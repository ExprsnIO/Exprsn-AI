import { ENTERPRISE_SCHEMA, GROUP_SCHEMA, USER_SCHEMA } from './filter.js';

/*
 * The SCIM discovery documents (RFC 7643 sections 5 to 8, RFC 7644 section 4): ServiceProviderConfig, ResourceTypes
 * and Schemas for the core User (with the enterprise extension) and Group. The attribute definitions here are also
 * what the service keeps: an attribute the schemas do not define is ignored on write (RFC 7644 3.3), `password` is
 * never stored or returned, and read-only attributes (`id`, `meta`, a user's `groups`) are set by the server.
 */

export const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SPC_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
export const RT_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
export const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

type AttrType = 'string' | 'boolean' | 'complex' | 'reference' | 'dateTime' | 'binary' | 'decimal' | 'integer';

export interface AttrDef {
  name: string;
  type: AttrType;
  multiValued: boolean;
  description: string;
  required: boolean;
  caseExact: boolean;
  mutability: 'readOnly' | 'readWrite' | 'immutable' | 'writeOnly';
  returned: 'always' | 'never' | 'default' | 'request';
  uniqueness: 'none' | 'server' | 'global';
  subAttributes?: AttrDef[];
  canonicalValues?: string[];
  referenceTypes?: string[];
}

const a = (name: string, description: string, o: Partial<AttrDef> = {}): AttrDef => ({
  name,
  type: 'string',
  multiValued: false,
  description,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...o
});

/** The sub-attributes of a multi-valued attribute such as emails (value, display, type, primary). */
const multi = (name: string, description: string, types: string[], valueType: AttrType = 'string'): AttrDef =>
  a(name, description, {
    type: 'complex',
    multiValued: true,
    subAttributes: [
      a('value', `The ${name} value.`, { type: valueType }),
      a('display', 'A human-readable name.'),
      a('type', 'A label for its function.', { canonicalValues: types }),
      a('primary', 'Whether this is the primary value.', { type: 'boolean' })
    ]
  });

export const USER_ATTRS: AttrDef[] = [
  a('userName', 'The unique name the user signs in with; it becomes their username in Exprsn AI (lower case).', { required: true, uniqueness: 'server' }),
  a('name', 'The components of the user\'s name.', {
    type: 'complex',
    subAttributes: ['formatted', 'familyName', 'givenName', 'middleName', 'honorificPrefix', 'honorificSuffix'].map((n) => a(n, `The ${n} part of the name.`))
  }),
  a('displayName', 'The name shown for the user.'),
  a('nickName', 'A casual name.'),
  a('profileUrl', 'A profile page.', { type: 'reference', referenceTypes: ['external'] }),
  a('title', 'The user\'s title.'),
  a('userType', 'The relationship to the organisation.'),
  a('preferredLanguage', 'The preferred language.'),
  a('locale', 'The locale.'),
  a('timezone', 'The time zone.'),
  a('active', 'Whether the user may sign in. false disables the user and ends their sessions, OAuth grants, API keys and app passwords.', { type: 'boolean' }),
  a('password', 'Not kept: SCIM users sign in through the stores the SCIM store names.', { mutability: 'writeOnly', returned: 'never' }),
  multi('emails', 'Email addresses; the primary (else the first) becomes the user\'s address.', ['work', 'home', 'other']),
  multi('phoneNumbers', 'Phone numbers.', ['work', 'home', 'mobile', 'fax', 'pager', 'other']),
  multi('ims', 'Instant messaging addresses.', ['aim', 'gtalk', 'icq', 'xmpp', 'msn', 'skype', 'qq', 'yahoo']),
  multi('photos', 'Photo URLs.', ['photo', 'thumbnail'], 'reference'),
  a('addresses', 'Physical addresses.', {
    type: 'complex',
    multiValued: true,
    subAttributes: ['formatted', 'streetAddress', 'locality', 'region', 'postalCode', 'country', 'type'].map((n) => a(n, `The ${n} of the address.`)).concat([a('primary', 'Whether this is the primary address.', { type: 'boolean' })])
  }),
  a('groups', 'The groups the user is a member of (set through Groups).', {
    type: 'complex',
    multiValued: true,
    mutability: 'readOnly',
    subAttributes: [a('value', 'The group id.', { mutability: 'readOnly' }), a('$ref', 'The group URI.', { type: 'reference', referenceTypes: ['Group'], mutability: 'readOnly' }), a('display', 'The group\'s name.', { mutability: 'readOnly' }), a('type', 'direct', { mutability: 'readOnly', canonicalValues: ['direct'] })]
  }),
  multi('entitlements', 'Entitlements.', []),
  multi('roles', 'Roles as the provider names them (Exprsn AI roles come from group mappings).', []),
  multi('x509Certificates', 'Certificates.', [], 'binary')
];

