import { z } from 'zod';
import { json } from '../db/knex.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { isConfidential, OAuthError, type ClientRow } from './oidc.js';

/*
 * 1.9.0, Sprint 55 (B-191): OAuth and OIDC provider settings per tenant and per client.
 *
 * The tenant's defaults (`oidc_client_settings` with an empty `client_id`) and a client's own settings (its row there)
 * decide: the authorization code lifetime, whether every client must use PKCE or only public ones (a public client
 * always must), the consent screen (the tenant's consent settings, or on or off for one client), a rate limit at the
 * token, PAR and device endpoints, and refresh-token rotation (rotated on every use with reuse detection, which
 * revokes the family; or, for a confidential client only, kept until it expires). A client's access and refresh
 * lifetimes stay on its own row (`oidc_clients.access_ttl`, `refresh_ttl`); the tenant's lifetimes are what new
 * clients get. Without migration 130 every value is today's: 60-second codes, PKCE for public clients and those
 * that ask for it, the tenant's consent settings, no per-client limit, rotation.
 */

export const CODE_TTL_DEFAULT = 60;
export const ACCESS_TTL_DEFAULT = 600;
export const REFRESH_TTL_DEFAULT = 8 * 3600;
/** The longest access token: the deny-list keeps a revocation this long (MAX_ACCESS_MS in oidc.ts). */
export const ACCESS_TTL_MAX = 1800;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const LIFETIME_BOUNDS = {
  codeTtl: { min: 10, max: 600 },
  accessTtl: { min: 60, max: ACCESS_TTL_MAX },
  refreshTtl: { min: 300, max: 90 * 86_400 },
  ratePerMinute: { min: 1, max: 100_000 }
} as const;

export const tenantOauthSchema = z
  .object({
    codeTtl: int(LIFETIME_BOUNDS.codeTtl.min, LIFETIME_BOUNDS.codeTtl.max).optional(),
    accessTtl: int(LIFETIME_BOUNDS.accessTtl.min, LIFETIME_BOUNDS.accessTtl.max).optional(),
    refreshTtl: int(LIFETIME_BOUNDS.refreshTtl.min, LIFETIME_BOUNDS.refreshTtl.max).optional(),
    /** `all`: every client must send a PKCE challenge; `public`: public clients, and the clients that ask for it. */
    pkce: z.enum(['all', 'public']).optional(),
    /** Token, PAR and device requests a minute per client (null: no limit beyond the per-address one). */
    ratePerMinute: int(LIFETIME_BOUNDS.ratePerMinute.min, LIFETIME_BOUNDS.ratePerMinute.max).nullable().optional(),
    rotation: z.enum(['rotate', 'reuse']).optional()
  })
  .strict();

export const clientSettingsSchema = z
  .object({
    codeTtl: int(LIFETIME_BOUNDS.codeTtl.min, LIFETIME_BOUNDS.codeTtl.max).nullable().optional(),
    /** `inherit` the tenant's consent settings, or show the consent screen always (`on`) or never (`off`). */
    consent: z.enum(['inherit', 'on', 'off']).optional(),
    ratePerMinute: int(LIFETIME_BOUNDS.ratePerMinute.min, LIFETIME_BOUNDS.ratePerMinute.max).nullable().optional(),
    rotation: z.enum(['inherit', 'rotate', 'reuse']).optional()
  })
  .strict();

export type TenantOauth = z.infer<typeof tenantOauthSchema>;
export type ClientSettings = z.infer<typeof clientSettingsSchema>;
export type SettingSource = 'client' | 'tenant' | 'default';

export interface EffectiveTenantOauth {
  codeTtl: number;
  accessTtl: number;
  refreshTtl: number;
  pkce: 'all' | 'public';
  ratePerMinute: number | null;
  rotation: 'rotate' | 'reuse';
  sources: Record<string, SettingSource>;
}

export interface EffectiveClientSettings {
  codeTtl: number;
  accessTtl: number;
  refreshTtl: number;
  pkceRequired: boolean;
  consent: 'tenant' | 'on' | 'off';
  ratePerMinute: number | null;
  rotation: 'rotate' | 'reuse';
  sources: Record<string, SettingSource>;
}

const TENANT_ROW = '';

