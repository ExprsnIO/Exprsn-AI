import { z, type ZodType } from 'zod';
import {
  atprotoConfigSchema,
  githubConfigSchema,
  ldapConfigSchema,
  localConfigSchema,
  oidcConfigSchema,
  samlConfigSchema,
  scimConfigSchema,
  sqlConfigSchema,
  type ExternalUser,
  type IdentityProvider,
  type Step
} from './types.js';

/*
 * 1.9.0, Sprint 54 (B-181): the registry of user-store kinds. The store wizard and the form editor in the console are
 * driven entirely from it, so a new kind (Active Directory, the cloud directory presets, Exprsn platform accounts:
 * B-182 to B-184) plugs in by registering a definition here and nothing else in the wizard changes.
 *
 * A definition is
 *
 *   { kind, title, description?, config, schema, presets?, signIn, platform?, test }
 *
 * - `kind`: the stored `identity_providers.kind`. The chain (`identity/chain.ts`) must know how to build it, and
 *   `parseProviderConfig` how to parse it.
 * - `config`: the kind's zod schema, the one the server parses with. The form's field types, required fields,
 *   defaults and enums are generated from it (`formFor`), so the form never drifts from what the server accepts.
 * - `schema`: the form's layout over that zod schema: sections (each in one wizard step: `connection` or
 *   `attributes`), and per field its label, help, placeholder and whether it is advanced. Keys are dotted paths into
 *   the configuration (`columns.username`). A field the layout does not name still appears, under "Other settings".
 *   A field whose zod schema is `secretRef` is a secret: the form takes a reference (`vault:path#key`, `env:NAME`,
 *   `file:/path`), never a value, and the server refuses anything else.
 * - `presets`: named starting configurations (a preset fills the form and can be edited afterwards), optionally with
 *   suggested group mappings.
 * - `signIn`: `password` (the chain asks it with a username and password), `redirect` (OIDC, SAML, GitHub,
 *   AT-Protocol, and the platform's OAuth server) or `push` (SCIM).
 * - `platform`: changing a store of this kind also needs `platform:manage` (Exprsn platform accounts).
 * - `test(config, credentials, ctx)`: the wizard's "test with a real account". `config` is already parsed by `config`;
 *   `credentials` is a username and, optionally, a password, used for this one call and never stored, logged or
 *   audited (only the username is). `ctx.probe` builds an uncached provider for the configuration the way the chain
 *   would (the chain's outbound address checks and the saving admin's vault references apply). Return the steps, and
 *   `user` when the account was found.
 */

export type StoreStep = 'connection' | 'attributes';

export interface FormFieldLayout {
  key: string;
  label?: string;
  help?: string;
  placeholder?: string;
  advanced?: boolean;
  /** 1.9.0 (B-184): a text field shown as a text area (a PEM bundle). */
  multiline?: boolean;
}

export interface FormSectionLayout {
  id: string;
  title: string;
  step: StoreStep;
  description?: string;
  fields: (string | FormFieldLayout)[];
}

export interface FormLayout {
  sections: FormSectionLayout[];
}

export type FieldType = 'text' | 'url' | 'number' | 'boolean' | 'select' | 'multiselect' | 'list' | 'secret';

/** One generated form field: its layout plus what the zod schema says about it. */
export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  help?: string;
  placeholder?: string;
  advanced?: boolean;
  multiline?: boolean;
  default?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  /** For `secret`: the reference forms accepted. */
  accepts?: string[];
}

export interface FormSection {
  id: string;
  title: string;
  step: StoreStep;
  description?: string;
  fields: FormField[];
}

export interface StorePreset {
  id: string;
  title: string;
  description?: string;
  config: Record<string, unknown>;
  /** Suggested group mappings (the group as the store names it); the wizard offers them, the admin decides. */
  mappings?: { group: string; role: string; clearance: string }[];
}

export interface StoreTestCredentials {
  username: string;
  /** Absent: the account is only looked up (no bind as the user). */
  password?: string;
}

