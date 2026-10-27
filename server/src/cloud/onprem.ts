import { z } from 'zod';
import { labelRank, LABELS } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { forbidden, HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import type { EdgeRow } from './edge.js';
import type { DesiredResource, Deployment, Plan } from './graph.js';
import type { CallContext, ResourceSpec } from './providers/types.js';
import { CLOUDFLARE_FRONT_DOOR_CAP, type ProblemCheck, type SpecProblem } from './spec.js';
import { cloudTags } from './tags.js';
import type { CloudAccount } from './types.js';

/*
 * 1.9.99-final, Sprint 62 (B-10209): an existing install (Compose, bare metal or Helm on-prem) registered as a
 * deployment without compute, so the Cloudflare front door (B-109, `cloud/edge.ts`), drift and spend apply to it.
 *
 * The wizard sends `{ kind: 'onprem', ... }` to the same routes as a cloud spec (`validate-spec` and `POST
 * /admin/cloud/deployments`). The spec names the install's kind and where its app answers for the tunnel's connector
 * (the origin service: Compose `http://app:8080`, bare metal `http://127.0.0.1:8080`, Helm
 * `http://exprsn-ai.exprsn-ai.svc:80` by default), the highest label it holds (at most `confidential` behind
 * Cloudflare, open decision 5), and the front door (a platform Cloudflare account, the name and its zone, the plan,
 * the WAF). Its compute is `none`: the render has no network, no compute, no data tier, and the plan made at
 * registration has no step at all; only the front door's tunnel and proxied record are rendered (on the Cloudflare
 * account, as a cloud spec's `frontDoor`).
 *
 * The deployment lives on the Cloudflare account (a deployment's graph lives on one account; region `global`). Its
 * front door is created with it (or an existing front door for this install's name, made before without a
 * deployment, is attached), and applying the front door (`POST /admin/cloud/edge/:id/apply`) records the tunnel and
 * the DNS record in the deployment's graph with their provider ids (`recordFrontDoor`), so drift reads them through the
 * Cloudflare adapter and the deployment shows as `applied` with its public URL. Spend is the Cloudflare account's
 * (`/admin/cloud/deployments/:id/costs`). Nothing is called on any cloud at registration.
 */

export const ONPREM_INSTALLS = ['compose', 'baremetal', 'helm'] as const;
export type OnpremInstall = (typeof ONPREM_INSTALLS)[number];

/** Where the app answers for the tunnel's connector, by install kind (the shipped Compose file, unit and chart). */
export const ONPREM_ORIGINS: Record<OnpremInstall, string> = { compose: 'http://app:8080', baremetal: 'http://127.0.0.1:8080', helm: 'http://exprsn-ai.exprsn-ai.svc:80' };
/** The front door's install target for each kind (`CloudEdge.installFor`). */
export const INSTALL_TARGET: Record<OnpremInstall, 'compose' | 'systemd' | 'helm'> = { compose: 'compose', baremetal: 'systemd', helm: 'helm' };

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a DNS name such as ai.example.com');

export const onpremSpecSchema = z
  .object({
    kind: z.literal('onprem'),
    /** The deployment's name, also its front door's (so it ends with a letter or digit). */
    name: z.string().regex(/^[a-z][a-z0-9-]{0,29}[a-z0-9]$/, 'lower case letters, digits and dashes, starting with a letter and ending with a letter or digit'),
    description: z.string().trim().max(500).optional(),
    label: z.enum(LABELS).default('internal'),
    install: z
      .object({
        kind: z.enum(ONPREM_INSTALLS),
        /** Where the tunnel's connector reaches the app (the kind's default when not given). */
        service: z.url().max(500).refine((u) => /^https?:\/\//.test(u), 'an http:// or https:// address').optional(),
        version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'a release version such as 1.0.0').optional()
      })
      .strict(),
    /** No compute: nothing is planned on any cloud but the front door. */
    compute: z.object({ shape: z.literal('none') }).strict().default({ shape: 'none' }),
    frontDoor: z
      .object({
        kind: z.literal('cloudflare'),
        accountId: id26,
        hostname,
        zone: hostname,
        plan: z.enum(['free', 'pro', 'business']).default('free'),
        waf: z.object({ enabled: z.boolean().default(true), adminCidrs: z.array(z.string().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/)).max(20).default([]) }).strict().optional()
      })
      .strict()
  })
  .strict();
