import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { z, ZodError } from 'zod';
import { effectivePermissions } from '../authz/policy.js';
import { Cid } from '../atproto/encoding.js';
import { dataToJson } from '../atproto/pds/lexjson.js';
import { XrpcError, type PdsAccountRow, type PdsActor, type PdsAuth } from '../atproto/pds/service.js';
import { isDid, isHandle, isNsid, isRecordKey } from '../atproto/pds/syntax.js';
import { AUTH_TAG, ip, loadPrincipal, PERMISSION_TAG } from '../http/middleware.js';
import { HttpProblem } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

/*
 * The PDS's XRPC endpoints (1.5.0, Sprint 31: B-2901 to B-2905), mounted at the root outside /api: no session cookie,
 * no CSRF. docs/pds.md lists them with their parameters. Errors are AT-Protocol's `{ error, message }`.
 *
 * - Public: describeServer, createAccount, createSession, and refreshSession / deleteSession (which carry their own
 *   refresh token), resolveHandle, and the reads (`com.atproto.repo` getRecord, listRecords, describeRepo; every
 *   `com.atproto.sync` read). Repositories are public by protocol.
 * - The rest need an access token from a session, whose account is active (or, for the account endpoints,
 *   deactivated) and whose Exprsn-AI user still holds `atproto:link` and is not disabled or suspended. The route
 *   registry declares them with `atproto:link`.
 *
 * Every address is limited to PDS_RATE_PER_MINUTE calls, and sign-ins and sign-ups to 30 a minute (as /api/auth).
 * Browsers may call them from any origin (Bluesky's web app does): CORS is open, with preflights answered here.
 */

const XRPC = '/xrpc';
const json = express.json({ limit: '1mb', strict: true });
const SERVICE_AUTH_MAX_S = 3600;

const did = z.string().max(2048).refine(isDid, 'not a DID');
const repoParam = z.string().min(3).max(2048).refine((v) => isDid(v) || isHandle(v), 'not a DID or handle');
const nsid = z.string().max(317).refine(isNsid, 'not an NSID');
const rkey = z.string().max(512).refine(isRecordKey, 'not a record key');
const cidStr = z.string().min(8).max(200).refine((v) => {
  try {
    Cid.parse(v);
    return true;
  } catch {
    return false;
  }
}, 'not a CID');
const limit = (max: number, dflt: number) => z.coerce.number().int().min(1).max(max).default(dflt);
const boolQ = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Sends an XRPC error: `{ error, message }` with the error's status and headers. */
const xrpcError = (res: Response, err: XrpcError) => {
  for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
  res.status(err.status).json({ error: err.error, message: err.message });
};

