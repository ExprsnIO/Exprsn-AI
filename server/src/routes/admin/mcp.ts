import { Router, type Request } from 'express';
import { isVaultRef } from '../../vault/policy.js';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { labelRank, LABELS } from '../../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { conflict, forbidden, notFound } from '../../http/problem.js';
import { serverView, toolView, type ServerRow } from '../../mcp/service.js';
import { SIDE_EFFECTS } from '../../registry/service.js';
import type { ProfileRow } from '../../gateway/repo.js';
import type { Services } from '../../services.js';

const urlSchema = z.string().trim().url().max(500);

/** MCP servers: registration (internal hosts only), checks, tool review, credentials and profile bindings. */
export function mcpAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/mcp-servers', noStore, requireAuth());
  const manage = requirePermission(s, 'mcp:manage');
  const profiles = requirePermission(s, 'profiles:manage');
  const mcp = s.mcp;

  const audit = (req: Request, action: string, srv: Pick<ServerRow, 'id' | 'name'>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target: { mcpServer: srv.id, name: srv.name }, ...(detail ? { detail } : {}), traceId: req.traceId });
  };
  const load = (req: Request) => mcp.server(principalOf(req).tenantId, String(req.params.id));
  const toolNames = (srv: ServerRow, names: string[]) => names.map((n) => `${srv.name}.${n}`);
  const boundProfiles = (all: ProfileRow[], srv: ServerRow) => all.filter((x) => x.tools.some((t) => t.startsWith(`${srv.name}.`)));

  r.get('/mcp-servers', manage, async (req, res) => {
    const p = principalOf(req);
    const [list, all] = await Promise.all([mcp.servers(p.tenantId), s.gateway.repo.profiles(p.tenantId)]);
    res.json(
      await Promise.all(
        list.map(async (srv) => {
          const tools = await mcp.tools(srv.id);
          return { ...serverView(srv), tools: tools.length, approved: tools.filter((t) => t.state === 'approved').length, disabled: tools.filter((t) => t.state === 'changed' || t.state === 'rejected').length, pending: tools.filter((t) => t.state === 'pending').length, profiles: boundProfiles(all, srv).map((x) => x.name) };
        })
      )
    );
  });

  r.get('/mcp-servers/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const srv = await load(req);
    const [tools, events, all, connections, mine] = await Promise.all([mcp.tools(srv.id), mcp.events(srv.id), s.gateway.repo.profiles(p.tenantId), srv.auth === 'user' ? mcp.connections(srv.id) : Promise.resolve([]), mcp.tokenStatus(p, srv.id)]);
    const models = await s.gateway.repo.models();
    const bindings = boundProfiles(all, srv).map((x) => {
      const m = models.find((y) => y.id === x.model_id);
      return { profileId: x.id, profile: x.name, model: m?.name ?? null, toolsCapable: !!m?.capabilities.includes('tools'), label: x.label, tools: x.tools.filter((t) => t.startsWith(`${srv.name}.`)).map((t) => t.slice(srv.name.length + 1)), toolCount: x.tools.length, status: x.status };
    });
    res.json({ ...serverView(srv), tools: tools.map(toolView), events, bindings, connections, myToken: mine });
  });

  r.post('/mcp-servers', manage, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lower-case letters, digits and hyphens'), description: z.string().trim().max(500).nullable().default(null), url: urlSchema, zone: z.string().trim().regex(/^[a-z0-9-]{1,63}$/).default('app-internal'), auth: z.enum(['none', 'service', 'user']).default('none'), credential: z.string().min(8).max(4096).nullable().default(null) }), req.body);
    if (b.auth === 'service' && b.credential && isVaultRef(b.credential)) await s.vault.assertRefsReadable(p, [b.credential], { ip: ip(req), traceId: req.traceId });
    try {
      await s.zones.assertMemberFits('MCP server', b.zone, null);
      const out = await mcp.register(p, b);
      await audit(req, 'mcp.registered', out.server, { url: b.url, zone: b.zone, auth: b.auth, health: out.server.health });
      res.status(201).json({ ...serverView(out.server), report: out.report });
    } catch (err) {
      await s.audit.append({ tenantId: p.tenantId, action: 'mcp.register.refused', kind: 'admin', actor: actorFrom(p, ip(req)), target: { name: b.name, url: b.url }, detail: { reason: (err as Error).message }, traceId: req.traceId });
      throw err;
    }
  });

  /** A compatibility and health check now: handshake, tools/list, hashes. */
  r.post('/mcp-servers/:id/check', manage, async (req, res) => {
    const srv = await load(req);
    const report = await mcp.check(srv, { asUser: principalOf(req) });
    const after = await load(req);
    await audit(req, 'mcp.checked', srv, { health: after.health });
    res.json({ ...serverView(after), report });
  });

  r.post('/mcp-servers/:id/tools/:tool/approve', manage, async (req, res) => {
    const p = principalOf(req);
    const srv = await load(req);
    const b = parseBody(z.object({ sideEffect: z.enum(SIDE_EFFECTS), confirm: z.enum(['always', 'never']), label: z.enum(LABELS).default('internal') }), req.body);
    // A tool cannot be cleared for data above its server's zone ceiling.
    const ceiling = await s.zones.ceilingOf(srv.zone);
    if (ceiling && labelRank(b.label) > labelRank(ceiling)) throw forbidden(`${srv.name} is in the ${srv.zone} zone, whose ceiling is ${ceiling}; its tools cannot be approved for ${b.label} data.`, { step: 'zone', zoneCeiling: ceiling });
    const t = await mcp.approveTool(p, srv, String(req.params.tool), b);
    await audit(req, 'mcp.tool.approved', srv, { tool: t.name, hash: t.hash, sideEffect: b.sideEffect, confirm: b.confirm, label: b.label });
    res.json(toolView(t));
  });

  r.post('/mcp-servers/:id/tools/:tool/revoke', manage, async (req, res) => {
    const srv = await load(req);
    const t = await mcp.revokeTool(srv, String(req.params.tool), 'revoke', principalOf(req));
    await audit(req, 'mcp.tool.revoked', srv, { tool: t.name });
    res.json(toolView(t));
  });

  r.post('/mcp-servers/:id/tools/:tool/reject-change', manage, async (req, res) => {
    const srv = await load(req);
    const t = await mcp.revokeTool(srv, String(req.params.tool), 'reject-change', principalOf(req));
    await audit(req, 'mcp.tool.change.rejected', srv, { tool: t.name, announcedHash: t.hash, approvedHash: t.approved_hash });
    res.json(toolView(t));
  });

  r.put('/mcp-servers/:id/credential', manage, async (req, res) => {
    const srv = await load(req);
    const b = parseBody(z.object({ secret: z.string().min(8).max(4096) }), req.body);
    // Sprint 25 (B-1705): a vault reference must be readable by the admin saving it; it resolves as them.
    if (isVaultRef(b.secret)) await s.vault.assertRefsReadable(principalOf(req), [b.secret], { ip: ip(req), traceId: req.traceId });
    await mcp.rotateCredential(srv, b.secret, principalOf(req).userId);
    await audit(req, 'mcp.credential.rotated', srv);
    res.json({ ok: true });
  });

  /** Binds the server's approved tools to a profile (a new profile version). The model must support tools. */
  r.post('/mcp-servers/:id/bind', manage, profiles, async (req, res) => {
    const p = principalOf(req);
    const srv = await load(req);
    if (srv.state !== 'active') throw conflict('The server is deregistered.');
    const b = parseBody(z.object({ profileId: z.string().length(26), tools: z.array(z.string().min(1).max(120)).max(32).optional() }), req.body);
    const prof = await s.gateway.repo.profile(p.tenantId, b.profileId);
    if (!prof || prof.alias_of) throw notFound('Profile');
    const m = prof.model_id ? await s.gateway.repo.model(prof.model_id) : undefined;
    if (!m?.capabilities.includes('tools') || m.evaluation?.toolsWithheld) throw conflict(`${m?.name ?? 'The profile\'s model'} has no tools capability; tools cannot be bound to ${prof.name}.`);
    const approved = (await mcp.tools(srv.id)).filter((t) => t.state === 'approved').map((t) => t.name);
    const pick = b.tools ?? approved;
    const bad = pick.filter((t) => !approved.includes(t));
    if (bad.length) throw conflict(`Not approved: ${bad.join(', ')}.`);
    if (!pick.length) throw conflict('The server has no approved tools to bind.');
    const tools = [...new Set([...prof.tools.filter((t) => !t.startsWith(`${srv.name}.`)), ...toolNames(srv, pick)])];
    if (tools.length > 32) throw conflict(`${prof.name} would carry ${tools.length} tools; the budget is 32.`);
    const version = prof.version + 1;
    await s.gateway.repo.updateProfile(p.tenantId, prof.id, { tools, version, updated_by: p.userId });
    await s.gateway.repo.snapshot({ ...prof, tools, version, updated_by: p.userId, updated_at: Date.now() }, `Bound ${srv.name}`, p.userId);
    await audit(req, 'mcp.bound', srv, { profile: prof.name, tools: pick, version });
    res.json({ profile: prof.name, tools, version });
  });

  r.delete('/mcp-servers/:id/bind/:profileId', manage, profiles, async (req, res) => {
    const p = principalOf(req);
    const srv = await load(req);
    const prof = await s.gateway.repo.profile(p.tenantId, String(req.params.profileId));
    if (!prof) throw notFound('Profile');
    const tools = prof.tools.filter((t) => !t.startsWith(`${srv.name}.`));
    if (tools.length === prof.tools.length) throw conflict(`${prof.name} has no tools from ${srv.name}.`);
    const version = prof.version + 1;
    await s.gateway.repo.updateProfile(p.tenantId, prof.id, { tools, version, updated_by: p.userId });
    await s.gateway.repo.snapshot({ ...prof, tools, version, updated_by: p.userId, updated_at: Date.now() }, `Unbound ${srv.name}`, p.userId);
    await audit(req, 'mcp.unbound', srv, { profile: prof.name, version });
    res.json({ profile: prof.name, tools, version });
  });

  /** Deregistration removes the server's tools from every profile and deprecates their registry entries. */
  r.delete('/mcp-servers/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const srv = await load(req);
    if (srv.state !== 'active') throw conflict('Already deregistered.');
    const affected = boundProfiles(await s.gateway.repo.profiles(p.tenantId), srv);
    for (const prof of affected) {
      const tools = prof.tools.filter((t) => !t.startsWith(`${srv.name}.`));
      await s.gateway.repo.updateProfile(p.tenantId, prof.id, { tools, version: prof.version + 1, updated_by: p.userId });
      await s.gateway.repo.snapshot({ ...prof, tools, version: prof.version + 1 }, `Deregistered ${srv.name}`, p.userId);
    }
    await mcp.deregister(srv);
    await audit(req, 'mcp.deregistered', srv, { profiles: affected.map((x) => x.name) });
    res.json({ ok: true, profiles: affected.map((x) => x.name) });
  });

  return r;
}
