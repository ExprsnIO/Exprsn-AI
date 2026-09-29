import { randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
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
import { hmac, safeEqual, type SecretBox } from '../crypto/index.js';

authenticator.options = { step: 30, window: 1, digits: 6 };

export interface FactorRow {
  id: string;
  user_id: string;
  kind: 'totp' | 'webauthn';
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
  kind: r.kind as 'totp' | 'webauthn',
  label: String(r.label),
  confirmed_at: r.confirmed_at == null ? null : Number(r.confirmed_at),
  last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
  created_at: Number(r.created_at)
});

/** TOTP (RFC 6238) and WebAuthn passkeys as second factors, plus single-use recovery codes. */
export class MfaService {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly cfg: MfaSettings
  ) {}

  async factors(userId: string, confirmedOnly = true): Promise<FactorRow[]> {
    const q = this.db('mfa_factors').where({ user_id: userId });
    if (confirmedOnly) q.whereNotNull('confirmed_at');
    return (await q.orderBy('created_at')).map(factor);
  }

  async methods(userId: string): Promise<('totp' | 'webauthn' | 'recovery')[]> {
    const kinds = new Set((await this.factors(userId)).map((f) => f.kind));
    const out: ('totp' | 'webauthn' | 'recovery')[] = [];
    if (kinds.has('webauthn')) out.push('webauthn');
    if (kinds.has('totp')) out.push('totp');
    if (out.length && (await this.remainingRecoveryCodes(userId)) > 0) out.push('recovery');
    return out;
  }

  // ---------- TOTP ----------

  /** Starts enrolment: stores an unconfirmed factor and returns the seed and otpauth URI once. */
  async beginTotp(userId: string, username: string, label: string): Promise<{ id: string; secret: string; uri: string }> {
    await this.db('mfa_factors').where({ user_id: userId, kind: 'totp' }).whereNull('confirmed_at').delete();
    const id = ulid();
    const secret = authenticator.generateSecret(20);
    await this.db('mfa_factors').insert({ id, user_id: userId, kind: 'totp', label, secret: this.box.seal(secret, 'totp:' + id), created_at: Date.now() });
    return { id, secret, uri: authenticator.keyuri(username, this.cfg.issuer, secret) };
  }

  async confirmTotp(userId: string, factorId: string, code: string): Promise<boolean> {
    const row = await this.db('mfa_factors').where({ id: factorId, user_id: userId, kind: 'totp' }).whereNull('confirmed_at').first();
    if (!row) return false;
    const step = this.checkCode(row, code);
    if (step == null) return false;
    await this.db('mfa_factors').where({ id: factorId }).update({ confirmed_at: Date.now(), last_step: step, last_used_at: Date.now() });
    return true;
  }

  /** Verifies a code against any confirmed TOTP factor. A code (time step) is accepted once only. */
  async verifyTotp(userId: string, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const rows = await this.db('mfa_factors').where({ user_id: userId, kind: 'totp' }).whereNotNull('confirmed_at');
    for (const row of rows) {
      const step = this.checkCode(row, code);
      if (step == null) continue;
      const n = await this.db('mfa_factors')
        .where({ id: row.id })
        .andWhere((w) => w.whereNull('last_step').orWhere('last_step', '<', step))
        .update({ last_step: step, last_used_at: Date.now() });
      if (n) return true;
    }
    return false;
  }

  private checkCode(row: Record<string, unknown>, code: string): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const secret = this.box.open(String(row.secret), 'totp:' + String(row.id));
    const delta = authenticator.checkDelta(code, secret);
    if (delta == null) return null;
    return Math.floor(Date.now() / 30_000) + delta;
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
