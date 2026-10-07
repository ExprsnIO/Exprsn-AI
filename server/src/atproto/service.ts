import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { AuditActor } from '../audit/chain.js';
import { isUniqueViolation } from '../audit/chain.js';
import { json } from '../db/knex.js';
import { flagRef, type FlagRow, type Severity } from '../guardrails/flags.js';
import type { GuardDecision } from '../guardrails/types.js';
import { servicePolicy } from '../platform/egress.js';
import { TOPICS } from '../platform/bus.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { parseMultikey, type Curve } from './crypto.js';
import { didDocument, DidResolver, didWebFor, GuardedFetch, labelerFromDocument, plcDidForGenesis, plcOperationCid, signPlcOperation, type DidDocument, type PlcOperation, type PlcService } from './did.js';
import { AT_CUSTODY_MESSAGE, AtCustodyError, AtprotoKeys, type AtKeyRef } from './keys.js';
import { LABEL_VALUE_RE, LABELS_TOPIC, labelsForDecision, labelsForFlag, labelSigningBytes, readLabel, SUBJECT_RE, verifyLabel, type Label } from './labels.js';
import { pullLabelStream } from './stream.js';

/*
 * AT-Protocol trust (B-1608 to B-1611).
 *
 * Identities. Each tenant may have its own service DID, did:web or did:plc; a tenant without one labels under the
 * platform's (tenant_id null), the fallback. A did:web lives at the tenant's own host (`did:web:<host>`, document at
 * `/.well-known/did.json` for requests to that host) or under the platform's (`did:web:<host>:atproto:<key>`,
 * document at `/atproto/<key>/did.json`). A did:plc is created by a genesis operation signed with its rotation key and
 * submitted to the PLC directory (ATPROTO_PLC_URL); every later change (a rotated key) is another signed operation.
 *
 * Keys (B-1608). A label key (`#atproto_label`) per identity and, for did:plc, a rotation key; secp256k1 or P-256,
 * made and used in the signer or OpenBao transit (`keys.ts`). Rotating the label key changes the DID document at once
 * for did:web and through a signed PLC operation for did:plc; labels signed by a retired key are signed again with the
 * current one the next time they are served, as Bluesky's Ozone does, so they keep verifying against the document.
 *
 * Labels (B-1610). Guardrail and flag verdicts become labels (`labels.ts`), each signed and numbered with the
 * identity's next `seq`. A negation is a new label (`neg: true`) with its own seq. Labels made from a flag are
 * negated when the flag is dismissed or approved; `negateForFlag` is also the hook for upheld appeals (B-1903).
 *
 * Inbound labels (B-1611). A tenant registers external labelers it trusts by DID. Their DID documents are resolved
 * through the service URL checks (B-901), labels are read from their subscribeLabels stream from a stored cursor, and
 * each is verified against the labeler's `#atproto_label` key (the document is fetched again once when a signature
 * fails, in case the key rotated). A label that fails is dropped and audited; a verified label whose value the tenant
 * chose becomes a flag in the chosen workspace's queue.
 */

export { LABELS_TOPIC };
export const PULL_JOB = 'atproto.labels.pull';

export type Method = 'web' | 'plc';
export type KeyPurpose = 'label' | 'rotation';

