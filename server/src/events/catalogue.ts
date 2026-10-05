import { Ajv, type ValidateFunction } from 'ajv';
import client from 'prom-client';
import type { Registry } from 'prom-client';
import { LABELS } from '../authz/labels.js';

/*
 * The event catalogue (B-2001). Every event Exprsn-AI emits to webhooks (and, from B-2003, to plugins) has a type, an
 * envelope and a data schema. Types come in two kinds:
 *
 * - named events: job states, flags, approvals, plugin lifecycle and, reserved for the domains of B-22 to B-27,
 *   records, files, groups, messages and posts. Each has its own data schema and version.
 * - audit actions: every append to a tenant's audit chain is also an event whose type is the action name
 *   (`user.created`, `webhook.updated`…). They share one data schema, the audit entry.
 *
 * The catalogue is versioned: `CATALOGUE_VERSION` moves when a type is added or a schema changes, and each type
 * carries its own `version`, which only moves when its data schema changes incompatibly (a new optional field does not
 * move it). Reserved types are published so receivers can prepare; they are not emitted until their domain ships.
 */

export const CATALOGUE_VERSION = 3;

export type JsonSchema = Record<string, unknown>;

export interface EventGroup {
  pattern: string;
  description: string;
}

export interface EventType {
  type: string;
  group: string;
  version: number;
  /** The release that first emitted (or reserved) the type. */
  since: string;
  /** `emitted` today, or `reserved` for a domain that has not shipped yet. */
  status: 'emitted' | 'reserved';
  description: string;
  data: JsonSchema;
}

/** The groups a webhook or plugin subscribes to (a name, a prefix ending in `.*`, or `*`). */
export const EVENT_GROUPS: EventGroup[] = [
  { pattern: '*', description: 'Every event below' },
  { pattern: 'job.*', description: 'Job states: job.succeeded, job.failed, job.cancelled' },
  { pattern: 'flag.*', description: 'Guardrail flags: created, confirmed, dismissed, approved, rejected, escalated, reassigned, breached, reopened' },
  { pattern: 'approval.*', description: 'Approvals requested by agent runs and workflows' },
  { pattern: 'workflow.*', description: 'Workflow runs and approvals (audit actions)' },
  { pattern: 'agent.*', description: 'Agent runs and tool-call approvals (audit actions)' },
  { pattern: 'user.*', description: 'Accounts created, synced and disabled (audit actions)' },
  { pattern: 'auth.*', description: 'Sign-ins and second factors (audit actions)' },
  { pattern: 'authz.*', description: 'Authorisation denials (audit actions)' },
  { pattern: 'chat.*', description: 'Chat failures and shares (audit actions)' },
  { pattern: 'conversation.*', description: 'Conversation shares, exports and deletions (audit actions)' },
  { pattern: 'billing.*', description: 'Statements and price books (audit actions)' },
  { pattern: 'webhook.*', description: 'Changes to webhooks themselves (audit actions)' },
  // 1.4.0 (B-2001)
  { pattern: 'plugin.*', description: 'Plugin installs, lifecycle transitions and grants; since Sprint 25 also plugin.audited, plugin.action.refused, plugin.call.refused and plugin.throttled (audit actions)' },
  // 1.4.0, Sprint 25 (B-1608 to B-1611)
  { pattern: 'atproto.*', description: 'AT-Protocol identities, key rotations, labels published and withdrawn, trusted labelers and rejected inbound labels; since Sprint 27 firehose subscriptions created, updated, started, stopped and deleted (atproto.firehose.*) (audit actions)' },
  { pattern: 'record.*', description: 'Low-code app records (Sprint 27): created, updated, deleted, transitioned' },
  // 1.4.0, Sprint 27 (B-2201 to B-2208)
  { pattern: 'app.*', description: 'Low-code apps: apps, entities, record changes, imports and exports, forms and public submissions, triggers fired and skipped, AI fields, bundles and drafts (audit actions; never record values)' },
  { pattern: 'file.*', description: 'File store (Sprint 26d): uploaded, updated, deleted (to the trash), restored, shared; and audit actions for uploads received, versions ready or rejected, downloads, shares, trash, purges and quotas' },
  { pattern: 'group.*', description: 'Groups and their members (reserved until B-25)' },
  { pattern: 'message.*', description: 'Messaging: sent, edited, deleted (reserved until B-26)' },
  { pattern: 'post.*', description: 'Workspace feed posts: created, updated, deleted, held (reserved until B-27)' },
  // 1.4.0, Sprint 26 (B-1901 to B-1907)
  { pattern: 'moderation.*', description: 'Moderation checks, reports, actions on objects, appeals, sanctions, review queues, providers and dead letters (audit actions; never the content)' },
  // 1.4.0, Sprint 25c (B-1704 to B-1706)
  { pattern: 'vault.*', description: 'Secrets vault: secrets, transit keys, policies, database leases and rotation notices (audit actions; never values)' }
];

