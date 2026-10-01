import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import type { Db } from '../db/knex.js';
import { combine, split } from './shamir.js';

/*
 * B-1404: escrow of the local key-encryption key (DATA_KEY) as k-of-n Shamir shares.
 *
 * `kms:escrow` prints each share once, with its own check value (so a mistyped share is caught on its own), and the
 * key check value: an HMAC of a fixed label under the key, which identifies the key without revealing it. The
 * database keeps the escrow's id, k, n and key check value, never a share. `kms:recover` takes k shares of one
 * escrow, rebuilds the key, and accepts it only when its key check value matches (the database's record, or the value
 * printed at escrow time when the database is gone too).
 */

const KCV_LABEL = 'exprsn-ai key check value v1';
const PREFIX = 'exprsn-share';

export class EscrowError extends Error {}

/** 16 hex characters identifying a key. */
export function keyCheckValue(key: Buffer): string {
  return createHmac('sha256', key).update(KCV_LABEL).digest('hex').slice(0, 16);
}

export interface DecodedShare {
  escrowId: string;
  k: number;
  n: number;
  x: number;
  y: Buffer;
}

const shareCheck = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 8);

/** `exprsn-share:v1:<escrow id>:<k>of<n>:<x>:<hex>:<check>`. */
export function encodeShare(s: DecodedShare): string {
  const body = `${PREFIX}:v1:${s.escrowId}:${s.k}of${s.n}:${s.x}:${s.y.toString('hex')}`;
  return `${body}:${shareCheck(body)}`;
}

export function decodeShare(text: string): DecodedShare {
  const t = text.trim().replace(/\s+/g, '');
  const m = /^exprsn-share:v1:([0-9A-HJKMNP-TV-Z]{26}):(\d{1,3})of(\d{1,3}):(\d{1,3}):([0-9a-f]{2,512}):([0-9a-f]{8})$/.exec(t);
  if (!m) throw new EscrowError('This is not an escrow share (expected exprsn-share:v1:...).');
  const body = t.slice(0, t.lastIndexOf(':'));
  if (shareCheck(body) !== m[6]) throw new EscrowError(`Share ${m[4]} does not match its check value: it was copied wrongly.`);
  const k = Number(m[2]);
  const n = Number(m[3]);
  const x = Number(m[4]);
  if (k < 2 || n < k || n > 255 || x < 1 || x > n || m[5]!.length % 2) throw new EscrowError('The share is malformed.');
  return { escrowId: m[1]!, k, n, x, y: Buffer.from(m[5]!, 'hex') };
}

export interface Escrow {
  id: string;
  k: number;
  n: number;
  keyCheck: string;
  shares: string[];
}

/** Splits the key into n shares of which k rebuild it. */
export function escrowKey(key: Buffer, k: number, n: number, id = ulid()): Escrow {
  if (key.length !== 32) throw new EscrowError('The key-encryption key must be 32 bytes.');
  const shares = split(key, n, k).map((s) => encodeShare({ escrowId: id, k, n, x: s.x, y: s.y }));
  return { id, k, n, keyCheck: keyCheckValue(key), shares };
}

/**
 * Rebuilds the key from shares of one escrow. Refuses fewer shares than the threshold, shares of different escrows,
 * duplicates, and a result whose key check value is not `expectedCheck`.
 */
export function recoverKey(texts: string[], expectedCheck: string): { key: Buffer; escrowId: string; used: number } {
  if (!/^[0-9a-f]{16}$/.test(expectedCheck)) throw new EscrowError('The key check value is 16 hexadecimal characters.');
  const shares = texts.map(decodeShare);
  if (!shares.length) throw new EscrowError('No shares given.');
  const first = shares[0]!;
  if (shares.some((s) => s.escrowId !== first.escrowId || s.k !== first.k || s.n !== first.n)) throw new EscrowError('The shares come from different escrows.');
  const unique = [...new Map(shares.map((s) => [s.x, s])).values()];
  if (unique.length < first.k) throw new EscrowError(`This escrow needs ${first.k} different shares; ${unique.length} ${unique.length === 1 ? 'was' : 'were'} given.`);
  const key = combine(unique.slice(0, first.k).map((s) => ({ x: s.x, y: s.y })));
  const got = keyCheckValue(key);
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(expectedCheck))) throw new EscrowError('The rebuilt key does not match the key check value: a share is wrong or belongs to another key.');
  return { key, escrowId: first.escrowId, used: first.k };
}

export interface EscrowRow {
  id: string;
  kms: string;
  threshold: number;
  shares: number;
  key_check: string;
  created_by: string | null;
  created_at: number;
  verified_at: number | null;
}

export async function recordEscrow(db: Db, e: Pick<Escrow, 'id' | 'k' | 'n' | 'keyCheck'>, by: string | null): Promise<void> {
  await db('kms_escrows').insert({ id: e.id, kms: 'local', threshold: e.k, shares: e.n, key_check: e.keyCheck, created_by: by, created_at: Date.now(), verified_at: null });
}

export async function escrowById(db: Db, id: string): Promise<EscrowRow | undefined> {
  return (await db('kms_escrows').where({ id }).first()) as EscrowRow | undefined;
}

export async function latestEscrow(db: Db): Promise<EscrowRow | undefined> {
  return (await db('kms_escrows').orderBy('created_at', 'desc').first()) as EscrowRow | undefined;
}
