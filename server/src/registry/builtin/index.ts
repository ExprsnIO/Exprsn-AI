import { clears, highest, labelRank, type Label } from '../../authz/labels.js';
import { authorize, type Principal } from '../../authz/policy.js';
import type { Permission } from '../../authz/permissions.js';
import type { Services } from '../../services.js';
import { parseBody } from '../../http/middleware.js';
import { aggregateSchema, filterSchema, sortSchema } from '../../apps/query.js';
import { HttpProblem } from '../../http/problem.js';
import type { ToolCallContext } from '../dispatch.js';
import type { EntryRow } from '../service.js';
import { BUILTIN_NAMES } from './catalog.js';

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

/** Thrown for a call the caller may not make; the dispatcher returns the message to the caller as data. */
export class BuiltinRefused extends Error {}

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
        return { conversation, message: m.id, label: m.label };
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
        const ids = Array.isArray(args.kbIds) ? (args.kbIds as unknown[]).map(String) : [];
        const kbs = ids.map((id) => visible.get(id)).filter((kb) => kb && kb.status === 'published');
        if (kbs.length !== ids.length) throw new BuiltinRefused('A knowledge base in kbIds does not exist, is not published, or is not shared with the caller.');
        const f = (args.labels ?? undefined) as { any?: string[]; all?: string[]; minScore?: number } | undefined;
        const ceiling: Label = clears(p.clearance, ctx.label) ? ctx.label : p.clearance;
        const out = await s.knowledge.search(p, kbs as NonNullable<(typeof kbs)[number]>[], String(args.query ?? ''), { k: typeof args.k === 'number' ? args.k : 8, ceiling, queryLabel: ceiling, rerank: true, withText: true, lenient: true, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(f ? { labels: f } : {}) });
        return {
          ceiling: out.ceiling,
          hits: out.hits.map((h) => ({ kb: h.kb, document: h.document, documentId: h.documentId, section: h.heading, label: h.label, score: h.rerank ?? h.fused, ...(h.withheld ? { withheld: h.withheld } : { text: h.text ?? '' }), ...(h.image ? { image: h.image } : {}) }))
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
            ...(args.filter ? { filter: parseBody(filterSchema, args.filter) } : {}),
            ...(args.sort ? { sort: parseBody(sortSchema, args.sort) } : {}),
            ...(str('q') ? { q: str('q') } : {}),
            limit: typeof args.limit === 'number' ? args.limit : 25,
            ...(str('cursor') ? { cursor: str('cursor') } : {})
          });
          return { total: out.total, nextCursor: out.nextCursor, records: out.records.map((r) => ({ id: r.id, values: r.values, label: r.label, state: r.state, version: r.version, updatedAt: r.updatedAt })) };
        }
        case 'count': {
          const out = await s.apps.query(reader, String(args.app), String(args.entity), { ...(args.filter ? { filter: parseBody(filterSchema, args.filter) } : {}), ...(str('q') ? { q: str('q') } : {}), limit: 1 });
          return { count: Number(out.total ?? 0) };
        }
        case 'aggregate': {
          const input = parseBody(aggregateSchema, { ...(args.filter ? { filter: args.filter } : {}), ...(str('q') ? { q: str('q') } : {}), ...(str('groupBy') ? { groupBy: str('groupBy') } : {}), metrics: args.metrics });
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
      if (err instanceof HttpProblem) throw new BuiltinRefused(`${err.title}: ${err.detail ?? ''}`.trim());
      throw err;
    }
  }
}
