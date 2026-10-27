import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, LABELS, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { loadPrincipal } from '../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { guardedRequest, serviceAddressProblem, servicePolicy, ServiceUrlRefused } from '../platform/egress.js';
import type { JobContext } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { flowInputSchema, flowProblems, type Condition, type FlowAction, type FlowInput, type Leaf, type LeafOp } from './flows.js';
import { layoutProblems, type LayoutDefinition } from './form-layout.js';
import { formDefinitionSchema, type FormDefinition } from './forms.js';
import { compileFormula } from './formula.js';
import { checkDefinition, entityDefinitionSchema, INDEX_TEXT_MAX, NAME, normText, RESERVED, validateValues, ValueError, type EntityDefinition, type Field, type StateMachine, type Values } from './schema.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';

/*
 * Importing the exprsn-platform's low-code apps into Apps (docs/decisions/lowcode-port.md, "Importing platform apps").
 *
 * The platform's `/lowcode` module is read through its own API as one of its accounts (a bearer: the configured
 * PLATFORM_LOWCODE_TOKEN, or one passed for one import), over the operator service URL checks of `platform/egress.ts`.
 * One platform app (its entities with their typed fields, lookups and state machines, its forms, flows and records) is
 * mapped onto an Exprsn-AI app: a new one, or an existing one by name. A dry run (`plan`) returns the whole mapping
 * report: what maps, what changes on the way and why, what is dropped and why, which records would fail validation,
 * and which writes to the platform the import would make. The import itself (`start`) is the job
 * `apps.platform-import`: it reads the platform again, refuses when the design changed since the dry run, and writes
 * through the normal services (apps, entities, records with their validation, policies, labels and audit, forms,
 * flows compiled into workflows), as the person who started it, within their clearance.
 *
 * Idempotent: `app_platform_links` remembers which Exprsn-AI object each platform object became, so a second import
 * updates (or leaves alone) instead of duplicating. Platform writes are off unless asked for (`markPlatform`): one
 * lookup on the platform app, `exprsn_ai_link`, names where it was imported. Every platform write goes through
 * `PlatformLowcodeClient.write`, which allows only that lookup's POST and PUT, and each is audited.
 */

// ---------- the platform's shapes (exprsn-platform/services/lowcode/src/models/index.js) ----------

export interface PField {
  key: string;
  label?: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  role?: string;
  aggregation?: string;
  format?: unknown;
  default?: unknown;
  min?: number;
  max?: number;
  enumValues?: unknown[];
  enumLookup?: string;
  refEntity?: string;
  formula?: string;
  aiPrompt?: string;
}
export interface PTransition {
  from: string;
  event: string;
  to: string;
  guard?: unknown;
  actions?: unknown;
}
export interface PStateMachine {
  initial?: string;
  states?: string[];
  transitions?: PTransition[];
}
export interface PApp {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  status?: string;
  scopeType?: string;
  scopeId?: string | null;
  capabilities?: string[];
}
export interface PEntity {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  fields: PField[];
  stateMachine?: PStateMachine | null;
  storage?: { mode?: string } | null;
}
export interface PLookup {
  id: string;
  key: string;
  name: string;
  values: { value: unknown; label?: unknown; metadata?: unknown }[];
  source?: { type?: string; provider?: string; params?: Record<string, unknown> } | null;
}
export interface PForm {
  id: string;
  key: string;
  name: string;
  entityKey: string;
  layout?: { sections?: { title?: string; fields?: unknown[] }[]; steps?: boolean; submitLabel?: string } | null;
  isPublic?: boolean;
  settings?: Record<string, unknown> | null;
}
export interface PCondition {
  field?: string;
  op?: string;
  value?: unknown;
  all?: PCondition[];
  any?: PCondition[];
  none?: PCondition[];
}
export interface PAction {
  type: string;
  entityKey?: string;
  entity?: string;
  recordId?: string;
  data?: Record<string, unknown>;
  event?: string;
  when?: PCondition | null;
  onError?: 'continue' | 'stop';
  retries?: number;
  [k: string]: unknown;
}
export interface PFlow {
  id: string;
  key: string;
  name: string;
  event: string;
  trigger?: { type?: string; cron?: string } | null;
  match?: PCondition | null;
  actions: PAction[];
  enabled?: boolean;
}
export interface PRecord {
  id: string;
  data: Record<string, unknown>;
  state?: string | null;
}

/** The lookup the importer writes on the platform app (with `markPlatform`), and never imports. */
export const LINK_LOOKUP = 'exprsn_ai_link';

// ---------- the platform client ----------

export interface PlatformWrite {
  method: 'POST' | 'PUT';
  path: string;
  purpose: string;
}

/** The only writes the importer may make on the platform: its own link lookup. Never a delete. */
const WRITE_ALLOWED: { method: PlatformWrite['method']; path: RegExp }[] = [
  { method: 'POST', path: /^\/lowcode\/api\/design\/lookups$/ },
  { method: 'PUT', path: /^\/lowcode\/api\/design\/lookups\/[0-9a-f-]{36}$/i }
];

const MAX_ANSWER = 16 * 1024 * 1024;

/** A bearer from a setting or a file: the token itself, or a JSON object with `token` (a kept platform session). */
export function bearerOf(raw: string | undefined | null): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { token?: unknown };
      return typeof o.token === 'string' && o.token ? o.token : null;
    } catch {
      return null;
    }
  }
  return t;
}

/** The platform's base URL in one spelling (origin and path, no trailing slash, loopback as 127.0.0.1), which links are keyed by. */
export function platformBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('The platform URL is not a URL.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw badRequest('The platform URL is https (http only on this host).');
  if (u.username || u.password || u.search || u.hash) throw badRequest('The platform URL has no credentials, query or fragment.');
  // the loopback in one spelling, as the key of links and as the address dialled (the egress guard dials the first
  // address a name resolves to, and `localhost` is ::1 first on macOS while the platform listens on IPv4)
  const shown = loopback ? `127.0.0.1${u.port ? `:${u.port}` : ''}` : u.host;
  return `${u.protocol}//${shown}${u.pathname.replace(/\/+$/, '')}`;
}

export class PlatformLowcodeClient {
  readonly writes: (PlatformWrite & { status: number })[] = [];

