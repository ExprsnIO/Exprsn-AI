import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { appTierSpecProblems, cloudflareAppProblems, DATABASE_REQUIRED, REDIS_REQUIRED, renderWorkerScript } from '../src/cloud/cloudflare-app.js';
import { computeProblems, type SecretBroker } from '../src/cloud/compute.js';
import type { DesiredResource } from '../src/cloud/graph.js';
import { assetHash, hyperdriveOrigin, multipart } from '../src/cloud/providers/cloudflare-app.js';
import { CloudflareProvider, type CallContext, type SecretBinding } from '../src/cloud/providers/index.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import { renderGraph } from '../src/cloud/render.js';
import { deploymentSpecSchema, type DeploymentSpec, type DeploymentSpecInput } from '../src/cloud/spec.js';
import { cloudTags } from '../src/cloud/tags.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { servicePolicy } from '../src/platform/egress.js';
import { DEFAULT_ZONES, type ZoneSpec } from '../src/zones/spec.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { parseMultipart } from './fake-cloudflare-app.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import { harness, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 61 (B-10905): the Cloudflare app tier (hybrid), `compute.shape: cloudflare`, against
 * `fake-cloudflare.ts` (with `fake-cloudflare-app.ts`) only: the spec renders a Worker with the console's static
 * assets, the signed image on Containers, Hyperdrive to the data tier's PostgreSQL and an R2 bucket on the Cloudflare
 * account, with the database, and no cache, on the target provider; Redis is required from a managed cache on another
 * provider (a plan without it is refused with that reason); no secret is ever a plain setting; and the adapter makes
 * each resource with the secrets going from the broker to Cloudflare only.
 */

const ALLOWED = '127.0.0.1,::1,localhost';
const IMAGE = `registry.cloudflare.com/exprsn/exprsn-ai@sha256:${'b'.repeat(64)}`;
const SECRET_VALUE = (b: SecretBinding) => (b.env === 'DATABASE_URL' ? 'postgres://exprsn:db-password-not-in-props@db.internal.example.test:5432/exprsn' : `value-of-${b.name}-secret`);
const zones = (): Map<string, { version: number; spec: ZoneSpec }> => new Map(DEFAULT_ZONES.map((z) => [z.id, { version: 1, spec: structuredClone(z.spec) }]));

function spec(extra: Partial<DeploymentSpecInput> & { cloudflare?: Record<string, unknown> } = {}): DeploymentSpec {
  const { cloudflare, ...rest } = extra;
  return deploymentSpecSchema.parse({
    name: 'edge-app',
    target: { provider: 'aws', accountId: ulid(), region: 'eu-central-1' },
    compute: { shape: 'cloudflare', size: 'medium', ...(cloudflare !== undefined ? { cloudflare } : { cloudflare: { redisUrlRef: 'vault:cloud/edge-app#redis_url' } }) },
    data: { mode: 'provision', engine: 'postgres', cache: true },
    frontDoor: { kind: 'cloudflare', accountId: ulid(), hostname: 'ai.example.test', zone: 'example.test' },
    release: { version: '1.0.0', image: IMAGE },
    keys: { provider: 'openbao', addr: 'https://bao.example.test' },
    ...rest
  });
}
const graph = (s: DeploymentSpec) => renderGraph(s, { zones: zones(), corporateCidrs: [] });

describe('the cloudflare shape: spec and render', () => {
  it('renders a Worker with static assets, Containers, Hyperdrive and R2 on Cloudflare; the database stays on AWS, no cache', () => {
    const s = spec();
    expect(appTierSpecProblems(s)).toEqual([]);
    const g = graph(s);
    // The target account: the network and the provisioned database, but no app tier, no cache and no S3 bucket.
    expect(g.resources.some((r) => r.type === 'database' && r.key === 'db')).toBe(true);
    expect(g.resources.some((r) => ['container_service', 'vm', 'kubernetes_cluster', 'cache', 'bucket', 'load_balancer'].includes(r.type))).toBe(false);
    // The Cloudflare account.
    const t = g.appTier!;
    expect(t.accountId).toBe(s.frontDoor.kind === 'cloudflare' ? s.frontDoor.accountId : null);
    const by = Object.fromEntries(t.resources.map((r) => [r.key, r]));
    expect(t.resources.map((r) => `${r.key}:${r.type}`)).toEqual(['blobs:bucket', 'hyperdrive:hyperdrive', 'worker:worker', 'app:container_service']);
    expect(by.blobs).toMatchObject({ region: 'r2-eu', protect: true, spec: { jurisdiction: 'eu', publicAccess: false } });
    expect(by.hyperdrive!.spec).toMatchObject({ origin: { databaseUrlRef: 'vault:cloud/edge-app#database_url', via: 'tunnel', accessClientSecretRef: 'vault:cloud/edge-app#hyperdrive_access_client_secret', from: { account: 'target', key: 'db' } } });
    expect(by.worker).toMatchObject({ dependsOn: ['hyperdrive', 'blobs'], spec: { hyperdrive: 'hyperdrive', databaseFrom: 'hyperdrive', r2: { bucket: 'blobs', jurisdiction: 'eu' }, customDomain: { hostname: 'ai.example.test', zone: 'example.test' }, container: { className: 'ExprsnApp', instances: 2, port: 8080 } } });
    expect((by.worker!.spec.vars as Record<string, string>)).toMatchObject({ NODE_ENV: 'production', PUBLIC_URL: 'https://ai.example.test', KMS_PROVIDER: 'openbao', BLOB_STORE: 's3', S3_REGION: 'auto', S3_FORCE_PATH_STYLE: 'true', PORT: '8080' });
    expect((by.worker!.spec.secrets as SecretBinding[]).map((b) => b.env)).toEqual(['SESSION_SECRET', 'REDIS_URL', 'OPENBAO_TOKEN', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
    expect(by.app).toMatchObject({ dependsOn: ['worker'], spec: { platform: 'cloudflare-containers', image: IMAGE, replicas: 2, instanceType: 'standard-2', env: {}, worker: 'worker', migrate: { command: ['node', 'server/dist/cli.js', 'migrate'], onStart: true } } });
    // The front door: the Worker answers on the hostname; the tunnel carries Hyperdrive to the private database.
    expect(g.frontDoor!.resources.map((r) => r.type)).toEqual(['tunnel']);
    expect(g.notes.join(' ')).toMatch(/Cloudflare Containers \(2 × standard-2\), Hyperdrive to PostgreSQL through the tunnel, blobs on R2 \(eu jurisdiction\)/);
    // No secret value and no plain secret anywhere; the render checks pass.
    expect(computeProblems([...g.resources, ...t.resources])).toEqual([]);
    expect(JSON.stringify(t)).not.toMatch(/DATA_KEY|password/i);
  });

  it('takes an existing database directly, R2 in the default jurisdiction for a US data region, FedRAMP when asked', () => {
    const us = graph(spec({ target: { provider: 'aws', accountId: ulid(), region: 'us-east-1' }, data: { mode: 'existing', databaseUrlRef: 'vault:cloud/edge-app#db', redisUrlRef: 'vault:cloud/edge-app#redis' }, cloudflare: {} }));
    const by = Object.fromEntries(us.appTier!.resources.map((r) => [r.key, r]));
    expect(by.blobs).toMatchObject({ region: null, spec: { jurisdiction: 'default' } });
    expect(by.hyperdrive!.spec).toMatchObject({ origin: { databaseUrlRef: 'vault:cloud/edge-app#db', via: 'direct' } });
    expect((by.worker!.spec.secrets as SecretBinding[]).find((b) => b.env === 'REDIS_URL')!.ref).toBe('vault:cloud/edge-app#redis');
    expect(us.frontDoor!.resources).toEqual([]);
    const gov = graph(spec({ cloudflare: { redisUrlRef: 'vault:cloud/edge-app#redis_url', r2Jurisdiction: 'fedramp' } }));
    expect(gov.appTier!.resources.find((r) => r.key === 'blobs')).toMatchObject({ region: 'r2-fedramp', spec: { jurisdiction: 'fedramp' } });
  });

  it('refuses a Cloudflare app tier without Redis on another provider, with that reason, and what it cannot run', () => {
    const noRedis = spec({ cloudflare: {} });
    expect(appTierSpecProblems(noRedis)).toEqual([{ path: 'compute.cloudflare.redisUrlRef', message: REDIS_REQUIRED }]);
    // The render check (a blocker of every plan) says the same of the Worker.
    const t = graph(noRedis).appTier!.resources;
    expect(cloudflareAppProblems(t)).toEqual([`worker (worker): ${REDIS_REQUIRED}`]);
    expect(computeProblems(t)).toContain(`worker (worker): ${REDIS_REQUIRED}`);
    // Without Hyperdrive.
    expect(cloudflareAppProblems(graph(spec()).appTier!.resources.filter((r) => r.type !== 'hyperdrive'))).toEqual([`worker (worker): ${DATABASE_REQUIRED}`]);
    const bad = appTierSpecProblems(spec({ frontDoor: { kind: 'acme', hostname: 'ai.example.test', zone: 'example.test' }, keys: { provider: 'aws-kms', region: 'eu-central-1', accessKeyId: 'AKIAEXAMPLE000000000', secretRef: 'vault:cloud/k#s' }, gpuPools: [{ name: 'gpu', gpu: 'l4', min: 0, max: 1 }], release: {} }));
    expect(bad.map((p) => p.path).sort()).toEqual(['frontDoor.kind', 'gpuPools', 'keys.provider', 'release.image']);
    expect(bad.find((p) => p.path === 'gpuPools')!.message).toMatch(/Runs the app tier only|app tier only; pick a provider for data and GPUs/);
  });

  it('never takes a secret as a plain Worker setting, or one production takes only as a file', () => {
    const t = graph(spec()).appTier!.resources.map((r) => structuredClone(r));
    const w = t.find((r) => r.type === 'worker')!;
    (w.spec.vars as Record<string, string>).DATA_KEY = 'AAAA';
    (w.spec.vars as Record<string, string>).REDIS_URL = 'rediss://:pw@cache.example.test:6380';
    (w.spec.secrets as SecretBinding[]).push({ name: 'kms', env: 'KMS_AWS_SECRET_ACCESS_KEY', ref: 'vault:cloud/edge-app#kms' }, { name: 'inline', env: 'SMTP_URL', ref: 'smtp://user:pw@mail' });
    const problems = cloudflareAppProblems(t);
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/DATA_KEY is set as a plain Worker variable.*never leaves OpenBao/),
      expect.stringMatching(/REDIS_URL is set as a plain Worker variable/),
      expect.stringMatching(/KMS_AWS_SECRET_ACCESS_KEY would reach the container as a variable/),
      expect.stringMatching(/the secret inline is not a vault: reference/)
    ]));
    const c = t.find((r) => r.type === 'container_service')!;
    (c.spec.env as Record<string, string>).SESSION_SECRET = 'x';
    c.spec.image = 'ghcr.io/exprsn/exprsn-ai:latest';
    expect(computeProblems(t)).toEqual(expect.arrayContaining([expect.stringMatching(/app \(container_service\): SESSION_SECRET is set as a plain environment variable/), expect.stringMatching(/no image pinned by digest/), expect.stringMatching(/takes its settings from its Worker/)]));
  });

  it('writes a Worker module with no secret value in it', () => {
    const js = renderWorkerScript({ className: 'ExprsnApp', instances: 3, port: 8080, vars: ['NODE_ENV'], secrets: ['SESSION_SECRET', 'REDIS_URL'], prefixes: ['/js/'] });
    expect(js).toContain('export class ExprsnApp extends DurableObject');
    expect(js).toContain('out.DATABASE_URL = env.HYPERDRIVE.connectionString');
    expect(js).toContain('const INSTANCES = 3;');
    expect(js).toContain('"SESSION_SECRET","REDIS_URL"');
    expect(js).not.toMatch(/value-of|password/);
    expect(hyperdriveOrigin('postgres://u%40x:p%23w@db.example.test:6543/app')).toEqual({ scheme: 'postgres', host: 'db.example.test', port: 6543, database: 'app', user: 'u@x', password: 'p#w' });
    expect(() => hyperdriveOrigin('mysql://u:p@h/db')).toThrow(/postgres/);
    const mp = multipart([{ name: 'metadata', contentType: 'application/json', body: '{"a":1}' }]);
    expect(parseMultipart(mp.contentType, mp.body)).toEqual([expect.objectContaining({ name: 'metadata', body: Buffer.from('{"a":1}') })]);
    expect(assetHash({ path: '/js/a.js', body: Buffer.from('x') })).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('the Cloudflare adapter: Workers with static assets, Hyperdrive and Containers', () => {
  const fake = new FakeCloudflare();
  let p: CloudflareProvider;
  let ctx: CallContext;
  let assets = '';
  const tags = cloudTags({ account: 'edge', deployment: 'edge-app' });
  const asked: string[] = [];

  beforeAll(async () => {
    await fake.start();
    fake.addZone('example.test');
    assets = mkdtempSync(path.join(tmpdir(), 'exprsn-web-'));
    mkdirSync(path.join(assets, 'js'), { recursive: true });
    mkdirSync(path.join(assets, 'css'), { recursive: true });
    writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>console</title>');
    writeFileSync(path.join(assets, 'js', 'app.js'), 'console.log("app")');
    writeFileSync(path.join(assets, 'js', 'screens.js'), 'console.log("screens")');
    writeFileSync(path.join(assets, 'css', 'app.css'), 'body{}');
    const t = fake.addToken(['Workers Scripts Write', 'Containers Edit', 'Hyperdrive Write', 'Zone Read', 'Workers R2 Storage Write']);
    p = new CloudflareProvider({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), sleep: async () => undefined, random: () => 0.5, endpoints: { api: fake.url, assetsRoot: assets } });
    const account: CloudAccount = { id: 'acc-edge', name: 'edge', provider: 'cloudflare', scope: 'platform', tenantId: null, providerIds: { cloudflareAccountId: fake.accountId }, credentialMode: 'vaulted', defaultRegion: 'global', state: 'active', description: null, regions: [], validation: null, createdBy: null, createdAt: 0, updatedAt: 0 };
    ctx = { account, cred: { kind: 'token', token: t.value }, secrets: { value: async (b) => (asked.push(b.env), SECRET_VALUE(b)), wrap: async () => null } };
  });
  afterAll(() => fake.stop());

  const resourcesOf = () => Object.fromEntries(graph(spec()).appTier!.resources.map((r) => [r.key, r])) as Record<string, DesiredResource>;
  const toSpec = (r: DesiredResource, refs: Record<string, string> = {}) => ({ type: r.type, name: r.key, idempotencyKey: `k-${r.key}`, tags, props: r.spec as never, ...(Object.keys(refs).length ? { parent: { refs } } : {}) });

  it('makes Hyperdrive with the password from the broker, never read back; adopts it on a second create', async () => {
    const hd = await p.create(ctx, toSpec(resourcesOf().hyperdrive!));
    expect(hd.done && hd.resource).toMatchObject({ type: 'hyperdrive', name: 'hyperdrive', props: { host: 'db.internal.example.test', database: 'exprsn', user: 'exprsn', via: 'tunnel' } });
    const stored = [...fake.app.hyperdrives.values()][0]!;
    expect(stored).toMatchObject({ name: 'exprsn-edge-hyperdrive', origin: { password: 'db-password-not-in-props', access_client_id: 'value-of-hyperdrive_access_client_id-secret', access_client_secret: 'value-of-hyperdrive_access_client_secret-secret' } });
    expect(stored.origin.port).toBeUndefined(); // through the tunnel: no port
    expect(JSON.stringify(hd)).not.toMatch(/db-password|access_client_secret|value-of/);
    expect(await p.create(ctx, toSpec(resourcesOf().hyperdrive!))).toMatchObject({ adopted: true });
    expect(fake.app.hyperdrives.size).toBe(1);
  });

  it('uploads the console\'s asset files, the script with its bindings, the secrets apart, and the custom domain; then the container', async () => {
    const r = resourcesOf();
    const hd = [...fake.app.hyperdrives.values()][0]!;
    const bucket = (await p.create({ ...ctx, region: 'r2-eu' }, { ...toSpec(r.blobs!), region: 'r2-eu' })) as { done: true; resource: { providerId: string } };
    expect(fake.buckets.get(bucket.resource.providerId)).toMatchObject({ jurisdiction: 'eu' });
    const w = await p.create(ctx, toSpec(r.worker!, { hyperdrive: hd.id, blobs: bucket.resource.providerId }));
    expect(w.done && w.resource).toMatchObject({ type: 'worker', providerId: 'exprsn-edge-worker', props: { secrets: ['OPENBAO_TOKEN', 'REDIS_URL', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'SESSION_SECRET'], customDomain: 'ai.example.test' } });
    const script = fake.app.scripts.get('exprsn-edge-worker')!;
    // Static assets: the asset files only (no HTML), uploaded with the session's JWT, bound as ASSETS.
    expect(script.assets.sort()).toEqual(['/css/app.css', '/js/app.js', '/js/screens.js']);
    expect(fake.app.uploaded.size).toBe(3);
    const uploads = fake.calls(/workers\/assets\/upload/);
    expect(uploads.length).toBe(2);
    expect(uploads.every((u) => u.headers.authorization!.startsWith('Bearer aus.'))).toBe(true);
    const bindings = script.metadata.bindings as { type: string; name: string; text?: string; id?: string; class_name?: string }[];
    expect(bindings.filter((b) => b.type !== 'plain_text')).toEqual([{ type: 'hyperdrive', name: 'HYPERDRIVE', id: hd.id }, { type: 'durable_object_namespace', name: 'APP', class_name: 'ExprsnApp' }, { type: 'assets', name: 'ASSETS' }]);
    const vars = Object.fromEntries(bindings.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text]));
    expect(vars).toMatchObject({ BLOB_STORE: 's3', S3_ENDPOINT: `https://${fake.accountId}.eu.r2.cloudflarestorage.com`, S3_BUCKET: bucket.resource.providerId, S3_REGION: 'auto' });
    expect(Object.keys(vars).some((k) => /SECRET|TOKEN|REDIS|DATA_KEY|PASSWORD/.test(k))).toBe(false);
    expect(script.metadata).toMatchObject({ containers: [{ class_name: 'ExprsnApp' }], migrations: { new_sqlite_classes: ['ExprsnApp'] }, assets: { config: { run_worker_first: true } } });
    // Secrets: through the secrets API only, with the broker's values; never in the script or its metadata.
    expect(Object.fromEntries(script.secrets)).toEqual({ SESSION_SECRET: 'value-of-session_secret-secret', REDIS_URL: 'value-of-redis_url-secret', OPENBAO_TOKEN: 'value-of-openbao_token-secret', S3_ACCESS_KEY_ID: 'value-of-s3_access_key_id-secret', S3_SECRET_ACCESS_KEY: 'value-of-s3_secret_access_key-secret' });
    expect(script.module + JSON.stringify(script.metadata)).not.toMatch(/value-of|db-password/);
    expect(JSON.stringify(w)).not.toMatch(/value-of/);
    expect(fake.app.domains).toEqual([expect.objectContaining({ hostname: 'ai.example.test', service: 'exprsn-edge-worker' })]);

    const c = await p.create(ctx, toSpec(r.app!, { worker: 'exprsn-edge-worker' }));
    expect(c.done && c.resource).toMatchObject({ type: 'container_service', props: { platform: 'cloudflare-containers', image: IMAGE, instanceType: 'standard-2', replicas: 2 } });
    const app = [...fake.app.containers.values()][0]!;
    expect(app).toMatchObject({ name: 'exprsn-edge-app', instances: 2, configuration: { image: IMAGE, instance_type: 'standard-2' }, durable_objects: { namespace_id: fake.app.namespaces[0]!.id } });
    expect(JSON.stringify(app)).not.toMatch(/value-of|env/);
    // A new image is a rollout of the application.
    const next = `registry.cloudflare.com/exprsn/exprsn-ai@sha256:${'c'.repeat(64)}`;
    await p.update(ctx, { type: 'container_service', providerId: app.id }, toSpec({ ...r.app!, spec: { ...r.app!.spec, image: next } }, { worker: 'exprsn-edge-worker' }));
    expect(fake.app.containers.get(app.id)).toMatchObject({ configuration: { image: next } });
    expect((await p.list(ctx, 'worker', { managedOnly: true })).map((x) => x.name)).toEqual(['worker']);

    // Deleting the Worker removes its custom domain first.
    await p.delete(ctx, { type: 'container_service', providerId: app.id });
    await p.delete(ctx, { type: 'worker', providerId: 'exprsn-edge-worker' });
    expect(fake.app.scripts.size).toBe(0);
    expect(fake.app.domains).toEqual([]);
    expect(await p.describe(ctx, { type: 'worker', providerId: 'exprsn-edge-worker' })).toBeNull();
  });

  it('refuses a secret without the deployment\'s broker', async () => {
    const r = resourcesOf();
    const { secrets: _s, ...noBroker } = ctx;
    void _s;
    await expect(p.create(noBroker, toSpec(r.hyperdrive!, {}), )).resolves.toMatchObject({ adopted: true }); // exists: no secret needed
    fake.app.hyperdrives.clear();
    await expect(p.create(noBroker, toSpec(r.hyperdrive!))).rejects.toMatchObject({ code: 'no_secret_broker' });
  });
});

