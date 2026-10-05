import { randomInt } from 'node:crypto';

/*
 * Timestamp identifiers (B-2902, https://atproto.com/specs/tid): 13 characters of "base32-sortable"
 * (`234567abcdefghijklmnopqrstuvwxyz`), a 64-bit integer whose top bit is zero, the next 53 bits a timestamp in
 * microseconds since the epoch and the last 10 bits a clock identifier. They sort as strings in time order. A repo's
 * `rev` and the default record key of a new record are TIDs; a repo's revs only ever grow, so `nextTid` never returns
 * one at or below the previous rev, even when the clock steps back.
 */

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

function s32encode(n: bigint, width: number): string {
  let out = '';
  let v = n;
  while (v > 0n) {
    out = S32[Number(v % 32n)] + out;
    v /= 32n;
  }
  return out.padStart(width, '2');
}

function s32decode(s: string): bigint {
  let n = 0n;
  for (const ch of s) {
    const i = S32.indexOf(ch);
    if (i < 0) throw new Error('Not base32-sortable');
    n = n * 32n + BigInt(i);
  }
  return n;
}

/** This process's clock identifier (the spec lets it be random, as long as it stays put). */
const CLOCK_ID = BigInt(randomInt(0, 1024));
let lastMicros = 0n;

/** The TID of a time (microseconds) and clock identifier. */
export function tidFrom(micros: bigint, clockId: bigint = CLOCK_ID): string {
  if (micros < 0n || micros >= 1n << 53n || clockId < 0n || clockId >= 1024n) throw new Error('TID out of range');
  return s32encode(micros, 11) + s32encode(clockId, 2);
}

export const tidMicros = (tid: string): bigint => s32decode(tid.slice(0, 11));

/** A fresh TID, strictly after `after` (a previous rev) when one is given and after any TID this process made. */
export function nextTid(after?: string | null): string {
  let micros = BigInt(Date.now()) * 1000n;
  if (micros <= lastMicros) micros = lastMicros + 1n;
  lastMicros = micros;
  let tid = tidFrom(micros);
  if (after && TID_RE.test(after) && tid <= after) {
    lastMicros = tidMicros(after) + 1n;
    tid = tidFrom(lastMicros);
  }
  return tid;
}
