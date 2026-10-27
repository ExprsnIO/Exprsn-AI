import type * as dnsModule from 'node:dns';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GuardedFetch } from '../src/atproto/did.js';
import { HandleError, HandleResolver, normaliseHandle } from '../src/atproto/handles.js';
import { decodeJwt } from '../src/federation/jose.js';
import { servicePolicy } from '../src/platform/egress.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { FakePlcDirectory } from './sprint25b-fakes.js';
import { FakePds } from './sprint26b-fakes.js';

// Names under .s26b.test resolve by plan (A records and TXT records); other names resolve normally.
const dnsPlan = vi.hoisted(() => ({ a: new Map<string, string[]>(), txt: new Map<string, string[][]>() }));
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof dnsModule>();
  type Cb = (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void;
  const lookup = (host: string, opts: unknown, cb?: Cb) => {
    const callback = (typeof opts === 'function' ? opts : cb) as Cb;
    const plan = dnsPlan.a.get(host);
    if (!plan) {
      if (host.endsWith('.s26b.test')) return queueMicrotask(() => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }), ''));
      return (actual.lookup as unknown as (h: string, o: unknown, c: Cb) => void)(host, typeof opts === 'function' ? {} : opts, callback);
    }
    const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
    const list = plan.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    queueMicrotask(() => callback(null, all ? list : list[0]!.address, list[0]!.family));
  };
  const resolveTxt = (name: string, cb: (err: NodeJS.ErrnoException | null, records: string[][]) => void) => {
    const plan = dnsPlan.txt.get(name);
    if (plan) return queueMicrotask(() => cb(null, plan));
    if (name.endsWith('.s26b.test')) return queueMicrotask(() => cb(Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' }), []));
    return actual.resolveTxt(name, cb);
  };
  return { ...actual, lookup, resolveTxt, default: { ...actual, lookup, resolveTxt } };
});

const did = (name: string) => `did:plc:${name.padEnd(24, 'a').replace(/[^a-z2-7]/g, 'a').slice(0, 24)}`;
const ALICE = { did: did('alice'), handle: 'alice.s26b.test' };
const BOB = { did: did('bob'), handle: 'bob.s26b.test' };
const CAROL = { did: did('carol'), handle: 'carol.s26b.test' };
const DAVE = { did: did('dave'), handle: 'dave.s26b.test' };
const ERIN = { did: did('erin'), handle: 'erin.s26b.test' };

const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

