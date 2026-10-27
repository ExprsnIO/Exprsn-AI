import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { EVENT_GROUPS, EVENT_TYPES } from '../events/catalogue.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import { writeTar } from '../ops/tar.js';
import type { Services } from '../services.js';
import { DOMAIN_CALLS } from './broker-calls.js';
import { CAPABILITIES, capability } from './capabilities.js';
import { ACTION_CAPABILITY, ManifestError, validateManifest, type Manifest } from './manifest.js';
import { CALL_CAPABILITY as SURFACE_CALL_CAPABILITY, SURFACE_SLOTS } from './surfaces.js';

/*
 * 1.8.0, Sprint 48 (B-147): the plugin creator. A wizard in the console writes a plugin manifest step by step (the
 * basics; capabilities from the closed vocabulary; UI surfaces; events and what handles them; review), and this
 * module keeps each person's wizard state as a draft, builds the manifest from it and checks it with the same
 * `validateManifest` (and so `surfaceProblems`) every install goes through.
 *
 * Nothing here loads or runs code. The output is data: a manifest that an admin downloads (as the plugin file of an
 * unsigned import bundle, which they sign offline like any other bundle) or installs as a plugin in the state
 * `installed`, with no capability granted, so the existing grant and enable flow, the signing policy
 * (`PLUGINS_REQUIRE_SIGNED`) and Agent 2's checks at enable all still apply. A script handler is offered because
 * script plugins exist (B-2004): the wizard writes a skeleton source, the same checks refuse network and process
 * modules and credentials in it, and it runs only in the script sandbox after the plugin is enabled.
 *
 * Drafts belong to their author: another admin of the tenant neither lists nor opens them. Every change is audited
 * as `plugin.draft.*` (created, saved, installed, exported, deleted).
 */

export const MAX_DRAFTS_PER_USER = 50;

/** What each capability lets a plugin do, in plain words for the wizard (the vocabulary's own text is the rule). */
export const CAPABILITY_HELP: Record<string, string> = {
  'read:events': 'Hear about things that happen in the tenant: jobs finishing, flags raised, approvals asked for, workflow and agent runs, sign-ins and plugin changes. It sees what happened, not the content behind it.',
  'read:records': 'Hear when low-code app records are created, changed or deleted, and read records. A panel reads them as the person looking at it.',
  'read:files': 'Hear about file store changes and read files, only those the person using the plugin may read.',
  'read:groups': 'Hear about groups and their memberships, and read a group.',
  'read:messages': 'Hear that messages were sent. Only ids: the text of a message stays sealed.',
  'read:posts': 'Hear about posts in the workspace feed.',
  'read:flags': 'Read the feature flags the tenant sees, so the plugin can switch its own behaviour with them. Only values: not who set them or why.',
  'emit:log': "Write lines to the plugin's own log, which admins read under Plugins and events. Harmless, and useful while you build.",
  'emit:audit': "Add entries to the tenant's audit chain, marked as written by this plugin.",
  'emit:notification': 'Send in-app notifications to people in the tenant.',
  'emit:flag': 'Raise a flag for a person to review. A flag never acts on its own.',
  'call:webhook': 'Send events out of the platform to an address on the allowed hosts, through the signed webhook delivery. High risk: data leaves the tenant. Never granted unless an admin names it.',
  'call:workflow': 'Start one of the tenant\'s published workflows. High risk: a workflow can do anything its steps do. Never granted unless an admin names it.',
  'write:records': 'Create and change low-code records, through the guardrails. High risk: it changes data. Never granted unless an admin names it.',
  'write:posts': 'Publish posts in the workspace feed as the plugin, through the guardrails. High risk: it speaks for the tenant. Never granted unless an admin names it.'
};

const SLOT_HELP: Record<string, string> = {
  settings: 'A panel on the plugin\'s own page under Plugins and events.',
  record: 'A side panel beside a low-code record (optionally only for one app and entity). Its calls may use {{context.app}}, {{context.entity}} and {{context.record}}.',
  conversation: 'A side panel beside a conversation. Its calls may use {{context.conversation}}.',
  file: 'A side panel beside a file in the file store. Its calls may use {{context.file}}.',
  dashboard: 'A card on the Overview.'
};

