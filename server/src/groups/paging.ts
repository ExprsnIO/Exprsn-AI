import { badRequest } from '../http/problem.js';

/*
 * 1.7.0 (B-9704): search and paging on groups, members and attendees.
 *
 * A page is asked for with `limit` (and then `cursor`, the `next` of the page before). Pages are cut by keyset, never
 * by offset: the cursor names the last row of a page by its sort key and its id, so a row that joins or leaves between
 * two requests neither repeats nor skips its neighbours, and the order is the same on every database. A list asked
 * for without `limit` and `cursor` answers as it did before 1.7.0 (an array).
 */

export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 50;

export interface PageQuery {
  q?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}
export interface Page<T> {
  items: T[];
  /** The cursor of the next page, or null on the last one. */
  next: string | null;
  /** How many rows match the search in all. */
  total: number;
}

export const paged = (q: PageQuery): boolean => q.limit !== undefined || q.cursor !== undefined;
export const pageSize = (q: PageQuery): number => Math.min(Math.max(1, q.limit ?? DEFAULT_PAGE), MAX_PAGE);

export const encodeCursor = (parts: (string | number)[]): string => Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');

/** The parts of a cursor this server made; anything else is a 400. */
export function decodeCursor<T extends readonly ('string' | 'number')[]>(cursor: string, shape: T): { [K in keyof T]: T[K] extends 'number' ? number : string } {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === shape.length && v.every((x, i) => typeof x === shape[i] && (typeof x !== 'number' || Number.isFinite(x)))) return v as never;
  } catch {
    // falls through
  }
  throw badRequest('cursor is not one this list returned.');
}

/** A search term as a LIKE pattern over lower-cased text, with the wildcards taken out of what was typed. */
export const likeOf = (q: string | undefined): string | null => {
  const t = (q ?? '').trim().toLowerCase().replace(/[%_\\]/g, '');
  return t ? `%${t}%` : null;
};

/** Code-point order, the same on every database and in every process (a collation is neither). */
export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
