import { highest, labelRank, type Label } from '../../authz/labels.js';
import { authorize, type Principal } from '../../authz/policy.js';
import type { Permission } from '../../authz/permissions.js';
import type { Services } from '../../services.js';
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
      default:
        throw new Error(`Unknown built-in ${String(entry.definition.builtin)}.`);
    }
  }
}
