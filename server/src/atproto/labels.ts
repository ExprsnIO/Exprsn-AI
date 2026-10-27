import type { KeyObject } from 'node:crypto';
import type { FlagRow } from '../guardrails/flags.js';
import type { GuardAction, GuardDecision } from '../guardrails/types.js';
import { cborEncode } from './cbor.js';
import { verifySignature, type Curve } from './crypto.js';

/*
 * AT-Protocol labels (B-1610, B-1611; https://atproto.com/specs/label). A label is
 *
 *   { ver: 1, src: <labeler DID>, uri: <subject>, cid?: <record version>, val, neg, cts, exp?, sig }
 *
 * and its signature covers the DAG-CBOR encoding of the label without `sig`, made with the labeler's
 * `#atproto_label` key. `neg: true` withdraws an earlier label with the same src, uri and val.
 */

/** Bus topic: an identity has a new label (`{ identityId, seq }`); subscribers on every instance read it. */
export const LABELS_TOPIC = 'atproto.labels';

export interface Label {
  ver: 1;
  src: string;
  uri: string;
  cid?: string;
  val: string;
  neg: boolean;
  cts: string;
  exp?: string;
  sig?: Buffer;
}

/** A label value: lower-case letters, digits and hyphens, optionally behind `!` for the global system values. */
export const LABEL_VALUE_RE = /^!?[a-z0-9][a-z0-9-]{0,127}$/;
/** A label subject: an at:// URI, a DID or an https URL. */
export const SUBJECT_RE = /^(at:\/\/[\x21-\x7e]{3,2000}|did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}|https:\/\/[\x21-\x7e]{3,2000})$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** The bytes a label's signature covers. */
export function labelSigningBytes(l: Label): Buffer {
  return cborEncode({ ver: l.ver, src: l.src, uri: l.uri, cid: l.cid, val: l.val, neg: l.neg, cts: l.cts, exp: l.exp });
}

/** The JSON form (XRPC): bytes as `{ $bytes: <base64 without padding> }`. */
export function labelJson(l: Label): Record<string, unknown> {
  return { ver: l.ver, src: l.src, uri: l.uri, ...(l.cid ? { cid: l.cid } : {}), val: l.val, neg: l.neg, cts: l.cts, ...(l.exp ? { exp: l.exp } : {}), ...(l.sig ? { sig: { $bytes: l.sig.toString('base64').replace(/=+$/, '') } } : {}) };
}

/** The event-stream form: a CBOR map with `sig` as bytes. */
export function labelCbor(l: Label): Record<string, unknown> {
  return { ver: l.ver, src: l.src, uri: l.uri, cid: l.cid, val: l.val, neg: l.neg, cts: l.cts, exp: l.exp, sig: l.sig };
}

/** Reads a label from the network (JSON or CBOR form); null when it is not a well-formed label. */
export function readLabel(v: unknown): Label | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown, max: number) => (typeof x === 'string' && x.length <= max ? x : null);
  const src = str(o.src, 2048);
  const uri = str(o.uri, 2048);
  const val = str(o.val, 129);
  const cts = str(o.cts, 64);
  if (!src || !src.startsWith('did:') || !uri || !val || !LABEL_VALUE_RE.test(val) || !cts || !DATETIME_RE.test(cts)) return null;
  const ver = o.ver === undefined ? 1 : o.ver;
  if (ver !== 1) return null;
  if (o.neg !== undefined && typeof o.neg !== 'boolean') return null;
  if (o.cid !== undefined && str(o.cid, 200) === null) return null;
  if (o.exp !== undefined && (str(o.exp, 64) === null || !DATETIME_RE.test(o.exp as string))) return null;
  let sig: Buffer | undefined;
  if (Buffer.isBuffer(o.sig)) sig = o.sig;
  else if (o.sig && typeof o.sig === 'object' && typeof (o.sig as { $bytes?: unknown }).$bytes === 'string') sig = Buffer.from((o.sig as { $bytes: string }).$bytes, 'base64');
  return { ver: 1, src, uri, ...(o.cid ? { cid: o.cid as string } : {}), val, neg: o.neg === true, cts, ...(o.exp ? { exp: o.exp as string } : {}), ...(sig ? { sig } : {}) };
}

/**
 * Re-encodes a received label exactly as it was sent. `neg` is part of the signed map only when the sender included
 * it: Bluesky's own labelers always send it, but a label without the field must still verify.
 */
export function verifyLabel(raw: Record<string, unknown>, l: Label, curve: Curve, key: KeyObject): boolean {
  if (!l.sig) return false;
  const bytes = cborEncode({ ver: raw.ver === undefined ? undefined : 1, src: l.src, uri: l.uri, cid: l.cid, val: l.val, neg: raw.neg === undefined ? undefined : l.neg, cts: l.cts, exp: l.exp });
  return verifySignature(curve, key, bytes, l.sig);
}

/*
 * Verdicts to labels. The guardrail action decides the system label: a block or a hold hides the subject (`!hide`),
 * a warning, flag or redaction warns (`!warn`); allow and log label nothing. Each enforced finding adds category
 * labels by matching its rule name and detail against the table below (the values AT-Protocol clients know, plus a
 * few of Exprsn-AI's own, which only clients that read this labeler's values act on).
 */
const ACTION_LABEL: Partial<Record<GuardAction, string>> = { block: '!hide', 'require-approval': '!hide', redact: '!warn', flag: '!warn', warn: '!warn' };

const CATEGORIES: [RegExp, string][] = [
  [/\bporn|explicit sexual/i, 'porn'],
  [/sexual|\bS12\b/i, 'sexual'],
  [/nudity|\bnude/i, 'nudity'],
  [/gore|graphic|violen|\bS1\b/i, 'graphic-media'],
  [/\bspam/i, 'spam'],
  [/self[- ]harm|suicide|\bS11\b/i, 'self-harm'],
  [/\bhate|\bS10\b/i, 'hate'],
  [/harass/i, 'harassment'],
  [/\bpii\b|personal data|email address|phone number|credit card|\bssn\b|\biban\b/i, 'pii'],
  [/secret|credential|api key|private key|password/i, 'secrets']
];

export function categoriesOf(text: string): string[] {
  const out = new Set<string>();
  for (const [re, val] of CATEGORIES) if (re.test(text)) out.add(val);
  return [...out];
}

/** Labels for a guardrail decision (B-1610). */
export function labelsForDecision(d: Pick<GuardDecision, 'action' | 'findings'>): string[] {
  const out = new Set<string>();
  const system = ACTION_LABEL[d.action];
  if (system) out.add(system);
  for (const f of d.findings) {
    if (f.stage !== 'enforce' || f.action === 'allow' || f.action === 'log') continue;
    for (const c of categoriesOf(`${f.ruleName} ${f.detail ?? ''}`)) out.add(c);
  }
  return [...out];
}

/**
 * Labels for a flag's verdict: an open, confirmed or rejected flag labels its subject from its rule action and name;
 * a dismissed or approved flag labels nothing (and withdraws what it labelled, see `AtprotoService.negateForFlag`).
 * A flag without a hiding or warning action still warns: a person or a rule thought the subject worth review.
 */
export function labelsForFlag(f: Pick<FlagRow, 'state' | 'action' | 'rule_name' | 'severity'>): string[] {
  if (f.state === 'dismissed' || f.state === 'approved') return [];
  const system = ACTION_LABEL[(f.action ?? 'flag') as GuardAction] ?? '!warn';
  return [...new Set([system, ...categoriesOf(f.rule_name)])];
}
