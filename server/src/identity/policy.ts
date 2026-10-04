import type { Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { isRole, rolesRequireMfa } from '../authz/permissions.js';
import { sha256 } from '../crypto/index.js';
import { json } from '../db/knex.js';
import type { UserRow } from '../repos/users.js';
import type { Services } from '../services.js';
import type { SessionStage } from './sessions.js';
import { browserOf } from './signin-notices.js';

/*
 * Sprint 26a: per-tenant identity policies (ported in design from exprsn-platform's signup policy and MFA policy
 * services, with their fail-closed defaults).
 *
 * - Signup (B-1801): closed unless a tenant admin opens it; `open` creates the account at once, `approval` creates it
 *   disabled until an admin approves; a non-empty domain list refuses every other email domain. Self-registered
 *   accounts get only the roles listed here, which are never admin roles.
 * - MFA (B-1803): a second factor for everyone or for some roles, on top of the roles that always need one, with a
 *   grace period counted from when the requirement last widened (or the account's creation, if later), and an
 *   optional trusted-device period: after a factor, the browser's B-801 device cookie can be remembered so the factor
 *   is skipped until the period ends or the user's sessions are revoked.
 */

const DAY_MS = 24 * 3600_000;

/** Roles a self-registered account may receive: none that administers anything or needs a second factor. */
export const SIGNUP_ROLES = ['member', 'flag-reviewer', 'knowledge-curator'] as const;

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'A domain such as example.com');

export const signupPolicySchema = z
  .object({
    mode: z.enum(['closed', 'open', 'approval']).default('closed'),
    /** Email domains allowed to sign up (exact, or any subdomain with a leading `*.`); empty means any domain. */
    domains: z.array(z.union([domain, z.string().trim().toLowerCase().regex(/^\*\.[a-z0-9.-]+$/, 'A domain such as *.example.com')])).max(200).default([]),
    /**
     * Local accounts must confirm their email address before they can sign in (self-registered ones, and any other
     * local account whose address was never proven). Off until a tenant admin turns it on, so existing accounts are
     * never locked out by an upgrade.
     */
    requireEmailVerification: z.boolean().default(false),
    roles: z.array(z.enum(SIGNUP_ROLES)).min(1).max(3).default(['member']),
    clearance: z.enum(LABELS).default('internal'),
    /** A workspace new accounts join directly. */
    workspaceId: z.string().length(26).nullable().default(null)
  })
  .strict();

export const mfaPolicySchema = z
  .object({
    /** Who must have a second factor beyond the roles that always need one: nobody else, everyone, or listed roles. */
    require: z.enum(['off', 'all', 'roles']).default('off'),
    roles: z.array(z.string().refine(isRole, 'Unknown role')).max(20).default([]),
    /** Days an account may still sign in without a factor once the requirement covers it (0: enrol at once). */
    graceDays: z.number().int().min(0).max(90).default(0),
    /** Days a browser may skip the second factor after "trust this device" (0: never). */
    trustedDeviceDays: z.number().int().min(0).max(90).default(0)
  })
  .strict()
  .refine((p) => p.require !== 'roles' || p.roles.length > 0, { message: 'Name at least one role, or require a factor for everyone.', path: ['roles'] });

export type SignupPolicy = z.infer<typeof signupPolicySchema>;
export type MfaPolicy = z.infer<typeof mfaPolicySchema>;

