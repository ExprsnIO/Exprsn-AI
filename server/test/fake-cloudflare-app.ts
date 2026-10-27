/*
 * 1.9.99-final, Sprint 61 (B-10905): the Cloudflare app tier for `fake-cloudflare.ts`: Workers scripts uploaded as
 * multipart (metadata and module kept, a Durable Object namespace made for each container class), their settings,
 * secrets (kept by name; the values only so a test can compare them, never in an answer), static asset upload
 * sessions (the manifest, the buckets asked for, the upload with the session's JWT, the completion JWT), custom
 * domains, Hyperdrive configurations (the origin's password required and never answered) and Containers
 * applications. The permission groups are checked by `fake-cloudflare.ts`. It is never the real Cloudflare.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { json, type RecordedRequest, type Reply } from './fake-cloud-base.js';

export interface FakeScript {
  id: string;
  metadata: Record<string, unknown>;
  module: string;
  secrets: Map<string, string>;
  /** The asset paths the script's completion JWT stands for. */
  assets: string[];
  created_on: string;
}

/** The parts of a multipart/form-data body. */
export function parseMultipart(contentType: string, raw: Buffer): { name: string; filename: string | null; contentType: string | null; body: Buffer }[] {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) return [];
  const text = raw.toString('latin1');
  return text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((chunk) => {
      const part = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
      const i = part.indexOf('\r\n\r\n');
      const head = part.slice(0, i);
      const body = Buffer.from(part.slice(i + 4), 'latin1');
      return { name: /name="([^"]+)"/.exec(head)?.[1] ?? '', filename: /filename="([^"]+)"/.exec(head)?.[1] ?? null, contentType: /Content-Type: ([^\r\n]+)/i.exec(head)?.[1] ?? null, body };
    });
}

export class FakeCloudflareApp {
  readonly scripts = new Map<string, FakeScript>();
  readonly namespaces: { id: string; name: string; script: string; class: string }[] = [];
  readonly domains: { id: string; hostname: string; service: string; zone_id: string; environment: string }[] = [];
  readonly hyperdrives = new Map<string, { id: string; name: string; origin: Record<string, unknown>; caching: Record<string, unknown> }>();
  readonly containers = new Map<string, Record<string, unknown> & { id: string; name: string }>();
  /** Upload sessions by JWT: the manifest's hashes still to upload, and what was uploaded. */
  private readonly sessions = new Map<string, { script: string; manifest: Record<string, { hash: string; size: number }>; pending: Set<string> }>();
  private readonly completions = new Map<string, { script: string; paths: string[] }>();
  readonly uploaded = new Map<string, Buffer>();

  matches(path: string): boolean {
    return /^\/accounts\/[^/]+\/(workers\/(scripts|assets|durable_objects|domains)|hyperdrive\/configs|containers\/applications)/.test(path);
  }

  /** The asset upload is authenticated with the session's JWT, not an API token. */
  acceptsJwt(path: string, bearer: string): boolean {
    return /^\/accounts\/[^/]+\/workers\/assets\/upload$/.test(path) && this.sessions.has(bearer);
  }

  private ok(result: unknown, status = 200): Reply {
    return { status, body: { success: true, errors: [], messages: [], result } };
  }

  private err(status: number, code: number, message: string): Reply {
    return { status, body: { success: false, errors: [{ code, message }], messages: [], result: null } };
  }

