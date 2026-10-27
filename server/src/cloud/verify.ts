import { isIPv4 } from 'node:net';
import { connect as tlsConnect, type PeerCertificate } from 'node:tls';
import { checkServiceHost, guardedRequest, serviceAddressProblem, servicePolicy, ServiceUrlRefused } from '../platform/egress.js';
import type { Services } from '../services.js';
import { cloudAudit, type CloudAuditActor } from './audit.js';
import type { Deployment, GraphResource, ObservedResource, ReadinessResult, VerifyReport } from './graph.js';
import { fieldChanges } from './planner.js';

/*
 * 1.9.99-final, Sprint 57 (B-10105): verify (`cloud.verify`, queued after every successful apply). Readiness per
 * resource (the provider reports it, it is ready, and it matches the desired spec) and for the deployment (the checks
 * below). A deployment is `ready` only when every resource and every check that applies passes; an `unknown` check
 * (the app's URL not known yet, a check that could not run) is not a pass, so a deployment whose app cannot reach its
 * database is never shown healthy. A failed verify marks the deployment `degraded` and offers rollback (the lifecycle
 * work's, B-10107); a passing one records each resource's state as the last verified one.
 *
 * Checks are `ReadinessCheck`s (`register` adds more): `app.readyz` reads the app's `/readyz` at its public URL
 * through the egress guard, and from its body `app.database` and `app.redis` (reachable from the app);
 * `tls.chain` checks the certificate chain and name of the public URL. Pool health arrives with B-104, and the
 * deployed app itself (so a public URL) with B-102.
 */

export interface VerifyOptions {
  timeoutMs: number;
  /** Extra trust anchors for the TLS check (tests: a local CA). */
  tlsCa?: string | Buffer | Array<string | Buffer>;
}

export interface CheckContext {
  s: Services;
  deployment: Deployment;
  resources: GraphResource[];
  observed: Map<string, ObservedResource | null>;
  options: VerifyOptions;
  signal?: AbortSignal;
}

export interface ReadinessCheck {
  id: string;
  applies(d: Deployment, resources: GraphResource[]): boolean;
  run(c: CheckContext): Promise<ReadinessResult[]>;
}

const result = (id: string, status: ReadinessResult['status'], detail: string): ReadinessResult => ({ id, key: null, status, detail });

/** The app's `/readyz` at its public URL; the database and Redis as the app reports them. */
export const readyzCheck: ReadinessCheck = {
  id: 'app.readyz',
  applies: (d) => !!d.endpoints.publicUrl || !!d.endpoints.app,
  async run(c) {
    const e = c.deployment.endpoints;
    if (!e.publicUrl) return [result('app.readyz', 'unknown', 'The app’s public URL is not known yet, so its readiness cannot be read.')];
    const policy = servicePolicy(c.s.cfg);
    const url = new URL('/readyz', e.publicUrl);
    let res;
    try {
      res = await guardedRequest({ method: 'GET', url, headers: { accept: 'application/json' }, timeoutMs: c.options.timeoutMs, maxBytes: 64 * 1024, ...(c.signal ? { signal: c.signal } : {}), check: (a, h) => serviceAddressProblem(a, h, policy) });
    } catch (err) {
      const why = err instanceof ServiceUrlRefused ? `refused: ${err.message}` : `unreachable: ${String((err as Error).message ?? err).slice(0, 200)}`;
      return [result('app.readyz', 'fail', `${url.origin}/readyz is ${why}`), result('app.database', 'unknown', 'Not reported: the app did not answer.'), ...(e.redis ? [result('app.redis', 'unknown', 'Not reported: the app did not answer.')] : [])];
    }
    let body: { status?: string; checks?: Record<string, string> };
    try {
      body = JSON.parse(res.body.toString('utf8'));
    } catch {
      body = {};
    }
    const checks = body.checks ?? {};
    const out = [res.status === 200 ? result('app.readyz', 'pass', `${url.origin}/readyz answered 200 (${body.status ?? 'ready'}).`) : result('app.readyz', 'fail', `${url.origin}/readyz answered ${res.status} (${body.status ?? 'not ready'}).`)];
    const db = checks.database ?? checks.db;
    out.push(db == null ? result('app.database', 'unknown', 'The app did not report its database.') : db === 'ok' ? result('app.database', 'pass', 'The app reaches its database.') : result('app.database', 'fail', `The app cannot reach its database (${db}).`));
    const redis = checks.redis;
    if (redis != null || e.redis) out.push(redis == null ? result('app.redis', 'unknown', 'The app did not report Redis.') : redis === 'ok' ? result('app.redis', 'pass', 'The app reaches Redis.') : result('app.redis', 'fail', `The app cannot reach Redis (${redis}).`));
    return out;
  }
};