export interface IdentityRow {
  id: string;
  tenant_id: string | null;
  method: Method;
  did: string;
  handle: string | null;
  host: string | null;
  path_key: string | null;
  endpoint: string;
  plc_prev: string | null;
  plc_op: PlcOperation | null;
  state: 'active' | 'deactivated';
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface KeyRow {
  id: string;
  identity_id: string;
  tenant_id: string | null;
  purpose: KeyPurpose;
  curve: Curve;
  custody: 'signer' | 'openbao';
  key_name: string;
  key_wrapped: string | null;
  multikey: string;
  state: 'active' | 'retired';
  created_by: string | null;
  created_at: number;
  retired_at: number | null;
}

export interface LabelRow {
  id: string;
  identity_id: string;
  tenant_id: string | null;
  seq: number;
  label: Label;
  key_id: string;
  flag_id: string | null;
  created_by: string | null;
  created_at: number;
}

export interface LabelerRow {
  id: string;
  tenant_id: string;
  did: string;
  name: string;
  endpoint: string | null;
  multikey: string | null;
  workspace_id: string | null;
  vals: string[];
  state: 'active' | 'paused';
  cursor: number | null;
  last_pull_at: number | null;
  last_error: string | null;
  received: number;
  rejected: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface InboundRow {
  id: string;
  labeler_id: string;
  seq: number | null;
  uri: string;
  cid: string | null;
  val: string;
  neg: boolean;
  cts: string;
  exp: string | null;
  flag_id: string | null;
  created_at: number;
}

/** Who acts: a person through the API, or the system (a job, the flag hook). */
export interface AtActor {
  tenantId: string;
  userId: string | null;
  actor: AuditActor;
  traceId?: string | null;
}

export class AtprotoError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extensions: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** The label values that become flags when a tenant does not choose: the system values and the common categories. */
export const DEFAULT_INBOUND_VALUES = ['!hide', '!warn', 'porn', 'sexual', 'nudity', 'graphic-media', 'spam'];
const SEVERITY: Record<string, Severity> = { '!hide': 'high', '!warn': 'medium' };
const HANDLE_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_REJECT_AUDITS = 20;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

const identityFrom = (r: Record<string, unknown>): IdentityRow => ({ ...(r as unknown as IdentityRow), plc_op: json<PlcOperation | null>(r.plc_op, null), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const keyFrom = (r: Record<string, unknown>): KeyRow => ({ ...(r as unknown as KeyRow), created_at: num(r.created_at), retired_at: numOrNull(r.retired_at) });
const labelFrom = (r: Record<string, unknown>): LabelRow => ({
  id: String(r.id),
  identity_id: String(r.identity_id),
  tenant_id: (r.tenant_id as string | null) ?? null,
  seq: num(r.seq),
  label: { ver: 1, src: String(r.src), uri: String(r.uri), ...(r.cid ? { cid: String(r.cid) } : {}), val: String(r.val), neg: bool(r.neg), cts: String(r.cts), ...(r.exp ? { exp: String(r.exp) } : {}), sig: Buffer.from(String(r.sig), 'base64') },
  key_id: String(r.key_id),
  flag_id: (r.flag_id as string | null) ?? null,
  created_by: (r.created_by as string | null) ?? null,
  created_at: num(r.created_at)
});
const labelerFrom = (r: Record<string, unknown>): LabelerRow => ({ ...(r as unknown as LabelerRow), vals: json<string[]>(r.vals, []), cursor: numOrNull(r.cursor), last_pull_at: numOrNull(r.last_pull_at), received: num(r.received), rejected: num(r.rejected), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const inboundFrom = (r: Record<string, unknown>): InboundRow => ({ ...(r as unknown as InboundRow), seq: numOrNull(r.seq), neg: bool(r.neg), created_at: num(r.created_at) });
const refOf = (k: KeyRow): AtKeyRef => ({ custody: k.custody, keyName: k.key_name, wrapped: k.key_wrapped, curve: k.curve });

export class AtprotoService {
  readonly keys: AtprotoKeys;
  readonly http: GuardedFetch;
  readonly resolver: DidResolver;

  constructor(private readonly s: () => Services) {
    this.keys = new AtprotoKeys(() => this.s().kms, () => this.s().cfg.OPENBAO_KEY_PREFIX);
    this.http = new GuardedFetch(() => servicePolicy(this.s().cfg));
    this.resolver = new DidResolver(this.http, () => this.s().cfg.ATPROTO_PLC_URL);
  }

  private get db() {
    return this.s().db;
  }

  /** The base URL the platform's DID and the path-form tenant DIDs live under. */
  base(): URL {
    return new URL(this.s().cfg.ATPROTO_PUBLIC_URL ?? this.s().cfg.PUBLIC_URL);
  }

  private audit(by: AtActor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: by.tenantId, action, kind: by.userId ? 'admin' : 'system', actor: by.actor, target, label: 'internal', ...(detail ? { detail } : {}), traceId: by.traceId ?? null });
  }

  info() {
    return { custody: this.keys.custody(), curves: this.keys.curves(), defaultCurve: this.keys.custody() ? this.keys.defaultCurve() : null, plcUrl: this.s().cfg.ATPROTO_PLC_URL, base: this.base().origin };
  }

  // ---------- identities (B-1609) ----------

  async identity(tenantId: string | null): Promise<IdentityRow | undefined> {
    const q = this.db('atproto_identities').where({ state: 'active' });
    const r = (await (tenantId === null ? q.whereNull('tenant_id') : q.where({ tenant_id: tenantId })).first()) as Record<string, unknown> | undefined;
    return r ? identityFrom(r) : undefined;
  }

  async identityById(id: string): Promise<IdentityRow | undefined> {
    const r = (await this.db('atproto_identities').where({ id }).first()) as Record<string, unknown> | undefined;
    return r ? identityFrom(r) : undefined;
  }

  /** The identity that signs a tenant's labels: its own, else the platform's (the fallback). */
  async signingIdentity(tenantId: string): Promise<IdentityRow | undefined> {
    return (await this.identity(tenantId)) ?? (await this.identity(null));
  }

  /** The identity a request to this host speaks for: a tenant's own host, else the platform's on the base host. */
  async identityByHost(hostHeader: string): Promise<IdentityRow | undefined> {
    const host = hostHeader.trim().toLowerCase();
    if (!host || host.length > 260) return undefined;
    const own = (await this.db('atproto_identities').where({ host, state: 'active' }).first()) as Record<string, unknown> | undefined;
    if (own) return identityFrom(own);
    return host === this.base().host.toLowerCase() ? this.identity(null) : undefined;
  }

  async identityByPathKey(key: string): Promise<IdentityRow | undefined> {
    const r = (await this.db('atproto_identities').where({ path_key: key, state: 'active' }).first()) as Record<string, unknown> | undefined;
    return r ? identityFrom(r) : undefined;
  }

  async identityByHandle(handle: string): Promise<IdentityRow | undefined> {
    const r = (await this.db('atproto_identities').where({ handle: handle.toLowerCase(), state: 'active' }).first()) as Record<string, unknown> | undefined;
    return r ? identityFrom(r) : undefined;
  }

  async keysOf(identityId: string, all = false): Promise<KeyRow[]> {
    const q = this.db('atproto_keys').where({ identity_id: identityId }).orderBy('created_at', 'desc');
    if (!all) q.andWhere({ state: 'active' });
    return ((await q) as Record<string, unknown>[]).map(keyFrom);
  }

  private async activeKey(identityId: string, purpose: KeyPurpose): Promise<KeyRow> {
    const r = (await this.db('atproto_keys').where({ identity_id: identityId, purpose, state: 'active' }).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined;
    if (!r) throw new AtprotoError(409, `This identity has no active ${purpose} key.`);
    return keyFrom(r);
  }

  /** The DID document: built from the active keys (did:web), or from the last accepted PLC operation (did:plc). */
  async document(identity: IdentityRow): Promise<DidDocument> {
    if (identity.method === 'plc' && identity.plc_op) return didDocument(identity.did, identity.plc_op);
    const label = await this.activeKey(identity.id, 'label');
    // B-3001: a tenant with feeds also serves them here (`#bsky_fg`, feeds.ts).
    const extra = (await this.s().feedGenerators?.didServices(identity)) ?? {};
    return didDocument(identity.did, { alsoKnownAs: identity.handle ? [`at://${identity.handle}`] : [], verificationMethods: { atproto_label: `did:key:${label.multikey}` }, services: { atproto_labeler: { type: 'AtprotoLabeler', endpoint: identity.endpoint }, ...extra } });
  }

  /**
   * B-3001: makes sure a did:plc document carries a service (the feed generator's `#bsky_fg`): when it does not, a
   * new operation adding it, signed by the rotation key in force, is accepted by the PLC directory before anything
   * changes here. A did:web needs nothing (its document is computed). Returns the identity as it is now.
   */
  async ensurePlcService(by: AtActor, identity: IdentityRow, id: string, svc: PlcService): Promise<IdentityRow> {
    if (identity.method !== 'plc') return identity;
    const prevOp = identity.plc_op;
    if (!prevOp || !identity.plc_prev) throw new AtprotoError(409, 'This did:plc has no recorded operation to follow.');
    const cur = prevOp.services[id];
    if (cur && cur.type === svc.type && cur.endpoint === svc.endpoint) return identity;
    const rotation = await this.activeKey(identity.id, 'rotation');
    const op: PlcOperation = { type: 'plc_operation', rotationKeys: prevOp.rotationKeys, verificationMethods: prevOp.verificationMethods, alsoKnownAs: prevOp.alsoKnownAs, services: { ...prevOp.services, [id]: svc }, prev: identity.plc_prev };
    const signed = await signPlcOperation(op, (bytes) => this.keys.sign(refOf(rotation), bytes));
    await this.submitPlc(identity.did, signed);
    const plcPrev = plcOperationCid(signed);
    await this.db('atproto_identities').where({ id: identity.id }).update({ plc_op: JSON.stringify(signed), plc_prev: plcPrev, updated_at: Date.now() });
    await this.audit(by, 'atproto.identity.service-added', { identity: identity.id, did: identity.did }, { service: `#${id}`, type: svc.type, endpoint: svc.endpoint, plcCid: plcPrev });
    return (await this.identityById(identity.id))!;
  }

  private requireCustody(curve: Curve): void {
    const custody = this.keys.custody();
    if (!custody) throw new AtprotoError(409, AT_CUSTODY_MESSAGE, { step: 'custody' });
    if (!this.keys.curves().includes(curve)) throw new AtprotoError(409, 'OpenBao transit has no secp256k1 keys; run the signer (SIGNER_SOCKET) for secp256k1, or choose P-256.', { step: 'custody' });
  }

  private async newKey(identityId: string, tenantId: string | null, purpose: KeyPurpose, curve: Curve, by: AtActor) {
    const id = ulid();
    const made = await this.keys.create(id, curve);
    const row = { id, identity_id: identityId, tenant_id: tenantId, purpose, curve, custody: made.ref.custody, key_name: made.ref.keyName, key_wrapped: made.ref.wrapped, multikey: made.multikey, state: 'active', created_by: by.userId, created_at: Date.now(), retired_at: null };
    return { row, ref: made.ref, didKey: made.didKey };
  }

  private async submitPlc(did: string, op: PlcOperation): Promise<void> {
    const url = `${this.s().cfg.ATPROTO_PLC_URL.replace(/\/$/, '')}/${did}`;
    let r: { status: number; text: string };
    try {
      r = await this.http.request(url, { method: 'POST', body: op });
    } catch (err) {
      throw new AtprotoError(502, `The PLC directory could not be reached: ${(err as Error).message}`, { step: 'plc' });
    }
    if (r.status < 200 || r.status >= 300) throw new AtprotoError(502, `The PLC directory refused the operation (${r.status}): ${r.text.slice(0, 200)}`, { step: 'plc' });
  }

  async createIdentity(by: AtActor, tenantId: string | null, o: { method: Method; handle?: string | null; host?: string | null; curve?: Curve; rotationCurve?: Curve }): Promise<IdentityRow> {
    const curve = o.curve ?? this.keys.defaultCurve();
    const rotationCurve = o.rotationCurve ?? curve;
    this.requireCustody(curve);
    if (o.method === 'plc') this.requireCustody(rotationCurve);
    if (await this.identity(tenantId)) throw new AtprotoError(409, tenantId ? 'This tenant already has an AT-Protocol identity.' : 'The platform already has an AT-Protocol identity.');
    const base = this.base();
    let host = o.host?.trim().toLowerCase() || null;
    if (host && tenantId === null) throw new AtprotoError(400, 'The platform identity lives on the base URL (ATPROTO_PUBLIC_URL or PUBLIC_URL); it takes no host.');
    if (host && (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host) || !HANDLE_RE.test(host.replace(/:\d+$/, '')))) throw new AtprotoError(400, `${host} is not a host name.`);
    if (host === base.host.toLowerCase()) host = null;
    let pathKey: string | null = null;
    if (tenantId !== null && !host) {
      const tenant = await this.s().tenants.byId(tenantId);
      pathKey = (tenant?.slug ?? tenantId).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
    }
    const endpoint = host ? `https://${host}` : pathKey ? `${base.origin}/atproto/${pathKey}` : base.origin;
    let handle = o.handle?.trim().toLowerCase() || null;
    if (handle === null && o.handle === undefined) {
      const candidate = host ? host.replace(/:\d+$/, '') : tenantId === null ? base.hostname : null;
      handle = candidate && HANDLE_RE.test(candidate) ? candidate : null;
    }
    if (handle && !HANDLE_RE.test(handle)) throw new AtprotoError(400, `${handle} is not a valid handle.`);
    if (handle && (await this.identityByHandle(handle))) throw new AtprotoError(409, `The handle ${handle} is taken.`);
    if (host && (await this.db('atproto_identities').where({ host }).first())) throw new AtprotoError(409, `The host ${host} is taken.`);
    if (pathKey && (await this.db('atproto_identities').where({ path_key: pathKey }).first())) throw new AtprotoError(409, `The path /atproto/${pathKey} is taken.`);

    const id = ulid();
    const now = Date.now();
    const label = await this.newKey(id, tenantId, 'label', curve, by);
    const keys = [label.row];
    let did: string;
    let plcOp: PlcOperation | null = null;
    let plcPrev: string | null = null;
    if (o.method === 'web') {
      did = host ? didWebFor(new URL(`https://${host}`)) : didWebFor(base, pathKey ? ['atproto', pathKey] : []);
    } else {
      const rotation = await this.newKey(id, tenantId, 'rotation', rotationCurve, by);
      keys.push(rotation.row);
      const op: PlcOperation = { type: 'plc_operation', rotationKeys: [rotation.didKey], verificationMethods: { atproto_label: label.didKey }, alsoKnownAs: handle ? [`at://${handle}`] : [], services: { atproto_labeler: { type: 'AtprotoLabeler', endpoint } }, prev: null };
      plcOp = await signPlcOperation(op, (bytes) => this.keys.sign(rotation.ref, bytes));
      did = plcDidForGenesis(plcOp);
      await this.submitPlc(did, plcOp);
      plcPrev = plcOperationCid(plcOp);
    }
    if (await this.db('atproto_identities').where({ did }).first()) throw new AtprotoError(409, `${did} is already in use.`);
    await this.db.transaction(async (trx) => {
      await trx('atproto_identities').insert({ id, tenant_id: tenantId, method: o.method, did, handle, host, path_key: pathKey, endpoint, plc_prev: plcPrev, plc_op: plcOp ? JSON.stringify(plcOp) : null, state: 'active', created_by: by.userId, created_at: now, updated_at: now });
      await trx('atproto_keys').insert(keys);
    });
    await this.audit(by, 'atproto.identity.created', { identity: id, did, platform: tenantId === null }, { method: o.method, handle, endpoint, curve, custody: label.row.custody, ...(plcPrev ? { plcCid: plcPrev } : {}) });
    return (await this.identityById(id))!;
  }

  /**
   * Rotates the label key or (did:plc) the rotation key (B-1608). did:web documents change at once; for did:plc a new
   * operation, signed by the rotation key in force, is accepted by the directory before anything changes here.
   */
  async rotateKey(by: AtActor, identity: IdentityRow, purpose: KeyPurpose, curve?: Curve): Promise<{ identity: IdentityRow; key: KeyRow; retired: KeyRow }> {
    if (purpose === 'rotation' && identity.method !== 'plc') throw new AtprotoError(400, 'Only a did:plc has rotation keys; a did:web is controlled by its host.');
    const old = await this.activeKey(identity.id, purpose);
    const c = curve ?? old.curve;
    this.requireCustody(c);
    const fresh = await this.newKey(identity.id, identity.tenant_id, purpose, c, by);
    const now = Date.now();
    let plcOp: PlcOperation | null = null;
    let plcPrev: string | null = null;
    if (identity.method === 'plc') {
      if (!identity.plc_op || !identity.plc_prev) throw new AtprotoError(409, 'This did:plc has no recorded operation to follow.');
      const rotation = await this.activeKey(identity.id, 'rotation');
      const prevOp = identity.plc_op;
      const op: PlcOperation = {
        type: 'plc_operation',
        rotationKeys: purpose === 'rotation' ? [fresh.didKey] : prevOp.rotationKeys,
        verificationMethods: purpose === 'label' ? { ...prevOp.verificationMethods, atproto_label: fresh.didKey } : prevOp.verificationMethods,
        alsoKnownAs: prevOp.alsoKnownAs,
        services: prevOp.services,
        prev: identity.plc_prev
      };
      // Signed by the rotation key in force before the change, including when that key is the one being replaced.
      plcOp = await signPlcOperation(op, (bytes) => this.keys.sign(refOf(rotation), bytes));
      await this.submitPlc(identity.did, plcOp);
      plcPrev = plcOperationCid(plcOp);
    }
    await this.db.transaction(async (trx) => {
      await trx('atproto_keys').where({ id: old.id }).update({ state: 'retired', retired_at: now });
      await trx('atproto_keys').insert(fresh.row);
      await trx('atproto_identities').where({ id: identity.id }).update({ updated_at: now, ...(plcOp ? { plc_op: JSON.stringify(plcOp), plc_prev: plcPrev } : {}) });
    });
    await this.audit(by, 'atproto.key.rotated', { identity: identity.id, did: identity.did, key: fresh.row.id }, { purpose, curve: c, retired: old.id, ...(plcPrev ? { plcCid: plcPrev } : {}) });
    return { identity: (await this.identityById(identity.id))!, key: keyFrom(fresh.row as unknown as Record<string, unknown>), retired: { ...old, state: 'retired', retired_at: now } };
  }

  // ---------- labels (B-1610) ----------

  async maxSeq(identityId: string): Promise<number> {
    const r = (await this.db('atproto_labels').where({ identity_id: identityId }).max({ n: 'seq' }).first()) as { n: number | string | null } | undefined;
    return Number(r?.n ?? 0);
  }

  private async signLabel(identity: IdentityRow, key: KeyRow, l: Omit<Label, 'sig'>): Promise<Buffer> {
    if (l.src !== identity.did) throw new Error('A label is signed by its own source');
    return this.keys.sign(refOf(key), labelSigningBytes(l));
  }

  /** Signs and stores one label with the identity's next seq; tells every instance's subscribers. */
  private async append(by: AtActor, identity: IdentityRow, tenantId: string | null, l: { uri: string; cid?: string | null; val: string; neg: boolean; exp?: string | null; flagId?: string | null }): Promise<LabelRow> {
    const key = await this.activeKey(identity.id, 'label');
    const label: Label = { ver: 1, src: identity.did, uri: l.uri, ...(l.cid ? { cid: l.cid } : {}), val: l.val, neg: l.neg, cts: new Date().toISOString(), ...(l.exp ? { exp: l.exp } : {}) };
    const sig = await this.signLabel(identity, key, label);
    const id = ulid();
    for (let attempt = 0; ; attempt++) {
      const seq = (await this.maxSeq(identity.id)) + 1;
      try {
        await this.db('atproto_labels').insert({ id, identity_id: identity.id, tenant_id: tenantId, seq, src: label.src, uri: label.uri, uri_hash: hash(label.uri), cid: label.cid ?? null, val: label.val, neg: label.neg, cts: label.cts, exp: label.exp ?? null, sig: sig.toString('base64'), key_id: key.id, flag_id: l.flagId ?? null, created_by: by.userId, created_at: Date.now() });
        break;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= 8) throw err;
      }
    }
    const row = labelFrom((await this.db('atproto_labels').where({ id }).first()) as Record<string, unknown>);
    this.s().bus.publish(LABELS_TOPIC, { identityId: identity.id, seq: row.seq });
    return row;
  }

  private async requireIdentity(tenantId: string): Promise<IdentityRow> {
    const identity = await this.signingIdentity(tenantId);
    if (!identity) throw new AtprotoError(409, 'Neither this tenant nor the platform has an AT-Protocol identity to sign labels with.', { step: 'identity' });
    return identity;
  }

  private checkSubject(uri: string): void {
    if (!SUBJECT_RE.test(uri)) throw new AtprotoError(400, 'The subject must be an at:// URI, a DID or an https URL.');
  }

  /** The labels currently in force from this identity on a subject (the last label for each value, unless negated). */
  async current(identityId: string, uri: string): Promise<LabelRow[]> {
    const rows = ((await this.db('atproto_labels').where({ identity_id: identityId, uri_hash: hash(uri) }).orderBy('seq', 'asc')) as Record<string, unknown>[]).map(labelFrom).filter((r) => r.label.uri === uri);
    const last = new Map<string, LabelRow>();
    for (const r of rows) last.set(r.label.val, r);
    return [...last.values()].filter((r) => !r.label.neg);
  }

  /** Emits labels for values on a subject; values already in force are not repeated. */
  async emit(by: AtActor, tenantId: string, o: { uri: string; cid?: string | null; vals: string[]; exp?: string | null; flagId?: string | null; source?: string }): Promise<LabelRow[]> {
    this.checkSubject(o.uri);
    for (const v of o.vals) if (!LABEL_VALUE_RE.test(v)) throw new AtprotoError(400, `${v} is not a label value (lower-case letters, digits and hyphens, optionally after !).`);
    const identity = await this.requireIdentity(tenantId);
    const inForce = new Set((await this.current(identity.id, o.uri)).map((r) => r.label.val));
    const out: LabelRow[] = [];
    for (const val of [...new Set(o.vals)]) {
      if (inForce.has(val)) continue;
      out.push(await this.append(by, identity, tenantId, { uri: o.uri, cid: o.cid ?? null, val, neg: false, exp: o.exp ?? null, flagId: o.flagId ?? null }));
    }
    if (out.length) await this.audit(by, 'atproto.label.created', { did: identity.did, subjectHash: hash(o.uri), ...(o.flagId ? { flag: o.flagId } : {}) }, { vals: out.map((r) => r.label.val), seqs: out.map((r) => r.seq), source: o.source ?? 'manual', fallback: identity.tenant_id === null });
    return out;
  }

  /** Withdraws a label in force (B-1610; the appeal decision of B-1903 calls this through `negateForFlag`). */
  async negate(by: AtActor, tenantId: string, o: { uri: string; val: string; reason?: string | null }): Promise<LabelRow> {
    this.checkSubject(o.uri);
    const identity = await this.requireIdentity(tenantId);
    const live = (await this.current(identity.id, o.uri)).find((r) => r.label.val === o.val);
    if (!live) throw new AtprotoError(409, `There is no ${o.val} label in force on this subject.`);
    if (identity.tenant_id === null && live.tenant_id !== tenantId) throw new AtprotoError(403, "Another tenant's label under the platform identity is withdrawn by that tenant.", { step: 'tenant' });
    const row = await this.append(by, identity, tenantId, { uri: o.uri, cid: live.label.cid ?? null, val: o.val, neg: true, flagId: live.flag_id });
    await this.audit(by, 'atproto.label.negated', { did: identity.did, subjectHash: hash(o.uri), ...(live.flag_id ? { flag: live.flag_id } : {}) }, { val: o.val, seq: row.seq, negates: live.seq, ...(o.reason ? { reason: o.reason.slice(0, 500) } : {}) });
    return row;
  }

  /** Withdraws every label in force that a flag produced: a dismissed or approved flag, or an upheld appeal. */
  async negateForFlag(by: AtActor, tenantId: string, flagId: string, reason = 'flag decided'): Promise<LabelRow[]> {
    const made = ((await this.db('atproto_labels').where({ flag_id: flagId, neg: false })) as Record<string, unknown>[]).map(labelFrom).filter((r) => r.tenant_id === tenantId);
    const out: LabelRow[] = [];
    const seen = new Set<string>();
    for (const r of made) {
      const k = `${r.identity_id} ${r.label.uri} ${r.label.val}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const live = (await this.current(r.identity_id, r.label.uri)).find((x) => x.label.val === r.label.val);
      if (!live || live.flag_id !== flagId) continue;
      out.push(await this.negate(by, tenantId, { uri: r.label.uri, val: r.label.val, reason }));
    }
    return out;
  }

  /** Labels a subject from a flag's verdict. */
  async labelFlag(by: AtActor, tenantId: string, flag: FlagRow, uri: string, cid?: string | null): Promise<LabelRow[]> {
    const vals = labelsForFlag(flag);
    if (!vals.length) throw new AtprotoError(409, `${flagRef(flag)} was ${flag.state}; a dismissed or approved flag labels nothing.`);
    return this.emit(by, tenantId, { uri, cid: cid ?? null, vals, flagId: flag.id, source: `flag ${flagRef(flag)}` });
  }

  /** Labels a subject from a guardrail decision (for the moderation check, B-1901, and the firehose, B-1908). */
  async labelDecision(by: AtActor, tenantId: string, uri: string, decision: Pick<GuardDecision, 'action' | 'findings'>, o: { cid?: string | null; flagId?: string | null } = {}): Promise<LabelRow[]> {
    const vals = labelsForDecision(decision);
    if (!vals.length) return [];
    return this.emit(by, tenantId, { uri, cid: o.cid ?? null, vals, flagId: o.flagId ?? null, source: `guardrail ${decision.action}` });
  }

  /** Re-signs labels made with a retired key, so served labels verify against the current document. */
  private async fresh(rows: LabelRow[]): Promise<LabelRow[]> {
    const byIdentity = new Map<string, { identity: IdentityRow; key: KeyRow } | null>();
    for (const r of rows) {
      if (!byIdentity.has(r.identity_id)) {
        const identity = await this.identityById(r.identity_id);
        const key = identity ? ((await this.db('atproto_keys').where({ identity_id: identity.id, purpose: 'label', state: 'active' }).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined) : undefined;
        byIdentity.set(r.identity_id, identity && key ? { identity, key: keyFrom(key) } : null);
      }
      const cur = byIdentity.get(r.identity_id);
      if (!cur || r.key_id === cur.key.id) continue;
      const { sig: _old, ...unsigned } = r.label;
      const sig = await this.signLabel(cur.identity, cur.key, unsigned);
      await this.db('atproto_labels').where({ id: r.id }).update({ sig: sig.toString('base64'), key_id: cur.key.id });
      r.label.sig = sig;
      r.key_id = cur.key.id;
    }
    return rows;
  }

  /** Labels after a seq, in order (subscribeLabels). */
  async labelsAfter(identityId: string, seq: number, limit: number): Promise<LabelRow[]> {
    const rows = ((await this.db('atproto_labels').where({ identity_id: identityId }).andWhere('seq', '>', seq).orderBy('seq', 'asc').limit(limit)) as Record<string, unknown>[]).map(labelFrom);
    return this.fresh(rows);
  }

  /** `com.atproto.label.queryLabels`: prefix (`…*`) or exact URI patterns, optionally only from some sources. */
  async query(identity: IdentityRow, o: { uriPatterns: string[]; sources?: string[]; limit: number; cursor?: number | null }): Promise<{ labels: LabelRow[]; cursor: string | null }> {
    if (o.sources?.length && !o.sources.includes(identity.did)) return { labels: [], cursor: null };
    const all = o.uriPatterns.includes('*');
    const q = this.db('atproto_labels').where({ identity_id: identity.id }).orderBy('seq', 'asc').limit(o.limit);
    if (o.cursor != null) q.andWhere('seq', '>', o.cursor);
    if (!all) {
      q.andWhere((w) => {
        for (const p of o.uriPatterns) {
          if (p.endsWith('*')) w.orWhereRaw("uri LIKE ? ESCAPE '!'", [p.slice(0, -1).replace(/[!%_]/g, '!$&') + '%']);
          else w.orWhere({ uri_hash: hash(p) });
        }
      });
    }
    const scanned = ((await q) as Record<string, unknown>[]).map(labelFrom);
    // LIKE folds case on MySQL and SQLite; the match is exact here.
    const matched = all ? scanned : scanned.filter((r) => o.uriPatterns.some((p) => (p.endsWith('*') ? r.label.uri.startsWith(p.slice(0, -1)) : r.label.uri === p)));
    const labels = await this.fresh(matched);
    return { labels, cursor: scanned.length === o.limit ? String(scanned.at(-1)!.seq) : null };
  }

  /** A tenant's own labels (the admin list), newest first. */
  async list(tenantId: string, o: { uri?: string; limit: number; before?: number | null }): Promise<LabelRow[]> {
    const q = this.db('atproto_labels').where({ tenant_id: tenantId }).orderBy('created_at', 'desc').orderBy('seq', 'desc').limit(o.limit);
    if (o.uri) q.andWhere({ uri_hash: hash(o.uri) });
    if (o.before) q.andWhere('created_at', '<', o.before);
    return ((await q) as Record<string, unknown>[]).map(labelFrom);
  }

  // ---------- inbound labels (B-1611) ----------

  async labelers(tenantId: string): Promise<LabelerRow[]> {
    return ((await this.db('atproto_labelers').where({ tenant_id: tenantId }).orderBy('created_at', 'asc')) as Record<string, unknown>[]).map(labelerFrom);
  }

  async labeler(tenantId: string, id: string): Promise<LabelerRow | undefined> {
    const r = (await this.db('atproto_labelers').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? labelerFrom(r) : undefined;
  }

  /** Resolves a labeler's DID document (B-901 checks) for its label key and endpoint. */
  private async resolveLabeler(did: string, fresh = false) {
    let doc: unknown;
    try {
      doc = await this.resolver.resolve(did, fresh);
    } catch (err) {
      throw new AtprotoError(502, `${did} could not be resolved: ${(err as Error).message}`, { step: 'resolve' });
    }
    try {
      return labelerFromDocument(doc, did);
    } catch (err) {
      throw new AtprotoError(422, `${did}: ${(err as Error).message}`, { step: 'document' });
    }
  }

  private async checkWorkspace(tenantId: string, workspaceId: string | null | undefined): Promise<void> {
    if (workspaceId && !(await this.s().tenants.workspace(tenantId, workspaceId))) throw new AtprotoError(400, 'The workspace is not in this tenant.');
  }

  async addLabeler(by: AtActor, tenantId: string, o: { did: string; name: string; workspaceId?: string | null; vals?: string[] }): Promise<LabelerRow> {
    if (!/^did:(plc:[a-z2-7]{24}|web:[A-Za-z0-9.%:-]{3,250})$/.test(o.did)) throw new AtprotoError(400, 'A labeler is a did:plc or did:web.');
    await this.checkWorkspace(tenantId, o.workspaceId);
    if ((await this.labelers(tenantId)).some((l) => l.did === o.did)) throw new AtprotoError(409, 'This labeler is already registered.');
    const doc = await this.resolveLabeler(o.did, true);
    if (!doc.endpoint) throw new AtprotoError(422, `${o.did} names no #atproto_labeler endpoint.`, { step: 'document' });
    const id = ulid();
    const now = Date.now();
    const vals = o.vals ?? DEFAULT_INBOUND_VALUES;
    await this.db('atproto_labelers').insert({ id, tenant_id: tenantId, did: o.did, name: o.name, endpoint: doc.endpoint, multikey: doc.multikey, workspace_id: o.workspaceId ?? null, vals: JSON.stringify(vals), state: 'active', cursor: null, last_pull_at: null, last_error: null, received: 0, rejected: 0, created_by: by.userId, created_at: now, updated_at: now });
    await this.audit(by, 'atproto.labeler.created', { labeler: id, did: o.did }, { name: o.name, endpoint: doc.endpoint, vals, workspace: o.workspaceId ?? null });
    return (await this.labeler(tenantId, id))!;
  }

  async updateLabeler(by: AtActor, l: LabelerRow, patch: { name?: string; workspaceId?: string | null; vals?: string[]; state?: 'active' | 'paused' }): Promise<LabelerRow> {
    await this.checkWorkspace(l.tenant_id, patch.workspaceId);
    const row: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.workspaceId !== undefined) row.workspace_id = patch.workspaceId;
    if (patch.vals !== undefined) row.vals = JSON.stringify(patch.vals);
    if (patch.state !== undefined) row.state = patch.state;
    await this.db('atproto_labelers').where({ id: l.id }).update(row);
    await this.audit(by, 'atproto.labeler.updated', { labeler: l.id, did: l.did }, { ...patch });
    return (await this.labeler(l.tenant_id, l.id))!;
  }

  async removeLabeler(by: AtActor, l: LabelerRow): Promise<void> {
    await this.db('atproto_labelers').where({ id: l.id }).delete();
    await this.audit(by, 'atproto.labeler.deleted', { labeler: l.id, did: l.did });
  }

  async inbound(tenantId: string, labelerId: string, limit = 100): Promise<InboundRow[]> {
    return ((await this.db('atproto_inbound_labels').where({ tenant_id: tenantId, labeler_id: labelerId }).orderBy('created_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(inboundFrom);
  }

  /**
   * Takes one message's labels from a labeler: verifies each against the labeler's key, drops and audits the ones
   * that fail, stores the rest once, and raises a flag for each new verified label whose value the tenant chose.
   */
  async ingest(by: AtActor, l: LabelerRow, seq: number | null, raws: unknown[], ctx: { refreshed: boolean; audits: number } = { refreshed: false, audits: 0 }): Promise<{ accepted: number; rejected: number; flags: string[] }> {
    let accepted = 0;
    let rejected = 0;
    const flags: string[] = [];
    for (const raw of raws.slice(0, 1000)) {
      const label = readLabel(raw);
      let problem: string | null = null;
      if (!label) problem = 'malformed';
      else if (label.src !== l.did) problem = 'source';
      else if (!label.sig) problem = 'unsigned';
      else {
        let ok = false;
        if (l.multikey) {
          const k = parseMultikey(l.multikey);
          ok = verifyLabel(raw as Record<string, unknown>, label, k.curve, k.key);
        }
        if (!ok && !ctx.refreshed) {
          // The labeler may have rotated its key: fetch its document once more and try again.
          ctx.refreshed = true;
          try {
            const doc = await this.resolveLabeler(l.did, true);
            if (doc.multikey !== l.multikey) {
              await this.db('atproto_labelers').where({ id: l.id }).update({ multikey: doc.multikey, ...(doc.endpoint ? { endpoint: doc.endpoint } : {}), updated_at: Date.now() });
              l.multikey = doc.multikey;
              ok = verifyLabel(raw as Record<string, unknown>, label, doc.curve, doc.key);
            }
          } catch {
            /* keep the old key; the label is refused below */
          }
        }
        if (!ok) problem = 'signature';
      }
      if (problem || !label) {
        rejected++;
        if (ctx.audits++ < MAX_REJECT_AUDITS) {
          const uri = label?.uri ?? (raw && typeof raw === 'object' && typeof (raw as { uri?: unknown }).uri === 'string' ? String((raw as { uri: string }).uri) : '');
          await this.audit(by, 'atproto.label.rejected', { labeler: l.id, did: l.did, ...(uri ? { subjectHash: hash(uri) } : {}) }, { reason: problem ?? 'malformed', val: label?.val ?? null, seq });
        }
        continue;
      }
      const id = ulid();
      try {
        await this.db('atproto_inbound_labels').insert({ id, tenant_id: l.tenant_id, labeler_id: l.id, seq, uri: label.uri, uri_hash: hash(label.uri), cid: label.cid ?? null, val: label.val, neg: label.neg, cts: label.cts, exp: label.exp ?? null, dedupe: hash(`${label.uri}\n${label.val}\n${label.neg ? 1 : 0}\n${label.cts}`), flag_id: null, created_at: Date.now() });
      } catch (err) {
        if (isUniqueViolation(err)) continue; // already received
        throw err;
      }
      accepted++;
      // Negations, values the tenant did not choose and labels already expired are kept but raise no flag.
      if (label.neg || !l.vals.includes(label.val) || (label.exp && Date.parse(label.exp) < Date.now())) continue;
      const flag = await this.s().guard.flags.create({
        tenantId: l.tenant_id,
        workspaceId: l.workspace_id,
        kind: 'report',
        checkpoint: 'atproto-label',
        ruleName: `${l.name}: ${label.val}`,
        action: label.val === '!hide' ? 'block' : 'flag',
        severity: SEVERITY[label.val] ?? 'low',
        label: 'internal',
        note: `Label ${label.val} from ${l.did} on ${label.uri}`.slice(0, 1000),
        actor: { name: l.name, via: 'atproto-labeler' },
        source: { kind: 'atproto-label', id }
      });
      await this.db('atproto_inbound_labels').where({ id }).update({ flag_id: flag.id });
      flags.push(flagRef(flag));
    }
    if (accepted || rejected) await this.db('atproto_labelers').where({ id: l.id }).increment({ received: accepted, rejected });
    return { accepted, rejected, flags };
  }

  /** Reads a labeler's stream from its cursor and stores the new cursor (the pull job, B-1611). */
  async pull(by: AtActor, l: LabelerRow, o: { idleMs?: number; maxMs?: number } = {}) {
    if (l.state !== 'active') return { skipped: 'paused' };
    let endpoint = l.endpoint;
    if (!endpoint || !l.multikey) {
      const doc = await this.resolveLabeler(l.did, true);
      endpoint = doc.endpoint;
      l.multikey = doc.multikey;
      await this.db('atproto_labelers').where({ id: l.id }).update({ endpoint, multikey: doc.multikey, updated_at: Date.now() });
    }
    if (!endpoint) throw new AtprotoError(422, `${l.did} names no #atproto_labeler endpoint.`);
    const ctx = { refreshed: false, audits: 0 };
    let accepted = 0;
    let rejected = 0;
    const flags: string[] = [];
    // A new labeler is read from the start of its stream (cursor 0); without a cursor a stream only sends new labels.
    const r = await pullLabelStream(endpoint, l.cursor ?? 0, servicePolicy(this.s().cfg), async (seq, labels) => {
      const x = await this.ingest(by, l, seq, labels, ctx);
      accepted += x.accepted;
      rejected += x.rejected;
      flags.push(...x.flags);
    }, o);
    await this.db('atproto_labelers').where({ id: l.id }).update({ cursor: r.cursor, last_pull_at: Date.now(), last_error: r.error, updated_at: Date.now() });
    if (ctx.audits > MAX_REJECT_AUDITS) await this.audit(by, 'atproto.label.rejected', { labeler: l.id, did: l.did }, { reason: 'summary', more: ctx.audits - MAX_REJECT_AUDITS });
    if (accepted || rejected) await this.audit(by, 'atproto.labels.ingested', { labeler: l.id, did: l.did }, { accepted, rejected, flags: flags.slice(0, 50), cursor: r.cursor });
    return { accepted, rejected, flags, cursor: r.cursor, frames: r.frames, error: r.error };
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register(PULL_JOB, async (p, ctx) => {
      const tenantId = ctx.job.tenant_id;
      const l = await this.labeler(tenantId, String(p.labelerId ?? ''));
      if (!l) return { skipped: 'no such labeler' };
      const r = await this.pull({ tenantId, userId: null, actor: { service: 'atproto-labels' } }, l);
      return { labeler: l.id, ...r };
    });
    // A flag dismissed or approved withdraws the labels it produced (on the instance where it was decided).
    s.bus.on<{ tenantId?: string; type?: string; data?: { id?: string } }>(TOPICS.integrationEvent, (e) => {
      if ((e.type !== 'flag.dismissed' && e.type !== 'flag.approved') || !e.tenantId || !e.data?.id) return;
      void this.negateForFlag({ tenantId: e.tenantId, userId: null, actor: { service: 'atproto-labels' } }, e.tenantId, e.data.id, e.type).catch((err: unknown) => s.log.warn({ err, flag: e.data?.id }, 'withdrawing labels for a decided flag failed'));
    });
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every(PULL_JOB, this.s().cfg.ATPROTO_LABEL_PULL_MINUTES * 60_000, async () => {
      const rows = ((await this.db('atproto_labelers').where({ state: 'active' })) as Record<string, unknown>[]).map(labelerFrom);
      return rows.map((r) => ({ tenantId: r.tenant_id, payload: { labelerId: r.id }, key: r.id }));
    });
  }

  close(): Promise<void> {
    return this.http.close();
  }
}

export { AtCustodyError };
