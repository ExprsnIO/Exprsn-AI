import { z } from 'zod';
import { LABELS } from '../../authz/labels.js';
import { secretRefProblem } from '../secrets.js';
import { scrubSecrets } from '../../platform/diagnostics.js';
import { isPermission } from '../../authz/permissions.js';
import { parsePemCertificates } from '../../federation/x509.js';

export interface ExternalUser {
  /** Stable id inside the store: the LDAP DN or the SQL row key. The link to our user row. */
  externalId: string;
  username: string;
  displayName: string;
  email: string | null;
  groups: string[];
  /** 1.5.0 (B-3305): the user's manager as the store names them (their external id there: an LDAP DN, a SQL row key). */
  manager?: string | null;
}

export type AuthResult =
  | { status: 'ok'; user: ExternalUser }
  /** The store has no such user; the chain moves on to the next store. */
  | { status: 'not_found' }
  /** The store owns the user and rejected the password; the chain stops here. */
  | { status: 'invalid'; reason?: StoreRefusal }
  /** The store owns the user and marks them disabled; the chain stops here. */
  | { status: 'disabled'; reason?: StoreRefusal }
  /** The store could not be asked (network, TLS, config); the chain moves on but the failure is reported. */
  | { status: 'error'; message: string };

/**
 * 1.9.0 (B-182): why a store refused an account it owns, when it says (Active Directory's bind codes and account
 * flags). `password_expired`, `must_change` and `account_expired` come only after the right password and may be shown
 * to the person; `locked` and `disabled` are for the audit and the admin's test only.
 */
export type StoreRefusal = 'password_expired' | 'must_change' | 'account_expired' | 'locked' | 'disabled';

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
  /**
   * 1.9.0 (B-182, B-183): looks a user up by their stable external id (AD objectGUID, a Graph or Google user id), so
   * directory sync follows a renamed account. Stores without it are looked up by username.
   */
  lookupById?(externalId: string, steps?: Step[]): Promise<ExternalUser | null>;
  /** Checks connectivity and configuration. */
  test(steps: Step[]): Promise<boolean>;
  close(): Promise<void>;
}

export const PROVIDER_KINDS = ['local', 'ldap', 'sql', 'oidc', 'saml', 'atproto', 'github', 'scim', 'ad', 'exprsn-platform'] as const;
/**
 * Upstream identity providers: sign-in is redirected to them; they take no passwords and have no directory to sync.
 * Sprint 26a (B-1804): GitHub is one, as an OAuth 2.0 store.
 */
export const FEDERATED_KINDS = ['oidc', 'saml', 'github'] as const;
export const isFederatedKind = (k: string): k is 'oidc' | 'saml' | 'github' => k === 'oidc' || k === 'saml' || k === 'github';
/** Sprint 26 (B-1808): stores that sign in by redirect and have no directory: upstream OIDC, SAML and GitHub, and AT-Protocol. */
export const signsInByRedirect = (k: string): boolean => isFederatedKind(k) || k === 'atproto' || k === 'exprsn-platform';
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * A secret is referenced, never stored: `env:NAME`, `file:/absolute/path` or (Sprint 25, B-1705) `vault:path#key`,
 * read from the tenant's vault as the user who saved the store.
 */
