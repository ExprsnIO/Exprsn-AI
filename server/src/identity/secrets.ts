import { readFileSync } from 'node:fs';

/** Resolves an `env:NAME` or `file:/path` reference. Values are read at use time so rotation needs no restart. */
export function resolveSecret(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const v = env[name];
    if (v == null || v === '') throw new Error(`Secret ${ref} is not set`);
    return v;
  }
  if (ref.startsWith('file:')) {
    try {
      return readFileSync(ref.slice(5), 'utf8').trim();
    } catch {
      throw new Error(`Secret ${ref} could not be read`);
    }
  }
  throw new Error('Secret references must start with env: or file:');
}
