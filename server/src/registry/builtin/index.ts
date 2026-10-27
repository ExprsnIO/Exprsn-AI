import { clears, highest, labelRank, type Label } from '../../authz/labels.js';
import { authorize, type Principal } from '../../authz/policy.js';
import { actorFrom } from '../../audit/chain.js';
import { USER_TYPES, WORKSPACE_TYPES } from '../../memory/service.js';
import type { Permission } from '../../authz/permissions.js';
import type { Services } from '../../services.js';
import { parseBody } from '../../http/middleware.js';
import { aggregateSchema, filterSchema, sortSchema } from '../../apps/query.js';
import { HttpProblem } from '../../http/problem.js';
import { categoryFilter, categoryPath, categoryPaths, CategoryError } from '../../knowledge/categories.js';
import { detectType, extractText, ExtractionError } from '../../knowledge/extract.js';
import type { ToolCallContext } from '../dispatch.js';
import type { EntryRow } from '../service.js';
import { BUILTIN_NAMES } from './catalog.js';
import { hostsAdd, hostsCheck, hostsList, hostsRemove } from './allowed-hosts.js';
import { filesApplyTool, filesExtract, filesRunTool, filesSave, httpCall, httpDownload, ToolRefused, type BridgeDeps } from './net-files.js';
import { dnsLookupTool, netScanTool, whoisLookupTool } from './net-diagnostics.js';
import { imageTool, ImageToolRefused } from './images.js';

export { BUILTIN_TOOLS, BUILTIN_NAMES } from './catalog.js';

/*
 * B-3904: the domain built-ins (see catalog.ts). The dispatcher calls `run` after its own checks (input schema, the
 * tool's ceiling, the `tool-call` checkpoint, approval for writes, the rate limit). Each built-in then acts as the
 * caller through the domain service, which applies its own rules again: the permission the matching route requires,
 * membership and rights, clearance and label ceilings, guardrails, the audit entry and the catalogue event. Nothing
 * runs as the platform.
 *
 * The source of a call is kept where the domain has a place for it: a post records the workflow run (or agent run,
 * conversation, API request) that made it.
 */

const MAX_FILE_BYTES = 1024 * 1024;

/** Category arguments as stored, or a refusal that says what a category looks like. */
function categoriesOf<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof CategoryError) throw new BuiltinRefused(`${err.message} Levels are separated by "/", most general first.`);
    throw err;
  }
}

/**
 * A problem a domain service reported, as the caller reads it. Arguments that did not validate name what was wrong
 * with which one, so a model can correct its call instead of repeating it.
 */
function refusal(err: HttpProblem): string {
  const issues = Array.isArray(err.extensions?.errors) ? (err.extensions.errors as { path?: unknown; message?: unknown }[]).slice(0, 6).map((i) => `${String(i.path ?? '') || 'arguments'}: ${String(i.message ?? '')}`) : [];
  return `${err.title}: ${err.detail ?? ''}${issues.length ? ` ${issues.join('; ')}.` : ''}`.trim();
}

const FILTER_SHAPE = 'A filter is one condition {"field": "<name>", "op": "eq", "value": "<value>"} (op: eq, ne, gt, gte, lt, lte, in, contains, startsWith, exists), or {"and": [conditions]}, {"or": [conditions]}, {"not": condition}. A record\'s state is the field "state".';
const SORT_SHAPE = 'A sort is a list of at most three {"field": "<name>", "dir": "asc" | "desc"}.';
/** A filter or sort argument, or a refusal that shows the shape: a bare "did not validate" teaches a model nothing. */
function filterOf(v: unknown) {
  const r = filterSchema.safeParse(v);
  if (!r.success) throw new BuiltinRefused(`The filter did not validate. ${FILTER_SHAPE} Given: ${JSON.stringify(v).slice(0, 300)}`);
  return r.data;
}
function sortOf(v: unknown) {
  const r = sortSchema.safeParse(v);
  if (!r.success) throw new BuiltinRefused(`The sort did not validate. ${SORT_SHAPE} Given: ${JSON.stringify(v).slice(0, 300)}`);
  return r.data;
}

/** Thrown for a call the caller may not make; the dispatcher returns the message to the caller as data. */
export class BuiltinRefused extends Error {}

/** The script tool `files.read` hands Office, OpenDocument and RTF files to, where a tenant has published it. */
const DOCUMENT_READER = 'document_process';

export class BuiltinTools {
  constructor(private readonly s: () => Services) {}

  static has(builtin: string): boolean {
    return BUILTIN_NAMES.includes(builtin);
  }

  private need(p: Principal, perm: Permission): void {
    const d = authorize(p, perm, { tenantId: p.tenantId });
    if (!d.allow) throw new BuiltinRefused(`${p.displayName} may not do this: ${d.reason}.`);
  }

