import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionSpec, DataDriver } from '../src/connections/drivers.js';
import { verifySignature } from '../src/webhooks/service.js';
import { FakeMcp } from './fake-mcp.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { FakeReceiver } from './sprint13-fakes.js';

/*
 * 1.7.0, Sprint 42 (B-9208): third-party credentials sealed outside the vault move to vault paths, with a reference
 * beside the sealed value, which stays.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('B-9208: third-party credentials in the vault', () => {
  let h: Harness;
  let hook: FakeReceiver;
  const specs: ConnectionSpec[] = [];

  beforeEach(async () => {
    specs.length = 0;
    const driver = (spec: ConnectionSpec) => {
      specs.push(spec);
      return { spec, test: async () => ({ version: 'fake', readOnly: true, health: 'healthy' as const, detail: `Account ${spec.username}` }), close: async () => undefined } as unknown as DataDriver;
    };
    h = await harness({ WEBHOOK_RETRY_BASE_MS: '10' }, { drivers: { postgres: driver } });
    hook = await new FakeReceiver().start();
  });
  afterEach(async () => {
    await h.close();
    await hook.stop();
  });

  async function admin() {
    const id = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    const c = await loginAdmin(h, 'root');
    const send = (m: 'post' | 'put' | 'delete', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { ...c, id, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), get: (p: string) => c.agent.get(p) };
  }
  const drain = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
      await h.s.jobs.runDue();
      await sleep(15);
    }
  };
  const fire = async (n: number) => {
    await h.s.audit.append({ tenantId: h.tenantId, action: 'demo.happened', kind: 'admin', actor: { service: 'test' }, target: { n }, label: 'internal' });
    for (let i = 0; i < 40 && hook.got.length < n; i++) await drain(1);
    return hook.got[n - 1]!;
  };
  const signedWith = (secret: string, got: { headers: Record<string, unknown>; body: string }) => verifySignature(secret, got.headers['x-exprsn-timestamp'] as string, got.headers['x-exprsn-signature'] as string, got.body);
  const auditText = async () => JSON.stringify(await h.s.db('audit_events').where({ tenant_id: h.tenantId }));

  it('moves sealed credentials to vault paths, reads them there, keeps the sealed values, and can take the move back', async () => {
    const a = await admin();
    const wh = (await a.post('/api/admin/webhooks', { name: 'ops', url: `${hook.url}/hook`, events: ['demo.*'], maxLabel: 'internal' }).expect(201)).body as { id: string; secret: string };
    const conn = (await a.post('/api/admin/connections', { name: 'ledger-ro', engine: 'postgres', endpoint: 'pg-ledger.northwind.internal:5432', database: 'ledger', label: 'confidential', username: 'ledger_ro', password: 'pw-One-1' }).expect(201)).body as { id: string };
    // A connection whose password is already a vault reference is not this move's to make.
    const sealedBefore = { wh: ((await h.s.db('webhooks').where({ id: wh.id }).first()) as { secret_sealed: string }).secret_sealed, conn: ((await h.s.db('data_connections').where({ id: conn.id }).first()) as { credential: string }).credential };
    expect(signedWith(wh.secret, await fire(1))).toBe(true);

    // Nothing moved by the migration: the counts say what is sealed outside the vault.
    const before = (await a.get('/api/vault/credential-moves').expect(200)).body;
    expect(before.remaining).toBe(2);
    expect(before.kinds.find((k: { kind: string }) => k.kind === 'webhook')).toMatchObject({ sealed: 1, moved: 0, path: 'integrations/webhook', service: 'integration.webhook' });
    expect(before.kinds.find((k: { kind: string }) => k.kind === 'connection')).toMatchObject({ sealed: 1, moved: 0 });
    expect(await h.s.db('vault_secrets').where({ tenant_id: h.tenantId })).toHaveLength(0);

    // The move: a vault secret per credential, a reference beside the sealed value, the sealed value untouched.
    const out = (await a.post('/api/vault/credential-moves', {}).expect(200)).body;
    expect(out).toMatchObject({ failed: [], remaining: 0 });
    expect(out.moved.map((m: { kind: string; field: string }) => `${m.kind}:${m.field}`).sort()).toEqual(['connection:password', 'webhook:secret']);
    const whRow = (await h.s.db('webhooks').where({ id: wh.id }).first()) as { secret_sealed: string; secret_ref: string };
    const connRow = (await h.s.db('data_connections').where({ id: conn.id }).first()) as { credential: string; credential_ref: string };
    expect(whRow).toMatchObject({ secret_sealed: sealedBefore.wh, secret_ref: `vault:integrations/webhook/${wh.id.toLowerCase()}#secret` });
    expect(connRow).toMatchObject({ credential: sealedBefore.conn, credential_ref: `vault:integrations/connection/${conn.id.toLowerCase()}#password` });
    expect((await h.s.db('vault_secrets').where({ tenant_id: h.tenantId }).orderBy('path')).map((r: { path: string; label: string }) => [r.path, r.label])).toEqual([[`integrations/connection/${conn.id.toLowerCase()}`, 'restricted'], [`integrations/webhook/${wh.id.toLowerCase()}`, 'restricted']]);
    // Read as the kind's service, whose grant is read and write on its own path and nothing else.
    expect(await h.s.credentialMoves.read('webhook', h.tenantId, whRow.secret_ref, 'test')).toBe(wh.secret);
    expect(await h.s.credentialMoves.read('connection', h.tenantId, connRow.credential_ref, 'test')).toBe('pw-One-1');
    await expect(h.s.credentialMoves.read('webhook', h.tenantId, connRow.credential_ref, 'test')).rejects.toMatchObject({ status: 403 });
    const grants = (await h.s.vault.listGrants(h.tenantId)).filter((g) => g.subjectKind === 'service');
    expect(grants.map((g) => [g.subject, g.path, [...g.capabilities].sort().join(',')]).sort()).toEqual([['integration.connection', 'kv/integrations/connection', 'read,write'], ['integration.webhook', 'kv/integrations/webhook', 'read,write']]);
    // The values are in no audit entry; the moves and the reads are.
    const audit = await auditText();
    expect(audit).not.toContain(wh.secret);
    expect(audit).not.toContain('pw-One-1');
    expect(audit).toContain('vault.credential.moved');
    // Run again: nothing left to do, nothing written twice.
    expect((await a.post('/api/vault/credential-moves', {}).expect(200)).body).toMatchObject({ moved: [], failed: [], remaining: 0 });
    expect((await a.get('/api/vault/credential-moves').expect(200)).body.kinds.find((k: { kind: string }) => k.kind === 'webhook')).toMatchObject({ sealed: 0, moved: 1 });

    // The integrations read through the vault now: a delivery is signed with the secret, a connection gets its password.
    expect(signedWith(wh.secret, await fire(2))).toBe(true);
    await a.post(`/api/admin/connections/${conn.id}/test`).expect(200);
    expect(specs.at(-1)).toMatchObject({ username: 'ledger_ro', password: 'pw-One-1' });
    // It is the vault that is read: with the vault secret changed behind the integration, the new value is used.
    await h.s.credentialMoves.rewritten('connection', h.tenantId, conn.id, 'password', 'pw-Vault-2', connRow.credential_ref);
    await a.post(`/api/admin/connections/${conn.id}/test`).expect(200);
    expect(specs.at(-1)).toMatchObject({ password: 'pw-Vault-2' });

    // A credential changed after the move goes to both places, so the sealed value stays current.
    const rotated = (await a.post(`/api/admin/webhooks/${wh.id}/secret`).expect(200)).body.secret as string;
    expect(rotated).not.toBe(wh.secret);
    const whAfter = (await h.s.db('webhooks').where({ id: wh.id }).first()) as { secret_sealed: string; secret_ref: string };
    expect(whAfter.secret_ref).toBe(whRow.secret_ref);
    expect(whAfter.secret_sealed).not.toBe(sealedBefore.wh);
    expect(await h.s.keys.open(h.tenantId, whAfter.secret_sealed, `webhook:${wh.id}`)).toBe(rotated);
    expect(await h.s.credentialMoves.read('webhook', h.tenantId, whAfter.secret_ref, 'test')).toBe(rotated);
    expect(signedWith(rotated, await fire(3))).toBe(true);
    await a.put(`/api/admin/connections/${conn.id}/credential`, { username: 'ledger_ro', password: 'pw-Three-3' }).expect(200);
    await a.post(`/api/admin/connections/${conn.id}/test`).expect(200);
    expect(specs.at(-1)).toMatchObject({ password: 'pw-Three-3' });
    expect(await h.s.credentialMoves.read('connection', h.tenantId, connRow.credential_ref, 'test')).toBe('pw-Three-3');

    // Taking the move back: the references go, the integrations read their sealed values, which are current.
    const back = (await a.post('/api/vault/credential-moves/restore', {}).expect(200)).body;
    expect(back.restored).toHaveLength(2);
    expect(((await h.s.db('webhooks').where({ id: wh.id }).first()) as { secret_ref: string | null }).secret_ref).toBeNull();
    expect(signedWith(rotated, await fire(4))).toBe(true);
    await a.post(`/api/admin/connections/${conn.id}/test`).expect(200);
    expect(specs.at(-1)).toMatchObject({ password: 'pw-Three-3' });
    expect((await a.get('/api/vault/credential-moves').expect(200)).body.remaining).toBe(2);
    expect(await auditText()).toContain('vault.credential.restored');
    // And moved again, onto the same paths as new versions.
    expect((await a.post('/api/vault/credential-moves', { kinds: ['webhook'] }).expect(200)).body.moved).toHaveLength(1);
    expect((await a.get('/api/vault/credential-moves').expect(200)).body.remaining).toBe(1);
  });

  it('moves MCP service tokens and OAuth client secrets; each read of one through the vault is audited', async () => {
    const a = await admin();
    const mcp = await new FakeMcp().start();
    try {
      mcp.token = 'svc-token-One-1';
      const svc = (await a.post('/api/admin/mcp-servers', { name: 'svc', url: mcp.url, auth: 'service', credential: 'svc-token-One-1' }).expect(201)).body as { id: string };
      const usr = (await a.post('/api/admin/mcp-servers', { name: 'gitlab', url: mcp.url, auth: 'user' }).expect(201)).body as { id: string };
      const server = { id: usr.id, tenant_id: h.tenantId, url: mcp.url };
      const manual = { authorizationEndpoint: 'https://as.northwind.example/authorize', tokenEndpoint: 'https://as.northwind.example/token', clientId: 'exprsn-ai' };
      await h.s.mcp.oauth.setManual(server, { ...manual, clientSecret: 'oauth-client-One-1' }, a.id);
      // What the token endpoint would be sent: the client's Basic credentials.
      const basic = async () => {
        const cfg = (await h.s.mcp.oauth.config(usr.id))!;
        const auth = (await (h.s.mcp.oauth as unknown as { clientAuth(c: unknown, f: Record<string, string>): Promise<Record<string, string>> }).clientAuth(cfg, {})).authorization;
        return auth ? Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString() : null;
      };
      expect(await basic()).toBe('exprsn-ai:oauth-client-One-1');

      const kinds = (await a.get('/api/vault/credential-moves').expect(200)).body.kinds as { kind: string; sealed: number }[];
      expect(kinds.find((k) => k.kind === 'mcp-server')).toMatchObject({ sealed: 1 });
      expect(kinds.find((k) => k.kind === 'mcp-oauth-client')).toMatchObject({ sealed: 1, path: 'integrations/mcp-oauth-client' });
      const out = (await a.post('/api/vault/credential-moves', { kinds: ['mcp-server', 'mcp-oauth-client'] }).expect(200)).body;
      expect(out).toMatchObject({ failed: [], remaining: 0 });
      expect(((await h.s.db('mcp_servers').where({ id: svc.id }).first()) as { credential_ref: string }).credential_ref).toBe(`vault:integrations/mcp-server/${svc.id.toLowerCase()}#token`);
      const oauthRef = `vault:integrations/mcp-oauth-client/${usr.id.toLowerCase()}#secret`;
      expect(((await h.s.db('mcp_oauth').where({ server_id: usr.id }).first()) as { client_secret_ref: string }).client_secret_ref).toBe(oauthRef);

      // The server is called with the token read from the vault, and that read is in the audit log as the service's.
      const readsBefore = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'vault.secret.read' })).length;
      expect((await a.post(`/api/admin/mcp-servers/${svc.id}/check`).expect(200)).body.health).toBe('healthy');
      const reads = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'vault.secret.read' })) as { actor: string; target: string }[];
      expect(reads.length).toBeGreaterThan(readsBefore);
      expect(reads.some((r) => r.actor.includes('integration.mcp-server') && r.target.includes(`integrations/mcp-server/${svc.id.toLowerCase()}`))).toBe(true);
      expect(await basic()).toBe('exprsn-ai:oauth-client-One-1');
      expect(((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'vault.secret.read' })) as { actor: string }[]).some((r) => r.actor.includes('integration.mcp-oauth-client'))).toBe(true);
      const audit = await auditText();
      expect(audit).not.toContain('svc-token-One-1');
      expect(audit).not.toContain('oauth-client-One-1');

      // A client secret changed after the move goes to both places; one removed takes its reference with it.
      await h.s.mcp.oauth.setManual(server, { ...manual, clientSecret: 'oauth-client-Two-2' }, a.id);
      const row = (await h.s.db('mcp_oauth').where({ server_id: usr.id }).first()) as { client_secret: string; client_secret_ref: string };
      expect(row.client_secret_ref).toBe(oauthRef);
      expect(await h.s.keys.open(h.tenantId, row.client_secret, `mcp-oauth-client:${usr.id}`)).toBe('oauth-client-Two-2');
      expect(await h.s.credentialMoves.read('mcp-oauth-client', h.tenantId, oauthRef, 'test')).toBe('oauth-client-Two-2');
      expect(await basic()).toBe('exprsn-ai:oauth-client-Two-2');
      await h.s.mcp.oauth.setManual(server, manual, a.id);
      expect(((await h.s.db('mcp_oauth').where({ server_id: usr.id }).first()) as { client_secret_ref: string }).client_secret_ref).toBe(oauthRef);
      await h.s.mcp.oauth.setManual(server, { ...manual, clientSecret: null }, a.id);
      expect(await h.s.db('mcp_oauth').where({ server_id: usr.id }).first()).toMatchObject({ client_secret: null, client_secret_ref: null });
      expect(await basic()).toBeNull();

      // Taken back: the service token is read sealed again.
      expect((await a.post('/api/vault/credential-moves/restore', { kinds: ['mcp-server'] }).expect(200)).body.restored).toHaveLength(1);
      expect((await a.post(`/api/admin/mcp-servers/${svc.id}/check`).expect(200)).body.health).toBe('healthy');
    } finally {
      await mcp.stop();
    }
  });

  it('leaves alone what is already a vault reference, and a build without the vault hook reads the sealed value', async () => {
    const a = await admin();
    await a.post('/api/vault/policies', { subjectKind: 'user', subject: a.id, path: 'kv/apps', capabilities: ['read', 'write'], effect: 'allow' }).expect(201);
    await a.put('/api/vault/kv/data/apps/ledger', { data: { password: 'from-the-vault' } }).expect((r) => expect(r.status).toBeLessThan(300));
    const conn = (await a.post('/api/admin/connections', { name: 'ledger-ref', engine: 'postgres', endpoint: 'pg-ledger.northwind.internal:5432', database: 'ledger', label: 'confidential', username: 'ledger_ro', password: 'vault:apps/ledger#password' }).expect(201)).body as { id: string };
    const status = (await a.get('/api/vault/credential-moves').expect(200)).body;
    expect(status.kinds.find((k: { kind: string }) => k.kind === 'connection')).toMatchObject({ sealed: 0, references: 1 });
    expect((await a.post('/api/vault/credential-moves', {}).expect(200)).body).toMatchObject({ moved: [], remaining: 0 });
    expect(((await h.s.db('data_connections').where({ id: conn.id }).first()) as { credential_ref: string | null }).credential_ref).toBeNull();
    await a.post(`/api/admin/connections/${conn.id}/test`).expect(200);
    expect(specs.at(-1)).toMatchObject({ password: 'from-the-vault' });
    // A member cannot see the counts or run the move.
    await localUser(h, 'plain', ['member']);
    const plain = await loginPlain();
    await plain.agent.get('/api/vault/credential-moves').expect(403);
  });

  async function loginPlain() {
    const { login } = await import('./helpers.js');
    return login(h, 'plain');
  }
});
