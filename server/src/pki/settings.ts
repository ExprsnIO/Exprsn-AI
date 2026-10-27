import { ulid } from 'ulid';
import { z } from 'zod';
import type { Config } from '../config/index.js';
import { envOf } from '../config/index.js';
import { appliedOf } from '../config/settings.js';
import { json } from '../db/knex.js';
import { rolesGranting } from '../authz/permissions.js';
import type { Services } from '../services.js';
import { MAX_OCSP_REQUESTS } from './ocsp.js';
import { PkiError, type PkiActor } from './service.js';
import { ISSUER_KEY_TYPES, KEY_STRENGTH, type IssuerKeyType, type SubjectAttrs } from './x509.js';

/*
 * 1.9.0, Sprint 55 (B-187): the certificate authority's settings, saved from Certificates › Settings or
 * `exprsn-ai pki:settings`, with the environment as the default and the floor.
 *
 *   effective value = the tenant's saved value (where a tenant may override)
 *                   → else the platform's saved value
 *                   → else the environment variable (PKI_*), or the built-in default
 *
 * Every value is checked against its range when saved. A value set explicitly in the environment (or by an approved
 * configuration override) is a floor: a saved value may be stricter, never weaker (a shorter lifetime, a lower rate,
 * a stronger key). For a tenant the platform's effective value is the floor in the same way: a tenant may tighten
 * what the platform allows, never loosen it ("per-tenant overrides where safe").
 *
 * Changes to the root or the intermediates (subject, key algorithm, validity, path length) are under dual control:
 * they wait as a proposal until a second platform admin approves, and even then take effect only at the next
 * rotation (subject and algorithm) or re-issue (validity and path length). Nothing re-keys when a setting changes.
 * Everything else takes effect at once: the next issuance, the next CRL, the next OCSP answer.
 *
 * The tables come with migration 127. Until it runs, every value is the environment's and saving answers 409.
 */

export const PKI_SETTINGS_TOPIC = 'pki.settings';
export const PLATFORM_SCOPE = 'platform';

export type SettingSource = 'tenant' | 'platform' | 'environment' | 'default';
export type TokenSignature = 'ecdsa-p256' | 'ecdsa-p384' | 'rsa-pss';
export type TokenExpiry = 'time' | 'uses' | 'persistent';

/** The effective value of every setting, by key. */
export interface PkiValues {
  'root.subject': SubjectAttrs;
  'root.days': number;
  'root.keyType': IssuerKeyType;
  'root.pathLen': number | null;
  'intermediate.subject': SubjectAttrs;
  'intermediate.days': number;
  'intermediate.keyType': IssuerKeyType;
  'intermediate.pathLen': number;
  'leaf.subject': SubjectAttrs;
  'profiles.subject': Record<string, SubjectAttrs>;
  'crl.intervalMinutes': number;
  'crl.validityHours': number;
  'crl.nextUpdateDays': number | null;
  'ocsp.validityMinutes': number;
  'ocsp.cacheSeconds': number;
  'ocsp.delegated': boolean;
  'ocsp.responderDays': number;
  'ocsp.responderKeyType': IssuerKeyType;
  'ocsp.batch': boolean;
  'ocsp.maxBatch': number;
  'acme.termsUrl': string | null;
  'acme.certDays': number | null;
  'acme.privateIdentifiers': boolean;
  'acme.issuerId': string | null;
  publicUrl: string | null;
  ratePerMinute: number;
  'tokens.maxBytes': number;
  'tokens.signature': TokenSignature;
  'tokens.defaultExpiry': TokenExpiry;
  'tokens.defaultTtlMinutes': number;
  'tokens.defaultUses': number;
  'tokens.rotationDays': number;
  'members.enabled': boolean;
  'members.profileId': string | null;
  'members.withToken': boolean;
  'members.renewDays': number;
  'members.signIn': boolean;
  'members.mtls': boolean;
  'members.san': 'uri' | 'email';
}
export type PkiKey = keyof PkiValues;

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const text64 = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f), 'printable characters only');
export const subjectSchema = z
  .object({
    C: z.string().trim().regex(/^[A-Za-z]{2}$/, 'a two-letter country code').nullable().optional(),
    ST: text64.nullable().optional(),
    L: text64.nullable().optional(),
    O: text64.nullable().optional(),
    OU: text64.nullable().optional(),
    email: z.email().max(128).refine((v) => /^[\x21-\x7e]+$/.test(v), 'ASCII only').nullable().optional()
  })
  .strict()
  .transform((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, k === 'C' ? String(v).toUpperCase() : v])) as SubjectAttrs);
