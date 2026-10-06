import { z } from 'zod';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import type { Permission } from '../authz/permissions.js';
import { forbidden, HttpProblem } from '../http/problem.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import type { Actor } from '../apps/service.js';
import type { Services } from '../services.js';
import type { PluginRow } from './service.js';

/*
 * B-3904: the broker's domain calls, live since 1.5.0 (they answered 501 while their domains had not shipped):
 * `records.read`, `records.write`, `files.read`, `groups.read` and `posts.write`. The capability check has already
 * passed (runtime.ts `perform`). Each call then acts as the user who installed the plugin, the same rule as
 * `call:workflow`: that user must still be active and hold the permission the matching route requires; their
 * clearance is capped at the plugin's max label; and the domain service applies its own rules (membership, rights,
 * label ceilings, guardrails, audit). Nothing is read above the event's label and the plugin's max label, and what a
 * call writes carries at least the event's label.
 */

export const DOMAIN_CALLS = ['records.read', 'records.write', 'files.read', 'groups.read', 'posts.write'] as const;
export type DomainCall = (typeof DOMAIN_CALLS)[number];
export const isDomainCall = (api: string): api is DomainCall => (DOMAIN_CALLS as readonly string[]).includes(api);

/** At most this much of a file comes back to a handler (its stdin and stdout are capped too). */
const FILE_READ_MAX = 256 * 1024;

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const ref = z.string().trim().min(1).max(100);
const values = z.record(z.string().max(63), z.unknown()).refine((v) => Object.keys(v).length <= 100, 'At most 100 fields');

