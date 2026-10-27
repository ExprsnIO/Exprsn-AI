import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';

/** Parameters follow the OWASP password storage recommendation for argon2id. */
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => argon2.hash(password, ARGON2_OPTS);

export type HashScheme = 'argon2' | 'bcrypt' | 'unsupported';

export function hashScheme(hash: string): HashScheme {
  if (hash.startsWith('$argon2')) return 'argon2';
  if (/^\$2[aby]\$\d{2}\$/.test(hash)) return 'bcrypt';
  return 'unsupported';
}

/** Verifies against argon2 or bcrypt hashes. Unknown schemes (plain text, unsalted digests) never verify. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    switch (hashScheme(hash)) {
      case 'argon2':
        return await argon2.verify(hash, password);
      case 'bcrypt':
        return await bcrypt.compare(password, hash);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// A real hash of a random value, so that "no such user" costs the same as a wrong password.
let dummy: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(18).toString('base64url'));
  await verifyPassword(await dummy, password);
}

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Passwords of 12 or more characters that lead public breach corpora (ASVS 2.1.7). A short local list: it stops the
 * obvious choices without a network call, and is no substitute for a full breached-password check.
 */
const COMMON_PASSWORDS = new Set([
  '123456789012', '1234567890123', '12345678901234', '123456123456', '123123123123', '111111111111', '000000000000',
  '123456654321', '1q2w3e4r5t6y', '1qaz2wsx3edc', 'qwertyuiop12', 'qwertyuiop123', 'qwerty123456', 'qwertyqwerty',
  'qwe123qwe123', 'asdfghjkl123', 'zxcvbnm12345', 'abcdefghijkl', 'abc123abc123', 'abcd12345678', 'password1234',
  'password12345', 'password123!', 'passwordpassword', 'p@ssw0rd1234', 'p@ssword1234', 'passw0rd1234', 'iloveyou1234',
  'administrator', 'administrator1', 'admin1234567', 'adminadmin123', 'welcome12345', 'welcome123456', 'changeme1234',
  'letmein12345', 'football1234', 'baseball1234', 'princess1234', 'sunshine1234', 'superman1234', 'starwars1234',
  'trustno11234', 'monkey123456', 'dragon123456', 'master123456', 'whatever1234', 'computer1234', 'internet1234',
  'correcthorsebatterystaple', 'thequickbrownfox', 'qazwsxedcrfv', '1qazxsw23edc', 'zaq12wsxcde3', 'q1w2e3r4t5y6',
  'a1b2c3d4e5f6', 'aa123456789012', 'secret123456', 'mypassword123', 'letmeinplease', 'iloveyouforever'
]);

/** Words tied to this service that make a password guessable (ASVS 2.1.7 context-specific words). */
const CONTEXT_WORDS = ['exprsn', 'exprsnai'];

/**
 * 1.9.0 (B-190): the length and character-class part of a tenant's sign-in policy. The platform floor of 12 is never
 * lowered; character classes are off by default (NIST SP 800-63B prefers length to composition rules).
 */
export interface PasswordRuleSettings {
  minLength: number;
  maxLength: number;
  requireLower: boolean;
  requireUpper: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

/** The shortest password any tenant may allow. */
export const PASSWORD_FLOOR = 12;

/** Today's rules: 12 to 256 characters, no composition rules. A tenant without a policy gets exactly these. */
export const DEFAULT_PASSWORD_RULES: Readonly<PasswordRuleSettings> = Object.freeze({ minLength: PASSWORD_FLOOR, maxLength: 256, requireLower: false, requireUpper: false, requireDigit: false, requireSymbol: false });

const SYMBOL = /[^\p{L}\p{N}\s]/u;
const isCommon = (lower: string): boolean => COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lower.replace(/\s+/g, ''));
const hasServiceName = (lower: string): boolean => CONTEXT_WORDS.some((w) => lower.replace(/[^a-z]/g, '').includes(w));

