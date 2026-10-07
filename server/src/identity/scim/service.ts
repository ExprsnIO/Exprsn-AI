import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation, type AuditActor } from '../../audit/chain.js';
import { highest, type Label } from '../../authz/labels.js';
import { rolesRequireMfa } from '../../authz/permissions.js';
import type { Principal } from '../../authz/policy.js';
import { hmac, randomToken, safeEqual } from '../../crypto/index.js';
import { json } from '../../db/knex.js';
import { badRequest, notFound } from '../../http/problem.js';
import type { ProviderRow } from '../../repos/providers.js';
import { normaliseGroup, resolveMappings } from '../../repos/users.js';
import type { Services } from '../../services.js';
import { scimConfigSchema, type ScimConfig } from '../providers/types.js';
import { ENTERPRISE_SCHEMA, GROUP_SCHEMA, keyOf, matches, parseAttrPath, parseFilter, ScimFilterError, simpleEq, USER_SCHEMA, type Filter } from './filter.js';
import { applyPatch, normalise, ScimError, type Doc, type SchemaSet } from './patch.js';

export { ScimError };
import { LIST_SCHEMA } from './schemas.js';

/*
 * 1.6.0, Sprint 37c (B-7201, B-7202): SCIM 2.0 provisioning (RFC 7643, RFC 7644) into a tenant's SCIM store.
 *
 * - Tokens: `exai_scim1_<prefix>_<secret>`, made and revoked under Identity by holders of `identity:manage`, shown
 *   once; we keep the prefix and an HMAC. A token is bound to one SCIM store of one tenant; the tenant and the store
 *   come from the token, never from the request.
 * - Users: a SCIM user is a user of the tenant (the resource id is the user's id) linked to the store; `userName`
 *   becomes the username (lower case), `displayName` (else the name parts) the display name, the primary email the
 *   address, the enterprise `manager` the manager access reviews assign. `active: false` disables the user and ends
 *   every way they are signed in at once: sessions (their sockets close), OAuth refresh tokens, API keys and DAV app
 *   passwords, so their next request fails. A delete does the same and removes the SCIM record and link (the user row
 *   stays for the audit history). A user is never hard-deleted.
 * - Groups: kept as pushed. Membership maps to roles through the tenant's group mappings, which name a group's display
 *   name with the SCIM store as provider (else the store's default roles and clearance). Every change to a group or a
 *   membership recomputes its members' mapped roles, workspaces and clearance; when they change, the member's
 *   sessions end so the next request is evaluated with the new roles.
 * - Lists filter (the full RFC grammar; one `eq` on userName, externalId, id or displayName is asked of the database,
 *   anything else is evaluated over the store's resources, at most SCAN_MAX of them) and page with startIndex and
 *   count, capped at IDENTITY_SCIM_MAX_RESULTS. `attributes` and `excludedAttributes` project the answer.
 *   meta.version is a weak ETag; If-Match on PUT, PATCH and DELETE refuses a stale write with 412.
 * Every change is audited (`scim.*`) with the token as the actor.
 */

const TOKEN_RE = /^exai_scim1_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const SCAN_MAX = 50_000;
const USER_SET: SchemaSet = { core: USER_SCHEMA, extensions: [ENTERPRISE_SCHEMA] };
const GROUP_SET: SchemaSet = { core: GROUP_SCHEMA, extensions: [] };
export const REAPPLY_JOB = 'identity.scim.reapply';

export interface ScimCaller {
  tenantId: string;
  provider: ProviderRow;
  cfg: ScimConfig;
  tokenId: string;
  actor: AuditActor;
  base: string;
  traceId: string | null;
}

interface UserRowS {
  user_id: string;
  tenant_id: string;
  provider_id: string;
  user_name: string;
  user_name_lc: string;
  external_id: string | null;
  active: boolean;
  attributes: string;
  version: number;
  created_at: number;
  updated_at: number;
}

