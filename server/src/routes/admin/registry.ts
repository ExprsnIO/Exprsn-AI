import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { AGENT_TYPES } from '../../memory/service.js';
import { actorFrom } from '../../audit/chain.js';
import { authorize } from '../../authz/policy.js';
import { LABELS } from '../../authz/labels.js';
import type { Permission } from '../../authz/permissions.js';
import { declaresAnyOf, ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, conflict, notFound } from '../../http/problem.js';
import { entryView, ENTRY_KINDS, ENTRY_STATUSES, MAX_BUDGETS, SIDE_EFFECTS, type EntryKind, type EntryRow } from '../../registry/service.js';
import type { Services } from '../../services.js';

const semver = z.string().trim().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/, 'A semantic version such as 1.2.0');
const entryName = z.string().trim().regex(/^[a-z0-9][a-z0-9_.:-]{0,119}$/i, 'Letters, digits and . _ : -, for example ledger.query');
const schemaObj = z.record(z.string(), z.unknown());
const budgets = z.object({ steps: z.number().int().min(1).max(MAX_BUDGETS.steps), tokens: z.number().int().min(100).max(MAX_BUDGETS.tokens), wallSeconds: z.number().int().min(5).max(MAX_BUDGETS.wallSeconds), toolCalls: z.number().int().min(0).max(MAX_BUDGETS.toolCalls) });
/** An agent's memory policy (Sprint 12): whether its runs may propose memories, of which types, and how many per run. */
const memoryPolicy = z.object({ write: z.enum(['off', 'propose']).default('off'), types: z.array(z.enum(AGENT_TYPES)).min(1).max(AGENT_TYPES.length).default([...AGENT_TYPES]), maxPerRun: z.number().int().min(1).max(20).default(3) }).strict();
const agentDef = z.object({ profile: z.string().trim().min(1).max(63), systemPrompt: z.string().max(20_000).nullable().default(null), tools: z.array(entryName).max(32).default([]), skills: z.array(entryName).max(16).default([]), budgets, memory: memoryPolicy.optional() });
const skillDef = z.object({ instructions: z.string().max(100_000), tools: z.array(entryName).max(32).default([]) });
const scriptDef = z.object({ scriptId: z.string().length(26) });

/** Tool and skill entries are a tool admin's; agent entries an agent admin's. */
const permFor = (kind: EntryKind): Permission => (kind === 'agent' ? 'agents:manage' : 'tools:manage');

