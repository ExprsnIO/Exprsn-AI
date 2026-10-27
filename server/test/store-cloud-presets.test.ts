/*
 * 1.9.0, Sprint 54 (B-183): cloud directory presets and the Graph and Directory API pulls, against local fakes of
 * Microsoft Graph and the Google Directory API (`fake-cloud-directory.ts`) and the upstream IdP fake. No real cloud
 * service is contacted: the presets are only parsed, and every address below is 127.0.0.1 or refused before a
 * connection.
 */
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { formFor, layoutDrift, storeKind } from '../src/identity/providers/kinds.js';
import { STORE_PRESETS } from '../src/identity/providers/store-kinds.js';
import { CloudDirectoryClient, directoryNet, DirectoryError } from '../src/identity/providers/cloud-directory.js';
import { ServiceUrlRefused } from '../src/platform/egress.js';
import { cloudDirectorySchema, ldapConfigSchema, oidcConfigSchema, samlConfigSchema, scimConfigSchema, type Step } from '../src/identity/providers/types.js';
import { FakeIdp } from './fake-idp.js';
import { FakeGoogle, FakeGraph } from './fake-cloud-directory.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'put' | 'patch', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

describe('B-183: cloud directory presets and pulls', () => {
  let h: Harness;
  let admin: Client;
  let adminId: string;
  let idp: FakeIdp;
  let graph: FakeGraph;
  let google: FakeGoogle;

  beforeAll(async () => {
    h = await harness();
    adminId = (await localUser(h, 'tadmin', ['tenant-admin', 'identity-admin'], 'restricted')).id;
    admin = await loginAdmin(h, 'tadmin');
    await send(admin, 'post', '/api/vault/policies', { subjectKind: 'user', subject: adminId, path: '*', capabilities: ['*'] }).expect(201);
    idp = new FakeIdp();
    await idp.start();
    graph = await new FakeGraph().start();
    google = await new FakeGoogle().start();
    await send(admin, 'put', '/api/vault/kv/data/identity/entra', { data: { clientSecret: graph.clientSecret, rpSecret: idp.clientSecret } }).expect(201);
    await send(admin, 'put', '/api/vault/kv/data/identity/google', { data: { serviceAccount: google.serviceAccountJson(), rpSecret: idp.clientSecret } }).expect(201);
  });
  afterAll(async () => {
    await idp.stop();
    await graph.stop();
    await google.stop();
    await h.close();
  });

  // ---------- presets ----------

  it('offers Entra ID, Google Workspace, Okta, Keycloak, Authentik, FreeIPA and 389 DS presets that fill each kind\'s form', async () => {
    const ids = (kind: string) => (storeKind(kind)!.presets ?? []).map((p) => p.id);
    expect(ids('oidc')).toEqual(expect.arrayContaining(['entra-id', 'google-workspace', 'okta', 'keycloak', 'authentik']));
    expect(ids('saml')).toEqual(expect.arrayContaining(['okta-saml', 'keycloak-saml', 'authentik-saml']));
    expect(ids('scim')).toEqual(expect.arrayContaining(['entra-id-scim', 'google-workspace-scim', 'okta-scim', 'keycloak-scim', 'authentik-scim']));
    expect(ids('ldap')).toEqual(expect.arrayContaining(['openldap', 'freeipa', '389ds'])); // the built-in preset stays
    for (const kind of ['oidc', 'saml', 'scim', 'ldap', 'ad', 'exprsn-platform']) expect(layoutDrift(storeKind(kind)!), kind).toEqual([]);

    // Filled in with what only the admin knows, every preset is a configuration the server accepts.
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const cert = selfSignedCertificate({ publicKey: pair.publicKey, privateKey: pair.privateKey, commonName: 'idp', days: 2 }).toString('base64');
    const fill = (c: Record<string, unknown>) => JSON.parse(JSON.stringify(c).replaceAll('TENANT-ID', '72f988bf-86f1-41af-91ab-2d7cd011db47').replaceAll('"certificates":[]', `"certificates":["${cert}"]`)) as Record<string, unknown>;
    const schemas = { oidc: oidcConfigSchema, saml: samlConfigSchema, scim: scimConfigSchema, ldap: ldapConfigSchema };
    for (const [kind, schema] of Object.entries(schemas)) {
      for (const p of STORE_PRESETS[kind]!) {
        const r = schema.safeParse(fill(p.config));
        expect(r.success, `${kind}/${p.id}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
      }
    }
    // Entra ID: endpoints, scopes and claims of the v2.0 endpoint and Graph; groups by display name
    const entra = fill(STORE_PRESETS.oidc!.find((p) => p.id === 'entra-id')!.config) as Record<string, unknown> & { directory: Record<string, unknown> };
    expect(entra).toMatchObject({ issuer: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0', usernameClaim: 'preferred_username', subjectClaim: 'oid', groupsClaim: 'groups' });
    expect(entra.directory).toMatchObject({ api: 'msgraph', tokenUrl: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/token', apiUrl: 'https://graph.microsoft.com/v1.0', scope: 'https://graph.microsoft.com/.default', groupName: 'displayName' });
    const gw = STORE_PRESETS.oidc!.find((p) => p.id === 'google-workspace')!.config as Record<string, unknown> & { directory: Record<string, unknown> };
    expect(gw).toMatchObject({ issuer: 'https://accounts.google.com', usernameClaim: 'email' });
    expect(gw.directory).toMatchObject({ api: 'google', tokenUrl: 'https://oauth2.googleapis.com/token', apiUrl: 'https://admin.googleapis.com/admin/directory/v1', customer: 'my_customer', groupName: 'email' });
    // the form shows the directory block, with its credentials as secret references
    const fields = formFor(storeKind('oidc')!).flatMap((s) => s.fields);
    expect(fields.find((f) => f.key === 'directory.clientSecret')?.type).toBe('secret');
    expect(fields.find((f) => f.key === 'directory.api')?.options).toEqual(['msgraph', 'google']);

    // and the wizard's kind list carries them
    const kinds = (await admin.agent.get('/api/admin/identity-store-kinds').expect(200)).body.kinds as { kind: string; presets: { id: string }[] }[];
    expect(kinds.find((k) => k.kind === 'oidc')!.presets.map((p) => p.id)).toEqual(expect.arrayContaining(['entra-id', 'google-workspace']));
    expect(kinds.map((k) => k.kind)).toEqual(expect.arrayContaining(['ad', 'exprsn-platform']));
  });

  it('takes directory credentials as vault references only', () => {
    const base = { api: 'msgraph', tokenUrl: 'https://login.microsoftonline.com/t/oauth2/v2.0/token', clientId: 'x' };
    expect(cloudDirectorySchema.safeParse({ ...base, clientSecret: 'vault:identity/entra#clientSecret' }).success).toBe(true);
    for (const ref of ['env:UPSTREAM_SECRET_GRAPH', 'file:/etc/secret', 'plain-secret-value']) expect(cloudDirectorySchema.safeParse({ ...base, clientSecret: ref }).success, ref).toBe(false);
    expect(cloudDirectorySchema.safeParse({ api: 'google', serviceAccount: 'env:UPSTREAM_SECRET_SA', subject: 'a@b.c' }).success).toBe(false);
    expect(cloudDirectorySchema.safeParse({ api: 'msgraph', clientSecret: 'vault:a#b' }).error?.issues.map((i) => i.path.join('.'))).toEqual(expect.arrayContaining(['tokenUrl', 'clientId']));
    // plain http only on this host
    expect(cloudDirectorySchema.safeParse({ ...base, tokenUrl: 'http://login.example.com/token', clientSecret: 'vault:a#b' }).success).toBe(false);
  });

  // ---------- Microsoft Graph ----------

  describe('Entra ID with the Graph pull', () => {
    let storeId: string;
    beforeAll(() => {
      graph.users.set('u-1', { id: 'u-1', userPrincipalName: 'Alice@Contoso.test', displayName: 'Alice Contoso', mail: 'alice@contoso.test', groups: [{ id: 'g-1', displayName: 'Engineering', securityEnabled: true }, { id: 'g-2', displayName: 'All Staff', securityEnabled: true }, { id: 'g-3', displayName: 'Team Site', securityEnabled: false }] });
      graph.users.set('u-2', { id: 'u-2', userPrincipalName: 'bob@contoso.test', groups: [{ id: 'g-2', displayName: 'All Staff', securityEnabled: true }] });
    });
    const config = () => ({
      issuer: idp.url,
      clientId: idp.clientId,
      clientSecret: 'vault:identity/entra#rpSecret',
      usernameClaim: 'preferred_username',
      subjectClaim: 'oid',
      directory: { api: 'msgraph', tokenUrl: graph.tokenUrl, apiUrl: `${graph.url}/v1.0`, clientId: graph.clientId, clientSecret: 'vault:identity/entra#clientSecret', groupName: 'displayName', securityGroupsOnly: true }
    });

    it('refuses a directory at a metadata or (internal-only) public address before saving', async () => {
      const bad = await send(admin, 'post', '/api/admin/identity-providers', { name: 'Entra bad', kind: 'oidc', config: { ...config(), directory: { ...config().directory, tokenUrl: 'https://169.254.169.254/token' } } });
      expect(bad.status).toBe(400);
      expect(bad.body.reason).toBe('service_url');
      // at request time too: the egress guard refuses without connecting
      const strict = directoryNet({ SERVICE_INTERNAL_ONLY: true, FEDERATION_TIMEOUT_MS: 2000 });
      await expect(strict.request('https://8.8.8.8/token', { method: 'POST', body: 'x' })).rejects.toBeInstanceOf(ServiceUrlRefused);
      await expect(strict.request('https://169.254.169.254/latest/meta-data', {})).rejects.toThrow(/metadata/);
      const env = await send(admin, 'post', '/api/admin/identity-providers', { name: 'Entra env', kind: 'oidc', config: { ...config(), directory: { ...config().directory, clientSecret: 'env:UPSTREAM_SECRET_GRAPH' } } });
      expect(env.status).toBe(400);
    });

    it('tests the store with the client credentials grant read from the vault', async () => {
      const created = await send(admin, 'post', '/api/admin/identity-providers', { name: 'Entra ID', kind: 'oidc', config: config() });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      storeId = created.body.id;
      graph.grants.length = 0;
      const tested = (await send(admin, 'post', `/api/admin/identity-providers/${storeId}/test`).expect(200)).body as { ok: boolean; steps: Step[] };
      expect(tested.ok, JSON.stringify(tested.steps)).toBe(true);
      expect(tested.steps.map((s) => s.title)).toEqual(expect.arrayContaining(['Client credentials grant', 'Read the directory (Microsoft Graph)']));
      expect(graph.grants[0]).toMatchObject({ grant_type: 'client_credentials', client_id: graph.clientId, client_secret: graph.clientSecret, scope: 'https://graph.microsoft.com/.default' });
      // the secret never lands in the stored configuration or the test's answer
      expect(JSON.stringify(await h.s.db('identity_providers').where({ id: storeId }))).not.toContain(graph.clientSecret);
      expect(JSON.stringify(tested)).not.toContain(graph.clientSecret);
    });

    it('signs in with groups pulled from Graph (nested, paged, security groups only), linked by oid', async () => {
      await send(admin, 'post', '/api/admin/group-mappings', { providerId: storeId, group: 'Engineering', role: 'knowledge-curator', clearance: 'internal' }).expect(201);
      await send(admin, 'post', '/api/admin/group-mappings', { providerId: storeId, group: 'All Staff', role: 'member', clearance: 'internal' }).expect(201);
      const browser = request.agent(h.app);
      const start = await browser.get(`/federation/oidc/start?provider=${storeId}`).expect(302);
      // the ID token's groups are Entra object ids; they are not what mappings name
      const { code, state } = idp.authorize(start.headers.location!, { sub: 'pairwise-sub-1', oid: 'u-1', preferred_username: 'alice@contoso.test', name: 'Alice Contoso', email: 'alice@contoso.test', groups: ['g-1', 'g-2'] } as never);
      const cb = await browser.get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`);
      expect(cb.status, cb.text).toBe(302);
      const me = (await browser.get('/api/me').expect(200)).body;
      expect(me.roles.map((r: { id: string }) => r.id).sort()).toEqual(['knowledge-curator', 'member']);
      const user = (await h.s.users.byUsername(h.tenantId, 'alice@contoso.test'))!;
      const link = (await h.s.db('user_identities').where({ user_id: user.id, provider_id: storeId }).first()) as { external_id: string; groups: string };
      expect(link.external_id).toBe('u-1');
      expect((JSON.parse(link.groups) as string[]).sort()).toEqual(['All Staff', 'Engineering']); // Team Site is not a security group
      expect(graph.requests.some((r) => r.path.includes('/users/u-1/transitiveMemberOf/microsoft.graph.group') && r.path.includes('skiptoken=2'))).toBe(true);
    });

    it('joins directory sync: groups refreshed by id, a disabled account disabled, a foreign paging link refused', async () => {
      const row = (await h.s.providers.get(h.tenantId, storeId))!;
      graph.users.get('u-1')!.groups = [{ id: 'g-2', displayName: 'All Staff', securityEnabled: true }];
      let report = await h.s.sync.syncProvider(row);
      expect(report.aborted).toBeUndefined();
      expect(report.updated).toBe(1);
      const user = (await h.s.users.byUsername(h.tenantId, 'alice@contoso.test'))!;
      expect((await h.s.users.roleIds(user.id)).sort()).toEqual(['member']);
      // a paging link to another host stops the run without changing anyone
      graph.users.get('u-1')!.groups = [{ id: 'g-1', displayName: 'Engineering', securityEnabled: true }, { id: 'g-2', displayName: 'All Staff', securityEnabled: true }];
      // Since migration 143 the first run saved Graph delta links; drop them so this run is the full pull under test.
      if (await h.s.db.schema.hasTable('directory_sync_state')) await h.s.db('directory_sync_state').where({ provider_id: storeId }).delete();
      graph.foreignNextLink = true;
      report = await h.s.sync.syncProvider(row);
      graph.foreignNextLink = false;
      expect(report.aborted).toMatch(/could not be read/);
      expect(report.errors.join()).toMatch(/another host/);
      // disabled in Entra ID: disabled here
      graph.users.get('u-1')!.accountEnabled = false;
      report = await h.s.sync.syncProvider(row);
      expect(report.disabled.map((d) => d.username)).toEqual(['alice@contoso.test']);
      expect((await h.s.users.byUsername(h.tenantId, 'alice@contoso.test'))!.state).toBe('disabled');
    });

    it('refuses the sign-in when the directory does not have the account', async () => {
      const browser = request.agent(h.app);
      const start = await browser.get(`/federation/oidc/start?provider=${storeId}`).expect(302);
      const { code, state } = idp.authorize(start.headers.location!, { sub: 'x', oid: 'u-404', preferred_username: 'ghost@contoso.test' } as never);
      const cb = await browser.get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`);
      expect(cb.status).toBe(400);
      expect(cb.text).toContain('directory does not have this account');
      expect(await h.s.users.byUsername(h.tenantId, 'ghost@contoso.test')).toBeUndefined();
    });
  });

  // ---------- Google Directory API ----------

  describe('Google Workspace with the Directory API pull', () => {
    beforeAll(() => {
      google.users.set('g-100', { id: 'g-100', primaryEmail: 'carol@example.com', fullName: 'Carol Example', groups: [{ id: 'gg-1', email: 'eng@example.com', name: 'Engineering' }, { id: 'gg-2', email: 'all@example.com', name: 'Everyone' }] });
      google.users.set('g-101', { id: 'g-101', primaryEmail: 'dan@example.com', suspended: true, groups: [] });
    });
    const config = () => ({
      issuer: idp.url,
      clientId: idp.clientId,
      clientSecret: 'vault:identity/google#rpSecret',
      usernameClaim: 'email',
      directory: { api: 'google', tokenUrl: `${google.url}/token`, apiUrl: `${google.url}/admin/directory/v1`, serviceAccount: 'vault:identity/google#serviceAccount', subject: google.admin }
    });

    it('signs a service account assertion from the vault, and reads users and their groups page by page', async () => {
      const created = await send(admin, 'post', '/api/admin/identity-providers', { name: 'Google Workspace', kind: 'oidc', config: config() });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const tested = (await send(admin, 'post', `/api/admin/identity-providers/${created.body.id}/test`).expect(200)).body as { ok: boolean; steps: Step[] };
      expect(tested.ok, JSON.stringify(tested.steps)).toBe(true);
      expect(google.assertions.at(-1)).toMatchObject({ iss: google.clientEmail, sub: google.admin, aud: `${google.url}/token` });
      const row = (await h.s.providers.get(h.tenantId, created.body.id))!;
      const p = h.s.chain.build(row);
      const carol = await p.lookup('Carol@Example.com');
      expect(carol).toMatchObject({ externalId: 'g-100', username: 'carol@example.com', displayName: 'Carol Example', email: 'carol@example.com' });
      expect(carol!.groups).toEqual(['eng@example.com', 'all@example.com']);
      expect((await p.lookupById!('g-100'))?.username).toBe('carol@example.com');
      expect(await p.lookup('dan@example.com')).toBeNull(); // suspended
      expect(await p.lookup('nobody@example.com')).toBeNull();
      // the wizard's test looks the account up in the directory
      const wiz = (await send(admin, 'post', '/api/admin/identity-store-kinds/oidc/test', { config: config(), credentials: { username: 'carol@example.com' } }).expect(200)).body;
      expect(wiz).toMatchObject({ ok: true, result: 'found', user: { username: 'carol@example.com' } });
    });

    it('refuses a key that is not a service account, and a refused assertion, in words', async () => {
      const bad = new CloudDirectoryClient({ api: 'google', tokenUrl: `${google.url}/token`, apiUrl: `${google.url}/admin/directory/v1`, serviceAccount: 'vault:x#y', subject: google.admin }, directoryNet({ FEDERATION_TIMEOUT_MS: 2000 }), async () => '{"client_email":"x"}');
      await expect(bad.user('carol@example.com')).rejects.toBeInstanceOf(DirectoryError);
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const forged = new CloudDirectoryClient({ api: 'google', tokenUrl: `${google.url}/token`, apiUrl: `${google.url}/admin/directory/v1`, serviceAccount: 'vault:x#y', subject: google.admin }, directoryNet({ FEDERATION_TIMEOUT_MS: 2000 }), async () => JSON.stringify({ client_email: google.clientEmail, private_key: other }));
      await expect(forged.user('carol@example.com')).rejects.toThrow(/invalid_grant/);
    });
  });

  // ---------- QA-1 (1.9.9-qa): full import before first sign-in, and Graph delta queries ----------

  describe('QA-1: the full import of a cloud directory, and incremental sync by Graph delta', () => {
    let g2: FakeGraph;
    let gStore: string;
    let googleStore: string;
    let dryId: string;
    const drain = async () => {
      for (let i = 0; i < 20; i++) if (!(await h.s.jobs.runDue())) return;
    };
    const imp = (store: string, body: object) => send(admin, 'post', `/api/admin/identity-providers/${store}/directory-imports`, body);
    const report = async (store: string, id: string) => (await admin.agent.get(`/api/admin/identity-providers/${store}/directory-imports/${id}`).expect(200)).body;

    beforeAll(async () => {
      g2 = await new FakeGraph().start();
      g2.userPageSize = 2; // the import pages through /users
      g2.users.set('a-1', { id: 'a-1', userPrincipalName: 'ann@fabrikam.test', displayName: 'Ann Fabrikam', groups: [{ id: 'f-eng', displayName: 'Fab Engineering', securityEnabled: true }, { id: 'f-all', displayName: 'Fab Staff', securityEnabled: true }] });
      g2.users.set('b-1', { id: 'b-1', userPrincipalName: 'ben@fabrikam.test', groups: [{ id: 'f-all', displayName: 'Fab Staff', securityEnabled: true }] });
      g2.users.set('c-1', { id: 'c-1', userPrincipalName: 'cy@fabrikam.test', accountEnabled: false, groups: [{ id: 'f-all', displayName: 'Fab Staff', securityEnabled: true }] });
      g2.users.set('d-1', { id: 'd-1', userPrincipalName: 'dee@fabrikam.test', groups: [{ id: 'f-x', displayName: 'Unmapped', securityEnabled: true }] });
      g2.users.set('e-1', { id: 'e-1', userPrincipalName: 'eli@fabrikam.test', groups: [{ id: 'f-all', displayName: 'Fab Staff', securityEnabled: true }] });
      await localUser(h, 'eli@fabrikam.test', ['member']); // linked to the local store: a conflict, never merged
      await send(admin, 'put', '/api/vault/kv/data/identity/fabrikam', { data: { clientSecret: g2.clientSecret, rpSecret: idp.clientSecret } }).expect(201);
      const created = await send(admin, 'post', '/api/admin/identity-providers', {
        name: 'Fabrikam Entra',
        kind: 'oidc',
        config: { issuer: idp.url, clientId: idp.clientId, clientSecret: 'vault:identity/fabrikam#rpSecret', usernameClaim: 'preferred_username', subjectClaim: 'oid', directory: { api: 'msgraph', tokenUrl: g2.tokenUrl, apiUrl: `${g2.url}/v1.0`, clientId: g2.clientId, clientSecret: 'vault:identity/fabrikam#clientSecret' } }
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      gStore = created.body.id;
      await send(admin, 'post', '/api/admin/group-mappings', { providerId: gStore, group: 'Fab Engineering', role: 'knowledge-curator', clearance: 'internal' }).expect(201);
      await send(admin, 'post', '/api/admin/group-mappings', { providerId: gStore, group: 'Fab Staff', role: 'member', clearance: 'internal' }).expect(201);
    });
    afterAll(async () => {
      await g2.stop();
    });

    it('is not available until migration 143 is applied, and sync still pulls in full', async () => {
      if (await h.s.db.schema.hasTable('directory_imports')) return; // a database that has it already
      expect((await admin.agent.get(`/api/admin/identity-providers/${gStore}/directory-imports`).expect(200)).body).toEqual({ available: false, imports: [] });
      const r = await imp(gStore, { dryRun: true });
      expect(r.status).toBe(409);
      expect(r.body.detail).toMatch(/143_directory_sync_state/);
      const report0 = await h.s.sync.syncProvider((await h.s.providers.get(h.tenantId, gStore))!);
      expect(report0.aborted).toBeUndefined(); // nobody linked yet
    });

    it('dry run first: counts what an import would do and changes nothing; the run must name it', async () => {
      if (!(await h.s.db.schema.hasTable('directory_imports'))) await (await import('../src/db/migrations/143_directory_sync_state.js')).up(h.s.db);
      const before = Number(((await h.s.db('users').where({ tenant_id: h.tenantId }).count({ n: '*' }).first()) as { n: number }).n);
      expect((await imp(gStore, { dryRun: false })).status).toBe(409);
      const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
      expect((await imp(local.id, { dryRun: true })).status).toBe(409); // no cloud directory
      const dry = await imp(gStore, { dryRun: true });
      expect(dry.status, JSON.stringify(dry.body)).toBe(202);
      expect((await imp(gStore, { dryRun: true })).status).toBe(409); // one at a time
      await drain();
      const rep = await report(gStore, dry.body.id);
      expect(rep).toMatchObject({ state: 'succeeded', dryRun: true, progress: 100, summary: { dryRun: true, users: 5, create: 2, disabled: 1, noMappedGroup: 1, conflict: 1, applied: 0 } });
      const by = (u: string) => rep.report.find((r: { username: string }) => r.username === u);
      expect(by('ann@fabrikam.test')).toMatchObject({ action: 'create', roles: ['knowledge-curator', 'member'], clearance: 'internal' });
      expect(by('cy@fabrikam.test')).toMatchObject({ action: 'disabled' });
      expect(by('dee@fabrikam.test')).toMatchObject({ action: 'no_mapped_group' });
      expect(by('eli@fabrikam.test')).toMatchObject({ action: 'conflict' });
      expect(g2.requests.filter((r) => r.path.startsWith('/v1.0/users?')).length).toBe(3); // 5 users, 2 a page
      expect(Number(((await h.s.db('users').where({ tenant_id: h.tenantId }).count({ n: '*' }).first()) as { n: number }).n)).toBe(before);
      expect(await h.s.db('audit_events').where({ action: 'identity.directory_import.dry_run' }).first()).toBeTruthy();
      dryId = dry.body.id;
    });

    it('the run makes accounts as a first sign-in would (roles, clearance, link), never the disabled ones', async () => {
      const run = await imp(gStore, { dryRun: false, fromDryRun: dryId });
      expect(run.status, JSON.stringify(run.body)).toBe(202);
      await drain();
      const rep = await report(gStore, run.body.id);
      expect(rep).toMatchObject({ state: 'succeeded', dryRun: false, fromDryRun: dryId, summary: { create: 2, applied: 2, disabled: 1, conflict: 1 } });
      const ann = (await h.s.users.byUsername(h.tenantId, 'ann@fabrikam.test'))!;
      expect((await h.s.users.roleIds(ann.id)).sort()).toEqual(['knowledge-curator', 'member']);
      expect(ann.clearance).toBe('internal');
      expect(ann.last_login_at ?? null).toBeNull(); // not a sign-in
      expect((await h.s.users.identitiesFor(ann.id)).find((i) => i.provider_id === gStore)?.external_id).toBe('a-1');
      expect(await h.s.users.byUsername(h.tenantId, 'cy@fabrikam.test')).toBeUndefined();
      expect(await h.s.users.byUsername(h.tenantId, 'dee@fabrikam.test')).toBeUndefined();
      const eli = (await h.s.users.byUsername(h.tenantId, 'eli@fabrikam.test'))!;
      expect((await h.s.users.identitiesFor(eli.id)).some((i) => i.provider_id === gStore)).toBe(false);
      expect(await h.s.db('audit_events').where({ action: 'user.created' }).whereRaw("detail like '%directory-import%'").first()).toBeTruthy();
      // the first sign-in finds the account already there, linked by oid
      const browser = request.agent(h.app);
      const start = await browser.get(`/federation/oidc/start?provider=${gStore}`).expect(302);
      const { code, state } = idp.authorize(start.headers.location!, { sub: 'p-ann', oid: 'a-1', preferred_username: 'ann@fabrikam.test', name: 'Ann Fabrikam' } as never);
      expect((await browser.get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`)).status).toBe(302);
      expect((await browser.get('/api/me').expect(200)).body.user.id).toBe(ann.id);
      // a later import plans them as already linked
      const again = await imp(gStore, { dryRun: true });
      await drain();
      expect((await report(gStore, again.body.id)).summary).toMatchObject({ existing: 2, create: 0 });
      expect((await admin.agent.get(`/api/admin/identity-providers/${gStore}/directory-imports`).expect(200)).body.imports.length).toBe(3);
    });

    it('syncs by Graph delta: only changed accounts are looked up, and a 410 or a deleted group falls back to a full pull', async () => {
      const row = (await h.s.providers.get(h.tenantId, gStore))!;
      let r = await h.s.sync.syncProvider(row);
      expect(r).toMatchObject({ mode: 'full', checked: 2 }); // no links yet: full, and links taken
      expect((await h.s.db('directory_sync_state').where({ provider_id: gStore }).first())?.users_delta_link).toContain('$deltatoken=');
      r = await h.s.sync.syncProvider(row);
      expect(r).toMatchObject({ mode: 'delta', checked: 0 }); // nothing changed

      // Ann leaves Fab Engineering: the groups delta names her, Ben is not asked about
      g2.users.get('a-1')!.groups = [{ id: 'f-all', displayName: 'Fab Staff', securityEnabled: true }];
      g2.memberChange('f-eng', 'a-1', true);
      g2.requests.length = 0;
      r = await h.s.sync.syncProvider(row);
      expect(r).toMatchObject({ mode: 'delta', checked: 1, updated: 1 });
      expect(g2.requests.some((x) => x.path.startsWith('/v1.0/users/b-1'))).toBe(false);
      const ann = (await h.s.users.byUsername(h.tenantId, 'ann@fabrikam.test'))!;
      expect(await h.s.users.roleIds(ann.id)).toEqual(['member']);

      // Ben disabled in Entra: the users delta names him (in pages of two changes)
      g2.users.get('b-1')!.accountEnabled = false;
      g2.touchUser('d-1');
      g2.touchUser('c-1');
      g2.touchUser('b-1');
      r = await h.s.sync.syncProvider(row);
      expect(r.mode).toBe('delta');
      expect(r.disabled.map((d) => d.username)).toEqual(['ben@fabrikam.test']);

      // the link expired: 410, a full pull, new links
      g2.expireDeltas();
      r = await h.s.sync.syncProvider(row);
      expect(r).toMatchObject({ mode: 'full', checked: 1 });
      expect(r.fullBecause).toMatch(/expired \(410\)/);
      expect((await h.s.sync.syncProvider(row)).mode).toBe('delta');

      // a renamed group: its transitive members are looked up (what mappings name changed)
      await send(admin, 'post', '/api/admin/group-mappings', { providerId: gStore, group: 'Fabrikam Staff', role: 'member', clearance: 'internal' }).expect(201);
      g2.renameGroup('f-all', 'Fabrikam Staff');
      r = await h.s.sync.syncProvider(row);
      expect(r).toMatchObject({ mode: 'delta', checked: 1 });
      expect(g2.requests.some((x) => x.path.includes('/groups/f-all/transitiveMembers'))).toBe(true);
      const link = (await h.s.db('user_identities').where({ user_id: ann.id, provider_id: gStore }).first()) as { groups: string };
      expect(JSON.parse(link.groups)).toEqual(['Fabrikam Staff']);

      // a deleted group: its members are gone with it, so everyone is pulled
      g2.deleteGroup('f-old');
      r = await h.s.sync.syncProvider(row);
      expect(r.mode).toBe('full');
      expect(r.fullBecause).toMatch(/group was deleted/);
      expect((await h.s.sync.syncProvider(row)).mode).toBe('delta');
    });

    it('imports a Google Workspace directory page by page, suspended accounts left out', async () => {
      google.userPageSize = 1;
      google.users.set('g-102', { id: 'g-102', primaryEmail: 'erin@example.com', fullName: 'Erin Example', groups: [{ id: 'gg-1', email: 'eng@example.com', name: 'Engineering' }] });
      const created = await send(admin, 'post', '/api/admin/identity-providers', { name: 'Google import', kind: 'oidc', config: { issuer: idp.url, clientId: idp.clientId, clientSecret: 'vault:identity/google#rpSecret', usernameClaim: 'email', directory: { api: 'google', tokenUrl: `${google.url}/token`, apiUrl: `${google.url}/admin/directory/v1`, serviceAccount: 'vault:identity/google#serviceAccount', subject: google.admin } } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      googleStore = created.body.id;
      await send(admin, 'post', '/api/admin/group-mappings', { providerId: googleStore, group: 'eng@example.com', role: 'member', clearance: 'internal' }).expect(201);
      const dry = await imp(googleStore, {});
      await drain();
      const rep = await report(googleStore, dry.body.id);
      // carol and erin are made (carol was only looked up by the earlier Google store, never signed in); dan is suspended
      expect(rep.summary).toMatchObject({ users: 3, disabled: 1, create: 2 });
      expect(rep.report.find((x: { username: string }) => x.username === 'dan@example.com').action).toBe('disabled');
      const run = await imp(googleStore, { dryRun: false, fromDryRun: dry.body.id });
      await drain();
      expect((await report(googleStore, run.body.id)).summary).toMatchObject({ applied: 2 });
      expect((await h.s.users.byUsername(h.tenantId, 'erin@example.com'))?.state).toBe('active');
      // Google has no delta: a sync of it is a full pull, and keeps no links
      const sync = await h.s.sync.syncProvider((await h.s.providers.get(h.tenantId, googleStore))!);
      expect(sync.mode).toBe('full');
      expect(await h.s.db('directory_sync_state').where({ provider_id: googleStore }).first()).toBeUndefined();
    });
  });
});