export interface StoreTestResult {
  ok: boolean;
  /** `connected`: reachable, no account asked; otherwise the chain's answer for the test account. */
  result: 'connected' | 'unreachable' | 'ok' | 'found' | 'not_found' | 'invalid' | 'disabled' | 'error' | 'not_supported';
  steps: Step[];
  user?: Pick<ExternalUser, 'externalId' | 'username' | 'displayName' | 'email' | 'groups'> | null;
  detail?: string;
}

export interface StoreTestContext {
  /** An uncached provider for `config` as the chain would build it; the caller's `test` should close it. */
  probe(config: Record<string, unknown>): IdentityProvider;
}

export interface StoreKindDefinition {
  kind: string;
  title: string;
  description?: string;
  config: ZodType;
  schema: FormLayout;
  presets?: StorePreset[];
  signIn: 'password' | 'redirect' | 'push';
  platform?: boolean;
  test(config: Record<string, unknown>, credentials: StoreTestCredentials | null, ctx: StoreTestContext): Promise<StoreTestResult>;
}

const registry = new Map<string, StoreKindDefinition>();

/** Adds (or replaces) a kind. Later registrations of the same kind win, so a module can refine a built-in. */
export function registerStoreKind(def: StoreKindDefinition): void {
  registry.set(def.kind, def);
}

export const storeKind = (kind: string): StoreKindDefinition | undefined => registry.get(kind);
export const storeKinds = (): StoreKindDefinition[] => [...registry.values()];

// ---------- generating the form from the zod schema ----------

interface JsonProp {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonProp;
  properties?: Record<string, JsonProp>;
  required?: string[];
  default?: unknown;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  anyOf?: JsonProp[];
}

