import { Router, type Request } from 'express';
import { z } from 'zod';
import { HOOK_MAX_BYTES } from '../apps/flow-hooks.js';
import { flowInputSchema, flowUpdateSchema } from '../apps/flows.js';
import { badRequest } from '../http/problem.js';
import type { Actor } from '../apps/service.js';
import type { Principal } from '../authz/policy.js';
import { ip, parseBody, principalOf, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const ref = z.string().min(1).max(63);

/**
 * App flows (the exprsn-platform low-code port, `docs/decisions/lowcode-port.md`): an app's automations edited on the
 * Apps canvas and compiled into workflows. Mounted inside `routes/apps.ts`, behind its `/apps` guards (authentication,
 * app-scoped credentials). Reading flows and their runs needs `apps:design`; changing them also `workflows:manage`,
 * because a flow creates, saves and publishes its workflow. The hook routes manage a webhook flow's incoming webhook
 * (`apps/flow-hooks.ts`); the public endpoint itself is `routes/apps-flow-hooks-public.ts`.
 */
export function appFlowRoutes(s: Services): Router {
  const r = Router();
  const design = requirePermission(s, 'apps:design');
  const manage = requirePermission(s, 'workflows:manage');
  const flows = s.apps.flows;
  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const param = (req: Request, k: string) => parseBody(ref, req.params[k]);

  r.get('/apps/:app/flows', design, async (req, res) => {
    res.json({ flows: await flows.list(principalOf(req), param(req, 'app')) });
  });

  r.post('/apps/:app/flows', design, manage, async (req, res) => {
    res.status(201).json(await flows.create(actor(req), param(req, 'app'), parseBody(flowInputSchema, req.body)));
  });

  /** A model's draft of a flow from a description; validated, never saved. */
  r.post('/apps/:app/flows/draft', design, manage, async (req, res) => {
    const body = parseBody(z.object({ prompt: z.string().trim().min(3).max(4000), profile: z.string().min(1).max(63) }).strict(), req.body);
    res.json(await flows.draft(actor(req), param(req, 'app'), body));
  });

  /** What the integration actions may use here (for those who may change flows): tools, scripts, agents, profiles cleared for the entity's label. */
  r.get('/apps/:app/flows/palette', design, manage, async (req, res) => {
    const q = parseBody(z.object({ entity: z.string().min(1).max(63).optional() }).strict(), { ...(typeof req.query.entity === 'string' ? { entity: req.query.entity } : {}) });
    res.json(await flows.palette(principalOf(req), param(req, 'app'), q.entity));
  });

  r.get('/apps/:app/flows/:flow', design, async (req, res) => {
    res.json(await flows.get(principalOf(req), param(req, 'app'), param(req, 'flow')));
  });

  r.put('/apps/:app/flows/:flow', design, manage, async (req, res) => {
    // 1.8.0 (B-140): someone else's live edit lock on the flow, or on the workflow it saves, refuses the save (409).
    const p = principalOf(req);
    const body = parseBody(flowUpdateSchema, req.body);
    const app = await s.apps.app(p, param(req, 'app'));
    const row = (await s.db('app_flows').where({ app_id: app.id }).andWhere((q) => q.where({ id: param(req, 'flow') }).orWhere({ name: param(req, 'flow') })).first('id', 'name', 'title', 'workflow_id')) as { id: string; name: string; title: string | null; workflow_id: string } | undefined;
    if (row) {
      await s.designLocks.assertCanSave(p, 'app-flow', app.tenant_id, row.id);
      await s.designLocks.assertCanSave(p, 'workflow', app.tenant_id, row.workflow_id);
    }
    const out = await flows.update(actor(req), app.id, param(req, 'flow'), body);
    if (row) await s.designLocks.releaseOnSave(p, 'app-flow', { tenantId: app.tenant_id, id: row.id, label: app.label, title: row.title || row.name }, { ip: ip(req), traceId: req.traceId });
    res.json(out);
  });

  r.patch('/apps/:app/flows/:flow', design, manage, async (req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
    res.json(await flows.setEnabled(actor(req), param(req, 'app'), param(req, 'flow'), body.enabled));
  });

  r.delete('/apps/:app/flows/:flow', design, manage, async (req, res) => {
    await flows.remove(actor(req), param(req, 'app'), param(req, 'flow'));
    res.status(204).end();
  });

  /** A dry run of the flow on one record: steps that write or send are mocked. */
  r.post('/apps/:app/flows/:flow/test', design, manage, async (req, res) => {
    const body = parseBody(z.object({ record: z.string().length(26).optional(), event: z.enum(['created', 'updated', 'deleted', 'transitioned', 'manual']).optional(), payload: z.record(z.string().max(200), z.unknown()).optional() }).strict(), req.body);
    if (body.payload && Buffer.byteLength(JSON.stringify(body.payload)) > HOOK_MAX_BYTES) throw badRequest(`A test payload is at most ${HOOK_MAX_BYTES} bytes, as a webhook body is.`);
    res.status(202).json(await flows.test(actor(req), param(req, 'app'), param(req, 'flow'), body));
  });

  /** A webhook flow's hook: on (the caller owns its runs) or off. */
  r.put('/apps/:app/flows/:flow/hook', design, manage, async (req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
    res.json(await flows.hooks.setEnabled(actor(req), param(req, 'app'), param(req, 'flow'), body.enabled));
  });

  /** Makes or replaces the hook's signing secret; the secret is shown in this answer only. */
  r.post('/apps/:app/flows/:flow/hook/secret', design, manage, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(await flows.hooks.rotate(actor(req), param(req, 'app'), param(req, 'flow')));
  });

  r.get('/apps/:app/flows/:flow/runs', design, async (req, res) => {
    res.json({ runs: await flows.runs(principalOf(req), param(req, 'app'), param(req, 'flow')) });
  });

  return r;
}
