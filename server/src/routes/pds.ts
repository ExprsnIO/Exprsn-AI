import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { newestSeq } from '../atproto/pds/sequencer.js';
import { feedRecordView, type PublishTarget } from '../atproto/pds/feeds.js';
import { accountView, appPasswordView, hostingView, inviteView, REPO_OBJECT, XrpcError, type PdsAccountRow, type PdsActor } from '../atproto/pds/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../http/middleware.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import { objectHash } from '../moderation/registry.js';
import type { Services } from '../services.js';

/**
 * The PDS under /api (1.5.0, Sprint 31: B-2901 to B-2905 and B-3004); the XRPC side is `pds-xrpc.ts`.
 *
 * - `/api/admin/pds/tenants` (platform:manage and a recent sign-in): hosting on or off per tenant, and asking the
 *   relays to crawl now. Hosting is opt-in per tenant, enabled by a platform admin (decision of 2026-10-05).
 * - `/api/admin/pds/...` (pds:manage): the tenant's hosting settings, accounts (deactivate, activate, take down and
 *   restore through moderation, B-19), invite codes, and published feed generator records (B-3004).
 * - `/api/me/pds/...` (atproto:link, a browser session): the user's own account, handle and app passwords, and the
 *   single-use code that confirms a move to another PDS.
 *
 * Every change is audited (`pds.*`); app passwords, invite codes and the move code are shown once.
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const reason = z.string().trim().min(1).max(500);
const mime = z.string().trim().toLowerCase().regex(/^[a-z]+\/([a-z0-9.+-]+|\*)$/).max(100);

const TITLES: Record<number, string> = { 400: 'Invalid request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 429: 'Too many requests', 502: 'Upstream error', 503: 'Unavailable' };

export function pdsRoutes(s: Services): Router {
  const r = Router();
  r.use('/admin/pds', noStore);
  r.use('/me/pds', noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'atproto:link'));
  const manage = [requireAuth(), requirePermission(s, 'pds:manage')];
  const platform = [requireAuth({ sessionOnly: true }), requirePermission(s, 'platform:manage'), requireRecentAuth(s)];
  const recent = requireRecentAuth(s);

  const by = (req: Request): PdsActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof XrpcError) throw new HttpProblem(err.status, TITLES[err.status] ?? 'Error', err.message, { extensions: { error: err.error } });
      throw err;
    }
  };
  const platformInfo = () => ({ maxBlobBytes: s.cfg.PDS_BLOB_MAX_BYTES, blobTypes: s.cfg.PDS_BLOB_TYPES });

  const tenantAccount = async (req: Request): Promise<PdsAccountRow> => {
    const id = parseBody(id26, req.params.id);
    const a = await s.pds.accountById(id);
    if (!a || a.tenant_id !== principalOf(req).tenantId) throw notFound('Account');
    return a;
  };
  const withUser = async (a: PdsAccountRow) => accountView(a, { username: (await s.users.get(a.tenant_id, a.user_id))?.username ?? null, records: await s.pds.recordCount(a.id) });

  // ---------- platform: hosting per tenant and relays ----------

  r.get('/admin/pds/tenants', ...platform, async (_req, res) => {
    const tenants = await s.tenants.list();
    const rows = await Promise.all(tenants.map(async (t) => ({ tenantId: t.id, slug: t.slug, name: t.name, ...hostingView(await s.pds.hosting(t.id), platformInfo()) })));
    res.json({ tenants: rows, service: { did: s.pds.serviceDid(), endpoint: s.pds.publicUrl(), handleDomain: s.pds.handleDomain(), zone: s.cfg.PDS_ZONE, custody: s.atproto.keys.custody(), relays: await s.pds.crawlState() } });
  });

  r.put('/admin/pds/tenants/:tid', ...platform, async (req, res) => {
    const tid = parseBody(id26, req.params.tid);
    const b = parseBody(z.object({ enabled: z.boolean(), zone: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).optional() }).strict(), req.body);
    const row = await run(() => (b.enabled ? s.pds.enable(by(req), tid, { zone: b.zone }) : s.pds.disable(by(req), tid)));
    res.json(hostingView(row, platformInfo()));
  });

  r.post('/admin/pds/crawl', ...platform, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    const relays = await s.pds.requestCrawl({ force: true });
    await s.audit.append({ tenantId: principalOf(req).tenantId, action: 'pds.crawl.requested', kind: 'admin', actor: actorFrom(principalOf(req), ip(req)), target: { host: s.pds.host() }, detail: { relays: relays.map((x) => ({ relay: x.relay, status: x.status, error: x.error })) }, traceId: req.traceId });
    res.json({ host: s.pds.host(), relays });
  });

  // ---------- the tenant's hosting ----------

  r.get('/admin/pds', ...manage, async (req, res) => {
    const tenantId = principalOf(req).tenantId;
    const h = await s.pds.hosting(tenantId);
    const counts = (await s.db('pds_accounts').where({ tenant_id: tenantId }).groupBy('state').select('state').count({ n: '*' })) as { state: string; n: number | string }[];
    res.json({
      ...hostingView(h, platformInfo()),
      accounts: Object.fromEntries(counts.map((c) => [c.state, Number(c.n)])),
      service: { did: s.pds.serviceDid(), endpoint: s.pds.publicUrl(), subscribeRepos: `${s.pds.publicUrl().replace(/^http/, 'ws')}/xrpc/com.atproto.sync.subscribeRepos`, seq: await newestSeq(s.db), custody: s.atproto.keys.custody(), curves: s.atproto.keys.curves() }
    });
  });

  r.patch('/admin/pds/settings', ...manage, async (req, res) => {
    const b = parseBody(z.object({ inviteRequired: z.boolean().optional(), blobMaxBytes: z.number().int().min(1024).nullable().optional(), blobTypes: z.array(mime).min(1).max(20).nullable().optional() }).strict(), req.body);
    const row = await run(() => s.pds.updateSettings(by(req), principalOf(req).tenantId, b));
    res.json(hostingView(row, platformInfo()));
  });

  // ---------- accounts ----------

  r.get('/admin/pds/accounts', ...manage, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['active', 'deactivated', 'takendown']).optional(), q: z.string().trim().max(253).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().min(0).optional() }).strict(), req.query);
    const rows = await s.pds.accounts(principalOf(req).tenantId, q);
    res.json({ accounts: await Promise.all(rows.map(withUser)) });
  });

  r.get('/admin/pds/accounts/:id', ...manage, async (req, res) => {
    res.json(await withUser(await tenantAccount(req)));
  });

  r.post('/admin/pds/accounts/:id/deactivate', ...manage, async (req, res) => {
    const b = parseBody(z.object({ reason }).strict(), req.body);
    const a = await tenantAccount(req);
    res.json(await withUser(await run(() => s.pds.deactivate(by(req), a, b.reason))));
  });

  r.post('/admin/pds/accounts/:id/activate', ...manage, async (req, res) => {
    const a = await tenantAccount(req);
    res.json(await withUser(await run(() => s.pds.activate(by(req), a))));
  });

  // A takedown is a moderation action on the `pds-repo` object (B-1903): audited, told to the owner, appealable.
  r.post('/admin/pds/accounts/:id/takedown', ...manage, async (req, res) => {
    const b = parseBody(z.object({ reason }).strict(), req.body);
    const a = await tenantAccount(req);
    if (a.state === 'takendown') throw new HttpProblem(409, 'Conflict', 'This repo is already taken down.');
    const p = principalOf(req);
    const action = await s.moderation.takeDown({ tenantId: p.tenantId, principal: p, actor: actorFrom(p, ip(req)), traceId: req.traceId }, REPO_OBJECT, a.id, b.reason);
    await s.db('pds_accounts').where({ id: a.id }).update({ takedown_ref: action.id });
    res.json({ account: await withUser((await s.pds.accountById(a.id))!), action });
  });

  r.post('/admin/pds/accounts/:id/restore', ...manage, async (req, res) => {
    const b = parseBody(z.object({ reason }).strict(), req.body);
    const a = await tenantAccount(req);
    if (a.state !== 'takendown') throw new HttpProblem(409, 'Conflict', 'This repo is not taken down.');
    const p = principalOf(req);
    const live = (await s.db('moderation_actions').where({ tenant_id: p.tenantId, object_hash: objectHash(REPO_OBJECT, a.id), state: 'applied' }).orderBy('created_at', 'desc').first('id')) as { id: string } | undefined;
    if (!live) throw new HttpProblem(409, 'Conflict', 'No moderation action keeps this repo down.');
    const out = await s.moderation.reverse({ tenantId: p.tenantId, principal: p, actor: actorFrom(p, ip(req)), traceId: req.traceId }, live.id, b.reason);
    res.json({ account: await withUser((await s.pds.accountById(a.id))!), action: out.action, restored: out.restored });
  });

  // ---------- invite codes ----------

  r.get('/admin/pds/invites', ...manage, async (req, res) => {
    res.json({ invites: (await s.pds.invites(principalOf(req).tenantId)).map(inviteView) });
  });

  r.post('/admin/pds/invites', ...manage, async (req, res) => {
    const b = parseBody(z.object({ usesMax: z.number().int().min(1).max(1000).default(1), expiresInDays: z.number().int().min(1).max(365).nullable().optional(), note: z.string().trim().max(200).nullable().optional() }).strict(), req.body ?? {});
    const out = await run(() => s.pds.createInvite(by(req), principalOf(req).tenantId, b));
    res.status(201).json({ ...inviteView(out.invite), code: out.code, notice: 'This is the only time the invite code is shown.' });
  });

  r.delete('/admin/pds/invites/:id', ...manage, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    if (!(await s.pds.disableInvite(by(req), principalOf(req).tenantId, id))) throw notFound('Invite code');
    res.status(204).end();
  });

  // ---------- feed generator records (B-3004) ----------

  const target = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('hosted'), accountId: id26 }).strict(),
    z.object({ kind: z.literal('external'), identifier: z.string().trim().min(3).max(300), appPassword: z.string().min(1).max(100), pdsUrl: z.string().url().max(500).optional() }).strict()
  ]);

  r.get('/admin/pds/feed-generators', ...manage, async (req, res) => {
    res.json({ records: (await s.pds.feeds.list(principalOf(req).tenantId)).map(feedRecordView) });
  });

  r.post('/admin/pds/feed-generators', ...manage, async (req, res) => {
    const b = parseBody(
      z
        .object({
          target,
          serviceDid: z.string().trim().max(300),
          rkey: z.string().trim().min(1).max(64),
          displayName: z.string().trim().min(1).max(64),
          description: z.string().trim().max(3000).optional(),
          acceptsInteractions: z.boolean().optional(),
          contentMode: z.enum(['app.bsky.feed.defs#contentModeUnspecified', 'app.bsky.feed.defs#contentModeVideo']).optional()
        })
        .strict(),
      req.body
    );
    const row = await run(() => s.pds.feeds.publish(by(req), principalOf(req).tenantId, b.target as PublishTarget, b));
    res.status(201).json(feedRecordView(row));
  });

  r.post('/admin/pds/feed-generators/:id/withdraw', ...manage, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const b = parseBody(z.object({ identifier: z.string().trim().min(3).max(300).optional(), appPassword: z.string().min(1).max(100).optional(), pdsUrl: z.string().url().max(500).optional() }).strict(), req.body ?? {});
    const row = await s.pds.feeds.get(principalOf(req).tenantId, id);
    if (!row) throw notFound('Feed generator record');
    await run(() => s.pds.feeds.withdraw(by(req), row, b.identifier && b.appPassword ? { identifier: b.identifier, appPassword: b.appPassword, pdsUrl: b.pdsUrl } : undefined));
    res.status(204).end();
  });

  // ---------- the user's own account ----------

  const mine = async (req: Request): Promise<PdsAccountRow> => {
    const a = await s.pds.accountByUser(principalOf(req).userId);
    if (!a) throw notFound('AT-Protocol account');
    return a;
  };

  r.get('/me/pds', async (req, res) => {
    const p = principalOf(req);
    const h = await s.pds.hosting(p.tenantId);
    const a = await s.pds.accountByUser(p.userId);
    res.json({
      hosting: { enabled: !!h?.enabled, handleDomain: h?.enabled ? h.handle_domain : null, endpoint: s.pds.publicUrl() },
      account: a ? accountView(a, { records: await s.pds.recordCount(a.id) }) : null,
      appPasswords: a ? (await s.pds.appPasswords(a.id)).map(appPasswordView) : []
    });
  });

  r.post('/me/pds', recent, async (req, res) => {
    const b = parseBody(z.object({ handle: z.string().trim().toLowerCase().min(3).max(253) }).strict(), req.body);
    const p = principalOf(req);
    const h = await s.pds.hosting(p.tenantId);
    if (!h?.enabled) throw new HttpProblem(409, 'Conflict', 'Your organisation does not host AT-Protocol accounts; a platform admin enables it.');
    const user = await s.users.get(p.tenantId, p.userId);
    if (!user) throw notFound('User');
    const a = await run(() => s.pds.createAccount(by(req), { user, handle: b.handle, hosting: h, via: 'console' }));
    res.status(201).json(accountView(a, { records: 0 }));
  });

  r.put('/me/pds/handle', recent, async (req, res) => {
    const b = parseBody(z.object({ handle: z.string().trim().toLowerCase().min(3).max(253) }).strict(), req.body);
    const a = await mine(req);
    res.json(accountView(await run(() => s.pds.updateHandle(by(req), a, b.handle))));
  });

  r.post('/me/pds/deactivate', async (req, res) => {
    const a = await mine(req);
    res.json(accountView(await run(() => s.pds.deactivate(by(req), a, 'Deactivated by the account holder'))));
  });

  r.post('/me/pds/activate', async (req, res) => {
    const a = await mine(req);
    res.json(accountView(await run(() => s.pds.activate(by(req), a))));
  });

  // App passwords: a recent sign-in, and a fresh second factor when the account has one (as for DAV, B-3101).
  r.post('/me/pds/app-passwords', recent, async (req, res) => {
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100), privileged: z.boolean().default(false) }).strict(), req.body);
    const p = principalOf(req);
    const session = req.authSession!;
    if ((await s.mfa.factors(p.userId)).length && (!session.mfa_verified_at || Date.now() - session.mfa_verified_at > s.cfg.STEPUP_WINDOW_SECONDS * 1000)) {
      throw new HttpProblem(401, 'Step-up required', 'Confirm with your second factor (a code or a passkey) to create an app password.', { extensions: { step_up: true, factor: true, window_seconds: s.cfg.STEPUP_WINDOW_SECONDS } });
    }
    const a = await mine(req);
    if (a.state === 'takendown') throw forbidden('This account has been taken down.', { step: 'state' });
    const out = await run(() => s.pds.createAppPassword(by(req), a, b));
    res.status(201).json({ ...appPasswordView(out.row), password: out.password, identifier: a.handle, server: s.pds.publicUrl(), notice: 'This is the only time the app password is shown.' });
  });

  r.delete('/me/pds/app-passwords/:id', async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const a = await mine(req);
    if (!(await s.pds.revokeAppPassword(by(req), a, id))) throw notFound('App password');
    res.status(204).end();
  });

  r.post('/me/pds/plc-token', recent, async (req, res) => {
    const a = await mine(req);
    const out = await run(() => s.pds.migration.plcToken(by(req), a));
    res.status(201).json({ ...out, notice: 'Give this code to the tool moving your account (signPlcOperation). It works once, within 15 minutes.' });
  });

  return r;
}
