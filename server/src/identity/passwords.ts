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

/** NIST SP 800-63B style: length over composition rules; reject the username, common and context-specific values. */
export function checkPasswordPolicy(password: string, username: string): PasswordPolicyResult {
  if (password.length < 12) return { ok: false, reason: 'Use at least 12 characters.' };
  if (password.length > 256) return { ok: false, reason: 'Use at most 256 characters.' };
  const lower = password.toLowerCase();
  if (lower.includes(username.toLowerCase())) return { ok: false, reason: 'The password must not contain the username.' };
  if (/^(.)\1+$/.test(password)) return { ok: false, reason: 'The password is a single repeated character.' };
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lower.replace(/\s+/g, ''))) return { ok: false, reason: 'This password is one of the most common ones. Choose another.' };
  if (CONTEXT_WORDS.some((w) => lower.replace(/[^a-z]/g, '').includes(w))) return { ok: false, reason: 'The password must not contain the name of this service.' };
  return { ok: true };
}

// ---------- Sprint 17 (B-802): strength meter ----------

export interface PasswordRule {
  id: 'length' | 'max' | 'username' | 'repeated' | 'common' | 'service';
  label: string;
  ok: boolean;
}

/** The policy's rules one by one, for the console's strength meter (the same checks as checkPasswordPolicy). */
export function passwordRules(password: string, username: string): PasswordRule[] {
  const lower = password.toLowerCase();
  return [
    { id: 'length', label: 'At least 12 characters', ok: password.length >= 12 },
    { id: 'max', label: 'At most 256 characters', ok: password.length <= 256 },
    { id: 'username', label: 'Does not contain the username', ok: !username || !lower.includes(username.toLowerCase()) },
    { id: 'repeated', label: 'Not one repeated character', ok: !/^(.)\1+$/.test(password) },
    { id: 'common', label: 'Not one of the most common passwords', ok: !(COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lower.replace(/\s+/g, ''))) },
    { id: 'service', label: 'Does not contain the name of this service', ok: !CONTEXT_WORDS.some((w) => lower.replace(/[^a-z]/g, '').includes(w)) }
  ];
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
