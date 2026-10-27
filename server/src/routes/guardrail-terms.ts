import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, HttpProblem } from '../http/problem.js';
import { treeTermRefs } from '../guardrails/conditions.js';
import { checkEntries, entriesFromCsv, entriesToCsv, MAX_TERM_ENTRIES, termEntrySchema, termListSchema, type TermListRow } from '../guardrails/terms.js';
import type { Rule } from '../guardrails/rules.js';
import type { Services } from '../services.js';

const listId = z.string().length(26);

/**
 * B-156: named term lists, shared by every rule set of a tenant. They are guardrail configuration, so they sit under
 * the permission that governs rule sets, `guardrails:manage` (the Guardrail admin role, and System admin): whoever may
 * write a rule may write the lists its rules use, and nobody else reads them (a deny list can be a list of slurs).
 * Every change of the entries is a new version; CSV import has a dry run that reports duplicates and invalid rows.
 */
export function guardrailTermRoutes(s: Services): Router {
  const r = Router();
  const { sets, terms } = s.guard;
  r.use('/admin/guardrails/term-lists', noStore, requireAuth());
  const manage = requirePermission(s, 'guardrails:manage');
  const csvBody = express.text({ type: () => true, limit: '8mb' });

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };
  const load = (req: Request) => terms.get(principalOf(req).tenantId, parseBody(listId, req.params.id));

  /** Rules (in a draft or published) that refer to each list, by rule set. */
  const usage = async (tenantId: string): Promise<Map<string, { setId: string; set: string; ruleId: string; rule: string; version: number | 'latest' }[]>> => {
    const out = new Map<string, { setId: string; set: string; ruleId: string; rule: string; version: number | 'latest' }[]>();
    const add = (list: string, set: { id: string; name: string }, rule: Rule, version: number | 'latest') => {
      const xs = out.get(list) ?? [];
      if (!xs.some((x) => x.setId === set.id && x.ruleId === rule.id && x.version === version)) xs.push({ setId: set.id, set: set.name, ruleId: rule.id, rule: rule.name, version });
      out.set(list, xs);
    };
    for (const set of await sets.list(tenantId)) {
      if (set.scope === 'platform') continue;
      for (const rule of [...((await sets.draft(set.id))?.rules ?? []), ...((await sets.published(set))?.rules ?? [])]) {
        const m = rule.mechanism;
        if (m.kind === 'term-list') {
          add(m.list, set, rule, m.version);
          if (m.except) add(m.except.list, set, rule, m.except.version);
        } else if (m.kind === 'conditions') for (const ref of treeTermRefs(m.when)) add(ref.list, set, rule, ref.version);
      }
    }
    return out;
  };
  const view = (l: TermListRow, count: number | null, usedBy: unknown[] = []) => ({ id: l.id, name: l.name, description: l.description, kind: l.kind, latestVersion: l.latest_version, entries: count, usedBy, createdAt: l.created_at, updatedAt: l.updated_at });

  r.get('/admin/guardrails/term-lists', manage, async (req, res) => {
    const p = principalOf(req);
    const lists = await terms.list(p.tenantId);
    const used = await usage(p.tenantId);
    const counts = new Map(((await s.db('guard_term_list_versions as v').join('guard_term_lists as l', 'l.id', 'v.list_id').where('l.tenant_id', p.tenantId).whereRaw('v.version = l.latest_version').select('v.list_id', 'v.entry_count')) as { list_id: string; entry_count: number }[]).map((x) => [x.list_id, Number(x.entry_count)]));
    res.json(lists.map((l) => view(l, counts.get(l.id) ?? 0, used.get(l.id) ?? [])));
  });

  r.post('/admin/guardrails/term-lists', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(termListSchema.extend({ entries: z.array(termEntrySchema).max(2000).default([]), note: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    const report = checkEntries(body.entries);
    if (report.invalid.length) throw new HttpProblem(422, 'Invalid entries', `${report.invalid.length} entr${report.invalid.length === 1 ? 'y is' : 'ies are'} not valid.`, { extensions: { invalid: report.invalid } });
    const { list, version } = await terms.create(p.tenantId, { name: body.name, description: body.description ?? null, kind: body.kind }, report.entries, p.userId, body.note);
    await audit(req, 'guardrail.terms.created', { list: list.id, name: list.name }, { kind: list.kind, version: version.version, entries: version.count, duplicates: report.duplicates.length });
    res.status(201).json({ ...view(list, version.count), duplicates: report.duplicates });
  });

  r.get('/admin/guardrails/term-lists/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const list = await load(req);
    const q = parseBody(z.object({ version: z.coerce.number().int().min(1).optional() }), req.query);
    const v = await terms.version(list.id, q.version ?? list.latest_version);
    if (!v) throw new HttpProblem(404, 'Not found', `Version ${q.version} does not exist.`);
    res.json({ ...view(list, v.count, (await usage(p.tenantId)).get(list.id) ?? []), version: v.version, note: v.note, entries: v.entries, versions: await terms.versions(list.id) });
  });

  r.patch('/admin/guardrails/term-lists/:id', manage, async (req, res) => {
    const list = await load(req);
    const body = parseBody(z.object({ description: z.string().trim().max(500).nullable() }).strict(), req.body);
    const next = await terms.describe(list, body);
    await audit(req, 'guardrail.terms.updated', { list: list.id, name: list.name }, { fields: ['description'] });
    res.json(view(next, null));
  });

  /** Replaces the entries: the list's next version. */
  r.put('/admin/guardrails/term-lists/:id/entries', manage, async (req, res) => {
    const p = principalOf(req);
    const list = await load(req);
    const body = parseBody(z.object({ entries: z.array(termEntrySchema).max(5000), note: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    const report = checkEntries(body.entries);
    if (report.invalid.length) throw new HttpProblem(422, 'Invalid entries', `${report.invalid.length} entr${report.invalid.length === 1 ? 'y is' : 'ies are'} not valid.`, { extensions: { invalid: report.invalid } });
    const v = await terms.saveVersion(list, report.entries, p.userId, body.note);
    await audit(req, 'guardrail.terms.versioned', { list: list.id, name: list.name, version: v.version }, { entries: v.count, duplicates: report.duplicates.length });
    res.json({ version: v.version, entries: v.count, duplicates: report.duplicates });
  });

  /**
   * CSV import (text/csv body: a `value` column and an optional `match`, or one entry per line). `mode=replace` (the
   * default) makes the CSV the next version; `append` adds it to the latest. `dryRun=true` writes nothing and reports
   * what the version would hold, the duplicates and the invalid rows.
   */
  r.post('/admin/guardrails/term-lists/:id/import', manage, csvBody, async (req, res) => {
    const p = principalOf(req);
    const list = await load(req);
    const q = parseBody(z.object({ dryRun: z.enum(['true', 'false', '1', '0']).optional(), mode: z.enum(['replace', 'append']).default('replace'), note: z.string().trim().max(500).optional() }), req.query);
    const dryRun = q.dryRun === 'true' || q.dryRun === '1';
    if (typeof req.body !== 'string' || !req.body.trim()) throw badRequest('Send the CSV as the request body.');
    const rows = entriesFromCsv(req.body);
    const base = q.mode === 'append' ? ((await terms.version(list.id, list.latest_version))?.entries ?? []) : [];
    // Existing entries come first, so a row repeating one is reported as the duplicate (rows are numbered from 1).
    const report = checkEntries([...base, ...rows], 1 - base.length);
    const total = report.entries.length;
    const over = total > MAX_TERM_ENTRIES;
    if (dryRun) {
      res.json({ dryRun: true, mode: q.mode, rows: rows.length, entries: total, max: MAX_TERM_ENTRIES, overLimit: over, added: total - base.length, duplicates: report.duplicates.slice(0, 500), duplicateCount: report.duplicates.length, invalid: report.invalid.slice(0, 500), invalidCount: report.invalid.length });
      return;
    }
    if (report.invalid.length) throw new HttpProblem(422, 'Invalid entries', `${report.invalid.length} row${report.invalid.length === 1 ? ' is' : 's are'} not valid. Run a dry run to see them, fix the CSV, and import again.`, { extensions: { invalid: report.invalid.slice(0, 500), invalidCount: report.invalid.length } });
    const v = await terms.saveVersion(list, report.entries, p.userId, q.note ?? `CSV import (${q.mode})`);
    await audit(req, 'guardrail.terms.imported', { list: list.id, name: list.name, version: v.version }, { mode: q.mode, rows: rows.length, entries: v.count, duplicates: report.duplicates.length });
    res.status(201).json({ dryRun: false, version: v.version, entries: v.count, duplicateCount: report.duplicates.length });
  });

  r.get('/admin/guardrails/term-lists/:id/export', manage, async (req, res) => {
    const list = await load(req);
    const q = parseBody(z.object({ version: z.coerce.number().int().min(1).optional() }), req.query);
    const v = await terms.version(list.id, q.version ?? list.latest_version);
    if (!v) throw new HttpProblem(404, 'Not found', `Version ${q.version} does not exist.`);
    await audit(req, 'guardrail.terms.exported', { list: list.id, name: list.name, version: v.version }, { entries: v.count });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${list.name}-v${v.version}.csv"`);
    res.send(entriesToCsv(v.entries));
  });

  /** What a version of the list finds in a sample text, with the normalised spans. Nothing is recorded. */
  r.post('/admin/guardrails/term-lists/:id/test', manage, async (req, res) => {
    const p = principalOf(req);
    const list = await load(req);
    const body = parseBody(z.object({ text: z.string().min(1).max(100_000), version: z.union([z.literal('latest'), z.number().int().min(1)]).default('latest') }).strict(), req.body);
    const t0 = performance.now();
    const m = await terms.matcher(p.tenantId, { list: list.id, version: body.version });
    const hits = m.terms.find(body.text);
    res.json({ version: m.version, kind: list.kind, ms: Math.round((performance.now() - t0) * 100) / 100, hits: hits.map((h) => ({ entry: h.entry, match: h.match, start: h.span[0], end: h.span[1], text: body.text.slice(h.span[0], h.span[1]) })) });
  });

  r.delete('/admin/guardrails/term-lists/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const list = await load(req);
    const used = (await usage(p.tenantId)).get(list.id) ?? [];
    if (used.length) throw new HttpProblem(409, 'Term list in use', `${list.name} is used by ${used.map((u) => `${u.rule} (${u.set})`).slice(0, 5).join(', ')}. Change those rules first.`, { extensions: { usedBy: used } });
    await terms.remove(list);
    await audit(req, 'guardrail.terms.deleted', { list: list.id, name: list.name }, { versions: list.latest_version });
    res.status(204).end();
  });

  return r;
}
