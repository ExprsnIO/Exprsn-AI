import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { domainCall, DOMAIN_CALLS, type DomainCall } from './broker-calls.js';
import type { PluginRow } from './service.js';

/*
 * 1.7.0, Sprint 43 (B-112, decision D11d; the record is docs/decisions/plugin-ui-surfaces.md): plugin UI surfaces.
 *
 * Declarative surfaces, rendered by the console: a plugin's manifest describes each surface as data (blocks of text,
 * key-value lines, a table and action buttons) and the console draws it with its own UI helpers. No plugin markup,
 * script or style reaches the browser, so the console's content-security policy does not change, and keyboard use,
 * labels, contrast and reflow are the console's own.
 *
 * Where a surface appears is its `slot`: a settings panel on the Plugins and events screen, a side panel beside a
 * record, a conversation or a file, or a card on the Overview. A surface names the capabilities its bridge may call
 * (a subset of what the manifest asks for), and each of its data calls and actions is one of the broker's domain
 * calls, declared in the manifest with its arguments. The console asks the bridge to run a call by its id, with the
 * context of the slot (the record, conversation, file or group shown); it never sends a call of its own making.
 *
 * The bridge runs a call as the viewer, never as the installer and never with the session handed to the plugin: the
 * call's capability must be granted to the plugin and declared by the surface, the viewer must hold the route's
 * permission, and their clearance is capped at the plugin's max label, so a surface never reads above the viewer.
 * A tenant admin approves each surface (the install grants nothing for it); any surface can be disabled at once.
 */

export const SURFACE_SLOTS = ['settings', 'record', 'conversation', 'file', 'dashboard'] as const;
export type SurfaceSlot = (typeof SURFACE_SLOTS)[number];

/** The capability each domain call needs (as in runtime.ts). */
export const CALL_CAPABILITY: Record<DomainCall, string> = { 'records.read': 'read:records', 'records.write': 'write:records', 'files.read': 'read:files', 'groups.read': 'read:groups', 'posts.write': 'write:posts', 'flags.read': 'read:flags' };

/** What a slot hands the bridge: `{{context.<key>}}` in a call's arguments. */
const CONTEXT_KEYS: Record<SurfaceSlot, readonly string[]> = { settings: [], dashboard: [], record: ['app', 'entity', 'record'], conversation: ['conversation'], file: ['file'] };

const id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'a lowercase id: letters, digits and hyphens');
const text = z.string().max(2000);
const path = z.string().regex(/^[A-Za-z0-9_.]{1,120}$/, 'a dotted path into the call\'s answer');
const call = z.object({ api: z.enum(DOMAIN_CALLS), with: z.record(z.string(), z.unknown()).default({}) }).strict();

const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text }).strict(),
  z.object({ type: z.literal('kv'), data: id, items: z.array(z.object({ label: z.string().max(80), path }).strict()).min(1).max(20) }).strict(),
  z.object({ type: z.literal('table'), data: id, rows: path, columns: z.array(z.object({ label: z.string().max(80), path }).strict()).min(1).max(8) }).strict(),
  z.object({ type: z.literal('action'), label: z.string().min(1).max(60), action: id, confirm: z.string().max(300).optional() }).strict()
]);

export const surfaceSchema = z
  .object({
    id,
    slot: z.enum(SURFACE_SLOTS),
    title: z.string().trim().min(1).max(80),
    description: z.string().max(300).optional(),
    /** For a record slot: only beside records of this app (and entity). */
    app: z.string().max(100).optional(),
    entity: z.string().max(100).optional(),
    capabilities: z.array(z.string().max(60)).max(10).default([]),
    data: z.record(id, call).default({}),
    actions: z.record(id, call).default({}),
    blocks: z.array(block).min(1).max(30)
  })
  .strict();
export type Surface = z.infer<typeof surfaceSchema>;

