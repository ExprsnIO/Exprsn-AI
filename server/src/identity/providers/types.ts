import { z } from 'zod';
import { LABELS } from '../../authz/labels.js';

export interface ExternalUser {
  /** Stable id inside the store: the LDAP DN or the SQL row key. The link to our user row. */
  externalId: string;
  username: string;
  displayName: string;
  email: string | null;
  groups: string[];
}

export type AuthResult =
  | { status: 'ok'; user: ExternalUser }
  /** The store has no such user; the chain moves on to the next store. */
  | { status: 'not_found' }
  /** The store owns the user and rejected the password; the chain stops here. */
  | { status: 'invalid' }
  /** The store owns the user and marks them disabled; the chain stops here. */
  | { status: 'disabled' }
  /** The store could not be asked (network, TLS, config); the chain moves on but the failure is reported. */
  | { status: 'error'; message: string };

export interface Step {
  title: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

export interface IdentityProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  authenticate(username: string, password: string, steps?: Step[]): Promise<AuthResult>;
  /** Looks a user up without a password (directory sync, admin "test login" lookups). */
  lookup(username: string, steps?: Step[]): Promise<ExternalUser | null>;
  /** Checks connectivity and configuration. */
  test(steps: Step[]): Promise<boolean>;
  close(): Promise<void>;
}

export const PROVIDER_KINDS = ['local', 'ldap', 'sql'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** A secret is referenced, never stored: `env:NAME` or `file:/absolute/path`. */
export const secretRef = z
  .string()
  .regex(/^(env:[A-Z_][A-Z0-9_]*|file:\/.+)$/, 'Use a secret reference: env:NAME or file:/absolute/path');

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/, 'Must be a plain SQL identifier');

const common = {
  /** Roles given when no group mapping matches (for stores without groups). Admin roles cannot be defaults. */
  defaultRoles: z.array(z.enum(['member', 'auditor', 'flag-reviewer', 'knowledge-curator'])).default([]),
  defaultClearance: z.enum(LABELS).default('internal')
};

export const localConfigSchema = z.object({ ...common }).strict();

export const ldapConfigSchema = z
  .object({
    ...common,
    url: z.string().regex(/^ldaps?:\/\/[^\s]+$/, 'ldap:// or ldaps:// URL'),
    startTLS: z.boolean().default(false),
    /** Development only: plain ldap:// without StartTLS. Refused when NODE_ENV=production. */
    allowInsecure: z.boolean().default(false),
    caFile: z.string().optional(),
    bindDN: z.string().min(1),
    bindPassword: secretRef,
    userBase: z.string().min(1),
    userFilter: z.string().default('(&(objectClass=inetOrgPerson)(uid={{username}}))').refine((f) => f.includes('{{username}}'), 'userFilter must contain {{username}}'),
    usernameAttribute: z.string().default('uid'),
    displayNameAttribute: z.string().default('cn'),
    emailAttribute: z.string().default('mail'),
    groupMode: z.enum(['memberOf', 'search']).default('search'),
    groupBase: z.string().optional(),
    groupFilter: z.string().default('(|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}}))'),
    groupNameAttribute: z.enum(['dn', 'cn']).default('dn'),
    timeoutMs: z.number().int().min(500).max(30000).default(5000)
  })
  .strict()
  .refine((c) => c.groupMode !== 'search' || !!c.groupBase, { message: 'groupBase is required when groupMode is search', path: ['groupBase'] });

export const sqlConfigSchema = z
  .object({
    ...common,
    dialect: z.enum(['pg', 'mysql', 'sqlite']),
    /** Connection URL (pg/mysql) or file path (sqlite), as a secret reference. */
    connection: secretRef,
    table: identifier,
    columns: z
      .object({
        id: identifier.optional(),
        username: identifier,
        passwordHash: identifier,
        displayName: identifier.optional(),
        email: identifier.optional(),
        /** Truthy means disabled. */
        disabled: identifier.optional(),
        /** Comma-separated or JSON-array group list on the user row. */
        groups: identifier.optional()
      })
      .strict(),
    groupTable: z.object({ table: identifier, userColumn: identifier, groupColumn: identifier }).strict().optional(),
    caseInsensitive: z.boolean().default(true),
    timeoutMs: z.number().int().min(500).max(30000).default(5000)
  })
  .strict();

export type LocalConfig = z.infer<typeof localConfigSchema>;
export type LdapConfig = z.infer<typeof ldapConfigSchema>;
export type SqlConfig = z.infer<typeof sqlConfigSchema>;

export function parseProviderConfig(kind: ProviderKind, config: unknown): LocalConfig | LdapConfig | SqlConfig {
  switch (kind) {
    case 'local':
      return localConfigSchema.parse(config ?? {});
    case 'ldap':
      return ldapConfigSchema.parse(config);
    case 'sql':
      return sqlConfigSchema.parse(config);
  }
}

export const timed = async <T>(steps: Step[] | undefined, title: string, fn: () => Promise<T>, describe?: (v: T) => string): Promise<T> => {
  const t0 = performance.now();
  try {
    const v = await fn();
    steps?.push({ title, ok: true, ms: Math.round(performance.now() - t0), ...(describe ? { detail: describe(v) } : {}) });
    return v;
  } catch (err) {
    steps?.push({ title, ok: false, ms: Math.round(performance.now() - t0), detail: (err as Error).message });
    throw err;
  }
};
