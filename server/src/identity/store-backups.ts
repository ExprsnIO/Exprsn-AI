import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { canonicalJson, SecretBox, sha256 } from '../crypto/index.js';
import type { Db } from '../db/knex.js';
import { json } from '../db/knex.js';
import { clears, LABELS, type Label } from '../authz/labels.js';
import { canGrant, isRole } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { HttpProblem } from '../http/problem.js';
import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import { ProviderRepo, type ProviderRow } from '../repos/providers.js';
import { normaliseGroup } from '../repos/users.js';
import type { Services } from '../services.js';
import { vaultRefsIn } from './secrets.js';
import type { StoreAdmin, StoreVersion } from './store-admin.js';
import { PROVIDER_KINDS, type ProviderKind } from './providers/types.js';

/*
 * 1.9.0, Sprint 54 (B-186): a backup of one user store as a sealed, signed archive (`exprsn-store-backup/1`).
 *
 * What it holds: the store (name, kind, order, state, configuration), its configuration versions, its group mappings
 * (workspaces by name, so they can be found in another tenant), its identity links with the linked accounts' names
 * and state, and for `local` and `sql` stores the accounts' records: for `local` their password hashes, and for both
 * their second factors. Configurations hold secret references only (`vault:`, `env:`, `file:`), never values; a TOTP or
 * email factor's secret stays sealed under the platform key it was sealed with and is re-sealed for the new factor's
 * id on restore. Recovery codes are bound to the account id, so they come back only into the same account.
 *
 * How it is protected: the payload is sealed with a fresh AES-256-GCM key, which the KMS wraps under
 * `<OPENBAO_KEY_PREFIX>identity-store-backups`; the archive (everything but the signature) is HMAC-signed by the KMS
 * under the same name. So a backup opens only on an installation with the same KMS key (the same platform), in any of
 * its tenants, and a changed byte, another key or another platform's signature is refused before anything is read.
 *
 * Restore: into the tenant of the admin restoring (from the session), into the same store (by id in the same tenant,
 * else by name and kind) or as a new store (created disabled, for review). A dry run lists every change and changes
 * nothing. The restoring admin must be able to grant each mapped role and clearance and read each vault reference,
 * as when saving a store by hand; a mapping they cannot give, or whose role or workspace is not in this tenant, is
 * skipped and listed. Existing passwords, factors and links are never overwritten.
 */

export const STORE_BACKUP_FORMAT = 'exprsn-store-backup/1';
const SCHEMA_RECHECK_MS = 30_000;

export const backupsMissing = () => new HttpProblem(503, 'Not installed', 'Saved store backups need the database migration 141_identity_store_backups, which has not been applied. A backup can still be downloaded.', { extensions: { reason: 'migration_pending' } });

const userRecord = z.object({
  id: z.string().max(26),
  username: z.string().max(190),
  displayName: z.string().max(200),
  email: z.string().max(320).nullable(),
  state: z.enum(['active', 'disabled']),
  clearanceDirect: z.enum(LABELS).nullable()
});

const payloadSchema = z.object({
  store: z.object({ id: z.string().max(26), name: z.string().max(100), kind: z.enum(PROVIDER_KINDS), position: z.number().int(), enabled: z.boolean(), state: z.enum(['active', 'archived']), config: z.record(z.string(), z.unknown()) }),
  versions: z.array(z.object({ version: z.number().int(), name: z.string(), kind: z.string(), position: z.number().int(), enabled: z.boolean(), config: z.record(z.string(), z.unknown()), reason: z.string().nullable(), createdBy: z.string().nullable(), createdAt: z.number() })),
  mappings: z.array(z.object({ group: z.string().max(512), role: z.string().max(40), clearance: z.enum(LABELS), workspace: z.string().max(200).nullable() })),
  links: z.array(z.object({ externalId: z.string().max(512), groups: z.array(z.string()), managerRef: z.string().max(512).nullable(), user: userRecord })),
  credentials: z.array(z.object({ userId: z.string().max(26), passwordHash: z.string().max(255), mustChange: z.boolean() })).default([]),
  factors: z
    .array(
      z.object({
        userId: z.string().max(26),
        id: z.string().max(26),
        kind: z.string().max(20),
        label: z.string().max(100),
        secret: z.string().nullable(),
        credentialId: z.string().max(512).nullable(),
        publicKey: z.string().nullable(),
        counter: z.number().nullable(),
        transports: z.string().nullable(),
        confirmedAt: z.number().nullable(),
        createdAt: z.number()
      })
    )
    .default([]),
  recoveryCodes: z.array(z.object({ userId: z.string().max(26), codeHash: z.string().max(64), usedAt: z.number().nullable(), createdAt: z.number() })).default([])
});

