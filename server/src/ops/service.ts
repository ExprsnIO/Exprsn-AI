import type { Services } from '../services.js';
import type { Scheduler } from '../platform/jobs.js';
import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import { notFound } from '../http/problem.js';
import { BundleService } from './bundles.js';
import { MirrorService } from './mirrors.js';
import { CertificateService } from './certs.js';
import { BackupService } from './backups.js';
import { audit, platformTenant, systemActor, type OpsActor } from './common.js';

type Tenants = () => Promise<{ tenantId: string; payload: Record<string, unknown> }[]>;

const FILE_SECRETS = ['SESSION_SECRET', 'DATA_KEY', 'DATABASE_URL', 'METRICS_TOKEN', 'OPENBAO_TOKEN', 'REDIS_URL', 'SMTP_URL', 'S3_SECRET_ACCESS_KEY', 'SIEM_TOKEN'] as const;

/** Sprint 9: signed import bundles, mirrors, ACME certificates, backups and restore drills. Reads its collaborators through `s` so later replacements (tests, overrides) are used. */
export class OpsService {
  readonly bundles: BundleService;
  readonly mirrors: MirrorService;
  readonly certs: CertificateService;
  readonly backups: BackupService;

  constructor(private readonly s: () => Services) {
    // `s` is not assigned until every service is built, so nothing here reads it yet.
    this.bundles = new BundleService(s);
    this.mirrors = new MirrorService(s);
    this.certs = new CertificateService(s);
    this.backups = new BackupService(s);
  }

  /** Who a job's changes are recorded against: the person who started it, in the job's tenant. */
  private jobActor(tenantId: string, createdBy: string | null): OpsActor {
    return systemActor(tenantId, createdBy);
  }

  /** Registers this area's job handlers on `s.jobs`. */
  registerJobs(): void {
    const jobs = this.s().jobs;
    jobs.register('ops.bundle.verify', async (p, ctx) => this.bundles.runVerify(String(p.bundleId), this.jobActor(ctx.job.tenant_id, ctx.job.created_by), ctx.progress, ctx.signal), { timeoutMs: 6 * 3_600_000 });
    jobs.register('ops.bundle.promote', async (p, ctx) => this.bundles.runPromote(String(p.bundleId), this.jobActor(ctx.job.tenant_id, ctx.job.created_by), ctx.progress), { timeoutMs: 6 * 3_600_000 });
    jobs.register('ops.mirror.check', async (p, ctx) => this.mirrors.check(Array.isArray(p.mirrorIds) ? p.mirrorIds.map(String) : null, ctx.progress, ctx.signal));
    jobs.register('ops.cert.issue', async (p, ctx) => this.certs.runIssue(String(p.certId), this.jobActor(ctx.job.tenant_id, ctx.job.created_by), ctx.progress, ctx.signal), { timeoutMs: 20 * 60_000 });
    jobs.register('ops.cert.sweep', async (_p, ctx) => {
      await this.s().db('platform_acme_challenges').where('expires_at', '<', Date.now()).delete();
      return this.certs.sweep(this.jobActor(ctx.job.tenant_id, ctx.job.created_by));
    });
    jobs.register('ops.backup.create', async (p, ctx) => {
      const by = this.jobActor(ctx.job.tenant_id, ctx.job.created_by);
      // Scheduled runs create their row here; requested ones already have it.
      const id = p.backupId ? String(p.backupId) : (await this.backups.request(by, 'scheduled').catch(() => null))?.id;
      if (!id) return { skipped: 'A backup is already running.' };
      if (!p.backupId) return { queued: id };
      const m = await this.backups.run(id, by, ctx.progress);
      return { backup: id, tables: m.tables.length, rows: m.totalRows };
    }, { timeoutMs: 6 * 3_600_000 });
    jobs.register('ops.backup.drill', async (p, ctx) => {
      const by = this.jobActor(ctx.job.tenant_id, ctx.job.created_by);
      if (!p.drillId) {
        const d = await this.backups.requestDrill(by, null, 'scheduled').catch(() => null);
        return d ? { queued: d.id } : { skipped: 'No backup to restore, or a drill is already running.' };
      }
      const d = await this.backups.runDrill(String(p.drillId), by, ctx.progress);
      return { drill: d.id, state: d.state, rpoMs: d.rpo_ms, rtoMs: d.rto_ms };
    }, { timeoutMs: 12 * 3_600_000 });
    jobs.register('ops.backup.watch', async (_p, ctx) => this.backups.watch(this.jobActor(ctx.job.tenant_id, null)));
  }

  /** Adds this area's recurring schedules. Platform work runs once per bucket, recorded in the default tenant. */
  schedule(scheduler: Scheduler, _activeTenants: Tenants): void {
    const cfg = this.s().cfg;
    const once = async () => {
      const t = await platformTenant(this.s());
      return t ? [{ tenantId: t, payload: {}, key: 'platform' }] : [];
    };
    scheduler.every('ops.backup.create', cfg.PLATFORM_BACKUP_MINUTES * 60_000, once);
    scheduler.every('ops.backup.drill', cfg.PLATFORM_DRILL_MINUTES * 60_000, once);
    scheduler.every('ops.backup.watch', 15 * 60_000, once);
    scheduler.every('ops.mirror.check', cfg.PLATFORM_MIRROR_CHECK_MINUTES * 60_000, once);
    scheduler.every('ops.cert.sweep', cfg.ACME_CHECK_MINUTES * 60_000, once);
  }

