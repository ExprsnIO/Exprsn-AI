import { dialectOf } from '../connections/dialects.js';
import { isEngine } from '../connections/engines.js';
import { Readable } from 'node:stream';
import { stringify as yamlStringify } from 'yaml';
import { clears, highest, LABELS, type Label } from '../authz/labels.js';
import { authorize, effectivePermissions, type Principal } from '../authz/policy.js';
import type { Permission } from '../authz/permissions.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import { toXlsx } from '../imports/xlsx-writer.js';
import { guardedRequest, servicePolicy, ServiceUrlRefused, toolAddressProblem } from '../platform/egress.js';
import type { EntryRow } from '../registry/service.js';
import type { Services } from '../services.js';
import type { FileRow, VersionRow } from './service.js';

/*
 * Imports into Files from elsewhere (2.0.0): a URL, a database table or query, a knowledge document, an agent run, a
 * workflow run or bundle, a skill and a tool. Each one is read as the caller through its own governed path (the
 * outbound address guard and the tenant's allowed hosts; the connection's classification, allow-list, masking and
 * row cap, or a saved query's published version; the knowledge base's access and the context checkpoint; the run's
 * visibility; the registry's permissions), then written through `FileService.upload`, so the new file is quarantined,
 * scanned and labelled like any upload. The file's label is never below the label of what it came from.
 */

export const IMPORT_KINDS = ['knowledge', 'agent-run', 'workflow-run', 'workflow', 'skill', 'tool', 'database', 'database-object', 'saved-query'] as const;
export type ImportSourceKind = (typeof IMPORT_KINDS)[number];

export interface Target {
  workspaceId?: string | null;
  folderId?: string | null;
  label?: Label;
  name?: string;
}

export interface CallCtx {
  ip: string | null;
  traceId: string;
}

export interface Imported {
  file: FileRow;
  version: VersionRow;
  /** What the route records in the audit detail. */
  detail: Record<string, unknown>;
}

const MAX_REDIRECTS = 5;
const STEP_MAX_CHARS = 20_000;
const KNOWLEDGE_MAX_CHARS = 4_000_000;

const EXT_OF: Record<string, string> = {
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'application/json': '.json',
  'text/html': '.html',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/zip': '.zip'
};

/** A file name made safe: no separators or control characters, at most 200 characters, never empty. */
export function safeName(raw: string, fallback = 'download'): string {
  // eslint-disable-next-line no-control-regex
  const n = raw.replace(/[/\\\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+$/, '').slice(0, 200);
  return n || fallback;
}

/** The name a download is saved as: Content-Disposition, else the URL's last segment, else `download`; with an extension. */
export function downloadName(url: URL, disposition: string | undefined, contentType: string | null): string {
  let name = '';
  if (disposition) {
    const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(disposition);
    const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(disposition);
    try {
      name = star ? decodeURIComponent(star[2]!.trim()) : plain ? (plain[1] ?? plain[2] ?? '').trim() : '';
    } catch {
      name = plain ? (plain[1] ?? plain[2] ?? '').trim() : '';
    }
  }
  if (!name) {
    const seg = url.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      name = decodeURIComponent(seg);
    } catch {
      name = seg;
    }
  }
  name = safeName(name);
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = EXT_OF[type];
  if (ext && !/\.[A-Za-z0-9]{1,8}$/.test(name)) name = `${name}${ext}`;
  return name;
}

