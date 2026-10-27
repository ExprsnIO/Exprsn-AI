/*
 * 1.9.99-final, Sprint 61 (B-10901 to B-10904): the front door part of `fake-cloudflare.ts`. Working: zone settings
 * (`ssl`, `min_tls_version`, `always_use_https`, read and patched), certificate packs (a Universal certificate per
 * zone, active unless the zone is in `pendingCertificates`), ruleset phase entrypoints (read, replaced; rate limiting
 * rules checked against the zone's plan as Cloudflare does), a tunnel's token and its remotely managed configuration
 * (the catch-all rule required last), Access applications (with an `aud` tag) and identity providers, `GET /ips`, and
 * the team's Access signing keys at `/cdn-cgi/access/certs` (`signAccessJwt` signs tokens with them). It is never the
 * real Cloudflare.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { RATE_LIMIT_PLANS, type CfPlan } from '../src/cloud/edge-waf.js';
import { json, type RecordedRequest, type Reply } from './fake-cloud-base.js';

const ok = (result: unknown, info?: Record<string, unknown>): Reply => ({ status: 200, body: { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) } });
const err = (status: number, code: number, message: string): Reply => ({ status, body: { success: false, errors: [{ code, message }], messages: [], result: null } });
const listOf = (items: unknown[]): Reply => ok(items, { page: 1, per_page: items.length || 100, count: items.length, total_count: items.length, total_pages: 1 });

/** The permission groups of the front door's paths, checked by `fake-cloudflare.ts` before routing here. */
export const EDGE_PERMISSIONS: [RegExp, string, string][] = [
  // This build's catalogue (`CF_FEATURE_PERMISSIONS.frontdoor`) names SSL and Certificates for the SSL settings too.
  [/^\/zones\/[^/]+\/(settings|ssl)\//, 'SSL and Certificates Read', 'SSL and Certificates Write'],
  [/^\/zones\/[^/]+\/rulesets/, 'Zone WAF Read', 'Zone WAF Write'],
  [/^\/accounts\/[^/]+\/access\/identity_providers/, 'Access: Organizations, Identity Providers, and Groups Read', 'Access: Organizations, Identity Providers, and Groups Write'],
  [/^\/accounts\/[^/]+\/access\//, 'Access: Apps and Policies Read', 'Access: Apps and Policies Write']
];

export const TEST_IP_RANGES = { ipv4_cidrs: ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'], ipv6_cidrs: ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'] };

export class FakeCloudflareEdge {
  /** Zone settings by zone id. */
  readonly settings = new Map<string, Record<string, string>>();
  /** Zones whose Universal certificate is still pending. */
  readonly pendingCertificates = new Set<string>();
  /** Each zone's plan (default free), for the rate limiting rule checks. */
  readonly plans = new Map<string, CfPlan>();
  /** Ruleset entrypoints by `<zone>|<phase>`. */
  readonly rulesets = new Map<string, { id: string; phase: string; kind: 'zone'; rules: Record<string, unknown>[]; version: number }>();
  readonly tunnelTokens = new Map<string, string>();
  readonly tunnelConfigs = new Map<string, { config: { ingress: Record<string, unknown>[] }; version: number }>();
  readonly accessApps = new Map<string, Record<string, unknown> & { id: string; name: string; aud: string }>();
  readonly accessIdps = new Map<string, Record<string, unknown> & { id: string; name: string }>();
  ranges = TEST_IP_RANGES;
  /** The team's Access signing key. */
  readonly accessKey: { privateKey: KeyObject; kid: string; jwk: Record<string, unknown> };

  constructor(
    private readonly zones: () => Map<string, { id: string; name: string }>,
    private readonly tunnels: () => Map<string, { id: string; deleted_at: string | null }>
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const kid = createHash('sha256').update(String(jwk.n)).digest('hex').slice(0, 32);
    this.accessKey = { privateKey, kid, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
  }

  /** Signs an Access token as the team does (RS256, the team's issuer, the application's audience). */
  signAccessJwt(claims: { aud: string | string[]; teamDomain: string; email?: string; sub?: string; expS?: number; key?: KeyObject; kid?: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: claims.kid ?? this.accessKey.kid, typ: 'JWT' };
    const body = { aud: Array.isArray(claims.aud) ? claims.aud : [claims.aud], iss: `https://${claims.teamDomain}`, email: claims.email ?? 'admin@example.test', sub: claims.sub ?? randomUUID(), type: 'app', iat: now, nbf: now, exp: now + (claims.expS ?? 600), identity_nonce: randomBytes(8).toString('hex') };
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), claims.key ?? this.accessKey.privateKey).toString('base64url')}`;
  }

  /** The public certificate endpoint (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), outside `/client/v4`. */
  publicMatches(path: string): boolean {
    return path === '/cdn-cgi/access/certs';
  }

  publicRoute(): Reply {
    return { status: 200, body: { keys: [this.accessKey.jwk], public_cert: { kid: this.accessKey.kid, cert: '' }, public_certs: [] } };
  }

  matches(path: string): boolean {
    return /^\/zones\/[^/]+\/(settings|ssl|rulesets)\//.test(path) || /^\/accounts\/[^/]+\/cfd_tunnel\/[^/]+\/(token|configurations)$/.test(path) || /^\/accounts\/[^/]+\/access\//.test(path) || path === '/ips';
  }

  private zoneSettings(zoneId: string): Record<string, string> {
    let s = this.settings.get(zoneId);
    if (!s) this.settings.set(zoneId, (s = { ssl: 'full', min_tls_version: '1.0', always_use_https: 'off' }));
    return s;
  }

  route(r: RecordedRequest, path: string): Reply {
    const b = json(r);
    const now = new Date().toISOString();
    let m: RegExpExecArray | null;
    if (path === '/ips') return ok({ ...this.ranges, etag: createHash('md5').update(JSON.stringify(this.ranges)).digest('hex') });

    if ((m = /^\/zones\/([^/]+)\/(settings|ssl|rulesets)\/(.+)$/.exec(path))) {
      const zone = this.zones().get(m[1]!);
      if (!zone) return err(404, 7003, 'Could not route to /zones/..., perhaps your object identifier is invalid?');
      const rest = m[3]!;
      if (m[2] === 'settings') {
        const s = this.zoneSettings(zone.id);
        if (!(rest in s)) return err(404, 1002, 'Invalid setting');
        if (r.method === 'PATCH') {
          const v = String(b.value ?? '');
          const allowed: Record<string, string[]> = { ssl: ['off', 'flexible', 'full', 'strict'], min_tls_version: ['1.0', '1.1', '1.2', '1.3'], always_use_https: ['on', 'off'] };
          if (!allowed[rest]!.includes(v)) return err(400, 1007, `Invalid value for zone setting ${rest}`);
          s[rest] = v;
        }
        return ok({ id: rest, value: s[rest], editable: true, modified_on: now });
      }
      if (m[2] === 'ssl' && rest === 'certificate_packs' && r.method === 'GET') {
        return listOf([{ id: createHash('sha256').update(zone.id).digest('hex').slice(0, 36), type: 'universal', hosts: [zone.name, `*.${zone.name}`], status: this.pendingCertificates.has(zone.id) ? 'initializing' : 'active', certificate_authority: 'google', validity_days: 90 }]);
      }
      if (m[2] === 'rulesets' && (m = /^phases\/([a-z_]+)\/entrypoint$/.exec(rest))) {
        const phase = m[1]!;
        const key = `${zone.id}|${phase}`;
        if (r.method === 'GET') {
          const rs = this.rulesets.get(key);
          return rs ? ok(rs) : err(404, 10003, 'could not find entrypoint ruleset in the phase');
        }
        if (r.method === 'PUT') {
          const rules = (b.rules as Record<string, unknown>[] | undefined) ?? [];
          for (const rule of rules) if (!rule.action || typeof rule.expression !== 'string') return err(400, 20021, 'Each rule needs an action and an expression.');
          if (phase === 'http_ratelimit') {
            const plan = RATE_LIMIT_PLANS[this.plans.get(zone.id) ?? 'free'];
            if (rules.length > plan.rules) return err(400, 20120, `The zone's plan allows ${plan.rules} rate limiting rule(s).`);
            for (const rule of rules) {
              const rl = rule.ratelimit as { characteristics?: string[]; period?: number; mitigation_timeout?: number; requests_per_period?: number } | undefined;
              if (!rl || !rl.characteristics?.includes('cf.colo.id')) return err(400, 20120, 'A rate limiting rule counts by cf.colo.id.');
              if (!plan.periods.includes(Number(rl.period))) return err(400, 20120, `The period ${String(rl.period)} is not available on this plan.`);
              if (!plan.timeouts.includes(Number(rl.mitigation_timeout))) return err(400, 20120, `The mitigation timeout ${String(rl.mitigation_timeout)} is not available on this plan.`);
              if (!(Number(rl.requests_per_period) >= 1)) return err(400, 20120, 'requests_per_period must be at least 1.');
            }
          }
          const prev = this.rulesets.get(key);
          const rs = { id: prev?.id ?? randomBytes(16).toString('hex'), phase, kind: 'zone' as const, rules: rules.map((x) => ({ id: randomBytes(16).toString('hex'), ...x })), version: (prev?.version ?? 0) + 1 };
          this.rulesets.set(key, rs);
          return ok(rs);
        }
      }
      return err(404, 7000, 'No route for that URI');
    }

    if ((m = /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/(token|configurations)$/.exec(path))) {
      const t = this.tunnels().get(m[1]!);
      if (!t || t.deleted_at) return err(404, 1003, 'Tunnel not found');
      if (m[2] === 'token' && r.method === 'GET') {
        let token = this.tunnelTokens.get(t.id);
        if (!token) this.tunnelTokens.set(t.id, (token = Buffer.from(JSON.stringify({ a: 'acc', t: t.id, s: randomBytes(32).toString('base64') })).toString('base64')));
        return ok(token);
      }
      if (m[2] === 'configurations') {
        if (r.method === 'GET') return ok({ tunnel_id: t.id, config: this.tunnelConfigs.get(t.id)?.config ?? { ingress: [] }, version: this.tunnelConfigs.get(t.id)?.version ?? 0 });
        if (r.method === 'PUT') {
          const ingress = ((b.config as { ingress?: Record<string, unknown>[] } | undefined)?.ingress ?? []) as Record<string, unknown>[];
          if (!ingress.length || ingress.at(-1)!.hostname !== undefined) return err(400, 1055, 'The last ingress rule must match every request (no hostname).');
          const cfg = { config: { ingress }, version: (this.tunnelConfigs.get(t.id)?.version ?? 0) + 1 };
          this.tunnelConfigs.set(t.id, cfg);
          return ok({ tunnel_id: t.id, ...cfg });
        }
      }
    }

    if ((m = /^\/accounts\/[^/]+\/access\/(apps|identity_providers)(?:\/([^/]+))?$/.exec(path))) {
      const store = (m[1] === 'apps' ? this.accessApps : this.accessIdps) as Map<string, Record<string, unknown> & { id: string; name: string }>;
      const id = m[2];
      if (!id) {
        if (r.method === 'GET') return listOf([...store.values()]);
        if (r.method === 'POST') {
          if (!b.name) return err(400, 12130, 'name is required');
          if ([...store.values()].some((x) => x.name === b.name)) return err(409, 12130, 'An item with that name exists.');
          if (m[1] === 'apps' && (!b.domain || b.type !== 'self_hosted')) return err(400, 12130, 'A self-hosted application needs a domain.');
          if (m[1] === 'identity_providers' && (b.type !== 'oidc' || !(b.config as Record<string, unknown> | undefined)?.client_secret)) return err(400, 12130, 'An OIDC identity provider needs its client secret.');
          const item = { ...b, id: randomUUID(), name: String(b.name), created_at: now, ...(m[1] === 'apps' ? { aud: randomBytes(32).toString('hex') } : {}) };
          // The identity provider's secret is never answered back.
          store.set(item.id, item as never);
          return ok(m[1] === 'identity_providers' ? { ...item, config: { ...((b.config as object | undefined) ?? {}), client_secret: '********' } } : item);
        }
      } else {
        const item = store.get(id);
        if (!item) return err(404, 12130, 'Not found');
        if (r.method === 'GET') return ok(m[1] === 'identity_providers' ? { ...item, config: { ...((item.config as object) ?? {}), client_secret: '********' } } : item);
        if (r.method === 'PUT') {
          const next = { ...b, id, name: String(b.name ?? item.name), ...(m[1] === 'apps' ? { aud: item.aud } : {}), updated_at: now };
          store.set(id, next as never);
          return ok(next);
        }
        if (r.method === 'DELETE') {
          store.delete(id);
          return ok({ id });
        }
      }
    }
    return err(404, 7000, 'No route for that URI');
  }
}