describe('Sprint 26 (B-1807, B-1808): AT-Protocol accounts', () => {
  let h: Harness;
  let plc: FakePlcDirectory;
  let pds: FakePds;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let storeId = '';

  const as = (c: { agent: ReturnType<typeof request.agent>; csrf: string }, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) => {
    const r = c.agent[method](url).set('x-csrf-token', c.csrf);
    return body === undefined ? r : r.send(body as object);
  };

  beforeAll(async () => {
    plc = new FakePlcDirectory();
    await plc.start();
    h = await harness({ ATPROTO_PLC_URL: plc.url });
    // The authorization server reads the client metadata document and key set from the app under test.
    pds = new FakePds(async (url) => (await request(h.app).get(new URL(url).pathname).expect(200)).body as unknown);
    await pds.start();
    for (const a of [ALICE, BOB, CAROL, DAVE, ERIN]) {
      pds.register(plc, a);
      dnsPlan.txt.set(`_atproto.${a.handle}`, [[`did=${a.did}`]]);
    }
    await localUser(h, 'ident', ['identity-admin', 'member']);
    admin = await loginAdmin(h, 'ident');
    await localUser(h, 'alice', ['member']);
    await localUser(h, 'bob', ['member']);
  });

  afterAll(async () => {
    await h?.close();
    await pds?.stop();
    await plc?.stop();
  });

  describe('B-1807: handles and user DIDs', () => {
    it('checks handle syntax; .test is accepted outside production only', () => {
      expect(normaliseHandle('@Alice.Example.COM', { production: true })).toBe('alice.example.com');
      for (const bad of ['localhost', 'alice', 'a..b.com', '-a.com', 'a.123', 'x.local', 'x.internal', 'x.onion', `${'a'.repeat(64)}.com`]) expect(() => normaliseHandle(bad, { production: false }), bad).toThrow(HandleError);
      expect(() => normaliseHandle('alice.test', { production: true })).toThrow(/not allowed/);
      expect(normaliseHandle('alice.test', { production: false })).toBe('alice.test');
    });

    it('resolves a handle by DNS TXT, and by /.well-known/atproto-did when there is no record', async () => {
      const http = new GuardedFetch(() => servicePolicy({}));
      const dns = new HandleResolver(http, { production: false });
      expect(await dns.resolve('alice.s26b.test')).toEqual({ handle: 'alice.s26b.test', did: ALICE.did, method: 'dns' });
      pds.wellKnownDid = DAVE.did;
      const web = new HandleResolver(http, { production: false, wellKnownUrl: () => `${pds.url}/.well-known/atproto-did` });
      expect(await web.resolve('web-only.s26b.test')).toEqual({ handle: 'web-only.s26b.test', did: DAVE.did, method: 'https' });
      dnsPlan.txt.set('_atproto.two.s26b.test', [[`did=${ALICE.did}`], [`did=${BOB.did}`]]);
      await expect(dns.resolve('two.s26b.test')).rejects.toMatchObject({ code: 'conflict' });
      await http.close();
    });

    it('refuses a handle pointing at a link-local address (and at the metadata address), through the service URL checks', async () => {
      dnsPlan.a.set('evil.s26b.test', ['169.254.10.1']);
      dnsPlan.a.set('imds.s26b.test', ['169.254.169.254']);
      const http = new GuardedFetch(() => servicePolicy({}));
      const resolver = new HandleResolver(http, { production: false });
      await expect(resolver.resolve('evil.s26b.test')).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/link-local/) });
      await expect(resolver.resolve('imds.s26b.test')).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/metadata/) });
      await http.close();

      // Through the API: the claim and the identity admins' check are both refused, with the reason.
      const alice = await login(h, 'alice');
      const claim = await as(alice, 'post', '/api/me/atproto/claim', { account: 'evil.s26b.test' });
      expect(claim.status).toBe(422);
      expect(claim.body).toMatchObject({ step: 'handle', reason: 'refused' });
      expect(claim.body.detail).toMatch(/link-local/);
      const check = await as(admin, 'post', '/api/admin/atproto/accounts/check', { account: 'evil.s26b.test' }).expect(200);
      expect(check.body.ok).toBe(false);
      expect(check.body.steps[0].detail).toMatch(/link-local/);
      // The same handle is fine once it points at an address the policy admits.
      dnsPlan.a.set('evil.s26b.test', ['127.0.0.1']);
      expect((await as(alice, 'post', '/api/me/atproto/claim', { account: 'evil.s26b.test' })).body.reason).toBe('not_found');
    });

    it('binds a DID after the challenge appears in its profile record; one user per DID; handles must resolve back', async () => {
      const alice = await login(h, 'alice');
      const claim = await as(alice, 'post', '/api/me/atproto/claim', { account: ALICE.handle }).expect(201);
      expect(claim.body.binding).toMatchObject({ did: ALICE.did, verified: false, challengePending: true });
      const token = claim.body.challenge.token as string;
      expect(token).toMatch(/^exprsn-ai-verify-[0-9a-f]{32}$/);
      // Stored as a hash only.
      const stored = await h.s.db('atproto_user_dids').where({ did: ALICE.did }).first();
      expect(JSON.stringify(stored)).not.toContain(token);

      const early = await as(alice, 'post', '/api/me/atproto/verify', {});
      expect(early.status).toBe(409);
      expect(early.body.step).toBe('proof');
      pds.accounts.get(ALICE.did)!.description = `Hello. ${token}`;
      const ok = await as(alice, 'post', '/api/me/atproto/verify', {}).expect(200);
      expect(ok.body.binding).toMatchObject({ did: ALICE.did, verified: true, proof: 'profile', handle: ALICE.handle, challengePending: false });
      // The challenge is used up.
      expect((await as(alice, 'post', '/api/me/atproto/verify', {})).status).toBe(409);

      // Bob cannot bind Alice's DID.
      const bob = await login(h, 'bob');
      const taken = await as(bob, 'post', '/api/me/atproto/claim', { account: ALICE.did });
      expect(taken.status).toBe(409);

      // A handle naming another DID is refused for Alice's binding.
      const wrong = await as(alice, 'put', '/api/me/atproto/handle', { handle: BOB.handle });
      expect(wrong.status).toBe(422);
      expect(wrong.body.reason).toBe('mismatch');

      const list = await as(admin, 'get', '/api/admin/atproto/accounts?verified=true').expect(200);
      expect(list.body).toEqual([expect.objectContaining({ did: ALICE.did, username: 'alice', verified: true })]);
      const actions = (await h.s.db('audit_events').whereIn('action', ['atproto.did.claimed', 'atproto.did.verified', 'atproto.did.verify_failed']).select('action')).map((r: { action: string }) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['atproto.did.claimed', 'atproto.did.verified', 'atproto.did.verify_failed']));
    });

    it('needs the atproto:link permission', async () => {
      await localUser(h, 'auditor1', ['auditor']);
      const a = await login(h, 'auditor1');
      // The auditor role needs a second factor first; whatever the stage, the route is not served.
      expect([401, 403]).toContain((await as(a, 'get', '/api/me/atproto')).status);
    });
  });

  describe('B-1808: sign-in with an AT-Protocol account', () => {
    beforeAll(async () => {
      const store = await as(admin, 'post', '/api/admin/identity-providers', { name: 'Bluesky', kind: 'atproto', position: 200, config: {} }).expect(201);
      storeId = store.body.id;
      await as(admin, 'post', '/api/admin/group-mappings', { providerId: storeId, group: CAROL.did, role: 'member', clearance: 'internal' }).expect(201);
    });

    const begin = async (handle: string, provider = storeId) => {
      const browser = request.agent(h.app);
      const start = await browser.get(`/federation/atproto/start?${new URLSearchParams({ provider, handle })}`);
      return { browser, start };
    };

    it('serves the client metadata document the authorization server fetches', async () => {
      const r = await request(h.app).get('/federation/atproto/client-metadata.json').expect(200);
      expect(r.body).toMatchObject({
        client_id: 'http://localhost:8080/federation/atproto/client-metadata.json',
        redirect_uris: ['http://localhost:8080/federation/atproto/callback'],
        scope: 'atproto',
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: 'ES256',
        jwks_uri: 'http://localhost:8080/.well-known/jwks.json',
        dpop_bound_access_tokens: true,
        grant_types: ['authorization_code', 'refresh_token']
      });
      const opts = await request(h.app).get('/api/auth/sign-in-options').expect(200);
      expect(opts.body.upstream).toEqual(expect.arrayContaining([{ id: storeId, name: 'Bluesky', protocol: 'atproto', start: `/federation/atproto/start?provider=${storeId}` }]));
      // Without a handle, the start page asks for one.
      const form = await request(h.app).get(`/federation/atproto/start?provider=${storeId}`).expect(200);
      expect(form.text).toContain('name="handle"');
    });

    it('completes a sign-in against the local PDS double with a DPoP-bound token (PAR, PKCE, DPoP nonces), mapping the DID to a role', async () => {
      const before = { par: pds.log.nonceRetries.par, issued: pds.log.issued.length };
      const { browser, start } = await begin(CAROL.handle);
      expect(start.status).toBe(302);
      const location = start.headers.location!;
      expect(location.startsWith(`${pds.url}/oauth/authorize?`)).toBe(true);
      // PAR was used, with the server's nonce after one use_dpop_nonce answer, PKCE S256 and the handle as login hint.
      expect(pds.log.nonceRetries.par).toBeGreaterThan(before.par);
      expect(pds.log.pars.at(-1)).toMatchObject({ scope: 'atproto', loginHint: CAROL.handle, redirectUri: 'http://localhost:8080/federation/atproto/callback' });

      const callback = pds.authorize(location, CAROL.did);
      const done = await browser.get(pathOf(callback));
      expect(done.status).toBe(302);
      expect(done.headers.location).toBe('/');

      // The token: DPoP-bound to the key whose proofs the PAR, the token request and the PDS session check carried.
      const issued = pds.log.issued.slice(before.issued);
      expect(issued).toHaveLength(1);
      expect(issued[0]!.tokenType).toBe('DPoP');
      const cnf = decodeJwt(issued[0]!.access).claims.cnf as { jkt: string };
      expect(cnf.jkt).toBe(issued[0]!.jkt);
      expect(pds.log.pars.at(-1)!.jkt).toBe(cnf.jkt);
      expect(pds.log.sessions.at(-1)).toEqual({ did: CAROL.did, jkt: cnf.jkt });
      // Exprsn-AI keeps no tokens: both were revoked.
      await vi.waitFor(() => expect(pds.log.revoked).toEqual(expect.arrayContaining([issued[0]!.access, issued[0]!.refresh])));

      const session = await browser.get('/api/auth/session').expect(200);
      expect(session.body.stage).toBe('active');
      const me = await browser.get('/api/me').expect(200);
      expect(me.body.user.username).toBe(CAROL.handle);
      const user = (await h.s.users.byUsername(h.tenantId, CAROL.handle))!;
      expect(await h.s.users.roleIds(user.id)).toEqual(['member']);
      expect(await h.s.users.identity(storeId, CAROL.did)).toMatchObject({ user_id: user.id });
      const audit = await h.s.db('audit_events').where({ action: 'auth.login' }).orderBy('seq', 'desc').first();
      expect(JSON.parse(audit.target)).toMatchObject({ provider: 'Bluesky', kind: 'atproto' });
    });

    it('signs a bound DID in as the user it is bound to', async () => {
      const { browser, start } = await begin(ALICE.handle);
      const done = await browser.get(pathOf(pds.authorize(start.headers.location!, ALICE.did)));
      expect(done.status).toBe(302);
      const me = await browser.get('/api/me').expect(200);
      expect(me.body.user.username).toBe('alice');
      // No second account and no mapping change for her.
      expect(await h.s.users.byUsername(h.tenantId, ALICE.handle)).toBeUndefined();
      const alice = (await h.s.users.byUsername(h.tenantId, 'alice'))!;
      expect(await h.s.users.roleIds(alice.id)).toEqual(['member']);
    });

    it('refuses an unmapped DID, and any unbound DID when the store admits bound DIDs only', async () => {
      const { browser, start } = await begin(DAVE.handle);
      const refused = await browser.get(pathOf(pds.authorize(start.headers.location!, DAVE.did)));
      expect(refused.status).toBe(403);
      expect(refused.text).toMatch(/not in a group mapped/);

      await as(admin, 'patch', `/api/admin/identity-providers/${storeId}`, { config: { boundOnly: true } }).expect(200);
      try {
        const c = await begin(CAROL.handle);
        const r = await c.browser.get(pathOf(pds.authorize(c.start.headers.location!, CAROL.did)));
        expect(r.status).toBe(403);
        expect(r.text).toMatch(/not linked/);
        expect(await h.s.db('audit_events').where({ action: 'auth.login.refused' }).whereLike('detail', '%not_bound%').first()).toBeTruthy();
      } finally {
        await as(admin, 'patch', `/api/admin/identity-providers/${storeId}`, { config: { boundOnly: false } }).expect(200);
      }
    });

    it('refuses another account than asked for, a response from another issuer, a non-DPoP token, a replayed or foreign callback', async () => {
      const failed = async (setup: () => void, expectText: RegExp) => {
        const { browser, start } = await begin(CAROL.handle);
        setup();
        try {
          const r = await browser.get(pathOf(pds.authorize(start.headers.location!, CAROL.did)));
          expect(r.status).toBe(400);
          expect(r.text).toMatch(expectText);
        } finally {
          pds.subOverride = null;
          pds.issOverride = null;
          pds.tokenType = 'DPoP';
        }
      };
      await failed(() => (pds.subOverride = ERIN.did), /another account/);
      await failed(() => (pds.issOverride = 'https://evil.example'), /authorization server the sign-in went to/);
      await failed(() => (pds.tokenType = 'Bearer'), /not DPoP-bound/);

      // A callback replayed, or opened in a browser that did not start the sign-in.
      const { browser, start } = await begin(CAROL.handle);
      const cb = pathOf(pds.authorize(start.headers.location!, CAROL.did));
      const other = await request.agent(h.app).get(cb);
      expect(other.status).toBe(400);
      expect(other.text).toMatch(/another browser/);
      expect((await browser.get(cb)).status).toBe(302);
      expect((await browser.get(cb)).text).toMatch(/already used|unknown/);
    });

    it('refuses an account whose authorization server the store does not accept', async () => {
      await as(admin, 'patch', `/api/admin/identity-providers/${storeId}`, { config: { authServers: ['https://pds.corp.example'] } }).expect(200);
      try {
        const { start } = await begin(CAROL.handle);
        expect(start.status).toBe(400);
        expect(start.text).toMatch(/does not accept accounts from/);
      } finally {
        await as(admin, 'patch', `/api/admin/identity-providers/${storeId}`, { config: {} }).expect(200);
      }
    });

    it('B-1807: binds a DID by signing in at its authorization server from Settings ("link")', async () => {
      const bob = await login(h, 'bob');
      const link = await as(bob, 'post', '/api/me/atproto/link', { account: BOB.handle }).expect(200);
      const done = await bob.agent.get(pathOf(pds.authorize(link.body.url, BOB.did)));
      expect(done.status).toBe(302);
      expect(done.headers.location).toBe('/#/settings?atproto=linked');
      const mine = await as(bob, 'get', '/api/me/atproto').expect(200);
      expect(mine.body.binding).toMatchObject({ did: BOB.did, verified: true, proof: 'oauth', handle: BOB.handle });
      // Bob can now sign in with his AT-Protocol account.
      const { browser, start } = await begin(BOB.handle);
      await browser.get(pathOf(pds.authorize(start.headers.location!, BOB.did))).expect(302);
      expect((await browser.get('/api/me').expect(200)).body.user.username).toBe('bob');

      // Removing the binding (self) is audited, and an admin can remove one too.
      await as(bob, 'delete', '/api/me/atproto').expect(204);
      const row = await h.s.atprotoAccounts.binding(h.tenantId, (await h.s.users.byUsername(h.tenantId, 'alice'))!.id);
      await as(admin, 'delete', `/api/admin/atproto/accounts/${row!.id}`).expect(204);
      expect(await h.s.db('audit_events').where({ action: 'atproto.did.removed' }).count({ n: '*' }).first()).toMatchObject({ n: 2 });
    });

    it('tests the store: client metadata address and client assertion key', async () => {
      const r = await as(admin, 'post', `/api/admin/identity-providers/${storeId}/test`, {});
      expect(r.status).toBe(200);
      expect(r.body.steps.map((x: { title: string }) => x.title)).toEqual(expect.arrayContaining(['Client metadata address', 'Client assertion key']));
    });
  });
});
