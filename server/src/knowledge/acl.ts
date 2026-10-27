import type { Db } from '../db/knex.js';
import { json } from '../db/knex.js';
import type { Principal } from '../authz/policy.js';

/*
 * Row-level access for database knowledge sources (B-1002). A source may name an access column: each row's value
 * lists the directory groups (or the users) allowed to retrieve it. The list travels with the row onto its document
 * and every chunk (`acl`, JSON), and retrieval drops chunks whose list does not name the reader. Entries are kept as
 * `g:<group>` or `u:<user>`, lower-cased. A row whose access value is empty is retrievable by nobody (fail closed).
 */

export type AccessKind = 'group' | 'user';

/**
 * The entries in an access column value: a JSON array, a PostgreSQL array literal (`{a,b}`), or a list separated by
 * commas, semicolons or new lines. Entries are trimmed and lower-cased; empty ones are dropped.
 */
export function parseAccessValue(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  let s = String(v).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const a = JSON.parse(s) as unknown;
      if (Array.isArray(a)) return parseAccessValue(a);
    } catch {
      // not JSON: read it as a list
    }
  }
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  return [...new Set(s.split(/[,;\n]/).map((x) => x.trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase()).filter(Boolean))];
}

/** The access list stored for a row: its entries with the kind's prefix. */
export function rowAcl(kind: AccessKind, value: unknown): string[] {
  const p = kind === 'group' ? 'g:' : 'u:';
  return parseAccessValue(value).map((x) => p + x);
}

/** A stored `acl` column: null means no row-level list (the base's access alone decides). */
export const readAcl = (v: unknown): string[] | null => {
  if (v == null || v === '') return null;
  const a = json<unknown>(v, null);
  return Array.isArray(a) ? a.map(String) : [];
};

/** Whether a reader's entries meet a stored list. */
export const aclAllows = (acl: string[] | null, reader: ReadonlySet<string>): boolean => acl == null || acl.some((x) => reader.has(x));

/**
 * The entries a principal matches: every directory group from the user's identities (as of their last sign-in or
 * directory sync) and the user's id, username and email.
 */
export async function readerEntries(db: Db, p: Pick<Principal, 'userId' | 'username'>): Promise<Set<string>> {
  const out = new Set<string>();
  const user = (await db('users').where({ id: p.userId }).first('id', 'username', 'email')) as { id: string; username: string; email: string | null } | undefined;
  for (const u of [p.userId, p.username, user?.username, user?.email]) if (u) out.add(`u:${String(u).toLowerCase()}`);
  const ids = (await db('user_identities').where({ user_id: p.userId }).select('groups')) as { groups: string }[];
  for (const r of ids) for (const g of json<unknown[]>(r.groups, [])) if (g != null && String(g).trim()) out.add(`g:${String(g).trim().toLowerCase()}`);
  return out;
}
