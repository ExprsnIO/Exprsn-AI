import { X509Certificate } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { hmac, randomToken } from '../crypto/index.js';
import type { Services } from '../services.js';
import type { SigningKeys } from './keys.js';
import type { TenantCtx } from './oidc.js';
import { normaliseCertificate } from './x509.js';
import { attr, child, descendants, elements, escAttr, escText, NS, parseXml, signEnveloped, textOf, verifyEnveloped, verifyRedirectSignature, XmlError, type XmlElement } from './xml.js';

export const NAMEID_FORMATS = {
  emailAddress: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient'
} as const;
export type NameIdFormat = keyof typeof NAMEID_FORMATS;

export const BINDING = {
  post: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  redirect: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
};

export const DEFAULT_ATTRIBUTES: Record<string, string> = { username: 'uid', email: 'email', displayName: 'displayName', groups: 'groups', roles: 'roles', clearance: 'clearance' };

export interface AcsUrl {
  url: string;
  index: number;
  binding: string;
}

export interface SpRow {
  id: string;
  tenant_id: string;
  name: string;
  entity_id: string;
  acs_urls: AcsUrl[];
  nameid_format: NameIdFormat;
  certificate: string | null;
  signed_requests: boolean;
  attribute_map: Record<string, string>;
  status: 'active' | 'disabled';
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

const spFromRow = (r: Record<string, unknown>): SpRow => ({
  ...(r as unknown as SpRow),
  acs_urls: json<AcsUrl[]>(r.acs_urls, []),
  signed_requests: !!r.signed_requests,
  attribute_map: json<Record<string, string>>(r.attribute_map, {}),
  last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export interface CertInfo {
  subject: string;
  issuer: string;
  validTo: number;
  fingerprint: string;
  expired: boolean;
}

export function certInfo(b64: string | null): CertInfo | null {
  if (!b64) return null;
  try {
    const c = new X509Certificate(Buffer.from(b64, 'base64'));
    const validTo = Date.parse(c.validTo);
    return { subject: c.subject.replace(/\n/g, ', '), issuer: c.issuer.replace(/\n/g, ', '), validTo, fingerprint: c.fingerprint256, expired: validTo < Date.now() };
  } catch {
    return null;
  }
}

export interface ParsedSpMetadata {
  entityId: string;
  acsUrls: AcsUrl[];
  certificate: string | null;
  cert: CertInfo | null;
  nameIdFormat: NameIdFormat;
  signedRequests: boolean;
}

const formatKey = (uri: string | undefined): NameIdFormat => (Object.entries(NAMEID_FORMATS).find(([, v]) => v === uri)?.[0] as NameIdFormat | undefined) ?? 'unspecified';

/** Parses SP metadata pasted by an admin. Nothing is fetched. */
export function parseSpMetadata(xml: string): ParsedSpMetadata {
  const root = parseXml(xml, 512 * 1024);
  const ed = root.local === 'EntityDescriptor' ? root : descendants(root, NS.md, 'EntityDescriptor')[0];
  if (!ed || ed.ns !== NS.md) throw new XmlError('No md:EntityDescriptor found.');
  const entityId = attr(ed, 'entityID');
  const sp = child(ed, NS.md, 'SPSSODescriptor');
  if (!entityId || !sp) throw new XmlError('The metadata has no entityID or SPSSODescriptor.');
  const acsUrls = elements(sp, NS.md, 'AssertionConsumerService')
    .map((e) => ({ url: attr(e, 'Location') ?? '', index: Number(attr(e, 'index') ?? 0), binding: attr(e, 'Binding') ?? BINDING.post }))
    .filter((a) => /^https?:\/\//.test(a.url) && a.binding === BINDING.post);
  if (!acsUrls.length) throw new XmlError('The metadata has no HTTP-POST AssertionConsumerService.');
  const signingKey = elements(sp, NS.md, 'KeyDescriptor').find((k) => (attr(k, 'use') ?? 'signing') === 'signing');
  const certEl = signingKey ? descendants(signingKey, NS.ds, 'X509Certificate')[0] : undefined;
  const certificate = certEl ? normaliseCertificate(textOf(certEl)) : null;
  return {
    entityId,
    acsUrls,
    certificate,
    cert: certInfo(certificate),
    nameIdFormat: formatKey(textOf(child(sp, NS.md, 'NameIDFormat')).trim() || undefined),
    signedRequests: attr(sp, 'AuthnRequestsSigned') === 'true'
  };
}

export interface AuthnRequest {
  id: string;
  issuer: string;
  acsUrl: string | null;
  acsIndex: number | null;
  forceAuthn: boolean;
  isPassive: boolean;
}

export class SamlError extends Error {}

const isoNow = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const newId = () => `_${randomToken(20).replace(/[^A-Za-z0-9]/g, 'x')}`;

/**
 * The SAML 2.0 IdP: service provider registrations, metadata, SP-initiated SSO over the HTTP-Redirect and HTTP-POST
 * bindings, and responses whose assertion carries an enveloped RSA-SHA256 signature. The IdP entity ID is
 * `<issuer>/saml/idp`.
 */
export class SamlIdp {
  constructor(
    private readonly s: () => Services,
    private readonly keys: SigningKeys
  ) {}

  private get db() {
    return this.s().db;
  }

  entityId(t: TenantCtx): string {
    return `${t.issuer}/saml/idp`;
  }

  async list(tenantId: string): Promise<SpRow[]> {
    return (await this.db('saml_service_providers').where({ tenant_id: tenantId }).orderBy('name')).map(spFromRow);
  }

  async get(tenantId: string, id: string): Promise<SpRow | undefined> {
    const r = await this.db('saml_service_providers').where({ tenant_id: tenantId, id }).first();
    return r ? spFromRow(r) : undefined;
  }

  async byEntity(tenantId: string, entityId: string): Promise<SpRow | undefined> {
    const r = await this.db('saml_service_providers').where({ tenant_id: tenantId, entity_id: entityId }).first();
    return r ? spFromRow(r) : undefined;
  }

  async create(tenantId: string, input: { name: string; entityId: string; acsUrls: AcsUrl[]; nameIdFormat: NameIdFormat; certificate: string | null; signedRequests: boolean; attributeMap: Record<string, string> }): Promise<SpRow> {
    const t = Date.now();
    const row = { id: ulid(), tenant_id: tenantId, name: input.name, entity_id: input.entityId, acs_urls: JSON.stringify(input.acsUrls), nameid_format: input.nameIdFormat, certificate: input.certificate, signed_requests: input.signedRequests, attribute_map: JSON.stringify(input.attributeMap), status: 'active', last_used_at: null, created_at: t, updated_at: t };
    await this.db('saml_service_providers').insert(row);
    return spFromRow(row);
  }

  async update(tenantId: string, id: string, patch: { status?: 'active' | 'disabled'; signedRequests?: boolean; nameIdFormat?: NameIdFormat; attributeMap?: Record<string, string>; certificate?: string | null }): Promise<SpRow | undefined> {
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.status) upd.status = patch.status;
    if (patch.signedRequests !== undefined) upd.signed_requests = patch.signedRequests;
    if (patch.nameIdFormat) upd.nameid_format = patch.nameIdFormat;
    if (patch.attributeMap) upd.attribute_map = JSON.stringify(patch.attributeMap);
    if (patch.certificate !== undefined) upd.certificate = patch.certificate;
    await this.db('saml_service_providers').where({ tenant_id: tenantId, id }).update(upd);
    return this.get(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    return (await this.db('saml_service_providers').where({ tenant_id: tenantId, id }).delete()) > 0;
  }

  /** IdP metadata: entity ID, signing certificate, SSO endpoints for both bindings, NameID formats. */
  async metadata(t: TenantCtx): Promise<string> {
    const { row } = await this.keys.signer(t.id, 'saml');
    const sso = `${t.issuer}/saml/sso`;
    return `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="${NS.md}" xmlns:ds="${NS.ds}" entityID="${escAttr(this.entityId(t))}"><md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${row.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>${Object.values(NAMEID_FORMATS).map((f) => `<md:NameIDFormat>${f}</md:NameIDFormat>`).join('')}<md:SingleSignOnService Binding="${BINDING.redirect}" Location="${escAttr(sso)}"/><md:SingleSignOnService Binding="${BINDING.post}" Location="${escAttr(sso)}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
  }

  async certificate(t: TenantCtx): Promise<{ kid: string; certificate: string }> {
    const { row } = await this.keys.signer(t.id, 'saml');
    return { kid: row.kid, certificate: row.certificate ?? '' };
  }

  /**
   * Decodes and checks an AuthnRequest: base64 (and DEFLATE for the redirect binding), a known and enabled SP,
   * a registered ACS URL, and the SP's signature when the SP is registered with signed requests.
   */
  async parseRequest(t: TenantCtx, binding: 'redirect' | 'post', samlRequest: string, rawQuery: string): Promise<{ sp: SpRow; request: AuthnRequest; acs: AcsUrl }> {
    let xml: string;
    try {
      const bytes = Buffer.from(samlRequest, 'base64');
      xml = (binding === 'redirect' ? inflateRawSync(bytes, { maxOutputLength: 256 * 1024 }) : bytes).toString('utf8');
    } catch {
      throw new SamlError('The SAMLRequest could not be decoded.');
    }
    let root: XmlElement;
    try {
      root = parseXml(xml, 256 * 1024);
    } catch (err) {
      throw new SamlError(`The SAMLRequest is not valid XML: ${(err as Error).message}`);
    }
    if (root.ns !== NS.samlp || root.local !== 'AuthnRequest') throw new SamlError('Expected a samlp:AuthnRequest.');
    const id = attr(root, 'ID');
    const issuer = textOf(child(root, NS.saml, 'Issuer')).trim();
    if (!id || !issuer) throw new SamlError('The AuthnRequest has no ID or Issuer.');
    const sp = await this.byEntity(t.id, issuer);
    if (!sp) throw new SamlError(`No service provider is registered as ${issuer}.`);
    if (sp.status !== 'active') throw new SamlError(`The service provider ${sp.name} is disabled.`);
    if (sp.signed_requests) {
      if (!sp.certificate) throw new SamlError('The service provider has no certificate to verify its signed requests.');
      const v = binding === 'redirect' ? verifyRedirectSignature(rawQuery, [sp.certificate]) : verifyEnveloped(root, root, [sp.certificate]);
      if (!v.ok) throw new SamlError(v.reason ?? 'The request signature does not verify.');
    }
    const acsUrl = attr(root, 'AssertionConsumerServiceURL') ?? null;
    const acsIndexRaw = attr(root, 'AssertionConsumerServiceIndex');
    const acsIndex = acsIndexRaw != null ? Number(acsIndexRaw) : null;
    let acs: AcsUrl | undefined;
    if (acsUrl) acs = sp.acs_urls.find((a) => a.url === acsUrl);
    else if (acsIndex != null) acs = sp.acs_urls.find((a) => a.index === acsIndex);
    else acs = [...sp.acs_urls].sort((a, b) => a.index - b.index)[0];
    if (!acs) throw new SamlError('The requested AssertionConsumerService is not registered for this service provider.');
    return { sp, acs, request: { id, issuer, acsUrl, acsIndex, forceAuthn: attr(root, 'ForceAuthn') === 'true', isPassive: attr(root, 'IsPassive') === 'true' } };
  }

  private nameId(sp: SpRow, user: { id: string; username: string; email: string | null }): string {
    switch (sp.nameid_format) {
      case 'emailAddress':
        return user.email ?? user.username;
      case 'persistent':
        // Pairwise: stable for this SP, unlinkable across SPs.
        return hmac(this.s().cfg.SESSION_SECRET, `saml-persistent:${sp.entity_id}:${user.id}`).slice(0, 40);
      case 'transient':
        return newId();
      default:
        return user.username;
    }
  }

  /** Builds the signed samlp:Response (base64) for a signed-in user. */
  async response(t: TenantCtx, sp: SpRow, acs: AcsUrl, inResponseTo: string | null, user: { id: string; username: string; displayName: string; email: string | null; groups: string[]; roles: string[]; clearance: string; authTime: number; method: string }): Promise<string> {
    const { row, key } = await this.keys.signer(t.id, 'saml');
    const now = Date.now();
    const until = isoNow(now + this.s().cfg.SAML_ASSERTION_MINUTES * 60_000);
    const idp = escText(this.entityId(t));
    const map = { ...DEFAULT_ATTRIBUTES, ...sp.attribute_map };
    const values: Record<string, string[]> = { username: [user.username], email: user.email ? [user.email] : [], displayName: [user.displayName], groups: user.groups, roles: user.roles, clearance: [user.clearance] };
    const attributes = Object.entries(values)
      .filter(([k, v]) => map[k] && v.length)
      .map(([k, v]) => `<saml:Attribute Name="${escAttr(map[k]!)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${v.map((x) => `<saml:AttributeValue>${escText(x)}</saml:AttributeValue>`).join('')}</saml:Attribute>`)
      .join('');
    const irt = inResponseTo ? ` InResponseTo="${escAttr(inResponseTo)}"` : '';
    const assertionId = newId();
    const classRef = /kerberos/i.test(user.method) ? 'urn:oasis:names:tc:SAML:2.0:ac:classes:Kerberos' : 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
    const assertion =
      `<saml:Assertion xmlns:saml="${NS.saml}" ID="${assertionId}" IssueInstant="${isoNow(now)}" Version="2.0">` +
      `<saml:Issuer>${idp}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="${NAMEID_FORMATS[sp.nameid_format]}">${escText(this.nameId(sp, user))}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${until}" Recipient="${escAttr(acs.url)}"></saml:SubjectConfirmationData></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${isoNow(now - 60_000)}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${escText(sp.entity_id)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${isoNow(user.authTime)}" SessionIndex="${newId()}"><saml:AuthnContext><saml:AuthnContextClassRef>${classRef}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      (attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : '') +
      `</saml:Assertion>`;
    const signed = signEnveloped(assertion, key, row.certificate!, { afterLocal: 'Issuer' });
    const response =
      `<samlp:Response xmlns:samlp="${NS.samlp}" Destination="${escAttr(acs.url)}" ID="${newId()}"${irt} IssueInstant="${isoNow(now)}" Version="2.0">` +
      `<saml:Issuer xmlns:saml="${NS.saml}">${idp}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"></samlp:StatusCode></samlp:Status>` +
      signed +
      `</samlp:Response>`;
    await this.db('saml_service_providers').where({ id: sp.id }).update({ last_used_at: now });
    return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${response}`, 'utf8').toString('base64');
  }
}