/** The registry: tools, skills and agents, automated checks, review, publish scope and the lifecycle. */
export function registryAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/registry', noStore, requireAuth());
  const read = requirePermission(s, 'tools:manage');
  const reg = s.registry;

  /** The permission for the entry kind in the body or the loaded entry, checked like requirePermission. */
  const forKind = (kindOf: (req: Request) => Promise<EntryKind> | EntryKind): RequestHandler =>
    declaresAnyOf(async (req, res, next) => {
      await requirePermission(s, permFor(await kindOf(req)))(req, res, next);
    }, ['tools:manage', 'agents:manage']);
  const entryKind = async (req: Request) => (await load(req)).kind;

  const audit = (req: Request, action: string, e: Pick<EntryRow, 'id' | 'name' | 'version' | 'kind'>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target: { registryEntry: e.id, kind: e.kind, name: e.name, version: e.version }, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const load = async (req: Request) => reg.mustGet(principalOf(req).tenantId, String(req.params.id));
  const reviewerNames = async (list: EntryRow[]) => {
    const ids = [...new Set(list.map((e) => e.reviewed_by).filter((x): x is string => !!x))];
    return new Map((await s.db('users').whereIn('id', ids).select('id', 'display_name')).map((u: { id: string; display_name: string }) => [u.id, u.display_name]));
  };
  const view = async (e: EntryRow) => entryView(e, await reviewerNames([e]));

  r.get('/registry', read, async (req, res) => {
    const q = parseBody(z.object({ kind: z.enum(ENTRY_KINDS).optional(), status: z.enum(ENTRY_STATUSES).optional() }), req.query);
    const list = await reg.list(principalOf(req).tenantId, q);
    const names = await reviewerNames(list);
    res.json(list.map((e) => entryView(e, names)));
  });

  r.get('/registry/:id', read, async (req, res) => {
    const p = principalOf(req);
    const e = await load(req);
    const versions = await reg.versions(e);
    const names = await reviewerNames([e, ...versions]);
    const referencedBy = e.kind === 'tool' && e.tenant_id ? await reg.referencedBy(p.tenantId, e.name) : [];
    const profiles = e.kind === 'tool' ? (await s.gateway.repo.profiles(p.tenantId)).filter((x) => x.tools.includes(e.name)).map((x) => x.name) : [];
    const workspaces = e.publish_workspaces.length ? ((await s.db('workspaces').whereIn('id', e.publish_workspaces).select('id', 'name')) as { id: string; name: string }[]) : [];
    res.json({ ...entryView(e, names), versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, createdAt: v.created_at })), referencedBy, profiles, workspaces });
  });

  const createBody = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('tool'), name: entryName, version: semver.default('0.1.0'), description: z.string().trim().max(2000).nullable().default(null), sideEffect: z.enum(SIDE_EFFECTS), confirm: z.enum(['always', 'never']).optional(), ratePerHour: z.number().int().min(1).max(100_000).nullable().default(null), label: z.enum(LABELS).default('internal'), inputSchema: schemaObj, outputSchema: schemaObj.nullable().default(null), definition: scriptDef }),
    z.object({ kind: z.literal('skill'), name: entryName, version: semver.default('0.1.0'), description: z.string().trim().max(2000).nullable().default(null), label: z.enum(LABELS).default('internal'), definition: skillDef }),
    z.object({ kind: z.literal('agent'), name: z.string().trim().min(1).max(120), version: semver.default('0.1.0'), description: z.string().trim().max(2000).nullable().default(null), label: z.enum(LABELS).default('internal'), definition: agentDef })
  ]);

  /** A new draft. Tools submitted here are script-backed; MCP tools come from the MCP servers screen. */
  r.post('/registry', forKind((req) => ((req.body as { kind?: string })?.kind === 'agent' ? 'agent' : 'tool')), async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(createBody, req.body);
    let e: EntryRow;
    if (b.kind === 'tool') {
      const script = (await s.db('scripts').where({ tenant_id: p.tenantId, id: b.definition.scriptId }).first()) as { id: string; name: string; version: number; language: string } | undefined;
      if (!script) throw notFound('Script');
      e = await reg.create(p, { kind: 'tool', name: b.name, version: b.version, description: b.description, impl: 'script', sideEffect: b.sideEffect, ...(b.confirm ? { confirm: b.confirm } : {}), ratePerHour: b.ratePerHour, label: b.label, inputSchema: b.inputSchema, outputSchema: b.outputSchema, definition: { scriptId: script.id, scriptName: script.name, version: script.version, language: script.language } });
    } else if (b.kind === 'skill') {
      e = await reg.create(p, { kind: 'skill', name: b.name, version: b.version, description: b.description, impl: 'archive', sideEffect: null, label: b.label, inputSchema: null, outputSchema: null, definition: b.definition });
    } else {
      if (!(await s.gateway.repo.profileByName(p.tenantId, b.definition.profile))) throw notFound(`Profile ${b.definition.profile}`);
      e = await reg.create(p, { kind: 'agent', name: b.name, version: b.version, description: b.description, impl: 'agent', sideEffect: null, label: b.label, inputSchema: null, outputSchema: null, definition: b.definition });
    }
    await audit(req, 'registry.created', e, { impl: e.impl, checksPassed: e.checks.every((c) => c.ok) });
    res.status(201).json(await view(e));
  });

  r.patch('/registry/:id', forKind(entryKind), async (req, res) => {
    const p = principalOf(req);
    const e = await load(req);
    const b = parseBody(z.object({ description: z.string().trim().max(2000).nullable().optional(), sideEffect: z.enum(SIDE_EFFECTS).optional(), confirm: z.enum(['always', 'never']).optional(), ratePerHour: z.number().int().min(1).max(100_000).nullable().optional(), label: z.enum(LABELS).optional(), inputSchema: schemaObj.optional(), outputSchema: schemaObj.nullable().optional(), definition: z.record(z.string(), z.unknown()).optional() }).strict(), req.body);
    if (b.definition && e.kind === 'tool') throw badRequest('A tool\'s implementation is fixed; create a new entry.');
    if (b.definition) b.definition = e.kind === 'agent' ? parseBody(agentDef, b.definition) : parseBody(skillDef, b.definition);
    const next = await reg.update(p, e, b);
    await audit(req, 'registry.updated', e, { changed: Object.keys(b) });
    res.json(await view(next));
  });

  r.post('/registry/:id/checks', forKind(entryKind), async (req, res) => {
    const e = await reg.recheck(await load(req));
    res.json(await view(e));
  });

  r.post('/registry/:id/submit', forKind(entryKind), async (req, res) => {
    const e = await reg.submit(await load(req));
    await audit(req, 'registry.submitted', e, { checks: e.checks.map((c) => ({ name: c.name, ok: c.ok })) });
    res.json(await view(e));
  });

  r.post('/registry/:id/review', forKind(entryKind), async (req, res) => {
    const p = principalOf(req);
    const e = await load(req);
    const b = parseBody(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).nullable().default(null), scope: z.enum(['tenant', 'workspace']).default('tenant'), workspaces: z.array(z.string().length(26)).max(200).default([]) }), req.body);
    const next = await reg.review(p, e, b);
    await audit(req, b.decision === 'approve' ? 'registry.published' : 'registry.rejected', e, { note: b.note, scope: next.publish_scope, workspaces: next.publish_workspaces, hash: next.approved_hash });
    if (e.owner_id) {
      await s.notifications.notify({ tenantId: p.tenantId, userIds: [e.owner_id], kind: 'registry', title: `${e.name} ${e.version} ${b.decision === 'approve' ? 'published' : 'returned to draft'}`, ...(b.note ? { body: b.note } : {}), route: 'registry' });
    }
    res.json(await view(next));
  });

  r.post('/registry/:id/publish', forKind(entryKind), async (req, res) => {
    const e = await load(req);
    const b = parseBody(z.object({ scope: z.enum(['tenant', 'workspace']), workspaces: z.array(z.string().length(26)).max(200).default([]) }), req.body);
    const next = await reg.publishTo(e, b.scope, b.workspaces);
    await audit(req, 'registry.scope.changed', e, { scope: next.publish_scope, workspaces: next.publish_workspaces });
    res.json(await view(next));
  });

  r.post('/registry/:id/lifecycle', forKind(entryKind), async (req, res) => {
    const p = principalOf(req);
    const e = await load(req);
    const b = parseBody(z.object({ to: z.enum(['deprecated', 'retired', 'published']), replacement: z.string().trim().max(200).nullable().default(null) }), req.body);
    const referencedBy = b.to === 'retired' && e.kind === 'tool' ? await reg.referencedBy(p.tenantId, e.name) : [];
    const next = await reg.lifecycle(e, b.to, { replacement: b.replacement });
    await audit(req, b.to === 'published' ? 'registry.restored' : `registry.${b.to}`, e, { from: e.status, replacement: b.replacement, referencedBy: referencedBy.map((x) => `${x.name} ${x.version}`) });
    res.json({ ...(await view(next)), referencedBy });
  });

  r.post('/registry/:id/versions', forKind(entryKind), async (req, res) => {
    const p = principalOf(req);
    const e = await load(req);
    const b = parseBody(z.object({ version: semver }), req.body);
    const next = await reg.newVersion(p, e, b.version);
    await audit(req, 'registry.version.created', next, { from: e.version });
    res.status(201).json(await view(next));
  });

  /**
   * The test harness: a tool runs once with sample arguments (write and destructive MCP tools are not run against
   * live systems); an agent starts a real run, which the Runs screen shows.
   */
  r.post('/registry/:id/test', forKind(entryKind), async (req, res) => {
    const p = principalOf(req);
    const e = await load(req);
    const b = parseBody(z.object({ arguments: z.record(z.string(), z.unknown()).default({}), input: z.string().trim().max(20_000).optional(), label: z.enum(LABELS).optional() }), req.body);
    if (e.kind === 'skill') throw conflict('Skills are tested through an agent that loads them.');
    if (e.kind === 'agent') {
      if (!authorize(p, 'agents:run').allow) throw conflict('Running an agent needs agents:run.');
      const run = await s.agents.start(p, { agent: e.id, input: b.input ?? 'Describe what you can do in two sentences.', ...(b.label ? { label: b.label } : {}) });
      await audit(req, 'registry.tested', e, { run: run.id });
      return res.status(202).json({ runId: run.id });
    }
    const tool = s.tools.toResolved(e);
    const sandboxed = e.impl === 'builtin' || e.impl === 'script';
    const outcome = await s.tools.call({ principal: p, label: b.label ?? e.label, source: { kind: 'registry-test', id: e.id }, approved: sandboxed }, tool, b.arguments);
    await audit(req, 'registry.tested', e, { ok: outcome.ok, denied: !!outcome.denied, needsApproval: !!outcome.needsApproval, valid: outcome.valid ?? null });
    res.json({ ...outcome, label: e.label, sandboxed, note: outcome.needsApproval ? `${e.name} is a ${tool.sideEffect} tool; the harness does not run it against a live system.` : null });
  });

  return r;
}
