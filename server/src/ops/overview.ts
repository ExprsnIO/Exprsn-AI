import { createHash } from 'node:crypto';
import { actorFrom, isUniqueViolation, type AuditEvent } from '../audit/chain.js';
import { authorize, type Principal } from '../authz/policy.js';
import { clears } from '../authz/labels.js';
import { conflict } from '../http/problem.js';
import type { Services } from '../services.js';
import { certStatus } from './certs.js';
import { audit } from './common.js';
import { isPlatformAdmin } from './jobs-admin.js';

/*
 * 1.6.0 (B-4202): the Overview. Alerts are computed when asked, from the watches that already exist (the schema
 * handshake of every instance, the backup RPO watch, zone drift in the cluster, certificate expiry, the rate-limit
 * probe); none is stored. Acknowledging one (Q15) hides it for every administrator of the tenant and is audited
 * `platform.alert.acknowledged`; it changes nothing about the condition, and a new occurrence (a different key) shows
 * again. System admins (`platform:manage`) see the platform alerts, the instances and capacity; a tenant admin sees
 * their tenant's alerts (its own certificates expiring), counters, schedules and audit.
 */

export interface PlatformAlert {
  key: string;
  kind: 'schema' | 'instance' | 'rpo' | 'drift' | 'certs' | 'pki' | 'ratelimit';
  tone: 'danger' | 'warn';
  title: string;
  text: string;
  since: number;
  open: { route: string; params?: Record<string, string>; label: string } | { instance: string; label: string };
}

