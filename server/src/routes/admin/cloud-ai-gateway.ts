import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { aiGatewayConfigSchema, aiGatewaySettingsSchema, aiGatewayPolicy } from '../../cloud/ai-gateway.js';
import { cloudAudit } from '../../cloud/audit.js';
import { CloudProviderError } from '../../cloud/providers/types.js';
import { conflict, HttpProblem, notFound } from '../../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 61 (B-10908): Cloudflare AI Gateway in front of a cloud model instance (`cloud/ai-gateway.ts`).
 *
 *   PUT    /admin/instances/:id/ai-gateway                  pools:manage + cloud:read: { accountId, gatewayId, cache?,
 *                                                            cacheTtl?, logs?, confidential?, customProvider? } on a
 *                                                            Bedrock, Azure OpenAI, DigitalOcean GenAI or Workers AI
 *                                                            instance; its inference calls go through the gateway
 *   DELETE /admin/instances/:id/ai-gateway                  pools:manage: calls go straight to the provider again
 *   PUT    /admin/cloud/accounts/:id/ai-gateways/:gateway   cloud:admin: creates or updates the gateway on the
 *                                                            Cloudflare account (rate limits, default cache TTL, logs
 *                                                            off by default, authentication on)
 *
 * Each change is audited; no token or secret is in a request, an answer or an audit entry.
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');

export function cloudAiGatewayRoutes(s: Services): Router {
  const r = Router();
  const pools = [noStore, requireAuth(), requirePermission(s, 'pools:manage'), requirePermission(s, 'cloud:read')];
  const removeAuth = [noStore, requireAuth(), requirePermission(s, 'pools:manage')];
  const admin = [noStore, requireAuth(), requirePermission(s, 'cloud:admin')];
  const g = s.gateway;

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, detail, traceId: req.traceId });
  };

  const instance = async (req: Request) => {
    const inst = await g.repo.instance(parseBody(id26, req.params.id));
    if (!inst) throw notFound('Instance');
    return inst;
  };

  r.put('/instances/:id/ai-gateway', ...pools, async (req, res) => {
    const inst = await instance(req);
    const settings = parseBody(aiGatewaySettingsSchema, req.body);
    const p = principalOf(req);
    await s.cloud.aiGateway.check(inst, settings, (a) => s.cloud.accounts.canSee(p, a));
    const cloud = inst.settings.cloud;
    if (!cloud) throw conflict('AI Gateway goes in front of a cloud model server only.');
    await g.repo.updateInstance(inst.id, { settings: { ...inst.settings, cloud: { ...cloud, aiGateway: settings } } });
    await audit(req, 'instance.ai_gateway.set', { instance: inst.id, name: inst.name }, { account: settings.accountId, gateway: settings.gatewayId, internal: aiGatewayPolicy(settings, 'internal'), confidential: aiGatewayPolicy(settings, 'confidential'), cacheTtl: settings.cacheTtl, before: cloud.aiGateway ?? null });
    await g.pollOne(inst.id);
    res.json({ instance: inst.id, aiGateway: settings, policy: { public: aiGatewayPolicy(settings, 'public'), internal: aiGatewayPolicy(settings, 'internal'), confidential: aiGatewayPolicy(settings, 'confidential'), restricted: aiGatewayPolicy(settings, 'restricted') } });
  });

  r.delete('/instances/:id/ai-gateway', ...removeAuth, async (req, res) => {
    const inst = await instance(req);
    const cloud = inst.settings.cloud;
    if (cloud?.aiGateway) {
      const { aiGateway, ...rest } = cloud;
      await g.repo.updateInstance(inst.id, { settings: { ...inst.settings, cloud: rest } });
      await audit(req, 'instance.ai_gateway.removed', { instance: inst.id, name: inst.name }, { account: aiGateway.accountId, gateway: aiGateway.gatewayId });
      await g.pollOne(inst.id);
    }
    res.status(204).end();
  });

  r.put('/cloud/accounts/:id/ai-gateways/:gateway', ...admin, async (req, res) => {
    const p = principalOf(req);
    const account = await s.cloud.accounts.getFor(p, parseBody(id26, req.params.id));
    if (account.provider !== 'cloudflare') throw conflict(`${account.name} is not a Cloudflare account; AI Gateway needs one.`);
    const body = parseBody(aiGatewayConfigSchema.omit({ gatewayId: true }), req.body);
    const gatewayId = parseBody(aiGatewayConfigSchema.shape.gatewayId, req.params.gateway);
    let out: { id: string; created: boolean };
    try {
      out = await s.cloud.aiGateway.ensure(account.id, { ...body, gatewayId });
    } catch (err) {
      if (err instanceof CloudProviderError) throw new HttpProblem(err.status >= 500 ? 502 : 409, 'Cloudflare refused', err.message, { extensions: { reason: err.code ?? 'provider_error' } });
      throw err;
    }
    await cloudAudit(s, { tenantId: p.tenantId, action: out.created ? 'cloud.ai_gateway.created' : 'cloud.ai_gateway.updated', actor: { principal: p, ip: ip(req), traceId: req.traceId }, label: 'internal', detail: { account: account.id, gateway: gatewayId, rateLimit: body.rateLimit, cacheTtl: body.cacheTtl, logs: body.logs, authentication: body.authentication } });
    res.status(out.created ? 201 : 200).json({ account: account.id, gateway: gatewayId, created: out.created, ...body });
  });

  return r;
}
