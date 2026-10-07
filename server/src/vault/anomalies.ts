import { ulid } from 'ulid';
import { actorFrom, PLATFORM_TENANT } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { VaultCaller } from './service.js';

/*
 * 1.6.0 (B-4803): anomaly detection on reveals of KV secrets.
 *
 * Every reveal over the API (a request with an address; values the server resolves at use for `vault:` references
 * carry none and are not watched) is kept for VAULT_ANOMALY_HISTORY_DAYS with who, from where and at which hour. Each
 * reveal is compared with the secret's own history, before it is answered:
 *
 * - new address: the secret was revealed from other addresses in that time, never from this one;
 * - odd hour: the secret has at least VAULT_ANOMALY_MIN_HISTORY reveals in that time and none in this hour of the day
 *   (UTC);
 * - burst: this is at least the VAULT_ANOMALY_BURST-th reveal of the secret by one principal within
 *   VAULT_ANOMALY_BURST_SECONDS.
 *
 * A signal raises a flag for the secret's owner (its owner, else its creator): a notification and an entry under
 * Vault, Reveal flags. One flag stays open per secret and principal: later signals are added to it (a new kind tells
 * the owner again) and later reveals counted on it. The owner or a vault administrator resolves it as expected or
 * suspicious. Detection never refuses a reveal: it tells the person who should know. VAULT_ANOMALY_BURST=0 turns it off.
 */

export const PRUNE_JOB = 'vault.reveals.prune';
export type SignalKind = 'new-address' | 'odd-hour' | 'burst';
export interface Signal {
  kind: SignalKind;
  detail: string;
  at: number;
}