export type StoreBackupPayload = z.infer<typeof payloadSchema>;

export const archiveSchema = z.object({
  format: z.literal(STORE_BACKUP_FORMAT),
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  createdAt: z.number().int(),
  source: z.object({ tenant: z.object({ id: z.string().max(26), slug: z.string().max(100) }), store: z.object({ id: z.string().max(26), name: z.string().max(100), kind: z.string().max(20) }) }),
  counts: z.record(z.string(), z.number().int()),
  key: z.string().max(200),
  sealed: z.object({ cipher: z.literal('aes-256-gcm'), wrappedKey: z.string().max(4000), data: z.string(), sha256: z.string().length(64) }),
  signature: z.string().max(400)
});

export type StoreBackupArchive = z.infer<typeof archiveSchema>;

export interface RestoreChange {
  what: 'store' | 'version' | 'mapping' | 'link' | 'user' | 'password' | 'factor' | 'recovery-codes';
  action: 'create' | 'update' | 'unchanged' | 'skip';
  detail: string;
}

export interface RestoreReport {
  dryRun: boolean;
  backup: { id: string; createdAt: number; source: StoreBackupArchive['source'] };
  target: { id: string | null; name: string; kind: string; created: boolean };
  changes: RestoreChange[];
  summary: Record<string, number>;
  warnings: string[];
}

const refused = (detail: string, reason: string) => new HttpProblem(422, 'Backup refused', detail, { extensions: { reason } });

export class StoreBackups {
  private schema: { ok: boolean; at: number } | null = null;
  private origin: { ok: boolean; at: number } | null = null;

  constructor(
    private readonly s: Services,
    private readonly admin: StoreAdmin
  ) {}

