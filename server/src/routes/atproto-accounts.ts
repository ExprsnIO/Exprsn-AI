import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { AtAccountError, type AccountActor, type UserDidRow } from '../atproto/accounts.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../http/middleware.js';
import { HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { setFedCookie } from './federation-public.js';

const TITLES: Record<number, string> = { 400: 'Invalid request', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Refused', 502: 'Upstream error' };

/** A handle (domain name) or a did:plc / did:web. */
const account = z.string().trim().min(3).max(300);
const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

const view = (r: UserDidRow) => ({
  id: r.id,
  did: r.did,
  verified: !!r.verified_did,
  proof: r.proof,
  handle: r.handle,
  handleCheckedAt: r.handle_checked_at,
  pds: r.pds,
  challengePending: !!(r.challenge_hash && r.challenge_expires_at && r.challenge_expires_at > Date.now()),
  challengeExpiresAt: r.challenge_hash ? r.challenge_expires_at : null,
  verifiedAt: r.verified_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

/**
 * Sprint 26 (B-1807, B-1808): a user's own AT-Protocol DID and handle under `/api/me/atproto` (`atproto:link`, a
 * browser session; claiming and linking also need a recent sign-in, since a bound DID signs in as the user), the
 * tenant's bindings under `/api/admin/atproto` (`identity:manage`), and the resolution check an identity admin runs
 * before adding an AT-Protocol user store. The sign-in pages themselves are in `federation-public.ts`.
 */
export function atprotoAccountRoutes(s: Services): Router {
  const r = Router();
  r.use('/me/atproto', noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'atproto:link'));
  r.use('/admin/atproto/accounts', noStore, requireAuth(), requirePermission(s, 'identity:manage'));
  const recent = requireRecentAuth(s);

  const by = (req: Request): AccountActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), traceId: req.traceId };
  };

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AtAccountError) throw new HttpProblem(err.status, TITLES[err.status] ?? 'Error', err.message, { extensions: err.extensions });
      throw err;
    }
  };

  // ---------- the signed-in user's own DID ----------

  r.get('/me/atproto', async (req, res) => {
    const p = principalOf(req);
    const row = await s.atprotoAccounts.binding(p.tenantId, p.userId);
    res.json({ binding: row ? view(row) : null });
  });

  /** Claims a DID (or the DID a handle names) and returns the challenge once. */
  r.post('/me/atproto/claim', recent, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ account }).strict(), req.body);
    const out = await run(() => s.atprotoAccounts.claim(by(req), p.userId, body.account));
    res.status(201).json({
      binding: view(out.row),
      challenge: {
        token: out.token,
        expiresAt: out.expiresAt,
        instructions: `Add ${out.token} to the description of your profile (for example in the Bluesky app), then verify. You can remove it afterwards.`
      }
    });
  });

  /** Checks the open challenge in the account's profile record; on success the DID is bound. */
  r.post('/me/atproto/verify', async (req, res) => {
    const p = principalOf(req);
    parseBody(z.object({}).strict(), req.body ?? {});
    const row = await run(() => s.atprotoAccounts.verify(by(req), p.userId));
    res.json({ binding: view(row) });
  });

  /**
   * Proves control by signing in at the account's own authorization server: returns the address to send the browser
   * to (the console follows it); the callback binds the DID to this user if this session is still signed in.
   */
  r.post('/me/atproto/link', recent, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ account }).strict(), req.body);
    const t = await s.federation.tenantById(p.tenantId);
    if (!t) throw notFound('Tenant');
    const out = await run(() => s.atprotoAccounts.start(t, { providerId: null, input: body.account, returnTo: null, link: { sessionId: req.authSession!.id, userId: p.userId } }));
    setFedCookie(res, s, out.browser, 'lax');
    await s.audit.append({ tenantId: p.tenantId, action: 'atproto.did.link_started', kind: 'admin', actor: actorFrom(p, ip(req)), target: { user: p.userId, account: body.account }, traceId: req.traceId });
    res.json({ url: out.url });
  });

  /** Sets the handle shown for the bound DID; it must resolve to it, through the service URL checks. */
  r.put('/me/atproto/handle', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ handle: account }).strict(), req.body);
    const row = await run(() => s.atprotoAccounts.setHandle(by(req), p.userId, body.handle));
    res.json({ binding: view(row) });
  });

  r.delete('/me/atproto', async (req, res) => {
    const p = principalOf(req);
    const row = await s.atprotoAccounts.binding(p.tenantId, p.userId);
    if (!row) throw notFound('AT-Protocol account');
    await s.atprotoAccounts.remove(by(req), row, 'self');
    res.status(204).end();
  });

  // ---------- identity admins ----------

  r.get('/admin/atproto/accounts', async (req, res) => {
    const q = parseBody(z.object({ verified: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) }).strict(), req.query);
    const rows = await s.atprotoAccounts.list(principalOf(req).tenantId, { ...(q.verified ? { verified: q.verified === 'true' } : {}), limit: q.limit, offset: q.offset });
    res.json(rows.map((x) => ({ ...view(x), userId: x.user_id, username: x.username })));
  });

  /** Resolves a handle or DID step by step (handle, DID document, PDS, authorization server). */
  r.post('/admin/atproto/accounts/check', async (req, res) => {
    const body = parseBody(z.object({ account }).strict(), req.body);
    const out = await s.atprotoAccounts.check(body.account);
    await s.audit.append({ tenantId: principalOf(req).tenantId, action: 'atproto.account.checked', kind: 'admin', actor: actorFrom(principalOf(req), ip(req)), target: { account: body.account }, detail: { ok: out.ok, did: out.did ?? null }, traceId: req.traceId });
    res.json(out);
  });

  r.delete('/admin/atproto/accounts/:id', async (req, res) => {
    const p = principalOf(req);
    const row = await s.atprotoAccounts.bindingById(p.tenantId, parseBody(id26, req.params.id));
    if (!row) throw notFound('AT-Protocol account');
    await s.atprotoAccounts.remove(by(req), row, 'admin');
    res.status(204).end();
  });

  return r;
}
