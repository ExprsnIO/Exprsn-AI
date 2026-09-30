import { canonicalJson, sha256 } from '../crypto/index.js';
import { parseProviderConfig, type SamlUpstreamConfig } from '../identity/providers/types.js';
import type { Services } from '../services.js';
import type { FederationProposalRow, FederationProposals, ProposalActor } from './proposals.js';
import { certInfo, parseSpMetadata, type AcsUrl, type ParsedSpMetadata, type SpRow } from './saml.js';
import { parseIdpMetadata } from './upstream.js';

export interface MetadataSourceRow {
  id: string;
  tenant_id: string;
  kind: 'sp' | 'idp';
  url: string;
  digest: string | null;
  fetched_at: number | null;
  error: string | null;
  created_at: number;
}

/** The parts of SP metadata that decide where assertions go and whose signatures count. */
export interface SpSnapshot {
  entityId: string;
  acsUrls: AcsUrl[];
  certificate: string | null;
  encryptionCertificate: string | null;
  sloUrl: string | null;
  sloBinding: 'redirect' | 'post' | null;
}

/** The parts of IdP metadata that decide which signatures are trusted and where the browser is sent. */
export interface IdpSnapshot {
  entityId: string;
  ssoUrl: string;
  sloUrl: string | null;
  certificates: string[];
}

const toRow = (r: Record<string, unknown>): MetadataSourceRow => ({ ...(r as unknown as MetadataSourceRow), fetched_at: r.fetched_at == null ? null : Number(r.fetched_at), created_at: Number(r.created_at) });

export const spSnapshot = (m: ParsedSpMetadata | SpRow): SpSnapshot =>
  'entityId' in m
    ? { entityId: m.entityId, acsUrls: m.acsUrls, certificate: m.certificate, encryptionCertificate: m.encryptionCertificate, sloUrl: m.sloUrl, sloBinding: m.sloBinding }
    : { entityId: m.entity_id, acsUrls: m.acs_urls, certificate: m.certificate, encryptionCertificate: m.encryption_certificate, sloUrl: m.slo_url, sloBinding: m.slo_binding };

export const idpSnapshot = (m: { entityId: string; ssoUrl: string; sloUrl?: string | null; certificates: string[] }): IdpSnapshot => ({ entityId: m.entityId, ssoUrl: m.ssoUrl, sloUrl: m.sloUrl ?? null, certificates: [...m.certificates].sort() });

const digestOf = (v: unknown): string => sha256(canonicalJson(v));
const fp = (cert: string | null): string => (cert ? (certInfo(cert)?.fingerprint ?? 'unreadable') : 'none');

/** A plain description of what changed between two snapshots, for the proposal and the audit trail. */
function describe(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of Object.keys(after)) {
    if (canonicalJson(before[k] ?? null) === canonicalJson(after[k] ?? null)) continue;
    if (k === 'certificate' || k === 'encryptionCertificate') parts.push(`${k === 'certificate' ? 'signing' : 'encryption'} certificate ${fp(before[k] as string | null)} → ${fp(after[k] as string | null)}`);
    else if (k === 'certificates') parts.push(`signing certificates ${((before[k] as string[] | undefined) ?? []).map(fp).join(', ') || 'none'} → ${(after[k] as string[]).map(fp).join(', ')}`);
    else if (k === 'acsUrls') parts.push(`assertion consumer services ${((before[k] as AcsUrl[] | undefined) ?? []).map((a) => a.url).join(', ')} → ${(after[k] as AcsUrl[]).map((a) => a.url).join(', ')}`);
    else parts.push(`${k} ${String(before[k] ?? 'none')} → ${String(after[k] ?? 'none')}`);
  }
  return parts.join('; ');
}

/**
 * SAML metadata fetched from a URL (B-807) for registered service providers and upstream identity providers. The URL
 * is fetched through the upstream federation checks (internal hosts or FEDERATION_ALLOWED_HOSTS, re-checked at dial
 * time, no redirects, 1 MB). The first fetch is applied when the admin registers it; later fetches (daily, or on
 * demand) that change a certificate or an endpoint become a proposal an identity admin approves, and until then the
 * previous values stay in force.
 */