const id26 = { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' };
const str = (max = 200) => ({ type: 'string', maxLength: max });
const nullable = (s: JsonSchema) => ({ anyOf: [s, { type: 'null' }] });
const obj = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties), extra = false): JsonSchema => ({ type: 'object', properties, required, additionalProperties: extra });
const label = { type: 'string', enum: [...LABELS] };
const ms = { type: 'integer', minimum: 0 };

const job = obj({ id: str(64), type: str(120), state: { type: 'string', enum: ['succeeded', 'failed', 'cancelled'] }, error: nullable({ type: 'string' }) });
const flag = obj({ flag: { type: 'string', pattern: '^F-\\d+$' }, id: str(64), action: str(40), severity: str(40), checkpoint: str(60) });
const approval = {
  oneOf: [
    obj({ kind: { const: 'workflow' }, workflow: str(64), run: str(64), step: str(120), role: str(60), dueAt: nullable(ms) }),
    obj({ kind: { const: 'agent' }, run: str(64), agent: str(200) })
  ]
};
// Domain events (files emitted since Sprint 26d, records since Sprint 27, the others reserved): ids and names only; content stays in the
// tenant, sealed, and is fetched through the API.
const record = (extra: Record<string, JsonSchema> = {}) => obj({ app: id26, entity: str(120), record: id26, workspace: nullable(id26), actor: nullable(id26), ...extra });
const file = (extra: Record<string, JsonSchema> = {}) => obj({ file: id26, folder: nullable(id26), workspace: id26, version: { type: 'integer', minimum: 1 }, actor: nullable(id26), ...extra });
const group = (extra: Record<string, JsonSchema> = {}) => obj({ group: id26, workspace: id26, actor: nullable(id26), ...extra });
const message = (extra: Record<string, JsonSchema> = {}) => obj({ conversation: id26, message: id26, actor: nullable(id26), ...extra });
const post = (extra: Record<string, JsonSchema> = {}) => obj({ post: id26, feed: { type: 'string', enum: ['workspace', 'group', 'user'] }, workspace: id26, group: nullable(id26), actor: nullable(id26), ...extra });

const flagActions: [string, string][] = [
  ['created', 'A rule, a fail-open decision or a report raised a flag'],
  ['confirmed', 'A reviewer confirmed a flag'],
  ['dismissed', 'A reviewer dismissed a flag'],
  ['approved', 'A reviewer approved a held prompt or answer'],
  ['rejected', 'A reviewer rejected a held prompt or answer'],
  ['escalated', 'A flag moved up a review level'],
  ['reassigned', 'A flag was handed to another reviewer'],
  ['breached', 'A flag passed its review deadline'],
  ['eval', 'A flag was added to an evaluation set'],
  // 1.4.0, Sprint 26 (B-1903)
  ['reopened', 'An upheld appeal put a decided flag back in the queue']
];