  constructor(
    readonly base: string,
    private readonly token: string,
    private readonly cfg: { SERVICE_ALLOWED_HOSTS?: string; SERVICE_INTERNAL_ONLY?: boolean },
    /** Called after every platform write (the audit entry). */
    private readonly onWrite: (w: PlatformWrite & { status: number }) => Promise<void> = async () => {}
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const policy = servicePolicy(this.cfg);
    let res;
    try {
      res = await guardedRequest({
        method,
        url: new URL(this.base + path),
        headers: { accept: 'application/json', authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        timeoutMs: 30_000,
        maxBytes: MAX_ANSWER,
        check: (address, host) => serviceAddressProblem(address, host, policy)
      });
    } catch (err) {
      if (err instanceof ServiceUrlRefused) throw new HttpProblem(400, 'Platform not reachable', `The platform URL is refused: ${err.message}`);
      throw new HttpProblem(502, 'Platform not reachable', `The platform did not answer (${(err as Error).message.slice(0, 200)}).`);
    }
    let parsed: unknown;
    try {
      parsed = res.body.length ? JSON.parse(res.body.toString('utf8')) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, json: parsed };
  }

  private fail(method: string, path: string, status: number, body: unknown): never {
    const o = (body ?? {}) as { message?: unknown; error?: unknown };
    const why = String((typeof o.message === 'string' && o.message) || (typeof o.error === 'string' && o.error) || '').slice(0, 200);
    const shown = path.replace(/\?.*$/, '');
    if (status === 401) throw new HttpProblem(502, 'Platform refused the credential', `The platform answered 401 to ${method} ${shown}: the platform token is missing, expired or wrong.`);
    if (status === 403) throw new HttpProblem(403, 'Platform refused', `The platform account may not read this (${method} ${shown}: ${why || 'forbidden'}).`, { extensions: { step: 'platform' } });
    if (status === 404) throw new HttpProblem(404, 'Not found', `The platform has no ${shown.split('/').slice(-2).join(' ')} (${why || 'not found'}).`);
    throw new HttpProblem(502, 'Platform error', `The platform answered ${status} to ${method} ${shown}${why ? `: ${why}` : ''}.`);
  }

  async get<T>(path: string): Promise<T> {
    const r = await this.request('GET', path);
    if (r.status !== 200) this.fail('GET', path, r.status, r.json);
    return r.json as T;
  }

  /** The one function that writes to the platform: only the calls in WRITE_ALLOWED, each reported to `onWrite`. */
  async write<T>(w: PlatformWrite, body: unknown): Promise<T> {
    if (!WRITE_ALLOWED.some((a) => a.method === w.method && a.path.test(w.path))) throw new Error(`the importer does not write ${w.method} ${w.path} on the platform`);
    const r = await this.request(w.method, w.path, body);
    const done = { ...w, status: r.status };
    this.writes.push(done);
    await this.onWrite(done);
    if (r.status !== 200 && r.status !== 201) this.fail(w.method, w.path, r.status, r.json);
    return r.json as T;
  }

  // reads (routes/design.js and routes/records.js of the platform's lowcode module)
  async health(): Promise<{ status?: string; enabled?: boolean }> {
    return this.get('/lowcode/health');
  }
  async apps(): Promise<PApp[]> {
    return (await this.get<{ apps?: PApp[] }>('/lowcode/api/design/apps')).apps ?? [];
  }
  async app(id: string): Promise<PApp> {
    return (await this.get<{ app: PApp }>(`/lowcode/api/design/apps/${encodeURIComponent(id)}`)).app;
  }
  async entities(appId: string): Promise<PEntity[]> {
    return (await this.get<{ entities?: PEntity[] }>(`/lowcode/api/design/entities?appId=${encodeURIComponent(appId)}`)).entities ?? [];
  }
  async lookups(appId: string): Promise<PLookup[]> {
    return (await this.get<{ lookups?: PLookup[] }>(`/lowcode/api/design/lookups?appId=${encodeURIComponent(appId)}`)).lookups ?? [];
  }
  async forms(appId: string): Promise<PForm[]> {
    return (await this.get<{ forms?: PForm[] }>(`/lowcode/api/design/forms?appId=${encodeURIComponent(appId)}`)).forms ?? [];
  }
  /**
   * 1.8.0 (B-143): the app's AppRoles (the exprsn-svr low-code security API). A platform that serves none (an older
   * module, or an account that may not read them) gives an empty list: roles are a nicety of the import, never its gate.
   */
  async roles(appId: string): Promise<PRole[]> {
    try {
      const body = await this.get<{ data?: { roles?: PRole[] }; roles?: PRole[] }>(`/lowcode/api/security/roles?applicationId=${encodeURIComponent(appId)}&limit=100`);
      const list = body?.data?.roles ?? body?.roles ?? [];
      return Array.isArray(list) ? list.filter((r) => r && typeof r.name === 'string').slice(0, 100) : [];
    } catch {
      return [];
    }
  }
  async flows(appId: string): Promise<PFlow[]> {
    // A webhook trigger carries its secret: it is dropped here and never kept, shown or compared.
    return ((await this.get<{ flows?: PFlow[] }>(`/lowcode/api/design/flows?appId=${encodeURIComponent(appId)}`)).flows ?? []).map((f) => ({ ...f, trigger: f.trigger ? { type: f.trigger.type, ...(f.trigger.cron ? { cron: f.trigger.cron } : {}) } : null }));
  }
  /** Every record of an entity the account can see, oldest first, up to `max` (and whether there were more). */
  async records(appId: string, entityKey: string, max: number): Promise<{ records: PRecord[]; total: number; truncated: boolean }> {
    const out: PRecord[] = [];
    let total = 0;
    for (let offset = 0; out.length < max; offset += 500) {
      const page = await this.get<{ records?: PRecord[]; total?: number }>(`/lowcode/api/data/${encodeURIComponent(entityKey)}/records?appId=${encodeURIComponent(appId)}&sort=createdAt&limit=500&offset=${offset}`);
      total = Number(page.total ?? 0);
      const rows = page.records ?? [];
      out.push(...rows.slice(0, max - out.length));
      if (rows.length < 500 || offset + 500 >= total) break;
    }
    return { records: out.map((r) => ({ id: r.id, data: r.data ?? {}, state: r.state ?? null })), total, truncated: total > out.length };
  }
}

// ---------- mapping ----------

export interface FieldReport {
  source: string;
  name: string;
  from: string;
  to: string;
  notes: string[];
}
export interface Dropped {
  what: string;
  why: string;
}

/** 1.8.0 (B-143): a platform AppRole (exprsn-svr `lowcode/models/AppRole.js`), as `/lowcode/api/security/roles` lists it. */
export interface PRole {
  id?: string;
  name: string;
  displayName?: string | null;
  description?: string | null;
  isSystemRole?: boolean;
  permissions?: unknown;
}

/** A platform role as an app role: its name, and a description from its display name and description. */
export interface RolePlan {
  source: string;
  name: string;
  description: string | null;
  action: 'create' | 'existing';
}

/**
 * Maps platform AppRoles onto the app's role catalogue (by name, without regard to case): new names are created,
 * known ones left as they are. What a platform role was allowed is not carried: its permissions are grants on platform
 * resources, which Exprsn-AI expresses as row and field policies naming the role.
 */
export function mapPlatformRoles(roles: PRole[], have: Set<string>, dropped: Dropped[]): RolePlan[] {
  const out: RolePlan[] = [];
  const seen = new Set<string>();
  for (const r of roles) {
    const name = String(r.name ?? '').trim().slice(0, 63);
    const key = name.toLowerCase();
    if (!name || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(name)) {
      dropped.push({ what: `role ${String(r.name ?? '').slice(0, 60)}`, why: 'its name is not one an app role can have.' });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const text = [r.displayName && r.displayName !== name ? String(r.displayName) : null, r.description ? String(r.description) : null].filter(Boolean).join(': ').slice(0, 500);
    out.push({ source: name, name, description: text || null, action: have.has(key) ? 'existing' : 'create' });
    const perms = r.permissions && typeof r.permissions === 'object' ? Object.keys(r.permissions as object).length : 0;
    if (perms) dropped.push({ what: `role ${name}: ${perms} permission(s)`, why: 'platform resource grants; write row and field policies naming the app role instead.' });
  }
  return out;
}

/** How one platform field's values are written: into which field, converted how (or a reference to resolve). */
export interface FieldPlan {
  source: string;
  name: string;
  /** The Exprsn-AI field the values go into (the existing one when the entity exists). */
  target: Field;
  /** The platform entity whose records a reference names (reference and entity-lookup fields). */
  refEntity: string | null;
  /** Values are not written: the field is computed in Exprsn-AI. */
  computed: boolean;
  /** Values are not written, and why (a file pointer, a type that cannot hold them). */
  skip: string | null;
}

/** A name Exprsn-AI accepts, from a platform key: lower case, `_` for anything else, not reserved, unique in `taken`. */
export function nameFrom(key: string, taken: Set<string>, reserved: ReadonlySet<string> = new Set()): string {
  let n = key.normalize('NFKD').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(n)) n = `f_${n}`;
  n = n.slice(0, 63).replace(/_+$/, '') || 'field';
  if (reserved.has(n)) n = `${n}_value`.slice(0, 63);
  let out = n;
  for (let i = 2; taken.has(out); i++) out = `${n.slice(0, 60)}_${i}`;
  taken.add(out);
  return out;
}

/** A state name Exprsn-AI accepts. */
function stateFrom(s: string): string {
  let n = String(s).normalize('NFKD').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  if (!/^[a-z]/.test(n)) n = `s_${n}`;
  return n.slice(0, 60).replace(/[_-]+$/, '') || 'state';
}

/** What the records say about a field: longest text, line breaks, largest JSON. */
interface Observed {
  maxLen: number;
  multiline: boolean;
  maxJson: number;
}
function observe(records: PRecord[], key: string): Observed {
  const o: Observed = { maxLen: 0, multiline: false, maxJson: 0 };
  for (const r of records) {
    const v = r.data[key];
    if (v == null) continue;
    if (typeof v === 'string') {
      o.maxLen = Math.max(o.maxLen, [...v].length);
      if (/[\r\n]/.test(v)) o.multiline = true;
    } else o.maxJson = Math.max(o.maxJson, Buffer.byteLength(JSON.stringify(v)));
  }
  return o;
}

const ID_PLACEHOLDER = '0'.repeat(26);

export interface MapContext {
  /** The platform app's lookups by key (the link lookup left out). */
  lookups: Map<string, PLookup>;
  /** Exprsn-AI entity names by platform entity key, decided before the fields are mapped. */
  entityNames: Map<string, string>;
}

/** Maps one platform field onto a new Exprsn-AI field. */
export function mapField(pf: PField, name: string, records: PRecord[], ctx: MapContext): { field: Field; plan: Omit<FieldPlan, 'target'>; report: FieldReport; dropped: Dropped[] } {
  const notes: string[] = [];
  const dropped: Dropped[] = [];
  const title = typeof pf.label === 'string' && pf.label.trim() ? pf.label.trim().slice(0, 200) : undefined;
  const base = { name, ...(title ? { title } : {}), required: !!pf.required, indexed: false, unique: false };
  const seen = observe(records, pf.key);
  const dimension = pf.role === 'dimension' || pf.role === 'measure';
  let refEntity: string | null = null;
  if (name !== pf.key) notes.push(`renamed from ${pf.key}`);
  if (pf.default !== undefined) dropped.push({ what: `${pf.key}: default ${JSON.stringify(pf.default).slice(0, 60)}`, why: 'Exprsn-AI fields have no default value; the platform already wrote it into its records.' });
  if (pf.aggregation || pf.format !== undefined) dropped.push({ what: `${pf.key}: ${[pf.aggregation ? `aggregation ${pf.aggregation}` : '', pf.format !== undefined ? 'format' : ''].filter(Boolean).join(' and ')}`, why: 'presentation hints; Exprsn-AI aggregates any indexed field when asked.' });

  const text = (multilineDefault: boolean, defaultMax: number): Field => {
    const want = Math.max(pf.max ?? 0, seen.maxLen, 1);
    let maxLength = pf.max ?? defaultMax;
    if (seen.maxLen > maxLength) {
      maxLength = Math.min(100_000, seen.maxLen);
      notes.push(`maxLength raised to ${maxLength}: a record holds text that long`);
    }
    const multiline = multilineDefault || seen.multiline;
    if (multiline && !multilineDefault) notes.push('multi-line: a record holds a line break');
    let unique = !!pf.unique;
    if (unique && maxLength > INDEX_TEXT_MAX) {
      if (want <= INDEX_TEXT_MAX) maxLength = INDEX_TEXT_MAX;
      else {
        unique = false;
        dropped.push({ what: `${pf.key}: unique`, why: `a unique text field holds at most ${INDEX_TEXT_MAX} characters, and its records hold longer text.` });
      }
    }
    return { ...base, type: 'string', unique, indexed: unique, maxLength, ...(pf.min != null ? { minLength: Math.max(0, Math.floor(pf.min)) } : {}), ...(multiline ? { multiline: true } : {}) } as Field;
  };

  let field: Field;
  const formula = typeof pf.formula === 'string' ? pf.formula : null;
  switch (pf.type) {
    case 'string':
      field = text(false, 1000);
      break;
    case 'text':
      field = text(true, 10_000);
      break;
    case 'number':
    case 'integer':
      field = { ...base, type: 'number', integer: pf.type === 'integer', indexed: dimension || !!pf.unique, unique: !!pf.unique, ...(pf.min != null ? { min: pf.min } : {}), ...(pf.max != null ? { max: pf.max } : {}) } as Field;
      if (pf.type === 'integer') notes.push('a whole number field');
      break;
    case 'boolean':
      field = { ...base, type: 'boolean', indexed: dimension } as Field;
      break;
    case 'date':
    case 'datetime':
      field = { ...base, type: 'date', withTime: pf.type === 'datetime', indexed: dimension || !!pf.unique, unique: !!pf.unique } as Field;
      notes.push(pf.type === 'datetime' ? 'values written as ISO 8601 date and time in UTC' : 'values written as YYYY-MM-DD');
      break;
    case 'enum': {
      const inline = Array.isArray(pf.enumValues) ? pf.enumValues.map((v) => ({ value: String(v) })) : [];
      const lk = pf.enumLookup ? ctx.lookups.get(pf.enumLookup) : undefined;
      if (pf.enumLookup && !lk) {
        field = text(false, 1000);
        dropped.push({ what: `${pf.key}: lookup ${pf.enumLookup}`, why: 'the lookup is not one of this app’s lookups (a platform-wide lookup cannot be read); the field keeps its values as text.' });
        break;
      }
      const provider = lk?.source?.type === 'provider' ? lk.source.provider : null;
      if (lk && provider === 'lowcode.entity') {
        const params = lk.source?.params ?? {};
        const ek = String(params.entityKey ?? '');
        const valueField = String(params.valueField ?? 'id');
        const target = ctx.entityNames.get(ek);
        if (target && valueField === 'id' && !inline.length) {
          const labelField = typeof params.labelField === 'string' && params.labelField !== 'id' ? params.labelField : null;
          field = { ...base, type: 'lookup', source: 'entity', entity: target, ...(labelField ? { display: nameFrom(labelField, new Set()) } : {}) } as Field;
          refEntity = ek;
          notes.push(`lookup ${lk.key} reads the records of ${ek}: an entity lookup of ${target}; values are the imported records' ids`);
          break;
        }
        field = text(false, 1000);
        dropped.push({ what: `${pf.key}: lookup ${lk.key}`, why: `the lookup reads ${valueField === 'id' ? 'records of an entity this import does not have' : `the field ${valueField} of ${ek}`}; the field keeps its values as text.` });
        break;
      }
      if (lk && provider) {
        field = text(false, 1000);
        dropped.push({ what: `${pf.key}: lookup ${lk.key} (provider ${provider})`, why: 'its options come from platform data (users, groups, queues, topics or files) Exprsn-AI does not have; the field keeps its values as text.' });
        break;
      }
      const fromLookup = (lk?.values ?? []).map((v) => ({ value: String(v.value), ...(v.label != null && String(v.label) !== String(v.value) ? { label: String(v.label).slice(0, 200) } : {}) }));
      const all = [...inline, ...fromLookup];
      const seenV = new Set<string>();
      const options: { value: string; label?: string }[] = [];
      let bad = false;
      for (const o of all) {
        const v = o.value.trim();
        if (!v || v.length > 100) {
          bad = true;
          continue;
        }
        const k = normText(v);
        if (seenV.has(k)) {
          if (o.value !== v || all.filter((x) => normText(x.value.trim()) === k).length > 1) notes.push(`option ${v} listed twice (or differing only in case); kept once`);
          continue;
        }
        seenV.add(k);
        options.push({ ...o, value: v });
      }
      if (bad || !options.length) {
        field = text(false, 1000);
        dropped.push({ what: `${pf.key}: options`, why: 'an option is empty or longer than 100 characters, which an Exprsn-AI option cannot be; the field keeps its values as text.' });
        break;
      }
      if (lk || options.length > 200) {
        if (options.length > 500) {
          field = text(false, 1000);
          dropped.push({ what: `${pf.key}: options`, why: 'more than 500 options; the field keeps its values as text.' });
          break;
        }
        field = { ...base, type: 'lookup', source: 'static', options, indexed: dimension } as Field;
        notes.push(lk ? `lookup ${lk.key}: a static lookup with its ${options.length} values` : 'more than 200 options: a static lookup');
      } else field = { ...base, type: 'enum', options, indexed: dimension || !!pf.unique, unique: !!pf.unique } as Field;
      break;
    }
    case 'reference': {
      const target = pf.refEntity ? ctx.entityNames.get(pf.refEntity) : undefined;
      if (!target) {
        field = text(false, 100);
        dropped.push({ what: `${pf.key}: reference to ${pf.refEntity ?? '?'}`, why: 'the referenced entity is not in this app; the platform record ids are kept as text.' });
        break;
      }
      field = { ...base, type: 'reference', entity: target, indexed: true } as Field;
      refEntity = pf.refEntity!;
      notes.push(`values are the imported ${target} records' ids`);
      break;
    }
    case 'json':
      field = { ...base, type: 'json', maxBytes: Math.min(100_000, Math.max(10_000, seen.maxJson)) } as Field;
      if (seen.maxJson > 10_000) notes.push(`maxBytes raised to ${Math.min(100_000, seen.maxJson)}`);
      break;
    case 'file':
      field = { ...base, type: 'json', required: false, maxBytes: 2000 } as Field;
      notes.push('the FileVault pointer ({fileId, name, size, mime}) kept as JSON');
      dropped.push({ what: `${pf.key}: the files themselves`, why: 'the platform’s FileVault files are not copied; upload them to Files and attach them if they are needed.' });
      break;
    default:
      field = { ...base, type: 'json', maxBytes: 10_000 } as Field;
      dropped.push({ what: `${pf.key}: type ${pf.type}`, why: 'not a platform field type this importer knows; the values are kept as JSON.' });
  }

  // a formula is checked once every field's name is known (formulaField)
  if (formula != null) notes.push('computed on the platform');
  if (typeof pf.aiPrompt === 'string') {
    notes.push('an AI field on the platform: imported as plain text with the values it produced');
    dropped.push({ what: `${pf.key}: AI prompt`, why: 'an Exprsn-AI AI field needs one of this tenant’s profiles; change the field to type ai on the Entities tab to regenerate it.' });
    field = { ...field, required: false } as Field;
  }
  if (field.unique && !['string', 'number', 'date', 'enum', 'reference', 'lookup', 'file'].includes(field.type)) field = { ...field, unique: false } as Field;
  return { field, plan: { source: pf.key, name, refEntity, computed: false, skip: null }, report: { source: pf.key, name, from: pf.type, to: field.type === 'string' && (field as { multiline?: boolean }).multiline ? 'string (multi-line)' : field.type, notes }, dropped };
}

/** A formula field: kept computed when Exprsn-AI's formula language reads it, else the stored values are imported. */
function formulaField(pf: PField, mapped: Field, plain: ReadonlySet<string>, keyToName: Map<string, string>): { field: Field; computed: boolean; note: string } {
  let expr = String(pf.formula ?? '').trim();
  // platform formulas name fields by key; renamed ones are spelled with their new name
  for (const [k, n] of keyToName) if (k !== n) expr = expr.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), n);
  try {
    compileFormula(expr, plain);
    return { field: { name: mapped.name, ...(mapped.title ? { title: mapped.title } : {}), required: false, indexed: mapped.indexed, unique: false, type: 'formula', expression: expr } as Field, computed: true, note: `a formula field: ${expr.slice(0, 80)}` };
  } catch (err) {
    return { field: mapped, computed: false, note: `the platform formula ${expr.slice(0, 60)} is not one Exprsn-AI reads (${(err as Error).message.slice(0, 100)}); the stored values are imported and no longer computed` };
  }
}

