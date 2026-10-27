/*
 * 1.9.99-final, Sprint 61 (B-10903, B-10904) against `fake-cloudflare.ts` only. The WAF and rate limits rendered from
 * the server's own limits and applied (the fake checks them against the zone's plan, as Cloudflare does), rules this
 * build did not write kept; a simulated edge over the applied rules stops a burst of sign-in attempts before the
 * server's failed-sign-in throttle has counted enough to lock the account; /socket.io/ and streaming responses are
 * exempt from buffering. Cloudflare Access for the console with Exprsn-AI's OIDC provider or the account's own
 * identity provider, the machine and public paths excluded, and the server's own `Cf-Access-Jwt-Assertion` check,
 * which is an extra condition and never a sign-in. Migration 161 is applied here when missing.
 */
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessAppFor, accessSchema, edgeCreateSchema, mergeRules } from '../src/cloud/edge.js';
import { evaluateExpression, MANAGED_RULESETS, renderWaf, serverLimits, simulateEdge, SIGN_IN_PATH, type CfRule, type EdgeRequest, type WafPhase } from '../src/cloud/edge-waf.js';
import { accessProtects, accessVerifierFor, ACCESS_EXCLUSIONS } from '../src/http/cloudflare-access.js';
import { edgeWorld, type EdgeWorld } from './cloudflare-edge-helpers.js';
import { localUser, login, PASSWORD } from './helpers.js';

const TEAM = 'exprsn-test.cloudflareaccess.com';

