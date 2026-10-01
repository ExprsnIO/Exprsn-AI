import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import type { Permission } from '../authz/permissions.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { classifierView, newClassifierSchema, type ClassifierRow } from '../guardrails/classifiers.js';
import { flagRef } from '../guardrails/flags.js';
import { escapeLiteral } from '../guardrails/regex.js';
import { checkRule, diffRules, ruleSchema, rulesFromYaml, rulesToYaml, type Rule } from '../guardrails/rules.js';
import type { RuleSetRow, VersionRow } from '../guardrails/sets.js';
import { CHECKPOINTS, GUARD_ACTIONS, type Checkpoint } from '../guardrails/types.js';
import type { Services } from '../services.js';

const FP_PROMOTION_LIMIT = 0.1;
const ruleIdParam = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/**
 * Guardrail rule sets, the live rule test and shadow replay (`guardrails:manage`); the classifier registry
 * (`classifiers:manage`); the flag queue (`flags:review`). The platform baseline is edited only by platform guardrail
 * admins (who also hold `platform:manage`) and publishes when a second one approves.
 */
export function guardrailRoutes(s: Services): Router {
  const r = Router();
  const { sets, engine, flags, classifiers } = s.guard;
  r.use(['/admin/guardrails', '/admin/classifiers', '/admin/label-names', '/flags', '/eval-sets', '/classify'], noStore, requireAuth());
  const manage = requirePermission(s, 'guardrails:manage');
  const classify = requirePermission(s, 'classifiers:manage');
  const review = requirePermission(s, 'flags:review');
  /** Passes when the caller holds any of the permissions; the denial (and its audit) names the first. */
  const anyOf =
    (...perms: Permission[]): RequestHandler =>
    (req, res, next) => {
      const held = effectivePermissions(principalOf(req));
      return requirePermission(s, perms.find((x) => held.has(x)) ?? perms[0]!)(req, res, next);
    };

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label?: Label) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), ...(label ? { label } : {}), traceId: req.traceId });
  };
  const platformAdmin = (p: Principal) => effectivePermissions(p).has('platform:manage');
  const names = async (ids: (string | null | undefined)[]) => {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    return new Map(((await s.db('users').whereIn('id', list).select('id', 'display_name')) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
  };

  // ---------- rule sets ----------

  const loadSet = async (req: Request) => sets.get(principalOf(req).tenantId, String(req.params.id));
  /** Writing to the platform baseline needs a platform guardrail admin; everyone else gets "Baseline locked". */
  const writable = (p: Principal, set: RuleSetRow) => {
    if (set.scope === 'platform' && !platformAdmin(p)) {
      throw forbidden('Baseline locked: the platform baseline is owned by platform guardrail admins. A tenant rule set can add stricter rules but cannot relax it. Request a change instead.', { step: 'baseline-locked', owner: 'Platform guardrail admins' });
    }
  };
  const versionView = (v: VersionRow, who: Map<string, string>) => ({
    version: v.version,
    status: v.status,
    note: v.note,
    rules: v.rules,
    createdBy: v.created_by,
    createdByName: v.created_by ? (who.get(v.created_by) ?? null) : null,
    submittedBy: v.submitted_by,
    submittedByName: v.submitted_by ? (who.get(v.submitted_by) ?? null) : null,
    submittedAt: v.submitted_at,
    approvedBy: v.approved_by,
    approvedByName: v.approved_by ? (who.get(v.approved_by) ?? null) : null,
    approvedAt: v.approved_at,
    publishedAt: v.published_at,
    createdAt: v.created_at,
    updatedAt: v.updated_at
  });

  const setSummary = async (set: RuleSetRow, p: Principal) => {
    const [pub, draft] = await Promise.all([sets.published(set), sets.draft(set.id)]);
    const counts: Record<string, number> = {};
    for (const rule of (draft ?? pub)?.rules ?? []) counts[rule.checkpoint] = (counts[rule.checkpoint] ?? 0) + 1;
    return {
      id: set.id,
      scope: set.scope,
      name: set.name,
      description: set.description,
      workspaceId: set.workspace_id,
      agent: set.agent,
      publishedVersion: set.published_version,
      draft: draft ? { version: draft.version, status: draft.status } : null,
      locked: set.scope === 'platform' && !platformAdmin(p),
      owner: set.scope === 'platform' ? 'Platform guardrail admins' : null,
      rulesByCheckpoint: counts,
      updatedAt: set.updated_at
    };
  };

  r.get('/admin/guardrails/sets', manage, async (req, res) => {
    const p = principalOf(req);
    const list = await sets.list(p.tenantId);
    const ws = new Map((await s.tenants.workspaces(p.tenantId)).map((w) => [w.id, w.name]));
    res.json(await Promise.all(list.map(async (x) => ({ ...(await setSummary(x, p)), workspace: x.workspace_id ? (ws.get(x.workspace_id) ?? null) : null }))));
  });

  r.post('/admin/guardrails/sets', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(100), scope: z.enum(['tenant', 'workspace', 'agent']), workspaceId: z.string().length(26).nullable().optional(), agent: z.string().trim().min(1).max(100).nullable().optional(), description: z.string().trim().max(500).nullable().optional() }), req.body);
    if (body.workspaceId && !(await s.tenants.workspaces(p.tenantId)).some((w) => w.id === body.workspaceId)) throw notFound('Workspace');
    const set = await sets.create(p.tenantId, body, p.userId);
    await audit(req, 'guardrails.set.created', { set: set.id, name: set.name }, { scope: set.scope, workspace: set.workspace_id, agent: set.agent });
    res.status(201).json(await setSummary(set, p));
  });

  r.get('/admin/guardrails/sets/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    const [versions, draft, pub, baseline] = await Promise.all([sets.versions(set.id), sets.draft(set.id), sets.published(set), sets.baselineRules()]);
    const who = await names(versions.flatMap((v) => [v.created_by, v.submitted_by, v.approved_by]));
    const working = (draft ?? pub)?.rules ?? [];
    const ruleIds = new Set(working.map((x) => x.id));
    const stats = await engine.stats(p.tenantId, set, [...working, ...(pub?.rules ?? []).filter((x) => !ruleIds.has(x.id))]);
    res.json({
      ...(await setSummary(set, p)),
      published: pub ? versionView(pub, who) : null,
      draft: draft ? versionView(draft, who) : null,
      versions: versions.map((v) => ({ version: v.version, status: v.status, note: v.note, createdByName: v.created_by ? (who.get(v.created_by) ?? null) : null, publishedAt: v.published_at, createdAt: v.created_at })),
      yaml: Object.fromEntries(working.map((x) => [x.id, rulesToYaml([x])])),
      stats,
      // Rules of a tenant set that share an id with the platform baseline cannot be relaxed.
      baseline: set.scope === 'platform' ? [] : working.filter((x) => baseline.has(x.id)).map((x) => x.id),
      promotionLimit: FP_PROMOTION_LIMIT
    });
  });

  /** Replaces the draft's rules, from a list or from YAML. */
  r.put('/admin/guardrails/sets/:id/draft', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const body = parseBody(z.object({ rules: z.array(z.unknown()).max(500).optional(), yaml: z.string().max(500_000).optional(), note: z.string().trim().max(500).nullable().optional() }).refine((b) => !!b.rules !== !!b.yaml, 'Send rules or yaml'), req.body);
    const before = await sets.workingRules(set);
    const d = await sets.saveDraft(set, body.yaml !== undefined ? rulesFromYaml(body.yaml) : body.rules, p.userId, body.note);
    const diff = diffRules(before, d.rules);
    await audit(req, 'guardrails.draft.saved', { set: set.id, name: set.name, version: d.version }, { added: diff.added.map((x) => x.id), removed: diff.removed.map((x) => x.id), changed: diff.changed.map((x) => ({ id: x.id, fields: x.fields })) });
    res.json({ version: d.version, status: d.status, rules: d.rules, diff });
  });

  /** Adds or replaces one rule in the draft (the form and the rule's YAML are the same rule). */
  r.put('/admin/guardrails/sets/:id/draft/rules/:ruleId', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const ruleId = parseBody(ruleIdParam, req.params.ruleId);
    const body = parseBody(z.object({ rule: z.unknown().optional(), yaml: z.string().max(100_000).optional() }).refine((b) => (b.rule === undefined) !== (b.yaml === undefined), 'Send rule or yaml'), req.body);
    let raw: unknown = body.yaml !== undefined ? rulesFromYaml(body.yaml) : body.rule;
    if (Array.isArray(raw)) raw = raw.length === 1 ? raw[0] : raw;
    const working = await sets.workingRules(set);
    const existing = working.find((x) => x.id === ruleId);
    const incoming = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>), id: ruleId } : raw;
    // New rules start in shadow; they enforce only after a test run and a replay (then "promote").
    if (!existing && incoming && typeof incoming === 'object' && !('stage' in incoming)) (incoming as Record<string, unknown>).stage = 'shadow';
    const next = existing ? working.map((x) => (x.id === ruleId ? (incoming as Rule) : x)) : [...working, incoming as Rule];
    const d = await sets.saveDraft(set, next, p.userId);
    const saved = d.rules.find((x) => x.id === ruleId)!;
    await audit(req, existing ? 'guardrails.rule.updated' : 'guardrails.rule.added', { set: set.id, name: set.name, version: d.version, rule: ruleId }, { fields: existing ? diffRules([existing], [saved]).changed[0]?.fields ?? [] : null });
    res.json({ version: d.version, status: d.status, rule: saved, yaml: rulesToYaml([saved]) });
  });

  r.delete('/admin/guardrails/sets/:id/draft/rules/:ruleId', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const ruleId = parseBody(ruleIdParam, req.params.ruleId);
    const working = await sets.workingRules(set);
    if (!working.some((x) => x.id === ruleId)) throw notFound('Rule');
    const d = await sets.saveDraft(set, working.filter((x) => x.id !== ruleId), p.userId);
    await audit(req, 'guardrails.rule.removed', { set: set.id, name: set.name, version: d.version, rule: ruleId });
    res.json({ version: d.version, status: d.status });
  });

  r.delete('/admin/guardrails/sets/:id/draft', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const d = await sets.withdraw(set);
    await audit(req, 'guardrails.draft.withdrawn', { set: set.id, name: set.name, version: d.version });
    res.status(204).end();
  });

  /** Requests review: the draft waits for a second guardrail admin and runs in shadow meanwhile. */
  r.post('/admin/guardrails/sets/:id/draft/submit', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const d = await sets.submit(set, p.userId);
    const recipients = set.scope === 'platform'
      ? await s.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.state': 'active', 'r.role': 'system-admin' }).distinct('u.id', 'u.tenant_id')
      : await s.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.state': 'active', 'u.tenant_id': p.tenantId }).whereIn('r.role', ['guardrail-admin', 'system-admin']).distinct('u.id', 'u.tenant_id');
    const byTenant = new Map<string, string[]>();
    for (const u of recipients as { id: string; tenant_id: string }[]) if (u.id !== p.userId) byTenant.set(u.tenant_id, [...(byTenant.get(u.tenant_id) ?? []), u.id]);
    for (const [tenantId, userIds] of byTenant) await s.notifications.notify({ tenantId, userIds, kind: 'guardrails', title: `${set.name} v${d.version} waits for a second approver`, body: `Proposed by ${p.displayName}`, route: 'guardrails', label: 'internal' });
    await audit(req, 'guardrails.review.requested', { set: set.id, name: set.name, version: d.version });
    res.json({ version: d.version, status: d.status, notified: [...byTenant.values()].reduce((a, x) => a + x.length, 0) });
  });

  /** Dual control: someone other than the draft's author and submitter approves, and it publishes. */
  r.post('/admin/guardrails/sets/:id/draft/approve', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const d = await sets.draft(set.id);
    if (!d) throw notFound('Draft');
    if (d.status !== 'pending') throw conflict('Request review before approving.');
    if (d.submitted_by === p.userId || d.created_by === p.userId) throw forbidden('Dual control: you cannot approve your own change. Another guardrail admin must approve it.', { step: 'dual-control' });
    const before = (await sets.published(set))?.rules ?? [];
    const v = await sets.publish(set, p.userId);
    const diff = diffRules(before, v.rules);
    await audit(req, 'guardrails.published', { set: set.id, name: set.name, version: v.version }, { approvedBy: p.userId, proposedBy: d.submitted_by, added: diff.added.map((x) => x.id), removed: diff.removed.map((x) => x.id), changed: diff.changed.map((x) => ({ id: x.id, fields: x.fields })) });
    res.json({ version: v.version, status: v.status });
  });

  /** Publishes a tenant, workspace or agent set's draft. The platform baseline only publishes through approval. */
  r.post('/admin/guardrails/sets/:id/draft/publish', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    if (set.scope === 'platform') throw forbidden('Changes to the platform baseline wait for a second guardrail admin: request review, then another platform guardrail admin approves.', { step: 'dual-control' });
    const before = (await sets.published(set))?.rules ?? [];
    const v = await sets.publish(set, p.userId);
    const diff = diffRules(before, v.rules);
    await audit(req, 'guardrails.published', { set: set.id, name: set.name, version: v.version }, { added: diff.added.map((x) => x.id), removed: diff.removed.map((x) => x.id), changed: diff.changed.map((x) => ({ id: x.id, fields: x.fields })) });
    res.json({ version: v.version, status: v.status });
  });

  /** Diff between two versions (default: published → draft). */
  r.get('/admin/guardrails/sets/:id/diff', manage, async (req, res) => {
    const set = await loadSet(req);
    const q = parseBody(z.object({ from: z.coerce.number().int().min(0).optional(), to: z.coerce.number().int().min(1).optional() }), req.query);
    const draft = await sets.draft(set.id);
    const toV = q.to ?? draft?.version ?? set.published_version;
    const fromV = q.from ?? (toV === set.published_version ? (toV ?? 1) - 1 : set.published_version) ?? 0;
    const [a, b] = await Promise.all([fromV ? sets.version(set.id, fromV) : undefined, toV ? sets.version(set.id, toV) : undefined]);
    if (toV && !b) throw notFound('Version');
    res.json({ from: a ? a.version : null, to: b ? b.version : null, ...diffRules(a?.rules ?? [], b?.rules ?? []) });
  });

  /** Moves a shadow rule to enforce in the draft, when reviewers' false positives are within the promotion limit. */
  r.post('/admin/guardrails/sets/:id/promote', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const body = parseBody(z.object({ ruleId: ruleIdParam }), req.body);
    const working = await sets.workingRules(set);
    const rule = working.find((x) => x.id === body.ruleId);
    if (!rule) throw notFound('Rule');
    if (rule.stage === 'enforce') throw conflict(`${rule.name} already enforces.`);
    const fp = await flags.falsePositives(p.tenantId, set.id, rule.id);
    if (fp.rate != null && fp.rate > FP_PROMOTION_LIMIT) {
      await audit(req, 'guardrails.promotion.refused', { set: set.id, rule: rule.id }, { falsePositiveRate: fp.rate });
      throw new HttpProblem(409, 'Promotion refused', `False-positive rate ${(fp.rate * 100).toFixed(1)}% is above the ${FP_PROMOTION_LIMIT * 100}% promotion limit (${fp.dismissed} dismissed of ${fp.confirmed + fp.dismissed} reviewed). Narrow the rule and replay it before enforcing.`, { extensions: { rate: fp.rate, limit: FP_PROMOTION_LIMIT } });
    }
    const d = await sets.saveDraft(set, working.map((x) => (x.id === rule.id ? { ...x, stage: 'enforce' as const } : x)), p.userId);
    await audit(req, 'guardrails.rule.promoted', { set: set.id, name: set.name, version: d.version, rule: rule.id }, { falsePositiveRate: fp.rate });
    res.json({ version: d.version, status: d.status, falsePositives: fp });
  });

  /** Shadow replay of a version (default: the draft) over recorded inputs, as a job. */
  r.post('/admin/guardrails/sets/:id/replay', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    const body = parseBody(z.object({ version: z.number().int().min(1).optional() }), req.body ?? {});
    const version = body.version ?? (await sets.draft(set.id))?.version ?? set.published_version;
    if (!version || !(await sets.version(set.id, version))) throw notFound('Version');
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'guardrails.replay', payload: { setId: set.id, version }, createdBy: p.userId, maxAttempts: 1 });
    await audit(req, 'guardrails.replay.started', { set: set.id, name: set.name, version }, { job: job.id });
    res.status(202).json({ jobId: job.id, version });
  });

  /** Live test of one rule (a draft object, or a saved rule) on sample text. Nothing is recorded or flagged. */
  r.post('/admin/guardrails/test', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ rule: z.unknown().optional(), setId: z.string().length(26).optional(), ruleId: ruleIdParam.optional(), text: z.string().min(1).max(100_000), label: z.enum(LABELS).optional(), meta: z.record(z.string(), z.unknown()).optional() }), req.body);
    let rule: Rule;
    if (body.rule !== undefined) {
      const parsed = ruleSchema.safeParse(body.rule);
      if (!parsed.success) throw new HttpProblem(422, 'Invalid rule', 'The rule does not match the GuardrailRule schema.', { extensions: { errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
      rule = parsed.data;
      checkRule(rule);
    } else {
      if (!body.setId || !body.ruleId) throw new HttpProblem(400, 'Invalid request', 'Send a rule, or a setId and ruleId.');
      const set = await sets.get(p.tenantId, body.setId);
      const found = (await sets.workingRules(set)).find((x) => x.id === body.ruleId);
      if (!found) throw notFound('Rule');
      rule = found;
    }
    const label = body.label ?? 'internal';
    const out = await engine.evaluate(rule, { tenantId: p.tenantId, checkpoint: rule.checkpoint, text: body.text, label, principal: p, meta: body.meta ?? {} });
    res.json({ ...out, action: out.error ? (rule.onError === 'closed' ? 'require-approval' : 'flag') : out.hit ? rule.action : 'allow', stage: rule.stage, onError: rule.onError, spans: out.spans.map(([a, b]) => ({ start: a, end: b, text: body.text.slice(a, b) })) });
  });

  /** Validates YAML against the GuardrailRule schema without saving (the YAML editor's check). */
  r.post('/admin/guardrails/validate', manage, async (req, res) => {
    const body = parseBody(z.object({ yaml: z.string().max(500_000) }), req.body);
    const raw = rulesFromYaml(body.yaml);
    const list = Array.isArray(raw) ? raw : [raw];
    const parsed = z.array(ruleSchema).safeParse(list);
    if (!parsed.success) throw new HttpProblem(422, 'Invalid rule', 'The YAML does not match the GuardrailRule schema.', { extensions: { errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    for (const x of parsed.data) checkRule(x);
    res.json({ rules: parsed.data });
  });

  /** A tenant admin asks the platform guardrail admins to change a baseline rule. */
  r.post('/admin/guardrails/requests', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ setId: z.string().length(26), ruleId: ruleIdParam, change: z.string().trim().min(1).max(2000) }), req.body);
    const set = await sets.get(p.tenantId, body.setId);
    if (set.scope !== 'platform') throw conflict('Requests are for platform baseline rules; edit your own rule sets directly.');
    const rule = (await sets.workingRules(set)).find((x) => x.id === body.ruleId);
    if (!rule) throw notFound('Rule');
    const admins = (await s.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.state': 'active', 'r.role': 'system-admin' }).distinct('u.id', 'u.tenant_id')) as { id: string; tenant_id: string }[];
    const byTenant = new Map<string, string[]>();
    for (const u of admins) if (u.id !== p.userId) byTenant.set(u.tenant_id, [...(byTenant.get(u.tenant_id) ?? []), u.id]);
    for (const [tenantId, userIds] of byTenant) await s.notifications.notify({ tenantId, userIds, kind: 'guardrails', title: `Change requested to baseline rule ${rule.name}`, body: `${p.displayName} (${p.tenantSlug}): ${body.change}`.slice(0, 1000), route: 'guardrails', label: 'internal' });
    await audit(req, 'guardrails.change.requested', { set: set.id, rule: rule.id }, { change: body.change });
    res.status(202).json({ notified: admins.filter((u) => u.id !== p.userId).length });
  });

  /** Guard-model and classifier failures in the last hour: turns held, decisions that fell open. */
  r.get('/admin/guardrails/status', manage, async (req, res) => {
    res.json(await engine.status(principalOf(req).tenantId));
  });

  // ---------- classifiers ----------

  const loadClassifier = async (req: Request) => classifiers.requireOwn(principalOf(req).tenantId, String(req.params.id));
  const classifierWritable = (p: Principal, c: ClassifierRow) => {
    if (c.tenant_id === null && !platformAdmin(p)) throw forbidden('Platform classifiers are changed by platform admins.', { step: 'role' });
  };
  /** Rules (published or in a draft) that use a classifier, by rule set. */
  const usageOf = async (tenantId: string, c: ClassifierRow) => {
    const out: { set: string; setId: string; rule: string; ruleId: string; checkpoint: string }[] = [];
    for (const set of await sets.list(tenantId)) {
      const seen = new Set<string>();
      for (const rule of [...((await sets.draft(set.id))?.rules ?? []), ...((await sets.published(set))?.rules ?? [])]) {
        const m = rule.mechanism;
        const uses = (m.kind === 'classifier' && m.classifier === c.slug) || (c.engine === 'deterministic' && m.kind === c.config.family) || (c.engine === 'guard' && m.kind === 'guard-model' && m.profile === c.config.profile);
        if (uses && !seen.has(rule.id)) {
          seen.add(rule.id);
          out.push({ set: set.name, setId: set.id, rule: rule.name, ruleId: rule.id, checkpoint: rule.checkpoint });
        }
      }
    }
    return out;
  };

  r.get('/admin/classifiers', classify, async (req, res) => {
    const p = principalOf(req);
    const list = await classifiers.list(p.tenantId);
    res.json(await Promise.all(list.map(async (c) => ({ ...classifierView(c, await classifiers.sampleCounts(p.tenantId, c)), usage: await usageOf(p.tenantId, c) }))));
  });

  r.post('/admin/classifiers', classify, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(newClassifierSchema, req.body);
    const c = await classifiers.create(p.tenantId, body, { userId: p.userId, name: p.displayName });
    await audit(req, 'classifier.created', { classifier: c.id, name: c.name }, { engine: c.engine, labels: c.config.labels.map((l) => l.label) });
    res.status(201).json(classifierView(c, {}));
  });

  r.get('/admin/classifiers/:id', classify, async (req, res) => {
    const p = principalOf(req);
    const c = await loadClassifier(req);
    res.json({ ...classifierView(c, await classifiers.sampleCounts(p.tenantId, c)), versions: await classifiers.versions(c), usage: await usageOf(p.tenantId, c) });
  });

  r.patch('/admin/classifiers/:id', classify, async (req, res) => {
    const p = principalOf(req);
    const c = await loadClassifier(req);
    classifierWritable(p, c);
    const body = parseBody(z.object({ thresholds: z.record(z.string(), z.number().min(0.01).max(0.99)).optional(), profile: z.string().trim().min(1).max(63).optional(), instructions: z.string().trim().max(2000).optional(), dataset: z.string().trim().regex(/^[\w.-]{1,100}$/).optional(), description: z.string().trim().max(1000).optional() }).strict(), req.body);
    const next = await classifiers.update(c, body, p.userId);
    await audit(req, 'classifier.updated', { classifier: c.id, name: c.name, version: next.version }, { before: c.config.labels, after: body });
    res.json(classifierView(next, await classifiers.sampleCounts(p.tenantId, next)));
  });

  r.post('/admin/classifiers/:id/publish', classify, async (req, res) => {
    const p = principalOf(req);
    const c = await loadClassifier(req);
    classifierWritable(p, c);
    const next = await classifiers.publish(c);
    await audit(req, 'classifier.published', { classifier: c.id, name: c.name, version: c.version });
    res.json(classifierView(next));
  });

  const startJob = (type: 'classifier.evaluate' | 'classifier.train') => async (req: Request, res: Response) => {
    const p = principalOf(req);
    const c = await loadClassifier(req);
    if (type === 'classifier.train') {
      classifierWritable(p, c);
      if (c.engine !== 'linear') throw conflict('Only trained (linear) classifiers are trained here; the others are evaluated.');
    }
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type, payload: { classifierId: c.id }, createdBy: p.userId, maxAttempts: 1 });
    await audit(req, `${type}.started`, { classifier: c.id, name: c.name }, { job: job.id, dataset: c.dataset });
    res.status(202).json({ jobId: job.id });
  };
  r.post('/admin/classifiers/:id/evaluate', classify, startJob('classifier.evaluate'));
  r.post('/admin/classifiers/:id/train', classify, startJob('classifier.train'));

  /** Adds labelled cases to the classifier's dataset (sealed). */
  r.post('/admin/classifiers/:id/samples', classify, async (req, res) => {
    const p = principalOf(req);
    const c = await loadClassifier(req);
    const labels = c.config.labels.map((l) => l.label);
    const body = parseBody(z.object({ items: z.array(z.object({ text: z.string().min(1).max(50_000), expected: z.string().min(1).max(100), label: z.enum(LABELS).optional() })).min(1).max(1000) }), req.body);
    const bad = body.items.find((x) => x.expected !== 'none' && !labels.includes(x.expected));
    if (bad) throw new HttpProblem(422, 'Invalid sample', `${c.name} has no label ${bad.expected}; use one of ${labels.join(', ')} or none.`);
    const added = await classifiers.addCases(p.tenantId, c.dataset ?? `${c.slug}-eval`, body.items.map((x) => ({ ...x, label: x.label ?? 'internal' })), p.userId);
    await audit(req, 'classifier.samples.added', { classifier: c.id, dataset: c.dataset }, { added });
    res.status(201).json({ added, samples: await classifiers.sampleCounts(p.tenantId, c) });
  });

  /** Synchronous classification of short text; nothing is stored. */
  r.post('/classify', anyOf('inference:invoke', 'classifiers:manage'), async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ classifier: z.string().min(1).max(63), text: z.string().min(1).max(20_000), label: z.enum(LABELS).optional() }), req.body);
    const c = await classifiers.get(p.tenantId, body.classifier);
    if (!c) throw notFound('Classifier');
    try {
      const out = await classifiers.score(p.tenantId, c, body.text, body.label ?? 'internal');
      res.json({ classifier: c.slug, version: c.version, labels: c.config.labels, ...out, spans: out.spans.map((d) => ({ kind: d.kind, start: d.span[0], end: d.span[1], score: d.score })) });
    } catch (err) {
      const why = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
      throw new HttpProblem(503, 'Classifier unavailable', `${c.name} could not classify the text: ${why}`);
    }
  });

  /** The tenant's names for the four levels. The order is fixed: ceilings and high-water marks compare by position. */
  r.get('/admin/label-names', classify, async (req, res) => {
    const rows = (await s.db('label_names').where({ tenant_id: principalOf(req).tenantId })) as { label: string; name: string }[];
    res.json(Object.fromEntries(LABELS.map((l) => [l, rows.find((x) => x.label === l)?.name ?? l[0]!.toUpperCase() + l.slice(1)])));
  });

  r.put('/admin/label-names', classify, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ order: z.array(z.enum(LABELS)).optional(), names: z.partialRecord(z.enum(LABELS), z.string().trim().min(1).max(40)) }).strict(), req.body);
    if (body.order && body.order.join() !== LABELS.join()) {
      throw new HttpProblem(409, 'Reorder refused', `The order ${LABELS.join(', ')} is fixed. Model and zone ceilings, tool egress and the high-water mark all compare levels by position.`);
    }
    for (const [label, name] of Object.entries(body.names)) {
      const n = await s.db('label_names').where({ tenant_id: p.tenantId, label }).update({ name, updated_at: Date.now() });
      if (!n) await s.db('label_names').insert({ tenant_id: p.tenantId, label, name, updated_at: Date.now() });
    }
    await audit(req, 'labels.renamed', { tenant: p.tenantId }, { names: body.names });
    res.json({ ok: true });
  });

  // ---------- eval sets ----------

  r.get('/eval-sets', anyOf('flags:review', 'classifiers:manage'), async (req, res) => {
    res.json(await classifiers.evalSets(principalOf(req).tenantId));
  });

  // ---------- flags ----------

  const reviewScope = async (req: Request) => {
    const p = principalOf(req);
    return { p, ws: (await workspacesFor(s, p)).map((w) => w.id) };
  };
  const ref = (req: Request) => String(req.params.ref);

  r.get('/flags', review, async (req, res) => {
    const { p, ws } = await reviewScope(req);
    res.json(await flags.queue(p, ws));
  });

  r.get('/flags/decisions', review, async (req, res) => {
    const { p, ws } = await reviewScope(req);
    const q = parseBody(z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) }), req.query);
    res.json(await flags.decisions(p, ws, q.hours));
  });

  /** A user reports an answer from their own conversation; a reviewer doing so files it as a reviewer flag. */
  r.post('/flags/report', requirePermission(s, 'chat:read'), async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ conversationId: z.string().length(26), messageId: z.string().length(26), reason: z.string().trim().min(1).max(200), note: z.string().trim().max(1000).optional(), span: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(), severity: z.enum(['high', 'medium', 'low']).default('medium') }), req.body);
    const conv = (await s.db('conversations').where({ tenant_id: p.tenantId, id: body.conversationId, user_id: p.userId }).first()) as { id: string; workspace_id: string | null } | undefined;
    if (!conv) throw notFound('Conversation');
    const m = (await s.db('messages').where({ conversation_id: conv.id, id: body.messageId }).first()) as { id: string; content: string | null; label: Label } | undefined;
    if (!m) throw notFound('Message');
    const text = m.content ? await s.keys.open(p.tenantId, m.content, `content:${m.id}`) : '';
    const span = body.span && body.span[0] < body.span[1] && body.span[1] <= text.length ? body.span : null;
    const reviewer = effectivePermissions(p).has('flags:review');
    const f = await flags.create({ tenantId: p.tenantId, workspaceId: conv.workspace_id, kind: reviewer ? 'reviewer' : 'report', checkpoint: 'user-report', ruleName: 'Reported from chat', severity: body.severity, label: m.label, text, span, note: `Reporter chose "${body.reason}".${body.note ? ` ${body.note}` : ''}`, actor: { user: p.userId, name: `Reported by ${p.displayName}`, via: 'chat' }, source: { kind: 'message', id: m.id }, conversationId: conv.id });
    await audit(req, 'flag.reported', { flag: flagRef(f), message: m.id }, { reason: body.reason, severity: f.severity }, m.label);
    res.status(201).json({ id: f.id, ref: flagRef(f), severity: f.severity, dueAt: f.due_at });
  });

  r.get('/flags/:ref', review, async (req, res) => {
    const { p, ws } = await reviewScope(req);
    res.json(await flags.detail(p, ref(req), ws));
  });

  r.post('/flags/:ref/decide', review, async (req, res) => {
    const { p, ws } = await reviewScope(req);
    const body = parseBody(z.object({ decision: z.enum(['confirmed', 'dismissed', 'approved', 'rejected']), reason: z.string().trim().max(500).nullable().optional() }), req.body);
    if (body.decision === 'approved' || body.decision === 'rejected') {
      // A held chat answer (Sprint 12): approving releases it to its owner, rejecting withdraws it.
      const decision = body.decision;
      let conversationId: string | null = null;
      const f = await flags.decideHold(p, ref(req), ws, decision, body.reason ?? null, async (flag) => {
        // Sprint 21 (B-1301): a held /v1 request runs as its sender when approved.
        if (flag.source_kind === 'api-request' && flag.source_id) {
          await s.openai.holds.resolve(p, flag.source_id, decision);
          return;
        }
        if (flag.source_kind !== 'message' || !flag.source_id) throw conflict(`${flagRef(flag)} has no answer attached.`);
        conversationId = (await s.chat.resolveHold(p, flag.source_id, decision)).conversationId;
      });
      if (f.source_kind === 'api-request') await audit(req, `api.hold.${decision}`, { flag: flagRef(f), request: f.source_id }, { reason: body.reason ?? null, rule: f.rule_id }, f.label);
      else await audit(req, `chat.hold.${decision}`, { flag: flagRef(f), message: f.source_id, conversation: conversationId }, { reason: body.reason ?? null, rule: f.rule_id }, f.label);
      res.json(flags.view(f, p));
      return;
    }
    const f = await flags.decide(p, ref(req), ws, body.decision, body.reason ?? null);
    let evalCase: string | null = null;
    if (body.decision === 'confirmed') {
      // A confirmed flag becomes a positive eval case for its rule.
      const text = await flags.flaggedText(p, f);
      if (text) {
        await classifiers.addCases(p.tenantId, f.eval_set!, [{ text, expected: 'positive', label: f.label, flagId: f.id, ...(f.rule_id ? { ruleId: f.rule_id } : {}) }], p.userId);
        evalCase = `${f.eval_set}/${flagRef(f).toLowerCase()}`;
      }
    }
    await audit(req, `flag.${body.decision}`, { flag: flagRef(f), rule: f.rule_id, set: f.set_id }, { reason: body.reason ?? null, evalCase }, f.label);
    res.json({ ...flags.view(f, p), evalCase });
  });

  r.post('/flags/:ref/escalate', review, async (req, res) => {
    const { p, ws } = await reviewScope(req);
    const body = parseBody(z.object({ to: z.enum(['workspace', 'tenant', 'platform']), note: z.string().trim().max(500).nullable().optional() }), req.body);
    const f = await flags.escalate(p, ref(req), ws, body.to, body.note ?? null);
    await audit(req, 'flag.escalated', { flag: flagRef(f) }, { to: body.to, note: body.note ?? null }, f.label);
    res.json(flags.view(f, p));
  });

  r.get('/flags/:ref/reviewers', review, async (req, res) => {
    const { p, ws } = await reviewScope(req);
    res.json(await flags.reviewers(p, ref(req), ws));
  });

  r.post('/flags/:ref/reassign', review, async (req, res) => {
    const { p, ws } = await reviewScope(req);
    const body = parseBody(z.object({ userId: z.string().length(26) }), req.body);
    const out = await flags.reassign(p, ref(req), ws, body.userId);
    await audit(req, 'flag.reassigned', { flag: flagRef(out.flag) }, { to: out.to.id }, out.flag.label);
    res.json({ ...flags.view(out.flag, p), assigneeName: out.to.name });
  });

  r.post('/flags/:ref/eval', review, async (req, res) => {
    const { p, ws } = await reviewScope(req);
    const body = parseBody(z.object({ evalSet: z.string().trim().regex(/^[\w.-]{1,100}$/), expected: z.enum(['positive', 'negative']) }), req.body);
    const f = await flags.detail(p, ref(req), ws);
    const row = await flags.get(p.tenantId, f.id);
    const text = await flags.flaggedText(p, row);
    if (!text) throw conflict('This flag has no text to add.');
    await classifiers.addCases(p.tenantId, body.evalSet, [{ text, expected: body.expected, label: row.label, flagId: row.id, ...(row.rule_id ? { ruleId: row.rule_id } : {}) }], p.userId);
    await flags.markEval(p, row, body.evalSet);
    const cases = (await classifiers.evalSets(p.tenantId)).find((x) => x.name === body.evalSet)?.cases ?? 1;
    await audit(req, 'flag.eval_case.added', { flag: flagRef(row), evalSet: body.evalSet }, { expected: body.expected, case: cases }, row.label);
    res.status(201).json({ evalSet: body.evalSet, case: cases });
  });

  /** Drafts a shadow rule matching the flagged span literally, in a rule set the caller manages. */
  r.post('/flags/:ref/rule', review, manage, async (req, res) => {
    const { p, ws } = await reviewScope(req);
    const body = parseBody(z.object({ setId: z.string().length(26), action: z.enum(GUARD_ACTIONS).default('flag'), name: z.string().trim().min(1).max(200).optional() }), req.body);
    const f = await flags.get(p.tenantId, (await flags.detail(p, ref(req), ws)).id);
    const d = await flags.detail(p, f.id, ws);
    if (d.restricted) throw forbidden('Above your clearance.', { step: 'clearance' });
    const span = d.excerpt?.span?.trim();
    if (!span) throw conflict('This flag has no flagged span to build a rule from.');
    const set = await sets.get(p.tenantId, body.setId);
    writable(p, set);
    const checkpoint: Checkpoint = (CHECKPOINTS as readonly string[]).includes(f.checkpoint) ? (f.checkpoint as Checkpoint) : 'model-output';
    const rule: Rule = { id: `from-${flagRef(f).toLowerCase()}`, name: body.name ?? `From ${flagRef(f)}`, checkpoint, type: 'pattern', mechanism: { kind: 'pattern', pattern: escapeLiteral(span.slice(0, 200)) }, action: body.action, stage: 'shadow', onError: 'closed', severity: f.severity, enabled: true, description: `Created from ${flagRef(f)}` };
    const working = await sets.workingRules(set);
    if (working.some((x) => x.id === rule.id)) throw conflict(`${set.name} already has a rule from ${flagRef(f)}.`);
    const v = await sets.saveDraft(set, [...working, rule], p.userId);
    await audit(req, 'guardrails.rule.added', { set: set.id, name: set.name, version: v.version, rule: rule.id }, { fromFlag: flagRef(f) });
    res.status(201).json({ setId: set.id, version: v.version, rule });
  });

  return r;
}