/**
 * NIST SP 800-63B style: length over composition rules; reject the username, common and context-specific values. With
 * `rules` (a tenant's policy) the length bounds and any character classes it turned on apply too; the floor holds.
 */
export function checkPasswordPolicy(password: string, username: string, rules: PasswordRuleSettings = DEFAULT_PASSWORD_RULES): PasswordPolicyResult {
  const failed = passwordRules(password, username, rules).find((r) => !r.ok);
  if (!failed) return { ok: true };
  return { ok: false, reason: REASONS[failed.id](rules) };
}

const REASONS: Record<PasswordRule['id'], (r: PasswordRuleSettings) => string> = {
  length: (r) => `Use at least ${Math.max(PASSWORD_FLOOR, r.minLength)} characters.`,
  max: (r) => `Use at most ${r.maxLength} characters.`,
  username: () => 'The password must not contain the username.',
  repeated: () => 'The password is a single repeated character.',
  common: () => 'This password is one of the most common ones. Choose another.',
  service: () => 'The password must not contain the name of this service.',
  lower: () => 'Include a lower-case letter.',
  upper: () => 'Include an upper-case letter.',
  digit: () => 'Include a digit.',
  symbol: () => 'Include a symbol (a character that is not a letter, digit or space).'
};

// ---------- Sprint 17 (B-802): strength meter ----------

export interface PasswordRule {
  id: 'length' | 'max' | 'username' | 'repeated' | 'common' | 'service' | 'lower' | 'upper' | 'digit' | 'symbol';
  label: string;
  ok: boolean;
}

/**
 * The policy's rules one by one, for the console's strength meter and for checkPasswordPolicy (one list, so the meter
 * and the check never disagree). Character-class rules appear only when the tenant's policy turns them on.
 */
export function passwordRules(password: string, username: string, rules: PasswordRuleSettings = DEFAULT_PASSWORD_RULES): PasswordRule[] {
  const lower = password.toLowerCase();
  const min = Math.max(PASSWORD_FLOOR, rules.minLength);
  const out: PasswordRule[] = [
    { id: 'length', label: `At least ${min} characters`, ok: password.length >= min },
    { id: 'max', label: `At most ${rules.maxLength} characters`, ok: password.length <= rules.maxLength },
    { id: 'username', label: 'Does not contain the username', ok: !username || !lower.includes(username.toLowerCase()) },
    { id: 'repeated', label: 'Not one repeated character', ok: !/^(.)\1+$/.test(password) },
    { id: 'common', label: 'Not one of the most common passwords', ok: !isCommon(lower) },
    { id: 'service', label: 'Does not contain the name of this service', ok: !hasServiceName(lower) }
  ];
  if (rules.requireLower) out.push({ id: 'lower', label: 'A lower-case letter', ok: /\p{Ll}/u.test(password) });
  if (rules.requireUpper) out.push({ id: 'upper', label: 'An upper-case letter', ok: /\p{Lu}/u.test(password) });
  if (rules.requireDigit) out.push({ id: 'digit', label: 'A digit', ok: /\p{N}/u.test(password) });
  if (rules.requireSymbol) out.push({ id: 'symbol', label: 'A symbol', ok: SYMBOL.test(password) });
  return out;
}

// ---------- 1.9.0 (B-190): "not too close to the old password" ----------

/** Levenshtein distance, two rows; inputs are capped by the routes (1,024 characters). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** The longest run of characters the two share (dynamic programming, one row). */
function longestSharedRun(a: string, b: string): number {
  let best = 0;
  let row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const next = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) best = Math.max(best, (next[j] = row[j - 1]! + 1));
    row = next;
  }
  return best;
}

const normalise = (p: string): string => p.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/**
 * Whether a new password is too close to the old one: compared case- and space-insensitively, an edit distance of at
 * most a quarter of the longer one (and never under 3), or most of the old password kept as one run (three
 * quarters of it, and at least 8 characters). "Summer-2025!" to "Summer-2026!" is too close; a new passphrase is not.
 */
