import { ulid } from 'ulid';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Db } from '../db/knex.js';
import type { AuditLog } from '../audit/chain.js';
import { actorFrom } from '../audit/chain.js';
import type { AllowList } from '../mcp/hosts.js';
import { guardedRequest, ServiceUrlRefused, toolAddressProblem, type ServicePolicy } from '../platform/egress.js';
import { parseVaultRef } from '../vault/policy.js';
import type { ToolCallContext } from './dispatch.js';
import type { EntryRow, SideEffect } from './service.js';

/*
 * 1.6.0, Sprint 37a (B-89): registry tools that call an outside HTTP API (`impl: 'http'`), ported from
 * exprsn-platform's agent runtime with the constraints of the port findings (decision D11c):
 *
 * - The URL's scheme and host are fixed by the author; only path and query parameters come from the tool's arguments
 *   (`{name}` placeholders naming properties of the input schema), percent-encoded.
 * - Every call goes through the outbound address guard (`platform/egress.ts`, `guardedRequest`): resolved once, every
 *   address checked, the connection pinned, redirects not followed. Internal hosts only as SERVICE_ALLOWED_HOSTS
 *   names them; public hosts only from the tenant's list of allowed hosts (the list webhooks and workflow HTTP steps
 *   read). Cloud metadata addresses never.
 * - Secret-bearing headers, query parameters and body fields only as `vault:path#key` references, resolved at call
 *   time as the tool's author under the vault policies; a literal is refused when the tool is saved.
 * - The dispatcher applies the tool-call guardrail to the arguments, the rate limit, the context checkpoint and the
 *   untrusted-content checkpoint (B-6902) to the result; this runner meters and audits each call
 *   (`registry.http.called`: host, method, status, size, latency; never a header, query string or body).
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Headers a tool may not set: the transport's own. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-connection', 'expect']);
/** Headers whose values are credentials: they take a vault reference only. */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie)$|(token|secret|api-?key|apikey|password|passwd|signature|session|auth)/i;
/** Query parameters and body fields whose values are credentials. */
const SECRET_FIELD = /(^|[_.-])(key|apikey|api_key|token|access_token|secret|client_secret|password|passwd|pwd|auth|authorization|signature|sig|credential|credentials|session)([_.-]|$)|apikey|accesstoken|clientsecret/i;

const PLACEHOLDER = /\{([A-Za-z_][\w-]{0,62})\}/g;
const VAULT_PLACEHOLDER = /\{(vault:[^{}\s]+)\}/g;
/** A value that is a vault reference, optionally after an authorization scheme. */
const VAULT_VALUE = /^((?:Bearer|Basic|Token|Bot) )?(vault:\S+)$/;

export const httpDefinitionSchema = z
  .object({
    method: z.enum(HTTP_METHODS),
    url: z.string().trim().min(8).max(2000),
    query: z.record(z.string().regex(/^[A-Za-z0-9_.[\]-]{1,100}$/, 'Query parameter names: letters, digits and _ . - [ ]'), z.string().max(1000)).default({}),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'Header names: letters, digits and hyphens'), z.string().max(2000)).default({}),
    body: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('none') }).strict(),
        z.object({ mode: z.literal('args') }).strict(),
        z.object({ mode: z.literal('template'), template: z.string().min(1).max(20_000), contentType: z.string().trim().max(100).default('application/json') }).strict()
      ])
      .default({ mode: 'none' }),
    response: z
      .object({
        pointer: z.string().max(500).regex(/^(\/.*)?$/, 'A JSON pointer starts with /').nullable().default(null),
        maxBytes: z.number().int().min(256).max(16 * 1024 * 1024).default(64 * 1024)
      })
      .strict()
      .default({ pointer: null, maxBytes: 64 * 1024 }),
    timeoutMs: z.number().int().min(500).max(120_000).default(10_000)
  })
  .strict();
export type HttpDefinition = z.infer<typeof httpDefinitionSchema>;

/** GET tools are read; every other method is write unless the author raises it to destructive. */
export function httpSideEffect(method: HttpMethod, requested: SideEffect | null | undefined): SideEffect {
  if (method === 'GET') return 'read';
  return requested === 'destructive' ? 'destructive' : 'write';
}

const placeholders = (s: string): string[] => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]!);