export const secretRef = z
  .string()
  .max(600)
  .regex(/^(env:[A-Z_][A-Z0-9_]*|file:\/.+|vault:[^#]+#[A-Za-z0-9_.-]{1,128})$/, 'Use a secret reference: env:NAME, file:/absolute/path or vault:path#key')
  .superRefine((ref, ctx) => {
    const problem = secretRefProblem(ref);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

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
    /** 1.5.0 (B-3305): the attribute holding the DN of the user's manager (access reviews assign them). */
    managerAttribute: z.string().default('manager'),
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
        groups: identifier.optional(),
        /** 1.5.0 (B-3305): the manager's key (the value of the id column, or the username when there is none). */
        manager: identifier.optional()
      })
      .strict(),
    groupTable: z.object({ table: identifier, userColumn: identifier, groupColumn: identifier }).strict().optional(),
    caseInsensitive: z.boolean().default(true),
    timeoutMs: z.number().int().min(500).max(30000).default(5000)
  })
  .strict();

const claimName = z.string().trim().min(1).max(200);

/** An upstream OpenID Connect provider (we are the relying party). */
export const oidcConfigSchema = z
  .object({
    ...common,
    issuer: z.url().refine((u) => /^https?:\/\//.test(u), 'http:// or https:// issuer'),
    clientId: z.string().trim().min(1).max(200),
    /** Absent for a public client (PKCE only). */
    clientSecret: secretRef.optional(),
    scopes: z.string().trim().max(500).default('openid profile email'),
    usernameClaim: claimName.default('preferred_username'),
    displayNameClaim: claimName.default('name'),
    emailClaim: claimName.default('email'),
    groupsClaim: claimName.default('groups'),
    /** 1.9.0 (B-183): the claim that links the account (default `sub`; Entra ID's `oid`, the id Graph knows). */
    subjectClaim: claimName.optional(),
    /** 1.9.0 (B-183): users and groups read from the provider's directory API (Microsoft Graph, Google Directory). */
    directory: z.lazy(() => cloudDirectorySchema).optional(),
    algs: z.array(z.enum(['RS256', 'ES256'])).min(1).default(['RS256', 'ES256'])
  })
  .strict();

/** An upstream SAML 2.0 identity provider (we are the service provider). */
export const samlConfigSchema = z
  .object({
    ...common,
    entityId: z.string().trim().min(1).max(1000),
    ssoUrl: z.url(),
    /** Sprint 14: the IdP's HTTP-Redirect single logout endpoint, from its metadata, when it has one. */
    sloUrl: z.url().optional(),
    /** Base64 DER signing certificates from the IdP metadata; assertions must be signed by one of them. */
    certificates: z.array(z.string().regex(/^[A-Za-z0-9+/=]+$/, 'Base64 DER certificate')).min(1).max(4),
    /** Empty means the NameID. */
    usernameAttribute: z.string().max(300).default(''),
    displayNameAttribute: z.string().max(300).default('displayName'),
    emailAttribute: z.string().max(300).default('email'),
    groupsAttribute: z.string().max(300).default('groups')
  })
  .strict();

/**
 * Sprint 26 (B-1808): AT-Protocol accounts (we are an OAuth client of each account's own authorization server). A DID
 * bound to a user (B-1807) signs in as that user; any other account is provisioned with its DID as its only group, so
 * group mappings name DIDs. `boundOnly` admits bound DIDs only; `authServers` (origins) limits which authorization
 * servers are accepted, for a tenant whose people all live on its own PDS. Empty: any.
 */
export const atprotoConfigSchema = z
  .object({
    ...common,
    boundOnly: z.boolean().default(false),
    authServers: z
      .array(z.url().refine((u) => /^https?:\/\/[^/]+\/?$/.test(u), 'An origin, such as https://pds.example.com'))
      .max(20)
      .default([])
      .transform((list) => list.map((u) => new URL(u).origin))
  })
  .strict();

export type AtprotoConfig = z.infer<typeof atprotoConfigSchema>;

const githubLogin = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})$/, 'A GitHub organisation login');

/**
 * Sprint 26a (B-1804): sign-in with GitHub (or GitHub Enterprise Server) as an OAuth 2.0 user store. Organisations
 * and teams become groups (`acme`, `acme/platform`) for the group mappings; `allowedOrgs` limits who may sign in.
 * The endpoints go through the service URL checks, at save and at every connection.
 */
export const githubConfigSchema = z
  .object({
    ...common,
    clientId: z.string().trim().min(1).max(200),
    clientSecret: secretRef,
    webUrl: z.url().refine((u) => /^https?:\/\//.test(u), 'http:// or https:// URL').default('https://github.com'),
    apiUrl: z.url().refine((u) => /^https?:\/\//.test(u), 'http:// or https:// URL').default('https://api.github.com'),
    /** Members of at least one of these organisations may sign in (empty: any GitHub account, then the mappings decide). */
    allowedOrgs: z.array(githubLogin).max(50).default([]),
    scopes: z.string().trim().max(200).default('read:user user:email read:org')
  })
  .strict();

export type GitHubConfig = z.infer<typeof githubConfigSchema>;

/**
 * 1.6.0, Sprint 37c (B-7201): a SCIM 2.0 store. An identity provider pushes users and groups to it at /scim/v2 with a
 * SCIM token; it takes no passwords. Its users sign in through the upstream stores named in `signInStores` (the OIDC,
 * SAML or GitHub store of the same provider): a sign-in there with the user's username signs in as the SCIM user, with
 * the roles the SCIM groups map to. Group mappings name the SCIM groups' display names, with this store as provider.
 */
export const scimConfigSchema = z
  .object({
    ...common,
    signInStores: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'A user store id')).max(10).default([])
  })
  .strict();

export type ScimConfig = z.infer<typeof scimConfigSchema>;
export type LocalConfig = z.infer<typeof localConfigSchema>;
export type OidcUpstreamConfig = z.infer<typeof oidcConfigSchema>;
export type SamlUpstreamConfig = z.infer<typeof samlConfigSchema>;
export type LdapConfig = z.infer<typeof ldapConfigSchema>;

