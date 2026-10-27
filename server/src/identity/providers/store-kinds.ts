import { connectivityTest, passwordStoreTest, registerStoreKind, storeKind, type FormSectionLayout, type StoreKindDefinition, type StorePreset, type StoreTestCredentials, type StoreTestContext, type StoreTestResult } from './kinds.js';
import { directoryDefaults } from './cloud-directory.js';
import { checkServiceUrl, servicePolicy } from '../../platform/egress.js';
import { badRequest } from '../../http/problem.js';
import { adConfigSchema, exprsnPlatformConfigSchema, type CloudDirectoryConfig, type ExprsnPlatformConfig, type OidcUpstreamConfig, type ProviderKind, type Step } from './types.js';

/*
 * 1.9.0, Sprint 54 (B-182 to B-184): the new user-store kinds and the cloud directory presets, registered in the kind
 * registry (`kinds.ts`, B-181) that drives the store wizard and the form editor:
 *
 * - `ad` (Active Directory) and `exprsn-platform` (Exprsn platform accounts) as kinds of their own;
 * - presets on the existing kinds: Microsoft Entra ID, Google Workspace, Okta, Keycloak and Authentik (OIDC, SAML or
 *   SCIM), FreeIPA and 389 Directory Server (LDAP). A preset fills the form (endpoints, scopes, claim and attribute
 *   names, how groups are named) and can be edited afterwards; the upper-case words (TENANT-ID, YOUR-ORG) are the
 *   parts only the admin knows.
 *
 * The built-in definitions are refined, not replaced: their layout and presets stay, these are added.
 */

const access: FormSectionLayout = {
  id: 'access',
  title: 'Default access',
  step: 'attributes',
  description: 'Given when none of the user\'s groups is mapped. Admin roles cannot be defaults.',
  fields: [
    { key: 'defaultRoles', label: 'Default roles' },
    { key: 'defaultClearance', label: 'Default clearance' }
  ]
};

// ---------- B-182: Active Directory ----------

