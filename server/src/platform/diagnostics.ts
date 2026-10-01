/*
 * B-907 (ASVS 7.4.1): diagnostic messages from drivers, directories, workers and hooks are shown to admins and kept
 * in health details and the audit trail. Before they leave the server they are scrubbed of secrets: the values the
 * caller knows are secret (a connection's password, a token), credentials in URLs, `key=value` pairs whose key names a
 * secret, bearer and basic authorization values, and private-key blocks.
 */

const MASK = '********';

// `key=value` for any secret-looking key; `key: value` only for keys that cannot start a sentence ("token: expired").
const KEY_EQ = /\b((?:password|passwd|pwd|pass|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|private[_-]?key|sslpassword|sslkey)\s*=\s*)("[^"]*"|'[^']*'|[^\s,;&)"']+)/gi;
const KEY_COLON = /(["']?\b(?:password|passwd|pwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|private[_-]?key)["']?\s*:\s*)("[^"]*"|'[^']*'|[^\s,;&)"'}]+)/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi;
const AUTH_HEADER = /\b(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]+/gi;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi;
const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Masks secrets in a diagnostic message. `secrets` are exact values to mask wherever they appear (4+ characters). */
export function scrubSecrets(message: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = String(message);
  for (const v of secrets) {
    if (!v || v.length < 4) continue;
    out = out.replace(new RegExp(escape(v), 'g'), MASK);
    const enc = encodeURIComponent(v);
    if (enc !== v) out = out.replace(new RegExp(escape(enc), 'g'), MASK);
  }
  return out
    .replace(PEM_KEY, `-----PRIVATE KEY ${MASK}-----`)
    .replace(URL_USERINFO, (_m, scheme: string, user: string) => `${scheme}${user}:${MASK}@`)
    .replace(AUTH_HEADER, (_m, p: string) => `${p}${MASK}`)
    .replace(BEARER, (_m, p: string) => `${p}${MASK}`)
    .replace(KEY_EQ, (_m, k: string) => `${k}${MASK}`)
    .replace(KEY_COLON, (_m, k: string) => `${k}${MASK}`);
}

/** Scrubs an error's message (for `err.message` in catch blocks). */
export const scrubError = (err: unknown, secrets: readonly (string | null | undefined)[] = []): string => scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
