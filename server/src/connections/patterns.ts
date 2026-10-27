/*
 * 1.9.0: allow-list patterns for engines whose objects are not tables: Redis key patterns, RabbitMQ queues,
 * Prometheus metrics and InfluxDB measurements. An entry is a name or a glob with `*` (any run of characters) and `?`
 * (one character). A concrete name is allowed when an entry matches it. A pattern the caller asks for (a SCAN MATCH,
 * a metric regex already reduced to a glob) is allowed only when it can match nothing an entry does not: it equals an
 * entry, or it is the entry's literal prefix followed by more pattern (`session:*` allows `session:42:*`).
 */

const escape = (x: string) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** A glob as an anchored regular expression. */
export function globRegExp(glob: string): RegExp {
  return new RegExp('^' + [...glob].map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : escape(ch))).join('') + '$', 's');
}

export const hasGlob = (x: string): boolean => /[*?[]/.test(x);

/** Whether a concrete name or a pattern is covered by the allow-list (names compare exactly: keys are case-sensitive). */
export function allowedPattern(object: string, allow: readonly string[]): boolean {
  if (!object) return false;
  if (!hasGlob(object)) return allow.some((a) => a === object || (hasGlob(a) && globRegExp(a).test(object)));
  return allow.some((a) => {
    if (a === object) return true;
    if (!hasGlob(a)) return false;
    // `prefix*` entries cover any pattern that starts with the same literal prefix (and needs no more than the entry).
    const star = a.indexOf('*');
    if (star !== a.length - 1 || /[?]/.test(a)) return false;
    const prefix = a.slice(0, -1);
    const lead = object.search(/[*?[]/);
    return object.slice(0, lead < 0 ? object.length : lead).startsWith(prefix);
  });
}
