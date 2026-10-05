import { randomBytes, randomInt } from 'node:crypto';
import { totp } from './totp.js';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import { hmac, safeEqual } from '../crypto/index.js';
import type { Sealer } from '../platform/datakeys.js';

export interface FactorRow {
  id: string;
  user_id: string;
  kind: 'totp' | 'webauthn' | 'email';
  label: string;
  confirmed_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

export interface MfaSettings {
  issuer: string;
  rpId: string;
  rpName: string;
  origin: string;
  secret: string;
}

const factor = (r: Record<string, unknown>): FactorRow => ({
  id: String(r.id),
  user_id: String(r.user_id),
  kind: r.kind as FactorRow['kind'],
  label: String(r.label),
  confirmed_at: r.confirmed_at == null ? null : Number(r.confirmed_at),
  last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
  created_at: Number(r.created_at)
});

/** TOTP (RFC 6238) and WebAuthn passkeys as second factors, plus single-use recovery codes. */
export class MfaService {
  constructor(
    private readonly db: Db,
    private readonly box: Sealer,
    private readonly cfg: MfaSettings
  ) {}

  async factors(userId: string, confirmedOnly = true): Promise<FactorRow[]> {
    const q = this.db('mfa_factors').where({ user_id: userId });
    if (confirmedOnly) q.whereNotNull('confirmed_at');
    return (await q.orderBy('created_at')).map(factor);
  }

  async methods(userId: string): Promise<('totp' | 'webauthn' | 'email' | 'recovery')[]> {
    const kinds = new Set((await this.factors(userId)).map((f) => f.kind));
    const out: ('totp' | 'webauthn' | 'email' | 'recovery')[] = [];
    if (kinds.has('webauthn')) out.push('webauthn');
    if (kinds.has('totp')) out.push('totp');
    if (kinds.has('email')) out.push('email');
    if (out.length && (await this.remainingRecoveryCodes(userId)) > 0) out.push('recovery');
    return out;
  }

  // ---------- TOTP ----------

  /** Starts enrolment: stores an unconfirmed factor and returns the seed and otpauth URI once. */
  async beginTotp(userId: string, username: string, label: string): Promise<{ id: string; secret: string; uri: string }> {
    await this.db('mfa_factors').where({ user_id: userId, kind: 'totp' }).whereNull('confirmed_at').delete();
    const id = ulid();
    const secret = totp.generateSecret(20);
    await this.db('mfa_factors').insert({ id, user_id: userId, kind: 'totp', label, secret: await this.box.seal(secret, 'totp:' + id), created_at: Date.now() });
    return { id, secret, uri: totp.keyuri(username, this.cfg.issuer, secret) };
  }

  async confirmTotp(userId: string, factorId: string, code: string): Promise<boolean> {
    const row = await this.db('mfa_factors').where({ id: factorId, user_id: userId, kind: 'totp' }).whereNull('confirmed_at').first();
    if (!row) return false;
    const step = await this.checkCode(row, code);
    if (step == null) return false;
    await this.db('mfa_factors').where({ id: factorId }).update({ confirmed_at: Date.now(), last_step: step, last_used_at: Date.now() });
    return true;
  }

  /** Verifies a code against any confirmed TOTP factor. A code (time step) is accepted once only. */
  async verifyTotp(userId: string, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const rows = await this.db('mfa_factors').where({ user_id: userId, kind: 'totp' }).whereNotNull('confirmed_at');
    for (const row of rows) {
      const step = await this.checkCode(row, code);
      if (step == null) continue;
      const n = await this.db('mfa_factors')
        .where({ id: row.id })
        .andWhere((w) => w.whereNull('last_step').orWhere('last_step', '<', step))
        .update({ last_step: step, last_used_at: Date.now() });
      if (n) return true;
    }
    return false;
  }

  private async checkCode(row: Record<string, unknown>, code: string): Promise<number | null> {
    if (!/^\d{6}$/.test(code)) return null;
    const secret = await this.box.open(String(row.secret), 'totp:' + String(row.id));
    const delta = totp.checkDelta(code, secret);
    if (delta == null) return null;
    return Math.floor(Date.now() / 30_000) + delta;
  }

  // ---------- email one-time codes (Sprint 28a, B-1806) ----------