/** A CSV cell: quoted when needed; a value that a spreadsheet would read as a formula gets a leading quote. */
export function csvCell(v: unknown): string {
  let t = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export const toCsv = (columns: string[], rows: unknown[][]): string => [columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const day = () => new Date().toISOString().slice(0, 10);
const clip = (t: string, max = STEP_MAX_CHARS) => (t.length > max ? `${t.slice(0, max)}\n… (${(t.length - max).toLocaleString('en-US')} more characters left out)` : t);
const asText = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const when = (t: number | null | undefined) => (t ? new Date(Number(t)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');

/** Keys of a definition whose values never leave the registry, and `vault:` references (kept as references only). */
const SECRET_KEY = /secret|password|passwd|token|credential|private.?key|api.?key|sealed|authorization|cookie/i;
export function redactDefinition(v: unknown, depth = 0): unknown {
  if (depth > 20) return '[nested too deep]';
  if (typeof v === 'string') return /^vault:/.test(v) ? '[vault reference]' : v;
  if (Array.isArray(v)) return v.map((x) => redactDefinition(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[withheld]' : redactDefinition(x, depth + 1)]));
  return v;
}

export class FileImports {
  constructor(private readonly s: () => Services) {}

  private need(p: Principal, ...perms: Permission[]): void {
    for (const perm of perms) if (authorize(p, perm, { tenantId: p.tenantId }).allow) return;
    throw forbidden(`This needs ${perms.join(' or ')}.`, { step: 'role', action: perms[0] });
  }

  /** Writes `data` as a new file of the caller's workspace, scanned before the answer when it can be. */
  private async save(p: Principal, t: Target, o: { name: string; type: string; data: Buffer; sourceLabel: Label | null }, detail: Record<string, unknown>): Promise<Imported> {
    const files = this.s().files;
    let workspaceId: string;
    let folderId: string | null = null;
    if (t.folderId) {
      const f = await files.folder(p, t.folderId);
      workspaceId = f.workspace_id;
      folderId = f.id;
    } else workspaceId = (await files.workspaceFor(p, t.workspaceId ?? null)).id;
    // Never below the source; the upload checks the caller's clearance and the workspace ceiling.
    const label = t.label ? (o.sourceLabel ? highest(t.label, o.sourceLabel) : t.label) : (o.sourceLabel ?? 'internal');
    const name = await files.freeName(p.tenantId, workspaceId, folderId, safeName(t.name ?? o.name));
    const { file, version } = await files.upload(p, { workspaceId, folderId, name, label, declaredType: o.type, declaredBytes: o.data.length }, Readable.from([o.data]));
    const scanned = (await files.scanNow(version.id, 15_000)) ?? version;
    return { file: await files.writable(p, file.id), version: scanned, detail: { ...detail, label } };
  }

  // ---------- a URL ----------

  /**
   * A GET of `url` through the outbound address guard, as `http_download` makes it: the operator's service allow-list
   * for internal hosts, the tenant's list of allowed hosts for public ones, each redirect hop checked again, no
   * downgrade from https to http, credentials dropped when the host changes. Capped at the upload limit.
   */
  async url(p: Principal, input: Target & { url: string }): Promise<Imported> {
    const s = this.s();
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new HttpProblem(400, 'Invalid request', `${input.url} is not a URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpProblem(400, 'Invalid request', 'Only http:// and https:// URLs are fetched.');
    if (url.username || url.password) throw new HttpProblem(400, 'Invalid request', 'Credentials do not belong in the URL.');
    const policy = servicePolicy(s.cfg);
    const tenant = await s.integrations.allowList(p.tenantId);
    const headers: Record<string, string> = { accept: '*/*', 'accept-encoding': 'identity' };
    const redirects: string[] = [];
    for (;;) {
      let res;
      try {
        res = await guardedRequest({ method: 'GET', url, headers, timeoutMs: s.cfg.HTTP_TOOL_TIMEOUT_MS, maxBytes: s.files.options.maxBytes, check: (address, h) => toolAddressProblem(address, h, policy, tenant) });
      } catch (err) {
        if (err instanceof ServiceUrlRefused) {
          const large = /larger than/.test(err.message);
          throw new HttpProblem(large ? 413 : 403, large ? 'Too large' : 'Host refused', large ? `The file is larger than the upload limit of ${s.files.options.maxBytes.toLocaleString('en-US')} bytes.` : err.message, { extensions: { step: 'egress' } });
        }
        throw new HttpProblem(502, 'Fetch failed', `${url.host}: ${(err as Error).message}`.slice(0, 500));
      }
      const location = res.headers.location;
      if (location && [301, 302, 303, 307, 308].includes(res.status)) {
        if (redirects.length >= MAX_REDIRECTS) throw new HttpProblem(502, 'Too many redirects', `More than ${MAX_REDIRECTS} redirects; the last one points to ${location}.`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new HttpProblem(502, 'Bad redirect', `The server redirects to ${location}, which is not a URL.`);
        }
        if (url.protocol === 'https:' && next.protocol === 'http:') throw new HttpProblem(502, 'Bad redirect', `The server redirects from https to http (${next.host}), which is not followed.`);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new HttpProblem(502, 'Bad redirect', `The server redirects to ${next.protocol}, which is not followed.`);
        if (next.host !== url.host) for (const k of ['authorization', 'cookie']) delete headers[k];
        redirects.push(`${next.origin}${next.pathname}`);
        url = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new HttpProblem(502, 'Fetch failed', `${url.host} answered ${res.status}; nothing was saved.`, { extensions: { status: res.status } });
      const type = (res.contentType ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
      return this.save(p, input, { name: downloadName(url, res.headers['content-disposition'], res.contentType), type, data: res.body, sourceLabel: null }, { from: 'url', url: `${url.origin}${url.pathname}`, ...(redirects.length ? { redirects: redirects.length } : {}), bytes: res.body.length });
    }
  }

  // ---------- a database table or query ----------

  /** The read of an allow-listed object as the engine writes it. */
  private objectQuery(engine: string, object: string): { query: string; object?: string } {
    if (!/^[A-Za-z0-9_$.-]{1,200}$/.test(object)) throw new HttpProblem(400, 'Invalid request', `${object} is not a table, view or collection name.`);
    const d = isEngine(engine) ? dialectOf(engine) : null;
    if (d) return { query: `SELECT * FROM ${d.quoteIdent(object)}` };
    if (engine === 'mongodb') return { query: JSON.stringify({ find: object.replace(/^[^.]+\./, ''), filter: {} }), object };
    return { query: JSON.stringify({ query: { match_all: {} } }), object };
  }

  /**
   * Rows of a connection as a CSV, Excel or JSON file. A table, view or collection, or SQL, runs through
   * `ConnectionService.run` (`connections:manage`, as the query console); a saved query through `SavedQueries.run`
   * (`connections:query`, its published version). Masked values stay masked; the export guardrail sees the rows.
   */
  async database(p: Principal, input: Target & { connectionId?: string; object?: string; sql?: string; savedQueryId?: string; params?: Record<string, unknown>; format: 'csv' | 'xlsx' | 'json' }, ctx: CallCtx): Promise<Imported> {
    const s = this.s();
    const given = [input.object, input.sql, input.savedQueryId].filter((x) => x != null && x !== '').length;
    if (given !== 1) throw new HttpProblem(400, 'Invalid request', 'Give one of object, sql or savedQueryId.');
    let columns: string[];
    let rows: unknown[][];
    let label: Label;
    let capped: boolean;
    let masked: string[];
    let title: string;
    let source: Record<string, unknown>;
    if (input.savedQueryId) {
      const r = await s.savedQueries.run(p, input.savedQueryId, input.params ?? null, { via: 'files.import', ip: ctx.ip, traceId: ctx.traceId });
      const q = await s.savedQueries.get(p.tenantId, input.savedQueryId);
      columns = r.columns.map((c) => c.name);
      rows = r.rows.map((o) => columns.map((c) => o[c]));
      ({ label, masked } = r);
      capped = r.truncated;
      title = q.title ?? q.name;
      source = { savedQuery: q.id, connection: q.connection_id };
    } else {
      this.need(p, 'connections:manage');
      if (!input.connectionId) throw new HttpProblem(400, 'Invalid request', 'Give the connection a table or SQL is read from.');
      const c = await s.connections.get(p.tenantId, input.connectionId);
      const q = input.object ? this.objectQuery(c.engine, input.object) : { query: input.sql! };
      const r = await s.connections.run({ principal: p, ip: ctx.ip, traceId: ctx.traceId }, c.id, { ...q, confirmUnparsed: false });
      ({ columns, rows, label, capped, masked } = r);
      title = input.object ? `${c.name} ${input.object.replace(/^public\./, '')}` : `${c.name} query`;
      source = { connection: c.id, ...(input.object ? { object: input.object } : { sql: input.sql!.slice(0, 500) }) };
    }
    const csv = toCsv(columns, rows);
    const g = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'export', text: csv, label, principal: p, source: { kind: 'file-import', id: String(source.connection ?? source.savedQuery) }, meta: { rows: rows.length } });
    if (g.action === 'block' || g.action === 'require-approval') throw new HttpProblem(403, 'Blocked by a guardrail', g.reason ?? 'A guardrail rule refused this export.', { extensions: { step: 'guardrail', checkpoint: 'export' } });
    let data: Buffer;
    let type: string;
    if (input.format === 'csv') {
      data = Buffer.from(g.action === 'redact' ? g.text : csv, 'utf8');
      type = 'text/csv';
    } else {
      if (g.action === 'redact') throw new HttpProblem(409, 'Conflict', 'A guardrail rule redacts parts of these rows; import them as CSV, which carries the redacted text.');
      if (input.format === 'json') {
        data = Buffer.from(JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null]))), null, 2), 'utf8');
        type = 'application/json';
      } else {
        const cell = (v: unknown) => (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date ? v : JSON.stringify(v));
        data = toXlsx({ sheets: [{ name: title.slice(0, 31), columns: columns.map((t) => ({ title: t })), rows: rows.map((r) => ({ cells: r.map(cell) as (string | number | boolean | Date | null)[] })) }], title });
        type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      }
    }
    const out = await this.save(p, input, { name: `${title} ${day()}.${input.format}`, type, data, sourceLabel: label }, { from: 'database', ...source, rows: rows.length, capped, masked, format: input.format });
    return out;
  }

  // ---------- a knowledge document ----------

  /** A knowledge document's text as the caller may read it (sections above their clearance or withheld say so). */
  async knowledge(p: Principal, input: Target & { documentId: string; as: 'original' | 'text' | 'markdown' }): Promise<Imported> {
    const s = this.s();
    this.need(p, 'knowledge:read');
    if (input.as === 'original') {
      const o = await s.knowledge.originalOf(p, input.documentId);
      return this.save(p, input, { name: safeName(o.doc.name, 'document'), type: o.doc.type ?? 'application/octet-stream', data: o.data, sourceLabel: o.doc.label }, { from: 'knowledge', document: o.doc.id, kb: o.doc.kb_id, as: 'original' });
    }
    const parts: string[] = [];
    let chars = 0;
    let doc: Awaited<ReturnType<Services['knowledge']['readDocument']>>['doc'] | null = null;
    let kbName = '';
    let truncated = false;
    for (let from: number | null = 0; from != null; ) {
      const r = await s.knowledge.readDocument(p, input.documentId, { from, maxChars: 200_000 });
      doc = r.doc;
      kbName = r.kb.name;
      for (const sec of r.sections) {
        const body = sec.text ?? `[Withheld: ${sec.withheld ?? 'not shown'}]`;
        parts.push(input.as === 'markdown' && sec.heading ? `## ${sec.heading}\n\n${body}` : body);
        chars += body.length;
      }
      if (chars > KNOWLEDGE_MAX_CHARS) {
        truncated = true;
        break;
      }
      from = r.next;
    }
    if (!doc) throw notFound('Document');
    const stem = doc.name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
    const text = input.as === 'markdown' ? `# ${stem}\n\nFrom the knowledge base ${kbName}.\n\n${parts.join('\n\n')}\n` : `${parts.join('\n\n')}\n`;
    return this.save(p, input, { name: `${stem}${input.as === 'markdown' ? '.md' : '.txt'}`, type: input.as === 'markdown' ? 'text/markdown' : 'text/plain', data: Buffer.from(text, 'utf8'), sourceLabel: doc.label }, { from: 'knowledge', document: doc.id, kb: doc.kb_id, as: input.as, ...(truncated ? { truncated: true } : {}) });
  }

  // ---------- runs ----------

  /** An agent run (as the runs page shows it to the caller) as Markdown or as its JSON view. */
  async agentRun(p: Principal, input: Target & { runId: string; format: 'markdown' | 'json' }): Promise<Imported> {
    const s = this.s();
    this.need(p, 'agents:run', 'tools:manage', 'agents:manage');
    const v = await s.agents.view(p, input.runId);
    let text: string;
    if (input.format === 'json') text = JSON.stringify(v, null, 2);
    else {
      const out = [`# Agent run: ${v.agent}`, '', `- Run: ${v.id}`, `- Agent: ${v.agent} ${v.agentVersion ?? ''}`.trimEnd(), `- Profile: ${v.profile ?? '—'}`, `- State: ${v.state}`, `- Label: ${v.label}`, `- By: ${v.by ?? '—'}`, `- Started: ${when(v.startedAt)}`, `- Finished: ${when(v.finishedAt)}`, ...(v.error ? [`- Error: ${v.error}`] : []), '', '## Task', '', clip(asText(v.input)), '', '## Answer', '', clip(asText(v.output) || '(no answer)'), '', '## Steps', ''];
      for (const st of v.steps) {
        out.push(`### ${st.n}. ${st.title ?? st.lane} (${st.lane}, ${st.state})`, '');
        const d = st.detail ?? {};
        if (Object.keys(d).length) out.push('```json', clip(JSON.stringify(d, null, 2)), '```', '');
      }
      text = out.join('\n');
    }
    return this.save(p, input, { name: `Agent run ${v.agent} ${day()}.${input.format === 'json' ? 'json' : 'md'}`, type: input.format === 'json' ? 'application/json' : 'text/markdown', data: Buffer.from(text, 'utf8'), sourceLabel: v.label }, { from: 'agent-run', run: v.id, format: input.format });
  }

  /** A workflow run (its inputs, steps and outputs the caller is cleared for) as Markdown or JSON. */
  async workflowRun(p: Principal, input: Target & { runId: string; format: 'markdown' | 'json' }): Promise<Imported> {
    const s = this.s();
    const v = await s.workflows.runView(p, input.runId);
    const wf = (await s.db('workflows').where({ tenant_id: p.tenantId, id: v.workflowId }).first('name')) as { name: string } | undefined;
    const name = wf?.name ?? 'workflow';
    let text: string;
    if (input.format === 'json') text = JSON.stringify(v, null, 2);
    else {
      const out = [`# Workflow run: ${name}`, '', `- Run: ${v.id}`, `- Version: ${v.version ?? 'draft'}`, `- Mode: ${v.mode}`, `- State: ${v.state}`, `- Label: ${v.label}`, `- By: ${v.createdByName ?? '—'}`, `- Started: ${when(v.startedAt as number | null)}`, `- Finished: ${when(v.finishedAt as number | null)}`, ...(v.error ? [`- Error: ${v.error}`] : []), '', '## Input', '', '```json', clip(JSON.stringify(v.input ?? null, null, 2)), '```', '', '## Steps', ''];
      for (const st of v.steps) {
        out.push(`### ${st.nodeId} (${st.state})`, '');
        if (st.error) out.push(`Error: ${st.error}`, '');
        if (st.output != null) out.push('```json', clip(JSON.stringify(st.output, null, 2)), '```', '');
      }
      text = out.join('\n');
    }
    return this.save(p, input, { name: `Workflow run ${name} ${day()}.${input.format === 'json' ? 'json' : 'md'}`, type: input.format === 'json' ? 'application/json' : 'text/markdown', data: Buffer.from(text, 'utf8'), sourceLabel: v.label }, { from: 'workflow-run', run: v.id, workflow: v.workflowId, format: input.format });
  }

  /** A workflow's signed `exprsn-workflow/1` bundle (`workflows:manage`, as its export). */
  async workflow(p: Principal, input: Target & { workflowId: string }, ctx: CallCtx): Promise<Imported> {
    const s = this.s();
    this.need(p, 'workflows:manage');
    const bundle = await s.workflowBundles.export(p, input.workflowId, ctx);
    return this.save(p, input, { name: `${bundle.workflow.name}.workflow.json`, type: 'application/json', data: Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'), sourceLabel: bundle.workflow.label }, { from: 'workflow', workflow: input.workflowId, version: bundle.version });
  }

  // ---------- skills and tools ----------

  /**
   * A registry entry the caller may read: any entry of the tenant with `tools:manage` (as the registry screen), or with
   * `tools:invoke` a published one that resolves in the caller's workspace. Within the caller's clearance.
   */
  private async entry(p: Principal, id: string, kind: 'skill' | 'tool'): Promise<EntryRow> {
    const s = this.s();
    const e = await s.registry.get(p.tenantId, id);
    if (!e || e.kind !== kind || !clears(p.clearance, e.label)) throw notFound(kind === 'skill' ? 'Skill' : 'Tool');
    if (effectivePermissions(p).has('tools:manage')) return e;
    this.need(p, 'tools:invoke');
    const resolved = e.status === 'published' ? await s.registry.resolve({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null }, e.name, kind) : undefined;
    if (!resolved || resolved.id !== e.id) throw notFound(kind === 'skill' ? 'Skill' : 'Tool');
    return e;
  }

  /** A skill as Markdown: front matter (name, description, version, label, skills and tools it uses), then its instructions. */
  async skill(p: Principal, input: Target & { skillId: string }): Promise<Imported> {
    const e = await this.entry(p, input.skillId, 'skill');
    const d = e.definition ?? {};
    const list = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    const front = yamlStringify({ name: e.name, description: e.description ?? '', version: e.version, label: e.label, status: e.status, ...(list('skills').length ? { skills: list('skills') } : {}), tools: list('tools') }).trimEnd();
    const instructions = typeof d.instructions === 'string' ? d.instructions : '';
    const text = `---\n${front}\n---\n\n${instructions.trim()}\n`;
    return this.save(p, input, { name: `${e.name}.skill.md`, type: 'text/markdown', data: Buffer.from(text, 'utf8'), sourceLabel: e.label }, { from: 'skill', entry: e.id, name: e.name, version: e.version });
  }

  /** A tool's definition as JSON, without secrets: values of secret-looking keys and vault references are withheld. */
  async tool(p: Principal, input: Target & { toolId: string }): Promise<Imported> {
    const e = await this.entry(p, input.toolId, 'tool');
    const out = { name: e.name, version: e.version, kind: e.kind, description: e.description, impl: e.impl, sideEffect: e.side_effect, confirm: e.confirm, label: e.label, status: e.status, inputSchema: e.input_schema, outputSchema: e.output_schema, definition: redactDefinition(e.definition), exportedAt: new Date().toISOString() };
    return this.save(p, input, { name: `${e.name}.tool.json`, type: 'application/json', data: Buffer.from(JSON.stringify(out, null, 2), 'utf8'), sourceLabel: e.label }, { from: 'tool', entry: e.id, name: e.name, version: e.version });
  }

  // ---------- what can be picked ----------

  /** Items of a kind the caller may import, newest first, for the console's picker. */
  async sources(p: Principal, kind: ImportSourceKind, o: { q?: string; connection?: string } = {}): Promise<{ id: string; name: string; sub: string | null; label: Label; at: number | null }[]> {
    const s = this.s();
    const like = (o.q ?? '').trim().toLowerCase();
    const match = (...xs: (string | null | undefined)[]) => !like || xs.some((x) => (x ?? '').toLowerCase().includes(like));
    const cleared = LABELS.filter((l) => clears(p.clearance, l));
    switch (kind) {
      case 'knowledge': {
        this.need(p, 'knowledge:read');
        const bases = new Map((await s.knowledge.visible(p)).map((x) => [x.kb.id, x.kb.name]));
        if (!bases.size) return [];
        const qb = s.db('knowledge_documents').where({ tenant_id: p.tenantId }).whereIn('kb_id', [...bases.keys()]).whereIn('label', cleared).whereNotIn('state', ['removed', 'hidden', 'rejected']).whereNull('parent_id');
        if (like) qb.whereRaw('lower(name) like ?', [`%${like.replace(/[\\%_]/g, (c) => `\\${c}`)}%`]);
        const rows = (await qb.orderBy('updated_at', 'desc').limit(50).select('id', 'name', 'kb_id', 'label', 'updated_at')) as { id: string; name: string; kb_id: string; label: Label; updated_at: number | string }[];
        return rows.map((r) => ({ id: r.id, name: r.name, sub: bases.get(r.kb_id) ?? null, label: r.label, at: Number(r.updated_at) }));
      }
      case 'agent-run': {
        this.need(p, 'agents:run', 'tools:manage', 'agents:manage');
        return (await s.agents.list(p, { limit: 50 })).filter((r) => match(r.agent, r.id)).map((r) => ({ id: r.id, name: r.agent, sub: `${r.state}, ${r.profile ?? 'no profile'}`, label: r.label, at: r.createdAt }));
      }
      case 'workflow-run': {
        const rows = (await s.db('workflow_runs as r').join('workflows as w', 'w.id', 'r.workflow_id').where({ 'r.tenant_id': p.tenantId, 'r.created_by': p.userId }).whereIn('r.label', cleared).orderBy('r.created_at', 'desc').limit(50).select('r.id', 'r.state', 'r.label', 'r.created_at', 'w.name')) as { id: string; state: string; label: Label; created_at: number | string; name: string }[];
        return rows.filter((r) => match(r.name, r.id)).map((r) => ({ id: r.id, name: r.name, sub: r.state, label: r.label, at: Number(r.created_at) }));
      }
      case 'workflow': {
        this.need(p, 'workflows:manage');
        return (await s.workflows.list(p)).filter((w) => match(w.name, w.description)).map((w) => ({ id: w.id, name: w.name, sub: w.publishedVersion ? `version ${w.publishedVersion}` : 'draft', label: w.label, at: Number(w.updatedAt) }));
      }
      case 'skill':
      case 'tool': {
        const admin = effectivePermissions(p).has('tools:manage');
        if (!admin) this.need(p, 'tools:invoke');
        const out = [];
        for (const e of await s.registry.list(p.tenantId, admin ? { kind } : { kind, status: 'published' })) {
          if (!clears(p.clearance, e.label) || !match(e.name, e.description)) continue;
          if (!admin) {
            const r = await s.registry.resolve({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null }, e.name, kind);
            if (!r || r.id !== e.id) continue;
          }
          out.push({ id: e.id, name: e.name, sub: `${e.version}, ${e.status}`, label: e.label, at: e.updated_at ?? e.created_at });
          if (out.length >= 200) break;
        }
        return out;
      }
      case 'database': {
        // Connections the caller may query: all of them (cleared) with connections:manage; otherwise those holding a
        // saved query the caller may run.
        const manage = effectivePermissions(p).has('connections:manage');
        if (!manage) this.need(p, 'connections:query');
        const withQueries = manage ? null : new Set((await s.savedQueries.listFor(p)).filter((x) => clears(p.clearance, x.label)).map((x) => x.connection_id));
        return (await s.connections.list(p.tenantId))
          .filter((c) => clears(p.clearance, c.label) && match(c.name) && (!withQueries || withQueries.has(c.id)))
          .map((c) => ({ id: c.id, name: c.name, sub: manage ? `${c.engine}, ${c.allow_list.length} allowed object${c.allow_list.length === 1 ? '' : 's'}` : `${c.engine}, saved queries only`, label: c.label, at: null }));
      }
      case 'database-object': {
        // Tables, views and collections are read whole only through the query path, which needs connections:manage.
        this.need(p, 'connections:manage');
        if (!o.connection) throw new HttpProblem(400, 'Invalid request', 'Name the connection (connection=<id>).');
        const c = await s.connections.get(p.tenantId, o.connection);
        if (!clears(p.clearance, c.label)) throw notFound('Connection');
        return c.allow_list.filter((x) => match(x)).map((x) => ({ id: x, name: x.replace(/^public\./, ''), sub: c.name, label: c.label, at: null }));
      }
      case 'saved-query': {
        this.need(p, 'connections:query');
        return (await s.savedQueries.listFor(p, o.connection)).filter((x) => clears(p.clearance, x.label) && match(x.name, x.title)).map((x) => ({ id: x.id, name: x.title ?? x.name, sub: x.description, label: x.label, at: null }));
      }
    }
  }
}