export class FederationMetadata {
  constructor(
    private readonly s: () => Services,
    private readonly proposals: FederationProposals
  ) {
    proposals.onApprove('metadata.sp', (p, by) => this.applySp(p, by));
    proposals.onApprove('metadata.idp', (p, by) => this.applyIdp(p, by));
  }

  async source(tenantId: string, id: string): Promise<MetadataSourceRow | null> {
    const r = await this.s().db('federation_metadata').where({ tenant_id: tenantId, id }).first();
    return r ? toRow(r) : null;
  }

  async sources(tenantId: string): Promise<MetadataSourceRow[]> {
    return ((await this.s().db('federation_metadata').where({ tenant_id: tenantId }).orderBy('created_at')) as Record<string, unknown>[]).map(toRow);
  }

  /** Fetches metadata from a URL through the outbound checks. */
  fetch(url: string): Promise<string> {
    return this.s().federation.upstream.fetchMetadata(url);
  }

  /** Remembers where a registered SP's or IdP's metadata comes from, with the snapshot that was applied. */
  async register(tenantId: string, kind: 'sp' | 'idp', targetId: string, url: string, applied: SpSnapshot | IdpSnapshot): Promise<void> {
    const db = this.s().db;
    const row = { id: targetId, tenant_id: tenantId, kind, url, digest: digestOf(applied), fetched_at: Date.now(), error: null, created_at: Date.now() };
    const n = await db('federation_metadata').where({ id: targetId }).update({ url, digest: row.digest, fetched_at: row.fetched_at, error: null });
    if (!n) await db('federation_metadata').insert(row);
  }

  async forget(tenantId: string, targetId: string): Promise<void> {
    await this.s().db('federation_metadata').where({ tenant_id: tenantId, id: targetId }).delete();
  }

  /**
   * Fetches one source again. Unchanged metadata only records the time; a change of certificates or endpoints
   * becomes a proposal (replacing an older pending one). The entity ID may never change: that is another party.
   */
  async refresh(tenantId: string, id: string): Promise<{ state: 'unchanged' | 'proposed' | 'pending' | 'error'; proposal?: FederationProposalRow; error?: string }> {
    const s = this.s();
    const src = await this.source(tenantId, id);
    if (!src) return { state: 'error', error: 'No metadata URL is registered for it.' };
    const fail = async (message: string) => {
      await s.db('federation_metadata').where({ id }).update({ fetched_at: Date.now(), error: message.slice(0, 500) });
      await s.audit.append({ tenantId, action: 'federation.metadata.failed', kind: 'system', actor: { service: 'federation' }, target: { kind: src.kind, target: id, url: src.url }, detail: { error: message.slice(0, 300) } });
      return { state: 'error' as const, error: message };
    };
    let before: SpSnapshot | IdpSnapshot;
    let after: SpSnapshot | IdpSnapshot;
    let name: string;
    try {
      const xml = await this.fetch(src.url);
      if (src.kind === 'sp') {
        const sp = await s.federation.saml.get(tenantId, id);
        if (!sp) return fail('The service provider no longer exists.');
        name = sp.name;
        before = spSnapshot(sp);
        after = spSnapshot(parseSpMetadata(xml));
      } else {
        const row = await s.providers.get(tenantId, id);
        if (!row || row.kind !== 'saml') return fail('The identity provider no longer exists.');
        name = row.name;
        before = idpSnapshot(row.config as unknown as SamlUpstreamConfig);
        after = idpSnapshot(parseIdpMetadata(xml));
      }
    } catch (err) {
      return fail((err as Error).message);
    }
    if (after.entityId !== before.entityId) return fail(`The metadata now names entity ${after.entityId}, not ${before.entityId}. Register it as a new party if that is intended.`);
    const digest = digestOf(after);
    if (digest === digestOf(before)) {
      await s.db('federation_metadata').where({ id }).update({ fetched_at: Date.now(), error: null, digest });
      return { state: 'unchanged' };
    }
    const kind = src.kind === 'sp' ? 'metadata.sp' : 'metadata.idp';
    const pending = await this.proposals.pendingFor(tenantId, kind, id);
    await s.db('federation_metadata').where({ id }).update({ fetched_at: Date.now(), error: null });
    if (pending && pending.payload.digest === digest) return { state: 'pending', proposal: pending };
    const summary = `Fetched metadata changed: ${describe(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)}. The current values stay in force until an identity admin approves.`;
    const proposal = await this.proposals.propose(tenantId, { kind, targetId: id, name, payload: { snapshot: after, digest, url: src.url }, summary }, null);
    return { state: 'proposed', proposal };
  }

