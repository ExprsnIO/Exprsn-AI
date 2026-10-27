import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderWorkerScript } from '../cloudflare-app.js';
import { r2Endpoint, type R2Jurisdiction } from '../r2.js';
import type { CloudTransport } from './transport.js';
import { CloudProviderError, type CallContext, type ObservedResource, type OperationResult, type ResourceRef, type ResourceSpec, type SecretBinding } from './types.js';

/*
 * 1.9.99-final, Sprint 61 (B-10905): the Cloudflare app tier's resources for the Cloudflare adapter, over the API v4
 * through the adapter's transport (egress guard, rate limiter):
 *
 *   worker             the static assets (an upload session: the manifest of the console's asset files, the buckets
 *                      Cloudflare asks for uploaded with the session's JWT, the completion JWT), then the script
 *                      (multipart: metadata with plain-text, Hyperdrive, Durable Object and assets bindings, the
 *                      container class and its migration; the generated module), then each secret through the
 *                      secrets API (values from the deployment's secret broker, handed to Cloudflare only), then the
 *                      custom domain on the front door's zone
 *   hyperdrive         a configuration whose origin is parsed from the database URL the broker resolves (directly, or
 *                      through the tunnel with an Access service token); the password is never read back
 *   container_service  a Containers application for the Worker's Durable Object namespace, the image by digest
 *
 * Idempotency: by name (`exprsn-<account>-<name>`): a script, a configuration or an application that exists is
 * adopted. Observed state never carries a secret, a password or a token.
 */

type Send = <T>(ctx: CallContext, method: string, path: string, o?: { body?: unknown; raw?: { contentType: string; body: Buffer }; bearer?: string }) => Promise<{ status: number; body: { result: T }; requestId: string | null }>;

interface Asset {
  path: string;
  body: Buffer;
}

/** The console's directory in this build (web/ beside server/), unless the endpoints name another. */
export const defaultAssetsRoot = (): string => process.env.WEB_ROOT || fileURLToPath(new URL('../../../../web', import.meta.url));

const MAX_ASSETS = 20_000;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/** Cloudflare's asset hash: the first 32 hex digits of SHA-256 over the base64 content and the extension. */
export const assetHash = (a: Asset): string => createHash('sha256').update(a.body.toString('base64') + path.extname(a.path).slice(1)).digest('hex').slice(0, 32);

