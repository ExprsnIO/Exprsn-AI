import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { graphSchema } from '../workflows/graph.js';
import type { Services } from '../services.js';

const name = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lower-case letters, digits and hyphens');
const input = z.record(z.string(), z.unknown()).default({});

/**
 * Workflows. Editing and publishing need `workflows:manage`; starting runs of published versions and reading run
 * history need `agents:run` (members hold it). Approvals are decided by holders of the role the step names, which
 * the service checks, together with clearance for the run's label.
 */
export function workflowRoutes(s: Services): Router {
  const r = Router();
  r.use(['/workflows', '/workflow-runs', '/workflow-approvals'], noStore, requireAuth());
  const run = requirePermission(s, 'agents:run');
  const manage = requirePermission(s, 'workflows:manage');
  const wf = s.workflows;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/workflows', run, async (req, res) => {
    res.json(await wf.list(principalOf(req)));
  });

  r.post('/workflows', manage, async (req, res) => {
    const body = parseBody(z.object({ name, description: z.string().trim().max(500).nullable().default(null), label: z.enum(LABELS).default('internal'), graph: graphSchema.optional() }).strict(), req.body);
    const w = await wf.create(principalOf(req), body);
    await audit(req, 'workflow.created', { workflow: w.id, name: w.name }, w.label);
    res.status(201).json(await wf.view(principalOf(req), w.id));
  });

  r.get('/workflows/:id', run, async (req, res) => {
    res.json(await wf.view(principalOf(req), String(req.params.id)));
  });

  /** Saves the draft graph; `rev` is the revision the editor loaded (409 if someone saved since). */
  r.put('/workflows/:id/draft', manage, async (req, res) => {
    const body = parseBody(z.object({ graph: graphSchema.optional(), rev: z.number().int().min(1).optional(), description: z.string().trim().max(500).nullable().optional(), label: z.enum(LABELS).optional() }).strict(), req.body);
    const v = await wf.saveDraft(principalOf(req), String(req.params.id), body);
    await audit(req, 'workflow.draft.saved', { workflow: v.id, name: v.name }, v.label, { rev: v.draftRev, steps: v.draft.nodes.length, edges: v.draft.edges.length, ...(body.label ? { label: body.label } : {}) });
    res.json(v);
  });

  /** Validates a graph against the workflow's label and the tenant's profiles, without saving it. */
  r.post('/workflows/:id/validate', run, async (req, res) => {
    const p = principalOf(req);
    const w = await wf.workflow(p, String(req.params.id));
    const body = parseBody(z.object({ graph: graphSchema.optional() }).strict(), req.body);
    res.json(await wf.validate(p.tenantId, body.graph ?? graphSchema.parse(JSON.parse(w.draft)), w.label));
  });

  r.post('/workflows/:id/publish', manage, async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().default(null) }).strict(), req.body);
    const p = principalOf(req);
    const w = await wf.workflow(p, String(req.params.id));
    try {
      const out = await wf.publish(p, w.id, body.note);
      await audit(req, 'workflow.published', { workflow: w.id, name: w.name }, w.label, { version: out.version, warnings: out.warnings.length });
      res.json({ ...out, workflow: await wf.view(p, w.id) });
    } catch (err) {
      await audit(req, 'workflow.publish.refused', { workflow: w.id, name: w.name }, w.label, { detail: (err as Error).message.slice(0, 300) });
      throw err;
    }
  });

  r.delete('/workflows/:id', manage, async (req, res) => {
    const w = await wf.remove(principalOf(req), String(req.params.id));
    await audit(req, 'workflow.deleted', { workflow: w.id, name: w.name }, w.label);
    res.status(204).end();
  });

  // ---------- runs ----------

  r.post('/workflows/:id/runs', run, async (req, res) => {
    const body = parseBody(z.object({ input }).strict(), req.body);
    const out = await wf.start(principalOf(req), String(req.params.id), { input: body.input, dry: false, trigger: req.apiKey ? 'api' : 'manual' });
    await audit(req, 'workflow.run.started', { workflow: out.workflow_id, run: out.id }, out.label, { version: out.version });
    res.status(202).json({ id: out.id, state: out.state, version: out.version, mode: out.mode, label: out.label });
  });

  /** A dry run of the draft: models and HTTP calls are mocked, guardrails are not consulted, nothing is metered. */
  r.post('/workflows/:id/dry-run', manage, async (req, res) => {
    const body = parseBody(z.object({ input }).strict(), req.body);
    const out = await wf.start(principalOf(req), String(req.params.id), { input: body.input, dry: true });
    await audit(req, 'workflow.dryrun.started', { workflow: out.workflow_id, run: out.id }, out.label, { draftRev: out.draft_rev });
    res.status(202).json({ id: out.id, state: out.state, version: out.version, mode: out.mode, label: out.label });
  });

  r.get('/workflows/:id/runs', run, async (req, res) => {
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    res.json(await wf.runs(principalOf(req), String(req.params.id), q.limit));
  });

  // Run owners, workflow admins and approvers of the run may read it; the service decides which.
  r.get('/workflow-runs/:id', async (req, res) => {
    res.json(await wf.runView(principalOf(req), String(req.params.id)));
  });

  r.post('/workflow-runs/:id/replay', run, async (req, res) => {
    const body = parseBody(z.object({ from: z.string().min(1).max(63) }).strict(), req.body);
    const out = await wf.replay(principalOf(req), String(req.params.id), body.from);
    await audit(req, 'workflow.run.replayed', { workflow: out.workflow_id, run: out.id, replayOf: out.replay_of, from: body.from }, out.label);
    res.status(202).json({ id: out.id, state: out.state, mode: out.mode, replayOf: out.replay_of, replayFrom: out.replay_from });
  });

  r.post('/workflow-runs/:id/cancel', run, async (req, res) => {
    const out = await wf.cancel(principalOf(req), String(req.params.id));
    await audit(req, 'workflow.run.cancelled', { workflow: out.workflow_id, run: out.id }, out.label);
    res.json({ id: out.id, state: out.state });
  });

  // ---------- approvals ----------

  r.get('/workflow-approvals', async (req, res) => {
    res.json(await wf.pendingApprovals(principalOf(req)));
  });

  r.post('/workflow-approvals/:id', async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(1000).nullable().default(null) }).strict(), req.body);
    const out = await wf.decide(principalOf(req), String(req.params.id), body);
    await audit(req, out.state === 'approved' ? 'workflow.approval.approved' : 'workflow.approval.rejected', { workflow: out.workflowId, run: out.run, approval: out.approval }, out.label, { reason: body.reason ? 'given' : null });
    res.json(out);
  });

  return r;
}