interface GroupRowS {
  id: string;
  tenant_id: string;
  provider_id: string;
  display_name: string;
  display_name_lc: string;
  external_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

interface TokenRow {
  id: string;
  tenant_id: string;
  provider_id: string;
  name: string;
  prefix: string;
  token_hash: string;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface ListQuery {
  filter?: string | undefined;
  startIndex?: number | undefined;
  count?: number | undefined;
  attributes?: string | undefined;
  excludedAttributes?: string | undefined;
}

const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't';
const n = (v: unknown): number => Number(v);
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const userFrom = (r: Record<string, unknown>): UserRowS => ({ ...(r as unknown as UserRowS), active: bool(r.active), version: n(r.version), created_at: n(r.created_at), updated_at: n(r.updated_at) });
const groupFrom = (r: Record<string, unknown>): GroupRowS => ({ ...(r as unknown as GroupRowS), version: n(r.version), created_at: n(r.created_at), updated_at: n(r.updated_at) });
const tokenFrom = (r: Record<string, unknown>): TokenRow => ({ ...(r as unknown as TokenRow), created_at: n(r.created_at), expires_at: nn(r.expires_at), last_used_at: nn(r.last_used_at), revoked_at: nn(r.revoked_at) });
const iso = (t: number) => new Date(t).toISOString();
const etag = (v: number) => `W/"${v}"`;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Control characters (C0 and DEL), refused in names. */
const hasControl = (v: string): boolean => [...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

export const tokenState = (t: Pick<TokenRow, 'revoked_at' | 'expires_at'>): 'active' | 'expired' | 'revoked' => (t.revoked_at ? 'revoked' : t.expires_at != null && t.expires_at <= Date.now() ? 'expired' : 'active');
const tokenView = (t: TokenRow) => ({ id: t.id, name: t.name, prefix: t.prefix, state: tokenState(t), createdBy: t.created_by, createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, lastUsedIp: t.last_used_ip, revokedAt: t.revoked_at });

/** Applies `attributes` / `excludedAttributes` (RFC 7644 3.4.2.5); `id` and `schemas` are always returned. */
export function project(resource: Doc, attributes?: string, excluded?: string): Doc {
  const list = (s?: string) =>
    (s ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        try {
          return parseAttrPath(x);
        } catch {
          throw new ScimError(400, 'invalidSyntax', `${x.slice(0, 100)} is not an attribute.`);
        }
      });
  const inc = list(attributes);
  const exc = list(excluded);
  if (inc.length) {
    const out: Doc = { schemas: resource.schemas, id: resource.id };
    for (const p of inc) {
      const box = p.urn ? (isObj(resource[p.urn]) ? (resource[p.urn] as Doc) : null) : resource;
      if (!box) continue;
      const k = p.attr ? keyOf(box, p.attr) : undefined;
      if (!p.attr && p.urn) {
        out[p.urn] = box;
        continue;
      }
      if (k === undefined) continue;
      const target = p.urn ? ((out[p.urn] as Doc | undefined) ?? (out[p.urn] = {})) : out;
      const val = box[k];
      if (!(target as Doc)) continue;
      if (p.sub && isObj(val)) {
        const sk = keyOf(val, p.sub);
        if (sk !== undefined) (target as Doc)[k] = { ...(isObj((target as Doc)[k]) ? ((target as Doc)[k] as Doc) : {}), [sk]: val[sk] };
      } else if (p.sub && Array.isArray(val)) {
        (target as Doc)[k] = val.map((it) => (isObj(it) ? Object.fromEntries(Object.entries(it).filter(([x]) => x.toLowerCase() === p.sub!.toLowerCase())) : it));
      } else (target as Doc)[k] = val;
    }
    return out;
  }
  if (exc.length) {
    const out: Doc = JSON.parse(JSON.stringify(resource)) as Doc;
    for (const p of exc) {
      const box = p.urn ? (isObj(out[p.urn]) ? (out[p.urn] as Doc) : null) : out;
      if (!box) continue;
      const k = keyOf(box, p.attr);
      if (k === undefined || (!p.urn && (k === 'id' || k === 'schemas'))) continue;
      if (p.sub && isObj(box[k])) {
        const sk = keyOf(box[k] as Doc, p.sub);
        if (sk) delete (box[k] as Doc)[sk];
      } else delete box[k];
    }
    return out;
  }
  return resource;
}

export class ScimService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(REAPPLY_JOB, async (p, ctx) => {
      const tenantId = String(p.tenantId ?? ctx.job.tenant_id);
      const provider = await this.s().providers.get(tenantId, String(p.providerId));
      if (!provider || provider.kind !== 'scim') return { users: 0 };
      const c = this.systemCaller(provider, 'identity.scim.reapply');
      const ids = ((await this.db('scim_users').where({ provider_id: provider.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
      let changed = 0;
      for (let i = 0; i < ids.length; i += 200) {
        changed += await this.refreshAccess(c, ids.slice(i, i + 200));
        await ctx.progress(Math.round(((i + 200) / Math.max(ids.length, 1)) * 100), `${Math.min(i + 200, ids.length)} of ${ids.length}`);
      }
      return { users: ids.length, changed };
    });
  }

  private systemCaller(provider: ProviderRow, service: string): ScimCaller {
    return { tenantId: provider.tenant_id, provider, cfg: scimConfigSchema.parse(provider.config ?? {}), tokenId: '', actor: { service }, base: this.baseUrl(), traceId: null };
  }

  baseUrl(): string {
    return `${this.s().cfg.PUBLIC_URL.replace(/\/+$/, '')}/scim/v2`;
  }

  private digest(token: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, 'scim:' + token);
  }

  private audit(c: ScimCaller, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label: Label = 'internal') {
    return this.s().audit.append({ tenantId: c.tenantId, action, kind: 'admin', actor: c.actor, target: { store: c.provider.id, ...target }, label, ...(detail ? { detail } : {}), traceId: c.traceId });
  }

  // ---------- tokens and the store (Identity screen, identity:manage) ----------

  private async scimStore(p: Principal, providerId: string): Promise<ProviderRow> {
    const row = await this.s().providers.get(p.tenantId, providerId);
    if (!row) throw notFound('User store');
    if (row.kind !== 'scim') throw badRequest('This user store is not a SCIM store.');
    return row;
  }

  async status(p: Principal, providerId: string) {
    const row = await this.scimStore(p, providerId);
    const count = async (q: ReturnType<Services['db']>) => Number(((await q.count({ n: '*' }).first()) as { n: number | string } | undefined)?.n ?? 0);
    const [users, active, groups, tokens, last] = await Promise.all([
      count(this.db('scim_users').where({ provider_id: row.id })),
      count(this.db('scim_users').where({ provider_id: row.id, active: true })),
      count(this.db('scim_groups').where({ provider_id: row.id })),
      this.db('scim_tokens').where({ tenant_id: p.tenantId, provider_id: row.id }).orderBy('created_at', 'desc') as Promise<Record<string, unknown>[]>,
      this.db('scim_users').where({ provider_id: row.id }).max({ t: 'updated_at' }).first() as Promise<{ t: number | string | null } | undefined>
    ]);
    const mapped = ((await this.db('group_mappings').where({ tenant_id: p.tenantId, provider_id: row.id }).count({ n: '*' }).first()) as { n: number | string } | undefined)?.n;
    return { store: { id: row.id, name: row.name, enabled: row.enabled, config: row.config }, baseUrl: this.baseUrl(), users, activeUsers: active, groups, groupMappings: Number(mapped ?? 0), lastChangeAt: last?.t == null ? null : Number(last.t), tokens: tokens.map(tokenFrom).map(tokenView) };
  }

  async createToken(p: Principal, providerId: string, input: { name: string; expiresInDays?: number | null | undefined }, ctx: { ip?: string | null; traceId?: string | null }) {
    const row = await this.scimStore(p, providerId);
    const max = this.s().cfg.IDENTITY_SCIM_TOKEN_MAX_DAYS;
    let days = input.expiresInDays ?? null;
    if (max > 0) {
      if (days != null && days > max) throw badRequest(`A SCIM token lasts at most ${max} days on this server (IDENTITY_SCIM_TOKEN_MAX_DAYS).`);
      days = days ?? max;
    }
    const prefix = randomBytes(6).toString('hex');
    const token = `exai_scim1_${prefix}_${randomToken(32)}`;
    const now = Date.now();
    const t: TokenRow = { id: ulid(), tenant_id: p.tenantId, provider_id: row.id, name: input.name, prefix, token_hash: this.digest(token), created_by: p.userId, created_at: now, expires_at: days != null ? now + Math.round(days * 86_400_000) : null, last_used_at: null, last_used_ip: null, revoked_at: null, revoked_by: null };
    await this.db('scim_tokens').insert(t);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'scim.token.created', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { store: row.id, token: t.id, prefix }, detail: { name: t.name, expiresAt: t.expires_at }, traceId: ctx.traceId ?? null });
    return { ...tokenView(t), token, baseUrl: this.baseUrl() };
  }