export function resolveTenantOauth(t: TenantOauth | null): EffectiveTenantOauth {
  const v = t ?? {};
  const sources: Record<string, SettingSource> = {};
  const pick = <T>(k: string, x: T | undefined, d: T): T => {
    sources[k] = x === undefined ? 'default' : 'tenant';
    return x === undefined ? d : x;
  };
  return {
    codeTtl: pick('codeTtl', v.codeTtl, CODE_TTL_DEFAULT),
    accessTtl: pick('accessTtl', v.accessTtl, ACCESS_TTL_DEFAULT),
    refreshTtl: pick('refreshTtl', v.refreshTtl, REFRESH_TTL_DEFAULT),
    pkce: pick('pkce', v.pkce, 'public'),
    ratePerMinute: pick('ratePerMinute', v.ratePerMinute, null),
    rotation: pick('rotation', v.rotation, 'rotate'),
    sources
  };
}

export function resolveClient(client: ClientRow, tenant: EffectiveTenantOauth, own: ClientSettings | null): EffectiveClientSettings {
  const c = own ?? {};
  const sources: Record<string, SettingSource> = { accessTtl: 'client', refreshTtl: 'client' };
  const codeTtl = c.codeTtl != null ? c.codeTtl : tenant.codeTtl;
  sources.codeTtl = c.codeTtl != null ? 'client' : tenant.sources.codeTtl!;
  // A public client always uses PKCE; `all` makes every client; otherwise the client's own switch.
  const pkceRequired = client.type === 'public' || tenant.pkce === 'all' || client.pkce_required;
  sources.pkceRequired = client.type === 'public' ? 'default' : tenant.pkce === 'all' ? 'tenant' : 'client';
  const consent = c.consent === 'on' || c.consent === 'off' ? c.consent : 'tenant';
  sources.consent = consent === 'tenant' ? 'tenant' : 'client';
  const ratePerMinute = c.ratePerMinute !== undefined && c.ratePerMinute !== null ? c.ratePerMinute : tenant.ratePerMinute;
  sources.ratePerMinute = c.ratePerMinute != null ? 'client' : tenant.sources.ratePerMinute!;
  // Keeping a refresh token (no rotation) is for confidential clients only; a public client's is always rotated.
  const asked = c.rotation === 'rotate' || c.rotation === 'reuse' ? c.rotation : tenant.rotation;
  const rotation = isConfidential(client) ? asked : 'rotate';
  sources.rotation = !isConfidential(client) ? 'default' : c.rotation === 'rotate' || c.rotation === 'reuse' ? 'client' : tenant.sources.rotation!;
  return { codeTtl, accessTtl: client.access_ttl, refreshTtl: client.refresh_ttl, pkceRequired, consent, ratePerMinute, rotation, sources };
}

/** The provider's view of the settings: every read tolerates a database without the 130 tables (today's values). */
export class OidcClientSettings {
  private ready: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  async available(): Promise<boolean> {
    if (this.ready && (this.ready.ok || Date.now() - this.ready.at < 60_000)) return this.ready.ok;
    const ok = await this.db.schema.hasTable('oidc_client_settings').catch(() => false);
    this.ready = { ok, at: Date.now() };
    return ok;
  }

  private async row(tenantId: string, clientId: string): Promise<{ settings: unknown; updatedBy: string | null; updatedAt: number } | null> {
    if (!(await this.available())) return null;
    const r = (await this.db('oidc_client_settings').where({ tenant_id: tenantId, client_id: clientId }).first().catch(() => undefined)) as { settings: string; updated_by: string | null; updated_at: number } | undefined;
    return r ? { settings: json(r.settings, {}), updatedBy: r.updated_by ?? null, updatedAt: Number(r.updated_at) } : null;
  }

  private async write(tenantId: string, clientId: string, settings: object, by: string | null): Promise<void> {
    if (!(await this.available())) throw new HttpProblem(503, 'Not ready', 'The OAuth settings tables are not installed yet (migration 130_oidc_client_settings). Run the migrations first.');
    const row = { tenant_id: tenantId, client_id: clientId, settings: JSON.stringify(settings), updated_by: by, updated_at: Date.now() };
    const n = await this.db('oidc_client_settings').where({ tenant_id: tenantId, client_id: clientId }).update(row);
    if (!n) await this.db('oidc_client_settings').insert(row);
  }

  async tenantStored(tenantId: string): Promise<TenantOauth | null> {
    const r = await this.row(tenantId, TENANT_ROW);
    const parsed = r ? tenantOauthSchema.safeParse(r.settings) : null;
    return parsed?.success ? parsed.data : null;
  }

  async tenant(tenantId: string): Promise<EffectiveTenantOauth> {
    return resolveTenantOauth(await this.tenantStored(tenantId));
  }

  async saveTenant(tenantId: string, settings: TenantOauth, by: string | null): Promise<EffectiveTenantOauth> {
    await this.write(tenantId, TENANT_ROW, settings, by);
    return this.tenant(tenantId);
  }