// ---------- 1.9.0, Sprint 54 (B-182 to B-184) ----------

/** A credential of the new stores: a `vault:` reference only (never env: or file:). */
export const vaultSecretRef = secretRef.refine((r) => r.startsWith('vault:'), 'Use a vault reference: vault:path#key');

/** https://, or http:// on this host only (local stand-ins). */
const serviceUrl = z.url().refine((u) => /^https:\/\//i.test(u) || /^http:\/\/(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d+)?(\/|$)/i.test(u), 'https:// (http:// only on this host)');

/**
 * B-183: a cloud directory read with the client credentials grant (Microsoft Graph) or a service account's signed
 * assertion (Google Directory API, domain-wide delegation). Its users and groups join directory sync; the group
 * names it gives are the ones mappings name, at sign-in and at every sync.
 */
export const cloudDirectorySchema = z
  .object({
    api: z.enum(['msgraph', 'google']),
    tokenUrl: serviceUrl.optional(),
    apiUrl: serviceUrl.optional(),
    /** Graph: the app registration's client id and secret (client credentials). */
    clientId: z.string().trim().min(1).max(200).optional(),
    clientSecret: vaultSecretRef.optional(),
    /** Google: the service account's JSON key, and the admin it acts as. */
    serviceAccount: vaultSecretRef.optional(),
    subject: z.email().max(320).optional(),
    customer: z.string().trim().regex(/^[A-Za-z0-9_]{1,64}$/).optional(),
    scope: z.string().trim().max(1000).optional(),
    /** What a group is called in mappings: Graph `displayName` or `id`; Google `email` or `name`. */
    groupName: z.enum(['displayName', 'id', 'email', 'name']).optional(),
    /** Graph: only security groups (not Microsoft 365 groups). */
    securityGroupsOnly: z.boolean().optional()
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.api === 'msgraph') {
      if (!d.tokenUrl) ctx.addIssue({ code: 'custom', path: ['tokenUrl'], message: 'The token endpoint is required for Microsoft Graph (https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token).' });
      if (!d.clientId) ctx.addIssue({ code: 'custom', path: ['clientId'], message: 'The client id is required for Microsoft Graph.' });
      if (!d.clientSecret) ctx.addIssue({ code: 'custom', path: ['clientSecret'], message: 'The client secret (a vault reference) is required for Microsoft Graph.' });
      if (d.groupName && d.groupName !== 'displayName' && d.groupName !== 'id') ctx.addIssue({ code: 'custom', path: ['groupName'], message: 'Graph groups are named by displayName or id.' });
    } else {
      if (!d.serviceAccount) ctx.addIssue({ code: 'custom', path: ['serviceAccount'], message: 'The service account key (a vault reference) is required for the Directory API.' });
      if (!d.subject) ctx.addIssue({ code: 'custom', path: ['subject'], message: 'The admin the service account acts as is required for the Directory API.' });
      if (d.groupName && d.groupName !== 'email' && d.groupName !== 'name') ctx.addIssue({ code: 'custom', path: ['groupName'], message: 'Google groups are named by email or name.' });
    }
  });

export type CloudDirectoryConfig = z.infer<typeof cloudDirectorySchema>;

const ldapUrl = z.string().regex(/^ldaps?:\/\/[^\s/]+\/?$/, 'ldap:// or ldaps:// URL (no path)');

/**
 * B-182: Active Directory over LDAP. Domain controllers come from `urls` or from DNS SRV records of `domain`
 * (`_ldap._tcp`, or `_gc._tcp` for the Global Catalog), tried in order with failover. Only LDAPS or StartTLS: a
 * plain bind is never made, in development either.
 */