  route(r: RecordedRequest, path: string): Reply {
    const now = new Date().toISOString();
    const b = (r.headers['content-type'] ?? '').startsWith('application/json') ? json(r) : {};
    let m: RegExpExecArray | null;

    // ---------- static assets ----------
    if ((m = /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/assets-upload-session$/.exec(path)) && r.method === 'POST') {
      const manifest = (b.manifest ?? {}) as Record<string, { hash: string; size: number }>;
      const jwt = `aus.${randomBytes(12).toString('hex')}`;
      const hashes = [...new Set(Object.values(manifest).map((x) => x.hash))];
      this.sessions.set(jwt, { script: decodeURIComponent(m[1]!), manifest, pending: new Set(hashes) });
      const completion = `auc.${randomBytes(12).toString('hex')}`;
      this.completions.set(completion, { script: decodeURIComponent(m[1]!), paths: Object.keys(manifest) });
      // Two buckets when there are several files, as Cloudflare splits them.
      const buckets = hashes.length > 1 ? [hashes.slice(0, Math.ceil(hashes.length / 2)), hashes.slice(Math.ceil(hashes.length / 2))] : hashes.length ? [hashes] : [];
      return this.ok({ jwt: buckets.length ? jwt : completion, buckets });
    }
    if (/^\/accounts\/[^/]+\/workers\/assets\/upload$/.test(path) && r.method === 'POST') {
      const jwt = /^Bearer (.+)$/.exec(r.headers.authorization ?? '')?.[1] ?? '';
      const s = this.sessions.get(jwt);
      if (!s) return this.err(401, 10000, 'Authentication error');
      for (const p of parseMultipart(r.headers['content-type'] ?? '', r.raw ?? Buffer.alloc(0))) {
        if (!s.pending.has(p.name)) return this.err(400, 10204, `Unexpected asset ${p.name}`);
        this.uploaded.set(p.name, Buffer.from(p.body.toString('latin1'), 'base64'));
        s.pending.delete(p.name);
      }
      if (s.pending.size) return this.ok({ jwt: null }, 202);
      const completion = [...this.completions.entries()].find(([, c]) => c.script === s.script)?.[0];
      return this.ok({ jwt: completion ?? null }, 201);
    }

    // ---------- scripts ----------
    if ((m = /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/settings$/.exec(path)) && r.method === 'GET') {
      const s = this.scripts.get(decodeURIComponent(m[1]!));
      if (!s) return this.err(404, 10007, 'workers.api.error.script_not_found');
      const bindings = ((s.metadata.bindings ?? []) as { type: string; name: string }[]).map((x) => ({ type: x.type, name: x.name }));
      return this.ok({ bindings: [...bindings, ...[...s.secrets.keys()].map((n) => ({ type: 'secret_text', name: n }))], compatibility_date: s.metadata.compatibility_date });
    }
    if ((m = /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/secrets$/.exec(path)) && r.method === 'PUT') {
      const s = this.scripts.get(decodeURIComponent(m[1]!));
      if (!s) return this.err(404, 10007, 'workers.api.error.script_not_found');
      if (!b.name || typeof b.text !== 'string' || b.type !== 'secret_text') return this.err(400, 10021, 'A secret has a name, a text and the type secret_text.');
      s.secrets.set(String(b.name), b.text);
      return this.ok({ name: b.name, type: 'secret_text' });
    }
    if ((m = /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]!);
      if (r.method === 'PUT') {
        const parts = parseMultipart(r.headers['content-type'] ?? '', r.raw ?? Buffer.alloc(0));
        const meta = parts.find((p) => p.name === 'metadata');
        if (!meta) return this.err(400, 10021, 'Uploads need a metadata part.');
        const metadata = JSON.parse(meta.body.toString('utf8')) as Record<string, unknown>;
        const main = String(metadata.main_module ?? '');
        const mod = parts.find((p) => p.name === main);
        if (!mod) return this.err(400, 10021, `No such module ${main}.`);
        const assetsJwt = (metadata.assets as { jwt?: string } | undefined)?.jwt;
        const completion = assetsJwt ? this.completions.get(assetsJwt) : null;
        if (assetsJwt && !completion) return this.err(400, 10203, 'The assets upload is not complete.');
        const prev = this.scripts.get(id);
        const script: FakeScript = { id, metadata, module: mod.body.toString('utf8'), secrets: prev?.secrets ?? new Map(), assets: completion?.paths ?? [], created_on: prev?.created_on ?? now };
        this.scripts.set(id, script);
        for (const c of ((metadata.containers ?? []) as { class_name: string }[])) {
          if (!this.namespaces.some((n) => n.script === id && n.class === c.class_name)) this.namespaces.push({ id: randomBytes(16).toString('hex'), name: `${id}_${c.class_name}`, script: id, class: c.class_name });
        }
        return this.ok({ id, tag: randomBytes(8).toString('hex'), modified_on: now });
      }
      if (r.method === 'DELETE') {
        if (!this.scripts.delete(id)) return this.err(404, 10007, 'workers.api.error.script_not_found');
        return this.ok(null);
      }
    }
    if (/^\/accounts\/[^/]+\/workers\/scripts$/.test(path) && r.method === 'GET') return this.ok([...this.scripts.values()].map((s) => ({ id: s.id, created_on: s.created_on })));
    if (/^\/accounts\/[^/]+\/workers\/durable_objects\/namespaces$/.test(path) && r.method === 'GET') return this.ok(this.namespaces);