describe('the engine path on the Cloudflare account', () => {
  let h: Harness;
  const cf = new FakeCloudflare();
  let account: CloudAccount;
  let actor: { principal: Principal; ip: string };
  let assets = '';

  beforeAll(async () => {
    await cf.start();
    cf.addZone('example.test');
    assets = mkdtempSync(path.join(tmpdir(), 'exprsn-web-'));
    mkdirSync(path.join(assets, 'js'));
    writeFileSync(path.join(assets, 'js', 'app.js'), 'console.log(1)');
    h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
    if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
    h.s.cloud.deployments.resetSchemaCache();
    const token = cf.addToken(['Zone Read', 'DNS Write', 'Cloudflare Tunnel Write', 'Workers Scripts Write', 'Containers Edit', 'Hyperdrive Write', 'Workers R2 Storage Write']).value;
    const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { cloudflare: { api: cf.url, assetsRoot: assets } }, transport: { sleep: async () => undefined, random: () => 0.5 } });
    Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'token', token, accountId: cf.accountId }) };
    h.s.cloud.engine.options.sleep = async () => undefined;
    h.s.cloud.engine.hooks.secrets = { value: async (_d, b) => SECRET_VALUE(b), wrap: async () => null } satisfies SecretBroker;
    account = await seedAccount(h, { provider: 'cloudflare', mode: 'vaulted', name: 'edge', providerIds: { cloudflareAccountId: cf.accountId } });
    await h.s.db('cloud_account_regions').insert({ account_id: account.id, region: 'r2-eu', zone: 'edge-eu', ceiling: 'internal', geo: 'eu', is_default: false, updated_at: Date.now() });
    const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'frontdoor', name: 'Front door', status: 'ok', required: [], missing: [], reason: null }, { feature: 'apptier', name: 'App tier', status: 'ok', required: [], missing: [], reason: null }] };
    await h.s.db('cloud_accounts').where({ id: account.id }).update({ validation: JSON.stringify(VALIDATED) });
    actor = { principal: { kind: 'user', userId: 'u-cloud', tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username: 'cloud', displayName: 'Cloud', roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true }, ip: '127.0.0.1' };
  });
  afterAll(async () => {
    await h.close();
    await cf.stop();
  });

  it('refuses a plan without Redis on another provider, with that reason, before any provider change', async () => {
    const d = await h.s.cloud.deployments.create(actor, { name: 'edge-noredis', accountId: account.id, region: 'global' });
    const plan = await h.s.cloud.plans.create(actor, d.id, graph(spec({ cloudflare: {} })).appTier!.resources);
    expect(plan.applicable).toBe(false);
    expect(plan.blockers).toContain(`worker (worker): ${REDIS_REQUIRED}`);
    await expect(h.s.cloud.plans.apply(actor, plan.id, plan.hash)).rejects.toMatchObject({ status: 409 });
    expect(cf.app.scripts.size + cf.app.hyperdrives.size + cf.app.containers.size).toBe(0);
  });

  it('plans and applies the app tier: R2 in its EU region, Hyperdrive, the Worker and the container, with no secret in the journal', async () => {
    const d = await h.s.cloud.deployments.create(actor, { name: 'edge-app', accountId: account.id, region: 'global' });
    const plan = await h.s.cloud.plans.create(actor, d.id, graph(spec()).appTier!.resources);
    expect(plan.blockers).toEqual([]);
    const { jobId } = await h.s.cloud.plans.apply(actor, plan.id, plan.hash);
    const outcome = await h.s.cloud.engine.apply(plan.id, { jobId, onBehalfOf: actor.principal.userId });
    expect(outcome).toMatchObject({ state: 'applied' });
    expect([...cf.buckets.values()]).toEqual([expect.objectContaining({ jurisdiction: 'eu' })]);
    expect(cf.app.hyperdrives.size).toBe(1);
    expect(cf.app.scripts.size).toBe(1);
    expect(cf.app.containers.size).toBe(1);
    const resources = await h.s.cloud.deployments.resources(d.id);
    expect(resources.map((r) => r.key).sort()).toEqual(['app', 'blobs', 'hyperdrive', 'worker']);
    const rows = JSON.stringify([await h.s.db('cloud_resources').where({ deployment_id: d.id }), await h.s.db('cloud_operations').where({ deployment_id: d.id }).catch(() => [])]);
    expect(rows).not.toMatch(/value-of|db-password/);
  });
});
