import { readFileSync } from 'node:fs';
import { Agent, fetch, type Dispatcher } from 'undici';

/*
 * B-1405: a minimal Kubernetes API client for the zone NetworkPolicies: server-side apply (PATCH with
 * application/apply-patch+yaml, a field manager and force, so this server owns the fields it renders) and GET for the
 * drift check. Inside a pod it uses the service account: the token file (re-read on every call, because projected
 * tokens rotate) and the cluster CA. RBAC limits it to networkpolicies in the zone namespaces (the Helm chart's
 * optional Role and RoleBinding).
 */

export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; [k: string]: unknown };
  [k: string]: unknown;
}

export interface KubeOptions {
  apiUrl: string;
  /** The bearer token, read when each request is made. */
  token: () => string;
  /** PEM of the CA that signed the API server's certificate. */
  ca?: Buffer | null;
  fieldManager: string;
  timeoutMs?: number;
}

export class KubeError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

/** The REST path of a namespaced object; only the kinds the zones render. */
export function objectPath(kind: string, namespace: string, name: string): string {
  const ns = encodeURIComponent(namespace);
  const n = encodeURIComponent(name);
  switch (kind) {
    case 'NetworkPolicy':
      return `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${n}`;
    default:
      throw new KubeError(`Applying ${kind} is not supported`, null);
  }
}

export class KubeClient {
  private readonly dispatcher: Dispatcher | undefined;
  private readonly base: string;

  constructor(private readonly o: KubeOptions) {
    this.base = o.apiUrl.replace(/\/+$/, '');
    this.dispatcher = o.ca ? new Agent({ connect: { ca: o.ca, rejectUnauthorized: true } }) : undefined;
  }

  private async call(method: string, path: string, body?: string, contentType?: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
    let token: string;
    try {
      token = this.o.token().trim();
    } catch (err) {
      throw new KubeError(`The service account token could not be read: ${(err as Error).message}`, null);
    }
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
      });
    } catch (err) {
      throw new KubeError(`The Kubernetes API did not answer: ${(err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message}`, null);
    }
    const text = await res.text();
    let json: Record<string, unknown> | null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  /** Server-side apply: creates the object or updates the fields this field manager owns. Returns the live object. */
  async apply(obj: KubeObject): Promise<KubeObject> {
    const ns = obj.metadata.namespace;
    if (!ns) throw new KubeError('The object has no namespace', null);
    const path = `${objectPath(obj.kind, ns, obj.metadata.name)}?fieldManager=${encodeURIComponent(this.o.fieldManager)}&force=true`;
    // YAML is a superset of JSON, so the apply body is the object as JSON.
    const r = await this.call('PATCH', path, JSON.stringify(obj), 'application/apply-patch+yaml');
    if (r.status >= 200 && r.status < 300 && r.json) return r.json as KubeObject;
    throw new KubeError(statusMessage(r.status, r.json), r.status);
  }

  /** The live object, or null when it does not exist. */
  async get(kind: string, namespace: string, name: string): Promise<KubeObject | null> {
    const r = await this.call('GET', objectPath(kind, namespace, name));
    if (r.status === 404) return null;
    if (r.status === 200 && r.json) return r.json as KubeObject;
    throw new KubeError(statusMessage(r.status, r.json), r.status);
  }
}

/** A short reason from a Kubernetes Status object (reason and message), without echoing request bodies. */
function statusMessage(status: number, body: Record<string, unknown> | null): string {
  const reason = typeof body?.reason === 'string' ? body.reason : null;
  const message = typeof body?.message === 'string' ? body.message.slice(0, 300) : null;
  const hint = status === 401 ? ' (the service account token was refused)' : status === 403 ? ' (RBAC: the service account may not change networkpolicies here; see zonesApply in the Helm chart)' : '';
  return `Kubernetes API answered ${status}${reason ? ` ${reason}` : ''}${message ? `: ${message}` : ''}${hint}`;
}

/** The client for the configured cluster: ZONES_APPLY_API_URL, or the in-cluster address from the service environment. */
export function kubeFromConfig(cfg: { ZONES_APPLY_API_URL?: string | undefined; ZONES_APPLY_TOKEN_FILE: string; ZONES_APPLY_CA_FILE: string; ZONES_APPLY_FIELD_MANAGER: string }, env: NodeJS.ProcessEnv = process.env): KubeClient {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? '443';
  const apiUrl = cfg.ZONES_APPLY_API_URL ?? (host ? `https://${host.includes(':') ? `[${host}]` : host}:${port}` : null);
  if (!apiUrl) throw new KubeError('ZONES_APPLY=kubernetes needs ZONES_APPLY_API_URL, or to run in a pod (KUBERNETES_SERVICE_HOST)', null);
  let ca: Buffer | null = null;
  if (apiUrl.startsWith('https:')) {
    try {
      ca = readFileSync(cfg.ZONES_APPLY_CA_FILE);
    } catch {
      ca = null; // the system trust store then
    }
  }
  return new KubeClient({ apiUrl, token: () => readFileSync(cfg.ZONES_APPLY_TOKEN_FILE, 'utf8'), ca, fieldManager: cfg.ZONES_APPLY_FIELD_MANAGER });
}

/**
 * Where the live value departs from what was applied: every field the desired object sets must be present and equal,
 * and lists must match element by element (a rule added or removed by hand changes a list's length). Fields only the
 * live object has (defaults the API server fills in, status, managed fields) are ignored. Null when they agree.
 */
export function firstDifference(desired: unknown, live: unknown, path = ''): string | null {
  if (Array.isArray(desired)) {
    if (!Array.isArray(live)) return path || '(root)';
    if (desired.length !== live.length) return `${path} (${desired.length} expected, ${live.length} found)`;
    for (let i = 0; i < desired.length; i++) {
      const d = firstDifference(desired[i], live[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (desired && typeof desired === 'object') {
    if (!live || typeof live !== 'object' || Array.isArray(live)) return path || '(root)';
    for (const [k, v] of Object.entries(desired as Record<string, unknown>)) {
      const d = firstDifference(v, (live as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  // Kubernetes returns numbers for ports and strings for labels; compare loosely only between those two.
  if (desired === live) return null;
  if ((typeof desired === 'number' || typeof desired === 'string') && (typeof live === 'number' || typeof live === 'string') && String(desired) === String(live)) return null;
  return path || '(root)';
}