/** The TLS chain of the public URL: trusted, valid now, and valid for the name. */
export const tlsCheck: ReadinessCheck = {
  id: 'tls.chain',
  applies: (d) => !!d.endpoints.publicUrl && d.endpoints.publicUrl.startsWith('https:'),
  async run(c) {
    const u = new URL(c.deployment.endpoints.publicUrl!);
    const name = c.deployment.endpoints.tlsName ?? u.hostname;
    let address: string;
    try {
      const addresses = (await checkServiceHost(u.hostname, servicePolicy(c.s.cfg))).addresses;
      address = addresses.find((a) => isIPv4(a)) ?? addresses[0]!;
    } catch (err) {
      return [result('tls.chain', 'fail', `The address of ${u.hostname} is refused: ${(err as Error).message}`)];
    }
    const port = Number(u.port || 443);
    return new Promise<ReadinessResult[]>((resolve) => {
      const sock = tlsConnect({ host: address, port, servername: name, rejectUnauthorized: false, ...(c.options.tlsCa ? { ca: c.options.tlsCa } : {}), timeout: c.options.timeoutMs });
      const done = (r: ReadinessResult) => {
        sock.destroy();
        resolve([r]);
      };
      sock.once('secureConnect', () => {
        const cert = sock.getPeerCertificate(true) as PeerCertificate;
        if (!sock.authorized) return done(result('tls.chain', 'fail', `The certificate chain for ${name} is not trusted (${String(sock.authorizationError)}).`));
        const now = Date.now();
        if (cert.valid_to && Date.parse(cert.valid_to) < now) return done(result('tls.chain', 'fail', `The certificate for ${name} expired on ${cert.valid_to}.`));
        const days = cert.valid_to ? Math.floor((Date.parse(cert.valid_to) - now) / 86_400_000) : null;
        done(result('tls.chain', 'pass', `The certificate chain for ${name} is trusted${days != null ? `, valid for ${days} more days` : ''}.`));
      });
      sock.once('timeout', () => done(result('tls.chain', 'fail', `No TLS answer from ${u.host} in time.`)));
      sock.once('error', (err) => done(result('tls.chain', 'fail', `TLS to ${u.host} failed: ${err.message}`)));
    });
  }
};

export class CloudVerify {
  readonly checks: ReadinessCheck[] = [readyzCheck, tlsCheck];
  options: VerifyOptions = { timeoutMs: 10_000 };

  constructor(private readonly s: () => Services) {}

  /** Adds a check (pool health with B-104, the lifecycle work's own). */
  register(check: ReadinessCheck): void {
    const i = this.checks.findIndex((c) => c.id === check.id);
    if (i >= 0) this.checks.splice(i, 1, check);
    else this.checks.push(check);
  }