  /** Data at `label` may not go somewhere below it (a conversation, a group, a session labelled lower). */
  private fits(label: Label, where: Label, what: string): void {
    if (labelRank(label) > labelRank(where)) throw new BuiltinRefused(`Blocked by label ceiling: ${what} is ${where}; the data the call is made with is ${label}.`);
  }

  /** What the call came from, as a domain source: a workflow step becomes its run. */
  async source(ctx: ToolCallContext): Promise<{ kind: string; id: string } | undefined> {
    const src = ctx.source;
    if (!src) return undefined;
    if (src.kind === 'workflow-step') {
      const step = (await this.s().db('workflow_steps').where({ id: src.id, tenant_id: ctx.principal.tenantId }).first('run_id')) as { run_id: string } | undefined;
      return step ? { kind: 'workflow-run', id: step.run_id } : src;
    }
    return src;
  }

  async run(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown> {
    const s = this.s();
    const p = ctx.principal;
    const dctx = { p, ip: null, traceId: null };
    const str = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
    switch (String(entry.definition.builtin)) {
      case 'messages.send': {
        this.need(p, 'messages:write');
        let conversation = str('conversation');
        const user = str('user');
        if (!conversation === !user) throw new BuiltinRefused('Name either a conversation or a person (user), not both.');
        if (user) conversation = (await s.messaging.direct(dctx, user)).conversation.id as string;
        this.fits(ctx.label, (await s.messaging.require(p, conversation!, 'send')).conv.label, 'the conversation');
        const m = await s.messaging.send(dctx, conversation!, { body: String(args.body ?? ''), ...(str('thread') ? { threadId: str('thread') } : {}) });
        // 1.7.0 (B-9401): `held` when the user-input guardrail holds it for review; it is not delivered yet.
        return { conversation, message: m.id, state: m.state, label: m.label };
      }
      case 'feed.post': {
        this.need(p, 'feed:write');
        const source = await this.source(ctx);
        const post = await s.feed.createPost(dctx, { workspaceId: str('workspace'), groupId: str('group'), body: String(args.body ?? ''), label: ctx.label, source });
        return { post: post.id, state: post.state, label: post.label, workspace: post.workspaceId };
      }
      case 'files.write_version': {
        this.need(p, 'files:write');
        const encoding = str('encoding') === 'base64' ? 'base64' : 'utf8';
        const data = Buffer.from(String(args.content ?? ''), encoding);
        if (data.length > MAX_FILE_BYTES) throw new BuiltinRefused(`The content is ${data.length} bytes; a built-in write takes at most ${MAX_FILE_BYTES}.`);
        const current = await s.files.writable(p, String(args.file));
        const r = await s.files.uploadVersion(p, current.id, { label: highest(current.label, ctx.label), declaredType: str('type') ?? null, declaredBytes: data.length }, (async function* () {
          yield data;
        })());
        return { file: r.file.id, version: r.version.number, state: r.version.state, size: Number(r.version.size) };
      }
      case 'groups.create_event': {
        this.need(p, 'groups:write');
        const g = await s.groups.require(p, String(args.group), 'events');
        this.fits(ctx.label, g.group.label, 'the group');
        const e = await s.calendar.create(dctx, g.group.id, {
          title: String(args.title),
          start: String(args.start),
          timeZone: String(args.timeZone),
          ...(str('end') ? { end: str('end') } : {}),
          ...(typeof args.durationMinutes === 'number' ? { durationMinutes: args.durationMinutes } : {}),
          ...(str('description') ? { description: str('description') } : {}),
          ...(str('location') ? { location: str('location') } : {}),
          ...(Array.isArray(args.reminders) ? { reminders: (args.reminders as unknown[]).map(Number) } : {})
        });
        return { event: e.id, group: e.groupId, startsAt: e.startsAt, label: e.label };
      }
      case 'channels.answer': {
        this.need(p, 'channels:review');
        const sess = await s.channels.session(p.tenantId, String(args.session));
        if (sess) this.fits(ctx.label, sess.label, 'the session');
        const m = await s.channels.agentReply(dctx, String(args.channel), String(args.session), String(args.text ?? ''));
        return { message: m.id, seq: Number(m.seq) };
      }
      case 'knowledge_search': {
        // Sprint 36c (B-8803): the agent and workflow knowledge step. Published bases the caller may read, searched
        // at most at the label of the conversation or run the result lands in (and never above the caller).
        this.need(p, 'knowledge:read');
        const visible = new Map((await s.knowledge.visible(p)).map((x) => [x.kb.id, x.kb]));
        // Without kbIds (migration 042): every published base the caller may read, the first 20 by name.
        const ids = Array.isArray(args.kbIds) ? (args.kbIds as unknown[]).map(String) : [...visible.values()].filter((kb) => kb.status === 'published').slice(0, 20).map((kb) => kb.id);
        const kbs = ids.map((id) => visible.get(id)).filter((kb) => kb && kb.status === 'published');
        if (kbs.length !== ids.length) throw new BuiltinRefused('A knowledge base in kbIds does not exist, is not published, or is not shared with the caller.');
        const f = (args.labels ?? undefined) as { any?: string[]; all?: string[]; minScore?: number } | undefined;
        const cats = categoriesOf(() => categoryFilter(args.categories, args.categoriesAll));
        const ceiling: Label = clears(p.clearance, ctx.label) ? ctx.label : p.clearance;
        const out = await s.knowledge.search(p, kbs as NonNullable<(typeof kbs)[number]>[], String(args.query ?? ''), { k: typeof args.k === 'number' ? args.k : 8, ceiling, queryLabel: ceiling, rerank: true, withText: true, lenient: true, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(f ? { labels: f } : {}), ...(cats ? { categories: cats } : {}) });
        return {
          ceiling: out.ceiling,
          hits: out.hits.map((h) => ({ kb: h.kb, document: h.document, documentId: h.documentId, section: h.heading, label: h.label, score: h.rerank ?? h.fused, ...(h.categories ? { categories: h.categories } : {}), ...(h.withheld ? { withheld: h.withheld } : { text: h.text ?? '' }), ...(h.image ? { image: h.image } : {}) }))
        };
      }
      case 'records.entities':
      case 'records.query':
      case 'records.count':
      case 'records.aggregate':
      case 'records.create':
      case 'records.update':
      case 'records.delete':
        return this.records(ctx, String(entry.definition.builtin).slice('records.'.length), args);
      case 'knowledge_list':
      case 'knowledge_read':
      case 'knowledge_save':
      case 'knowledge_add':
      case 'knowledge_categorize':
      case 'knowledge_categories':
      case 'knowledge_changes':
      case 'files.search':
      case 'files.read':
      case 'http_fetch':
      case 'http_request':
      case 'http_download':
      case 'files.run_tool':
      case 'files.apply_tool':
      case 'files.save':
      case 'files.extract':
      case 'allowed_hosts.check':
      case 'allowed_hosts.list':
      case 'allowed_hosts.add':
      case 'allowed_hosts.remove':
      case 'dns.lookup':
      case 'whois.lookup':
      case 'net.scan':
      case 'memory_search':
      case 'memory_save':
        return this.research(ctx, String(entry.definition.builtin), args);
      // Migration 045: references, revisions and review, through `knowledge/revisions.ts`.
      case 'knowledge_propose':
      case 'knowledge_revisions':
      case 'knowledge_publish':
        this.need(p, 'knowledge:read');
        try {
          return await s.knowledgeRevisions.tool(ctx, String(entry.definition.builtin), args);
        } catch (err) {
          if (err instanceof HttpProblem) throw new BuiltinRefused(refusal(err));
          throw err;
        }
      // Migration 074 (`images.ts`): pictures listed, generated, edited and restyled, the caller's own only.
      case 'image_list':
      case 'image_generate':
      case 'image_crop':
      case 'image_resize':
      case 'image_rotate':
      case 'image_blur':
      case 'image_adjust':
      case 'image_effect':
      case 'image_style':
      case 'image_edit':
      case 'image_restyle':
        this.need(p, 'images:generate');
        try {
          return await imageTool(s, ctx, String(entry.definition.builtin), args);
        } catch (err) {
          if (err instanceof HttpProblem) throw new BuiltinRefused(refusal(err));
          if (err instanceof ImageToolRefused) throw new BuiltinRefused(err.message);
          throw err;
        }
      // Migration 087 (Sprint 46, B-131): a published decision table, read as the caller (as the table routes read it:
      // agents:run), never above the label of the call, so its outputs cannot carry more into the conversation or run.
      case 'decision.evaluate': {
        this.need(p, 'agents:run');
        const reader: Principal = labelRank(p.clearance) > labelRank(ctx.label) ? { ...p, clearance: ctx.label } : p;
        const version = typeof args.version === 'number' ? args.version : 'published';
        const inputs = args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs) ? (args.inputs as Record<string, unknown>) : {};
        try {
          const r = await s.decisions.evaluateAs(reader, String(args.table ?? ''), version, inputs);
          return { table: r.table.name, version: r.version, hitPolicy: r.result.hitPolicy, matched: r.result.matched, outputs: r.result.outputs, ...(r.result.rows ? { rows: r.result.rows } : {}), summary: r.result.summary, explanation: r.result.explanation };
        } catch (err) {
          if (err instanceof HttpProblem && err.status === 404) throw new BuiltinRefused(`There is no decision table ${String(args.table ?? '')} that this call may read (the call's label is ${ctx.label}).`);
          if (err instanceof HttpProblem) throw new BuiltinRefused(refusal(err));
          throw err;
        }
      }
      // Migration 090 (Sprint 45, B-125, B-126): a published saved query or a REST endpoint, read as the caller
      // (connections:query, clearance), never above the label of the call; write queries never run here.
      case 'connections.query': {
        this.need(p, 'connections:query');
        const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? (args.params as Record<string, unknown>) : {};
        const limit = typeof args.limit === 'number' ? args.limit : undefined;
        const cursor = str('cursor') ?? null;
        const via = ctx.source?.kind ?? 'tool';
        try {
          if (str('query')) {
            if (str('connection') || str('endpoint')) throw new BuiltinRefused('Name either a saved query, or a REST connection and its endpoint, not both.');
            const r = await s.savedQueries.run(p, str('query')!, params, { ...(limit ? { limit } : {}), cursor, ceiling: ctx.label, via });
            return { columns: r.columns, rows: r.rows, truncated: r.truncated, nextCursor: r.nextCursor ?? null, label: r.label, masked: r.masked };
          }
          if (!str('connection') || !str('endpoint')) throw new BuiltinRefused('Name a saved query (query), or a REST connection (connection) and its endpoint (endpoint).');
          const r = await s.restConnections.read(p, str('connection')!, str('endpoint')!, params, { ...(limit ? { limit } : {}), cursor, ceiling: ctx.label, via });
          return { columns: r.columns, rows: r.rows, truncated: r.truncated, nextCursor: r.nextCursor ?? null, label: r.label, masked: r.masked, ...(r.untrusted ? { untrusted: r.untrusted } : {}) };
        } catch (err) {
          if (err instanceof HttpProblem && err.status === 404) throw new BuiltinRefused(`There is no ${str('query') ? `saved query ${str('query')}` : `REST endpoint ${str('connection')}.${str('endpoint')}`} that this call may read (the call's label is ${ctx.label}).`);
          if (err instanceof HttpProblem) throw new BuiltinRefused(refusal(err));
          throw err;
        }
      }
      default:
        throw new Error(`Unknown built-in ${String(entry.definition.builtin)}.`);
    }
  }

