import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/identity/totp.js';
import { checkPasswordPolicy } from '../src/identity/passwords.js';
import { checkGitUrl } from '../src/knowledge/sources.js';
import { isNeverAddress } from '../src/mcp/hosts.js';
import { redactRequest, redactUrl } from '../src/observability/index.js';
import { UpstreamError } from '../src/federation/upstream.js';
import { publicReason, SIGN_IN_POINTS } from '../src/routes/federation-public.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

/** Sprint 10: fixes from the OWASP ASVS 4.0.3 level 2 review (docs/asvs.md). */
describe('ASVS L2 review', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
    await localUser(h, 'asvsmember', ['member']);
  });
  afterAll(async () => h.close());

  describe('V8.2.1 caching of sensitive responses', () => {
    it('sends Cache-Control: no-store on every API answer, including routers that did not set it', async () => {
      const m = await login(h, 'asvsmember');
      for (const path of ['/api/agents', '/api/knowledge/bases', '/api/images', '/api/training/datasets', '/api/nope']) {
        const res = await m.agent.get(path);
        expect(res.headers['cache-control'], path).toBe('no-store');
      }
      expect((await request(h.app).get('/api/me')).headers['cache-control']).toBe('no-store');
    });
  });

  describe('V7.4.1 and V14.3.2 error handling', () => {
    it('keeps dependency errors out of the public readiness answer', async () => {
      const original = h.s.blobs.health.bind(h.s.blobs);
      h.s.blobs.health = async () => ({ ok: false, detail: 'EACCES: permission denied, open /srv/secret-blobs/.probe' });
      try {
        const res = await request(h.app).get('/readyz').expect(503);
        expect(res.body.checks.blobs).toBe('unavailable');
        expect(JSON.stringify(res.body)).not.toContain('/srv/secret-blobs');
      } finally {
        h.s.blobs.health = original;
      }
    });

    it('names our own upstream checks on public error pages but not network or driver errors', () => {
      expect(publicReason(new UpstreamError('The ID token nonce does not match this sign-in.'), 'generic')).toMatch(/nonce/);
      expect(publicReason(new Error('connect ECONNREFUSED 10.9.8.7:443'), 'generic')).toBe('generic');
    });

    it('does not show an unexpected upstream start failure to the browser', async () => {
      const up = h.s.federation.upstream;
      const original = up.startOidc.bind(up);
      up.startOidc = async () => {
        throw new Error('connect ECONNREFUSED 10.9.8.7:443');
      };
      try {
        const res = await request(h.app).get('/federation/oidc/start?provider=01J0000000000000000000000X').set('x-forwarded-for', '198.51.100.20');
        expect(res.status).toBe(502);
        expect(res.text).not.toContain('10.9.8.7');
        expect(res.text).toContain('could not be reached');
      } finally {
        up.startOidc = original;
      }
    });

    it('answers userinfo failures that are not token errors without internal detail', async () => {
      const oidc = h.s.federation.oidc;
      const original = oidc.userinfo.bind(oidc);
      oidc.userinfo = async () => {
        throw new Error('SQLITE_BUSY: database is locked at /var/lib/exprsn/app.sqlite');
      };
      try {
        const res = await request(h.app).get('/oauth/userinfo').set('authorization', 'Bearer eyJhbGciOiJFUzI1NiJ9.e30.x');
        expect(res.status).toBe(401);
        expect(res.body.error_description).toBe('The access token could not be verified.');
        expect(String(res.headers['www-authenticate'])).not.toContain('sqlite');
      } finally {
        oidc.userinfo = original;
      }
      // A token error itself is still explained.
      const bad = await request(h.app).get('/oauth/userinfo').set('authorization', 'Bearer not-a-jwt');
      expect(bad.status).toBe(401);
      expect(bad.body.error_description).toMatch(/JWT/);
    });
  });

  describe('V2.2.1 and V11.1.4 anti-automation on public sign-in endpoints', () => {
    it('throttles the browser sign-in and callback endpoints per client address', async () => {
      // Without a ticket each request is a cheap Negotiate challenge (or refusal) until the limiter steps in.
      const hit = () => request(h.app).get('/auth/negotiate').set('x-forwarded-for', '198.51.100.99');
      for (let i = 0; i < SIGN_IN_POINTS; i++) expect((await hit()).status).not.toBe(429);
      const res = await hit();
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.headers['cache-control']).toBe('no-store');
      // Discovery and keys are not sign-in endpoints and stay available.
      expect((await request(h.app).get('/.well-known/openid-configuration').set('x-forwarded-for', '198.51.100.99')).status).toBe(200);
    });

    it('keeps the strict sign-in limit for credential attempts, not for the session check each page load makes', async () => {
      const agent = (await login(h, 'asvsmember')).agent;
      for (let i = 0; i < 40; i++) expect((await agent.get('/api/auth/session')).status).toBe(200);
      const tries = [];
      for (let i = 0; i < 31; i++) tries.push((await request(h.app).post('/api/auth/login').set('x-forwarded-for', '198.51.100.77').send({ username: 'nobody-here', password: 'x' })).status);
      expect(tries).toContain(429);
    });
  });

  describe('V7.1.1 credentials and one-time codes stay out of the logs', () => {
    it('redacts credential-bearing query parameters in logged URLs', () => {
      expect(redactUrl('/federation/oidc/callback?code=abc123&state=xyz&iss=https%3A%2F%2Fidp')).toBe('/federation/oidc/callback?code=[redacted]&state=[redacted]&iss=https%3A%2F%2Fidp');
      expect(redactUrl('/saml/sso?SAMLRequest=fZJNb&RelayState=r1&SigAlg=rsa')).toBe('/saml/sso?SAMLRequest=[redacted]&RelayState=[redacted]&SigAlg=rsa');
      expect(redactUrl('/api/auth/device?user_code=ABCD-EFGH')).toBe('/api/auth/device?user_code=[redacted]');
      expect(redactUrl('/api/agents')).toBe('/api/agents');
      const r = redactRequest({ url: '/oauth/authorize?client_id=c1&code_verifier=v', query: { client_id: 'c1', code_verifier: 'v' } });
      expect(r.url).toBe('/oauth/authorize?client_id=c1&code_verifier=[redacted]');
      expect(r.query).toEqual({ client_id: 'c1', code_verifier: '[redacted]' });
    });
  });

  describe('V2.1.7 password policy for local accounts', () => {
    it('refuses common and service-named passwords, and keeps accepting long unusual ones', () => {
      expect(checkPasswordPolicy('Password1234', 'alice').ok).toBe(false);
      expect(checkPasswordPolicy('qwertyuiop123', 'alice').ok).toBe(false);
      expect(checkPasswordPolicy('correct horse battery staple', 'alice').ok).toBe(false);
      expect(checkPasswordPolicy('my-exprsn-ai-login', 'alice').reason).toMatch(/name of this service/);
      expect(checkPasswordPolicy('violet tram under the pier', 'alice').ok).toBe(true);
    });

    it('applies the policy when an admin creates a local account', async () => {
      await localUser(h, 'asvsadmin', ['tenant-admin', 'identity-admin', 'member']);
      const a = await loginAdmin(h, 'asvsadmin');
      const res = await a.agent.post('/api/admin/users').set('x-csrf-token', a.csrf).send({ username: 'breakglass2', displayName: 'Break glass', password: 'password1234', roles: ['member'], clearance: 'internal' });
      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/most common/);
    });
  });

  describe('V2.8 and V3.7 second factors', () => {
    it('does not let an admin remove their only factor even when mfa_required was never set on the account', async () => {
      const u = await localUser(h, 'asvsops', ['auditor', 'member']);
      expect((await h.s.users.get(h.tenantId, u.id))?.mfa_required).toBeFalsy();
      const a = await loginAdmin(h, 'asvsops');
      const factors = (await a.agent.get('/api/me/mfa')).body.factors as { id: string }[];
      expect(factors).toHaveLength(1);
      const res = await a.agent.delete(`/api/me/mfa/${factors[0]!.id}`).set('x-csrf-token', a.csrf);
      expect(res.status).toBe(403);
      expect(totp.check(totp.generate(a.totpSecret), a.totpSecret)).toBe(true);
    });
  });

  describe('V3.2.1 session tokens on sign-in', () => {
    it('ends the session a browser held when it signs in again', async () => {
      const first = await login(h, 'asvsmember');
      const again = await first.agent.post('/api/auth/login').set('x-csrf-token', first.csrf).send({ username: 'asvsmember', password: 'correct horse battery staple' });
      expect(again.status).toBe(200);
      // The old cookie no longer authenticates; the new one does.
      await request(h.app).get('/api/me').set('cookie', first.cookie).expect(401);
      await first.agent.get('/api/me').expect(200);
    });
  });

  describe('V12.6.1 and V5.2.6 server-side requests', () => {
    it('refuses git sources on link-local, unspecified and multicast addresses', () => {
      expect(isNeverAddress('169.254.169.254')).toBe(true);
      expect(isNeverAddress('::ffff:169.254.169.254')).toBe(true);
      expect(isNeverAddress('fe80::1')).toBe(true);
      expect(isNeverAddress('10.0.0.5')).toBe(false);
      expect(checkGitUrl('https://169.254.169.254/latest/meta-data.git', false)).toMatch(/Link-local/);
      expect(checkGitUrl('https://[fe80::1]/r.git', false)).toMatch(/Link-local/);
      expect(checkGitUrl('https://git.example.com/org/repo.git', false)).toBeNull();
    });
  });
});
