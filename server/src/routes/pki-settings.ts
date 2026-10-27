import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { effectivePermissions } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../http/middleware.js';
import { HttpProblem, notFound } from '../http/problem.js';
import { CustodyUnavailable } from '../pki/keys.js';
import { PkiError, type IssuerRow, type PkiActor } from '../pki/service.js';
import { PKI_SETTING_KEYS, type ProposalRow } from '../pki/settings.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 55 (B-187): Certificates › Settings, under `/api/pki/settings` with pki:manage. Mounted before the
 * CA's own router (`routes/pki.ts`). The platform scope also needs platform:manage and a recent sign-in; changes to
 * the root and intermediates become proposals that a second platform admin approves (never the proposer).
 *
 *   GET  /api/pki/settings                         every setting for the platform and this tenant: value, source,
 *                                                  floor, range; pending proposals; the issuers' current values
 *   PUT  /api/pki/settings                         { scope, values, reset, reason }: saved or proposed
 *   GET  /api/pki/settings/proposals               proposals (?state=pending|applied|rejected|withdrawn|all)
 *   POST /api/pki/settings/proposals/:id/approve   a second platform admin puts it in force
 *   POST /api/pki/settings/proposals/:id/reject    rejected (or withdrawn by its proposer)
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const TITLES: Record<number, string> = { 400: 'Invalid request', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Refused by policy', 502: 'Key store error' };

export const proposalView = (p: ProposalRow) => ({ id: p.id, scope: p.scope, changes: p.changes, state: p.state, reason: p.reason, proposedBy: p.proposed_by, proposedAt: p.proposed_at, decidedBy: p.decided_by, decidedAt: p.decided_at, note: p.note });

/** What an issuer has now, beside what the settings would give it at its next rotation or re-issue. */
const issuerNow = (i: IssuerRow | undefined) => (i ? { id: i.id, name: i.name, keyType: i.key_type, pathLen: i.path_len, notBefore: i.not_before, notAfter: i.not_after, days: Math.round((i.not_after - i.not_before) / 86_400_000), generation: i.generation } : null);

export function pkiSettingsRoutes(s: Services): Router {
  const r = Router();
  r.use('/pki/settings', noStore, requireAuth(), requirePermission(s, 'pki:manage'));
  const recent = requireRecentAuth(s);

  const by = (req: Request): PkiActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
  };
  const platform = (req: Request): boolean => effectivePermissions(principalOf(req)).has('platform:manage');
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PkiError) throw new HttpProblem(err.status, TITLES[err.status] ?? 'Error', err.message, { extensions: err.extensions });
      if (err instanceof CustodyUnavailable) throw new HttpProblem(409, 'Conflict', err.message, { extensions: { step: 'custody' } });
      throw err;
    }
  };

  const view = async (req: Request) => {
    const t = principalOf(req).tenantId;
    const canPlatform = platform(req);
    const ps = s.pkiSettings;
    const [plat, ten, root, inter] = await Promise.all([ps.describe(t, 'platform'), ps.describe(t, 'tenant'), s.pki.activeRoot(), s.pki.activeIntermediate(t)]);
    return {
      configured: await ps.configured(),
      canPlatform,
      platform: plat,
      tenant: ten,
      proposals: canPlatform ? (await ps.proposals('pending')).map(proposalView) : [],
      issuers: { root: issuerNow(root), intermediate: issuerNow(inter) },
      keys: PKI_SETTING_KEYS
    };
  };

  r.get('/pki/settings', async (req, res) => {
    res.json(await view(req));
  });

  r.put('/pki/settings', async (req, res) => {
    const b = parseBody(
      z
        .object({
          scope: z.enum(['platform', 'tenant']),
          values: z.record(z.string().max(64), z.unknown()).refine((o) => Object.keys(o).length <= 60, 'at most 60 settings at once').optional(),
          reset: z.array(z.string().max(64)).max(60).optional(),
          reason: z.string().trim().max(500).nullable().optional()
        })
        .strict()
        .refine((x) => Object.keys(x.values ?? {}).length + (x.reset?.length ?? 0) > 0, 'Send values or reset.'),
      req.body
    );
    // The platform's settings reach every tenant: a recent sign-in, as for the root itself.
    if (b.scope === 'platform') await recent(req, res, () => undefined);
    const out = await run(() => s.pkiSettings.save(by(req), b.scope, { values: b.values ?? {}, reset: b.reset ?? [], reason: b.reason ?? null }, platform(req)));
    res.json({ applied: out.applied, proposal: out.proposal ? proposalView(out.proposal) : null, settings: await view(req) });
  });

  r.get('/pki/settings/proposals', requirePermission(s, 'platform:manage'), async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'applied', 'rejected', 'withdrawn', 'all']).default('pending'), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict(), req.query);
    res.json({ proposals: (await s.pkiSettings.proposals(q.state, q.limit)).map(proposalView) });
  });

  const note = z.object({ note: z.string().trim().max(500).nullable().optional() }).strict();
  const proposalId = (req: Request): string => {
    const id = id26.safeParse(req.params.id);
    if (!id.success) throw notFound('Proposal');
    return id.data;
  };

  r.post('/pki/settings/proposals/:id/approve', requirePermission(s, 'platform:manage'), recent, async (req, res) => {
    const b = parseBody(note, req.body ?? {});
    const out = await run(() => s.pkiSettings.approve(by(req), proposalId(req), b.note ?? null, platform(req)));
    res.json(proposalView(out));
  });

  r.post('/pki/settings/proposals/:id/reject', requirePermission(s, 'platform:manage'), async (req, res) => {
    const b = parseBody(note, req.body ?? {});
    const out = await run(() => s.pkiSettings.reject(by(req), proposalId(req), b.note ?? null, platform(req)));
    res.json(proposalView(out));
  });

  return r;
}