/** Every vault reference in a definition (header and query values, body placeholders). */
export function httpVaultRefs(d: HttpDefinition): string[] {
  const out: string[] = [];
  for (const v of [...Object.values(d.headers), ...Object.values(d.query)]) {
    const m = VAULT_VALUE.exec(v);
    if (m) out.push(m[2]!);
  }
  if (d.body.mode === 'template') for (const m of d.body.template.matchAll(VAULT_PLACEHOLDER)) out.push(m[1]!);
  return [...new Set(out)];
}

/**
 * What is wrong with a definition against the tool's input schema, or an empty list: a host or scheme taken from
 * arguments, placeholders that are not properties, a reserved header, a credential given as a literal, a bad vault
 * reference, a body on a GET.
 */
export function httpDefinitionProblems(d: HttpDefinition, inputSchema: unknown): string[] {
  const out: string[] = [];
  const props = new Set(Object.keys(((inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {}));
  const origin = /^(https?):\/\/([^/?#]*)/i.exec(d.url);
  if (!origin) out.push('The URL template must start with http:// or https:// and a host.');
  else {
    if (/[{}]/.test(origin[2]!)) out.push('The host is fixed: only the path and query take parameters.');
    if (/@/.test(origin[2]!)) out.push('Credentials do not belong in the URL; use a vault reference in a header.');
  }
  try {
    new URL(d.url.replace(PLACEHOLDER, 'x'));
  } catch {
    out.push('The URL template is not a URL.');
  }
  const used = [...placeholders(d.url), ...Object.values(d.query).flatMap(placeholders), ...Object.values(d.headers).flatMap(placeholders), ...(d.body.mode === 'template' ? placeholders(d.body.template) : [])];
  const unknown = [...new Set(used.filter((n) => !props.has(n)))];
  if (unknown.length) out.push(`${unknown.map((n) => `{${n}}`).join(', ')} ${unknown.length === 1 ? 'is not a property' : 'are not properties'} of the input schema.`);
  // The URL's own query string: a credential there is a literal too.
  const qs = d.url.includes('?') ? d.url.slice(d.url.indexOf('?') + 1).split('#')[0]! : '';
  for (const part of qs ? qs.split('&') : []) {
    const [k = '', v = ''] = part.split('=');
    if (SECRET_FIELD.test(decodeURIComponent(k)) && !/^\{[\w-]+\}$/.test(v)) out.push(`The query parameter ${k} in the URL carries a credential; move it to the query parameters as a vault reference.`);
  }
  for (const [k, v] of Object.entries(d.headers)) {
    if (RESERVED_HEADERS.has(k.toLowerCase())) out.push(`The header ${k} is set by the transport and cannot be set by a tool.`);
    const ref = VAULT_VALUE.exec(v);
    if (SECRET_HEADER.test(k) && !ref) out.push(`The header ${k} carries a credential: use a vault reference (vault:path#key, optionally after Bearer, Basic or Token), never a literal.`);
  }
  for (const [k, v] of Object.entries(d.query)) {
    if (SECRET_FIELD.test(k) && !VAULT_VALUE.exec(v)) out.push(`The query parameter ${k} carries a credential: use a vault reference (vault:path#key), never a literal.`);
  }
  if (d.body.mode === 'template') {
    // A credential field in the body takes a vault placeholder ({vault:path#key}) or an argument, never a literal.
    for (const m of d.body.template.matchAll(/"([^"\\]{1,100})"\s*:\s*"([^"\\]*)"/g)) {
      if (SECRET_FIELD.test(m[1]!) && m[2]!.length && !/^\{(vault:[^{}\s]+|[A-Za-z_][\w-]{0,62})\}$/.test(m[2]!)) out.push(`The body field ${m[1]} carries a credential: use {vault:path#key} or an argument, never a literal.`);
    }
  }
  if (d.method === 'GET' && d.body.mode !== 'none') out.push('A GET tool sends no body.');
  for (const ref of httpVaultRefs(d)) if (!parseVaultRef(ref)) out.push(`${ref.slice(0, 120)} is not a vault reference: they look like vault:<path>#<key>.`);
  return [...new Set(out)];
}

/** The definition of a saved entry, or a clear error. */
export function parseHttpDefinition(raw: unknown): HttpDefinition {
  const r = httpDefinitionSchema.safeParse(raw);
  if (!r.success) throw new Error(`The HTTP tool's definition is not valid: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`).join('; ')}.`);
  return r.data;
}

/** RFC 6901: the value at a JSON pointer ('' or null: the whole document); undefined when it is not there. */
export function jsonPointer(doc: unknown, pointer: string | null): unknown {
  if (!pointer) return doc;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      cur = cur[Number(key)];
    } else if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, key)) cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

const scalar = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export interface HttpToolDeps {
  db: Db;
  audit: AuditLog;
  log: Logger;
  /** The operator's service policy (SERVICE_ALLOWED_HOSTS): which internal hosts a tool may reach. */
  policy: ServicePolicy;
  /** The tenant's list of allowed hosts, parsed (null: none). */
  tenantHosts: (tenantId: string) => Promise<AllowList | null>;
  /** Resolves a vault reference as the tool's author (`VaultService.resolveFor`). */
  vault: (tenantId: string, ownerId: string | null, ref: string, via: string) => Promise<string>;
  /** HTTP_TOOL_TIMEOUT_MS and HTTP_TOOL_MAX_RESPONSE_BYTES: the most a tool may ask for. */
  maxTimeoutMs: number;
  maxResponseBytes: number;
}

/** Runs `impl: http` registry tools for the dispatcher. */
export class HttpToolRunner {
  constructor(private readonly d: HttpToolDeps) {}

  /** Renders a template: `{name}` from the arguments (encoded for a URL when `encode`). */
  private render(t: string, args: Record<string, unknown>, encode: boolean): string {
    return t.replace(PLACEHOLDER, (_m, name: string) => {
      const v = args[name];
      if (v === undefined || v === null) throw new Error(`The argument ${name} is needed for the URL.`);
      return encode ? encodeURIComponent(scalar(v)) : scalar(v);
    });
  }

  /** A header or query value: a vault reference resolved as the author, else a template over the arguments. */
  private async value(raw: string, args: Record<string, unknown>, entry: EntryRow): Promise<string | null> {
    const ref = VAULT_VALUE.exec(raw);
    if (ref) return (ref[1] ?? '') + (await this.secret(entry, ref[2]!));
    const names = placeholders(raw);
    // A value made of one optional argument the caller left out is omitted.
    if (names.length && names.every((n) => args[n] === undefined || args[n] === null)) return null;
    return raw.replace(PLACEHOLDER, (_m, name: string) => scalar(args[name]));
  }

  private async secret(entry: EntryRow, ref: string): Promise<string> {
    try {
      return await this.d.vault(entry.tenant_id ?? '', entry.owner_id, ref, `registry:${entry.name}`);
    } catch (err) {
      throw new Error(`${ref} could not be read from the vault as the tool's author: ${(err as Error).message}`, { cause: err });
    }
  }

  /** Builds the request: URL, query, headers and body. Secrets are resolved here and never leave this function. */
  async build(entry: EntryRow, args: Record<string, unknown>): Promise<{ def: HttpDefinition; url: URL; headers: Record<string, string>; body?: string }> {
    const def = parseHttpDefinition(entry.definition);
    const [beforeQuery, afterQuery] = def.url.split(/\?(.*)/s, 2) as [string, string | undefined];
    const used = new Set([...placeholders(def.url)]);
    let urlText = this.render(beforeQuery, args, true);
    if (afterQuery !== undefined) urlText += `?${this.render(afterQuery, args, true)}`;
    const url = new URL(urlText);
    for (const [k, v] of Object.entries(def.query)) {
      placeholders(v).forEach((n) => used.add(n));
      const val = await this.value(v, args, entry);
      if (val !== null) url.searchParams.append(k, val);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(def.headers)) {
      placeholders(v).forEach((n) => used.add(n));
      const val = await this.value(v, args, entry);
      if (val !== null) headers[k.toLowerCase()] = val;
    }
    let body: string | undefined;
    if (def.body.mode === 'args') {
      body = JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k))));
      headers['content-type'] ??= 'application/json';
    } else if (def.body.mode === 'template') {
      let text = def.body.template;
      for (const m of [...text.matchAll(VAULT_PLACEHOLDER)]) text = text.split(m[0]).join(JSON.stringify(await this.secret(entry, m[1]!)).slice(1, -1));
      body = text.replace(PLACEHOLDER, (_m, name: string) => JSON.stringify(args[name] ?? null));
      headers['content-type'] ??= def.body.contentType;
    }
    headers.accept ??= 'application/json, text/plain;q=0.9, */*;q=0.5';
    return { def, url, headers, ...(body !== undefined ? { body } : {}) };
  }

  async run(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown> {
    const p = ctx.principal;
    const { def, url, headers, body } = await this.build(entry, args);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const tenant = await this.d.tenantHosts(p.tenantId);
    const t0 = Date.now();
    let status = 0;
    let bytes = 0;
    let outcome: 'ok' | 'http-error' | 'refused' | 'failed' = 'failed';
    try {
      const res = await guardedRequest({
        method: def.method,
        url,
        headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: Math.min(def.timeoutMs, this.d.maxTimeoutMs),
        maxBytes: Math.min(def.response.maxBytes, this.d.maxResponseBytes),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        check: (address, h) => toolAddressProblem(address, h, this.d.policy, tenant)
      });
      status = res.status;
      bytes = res.body.length;
      if (status < 200 || status >= 300) {
        outcome = 'http-error';
        throw new Error(`${def.method} ${host} answered ${status}${status >= 300 && status < 400 ? ' (redirects are not followed)' : ''}.`);
      }
      const text = res.body.toString('utf8');
      let doc: unknown = text;
      if (res.contentType && /json/i.test(res.contentType)) {
        try {
          doc = JSON.parse(text) as unknown;
        } catch {
          doc = text;
        }
      }
      const value = jsonPointer(doc, def.response.pointer);
      if (value === undefined) throw new Error(`The answer has nothing at ${def.response.pointer}.`);
      outcome = 'ok';
      return value;
    } catch (err) {
      if (outcome === 'http-error' || status !== 0) throw err;
      if (err instanceof ServiceUrlRefused) {
        const refused = !/larger than|No answer within/.test(err.message);
        outcome = refused ? 'refused' : 'failed';
        throw new Error(`${refused ? 'egress_refused' : 'http_failed'}: ${err.message}`, { cause: err });
      }
      throw new Error(`http_failed: ${(err as Error).message}`, { cause: err });
    } finally {
      await this.record(ctx, entry, { host, method: def.method, status, bytes, latencyMs: Date.now() - t0, outcome }).catch((e: unknown) => this.d.log.warn({ err: e, tool: entry.name }, 'HTTP tool call not recorded'));
    }
  }

  /** The meter row and the audit event of one call: host, method, status, size, latency; no URL, header or body. */
  private async record(ctx: ToolCallContext, entry: EntryRow, c: { host: string; method: string; status: number; bytes: number; latencyMs: number; outcome: string }): Promise<void> {
    const p = ctx.principal;
    await this.d.db('registry_http_calls').insert({ id: ulid(), tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, user_id: p.userId, entry_id: entry.id, tool: entry.name.slice(0, 120), host: c.host.slice(0, 253), method: c.method, status: c.status, bytes: c.bytes, latency_ms: c.latencyMs, outcome: c.outcome, created_at: Date.now() });
    await this.d.audit.append({ tenantId: p.tenantId, action: 'registry.http.called', kind: 'system', actor: actorFrom(p), target: { registryEntry: entry.id, name: entry.name, version: entry.version }, label: ctx.label, detail: { host: c.host, method: c.method, status: c.status, bytes: c.bytes, latencyMs: c.latencyMs, outcome: c.outcome, ...(ctx.source ? { via: ctx.source.kind } : {}) } });
  }

  /** Calls of a tool over the last day: how many, how many failed, the median latency. */
  async stats(tenantId: string, entryId: string) {
    const rows = (await this.d.db('registry_http_calls').where({ tenant_id: tenantId, entry_id: entryId }).andWhere('created_at', '>=', Date.now() - 86_400_000).orderBy('created_at', 'desc').limit(1000).select('outcome', 'status', 'latency_ms', 'host', 'created_at')) as { outcome: string; status: number; latency_ms: number; host: string; created_at: number }[];
    const lat = rows.map((r) => Number(r.latency_ms)).sort((a, b) => a - b);
    return { calls: rows.length, failed: rows.filter((r) => r.outcome !== 'ok').length, refused: rows.filter((r) => r.outcome === 'refused').length, medianMs: lat.length ? lat[Math.floor(lat.length / 2)]! : null, last: rows[0] ? { at: Number(rows[0].created_at), status: Number(rows[0].status), outcome: rows[0].outcome, host: rows[0].host } : null };
  }
}