export interface IdentityPolicyRow {
  signup: SignupPolicy;
  mfa: MfaPolicy;
  mfaEffectiveAt: number | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface SignInStage {
  stage: SessionStage;
  /** The second factor was skipped because the device is trusted: the session counts as factor-verified. */
  mfaVerified: boolean;
  trustedDevice: boolean;
  /** In a grace period: the time by which a factor must be enrolled. */
  enrolBy: number | null;
}

/** Whether `email`'s domain is allowed by `domains` (empty allows any). */
export function domainAllowed(domains: string[], email: string): boolean {
  if (!domains.length) return true;
  const d = email.split('@').pop()!.toLowerCase();
  return domains.some((x) => (x.startsWith('*.') ? d.endsWith(x.slice(1)) && d.length > x.length - 1 : d === x));
}

export class IdentityPolicies {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  async get(tenantId: string): Promise<IdentityPolicyRow> {
    const r = (await this.db('identity_policies').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    // Stored values were validated when saved; parsing again fills defaults added later. Anything unreadable falls
    // back to the defaults: sign-up closed, no tenant MFA requirement beyond the roles', no trusted devices.
    const signup = signupPolicySchema.safeParse(json(r?.signup as string | null, {}));
    const mfa = mfaPolicySchema.safeParse(json(r?.mfa as string | null, {}));
    return {
      signup: signup.success ? signup.data : signupPolicySchema.parse({}),
      mfa: mfa.success ? mfa.data : mfaPolicySchema.parse({}),
      mfaEffectiveAt: r?.mfa_effective_at == null ? null : Number(r.mfa_effective_at),
      updatedBy: (r?.updated_by as string | null) ?? null,
      updatedAt: r?.updated_at == null ? null : Number(r.updated_at)
    };
  }

  private async save(tenantId: string, patch: Record<string, unknown>, by: string | null): Promise<void> {
    const t = Date.now();
    const n = await this.db('identity_policies').where({ tenant_id: tenantId }).update({ ...patch, updated_by: by, updated_at: t });
    if (!n) {
      const base = await this.get(tenantId);
      await this.db('identity_policies').insert({ tenant_id: tenantId, signup: JSON.stringify(base.signup), mfa: JSON.stringify(base.mfa), mfa_effective_at: null, ...patch, updated_by: by, updated_at: t });
    }
  }

  async setSignup(tenantId: string, policy: SignupPolicy, by: string | null): Promise<void> {
    await this.save(tenantId, { signup: JSON.stringify(policy) }, by);
  }

  /**
   * Saves the MFA policy. When the requirement now covers anyone it did not before (off to on, roles to all, a role
   * added), the grace period starts again from now; a narrowed or unchanged requirement keeps its start.
   */
  async setMfa(tenantId: string, policy: MfaPolicy, by: string | null): Promise<{ widened: boolean }> {
    const before = await this.get(tenantId);
    const b = before.mfa;
    const widened = policy.require !== 'off' && (b.require === 'off' || (b.require === 'roles' && (policy.require === 'all' || policy.roles.some((r) => !b.roles.includes(r)))));
    const patch: Record<string, unknown> = { mfa: JSON.stringify(policy) };
    if (widened || before.mfaEffectiveAt == null) patch.mfa_effective_at = policy.require === 'off' ? null : Date.now();
    await this.save(tenantId, patch, by);
    // Trusted devices only last as long as the policy allows: shortening (or ending) the period applies at once.
    if (policy.trustedDeviceDays < b.trustedDeviceDays) {
      const q = this.db('trusted_devices').where({ tenant_id: tenantId });
      if (policy.trustedDeviceDays === 0) await q.delete();
      else await q.andWhere('created_at', '<', Date.now() - policy.trustedDeviceDays * DAY_MS).delete();
    }
    return { widened };
  }

  /** Whether the tenant policy makes this account need a second factor, and until when it may still sign in without. */
  mfaRequirement(row: IdentityPolicyRow, user: Pick<UserRow, 'created_at'>, roles: string[]): { required: boolean; enrolBy: number | null } {
    const p = row.mfa;
    const covered = p.require === 'all' || (p.require === 'roles' && roles.some((r) => p.roles.includes(r)));
    if (!covered) return { required: false, enrolBy: null };
    const from = Math.max(row.mfaEffectiveAt ?? 0, user.created_at);
    const enrolBy = from + p.graceDays * DAY_MS;
    return Date.now() < enrolBy ? { required: false, enrolBy } : { required: true, enrolBy: null };
  }

  // ---------- trusted devices (B-1803) ----------

  private deviceKey(userId: string, device: string): string {
    return sha256(`trusted-device\n${userId}\n${device}`);
  }

