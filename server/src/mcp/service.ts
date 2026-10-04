import { ulid } from 'ulid';
import { isVaultRef } from '../vault/policy.js';
import { scrubSecrets } from '../platform/diagnostics.js';
import type { Logger } from 'pino';
import type { Agent } from 'undici';
import { json, type Db } from '../db/knex.js';
import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { AuditLog } from '../audit/chain.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { Notifications } from '../platform/notifications.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { schemaHash } from '../registry/schema.js';
import type { RegistryService, SideEffect } from '../registry/service.js';
import { McpClient, McpError, type McpCallResult, type McpToolInfo } from './client.js';
import { checkUrl, guardedAgent, HostRefused, parseAllowList, type AllowList } from './hosts.js';

export type ServerHealth = 'registering' | 'healthy' | 'changed' | 'unreachable' | 'incompatible';
export type ToolState = 'pending' | 'approved' | 'changed' | 'rejected' | 'removed';

export interface ServerRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  url: string;
  zone: string;
  auth: 'none' | 'service' | 'user';
  credential: string | null;
  credential_rotated_at: number | null;
  /** Sprint 25 (B-1705): who saved a `vault:` service token reference; it resolves under their vault policy. */
  vault_owner?: string | null;
  state: 'active' | 'deregistered';
  health: ServerHealth;
  health_detail: string | null;
  protocol_version: string | null;
  server_info: string | null;
  latency_ms: number | null;
  failures: number;
  last_checked_at: number | null;
  last_ok_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ToolRow {
  id: string;
  server_id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  input_schema: string | null;
  annotations: string | null;
  hash: string;
  approved_hash: string | null;
  approved_schema: string | null;
  state: ToolState;
  side_effect: SideEffect | null;
  confirm: 'always' | 'never' | null;
  label: Label | null;
  approved_by: string | null;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CheckLine {
  check: string;
  result: 'passed' | 'failed' | 'changed' | 'skipped';
  detail: string;
}

const num = (v: unknown) => (v == null ? null : Number(v));

export const toolView = (t: ToolRow) => {
  const annotations = json<Record<string, unknown>>(t.annotations, {});
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    inputSchema: json<Record<string, unknown> | null>(t.input_schema, null),
    annotations,
    hash: t.hash,
    approvedHash: t.approved_hash,
    approvedSchema: json<Record<string, unknown> | null>(t.approved_schema, null),
    state: t.state,
    sideEffect: t.side_effect,
    suggestedSideEffect: suggestSide(annotations),
    confirm: t.confirm,
    label: t.label,
    approvedAt: num(t.approved_at),
    updatedAt: Number(t.updated_at)
  };
};

export const serverView = (s: ServerRow) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  url: s.url,
  zone: s.zone,
  auth: s.auth,
  hasCredential: !!s.credential,
  credentialRotatedAt: num(s.credential_rotated_at),
  state: s.state,
  health: s.health,
  healthDetail: s.health_detail,
  protocolVersion: s.protocol_version,
  serverInfo: json<Record<string, unknown> | null>(s.server_info, null),
  latencyMs: num(s.latency_ms),
  failures: Number(s.failures),
  lastCheckedAt: num(s.last_checked_at),
  lastOkAt: num(s.last_ok_at),
  createdAt: Number(s.created_at)
});

/** The side-effect class the annotations suggest. Annotations are untrusted: the review sets the real class. */
function suggestSide(a: Record<string, unknown>): SideEffect {
  if (a.destructiveHint === true) return 'destructive';
  if (a.readOnlyHint === true) return 'read';
  return 'write';
}

const hashTool = (t: McpToolInfo) => schemaHash({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null, outputSchema: t.outputSchema ?? null, annotations: t.annotations ?? null });

/**
 * MCP servers over streamable HTTP, on internal hosts only. Registration and every health check run the handshake
 * and `tools/list`, hashing each tool's announcement (name, description, schemas, annotations). New tools wait for
 * review; an approved tool whose hash changes is disabled until a tool admin approves the new schema. Credentials
 * are sealed with the tenant key: a service token per server, or a token per user (the vault), never returned and
 * never put in model context.
 */
