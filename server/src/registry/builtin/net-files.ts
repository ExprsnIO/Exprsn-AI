import { clears, highest, type Label } from '../../authz/labels.js';
import type { Principal } from '../../authz/policy.js';
import type { Services } from '../../services.js';
import { htmlText } from '../../knowledge/extract.js';
import { guardedRequest, servicePolicy, ServiceUrlRefused, toolAddressProblem } from '../../platform/egress.js';
import type { ToolCallContext } from '../dispatch.js';
import type { EntryRow } from '../service.js';
import { CommandRefused, parseFetchCommand, type ParsedCommand } from './curl.js';

/*
 * Migration 048: the built-ins that reach outward and that bridge Files and the script tools.
 *
 * - `http_fetch` (read), `http_request` (write) and `http_download` (write): one HTTP request as curl or wget would
 *   make it, through the outbound address guard and the tenant's list of allowed hosts, like an `impl: http` tool
 *   (`platform/egress.ts`). Each hop of a redirect is checked again. A request is described by its arguments or by a
 *   curl or wget command line (`curl.ts`), which is read, never run.
 * - `files.run_tool` (read) runs one of the tenant's published script tools, or a read-only MCP tool this table knows
 *   (the document converter exprsn-convert), on files in Files: the file's content is put into the tool's arguments
 *   here, so a model never carries the bytes. `files.apply_tool` (write) does the same
 *   and saves one field of the result as a new version of the file or as a new file. `files.save` (write) creates a
 *   file from text or base64, and `files.extract` (write) unpacks members of an archive into Files.
 *
 * Everything acts as the caller through the Files service (membership, clearance, labels, scan) and is audited.
 */

/** Thrown for a call that cannot be made; `BuiltinTools` returns the message to the caller as data. */
export class ToolRefused extends Error {}

