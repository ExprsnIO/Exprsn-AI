import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { AuditActor } from '../../audit/chain.js';
import { isUniqueViolation } from '../../audit/chain.js';
import { hmac } from '../../crypto/index.js';
import { json } from '../../db/knex.js';
import type { UserRow } from '../../repos/users.js';
import type { Services } from '../../services.js';
import type { Curve } from '../crypto.js';
import { didDocument, didWebFor, plcDidForGenesis, plcOperationCid, signPlcOperation, type DidDocument, type PlcOperation } from '../did.js';
import { normaliseHandle, HandleError } from '../handles.js';
import { AtCustodyError, type AtKeyRef } from '../keys.js';
import { PdsBlobs } from './blobs.js';
import { PdsFeeds } from './feeds.js';
import { PdsMigration } from './migration.js';
import { RepoStore } from './repo-store.js';
import { sequence, SEQ_TOPIC, type SeqInput } from './sequencer.js';
import { newJti, PdsTokens, signServiceJwt, TokenError, type AccessScope } from './tokens.js';

/*
 * The AT-Protocol personal data server (B-2901 to B-2906): accounts tied to Exprsn-AI identities.
 *
 * Hosting. Off for every tenant until a platform admin enables it (the owner decision of 2026-10-05), in the PDS zone
 * (PDS_ZONE), which must have egress to the network: repositories are public by protocol, so a deployment or zone that
 * cannot publish refuses hosting. Everything the PDS stores is labelled `public`; nothing from the rest of Exprsn-AI
 * flows into a repo except what the account writes itself (and B-3004's generator metadata, given by an admin).
 *
 * Accounts. One per Exprsn-AI user. A new account gets a did:plc whose genesis operation names the account's repo
 * signing key (`#atproto`), its handle and this PDS (`#atproto_pds`), signed by a rotation key; both keys are made and
 * used in the signer or OpenBao transit (`keys.ts`), never here. Handles are `<name>.<tenant>.<PDS_HANDLE_DOMAIN>`,
 * resolved over HTTPS (`/.well-known/atproto-did` on the handle's host, which wildcard DNS sends here) and by
 * `com.atproto.identity.resolveHandle`. A user creates their account from the console, or a new person signs up over
 * XRPC (`createAccount`), which goes through the tenant's sign-up policy (B-1801): an open policy creates the
 * Exprsn-AI account as self-registration does, and a closed or approval policy (or a tenant that requires them) needs
 * an invite code, which an admin with `pds:manage` issued and which stands in for the approval.
 *
 * Sessions. Bluesky clients sign in with an app password made in the console (`createSession`); the Exprsn-AI
 * password never works over XRPC, so a second factor cannot be bypassed. `createAccount` returns a session directly.
 *
 * State. `active`, `deactivated` (by the account, an admin, or until a migration in is activated) or `takendown`
 * (through moderation, B-19: the repo answers `RepoTakendown`, its blobs are not served, sessions are revoked, and the
 * tenant's labeler publishes `!takedown` on the DID, B-1610). Each change is an `#account` event on the firehose.
 */

export class XrpcError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

export type AccountState = 'active' | 'deactivated' | 'takendown';

export interface PdsTenantRow {
  tenant_id: string;
  enabled: boolean;
  zone: string;
  handle_domain: string;
  invite_required: boolean;
  blob_max_bytes: number | null;
  blob_types: string[] | null;
  enabled_by: string | null;
  enabled_at: number | null;
  disabled_at: number | null;
  updated_by: string | null;
  updated_at: number;
}

export interface PdsAccountRow {
  id: string;
  tenant_id: string;
  user_id: string;
  did: string;
  handle: string;
  state: AccountState;
  state_reason: string | null;
  takedown_ref: string | null;
  migrating: boolean;
  did_method: 'plc' | 'web';
  key_curve: Curve;
  key_custody: 'signer' | 'openbao';
  key_name: string;
  key_wrapped: string | null;
  key_multikey: string;
  rot_curve: Curve | null;
  rot_custody: 'signer' | 'openbao' | null;
  rot_key_name: string | null;
  rot_key_wrapped: string | null;
  rot_multikey: string | null;
  plc_op: PlcOperation | null;
  plc_prev: string | null;
  commit_cid: string | null;
  rev: string | null;
  data_cid: string | null;
  email: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deactivated_at: number | null;
  takendown_at: number | null;
}

export interface InviteRow {
  id: string;
  tenant_id: string;
  hint: string;
  uses_max: number;
  uses: number;
  note: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  disabled_at: number | null;
}

