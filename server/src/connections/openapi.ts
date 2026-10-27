import { parseYamlSafely } from '../platform/yaml.js';
import { SECRET_FIELD } from '../platform/secret-names.js';
import type { ParamDef } from './params.js';

/*
 * 1.9.0: OpenAPI import for REST connections. An OpenAPI 3.x or Swagger 2.0 document (JSON or YAML, capped) is read
 * into the operations a REST endpoint can be made from: GET operations only (anything else can change data), whose
 * path lies under the connection's base URL. Each gets its typed path and query parameters (credentials and paging
 * parameters left out: the connection's authentication and the paging settings carry those; header and cookie
 * parameters are not offered), a paging guess and a response mapping guess from its 200 schema (`$ref` resolved
 * inside the document only). Importing creates ordinary endpoints through `saveEndpoint`, so every check of a
 * hand-made endpoint applies.
 */

export const MAX_OPENAPI_BYTES = 4 * 1024 * 1024;
const MAX_OPERATIONS = 500;

type Json = Record<string, unknown>;

export interface OpenApiParam {
  name: string;
  /** The name the endpoint uses ({snake_case}). */
  param: string;
  in: 'path' | 'query';
  type: ParamDef['type'];
  required: boolean;
  enum?: (string | number)[];
  default?: string | number | boolean;
}

export type PagingGuess =
  | { kind: 'none' }
  | { kind: 'page'; param: string; sizeParam: string | null; size?: number }
  | { kind: 'offset'; offsetParam: string; limitParam: string; size?: number }
  | { kind: 'cursor'; param: string; next: string; sizeParam: string | null; size?: number }
  | { kind: 'link'; sizeParam: string | null; size?: number };

export interface OpenApiOperation {
  /** The operationId, or one made from the method and path. */
  operationId: string;
  /** A valid, unique endpoint name. */
  name: string;
  method: string;
  path: string;
  summary: string | null;
  importable: boolean;
  reason?: string;
  /** The endpoint's path below the base URL, with {snake_case} placeholders. */
  endpointPath: string | null;
  params: OpenApiParam[];
  paging: PagingGuess;
  mapping: { items: string; fields: { name: string; path: string; type: 'string' | 'number' | 'boolean' | 'date' | 'json' }[] };
  notes: string[];
}

export interface OpenApiMeta {
  kind: 'openapi';
  specVersion: string;
  title: string | null;
  version: string | null;
  servers: string[];
  operations: OpenApiOperation[];
  notes: string[];
}

/** The document as an object, from JSON or YAML text. */
export function parseOpenApiText(text: string): Json {
  if (Buffer.byteLength(text, 'utf8') > MAX_OPENAPI_BYTES) throw new Error('The document is larger than 4 MB.');
  const trimmed = text.trimStart();
  let doc: unknown;
  if (trimmed.startsWith('{')) doc = JSON.parse(trimmed);
  else doc = parseYamlSafely(text, { maxBytes: MAX_OPENAPI_BYTES, maxDepth: 64, maxNodes: 500_000 });
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('The document is not an object.');
  const d = doc as Json;
  if (typeof d.openapi !== 'string' && d.swagger !== '2.0') throw new Error('The document is neither OpenAPI 3 (openapi: 3.x) nor Swagger 2.0.');
  if (typeof d.openapi === 'string' && !/^3\./.test(d.openapi)) throw new Error(`OpenAPI ${d.openapi.slice(0, 20)} is not read; 3.x and Swagger 2.0 are.`);
  if (!d.paths || typeof d.paths !== 'object') throw new Error('The document has no paths.');
  return d;
}

const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

/** A `$ref` inside the document (`#/components/schemas/X`, `#/definitions/X`, `#/components/parameters/Y`). */
function deref(doc: Json, v: unknown, depth = 0): Json | null {
  const o = obj(v);
  if (!o) return null;
  const ref = o.$ref;
  if (typeof ref !== 'string') return o;
  if (!ref.startsWith('#/') || depth > 8) return null;
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = obj(cur)?.[k];
  }
  return deref(doc, cur, depth + 1);
}

/** {petId} → pet_id; a valid parameter name. */
export function snake(name: string): string {
  const s = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
  const out = /^[a-z]/.test(s) ? s : `p_${s}`;
  return out.slice(0, 63) || 'p';
}