export const DOMAIN_WITH: Record<DomainCall, z.ZodType> = {
  'records.read': z.object({ app: ref, entity: ref, id: id.optional(), filter: z.unknown().optional(), q: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  'records.write': z
    .object({ app: ref, entity: ref, action: z.enum(['create', 'update', 'transition']).default('create'), id: id.optional(), values: values.default({}), to: z.string().max(60).optional(), version: z.number().int().min(1).optional() })
    .strict()
    .refine((c) => c.action === 'create' || !!c.id, 'An update or transition names the record (id)')
    .refine((c) => c.action !== 'transition' || !!c.to, 'A transition names the state to move to (to)'),
  'files.read': z.object({ file: id, version: z.number().int().min(1).optional() }).strict(),
  'groups.read': z.object({ group: id, events: z.boolean().optional() }).strict(),
  'posts.write': z.object({ workspace: id.optional(), group: id.optional(), body: z.string().trim().min(1).max(5000) }).strict()
};

const PERMISSION: Record<DomainCall, Permission> = {
  'records.read': 'records:read',
  'records.write': 'records:write',
  'files.read': 'files:read',
  'groups.read': 'groups:read',
  'posts.write': 'feed:write'
};

/** The user a plugin acts as: its installer, still active, with the permission, clearance capped at its max label. */
async function installer(s: Services, p: PluginRow, perm: Permission, workspace?: string): Promise<Principal> {
  if (!p.installed_by) throw forbidden(`${p.plugin_key} was installed from the command line; a plugin's platform calls act as the user who installed it.`, { step: 'role' });
  const who = await loadPrincipal(s, p.tenant_id, p.installed_by, {});
  if (!who) throw forbidden(`The user who installed ${p.plugin_key} is no longer active.`, { step: 'role' });
  if (!authorize(who, perm).allow) throw forbidden(`The user who installed ${p.plugin_key} does not hold ${perm}.`, { step: 'role' });
  who.clearance = labelRank(who.clearance) < labelRank(p.max_label) ? who.clearance : p.max_label;
  who.workspaceId = null;
  if (workspace) {
    if (!(await workspacesFor(s, who)).some((w) => w.id === workspace)) throw forbidden('The installer is not a member of that workspace.', { step: 'role' });
    who.workspaceId = workspace;
  }
  return who;
}

/** One domain call from a handler; `label` is the event's. */
export async function domainCall(s: Services, plugin: PluginRow, api: DomainCall, raw: Record<string, unknown>, label: Label): Promise<Record<string, unknown>> {
  const parsed = DOMAIN_WITH[api].safeParse(raw);
  if (!parsed.success) throw new HttpProblem(400, 'Invalid request', `${api}: ${parsed.error.issues[0]?.message ?? 'invalid arguments'}`, { extensions: { errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  const args = parsed.data as Record<string, unknown>;
  const who = await installer(s, plugin, PERMISSION[api], typeof args.workspace === 'string' ? args.workspace : undefined);
  const actor: Actor & { principal: Principal } = { principal: who, source: 'plugin', service: `plugin:${plugin.plugin_key}` };
  switch (api) {
    case 'records.read': {
      if (typeof args.id === 'string') return { record: await s.apps.get(who, String(args.app), String(args.entity), args.id) };
      const page = await s.apps.query(who, String(args.app), String(args.entity), { ...(args.filter !== undefined ? { filter: args.filter as never } : {}), ...(typeof args.q === 'string' ? { q: args.q } : {}), limit: Number(args.limit ?? 20) });
      return page as unknown as Record<string, unknown>;
    }
    case 'records.write': {
      const app = await s.apps.app(who, String(args.app));
      const entity = await s.apps.entityOf(app, String(args.entity));
      if (args.action === 'create') {
        const rec = await s.apps.createRecord(actor, app, entity, { values: args.values as Record<string, unknown>, label: highest(entity.label, label) });
        return { id: rec.id, state: rec.state, label: rec.label, version: rec.version };
      }
      const current = await s.apps.readable(who, entity, String(args.id));
      if (labelRank(label) > labelRank(current.label)) throw new HttpProblem(403, 'Forbidden', `Blocked by label: the record is ${current.label}; the event is ${label}.`, { extensions: { step: 'clearance' } });
      const version = typeof args.version === 'number' ? { version: args.version } : {};
      const rec = args.action === 'update' ? await s.apps.updateRecord(actor, app, entity, current.id, { values: args.values as Record<string, unknown>, ...version }) : await s.apps.transition(actor, app, entity, current.id, String(args.to), version);
      return { id: rec.id, state: rec.state, label: rec.label, version: rec.version };
    }
    case 'files.read': {
      const r = await s.files.content(who, String(args.file), typeof args.version === 'number' ? args.version : undefined);
      if (!clears(who.clearance, r.version.label)) throw forbidden(`The file is ${r.version.label}, above what ${plugin.plugin_key} may read.`, { step: 'clearance' });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of r.stream) {
        chunks.push(c);
        size += c.length;
        if (size > FILE_READ_MAX) break;
      }
      const data = Buffer.concat(chunks).subarray(0, FILE_READ_MAX);
      const text = /^(text\/|application\/(json|xml|yaml|x-yaml|csv))/.test(r.version.type ?? '');
      return { file: r.file.id, name: r.file.name, version: r.version.number, type: r.version.type, size: Number(r.version.size), label: r.version.label, truncated: Number(r.version.size) > FILE_READ_MAX, ...(text ? { text: data.toString('utf8') } : { base64: data.toString('base64') }) };
    }
    case 'groups.read': {
      const g = (await s.groups.view(who, String(args.group))) as Record<string, unknown>;
      if (!args.events) return { group: g };
      const now = Date.now();
      const events = await s.calendar.list(who, String(args.group), { from: now, to: now + 90 * 86_400_000 });
      return { group: g, events };
    }
    case 'posts.write': {
      const post = await s.feed.createPost({ p: who, ip: null }, { workspaceId: typeof args.workspace === 'string' ? args.workspace : undefined, groupId: typeof args.group === 'string' ? args.group : undefined, body: String(args.body), label, source: { kind: 'plugin', id: plugin.id } });
      return { post: post.id, state: post.state, label: post.label, workspace: post.workspaceId };
    }
  }
}
