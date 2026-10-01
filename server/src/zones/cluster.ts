import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { Services } from '../services.js';
import type { Scheduler } from '../platform/jobs.js';
import { audit, notifyAdmins, platformTenant, systemActor, type OpsActor } from '../ops/common.js';
import { firstDifference, KubeError, kubeFromConfig, type KubeClient, type KubeObject } from './kube.js';
import { ZONES_CHANGED } from './service.js';

/*
 * B-1405: zones applied in-cluster. With ZONES_APPLY=kubernetes, the NetworkPolicy rendered for each zone's current
 * version (the text shown in the Zones diff) is applied through the Kubernetes API with server-side apply whenever a
 * zone changes, and a drift check compares the live objects with what was applied: a policy edited or deleted by hand
 * is reported (audited, system admins notified) until the next apply puts it back. Namespaces are not created: the
 * chart's RBAC covers networkpolicies only, so a missing namespace is reported as an apply error.
 */

export type ClusterState = 'pending' | 'applied' | 'drift' | 'missing' | 'error';

export interface ClusterObjectRow {
  namespace: string;
  kind: string;
  name: string;
  zone_id: string;
  zone_version: number;
  desired_hash: string;
  state: ClusterState;
  detail: string | null;
  applied_at: number | null;
  checked_at: number | null;
  updated_at: number;
}

export interface DesiredObject {
  zoneId: string;
  version: number;
  object: KubeObject;
  hash: string;
}

const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v));

/** What is compared for drift: the identity, the labels this server sets, and the spec. */
const comparable = (o: KubeObject) => ({ metadata: { name: o.metadata.name, namespace: o.metadata.namespace, labels: o.metadata.labels ?? {} }, spec: o.spec });

/** The NetworkPolicy objects in a zone's rendered YAML (the Namespace document is skipped). */
export function policiesFrom(text: string): KubeObject[] {
  return YAML.parseAllDocuments(text)
    .map((d) => d.toJS() as KubeObject | null)
    .filter((o): o is KubeObject => !!o && typeof o === 'object' && o.kind === 'NetworkPolicy' && !!o.metadata?.name && !!o.metadata.namespace);
}

export class ZoneCluster {
  /** Tests replace the client (a fake API server). */
  client: KubeClient | null = null;

  constructor(private readonly s: () => Services) {}

  get enabled(): boolean {
    return this.s().cfg.ZONES_APPLY === 'kubernetes';
  }

