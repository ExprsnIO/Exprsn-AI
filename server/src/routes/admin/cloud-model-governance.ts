import { Router } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import type { Label } from '../../authz/labels.js';
import type { Principal } from '../../authz/policy.js';
import { modelPriceSchema, modelPriceView, providerOf } from '../../cloud/model-prices.js';
import { attestationTermsSchema, attestationView, instanceScope, SCOPE_CAP } from '../../cloud/model-residency.js';
import { entryView } from '../../cloud/model-import.js';
import type { InstanceRow, ModelRow } from '../../gateway/repo.js';
import { badRequest, conflict, HttpProblem, notFound } from '../../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 61 (B-10505 to B-10508): what the Models screen's cloud card shows and changes.
 *
 *   GET  /admin/cloud/model-cards                                 cloud:read, models:manage   every cloud model the caller can see: provider, account, region, price, residency, guardrail layer, AI Gateway
 *   GET  /admin/cloud/model-prices?provider&model                 cloud:read                  price versions (the table's and the sheet's, unverified flagged)
 *   PUT  /admin/cloud/model-prices                                finops:manage               a price version by hand, priced from its effective day
 *   POST /admin/cloud/accounts/:id/model-prices/refresh           cloud:read, finops:manage   the account's entries priced from the AWS Price List or Azure Retail Prices API
 *   GET  /admin/cloud/attestations?model&account                  cloud:read                  data-terms attestations
 *   POST /admin/cloud/model-entries/:modelId/attestations         cloud:admin                 propose the account's data terms for an entry (dual control)
 *   POST /admin/cloud/attestations/:id/approve                    cloud:admin                 a second cloud admin approves: the ceiling rises to confidential (regional entries only)
 *   POST /admin/cloud/attestations/:id/reject                     cloud:admin                 reject (or withdraw) a proposal
 *   POST /admin/cloud/attestations/:id/revoke                     cloud:admin                 the ceiling drops back to internal, the model's label with it
 *   PUT  /admin/cloud/model-servers/:id/guardrail                 cloud:admin, models:manage  a Bedrock instance's provider guardrail (id, version, mode, enabled), or null to remove it
 *
 * Without migration 163 the price and attestation writes answer 503 `migration_pending`; the reads answer the sheet.
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const providerSchema = z.enum(['aws', 'azure', 'digitalocean', 'cloudflare']);

export const guardrailSettingSchema = z
  .object({
    /** The guardrail's id or ARN. */
    id: z.string().trim().regex(/^(arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d{12}:guardrail\/)?[a-z0-9]{1,64}$/, 'a Bedrock Guardrail id or ARN'),
    /** A published version (`1`, `2`...) or `DRAFT`. */
    version: z.string().trim().regex(/^(DRAFT|[1-9][0-9]{0,7})$/, 'DRAFT or a version number'),
    mode: z.enum(['converse', 'apply']).default('converse'),
    enabled: z.boolean().default(true)
  })
  .strict();

const flavourOf = (row: InstanceRow): string => (row.kind === 'bedrock' ? 'bedrock' : (row.settings.cloud?.flavour ?? 'openai'));

/** B-10908's per-instance setting (`settings.cloud.aiGateway`, `cloud/ai-gateway.ts`), read as the card shows it. */
function aiGatewayView(row: InstanceRow | null) {
  const raw = (row?.settings.cloud as Record<string, unknown> | undefined)?.aiGateway as { accountId?: string; gatewayId?: string; cache?: boolean; logs?: boolean; confidential?: { cache?: boolean; logs?: boolean } } | undefined;
  if (!raw?.gatewayId) return null;
  return { gatewayId: raw.gatewayId, accountId: raw.accountId ?? null, cache: raw.cache !== false, logs: raw.logs !== false, confidential: { cache: raw.confidential?.cache === true, logs: raw.confidential?.logs === true } };
}

