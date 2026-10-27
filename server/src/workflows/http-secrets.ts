import { detectSecrets } from '../guardrails/detectors.js';
import { SECRET_FIELD, SECRET_HEADER } from '../platform/secret-names.js';
import { BODY_VAULT_REF, headerVaultRef, queryVaultRef } from './graph.js';

/*
 * 1.7.0 (B-9102, VLT-9): credentials never sit in a workflow graph. Every header, query parameter and body field of
 * an HTTP step whose name says it carries a credential takes a vault reference, resolved when the step runs as the
 * run's principal under the vault policies:
 *
 * - a header: `vault:path#key`, optionally after Bearer, Basic or Token (as Authorization since B-1705);
 * - a query parameter: under `query`, `vault:path#key`; a credential in the URL's own query string is refused;
 * - a body field: `{vault:path#key}` as the whole value, optionally after Bearer, Basic or Token.
 *
 * A value that looks like a credential whatever its name (a private key, a cloud access key, a provider token, a JWT)
 * is refused too. The check runs when a workflow is created, saved, published or imported from a bundle; it is not
 * part of the graph schema, so a version stored before the rule still loads and runs.
 */

const LOOKS = ['private_key', 'cloud_access_key', 'bearer_token'] as const;
const KIND_NAMES: Record<string, string> = { private_key: 'a private key', cloud_access_key: 'a cloud access key', bearer_token: 'a token' };
const REF_HINT = 'Store it in the vault and reference it';
const BODY_SECRET_OK = /^((?:Bearer|Basic|Token) )?\{vault:[^{}\s]+\}$/;

/** What a literal value looks like when it is a credential by its shape, or null. */
function looksLike(value: string): string | null {
  const d = detectSecrets(value, LOOKS)[0];
  return d ? (KIND_NAMES[d.kind] ?? 'a credential') : null;
}

const decode = (x: string): string => {
  try {
    return decodeURIComponent(x.replace(/\+/g, ' '));
  } catch {
    return x;
  }
};

/** The names of the parameters in a URL's own query string (the URL may hold `{{…}}` templates). */
function urlQueryNames(url: string): string[] {
  const q = url.indexOf('?');
  if (q < 0) return [];
  return url
    .slice(q + 1)
    .split('#')[0]!
    .split('&')
    .map((pair) => decode(pair.split('=')[0] ?? '').trim())
    .filter(Boolean);
}

/** The credential-named fields of a body template with a value that is not a vault reference. */
function bodyLiteral(body: string): string | null {
  const text = body.trim();
  if (/^[{[]/.test(text)) {
    // JSON, possibly with unquoted {{…}} templates, so it is scanned, not parsed.
    for (const m of text.matchAll(/"((?:[^"\\]|\\.){1,200})"\s*:\s*("(?:[^"\\]|\\.)*"|\{\{[^}]*\}\}|\{vault:[^{}\s]+\}|[{[]|[^\s,}\]{["]+)/g)) {
      const name = m[1]!;
      const raw = m[2]!;
      if (!SECRET_FIELD.test(name)) continue;
      // Nothing there, or a nested object or list, whose own fields are checked as the scan reaches them.
      if (raw === 'null' || raw === '[' || raw === '{') continue;
      let value = raw;
      if (raw.startsWith('"')) {
        try {
          value = JSON.parse(raw) as string;
        } catch {
          value = raw.slice(1, -1);
        }
      }
      if (!BODY_SECRET_OK.test(value)) return name;
    }
    return null;
  }
  if (/^[^=&\s]+=/.test(text) && !/\n/.test(text)) {
    for (const pair of text.split('&')) {
      const i = pair.indexOf('=');
      const name = decode(i < 0 ? pair : pair.slice(0, i)).trim();
      const value = i < 0 ? '' : pair.slice(i + 1);
      if (name && SECRET_FIELD.test(name) && value !== '' && !BODY_SECRET_OK.test(decode(value))) return name;
    }
  }
  return null;
}

/** Why an HTTP step of the graph would store a credential, or null when none would. */
export function literalSecret(g: { nodes: { id?: string; kind: string; title?: string; config: unknown }[] }): string | null {
  return literalSecretIssue(g)?.message ?? null;
}

/** The same with the step it is about, for the editor's list of problems. */
export function literalSecretIssue(g: { nodes: { id?: string; kind: string; title?: string; config: unknown }[] }): { nodeId?: string; message: string } | null {
  for (const n of g.nodes) {
    if (n.kind !== 'http') continue;
    const message = stepLiteral(n);
    if (message) return { ...(n.id ? { nodeId: n.id } : {}), message };
  }
  return null;
}

function stepLiteral(n: { kind: string; title?: string; config: unknown }): string | null {
  const title = n.title ?? 'An HTTP step';
  const c = (n.config ?? {}) as { url?: unknown; headers?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
  for (const [k, v] of Object.entries(c.headers ?? {})) {
    const ref = typeof v === 'string' && headerVaultRef(v);
    if (ref) continue;
    if (k.toLowerCase() === 'authorization') return `${title}: Authorization takes a vault reference (vault:path#key, optionally after Bearer, Basic or Token), never a literal credential.`;
    if (SECRET_HEADER.test(k)) return `${title}: the header ${k} carries a credential and takes a vault reference (vault:path#key, optionally after Bearer, Basic or Token), never a literal value.`;
    const looks = typeof v === 'string' ? looksLike(v) : null;
    if (looks) return `${title}: the header ${k} holds what looks like ${looks}. ${REF_HINT} (vault:path#key).`;
  }
  const url = typeof c.url === 'string' ? c.url : '';
  const inUrl = urlQueryNames(url).find((name) => SECRET_FIELD.test(name));
  if (inUrl) return `${title}: the query parameter ${inUrl} carries a credential. Take it out of the URL and add it under Query parameters as a vault reference (vault:path#key).`;
  const urlLooks = looksLike(url);
  if (urlLooks) return `${title}: the URL holds what looks like ${urlLooks}. ${REF_HINT} under Query parameters (vault:path#key).`;
  for (const [k, v] of Object.entries(c.query ?? {})) {
    if (typeof v === 'string' && queryVaultRef(v)) continue;
    if (SECRET_FIELD.test(k)) return `${title}: the query parameter ${k} carries a credential and takes a vault reference (vault:path#key), never a literal value.`;
    const looks = typeof v === 'string' ? looksLike(v) : null;
    if (looks) return `${title}: the query parameter ${k} holds what looks like ${looks}. ${REF_HINT} (vault:path#key).`;
  }
  if (typeof c.body === 'string' && c.body) {
    const field = bodyLiteral(c.body);
    if (field) return `${title}: the body field ${field} carries a credential and takes a vault reference ({vault:path#key} as its whole value, optionally after Bearer, Basic or Token), never a literal value.`;
    const looks = looksLike(c.body.replace(BODY_VAULT_REF, ''));
    if (looks) return `${title}: the body holds what looks like ${looks}. ${REF_HINT} ({vault:path#key}).`;
  }
  return null;
}
