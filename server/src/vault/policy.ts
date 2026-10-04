/*
 * Vault path policies (B-1703). A grant allows or denies a list of capabilities on a path prefix to one subject: a
 * user, a directory group, a workspace (its members) or an API key. Evaluation for one request:
 *
 *   1. Keep the grants whose subject is the caller and whose prefix covers the path (on a segment boundary: `kv/apps`
 *      covers `kv/apps` and `kv/apps/db`, never `kv/apps2`; `*` covers every path) and whose capabilities include
 *      the one asked for (or `*`).
 *   2. Any matching deny refuses, however specific the allows are: deny wins. The deciding grant is the deny with the
 *      longest prefix.
 *   3. Otherwise the allow with the longest prefix decides.
 *   4. No matching grant: refused (default deny).
 *
 * `explainGrants` reports every grant that names the caller and covers the path, with whether it applies to the
 * capability, and names the deciding one. These functions are pure; the service collects the caller's subjects.
 */

export const CAPABILITIES = ['list', 'read', 'write', 'delete', 'destroy', 'encrypt', 'decrypt', 'rewrap', 'sign', 'verify', 'manage'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const SUBJECT_KINDS = ['user', 'group', 'workspace', 'api_key'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export type Effect = 'allow' | 'deny';

export interface Grant {
  id: string;
  subjectKind: SubjectKind;
  subject: string;
  /** A path prefix (`kv/...` or `transit/...`), or `*` for every path. */
  path: string;
  capabilities: (Capability | '*')[];
  effect: Effect;
  description?: string | null;
}

/** Who the caller is, for policy purposes. An API key acts as its owner plus itself. */
export interface Subjects {
  userId: string | null;
  /** Normalised directory group names from the caller's user stores. */
  groups: string[];
  /** Workspaces the caller is a member of. */
  workspaces: string[];
  apiKeyId: string | null;
}

// Lower case only: paths compare the same way on every database (MySQL's default collation ignores case).
const SEGMENT = /^[a-z0-9._-]{1,100}$/;

/**
 * A vault path: `kv/<segments>`, `transit/<name>` or (Sprint 25, B-1704) `database/<engine>/<role>`. Segments are
 * lower-case letters, digits, dot, dash and underscore.
 */
export function isVaultPath(path: string): boolean {
  if (path.length > 400) return false;
  const parts = path.split('/');
  if (parts[0] !== 'kv' && parts[0] !== 'transit' && parts[0] !== 'database') return false;
  return parts.slice(1).every((p) => SEGMENT.test(p) && p !== '.' && p !== '..');
}

/** A grant prefix: `*`, `kv`, `transit`, `database`, or a vault path. */
export const isGrantPath = (path: string): boolean => path === '*' || isVaultPath(path);

/** Does the prefix cover the path, on a segment boundary? */
export function prefixCovers(prefix: string, path: string): boolean {
  if (prefix === '*') return true;
  return path === prefix || path.startsWith(prefix + '/');
}

/** Specificity of a prefix: `*` is the least specific. */
const specificity = (prefix: string): number => (prefix === '*' ? 0 : prefix.split('/').length);

export function subjectMatches(g: Pick<Grant, 'subjectKind' | 'subject'>, s: Subjects): boolean {
  switch (g.subjectKind) {
    case 'user':
      return s.userId != null && g.subject === s.userId;
    case 'group':
      return s.groups.includes(g.subject);
    case 'workspace':
      return s.workspaces.includes(g.subject);
    case 'api_key':
      return s.apiKeyId != null && g.subject === s.apiKeyId;
  }
}

const covers = (g: Grant, cap: Capability): boolean => g.capabilities.includes('*') || g.capabilities.includes(cap);

/** Most specific first; among equals, deny before allow, then by id so the answer is stable. */
const order = (a: Grant, b: Grant): number => specificity(b.path) - specificity(a.path) || (a.effect === b.effect ? 0 : a.effect === 'deny' ? -1 : 1) || a.id.localeCompare(b.id);

export interface PolicyDecision {
  allow: boolean;
  capability: Capability;
  path: string;
  /** The grant that decided, or null when nothing matched (default deny). */
  grant: Grant | null;
  reason: string;
}

const describe = (g: Grant): string => `${g.effect} ${g.capabilities.join(',')} on ${g.path} to ${g.subjectKind.replace('_', ' ')} ${g.subject}`;

export function evaluate(grants: readonly Grant[], subjects: Subjects, path: string, capability: Capability): PolicyDecision {
  const hits = grants.filter((g) => subjectMatches(g, subjects) && prefixCovers(g.path, path) && covers(g, capability)).sort(order);
  const deny = hits.find((g) => g.effect === 'deny');
  if (deny) return { allow: false, capability, path, grant: deny, reason: `Denied by grant ${deny.id} (${describe(deny)}); a deny wins over any allow` };
  const allow = hits[0];
  if (allow) return { allow: true, capability, path, grant: allow, reason: `Allowed by grant ${allow.id} (${describe(allow)})` };
  return { allow: false, capability, path, grant: null, reason: `No vault policy grants ${capability} on ${path}` };
}

export interface ExplainedGrant {
  grant: Grant;
  /** Whether the grant lists the capability asked about. */
  appliesToCapability: boolean;
  deciding: boolean;
}

/** The decision plus every grant naming the caller that covers the path, most specific first. */
export function explainGrants(grants: readonly Grant[], subjects: Subjects, path: string, capability: Capability): { decision: PolicyDecision; grants: ExplainedGrant[] } {
  const decision = evaluate(grants, subjects, path, capability);
  const relevant = grants.filter((g) => subjectMatches(g, subjects) && prefixCovers(g.path, path)).sort(order);
  return { decision, grants: relevant.map((g) => ({ grant: g, appliesToCapability: covers(g, capability), deciding: decision.grant?.id === g.id })) };
}

/** Capabilities that apply to each part of the vault, for validating grants and for the explain view. */
export const KV_CAPABILITIES: readonly Capability[] = ['list', 'read', 'write', 'delete', 'destroy'];
export const TRANSIT_CAPABILITIES: readonly Capability[] = ['list', 'encrypt', 'decrypt', 'rewrap', 'sign', 'verify', 'manage'];
/** Sprint 25 (B-1704): `read` issues a database lease for a role, `list` shows the engine's roles. */
export const DATABASE_CAPABILITIES: readonly Capability[] = ['list', 'read'];

export const kvPolicyPath = (path: string): string => `kv/${path}`;
export const transitPolicyPath = (name: string): string => `transit/${name}`;
export const databasePolicyPath = (engine: string, role: string): string => `database/${engine}/${role}`;

/** A KV path as callers write it (without the `kv/` namespace): one to sixteen segments. */
export function isKvPath(path: string): boolean {
  const parts = path.split('/');
  return parts.length >= 1 && parts.length <= 16 && isVaultPath(kvPolicyPath(path));
}

/** The text form of a reference: `vault:<kv path>#<key>`. */
export const VAULT_REF = /^vault:([^#]+)#([A-Za-z0-9_.-]{1,128})$/;

/** A `vault:<path>#<key>` reference (B-1705 resolves these against the same policies). */
export function parseVaultRef(ref: string): { path: string; key: string } | null {
  const m = VAULT_REF.exec(ref);
  if (!m || !isKvPath(m[1]!)) return null;
  return { path: m[1]!, key: m[2]! };
}

export const isVaultRef = (v: unknown): boolean => typeof v === 'string' && v.startsWith('vault:');