const WEEK = 7 * 24 * 3600_000;
const digest = (parts: string[]) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class PlatformOverview {
  constructor(private readonly s: () => Services) {}

  /** Every open alert the principal may see, acknowledged ones left out, newest first. */
  async alerts(p: Principal): Promise<PlatformAlert[]> {
    const s = this.s();
    const out: PlatformAlert[] = [];
    const now = Date.now();
    if (isPlatformAdmin(p)) {
      const instances = await s.instances.list();
      for (const i of instances) {
        if (i.state !== 'not answering' && i.schema.state === 'behind') {
          out.push({ key: `schema:${i.id}:${digest([i.schema.detail ?? ''])}`, kind: 'schema', tone: 'danger', title: `Instance ${i.id} is behind the schema`, text: `${i.schema.detail ?? 'The database has migrations this build does not know.'} It answers /readyz with 503 and claims no jobs until it runs the current build.`, since: i.startedAt, open: { instance: i.id, label: 'Open instance' } });
        } else if (i.state === 'not answering') {
          out.push({ key: `instance:${i.id}:${i.heartbeatAt}`, kind: 'instance', tone: 'warn', title: `Instance ${i.id} stopped reporting`, text: `Its last heartbeat was at ${new Date(i.heartbeatAt).toISOString()}. A clean shutdown removes an instance from this list; this one went away without one, or cannot reach the database.`, since: i.heartbeatAt, open: { instance: i.id, label: 'Open instance' } });
        }
      }
      const backup = await s.ops.backups.alert();
      if (backup && !backup.acknowledgedAt) {
        out.push({ key: `rpo:${backup.raisedAt}`, kind: 'rpo', tone: 'danger', title: 'The backup is past its RPO', text: `${backup.lastBackupAt ? `The last database backup finished at ${new Date(backup.lastBackupAt).toISOString()}` : 'There is no database backup yet'}; PLATFORM_BACKUP_RPO_MINUTES is ${s.cfg.PLATFORM_BACKUP_RPO_MINUTES}. The backup watch clears this when the next backup lands.`, since: backup.raisedAt, open: { route: 'platform', params: { tab: 'backups' }, label: 'Open backups' } });
      }
      const drift = (await s.db('zone_cluster_objects').whereIn('state', ['drift', 'missing']).orderBy('zone_id').select('zone_id', 'name', 'state', 'updated_at')) as { zone_id: string; name: string; state: string; updated_at: number | string }[];
      if (drift.length) {
        const zones = [...new Set(drift.map((d) => d.zone_id))];
        out.push({ key: `drift:${digest(drift.map((d) => `${d.zone_id}/${d.name}:${d.state}:${d.updated_at}`))}`, kind: 'drift', tone: 'warn', title: `Zone policy drift on ${zones.join(', ')} in-cluster`, text: `${drift.length} NetworkPolic${drift.length === 1 ? 'y differs from what was' : 'ies differ from what was'} applied (${drift.map((d) => `${d.name}: ${d.state}`).join('; ')}). Applying the zones puts ${drift.length === 1 ? 'it' : 'them'} right.`, since: Math.max(...drift.map((d) => Number(d.updated_at))), open: { route: 'zones', label: 'Open zones' } });
      }
      const certs = (await s.ops.certs.list()).map((c) => ({ c, st: certStatus(c, s.cfg.ACME_RENEW_DAYS, now) })).filter(({ c, st }) => (st.status === 'expiring' || st.status === 'expired') && c.not_after != null && c.not_after - now <= WEEK);
      if (certs.length) {
        out.push({ key: `certs:${digest(certs.map(({ c }) => `${c.id}:${c.not_after}`))}`, kind: 'certs', tone: 'warn', title: `${certs.length} platform certificate${certs.length === 1 ? ' expires' : 's expire'} within 7 days`, text: `${certs.map(({ c }) => `${c.name} (${day(c.not_after!)})`).join(', ')}. Renewal runs on the certificate sweep where auto-renew is on.`, since: Math.min(...certs.map(({ c }) => c.not_after! - WEEK)), open: { route: 'platform', params: { tab: 'certs' }, label: 'Open certificates' } });
      }
      const self = s.counters.health?.();
      const degraded = instances.filter((i) => i.state !== 'not answering' && i.runtime?.rateLimit?.degraded);
      const since = self?.degraded ? self.since : degraded.length ? Math.min(...degraded.map((i) => i.runtime.rateLimit.since ?? i.heartbeatAt)) : null;
      if (since != null) {
        out.push({ key: `ratelimit:${since}`, kind: 'ratelimit', tone: 'warn', title: 'Rate limits counting per instance', text: `Redis has not answered the rate-limit probe since ${new Date(since).toISOString()}${self?.detail ? ` (${self.detail})` : ''}. Each instance counts limits on its own until it does, so a client can send up to its allowance on every instance.`, since, open: { route: 'platform', label: 'Open platform' } });
      }
    }
    // The tenant's own certificates (the certificate authority, Sprint 24) expiring within a week.
    if (authorize(p, 'pki:manage').allow) {
      const pki = (await s.db('pki_certificates').where({ tenant_id: p.tenantId, state: 'valid' }).andWhere('not_after', '>', now).andWhere('not_after', '<=', now + WEEK).orderBy('not_after').limit(50).select('id', 'common_name', 'serial', 'not_after')) as { id: string; common_name: string | null; serial: string; not_after: number | string }[];
      if (pki.length) {
        out.push({ key: `pki:${digest(pki.map((c) => `${c.id}:${c.not_after}`))}`, kind: 'pki', tone: 'warn', title: `${pki.length} certificate${pki.length === 1 ? ' expires' : 's expire'} within 7 days`, text: `${pki.slice(0, 5).map((c) => `${c.common_name ?? c.serial} (${day(Number(c.not_after))})`).join(', ')}${pki.length > 5 ? ` and ${pki.length - 5} more` : ''}. The expiry sweep notifies their requesters; a renewal replaces them.`, since: Math.min(...pki.map((c) => Number(c.not_after) - WEEK)), open: { route: 'certificates', label: 'Open certificates' } });
      }
    }
    const acked = new Set(((await s.db('platform_alert_acks').where({ tenant_id: p.tenantId }).whereIn('alert_key', out.map((a) => a.key)).select('alert_key')) as { alert_key: string }[]).map((r) => r.alert_key));
    return out.filter((a) => !acked.has(a.key)).sort((a, b) => b.since - a.since);
  }

  /** Acknowledges open alerts for the whole tenant (Q15), in one audit event. */
  async acknowledge(p: Principal, keys: string[], ip: string | null, traceId?: string): Promise<PlatformAlert[]> {
    const s = this.s();
    const open = await this.alerts(p);
    const chosen = open.filter((a) => keys.includes(a.key));
    if (!chosen.length) throw conflict('None of those alerts is open.');
    const t = Date.now();
    for (const a of chosen) {
      try {
        await s.db('platform_alert_acks').insert({ tenant_id: p.tenantId, alert_key: a.key, acknowledged_by: p.userId, acknowledged_at: t });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    await audit(s, { tenantId: p.tenantId, actor: actorFrom(p, ip), userId: p.userId, traceId: traceId ?? null }, 'platform.alert.acknowledged', { alerts: chosen.map((a) => a.key) }, { titles: chosen.map((a) => a.title), kinds: chosen.map((a) => a.kind) }, 'admin');
    return open.filter((a) => !chosen.includes(a));
  }

  /** The counters for a window: jobs (every tenant for a system admin), flags, held replies, sign-ins and sockets. */
  async counters(p: Principal, windowMs: number) {
    const s = this.s();
    const platform = isPlatformAdmin(p);
    const now = Date.now();
    const since = now - windowMs;
    const jobs = () => (platform ? s.db('jobs') : s.db('jobs').where({ tenant_id: p.tenantId }));
    const n = (r: unknown) => Number((r as { n?: number | string } | undefined)?.n ?? 0);
    const [queued, running, failed, oldest, flags, overdue, held, signins, refused, workspaces] = await Promise.all([
      jobs().where({ state: 'queued' }).count({ n: '*' }).first(),
      jobs().where({ state: 'running' }).count({ n: '*' }).first(),
      jobs().where({ state: 'failed' }).andWhere('finished_at', '>=', since).count({ n: '*' }).first(),
      jobs().where({ state: 'queued' }).min({ n: 'created_at' }).first(),
      s.db('guard_flags').where({ tenant_id: p.tenantId, state: 'open' }).count({ n: '*' }).first(),
      s.db('guard_flags').where({ tenant_id: p.tenantId, state: 'open' }).andWhere('due_at', '<', now).count({ n: '*' }).first(),
      s.db('channel_messages').where({ tenant_id: p.tenantId, state: 'held' }).count({ n: '*' }).first(),
      // A sign-in completes as auth.login (password or upstream) or auth.mfa.verified (the second factor).
      s.db('audit_events').where({ tenant_id: p.tenantId }).whereIn('action', ['auth.login', 'auth.mfa.verified']).andWhere('ts', '>=', since).count({ n: '*' }).first(),
      s.db('audit_events').where({ tenant_id: p.tenantId, action: 'moderation.signin.refused' }).andWhere('ts', '>=', since).count({ n: '*' }).first(),
      s.db('workspaces').where({ tenant_id: p.tenantId }).count({ n: '*' }).first()
    ]);
    const oldestAt = (oldest as { n?: number | string | null } | undefined)?.n;
    const instances = platform ? (await s.instances.list()).filter((i) => i.state !== 'not answering') : [];
    return {
      jobsScope: platform ? 'all tenants' : 'your tenant',
      queued: n(queued), oldestQueuedAt: oldestAt == null ? null : Number(oldestAt), running: n(running), failed: n(failed),
      flags: { open: n(flags), overdue: n(overdue) }, heldReplies: n(held),
      signins: n(signins), refusedBySanction: n(refused), workspaces: n(workspaces),
      sockets: platform ? { total: instances.reduce((a, i) => a + i.sockets, 0), instances: instances.length } : null,
      runningOn: platform ? instances.filter((i) => i.jobsClaimed > 0).length : null
    };
  }

  /** The last audit events of the tenant, redacted above the reader's clearance; null without `audit:read`. */
  async recentAudit(p: Principal, limit = 8) {
    const s = this.s();
    if (!authorize(p, 'audit:read').allow) return null;
    const events = await s.audit.list(p.tenantId, { limit });
    const users = [...new Set(events.map((e) => e.actor?.user).filter((u): u is string => typeof u === 'string'))];
    const names = new Map(((users.length ? await s.db('users').whereIn('id', users).select('id', 'display_name') : []) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
    return events.map((e: AuditEvent) => {
      const visible = clears(p.clearance, e.label);
      const a = e.actor ?? {};
      const actor = typeof a.user === 'string' ? (names.get(a.user) ?? a.user) : typeof a.username === 'string' ? a.username : typeof a.service === 'string' ? a.service : 'system';
      const object = visible ? Object.entries(e.target ?? {}).filter(([, v]) => v != null && typeof v !== 'object').slice(0, 3).map(([k, v]) => `${k} ${String(v)}`).join(', ') : null;
      return { id: e.id, seq: e.seq, ts: e.ts, action: e.action, actor: visible ? actor : null, object, label: e.label, redacted: !visible };
    });
  }

  /** What the platform holds: database size and pool, vectors, blob store, the rate-limit store (system admins). */
  async capacity() {
    const s = this.s();
    const client = s.cfg.DB_CLIENT;
    let bytes: number | null;
    try {
      const q = client === 'pg' ? 'select pg_database_size(current_database()) as n' : client === 'mysql' ? 'select coalesce(sum(data_length + index_length), 0) as n from information_schema.tables where table_schema = database()' : 'select page_count * page_size as n from pragma_page_count(), pragma_page_size()';
      const r = (await s.db.raw(q)) as unknown;
      const row = client === 'pg' ? (r as { rows: { n: string | number }[] }).rows[0] : client === 'mysql' ? (r as [{ n: string | number }[]])[0][0] : (r as { n: string | number }[])[0];
      bytes = row?.n != null ? Number(row.n) : null;
    } catch {
      bytes = null;
    }
    const pool = (s.db.client as { pool?: { numUsed?: () => number; max?: number } }).pool;
    const vectors = Number(((await s.db('vectors').count({ n: '*' }).first()) as { n?: number | string } | undefined)?.n ?? 0);
    const blobs = await s.blobs.health();
    const rl = s.counters.health?.() ?? null;
    return {
      database: { client, bytes, pool: pool && typeof pool.numUsed === 'function' && pool.max ? { used: pool.numUsed(), max: pool.max } : null },
      vectors: { count: vectors, store: s.vectors.kind },
      blobs: { kind: s.blobs.kind, ok: blobs.ok },
      rateLimit: { kind: s.counters.kind, degraded: !!rl?.degraded, since: rl?.since ?? null },
      cache: { kind: s.cache.store.kind }
    };
  }
}