export type OnpremSpec = z.infer<typeof onpremSpecSchema>;

/** Whether a wizard body is an on-prem registration (the routes branch on it before parsing). */
export const isOnpremBody = (b: unknown): boolean => !!b && typeof b === 'object' && (b as { kind?: unknown }).kind === 'onprem';

/** The kind of a deployment from its stored spec. */
export const deploymentKindOf = (spec: Record<string, unknown> | null): 'cloud' | 'onprem' => (spec?.kind === 'onprem' ? 'onprem' : 'cloud');

export interface OnpremRender {
  /** Always empty: no network, compute or data tier is planned for an on-prem install. */
  resources: DesiredResource[];
  frontDoor: { accountId: string; resources: DesiredResource[]; planned: false; note: string };
  origin: string;
  notes: string[];
}

export const originOf = (spec: OnpremSpec): string => spec.install.service ?? ONPREM_ORIGINS[spec.install.kind];

/** Pure: what an on-prem registration renders (no compute; the front door's tunnel and record). */
export function renderOnprem(spec: OnpremSpec): OnpremRender {
  const fd = spec.frontDoor;
  const record = fd.hostname === fd.zone ? '@' : fd.hostname.slice(0, -(fd.zone.length + 1));
  return {
    resources: [],
    origin: originOf(spec),
    frontDoor: {
      accountId: fd.accountId,
      planned: false,
      note: 'The front door lives on the Cloudflare account; applying it (the edge flow) makes the tunnel and the proxied record and records them in this deployment.',
      resources: [
        { key: 'tunnel', type: 'tunnel', spec: { origin: originOf(spec) }, dependsOn: [], protect: false, region: null },
        { key: 'dns-app', type: 'dns_record', spec: { zone: fd.zone, record, recordType: 'CNAME', values: [], valueFrom: { key: 'tunnel', field: 'cname' }, proxied: true, plan: fd.plan }, dependsOn: ['tunnel'], protect: false, region: null }
      ]
    },
    notes: [`An on-prem ${spec.install.kind === 'baremetal' ? 'bare-metal' : spec.install.kind === 'helm' ? 'Helm' : 'Compose'} install: no compute, network or data tier is planned; the tunnel's connector runs beside the app and reaches it at ${originOf(spec)}.`]
  };
}

export interface OnpremValidation {
  valid: boolean;
  problems: SpecProblem[];
  account: CloudAccount | null;
  /** A front door for this name made earlier without a deployment, attached at registration. */
  attach: EdgeRow | null;
}

