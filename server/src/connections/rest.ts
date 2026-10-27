import { isIP } from 'node:net';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, type AuditActor } from '../audit/chain.js';
import { clears, labelRank, LABELS, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { tenantHostProblem } from '../integrations/hosts.js';
import type { AllowList } from '../mcp/hosts.js';
import { guardedRequest, servicePolicy, ServiceUrlRefused, toolAddressProblem, type GuardedResponse } from '../platform/egress.js';
import { scrubError } from '../platform/diagnostics.js';
import { SECRET_FIELD, SECRET_HEADER } from '../platform/secret-names.js';
import { jsonPointer } from '../registry/http-tool.js';
import type { Services } from '../services.js';
import { isSecretRef, isVaultRef } from '../vault/policy.js';
import { bindParams, paramProblems, paramsSchema, type ParamDef } from './params.js';
import { asObjects, columnTypes, decodeCursor, type ReadResult } from './saved-queries.js';
import { classifyGraphql, INTROSPECTION_QUERY, rootFields, type RootField } from './graphql.js';
import { filterProblems, MAX_METADATA_BYTES, odataError, orderbyProblems, parseMetadata, renderFilter, renderSearch, searchProblems, type ODataMeta, type ODataSet } from './odata.js';
import { MAX_OPENAPI_BYTES, paramDefs, parseOpenApiText, readOpenApi, type OpenApiMeta } from './openapi.js';
import { buildEnvelope, MAX_WSDL_BYTES, parseWsdl, readEnvelope, SoapFault, underBase, writeLikeOperation, type ServiceMeta, type SoapArg, type SoapOperation } from './soap.js';

/*
 * 1.8.0, Sprint 45 (B-126): REST APIs as connection sources.
 *
 * - A REST connection is a base URL whose host must be on the tenant's list of allowed hosts (an internal host also
 *   needs the operator's SERVICE_ALLOWED_HOSTS); every request goes through `guardedRequest` with that check at dial
 *   time (resolved once, every address checked, pinned, no redirects, capped by size and time).
 * - Authentication: none, basic, bearer, an API key in a header or the query string, or OAuth2 client credentials
 *   (the token URL passes the same host check; tokens are kept in this process until they expire). The secret is
 *   sealed under the tenant key (`rest-connection:<id>`) or kept as a `vault:` reference resolved as whoever saved
 *   it; a sealed one moves to the vault with the other third-party credentials (`vault/credential-moves.ts`). Default
 *   headers and endpoint query parameters never hold a credential literal: a `vault:` reference or nothing.
 * - Endpoints are named GET resources: a path template with typed parameters (percent-encoded, never `.` or `..`,
 *   and the URL must stay under the base path), query parameters, paging (page number, offset, cursor from the body,
 *   or the Link header, whose next URL must stay under the base URL) and a response mapping (a JSON pointer or dotted
 *   path to the items, fields with types).
 * - Every answer passes the `untrusted-content` checkpoint (source `http`) before anything reads it: a block withholds
 *   the rows, an annotation is carried with them. Reads are audited (`connection.rest.read`, `.refused`, `.failed`)
 *   with host, status, pages, rows and size, never a header, query string or body.
 *
 * 1.9.0: two more protocols on the same connections, with the same host rules, authentication, caps, paging, mapping,
 * checkpoint and audit; only how one request is built and how its answer becomes a JSON document differ.
 * - `graphql`: the base URL is the GraphQL endpoint; an endpoint holds one `query` document (graphql.ts refuses
 *   mutations, subscriptions, introspection and documents past the depth and field caps, at save and at every read)
 *   and its variables, which the typed parameters and the paging values fill; the query text is never templated.
 *   An answer with `errors` and no `data` fails; `data` with `errors` is read with a warning.
 * - `soap`: the connection holds its WSDL (fetched through the same guard, or uploaded), read by soap.ts; an endpoint
 *   names an operation (and port) whose address must lie under the base URL, and its arguments, escaped into the
 *   input element. Operations named like writes are refused unless the editor confirms they only read.
 * - `odata` (OData v4): the base URL is the service root; its `$metadata` is read by odata.ts; an endpoint names an
 *   entity set or singleton and its query options ($select, $filter, $orderby, $expand, $search), whose parameters
 *   become OData literals escaped by type. GET only; server-driven paging follows `@odata.nextLink` under the base.
 * - OpenAPI import (openapi.ts, REST only): GET operations of an OpenAPI 3 or Swagger 2.0 document become endpoints.
 *
 * The columns `wsdl_url`, `wsdl`, `wsdl_at` and `service_meta` (migration 114) hold the connection's service
 * description, whatever it is: the WSDL (SOAP), the `$metadata` document (OData) or an imported OpenAPI document
 * (REST), with what was read from it. `connFrom` hands each protocol its own reading (`service_meta`, `odata_meta`,
 * `openapi_meta`).
 */

export const PROTOCOLS = ['rest', 'graphql', 'soap', 'odata'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const AUTH_KINDS = ['none', 'basic', 'bearer', 'api-key-header', 'api-key-query', 'oauth2-client'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

const NAME = /^[a-z][a-z0-9_-]{0,62}$/;
export const restName = z.string().trim().regex(NAME, 'lower-case letters, digits, _ and -, starting with a letter');
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'Header names: letters, digits and hyphens');
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-connection', 'expect']);
const VAULT_VALUE = /^((?:Bearer|Basic|Token|Bot) )?(vault:\S+)$/;
const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,62})\}/g;

const authSchema = z
  .object({
    kind: z.enum(AUTH_KINDS),
    username: z.string().trim().min(1).max(200).optional(),
    headerName: headerName.optional(),
    queryName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).optional(),
    tokenUrl: z.string().trim().url().max(2000).optional(),
    clientId: z.string().trim().min(1).max(500).optional(),
    scope: z.string().trim().max(1000).optional(),
    /** The password, token, key or client secret: sealed, or a `vault:` reference kept as written. Never shown again. */
    secret: z.string().min(1).max(4000).optional()
  })
  .strict();

export const restConnectionCreateSchema = z
  .object({
    name: restName,
    title: z.string().trim().max(200).nullable().default(null),
    baseUrl: z.string().trim().min(8).max(2000),
    zone: z.string().trim().regex(/^[a-z0-9-]{1,63}$/).default('data'),
    label: z.enum(LABELS).default('internal'),
    auth: authSchema.default({ kind: 'none' }),
    headers: z.record(headerName, z.string().max(2000)).default({}),
    timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
    maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).default(1024 * 1024),
    /** 1.9.0: how requests are made: plain REST (GET), GraphQL (POST of a query) or SOAP (POST of an envelope). */
    protocol: z.enum(PROTOCOLS).default('rest'),
    /** SOAP: where the WSDL is fetched from (through the same guard), or the WSDL itself. */
    wsdlUrl: z.string().trim().url().max(2000).optional(),
    wsdl: z.string().min(20).max(MAX_WSDL_BYTES).optional()
  })
  .strict();

export const wsdlRefreshSchema = z.object({ wsdlUrl: z.string().trim().url().max(2000).optional(), wsdl: z.string().min(20).max(MAX_WSDL_BYTES).optional() }).strict();

export const restConnectionUpdateSchema = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    baseUrl: z.string().trim().min(8).max(2000).optional(),
    zone: z.string().trim().regex(/^[a-z0-9-]{1,63}$/).optional(),
    label: z.enum(LABELS).optional(),
    auth: authSchema.optional(),
    headers: z.record(headerName, z.string().max(2000)).optional(),
    timeoutMs: z.number().int().min(500).max(60_000).optional(),
    maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional()
  })
  .strict();

const pointerOrPath = z.string().max(500).regex(/^(\/.*|[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*)?$/, 'a JSON pointer such as /data/items, or a dotted path such as data.items');
const size = z.number().int().min(1).max(1000).default(50);

export const pagingSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('page'), param: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).default('page'), start: z.number().int().min(0).max(1).default(1), sizeParam: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).nullable().default(null), size, maxPages: z.number().int().min(1).max(100).default(20) }).strict(),
    z.object({ kind: z.literal('offset'), offsetParam: z.string().regex(/^\$?[A-Za-z0-9_.-]{1,100}$/).default('offset'), limitParam: z.string().regex(/^\$?[A-Za-z0-9_.-]{1,100}$/).default('limit'), size, maxPages: z.number().int().min(1).max(100).default(20) }).strict(),
    z.object({ kind: z.literal('cursor'), param: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).default('cursor'), next: pointerOrPath, hasNext: pointerOrPath.optional(), sizeParam: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).nullable().default(null), size, maxPages: z.number().int().min(1).max(100).default(20) }).strict(),
    z.object({ kind: z.literal('link'), sizeParam: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).nullable().default(null), size, maxPages: z.number().int().min(1).max(100).default(20) }).strict()
  ])
  .default({ kind: 'none' });
export type Paging = z.infer<typeof pagingSchema>;

export const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'json'] as const;

export const mappingSchema = z
  .object({
    /** Where the items are: '' or absent for the whole answer (an array, or one object). */
    items: pointerOrPath.default(''),
    fields: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'a plain field name'), path: pointerOrPath, type: z.enum(FIELD_TYPES).default('string') }).strict()).max(200).default([])
  })
  .strict()
  .default({ items: '', fields: [] });
export type Mapping = z.infer<typeof mappingSchema>;

const jsonLiteral: z.ZodType<unknown> = z.lazy(() => z.union([z.string().max(2000), z.number(), z.boolean(), z.null(), z.array(jsonLiteral).max(100), z.record(z.string().max(100), jsonLiteral)]));
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

/** 1.9.0: a GraphQL endpoint's query and variables. A variable is a JSON literal, or a string with {param} placeholders. */
export const graphqlRequestSchema = z
  .object({
    query: z.string().min(1).max(20_000),
    variables: z.record(z.string().regex(/^[_A-Za-z][_0-9A-Za-z]{0,62}$/, 'a GraphQL variable name'), jsonLiteral).default({})
  })
  .strict();

/** 1.9.0: an OData endpoint's entity set (or singleton) and query options; `filter` and `search` are templates. */
export const odataRequestSchema = z
  .object({
    entitySet: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'an entity set or singleton name from the metadata'),
    select: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(200).default([]),
    filter: z.string().max(2000).optional(),
    orderby: z.string().max(500).optional(),
    expand: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(20).default([]),
    search: z.string().max(500).optional(),
    /** Ask for `$count=true` (the total count comes in `@odata.count`). */
    count: z.boolean().default(false)
  })
  .strict();

/** 1.9.0: a SOAP endpoint's operation, its port (the first that has it when absent) and its arguments (text templates). */
export const soapRequestSchema = z
  .object({
    operation: z.string().regex(NCNAME, 'an operation name from the WSDL'),
    port: z.string().regex(NCNAME).optional(),
    args: z.record(z.string().regex(NCNAME, 'an element name'), z.string().max(2000)).default({}),
    /** The editor's confirmation that an operation named like a write only reads (audited). */
    confirmRead: z.boolean().default(false)
  })
  .strict();

