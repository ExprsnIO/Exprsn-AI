import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears } from '../authz/labels.js';
import { effectivePermissions } from '../authz/policy.js';
import { AtCustodyError } from '../atproto/keys.js';
import { labelJson } from '../atproto/labels.js';
import { AtprotoError, PULL_JOB, type AtActor, type IdentityRow, type InboundRow, type KeyRow, type LabelerRow, type LabelRow } from '../atproto/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../http/middleware.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const curve = z.enum(['secp256k1', 'p256']);
const labelVal = z.string().regex(/^!?[a-z0-9][a-z0-9-]{0,127}$/, 'a label value: lower-case letters, digits and hyphens, optionally after !');
const subject = z.string().trim().min(3).max(2048);
const platformQuery = z.object({ platform: z.enum(['true', 'false']).optional() }).strict();

const TITLES: Record<number, string> = { 400: 'Invalid request', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Unusable DID document', 502: 'Upstream error' };

const keyView = (k: KeyRow) => ({ id: k.id, purpose: k.purpose, curve: k.curve, custody: k.custody, didKey: `did:key:${k.multikey}`, state: k.state, createdAt: k.created_at, retiredAt: k.retired_at });

const labelView = (l: LabelRow) => ({ id: l.id, seq: l.seq, flagId: l.flag_id, createdAt: l.created_at, label: labelJson(l.label) });

const labelerView = (l: LabelerRow) => ({ id: l.id, did: l.did, name: l.name, endpoint: l.endpoint, didKey: l.multikey ? `did:key:${l.multikey}` : null, workspaceId: l.workspace_id, vals: l.vals, state: l.state, cursor: l.cursor, lastPullAt: l.last_pull_at, lastError: l.last_error, received: l.received, rejected: l.rejected, createdAt: l.created_at, updatedAt: l.updated_at });

const inboundView = (r: InboundRow) => ({ id: r.id, seq: r.seq, uri: r.uri, cid: r.cid, val: r.val, neg: r.neg, cts: r.cts, exp: r.exp, flagId: r.flag_id, createdAt: r.created_at });

/**
 * AT-Protocol trust (Sprint 25, B-1608 to B-1611) under `/api/atproto`. Identities and their keys need `pki:manage`
 * (the platform's identity also `platform:manage` and a recent sign-in); labels and the registry of trusted external
 * labelers need `labels:manage`. The public DID documents, queryLabels and subscribeLabels are in `atproto-public.ts`
 * and `atproto/stream.ts`.
 */
export function atprotoRoutes(s: Services): Router {
  const r = Router();
  r.use('/atproto', noStore, requireAuth());
  const keysPerm = requirePermission(s, 'pki:manage');
  const labelsPerm = requirePermission(s, 'labels:manage');
  const recent = requireRecentAuth(s);

  const by = (req: Request): AtActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
  };
  const isPlatform = (req: Request): boolean => effectivePermissions(principalOf(req)).has('platform:manage');

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AtprotoError) throw new HttpProblem(err.status, TITLES[err.status] ?? 'Error', err.message, { extensions: err.extensions });
      if (err instanceof AtCustodyError) throw new HttpProblem(409, 'Conflict', err.message, { extensions: { step: 'custody' } });
      throw err;
    }
  };

  /** `?platform=true` (or `platform: true` in the body) addresses the platform identity: platform admins only. */
  const scope = (req: Request, res: Parameters<RequestHandler>[1], wantsPlatform: boolean): string | null => {
    if (!wantsPlatform) return principalOf(req).tenantId;
    if (!isPlatform(req)) throw forbidden('Only a platform administrator manages the platform identity.', { step: 'permission' });
    recent(req, res, () => undefined);
    return null;
  };

  const identityView = async (i: IdentityRow) => ({
    id: i.id,
    platform: i.tenant_id === null,
    method: i.method,
    did: i.did,
    handle: i.handle,
    host: i.host,
    endpoint: i.endpoint,
    plcCid: i.plc_prev,
    state: i.state,
    keys: (await s.atproto.keysOf(i.id, true)).map(keyView),
    document: await s.atproto.document(i).catch(() => null),
    createdAt: i.created_at,
    updatedAt: i.updated_at
  });

  r.get('/atproto', async (req, res) => {
    const p = principalOf(req);
    const perms = effectivePermissions(p);
    if (!perms.has('pki:manage') && !perms.has('labels:manage')) throw forbidden('This needs pki:manage or labels:manage.', { step: 'permission' });
    const own = await s.atproto.identity(p.tenantId);
    const platform = await s.atproto.identity(null);
    const summary = (i: IdentityRow | undefined) => (i ? { id: i.id, did: i.did, method: i.method, handle: i.handle, endpoint: i.endpoint } : null);
    res.json({ ...s.atproto.info(), identity: summary(own), fallback: own ? null : summary(platform) });
  });

  // ---------- identities and keys (B-1608, B-1609) ----------

  r.get('/atproto/identity', keysPerm, async (req, res) => {
    const q = parseBody(platformQuery, req.query);
    const tenantId = q.platform === 'true' ? (isPlatform(req) ? null : principalOf(req).tenantId) : principalOf(req).tenantId;
    if (q.platform === 'true' && tenantId !== null) throw forbidden('Only a platform administrator reads the platform identity here.', { step: 'permission' });
    const i = await s.atproto.identity(tenantId);
    if (!i) throw notFound('AT-Protocol identity');
    res.json(await identityView(i));
  });

  r.post('/atproto/identity', keysPerm, async (req, res) => {
    const b = parseBody(
      z
        .object({
          platform: z.boolean().default(false),
          method: z.enum(['web', 'plc']),
          handle: z.string().trim().toLowerCase().max(253).nullable().optional(),
          host: z.string().trim().toLowerCase().max(259).nullable().optional(),
          curve: curve.optional(),
          rotationCurve: curve.optional()
        })
        .strict(),
      req.body
    );
    const tenantId = scope(req, res, b.platform);
    const row = await run(() => s.atproto.createIdentity(by(req), tenantId, { method: b.method, ...(b.handle !== undefined ? { handle: b.handle } : {}), host: b.host ?? null, ...(b.curve ? { curve: b.curve } : {}), ...(b.rotationCurve ? { rotationCurve: b.rotationCurve } : {}) }));
    res.status(201).json(await identityView(row));
  });

  r.post('/atproto/identity/rotate', keysPerm, async (req, res) => {
    const b = parseBody(z.object({ platform: z.boolean().default(false), purpose: z.enum(['label', 'rotation']), curve: curve.optional() }).strict(), req.body);
    const tenantId = scope(req, res, b.platform);
    const i = await s.atproto.identity(tenantId);
    if (!i) throw notFound('AT-Protocol identity');
    const out = await run(() => s.atproto.rotateKey(by(req), i, b.purpose, b.curve));
    res.json({ identity: await identityView(out.identity), key: keyView(out.key), retired: keyView(out.retired) });
  });

  // ---------- labels (B-1610) ----------

  r.get('/atproto/labels', labelsPerm, async (req, res) => {
    const q = parseBody(z.object({ uri: subject.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().min(0).optional() }).strict(), req.query);
    const rows = await s.atproto.list(principalOf(req).tenantId, { ...(q.uri ? { uri: q.uri } : {}), limit: q.limit, before: q.before ?? null });
    res.json({ labels: rows.map(labelView) });
  });

  r.post('/atproto/labels', labelsPerm, async (req, res) => {
    const b = parseBody(
      z
        .object({
          uri: subject,
          cid: z.string().regex(/^b[a-z2-7]{8,200}$/, 'a base32 CIDv1').nullable().optional(),
          vals: z.array(labelVal).min(1).max(20).optional(),
          flag: z.string().regex(/^F-\d{1,12}$/i).optional(),
          exp: z.iso.datetime().nullable().optional()
        })
        .strict()
        .refine((x) => Boolean(x.vals) !== Boolean(x.flag), 'give either vals or flag'),
      req.body
    );
    const p = principalOf(req);
    let rows: LabelRow[];
    if (b.flag) {
      const flag = await s.guard.flags.get(p.tenantId, b.flag.toUpperCase()).catch(() => null);
      if (!flag || !clears(p.clearance, flag.label)) throw notFound('Flag');
      rows = await run(() => s.atproto.labelFlag(by(req), p.tenantId, flag, b.uri, b.cid ?? null));
    } else {
      rows = await run(() => s.atproto.emit(by(req), p.tenantId, { uri: b.uri, cid: b.cid ?? null, vals: b.vals!, exp: b.exp ?? null }));
    }
    res.status(rows.length ? 201 : 200).json({ labels: rows.map(labelView) });
  });

  r.post('/atproto/labels/negate', labelsPerm, async (req, res) => {
    const b = parseBody(z.object({ uri: subject, val: labelVal, reason: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    const row = await run(() => s.atproto.negate(by(req), principalOf(req).tenantId, { uri: b.uri, val: b.val, reason: b.reason ?? null }));
    res.status(201).json(labelView(row));
  });

  // ---------- trusted external labelers (B-1611) ----------

  const labeler = async (req: Request): Promise<LabelerRow> => {
    const id = id26.safeParse(req.params.id);
    const l = id.success ? await s.atproto.labeler(principalOf(req).tenantId, id.data) : undefined;
    if (!l) throw notFound('Labeler');
    return l;
  };

  r.get('/atproto/labelers', labelsPerm, async (req, res) => {
    res.json({ labelers: (await s.atproto.labelers(principalOf(req).tenantId)).map(labelerView) });
  });

  r.post('/atproto/labelers', labelsPerm, async (req, res) => {
    const b = parseBody(z.object({ did: z.string().trim().max(300), name: z.string().trim().min(1).max(100), workspaceId: id26.nullable().optional(), vals: z.array(labelVal).max(100).optional() }).strict(), req.body);
    const row = await run(() => s.atproto.addLabeler(by(req), principalOf(req).tenantId, { did: b.did, name: b.name, workspaceId: b.workspaceId ?? null, ...(b.vals ? { vals: b.vals } : {}) }));
    res.status(201).json(labelerView(row));
  });

  r.patch('/atproto/labelers/:id', labelsPerm, async (req, res) => {
    const l = await labeler(req);
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100).optional(), workspaceId: id26.nullable().optional(), vals: z.array(labelVal).max(100).optional(), state: z.enum(['active', 'paused']).optional() }).strict(), req.body);
    res.json(labelerView(await run(() => s.atproto.updateLabeler(by(req), l, b))));
  });

  r.delete('/atproto/labelers/:id', labelsPerm, async (req, res) => {
    const l = await labeler(req);
    await s.atproto.removeLabeler(by(req), l);
    res.status(204).end();
  });

  r.get('/atproto/labelers/:id/labels', labelsPerm, async (req, res) => {
    const l = await labeler(req);
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(), req.query);
    res.json({ labels: (await s.atproto.inbound(l.tenant_id, l.id, q.limit)).map(inboundView) });
  });

  r.post('/atproto/labelers/:id/pull', labelsPerm, async (req, res) => {
    const l = await labeler(req);
    if (l.state !== 'active') throw new HttpProblem(409, 'Conflict', 'This labeler is paused.');
    const p = principalOf(req);
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: PULL_JOB, payload: { labelerId: l.id }, createdBy: p.userId, dedupeKey: `${PULL_JOB}:${l.id}:manual:${Math.floor(Date.now() / 10_000)}`, maxAttempts: 1 });
    await s.audit.append({ tenantId: p.tenantId, action: 'atproto.labeler.pulled', kind: 'admin', actor: actorFrom(p, ip(req)), target: { labeler: l.id, did: l.did, job: job.id }, traceId: req.traceId ?? null });
    res.status(202).json({ job: { id: job.id, state: job.state } });
  });

  return r;
}
