import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { ulid } from 'ulid';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { checkUrl, guardedAgent, HostRefused, parseAllowList } from '../mcp/hosts.js';
import { json } from '../db/knex.js';
import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import { scrubSecrets } from '../platform/diagnostics.js';
import { badRequest, conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { audit, type OpsActor } from './common.js';
import type { MirrorKind, MirrorRow } from './mirrors.js';
import { tarStream } from './tar.js';

/*
 * B-909: pushing promoted artefacts into the registries behind the mirrors, through their own HTTP APIs (plain
 * fetch, no SDKs), instead of leaving it to each mirror's sync from `mirrors/<kind>/`:
 *
 * - images → Harbor, or any OCI distribution registry: each image file is an OCI image layout tar (`oci-layout`,
 *   `index.json`, `blobs/sha256/...`); blobs go up with POST /v2/<repo>/blobs/uploads/ and a monolithic PUT (skipped
 *   when HEAD finds them), then the manifests, then the tag. Basic credentials, exchanged for a bearer token when the
 *   registry asks (the Docker token flow Harbor uses). The repository is `<project>/<name>`, the name and tag coming
 *   from the `io.containerd.image.name` / `org.opencontainers.image.ref.name` annotations or the file name.
 * - npm → Verdaccio (or any npm registry): the npm publish document (PUT /<name> with the tarball as a base64
 *   attachment), name and version read from `package/package.json` inside the tarball; a bearer token, or basic.
 * - pypi → devpi (or any legacy upload API): a multipart `:action=file_upload` POST to the index URL
 *   (`<url>/<user>/<index>/`), name and version from the wheel or sdist file name; basic credentials.
 *
 * A push target belongs to one mirror; its secret is sealed with the platform data key. Targets must be internal
 * hosts (PLATFORM_ALLOWED_HOSTS for others), checked again at connect time. Every file's outcome is recorded.
 */

export const PUSH_KIND: Partial<Record<MirrorKind, 'oci' | 'npm' | 'pypi'>> = { images: 'oci', npm: 'npm', pypi: 'pypi' };
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_SMALL_BLOB = 4 * 1024 * 1024;

export interface PushTargetRow {
  id: string;
  mirror_id: string;
  kind: 'oci' | 'npm' | 'pypi';
  url: string;
  repository: string | null;
  username: string | null;
  secret_sealed: string | null;
  state: 'active' | 'disabled';
  last_push_at: number | null;
  last_push_ok: boolean | null;
  last_detail: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface PushRow {
  id: string;
  bundle_id: string;
  target_id: string;
  path: string;
  sha256: string;
  artefact: string | null;
  state: 'pushed' | 'exists' | 'failed';
  detail: string | null;
  at: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const targetFrom = (r: Record<string, unknown>): PushTargetRow => ({ ...(r as unknown as PushTargetRow), last_push_at: num(r.last_push_at), last_push_ok: r.last_push_ok == null ? null : Boolean(r.last_push_ok), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export const targetView = (t: PushTargetRow) => ({ id: t.id, mirrorId: t.mirror_id, kind: t.kind, url: t.url, repository: t.repository, username: t.username, hasSecret: !!t.secret_sealed, state: t.state, lastPushAt: t.last_push_at, lastPushOk: t.last_push_ok, lastDetail: t.last_detail, updatedAt: t.updated_at });
export const pushView = (p: PushRow) => ({ id: p.id, bundleId: p.bundle_id, targetId: p.target_id, path: p.path, sha256: p.sha256, artefact: p.artefact, state: p.state, detail: p.detail, at: Number(p.at) });

class PushError extends Error {}

interface Creds {
  username: string | null;
  secret: string | null;
}

const basic = (c: Creds) => (c.username ? `Basic ${Buffer.from(`${c.username}:${c.secret ?? ''}`).toString('base64')}` : null);

/** Reads name and version from an npm tarball's package/package.json. */
export async function npmManifest(tgz: Buffer): Promise<Record<string, unknown> & { name: string; version: string }> {
  const gunzip = Readable.from([tgz]).pipe(createGunzip());
  for await (const e of tarStream(gunzip as AsyncIterable<Buffer>)) {
    if (e.path === 'package/package.json') {
      const pkg = JSON.parse((await e.buffer(1024 * 1024)).toString('utf8')) as Record<string, unknown>;
      if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') throw new PushError('package.json has no name or version.');
      if (!/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(pkg.name) || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new PushError(`${String(pkg.name)}@${String(pkg.version)} is not a valid npm name and version.`);
      return pkg as Record<string, unknown> & { name: string; version: string };
    }
  }
  throw new PushError('The tarball has no package/package.json.');
}

/** Name and version from a wheel (`name-ver-py-abi-plat.whl`) or sdist (`name-ver.tar.gz`) file name. */
export function pythonDist(file: string): { name: string; version: string; filetype: 'bdist_wheel' | 'sdist'; pyversion: string } {
  const base = file.split('/').pop()!;
  const whl = /^([A-Za-z0-9_.]+)-([0-9][A-Za-z0-9_.!+]*)(-\d[^-]*)?-([^-]+)-([^-]+)-([^-]+)\.whl$/.exec(base);
  if (whl) return { name: whl[1]!, version: whl[2]!, filetype: 'bdist_wheel', pyversion: whl[4]! };
  const sd = /^([A-Za-z0-9_.-]+?)-([0-9][A-Za-z0-9_.!+]*)\.(tar\.gz|zip)$/.exec(base);
  if (sd) return { name: sd[1]!, version: sd[2]!, filetype: 'sdist', pyversion: 'source' };
  throw new PushError(`${base} is not a wheel or sdist file name.`);
}

export class PushService {
  constructor(private readonly s: () => Services) {}

  private allow() {
    return parseAllowList(this.s().cfg.PLATFORM_ALLOWED_HOSTS);
  }

  async targets(): Promise<PushTargetRow[]> {
    return ((await this.s().db('platform_push_targets').orderBy('created_at')) as Record<string, unknown>[]).map(targetFrom);
  }

  async target(mirrorId: string): Promise<PushTargetRow | null> {
    const r = (await this.s().db('platform_push_targets').where({ mirror_id: mirrorId }).first()) as Record<string, unknown> | undefined;
    return r ? targetFrom(r) : null;
  }

  /** Sets (or replaces) a mirror's push target. The secret is sealed; leaving it out keeps the stored one. */
  async setTarget(by: OpsActor, mirror: MirrorRow, input: { url: string; repository?: string | null; username?: string | null; secret?: string | null; state?: 'active' | 'disabled' }): Promise<PushTargetRow> {
    const kind = PUSH_KIND[mirror.kind];
    if (!kind) throw badRequest(`Pushing is available for image, npm and PyPI mirrors; ${mirror.name} holds ${mirror.kind}.`);
    try {
      await checkUrl(input.url, this.allow());
    } catch (err) {
      if (err instanceof HostRefused) throw badRequest(err.message, { field: 'url' });
      throw err;
    }
    if (kind === 'oci' && !input.repository) throw badRequest('Give the Harbor project (or registry namespace) images go under.', { field: 'repository' });
    const cur = await this.target(mirror.id);
    const id = cur?.id ?? ulid();
    const t = Date.now();
    const row = {
      kind, url: input.url.replace(/\/+$/, ''), repository: input.repository ?? null, username: input.username ?? null,
      secret_sealed: input.secret === undefined ? (cur?.secret_sealed ?? null) : input.secret ? await this.s().keys.seal(PLATFORM_SCOPE, input.secret, `platform-push:${id}`) : null,
      state: input.state ?? cur?.state ?? 'active', updated_at: t
    };
    if (cur) await this.s().db('platform_push_targets').where({ id }).update(row);
    else await this.s().db('platform_push_targets').insert({ id, mirror_id: mirror.id, ...row, created_by: by.userId, created_at: t });
    await audit(this.s(), by, cur ? 'platform.push.target.updated' : 'platform.push.target.created', { mirror: mirror.id, name: mirror.name, target: id }, { kind, url: row.url, repository: row.repository, username: row.username, secretChanged: input.secret !== undefined, state: row.state }, 'admin');
    return (await this.target(mirror.id))!;
  }

  async removeTarget(by: OpsActor, mirror: MirrorRow): Promise<void> {
    const cur = await this.target(mirror.id);
    if (!cur) throw notFound('Push target');
    await this.s().db('platform_push_targets').where({ id: cur.id }).delete();
    await audit(this.s(), by, 'platform.push.target.removed', { mirror: mirror.id, name: mirror.name, target: cur.id }, { url: cur.url }, 'admin');
  }

  async pushes(bundleId: string): Promise<PushRow[]> {
    return (await this.s().db('platform_pushes').where({ bundle_id: bundleId }).orderBy('at')) as PushRow[];
  }

  /** Queues a push of a promoted bundle (after promotion, or again by hand). */
  async request(by: OpsActor, bundleId: string): Promise<{ jobId: string } | null> {
    const b = await this.s().ops.bundles.get(bundleId);
    if (b.state !== 'in production') throw conflict(`Only a promoted bundle is pushed; this one is ${b.state}.`);
    const targets = (await this.targets()).filter((t) => t.state === 'active');
    if (!targets.length) return null;
    const job = await this.s().jobs.enqueue({ tenantId: by.tenantId, type: 'ops.bundle.push', payload: { bundleId }, createdBy: by.userId, maxAttempts: 1 });
    await audit(this.s(), by, 'platform.bundle.push.requested', { bundle: bundleId, name: b.name }, { job: job.id, targets: targets.map((t) => t.id) });
    return { jobId: job.id };
  }

  /** The push job: every file of the bundle whose mirror has an active target goes to that registry. */
  async run(bundleId: string, by: OpsActor, progress: (pct: number, msg: string) => Promise<void>): Promise<{ pushed: number; exists: number; failed: number }> {
    const s = this.s();
    const b = await s.ops.bundles.get(bundleId);
    const mirrors = await s.ops.mirrors.list();
    const targets = (await this.targets()).filter((t) => t.state === 'active');
    const counts = { pushed: 0, exists: 0, failed: 0 };
    const work: { t: PushTargetRow; m: MirrorRow; file: { path: string; sha256: string; size: number } }[] = [];
    for (const t of targets) {
      const m = mirrors.find((x) => x.id === t.mirror_id);
      if (!m) continue;
      const raw = await s.blobs.get(`mirrors/${m.kind}/index/${b.name}.json`);
      if (!raw) continue;
      for (const file of json<{ files: { path: string; sha256: string; size: number }[] }>(raw.toString('utf8'), { files: [] }).files) work.push({ t, m, file });
    }
    const agent = guardedAgent(this.allow(), 5 * 60_000);
    try {
      for (const [i, w] of work.entries()) {
        let state: PushRow['state'] = 'failed';
        let artefact: string | null = null;
        let detail: string;
        const creds = await this.creds(w.t);
        try {
          await checkUrl(w.t.url, this.allow());
          const key = `mirrors/${w.m.kind}/sha256/${w.file.sha256}`;
          const r = w.t.kind === 'npm' ? await this.pushNpm(w.t, creds, key, agent) : w.t.kind === 'pypi' ? await this.pushPypi(w.t, creds, key, w.file.path, agent) : await this.pushOci(w.t, creds, key, w.file.path, agent);
          state = r.exists ? 'exists' : 'pushed';
          artefact = r.artefact;
          detail = r.exists ? `${r.artefact} was already there` : `Pushed ${r.artefact}`;
        } catch (err) {
          detail = scrubSecrets((err as Error & { cause?: Error }).cause?.message ?? (err as Error).message, [creds.secret]);
        }
        counts[state === 'pushed' ? 'pushed' : state === 'exists' ? 'exists' : 'failed']++;
        const at = Date.now();
        await s.db('platform_pushes').insert({ id: ulid(), bundle_id: bundleId, target_id: w.t.id, path: w.file.path.slice(0, 500), sha256: w.file.sha256, artefact: artefact?.slice(0, 300) ?? null, state, detail: detail.slice(0, 500), at });
        await s.db('platform_push_targets').where({ id: w.t.id }).update({ last_push_at: at, last_push_ok: state !== 'failed', last_detail: detail.slice(0, 500) });
        await progress(Math.round(((i + 1) * 100) / work.length), `${w.file.path}: ${state}`);
      }
    } finally {
      await agent.close().catch(() => undefined);
    }
    await audit(s, by, counts.failed ? 'platform.bundle.push.failed' : 'platform.bundle.pushed', { bundle: bundleId, name: b.name }, { ...counts, files: work.length });
    return counts;
  }

  private async creds(t: PushTargetRow): Promise<Creds> {
    return { username: t.username, secret: t.secret_sealed ? await this.s().keys.open(PLATFORM_SCOPE, t.secret_sealed, `platform-push:${t.id}`) : null };
  }

  private async read(key: string, max = MAX_PACKAGE_BYTES): Promise<Buffer> {
    const got = await this.s().blobs.getStream(key);
    if (!got) throw new PushError('The promoted file is missing from the mirror store.');
    if (got.size > max) throw new PushError(`The file is larger than ${max} bytes.`);
    const parts: Buffer[] = [];
    for await (const c of got.stream as AsyncIterable<Buffer>) parts.push(c);
    return Buffer.concat(parts);
  }

  // ---------- npm (Verdaccio) ----------

  private async pushNpm(t: PushTargetRow, c: Creds, key: string, dispatcher: Dispatcher): Promise<{ artefact: string; exists: boolean }> {
    const tgz = await this.read(key);
    const pkg = await npmManifest(tgz);
    const artefact = `${pkg.name}@${pkg.version}`;
    const file = `${pkg.name.replace(/^@[^/]+\//, '')}-${pkg.version}.tgz`;
    const pathName = pkg.name.startsWith('@') ? `@${encodeURIComponent(pkg.name.slice(1))}` : encodeURIComponent(pkg.name);
    const shasum = createHash('sha1').update(tgz).digest('hex');
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    const doc = {
      _id: pkg.name,
      name: pkg.name,
      description: typeof pkg.description === 'string' ? pkg.description : undefined,
      'dist-tags': { latest: pkg.version },
      versions: { [pkg.version]: { ...pkg, _id: artefact, dist: { shasum, integrity, tarball: `${t.url}/${pathName}/-/${file}` } } },
      _attachments: { [file]: { content_type: 'application/octet-stream', data: tgz.toString('base64'), length: tgz.length } }
    };
    const auth = c.secret && !c.username ? `Bearer ${c.secret}` : basic(c);
    const res = await undiciFetch(`${t.url}/${pathName}`, { method: 'PUT', headers: { 'content-type': 'application/json', accept: 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(doc), dispatcher, redirect: 'error', signal: AbortSignal.timeout(5 * 60_000) });
    const text = await res.text().catch(() => '');
    if (res.status === 409 || (res.status === 403 && /already|cannot publish over/i.test(text))) return { artefact, exists: true };
    if (!res.ok) throw new PushError(`The npm registry answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    return { artefact, exists: false };
  }

  // ---------- PyPI (devpi) ----------

  private async pushPypi(t: PushTargetRow, c: Creds, key: string, path: string, dispatcher: Dispatcher): Promise<{ artefact: string; exists: boolean }> {
    const dist = pythonDist(path);
    const data = await this.read(key);
    const boundary = `exprsn-${ulid()}`;
    const field = (name: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const filename = path.split('/').pop()!.replace(/"/g, '');
    const body = Buffer.concat([
      field(':action', 'file_upload'),
      field('protocol_version', '1'),
      field('metadata_version', '2.1'),
      field('name', dist.name),
      field('version', dist.version),
      field('filetype', dist.filetype),
      field('pyversion', dist.pyversion),
      field('sha256_digest', createHash('sha256').update(data).digest('hex')),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const url = `${t.url}/${(t.repository ?? '').replace(/^\/+|\/+$/g, '')}${t.repository ? '/' : ''}`;
    const auth = basic(c);
    const res = await undiciFetch(url, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...(auth ? { authorization: auth } : {}) }, body, dispatcher, redirect: 'error', signal: AbortSignal.timeout(5 * 60_000) });
    const text = await res.text().catch(() => '');
    const artefact = `${dist.name}==${dist.version} (${filename})`;
    if (res.status === 409) return { artefact, exists: true };
    if (!res.ok) throw new PushError(`The package index answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    return { artefact, exists: false };
  }

  // ---------- OCI (Harbor) ----------

  private async pushOci(t: PushTargetRow, c: Creds, key: string, path: string, dispatcher: Dispatcher): Promise<{ artefact: string; exists: boolean }> {
    const reg = new OciRegistry(t.url, c, dispatcher);
    // Pass 1: the index and every small blob (manifests and configs); large layers are only sized.
    const small = new Map<string, Buffer>();
    type OciIndex = { manifests?: { digest: string; mediaType?: string; annotations?: Record<string, string> }[] };
    let index = null as OciIndex | null;
    for await (const e of tarStream(await this.stream(key))) {
      if (e.path === 'index.json') index = JSON.parse((await e.buffer(MAX_SMALL_BLOB)).toString('utf8')) as OciIndex;
      else if (e.path.startsWith('blobs/sha256/') && e.size <= MAX_SMALL_BLOB) small.set(`sha256:${e.path.slice('blobs/sha256/'.length)}`, await e.buffer(MAX_SMALL_BLOB));
    }
    const top = index?.manifests?.[0];
    if (!top) throw new PushError(`${path} is not an OCI image layout (no index.json manifest).`);
    const ann = top.annotations ?? {};
    const full = ann['io.containerd.image.name'] ?? '';
    const base = path.split('/').pop()!.replace(/\.(tar|oci)$/, '');
    const name = (full ? full.split('/').pop()!.split(':')[0]! : base.split(':')[0]!).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const refName = ann['org.opencontainers.image.ref.name'] ?? (full.includes(':') ? full.split(':').pop()! : 'latest');
    const tag = (refName.includes(':') ? refName.split(':').pop()! : refName).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 128) || 'latest';
    const repo = `${t.repository!.replace(/^\/+|\/+$/g, '')}/${name}`;
    // Which blobs the manifests need, and the manifests to put (children before an index).
    const manifests: { digest: string; mediaType: string; body: Buffer }[] = [];
    const need = new Set<string>();
    const visit = (digest: string, mediaType?: string) => {
      const body = small.get(digest);
      if (!body) throw new PushError(`Manifest ${digest} is missing from ${path}.`);
      const m = JSON.parse(body.toString('utf8')) as { mediaType?: string; manifests?: { digest: string; mediaType?: string }[]; config?: { digest: string }; layers?: { digest: string }[] };
      const type = m.mediaType ?? mediaType ?? (m.manifests ? 'application/vnd.oci.image.index.v1+json' : 'application/vnd.oci.image.manifest.v1+json');
      if (m.manifests) for (const child of m.manifests) visit(child.digest, child.mediaType);
      if (m.config) need.add(m.config.digest);
      for (const l of m.layers ?? []) need.add(l.digest);
      manifests.push({ digest, mediaType: type, body });
    };
    visit(top.digest, top.mediaType);
    let uploaded = 0;
    for (const d of need) {
      const b = small.get(d);
      if (!b) continue;
      if (await reg.upload(repo, d, b.length, [b])) uploaded++;
    }
    // Pass 2: stream the large layers.
    for await (const e of tarStream(await this.stream(key))) {
      if (!e.path.startsWith('blobs/sha256/')) continue;
      const d = `sha256:${e.path.slice('blobs/sha256/'.length)}`;
      if (!need.has(d) || small.has(d)) continue;
      if (await reg.upload(repo, d, e.size, e.body())) uploaded++;
    }
    for (const m of manifests) await reg.putManifest(repo, m.digest, m.mediaType, m.body);
    await reg.putManifest(repo, tag, manifests[manifests.length - 1]!.mediaType, manifests[manifests.length - 1]!.body);
    return { artefact: `${repo}:${tag}`, exists: uploaded === 0 && need.size > 0 && (await reg.hadTag()) };
  }

  private async stream(key: string): Promise<AsyncIterable<Buffer>> {
    const got = await this.s().blobs.getStream(key);
    if (!got) throw new PushError('The promoted file is missing from the mirror store.');
    return got.stream as AsyncIterable<Buffer>;
  }
}

/** A small OCI distribution client: token auth, blob uploads (HEAD, POST, monolithic PUT), manifests. */
class OciRegistry {
  private token: string | null = null;
  private tagExisted = false;

  constructor(
    private readonly base: string,
    private readonly c: Creds,
    private readonly dispatcher: Dispatcher
  ) {}

  async hadTag(): Promise<boolean> {
    return this.tagExisted;
  }

  private async req(method: string, url: string, init: { headers?: Record<string, string>; body?: Buffer | AsyncIterable<Buffer>; length?: number } = {}): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = this.token ? `Bearer ${this.token}` : basic(this.c);
      const body = init.body === undefined ? undefined : Buffer.isBuffer(init.body) ? init.body : Readable.from(init.body);
      const res = await undiciFetch(url, { method, headers: { ...(init.headers ?? {}), ...(auth ? { authorization: auth } : {}), ...(init.length != null ? { 'content-length': String(init.length) } : {}) }, body: body as never, ...(body && !Buffer.isBuffer(body) ? { duplex: 'half' } : {}), dispatcher: this.dispatcher, redirect: 'manual', signal: AbortSignal.timeout(30 * 60_000) } as never);
      if (res.status !== 401 || attempt === 1 || (init.body && !Buffer.isBuffer(init.body))) return res;
      const challenge = res.headers.get('www-authenticate') ?? '';
      await res.body?.cancel().catch(() => undefined);
      const m = /^Bearer\s+(.*)$/i.exec(challenge);
      if (!m) return res;
      const params = Object.fromEntries([...m[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1]!, x[2]!]));
      if (!params.realm) return res;
      const q = new URLSearchParams({ ...(params.service ? { service: params.service } : {}), ...(params.scope ? { scope: params.scope } : {}) });
      const tr = await undiciFetch(`${params.realm}?${q}`, { headers: basic(this.c) ? { authorization: basic(this.c)! } : {}, dispatcher: this.dispatcher, signal: AbortSignal.timeout(30_000) });
      if (!tr.ok) throw new PushError(`The registry's token service answered ${tr.status}.`);
      const tj = (await tr.json()) as { token?: string; access_token?: string };
      this.token = tj.token ?? tj.access_token ?? null;
      if (!this.token) throw new PushError('The registry\'s token service returned no token.');
    }
    throw new PushError('unreachable');
  }

  /** Uploads one blob unless the registry has it; returns whether it uploaded. */
  async upload(repo: string, digest: string, size: number, body: AsyncIterable<Buffer> | Buffer[]): Promise<boolean> {
    const head = await this.req('HEAD', `${this.base}/v2/${repo}/blobs/${digest}`);
    if (head.status === 200) {
      if (!Array.isArray(body)) for await (const c of body) void c;
      return false;
    }
    const start = await this.req('POST', `${this.base}/v2/${repo}/blobs/uploads/`);
    await start.body?.cancel().catch(() => undefined);
    if (start.status !== 202) throw new PushError(`The registry refused an upload to ${repo} (${start.status}).`);
    const loc = start.headers.get('location');
    if (!loc) throw new PushError('The registry gave no upload location.');
    const url = new URL(loc, this.base);
    url.searchParams.set('digest', digest);
    const res = await this.req('PUT', url.toString(), { headers: { 'content-type': 'application/octet-stream' }, body: Array.isArray(body) ? Buffer.concat(body) : body, length: size });
    const text = await res.text().catch(() => '');
    if (res.status !== 201) throw new PushError(`The registry refused blob ${digest.slice(0, 19)} (${res.status}${text ? `: ${text.slice(0, 200)}` : ''}).`);
    return true;
  }

  async putManifest(repo: string, reference: string, mediaType: string, body: Buffer): Promise<void> {
    if (!reference.startsWith('sha256:')) {
      const head = await this.req('HEAD', `${this.base}/v2/${repo}/manifests/${reference}`, { headers: { accept: mediaType } });
      this.tagExisted = head.status === 200 && head.headers.get('docker-content-digest') === `sha256:${createHash('sha256').update(body).digest('hex')}`;
    }
    const res = await this.req('PUT', `${this.base}/v2/${repo}/manifests/${reference}`, { headers: { 'content-type': mediaType }, body });
    const text = await res.text().catch(() => '');
    if (res.status !== 201 && res.status !== 200) throw new PushError(`The registry refused the manifest ${reference.slice(0, 19)} (${res.status}${text ? `: ${text.slice(0, 200)}` : ''}).`);
  }
}
