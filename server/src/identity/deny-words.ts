import { CompiledTerms, normalise, normaliseEntry, joined } from '../guardrails/term-match.js';
import { badRequest } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 55 (B-194): tenant deny words, `s.passwordDenyWords`.
 *
 * A short list of words a tenant forbids inside passwords (its name, products, places). The words are the tenant's
 * setting (`leaked_password_settings.deny_words`), optionally joined by one of its guardrail term lists (B-156,
 * `deny_term_list`, read at its latest version), and matched with B-156's normaliser (`guardrails/term-match.ts`):
 * case, accents, compatibility forms, Cyrillic and Greek lookalikes and leetspeak are folded on both sides, so
 * "Acme" also refuses "@CM3", "ácme" and "Аcme". A word matches anywhere inside the password: after the normalised
 * reading, the reading with spaced-out letters joined ("a c m e"), and the reading with every separator removed
 * ("ac-me", "ac.me"). Entries shorter than three characters after normalisation are ignored, so a stray "a" cannot
 * refuse everything. The matched word may be shown: it is the tenant's own word, not a secret.
 *
 * No settings (or the migration not applied yet) means no deny words: today's behaviour.
 */

export const MAX_DENY_WORDS = 200;
export const MIN_DENY_SKELETON = 3;
const CACHE_MS = 15_000;

export interface DenyWordResult {
  found: boolean;
  term?: string;
}

/** The words to compile: entries kept as written (for the answer), compared by their skeleton. */
export function compileDenyWords(words: string[]): CompiledTerms | null {
  const usable = words.map((w) => w.trim()).filter((w) => normaliseEntry(w).replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_DENY_SKELETON);
  if (!usable.length) return null;
  // Separators inside an entry are dropped too, so "Acme Corp" matches "acmecorp1!" as well as "acme corp".
  const entries = usable.flatMap((value) => {
    const bare = normaliseEntry(value).replace(/[^\p{L}\p{N}]/gu, '');
    return [{ value, match: 'substring' as const }, ...(bare !== normaliseEntry(value) ? [{ value: bare, match: 'substring' as const }] : [])];
  });
  return new CompiledTerms(entries);
}

/** The first deny word found in a password, as the tenant wrote it. */
export function findDenyWord(compiled: CompiledTerms | null, words: string[], password: string): string | null {
  if (!compiled) return null;
  const first = normalise(password);
  const readings = [password, joined(first)?.text ?? null, first.text.replace(/[^\p{L}\p{N}]/gu, '')].filter((x): x is string => !!x);
  for (const text of readings) {
    const hits = compiled.find(text, 1);
    if (hits.length) {
      const hit = hits[0]!.entry;
      // A bare (separator-free) entry answers with the word it came from.
      return words.find((w) => w.trim() === hit) ?? words.find((w) => normaliseEntry(w).replace(/[^\p{L}\p{N}]/gu, '') === hit) ?? hit;
    }
  }
  return null;
}

export class PasswordDenyWords {
  private readonly cache = new Map<string, { at: number; words: string[]; compiled: CompiledTerms | null }>();

  constructor(private readonly s: () => Services) {}

  /** Drops a tenant's compiled words (its settings or its term list changed). */
  forget(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  /** The tenant's deny words: its own setting plus the entries of the term list it names (latest version). */
  async words(tenantId: string): Promise<string[]> {
    return (await this.compiled(tenantId)).words;
  }

  private async compiled(tenantId: string): Promise<{ words: string[]; compiled: CompiledTerms | null }> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const settings = await this.s().leakedPasswords.settings(tenantId);
    const words = [...settings.denyWords];
    if (settings.denyTermList) {
      try {
        const m = await this.s().guard.terms.get(tenantId, settings.denyTermList);
        const v = await this.s().guard.terms.version(m.id, m.latest_version);
        for (const e of v?.entries ?? []) if (e.match !== 'domain') words.push(e.value);
      } catch {
        // A deleted term list leaves the tenant's own words.
      }
    }
    const out = { at: Date.now(), words, compiled: compileDenyWords(words) };
    this.cache.set(tenantId, out);
    return out;
  }

  /** Whether a password contains one of the tenant's deny words, and which one. */
  async check(tenantId: string, password: string): Promise<DenyWordResult> {
    const { words, compiled } = await this.compiled(tenantId);
    const term = findDenyWord(compiled, words, password);
    return term ? { found: true, term } : { found: false };
  }

  /** `check`, throwing a 400 `deny_word` problem naming the word (it is the tenant's own word, not a secret). */
  async assertAllowed(tenantId: string, password: string): Promise<void> {
    const r = await this.check(tenantId, password);
    if (r.found) throw badRequest(`The password must not contain "${r.term}", a word this organisation does not allow in passwords.`, { reason: 'deny_word', term: r.term });
  }
}
