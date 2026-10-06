import { createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import type { Db } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { scrubSecrets } from '../platform/diagnostics.js';
import type { Services } from '../services.js';
import { audit, notifyAdmins, type OpsActor } from '../ops/common.js';
import { CONFIG_FIELDS, envOf, parseConfigWith, type Config } from './index.js';
import { SETTINGS, SETTING_SECTIONS, type SettingDescriptor } from './settings.generated.js';

/*
 * B-4205: the Configuration screen's server side. The descriptor (name, section, type, default, secret, hot or
 * restart) is generated from config/index.ts (settings.generated.ts). Each instance reports what it reads under its
 * INSTANCE_NAME every PLATFORM_INSTANCE_REPORT_SECONDS: plain values (scrubbed of credentials), and for a secret only
 * whether it is set, its length, the file it came from and a fingerprint keyed with SESSION_SECRET so that two
 * instances can be compared without the value leaving either of them.
 *
 * Overrides (decision Q2): any setting the descriptor marks overridable may be given a value in the database. One
 * platform admin proposes it with a reason; a second one approves it (never the proposer). Approved, a hot setting is
 * applied to the configuration object every instance reads (on the bus at once, and at each report otherwise); a
 * restart setting is read at the next start (applyStoredOverrides, before the services are built), and the screen
 * names the instances still running without it. A value is checked against the field's schema and the configuration's
 * cross-field rules before it is proposed and again before it applies.
 */

export const SETTINGS_TOPIC = 'platform.settings';
const BY_NAME = new Map(SETTINGS.map((s) => [s.name, s]));
export const settingDescriptor = (name: string): SettingDescriptor | undefined => BY_NAME.get(name);
export { SETTINGS, SETTING_SECTIONS };

const APPLIED = Symbol.for('exprsn.config.applied');
type Applied = Record<string, number>;
/** The overrides this process reads, with when each was approved. */
export const appliedOf = (c: Config): Applied => {
  const r = c as unknown as Record<symbol, Applied | undefined>;
  if (!r[APPLIED]) Object.defineProperty(c, APPLIED, { value: {}, enumerable: false, writable: true });
  return r[APPLIED]!;
};

const VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();
export const buildVersion = (): string => VERSION;

export const instanceName = (c: Config): string => c.INSTANCE_NAME ?? hostname().slice(0, 100);
const STARTED = Date.now();

const read = (c: Config, name: string): unknown => (c as unknown as Record<string, unknown>)[name];
const write = (c: Config, name: string, v: unknown) => void ((c as unknown as Record<string, unknown>)[name] = v);

/** A configured value as text: lists joined with commas, unset as null. */
export const valueText = (v: unknown): string | null => (v === undefined || v === null ? null : Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** What one instance reports for one setting. */
export interface Reported {
  /** The value as text (null: unset). For a secret: 'set' or null. */
  v: string | null;
  src: 'env' | 'file' | 'default' | 'override';
  /** The `<NAME>_FILE` path a secret came from, and the file's mode. */
  file?: string;
  mode?: string;
  /** A secret's length and its keyed fingerprint (16 hex). */
  chars?: number;
  fp?: string;
}

/** What this instance reads, setting by setting. */
export function snapshot(c: Config): Record<string, Reported> {
  const env = envOf(c);
  const applied = appliedOf(c);
  const out: Record<string, Reported> = {};
  for (const d of SETTINGS) {
    const raw = read(c, d.name);
    const fileVar = d.file ? env[`${d.name}_FILE`] : undefined;
    const src: Reported['src'] = applied[d.name] ? 'override' : fileVar ? 'file' : env[d.name] != null && env[d.name] !== '' ? 'env' : 'default';
    if (d.secret) {
      const set = raw != null && raw !== '';
      const r: Reported = { v: set ? 'set' : null, src };
      if (set) {
        r.chars = String(raw).length;
        r.fp = createHmac('sha256', c.SESSION_SECRET).update(`setting:${d.name}\0${String(raw)}`).digest('hex').slice(0, 16);
      }
      if (fileVar) {
        r.file = fileVar;
        try {
          r.mode = `0${(statSync(fileVar).mode & 0o777).toString(8)}`;
        } catch {
          /* the file was read at start; it may be gone since */
        }
      }
      out[d.name] = r;
    } else {
      const t = valueText(raw);
      out[d.name] = { v: t == null ? null : scrubSecrets(t), src };
    }
  }
  return out;
}

/** The text that identifies a value across instances (a secret by its fingerprint). */
const identity = (r: Reported | undefined): string => (r ? (r.fp ? `fp:${r.fp}` : `v:${r.v ?? ''}`) : '');

interface OverrideRow {
  name: string;
  value: string;
  applies: 'hot' | 'restart';
  proposal_id: string;
  proposed_by: string;
  approved_by: string;
  reason: string;
  applied_at: number;
}

export interface ProposalRow {
  id: string;
  name: string;
  action: 'set' | 'clear';
  value: string | null;
  previous: string | null;
  reason: string;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
  proposed_by: string;
  proposed_tenant: string;
  proposed_at: number;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
}

const proposalFrom = (r: Record<string, unknown>): ProposalRow => ({ ...(r as unknown as ProposalRow), proposed_at: Number(r.proposed_at), decided_at: r.decided_at == null ? null : Number(r.decided_at) });
const overrideFrom = (r: Record<string, unknown>): OverrideRow => ({ ...(r as unknown as OverrideRow), applied_at: Number(r.applied_at) });

async function overrides(db: Db): Promise<OverrideRow[]> {
  if (!(await db.schema.hasTable('platform_setting_overrides'))) return [];
  return ((await db('platform_setting_overrides').select('*')) as Record<string, unknown>[]).map(overrideFrom);
}

/**
 * At start, before the services are built: the approved overrides go into the configuration (hot and restart
 * settings alike). When the merged configuration does not pass the schema (the environment changed since), none is
 * applied, the start goes on with the environment's values, and the problem is logged.
 */
export async function applyStoredOverrides(c: Config, db: Db, log?: Logger): Promise<{ applied: string[]; errors: string[] }> {
  if (!c.PLATFORM_SETTINGS_OVERRIDES) return { applied: [], errors: [] };
  const rows = (await overrides(db)).filter((o) => settingDescriptor(o.name)?.overridable);
  if (!rows.length) return { applied: [], errors: [] };
  const parsed = parseConfigWith(envOf(c), Object.fromEntries(rows.map((o) => [o.name, o.value])));
  if (!parsed.ok) {
    log?.error({ errors: parsed.errors }, 'stored setting overrides do not pass the configuration schema; starting with the environment alone');
    return { applied: [], errors: parsed.errors };
  }
  const applied = appliedOf(c);
  for (const o of rows) {
    write(c, o.name, read(parsed.config, o.name));
    applied[o.name] = o.applied_at;
  }
  return { applied: rows.map((o) => o.name), errors: [] };
}

export interface InstanceRow {
  instance: string;
  host: string;
  pid: number;
  version: string;
  started_at: number;
  reported_at: number;
  blob_mode: string | null;
  settings: Record<string, Reported>;
  overrides: Applied;
}

const instanceFrom = (r: Record<string, unknown>): InstanceRow => ({
  instance: String(r.instance),
  host: String(r.host),
  pid: Number(r.pid),
  version: String(r.version),
  started_at: Number(r.started_at),
  reported_at: Number(r.reported_at),
  blob_mode: (r.blob_mode as string | null) ?? null,
  settings: JSON.parse(String(r.settings)) as Record<string, Reported>,
  overrides: r.overrides ? (JSON.parse(String(r.overrides)) as Applied) : {}
});

const problem422 = (name: string, errors: string[]) =>
  new HttpProblem(422, 'Value refused', `${name}: ${errors.join('; ')}`, { extensions: { setting: name, errors } });

export class SettingsService {
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly s: () => Services) {}

  get instance(): string {
    return instanceName(this.s().cfg);
  }

  /** Reports now, then every PLATFORM_INSTANCE_REPORT_SECONDS; hot overrides follow the bus and each report. */
  start(): void {
    const s = this.s();
    this.off = s.bus.on(SETTINGS_TOPIC, () => this.sync());
    const tick = () => void this.sync().then(() => this.report()).catch((err: Error) => s.log.warn({ err: err.message }, 'settings report failed'));
    tick();
    this.timer = setInterval(tick, s.cfg.PLATFORM_INSTANCE_REPORT_SECONDS * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
  }

  /** Writes this instance's row. */
  async report(): Promise<void> {
    const s = this.s();
    const blobs = s.blobs as unknown as { label?: string };
    const row = {
      instance: this.instance,
      host: hostname().slice(0, 200),
      pid: process.pid,
      version: VERSION,
      started_at: STARTED,
      reported_at: Date.now(),
      blob_mode: blobs.label ?? 'single',
      settings: JSON.stringify(snapshot(s.cfg)),
      overrides: JSON.stringify(appliedOf(s.cfg))
    };
    const n = await s.db('platform_instance_settings').where({ instance: row.instance }).update(row);
    if (!n) await s.db('platform_instance_settings').insert(row).catch(async () => s.db('platform_instance_settings').where({ instance: row.instance }).update(row));
  }

  /**
   * Applies the hot overrides in the database to this process (and takes back removed ones). Restart settings are
   * left for the next start.
   */
  async sync(): Promise<string[]> {
    const s = this.s();
    if (!s.cfg.PLATFORM_SETTINGS_OVERRIDES) return [];
    const rows = (await overrides(s.db)).filter((o) => settingDescriptor(o.name)?.overridable);
    const applied = appliedOf(s.cfg);
    const hot = new Map(rows.filter((o) => o.applies === 'hot').map((o) => [o.name, o]));
    const changed = [...hot.values()].filter((o) => applied[o.name] !== o.applied_at);
    const removed = Object.keys(applied).filter((n) => settingDescriptor(n)?.applies === 'hot' && !hot.has(n));
    if (!changed.length && !removed.length) return [];
    const kept = rows.filter((o) => applied[o.name] || hot.has(o.name));
    const parsed = parseConfigWith(envOf(s.cfg), Object.fromEntries(kept.map((o) => [o.name, o.value])));
    if (!parsed.ok) {
      s.log.error({ errors: parsed.errors }, 'setting overrides do not pass the configuration schema; not applied');
      return [];
    }
    for (const o of changed) {
      write(s.cfg, o.name, read(parsed.config, o.name));
      applied[o.name] = o.applied_at;
      this.applyHook(o.name);
    }
    for (const n of removed) {
      write(s.cfg, n, read(parsed.config, n));
      delete applied[n];
      this.applyHook(n);
    }
    return [...changed.map((o) => o.name), ...removed];
  }

  /** Settings whose new value must reach something read once (the logger's level). */
  private applyHook(name: string): void {
    const s = this.s();
    if (name === 'LOG_LEVEL') s.log.level = s.cfg.LOG_LEVEL;
  }

  // ---------- reading ----------

  async instances(): Promise<(InstanceRow & { live: boolean })[]> {
    const s = this.s();
    const now = Date.now();
    const liveWithin = Math.max(3 * s.cfg.PLATFORM_INSTANCE_REPORT_SECONDS * 1000, 90_000);
    const rows = ((await s.db('platform_instance_settings').where('reported_at', '>', now - 24 * 3_600_000).orderBy('instance')) as Record<string, unknown>[]).map(instanceFrom);
    return rows.map((r) => ({ ...r, live: now - r.reported_at <= liveWithin }));
  }

  async proposals(limit = 100): Promise<ProposalRow[]> {
    return ((await this.s().db('platform_setting_proposals').orderBy('proposed_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(proposalFrom);
  }

  async proposal(id: string): Promise<ProposalRow> {
    const r = await this.s().db('platform_setting_proposals').where({ id }).first();
    if (!r) throw notFound('Override proposal');
    return proposalFrom(r);
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map(((list.length ? await this.s().db('users').whereIn('id', list).select('id', 'display_name') : []) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
  }

  /** When the key-encryption key was last re-wrapped and verified (DATA_KEY_PREVIOUS is then no longer needed). */
  private async rewrapFinished(): Promise<number | null> {
    const r = (await this.s().db('audit_events').where({ action: 'kms.rewrapped' }).orderBy('ts', 'desc').first('ts', 'detail')) as { ts: number | string; detail: string | null } | undefined;
    if (!r) return null;
    try {
      return (JSON.parse(r.detail ?? '{}') as { verified?: boolean }).verified ? Number(r.ts) : null;
    } catch {
      return null;
    }
  }

  /** The whole Configuration screen: the descriptor, what each instance reads, overrides, proposals and history. */
  async view(viewer: string | null): Promise<Record<string, unknown>> {
    const s = this.s();
    await this.report().catch(() => undefined);
    const [instances, rows, props, rewrap] = await Promise.all([this.instances(), overrides(s.db), this.proposals(500), this.rewrapFinished()]);
    const live = instances.filter((i) => i.live);
    const mine = snapshot(s.cfg);
    const byName = new Map(rows.map((o) => [o.name, o]));
    const names = await this.names([...props.flatMap((p) => [p.proposed_by, p.decided_by]), ...rows.flatMap((o) => [o.proposed_by, o.approved_by])]);
    const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
    const restart: Record<string, string[]> = {};
    const settings = SETTINGS.map((d) => {
      const per = live.map((i) => ({ instance: i.instance, ...(i.settings[d.name] ?? { v: null, src: 'default' as const }) }));
      const distinct = new Set(live.filter((i) => i.settings[d.name]).map((i) => identity(i.settings[d.name])));
      const o = byName.get(d.name);
      // An approved override this instance does not read yet: hot ones until the next sync, restart ones until a restart.
      const waiting = o ? live.filter((i) => i.overrides[d.name] !== o.applied_at).map((i) => i.instance) : live.filter((i) => i.overrides[d.name] != null).map((i) => i.instance);
      // A removed override of a restart setting is still read until the instance starts again, like a new one.
      if (waiting.length && (o ? o.applies === 'restart' : d.applies === 'restart')) restart[d.name] = waiting;
      const me = mine[d.name]!;
      const pending = props.find((p) => p.name === d.name && p.state === 'pending');
      const history = props.filter((p) => p.name === d.name && p.state !== 'pending').slice(0, 10).map((p) => ({ id: p.id, action: p.action, from: p.previous, to: p.value, reason: p.reason, state: p.state, proposedBy: nameOf(p.proposed_by), decidedBy: nameOf(p.decided_by), at: p.decided_at ?? p.proposed_at, note: p.note }));
      const deprecated = (d.name === 'DATA_KEY_PREVIOUS' || d.name === 'KMS_PREVIOUS_PROVIDER') && me.v != null && rewrap ? `The key-encryption key was re-wrapped and verified on ${new Date(rewrap).toISOString().slice(0, 10)}; nothing is sealed with the previous key any more.` : null;
      return {
        ...d,
        // `file` in the descriptor says the setting may come from <NAME>_FILE; here it is the file it came from.
        fileForm: d.file,
        file: me.file ?? null,
        value: me.v,
        source: me.src,
        ...(me.mode ? { mode: me.mode } : {}),
        ...(me.chars != null ? { chars: me.chars } : {}),
        // A value nobody set is the build's default, even one the configuration derives (COOKIE_SECURE).
        changed: me.src !== 'default' && (d.secret || (me.v !== d.default && !(me.v == null && (d.default == null || d.default === '')))),
        differs: distinct.size > 1,
        perInstance: per.map((p) => ({ instance: p.instance, value: p.v, source: p.src, ...(p.chars != null ? { chars: p.chars } : {}), ...(p.fp ? { fingerprint: p.fp } : {}) })),
        since: o ? o.applied_at : null,
        override: o ? { value: d.secret ? null : o.value, applies: o.applies, reason: o.reason, proposedBy: nameOf(o.proposed_by), approvedBy: nameOf(o.approved_by), appliedAt: o.applied_at, waiting } : null,
        pending: pending ? { id: pending.id, action: pending.action, value: pending.value, reason: pending.reason, proposedBy: nameOf(pending.proposed_by), proposedAt: pending.proposed_at, mine: pending.proposed_by === viewer } : null,
        history,
        deprecated
      };
    });
    return {
      build: VERSION,
      instance: this.instance,
      overridesEnabled: s.cfg.PLATFORM_SETTINGS_OVERRIDES,
      sections: SETTING_SECTIONS,
      instances: instances.map((i) => ({ instance: i.instance, host: i.host, version: i.version, startedAt: i.started_at, reportedAt: i.reported_at, live: i.live, blobMode: i.blob_mode, self: i.instance === this.instance })),
      restartRequired: Object.entries(restart).map(([name, inst]) => ({ name, instances: inst })),
      pending: props.filter((p) => p.state === 'pending').map((p) => ({ id: p.id, name: p.name, action: p.action, value: p.value, reason: p.reason, proposedBy: nameOf(p.proposed_by), proposedAt: p.proposed_at, mine: p.proposed_by === viewer })),
      settings
    };
  }

  /** The settings as a .env file: secrets masked with a comment naming their file. */
  envFile(onlyChanged: boolean): { text: string; lines: number } {
    const mine = snapshot(this.s().cfg);
    const out: string[] = [`# Exprsn-AI ${VERSION}, instance ${this.instance}, ${new Date().toISOString()}`, '# Secrets are masked; their files are named in a comment.'];
    let n = 0;
    for (const section of SETTING_SECTIONS) {
      const list = SETTINGS.filter((d) => d.section === section).filter((d) => {
        const r = mine[d.name]!;
        return !onlyChanged || (r.src !== 'default' && (d.secret || (r.v !== d.default && !(r.v == null && !d.default))));
      });
      if (!list.length) continue;
      out.push('', `# ${section}`);
      for (const d of list) {
        const r = mine[d.name]!;
        if (d.secret) {
          if (r.file) out.push(`# ${d.name} is read from ${r.file}`);
          out.push(`${d.name}=${r.v ? '********' : ''}`);
        } else out.push(`${d.name}=${quote(r.v ?? '')}`);
        n++;
      }
    }
    return { text: out.join('\n') + '\n', lines: n };
  }

  // ---------- overrides under dual control ----------

  private enabled(): void {
    if (!this.s().cfg.PLATFORM_SETTINGS_OVERRIDES) throw new HttpProblem(409, 'Overrides disabled', 'Settings are managed in the environment of this deployment (PLATFORM_SETTINGS_OVERRIDES=false).', { extensions: { step: 'overrides-disabled' } });
  }

  private overridable(name: string): SettingDescriptor {
    const d = settingDescriptor(name);
    if (!d) throw notFound('Setting');
    if (!d.overridable) throw new HttpProblem(409, 'Not overridable', `${name} cannot be overridden from the console: ${d.fixedReason ?? 'it is read before the overrides.'}`, { extensions: { setting: name, step: 'not-overridable' } });
    return d;
  }

  /** Checks a value against the field and against the whole configuration with every override in force. */
  async check(name: string, value: string | null): Promise<void> {
    const s = this.s();
    if (value != null) {
      const field = (CONFIG_FIELDS as Record<string, { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } }>)[name]!;
      const r = field.safeParse(value);
      if (!r.success) throw problem422(name, r.error!.issues.map((i) => i.message));
    }
    const rest = Object.fromEntries((await overrides(s.db)).filter((o) => o.name !== name).map((o) => [o.name, o.value]));
    const parsed = parseConfigWith(envOf(s.cfg), value == null ? rest : { ...rest, [name]: value });
    if (!parsed.ok) throw problem422(name, parsed.errors);
  }

  async propose(by: OpsActor, name: string, value: string | null, reason: string): Promise<ProposalRow> {
    this.enabled();
    const d = this.overridable(name);
    const s = this.s();
    const current = (await s.db('platform_setting_overrides').where({ name }).first()) as Record<string, unknown> | undefined;
    if (value == null && !current) throw conflict(`${name} has no override to remove.`);
    const mine = snapshot(s.cfg)[name]!;
    if (value != null && value === mine.v && !current) throw conflict(`${name} already reads ${value}.`);
    if (value != null && current && String(current.value) === value) throw conflict(`${name} is already overridden with ${value}.`);
    if (await s.db('platform_setting_proposals').where({ name, state: 'pending' }).first()) throw conflict(`An override of ${name} is already waiting for a second platform admin.`);
    await this.check(name, value);
    if (!by.userId) throw forbidden('Overrides are proposed by a person.');
    const row = { id: ulid(), name, action: value == null ? 'clear' : 'set', value, previous: d.secret ? null : mine.v, reason, state: 'pending', proposed_by: by.userId, proposed_tenant: by.tenantId, proposed_at: Date.now() };
    await s.db('platform_setting_proposals').insert(row);
    await audit(s, by, 'platform.setting.proposed', { setting: name, proposal: row.id }, { action: row.action, from: row.previous, to: value, applies: d.applies, reason }, 'admin');
    await notifyAdmins(s, { kind: 'platform.setting.proposed', title: `An override of ${name} is waiting for a second platform admin`, body: reason.slice(0, 300) }).catch(() => 0);
    return this.proposal(row.id);
  }

  private async pending(id: string): Promise<ProposalRow> {
    const p = await this.proposal(id);
    if (p.state !== 'pending') throw conflict(`The proposal is ${p.state}.`);
    return p;
  }

  private decide(id: string, state: ProposalRow['state'], by: OpsActor, note: string | null) {
    return this.s().db('platform_setting_proposals').where({ id, state: 'pending' }).update({ state, decided_by: by.userId, decided_at: Date.now(), note });
  }

  /** A second platform admin approves: the override is stored and applied (hot) or waits for a restart. */
  async approve(by: OpsActor, id: string, note: string | null): Promise<{ proposal: ProposalRow; applies: 'hot' | 'restart'; applied: boolean }> {
    this.enabled();
    const s = this.s();
    const p = await this.pending(id);
    if (p.proposed_by === by.userId) throw forbidden('Dual control: you cannot approve your own proposal. Another platform admin must approve it.', { step: 'dual-control' });
    const d = this.overridable(p.name);
    await this.check(p.name, p.value);
    if (!(await this.decide(id, 'approved', by, note))) throw conflict('The proposal was decided by someone else.');
    const t = Date.now();
    if (p.action === 'clear') await s.db('platform_setting_overrides').where({ name: p.name }).delete();
    else {
      const row = { name: p.name, value: p.value!, applies: d.applies, proposal_id: p.id, proposed_by: p.proposed_by, approved_by: by.userId!, reason: p.reason, applied_at: t };
      const n = await s.db('platform_setting_overrides').where({ name: p.name }).update(row);
      if (!n) await s.db('platform_setting_overrides').insert(row);
    }
    const synced = await this.sync();
    s.bus.publish(SETTINGS_TOPIC, { name: p.name });
    await this.report().catch(() => undefined);
    const applied = d.applies === 'hot' && (synced.includes(p.name) || p.action === 'clear');
    await audit(s, by, 'platform.setting.approved', { setting: p.name, proposal: id }, { action: p.action, from: p.previous, to: p.value, applies: d.applies, proposedBy: p.proposed_by, reason: p.reason, note, restartRequired: d.applies === 'restart' }, 'admin');
    return { proposal: await this.proposal(id), applies: d.applies, applied };
  }

  async reject(by: OpsActor, id: string, note: string | null): Promise<ProposalRow> {
    const p = await this.pending(id);
    if (p.proposed_by === by.userId) throw conflict('This is your own proposal: withdraw it instead.');
    await this.decide(id, 'rejected', by, note);
    await audit(this.s(), by, 'platform.setting.rejected', { setting: p.name, proposal: id }, { action: p.action, to: p.value, proposedBy: p.proposed_by, note }, 'admin');
    return this.proposal(id);
  }

  async withdraw(by: OpsActor, id: string): Promise<ProposalRow> {
    const p = await this.pending(id);
    if (p.proposed_by !== by.userId) throw forbidden('Only the admin who proposed a change can withdraw it; reject it instead.', { step: 'dual-control' });
    await this.decide(id, 'withdrawn', by, null);
    await audit(this.s(), by, 'platform.setting.withdrawn', { setting: p.name, proposal: id }, { action: p.action, to: p.value }, 'admin');
    return this.proposal(id);
  }
}

const quote = (v: string) => (/^[A-Za-z0-9_./:@,+-]*$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