  /**
   * Starts enrolling an email address as a factor: an unconfirmed factor holding the address (sealed), and a code for
   * it. The address is the one the code goes to from then on, so a later change of the account's email does not move
   * the factor. Returns the code once, for the caller to send.
   */
  async beginEmail(userId: string, address: string, label: string, ttlMs: number): Promise<{ id: string; code: string; expiresAt: number }> {
    await this.db('mfa_factors').where({ user_id: userId, kind: 'email' }).whereNull('confirmed_at').delete();
    const id = ulid();
    await this.db('mfa_factors').insert({ id, user_id: userId, kind: 'email', label, secret: await this.box.seal(address, 'email-factor:' + id), created_at: Date.now() });
    const { code, expiresAt } = await this.issueEmailCode(userId, id, 'enrol', null, ttlMs);
    return { id, code, expiresAt };
  }

  /** The address a confirmed (or, with `pending`, an unconfirmed) email factor sends to. */
  async emailFactor(userId: string, factorId?: string, pending = false): Promise<{ id: string; address: string } | null> {
    const q = this.db('mfa_factors').where({ user_id: userId, kind: 'email' });
    if (factorId) q.andWhere({ id: factorId });
    if (pending) q.whereNull('confirmed_at');
    else q.whereNotNull('confirmed_at');
    const row = (await q.orderBy('created_at', 'desc').first()) as { id: string; secret: string } | undefined;
    return row ? { id: row.id, address: await this.box.open(row.secret, 'email-factor:' + row.id) } : null;
  }

  private emailCodeHash(userId: string, code: string): string {
    return hmac(this.cfg.secret, `email-code:${userId}:${code}`);
  }

  /** A fresh six-digit code for the factor; earlier unused codes for the same purpose and session stop working. */
  async issueEmailCode(userId: string, factorId: string, purpose: 'enrol' | 'signin', sessionId: string | null, ttlMs: number): Promise<{ code: string; expiresAt: number }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const t = Date.now();
    const old = this.db('mfa_email_codes').where({ user_id: userId, purpose }).whereNull('used_at');
    if (sessionId) old.andWhere({ session_id: sessionId });
    await old.delete();
    await this.db('mfa_email_codes').insert({ id: ulid(), user_id: userId, factor_id: factorId, purpose, session_id: sessionId, code_hash: this.emailCodeHash(userId, code), expires_at: t + ttlMs, used_at: null, created_at: t });
    return { code, expiresAt: t + ttlMs };
  }

  /**
   * Checks a code once: a live, unused code for this purpose (and session, for a sign-in) is used up by a
   * compare-and-set, so two requests cannot both spend it. A wrong code changes nothing; the caller counts it.
   */
  async useEmailCode(userId: string, purpose: 'enrol' | 'signin', sessionId: string | null, code: string, factorId?: string): Promise<string | null> {
    if (!/^\d{6}$/.test(code)) return null;
    const h = this.emailCodeHash(userId, code);
    const q = this.db('mfa_email_codes').where({ user_id: userId, purpose }).whereNull('used_at').andWhere('expires_at', '>', Date.now());
    if (sessionId) q.andWhere({ session_id: sessionId });
    if (factorId) q.andWhere({ factor_id: factorId });
    const rows = (await q.select('id', 'code_hash', 'factor_id')) as { id: string; code_hash: string; factor_id: string }[];
    const hit = rows.find((r) => safeEqual(r.code_hash, h));
    if (!hit) return null;
    const n = await this.db('mfa_email_codes').where({ id: hit.id }).whereNull('used_at').update({ used_at: Date.now() });
    return n ? hit.factor_id : null;
  }

  /** Confirms an email factor being enrolled with the code sent to it. */
  async confirmEmail(userId: string, factorId: string, code: string): Promise<boolean> {
    const pending = await this.db('mfa_factors').where({ id: factorId, user_id: userId, kind: 'email' }).whereNull('confirmed_at').first('id');
    if (!pending) return false;
    if (!(await this.useEmailCode(userId, 'enrol', null, code, factorId))) return false;
    await this.db('mfa_factors').where({ id: factorId }).update({ confirmed_at: Date.now(), last_used_at: Date.now() });
    return true;
  }

  /** A sign-in code for a pending session: true (and the factor marked used) when it matches. */
  async verifyEmailCode(userId: string, sessionId: string, code: string): Promise<boolean> {
    const factorId = await this.useEmailCode(userId, 'signin', sessionId, code);
    if (!factorId) return false;
    // A factor removed after the code was sent no longer signs anyone in.
    return (await this.db('mfa_factors').where({ id: factorId, user_id: userId, kind: 'email' }).whereNotNull('confirmed_at').update({ last_used_at: Date.now() })) > 0;
  }