export interface AppPasswordRow {
  id: string;
  account_id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  privileged: boolean;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** Who acts: a person through the API or XRPC, or the system. */
export interface PdsActor {
  tenantId: string;
  userId: string | null;
  actor: AuditActor;
  traceId?: string | null;
}

/** An authenticated XRPC caller. */
export interface PdsAuth {
  account: PdsAccountRow;
  user: UserRow;
  scope: AccessScope;
  sessionId: string;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export const tenantFrom = (r: Record<string, unknown>): PdsTenantRow => ({
  ...(r as unknown as PdsTenantRow),
  enabled: bool(r.enabled),
  invite_required: bool(r.invite_required),
  blob_max_bytes: numOrNull(r.blob_max_bytes),
  blob_types: json<string[] | null>(r.blob_types, null),
  enabled_at: numOrNull(r.enabled_at),
  disabled_at: numOrNull(r.disabled_at),
  updated_at: num(r.updated_at)
});

export const accountFrom = (r: Record<string, unknown>): PdsAccountRow => ({
  ...(r as unknown as PdsAccountRow),
  migrating: bool(r.migrating),
  plc_op: json<PlcOperation | null>(r.plc_op, null),
  created_at: num(r.created_at),
  updated_at: num(r.updated_at),
  deactivated_at: numOrNull(r.deactivated_at),
  takendown_at: numOrNull(r.takendown_at)
});

const inviteFrom = (r: Record<string, unknown>): InviteRow => ({ ...(r as unknown as InviteRow), uses_max: num(r.uses_max), uses: num(r.uses), created_at: num(r.created_at), expires_at: numOrNull(r.expires_at), disabled_at: numOrNull(r.disabled_at) });
const appPasswordFrom = (r: Record<string, unknown>): AppPasswordRow => ({ ...(r as unknown as AppPasswordRow), privileged: bool(r.privileged), created_at: num(r.created_at), last_used_at: numOrNull(r.last_used_at), revoked_at: numOrNull(r.revoked_at) });

export const signingRef = (a: PdsAccountRow): AtKeyRef => ({ custody: a.key_custody, keyName: a.key_name, wrapped: a.key_wrapped, curve: a.key_curve });
export const rotationRef = (a: PdsAccountRow): AtKeyRef | null => (a.rot_key_name && a.rot_custody && a.rot_curve ? { custody: a.rot_custody, keyName: a.rot_key_name, wrapped: a.rot_key_wrapped, curve: a.rot_curve } : null);

/** Names a handle may not take (they would read as the service's own). */
const RESERVED = new Set(['admin', 'administrator', 'abuse', 'about', 'api', 'app', 'atproto', 'bsky', 'did', 'help', 'mail', 'mod', 'moderator', 'pds', 'plc', 'postmaster', 'relay', 'root', 'security', 'staff', 'support', 'system', 'www', 'xrpc']);
const NAME_RE = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$/;
const APP_PASSWORD_RE = /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/;
const INVITE_RE = /^[a-z0-9-]{10,80}$/;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

const randomBase32 = (n: number): string => [...randomBytes(n)].map((b) => B32[b & 31]).join('');

export const accountView = (a: PdsAccountRow, extra: { username?: string | null; records?: number } = {}) => ({
  id: a.id,
  did: a.did,
  handle: a.handle,
  state: a.state,
  stateReason: a.state_reason,
  takedownAction: a.takedown_ref,
  migrating: a.migrating,
  userId: a.user_id,
  ...(extra.username !== undefined ? { username: extra.username } : {}),
  email: a.email,
  didMethod: a.did_method,
  signingKey: `did:key:${a.key_multikey}`,
  rotationKey: a.rot_multikey ? `did:key:${a.rot_multikey}` : null,
  custody: a.key_custody,
  curve: a.key_curve,
  rev: a.rev,
  commit: a.commit_cid,
  ...(extra.records !== undefined ? { records: extra.records } : {}),
  createdAt: a.created_at,
  updatedAt: a.updated_at,
  deactivatedAt: a.deactivated_at,
  takendownAt: a.takendown_at
});

export const hostingView = (t: PdsTenantRow | undefined, platform: { maxBlobBytes: number; blobTypes: string[] }) => ({
  enabled: !!t?.enabled,
  zone: t?.zone ?? null,
  handleDomain: t?.handle_domain ?? null,
  inviteRequired: t?.invite_required ?? false,
  blobMaxBytes: t?.blob_max_bytes ?? platform.maxBlobBytes,
  blobTypes: t?.blob_types ?? platform.blobTypes,
  enabledBy: t?.enabled_by ?? null,
  enabledAt: t?.enabled_at ?? null,
  updatedAt: t?.updated_at ?? null
});

export const inviteView = (i: InviteRow) => ({ id: i.id, hint: i.hint, usesMax: i.uses_max, uses: i.uses, note: i.note, createdBy: i.created_by, createdAt: i.created_at, expiresAt: i.expires_at, disabledAt: i.disabled_at, state: i.disabled_at ? 'disabled' : i.expires_at && i.expires_at <= Date.now() ? 'expired' : i.uses >= i.uses_max ? 'used' : 'active' });

export const appPasswordView = (r: AppPasswordRow) => ({ id: r.id, name: r.name, privileged: r.privileged, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, state: r.revoked_at ? 'revoked' : 'active' });

export class PdsService {
  private tokenKeys: PdsTokens | null = null;
  readonly repo: RepoStore;
  readonly blobs: PdsBlobs;
  readonly migration: PdsMigration;
  readonly feeds: PdsFeeds;

  constructor(private readonly s: () => Services) {
    this.repo = new RepoStore(this, s);
    this.blobs = new PdsBlobs(this, s);
    this.migration = new PdsMigration(this, s);
    this.feeds = new PdsFeeds(this, s);
  }

  private get db() {
    return this.s().db;
  }

  get tokens(): PdsTokens {
    return (this.tokenKeys ??= new PdsTokens(this.s().cfg.SESSION_SECRET));
  }

  // ---------- the service ----------

  /** The PDS's public base URL (its accounts' `#atproto_pds` endpoint). */
  publicUrl(): string {
    const cfg = this.s().cfg;
    return new URL(cfg.PDS_PUBLIC_URL ?? cfg.ATPROTO_PUBLIC_URL ?? cfg.PUBLIC_URL).origin;
  }

  /** The host a relay crawls (with the port when there is one). */
  host(): string {
    return new URL(this.publicUrl()).host;
  }

  /** The PDS's own DID, the audience of its tokens and of inter-service tokens sent to it. */
  serviceDid(): string {
    return didWebFor(new URL(this.publicUrl()));
  }

  handleDomain(): string {
    return (this.s().cfg.PDS_HANDLE_DOMAIN ?? new URL(this.publicUrl()).hostname).toLowerCase();
  }

  private production(): boolean {
    return this.s().cfg.NODE_ENV === 'production';
  }

  async audit(by: PdsActor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId: by.tenantId, action, kind: by.userId ? 'admin' : 'system', actor: by.actor, target, label: 'public', ...(detail ? { detail } : {}), traceId: by.traceId ?? null });
  }

  /** Tells every instance's subscribeRepos streams that events were sequenced, and asks relays to crawl (throttled). */
  announce(): void {
    this.s().bus.publish(SEQ_TOPIC, { at: Date.now() });
    void this.crawlSoon().catch((err: unknown) => this.s().log.warn({ err }, 'pds: scheduling requestCrawl failed'));
  }

  // ---------- hosting (per tenant) ----------

