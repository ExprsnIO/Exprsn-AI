import { actorFrom, type AuditActor, type AuditEvent } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { Services } from '../services.js';

/*
 * 1.9.99-final, Sprint 57 (B-10701): the `cloud.*` audit events of the deployment engine, written through one helper
 * so every entry has the same shape: the deployment, the resource key and provider id where there is one, the
 * journal step (`operation`) and the provider's request id. Every resource Exprsn-AI creates is traced to the audit
 * entry and the journal step that created it (`cloud_resources.created_audit`, `created_op`; the journal row carries
 * the audit id back).
 *
 * The lifecycle work (drift decisions, destroys, rollback, the orphan sweep) and the budgets (overrides) write their
 * events through `cloudAudit` too. No entry ever carries a secret or a credential.
 */

/** The events this engine writes; others may add `cloud.*` names of their own. */
export const CLOUD_AUDIT_ACTIONS = [
  'cloud.deployment.created',
  'cloud.deployment.updated',
  'cloud.deployment.degraded',
  'cloud.deployment.ready',
  'cloud.plan.created',
  'cloud.plan.refused',
  'cloud.apply.started',
  'cloud.apply.succeeded',
  'cloud.apply.failed',
  'cloud.apply.cancelled',
  'cloud.resource.created',
  'cloud.resource.adopted',
  'cloud.resource.updated',
  'cloud.resource.replaced',
  'cloud.resource.deleted',
  'cloud.resource.failed',
  'cloud.verify.passed',
  'cloud.verify.failed',
  // Written by the lifecycle work and the budgets through this helper:
  'cloud.drift.detected',
  'cloud.drift.decided',
  'cloud.destroy.requested',
  'cloud.destroy.approved',
  'cloud.destroy.finished',
  'cloud.rollback.started',
  'cloud.rollback.finished',
  'cloud.orphan.found',
  'cloud.budget.override',
  // Sprint 60 (B-10401, B-10405): GPU pools (`cloud/gpu-enrol.ts`, the apply engine's capacity fallback).
  'cloud.gpu.pool.linked',
  'cloud.gpu.enrolment.minted',
  'cloud.gpu.node.enrolled',
  'cloud.gpu.node.refused',
  'cloud.gpu.capacity.fallback'
] as const;
export type CloudAuditAction = (typeof CLOUD_AUDIT_ACTIONS)[number];

/** Who acted: a person (through a route), or a cloud job acting for the person who started it. */
export type CloudAuditActor =
  | { principal: Principal; ip: string | null; traceId?: string }
  | { service: string; onBehalfOf?: string | null; jobId?: string | null; traceId?: string };

export interface CloudAuditInput {
  tenantId: string;
  action: CloudAuditAction | `cloud.${string}`;
  actor: CloudAuditActor;
  deploymentId?: string | null;
  deploymentName?: string | null;
  /** The resource key, its type and provider id, when the event is about one resource. */
  resource?: { key: string; type?: string; providerId?: string | null } | null;
  planId?: string | null;
  /** The journal step (`cloud_operations.id`) the event belongs to. */
  operationId?: string | null;
  /** The provider's request id (B-10701): every event about a provider call carries it when the provider sent one. */
  providerRequestId?: string | null;
  label?: Label;
  detail?: Record<string, unknown>;
}

function actorOf(a: CloudAuditActor): { actor: AuditActor; traceId?: string } {
  if ('principal' in a) return { actor: actorFrom(a.principal, a.ip), ...(a.traceId ? { traceId: a.traceId } : {}) };
  return { actor: { service: a.service, ...(a.onBehalfOf ? { user: a.onBehalfOf } : {}) }, ...(a.traceId ? { traceId: a.traceId } : {}) };
}

/** Writes one `cloud.*` event to the tenant's audit chain and returns it (its id goes into the journal and the graph). */
export async function cloudAudit(s: Services, input: CloudAuditInput): Promise<AuditEvent> {
  const { actor, traceId } = actorOf(input.actor);
  const target: Record<string, unknown> = {};
  if (input.deploymentId) target.deployment = input.deploymentId;
  if (input.deploymentName) target.name = input.deploymentName;
  if (input.resource) {
    target.resource = input.resource.key;
    if (input.resource.type) target.type = input.resource.type;
    if (input.resource.providerId) target.providerId = input.resource.providerId;
  }
  if (input.planId) target.plan = input.planId;
  const detail: Record<string, unknown> = { ...(input.detail ?? {}) };
  if (input.operationId) detail.operation = input.operationId;
  if (input.providerRequestId) detail.providerRequestId = input.providerRequestId;
  if (!('principal' in input.actor) && input.actor.jobId) detail.job = input.actor.jobId;
  return s.audit.append({ tenantId: input.tenantId, action: input.action, kind: 'admin', actor, target, detail, ...(input.label ? { label: input.label } : {}), ...(traceId ? { traceId } : {}) });
}