export interface BridgeDeps {
  s: Services;
  ctx: ToolCallContext;
  p: Principal;
  /** The caller with their clearance lowered to the label of the call. */
  reader: Principal;
  args: Record<string, unknown>;
  audit: (action: string, target: Record<string, unknown>, label: Label, detail: Record<string, unknown>) => Promise<unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const cleanName = (raw: string): string => raw.replace(/[/\\\0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

// ---------- HTTP ----------

const MAX_REDIRECTS = 5;
/** Headers a caller may not set: the client sets them, or they would change where the request goes. */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'expect']);
const SHOWN_HEADERS = ['content-type', 'content-length', 'content-disposition', 'last-modified', 'etag', 'location', 'cache-control', 'retry-after', 'www-authenticate', 'link'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

interface Fetched {
  finalUrl: URL;
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  body: Buffer;
  redirects: { status: number; to: string }[];
  method: string;
  parsed: ParsedCommand | null;
  notes: string[];
}

async function request(d: BridgeDeps, kind: 'fetch' | 'request' | 'download'): Promise<Fetched> {
  const { s, ctx, p, args } = d;
  let parsed: ParsedCommand | null = null;
  const command = str(args.command);
  if (command) {
    try {
      parsed = parseFetchCommand(command);
    } catch (err) {
      if (err instanceof CommandRefused) throw new ToolRefused(err.message);
      throw err;
    }
  }
  const rawUrl = str(args.url) ?? parsed?.url;
  if (!rawUrl) throw new ToolRefused('Give a url, or a curl or wget command.');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolRefused(`${rawUrl} is not a URL.`);
  }
  let method = (str(args.method) ?? parsed?.method ?? 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw new ToolRefused(`${method} is not a method this tool sends (${METHODS.join(', ')}).`);
  const headers: Record<string, string> = { ...(parsed?.headers ?? {}) };
  if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) headers[k.toLowerCase()] = String(v);
  for (const k of Object.keys(headers)) {
    if (FORBIDDEN_HEADERS.has(k)) throw new ToolRefused(`The header ${k} is set by the client and cannot be given.`);
    if (/[\r\n]/.test(headers[k]!)) throw new ToolRefused(`The header ${k} holds a line break.`);
  }
  let body: string | undefined = typeof args.body === 'string' ? args.body : parsed?.body;
  if (args.json !== undefined) {
    if (body !== undefined && typeof args.body === 'string') throw new ToolRefused('Give body or json, not both.');
    body = JSON.stringify(args.json);
    headers['content-type'] ??= 'application/json';
  }
  if (kind !== 'request') {
    if (body !== undefined || (method !== 'GET' && method !== 'HEAD')) throw new ToolRefused(`${kind === 'fetch' ? 'http_fetch' : 'http_download'} only reads (GET${kind === 'fetch' ? ' and HEAD' : ''}). To send data or use ${method}, call http_request, which waits for approval.`);
    if (kind === 'download' && method !== 'GET') throw new ToolRefused('http_download saves the answer to a GET.');
  }
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) throw new ToolRefused(`A ${method} request carries no body.`);
  headers.accept ??= '*/*';
  headers['accept-encoding'] = 'identity';
  const follow = typeof args.followRedirects === 'boolean' ? args.followRedirects : (parsed?.followRedirects ?? true);
  const maxRedirects = Math.min(parsed?.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS);
  const timeoutMs = Math.min(Math.round((num(args.timeoutSeconds) ?? parsed?.timeoutSeconds ?? 20) * 1000), s.cfg.HTTP_TOOL_TIMEOUT_MS);
  const maxBytes = kind === 'download' ? s.cfg.ATTACHMENT_MAX_BYTES : s.cfg.HTTP_TOOL_MAX_RESPONSE_BYTES;
  const policy = servicePolicy(s.cfg);
  const tenant = await s.integrations.allowList(p.tenantId);
  const redirects: { status: number; to: string }[] = [];
  const first = { host: url.hostname.toLowerCase(), method };
  const t0 = Date.now();
  let status = 0;
  let bytes = 0;
  let outcome: 'ok' | 'http-error' | 'refused' | 'failed' = 'failed';
  try {
    for (;;) {
      const res = await guardedRequest({ method, url, headers, ...(body !== undefined ? { body } : {}), timeoutMs, maxBytes, ...(ctx.signal ? { signal: ctx.signal } : {}), check: (address, h) => toolAddressProblem(address, h, policy, tenant) });
      status = res.status;
      bytes = res.body.length;
      const location = res.headers.location;
      if (follow && location && [301, 302, 303, 307, 308].includes(res.status)) {
        if (redirects.length >= maxRedirects) throw new ToolRefused(`More than ${maxRedirects} redirects; the last one points to ${location}.`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new ToolRefused(`The server redirects to ${location}, which is not a URL.`);
        }
        if (url.protocol === 'https:' && next.protocol === 'http:') throw new ToolRefused(`The server redirects from https to http (${next.host}), which is not followed.`);
        // Credentials stay with the host they were given for, as curl does.
        if (next.host !== url.host) for (const k of ['authorization', 'cookie']) delete headers[k];
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          body = undefined;
          delete headers['content-type'];
        }
        redirects.push({ status: res.status, to: `${next.origin}${next.pathname}` });
        url = next;
        continue;
      }
      outcome = res.status >= 200 && res.status < 400 ? 'ok' : 'http-error';
      return { finalUrl: url, status: res.status, headers: res.headers, contentType: res.contentType, body: res.body, redirects, method, parsed, notes: [...(parsed?.notes ?? [])] };
    }
  } catch (err) {
    if (err instanceof ToolRefused) {
      outcome = 'refused';
      throw err;
    }
    if (err instanceof ServiceUrlRefused) {
      const refused = !/larger than|No answer within/.test(err.message);
      outcome = refused ? 'refused' : 'failed';
      throw new ToolRefused(`${refused ? 'Refused' : 'Failed'}: ${err.message}${/larger than/.test(err.message) && kind !== 'download' ? ' To keep a large file, save it to Files with http_download.' : ''}`);
    }
    throw new ToolRefused(`The request failed: ${(err as Error).message}`);
  } finally {
    // Like an HTTP tool's call: the host, method, status, size and time; no URL path, header or body.
    await d.audit('registry.http.called', { name: kind === 'fetch' ? 'http_fetch' : kind === 'request' ? 'http_request' : 'http_download' }, ctx.label, { host: first.host, method: first.method, status, bytes, latencyMs: Date.now() - t0, outcome, ...(redirects.length ? { redirectedTo: url.hostname.toLowerCase(), redirects: redirects.length } : {}) }).catch(() => undefined);
  }
}

