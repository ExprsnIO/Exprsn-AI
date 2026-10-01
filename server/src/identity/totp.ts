import { generateSecret as otpSecret, generateSync, generateURI, verifySync } from 'otplib';

/** TOTP as the console and authenticator apps use it: SHA-1, six digits, 30-second steps, one step of drift each way. */
const PERIOD = 30;
const DIGITS = 6;

const seconds = (at: number): number => Math.floor(at / 1000);

export const totp = {
  /** A base32 secret of `bytes` random bytes (20, as RFC 4226 recommends). */
  generateSecret: (bytes = 20): string => otpSecret({ length: bytes }),
  /** The otpauth:// URI an authenticator app scans. */
  keyuri: (label: string, issuer: string, secret: string): string => generateURI({ issuer, label, secret, period: PERIOD, digits: DIGITS }),
  /** The code for `secret` at `at` (milliseconds; now by default). */
  generate: (secret: string, at: number = Date.now()): string => generateSync({ secret, period: PERIOD, digits: DIGITS, epoch: seconds(at) }),
  /** The step offset (-1, 0 or 1) at which `code` matches, or null. */
  checkDelta(code: string, secret: string, at: number = Date.now()): number | null {
    const r = verifySync({ secret, token: code, period: PERIOD, digits: DIGITS, epoch: seconds(at), epochTolerance: PERIOD });
    return r.valid ? r.delta : null;
  },
  check: (code: string, secret: string, at: number = Date.now()): boolean => totp.checkDelta(code, secret, at) !== null
};
