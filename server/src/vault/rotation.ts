import type { Label } from '../authz/labels.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { DAY_MS } from './service.js';

/*
 * Rotation schedules and expiry notices (B-1706). A KV secret or transit key with a rotation period is due when its
 * current version is older than the period. The `vault.rotation.check` job (every VAULT_ROTATION_CHECK_MINUTES, for
 * tenants that have schedules) sends its owner, or its creator when no owner is set, a notice:
 *
 *   due      the version falls due within VAULT_ROTATION_NOTICE_DAYS
 *   overdue  the version is past its rotation period
 *
 * each at most once per version (writing a new version, or rotating the key, starts the schedule again). A transit
 * key with `autoRotate` is rotated by the job when it falls due instead, and the owner is told. When the owner is no
 * longer an active user, the notice goes to the tenant admins. Notices carry paths and names, never values.
 */

type Stage = 'due' | 'overdue';
const RANK: Record<Stage, number> = { due: 1, overdue: 2 };

interface Due {
  table: 'vault_secrets' | 'vault_transit_keys';
  id: string;
  what: string;
  label: Label;
  version: number;
  rotatedAt: number;
  periodMs: number;
  owner: string | null;
  notice: Stage | null;
  noticeVersion: number | null;
  autoRotate: boolean;
}

const JOB = 'vault.rotation.check';

export class RotationNotices {
  constructor(
    private readonly s: () => Services,
    private readonly opts: { checkMinutes: number; noticeDays: number }
  ) {}

  registerJobs(): void {
    this.s().jobs.register(JOB, async (p, ctx) => {
      const out = await this.check(String(p.tenantId ?? ctx.job.tenant_id));
      await ctx.progress(100, `${out.notices} notices, ${out.rotated} keys rotated`);
      return out;
    });
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every(JOB, this.opts.checkMinutes * 60_000, async () => {
      const db = this.s().db;
      const a = (await db('vault_secrets').whereNotNull('rotation_period_ms').distinct('tenant_id')) as { tenant_id: string }[];
      const b = (await db('vault_transit_keys').whereNotNull('rotation_period_ms').distinct('tenant_id')) as { tenant_id: string }[];
      return [...new Set([...a, ...b].map((r) => r.tenant_id))].map((tenantId) => ({ tenantId, payload: { tenantId } }));
    });
  }

  /** Everything with a schedule in the tenant, with when its current version was made. */
  private async scheduled(tenantId: string): Promise<Due[]> {
    const db = this.s().db;
    const secrets = (await db('vault_secrets as s')
      .leftJoin('vault_secret_versions as v', (j) => j.on('v.secret_id', '=', 's.id').andOn('v.version', '=', 's.current_version'))
      .where('s.tenant_id', tenantId)
      .whereNotNull('s.rotation_period_ms')
      .select('s.id', 's.path', 's.label', 's.current_version', 's.created_at', 's.created_by', 's.owner_id', 's.rotation_period_ms', 's.rotation_notice', 's.rotation_notice_version', 'v.created_at as version_at')) as Record<string, unknown>[];
    const keys = (await db('vault_transit_keys as k')
      .leftJoin('vault_transit_versions as v', (j) => j.on('v.key_id', '=', 'k.id').andOn('v.version', '=', 'k.latest_version'))
      .where('k.tenant_id', tenantId)
      .whereNotNull('k.rotation_period_ms')
      .select('k.id', 'k.name', 'k.label', 'k.latest_version', 'k.created_at', 'k.created_by', 'k.owner_id', 'k.rotation_period_ms', 'k.auto_rotate', 'k.rotation_notice', 'k.rotation_notice_version', 'v.created_at as version_at')) as Record<string, unknown>[];
    const common = (r: Record<string, unknown>) => ({
      id: String(r.id),
      label: r.label as Label,
      rotatedAt: Number(r.version_at ?? r.created_at),
      periodMs: Number(r.rotation_period_ms),
      owner: (r.owner_id as string | null) ?? (r.created_by as string | null) ?? null,
      notice: (r.rotation_notice as Stage | null) ?? null,
      noticeVersion: r.rotation_notice_version == null ? null : Number(r.rotation_notice_version)
    });
    return [
      ...secrets.map((r) => ({ ...common(r), table: 'vault_secrets' as const, what: `secret ${String(r.path)}`, version: Number(r.current_version), autoRotate: false })),
      ...keys.map((r) => ({ ...common(r), table: 'vault_transit_keys' as const, what: `transit key ${String(r.name)}`, version: Number(r.latest_version), autoRotate: r.auto_rotate === true || r.auto_rotate === 1 || r.auto_rotate === '1' }))
    ];
  }