const AD: StoreKindDefinition = {
  kind: 'ad',
  title: 'Active Directory',
  description: 'Windows Active Directory over LDAPS or StartTLS: sAMAccountName or UPN sign-in, nested groups, objectGUID links, disabled and locked accounts refused, domain controllers from DNS with failover.',
  config: adConfigSchema,
  signIn: 'password',
  schema: {
    sections: [
      {
        id: 'connection',
        title: 'Domain controllers',
        step: 'connection',
        description: 'Leave the URLs empty to find domain controllers from the domain\'s DNS SRV records. A plain ldap:// bind is never made: LDAPS, or ldap:// with StartTLS.',
        fields: [
          { key: 'domain', label: 'DNS domain', placeholder: 'corp.example.com' },
          { key: 'urls', label: 'Domain controller URLs', placeholder: 'ldaps://dc1.corp.example.com:636', help: 'Tried in order; the one that answered last is tried first. Empty: from DNS.' },
          { key: 'site', label: 'AD site', help: 'Prefer this site\'s domain controllers (DNS discovery only).', advanced: true },
          { key: 'globalCatalog', label: 'Use the Global Catalog', help: 'For a forest with several domains (port 3269 over LDAPS, 3268 with StartTLS).' },
          { key: 'startTLS', label: 'Use StartTLS', help: 'Off: LDAPS.' },
          { key: 'ldapsPort', label: 'LDAPS port (DNS discovery)', advanced: true },
          { key: 'caFile', label: 'CA certificate file', placeholder: '/etc/exprsn-ai/ad-ca.pem' },
          { key: 'bindDN', label: 'Service account', placeholder: 'svc-exprsn@corp.example.com', help: 'A DN or a userPrincipalName. It needs read access to users and groups only.' },
          { key: 'bindPassword', label: 'Service account password' },
          { key: 'timeoutMs', label: 'Timeout (ms)', advanced: true }
        ]
      },
      {
        id: 'users',
        title: 'Users',
        step: 'attributes',
        fields: [
          { key: 'baseDN', label: 'Search base', placeholder: 'DC=corp,DC=example,DC=com' },
          { key: 'signInAttribute', label: 'Sign in with', help: 'either: sAMAccountName (also DOMAIN\\name) or userPrincipalName.' },
          { key: 'usernameFrom', label: 'Username here', help: 'In a forest with several domains, userPrincipalName is the one that is unique.' },
          { key: 'userFilter', label: 'User filter', advanced: true },
          { key: 'displayNameAttribute', label: 'Display name attribute', advanced: true },
          { key: 'emailAttribute', label: 'Email attribute', advanced: true },
          { key: 'managerAttribute', label: 'Manager attribute', advanced: true }
        ]
      },
      {
        id: 'groups',
        title: 'Groups',
        step: 'attributes',
        fields: [
          { key: 'nestedGroups', label: 'Include nested groups', help: 'Groups inside groups count (LDAP_MATCHING_RULE_IN_CHAIN).' },
          { key: 'primaryGroup', label: 'Include the primary group', help: 'The account\'s primary group (usually Domain Users), which memberOf leaves out.' },
          { key: 'groupBase', label: 'Group search base', help: 'Default: the search base.', advanced: true },
          { key: 'groupNameAttribute', label: 'Group name as', help: 'What group mappings name: the full DN (unique) or the cn.' },
          { key: 'pageSize', label: 'Page size', advanced: true },
          { key: 'maxGroups', label: 'Most groups read per user', advanced: true }
        ]
      },
      access
    ]
  },
  presets: [
    {
      id: 'active-directory',
      title: 'Active Directory (one domain)',
      description: 'Domain controllers from DNS over LDAPS; sign-in by sAMAccountName or UPN; nested groups by DN.',
      config: { domain: 'corp.example.com', urls: [], bindDN: 'svc-exprsn@corp.example.com', bindPassword: 'vault:identity/ad#bindPassword', baseDN: 'DC=corp,DC=example,DC=com', signInAttribute: 'either', usernameFrom: 'sAMAccountName', nestedGroups: true, groupNameAttribute: 'dn' },
      mappings: [{ group: 'CN=Exprsn-AI Users,OU=Groups,DC=corp,DC=example,DC=com', role: 'member', clearance: 'internal' }]
    },
    {
      id: 'active-directory-forest',
      title: 'Active Directory forest (Global Catalog)',
      description: 'Every domain of a forest through the Global Catalog; usernames are userPrincipalNames, which are unique across domains.',
      config: { domain: 'example.com', urls: [], globalCatalog: true, bindDN: 'svc-exprsn@example.com', bindPassword: 'vault:identity/ad#bindPassword', baseDN: 'DC=example,DC=com', signInAttribute: 'either', usernameFrom: 'userPrincipalName', nestedGroups: true, groupNameAttribute: 'dn' }
    },
    {
      id: 'active-directory-dcs',
      title: 'Active Directory (named domain controllers)',
      description: 'Two domain controllers by name over LDAPS, tried in order.',
      config: { domain: 'corp.example.com', urls: ['ldaps://dc1.corp.example.com:636', 'ldaps://dc2.corp.example.com:636'], bindDN: 'svc-exprsn@corp.example.com', bindPassword: 'vault:identity/ad#bindPassword', baseDN: 'DC=corp,DC=example,DC=com' }
    }
  ],
  test: passwordStoreTest
};

// ---------- B-184: Exprsn platform accounts ----------

const platformPreset = (url: string | undefined): StorePreset => ({
  id: 'exprsn-platform',
  title: 'This deployment\'s Exprsn platform',
  description: 'The platform\'s OAuth 2.0 server (services/auth) with PKCE; organisations become org:<slug> and org:<slug>/<role>, platform roles role:<name>.',
  config: { platformUrl: (url ?? 'https://platform.example.internal:8443').replace(/\/+$/, ''), clientId: 'exprsn-ai', clientSecret: 'vault:identity/exprsn-platform#clientSecret', scopes: 'openid profile email' },
  mappings: [{ group: 'role:user', role: 'member', clearance: 'internal' }]
});

