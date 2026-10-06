import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../http/middleware.js';
import { forbidden, notFound } from '../http/problem.js';
import { repoView } from '../imports/repositories.js';
import { FACETS, REPO_TYPE_INFO, REPO_TYPES } from '../imports/types.js';
import type { Services } from '../services.js';

/**
 * 1.5.0, Sprint 30 (B-3801 to B-3803): the import wizard's server side, under `/api/imports`. The Import screen
 * (B-3807) is built on these: repositories (dual-controlled), catalogue browse with facets, the select and review
 * steps (inspect, gate, plan), the Imports queue, licence exceptions for the legal-review role, settings and quota.
 */
const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const itemId = z.string().trim().min(1).max(300).regex(/^[^\0\s][^\0]*$/);
const name = z.string().trim().min(1).max(120);
const region = z.string().trim().min(1).max(40);
const hostList = z.array(z.string().trim().min(1).max(253)).max(30);
const options = z.record(z.string().max(40), z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(300)).max(500)])).refine((o) => Object.keys(o).length <= 20, 'At most 20 options');
const credentialRef = z.string().trim().max(300).nullable();
const credential = z.string().min(1).max(4000).nullable();
const harvestMinutes = z.number().int().min(15).max(60 * 24 * 31).nullable();

const planBody = z
  .object({
    repositoryId: id26,
    item: itemId,
    revision: z.string().trim().min(1).max(100).nullable().optional(),
    variants: z.array(z.string().max(400)).max(20).optional(),
    files: z.array(z.string().max(400)).max(500).optional(),
    target: z.literal('models').default('models'),
    label: z.enum(LABELS).default('internal'),
    licence: z.string().trim().min(1).max(120).nullable().optional(),
    attribution: z.string().trim().max(500).nullable().optional(),
    tag: z.string().trim().min(1).max(200).nullable().optional(),
    quantization: z.enum(['Q4_K_M', 'Q5_K_M', 'Q8_0', 'F16']).nullable().optional(),
    poolId: id26.nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    exception: z.object({ reason: z.string().trim().max(1000).nullable().optional() }).strict().nullable().optional()
  })
  .strict();