export class McpService {
  readonly allow: AllowList;
  private readonly agent: Agent;

  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly registry: RegistryService,
    private readonly audit: AuditLog,
    private readonly notifications: Notifications,
    private readonly log: Logger,
    private readonly o: { allowedHosts: string; timeoutMs: number }
  ) {
    this.allow = parseAllowList(o.allowedHosts);
    this.agent = guardedAgent(this.allow, o.timeoutMs);
  }

  async close(): Promise<void> {
    await this.agent.close().catch(() => undefined);
  }

  // ---------- reads ----------

  async servers(tenantId: string): Promise<ServerRow[]> {
    return (await this.db('mcp_servers').where({ tenant_id: tenantId }).orderBy('name')) as ServerRow[];
  }

  async server(tenantId: string, id: string): Promise<ServerRow> {
    const s = (await this.db('mcp_servers').where({ tenant_id: tenantId, id }).first()) as ServerRow | undefined;
    if (!s) throw notFound('MCP server');
    return s;
  }

  async byName(tenantId: string, name: string): Promise<ServerRow | undefined> {
    return (await this.db('mcp_servers').where({ tenant_id: tenantId, name }).first()) as ServerRow | undefined;
  }

  async tools(serverId: string): Promise<ToolRow[]> {
    return (await this.db('mcp_tools').where({ server_id: serverId }).orderBy('name')) as ToolRow[];
  }

  async tool(serverId: string, name: string): Promise<ToolRow> {
    const t = (await this.db('mcp_tools').where({ server_id: serverId, name }).first()) as ToolRow | undefined;
    if (!t) throw notFound('Tool');
    return t;
  }

  async events(serverId: string, limit = 50) {
    const rows = (await this.db('mcp_events').where({ server_id: serverId }).orderBy('ts', 'desc').limit(limit)) as { id: string; title: string; text: string | null; tone: string | null; ts: number }[];
    return rows.map((e) => ({ id: e.id, title: e.title, text: e.text, tone: e.tone ?? '', ts: Number(e.ts) }));
  }

  private async event(serverId: string, title: string, text: string | null, tone: '' | 'ok' | 'warn' | 'danger'): Promise<void> {
    await this.db('mcp_events').insert({ id: ulid(), server_id: serverId, title: title.slice(0, 300), text: text?.slice(0, 1000) ?? null, tone, ts: Date.now() });
  }

  private async notifyAdmins(tenantId: string, title: string, body: string): Promise<void> {
    const users = await this.notifications.usersWithRoles(tenantId, ['tool-admin', 'tenant-admin']);
    await this.notifications.notify({ tenantId, userIds: users, kind: 'mcp', title, body, route: 'mcp-servers' }).catch((err: Error) => this.log.warn({ err: err.message }, 'mcp notification failed'));
  }

  // ---------- registration and checks ----------

  async register(p: Principal, input: { name: string; description: string | null; url: string; zone: string; auth: 'none' | 'service' | 'user'; credential?: string | null }): Promise<{ server: ServerRow; report: CheckLine[] }> {
    try {
      await checkUrl(input.url, this.allow);
    } catch (err) {
      if (err instanceof HostRefused) throw new HttpProblem(422, 'Internal only', err.message, { extensions: { reason: 'public-host' } });
      throw err;
    }
    if (await this.byName(p.tenantId, input.name)) throw conflict('A server with that name exists.');
    if (input.auth === 'service' && !input.credential) throw conflict('A service token is needed for service authorization.');
    const t = Date.now();
    const id = ulid();
    const row: ServerRow = { id, tenant_id: p.tenantId, name: input.name, description: input.description, url: input.url, zone: input.zone, auth: input.auth, credential: input.auth === 'service' && input.credential ? await this.keys.seal(p.tenantId, input.credential, `mcp-credential:${id}`) : null, credential_rotated_at: input.credential ? t : null, vault_owner: input.auth === 'service' && isVaultRef(input.credential) ? p.userId : null, state: 'active', health: 'registering', health_detail: null, protocol_version: null, server_info: null, latency_ms: null, failures: 0, last_checked_at: null, last_ok_at: null, created_by: p.userId, created_at: t, updated_at: t };
    await this.db('mcp_servers').insert(row);
    await this.event(id, 'Registered', `Streamable HTTP at ${input.url}, zone ${input.zone}.`, '');
    const report = await this.check(row, { asUser: p });
    return { server: (await this.server(p.tenantId, id))!, report };
  }

  private async client(s: ServerRow, token: string | null): Promise<McpClient> {
    return new McpClient(s.url, { dispatcher: this.agent, allow: this.allow, timeoutMs: this.o.timeoutMs, token });
  }

  /**
   * Sprint 25 (B-1705): resolves a `vault:` service token reference as the user who saved it (set by createServices;
   * a reference does not resolve without it).
   */
  vaultResolver: ((tenantId: string, ownerId: string | null, ref: string, via: string) => Promise<string>) | null = null;

  private async serviceToken(s: ServerRow): Promise<string | null> {
    if (s.auth !== 'service' || !s.credential) return null;
    const token = await this.keys.open(s.tenant_id, s.credential, `mcp-credential:${s.id}`);
    if (!isVaultRef(token)) return token;
    if (!this.vaultResolver) throw conflict('This server takes its token from the vault, which cannot be read here.');
    return this.vaultResolver(s.tenant_id, s.vault_owner ?? null, token, `mcp-server:${s.id}`);
  }

  /**
   * One health and compatibility check: handshake, tools/list and hash comparison. The result is stored on the
   * server; health transitions go to the changes timeline and the audit chain.
   */
  async check(s: ServerRow, opts: { signal?: AbortSignal; asUser?: Principal } = {}): Promise<CheckLine[]> {
    const signal = opts.signal;
    if (s.state !== 'active') return [{ check: 'Server', result: 'skipped', detail: 'Deregistered.' }];
    const report: CheckLine[] = [];
    const started = Date.now();
    let health: ServerHealth;
    let detail: string | null = null;
    const upd: Partial<ServerRow> = { last_checked_at: started };
    try {
      await checkUrl(s.url, this.allow);
      report.push({ check: 'Internal address', result: 'passed', detail: 'Every resolved address is internal or allow-listed.' });
    } catch (err) {
      if (!(err instanceof HostRefused)) throw err;
      report.push({ check: 'Internal address', result: 'failed', detail: err.message });
      return this.finish(s, report, 'unreachable', err.message, { ...upd, failures: Number(s.failures) + 1 });
    }
    // A per-user server is checked with the checking admin's own token when they have connected one (the scheduled
    // poll has no user and checks without one; servers that insist answer 401, reported as a failed handshake).
    let client: McpClient;
    try {
      client = await this.client(s, s.auth === 'user' ? (opts.asUser ? await this.userToken(s, opts.asUser.userId) : null) : await this.serviceToken(s));
      const init = await client.initialize(signal);
      report.push({ check: 'Initialize handshake', result: 'passed', detail: `Protocol ${init.protocolVersion}${init.serverInfo?.name ? `, ${init.serverInfo.name} ${init.serverInfo.version ?? ''}`.trimEnd() : ''}.` });
      upd.protocol_version = init.protocolVersion;
      upd.server_info = init.serverInfo ? JSON.stringify(init.serverInfo) : null;
    } catch (err) {
      const e = err as McpError;
      const incompatible = e instanceof McpError && e.kind === 'incompatible';
      report.push({ check: 'Initialize handshake', result: 'failed', detail: e.message });
      report.push({ check: 'tools/list', result: 'skipped', detail: '' });
      return this.finish(s, report, incompatible ? 'incompatible' : 'unreachable', e.message, { ...upd, failures: Number(s.failures) + 1 });
    }
    try {
      const tools = await client.listTools(signal);
      upd.latency_ms = Date.now() - started;
      const changed = await this.syncTools(s, tools);
      report.push({ check: 'tools/list', result: changed.length ? 'changed' : 'passed', detail: `${tools.length} tool${tools.length === 1 ? '' : 's'}, ${changed.length ? `${changed.length} hash${changed.length === 1 ? '' : 'es'} differ${changed.length === 1 ? 's' : ''} from the approved one: ${changed.join(', ')}` : 'approved hashes match'}.` });
      health = (await this.db('mcp_tools').where({ server_id: s.id, state: 'changed' }).first('id')) ? 'changed' : 'healthy';
      if (health === 'changed') detail = 'A tool no longer matches its approved hash and is disabled.';
      return this.finish(s, report, health, detail, { ...upd, failures: 0, last_ok_at: Date.now() });
    } catch (err) {
      const e = err as Error;
      report.push({ check: 'tools/list', result: 'failed', detail: e.message });
      return this.finish(s, report, 'unreachable', e.message, { ...upd, failures: Number(s.failures) + 1 });
    }
  }

  private async finish(s: ServerRow, report: CheckLine[], health: ServerHealth, detail: string | null, upd: Partial<ServerRow>): Promise<CheckLine[]> {
    await this.db('mcp_servers').where({ id: s.id }).update({ ...upd, health, health_detail: detail ? scrubSecrets(detail).slice(0, 500) : null, updated_at: Date.now() });
    if (health !== s.health) {
      const tone = health === 'healthy' ? 'ok' : health === 'changed' ? 'danger' : health === 'registering' ? '' : 'danger';
      const title = health === 'healthy' ? (s.health === 'registering' ? 'Compatibility passed' : 'Health restored') : health === 'unreachable' ? 'Health check failing' : health === 'incompatible' ? 'Compatibility failed' : 'Tool schema changed';
      await this.event(s.id, title, detail ?? report.map((r) => `${r.check}: ${r.result}`).join('; '), tone);
      await this.audit.append({ tenantId: s.tenant_id, action: `mcp.health.${health}`, kind: 'system', actor: { service: 'mcp' }, target: { mcpServer: s.id, name: s.name }, detail: { from: s.health, to: health, detail } });
      if (health === 'unreachable' || health === 'incompatible') await this.notifyAdmins(s.tenant_id, `MCP server ${s.name}: ${title.toLowerCase()}`, detail ?? '');
    }
    return report;
  }

  /** Stores what the server announces; returns the names of approved tools whose hash changed. */
  private async syncTools(s: ServerRow, announced: McpToolInfo[]): Promise<string[]> {
    const existing = await this.tools(s.id);
    const changed: string[] = [];
    const t = Date.now();
    const seen = new Set<string>();
    for (const a of announced.slice(0, 500)) {
      if (seen.has(a.name)) continue;
      seen.add(a.name);
      const hash = hashTool(a);
      const cur = existing.find((x) => x.name === a.name);
      const fields = { description: a.description?.slice(0, 2000) ?? null, input_schema: a.inputSchema ? JSON.stringify(a.inputSchema) : null, annotations: a.annotations ? JSON.stringify(a.annotations) : null, hash, updated_at: t };
      if (!cur) {
        const side = suggestSide(a.annotations ?? {});
        await this.db('mcp_tools').insert({ id: ulid(), server_id: s.id, tenant_id: s.tenant_id, name: a.name.slice(0, 120), ...fields, approved_hash: null, approved_schema: null, state: 'pending', side_effect: null, confirm: null, label: null, approved_by: null, approved_at: null, created_at: t });
        if (s.health !== 'registering') await this.event(s.id, `${a.name} offered by server`, `${side === 'destructive' ? 'destructiveHint: true. ' : ''}Not approved; hidden from every profile.`, side === 'destructive' ? 'warn' : '');
        continue;
      }
      if (cur.hash === hash && cur.state !== 'removed') continue;
      let state: ToolState = cur.state;
      if (cur.approved_hash) {
        if (hash === cur.approved_hash) state = cur.state === 'rejected' || cur.state === 'changed' || cur.state === 'removed' ? 'approved' : cur.state;
        else if (cur.state === 'approved' || cur.state === 'removed') {
          state = 'changed';
          changed.push(a.name);
          await this.event(s.id, 'Schema changed', `${a.name} hash ${hash.slice(0, 8)} differs from approved ${cur.approved_hash.slice(0, 8)}. Tool disabled until re-approved.`, 'danger');
          await this.audit.append({ tenantId: s.tenant_id, action: 'mcp.tool.changed', kind: 'system', actor: { service: 'mcp' }, target: { mcpServer: s.id, name: s.name, tool: a.name }, detail: { approvedHash: cur.approved_hash, announcedHash: hash } });
          await this.notifyAdmins(s.tenant_id, `${s.name}.${a.name} changed its schema`, 'The tool is disabled until a tool admin approves the new schema.');
        } else if (cur.state === 'changed' || cur.state === 'rejected') changed.push(a.name);
      } else if (cur.state === 'removed' || cur.state === 'rejected') state = 'pending';
      await this.db('mcp_tools').where({ id: cur.id }).update({ ...fields, state });
    }
    for (const cur of existing.filter((x) => !seen.has(x.name) && x.state !== 'removed')) {
      await this.db('mcp_tools').where({ id: cur.id }).update({ state: 'removed', updated_at: t });
      await this.event(s.id, `${cur.name} no longer offered`, 'Removed from routing; it returns if the server offers the same schema again.', 'warn');
    }
    return changed;
  }

  /** Checks every active server of a tenant (the polling job). */
  async pollTenant(tenantId: string, progress?: (pct: number, msg?: string) => Promise<void>, signal?: AbortSignal) {
    const list = (await this.servers(tenantId)).filter((s) => s.state === 'active');
    const out: { server: string; health: string }[] = [];
    for (const [i, s] of list.entries()) {
      if (signal?.aborted) break;
      await this.check(s, { ...(signal ? { signal } : {}) }).catch((err: Error) => this.log.warn({ err: err.message, server: s.id }, 'mcp check failed'));
      out.push({ server: s.name, health: (await this.server(tenantId, s.id)).health });
      await progress?.(((i + 1) / list.length) * 100, s.name);
    }
    return out;
  }

  // ---------- review ----------

  async approveTool(p: Principal, s: ServerRow, name: string, input: { sideEffect: SideEffect; confirm: 'always' | 'never'; label: Label }): Promise<ToolRow> {
    if (s.state !== 'active') throw conflict('The server is deregistered.');
    const t = await this.tool(s.id, name);
    if (t.state === 'removed') throw conflict('The server no longer offers this tool.');
    if (input.sideEffect !== 'read' && input.confirm === 'never') throw conflict('Write and destructive tools need confirmation on every call.');
    const approvedSchema = JSON.stringify({ name: t.name, description: t.description, inputSchema: json(t.input_schema, null), annotations: json(t.annotations, null) });
    const now = Date.now();
    await this.db('mcp_tools').where({ id: t.id }).update({ state: 'approved', approved_hash: t.hash, approved_schema: approvedSchema, side_effect: input.sideEffect, confirm: input.confirm, label: input.label, approved_by: p.userId, approved_at: now, updated_at: now });
    await this.registry.upsertMcpEntry(p, { serverId: s.id, serverName: s.name, tool: t.name, description: t.description, inputSchema: json(t.input_schema, null), sideEffect: input.sideEffect, confirm: input.confirm, label: input.label, hash: t.hash });
    await this.event(s.id, `${t.name} approved as ${input.sideEffect}`, `Hash ${t.hash.slice(0, 8)} recorded; confirmation ${input.confirm}. Reviewer ${p.displayName}.`, 'ok');
    if (!(await this.db('mcp_tools').where({ server_id: s.id, state: 'changed' }).first('id')) && s.health === 'changed') {
      await this.db('mcp_servers').where({ id: s.id }).update({ health: 'healthy', health_detail: null, updated_at: now });
    }
    return this.tool(s.id, name);
  }

  /** Revoking hides the tool again; a rejected change keeps the tool disabled with its old approval on record. */
  async revokeTool(s: ServerRow, name: string, how: 'revoke' | 'reject-change', by: Principal): Promise<ToolRow> {
    const t = await this.tool(s.id, name);
    const now = Date.now();
    if (how === 'revoke') {
      if (t.state !== 'approved') throw conflict('Only approved tools can be revoked.');
      await this.db('mcp_tools').where({ id: t.id }).update({ state: 'pending', approved_hash: null, approved_schema: null, approved_by: null, approved_at: null, updated_at: now });
      await this.event(s.id, `${t.name} approval revoked`, `Hidden from every bound profile. By ${by.displayName}.`, 'warn');
    } else {
      if (t.state !== 'changed') throw conflict('The tool has no pending schema change.');
      await this.db('mcp_tools').where({ id: t.id }).update({ state: 'rejected', updated_at: now });
      await this.event(s.id, `Schema change to ${t.name} rejected`, `The tool stays disabled until the server restores the approved schema. By ${by.displayName}.`, 'warn');
    }
    return this.tool(s.id, name);
  }

  async deregister(s: ServerRow): Promise<void> {
    await this.db('mcp_servers').where({ id: s.id }).update({ state: 'deregistered', updated_at: Date.now() });
    await this.db('mcp_tokens').where({ server_id: s.id }).delete();
    for (const e of await this.registry.mcpEntries(s.tenant_id, s.id)) if (e.status === 'published') await this.registry.setStatus(e, 'deprecated', { replacement: null });
    await this.event(s.id, 'Deregistered', 'Tools removed from routing; registry entries deprecated; user tokens deleted.', 'danger');
  }

  async rotateCredential(s: ServerRow, secret: string, by: string | null = null): Promise<void> {
    if (s.auth !== 'service') throw conflict('This server does not use a service token.');
    const now = Date.now();
    await this.db('mcp_servers').where({ id: s.id }).update({ credential: await this.keys.seal(s.tenant_id, secret, `mcp-credential:${s.id}`), credential_rotated_at: now, vault_owner: isVaultRef(secret) ? by : null, updated_at: now });
    await this.event(s.id, 'Credentials rotated', 'The service token was replaced.', 'ok');
  }

  // ---------- the per-user vault ----------

  async setToken(p: Principal, s: ServerRow, token: string, input: { scopes?: string | null; expiresAt?: number | null }): Promise<void> {
    if (s.auth !== 'user') throw conflict('This server does not use per-user tokens.');
    const row = { id: ulid(), server_id: s.id, tenant_id: p.tenantId, user_id: p.userId, token: '', scopes: input.scopes ?? null, expires_at: input.expiresAt ?? null, created_at: Date.now() };
    row.token = await this.keys.seal(p.tenantId, token, `mcp-token:${s.id}:${p.userId}`);
    await this.db('mcp_tokens').where({ server_id: s.id, user_id: p.userId }).delete();
    await this.db('mcp_tokens').insert(row);
  }

  async removeToken(p: Principal, s: ServerRow): Promise<boolean> {
    return (await this.db('mcp_tokens').where({ server_id: s.id, user_id: p.userId }).delete()) > 0;
  }

  /** Who has connected a token (never the token). */
  async connections(serverId: string) {
    const rows = (await this.db('mcp_tokens as t').join('users as u', 'u.id', 't.user_id').where({ 't.server_id': serverId }).select('t.user_id', 'u.display_name', 't.scopes', 't.expires_at', 't.created_at')) as { user_id: string; display_name: string; scopes: string | null; expires_at: number | null; created_at: number }[];
    return rows.map((r) => ({ userId: r.user_id, name: r.display_name, scopes: r.scopes, expiresAt: num(r.expires_at), connectedAt: Number(r.created_at), expired: r.expires_at != null && Number(r.expires_at) < Date.now() }));
  }

  async tokenStatus(p: Principal, serverId: string) {
    const r = (await this.db('mcp_tokens').where({ server_id: serverId, user_id: p.userId }).first('scopes', 'expires_at', 'created_at')) as { scopes: string | null; expires_at: number | null; created_at: number } | undefined;
    return r ? { connected: true, scopes: r.scopes, expiresAt: num(r.expires_at), expired: r.expires_at != null && Number(r.expires_at) < Date.now(), connectedAt: Number(r.created_at) } : { connected: false };
  }

  private async userToken(s: ServerRow, userId: string): Promise<string | null> {
    const r = (await this.db('mcp_tokens').where({ server_id: s.id, user_id: userId }).first('token', 'expires_at')) as { token: string; expires_at: number | null } | undefined;
    if (!r || (r.expires_at != null && Number(r.expires_at) < Date.now())) return null;
    return this.keys.open(s.tenant_id, r.token, `mcp-token:${s.id}:${userId}`);
  }

  // ---------- calls ----------

  /** Why a tool cannot be called now, or null. The dispatcher hides tools with a reason; calls get a typed error. */
  async unavailable(serverId: string, toolName: string, userId: string): Promise<string | null> {
    const s = (await this.db('mcp_servers').where({ id: serverId }).first()) as ServerRow | undefined;
    if (!s || s.state !== 'active') return 'The MCP server is deregistered.';
    if (s.health === 'unreachable' || s.health === 'incompatible') return `The MCP server ${s.name} is ${s.health}.`;
    const t = (await this.db('mcp_tools').where({ server_id: s.id, name: toolName }).first()) as ToolRow | undefined;
    if (!t || t.state !== 'approved' || t.hash !== t.approved_hash) return `${s.name}.${toolName} is ${t ? (t.state === 'changed' ? 'disabled until its new schema is approved' : t.state === 'approved' ? 'changed since approval' : t.state === 'pending' ? 'not approved' : t.state) : 'not offered'}.`;
    if (s.auth === 'user' && !(await this.userToken(s, userId))) return `Connect your token for ${s.name} first (vault connection needed).`;
    return null;
  }

  async call(p: Principal, serverId: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const why = await this.unavailable(serverId, toolName, p.userId);
    if (why) throw new McpError(why, null, 'refused');
    const s = (await this.db('mcp_servers').where({ id: serverId }).first()) as ServerRow;
    const token = s.auth === 'user' ? await this.userToken(s, p.userId) : await this.serviceToken(s);
    const client = await this.client(s, token);
    await client.initialize(signal);
    return client.callTool(toolName, args, signal);
  }

  assertTenant(s: ServerRow, p: Principal): void {
    if (s.tenant_id !== p.tenantId) throw forbidden('Another tenant\'s server.', { step: 'tenant' });
  }
}