/** The files under `root` whose served path starts with one of `prefixes`. */
export async function readAssets(root: string, prefixes: readonly string[]): Promise<Asset[]> {
  const out: Asset[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_ASSETS) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const served = `/${path.relative(root, full).split(path.sep).join('/')}`;
        if (!prefixes.some((p) => served === p || served.startsWith(p)) || /\.html?$/i.test(served)) continue;
        if ((await stat(full)).size > MAX_ASSET_BYTES) throw new CloudProviderError(`${served} is larger than Workers static assets take (25 MiB).`, 'cloudflare', 400, 'asset_too_large');
        out.push({ path: served, body: await readFile(full) });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** A multipart/form-data body. */
export function multipart(parts: { name: string; filename?: string; contentType: string; body: Buffer | string }[]): { contentType: string; body: Buffer } {
  const boundary = `exprsn-${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\nContent-Type: ${p.contentType}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

/** A database URL as Hyperdrive's origin (the password included: it goes to Cloudflare only). */
export function hyperdriveOrigin(url: string): { scheme: string; host: string; port: number; database: string; user: string; password: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CloudProviderError('The database URL for Hyperdrive is not a URL.', 'cloudflare', 400, 'bad_database_url');
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new CloudProviderError('Hyperdrive reaches PostgreSQL: the database URL is postgres://.', 'cloudflare', 400, 'bad_database_url');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!u.hostname || !u.username || !database) throw new CloudProviderError('The database URL for Hyperdrive names a host, a user and a database.', 'cloudflare', 400, 'bad_database_url');
  return { scheme: 'postgres', host: u.hostname, port: Number(u.port || 5432), database, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

interface CfScript { id: string; tag?: string; modified_on?: string }
interface CfHyperdrive { id: string; name: string; origin?: { host?: string; port?: number; database?: string; user?: string; scheme?: string; access_client_id?: string }; caching?: { disabled?: boolean } }
interface CfContainerApp { id: string; name: string; instances?: number; configuration?: { image?: string; instance_type?: string }; durable_objects?: { namespace_id?: string }; health?: { instances?: { active?: number } } }

export class CloudflareAppTier {
  constructor(
    private readonly o: {
      send: Send;
      accountId: (ctx: CallContext) => string;
      name: (ctx: CallContext, name: string) => string;
      zoneId: (ctx: CallContext, zone: string) => Promise<string>;
      assetsRoot: () => string;
    }
  ) {}

  private acc(ctx: CallContext): string {
    return `/accounts/${encodeURIComponent(this.o.accountId(ctx))}`;
  }

  private async secret(ctx: CallContext, b: SecretBinding): Promise<string> {
    if (!ctx.secrets) throw new CloudProviderError(`The secret ${b.name} needs the deployment's secret broker, which this call does not have.`, 'cloudflare', 409, 'no_secret_broker');
    return ctx.secrets.value(b);
  }

  private async missing<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  // ---------- hyperdrive ----------

  private hyperdriveObserved(c: CfHyperdrive, name: string): ObservedResource {
    // Never the password or the Access secret.
    return { type: 'hyperdrive', providerId: c.id, name, state: 'ready', tags: {}, props: { host: c.origin?.host ?? null, database: c.origin?.database ?? null, user: c.origin?.user ?? null, via: c.origin?.access_client_id ? 'tunnel' : 'direct', caching: { disabled: c.caching?.disabled ?? false } } };
  }

  private async hyperdriveBody(ctx: CallContext, spec: ResourceSpec): Promise<Record<string, unknown>> {
    const p = spec.props as { origin?: { databaseUrlRef?: string; via?: string; accessClientIdRef?: string; accessClientSecretRef?: string }; caching?: { disabled?: boolean } };
    const o = p.origin ?? {};
    if (!o.databaseUrlRef) throw new CloudProviderError('A Hyperdrive configuration names its database URL reference.', 'cloudflare', 400, 'no_database');
    const origin = hyperdriveOrigin(await this.secret(ctx, { name: 'database_url', env: 'DATABASE_URL', ref: o.databaseUrlRef }));
    const viaTunnel = o.via === 'tunnel';
    const access = viaTunnel && o.accessClientIdRef && o.accessClientSecretRef ? { access_client_id: await this.secret(ctx, { name: 'hyperdrive_access_client_id', env: 'HYPERDRIVE_ACCESS_CLIENT_ID', ref: o.accessClientIdRef }), access_client_secret: await this.secret(ctx, { name: 'hyperdrive_access_client_secret', env: 'HYPERDRIVE_ACCESS_CLIENT_SECRET', ref: o.accessClientSecretRef }) } : null;
    if (viaTunnel && !access) throw new CloudProviderError('Hyperdrive through a tunnel needs a Cloudflare Access service token (its id and secret references).', 'cloudflare', 400, 'no_access_token');
    // Through a tunnel Hyperdrive takes the host the tunnel publishes, with no port.
    const originBody = viaTunnel ? { scheme: origin.scheme, host: origin.host, database: origin.database, user: origin.user, password: origin.password, ...access } : origin;
    return { name: this.o.name(ctx, spec.name), origin: originBody, caching: { disabled: p.caching?.disabled ?? false } };
  }

  // ---------- worker ----------

  private workerObserved(name: string, logical: string, settings: { bindings?: { type: string; name: string }[]; assets?: { count?: number } } | null, domain: string | null): ObservedResource {
    const bindings = (settings?.bindings ?? []).map((b) => ({ type: b.type, name: b.name }));
    return { type: 'worker', providerId: name, name: logical, state: 'ready', tags: {}, props: { bindings, secrets: bindings.filter((b) => b.type === 'secret_text').map((b) => b.name).sort(), ...(domain ? { customDomain: domain } : {}) } };
  }

  private async uploadAssets(ctx: CallContext, script: string, prefixes: readonly string[]): Promise<{ jwt: string; files: number }> {
    const assets = await readAssets(this.o.assetsRoot(), prefixes);
    const manifest = Object.fromEntries(assets.map((a) => [a.path, { hash: assetHash(a), size: a.body.length }]));
    const s = await this.o.send<{ jwt: string; buckets?: string[][] }>(ctx, 'POST', `${this.acc(ctx)}/workers/scripts/${encodeURIComponent(script)}/assets-upload-session`, { body: { manifest } });
    let jwt = s.body.result.jwt;
    const byHash = new Map(assets.map((a) => [assetHash(a), a]));
    for (const bucket of s.body.result.buckets ?? []) {
      const parts = bucket.map((h) => {
        const a = byHash.get(h);
        if (!a) throw new CloudProviderError(`Cloudflare asked for an asset this build does not have (${h}).`, 'cloudflare', 502, 'asset_unknown');
        return { name: h, filename: h, contentType: 'application/octet-stream', body: a.body.toString('base64') };
      });
      const up = await this.o.send<{ jwt?: string }>(ctx, 'POST', `${this.acc(ctx)}/workers/assets/upload?base64=true`, { raw: multipart(parts), bearer: s.body.result.jwt });
      if (up.body.result?.jwt) jwt = up.body.result.jwt;
    }
    return { jwt, files: assets.length };
  }

  private async namespaceOf(ctx: CallContext, script: string, className: string): Promise<string> {
    const r = await this.o.send<{ id: string; script?: string; class?: string }[]>(ctx, 'GET', `${this.acc(ctx)}/workers/durable_objects/namespaces?per_page=1000`);
    const ns = (r.body.result ?? []).find((n) => n.script === script && n.class === className);
    if (!ns) throw new CloudProviderError(`The Worker ${script} has no Durable Object namespace for ${className}.`, 'cloudflare', 409, 'no_namespace');
    return ns.id;
  }

  private async putWorker(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    const p = spec.props as {
      compatibilityDate?: string;
      vars?: Record<string, string>;
      secrets?: SecretBinding[];
      hyperdrive?: string;
      r2?: { bucket: string; jurisdiction: R2Jurisdiction };
      assets?: { prefixes?: string[] };
      container?: { className: string; instances: number; port: number };
      customDomain?: { hostname: string; zone: string };
    };
    const name = this.o.name(ctx, spec.name);
    const refs = spec.parent?.refs ?? {};
    const vars: Record<string, string> = { ...(p.vars ?? {}) };
    if (p.r2) {
      vars.S3_ENDPOINT = r2Endpoint(this.o.accountId(ctx), p.r2.jurisdiction);
      if (refs[p.r2.bucket]) vars.S3_BUCKET = refs[p.r2.bucket]!;
    }
    const secrets = p.secrets ?? [];
    const prefixes = p.assets?.prefixes ?? [];
    const assets = prefixes.length ? await this.uploadAssets(ctx, name, prefixes) : null;
    const container = p.container;
    const hyperdriveId = p.hyperdrive ? refs[p.hyperdrive] : undefined;
    if (p.hyperdrive && !hyperdriveId) throw new CloudProviderError(`The Worker binds Hyperdrive ${p.hyperdrive}, which has no id yet.`, 'cloudflare', 409, 'dependency_missing');
    const bindings: Record<string, unknown>[] = [
      ...Object.entries(vars).map(([k, v]) => ({ type: 'plain_text', name: k, text: v })),
      ...(hyperdriveId ? [{ type: 'hyperdrive', name: 'HYPERDRIVE', id: hyperdriveId }] : []),
      ...(container ? [{ type: 'durable_object_namespace', name: 'APP', class_name: container.className }] : []),
      ...(assets ? [{ type: 'assets', name: 'ASSETS' }] : [])
    ];
    const metadata = {
      main_module: 'worker.js',
      compatibility_date: p.compatibilityDate ?? '2026-09-01',
      bindings,
      // Secrets set apart (`/secrets`) are kept when the script is uploaded again.
      keep_bindings: ['secret_text'],
      ...(assets ? { assets: { jwt: assets.jwt, config: { run_worker_first: true } } } : {}),
      ...(container ? { migrations: { new_tag: 'v1', new_sqlite_classes: [container.className] }, containers: [{ class_name: container.className }] } : {}),
      tags: Object.entries(spec.tags).map(([k, v]) => `${k}=${v}`).slice(0, 8)
    };
    const module = renderWorkerScript({ className: container?.className ?? 'ExprsnApp', instances: container?.instances ?? 1, port: container?.port ?? 8080, vars: Object.keys(vars), secrets: secrets.map((b) => b.env), prefixes });
    const r = await this.o.send<CfScript>(ctx, 'PUT', `${this.acc(ctx)}/workers/scripts/${encodeURIComponent(name)}`, { raw: multipart([{ name: 'metadata', contentType: 'application/json', body: JSON.stringify(metadata) }, { name: 'worker.js', filename: 'worker.js', contentType: 'application/javascript+module', body: module }]) });
    for (const b of secrets) {
      // The value goes from the vault to Cloudflare's secret store only: never into props, the journal or an error.
      await this.o.send(ctx, 'PUT', `${this.acc(ctx)}/workers/scripts/${encodeURIComponent(name)}/secrets`, { body: { name: b.env, text: await this.secret(ctx, b), type: 'secret_text' } });
    }
    let domain: string | null = null;
    if (p.customDomain) {
      const zoneId = await this.o.zoneId(ctx, p.customDomain.zone);
      await this.o.send(ctx, 'PUT', `${this.acc(ctx)}/workers/domains`, { body: { hostname: p.customDomain.hostname, service: name, environment: 'production', zone_id: zoneId } });
      domain = p.customDomain.hostname;
    }
    const observed = await this.describe(ctx, { type: 'worker', providerId: name });
    return { done: true, resource: observed ?? this.workerObserved(name, spec.name, null, domain), ...(r.requestId ? { requestId: r.requestId } : {}) };
  }

  // ---------- container_service ----------

  private containerObserved(a: CfContainerApp, name: string): ObservedResource {
    return { type: 'container_service', providerId: a.id, name, state: 'ready', tags: {}, props: { platform: 'cloudflare-containers', image: a.configuration?.image ?? null, instanceType: a.configuration?.instance_type ?? null, replicas: a.instances ?? null, namespace: a.durable_objects?.namespace_id ?? null } };
  }

  private async containerBody(ctx: CallContext, spec: ResourceSpec): Promise<Record<string, unknown>> {
    const p = spec.props as { image?: string | null; replicas?: number; instanceType?: string; worker?: string; className?: string };
    if (!p.image || !/@sha256:[a-f0-9]{64}$/.test(p.image)) throw new CloudProviderError('A Cloudflare container runs an image pinned by digest.', 'cloudflare', 400, 'image_not_pinned');
    const script = (p.worker && spec.parent?.refs?.[p.worker]) || null;
    if (!script) throw new CloudProviderError('A Cloudflare container runs behind its Worker, which has no script yet.', 'cloudflare', 409, 'dependency_missing');
    const namespace = await this.namespaceOf(ctx, script, p.className ?? 'ExprsnApp');
    return { name: this.o.name(ctx, spec.name), scheduling_policy: 'default', instances: p.replicas ?? 1, max_instances: p.replicas ?? 1, configuration: { image: p.image, instance_type: p.instanceType ?? 'standard-1' }, durable_objects: { namespace_id: namespace } };
  }

  // ---------- the operations ----------

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    const name = this.o.name(ctx, spec.name);
    switch (spec.type) {
      case 'worker':
        return this.describe(ctx, { type: 'worker', providerId: name });
      case 'hyperdrive': {
        const r = await this.o.send<CfHyperdrive[]>(ctx, 'GET', `${this.acc(ctx)}/hyperdrive/configs`);
        const c = (r.body.result ?? []).find((x) => x.name === name);
        return c ? this.hyperdriveObserved(c, spec.name) : null;
      }
      case 'container_service': {
        const r = await this.o.send<CfContainerApp[]>(ctx, 'GET', `${this.acc(ctx)}/containers/applications`);
        const a = (r.body.result ?? []).find((x) => x.name === name);
        return a ? this.containerObserved(a, spec.name) : null;
      }
    }
    return null;
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    switch (ref.type) {
      case 'worker': {
        const s = await this.missing(this.o.send<{ bindings?: { type: string; name: string }[] }>(ctx, 'GET', `${this.acc(ctx)}/workers/scripts/${encodeURIComponent(ref.providerId)}/settings`));
        if (!s) return null;
        const d = await this.o.send<{ hostname: string; service: string }[]>(ctx, 'GET', `${this.acc(ctx)}/workers/domains?service=${encodeURIComponent(ref.providerId)}`).catch(() => null);
        return this.workerObserved(ref.providerId, ref.providerId, s.body.result, d?.body.result?.[0]?.hostname ?? null);
      }
      case 'hyperdrive': {
        const r = await this.missing(this.o.send<CfHyperdrive>(ctx, 'GET', `${this.acc(ctx)}/hyperdrive/configs/${encodeURIComponent(ref.providerId)}`));
        return r ? this.hyperdriveObserved(r.body.result, r.body.result.name) : null;
      }
      case 'container_service': {
        const r = await this.missing(this.o.send<CfContainerApp>(ctx, 'GET', `${this.acc(ctx)}/containers/applications/${encodeURIComponent(ref.providerId)}`));
        return r ? this.containerObserved(r.body.result, r.body.result.name) : null;
      }
    }
    return null;
  }

  async list(ctx: CallContext, type: 'worker' | 'hyperdrive' | 'container_service', prefix: string | null): Promise<ObservedResource[]> {
    const keep = (n: string) => !prefix || n.startsWith(prefix);
    const logical = (n: string) => (prefix && n.startsWith(prefix) ? n.slice(prefix.length) : n);
    if (type === 'worker') {
      const r = await this.o.send<CfScript[]>(ctx, 'GET', `${this.acc(ctx)}/workers/scripts`);
      return (r.body.result ?? []).filter((x) => keep(x.id)).map((x) => this.workerObserved(x.id, logical(x.id), null, null));
    }
    if (type === 'hyperdrive') {
      const r = await this.o.send<CfHyperdrive[]>(ctx, 'GET', `${this.acc(ctx)}/hyperdrive/configs`);
      return (r.body.result ?? []).filter((x) => keep(x.name)).map((x) => this.hyperdriveObserved(x, logical(x.name)));
    }
    const r = await this.o.send<CfContainerApp[]>(ctx, 'GET', `${this.acc(ctx)}/containers/applications`);
    return (r.body.result ?? []).filter((x) => keep(x.name)).map((x) => this.containerObserved(x, logical(x.name)));
  }

  async create(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    const existing = await this.find(ctx, spec);
    switch (spec.type) {
      case 'worker':
        // A script is uploaded whole: an existing one is replaced with this build's (adopted by name).
        return { ...(await this.putWorker(ctx, spec)), ...(existing ? { adopted: true } : {}) };
      case 'hyperdrive': {
        if (existing) return { done: true, resource: existing, adopted: true };
        const r = await this.o.send<CfHyperdrive>(ctx, 'POST', `${this.acc(ctx)}/hyperdrive/configs`, { body: await this.hyperdriveBody(ctx, spec) });
        return { done: true, resource: this.hyperdriveObserved(r.body.result, spec.name), ...(r.requestId ? { requestId: r.requestId } : {}) };
      }
      case 'container_service': {
        if (existing) return { done: true, resource: existing, adopted: true };
        const r = await this.o.send<CfContainerApp>(ctx, 'POST', `${this.acc(ctx)}/containers/applications`, { body: await this.containerBody(ctx, spec) });
        return { done: true, resource: this.containerObserved(r.body.result, spec.name), ...(r.requestId ? { requestId: r.requestId } : {}) };
      }
    }
    throw new CloudProviderError(`${spec.type} is not part of the Cloudflare app tier.`, 'cloudflare', 400, 'wrong_type');
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec): Promise<OperationResult> {
    switch (ref.type) {
      case 'worker':
        return this.putWorker(ctx, spec);
      case 'hyperdrive': {
        const r = await this.o.send<CfHyperdrive>(ctx, 'PUT', `${this.acc(ctx)}/hyperdrive/configs/${encodeURIComponent(ref.providerId)}`, { body: await this.hyperdriveBody(ctx, spec) });
        return { done: true, resource: this.hyperdriveObserved(r.body.result, spec.name) };
      }
      case 'container_service': {
        // A new image or instance count is a rollout of the application.
        const body = await this.containerBody(ctx, spec);
        const r = await this.o.send<CfContainerApp>(ctx, 'PATCH', `${this.acc(ctx)}/containers/applications/${encodeURIComponent(ref.providerId)}`, { body: { instances: body.instances, max_instances: body.max_instances, configuration: body.configuration } });
        return { done: true, resource: this.containerObserved(r.body.result, spec.name) };
      }
    }
    throw new CloudProviderError(`${ref.type} is not part of the Cloudflare app tier.`, 'cloudflare', 400, 'wrong_type');
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    const gone = async (p: Promise<unknown>) => void (await this.missing(p));
    switch (ref.type) {
      case 'worker': {
        const d = await this.o.send<{ id: string; hostname: string }[]>(ctx, 'GET', `${this.acc(ctx)}/workers/domains?service=${encodeURIComponent(ref.providerId)}`).catch(() => null);
        for (const x of d?.body.result ?? []) await gone(this.o.send(ctx, 'DELETE', `${this.acc(ctx)}/workers/domains/${encodeURIComponent(x.id)}`));
        await gone(this.o.send(ctx, 'DELETE', `${this.acc(ctx)}/workers/scripts/${encodeURIComponent(ref.providerId)}?force=true`));
        return { done: true, resource: null };
      }
      case 'hyperdrive':
        await gone(this.o.send(ctx, 'DELETE', `${this.acc(ctx)}/hyperdrive/configs/${encodeURIComponent(ref.providerId)}`));
        return { done: true, resource: null };
      case 'container_service':
        await gone(this.o.send(ctx, 'DELETE', `${this.acc(ctx)}/containers/applications/${encodeURIComponent(ref.providerId)}`));
        return { done: true, resource: null };
    }
    throw new CloudProviderError(`${ref.type} is not part of the Cloudflare app tier.`, 'cloudflare', 400, 'wrong_type');
  }
}