  /** Readiness of each resource: reported, ready, and as desired. */
  static resourceResults(resources: GraphResource[], observed: Map<string, ObservedResource | null>): ReadinessResult[] {
    return resources.map((r) => {
      const at = (status: ReadinessResult['status'], detail: string): ReadinessResult => ({ id: 'resource', key: r.key, status, detail });
      if (!r.providerId) return at('fail', 'Not created.');
      const o = observed.has(r.key) ? (observed.get(r.key) ?? null) : r.observed;
      if (!o) return at('fail', `${r.providerId} is missing at the provider.`);
      if (o.state !== 'ready') return at('fail', `${r.providerId} is ${o.state}.`);
      const changes = fieldChanges(r.desired, r.desired.region ?? r.region, r, o);
      if (changes.length) return at('fail', `It differs from the desired spec: ${changes.map((c) => c.path).join(', ')}.`);
      return at('pass', `${r.providerId} is ready.`);
    });
  }

  async run(deploymentId: string, run: { jobId?: string | null; onBehalfOf?: string | null; signal?: AbortSignal } = {}): Promise<VerifyReport> {
    const s = this.s();
    const deployments = s.cloud.deployments;
    const d = await deployments.get(deploymentId);
    if (!d) throw new Error('no such deployment');
    const at = Date.now();
    const actor: CloudAuditActor = { service: 'cloud.verify', onBehalfOf: run.onBehalfOf ?? null, jobId: run.jobId ?? null };
    if (deployments.leaseOf(d)?.holder && !deployments.leaseOf(d)!.holder.startsWith('poll:')) {
      return { at, ok: false, resources: [], checks: [result('apply', 'unknown', 'An apply is running; verify after it.')], rollback: { offered: false, reason: null } };
    }
    const context = await deployments.context(d, 'read');
    const refresh = await deployments.refresh(d, { context, ...(run.signal ? { signal: run.signal } : {}) });
    const resources = await deployments.resources(d.id);
    const resourceResults = CloudVerify.resourceResults(resources, refresh.observed);
    const ctx: CheckContext = { s, deployment: d, resources, observed: refresh.observed, options: this.options, ...(run.signal ? { signal: run.signal } : {}) };
    const checks: ReadinessResult[] = [];
    for (const c of this.checks) {
      if (!c.applies(d, resources)) continue;
      try {
        checks.push(...(await c.run(ctx)));
      } catch (err) {
        checks.push(result(c.id, 'unknown', `The check could not run: ${String((err as Error).message ?? err).slice(0, 200)}`));
      }
    }
    const ok = resourceResults.every((r) => r.status === 'pass') && checks.every((c) => c.status === 'pass' || c.status === 'skipped');
    const applied = await s.db('cloud_plans').where({ deployment_id: d.id, state: 'applied' }).first('id');
    const report: VerifyReport = {
      at,
      ok,
      resources: resourceResults,
      checks,
      rollback: ok ? { offered: false, reason: null } : { offered: !!applied, reason: applied ? 'Verify failed after an apply: roll back to the last verified state, or fix and apply again.' : null }
    };
    const settle = ['applied', 'ready', 'degraded'].includes(d.state);
    if (ok) {
      await deployments.markVerified(d.id, at);
      await deployments.setState(d.id, settle ? 'ready' : d.state, { health: 'healthy', verify: report });
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.verify.passed', actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { resources: resourceResults.length, checks: checks.map((c) => `${c.id}:${c.status}`) } });
      if (settle && d.state !== 'ready') await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.deployment.ready', actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: {} });
    } else {
      await deployments.setState(d.id, settle ? 'degraded' : d.state, { health: 'degraded', verify: report });
      const failing = [...resourceResults, ...checks].filter((r) => r.status === 'fail' || r.status === 'unknown').map((r) => `${r.key ?? r.id}: ${r.detail}`);
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.verify.failed', actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { failing: failing.slice(0, 20), rollbackOffered: report.rollback.offered } });
      if (settle && d.state !== 'degraded') await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.deployment.degraded', actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { failing: failing.slice(0, 20), rollbackOffered: report.rollback.offered } });
    }
    return report;
  }
}