  get keyName(): string {
    return `${this.s.cfg.OPENBAO_KEY_PREFIX}identity-store-backups`;
  }

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = await this.s.db.schema.hasTable('identity_store_backups');
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
    this.origin = null;
  }

  // ---------- making a backup ----------

  /** Reads everything the backup holds for `row`. */
  async collect(row: ProviderRow): Promise<StoreBackupPayload> {
    const db = this.s.db;
    let versions: StoreVersion[] = await this.admin.versions(row.tenant_id, row.id);
    // Without migration 140 (or for a store not changed since), the store as it is now is its one version.
    if (!versions.length) versions = [{ version: 1, name: row.name, kind: row.kind, position: row.position, enabled: row.enabled, config: row.config, reason: null, createdBy: null, createdAt: row.updated_at }];
    const workspaces = new Map(((await db('workspaces').where({ tenant_id: row.tenant_id }).select('id', 'name')) as { id: string; name: string }[]).map((w) => [w.id, w.name]));
    const mappings = (await this.s.users.mappings(row.tenant_id)).filter((m) => m.provider_id === row.id).map((m) => ({ group: m.group_name, role: m.role, clearance: m.clearance, workspace: m.workspace_id ? (workspaces.get(m.workspace_id) ?? null) : null }));
    const linkRows = (await db('user_identities as i')
      .join('users as u', 'u.id', 'i.user_id')
      .where({ 'i.provider_id': row.id, 'u.tenant_id': row.tenant_id })
      .orderBy('u.username')
      .select('i.external_id', 'i.groups', 'i.manager_ref', 'u.id', 'u.username', 'u.display_name', 'u.email', 'u.state', 'u.clearance_direct')) as Record<string, unknown>[];
    const links = linkRows.map((r) => ({
      externalId: String(r.external_id),
      groups: json<string[]>(r.groups, []),
      managerRef: (r.manager_ref as string | null) ?? null,
      user: { id: String(r.id), username: String(r.username), displayName: String(r.display_name), email: (r.email as string | null) ?? null, state: r.state === 'disabled' ? ('disabled' as const) : ('active' as const), clearanceDirect: (r.clearance_direct as Label | null) ?? null }
    }));
    const userIds = links.map((l) => l.user.id);
    const payload: StoreBackupPayload = { store: { id: row.id, name: row.name, kind: row.kind, position: row.position, enabled: row.enabled, state: row.state, config: row.config }, versions, mappings, links, credentials: [], factors: [], recoveryCodes: [] };
    if ((row.kind === 'local' || row.kind === 'sql') && userIds.length) {
      if (row.kind === 'local') {
        const creds = (await db('local_credentials').whereIn('user_id', userIds).select('user_id', 'password_hash', 'must_change')) as { user_id: string; password_hash: string; must_change: unknown }[];
        payload.credentials = creds.map((c) => ({ userId: c.user_id, passwordHash: c.password_hash, mustChange: !!c.must_change }));
      }
      const factors = (await db('mfa_factors').whereIn('user_id', userIds).whereNotNull('confirmed_at').orderBy('created_at')) as Record<string, unknown>[];
      payload.factors = factors.map((f) => ({
        userId: String(f.user_id),
        id: String(f.id),
        kind: String(f.kind),
        label: String(f.label),
        secret: (f.secret as string | null) ?? null,
        credentialId: (f.credential_id as string | null) ?? null,
        publicKey: (f.public_key as string | null) ?? null,
        counter: f.counter == null ? null : Number(f.counter),
        transports: (f.transports as string | null) ?? null,
        confirmedAt: f.confirmed_at == null ? null : Number(f.confirmed_at),
        createdAt: Number(f.created_at)
      }));
      const codes = (await db('mfa_recovery_codes').whereIn('user_id', userIds).select('user_id', 'code_hash', 'used_at', 'created_at')) as Record<string, unknown>[];
      payload.recoveryCodes = codes.map((c) => ({ userId: String(c.user_id), codeHash: String(c.code_hash), usedAt: c.used_at == null ? null : Number(c.used_at), createdAt: Number(c.created_at) }));
    }
    return payload;
  }

  /** Seals and signs a backup of `row`. Nothing is stored; `save` keeps it in the blob store. */
  async build(row: ProviderRow): Promise<StoreBackupArchive> {
    const s = this.s;
    const payload = await this.collect(row);
    const tenant = await s.tenants.byId(row.tenant_id);
    const id = ulid();
    const plain = JSON.stringify(payload);
    const dek = randomBytes(32);
    await s.kms.ensureKey(this.keyName);
    const sealed = { cipher: 'aes-256-gcm' as const, wrappedKey: await s.kms.wrap(this.keyName, dek, `store-backup:${id}`), data: new SecretBox(dek.toString('base64')).seal(plain, `exprsn-store-backup:${id}`), sha256: sha256(plain) };
    dek.fill(0);
    const counts = { versions: payload.versions.length, mappings: payload.mappings.length, links: payload.links.length, passwords: payload.credentials.length, factors: payload.factors.length, recoveryCodes: payload.recoveryCodes.length };
    const body = { format: STORE_BACKUP_FORMAT as typeof STORE_BACKUP_FORMAT, id, createdAt: Date.now(), source: { tenant: { id: row.tenant_id, slug: tenant?.slug ?? '' }, store: { id: row.id, name: row.name, kind: row.kind } }, counts, key: this.keyName, sealed };
    const signature = await s.kms.hmac(this.keyName, canonicalJson(body));
    return { ...body, signature };
  }

  static blobKey(tenantId: string, id: string): string {
    return `identity/store-backups/${tenantId}/${id}.json`;
  }

  /**
   * QA-1: whether `identity_store_backups.origin` exists (migration 142). Without it every saved backup counts as
   * made by hand and a schedule prunes nothing.
   */
  async hasOrigin(): Promise<boolean> {
    const t = Date.now();
    if (this.origin && (this.origin.ok || t - this.origin.at < SCHEMA_RECHECK_MS)) return this.origin.ok;
    let ok: boolean;
    try {
      ok = (await this.installed()) && (await this.s.db.schema.hasColumn('identity_store_backups', 'origin'));
    } catch {
      ok = false;
    }
    this.origin = { ok, at: t };
    return ok;
  }

  /** Builds a backup and keeps it in the blob store, with a row in `identity_store_backups`. */
  async save(row: ProviderRow, by: string | null, origin: 'manual' | 'schedule' = 'manual'): Promise<{ id: string; createdAt: number; bytes: number; sha256: string; counts: Record<string, number> }> {
    if (!(await this.installed())) throw backupsMissing();
    const archive = await this.build(row);
    const text = Buffer.from(JSON.stringify(archive), 'utf8');
    const key = StoreBackups.blobKey(row.tenant_id, archive.id);
    await this.s.blobs.put(key, text, 'application/json');
    const digest = sha256(text);
    await this.s.db('identity_store_backups').insert({ id: archive.id, tenant_id: row.tenant_id, provider_id: row.id, provider_name: row.name, kind: row.kind, format: STORE_BACKUP_FORMAT, blob_key: key, sha256: digest, bytes: text.length, counts: JSON.stringify(archive.counts), created_by: by, created_at: archive.createdAt, ...((await this.hasOrigin()) ? { origin } : {}) });
    return { id: archive.id, createdAt: archive.createdAt, bytes: text.length, sha256: digest, counts: archive.counts };
  }

  /**
   * QA-1 (B-186): keeps an uploaded backup, streamed into the blob store (`source` is the raw request body, at most
   * `maxBytes`), so one larger than the API's JSON limit can be restored by id. The archive's format and signature
   * are checked, and its payload unsealed, before it is listed; a refused one leaves nothing behind. The row has its
   * own id (an archive downloaded here and uploaded again is a second copy).
   */
  async upload(tenantId: string, by: string | null, source: AsyncIterable<Buffer | Uint8Array>, maxBytes: number): Promise<{ id: string; archiveId: string; createdAt: number; bytes: number; sha256: string; counts: Record<string, number>; source: StoreBackupArchive['source'] }> {
    if (!(await this.installed())) throw backupsMissing();
    const id = ulid();
    const key = StoreBackups.blobKey(tenantId, id);
    let seen = 0;
    const capped = async function* () {
      for await (const chunk of source) {
        seen += chunk.length;
        if (seen > maxBytes) throw new HttpProblem(413, 'Too large', `A store backup upload is at most ${Math.round(maxBytes / 1024 / 1024)} MB.`, { extensions: { reason: 'too_large', maxBytes } });
        yield Buffer.from(chunk);
      }
    };
    try {
      await this.s.blobs.putStream(key, capped(), 'application/json');
    } catch (err) {
      await this.s.blobs.delete(key).catch(() => undefined);
      throw err;
    }
    try {
      const raw = await this.s.blobs.get(key);
      if (!raw || !raw.length) throw refused('The upload was empty.', 'format');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw refused('The uploaded file is not JSON.', 'format');
      }
      const archive = this.parseArchive(parsed);
      await this.open(archive); // the signature, the seal and the payload's shape
      const digest = sha256(raw);
      const t = Date.now();
      await this.s.db('identity_store_backups').insert({ id, tenant_id: tenantId, provider_id: archive.source.store.id, provider_name: archive.source.store.name.slice(0, 100), kind: archive.source.store.kind.slice(0, 20), format: STORE_BACKUP_FORMAT, blob_key: key, sha256: digest, bytes: raw.length, counts: JSON.stringify(archive.counts), created_by: by, created_at: t, ...((await this.hasOrigin()) ? { origin: 'upload' } : {}) });
      return { id, archiveId: archive.id, createdAt: t, bytes: raw.length, sha256: digest, counts: archive.counts, source: archive.source };
    } catch (err) {
      await this.s.blobs.delete(key).catch(() => undefined);
      throw err;
    }
  }

  async list(tenantId: string, providerId?: string): Promise<{ id: string; providerId: string; providerName: string; kind: string; bytes: number; sha256: string; counts: Record<string, number>; origin: string; createdBy: string | null; createdAt: number }[]> {
    if (!(await this.installed())) return [];
    const q = this.s.db('identity_store_backups').where({ tenant_id: tenantId }).orderBy('created_at', 'desc').limit(200);
    if (providerId) q.andWhere({ provider_id: providerId });
    return ((await q) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), providerId: String(r.provider_id), providerName: String(r.provider_name), kind: String(r.kind), bytes: Number(r.bytes), sha256: String(r.sha256), counts: json<Record<string, number>>(r.counts, {}), origin: (r.origin as string | null | undefined) ?? 'manual', createdBy: (r.created_by as string | null) ?? null, createdAt: Number(r.created_at) }));
  }

  /** A saved backup's archive, checked against the digest kept when it was saved. */
  async read(tenantId: string, id: string): Promise<StoreBackupArchive> {
    if (!(await this.installed())) throw backupsMissing();
    const row = (await this.s.db('identity_store_backups').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!row) throw new HttpProblem(404, 'Not found', 'Store backup not found.');
    const raw = await this.s.blobs.get(String(row.blob_key));
    if (!raw) throw new HttpProblem(410, 'Gone', 'The backup file is no longer in the blob store.');
    if (sha256(raw) !== String(row.sha256)) throw refused('The saved backup file does not match the digest kept when it was saved.', 'digest');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw refused('The saved backup file is not JSON.', 'format');
    }
    return this.parseArchive(parsed);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    if (!(await this.installed())) throw backupsMissing();
    const row = (await this.s.db('identity_store_backups').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!row) return false;
    await this.s.blobs.delete(String(row.blob_key)).catch(() => undefined);
    await this.s.db('identity_store_backups').where({ tenant_id: tenantId, id }).delete();
    return true;
  }

  // ---------- opening a backup ----------

  parseArchive(raw: unknown): StoreBackupArchive {
    const r = archiveSchema.safeParse(raw);
    if (!r.success) throw refused('This is not a store backup this server reads (exprsn-store-backup/1).', 'format');
    return r.data;
  }

  /** Verifies the signature over exactly what arrived, then unseals and checks the payload. */
  async open(archive: StoreBackupArchive): Promise<StoreBackupPayload> {
    const s = this.s;
    const { signature, ...body } = archive;
    if (body.key !== this.keyName) throw refused('The backup was signed with a key this server does not hold.', 'signature');
    const ok = await s.kms.verifyHmac(this.keyName, canonicalJson(body), signature).catch(() => false);
    if (!ok) throw refused('The backup signature does not verify: it was changed after it was made, or made by another installation.', 'signature');
    let plain: string;
    try {
      const dek = await s.kms.unwrap(this.keyName, body.sealed.wrappedKey, `store-backup:${body.id}`);
      plain = new SecretBox(dek.toString('base64')).open(body.sealed.data, `exprsn-store-backup:${body.id}`);
      dek.fill(0);
    } catch {
      throw refused('The backup could not be unsealed with this installation\'s key.', 'seal');
    }
    if (sha256(plain) !== body.sealed.sha256) throw refused('The unsealed backup does not match its digest.', 'digest');
    const parsed = payloadSchema.safeParse(JSON.parse(plain));
    if (!parsed.success) throw refused('The backup\'s contents are not in the expected shape.', 'format');
    return parsed.data;
  }

  // ---------- restoring ----------

  /**
   * Restores `archive` into the restoring admin's tenant. `mode: same` updates the store it was made from (by id in
   * the same tenant, else by name and kind) or creates it under its own name; `mode: new` always creates a store,
   * named `name`. A new store starts disabled. With `dryRun`, nothing is written and the report says what would be.
   */
  async restore(p: Principal, archive: StoreBackupArchive, o: { mode: 'same' | 'new'; name?: string; dryRun: boolean; ctx?: { ip?: string | null; traceId?: string | null } }): Promise<RestoreReport> {
    const s = this.s;
    const payload = await this.open(archive);
    const tenantId = p.tenantId;
    const changes: RestoreChange[] = [];
    const warnings: string[] = [];
    const src = payload.store;
    const kind = src.kind as ProviderKind;
    const latest = payload.versions[payload.versions.length - 1] ?? { name: src.name, position: src.position, enabled: src.enabled, config: src.config, version: 1 };
    const stores = await s.providers.list(tenantId);
    const sameTenant = archive.source.tenant.id === tenantId;

    let target: ProviderRow | undefined;
    if (o.mode === 'same') target = (sameTenant ? stores.find((x) => x.id === src.id) : undefined) ?? stores.find((x) => x.name === src.name && x.kind === kind) ?? (kind === 'local' ? stores.find((x) => x.kind === 'local') : undefined);
    else if (kind === 'local') throw new HttpProblem(409, 'Conflict', 'A tenant has one local user store; restore a local store backup into it (mode same).');
    const name = (o.mode === 'new' ? o.name?.trim() || `${src.name} (restored)` : src.name).slice(0, 100);
    if (!target && stores.some((x) => x.name === name)) throw new HttpProblem(409, 'Conflict', `A user store named ${name} exists; give the restored store another name.`);
    if (target?.managed_by === 'config') throw new HttpProblem(409, 'Conflict', 'That store is managed by the configuration file; change it there.');

    // The configuration's vault references must be readable by the admin restoring, as when saving by hand.
    const refs = vaultRefsIn(latest.config);
    try {
      await s.vault.assertRefsReadable(p, refs, o.ctx ?? {});
    } catch (err) {
      if (!o.dryRun) throw err;
      warnings.push(`Vault references you cannot read: ${(err as Error).message}`);
    }

    if (!target) changes.push({ what: 'store', action: 'create', detail: `${name} (${kind}), disabled for review, from version ${latest.version}` });
    else if (canonicalJson(target.config) !== canonicalJson(latest.config)) changes.push({ what: 'store', action: 'update', detail: `${target.name}: configuration from version ${latest.version}` });
    else changes.push({ what: 'store', action: 'unchanged', detail: `${target.name}: configuration already matches version ${latest.version}` });
    changes.push({ what: 'version', action: 'create', detail: target ? 'one new version recording the restore' : `${payload.versions.length} version${payload.versions.length === 1 ? '' : 's'} of history` });

    // Mappings: the role must exist here and be grantable by the restorer; the workspace is found by name.
    const workspaces = new Map(((await s.db('workspaces').where({ tenant_id: tenantId }).select('id', 'name')) as { id: string; name: string }[]).map((w) => [w.name, w.id]));
    const existingMappings = target ? (await s.users.mappings(tenantId)).filter((m) => m.provider_id === target!.id) : [];
    const mappingOps: { group: string; role: string; clearance: Label; workspaceId: string | null }[] = [];
    for (const m of payload.mappings) {
      const label = `${m.group} → ${m.role} (${m.clearance})${m.workspace ? ` in ${m.workspace}` : ''}`;
      if (!isRole(m.role, tenantId)) changes.push({ what: 'mapping', action: 'skip', detail: `${label}: the role does not exist in this tenant` });
      else if (!canGrant(p.roles, m.role, tenantId)) changes.push({ what: 'mapping', action: 'skip', detail: `${label}: your roles cannot grant it` });
      else if (!clears(p.clearance, m.clearance)) changes.push({ what: 'mapping', action: 'skip', detail: `${label}: above your clearance` });
      else if (m.workspace && !workspaces.has(m.workspace)) changes.push({ what: 'mapping', action: 'skip', detail: `${label}: no workspace of that name here` });
      else {
        const workspaceId = m.workspace ? workspaces.get(m.workspace)! : null;
        if (existingMappings.some((x) => x.group_name === normaliseGroup(m.group) && x.role === m.role && x.clearance === m.clearance && x.workspace_id === workspaceId)) changes.push({ what: 'mapping', action: 'unchanged', detail: label });
        else {
          changes.push({ what: 'mapping', action: 'create', detail: label });
          mappingOps.push({ group: m.group, role: m.role, clearance: m.clearance, workspaceId });
        }
      }
    }

    // Accounts and links. Local and SQL stores carry their account records, so a missing account is created; for
    // the other kinds a link is restored only to an account that exists (the rest link again at their next sign-in).
    const carriesUsers = kind === 'local' || kind === 'sql';
    type LinkOp = { link: StoreBackupPayload['links'][number]; userId: string | null; createUser: boolean; sameUser: boolean };
    const linkOps: LinkOp[] = [];
    for (const link of payload.links) {
      const byId = sameTenant ? ((await s.users.get(tenantId, link.user.id)) ?? null) : null;
      const existing = byId ?? (await s.users.byUsername(tenantId, link.user.username)) ?? null;
      if (!existing && !carriesUsers) {
        changes.push({ what: 'link', action: 'skip', detail: `${link.user.username}: no account here; linked at their next sign-in` });
        continue;
      }
      if (!existing) changes.push({ what: 'user', action: 'create', detail: `${link.user.username} (${link.user.state})` });
      const externalId = kind === 'local' ? (existing?.id ?? '(new account id)') : link.externalId;
      const linked = target && existing ? await s.users.identity(target.id, externalId) : undefined;
      changes.push({ what: 'link', action: linked ? 'unchanged' : 'create', detail: `${link.user.username} as ${externalId}` });
      linkOps.push({ link, userId: existing?.id ?? null, createUser: !existing, sameUser: !!byId && byId.id === link.user.id });
    }
    const opFor = (userId: string) => linkOps.find((l) => l.link.user.id === userId);
    for (const c of payload.credentials) {
      const op = opFor(c.userId);
      if (!op) continue;
      const has = op.userId ? await s.db('local_credentials').where({ user_id: op.userId }).first('user_id') : undefined;
      changes.push({ what: 'password', action: has ? 'unchanged' : 'create', detail: `${op.link.user.username}${has ? ': keeps the current password' : ': password hash restored'}` });
    }
    for (const f of payload.factors) {
      const op = opFor(f.userId);
      if (!op) continue;
      const has = op.userId ? await s.db('mfa_factors').where({ user_id: op.userId, kind: f.kind, label: f.label }).first('id') : undefined;
      changes.push({ what: 'factor', action: has ? 'unchanged' : 'create', detail: `${op.link.user.username}: ${f.kind} ${f.label}` });
    }
    const codeUsers = [...new Set(payload.recoveryCodes.map((c) => c.userId))];
    for (const u of codeUsers) {
      const op = opFor(u);
      if (!op) continue;
      if (!op.sameUser) changes.push({ what: 'recovery-codes', action: 'skip', detail: `${op.link.user.username}: recovery codes belong to the original account; new ones are made at next sign-in` });
      else {
        const has = await s.db('mfa_recovery_codes').where({ user_id: op.userId! }).first('id');
        changes.push({ what: 'recovery-codes', action: has ? 'unchanged' : 'create', detail: op.link.user.username });
      }
    }

    const summary: Record<string, number> = {};
    for (const c of changes) summary[`${c.what}.${c.action}`] = (summary[`${c.what}.${c.action}`] ?? 0) + 1;
    const report: RestoreReport = { dryRun: o.dryRun, backup: { id: archive.id, createdAt: archive.createdAt, source: archive.source }, target: { id: target?.id ?? null, name: target?.name ?? name, kind, created: !target }, changes, summary, warnings };
    if (o.dryRun) return report;

    // ---- apply, in one transaction ----
    const box = s.keys.sealer(PLATFORM_SCOPE);
    const resealed = new Map<string, { id: string; secret: string | null }>();
    for (const f of payload.factors) {
      const id = ulid();
      let secret: string | null = null;
      if (f.secret) {
        const aadOld = f.kind === 'email' ? `email-factor:${f.id}` : `totp:${f.id}`;
        const aadNew = f.kind === 'email' ? `email-factor:${id}` : `totp:${id}`;
        try {
          secret = await box.seal(await box.open(f.secret, aadOld), aadNew);
        } catch {
          warnings.push(`A ${f.kind} factor of ${opFor(f.userId)?.link.user.username ?? 'an account'} could not be re-sealed and was left out.`);
          continue;
        }
      }
      resealed.set(f.id, { id, secret });
    }
    let targetId = target?.id ?? null;
    // Asked before the transaction: on SQLite a query outside it would wait for it.
    const versioned = await this.admin.installed();
    await s.db.transaction(async (trx) => {
      const providers = new ProviderRepo(trx as unknown as Db);
      const users = s.users.within(trx as unknown as Db);
      const by = p.userId ?? null;
      let row: ProviderRow;
      if (!target) {
        row = await providers.create(tenantId, { name, kind, position: latest.position, enabled: false, config: latest.config, vaultOwner: refs.length ? p.userId : null });
        targetId = row.id;
        if (versioned) {
          let v = 0;
          for (const ver of payload.versions) {
            v++;
            await trx('identity_provider_versions').insert({ id: ulid(), tenant_id: tenantId, provider_id: row.id, version: v, name: ver.name, kind: ver.kind, position: ver.position, enabled: ver.enabled, config: JSON.stringify(ver.config), reason: `restored from backup ${archive.id}${ver.reason ? `: ${ver.reason}` : ''}`.slice(0, 500), created_by: ver.createdBy, created_at: ver.createdAt });
          }
          await trx('identity_provider_versions').insert({ id: ulid(), tenant_id: tenantId, provider_id: row.id, version: v + 1, name: row.name, kind: row.kind, position: row.position, enabled: row.enabled, config: JSON.stringify(row.config), reason: `restored from backup ${archive.id}`, created_by: by, created_at: Date.now() });
        }
      } else {
        row = (await providers.update(tenantId, target.id, { config: latest.config, ...(refs.length ? { vaultOwner: p.userId } : {}) }))!;
        if (versioned) {
          const top = (await trx('identity_provider_versions').where({ provider_id: row.id }).max({ v: 'version' }).first()) as { v: number | string | null } | undefined;
          await trx('identity_provider_versions').insert({ id: ulid(), tenant_id: tenantId, provider_id: row.id, version: Number(top?.v ?? 0) + 1, name: row.name, kind: row.kind, position: row.position, enabled: row.enabled, config: JSON.stringify(row.config), reason: `restored from backup ${archive.id}`, created_by: by, created_at: Date.now() });
        }
      }
      for (const m of mappingOps) await users.addMapping(tenantId, { providerId: row.id, group: m.group, role: m.role, clearance: m.clearance, workspaceId: m.workspaceId });
      const idFor = new Map<string, string>();
      for (const op of linkOps) {
        let userId = op.userId;
        if (op.createUser) {
          const u = await users.create(tenantId, { username: op.link.user.username, displayName: op.link.user.displayName, email: op.link.user.email, clearance: op.link.user.clearanceDirect ?? 'internal' });
          userId = u.id;
          await users.update(tenantId, u.id, { clearance_direct: op.link.user.clearanceDirect, ...(op.link.user.state === 'disabled' ? { state: 'disabled' as const, disabled_reason: 'Restored from a store backup as disabled' } : {}) });
        }
        idFor.set(op.link.user.id, userId!);
        const externalId = kind === 'local' ? userId! : op.link.externalId;
        await users.upsertIdentity(userId!, row.id, externalId, op.link.groups, op.link.managerRef);
      }
      for (const c of payload.credentials) {
        const userId = idFor.get(c.userId);
        if (!userId || (await trx('local_credentials').where({ user_id: userId }).first('user_id'))) continue;
        await trx('local_credentials').insert({ user_id: userId, password_hash: c.passwordHash, must_change: c.mustChange, updated_at: Date.now() });
      }
      for (const f of payload.factors) {
        const userId = idFor.get(f.userId);
        const fresh = resealed.get(f.id);
        if (!userId || !fresh || (await trx('mfa_factors').where({ user_id: userId, kind: f.kind, label: f.label }).first('id'))) continue;
        await trx('mfa_factors').insert({ id: fresh.id, user_id: userId, kind: f.kind, label: f.label, secret: fresh.secret, credential_id: f.credentialId, public_key: f.publicKey, counter: f.counter, transports: f.transports, confirmed_at: f.confirmedAt, created_at: f.createdAt });
      }
      for (const u of codeUsers) {
        const op = opFor(u);
        if (!op?.sameUser || (await trx('mfa_recovery_codes').where({ user_id: op.userId! }).first('id'))) continue;
        for (const c of payload.recoveryCodes.filter((x) => x.userId === u)) await trx('mfa_recovery_codes').insert({ id: ulid(), user_id: op.userId!, code_hash: c.codeHash, used_at: c.usedAt, created_at: c.createdAt });
      }
    });
    report.target.id = targetId;
    return report;
  }
}

const backups = new WeakMap<Services, StoreBackups>();

/** The one `StoreBackups` of a `Services`. */
export function storeBackupsFor(s: Services, admin: StoreAdmin): StoreBackups {
  let b = backups.get(s);
  if (!b) backups.set(s, (b = new StoreBackups(s, admin)));
  return b;
}
