import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { clears, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { actorFrom, isUniqueViolation, type AuditActor, type AuditKind } from '../audit/chain.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { scrubError } from '../platform/diagnostics.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { leasePassword, leaseUsername, SCHEMA_NAME, type DbAdmin, type DbAdminFactory, type Dialect, type EngineTarget, type LeaseGrant, type Privileges } from './db-engines.js';
import { databasePolicyPath } from './policy.js';

/*
 * Database leases (B-1704): short-lived accounts on a tenant's own PostgreSQL or MySQL server, made by the built-in
 * engines when OpenBao is not the source (B-416 covers OpenBao for data connections).
 *
 * - An engine is registered by a holder of `connections:manage`, in a zone whose ceiling covers the engine's label
 *   (the zone checks of B-415), with an admin login whose password is sealed with the tenant key or is a `vault:`
 *   reference read as the registering user. Roles name a privilege template (read, read-write) and the schemas (or
 *   MySQL databases) it applies to.
 * - A lease is issued to a holder of `secrets:read` whose vault policy grants `read` on `database/<engine>/<role>` and
 *   whose clearance reaches the engine's label. The password is returned once and never stored; the user name and the
 *   expiry are. PostgreSQL accounts also carry `VALID UNTIL`, so the login stops working at expiry even before the
 *   sweeper runs.
 * - Renewal moves the expiry by the role's TTL, never past the lease's maximum. Revocation and expiry drop the
 *   account; a drop the database refuses is retried by the sweeper with back-off, and the admins are told.
 */

interface EngineRow {
  id: string;
  tenant_id: string;
  name: string;
  dialect: Dialect;
  endpoint: string;
  database: string | null;
  tls: boolean;
  zone: string;
  label: Label;
  admin_username: string;
  admin_password_sealed: string | null;
  admin_password_ref: string | null;
  user_host: string;
  default_ttl_s: number;
  max_ttl_s: number;
  state: 'active' | 'disabled';
  owner_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface RoleRow {
  id: string;
  tenant_id: string;
  engine_id: string;
  name: string;
  privileges: Privileges;
  schemas: string;
  default_ttl_s: number | null;
  max_ttl_s: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

type LeaseState = 'active' | 'revoking' | 'revoked' | 'expired';

interface LeaseRow {
  id: string;
  tenant_id: string;
  engine_id: string;
  engine_name: string;
  role_id: string;
  role_name: string;
  grants: string;
  label: Label;
  username: string;
  state: LeaseState;
  issued_to: string | null;
  api_key_id: string | null;
  issued_at: number;
  expires_at: number;
  max_expires_at: number;
  renewals: number;
  ended_at: number | null;
  ended_by: string | null;
  end_reason: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number | null;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1';

const engineFrom = (r: Record<string, unknown>): EngineRow => ({ ...(r as unknown as EngineRow), tls: bool(r.tls), default_ttl_s: num(r.default_ttl_s), max_ttl_s: num(r.max_ttl_s), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const roleFrom = (r: Record<string, unknown>): RoleRow => ({ ...(r as unknown as RoleRow), default_ttl_s: numOrNull(r.default_ttl_s), max_ttl_s: numOrNull(r.max_ttl_s), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const leaseFrom = (r: Record<string, unknown>): LeaseRow => ({
  ...(r as unknown as LeaseRow),
  issued_at: num(r.issued_at),
  expires_at: num(r.expires_at),
  max_expires_at: num(r.max_expires_at),
  renewals: num(r.renewals),
  ended_at: numOrNull(r.ended_at),
  attempts: num(r.attempts),
  next_attempt_at: numOrNull(r.next_attempt_at)
});

export const leaseView = (l: LeaseRow) => ({
  id: l.id,
  engine: l.engine_name,
  role: l.role_name,
  username: l.username,
  label: l.label,
  state: l.state,
  issuedTo: l.issued_to,
  issuedAt: l.issued_at,
  expiresAt: l.expires_at,
  maxExpiresAt: l.max_expires_at,
  renewals: l.renewals,
  endedAt: l.ended_at,
  endReason: l.end_reason,
  attempts: l.attempts,
  lastError: l.last_error
});

const roleView = (r: RoleRow, e: EngineRow) => ({
  name: r.name,
  privileges: r.privileges,
  schemas: json<string[]>(r.schemas, []),
  defaultTtlSeconds: r.default_ttl_s ?? e.default_ttl_s,
  maxTtlSeconds: r.max_ttl_s ?? e.max_ttl_s,
  policyPath: databasePolicyPath(e.name, r.name),
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

export interface EngineInput {
  name: string;
  dialect: Dialect;
  endpoint: string;
  database: string | null;
  tls: boolean;
  zone: string;
  label: Label;
  adminUsername: string;
  /** Exactly one of a password (sealed) or a `vault:path#key` reference. */
  adminPassword?: string | null;
  adminPasswordRef?: string | null;
  userHost: string;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  /** Log in and check the admin can create accounts before saving (default). */
  check: boolean;
}

export interface RoleInput {
  privileges: Privileges;
  schemas?: string[];
  defaultTtlSeconds?: number | null;
  maxTtlSeconds?: number | null;
}

interface Ctx {
  ip?: string | null;
  traceId?: string | null;
}

const SWEEP_JOB = 'vault.leases.sweep';
/** How long a claimed lease stays with one sweeper before another may try it. */
const CLAIM_MS = 5 * 60_000;
const backoff = (attempts: number): number => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

export class DatabaseLeases {
  constructor(
    private readonly s: () => Services,
    private readonly opts: { admins: DbAdminFactory; defaultTtlS: number; maxTtlS: number; sweepSeconds: number }
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(SWEEP_JOB, async (p, ctx) => {
      const out = await this.sweep(String(p.tenantId ?? ctx.job.tenant_id));
      await ctx.progress(100, `${out.ended} ended, ${out.failed} to retry`);
      return out;
    });
  }

  /** Every tenant with a lease past its expiry (or a drop to retry) gets one sweep per interval. */
  schedule(scheduler: Scheduler): void {
    scheduler.every(SWEEP_JOB, this.opts.sweepSeconds * 1000, async () => {
      const now = Date.now();
      const rows = (await this.db('vault_db_leases')
        .where((q) => q.where('state', 'active').andWhere('expires_at', '<=', now))
        .orWhere((q) => q.where('state', 'revoking').andWhere((w) => w.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now)))
        .distinct('tenant_id')) as { tenant_id: string }[];
      return rows.map((r) => ({ tenantId: r.tenant_id, payload: { tenantId: r.tenant_id } }));
    });
  }

  private audit(tenantId: string, action: string, kind: AuditKind, actor: AuditActor, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>, traceId?: string | null) {
    return this.s().audit.append({ tenantId, action, kind, actor, target, label, ...(detail ? { detail } : {}), traceId: traceId ?? null });
  }

  private static isAdmin(p: Principal): boolean {
    const perms = effectivePermissions(p);
    return perms.has('connections:manage') || perms.has('secrets:admin');
  }

  // ---------- engines ----------

  private async engineRow(tenantId: string, name: string, clearance: Label): Promise<EngineRow> {
    const r = await this.db('vault_db_engines').where({ tenant_id: tenantId, name }).first();
    if (!r) throw notFound('Database engine');
    const e = engineFrom(r);
    if (!clears(clearance, e.label)) throw notFound('Database engine');
    return e;
  }

  private async rolesOf(engineId: string): Promise<RoleRow[]> {
    return ((await this.db('vault_db_roles').where({ engine_id: engineId }).orderBy('name')) as Record<string, unknown>[]).map(roleFrom);
  }

  private async engineView(e: EngineRow) {
    const active = (await this.db('vault_db_leases').where({ engine_id: e.id }).whereIn('state', ['active', 'revoking']).count({ n: '*' }).first()) as { n: number | string } | undefined;
    return {
      name: e.name,
      dialect: e.dialect,
      endpoint: e.endpoint,
      database: e.database,
      tls: e.tls,
      zone: e.zone,
      label: e.label,
      adminUsername: e.admin_username,
      adminPasswordFrom: e.admin_password_ref ? 'vault' : 'sealed',
      adminPasswordRef: e.admin_password_ref,
      userHost: e.user_host,
      defaultTtlSeconds: e.default_ttl_s,
      maxTtlSeconds: e.max_ttl_s,
      state: e.state,
      activeLeases: Number(active?.n ?? 0),
      roles: (await this.rolesOf(e.id)).map((r) => roleView(r, e)),
      createdBy: e.created_by,
      createdAt: e.created_at,
      updatedAt: e.updated_at
    };
  }

  async listEngines(p: Principal) {
    const rows = ((await this.db('vault_db_engines').where({ tenant_id: p.tenantId }).orderBy('name')) as Record<string, unknown>[]).map(engineFrom).filter((e) => clears(p.clearance, e.label));
    return Promise.all(rows.map((e) => this.engineView(e)));
  }

  async getEngine(p: Principal, name: string) {
    return this.engineView(await this.engineRow(p.tenantId, name, p.clearance));
  }

  /** The admin login for an engine: the sealed password, or the vault reference read as the user who saved it. */
  private async target(e: EngineRow, traceId?: string | null): Promise<EngineTarget> {
    let password: string;
    if (e.admin_password_ref) password = await this.s().vault.resolveFor(e.tenant_id, e.owner_id, e.admin_password_ref, { via: `database-engine:${e.id}`, traceId: traceId ?? null });
    else if (e.admin_password_sealed) password = await this.s().keys.open(e.tenant_id, e.admin_password_sealed, `vault-db-engine:${e.id}`);
    else throw conflict(`${e.name} has no admin password.`);
    return { dialect: e.dialect, endpoint: e.endpoint, database: e.database, tls: e.tls, adminUsername: e.admin_username, adminPassword: password, userHost: e.user_host };
  }

  /** Runs one admin operation; database errors become a 502 with any credential masked. */
  private async withAdmin<T>(e: EngineRow, what: string, fn: (a: DbAdmin) => Promise<T>, traceId?: string | null): Promise<T> {
    const t = await this.target(e, traceId);
    try {
      return await fn(this.opts.admins(t));
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(502, 'Database refused', `${what} on ${e.name}: ${scrubError(err, [t.adminPassword]).slice(0, 400)}`, { extensions: { engine: e.name } });
    }
  }

  private checkTtls(defaultTtl: number, maxTtl: number): void {
    if (maxTtl > this.opts.maxTtlS) throw badRequest(`The maximum TTL is at most ${this.opts.maxTtlS} seconds on this server (VAULT_LEASE_MAX_TTL_SECONDS).`);
    if (defaultTtl > maxTtl) throw badRequest('The default TTL cannot be longer than the maximum TTL.');
  }

  private async checkPlacement(p: Principal, zone: string, label: Label): Promise<void> {
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; a ${label} database is above it.`, { step: 'clearance' });
    await this.s().zones.assertMemberFits('database engine', zone, label);
  }

  async registerEngine(p: Principal, input: EngineInput, ctx: Ctx = {}) {
    if (!!input.adminPassword === !!input.adminPasswordRef) throw badRequest('Give the admin password, or a vault reference to it (adminPasswordRef), not both.');
    if (input.dialect === 'mysql' && !input.database) throw badRequest('A MySQL engine names the database its roles are granted on by default.');
    this.checkTtls(input.defaultTtlSeconds, input.maxTtlSeconds);
    try {
      await this.checkPlacement(p, input.zone, input.label);
    } catch (err) {
      await this.audit(p.tenantId, 'vault.database.engine.refused', 'admin', actorFrom(p, ctx.ip), { engine: input.name }, input.label, { zone: input.zone, reason: (err as Error).message }, ctx.traceId);
      throw err;
    }
    if (input.adminPasswordRef) await this.s().vault.assertRefsReadable(p, [input.adminPasswordRef], ctx);
    const id = ulid();
    const now = Date.now();
    const row: EngineRow = {
      id,
      tenant_id: p.tenantId,
      name: input.name,
      dialect: input.dialect,
      endpoint: input.endpoint,
      database: input.database,
      tls: input.tls,
      zone: input.zone,
      label: input.label,
      admin_username: input.adminUsername,
      admin_password_sealed: input.adminPassword ? await this.s().keys.seal(p.tenantId, input.adminPassword, `vault-db-engine:${id}`) : null,
      admin_password_ref: input.adminPasswordRef ?? null,
      user_host: input.userHost,
      default_ttl_s: input.defaultTtlSeconds,
      max_ttl_s: input.maxTtlSeconds,
      state: 'active',
      owner_id: p.userId,
      created_by: p.userId,
      created_at: now,
      updated_at: now
    };
    let check: { version: string; canCreate: boolean; detail: string } | null = null;
    if (input.check) {
      check = await this.withAdmin(row, 'Checking the admin login', (a) => a.test(10_000), ctx.traceId);
      if (!check.canCreate) throw new HttpProblem(422, 'Admin cannot create accounts', check.detail, { extensions: { engine: input.name } });
    }
    try {
      await this.db('vault_db_engines').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A database engine named ${input.name} exists.`);
      throw err;
    }
    await this.audit(p.tenantId, 'vault.database.engine.registered', 'admin', actorFrom(p, ctx.ip), { engine: row.name }, row.label, { dialect: row.dialect, endpoint: row.endpoint, database: row.database, zone: row.zone, adminUsername: row.admin_username, adminPasswordFrom: row.admin_password_ref ? 'vault' : 'sealed', checked: !!check }, ctx.traceId);
    return { ...(await this.engineView(row)), ...(check ? { check } : {}) };
  }

  async updateEngine(p: Principal, name: string, patch: Partial<Pick<EngineInput, 'endpoint' | 'database' | 'tls' | 'zone' | 'label' | 'adminUsername' | 'adminPassword' | 'adminPasswordRef' | 'userHost' | 'defaultTtlSeconds' | 'maxTtlSeconds'>> & { state?: 'active' | 'disabled' }, ctx: Ctx = {}) {
    const e = await this.engineRow(p.tenantId, name, p.clearance);
    if (patch.adminPassword && patch.adminPasswordRef) throw badRequest('Give the admin password, or a vault reference to it, not both.');
    const zone = patch.zone ?? e.zone;
    const label = patch.label ?? e.label;
    if (patch.zone !== undefined || patch.label !== undefined) await this.checkPlacement(p, zone, label);
    this.checkTtls(patch.defaultTtlSeconds ?? e.default_ttl_s, patch.maxTtlSeconds ?? e.max_ttl_s);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    for (const [k, col] of [['endpoint', 'endpoint'], ['database', 'database'], ['tls', 'tls'], ['zone', 'zone'], ['label', 'label'], ['adminUsername', 'admin_username'], ['userHost', 'user_host'], ['defaultTtlSeconds', 'default_ttl_s'], ['maxTtlSeconds', 'max_ttl_s'], ['state', 'state']] as const) {
      if (patch[k] !== undefined) upd[col] = patch[k];
    }
    if (patch.adminPasswordRef) {
      await this.s().vault.assertRefsReadable(p, [patch.adminPasswordRef], ctx);
      Object.assign(upd, { admin_password_ref: patch.adminPasswordRef, admin_password_sealed: null, owner_id: p.userId });
    } else if (patch.adminPassword) {
      Object.assign(upd, { admin_password_sealed: await this.s().keys.seal(p.tenantId, patch.adminPassword, `vault-db-engine:${e.id}`), admin_password_ref: null, owner_id: p.userId });
    }
    await this.db('vault_db_engines').where({ id: e.id }).update(upd);
    const changed = Object.keys(patch).filter((k) => k !== 'adminPassword' || !!patch.adminPassword);
    await this.audit(p.tenantId, 'vault.database.engine.updated', 'admin', actorFrom(p, ctx.ip), { engine: e.name }, label, { changed }, ctx.traceId);
    return this.getEngine(p, e.name);
  }

  async testEngine(p: Principal, name: string, ctx: Ctx = {}) {
    const e = await this.engineRow(p.tenantId, name, p.clearance);
    const t0 = Date.now();
    let out: { ok: boolean; version?: string; canCreate?: boolean; detail: string; ms: number };
    try {
      const r = await this.withAdmin(e, 'Checking the admin login', (a) => a.test(10_000), ctx.traceId);
      out = { ok: r.canCreate, version: r.version, canCreate: r.canCreate, detail: r.detail, ms: Date.now() - t0 };
    } catch (err) {
      out = { ok: false, detail: err instanceof HttpProblem ? (err.detail ?? err.title) : String(err), ms: Date.now() - t0 };
    }
    await this.audit(p.tenantId, 'vault.database.engine.tested', 'admin', actorFrom(p, ctx.ip), { engine: e.name }, e.label, { ok: out.ok, ms: out.ms }, ctx.traceId);
    return out;
  }

  /** Removes an engine after revoking its live leases; refuses while any account could not be dropped. */
  async removeEngine(p: Principal, name: string, ctx: Ctx = {}): Promise<void> {
    const e = await this.engineRow(p.tenantId, name, p.clearance);
    const live = ((await this.db('vault_db_leases').where({ engine_id: e.id }).whereIn('state', ['active', 'revoking'])) as Record<string, unknown>[]).map(leaseFrom);
    const failed: string[] = [];
    for (const l of live) if (!(await this.end(l, 'revoked', actorFrom(p, ctx.ip), p.userId, ctx.traceId))) failed.push(l.username);
    if (failed.length) throw conflict(`${failed.length} account${failed.length === 1 ? '' : 's'} could not be dropped (${failed.slice(0, 5).join(', ')}); the engine stays until they are. The sweeper keeps trying.`);
    await this.db.transaction(async (trx) => {
      await trx('vault_db_roles').where({ engine_id: e.id }).delete();
      await trx('vault_db_engines').where({ id: e.id }).delete();
    });
    await this.audit(p.tenantId, 'vault.database.engine.removed', 'admin', actorFrom(p, ctx.ip), { engine: e.name }, e.label, { revoked: live.length }, ctx.traceId);
  }

  // ---------- roles ----------

  async putRole(p: Principal, engineName: string, roleName: string, input: RoleInput, ctx: Ctx = {}) {
    const e = await this.engineRow(p.tenantId, engineName, p.clearance);
    const schemas = [...new Set(input.schemas?.length ? input.schemas : e.dialect === 'postgres' ? ['public'] : [e.database!])];
    if (schemas.some((x) => !SCHEMA_NAME.test(x))) throw badRequest('Schema and database names are letters, digits, _, $ and -, starting with a letter or _.');
    const maxTtl = input.maxTtlSeconds ?? e.max_ttl_s;
    const defTtl = input.defaultTtlSeconds ?? Math.min(e.default_ttl_s, maxTtl);
    if (maxTtl > e.max_ttl_s) throw badRequest(`A role's maximum TTL cannot pass the engine's (${e.max_ttl_s} seconds).`);
    if (defTtl > maxTtl) throw badRequest('The default TTL cannot be longer than the maximum TTL.');
    const now = Date.now();
    const existing = await this.db('vault_db_roles').where({ engine_id: e.id, name: roleName }).first('id');
    const values = { privileges: input.privileges, schemas: JSON.stringify(schemas), default_ttl_s: input.defaultTtlSeconds ?? null, max_ttl_s: input.maxTtlSeconds ?? null, updated_at: now };
    if (existing) await this.db('vault_db_roles').where({ id: (existing as { id: string }).id }).update(values);
    else await this.db('vault_db_roles').insert({ id: ulid(), tenant_id: p.tenantId, engine_id: e.id, name: roleName, ...values, created_by: p.userId, created_at: now });
    await this.audit(p.tenantId, 'vault.database.role.saved', 'admin', actorFrom(p, ctx.ip), { engine: e.name, role: roleName }, e.label, { privileges: input.privileges, schemas, created: !existing }, ctx.traceId);
    const row = roleFrom((await this.db('vault_db_roles').where({ engine_id: e.id, name: roleName }).first()) as Record<string, unknown>);
    return roleView(row, e);
  }

  async removeRole(p: Principal, engineName: string, roleName: string, ctx: Ctx = {}): Promise<void> {
    const e = await this.engineRow(p.tenantId, engineName, p.clearance);
    const r = await this.db('vault_db_roles').where({ engine_id: e.id, name: roleName }).first('id');
    if (!r) throw notFound('Role');
    const live = (await this.db('vault_db_leases').where({ engine_id: e.id, role_name: roleName }).whereIn('state', ['active', 'revoking']).count({ n: '*' }).first()) as { n: number | string } | undefined;
    if (Number(live?.n ?? 0)) throw conflict(`${roleName} has ${live!.n} live lease(s); revoke them or let them expire first.`);
    await this.db('vault_db_roles').where({ id: (r as { id: string }).id }).delete();
    await this.audit(p.tenantId, 'vault.database.role.removed', 'admin', actorFrom(p, ctx.ip), { engine: e.name, role: roleName }, e.label, undefined, ctx.traceId);
  }

  /** The roles the caller may take a lease for (their policy's `list` or `read` on the role path, and clearance). */
  async issuableRoles(p: Principal) {
    const engines = ((await this.db('vault_db_engines').where({ tenant_id: p.tenantId, state: 'active' }).orderBy('name')) as Record<string, unknown>[]).map(engineFrom).filter((e) => clears(p.clearance, e.label));
    if (!engines.length) return [];
    const roles = ((await this.db('vault_db_roles').whereIn('engine_id', engines.map((e) => e.id)).orderBy('name')) as Record<string, unknown>[]).map(roleFrom);
    const byId = new Map(engines.map((e) => [e.id, e]));
    const c = await this.s().vault.callerFor(p);
    const paths = roles.map((r) => databasePolicyPath(byId.get(r.engine_id)!.name, r.name));
    const [canList, canRead] = await Promise.all([this.s().vault.allowedPaths(c, paths, 'list'), this.s().vault.allowedPaths(c, paths, 'read')]);
    return roles
      .filter((_, i) => canList.has(paths[i]!) || canRead.has(paths[i]!))
      .map((r) => {
        const e = byId.get(r.engine_id)!;
        return { engine: e.name, dialect: e.dialect, endpoint: e.endpoint, database: e.database, label: e.label, ...roleView(r, e), canIssue: canRead.has(databasePolicyPath(e.name, r.name)) };
      });
  }

  // ---------- leases ----------

  /** Issues a lease: the account exists in the database before the password is returned, once. */
  async issue(p: Principal, engineName: string, roleName: string, input: { ttlSeconds?: number }, ctx: Ctx = {}) {
    const e = await this.engineRow(p.tenantId, engineName, p.clearance);
    const c = await this.s().vault.callerFor(p, ctx);
    await this.s().vault.authorize(c, databasePolicyPath(e.name, roleName), 'read');
    if (e.state !== 'active') throw conflict(`${e.name} is disabled; it issues no leases.`);
    const r = await this.db('vault_db_roles').where({ engine_id: e.id, name: roleName }).first();
    if (!r) throw notFound('Role');
    const role = roleFrom(r);
    const maxTtl = role.max_ttl_s ?? e.max_ttl_s;
    const ttl = Math.min(input.ttlSeconds ?? role.default_ttl_s ?? e.default_ttl_s, maxTtl);
    const grant: LeaseGrant = { privileges: role.privileges, schemas: json<string[]>(role.schemas, []) };
    const now = Date.now();
    const id = ulid();
    const username = leaseUsername(role.name);
    const password = leasePassword();
    const row: LeaseRow = {
      id,
      tenant_id: p.tenantId,
      engine_id: e.id,
      engine_name: e.name,
      role_id: role.id,
      role_name: role.name,
      grants: JSON.stringify(grant),
      label: e.label,
      username,
      state: 'active',
      issued_to: p.userId,
      api_key_id: p.apiKeyId,
      issued_at: now,
      expires_at: now + ttl * 1000,
      max_expires_at: now + maxTtl * 1000,
      renewals: 0,
      ended_at: null,
      ended_by: null,
      end_reason: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null
    };
    // The row first: if this instance stops half way, the sweeper still finds the account and drops it at expiry.
    await this.db('vault_db_leases').insert(row);
    try {
      await this.withAdmin(e, 'Creating the account', (a) => a.createUser(username, password, new Date(row.expires_at), grant), ctx.traceId);
    } catch (err) {
      await this.withAdmin(e, 'Cleaning up', (a) => a.dropUser(username, grant), ctx.traceId).catch(() => undefined);
      await this.db('vault_db_leases').where({ id }).update({ state: 'revoked', ended_at: Date.now(), end_reason: 'issue-failed', last_error: (err instanceof HttpProblem ? (err.detail ?? err.title) : String(err)).slice(0, 500) });
      await this.audit(p.tenantId, 'vault.database.lease.failed', 'admin', actorFrom(p, ctx.ip), { lease: id, engine: e.name, role: role.name }, e.label, { error: (err as Error).message.slice(0, 300) }, ctx.traceId);
      throw err;
    }
    await this.audit(p.tenantId, 'vault.database.lease.issued', 'decision', actorFrom(p, ctx.ip), { lease: id, engine: e.name, role: role.name, username }, e.label, { ttlSeconds: ttl, maxTtlSeconds: maxTtl, privileges: grant.privileges, schemas: grant.schemas }, ctx.traceId);
    return {
      ...leaseView(row),
      leaseDurationSeconds: ttl,
      renewable: true,
      password,
      connection: { dialect: e.dialect, endpoint: e.endpoint, database: e.database, tls: e.tls }
    };
  }

  private async visibleLease(p: Principal, id: string): Promise<LeaseRow> {
    const r = await this.db('vault_db_leases').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Lease');
    const l = leaseFrom(r);
    if (!clears(p.clearance, l.label)) throw notFound('Lease');
    if (l.issued_to !== p.userId && !DatabaseLeases.isAdmin(p)) throw notFound('Lease');
    return l;
  }

  async listLeases(p: Principal, opts: { all?: boolean; engine?: string; state?: LeaseState; limit?: number } = {}) {
    if (opts.all && !DatabaseLeases.isAdmin(p)) throw forbidden('Every lease in the tenant is shown to holders of connections:manage or secrets:admin.', { step: 'role', action: 'connections:manage' });
    const q = this.db('vault_db_leases').where({ tenant_id: p.tenantId });
    if (!opts.all) q.andWhere({ issued_to: p.userId });
    if (opts.engine) q.andWhere({ engine_name: opts.engine });
    if (opts.state) q.andWhere({ state: opts.state });
    const rows = ((await q.orderBy('issued_at', 'desc').limit(opts.limit ?? 200)) as Record<string, unknown>[]).map(leaseFrom).filter((l) => clears(p.clearance, l.label));
    return rows.map(leaseView);
  }

  async getLease(p: Principal, id: string) {
    return leaseView(await this.visibleLease(p, id));
  }

  /** Moves the expiry by `incrementSeconds` (the role's TTL by default), never past the lease's maximum. */
  async renew(p: Principal, id: string, incrementSeconds: number | undefined, ctx: Ctx = {}) {
    const l = await this.visibleLease(p, id);
    const now = Date.now();
    if (l.state !== 'active' || l.expires_at <= now) throw new HttpProblem(410, 'Gone', `Lease ${l.id} has ${l.state === 'active' ? 'expired' : `ended (${l.state})`}; take a new one.`, { extensions: { state: l.state } });
    const e = (await this.db('vault_db_engines').where({ id: l.engine_id }).first()) as Record<string, unknown> | undefined;
    if (!e) throw conflict('The engine of this lease was removed.');
    const engine = engineFrom(e);
    // Renewing is using the secret again: the holder's policy must still allow it (an admin renews as themselves).
    await this.s().vault.authorize(await this.s().vault.callerFor(p, ctx), databasePolicyPath(engine.name, l.role_name), 'read');
    const role = await this.db('vault_db_roles').where({ id: l.role_id }).first();
    const inc = incrementSeconds ?? (role ? (roleFrom(role).default_ttl_s ?? engine.default_ttl_s) : engine.default_ttl_s);
    const next = Math.min(now + inc * 1000, l.max_expires_at);
    const capped = next >= l.max_expires_at;
    if (next > l.expires_at) {
      await this.withAdmin(engine, 'Extending the account', (a) => a.extend(l.username, new Date(next)), ctx.traceId);
      const moved = await this.db('vault_db_leases').where({ id: l.id, state: 'active', renewals: l.renewals }).update({ expires_at: next, renewals: l.renewals + 1 });
      if (!moved) throw conflict('The lease changed at the same time; read it and try again.');
    }
    await this.audit(p.tenantId, 'vault.database.lease.renewed', 'decision', actorFrom(p, ctx.ip), { lease: l.id, engine: l.engine_name, role: l.role_name, username: l.username }, l.label, { from: l.expires_at, to: Math.max(next, l.expires_at), capped }, ctx.traceId);
    return { ...leaseView({ ...l, expires_at: Math.max(next, l.expires_at), renewals: next > l.expires_at ? l.renewals + 1 : l.renewals }), capped };
  }

  async revoke(p: Principal, id: string, ctx: Ctx = {}) {
    const l = await this.visibleLease(p, id);
    if (l.state === 'revoked' || l.state === 'expired') return leaseView(l);
    const ok = await this.end(l, 'revoked', actorFrom(p, ctx.ip), p.userId, ctx.traceId);
    const after = leaseFrom((await this.db('vault_db_leases').where({ id: l.id }).first()) as Record<string, unknown>);
    if (!ok) throw new HttpProblem(502, 'Database refused', `The account ${l.username} could not be dropped yet: ${after.last_error ?? 'unknown error'}. It is retried until it is.`, { extensions: { lease: leaseView(after) } });
    return leaseView(after);
  }

  /** Drops the account and closes the lease. On failure the lease waits in `revoking` for the sweeper. */
  private async end(l: LeaseRow, reason: 'revoked' | 'expired', actor: AuditActor, by: string | null, traceId?: string | null): Promise<boolean> {
    const e = (await this.db('vault_db_engines').where({ id: l.engine_id }).first()) as Record<string, unknown> | undefined;
    const grant = json<LeaseGrant>(l.grants, { privileges: 'read', schemas: [] });
    try {
      if (!e) throw new Error('The engine of this lease was removed.');
      const engine = engineFrom(e);
      await this.withAdmin(engine, 'Dropping the account', (a) => a.dropUser(l.username, grant), traceId);
    } catch (err) {
      const message = (err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message).slice(0, 500);
      const attempts = l.attempts + 1;
      await this.db('vault_db_leases').where({ id: l.id }).update({ state: 'revoking', end_reason: reason, attempts, last_error: message, next_attempt_at: Date.now() + backoff(attempts) });
      await this.audit(l.tenant_id, 'vault.database.lease.revoke-failed', 'system', actor, { lease: l.id, engine: l.engine_name, role: l.role_name, username: l.username }, l.label, { reason, attempts, error: message }, traceId);
      if (attempts === 1) await this.tellAdmins(l, message);
      return false;
    }
    const now = Date.now();
    await this.db('vault_db_leases').where({ id: l.id }).update({ state: reason, ended_at: now, ended_by: by, end_reason: reason, last_error: null, next_attempt_at: null });
    await this.audit(l.tenant_id, reason === 'expired' ? 'vault.database.lease.expired' : 'vault.database.lease.revoked', reason === 'expired' ? 'system' : 'decision', actor, { lease: l.id, engine: l.engine_name, role: l.role_name, username: l.username }, l.label, { issuedAt: l.issued_at, expiresAt: l.expires_at, renewals: l.renewals }, traceId);
    return true;
  }

  private async tellAdmins(l: LeaseRow, message: string): Promise<void> {
    const n = this.s().notifications;
    const admins = await n.usersWithRoles(l.tenant_id, ['connection-admin', 'tenant-admin']);
    const e = (await this.db('vault_db_engines').where({ id: l.engine_id }).first('owner_id')) as { owner_id: string | null } | undefined;
    await n
      .notify({ tenantId: l.tenant_id, userIds: [...admins, ...(e?.owner_id ? [e.owner_id] : [])], kind: 'vault', title: `A database account could not be dropped: ${l.username}`, body: `${l.engine_name}/${l.role_name}: ${message.slice(0, 300)} The sweeper keeps trying.`, label: l.label, email: true })
      .catch(() => undefined);
  }

  /**
   * The expiry sweeper: every lease past its expiry, and every drop that failed before and is due again, is claimed
   * (so two instances never work on the same lease) and ended.
   */
  async sweep(tenantId: string): Promise<{ ended: number; failed: number }> {
    const now = Date.now();
    const due = ((await this.db('vault_db_leases')
      .where({ tenant_id: tenantId })
      .andWhere((q) => q.where((w) => w.where('state', 'active').andWhere('expires_at', '<=', now)).orWhere((w) => w.where('state', 'revoking').andWhere((x) => x.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now))))
      .orderBy('expires_at')
      .limit(500)) as Record<string, unknown>[]).map(leaseFrom);
    let ended = 0;
    let failed = 0;
    for (const l of due) {
      const reason = l.state === 'active' ? 'expired' : ((l.end_reason as 'revoked' | 'expired' | null) ?? 'expired');
      const q = this.db('vault_db_leases').where({ id: l.id, state: l.state, attempts: l.attempts });
      if (l.next_attempt_at == null) q.whereNull('next_attempt_at');
      else q.andWhere({ next_attempt_at: l.next_attempt_at });
      const claimed = await q.update({ state: 'revoking', end_reason: reason, next_attempt_at: now + CLAIM_MS });
      if (!claimed) continue;
      if (await this.end({ ...l, state: 'revoking' }, reason, { service: 'vault.leases' }, null)) ended++;
      else failed++;
    }
    return { ended, failed };
  }
}

