import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { rolesRequireMfa } from '../authz/permissions.js';
import type { Config } from '../config/index.js';
import { json } from '../db/knex.js';
import { badRequest, forbidden, HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import type { LockoutSettings } from './lockout.js';
import { checkPasswordPolicy, DEFAULT_PASSWORD_RULES, hashScheme, PASSWORD_FLOOR, passwordRules, tooSimilar, verifyPassword, type PasswordCheckHosts, type PasswordRule, type PasswordRuleSettings } from './passwords.js';

/*
 * 1.9.0, Sprint 55 (B-190): the tenant sign-in policy, enforced.
 *
 * A tenant sets only what it wants to change; everything else is the platform's. The platform gives the floor (a
 * password of at least 12 characters, which no tenant lowers) and the bounds: SESSION_IDLE_MINUTES,
 * SESSION_ABSOLUTE_HOURS and STEPUP_WINDOW_SECONDS are the longest a tenant may allow (it may only shorten them),
 * LOCKOUT_MAX_ATTEMPTS the most attempts. A tenant without a policy row gets exactly today's behaviour.
 *
 * Every new password goes through `checkNewPassword`, in this order: the policy (length, character classes when
 * turned on, the username, common passwords, not too close to the previous one, the history), then the tenant's deny
 * words (B-194, `s.passwordDenyWords`), then the leaked-password lists (B-193, `s.leakedPasswords`, which decides what
 * a hit or an unavailable list means; without it, the BREACHED_* check as before). At sign-in a password that no
 * longer meets the policy (or has passed a forced expiry) is accepted and the person is asked to change it: the
 * session starts in the `password` stage, never locked out.
 */

export const MFA_METHODS = ['totp', 'passkey', 'email'] as const;
export type MfaMethodKind = (typeof MFA_METHODS)[number];
/** The factor kinds `MfaService` stores, by the policy's names. */
const FACTOR_KIND: Record<MfaMethodKind, 'totp' | 'webauthn' | 'email'> = { totp: 'totp', passkey: 'webauthn', email: 'email' };

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** What a tenant stores: every field optional (left out is the platform's or the default). */
export const signinPolicySchema = z
  .object({
    password: z
      .object({
        minLength: int(PASSWORD_FLOOR, 128).optional(),
        maxLength: int(PASSWORD_FLOOR, 1024).optional(),
        requireLower: z.boolean().optional(),
        requireUpper: z.boolean().optional(),
        requireDigit: z.boolean().optional(),
        requireSymbol: z.boolean().optional(),
        /** Refuse a new password too close to the one it replaces (known only when the person types the old one). */
        notSimilarToPrevious: z.boolean().optional(),
        /** How many earlier passwords may not be used again (0: none; the current one is always refused at a change). */
        history: int(0, 24).optional(),
        /** Days after which a password must be changed (0: never, the NIST recommendation). */
        expiryDays: int(0, 730).optional()
      })
      .strict()
      .default({}),
    lockout: z.object({ maxAttempts: int(3, 50).optional(), windowMinutes: int(1, 24 * 60).optional(), durationMinutes: int(1, 24 * 60).optional() }).strict().default({}),
    sessions: z.object({ idleMinutes: int(5, 24 * 60).optional(), absoluteHours: int(1, 24 * 30).optional(), stepUpSeconds: int(30, 24 * 3600).optional() }).strict().default({}),
    /** The second factors people may use and enrol; at least one. */
    mfaMethods: z.array(z.enum(MFA_METHODS)).min(1).max(3).optional()
  })
  .strict()
  .superRefine((p, ctx) => {
    const min = p.password.minLength ?? DEFAULT_PASSWORD_RULES.minLength;
    const max = p.password.maxLength ?? DEFAULT_PASSWORD_RULES.maxLength;
    if (max < min) ctx.addIssue({ code: 'custom', path: ['password', 'maxLength'], message: `The maximum must be at least the minimum (${min}).` });
  });

export type SigninPolicy = z.infer<typeof signinPolicySchema>;

export type PolicySource = 'platform floor' | 'platform' | 'tenant' | 'default';

export interface EffectiveSigninPolicy {
  /** Whether the tenant has a policy at all (false: today's behaviour everywhere). */
  configured: boolean;
  password: PasswordRuleSettings & { notSimilarToPrevious: boolean; history: number; expiryDays: number };
  lockout: LockoutSettings;
  sessions: { idleMinutes: number; absoluteHours: number; stepUpSeconds: number };
  mfaMethods: MfaMethodKind[];
  /** Where each value comes from, by its path (`password.minLength`, `sessions.idleMinutes`, ...). */
  sources: Record<string, PolicySource>;
}

export interface PlatformBounds {
  password: { minLength: { min: number; max: number }; maxLength: { min: number; max: number }; history: { min: number; max: number }; expiryDays: { min: number; max: number } };
  lockout: { maxAttempts: { min: number; max: number }; windowMinutes: { min: number; max: number }; durationMinutes: { min: number; max: number } };
  sessions: { idleMinutes: { min: number; max: number }; absoluteHours: { min: number; max: number }; stepUpSeconds: { min: number; max: number } };
}

/** The range each value may take: the platform's settings are the most a tenant may allow. */
export function platformBounds(cfg: Pick<Config, 'SESSION_IDLE_MINUTES' | 'SESSION_ABSOLUTE_HOURS' | 'STEPUP_WINDOW_SECONDS' | 'LOCKOUT_MAX_ATTEMPTS'>): PlatformBounds {
  return {
    password: { minLength: { min: PASSWORD_FLOOR, max: 128 }, maxLength: { min: PASSWORD_FLOOR, max: 1024 }, history: { min: 0, max: 24 }, expiryDays: { min: 0, max: 730 } },
    lockout: { maxAttempts: { min: 3, max: Math.max(3, cfg.LOCKOUT_MAX_ATTEMPTS) }, windowMinutes: { min: 1, max: 24 * 60 }, durationMinutes: { min: 1, max: 24 * 60 } },
    sessions: { idleMinutes: { min: 5, max: Math.max(5, cfg.SESSION_IDLE_MINUTES) }, absoluteHours: { min: 1, max: Math.max(1, cfg.SESSION_ABSOLUTE_HOURS) }, stepUpSeconds: { min: 30, max: Math.max(30, cfg.STEPUP_WINDOW_SECONDS) } }
  };
}

/** Values outside the platform's bounds, as problem details (a saved policy must be within them). */
export function outOfBounds(p: SigninPolicy, b: PlatformBounds): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const check = (path: string, v: number | undefined, r: { min: number; max: number }, unit: string) => {
    if (v !== undefined && (v < r.min || v > r.max)) out.push({ path, message: `Between ${r.min} and ${r.max} ${unit}: the platform allows no more.` });
  };
  check('lockout.maxAttempts', p.lockout.maxAttempts, b.lockout.maxAttempts, 'attempts');
  check('sessions.idleMinutes', p.sessions.idleMinutes, b.sessions.idleMinutes, 'minutes');
  check('sessions.absoluteHours', p.sessions.absoluteHours, b.sessions.absoluteHours, 'hours');
  check('sessions.stepUpSeconds', p.sessions.stepUpSeconds, b.sessions.stepUpSeconds, 'seconds');
  return out;
}

/** What saving `p` deserves a word about: forced expiry, and character classes (both against NIST's advice). */
export function policyWarnings(p: SigninPolicy): string[] {
  const out: string[] = [];
  if ((p.password.expiryDays ?? 0) > 0) out.push(`Passwords expire after ${p.password.expiryDays} days. NIST SP 800-63B advises against forced expiry: people pick weaker, predictable passwords. Prefer the leaked-password check, which asks for a change only when there is a reason.`);
  if (p.password.requireLower || p.password.requireUpper || p.password.requireDigit || p.password.requireSymbol) out.push('Character-class rules are on. NIST SP 800-63B prefers length: a long passphrase is stronger than a short password with a symbol.');
  return out;
}

/** The tenant's policy over the platform's values, clamped to the platform's current bounds, with the sources. */
export function resolvePolicy(stored: SigninPolicy | null, cfg: Config): EffectiveSigninPolicy {
  const p = stored ?? signinPolicySchema.parse({});
  const b = platformBounds(cfg);
  const sources: Record<string, PolicySource> = {};
  const pick = <T>(path: string, tenant: T | undefined, fallback: T, src: PolicySource): T => {
    sources[path] = tenant === undefined ? src : 'tenant';
    return tenant === undefined ? fallback : tenant;
  };
  // A tenant value above the platform's current maximum (the platform was tightened later) is held to it.
  const capped = (path: string, tenant: number | undefined, platform: number, max: number): number => {
    if (tenant === undefined) {
      sources[path] = 'platform';
      return platform;
    }
    sources[path] = tenant > max ? 'platform' : 'tenant';
    return Math.min(tenant, max);
  };
  const minLength = pick('password.minLength', p.password.minLength, PASSWORD_FLOOR, 'platform floor');
  return {
    // A saved policy that sets nothing is no policy: sign-in behaves exactly as without one.
    configured: !!stored && (Object.keys(p.password).length > 0 || Object.keys(p.lockout).length > 0 || Object.keys(p.sessions).length > 0 || p.mfaMethods !== undefined),
    password: {
      minLength,
      maxLength: Math.max(minLength, pick('password.maxLength', p.password.maxLength, DEFAULT_PASSWORD_RULES.maxLength, 'default')),
      requireLower: pick('password.requireLower', p.password.requireLower, false, 'default'),
      requireUpper: pick('password.requireUpper', p.password.requireUpper, false, 'default'),
      requireDigit: pick('password.requireDigit', p.password.requireDigit, false, 'default'),
      requireSymbol: pick('password.requireSymbol', p.password.requireSymbol, false, 'default'),
      notSimilarToPrevious: pick('password.notSimilarToPrevious', p.password.notSimilarToPrevious, false, 'default'),
      history: pick('password.history', p.password.history, 0, 'default'),
      expiryDays: pick('password.expiryDays', p.password.expiryDays, 0, 'default')
    },
    lockout: {
      maxAttempts: capped('lockout.maxAttempts', p.lockout.maxAttempts, cfg.LOCKOUT_MAX_ATTEMPTS, b.lockout.maxAttempts.max),
      windowMinutes: pick('lockout.windowMinutes', p.lockout.windowMinutes, cfg.LOCKOUT_WINDOW_MINUTES, 'platform'),
      durationMinutes: pick('lockout.durationMinutes', p.lockout.durationMinutes, cfg.LOCKOUT_DURATION_MINUTES, 'platform')
    },
    sessions: {
      idleMinutes: capped('sessions.idleMinutes', p.sessions.idleMinutes, cfg.SESSION_IDLE_MINUTES, b.sessions.idleMinutes.max),
      absoluteHours: capped('sessions.absoluteHours', p.sessions.absoluteHours, cfg.SESSION_ABSOLUTE_HOURS, b.sessions.absoluteHours.max),
      stepUpSeconds: capped('sessions.stepUpSeconds', p.sessions.stepUpSeconds, cfg.STEPUP_WINDOW_SECONDS, b.sessions.stepUpSeconds.max)
    },
    mfaMethods: pick('mfaMethods', p.mfaMethods ? [...new Set(p.mfaMethods)] : undefined, [...MFA_METHODS], 'default'),
    sources
  };
}

export type PasswordContext = 'change' | 'reset' | 'admin' | 'import' | 'signup' | 'invite';

export interface NewPasswordInput {
  tenantId: string;
  username: string;
  password: string;
  /** The account the password is for, when it exists: its current and earlier passwords are compared (history). */
  userId?: string | null;
  /** The password it replaces, when the person typed it (a change): "not too close to the old password". */
  previous?: string | null;
  context?: PasswordContext;
  actor?: Principal | null;
  ip?: string | null;
  traceId?: string;
}

/** Why a sign-in with a correct password goes to the `password` stage. */
export type ChangeReason = 'policy' | 'expired' | 'leaked';

const CACHE_MS = 30_000;
const TOPIC = 'identity.signin_policy.changed';

/**
 * The tenant sign-in policy: stored values, the effective policy (cached for 30 seconds, dropped on every instance
 * when it changes), and its enforcement points. Every read tolerates a database without the 129 tables: no table is
 * the same as no policy.
 */
export class SigninPolicies {
  private readonly cache = new Map<string, { at: number; value: EffectiveSigninPolicy }>();
  private ready: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {
    s().bus.on<{ tenantId?: string }>(TOPIC, (p) => {
      if (p?.tenantId) this.cache.delete(p.tenantId);
      else this.cache.clear();
    });
  }

  private get db() {
    return this.s().db;
  }

  /** Whether migration 129 has run (a missing table is re-checked once a minute). */
  async available(): Promise<boolean> {
    if (this.ready && (this.ready.ok || Date.now() - this.ready.at < 60_000)) return this.ready.ok;
    const ok = await this.db.schema.hasTable('signin_policies').catch(() => false);
    this.ready = { ok, at: Date.now() };
    return ok;
  }

  bounds(): PlatformBounds {
    return platformBounds(this.s().cfg);
  }

  async stored(tenantId: string): Promise<{ policy: SigninPolicy; updatedBy: string | null; updatedAt: number } | null> {
    if (!(await this.available())) return null;
    const r = (await this.db('signin_policies').where({ tenant_id: tenantId }).first()) as { policy: string; updated_by: string | null; updated_at: number } | undefined;
    if (!r) return null;
    // Validated when saved; parsing again drops anything a later build no longer knows. Unreadable is no policy.
    const parsed = signinPolicySchema.safeParse(json(r.policy, {}));
    return parsed.success ? { policy: parsed.data, updatedBy: r.updated_by ?? null, updatedAt: Number(r.updated_at) } : null;
  }

  async effective(tenantId: string): Promise<EffectiveSigninPolicy> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const stored = await this.stored(tenantId).catch(() => null);
    const value = resolvePolicy(stored?.policy ?? null, this.s().cfg);
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(tenantId, { at: Date.now(), value });
    return value;
  }

  private changed(tenantId: string): void {
    this.cache.delete(tenantId);
    this.s().bus.publish(TOPIC, { tenantId });
  }

  /** Saves a tenant's policy (validated, within the platform's bounds). Returns the warnings it deserves. */
  async save(tenantId: string, policy: SigninPolicy, by: string | null): Promise<{ warnings: string[] }> {
    if (!(await this.available())) throw new HttpProblem(503, 'Not ready', 'The sign-in policy tables are not installed yet (migration 129_signin_policy). Run the migrations first.');
    const bad = outOfBounds(policy, this.bounds());
    if (bad.length) throw badRequest(bad.map((x) => `${x.path}: ${x.message}`).join(' '), { errors: bad });
    const row = { tenant_id: tenantId, policy: JSON.stringify(policy), updated_by: by, updated_at: Date.now() };
    const n = await this.db('signin_policies').where({ tenant_id: tenantId }).update(row);
    if (!n) await this.db('signin_policies').insert(row);
    // A shorter history keeps only what it still needs.
    await this.pruneHistory(tenantId, policy.password.history ?? 0);
    this.changed(tenantId);
    return { warnings: policyWarnings(policy) };
  }

  /** Removes the tenant's policy: every value is the platform's again. True when there was one. */
  async reset(tenantId: string): Promise<boolean> {
    if (!(await this.available())) return false;
    const n = await this.db('signin_policies').where({ tenant_id: tenantId }).delete();
    await this.db('password_history').where({ tenant_id: tenantId }).delete();
    this.changed(tenantId);
    return n > 0;
  }

  // ---------- the values other services read ----------

  async rulesFor(tenantId: string): Promise<PasswordRuleSettings> {
    return (await this.effective(tenantId)).password;
  }

  async lockoutFor(tenantId: string): Promise<LockoutSettings> {
    return (await this.effective(tenantId)).lockout;
  }

  /** The tenant's session lifetimes, or null when they are the platform's (the session service's own values). */
  async sessionLifetimes(tenantId: string): Promise<{ idleMinutes: number; absoluteHours: number } | null> {
    const e = await this.effective(tenantId);
    if (e.sources['sessions.idleMinutes'] !== 'tenant' && e.sources['sessions.absoluteHours'] !== 'tenant') return null;
    return { idleMinutes: e.sessions.idleMinutes, absoluteHours: e.sessions.absoluteHours };
  }

  async stepUpSeconds(tenantId: string): Promise<number> {
    return (await this.effective(tenantId)).sessions.stepUpSeconds;
  }

  // ---------- MFA methods ----------

  async allowedMethods(tenantId: string): Promise<MfaMethodKind[]> {
    return (await this.effective(tenantId)).mfaMethods;
  }

  /**
   * The factors offered at sign-in: the allowed ones the account has (and recovery codes). An account with none of
   * the allowed kinds keeps the ones it has, so restricting the methods never locks anyone out; it enrols an
   * allowed one next (Settings refuses new factors of the other kinds).
   */
  async offered<M extends string>(tenantId: string, methods: M[]): Promise<M[]> {
    const allowed = new Set((await this.allowedMethods(tenantId)).map((m) => FACTOR_KIND[m] as string));
    const mine = methods.filter((m) => m === 'recovery' || allowed.has(m));
    return mine.some((m) => m !== 'recovery') ? mine : methods;
  }

  /** Refuses a second factor at sign-in that the tenant no longer allows, when the account has an allowed one. */
  async assertOffered(tenantId: string, method: 'totp' | 'webauthn' | 'email' | 'recovery', methods: ('totp' | 'webauthn' | 'email' | 'recovery')[]): Promise<void> {
    if (!(await this.offered(tenantId, methods)).includes(method)) throw forbidden('This organisation no longer allows this kind of second factor. Use another one you have.', { reason: 'mfa_method_not_allowed' });
  }

  /** Refuses enrolling a factor of a kind the tenant does not allow. */
  async assertEnrol(tenantId: string, kind: MfaMethodKind): Promise<void> {
    const allowed = await this.allowedMethods(tenantId);
    if (!allowed.includes(kind)) throw forbidden(`This organisation does not allow ${kind === 'passkey' ? 'passkeys' : kind === 'totp' ? 'authenticator apps' : 'email codes'} as a second factor. Allowed: ${allowed.map((m) => (m === 'passkey' ? 'passkeys' : m === 'totp' ? 'authenticator apps' : 'email codes')).join(', ')}.`, { reason: 'mfa_method_not_allowed', allowed });
  }

  // ---------- the password pipeline ----------

  /**
   * Checks a new password, in order: the policy, the tenant's deny words, the leaked-password lists. Throws a 400
   * problem naming the reason (`policy` with the rule, `history`, `deny_word`, `leaked`), or a 503 when a leaked list
   * is unavailable and the tenant fails closed. Returns warnings (a leaked hit the check said to accept with a warning).
   */
  async checkNewPassword(input: NewPasswordInput): Promise<{ warnings: string[] }> {
    const s = this.s();
    const pol = await this.effective(input.tenantId);
    const warnings: string[] = [];

    // 1. The policy.
    const failed = passwordRules(input.password, input.username, pol.password).find((r) => !r.ok);
    if (failed) throw badRequest(checkPasswordPolicy(input.password, input.username, pol.password).reason!, { reason: 'policy', rule: failed.id });
    if (pol.password.notSimilarToPrevious && input.previous && tooSimilar(input.previous, input.password)) throw badRequest('The new password is too close to the old one. Choose one that is not a small change of it.', { reason: 'policy', rule: 'similar' });
    if (pol.password.history > 0 && input.userId && (await this.reused(input.userId, input.password, pol.password.history))) throw badRequest(`Choose a password you have not used before: the last ${pol.password.history} cannot be used again.`, { reason: 'history' });

    // 2. The tenant's deny words (B-194).
    const hosts = s as unknown as PasswordCheckHosts;
    if (hosts.passwordDenyWords) {
      const d = await hosts.passwordDenyWords.check(input.tenantId, input.password);
      if (d.found) throw badRequest(d.term ? `The password contains "${d.term}", which this organisation does not allow in passwords.` : 'The password contains a word this organisation does not allow in passwords.', { reason: 'deny_word' });
    }

    // 3. The leaked-password lists (B-193); without them, the BREACHED_* check as before.
    if (hosts.leakedPasswords) {
      const r = await hosts.leakedPasswords.check(input.tenantId, input.password);
      if ('unavailable' in r) {
        await this.auditUnavailable(input, [{ source: 'leaked-lists', reason: r.reason ?? 'unavailable' }], r.action === 'block');
        if (r.action === 'block') throw new HttpProblem(503, 'Check unavailable', 'The leaked-password check is unavailable, and this organisation does not accept a password without it. Try again later.', { extensions: { reason: 'leaked_unavailable' } });
      } else if (r.found) {
        const action = r.action ?? 'block';
        if (action === 'block' || action === 'require_change') throw badRequest(r.message ?? 'This password appears in a list of leaked passwords. Choose another.', { reason: (r as { source?: string }).source === 'breached' ? 'breached' : 'leaked' });
        if (action === 'warn') warnings.push(r.message ?? 'This password appears in a list of leaked passwords. Consider choosing another.');
      }
    } else {
      const r = await s.account.breached.check(input.password);
      if (r.breached) throw badRequest('This password appears in a public list of breached passwords. Choose another.', { reason: 'breached' });
      if (r.unavailable?.length) await this.auditUnavailable(input, r.unavailable, false);
    }
    return { warnings };
  }

  private async auditUnavailable(input: NewPasswordInput, sources: { source: string; reason: string }[], closed: boolean): Promise<void> {
    await this.s().audit.append({
      tenantId: input.tenantId,
      action: 'password.breach_check.unavailable',
      kind: 'auth',
      actor: input.actor ? actorFrom(input.actor, input.ip ?? null) : { username: input.username, ip: input.ip ?? null },
      target: { username: input.username },
      detail: { sources, note: closed ? 'The leaked-password check failed closed: the password was refused.' : 'The breached-password check failed open: the password was accepted without it.' },
      ...(input.traceId ? { traceId: input.traceId } : {})
    });
  }

  /** The policy's rules one by one for the strength meter, with the tenant's settings. */
  async meterRules(tenantId: string, password: string, username: string): Promise<PasswordRule[]> {
    return passwordRules(password, username, await this.rulesFor(tenantId));
  }

  // ---------- history ----------

  /** Whether `password` is the account's current one or one of its last `count` (verified against each hash). */
  private async reused(userId: string, password: string, count: number): Promise<boolean> {
    const cur = (await this.db('local_credentials').where({ user_id: userId }).first('password_hash')) as { password_hash: string } | undefined;
    if (cur && (await verifyPassword(cur.password_hash, password))) return true;
    if (!(await this.available())) return false;
    const rows = (await this.db('password_history').where({ user_id: userId }).orderBy('created_at', 'desc').limit(count).select('password_hash')) as { password_hash: string }[];
    for (const r of rows) if (await verifyPassword(r.password_hash, password)) return true;
    return false;
  }

  /**
   * Keeps the hash a password change replaces, when the tenant keeps a history: argon2 hashes only (an imported bcrypt
   * hash is dropped), at most the policy's count per account.
   */
  async remember(tenantId: string, userId: string, oldHash: string | null | undefined): Promise<void> {
    if (!oldHash || hashScheme(oldHash) !== 'argon2') return;
    const count = (await this.effective(tenantId)).password.history;
    if (count <= 0 || !(await this.available())) return;
    await this.db('password_history').insert({ id: ulid(), tenant_id: tenantId, user_id: userId, password_hash: oldHash, created_at: Date.now() });
    const keep = (await this.db('password_history').where({ user_id: userId }).orderBy('created_at', 'desc').limit(count).select('id')) as { id: string }[];
    await this.db('password_history').where({ user_id: userId }).whereNotIn('id', keep.map((k) => k.id)).delete();
  }

  private async pruneHistory(tenantId: string, count: number): Promise<void> {
    if (count <= 0) {
      await this.db('password_history').where({ tenant_id: tenantId }).delete();
      return;
    }
    const users = (await this.db('password_history').where({ tenant_id: tenantId }).distinct('user_id')) as { user_id: string }[];
    for (const u of users) {
      const keep = (await this.db('password_history').where({ user_id: u.user_id }).orderBy('created_at', 'desc').limit(count).select('id')) as { id: string }[];
      await this.db('password_history').where({ user_id: u.user_id }).whereNotIn('id', keep.map((k) => k.id)).delete();
    }
  }

  /** Forgets an account's history (the account was deleted). */
  async forgetUser(userId: string): Promise<void> {
    if (await this.available()) await this.db('password_history').where({ user_id: userId }).delete();
  }

  // ---------- sign-in ----------

  /** When the local password was last set (local_credentials.updated_at), or null for a directory account. */
  async passwordSetAt(userId: string): Promise<number | null> {
    const r = (await this.db('local_credentials').where({ user_id: userId }).first('updated_at')) as { updated_at: number | null } | undefined;
    return r?.updated_at == null ? null : Number(r.updated_at);
  }

  /**
   * After a correct local password at sign-in: whether the person must change it before anything else, and why. The
   * sign-in is never refused for it. Without a tenant policy only the leaked-password check (B-193) may ask.
   */
  async atSignIn(tenantId: string, user: { id: string; username: string }, password: string): Promise<{ change: ChangeReason | null; blocked?: boolean }> {
    const pol = await this.effective(tenantId);
    if (pol.configured) {
      if (!checkPasswordPolicy(password, user.username, pol.password).ok) return { change: 'policy' };
      if (pol.password.expiryDays > 0) {
        const at = await this.passwordSetAt(user.id);
        if (at != null && Date.now() - at > pol.password.expiryDays * 86_400_000) return { change: 'expired' };
      }
    }
    const leaked = (this.s() as unknown as PasswordCheckHosts).leakedPasswords;
    if (leaked?.atSignIn) {
      const r = await leaked.atSignIn(tenantId, user.id, password).catch(() => null);
      if (r && !('unavailable' in r) && r.found) {
        if (r.action === 'block') return { change: null, blocked: true };
        if (r.action === 'require_change') return { change: 'leaked' };
      }
    }
    return { change: null };
  }

  // ---------- "what applies to this person" ----------

  async whatApplies(tenantId: string, userId: string) {
    const s = this.s();
    const user = await s.users.get(tenantId, userId);
    if (!user) return null;
    const [pol, home, roles, idp, methods] = await Promise.all([this.effective(tenantId), s.account.passwordHome(tenantId, userId), s.users.roleIds(userId), s.identityPolicy.get(tenantId), s.mfa.methods(userId)]);
    const setAt = home.kind === 'local' ? await this.passwordSetAt(userId) : null;
    const roleNeedsMfa = rolesRequireMfa(roles, tenantId);
    const tenantNeed = s.identityPolicy.mfaRequirement(idp, user, roles);
    const allowedKinds = new Set(pol.mfaMethods.map((m) => FACTOR_KIND[m] as string));
    return {
      user: { id: user.id, username: user.username, displayName: user.display_name },
      configured: pol.configured,
      password: {
        managedHere: home.kind === 'local',
        stores: home.kind === 'directory' ? home.stores.map((x) => x.name) : [],
        mustChange: home.kind === 'local' ? home.mustChange : false,
        setAt,
        expiresAt: setAt != null && pol.password.expiryDays > 0 ? setAt + pol.password.expiryDays * 86_400_000 : null,
        rules: pol.password
      },
      lockout: pol.lockout,
      sessions: pol.sessions,
      mfa: {
        required: !!user.mfa_required || roleNeedsMfa || tenantNeed.required,
        why: roleNeedsMfa ? 'role' : user.mfa_required ? 'account' : tenantNeed.required ? 'tenant policy' : tenantNeed.enrolBy ? 'tenant policy, in its grace period' : null,
        enrolBy: tenantNeed.enrolBy,
        allowed: pol.mfaMethods,
        enrolled: methods.filter((m) => m !== 'recovery'),
        notAllowed: methods.filter((m) => m !== 'recovery' && !allowedKinds.has(m))
      },
      sources: pol.sources
    };
  }
}
