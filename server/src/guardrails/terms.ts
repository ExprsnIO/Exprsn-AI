import { ulid } from 'ulid';
import { z } from 'zod';
import { json, type Db } from '../db/knex.js';
import { isUniqueViolation } from '../audit/chain.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import { parseCsv } from '../identity/user-import.js';
import type { Bus } from '../platform/bus.js';
import { CompiledTerms, hostSkeleton, normaliseEntry, type TermEntry, type TermMatch } from './term-match.js';

/*
 * B-156: named term lists. A list belongs to a tenant and is shared by every rule set of it; its kind (`deny` or
 * `allow`) is fixed when it is made. Its entries are versioned: every change of the entries is a new, immutable
 * version, so a rule pinned to version 3 keeps meaning what it meant, and `latest` follows the newest. A version is
 * compiled once into a matcher (`term-match.ts`) and kept in a small cache by list and version; nothing about a
 * version changes after it is written, so the cache needs no invalidation, only `latest` does (on the bus).
 */

export const MAX_TERM_ENTRIES = 50_000;
export const TERM_MATCHES = ['word', 'substring', 'domain'] as const;
export const TERMS_CHANGED = 'guardrails.terms.changed';
const COMPILED_CACHE = 8;
const LATEST_MS = 15_000;

export interface TermListRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  kind: 'deny' | 'allow';
  latest_version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface TermVersionRow {
  id: string;
  list_id: string;
  version: number;
  entries: TermEntry[];
  count: number;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

const listFrom = (r: Record<string, unknown>): TermListRow => ({ ...(r as unknown as TermListRow), latest_version: Number(r.latest_version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const versionFrom = (r: Record<string, unknown>): TermVersionRow => ({ ...(r as unknown as TermVersionRow), version: Number(r.version), count: Number(r.entry_count), entries: json<TermEntry[]>(r.entries, []), created_at: Number(r.created_at) });

export const termEntrySchema = z.object({ value: z.string().trim().min(1).max(200), match: z.enum(TERM_MATCHES).default('word') }).strict();
export const termListSchema = z.object({ name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lower-case letters, digits and hyphens'), description: z.string().trim().max(500).nullable().optional(), kind: z.enum(['deny', 'allow']) }).strict();
/** A reference from a rule to a list: by id, and `latest` or a pinned version. */
export const termRefSchema = z.object({ list: z.string().length(26), version: z.union([z.literal('latest'), z.number().int().min(1)]).default('latest') }).strict();
export type TermRef = z.infer<typeof termRefSchema>;

const DOMAIN = /^(?=.{1,253}$)(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63}$/u;

/** What a dry run (or an import) found in the proposed entries. */
export interface EntryReport {
  entries: TermEntry[];
  duplicates: { row: number; value: string; match: TermMatch; firstRow: number }[];
  invalid: { row: number; value: string; reason: string }[];
}

/**
 * Checks and de-duplicates entries: a domain must be a host name (a leading `*.` is dropped; subdomains match anyway),
 * words and phrases must keep something after normalisation, and two entries are duplicates when they normalise to
 * the same thing with the same way of matching ("Spam" and "SP4M" are one entry). Rows are numbered from 1.
 */
export function checkEntries(raw: { value: string; match?: string }[], firstRow = 1): EntryReport {
  const entries: TermEntry[] = [];
  const duplicates: EntryReport['duplicates'] = [];
  const invalid: EntryReport['invalid'] = [];
  const seen = new Map<string, number>();
  raw.forEach((r, i) => {
    const row = i + firstRow;
    const value = String(r.value ?? '').trim();
    const match = (r.match ?? 'word').trim().toLowerCase() || 'word';
    if (!(TERM_MATCHES as readonly string[]).includes(match)) return void invalid.push({ row, value, reason: `match must be word, substring or domain, not ${match}` });
    if (!value) return void invalid.push({ row, value, reason: 'empty' });
    if (value.length > 200) return void invalid.push({ row, value: value.slice(0, 60), reason: 'longer than 200 characters' });
    let v = value;
    if (match === 'domain') {
      v = value.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '').replace(/\.$/, '');
      if (!DOMAIN.test(v)) return void invalid.push({ row, value, reason: 'not a domain name' });
    }
    const key = `${match}:${match === 'domain' ? hostSkeleton(v) : normaliseEntry(v)}`;
    if (key === `${match}:`) return void invalid.push({ row, value, reason: 'nothing left to match after normalisation' });
    const first = seen.get(key);
    if (first !== undefined) return void duplicates.push({ row, value, match: match as TermMatch, firstRow: first });
    seen.set(key, row);
    entries.push({ value: v, match: match as TermMatch });
  });
  return { entries, duplicates, invalid };
}

/** CSV with a header naming `value` (or `term`) and optionally `match`; without a header, one entry per line. */
export function entriesFromCsv(text: string): { value: string; match?: string }[] {
  const rows = parseCsv(text, MAX_TERM_ENTRIES + 1);
  if (!rows.length) return [];
  const head = rows[0]!.map((c) => c.trim().toLowerCase());
  const vi = head.findIndex((c) => c === 'value' || c === 'term' || c === 'entry');
  if (vi < 0) return rows.map((r) => ({ value: r[0] ?? '', ...(r[1] !== undefined ? { match: r[1] } : {}) }));
  const mi = head.indexOf('match');
  return rows.slice(1).map((r) => ({ value: r[vi] ?? '', ...(mi >= 0 && r[mi] !== undefined ? { match: r[mi] } : {}) }));
}

const cell = (s: string) => (/[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${(/^[=+\-@\t]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s);
export const entriesToCsv = (entries: TermEntry[]): string => ['value,match', ...entries.map((e) => `${cell(e.value)},${e.match}`)].join('\r\n') + '\r\n';

export class TermListService {
  private readonly compiled = new Map<string, CompiledTerms>();
  private readonly latest = new Map<string, { at: number; version: number | null }>();

  constructor(
    private readonly db: Db,
    private readonly bus: Bus
  ) {
    bus.on<{ listId: string | null }>(TERMS_CHANGED, ({ listId }) => {
      if (listId) this.latest.delete(listId);
      else this.latest.clear();
    });
  }

  async list(tenantId: string): Promise<TermListRow[]> {
    return ((await this.db('guard_term_lists').where({ tenant_id: tenantId }).orderBy('name')) as Record<string, unknown>[]).map(listFrom);
  }

  async get(tenantId: string, id: string): Promise<TermListRow> {
    const r = await this.db('guard_term_lists').where({ id, tenant_id: tenantId }).first();
    if (!r) throw notFound('Term list');
    return listFrom(r);
  }

  async versions(listId: string): Promise<Omit<TermVersionRow, 'entries'>[]> {
    return ((await this.db('guard_term_list_versions').where({ list_id: listId }).orderBy('version', 'desc').select('id', 'list_id', 'version', 'entry_count', 'note', 'created_by', 'created_at')) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), list_id: String(r.list_id), note: (r.note as string | null) ?? null, created_by: (r.created_by as string | null) ?? null, version: Number(r.version), count: Number(r.entry_count), created_at: Number(r.created_at) }));
  }

  async version(listId: string, version: number): Promise<TermVersionRow | undefined> {
    const r = await this.db('guard_term_list_versions').where({ list_id: listId, version }).first();
    return r ? versionFrom(r) : undefined;
  }

  async create(tenantId: string, input: z.infer<typeof termListSchema>, entries: TermEntry[], by: string, note?: string | null): Promise<{ list: TermListRow; version: TermVersionRow }> {
    if (entries.length > MAX_TERM_ENTRIES) throw tooMany(entries.length);
    const t = Date.now();
    const list: TermListRow = { id: ulid(), tenant_id: tenantId, name: input.name, description: input.description ?? null, kind: input.kind, latest_version: 1, created_by: by, created_at: t, updated_at: t };
    const version: TermVersionRow = { id: ulid(), list_id: list.id, version: 1, entries, count: entries.length, note: note ?? null, created_by: by, created_at: t };
    try {
      await this.db.transaction(async (trx) => {
        await trx('guard_term_lists').insert(list);
        await trx('guard_term_list_versions').insert(versionRow(version));
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A term list named ${input.name} exists.`);
      throw err;
    }
    return { list, version };
  }

  async describe(list: TermListRow, patch: { description?: string | null }): Promise<TermListRow> {
    const t = Date.now();
    await this.db('guard_term_lists').where({ id: list.id }).update({ ...(patch.description !== undefined ? { description: patch.description } : {}), updated_at: t });
    return { ...list, ...(patch.description !== undefined ? { description: patch.description } : {}), updated_at: t };
  }

  /** Writes the entries as the list's next version. */
  async saveVersion(list: TermListRow, entries: TermEntry[], by: string, note?: string | null): Promise<TermVersionRow> {
    if (entries.length > MAX_TERM_ENTRIES) throw tooMany(entries.length);
    const t = Date.now();
    const next = list.latest_version + 1;
    const v: TermVersionRow = { id: ulid(), list_id: list.id, version: next, entries, count: entries.length, note: note ?? null, created_by: by, created_at: t };
    try {
      await this.db.transaction(async (trx) => {
        await trx('guard_term_list_versions').insert(versionRow(v));
        const n = await trx('guard_term_lists').where({ id: list.id, latest_version: list.latest_version }).update({ latest_version: next, updated_at: t });
        if (!n) throw conflict('Someone else changed this term list at the same time. Reload it.');
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Someone else changed this term list at the same time. Reload it.');
      throw err;
    }
    this.bus.publish(TERMS_CHANGED, { listId: list.id });
    return v;
  }

  async remove(list: TermListRow): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx('guard_term_list_versions').where({ list_id: list.id }).delete();
      await trx('guard_term_lists').where({ id: list.id }).delete();
    });
    this.bus.publish(TERMS_CHANGED, { listId: list.id });
  }

  // ---------- matching ----------

  private async latestOf(tenantId: string, listId: string): Promise<number | null> {
    const hit = this.latest.get(listId);
    if (hit && Date.now() - hit.at < LATEST_MS) return hit.version;
    const r = (await this.db('guard_term_lists').where({ id: listId, tenant_id: tenantId }).first('latest_version')) as { latest_version: number } | undefined;
    const version = r ? Number(r.latest_version) : null;
    this.latest.set(listId, { at: Date.now(), version });
    return version;
  }

  /** The compiled matcher of a referenced version, with the list's kind. Throws when the list or version is gone. */
  async matcher(tenantId: string, ref: TermRef): Promise<{ list: { id: string; name: string; kind: 'deny' | 'allow' }; version: number; terms: CompiledTerms }> {
    const version = ref.version === 'latest' ? await this.latestOf(tenantId, ref.list) : ref.version;
    if (version == null) throw new Error(`term list ${ref.list} does not exist`);
    const row = (await this.db('guard_term_lists').where({ id: ref.list, tenant_id: tenantId }).first('id', 'name', 'kind')) as { id: string; name: string; kind: 'deny' | 'allow' } | undefined;
    if (!row) throw new Error(`term list ${ref.list} does not exist`);
    const key = `${ref.list}@${version}`;
    let terms = this.compiled.get(key);
    if (!terms) {
      const v = await this.version(ref.list, version);
      if (!v) throw new Error(`term list ${row.name} has no version ${version}`);
      terms = new CompiledTerms(v.entries);
      if (this.compiled.size >= COMPILED_CACHE) this.compiled.delete(this.compiled.keys().next().value!);
      this.compiled.set(key, terms);
    } else {
      // Most recently used last.
      this.compiled.delete(key);
      this.compiled.set(key, terms);
    }
    return { list: row, version, terms };
  }

  /** Refuses references to lists or versions the tenant does not have (a rule is saved only if it can run). */
  async checkRefs(tenantId: string | null, refs: { ruleId: string; ref: TermRef }[]): Promise<void> {
    for (const { ruleId, ref } of refs) {
      if (!tenantId) throw new HttpProblem(422, 'Invalid rule', `${ruleId}: the platform baseline cannot use a term list; term lists belong to a tenant.`, { extensions: { ruleId } });
      const row = (await this.db('guard_term_lists').where({ id: ref.list, tenant_id: tenantId }).first('latest_version', 'name')) as { latest_version: number; name: string } | undefined;
      if (!row) throw new HttpProblem(422, 'Invalid rule', `${ruleId}: the term list ${ref.list} does not exist.`, { extensions: { ruleId, list: ref.list } });
      if (ref.version !== 'latest' && ref.version > Number(row.latest_version)) throw new HttpProblem(422, 'Invalid rule', `${ruleId}: the term list ${row.name} has no version ${ref.version}.`, { extensions: { ruleId, list: ref.list } });
    }
  }
}

const versionRow = (v: TermVersionRow) => ({ id: v.id, list_id: v.list_id, version: v.version, entries: JSON.stringify(v.entries), entry_count: v.count, note: v.note, created_by: v.created_by, created_at: v.created_at });
const tooMany = (n: number) => new HttpProblem(422, 'Too many entries', `A term list holds at most ${MAX_TERM_ENTRIES.toLocaleString('en')} entries; this one has ${n.toLocaleString('en')}.`, { extensions: { max: MAX_TERM_ENTRIES, count: n } });
