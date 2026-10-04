import { monotonicFactory, ulid } from 'ulid';
import { canonicalJson, sha256 } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { clears, type Label } from '../authz/labels.js';
import { isUniqueViolation, type AuditActor } from '../audit/chain.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS } from '../platform/bus.js';
import type { Services } from '../services.js';
import { capability } from './capabilities.js';
import { configProblems, defaultGrants, ManifestError, missingGrants, validateManifest, type Manifest } from './manifest.js';

/*
 * Per-tenant plugin installs (B-2002). A plugin is data: its manifest, the capabilities granted to it, a lifecycle
 * state and a sealed configuration. The lifecycle (after exprsn-platform's install machine):
 *
 *   (none | removed) --install--> installed --enable--> enabled --disable--> disabled --enable--> enabled
 *   installed --disable--> disabled;  installed | enabled | disabled --remove--> removed
 *
 * Every transition is recorded in `plugin_transitions` and in the audit chain (`plugin.<event>`), and published on
 * the bus (`plugin.changed`); the tenant's cached list of enabled plugins is cleared on every instance first.
 * Nothing here runs a plugin: declarative actions arrive with B-2003 and script handlers with B-2004.
 */

/** Transition ids sort in the order they were made, also within one millisecond. */
const nextId = monotonicFactory();

export type PluginState = 'installed' | 'enabled' | 'disabled' | 'removed';
export type PluginEvent = 'install' | 'enable' | 'disable' | 'remove' | 'grants';

export const TRANSITIONS: Record<'enable' | 'disable' | 'remove', { from: readonly PluginState[]; to: PluginState }> = {
  enable: { from: ['installed', 'disabled'], to: 'enabled' },
  disable: { from: ['installed', 'enabled'], to: 'disabled' },
  remove: { from: ['installed', 'enabled', 'disabled'], to: 'removed' }
};

export interface PluginRow {
  id: string;
  tenant_id: string;
  plugin_key: string;
  name: string;
  version: string;
  kind: Manifest['kind'];
  manifest: Manifest;
  manifest_hash: string;
  granted: string[];
  max_label: Label;
  config_sealed: string | null;
  state: PluginState;
  installed_by: string | null;
  updated_by: string | null;
  state_changed_at: number;
  created_at: number;
  updated_at: number;
}

/** Who acts: a signed-in user (with their clearance) or an operator through the CLI. */
export interface PluginActor {
  userId: string | null;
  clearance: Label;
  audit: AuditActor;
  traceId?: string | null;
}

