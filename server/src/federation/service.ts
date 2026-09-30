import type { Services } from '../services.js';
import type { Scheduler } from '../platform/jobs.js';
import { json } from '../db/knex.js';
import { permissionsFor, rolesRequireMfa, type Permission } from '../authz/permissions.js';
import { isLabel } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { TOPICS } from '../platform/bus.js';
import { decodeJwt } from './jose.js';
import { SigningKeys } from './keys.js';
import { DENIED_TOPIC, OidcProvider, type DpopInput, type TenantCtx } from './oidc.js';
import { SamlIdp } from './saml.js';
import { Upstream } from './upstream.js';

type Tenants = () => Promise<{ tenantId: string; payload: Record<string, unknown> }[]>;

export interface FederationSettings {
  consent: {
    /** First-party (and service) clients skip the consent page. */
    firstPartyPreconsented: boolean;
    /** Third-party and public clients ask on first use. */
    thirdPartyAsk: boolean;
    /** Remember a consent for 90 days (off: ask at every authorization). */
    remember: boolean;
  };
  kerberos: {
    /** Kerberos SPNEGO sign-in for this tenant (the server also needs KERBEROS_SERVICE and the kerberos module). */
    enabled: boolean;
    /** Accepted realms, upper case; empty accepts any realm the keytab's KDC vouches for. */
    realms: string[];
  };
}

export const DEFAULT_SETTINGS: FederationSettings = {
  consent: { firstPartyPreconsented: true, thirdPartyAsk: true, remember: true },
  kerberos: { enabled: true, realms: [] }
};

export const CONSENT_REMEMBER_DAYS = 90;

/**
 * Sprint 9: OIDC provider, SAML IdP, upstream federation, Kerberos SPNEGO and device flow. Reads its collaborators
 * through `s` so later replacements (tests, overrides) are used.
 *
 * Issuers: the default tenant's issuer is FEDERATION_ISSUER (or PUBLIC_URL); every other tenant's is
 * `<that>/t/<tenant slug>`. Each tenant has its own signing keys, clients, SAML service providers and upstream
 * providers, and tokens carry `tenant` and `tid` claims; a session in one tenant never authorizes a client of another.
 */
export class FederationService {
  readonly keys: SigningKeys;
  readonly oidc: OidcProvider;
  readonly saml: SamlIdp;
  readonly upstream: Upstream;

  constructor(private readonly s: () => Services) {
    this.keys = new SigningKeys(s);
    this.oidc = new OidcProvider(s, this.keys);
    this.saml = new SamlIdp(s, this.keys);
    this.upstream = new Upstream(s);
  }

  private base(): string {
    return (this.s().cfg.FEDERATION_ISSUER ?? this.s().cfg.PUBLIC_URL).replace(/\/+$/, '');
  }

  issuerFor(slug: string): string {
    return slug === this.s().cfg.DEFAULT_TENANT ? this.base() : `${this.base()}/t/${slug}`;
  }

  /** The protocol view of an active tenant, by slug. */
  async tenantBySlug(slug: string): Promise<TenantCtx | null> {
    const t = await this.s().tenants.bySlug(slug);
    if (!t || t.state !== 'active') return null;
    return { id: t.id, slug: t.slug, name: t.name, issuer: this.issuerFor(t.slug) };
  }

  async tenantById(id: string): Promise<TenantCtx | null> {
    const t = await this.s().tenants.byId(id);
    if (!t) return null;
    return { id: t.id, slug: t.slug, name: t.name, issuer: this.issuerFor(t.slug) };
  }

  async settings(tenantId: string): Promise<FederationSettings> {
    const r = (await this.s().db('federation_settings').where({ tenant_id: tenantId }).first()) as { settings: string } | undefined;
    const stored = json<Partial<FederationSettings>>(r?.settings, {});
    return { consent: { ...DEFAULT_SETTINGS.consent, ...stored.consent }, kerberos: { ...DEFAULT_SETTINGS.kerberos, ...stored.kerberos } };
  }

  async updateSettings(tenantId: string, patch: { consent?: Partial<FederationSettings['consent']>; kerberos?: Partial<FederationSettings['kerberos']> }): Promise<FederationSettings> {
    const cur = await this.settings(tenantId);
    const next: FederationSettings = { consent: { ...cur.consent, ...patch.consent }, kerberos: { ...cur.kerberos, ...patch.kerberos } };
    const row = { tenant_id: tenantId, settings: JSON.stringify(next), updated_at: Date.now() };
    const n = await this.s().db('federation_settings').where({ tenant_id: tenantId }).update(row);
    if (!n) await this.s().db('federation_settings').insert(row);
    return next;
  }