  /** Data keys by scope (the platform's and each tenant's), for the secrets health view. */
  async dataKeys(): Promise<{ scope: string; name: string; tenant: string | null; kms: string; version: number; rotatedAt: number; nextRotation: number; versions: number; state: string }[]> {
    const s = this.s();
    const rows = (await s.db('tenant_keys').select('tenant_id', 'version', 'kms', 'key_name', 'state', 'created_at').orderBy('version', 'desc')) as { tenant_id: string; version: number; kms: string; key_name: string; state: string; created_at: number }[];
    const tenants = new Map((await s.tenants.list()).map((t) => [t.id, t.name]));
    const byScope = new Map<string, typeof rows>();
    for (const r of rows) byScope.set(r.tenant_id, [...(byScope.get(r.tenant_id) ?? []), r]);
    const period = s.cfg.PLATFORM_KEY_ROTATION_DAYS * 86_400_000;
    return [...byScope.entries()].map(([scope, list]) => {
      const top = list[0]!;
      return { scope, name: top.key_name, tenant: scope === PLATFORM_SCOPE ? null : tenants.get(scope) ?? scope, kms: top.kms, version: Number(top.version), rotatedAt: Number(top.created_at), nextRotation: Number(top.created_at) + period, versions: list.length, state: top.state };
    }).sort((a, b) => (a.scope === PLATFORM_SCOPE ? -1 : b.scope === PLATFORM_SCOPE ? 1 : a.name.localeCompare(b.name)));
  }

  async rotateKey(by: OpsActor, scope: string): Promise<{ version: number }> {
    const s = this.s();
    const known = await s.db('tenant_keys').where({ tenant_id: scope }).first();
    if (!known) throw notFound('Data key');
    const r = await s.keys.rotate(scope);
    await audit(s, by, 'kms.key.rotated', { key: s.keys.kekName(scope), scope }, r, 'admin');
    return r;
  }

  /** The header strip and health checks. */
  async summary(): Promise<Record<string, unknown>> {
    const s = this.s();
    const [kms, blobs, skew] = await Promise.all([s.kms.health(), s.blobs.health(), this.clockSkew()]);
    return {
      kms: { kind: s.kms.kind, ...kms },
      blobs: { kind: s.blobs.kind, ...blobs },
      clock: skew,
      secretsFromFiles: FILE_SECRETS.filter((n) => process.env[n] || process.env[`${n}_FILE`]).map((n) => ({ name: n, file: !!process.env[`${n}_FILE`] })),
      scanner: this.bundles.scanner?.name ?? null,
      staging: this.bundles.staging?.name ?? null,
      licenceAllow: s.cfg.PLATFORM_LICENCE_ALLOW.split(',').map((x) => x.trim()).filter(Boolean),
      scanFailSeverity: s.cfg.PLATFORM_SCAN_FAIL_SEVERITY,
      bundleMaxBytes: s.cfg.PLATFORM_BUNDLE_MAX_BYTES,
      acme: { ...(await this.certs.accountView()), renewDays: s.cfg.ACME_RENEW_DAYS, checkMinutes: s.cfg.ACME_CHECK_MINUTES },
      backup: {
        everyMinutes: s.cfg.PLATFORM_BACKUP_MINUTES,
        retain: s.cfg.PLATFORM_BACKUP_RETAIN,
        rpoMinutes: s.cfg.PLATFORM_BACKUP_RPO_MINUTES,
        rtoMinutes: s.cfg.PLATFORM_BACKUP_RTO_MINUTES,
        drillEveryMinutes: s.cfg.PLATFORM_DRILL_MINUTES,
        dbClient: s.cfg.DB_CLIENT,
        alert: await this.backups.alert()
      },
      keyRotationDays: s.cfg.PLATFORM_KEY_ROTATION_DAYS
    };
  }

  /** The difference between this server's clock and the database server's, as a cheap cross-host time check. */
  async clockSkew(): Promise<{ skewMs: number | null; against: string }> {
    const s = this.s();
    const sql = s.cfg.DB_CLIENT === 'pg' ? 'SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS t' : s.cfg.DB_CLIENT === 'mysql' ? 'SELECT CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS UNSIGNED) AS t' : "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS t";
    try {
      const before = Date.now();
      const r = await s.db.raw(sql);
      const after = Date.now();
      const row = s.cfg.DB_CLIENT === 'pg' ? r.rows[0] : s.cfg.DB_CLIENT === 'mysql' ? r[0][0] : r[0];
      return { skewMs: Math.abs(Number(row.t) - (before + after) / 2), against: s.cfg.DB_CLIENT === 'sqlite' ? 'the database (same host)' : 'the database server' };
    } catch {
      return { skewMs: null, against: 'the database server' };
    }
  }
}

