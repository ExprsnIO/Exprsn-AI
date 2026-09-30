import { createPublicKey, type KeyObject } from 'node:crypto';
import { ulid } from 'ulid';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { keyFingerprint, type BundleService, type SignerKeyRow } from './bundles.js';
import { audit, notifyAdmins, shortFingerprint, type OpsActor } from './common.js';

export interface SignerProposalRow {
  id: string;
  action: 'add' | 'revoke';
  key_id: string | null;
  name: string;
  algorithm: string | null;
  fingerprint: string | null;
  public_key_pem: string | null;
  reason: string | null;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  proposed_by: string | null;
  proposed_tenant: string;
  proposed_at: number;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
}

const fromRow = (r: Record<string, unknown>): SignerProposalRow => ({ ...(r as unknown as SignerProposalRow), proposed_at: Number(r.proposed_at), decided_at: r.decided_at == null ? null : Number(r.decided_at) });

/**
 * Dual control for import signer keys (B-412). Adding or revoking a key is a proposal that a second platform admin
 * approves; only then does the change apply. The very first key (none registered yet) is the exception, as with the
 * default zone set: one admin registers it, and every later change needs two people.
 */
export class SignerProposals {
  constructor(
    private readonly s: () => Services,
    private readonly bundles: BundleService
  ) {}