/** Problems with a manifest's `ui` against its capabilities; empty when it is sound. */
export function surfaceProblems(ui: readonly Surface[], manifestCapabilities: readonly string[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const s of ui) {
    if (ids.has(s.id)) out.push(`ui: the surface id ${s.id} is used twice`);
    ids.add(s.id);
    for (const c of s.capabilities) if (!manifestCapabilities.includes(c)) out.push(`ui.${s.id}: ${c} is not among the capabilities the manifest asks for`);
    for (const [kind, calls] of [['data', s.data], ['actions', s.actions]] as const) {
      for (const [cid, c] of Object.entries(calls)) {
        const need = CALL_CAPABILITY[c.api];
        if (!s.capabilities.includes(need)) out.push(`ui.${s.id}.${kind}.${cid}: ${c.api} needs ${need}, which the surface does not declare`);
        if (kind === 'data' && !c.api.endsWith('.read')) out.push(`ui.${s.id}.data.${cid}: data is read with a read call; ${c.api} belongs under actions`);
        for (const m of JSON.stringify(c.with).matchAll(/\{\{\s*([a-z.]+)\s*\}\}/g)) {
          const key = m[1]!.replace(/^context\./, '');
          if (!m[1]!.startsWith('context.') || !CONTEXT_KEYS[s.slot].includes(key)) out.push(`ui.${s.id}.${kind}.${cid}: {{${m[1]}}} is not something the ${s.slot} slot provides (${CONTEXT_KEYS[s.slot].map((k) => `context.${k}`).join(', ') || 'nothing'})`);
        }
      }
    }
    for (const b of s.blocks) {
      if ((b.type === 'kv' || b.type === 'table') && !s.data[b.data]) out.push(`ui.${s.id}: a ${b.type} block reads ${b.data}, which is not under data`);
      if (b.type === 'action' && !s.actions[b.action]) out.push(`ui.${s.id}: the action ${b.action} is not under actions`);
    }
    if (s.slot !== 'record' && (s.app || s.entity)) out.push(`ui.${s.id}: app and entity narrow a record slot only`);
  }
  return out;
}

/** Substitutes `{{context.<key>}}` (whole values only) from the slot's context; anything not given is refused. */
function bind(value: unknown, context: Record<string, string>): unknown {
  if (typeof value === 'string') {
    const m = /^\{\{\s*context\.([a-z]+)\s*\}\}$/.exec(value);
    if (!m) return value;
    const v = context[m[1]!];
    if (v === undefined) throw new HttpProblem(400, 'Invalid request', `This panel needs the ${m[1]} it is shown beside.`);
    return v;
  }
  if (Array.isArray(value)) return value.map((x) => bind(x, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, bind(v, context)]));
  return value;
}

export interface SurfaceState {
  plugin_id: string;
  surface_id: string;
  approved_by: string | null;
  approved_at: number | null;
  enabled: boolean;
}

export class PluginSurfaces {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async states(tenantId: string, pluginId?: string): Promise<Map<string, SurfaceState>> {
    const rows = (await this.db('plugin_surfaces').where({ tenant_id: tenantId }).modify((q) => { if (pluginId) void q.where({ plugin_id: pluginId }); })) as Record<string, unknown>[];
    return new Map(rows.map((r) => [`${r.plugin_id}/${r.surface_id}`, { plugin_id: String(r.plugin_id), surface_id: String(r.surface_id), approved_by: (r.approved_by as string | null) ?? null, approved_at: r.approved_at == null ? null : Number(r.approved_at), enabled: r.enabled === true || r.enabled === 1 }]));
  }

  /** A plugin's surfaces with their approval and state, for its admins (Plugins and events). */
  async forPlugin(tenantId: string, plugin: PluginRow) {
    const st = await this.states(tenantId, plugin.id);
    return (plugin.manifest.ui ?? []).map((u) => {
      const x = st.get(`${plugin.id}/${u.id}`);
      const missing = u.capabilities.filter((c) => !plugin.granted.includes(c));
      return { id: u.id, slot: u.slot, title: u.title, description: u.description ?? null, capabilities: u.capabilities, missingGrants: missing, approved: !!x?.approved_at, approvedBy: x?.approved_by ?? null, approvedAt: x?.approved_at ?? null, enabled: !!x?.enabled };
    });
  }

