import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { safeEqual } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { conflict } from '../http/problem.js';
import type { Services } from '../services.js';
import { isVaultRef, kvPolicyPath } from './policy.js';
import type { VaultCaller } from './service.js';

/*
 * 1.7.0, Sprint 42 (B-9208, VLT-8): third-party credentials move to vault paths.
 *
 * Webhook secrets, MCP service tokens and OAuth client secrets, data-connection passwords, moderation provider keys,
 * channel secrets and knowledge-source credentials are sealed in their own tables, outside the vault: no path policy, no versions, no
 * rotation notice and no reveal audit apply to them. This moves one to a KV secret at
 * `integrations/<kind>/<row id>` and records `vault:<path>#<field>` in a new column beside the sealed value:
 *
 * - The integration reads through the reference when its row has one, as the tenant service `integration.<kind>`
 *   (the owner of the reference, B-9209), which holds read and write on `kv/integrations/<kind>` and nothing else.
 *   No person owns it, as no person owned the sealed value: disabling whoever ran the move changes nothing.
 * - The sealed value stays where it was. Until a later clean-up removes it, a credential changed after the move is
 *   written to both places, so taking the references away again (`restore`) always falls back to the current value.
 * - Nothing moves by itself. `move` is an admin's action, one row at a time: it opens the sealed value in this
 *   process, writes the vault secret, reads it back, and only then records the reference. A row that fails is left
 *   as it was and reported; running it again continues where it stopped. The value never enters a log line, an audit
 *   entry or a job payload.
 * - A credential that is already a `vault:` reference (B-1705), or is taken from OpenBao, is counted and left alone.
 *
 * HTTP tools of the registry hold no credential of their own (only `vault:` references, B-8901), and import
 * repositories already keep theirs in the vault (B-3801): neither has anything to move. Two kinds of sealed credential
 * are left out on purpose: the per-user MCP access and refresh tokens (a person's own delegation, replaced at every
 * refresh, and removed when they disconnect) and the tokens of audit SIEM destinations (the forwarder must not read
 * through the vault whose reads it forwards, nor stop forwarding when the vault cannot be read).
 */