export const adConfigSchema = z
  .object({
    ...common,
    domain: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/, 'A DNS domain, such as corp.example.com'),
    /** Empty: domain controllers from DNS SRV records. */
    urls: z.array(ldapUrl).max(10).default([]),
    /** An AD site, to prefer its domain controllers (`_ldap._tcp.<site>._sites.<domain>`). */
    site: z.string().regex(/^[A-Za-z0-9-]{1,63}$/, 'An AD site name').optional(),
    /** The Global Catalog (3269 LDAPS, 3268 with StartTLS) for a multi-domain forest. */
    globalCatalog: z.boolean().default(false),
    startTLS: z.boolean().default(false),
    /** With SRV discovery and LDAPS: the port (636, or 3269 for the Global Catalog). */
    ldapsPort: z.number().int().min(1).max(65535).optional(),
    caFile: z.string().optional(),
    /** The service account: a DN or a userPrincipalName. */
    bindDN: z.string().min(1).max(500),
    bindPassword: secretRef,
    baseDN: z.string().min(1).max(500),
    signInAttribute: z.enum(['either', 'sAMAccountName', 'userPrincipalName']).default('either'),
    /** What the account's username here is. */
    usernameFrom: z.enum(['sAMAccountName', 'userPrincipalName']).default('sAMAccountName'),
    /** ANDed with the sign-in attribute match. */
    userFilter: z.string().max(1000).default('(&(objectCategory=person)(objectClass=user))').refine((f) => /^\(.*\)$/.test(f.trim()), 'A filter in parentheses'),
    displayNameAttribute: z.string().default('displayName'),
    emailAttribute: z.string().default('mail'),
    managerAttribute: z.string().default('manager'),
    /** Nested groups by LDAP_MATCHING_RULE_IN_CHAIN; off: the direct memberOf only. */
    nestedGroups: z.boolean().default(true),
    /**
     * QA-1: the primary group (primaryGroupID, usually Domain Users), which memberOf and the in-chain search leave
     * out, resolved through the account's domain SID and mapped like any other group.
     */
    primaryGroup: z.boolean().default(true),
    /** Where groups are searched for nested membership (default: baseDN). */
    groupBase: z.string().max(500).optional(),
    groupNameAttribute: z.enum(['dn', 'cn']).default('dn'),
    pageSize: z.number().int().min(10).max(5000).default(500),
    maxGroups: z.number().int().min(1).max(20000).default(2000),
    timeoutMs: z.number().int().min(500).max(30000).default(5000)
  })
  .strict()
  .superRefine((c, ctx) => {
    c.urls.forEach((u, i) => {
      if (u.startsWith('ldap://') && !c.startTLS) ctx.addIssue({ code: 'custom', path: ['urls', i], message: 'ldap:// needs StartTLS; Active Directory is asked over LDAPS or StartTLS only.' });
    });
  });

export type AdConfig = z.infer<typeof adConfigSchema>;