/** Validates an on-prem registration against its Cloudflare account, the label cap and the names in use; calls no provider. */
export async function validateOnprem(s: Services, p: Principal, spec: OnpremSpec): Promise<OnpremValidation> {
  const problems: SpecProblem[] = [];
  const add = (path: string, check: ProblemCheck, message: string) => problems.push({ path, check, message });
  const acc = s.cloud.accounts;
  await acc.need();
  const fd = spec.frontDoor;
  if (fd.hostname !== fd.zone && !fd.hostname.endsWith(`.${fd.zone}`)) add('frontDoor.hostname', 'front_door', `${fd.hostname} is not in the DNS zone ${fd.zone}.`);
  if (labelRank(spec.label) > labelRank(CLOUDFLARE_FRONT_DOOR_CAP)) add('label', 'ceiling', `Cloudflare's edge sees decrypted traffic, so an install behind it holds at most ${CLOUDFLARE_FRONT_DOOR_CAP}.`);
  let account: CloudAccount | null = null;
  const cf = await acc.get(fd.accountId);
  if (!cf || !acc.canSee(p, cf)) add('frontDoor.accountId', 'state', 'The Cloudflare account does not exist.');
  else if (cf.provider !== 'cloudflare') add('frontDoor.accountId', 'provider', `${cf.name} is not a Cloudflare account; an on-prem install is registered on the Cloudflare account of its front door.`);
  else {
    account = cf;
    if (cf.scope !== 'platform') add('frontDoor.accountId', 'scope', `${cf.name} is a tenant account; the front door of an install needs a platform account.`);
    const e = await acc.checkRegion(cf, 'global', labelRank(spec.label) > labelRank(CLOUDFLARE_FRONT_DOOR_CAP) ? CLOUDFLARE_FRONT_DOOR_CAP : spec.label, { use: 'deploy' });
    if (!e.allow) add('frontDoor.accountId', (e.step ?? 'region') as ProblemCheck, e.reason);
    const v = cf.validation?.features.find((x) => x.feature === 'frontdoor');
    if (!cf.validation) add('frontDoor.accountId', 'permission', `${cf.name} has not been validated yet; validate it before registering an install behind it.`);
    else if (v?.status === 'missing') add('frontDoor.accountId', 'permission', `${cf.name}'s token lacks ${v.missing.join(', ')}, which the front door needs.`);
    else if (v?.status === 'error') add('frontDoor.accountId', 'permission', `The last permission check for the front door failed; validate ${cf.name} again.`);
  }
  if ((await s.cloud.deployments.installed().catch(() => false)) && (await s.db('cloud_deployments').where({ tenant_id: p.tenantId, name: spec.name }).first())) add('name', 'name', `A deployment named ${spec.name} already exists.`);
  let attach: EdgeRow | null = null;
  if (await s.cloud.edge.installed().catch(() => false)) {
    const rows = (await s.db('cloud_edge').where({ name: spec.name }).orWhere({ hostname: fd.hostname }).select('id')) as { id: string }[];
    for (const r of rows) {
      const e = await s.cloud.edge.get(r.id);
      if (!attach && !e.deploymentId && e.hostname === fd.hostname && e.accountId === fd.accountId && e.origin.kind === 'tunnel') attach = e;
      else add(e.hostname === fd.hostname ? 'frontDoor.hostname' : 'name', 'front_door', e.hostname === fd.hostname ? `A front door for ${fd.hostname} exists already${e.deploymentId ? ' on another deployment' : ' with another account or a public origin'}.` : `A front door named ${spec.name} exists already.`);
    }
  }
  return { valid: problems.length === 0, problems, account, attach };
}

/** The refusal for an on-prem spec with problems: 403 for a placement or permission check, else 422 `invalid_spec`. */
export function onpremRefusal(v: OnpremValidation): HttpProblem {
  const placement = v.problems.find((p) => ['state', 'use', 'region', 'ceiling', 'residency'].includes(p.check));
  if (placement) return forbidden(placement.message, { step: 'zone', check: placement.check, reason: 'placement_refused', problems: v.problems });
  return new HttpProblem(422, 'Unprocessable content', `The on-prem registration has ${v.problems.length} problem${v.problems.length === 1 ? '' : 's'}: ${v.problems[0]!.message}`, { extensions: { reason: 'invalid_spec', problems: v.problems } });
}

export interface OnpremRegistration {
  deployment: Deployment;
  plan: Plan;
  edge: EdgeRow | null;
  frontDoor: OnpremRender['frontDoor'];
  install: Record<string, unknown> | null;
  notes: string[];
}

/**
 * Registers an on-prem install: the deployment on the Cloudflare account (no compute), an empty plan (nothing to
 * plan), and its front door (created, or the install's earlier one attached). Creating a front door needs
 * `cloud:admin`, which the caller is checked for first.
 */
