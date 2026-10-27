import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deployment } from '../src/cloud/graph.js';
import type { ResourceSpec } from '../src/cloud/providers/types.js';
import { cloudTags } from '../src/cloud/tags.js';
import { DIGEST_A, DIGEST_B, deployed, drain, kubeSpec, kubeWorld, REPO, type KubeWorld } from './cloud-kubernetes-helpers.js';

/*
 * 1.9.99-final, Sprint 58 (B-10207): upgrades of a Kubernetes deployment by image digest, on the DigitalOcean fake and
 * its fake cluster. An upgrade is planned (refused before anything changes when it cannot go ahead), approved by its
 * plan's hash, and then: the database snapshot first, `migrate --check` with the new image as a Job, the rolling
 * update (`helm upgrade`), verify; when verify fails the app tier goes back to the previous image by itself, and the
 * database rolls back only by restoring its snapshot, which one cloud admin asks for and another approves.
 *
 * Since Sprint 59 (B-10307) the managed database is a real DigitalOcean Managed PostgreSQL cluster on the fake, made
 * through the adapter: the upgrade's snapshot is the adapter's own (a restore point inside DigitalOcean's
 * point-in-time window), and the approved restore forks a new cluster from it, which joins the graph beside the old one.
 */

const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const DIGEST_D = `sha256:${'d'.repeat(64)}`;

let w: KubeWorld;
let d: Deployment;
let dbId = '';
/** The managed PostgreSQL clusters in the DigitalOcean fake. */
const pgClusters = () => [...w.do.dbs.clusters.values()].filter((c) => c.engine === 'pg');

const api = (who: KubeWorld['alice']) => ({
  post: (path: string, body: object = {}) => who.client.agent.post(path).set('x-csrf-token', who.client.csrf).send(body),
  get: (path: string) => who.client.agent.get(path)
});
const U = (id: string) => `/api/admin/cloud/deployments/${id}`;

/** Plans an upgrade over the API, applies it by its hash and drains. */
async function upgrade(image: string, extra: object = {}) {
  const planned = await api(w.alice).post(`${U(d.id)}/upgrades`, { image, ...extra });
  expect(planned.status, JSON.stringify(planned.body)).toBe(201);
  const applied = await api(w.alice).post(`${U(d.id)}/upgrades/${planned.body.upgrade.id}/apply`, { hash: planned.body.plan.hash });
  expect(applied.status, JSON.stringify(applied.body)).toBe(202);
  await drain(w);
  return (await w.h.s.cloud.releases.upgrades.get(planned.body.upgrade.id))!;
}

beforeAll(async () => {
  w = await kubeWorld();
  d = await deployed(w, kubeSpec(w, 'digitalocean', 'up-lab'));
  expect(d.state).toBe('ready');
  // The managed database (B-10301): a DigitalOcean Managed PostgreSQL cluster in the deployment's VPC, made through the adapter.
  const vpc = (await w.h.s.cloud.deployments.resources(d.id)).find((r) => r.type === 'network')!;
  const c = await w.h.s.cloud.deployments.context(d, 'deploy');
  const props = { engine: 'postgres', version: '17', size: 'db-s-2vcpu-4gb', publicAccess: false, privateEndpoint: true } as const;
  const spec: ResourceSpec = { type: 'database', name: 'up-lab-db', idempotencyKey: 'up-lab-db-create', tags: cloudTags({ account: c.account.name, deployment: d.name }), region: 'fra1', parent: { networkId: vpc.providerId! }, props };
  const made = await c.provider.create(c.ctx('fra1'), spec);
  let observed = made.resource ?? null;
  if (!made.done) for (let i = 0; i < 20; i++) {
    const r = await c.provider.poll(c.ctx('fra1'), made.operation);
    if (r.state === 'succeeded') {
      observed = r.resource;
      break;
    }
  }
  expect(observed).toMatchObject({ type: 'database', state: 'ready', props: { deletionProtection: true, publicAccess: false } });
  dbId = observed!.providerId;
  const db = { key: 'db', type: 'database' as const, spec: props, dependsOn: [], network: vpc.key, protect: true, region: null };
  await w.h.s.cloud.deployments.upsertResource(d.id, db, 'fra1', { providerId: dbId, observed, state: 'ready' });
}, 300_000);