export const EVENT_TYPES: EventType[] = [
  ...(['succeeded', 'failed', 'cancelled'] as const).map((st) => ({ type: `job.${st}`, group: 'job.*', version: 1, since: '1.1.0', status: 'emitted' as const, description: `A job ${st}`, data: job })),
  ...flagActions.map(([a, d]) => ({ type: `flag.${a}`, group: 'flag.*', version: 1, since: '1.1.0', status: 'emitted' as const, description: d, data: flag })),
  { type: 'approval.requested', group: 'approval.*', version: 1, since: '1.1.0', status: 'emitted', description: 'An agent run or a workflow waits for an approval', data: approval },
  { type: 'record.created', group: 'record.*', version: 1, since: '1.4.0', status: 'emitted', description: 'A record was created', data: record() },
  { type: 'record.updated', group: 'record.*', version: 1, since: '1.4.0', status: 'emitted', description: 'A record was updated', data: record({ fields: { type: 'array', items: str(120), maxItems: 500 } }) },
  { type: 'record.deleted', group: 'record.*', version: 1, since: '1.4.0', status: 'emitted', description: 'A record was deleted', data: record() },
  { type: 'record.transitioned', group: 'record.*', version: 1, since: '1.4.0', status: 'emitted', description: "A record moved through its entity's state machine", data: record({ from: str(60), to: str(60) }) },
  { type: 'file.uploaded', group: 'file.*', version: 1, since: '1.4.0', status: 'emitted', description: 'A file passed quarantine and was stored', data: file() },
  { type: 'file.updated', group: 'file.*', version: 1, since: '1.4.0', status: 'emitted', description: 'A new version of a file was stored', data: file() },
  { type: 'file.deleted', group: 'file.*', version: 1, since: '1.4.0', status: 'emitted', description: 'A file went to the trash', data: file() },
  { type: 'file.restored', group: 'file.*', version: 1, since: '1.4.0', status: 'emitted', description: 'A file version was restored (and scanned again)', data: file({ from: { type: 'integer', minimum: 1 } }) },
  { type: 'file.shared', group: 'file.*', version: 1, since: '1.4.0', status: 'emitted', description: 'A file was shared with a user, group, workspace or link', data: file({ with: { type: 'string', enum: ['user', 'group', 'workspace', 'link'] } }) },
  { type: 'group.created', group: 'group.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A group was created', data: group() },
  { type: 'group.updated', group: 'group.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A group was changed', data: group() },
  { type: 'group.deleted', group: 'group.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A group was deleted', data: group() },
  { type: 'group.member.added', group: 'group.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A user joined a group', data: group({ user: id26, role: str(40) }) },
  { type: 'group.member.removed', group: 'group.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A user left or was removed from a group', data: group({ user: id26 }) },
  { type: 'message.sent', group: 'message.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A message was sent', data: message({ thread: nullable(id26) }) },
  { type: 'message.edited', group: 'message.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A message was edited', data: message() },
  { type: 'message.deleted', group: 'message.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A message was deleted', data: message() },
  { type: 'post.created', group: 'post.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A post was published', data: post() },
  { type: 'post.updated', group: 'post.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A post was edited', data: post() },
  { type: 'post.deleted', group: 'post.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A post was deleted', data: post() },
  { type: 'post.held', group: 'post.*', version: 1, since: '1.4.0', status: 'reserved', description: 'A post waits in the flag queue before publishing', data: post({ flag: { type: 'string', pattern: '^F-\\d+$' } }) }
];

/** Audit actions: the data is the audit entry (without the tenant's content, which audit entries never carry). */
export const AUDIT_EVENT: Omit<EventType, 'type' | 'group'> & { pattern: string } = {
  pattern: '<audit action>',
  version: 1,
  since: '1.1.0',
  status: 'emitted',
  description: "Every other type is an audit action: the event is the tenant's audit entry. A change audited under the name of a named type (a reviewer confirming a flag appends flag.confirmed) is delivered twice, once with each data shape; tell them apart by data.hash, which only audit entries carry",
  data: obj(
    {
      seq: { type: 'integer', minimum: 1 },
      action: str(200),
      kind: str(40),
      actor: obj({ user: nullable(str(64)), username: nullable(str(320)), service: nullable(str(120)) }),
      target: { type: 'object' },
      detail: nullable({ type: 'object' }),
      decision: nullable({ type: 'object' }),
      traceId: nullable(str(64)),
      hash: { type: 'string', pattern: '^[0-9a-f]{64}$' }
    },
    ['seq', 'action', 'kind', 'actor', 'target', 'hash']
  )
};

/** The body of every delivery: what `WebhookService.queue` sends. */
export const ENVELOPE: JsonSchema = obj({
  id: str(120),
  type: { type: 'string', pattern: '^[a-z][a-z0-9_-]*(\\.[a-z0-9_-]+)*$', maxLength: 120 },
  tenant: str(64),
  label,
  createdAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' },
  data: { type: 'object' }
});

const byType = new Map(EVENT_TYPES.map((t) => [t.type, t]));

/** The catalogue entry for a type: a named event, or the audit-action schema for anything else. */
export function entryFor(type: string): { type: string; version: number; status: EventType['status']; data: JsonSchema; audit: boolean } {
  const named = byType.get(type);
  if (named) return { type, version: named.version, status: named.status, data: named.data, audit: false };
  return { type, version: AUDIT_EVENT.version, status: 'emitted', data: AUDIT_EVENT.data, audit: true };
}

