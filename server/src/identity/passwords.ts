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
  dummy ??= hashPassword(Math.random().toString(36));
  await verifyPassword(await dummy, password);
}

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: string;
}

/** NIST SP 800-63B style: length over composition rules; reject the username and trivially weak values. */
export function checkPasswordPolicy(password: string, username: string): PasswordPolicyResult {
  if (password.length < 12) return { ok: false, reason: 'Use at least 12 characters.' };
  if (password.length > 256) return { ok: false, reason: 'Use at most 256 characters.' };
  if (password.toLowerCase().includes(username.toLowerCase())) return { ok: false, reason: 'The password must not contain the username.' };
  if (/^(.)\1+$/.test(password)) return { ok: false, reason: 'The password is a single repeated character.' };
  return { ok: true };
}
