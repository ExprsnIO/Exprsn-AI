import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import type { Services } from '../services.js';
import { didExprsnFromMultikey, isDidExprsn, selfCertifyingDocument } from './did-exprsn.js';
import type { AtKeyRef } from './keys.js';
import { labelSigningBytes, type Label } from './labels.js';
import type { Curve } from './crypto.js';

/*
 * 1.7.0, Sprint 43 (B-11302): each user's own `did:exprsn`, minted on first use.
 *
 * The key is made in the signer (secp256k1) or OpenBao transit (P-256) and never leaves it, like an AT-Protocol
 * account key (atproto/keys.ts); the row keeps the reference and the public key. A user has one. Where the user has
 * an account on this server's PDS, their DID document names its `did:plc` (or `did:web`) in `alsoKnownAs`, and the
 * resolver adds it when it resolves the DID here; resolved anywhere else, the document is the bare self-certifying
 * one. Labels and service-auth tokens signed with the key verify under the DID through the code that verifies them
 * for did:plc and did:web.
 */

export interface ExprsnDidRow {
  id: string;
  tenant_id: string;
  user_id: string;
  did: string;
  multikey: string;
  curve: Curve;
  key_ref: string;
  created_at: number;
}

export class UserDids {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async row(tenantId: string, userId: string): Promise<ExprsnDidRow | undefined> {
    return (await this.db('atproto_exprsn_dids').where({ tenant_id: tenantId, user_id: userId }).first()) as ExprsnDidRow | undefined;
  }

  async byDid(did: string): Promise<ExprsnDidRow | undefined> {
    return isDidExprsn(did) ? ((await this.db('atproto_exprsn_dids').where({ did }).first()) as ExprsnDidRow | undefined) : undefined;
  }

  /** The user's hosted PDS DID, if they have an account on this server's PDS that is not taken down. */
  private async pdsDid(tenantId: string, userId: string): Promise<string | null> {
    const a = (await this.db('pds_accounts').where({ tenant_id: tenantId, user_id: userId }).first('did', 'state')) as { did: string; state: string } | undefined;
    return a && a.state !== 'takendown' && a.state !== 'deleted' ? a.did : null;
  }

  /** The user's did:exprsn, minted (a key made in the signer, audited) the first time it is asked for. */
  async mint(p: Principal, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<ExprsnDidRow> {
    const have = await this.row(p.tenantId, p.userId);
    if (have) return have;
    const s = this.s();
    const curve = s.atproto.keys.defaultCurve();
    const id = ulid();
    const k = await s.atproto.keys.create(`user-did-${id}`, curve);
    const row: ExprsnDidRow = { id, tenant_id: p.tenantId, user_id: p.userId, did: didExprsnFromMultikey(k.multikey), multikey: k.multikey, curve, key_ref: JSON.stringify(k.ref), created_at: Date.now() };
    try {
      await this.db('atproto_exprsn_dids').insert(row);
    } catch (err) {
      // a second request minted at the same time: theirs stands (this key is left unused in the store)
      if (isUniqueViolation(err)) return (await this.row(p.tenantId, p.userId))!;
      throw err;
    }
    await s.audit.append({ tenantId: p.tenantId, action: 'atproto.user-did.minted', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { user: p.userId, did: row.did }, detail: { curve, custody: k.ref.custody }, traceId: ctx.traceId ?? null });
    return row;
  }

  /** What the user sees of their DIDs: the did:exprsn and, linked to it, their PDS DID. */
  async list(p: Principal, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const row = await this.mint(p, ctx);
    const pds = await this.pdsDid(p.tenantId, p.userId);
    return [{ did: row.did, method: 'exprsn' as const, curve: row.curve, publicKeyMultibase: row.multikey, alsoKnownAs: pds ? [pds] : [], createdAt: Number(row.created_at), document: selfCertifyingDocument(row.did, { alsoKnownAs: pds ? [pds] : [] }) }];
  }

  /** For the resolver: what this server adds to a did:exprsn it minted. */
  async local(did: string): Promise<{ alsoKnownAs: string[] } | null> {
    const row = await this.byDid(did);
    if (!row) return null;
    const pds = await this.pdsDid(row.tenant_id, row.user_id);
    return { alsoKnownAs: pds ? [pds] : [] };
  }

  private async sign(row: ExprsnDidRow, data: Buffer): Promise<Buffer> {
    return this.s().atproto.keys.sign(JSON.parse(row.key_ref) as AtKeyRef, data);
  }

  /** A label issued under the user's did:exprsn (`src`), signed with its key. */
  async signLabel(p: Principal, input: { uri: string; val: string; neg?: boolean; cts?: string }): Promise<Label> {
    const row = await this.mint(p);
    const label: Label = { ver: 1, src: row.did, uri: input.uri, val: input.val, neg: input.neg ?? false, cts: input.cts ?? new Date().toISOString() };
    return { ...label, sig: await this.sign(row, labelSigningBytes(label)) };
  }

  /** A short-lived service-auth JWT whose issuer is the user's did:exprsn (ES256K or ES256). */
  async serviceJwt(p: Principal, aud: string, lxm: string | null, ttlSeconds = 60): Promise<string> {
    const row = await this.mint(p);
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: row.curve === 'secp256k1' ? 'ES256K' : 'ES256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: row.did, aud, exp: now + Math.min(ttlSeconds, 3600), iat: now, ...(lxm ? { lxm } : {}), jti: ulid() })).toString('base64url');
    const sig = await this.sign(row, Buffer.from(`${head}.${body}`, 'ascii'));
    return `${head}.${body}.${sig.toString('base64url')}`;
  }
}