const CREDENTIAL = /^(api[_-]?key|apikey|key|token|access[_-]?token|auth|authorization|secret|client[_-]?secret|password|signature|sig|session|x-api-key)$/i;
const PAGE = /^(page|page_number|pagenumber|pageNumber|p)$/;
const SIZE = /^(per_page|perPage|page_size|pageSize|pagesize|size|limit|count|max_results|maxResults|top|\$top)$/;
const OFFSET = /^(offset|skip|start|\$skip)$/;
const CURSOR = /^(cursor|after|next|page_token|pageToken|next_token|nextToken|continuation|continuationToken|starting_after)$/;
const NEXT_FIELD = /^(next|nextCursor|next_cursor|next_page_token|nextPageToken|next_token|nextToken|cursor|endCursor|end_cursor)$/;

function schemaType(doc: Json, s: unknown): { type: ParamDef['type']; enum?: (string | number)[]; default?: string | number | boolean } {
  const o = deref(doc, s) ?? {};
  const t = o.type;
  const en = Array.isArray(o.enum) ? (o.enum.filter((x) => typeof x === 'string' || typeof x === 'number') as (string | number)[]).slice(0, 200) : undefined;
  const def = typeof o.default === 'string' || typeof o.default === 'number' || typeof o.default === 'boolean' ? o.default : undefined;
  const base = (type: ParamDef['type']) => ({ type, ...(en?.length ? { enum: en } : {}), ...(def !== undefined ? { default: def } : {}) });
  if (t === 'integer' || t === 'number') return base('number');
  if (t === 'boolean') return base('boolean');
  if (t === 'array') return base('list');
  if (t === 'string' && (o.format === 'date' || o.format === 'date-time')) return base('date');
  return base('string');
}

function fieldType(doc: Json, s: unknown): 'string' | 'number' | 'boolean' | 'date' | 'json' {
  const o = deref(doc, s) ?? {};
  if (o.type === 'integer' || o.type === 'number') return 'number';
  if (o.type === 'boolean') return 'boolean';
  if (o.type === 'array' || o.type === 'object' || o.properties) return 'json';
  if (o.type === 'string' && (o.format === 'date' || o.format === 'date-time')) return 'date';
  return 'string';
}

const pointerKey = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** The 200 (or 2XX, or default) response's JSON schema. */
function responseSchema(doc: Json, op: Json, swagger2: boolean): Json | null {
  const responses = obj(op.responses) ?? {};
  const r = deref(doc, responses['200'] ?? responses['2XX'] ?? responses['201'] ?? responses.default);
  if (!r) return null;
  if (swagger2) return deref(doc, r.schema);
  const content = obj(r.content) ?? {};
  const media = Object.keys(content).find((k) => /json/i.test(k));
  return media ? deref(doc, obj(content[media])?.schema) : null;
}

function itemFields(doc: Json, item: Json | null): OpenApiOperation['mapping']['fields'] {
  const props = obj(item?.properties) ?? {};
  return Object.entries(props)
    .filter(([k]) => FIELD.test(k))
    .slice(0, 50)
    .map(([k, v]) => ({ name: k, path: `/${pointerKey(k)}`, type: fieldType(doc, v) }));
}

function mappingGuess(doc: Json, schema: Json | null): { mapping: OpenApiOperation['mapping']; next: string | null } {
  if (!schema) return { mapping: { items: '', fields: [] }, next: null };
  if (schema.type === 'array') return { mapping: { items: '', fields: itemFields(doc, deref(doc, schema.items)) }, next: null };
  const props = obj(schema.properties) ?? {};
  let next: string | null = null;
  // A cursor field at the top or one level down (meta, pagination, pageInfo, links).
  for (const [k, v] of Object.entries(props)) {
    if (NEXT_FIELD.test(k)) next ??= `/${pointerKey(k)}`;
    const inner = obj(deref(doc, v)?.properties);
    if (inner) for (const k2 of Object.keys(inner)) if (NEXT_FIELD.test(k2)) next ??= `/${pointerKey(k)}/${pointerKey(k2)}`;
  }
  const preferred = ['data', 'items', 'results', 'records', 'value', 'values', 'entries', 'rows', 'list', 'content', 'objects', 'hits'];
  const arrays = Object.entries(props).filter(([, v]) => deref(doc, v)?.type === 'array');
  // Only a list under a name that says so: an object with an array field (tags, roles) is one item, not a page.
  const pick = arrays.find(([k]) => preferred.includes(k));
  if (pick) return { mapping: { items: `/${pointerKey(pick[0])}`, fields: itemFields(doc, deref(doc, deref(doc, pick[1])?.items)) }, next };
  return { mapping: { items: '', fields: itemFields(doc, schema) }, next };
}