afterAll(async () => {
  await w?.stop();
});

describe('planning an upgrade (B-10207)', () => {
  it('refuses before anything changes: the running digest, an unsupported shape, no snapshot possible', async () => {
    const same = await api(w.alice).post(`${U(d.id)}/upgrades`, { image: `${REPO}@${DIGEST_A}` });
    expect(same.status).toBe(409);
    expect(same.body.reason).toBe('same_release');
    const plain = await w.h.s.cloud.deployments.create(w.alice, { name: 'plain', accountId: w.accounts.digitalocean.id });
    const bad = await api(w.alice).post(`${U(plain.id)}/upgrades`, { imageDigest: DIGEST_B });
    expect(bad.body.reason).toBe('upgrade_unsupported');
    // An adapter that takes no database snapshot: refused with its reason, before any plan.
    const p = w.h.s.cloud.providers.providerFor('digitalocean');
    const keep = p.snapshotSupport!;
    p.snapshotSupport = () => 'Final snapshots of managed databases come with the database adapters (B-103).';
    try {
      const plans = await w.h.s.db('cloud_plans').where({ deployment_id: d.id }).count({ n: '*' });
      const r = await api(w.alice).post(`${U(d.id)}/upgrades`, { imageDigest: DIGEST_B });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ reason: 'snapshot_unsupported', detail: expect.stringMatching(/B-103/) });
      expect(await w.h.s.db('cloud_plans').where({ deployment_id: d.id }).count({ n: '*' })).toEqual(plans);
    } finally {
      p.snapshotSupport = keep;
    }
    expect(await w.h.s.db('cloud_upgrades')).toHaveLength(0);
  });

  it('a database the deployment does not manage needs the operator’s own backup, named by reference', async () => {
    const other = await deployed(w, kubeSpec(w, 'digitalocean', 'ext-lab'));
    const r = await api(w.alice).post(`${U(other.id)}/upgrades`, { imageDigest: DIGEST_B });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('snapshot_unavailable');
    const ok = await api(w.alice).post(`${U(other.id)}/upgrades`, { imageDigest: DIGEST_B, externalBackup: { ref: 'pgbackrest:ext-lab/20261020-1200F', note: 'taken by hand' } });
    expect(ok.status).toBe(201);
    expect(ok.body.plan).toMatchObject({ purpose: 'upgrade', applicable: true, summary: { create: 0, update: 0, replace: 0, delete: 0 } });
    expect(ok.body.upgrade).toMatchObject({ state: 'planned', fromDigest: DIGEST_A, toDigest: DIGEST_B, backup: { ref: 'pgbackrest:ext-lab/20261020-1200F' } });
    // Only one upgrade at a time.
    const again = await api(w.alice).post(`${U(other.id)}/upgrades`, { imageDigest: DIGEST_C, externalBackup: { ref: 'x' } });
    expect(again.body.reason).toBe('upgrade_in_progress');
  }, 120_000);
});

