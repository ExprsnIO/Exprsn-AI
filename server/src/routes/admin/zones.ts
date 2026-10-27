import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { LABELS } from '../../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, conflict, notFound } from '../../http/problem.js';
import type { Services } from '../../services.js';
import { FORMATS } from '../../zones/render.js';
import { specPatchSchema, specSchema, ZONE_ID } from '../../zones/spec.js';

const zoneId = z.string().regex(ZONE_ID, 'A zone id');
const poolName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const reason = z.string().trim().max(500).nullable().default(null);
/** Sprint 18 (B-908): connections and MCP servers a proposal moves into the zone. */
const moveMembers = z.array(z.object({ kind: z.enum(['connection', 'mcp']), id: z.string().regex(/^[0-9A-Za-z]{26}$/) }).strict()).max(50).default([]);
const note = z.object({ note: z.string().trim().max(500).nullable().default(null) }).strict();
const address = z
  .string()
  .trim()
  .max(300)
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v) || /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):\d{1,5}$/.test(v), 'An http(s):// URL or host:port');

/**
 * Zones: definitions, ceilings, proposals with dual control, rendered configuration and endpoint health (Sprint 9).
 *
 * Zones are platform-wide, like pools: every route needs `zones:manage` (system admins only), zone rows carry no
 * tenant, and each change is audited into the acting admin's tenant chain (as pool and platform-baseline changes
 * are), with the zone and version as the target. Profiles and connections from every tenant appear only as
 * ceiling blockers and zone members, by name and label.
 */