const keyType = z.enum(ISSUER_KEY_TYPES as unknown as [IssuerKeyType, ...IssuerKeyType[]]);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const url = z.url().max(500).refine((u) => /^https?:\/\//i.test(u), 'an http or https URL');

type Group = 'root' | 'intermediate' | 'names' | 'crl' | 'ocsp' | 'acme' | 'public' | 'tokens' | 'members';

interface Def {
  key: PkiKey;
  group: Group;
  label: string;
  /** The allowed values, in words (shown beside the field). */
  range: string;
  schema: z.ZodType;
  /** What applies when nothing is saved. */
  base: (c: Config) => unknown;
  /** The environment variable `base` reads. */
  env?: string;
  /** Saved at platform scope; a tenant may override it. */
  platform: boolean;
  tenant: boolean;
  /** A change waits for a second platform admin. */
  dual?: boolean;
  /** Whether `a` is at least as strict as `b` (for floors); absent: no floor. */
  stricter?: (a: never, b: never) => boolean;
  /** When a saved value takes effect. */
  applies: string;
}

const lower = (a: number | null, b: number | null) => a == null || b == null || a <= b;
const stronger = (a: IssuerKeyType, b: IssuerKeyType) => KEY_STRENGTH[a] >= KEY_STRENGTH[b];
const nextIssue = 'At the next issuance';
const crlNext = 'At the next CRL';
const ocspNext = 'At the next OCSP answer';
const rotation = 'At the next rotation, after a second platform admin approves';
const reissue = 'At the next re-issue or rotation, after a second platform admin approves';

const DEFS: readonly Def[] = [
  { key: 'root.subject', group: 'root', label: 'Root subject', range: 'C (two letters), ST, L, O, OU (up to 64 characters each) and email', schema: subjectSchema, base: () => ({}), platform: true, tenant: false, dual: true, applies: rotation },
  { key: 'root.days', group: 'root', label: 'Root validity (days)', range: '365 to 9,125 days', schema: int(365, 9125), base: () => 3650, platform: true, tenant: false, dual: true, stricter: lower as never, applies: reissue },
  { key: 'root.keyType', group: 'root', label: 'Root key algorithm', range: ISSUER_KEY_TYPES.join(', '), schema: keyType, base: () => 'ecdsa-p256', platform: true, tenant: false, dual: true, stricter: stronger as never, applies: rotation },
  { key: 'root.pathLen', group: 'root', label: 'Root path length', range: 'none (unlimited) or 1 to 4', schema: int(1, 4).nullable(), base: () => null, platform: true, tenant: false, dual: true, applies: reissue },
  { key: 'intermediate.subject', group: 'intermediate', label: 'Intermediate subject', range: 'C (two letters), ST, L, O, OU and email; the common name stays the tenant’s', schema: subjectSchema, base: () => ({}), platform: true, tenant: false, dual: true, applies: rotation },
  { key: 'intermediate.days', group: 'intermediate', label: 'Intermediate validity (days)', range: '30 to 3,650 days, within the root’s', schema: int(30, 3650), base: () => 1825, platform: true, tenant: false, dual: true, stricter: lower as never, applies: reissue },
  { key: 'intermediate.keyType', group: 'intermediate', label: 'Intermediate key algorithm', range: ISSUER_KEY_TYPES.join(', '), schema: keyType, base: () => 'ecdsa-p256', platform: true, tenant: false, dual: true, stricter: stronger as never, applies: rotation },
  { key: 'intermediate.pathLen', group: 'intermediate', label: 'Intermediate path length', range: '0 to 3, below the root’s', schema: int(0, 3), base: () => 0, platform: true, tenant: false, dual: true, applies: reissue },
  { key: 'leaf.subject', group: 'names', label: 'Subject of issued certificates', range: 'C, ST, L, O, OU and email added to each certificate’s common name', schema: subjectSchema, base: () => ({}), platform: true, tenant: true, applies: nextIssue },
  { key: 'profiles.subject', group: 'names', label: 'Subject per profile', range: 'a subject per profile id, in place of the one above', schema: z.record(id26, subjectSchema).refine((r) => Object.keys(r).length <= 200, 'at most 200 profiles'), base: () => ({}), platform: false, tenant: true, applies: nextIssue },
  { key: 'crl.intervalMinutes', group: 'crl', label: 'CRL interval (minutes)', range: '0 (only after a revocation) to 10,080 minutes', schema: int(0, 10_080), base: (c) => c.PKI_CRL_MINUTES, env: 'PKI_CRL_MINUTES', platform: true, tenant: true, stricter: ((a: number, b: number) => a > 0 && (b === 0 || a <= b)) as never, applies: 'At the next scheduled CRL' },
  { key: 'crl.validityHours', group: 'crl', label: 'CRL validity (hours)', range: '1 to 720 hours, longer than the interval', schema: int(1, 720), base: (c) => c.PKI_CRL_VALIDITY_HOURS, env: 'PKI_CRL_VALIDITY_HOURS', platform: true, tenant: true, stricter: lower as never, applies: crlNext },
  { key: 'crl.nextUpdateDays', group: 'crl', label: 'CRL next update (days)', range: 'none (the validity) or 1 to 30 days, at least the validity', schema: int(1, 30).nullable(), base: () => null, platform: true, tenant: true, stricter: lower as never, applies: crlNext },
  { key: 'ocsp.validityMinutes', group: 'ocsp', label: 'OCSP answer validity (minutes)', range: '1 to 10,080 minutes', schema: int(1, 10_080), base: (c) => c.PKI_OCSP_VALIDITY_MINUTES, env: 'PKI_OCSP_VALIDITY_MINUTES', platform: true, tenant: true, stricter: lower as never, applies: ocspNext },
  { key: 'ocsp.cacheSeconds', group: 'ocsp', label: 'OCSP cache (seconds)', range: '0 to 86,400 seconds, within the answer validity', schema: int(0, 86_400), base: (c) => c.PKI_OCSP_CACHE_SECONDS, env: 'PKI_OCSP_CACHE_SECONDS', platform: true, tenant: true, stricter: lower as never, applies: ocspNext },
  { key: 'ocsp.delegated', group: 'ocsp', label: 'Delegated responder certificate', range: 'on: a short-lived responder certificate signs; off: the issuer’s own key signs', schema: z.boolean(), base: () => true, platform: true, tenant: false, applies: ocspNext },
  { key: 'ocsp.responderDays', group: 'ocsp', label: 'Responder certificate lifetime (days)', range: '1 to 365 days', schema: int(1, 365), base: (c) => c.PKI_OCSP_SIGNER_DAYS, env: 'PKI_OCSP_SIGNER_DAYS', platform: true, tenant: false, stricter: lower as never, applies: 'At the next responder certificate' },
  { key: 'ocsp.responderKeyType', group: 'ocsp', label: 'Responder key algorithm', range: ISSUER_KEY_TYPES.join(', '), schema: keyType, base: () => 'ecdsa-p256', platform: true, tenant: false, stricter: stronger as never, applies: 'At the next responder certificate' },
  { key: 'ocsp.batch', group: 'ocsp', label: 'Batch requests', range: 'on: several certificates in one request; off: one', schema: z.boolean(), base: () => true, platform: true, tenant: false, applies: ocspNext },
  { key: 'ocsp.maxBatch', group: 'ocsp', label: 'Most certificates per request', range: `1 to ${MAX_OCSP_REQUESTS}`, schema: int(1, MAX_OCSP_REQUESTS), base: () => MAX_OCSP_REQUESTS, platform: true, tenant: false, stricter: lower as never, applies: ocspNext },
  { key: 'acme.termsUrl', group: 'acme', label: 'Terms of service URL', range: 'none, or an http or https URL; when set, new accounts must agree', schema: url.nullable(), base: () => null, platform: true, tenant: true, applies: 'At the next directory request' },
  { key: 'acme.certDays', group: 'acme', label: 'ACME certificate validity (days)', range: 'none (the profile’s default) or 1 to 398 days, within the profile', schema: int(1, 398).nullable(), base: () => null, platform: true, tenant: true, stricter: lower as never, applies: 'At the next finalized order' },
  { key: 'acme.privateIdentifiers', group: 'acme', label: 'Private identifiers allowed', range: 'on: names such as host.internal or printer.local; off: public names only', schema: z.boolean(), base: () => true, platform: true, tenant: true, stricter: ((a: boolean, b: boolean) => !a || b) as never, applies: 'At the next new order' },
  { key: 'acme.issuerId', group: 'acme', label: 'Issuing intermediate', range: 'none (the tenant’s active intermediate) or one of the tenant’s intermediates', schema: id26.nullable(), base: () => null, platform: false, tenant: true, applies: 'At the next finalized order' },
  { key: 'publicUrl', group: 'public', label: 'Public URL', range: 'none (PUBLIC_URL) or an http or https URL; CRL, OCSP and issuer URLs in new certificates', schema: url.nullable(), base: (c) => c.PKI_PUBLIC_URL ?? null, env: 'PKI_PUBLIC_URL', platform: true, tenant: false, applies: 'In certificates issued from now on' },
  { key: 'ratePerMinute', group: 'public', label: 'Requests per address per minute', range: '1 to 1,000,000', schema: int(1, 1_000_000), base: (c) => c.PKI_PUBLIC_RATE_PER_MINUTE, env: 'PKI_PUBLIC_RATE_PER_MINUTE', platform: true, tenant: false, stricter: lower as never, applies: 'At the next public request' },
  { key: 'tokens.maxBytes', group: 'tokens', label: 'Largest token (bytes)', range: '512 to 16,384 bytes', schema: int(512, 16_384), base: () => 4096, platform: true, tenant: true, stricter: lower as never, applies: 'At the next token' },
  { key: 'tokens.signature', group: 'tokens', label: 'Token signature', range: 'ECDSA P-256 (ES256), ECDSA P-384 (ES384) or RSA-PSS (PS256)', schema: z.enum(['ecdsa-p256', 'ecdsa-p384', 'rsa-pss']), base: () => 'ecdsa-p256', platform: true, tenant: true, applies: 'At the next token-signer rotation' },
  { key: 'tokens.defaultExpiry', group: 'tokens', label: 'Default expiry', range: 'time, uses or persistent', schema: z.enum(['time', 'uses', 'persistent']), base: () => 'time', platform: true, tenant: true, applies: 'At the next token' },
  { key: 'tokens.defaultTtlMinutes', group: 'tokens', label: 'Default lifetime (minutes)', range: '1 to 525,600 minutes (a year)', schema: int(1, 525_600), base: () => 60, platform: true, tenant: true, applies: 'At the next token' },
  { key: 'tokens.defaultUses', group: 'tokens', label: 'Default uses', range: '1 to 1,000,000', schema: int(1, 1_000_000), base: () => 1, platform: true, tenant: true, applies: 'At the next token' },
  { key: 'tokens.rotationDays', group: 'tokens', label: 'Token signer rotation (days)', range: '1 to 365 days', schema: int(1, 365), base: () => 30, platform: true, tenant: true, stricter: lower as never, applies: 'At the next scheduled rotation' },
  { key: 'members.enabled', group: 'members', label: 'Member certificates', range: 'on: each member gets a client certificate when they join', schema: z.boolean(), base: () => false, platform: false, tenant: true, applies: 'For members who join from now on, and at the next sweep for those already here' },
  { key: 'members.profileId', group: 'members', label: 'Client profile', range: 'one of the tenant’s active client profiles', schema: id26.nullable(), base: () => null, platform: false, tenant: true, applies: nextIssue },
  { key: 'members.withToken', group: 'members', label: 'Also a CA token', range: 'on: each member certificate comes with a CA token for this server', schema: z.boolean(), base: () => false, platform: false, tenant: true, applies: nextIssue },
  { key: 'members.renewDays', group: 'members', label: 'Renew before expiry (days)', range: '1 to 90 days', schema: int(1, 90), base: () => 30, platform: false, tenant: true, applies: 'At the next sweep' },
  { key: 'members.signIn', group: 'members', label: 'Sign-in with the certificate', range: 'on: the certificate signs the member in (through a trusted proxy)', schema: z.boolean(), base: () => false, platform: false, tenant: true, applies: 'At the next sign-in' },
  { key: 'members.mtls', group: 'members', label: 'mTLS for the API', range: 'on: the certificate authenticates API calls (through a trusted proxy)', schema: z.boolean(), base: () => false, platform: false, tenant: true, applies: 'At the next request' },
  { key: 'members.san', group: 'members', label: 'Mapped to the account by', range: 'uri (exprsn-member://<tenant>/<user id>) or email (the account’s address)', schema: z.enum(['uri', 'email']), base: () => 'uri', platform: false, tenant: true, applies: nextIssue }
];
const BY_KEY = new Map<string, Def>(DEFS.map((d) => [d.key, d]));
export const PKI_SETTING_KEYS = DEFS.map((d) => d.key);
export const DUAL_KEYS = DEFS.filter((d) => d.dual).map((d) => d.key);

export interface SettingView {
  key: PkiKey;
  group: Group;
  label: string;
  range: string;
  value: unknown;
  source: SettingSource;
  env: string | null;
  /** The value the environment gives (whether or not it is set explicitly). */
  envValue: unknown;
  /** A value saved here must be at least as strict as this one (the explicit environment value, or for a tenant the platform's). */
  floor: { value: unknown; source: SettingSource } | null;
  /** What this scope saved (null: inherits). */
  saved: unknown;
  scopes: { platform: boolean; tenant: boolean };
  dual: boolean;
  applies: string;
}

export interface ProposalRow {
  id: string;
  scope: string;
  changes: Record<string, unknown>;
  state: 'pending' | 'applied' | 'rejected' | 'withdrawn';
  reason: string | null;
  tenant_id: string;
  proposed_by: string | null;
  proposed_at: number;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
}

const proposalFrom = (r: Record<string, unknown>): ProposalRow => ({ ...(r as unknown as ProposalRow), changes: json<Record<string, unknown>>(r.changes, {}), proposed_at: Number(r.proposed_at), decided_at: r.decided_at == null ? null : Number(r.decided_at) });

interface Row {
  data: Record<string, unknown>;
  version: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class PkiSettings {
  private readonly rows = new Map<string, { row: Row | null; at: number }>();
  private table: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private get cfg() {
    return this.s().cfg;
  }

  listen(): void {
    this.s().bus.on<{ scope?: string }>(PKI_SETTINGS_TOPIC, ({ scope }) => {
      // Marked stale rather than dropped: synchronous readers keep the last value until the next read replaces it.
      for (const [k, v] of this.rows) if (!scope || k === scope) v.at = 0;
      // The platform row is read again at once, so the URL builders see the new public URL.
      if (!scope || scope === PLATFORM_SCOPE) void this.prime();
    });
  }

  /** Forgets whether the tables exist (after a migration ran in this process). */
  forget(): void {
    this.table = null;
    this.rows.clear();
  }

  /** Whether the migration that makes the tables has run. */
  async configured(): Promise<boolean> {
    // Present is kept; missing is looked at again after 10 seconds, so registering the migration is noticed soon.
    if (this.table && (this.table.ok || Date.now() - this.table.at < 10_000)) return this.table.ok;
    let ok: boolean;
    try {
      ok = (await this.db.schema.hasTable('pki_settings')) && (await this.db.schema.hasTable('pki_settings_proposals'));
    } catch {
      ok = false;
    }
    this.table = { ok, at: Date.now() };
    return ok;
  }

  private stale(scope: string): void {
    const hit = this.rows.get(scope);
    if (hit) hit.at = 0;
  }

  private async row(scope: string): Promise<Row | null> {
    const hit = this.rows.get(scope);
    if (hit && Date.now() - hit.at < 30_000) return hit.row;
    let row: Row | null = null;
    if (await this.configured()) {
      const r = (await this.db('pki_settings').where({ scope }).first()) as Record<string, unknown> | undefined;
      row = r ? { data: json<Record<string, unknown>>(r.data, {}), version: Number(r.version) } : null;
    }
    this.rows.set(scope, { row, at: Date.now() });
    return row;
  }

  /** Whether the environment variable behind a setting was set (in the environment, a file or an approved override). */
  private explicit(d: Def): boolean {
    if (!d.env) return false;
    const env = envOf(this.cfg);
    return !!appliedOf(this.cfg)[d.env] || (env[d.env] != null && env[d.env] !== '') || (env[`${d.env}_FILE`] != null && env[`${d.env}_FILE`] !== '');
  }

  private envValue(d: Def): unknown {
    return d.base(this.cfg);
  }

  /** The platform's effective values, without a tenant (the root's CRLs and OCSP answers, the public routes). */
  async platform(): Promise<PkiValues> {
    return this.values(null);
  }

  /** The effective values for a tenant (null: the platform's). */
  async values(tenantId: string | null): Promise<PkiValues> {
    const plat = await this.row(PLATFORM_SCOPE);
    const ten = tenantId ? await this.row(tenantId) : null;
    const out: Record<string, unknown> = {};
    for (const d of DEFS) {
      const t = d.tenant && ten && d.key in ten.data ? ten.data[d.key] : undefined;
      const p = d.platform && plat && d.key in plat.data ? plat.data[d.key] : undefined;
      out[d.key] = t !== undefined ? t : p !== undefined ? p : this.envValue(d);
    }
    return out as unknown as PkiValues;
  }

  /** The platform values this instance has read already (for synchronous callers such as the URL builders); null until loaded. */
  cachedPlatform<K extends PkiKey>(key: K): PkiValues[K] | undefined {
    const hit = this.rows.get(PLATFORM_SCOPE);
    const d = BY_KEY.get(key)!;
    if (!hit) return undefined;
    const v = hit.row && key in hit.row.data ? hit.row.data[key] : this.envValue(d);
    return v as PkiValues[K];
  }

  /** Loads the platform row so `cachedPlatform` answers (at start, and again after each change through the bus). */
  async prime(): Promise<void> {
    await this.row(PLATFORM_SCOPE).catch(() => undefined);
  }

  /** Every setting as Certificates › Settings shows it for a scope: value, source, floor, range and what this scope saved. */
  async describe(tenantId: string, scope: 'platform' | 'tenant'): Promise<SettingView[]> {
    const plat = await this.row(PLATFORM_SCOPE);
    const ten = await this.row(tenantId);
    const platformValues = await this.values(null);
    const out: SettingView[] = [];
    for (const d of DEFS) {
      if (scope === 'platform' && !d.platform) continue;
      if (scope === 'tenant' && !d.tenant) continue;
      const tv = d.tenant && ten && d.key in ten.data ? ten.data[d.key] : undefined;
      const pv = d.platform && plat && d.key in plat.data ? plat.data[d.key] : undefined;
      const envValue = this.envValue(d);
      const envSource: SettingSource = this.explicit(d) ? 'environment' : 'default';
      let value: unknown;
      let source: SettingSource;
      if (scope === 'tenant' && tv !== undefined) [value, source] = [tv, 'tenant'];
      else if (pv !== undefined) [value, source] = [pv, 'platform'];
      else [value, source] = [envValue, envSource];
      const floor = !d.stricter ? null : scope === 'tenant' && d.platform ? { value: platformValues[d.key], source: (pv !== undefined ? 'platform' : envSource) as SettingSource } : envSource === 'environment' ? { value: envValue, source: 'environment' as const } : null;
      out.push({ key: d.key, group: d.group, label: d.label, range: d.range, value, source, env: d.env ?? null, envValue, floor, saved: scope === 'tenant' ? (tv ?? null) : (pv ?? null), scopes: { platform: d.platform, tenant: d.tenant }, dual: !!d.dual, applies: d.applies });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Saving

  private refuse(message: string, key?: string): never {
    throw new PkiError(422, message, { step: 'settings', ...(key ? { key } : {}) });
  }

  /** Parses each value against its range, in this scope. */
  private parse(scope: 'platform' | 'tenant', values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const d = BY_KEY.get(k);
      if (!d) this.refuse(`${k} is not a certificate authority setting.`, k);
      if (scope === 'platform' && !d.platform) this.refuse(`${d.label} is set by each tenant, not for the platform.`, k);
      if (scope === 'tenant' && !d.tenant) this.refuse(`${d.label} is a platform setting; a tenant cannot override it.`, k);
      const r = d.schema.safeParse(v);
      if (!r.success) this.refuse(`${d.label}: ${r.error.issues[0]?.message ?? 'out of range'} (allowed: ${d.range}).`, k);
      out[k] = r.data;
    }
    return out;
  }

  /** Floors and the rules between settings, on the values that would apply. */
  private async check(tenantId: string, scope: 'platform' | 'tenant', merged: Record<string, unknown>, changed: string[]): Promise<void> {
    const platformAfter = scope === 'platform' ? this.mergeValues(merged, null) : await this.values(null);
    const after = scope === 'platform' ? platformAfter : this.mergeValues(merged, platformAfter);
    for (const k of changed) {
      const d = BY_KEY.get(k)!;
      if (!d.stricter || !(k in merged)) continue;
      const floor = scope === 'tenant' && d.platform ? platformAfter[d.key] : this.explicit(d) ? this.envValue(d) : undefined;
      if (floor === undefined) continue;
      if (!(d.stricter as (a: unknown, b: unknown) => boolean)(merged[k], floor)) this.refuse(`${d.label} may be stricter than ${scope === 'tenant' && d.platform ? "the platform's" : `the environment's (${d.env})`} ${JSON.stringify(floor)}, never weaker.`, k);
    }
    if (after['crl.intervalMinutes'] > 0 && after['crl.intervalMinutes'] >= after['crl.validityHours'] * 60) this.refuse('The CRL validity must be longer than the CRL interval.', 'crl.validityHours');
    if (after['crl.nextUpdateDays'] != null && after['crl.validityHours'] > after['crl.nextUpdateDays'] * 24) this.refuse('The CRL next update must be at least the CRL validity.', 'crl.nextUpdateDays');
    if (after['ocsp.cacheSeconds'] > after['ocsp.validityMinutes'] * 60) this.refuse('The OCSP cache cannot outlast an answer’s validity.', 'ocsp.cacheSeconds');
    if (platformAfter['root.pathLen'] !== null && platformAfter['root.pathLen'] <= platformAfter['intermediate.pathLen']) this.refuse('The root’s path length must be larger than the intermediates’.', 'root.pathLen');
    if (platformAfter['intermediate.days'] > platformAfter['root.days']) this.refuse('The intermediates cannot outlive the root.', 'intermediate.days');
    if (scope !== 'tenant') return;
    // Tenant-only references: profiles, the ACME intermediate and the member profile must be this tenant's.
    const pki = this.s().pki;
    if (changed.includes('profiles.subject')) {
      const ids = new Set((await pki.profiles(tenantId)).map((p) => p.id));
      for (const id of Object.keys(after['profiles.subject'])) if (!ids.has(id)) this.refuse(`There is no profile ${id} in this tenant.`, 'profiles.subject');
    }
    if (changed.includes('acme.issuerId') && after['acme.issuerId']) {
      const i = await pki.issuer(after['acme.issuerId']);
      if (!i || i.kind !== 'intermediate' || i.tenant_id !== tenantId) this.refuse('The issuing intermediate must be one of this tenant’s intermediates.', 'acme.issuerId');
    }
    if (after['members.enabled'] && changed.some((k) => k.startsWith('members.'))) {
      if (!after['members.profileId']) this.refuse('Member certificates need a client profile.', 'members.profileId');
      const p = await pki.profile(tenantId, after['members.profileId']);
      if (!p || p.kind !== 'client' || p.state !== 'active') this.refuse('Member certificates are issued under an active client profile.', 'members.profileId');
      if (after['members.san'] === 'uri') {
        const tenant = await this.s().tenants.byId(tenantId);
        const prefix = `exprsn-member://${tenant?.slug ?? tenantId}/`;
        if (!p.policy.uriPrefixes.some((u) => prefix.startsWith(u))) this.refuse(`The profile ${p.name} must allow the URI prefix ${prefix} for member certificates.`, 'members.profileId');
      }
    }
    if ((after['members.signIn'] || after['members.mtls']) && !after['members.enabled']) this.refuse('Certificate sign-in and mTLS need member certificates on.', 'members.enabled');
  }

  /** The values that would apply with `data` saved in a scope over `under` (the platform's values for a tenant, else the environment). */
  private mergeValues(data: Record<string, unknown>, under: PkiValues | null): PkiValues {
    const out: Record<string, unknown> = {};
    for (const d of DEFS) out[d.key] = d.key in data ? data[d.key] : under ? under[d.key] : this.envValue(d);
    return out as unknown as PkiValues;
  }

  private async requireTable(): Promise<void> {
    if (!(await this.configured())) throw new PkiError(409, 'Certificate authority settings are not configured on this server yet (migration 127_pki_settings has not run); the environment values apply.', { step: 'settings-table' });
  }

  private scopeId(by: PkiActor, scope: 'platform' | 'tenant'): string {
    return scope === 'platform' ? PLATFORM_SCOPE : by.tenantId;
  }

  private audit(by: PkiActor, action: string, target: Record<string, unknown>, detail: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: by.tenantId, action, kind: by.userId ? 'admin' : 'system', actor: by.actor, target, label: 'internal', detail, traceId: by.traceId ?? null });
  }

  private changedNow(scopeId: string): void {
    this.s().bus.publish(PKI_SETTINGS_TOPIC, { scope: scopeId });
    // CRLs and OCSP answers read the new values at once: drop the cached answers everywhere.
    this.s().pki.changed('');
  }

  /** Writes `data` as the scope's saved values, if nobody saved in between (compare-and-set on the version). */
  private async write(scopeId: string, data: Record<string, unknown>, base: Row | null, by: PkiActor): Promise<void> {
    const t = Date.now();
    if (!base) {
      try {
        await this.db('pki_settings').insert({ scope: scopeId, data: JSON.stringify(data), version: 1, updated_by: by.userId, updated_at: t });
        this.rows.set(scopeId, { row: { data, version: 1 }, at: t });
        return;
      } catch {
        throw new PkiError(409, 'Someone else saved these settings at the same time. Reload and try again.', { step: 'settings-version' });
      }
    }
    const n = await this.db('pki_settings').where({ scope: scopeId, version: base.version }).update({ data: JSON.stringify(data), version: base.version + 1, updated_by: by.userId, updated_at: t });
    if (!n) throw new PkiError(409, 'Someone else saved these settings at the same time. Reload and try again.', { step: 'settings-version' });
    this.rows.set(scopeId, { row: { data, version: base.version + 1 }, at: t });
  }

  /**
   * Saves settings in a scope. `values` are new values, `reset` keys go back to inheriting. Out-of-range or weaker
   * values are refused (422). Changes to the root and intermediates become a proposal for a second platform admin;
   * the rest apply at once. `platformAdmin` says whether the caller holds platform:manage.
   */
  async save(by: PkiActor, scope: 'platform' | 'tenant', input: { values?: Record<string, unknown>; reset?: string[]; reason?: string | null }, platformAdmin: boolean): Promise<{ applied: string[]; proposal: ProposalRow | null }> {
    await this.requireTable();
    if (scope === 'platform' && !platformAdmin) throw new PkiError(403, 'Only a platform administrator changes the platform’s certificate authority settings.', { step: 'permission' });
    const parsed = this.parse(scope, input.values ?? {});
    for (const k of input.reset ?? []) {
      const d = BY_KEY.get(k);
      if (!d) this.refuse(`${k} is not a certificate authority setting.`, k);
      if (!(scope === 'platform' ? d.platform : d.tenant)) this.refuse(`${d.label} cannot be reset for ${scope === 'platform' ? 'the platform' : 'a tenant'}.`, k);
    }
    const scopeId = this.scopeId(by, scope);
    this.stale(scopeId);
    const base = await this.row(scopeId);
    const current = { ...(base?.data ?? {}) };
    const wanted: Record<string, unknown> = { ...parsed };
    for (const k of input.reset ?? []) wanted[k] = undefined;
    const changes = Object.entries(wanted).filter(([k, v]) => !same(current[k], v) || (v === undefined && k in current));
    const immediate = changes.filter(([k]) => !BY_KEY.get(k)!.dual);
    const dual = changes.filter(([k]) => BY_KEY.get(k)!.dual);
    // The whole change is checked as if it all applied, so an approved proposal cannot break a rule later.
    const merged = { ...current };
    for (const [k, v] of changes) if (v === undefined) delete merged[k];
    else merged[k] = v;
    await this.check(by.tenantId, scope, merged, changes.map(([k]) => k));
    if (!changes.length) return { applied: [], proposal: null };

    const applied: string[] = [];
    if (immediate.length) {
      const next = { ...current };
      for (const [k, v] of immediate) if (v === undefined) delete next[k];
      else next[k] = v;
      await this.write(scopeId, next, base, by);
      this.changedNow(scopeId);
      applied.push(...immediate.map(([k]) => k));
      await this.audit(by, 'pki.settings.updated', { scope: scopeId }, { changes: Object.fromEntries(immediate.map(([k, v]) => [k, { before: current[k] ?? null, after: v ?? null, reset: v === undefined }])), reason: input.reason ?? null });
    }
    let proposal: ProposalRow | null = null;
    if (dual.length) {
      const row = { id: ulid(), scope: scopeId, changes: JSON.stringify(Object.fromEntries(dual.map(([k, v]) => [k, v === undefined ? null : v]))), state: 'pending', reason: input.reason ?? null, tenant_id: by.tenantId, proposed_by: by.userId, proposed_at: Date.now(), decided_by: null, decided_at: null, note: null };
      await this.db('pki_settings_proposals').insert(row);
      proposal = proposalFrom(row);
      await this.audit(by, 'pki.settings.proposed', { scope: scopeId, proposal: row.id }, { changes: Object.fromEntries(dual.map(([k, v]) => [k, { before: current[k] ?? null, after: v ?? null, reset: v === undefined }])), reason: input.reason ?? null });
      await this.askApprovers(by, proposal);
    }
    return { applied, proposal };
  }

  private async askApprovers(by: PkiActor, p: ProposalRow): Promise<void> {
    const n = this.s().notifications;
    const to = (await n.usersWithRoles(by.tenantId, rolesGranting('platform:manage', by.tenantId))).filter((u) => u !== by.userId);
    if (!to.length) return;
    await n.notify({ tenantId: by.tenantId, userIds: to, kind: 'pki.settings.proposed', title: 'A certificate authority change waits for a second platform admin', body: `Settings: ${Object.keys(p.changes).join(', ')}`.slice(0, 300), route: 'certificates', label: 'internal' }).catch(() => undefined);
  }

  async proposals(state: ProposalRow['state'] | 'all' = 'pending', limit = 50): Promise<ProposalRow[]> {
    if (!(await this.configured())) return [];
    const q = this.db('pki_settings_proposals').orderBy('proposed_at', 'desc').limit(limit);
    if (state !== 'all') q.where({ state });
    return ((await q) as Record<string, unknown>[]).map(proposalFrom);
  }

  async proposal(id: string): Promise<ProposalRow | undefined> {
    if (!(await this.configured())) return undefined;
    const r = (await this.db('pki_settings_proposals').where({ id }).first()) as Record<string, unknown> | undefined;
    return r ? proposalFrom(r) : undefined;
  }

  /** Dual control: a second platform admin (never the proposer) puts a proposal in force. It applies at the next rotation or re-issue. */
  async approve(by: PkiActor, id: string, note: string | null, platformAdmin: boolean): Promise<ProposalRow> {
    await this.requireTable();
    if (!platformAdmin) throw new PkiError(403, 'Only a platform administrator approves certificate authority changes.', { step: 'permission' });
    const p = await this.proposal(id);
    if (!p) throw new PkiError(404, 'Proposal not found.');
    if (p.state !== 'pending') throw new PkiError(409, `This proposal is ${p.state}.`);
    if (p.proposed_by && p.proposed_by === by.userId) throw new PkiError(403, 'Dual control: you cannot approve your own change. Another platform admin must approve it.', { step: 'dual-control' });
    this.stale(p.scope);
    const base = await this.row(p.scope);
    const current = { ...(base?.data ?? {}) };
    const next = { ...current };
    for (const [k, v] of Object.entries(p.changes)) if (v === null && BY_KEY.get(k)!.key !== 'root.pathLen') delete next[k];
    else next[k] = v;
    // The rules are checked again: other settings may have moved since it was proposed.
    await this.check(by.tenantId, p.scope === PLATFORM_SCOPE ? 'platform' : 'tenant', next, Object.keys(p.changes));
    const claimed = await this.db('pki_settings_proposals').where({ id, state: 'pending' }).update({ state: 'applied', decided_by: by.userId, decided_at: Date.now(), note });
    if (!claimed) throw new PkiError(409, 'This proposal was decided by someone else.');
    await this.write(p.scope, next, base, by);
    this.changedNow(p.scope);
    await this.audit(by, 'pki.settings.approved', { scope: p.scope, proposal: id }, { changes: p.changes, proposedBy: p.proposed_by, note, appliesAt: 'next rotation or re-issue' });
    return { ...p, state: 'applied', decided_by: by.userId, decided_at: Date.now(), note };
  }

  /** Rejects a proposal; its proposer withdraws it instead. */
  async reject(by: PkiActor, id: string, note: string | null, platformAdmin: boolean): Promise<ProposalRow> {
    await this.requireTable();
    const p = await this.proposal(id);
    if (!p) throw new PkiError(404, 'Proposal not found.');
    if (p.state !== 'pending') throw new PkiError(409, `This proposal is ${p.state}.`);
    const own = !!p.proposed_by && p.proposed_by === by.userId;
    if (!own && !platformAdmin) throw new PkiError(403, 'Only a platform administrator rejects certificate authority changes.', { step: 'permission' });
    const state = own ? 'withdrawn' : 'rejected';
    const n = await this.db('pki_settings_proposals').where({ id, state: 'pending' }).update({ state, decided_by: by.userId, decided_at: Date.now(), note });
    if (!n) throw new PkiError(409, 'This proposal was decided by someone else.');
    await this.audit(by, own ? 'pki.settings.withdrawn' : 'pki.settings.rejected', { scope: p.scope, proposal: id }, { changes: p.changes, proposedBy: p.proposed_by, note });
    return { ...p, state, decided_by: by.userId, decided_at: Date.now(), note };
  }
}