/** Server URLs: OpenAPI 3 `servers` (variables at their defaults), Swagger 2.0 `schemes`, `host` and `basePath`. */
function serversOf(doc: Json, swagger2: boolean): string[] {
  if (swagger2) {
    const host = typeof doc.host === 'string' ? doc.host : null;
    const basePath = typeof doc.basePath === 'string' ? doc.basePath : '';
    const schemes = Array.isArray(doc.schemes) && doc.schemes.length ? (doc.schemes as string[]) : ['https'];
    return host ? schemes.map((s) => `${s}://${host}${basePath}`) : [basePath || '/'];
  }
  const list = Array.isArray(doc.servers) ? doc.servers : [];
  const out: string[] = [];
  for (const s of list) {
    const o = obj(s);
    if (!o || typeof o.url !== 'string') continue;
    const vars = obj(o.variables) ?? {};
    out.push(o.url.replace(/\{([^}]+)\}/g, (_m, n: string) => String(obj(vars[n])?.default ?? '')));
  }
  return out.length ? out : ['/'];
}

/** The endpoint path of `server + path` below the base URL, or null when it is not under it. */
function underBasePath(baseUrl: string, server: string, path: string, docUrl: string | null): string | null {
  let full: URL;
  try {
    full = new URL(server.replace(/\/+$/, '') + path.replace(/\{([^}]+)\}/g, (_m, n: string) => `__P_${Buffer.from(n).toString('hex')}__`), docUrl ?? baseUrl);
  } catch {
    return null;
  }
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  if (full.origin !== base.origin) return null;
  const p = decodeURIComponent(full.pathname);
  if (prefix && p !== prefix && !p.startsWith(`${prefix}/`)) return null;
  return p.slice(prefix.length).replace(/__P_([0-9a-f]+)__/g, (_m, hex: string) => `{${snake(Buffer.from(hex, 'hex').toString())}}`);
}