export function zoneAdminRoutes(s: Services): Router {
  const r = Router();
  const zones = s.zones;
  r.use('/zones', noStore, requireAuth(), requirePermission(s, 'zones:manage'));

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };
  const idOf = (req: Request) => parseBody(zoneId, req.params.id);

  /** Tells the other system admins that a draft waits for them. */
  const notifyReviewers = async (req: Request, title: string) => {
    const p = principalOf(req);
    const admins = (await s.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.state': 'active', 'r.role': 'system-admin' }).distinct('u.id', 'u.tenant_id')) as { id: string; tenant_id: string }[];
    const byTenant = new Map<string, string[]>();
    for (const u of admins) if (u.id !== p.userId) byTenant.set(u.tenant_id, [...(byTenant.get(u.tenant_id) ?? []), u.id]);
    for (const [tenantId, userIds] of byTenant) await s.notifications.notify({ tenantId, userIds, kind: 'zones', title, body: `Proposed by ${p.displayName}`, route: 'zones', label: 'internal' });
    return [...byTenant.values()].reduce((a, x) => a + x.length, 0);
  };

  /**
   * B-908: when the first zone gets a current definition (an approval or the default set), connections and MCP
   * servers registered before are checked against it; the misplaced ones are audited and system admins are told,
   * so each can be moved with a proposal from the Zones screen.
   */
  const recheckIfFirst = async (req: Request, wasDefined: boolean) => {
    if (wasDefined || !(await zones.anyDefined())) return 0;
    const list = await zones.misplaced();
    if (list.length) {
      await audit(req, 'zone.members.rechecked', {}, { misplaced: list.length, members: list.slice(0, 100).map((m) => ({ kind: m.kind, id: m.id, name: m.name, zone: m.zone, suggestion: m.suggestion })) });
      const admins = (await s.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.state': 'active', 'r.role': 'system-admin' }).distinct('u.id', 'u.tenant_id')) as { id: string; tenant_id: string }[];
      const byTenant = new Map<string, string[]>();
      for (const u of admins) byTenant.set(u.tenant_id, [...(byTenant.get(u.tenant_id) ?? []), u.id]);
      for (const [tenantId, userIds] of byTenant) await s.notifications.notify({ tenantId, userIds, kind: 'zones', title: `${list.length} ${list.length === 1 ? 'member is' : 'members are'} outside their zone`, body: 'Connections and MCP servers registered before zones were defined. Review them under Zones and propose a move.', route: 'zones', label: 'internal' });
    }
    return list.length;
  };

  /** B-908: members outside what their zone admits, with a suggested zone for a one-click move proposal. */
  r.get('/zones/misplaced', async (_req, res) => {
    res.json({ misplaced: await zones.misplaced() });
  });

  r.get('/zones', async (req, res) => {
    res.json(await zones.overview(principalOf(req)));
  });

  /** Creates the default zone set for ids that do not exist yet (see ZoneService.seedDefaults). */
  r.post('/zones/seed', async (req, res) => {
    const wasDefined = await zones.anyDefined();
    const out = await zones.seedDefaults(principalOf(req));
    if (out.created.length) await audit(req, 'zone.seeded', { zones: out.created }, { adjusted: out.adjusted, skipped: out.skipped });
    const misplaced = await recheckIfFirst(req, wasDefined);
    res.status(out.created.length ? 201 : 200).json({ ...out, misplaced });
  });

  /** Rendered configuration of every current zone, as a file. */
  r.get('/zones/rendered/:format', async (req, res) => {
    const format = parseBody(z.enum(FORMATS), req.params.format);
    const out = await zones.rendered(format);
    res.type(format === 'nftables' ? 'text/plain' : 'application/yaml').setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.text);
  });

  /** Proposes a new zone: its version 1 is a draft until a second system admin approves it. */
  r.post('/zones', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ id: zoneId, spec: specSchema, movePools: z.array(poolName).max(50).default([]), reason }).strict(), req.body);
    const v = await zones.propose(p, body.id, { create: true, spec: body.spec, movePools: body.movePools, reason: body.reason });
    await audit(req, 'zone.proposed', { zone: body.id, version: v.version }, { created: true, reason: body.reason, maxLabel: v.spec.maxLabel, movePools: body.movePools });
    const notified = await notifyReviewers(req, `New zone ${body.id} waits for a second approver`);
    res.status(201).json({ zone: body.id, version: v.version, status: v.status, notified });
  });

  r.get('/zones/:id/versions', async (req, res) => {
    const id = idOf(req);
    if (!(await zones.zone(id))) throw notFound('Zone');
    const list = await zones.versions(id);
    const people = [...new Set(list.flatMap((v) => [v.proposed_by, v.decided_by]).filter((x): x is string => !!x))];
    const names = new Map(((people.length ? await s.db('users').whereIn('id', people).select('id', 'display_name') : []) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
    res.json(
      list.map((v) => ({
        version: v.version,
        status: v.status,
        spec: v.spec,
        movePools: v.move_pools,
        reason: v.reason,
        proposedBy: v.proposed_by,
        proposedByName: v.proposed_by ? (names.get(v.proposed_by) ?? null) : null,
        proposedAt: v.proposed_at,
        decidedBy: v.decided_by,
        decidedByName: v.decided_by ? (names.get(v.decided_by) ?? null) : null,
        decidedAt: v.decided_at,
        decisionNote: v.decision_note
      }))
    );
  });

  /** The rendered NetworkPolicy, Compose and nftables before and after a version, with line diffs. */
  r.get('/zones/:id/diff', async (req, res) => {
    const q = parseBody(z.object({ version: z.coerce.number().int().min(1).optional() }).strict(), req.query);
    res.json(await zones.diff(idOf(req), q.version));
  });

  /** One zone's rendered configuration at a version (default current), as a file. */
  r.get('/zones/:id/rendered/:format', async (req, res) => {
    const format = parseBody(z.enum(FORMATS), req.params.format);
    const q = parseBody(z.object({ version: z.coerce.number().int().min(1).optional() }).strict(), req.query);
    const out = await zones.rendered(format, idOf(req), q.version);
    res.type(format === 'nftables' ? 'text/plain' : 'application/yaml').setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.text);
  });

  /** What must move before the zone's ceiling can be the given label (the "Ceiling too low" list), without proposing. */
  r.get('/zones/:id/blockers', async (req, res) => {
    const id = idOf(req);
    const q = parseBody(z.object({ ceiling: z.enum(LABELS) }).strict(), req.query);
    if (!(await zones.zone(id))) throw notFound('Zone');
    res.json({ zone: id, ceiling: q.ceiling, blockers: await zones.blockers(id, q.ceiling) });
  });

  /** Proposes a change: `patch` is merged over the current definition; `movePools` move into the zone on approval. */
  r.post('/zones/:id/proposals', async (req, res) => {
    const p = principalOf(req);
    const id = idOf(req);
    const body = parseBody(z.object({ patch: specPatchSchema.default({}), movePools: z.array(poolName).max(50).default([]), moveMembers, reason }).strict(), req.body);
    const v = await zones.propose(p, id, { create: false, patch: body.patch, movePools: body.movePools, moveMembers: body.moveMembers, reason: body.reason });
    await audit(req, 'zone.proposed', { zone: id, version: v.version }, { fields: Object.keys(body.patch), reason: body.reason, maxLabel: v.spec.maxLabel, movePools: body.movePools, moveMembers: v.move_members });
    const notified = await notifyReviewers(req, `Zone ${id} v${v.version} waits for a second approver`);
    res.status(201).json({ zone: id, version: v.version, status: v.status, notified });
  });

  /** Dual control: another system admin approves the draft; it becomes current and routing follows at once. */
  r.post('/zones/:id/draft/approve', async (req, res) => {
    const id = idOf(req);
    const body = parseBody(note, req.body ?? {});
    const wasDefined = await zones.anyDefined();
    const out = await zones.approve(principalOf(req), id, body.note);
    await audit(req, 'zone.approved', { zone: id, version: out.version.version }, { previous: out.previous, proposedBy: out.version.proposed_by, movedPools: out.moved, movedMembers: out.movedMembers, maxLabel: out.version.spec.maxLabel, note: body.note });
    const misplaced = await recheckIfFirst(req, wasDefined);
    res.json({ zone: id, version: out.version.version, status: out.version.status, previous: out.previous, movedPools: out.moved, movedMembers: out.movedMembers, misplaced });
  });

  r.post('/zones/:id/draft/reject', async (req, res) => {
    const id = idOf(req);
    const body = parseBody(note, req.body ?? {});
    const v = await zones.reject(principalOf(req), id, body.note);
    await audit(req, 'zone.rejected', { zone: id, version: v.version }, { proposedBy: v.proposed_by, note: body.note });
    res.json({ zone: id, version: v.version, status: v.status });
  });

  r.post('/zones/:id/draft/withdraw', async (req, res) => {
    const id = idOf(req);
    const v = await zones.withdraw(principalOf(req), id);
    await audit(req, 'zone.withdrawn', { zone: id, version: v.version });
    res.json({ zone: id, version: v.version, status: v.status });
  });

  // ---------- endpoints and health ----------

  r.post('/zones/:id/endpoints', async (req, res) => {
    const id = idOf(req);
    const body = parseBody(z.object({ name: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'Lower case letters, digits, dots, dashes'), address, kind: z.string().trim().min(1).max(40).default('service') }).strict(), req.body);
    const e = await zones.addEndpoint(principalOf(req), id, body);
    await audit(req, 'zone.endpoint.added', { zone: id, endpoint: e.id, name: e.name }, { address: e.address, kind: e.kind });
    res.status(201).json(e);
  });

  r.delete('/zones/:id/endpoints/:endpointId', async (req, res) => {
    const id = idOf(req);
    const e = await zones.removeEndpoint(id, String(req.params.endpointId));
    await audit(req, 'zone.endpoint.removed', { zone: id, endpoint: e.id, name: e.name });
    res.status(204).end();
  });

  /** Runs the health checks of the zone's registered endpoints now. */
  r.post('/zones/:id/endpoints/check', async (req, res) => {
    const id = idOf(req);
    if (!(await zones.zone(id))) throw notFound('Zone');
    res.json(await zones.checkEndpoints(id));
  });

  /** Drains a member: an Ollama instance through the gateway (in-flight requests finish), or a registered endpoint. */
  r.post('/zones/:id/members/:action', async (req, res) => {
    const p = principalOf(req);
    const id = idOf(req);
    const action = parseBody(z.enum(['drain', 'undrain']), req.params.action);
    const body = parseBody(z.object({ ref: z.string().regex(/^(instance|endpoint):[0-9A-Z]{26}$/, 'instance:<id> or endpoint:<id>') }).strict(), req.body);
    const [kind, ref] = body.ref.split(':') as ['instance' | 'endpoint', string];
    if (kind === 'endpoint') {
      const e = await zones.setEndpointState(id, ref, action === 'drain' ? 'drained' : 'active');
      await audit(req, `zone.endpoint.${action === 'drain' ? 'drained' : 'undrained'}`, { zone: id, endpoint: e.id, name: e.name });
      res.json({ ref: body.ref, state: e.state });
      return;
    }
    const inst = await s.gateway.repo.instance(ref);
    const pool = inst ? await s.gateway.repo.pool(inst.pool_id) : undefined;
    if (!inst || !pool || pool.zone !== id) throw notFound('Instance');
    if (action === 'drain') {
      if (inst.state === 'draining') throw conflict(`${inst.name} is already draining.`);
      const out = await s.gateway.drain(inst.id, p.username);
      await audit(req, 'instance.drained', { instance: inst.id, name: inst.name, pool: pool.name, zone: id }, { unloaded: out.unloaded, from: 'zones' });
      res.json({ ref: body.ref, state: 'draining', unloaded: out.unloaded });
    } else {
      if (inst.state !== 'draining') throw badRequest(`${inst.name} is not draining.`);
      await s.gateway.undrain(inst.id);
      await audit(req, 'instance.undrained', { instance: inst.id, name: inst.name, pool: pool.name, zone: id }, { from: 'zones' });
      res.json({ ref: body.ref, state: 'active' });
    }
  });

  return r;
}