const platformKind = (url: string | undefined): StoreKindDefinition => ({
  kind: 'exprsn-platform',
  title: 'Exprsn platform accounts',
  description: 'Sign-in by the Exprsn platform\'s OAuth 2.0 server (authorization code with PKCE); platform organisations and roles become groups.',
  config: exprsnPlatformConfigSchema,
  signIn: 'redirect',
  platform: true,
  schema: {
    sections: [
      {
        id: 'connection',
        title: 'Platform',
        step: 'connection',
        description: 'Register this server as an OAuth client on the platform with the redirect URI <issuer>/federation/exprsn-platform/callback.',
        fields: [
          { key: 'platformUrl', label: 'Platform address', placeholder: 'https://platform.example.internal:8443' },
          { key: 'clientId', label: 'Client id' },
          { key: 'clientSecret', label: 'Client secret', help: 'A vault reference. Leave empty for a public client (PKCE only).' },
          { key: 'scopes', label: 'Scopes' },
          { key: 'authorizePath', label: 'Authorize path', advanced: true },
          { key: 'tokenPath', label: 'Token path', advanced: true },
          { key: 'userinfoPath', label: 'Userinfo path', advanced: true },
          { key: 'revokePath', label: 'Revocation path', help: 'The token is revoked here after sign-in. Empty: not revoked.', advanced: true }
        ]
      },
      {
        id: 'accounts',
        title: 'Accounts and groups',
        step: 'attributes',
        fields: [
          { key: 'usernameClaim', label: 'Username claim' },
          { key: 'requireVerifiedEmail', label: 'Require a verified address' },
          { key: 'organizationsClaim', label: 'Organisations claim', advanced: true },
          { key: 'rolesClaim', label: 'Roles claim', advanced: true },
          { key: 'membershipsPath', label: 'Memberships path', help: 'An endpoint returning { organizations: [{ slug, role }] } for the access token. Empty: claims only.', advanced: true },
          { key: 'allowedOrganizations', label: 'Allowed organisations', help: 'Empty: any platform account, then the mappings decide.' }
        ]
      },
      {
        id: 'api-tokens',
        title: 'API tokens',
        step: 'connection',
        description: 'Accept the platform CA\'s tokens as bearer credentials on this tenant\'s API. The person is the account linked to the token\'s platform account through this store; no account is created from a token.',
        fields: [
          { key: 'acceptApiTokens', label: 'Accept platform API tokens', help: 'Off by default. When on, every field below except the JWKS address is required.' },
          { key: 'requireSignedClaims', label: 'Require signed claims', help: 'Refuse tokens signed with the platform CA\'s retired v1 scheme, which leaves the account, permissions and resource unsigned. Off by default during the changeover.', advanced: true },
          { key: 'adminTokensWithoutMfa', label: 'Admin tokens without a second factor', help: 'Off by default: admin roles that need a second factor act with a platform token only when it was minted from a login verified with one (its signed mfa claim). On waives that.', advanced: true },
          { key: 'tokenIssuer', label: 'CA domain', help: 'The token\'s issuer.domain, the platform CA\'s CA_DOMAIN.', placeholder: 'ca.exprsn.io' },
          { key: 'tokenTrustAnchor', label: 'Trust anchor (PEM)', help: 'The platform CA\'s certificate, and its token-signing certificates unless the JWKS address serves them.', multiline: true },
          { key: 'tokenJwksUrl', label: 'Signing keys (JWKS) address', help: 'Optional: keys with x5c certificates issued by the trust anchor.', advanced: true },
          { key: 'tokenValidateUrl', label: 'Validation endpoint', help: 'The CA\'s POST /api/tokens/validate: revocation and the token\'s account, permissions and resource.', placeholder: 'https://platform.example.internal:8443/api/tokens/validate' },
          { key: 'tokenServiceId', label: 'Service id', help: 'Sent as X-Service-ID to the validation endpoint.' },
          { key: 'tokenServiceToken', label: 'Service token', help: 'A vault reference; sent as X-Service-Token.' },
          { key: 'apiAudience', label: 'API audience', help: 'This server\'s API address; the token\'s resource must name it.', placeholder: 'https://ai.example.com/api' },
          { key: 'scopeMap', label: 'Permission bits', help: 'One line per bit: read=chat:use knowledge:read. A bit not listed grants nothing; the account\'s roles still apply.' },
          { key: 'tokenCacheSeconds', label: 'Validation cache (seconds)', advanced: true }
        ]
      },
      access
    ]
  },
  presets: [platformPreset(url)],
  test: connectivityTest
});

