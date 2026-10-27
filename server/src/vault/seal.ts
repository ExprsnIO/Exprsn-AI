import { ulid } from 'ulid';
import type { AuditActor } from '../audit/chain.js';
import { HttpProblem, badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import { notifyAdmins, platformTenant } from '../ops/common.js';
import { decodeShare, EscrowError, escrowById, keyCheckValue, latestEscrow, recoverKey, type EscrowRow } from '../platform/escrow.js';
import type { HeldKeys, Kms } from '../platform/kms.js';
import type { Services } from '../services.js';
import type { SignerClient } from '../signer/client.js';

/*
 * 1.8.0, Sprint 48 (B-145): the emergency vault seal.
 *
 * Sealing (one action, "Seal the vault"):
 *   - dual control: a platform admin proposes it with a reason (`propose`), and a second, different platform admin
 *     approves it (`approve`); the seal fires on approval. A proposal expires after PROPOSAL_TTL_MS.
 *   - break-glass (`breakGlass`): k escrow shares, given together (console page or CLI), seal at once without any
 *     session. Whoever holds k shares can already rebuild the key-encryption key with `kms:recover`, so letting them
 *     seal adds no power they lack; it is the way to stop the platform when the admin accounts are compromised or a
 *     second admin cannot be reached. The shares are checked against the escrow's key check value and never stored.
 *
 * What a seal does, on every instance (the bus topic SEAL_TOPIC, the persisted flag in `vault_seal_state` read at
 * start-up by `restore`, and a poll of it every POLL_MS in a server so a missed bus message or a CLI change still
 * reaches it):
 *   - drops the in-memory data keys (`DataKeys.dropAll`), the keyring's HMAC secrets (`SystemKeys.seal`), the
 *     opened private keys and derived secrets other services cache (`dropHeldCaches`), and tells the signer to seal
 *     (it drops its key-encryption key and held-key secret);
 *   - refuses every key operation: the KMS (`guardKms`: wrap, unwrap, HMAC, signing and held keys), the data keys
 *     (`DataKeys.sealCheck`) and the keyring answer 503 "Vault sealed"; jobs are not claimed (`refusal` in the job
 *     queue's gate); the HTTP gate (`routes/vault-seal-public.ts`) answers 503 for everything but health, the console's
 *     static files, the session probe and the unseal page and its API.
 *   - the audit chain keeps recording: an append is a SHA-256 hash chain in the database and needs no key, so
 *     `vault.sealed`, `vault.seal.applied`, every share and `vault.unsealed` are written while sealed. (Checkpoints are
 *     KMS-signed; their job waits until the vault is unsealed and then signs the entries written meanwhile.)
 *
 * Unsealing needs the escrow quorum (Shamir shares as `kms:escrow` printed them): k holders submit one share each
 * (`submitShare`, through the unseal page or `exprsn-ai vault:unseal`). Progress is held in memory on the instance
 * that receives them, never stored. At k shares the key is rebuilt and checked against the escrow's key check
 * value and the running key's; the signer is unsealed with the same shares (it checks them itself); the flag is
 * cleared and every instance reopens its keys. Each share, a refused one, a failed attempt and the unseal are
 * audited (`vault.unseal.share`, `vault.unseal.share.refused`, `vault.unseal.failed`, `vault.unsealed`).
 *
 * KMS adapters:
 *   - the signer (SIGNER_SOCKET): the real seal. The signer drops its key; only the quorum's shares give it back.
 *   - local (DATA_KEY in this process): the key stays in this process's configuration while sealed; the seal is the
 *     refusal of every key operation plus the dropped caches. The shares are still required to unseal.
 *   - OpenBao: refused here. Seal OpenBao itself (`bao operator seal`) and unseal it with its own key shares.
 */

export const SEAL_TOPIC = 'vault.seal';
export const PROPOSAL_TTL_MS = 60 * 60_000;
export const POLL_MS = 5_000;
/** Unseal progress is forgotten after this long without a new share. */
export const PROGRESS_TTL_MS = 30 * 60_000;
const STATE_ID = 'vault';

export function sealedProblem(detail?: string): HttpProblem {
  return new HttpProblem(503, 'Vault sealed', detail ?? 'The vault is sealed: nothing that needs a key can run until the escrow quorum unseals it. Share holders unseal it at /unseal.html or with exprsn-ai vault:unseal.', { extensions: { step: 'vault-sealed', sealed: true, unseal: '/unseal.html' }, headers: { 'Retry-After': '30' } });
}

const SIGNER_SEALED_RE = /The signer is sealed/;

export interface SealActor {
  tenantId: string;
  userId: string | null;
  audit: AuditActor;
  traceId?: string | null;
}

interface StateRow {
  id: string;
  sealed: boolean | number;
  sealed_at: number | null;
  sealed_by: string | null;
  mode: 'dual-control' | 'break-glass' | null;
  reason: string | null;
  proposal_id: string | null;
  escrow_id: string | null;
  unsealed_at: number | null;
  unsealed_by: string | null;
  updated_at: number;
}

interface ProposalRow {
  id: string;
  reason: string;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
  proposed_by: string;
  proposed_tenant: string;
  proposed_at: number;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
}

const proposalView = (p: ProposalRow, names: Map<string, string>, viewer: string | null) => ({
  id: p.id,
  reason: p.reason,
  state: p.state === 'pending' && Number(p.expires_at) <= Date.now() ? 'expired' : p.state,
  proposedBy: p.proposed_by,
  proposedByName: names.get(p.proposed_by) ?? null,
  proposedAt: Number(p.proposed_at),
  expiresAt: Number(p.expires_at),
  decidedBy: p.decided_by,
  decidedByName: p.decided_by ? (names.get(p.decided_by) ?? null) : null,
  decidedAt: p.decided_at == null ? null : Number(p.decided_at),
  note: p.note,
  mine: !!viewer && p.proposed_by === viewer
});

/** The signer client behind a KMS, if the signer is the KMS. */
export const signerOf = (kms: Kms): SignerClient | null => (kms as unknown as { client?: SignerClient }).client ?? null;

/**
 * Clears the private keys and derived secrets that services cache outside the data keys and the keyring (B-145).
 * Each entry names a service and the field of it that holds a cache; a missing one is skipped.
 */
function dropHeldCaches(s: Services): number {
  const targets: [unknown, string][] = [
    [(s.federation as unknown as { keys?: unknown }).keys, 'cache'], // OIDC and SAML private keys, opened
    [(s.knowledge as unknown as { terms?: unknown }).terms, 'cache'], // keyword-term HMAC keys
    [s.calendar, 'feedKeyCache'], // calendar feed signing keys
    [s.chain, 'cache'], // identity providers with their resolved secrets
    [(s.connections as unknown as { dynamic?: unknown }).dynamic, 'cache'] // dynamic database credentials
  ];
  let n = 0;
  for (const [owner, field] of targets) {
    const m = (owner as Record<string, unknown> | undefined)?.[field];
    if (m instanceof Map) {
      n += m.size;
      m.clear();
    }
  }
  return n;
}

export class VaultSeal {
  private flag = false;
  private since: number | null = null;
  /** The server started sealed: the start steps after the database run when it is unsealed (`reopen`). */
  private bootPending = false;
  /** The rest of the start sequence (`openVault` past the database); set by the boot. */
  reopen: (() => Promise<void>) | null = null;
  private progress: { escrowId: string; k: number; n: number; shares: Map<number, string>; updatedAt: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private listening = false;
  private applying: Promise<void> = Promise.resolve();
  /** The signer did not take the shares back on this instance (another signer, or it was restarted): status shows it. */
  signerSealed = false;

  constructor(private readonly s: () => Services) {}

  get sealed(): boolean {
    return this.flag;
  }

  /** Throws 503 "Vault sealed" while sealed: the KMS, the data keys and the keyring call it before every key use. */
  assertOpen(): void {
    if (this.flag) throw sealedProblem();
  }

  /** For the job queue's gate: why jobs wait. */
  refusal(): string | null {
    return this.flag ? 'the vault is sealed' : null;
  }

  /** The KMS behind the gate: every key operation refuses while sealed; health still answers. */
  guardKms(inner: Kms): Kms {
    const k = Object.create(inner) as Kms;
    const guard = <A extends unknown[], R>(fn: ((...a: A) => Promise<R>) | undefined, self: unknown) =>
      fn &&
      (async (...args: A): Promise<R> => {
        this.assertOpen();
        try {
          return await fn.apply(self, args);
        } catch (err) {
          if (SIGNER_SEALED_RE.test((err as Error)?.message ?? '')) throw sealedProblem('The signer is sealed: it holds no key until the escrow quorum unseals it.');
          throw err;
        }
      });
    k.ensureKey = guard(inner.ensureKey, inner)!;
    k.wrap = guard(inner.wrap, inner)!;
    k.unwrap = guard(inner.unwrap, inner)!;
    k.hmac = guard(inner.hmac, inner)!;
    k.verifyHmac = guard(inner.verifyHmac, inner)!;
    k.destroyKey = guard(inner.destroyKey, inner)!;
    if (inner.createSigningKey) k.createSigningKey = guard(inner.createSigningKey, inner);
    if (inner.sign) k.sign = guard(inner.sign, inner);
    if (inner.heldKeys) {
      const h = inner.heldKeys;
      const held: HeldKeys = { create: guard(h.create, h)!, sign: guard(h.sign, h)!, decrypt: guard(h.decrypt, h)! };
      Object.defineProperty(k, 'heldKeys', { value: held, enumerable: true });
    }
    return k;
  }

  // ---------- state ----------

  private async row(): Promise<StateRow | null> {
    return ((await this.s().db('vault_seal_state').where({ id: STATE_ID }).first()) as StateRow | undefined) ?? null;
  }

  private async persist(fields: Partial<StateRow>): Promise<void> {
    const db = this.s().db;
    const row = { ...fields, updated_at: Date.now() };
    const n = await db('vault_seal_state').where({ id: STATE_ID }).update(row);
    if (!n) await db('vault_seal_state').insert({ id: STATE_ID, sealed: false, ...row });
  }

  private async platformTenantId(fallback?: string): Promise<string> {
    return (await platformTenant(this.s())) ?? fallback ?? 'platform';
  }

  private async audit(tenantId: string | null, action: string, actor: AuditActor, target: Record<string, unknown>, detail: Record<string, unknown> = {}, traceId?: string | null): Promise<void> {
    const t = tenantId ?? (await this.platformTenantId());
    await this.s().audit.append({ tenantId: t, action, kind: actor.user ? 'admin' : 'system', actor, target, label: 'restricted', detail, traceId: traceId ?? null });
  }

  private get instance(): string {
    return this.s().instances?.id ?? 'unknown';
  }

  /** Subscribes to the bus: a seal or an unseal made on any instance reaches this one. */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.s().bus.on<{ sealed: boolean }>(SEAL_TOPIC, (m) => {
      if (m?.sealed && !this.flag) return this.serial(() => this.applySeal('bus'));
      if (m && !m.sealed && this.flag) return this.serial(() => this.sync());
      return undefined;
    });
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.applying.then(fn, fn);
    this.applying = next.catch((err: Error) => this.s().log.error({ err: err.message }, 'vault seal: could not apply a change'));
    return this.applying;
  }

  /**
   * Called by the server's start sequence once the database is up: a persisted seal holds this instance sealed (the
   * remaining start steps wait for the unseal), and the poll of the flag starts. Returns whether it is sealed.
   */
  async restore(opts: { poll?: boolean } = {}): Promise<boolean> {
    this.listen();
    if (opts.poll !== false) this.startPolling();
    const r = await this.row();
    if (r && !!r.sealed) {
      this.bootPending = true;
      await this.serial(() => this.applySeal('restore'));
      return true;
    }
    return false;
  }

  startPolling(ms = POLL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.serial(() => this.sync()), ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Brings this instance in line with the persisted flag (the poll, and an unseal heard on the bus). */
  async sync(): Promise<void> {
    const r = await this.row();
    const want = !!r?.sealed;
    if (want && !this.flag) await this.applySeal('poll');
    else if (!want && this.flag) await this.applyUnseal('poll');
  }

  /** The seal on this instance: refuse, drop every key held in memory, seal the signer. */
  private async applySeal(origin: 'local' | 'bus' | 'restore' | 'poll'): Promise<void> {
    if (this.flag) return;
    const s = this.s();
    this.flag = true;
    this.since = Date.now();
    this.progress = null;
    const dataKeys = s.keys.dropAll();
    s.sysKeys.seal('the vault is sealed');
    const cached = dropHeldCaches(s);
    let signer: string | null = null;
    const client = signerOf(s.kms);
    if (client) {
      try {
        await client.call('seal');
        signer = 'sealed';
      } catch (err) {
        signer = `not sealed: ${(err as Error).message.slice(0, 200)}`;
        s.log.error({ err: (err as Error).message }, 'vault seal: the signer did not seal');
      }
    }
    s.log.warn({ origin, instance: this.instance }, 'vault sealed on this instance');
    await this.audit(null, 'vault.seal.applied', { service: 'vault' }, { instance: this.instance }, { origin, dataKeysDropped: dataKeys, cachesDropped: cached, signer });
  }

  /** The unseal on this instance: reopen the keyring (and, for a server that started sealed, the rest of the start). */
  private async applyUnseal(origin: 'local' | 'bus' | 'poll'): Promise<void> {
    if (!this.flag) return;
    const s = this.s();
    this.flag = false;
    this.since = null;
    this.progress = null;
    let signer: string | null = null;
    const client = signerOf(s.kms);
    if (client) {
      const st = await client.call('seal-status').catch(() => null);
      this.signerSealed = !!st?.sealed;
      signer = st ? (st.sealed ? 'still sealed' : 'open') : 'unreachable';
      if (this.signerSealed) s.log.error({ instance: this.instance }, 'vault unsealed, but this instance\'s signer is still sealed: unseal it with exprsn-ai vault:unseal --signer-only on its host');
    }
    await s.sysKeys.unseal();
    if (this.bootPending && this.reopen) {
      this.bootPending = false;
      await this.reopen();
    }
    s.log.warn({ origin, instance: this.instance }, 'vault unsealed on this instance');
    await this.audit(null, 'vault.unseal.applied', { service: 'vault' }, { instance: this.instance }, { origin, signer });
  }

  // ---------- status ----------

  private async escrow(id?: string | null): Promise<EscrowRow | null> {
    return ((id ? await escrowById(this.s().db, id) : await latestEscrow(this.s().db)) ?? null) as EscrowRow | null;
  }

  /** The key check value of the key this deployment runs on, when it can be known. */
  private async runningKeyCheck(): Promise<{ keyCheck: string | null; why: string | null }> {
    const s = this.s();
    if (s.cfg.KMS_PROVIDER === 'openbao') return { keyCheck: null, why: 'With OpenBao the key-encryption keys are OpenBao\'s: seal OpenBao itself (bao operator seal) and unseal it with its own key shares.' };
    const client = signerOf(s.kms);
    if (client) {
      const st = await client.call('seal-status').catch((err: Error) => ({ error: err.message }));
      if ('error' in st) return { keyCheck: null, why: `The signer did not say which key it holds (${String(st.error).slice(0, 200)}); a signer older than 1.8.0 cannot be sealed.` };
      return { keyCheck: String(st.keyCheck), why: null };
    }
    if (!s.cfg.DATA_KEY) return { keyCheck: null, why: 'No local key-encryption key is configured.' };
    return { keyCheck: keyCheckValue(Buffer.from(s.cfg.DATA_KEY, 'base64')), why: null };
  }

  /** Whether a seal could be undone: an escrow of the running key exists. Throws 409 when not. */
  private async sealable(): Promise<EscrowRow> {
    const run = await this.runningKeyCheck();
    if (!run.keyCheck) throw conflict(`The vault cannot be sealed here: ${run.why}`);
    const e = await this.escrow();
    if (!e) throw conflict('The vault cannot be sealed: there is no key escrow, so nothing could unseal it. Run exprsn-ai kms:escrow first.');
    if (e.key_check !== run.keyCheck) throw conflict(`The vault cannot be sealed: the newest escrow (${e.id}) is not of the key this deployment runs on, so its shares could not unseal it. Make a new escrow with exprsn-ai kms:escrow.`);
    return e;
  }

  /** What an anonymous caller may know (the unseal page): sealed or not, and the quorum's progress. */
  async publicStatus() {
    const r = await this.row();
    const sealed = this.flag || !!r?.sealed;
    if (!sealed) return { sealed: false, instance: this.instance };
    const e = await this.escrow(r?.escrow_id);
    const prog = this.progress && Date.now() - this.progress.updatedAt < PROGRESS_TTL_MS ? this.progress : null;
    return { sealed: true, since: r?.sealed_at == null ? this.since : Number(r.sealed_at), mode: r?.mode ?? null, instance: this.instance, escrow: e ? { id: e.id, threshold: Number(e.threshold), shares: Number(e.shares) } : null, progress: { submitted: prog?.shares.size ?? 0, needed: prog?.k ?? (e ? Number(e.threshold) : null) } };
  }

  /** For platform admins (while unsealed): whether a seal is possible, the proposals and the last seal. */
  async status(viewer: string | null) {
    const s = this.s();
    const r = await this.row();
    const e = await this.escrow();
    const run = await this.runningKeyCheck();
    const proposals = ((await s.db('vault_seal_proposals').orderBy('proposed_at', 'desc').limit(20)) as ProposalRow[]);
    const names = await this.names(proposals.flatMap((p) => [p.proposed_by, p.decided_by]));
    const sealable = !!run.keyCheck && !!e && e.key_check === run.keyCheck;
    return {
      sealed: this.flag,
      instance: this.instance,
      kms: s.cfg.KMS_PROVIDER === 'openbao' ? 'openbao' : signerOf(s.kms) ? 'signer' : 'local',
      sealable,
      problem: sealable ? null : (run.why ?? (!e ? 'There is no key escrow: run exprsn-ai kms:escrow first.' : 'The newest escrow is not of the running key: make a new escrow.')),
      escrow: e ? { id: e.id, threshold: Number(e.threshold), shares: Number(e.shares), keyCheck: e.key_check, matchesRunningKey: e.key_check === run.keyCheck, createdAt: Number(e.created_at) } : null,
      signerSealed: this.signerSealed,
      last: r ? { sealedAt: r.sealed_at == null ? null : Number(r.sealed_at), sealedBy: r.sealed_by, mode: r.mode, reason: r.reason, unsealedAt: r.unsealed_at == null ? null : Number(r.unsealed_at), unsealedBy: r.unsealed_by } : null,
      proposals: proposals.map((p) => proposalView(p, names, viewer)),
      proposalTtlMs: PROPOSAL_TTL_MS
    };
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const rows = (await this.s().db('users').whereIn('id', want).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  // ---------- sealing: dual control ----------

  private async proposal(id: string): Promise<ProposalRow> {
    const p = (await this.s().db('vault_seal_proposals').where({ id }).first()) as ProposalRow | undefined;
    if (!p) throw notFound('Seal proposal');
    return p;
  }

  async propose(by: SealActor, reason: string) {
    if (!by.userId) throw forbidden('A seal is proposed by a person.');
    if (this.flag) throw conflict('The vault is already sealed.');
    const e = await this.sealable();
    const s = this.s();
    const now = Date.now();
    await s.db('vault_seal_proposals').where({ state: 'pending' }).andWhere('expires_at', '<=', now).update({ state: 'expired', decided_at: now });
    if (await s.db('vault_seal_proposals').where({ state: 'pending' }).first('id')) throw conflict('A seal is already waiting for a second platform admin: approve or withdraw it.');
    const row: ProposalRow = { id: ulid(), reason, state: 'pending', proposed_by: by.userId, proposed_tenant: by.tenantId, proposed_at: now, expires_at: now + PROPOSAL_TTL_MS, decided_by: null, decided_at: null, note: null };
    await s.db('vault_seal_proposals').insert(row);
    await this.audit(by.tenantId, 'vault.seal.proposed', by.audit, { proposal: row.id }, { reason, expiresAt: row.expires_at, escrow: e.id, threshold: Number(e.threshold), shares: Number(e.shares) }, by.traceId);
    await notifyAdmins(s, { kind: 'vault.seal.proposed', title: 'Sealing the vault waits for a second platform admin', body: reason.slice(0, 300), email: true }).catch(() => 0);
    return proposalView(row, await this.names([row.proposed_by]), by.userId);
  }

  private async pending(id: string): Promise<ProposalRow> {
    const p = await this.proposal(id);
    if (p.state !== 'pending') throw conflict(`The proposal is ${p.state}.`);
    if (Number(p.expires_at) <= Date.now()) {
      await this.s().db('vault_seal_proposals').where({ id, state: 'pending' }).update({ state: 'expired', decided_at: Date.now() });
      throw conflict('The proposal has expired: propose the seal again.');
    }
    return p;
  }

  private async decide(id: string, state: ProposalRow['state'], by: SealActor, note: string | null): Promise<void> {
    const n = await this.s().db('vault_seal_proposals').where({ id, state: 'pending' }).update({ state, decided_by: by.userId, decided_at: Date.now(), note });
    if (!n) throw conflict('The proposal was decided by someone else.');
  }

  /** A second, different platform admin approves: the seal fires on every instance. */
  async approve(by: SealActor, id: string, note: string | null) {
    const p = await this.pending(id);
    if (!by.userId || p.proposed_by === by.userId) throw forbidden('Dual control: you cannot approve your own proposal. Another platform admin must approve it.', { step: 'dual-control' });
    const e = await this.sealable();
    await this.decide(id, 'approved', by, note);
    await this.audit(by.tenantId, 'vault.seal.approved', by.audit, { proposal: id }, { proposedBy: p.proposed_by, reason: p.reason, note }, by.traceId);
    await this.fire('dual-control', by.audit.username ?? by.userId, p.reason, id, e, by);
    return { sealed: true, proposal: proposalView({ ...p, state: 'approved', decided_by: by.userId, decided_at: Date.now(), note }, await this.names([p.proposed_by, by.userId]), by.userId) };
  }

  async reject(by: SealActor, id: string, note: string | null) {
    const p = await this.pending(id);
    if (p.proposed_by === by.userId) throw conflict('This is your own proposal: withdraw it instead.');
    await this.decide(id, 'rejected', by, note);
    await this.audit(by.tenantId, 'vault.seal.rejected', by.audit, { proposal: id }, { proposedBy: p.proposed_by, note }, by.traceId);
    return proposalView({ ...p, state: 'rejected', decided_by: by.userId, decided_at: Date.now(), note }, await this.names([p.proposed_by, by.userId]), by.userId);
  }

  async withdraw(by: SealActor, id: string) {
    const p = await this.pending(id);
    if (p.proposed_by !== by.userId) throw forbidden('Only the admin who proposed the seal can withdraw it; reject it instead.', { step: 'dual-control' });
    await this.decide(id, 'withdrawn', by, null);
    await this.audit(by.tenantId, 'vault.seal.withdrawn', by.audit, { proposal: id }, {}, by.traceId);
    return proposalView({ ...p, state: 'withdrawn', decided_by: by.userId, decided_at: Date.now() }, await this.names([p.proposed_by]), by.userId);
  }

  // ---------- sealing: break-glass ----------

  /** k escrow shares together seal at once, with no session (see the header). The shares are never stored. */
  async breakGlass(shares: string[], reason: string, actor: AuditActor, traceId?: string | null) {
    if (this.flag) throw conflict('The vault is already sealed.');
    const e = await this.sealable();
    try {
      recoverKey(shares, e.key_check).key.fill(0);
    } catch (err) {
      const msg = err instanceof EscrowError ? err.message : 'The shares could not be read.';
      await this.audit(null, 'vault.seal.break-glass.refused', actor, { escrow: e.id }, { reason: msg, given: shares.length }, traceId);
      throw new HttpProblem(422, 'Shares refused', msg, { extensions: { step: 'escrow-shares' } });
    }
    await this.audit(null, 'vault.seal.break-glass', actor, { escrow: e.id }, { reason, shares: shares.map((x) => { try { return decodeShare(x).x; } catch { return null; } }) }, traceId);
    await this.fire('break-glass', actor.service ? `break-glass via ${actor.service}` : `break-glass from ${actor.ip ?? 'unknown address'}`, reason, null, e, { tenantId: await this.platformTenantId(), userId: null, audit: actor, traceId: traceId ?? null });
    return { sealed: true };
  }

  /** Persists the seal, tells every instance, applies it here, and records `vault.sealed`. */
  private async fire(mode: 'dual-control' | 'break-glass', who: string, reason: string, proposalId: string | null, e: EscrowRow, by: SealActor): Promise<void> {
    const at = Date.now();
    await this.persist({ sealed: true, sealed_at: at, sealed_by: who.slice(0, 200), mode, reason: reason.slice(0, 1000), proposal_id: proposalId, escrow_id: e.id, unsealed_at: null, unsealed_by: null });
    await this.serial(() => this.applySeal('local'));
    this.s().bus.publish(SEAL_TOPIC, { sealed: true, at });
    await this.audit(by.tenantId, 'vault.sealed', by.audit, { proposal: proposalId, escrow: e.id }, { mode, reason, threshold: Number(e.threshold), shares: Number(e.shares), instance: this.instance }, by.traceId);
  }

  // ---------- unsealing: the escrow quorum ----------

  /**
   * One share holder's share. Progress is kept in this instance's memory (never stored) until k different shares of
   * the seal's escrow are in; then the vault is unsealed. Returns the progress, or `{ sealed: false }`.
   */
  async submitShare(text: string, actor: AuditActor, traceId?: string | null) {
    const r = await this.row();
    if (!r?.sealed && !this.flag) throw conflict('The vault is not sealed.');
    const e = await this.escrow(r?.escrow_id);
    if (!e) throw conflict('The escrow this seal names is gone from the database; unseal with exprsn-ai vault:unseal --check <key check value>.');
    let share;
    try {
      share = decodeShare(text);
      if (share.escrowId !== e.id) throw new EscrowError(`This share belongs to escrow ${share.escrowId}; the seal needs shares of escrow ${e.id}.`);
    } catch (err) {
      const msg = err instanceof EscrowError ? err.message : 'The share could not be read.';
      await this.audit(null, 'vault.unseal.share.refused', actor, { escrow: e.id }, { reason: msg }, traceId);
      throw new HttpProblem(422, 'Share refused', msg, { extensions: { step: 'escrow-share' } });
    }
    const now = Date.now();
    if (!this.progress || this.progress.escrowId !== e.id || now - this.progress.updatedAt > PROGRESS_TTL_MS) this.progress = { escrowId: e.id, k: share.k, n: share.n, shares: new Map(), updatedAt: now };
    const dup = this.progress.shares.has(share.x);
    this.progress.shares.set(share.x, text.trim().replace(/\s+/g, ''));
    this.progress.updatedAt = now;
    await this.audit(null, 'vault.unseal.share', actor, { escrow: e.id }, { share: share.x, duplicate: dup, submitted: this.progress.shares.size, needed: share.k, instance: this.instance }, traceId);
    if (this.progress.shares.size < this.progress.k) return { sealed: true, progress: { submitted: this.progress.shares.size, needed: this.progress.k }, instance: this.instance };
    const shares = [...this.progress.shares.values()];
    this.progress = null;
    await this.unsealWith(shares, actor, traceId);
    return { sealed: false, instance: this.instance };
  }

  /** Forgets the shares submitted so far on this instance. */
  async resetProgress(actor: AuditActor, traceId?: string | null) {
    const had = this.progress?.shares.size ?? 0;
    this.progress = null;
    await this.audit(null, 'vault.unseal.reset', actor, {}, { discarded: had, instance: this.instance }, traceId);
    return { submitted: 0 };
  }

  /**
   * Unseals with k shares at once (the quorum reached here, or `exprsn-ai vault:unseal`). `check` is the key check
   * value printed at escrow time, for when the escrow's row is gone.
   */
  async unsealWith(shares: string[], actor: AuditActor, traceId?: string | null, check?: string | null): Promise<void> {
    const s = this.s();
    const r = await this.row();
    if (!r?.sealed && !this.flag) throw conflict('The vault is not sealed.');
    const e = await this.escrow(r?.escrow_id ?? (shares[0] ? (() => { try { return decodeShare(shares[0]!).escrowId; } catch { return null; } })() : null));
    const expected = e?.key_check ?? check ?? null;
    if (!expected) throw conflict('The escrow is not in the database: give its key check value (--check).');
    const fail = async (msg: string, status = 422): Promise<never> => {
      await this.audit(null, 'vault.unseal.failed', actor, { escrow: e?.id ?? null }, { reason: msg, given: shares.length, instance: this.instance }, traceId);
      throw new HttpProblem(status, 'Unseal failed', msg, { extensions: { step: 'escrow-shares' } });
    };
    let used: number;
    try {
      const rec = recoverKey(shares, expected);
      used = rec.used;
      // The local key must be the one the shares rebuild; with the signer, the signer checks the shares itself.
      const run = signerOf(s.kms) ? null : s.cfg.DATA_KEY ? keyCheckValue(Buffer.from(s.cfg.DATA_KEY, 'base64')) : null;
      const got = keyCheckValue(rec.key);
      rec.key.fill(0);
      if (run && run !== got) return await fail('The shares rebuild a key, but not the key this deployment runs on.');
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      return await fail(err instanceof EscrowError ? err.message : 'The shares could not be read.');
    }
    const client = signerOf(s.kms);
    if (client) {
      try {
        await client.call('unseal', { shares });
        this.signerSealed = false;
      } catch (err) {
        return await fail(`The signer refused the shares: ${(err as Error).message.replace(/^Signer: /, '').slice(0, 300)}`, 502);
      }
    }
    const at = Date.now();
    const who = actor.username ?? actor.service ?? (actor.ip ? `share holders from ${actor.ip}` : 'share holders');
    await this.persist({ sealed: false, unsealed_at: at, unsealed_by: who.slice(0, 200) });
    await this.serial(() => this.applyUnseal('local'));
    this.s().bus.publish(SEAL_TOPIC, { sealed: false, at });
    await this.audit(null, 'vault.unsealed', actor, { escrow: e?.id ?? null }, { shares: used, sealedAt: r?.sealed_at == null ? null : Number(r.sealed_at), sealedFor: r?.sealed_at == null ? null : at - Number(r.sealed_at), mode: r?.mode ?? null, instance: this.instance, signer: client ? 'unsealed' : null }, traceId);
  }

  /** `vault:unseal --signer-only`: unseals this host's signer when the vault is open but the signer kept its seal. */
  async unsealSigner(shares: string[], actor: AuditActor): Promise<void> {
    const client = signerOf(this.s().kms);
    if (!client) throw badRequest('This process does not use the signer (SIGNER_SOCKET).');
    await client.call('unseal', { shares });
    this.signerSealed = false;
    await this.audit(null, 'vault.unseal.signer', actor, {}, { instance: this.instance });
  }
}