  async list(limit = 50): Promise<SignerProposalRow[]> {
    return ((await this.s().db('platform_signer_proposals').orderBy('proposed_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(fromRow);
  }

  async get(id: string): Promise<SignerProposalRow> {
    const r = await this.s().db('platform_signer_proposals').where({ id }).first();
    if (!r) throw notFound('Signer key proposal');
    return fromRow(r);
  }

  /** Proposes a new key; with no keys registered yet it is added at once. */
  async proposeAdd(by: OpsActor, input: { name: string; publicKeyPem: string }): Promise<{ key: SignerKeyRow | null; proposal: SignerProposalRow | null }> {
    const existing = await this.bundles.keys();
    if (!existing.length) return { key: await this.bundles.addKey(by, input), proposal: null };
    let key: KeyObject;
    try {
      key = createPublicKey(input.publicKeyPem);
    } catch {
      throw badRequest('The public key is not a PEM public key.', { field: 'publicKeyPem' });
    }
    const algorithm = key.asymmetricKeyType === 'ed25519' ? 'ed25519' : key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? 'ecdsa-p256-sha256' : null;
    if (!algorithm) throw badRequest('Signer keys must be Ed25519 or ECDSA P-256.', { field: 'publicKeyPem' });
    const fingerprint = keyFingerprint(key);
    if (existing.some((k) => k.fingerprint === fingerprint)) throw conflict('That key is already registered.');
    if (await this.s().db('platform_signer_proposals').where({ state: 'pending', action: 'add', fingerprint }).first()) throw conflict('That key is already proposed and waiting for a second admin.');
    const row = { id: ulid(), action: 'add', key_id: null, name: input.name, algorithm, fingerprint, public_key_pem: key.export({ type: 'spki', format: 'pem' }).toString(), reason: null, state: 'pending', proposed_by: by.userId, proposed_tenant: by.tenantId, proposed_at: Date.now() };
    await this.s().db('platform_signer_proposals').insert(row);
    await audit(this.s(), by, 'platform.signer.proposed', { proposal: row.id, name: row.name }, { action: 'add', algorithm, fingerprint }, 'admin');
    await notifyAdmins(this.s(), { kind: 'platform.signer.proposed', title: `Signer key ${row.name} is waiting for a second admin`, body: `Fingerprint ${shortFingerprint(fingerprint)}. Another platform admin must approve it before bundles signed with it verify.` });
    return { key: null, proposal: await this.get(row.id) };
  }

  async proposeRevoke(by: OpsActor, keyId: string, reason: string): Promise<SignerProposalRow> {
    const k = (await this.bundles.keys()).find((x) => x.id === keyId);
    if (!k) throw notFound('Signer key');
    if (k.state === 'revoked') throw conflict('The key is already revoked.');
    if (await this.s().db('platform_signer_proposals').where({ state: 'pending', action: 'revoke', key_id: keyId }).first()) throw conflict('Revoking this key is already proposed and waiting for a second admin.');
    const row = { id: ulid(), action: 'revoke', key_id: keyId, name: k.name, algorithm: k.algorithm, fingerprint: k.fingerprint, public_key_pem: null, reason, state: 'pending', proposed_by: by.userId, proposed_tenant: by.tenantId, proposed_at: Date.now() };
    await this.s().db('platform_signer_proposals').insert(row);
    await audit(this.s(), by, 'platform.signer.proposed', { proposal: row.id, key: keyId, name: k.name }, { action: 'revoke', fingerprint: k.fingerprint, reason }, 'admin');
    await notifyAdmins(this.s(), { kind: 'platform.signer.proposed', title: `Revoking signer key ${k.name} is waiting for a second admin`, body: reason.slice(0, 300) });
    return this.get(row.id);
  }

  private async pending(id: string): Promise<SignerProposalRow> {
    const p = await this.get(id);
    if (p.state !== 'pending') throw conflict(`The proposal is ${p.state}.`);
    return p;
  }

  private decide(id: string, state: SignerProposalRow['state'], by: OpsActor, note: string | null, keyId?: string) {
    return this.s().db('platform_signer_proposals').where({ id, state: 'pending' }).update({ state, decided_by: by.userId, decided_at: Date.now(), note, ...(keyId ? { key_id: keyId } : {}) });
  }

  /** A second platform admin approves; the change applies now. */
  async approve(by: OpsActor, id: string, note: string | null): Promise<{ proposal: SignerProposalRow; key: SignerKeyRow }> {
    const p = await this.pending(id);
    if (p.proposed_by && p.proposed_by === by.userId) throw forbidden('Dual control: you cannot approve your own proposal. Another platform admin must approve it.', { step: 'dual-control' });
    // Claim the proposal first, so two approvers racing apply it once.
    if (!(await this.decide(id, 'approved', by, note))) throw conflict('The proposal was decided by someone else.');
    const key = p.action === 'add' ? await this.bundles.addKey(by, { name: p.name, publicKeyPem: p.public_key_pem ?? '' }) : await this.bundles.revokeKey(by, p.key_id ?? '', p.reason ?? 'revoked under dual control');
    if (p.action === 'add') await this.s().db('platform_signer_proposals').where({ id }).update({ key_id: key.id });
    await audit(this.s(), by, 'platform.signer.approved', { proposal: id, key: key.id, name: p.name }, { action: p.action, fingerprint: p.fingerprint, proposedBy: p.proposed_by, note }, 'admin');
    return { proposal: await this.get(id), key };
  }

  async reject(by: OpsActor, id: string, note: string | null): Promise<SignerProposalRow> {
    const p = await this.pending(id);
    if (p.proposed_by && p.proposed_by === by.userId) throw conflict('This is your own proposal: withdraw it instead.');
    await this.decide(id, 'rejected', by, note);
    await audit(this.s(), by, 'platform.signer.rejected', { proposal: id, name: p.name }, { action: p.action, fingerprint: p.fingerprint, proposedBy: p.proposed_by, note }, 'admin');
    return this.get(id);
  }

  async withdraw(by: OpsActor, id: string): Promise<SignerProposalRow> {
    const p = await this.pending(id);
    if (p.proposed_by !== by.userId) throw forbidden('Only the admin who proposed a change can withdraw it; reject it instead.', { step: 'dual-control' });
    await this.decide(id, 'withdrawn', by, null);
    await audit(this.s(), by, 'platform.signer.withdrawn', { proposal: id, name: p.name }, { action: p.action, fingerprint: p.fingerprint }, 'admin');
    return this.get(id);
  }
}
