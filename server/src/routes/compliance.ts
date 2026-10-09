import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { dlpPatternInputSchema, dlpRuleInputSchema, DLP_SCOPES, BUILTIN_DETECTORS, patternView, ruleView } from '../compliance/dlp.js';
import { exportInputSchema, exportView } from '../compliance/exports.js';
import { HOLD_SCOPES } from '../compliance/holds.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);

/*
 * Compliance (1.6.0, Sprint 38c): DLP rules and patterns, legal holds and compliance exports.
 * `compliance:manage` keeps DLP and holds (holds under dual control); `compliance:export` requests and downloads
 * exports, as a person or as an API key scoped to it.
 */
export function complianceRoutes(s: Services): Router {
  const r = Router();
  r.use('/compliance', noStore, requireAuth());
  const manage = requirePermission(s, 'compliance:manage');
  const exporter = requirePermission(s, 'compliance:export');
  const ctx = (req: Request) => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId });

  // ---------- DLP (B-7601) ----------

  r.get('/compliance/dlp', manage, async (req, res) => {
    const p = principalOf(req);
    const [rules, patterns] = await Promise.all([s.dlp.rules(p.tenantId), s.dlp.patterns(p.tenantId)]);
    res.json({ rules: rules.map(ruleView), patterns: patterns.map(patternView), detectors: [...BUILTIN_DETECTORS], scopes: [...DLP_SCOPES], labels: [...LABELS] });
  });

  r.post('/compliance/dlp/rules', manage, async (req, res) => {
    res.status(201).json(ruleView(await s.dlp.createRule(principalOf(req), ip(req), parseBody(dlpRuleInputSchema, req.body))));
  });

  r.put('/compliance/dlp/rules/:id', manage, async (req, res) => {
    res.json(ruleView(await s.dlp.updateRule(principalOf(req), ip(req), parseBody(id26, req.params.id), parseBody(dlpRuleInputSchema, req.body))));
  });

  r.delete('/compliance/dlp/rules/:id', manage, async (req, res) => {
    await s.dlp.removeRule(principalOf(req), ip(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.post('/compliance/dlp/patterns', manage, async (req, res) => {
    res.status(201).json(patternView(await s.dlp.createPattern(principalOf(req), ip(req), parseBody(dlpPatternInputSchema, req.body))));
  });

  r.put('/compliance/dlp/patterns/:id', manage, async (req, res) => {
    res.json(patternView(await s.dlp.updatePattern(principalOf(req), ip(req), parseBody(id26, req.params.id), parseBody(dlpPatternInputSchema, req.body))));
  });

  r.delete('/compliance/dlp/patterns/:id', manage, async (req, res) => {
    await s.dlp.removePattern(principalOf(req), ip(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  /** Tries the tenant's rules on a text: what fires, the label and the redacted text. Nothing is stored or audited. */
  r.post('/compliance/dlp/test', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ text: z.string().min(1).max(200_000), scope: z.enum(DLP_SCOPES).default('answer'), label: z.enum(LABELS).default('internal') }).strict(), req.body);
    const out = await s.dlp.inspect({ tenantId: p.tenantId, text: body.text, scope: body.scope, label: body.label });
    res.json({ label: out.label, raised: out.raised, action: out.action, text: out.text, rules: out.rules, detections: out.detections.map((d) => ({ kind: d.kind, span: d.span, score: d.score, rule: d.rule })) });
  });

  // ---------- legal holds (B-7602) ----------

  r.get('/compliance/holds', manage, async (req, res) => {
    const p = principalOf(req);
    res.json({ holds: await s.legalHolds.list(p), approvers: await s.legalHolds.approvers(p), scopes: [...HOLD_SCOPES] });
  });

  r.post('/compliance/holds', manage, async (req, res) => {
    const body = parseBody(z.object({ scope: z.enum(HOLD_SCOPES), scopeId: id26, reason: z.string().trim().min(3).max(1000), approverId: id26 }).strict(), req.body);
    res.status(201).json(await s.legalHolds.request(ctx(req), body));
  });

  r.get('/compliance/holds/:id', manage, async (req, res) => {
    res.json(await s.legalHolds.get(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.post('/compliance/holds/:id/decide', manage, async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    res.json(await s.legalHolds.decide(ctx(req), parseBody(id26, req.params.id), body.decision, body.note ?? null));
  });

  r.post('/compliance/holds/:id/withdraw', manage, async (req, res) => {
    res.json(await s.legalHolds.withdraw(ctx(req), parseBody(id26, req.params.id)));
  });

  r.post('/compliance/holds/:id/release', manage, async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    res.json(await s.legalHolds.release(ctx(req), parseBody(id26, req.params.id), body.note ?? null));
  });

  // ---------- compliance exports (B-7603) ----------

  r.get('/compliance/exports', exporter, async (req, res) => {
    res.json({ exports: (await s.complianceExports.list(principalOf(req))).map(exportView) });
  });

  r.post('/compliance/exports', exporter, async (req, res) => {
    res.status(202).json(exportView(await s.complianceExports.request(principalOf(req), ip(req), parseBody(exportInputSchema, req.body))));
  });

  r.get('/compliance/exports/:id', exporter, async (req, res) => {
    res.json(exportView(await s.complianceExports.get(principalOf(req).tenantId, parseBody(id26, req.params.id))));
  });

  r.get('/compliance/exports/:id/download', exporter, async (req, res) => {
    const { file, parts, first } = await s.complianceExports.download(principalOf(req), ip(req), parseBody(id26, req.params.id));
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    if (first) res.write(first);
    for await (const part of parts) if (!res.write(part)) await new Promise((resolve) => res.once('drain', resolve));
    res.end();
  });

  return r;
}