    // ---------- custom domains ----------
    if (/^\/accounts\/[^/]+\/workers\/domains$/.test(path)) {
      if (r.method === 'GET') return this.ok(this.domains.filter((d) => !r.query.get('service') || d.service === r.query.get('service')));
      if (r.method === 'PUT') {
        if (!b.hostname || !b.service || !b.zone_id) return this.err(400, 100117, 'hostname, service and zone_id are required.');
        if (!this.scripts.has(String(b.service))) return this.err(400, 100114, 'The service does not exist.');
        const existing = this.domains.find((d) => d.hostname === b.hostname);
        if (existing) Object.assign(existing, { service: String(b.service), zone_id: String(b.zone_id) });
        else this.domains.push({ id: randomBytes(16).toString('hex'), hostname: String(b.hostname), service: String(b.service), zone_id: String(b.zone_id), environment: String(b.environment ?? 'production') });
        return this.ok(this.domains.find((d) => d.hostname === b.hostname));
      }
    }
    if ((m = /^\/accounts\/[^/]+\/workers\/domains\/([^/]+)$/.exec(path)) && r.method === 'DELETE') {
      const i = this.domains.findIndex((d) => d.id === m![1]);
      if (i < 0) return this.err(404, 100116, 'Domain not found');
      this.domains.splice(i, 1);
      return this.ok(null);
    }

    // ---------- hyperdrive ----------
    const shown = (h: { id: string; name: string; origin: Record<string, unknown>; caching: Record<string, unknown> }) => {
      const { password: _p, access_client_secret: _s, ...origin } = h.origin;
      void _p;
      void _s;
      return { id: h.id, name: h.name, origin, caching: h.caching };
    };
    if ((m = /^\/accounts\/[^/]+\/hyperdrive\/configs(?:\/([^/]+))?$/.exec(path))) {
      const id = m[1];
      if (!id && r.method === 'GET') return this.ok([...this.hyperdrives.values()].map(shown));
      if (!id && r.method === 'POST') {
        const origin = (b.origin ?? {}) as Record<string, unknown>;
        if (!b.name) return this.err(400, 2017, 'A name is required.');
        if (!origin.host || !origin.database || !origin.user || !origin.password) return this.err(400, 2008, 'The origin needs a host, a database, a user and a password.');
        if (origin.access_client_id ? !origin.access_client_secret || origin.port !== undefined : !origin.port) return this.err(400, 2008, 'An origin is a host and port, or a tunnel host with an Access service token and no port.');
        const h = { id: randomBytes(16).toString('hex'), name: String(b.name), origin, caching: (b.caching ?? {}) as Record<string, unknown> };
        this.hyperdrives.set(h.id, h);
        return this.ok(shown(h));
      }
      const h = id ? this.hyperdrives.get(id) : undefined;
      if (!h) return this.err(404, 2009, 'Hyperdrive config not found');
      if (r.method === 'GET') return this.ok(shown(h));
      if (r.method === 'PUT') {
        Object.assign(h, { origin: (b.origin ?? h.origin) as Record<string, unknown>, caching: (b.caching ?? h.caching) as Record<string, unknown> });
        return this.ok(shown(h));
      }
      if (r.method === 'DELETE') {
        this.hyperdrives.delete(h.id);
        return this.ok(null);
      }
    }

    // ---------- containers ----------
    if ((m = /^\/accounts\/[^/]+\/containers\/applications(?:\/([^/]+))?$/.exec(path))) {
      const id = m[1];
      if (!id && r.method === 'GET') return this.ok([...this.containers.values()]);
      if (!id && r.method === 'POST') {
        if (!b.name) return this.err(400, 10021, 'A name is required.');
        const ns = (b.durable_objects as { namespace_id?: string } | undefined)?.namespace_id;
        if (!ns || !this.namespaces.some((n) => n.id === ns)) return this.err(400, 10022, 'The Durable Object namespace does not exist.');
        const image = String((b.configuration as { image?: string } | undefined)?.image ?? '');
        if (!image) return this.err(400, 10023, 'An image is required.');
        const app = { id: randomUUID(), ...b, name: String(b.name), created_at: now };
        this.containers.set(app.id, app);
        return this.ok(app);
      }
      const app = id ? this.containers.get(id) : undefined;
      if (!app) return this.err(404, 10024, 'Application not found');
      if (r.method === 'GET') return this.ok(app);
      if (r.method === 'PATCH') {
        Object.assign(app, b, { updated_at: now });
        return this.ok(app);
      }
      if (r.method === 'DELETE') {
        this.containers.delete(app.id);
        return this.ok(null);
      }
    }
    return this.err(404, 7000, 'No route for that URI');
  }
}