const SECRET_PATTERN_START = '^(env:';
const humanise = (key: string) => {
  const last = key.split('.').pop() ?? key;
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The leaf fields of a JSON schema object, flattened into dotted keys (one level of nesting, as the kinds use). */
function leaves(schema: JsonProp, prefix = '', parentRequired = true): Map<string, { prop: JsonProp; required: boolean }> {
  const out = new Map<string, { prop: JsonProp; required: boolean }>();
  const req = new Set(schema.required ?? []);
  for (const [name, raw] of Object.entries(schema.properties ?? {})) {
    const prop = raw.anyOf?.find((x) => x.type !== 'null') ?? raw;
    const key = prefix ? `${prefix}.${name}` : name;
    const required = parentRequired && req.has(name) && prop.default === undefined;
    if (prop.type === 'object' && prop.properties) for (const [k, v] of leaves(prop, key, required)) out.set(k, v);
    else out.set(key, { prop, required });
  }
  return out;
}

function fieldOf(key: string, prop: JsonProp, required: boolean, layout: FormFieldLayout | undefined): FormField {
  let type: FieldType = 'text';
  let options: string[] | undefined;
  if (prop.type === 'boolean') type = 'boolean';
  else if (prop.type === 'integer' || prop.type === 'number') type = 'number';
  else if (prop.enum) {
    type = 'select';
    options = prop.enum.map(String);
  } else if (prop.type === 'array') {
    if (prop.items?.enum) {
      type = 'multiselect';
      options = prop.items.enum.map(String);
    } else type = 'list';
  } else if (prop.pattern?.startsWith(SECRET_PATTERN_START)) type = 'secret';
  else if (prop.format === 'uri') type = 'url';
  const f: FormField = { key, label: layout?.label ?? humanise(key), type, required };
  if (layout?.help) f.help = layout.help;
  if (layout?.placeholder) f.placeholder = layout.placeholder;
  if (layout?.advanced) f.advanced = true;
  if (layout?.multiline && type === 'text') f.multiline = true;
  if (prop.default !== undefined) f.default = prop.default;
  if (options) f.options = options;
  const min = prop.minimum ?? prop.minLength;
  const max = prop.maximum ?? prop.maxLength;
  if (min !== undefined) f.min = min;
  if (max !== undefined) f.max = max;
  if (prop.pattern && type !== 'secret') f.pattern = prop.pattern;
  if (type === 'secret') {
    f.accepts = ['vault:path#key', 'env:NAME', 'file:/absolute/path'];
    f.help = (f.help ? f.help + ' ' : '') + 'A reference to the secret, never the secret itself.';
    f.placeholder ??= 'vault:identity/store#password';
  }
  return f;
}

const formCache = new WeakMap<StoreKindDefinition, FormSection[]>();

/** The form for a kind: its layout's sections with every field typed from the zod schema, plus the fields left over. */
export function formFor(def: StoreKindDefinition): FormSection[] {
  const cached = formCache.get(def);
  if (cached) return cached;
  const json = z.toJSONSchema(def.config, { io: 'input', unrepresentable: 'any' }) as JsonProp;
  const all = leaves(json);
  const placed = new Set<string>();
  const sections: FormSection[] = def.schema.sections.map((sec) => ({
    id: sec.id,
    title: sec.title,
    step: sec.step,
    ...(sec.description ? { description: sec.description } : {}),
    fields: sec.fields.flatMap((f) => {
      const layout = typeof f === 'string' ? { key: f } : f;
      const found = all.get(layout.key);
      if (!found) return [];
      placed.add(layout.key);
      return [fieldOf(layout.key, found.prop, found.required, layout)];
    })
  }));
  const rest = [...all.entries()].filter(([k]) => !placed.has(k));
  if (rest.length) sections.push({ id: 'other', title: 'Other settings', step: 'attributes', fields: rest.map(([k, v]) => fieldOf(k, v.prop, v.required, { key: k, advanced: true })) });
  const out = sections.filter((s) => s.fields.length);
  formCache.set(def, out);
  return out;
}

/** Every key a layout names that its zod schema does not have (a test keeps this empty for every kind). */
export function layoutDrift(def: StoreKindDefinition): string[] {
  const all = leaves(z.toJSONSchema(def.config, { io: 'input', unrepresentable: 'any' }) as JsonProp);
  return def.schema.sections.flatMap((s) => s.fields.map((f) => (typeof f === 'string' ? f : f.key))).filter((k) => !all.has(k));
}

/** What the console gets for a kind (no functions). */
export function kindView(def: StoreKindDefinition) {
  return {
    kind: def.kind,
    title: def.title,
    ...(def.description ? { description: def.description } : {}),
    signIn: def.signIn,
    platform: !!def.platform,
    sections: formFor(def),
    presets: def.presets ?? []
  };
}

// ---------- tests ----------

const userView = (u: ExternalUser) => ({ externalId: u.externalId, username: u.username, displayName: u.displayName, email: u.email, groups: u.groups });

/**
 * The test for stores that take passwords: connect, then (with credentials) sign in as the account, or (with a
 * username only) look it up. The password is passed straight to the provider and dropped.
 */
export async function passwordStoreTest(config: Record<string, unknown>, credentials: StoreTestCredentials | null, ctx: StoreTestContext): Promise<StoreTestResult> {
  const steps: Step[] = [];
  let provider: IdentityProvider;
  try {
    provider = ctx.probe(config);
  } catch (err) {
    steps.push({ title: 'Configuration', ok: false, detail: (err as Error).message });
    return { ok: false, result: 'error', steps, detail: (err as Error).message };
  }
  try {
    let connected = false;
    try {
      connected = await provider.test(steps);
    } catch (err) {
      if (!steps.some((s) => !s.ok)) steps.push({ title: 'Connection', ok: false, detail: (err as Error).message });
    }
    if (!connected) return { ok: false, result: 'unreachable', steps };
    if (!credentials) return { ok: true, result: 'connected', steps };
    if (credentials.password) {
      const r = await provider.authenticate(credentials.username, credentials.password, steps);
      if (r.status === 'ok') return { ok: true, result: 'ok', steps, user: userView(r.user) };
      return { ok: false, result: r.status, steps, ...(r.status === 'error' ? { detail: r.message } : {}) };
    }
    const u = await provider.lookup(credentials.username, steps);
    return u ? { ok: true, result: 'found', steps, user: userView(u) } : { ok: false, result: 'not_found', steps };
  } catch (err) {
    steps.push({ title: 'Test account', ok: false, detail: (err as Error).message });
    return { ok: false, result: 'error', steps, detail: (err as Error).message };
  } finally {
    await provider.close().catch(() => undefined);
  }
}

/** The test for stores that sign in by redirect or are pushed to: reachability and configuration only. */
export async function connectivityTest(config: Record<string, unknown>, credentials: StoreTestCredentials | null, ctx: StoreTestContext): Promise<StoreTestResult> {
  const steps: Step[] = [];
  let ok = false;
  try {
    const provider = ctx.probe(config);
    try {
      ok = await provider.test(steps);
    } finally {
      await provider.close().catch(() => undefined);
    }
  } catch (err) {
    steps.push({ title: 'Configuration', ok: false, detail: (err as Error).message });
  }
  if (credentials) steps.push({ title: 'Test account', ok: true, detail: 'This kind signs in by redirect or is pushed to, so no password is tried here; sign in through it once it is saved.' });
  return { ok, result: ok ? 'connected' : 'unreachable', steps };
}

// ---------- the built-in kinds ----------

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

registerStoreKind({
  kind: 'ldap',
  title: 'OpenLDAP / LDAP directory',
  description: 'A directory asked over LDAPS or StartTLS with a service account; groups by search or memberOf.',
  config: ldapConfigSchema,
  signIn: 'password',
  schema: {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        step: 'connection',
        fields: [
          { key: 'url', label: 'Directory URL', placeholder: 'ldaps://ldap.example.internal:636', help: 'ldaps://, or ldap:// with StartTLS. The host must be internal.' },
          { key: 'startTLS', label: 'Use StartTLS' },
          { key: 'caFile', label: 'CA certificate file', placeholder: '/etc/exprsn-ai/ldap-ca.pem' },
          { key: 'bindDN', label: 'Service account DN', placeholder: 'cn=exprsn-svc,ou=services,dc=example,dc=internal' },
          { key: 'bindPassword', label: 'Service account password' },
          { key: 'timeoutMs', label: 'Timeout (ms)', advanced: true },
          { key: 'allowInsecure', label: 'Allow plain ldap:// (development only)', advanced: true }
        ]
      },
      {
        id: 'users',
        title: 'Users',
        step: 'attributes',
        fields: [
          { key: 'userBase', label: 'User search base', placeholder: 'ou=people,dc=example,dc=internal' },
          { key: 'userFilter', label: 'User filter', help: 'Must contain {{username}}.' },
          { key: 'usernameAttribute', label: 'Username attribute' },
          { key: 'displayNameAttribute', label: 'Display name attribute' },
          { key: 'emailAttribute', label: 'Email attribute' },
          { key: 'managerAttribute', label: 'Manager attribute', advanced: true }
        ]
      },
      {
        id: 'groups',
        title: 'Groups',
        step: 'attributes',
        fields: [
          { key: 'groupMode', label: 'How groups are found' },
          { key: 'groupBase', label: 'Group search base', help: 'Required when groups are found by search.' },
          { key: 'groupFilter', label: 'Group filter', advanced: true },
          { key: 'groupNameAttribute', label: 'Group name as', help: 'What group mappings name: the full DN or the cn.' }
        ]
      },
      access
    ]
  },
  presets: [
    {
      id: 'openldap',
      title: 'OpenLDAP',
      config: { url: 'ldaps://ldap.example.internal:636', bindDN: 'cn=exprsn-svc,ou=services,dc=example,dc=internal', bindPassword: 'vault:identity/ldap#bindPassword', userBase: 'ou=people,dc=example,dc=internal', groupBase: 'ou=groups,dc=example,dc=internal' }
    }
  ],
  test: passwordStoreTest
});