/** Fills the platform kind's preset with this deployment's platform address (PLATFORM_LOWCODE_URL), when set. */
export function configurePlatformKind(url: string | undefined): void {
  registerStoreKind(platformKind(url));
}

// ---------- B-183: cloud directory and identity provider presets ----------

/** The OIDC test with a directory: connectivity, then the test account looked up in the directory (no password). */
async function oidcTest(config: Record<string, unknown>, credentials: StoreTestCredentials | null, ctx: StoreTestContext): Promise<StoreTestResult> {
  if (!(config as unknown as OidcUpstreamConfig).directory) return connectivityTest(config, credentials, ctx);
  const steps: Step[] = [];
  let provider;
  try {
    provider = ctx.probe(config);
  } catch (err) {
    steps.push({ title: 'Configuration', ok: false, detail: (err as Error).message });
    return { ok: false, result: 'error', steps, detail: (err as Error).message };
  }
  try {
    const connected = await provider.test(steps).catch(() => false);
    if (!connected) return { ok: false, result: 'unreachable', steps };
    if (!credentials) return { ok: true, result: 'connected', steps };
    const u = await provider.lookup(credentials.username, steps);
    if (credentials.password) steps.push({ title: 'Password', ok: true, detail: 'This store signs in by redirect, so no password is tried here; the account was looked up in the directory.' });
    return u ? { ok: true, result: 'found', steps, user: { externalId: u.externalId, username: u.username, displayName: u.displayName, email: u.email, groups: u.groups } } : { ok: false, result: 'not_found', steps };
  } catch (err) {
    steps.push({ title: 'Test account', ok: false, detail: (err as Error).message });
    return { ok: false, result: 'error', steps, detail: (err as Error).message };
  } finally {
    await provider.close().catch(() => undefined);
  }
}

const directorySection: FormSectionLayout = {
  id: 'directory',
  title: 'Directory pull',
  step: 'attributes',
  description: 'Optional: read users and groups from Microsoft Graph or the Google Directory API, so directory sync refreshes and disables accounts and groups are named the same at sign-in and at every sync.',
  fields: [
    { key: 'directory.api', label: 'Directory API' },
    { key: 'directory.tokenUrl', label: 'Token endpoint' },
    { key: 'directory.apiUrl', label: 'API address', advanced: true },
    { key: 'directory.clientId', label: 'Client id (Graph)' },
    { key: 'directory.clientSecret', label: 'Client secret (Graph)', help: 'A vault reference; the client credentials grant.' },
    { key: 'directory.serviceAccount', label: 'Service account key (Google)', help: 'A vault reference to the JSON key, with domain-wide delegation.' },
    { key: 'directory.subject', label: 'Admin to act as (Google)' },
    { key: 'directory.customer', label: 'Customer (Google)', advanced: true },
    { key: 'directory.scope', label: 'Scope', advanced: true },
    { key: 'directory.groupName', label: 'Group name as' },
    { key: 'directory.securityGroupsOnly', label: 'Security groups only (Graph)' },
    { key: 'subjectClaim', label: 'Account link claim', help: 'Default sub. Entra ID: oid, the id Graph knows.', advanced: true }
  ]
};