  private kube(): KubeClient {
    this.client ??= kubeFromConfig(this.s().cfg);
    return this.client;
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('zones.cluster.apply', async (_p, ctx) => {
      const r = await this.apply(systemActor(ctx.job.tenant_id, ctx.job.created_by));
      await ctx.progress(100, `${r.applied} applied, ${r.failed} failed`);
      return r;
    });
    s.jobs.register('zones.cluster.drift', async (_p, ctx) => {
      const r = await this.check(systemActor(ctx.job.tenant_id, ctx.job.created_by));
      await ctx.progress(100, `${r.drift} drifted, ${r.missing} missing`);
      return r;
    });
    // A zone change on any instance queues one apply (the dedupe key is the rendered set and the minute).
    s.bus.on(ZONES_CHANGED, async () => {
      if (!this.enabled) return;
      const tenantId = await platformTenant(s);
      if (!tenantId) return;
      const set = await this.desired();
      const key = createHash('sha256').update(set.map((d) => d.hash).join(',')).digest('hex').slice(0, 32);
      await s.jobs.enqueue({ tenantId, type: 'zones.cluster.apply', dedupeKey: `zones.cluster.apply:${key}:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 3 });
    });
  }

  schedule(scheduler: Scheduler): void {
    const s = this.s();
    if (!this.enabled) return;
    scheduler.every('zones.cluster.drift', s.cfg.ZONES_APPLY_DRIFT_MINUTES * 60_000, async () => {
      const t = await platformTenant(s);
      return t ? [{ tenantId: t, key: 'platform' }] : [];
    });
  }

  /** The NetworkPolicies of every zone's current version, as rendered. */
  async desired(): Promise<DesiredObject[]> {
    const zones = this.s().zones;
    const out: DesiredObject[] = [];
    for (const [id, z] of [...(await zones.current())].sort(([a], [b]) => a.localeCompare(b))) {
      const { text } = await zones.rendered('networkpolicy', id);
      for (const object of policiesFrom(text)) out.push({ zoneId: id, version: z.version, object, hash: createHash('sha256').update(canonical(comparable(object))).digest('hex') });
    }
    return out;
  }

  async status(): Promise<ClusterObjectRow[]> {
    return (await this.s().db('zone_cluster_objects').orderBy([{ column: 'zone_id' }, { column: 'name' }])) as ClusterObjectRow[];
  }

  private async save(d: DesiredObject, patch: Partial<ClusterObjectRow>): Promise<void> {
    const db = this.s().db;
    const key = { namespace: d.object.metadata.namespace!, kind: d.object.kind, name: d.object.metadata.name };
    const t = Date.now();
    const n = await db('zone_cluster_objects').where(key).update({ zone_id: d.zoneId, zone_version: d.version, desired_hash: d.hash, ...patch, updated_at: t });
    if (!n) await db('zone_cluster_objects').insert({ ...key, zone_id: d.zoneId, zone_version: d.version, desired_hash: d.hash, state: 'pending', detail: null, applied_at: null, checked_at: null, ...patch, updated_at: t });
  }

  /** Applies every zone's NetworkPolicy. Each object succeeds or fails on its own. */
  async apply(by: OpsActor): Promise<{ applied: number; failed: number; objects: { zone: string; namespace: string; name: string; state: ClusterState; detail: string | null }[] }> {
    const s = this.s();
    if (!this.enabled) throw new KubeError('Zones are not applied in-cluster (ZONES_APPLY is off).', null);
    const objects: { zone: string; namespace: string; name: string; state: ClusterState; detail: string | null }[] = [];
    for (const d of await this.desired()) {
      try {
        await this.kube().apply(d.object);
        await this.save(d, { state: 'applied', detail: null, applied_at: Date.now(), checked_at: Date.now() });
        objects.push({ zone: d.zoneId, namespace: d.object.metadata.namespace!, name: d.object.metadata.name, state: 'applied', detail: null });
      } catch (err) {
        const detail = (err as Error).message.slice(0, 1000);
        await this.save(d, { state: 'error', detail, checked_at: Date.now() });
        objects.push({ zone: d.zoneId, namespace: d.object.metadata.namespace!, name: d.object.metadata.name, state: 'error', detail });
      }
    }
    const applied = objects.filter((o) => o.state === 'applied').length;
    const failed = objects.length - applied;
    await audit(s, by, 'zone.cluster.applied', { cluster: 'kubernetes' }, { applied, failed, objects: objects.slice(0, 100) });
    if (failed) await notifyAdmins(s, { kind: 'zones', title: `${failed} zone ${failed === 1 ? 'policy' : 'policies'} could not be applied`, body: objects.find((o) => o.state === 'error')?.detail ?? undefined });
    return { applied, failed, objects };
  }

  /**
   * Compares each live NetworkPolicy with what was rendered. A difference or a missing object is drift: audited and
   * notified when first seen, and kept on the row until an apply clears it.
   */
  async check(by: OpsActor): Promise<{ checked: number; drift: number; missing: number; errors: number; objects: { zone: string; namespace: string; name: string; state: ClusterState; detail: string | null }[] }> {
    const s = this.s();
    if (!this.enabled) throw new KubeError('Zones are not applied in-cluster (ZONES_APPLY is off).', null);
    const before = new Map((await this.status()).map((r) => [`${r.namespace}/${r.kind}/${r.name}`, r]));
    const objects: { zone: string; namespace: string; name: string; state: ClusterState; detail: string | null }[] = [];
    const fresh: typeof objects = [];
    for (const d of await this.desired()) {
      const ns = d.object.metadata.namespace!;
      const prev = before.get(`${ns}/${d.object.kind}/${d.object.metadata.name}`);
      let state: ClusterState;
      let detail: string | null;
      if (!prev || prev.desired_hash !== d.hash || prev.applied_at == null) {
        // Not applied in this form yet: that is pending work for the next apply, not drift.
        state = 'pending';
        detail = 'The current zone version has not been applied yet.';
      } else {
        try {
          const live = await this.kube().get(d.object.kind, ns, d.object.metadata.name);
          if (!live) {
            state = 'missing';
            detail = 'The NetworkPolicy was deleted from the cluster.';
          } else {
            const diff = firstDifference(comparable(d.object), comparable(live));
            state = diff ? 'drift' : 'applied';
            detail = diff ? `Changed in the cluster at ${diff}.` : null;
          }
        } catch (err) {
          state = 'error';
          detail = (err as Error).message.slice(0, 1000);
        }
      }
      await this.save(d, { state, detail, checked_at: Date.now() });
      const o = { zone: d.zoneId, namespace: ns, name: d.object.metadata.name, state, detail };
      objects.push(o);
      if ((state === 'drift' || state === 'missing') && prev?.state !== state) fresh.push(o);
    }
    if (fresh.length) {
      await audit(s, by, 'zone.cluster.drift', { cluster: 'kubernetes' }, { objects: fresh });
      await notifyAdmins(s, { kind: 'zones', title: `${fresh.length} zone ${fresh.length === 1 ? 'policy has' : 'policies have'} drifted in the cluster`, body: fresh.map((o) => `${o.namespace}/${o.name}: ${o.detail}`).join(' ').slice(0, 500) });
    }
    return { checked: objects.length, drift: objects.filter((o) => o.state === 'drift').length, missing: objects.filter((o) => o.state === 'missing').length, errors: objects.filter((o) => o.state === 'error').length, objects };
  }
}