export const CREDENTIAL_KINDS = ['webhook', 'mcp-server', 'mcp-oauth-client', 'connection', 'moderation-provider', 'channel', 'knowledge-source', 'rest-connection'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

interface FieldSpec {
  /** The key in the vault secret, and the name of the field in what the routes report. */
  field: string;
  sealedColumn: string;
  refColumn: string;
  aad(id: string): string;
  /** The part of the opened value that is the credential: all of it, or one member of its JSON. */
  member?: string;
}

interface KindSpec {
  table: string;
  /** The column that identifies a row (and names its vault path); `id` unless the table is keyed otherwise. */
  idColumn?: string;
  title: string;
  fields: FieldSpec[];
  /** Rows of the table that are not this kind's to move (a connection that takes its credential from OpenBao). */
  skip?(row: Record<string, unknown>): boolean;
}

const SPECS: Record<CredentialKind, KindSpec> = {
  webhook: { table: 'webhooks', title: 'Webhook signing secrets', fields: [{ field: 'secret', sealedColumn: 'secret_sealed', refColumn: 'secret_ref', aad: (id) => `webhook:${id}` }] },
  'mcp-server': { table: 'mcp_servers', title: 'MCP service tokens', fields: [{ field: 'token', sealedColumn: 'credential', refColumn: 'credential_ref', aad: (id) => `mcp-credential:${id}` }] },
  'mcp-oauth-client': { table: 'mcp_oauth', idColumn: 'server_id', title: 'MCP OAuth client secrets', fields: [{ field: 'secret', sealedColumn: 'client_secret', refColumn: 'client_secret_ref', aad: (id) => `mcp-oauth-client:${id}` }] },
  connection: { table: 'data_connections', title: 'Data connection passwords', fields: [{ field: 'password', sealedColumn: 'credential', refColumn: 'credential_ref', aad: (id) => `connection:${id}`, member: 'password' }, { field: 'adminPassword', sealedColumn: 'admin_credential', refColumn: 'admin_credential_ref', aad: (id) => `connection-admin:${id}`, member: 'password' }], skip: (r) => r.credential_source === 'openbao' },
  'moderation-provider': { table: 'moderation_providers', title: 'Moderation provider keys', fields: [{ field: 'secret', sealedColumn: 'secret', refColumn: 'secret_ref', aad: (id) => `modprov:${id}` }] },
  channel: {
    table: 'channels',
    title: 'Channel secrets',
    fields: [
      { field: 'identity', sealedColumn: 'identity_secret', refColumn: 'identity_secret_ref', aad: (id) => `channel-identity:${id}` },
      { field: 'webhook', sealedColumn: 'webhook_secret', refColumn: 'webhook_secret_ref', aad: (id) => `channel-webhook:${id}` }
    ]
  },
  'knowledge-source': { table: 'knowledge_sources', title: 'Knowledge source credentials', fields: [{ field: 'secret', sealedColumn: 'secret_sealed', refColumn: 'secret_ref', aad: (id) => `knowledge-source:${id}` }] },
  // Sprint 45 (B-126): a REST connection's password, token, API key or OAuth2 client secret (a `vault:` reference stays as written).
  'rest-connection': { table: 'rest_connections', title: 'REST connection secrets', fields: [{ field: 'secret', sealedColumn: 'credential', refColumn: 'credential_ref', aad: (id) => `rest-connection:${id}`, member: 'secret' }] }
};

/** The tenant service that owns a kind's moved credentials (a subject of tenant vault policies since B-9209). */
export const credentialService = (kind: CredentialKind): string => `integration.${kind}`;
export const credentialPath = (kind: CredentialKind, id: string): string => `integrations/${kind}/${id.toLowerCase()}`;
export const credentialRef = (kind: CredentialKind, id: string, field: string): string => `vault:${credentialPath(kind, id)}#${field}`;
const kindRoot = (kind: CredentialKind): string => kvPolicyPath(`integrations/${kind}`);

/** What an integration needs of this: reading a moved credential, and keeping the vault's copy current. */
export interface CredentialVault {
  read(kind: CredentialKind, tenantId: string, ref: string, via: string): Promise<string>;
  rewritten(kind: CredentialKind, tenantId: string, id: string, field: string, value: string | null, ref: string | null | undefined): Promise<string | null>;
}

export class CredentialMoves implements CredentialVault {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** The kind's service in a tenant, as the vault's policy sees it. */
  private service(tenantId: string, kind: CredentialKind, via?: string): VaultCaller {
    const service = credentialService(kind);
    return { tenantId, clearance: 'restricted', subjects: { userId: null, groups: [], workspaces: [], apiKeyId: null, service }, actor: { service, ...(via ? { via } : {}) }, denialKey: `${tenantId}:${service}` };
  }

  /** A moved credential, read through the vault as its kind's service: the path policy applies and the read is audited. */
  async read(kind: CredentialKind, tenantId: string, ref: string, via: string): Promise<string> {
    return this.s().vault.readValue(this.service(tenantId, kind, via), ref);
  }

  /**
   * The integration changed a credential. Returns what its reference column holds now: the same reference, with the
   * new value written to the vault as a new version, when the credential was moved; null when it was not, or when the
   * new value is itself a `vault:` reference or the credential was removed.
   */
  async rewritten(kind: CredentialKind, tenantId: string, id: string, field: string, value: string | null, ref: string | null | undefined): Promise<string | null> {
    if (!ref || value == null || isVaultRef(value)) return null;
    const c = this.service(tenantId, kind, 'credential changed');
    const path = credentialPath(kind, id);
    const current = await this.s().vault.read(c, path).then((r) => r.data, () => ({}) as Record<string, string>);
    await this.s().vault.write(c, path, { ...current, [field]: value }, { label: 'restricted' });
    return credentialRef(kind, id, field);
  }

  /** The credential inside an opened sealed value: all of it, or the member a spec names. */
  private part(spec: FieldSpec, opened: string): string | null {
    if (!spec.member) return opened;
    const v = json<Record<string, unknown>>(opened, {})[spec.member];
    return typeof v === 'string' && v !== '' ? v : null;
  }

  /** Every row and field of a kind in a tenant, with where its credential is now. Opens sealed values; returns none. */
  private async survey(tenantId: string, kind: CredentialKind): Promise<{ id: string; spec: FieldSpec; state: 'moved' | 'sealed' | 'reference' | 'external'; value?: string }[]> {
    const spec = SPECS[kind];
    if (!(await this.db.schema.hasTable(spec.table))) return [];
    const rows = (await this.db(spec.table).where({ tenant_id: tenantId })) as Record<string, unknown>[];
    const out: { id: string; spec: FieldSpec; state: 'moved' | 'sealed' | 'reference' | 'external'; value?: string }[] = [];
    for (const r of rows) {
      const id = String(r[spec.idColumn ?? 'id']);
      for (const f of spec.fields) {
        if (spec.skip?.(r)) {
          out.push({ id, spec: f, state: 'external' });
          continue;
        }
        const sealed = r[f.sealedColumn];
        if (sealed == null || sealed === '') continue;
        if (r[f.refColumn]) {
          out.push({ id, spec: f, state: 'moved' });
          continue;
        }
        const value = this.part(f, await this.s().keys.open(tenantId, String(sealed), f.aad(id)));
        if (value == null) continue;
        out.push(isVaultRef(value) ? { id, spec: f, state: 'reference' } : { id, spec: f, state: 'sealed', value });
      }
    }
    return out;
  }

  /** Per kind: how many credentials are sealed outside the vault, moved, already references, or held elsewhere. */
  async status(p: Principal) {
    const kinds = [];
    for (const kind of CREDENTIAL_KINDS) {
      const found = await this.survey(p.tenantId, kind);
      const n = (state: string) => found.filter((f) => f.state === state).length;
      kinds.push({ kind, title: SPECS[kind].title, path: `integrations/${kind}`, service: credentialService(kind), sealed: n('sealed'), moved: n('moved'), references: n('reference'), external: n('external') });
    }
    return { kinds, remaining: kinds.reduce((a, k) => a + k.sealed, 0) };
  }

  /** The grant that lets a kind's service read and write its own credentials; made once, as the admin who runs the move. */
  private async ensureGrant(p: Principal, kind: CredentialKind, ctx: { ip?: string | null; traceId?: string | null }): Promise<void> {
    const s = this.s();
    const service = credentialService(kind);
    const have = (await s.vault.listGrants(p.tenantId)).some((g) => g.subjectKind === 'service' && g.subject === service && g.path === kindRoot(kind) && g.effect === 'allow' && (g.capabilities.includes('*') || (g.capabilities.includes('read') && g.capabilities.includes('write'))));
    if (have) return;
    await s.vault.createGrant(await s.vault.callerFor(p, ctx), { subjectKind: 'service', subject: service, path: kindRoot(kind), capabilities: ['read', 'write'], effect: 'allow', description: `The ${SPECS[kind].title.toLowerCase()} moved to the vault (B-9208) are read and kept current by this service.` });
  }

  /**
   * Moves up to `limit` sealed credentials of the kinds named (all by default) to the vault. Each one: the vault
   * secret is written, read back and compared, then the reference is recorded. The sealed value is not touched.
   */
  async move(p: Principal, opts: { kinds?: CredentialKind[]; limit?: number } = {}, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const s = this.s();
    const limit = Math.min(opts.limit ?? 200, 1000);
    const moved: { kind: CredentialKind; id: string; field: string; path: string }[] = [];
    const failed: { kind: CredentialKind; id: string; field: string; error: string }[] = [];
    let remaining = 0;
    for (const kind of opts.kinds?.length ? opts.kinds : CREDENTIAL_KINDS) {
      const todo = (await this.survey(p.tenantId, kind)).filter((f) => f.state === 'sealed');
      if (!todo.length) continue;
      await this.ensureGrant(p, kind, ctx);
      const c = this.service(p.tenantId, kind, 'credential move');
      for (const f of todo) {
        if (moved.length + failed.length >= limit) {
          remaining++;
          continue;
        }
        const path = credentialPath(kind, f.id);
        try {
          const current = await s.vault.read(c, path).then((r) => r.data, () => ({}) as Record<string, string>);
          const had = current[f.spec.field];
          if (had === undefined || had.length !== f.value!.length || !safeEqual(had, f.value!)) await s.vault.write(c, path, { ...current, [f.spec.field]: f.value! }, { label: 'restricted' });
          const back = (await s.vault.read(c, path)).data[f.spec.field];
          if (back === undefined || back.length !== f.value!.length || !safeEqual(back, f.value!)) throw conflict('The vault did not return what was written.');
          // Only a row that still has no reference and still holds the sealed value that was read takes it.
          const n = await this.db(SPECS[kind].table).where({ tenant_id: p.tenantId, [SPECS[kind].idColumn ?? 'id']: f.id }).whereNull(f.spec.refColumn).update({ [f.spec.refColumn]: credentialRef(kind, f.id, f.spec.field) });
          if (!n) continue;
          moved.push({ kind, id: f.id, field: f.spec.field, path });
          await s.audit.append({ tenantId: p.tenantId, action: 'vault.credential.moved', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { kind, id: f.id, field: f.spec.field, path: kvPolicyPath(path) }, label: 'restricted', detail: { service: credentialService(kind), sealedKept: true }, traceId: ctx.traceId ?? null });
        } catch (err) {
          // The message of a vault or database error names paths and states, never the value.
          failed.push({ kind, id: f.id, field: f.spec.field, error: String((err as { detail?: string }).detail ?? (err as Error).message ?? 'failed').slice(0, 300) });
        }
      }
    }
    return { moved, failed, remaining };
  }

  /**
   * Takes the references away again: the integrations read their sealed values, as before the move. The vault
   * secrets are left for an admin to destroy. Nothing is lost: a credential changed since the move was written to
   * both places.
   */
  async restore(p: Principal, opts: { kinds?: CredentialKind[] } = {}, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const restored: { kind: CredentialKind; id: string; field: string }[] = [];
    for (const kind of opts.kinds?.length ? opts.kinds : CREDENTIAL_KINDS) {
      for (const f of (await this.survey(p.tenantId, kind)).filter((x) => x.state === 'moved')) {
        const n = await this.db(SPECS[kind].table).where({ tenant_id: p.tenantId, [SPECS[kind].idColumn ?? 'id']: f.id }).whereNotNull(f.spec.refColumn).update({ [f.spec.refColumn]: null });
        if (!n) continue;
        restored.push({ kind, id: f.id, field: f.spec.field });
        await this.s().audit.append({ tenantId: p.tenantId, action: 'vault.credential.restored', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { kind, id: f.id, field: f.spec.field, path: kvPolicyPath(credentialPath(kind, f.id)) }, label: 'restricted', traceId: ctx.traceId ?? null });
      }
    }
    return { restored };
  }
}