  /**
   * Builds a principal from an access token issued here (for the API's bearer authentication). Scopes narrow the
   * user's roles; admin roles still need a token whose sign-in had a second factor.
   */
  async principalFromAccessToken(token: string, binding?: { scheme: 'bearer' | 'dpop'; dpop: DpopInput }): Promise<Principal | null> {
    let tid: string;
    try {
      tid = String(decodeJwt(token).claims.tid ?? '');
    } catch {
      return null;
    }
    const t = tid ? await this.tenantById(tid) : null;
    if (!t) return null;
    const claims = await this.oidc.verifyAccessToken(t, token).catch(() => null);
    if (!claims) return null;
    // DPoP-bound tokens need a proof from their key for this request; bearer tokens must not claim DPoP.
    if (binding && !(await this.oidc.checkBinding(claims, token, binding.scheme, binding.dpop).then(() => true, () => false))) return null;
    // Only tokens minted for this API: a token exchanged or requested for another audience is refused here.
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(`${t.issuer}/api`)) return null;
    const s = this.s();
    if ((await s.tenants.byId(t.id))?.state !== 'active') return null;
    const user = await s.users.get(t.id, String(claims.sub));
    if (!user || user.state !== 'active') return null;
    const roles = await s.users.roleIds(user.id);
    const mfa = Array.isArray(claims.amr) && (claims.amr.includes('mfa') || claims.amr.includes('otp') || claims.amr.includes('hwk'));
    // Admin roles need a second factor: a token from a sign-in without one is not accepted for such a user.
    if (!mfa && rolesRequireMfa(roles)) return null;
    const perms = permissionsFor(roles);
    const scopes = String(claims.scope ?? '').split(' ').map((x) => (x.startsWith('inference:invoke:') ? 'inference:invoke' : x)).filter((x): x is Permission => perms.has(x as Permission));
    return {
      kind: 'api_key',
      userId: user.id,
      tenantId: t.id,
      tenantSlug: t.slug,
      username: user.username,
      displayName: user.display_name,
      roles,
      clearance: isLabel(user.clearance) ? user.clearance : 'public',
      scopes,
      sessionId: null,
      apiKeyId: null,
      mfa
    };
  }

  /** Registers this area's job handlers on `s.jobs`, and the upstream checks on the identity chain. */
  registerJobs(): void {
    const s = this.s();
    s.chain.useFederatedTester((row, steps) => this.upstream.test(row, steps));
    s.jobs.register('federation.keys', async (p, ctx) => this.keys.scheduled(String(p.tenantId ?? ctx.job.tenant_id)));
    s.jobs.register('federation.purge', async () => ({ deleted: await this.oidc.purge() }));
    // Sprint 14: back-channel logout. A logout token per client, posted through the internal-host checks; a client
    // that does not answer 200 is retried by the queue.
    s.jobs.register('federation.backchannel', async (p, ctx) => {
      const t = await this.tenantById(ctx.job.tenant_id);
      const client = t ? await this.oidc.byClientId(t.id, String(p.clientId)) : undefined;
      if (!t || !client?.backchannel_logout_uri || client.status !== 'active') return { skipped: true };
      const token = await this.oidc.logoutToken(t, client.client_id, String(p.userId), String(p.sid));
      const status = await this.upstream.postForm(client.backchannel_logout_uri, { logout_token: token });
      await s.audit.append({ tenantId: t.id, action: 'oidc.logout.backchannel', kind: 'system', actor: { service: 'federation' }, target: { client: client.client_id, name: client.name }, detail: { status, user: String(p.userId) } });
      return { delivered: true, status };
    });
    // Any instance that revokes a session tells every instance; the claim in sessionsEnded delivers each logout once.
    s.bus.on<string[]>(TOPICS.sessionsRevoked, async (ids) => {
      if (!Array.isArray(ids) || !ids.length) return;
      await this.oidc.sessionsEnded(ids);
      await this.saml.sessionsEnded(ids);
    });
    // A token or grant was denied on some instance: drop this instance's cached access-token checks.
    s.bus.on(DENIED_TOPIC, () => this.oidc.forgetChecks());
  }

  /** Adds this area's recurring schedules: key rotation checks and the purge of expired codes and pending state. */
  schedule(scheduler: Scheduler, activeTenants: Tenants): void {
    scheduler.every('federation.keys', 60 * 60_000, activeTenants);
    scheduler.every('federation.purge', 60 * 60_000, async () => {
      const list = await activeTenants();
      return list.slice(0, 1);
    });
  }
}