/** The adapter's `send` over its transport: the API token (or an asset upload JWT) and a JSON or raw body. */
export function cloudflareSend(transport: CloudTransport, base: () => string): Send {
  return async <T>(ctx: CallContext, method: string, p: string, o: { body?: unknown; raw?: { contentType: string; body: Buffer }; bearer?: string } = {}) => {
    if (ctx.cred.kind !== 'token') throw new CloudProviderError('A Cloudflare account needs an API token.', 'cloudflare', 400, 'wrong_credential');
    const headers: Record<string, string> = { authorization: `Bearer ${o.bearer ?? ctx.cred.token}`, ...(o.raw ? { 'content-type': o.raw.contentType } : {}) };
    const body = o.raw ? o.raw.body : o.body !== undefined ? JSON.stringify(o.body) : undefined;
    const r = await transport.json<{ result: T }>({ method, url: `${base()}${p}`, headers, ...(body !== undefined ? { body } : {}), accountId: ctx.account.id, ...(ctx.signal ? { signal: ctx.signal } : {}) }, (status, b) => {
      const e = ((b ?? {}) as { errors?: { code: number; message: string }[] }).errors?.[0];
      return { message: `Cloudflare answered ${status}${e ? ` (${e.code})` : ''}: ${(e?.message ?? 'no detail').slice(0, 300)}`, code: e ? String(e.code) : null };
    });
    return { status: r.status, body: r.body, requestId: r.requestId };
  };
}
