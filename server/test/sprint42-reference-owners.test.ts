import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionSpec, DataDriver } from '../src/connections/drivers.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 42 (1.7.0), B-9209 (VLT-10): a saved vault reference handed to a workspace or a service.
 * Done when: disabling the admin who set up a connection leaves the connection working.
 */

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

class SpecDriver implements DataDriver {
  static specs: ConnectionSpec[] = [];
  constructor(spec: ConnectionSpec) {
    SpecDriver.specs.push(spec);
  }
  async test() {
    return { version: 'PostgreSQL 17', readOnly: true, detail: 'ok', health: 'healthy' as const };
  }
  async introspect() {
    return [{ name: 'orders', kind: 'table' as const, columns: [{ name: 'id', type: 'int' }] }];
  }
  async query() {
    return { columns: ['id'], rows: [[1]], capped: false, estimate: null };
  }
  async rows() {
    return { columns: ['id'], rows: [[1]], capped: false, estimate: null };
  }
}

describe('vault reference owners (B-9209)', () => {
  let h: Harness;
  let root: Client;
  let ada: Client;
  let rootId: string;
  let ws: string;

  beforeEach(async () => {
    h = await harness({ CONNECTIONS_ALLOWED_HOSTS: 'db.data.internal' }, { drivers: { postgres: (spec) => new SpecDriver(spec) } });
    rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    await localUser(h, 'ada', ['system-admin'], 'restricted');
    root = await loginAdmin(h, 'root');
    ada = await loginAdmin(h, 'ada');
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Data', 'confidential')).id;
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'kv', capabilities: ['write', 'list', 'read'], effect: 'allow' }).expect(201);
    SpecDriver.specs = [];
  }, 120_000);
  afterEach(async () => {
    await h.close();
  });

  const connection = async (name: string, ref: string) => {
    const conn = (await send(root, 'post', '/api/admin/connections', { name, engine: 'postgres', endpoint: 'db.data.internal:5432', database: 'shop', zone: 'data', label: 'internal', username: 'reader', password: ref }).expect(201)).body as { id: string };
    await send(root, 'post', `/api/admin/connections/${conn.id}/schema`).expect(200);
    await send(root, 'put', `/api/admin/connections/${conn.id}/allow-list`, { objects: ['orders'], piiColumns: [] }).expect(200);
    return conn;
  };
  const query = (c: Client, id: string) => send(c, 'post', `/api/admin/connections/${id}/query`, { query: 'SELECT id FROM orders' });

  it('disabling the admin who set up a connection leaves it working once its reference belongs to a workspace', async () => {
    await send(root, 'put', '/api/vault/kv/data/apps/db', { data: { password: 'conn-pw-from-vault' } }).expect(201);
    await send(root, 'put', '/api/vault/kv/data/apps/other', { data: { password: 'other-pw' } }).expect(201);
    const orders = await connection('orders', 'vault:apps/db#password');
    const other = await connection('other', 'vault:apps/other#password');
    await query(ada, orders.id).expect(200);

    // Handing over grants nothing: the workspace must hold read already, and the admin must read the reference themselves.
    const body = { savedBy: rootId, ref: 'vault:apps/db#password', owner: { kind: 'workspace', id: ws } };
    expect((await send(ada, 'put', '/api/vault/reference-owners', body).expect(403)).body.step).toBe('vault-policy');
    const noGrant = await send(root, 'put', '/api/vault/reference-owners', body).expect(409);
    expect(noGrant.body).toMatchObject({ step: 'vault-policy', path: 'kv/apps/db' });
    expect(await h.s.db('vault_reference_owners')).toHaveLength(0);
    const wsGrant = (await send(root, 'post', '/api/vault/policies', { subjectKind: 'workspace', subject: ws, path: 'kv/apps/db', capabilities: ['read'], effect: 'allow' }).expect(201)).body as { id: string };
    await send(root, 'put', '/api/vault/reference-owners', { ...body, ref: 'vault:apikey:exprsn/ci#key' }).expect(400);
    await send(root, 'put', '/api/vault/reference-owners', { ...body, owner: { kind: 'workspace', id: '0'.repeat(26) } }).expect(400);
    const handed = (await send(root, 'put', '/api/vault/reference-owners', body).expect(200)).body;
    expect(handed).toMatchObject({ savedBy: rootId, ref: 'vault:apps/db#password', owner: { kind: 'workspace', id: ws }, clearance: 'internal' });
    const [set] = await h.s.audit.list(h.tenantId, { action: 'vault.reference.owner.set' });
    expect(set).toMatchObject({ target: { path: 'apps/db', savedBy: rootId }, detail: { before: { kind: 'user', owner: rootId }, after: { kind: 'workspace', owner: ws } } });
    expect((await ada.agent.get('/api/vault/reference-owners').expect(200)).body.owners).toEqual([expect.objectContaining({ id: handed.id, savedByActive: true, owner: { kind: 'workspace', id: ws, name: 'Data' } })]);

    // The admin who set both connections up is disabled.
    await h.s.users.update(h.tenantId, rootId, { state: 'disabled' });
    SpecDriver.specs = [];
    await query(ada, orders.id).expect(200);
    expect(SpecDriver.specs.at(-1)).toMatchObject({ username: 'reader', password: 'conn-pw-from-vault' });
    const [read] = await h.s.audit.list(h.tenantId, { action: 'vault.secret.read' });
    expect(read).toMatchObject({ target: { path: 'apps/db' }, actor: { service: 'vault.reference', name: `workspace:${ws}` } });
    expect((read!.actor as { user?: string }).user).toBeUndefined();
    // A reference of theirs that was not handed over stops, as before.
    expect((await query(ada, other.id).expect(403)).body.step).toBe('vault-owner');

    // The owner's policy is asked at every use: without the workspace's grant the reference does not resolve.
    await send(ada, 'delete', `/api/vault/policies/${wsGrant.id}`).expect(204);
    expect((await query(ada, orders.id).expect(403)).body).toMatchObject({ step: 'vault-policy' });
    await send(ada, 'post', '/api/vault/policies', { subjectKind: 'workspace', subject: ws, path: 'kv/apps', capabilities: ['read'], effect: 'allow' }).expect(201);
    await query(ada, orders.id).expect(200);

    // A secret relabelled above what the reference reads at stops resolving.
    await h.s.db('vault_secrets').where({ tenant_id: h.tenantId, path: 'apps/db' }).update({ label: 'restricted' });
    await query(ada, orders.id).expect(404);
    await h.s.db('vault_secrets').where({ tenant_id: h.tenantId, path: 'apps/db' }).update({ label: 'internal' });
    await query(ada, orders.id).expect(200);

    // Taken back, it resolves as the person again: disabled, so it stops.
    await send(ada, 'delete', `/api/vault/reference-owners/${handed.id}`).expect(204);
    expect((await query(ada, orders.id).expect(403)).body.step).toBe('vault-owner');
    expect((await h.s.audit.list(h.tenantId, { action: 'vault.reference.owner.removed' }))[0]).toMatchObject({ detail: { before: { kind: 'workspace', owner: ws }, after: { kind: 'user', owner: rootId } } });
  }, 120_000);

  it('a service owner reads under grants made to integration.<name>; other service names stay in the platform scope', async () => {
    await send(root, 'put', '/api/vault/kv/data/apps/db', { data: { password: 'conn-pw-from-vault' } }).expect(201);
    const orders = await connection('orders', 'vault:apps/db#password');
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'service', subject: 'federation.oidc', path: 'kv/apps/db', capabilities: ['read'] }).expect(400);
    const body = { savedBy: rootId, ref: 'vault:apps/db#password', owner: { kind: 'service', id: 'integration.orders' } };
    await send(root, 'put', '/api/vault/reference-owners', { ...body, owner: { kind: 'service', id: 'federation.oidc' } }).expect(400);
    await send(root, 'put', '/api/vault/reference-owners', body).expect(409);
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'service', subject: 'integration.orders', path: 'kv/apps/db', capabilities: ['read'], effect: 'allow' }).expect(201);
    await send(root, 'put', '/api/vault/reference-owners', body).expect(200);
    // Handing the same reference over again replaces the owner; there is one row per person and reference.
    await send(root, 'put', '/api/vault/reference-owners', body).expect(200);
    expect(await h.s.db('vault_reference_owners')).toHaveLength(1);
    await h.s.users.update(h.tenantId, rootId, { state: 'disabled' });
    await query(ada, orders.id).expect(200);
    const [read] = await h.s.audit.list(h.tenantId, { action: 'vault.secret.read' });
    expect(read).toMatchObject({ actor: { service: 'vault.reference', name: 'service:integration.orders' } });
    // The service subject of a tenant never reaches the platform scope.
    expect(await h.s.db('vault_policies').where({ tenant_id: 'platform', subject: 'integration.orders' })).toHaveLength(0);
  }, 120_000);
});
