import { ulid } from 'ulid';
import type { AuditActor } from '../audit/chain.js';
import { isUniqueViolation } from '../audit/chain.js';
import { highest, labelRank, type Label } from '../authz/labels.js';
import type { Permission } from '../authz/permissions.js';
import type { ProfileRow } from '../gateway/repo.js';
import { createAdmin } from '../identity/admin-create.js';
import { checkPasswordPolicy } from '../identity/passwords.js';
import { conflict, HttpProblem } from '../http/problem.js';
import type { Tenant, Workspace } from '../repos/tenants.js';
import type { Services } from '../services.js';

/*
 * 1.6.0 (B-4501): tenant provisioning templates, exprsn-platform's enterprise, team and personal organisation types.
 * A template is code, not data: it names the workspaces a new tenant starts with, custom roles built only from the
 * member baseline (so a template never grants an admin permission past dual control), draft gateway profiles (a model
 * admin picks their models and publishes them), the zone those profiles route to (they are pinned to a pool in that
 * zone when one exists) and whether the tenant gets its own issuing CA (an intermediate under the platform root, made
 * only when a root exists and the CA's key custody is available). Provisioning makes the tenant as `POST
 * /api/admin/tenants` does, applies the template and creates the first admin (tenant-admin, cleared for the highest
 * workspace ceiling, a member of every workspace) with a single-use enrolment link or a password, in one step. A part
 * that cannot be made (no pool in the zone, no root) is reported, never fails the tenant.
 */

export const TEMPLATE_IDS = ['enterprise', 'team', 'personal'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface TemplateWorkspace {
  name: string;
  description: string;
  label: Label;
  visibility: Workspace['visibility'];
}

export interface TemplateRole {
  name: string;
  description: string;
  permissions: Permission[];
}

export interface TemplateProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  label: Label;
}

export interface TenantTemplate {
  id: TemplateId;
  name: string;
  description: string;
  workspaces: TemplateWorkspace[];
  roles: TemplateRole[];
  profiles: TemplateProfile[];
  zone: string;
  issuer: boolean;
}

const READ: Permission[] = ['chat:read', 'knowledge:read', 'models:read', 'files:read', 'groups:read', 'feed:read', 'messages:read', 'social:read', 'calendars:read', 'contacts:read', 'records:read'];
const CONTRIBUTE: Permission[] = [...READ, 'chat:write', 'inference:invoke', 'context:read', 'context:write', 'tools:invoke', 'files:write', 'groups:write', 'feed:write', 'messages:write', 'social:write', 'calendars:write', 'contacts:write', 'records:write', 'moderation:report', 'moderation:appeal'];

const ASSISTANT: TemplateProfile = { name: 'assistant', displayName: 'Assistant', description: 'General help with writing, questions and everyday tasks.', systemPrompt: 'You are a helpful assistant for this organisation. Answer plainly and say when you are not sure.', label: 'internal' };

export const TEMPLATES: readonly TenantTemplate[] = [
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'An organisation with departments: a workspace per function up to confidential, reader and contributor roles, three draft profiles and its own issuing CA.',
    workspaces: [
      { name: 'General', description: 'Open to everyone in the organisation.', label: 'internal', visibility: 'tenant' },
      { name: 'Finance', description: 'Finance and accounting.', label: 'confidential', visibility: 'members' },
      { name: 'People', description: 'People operations and HR.', label: 'confidential', visibility: 'members' },
      { name: 'Engineering', description: 'Engineering and IT.', label: 'internal', visibility: 'members' },
      { name: 'Legal', description: 'Legal and compliance.', label: 'confidential', visibility: 'members' }
    ],
    roles: [
      { name: 'Reader', description: 'Reads conversations, knowledge, files and feeds in their workspaces; changes nothing.', permissions: READ },
      { name: 'Contributor', description: 'Chats, posts, shares files and keeps records in their workspaces.', permissions: CONTRIBUTE }
    ],
    profiles: [
      ASSISTANT,
      { name: 'analyst', displayName: 'Analyst', description: 'Careful answers over figures and documents.', systemPrompt: 'You are an analyst. Show your working, cite the documents you were given and never invent figures.', label: 'confidential' },
      { name: 'summariser', displayName: 'Summariser', description: 'Short summaries of long text.', systemPrompt: 'Summarise what you are given in a few plain sentences. Keep names, dates and numbers exact.', label: 'internal' }
    ],
    zone: 'inference',
    issuer: true
  },
  {
    id: 'team',
    name: 'Team',
    description: 'A small team: a shared workspace and a projects workspace, a contributor role, one draft profile and its own issuing CA.',
    workspaces: [
      { name: 'Team', description: 'Everyone on the team.', label: 'internal', visibility: 'tenant' },
      { name: 'Projects', description: 'Project work, by invitation.', label: 'internal', visibility: 'members' }
    ],
    roles: [{ name: 'Contributor', description: 'Chats, posts, shares files and keeps records in their workspaces.', permissions: CONTRIBUTE }],
    profiles: [ASSISTANT],
    zone: 'inference',
    issuer: true
  },
  {
    id: 'personal',
    name: 'Personal',
    description: 'One person: a private confidential workspace and one draft profile. No custom roles and no CA.',
    workspaces: [{ name: 'Personal', description: 'Your own workspace.', label: 'confidential', visibility: 'members' }],
    roles: [],
    profiles: [{ ...ASSISTANT, label: 'confidential' }],
    zone: 'inference',
    issuer: false
  }
];