describe('an upgrade by digest (B-10207)', () => {
  it('takes the database snapshot first, checks the migrations with the new image, rolls the release and verifies', async () => {
    const u = await upgrade(`${REPO}@${DIGEST_B}`);
    expect(u.state).toBe('succeeded');
    expect(u.steps.map((s) => [s.id, s.state])).toEqual([
      ['snapshot', 'done'],
      ['migrate_check', 'done'],
      ['rollout', 'done'],
      ['verify', 'done']
    ]);
    // The snapshot came first and is listed.
    const snap = (await w.h.s.cloud.releases.upgrades.snapshot(u.snapshotId!))!;
    // The adapter's own snapshot (B-10307): a restore point inside DigitalOcean's point-in-time window.
    expect(snap).toMatchObject({ kind: 'provider', state: 'available', resourceKey: 'db', providerId: dbId, snapshotRef: expect.stringMatching(/^pitr:\d{4}-\d{2}-\d{2}T/), restorable: true });
    expect(pgClusters()).toHaveLength(1);
    const order = (await w.h.s.db('audit_events').whereIn('action', ['cloud.upgrade.snapshot', 'cloud.release.deployed']).where('ts', '>=', u.createdAt).orderBy('seq')).map((e: { action: string }) => e.action);
    expect(order).toEqual(['cloud.upgrade.snapshot', 'cloud.release.deployed']);
    // migrate --check ran as a Job with the new image (expand-only pending: exit 2), and was removed afterwards.
    const check = w.kube.digitalocean.requests.find((r) => r.method === 'PATCH' && /\/jobs\/exprsn-ai-migrate-check-/.test(r.path));
    expect(check).toBeTruthy();
    expect(u.steps.find((s) => s.id === 'migrate_check')!.detail).toMatch(/only expand/);
    expect([...w.kube.digitalocean.objects.keys()].some((k) => k.includes('migrate-check'))).toBe(false);
    // The rolling update: the new digest in the values, the release's revision 2, the cluster running it.
    const up = w.helm.digitalocean.calls.filter((c) => c.args[0] === 'upgrade').at(-1)!;
    expect(up.values).toMatchObject({ image: { repository: REPO, digest: DIGEST_B } });
    expect(w.kube.digitalocean.image()).toBe(`${REPO}@${DIGEST_B}`);
    expect(await w.h.s.cloud.releases.current(d.id)).toMatchObject({ digest: DIGEST_B, reason: 'upgrade', upgradeId: u.id, state: 'deployed' });
    expect((await w.h.s.cloud.deployments.get(d.id))!.state).toBe('ready');
  }, 120_000);

  it('rolls the app tier back to the previous image by itself when verify fails; the snapshot is listed for restore', async () => {
    w.app.digitalocean.bad.add(DIGEST_C);
    const before = w.helm.digitalocean.calls.filter((c) => c.args[0] === 'rollback').length;
    const u = await upgrade(`${REPO}@${DIGEST_C}`);
    expect(u.state).toBe('rolled_back');
    expect(u.steps.map((s) => [s.id, s.state])).toEqual([
      ['snapshot', 'done'],
      ['migrate_check', 'done'],
      ['rollout', 'done'],
      ['verify', 'failed'],
      ['rollback', 'done']
    ]);
    expect(u.note).toMatch(/back on sha256:b+.*not rolled back.*listed for restore/);
    // No manual step: helm rollback ran, the previous image runs again, and the deployment is ready again.
    expect(w.helm.digitalocean.calls.filter((c) => c.args[0] === 'rollback').length).toBe(before + 1);
    expect(w.kube.digitalocean.image()).toBe(`${REPO}@${DIGEST_B}`);
    expect(await w.h.s.cloud.releases.current(d.id)).toMatchObject({ digest: DIGEST_B, reason: 'rollback', state: 'deployed' });
    expect((await w.h.s.cloud.deployments.get(d.id))!).toMatchObject({ state: 'ready', health: 'healthy' });
    // The database stayed as it is; its snapshot is listed for restore.
    expect(pgClusters()).toHaveLength(1);
    const listed = (await api(w.alice).get(`${U(d.id)}/snapshots`).expect(200)).body.snapshots;
    expect(listed.find((s: { id: string }) => s.id === u.snapshotId)).toMatchObject({ state: 'available', restorable: true, upgradeId: u.id });
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.upgrade.rolled_back' }).first()).toBeTruthy();
  }, 120_000);

  it('stops before rolling anything when the new release has destructive migrations', async () => {
    w.kube.digitalocean.exitCodeFor = (job) => (JSON.stringify(job).includes(DIGEST_D) && JSON.stringify(job).includes('--check') ? 3 : 0);
    const releases = (await w.h.s.db('cloud_releases').where({ deployment_id: d.id })).length;
    const u = await upgrade(`${REPO}@${DIGEST_D}`);
    expect(u.state).toBe('blocked');
    expect(u.steps.find((s) => s.id === 'migrate_check')).toMatchObject({ state: 'failed', detail: expect.stringMatching(/destructive/) });
    expect(u.steps.find((s) => s.id === 'rollout')!.state).toBe('pending');
    expect((await w.h.s.db('cloud_releases').where({ deployment_id: d.id })).length).toBe(releases);
    expect(w.kube.digitalocean.image()).toBe(`${REPO}@${DIGEST_B}`);
  }, 120_000);
});