export function cloudModelGovernanceRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requirePermission(s, 'cloud:read')];
  const cards = [...read, requirePermission(s, 'models:manage')];
  const finops = [noStore, requireAuth(), requirePermission(s, 'finops:manage')];
  const admin = [noStore, requireAuth(), requirePermission(s, 'cloud:admin')];
  const ctx = (req: Parameters<typeof ip>[0]) => ({ ip: ip(req), traceId: req.traceId });

  /** One model's card: where it runs, its price today, residency, the guardrail layer and AI Gateway. */
  const card = async (p: Principal, m: ModelRow, inst: InstanceRow | null, visible: Map<string, { id: string; name: string; provider: string }>) => {
    const entry = await s.cloud.modelImport.entry(m.id).catch(() => null);
    const accountId = entry?.accountId ?? inst?.settings.cloud?.accountId ?? null;
    const account = accountId ? (visible.get(accountId) ?? null) : null;
    if (!account) return null;
    const provider = (inst ? providerOf(inst) : null) ?? (entry?.provider as 'aws' | 'azure' | 'digitalocean' | 'cloudflare' | undefined) ?? null;
    if (!provider) return null;
    const region = entry?.region ?? inst?.settings.cloud?.region ?? null;
    const priced = provider === 'azure' ? ((entry?.details?.model as { name?: string } | null | undefined)?.name ?? (inst?.settings.reported?.models ?? []).find((x) => x.id === m.name)?.ownedBy ?? m.name) : m.name;
    const price = await s.cloud.modelPrices.card(provider, priced, region === 'global' ? null : region);
    const bare = inst ? instanceScope(inst, m.name) : 'regional';
    const residency = entry ? await s.cloud.modelResidency.view(entry, m.label as Label) : { scope: bare, cap: bare === 'regional' ? null : SCOPE_CAP, ceiling: null, regions: region ? [{ region, allowed: true, ceiling: null, reason: null }] : [], attestation: null, pending: [] };
    const gr = inst?.settings.cloud?.guardrail ?? null;
    const embedding = (m.capabilities ?? []).includes('embedding');
    return {
      modelId: m.id,
      name: m.name,
      label: m.label,
      state: m.state,
      provider,
      flavour: inst ? flavourOf(inst) : (entry?.flavour ?? null),
      account: { id: account.id, name: account.name },
      region,
      routesTo: entry?.routesTo ?? (region ? [region] : []),
      entry: entry ? entryView(entry) : null,
      instance: inst ? { id: inst.id, name: inst.name, kind: inst.kind, health: inst.health } : null,
      price: { ...price, pricedAs: priced },
      residency,
      guardrail: { layer: provider === 'aws' ? (gr ? { ...gr, applies: embedding ? 'not to embeddings' : gr.enabled ? gr.mode : 'off' } : null) : provider === 'azure' ? { contentFilter: 'Azure content filter results recorded as guardrail decisions' } : null, exprsnCheckpoints: 'always: user-input before, model-output after; the provider layer never turns one off' },
      aiGateway: aiGatewayView(inst)
    };
  };

  r.get('/cloud/model-cards', ...cards, async (req, res) => {
    const p = principalOf(req);
    const visible = new Map((await s.cloud.accounts.list(p).catch(() => [])).map((a) => [a.id, { id: a.id, name: a.name, provider: a.provider }]));
    if (!visible.size) return void res.json({ cards: [] });
    const instances = new Map((await s.gateway.repo.instances()).map((i) => [i.id, i]));
    const out = [];
    for (const m of await s.gateway.repo.models()) {
      if (m.format !== 'server') continue;
      const inst = m.server_instance_id ? (instances.get(m.server_instance_id) ?? null) : null;
      if (inst && !providerOf(inst) && !(await s.cloud.modelImport.entry(m.id).catch(() => null))) continue;
      const c = await card(p, m, inst, visible);
      if (c) out.push(c);
    }
    res.json({ cards: out });
  });

  // ---------- prices (B-10505) ----------

  r.get('/cloud/model-prices', ...read, async (req, res) => {
    const q = parseBody(z.object({ provider: providerSchema.optional(), model: z.string().trim().min(1).max(200).optional() }).strict(), req.query);
    res.json({ installed: await s.cloud.modelPrices.installed(), prices: (await s.cloud.modelPrices.list(q)).map(modelPriceView) });
  });

  r.put('/cloud/model-prices', ...finops, async (req, res) => {
    const body = parseBody(modelPriceSchema, req.body);
    const price = await s.cloud.modelPrices.set(principalOf(req), body, ctx(req));
    res.json(modelPriceView(price));
  });

  r.post('/cloud/accounts/:id/model-prices/refresh', ...read, requirePermission(s, 'finops:manage'), async (req, res) => {
    res.json(await s.cloud.modelPrices.refresh(parseBody(id26, req.params.id), principalOf(req), ctx(req)));
  });

  // ---------- attestations (B-10507) ----------

  r.get('/cloud/attestations', ...read, async (req, res) => {
    const q = parseBody(z.object({ model: id26.optional(), account: id26.optional() }).strict(), req.query);
    const visible = new Set((await s.cloud.accounts.list(principalOf(req)).catch(() => [])).map((a) => a.id));
    const list = (await s.cloud.modelResidency.list({ ...(q.model ? { modelId: q.model } : {}), ...(q.account ? { accountId: q.account } : {}) })).filter((a) => visible.has(a.accountId));
    res.json({ installed: await s.cloud.modelResidency.installed(), attestations: list.map(attestationView) });
  });

  r.post('/cloud/model-entries/:modelId/attestations', ...admin, async (req, res) => {
    const terms = parseBody(attestationTermsSchema, req.body);
    res.status(201).json(attestationView(await s.cloud.modelResidency.propose(principalOf(req), parseBody(id26, req.params.modelId), terms, ctx(req))));
  });

  r.post('/cloud/attestations/:id/approve', ...admin, async (req, res) => {
    const out = await s.cloud.modelResidency.approve(principalOf(req), parseBody(id26, req.params.id), ctx(req));
    res.json({ attestation: attestationView(out.attestation), ceiling: out.ceiling });
  });

  r.post('/cloud/attestations/:id/reject', ...admin, async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().default(null) }).strict(), req.body ?? {});
    res.json(attestationView(await s.cloud.modelResidency.reject(principalOf(req), parseBody(id26, req.params.id), { ...ctx(req), note: body.note })));
  });

  r.post('/cloud/attestations/:id/revoke', ...admin, async (req, res) => {
    const out = await s.cloud.modelResidency.revoke(principalOf(req), parseBody(id26, req.params.id), ctx(req));
    res.json({ attestation: attestationView(out.attestation), ceiling: out.ceiling });
  });

  // ---------- the provider guardrail (B-10506) ----------

  r.put('/cloud/model-servers/:id/guardrail', ...admin, requirePermission(s, 'models:manage'), async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ guardrail: guardrailSettingSchema.nullable() }).strict(), req.body);
    const inst = await s.gateway.repo.instance(parseBody(id26, req.params.id));
    if (!inst) throw notFound('Model server');
    if (inst.kind !== 'bedrock' || !inst.settings.cloud) throw badRequest('A provider guardrail is set on a Bedrock model server (kind bedrock).');
    const account = await s.cloud.accounts.getFor(p, inst.settings.cloud.accountId);
    const before = inst.settings.cloud.guardrail ?? null;
    let found: { name?: string; status?: string } | null = null;
    if (body.guardrail?.enabled) {
      // The guardrail must exist in the instance's region (GetGuardrail), so a typo never silently runs unguarded.
      try {
        found = await s.cloud.bedrock.api(account.id, inst.settings.cloud.region).getGuardrail(body.guardrail.id, body.guardrail.version);
      } catch (err) {
        const e = err as { status?: number; message?: string };
        throw new HttpProblem(e.status === 404 ? 409 : 502, e.status === 404 ? 'Conflict' : 'Bad Gateway', `Bedrock did not confirm the guardrail ${body.guardrail.id} version ${body.guardrail.version} in ${inst.settings.cloud.region}: ${(e.message ?? 'no detail').slice(0, 300)}`, { extensions: { reason: 'guardrail_unconfirmed' } });
      }
      if (found.status && !/^(READY|ACTIVE)$/i.test(found.status)) throw conflict(`The guardrail is ${found.status}, not ready.`);
    }
    const cloud = { ...inst.settings.cloud };
    if (body.guardrail) cloud.guardrail = { ...body.guardrail, setBy: p.userId, setAt: Date.now() };
    else delete cloud.guardrail;
    await s.gateway.repo.updateInstance(inst.id, { settings: { ...inst.settings, cloud } });
    await s.audit.append({ tenantId: p.tenantId, action: 'cloud.model-server.guardrail.set', kind: 'admin', actor: actorFrom(p, ip(req)), target: { instance: inst.name }, detail: { before: before ? { id: before.id, version: before.version, mode: before.mode, enabled: before.enabled } : null, after: body.guardrail ? { id: body.guardrail.id, version: body.guardrail.version, mode: body.guardrail.mode, enabled: body.guardrail.enabled } : null, name: found?.name ?? null, exprsnCheckpoints: 'unchanged' }, traceId: req.traceId });
    // The gateway builds the instance's server again with the new layer at its next poll; ask for that poll now.
    await s.gateway.pollAll().catch(() => undefined);
    res.json({ instance: inst.id, guardrail: cloud.guardrail ?? null });
  });

  return r;
}
