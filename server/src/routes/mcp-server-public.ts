import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { authorize, type Principal } from '../authz/policy.js';
import { DpopNonceError } from '../federation/oidc.js';
import { AUTH_TAG, BAD_BEARER_PER_MINUTE } from '../http/middleware.js';
import { SUPPORTED_VERSIONS } from '../mcp/client.js';
import { isMcpGroup, MCP_SCOPES, mcpBase, mcpResource, metadataUrl, type McpGroup } from '../mcp/server/resource.js';
import type { McpServerTool, PublicationRow } from '../mcp/server/service.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

/** Calls per user per minute on the MCP endpoints, across workspaces. */
export const MCP_CALLS_PER_MINUTE = 600;
const SERVER_INFO = { name: 'exprsn-ai', title: 'Exprsn-AI', version: '1.6.0' };

interface RpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

const rpcError = (id: RpcMessage['id'], code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const quoted = (v: string) => v.replace(/["\\\r\n]/g, "'");

/**
 * Sprint 37b (B-7101, B-7102): each workspace's MCP server, over the streamable HTTP transport (protocol 2025-06-18,
 * also 2025-03-26), at `/mcp/<tenant slug>/<workspace id>`, outside `/api`: a JSON-RPC message POSTed, a JSON answer.
 * No sessions and no server-sent stream (GET and DELETE answer 405). It is an OAuth 2.1 resource server of the
 * tenant's own issuer: an access token whose audience is this endpoint's URL (RFC 8707), sent as Bearer or DPoP; a
 * request without one gets 401 with `WWW-Authenticate` naming the protected resource metadata (RFC 9728), published
 * at `/.well-known/oauth-protected-resource/mcp/<tenant slug>/<workspace id>`. Tokens for the API (or another
 * workspace) are refused here, and these tokens are refused by the API.
 */
export function mcpServerPublicRoutes(s: Services): Router {
  const r = Router();
  const badBearer = new Limiter(s.counters, 'bearer-fail', BAD_BEARER_PER_MINUTE, 60_000);
  const perUser = new RateLimiterMemory({ points: MCP_CALLS_PER_MINUTE, duration: 60 });
  const body = express.text({ type: () => true, limit: '1mb' });

  /** The tenant, workspace and publication an endpoint path names, when the workspace publishes its MCP server. */
  const target = async (req: Request): Promise<{ tenant: { id: string; slug: string; issuer: string }; pub: PublicationRow; resource: string; metadata: string } | null> => {
    const slug = String(req.params.tenant ?? '');
    const wsId = String(req.params.workspace ?? '');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(wsId)) return null;
    const t = await s.federation.tenantBySlug(slug);
    if (!t) return null;
    const pub = await s.mcpServer.publication(t.id, wsId);
    if (!pub?.enabled) return null;
    const ws = await s.tenants.workspace(t.id, wsId);
    if (!ws || ws.state !== 'active') return null;
    return { tenant: t, pub, resource: mcpResource(s.cfg, slug, wsId), metadata: metadataUrl(s.cfg, slug, wsId) };
  };

  const notFound = (res: Response) => void res.status(404).setHeader('Cache-Control', 'no-store').json({ error: 'not_found', error_description: 'No MCP server is published at this address.' });

  r.get('/.well-known/oauth-protected-resource/mcp/:tenant/:workspace', async (req, res) => {
    const x = await target(req);
    if (!x) return notFound(res);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      resource: x.resource,
      authorization_servers: [x.tenant.issuer],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Exprsn-AI MCP server',
      dpop_signing_alg_values_supported: ['ES256', 'RS256'],
      dpop_bound_access_tokens_required: x.pub.require_dpop
    });
  });

  /** RFC 9728 5.1 / RFC 6750 3: the challenge that tells a client where to get a token. */
  const challenge = (res: Response, x: { metadata: string; pub: PublicationRow }, status: 401 | 403, error: string | null, description: string) => {
    const scope = MCP_SCOPES.join(' ');
    const extra = error ? `, error="${error}", error_description="${quoted(description)}"` : '';
    const bearer = `Bearer resource_metadata="${x.metadata}", scope="${scope}"${extra}`;
    res.setHeader('WWW-Authenticate', x.pub.require_dpop ? `${bearer}, DPoP algs="ES256 RS256", resource_metadata="${x.metadata}"${extra}` : bearer);
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json({ error: error ?? 'invalid_request', error_description: description });
  };

  const handler: RequestHandler = async (req, res) => {
    const x = await target(req);
    if (!x) return notFound(res);
    // DNS rebinding (MCP transport security): a browser page from another origin may not drive this endpoint.
    const origin = req.headers.origin;
    if (origin && origin !== s.cfg.ORIGIN) return void res.status(403).json({ error: 'forbidden', error_description: 'Cross-origin requests are refused.' });
    const auth = req.headers.authorization;
    if (!auth) return challenge(res, x, 401, null, 'Sign in through the tenant\'s authorization server to use this MCP server.');
    const held = await badBearer.blocked(req.ip ?? 'unknown');
    if (held.blocked) return void res.status(429).setHeader('Retry-After', String(Math.max(1, Math.ceil(held.resetMs / 1000)))).json({ error: 'too_many_requests', error_description: 'Too many failed credentials from this address.' });
    const m = /^(Bearer|DPoP)\s+(\S+)$/i.exec(auth);
    const refuse = async (why: string) => {
      await badBearer.consume(req.ip ?? 'unknown');
      challenge(res, x, 401, 'invalid_token', why);
    };
    if (!m?.[2] || !m[2].startsWith('eyJ')) return refuse('Send an access token from the tenant\'s authorization server.');
    const scheme = m[1]!.toLowerCase() === 'dpop' ? 'dpop' : 'bearer';
    let claims: Record<string, unknown> = {};
    let p: Principal | null;
    try {
      if (scheme === 'dpop' && s.cfg.DPOP_NONCES) res.setHeader('DPoP-Nonce', s.federation.oidc.dpopNonce());
      p = await s.federation.principalFromAccessToken(m[2], { scheme, dpop: { proof: req.header('dpop'), method: 'POST', url: `${mcpBase(s.cfg)}${req.originalUrl}` } }, { audience: x.resource, claims: (c) => (claims = c) });
    } catch (err) {
      if (!(err instanceof DpopNonceError)) throw err;
      res.setHeader('DPoP-Nonce', s.federation.oidc.dpopNonce());
      res.setHeader('WWW-Authenticate', `DPoP error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof", resource_metadata="${x.metadata}"`);
      return void res.status(401).json({ error: 'use_dpop_nonce', error_description: err.message });
    }
    if (!p || p.tenantId !== x.tenant.id) return refuse('The access token is invalid, expired, revoked, or was issued for another resource.');
    if (x.pub.require_dpop && typeof (claims.cnf as { jkt?: unknown } | undefined)?.jkt !== 'string') return refuse('This MCP server accepts DPoP-bound tokens only.');
    const caller = await s.mcpServer.callerIn(p, x.pub);
    if (!caller) return void res.status(403).json({ error: 'forbidden', error_description: 'You may not act in this workspace.' });
    if (!MCP_SCOPES.some((perm) => authorize(caller, perm, { tenantId: caller.tenantId }).allow)) return challenge(res, x, 403, 'insufficient_scope', 'The token carries none of the scopes this server needs, or your roles grant none of them.');
    try {
      await perUser.consume(`${caller.tenantId}:${caller.userId}`);
    } catch (rej) {
      const ms = (rej as { msBeforeNext?: number }).msBeforeNext ?? 1000;
      return void res.status(429).setHeader('Retry-After', String(Math.max(1, Math.ceil(ms / 1000)))).json({ error: 'too_many_requests', error_description: `At most ${MCP_CALLS_PER_MINUTE} requests a minute.` });
    }
    const version = req.header('mcp-protocol-version');
    if (version && !SUPPORTED_VERSIONS.includes(version)) return void res.status(400).json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${version}; this server speaks ${SUPPORTED_VERSIONS.join(' and ')}.`));
    let msg: RpcMessage;
    try {
      msg = JSON.parse(typeof req.body === 'string' ? req.body : '') as RpcMessage;
    } catch {
      return void res.status(400).json(rpcError(null, -32700, 'Parse error.'));
    }
    if (Array.isArray(msg)) return void res.status(400).json(rpcError(null, -32600, 'Batches are not supported (protocol 2025-06-18).'));
    if (!plain(msg) || msg.jsonrpc !== '2.0') return void res.status(400).json(rpcError(null, -32600, 'Not a JSON-RPC 2.0 message.'));
    // Notifications and responses are accepted without an answer.
    if (msg.id === undefined || typeof msg.method !== 'string') return void res.status(202).end();
    const id = msg.id as RpcMessage['id'];
    const asked = typeof req.query.groups === 'string' ? req.query.groups.split(',').map((g) => g.trim()).filter(isMcpGroup) : null;
    const groups: McpGroup[] = asked?.length ? x.pub.groups.filter((g) => asked.includes(g)) : x.pub.groups;
    const params = plain(msg.params) ? msg.params : {};
    const ok = (result: unknown) => void res.setHeader('Cache-Control', 'no-store').json({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'initialize': {
        const want = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const ws = await s.tenants.workspace(caller.tenantId, x.pub.workspace_id);
        return ok({
          protocolVersion: SUPPORTED_VERSIONS.includes(want) ? want : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: `Tools of the ${ws?.name ?? ''} workspace in Exprsn-AI, acting as ${caller.displayName} (groups: ${groups.join(', ') || 'none'}). Results carry data up to ${caller.clearance}. Write and destructive tools wait for approval in Exprsn-AI under Settings, MCP access; call them again with the same arguments once approved.`
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list': {
        const tools = await s.mcpServer.catalog(caller, groups);
        return ok({ tools: tools.map((t: McpServerTool) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) });
      }
      case 'tools/call': {
        if (typeof params.name !== 'string' || params.name.length > 128) return void res.json(rpcError(id, -32602, 'params.name is required.'));
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!plain(args)) return void res.json(rpcError(id, -32602, 'params.arguments must be an object.'));
        const ac = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) ac.abort(new Error('The client went away.'));
        });
        const out = await s.mcpServer.call(caller, groups, params.name, args, { clientId: typeof claims.client_id === 'string' ? claims.client_id : null, ip: req.ip ?? null, traceId: req.traceId ?? null, signal: ac.signal });
        if (out.outcome === 'unknown') return void res.json(rpcError(id, -32602, `Unknown tool: ${params.name}.`));
        if (out.ok) return ok({ content: [{ type: 'text', text: JSON.stringify(out.result ?? null) }], ...(plain(out.result) ? { structuredContent: out.result } : {}), isError: false });
        return ok({ content: [{ type: 'text', text: out.error ?? 'The call failed.' }], ...(out.held ? { structuredContent: { held: out.held } } : out.pending ? { structuredContent: { pending: out.pending } } : {}), isError: out.outcome !== 'pending' });
      }
      default:
        return void res.json(rpcError(id, -32601, `Method not found: ${msg.method}.`));
    }
  };
  r.post('/mcp/:tenant/:workspace', body, Object.assign(handler, { [AUTH_TAG]: true }));
  const noStream: RequestHandler = (_req, res) => void res.status(405).setHeader('Allow', 'POST').json({ error: 'method_not_allowed', error_description: 'This MCP server answers POSTed JSON-RPC messages with JSON; it offers no event stream or sessions.' });
  r.get('/mcp/:tenant/:workspace', noStream);
  r.delete('/mcp/:tenant/:workspace', noStream);
  return r;
}