interface FlagRow {
  id: string;
  tenant_id: string;
  secret_id: string;
  path: string;
  label: Label;
  owner_id: string | null;
  principal: string;
  principal_name: string | null;
  ip: string | null;
  signals: Signal[];
  reveals: number;
  state: 'open' | 'expected' | 'suspicious';
  resolved_by: string | null;
  resolved_at: number | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

const flagFrom = (r: Record<string, unknown>): FlagRow => ({ ...(r as unknown as FlagRow), signals: json<Signal[]>(r.signals, []), reveals: Number(r.reveals), resolved_at: r.resolved_at == null ? null : Number(r.resolved_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export const revealFlagView = (f: FlagRow) => ({ id: f.id, path: f.path, label: f.label, ownerId: f.owner_id, principal: f.principal, principalName: f.principal_name, ip: f.ip, signals: f.signals, reveals: f.reveals, state: f.state, resolvedBy: f.resolved_by, resolvedAt: f.resolved_at, note: f.note, createdAt: f.created_at, updatedAt: f.updated_at });

const principalKey = (c: VaultCaller): string => (c.actor.apiKey ? `key:${c.actor.apiKey}` : c.actor.user ? `user:${c.actor.user}` : c.actor.service ? `service:${c.actor.service}` : 'anonymous');
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export class RevealWatch {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(PRUNE_JOB, async () => this.prune());
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every(PRUNE_JOB, 3_600_000, async () => [{ tenantId: PLATFORM_TENANT, key: 'all' }]);
  }

  /** Records a reveal and raises (or adds to) a flag when it looks unusual. Never throws for the reveal's sake. */
  async observe(c: VaultCaller, secret: { id: string; path: string; label: Label; owner_id?: string | null; created_by: string | null }, version: number, now = Date.now()): Promise<Signal[]> {
    const s = this.s();
    const cfg = s.cfg;
    const ip = c.actor.ip ?? null;
    if (!cfg.VAULT_ANOMALY_BURST || !ip) return [];
    const db = this.db;
    const principal = principalKey(c);
    const hour = new Date(now).getUTCHours();
    const since = now - cfg.VAULT_ANOMALY_HISTORY_DAYS * 86_400_000;
    const history = db('vault_reveals').where({ secret_id: secret.id }).andWhere('at', '>=', since);
    const count = async (q: typeof history) => Number(((await q.count({ n: '*' }).first()) as { n: number | string } | undefined)?.n ?? 0);
    const signals: Signal[] = [];
    const total = await count(history.clone());
    if (total > 0 && !(await history.clone().where({ ip }).first('id'))) signals.push({ kind: 'new-address', detail: `First reveal from ${ip} in ${cfg.VAULT_ANOMALY_HISTORY_DAYS} days; the secret was revealed ${total} ${total === 1 ? 'time' : 'times'} from other addresses.`, at: now });
    if (total >= cfg.VAULT_ANOMALY_MIN_HISTORY && (await count(history.clone().where({ hour }))) === 0) signals.push({ kind: 'odd-hour', detail: `Revealed at ${hh(hour)} UTC; none of its last ${total} reveals were in that hour.`, at: now });
    await db('vault_reveals').insert({ id: ulid(), tenant_id: c.tenantId, secret_id: secret.id, version, principal, ip, via: c.actor.via?.slice(0, 60) ?? null, hour, at: now });
    const burst = await count(db('vault_reveals').where({ secret_id: secret.id, principal }).andWhere('at', '>', now - cfg.VAULT_ANOMALY_BURST_SECONDS * 1000));
    if (burst >= cfg.VAULT_ANOMALY_BURST) signals.push({ kind: 'burst', detail: `${burst} reveals by the same caller within ${cfg.VAULT_ANOMALY_BURST_SECONDS} s.`, at: now });

    const open = (await db('vault_reveal_flags').where({ secret_id: secret.id, principal, state: 'open' }).first()) as Record<string, unknown> | undefined;
    if (open) {
      const f = flagFrom(open);
      const fresh = signals.filter((x) => !f.signals.some((y) => y.kind === x.kind));
      await db('vault_reveal_flags').where({ id: f.id }).update({ reveals: f.reveals + 1, updated_at: now, ...(fresh.length ? { signals: JSON.stringify([...f.signals, ...fresh]) } : {}) });
      if (fresh.length) await this.raised(c, { ...f, signals: [...f.signals, ...fresh] }, fresh, false);
      return signals;
    }
    if (!signals.length) return signals;
    const f: FlagRow = { id: ulid(), tenant_id: c.tenantId, secret_id: secret.id, path: secret.path, label: secret.label, owner_id: secret.owner_id ?? secret.created_by, principal, principal_name: (c.actor.username ?? c.actor.name ?? c.actor.service ?? null)?.slice(0, 200) ?? null, ip, signals, reveals: 1, state: 'open', resolved_by: null, resolved_at: null, note: null, created_at: now, updated_at: now };
    await db('vault_reveal_flags').insert({ ...f, signals: JSON.stringify(f.signals) });
    await this.raised(c, f, signals, true);
    return signals;
  }

  private async raised(c: VaultCaller, f: FlagRow, fresh: Signal[], created: boolean): Promise<void> {
    const s = this.s();
    await s.audit.append({ tenantId: f.tenant_id, action: created ? 'vault.reveal.flagged' : 'vault.reveal.flag.updated', kind: 'system', actor: { service: 'vault', ...(c.actor.user ? { user: c.actor.user } : {}), ...(c.actor.ip ? { ip: c.actor.ip } : {}) }, target: { path: f.path, flag: f.id }, label: f.label, detail: { principal: f.principal, signals: fresh.map((x) => x.kind), reveals: f.reveals } });
    if (!f.owner_id) return;
    const words = fresh.map((x) => (x.kind === 'new-address' ? 'from a new address' : x.kind === 'odd-hour' ? 'at an unusual hour' : 'in a burst')).join(', ');
    await s.notifications.notify({ tenantId: f.tenant_id, userIds: [f.owner_id], kind: 'vault', title: `Unusual reveal of ${f.path}`, body: `${f.principal_name ?? f.principal} revealed it ${words}. Check it under Vault, Reveal flags; rotate the secret if you do not recognise it.`, route: `vault?tab=flags&flag=${f.id}`, label: f.label, email: true }).catch(() => undefined);
  }

  private mayResolve(p: Principal, f: FlagRow): boolean {
    return f.owner_id === p.userId || effectivePermissions(p).has('secrets:admin');
  }

  /** The caller's flags (secrets they own), or every flag for a vault administrator, within their clearance. */
  async list(p: Principal, state: FlagRow['state'] | 'all' = 'open') {
    const q = this.db('vault_reveal_flags').where({ tenant_id: p.tenantId });
    if (!effectivePermissions(p).has('secrets:admin')) q.andWhere({ owner_id: p.userId });
    if (state !== 'all') q.andWhere({ state });
    const rows = ((await q.orderBy('updated_at', 'desc').limit(500)) as Record<string, unknown>[]).map(flagFrom).filter((f) => clears(p.clearance, f.label));
    return rows.map(revealFlagView);
  }

  /** The reveals behind a flag: the principal's reveals of the secret since a day before the flag, newest first. */
  async detail(p: Principal, id: string) {
    const f = await this.visible(p, id);
    const reveals = (await this.db('vault_reveals').where({ secret_id: f.secret_id }).andWhere('at', '>=', f.created_at - 86_400_000).orderBy('at', 'desc').limit(100).select('principal', 'ip', 'hour', 'at', 'version')) as { principal: string; ip: string | null; hour: number; at: number | string; version: number }[];
    return { ...revealFlagView(f), recent: reveals.map((r) => ({ principal: r.principal, ip: r.ip, hour: Number(r.hour), at: Number(r.at), version: Number(r.version), flagged: r.principal === f.principal })) };
  }

  private async visible(p: Principal, id: string): Promise<FlagRow> {
    const r = await this.db('vault_reveal_flags').where({ tenant_id: p.tenantId, id }).first();
    const f = r ? flagFrom(r) : null;
    if (!f || !clears(p.clearance, f.label) || !this.mayResolve(p, f)) throw notFound('Reveal flag');
    return f;
  }

  async resolve(p: Principal, id: string, decision: 'expected' | 'suspicious', note: string | null, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const f = await this.visible(p, id);
    const t = Date.now();
    const n = await this.db('vault_reveal_flags').where({ id: f.id, state: 'open' }).update({ state: decision, resolved_by: p.userId, resolved_at: t, note: note?.slice(0, 500) ?? null, updated_at: t });
    if (!n) throw conflict(`The flag was already resolved as ${f.state}.`);
    await this.s().audit.append({ tenantId: f.tenant_id, action: 'vault.reveal.flag.resolved', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { path: f.path, flag: f.id }, label: f.label, detail: { decision, note: note ?? null, principal: f.principal, signals: f.signals.map((x) => x.kind) }, traceId: ctx.traceId ?? null });
    return revealFlagView({ ...f, state: decision, resolved_by: p.userId, resolved_at: t, note, updated_at: t });
  }

  /** Drops reveals older than VAULT_ANOMALY_HISTORY_DAYS. */
  async prune(): Promise<{ deleted: number }> {
    const deleted = await this.db('vault_reveals').where('at', '<', Date.now() - this.s().cfg.VAULT_ANOMALY_HISTORY_DAYS * 86_400_000).delete();
    return { deleted: Number(deleted) };
  }
}