export const endpointDefinitionSchema = z
  .object({
    path: z.string().trim().max(2000).regex(/^(\/[^\s?#]*)?$/, 'a path starting with /, without a query string').default(''),
    params: paramsSchema.default([]),
    query: z.record(z.string().regex(/^[A-Za-z0-9_.[\]-]{1,100}$/), z.string().max(1000)).default({}),
    paging: pagingSchema,
    mapping: mappingSchema,
    graphql: graphqlRequestSchema.optional(),
    soap: soapRequestSchema.optional(),
    odata: odataRequestSchema.optional()
  })
  .strict();
export type EndpointDefinition = z.infer<typeof endpointDefinitionSchema>;

export const endpointCreateSchema = z
  .object({
    name: restName,
    title: z.string().trim().max(200).nullable().default(null),
    description: z.string().trim().max(1000).nullable().default(null),
    lookups: z.boolean().default(false),
    definition: endpointDefinitionSchema
  })
  .strict();
export const endpointUpdateSchema = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    lookups: z.boolean().optional(),
    definition: endpointDefinitionSchema.optional()
  })
  .strict();

export interface RestConnectionRow {
  id: string;
  tenant_id: string;
  name: string;
  title: string | null;
  base_url: string;
  zone: string;
  label: Label;
  auth_kind: AuthKind;
  auth_config: { username?: string; headerName?: string; queryName?: string; tokenUrl?: string; clientId?: string; scope?: string };
  credential: string | null;
  credential_ref: string | null;
  vault_owner: string | null;
  default_headers: Record<string, string>;
  timeout_ms: number;
  max_bytes: number;
  protocol: Protocol;
  wsdl_url: string | null;
  wsdl_at: number | null;
  /** What soap.ts read from the WSDL; null for other protocols. */
  service_meta: ServiceMeta | null;
  /** What odata.ts read from `$metadata`; null for other protocols. */
  odata_meta: ODataMeta | null;
  /** What openapi.ts read from an imported OpenAPI document (REST); null when none was imported. */
  openapi_meta: OpenApiMeta | null;
  health: 'unknown' | 'healthy' | 'degraded' | 'unreachable';
  health_detail: string | null;
  checked_at: number | null;
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface EndpointRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  name: string;
  title: string | null;
  description: string | null;
  definition: EndpointDefinition;
  lookups: boolean;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const connFrom = (r: Record<string, unknown>): RestConnectionRow => {
  const protocol = ((PROTOCOLS as readonly string[]).includes(String(r.protocol)) ? r.protocol : 'rest') as Protocol;
  const meta = json<Record<string, unknown> | null>(r.service_meta, null);
  const { wsdl: _doc, ...row } = r;
  return {
    ...(row as unknown as RestConnectionRow),
    protocol,
    wsdl_url: (r.wsdl_url as string | null | undefined) ?? null,
    wsdl_at: num(r.wsdl_at),
    service_meta: protocol === 'soap' ? (meta as unknown as ServiceMeta | null) : null,
    odata_meta: protocol === 'odata' && meta?.kind === 'odata' ? (meta as unknown as ODataMeta) : null,
    openapi_meta: protocol === 'rest' && meta?.kind === 'openapi' ? (meta as unknown as OpenApiMeta) : null,
    auth_kind: r.auth_kind as AuthKind,
    auth_config: json(r.auth_config, {}),
    default_headers: json(r.default_headers, {}),
    timeout_ms: Number(r.timeout_ms),
    max_bytes: Number(r.max_bytes),
    checked_at: num(r.checked_at),
    version: Number(r.version),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at)
  };
};
const endpointFrom = (r: Record<string, unknown>): EndpointRow => ({
  ...(r as unknown as EndpointRow),
  definition: endpointDefinitionSchema.parse(json(r.definition, {})),
  lookups: !!r.lookups,
  version: Number(r.version),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const restConnectionView = (c: RestConnectionRow, endpoints: EndpointRow[] = []) => ({
  id: c.id,
  kind: 'rest' as const,
  protocol: c.protocol,
  /** 2.0.x: the console's grouping: REST (REST and OData, resource URLs over HTTP verbs) or non-REST (GraphQL, SOAP). */
  category: c.protocol === 'rest' || c.protocol === 'odata' ? ('rest' as const) : ('non-rest' as const),
  name: c.name,
  title: c.title,
  baseUrl: c.base_url,
  ...(c.protocol === 'soap' ? { wsdlUrl: c.wsdl_url, wsdlAt: c.wsdl_at, soap: soapView(c) } : {}),
  ...(c.protocol === 'odata' ? { metadataUrl: c.wsdl_url, metadataAt: c.wsdl_at, odata: c.odata_meta } : {}),
  ...(c.openapi_meta ? { openapi: { url: c.wsdl_url, at: c.wsdl_at, specVersion: c.openapi_meta.specVersion, title: c.openapi_meta.title, version: c.openapi_meta.version, servers: c.openapi_meta.servers, operations: c.openapi_meta.operations, notes: c.openapi_meta.notes } } : {}),
  host: hostOf(c.base_url),
  zone: c.zone,
  label: c.label,
  auth: { kind: c.auth_kind, ...c.auth_config, hasSecret: !!c.credential, secretFromVault: !!c.vault_owner || !!c.credential_ref },
  headers: Object.fromEntries(Object.entries(c.default_headers).map(([k, v]) => [k, VAULT_VALUE.test(v) ? v : SECRET_HEADER.test(k) ? '••••' : v])),
  timeoutMs: c.timeout_ms,
  maxBytes: c.max_bytes,
  health: c.health,
  healthDetail: c.health_detail,
  checkedAt: c.checked_at,
  version: c.version,
  endpoints: endpoints.map(endpointView),
  createdAt: c.created_at,
  updatedAt: c.updated_at
});

/** A SOAP connection's ports and operations as the editor lists them (never the WSDL itself). */
function soapView(c: RestConnectionRow) {
  const m = c.service_meta;
  if (!m) return { ports: [], operations: [], notes: [] };
  return {
    targetNamespace: m.targetNamespace,
    ports: m.ports.map((p) => ({ ...p, usable: underBase(c.base_url, p.address) })),
    operations: m.operations.map((o) => ({ name: o.name, port: o.port, soapVersion: o.soapVersion, soapAction: o.soapAction, style: o.style, input: o.input.element?.name ?? o.name, fields: o.input.fields, output: o.output.element?.name ?? null, writeLike: !!writeLikeOperation(o.name) })),
    notes: m.notes
  };
}

export const endpointView = (e: EndpointRow) => ({ id: e.id, connectionId: e.connection_id, name: e.name, title: e.title, description: e.description, lookups: e.lookups, version: e.version, ...e.definition, updatedAt: e.updated_at });

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

/** A value at a JSON pointer or a dotted path. */
export function valueAt(doc: unknown, path: string): unknown {
  if (!path) return doc;
  if (path.startsWith('/')) return jsonPointer(doc, path);
  let cur: unknown = doc;
  for (const k of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? (/^\d+$/.test(k) ? cur[Number(k)] : undefined) : Object.prototype.hasOwnProperty.call(cur, k) ? (cur as Record<string, unknown>)[k] : undefined;
  }
  return cur;
}

/** A mapped value in its field's type (null when it does not read as that type). */
export function typed(type: (typeof FIELD_TYPES)[number], v: unknown): unknown {
  if (v === undefined || v === null) return null;
  switch (type) {
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : typeof v === 'string' ? /^(1|true|t|yes|y)$/i.test(v) : null;
    case 'date': {
      const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    case 'json':
      return v;
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

/** Items as columns and rows: the mapped fields, or every top-level key of the items when none are mapped. */
export function mapItems(items: unknown[], m: Mapping): { columns: string[]; rows: unknown[][] } {
  if (m.fields.length) return { columns: m.fields.map((f) => f.name), rows: items.map((it) => m.fields.map((f) => typed(f.type, valueAt(it, f.path)))) };
  const columns: string[] = [];
  for (const it of items) if (it && typeof it === 'object' && !Array.isArray(it)) for (const k of Object.keys(it)) if (!columns.includes(k) && columns.length < 200) columns.push(k);
  if (!columns.length) return { columns: ['value'], rows: items.map((it) => [it]) };
  return { columns, rows: items.map((it) => columns.map((k) => (it && typeof it === 'object' ? ((it as Record<string, unknown>)[k] ?? null) : null))) };
}

/** RFC 8288: the `rel="next"` target of a Link header. */
export function nextLink(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]*)>\s*;(.*)$/.exec(part);
    if (m && /(^|;)\s*rel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?\s*(;|$)/i.test(m[2]!)) return m[1]!;
  }
  return null;
}

/** Problems with an endpoint definition: placeholders that are not parameters, credential literals, identifiers. */
export function endpointProblems(d: EndpointDefinition): string[] {
  const out = paramProblems(d.params);
  const names = new Set(d.params.map((p) => p.name));
  if (d.params.some((p) => p.type === 'identifier')) out.push('Identifier parameters are for SQL queries; a REST parameter is a value.');
  const used = new Set<string>();
  const templates = [d.path, ...Object.values(d.query), ...Object.values(d.graphql?.variables ?? {}).filter((v): v is string => typeof v === 'string'), ...Object.values(d.soap?.args ?? {}), ...(d.odata?.filter ? [d.odata.filter] : []), ...(d.odata?.search ? [d.odata.search] : [])];
  for (const t of templates) for (const m of t.matchAll(PLACEHOLDER)) used.add(m[1]!);
  if ([d.graphql, d.soap, d.odata].filter(Boolean).length > 1) out.push('An endpoint is REST, GraphQL, SOAP or OData: one of them.');
  for (const u of used) if (!names.has(u)) out.push(`{${u}} is not a parameter of this endpoint.`);
  for (const [k, v] of Object.entries(d.query)) if (SECRET_FIELD.test(k) && !VAULT_VALUE.test(v) && !/^\{[a-z][a-z0-9_]*\}$/.test(v)) out.push(`The query parameter ${k} carries a credential: give it as the connection's API key, or a vault reference, never a literal.`);
  return [...new Set(out)];
}

const GQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** The request parameters a paging style sets: query parameters (REST), variables (GraphQL) or input fields (SOAP). */
function pagingNames(p: Paging): string[] {
  if (p.kind === 'page') return [p.param, ...(p.sizeParam ? [p.sizeParam] : [])];
  if (p.kind === 'offset') return [p.offsetParam, p.limitParam];
  if (p.kind === 'cursor') return [p.param, ...(p.sizeParam ? [p.sizeParam] : [])];
  if (p.kind === 'link') return p.sizeParam ? [p.sizeParam] : [];
  return [];
}

/** The operation a SOAP endpoint calls: by name, on its port or the first usable port that has it. */
export function soapOperation(c: Pick<RestConnectionRow, 'base_url' | 'service_meta'>, req: { operation: string; port?: string | undefined }): { op: SoapOperation; address: string } | null {
  const m = c.service_meta;
  if (!m) return null;
  const candidates = m.operations.filter((o) => o.name === req.operation && (!req.port || o.port === req.port));
  const addressOf = (o: SoapOperation) => m.ports.find((p) => p.name === o.port)?.address ?? '';
  const pick = candidates.find((o) => underBase(c.base_url, addressOf(o))) ?? candidates[0];
  return pick ? { op: pick, address: addressOf(pick) } : null;
}

/** What the connection's protocol asks of an endpoint definition (1.9.0). */
export function protocolProblems(c: Pick<RestConnectionRow, 'protocol' | 'base_url' | 'service_meta'> & Partial<Pick<RestConnectionRow, 'odata_meta'>>, d: EndpointDefinition): string[] {
  const out: string[] = [];
  if (c.protocol === 'rest') {
    if (d.graphql || d.soap || d.odata) out.push('This is a REST connection: an endpoint has no GraphQL query, SOAP operation or OData entity set.');
    return out;
  }
  if (c.protocol === 'odata') return odataProblems(c.odata_meta ?? null, d);
  if (d.odata) out.push(`This is a ${c.protocol === 'graphql' ? 'GraphQL' : 'SOAP'} connection: an endpoint has no OData entity set.`);
  if (d.paging.kind === 'link') out.push('Link-header paging is for REST endpoints.');
  if (c.protocol === 'graphql') {
    if (d.soap) out.push('This is a GraphQL connection: an endpoint has no SOAP operation.');
    if (!d.graphql) return [...out, 'A GraphQL endpoint holds its query document.'];
    out.push(...classifyGraphql(d.graphql.query).problems);
    for (const n of pagingNames(d.paging)) if (!GQL_NAME.test(n)) out.push(`The paging variable ${n} is not a GraphQL variable name.`);
    return out;
  }
  if (d.graphql) out.push('This is a SOAP connection: an endpoint has no GraphQL query.');
  if (!d.soap) return [...out, 'A SOAP endpoint names the operation it calls.'];
  if (d.path) out.push('A SOAP endpoint is called at its port\'s address from the WSDL; leave the path empty.');
  const found = soapOperation(c, d.soap);
  if (!found) return [...out, `${d.soap.operation} is not an operation of this WSDL${d.soap.port ? ` on port ${d.soap.port}` : ''}.`];
  const { op, address } = found;
  if (!underBase(c.base_url, address)) out.push(`The address of port ${op.port} (${address.slice(0, 200)}) is not under the base URL ${c.base_url}; requests only go to addresses under it.`);
  const verb = writeLikeOperation(op.name);
  if (verb && !d.soap.confirmRead) out.push(`${op.name} is named like a write (${verb}). API connections only read in this release: confirm the operation only reads (confirmRead), or leave it out.`);
  if (op.input.fields.length) {
    const known = new Set(op.input.fields.map((f) => f.name));
    for (const k of Object.keys(d.soap.args)) if (!known.has(k)) out.push(`${k} is not an input field of ${op.name} (${[...known].slice(0, 20).join(', ')}).`);
    for (const n of pagingNames(d.paging)) if (!known.has(n)) out.push(`The paging field ${n} is not an input field of ${op.name}.`);
  }
  return out;
}

/** The entity set or singleton an OData endpoint reads. */
export function odataSet(meta: ODataMeta | null, name: string): ODataSet | null {
  return meta?.sets.find((x) => x.name === name) ?? null;
}

/** What an OData endpoint must be: its entity set from the metadata, names it knows, checked filter and search. */
export function odataProblems(meta: ODataMeta | null, d: EndpointDefinition): string[] {
  const out: string[] = [];
  if (d.graphql || d.soap) out.push('This is an OData connection: an endpoint has no GraphQL query or SOAP operation.');
  if (!d.odata) return [...out, 'An OData endpoint names the entity set it reads.'];
  if (!meta) return [...out, 'The connection\'s $metadata has not been read; refresh it first.'];
  if (d.path) out.push('An OData endpoint reads its entity set under the service root; leave the path empty.');
  for (const k of Object.keys(d.query)) if (k.startsWith('$')) out.push(`${k} is set from the endpoint's OData options, not as a query parameter.`);
  if (d.paging.kind === 'page' || d.paging.kind === 'cursor') out.push('OData endpoints page with $top and $skip (offset paging) or by the server\'s @odata.nextLink (link paging).');
  if (d.paging.kind === 'offset' && (d.paging.offsetParam !== '$skip' || d.paging.limitParam !== '$top')) out.push('OData offset paging uses $skip and $top.');
  const set = odataSet(meta, d.odata.entitySet);
  if (!set) return [...out, `${d.odata.entitySet} is not an entity set or singleton of this service (${meta.sets.map((x) => x.name).slice(0, 15).join(', ')}).`];
  const props = new Set(set.properties.map((p) => p.name));
  const navs = new Set(set.navigation.map((n) => n.name));
  for (const x of d.odata.select) if (!props.has(x) && !navs.has(x)) out.push(`${x} is not a property of ${set.name}.`);
  for (const x of d.odata.expand) if (!navs.has(x)) out.push(`${x} is not a navigation property of ${set.name}.`);
  const params = new Set(d.params.map((p) => p.name));
  if (d.odata.filter) out.push(...filterProblems(d.odata.filter, set, params));
  if (d.odata.orderby) out.push(...orderbyProblems(d.odata.orderby, set));
  if (d.odata.search) out.push(...searchProblems(d.odata.search, params));
  if (set.kind === 'singleton' && (d.odata.filter || d.odata.orderby || d.odata.search || d.paging.kind !== 'none')) out.push(`${set.name} is a singleton: it takes $select and $expand only.`);
  return [...new Set(out)];
}

/** A template string's value: the bound value itself for a lone `{param}`, else the text with placeholders filled. */
function renderTemplate(t: string, values: Record<string, unknown>): unknown {
  const whole = /^\{([a-z][a-z0-9_]{0,62})\}$/.exec(t);
  if (whole) return values[whole[1]!];
  return t.replace(PLACEHOLDER, (_m, n: string) => (Array.isArray(values[n]) ? (values[n] as unknown[]).join(',') : String(values[n] ?? '')));
}

/** GraphQL variables: JSON literals as written, templates with the bound parameters; an absent value is left out. */
export function graphqlVariables(vars: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    const val = typeof v === 'string' ? renderTemplate(v, values) : v;
    if (val !== undefined && val !== null) out[k] = val;
  }
  return out;
}

const argText = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.flatMap(argText) : v instanceof Date ? [v.toISOString()] : [typeof v === 'object' ? JSON.stringify(v) : String(v)]);

/** SOAP arguments in the input element's order (the order given when the WSDL lists no fields). */
export function soapArgs(op: SoapOperation, templates: Record<string, string>, values: Record<string, unknown>, extra: Record<string, string | number>): SoapArg[] {
  const rendered = new Map<string, string[]>();
  for (const [k, t] of Object.entries(templates)) rendered.set(k, argText(renderTemplate(t, values)));
  for (const [k, v] of Object.entries(extra)) rendered.set(k, [String(v)]);
  const order = op.input.fields.length ? op.input.fields.map((f) => f.name) : [...rendered.keys()];
  return order.filter((n) => rendered.has(n) && rendered.get(n)!.length).map((n) => [n, rendered.get(n)!]);
}

interface PageState {
  /** Page number, offset, cursor value or next URL for the next request. */
  page?: number;
  offset?: number;
  cursor?: string | null;
  url?: string | null;
  /** Items of that page already returned. */
  skip?: number;
  /** The endpoint version the cursor was made for. */
  v: number;
  e: string;
}

/** Who a read is for (see `RunCaller` in saved-queries.ts). */
export interface RestCaller {
  tenantId: string;
  principal: Principal | null;
  ceiling?: Label | null;
  via: string;
  ip?: string | null;
  traceId?: string | null;
}

export interface RestReadResult extends ReadResult {
  pages: number;
  /** GraphQL: errors that came with partial data. */
  warnings?: string[];
  untrusted?: { action: 'annotate'; rule: string | null };
}

export class RestConnections {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** OAuth2 access tokens by connection and version, until shortly before they expire. Process-local, like a lease. */
  private readonly tokens = new Map<string, { token: string; until: number }>();

  // ---------- design ----------

  async list(tenantId: string): Promise<RestConnectionRow[]> {
    return ((await this.db('rest_connections').where({ tenant_id: tenantId }).orderBy('name')) as Record<string, unknown>[]).map(connFrom);
  }

  /** A connection by id or name. */
  async get(tenantId: string, ref: string): Promise<RestConnectionRow> {
    const r = await this.db('rest_connections').where({ tenant_id: tenantId }).andWhere((w) => void w.where({ id: ref }).orWhere({ name: ref })).first();
    if (!r) throw notFound('REST connection');
    return connFrom(r);
  }

  async endpoints(c: Pick<RestConnectionRow, 'id'>): Promise<EndpointRow[]> {
    return ((await this.db('rest_endpoints').where({ connection_id: c.id }).orderBy('name')) as Record<string, unknown>[]).map(endpointFrom);
  }

  async endpoint(c: Pick<RestConnectionRow, 'id' | 'name'>, ref: string): Promise<EndpointRow> {
    const r = await this.db('rest_endpoints').where({ connection_id: c.id }).andWhere((w) => void w.where({ id: ref }).orWhere({ name: ref })).first();
    if (!r) throw notFound(`Endpoint ${ref.slice(0, 63)} of ${c.name}`);
    return endpointFrom(r);
  }

  async view(c: RestConnectionRow) {
    return restConnectionView(c, await this.endpoints(c));
  }

  /** Why a base URL may not be used: not http(s), credentials or a query in it, or a host not on the tenant's list. */
  async baseUrlProblem(tenantId: string, raw: string): Promise<string | null> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return `${raw.slice(0, 100)} is not a URL.`;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'A REST connection uses http:// or https://.';
    if (u.username || u.password) return 'Credentials do not belong in the URL; give them as the connection\'s authentication.';
    if (u.search || u.hash) return 'The base URL has no query string or fragment; endpoints add their own query parameters.';
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const list = await this.s().integrations.allowList(tenantId);
    if (!list || list.empty) return `${host} is not on this tenant's list of allowed hosts, which is empty. A tenant admin adds it under Registry, Allowed hosts.`;
    const p = tenantHostProblem(host, isIP(host) ? [host] : [], list);
    return p ? `${p} A tenant admin adds it under Registry, Allowed hosts.` : null;
  }

  private headerProblems(headers: Record<string, string>): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(headers)) {
      if (RESERVED_HEADERS.has(k.toLowerCase())) out.push(`The header ${k} is set by the transport.`);
      const ref = VAULT_VALUE.exec(v);
      if (SECRET_HEADER.test(k) && !ref) out.push(`The header ${k} carries a credential: use the connection's authentication or a vault reference (vault:path#key), never a literal.`);
      if (ref && !isSecretRef(ref[2]!)) out.push(`${ref[2]!.slice(0, 120)} is not a vault reference.`);
    }
    return out;
  }

  private authProblems(a: z.infer<typeof authSchema>): string[] {
    const out: string[] = [];
    const needSecret = a.kind !== 'none';
    if (a.kind === 'basic' && !a.username) out.push('Basic authentication names the user.');
    if (a.kind === 'api-key-header' && !a.headerName) out.push('Name the header the API key goes in.');
    if (a.kind === 'api-key-query' && !a.queryName) out.push('Name the query parameter the API key goes in.');
    if (a.kind === 'oauth2-client' && (!a.tokenUrl || !a.clientId)) out.push('OAuth2 client credentials need the token URL and the client id.');
    if (needSecret && a.secret === undefined) out.push('Give the secret (a password, token, key or client secret), or a vault reference to it.');
    if (!needSecret && a.secret !== undefined) out.push('Without authentication there is no secret.');
    if (a.secret && isVaultRef(a.secret) && !isSecretRef(a.secret)) out.push(`${a.secret.slice(0, 120)} is not a vault reference: they look like vault:<path>#<key>.`);
    return out;
  }

  private sealSecret(tenantId: string, id: string, secret: string): Promise<string> {
    return this.s().keys.seal(tenantId, JSON.stringify({ secret }), `rest-connection:${id}`);
  }

  private configOf(a: z.infer<typeof authSchema>): RestConnectionRow['auth_config'] {
    const { kind: _k, secret: _s, ...rest } = a;
    return rest;
  }

  async create(p: Principal, input: z.infer<typeof restConnectionCreateSchema>, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<RestConnectionRow> {
    const s = this.s();
    if (!clears(p.clearance, input.label)) throw forbidden(`Your clearance is ${p.clearance}; a ${input.label} connection is above it.`, { step: 'clearance' });
    const problems = [...this.authProblems(input.auth), ...this.headerProblems(input.headers)];
    if (input.protocol === 'soap' && !input.wsdlUrl && !input.wsdl) problems.push('A SOAP connection needs its WSDL: the URL to fetch it from, or the document itself.');
    if (input.protocol !== 'soap' && (input.wsdlUrl || input.wsdl)) problems.push('A WSDL is for SOAP connections.');
    if (input.wsdlUrl && input.wsdl) problems.push('Give the WSDL as a URL or as the document, not both.');
    const urlProblem = await this.baseUrlProblem(p.tenantId, input.baseUrl);
    if (urlProblem) problems.unshift(urlProblem);
    if (input.auth.tokenUrl) {
      const tp = await this.baseUrlProblem(p.tenantId, input.auth.tokenUrl.replace(/[?#].*$/, ''));
      if (tp) problems.push(`The token URL: ${tp}`);
    }
    if (problems.length) {
      await s.audit.append({ tenantId: p.tenantId, action: 'connection.rest.refused', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { name: input.name }, label: input.label, detail: { host: hostOf(input.baseUrl), problems: problems.slice(0, 5) }, traceId: ctx.traceId ?? null });
      throw new HttpProblem(422, 'REST connection refused', problems.join(' '), { extensions: { problems } });
    }
    const refs = [...(input.auth.secret && isVaultRef(input.auth.secret) ? [input.auth.secret] : []), ...Object.values(input.headers).map((v) => VAULT_VALUE.exec(v)?.[2]).filter((x): x is string => !!x)];
    if (refs.length) await s.vault.assertRefsReadable(p, refs, ctx);
    await s.zones.assertMemberFits('connection', input.zone, input.label);
    if (await this.db('rest_connections').where({ tenant_id: p.tenantId, name: input.name }).first('id')) throw conflict('A REST connection with that name exists.');
    if (await this.db('data_connections').where({ tenant_id: p.tenantId, name: input.name }).first('id')) throw conflict('A data connection with that name exists.');
    let wsdl: { text: string; meta: ServiceMeta; url?: string } | null = null;
    if (input.protocol === 'soap') {
      try {
        wsdl = await this.loadWsdl(p.tenantId, input.baseUrl.replace(/\/+$/, ''), input.wsdlUrl ?? null, input.wsdl ?? null, input.timeoutMs);
      } catch (err) {
        if (err instanceof HttpProblem) await s.audit.append({ tenantId: p.tenantId, action: 'connection.rest.refused', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { name: input.name }, label: input.label, detail: { host: hostOf(input.baseUrl), protocol: 'soap', problems: [(err.detail ?? err.title).slice(0, 300)] }, traceId: ctx.traceId ?? null });
        throw err;
      }
    }
    const id = ulid();
    const t = Date.now();
    await this.db('rest_connections').insert({
      id,
      tenant_id: p.tenantId,
      name: input.name,
      title: input.title,
      base_url: input.baseUrl.replace(/\/+$/, ''),
      zone: input.zone,
      label: input.label,
      auth_kind: input.auth.kind,
      auth_config: JSON.stringify(this.configOf(input.auth)),
      credential: input.auth.secret ? await this.sealSecret(p.tenantId, id, input.auth.secret) : null,
      credential_ref: null,
      vault_owner: refs.length ? p.userId : null,
      default_headers: JSON.stringify(input.headers),
      timeout_ms: input.timeoutMs,
      max_bytes: input.maxBytes,
      // Written only for the new protocols, so a database without migration 114 still takes a REST connection.
      ...(input.protocol !== 'rest' ? { protocol: input.protocol } : {}),
      ...(wsdl ? { wsdl_url: wsdl.url ?? input.wsdlUrl ?? null, wsdl: wsdl.text, wsdl_at: t, service_meta: JSON.stringify(wsdl.meta) } : {}),
      health: 'unknown',
      health_detail: null,
      checked_at: null,
      version: 1,
      created_by: p.userId,
      created_at: t,
      updated_at: t
    });
    let row = await this.get(p.tenantId, id);
    if (row.protocol === 'odata') {
      // OData: $metadata is read with the stored authentication (a vault reference resolves as the saver); a
      // connection whose metadata cannot be read is not kept.
      try {
        const m = await this.loadMetadata(p.tenantId, row.base_url, row.timeout_ms, row);
        await this.db('rest_connections').where({ id }).update({ wsdl_url: m.url, wsdl: m.text, wsdl_at: t, service_meta: JSON.stringify(m.meta) });
        row = await this.get(p.tenantId, id);
      } catch (err) {
        await this.db('rest_connections').where({ id }).delete();
        this.tokens.delete(`${id}:1`);
        const prob = err instanceof HttpProblem ? err : new HttpProblem(502, 'Metadata fetch failed', scrubError(err, []).slice(0, 300));
        await s.audit.append({ tenantId: p.tenantId, action: 'connection.rest.refused', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { name: input.name }, label: input.label, detail: { host: hostOf(input.baseUrl), protocol: 'odata', problems: [(prob.detail ?? prob.title).slice(0, 300)] }, traceId: ctx.traceId ?? null });
        throw prob;
      }
    }
    await s.audit.append({ tenantId: p.tenantId, action: 'connection.rest.registered', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: id, name: row.name }, label: row.label, detail: { host: hostOf(row.base_url), zone: row.zone, auth: row.auth_kind, secretFromVault: !!row.vault_owner, timeoutMs: row.timeout_ms, maxBytes: row.max_bytes, ...(row.protocol !== 'rest' ? { protocol: row.protocol } : {}), ...(row.service_meta ? { wsdlFrom: row.wsdl_url ? 'url' : 'upload', ports: row.service_meta.ports.length, operations: row.service_meta.operations.length } : {}), ...(row.odata_meta ? { sets: row.odata_meta.sets.length } : {}) }, traceId: ctx.traceId ?? null });
    return row;
  }

  /**
   * OData: `<root>/$metadata`, fetched through the same guard (allowed hosts, pinned address, no redirects, 2 MB, the
   * timeout) with the connection's authentication, and read by the strict parser.
   */
  private async loadMetadata(tenantId: string, baseUrl: string, timeoutMs: number, stored: RestConnectionRow): Promise<{ text: string; meta: ODataMeta; url: string }> {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/$metadata`);
    const check = await this.check(tenantId);
    const { headers, query, secrets } = await this.auth(stored, check);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: GuardedResponse;
    try {
      res = await guardedRequest({ method: 'GET', url, headers: { ...headers, accept: 'application/xml', 'odata-maxversion': '4.0' }, timeoutMs, maxBytes: MAX_METADATA_BYTES, check });
    } catch (err) {
      if (err instanceof ServiceUrlRefused) throw new HttpProblem(422, 'Metadata refused', err.message);
      throw new HttpProblem(502, 'Metadata fetch failed', scrubError(err, secrets).slice(0, 300));
    }
    const declared = Number(res.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > res.body.length) throw new HttpProblem(422, 'Metadata refused', 'The $metadata document is larger than 2 MB.');
    if (res.status < 200 || res.status >= 300) throw new HttpProblem(502, 'Metadata fetch failed', `GET ${hostOf(baseUrl)}/$metadata answered ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}.`);
    const text = res.body.toString('utf8');
    try {
      return { text, meta: parseMetadata(text), url: url.toString().replace(/\?.*$/, '') };
    } catch (err) {
      throw new HttpProblem(422, 'Metadata refused', `The $metadata could not be read: ${(err as Error).message}`.slice(0, 500));
    }
  }

  /** OData: reads `$metadata` again and lists the endpoints whose entity set is gone. */
  async refreshMetadata(p: Principal, ref: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ connection: RestConnectionRow; missing: string[] }> {
    const c = await this.readable(p, ref);
    if (c.protocol !== 'odata') throw conflict(`${c.name} is a ${c.protocol} connection; $metadata is for OData connections.`);
    const m = await this.loadMetadata(c.tenant_id, c.base_url, c.timeout_ms, c);
    const t = Date.now();
    await this.db('rest_connections').where({ id: c.id }).update({ wsdl_url: m.url, wsdl: m.text, wsdl_at: t, service_meta: JSON.stringify(m.meta), version: c.version + 1, updated_at: t });
    const row = await this.get(c.tenant_id, c.id);
    const missing = (await this.endpoints(row)).filter((e) => e.definition.odata && !odataSet(row.odata_meta, e.definition.odata.entitySet)).map((e) => e.name);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'connection.rest.metadata.refreshed', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name }, label: c.label, detail: { protocol: 'odata', host: hostOf(c.base_url), sets: m.meta.sets.length, actions: m.meta.actions.length, functions: m.meta.functions.length, missing, version: row.version }, traceId: ctx.traceId ?? null });
    return { connection: row, missing };
  }

  /**
   * OpenAPI import, first step: an OpenAPI 3 or Swagger 2.0 document by URL (through the same guard, 4 MB) or as
   * text, kept as the REST connection's service description, with its operations read against the base URL.
   */
  async readOpenApi(p: Principal, ref: string, input: { url?: string | undefined; document?: string | undefined }, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ connection: RestConnectionRow; meta: OpenApiMeta }> {
    const c = await this.readable(p, ref);
    if (c.protocol !== 'rest') throw conflict(`${c.name} is a ${c.protocol} connection; OpenAPI import is for REST connections.`);
    if (!!input.url === !!input.document) throw new HttpProblem(400, 'Invalid request', 'Give the OpenAPI document as a URL or as text: one of them.');
    let text = input.document ?? '';
    if (input.url) {
      const up = await this.wsdlUrlProblem(c.tenant_id, input.url);
      if (up) throw new HttpProblem(422, 'OpenAPI refused', `${up.replace('WSDL', 'document')} A tenant admin adds it under Registry, Allowed hosts.`);
      let res: GuardedResponse;
      try {
        res = await guardedRequest({ method: 'GET', url: new URL(input.url), headers: { accept: 'application/json, application/yaml, application/x-yaml, text/yaml, */*' }, timeoutMs: c.timeout_ms, maxBytes: MAX_OPENAPI_BYTES, check: await this.check(c.tenant_id) });
      } catch (err) {
        if (err instanceof ServiceUrlRefused) throw new HttpProblem(422, 'OpenAPI refused', err.message);
        throw new HttpProblem(502, 'OpenAPI fetch failed', scrubError(err, []).slice(0, 300));
      }
      const declared = Number(res.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > res.body.length) throw new HttpProblem(422, 'OpenAPI refused', 'The document is larger than 4 MB.');
      if (res.status < 200 || res.status >= 300) throw new HttpProblem(502, 'OpenAPI fetch failed', `GET ${hostOf(input.url)} answered ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}.`);
      text = res.body.toString('utf8');
    }
    let meta: OpenApiMeta;
    try {
      const existing = new Set((await this.endpoints(c)).map((e) => e.name));
      meta = readOpenApi(parseOpenApiText(text), c.base_url, input.url ?? null, existing);
    } catch (err) {
      throw new HttpProblem(422, 'OpenAPI refused', `The document could not be read: ${(err as Error).message}`.slice(0, 500));
    }
    const t = Date.now();
    await this.db('rest_connections').where({ id: c.id }).update({ wsdl_url: input.url ?? null, wsdl: text, wsdl_at: t, service_meta: JSON.stringify(meta), updated_at: t });
    const row = await this.get(c.tenant_id, c.id);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'connection.rest.openapi.read', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name }, label: c.label, detail: { from: input.url ? 'url' : 'upload', ...(input.url ? { host: hostOf(input.url) } : {}), specVersion: meta.specVersion, operations: meta.operations.length, importable: meta.operations.filter((o) => o.importable).length }, traceId: ctx.traceId ?? null });
    return { connection: row, meta };
  }

  /** OpenAPI import, second step: the chosen GET operations become endpoints through `saveEndpoint` (every check applies). */
  async importOpenApi(p: Principal, ref: string, chosen: { operationId: string; name?: string | undefined }[], ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ created: { operationId: string; endpoint: string }[]; refused: { operationId: string; reason: string }[] }> {
    const c = await this.readable(p, ref);
    if (c.protocol !== 'rest') throw conflict(`${c.name} is a ${c.protocol} connection; OpenAPI import is for REST connections.`);
    const meta = c.openapi_meta;
    if (!meta) throw conflict(`${c.name} has no OpenAPI document; read one first.`);
    const taken = new Set((await this.endpoints(c)).map((e) => e.name));
    const created: { operationId: string; endpoint: string }[] = [];
    const refused: { operationId: string; reason: string }[] = [];
    for (const want of chosen) {
      const op = meta.operations.find((o) => o.operationId === want.operationId);
      if (!op) {
        refused.push({ operationId: want.operationId, reason: 'No operation of the document has that operationId.' });
        continue;
      }
      if (!op.importable || op.endpointPath === null) {
        refused.push({ operationId: op.operationId, reason: op.reason ?? 'Not importable.' });
        continue;
      }
      let name = want.name ?? op.name;
      if (taken.has(name)) {
        const base = name.slice(0, 56);
        for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
      }
      const query: Record<string, string> = {};
      for (const prm of op.params) if (prm.in === 'query') query[prm.name] = `{${prm.param}}`;
      const paging = pagingSchema.safeParse(op.paging.kind === 'none' ? { kind: 'none' } : { ...op.paging, ...('sizeParam' in op.paging && op.paging.sizeParam === null ? { sizeParam: null } : {}) });
      const definition = { path: op.endpointPath, params: paramDefs(op), query, paging: paging.success ? paging.data : { kind: 'none' as const }, mapping: op.mapping };
      try {
        const e = await this.saveEndpoint(p, c.id, { name, title: op.summary, description: `Imported from OpenAPI: ${op.method} ${op.path}`.slice(0, 1000), lookups: false, definition: definition as EndpointDefinition }, ctx);
        taken.add(e.name);
        created.push({ operationId: op.operationId, endpoint: e.name });
      } catch (err) {
        refused.push({ operationId: op.operationId, reason: ((err as HttpProblem).detail ?? (err as Error).message ?? 'refused').slice(0, 500) });
      }
    }
    await this.s().audit.append({ tenantId: p.tenantId, action: 'connection.rest.openapi.imported', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name }, label: c.label, detail: { created: created.map((x) => x.endpoint), refused: refused.map((x) => x.operationId).slice(0, 50) }, traceId: ctx.traceId ?? null });
    return { created, refused };
  }

  /** Why a WSDL URL may not be fetched: not http(s), credentials in it, or a host not on the tenant's list. */
  private async wsdlUrlProblem(tenantId: string, raw: string): Promise<string | null> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return `${raw.slice(0, 100)} is not a URL.`;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'A WSDL is fetched over http:// or https://.';
    if (u.username || u.password) return 'Credentials do not belong in the WSDL URL.';
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const list = await this.s().integrations.allowList(tenantId);
    if (!list || list.empty) return `${host} is not on this tenant's list of allowed hosts, which is empty.`;
    return tenantHostProblem(host, isIP(host) ? [host] : [], list);
  }

  /**
   * A WSDL fetched (through the same guard: allowed hosts, pinned address, no redirects, 2 MB, the connection's
   * timeout) or as given, read by the strict parser; at least one SOAP port must lie under the base URL.
   */
  private async loadWsdl(tenantId: string, baseUrl: string, wsdlUrl: string | null, given: string | null, timeoutMs: number): Promise<{ text: string; meta: ServiceMeta }> {
    let text = given;
    if (text == null) {
      if (!wsdlUrl) throw new HttpProblem(400, 'Invalid request', 'Give the WSDL URL or the document.');
      const up = await this.wsdlUrlProblem(tenantId, wsdlUrl);
      if (up) throw new HttpProblem(422, 'WSDL refused', `${up} A tenant admin adds it under Registry, Allowed hosts.`);
      let res: GuardedResponse;
      try {
        res = await guardedRequest({ method: 'GET', url: new URL(wsdlUrl), headers: { accept: 'text/xml, application/xml, application/wsdl+xml' }, timeoutMs, maxBytes: MAX_WSDL_BYTES, check: await this.check(tenantId) });
      } catch (err) {
        if (err instanceof ServiceUrlRefused) throw new HttpProblem(422, 'WSDL refused', err.message);
        throw new HttpProblem(502, 'WSDL fetch failed', scrubError(err, []).slice(0, 300));
      }
      const declared = Number(res.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > res.body.length) throw new HttpProblem(422, 'WSDL refused', 'The WSDL is larger than 2 MB.');
      if (res.status < 200 || res.status >= 300) throw new HttpProblem(502, 'WSDL fetch failed', `GET ${hostOf(wsdlUrl)} answered ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}.`);
      text = res.body.toString('utf8');
    }
    let meta: ServiceMeta;
    try {
      meta = parseWsdl(text);
    } catch (err) {
      throw new HttpProblem(422, 'WSDL refused', `The WSDL could not be read: ${(err as Error).message}`.slice(0, 500));
    }
    if (!meta.ports.some((p) => underBase(baseUrl, p.address))) throw new HttpProblem(422, 'WSDL refused', `No SOAP port of the WSDL is under the base URL ${baseUrl} (${meta.ports.map((p) => p.address).slice(0, 5).join(', ')}). Requests only go to addresses under it.`);
    return { text, meta };
  }

  /** Fetches the WSDL again (or takes a new one), re-reads it and lists the endpoints whose operation is gone. */
  async refreshWsdl(p: Principal, ref: string, input: z.infer<typeof wsdlRefreshSchema>, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ connection: RestConnectionRow; missing: string[] }> {
    const c = await this.readable(p, ref);
    if (c.protocol !== 'soap') throw conflict(`${c.name} is a ${c.protocol} connection; a WSDL is for SOAP connections.`);
    if (input.wsdlUrl && input.wsdl) throw new HttpProblem(400, 'Invalid request', 'Give the WSDL as a URL or as the document, not both.');
    const url = input.wsdlUrl ?? (input.wsdl ? null : c.wsdl_url);
    if (!url && !input.wsdl) throw new HttpProblem(400, 'Invalid request', `${c.name}'s WSDL was uploaded; upload it again or give a URL.`);
    const w = await this.loadWsdl(c.tenant_id, c.base_url, url, input.wsdl ?? null, c.timeout_ms);
    const t = Date.now();
    await this.db('rest_connections').where({ id: c.id }).update({ wsdl_url: url, wsdl: w.text, wsdl_at: t, service_meta: JSON.stringify(w.meta), version: c.version + 1, updated_at: t });
    const row = await this.get(c.tenant_id, c.id);
    const missing = (await this.endpoints(row)).filter((e) => e.definition.soap && !soapOperation(row, e.definition.soap)).map((e) => e.name);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'connection.rest.wsdl.refreshed', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name }, label: c.label, detail: { protocol: 'soap', from: url ? 'url' : 'upload', ...(url ? { host: hostOf(url) } : {}), ports: w.meta.ports.length, operations: w.meta.operations.length, notes: w.meta.notes.length, missing, version: row.version }, traceId: ctx.traceId ?? null });
    return { connection: row, missing };
  }

  /** The stored WSDL document of a SOAP connection. */
  async wsdlDocument(p: Principal, ref: string): Promise<string> {
    const c = await this.readable(p, ref);
    const row = (await this.db('rest_connections').where({ id: c.id }).first('wsdl')) as { wsdl?: string | null } | undefined;
    if (c.protocol !== 'soap' || !row?.wsdl) throw notFound('WSDL');
    return row.wsdl;
  }

  /** The schema helper: the Query type's root fields, from an introspection query sent as the connection authenticates. */
  async graphqlSchema(p: Principal, ref: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ queryType: string | null; fields: RootField[] }> {
    const c = await this.readable(p, ref);
    if (c.protocol !== 'graphql') throw conflict(`${c.name} is a ${c.protocol} connection; the schema helper is for GraphQL.`);
    const check = await this.check(c.tenant_id);
    let secrets: string[] = [];
    try {
      const a = await this.auth(c, check);
      secrets = a.secrets;
      const res = await guardedRequest({ method: 'POST', url: this.url(c, { path: '', params: [], query: {}, paging: { kind: 'none' }, mapping: { items: '', fields: [] } }, {}, {}, a.query), headers: { ...a.headers, 'content-type': 'application/json', accept: 'application/graphql-response+json, application/json' }, body: JSON.stringify({ query: INTROSPECTION_QUERY }), timeoutMs: c.timeout_ms, maxBytes: Math.min(16 * 1024 * 1024, Math.max(c.max_bytes, 4 * 1024 * 1024)), check });
      const status = res.status;
      const doc = this.answer(c, res, 'POST', hostOf(c.base_url), null, []) as { data?: unknown };
      const out = rootFields(doc.data);
      await this.s().audit.append({ tenantId: p.tenantId, action: 'connection.rest.graphql.schema', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name }, label: c.label, detail: { protocol: 'graphql', host: hostOf(c.base_url), status, fields: out.fields.length }, traceId: ctx.traceId ?? null });
      return out;
    } catch (err) {
      const raw = err instanceof HttpProblem ? err : err instanceof ServiceUrlRefused ? new HttpProblem(422, 'Host refused', err.message) : new HttpProblem(502, 'Request failed', scrubError(err, secrets).slice(0, 300));
      throw raw.detail ? new HttpProblem(raw.status, raw.title, scrubError(new Error(raw.detail), secrets)) : raw;
    }
  }

  async update(p: Principal, ref: string, input: z.infer<typeof restConnectionUpdateSchema>, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<RestConnectionRow> {
    const s = this.s();
    const c = await this.readable(p, ref);
    const label = input.label ?? c.label;
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    const problems: string[] = [];
    if (input.baseUrl) {
      const up = await this.baseUrlProblem(p.tenantId, input.baseUrl);
      if (up) problems.push(up);
      const base = input.baseUrl.replace(/\/+$/, '');
      if (c.protocol === 'soap' && c.service_meta && !c.service_meta.ports.some((x) => underBase(base, x.address))) problems.push(`No SOAP port of the WSDL is under ${base}; requests only go to addresses under the base URL.`);
    }
    if (input.auth) {
      // The secret may be left out to keep the one that is sealed, as long as the kind does not change.
      const keep = input.auth.secret === undefined && input.auth.kind === c.auth_kind && !!c.credential;
      problems.push(...this.authProblems(keep ? { ...input.auth, secret: 'kept' } : input.auth));
      if (input.auth.tokenUrl) {
        const tp = await this.baseUrlProblem(p.tenantId, input.auth.tokenUrl.replace(/[?#].*$/, ''));
        if (tp) problems.push(`The token URL: ${tp}`);
      }
    }
    if (input.headers) problems.push(...this.headerProblems(input.headers));
    if (problems.length) throw new HttpProblem(422, 'REST connection refused', problems.join(' '), { extensions: { problems } });
    const refs = [...(input.auth?.secret && isVaultRef(input.auth.secret) ? [input.auth.secret] : []), ...Object.values(input.headers ?? {}).map((v) => VAULT_VALUE.exec(v)?.[2]).filter((x): x is string => !!x)];
    // The references that stay: the sealed secret when it is a reference and not replaced, the headers not replaced.
    const keepSecret = !input.auth || (input.auth.secret === undefined && input.auth.kind !== 'none');
    const keptSecretRef = keepSecret && c.credential ? json<{ secret?: string }>(await s.keys.open(c.tenant_id, c.credential, `rest-connection:${c.id}`), {}).secret : undefined;
    const kept = [...(keptSecretRef && isVaultRef(keptSecretRef) ? [keptSecretRef] : []), ...(input.headers ? [] : Object.values(c.default_headers).map((v) => VAULT_VALUE.exec(v)?.[2]).filter((x): x is string => !!x))];
    // All references of a connection resolve as one owner: whoever brings a new one must be able to read the kept ones too.
    if (refs.length) await s.vault.assertRefsReadable(p, [...new Set([...refs, ...kept])], ctx);
    if (input.zone !== undefined || input.label !== undefined) await s.zones.assertMemberFits('connection', input.zone ?? c.zone, label);
    const upd: Record<string, unknown> = { version: c.version + 1, updated_at: Date.now() };
    if (input.title !== undefined) upd.title = input.title;
    if (input.baseUrl !== undefined) Object.assign(upd, { base_url: input.baseUrl.replace(/\/+$/, ''), health: 'unknown', health_detail: null });
    if (input.zone !== undefined) upd.zone = input.zone;
    if (input.label !== undefined) upd.label = input.label;
    if (input.headers !== undefined) upd.default_headers = JSON.stringify(input.headers);
    if (input.timeoutMs !== undefined) upd.timeout_ms = input.timeoutMs;
    if (input.maxBytes !== undefined) upd.max_bytes = input.maxBytes;
    if (input.auth) {
      Object.assign(upd, { auth_kind: input.auth.kind, auth_config: JSON.stringify(this.configOf(input.auth)) });
      if (input.auth.kind === 'none') Object.assign(upd, { credential: null, credential_ref: null });
      else if (input.auth.secret !== undefined) {
        Object.assign(upd, { credential: await this.sealSecret(c.tenant_id, c.id, input.auth.secret), credential_ref: (await s.credentialMoves.rewritten('rest-connection', c.tenant_id, c.id, 'secret', input.auth.secret, c.credential_ref)) ?? null });
      }
    }
    upd.vault_owner = refs.length ? p.userId : kept.length ? c.vault_owner : null;
    await this.db('rest_connections').where({ id: c.id }).update(upd);
    this.tokens.delete(c.id);
    const row = await this.get(p.tenantId, c.id);
    await s.audit.append({ tenantId: p.tenantId, action: input.auth?.secret !== undefined ? 'connection.rest.credential.rotated' : 'connection.rest.updated', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name }, label: row.label, detail: { changed: Object.keys(input), host: hostOf(row.base_url), auth: row.auth_kind, version: row.version }, traceId: ctx.traceId ?? null });
    return row;
  }

  async remove(p: Principal, ref: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<void> {
    const c = await this.readable(p, ref);
    const used = await this.usedBy(c);
    if (used.length) throw new HttpProblem(409, 'Still in use', `${used.map((u) => u.name).join(', ')} still ${used.length === 1 ? 'reads' : 'read'} from ${c.name}. Remove ${used.length === 1 ? 'it' : 'them'} first.`, { extensions: { usedBy: used } });
    await this.db.transaction(async (trx) => {
      await trx('rest_endpoints').where({ connection_id: c.id }).delete();
      await trx('rest_connections').where({ id: c.id }).delete();
    });
    this.tokens.delete(c.id);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'connection.rest.removed', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name }, label: c.label, traceId: ctx.traceId ?? null });
  }

  /** App entities and knowledge sources that read from a connection. */
  async usedBy(c: Pick<RestConnectionRow, 'id' | 'tenant_id'>): Promise<{ kind: string; id: string; name: string }[]> {
    const out: { kind: string; id: string; name: string }[] = [];
    if (await this.db.schema.hasColumn('app_entity_sources', 'kind')) {
      for (const r of (await this.db('app_entity_sources as s').join('app_entities as e', 'e.id', 's.entity_id').where({ 's.tenant_id': c.tenant_id, 's.connection_id': c.id, 's.kind': 'rest' }).select('s.entity_id', 'e.name')) as { entity_id: string; name: string }[]) out.push({ kind: 'app-entity', id: r.entity_id, name: `entity ${r.name}` });
    }
    for (const r of (await this.db('knowledge_sources as s').join('knowledge_bases as b', 'b.id', 's.kb_id').where({ 's.tenant_id': c.tenant_id, 's.kind': 'rest' }).select('s.id', 's.config', 'b.name as kb')) as { id: string; config: string; kb: string }[]) {
      if (json<{ external?: { connectionId?: string } }>(r.config, {}).external?.connectionId === c.id) out.push({ kind: 'knowledge-source', id: r.id, name: `knowledge base ${r.kb}` });
    }
    return out;
  }

  private async readable(p: Principal, ref: string): Promise<RestConnectionRow> {
    const c = await this.get(p.tenantId, ref);
    if (!clears(p.clearance, c.label)) throw notFound('REST connection');
    return c;
  }

  async listFor(p: Principal): Promise<RestConnectionRow[]> {
    return (await this.list(p.tenantId)).filter((c) => clears(p.clearance, c.label));
  }

  async saveEndpoint(p: Principal, ref: string, input: z.infer<typeof endpointCreateSchema>, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<EndpointRow> {
    const c = await this.readable(p, ref);
    // Checked here as well as at the route: a definition stored unchecked could not be read back.
    const parsed = endpointCreateSchema.safeParse(input);
    if (!parsed.success) throw new HttpProblem(422, 'Endpoint refused', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' '));
    input = parsed.data;
    const problems = [...endpointProblems(input.definition), ...protocolProblems(c, input.definition)];
    if (problems.length) throw new HttpProblem(422, 'Endpoint refused', problems.join(' '), { extensions: { problems } });
    const existing = await this.db('rest_endpoints').where({ connection_id: c.id, name: input.name }).first();
    const t = Date.now();
    let id: string;
    if (existing) {
      id = String(existing.id);
      await this.db('rest_endpoints').where({ id }).update({ title: input.title, description: input.description, lookups: input.lookups, definition: JSON.stringify(input.definition), version: Number(existing.version) + 1, updated_by: p.userId, updated_at: t });
    } else {
      id = ulid();
      await this.db('rest_endpoints').insert({ id, tenant_id: c.tenant_id, connection_id: c.id, name: input.name, title: input.title, description: input.description, lookups: input.lookups, definition: JSON.stringify(input.definition), version: 1, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t });
    }
    const e = await this.endpoint(c, id);
    await this.s().audit.append({ tenantId: p.tenantId, action: existing ? 'connection.rest.endpoint.updated' : 'connection.rest.endpoint.created', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name, endpoint: e.id, endpointName: e.name }, label: c.label, detail: { path: e.definition.path, paging: e.definition.paging.kind, fields: e.definition.mapping.fields.length, params: e.definition.params.map((x) => x.name), lookups: e.lookups, version: e.version, ...(c.protocol !== 'rest' ? { protocol: c.protocol } : {}), ...(e.definition.graphql ? { graphqlOperation: classifyGraphql(e.definition.graphql.query).name, variables: Object.keys(e.definition.graphql.variables) } : {}), ...(e.definition.soap ? { operation: e.definition.soap.operation, port: e.definition.soap.port ?? null, args: Object.keys(e.definition.soap.args), ...(writeLikeOperation(e.definition.soap.operation) ? { confirmRead: e.definition.soap.confirmRead } : {}) } : {}) }, traceId: ctx.traceId ?? null });
    return e;
  }

  async updateEndpoint(p: Principal, ref: string, endpointRef: string, input: z.infer<typeof endpointUpdateSchema>, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<EndpointRow> {
    const c = await this.readable(p, ref);
    const e = await this.endpoint(c, endpointRef);
    return this.saveEndpoint(p, c.id, { name: e.name, title: input.title !== undefined ? input.title : e.title, description: input.description !== undefined ? input.description : e.description, lookups: input.lookups ?? e.lookups, definition: input.definition ?? e.definition }, ctx);
  }

  async removeEndpoint(p: Principal, ref: string, endpointRef: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<void> {
    const c = await this.readable(p, ref);
    const e = await this.endpoint(c, endpointRef);
    const used = (await this.usedBy(c)).filter(Boolean);
    const sources = (await this.db('app_entity_sources').where({ connection_id: c.id, kind: 'rest', object: e.name }).select('entity_id')) as unknown[];
    const kbs = used.filter((u) => u.kind === 'knowledge-source');
    const kbHit: string[] = [];
    for (const k of kbs) {
      const row = await this.db('knowledge_sources').where({ id: k.id }).first('config');
      if (json<{ external?: { endpoint?: string } }>(row?.config, {}).external?.endpoint === e.name) kbHit.push(k.name);
    }
    if (sources.length || kbHit.length) throw new HttpProblem(409, 'Still in use', `${[...(sources.length ? [`${sources.length} app entit${sources.length === 1 ? 'y' : 'ies'}`] : []), ...kbHit].join(', ')} still read ${e.name}.`);
    await this.db('rest_endpoints').where({ id: e.id }).delete();
    await this.s().audit.append({ tenantId: p.tenantId, action: 'connection.rest.endpoint.removed', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name, endpoint: e.id, endpointName: e.name }, label: c.label, traceId: ctx.traceId ?? null });
  }

  // ---------- requests ----------

  /** The tenant's list, which every address must be on (the operator's rules come first). */
  private async check(tenantId: string): Promise<(address: string, host: string) => string | null> {
    const list: AllowList | null = await this.s().integrations.allowList(tenantId);
    const policy = servicePolicy(this.s().cfg);
    return (address, host) => toolAddressProblem(address, host, policy, list) ?? (!list || list.empty ? `${host} is not on this tenant's list of allowed hosts.` : tenantHostProblem(host, [address], list));
  }

  /** The connection's secret: sealed, moved to the vault, or a `vault:` reference read as whoever saved it. */
  private async secret(c: RestConnectionRow): Promise<string | null> {
    if (!c.credential) return null;
    const opened = json<{ secret?: string }>(await this.s().keys.open(c.tenant_id, c.credential, `rest-connection:${c.id}`), {}).secret ?? null;
    if (opened == null) return null;
    if (c.credential_ref && !isVaultRef(opened)) return this.s().credentialMoves.read('rest-connection', c.tenant_id, c.credential_ref, `rest-connection:${c.id}`);
    if (isVaultRef(opened)) return this.vaultValue(c, opened);
    return opened;
  }

  private async vaultValue(c: RestConnectionRow, ref: string): Promise<string> {
    try {
      return await this.s().vault.resolveFor(c.tenant_id, c.vault_owner, ref, { via: `rest-connection:${c.id}` });
    } catch (err) {
      throw new HttpProblem(409, 'Vault reference unreadable', `${ref.slice(0, 120)} could not be read as the person who saved it: ${(err as HttpProblem).detail ?? (err as Error).message}`.slice(0, 400));
    }
  }

  private async oauthToken(c: RestConnectionRow, secret: string, check: (a: string, h: string) => string | null, signal?: AbortSignal): Promise<string> {
    const key = `${c.id}:${c.version}`;
    const hit = this.tokens.get(key);
    if (hit && hit.until > Date.now()) return hit.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.auth_config.clientId ?? '', client_secret: secret, ...(c.auth_config.scope ? { scope: c.auth_config.scope } : {}) }).toString();
    const res = await guardedRequest({ method: 'POST', url: new URL(c.auth_config.tokenUrl ?? ''), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, timeoutMs: c.timeout_ms, maxBytes: 64 * 1024, check, ...(signal ? { signal } : {}) });
    if (res.status < 200 || res.status >= 300) throw new HttpProblem(502, 'Token request failed', `The token endpoint answered ${res.status}.`);
    const doc = json<{ access_token?: string; expires_in?: number; token_type?: string }>(res.body.toString('utf8'), {});
    if (!doc.access_token) throw new HttpProblem(502, 'Token request failed', 'The token endpoint answered without an access_token.');
    const ttl = Math.max(0, (Number(doc.expires_in) || 300) - 30) * 1000;
    if (this.tokens.size > 1000) this.tokens.clear();
    this.tokens.set(key, { token: doc.access_token, until: Date.now() + ttl });
    return doc.access_token;
  }

  /** Headers and query parameters of the connection's authentication and its default headers. */
  private async auth(c: RestConnectionRow, check: (a: string, h: string) => string | null, signal?: AbortSignal): Promise<{ headers: Record<string, string>; query: Record<string, string>; secrets: string[] }> {
    const headers: Record<string, string> = {};
    const query: Record<string, string> = {};
    const secrets: string[] = [];
    for (const [k, v] of Object.entries(c.default_headers)) {
      const ref = VAULT_VALUE.exec(v);
      if (ref) {
        const val = await this.vaultValue(c, ref[2]!);
        secrets.push(val);
        headers[k.toLowerCase()] = (ref[1] ?? '') + val;
      } else headers[k.toLowerCase()] = v;
    }
    const secret = c.auth_kind === 'none' ? null : await this.secret(c);
    if (secret) secrets.push(secret);
    switch (c.auth_kind) {
      case 'basic':
        headers.authorization = 'Basic ' + Buffer.from(`${c.auth_config.username ?? ''}:${secret ?? ''}`).toString('base64');
        break;
      case 'bearer':
        headers.authorization = `Bearer ${secret ?? ''}`;
        break;
      case 'api-key-header':
        headers[(c.auth_config.headerName ?? 'x-api-key').toLowerCase()] = secret ?? '';
        break;
      case 'api-key-query':
        query[c.auth_config.queryName ?? 'api_key'] = secret ?? '';
        break;
      case 'oauth2-client': {
        const token = await this.oauthToken(c, secret ?? '', check, signal);
        secrets.push(token);
        headers.authorization = `Bearer ${token}`;
        break;
      }
      default:
        break;
    }
    headers.accept ??= 'application/json';
    return { headers, query, secrets };
  }

  /** The URL of one request: base, the rendered path (kept under the base path), the query. */
  private url(c: RestConnectionRow, d: EndpointDefinition, values: Record<string, unknown>, extra: Record<string, string | number>, auth: Record<string, string>, at?: string): URL {
    const base = new URL(c.base_url);
    if (at) {
      // SOAP: the port's address from the WSDL, which must lie under the base URL.
      if (!underBase(c.base_url, at)) throw new HttpProblem(422, 'Address refused', `The operation's address is not under ${c.base_url}; it is not called.`);
      const u = new URL(at);
      for (const [k, t] of Object.entries(d.query)) u.searchParams.set(k, String(renderTemplate(t, values) ?? ''));
      for (const [k, v] of Object.entries(auth)) u.searchParams.set(k, v);
      return u;
    }
    const path = d.path.replace(PLACEHOLDER, (_m, name: string) => {
      const v = values[name];
      if (v == null) throw new HttpProblem(400, 'Invalid parameters', `${name} is needed for the path.`);
      const sv = Array.isArray(v) ? v.join(',') : String(v);
      if (sv === '.' || sv === '..' || sv === '') throw new HttpProblem(400, 'Invalid parameters', `${name} may not be empty, . or ..`);
      return encodeURIComponent(sv);
    });
    const u = new URL(base.toString().replace(/\/+$/, '') + path);
    const prefix = base.pathname.replace(/\/+$/, '');
    if (u.origin !== base.origin || (prefix && u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`))) throw new HttpProblem(400, 'Invalid parameters', 'The path leaves the connection\'s base URL.');
    for (const [k, t] of Object.entries(d.query)) {
      const names = [...t.matchAll(PLACEHOLDER)].map((m) => m[1]!);
      if (names.length && names.every((n) => values[n] == null)) continue;
      u.searchParams.set(k, t.replace(PLACEHOLDER, (_m, n: string) => (Array.isArray(values[n]) ? (values[n] as unknown[]).join(',') : String(values[n] ?? ''))));
    }
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
    for (const [k, v] of Object.entries(auth)) u.searchParams.set(k, v);
    return u;
  }

  /** One request of an endpoint in the connection's protocol (1.9.0): a GET, a GraphQL POST or a SOAP POST. */
  private request(c: RestConnectionRow, d: EndpointDefinition, values: Record<string, unknown>, extra: Record<string, string | number>, a: { headers: Record<string, string>; query: Record<string, string> }, soap: { op: SoapOperation; address: string } | null): { method: string; url: URL; headers: Record<string, string>; body?: string } {
    if (c.protocol === 'graphql' && d.graphql) {
      const variables = { ...graphqlVariables(d.graphql.variables, values), ...extra };
      return { method: 'POST', url: this.url(c, d, values, {}, a.query), headers: { ...a.headers, 'content-type': 'application/json', accept: 'application/graphql-response+json, application/json' }, body: JSON.stringify({ query: d.graphql.query, variables }) };
    }
    if (c.protocol === 'soap' && d.soap && soap) {
      const env = buildEnvelope(soap.op, soapArgs(soap.op, d.soap.args, values, extra));
      return { method: 'POST', url: this.url(c, d, values, {}, a.query, soap.address), headers: { ...a.headers, ...env.headers }, body: env.body };
    }
    if (c.protocol === 'odata' && d.odata) return { method: 'GET', url: this.odataUrl(c, d, values, extra, a.query), headers: { ...a.headers, accept: 'application/json;odata.metadata=minimal', 'odata-maxversion': '4.0' } };
    return { method: 'GET', url: this.url(c, d, values, extra, a.query), headers: a.headers };
  }

  /** OData: the entity set's URL with its query options, the parameters as literals (odata.ts), paging's $top/$skip. */
  private odataUrl(c: RestConnectionRow, d: EndpointDefinition, values: Record<string, unknown>, extra: Record<string, string | number>, auth: Record<string, string>): URL {
    const o = d.odata!;
    const set = odataSet(c.odata_meta, o.entitySet);
    if (!set) throw new HttpProblem(422, 'Endpoint refused', `${o.entitySet} is not in the connection's $metadata.`);
    const u = new URL(`${c.base_url.replace(/\/+$/, '')}/${encodeURIComponent(set.name)}`);
    if (o.select.length) u.searchParams.set('$select', o.select.join(','));
    if (o.expand.length) u.searchParams.set('$expand', o.expand.join(','));
    const types = Object.fromEntries(d.params.map((p) => [p.name, p.type]));
    if (o.filter) {
      let f: string;
      try {
        f = renderFilter(o.filter, set, values, types);
      } catch (err) {
        throw new HttpProblem(400, 'Invalid parameters', `The filter could not take its parameters: ${(err as Error).message}.`);
      }
      if (f.trim()) u.searchParams.set('$filter', f);
    }
    if (o.orderby) u.searchParams.set('$orderby', o.orderby);
    if (o.search) u.searchParams.set('$search', renderSearch(o.search, values));
    if (o.count) u.searchParams.set('$count', 'true');
    for (const [k, t] of Object.entries(d.query)) {
      const names = [...t.matchAll(PLACEHOLDER)].map((m) => m[1]!);
      if (names.length && names.every((n) => values[n] == null)) continue;
      u.searchParams.set(k, String(renderTemplate(t, values) ?? ''));
    }
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
    for (const [k, v] of Object.entries(auth)) u.searchParams.set(k, v);
    return u;
  }

  /** The JSON document of an answer, in the connection's protocol; GraphQL errors and SOAP faults as problems. */
  private answer(c: RestConnectionRow, res: GuardedResponse, method: string, host: string, soap: SoapOperation | null, warnings: string[]): unknown {
    const status = res.status;
    const statusProblem = () => new HttpProblem(502, 'Request failed', `${method} ${host} answered ${status}${status >= 300 && status < 400 ? ' (redirects are not followed)' : ''}.`);
    const text = res.body.toString('utf8');
    if (c.protocol === 'soap') {
      let doc: Record<string, unknown>;
      try {
        doc = readEnvelope(text, c.max_bytes);
      } catch (err) {
        if (err instanceof SoapFault) throw new HttpProblem(502, 'SOAP Fault', `${soap?.name ?? 'The operation'} answered with a fault${err.code ? ` (${err.code.slice(0, 100)})` : ''}: ${err.message.slice(0, 300)}`);
        if (status < 200 || status >= 300) throw statusProblem();
        throw new HttpProblem(502, 'Not SOAP', `${host} did not answer with a SOAP envelope: ${(err as Error).message.slice(0, 200)}`);
      }
      if (status < 200 || status >= 300) throw statusProblem();
      return doc;
    }
    let doc: unknown;
    let parsed = true;
    try {
      doc = JSON.parse(text) as unknown;
    } catch {
      parsed = false;
    }
    if (c.protocol === 'odata' && parsed) {
      const e = odataError(doc);
      if (e) throw new HttpProblem(502, 'OData error', `${host} answered ${status}${e.code ? ` (${e.code.slice(0, 100)})` : ''}: ${e.message.slice(0, 300)}`);
    }
    if (c.protocol === 'graphql' && parsed && doc && typeof doc === 'object') {
      const errs = (doc as { errors?: unknown }).errors;
      const data = (doc as { data?: unknown }).data;
      const first = Array.isArray(errs) && errs.length ? String((errs[0] as { message?: unknown })?.message ?? 'error').slice(0, 300) : null;
      if (first && (data === null || data === undefined)) throw new HttpProblem(502, 'GraphQL error', `${host} answered with ${(errs as unknown[]).length} error${(errs as unknown[]).length === 1 ? '' : 's'}: ${first}`);
      if (first) {
        const w = `The answer came with ${(errs as unknown[]).length} error${(errs as unknown[]).length === 1 ? '' : 's'} beside partial data: ${first}`;
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
    if (status < 200 || status >= 300) throw statusProblem();
    if (!parsed) throw new HttpProblem(502, 'Not JSON', `${host} did not answer with JSON.`);
    return doc;
  }

  /** A next-page URL from a Link header, kept under the base URL. */
  private underBase(c: RestConnectionRow, raw: string, from: URL): URL {
    const base = new URL(c.base_url);
    const u = new URL(raw, from);
    const prefix = base.pathname.replace(/\/+$/, '');
    if (u.origin !== base.origin || (prefix && u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`))) throw new HttpProblem(502, 'Next page refused', `The next page link points outside ${c.base_url}; it is not followed.`);
    if (u.username || u.password) throw new HttpProblem(502, 'Next page refused', 'The next page link carries credentials; it is not followed.');
    return u;
  }

  /**
   * Fetches mapped rows: page after page in the endpoint's paging style until `limit` rows, the last page or the
   * page cap. A cursor names the page to go on from and how many of its items were already returned.
   */
  async fetchRows(caller: RestCaller, c: RestConnectionRow, e: EndpointRow, given: Record<string, unknown> | null | undefined, opts: { limit?: number | undefined; cursor?: string | null; definition?: EndpointDefinition; signal?: AbortSignal }): Promise<RestReadResult> {
    const s = this.s();
    const d = opts.definition ?? e.definition;
    const soap = c.protocol === 'soap' && d.soap ? soapOperation(c, d.soap) : null;
    const ctx = { ip: caller.ip ?? null, traceId: caller.traceId ?? null };
    const actor: AuditActor = caller.principal ? actorFrom(caller.principal, ctx.ip) : { service: caller.via };
    const host = hostOf(c.base_url);
    const record = (action: string, detail: Record<string, unknown>) => s.audit.append({ tenantId: c.tenant_id, action, kind: caller.principal ? 'admin' : 'system', actor, target: { restConnection: c.id, name: c.name, endpoint: e.id, endpointName: e.name }, label: c.label, detail: { via: caller.via, host, ...(c.protocol !== 'rest' ? { protocol: c.protocol } : {}), ...(soap ? { operation: soap.op.name } : {}), ...detail }, traceId: ctx.traceId });
    const refuse = async (p: HttpProblem) => {
      await record('connection.rest.read.refused', { reason: (p.detail ?? p.title).slice(0, 300) });
      return p;
    };
    if (caller.principal && !clears(caller.principal.clearance, c.label)) throw await refuse(forbidden(`${c.name} is labelled ${c.label} and your clearance is ${caller.principal.clearance}.`, { step: 'clearance' }));
    if (caller.ceiling && labelRank(c.label) > labelRank(caller.ceiling)) throw await refuse(forbidden(`Blocked by label ceiling: ${c.name} is ${c.label}, above the ${caller.ceiling} it is read for.`, { step: 'label' }));
    const problems = [...endpointProblems(d), ...protocolProblems(c, d)];
    if (problems.length) throw await refuse(new HttpProblem(422, 'Endpoint refused', problems.join(' ')));
    const values = bindParams(d.params as ParamDef[], given);
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    let state = decodeCursor<PageState>(opts.cursor);
    if (state && (state.e !== e.id || state.v !== e.version)) throw await refuse(conflict(`The cursor belongs to another endpoint or version of ${e.name}; start from the first page.`));
    const paging = d.paging;
    state ??= { v: e.version, e: e.id, ...(paging.kind === 'page' ? { page: paging.start } : paging.kind === 'offset' ? { offset: 0 } : {}) };
    const check = await this.check(c.tenant_id);
    const t0 = Date.now();
    const columns: string[] = [];
    const rows: unknown[][] = [];
    let pages = 0;
    let bytes = 0;
    let status = 0;
    let next: PageState | null = null;
    let secrets: string[] = [];
    let method = 'GET';
    const warnings: string[] = [];
    try {
      const a = await this.auth(c, check, opts.signal);
      secrets = a.secrets;
      const maxPages = paging.kind === 'none' ? 1 : paging.maxPages;
      let cur: PageState | null = state;
      while (cur && pages < maxPages && rows.length < limit) {
        // Numbers stay numbers for GraphQL variables; REST writes them into the query string.
        const extra: Record<string, string | number> = {};
        if (paging.kind === 'page') {
          extra[paging.param] = cur.page ?? paging.start;
          if (paging.sizeParam) extra[paging.sizeParam] = paging.size;
        } else if (paging.kind === 'offset') {
          extra[paging.offsetParam] = cur.offset ?? 0;
          extra[paging.limitParam] = paging.size;
        } else if (paging.kind === 'cursor') {
          if (cur.cursor) extra[paging.param] = cur.cursor;
          if (paging.sizeParam) extra[paging.sizeParam] = paging.size;
        } else if (paging.kind === 'link' && paging.sizeParam && !cur.url) extra[paging.sizeParam] = paging.size;
        const req = paging.kind === 'link' && cur.url ? { method: 'GET', url: this.underBase(c, cur.url, new URL(c.base_url)), headers: c.protocol === 'odata' ? { ...a.headers, accept: 'application/json;odata.metadata=minimal', 'odata-maxversion': '4.0' } : a.headers } : this.request(c, d, values, extra, a, soap);
        const url: URL = req.url;
        method = req.method;
        let res: GuardedResponse;
        try {
          res = await guardedRequest({ method: req.method, url, headers: req.headers, ...('body' in req && req.body !== undefined ? { body: req.body } : {}), timeoutMs: c.timeout_ms, maxBytes: c.max_bytes, check, ...(opts.signal ? { signal: opts.signal } : {}) });
        } catch (err) {
          if (err instanceof ServiceUrlRefused) {
            const capped = /larger than|No answer within/.test(err.message);
            throw new HttpProblem(capped ? 502 : 422, capped ? 'Request failed' : 'Host refused', err.message);
          }
          throw err;
        }
        pages++;
        status = res.status;
        bytes += res.body.length;
        // An answer cut at the cap arrives short of its declared length: it is refused, never read as a whole.
        const declared = Number(res.headers['content-length'] ?? NaN);
        if (Number.isFinite(declared) && (declared > c.max_bytes || declared > res.body.length)) throw new HttpProblem(502, 'Request failed', `The answer is larger than ${Math.round(c.max_bytes / 1024)} KB.`);
        const doc = this.answer(c, res, req.method, host, soap?.op ?? null, warnings);
        // OData: an entity set's items are in `value` unless the mapping says otherwise; a singleton is the answer.
        const itemsAt = c.protocol === 'odata' && !d.mapping.items && odataSet(c.odata_meta, d.odata?.entitySet ?? '')?.kind === 'set' ? '/value' : d.mapping.items;
        const at = valueAt(doc, itemsAt);
        const raw = Array.isArray(at) ? at : at && typeof at === 'object' ? [at] : at === undefined ? null : [];
        // OData control information (@odata.context, @odata.etag, …) is not data.
        const items = raw && c.protocol === 'odata' ? raw.map((it) => (it && typeof it === 'object' && !Array.isArray(it) ? Object.fromEntries(Object.entries(it as Record<string, unknown>).filter(([k]) => !k.startsWith('@odata.'))) : it)) : raw;
        if (items === null) throw new HttpProblem(502, 'Mapping found nothing', `The answer has nothing at ${itemsAt || 'its root'}.`);
        const m = mapItems(items, d.mapping);
        if (!columns.length) columns.push(...m.columns);
        const skip = cur.skip ?? 0;
        const want = limit - rows.length;
        const fresh = m.rows.slice(skip).map((r) => columns.map((col) => r[m.columns.indexOf(col)] ?? null));
        rows.push(...fresh.slice(0, want));
        // What comes after this page.
        let after: PageState | null = null;
        if (paging.kind === 'page') after = items.length >= paging.size ? { ...cur, page: (cur.page ?? paging.start) + 1, skip: 0 } : null;
        else if (paging.kind === 'offset') after = items.length >= paging.size ? { ...cur, offset: (cur.offset ?? 0) + items.length, skip: 0 } : null;
        else if (paging.kind === 'cursor') {
          const n = valueAt(doc, paging.next);
          // 1.9.0: a `hasNext` pointer (GraphQL's pageInfo.hasNextPage) ends the paging when it is false.
          const more = paging.hasNext ? !!valueAt(doc, paging.hasNext) : true;
          after = more && n != null && n !== '' && items.length ? { ...cur, cursor: String(n), skip: 0 } : null;
        } else if (paging.kind === 'link') {
          // OData: server-driven paging by `@odata.nextLink` in the body; REST: the Link header.
          const odataNext = c.protocol === 'odata' && doc && typeof doc === 'object' ? (doc as Record<string, unknown>)['@odata.nextLink'] : undefined;
          const link = c.protocol === 'odata' ? (typeof odataNext === 'string' && odataNext ? odataNext : null) : nextLink(res.headers.link);
          after = link && items.length ? { ...cur, url: this.underBase(c, link, url).toString(), skip: 0 } : null;
        }
        if (fresh.length > want) {
          next = { ...cur, skip: skip + want };
          cur = null;
        } else {
          next = after;
          cur = after;
        }
      }
    } catch (err) {
      const raw = err instanceof HttpProblem ? err : new HttpProblem(502, 'Request failed', scrubError(err, secrets).slice(0, 300));
      // Nothing the answer or a driver said may carry the secret back out.
      const p = raw.detail ? new HttpProblem(raw.status, raw.title, scrubError(new Error(raw.detail), secrets), { extensions: raw.extensions }) : raw;
      await record(p.status < 500 ? 'connection.rest.read.refused' : 'connection.rest.read.failed', { status, pages, error: (p.detail ?? p.title).slice(0, 300) });
      await this.db('rest_connections').where({ id: c.id }).update({ health: p.status < 500 ? c.health : 'unreachable', health_detail: (p.detail ?? p.title).slice(0, 300), checked_at: Date.now() });
      throw p;
    }
    // The untrusted-content checkpoint, before any model, workflow, base or app reads these rows.
    const text = JSON.stringify(rows);
    const verdict = await s.injection.screen({ tenantId: c.tenant_id, workspaceId: caller.principal?.workspaceId ?? null, ...(caller.principal ? { principal: caller.principal } : {}), label: c.label, source: 'http', ref: e.id, name: `${c.name}.${e.name}`, text, meta: { connection: c.name, endpoint: e.name, via: caller.via } });
    if (verdict.action === 'block') {
      await record('connection.rest.read.refused', { status, pages, rows: rows.length, reason: 'untrusted-content', rule: verdict.rule });
      throw new HttpProblem(422, 'Withheld: untrusted content', `The answer of ${c.name}.${e.name} tries to instruct a model${verdict.rule ? ` (${verdict.rule})` : ''}; its rows are withheld.`, { extensions: { step: 'guardrail', checkpoint: 'untrusted-content' } });
    }
    let kept = rows;
    if (verdict.text !== text) {
      try {
        kept = JSON.parse(verdict.text) as unknown[][];
      } catch {
        throw new HttpProblem(422, 'Withheld: untrusted content', 'A guardrail changed the answer so that it no longer reads as rows.');
      }
    }
    const ms = Date.now() - t0;
    await record('connection.rest.read', { status, pages, rows: kept.length, bytes, ms, truncated: !!next, ...(warnings.length ? { warnings: warnings.length } : {}), ...(verdict.detected ? { untrusted: verdict.action, rule: verdict.rule } : {}) });
    await this.db('rest_connections').where({ id: c.id }).update({ health: 'healthy', health_detail: `${method} answered ${status}`, checked_at: Date.now() });
    return { columns: columnTypes(columns, kept), rows: asObjects(columns, kept), truncated: !!next, ...(next ? { nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url') } : {}), label: c.label, masked: [], ms, pages, ...(warnings.length ? { warnings: warnings.map((w) => scrubError(new Error(w), secrets)) } : {}), ...(verdict.detected && verdict.action === 'annotate' ? { untrusted: { action: 'annotate' as const, rule: verdict.rule } } : {}) };
  }

  /**
   * B-129's entry point and the read API: an endpoint read as `principal`, who needs `connections:query` and
   * clearance for the connection's label.
   */
  async read(principal: Principal, connectionId: string, endpointName: string, params: Record<string, unknown> | null | undefined, opts: { limit?: number; cursor?: string | null; ceiling?: Label | null; via?: string; ip?: string | null; traceId?: string | null } = {}): Promise<RestReadResult> {
    const d = authorize(principal, 'connections:query', { tenantId: principal.tenantId });
    if (!d.allow) throw forbidden(`${principal.displayName} may not read REST connections: ${d.reason}.`, { step: d.step });
    const c = await this.get(principal.tenantId, connectionId).catch(() => null);
    if (!c || !clears(principal.clearance, c.label)) throw notFound('REST connection');
    const e = await this.endpoint(c, endpointName);
    return this.fetchRows({ tenantId: principal.tenantId, principal, ceiling: opts.ceiling ?? null, via: opts.via ?? 'api', ip: opts.ip ?? null, traceId: opts.traceId ?? null }, c, e, params, { limit: opts.limit, cursor: opts.cursor ?? null });
  }

  /** The endpoint editor's test call (connections:manage): the saved endpoint or an unsaved definition. */
  async testEndpoint(p: Principal, ref: string, endpointRef: string | null, definition: EndpointDefinition | null, params: Record<string, unknown> | null | undefined, opts: { limit?: number; ip?: string | null; traceId?: string | null } = {}): Promise<RestReadResult> {
    const c = await this.readable(p, ref);
    const e: EndpointRow = endpointRef ? await this.endpoint(c, endpointRef) : { id: 'draft', tenant_id: c.tenant_id, connection_id: c.id, name: 'draft', title: null, description: null, definition: definition!, lookups: false, version: 0, created_by: p.userId, updated_by: p.userId, created_at: Date.now(), updated_at: Date.now() };
    return this.fetchRows({ tenantId: p.tenantId, principal: p, via: 'test', ip: opts.ip ?? null, traceId: opts.traceId ?? null }, c, e, params, { limit: Math.min(opts.limit ?? 20, 200), cursor: null, ...(definition ? { definition } : {}) });
  }

  /** A connection test: authentication (an OAuth2 token) and a GET of the base URL, through the same guard. */
  async test(p: Principal, ref: string, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<{ ok: boolean; status: number | null; ms: number; detail: string; health: RestConnectionRow['health'] }> {
    const c = await this.readable(p, ref);
    const check = await this.check(c.tenant_id);
    const t0 = Date.now();
    let out: { ok: boolean; status: number | null; ms: number; detail: string; health: RestConnectionRow['health'] };
    let secrets: string[] = [];
    try {
      const a = await this.auth(c, check);
      secrets = a.secrets;
      const empty: EndpointDefinition = { path: '', params: [], query: {}, paging: { kind: 'none' }, mapping: { items: '', fields: [] } };
      const tokenNote = c.auth_kind === 'oauth2-client' ? '; the token endpoint issued a token' : '';
      if (c.protocol === 'graphql') {
        // The smallest query there is.
        const res = await guardedRequest({ method: 'POST', url: this.url(c, empty, {}, {}, a.query), headers: { ...a.headers, 'content-type': 'application/json', accept: 'application/graphql-response+json, application/json' }, body: JSON.stringify({ query: '{ __typename }' }), timeoutMs: c.timeout_ms, maxBytes: c.max_bytes, check });
        const doc = json<{ data?: { __typename?: string } }>(res.body.toString('utf8'), {});
        const typed = typeof doc.data?.__typename === 'string';
        out = { ok: res.status < 500, status: res.status, ms: Date.now() - t0, detail: `POST { __typename } to ${hostOf(c.base_url)} answered ${res.status}${typed ? ` with ${doc.data!.__typename}` : ', without data'}${tokenNote}.`, health: res.status < 400 && typed ? 'healthy' : res.status < 500 ? 'degraded' : 'unreachable' };
      } else if (c.protocol === 'odata') {
        const u = new URL(`${c.base_url.replace(/\/+$/, '')}/$metadata`);
        for (const [k, v] of Object.entries(a.query)) u.searchParams.set(k, v);
        const res = await guardedRequest({ method: 'GET', url: u, headers: { ...a.headers, accept: 'application/xml', 'odata-maxversion': '4.0' }, timeoutMs: c.timeout_ms, maxBytes: MAX_METADATA_BYTES, check });
        let readable = false;
        try {
          readable = res.status < 300 && parseMetadata(res.body.toString('utf8')).sets.length > 0;
        } catch {
          readable = false;
        }
        out = { ok: res.status < 500, status: res.status, ms: Date.now() - t0, detail: `GET ${hostOf(c.base_url)}/$metadata answered ${res.status}${readable ? ', and it reads as OData v4 metadata' : ''}${tokenNote}.`, health: res.status < 400 && readable ? 'healthy' : res.status < 500 ? 'degraded' : 'unreachable' };
      } else {
        // REST: a GET of the base URL. SOAP: the same; a SOAP service may refuse a GET, so any answer shows it is reachable.
        const res = await guardedRequest({ method: 'GET', url: this.url(c, empty, {}, {}, a.query), headers: a.headers, timeoutMs: c.timeout_ms, maxBytes: c.max_bytes, check });
        const ok = c.protocol === 'soap' ? true : res.status < 500;
        out = { ok, status: res.status, ms: Date.now() - t0, detail: `GET ${hostOf(c.base_url)} answered ${res.status}${tokenNote}.`, health: res.status < 400 ? 'healthy' : ok ? 'degraded' : 'unreachable' };
      }
    } catch (err) {
      out = { ok: false, status: null, ms: Date.now() - t0, detail: scrubError(err instanceof HttpProblem ? new Error(err.detail ?? err.title) : err, secrets).slice(0, 300), health: 'unreachable' };
    }
    await this.db('rest_connections').where({ id: c.id }).update({ health: out.health, health_detail: out.detail, checked_at: Date.now() });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'connection.rest.tested', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { restConnection: c.id, name: c.name }, label: c.label, detail: { ok: out.ok, status: out.status, health: out.health, ms: out.ms }, traceId: ctx.traceId ?? null });
    return out;
  }

  // ---------- sources ----------

  /** Rows of an endpoint for an app entity pulled from it (read-only), as arrays, held to the entity's label. */
  async rowsForApp(tenantId: string, connectionId: string, endpoint: string, params: Record<string, unknown>, opts: { limit: number; ceiling: Label }): Promise<{ columns: string[]; rows: unknown[][]; capped: boolean; label: Label }> {
    const c = await this.get(tenantId, connectionId);
    const e = await this.endpoint(c, endpoint);
    const r = await this.fetchRows({ tenantId, principal: null, ceiling: opts.ceiling, via: 'apps.source' }, c, e, params, { limit: opts.limit });
    const columns = r.columns.map((x) => x.name);
    return { columns, rows: r.rows.map((row) => columns.map((k) => row[k] ?? null)), capped: r.truncated, label: c.label };
  }

  private readonly optionCache = new Map<string, { at: number; options: { value: string; label: string }[] }>();

  /** Options for an app lookup from an endpoint field: an endpoint marked for lookups, at most at the entity's label. */
  async lookupOptions(p: Principal | null, tenantId: string, connectionRef: string, endpoint: string, o: { valueField: string; labelField?: string | null; params?: Record<string, unknown> | null; ceiling: Label }): Promise<{ value: string; label: string }[]> {
    const c = await this.get(tenantId, connectionRef).catch(() => null);
    if (!c || (p && !clears(p.clearance, c.label))) throw notFound('REST connection');
    const e = await this.endpoint(c, endpoint);
    if (!e.lookups) throw conflict(`${c.name}.${e.name} is not offered to app lookups; a connections manager turns that on.`);
    const key = `${tenantId}:${e.id}:${e.version}:${JSON.stringify(o)}`;
    const hit = this.optionCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.options;
    const r = await this.fetchRows({ tenantId, principal: p, ceiling: o.ceiling, via: 'lookup' }, c, e, o.params ?? {}, { limit: 500 });
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const row of r.rows) {
      const v = row[o.valueField];
      if (v == null || seen.has(String(v))) continue;
      seen.add(String(v));
      options.push({ value: String(v).slice(0, 500), label: String((o.labelField ? row[o.labelField] : null) ?? v).slice(0, 500) });
    }
    if (this.optionCache.size > 500) this.optionCache.clear();
    this.optionCache.set(key, { at: Date.now(), options });
    return options;
  }
}