describe('B-10903: the WAF and rate limits, rendered from the server\'s limits', () => {
  const limits = serverLimits({ API_RATE_PER_MINUTE: 600, LOCKOUT_MAX_ATTEMPTS: 5, LOCKOUT_WINDOW_MINUTES: 15, LOCKOUT_DURATION_MINUTES: 15 });

  it('mirrors each limit within the plan, sign-in one attempt below the throttle', () => {
    const free = renderWaf(limits, 'free');
    expect(free.phases.http_ratelimit).toHaveLength(1);
    expect(free.phases.http_ratelimit[0]).toMatchObject({ ref: 'exprsn-rl-signin', ratelimit: { characteristics: ['ip.src', 'cf.colo.id'], period: 10, requests_per_period: 4, mitigation_timeout: 10 } });
    expect(free.mirrored.filter((m) => m.edge === null).map((m) => m.limit)).toEqual(['/api/auth', '/v1', '/api']);
    expect(free.phases.http_request_firewall_managed.map((r) => r.action_parameters?.id).filter(Boolean)).toEqual([MANAGED_RULESETS.free]);

    const biz = renderWaf(limits, 'business');
    const byRef = Object.fromEntries(biz.phases.http_ratelimit.map((r) => [r.ref, r.ratelimit]));
    expect(byRef).toEqual({
      'exprsn-rl-signin': { characteristics: ['ip.src', 'cf.colo.id'], period: 600, requests_per_period: 4, mitigation_timeout: 600 },
      'exprsn-rl-auth': { characteristics: ['ip.src', 'cf.colo.id'], period: 60, requests_per_period: 30, mitigation_timeout: 60 },
      'exprsn-rl-v1': { characteristics: ['ip.src', 'cf.colo.id'], period: 60, requests_per_period: 600, mitigation_timeout: 60 },
      'exprsn-rl-api': { characteristics: ['ip.src', 'cf.colo.id'], period: 60, requests_per_period: 600, mitigation_timeout: 60 }
    });
    // From Pro the OWASP Core Ruleset runs, skipped for model prompts (code and SQL in a prompt are not attacks).
    const managed = biz.phases.http_request_firewall_managed;
    expect(managed[0]).toMatchObject({ action: 'skip', action_parameters: { rulesets: [MANAGED_RULESETS.owasp] } });
    expect(managed.map((r) => r.action_parameters?.id).filter(Boolean)).toEqual([MANAGED_RULESETS.cloudflare, MANAGED_RULESETS.owasp]);
    expect(evaluateExpression(managed[0]!.expression, { method: 'POST', path: '/v1/chat/completions', ip: '1.1.1.1' })).toBe(true);
    expect(evaluateExpression(managed[0]!.expression, { method: 'POST', path: '/api/admin/users', ip: '1.1.1.1' })).toBe(false);
  });

  it('writes expressions the rules language reads as intended', () => {
    const r = renderWaf(limits, 'enterprise', { adminCidrs: ['192.0.2.0/24', '2001:db8::/32'] });
    const rule = (ref: string) => [...Object.values(r.phases).flat()].find((x) => x.ref === ref)!.expression;
    const ev = (ref: string, method: string, p: string, ip = '198.51.100.1') => evaluateExpression(rule(ref), { method, path: p, ip });
    expect(ev('exprsn-rl-signin', 'POST', SIGN_IN_PATH)).toBe(true);
    expect(ev('exprsn-rl-signin', 'GET', SIGN_IN_PATH)).toBe(false);
    expect(ev('exprsn-rl-auth', 'POST', '/api/auth/mfa/totp')).toBe(true);
    expect(ev('exprsn-rl-auth', 'GET', '/api/auth/session')).toBe(false);
    expect(ev('exprsn-rl-api', 'GET', '/api/me')).toBe(true);
    expect(ev('exprsn-rl-api', 'POST', '/api/public/shared-links/open')).toBe(false);
    expect(ev('exprsn-rl-api', 'GET', '/socket.io/')).toBe(false);
    expect(ev('exprsn-rl-v1', 'POST', '/v1/chat/completions')).toBe(true);
    expect(ev('exprsn-block-methods', 'TRACE', '/')).toBe(true);
    expect(ev('exprsn-admin-allow', 'GET', '/api/admin/users', '192.0.2.7')).toBe(false);
    expect(ev('exprsn-admin-allow', 'GET', '/api/admin/users', '198.51.100.7')).toBe(true);
    expect(ev('exprsn-admin-allow', 'GET', '/api/me', '198.51.100.7')).toBe(false);
  });

  it('exempts /socket.io/ and streams from buffering, and never counts the socket', () => {
    const r = renderWaf(limits, 'business');
    const reqs: EdgeRequest[] = [
      ...Array.from({ length: 700 }, (_, i) => ({ method: 'GET', path: '/socket.io/', ip: '203.0.113.9', at: i / 1000 })),
      { method: 'POST', path: '/v1/chat/completions', ip: '203.0.113.9', at: 1 },
      { method: 'POST', path: '/v1/responses', ip: '203.0.113.9', at: 1 },
      { method: 'GET', path: '/css/app.css', ip: '203.0.113.9', at: 1 },
      { method: 'GET', path: '/api/me', ip: '203.0.113.9', at: 1 }
    ];
    const out = simulateEdge(r.phases, reqs);
    expect(out.filter((d) => d.request.path === '/socket.io/').every((d) => d.outcome === 'origin' && d.unbuffered && !d.cached)).toBe(true);
    const at = (p: string) => out.find((d) => d.request.path === p)!;
    expect(at('/v1/chat/completions')).toMatchObject({ outcome: 'origin', unbuffered: true, cached: false });
    expect(at('/v1/responses')).toMatchObject({ unbuffered: true });
    expect(at('/css/app.css')).toMatchObject({ unbuffered: false, cached: true });
    expect(at('/api/me')).toMatchObject({ unbuffered: false, cached: false });
  });

  it('keeps the rules it did not write', () => {
    const theirs = [{ id: 'x1', ref: 'operator-geo', description: 'theirs', expression: 'ip.src in {192.0.2.1}', action: 'block', enabled: true }, { id: 'x2', ref: 'exprsn-rl-old', description: 'ours, old', expression: 'true', action: 'block', enabled: true }];
    const merged = mergeRules(theirs as (CfRule & { id: string })[], renderWaf(limits, 'free').phases.http_ratelimit);
    expect(merged.map((m) => m.ref)).toEqual(['exprsn-rl-signin', 'operator-geo']);
    expect(merged.some((m) => 'id' in m)).toBe(false);
  });
});