export function importRoutes(s: Services): Router {
  const r = Router();
  const im = () => s.imports;
  r.use(['/imports', '/admin/tenants/:tid/import-quota'], noStore, requireAuth());
  const run = requirePermission(s, 'imports:run');
  const repos = requirePermission(s, 'imports:repositories');
  const review = requirePermission(s, 'imports:review');
  const platform = requirePermission(s, 'platform:manage');
  const trace = (req: Request) => req.traceId;

  // ---------- types, settings, quota ----------

  r.get('/imports/types', run, (_req, res) => {
    res.json(REPO_TYPES.map((t) => ({ ...REPO_TYPE_INFO[t], facets: Object.fromEntries(REPO_TYPE_INFO[t].kinds.map((k) => [k, FACETS[k].map(([key, label]) => ({ key, label }))])) })));
  });

  r.get('/imports/settings', requireAnyPermission(s, ['imports:run', 'imports:review']), async (req, res) => {
    res.json(await im().settings(principalOf(req).tenantId));
  });

  r.put('/imports/settings/licences', review, async (req, res) => {
    const { allowedLicences } = parseBody(z.object({ allowedLicences: z.array(z.string().trim().min(1).max(120)).max(500) }).strict(), req.body);
    res.json(await im().setLicences(principalOf(req), allowedLicences, trace(req)));
  });

  r.get('/imports/quota', requireAnyPermission(s, ['imports:run', 'usage:read']), async (req, res) => {
    res.json(await im().quota(principalOf(req).tenantId));
  });

  r.put('/admin/tenants/:tid/import-quota', requirePermission(s, 'tenant:manage', (req) => ({ tenantId: String(req.params.tid) })), async (req, res) => {
    const p = principalOf(req);
    if (!p.roles.includes('system-admin')) throw forbidden('Only a system admin sets a tenant\'s import quota.', { step: 'role' });
    const t = await s.tenants.byId(parseBody(id26, req.params.tid));
    if (!t) throw notFound('Tenant');
    const { maxBytes } = parseBody(z.object({ maxBytes: z.number().int().min(0).max(1e16).nullable() }).strict(), req.body);
    res.json(await im().setQuota(p, t.id, maxBytes, trace(req)));
  });

  // ---------- repositories (B-3801) ----------

  r.get('/imports/repositories', run, async (req, res) => {
    res.json((await im().repositories.list(principalOf(req).tenantId)).map((x) => repoView(x)));
  });

  r.post('/imports/repositories', repos, async (req, res) => {
    const body = parseBody(
      z
        .object({
          name,
          type: z.enum(REPO_TYPES),
          baseUrl: z.string().trim().url().max(500).nullable().optional(),
          region: region.default('Global'),
          kinds: z.array(z.enum(['model', 'dataset'])).min(1).max(2).optional(),
          extraHosts: hostList.optional(),
          options: options.optional(),
          credentialRef: credentialRef.optional(),
          credential: credential.optional(),
          licencePolicy: z.string().trim().max(1000).nullable().optional(),
          harvestMinutes: harvestMinutes.optional()
        })
        .strict(),
      req.body
    );
    res.status(201).json(repoView(await im().repositories.propose(principalOf(req), body, trace(req))));
  });

  r.get('/imports/repositories/:id', run, async (req, res) => {
    res.json(repoView(await im().repositories.get(principalOf(req).tenantId, parseBody(id26, req.params.id))));
  });

  r.patch('/imports/repositories/:id', repos, async (req, res) => {
    const body = parseBody(z.object({ name: name.optional(), region: region.optional(), options: options.optional(), credentialRef: credentialRef.optional(), credential: credential.optional(), licencePolicy: z.string().trim().max(1000).nullable().optional(), harvestMinutes: harvestMinutes.optional() }).strict(), req.body);
    res.json(repoView(await im().repositories.update(principalOf(req), parseBody(id26, req.params.id), body, trace(req))));
  });

  r.delete('/imports/repositories/:id', repos, async (req, res) => {
    await im().repositories.remove(principalOf(req), parseBody(id26, req.params.id), trace(req));
    res.status(204).end();
  });

  const note = z.object({ note: z.string().trim().max(500).nullable().optional() }).strict();

  r.post('/imports/repositories/:id/confirm', repos, async (req, res) => {
    const { note: n } = parseBody(note, req.body ?? {});
    const out = await im().repositories.confirm(principalOf(req), parseBody(id26, req.params.id), n ?? null, trace(req));
    res.json({ ...repoView(out.repository), harvestJobId: out.jobId });
  });

  r.post('/imports/repositories/:id/reject', repos, async (req, res) => {
    const { note: n } = parseBody(note, req.body ?? {});
    res.json(repoView(await im().repositories.reject(principalOf(req), parseBody(id26, req.params.id), n ?? null, trace(req))));
  });

  r.post('/imports/repositories/:id/enable', repos, async (req, res) => {
    res.json(repoView(await im().repositories.setEnabled(principalOf(req), parseBody(id26, req.params.id), true, trace(req))));
  });

  r.post('/imports/repositories/:id/disable', repos, async (req, res) => {
    res.json(repoView(await im().repositories.setEnabled(principalOf(req), parseBody(id26, req.params.id), false, trace(req))));
  });

  r.post('/imports/repositories/:id/harvest', repos, async (req, res) => {
    res.status(202).json({ jobId: await im().repositories.harvestNow(principalOf(req), parseBody(id26, req.params.id), trace(req)) });
  });

  r.post('/imports/repositories/:id/check', repos, async (req, res) => {
    res.json(repoView(await im().repositories.probe(principalOf(req), parseBody(id26, req.params.id))));
  });

  // ---------- catalogue browse (B-3802) ----------

  r.get('/imports/repositories/:id/catalog', run, async (req, res) => {
    const p = principalOf(req);
    const repo = await im().repositories.active(p.tenantId, parseBody(id26, req.params.id));
    const q = parseBody(
      z.object({ kind: z.enum(['model', 'dataset']).optional(), q: z.string().max(200).default(''), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(100_000).default(0), live: z.enum(['auto', 'on', 'off']).default('auto') }).passthrough(),
      req.query
    );
    const kind = q.kind ?? repo.kinds[0]!;
    const keys = new Set(FACETS[kind].map(([k]) => k));
    const facets: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      const m = /^facet\.(\w{1,40})$/.exec(k);
      if (m && keys.has(m[1]!) && typeof v === 'string' && v.length <= 200) facets[m[1]!] = v;
    }
    const out = await im().catalog.browse(repo, { kind, q: q.q, facets, limit: q.limit, offset: q.offset, live: q.live });
    const fresh = await im().repositories.get(p.tenantId, repo.id);
    res.json({ repository: repoView(fresh), kind, query: q.q, selected: facets, limit: q.limit, offset: q.offset, snapshotAt: fresh.snapshot_at, ...out });
  });

  // ---------- select and review (B-3803) ----------

  r.get('/imports/repositories/:id/item', run, async (req, res) => {
    const q = parseBody(z.object({ id: itemId, revision: z.string().trim().min(1).max(100).optional() }).strict(), req.query);
    res.json(await im().inspect(principalOf(req), parseBody(id26, req.params.id), q.id, q.revision ?? null));
  });

  r.post('/imports/repositories/:id/gate', run, async (req, res) => {
    const { item } = parseBody(z.object({ item: itemId }).strict(), req.body);
    res.json(await im().acceptGate(principalOf(req), parseBody(id26, req.params.id), item, trace(req)));
  });

  r.post('/imports/plan', run, async (req, res) => {
    const plan = await im().plan(principalOf(req), parseBody(planBody, req.body));
    res.json({ ...plan, selected: plan.selected.map((f) => f.name) });
  });

  // ---------- the queue ----------

  r.get('/imports', run, async (req, res) => {
    const q = parseBody(z.object({ state: z.string().max(30).optional(), kind: z.enum(['model', 'dataset']).optional(), q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict(), req.query);
    res.json(await im().list(principalOf(req), q));
  });

  r.post('/imports', run, async (req, res) => {
    res.status(201).json(await im().request(principalOf(req), parseBody(planBody, req.body), trace(req)));
  });

  r.get('/imports/exceptions', requireAnyPermission(s, ['imports:run', 'imports:review']), async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'granted', 'refused', 'withdrawn']).optional() }).strict(), req.query);
    res.json(await im().exceptions(principalOf(req), q.state));
  });

  r.post('/imports/exceptions/:id/decision', review, async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['grant', 'refuse']), note: z.string().trim().max(1000).nullable().optional() }).strict(), req.body);
    res.json(await im().decide(principalOf(req), parseBody(id26, req.params.id), body.decision, body.note ?? null, trace(req)));
  });

  r.get('/imports/bundle-requests', platform, async (req, res) => {
    const p = principalOf(req);
    res.json(await im().bundleRequests(p.roles.includes('system-admin') ? null : p.tenantId));
  });

  r.get('/imports/proxy-allowlist', platform, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ format: z.enum(['json', 'squid']).default('json') }).strict(), req.query);
    const list = await im().repositories.allowList(p.roles.includes('system-admin') ? null : p.tenantId);
    if (q.format === 'squid') {
      res.type('text/plain').send(`# Exprsn-AI import allow-list, ${new Date().toISOString()}\n${list.map((h) => (h.host.startsWith('*.') ? h.host.slice(1) : h.host)).join('\n')}\n`);
      return;
    }
    res.json({ proxy: im().fetcher.viaProxy, hosts: list });
  });

  r.get('/imports/:id', run, async (req, res) => {
    const p = principalOf(req);
    res.json(await im().view(p.tenantId, await im().get(p, parseBody(id26, req.params.id))));
  });

  r.post('/imports/:id/cancel', run, async (req, res) => {
    res.json(await im().cancel(principalOf(req), parseBody(id26, req.params.id), trace(req)));
  });

  r.post('/imports/:id/retry', run, async (req, res) => {
    res.json(await im().retry(principalOf(req), parseBody(id26, req.params.id), trace(req)));
  });

  return r;
}
