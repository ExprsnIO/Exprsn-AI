import { ibanValid, luhn } from '../chat/attachments.js';

/**
 * Deterministic detectors behind the PII and secrets classifiers and the `pii` rule mechanism. Each returns spans
 * with a score: 1.00 when a checksum verifies (payment cards by Luhn, IBANs by mod-97, national identifiers by their
 * check digit or letter), lower for pattern-only matches. The same detectors classify attachments (chat/attachments).
 */
export interface Detection {
  kind: string;
  span: [number, number];
  score: number;
}

export const PII_KINDS = ['email', 'phone', 'iban', 'payment_card', 'national_id'] as const;
export const SECRET_KINDS = ['private_key', 'cloud_access_key', 'bearer_token', 'high_entropy'] as const;

function scan(text: string, re: RegExp, fn: (m: RegExpExecArray) => { score: number; start?: number; end?: number } | null, kind: string, out: Detection[]): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const hit = fn(m);
    if (hit) out.push({ kind, span: [hit.start ?? m.index, hit.end ?? m.index + m[0].length], score: hit.score });
    if (out.length > 5000) break;
  }
}

/** Spanish DNI/NIE: eight digits (NIE: X, Y or Z then seven) and the check letter. */
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const dniValid = (s: string): boolean => {
  const v = s.toUpperCase().replace(/^[XYZ]/, (c) => String('XYZ'.indexOf(c)));
  const n = Number(v.slice(0, 8));
  return /^\d{8}[A-Z]$/.test(v) && DNI_LETTERS[n % 23] === v[8];
};

/** Dutch BSN: nine digits passing the eleven test. */
const bsnValid = (d: string): boolean => {
  if (!/^\d{9}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(d[i]) * (9 - i);
  sum -= Number(d[8]);
  return sum % 11 === 0 && sum !== 0;
};

export function detectPii(text: string, kinds: readonly string[] = PII_KINDS): Detection[] {
  const want = new Set(kinds.includes('*') ? PII_KINDS : kinds);
  const out: Detection[] = [];
  if (want.has('email')) scan(text, /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g, () => ({ score: 0.99 }), 'email', out);
  if (want.has('payment_card')) {
    scan(text, /\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
      const d = m[0].replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d) ? { score: 1 } : null;
    }, 'payment_card', out);
  }
  if (want.has('iban')) scan(text, /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, (m) => (ibanValid(m[0]) ? { score: 1 } : null), 'iban', out);
  if (want.has('national_id')) {
    // US SSN (pattern rules only), UK National Insurance number, Spanish DNI/NIE, Dutch BSN (both checksummed).
    scan(text, /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, () => ({ score: 0.9 }), 'national_id', out);
    scan(text, /\b(?![DFIQUV])[A-Z](?![DFIOQUV])[A-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g, (m) => (/^(BG|GB|NK|KN|TN|NT|ZZ)/.test(m[0]) ? null : { score: 0.9 }), 'national_id', out);
    scan(text, /\b[XYZ]?\d{7,8}-?[A-Z]\b/g, (m) => {
      const v = m[0].replace('-', '');
      return (/^[XYZ]\d{7}[A-Z]$/.test(v) || /^\d{8}[A-Z]$/.test(v)) && dniValid(v) ? { score: 1 } : null;
    }, 'national_id', out);
    scan(text, /\b(bsn|burgerservicenummer)?[:\s#]*(\d{9})\b/gi, (m) => (bsnValid(m[2]!) ? { score: m[1] ? 1 : 0.6, start: m.index + m[0].length - 9 } : null), 'national_id', out);
  }
  if (want.has('phone')) {
    scan(text, /(?:\+\d{1,3}[ .-]?)?\(?\d{2,4}\)?[ .-]\d{3,4}[ .-]\d{3,4}\b/g, (m) => {
      const d = m[0].replace(/\D/g, '');
      return d.length >= 9 && d.length <= 15 ? { score: m[0].startsWith('+') ? 0.96 : 0.85 } : null;
    }, 'phone', out);
  }
  // Digit groups inside an IBAN, a card number or an identifier are not phone numbers.
  const strong = out.filter((d) => d.kind !== 'phone' && d.kind !== 'email');
  return dedupe(out.filter((d) => d.kind !== 'phone' || !strong.some((x) => x.span[0] < d.span[1] && d.span[0] < x.span[1])));
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function detectSecrets(text: string, kinds: readonly string[] = SECRET_KINDS): Detection[] {
  const want = new Set(kinds.includes('*') ? SECRET_KINDS : kinds);
  const out: Detection[] = [];
  if (want.has('private_key')) scan(text, /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g, () => ({ score: 1 }), 'private_key', out);
  if (want.has('cloud_access_key')) {
    scan(text, /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => ({ score: 0.99 }), 'cloud_access_key', out);
    scan(text, /\bAIza[0-9A-Za-z_-]{35}\b/g, () => ({ score: 0.97 }), 'cloud_access_key', out);
  }
  if (want.has('bearer_token')) {
    scan(text, /\bsk-[A-Za-z0-9_-]{20,}/g, () => ({ score: 0.98 }), 'bearer_token', out);
    scan(text, /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, () => ({ score: 0.99 }), 'bearer_token', out);
    scan(text, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, () => ({ score: 0.97 }), 'bearer_token', out);
    scan(text, /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => ({ score: 0.95 }), 'bearer_token', out);
    scan(text, /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, (m) => ({ score: 0.9, start: m.index + m[0].length - m[1]!.length }), 'bearer_token', out);
  }
  if (want.has('high_entropy')) {
    // Score is entropy / 7 bits: 0.60 at 4.2 bits per character, over tokens of 20 or more characters.
    scan(text, /[A-Za-z0-9+/=_-]{20,}/g, (m) => {
      const h = entropy(m[0]);
      return /[0-9]/.test(m[0]) && /[A-Za-z]/.test(m[0]) ? { score: Math.min(1, Math.round((h / 7) * 100) / 100) } : null;
    }, 'high_entropy', out);
  }
  return dedupe(out);
}

/** Overlapping detections of the same kind collapse to the highest-scoring one. */
function dedupe(list: Detection[]): Detection[] {
  const sorted = list.sort((a, b) => a.span[0] - b.span[0] || b.score - a.score);
  const out: Detection[] = [];
  for (const d of sorted) {
    const clash = out.find((x) => x.kind === d.kind && x.span[0] < d.span[1] && d.span[0] < x.span[1]);
    if (!clash) out.push(d);
    else if (d.score > clash.score) Object.assign(clash, d);
  }
  return out;
}