export const templateById = (id: string): TenantTemplate | undefined => TEMPLATES.find((t) => t.id === id);

/** The highest workspace ceiling of a template: what its first admin is cleared for. */
export const templateCeiling = (t: TenantTemplate): Label => highest(...t.workspaces.map((w) => w.label));

export const templateView = (t: TenantTemplate) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  workspaces: t.workspaces.map((w) => ({ name: w.name, description: w.description, label: w.label, visibility: w.visibility })),
  roles: t.roles.map((r) => ({ name: r.name, description: r.description, permissions: r.permissions })),
  profiles: t.profiles.map((p) => ({ name: p.name, displayName: p.displayName, description: p.description, label: p.label })),
  zone: t.zone,
  issuer: t.issuer,
  adminClearance: templateCeiling(t)
});

/** Who provisions: a system admin (their tenant's chain records it too) or the CLI. */
export interface ProvisionActor {
  tenantId: string | null;
  userId: string | null;
  actor: AuditActor;
  traceId?: string | null;
}

export interface ProvisionInput {
  template: TemplateId;
  slug: string;
  name: string;
  directoryDn?: string | null;
  admin: { username: string; displayName: string; email?: string | null; password: string | null };
}

export interface ProvisionResult {
  tenant: Tenant;
  applied: {
    template: TemplateId;
    workspaces: { id: string; name: string; label: Label }[];
    roles: { id: string; name: string }[];
    profiles: { id: string; name: string; poolId: string | null }[];
    zone: { id: string; state: 'pinned' | 'no pool in zone'; poolId: string | null; poolName: string | null };
    issuer: { state: 'created' | 'skipped' | 'not in template'; id: string | null; reason: string | null };
  };
  admin: { id: string; username: string; roles: string[]; clearance: Label; enrolLink: string | null; enrolHours: number | null };
}