  /** The scheduled refresh of every source in a tenant. */
  async refreshTenant(tenantId: string): Promise<{ checked: number; proposed: number; failed: number }> {
    const out = { checked: 0, proposed: 0, failed: 0 };
    for (const src of await this.sources(tenantId)) {
      const r = await this.refresh(tenantId, src.id);
      out.checked++;
      if (r.state === 'proposed') out.proposed++;
      if (r.state === 'error') out.failed++;
    }
    return out;
  }

  private async applySp(p: FederationProposalRow, by: ProposalActor): Promise<void> {
    const s = this.s();
    const snap = p.payload.snapshot as SpSnapshot;
    const sp = await s.federation.saml.get(p.tenant_id, p.target_id);
    if (!sp || sp.entity_id !== snap.entityId) throw new Error('The service provider changed since the proposal was made.');
    const encrypt = sp.encrypt_assertions && !!snap.encryptionCertificate;
    await s.db('saml_service_providers').where({ tenant_id: p.tenant_id, id: sp.id }).update({ acs_urls: JSON.stringify(snap.acsUrls), certificate: snap.certificate, encryption_certificate: snap.encryptionCertificate, encrypt_assertions: encrypt, slo_url: snap.sloUrl, slo_binding: snap.sloBinding, signed_requests: sp.signed_requests && !!snap.certificate, updated_at: Date.now() });
    await s.db('federation_metadata').where({ id: sp.id }).update({ digest: String(p.payload.digest ?? '') });
    await s.audit.append({ tenantId: p.tenant_id, action: 'federation.saml_sp.metadata_applied', kind: 'admin', actor: { user: by.userId, username: by.username, ip: by.ip }, target: { sp: sp.id, name: sp.name, entity: sp.entity_id }, detail: { proposal: p.id, cert: fp(snap.certificate), encryptionCert: fp(snap.encryptionCertificate), acs: snap.acsUrls.map((a) => a.url), slo: snap.sloUrl } });
  }

  private async applyIdp(p: FederationProposalRow, by: ProposalActor): Promise<void> {
    const s = this.s();
    const snap = p.payload.snapshot as IdpSnapshot;
    const row = await s.providers.get(p.tenant_id, p.target_id);
    const cfg = row?.config as unknown as SamlUpstreamConfig | undefined;
    if (!row || row.kind !== 'saml' || cfg?.entityId !== snap.entityId) throw new Error('The identity provider changed since the proposal was made.');
    const next: Record<string, unknown> = { ...cfg, ssoUrl: snap.ssoUrl, certificates: snap.certificates };
    if (snap.sloUrl) next.sloUrl = snap.sloUrl;
    else delete next.sloUrl;
    parseProviderConfig('saml', next);
    await s.providers.update(p.tenant_id, row.id, { config: next });
    await s.db('federation_metadata').where({ id: row.id }).update({ digest: String(p.payload.digest ?? '') });
    await s.audit.append({ tenantId: p.tenant_id, action: 'identity.provider.metadata_applied', kind: 'admin', actor: { user: by.userId, username: by.username, ip: by.ip }, target: { provider: row.id, name: row.name, kind: 'saml' }, detail: { proposal: p.id, certificates: snap.certificates.map(fp), ssoUrl: snap.ssoUrl, sloUrl: snap.sloUrl } });
  }
}