export interface EntityPlan {
  sourceId: string;
  sourceKey: string;
  name: string;
  title: string;
  action: 'create' | 'update' | 'unchanged';
  /** The existing Exprsn-AI entity (linked by an earlier import, or of the same name in an existing app). */
  existing: EntityRow | null;
  /** The definition the entity ends up with. */
  definition: EntityDefinition;
  fields: FieldReport[];
  dropped: Dropped[];
  changed: string[];
  plans: FieldPlan[];
  /** Platform state → Exprsn-AI state. */
  states: Map<string, string>;
  /** Platform transition event → the Exprsn-AI states it leads to. */
  events: Map<string, Set<string>>;
  records: { total: number; read: number; truncated: boolean; create: number; update: number; invalid: number };
}

/** Maps a platform state machine; `from` lists group by (event, to). */
export function mapStates(sm: PStateMachine | null | undefined): { states: StateMachine | null; map: Map<string, string>; events: Map<string, Set<string>>; dropped: Dropped[]; notes: string[] } {
  const map = new Map<string, string>();
  const events = new Map<string, Set<string>>();
  const dropped: Dropped[] = [];
  const notes: string[] = [];
  if (!sm || !Array.isArray(sm.states) || !sm.states.length) return { states: null, map, events, dropped, notes };
  const taken = new Set<string>();
  for (const s of sm.states) {
    let n = stateFrom(s);
    for (let i = 2; taken.has(n); i++) n = `${stateFrom(s).slice(0, 56)}_${i}`;
    taken.add(n);
    map.set(String(s), n);
    if (n !== s) notes.push(`state ${s} is ${n}`);
  }
  const initial = map.get(String(sm.initial ?? sm.states[0])) ?? map.get(String(sm.states[0]))!;
  const grouped = new Map<string, { name: string; from: Set<string>; to: string }>();
  for (const t of sm.transitions ?? []) {
    const to = map.get(String(t.to));
    const from = t.from === '*' ? '*' : map.get(String(t.from));
    if (!to || !from) {
      dropped.push({ what: `transition ${t.from} -${t.event}-> ${t.to}`, why: 'it names a state the machine does not list.' });
      continue;
    }
    if (t.guard) dropped.push({ what: `transition ${t.event}: guard`, why: 'Exprsn-AI transitions have no condition; a guard becomes a role list or a policy if it is needed.' });
    if (Array.isArray(t.actions) && t.actions.length) dropped.push({ what: `transition ${t.event}: ${t.actions.length} action(s)`, why: 'hook actions on a transition are not imported; a flow on the transitioned event does that in Exprsn-AI.' });
    const name = stateFrom(String(t.event));
    const key = `${name}>${to}`;
    const g = grouped.get(key) ?? { name, from: new Set<string>(), to };
    g.from.add(from);
    grouped.set(key, g);
    const ev = events.get(String(t.event)) ?? new Set<string>();
    ev.add(to);
    events.set(String(t.event), ev);
  }
  const transitions = [...grouped.values()].map((g) => ({ name: g.name, from: g.from.has('*') ? ['*'] : [...g.from], to: g.to }));
  return { states: { initial, states: [...map.values()].map((name) => ({ name })), transitions }, map, events, dropped, notes };
}

/** Adds what the platform has to an existing state machine (states and transitions it lacks). */
function mergeStates(have: StateMachine | undefined, add: StateMachine | null): { states: StateMachine | undefined; changed: string[] } {
  if (!add) return { states: have, changed: [] };
  if (!have) return { states: add, changed: ['state machine added'] };
  const changed: string[] = [];
  const states = [...have.states];
  for (const s of add.states) if (!states.some((x) => x.name === s.name)) {
    states.push(s);
    changed.push(`state ${s.name} added`);
  }
  const transitions = [...have.transitions];
  for (const t of add.transitions) {
    const same = transitions.find((x) => x.to === t.to && (x.from.includes('*') || t.from.every((f) => x.from.includes(f))));
    if (same) continue;
    transitions.push(t);
    changed.push(`transition to ${t.to} from ${t.from.join(', ')} added`);
  }
  return { states: { ...have, states, transitions }, changed };
}

