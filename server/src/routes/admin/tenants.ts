import { Router, type Request } from 'express';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, isUniqueViolation } from '../../audit/chain.js';
import { clears, LABELS } from '../../authz/labels.js';
import { canGrant, isPermission, isRole, type Permission } from '../../authz/permissions.js';
import { explain, type Principal } from '../../authz/policy.js';
import { ip, loadPrincipal, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, conflict, forbidden, notFound } from '../../http/problem.js';
import type { Tenant, Workspace } from '../../repos/tenants.js';
import type { Services } from '../../services.js';

const limit = z.number().int().min(0).max(1e15).nullable();
const quotaSchema = z.object({ tokensPerDay: limit.optional(), gpuSecondsPerMonth: limit.optional(), trainingGpuHoursPerMonth: limit.optional() }).strict();

const isSystemAdmin = (p: Principal) => p.roles.includes('system-admin');

export const workspaceView = (w: Workspace, members?: number) => ({
  id: w.id,
  tenantId: w.tenant_id,
  name: w.name,
  slug: w.slug,
  description: w.description,
  label: w.label_ceiling,
  visibility: w.visibility,
  state: w.state,
  members: members ?? null,
  createdAt: w.created_at,
  updatedAt: w.updated_at
});

/**
 * Tenants and workspaces. A tenant admin manages their own tenant's workspaces, members and workspace quotas;
 * creating tenants, tenant totals and offboarding belong to system admins.
 */
