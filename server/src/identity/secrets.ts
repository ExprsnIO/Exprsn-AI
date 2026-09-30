import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * What a secret reference may point at. Tenant admins write references (user stores, upstream IdPs), so the operator
 * decides which environment variables and directories they can reach, and the server's own secrets are never
 * reachable: an LDAP bind or SQL test-login would otherwise hand them to whoever controls the far end.
 */
export interface SecretPolicy {
  /** Allowed `env:` names; an entry ending in `*` is a prefix. */
  envAllow: string[];
  /** Names that are refused even when allowed (the server's own configuration). */
  envDeny: ReadonlySet<string>;
  /** Directories (absolute, real paths) that `file:` references must resolve inside. */
  dirs: string[];
  /** Real paths of files that are never readable (the server's own secret files). */
  fileDeny: ReadonlySet<string>;
}

const list = (spec: string) => spec.split(',').map((x) => x.trim()).filter(Boolean);

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Builds the policy from configuration: `SECRET_REF_ENV`, `SECRET_REF_DIRS`, the server's own names and `*_FILE` secrets. */
export function secretPolicy(input: { envAllow: string; dirs: string; serverEnvNames: ReadonlySet<string>; serverSecretFiles: (string | undefined)[] }): SecretPolicy {
  return {
    envAllow: list(input.envAllow),
    envDeny: input.serverEnvNames,
    // Both spellings of each directory: the lexical check at save time sees the path as written (e.g. /var on macOS,
    // which is really /private/var); the check at read time sees the real path.
    dirs: [...new Set(list(input.dirs).filter((d) => path.isAbsolute(d)).flatMap((d) => [path.resolve(d), real(d)]))],
    fileDeny: new Set(input.serverSecretFiles.filter((f): f is string => !!f).map(real))
  };
}

/** Refuses everything until the server configures a policy (createServices does, from the configuration). */
let active: SecretPolicy = { envAllow: [], envDeny: new Set(), dirs: [], fileDeny: new Set() };

export function configureSecretPolicy(p: SecretPolicy): void {
  active = p;
}

const envAllowed = (name: string, p: SecretPolicy) => !p.envDeny.has(name) && p.envAllow.some((a) => (a.endsWith('*') ? name.startsWith(a.slice(0, -1)) : name === a));

const insideDirs = (file: string, p: SecretPolicy) => p.dirs.some((d) => file === d || file.startsWith(d.endsWith(path.sep) ? d : d + path.sep));

/**
 * Why a reference is not allowed, or null when it is. Checked when a store is saved (lexically, so the admin hears
 * at once) and again when it is read (on the real path, so a symlink cannot lead outside the directories).
 */
export function secretRefProblem(ref: string, p: SecretPolicy = active): string | null {
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    if (p.envDeny.has(name)) return `${name} is one of the server's own settings and cannot be referenced.`;
    if (!envAllowed(name, p)) return `env:${name} is not on the operator's list of referenceable variables (SECRET_REF_ENV).`;
    return null;
  }
  if (ref.startsWith('file:')) {
    const file = ref.slice(5);
    if (!path.isAbsolute(file)) return 'file: references need an absolute path.';
    const norm = path.resolve(file);
    if (p.fileDeny.has(norm) || p.fileDeny.has(real(norm))) return `${file} holds one of the server's own secrets and cannot be referenced.`;
    if (!insideDirs(norm, p)) return `${file} is outside the directories secrets may be read from (SECRET_REF_DIRS).`;
    return null;
  }
  return 'Secret references must start with env: or file:';
}

/** Resolves an `env:NAME` or `file:/path` reference. Values are read at use time so rotation needs no restart. */
export function resolveSecret(ref: string, env: NodeJS.ProcessEnv = process.env, p: SecretPolicy = active): string {
  const problem = secretRefProblem(ref, p);
  if (problem) throw new Error(`Secret ${ref} is not allowed: ${problem}`);
  if (ref.startsWith('env:')) {
    const v = env[ref.slice(4)];
    if (v == null || v === '') throw new Error(`Secret ${ref} is not set`);
    return v;
  }
  const file = real(ref.slice(5));
  if (p.fileDeny.has(file) || !insideDirs(file, p)) throw new Error(`Secret ${ref} is not allowed: it resolves outside the permitted directories.`);
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`Secret ${ref} could not be read`);
  }
}
