import { Router, type Request, type Response } from 'express';
import { parseCookie } from 'cookie';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { conflict, notFound } from '../http/problem.js';
import { OAUTH_COOKIE, OAuthFailure, STATE_MS } from '../mcp/oauth.js';
import { MCP_GROUPS, MCP_SCOPES, mcpResource } from '../mcp/server/resource.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/**
 * Sprint 37b: the MCP server's administration (B-7101, B-7102: which workspaces publish, which tool groups, at which
 * label, DPoP, and whether MCP clients may register themselves; Identity, MCP server; `identity:manage`), each
 * user's view of it (connection URLs, and the calls held for their approval, decided only from a browser session),
 * and the user's side of MCP client OAuth (B-7103: start, and the redirect back).
 */
export function mcpAccessRoutes(s: Services): Router {
  const r = Router();
  r.use(['/admin/mcp-server', '/me/mcp-server', '/me/mcp-holds', '/mcp-oauth/start'], noStore);
  const identity = requirePermission(s, 'identity:manage');
  const invoke = requirePermission(s, 'tools:invoke');
  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  // ---------- administration ----------

  r.get('/admin/mcp-server', requireAuth(), identity, async (req, res) => {
    const p = principalOf(req);
    const t = await s.federation.tenantById(p.tenantId);
    const clients = (await s.federation.oidc.listClients(p.tenantId)).filter((c) => c.dynamic);
    res.json({
      issuer: t?.issuer ?? null,
      scopes: [...MCP_SCOPES],
      groups: [...MCP_GROUPS],
      dynamicRegistration: await s.mcpServer.dynamicRegistration(p.tenantId),
      registrationEndpoint: t ? `${t.issuer}/oauth/register` : null,
      publications: await s.mcpServer.overview(p.tenantId, p.tenantSlug),
      clients: clients.map((c) => ({ id: c.id, clientId: c.client_id, name: c.name, type: c.type, redirectUris: c.redirect_uris, scopes: c.scopes, status: c.status, lastUsedAt: c.last_used_at, createdAt: c.created_at }))
    });
  });

  r.put('/admin/mcp-server/settings', requireAuth(), identity, async (req, res) => {
    const b = parseBody(z.object({ dynamicRegistration: z.boolean() }).strict(), req.body);
    const p = principalOf(req);
    await s.mcpServer.setDynamicRegistration(p.tenantId, b.dynamicRegistration, p.userId);
    await audit(req, 'mcp.server.settings.updated', { tenant: p.tenantId }, { dynamicRegistration: b.dynamicRegistration });
    res.json({ dynamicRegistration: b.dynamicRegistration });
  });

  r.put('/admin/mcp-server/workspaces/:workspaceId', requireAuth(), identity, async (req, res) => {
    const p = principalOf(req);
    const wsId = parseBody(id26, req.params.workspaceId);
    const b = parseBody(z.object({ enabled: z.boolean().optional(), groups: z.array(z.enum(MCP_GROUPS)).max(MCP_GROUPS.length).optional(), label: z.enum(LABELS).optional(), requireDpop: z.boolean().optional() }).strict(), req.body);
    const before = await s.mcpServer.publication(p.tenantId, wsId);
    const pub = await s.mcpServer.publish(p, wsId, b);
    const action = pub.enabled && !before?.enabled ? 'mcp.server.published' : !pub.enabled && before?.enabled ? 'mcp.server.unpublished' : 'mcp.server.publication.updated';
    await audit(req, action, { workspace: wsId }, { enabled: pub.enabled, groups: pub.groups, label: pub.label, requireDpop: pub.require_dpop });
    res.json({ workspaceId: wsId, url: mcpResource(s.cfg, p.tenantSlug, wsId), enabled: pub.enabled, groups: pub.groups, label: pub.label, requireDpop: pub.require_dpop, updatedAt: pub.updated_at });
  });

  /** What a workspace publishes, as the admin themselves would see it over MCP (their roles, clearance and the label). */
  r.get('/admin/mcp-server/workspaces/:workspaceId/tools', requireAuth(), identity, async (req, res) => {
    const p = principalOf(req);
    const wsId = parseBody(id26, req.params.workspaceId);
    if (!(await s.tenants.workspace(p.tenantId, wsId))) throw notFound('Workspace');
    const pub = (await s.mcpServer.publication(p.tenantId, wsId)) ?? { workspace_id: wsId, label: 'internal' as const, groups: [...MCP_GROUPS] };
    const caller = await s.mcpServer.callerIn(p, { ...pub, id: '', tenant_id: p.tenantId, enabled: true, require_dpop: false, created_by: null, updated_by: null, created_at: 0, updated_at: 0 });
    if (!caller) return void res.json({ asYou: false, tools: [] });
    const tools = await s.mcpServer.catalog(caller, pub.groups);
    res.json({ asYou: true, label: caller.clearance, tools: tools.map((t) => ({ name: t.name, title: t.title, group: t.group, sideEffect: t.sideEffect, description: t.description })) });
  });

  // ---------- each user ----------

  r.get('/me/mcp-server', requireAuth(), async (req, res) => {
    const p = principalOf(req);
    res.json({ servers: await s.mcpServer.forUser(p), holds: await s.mcpServer.holds(p, 'pending') });
  });

  r.get('/me/mcp-holds', requireAuth(), async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'all']).default('pending') }), req.query);
    res.json({ holds: await s.mcpServer.holds(principalOf(req), q.state) });
  });

  /** Only a browser session decides: a token that asked for the call can never approve it. */
  r.post('/me/mcp-holds/:id/decide', requireAuth({ sessionOnly: true }), async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ decision: z.enum(['approve', 'reject']) }).strict(), req.body);
    const h = await s.mcpServer.decide(p, parseBody(id26, req.params.id), b.decision);
    await audit(req, b.decision === 'approve' ? 'mcp.server.hold.approved' : 'mcp.server.hold.rejected', { hold: h.id, tool: h.tool, workspace: h.workspace_id }, { client: h.client_id, sideEffect: h.side_effect });
    res.json({ id: h.id, state: h.state, expiresAt: Number(h.expires_at) });
  });

  // ---------- MCP client OAuth (B-7103) ----------

  /** Starts the user's authorization at the MCP server's authorization server; the browser goes to `authorizeUrl`. */
  r.post('/mcp-oauth/start', requireAuth({ sessionOnly: true }), invoke, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ server: id26, returnTo: z.enum(['settings', 'mcp-servers']).default('settings') }).strict(), req.body);
    const srv = await s.mcp.server(p.tenantId, b.server);
    if (srv.state !== 'active') throw conflict('The server is deregistered.');
    if (srv.auth !== 'user') throw conflict(`${srv.name} does not use per-user connections.`);
    const out = await s.mcp.oauth.start(srv, p.userId, b.returnTo);
    res.cookie(OAUTH_COOKIE, out.binding, { httpOnly: true, secure: s.cfg.COOKIE_SECURE, sameSite: 'lax', path: '/api/mcp-oauth', maxAge: STATE_MS });
    await audit(req, 'mcp.oauth.started', { mcpServer: srv.id, name: srv.name });
    res.json({ authorizeUrl: out.authorizeUrl });
  });

  /**
   * The authorization server sends the browser back here (a cross-site navigation, so without the session cookie):
   * the state and the binding cookie identify the user and request; the tokens are stored and the console reopens.
   */
  r.get('/mcp-oauth/callback', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.clearCookie(OAUTH_COOKIE, { httpOnly: true, secure: s.cfg.COOKIE_SECURE, sameSite: 'lax', path: '/api/mcp-oauth' });
    const q = parseBody(z.object({ state: z.string().max(200).optional(), code: z.string().max(4000).optional(), error: z.string().max(200).optional(), error_description: z.string().max(1000).optional(), iss: z.string().max(500).optional() }).passthrough(), req.query) as { state?: string; code?: string; error?: string; error_description?: string; iss?: string };
    const cookie = req.headers.cookie ? parseCookie(req.headers.cookie)[OAUTH_COOKIE] : undefined;
    const back = (route: string, params: Record<string, string>) => res.redirect(302, `/#/${route}?${new URLSearchParams(params).toString()}`);
    try {
      const out = await s.mcp.oauth.finish(q, cookie);
      const srv = await s.mcp.server(out.tenantId, out.serverId);
      await s.mcp.storeOAuthTokens(out.tenantId, srv, out.userId, out.tokens);
      await s.audit.append({ tenantId: out.tenantId, action: 'mcp.oauth.connected', kind: 'admin', actor: { user: out.userId, ip: req.ip ?? null }, target: { mcpServer: srv.id, name: srv.name }, detail: { scopes: out.tokens.scopes, expiresAt: out.tokens.expiresAt, refresh: !!out.tokens.refresh }, traceId: req.traceId });
      return back(out.returnTo === 'mcp-servers' ? 'mcp-servers' : 'settings', { tab: 'mcp', server: srv.id, result: 'connected' });
    } catch (err) {
      if (!(err instanceof OAuthFailure)) throw err;
      s.log.warn({ err: err.message, code: err.code, trace_id: req.traceId }, 'mcp oauth callback failed');
      return back('settings', { tab: 'mcp', result: 'failed', reason: err.message.slice(0, 300) });
    }
  });

  return r;
}