export function tenantAdminRoutes(s: Services): Router {
  const r = Router();
  r.use(['/tenants', '/authz'], noStore, requireAuth());

  // The policy's tenant step compares the path's tenant with the caller's; only system admins cross it.
  const manage = requirePermission(s, 'tenant:manage', (req) => ({ tenantId: String(req.params.tid ?? principalOf(req).tenantId) }));
  const systemOnly = (req: Request) => {
    if (!isSystemAdmin(principalOf(req))) throw forbidden('Only a system admin can do this.', { step: 'role' });
  };

  const audit = (req: Request, tenantId: string, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    const e = { action, kind: 'admin' as const, actor: actorFrom(p, ip(req)), target: { ...target, tenant: tenantId }, ...(detail ? { detail } : {}), traceId: req.traceId };
    // Changes to another tenant are recorded in both chains.
    return Promise.all([s.audit.append({ tenantId, ...e }), ...(tenantId !== p.tenantId ? [s.audit.append({ tenantId: p.tenantId, ...e })] : [])]);
  };

  const loadTenant = async (req: Request): Promise<Tenant> => {
    const t = await s.tenants.byId(String(req.params.tid));
    if (!t) throw notFound('Tenant');
    return t;
  };
  const loadWorkspace = async (req: Request): Promise<Workspace> => {
    const w = await s.tenants.workspace(String(req.params.tid), String(req.params.wid));
    if (!w) throw notFound('Workspace');
    return w;
  };

  /** Views of several tenants: workspaces, member and user counts and keys come from one query each for the whole list. */
  const tenantViews = async (list: Tenant[]) => {
    const ids = list.map((t) => t.id);
    const [workspaces, counts, keys, users] = await Promise.all([s.tenants.workspacesFor(ids, { includeArchived: true }), s.tenants.memberCountsFor(ids), s.keys.describeMany(ids), s.tenants.userCountsFor(ids)]);
    return Promise.all(list.map((t) => tenantView(t, { workspaces: workspaces.get(t.id) ?? [], counts, key: keys.get(t.id)!, users: users.get(t.id) ?? 0 })));
  };

  const tenantView = async (t: Tenant, pre?: { workspaces: Workspace[]; counts: Map<string, number>; key: Awaited<ReturnType<typeof s.keys.describe>>; users: number }) => {
    const [{ workspaces, counts, key, users }, quota, sync] = await Promise.all([
      pre ?? (async () => ({ workspaces: await s.tenants.workspaces(t.id, { includeArchived: true }), counts: await s.tenants.memberCounts(t.id), key: await s.keys.describe(t.id), users: (await s.tenants.userCountsFor([t.id])).get(t.id) ?? 0 }))(),
      s.quotas.view(t.id, null),
      s.jobs.list(t.id, { type: 'directory.sync', limit: 1 })
    ]);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      directoryDn: t.directory_dn,
      state: t.state,
      createdAt: t.created_at,
      users,
      key: { kms: key.kms, name: key.keyName, version: key.version, state: key.state },
      quota,
      lastSync: sync[0] ? { state: sync[0].state, at: sync[0].finished_at ?? sync[0].created_at, result: sync[0].result } : null,
      workspaces: workspaces.map((w) => workspaceView(w, counts.get(w.id) ?? 0))
    };
  };

  // ---------- tenants ----------

  r.get('/tenants', requirePermission(s, 'tenant:manage'), async (req, res) => {
    const p = principalOf(req);
    const list = isSystemAdmin(p) ? await s.tenants.list() : [(await s.tenants.byId(p.tenantId))!];
    res.json(await tenantViews(list));
  });

  r.get('/tenants/:tid', manage, async (req, res) => {
    res.json(await tenantView(await loadTenant(req)));
  });

  r.post('/tenants', requirePermission(s, 'tenant:manage'), async (req, res) => {
    systemOnly(req);
    const body = parseBody(
      z.object({
        slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        name: z.string().trim().min(1).max(200),
        directoryDn: z.string().trim().max(512).nullable().default(null)
      }),
      req.body
    );
    let t: Tenant;
    try {
      t = await s.tenants.create(body);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A tenant with that slug exists.');
      throw err;
    }
    await s.providers.create(t.id, { name: 'Local accounts', kind: 'local', position: 1000, enabled: true, config: {} });
    await s.keys.seal(t.id, 'key check', 'tenant-created'); // creates the tenant's data key now, so a KMS fault shows at once
    await audit(req, t.id, 'tenant.created', { slug: t.slug }, { name: t.name, directoryDn: t.directory_dn });
    res.status(201).json(await tenantView(t));
  });

  r.patch('/tenants/:tid', manage, async (req, res) => {
    const p = principalOf(req);
    const t = await loadTenant(req);
    const body = parseBody(
      z.object({ name: z.string().trim().min(1).max(200).optional(), directoryDn: z.string().trim().max(512).nullable().optional(), state: z.enum(['active', 'disabled']).optional() }).strict(),
      req.body
    );
    if (body.state !== undefined) {
      systemOnly(req);
      if (t.id === p.tenantId) throw forbidden('You cannot disable your own tenant.', { step: 'self' });
      if (t.state === 'offboarding' || t.state === 'offboarded') throw conflict('This tenant is offboarded; its key is destroyed and it cannot be re-enabled.');
    }
    const updated = await s.tenants.update(t.id, body);
    if (body.state === 'disabled') await s.sessions.revokeAllForTenant(t.id);
    await audit(req, t.id, body.state === 'disabled' ? 'tenant.disabled' : 'tenant.updated', { slug: t.slug }, { before: { name: t.name, directoryDn: t.directory_dn, state: t.state }, after: body });
    res.json(await tenantView(updated));
  });

  r.post('/tenants/:tid/offboard', manage, async (req, res) => {
    systemOnly(req);
    const p = principalOf(req);
    const t = await loadTenant(req);
    const body = parseBody(z.object({ confirm: z.string() }), req.body);
    if (body.confirm !== t.name) throw badRequest('Type the tenant name exactly to confirm.');
    if (t.id === p.tenantId) throw forbidden('You cannot offboard your own tenant.', { step: 'self' });
    if (t.state === 'offboarding' || t.state === 'offboarded') throw conflict('This tenant is already offboarded or being offboarded.');
    const result = await s.offboarding.start(t.id, p.userId);
    await audit(req, t.id, 'tenant.offboarded', { slug: t.slug }, { ...result, steps: ['key destroyed', 'sessions and API keys revoked', 'deletion job queued'] });
    res.status(202).json(result);
  });

  // ---------- quotas ----------

  r.get('/tenants/:tid/quota', manage, async (req, res) => {
    const t = await loadTenant(req);
    res.json(await s.quotas.view(t.id, null));
  });

  r.put('/tenants/:tid/quota', manage, async (req, res) => {
    systemOnly(req);
    const t = await loadTenant(req);
    const body = parseBody(quotaSchema, req.body);
    const before = await s.quotas.limits(t.id, null);
    await s.quotas.set(t.id, null, body, principalOf(req).userId);
    await audit(req, t.id, 'quota.updated', { scope: 'tenant' }, { before, after: body });
    res.json(await s.quotas.view(t.id, null));
  });

  // ---------- conversation retention (Sprint 12) ----------

  const retentionView = async (tenantId: string) => {
    const r = (await s.db('chat_retention').where({ tenant_id: tenantId }).first()) as { conversation_days: number | null; updated_by: string | null; updated_at: number; last_run_at: number | null; last_purged: number | null } | undefined;
    return { conversationDays: r?.conversation_days == null ? null : Number(r.conversation_days), updatedBy: r?.updated_by ?? null, updatedAt: r ? Number(r.updated_at) : null, lastRunAt: r?.last_run_at == null ? null : Number(r.last_run_at), lastPurged: r?.last_purged == null ? null : Number(r.last_purged), sweepMinutes: s.cfg.CHAT_RETENTION_SWEEP_MINUTES, scopes: await retentionScopes(tenantId) };
  };

  /** Sprint 16 (B-707): shorter periods for a workspace or a user; the shortest period that applies wins. */
  const retentionScopes = async (tenantId: string) => {
    const rows = (await s.db('chat_retention_scopes').where({ tenant_id: tenantId }).orderBy([{ column: 'scope' }, { column: 'conversation_days' }])) as { id: string; scope: 'workspace' | 'user'; scope_id: string; conversation_days: number; updated_by: string | null; updated_at: number }[];
    const out = [];
    for (const x of rows) {
      const name = x.scope === 'workspace' ? ((await s.tenants.workspace(tenantId, x.scope_id))?.name ?? null) : ((await s.users.get(tenantId, x.scope_id))?.display_name ?? null);
      out.push({ id: x.id, scope: x.scope, scopeId: x.scope_id, name, conversationDays: Number(x.conversation_days), updatedBy: x.updated_by, updatedAt: Number(x.updated_at) });
    }
    return out;
  };

  r.get('/tenants/:tid/retention', manage, async (req, res) => {
    res.json(await retentionView((await loadTenant(req)).id));
  });

  /** Conversations not updated for more than this many days are deleted by a scheduled job; null keeps them. */
  r.put('/tenants/:tid/retention', manage, async (req, res) => {
    const t = await loadTenant(req);
    const body = parseBody(z.object({ conversationDays: z.number().int().min(1).max(3650).nullable() }).strict(), req.body);
    const before = await retentionView(t.id);
    const row = { conversation_days: body.conversationDays, updated_by: principalOf(req).userId, updated_at: Date.now() };
    if (!(await s.db('chat_retention').where({ tenant_id: t.id }).update(row))) await s.db('chat_retention').insert({ tenant_id: t.id, ...row });
    await audit(req, t.id, 'tenant.retention.updated', { slug: t.slug }, { before: before.conversationDays, after: body.conversationDays });
    res.json(await retentionView(t.id));
  });

  /**
   * A retention period for one workspace or one user of the tenant (null removes it). It can only shorten what applies
   * to their conversations: the shortest of the tenant's, the workspace's and the owner's periods wins.
   */
  r.put('/tenants/:tid/retention/scopes', manage, async (req, res) => {
    const t = await loadTenant(req);
    const body = parseBody(z.object({ scope: z.enum(['workspace', 'user']), scopeId: z.string().length(26), conversationDays: z.number().int().min(1).max(3650).nullable() }).strict(), req.body);
    const target = body.scope === 'workspace' ? await s.tenants.workspace(t.id, body.scopeId) : await s.users.get(t.id, body.scopeId);
    if (!target) throw notFound(body.scope === 'workspace' ? 'Workspace' : 'User');
    const where = { tenant_id: t.id, scope: body.scope, scope_id: body.scopeId };
    const before = (await s.db('chat_retention_scopes').where(where).first('conversation_days')) as { conversation_days: number } | undefined;
    if (body.conversationDays == null) await s.db('chat_retention_scopes').where(where).delete();
    else {
      const row = { conversation_days: body.conversationDays, updated_by: principalOf(req).userId, updated_at: Date.now() };
      if (!(await s.db('chat_retention_scopes').where(where).update(row))) await s.db('chat_retention_scopes').insert({ id: ulid(), ...where, ...row });
    }
    await audit(req, t.id, 'tenant.retention.scope.updated', { slug: t.slug, [body.scope]: body.scopeId }, { scope: body.scope, before: before ? Number(before.conversation_days) : null, after: body.conversationDays });
    res.json(await retentionView(t.id));
  });

  // ---------- conversation sharing settings (Sprint 16, B-706) ----------

  r.get('/tenants/:tid/sharing', manage, async (req, res) => {
    res.json(await s.sharing.settings((await loadTenant(req)).id));
  });

  /** Anonymous share links are off until a tenant admin turns them on; they only ever open `public` conversations. */
  r.put('/tenants/:tid/sharing', manage, async (req, res) => {
    const t = await loadTenant(req);
    const body = parseBody(z.object({ anonymousLinks: z.boolean(), anonymousMaxHours: z.number().int().min(1).max(30 * 24).optional() }).strict(), req.body);
    const before = await s.sharing.settings(t.id);
    const after = await s.sharing.setSettings(t.id, principalOf(req).userId, body);
    await audit(req, t.id, 'tenant.sharing.updated', { slug: t.slug }, { before, after: { anonymousLinks: after.anonymousLinks, anonymousMaxHours: after.anonymousMaxHours } });
    res.json(after);
  });

  /** Applies the policy now, as the schedule would. */
  r.post('/tenants/:tid/retention/run', manage, async (req, res) => {
    const t = await loadTenant(req);
    const policy = await retentionView(t.id);
    if (policy.conversationDays == null && !policy.scopes.length) throw conflict('This tenant keeps conversations until their owners delete them; set a retention period first.');
    const job = await s.jobs.enqueue({ tenantId: t.id, type: 'chat.retention', payload: { tenantId: t.id }, createdBy: principalOf(req).userId, maxAttempts: 1 });
    await audit(req, t.id, 'tenant.retention.run', { slug: t.slug }, { days: policy.conversationDays, job: job.id });
    res.status(202).json({ jobId: job.id });
  });

  // ---------- workspaces ----------

  r.get('/tenants/:tid/workspaces', manage, async (req, res) => {
    const t = await loadTenant(req);
    const counts = await s.tenants.memberCounts(t.id);
    res.json((await s.tenants.workspaces(t.id, { includeArchived: true })).map((w) => workspaceView(w, counts.get(w.id) ?? 0)));
  });

  r.post('/tenants/:tid/workspaces', manage, async (req, res) => {
    const p = principalOf(req);
    const t = await loadTenant(req);
    if (t.state !== 'active') throw conflict('Workspaces can only be added to an active tenant.');
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(500).nullable().default(null),
        labelCeiling: z.enum(LABELS).default('internal'),
        visibility: z.enum(['tenant', 'members']).default('members'),
        mapping: z
          .object({ group: z.string().trim().min(1).max(512), role: z.string().refine(isRole, 'Unknown role').default('member'), clearance: z.enum(LABELS), providerId: z.string().length(26).nullable().default(null) })
          .optional()
      }),
      req.body
    );
    if (!clears(p.clearance, body.labelCeiling)) throw forbidden('You cannot create a workspace with a ceiling above your own clearance.', { step: 'clearance' });
    if (body.mapping) {
      if (t.id !== p.tenantId) throw forbidden('Group mappings are managed from inside the tenant.', { step: 'tenant' });
      if (!canGrant(p.roles, body.mapping.role)) throw forbidden(`Your roles cannot grant ${body.mapping.role}.`, { step: 'role' });
      if (!clears(p.clearance, body.mapping.clearance)) throw forbidden('You cannot map a clearance above your own.', { step: 'clearance' });
    }
    let w: Workspace;
    try {
      w = await s.tenants.createWorkspace(t.id, body.name, body.labelCeiling, { description: body.description, visibility: body.visibility });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A workspace with that name exists in this tenant.');
      throw err;
    }
    const mapping = body.mapping ? await s.users.addMapping(t.id, { providerId: body.mapping.providerId, group: body.mapping.group, role: body.mapping.role, clearance: body.mapping.clearance, workspaceId: w.id }) : null;
    await audit(req, t.id, 'workspace.created', { workspace: w.id, name: w.name }, { labelCeiling: w.label_ceiling, visibility: w.visibility, mapping: mapping ? { group: mapping.group_name, role: mapping.role } : null });
    res.status(201).json(workspaceView(w, 0));
  });

  r.patch('/tenants/:tid/workspaces/:wid', manage, async (req, res) => {
    const p = principalOf(req);
    const t = await loadTenant(req);
    const w = await loadWorkspace(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        labelCeiling: z.enum(LABELS).optional(),
        visibility: z.enum(['tenant', 'members']).optional(),
        state: z.enum(['active', 'archived']).optional()
      }).strict(),
      req.body
    );
    if (body.labelCeiling && !clears(p.clearance, body.labelCeiling)) throw forbidden('You cannot raise a ceiling above your own clearance.', { step: 'clearance' });
    let updated: Workspace | undefined;
    try {
      updated = await s.tenants.updateWorkspace(t.id, w.id, body);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A workspace with that name exists in this tenant.');
      throw err;
    }
    await audit(req, t.id, body.state === 'archived' ? 'workspace.archived' : 'workspace.updated', { workspace: w.id, name: w.name }, { before: { name: w.name, labelCeiling: w.label_ceiling, visibility: w.visibility, state: w.state }, after: body });
    res.json(workspaceView(updated!));
  });

  /** Users of a tenant, for picking workspace members (system admins may be in another tenant). */
  r.get('/tenants/:tid/users', manage, async (req, res) => {
    const t = await loadTenant(req);
    const q = parseBody(z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const rows = await s.users.list(t.id, q);
    res.json(rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, clearance: u.clearance, state: u.state })));
  });

  r.get('/tenants/:tid/workspaces/:wid/members', manage, async (req, res) => {
    const w = await loadWorkspace(req);
    const rows = await s.tenants.members(w.id);
    res.json(
      await Promise.all(
        rows.map(async (m) => ({ id: m.user_id, username: m.username, displayName: m.display_name, clearance: m.clearance, state: m.state, lastLoginAt: m.last_login_at, sources: m.sources, roles: await s.users.roleIds(m.user_id) }))
      )
    );
  });

  r.post('/tenants/:tid/workspaces/:wid/members', manage, async (req, res) => {
    const t = await loadTenant(req);
    const w = await loadWorkspace(req);
    const body = parseBody(z.object({ userId: z.string().length(26) }), req.body);
    const u = await s.users.get(t.id, body.userId);
    if (!u) throw notFound('User');
    await s.tenants.addMember(w.id, u.id);
    await audit(req, t.id, 'workspace.member.added', { workspace: w.id, user: u.id, username: u.username });
    res.status(201).json({ ok: true });
  });

  r.delete('/tenants/:tid/workspaces/:wid/members/:uid', manage, async (req, res) => {
    const t = await loadTenant(req);
    const w = await loadWorkspace(req);
    const n = await s.tenants.removeMember(w.id, String(req.params.uid));
    if (!n) throw notFound('Direct membership');
    await audit(req, t.id, 'workspace.member.removed', { workspace: w.id, user: String(req.params.uid) }, { note: 'Memberships from group mappings stay until the mapping or the directory changes.' });
    res.status(204).end();
  });

  r.get('/tenants/:tid/workspaces/:wid/quota', manage, async (req, res) => {
    const w = await loadWorkspace(req);
    res.json(await s.quotas.view(w.tenant_id, w.id));
  });

  r.put('/tenants/:tid/workspaces/:wid/quota', manage, async (req, res) => {
    const w = await loadWorkspace(req);
    const body = parseBody(quotaSchema, req.body);
    // Workspace limits nest under the tenant's: a workspace cannot be given more than the tenant total.
    const tenant = await s.quotas.limits(w.tenant_id, null);
    for (const k of ['tokensPerDay', 'gpuSecondsPerMonth', 'trainingGpuHoursPerMonth'] as const) {
      const v = body[k];
      if (v != null && tenant[k] != null && v > tenant[k]) throw badRequest(`The workspace limit for ${k} cannot exceed the tenant limit of ${tenant[k]}.`);
    }
    const before = await s.quotas.limits(w.tenant_id, w.id);
    await s.quotas.set(w.tenant_id, w.id, body, principalOf(req).userId);
    await audit(req, w.tenant_id, 'quota.updated', { scope: 'workspace', workspace: w.id, name: w.name }, { before, after: body });
    res.json(await s.quotas.view(w.tenant_id, w.id));
  });

  // ---------- effective permission ----------

  /** Evaluates the policy pipeline for a user of this tenant, as the "effective permission" panel shows it. */
  r.post('/authz/evaluate', requirePermission(s, 'tenant:manage'), async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({ userId: z.string().length(26), action: z.string().refine(isPermission, 'Unknown permission'), label: z.enum(LABELS).optional(), zoneCeiling: z.enum(LABELS).optional() }),
      req.body
    );
    const u = await s.users.get(p.tenantId, body.userId);
    if (!u) throw notFound('User');
    const subject = await loadPrincipal(s, p.tenantId, u.id, {});
    const action = body.action as Permission;
    const resource = { tenantId: p.tenantId, ...(body.label ? { label: body.label } : {}), ...(body.zoneCeiling ? { zoneCeiling: body.zoneCeiling } : {}) };
    if (!subject) {
      res.json({ user: { id: u.id, username: u.username, state: u.state }, decision: { allow: false, step: 'role', reason: `The account is ${u.state}`, action, policy: 'baseline-v1' }, steps: [] });
      return;
    }
    const out = explain(subject, action, resource);
    res.json({ user: { id: u.id, username: u.username, state: u.state, roles: subject.roles, clearance: subject.clearance }, ...out });
  });

  return r;
}