  /** True when this browser's device cookie is trusted for the user and the tenant still allows trusted devices. */
  async isTrusted(req: Request, tenantId: string, userId: string, policy?: IdentityPolicyRow): Promise<boolean> {
    const p = policy ?? (await this.get(tenantId));
    if (p.mfa.trustedDeviceDays <= 0) return false;
    const device = this.s().account.signIns.deviceOf(req);
    if (!device) return false;
    const row = (await this.db('trusted_devices').where({ id: this.deviceKey(userId, device), user_id: userId }).first('expires_at', 'created_at')) as { expires_at: number; created_at: number } | undefined;
    if (!row) return false;
    const until = Math.min(Number(row.expires_at), Number(row.created_at) + p.mfa.trustedDeviceDays * DAY_MS);
    return until > Date.now();
  }

  /**
   * Remembers this browser after a second factor, for the tenant's trusted-device period. Needs the device cookie
   * (set at the first factor). Returns when the trust ends, or null when the tenant allows no trusted devices.
   */
  async trust(req: Request, input: { tenantId: string; userId: string; sessionId: string }): Promise<number | null> {
    const p = await this.get(input.tenantId);
    if (p.mfa.trustedDeviceDays <= 0) return null;
    // Admins (roles that require a second factor) and accounts marked as needing one never get a trusted device.
    const user = await this.s().users.get(input.tenantId, input.userId);
    if (!user || user.mfa_required || rolesRequireMfa(await this.s().users.roleIds(input.userId))) return null;
    const device = this.s().account.signIns.deviceOf(req);
    if (!device) return null;
    const t = Date.now();
    const row = { id: this.deviceKey(input.userId, device), tenant_id: input.tenantId, user_id: input.userId, session_id: input.sessionId, browser: browserOf(req.header('user-agent')).slice(0, 100), created_at: t, expires_at: t + p.mfa.trustedDeviceDays * DAY_MS };
    await this.db('trusted_devices').where({ id: row.id }).delete();
    await this.db('trusted_devices').insert(row);
    return row.expires_at;
  }

  async trustedDevices(userId: string): Promise<{ browser: string | null; createdAt: number; expiresAt: number }[]> {
    const rows = (await this.db('trusted_devices').where({ user_id: userId }).andWhere('expires_at', '>', Date.now()).orderBy('created_at', 'desc')) as { browser: string | null; created_at: number; expires_at: number }[];
    return rows.map((r) => ({ browser: r.browser, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) }));
  }

  /** Forgets every trusted device of a user (their sessions were revoked, or they asked). */
  async forgetUser(userId: string): Promise<number> {
    return this.db('trusted_devices').where({ user_id: userId }).delete();
  }

  /** Forgets the device trusted from one session (that session was revoked on purpose, not signed out). */
  async forgetSession(sessionId: string): Promise<number> {
    return this.db('trusted_devices').where({ session_id: sessionId }).delete();
  }

  async purge(): Promise<number> {
    return this.db('trusted_devices').where('expires_at', '<', Date.now()).delete();
  }

  // ---------- the stage a new sign-in starts in ----------

  /**
   * Where a sign-in whose first factor passed goes next: the second factor (unless this browser is trusted), factor
   * enrolment (roles that need one, or the tenant policy after its grace period), a forced password change, or done.
   */
  async signInStage(req: Request, input: { tenantId: string; user: UserRow; roles: string[]; mustChange: boolean }): Promise<SignInStage> {
    const policy = await this.get(input.tenantId);
    const done: SessionStage = input.mustChange ? 'password' : 'active';
    const methods = await this.s().mfa.methods(input.user.id);
    if (methods.length) {
      // Accounts whose roles require a second factor (admins) are asked for it on every sign-in: no trusted devices.
      const privileged = input.user.mfa_required || rolesRequireMfa(input.roles);
      if (!privileged && (await this.isTrusted(req, input.tenantId, input.user.id, policy))) return { stage: done, mfaVerified: true, trustedDevice: true, enrolBy: null };
      return { stage: 'mfa', mfaVerified: false, trustedDevice: false, enrolBy: null };
    }
    if (input.user.mfa_required || rolesRequireMfa(input.roles)) return { stage: 'enroll', mfaVerified: false, trustedDevice: false, enrolBy: null };
    const need = this.mfaRequirement(policy, input.user, input.roles);
    if (need.required) return { stage: 'enroll', mfaVerified: false, trustedDevice: false, enrolBy: null };
    return { stage: done, mfaVerified: false, trustedDevice: false, enrolBy: need.enrolBy };
  }
}
