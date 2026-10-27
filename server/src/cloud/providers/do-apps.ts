import { createHash } from 'node:crypto';
import { namePrefix } from '../tags.js';
import { CloudProviderError, type CallContext, type ContainerServiceProps, type ObservedResource, type OperationHandle, type OperationResult, type PollResult, type ResourceRef, type ResourceSpec } from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10205): DigitalOcean App Platform as the `container_service` type. One app spec: the
 * service (the image by digest, the instance size, the health check on `/readyz`, the VPC), a `PRE_DEPLOY` job that
 * runs the migration before every deployment (App Platform's own one-off job: a failed migration fails the
 * deployment, and the previous one keeps serving), and the variables: settings as `GENERAL`, secrets as `SECRET`
 * values from the engine's broker (App Platform keeps them encrypted and mounts no files, so the key-encryption key
 * stays in OpenBao transit: DATA_KEY is never one of them). Created by name (a create first looks the name up),
 * followed through its deployment (`do-app`: the app and deployment ids in the token).
 */

export interface DoAppsHost {
  call<T>(ctx: CallContext, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; requestId: string | null }>;
  all<T>(ctx: CallContext, path: string, key: string): Promise<T[]>;
  region(ctx: CallContext, spec?: ResourceSpec): string;
}

interface DoApp {
  id: string;
  spec: AppSpec;
  default_ingress?: string;
  live_url?: string;
  active_deployment?: { id: string; phase?: string };
  pending_deployment?: { id: string; phase?: string };
  in_progress_deployment?: { id: string; phase?: string };
}
interface AppSpec { name: string; region?: string; services?: { name: string; image?: { registry_type: string; registry?: string; repository: string; digest?: string; tag?: string }; instance_count?: number; instance_size_slug?: string }[]; jobs?: unknown[] }
interface Deployment { id: string; phase: string; progress?: { steps?: { name: string; status: string; reason?: { message?: string } }[] } }

const SIZES: Record<string, string> = { '2x4': 'apps-d-2vcpu-4gb', '4x8': 'apps-d-4vcpu-8gb', '8x16': 'apps-d-8vcpu-32gb' };

/** The registry form of an image by digest, as App Platform names it (GHCR, Docker Hub or DigitalOcean's registry). */
export function appImage(image: string): { registry_type: string; registry?: string; repository: string; digest: string } {
  const m = /^([a-z0-9.-]+(?::\d+)?)\/(.+)@(sha256:[a-f0-9]{64})$/.exec(image);
  if (!m) throw new CloudProviderError('App Platform takes an image pinned by digest.', 'digitalocean', 400, 'image_required');
  const [, host, path, digest] = m as unknown as [string, string, string, string];
  const parts = path.split('/');
  if (host === 'ghcr.io' && parts.length >= 2) return { registry_type: 'GHCR', registry: parts[0]!, repository: parts.slice(1).join('/'), digest };
  if ((host === 'docker.io' || host === 'registry-1.docker.io') && parts.length >= 2) return { registry_type: 'DOCKER_HUB', registry: parts[0]!, repository: parts.slice(1).join('/'), digest };
  if (host === 'registry.digitalocean.com' && parts.length >= 2) return { registry_type: 'DOCR', repository: parts.slice(1).join('/'), digest };
  throw new CloudProviderError(`App Platform pulls from GHCR, Docker Hub or DigitalOcean's registry, not ${host}.`, 'digitalocean', 400, 'registry_unsupported');
}

const imageOf = (s: AppSpec): string | null => {
  const i = s.services?.[0]?.image;
  if (!i?.digest) return null;
  const host = i.registry_type === 'GHCR' ? 'ghcr.io' : i.registry_type === 'DOCKER_HUB' ? 'docker.io' : 'registry.digitalocean.com';
  return `${host}/${i.registry ? `${i.registry}/` : ''}${i.repository}@${i.digest}`;
};

export class DoApps {
  constructor(private readonly h: DoAppsHost) {}