/** Provisions a tenant from a template. Throws 409 for a taken slug, 422 for an unacceptable admin password. */
export async function provisionTenant(s: Services, by: ProvisionActor, input: ProvisionInput): Promise<ProvisionResult> {
  const tpl = templateById(input.template);
  if (!tpl) throw new HttpProblem(422, 'Unknown template', `There is no template ${input.template}.`);
  const username = input.admin.username.trim().toLowerCase();
  if (input.admin.password !== null) {
    const policy = checkPasswordPolicy(input.admin.password, username);
    if (!policy.ok) throw new HttpProblem(422, 'Password not accepted', policy.reason, { extensions: { field: 'admin.password' } });
  }
  const traceId = by.traceId ?? null;
  const audit = async (tenantId: string, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const e = { action, kind: 'admin' as const, actor: by.actor, target: { ...target, tenant: tenantId }, ...(detail ? { detail } : {}), traceId };
    await s.audit.append({ tenantId, ...e });
    if (by.tenantId && by.tenantId !== tenantId) await s.audit.append({ tenantId: by.tenantId, ...e });
  };

  let tenant: Tenant;
  try {
    tenant = await s.tenants.create({ slug: input.slug, name: input.name, directoryDn: input.directoryDn ?? null });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('A tenant with that slug exists.');
    throw err;
  }
  await s.providers.create(tenant.id, { name: 'Local accounts', kind: 'local', position: 1000, enabled: true, config: {} });
  await s.keys.seal(tenant.id, 'key check', 'tenant-created');
  await audit(tenant.id, 'tenant.created', { slug: tenant.slug }, { name: tenant.name, directoryDn: tenant.directory_dn, template: tpl.id });

  // Workspaces.
  const workspaces: Workspace[] = [];
  for (const w of tpl.workspaces) {
    const row = await s.tenants.createWorkspace(tenant.id, w.name, w.label, { description: w.description, visibility: w.visibility });
    workspaces.push(row);
    await audit(tenant.id, 'workspace.created', { workspace: row.id, name: row.name }, { labelCeiling: row.label_ceiling, visibility: row.visibility, mapping: null, template: tpl.id });
  }

  // Custom roles (member baseline only).
  const roles: { id: string; name: string }[] = [];
  for (const r of tpl.roles) {
    const role = await s.customRoles.seed(tenant.id, { name: r.name, description: r.description, permissions: r.permissions, requiresMfa: false, grantableBy: ['tenant-admin', 'identity-admin'] }, null);
    roles.push({ id: role.id, name: role.name });
    await audit(tenant.id, 'authz.role.created', { role: role.id, name: role.name }, { version: 1, permissions: role.permissions, requiresMfa: false, grantableBy: role.grantable_by, dualControl: false, template: tpl.id });
  }

  // Draft profiles, pinned to a pool in the template's zone when there is one that may process their label.
  const pools = (await s.gateway.repo.pools()).filter((p) => p.zone === tpl.zone).sort((a, b) => a.name.localeCompare(b.name));
  const poolFor = (label: Label) => pools.find((p) => labelRank(p.label_ceiling as Label) >= labelRank(label)) ?? null;
  const profiles: { id: string; name: string; poolId: string | null }[] = [];
  for (const pr of tpl.profiles) {
    const pool = poolFor(pr.label);
    const t = Date.now();
    const row: ProfileRow = { id: ulid(), tenant_id: tenant.id, name: pr.name, display_name: pr.displayName, description: pr.description, alias_of: null, model_id: null, pool_id: pool?.id ?? null, num_ctx: null, temperature: null, think_default: 'off', think_ceiling: 'off', system_prompt: pr.systemPrompt, fallback: null, canary: null, tools: [], label: pr.label, status: 'draft', version: 1, updated_by: by.userId, created_at: t, updated_at: t };
    await s.gateway.repo.createProfile(row);
    await s.gateway.repo.snapshot(row, `Created from the ${tpl.name} template`, by.userId);
    profiles.push({ id: row.id, name: row.name, poolId: row.pool_id });
    await audit(tenant.id, 'profile.created', { profile: row.id, name: row.name }, { aliasOf: null, model: null, pool: row.pool_id, template: tpl.id });
  }
  const pinned = profiles.length > 0 && profiles.every((p) => p.poolId);
  const firstPool = pools.find((p) => profiles.some((x) => x.poolId === p.id)) ?? null;
  const zone = { id: tpl.zone, state: (pinned ? 'pinned' : 'no pool in zone') as 'pinned' | 'no pool in zone', poolId: firstPool?.id ?? null, poolName: firstPool?.name ?? null };

  // The issuing CA, when the template asks for one and the platform can make it.
  let issuer: ProvisionResult['applied']['issuer'] = { state: 'not in template', id: null, reason: null };
  if (tpl.issuer) {
    try {
      const row = await s.pki.createIntermediate({ tenantId: tenant.id, userId: by.userId, actor: by.actor, traceId }, tenant.id, { keyType: 'ecdsa-p256', days: 3 * 365 });
      issuer = { state: 'created', id: row.id, reason: null };
    } catch (err) {
      issuer = { state: 'skipped', id: null, reason: (err as Error).message.slice(0, 300) };
    }
  }

  // The first admin.
  const clearance = templateCeiling(tpl);
  const made = await createAdmin(s, { username, displayName: input.admin.displayName, email: input.admin.email ?? null, tenant: tenant.slug, roles: ['tenant-admin'], clearance, password: input.admin.password, actor: by.actor, traceId });
  for (const w of workspaces) {
    await s.tenants.addMember(w.id, made.user.id);
    await audit(tenant.id, 'workspace.member.added', { workspace: w.id, user: made.user.id, username }, { template: tpl.id });
  }

  const applied: ProvisionResult['applied'] = { template: tpl.id, workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, label: w.label_ceiling })), roles, profiles, zone, issuer };
  await audit(tenant.id, 'tenant.template.applied', { slug: tenant.slug }, { template: tpl.id, workspaces: applied.workspaces.map((w) => w.name), roles: roles.map((r) => r.name), profiles: profiles.map((p) => p.name), zone: { id: zone.id, state: zone.state, pool: zone.poolName }, issuer: { state: issuer.state, id: issuer.id, reason: issuer.reason }, admin: { user: made.user.id, username, enrolLink: !!made.enrol } });
  return { tenant, applied, admin: { id: made.user.id, username, roles: made.roles, clearance, enrolLink: made.enrol?.link ?? null, enrolHours: made.enrol?.hours ?? null } };
}