export async function registerOnprem(s: Services, actor: CloudActor, spec: OnpremSpec, v: OnpremValidation): Promise<OnpremRegistration> {
  if (!authorize(actor.principal, 'cloud:admin').allow) throw forbidden('Registering an on-prem install creates its Cloudflare front door, which needs cloud:admin.', { step: 'role', action: 'cloud:admin' });
  const account = v.account!;
  const g = renderOnprem(spec);
  const stored = { ...spec, install: { ...spec.install, service: g.origin } };
  const d = await s.cloud.deployments.create(actor, { name: spec.name, accountId: account.id, region: 'global', label: spec.label, description: spec.description ?? `The ${spec.install.kind} install behind ${spec.frontDoor.hostname}`, spec: stored as unknown as Record<string, unknown> });
  await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.deployment.spec', actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { kind: 'onprem', shape: 'none', install: spec.install.kind, origin: g.origin, frontDoor: 'cloudflare', hostname: spec.frontDoor.hostname, resources: 0 } });
  // Nothing to plan but the front door, which the edge flow applies: the plan has no step.
  const plan = await s.cloud.plans.create(actor, d.id, []);
  let edge: EdgeRow | null = null;
  if (await s.cloud.edge.installed().catch(() => false)) {
    if (v.attach) {
      await s.db('cloud_edge').where({ id: v.attach.id, deployment_id: null }).update({ deployment_id: d.id, updated_at: Date.now() });
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.edge.attached', actor, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { edge: v.attach.id, name: v.attach.name, hostname: v.attach.hostname } });
      edge = await s.cloud.edge.get(v.attach.id);
      if (edge.state === 'applied' && edge.tunnelId) await recordFrontDoor(s, edge);
    } else {
      edge = await s.cloud.edge.create(actor, { name: spec.name, accountId: account.id, deploymentId: d.id, hostname: spec.frontDoor.hostname, zone: spec.frontDoor.zone, plan: spec.frontDoor.plan, origin: { kind: 'tunnel', service: g.origin }, waf: spec.frontDoor.waf ?? { enabled: true, adminCidrs: [] } });
    }
  }
  const install = edge ? await s.cloud.edge.installFor(edge.id, INSTALL_TARGET[spec.install.kind]) : null;
  return { deployment: (await s.cloud.deployments.get(d.id))!, plan, edge, frontDoor: g.frontDoor, install, notes: [...g.notes, ...(edge ? [`Apply the front door ${edge.name} (POST /api/admin/cloud/edge/${edge.id}/apply) to make the tunnel and the DNS record.`] : ['The front door needs the database migration 161_cloud_edge; create it once that is applied.'])] };
}

/**
 * After a front door of an on-prem deployment applied (`CloudEdge.apply`): its tunnel and proxied record join the
 * deployment's graph with their provider ids and observed state, so drift reads them; the deployment is `applied`
 * with its public URL. A cloud deployment's front door changes nothing here.
 */
export async function recordFrontDoor(s: Services, edge: EdgeRow): Promise<void> {
  if (!edge.deploymentId || !edge.tunnelId) return;
  const deps = s.cloud.deployments;
  const d = await deps.get(edge.deploymentId);
  if (!d || deploymentKindOf(d.spec) !== 'onprem' || d.accountId !== edge.accountId) return;
  const c = await deps.context(d, 'read');
  const ctx: CallContext = c.ctx('global');
  const tags = cloudTags({ account: c.account.name, deployment: d.name });
  const cname = `${edge.tunnelId}.cfargotunnel.com`;
  const tunnel: DesiredResource = { key: 'tunnel', type: 'tunnel', name: `edge-${edge.name}`, spec: {}, dependsOn: [], protect: false, region: null };
  const record: DesiredResource = { key: 'dns-app', type: 'dns_record', spec: { zone: edge.zone, record: edge.hostname, recordType: 'CNAME', values: [cname], proxied: true }, dependsOn: ['tunnel'], protect: false, region: null };
  const t = await c.provider.describe(ctx, { type: 'tunnel', providerId: edge.tunnelId });
  const r = await c.provider.find(ctx, { type: 'dns_record', name: 'dns-app', idempotencyKey: `edge-dns:${edge.id}`, tags, props: record.spec } as ResourceSpec);
  await deps.upsertResource(d.id, tunnel, 'global', { providerId: edge.tunnelId, observed: t, state: t ? 'ready' : 'missing', tags });
  if (r) await deps.upsertResource(d.id, record, 'global', { providerId: r.providerId, locator: r.locator ?? null, observed: r, state: 'ready', tags });
  const now = Date.now();
  const patch: Record<string, unknown> = { endpoints: JSON.stringify({ ...d.endpoints, publicUrl: `https://${edge.hostname}`, tlsName: edge.hostname }), updated_at: now };
  if (['draft', 'planned', 'failed'].includes(d.state)) patch.state = 'applied';
  await s.db('cloud_deployments').where({ id: d.id }).update(patch);
  await deps.bump(d.id);
  await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.deployment.updated', actor: { service: 'cloud.edge' }, deploymentId: d.id, deploymentName: d.name, label: d.label, detail: { frontDoor: edge.id, recorded: ['tunnel', ...(r ? ['dns-app'] : [])], publicUrl: `https://${edge.hostname}` } });
}