const ENTRA_SECRET = 'vault:identity/entra#clientSecret';

const OIDC_PRESETS: StorePreset[] = [
  {
    id: 'entra-id',
    title: 'Microsoft Entra ID',
    description: 'Sign-in with Entra ID (OIDC v2.0) and users and groups from Microsoft Graph (client credentials; the app needs User.Read.All and GroupMember.Read.All). Groups are named by display name, nested included.',
    config: {
      issuer: 'https://login.microsoftonline.com/TENANT-ID/v2.0',
      clientId: 'APPLICATION-CLIENT-ID',
      clientSecret: ENTRA_SECRET,
      scopes: 'openid profile email',
      usernameClaim: 'preferred_username',
      displayNameClaim: 'name',
      emailClaim: 'email',
      groupsClaim: 'groups',
      subjectClaim: 'oid',
      algs: ['RS256'],
      directory: { api: 'msgraph', tokenUrl: 'https://login.microsoftonline.com/TENANT-ID/oauth2/v2.0/token', apiUrl: 'https://graph.microsoft.com/v1.0', clientId: 'APPLICATION-CLIENT-ID', clientSecret: ENTRA_SECRET, scope: 'https://graph.microsoft.com/.default', groupName: 'displayName', securityGroupsOnly: true }
    }
  },
  {
    id: 'google-workspace',
    title: 'Google Workspace',
    description: 'Sign-in with Google (OIDC) and users and groups from the Admin SDK Directory API (a service account with domain-wide delegation, read-only scopes). Groups are named by their address.',
    config: {
      issuer: 'https://accounts.google.com',
      clientId: 'CLIENT-ID.apps.googleusercontent.com',
      clientSecret: 'vault:identity/google#clientSecret',
      scopes: 'openid profile email',
      usernameClaim: 'email',
      displayNameClaim: 'name',
      emailClaim: 'email',
      groupsClaim: 'groups',
      algs: ['RS256'],
      directory: { api: 'google', tokenUrl: 'https://oauth2.googleapis.com/token', apiUrl: 'https://admin.googleapis.com/admin/directory/v1', serviceAccount: 'vault:identity/google#serviceAccount', subject: 'admin@example.com', customer: 'my_customer', groupName: 'email' }
    }
  },
  {
    id: 'okta',
    title: 'Okta',
    description: 'Sign-in with Okta\'s default authorization server. Add a groups claim to the ID token in Okta; users can be pushed with the Okta SCIM preset.',
    config: { issuer: 'https://YOUR-ORG.okta.com/oauth2/default', clientId: 'CLIENT-ID', clientSecret: 'vault:identity/okta#clientSecret', scopes: 'openid profile email groups', usernameClaim: 'preferred_username', displayNameClaim: 'name', emailClaim: 'email', groupsClaim: 'groups', algs: ['RS256'] }
  },
  {
    id: 'keycloak',
    title: 'Keycloak',
    description: 'Sign-in with a Keycloak realm. Add a "Group Membership" mapper named groups (full path off) to the client.',
    config: { issuer: 'https://keycloak.example.internal/realms/REALM', clientId: 'exprsn-ai', clientSecret: 'vault:identity/keycloak#clientSecret', scopes: 'openid profile email', usernameClaim: 'preferred_username', displayNameClaim: 'name', emailClaim: 'email', groupsClaim: 'groups', algs: ['RS256', 'ES256'] }
  },
  {
    id: 'authentik',
    title: 'Authentik',
    description: 'Sign-in with an Authentik OAuth2/OpenID provider; its profile scope carries the groups claim.',
    config: { issuer: 'https://authentik.example.internal/application/o/exprsn-ai/', clientId: 'CLIENT-ID', clientSecret: 'vault:identity/authentik#clientSecret', scopes: 'openid profile email', usernameClaim: 'preferred_username', displayNameClaim: 'name', emailClaim: 'email', groupsClaim: 'groups', algs: ['RS256', 'ES256'] }
  }
];

