import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';
import { audit, type OpsActor } from '../../ops/common.js';
import type { ProposalRow } from '../../config/settings.js';

const proposalView = (p: ProposalRow) => ({ id: p.id, name: p.name, action: p.action, value: p.value, previous: p.previous, reason: p.reason, state: p.state, proposedBy: p.proposed_by, proposedAt: p.proposed_at, decidedBy: p.decided_by, decidedAt: p.decided_at, note: p.note });
const note = z.object({ note: z.string().trim().max(500).nullable().optional() }).strict();

/**
 * 1.6.0, Sprint 35c (B-4205): Configuration. Every setting this build reads with what each instance reads; overrides
 * proposed by one platform admin and approved by another (decision Q2). Secret values never leave the server.
 */
export function platformSettingsRoutes(s: Services): Router {
  const r = Router();
  const manage = [noStore, requireAuth(), requirePermission(s, 'platform:manage')];
  const session = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'platform:manage')];
  const settings = s.settings;
  const by = (req: Request): OpsActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, actor: actorFrom(p, ip(req)), userId: p.userId, traceId: req.traceId };
  };

  r.get('/platform/settings', ...manage, async (req, res) => {
    res.json(await settings.view(principalOf(req).userId));
  });

  /** The settings as a .env file, secrets masked; audited, since it describes the deployment. */
  r.get('/platform/settings/export', ...manage, async (req, res) => {
    const changed = req.query.changed === 'true' || req.query.changed === '1';
    const out = settings.envFile(changed);
    await audit(s, by(req), 'platform.settings.exported', { instance: settings.instance }, { lines: out.lines, onlyChanged: changed }, 'admin');
    res.json(out);
  });

  /** Proposes an override (`value`), or removing one (`value: null`); a second platform admin decides (202). */
  r.post('/platform/settings/:name/proposals', ...session, async (req, res) => {
    const body = parseBody(z.object({ value: z.string().max(4000).nullable(), reason: z.string().trim().min(3, 'Give a reason of at least 3 characters.').max(500) }).strict(), req.body);
    res.status(202).json(proposalView(await settings.propose(by(req), String(req.params.name), body.value, body.reason)));
  });

  r.post('/platform/settings/proposals/:id/approve', ...session, async (req, res) => {
    const body = parseBody(note, req.body ?? {});
    const out = await settings.approve(by(req), String(req.params.id), body.note ?? null);
    res.json({ proposal: proposalView(out.proposal), applies: out.applies, applied: out.applied });
  });

  r.post('/platform/settings/proposals/:id/reject', ...session, async (req, res) => {
    const body = parseBody(note, req.body ?? {});
    res.json(proposalView(await settings.reject(by(req), String(req.params.id), body.note ?? null)));
  });

  r.post('/platform/settings/proposals/:id/withdraw', ...session, async (req, res) => {
    res.json(proposalView(await settings.withdraw(by(req), String(req.params.id))));
  });

  return r;
}