  /** Approve (and enable) a surface, disable it, or enable it again. Approving takes every capability it declares granted. */
  async set(p: Principal, plugin: PluginRow, surfaceId: string, change: { approve?: boolean; enabled?: boolean }, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const u = (plugin.manifest.ui ?? []).find((x) => x.id === surfaceId);
    if (!u) throw notFound('Surface');
    const cur = (await this.states(p.tenantId, plugin.id)).get(`${plugin.id}/${surfaceId}`);
    const t = Date.now();
    let next: SurfaceState = cur ?? { plugin_id: plugin.id, surface_id: surfaceId, approved_by: null, approved_at: null, enabled: false };
    if (change.approve) {
      const missing = u.capabilities.filter((c) => !plugin.granted.includes(c));
      if (missing.length) throw conflict(`Grant ${missing.join(', ')} to the plugin before approving this surface.`);
      next = { ...next, approved_by: p.userId, approved_at: t, enabled: true };
    }
    if (change.approve === false) next = { ...next, approved_by: null, approved_at: null, enabled: false };
    if (change.enabled !== undefined) {
      if (change.enabled && !next.approved_at) throw conflict('Approve the surface before enabling it.');
      next = { ...next, enabled: change.enabled };
    }
    await this.db.transaction(async (trx) => {
      await trx('plugin_surfaces').where({ tenant_id: p.tenantId, plugin_id: plugin.id, surface_id: surfaceId }).delete();
      await trx('plugin_surfaces').insert({ tenant_id: p.tenantId, plugin_id: plugin.id, surface_id: surfaceId, approved_by: next.approved_by, approved_at: next.approved_at, enabled: next.enabled, updated_at: t });
    });
    await this.s().audit.append({ tenantId: p.tenantId, action: change.approve ? 'plugin.surface.approved' : change.approve === false ? 'plugin.surface.unapproved' : next.enabled ? 'plugin.surface.enabled' : 'plugin.surface.disabled', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { plugin: plugin.id, key: plugin.plugin_key, surface: surfaceId }, detail: { slot: u.slot, capabilities: u.capabilities }, traceId: ctx.traceId ?? null });
    return (await this.forPlugin(p.tenantId, plugin)).find((x) => x.id === surfaceId)!;
  }

  /** The approved, enabled surfaces of enabled plugins for a slot, as the console draws them (no data). */
  async forSlot(p: Principal, slot: SurfaceSlot, near: { app?: string; entity?: string } = {}) {
    const plugins = ((await this.db('plugins').where({ tenant_id: p.tenantId, state: 'enabled' })) as Record<string, unknown>[]).map((r) => this.s().plugins.fromRow(r));
    const st = await this.states(p.tenantId);
    const out = [];
    for (const pl of plugins) {
      for (const u of pl.manifest.ui ?? []) {
        const x = st.get(`${pl.id}/${u.id}`);
        if (u.slot !== slot || !x?.approved_at || !x.enabled) continue;
        if (u.capabilities.some((c) => !pl.granted.includes(c))) continue;
        if (slot === 'record' && ((u.app && u.app !== near.app) || (u.entity && u.entity !== near.entity))) continue;
        out.push({ plugin: { id: pl.id, key: pl.plugin_key, name: pl.name }, id: u.id, slot: u.slot, title: u.title, description: u.description ?? null, blocks: u.blocks, data: Object.keys(u.data), actions: Object.fromEntries(Object.entries(u.actions).map(([k, v]) => [k, { api: v.api }])) });
      }
    }
    return out;
  }

  /** The bridge: runs one declared data call or action of a surface, as the viewer, with the slot's context. */
  async call(p: Principal, pluginId: string, surfaceId: string, kind: 'data' | 'action', callId: string, context: Record<string, string>, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const s = this.s();
    const row = (await this.db('plugins').where({ tenant_id: p.tenantId, id: pluginId }).first()) as Record<string, unknown> | undefined;
    if (!row) throw notFound('Plugin');
    const plugin = s.plugins.fromRow(row);
    const u = (plugin.manifest.ui ?? []).find((x) => x.id === surfaceId);
    const st = (await this.states(p.tenantId, plugin.id)).get(`${plugin.id}/${surfaceId}`);
    if (!u || plugin.state !== 'enabled' || !st?.approved_at || !st.enabled) throw notFound('Surface');
    const c = (kind === 'data' ? u.data : u.actions)[callId];
    if (!c) throw notFound('Call');
    const need = CALL_CAPABILITY[c.api];
    // the surface declared it, and the plugin holds it now (a grant can be taken back after approval)
    if (!u.capabilities.includes(need) || !plugin.granted.includes(need)) throw forbidden(`${plugin.plugin_key} may not call ${c.api} from this surface (${need}).`, { step: 'capability', capability: need });
    const allowed = CONTEXT_KEYS[u.slot];
    const given = Object.fromEntries(Object.entries(context).filter(([k, v]) => allowed.includes(k) && typeof v === 'string' && v.length <= 200));
    const args = bind(c.with, given) as Record<string, unknown>;
    const out = await domainCall(s, plugin, c.api, args, 'public', { viewer: p });
    if (kind === 'action') await s.audit.append({ tenantId: p.tenantId, action: 'plugin.surface.action', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { plugin: plugin.id, key: plugin.plugin_key, surface: surfaceId, action: callId }, detail: { api: c.api }, traceId: ctx.traceId ?? null });
    return out;
  }
}