const SAML_PRESETS: StorePreset[] = [
  {
    id: 'okta-saml',
    title: 'Okta (SAML)',
    description: 'An Okta SAML app. Paste the signing certificate from its metadata; add a group attribute statement named groups.',
    config: { entityId: 'http://www.okta.com/EXTERNAL-KEY', ssoUrl: 'https://YOUR-ORG.okta.com/app/APP-NAME/EXTERNAL-KEY/sso/saml', certificates: [], usernameAttribute: '', displayNameAttribute: 'displayName', emailAttribute: 'email', groupsAttribute: 'groups' }
  },
  {
    id: 'keycloak-saml',
    title: 'Keycloak (SAML)',
    description: 'A Keycloak SAML client. Add a "Group list" mapper with the attribute name groups.',
    config: { entityId: 'https://keycloak.example.internal/realms/REALM', ssoUrl: 'https://keycloak.example.internal/realms/REALM/protocol/saml', certificates: [], usernameAttribute: '', displayNameAttribute: 'displayName', emailAttribute: 'email', groupsAttribute: 'groups' }
  },
  {
    id: 'authentik-saml',
    title: 'Authentik (SAML)',
    description: 'An Authentik SAML provider with its default property mappings.',
    config: {
      entityId: 'https://authentik.example.internal',
      ssoUrl: 'https://authentik.example.internal/application/saml/exprsn-ai/sso/binding/redirect/',
      certificates: [],
      usernameAttribute: 'http://schemas.goauthentik.io/2021/02/saml/username',
      displayNameAttribute: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
      emailAttribute: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      groupsAttribute: 'http://schemas.xmlsoap.org/claims/Group'
    }
  }
];

const SCIM_PRESETS: StorePreset[] = [
  { id: 'entra-id-scim', title: 'Microsoft Entra ID (SCIM push)', description: 'Entra ID provisions users and groups to /scim/v2 with a SCIM token (Enterprise application, Provisioning). Name the Entra ID sign-in store (OIDC or SAML) under sign-in stores.', config: { signInStores: [] } },
  { id: 'google-workspace-scim', title: 'Google Workspace (SCIM push)', description: 'Google pushes SCIM only to apps in its own catalogue; for a custom app, use the Google Workspace OIDC preset with the Directory API pull instead.', config: { signInStores: [] } },
  { id: 'okta-scim', title: 'Okta (SCIM push)', description: 'An Okta app with SCIM provisioning to /scim/v2 (SCIM 2.0, header auth with the SCIM token). Name the Okta sign-in store under sign-in stores.', config: { signInStores: [] } },
  { id: 'keycloak-scim', title: 'Keycloak (SCIM push)', description: 'Keycloak with a SCIM client extension pushing to /scim/v2. Name the Keycloak sign-in store under sign-in stores.', config: { signInStores: [] } },
  { id: 'authentik-scim', title: 'Authentik (SCIM push)', description: 'An Authentik SCIM provider pushing to /scim/v2 with the SCIM token as its bearer. Name the Authentik sign-in store under sign-in stores.', config: { signInStores: [] } }
];

