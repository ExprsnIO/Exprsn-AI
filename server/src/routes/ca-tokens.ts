import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { HttpProblem, notFound } from '../http/problem.js';
import { CustodyUnavailable } from '../pki/keys.js';
import { PkiError, type PkiActor } from '../pki/service.js';
import { RESOURCE_TYPES, TICKET_MAX_MINUTES, TOKEN_PERMISSIONS, tokenView, type SignerRow, type TokenPermission } from '../pki/tokens.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 55 (B-188): Certificates › Tokens. Issuing, listing and revoking CA tokens and tickets need
 * pki:manage; validating, introspecting and refreshing a token (what a resource server or a service account does)
 * need pki:tokens. The tenant is the caller's: a token of another tenant is unknown here. Mounted before the CA's own
 * router (`routes/pki.ts`), whose /pki prefix asks for pki:manage.
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const TITLES: Record<number, string> = { 400: 'Invalid request', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Refused by policy', 502: 'Key store error' };
const resource = z.object({ type: z.enum(RESOURCE_TYPES), id: z.string().trim().min(1).max(500) }).strict();
const perm = z.enum(TOKEN_PERMISSIONS as [TokenPermission, ...TokenPermission[]]);
const perms = z.array(perm).min(1).max(TOKEN_PERMISSIONS.length).transform((x) => [...new Set(x)]);
const token = z.string().min(20).max(16_384);
const action = z.string().trim().regex(/^[a-z][a-z0-9._:-]{0,99}$/, 'an action name such as files.download');

const signerView = (sg: SignerRow) => ({ id: sg.id, issuerId: sg.issuer_id, certificateId: sg.certificate_id, alg: sg.alg, keyType: sg.key_type, custody: sg.custody, fingerprint: sg.fingerprint, notAfter: sg.not_after, state: sg.state, createdAt: sg.created_at, retiredAt: sg.retired_at, certificatePem: sg.certificate_pem });

export function caTokenRoutes(s: Services): Router {
  const r = Router();
  const manage = [noStore, requireAuth(), requirePermission(s, 'pki:manage')];
  const use = [noStore, requireAuth(), requirePermission(s, 'pki:tokens')];

  const by = (req: Request): PkiActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PkiError) throw new HttpProblem(err.status, TITLES[err.status] ?? 'Error', err.message, { extensions: err.extensions });
      if (err instanceof CustodyUnavailable) throw new HttpProblem(409, 'Conflict', err.message, { extensions: { step: 'custody' } });
      throw err;
    }
  };
  const idOf = (req: Request): string => {
    const id = id26.safeParse(req.params.id);
    if (!id.success) throw notFound('Token');
    return id.data;
  };

  r.get('/pki/tokens', ...manage, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['active', 'revoked', 'spent', 'replaced']).optional(), kind: z.enum(['token', 'ticket']).optional(), subject: id26.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).strict(), req.query);
    const t = principalOf(req).tenantId;
    const configured = await s.caTokens.configured();
    const v = await s.pki.settings(t);
    res.json({
      configured,
      tokens: configured ? (await s.caTokens.list(t, q)).map(tokenView) : [],
      signers: (await s.caTokens.signers(t)).map(signerView),
      permissions: TOKEN_PERMISSIONS,
      resourceTypes: RESOURCE_TYPES,
      ticketMaxMinutes: TICKET_MAX_MINUTES,
      defaults: { maxBytes: v['tokens.maxBytes'], signature: v['tokens.signature'], expiry: v['tokens.defaultExpiry'], ttlMinutes: v['tokens.defaultTtlMinutes'], uses: v['tokens.defaultUses'], rotationDays: v['tokens.rotationDays'] }
    });
  });

  r.post('/pki/tokens', ...manage, async (req, res) => {
    const b = parseBody(
      z
        .object({
          resource,
          permissions: perms,
          expiry: z.object({ kind: z.enum(['time', 'uses', 'persistent']).optional(), ttlMinutes: z.number().int().min(1).max(525_600).optional(), uses: z.number().int().min(1).max(1_000_000).optional() }).strict().optional(),
          subject: id26.nullable().optional(),
          label: z.string().trim().max(200).nullable().optional()
        })
        .strict(),
      req.body
    );
    const out = await run(() => s.caTokens.issue(by(req), b));
    // The token is shown once: only its id and hash are kept.
    res.status(201).json({ ...tokenView(out.row), token: out.token });
  });

  r.post('/pki/tickets', ...manage, async (req, res) => {
    const b = parseBody(z.object({ resource, permissions: perms, action, ttlMinutes: z.number().int().min(1).max(TICKET_MAX_MINUTES).optional(), subject: id26.nullable().optional(), label: z.string().trim().max(200).nullable().optional() }).strict(), req.body);
    const out = await run(() => s.caTokens.ticket(by(req), b));
    res.status(201).json({ ...tokenView(out.row), token: out.token });
  });

  r.post('/pki/tokens/revoke', ...manage, async (req, res) => {
    const b = parseBody(z.object({ ids: z.array(id26).max(1000).optional(), subject: id26.optional(), resource: resource.optional(), signerId: id26.optional(), all: z.boolean().optional(), reason: z.string().trim().max(100).nullable().optional() }).strict(), req.body);
    res.json(await run(() => s.caTokens.revokeMany(by(req), b)));
  });

  r.post('/pki/tokens/signers/rotate', ...manage, async (req, res) => {
    res.status(201).json(signerView(await run(() => s.caTokens.rotate(by(req)))));
  });

  r.post('/pki/tokens/validate', ...use, async (req, res) => {
    const b = parseBody(z.object({ token, resource: resource.optional(), permission: perm.optional(), action: action.optional(), spend: z.boolean().optional() }).strict(), req.body);
    res.json(await run(() => s.caTokens.validate(by(req), b.token, b)));
  });

  r.post('/pki/tokens/introspect', ...use, async (req, res) => {
    const b = parseBody(z.object({ token }).strict(), req.body);
    res.json(await run(() => s.caTokens.introspect(by(req), b.token)));
  });

  r.post('/pki/tokens/refresh', ...use, async (req, res) => {
    const b = parseBody(z.object({ token }).strict(), req.body);
    const out = await run(() => s.caTokens.refresh(by(req), b.token));
    res.status(201).json({ ...tokenView(out.row), token: out.token });
  });

  r.get('/pki/tokens/:id', ...manage, async (req, res) => {
    const row = await s.caTokens.get(principalOf(req).tenantId, idOf(req));
    if (!row) throw notFound('Token');
    res.json(tokenView(row));
  });

  r.post('/pki/tokens/:id/revoke', ...manage, async (req, res) => {
    const b = parseBody(z.object({ reason: z.string().trim().max(100).nullable().optional() }).strict(), req.body ?? {});
    res.json(tokenView(await run(() => s.caTokens.revoke(by(req), idOf(req), b.reason ?? null))));
  });

  return r;
}
