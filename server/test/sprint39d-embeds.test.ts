import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { claimsFor, ecPair, eddsa, es256, hs256, jwt, pem, setupApp, testCa, type AppFixture } from './sprint39d-helpers.js';

/*
 * 1.6.0, Sprint 39d (B-8701, B-8702): public embed pages framed only on the allowed host sites, opened and submitted by
 * their id; signed embeds exchanged for embedded sessions that act as the mapped user inside the app, refused when
 * expired, replayed, wrongly signed, for another audience or an unknown key; keys of every kind, the tenant CA included.
 */
describe('B-8701: public embed pages', () => {
  let f: AppFixture;
  beforeEach(async () => {
    f = await setupApp();
  });
  afterEach(async () => {
    await f.h.close();
  });

  it('a public form embeds on the allowed sites only, by its embed id, and submits through the public path', async () => {
    const { dee, h } = f;
    await dee.post('/api/apps/crm/forms', { name: 'intake', title: 'New deal', entity: 'deal', definition: { fields: [{ field: 'title' }, { field: 'region' }] } }).expect(201);
    // Not public yet: no embed page.
    expect((await dee.post('/api/apps/crm/embed/pages', { form: 'intake' }).expect(409)).body.detail).toMatch(/public form/);
    await dee.post('/api/apps/crm/forms/intake/public', { enabled: true }).expect(200);
    await dee.put('/api/apps/crm/embed', { allowedHosts: ['example.com'] }).expect(400);
    const cfg = (await dee.put('/api/apps/crm/embed', { publicEnabled: true, allowedHosts: ['https://example.com', 'https://intranet.example.com:8443'] }).expect(200)).body as { frameAncestors: string; audience: string };
    expect(cfg.frameAncestors).toBe("'self' https://example.com https://intranet.example.com:8443");
    const page = (await dee.post('/api/apps/crm/embed/pages', { form: 'intake' }).expect(201)).body as { id: string; url: string };
    expect(page.url).toMatch(new RegExp(`/embed/${page.id}$`));
    const html = await request(h.app).get(`/embed/${page.id}`).expect(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.headers['content-security-policy']).toContain("frame-ancestors 'self' https://example.com https://intranet.example.com:8443");
    expect(html.headers['x-frame-options']).toBeUndefined();
    expect(html.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(html.text).toContain(`data-embed="${page.id}"`);
    expect(html.text).toContain('/js/embed.js');
    // The page's calls: open (the form's fields) and submit, by the embed id; the link token never appears.
    const opened = (await request(h.app).post('/api/public/embeds/open').send({ embed: page.id }).expect(200)).body as { title: string; fields: { name: string }[]; form: string };
    expect(opened.title).toBe('New deal');
    expect(opened.fields.map((x) => x.name)).toEqual(['title', 'region']);
    expect(JSON.stringify(opened)).not.toContain('exa_');
    const sub = (await request(h.app).post('/api/public/embeds/submit').send({ embed: page.id, values: { title: 'From the embed', region: 'emea', amount: 999 } }).expect(201)).body as { submitted: boolean; dropped: number };
    expect(sub.submitted).toBe(true);
    expect(sub.dropped).toBe(1); // amount is not on the form
    const rows = (await dee.get('/api/apps/crm/deal?where=title:eq:From the embed').expect(200)).body as { records: { source: string; values: { amount?: number } }[] };
    expect(rows.records).toHaveLength(1);
    expect(rows.records[0]!.source).toBe('form');
    expect(rows.records[0]!.values.amount).toBeUndefined();
    // The embed is listed with its settings; turning public embeds off takes the page away; removing it too.
    const view = (await dee.get('/api/apps/crm/embed').expect(200)).body as { pages: { id: string; form: string; public: boolean }[]; publicEnabled: boolean };
    expect(view.pages.map((p) => [p.id, p.form, p.public])).toEqual([[page.id, 'intake', true]]);
    await dee.put('/api/apps/crm/embed', { publicEnabled: false }).expect(200);
    await request(h.app).get(`/embed/${page.id}`).expect(404);
    await request(h.app).post('/api/public/embeds/open').send({ embed: page.id }).expect(404);
    await dee.put('/api/apps/crm/embed', { publicEnabled: true }).expect(200);
    await dee.post('/api/apps/crm/forms/intake/public', { enabled: false }).expect(200);
    await request(h.app).get(`/embed/${page.id}`).expect(404);
    await dee.del(`/api/apps/crm/embed/pages/${page.id}`).expect(204);
    await request(h.app).get('/embed/00000000000000000000000000').expect(404);
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'app.embed.%').select('action')) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['app.embed.updated', 'app.embed.page.created', 'app.embed.page.removed']));
  });
});