/** Reads a parsed document's operations against a connection's base URL. */
export function readOpenApi(doc: Json, baseUrl: string, docUrl: string | null, existing: ReadonlySet<string> = new Set()): OpenApiMeta {
  const swagger2 = doc.swagger === '2.0';
  const info = obj(doc.info) ?? {};
  const servers = serversOf(doc, swagger2);
  const notes: string[] = [];
  const queryKeyNames = new Set<string>();
  // Query-string API keys named by the security schemes: the connection's authentication carries them.
  const schemes = swagger2 ? obj(doc.securityDefinitions) : obj(obj(doc.components)?.securitySchemes);
  for (const v of Object.values(schemes ?? {})) {
    const o = obj(v);
    if (o?.type === 'apiKey' && typeof o.name === 'string') queryKeyNames.add(o.name);
  }
  const used = new Set(existing);
  const uniqueName = (raw: string) => {
    let base = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .toLowerCase()
      .replace(/^[^a-z]+/, '')
      .replace(/-+/g, '-')
      .replace(/-$/, '')
      .slice(0, 56);
    if (!base) base = 'endpoint';
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    return name;
  };
  const operations: OpenApiOperation[] = [];
  for (const [path, item] of Object.entries(obj(doc.paths) ?? {})) {
    const pathItem = deref(doc, item);
    if (!pathItem) continue;
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']) {
      const op = obj(pathItem[method]);
      if (!op) continue;
      if (operations.length >= MAX_OPERATIONS) {
        notes.push(`Only the first ${MAX_OPERATIONS} operations are listed.`);
        break;
      }
      const operationId = typeof op.operationId === 'string' && op.operationId.trim() ? op.operationId.trim().slice(0, 200) : `${method}${path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '-')}`.slice(0, 200);
      const summary = typeof op.summary === 'string' ? op.summary.slice(0, 200) : null;
      const opNotes: string[] = [];
      const base = { operationId, method: method.toUpperCase(), path, summary, notes: opNotes };
      if (method !== 'get') {
        operations.push({ ...base, name: '', importable: false, reason: `${method.toUpperCase()} can change data; only GET operations become endpoints.`, endpointPath: null, params: [], paging: { kind: 'none' }, mapping: { items: '', fields: [] } });
        continue;
      }
      const opServers = Array.isArray(op.servers) && op.servers.length ? serversOf({ servers: op.servers }, false) : Array.isArray(pathItem.servers) && pathItem.servers.length ? serversOf({ servers: pathItem.servers }, false) : servers;
      let endpointPath: string | null = null;
      for (const sv of opServers) {
        endpointPath = underBasePath(baseUrl, sv, path, docUrl);
        if (endpointPath !== null) break;
      }
      // Parameters: the operation's own override the path item's (by name and place).
      const byKey = new Map<string, Json>();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = deref(doc, raw);
        if (p && typeof p.name === 'string' && typeof p.in === 'string') byKey.set(`${p.in}:${p.name}`, p);
      }
      const params: OpenApiParam[] = [];
      const queryNames: string[] = [];
      for (const p of byKey.values()) {
        const name = String(p.name);
        const where = String(p.in);
        if (where === 'header' || where === 'cookie') {
          opNotes.push(`The ${where} parameter ${name} is not offered.`);
          continue;
        }
        if (where !== 'path' && where !== 'query') continue;
        if (where === 'query' && (CREDENTIAL.test(name) || SECRET_FIELD.test(name) || queryKeyNames.has(name))) {
          opNotes.push(`${name} looks like a credential: the connection's authentication carries it.`);
          continue;
        }
        const t = schemaType(doc, swagger2 ? p : p.schema);
        params.push({ name, param: snake(name), in: where, type: t.type, required: where === 'path' || p.required === true, ...(t.enum ? { enum: t.enum } : {}), ...(t.default !== undefined ? { default: t.default } : {}) });
        if (where === 'query') queryNames.push(name);
      }
      // Paging from the query parameters and the response.
      const schema = responseSchema(doc, op, swagger2);
      const { mapping, next } = mappingGuess(doc, schema);
      const sizeName = queryNames.find((n) => SIZE.test(n)) ?? null;
      const offsetName = queryNames.find((n) => OFFSET.test(n));
      const pageName = queryNames.find((n) => PAGE.test(n));
      const cursorName = queryNames.find((n) => CURSOR.test(n));
      const headers = obj(obj(obj(op.responses)?.['200'])?.headers) ?? {};
      // The page size: the size parameter's documented default, else the paging default.
      const sizeDefault = params.find((p) => p.in === 'query' && p.name === sizeName)?.default;
      const size = typeof sizeDefault === 'number' && sizeDefault >= 1 ? { size: Math.min(1000, Math.floor(sizeDefault)) } : {};
      let paging: PagingGuess = { kind: 'none' };
      if (cursorName && next) paging = { kind: 'cursor', param: cursorName, next, sizeParam: sizeName, ...size };
      else if (offsetName && sizeName) paging = { kind: 'offset', offsetParam: offsetName, limitParam: sizeName, ...size };
      else if (pageName) paging = { kind: 'page', param: pageName, sizeParam: sizeName, ...size };
      else if (Object.keys(headers).some((h) => h.toLowerCase() === 'link')) paging = { kind: 'link', sizeParam: sizeName, ...size };
      const pagingNames = new Set(paging.kind === 'cursor' ? [paging.param, paging.sizeParam] : paging.kind === 'offset' ? [paging.offsetParam, paging.limitParam] : paging.kind === 'page' ? [paging.param, paging.sizeParam] : paging.kind === 'link' ? [paging.sizeParam] : []);
      const kept = params.filter((p) => !(p.in === 'query' && pagingNames.has(p.name)));
      if (kept.length > 30) opNotes.push('Only the first 30 parameters are kept.');
      const op2 = { ...base, name: '', endpointPath, params: kept.slice(0, 30), paging, mapping };
      if (endpointPath === null) operations.push({ ...op2, importable: false, reason: `${path} is not under the connection's base URL ${baseUrl} (servers: ${opServers.slice(0, 3).join(', ')}).` });
      else operations.push({ ...op2, name: uniqueName(operationId), importable: true });
    }
  }
  return { kind: 'openapi', specVersion: swagger2 ? '2.0' : String(doc.openapi), title: typeof info.title === 'string' ? info.title.slice(0, 200) : null, version: typeof info.version === 'string' ? info.version.slice(0, 50) : null, servers: servers.slice(0, 10), operations, notes };
}

/** The parameter definitions of an imported operation. */
export function paramDefs(op: OpenApiOperation): ParamDef[] {
  return op.params.map((p) => {
    const def: ParamDef = { name: p.param, type: p.type, required: p.required } as ParamDef;
    if (p.type === 'list') def.itemType = 'string';
    if (p.enum?.length && p.type !== 'list' && p.type !== 'boolean') def.allowed = p.enum;
    if (p.default !== undefined && p.type !== 'list') def.default = p.default;
    if (p.name !== p.param) def.title = p.name;
    return def;
  });
}