  private async recipients(tenantId: string, owner: string | null): Promise<string[]> {
    const s = this.s();
    if (owner) {
      const u = await s.users.get(tenantId, owner);
      if (u && u.state === 'active') return [u.id];
    }
    return s.notifications.usersWithRoles(tenantId, ['tenant-admin']);
  }

  async check(tenantId: string, now = Date.now()): Promise<{ checked: number; notices: number; rotated: number }> {
    const s = this.s();
    const items = await this.scheduled(tenantId);
    let notices = 0;
    let rotated = 0;
    for (const d of items) {
      const dueAt = d.rotatedAt + d.periodMs;
      const stage: Stage | null = now >= dueAt ? 'overdue' : now >= dueAt - this.opts.noticeDays * DAY_MS ? 'due' : null;
      if (!stage) continue;
      if (d.autoRotate && stage === 'overdue') {
        const r = await s.vault.autoRotateKey(tenantId, d.id);
        if (r) {
          rotated++;
          await s.notifications.notify({ tenantId, userIds: await this.recipients(tenantId, d.owner), kind: 'vault', title: `Transit key ${r.name} was rotated on schedule`, body: `Version ${r.to} is now used for new ciphertext and signatures; version ${r.from} still decrypts until the minimum decryption version passes it.`, label: d.label }).catch(() => undefined);
        }
        continue;
      }
      // Once per stage and version: a new version starts the schedule again.
      if (d.noticeVersion === d.version && d.notice && RANK[d.notice] >= RANK[stage]) continue;
      const claimed = await s.db(d.table).where({ id: d.id }).andWhere((q) => (d.noticeVersion == null ? q.whereNull('rotation_notice_version') : q.where('rotation_notice_version', d.noticeVersion))).andWhere((q) => (d.notice == null ? q.whereNull('rotation_notice') : q.where('rotation_notice', d.notice))).update({ rotation_notice: stage, rotation_notice_version: d.version, rotation_notified_at: now });
      if (!claimed) continue; // another instance sent it
      const days = Math.max(0, Math.ceil(Math.abs(dueAt - now) / DAY_MS));
      const title = stage === 'overdue' ? `Rotate ${d.what}: it is past its rotation period` : `Rotate ${d.what} within ${days} day${days === 1 ? '' : 's'}`;
      const body = stage === 'overdue' ? `Version ${d.version} was made ${new Date(d.rotatedAt).toISOString().slice(0, 10)} and was due for rotation ${new Date(dueAt).toISOString().slice(0, 10)}.` : `Version ${d.version} falls due for rotation on ${new Date(dueAt).toISOString().slice(0, 10)}.`;
      const userIds = await this.recipients(tenantId, d.owner);
      await s.notifications.notify({ tenantId, userIds, kind: 'vault', title, body, label: d.label, email: true });
      await s.audit.append({ tenantId, action: stage === 'overdue' ? 'vault.rotation.overdue' : 'vault.rotation.due', kind: 'system', actor: { service: 'vault.rotation' }, target: d.table === 'vault_secrets' ? { path: d.what.replace(/^secret /, '') } : { key: d.what.replace(/^transit key /, '') }, label: d.label, detail: { version: d.version, dueAt, notified: userIds.length } });
      notices++;
    }
    return { checked: items.length, notices, rotated };
  }
}