  /**
   * Sprint 37b (B-7101): the record built-ins. Reads see records at most at the label of the call (the caller's
   * clearance lowered to it), so nothing above the conversation, run or MCP call they answer comes back; a record
   * created from a call is at least at its label. Problems the apps service reports (a value that fails the entity's
   * validation, a stale version) come back to the caller as data.
   */
  private async records(ctx: ToolCallContext, op: string, args: Record<string, unknown>): Promise<unknown> {
    const s = this.s();
    const p = ctx.principal;
    this.need(p, op === 'entities' || op === 'query' || op === 'count' || op === 'aggregate' ? 'records:read' : 'records:write');
    const reader: Principal = labelRank(p.clearance) > labelRank(ctx.label) ? { ...p, clearance: ctx.label } : p;
    const str = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
    const actor = { principal: p, source: 'api' as const, ip: null };
    try {
      switch (op) {
        case 'entities': {
          const apps = (await s.apps.list(reader)).filter((a) => !str('app') || a.name === str('app') || a.id === str('app'));
          return {
            apps: await Promise.all(
              apps.map(async (a) => ({
                app: a.name,
                title: a.title,
                label: a.label,
                entities: (await s.apps.entities(a)).map((e) => ({ entity: e.name, title: e.title, label: e.label, fields: e.definition.fields.map((f) => ({ name: f.name, type: f.type, ...(f.title ? { title: f.title } : {}), ...((f as { required?: boolean }).required ? { required: true } : {}) })), ...(e.definition.states ? { states: e.definition.states.states.map((x) => x.name) } : {}) }))
              }))
            )
          };
        }
        case 'query': {
          const out = await s.apps.query(reader, String(args.app), String(args.entity), {
            ...(args.filter ? { filter: filterOf(args.filter) } : {}),
            ...(args.sort ? { sort: sortOf(args.sort) } : {}),
            ...(str('q') ? { q: str('q') } : {}),
            limit: typeof args.limit === 'number' ? args.limit : 25,
            ...(str('cursor') ? { cursor: str('cursor') } : {})
          });
          return { total: out.total, nextCursor: out.nextCursor, records: out.records.map((r) => ({ id: r.id, values: r.values, label: r.label, state: r.state, version: r.version, updatedAt: r.updatedAt })) };
        }
        case 'count': {
          const out = await s.apps.query(reader, String(args.app), String(args.entity), { ...(args.filter ? { filter: filterOf(args.filter) } : {}), ...(str('q') ? { q: str('q') } : {}), limit: 1 });
          return { count: Number(out.total ?? 0) };
        }
        case 'aggregate': {
          const input = parseBody(aggregateSchema, { ...(args.filter ? { filter: filterOf(args.filter) } : {}), ...(str('q') ? { q: str('q') } : {}), ...(str('groupBy') ? { groupBy: str('groupBy') } : {}), metrics: args.metrics });
          return await s.apps.aggregate(reader, String(args.app), String(args.entity), input);
        }
        case 'create': {
          const { app, entity } = await s.apps.resolve(p, String(args.app), String(args.entity));
          const r = await s.apps.createRecord(actor, app, entity, { values: (args.values ?? {}) as Record<string, unknown>, label: highest(entity.label, ctx.label) });
          return { id: r.id, values: r.values, label: r.label, version: r.version };
        }
        case 'update': {
          const { app, entity } = await s.apps.resolve(p, String(args.app), String(args.entity));
          const r = await s.apps.updateRecord(actor, app, entity, String(args.id), { values: (args.values ?? {}) as Record<string, unknown>, ...(typeof args.version === 'number' ? { version: args.version } : {}) });
          return { id: r.id, values: r.values, label: r.label, version: r.version };
        }
        case 'delete': {
          const { app, entity } = await s.apps.resolve(p, String(args.app), String(args.entity));
          const r = await s.apps.removeRecord(actor, app, entity, String(args.id));
          return { deleted: r.id };
        }
        default:
          throw new Error(`Unknown built-in records.${op}.`);
      }
    } catch (err) {
      if (err instanceof HttpProblem) throw new BuiltinRefused(refusal(err));
      throw err;
    }
  }