registerStoreKind({
  kind: 'sql',
  title: 'SQL user table',
  description: 'A PostgreSQL, MySQL or SQLite table of users with argon2 or bcrypt hashes, read with SELECT only.',
  config: sqlConfigSchema,
  signIn: 'password',
  schema: {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        step: 'connection',
        fields: [
          { key: 'dialect', label: 'Database' },
          { key: 'connection', label: 'Connection URL or file', help: 'The URL (PostgreSQL, MySQL) or file path (SQLite).' },
          { key: 'table', label: 'User table' },
          { key: 'timeoutMs', label: 'Timeout (ms)', advanced: true }
        ]
      },
      {
        id: 'columns',
        title: 'Columns',
        step: 'attributes',
        fields: [
          { key: 'columns.id', label: 'Row key column' },
          { key: 'columns.username', label: 'Username column' },
          { key: 'columns.passwordHash', label: 'Password hash column', help: 'argon2 or bcrypt hashes only.' },
          { key: 'columns.displayName', label: 'Display name column' },
          { key: 'columns.email', label: 'Email column' },
          { key: 'columns.disabled', label: 'Disabled column', help: 'Truthy means disabled.' },
          { key: 'columns.manager', label: 'Manager column', advanced: true },
          { key: 'caseInsensitive', label: 'Usernames ignore case' }
        ]
      },
      {
        id: 'groups',
        title: 'Groups',
        step: 'attributes',
        fields: [
          { key: 'columns.groups', label: 'Groups column', help: 'A comma-separated or JSON list on the user row.' },
          { key: 'groupTable.table', label: 'Group table', advanced: true },
          { key: 'groupTable.userColumn', label: 'Group table user column', advanced: true },
          { key: 'groupTable.groupColumn', label: 'Group table group column', advanced: true }
        ]
      },
      access
    ]
  },
  presets: [
    { id: 'pg', title: 'PostgreSQL user table', config: { dialect: 'pg', connection: 'vault:identity/hr-db#url', table: 'users', columns: { id: 'id', username: 'username', passwordHash: 'password_hash', displayName: 'full_name', email: 'email', disabled: 'disabled', groups: 'groups' } } },
    { id: 'mysql', title: 'MySQL user table', config: { dialect: 'mysql', connection: 'vault:identity/hr-db#url', table: 'users', columns: { id: 'id', username: 'username', passwordHash: 'password_hash', displayName: 'full_name', email: 'email', disabled: 'disabled' }, groupTable: { table: 'user_groups', userColumn: 'user_id', groupColumn: 'group_name' } } },
    { id: 'sqlite', title: 'SQLite user table', config: { dialect: 'sqlite', connection: 'file:/run/secrets/hr-sqlite-path', table: 'users', columns: { username: 'username', passwordHash: 'password_hash', displayName: 'display_name' }, defaultRoles: ['member'] } }
  ],
  test: passwordStoreTest
});