const fromRow = (r: Record<string, unknown>): PluginRow => ({
  ...(r as unknown as PluginRow),
  manifest: json<Manifest>(r.manifest, {} as Manifest),
  granted: json<string[]>(r.granted, []),
  state_changed_at: Number(r.state_changed_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const pluginView = (p: PluginRow) => ({
  id: p.id,
  key: p.plugin_key,
  name: p.name,
  version: p.version,
  kind: p.kind,
  description: p.manifest.description ?? null,
  publisher: p.manifest.publisher ?? null,
  state: p.state,
  events: p.manifest.events,
  capabilities: p.manifest.capabilities,
  optionalCapabilities: p.manifest.optionalCapabilities,
  granted: p.granted,
  missing: missingGrants(p.manifest, p.granted),
  maxLabel: p.max_label,
  configured: !!p.config_sealed,
  manifestHash: p.manifest_hash,
  installedBy: p.installed_by,
  stateChangedAt: p.state_changed_at,
  createdAt: p.created_at,
  updatedAt: p.updated_at
});

/** The manifest as shown back: a script's source is summarised, not echoed. */
export const manifestView = (m: Manifest) => ({ ...m, ...(m.script ? { script: { entry: m.script.entry, bytes: Buffer.byteLength(m.script.source) } } : {}) });

const manifestProblem = (err: ManifestError) => new HttpProblem(422, 'Manifest refused', err.problems[0] ?? 'The manifest is not valid.', { extensions: { errors: err.problems } });

export class PluginService {
  constructor(private readonly s: () => Services) {}

  /** Validates a manifest without installing it (the console's and the CLI's dry run). */
  check(input: unknown): Manifest {
    try {
      return validateManifest(input);
    } catch (err) {
      if (err instanceof ManifestError) throw manifestProblem(err);
      throw err;
    }
  }

  async list(tenantId: string, clearance: Label, opts: { removed?: boolean } = {}): Promise<PluginRow[]> {
    const q = this.s().db('plugins').where({ tenant_id: tenantId }).orderBy('plugin_key');
    if (!opts.removed) q.whereNot({ state: 'removed' });
    return ((await q) as Record<string, unknown>[]).map(fromRow).filter((p) => clears(clearance, p.max_label));
  }

  async get(tenantId: string, id: string, clearance: Label): Promise<PluginRow> {
    const r = await this.s().db('plugins').where({ tenant_id: tenantId }).andWhere((q) => q.where({ id }).orWhere({ plugin_key: id })).first();
    if (!r) throw notFound('Plugin');
    const p = fromRow(r);
    if (!clears(clearance, p.max_label)) throw forbidden(`The plugin ${p.plugin_key} receives ${p.max_label} events, above your clearance of ${clearance}.`, { step: 'clearance' });
    return p;
  }

  /** Enabled plugins of a tenant, through the cache (B-2102); the dispatchers of B-2003 and B-2004 read this. */
  async enabled(tenantId: string): Promise<{ id: string; key: string; version: string; granted: string[]; events: string[]; maxLabel: Label }[]> {
    return this.s().cache.get(tenantId, 'plugins', 'enabled', 'medium', async () =>
      (((await this.s().db('plugins').where({ tenant_id: tenantId, state: 'enabled' }).orderBy('plugin_key')) as Record<string, unknown>[]).map(fromRow)).map((p) => ({ id: p.id, key: p.plugin_key, version: p.version, granted: p.granted, events: p.manifest.events, maxLabel: p.max_label }))
    );
  }

  async transitions(tenantId: string, pluginId: string) {
    const rows = (await this.s().db('plugin_transitions').where({ tenant_id: tenantId, plugin_id: pluginId }).orderBy('created_at', 'asc').orderBy('id', 'asc')) as Record<string, unknown>[];
    return rows.map((r) => ({ event: r.event as PluginEvent, from: (r.from_state as PluginState | null) ?? null, to: r.to_state as PluginState, version: String(r.version), actor: (r.actor as string | null) ?? null, reason: (r.reason as string | null) ?? null, at: Number(r.created_at) }));
  }

  private checkGrants(m: Manifest, grants: string[]): void {
    const extra = grants.filter((g) => !m.capabilities.includes(g));
    if (extra.length) throw badRequest(`Only capabilities the manifest asks for can be granted; not ${extra.join(', ')}.`, { errors: extra.map((g) => ({ path: 'grants', message: `${g} is not in the manifest` })) });
  }

  /**
   * Installs a plugin (or reinstalls a removed one, with its new manifest). Grants default to the low-risk
   * capabilities the manifest asks for; high-risk ones (`call:*`, `write:*`) are granted only when named.
   */
  async install(tenantId: string, by: PluginActor, input: { manifest: unknown; grants?: string[]; maxLabel: Label; config?: Record<string, unknown>; reason?: string | null }): Promise<PluginRow> {
    const m = this.check(input.manifest);
    if (!clears(by.clearance, input.maxLabel)) throw forbidden(`Your clearance is ${by.clearance}; a plugin cannot receive ${input.maxLabel} events.`, { step: 'clearance' });
    const grants = [...new Set(input.grants ?? defaultGrants(m))];
    this.checkGrants(m, grants);
    const cfg = configProblems(m, input.config);
    if (cfg.length) throw new HttpProblem(422, 'Configuration refused', cfg[0]!, { extensions: { errors: cfg } });
    const s = this.s();
    const existing = await s.db('plugins').where({ tenant_id: tenantId, plugin_key: m.key }).first();
    if (existing && existing.state !== 'removed') throw conflict(`${m.key} is already installed (${String(existing.state)}). Remove it before installing another version.`);
    const id = existing ? String(existing.id) : ulid();
    const t = Date.now();
    const row = {
      tenant_id: tenantId,
      plugin_key: m.key,
      name: m.name,
      version: m.version,
      kind: m.kind,
      manifest: JSON.stringify(m),
      manifest_hash: sha256(canonicalJson(m)),
      granted: JSON.stringify(grants),
      max_label: input.maxLabel,
      config_sealed: input.config && Object.keys(input.config).length ? await s.keys.seal(tenantId, JSON.stringify(input.config), `plugin-config:${id}`) : null,
      state: 'installed' as const,
      installed_by: by.userId,
      updated_by: by.userId,
      state_changed_at: t,
      updated_at: t
    };
    try {
      await s.db.transaction(async (trx) => {
        if (existing) {
          const n = await trx('plugins').where({ id, tenant_id: tenantId, state: 'removed' }).update(row);
          if (n !== 1) throw conflict(`${m.key} changed while it was being installed; try again.`);
        } else await trx('plugins').insert({ id, ...row, created_at: t });
        await trx('plugin_transitions').insert({ id: nextId(), tenant_id: tenantId, plugin_id: id, event: 'install', from_state: existing ? 'removed' : null, to_state: 'installed', version: m.version, actor: actorRef(by), reason: input.reason?.slice(0, 500) ?? null, created_at: t });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`${m.key} is already installed.`);
      throw err;
    }
    await this.audit(tenantId, by, existing ? 'plugin.reinstalled' : 'plugin.installed', id, m, { version: m.version, kind: m.kind, capabilities: m.capabilities, granted: grants, maxLabel: input.maxLabel, manifestHash: row.manifest_hash });
    await this.changed(tenantId, id);
    return this.get(tenantId, id, by.clearance);
  }

  /** Moves a plugin through its lifecycle; a transition the current state does not allow is a 409. */
  async transition(tenantId: string, by: PluginActor, id: string, event: 'enable' | 'disable' | 'remove', reason: string | null = null): Promise<PluginRow> {
    const p = await this.get(tenantId, id, by.clearance);
    const tr = TRANSITIONS[event];
    if (!tr.from.includes(p.state)) throw conflict(`${p.plugin_key} is ${p.state}; it cannot be ${event === 'remove' ? 'removed' : `${event}d`} from there.`);
    if (event === 'enable') {
      if (p.kind === 'script') throw conflict(`${p.plugin_key} is a script plugin. Script handlers run in the sandbox in a later release; until then a script plugin is stored but cannot be enabled.`);
      const missing = missingGrants(p.manifest, p.granted);
      if (missing.length) throw new HttpProblem(409, 'Conflict', `${p.plugin_key} needs ${missing.join(', ')} granted before it can be enabled.`, { extensions: { missing } });
    }
    const t = Date.now();
    await this.s().db.transaction(async (trx) => {
      // The state is part of the condition: two transitions racing from one state cannot both apply.
      const n = await trx('plugins').where({ id: p.id, tenant_id: tenantId, state: p.state }).update({ state: tr.to, state_changed_at: t, updated_at: t, updated_by: by.userId });
      if (n !== 1) throw conflict(`${p.plugin_key} changed while this was being applied; try again.`);
      await trx('plugin_transitions').insert({ id: nextId(), tenant_id: tenantId, plugin_id: p.id, event, from_state: p.state, to_state: tr.to, version: p.version, actor: actorRef(by), reason: reason?.slice(0, 500) ?? null, created_at: t });
    });
    await this.audit(tenantId, by, `plugin.${event === 'remove' ? 'removed' : `${event}d`}`, p.id, p.manifest, { from: p.state, to: tr.to, version: p.version, ...(reason ? { reason } : {}) });
    await this.changed(tenantId, p.id);
    return { ...p, state: tr.to, state_changed_at: t, updated_at: t, updated_by: by.userId };
  }

  /** Replaces the grants. An enabled plugin that loses a capability it cannot do without is disabled with it. */
  async setGrants(tenantId: string, by: PluginActor, id: string, grants: string[], reason: string | null = null): Promise<PluginRow> {
    const p = await this.get(tenantId, id, by.clearance);
    if (p.state === 'removed') throw conflict(`${p.plugin_key} is removed.`);
    const next = [...new Set(grants)];
    this.checkGrants(p.manifest, next);
    const disable = p.state === 'enabled' && missingGrants(p.manifest, next).length > 0;
    const to: PluginState = disable ? 'disabled' : p.state;
    const t = Date.now();
    await this.s().db.transaction(async (trx) => {
      const n = await trx('plugins').where({ id: p.id, tenant_id: tenantId, state: p.state }).update({ granted: JSON.stringify(next), state: to, ...(disable ? { state_changed_at: t } : {}), updated_at: t, updated_by: by.userId });
      if (n !== 1) throw conflict(`${p.plugin_key} changed while this was being applied; try again.`);
      await trx('plugin_transitions').insert({ id: nextId(), tenant_id: tenantId, plugin_id: p.id, event: 'grants', from_state: p.state, to_state: to, version: p.version, actor: actorRef(by), reason: reason?.slice(0, 500) ?? null, created_at: t });
    });
    const added = next.filter((g) => !p.granted.includes(g));
    const removed = p.granted.filter((g) => !next.includes(g));
    await this.audit(tenantId, by, 'plugin.grants.updated', p.id, p.manifest, { before: p.granted, after: next, added, removed, highRisk: added.filter((g) => capability(g)?.risk === 'high'), ...(disable ? { disabled: true } : {}), ...(reason ? { reason } : {}) });
    await this.changed(tenantId, p.id);
    return { ...p, granted: next, state: to, updated_at: t, updated_by: by.userId };
  }

  private async audit(tenantId: string, by: PluginActor, action: string, id: string, m: Pick<Manifest, 'key' | 'name'>, detail: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId, action, kind: 'admin', actor: by.audit, target: { plugin: id, key: m.key, name: m.name }, label: 'internal', detail, ...(by.traceId ? { traceId: by.traceId } : {}) });
  }

  /** Clears the tenant's cached plugin list here and, through the bus, on every instance (B-2102), then announces it. */
  private async changed(tenantId: string, pluginId: string): Promise<void> {
    await this.s().cache.invalidate({ tenantId, ns: 'plugins' });
    this.s().bus.publish(TOPICS.pluginChanged, { tenantId, pluginId });
  }
}

const actorRef = (by: PluginActor): string | null => by.userId ?? (by.audit.service ? `service:${by.audit.service}` : null);