  /**
   * The research built-ins (migration 042): the bases and documents a caller may read, one document in order, the
   * caller's memories, and a finding kept as a document or a memory. Reads are at most at the label of the call (the
   * caller's clearance lowered to it), as for records; what is saved is at the label of the call. The domain services
   * apply their own rules (sharing and row access, the `context` and `memory` checkpoints, the scan of an upload,
   * the curator's decision on a workspace memory); the audit entries are the ones the matching routes write.
   */
  private async research(ctx: ToolCallContext, op: string, args: Record<string, unknown>): Promise<unknown> {
    const s = this.s();
    const p = ctx.principal;
    const reader: Principal = labelRank(p.clearance) > labelRank(ctx.label) ? { ...p, clearance: ctx.label } : p;
    const str = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
    const audit = (action: string, target: Record<string, unknown>, label: Label, detail: Record<string, unknown>) => s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, null), target, label, detail: { ...detail, via: 'tool', ...(ctx.source ? { source: ctx.source } : {}) } });
    try {
      switch (op) {
        case 'knowledge_list': {
          this.need(p, 'knowledge:read');
          const kbId = str('kbId');
          if (!kbId) {
            const bases = (await s.knowledge.summaries(reader)).filter((b) => b.status === 'published' && clears(reader.clearance, b.label));
            return { ceiling: reader.clearance, bases: bases.map((b) => ({ id: b.id, name: b.name, description: b.description, label: b.label, documents: b.documents, access: b.access })) };
          }
          const kb = await s.knowledge.base(reader, kbId);
          if (kb.status !== 'published') throw new BuiltinRefused('The knowledge base is not published.');
          const cats = categoriesOf(() => categoryFilter(args.categories));
          const docs = await s.knowledge.documents(reader, kb.id, { ...(str('q') ? { q: str('q')! } : {}), ...(cats ? { categories: cats } : {}), limit: typeof args.limit === 'number' ? args.limit : 50 });
          return { ceiling: reader.clearance, documents: docs.filter((d) => d.state === 'indexed' || d.state === 'unchanged').map((d) => ({ id: d.id, name: d.name, type: d.type, size: d.size, label: d.label, sections: d.chunks, source: d.source, categories: d.categories ?? [], updatedAt: d.updatedAt })) };
        }
        case 'knowledge_read': {
          this.need(p, 'knowledge:read');
          const out = await s.knowledge.readDocument(reader, String(args.documentId), { ...(typeof args.from === 'number' ? { from: args.from } : {}), ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}) });
          if (out.kb.status !== 'published') throw new BuiltinRefused('The knowledge base of this document is not published.');
          return { document: { id: out.doc.id, name: out.doc.name, kb: out.kb.name, kbId: out.kb.id, type: out.doc.type, label: out.doc.label, updatedAt: out.doc.updated_at }, sections: out.sections, total: out.total, next: out.next };
        }
        case 'knowledge_changes': {
          this.need(p, 'knowledge:read');
          // One change with its line diff, or what the syncs of the published bases found since a time.
          const changeId = str('changeId');
          if (changeId) {
            const out = await s.knowledge.change(reader, changeId);
            if (out.kb.status !== 'published') throw new BuiltinRefused('The knowledge base of this change is not published.');
            return { change: { id: out.change.id, kind: out.change.kind, document: out.change.name, documentId: out.change.document_id, kb: out.kb.name, kbId: out.kb.id, label: out.change.label, linesAdded: out.change.added, linesRemoved: out.change.removed, at: new Date(out.change.created_at).toISOString() }, ...(out.withheld ? { withheld: out.withheld } : { diff: out.diff ?? '', ...(out.change.truncated ? { note: 'The diff is long; only its start is kept.' } : {}) }) };
          }
          const kbId = str('kbId');
          const kbs = kbId ? [await s.knowledge.base(reader, kbId)] : (await s.knowledge.visible(reader)).map((x) => x.kb);
          const published = kbs.filter((kb) => kb.status === 'published' && clears(reader.clearance, kb.label));
          if (kbId && !published.length) throw new BuiltinRefused('The knowledge base is not published.');
          const days = typeof args.sinceDays === 'number' ? args.sinceDays : 7;
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          const since = Date.now() - days * 24 * 60 * 60_000;
          const rows = (await Promise.all(published.map(async (kb) => (await s.knowledge.changes(reader, kb.id, { since, limit })).map((c) => ({ c, kb }))))).flat().sort((a, b) => b.c.created_at - a.c.created_at).slice(0, limit);
          return { ceiling: reader.clearance, sinceDays: days, changes: rows.map(({ c, kb }) => ({ id: c.id, kind: c.kind, document: c.name, documentId: c.document_id, kb: kb.name, kbId: kb.id, label: c.label, linesAdded: c.added, linesRemoved: c.removed, hasDiff: !!c.diff_sealed, at: new Date(c.created_at).toISOString() })) };
        }
        case 'knowledge_save':
        case 'knowledge_add': {
          this.need(p, 'knowledge:read');
          const kb = await s.knowledge.base(p, String(args.kbId), 'manage');
          this.fits(ctx.label, kb.label, 'the knowledge base');
          const categories = categoriesOf(() => categoryPaths(args.categories));
          if (op === 'knowledge_add' && !categories.length) throw new BuiltinRefused('Give at least one category, such as "finance/reports/quarterly".');
          const title = String(args.title ?? '').replace(/[/\\\0]+/g, ' ').replace(/\s+/g, ' ').trim();
          const content = String(args.content ?? '').trim();
          const fileId = op === 'knowledge_add' ? str('fileId') : undefined;
          if (fileId && content) throw new BuiltinRefused('Give content or fileId, not both.');
          let name: string;
          let data: Buffer;
          let label = ctx.label;
          let from: Record<string, unknown> = {};
          if (fileId) {
            // A file from Files: its current version, read as the caller, at least at that version's label.
            this.need(p, 'files:read');
            const got = await s.files.content(reader, fileId);
            label = highest(ctx.label, got.version.label);
            this.fits(label, kb.label, 'the knowledge base');
            const parts: Buffer[] = [];
            let size = 0;
            for await (const part of got.stream) {
              size += part.length;
              if (size > s.cfg.ATTACHMENT_MAX_BYTES) throw new BuiltinRefused(`The file is larger than the ${s.cfg.ATTACHMENT_MAX_BYTES} bytes a knowledge base takes.`);
              parts.push(part);
            }
            data = Buffer.concat(parts);
            const ext = /\.[A-Za-z0-9]{1,8}$/.exec(got.file.name)?.[0] ?? '';
            name = title ? (title.toLowerCase().endsWith(ext.toLowerCase()) ? title : `${title}${ext}`) : got.file.name;
            from = { file: got.file.id, version: got.version.number };
          } else {
            if (!title || !content) throw new BuiltinRefused(op === 'knowledge_add' ? 'Give a title and content, or a fileId.' : 'Give the document a title and content.');
            name = /\.(md|markdown|txt)$/i.test(title) ? title : `${title}.md`;
            data = Buffer.from(/^#\s/.test(content) ? content : `# ${title}\n\n${content}`, 'utf8');
          }
          const doc = await s.knowledge.upload(p, kb.id, { name, label, data, categories });
          await audit('knowledge.uploaded', { kb: doc.kb_id, document: doc.id }, doc.label, { name: doc.name, size: doc.size, ...(categories.length ? { categories } : {}), ...from });
          return { document: doc.id, name: doc.name, kb: kb.name, state: doc.state, label: doc.label, ...(op === 'knowledge_add' || categories.length ? { categories } : {}), note: 'Scanned and classified before it is indexed; it is searchable once its state is indexed.' };
        }
        case 'knowledge_categorize': {
          this.need(p, 'knowledge:read');
          const mode = str('mode') === 'set' ? 'set' : str('mode') === 'remove' ? 'remove' : 'add';
          const out = await s.knowledge.setCategories(p, String(args.documentId), args.categories, mode);
          await audit('knowledge.document.categorised', { kb: out.doc.kb_id, document: out.doc.id }, out.doc.label, { from: out.before, to: out.after, mode });
          return { document: out.doc.id, name: out.doc.name, categories: out.after, before: out.before };
        }
        case 'knowledge_categories': {
          this.need(p, 'knowledge:read');
          const kbId = str('kbId');
          const under = str('under') ? categoriesOf(() => categoryPath(str('under'))) : null;
          const kbs = kbId ? [await s.knowledge.base(reader, kbId)] : (await s.knowledge.visible(reader)).map((x) => x.kb);
          const published = kbs.filter((kb) => kb.status === 'published' && clears(reader.clearance, kb.label));
          if (kbId && !published.length) throw new BuiltinRefused('The knowledge base is not published.');
          const depth = typeof args.depth === 'number' ? args.depth : 6;
          const rows = (await s.knowledge.categoryCounts(reader, published, { searchable: true })).filter((c) => c.depth <= depth && (!under || c.path === under || c.path.startsWith(`${under}/`)));
          return { ceiling: reader.clearance, categories: rows.slice(0, 500).map((c) => ({ category: c.path, documents: c.documents, filedHere: c.direct })), ...(rows.length > 500 ? { note: `${rows.length} categories; the first 500 are shown. Narrow with under or depth.` } : {}) };
        }
        case 'files.search': {
          this.need(p, 'files:read');
          const files = await s.files.search(reader, { ...(str('q') ? { q: str('q')! } : {}), ...(Array.isArray(args.tags) ? { tags: (args.tags as unknown[]).map(String) } : {}), limit: typeof args.limit === 'number' ? args.limit : 25 });
          return { ceiling: reader.clearance, files: files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, label: f.label, tags: f.tags, workspace: f.workspaceName, updatedAt: f.updatedAt })) };
        }
        case 'files.read': {
          // Migration 047: a file's text. Read as the caller within the label of the call, so nothing above the
          // conversation or run comes back; a read is audited like a download.
          this.need(p, 'files:read');
          const got = await s.files.content(reader, String(args.fileId), typeof args.version === 'number' ? args.version : undefined);
          const parts: Buffer[] = [];
          let size = 0;
          for await (const part of got.stream) {
            size += part.length;
            if (size > s.cfg.ATTACHMENT_MAX_BYTES) throw new BuiltinRefused(`The file is larger than the ${s.cfg.ATTACHMENT_MAX_BYTES} bytes this tool reads.`);
            parts.push(part);
          }
          const data = Buffer.concat(parts);
          const name = got.file.name;
          const from = typeof args.from === 'number' ? args.from : 0;
          const max = typeof args.maxChars === 'number' ? args.maxChars : 20_000;
          let text: string;
          let readBy = 'files.read';
          let extra: Record<string, unknown> = {};
          // Office, OpenDocument and RTF files go to the tenant's document reader (a sandboxed script tool) where it
          // is published and its ceiling covers this version's label; text, PDF and Word files are read here otherwise.
          const office = /\.(docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|ppsx|ppsm|potx|potm|odt|ott|ods|ots|odp|otp|rtf)$/i.test(name);
          const readerRow = office ? ((await s.db('registry_entries').where({ tenant_id: p.tenantId, kind: 'tool', name: DOCUMENT_READER, impl: 'script', status: 'published' }).orderBy('created_at', 'desc').first('id')) as { id: string } | undefined) : undefined;
          const readerTool = readerRow ? await s.registry.mustGet(p.tenantId, readerRow.id) : null;
          if (readerTool && clears(readerTool.label, got.version.label)) {
            const out = (await s.scripts.runAsTool(readerTool, { name, base64: data.toString('base64'), max_chars: 400_000, max_rows: typeof args.maxRows === 'number' ? args.maxRows : 200 }, ctx.signal)) as Record<string, unknown>;
            if (typeof out.error === 'string') throw new BuiltinRefused(`${name}: ${out.error}.`);
            text = String(out.content ?? '');
            readBy = DOCUMENT_READER;
            const warnings = Array.isArray(out.warnings) ? (out.warnings as unknown[]).map(String).filter((w) => !/^content cut at/.test(w)) : [];
            extra = { format: 'markdown', kind: out.kind, title: out.title, metadata: out.metadata, counts: out.counts, outline: Array.isArray(out.outline) ? out.outline.slice(0, 100) : [], ...(warnings.length ? { warnings } : {}), ...(out.truncated ? { note: 'The document is longer than this tool reads (400,000 characters); its end is missing.' } : {}) };
          } else {
            const t = detectType(data, name);
            if ('rejected' in t) throw new BuiltinRefused(office ? `${name} is a file this server reads only through the tool ${DOCUMENT_READER}, which is not published in this tenant${readerTool ? ` for ${got.version.label} content` : ''}.` : `${name} cannot be read as text: ${t.rejected}`);
            if (t.type.startsWith('image/')) throw new BuiltinRefused(`${name} is an image. Add it to a knowledge base that has a vision profile (knowledge_add with fileId) to have it described.`);
            try {
              text = extractText(data, t.type);
            } catch (err) {
              if (err instanceof ExtractionError) throw new BuiltinRefused(`${name} could not be read: ${err.message}`);
              throw err;
            }
            extra = { format: t.type === 'text/markdown' ? 'markdown' : 'text' };
          }
          if (from > text.length) throw new BuiltinRefused(`The text of ${name} has ${text.length} characters; from is past its end.`);
          const next = from + max < text.length ? from + max : null;
          await audit('file.downloaded', { file: got.file.id, version: got.version.number }, got.version.label, { size: got.version.size, tool: 'files.read', readBy, shared: got.via !== 'workspace' });
          return {
            file: { id: got.file.id, name, type: got.version.type, size: got.version.size, label: got.version.label, version: got.version.number },
            ...extra,
            readBy,
            content: text.slice(from, from + max),
            total: text.length,
            from,
            next,
            ...(next != null ? { note: `${extra.note ? `${String(extra.note)} ` : ''}More follows: call again with from ${next}.` } : {})
          };
        }
        // Migration 049 (`allowed-hosts.ts`): the tenant's list of allowed hosts. Looking a host up is for anyone who
        // may call tools; the list itself is the tenant admin's, as in the console.
        case 'allowed_hosts.check':
          if (!authorize(p, 'tenant:manage', { tenantId: p.tenantId }).allow) this.need(p, 'tools:invoke');
          return await hostsCheck({ s, ctx, p, reader, args, audit });
        case 'allowed_hosts.list':
        case 'allowed_hosts.add':
        case 'allowed_hosts.remove':
          this.need(p, 'tenant:manage');
          return await (op === 'allowed_hosts.list' ? hostsList : op === 'allowed_hosts.add' ? hostsAdd : hostsRemove)({ s, ctx, p, reader, args, audit });
        // Migration 048 (`net-files.ts`): requests to the outside, and script tools run on files.
        case 'http_fetch':
        case 'http_request':
        case 'http_download':
        case 'files.run_tool':
        case 'files.apply_tool':
        case 'files.save':
        case 'files.extract': {
          const deps: BridgeDeps = { s, ctx, p, reader, args, audit };
          this.need(p, 'tools:invoke');
          if (op.startsWith('files.')) this.need(p, 'files:read');
          if (op === 'http_download' || op === 'files.apply_tool' || op === 'files.save' || op === 'files.extract') this.need(p, 'files:write');
          if (op === 'http_fetch') return await httpCall(deps, 'fetch');
          if (op === 'http_request') return await httpCall(deps, 'request');
          if (op === 'http_download') return await httpDownload(deps);
          if (op === 'files.run_tool') return await filesRunTool(deps);
          if (op === 'files.apply_tool') return await filesApplyTool(deps);
          if (op === 'files.save') return await filesSave(deps);
          return await filesExtract(deps);
        }
        // Migration 053 (`net-diagnostics.ts`): DNS, WHOIS and TCP port scan. Read-only; anyone who may call tools.
        // net.scan reaches the target, so it goes through the outbound-address guard inside the handler.
        case 'dns.lookup':
        case 'whois.lookup':
        case 'net.scan': {
          this.need(p, 'tools:invoke');
          const deps: BridgeDeps = { s, ctx, p, reader, args, audit };
          if (op === 'dns.lookup') return await dnsLookupTool(deps);
          if (op === 'whois.lookup') return await whoisLookupTool(deps);
          return await netScanTool(deps);
        }
        case 'memory_search': {
          this.need(p, 'memory:write');
          const scope = str('scope');
          const items = await s.memory.contextFor({ principal: p, tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, query: String(args.query ?? ''), label: ctx.label, ceiling: reader.clearance });
          return { ceiling: reader.clearance, memories: items.filter((m) => !scope || m.cite.scope === scope).map((m) => ({ id: m.cite.memoryId, scope: m.cite.scope, type: m.cite.type, label: m.label, text: m.text })) };
        }
        case 'memory_save': {
          this.need(p, 'memory:write');
          const scope = str('scope') === 'workspace' ? 'workspace' : 'user';
          const allowed: readonly string[] = scope === 'user' ? USER_TYPES : WORKSPACE_TYPES;
          const type = str('type') ?? allowed[0]!;
          if (!allowed.includes(type)) throw new BuiltinRefused(`A ${scope} memory is one of: ${allowed.join(', ')}.`);
          const text = String(args.text ?? '').replace(/\s+/g, ' ').trim();
          if (!text) throw new BuiltinRefused('The memory is empty.');
          const m = await s.memory.add(p, { text, scope, type, label: ctx.label, expiresAt: null });
          await audit(m.state === 'proposed' ? 'memory.proposed' : 'memory.added', { memory: m.id, scope: m.scope }, m.label, { type: m.type });
          return { memory: m.id, scope: m.scope, type: m.type, state: m.state, label: m.label, ...(m.state === 'proposed' ? { note: 'A knowledge curator decides whether it is kept.' } : {}) };
        }
        default:
          throw new Error(`Unknown built-in ${op}.`);
      }
    } catch (err) {
      if (err instanceof HttpProblem) throw new BuiltinRefused(refusal(err));
      if (err instanceof ToolRefused) throw new BuiltinRefused(err.message);
      throw err;
    }
  }
}