const BLOCK_HELP: Record<string, string> = {
  text: 'A paragraph of fixed text.',
  kv: 'Label and value lines read from one data call (a dotted path into its answer for each line).',
  table: 'A table of rows read from one data call: the path of the rows, and a path for each column.',
  action: 'A button that runs one of the surface\'s actions as the viewer, after an optional confirmation.'
};

const ACTION_HELP: Record<string, string> = {
  log: "Writes a line to the plugin's log.",
  audit: 'Appends an audit entry.',
  notify: 'Notifies people (by role or by user id).',
  flag: 'Raises a flag for review.',
  webhook: 'Sends the event to the webhook address.',
  workflow: 'Starts a published workflow with the event as input.'
};

const short = (max: number) => z.string().max(max);
const handlerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('actions'), actions: z.array(z.object({ type: short(40), on: short(120).optional(), with: z.record(z.string(), z.unknown()).optional() }).strict()).max(50) }).strict(),
  z.object({ type: z.literal('webhook'), url: short(2000) }).strict(),
  z.object({ type: z.literal('script'), language: z.enum(['javascript', 'python']).optional(), entry: short(200).optional(), source: short(100_000).optional() }).strict()
]);

/** The wizard's state as the console sends it. Every part is optional while the draft is being written. */
export const wizardSchema = z
  .object({
    basics: z.object({ name: short(100).optional(), key: short(63).optional(), description: short(2000).optional(), version: short(40).optional(), publisher: short(200).optional() }).strict().optional(),
    capabilities: z.array(short(60)).max(30).optional(),
    optional: z.array(short(60)).max(30).optional(),
    surfaces: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
    events: z.array(short(120)).max(50).optional(),
    handler: handlerSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
export type Wizard = z.infer<typeof wizardSchema>;

export interface DraftRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  plugin_key: string | null;
  step: number;
  wizard: Wizard;
  plugin_id: string | null;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Record<string, unknown>): DraftRow => ({ ...(r as unknown as DraftRow), step: Number(r.step), wizard: json<Wizard>(r.wizard, {}), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

/** The wizard step a manifest problem belongs to (1 basics, 2 capabilities, 3 surfaces, 4 events and handler). */
export function stepOf(problem: string): number {
  if (/^(capabilities|optionalCapabilities)\b/.test(problem)) return 2;
  if (/^ui\b/.test(problem)) return 3;
  if (/^(events|actions|webhook|script|config)\b/.test(problem)) return 4;
  return 1;
}

/** The calls a script handler may make for a capability, for the skeleton's comment. */
function callsFor(cap: string): string[] {
  const out: string[] = [];
  for (const [action, need] of Object.entries(ACTION_CAPABILITY)) if (need === cap) out.push(action);
  for (const [api, need] of Object.entries(SURFACE_CALL_CAPABILITY)) if (need === cap) out.push(api);
  return out;
}

/**
 * The skeleton of a script handler: the entry function the sandbox calls as `entry(event, platform)`, with a comment
 * naming the platform calls the plugin's capabilities allow. It only logs; the author writes the rest.
 */
export function handlerSkeleton(w: { name: string; key: string; events: string[]; capabilities: string[]; language: 'javascript' | 'python'; entry: string }): string {
  const calls = w.capabilities.flatMap((c) => callsFor(c).map((api) => `${api} (${c})`));
  const events = w.events.length ? w.events.join(', ') : 'none yet';
  const canLog = w.capabilities.includes('emit:log');
  if (w.language === 'python') {
    return [
      `# ${w.name} (${w.key}): the handler of a script plugin, written by the plugin creator.`,
      `# The script sandbox calls ${w.entry}(event, platform) once for each event the plugin receives (${events}).`,
      '# It has no network and cannot start processes. It acts only through platform.call(api, args), which answers',
      `# the calls its granted capabilities allow: ${calls.length ? calls.join(', ') : 'none: the plugin asks for no capability that has a call'}.`,
      '# A call that is not granted raises PlatformError with status 403.',
      '',
      `def ${w.entry}(event, platform):`,
      canLog ? '    platform.log("Received " + str(event.get("type")), "info")' : '    # Ask for emit:log to write to the plugin\'s log with platform.log(message, level).',
      '    return {"handled": event.get("type")}',
      ''
    ].join('\n');
  }
  return [
    '/*',
    ` * ${w.name} (${w.key}): the handler of a script plugin, written by the plugin creator.`,
    ` * The script sandbox calls ${w.entry}(event, platform) once for each event the plugin receives (${events}).`,
    ' * It has no network and cannot start processes. It acts only through platform.call(api, args), which answers',
    ` * the calls its granted capabilities allow: ${calls.length ? calls.join(', ') : 'none: the plugin asks for no capability that has a call'}.`,
    ' * A call that is not granted throws an error whose status is 403. Await each call before the next.',
    ' */',
    `async function ${w.entry}(event, platform) {`,
    canLog ? "  await platform.log('Received ' + event.type, 'info');" : "  // Ask for emit:log to write to the plugin's log with platform.log(message, level).",
    '  return { handled: event.type };',
    '}',
    ''
  ].join('\n');
}

/** The manifest a wizard describes (not yet checked). */
export function buildManifest(w: Wizard): Record<string, unknown> {
  const b = w.basics ?? {};
  const caps = [...new Set(w.capabilities ?? [])];
  const h = w.handler ?? { type: 'none' as const };
  const kind = h.type === 'webhook' ? 'webhook' : h.type === 'script' ? 'script' : 'declarative';
  const key = (b.key ?? '').trim();
  const name = (b.name ?? '').trim();
  const events = [...new Set((w.events ?? []).map((e) => e.trim()).filter(Boolean))];
  const m: Record<string, unknown> = { key, name, version: (b.version ?? '').trim() || '0.1.0' };
  if (b.description?.trim()) m.description = b.description.trim();
  if (b.publisher?.trim()) m.publisher = b.publisher.trim();
  Object.assign(m, { kind, events, capabilities: caps, optionalCapabilities: [...new Set(w.optional ?? [])].filter((c) => caps.includes(c)) });
  if (h.type === 'actions' && h.actions.length) m.actions = h.actions.map((a) => ({ type: a.type, ...(a.on ? { on: a.on } : {}), ...(a.with && Object.keys(a.with).length ? { with: a.with } : {}) }));
  if (h.type === 'webhook') m.webhook = { url: h.url.trim() };
  if (h.type === 'script') {
    const language = h.language ?? 'javascript';
    const entry = (h.entry ?? '').trim() || 'handle';
    m.script = { entry, language, source: h.source?.trim() ? h.source : handlerSkeleton({ name: name || key || 'This plugin', key: key || 'plugin', events, capabilities: caps, language, entry }) };
  }
  if (w.surfaces?.length) m.ui = w.surfaces;
  if (w.config && Object.keys(w.config).length) m.config = { schema: w.config };
  return m;
}

/** Builds and checks a wizard's manifest: the manifest when it is valid, and every problem with its step. */
export function checkWizard(w: Wizard): { manifest: Record<string, unknown>; valid: boolean; problems: { step: number; message: string }[] } {
  const manifest = buildManifest(w);
  try {
    validateManifest(manifest);
    return { manifest, valid: true, problems: [] };
  } catch (err) {
    if (!(err instanceof ManifestError)) throw err;
    return { manifest, valid: false, problems: err.problems.map((message) => ({ step: stepOf(message), message })) };
  }
}

/** The bundle id of a plugin's unsigned import bundle. */
const bundleId = (m: Pick<Manifest, 'key' | 'version'>) => `plugin-${m.key}-${m.version}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 100);

/**
 * An unsigned import bundle carrying the plugin's manifest as its one file (`files/plugins/<key>.json`, mirror
 * `plugins`): `manifest.json` lists it with its sha256. It is not signed here: the operator signs `manifest.json`
 * with their offline key and adds `manifest.sig` as the second entry, as for every bundle (docs/deploy.md).
 */
export function unsignedBundle(m: Manifest): { name: string; tar: Buffer; bundleManifest: Record<string, unknown> } {
  const file = Buffer.from(JSON.stringify(m, null, 2) + '\n');
  const path = `plugins/${m.key}.json`;
  const bundleManifest = {
    format: 'exprsn-bundle/1',
    id: bundleId(m),
    created: new Date().toISOString(),
    contents: `Plugin ${m.name} ${m.version}, written with the plugin creator. Sign manifest.json and add manifest.sig before importing.`.slice(0, 500),
    files: [{ path, sha256: createHash('sha256').update(file).digest('hex'), size: file.length, mirror: 'plugins' }],
    sbom: { bomFormat: 'CycloneDX', specVersion: '1.5', components: [] }
  };
  const tar = writeTar([
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(bundleManifest, null, 2) + '\n') },
    { path: `files/${path}`, data: file }
  ]);
  return { name: `${bundleId(m)}.unsigned.tar`, tar, bundleManifest };
}

/** What the wizard offers at each step, from the same tables the checks use. */
export function vocabulary() {
  const eventGroups = EVENT_GROUPS.filter((g) => g.pattern !== '*').map((g) => ({ pattern: g.pattern, description: g.description, needs: CAPABILITIES.find((c) => (c.events ?? []).includes(g.pattern))?.name ?? null }));
  return {
    capabilities: CAPABILITIES.map((c) => ({ name: c.name, risk: c.risk, description: c.description, help: CAPABILITY_HELP[c.name] ?? c.description, events: c.events ?? [], calls: callsFor(c.name) })),
    optionalHelp: 'Required capabilities must all be granted before the plugin can be enabled. Optional ones the plugin can do without: an admin may leave them ungranted, and what needs them is refused (403) until they are.',
    grantsHelp: 'Installing grants nothing from the wizard: an admin grants capabilities on the plugin\'s page, and only then enables it. High-risk capabilities are never granted unless named.',
    slots: SURFACE_SLOTS.map((s) => ({ id: s, help: SLOT_HELP[s] ?? '' })),
    blocks: Object.entries(BLOCK_HELP).map(([type, help]) => ({ type, help })),
    calls: DOMAIN_CALLS.map((api) => ({ api, capability: SURFACE_CALL_CAPABILITY[api], read: api.endsWith('.read') })),
    actions: Object.entries(ACTION_CAPABILITY).map(([type, cap]) => ({ type, capability: cap, help: ACTION_HELP[type] ?? '' })),
    events: { groups: eventGroups, types: EVENT_TYPES.filter((t) => t.status === 'emitted').map((t) => ({ type: t.type, group: t.group, description: t.description, needs: CAPABILITIES.find((c) => (c.events ?? []).includes(t.group))?.name ?? null })) },
    handlers: [
      { type: 'none', help: 'No handler: the plugin only adds UI surfaces.' },
      { type: 'actions', help: 'Declarative actions: for each event, log, audit, notify, flag, send a webhook or start a workflow. No code.' },
      { type: 'webhook', help: 'Send every event the plugin receives to one address on the tenant\'s allowed hosts, signed.' },
      { type: 'script', help: 'A script handler run in the script sandbox, with no network; it calls the platform through the broker. With PLUGINS_REQUIRE_SIGNED at its default, a script plugin is installed only from a signed import bundle: download the bundle and have it signed.' }
    ],
    signing: { policy: null as string | null }
  };
}

export class PluginDrafts {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async audit(p: Principal, action: string, d: Pick<DraftRow, 'id' | 'name' | 'plugin_key'>, detail: Record<string, unknown> = {}, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    await this.s().audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { draft: d.id, name: d.name, ...(d.plugin_key ? { key: d.plugin_key } : {}) }, label: 'internal', detail, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
  }

  /** A draft of the caller's; anyone else's is not found. */
  async get(p: Principal, id: string): Promise<DraftRow> {
    const r = (await this.db('plugin_drafts').where({ tenant_id: p.tenantId, user_id: p.userId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Plugin draft');
    return fromRow(r);
  }

  async list(p: Principal): Promise<DraftRow[]> {
    return ((await this.db('plugin_drafts').where({ tenant_id: p.tenantId, user_id: p.userId }).orderBy('updated_at', 'desc')) as Record<string, unknown>[]).map(fromRow);
  }

  view(d: DraftRow) {
    const c = checkWizard(d.wizard);
    return { id: d.id, name: d.name, key: d.plugin_key, step: d.step, wizard: d.wizard, pluginId: d.plugin_id, createdAt: d.created_at, updatedAt: d.updated_at, manifest: c.manifest, valid: c.valid, problems: c.problems };
  }

  private nameOf(w: Wizard): { name: string; key: string | null } {
    const name = (w.basics?.name ?? '').trim() || (w.basics?.key ?? '').trim() || 'Untitled plugin';
    const key = (w.basics?.key ?? '').trim();
    return { name: name.slice(0, 100), key: key ? key.slice(0, 63) : null };
  }

  async create(p: Principal, w: Wizard, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<DraftRow> {
    const n = Number(((await this.db('plugin_drafts').where({ tenant_id: p.tenantId, user_id: p.userId }).count({ n: '*' }).first()) as { n?: number | string } | undefined)?.n ?? 0);
    if (n >= MAX_DRAFTS_PER_USER) throw conflict(`You have ${n} plugin drafts, the most one person keeps. Delete one first.`);
    const t = Date.now();
    const { name, key } = this.nameOf(w);
    const row = { id: ulid(), tenant_id: p.tenantId, user_id: p.userId, name, plugin_key: key, step: 1, wizard: JSON.stringify(w), plugin_id: null, created_at: t, updated_at: t };
    await this.db('plugin_drafts').insert(row);
    await this.audit(p, 'plugin.draft.created', row, {}, ctx);
    return this.get(p, row.id);
  }

  async save(p: Principal, id: string, input: { wizard?: Wizard | undefined; step?: number | undefined }, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<DraftRow> {
    const d = await this.get(p, id);
    const w = input.wizard ?? d.wizard;
    const { name, key } = this.nameOf(w);
    const update: Record<string, unknown> = { updated_at: Date.now(), name, plugin_key: key };
    if (input.wizard) update.wizard = JSON.stringify(input.wizard);
    if (input.step !== undefined) update.step = input.step;
    await this.db('plugin_drafts').where({ tenant_id: p.tenantId, user_id: p.userId, id: d.id }).update(update);
    await this.audit(p, 'plugin.draft.saved', { id: d.id, name, plugin_key: key }, { step: input.step ?? d.step, valid: checkWizard(w).valid }, ctx);
    return this.get(p, id);
  }

  async remove(p: Principal, id: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<void> {
    const d = await this.get(p, id);
    await this.db('plugin_drafts').where({ tenant_id: p.tenantId, user_id: p.userId, id: d.id }).delete();
    await this.audit(p, 'plugin.draft.deleted', d, {}, ctx);
  }

  /** The draft's checked manifest; a draft that does not check out is 422 with every problem. */
  private valid(d: DraftRow): Manifest {
    const c = checkWizard(d.wizard);
    if (!c.valid) throw new HttpProblem(422, 'Manifest refused', c.problems[0]?.message ?? 'The plugin draft does not make a valid manifest yet.', { extensions: { errors: c.problems.map((x) => x.message), steps: c.problems.map((x) => x.step) } });
    return validateManifest(c.manifest);
  }

  /** The plugin file, or the unsigned import bundle that carries it, for download. */
  async export(p: Principal, id: string, format: 'bundle' | 'manifest', ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ name: string; type: string; data: Buffer }> {
    const d = await this.get(p, id);
    const m = this.valid(d);
    const out = format === 'manifest' ? { name: `${m.key}.plugin.json`, type: 'application/json', data: Buffer.from(JSON.stringify(m, null, 2) + '\n') } : (() => {
      const b = unsignedBundle(m);
      return { name: b.name, type: 'application/x-tar', data: b.tar };
    })();
    await this.audit(p, 'plugin.draft.exported', d, { format, key: m.key, version: m.version, kind: m.kind, sha256: createHash('sha256').update(out.data).digest('hex') }, ctx);
    return out;
  }

  /**
   * Installs the draft's manifest as a plugin in the state `installed` with no capability granted: the admin grants
   * and enables it on the Plugins screen as for any install. The signing policy and the host checks of
   * `PluginService.install` apply unchanged.
   */
  async install(p: Principal, id: string, input: { maxLabel: Label; reason?: string | null }, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const d = await this.get(p, id);
    const m = this.valid(d);
    const s = this.s();
    const plugin = await s.plugins.install(p.tenantId, { userId: p.userId, clearance: p.clearance, audit: actorFrom(p, ctx.ip ?? null), traceId: ctx.traceId ?? null }, { manifest: m, grants: [], maxLabel: input.maxLabel, reason: input.reason ?? `From the plugin creator (draft ${d.id})` });
    await this.db('plugin_drafts').where({ tenant_id: p.tenantId, user_id: p.userId, id: d.id }).update({ plugin_id: plugin.id, updated_at: Date.now() });
    await this.audit(p, 'plugin.draft.installed', d, { plugin: plugin.id, key: m.key, version: m.version, kind: m.kind, capabilities: m.capabilities, highRisk: m.capabilities.filter((c) => capability(c)?.risk === 'high'), maxLabel: input.maxLabel }, ctx);
    return plugin;
  }
}
