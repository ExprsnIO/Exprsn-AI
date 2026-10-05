import { DavError } from './xml.js';

/*
 * The If header (RFC 4918 10.4): lists of conditions on ETags and lock tokens, optionally tagged with the resource
 * they apply to. handler.ts evaluates them (a request whose lists all fail is 412); the tokens named positively are
 * what a request submits for the lock checks of the file store (B-32).
 */

export interface IfCondition {
  not: boolean;
  token?: string;
  etag?: string;
}

export interface IfList {
  /** The tagged resource (an absolute path), or null for the request URL. */
  resource: string | null;
  conditions: IfCondition[];
}

/** Parses an If header into its lists; a malformed header is a 400. */
export function parseIf(h: string | undefined): IfList[] {
  if (!h) return [];
  const out: IfList[] = [];
  let i = 0;
  let tag: string | null = null;
  const s = h.trim();
  const fail = () => new DavError(400, 'The If header is malformed.');
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '<') {
      const end = s.indexOf('>', i);
      if (end < 0) throw fail();
      const url = s.slice(i + 1, end);
      try {
        tag = decodeURI(new URL(url, 'http://x').pathname).replace(/\/+$/, '');
      } catch {
        throw fail();
      }
      i = end + 1;
      continue;
    }
    if (c !== '(') throw fail();
    const end = s.indexOf(')', i);
    if (end < 0) throw fail();
    const body = s.slice(i + 1, end);
    const conditions: IfCondition[] = [];
    const re = /\s*(Not\s+)?(?:<([^>]*)>|\[(W\/)?"([^"]*)"\])/giy;
    let m: RegExpExecArray | null;
    let pos = 0;
    re.lastIndex = 0;
    while (pos < body.length && (m = re.exec(body))) {
      conditions.push({ not: !!m[1], ...(m[2] !== undefined ? { token: m[2] } : { etag: m[4]! }) });
      pos = re.lastIndex;
    }
    if (body.slice(pos).trim() || !conditions.length) throw fail();
    out.push({ resource: tag, conditions });
    i = end + 1;
  }
  return out;
}

/** Every lock token named in an If header (positively), for the lock checks. */
export const submittedTokens = (lists: IfList[]): Set<string> => new Set(lists.flatMap((l) => l.conditions.filter((c) => !c.not && c.token).map((c) => c.token!)));