export function tooSimilar(previous: string, next: string): boolean {
  const a = normalise(previous);
  const b = normalise(next);
  if (!a || !b) return false;
  if (a === b) return true;
  if (editDistance(a, b) <= Math.max(3, Math.floor(Math.max(a.length, b.length) / 4))) return true;
  const run = longestSharedRun(a, b);
  return run >= 8 && run >= Math.ceil(a.length * 0.75);
}

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * A rough entropy estimate: the character pool raised to the length, where characters that repeat the one before,
 * continue a run (abc, 123, qwe, in either direction) or belong to a common or context word count for little.
 * It is guidance for people, not a guarantee; the policy and the breached check are what refuse a password.
 */
export function estimateStrength(password: string, username: string): { bits: number; score: 0 | 1 | 2 | 3 | 4; label: string } {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(password)) pool += 33;
  if (/[^\x20-\x7e]/.test(password)) pool += 100;
  const lower = password.toLowerCase();
  let effective = 0;
  for (let i = 0; i < password.length; i++) {
    const prev = lower[i - 1];
    const cur = lower[i]!;
    if (prev === cur) {
      effective += 0.1;
      continue;
    }
    const run = prev !== undefined && SEQUENCES.some((seq) => {
      const a = seq.indexOf(prev);
      const b = seq.indexOf(cur);
      return a >= 0 && b >= 0 && Math.abs(a - b) === 1;
    });
    effective += run ? 0.25 : 1;
  }
  let bits = effective * Math.log2(Math.max(pool, 1));
  const rules = passwordRules(password, username);
  if (!rules.find((r) => r.id === 'common')!.ok || !rules.find((r) => r.id === 'repeated')!.ok) bits = Math.min(bits, 10);
  if (!rules.find((r) => r.id === 'username')!.ok || !rules.find((r) => r.id === 'service')!.ok) bits = Math.min(bits, 20);
  bits = Math.round(bits);
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { bits, score, label: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'][score]! };
}

// ---------- 1.9.0 (B-190 with B-193, B-194): the checks after the policy ----------

/**
 * What the leaked-password check (B-193) answers. Its rules are its own: with `action` it says what to do with a
 * password found on a list (`block` refuses it, `warn` accepts it with a warning, `accept` says nothing; at a password
 * set, `require_change` refuses it like `block`) and with an unavailable list whether to fail open (`accept`, audited)
 * or closed (`block`). Without `action`: found blocks, unavailable fails open, as the BREACHED_* check always did.
 */
export type LeakedPasswordResult =
  | { found: boolean; action?: 'accept' | 'warn' | 'require_change' | 'block'; message?: string }
  | { unavailable: true; action?: 'accept' | 'block'; reason?: string };

/**
 * `s.leakedPasswords` (B-193). When it is present it replaces the BREACHED_* check in the password pipeline, so it
 * must cover those sources too. `atSignIn`, when given, runs after a correct password at sign-in: `require_change`
 * signs the person in and asks them to change it (never a lockout), `block` refuses the sign-in.
 */
export interface LeakedPasswordCheck {
  check(tenantId: string, password: string): Promise<LeakedPasswordResult>;
  atSignIn?(tenantId: string, userId: string, password: string): Promise<LeakedPasswordResult>;
}

/** `s.passwordDenyWords` (B-194): a word the tenant forbids inside passwords, normalised by the check itself. */
export interface DenyWordResult {
  found: boolean;
  term?: string;
}

export interface PasswordDenyWordCheck {
  check(tenantId: string, password: string): Promise<DenyWordResult>;
}

/**
 * The two checks as the password pipeline finds them on the services object. They are optional and typed narrowly
 * here, so this file builds whether or not they exist yet; without them the pipeline behaves as before (no deny
 * words, the BREACHED_* check).
 */
export interface PasswordCheckHosts {
  leakedPasswords?: LeakedPasswordCheck;
  passwordDenyWords?: PasswordDenyWordCheck;
}