registerStoreKind({
  kind: 'local',
  title: 'Local accounts',
  description: 'Accounts kept in this application\'s own database: bootstrap and break-glass. One per tenant.',
  config: localConfigSchema,
  signIn: 'password',
  schema: { sections: [access] },
  test: passwordStoreTest
});

registerStoreKind({
  kind: 'oidc',
  title: 'Upstream OpenID Connect',
  description: 'Sign-in by redirect to an OpenID Connect provider; this server is the relying party.',
  config: oidcConfigSchema,
  signIn: 'redirect',
  schema: {
    sections: [
      {
        id: 'connection',
        title: 'Provider',
        step: 'connection',
        fields: [
          { key: 'issuer', label: 'Issuer', placeholder: 'https://login.example.com' },
          { key: 'clientId', label: 'Client id' },
          { key: 'clientSecret', label: 'Client secret', help: 'Leave empty for a public client (PKCE only).' },
          { key: 'scopes', label: 'Scopes' },
          { key: 'algs', label: 'Accepted signature algorithms', advanced: true }
        ]
      },
      {
        id: 'claims',
        title: 'Claims',
        step: 'attributes',
        fields: [
          { key: 'usernameClaim', label: 'Username claim' },
          { key: 'displayNameClaim', label: 'Display name claim' },
          { key: 'emailClaim', label: 'Email claim' },
          { key: 'groupsClaim', label: 'Groups claim' }
        ]
      },
      access
    ]
  },
  test: connectivityTest
});