  async revokeToken(p: Principal, providerId: string, tokenId: string, ctx: { ip?: string | null; traceId?: string | null }) {
    const row = await this.scimStore(p, providerId);
    const r = await this.db('scim_tokens').where({ tenant_id: p.tenantId, provider_id: row.id, id: tokenId }).first();
    if (!r) throw notFound('SCIM token');
    const t = tokenFrom(r);
    if (!t.revoked_at) {
      await this.db('scim_tokens').where({ id: t.id }).update({ revoked_at: Date.now(), revoked_by: p.userId });
      await this.s().audit.append({ tenantId: p.tenantId, action: 'scim.token.revoked', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { store: row.id, token: t.id, prefix: t.prefix }, traceId: ctx.traceId ?? null });
    }
    return tokenView({ ...t, revoked_at: t.revoked_at ?? Date.now(), revoked_by: t.revoked_by ?? p.userId });
  }

  /** Re-applies the group mappings to every user of the store (after the mappings changed), as a job. */
  async reapply(p: Principal, providerId: string, ctx: { ip?: string | null; traceId?: string | null }) {
    const row = await this.scimStore(p, providerId);
    const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: REAPPLY_JOB, payload: { tenantId: p.tenantId, providerId: row.id }, createdBy: p.userId });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'scim.mappings.reapplied', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { store: row.id, job: job.id }, traceId: ctx.traceId ?? null });
    return { jobId: job.id };
  }

  /** Drops the store's SCIM records when the store is deleted (its identity links go with the store). */
  async forget(tenantId: string, providerId: string): Promise<void> {
    await this.db.transaction(async (trx) => {
      const groups = ((await trx('scim_groups').where({ tenant_id: tenantId, provider_id: providerId }).select('id')) as { id: string }[]).map((g) => g.id);
      for (let i = 0; i < groups.length; i += 500) await trx('scim_group_members').whereIn('group_id', groups.slice(i, i + 500)).delete();
      await trx('scim_groups').where({ tenant_id: tenantId, provider_id: providerId }).delete();
      await trx('scim_users').where({ tenant_id: tenantId, provider_id: providerId }).delete();
      await trx('scim_tokens').where({ tenant_id: tenantId, provider_id: providerId }).update({ revoked_at: Date.now() });
    });
  }

  // ---------- authentication of /scim/v2 requests ----------

  async authenticate(header: string | undefined, ip: string | null, traceId: string | null): Promise<ScimCaller> {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
    const tm = m ? TOKEN_RE.exec(m[1]!) : null;
    if (!tm) throw new ScimError(401, null, 'Send a SCIM token as a bearer token (Authorization: Bearer exai_scim1_…).');
    const r = await this.db('scim_tokens').where({ prefix: tm[1] }).first();
    const t = r ? tokenFrom(r) : null;
    if (!t || !safeEqual(this.digest(m![1]!), t.token_hash)) throw new ScimError(401, null, 'The SCIM token is not valid.');
    if (tokenState(t) !== 'active') throw new ScimError(401, null, `The SCIM token is ${tokenState(t)}.`);
    const provider = await this.s().providers.get(t.tenant_id, t.provider_id);
    const tenant = await this.s().tenants.byId(t.tenant_id);
    if (!provider || provider.kind !== 'scim' || !tenant || tenant.state !== 'active') throw new ScimError(401, null, 'The SCIM token is not valid.');
    if (!provider.enabled) throw new ScimError(403, null, 'This SCIM store is disabled.');
    const now = Date.now();
    if (!t.last_used_at || now - t.last_used_at > 60_000 || t.last_used_ip !== ip) await this.db('scim_tokens').where({ id: t.id }).update({ last_used_at: now, last_used_ip: ip?.slice(0, 64) ?? null });
    return { tenantId: t.tenant_id, provider, cfg: scimConfigSchema.parse(provider.config ?? {}), tokenId: t.id, actor: { service: 'scim', via: `scim-token:${t.prefix}`, ip }, base: this.baseUrl(), traceId };
  }

  // ---------- users ----------

  private async userRow(c: ScimCaller, id: string): Promise<UserRowS> {
    const r = await this.db('scim_users').where({ provider_id: c.provider.id, user_id: id }).first();
    if (!r) throw new ScimError(404, null, `User ${id.slice(0, 64)} not found.`);
    return userFrom(r);
  }

  private async groupsOf(userIds: string[], providerId: string): Promise<Map<string, { id: string; name: string }[]>> {
    const out = new Map<string, { id: string; name: string }[]>();
    for (let i = 0; i < userIds.length; i += 500) {
      const rows = (await this.db('scim_group_members as m').join('scim_groups as g', 'g.id', 'm.group_id').where({ 'g.provider_id': providerId }).whereIn('m.user_id', userIds.slice(i, i + 500)).select('m.user_id', 'g.id', 'g.display_name')) as { user_id: string; id: string; display_name: string }[];
      for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), { id: r.id, name: r.display_name }]);
    }
    return out;
  }

  private userResource(c: ScimCaller, u: UserRowS, groups: { id: string; name: string }[]): Doc {
    const attrs = json<Doc>(u.attributes, {});
    const doc: Doc = { schemas: [USER_SCHEMA, ...(isObj(attrs[ENTERPRISE_SCHEMA]) ? [ENTERPRISE_SCHEMA] : [])], id: u.user_id, ...(u.external_id ? { externalId: u.external_id } : {}), userName: u.user_name, ...attrs, active: u.active };
    if (groups.length) doc.groups = groups.map((g) => ({ value: g.id, display: g.name, $ref: `${c.base}/Groups/${g.id}`, type: 'direct' }));
    doc.meta = { resourceType: 'User', created: iso(u.created_at), lastModified: iso(u.updated_at), version: etag(u.version), location: `${c.base}/Users/${u.user_id}` };
    return doc;
  }

  async getUser(c: ScimCaller, id: string, q: ListQuery = {}) {
    const u = await this.userRow(c, id);
    const res = this.userResource(c, u, (await this.groupsOf([u.user_id], c.provider.id)).get(u.user_id) ?? []);
    return { resource: project(res, q.attributes, q.excludedAttributes), etag: etag(u.version) };
  }

  private parseQuery(q: ListQuery): { filter: Filter | null; start: number; count: number } {
    let filter: Filter | null = null;
    if (q.filter) {
      try {
        filter = parseFilter(q.filter);
      } catch (err) {
        if (err instanceof ScimFilterError) throw new ScimError(400, 'invalidFilter', err.message);
        throw err;
      }
    }
    const max = this.s().cfg.IDENTITY_SCIM_MAX_RESULTS;
    const start = Math.max(1, Math.floor(q.startIndex ?? 1));
    const count = Math.min(Math.max(0, Math.floor(q.count ?? max)), max);
    return { filter, start, count };
  }

  private listResponse(all: number, start: number, items: Doc[]) {
    return { schemas: [LIST_SCHEMA], totalResults: all, itemsPerPage: items.length, startIndex: start, Resources: items };
  }

  async listUsers(c: ScimCaller, q: ListQuery) {
    const { filter, start, count } = this.parseQuery(q);
    const base = () => this.db('scim_users').where({ provider_id: c.provider.id });
    const eq = filter ? simpleEq(filter) : null;
    let rows: UserRowS[];
    let total: number;
    if (!filter || (eq && eq.attr !== 'displayname')) {
      const qb = base();
      if (eq?.attr === 'username') qb.andWhere({ user_name_lc: eq.value.toLowerCase() });
      else if (eq?.attr === 'externalid') qb.andWhere({ external_id: eq.value });
      else if (eq?.attr === 'id') qb.andWhere({ user_id: eq.value });
      total = Number(((await qb.clone().count({ n: '*' }).first()) as { n: number | string } | undefined)?.n ?? 0);
      rows = count ? ((await qb.orderBy([{ column: 'created_at' }, { column: 'user_id' }]).offset(start - 1).limit(count)) as Record<string, unknown>[]).map(userFrom) : [];
      const groups = await this.groupsOf(rows.map((r) => r.user_id), c.provider.id);
      return this.listResponse(total, start, rows.map((r) => project(this.userResource(c, r, groups.get(r.user_id) ?? []), q.attributes, q.excludedAttributes)));
    }
    const all = ((await base().orderBy([{ column: 'created_at' }, { column: 'user_id' }]).limit(SCAN_MAX + 1)) as Record<string, unknown>[]).map(userFrom);
    if (all.length > SCAN_MAX) throw new ScimError(400, 'tooMany', `This store has more than ${SCAN_MAX} users; filter with userName, externalId or id eq.`);
    const groups = await this.groupsOf(all.map((r) => r.user_id), c.provider.id);
    const hits = all.map((r) => this.userResource(c, r, groups.get(r.user_id) ?? [])).filter((d) => matches(d, filter));
    return this.listResponse(hits.length, start, hits.slice(start - 1, start - 1 + count).map((d) => project(d, q.attributes, q.excludedAttributes)));
  }

  /** The user's name, address, display name and manager from a SCIM document; refuses a document without userName. */
  private derive(doc: Doc): { userName: string; externalId: string | null; active: boolean; displayName: string; email: string | null; manager: string | null; attrs: Doc } {
    const userName = typeof doc.userName === 'string' ? doc.userName.trim() : '';
    if (!userName) throw new ScimError(400, 'invalidValue', 'userName is required.');
    if (userName.length > 190 || hasControl(userName)) throw new ScimError(400, 'invalidValue', 'userName is at most 190 characters, without control characters.');
    const name = isObj(doc.name) ? doc.name : {};
    const parts = [name.givenName, name.familyName].filter((x) => typeof x === 'string' && x.trim()).join(' ');
    const displayName = String((typeof doc.displayName === 'string' && doc.displayName.trim()) || (typeof name.formatted === 'string' && name.formatted.trim()) || parts || userName).slice(0, 200);
    const emails = Array.isArray(doc.emails) ? (doc.emails as Doc[]) : [];
    const pick = emails.find((e) => e.primary === true) ?? emails.find((e) => String(e.type ?? '').toLowerCase() === 'work') ?? emails[0];
    const email = pick && typeof pick.value === 'string' && pick.value.includes('@') ? pick.value.slice(0, 320) : null;
    const ent = isObj(doc[ENTERPRISE_SCHEMA]) ? (doc[ENTERPRISE_SCHEMA] as Doc) : {};
    const manager = isObj(ent.manager) && typeof ent.manager.value === 'string' && ent.manager.value ? ent.manager.value.slice(0, 512) : null;
    const attrs: Doc = { ...doc };
    delete attrs.userName;
    delete attrs.externalId;
    delete attrs.active;
    const externalId = typeof doc.externalId === 'string' && doc.externalId ? doc.externalId.slice(0, 255) : null;
    return { userName, externalId, active: doc.active === undefined ? true : doc.active === true, displayName, email, manager, attrs };
  }

  async createUser(c: ScimCaller, body: Doc) {
    const s = this.s();
    const doc = normalise(body, USER_SET);
    const d = this.derive(doc);
    const lc = d.userName.toLowerCase();
    if (await this.db('scim_users').where({ provider_id: c.provider.id, user_name_lc: lc }).first('user_id')) throw new ScimError(409, 'uniqueness', `A user with userName ${d.userName} exists in this store.`);
    let user = await s.users.byUsername(c.tenantId, lc);
    let adopted = false;
    if (user) {
      // A user of another store keeps their account: a SCIM store never takes it over.
      const links = (await s.users.identitiesFor(user.id)).filter((l) => l.provider_id !== c.provider.id);
      if (links.length || (await this.db('local_credentials').where({ user_id: user.id }).first('user_id'))) throw new ScimError(409, 'uniqueness', `The username ${lc} belongs to a user of another store.`);
      adopted = true;
    }
    const now = Date.now();
    try {
      await this.db.transaction(async (trx) => {
        const users = s.users.within(trx);
        if (!user) user = await users.create(c.tenantId, { username: lc, displayName: d.displayName, email: d.email, clearance: c.cfg.defaultClearance });
        else await users.update(c.tenantId, user.id, { display_name: d.displayName, email: d.email });
        await trx('scim_users').insert({ user_id: user.id, tenant_id: c.tenantId, provider_id: c.provider.id, user_name: d.userName, user_name_lc: lc, external_id: d.externalId, active: d.active, attributes: JSON.stringify(d.attrs), version: 1, created_at: now, updated_at: now });
        await users.upsertIdentity(user.id, c.provider.id, user.id, [], d.manager);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ScimError(409, 'uniqueness', `A user with userName ${d.userName} exists.`);
      throw err;
    }
    const u = user!;
    await this.audit(c, 'scim.user.created', { user: u.id, username: lc }, { externalId: d.externalId, active: d.active, adopted });
    await this.refreshAccess(c, [u.id]);
    if (!d.active) await this.endAccess(c, u.id, 'SCIM: deactivated');
    else if (adopted && u.state === 'disabled') await this.reactivate(c, u.id);
    return this.getUser(c, u.id);
  }

  private checkMatch(ifMatch: string | undefined, version: number): void {
    if (!ifMatch || ifMatch.trim() === '*') return;
    const tags = ifMatch.split(',').map((x) => x.trim());
    if (!tags.includes(etag(version)) && !tags.includes(`"${version}"`)) throw new ScimError(412, null, `The resource is at version ${etag(version)}; read it again.`);
  }

  /** Saves a whole new document for an existing user (PUT, and PATCH after its operations). */
  private async saveUser(c: ScimCaller, u: UserRowS, doc: Doc, how: 'replaced' | 'patched') {
    const s = this.s();
    const d = this.derive(doc);
    const lc = d.userName.toLowerCase();
    if (lc !== u.user_name_lc) {
      if (await this.db('scim_users').where({ provider_id: c.provider.id, user_name_lc: lc }).whereNot({ user_id: u.user_id }).first('user_id')) throw new ScimError(409, 'uniqueness', `A user with userName ${d.userName} exists in this store.`);
      const other = await s.users.byUsername(c.tenantId, lc);
      if (other && other.id !== u.user_id) throw new ScimError(409, 'uniqueness', `The username ${lc} belongs to another user.`);
    }
    const now = Date.now();
    // Read before the transaction: on SQLite the transaction holds the only connection.
    const groupNames = (await this.groupsOf([u.user_id], c.provider.id)).get(u.user_id)?.map((g) => normaliseGroup(g.name)) ?? [];
    const moved = await this.db.transaction(async (trx) => {
      const n = await trx('scim_users').where({ user_id: u.user_id, version: u.version }).update({ user_name: d.userName, user_name_lc: lc, external_id: d.externalId, active: d.active, attributes: JSON.stringify(d.attrs), version: u.version + 1, updated_at: now });
      if (!n) return 0;
      await trx('users').where({ tenant_id: c.tenantId, id: u.user_id }).update({ username: lc, display_name: d.displayName, email: d.email, updated_at: now });
      await s.users.within(trx).upsertIdentity(u.user_id, c.provider.id, u.user_id, groupNames, d.manager);
      return n;
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new ScimError(409, 'uniqueness', `The username ${lc} is taken.`);
      throw err;
    });
    if (!moved) throw new ScimError(409, null, 'The user changed at the same time; read it and try again.');
    const changed = Object.keys({ ...json<Doc>(u.attributes, {}), ...d.attrs }).filter((k) => JSON.stringify(json<Doc>(u.attributes, {})[k]) !== JSON.stringify(d.attrs[k]));
    if (lc !== u.user_name_lc) changed.push('userName');
    if (d.externalId !== u.external_id) changed.push('externalId');
    await this.audit(c, `scim.user.${how}`, { user: u.user_id, username: lc }, { changed: changed.sort(), active: d.active });
    if (u.active && !d.active) await this.endAccess(c, u.user_id, 'SCIM: deactivated');
    else if (!u.active && d.active) await this.reactivate(c, u.user_id);
    return this.getUser(c, u.user_id);
  }

  async replaceUser(c: ScimCaller, id: string, body: Doc, ifMatch?: string) {
    const u = await this.userRow(c, id);
    this.checkMatch(ifMatch, u.version);
    return this.saveUser(c, u, normalise(body, USER_SET), 'replaced');
  }

  async patchUser(c: ScimCaller, id: string, body: Doc, ifMatch?: string) {
    const u = await this.userRow(c, id);
    this.checkMatch(ifMatch, u.version);
    const current: Doc = { userName: u.user_name, ...(u.external_id ? { externalId: u.external_id } : {}), active: u.active, ...json<Doc>(u.attributes, {}) };
    const next = applyPatch(current, body.Operations ?? body.operations, USER_SET);
    return this.saveUser(c, u, normalise(next, USER_SET), 'patched');
  }

  async deleteUser(c: ScimCaller, id: string, ifMatch?: string) {
    const u = await this.userRow(c, id);
    this.checkMatch(ifMatch, u.version);
    const s = this.s();
    const groups = ((await this.db('scim_group_members as m').join('scim_groups as g', 'g.id', 'm.group_id').where({ 'm.user_id': u.user_id, 'g.provider_id': c.provider.id }).select('g.id')) as { id: string }[]).map((g) => g.id);
    const ended = await this.endAccess(c, u.user_id, 'SCIM: deleted', false);
    await this.db.transaction(async (trx) => {
      if (groups.length) {
        await trx('scim_group_members').where({ user_id: u.user_id }).whereIn('group_id', groups).delete();
        for (const g of groups) await trx('scim_groups').where({ id: g }).increment('version', 1).update({ updated_at: Date.now() });
      }
      await trx('scim_users').where({ user_id: u.user_id }).delete();
      await trx('user_identities').where({ user_id: u.user_id, provider_id: c.provider.id }).delete();
    });
    await s.users.setRoles(u.user_id, 'mapping', []);
    await s.users.setWorkspaceMemberships(u.user_id, 'mapping', []);
    await this.audit(c, 'scim.user.deleted', { user: u.user_id, username: u.user_name_lc }, { groups: groups.length, ...ended });
  }

  /** Disables the user and ends every way they are signed in. */
  private async endAccess(c: ScimCaller, userId: string, reason: string, audit = true) {
    const s = this.s();
    const user = await s.users.get(c.tenantId, userId);
    if (!user) return { sessions: 0, grants: 0, apiKeys: 0, appPasswords: 0 };
    // An administrator's own disable keeps its reason, so SCIM never re-enables it later.
    const adminDisabled = user.state === 'disabled' && !!user.disabled_reason && !user.disabled_reason.startsWith('SCIM');
    if (!adminDisabled) await s.users.update(c.tenantId, userId, { state: 'disabled', disabled_reason: reason.slice(0, 200) });
    const out = {
      sessions: await s.sessions.revokeAllForUser(userId),
      grants: await s.account.revokeGrants(c.tenantId, userId),
      apiKeys: await s.apiKeys.revokeAllForUser(userId),
      appPasswords: await s.dav.passwords.revokeAllForUser(userId, 'scim')
    };
    if (audit) await this.audit(c, 'scim.user.deactivated', { user: userId, username: user.username }, { reason, wasActive: user.state === 'active', revoked: out });
    return out;
  }

  /** Re-enables a user the SCIM store disabled (an admin's own disable stays: it was not SCIM's). */
  private async reactivate(c: ScimCaller, userId: string): Promise<void> {
    const s = this.s();
    const user = await s.users.get(c.tenantId, userId);
    if (!user || user.state === 'active') return;
    if (user.disabled_reason && !user.disabled_reason.startsWith('SCIM')) {
      await this.audit(c, 'scim.user.reactivation-skipped', { user: userId, username: user.username }, { reason: 'Disabled by an administrator, not by SCIM; it stays disabled.' });
      return;
    }
    await s.users.update(c.tenantId, userId, { state: 'active', disabled_reason: null });
    await this.audit(c, 'scim.user.reactivated', { user: userId, username: user.username });
  }

  /**
   * Recomputes mapped roles, workspaces and clearance from the users' SCIM groups (group mappings with this store as
   * provider, else the store's defaults). Ends the sessions of each user whose access changed. Returns how many did.
   */
  async refreshAccess(c: ScimCaller, userIds: string[]): Promise<number> {
    if (!userIds.length) return 0;
    const s = this.s();
    const mappings = await s.users.mappings(c.tenantId);
    const groups = await this.groupsOf(userIds, c.provider.id);
    const managers = new Map(((await this.db('scim_users').whereIn('user_id', userIds).select('user_id', 'attributes')) as { user_id: string; attributes: string }[]).map((r) => {
      const ent = json<Doc>(r.attributes, {})[ENTERPRISE_SCHEMA];
      const m = isObj(ent) && isObj(ent.manager) && typeof ent.manager.value === 'string' ? ent.manager.value : null;
      return [r.user_id, m] as const;
    }));
    let changed = 0;
    for (const id of userIds) {
      const user = await s.users.get(c.tenantId, id);
      if (!user || !managers.has(id)) continue;
      const names = (groups.get(id) ?? []).map((g) => normaliseGroup(g.name)).filter(Boolean).sort();
      const mapped = resolveMappings(mappings, c.provider.id, names);
      const roles = mapped.roles.length ? mapped.roles : c.cfg.defaultRoles;
      const mappedClearance: Label = mapped.clearance ?? c.cfg.defaultClearance;
      const clearance = user.clearance_direct ? highest(mappedClearance, user.clearance_direct) : mappedClearance;
      const before = { roles: (await s.users.roles(id)).filter((r) => r.source === 'mapping').map((r) => r.role).sort(), clearance: user.clearance, workspaces: ((await this.db('workspace_members').where({ user_id: id, source: 'mapping' }).select('workspace_id')) as { workspace_id: string }[]).map((w) => w.workspace_id).sort() };
      await s.users.upsertIdentity(id, c.provider.id, id, names, managers.get(id) ?? null);
      await s.users.setRoles(id, 'mapping', roles);
      await s.users.setWorkspaceMemberships(id, 'mapping', mapped.workspaces);
      const all = await s.users.roleIds(id);
      await s.users.update(c.tenantId, id, { clearance, mfa_required: user.mfa_required || rolesRequireMfa(all) });
      const after = { roles: [...new Set(roles)].sort(), clearance, workspaces: [...new Set(mapped.workspaces)].sort() };
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changed++;
        const revoked = user.state === 'active' ? await s.sessions.revokeAllForUser(id) : 0;
        await this.audit(c, 'scim.user.access.changed', { user: id, username: user.username }, { groups: names, before, after, sessionsRevoked: revoked });
      }
    }
    return changed;
  }

  // ---------- groups ----------

  private async groupRow(c: ScimCaller, id: string): Promise<GroupRowS> {
    const r = await this.db('scim_groups').where({ provider_id: c.provider.id, id }).first();
    if (!r) throw new ScimError(404, null, `Group ${id.slice(0, 64)} not found.`);
    return groupFrom(r);
  }

  private async membersOf(groupIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
    const out = new Map<string, { id: string; name: string }[]>();
    for (let i = 0; i < groupIds.length; i += 500) {
      const rows = (await this.db('scim_group_members as m').join('users as u', 'u.id', 'm.user_id').whereIn('m.group_id', groupIds.slice(i, i + 500)).orderBy('u.username').select('m.group_id', 'm.user_id', 'u.display_name')) as { group_id: string; user_id: string; display_name: string }[];
      for (const r of rows) out.set(r.group_id, [...(out.get(r.group_id) ?? []), { id: r.user_id, name: r.display_name }]);
    }
    return out;
  }

  private groupResource(c: ScimCaller, g: GroupRowS, members: { id: string; name: string }[], withMembers = true): Doc {
    return {
      schemas: [GROUP_SCHEMA],
      id: g.id,
      ...(g.external_id ? { externalId: g.external_id } : {}),
      displayName: g.display_name,
      ...(withMembers ? { members: members.map((m) => ({ value: m.id, display: m.name, $ref: `${c.base}/Users/${m.id}`, type: 'User' })) } : {}),
      meta: { resourceType: 'Group', created: iso(g.created_at), lastModified: iso(g.updated_at), version: etag(g.version), location: `${c.base}/Groups/${g.id}` }
    };
  }

  /** Members are only read when the answer includes them (Entra ID asks for groups with excludedAttributes=members). */
  private wantsMembers(q: ListQuery, filter: Filter | null): boolean {
    const ex = (q.excludedAttributes ?? '').toLowerCase().split(',').map((x) => x.trim());
    const inc = (q.attributes ?? '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
    const filterNeeds = !!filter && JSON.stringify(filter).toLowerCase().includes('"attr":"members"');
    return filterNeeds || (!ex.includes('members') && (!inc.length || inc.some((a) => a === 'members' || a.startsWith('members.'))));
  }

  async getGroup(c: ScimCaller, id: string, q: ListQuery = {}) {
    const g = await this.groupRow(c, id);
    const withMembers = this.wantsMembers(q, null);
    const members = withMembers ? ((await this.membersOf([g.id])).get(g.id) ?? []) : [];
    return { resource: project(this.groupResource(c, g, members, withMembers), q.attributes, q.excludedAttributes), etag: etag(g.version) };
  }

  async listGroups(c: ScimCaller, q: ListQuery) {
    const { filter, start, count } = this.parseQuery(q);
    const withMembers = this.wantsMembers(q, filter);
    const base = () => this.db('scim_groups').where({ provider_id: c.provider.id });
    const eq = filter ? simpleEq(filter) : null;
    if (!filter || (eq && eq.attr !== 'username')) {
      const qb = base();
      if (eq?.attr === 'displayname') qb.andWhere({ display_name_lc: eq.value.toLowerCase() });
      else if (eq?.attr === 'externalid') qb.andWhere({ external_id: eq.value });
      else if (eq?.attr === 'id') qb.andWhere({ id: eq.value });
      const total = Number(((await qb.clone().count({ n: '*' }).first()) as { n: number | string } | undefined)?.n ?? 0);
      const rows = count ? ((await qb.orderBy([{ column: 'created_at' }, { column: 'id' }]).offset(start - 1).limit(count)) as Record<string, unknown>[]).map(groupFrom) : [];
      const members = withMembers ? await this.membersOf(rows.map((r) => r.id)) : new Map<string, { id: string; name: string }[]>();
      return this.listResponse(total, start, rows.map((r) => project(this.groupResource(c, r, members.get(r.id) ?? [], withMembers), q.attributes, q.excludedAttributes)));
    }
    const all = ((await base().orderBy([{ column: 'created_at' }, { column: 'id' }]).limit(SCAN_MAX + 1)) as Record<string, unknown>[]).map(groupFrom);
    if (all.length > SCAN_MAX) throw new ScimError(400, 'tooMany', `This store has more than ${SCAN_MAX} groups; filter with displayName, externalId or id eq.`);
    const members = withMembers ? await this.membersOf(all.map((r) => r.id)) : new Map<string, { id: string; name: string }[]>();
    const hits = all.map((r) => this.groupResource(c, r, members.get(r.id) ?? [], withMembers)).filter((d) => matches(d, filter!));
    return this.listResponse(hits.length, start, hits.slice(start - 1, start - 1 + count).map((d) => project(d, q.attributes, q.excludedAttributes)));
  }

  /** The member ids a group document names, each a user of this store. */
  private async memberIds(c: ScimCaller, doc: Doc): Promise<string[]> {
    const list = Array.isArray(doc.members) ? (doc.members as Doc[]) : [];
    const ids = [...new Set(list.map((m) => (typeof m.value === 'string' ? m.value : '')).filter(Boolean))];
    if (ids.length > 100_000) throw new ScimError(400, 'tooMany', 'A group holds at most 100 000 members.');
    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) for (const r of (await this.db('scim_users').where({ provider_id: c.provider.id }).whereIn('user_id', ids.slice(i, i + 500)).select('user_id')) as { user_id: string }[]) known.add(r.user_id);
    const unknown = ids.filter((x) => !known.has(x));
    if (unknown.length) throw new ScimError(400, 'invalidValue', `Not users of this store: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}.`);
    return ids;
  }

  private groupFields(doc: Doc): { displayName: string; externalId: string | null } {
    const displayName = typeof doc.displayName === 'string' ? doc.displayName.trim() : '';
    if (!displayName) throw new ScimError(400, 'invalidValue', 'displayName is required.');
    if (displayName.length > 255 || hasControl(displayName)) throw new ScimError(400, 'invalidValue', 'displayName is at most 255 characters, without control characters.');
    return { displayName, externalId: typeof doc.externalId === 'string' && doc.externalId ? doc.externalId.slice(0, 255) : null };
  }

  async createGroup(c: ScimCaller, body: Doc) {
    const doc = normalise(body, GROUP_SET);
    const f = this.groupFields(doc);
    const members = await this.memberIds(c, doc);
    const now = Date.now();
    const g: GroupRowS = { id: ulid(), tenant_id: c.tenantId, provider_id: c.provider.id, display_name: f.displayName, display_name_lc: f.displayName.toLowerCase(), external_id: f.externalId, version: 1, created_at: now, updated_at: now };
    try {
      await this.db.transaction(async (trx) => {
        await trx('scim_groups').insert(g);
        for (let i = 0; i < members.length; i += 500) await trx('scim_group_members').insert(members.slice(i, i + 500).map((u) => ({ group_id: g.id, user_id: u, tenant_id: c.tenantId })));
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ScimError(409, 'uniqueness', `A group named ${f.displayName} exists in this store.`);
      throw err;
    }
    await this.audit(c, 'scim.group.created', { group: g.id, name: f.displayName }, { externalId: f.externalId, members: members.length });
    await this.refreshAccess(c, members);
    return this.getGroup(c, g.id);
  }

  private async saveGroup(c: ScimCaller, g: GroupRowS, doc: Doc, how: 'replaced' | 'patched') {
    const f = this.groupFields(doc);
    const next = await this.memberIds(c, doc);
    const before = ((await this.db('scim_group_members').where({ group_id: g.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
    const added = next.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !next.includes(x));
    const renamed = f.displayName !== g.display_name;
    const moved = await this.db.transaction(async (trx) => {
      const n = await trx('scim_groups').where({ id: g.id, version: g.version }).update({ display_name: f.displayName, display_name_lc: f.displayName.toLowerCase(), external_id: f.externalId, version: g.version + 1, updated_at: Date.now() });
      if (!n) return 0;
      for (let i = 0; i < removed.length; i += 500) await trx('scim_group_members').where({ group_id: g.id }).whereIn('user_id', removed.slice(i, i + 500)).delete();
      for (let i = 0; i < added.length; i += 500) await trx('scim_group_members').insert(added.slice(i, i + 500).map((u) => ({ group_id: g.id, user_id: u, tenant_id: c.tenantId })));
      return n;
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new ScimError(409, 'uniqueness', `A group named ${f.displayName} exists in this store.`);
      throw err;
    });
    if (!moved) throw new ScimError(409, null, 'The group changed at the same time; read it and try again.');
    await this.audit(c, `scim.group.${how}`, { group: g.id, name: f.displayName }, { renamed: renamed ? { from: g.display_name, to: f.displayName } : undefined, added: added.length, removed: removed.length });
    await this.refreshAccess(c, renamed ? [...new Set([...next, ...removed])] : [...added, ...removed]);
    return this.getGroup(c, g.id);
  }

  async replaceGroup(c: ScimCaller, id: string, body: Doc, ifMatch?: string) {
    const g = await this.groupRow(c, id);
    this.checkMatch(ifMatch, g.version);
    return this.saveGroup(c, g, normalise(body, GROUP_SET), 'replaced');
  }

  async patchGroup(c: ScimCaller, id: string, body: Doc, ifMatch?: string) {
    const g = await this.groupRow(c, id);
    this.checkMatch(ifMatch, g.version);
    const members = (await this.membersOf([g.id])).get(g.id) ?? [];
    const current: Doc = { displayName: g.display_name, ...(g.external_id ? { externalId: g.external_id } : {}), members: members.map((m) => ({ value: m.id })) };
    return this.saveGroup(c, g, normalise(applyPatch(current, body.Operations ?? body.operations, GROUP_SET), GROUP_SET), 'patched');
  }

  async deleteGroup(c: ScimCaller, id: string, ifMatch?: string) {
    const g = await this.groupRow(c, id);
    this.checkMatch(ifMatch, g.version);
    const members = ((await this.db('scim_group_members').where({ group_id: g.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
    await this.db.transaction(async (trx) => {
      await trx('scim_group_members').where({ group_id: g.id }).delete();
      await trx('scim_groups').where({ id: g.id }).delete();
    });
    await this.audit(c, 'scim.group.deleted', { group: g.id, name: g.display_name }, { members: members.length });
    await this.refreshAccess(c, members);
  }
}