function decodeBody(body: Buffer, contentType: string | null): { text: string; binary: boolean } {
  const type = (contentType ?? '').toLowerCase();
  const textual = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|csv|svg/.test(type);
  if (!textual && (body.subarray(0, 8192).includes(0) || /^(image|audio|video|font)\/|octet-stream|zip|gzip|pdf|x-tar|x-xz|x-bzip/.test(type))) return { text: '', binary: true };
  const charset = /charset=["']?([^;"'\s]+)/.exec(type)?.[1] ?? 'utf-8';
  try {
    return { text: new TextDecoder(charset).decode(body).replace(/^\uFEFF/, ''), binary: false };
  } catch {
    return { text: body.toString('utf8'), binary: false };
  }
}

export async function httpCall(d: BridgeDeps, kind: 'fetch' | 'request'): Promise<unknown> {
  const { args } = d;
  const r = await request(d, kind);
  const from = num(args.from) ?? 0;
  const max = num(args.maxChars) ?? 20_000;
  const type = (r.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const shown = Object.fromEntries(SHOWN_HEADERS.filter((h) => r.headers[h] != null).map((h) => [h, r.headers[h]!.slice(0, 500)]));
  const base = { url: r.finalUrl.toString(), method: r.method, status: r.status, ok: r.status >= 200 && r.status < 300, contentType: type || null, bytes: r.body.length, headers: shown, ...(r.redirects.length ? { redirects: r.redirects } : {}) };
  const notes = [...r.notes];
  if (r.status >= 300 && r.status < 400 && r.headers.location) notes.push('The server answered with a redirect that was not followed (followRedirects is off, as with curl without -L).');
  if (r.method === 'HEAD' || r.body.length === 0) return { ...base, format: 'none', content: '', total: 0, from: 0, next: null, ...(notes.length ? { note: notes.join(' ') } : {}) };
  const { text: decoded, binary } = decodeBody(r.body, r.contentType);
  if (binary) return { ...base, format: 'binary', content: '', total: 0, from: 0, next: null, note: [...notes, `The answer is ${r.body.length} bytes of ${type || 'binary data'}, not text. Save it to Files with http_download, then read it with files.read or files.run_tool.`].join(' ') };
  const asRaw = str(args.as) === 'raw';
  const html = /html/.test(type) || /^\s*(<!doctype html|<html[\s>])/i.test(decoded.slice(0, 500));
  const text = html && !asRaw ? htmlText(decoded) : decoded;
  if (from > text.length) throw new ToolRefused(`The answer has ${text.length} characters; from is past its end.`);
  const next = from + max < text.length ? from + max : null;
  if (next != null) notes.push(`More follows: call again with from ${next} (the page is fetched again).`);
  return { ...base, format: html ? (asRaw ? 'html' : 'text from html') : /json/.test(type) ? 'json' : 'text', content: text.slice(from, from + max), total: text.length, from, next, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

export async function httpDownload(d: BridgeDeps): Promise<unknown> {
  const { s, ctx, p, args } = d;
  const r = await request(d, 'download');
  if (r.status < 200 || r.status >= 300) throw new ToolRefused(`${r.finalUrl.host} answered ${r.status}; nothing was saved.`);
  if (!r.body.length) throw new ToolRefused(`${r.finalUrl.host} answered with an empty body; nothing was saved.`);
  const disposition = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(r.headers['content-disposition'] ?? '')?.[1];
  const lastSegment = r.finalUrl.pathname.split('/').filter(Boolean).pop() ?? '';
  const fromUrl = (() => {
    try {
      return decodeURIComponent(lastSegment);
    } catch {
      return lastSegment;
    }
  })();
  const name = cleanName(str(args.name) ?? r.parsed?.output ?? disposition ?? '') || cleanName(fromUrl) || 'download';
  const type = (r.contentType ?? '').split(';')[0]!.trim() || null;
  const data = r.body;
  const out = await s.files.upload(p, { workspaceId: str(args.workspaceId) ?? null, folderId: str(args.folderId) ?? null, name, label: ctx.label, declaredType: type, declaredBytes: data.length }, (async function* () {
    yield data;
  })());
  return { file: out.file.id, name: out.file.name, version: out.version.number, state: out.version.state, size: data.length, type, label: out.version.label, url: r.finalUrl.toString(), status: r.status, ...(r.redirects.length ? { redirects: r.redirects } : {}), note: 'The file is scanned before it can be read: files.read and files.run_tool take it by this id once its state is ready.' };
}

// ---------- Files and script tools ----------

/** How a file's content goes into a script tool's arguments, and which field of its result is the product. */
// `productEncoding` names the result field that says how the product is encoded ('text' or 'base64') when that differs
// by call, and `productName` the result field with the name to save it under when no saveAs is given.
const BRIDGES: Record<string, { argument: string; as: 'text' | 'base64' | 'text-or-base64'; base64Argument?: string; nameArgument?: string; product?: string; productAs?: 'text' | 'base64'; productEncoding?: string; productName?: string; many?: 'files-text' | 'files-list' }> = {
  unix_pipeline: { argument: 'input', as: 'text-or-base64', base64Argument: 'input_base64', product: 'stdout', productAs: 'text', many: 'files-text' },
  archive_tool: { argument: 'data_base64', as: 'base64', nameArgument: 'name', product: 'data_base64', productAs: 'base64', many: 'files-list' },
  document_process: { argument: 'base64', as: 'base64', nameArgument: 'name', product: 'content', productAs: 'text' },
  xcode_project: { argument: 'pbxproj', as: 'text', product: 'pbxproj', productAs: 'text' },
  xcode_build_log: { argument: 'log', as: 'text' },
  apply_patch: { argument: 'original', as: 'text', product: 'result', productAs: 'text' },
  diff_review: { argument: 'diff', as: 'text' },
  sql_lint: { argument: 'sql', as: 'text' },
  migration_safety_check: { argument: 'sql', as: 'text' },
  schema_review: { argument: 'ddl', as: 'text' },
  explain_plan_review: { argument: 'plan', as: 'text' },
  openapi_review: { argument: 'spec', as: 'text' },
  // MCP tools (read-only): the document converter of the local MCP server (services/exprsn-mcp/convert.mjs)
  'exprsn-convert.convert_document': { argument: 'base64', as: 'base64', nameArgument: 'name', product: 'content', productAs: 'text', productEncoding: 'encoding', productName: 'name' },
  'exprsn-convert.convert_inspect': { argument: 'base64', as: 'base64', nameArgument: 'name' },
  // the image format converter (services/exprsn-mcp/imgconv.mjs)
  'exprsn-imgconv.image_convert': { argument: 'base64', as: 'base64', nameArgument: 'name', product: 'content', productAs: 'base64', productEncoding: 'encoding', productName: 'name' },
  'exprsn-imgconv.image_optimize': { argument: 'base64', as: 'base64', nameArgument: 'name', product: 'content', productAs: 'base64', productEncoding: 'encoding', productName: 'name' },
  'exprsn-imgconv.image_icon_set': { argument: 'base64', as: 'base64', nameArgument: 'name', product: 'content', productAs: 'base64', productEncoding: 'encoding', productName: 'name' },
  'exprsn-imgconv.image_inspect': { argument: 'base64', as: 'base64', nameArgument: 'name' },
  // read-only reverse engineering of a file's bytes (services/exprsn-mcp/rea.mjs); each returns an analysis, not a file
  'exprsn-rea.binary_identify': { argument: 'base64', as: 'base64' },
  'exprsn-rea.binary_strings': { argument: 'base64', as: 'base64' },
  'exprsn-rea.binary_headers': { argument: 'base64', as: 'base64' },
  'exprsn-rea.binary_symbols': { argument: 'base64', as: 'base64' },
  'exprsn-rea.binary_disassemble': { argument: 'base64', as: 'base64' },
  'exprsn-rea.binary_entropy': { argument: 'base64', as: 'base64' }
};
/** Result fields too large to show a model: they are saved with files.apply_tool instead. */
const BULKY = 8 * 1024;
const MAX_EXTRA_FILES = 10;

async function readAll(d: BridgeDeps, fileId: string, version?: number) {
  const { s, reader } = d;
  const got = await s.files.content(reader, fileId, version);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of got.stream) {
    size += part.length;
    if (size > s.cfg.ATTACHMENT_MAX_BYTES) throw new ToolRefused(`${got.file.name} is larger than the ${s.cfg.ATTACHMENT_MAX_BYTES} bytes this tool handles.`);
    parts.push(part);
  }
  return { file: got.file, version: got.version, via: got.via, data: Buffer.concat(parts) };
}

const utf8 = (data: Buffer): string | null => {
  if (data.includes(0)) return null;
  const text = data.toString('utf8');
  return text.includes('\uFFFD') ? null : text.replace(/^\uFEFF/, '');
};

async function scriptTool(d: BridgeDeps, name: string): Promise<EntryRow> {
  const { s, p } = d;
  const row = (await s.db('registry_entries').where({ tenant_id: p.tenantId, kind: 'tool', name, impl: 'script', status: 'published' }).orderBy('created_at', 'desc').first('id')) as { id: string } | undefined;
  if (!row) throw new ToolRefused(`${name} is not a script tool published in this tenant. Script tools that work on files here: ${Object.keys(BRIDGES).join(', ')}.`);
  return s.registry.mustGet(p.tenantId, row.id);
}

/** A tool a file can be handed to: any published script tool, or a published read-only MCP tool named in BRIDGES. */
async function bridgedTool(d: BridgeDeps, name: string): Promise<EntryRow> {
  if (!BRIDGES[name]?.argument || !name.includes('.')) return scriptTool(d, name);
  const { s, p } = d;
  const row = (await s.db('registry_entries').where({ tenant_id: p.tenantId, kind: 'tool', name, impl: 'mcp', status: 'published' }).orderBy('created_at', 'desc').first('id')) as { id: string } | undefined;
  if (!row) throw new ToolRefused(`${name} is not published in this tenant.`);
  const tool = await s.registry.mustGet(p.tenantId, row.id);
  // Only reads: what a bridged tool writes is saved by files.apply_tool, never by the tool itself.
  if ((tool.side_effect ?? 'read') !== 'read') throw new ToolRefused(`${name} is a ${tool.side_effect} tool; only read tools work on files here.`);
  return tool;
}

async function runBridged(d: BridgeDeps, tool: EntryRow, toolArgs: Record<string, unknown>): Promise<unknown> {
  const { s, p, ctx } = d;
  if (tool.impl === 'script') return s.scripts.runAsTool(tool, toolArgs, ctx.signal);
  const r = await s.mcp.call(p, String(tool.definition.serverId), String(tool.definition.tool), toolArgs, ctx.signal);
  const text = (r.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  if (r.isError) throw new ToolRefused(`${tool.name}: ${text || 'the tool reported an error'}`);
  return r.structuredContent ?? { text };
}

/** Runs a script tool with the content of files put into its arguments. */
async function runOnFiles(d: BridgeDeps): Promise<{ tool: EntryRow; source: Awaited<ReturnType<typeof readAll>>; result: Record<string, unknown>; label: Label; bridge: (typeof BRIDGES)[string] | null }> {
  const { ctx, args } = d;
  const name = str(args.tool);
  if (!name) throw new ToolRefused('Name the tool to run.');
  const tool = await bridgedTool(d, name);
  const known = BRIDGES[name] ?? null;
  const argument = str(args.argument) ?? known?.argument;
  if (!argument) throw new ToolRefused(`Say which argument of ${name} takes the file's content (argument), and whether as text or base64 (as).`);
  const as = (str(args.as) as 'text' | 'base64' | undefined) ?? known?.as ?? 'text';
  const source = await readAll(d, String(args.fileId), num(args.version));
  let label = source.version.label;
  const toolArgs: Record<string, unknown> = { ...(args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? (args.arguments as Record<string, unknown>) : {}) };
  const text = utf8(source.data);
  if (as === 'base64') toolArgs[argument] = source.data.toString('base64');
  else if (text != null) toolArgs[argument] = text;
  else if (as === 'text-or-base64' && known?.base64Argument) toolArgs[known.base64Argument] = source.data.toString('base64');
  else throw new ToolRefused(`${source.file.name} is not text, and ${name} takes text.`);
  if (known?.nameArgument) toolArgs[known.nameArgument] ??= source.file.name;
  // More files, by id: named texts for a pipeline, the members of an archive to create.
  const more = Array.isArray(args.moreFileIds) ? (args.moreFileIds as unknown[]).map(String) : [];
  if (more.length) {
    if (!known?.many) throw new ToolRefused(`${name} takes one file.`);
    if (more.length > MAX_EXTRA_FILES) throw new ToolRefused(`At most ${MAX_EXTRA_FILES} more files in one call.`);
    const extra = await Promise.all(more.map((id) => readAll(d, id)));
    for (const e of extra) label = highest(label, e.version.label);
    if (known.many === 'files-text') {
      const files: Record<string, string> = {};
      for (const e of [source, ...extra]) {
        const t = utf8(e.data);
        if (t == null) throw new ToolRefused(`${e.file.name} is not text.`);
        files[e.file.name] = t;
      }
      toolArgs.files = { ...(toolArgs.files && typeof toolArgs.files === 'object' ? (toolArgs.files as Record<string, string>) : {}), ...files };
    } else {
      delete toolArgs[argument];
      toolArgs.files = [source, ...extra].map((e) => ({ name: e.file.name, base64: e.data.toString('base64') }));
    }
  } else if (known?.many === 'files-text' && text != null) toolArgs.files = { ...(toolArgs.files && typeof toolArgs.files === 'object' ? (toolArgs.files as Record<string, string>) : {}), [source.file.name]: text };
  // The tool's ceiling covers what it is handed, as the dispatcher asks of any call.
  if (!clears(tool.label, highest(label, ctx.label))) throw new ToolRefused(`${name} is cleared for ${tool.label} content; ${source.file.name} is ${label}.`);
  const out = await runBridged(d, tool, toolArgs);
  const result = out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : { result: out };
  await d.audit('file.downloaded', { file: source.file.id, version: source.version.number }, source.version.label, { size: source.version.size, tool: 'files.run_tool', readBy: name, shared: source.via !== 'workspace', ...(more.length ? { moreFiles: more.length } : {}) });
  return { tool, source, result, label: highest(label, ctx.label), bridge: known };
}

const fileView = (x: Awaited<ReturnType<typeof readAll>>) => ({ id: x.file.id, name: x.file.name, size: x.version.size, label: x.version.label, version: x.version.number });

export async function filesRunTool(d: BridgeDeps): Promise<unknown> {
  const r = await runOnFiles(d);
  const left: string[] = [];
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r.result)) {
    // The product of a tool that rewrites a file (a project file, an archive) is saved, not shown.
    const binary = k === r.bridge?.product && r.bridge?.productEncoding !== undefined && r.result[r.bridge.productEncoding] === 'base64';
    if (typeof v === 'string' && v.length > BULKY && (k === r.bridge?.product || /base64$/i.test(k)) && ((k !== 'stdout' && k !== 'content') || binary)) left.push(`${k} (${v.length} characters)`);
    else result[k] = v;
  }
  return { file: fileView(r.source), tool: r.tool.name, result, ...(left.length ? { note: `Left out of this answer: ${left.join(', ')}. To keep it, call files.apply_tool with the same arguments: it saves that field to Files.` } : {}) };
}

export async function filesApplyTool(d: BridgeDeps): Promise<unknown> {
  const { s, p, args } = d;
  const r = await runOnFiles(d);
  if (typeof r.result.error === 'string') throw new ToolRefused(`${r.tool.name}: ${r.result.error}; nothing was saved.`);
  if (Array.isArray(r.result.rejected) && r.result.rejected.length) throw new ToolRefused(`${r.tool.name} could not apply ${r.result.rejected.length} part(s) of the change (${JSON.stringify(r.result.rejected).slice(0, 600)}); nothing was saved.`);
  const field = str(args.resultField) ?? r.bridge?.product;
  if (!field) throw new ToolRefused(`Say which field of ${r.tool.name}'s result to save (resultField).`);
  const value = r.result[field];
  if (typeof value !== 'string' || !value) throw new ToolRefused(`The result of ${r.tool.name} has no text in ${field}; nothing was saved. It returned: ${Object.keys(r.result).join(', ')}.`);
  const said = field === r.bridge?.product && r.bridge?.productEncoding ? str(r.result[r.bridge.productEncoding]) : undefined;
  const encoding = (str(args.resultEncoding) as 'text' | 'base64' | undefined) ?? (said === 'base64' || said === 'text' ? said : undefined) ?? (field === r.bridge?.product ? r.bridge?.productAs : undefined) ?? (/base64$/i.test(field) ? 'base64' : 'text');
  const data = Buffer.from(value, encoding === 'base64' ? 'base64' : 'utf8');
  if (data.length > s.cfg.ATTACHMENT_MAX_BYTES) throw new ToolRefused(`The result is ${data.length} bytes, above the ${s.cfg.ATTACHMENT_MAX_BYTES} this tool saves.`);
  const body = (async function* () {
    yield data;
  })();
  const named = r.tool.name === 'archive_tool' ? 'name' : r.bridge?.productName;
  const saveAs = str(args.saveAs) ?? (named && typeof r.result[named] === 'string' ? (r.result[named] as string) : undefined);
  const summary = Object.fromEntries(Object.entries(r.result).filter(([k, v]) => k !== field && !(typeof v === 'string' && v.length > BULKY)));
  if (saveAs) {
    const out = await s.files.upload(p, { workspaceId: r.source.file.workspace_id, folderId: str(args.folderId) ?? r.source.file.folder_id ?? null, name: cleanName(saveAs), label: r.label, declaredType: null, declaredBytes: data.length }, body);
    return { saved: { file: out.file.id, name: out.file.name, version: out.version.number, state: out.version.state, size: data.length, label: out.version.label, new: true }, from: fileView(r.source), tool: r.tool.name, result: summary };
  }
  if (data.equals(r.source.data)) return { saved: null, from: fileView(r.source), tool: r.tool.name, result: summary, note: 'The result is the same as the file; no new version was saved.' };
  const out = await s.files.uploadVersion(p, r.source.file.id, { label: r.label, declaredType: null, declaredBytes: data.length }, body);
  return { saved: { file: out.file.id, name: out.file.name, version: out.version.number, state: out.version.state, size: data.length, label: out.version.label, new: false, previousVersion: r.source.version.number }, from: fileView(r.source), tool: r.tool.name, result: summary };
}

export async function filesSave(d: BridgeDeps): Promise<unknown> {
  const { s, ctx, p, args } = d;
  const name = cleanName(String(args.name ?? ''));
  if (!name) throw new ToolRefused('Give the file a name.');
  const encoding = str(args.encoding) === 'base64' ? 'base64' : 'utf8';
  const data = Buffer.from(String(args.content ?? ''), encoding);
  if (!data.length) throw new ToolRefused('The content is empty.');
  if (data.length > s.cfg.ATTACHMENT_MAX_BYTES) throw new ToolRefused(`The content is ${data.length} bytes, above the ${s.cfg.ATTACHMENT_MAX_BYTES} this tool saves.`);
  const out = await s.files.upload(p, { workspaceId: str(args.workspaceId) ?? null, folderId: str(args.folderId) ?? null, name, label: ctx.label, declaredType: str(args.type) ?? null, declaredBytes: data.length }, (async function* () {
    yield data;
  })());
  return { file: out.file.id, name: out.file.name, version: out.version.number, state: out.version.state, size: data.length, label: out.version.label };
}

const MAX_MEMBERS = 50;

export async function filesExtract(d: BridgeDeps): Promise<unknown> {
  const { s, ctx, p, args } = d;
  const tool = await scriptTool(d, 'archive_tool');
  const source = await readAll(d, String(args.fileId));
  const label = highest(source.version.label, ctx.label);
  if (!clears(tool.label, label)) throw new ToolRefused(`archive_tool is cleared for ${tool.label} content; ${source.file.name} is ${source.version.label}.`);
  const base = { data_base64: source.data.toString('base64'), name: source.file.name, ...(str(args.password) ? { password: str(args.password) } : {}) };
  const members = Array.isArray(args.members) ? (args.members as unknown[]).map(String) : undefined;
  const listed = (await s.scripts.runAsTool(tool, { ...base, action: 'list', ...(members ? { members } : {}) }, ctx.signal)) as { error?: string; members?: { path: string; type: string; size: number }[] };
  if (typeof listed.error === 'string') throw new ToolRefused(`${source.file.name}: ${listed.error}.`);
  const files = (listed.members ?? []).filter((m) => m.type === 'file');
  if (!files.length) throw new ToolRefused(`${source.file.name} has no file${members ? ' matching the members given' : ''}.`);
  if (files.length > MAX_MEMBERS) throw new ToolRefused(`${files.length} files match; this tool extracts at most ${MAX_MEMBERS} in one call. Name the ones you need in members (paths or patterns such as "docs/*.md").`);
  // The members go into a folder named after the archive, unless one is given.
  let folderId = str(args.folderId) ?? null;
  let folderName: string | null = null;
  if (!folderId) {
    folderName = cleanName(str(args.folderName) ?? source.file.name.replace(/(\.tar)?\.(zip|tar|tgz|gz|bz2|xz|txz|tbz2)$/i, '')) || 'extracted';
    const folder = await s.files.createFolder(p, { workspaceId: source.file.workspace_id, parentId: source.file.folder_id ?? null, name: folderName });
    folderId = folder.id;
  }
  const saved: Record<string, unknown>[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const names = new Set<string>();
  for (const m of files) {
    // One member per run: a script's answer is capped, so each member has the whole allowance.
    const got = (await s.scripts.runAsTool(tool, { ...base, action: 'extract', members: [m.path], as: 'base64', max_bytes: 600_000 }, ctx.signal)) as { error?: string; files?: { path: string; base64?: string; text?: string; skipped?: string; truncated?: boolean }[] };
    const f = got.files?.find((x) => x.path === m.path) ?? got.files?.[0];
    if (typeof got.error === 'string' || !f || f.skipped || f.truncated || (f.base64 == null && f.text == null)) {
      skipped.push({ path: m.path, reason: got.error ?? f?.skipped ?? (m.size > 600_000 ? `it is ${m.size} bytes; a member above 600,000 bytes cannot pass through the sandbox` : 'it could not be read') });
      continue;
    }
    const data = f.base64 != null ? Buffer.from(f.base64, 'base64') : Buffer.from(f.text ?? '', 'utf8');
    // Folders inside the archive are flattened into the name, so two members never collide silently.
    let name = cleanName(m.path.replace(/\//g, ' - '));
    for (let i = 2; names.has(name.toLowerCase()); i++) name = cleanName(`${m.path.replace(/\//g, ' - ')} (${i})`);
    names.add(name.toLowerCase());
    if (!data.length) {
      skipped.push({ path: m.path, reason: 'it is empty' });
      continue;
    }
    try {
      const out = await s.files.upload(p, { workspaceId: source.file.workspace_id, folderId, name, label, declaredType: null, declaredBytes: data.length }, (async function* () {
        yield data;
      })());
      saved.push({ path: m.path, file: out.file.id, name: out.file.name, size: data.length, state: out.version.state });
    } catch (err) {
      skipped.push({ path: m.path, reason: (err as Error).message.slice(0, 200) });
    }
  }
  await d.audit('file.downloaded', { file: source.file.id, version: source.version.number }, source.version.label, { size: source.version.size, tool: 'files.extract', readBy: 'archive_tool', shared: source.via !== 'workspace', members: saved.length });
  return { archive: fileView(source), folder: { id: folderId, ...(folderName ? { name: folderName, created: true } : {}) }, saved, skipped, note: `${saved.length} file${saved.length === 1 ? '' : 's'} saved${skipped.length ? `, ${skipped.length} skipped` : ''}. Each is scanned before it can be read.` };
}