/** Does a subscription pattern name something in the catalogue (a group, a named type, or a prefix of one)? */
export function knownPattern(pattern: string): boolean {
  if (pattern === '*') return true;
  if (EVENT_GROUPS.some((g) => g.pattern === pattern)) return true;
  if (byType.has(pattern)) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return EVENT_TYPES.some((t) => t.type.startsWith(prefix)) || EVENT_GROUPS.some((g) => g.pattern !== '*' && prefix.startsWith(g.pattern.slice(0, -1)));
  }
  // An exact audit action under a known group (`webhook.created`).
  return EVENT_GROUPS.some((g) => g.pattern.endsWith('.*') && pattern.startsWith(g.pattern.slice(0, -1)));
}

/** The catalogue as served at `GET /api/events/catalogue`. */
export function catalogue() {
  return {
    version: CATALOGUE_VERSION,
    envelope: ENVELOPE,
    groups: EVENT_GROUPS,
    types: EVENT_TYPES.map((t) => ({ type: t.type, group: t.group, version: t.version, since: t.since, status: t.status, description: t.description, schema: t.data })),
    auditActions: { version: AUDIT_EVENT.version, since: AUDIT_EVENT.since, description: AUDIT_EVENT.description, schema: AUDIT_EVENT.data }
  };
}

const ajv = new Ajv({ strict: false, allErrors: true });
const compiled = new Map<JsonSchema, ValidateFunction>();
const validator = (schema: JsonSchema): ValidateFunction => {
  let v = compiled.get(schema);
  if (!v) {
    v = ajv.compile(schema);
    compiled.set(schema, v);
  }
  return v;
};

export interface EventEnvelope {
  id: string;
  type: string;
  tenant: string;
  label: string;
  createdAt: string;
  data: Record<string, unknown>;
}

/** Validates an event (envelope and data) against the catalogue; returns the problems, empty when it conforms. */
export function validateEvent(e: unknown): string[] {
  const env = validator(ENVELOPE);
  if (!env(e)) return (env.errors ?? []).map((x) => `envelope${x.instancePath} ${x.message ?? 'is invalid'}`);
  const ev = e as EventEnvelope;
  const entry = entryFor(ev.type);
  const v = validator(entry.data);
  if (v(ev.data)) return [];
  const problems = (v.errors ?? []).map((x) => `${ev.type} data${x.instancePath} ${x.message ?? 'is invalid'}`);
  // A change that is audited under the same name as a named event (a reviewer confirming a flag appends
  // `flag.confirmed`) is also delivered as an audit action: the audit entry is valid data for that type too.
  if (!entry.audit && validator(AUDIT_EVENT.data)(ev.data)) return [];
  return problems;
}

/**
 * The catalogue at run time: every event the webhook fan-out sees is checked. A mismatch never stops a delivery (the
 * receiver still gets what happened); it is counted in `exprsn_event_schema_violations_total` and logged, so a schema
 * that drifted from the code shows up in the dashboards and the test suite.
 */
export class EventCatalogue {
  readonly violations: client.Counter<'type'>;
  readonly checked: client.Counter<'kind'>;

  constructor(registry: Registry, private readonly onViolation: (type: string, problems: string[]) => void = () => undefined) {
    const existing = registry.getSingleMetric('exprsn_event_schema_violations_total') as client.Counter<'type'> | undefined;
    this.violations = existing ?? new client.Counter({ name: 'exprsn_event_schema_violations_total', help: 'Emitted events that did not match their catalogue schema', labelNames: ['type'], registers: [registry] });
    this.checked = (registry.getSingleMetric('exprsn_events_emitted_total') as client.Counter<'kind'> | undefined) ?? new client.Counter({ name: 'exprsn_events_emitted_total', help: 'Events checked against the catalogue, by kind', labelNames: ['kind'], registers: [registry] });
  }

  check(e: EventEnvelope): string[] {
    const problems = validateEvent(e);
    this.checked.inc({ kind: entryFor(e.type).audit ? 'audit' : 'named' });
    if (problems.length) {
      this.violations.inc({ type: e.type.slice(0, 120) });
      this.onViolation(e.type, problems);
    }
    return problems;
  }
}