const urlPath = z.string().regex(/^(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/, 'A path starting with /');

/**
 * B-184: Exprsn platform accounts. Sign-in by the platform's OAuth 2.0 authorization server (`services/auth`):
 * authorization code with PKCE, then userinfo; organisations and roles become groups `org:<slug>`,
 * `org:<slug>/<role>` and `role:<name>`.
 */
export const exprsnPlatformConfigSchema = z
  .object({
    ...common,
    platformUrl: serviceUrl,
    clientId: z.string().trim().min(1).max(200),
    /** Absent for a public client (PKCE only). */
    clientSecret: vaultSecretRef.optional(),
    scopes: z.string().trim().max(500).default('openid profile email'),
    authorizePath: urlPath.default('/api/oauth2/authorize'),
    tokenPath: urlPath.default('/api/oauth2/token'),
    userinfoPath: urlPath.default('/api/oauth2/userinfo'),
    /** The token is revoked here after sign-in (empty: not revoked). */
    revokePath: urlPath.default('/api/oauth2/revoke'),
    /** An endpoint returning `{ organizations: [{ slug, role }] }` for the access token (empty: claims only). */
    membershipsPath: urlPath.default(''),
    usernameClaim: claimName.default('email'),
    organizationsClaim: claimName.default('organizations'),
    rolesClaim: claimName.default('roles'),
    /** Members of at least one of these organisations (slugs) may sign in; empty: any platform account. */
    allowedOrganizations: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'An organisation slug')).max(50).default([]),
    requireVerifiedEmail: z.boolean().default(true),
    /*
     * 1.9.0 (B-184): the platform's CA tokens accepted as bearer credentials on this tenant's API
     * (`federation/platform-tokens.ts`). Off until a store opts in; every field below is then required except the
     * JWKS address.
     */
    acceptApiTokens: z.boolean().default(false),
    /**
     * 1.9.9-qa (QA-1): refuse platform tokens signed with the CA's retired v1 scheme, whose signature leaves the
     * account, permission bits and resource unsigned; only `sigVersion: 2` tokens are accepted.
     */
    requireSignedClaims: z.boolean().default(false),
    /**
     * 2026-10-21: let admin roles that need a second factor act with a platform token that does not carry the CA's
     * signed `mfa` claim. Off: such roles need a token minted from an MFA-verified platform login (the default).
     */
    adminTokensWithoutMfa: z.boolean().default(false),
    /** The CA's domain, as the token's `issuer.domain` names it. */
    tokenIssuer: z.string().trim().toLowerCase().max(253).regex(/^$|^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/, 'A host name').default(''),
    /** PEM bundle: the platform CA's certificate(s), and optionally its token-signing certificates issued by them. */
    tokenTrustAnchor: z.string().max(65_536).default(''),
    /** Optional JWKS whose keys carry `x5c` token-signing certificates issued by the trust anchor (fetched, cached). */
    tokenJwksUrl: serviceUrl.optional(),
    /** The CA's token validation endpoint (`POST /api/tokens/validate`), asked for revocation and the token's claims. */
    tokenValidateUrl: serviceUrl.optional(),
    /** The service id this server calls the validation endpoint as (`X-Service-ID`). */
    tokenServiceId: z.string().trim().max(100).regex(/^$|^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash, underscore').default(''),
    /** Its service token (`X-Service-Token`), a vault reference. */
    tokenServiceToken: vaultSecretRef.optional(),
    /** This Exprsn-AI's API address as the token's resource must name it (the token's audience). */
    apiAudience: z.string().trim().max(500).regex(/^$|^https?:\/\/[^\s]+$/, 'An http(s) URL').default(''),
    /** `<bit>=<permission> <permission>`: what each token permission bit allows here. A bit not listed grants nothing. */
    scopeMap: z
      .array(
        z
          .string()
          .trim()
          .max(2000)
          .regex(/^(read|write|append|update|delete)\s*=\s*\S+(\s+\S+)*$/, 'read|write|append|update|delete = permission permission …')
          .refine((line) => line.split('=')[1]!.trim().split(/\s+/).every(isPermission), 'Each name after = must be an Exprsn-AI permission')
      )
      .max(5)
      .default([]),
    /** How long a validation answer is reused, in seconds (revocation takes effect within this). */
    tokenCacheSeconds: z.number().int().min(0).max(300).default(30)
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.tokenTrustAnchor) {
      try {
        if (!parsePemCertificates(c.tokenTrustAnchor).some((x) => x.ca)) ctx.addIssue({ code: 'custom', path: ['tokenTrustAnchor'], message: 'The bundle needs the platform CA\'s certificate (a CA certificate).' });
      } catch (err) {
        ctx.addIssue({ code: 'custom', path: ['tokenTrustAnchor'], message: `A certificate does not parse: ${(err as Error).message}` });
      }
    }
    if (!c.acceptApiTokens) return;
    const need: [keyof typeof c, string][] = [
      ['tokenIssuer', 'the CA domain'],
      ['tokenTrustAnchor', 'the trust anchor'],
      ['tokenValidateUrl', 'the validation endpoint'],
      ['tokenServiceId', 'the service id'],
      ['tokenServiceToken', 'the service token'],
      ['apiAudience', 'the API audience']
    ];
    for (const [key, what] of need) if (!c[key]) ctx.addIssue({ code: 'custom', path: [key], message: `Accepting platform tokens needs ${what}.` });
  });

export type ExprsnPlatformConfig = z.infer<typeof exprsnPlatformConfigSchema>;
export type SqlConfig = z.infer<typeof sqlConfigSchema>;

export function parseProviderConfig(kind: ProviderKind, config: unknown): LocalConfig | LdapConfig | SqlConfig | OidcUpstreamConfig | SamlUpstreamConfig | AtprotoConfig | GitHubConfig | ScimConfig | AdConfig | ExprsnPlatformConfig {
  switch (kind) {
    case 'local':
      return localConfigSchema.parse(config ?? {});
    case 'ldap':
      return ldapConfigSchema.parse(config);
    case 'sql':
      return sqlConfigSchema.parse(config);
    case 'oidc':
      return oidcConfigSchema.parse(config);
    case 'saml':
      return samlConfigSchema.parse(config);
    case 'atproto':
      return atprotoConfigSchema.parse(config ?? {});
    case 'github':
      return githubConfigSchema.parse(config);
    case 'scim':
      return scimConfigSchema.parse(config ?? {});
    case 'ad':
      return adConfigSchema.parse(config);
    case 'exprsn-platform':
      return exprsnPlatformConfigSchema.parse(config);
  }
}

export const timed = async <T>(steps: Step[] | undefined, title: string, fn: () => Promise<T>, describe?: (v: T) => string): Promise<T> => {
  const t0 = performance.now();
  try {
    const v = await fn();
    steps?.push({ title, ok: true, ms: Math.round(performance.now() - t0), ...(describe ? { detail: describe(v) } : {}) });
    return v;
  } catch (err) {
    // B-907: directory and database messages can carry a bind password or a connection string.
    steps?.push({ title, ok: false, ms: Math.round(performance.now() - t0), detail: scrubSecrets((err as Error).message) });
    throw err;
  }
};
