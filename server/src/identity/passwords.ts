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