describe('B-8702: signed embeds', () => {
  let f: AppFixture;
  beforeEach(async () => {
    f = await setupApp();
  });
  afterEach(async () => {
    await f.h.close();
  });

  const session = (f: AppFixture, token: string) => request(f.h.app).post('/api/public/embeds/session').send({ tenant: f.h.tenantId, app: 'crm', token });

  it('a token signed with a registered key opens a session that acts as the mapped user inside the app only', async () => {
    const { dee, h, member, bearer, apac } = f;
    await dee.post('/api/apps/crm/policies', { name: 'Own region', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' }, fields: { ssn: { read: true, unmasked: false, mask: 'last4' } } }).expect(201);
    await member('ana', { region: 'emea' });
    const host = ecPair();
    // Signed embeds off: no page, no exchange.
    await request(h.app).get(`/embed/app/${h.tenantId}/crm`).expect(404);
    const cfg = (await dee.put('/api/apps/crm/embed', { signedEnabled: true, allowedHosts: ['https://portal.example.com'], entities: ['deal'], maxTtlSeconds: 600 }).expect(200)).body as { audience: string; signedUrl: string };
    expect(cfg.audience).toMatch(/^exprsn-ai:app:/);
    await dee.put('/api/apps/crm/embed', { entities: ['nope'] }).expect(400);
    expect((await dee.post('/api/apps/crm/embed/keys', { kid: 'portal-1', alg: 'ES256' }).expect(400)).body.detail).toMatch(/public key/);
    const key = (await dee.post('/api/apps/crm/embed/keys', { kid: 'portal-1', alg: 'ES256', publicKey: pem(host.publicKey) }).expect(201)).body as { id: string; kid: string; state: string };
    expect(key.state).toBe('active');
    await dee.post('/api/apps/crm/embed/keys', { kid: 'portal-1', alg: 'ES256', publicKey: pem(host.publicKey) }).expect(409);
    const page = await request(h.app).get(`/embed/app/${h.tenantId}/crm`).expect(200);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'self' https://portal.example.com");
    expect(page.text).toContain(`data-audience="${cfg.audience}"`);

    const token = jwt({ alg: 'ES256', kid: 'portal-1' }, claimsFor(cfg.audience, 'ana'), es256(host.privateKey));
    const opened = (await session(f, token).expect(200)).body as { token: string; expiresAt: number; user: { username: string }; write: boolean; entities: { name: string }[] };
    expect(opened.token).toMatch(/^exe_/);
    expect(opened.user.username).toBe('ana');
    expect(opened.write).toBe(false);
    expect(opened.entities.map((e) => e.name)).toEqual(['deal']);
    expect(opened.expiresAt).toBeLessThanOrEqual(Date.now() + 61_000);
    const e = bearer(opened.token);
    const list = (await e.get('/api/apps/crm/deal').expect(200)).body as { records: { values: Record<string, unknown> }[] };
    expect(list.records.map((r) => r.values.title).sort()).toEqual(['Contoso', 'Fabrikam']);
    expect(list.records.find((r) => r.values.title === 'Contoso')!.values.ssn).toBe('***-**-6789');
    await e.get(`/api/apps/crm/deal/${apac.id}`).expect(404);
    expect((await e.post('/api/apps/crm/deal', { values: { title: 'x', region: 'emea' } }).expect(403)).body.step).toBe('scope');
    expect((await e.get('/api/apps/crm/company').expect(403)).body.detail).toMatch(/does not reach the entity company/);
    expect((await e.get('/api/me').expect(403)).body.detail).toMatch(/inside its app only/);
    await e.get('/api/apps/crm/schema').expect(403);
    // The same token again is a replay; a session lasts no longer than the app allows; a revoked key ends its sessions.
    expect((await session(f, token).expect(401)).body.detail).toMatch(/already used/);
    await dee.put('/api/apps/crm/embed', { write: true, maxTtlSeconds: 60 }).expect(200);
    const long = jwt({ alg: 'ES256', kid: 'portal-1' }, claimsFor(cfg.audience, 'ana', { exp: Math.floor(Date.now() / 1000) + 3600 }), es256(host.privateKey));
    const second = (await session(f, long).expect(200)).body as { token: string; expiresAt: number; write: boolean };
    expect(second.expiresAt).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(second.write).toBe(true);
    const made = (await bearer(second.token).post('/api/apps/crm/deal', { values: { title: 'By embed', region: 'emea' } }).expect(201)).body as { id: string; createdBy: string };
    expect(made.createdBy).toBeTruthy();
    const sessions = (await dee.get('/api/apps/crm/embed').expect(200)).body.sessions as { username: string; revokedAt: number | null }[];
    expect(sessions.filter((s) => s.username === 'ana')).toHaveLength(2);
    await dee.del(`/api/apps/crm/embed/keys/${key.id}`).expect(200);
    await bearer(second.token).get('/api/apps/crm/deal').expect(401);
    expect((await session(f, jwt({ alg: 'ES256', kid: 'portal-1' }, claimsFor(cfg.audience, 'ana'), es256(host.privateKey))).expect(401)).body.detail).toMatch(/revoked/);
    const audited = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'app.embed.session.%').select('action')) as { action: string }[]).map((a) => a.action);
    expect(audited.filter((a) => a === 'app.embed.session.created')).toHaveLength(2);
    expect(audited.filter((a) => a === 'app.embed.session.refused').length).toBeGreaterThanOrEqual(2);
  });

  it('refuses expired, tampered, misaddressed, unmapped and unknown-key tokens, and accepts HS256, EdDSA and tenant CA keys', async () => {
    const { dee, h, member } = f;
    await member('ana', null, 'ana@example.com');
    const cfg = (await dee.put('/api/apps/crm/embed', { signedEnabled: true, claimName: 'email', claimMatch: 'email' }).expect(200)).body as { audience: string };
    const host = ecPair();
    await dee.post('/api/apps/crm/embed/keys', { kid: 'es', alg: 'ES256', publicKey: pem(host.publicKey) }).expect(201);
    const good = () => claimsFor(cfg.audience, 'x', { email: 'Ana@Example.com' });
    expect((await session(f, 'not.a.jwt.but.long.enough.to.pass.the.shape.check').expect(401)).body.detail).toMatch(/not a JWT/);
    expect((await session(f, jwt({ alg: 'ES256', kid: 'nope' }, good(), es256(host.privateKey))).expect(401)).body.detail).toMatch(/No key nope/);
    expect((await session(f, jwt({ alg: 'HS256', kid: 'es' }, good(), hs256('a'.repeat(43)))).expect(401)).body.detail).toMatch(/signs ES256 tokens/);
    expect((await session(f, jwt({ alg: 'ES256', kid: 'es' }, good(), es256(ecPair().privateKey))).expect(401)).body.detail).toMatch(/signature does not verify/);
    expect((await session(f, jwt({ alg: 'ES256', kid: 'es' }, { ...good(), aud: 'exprsn-ai:app:other' }, es256(host.privateKey))).expect(401)).body.detail).toMatch(/audience/);
    expect((await session(f, jwt({ alg: 'ES256', kid: 'es' }, { ...good(), exp: Math.floor(Date.now() / 1000) - 120 }, es256(host.privateKey))).expect(401)).body.detail).toMatch(/expired/);
    expect((await session(f, jwt({ alg: 'ES256', kid: 'es' }, { ...good(), jti: undefined }, es256(host.privateKey))).expect(401)).body.detail).toMatch(/jti/);
    expect((await session(f, jwt({ alg: 'ES256', kid: 'es' }, { ...good(), email: 'nobody@example.com' }, es256(host.privateKey))).expect(401)).body.detail).toMatch(/No active user/);
    expect((await session(f, jwt({ alg: 'ES256', kid: 'es' }, good(), es256(host.privateKey))).expect(200)).body.user.username).toBe('ana');
    // HS256: the secret is shown once and signs tokens; a wrong secret does not.
    const hs = (await dee.post('/api/apps/crm/embed/keys', { kid: 'hs', alg: 'HS256' }).expect(201)).body as { secret: string; notice: string };
    expect(hs.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(((await dee.get('/api/apps/crm/embed').expect(200)).body.keys as { kid: string; secret?: string }[]).find((k) => k.kid === 'hs')!.secret).toBeUndefined();
    await session(f, jwt({ alg: 'HS256', kid: 'hs' }, good(), hs256(hs.secret))).expect(200);
    await session(f, jwt({ alg: 'HS256', kid: 'hs' }, good(), hs256('b'.repeat(43)))).expect(401);
    // EdDSA.
    const ed = (await import('./sprint39d-helpers.js')).edPair();
    await dee.post('/api/apps/crm/embed/keys', { kid: 'ed', alg: 'EdDSA', publicKey: pem(ed.publicKey) }).expect(201);
    await session(f, jwt({ alg: 'EdDSA', kid: 'ed' }, good(), eddsa(ed.privateKey))).expect(200);
    // The tenant CA: a certificate it issued verifies; one from elsewhere does not; a key needs an active CA.
    expect((await dee.post('/api/apps/crm/embed/keys', { kid: 'ca', alg: 'x5c' }).expect(409)).body.detail).toMatch(/no active certificate authority/);
    const ca = await testCa(h, h.tenantId);
    await dee.post('/api/apps/crm/embed/keys', { kid: 'ca', alg: 'x5c' }).expect(201);
    const leaf = await ca.issue('portal.example.com');
    await session(f, jwt({ alg: 'ES256', kid: 'ca', x5c: [leaf.x5c] }, good(), es256(leaf.key))).expect(200);
    expect((await session(f, jwt({ alg: 'ES256', kid: 'ca' }, good(), es256(leaf.key))).expect(401)).body.detail).toMatch(/no certificate/);
    const stranger = await testCa(h, '00000000000000000000000000');
    const foreign = await stranger.issue('evil.example.com');
    expect((await session(f, jwt({ alg: 'ES256', kid: 'ca', x5c: [foreign.x5c] }, good(), es256(foreign.key))).expect(401)).body.detail).toMatch(/not issued by the tenant CA/);
    // A disabled user is refused even with a good token.
    const ana = (await h.s.users.byUsername(h.tenantId, 'ana'))!;
    await h.s.users.update(h.tenantId, ana.id, { state: 'disabled' });
    expect((await session(f, jwt({ alg: 'ES256', kid: 'es' }, good(), es256(host.privateKey))).expect(401)).body.detail).toMatch(/No active user/);
  });
});
