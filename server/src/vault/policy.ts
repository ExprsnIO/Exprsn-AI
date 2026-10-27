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

/**
 * `service` (1.7.0, B-9201) names an internal caller; it exists in the platform scope only. `social_group` (1.7.0,
 * B-9803) names a social group by id: its members while they count as members (groups/subjects.ts). `group` stays a
 * directory group from the user stores, by normalised name.
 */
export const SUBJECT_KINDS = ['user', 'group', 'workspace', 'api_key', 'service', 'social_group'] as const;
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
  /** 1.6.0 (B-4801): the KV secret this grant shares (a share is a grant of read on its path), and when it ends. */
  shareSecretId?: string | null;
  expiresAt?: number | null;
}

/** Who the caller is, for policy purposes. An API key acts as its owner plus itself. */
export interface Subjects {
  userId: string | null;
  /** Normalised directory group names from the caller's user stores. */
  groups: string[];
  /** Workspaces the caller is a member of. */
  workspaces: string[];
  apiKeyId: string | null;
  /** 1.7.0 (B-9201): the internal service reading the platform scope, such as `federation.oidc`. */
  service?: string | null;
  /** 1.7.0 (B-9803): ids of the social groups the caller counts as a member of now. */
  socialGroups?: string[];
}

/**
 * 1.7.0 (B-9201): the vault's platform scope. Its rows carry this in `tenant_id` (no tenant has it: tenant ids are
 * ULIDs), its policy paths start with `sys/`, and it is sealed under the platform data key.
 */
export const SYS_SCOPE = 'platform';
export const SYS_PREFIX = 'sys';
export const sysPath = (path: string): string => `${SYS_PREFIX}/${path}`;
export const isSysPath = (path: string): boolean => path === SYS_PREFIX || path.startsWith(SYS_PREFIX + '/');

// Lower case only: paths compare the same way on every database (MySQL's default collation ignores case).
const SEGMENT = /^[a-z0-9._-]{1,100}$/;

/**
 * A vault path: `kv/<segments>`, `transit/<name>`, (Sprint 25, B-1704) `database/<engine>/<role>` or (1.7.0, B-9301)
 * `apikey/<provider>/<role>`. Segments are lower-case letters, digits, dot, dash and underscore.
 */
export function isVaultPath(path: string): boolean {
  if (path.length > 400) return false;
  const parts = path.split('/');
  if (parts[0] !== 'kv' && parts[0] !== 'transit' && parts[0] !== 'database' && parts[0] !== 'apikey') return false;
  return parts.slice(1).every((p) => SEGMENT.test(p) && p !== '.' && p !== '..');
}

/** 1.7.0 (B-9201): a path of the platform scope: `sys`, or `sys/` and a vault path (`sys/transit/session`). */
export function isSysVaultPath(path: string): boolean {
  if (path === SYS_PREFIX) return true;
  return path.startsWith(SYS_PREFIX + '/') && (['kv', 'transit', 'database'].includes(path.slice(4)) || isVaultPath(path.slice(4)));
}

/** A grant prefix: `*`, `kv`, `transit`, `database`, `apikey`, or a vault path. */
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
    case 'service':
      return s.service != null && g.subject === s.service;
    case 'social_group':
      return (s.socialGroups ?? []).includes(g.subject);
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
/** 1.7.0 (B-9301): `read` issues an API-key lease for a role, `list` shows the role. */
export const APIKEY_CAPABILITIES: readonly Capability[] = ['list', 'read'];
export const apiKeyPolicyPath = (provider: string, role: string): string => `apikey/${provider}/${role}`;

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

/**
 * 1.7.0 (B-9301): the reference that takes an API-key lease: `vault:apikey:<provider>/<role>#key`. Each read of it
 * issues a fresh key. The colon keeps it apart from every KV path, whose segments have none.
 */
export const APIKEY_REF = /^vault:apikey:([a-z0-9][a-z0-9._-]{0,63})\/([a-z0-9][a-z0-9._-]{0,63})#key$/;

export function parseApiKeyRef(ref: string): { provider: string; role: string } | null {
  const m = APIKEY_REF.exec(ref);
  return m ? { provider: m[1]!, role: m[2]! } : null;
}

/** A reference a feature may resolve at use: a KV value, or an API-key lease. */
export const isSecretRef = (ref: string): boolean => parseVaultRef(ref) != null || parseApiKeyRef(ref) != null;

export const isVaultRef = (v: unknown): boolean => typeof v === 'string' && v.startsWith('vault:');
