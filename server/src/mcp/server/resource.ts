import type { Config } from '../../config/index.js';

/*
 * B-7101, B-7102: where a workspace's MCP server answers, and how its URL works as an OAuth resource identifier.
 *
 * The endpoint is `<base>/mcp/<tenant slug>/<workspace id>`, where the base is API_PUBLIC_URL when a proxy serves the
 * API elsewhere, else the origin of PUBLIC_URL. That URL, without query or fragment, is the resource (RFC 8707) a
 * client names at the tenant's authorization endpoint and the audience of the tokens it gets; the tool groups a client
 * picks travel in the query (`?groups=records,knowledge`) and are not part of the resource. The protected resource
 * metadata (RFC 9728) is at `<base>/.well-known/oauth-protected-resource/mcp/<tenant slug>/<workspace id>`.
 */

export const MCP_GROUPS = ['workflows', 'agents', 'knowledge', 'tools', 'records'] as const;
export type McpGroup = (typeof MCP_GROUPS)[number];
export const isMcpGroup = (v: unknown): v is McpGroup => typeof v === 'string' && (MCP_GROUPS as readonly string[]).includes(v);

/**
 * The scopes an MCP client asks for: the permissions the tool groups need (narrowed further by the user's roles).
 * Agent runs (and workflows with model steps) call models as the user, which `inference:invoke` allows.
 */
export const MCP_SCOPES = ['tools:invoke', 'agents:run', 'inference:invoke', 'knowledge:read', 'records:read', 'records:write'] as const;

type UrlConfig = Pick<Config, 'PUBLIC_URL' | 'API_PUBLIC_URL'>;

export const mcpBase = (cfg: UrlConfig): string => (cfg.API_PUBLIC_URL ? cfg.API_PUBLIC_URL.replace(/\/+$/, '') : new URL(cfg.PUBLIC_URL).origin);

export const mcpResource = (cfg: UrlConfig, tenantSlug: string, workspaceId: string): string => `${mcpBase(cfg)}/mcp/${tenantSlug}/${workspaceId}`;

export const metadataUrl = (cfg: UrlConfig, tenantSlug: string, workspaceId: string): string => `${mcpBase(cfg)}/.well-known/oauth-protected-resource/mcp/${tenantSlug}/${workspaceId}`;

/** A resource identifier as a client sent it, without query and fragment (and a trailing slash), or null when it is not an http(s) URL. */
export function canonicalResource(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** The tenant and workspace an MCP resource URL names, or null when it is not one of this server's MCP endpoints. */
export function parseMcpResource(cfg: UrlConfig, raw: string): { tenantSlug: string; workspaceId: string } | null {
  const c = canonicalResource(raw);
  const base = mcpBase(cfg);
  if (!c || !c.startsWith(`${base}/mcp/`)) return null;
  const m = /^([a-z0-9][a-z0-9-]{0,62})\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(c.slice(base.length + 5));
  return m ? { tenantSlug: m[1]!, workspaceId: m[2]! } : null;
}