describe('restoring the database (B-10207, dual control)', () => {
  it('is asked for by one cloud admin and approved by another; never by the one who asked', async () => {
    const [snap] = (await w.h.s.cloud.releases.upgrades.snapshots(w.alice.principal, d.id)).filter((s) => s.kind === 'provider');
    const ask = await api(w.alice).post(`${U(d.id)}/snapshots/${snap!.id}/restore`, { note: 'back to before 1.0.1' });
    expect(ask.status).toBe(200);
    expect(ask.body.snapshot.restore).toMatchObject({ state: 'requested', requestedBy: w.alice.principal.userId });
    expect(pgClusters()).toHaveLength(1);
    const self = await api(w.alice).post(`${U(d.id)}/snapshots/${snap!.id}/restore/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.step).toBe('dual_control');
    const ok = await api(w.bob).post(`${U(d.id)}/snapshots/${snap!.id}/restore/approve`, { note: 'agreed' });
    expect(ok.status).toBe(202);
    await drain(w);
    // The restore forked a new cluster from the restore point (never over the old one), which joined the graph, protected.
    const source = w.do.dbs.clusters.get(dbId)!;
    const restored = pgClusters().find((c) => c.id !== dbId)!;
    expect(restored).toMatchObject({ status: 'online', size: source.size, private_network_uuid: source.private_network_uuid, restoredFrom: { database_name: source.name, backup_created_at: snap!.snapshotRef!.slice('pitr:'.length) } });
    expect(restored.tags).toContain('exprsn-deletion-protection');
    expect(restored.firewall.map((f) => f.value)).toEqual(source.firewall.map((f) => f.value));
    expect(await w.h.s.cloud.deployments.resource(d.id, 'db-restored')).toMatchObject({ providerId: restored.id, protect: true, desired: { spec: { restoreFrom: snap!.snapshotRef, deletionProtection: true } } });
    expect(((await w.h.s.db('audit_events').where({ action: 'cloud.snapshot.restored' }).first()) as { detail: string }).detail).toContain('db-restored');
    expect((await w.h.s.cloud.releases.upgrades.snapshot(snap!.id))!.restore).toMatchObject({ state: 'restored', decidedBy: w.bob.principal.userId });
    for (const a of ['cloud.snapshot.restore.requested', 'cloud.snapshot.restore.approved', 'cloud.snapshot.restored']) expect(await w.h.s.db('audit_events').where({ action: a }).first()).toBeTruthy();
    // An operator's own backup is restored with the tooling that made it.
    const ext = await w.h.s.db('cloud_snapshots').insert({ id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', deployment_id: d.id, tenant_id: d.tenantId, upgrade_id: null, kind: 'external', resource_key: null, resource_type: 'database', provider_id: null, name: 'by-hand', snapshot_ref: 'pgbackrest:x', state: 'available', pending: null, restore: null, error: null, created_by: null, created_at: Date.now(), updated_at: Date.now() });
    void ext;
    const r = await api(w.alice).post(`${U(d.id)}/snapshots/01JZZZZZZZZZZZZZZZZZZZZZZZ/restore`, {});
    expect(r.body.reason).toBe('restore_external');
  }, 120_000);
});