/** Converts one platform value into the form the target field takes (references excluded: they are resolved apart). */
export function convertValue(target: Field, v: unknown): unknown {
  if (v === null || v === undefined || v === '') return null;
  switch (target.type) {
    case 'string':
      return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    case 'number':
      return typeof v === 'number' ? v : Number(v);
    case 'boolean':
      return v === true || v === 'true' || v === 1 || v === '1' ? true : v === false || v === 'false' || v === 0 || v === '0' ? false : v;
    case 'date': {
      if (typeof v !== 'string' && typeof v !== 'number') return v;
      if (!target.withTime && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      const t = typeof v === 'number' ? v : Date.parse(v);
      if (!Number.isFinite(t)) return v;
      return target.withTime ? new Date(t).toISOString() : new Date(t).toISOString().slice(0, 10);
    }
    case 'enum':
    case 'lookup':
      return typeof v === 'string' ? v.trim() : String(v);
    case 'json':
      return typeof v === 'object' ? v : { value: v };
    default:
      return v;
  }
}

// ---------- conditions, forms and flows ----------

const OPS: Record<string, LeafOp> = { equals: 'eq', not_equals: 'ne', contains: 'contains', not_contains: 'not_contains', in: 'in', not_in: 'not_in', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', exists: 'exists', not_exists: 'not_exists' };
const NO_VALUE_OPS = new Set(['exists', 'not_exists']);

/**
 * A platform condition tree as an Exprsn-AI one. `fieldOf` names the Exprsn-AI field a platform path tests, or null
 * (a reason is collected). A node may combine `all`, `any` and `none` (all of them must hold).
 */
export function mapCondition(c: PCondition | null | undefined, fieldOf: (path: string) => string | null, problems: string[]): Condition | null {
  if (!c || typeof c !== 'object') return null;
  if (c.op !== undefined || c.field !== undefined) {
    const op = OPS[String(c.op)];
    if (!op) {
      problems.push(`the operator ${String(c.op)} (on ${String(c.field)}) has no Exprsn-AI equivalent`);
      return null;
    }
    const field = fieldOf(String(c.field ?? ''));
    if (!field) return null;
    const leaf: Leaf = { field, op };
    if (!NO_VALUE_OPS.has(String(c.op))) {
      const v = c.value;
      if (op === 'in' || op === 'not_in') {
        if (!Array.isArray(v) || !v.length || v.length > 20 || v.some((x) => typeof x === 'object' && x !== null)) {
          problems.push(`${String(c.field)} ${String(c.op)} needs a list of at most 20 plain values`);
          return null;
        }
        leaf.value = v.map((x) => (typeof x === 'number' || typeof x === 'boolean' ? x : String(x)));
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') leaf.value = typeof v === 'string' ? v.slice(0, 500) : v;
      else {
        problems.push(`${String(c.field)} ${String(c.op)} compares with a value that is not text, a number or true/false`);
        return null;
      }
    }
    return leaf;
  }
  const parts: Condition[] = [];
  for (const k of ['all', 'any', 'none'] as const) {
    const kids = c[k];
    if (!Array.isArray(kids)) continue;
    if (k === 'any' && !kids.length) continue;
    const mapped = kids.map((x) => mapCondition(x, fieldOf, problems)).filter((x): x is Condition => !!x);
    if (mapped.length !== kids.length) return null;
    if (!mapped.length) continue;
    parts.push(k === 'all' ? { all: mapped } : k === 'any' ? { any: mapped } : { none: mapped });
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0]! : { all: parts };
}

export interface FormPlan {
  sourceId: string;
  sourceKey: string;
  name: string;
  title: string;
  entity: string;
  action: 'create' | 'update' | 'unchanged' | 'skip';
  existingId: string | null;
  definition: FormDefinition | null;
  notes: string[];
  dropped: Dropped[];
  reason: string | null;
}

const condLeaves = (c: Condition): Leaf[] => ('all' in c ? c.all.flatMap(condLeaves) : 'any' in c ? c.any.flatMap(condLeaves) : 'none' in c ? c.none.flatMap(condLeaves) : [c]);

/**
 * A platform form as an Exprsn-AI form (version 2): its sections in order (each a wizard step when the platform shows
 * them as steps), help texts, `visibleWhen` trees as `visibleIf` trees over earlier fields, the submit label and
 * success message.
 */
export function mapForm(pf: PForm, ep: EntityPlan | undefined, takenNames: Set<string>): Omit<FormPlan, 'action' | 'existingId'> {
  const name = nameFrom(pf.key, takenNames);
  const out = { sourceId: pf.id, sourceKey: pf.key, name, title: (pf.name || pf.key).slice(0, 200), entity: ep?.name ?? pf.entityKey, definition: null as FormDefinition | null, notes: [] as string[], dropped: [] as Dropped[], reason: null as string | null };
  if (!ep) return { ...out, reason: `its entity ${pf.entityKey} is not imported` };
  if (name !== pf.key) out.notes.push(`renamed from ${pf.key}`);
  const byKey = new Map(ep.plans.map((p) => [p.source, p]));
  const fieldDef = new Map(ep.definition.fields.map((f) => [f.name, f]));
  const fields: FormDefinition['fields'] = [];
  const sections: { id: string; title?: string; fields: string[] }[] = [];
  const placed = new Set<string>();
  // a form condition reads the answers by field key (the platform also accepts data.<key> and record.data.<key>)
  const fieldOf = (why: string[]) => (path: string): string | null => {
    const m = /^(?:record\.data\.|data\.)?([A-Za-z][A-Za-z0-9_]*)$/.exec(path);
    const fp = m ? byKey.get(m[1]!) : undefined;
    if (!fp) {
      why.push(`it reads ${path}, which is not a field of the form`);
      return null;
    }
    return fp.name;
  };
  (pf.layout?.sections ?? []).forEach((s, si) => {
    const sec = { id: `s${si + 1}`, ...(s.title ? { title: String(s.title).slice(0, 200) } : {}), fields: [] as string[] };
    for (const entry of s.fields ?? []) {
      const e = typeof entry === 'string' ? { key: entry } : (entry as { key?: string; help?: string; placeholder?: string; visibleWhen?: PCondition | null });
      if (!e || typeof e.key !== 'string') continue;
      const fp = byKey.get(e.key);
      const def = fp ? fieldDef.get(fp.name) : undefined;
      if (!fp || !def) {
        out.dropped.push({ what: `field ${e.key}`, why: 'it is not a field of the entity.' });
        continue;
      }
      if (def.type === 'formula' || def.type === 'ai') {
        out.dropped.push({ what: `field ${e.key}`, why: 'it is computed; a form cannot ask for it.' });
        continue;
      }
      if (placed.has(fp.name)) continue;
      const item: FormDefinition['fields'][number] = { field: fp.name };
      if (typeof e.help === 'string' && e.help.trim()) item.help = e.help.trim().slice(0, 500);
      if (typeof e.placeholder === 'string' && e.placeholder) out.dropped.push({ what: `${e.key}: placeholder`, why: 'Exprsn-AI forms show the help text, not a placeholder.' });
      if (e.visibleWhen) {
        const why: string[] = [];
        const c = mapCondition(e.visibleWhen, fieldOf(why), why);
        const later = c ? condLeaves(c).filter((l) => !placed.has(l.field)) : [];
        if (c && !later.length) item.visibleIf = c;
        else out.dropped.push({ what: `${e.key}: visible when`, why: `${[...why, ...later.map((l) => `it reads ${l.field}, which comes later on the form (a condition reads earlier fields)`)].join('; ') || 'it could not be read'}; the field is shown always.` });
      }
      fields.push(item);
      sec.fields.push(fp.name);
      placed.add(fp.name);
    }
    if (sec.fields.length) sections.push(sec);
  });
  if (!fields.length) return { ...out, reason: 'none of its fields can be asked for in Exprsn-AI' };
  if (fields.length > 100) return { ...out, reason: 'it asks for more than 100 fields, which an Exprsn-AI form cannot' };
  const wizard = !!pf.layout?.steps && sections.length > 1;
  const layout = sections.length > 1 || sections.some((x) => x.title) || wizard ? { mode: wizard ? ('wizard' as const) : ('sections' as const), sections, ...(wizard ? { steps: sections.map((x, i) => ({ id: `step${i + 1}`, title: x.title ?? `Step ${i + 1}`, sections: [x.id] })) } : {}) } : null;
  if (wizard) out.notes.push(`${sections.length} wizard steps, one per section`);
  else if (layout) out.notes.push(`${sections.length} section${sections.length === 1 ? '' : 's'}`);
  const submit = typeof pf.layout?.submitLabel === 'string' ? pf.layout.submitLabel.slice(0, 60) : undefined;
  const success = typeof pf.settings?.successMessage === 'string' ? pf.settings.successMessage.slice(0, 500) : undefined;
  if (pf.isPublic) out.dropped.push({ what: 'public link', why: 'a public link is never carried over; make the form public on the Forms tab, which shows its new link once.' });
  for (const k of Object.keys(pf.settings ?? {})) if (k !== 'successMessage') out.dropped.push({ what: `setting ${k}`, why: 'not an Exprsn-AI form setting.' });
  const tree = fields.some((f) => f.visibleIf);
  const candidate = { ...(layout || tree ? { version: 2 as const } : {}), fields, ...(layout ? { layout } : {}), ...(submit ? { submitLabel: submit } : {}), ...(success ? { successMessage: success } : {}) };
  const parsed = formDefinitionSchema.safeParse(candidate);
  const problems = parsed.success ? layoutProblems(parsed.data as LayoutDefinition) : [];
  if (!parsed.success || problems.length) return { ...out, reason: `it does not make a valid form: ${parsed.success ? problems.join(' ').slice(0, 300) : (parsed.error.issues[0]?.message ?? 'invalid')}` };
  return { ...out, definition: parsed.data };
}

export interface FlowPlan {
  sourceId: string;
  sourceKey: string;
  name: string;
  title: string;
  imported: boolean;
  action: 'create' | 'update' | 'skip';
  existingId: string | null;
  input: FlowInput | null;
  reasons: string[];
  notes: string[];
}

/** Maps a platform flow onto an app flow, or says why it is not imported (it is all or nothing: no half flows). */
export function mapFlow(pf: PFlow, sourceAppId: string, entities: Map<string, EntityPlan>, takenNames: Set<string>, recordTarget: (platformId: string) => string | null): Omit<FlowPlan, 'action' | 'existingId'> {
  const name = nameFrom(pf.key, takenNames);
  const reasons: string[] = [];
  const notes: string[] = [];
  const out = { sourceId: pf.id, sourceKey: pf.key, name, title: (pf.name || pf.key).slice(0, 200), notes };
  if (name !== pf.key) notes.push(`renamed from ${pf.key}`);
  // the trigger
  const ttype = pf.trigger?.type ?? 'event';
  let trigger: FlowInput['trigger'] | null = null;
  if (ttype === 'event') {
    if (pf.event === 'lowcode.record.created') trigger = { kind: 'record', events: ['created'] };
    else if (pf.event === 'lowcode.record.updated') trigger = { kind: 'record', events: ['updated'] };
    else reasons.push(`it starts on the platform event ${pf.event}, which is not a record of this app`);
  } else if (ttype === 'schedule') trigger = { kind: 'schedule', cron: String(pf.trigger?.cron ?? '') };
  else if (ttype === 'manual') trigger = { kind: 'manual' };
  else if (ttype === 'webhook') {
    trigger = { kind: 'webhook' };
    notes.push('a webhook flow: its hook arrives off and without a secret (the platform\u2019s URL and secret never carry over); make a secret on the Flows tab, turn the hook on and point the sender at the new signed URL');
  }
  else reasons.push(`its trigger ${ttype} is not one Exprsn-AI has`);

  // which entity: the `entity` test of the condition (dropped), else the only entity
  let entityKey: string | null = null;
  const match = pf.match ?? null;
  let rest: PCondition | null = match;
  // the app and entity tests are AND-ed at the top: a leaf root, or the root's `all` (beside any `any` or `none`)
  const leafRoot = !!match && (match.field !== undefined || match.op !== undefined);
  const top = match && !leafRoot && Array.isArray(match.all) ? match.all : leafRoot ? [match!] : null;
  if (top) {
    const keep: PCondition[] = [];
    for (const l of top) {
      if (l.field === 'app' && l.op === 'equals') {
        if (l.value !== sourceAppId) reasons.push('it watches the records of another platform app');
        continue;
      }
      if (l.field === 'entity' && l.op === 'equals' && typeof l.value === 'string') {
        entityKey = l.value;
        continue;
      }
      if (l.field === 'module' && l.op === 'equals' && l.value === 'lowcode') continue;
      keep.push(l);
    }
    const others = leafRoot ? {} : { ...(match!.any ? { any: match!.any } : {}), ...(match!.none ? { none: match!.none } : {}) };
    rest = keep.length || Object.keys(others).length ? { ...(keep.length ? { all: keep } : {}), ...others } : null;
  }
  if (!entityKey) {
    const actionEntity = pf.actions.map((a) => a.entityKey ?? a.entity).find((x): x is string => typeof x === 'string');
    if (trigger?.kind !== 'record' && actionEntity && entities.has(actionEntity)) entityKey = actionEntity;
    else if (entities.size === 1) entityKey = [...entities.keys()][0]!;
  }
  const ep = entityKey ? entities.get(entityKey) : undefined;
  if (!ep) reasons.push(entityKey ? `its entity ${entityKey} is not imported` : 'it does not say which entity’s records it watches');
  const record = trigger?.kind === 'record';
  const pathField = (plan: EntityPlan | undefined) => (path: string): string | null => {
    if (!plan) return null;
    if (!record) {
      reasons.push(`it tests ${path}, but a ${trigger?.kind ?? ''} flow has no record`);
      return null;
    }
    if (path === 'record.state' || path === 'state') return 'state';
    const m = /^(?:record\.data\.|data\.)?([A-Za-z][A-Za-z0-9_]*)$/.exec(path);
    const fp = m && (path.startsWith('record.data.') || path.startsWith('data.')) ? plan.plans.find((p) => p.source === m[1]) : undefined;
    if (!fp) {
      reasons.push(`it tests ${path}, which an Exprsn-AI record flow does not carry (only the record's fields and state)`);
      return null;
    }
    return fp.name;
  };
  const condProblems: string[] = [];
  const cond = rest ? mapCondition(rest, pathField(ep), condProblems) : null;
  reasons.push(...condProblems);
  if (rest && !cond && !condProblems.length && reasons.length === 0) reasons.push('its condition could not be read');

  // the actions
  const actions: FlowAction[] = [];
  pf.actions.forEach((a, i) => {
    const where = `action ${i + 1} (${a.type})`;
    const common: { onError: 'stop' | 'continue'; retries: number; when?: Condition | null } = { onError: a.onError === 'stop' ? 'stop' : 'continue', retries: Math.min(3, Math.max(0, Number(a.retries) || 0)) };
    if (a.when) {
      const ps: string[] = [];
      const w = mapCondition(a.when, pathField(ep), ps);
      if (!w) {
        reasons.push(`${where}: its condition ${ps.join('; ') || 'could not be read'}`);
        return;
      }
      common.when = w;
    }
    const targetKey = a.entityKey ?? a.entity ?? entityKey;
    if (a.entity && !a.entityKey && a.type.endsWith('_record')) notes.push(`${where} names its entity as "entity", which the platform's engine does not read (it uses entityKey, else the triggering entity): imported as written, into ${a.entity}`);
    const tp = targetKey ? entities.get(targetKey) : undefined;
    const valuesOf = (data: Record<string, unknown> | undefined): Record<string, string> | null => {
      const vals: Record<string, string> = {};
      for (const [k, v] of Object.entries(data ?? {})) {
        const fp = tp?.plans.find((p) => p.source === k);
        if (!fp || fp.computed) {
          reasons.push(`${where}: it sets ${k}, which is not a writable field of ${targetKey}`);
          return null;
        }
        if (v !== null && typeof v === 'object') {
          reasons.push(`${where}: it sets ${k} to an object; a flow sets text, numbers or true/false`);
          return null;
        }
        if (fp.refEntity && v != null) {
          const t = recordTarget(String(v));
          if (!t) {
            reasons.push(`${where}: it sets ${k} to a platform record that is not imported`);
            return null;
          }
          vals[fp.name] = t;
          continue;
        }
        const s = v == null ? '' : String(convertValue(fp.target, v) ?? '');
        if (s.includes('{{')) notes.push(`${where}: the value of ${k} contains {{, which Exprsn-AI reads as a template`);
        vals[fp.name] = s.slice(0, 5000);
      }
      return vals;
    };
    switch (a.type) {
      case 'create_record': {
        if (!tp) return void reasons.push(`${where}: its entity ${targetKey ?? '?'} is not imported`);
        const values = valuesOf(a.data);
        if (!values) return;
        actions.push({ type: 'create', entity: tp.name, values, ...common });
        return;
      }
      case 'update_record': {
        if (!tp) return void reasons.push(`${where}: its entity ${targetKey ?? '?'} is not imported`);
        const values = valuesOf(a.data);
        if (!values) return;
        let rec: string | undefined;
        if (a.recordId) {
          const t = recordTarget(String(a.recordId));
          if (!t) return void reasons.push(`${where}: it updates the platform record ${String(a.recordId)}, which is not imported`);
          rec = t;
        }
        actions.push({ type: 'update', entity: tp.name, ...(rec ? { record: rec } : {}), values, ...common });
        return;
      }
      case 'transition_record': {
        if (!tp) return void reasons.push(`${where}: its entity ${targetKey ?? '?'} is not imported`);
        const tos = tp.events.get(String(a.event ?? ''));
        if (!tos || tos.size !== 1) return void reasons.push(`${where}: the event ${String(a.event)} ${tos ? 'leads to more than one state' : 'is not a transition of ' + tp.sourceKey}; Exprsn-AI moves a record to a named state`);
        let rec: string | undefined;
        if (a.recordId) {
          const t = recordTarget(String(a.recordId));
          if (!t) return void reasons.push(`${where}: it moves the platform record ${String(a.recordId)}, which is not imported`);
          rec = t;
        }
        actions.push({ type: 'transition', entity: tp.name, ...(rec ? { record: rec } : {}), to: [...tos][0]!, ...common });
        return;
      }
      case 'log':
      case 'audit':
        notes.push(`${where} dropped: Exprsn-AI keeps every run with its steps, so a ${a.type} marker has no step of its own`);
        return;
      case 'notify':
        return void reasons.push(`${where}: the platform notifies the record's owner, whom an Exprsn-AI notify step cannot name; add the step on the Flows tab with users or roles`);
      case 'http_request': {
        const method = String(a.method ?? 'GET').toUpperCase();
        const url = typeof a.url === 'string' ? a.url.trim() : '';
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((a.headers as Record<string, unknown> | undefined) ?? {})) {
          if (/^(host|content-length|x-service-id|x-service-token)$/i.test(k)) continue;
          // a credential in a header is a literal secret, which a flow takes only as a vault reference; never copied
          if (/auth|token|key|secret|cookie|password/i.test(k)) return void reasons.push(`${where}: its header ${k} carries a credential, which an Exprsn-AI flow takes only as a vault: reference; add the HTTP action on the Flows tab with one`);
          headers[k] = String(v).slice(0, 1000);
        }
        if (!url || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return void reasons.push(`${where}: it has no URL or an unknown method`);
        const body = a.body === undefined ? undefined : typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
        notes.push(`${where}: the host of ${url.slice(0, 120)} must be on the tenant's list of allowed hosts, checked when the flow is saved`);
        actions.push({ type: 'http', method: method as 'GET', url: url.slice(0, 2000), headers, ...(body !== undefined ? { body: body.slice(0, 5000) } : {}), ...common } as FlowAction);
        return;
      }
      default:
        return void reasons.push(`${where}: the platform action ${a.type} has no Exprsn-AI flow step${['post_timeline', 'send_spark', 'post_nexus', 'enqueue_job', 'write_file', 'read_secret', 'cortex', 'flag', 'export_entity'].includes(a.type) ? ' (it reaches a platform module)' : ''}`);
    }
  });
  if (!actions.length && !reasons.length) reasons.push('none of its actions has an Exprsn-AI step');
  if (actions.length > 12) reasons.push('it has more than 12 actions');
  if (reasons.length || !trigger || !ep) return { ...out, imported: false, input: null, reasons: [...new Set(reasons)] };
  const parsed = flowInputSchema.safeParse({ name, title: out.title.slice(0, 200), description: `Imported from the platform flow ${pf.key}.`, entity: ep.name, trigger, enabled: pf.enabled !== false, match: cond, actions });
  if (!parsed.success) return { ...out, imported: false, input: null, reasons: [`it does not make a valid flow: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ').slice(0, 300)}`] };
  const pseudo = [...entities.values()].map((e) => ({ id: e.name, name: e.name, definition: e.definition }) as EntityRow);
  const problems = flowProblems(parsed.data, pseudo);
  if (problems.length) return { ...out, imported: false, input: null, reasons: problems };
  return { ...out, imported: true, input: parsed.data, reasons: [] };
}

// ---------- plans and imports ----------

export const targetSchema = z
  .object({
    /** An existing app by name (`existing`), or a new one (`new`). An app linked by an earlier import is updated either way. */
    mode: z.enum(['new', 'existing']),
    name: z.string().regex(NAME, 'lower-case letters, digits and _, starting with a letter'),
    title: z.string().trim().min(1).max(200).optional(),
    /** The new app's label; must be within the importer's clearance and the workspace's ceiling. */
    label: z.enum(LABELS).optional(),
    /** The new app's workspace: absent for the current one, null for tenant-wide. */
    workspaceId: z.string().length(26).nullable().optional()
  })
  .strict();

export const optionsSchema = z
  .object({
    records: z.boolean().default(true),
    forms: z.boolean().default(true),
    flows: z.boolean().default(true),
    /** New flows are created turned off unless this is set (then as the platform has them). */
    enableFlows: z.boolean().default(false),
    /** Write the `exprsn_ai_link` lookup on the platform app after the import (the only platform write). */
    markPlatform: z.boolean().default(false)
  })
  .strict();

export const connectionSchema = z
  .object({
    url: z.string().url().max(500).optional(),
    /** A platform bearer for this import only; kept sealed until the import ends, never shown. */
    token: z.string().min(8).max(4000).optional()
  })
  .strict();

export const planInputSchema = z
  .object({
    platformApp: z.string().min(1).max(64),
    target: targetSchema,
    options: optionsSchema.default({ records: true, forms: true, flows: true, enableFlows: false, markPlatform: false }),
    connection: connectionSchema.optional()
  })
  .strict();
export type PlanInput = z.infer<typeof planInputSchema>;

interface Snapshot {
  app: PApp;
  entities: PEntity[];
  lookups: PLookup[];
  linkLookup: PLookup | null;
  forms: PForm[];
  flows: PFlow[];
  /** 1.8.0 (B-143): the app's roles, when the platform serves them (left out of the fingerprint). */
  roles: PRole[];
  records: Map<string, { records: PRecord[]; total: number; truncated: boolean }>;
  fingerprint: string;
}

interface LinkRow {
  kind: string;
  source_id: string;
  target_app_id: string;
  target_id: string;
}

export interface Plan {
  source: { url: string; app: { id: string; key: string; name: string; status: string | null; scope: string | null } };
  target: { mode: 'new' | 'existing' | 'linked'; appId: string | null; name: string; title: string; label: Label; workspaceId: string | null };
  entities: EntityPlan[];
  forms: FormPlan[];
  flows: FlowPlan[];
  /** 1.8.0 (B-143): the platform's AppRoles as app roles (absent from plans made before roles were read). */
  roles?: RolePlan[];
  records: { total: number; create: number; update: number; invalid: number; problems: { entity: string; source: string; problems: string[] }[] };
  platformWrites: PlatformWrite[];
  dropped: Dropped[];
  warnings: string[];
  fingerprint: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const credAad = (id: string) => `platform-import:${id}`;
const MAX_PROBLEMS = 500;
const MAX_REPORT = 5000;
const PLAN_TTL_MS = 60 * 60_000;

/** The report a person reads: the plan without the field plans' internals. */
export function planReport(p: Plan) {
  return {
    ...p,
    entities: p.entities.map((e) => ({ source: e.sourceKey, name: e.name, title: e.title, action: e.action, existingId: e.existing?.id ?? null, fields: e.fields, dropped: e.dropped, changed: e.changed, states: e.definition.states ? { initial: e.definition.states.initial, states: e.definition.states.states.map((s) => s.name), transitions: e.definition.states.transitions.length, renamed: Object.fromEntries([...e.states].filter(([a, b]) => a !== b)) } : null, records: e.records })),
    forms: p.forms.map(({ definition, ...f }) => ({ ...f, fields: definition?.fields.length ?? 0 })),
    flows: p.flows.map(({ input, ...f }) => ({ ...f, trigger: input?.trigger ?? null, actions: input?.actions.map((a) => a.type) ?? [], enabled: input?.enabled ?? null }))
  };
}

export class AppPlatformImport {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register('apps.platform-import', (p, ctx) => this.run(String(p.importId), ctx), { timeoutMs: 2 * 60 * 60_000 });
  }

  /** The importer must design apps and hold the operator's platform connection (platform:manage). */
  private assertMay(p: Principal): void {
    for (const perm of ['apps:design', 'platform:manage'] as const) {
      const d = authorize(p, perm);
      if (!d.allow) throw forbidden(`Importing from the Exprsn platform needs ${perm}.`, { step: d.step });
    }
  }

  private audit(p: Principal, action: string, target: Record<string, unknown>, label: Label, detail: Record<string, unknown>, o: { ip?: string | null; traceId?: string | null } = {}) {
    return this.s().audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, o.ip ?? null), target, label, detail, traceId: o.traceId ?? null });
  }

  /** The client for the configured platform, or for the URL and token given for one import. */
  client(conn: { url?: string | undefined; token?: string | undefined } | undefined, onWrite?: (w: PlatformWrite & { status: number }) => Promise<void>): PlatformLowcodeClient {
    const cfg = this.s().cfg;
    const raw = conn?.url ?? cfg.PLATFORM_LOWCODE_URL;
    if (!raw) throw new HttpProblem(503, 'Platform not configured', 'Set PLATFORM_LOWCODE_URL (and PLATFORM_LOWCODE_TOKEN_FILE) to import from the Exprsn platform.');
    const token = bearerOf(conn?.token) ?? bearerOf(cfg.PLATFORM_LOWCODE_TOKEN);
    if (!token) throw new HttpProblem(503, 'Platform not configured', 'No platform token: set PLATFORM_LOWCODE_TOKEN_FILE, or pass a token for this import.');
    return new PlatformLowcodeClient(platformBase(raw), token, cfg, onWrite);
  }

  private async links(tenantId: string, source: string): Promise<Map<string, LinkRow>> {
    const rows = (await this.db('app_platform_links').where({ tenant_id: tenantId, source })) as LinkRow[];
    return new Map(rows.map((r) => [`${r.kind}:${r.source_id}`, r]));
  }

  private async link(tenantId: string, source: string, kind: string, sourceId: string, appId: string, targetId: string, importId: string): Promise<void> {
    const row = { tenant_id: tenantId, source, kind, source_id: sourceId, target_app_id: appId, target_id: targetId, import_id: importId, updated_at: Date.now() };
    const n = await this.db('app_platform_links').where({ tenant_id: tenantId, source, kind, source_id: sourceId }).update(row);
    if (!n) await this.db('app_platform_links').insert(row);
  }

  // ---------- listing ----------

  /** The platform apps the configured account can import, with where each was imported to (here and as marked there). */
  async list(p: Principal) {
    this.assertMay(p);
    // Not configured is a state, not a failure: the console says so instead of reporting an error.
    let c: PlatformLowcodeClient;
    try {
      c = this.client(undefined);
    } catch (err) {
      if (err instanceof HttpProblem && err.title === 'Platform not configured') return { configured: false as const, reason: err.detail ?? null, url: null, apps: [] };
      throw err;
    }
    const health = await c.health();
    if (health.enabled === false) throw new HttpProblem(503, 'Platform low-code off', 'The platform’s Lowcode module is off (LOWCODE_ENABLED).');
    const apps = await c.apps();
    const links = await this.links(p.tenantId, c.base);
    const out = [];
    for (const a of apps) {
      const l = links.get(`app:${a.id}`);
      const target = l ? await this.apps.appById(p.tenantId, l.target_app_id) : undefined;
      let marked: { appId: string; label: string }[];
      try {
        const lk = (await c.lookups(a.id)).find((x) => x.key === LINK_LOOKUP);
        marked = (lk?.values ?? []).map((v) => ({ appId: String(v.value), label: String(v.label ?? v.value) }));
      } catch {
        marked = [];
      }
      out.push({ id: a.id, key: a.key, name: a.name, description: a.description ?? null, status: a.status ?? null, scope: a.scopeType ?? null, imported: target ? { appId: target.id, name: target.name, title: target.title } : null, markedOnPlatform: marked });
    }
    return { configured: true as const, url: c.base, apps: out };
  }

  // ---------- reading and planning ----------

  private async snapshot(c: PlatformLowcodeClient, ref: string, withRecords: boolean, max: number): Promise<Snapshot> {
    const listed = await c.apps();
    const found = listed.find((a) => a.id === ref || a.key === ref);
    if (!found) throw notFound('Platform app');
    const app = await c.app(found.id);
    const [entities, lookupsAll, forms, flows, roles] = await Promise.all([c.entities(app.id), c.lookups(app.id), c.forms(app.id), c.flows(app.id), c.roles(app.id)]);
    const linkLookup = lookupsAll.find((l) => l.key === LINK_LOOKUP) ?? null;
    const lookups = lookupsAll.filter((l) => l.key !== LINK_LOOKUP);
    const records = new Map<string, { records: PRecord[]; total: number; truncated: boolean }>();
    if (withRecords) for (const e of entities) records.set(e.id, await c.records(app.id, e.key, max));
    // what a dry run and its import must agree on: the design (records may change in between)
    const design = {
      app: { key: app.key, name: app.name },
      entities: [...entities].sort((a, b) => a.key.localeCompare(b.key)).map((e) => ({ id: e.id, key: e.key, fields: e.fields, stateMachine: e.stateMachine ?? null })),
      lookups: [...lookups].sort((a, b) => a.key.localeCompare(b.key)).map((l) => ({ key: l.key, values: l.values, source: l.source ?? null })),
      forms: [...forms].sort((a, b) => a.key.localeCompare(b.key)).map((f) => ({ key: f.key, entityKey: f.entityKey, layout: f.layout ?? null, settings: f.settings ?? null })),
      flows: [...flows].sort((a, b) => a.key.localeCompare(b.key)).map((f) => ({ key: f.key, event: f.event, trigger: f.trigger ?? null, match: f.match ?? null, actions: f.actions, enabled: f.enabled !== false }))
    };
    return { app, entities, lookups, linkLookup, forms, flows, roles, records, fingerprint: sha(JSON.stringify(design)) };
  }

  /** Where the import goes: the app an earlier import made (linked), an existing app by name, or a new one. */
  private async resolveTarget(p: Principal, base: string, snap: Snapshot, t: z.infer<typeof targetSchema>, links: Map<string, LinkRow>, warnings: string[]): Promise<{ mode: 'new' | 'existing' | 'linked'; app: AppRow | null; label: Label; workspaceId: string | null }> {
    void base;
    const l = links.get(`app:${snap.app.id}`);
    const linked = l ? await this.apps.appById(p.tenantId, l.target_app_id) : undefined;
    if (linked) {
      const app = await this.apps.designable(p, linked.id);
      if (t.mode === 'new' || t.name !== app.name) warnings.push(`The platform app ${snap.app.key} was imported before, as ${app.name}; this import updates ${app.name} (the target you chose is not used).`);
      return { mode: 'linked', app, label: app.label, workspaceId: app.workspace_id };
    }
    if (t.mode === 'existing') {
      const app = await this.apps.designable(p, t.name);
      if (t.label && t.label !== app.label) warnings.push(`${app.name} keeps its label ${app.label}; change it on the app if it should be ${t.label}.`);
      return { mode: 'existing', app, label: app.label, workspaceId: app.workspace_id };
    }
    const label = t.label;
    if (!label) throw badRequest('Choose the new app’s label.');
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; a ${label} app is above it.`, { step: 'clearance' });
    const workspaceId = t.workspaceId === undefined ? (p.workspaceId ?? null) : t.workspaceId;
    const clash = await this.apps.app(p, t.name).catch(() => null);
    if (clash && (clash.workspace_id ?? null) === workspaceId) throw conflict(`An app named ${t.name} exists ${workspaceId ? 'in that workspace' : 'tenant-wide'}; import into it (existing) or choose another name.`);
    return { mode: 'new', app: null, label, workspaceId };
  }

  /** Builds the whole mapping from a snapshot onto the target. Pure apart from reading the target's entities, forms and flows. */
  private async build(p: Principal, base: string, snap: Snapshot, input: PlanInput, links: Map<string, LinkRow>): Promise<Plan> {
    const warnings: string[] = [];
    const dropped: Dropped[] = [];
    const target = await this.resolveTarget(p, base, snap, input.target, links, warnings);
    const app = target.app;
    const have = app ? await this.apps.entities(app) : [];
    const linkedTo = (kind: string, id: string): string | null => {
      const l = links.get(`${kind}:${id}`);
      return l && app && l.target_app_id === app.id ? l.target_id : null;
    };

    // app-level things the platform has and Exprsn-AI does not
    if (snap.app.capabilities?.length) dropped.push({ what: `app capabilities ${snap.app.capabilities.join(', ')}`, why: 'platform-module grants for flows; Exprsn-AI flows act through their workflow and its owner.' });
    if (snap.app.scopeType && snap.app.scopeType !== 'platform') dropped.push({ what: `app scope ${snap.app.scopeType}`, why: `the platform owner scope; the Exprsn-AI app is ${target.workspaceId ? 'in a workspace' : 'tenant-wide'} at ${target.label}.` });
    if (snap.app.status && snap.app.status !== 'published') warnings.push(`The platform app is ${snap.app.status}; Exprsn-AI apps have no draft or archived state.`);
    for (const l of snap.lookups) if (!snap.entities.some((e) => e.fields.some((f) => f.enumLookup === l.key))) dropped.push({ what: `lookup ${l.key}`, why: 'no field uses it; Exprsn-AI keeps options on the field (a shared list is an entity).' });

    // entity names first (references need them)
    const taken = new Set(have.map((e) => e.name));
    const entityNames = new Map<string, string>();
    const existingFor = new Map<string, EntityRow | null>();
    for (const e of snap.entities) {
      const linkedId = linkedTo('entity', e.id);
      const byLink = linkedId ? have.find((x) => x.id === linkedId) : undefined;
      let name: string;
      let existing: EntityRow | null = null;
      if (byLink) {
        name = byLink.name;
        existing = byLink;
      } else {
        const want = nameFrom(e.key, new Set());
        const same = have.find((x) => x.name === want && ![...existingFor.values()].some((y) => y?.id === x.id));
        if (same) {
          name = same.name;
          existing = same;
        } else name = nameFrom(e.key, taken);
      }
      taken.add(name);
      entityNames.set(e.key, name);
      existingFor.set(e.key, existing);
    }
    const ctx: MapContext = { lookups: new Map(snap.lookups.map((l) => [l.key, l])), entityNames };

    const entities: EntityPlan[] = [];
    for (const e of snap.entities) {
      const recs = snap.records.get(e.id) ?? { records: [], total: 0, truncated: false };
      const existing = existingFor.get(e.key) ?? null;
      const fields: FieldReport[] = [];
      const eDropped: Dropped[] = [];
      const changed: string[] = [];
      const takenF = new Set<string>();
      const mapped: { pf: PField; field: Field; plan: Omit<FieldPlan, 'target'>; report: FieldReport }[] = [];
      for (const pf of e.fields) {
        const name = nameFrom(pf.key, takenF, RESERVED);
        const m = mapField(pf, name, recs.records, ctx);
        mapped.push({ pf, ...m });
        eDropped.push(...m.dropped);
      }
      // formulas once every name is known
      const plain = new Set(mapped.filter((m) => m.pf.formula == null).map((m) => m.field.name));
      const keyToName = new Map(mapped.map((m) => [m.pf.key, m.field.name]));
      for (const m of mapped) {
        if (m.pf.formula == null) continue;
        const f = formulaField(m.pf, m.field, plain, keyToName);
        m.field = f.field;
        m.plan = { ...m.plan, computed: f.computed };
        m.report.notes = m.report.notes.filter((x) => x !== 'computed on the platform');
        m.report.notes.push(f.note);
        m.report.to = f.field.type;
      }
      if (e.description) eDropped.push({ what: 'entity description', why: 'Exprsn-AI entities have a title, not a description.' });
      if (e.storage?.mode && e.storage.mode !== 'db') eDropped.push({ what: `storage mode ${e.storage.mode}`, why: 'records live in Exprsn-AI’s own sealed store; an outside table is a source on the Entities tab.' });
      const sm = mapStates(e.stateMachine);
      eDropped.push(...sm.dropped);

      let definition: EntityDefinition;
      const plans: FieldPlan[] = [];
      if (!existing) {
        definition = { fields: mapped.map((m) => m.field), ...(sm.states ? { states: sm.states } : {}) };
        for (const m of mapped) plans.push({ ...m.plan, target: m.field });
        for (const m of mapped) fields.push(m.report);
        if (sm.notes.length) changed.push(...sm.notes);
      } else {
        // merge into the existing entity: its fields win, what it lacks is added
        const cur = existing.definition;
        const outFields = [...cur.fields];
        const hasRecords = !!(await this.db('app_records').where({ entity_id: existing.id }).first('id'));
        for (const m of mapped) {
          const same = cur.fields.find((f) => f.name === m.field.name);
          if (same) {
            const notes = [...m.report.notes];
            if (same.type !== m.field.type) notes.push(`the existing field is ${same.type}; it is kept, and values are converted to it`);
            let tgt = same;
            if (same.type === 'enum' && m.field.type === 'enum') {
              const add = m.field.options.filter((o) => !same.options.some((x) => normText(x.value) === normText(o.value)));
              if (add.length && same.options.length + add.length <= 200) {
                tgt = { ...same, options: [...same.options, ...add] };
                outFields[outFields.findIndex((f) => f.name === same.name)] = tgt;
                changed.push(`${same.name}: options ${add.map((o) => o.value).join(', ').slice(0, 120)} added`);
              }
            }
            const needLen = Math.max(m.pf.max ?? 0, observe(recs.records, m.pf.key).maxLen);
            if (same.type === 'string' && m.field.type === 'string' && ((m.field.multiline && !same.multiline) || needLen > same.maxLength)) {
              const wantLen = Math.max(same.maxLength, Math.min(100_000, needLen));
              if (!((same.indexed || same.unique) && wantLen > INDEX_TEXT_MAX)) {
                tgt = { ...same, maxLength: wantLen, ...(m.field.multiline || same.multiline ? { multiline: true } : {}) };
                outFields[outFields.findIndex((f) => f.name === same.name)] = tgt;
                changed.push(`${same.name}: ${m.field.multiline && !same.multiline ? 'multi-line, ' : ''}maxLength ${wantLen}`);
              }
            }
            const computed = tgt.type === 'formula' || tgt.type === 'ai';
            const refEntity = tgt.type === 'reference' ? [...entityNames].find(([, n]) => n === tgt.entity)?.[0] ?? null : tgt.type === 'lookup' && tgt.source === 'entity' ? [...entityNames].find(([, n]) => n === tgt.entity)?.[0] ?? null : null;
            plans.push({ ...m.plan, target: tgt, computed, refEntity, skip: tgt.type === 'file' ? 'an Exprsn-AI file field holds a file of this tenant; the platform file is not copied' : (tgt.type === 'reference' || (tgt.type === 'lookup' && tgt.source === 'entity')) && !refEntity ? 'the existing field refers to an entity this import does not fill' : null });
            fields.push({ ...m.report, to: tgt.type, notes: [...notes, 'kept the existing field'] });
          } else {
            const add = hasRecords && m.field.required ? ({ ...m.field, required: false } as Field) : m.field;
            if (add !== m.field) changed.push(`${add.name}: added as optional (the entity has records without it)`);
            else changed.push(`${add.name}: added`);
            outFields.push(add);
            plans.push({ ...m.plan, target: add });
            fields.push(m.report);
          }
        }
        const merged = mergeStates(cur.states, sm.states);
        changed.push(...merged.changed);
        definition = { ...cur, fields: outFields, ...(merged.states ? { states: merged.states } : {}) };
        // the platform's states land on the existing machine's names (they are the same names or added)
      }
      // the definition must be valid: check it with every entity name of the target
      const parsed = entityDefinitionSchema.safeParse(definition);
      const problems = parsed.success ? checkDefinition(parsed.data, new Set([...taken, ...entityNames.values()])) : [parsed.error.issues[0]?.message ?? 'invalid'];
      if (problems.length) warnings.push(`Entity ${e.key}: ${problems.join(' ')}`);
      if (parsed.success) definition = parsed.data;
      const action: EntityPlan['action'] = !existing ? 'create' : JSON.stringify(existing.definition) === JSON.stringify(definition) ? 'unchanged' : 'update';
      entities.push({ sourceId: e.id, sourceKey: e.key, name: entityNames.get(e.key)!, title: (e.name || e.key).slice(0, 200), action, existing, definition, fields, dropped: eDropped, changed, plans, states: sm.map, events: sm.events, records: { total: recs.total, read: recs.records.length, truncated: recs.truncated, create: 0, update: 0, invalid: 0 } });
      if (recs.truncated) warnings.push(`${e.key} has ${recs.total} records; only the first ${recs.records.length} are imported (PLATFORM_IMPORT_MAX_RECORDS).`);
    }
    const byKey = new Map(entities.map((x) => [x.sourceKey, x]));

    // records: validation as the import will write them
    const problems: Plan['records']['problems'] = [];
    const sourceIds = new Set<string>();
    for (const r of snap.records.values()) for (const x of r.records) sourceIds.add(x.id);
    const counts = { total: 0, create: 0, update: 0, invalid: 0 };
    if (input.options.records) {
      for (const ep of entities) {
        const pe = snap.entities.find((e) => e.id === ep.sourceId)!;
        const recs = snap.records.get(pe.id)?.records ?? [];
        const uniques = new Map<string, string>();
        for (const r of recs) {
          counts.total++;
          const out = this.valuesFor(ep, r, (pid) => (sourceIds.has(pid) || linkedTo('record', pid) ? ID_PLACEHOLDER : null));
          const ps = [...out.problems];
          try {
            const stored = validateValues(ep.definition, out.values);
            for (const f of ep.definition.fields) {
              if (!f.unique || stored[f.name] == null) continue;
              const k = `${f.name}:${typeof stored[f.name] === 'string' ? normText(String(stored[f.name])) : JSON.stringify(stored[f.name])}`;
              const prior = uniques.get(k);
              if (prior) ps.push(`${f.name}: the same value as record ${prior}; it is unique`);
              else uniques.set(k, r.id);
            }
          } catch (err) {
            if (err instanceof ValueError) ps.push(...err.problems.map((x) => `${x.field}: ${x.message}`));
            else ps.push((err as Error).message);
          }
          if (r.state && ep.definition.states && !ep.states.has(r.state)) ps.push(`state ${r.state} is not a state of the machine; the record keeps the initial state`);
          if (ps.length) {
            counts.invalid++;
            ep.records.invalid++;
            if (problems.length < MAX_PROBLEMS) problems.push({ entity: ep.name, source: r.id, problems: ps });
          } else if (linkedTo('record', r.id)) {
            counts.update++;
            ep.records.update++;
          } else {
            counts.create++;
            ep.records.create++;
          }
        }
      }
    }

    // forms
    const forms: FormPlan[] = [];
    if (input.options.forms) {
      const haveForms = app ? ((await this.db('app_forms').where({ app_id: app.id }).select('id', 'name', 'definition', 'title')) as { id: string; name: string; definition: string; title: string }[]) : [];
      const takenNames = new Set(haveForms.map((f) => f.name));
      for (const pf of snap.forms) {
        const linkedId = linkedTo('form', pf.id);
        const existing = linkedId ? haveForms.find((f) => f.id === linkedId) : undefined;
        if (existing) takenNames.delete(existing.name);
        const m = mapForm(pf, byKey.get(pf.entityKey), takenNames);
        if (existing && m.name !== existing.name) {
          takenNames.delete(m.name);
          m.name = existing.name;
          takenNames.add(existing.name);
        }
        const same = existing && m.definition && JSON.stringify(json(existing.definition, {})) === JSON.stringify(m.definition) && existing.title === m.title;
        forms.push({ ...m, action: m.reason ? 'skip' : existing ? (same ? 'unchanged' : 'update') : 'create', existingId: existing?.id ?? null });
      }
    } else if (snap.forms.length) dropped.push({ what: `${snap.forms.length} form(s)`, why: 'forms were left out of this import.' });

    // flows
    const flows: FlowPlan[] = [];
    if (input.options.flows) {
      const mayFlows = authorize(p, 'workflows:manage').allow;
      const haveFlows = app ? ((await this.db('app_flows').where({ app_id: app.id }).select('id', 'name')) as { id: string; name: string }[]) : [];
      const takenNames = new Set(haveFlows.map((f) => f.name));
      for (const pf of snap.flows) {
        const linkedId = linkedTo('flow', pf.id);
        const existing = linkedId ? haveFlows.find((f) => f.id === linkedId) : undefined;
        if (existing) takenNames.delete(existing.name);
        const m = mapFlow(pf, snap.app.id, byKey, takenNames, (pid) => (sourceIds.has(pid) || linkedTo('record', pid) ? linkedTo('record', pid) ?? ID_PLACEHOLDER : null));
        if (existing) m.name = existing.name;
        if (m.input && existing) m.input = { ...m.input, name: existing.name };
        if (m.imported && !mayFlows) {
          m.imported = false;
          m.reasons = ['importing a flow creates and publishes its workflow, which needs workflows:manage'];
        }
        if (m.imported && !input.options.enableFlows && m.input && !existing) {
          if (m.input.enabled) m.notes.push('created turned off; turn it on on the Flows tab once checked (or import with enableFlows)');
          m.input = { ...m.input, enabled: false };
        }
        flows.push({ ...m, action: m.imported ? (existing ? 'update' : 'create') : 'skip', existingId: existing?.id ?? null });
      }
    } else if (snap.flows.length) dropped.push({ what: `${snap.flows.length} flow(s)`, why: 'flows were left out of this import.' });

    // 1.8.0 (B-143): the platform's AppRoles become the app's roles by name (who holds them is not carried).
    const roles = mapPlatformRoles(snap.roles, app ? await this.apps.roles.keys(app) : new Set<string>(), dropped);
    if (snap.roles.length) dropped.push({ what: 'role assignments', why: 'who holds a role is set per environment; assign people, groups or a workspace on the Roles tab.' });

    const platformWrites: PlatformWrite[] = input.options.markPlatform ? [snap.linkLookup ? { method: 'PUT', path: `/lowcode/api/design/lookups/${snap.linkLookup.id}`, purpose: `adds this Exprsn-AI app to the lookup ${LINK_LOOKUP} of ${snap.app.key}` } : { method: 'POST', path: '/lowcode/api/design/lookups', purpose: `creates the lookup ${LINK_LOOKUP} on ${snap.app.key}, naming the Exprsn-AI app it was imported into` }] : [];
    return {
      source: { url: base, app: { id: snap.app.id, key: snap.app.key, name: snap.app.name, status: snap.app.status ?? null, scope: snap.app.scopeType ?? null } },
      target: { mode: target.mode, appId: app?.id ?? null, name: app?.name ?? input.target.name, title: app?.title ?? input.target.title ?? snap.app.name.slice(0, 200), label: target.label, workspaceId: target.workspaceId },
      entities,
      forms,
      flows,
      roles,
      records: { ...counts, problems },
      platformWrites,
      dropped,
      warnings,
      fingerprint: snap.fingerprint
    };
  }

  /** One platform record's values for the target entity; references resolved by `ref` (null: not imported). */
  private valuesFor(ep: EntityPlan, r: PRecord, ref: (platformId: string) => string | null): { values: Values; deferred: Values; problems: string[] } {
    const values: Values = {};
    const deferred: Values = {};
    const problems: string[] = [];
    for (const fp of ep.plans) {
      if (fp.computed || fp.skip) continue;
      const raw = r.data[fp.source];
      if (raw === undefined || raw === null || raw === '') continue;
      if (fp.refEntity) {
        const t = ref(String(raw));
        if (t === null) problems.push(`${fp.name}: refers to the platform record ${String(raw)}, which is not imported`);
        else if (t === '') deferred[fp.name] = String(raw);
        else values[fp.name] = t;
        continue;
      }
      values[fp.name] = convertValue(fp.target, raw);
    }
    return { values, deferred, problems };
  }

  /** The dry run: reads the platform app, maps it onto the target and keeps the plan for `start`. */
  async plan(actor: Actor & { principal: Principal }, raw: unknown) {
    const p = actor.principal;
    this.assertMay(p);
    const input = planInputSchema.parse(raw);
    const c = this.client(input.connection);
    const snap = await this.snapshot(c, input.platformApp, input.options.records, this.s().cfg.PLATFORM_IMPORT_MAX_RECORDS);
    const links = await this.links(p.tenantId, c.base);
    const plan = await this.build(p, c.base, snap, input, links);
    const id = ulid();
    const now = Date.now();
    // an earlier dry run of this person that was never started goes (with any credential it kept)
    await this.db('app_platform_imports').where({ tenant_id: p.tenantId, created_by: p.userId, state: 'planned' }).andWhere('created_at', '<', now - PLAN_TTL_MS).delete();
    const token = input.connection?.token ? bearerOf(input.connection.token) : null;
    await this.db('app_platform_imports').insert({
      id,
      tenant_id: p.tenantId,
      source: c.base,
      source_app_id: snap.app.id,
      source_app_key: snap.app.key,
      target_app_id: plan.target.appId,
      target_name: plan.target.name,
      label: plan.target.label,
      workspace_id: plan.target.workspaceId,
      state: 'planned',
      options: JSON.stringify({ target: input.target, options: input.options, url: input.connection?.url ?? null }),
      credential: token ? await this.s().keys.seal(p.tenantId, token, credAad(id)) : null,
      fingerprint: plan.fingerprint,
      plan: JSON.stringify(planReport(plan)),
      report: null,
      summary: null,
      error: null,
      job_id: null,
      created_by: p.userId,
      created_at: now,
      started_at: null,
      finished_at: null
    });
    const report = planReport(plan);
    await this.audit(p, 'app.platform-import.planned', { import: id, platformApp: snap.app.key, app: plan.target.appId }, plan.target.label, { source: c.base, mode: plan.target.mode, target: plan.target.name, entities: plan.entities.length, records: plan.records.total, invalid: plan.records.invalid, flows: plan.flows.filter((f) => f.imported).length, flowsSkipped: plan.flows.filter((f) => !f.imported).length, platformWrites: plan.platformWrites.length }, actor);
    return { id, expiresAt: now + PLAN_TTL_MS, report };
  }

  /** Starts the import of a dry run (the same person's, within the hour) as the job `apps.platform-import`. */
  async start(actor: Actor & { principal: Principal }, planId: string) {
    const p = actor.principal;
    this.assertMay(p);
    const row = (await this.db('app_platform_imports').where({ tenant_id: p.tenantId, id: planId }).first()) as Record<string, unknown> | undefined;
    if (!row || row.created_by !== p.userId) throw notFound('Dry run');
    if (row.state !== 'planned') throw conflict('This dry run was started already; run a new dry run to import again.');
    if (Number(row.created_at) < Date.now() - PLAN_TTL_MS) throw conflict('This dry run is older than an hour; run it again.');
    const label = row.label as Label;
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; the app is ${label}.`, { step: 'clearance' });
    const n = await this.db('app_platform_imports').where({ id: planId, state: 'planned' }).update({ state: 'queued', started_at: Date.now() });
    if (n !== 1) throw conflict('This dry run was started already.');
    const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: 'apps.platform-import', payload: { importId: planId }, createdBy: p.userId, maxAttempts: 1 });
    await this.db('app_platform_imports').where({ id: planId }).update({ job_id: job.id });
    const plan = json<{ platformWrites?: PlatformWrite[]; records?: { total?: number } }>(row.plan, {});
    await this.audit(p, 'app.platform-import.started', { import: planId, platformApp: row.source_app_key, app: row.target_app_id ?? null, job: job.id }, label, { source: row.source, target: row.target_name, records: plan.records?.total ?? 0, platformWrites: (plan.platformWrites ?? []).map((w) => `${w.method} ${w.path}`) }, actor);
    return { id: planId, jobId: job.id };
  }

  /** A dry run or import of the caller (or any, for another holder of the same rights in the tenant), with its job. */
  async status(p: Principal, id: string) {
    this.assertMay(p);
    const r = (await this.db('app_platform_imports').where({ tenant_id: p.tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r || !clears(p.clearance, r.label as Label)) throw notFound('Import');
    const job = r.job_id ? await this.s().jobs.get(p.tenantId, String(r.job_id)) : undefined;
    return this.view(r, job ? { state: job.state, progress: job.progress, message: job.message, error: job.error } : null, true);
  }

  async recent(p: Principal) {
    this.assertMay(p);
    const rows = (await this.db('app_platform_imports').where({ tenant_id: p.tenantId }).orderBy('created_at', 'desc').limit(30)) as Record<string, unknown>[];
    return rows.filter((r) => clears(p.clearance, r.label as Label)).map((r) => this.view(r, null, false));
  }

  private view(r: Record<string, unknown>, job: { state: string; progress: number; message: string | null; error: string | null } | null, full: boolean) {
    return {
      id: String(r.id),
      state: String(r.state),
      source: String(r.source),
      platformApp: { id: String(r.source_app_id), key: String(r.source_app_key) },
      target: { appId: (r.target_app_id as string | null) ?? null, name: String(r.target_name), label: r.label as Label, workspaceId: (r.workspace_id as string | null) ?? null },
      summary: json<Record<string, unknown> | null>(r.summary, null),
      error: (r.error as string | null) ?? null,
      jobId: (r.job_id as string | null) ?? null,
      job,
      createdBy: String(r.created_by),
      createdAt: Number(r.created_at),
      startedAt: r.started_at == null ? null : Number(r.started_at),
      finishedAt: r.finished_at == null ? null : Number(r.finished_at),
      ...(full ? { plan: json<unknown>(r.plan, null), report: json<unknown[]>(r.report, []) } : {})
    };
  }

  // ---------- the import job ----------

  private async run(importId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const row = (await this.db('app_platform_imports').where({ id: importId }).first()) as Record<string, unknown> | undefined;
    if (!row || row.state !== 'queued') return { skipped: row?.state ?? 'gone' };
    await this.db('app_platform_imports').where({ id: importId }).update({ state: 'running' });
    const tenantId = String(row.tenant_id);
    const report: Record<string, unknown>[] = [];
    const finish = async (patch: Record<string, unknown>) => {
      await this.db('app_platform_imports').where({ id: importId }).update({ ...patch, credential: null, report: JSON.stringify(report.slice(0, MAX_REPORT)), finished_at: Date.now() });
    };
    const loaded = await loadPrincipal(s, tenantId, String(row.created_by), {});
    if (!loaded) {
      await finish({ state: 'failed', error: 'The person who started the import is disabled or gone.' });
      return { error: 'principal' };
    }
    const p: Principal = { ...loaded, mfa: true, workspaceId: (row.workspace_id as string | null) ?? null };
    const label = row.label as Label;
    try {
      this.assertMay(p);
      const opts = json<{ target: z.infer<typeof targetSchema>; options: z.infer<typeof optionsSchema>; url: string | null }>(row.options, { target: { mode: 'new', name: String(row.target_name) }, options: optionsSchema.parse({}), url: null });
      const token = row.credential ? await s.keys.open(tenantId, String(row.credential), credAad(importId)) : undefined;
      const actor: Actor & { principal: Principal } = { principal: p, source: 'import', via: 'platform-import' };
      const c = this.client({ ...(opts.url ? { url: opts.url } : {}), ...(token ? { token } : {}) }, async (w) => {
        await this.audit(p, 'app.platform-import.platform-write', { import: importId, platformApp: row.source_app_key }, label, { method: w.method, path: w.path, purpose: w.purpose, status: w.status });
      });
      await ctx.progress(2, 'Reading the platform app');
      const snap = await this.snapshot(c, String(row.source_app_id), opts.options.records, s.cfg.PLATFORM_IMPORT_MAX_RECORDS);
      if (snap.fingerprint !== row.fingerprint) throw conflict('The platform app’s design changed since the dry run; run the dry run again and check its report.');
      const links = await this.links(tenantId, c.base);
      const plan = await this.build(p, c.base, snap, { platformApp: snap.app.id, target: opts.target, options: opts.options }, links);
      if (plan.warnings.some((w) => /^Entity /.test(w))) throw badRequest(`The mapped design is not valid: ${plan.warnings.filter((w) => /^Entity /.test(w)).join(' ').slice(0, 400)}`);
      const summary = await this.apply(actor, plan, snap, c, importId, opts.options, report, ctx);
      await finish({ state: 'succeeded', summary: JSON.stringify(summary), target_app_id: summary.appId });
      await this.audit(p, 'app.platform-import.finished', { import: importId, platformApp: row.source_app_key, app: summary.appId }, label, summary);
      return summary;
    } catch (err) {
      const msg = (err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message).slice(0, 500);
      await finish({ state: 'failed', error: msg });
      await this.audit(p, 'app.platform-import.failed', { import: importId, platformApp: row.source_app_key }, label, { error: msg });
      return { error: msg };
    }
  }

  private async apply(actor: Actor & { principal: Principal }, plan: Plan, snap: Snapshot, c: PlatformLowcodeClient, importId: string, options: z.infer<typeof optionsSchema>, report: Record<string, unknown>[], ctx: JobContext) {
    const p = actor.principal;
    const tenantId = p.tenantId;
    const base = c.base;
    // the app
    let app: AppRow;
    if (plan.target.appId) app = await this.apps.designable(p, plan.target.appId);
    else {
      app = await this.apps.create(actor, { name: plan.target.name, title: plan.target.title, description: (snap.app.description ?? `Imported from the Exprsn platform app ${snap.app.key}.`).slice(0, 1000), label: plan.target.label, workspaceId: plan.target.workspaceId });
      report.push({ kind: 'app', source: snap.app.key, target: app.id, result: 'created' });
    }
    await this.link(tenantId, base, 'app', snap.app.id, app.id, app.id, importId);
    await ctx.progress(5, 'Entities');

    // entities: in two passes, so references to entities made later (or to each other) resolve
    // referenced entities first; a field naming an entity not made yet (a cycle) is added in the second pass
    const refsOf = (ep: EntityPlan) => ep.definition.fields.flatMap((f) => (f.type === 'reference' || (f.type === 'lookup' && f.source === 'entity') ? [f.entity] : [])).filter((n): n is string => !!n && n !== ep.name);
    const order: EntityPlan[] = [];
    const placed = new Set<string>();
    const visit = (ep: EntityPlan, path: Set<string>) => {
      if (placed.has(ep.name) || path.has(ep.name)) return;
      path.add(ep.name);
      for (const n of refsOf(ep)) {
        const dep = plan.entities.find((x) => x.name === n);
        if (dep) visit(dep, path);
      }
      placed.add(ep.name);
      order.push(ep);
    };
    for (const ep of plan.entities) visit(ep, new Set());
    const deferred = new Set<string>();
    const created = new Set<string>();
    const exists = (n: string) => created.has(n) || plan.entities.some((x) => x.existing && x.name === n);
    for (const ep of order) {
      if (ep.existing) continue;
      const pending = new Set(refsOf(ep).filter((n) => !exists(n)));
      let fields = ep.definition.fields.filter((f) => !((f.type === 'reference' || (f.type === 'lookup' && f.source === 'entity')) && pending.has(f.entity ?? '')));
      // an entity has at least one field: a placeholder stands in until the second pass
      if (!fields.length) fields = [{ name: 'imported_from', type: 'string', required: false, indexed: false, unique: false, maxLength: 100 } as Field];
      const first = { ...ep.definition, fields, ...(ep.definition.titleField && !fields.some((f) => f.name === ep.definition.titleField) ? { titleField: undefined } : {}) };
      const out = await this.apps.createEntity(actor, app.id, { name: ep.name, title: ep.title, label: app.label, definition: entityDefinitionSchema.parse(first) });
      ep.existing = out.entity;
      created.add(ep.name);
      if (fields.length !== ep.definition.fields.length || pending.size) deferred.add(ep.name);
      await this.link(tenantId, base, 'entity', ep.sourceId, app.id, out.entity.id, importId);
      report.push({ kind: 'entity', source: ep.sourceKey, target: out.entity.id, name: ep.name, result: 'created' });
    }
    for (const ep of order) {
      if (deferred.has(ep.name)) {
        const cur = (await this.apps.entityOf(app, ep.name));
        const out = await this.apps.updateEntity(actor, app.id, cur.id, { definition: ep.definition, rev: cur.rev });
        ep.existing = out.entity;
        continue;
      }
      if (created.has(ep.name)) continue;
      const cur = ep.existing!;
      if (ep.action === 'update') {
        const out = await this.apps.updateEntity(actor, app.id, cur.id, { definition: ep.definition, rev: cur.rev });
        ep.existing = out.entity;
      }
      await this.link(tenantId, base, 'entity', ep.sourceId, app.id, ep.existing!.id, importId);
      report.push({ kind: 'entity', source: ep.sourceKey, target: ep.existing!.id, name: ep.name, result: ep.action === 'update' ? 'updated' : 'unchanged', changed: ep.changed });
    }

    // records
    const counts = { created: 0, updated: 0, unchanged: 0, failed: 0, moved: 0, stateNotReached: 0 };
    if (options.records) {
      const links = await this.links(tenantId, base);
      const recLink = (pid: string): string | null => {
        const l = links.get(`record:${pid}`);
        return l && l.target_app_id === app.id ? l.target_id : null;
      };
      const sourceIds = new Set<string>();
      for (const r of snap.records.values()) for (const x of r.records) sourceIds.add(x.id);
      const total = [...snap.records.values()].reduce((n, r) => n + r.records.length, 0) || 1;
      let done = 0;
      const later: { ep: EntityPlan; entity: EntityRow; id: string; source: string; refs: Values }[] = [];
      // entities whose records others refer to go first
      const rank = (ep: EntityPlan) => plan.entities.filter((x) => x.plans.some((fp) => fp.refEntity === ep.sourceKey)).length;
      for (const ep of [...plan.entities].sort((a, b) => rank(b) - rank(a))) {
        const entity = await this.apps.entityOf(app, ep.name);
        const recs = snap.records.get(ep.sourceId)?.records ?? [];
        for (const r of recs) {
          if (ctx.signal.aborted) throw ctx.signal.reason as Error;
          const out = this.valuesFor(ep, r, (pid) => recLink(pid) ?? (sourceIds.has(pid) ? '' : null));
          const entry: Record<string, unknown> = { kind: 'record', entity: ep.name, source: r.id };
          try {
            if (out.problems.length) throw new HttpProblem(400, 'Invalid record', out.problems.join('; '));
            const existingId = recLink(r.id);
            let id: string | null = null;
            if (existingId) {
              const row = await this.apps.readable(p, entity, existingId).catch(() => null);
              if (row) {
                const cur = await this.apps.open(row);
                // a field the platform cleared is cleared here too (unless it is required)
                for (const fp of ep.plans) if (!fp.computed && !fp.skip && !fp.refEntity && out.values[fp.name] === undefined && cur[fp.name] != null && !fp.target.required) out.values[fp.name] = null;
                const stored = validateValues(entity.definition, out.values, { existing: cur });
                const diff = Object.keys(out.values).filter((k) => JSON.stringify(stored[k] ?? null) !== JSON.stringify(cur[k] ?? null));
                if (diff.length) {
                  await this.apps.updateRecord(actor, app, entity, row.id, { values: Object.fromEntries(diff.map((k) => [k, out.values[k] ?? null])) });
                  entry.result = 'updated';
                  entry.fields = diff;
                  counts.updated++;
                } else {
                  entry.result = 'unchanged';
                  counts.unchanged++;
                }
                id = row.id;
              }
            }
            if (!id) {
              const v = await this.apps.createRecord(actor, app, entity, { values: out.values });
              id = v.id;
              entry.result = 'created';
              counts.created++;
              links.set(`record:${r.id}`, { kind: 'record', source_id: r.id, target_app_id: app.id, target_id: id });
              await this.link(tenantId, base, 'record', r.id, app.id, id, importId);
            }
            entry.target = id;
            if (Object.keys(out.deferred).length) later.push({ ep, entity, id, source: r.id, refs: out.deferred });
            const moved = await this.moveTo(actor, app, entity, id, r.state ? ep.states.get(r.state) ?? null : null);
            if (moved === 'moved') counts.moved++;
            if (typeof moved === 'string' && moved.startsWith('not')) {
              counts.stateNotReached++;
              entry.note = moved;
            }
          } catch (err) {
            entry.result = 'failed';
            entry.problems = err instanceof HttpProblem ? [err.detail ?? err.title, ...((err.extensions.problems as { field: string; message: string }[] | undefined) ?? []).map((x) => `${x.field}: ${x.message}`)].slice(0, 20) : [(err as Error).message];
            counts.failed++;
          }
          if (report.length < MAX_REPORT) report.push(entry);
          done++;
          if (done % 25 === 0) await ctx.progress(5 + Math.round((done * 75) / total), `${done} of ${total} records`);
        }
      }
      // references to records written after the record that names them
      for (const x of later) {
        const values: Values = {};
        const missing: string[] = [];
        for (const [k, pid] of Object.entries(x.refs)) {
          const t = recLink(String(pid));
          if (t) values[k] = t;
          else missing.push(k);
        }
        try {
          if (Object.keys(values).length) await this.apps.updateRecord(actor, app, x.entity, x.id, { values });
          if (missing.length) throw new Error(`${missing.join(', ')}: the referenced platform record failed to import`);
        } catch (err) {
          if (report.length < MAX_REPORT) report.push({ kind: 'record', entity: x.ep.name, source: x.source, target: x.id, result: 'references', problems: [(err as Error).message] });
        }
      }
    }
    await ctx.progress(82, 'Forms');

    // forms
    const formCounts = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
    for (const f of plan.forms) {
      const entry: Record<string, unknown> = { kind: 'form', source: f.sourceKey, name: f.name };
      try {
        if (f.action === 'skip' || !f.definition) {
          entry.result = 'skipped';
          entry.reason = f.reason;
          formCounts.skipped++;
        } else if (f.existingId) {
          if (f.action === 'update') await this.apps.forms.update(actor, app.id, f.existingId, { title: f.title, definition: f.definition });
          entry.result = f.action === 'update' ? 'updated' : 'unchanged';
          formCounts[f.action === 'update' ? 'updated' : 'unchanged']++;
          entry.target = f.existingId;
        } else {
          const out = await this.apps.forms.create(actor, app.id, { name: f.name, title: f.title, entity: f.entity, definition: f.definition });
          await this.link(tenantId, base, 'form', f.sourceId, app.id, out.form.id, importId);
          entry.result = 'created';
          entry.target = out.form.id;
          formCounts.created++;
        }
      } catch (err) {
        entry.result = 'failed';
        entry.problems = [err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message];
        formCounts.skipped++;
      }
      report.push(entry);
    }
    await ctx.progress(90, 'Flows');

    // flows (after the records, so writing the records does not run them)
    const flowCounts = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
    const recLinks = await this.links(tenantId, base);
    const byKey = new Map(plan.entities.map((x) => [x.sourceKey, x]));
    for (const f of plan.flows) {
      const entry: Record<string, unknown> = { kind: 'flow', source: f.sourceKey, name: f.name };
      try {
        if (!f.imported || !f.input) {
          entry.result = 'skipped';
          entry.reasons = f.reasons;
          flowCounts.skipped++;
          report.push(entry);
          continue;
        }
        // mapped again now the records are imported, so a record an action names is the imported one
        const pf = snap.flows.find((x) => x.id === f.sourceId)!;
        const again = mapFlow(pf, snap.app.id, byKey, new Set(), (pid) => {
          const l = recLinks.get(`record:${pid}`);
          return l && l.target_app_id === app.id ? l.target_id : null;
        });
        if (!again.imported || !again.input) throw new Error(again.reasons.join('; ') || 'the flow no longer maps');
        const input: FlowInput = { ...again.input, name: f.name, enabled: f.input.enabled };
        if (f.existingId) {
          const { name: _n, ...rest } = input;
          void _n;
          const cur = (await this.db('app_flows').where({ id: f.existingId }).first('enabled', 'model')) as { enabled: unknown; model: string } | undefined;
          const next = { ...rest, enabled: !!cur?.enabled };
          // the same model as last time: nothing to compile or publish again (its enabled state is the app's own)
          const was = json<Record<string, unknown>>(cur?.model, {});
          const same = JSON.stringify(flowInputSchema.omit({ name: true }).safeParse({ ...was, enabled: next.enabled }).data ?? null) === JSON.stringify(flowInputSchema.omit({ name: true }).parse(next));
          if (!same) await this.apps.flows.update(actor, app.id, f.existingId, { ...next, force: false });
          entry.result = same ? 'unchanged' : 'updated';
          entry.target = f.existingId;
          flowCounts[same ? 'unchanged' : 'updated']++;
        } else {
          const out = (await this.apps.flows.create(actor, app.id, input)) as { id: string; enabled: boolean };
          await this.link(tenantId, base, 'flow', f.sourceId, app.id, out.id, importId);
          entry.result = 'created';
          entry.target = out.id;
          entry.enabled = out.enabled;
          flowCounts.created++;
        }
      } catch (err) {
        entry.result = 'failed';
        entry.problems = [err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message];
        flowCounts.failed++;
      }
      report.push(entry);
    }

    // 1.8.0 (B-143): the role catalogue (names and descriptions)
    const roleCounts = { created: 0, existing: 0 };
    for (const r of plan.roles ?? []) {
      if (r.action === 'existing' || (await this.apps.roles.keys(app)).has(r.name.toLowerCase())) {
        roleCounts.existing++;
        continue;
      }
      try {
        await this.apps.roles.create(actor, app, { name: r.name, description: r.description });
        roleCounts.created++;
        report.push({ kind: 'role', source: r.source, name: r.name, result: 'created' });
      } catch (err) {
        report.push({ kind: 'role', source: r.source, name: r.name, result: 'failed', problems: [err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message] });
      }
    }

    // the one platform write: where the app went (asked for, listed in the dry run)
    let marked: string | null = null;
    if (options.markPlatform) {
      await ctx.progress(97, 'Marking the platform app');
      const label = `${p.tenantSlug || tenantId}/${app.name}`.slice(0, 200);
      const entryV = { value: app.id, label, metadata: { server: this.s().cfg.PUBLIC_URL, importedAt: new Date().toISOString(), import: importId } };
      const lk = (await c.lookups(snap.app.id)).find((l) => l.key === LINK_LOOKUP);
      if (lk) await c.write({ method: 'PUT', path: `/lowcode/api/design/lookups/${lk.id}`, purpose: `adds this Exprsn-AI app to the lookup ${LINK_LOOKUP} of ${snap.app.key}` }, { values: [...(lk.values ?? []).filter((v) => String(v.value) !== app.id), entryV] });
      else await c.write({ method: 'POST', path: '/lowcode/api/design/lookups', purpose: `creates the lookup ${LINK_LOOKUP} on ${snap.app.key}, naming the Exprsn-AI app it was imported into` }, { appId: snap.app.id, key: LINK_LOOKUP, name: 'Imported into Exprsn-AI', values: [entryV] });
      marked = LINK_LOOKUP;
    }
    await ctx.progress(99, 'Done');
    return { appId: app.id, app: app.name, entities: plan.entities.length, records: counts, forms: formCounts, flows: flowCounts, roles: roleCounts, platformWrites: c.writes.map((w) => `${w.method} ${w.path} ${w.status}`), marked };
  }

  /**
   * Moves a record to the platform's state along the machine's transitions (shortest path, each one a normal,
   * audited transition). Returns 'moved', 'same', or why it could not.
   */
  private async moveTo(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, id: string, want: string | null): Promise<string> {
    const sm = entity.definition.states;
    if (!sm || !want) return 'same';
    const row = await this.apps.readable(actor.principal, entity, id);
    const from = row.state ?? sm.initial;
    if (from === want) return 'same';
    if (!sm.states.some((x) => x.name === want)) return `not moved: ${want} is not a state of ${entity.name}`;
    const prev = new Map<string, string | null>([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const st = queue.shift()!;
      if (st === want) break;
      for (const t of sm.transitions) if ((t.from.includes('*') || t.from.includes(st)) && !prev.has(t.to) && !(t.roles?.length && !actor.principal.roles.some((r) => t.roles!.includes(r) || r === 'system-admin'))) {
        prev.set(t.to, st);
        queue.push(t.to);
      }
    }
    if (!prev.has(want)) return `not moved: no transitions lead from ${from} to ${want}; the record stays ${from}`;
    const path: string[] = [];
    for (let x: string | null = want; x && x !== from; x = prev.get(x) ?? null) path.unshift(x);
    for (const step of path) await this.apps.transition(actor, app, entity, id, step, { note: 'platform import' });
    return 'moved';
  }
}
