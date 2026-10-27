/*
 * 1.9.99-final, Sprint 58 (B-10205): DigitalOcean App Platform for the DigitalOcean fake (`fake-do.ts` routes
 * `/v2/apps` here). Apps by id with their spec (SECRET values kept so a test can check where values went, and
 * answered encrypted as App Platform does), deployments that run the `PRE_DEPLOY` job first and settle ACTIVE after
 * `settleAfter` reads, or ERROR at the pre-deploy step when a test sets `migrationFails`. It is never the real API.
 */
import { randomUUID } from 'node:crypto';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';

export interface FakeApp {
  id: string;
  spec: Record<string, unknown>;
  default_ingress: string;
  active_deployment: { id: string; phase: string } | null;
  pending: string | null;
  created_at: string;
}

interface FakeAppDeployment { id: string; app: string; phase: string; reads: number; fails: boolean; jobs: string[] }

export class FakeDoApps {
  readonly apps = new Map<string, FakeApp>();
  readonly deployments = new Map<string, FakeAppDeployment>();
  /** The next deployments' PRE_DEPLOY migration fails. */
  migrationFails = false;

  constructor(private readonly settleAfter: () => number) {}

  private view(a: FakeApp): Record<string, unknown> {
    const enc = (spec: Record<string, unknown>) => JSON.parse(JSON.stringify(spec, (k, v) => (v && typeof v === 'object' && (v as { type?: string }).type === 'SECRET' ? { ...v, value: 'EV[1:encrypted]' } : v))) as Record<string, unknown>;
    return { id: a.id, spec: enc(a.spec), default_ingress: a.default_ingress, live_url: a.default_ingress, created_at: a.created_at, ...(a.active_deployment ? { active_deployment: a.active_deployment } : {}), ...(a.pending ? { pending_deployment: { id: a.pending, phase: this.deployments.get(a.pending)?.phase ?? 'PENDING_DEPLOY' } } : {}) };
  }

  private deploy(a: FakeApp): string {
    const jobs = ((a.spec.jobs as { name: string; kind: string }[] | undefined) ?? []).filter((j) => j.kind === 'PRE_DEPLOY').map((j) => j.name);
    const d: FakeAppDeployment = { id: randomUUID(), app: a.id, phase: 'PENDING_DEPLOY', reads: 0, fails: this.migrationFails && jobs.length > 0, jobs };
    this.deployments.set(d.id, d);
    a.pending = d.id;
    return d.id;
  }

  route(r: RecordedRequest, seg: string[], b: Record<string, unknown>): Reply {
    const id = seg[1];
    const unprocessable = (message: string): Reply => ({ status: 422, body: { id: 'unprocessable_entity', message } });
    if (!id) {
      if (r.method === 'GET') return { status: 200, body: { apps: [...this.apps.values()].map((a) => this.view(a)), links: {}, meta: { total: this.apps.size } } };
      if (r.method !== 'POST') return { status: 405, body: { id: 'method_not_allowed', message: 'Not allowed' } };
      const spec = b.spec as Record<string, unknown> | undefined;
      if (!spec?.name) return unprocessable('spec.name is required');
      if ([...this.apps.values()].some((a) => a.spec.name === spec.name)) return unprocessable(`An app named ${String(spec.name)} already exists.`);
      const a: FakeApp = { id: randomUUID(), spec, default_ingress: `https://${String(spec.name)}-abcde.ondigitalocean.app`, active_deployment: null, pending: null, created_at: new Date().toISOString() };
      this.apps.set(a.id, a);
      this.deploy(a);
      return { status: 200, body: { app: this.view(a) } };
    }
    const a = this.apps.get(id);
    if (!a) return { status: 404, body: { id: 'not_found', message: 'The resource you were accessing could not be found.' } };
    if (seg[2] === 'deployments' && seg[3]) {
      const d = this.deployments.get(seg[3]);
      if (!d || d.app !== a.id) return { status: 404, body: { id: 'not_found', message: 'Deployment not found.' } };
      d.reads += 1;
      if (d.phase === 'PENDING_DEPLOY' && d.reads > this.settleAfter()) {
        if (d.fails) {
          d.phase = 'ERROR';
          a.pending = null;
        } else {
          d.phase = 'ACTIVE';
          a.active_deployment = { id: d.id, phase: 'ACTIVE' };
          a.pending = null;
        }
      }
      return { status: 200, body: { deployment: { id: d.id, phase: d.phase, progress: { steps: [...d.jobs.map((j) => ({ name: `pre_deploy_${j}`, status: d.phase === 'ERROR' ? 'ERROR' : d.phase === 'ACTIVE' ? 'SUCCESS' : 'RUNNING', ...(d.phase === 'ERROR' ? { reason: { message: `job ${j} exited with code 1` } } : {}) })), { name: 'deploy', status: d.phase === 'ACTIVE' ? 'SUCCESS' : 'PENDING' }] } } } };
    }
    switch (r.method) {
      case 'GET':
        return { status: 200, body: { app: this.view(a) } };
      case 'PUT': {
        const spec = b.spec as Record<string, unknown> | undefined;
        if (!spec?.name) return unprocessable('spec.name is required');
        a.spec = spec;
        this.deploy(a);
        return { status: 200, body: { app: this.view(a) } };
      }
      case 'DELETE':
        this.apps.delete(a.id);
        return { status: 200, body: { id: a.id } };
    }
    return { status: 405, body: { id: 'method_not_allowed', message: 'Not allowed' } };
  }
}