  async clientStored(client: Pick<ClientRow, 'tenant_id' | 'client_id'>): Promise<ClientSettings | null> {
    const r = await this.row(client.tenant_id, client.client_id);
    const parsed = r ? clientSettingsSchema.safeParse(r.settings) : null;
    return parsed?.success ? parsed.data : null;
  }

  async effective(client: ClientRow): Promise<EffectiveClientSettings> {
    const [tenant, own] = await Promise.all([this.tenant(client.tenant_id), this.clientStored(client)]);
    return resolveClient(client, tenant, own);
  }

  /** Saves a client's settings, and its access and refresh lifetimes on its row. */
  async saveClient(client: ClientRow, settings: ClientSettings, lifetimes: { accessTtl?: number; refreshTtl?: number }, by: string | null): Promise<void> {
    if (settings.rotation === 'reuse' && !isConfidential(client)) throw new HttpProblem(409, 'Conflict', 'A public client\'s refresh tokens are always rotated: it has no secret to bind a kept token to.');
    if (settings.consent === 'off' && client.dynamic) throw new HttpProblem(409, 'Conflict', 'A client that registered itself always asks each person for consent.');
    const upd: Record<string, unknown> = {};
    if (lifetimes.accessTtl !== undefined) upd.access_ttl = lifetimes.accessTtl;
    if (lifetimes.refreshTtl !== undefined) upd.refresh_ttl = lifetimes.refreshTtl;
    await this.write(client.tenant_id, client.client_id, settings, by);
    if (Object.keys(upd).length) await this.db('oidc_clients').where({ tenant_id: client.tenant_id, id: client.id }).update({ ...upd, updated_at: Date.now() });
  }

  async removeClient(client: Pick<ClientRow, 'tenant_id' | 'client_id'>): Promise<void> {
    if (await this.available()) await this.db('oidc_client_settings').where({ tenant_id: client.tenant_id, client_id: client.client_id }).delete();
  }

  // ---------- enforcement ----------

  async pkceRequired(client: ClientRow): Promise<boolean> {
    if (client.type === 'public' || client.pkce_required) return true;
    return (await this.tenant(client.tenant_id)).pkce === 'all';
  }

  async codeTtlSeconds(client: ClientRow): Promise<number> {
    return (await this.effective(client)).codeTtl;
  }

  /**
   * Whether the consent screen is shown, given the tenant's consent settings: a client set to `on` always asks (unless
   * the person's remembered consent covers the scopes), one set to `off` never does.
   */
  async consentMode(client: ClientRow): Promise<'tenant' | 'on' | 'off'> {
    if (client.dynamic) return 'tenant';
    const c = (await this.clientStored(client))?.consent;
    return c === 'on' || c === 'off' ? c : 'tenant';
  }

  /** Counts one request against the client's per-minute limit (shared by every instance through the counters). */
  async admit(client: ClientRow): Promise<void> {
    const limit = (await this.effective(client)).ratePerMinute;
    if (!limit) return;
    const c = await this.s().counters.hit(`oidc-client:${client.tenant_id}:${client.client_id}`, 60_000);
    if (c.count > limit) {
      const retry = Math.max(1, Math.ceil(c.resetMs / 1000));
      throw new OAuthError(429, 'slow_down', `This client may make ${limit} requests a minute. Try again in ${retry} seconds.`, { 'Retry-After': String(retry) });
    }
  }

  /** Keeps why a refresh-token family ended (a reused token), for the client's settings page. */
  async familyEnded(row: { family_id: string; tenant_id: string; client_id: string; user_id: string }, reason: 'reuse', tokensRevoked: number): Promise<void> {
    if (!(await this.available())) return;
    try {
      await this.db('oidc_refresh_families').insert({ family_id: row.family_id, tenant_id: row.tenant_id, client_id: row.client_id, user_id: row.user_id, reason, tokens_revoked: tokensRevoked, revoked_at: Date.now() });
    } catch {
      // Already recorded (a second reuse of the same family).
    }
  }

  async endedFamilies(tenantId: string, clientId: string, limit = 20): Promise<{ familyId: string; userId: string; reason: string; tokensRevoked: number; revokedAt: number }[]> {
    if (!(await this.available())) return [];
    const rows = (await this.db('oidc_refresh_families').where({ tenant_id: tenantId, client_id: clientId }).orderBy('revoked_at', 'desc').limit(limit)) as { family_id: string; user_id: string; reason: string; tokens_revoked: number; revoked_at: number }[];
    return rows.map((r) => ({ familyId: r.family_id, userId: r.user_id, reason: r.reason, tokensRevoked: Number(r.tokens_revoked), revokedAt: Number(r.revoked_at) }));
  }
}