  async hosting(tenantId: string): Promise<PdsTenantRow | undefined> {
    const r = (await this.db('pds_tenants').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    return r ? tenantFrom(r) : undefined;
  }

  async enabledHostings(): Promise<PdsTenantRow[]> {
    return ((await this.db('pds_tenants').where({ enabled: true })) as Record<string, unknown>[]).map(tenantFrom);
  }

  /** The tenant whose handle domain a handle is directly under (`<name>.<domain>`), when it hosts accounts. */
  async hostingForHandle(handle: string): Promise<{ hosting: PdsTenantRow; name: string } | undefined> {
    const dot = handle.indexOf('.');
    if (dot < 1) return undefined;
    const r = (await this.db('pds_tenants').where({ handle_domain: handle.slice(dot + 1), enabled: true }).first()) as Record<string, unknown> | undefined;
    return r ? { hosting: tenantFrom(r), name: handle.slice(0, dot) } : undefined;
  }

  limits(t: PdsTenantRow | undefined): { maxBytes: number; types: string[] } {
    const cfg = this.s().cfg;
    return { maxBytes: Math.min(t?.blob_max_bytes ?? cfg.PDS_BLOB_MAX_BYTES, cfg.PDS_BLOB_MAX_BYTES), types: t?.blob_types ?? cfg.PDS_BLOB_TYPES };
  }

  /** Why hosting cannot run in a zone, or null when it can (repositories are public: the zone must reach the network). */
  async zoneProblem(zone: string): Promise<string | null> {
    const z = await this.s().moderation.zoneHasEgress(zone);
    return z.ok ? null : `A PDS publishes public repositories to relays and the PLC directory, so it runs only in a zone with egress to the network. ${z.why ?? ''}`.trim();
  }

  /** A platform admin turns hosting on for a tenant (B-2901). */
  async enable(by: PdsActor, tenantId: string, o: { zone?: string | undefined } = {}): Promise<PdsTenantRow> {
    const tenant = await this.s().tenants.byId(tenantId);
    if (!tenant || tenant.state !== 'active') throw new XrpcError(404, 'NotFound', 'No such active tenant.');
    const zone = o.zone ?? this.s().cfg.PDS_ZONE;
    const problem = await this.zoneProblem(zone);
    if (problem) throw new XrpcError(409, 'ZoneRefused', problem);
    if (!this.s().atproto.keys.custody()) throw new XrpcError(409, 'Custody', 'Account keys need the signer (SIGNER_SOCKET) or OpenBao transit (KMS_PROVIDER=openbao); this process never holds a private key.');
    const existing = await this.hosting(tenantId);
    const label = tenant.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || tenant.id.toLowerCase();
    const domain = existing?.handle_domain ?? `${label}.${this.handleDomain()}`;
    try {
      normaliseHandle(`check.${domain}`, { production: this.production() });
    } catch (err) {
      throw new XrpcError(409, 'HandleDomain', `Handles would live under ${domain}, which is not a usable domain (${(err as Error).message}) Set PDS_HANDLE_DOMAIN to the domain whose wildcard DNS points here.`);
    }
    const now = Date.now();
    if (existing) await this.db('pds_tenants').where({ tenant_id: tenantId }).update({ enabled: true, zone, enabled_by: by.userId, enabled_at: now, disabled_at: null, updated_by: by.userId, updated_at: now });
    else {
      try {
        await this.db('pds_tenants').insert({ tenant_id: tenantId, enabled: true, zone, handle_domain: domain, invite_required: false, blob_max_bytes: null, blob_types: null, enabled_by: by.userId, enabled_at: now, disabled_at: null, updated_by: by.userId, updated_at: now });
      } catch (err) {
        if (isUniqueViolation(err)) throw new XrpcError(409, 'HandleDomain', `Another tenant already has the handle domain ${domain}.`);
        throw err;
      }
    }
    await this.s().audit.append({ tenantId, action: 'pds.hosting.enabled', kind: 'admin', actor: by.actor, target: { tenant: tenantId }, label: 'internal', detail: { zone, handleDomain: domain }, traceId: by.traceId ?? null });
    return (await this.hosting(tenantId))!;
  }

  /** Turns hosting off; refused while the tenant still has active accounts (they deactivate or migrate first). */
  async disable(by: PdsActor, tenantId: string): Promise<PdsTenantRow> {
    const h = await this.hosting(tenantId);
    if (!h?.enabled) throw new XrpcError(409, 'NotEnabled', 'Hosting is not enabled for this tenant.');
    const active = Number(((await this.db('pds_accounts').where({ tenant_id: tenantId, state: 'active' }).count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
    if (active) throw new XrpcError(409, 'AccountsActive', `The tenant still hosts ${active} active account${active === 1 ? '' : 's'}; deactivate or migrate them first.`);
    const now = Date.now();
    await this.db('pds_tenants').where({ tenant_id: tenantId }).update({ enabled: false, disabled_at: now, updated_by: by.userId, updated_at: now });
    await this.s().audit.append({ tenantId, action: 'pds.hosting.disabled', kind: 'admin', actor: by.actor, target: { tenant: tenantId }, label: 'internal', traceId: by.traceId ?? null });
    return (await this.hosting(tenantId))!;
  }

  /** A tenant admin's settings: blob limits within the platform's, and invite codes even under an open sign-up policy. */
  async updateSettings(by: PdsActor, tenantId: string, patch: { inviteRequired?: boolean | undefined; blobMaxBytes?: number | null | undefined; blobTypes?: string[] | null | undefined }): Promise<PdsTenantRow> {
    const h = await this.hosting(tenantId);
    if (!h?.enabled) throw new XrpcError(409, 'NotEnabled', 'Hosting is not enabled for this tenant; a platform admin enables it.');
    const cfg = this.s().cfg;
    if (patch.blobMaxBytes != null && patch.blobMaxBytes > cfg.PDS_BLOB_MAX_BYTES) throw new XrpcError(400, 'InvalidRequest', `The platform's blob limit is ${cfg.PDS_BLOB_MAX_BYTES} bytes.`);
    if (patch.blobTypes) {
      const outside = patch.blobTypes.filter((t) => !cfg.PDS_BLOB_TYPES.includes(t));
      if (outside.length) throw new XrpcError(400, 'InvalidRequest', `Blob types outside the platform's list (${cfg.PDS_BLOB_TYPES.join(', ')}): ${outside.join(', ')}.`);
    }
    const row: Record<string, unknown> = { updated_by: by.userId, updated_at: Date.now() };
    if (patch.inviteRequired !== undefined) row.invite_required = patch.inviteRequired;
    if (patch.blobMaxBytes !== undefined) row.blob_max_bytes = patch.blobMaxBytes;
    if (patch.blobTypes !== undefined) row.blob_types = patch.blobTypes ? JSON.stringify(patch.blobTypes) : null;
    await this.db('pds_tenants').where({ tenant_id: tenantId }).update(row);
    await this.s().audit.append({ tenantId, action: 'pds.settings.updated', kind: 'admin', actor: by.actor, target: { tenant: tenantId }, label: 'internal', detail: { ...patch }, traceId: by.traceId ?? null });
    return (await this.hosting(tenantId))!;
  }

  // ---------- accounts ----------

  async accountById(id: string): Promise<PdsAccountRow | undefined> {
    const r = (await this.db('pds_accounts').where({ id }).first()) as Record<string, unknown> | undefined;
    return r ? accountFrom(r) : undefined;
  }

  async accountByDid(did: string): Promise<PdsAccountRow | undefined> {
    const r = (await this.db('pds_accounts').where({ did }).first()) as Record<string, unknown> | undefined;
    return r ? accountFrom(r) : undefined;
  }

  async accountByHandle(handle: string): Promise<PdsAccountRow | undefined> {
    const r = (await this.db('pds_accounts').where({ handle: handle.toLowerCase() }).first()) as Record<string, unknown> | undefined;
    return r ? accountFrom(r) : undefined;
  }

  async accountByUser(userId: string): Promise<PdsAccountRow | undefined> {
    const r = (await this.db('pds_accounts').where({ user_id: userId }).first()) as Record<string, unknown> | undefined;
    return r ? accountFrom(r) : undefined;
  }

  /** An account by DID or handle (`repo` parameters take either). */
  async accountByIdentifier(id: string): Promise<PdsAccountRow | undefined> {
    if (!id || id.length > 300) return undefined;
    return id.startsWith('did:') ? this.accountByDid(id) : this.accountByHandle(id);
  }

  async accounts(tenantId: string, o: { state?: AccountState | undefined; q?: string | undefined; limit: number; before?: number | null | undefined }): Promise<PdsAccountRow[]> {
    const q = this.db('pds_accounts').where({ tenant_id: tenantId }).orderBy('created_at', 'desc').limit(o.limit);
    if (o.state) q.andWhere({ state: o.state });
    if (o.q) q.andWhere((w) => w.where('handle', 'like', `%${o.q!.toLowerCase().replace(/[%_\\]/g, '')}%`).orWhere({ did: o.q }));
    if (o.before) q.andWhere('created_at', '<', o.before);
    return ((await q) as Record<string, unknown>[]).map(accountFrom);
  }

  async recordCount(accountId: string): Promise<number> {
    return Number(((await this.db('pds_records').where({ account_id: accountId }).count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
  }

  /** The account's DID document: from its last PLC operation, or built from what this PDS knows. */
  async didDoc(a: PdsAccountRow): Promise<DidDocument> {
    if (a.plc_op) return didDocument(a.did, a.plc_op);
    return didDocument(a.did, { alsoKnownAs: [`at://${a.handle}`], verificationMethods: { atproto: `did:key:${a.key_multikey}` }, services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: this.publicUrl() } } });
  }

  /** Checks a handle for a tenant: syntax, the tenant's domain, reserved names, and that nobody has it. */
  async checkHandle(input: string, hosting: PdsTenantRow, except?: string): Promise<string> {
    let handle: string;
    try {
      handle = normaliseHandle(input.includes('.') ? input : `${input}.${hosting.handle_domain}`, { production: this.production() });
    } catch (err) {
      throw new XrpcError(400, 'InvalidHandle', err instanceof HandleError ? err.message : 'Not a valid handle.');
    }
    const suffix = `.${hosting.handle_domain}`;
    const name = handle.endsWith(suffix) ? handle.slice(0, -suffix.length) : null;
    if (!name || name.includes('.')) throw new XrpcError(400, 'UnsupportedDomain', `Handles here end in ${suffix} (one name before it); your own domain comes in a later release.`);
    if (!NAME_RE.test(name)) throw new XrpcError(400, 'InvalidHandle', 'The name before the domain is 3 to 30 letters, digits and hyphens, not starting or ending with a hyphen.');
    if (RESERVED.has(name)) throw new XrpcError(400, 'HandleNotAvailable', `${name} is reserved.`);
    const taken = await this.accountByHandle(handle);
    if (taken && taken.id !== except) throw new XrpcError(400, 'HandleNotAvailable', 'Handle already taken.');
    if (await this.s().atproto.identityByHandle(handle)) throw new XrpcError(400, 'HandleNotAvailable', 'Handle already taken.');
    return handle;
  }

  /** Makes a key in the signer or OpenBao for an account (the curve the custody allows; secp256k1 where it can). */
  private async makeKey(id: string, curve?: Curve) {
    const keys = this.s().atproto.keys;
    const c = curve ?? keys.defaultCurve();
    if (!keys.curves().includes(c)) throw new XrpcError(409, 'Custody', keys.custody() ? 'OpenBao transit has no secp256k1 keys; choose P-256.' : 'Account keys need the signer (SIGNER_SOCKET) or OpenBao transit (KMS_PROVIDER=openbao).');
    try {
      return await keys.create(id, c);
    } catch (err) {
      if (err instanceof AtCustodyError) throw new XrpcError(409, 'Custody', err.message);
      throw err;
    }
  }

  async sign(ref: AtKeyRef, bytes: Buffer): Promise<Buffer> {
    return this.s().atproto.keys.sign(ref, bytes);
  }

  async submitPlc(did: string, op: PlcOperation): Promise<void> {
    const url = `${this.s().cfg.ATPROTO_PLC_URL.replace(/\/$/, '')}/${did}`;
    let r: { status: number; text: string };
    try {
      r = await this.s().atproto.http.request(url, { method: 'POST', body: op });
    } catch (err) {
      throw new XrpcError(502, 'UpstreamFailure', `The PLC directory could not be reached: ${(err as Error).message}`);
    }
    if (r.status < 200 || r.status >= 300) throw new XrpcError(502, 'UpstreamFailure', `The PLC directory refused the operation (${r.status}): ${r.text.slice(0, 200)}`);
  }

  /**
   * Creates the PDS account of an Exprsn-AI user (B-2901): keys, the did:plc (or, for a migration in, the DID the
   * account brings), the first commit of an empty repo, and the identity, account, commit and sync events.
   */
  async createAccount(by: PdsActor, o: { user: UserRow; handle: string; hosting: PdsTenantRow; did?: string | null; inviteId?: string | null; via: 'console' | 'xrpc' | 'migration' }): Promise<PdsAccountRow> {
    const { user, hosting } = o;
    if (!hosting.enabled) throw new XrpcError(400, 'InvalidRequest', 'This tenant does not host AT-Protocol accounts.');
    if (user.tenant_id !== hosting.tenant_id) throw new Error('The user is in another tenant');
    if (await this.accountByUser(user.id)) throw new XrpcError(409, 'AccountExists', 'This person already has an account here.');
    const handle = await this.checkHandle(o.handle, hosting);
    if (o.did && (await this.accountByDid(o.did))) throw new XrpcError(400, 'AlreadyExists', 'This DID already has an account here.');
    const id = ulid();
    const signing = await this.makeKey(`${id}-repo`);
    const rotation = await this.makeKey(`${id}-rotation`);
    let did: string;
    let plcOp: PlcOperation | null = null;
    let plcPrev: string | null = null;
    if (o.did) did = o.did;
    else {
      const op: PlcOperation = { type: 'plc_operation', rotationKeys: [rotation.didKey], verificationMethods: { atproto: signing.didKey }, alsoKnownAs: [`at://${handle}`], services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: this.publicUrl() } }, prev: null };
      plcOp = await signPlcOperation(op, (bytes) => this.sign(rotation.ref, bytes));
      did = plcDidForGenesis(plcOp);
      await this.submitPlc(did, plcOp);
      plcPrev = plcOperationCid(plcOp);
    }
    const now = Date.now();
    const migrating = !!o.did;
    const row: PdsAccountRow = {
      id,
      tenant_id: hosting.tenant_id,
      user_id: user.id,
      did,
      handle,
      state: migrating ? 'deactivated' : 'active',
      state_reason: migrating ? 'Migrating in: activate once the repo, blobs and DID are moved' : null,
      takedown_ref: null,
      migrating,
      did_method: did.startsWith('did:web:') ? 'web' : 'plc',
      key_curve: signing.ref.curve,
      key_custody: signing.ref.custody,
      key_name: signing.ref.keyName,
      key_wrapped: signing.ref.wrapped,
      key_multikey: signing.multikey,
      rot_curve: rotation.ref.curve,
      rot_custody: rotation.ref.custody,
      rot_key_name: rotation.ref.keyName,
      rot_key_wrapped: rotation.ref.wrapped,
      rot_multikey: rotation.multikey,
      plc_op: plcOp,
      plc_prev: plcPrev,
      commit_cid: null,
      rev: null,
      data_cid: null,
      email: user.email,
      created_by: by.userId,
      created_at: now,
      updated_at: now,
      deactivated_at: migrating ? now : null,
      takendown_at: null
    };
    const first = await this.repo.initialCommit(row);
    try {
      await this.db.transaction(async (trx) => {
        await trx('pds_accounts').insert({ ...row, plc_op: plcOp ? JSON.stringify(plcOp) : null, commit_cid: first.commitCid, rev: first.rev, data_cid: first.dataCid });
        await trx('pds_blocks').insert(first.blocks.map((b) => ({ account_id: id, cid: b.cid, kind: b.kind, size: b.bytes.length, data: b.bytes.toString('base64'), rev: first.rev })));
        if (o.inviteId) {
          const used = await trx('pds_invites').where({ id: o.inviteId }).whereNull('disabled_at').andWhere('uses', '<', trx.ref('uses_max')).increment('uses', 1);
          if (!used) throw new XrpcError(400, 'InvalidInviteCode', 'The invite code has been used up.');
          await trx('pds_invite_uses').insert({ invite_id: o.inviteId, account_id: id, used_at: now });
        }
        const events: SeqInput[] = [{ did, type: 'identity', body: { did, handle } }, { did, type: 'account', body: migrating ? { did, active: false, status: 'deactivated' } : { did, active: true } }];
        if (!migrating) events.push(...first.events);
        await sequence(trx, events);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new XrpcError(400, 'HandleNotAvailable', 'Handle or DID already taken.');
      throw err;
    }
    this.announce();
    await this.audit(by, 'pds.account.created', { account: id, did, user: user.id }, { handle, via: o.via, curve: row.key_curve, custody: row.key_custody, ...(plcPrev ? { plcCid: plcPrev } : {}), ...(o.inviteId ? { invite: o.inviteId } : {}), migrating });
    return (await this.accountById(id))!;
  }

  // ---------- invite codes (B-1801 policy) ----------

  private inviteHash(code: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, 'pds-invite:' + code.trim().toLowerCase());
  }

  async createInvite(by: PdsActor, tenantId: string, o: { usesMax: number; expiresInDays?: number | null | undefined; note?: string | null | undefined }): Promise<{ code: string; invite: InviteRow }> {
    const h = await this.hosting(tenantId);
    if (!h?.enabled) throw new XrpcError(409, 'NotEnabled', 'Hosting is not enabled for this tenant.');
    const code = `${h.handle_domain.split('.')[0]!.slice(0, 20)}-${randomBase32(5)}-${randomBase32(5)}-${randomBase32(5)}`;
    const now = Date.now();
    const row = { id: ulid(), tenant_id: tenantId, code_hash: this.inviteHash(code), hint: code.slice(-5), uses_max: o.usesMax, uses: 0, note: o.note ?? null, created_by: by.userId, created_at: now, expires_at: o.expiresInDays ? now + o.expiresInDays * 86_400_000 : null, disabled_at: null };
    await this.db('pds_invites').insert(row);
    await this.audit(by, 'pds.invite.created', { invite: row.id }, { usesMax: o.usesMax, expiresAt: row.expires_at, hint: row.hint });
    return { code, invite: inviteFrom(row) };
  }

  async invites(tenantId: string): Promise<InviteRow[]> {
    return ((await this.db('pds_invites').where({ tenant_id: tenantId }).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(inviteFrom);
  }

  async disableInvite(by: PdsActor, tenantId: string, id: string): Promise<boolean> {
    const n = await this.db('pds_invites').where({ tenant_id: tenantId, id }).whereNull('disabled_at').update({ disabled_at: Date.now() });
    if (n) await this.audit(by, 'pds.invite.disabled', { invite: id });
    return n > 0;
  }

  /** The usable invite a code names for the tenant, or null. */
  async findInvite(tenantId: string, code: string): Promise<InviteRow | null> {
    if (!INVITE_RE.test(code.trim().toLowerCase())) return null;
    const r = (await this.db('pds_invites').where({ tenant_id: tenantId, code_hash: this.inviteHash(code) }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    const i = inviteFrom(r);
    if (i.disabled_at || (i.expires_at && i.expires_at <= Date.now()) || i.uses >= i.uses_max) return null;
    return i;
  }

  // ---------- app passwords and sessions ----------

  private appPasswordHash(password: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, 'pds-app-password:' + password);
  }

  async createAppPassword(by: PdsActor, a: PdsAccountRow, o: { name: string; privileged: boolean }): Promise<{ password: string; row: AppPasswordRow }> {
    const live = Number(((await this.db('pds_app_passwords').where({ account_id: a.id }).whereNull('revoked_at').count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
    if (live >= 50) throw new XrpcError(409, 'TooManyAppPasswords', 'This account has 50 app passwords; revoke one first.');
    if ((await this.db('pds_app_passwords').where({ account_id: a.id, name: o.name }).whereNull('revoked_at').first())) throw new XrpcError(409, 'DuplicateName', 'An app password with this name exists.');
    const password = [0, 1, 2, 3].map(() => randomBase32(4)).join('-');
    const row = { id: ulid(), account_id: a.id, tenant_id: a.tenant_id, user_id: a.user_id, name: o.name, secret_hash: this.appPasswordHash(password), privileged: o.privileged, created_at: Date.now(), last_used_at: null, revoked_at: null };
    await this.db('pds_app_passwords').insert(row);
    await this.audit(by, 'pds.app_password.created', { account: a.id, did: a.did, appPassword: row.id }, { name: o.name, privileged: o.privileged });
    return { password, row: appPasswordFrom(row) };
  }

  async appPasswords(accountId: string): Promise<AppPasswordRow[]> {
    return ((await this.db('pds_app_passwords').where({ account_id: accountId }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(appPasswordFrom);
  }

  async revokeAppPassword(by: PdsActor, a: PdsAccountRow, id: string): Promise<boolean> {
    const now = Date.now();
    const n = await this.db('pds_app_passwords').where({ account_id: a.id, id }).whereNull('revoked_at').update({ revoked_at: now });
    if (!n) return false;
    await this.db('pds_sessions').where({ account_id: a.id, app_password_id: id }).whereNull('revoked_at').update({ revoked_at: now });
    await this.audit(by, 'pds.app_password.revoked', { account: a.id, did: a.did, appPassword: id });
    return true;
  }

  /** Checks a presented app password for an account; null when it is not one of the account's live ones. */
  async checkAppPassword(a: PdsAccountRow, password: string): Promise<AppPasswordRow | null> {
    if (!APP_PASSWORD_RE.test(password)) return null;
    const r = (await this.db('pds_app_passwords').where({ secret_hash: this.appPasswordHash(password) }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    const row = appPasswordFrom(r);
    if (row.account_id !== a.id || row.revoked_at) return null;
    if (!row.last_used_at || Date.now() - row.last_used_at > 60_000) await this.db('pds_app_passwords').where({ id: row.id }).update({ last_used_at: Date.now() });
    return row;
  }

  /** A new session: a refresh token tracked by its jti, and an access token bound to the same session. */
  async issueSession(a: PdsAccountRow, o: { appPasswordId: string | null; scope: AccessScope; ip: string | null }): Promise<{ accessJwt: string; refreshJwt: string; sessionId: string }> {
    const cfg = this.s().cfg;
    const jti = newJti();
    const now = Date.now();
    await this.db('pds_sessions').insert({ id: jti, account_id: a.id, app_password_id: o.appPasswordId, scope: o.scope, created_at: now, expires_at: now + cfg.PDS_REFRESH_DAYS * 86_400_000, used_at: null, revoked_at: null, ip: o.ip?.slice(0, 64) ?? null });
    return {
      accessJwt: this.tokens.access({ did: a.did, aud: this.serviceDid(), scope: o.scope, ttlS: cfg.PDS_ACCESS_MINUTES * 60, jti }),
      refreshJwt: this.tokens.refresh({ did: a.did, aud: this.serviceDid(), jti, ttlS: cfg.PDS_REFRESH_DAYS * 86_400 }),
      sessionId: jti
    };
  }

  /** Spends a refresh token once and issues the next pair. */
  async refresh(token: string, ip: string | null): Promise<{ account: PdsAccountRow; accessJwt: string; refreshJwt: string }> {
    let claims;
    try {
      claims = this.tokens.verify(token, { typ: 'refresh+jwt', aud: this.serviceDid() });
    } catch (err) {
      throw new XrpcError(400, err instanceof TokenError ? err.code : 'InvalidToken', (err as Error).message);
    }
    const r = (await this.db('pds_sessions').where({ id: claims.jti }).first()) as Record<string, unknown> | undefined;
    if (!r || r.revoked_at != null || Number(r.expires_at) <= Date.now()) throw new XrpcError(400, 'ExpiredToken', 'Token has been revoked');
    const a = await this.accountByDid(claims.sub);
    if (!a || a.id !== r.account_id) throw new XrpcError(400, 'InvalidToken', 'Token could not be verified');
    if (a.state === 'takendown') throw new XrpcError(400, 'AccountTakedown', 'Account has been taken down');
    if (r.app_password_id && !(await this.db('pds_app_passwords').where({ id: r.app_password_id }).whereNull('revoked_at').first())) throw new XrpcError(400, 'ExpiredToken', 'Token has been revoked');
    // Spent at most once: of two refreshes racing with the same token, one wins.
    const spent = await this.db('pds_sessions').where({ id: claims.jti }).whereNull('used_at').whereNull('revoked_at').update({ used_at: Date.now() });
    if (!spent) throw new XrpcError(400, 'ExpiredToken', 'Token has been revoked');
    const next = await this.issueSession(a, { appPasswordId: (r.app_password_id as string | null) ?? null, scope: r.scope as AccessScope, ip });
    return { account: a, accessJwt: next.accessJwt, refreshJwt: next.refreshJwt };
  }

  async endSession(token: string): Promise<void> {
    let claims;
    try {
      claims = this.tokens.verify(token, { typ: 'refresh+jwt', aud: this.serviceDid() });
    } catch (err) {
      throw new XrpcError(400, err instanceof TokenError ? err.code : 'InvalidToken', (err as Error).message);
    }
    await this.db('pds_sessions').where({ id: claims.jti }).update({ revoked_at: Date.now() });
  }

  async revokeSessions(accountId: string): Promise<number> {
    return this.db('pds_sessions').where({ account_id: accountId }).whereNull('revoked_at').update({ revoked_at: Date.now() });
  }

  /** The caller of an XRPC request from its access token. Takedowns and revoked sessions apply at once. */
  async authenticate(header: string | undefined): Promise<PdsAuth> {
    const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!m) throw new XrpcError(401, 'AuthMissing', 'Authentication Required');
    let claims;
    try {
      claims = this.tokens.verify(m[1]!, { typ: 'at+jwt', aud: this.serviceDid() });
    } catch (err) {
      throw new XrpcError(400, err instanceof TokenError ? err.code : 'InvalidToken', (err as Error).message);
    }
    const a = await this.accountByDid(claims.sub);
    if (!a) throw new XrpcError(400, 'InvalidToken', 'Token could not be verified');
    if (a.state === 'takendown') throw new XrpcError(400, 'AccountTakedown', 'Account has been taken down');
    const sess = claims.jti ? ((await this.db('pds_sessions').where({ id: claims.jti }).first('account_id', 'revoked_at')) as { account_id: string; revoked_at: unknown } | undefined) : undefined;
    if (!sess || sess.account_id !== a.id || sess.revoked_at != null) throw new XrpcError(400, 'ExpiredToken', 'Token has been revoked');
    const user = await this.s().users.get(a.tenant_id, a.user_id);
    if (!user || user.state !== 'active') throw new XrpcError(401, 'AccountDisabled', 'The Exprsn-AI account behind this AT-Protocol account is disabled.');
    if (await this.s().moderation.blocking(a.tenant_id, a.user_id)) throw new XrpcError(401, 'AccountSuspended', 'The account is suspended.');
    return { account: a, user, scope: claims.scope as AccessScope, sessionId: claims.jti! };
  }

  /** The account a refresh or access token names, without its state checks (`deleteSession`, `getSession`). */
  async session(a: PdsAccountRow) {
    const policy = await this.s().identityPolicy.get(a.tenant_id);
    const user = await this.s().users.get(a.tenant_id, a.user_id);
    const unverified = user ? await this.s().signup.needsVerification(policy, user) : false;
    return {
      handle: a.handle,
      did: a.did,
      ...(a.email ? { email: a.email, emailConfirmed: !unverified } : {}),
      didDoc: await this.didDoc(a),
      active: a.state === 'active',
      ...(a.state !== 'active' ? { status: a.state } : {})
    };
  }

  // ---------- account state (B-2905) ----------

  private async setState(by: PdsActor, a: PdsAccountRow, state: AccountState, o: { reason?: string | null; takedownRef?: string | null; from?: AccountState[] }): Promise<PdsAccountRow | null> {
    const now = Date.now();
    const patch: Record<string, unknown> = { state, state_reason: o.reason?.slice(0, 500) ?? null, updated_at: now };
    if (state === 'deactivated') patch.deactivated_at = now;
    if (state === 'takendown') Object.assign(patch, { takendown_at: now, takedown_ref: o.takedownRef ?? null });
    if (state === 'active') Object.assign(patch, { deactivated_at: null, takendown_at: null, takedown_ref: null, migrating: false });
    let changed = 0;
    await this.db.transaction(async (trx) => {
      changed = await trx('pds_accounts').where({ id: a.id }).whereIn('state', o.from ?? [a.state]).update(patch);
      if (!changed) return;
      await sequence(trx, [{ did: a.did, type: 'account', body: state === 'active' ? { did: a.did, active: true } : { did: a.did, active: false, status: state } }]);
    });
    if (!changed) return null;
    if (state !== 'active') await this.revokeSessions(a.id);
    this.announce();
    void by;
    return (await this.accountById(a.id))!;
  }

  async deactivate(by: PdsActor, a: PdsAccountRow, reason: string | null): Promise<PdsAccountRow> {
    if (a.state === 'takendown') throw new XrpcError(400, 'AccountTakedown', 'Account has been taken down');
    if (a.state === 'deactivated') return a;
    const after = await this.setState(by, a, 'deactivated', { reason, from: ['active'] });
    if (!after) throw new XrpcError(409, 'Conflict', 'The account changed meanwhile; try again.');
    await this.audit(by, 'pds.account.deactivated', { account: a.id, did: a.did }, reason ? { reason: reason.slice(0, 500) } : undefined);
    return after;
  }

  async activate(by: PdsActor, a: PdsAccountRow): Promise<PdsAccountRow> {
    if (a.state === 'takendown') throw new XrpcError(400, 'AccountTakedown', 'Account has been taken down');
    if (a.state === 'active') return a;
    if (a.migrating) await this.migration.assertReady(a);
    const after = await this.setState(by, a, 'active', { from: ['deactivated'] });
    if (!after) throw new XrpcError(409, 'Conflict', 'The account changed meanwhile; try again.');
    // A repo that arrived by migration (or changed while inactive) is announced as it is now.
    if (a.migrating) await this.repo.sequenceSync(after);
    await this.audit(by, 'pds.account.activated', { account: a.id, did: a.did }, a.migrating ? { migratedIn: true } : undefined);
    return after;
  }

  /**
   * Takes a repo down (the moderation hide of a `pds-repo` object, B-1903): the repo answers RepoTakendown, blobs
   * stop being served, sessions end, and `!takedown` is published on the DID through the tenant's labeler.
   * Returns the state it had, or null when it could not be taken down (already down).
   */
  async takeDown(by: PdsActor, a: PdsAccountRow, reason: string, actionRef: string | null): Promise<AccountState | null> {
    if (a.state === 'takendown') return null;
    const after = await this.setState(by, a, 'takendown', { reason, takedownRef: actionRef, from: ['active', 'deactivated'] });
    if (!after) return null;
    await this.db('pds_blobs').where({ account_id: a.id }).update({ taken_down: true });
    let labels: string[] = [];
    try {
      labels = (await this.s().atproto.emit(by, a.tenant_id, { uri: a.did, vals: ['!takedown'], source: 'pds takedown' })).map((l) => l.label.val);
    } catch (err) {
      // No labeler identity: the takedown stands, without a published label.
      this.s().log.info({ err: (err as Error).message, did: a.did }, 'pds takedown: no label published');
    }
    await this.audit(by, 'pds.account.takendown', { account: a.id, did: a.did, ...(actionRef ? { action: actionRef } : {}) }, { reason: reason.slice(0, 500), prevState: a.state, labels });
    return a.state;
  }

  /** Undoes a takedown (an upheld appeal or an admin's reversal); withdraws the `!takedown` label. */
  async restore(by: PdsActor, a: PdsAccountRow, prev: AccountState): Promise<boolean> {
    if (a.state !== 'takendown') return false;
    const target: AccountState = prev === 'deactivated' ? 'deactivated' : 'active';
    const after = await this.setState(by, a, target, { from: ['takendown'], reason: target === 'deactivated' ? a.state_reason : null });
    if (!after) return false;
    if (target === 'deactivated') await this.db('pds_accounts').where({ id: a.id }).update({ takendown_at: null, takedown_ref: null });
    await this.db('pds_blobs').where({ account_id: a.id }).update({ taken_down: false });
    let negated = false;
    try {
      await this.s().atproto.negate(by, a.tenant_id, { uri: a.did, val: '!takedown', reason: 'takedown reversed' });
      negated = true;
    } catch {
      /* no label was in force */
    }
    await this.audit(by, 'pds.account.restored', { account: a.id, did: a.did }, { state: target, labelWithdrawn: negated });
    return true;
  }

  /** Changes an account's handle within its tenant's domain: a PLC operation (when this PDS holds the rotation key) and an #identity event. */
  async updateHandle(by: PdsActor, a: PdsAccountRow, input: string): Promise<PdsAccountRow> {
    const hosting = await this.hosting(a.tenant_id);
    if (!hosting?.enabled) throw new XrpcError(400, 'InvalidRequest', 'This tenant does not host AT-Protocol accounts.');
    const handle = await this.checkHandle(input, hosting, a.id);
    if (handle === a.handle) return a;
    let plcOp: PlcOperation | null = a.plc_op;
    let plcPrev = a.plc_prev;
    const rot = rotationRef(a);
    if (a.did_method === 'plc' && a.plc_op && a.plc_prev && rot) {
      const { sig: _sig, ...last } = a.plc_op;
      const op: PlcOperation = { ...last, alsoKnownAs: [`at://${handle}`, ...a.plc_op.alsoKnownAs.filter((x) => !x.startsWith('at://'))], prev: a.plc_prev };
      plcOp = await signPlcOperation(op, (bytes) => this.sign(rot, bytes));
      await this.submitPlc(a.did, plcOp);
      plcPrev = plcOperationCid(plcOp);
    }
    try {
      await this.db.transaction(async (trx) => {
        await trx('pds_accounts').where({ id: a.id }).update({ handle, plc_op: plcOp ? JSON.stringify(plcOp) : null, plc_prev: plcPrev, updated_at: Date.now() });
        await sequence(trx, [{ did: a.did, type: 'identity', body: { did: a.did, handle } }]);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new XrpcError(400, 'HandleNotAvailable', 'Handle already taken.');
      throw err;
    }
    this.announce();
    await this.audit(by, 'pds.account.handle_changed', { account: a.id, did: a.did }, { from: a.handle, to: handle });
    return (await this.accountById(a.id))!;
  }

  /** An inter-service token for the account (`com.atproto.server.getServiceAuth`), signed with its repo key. */
  async serviceAuth(a: PdsAccountRow, o: { aud: string; lxm?: string | undefined; expS: number }): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    return signServiceJwt(a.key_curve, { iss: a.did, aud: o.aud, iat, exp: iat + o.expS, ...(o.lxm ? { lxm: o.lxm } : {}), jti: randomBytes(16).toString('hex') }, (bytes) => this.sign(signingRef(a), bytes));
  }

  // ---------- relays (B-2904) ----------

  private crawlTimer: NodeJS.Timeout | null = null;

  /** Asks the configured relays to crawl soon (once per PDS_CRAWL_MINUTES across instances, through a job). */
  async crawlSoon(): Promise<void> {
    const cfg = this.s().cfg;
    if (!cfg.PDS_RELAYS.length || this.crawlTimer) return;
    this.crawlTimer = setTimeout(() => {
      this.crawlTimer = null;
      const tenant = this.s().tenants;
      void tenant
        .bySlug(cfg.DEFAULT_TENANT)
        .then((t) => (t ? this.s().jobs.enqueue({ tenantId: t.id, type: CRAWL_JOB, payload: {}, createdBy: null, maxAttempts: 1, dedupeKey: `pds-crawl:${Math.floor(Date.now() / 10_000)}` }) : undefined))
        .catch((err: unknown) => this.s().log.warn({ err }, 'pds: enqueueing requestCrawl failed'));
    }, 1000);
    this.crawlTimer.unref?.();
  }

  /** Sends `com.atproto.sync.requestCrawl` to each configured relay not asked within PDS_CRAWL_MINUTES (or `force`). */
  async requestCrawl(o: { force?: boolean } = {}): Promise<{ relay: string; status: number | null; error: string | null; skipped?: boolean }[]> {
    const cfg = this.s().cfg;
    const out: { relay: string; status: number | null; error: string | null; skipped?: boolean }[] = [];
    for (const relay of cfg.PDS_RELAYS) {
      const relayHash = sha256hex(relay);
      const now = Date.now();
      const since = now - cfg.PDS_CRAWL_MINUTES * 60_000;
      // Claim the relay: only one instance asks within the interval.
      let claimed = 0;
      const row = await this.db('pds_crawls').where({ relay_hash: relayHash }).first();
      if (!row) {
        try {
          await this.db('pds_crawls').insert({ relay_hash: relayHash, relay: relay.slice(0, 500), last_at: now, last_status: null, last_error: null });
          claimed = 1;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      } else {
        const q = this.db('pds_crawls').where({ relay_hash: relayHash });
        if (!o.force) q.andWhere((w) => w.whereNull('last_at').orWhere('last_at', '<', since));
        claimed = await q.update({ last_at: now });
      }
      if (!claimed) {
        out.push({ relay, status: null, error: null, skipped: true });
        continue;
      }
      let status: number | null = null;
      let error: string | null = null;
      try {
        const r = await this.s().atproto.http.request(`${relay.replace(/\/+$/, '')}/xrpc/com.atproto.sync.requestCrawl`, { method: 'POST', body: { hostname: this.host() } });
        status = r.status;
        if (r.status < 200 || r.status >= 300) error = r.text.slice(0, 300) || `HTTP ${r.status}`;
      } catch (err) {
        error = (err as Error).message.slice(0, 300);
      }
      await this.db('pds_crawls').where({ relay_hash: relayHash }).update({ last_status: status, last_error: error });
      out.push({ relay, status, error });
    }
    return out;
  }

  async crawlState(): Promise<{ relay: string; lastAt: number | null; lastStatus: number | null; lastError: string | null }[]> {
    const rows = (await this.db('pds_crawls')) as Record<string, unknown>[];
    return this.s().cfg.PDS_RELAYS.map((relay) => {
      const r = rows.find((x) => x.relay_hash === sha256hex(relay));
      return { relay, lastAt: numOrNull(r?.last_at), lastStatus: numOrNull(r?.last_status), lastError: (r?.last_error as string | null) ?? null };
    });
  }

  // ---------- jobs and moderation ----------

  registerJobs(): void {
    const s = this.s();
    s.jobs.register(CRAWL_JOB, async () => ({ relays: await this.requestCrawl() }));
    s.jobs.register(TRIM_JOB, async () => this.trim());
    // A repo is a moderation object (B-1902): a takedown is the moderation hide, an upheld appeal restores it.
    if (!s.moderation.registry.get(REPO_OBJECT)) {
      const system = (tenantId: string): PdsActor => ({ tenantId, userId: null, actor: { service: 'moderation' } });
      s.moderation.registry.register({
        type: REPO_OBJECT,
        description: 'An AT-Protocol repository hosted by this PDS (a taken-down repo answers RepoTakendown and its blobs are not served)',
        resolve: async (tenantId, id) => {
          const a = await this.accountById(id);
          return a && a.tenant_id === tenantId ? { type: REPO_OBJECT, id: a.id, tenantId, workspaceId: null, label: 'public', ownerId: a.user_id, state: a.state === 'takendown' ? 'hidden' : a.state } : null;
        },
        // Repositories are public: anyone in the tenant may report one.
        canRead: async () => true,
        text: async (o) => (await this.accountById(o.id))?.handle ?? '',
        hide: async (o) => {
          const a = await this.accountById(o.id);
          if (!a) return null;
          const prev = await this.takeDown(system(o.tenantId), a, 'Taken down through moderation', null);
          return prev;
        },
        restore: async (o, prev) => {
          const a = await this.accountById(o.id);
          return a ? this.restore(system(o.tenantId), a, prev === 'deactivated' ? 'deactivated' : 'active') : false;
        }
      });
    }
  }

  schedule(): void {
    const s = this.s();
    s.scheduler.every(TRIM_JOB, 3600_000, async () => {
      const t = await s.tenants.bySlug(s.cfg.DEFAULT_TENANT);
      return t ? [{ tenantId: t.id, payload: {} }] : [];
    });
  }

  /** Drops events older than the backfill window (and a day), and blobs no record has used for a day. */
  async trim(): Promise<{ events: number; blobs: number }> {
    const cutoff = Date.now() - (this.s().cfg.PDS_BACKFILL_HOURS + 24) * 3600_000;
    const events = await this.db('pds_events').where('created_at', '<', cutoff).delete();
    const blobs = await this.blobs.sweep(Date.now() - 24 * 3600_000);
    return { events, blobs };
  }
}

export const CRAWL_JOB = 'pds.crawl';
export const TRIM_JOB = 'pds.trim';
export const REPO_OBJECT = 'pds-repo';