const LDAP_PRESETS: StorePreset[] = [
  {
    id: 'freeipa',
    title: 'FreeIPA',
    description: 'FreeIPA\'s directory over LDAPS with a system account; groups from cn=groups by cn.',
    config: {
      url: 'ldaps://ipa.example.internal:636',
      bindDN: 'uid=exprsn-svc,cn=sysaccounts,cn=etc,dc=example,dc=internal',
      bindPassword: 'vault:identity/freeipa#bindPassword',
      userBase: 'cn=users,cn=accounts,dc=example,dc=internal',
      userFilter: '(&(objectClass=person)(uid={{username}}))',
      usernameAttribute: 'uid',
      displayNameAttribute: 'displayName',
      emailAttribute: 'mail',
      groupMode: 'search',
      groupBase: 'cn=groups,cn=accounts,dc=example,dc=internal',
      groupFilter: '(member={{dn}})',
      groupNameAttribute: 'cn'
    }
  },
  {
    id: '389ds',
    title: '389 Directory Server',
    description: '389 Directory Server over LDAPS; people under ou=People, groups (groupOfUniqueNames or groupOfNames) under ou=Groups by cn.',
    config: {
      url: 'ldaps://ldap.example.internal:636',
      bindDN: 'uid=exprsn-svc,ou=Special Users,dc=example,dc=internal',
      bindPassword: 'vault:identity/389ds#bindPassword',
      userBase: 'ou=People,dc=example,dc=internal',
      userFilter: '(&(objectClass=inetOrgPerson)(uid={{username}}))',
      usernameAttribute: 'uid',
      displayNameAttribute: 'cn',
      emailAttribute: 'mail',
      groupMode: 'search',
      groupBase: 'ou=Groups,dc=example,dc=internal',
      groupFilter: '(|(uniqueMember={{dn}})(member={{dn}}))',
      groupNameAttribute: 'cn'
    }
  }
];

/** Adds presets (and layout sections) to a built-in kind, keeping its own. */
function refine(kind: string, more: { presets: StorePreset[]; sections?: FormSectionLayout[]; test?: StoreKindDefinition['test'] }): void {
  const base = storeKind(kind);
  if (!base) return;
  const known = new Set((base.presets ?? []).map((p) => p.id));
  const sections = more.sections ? [...base.schema.sections.filter((s) => s.id !== 'access' && !more.sections!.some((m) => m.id === s.id)), ...more.sections, ...base.schema.sections.filter((s) => s.id === 'access')] : base.schema.sections;
  registerStoreKind({ ...base, schema: { ...base.schema, sections }, presets: [...(base.presets ?? []), ...more.presets.filter((p) => !known.has(p.id))], ...(more.test ? { test: more.test } : {}) });
}

registerStoreKind(AD);
registerStoreKind(platformKind(undefined));
refine('oidc', { presets: OIDC_PRESETS, sections: [directorySection], test: oidcTest });
refine('saml', { presets: SAML_PRESETS });
refine('scim', { presets: SCIM_PRESETS });
refine('ldap', { presets: LDAP_PRESETS });

/** Every preset of every kind, for the docs and the tests. */
export const STORE_PRESETS: Record<string, StorePreset[]> = { ad: AD.presets!, 'exprsn-platform': platformKind(undefined).presets!, oidc: OIDC_PRESETS, saml: SAML_PRESETS, scim: SCIM_PRESETS, ldap: LDAP_PRESETS };

/**
 * The outbound addresses a store of the new kinds calls, which pass the operator's service URL checks when it is
 * saved (each connection checks again): a cloud directory's token and API endpoints, the platform's address.
 */
export function storeServiceUrls(kind: ProviderKind, config: unknown): string[] {
  if (kind === 'oidc') {
    const d = (config as { directory?: CloudDirectoryConfig }).directory;
    if (!d) return [];
    const x = directoryDefaults(d);
    return [x.tokenUrl, x.apiUrl].filter(Boolean);
  }
  if (kind === 'exprsn-platform') {
    const c = config as ExprsnPlatformConfig;
    return [c.platformUrl, c.tokenValidateUrl, c.tokenJwksUrl].filter((u): u is string => !!u);
  }
  return [];
}

/** Checks `storeServiceUrls` against the operator's service policy when a store is saved; throws a 400 problem. */
export async function assertStoreServiceUrls(cfg: { SERVICE_ALLOWED_HOSTS?: string; SERVICE_INTERNAL_ONLY?: boolean }, kind: ProviderKind, config: unknown): Promise<void> {
  for (const url of storeServiceUrls(kind, config)) {
    try {
      await checkServiceUrl(url, servicePolicy(cfg));
    } catch (err) {
      throw badRequest(`The address ${url} was refused: ${(err as Error).message}`, { reason: 'service_url' });
    }
  }
}