  appName(ctx: CallContext, spec: { name: string }): string {
    const n = `${namePrefix(ctx.account.name)}${spec.name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return n.length <= 32 ? n : `${n.slice(0, 23)}-${createHash('sha256').update(n).digest('hex').slice(0, 8)}`;
  }

  /** The app spec; secret values come from the broker and go only to DigitalOcean. */
  private async appSpec(ctx: CallContext, spec: ResourceSpec<'container_service'>): Promise<Record<string, unknown>> {
    const p: ContainerServiceProps = spec.props;
    if (!p.image) throw new CloudProviderError('The app has no image pinned by digest.', 'digitalocean', 400, 'image_required');
    if ('DATA_KEY' in p.env || 'DATA_KEY_PREVIOUS' in p.env || p.secrets.some((b) => b.env === 'DATA_KEY' || b.env === 'DATA_KEY_PREVIOUS')) throw new CloudProviderError('DATA_KEY is never an App Platform variable; the key-encryption key stays in OpenBao transit.', 'digitalocean', 400, 'inline_secret');
    if (p.secrets.length && !ctx.secrets) throw new CloudProviderError('No secret broker is configured, so the app’s secrets cannot be given to App Platform.', 'digitalocean', 409, 'secrets_unavailable');
    const envs: { key: string; value: string; scope: string; type: string }[] = Object.entries(p.env).map(([key, value]) => ({ key, value, scope: 'RUN_TIME', type: 'GENERAL' }));
    for (const b of p.secrets) envs.push({ key: b.env, value: await ctx.secrets!.value(b), scope: 'RUN_TIME', type: 'SECRET' });
    const image = appImage(p.image);
    const vpc = spec.parent?.networkId;
    return {
      name: this.appName(ctx, spec),
      region: this.h.region(ctx, spec).replace(/\d+$/, ''),
      services: [{ name: 'app', image, instance_count: p.replicas, instance_size_slug: SIZES[`${p.vcpu}x${p.memoryGb}`] ?? 'apps-d-2vcpu-4gb', http_port: p.port, health_check: { http_path: '/readyz', initial_delay_seconds: 20 }, envs, ...(p.ingress === 'internal' ? { internal_ports: [p.port] } : {}) }],
      jobs: [{ name: 'migrate', kind: 'PRE_DEPLOY', image, run_command: p.migrate.command.join(' '), instance_count: 1, instance_size_slug: 'apps-d-1vcpu-2gb', envs }],
      ...(vpc ? { vpc: { id: vpc } } : {}),
      ...(p.ingress === 'internet-facing' ? { ingress: { rules: [{ match: { path: { prefix: '/' } }, component: { name: 'app' } }] } } : {}),
      alerts: [{ rule: 'DEPLOYMENT_FAILED' }, { rule: 'DOMAIN_FAILED' }]
    };
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    const name = this.appName(ctx, spec);
    const a = (await this.h.all<DoApp>(ctx, '/v2/apps', 'apps')).find((x) => x.spec?.name === name);
    return a ? appObserved(a) : null;
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    try {
      return appObserved((await this.h.call<{ app: DoApp }>(ctx, 'GET', `/v2/apps/${encodeURIComponent(ref.providerId)}`)).body.app);
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  async list(ctx: CallContext, managedOnly: boolean): Promise<ObservedResource[]> {
    const prefix = namePrefix(ctx.account.name);
    return (await this.h.all<DoApp>(ctx, '/v2/apps', 'apps')).filter((a) => !managedOnly || a.spec?.name?.startsWith(prefix)).map(appObserved);
  }

  async create(ctx: CallContext, spec: ResourceSpec<'container_service'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const existing = await this.find(ctx, spec);
    if (existing) {
      if (existing.state === 'ready' && existing.props.image === spec.props.image) return { done: true, resource: existing, adopted: true };
      return { ...(await this.update(ctx, existing, spec, handle)), adopted: true };
    }
    const r = await this.h.call<{ app: DoApp }>(ctx, 'POST', '/v2/apps', { spec: await this.appSpec(ctx, spec) });
    return this.following(r.body.app, 'create', handle, r.requestId);
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec<'container_service'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const r = await this.h.call<{ app: DoApp }>(ctx, 'PUT', `/v2/apps/${encodeURIComponent(ref.providerId)}`, { spec: await this.appSpec(ctx, spec) });
    return this.following(r.body.app, 'update', handle, r.requestId);
  }

  private following(app: DoApp, op: 'create' | 'update', handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle, requestId: string | null): OperationResult {
    const dep = app.pending_deployment?.id ?? app.in_progress_deployment?.id ?? null;
    const o = appObserved(app);
    if (!dep) return { done: true, resource: o, ...(requestId ? { requestId } : {}) };
    return { done: false, operation: handle(op, o, 'do-app', JSON.stringify({ app: app.id, deployment: dep })), resource: o, ...(requestId ? { requestId } : {}) };
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    try {
      await this.h.call(ctx, 'DELETE', `/v2/apps/${encodeURIComponent(ref.providerId)}`);
    } catch (err) {
      if (!(err instanceof CloudProviderError && err.status === 404)) throw err;
    }
    return { done: true, resource: null };
  }

  /** The deployment until it is active; a failed `PRE_DEPLOY` migration fails it (the previous deployment keeps serving). */
  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    const t = JSON.parse(h.token) as { app: string; deployment: string };
    const r = await this.h.call<{ deployment: Deployment }>(ctx, 'GET', `/v2/apps/${encodeURIComponent(t.app)}/deployments/${encodeURIComponent(t.deployment)}`);
    const d = r.body.deployment;
    if (d.phase === 'ACTIVE') return { state: 'succeeded', resource: await this.describe(ctx, h.ref) };
    if (d.phase === 'ERROR' || d.phase === 'CANCELED') {
      const step = d.progress?.steps?.find((s) => s.status === 'ERROR');
      const migration = !!step && /pre_deploy|migrate/i.test(step.name);
      return { state: 'failed', error: migration ? `The migration job failed; the deployment was stopped before the app rolled out${step?.reason?.message ? ` (${step.reason.message.slice(0, 200)})` : ''}.` : `The App Platform deployment ended ${d.phase}${step ? ` at ${step.name}` : ''}.`, code: migration ? 'migration_failed' : 'deployment_failed' };
    }
    return { state: 'pending', waitMs: 5000 };
  }
}

function appObserved(a: DoApp): ObservedResource {
  const busy = !!(a.pending_deployment || a.in_progress_deployment);
  const host = a.default_ingress ? a.default_ingress.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  return {
    type: 'container_service',
    providerId: a.id,
    name: a.spec?.name ?? a.id,
    ...(a.spec?.region ? { region: a.spec.region } : {}),
    state: busy ? 'updating' : a.active_deployment?.phase === 'ACTIVE' || a.active_deployment ? 'ready' : 'creating',
    tags: {},
    props: { platform: 'app-platform', image: a.spec ? imageOf(a.spec) : null, replicas: a.spec?.services?.[0]?.instance_count ?? null, address: host }
  };
}