registerStoreKind({
  kind: 'saml',
  title: 'Upstream SAML 2.0',
  description: 'Sign-in by redirect to a SAML identity provider; this server is the service provider.',
  config: samlConfigSchema,
  signIn: 'redirect',
  schema: {
    sections: [
      {
        id: 'connection',
        title: 'Identity provider',
        step: 'connection',
        fields: [
          { key: 'entityId', label: 'Entity id' },
          { key: 'ssoUrl', label: 'Single sign-on URL' },
          { key: 'sloUrl', label: 'Single logout URL', advanced: true },
          { key: 'certificates', label: 'Signing certificates (base64 DER)', help: 'One per line, from the IdP metadata.' }
        ]
      },
      {
        id: 'attributes',
        title: 'Attributes',
        step: 'attributes',
        fields: [
          { key: 'usernameAttribute', label: 'Username attribute', help: 'Empty means the NameID.' },
          { key: 'displayNameAttribute', label: 'Display name attribute' },
          { key: 'emailAttribute', label: 'Email attribute' },
          { key: 'groupsAttribute', label: 'Groups attribute' }
        ]
      },
      access
    ]
  },
  test: connectivityTest
});

registerStoreKind({
  kind: 'github',
  title: 'GitHub sign-in',
  description: 'GitHub or GitHub Enterprise Server as an OAuth app; organisations and teams become groups.',
  config: githubConfigSchema,
  signIn: 'redirect',
  schema: {
    sections: [
      {
        id: 'connection',
        title: 'OAuth app',
        step: 'connection',
        fields: [
          { key: 'clientId', label: 'Client id' },
          { key: 'clientSecret', label: 'Client secret' },
          { key: 'webUrl', label: 'Web address' },
          { key: 'apiUrl', label: 'API address' },
          { key: 'scopes', label: 'Scopes', advanced: true }
        ]
      },
      { id: 'orgs', title: 'Organisations', step: 'attributes', fields: [{ key: 'allowedOrgs', label: 'Allowed organisations', help: 'Empty: any GitHub account, then the mappings decide.' }] },
      access
    ]
  },
  test: connectivityTest
});

registerStoreKind({
  kind: 'atproto',
  title: 'AT-Protocol accounts',
  description: 'Sign-in by OAuth with each account\'s own authorization server; DIDs are the groups.',
  config: atprotoConfigSchema,
  signIn: 'redirect',
  schema: {
    sections: [
      {
        id: 'connection',
        title: 'Accounts',
        step: 'connection',
        fields: [
          { key: 'boundOnly', label: 'Only DIDs bound to a user' },
          { key: 'authServers', label: 'Accepted authorization servers (origins)', help: 'Empty: any.' }
        ]
      },
      access
    ]
  },
  test: connectivityTest
});

registerStoreKind({
  kind: 'scim',
  title: 'SCIM 2.0 provisioning',
  description: 'Users and groups pushed by an identity provider (Entra ID, Okta) to /scim/v2; no passwords.',
  config: scimConfigSchema,
  signIn: 'push',
  schema: {
    sections: [
      { id: 'connection', title: 'Sign-in', step: 'connection', fields: [{ key: 'signInStores', label: 'Sign-in stores (ids)', help: 'The OIDC, SAML or GitHub stores its users sign in through.' }] },
      access
    ]
  },
  test: connectivityTest
});