export const ENTERPRISE_ATTRS: AttrDef[] = [
  a('employeeNumber', 'The employee number.'),
  a('costCenter', 'The cost centre.'),
  a('organization', 'The organisation.'),
  a('division', 'The division.'),
  a('department', 'The department.'),
  a('manager', 'The user\'s manager (access reviews assign them).', {
    type: 'complex',
    subAttributes: [a('value', 'The manager\'s id.'), a('$ref', 'The manager\'s URI.', { type: 'reference', referenceTypes: ['User'] }), a('displayName', 'The manager\'s name.', { mutability: 'readOnly' })]
  })
];

export const GROUP_ATTRS: AttrDef[] = [
  a('displayName', 'The group\'s name; group mappings with this SCIM store name it to give its members roles, clearance and workspaces.', { required: true, uniqueness: 'server' }),
  a('members', 'The group\'s members (users of this SCIM store).', {
    type: 'complex',
    multiValued: true,
    subAttributes: [a('value', 'The member\'s id.', { mutability: 'immutable' }), a('$ref', 'The member\'s URI.', { type: 'reference', referenceTypes: ['User'], mutability: 'immutable' }), a('display', 'The member\'s name.', { mutability: 'readOnly' }), a('type', 'User', { mutability: 'immutable', canonicalValues: ['User'] })]
  })
];

const COMMON_ATTRS = [
  a('id', 'The server\'s id for the resource.', { caseExact: true, mutability: 'readOnly', returned: 'always', uniqueness: 'server' }),
  a('externalId', 'The provider\'s id for the resource.', { caseExact: true })
];

export const definitionsFor = (schema: string): AttrDef[] => (schema === USER_SCHEMA ? [...COMMON_ATTRS, ...USER_ATTRS] : schema === GROUP_SCHEMA ? [...COMMON_ATTRS, ...GROUP_ATTRS] : schema === ENTERPRISE_SCHEMA ? ENTERPRISE_ATTRS : []);

/** The canonical spelling of an attribute name in a schema (names are case-insensitive), or undefined. */
export function canonical(defs: AttrDef[], name: string): AttrDef | undefined {
  const l = name.toLowerCase();
  return defs.find((d) => d.name.toLowerCase() === l);
}

const meta = (base: string, type: string, path: string) => ({ resourceType: type, location: `${base}/${path}` });

export function serviceProviderConfig(base: string, maxResults: number) {
  return {
    schemas: [SPC_SCHEMA],
    documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: true },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A SCIM token made under Identity, on the SCIM store (identity:manage). Shown once.', primary: true }],
    meta: { ...meta(base, 'ServiceProviderConfig', 'ServiceProviderConfig') }
  };
}

export function resourceTypes(base: string) {
  return [
    { schemas: [RT_SCHEMA], id: 'User', name: 'User', endpoint: '/Users', description: 'A user of the tenant, in this SCIM store', schema: USER_SCHEMA, schemaExtensions: [{ schema: ENTERPRISE_SCHEMA, required: false }], meta: meta(base, 'ResourceType', 'ResourceTypes/User') },
    { schemas: [RT_SCHEMA], id: 'Group', name: 'Group', endpoint: '/Groups', description: 'A group whose members get the roles its group mappings name', schema: GROUP_SCHEMA, meta: meta(base, 'ResourceType', 'ResourceTypes/Group') }
  ];
}

export function schemaDocs(base: string) {
  const doc = (id: string, name: string, description: string, attributes: AttrDef[]) => ({ schemas: [SCHEMA_SCHEMA], id, name, description, attributes, meta: meta(base, 'Schema', `Schemas/${id}`) });
  return [
    doc(USER_SCHEMA, 'User', 'User account', [...COMMON_ATTRS.slice(1), ...USER_ATTRS]),
    doc(ENTERPRISE_SCHEMA, 'EnterpriseUser', 'Enterprise user', ENTERPRISE_ATTRS),
    doc(GROUP_SCHEMA, 'Group', 'Group', [...COMMON_ATTRS.slice(1), ...GROUP_ATTRS])
  ];
}