export function pdsXrpcRoutes(s: Services): Router {
  const r = Router();
  const general = new Limiter(s.counters, 'pds-xrpc', s.cfg.PDS_RATE_PER_MINUTE, 60_000);
  const signins = new Limiter(s.counters, 'pds-auth', 30, 60_000);
  const failedSignins = new Limiter(s.counters, 'pds-auth-fail', 10, 15 * 60_000);

  // CORS and the general limit for every XRPC call this router answers (OPTIONS preflights end here).
  r.use(XRPC, async (req, res, next) => {
    if (!/^\/com\.atproto\.(server|identity|repo|sync)\./.test(req.path)) return next();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, atproto-proxy, atproto-accept-labelers');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    const l = await general.consume(req.ip ?? 'unknown');
    if (!l.allowed) throw new XrpcError(429, 'RateLimitExceeded', 'Too many requests from this address.', { 'Retry-After': String(Math.max(1, Math.ceil(l.resetMs / 1000))) });
    next();
  });

  /** An XRPC caller with an access token; the user must still hold atproto:link. */
  const auth = (o: { allowInactive?: boolean } = {}): RequestHandler => {
    const handler: RequestHandler = async (req, _res, next) => {
      const a = await s.pds.authenticate(req.headers.authorization);
      if (!o.allowInactive && a.account.state !== 'active') throw new XrpcError(400, 'AccountDeactivated', 'Account is deactivated');
      const p = await loadPrincipal(s, a.account.tenant_id, a.account.user_id, {});
      if (!p || !effectivePermissions(p).has('atproto:link')) throw new XrpcError(403, 'Forbidden', 'The Exprsn-AI account behind this AT-Protocol account may no longer use it (atproto:link).');
      (req as Request & { pds?: PdsAuth }).pds = a;
      next();
    };
    // 1.5.0 (B-3304): tagged like requireAuth and requirePermission, for the route permission registry.
    return Object.assign(handler, { [AUTH_TAG]: true, [PERMISSION_TAG]: 'atproto:link' });
  };
  const pdsOf = (req: Request): PdsAuth => (req as Request & { pds?: PdsAuth }).pds!;
  const by = (req: Request, a: PdsAccountRow): PdsActor => ({ tenantId: a.tenant_id, userId: a.user_id, actor: { user: a.user_id, name: a.handle, via: 'atproto-xrpc', ip: ip(req) }, traceId: req.traceId });
  const privileged = (a: PdsAuth) => a.scope === 'com.atproto.access' || a.scope === 'com.atproto.appPassPrivileged';

  const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
    const out = schema.safeParse(v);
    if (!out.success) throw new XrpcError(400, 'InvalidRequest', out.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ').slice(0, 500));
    return out.data;
  };

  /** The repo a read names, readable (not gone, taken down or deactivated). */
  const readable = async (id: string): Promise<PdsAccountRow> => {
    const a = await s.pds.accountByIdentifier(id);
    s.pds.repo.assertReadable(a, id);
    if (!a.commit_cid) throw new XrpcError(400, 'RepoNotFound', `Could not find repo for DID: ${id}`);
    return a;
  };

  const own = (req: Request, repo: string): PdsAccountRow => {
    const a = pdsOf(req).account;
    if (repo !== a.did && repo.toLowerCase() !== a.handle) throw new XrpcError(403, 'InvalidRequest', 'A session writes only to its own repo.');
    return a;
  };

  const car = (res: Response, bytes: Buffer) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/vnd.ipld.car').send(bytes);
  };

  // ---------- com.atproto.server ----------

  r.get(`${XRPC}/com.atproto.server.describeServer`, async (_req, res) => {
    const hosted = await s.pds.enabledHostings();
    res.json({ did: s.pds.serviceDid(), availableUserDomains: hosted.map((h) => `.${h.handle_domain}`), inviteCodeRequired: hosted.length > 0 && hosted.every((h) => h.invite_required), phoneVerificationRequired: false, links: {} });
  });

  r.post(`${XRPC}/com.atproto.server.createAccount`, json, async (req, res) => {
    const l = await signins.consume(req.ip ?? 'unknown');
    if (!l.allowed) throw new XrpcError(429, 'RateLimitExceeded', 'Too many sign-ups from this address.');
    const body = parse(z.object({ email: z.string().trim().email().max(320).optional(), handle: z.string().trim().min(3).max(253), did: did.optional(), inviteCode: z.string().trim().max(100).optional(), password: z.string().min(1).max(256).optional(), recoveryKey: z.string().max(200).optional(), verificationCode: z.string().max(100).optional(), verificationPhone: z.string().max(40).optional(), plcOp: z.unknown().optional() }), req.body);
    const handle = body.handle.toLowerCase();
    const found = await s.pds.hostingForHandle(handle);
    if (!found) throw new XrpcError(400, 'UnsupportedDomain', `Not a supported handle domain; available: ${(await s.pds.enabledHostings()).map((h) => `.${h.handle_domain}`).join(', ') || 'none'}.`);
    const { hosting, name } = found;
    const tenant = await s.tenants.byId(hosting.tenant_id);
    if (!tenant || tenant.state !== 'active') throw new XrpcError(400, 'UnsupportedDomain', 'This handle domain is not available.');
    if (body.did) await s.pds.migration.checkCreateAuth(req.headers.authorization, body.did);
    await s.pds.checkHandle(handle, hosting);
    if (!s.atproto.keys.custody()) throw new XrpcError(503, 'Unavailable', 'This PDS cannot hold account keys right now.');
    const policy = (await s.identityPolicy.get(tenant.id)).signup;
    const invite = body.inviteCode ? await s.pds.findInvite(tenant.id, body.inviteCode) : null;
    if (body.inviteCode && !invite) throw new XrpcError(400, 'InvalidInviteCode', 'Provided invite code not available');
    if (!invite && (hosting.invite_required || policy.mode !== 'open')) throw new XrpcError(400, 'InvalidInviteCode', 'An invite code is required to sign up here.');
    if (!body.email || !body.password) throw new XrpcError(400, 'InvalidRequest', 'An email address and a password are required.');
    let userId: string;
    try {
      const out = await s.signup.register(tenant, { username: name, displayName: name, email: body.email, password: body.password }, { ip: ip(req), traceId: req.traceId }, invite ? { invited: invite.id } : {});
      if (out.state !== 'active') throw new XrpcError(400, 'InvalidRequest', 'The account waits for an admin’s approval; ask for an invite code.');
      userId = out.userId;
    } catch (err) {
      if (err instanceof HttpProblem) throw new XrpcError(400, err.status === 409 ? 'HandleNotAvailable' : err.status === 422 || err.status === 400 ? 'InvalidPassword' : 'InvalidRequest', err.detail ?? err.title);
      throw err;
    }
    const user = (await s.users.get(tenant.id, userId))!;
    const actor: PdsActor = { tenantId: tenant.id, userId: user.id, actor: { user: user.id, username: user.username, via: 'atproto-xrpc', ip: ip(req) }, traceId: req.traceId };
    const a = await s.pds.createAccount(actor, { user, handle, hosting, did: body.did ?? null, inviteId: invite?.id ?? null, via: body.did ? 'migration' : 'xrpc' });
    const session = await s.pds.issueSession(a, { appPasswordId: null, scope: 'com.atproto.access', ip: ip(req) });
    res.json({ accessJwt: session.accessJwt, refreshJwt: session.refreshJwt, handle: a.handle, did: a.did, didDoc: await s.pds.didDoc(a) });
  });

  r.post(`${XRPC}/com.atproto.server.createSession`, json, async (req, res) => {
    const body = parse(z.object({ identifier: z.string().trim().min(1).max(320), password: z.string().min(1).max(256), authFactorToken: z.string().max(100).optional(), allowTakendown: z.boolean().optional() }), req.body);
    const addr = req.ip ?? 'unknown';
    const id = body.identifier.toLowerCase();
    const l = await signins.consume(addr);
    if (!l.allowed || (await failedSignins.blocked(`id:${id}`)).blocked) throw new XrpcError(429, 'RateLimitExceeded', 'Too many sign-in attempts; wait before trying again.');
    let a = await s.pds.accountByIdentifier(id);
    if (!a && id.includes('@')) {
      const rows = (await s.db('pds_accounts').where({ email: id }).limit(2)) as Record<string, unknown>[];
      if (rows.length === 1) a = (await s.pds.accountById(String(rows[0]!.id)))!;
    }
    const apw = a ? await s.pds.checkAppPassword(a, body.password) : null;
    if (!a || !apw) {
      await failedSignins.consume(`id:${id}`);
      throw new XrpcError(401, 'AuthenticationRequired', 'Invalid identifier or password. This server accepts app passwords only: create one in Exprsn-AI’s settings.');
    }
    if (a.state === 'takendown' && !body.allowTakendown) throw new XrpcError(401, 'AccountTakedown', 'Account has been taken down');
    const p = await loadPrincipal(s, a.tenant_id, a.user_id, {});
    if (!p || !effectivePermissions(p).has('atproto:link')) throw new XrpcError(401, 'AuthenticationRequired', 'The Exprsn-AI account behind this AT-Protocol account is disabled, suspended or may not use it.');
    const session = await s.pds.issueSession(a, { appPasswordId: apw.id, scope: apw.privileged ? 'com.atproto.appPassPrivileged' : 'com.atproto.appPass', ip: ip(req) });
    await s.pds.audit(by(req, a), 'pds.session.created', { account: a.id, did: a.did, appPassword: apw.id }, { name: apw.name });
    res.json({ accessJwt: session.accessJwt, refreshJwt: session.refreshJwt, ...(await s.pds.session(a)) });
  });

  r.post(`${XRPC}/com.atproto.server.refreshSession`, async (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m) throw new XrpcError(401, 'AuthMissing', 'Authentication Required');
    const out = await s.pds.refresh(m[1]!, ip(req));
    res.json({ accessJwt: out.accessJwt, refreshJwt: out.refreshJwt, ...(await s.pds.session(out.account)) });
  });

  r.post(`${XRPC}/com.atproto.server.deleteSession`, async (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m) throw new XrpcError(401, 'AuthMissing', 'Authentication Required');
    await s.pds.endSession(m[1]!);
    res.status(200).end();
  });

  r.get(`${XRPC}/com.atproto.server.getSession`, auth({ allowInactive: true }), async (req, res) => {
    res.json(await s.pds.session(pdsOf(req).account));
  });

  r.post(`${XRPC}/com.atproto.server.activateAccount`, auth({ allowInactive: true }), async (req, res) => {
    const a = pdsOf(req).account;
    await s.pds.activate(by(req, a), a);
    res.status(200).end();
  });

  r.post(`${XRPC}/com.atproto.server.deactivateAccount`, json, auth({ allowInactive: true }), async (req, res) => {
    const body = parse(z.object({ deleteAfter: z.string().max(40).optional() }), req.body ?? {});
    const a = pdsOf(req).account;
    await s.pds.deactivate(by(req, a), a, body.deleteAfter ? `Deactivated by the account (delete after ${body.deleteAfter} requested)` : 'Deactivated by the account');
    res.status(200).end();
  });

  r.get(`${XRPC}/com.atproto.server.checkAccountStatus`, auth({ allowInactive: true }), async (req, res) => {
    res.json(await s.pds.migration.checkStatus(pdsOf(req).account));
  });

  r.get(`${XRPC}/com.atproto.server.getServiceAuth`, auth({ allowInactive: true }), async (req, res) => {
    const q = parse(z.object({ aud: did, exp: z.coerce.number().int().positive().optional(), lxm: nsid.optional() }), req.query);
    const a = pdsOf(req);
    const now = Math.floor(Date.now() / 1000);
    const expS = q.exp ? q.exp - now : 60;
    if (expS <= 0 || expS > SERVICE_AUTH_MAX_S) throw new XrpcError(400, 'BadExpiration', `exp is at most ${SERVICE_AUTH_MAX_S} seconds ahead.`);
    // Moving the account (createAccount at another PDS) needs a privileged credential, as in the reference PDS.
    if ((!q.lxm || q.lxm === 'com.atproto.server.createAccount') && !privileged(a)) throw new XrpcError(400, 'InvalidRequest', 'This needs a privileged app password.');
    const token = await s.pds.serviceAuth(a.account, { aud: q.aud, lxm: q.lxm, expS });
    await s.pds.audit(by(req, a.account), 'pds.service_auth.issued', { account: a.account.id, did: a.account.did }, { aud: q.aud, lxm: q.lxm ?? null, expS });
    res.json({ token });
  });

  // ---------- com.atproto.identity ----------

  r.get(`${XRPC}/com.atproto.identity.resolveHandle`, async (req, res) => {
    const q = parse(z.object({ handle: z.string().trim().min(3).max(253) }), req.query);
    const handle = q.handle.toLowerCase();
    const a = await s.pds.accountByHandle(handle);
    if (a && a.state !== 'takendown') {
      res.json({ did: a.did });
      return;
    }
    try {
      res.json({ did: (await s.atprotoAccounts.handles.resolve(handle)).did });
    } catch {
      throw new XrpcError(400, 'HandleNotFound', 'Unable to resolve handle');
    }
  });

  r.get(`${XRPC}/com.atproto.identity.getRecommendedDidCredentials`, auth({ allowInactive: true }), async (req, res) => {
    res.json(s.pds.migration.credentials(pdsOf(req).account));
  });

  r.post(`${XRPC}/com.atproto.identity.requestPlcOperationSignature`, auth({ allowInactive: true }), async (req, res) => {
    const a = pdsOf(req);
    if (!privileged(a)) throw new XrpcError(400, 'InvalidRequest', 'This needs a privileged app password.');
    await s.pds.migration.requestSignature(a.account);
    res.status(200).end();
  });

  r.post(`${XRPC}/com.atproto.identity.signPlcOperation`, json, auth({ allowInactive: true }), async (req, res) => {
    const a = pdsOf(req);
    if (!privileged(a)) throw new XrpcError(400, 'InvalidRequest', 'This needs a privileged app password.');
    const service = z.object({ type: z.string().max(100), endpoint: z.string().url().max(500) });
    const body = parse(z.object({ token: z.string().trim().min(1).max(100), rotationKeys: z.array(z.string().max(200)).max(5).optional(), alsoKnownAs: z.array(z.string().max(300)).max(10).optional(), verificationMethods: z.record(z.string().max(40), z.string().max(200)).optional(), services: z.record(z.string().max(40), service).optional() }), req.body);
    const operation = await s.pds.migration.signPlcOperation(by(req, a.account), a.account, body);
    res.json({ operation });
  });

  r.post(`${XRPC}/com.atproto.identity.submitPlcOperation`, json, auth({ allowInactive: true }), async (req, res) => {
    const a = pdsOf(req);
    const service = z.object({ type: z.string().max(100), endpoint: z.string().max(500) }).strict();
    const op = parse(z.object({ operation: z.object({ type: z.literal('plc_operation'), rotationKeys: z.array(z.string().max(200)).max(5), verificationMethods: z.record(z.string().max(40), z.string().max(200)), alsoKnownAs: z.array(z.string().max(300)).max(10), services: z.record(z.string().max(40), service), prev: z.string().max(100).nullable(), sig: z.string().max(200) }).strict() }), req.body);
    await s.pds.migration.submitPlcOperation(by(req, a.account), a.account, op.operation);
    res.status(200).end();
  });

  r.post(`${XRPC}/com.atproto.identity.updateHandle`, json, auth(), async (req, res) => {
    const body = parse(z.object({ handle: z.string().trim().min(3).max(253) }), req.body);
    const a = pdsOf(req).account;
    await s.pds.updateHandle(by(req, a), a, body.handle);
    res.status(200).end();
  });

  // ---------- com.atproto.repo: writes ----------

  const writeResult = (o: { commit: { cid: string; rev: string }; results: { uri: string; cid?: string; validationStatus?: string }[] }) => ({ uri: o.results[0]!.uri, cid: o.results[0]!.cid, commit: o.commit, ...(o.results[0]!.validationStatus ? { validationStatus: o.results[0]!.validationStatus } : {}) });

  r.post(`${XRPC}/com.atproto.repo.createRecord`, json, auth(), async (req, res) => {
    const body = parse(z.object({ repo: repoParam, collection: nsid, rkey: rkey.optional(), validate: z.boolean().optional(), record: z.record(z.string(), z.unknown()), swapCommit: cidStr.optional() }), req.body);
    const a = own(req, body.repo);
    const out = await s.pds.repo.applyWrites(by(req, a), a, [{ action: 'create', collection: body.collection, rkey: body.rkey, value: body.record }], { validate: body.validate, swapCommit: body.swapCommit });
    res.json(writeResult(out));
  });

  r.post(`${XRPC}/com.atproto.repo.putRecord`, json, auth(), async (req, res) => {
    const body = parse(z.object({ repo: repoParam, collection: nsid, rkey, validate: z.boolean().optional(), record: z.record(z.string(), z.unknown()), swapRecord: cidStr.nullable().optional(), swapCommit: cidStr.optional() }), req.body);
    const a = own(req, body.repo);
    const exists = await s.pds.repo.getRecord(a, body.collection, body.rkey);
    const out = await s.pds.repo.applyWrites(by(req, a), a, [{ action: exists ? 'update' : 'create', collection: body.collection, rkey: body.rkey, value: body.record, swapRecord: body.swapRecord }], { validate: body.validate, swapCommit: body.swapCommit });
    res.json(writeResult(out));
  });

  r.post(`${XRPC}/com.atproto.repo.deleteRecord`, json, auth(), async (req, res) => {
    const body = parse(z.object({ repo: repoParam, collection: nsid, rkey, swapRecord: cidStr.optional(), swapCommit: cidStr.optional() }), req.body);
    const a = own(req, body.repo);
    if (!(await s.pds.repo.getRecord(a, body.collection, body.rkey))) {
      if (body.swapRecord) throw new XrpcError(400, 'InvalidSwap', 'Record was at null');
      res.json({});
      return;
    }
    const out = await s.pds.repo.applyWrites(by(req, a), a, [{ action: 'delete', collection: body.collection, rkey: body.rkey, swapRecord: body.swapRecord }], { swapCommit: body.swapCommit });
    res.json({ commit: out.commit });
  });

  r.post(`${XRPC}/com.atproto.repo.applyWrites`, json, auth(), async (req, res) => {
    const op = z.discriminatedUnion('$type', [
      z.object({ $type: z.literal('com.atproto.repo.applyWrites#create'), collection: nsid, rkey: rkey.optional(), value: z.record(z.string(), z.unknown()) }),
      z.object({ $type: z.literal('com.atproto.repo.applyWrites#update'), collection: nsid, rkey, value: z.record(z.string(), z.unknown()) }),
      z.object({ $type: z.literal('com.atproto.repo.applyWrites#delete'), collection: nsid, rkey })
    ]);
    const body = parse(z.object({ repo: repoParam, validate: z.boolean().optional(), writes: z.array(op).min(1).max(200), swapCommit: cidStr.optional() }), req.body);
    const a = own(req, body.repo);
    const out = await s.pds.repo.applyWrites(
      by(req, a),
      a,
      body.writes.map((w) => ({ action: w.$type.endsWith('#create') ? 'create' : w.$type.endsWith('#update') ? 'update' : 'delete', collection: w.collection, rkey: w.rkey, value: 'value' in w ? w.value : undefined })),
      { validate: body.validate, swapCommit: body.swapCommit }
    );
    res.json({ commit: out.commit, results: out.results.map((x) => ({ $type: `com.atproto.repo.applyWrites#${x.action}Result`, ...(x.cid ? { uri: x.uri, cid: x.cid, validationStatus: x.validationStatus } : {}) })) });
  });

  r.post(`${XRPC}/com.atproto.repo.uploadBlob`, auth({ allowInactive: true }), async (req, res) => {
    const a = pdsOf(req).account;
    const len = req.headers['content-length'] ? Number(req.headers['content-length']) : null;
    const blob = await s.pds.blobs.upload(by(req, a), a, req, { declaredBytes: Number.isFinite(len) ? len : null });
    res.json({ blob: dataToJson(blob as never) });
  });

  r.post(`${XRPC}/com.atproto.repo.importRepo`, auth({ allowInactive: true }), async (req, res) => {
    const a = pdsOf(req).account;
    const max = s.cfg.PDS_IMPORT_MAX_BYTES;
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > max) throw new XrpcError(413, 'PayloadTooLarge', `A repo import is at most ${max} bytes.`);
      chunks.push(c);
    }
    await s.pds.migration.importRepo(by(req, a), a, Buffer.concat(chunks, n));
    res.status(200).end();
  });

  r.get(`${XRPC}/com.atproto.repo.listMissingBlobs`, auth({ allowInactive: true }), async (req, res) => {
    const q = parse(z.object({ limit: limit(1000, 500), cursor: z.string().max(200).optional() }), req.query);
    res.json(await s.pds.blobs.missing(pdsOf(req).account, { limit: q.limit, cursor: q.cursor }));
  });

  // ---------- com.atproto.repo: reads (public) ----------

  r.get(`${XRPC}/com.atproto.repo.getRecord`, async (req, res) => {
    const q = parse(z.object({ repo: repoParam, collection: nsid, rkey, cid: cidStr.optional() }), req.query);
    const a = await readable(q.repo);
    const rec = await s.pds.repo.getRecord(a, q.collection, q.rkey, q.cid);
    if (!rec) throw new XrpcError(400, 'RecordNotFound', `Could not locate record: at://${a.did}/${q.collection}/${q.rkey}`);
    res.json(rec);
  });

  r.get(`${XRPC}/com.atproto.repo.listRecords`, async (req, res) => {
    const q = parse(z.object({ repo: repoParam, collection: nsid, limit: limit(100, 50), cursor: z.string().max(512).optional(), reverse: boolQ.optional() }), req.query);
    const a = await readable(q.repo);
    res.json(await s.pds.repo.listRecords(a, q.collection, { limit: q.limit, cursor: q.cursor, reverse: q.reverse }));
  });

  r.get(`${XRPC}/com.atproto.repo.describeRepo`, async (req, res) => {
    const q = parse(z.object({ repo: repoParam }), req.query);
    const a = await readable(q.repo);
    res.json({ handle: a.handle, did: a.did, didDoc: await s.pds.didDoc(a), collections: await s.pds.repo.collections(a.id), handleIsCorrect: true });
  });

  // ---------- com.atproto.sync (public) ----------

  r.get(`${XRPC}/com.atproto.sync.getRepo`, async (req, res) => {
    const q = parse(z.object({ did, since: z.string().max(13).optional() }), req.query);
    car(res, await s.pds.repo.exportCar(await readable(q.did), q.since));
  });

  r.get(`${XRPC}/com.atproto.sync.getRecord`, async (req, res) => {
    const q = parse(z.object({ did, collection: nsid, rkey }), req.query);
    car(res, await s.pds.repo.recordCar(await readable(q.did), q.collection, q.rkey));
  });

  r.get(`${XRPC}/com.atproto.sync.getBlocks`, async (req, res) => {
    const q = parse(z.object({ did, cids: z.union([cidStr, z.array(cidStr).min(1).max(1000)]).transform((v) => (Array.isArray(v) ? v : [v])) }), req.query);
    car(res, await s.pds.repo.blocksCar(await readable(q.did), q.cids));
  });

  r.get(`${XRPC}/com.atproto.sync.getLatestCommit`, async (req, res) => {
    const q = parse(z.object({ did }), req.query);
    const a = await readable(q.did);
    res.json({ cid: a.commit_cid, rev: a.rev });
  });

  r.get(`${XRPC}/com.atproto.sync.getRepoStatus`, async (req, res) => {
    const q = parse(z.object({ did }), req.query);
    const a = await s.pds.accountByDid(q.did);
    if (!a || !a.commit_cid) throw new XrpcError(400, 'RepoNotFound', `Could not find repo for DID: ${q.did}`);
    res.json({ did: a.did, active: a.state === 'active', ...(a.state !== 'active' ? { status: a.state } : { rev: a.rev }) });
  });

  r.get(`${XRPC}/com.atproto.sync.listRepos`, async (req, res) => {
    const q = parse(z.object({ limit: limit(1000, 500), cursor: z.string().max(26).optional() }), req.query);
    const qb = s.db('pds_accounts').whereNotNull('commit_cid').orderBy('id', 'asc').limit(q.limit).select('id', 'did', 'commit_cid', 'rev', 'state');
    if (q.cursor) qb.andWhere('id', '>', q.cursor);
    const rows = (await qb) as { id: string; did: string; commit_cid: string; rev: string; state: string }[];
    res.json({ repos: rows.map((x) => ({ did: x.did, head: x.commit_cid, rev: x.rev, active: x.state === 'active', ...(x.state !== 'active' ? { status: x.state } : {}) })), ...(rows.length === q.limit ? { cursor: rows.at(-1)!.id } : {}) });
  });

  r.get(`${XRPC}/com.atproto.sync.listBlobs`, async (req, res) => {
    const q = parse(z.object({ did, since: z.string().max(13).optional(), limit: limit(1000, 500), cursor: z.string().max(200).optional() }), req.query);
    res.json(await s.pds.blobs.list(await readable(q.did), { limit: q.limit, cursor: q.cursor, since: q.since }));
  });

  r.get(`${XRPC}/com.atproto.sync.getBlob`, async (req, res) => {
    const q = parse(z.object({ did, cid: cidStr }), req.query);
    const a = await readable(q.did);
    const got = await s.pds.blobs.open(a, q.cid);
    if (!got) throw new XrpcError(400, 'BlobNotFound', 'Blob not found');
    res.setHeader('Content-Type', got.blob.mime);
    res.setHeader('Content-Length', String(got.blob.size));
    // Never rendered as a page of this origin: the type is the sniffed one, and the content is sandboxed.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=60');
    for await (const c of got.stream) {
      if (!res.write(c)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  });

  // XRPC errors keep the protocol's shape; anything else from these routes is an InternalServerError.
  const onError: ErrorRequestHandler = (err, req, res, next) => {
    if (!req.path.startsWith(`${XRPC}/com.atproto.`)) return next(err);
    if (res.headersSent) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    if (err instanceof XrpcError) return xrpcError(res, err);
    if (err instanceof ZodError) return xrpcError(res, new XrpcError(400, 'InvalidRequest', 'The request did not validate.'));
    if ((err as { type?: string }).type === 'entity.parse.failed') return xrpcError(res, new XrpcError(400, 'InvalidRequest', 'The body is not valid JSON.'));
    if ((err as { type?: string }).type === 'entity.too.large') return xrpcError(res, new XrpcError(413, 'PayloadTooLarge', 'The request body is too large.'));
    if (err instanceof HttpProblem) return xrpcError(res, new XrpcError(err.status, 'InvalidRequest', err.detail ?? err.title));
    s.log.error({ err, trace_id: req.traceId }, 'xrpc: unhandled error');
    xrpcError(res, new XrpcError(500, 'InternalServerError', 'Internal Server Error'));
  };
  r.use(onError);

  return r;
}