  /** Drops codes that expired a day ago or were used (the retention sweep calls it). */
  async purgeEmailCodes(): Promise<number> {
    return this.db('mfa_email_codes').where('expires_at', '<', Date.now() - 86_400_000).orWhereNotNull('used_at').delete();
  }

  // ---------- WebAuthn ----------

  async registrationOptions(userId: string, username: string, displayName: string) {
    const existing = await this.db('mfa_factors').where({ user_id: userId, kind: 'webauthn' }).whereNotNull('confirmed_at').select('credential_id', 'transports');
    return generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName: username,
      userDisplayName: displayName,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: existing.map((c: { credential_id: string; transports: string | null }) => ({ id: c.credential_id, transports: json(c.transports, []) })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
    });
  }

  async verifyRegistration(userId: string, expectedChallenge: string, response: RegistrationResponseJSON, label: string): Promise<FactorRow | null> {
    const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: this.cfg.origin, expectedRPID: this.cfg.rpId });
    if (!v.verified) return null;
    const c = v.registrationInfo.credential;
    const t = Date.now();
    const row = { id: ulid(), user_id: userId, kind: 'webauthn', label, credential_id: c.id, public_key: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter, transports: JSON.stringify(c.transports ?? []), confirmed_at: t, created_at: t };
    await this.db('mfa_factors').insert(row);
    return factor(row);
  }

  async authenticationOptions(userId: string) {
    const creds = await this.db('mfa_factors').where({ user_id: userId, kind: 'webauthn' }).whereNotNull('confirmed_at').select('credential_id', 'transports');
    return generateAuthenticationOptions({
      rpID: this.cfg.rpId,
      allowCredentials: creds.map((c: { credential_id: string; transports: string | null }) => ({ id: c.credential_id, transports: json(c.transports, []) })),
      userVerification: 'preferred'
    });
  }

  async verifyAuthentication(userId: string, expectedChallenge: string, response: AuthenticationResponseJSON): Promise<boolean> {
    const row = await this.db('mfa_factors').where({ user_id: userId, kind: 'webauthn', credential_id: response.id }).whereNotNull('confirmed_at').first();
    if (!row) return false;
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpId,
      credential: { id: row.credential_id, publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')), counter: Number(row.counter ?? 0), transports: json(row.transports, []) }
    });
    if (!v.verified) return false;
    await this.db('mfa_factors').where({ id: row.id }).update({ counter: v.authenticationInfo.newCounter, last_used_at: Date.now() });
    return true;
  }

  // ---------- recovery codes ----------

  private codeHash(userId: string, code: string): string {
    return hmac(this.cfg.secret, `recovery:${userId}:${code.replace(/[\s-]/g, '').toLowerCase()}`);
  }

  /** Replaces all recovery codes; the plain codes are returned once. */
  async regenerateRecoveryCodes(userId: string, count = 10): Promise<string[]> {
    const codes = Array.from({ length: count }, () => {
      const raw = randomBytes(5).toString('hex');
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      await trx('mfa_recovery_codes').where({ user_id: userId }).delete();
      await trx('mfa_recovery_codes').insert(codes.map((c) => ({ id: ulid(), user_id: userId, code_hash: this.codeHash(userId, c), created_at: t })));
    });
    return codes;
  }

  async useRecoveryCode(userId: string, code: string): Promise<boolean> {
    const h = this.codeHash(userId, code);
    const rows = await this.db('mfa_recovery_codes').where({ user_id: userId }).whereNull('used_at').select('id', 'code_hash');
    const hit = rows.find((r: { code_hash: string }) => safeEqual(r.code_hash, h));
    if (!hit) return false;
    return (await this.db('mfa_recovery_codes').where({ id: hit.id }).whereNull('used_at').update({ used_at: Date.now() })) > 0;
  }

  async remainingRecoveryCodes(userId: string): Promise<number> {
    const r = (await this.db('mfa_recovery_codes').where({ user_id: userId }).whereNull('used_at').count({ n: '*' }).first()) as { n: number | string } | undefined;
    return Number(r?.n ?? 0);
  }

  async removeFactor(userId: string, id: string): Promise<boolean> {
    return (await this.db('mfa_factors').where({ user_id: userId, id }).delete()) > 0;
  }
}