describe('B-10903, B-10904: applied at the edge, and Access in front of the console', () => {
  let w: EdgeWorld;
  let edgeId = '';
  const host = 'ai.example.test';
  const applied = (): Partial<Record<WafPhase, CfRule[]>> => Object.fromEntries([...w.cf.edge.rulesets.entries()].filter(([k]) => k.startsWith(`${w.zoneId}|`)).map(([k, v]) => [k.split('|')[1], v.rules as unknown as CfRule[]]));

  beforeAll(async () => {
    w = await edgeWorld({ TRUST_PROXY: 'loopback,cloudflare', CLOUDFLARE_TUNNEL_PEERS: 'loopback', CLOUDFLARE_ACCESS_TEAM_DOMAIN: TEAM });
    // A rule of the operator's own, already in the custom phase.
    w.cf.edge.rulesets.set(`${w.zoneId}|http_request_firewall_custom`, { id: 'rs1', phase: 'http_request_firewall_custom', kind: 'zone', version: 1, rules: [{ id: 'op1', ref: 'operator-geo', expression: 'ip.src in {192.0.2.1}', action: 'block', enabled: true }] });
    const e = await w.h.s.cloud.edge.create(w.admin, edgeCreateSchema.parse({ name: 'console', accountId: w.account.id, hostname: host, zone: 'example.test', plan: 'pro', origin: { kind: 'tunnel', service: 'http://127.0.0.1:8080' } }));
    edgeId = e.id;
  }, 180_000);
  afterAll(async () => w.stop());

  it('is refused by Cloudflare when the rules do not fit the zone\'s plan, and applies when they do', async () => {
    // The zone is on the free plan; a Pro render has two rate limiting rules.
    await expect(w.h.s.cloud.edge.apply(w.admin, edgeId)).rejects.toMatchObject({ status: 409, extensions: { reason: 'edge_apply_failed', step: 'waf' } });
    expect((await w.h.s.cloud.edge.get(edgeId)).lastError).toMatch(/allows 1 rate limiting rule/);
    w.cf.edge.plans.set(w.zoneId, 'pro');
    const done = await w.h.s.cloud.edge.apply(w.admin, edgeId);
    expect(done.state).toBe('applied');
    const phases = applied();
    expect(phases.http_ratelimit!.map((r) => r.ref)).toEqual(['exprsn-rl-signin', 'exprsn-rl-auth']);
    expect(phases.http_request_firewall_custom!.map((r) => r.ref)).toEqual(['exprsn-block-methods', 'operator-geo']);
    expect(Object.keys(phases).sort()).toEqual(['http_config_settings', 'http_ratelimit', 'http_request_cache_settings', 'http_request_firewall_custom', 'http_request_firewall_managed']);
  });

  it('stops a burst of sign-in attempts at the edge before the server\'s throttle counts them', async () => {
    await localUser(w.h, 'victim', ['member']);
    const ip = '203.0.113.50';
    const burst: EdgeRequest[] = Array.from({ length: 25 }, (_, i) => ({ method: 'POST', path: SIGN_IN_PATH, ip, at: i * 0.05 }));
    const decisions = simulateEdge(applied(), burst);
    const passed = decisions.filter((d) => d.outcome === 'origin');
    expect(passed).toHaveLength(4);
    expect(decisions.filter((d) => d.outcome === 'blocked').every((d) => d.rule === 'exprsn-rl-signin')).toBe(true);
    // What passed reaches the server as the tunnel delivers it (the client in CF-Connecting-IP).
    for (const _ of passed) {
      const r = await request(w.h.app).post(SIGN_IN_PATH).set('cf-connecting-ip', ip).send({ username: 'victim', password: 'not the password' });
      expect(r.status).toBe(401);
    }
    const tenant = w.h.tenantId;
    const state = await w.h.s.throttle.check([`u:${tenant}:victim`, `ip:${ip}`]);
    expect(state).toMatchObject({ locked: false, remaining: 1 });
    // The account still signs in with its password: the burst never locked it.
    const ok = await request(w.h.app).post(SIGN_IN_PATH).set('cf-connecting-ip', ip).send({ username: 'victim', password: PASSWORD });
    expect(ok.status).toBe(200);
    // Without the edge, the same burst would have locked the account at the server.
    await localUser(w.h, 'victim2', ['member']);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await request(w.h.app).post(SIGN_IN_PATH).set('cf-connecting-ip', '203.0.113.51').send({ username: 'victim2', password: 'not the password' })).status);
    expect(statuses).toContain(429);
  });

  it('refuses a host-wide Access application with Exprsn-AI\'s own OIDC provider (the sign-in page would be behind it)', async () => {
    const c = w.admin.client;
    const r = await c.agent.put(`/api/admin/cloud/edge/${edgeId}/access`).set('x-csrf-token', c.csrf).send({ scope: 'host', teamDomain: TEAM, idp: { kind: 'exprsn', clientId: 'c_nothing', clientSecret: 'whatever-secret' } });
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/scope admin/);
  });

  it('sets up Access for the admin console with Exprsn-AI\'s OIDC provider; /v1 never meets it', async () => {
    const callback = `https://${TEAM}/cdn-cgi/access/callback`;
    const { client, secret } = await w.h.s.federation.oidc.createClient(w.h.tenantId, { name: 'Cloudflare Access', type: 'first_party', redirectUris: [callback], grants: ['authorization_code'], scopes: ['openid', 'email', 'profile'], pkceRequired: true, accessTtl: 600, refreshTtl: 3600, models: null, serviceUserId: null }, null);
    const c = w.admin.client;
    const wrong = await c.agent.put(`/api/admin/cloud/edge/${edgeId}/access`).set('x-csrf-token', c.csrf).send({ scope: 'admin', teamDomain: TEAM, idp: { kind: 'exprsn', clientId: client.client_id, clientSecret: 'not-the-secret' } });
    expect(wrong.status).toBe(409);
    const r = await c.agent.put(`/api/admin/cloud/edge/${edgeId}/access`).set('x-csrf-token', c.csrf).send({ scope: 'admin', teamDomain: TEAM, idp: { kind: 'exprsn', clientId: client.client_id, clientSecret: secret } });
    expect(r.status).toBe(200);
    expect(r.body.aud).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(r.body)).not.toContain(secret!);
    const idp = [...w.cf.edge.accessIdps.values()][0]!;
    const issuer = (await w.h.s.federation.tenantBySlug(w.h.s.cfg.DEFAULT_TENANT))!.issuer;
    expect(idp).toMatchObject({ type: 'oidc', config: { client_id: client.client_id, auth_url: `${issuer}/oauth/authorize`, token_url: `${issuer}/oauth/token`, certs_url: `${issuer}/.well-known/jwks.json`, pkce_enabled: true } });
    const apps = [...w.cf.edge.accessApps.values()] as unknown as { name: string; destinations: { uri: string }[]; policies: { decision: string }[]; allowed_idps: string[] }[];
    expect(apps.map((a) => a.name)).toEqual(['exprsn-console-console']);
    expect(apps[0]!.destinations.map((d) => d.uri)).toEqual([`${host}/api/admin`, `${host}/admin`]);
    expect(apps[0]!.allowed_idps).toEqual([idp.id]);
    // Which application answers each path, as Access picks: the excluded paths and everything outside the admin console meet none.
    for (const x of ACCESS_EXCLUSIONS) expect(accessAppFor(apps, host, `${x.path}/x`), x.path).toBeNull();
    expect(accessAppFor(apps, host, '/v1/chat/completions')).toBeNull();
    expect(accessAppFor(apps, host, '/api/admin/users')).toMatchObject({ decision: 'allow' });
    expect(accessAppFor(apps, host, '/api/administer')).toBeNull();
  });

  it('host-wide with the account\'s identity provider: every excluded path bypasses Access', async () => {
    const idpId = 'idp-corp';
    w.cf.edge.accessIdps.set(idpId, { id: idpId, name: 'corp-okta', type: 'okta', config: {} });
    const out = await w.h.s.cloud.edge.configureAccess(w.admin, edgeId, accessSchema.parse({ scope: 'host', teamDomain: TEAM, idp: { kind: 'cloudflare', identityProviderId: idpId }, allowedDomains: ['example.test'] }));
    expect(out.access).toMatchObject({ scope: 'host', identityProviderId: idpId });
    const apps = [...w.cf.edge.accessApps.values()] as unknown as { name: string; destinations: { uri: string }[]; policies: { decision: string; include: unknown[] }[] }[];
    expect(apps.map((a) => a.name).sort()).toEqual(['exprsn-console-console', 'exprsn-console-public']);
    const required = ['/v1', '/oauth', '/saml', '/.well-known', '/.well-known/acme-challenge', '/hooks', '/billing/stripe/webhook', '/api/public', '/shared'];
    for (const p of required) expect(accessAppFor(apps, host, `${p}/anything`), p).toMatchObject({ decision: 'bypass' });
    expect(accessAppFor(apps, host, '/t/acme/oauth/token')).toMatchObject({ decision: 'bypass' });
    expect(accessAppFor(apps, host, '/')).toMatchObject({ name: 'exprsn-console-console', decision: 'allow' });
    expect(accessAppFor(apps, host, '/api/me')).toMatchObject({ decision: 'allow' });
    expect(apps.find((a) => a.name === 'exprsn-console-console')!.policies[0]!.include).toEqual([{ email_domain: { domain: 'example.test' } }]);
    // One identity provider of Exprsn-AI's own, kept from the admin setup.
    const ids = [...w.cf.edge.accessIdps.values()].filter((x) => x.type === 'oidc');
    expect(ids).toHaveLength(1);
  });

  describe('the server\'s own Access check', () => {
    let aud = '';
    const jwt = (o: Partial<Parameters<typeof w.cf.edge.signAccessJwt>[0]> = {}) => w.cf.edge.signAccessJwt({ aud, teamDomain: TEAM, ...o });
    const cfgOf = () => w.h.s.cfg as unknown as Record<string, string>;

    beforeAll(async () => {
      aud = (await w.h.s.cloud.edge.get(edgeId)).accessAud!;
      cfgOf().CLOUDFLARE_ACCESS_AUD = aud;
      cfgOf().CLOUDFLARE_ACCESS_SCOPE = 'admin';
      accessVerifierFor(w.h.s).certsUrl = `${w.cf.url}/cdn-cgi/access/certs`;
    });
    afterAll(() => {
      cfgOf().CLOUDFLARE_ACCESS_AUD = '';
    });

    it('asks a protected path for a valid Access token as well as the session', async () => {
      const c = w.admin.client;
      const none = await c.agent.get('/api/admin/users');
      expect(none.status).toBe(403);
      expect(none.body.reason).toBe('access_required');
      expect((await c.agent.get('/api/admin/users').set('cf-access-jwt-assertion', jwt())).status).toBe(200);
      for (const bad of [jwt({ aud: 'f'.repeat(64) }), jwt({ teamDomain: 'other.cloudflareaccess.com' }), jwt({ expS: -600 }), jwt({ key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, kid: 'unknown' }), 'not.a.jwt']) {
        const r = await c.agent.get('/api/admin/users').set('cf-access-jwt-assertion', bad);
        expect(r.status).toBe(403);
        expect(r.body.reason).toBe('access_required');
      }
    });

    it('never signs anyone in: a valid Access token without a session is still 401', async () => {
      const r = await request(w.h.app).get('/api/admin/users').set('cf-access-jwt-assertion', jwt());
      expect(r.status).toBe(401);
    });

    it('never asks /v1, sign-in, discovery or public paths for it', async () => {
      expect((await request(w.h.app).get('/v1/models')).status).toBe(401);
      expect((await request(w.h.app).get('/.well-known/openid-configuration')).status).toBe(200);
      const member = await localUser(w.h, 'plainmember', ['member']);
      expect(member).toBeTruthy();
      const m = await login(w.h, 'plainmember');
      expect(m.res.status).toBe(200);
      expect((await m.agent.get('/api/me')).status).toBe(200);
    });

    it('host-wide, everything but the exclusions needs it', async () => {
      cfgOf().CLOUDFLARE_ACCESS_SCOPE = 'host';
      try {
        expect(accessProtects('host', '/api/me')).toBe(true);
        expect(accessProtects('host', '/v1/models')).toBe(false);
        expect(accessProtects('host', '/.well-known/acme-challenge/abc')).toBe(false);
        expect(accessProtects('host', '/v10')).toBe(true);
        const m = await login(w.h, 'plainmember');
        expect(m.res.status).toBe(403);
        expect((await request(w.h.app).get('/v1/models')).status).toBe(401);
        expect((await request(w.h.app).get('/.well-known/openid-configuration')).status).toBe(200);
        expect((await request(w.h.app).post('/api/public/shared-links/open').send({ token: 'exs_' + 'a'.repeat(30) })).body.reason).not.toBe('access_required');
        const ok = await request(w.h.app).post('/api/auth/login').set('cf-access-jwt-assertion', jwt()).send({ username: 'plainmember', password: PASSWORD });
        expect(ok.status).toBe(200);
      } finally {
        cfgOf().CLOUDFLARE_ACCESS_SCOPE = 'admin';
      }
    });
  });
});
