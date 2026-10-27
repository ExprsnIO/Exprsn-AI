import { Router, type Request } from 'express';
import { ulid } from 'ulid';
import { z, ZodError } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { authorize, type Principal } from '../../authz/policy.js';
import { LoginThrottle } from '../../identity/lockout.js';
import { formFor, kindView, storeKind, storeKinds, type StoreKindDefinition, type StoreTestCredentials, type StoreTestResult } from '../../identity/providers/kinds.js';
import { PROVIDER_KINDS, type ProviderKind } from '../../identity/providers/types.js';
import { vaultRefsIn } from '../../identity/secrets.js';
import { storeAdminFor, storeStateMissing } from '../../identity/store-admin.js';
import { storeBackupsFor } from '../../identity/store-backups.js';
import { governanceFor, STORE_BACKUP_UPLOAD_MAX_BYTES } from '../../identity/store-governance.js';
import { actorOf as govActor, identityStoreGovernanceRoutes } from './identity-store-governance.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound, tooManyRequests } from '../../http/problem.js';
import type { ProviderRow } from '../../repos/providers.js';
import type { Services } from '../../services.js';

/*
 * 1.9.0, Sprint 54: the store wizard and form editor (B-181), archive and restore (B-185) and store backups (B-186).
 * Mounted from `identityAdminRoutes`; every route needs `identity:manage`, and a kind marked `platform` in the kind
 * registry (Exprsn platform accounts) also needs `platform:manage`. Archive, restore and restoring a backup need a
 * recent sign-in.
 */

const credentialsSchema = z.object({ username: z.string().trim().min(1).max(190), password: z.string().min(1).max(1024).optional() }).strict();
const configBody = z.object({ config: z.record(z.string(), z.unknown()).default({}), step: z.enum(['connection', 'attributes']).optional() });
const reasonSchema = z.string().trim().max(500).optional();

/** The zod issues of a configuration as the form shows them (`config.<path>`). */
export const configErrors = (err: ZodError) => err.issues.map((i) => ({ path: ['config', ...i.path].join('.'), message: i.message }));

/** `platform:manage` too, for a kind the registry marks as a platform store. */
export function assertKindAllowed(p: Principal, kind: string): void {
  if (storeKind(kind)?.platform && !authorize(p, 'platform:manage').allow) throw forbidden('Stores of this kind are platform stores; changing one also needs platform:manage.', { step: 'role', action: 'platform:manage' });
}

/** A row for a configuration that is not saved, so the chain can build a provider for it (`IdentityChain.probe`). */
const probeRow = (p: Principal, kind: string, config: Record<string, unknown>): ProviderRow => {
  const t = Date.now();
  return { id: ulid(), tenant_id: p.tenantId, name: 'Store wizard test', kind: kind as ProviderKind, position: 0, enabled: false, config, managed_by: 'api', vault_owner: p.userId ?? null, state: 'active', state_before: null, archived_at: null, archived_by: null, created_at: t, updated_at: t };
};

/**
 * Runs a kind's test for a configuration with a real account, under the same lockout as "Test a login". The
 * credentials go to the store for this one call; only the username is audited, never the password.
 */
export async function runKindTest(s: Services, req: Request, def: StoreKindDefinition, config: Record<string, unknown>, credentials: StoreTestCredentials | null): Promise<StoreTestResult> {
  const p = principalOf(req);
  let parsed: Record<string, unknown>;
  try {
    parsed = def.config.parse(config) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ZodError) throw badRequest('The store configuration did not validate.', { errors: configErrors(err) });
    throw err;
  }
  await s.vault.assertRefsReadable(p, vaultRefsIn(config), { ip: ip(req), traceId: req.traceId });
  const keys = credentials ? LoginThrottle.keys(p.tenantId, credentials.username, null) : null;
  if (keys) {
    const reserved = await s.throttle.reserve([keys.account]);
    if (reserved.locked) throw tooManyRequests('This account is locked after failed attempts.', reserved.retryAfterSeconds);
  }
  const result = await def.test(parsed, credentials, { probe: (cfg) => s.chain.probe(probeRow(p, def.kind, cfg)) });
  if (keys) {
    if (result.result === 'invalid') await s.throttle.failed([keys.account]);
    else await s.throttle.release([keys.account]);
  }
  return result;
}

/** "Test before save" (B-181): a configuration that cannot connect or find the test account is refused (409). */
export async function testBeforeSave(s: Services, req: Request, kind: string, config: Record<string, unknown>, credentials: StoreTestCredentials): Promise<StoreTestResult> {
  const def = storeKind(kind);
  if (!def) throw badRequest(`No store kind ${kind}.`);
  const result = await runKindTest(s, req, def, config, credentials);
  if (!result.ok) throw new HttpProblem(409, 'Test before save failed', `The store was not saved: the test with ${credentials.username} answered ${result.result.replace('_', ' ')}.`, { extensions: { reason: 'test_failed', result: result.result, steps: result.steps } });
  return result;
}

export function identityStoreRoutes(s: Services): Router {
  const r = Router();
  const gate = [noStore, requireAuth(), requirePermission(s, 'identity:manage')];
  const fresh = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'identity:manage'), requireRecentAuth(s)];
  const admin = storeAdminFor(s);
  const backups = storeBackupsFor(s, admin);
  const governance = governanceFor(s); // QA-1: dual control, purge, schedules, exports, uploads
  r.use(identityStoreGovernanceRoutes(s));

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const load = async (req: Request) => {
    const row = await s.providers.get(principalOf(req).tenantId, String(req.params.id));
    if (!row) throw notFound('User store');
    return row;
  };

  const kindOf = (req: Request) => {
    const def = storeKind(String(req.params.kind));
    if (!def) throw notFound('Store kind');
    return def;
  };

  // ---------- the wizard (B-181) ----------

  r.get('/identity-store-kinds', ...gate, async (_req, res) => {
    res.json({ kinds: storeKinds().filter((k) => (PROVIDER_KINDS as readonly string[]).includes(k.kind)).map(kindView), archive: await admin.installed(), backups: await backups.installed(), governance: await governance.installed() });
  });

  /** Validates a configuration (optionally only the fields of one wizard step) and returns it with its defaults. */
  r.post('/identity-store-kinds/:kind/check', ...gate, async (req, res) => {
    const def = kindOf(req);
    const body = parseBody(configBody, req.body);
    const r2 = def.config.safeParse(body.config);
    if (r2.success) return void res.json({ ok: true, errors: [], config: r2.data });
    let errors = configErrors(r2.error);
    if (body.step) {
      const keys = formFor(def).filter((sec) => sec.step === body.step).flatMap((sec) => sec.fields.map((f) => `config.${f.key}`));
      // A field of the step, below it, or a missing block that holds one (`columns` for `columns.username`).
      errors = errors.filter((e) => keys.some((k) => e.path === k || e.path.startsWith(k + '.') || k.startsWith(e.path + '.')));
    }
    res.json({ ok: errors.length === 0, errors, config: null });
  });

  /** The wizard's test with a real account. The password is used for this call only. */
  r.post('/identity-store-kinds/:kind/test', ...gate, async (req, res) => {
    const p = principalOf(req);
    const def = kindOf(req);
    assertKindAllowed(p, def.kind);
    const body = parseBody(z.object({ config: z.record(z.string(), z.unknown()).default({}), credentials: credentialsSchema.optional() }), req.body);
    const result = await runKindTest(s, req, def, body.config, body.credentials ?? null);
    await audit(req, 'identity.store.wizard_tested', { kind: def.kind, ...(body.credentials ? { username: body.credentials.username.toLowerCase() } : {}) }, { result: result.result, ok: result.ok, password: !!body.credentials?.password });
    res.json(result);
  });

  /** The sign-in order step: the stores' order as a list of ids, first asked first. */
  r.put('/identity-providers/order', ...gate, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ ids: z.array(z.string().length(26)).min(1).max(200), reason: reasonSchema }), req.body);
    const stores = await s.providers.list(p.tenantId);
    if (new Set(body.ids).size !== body.ids.length || body.ids.length !== stores.length || body.ids.some((id) => !stores.some((x) => x.id === id))) throw badRequest('Name every user store of this tenant once.');
    const before = stores.map((x) => x.id);
    for (const [i, id] of body.ids.entries()) {
      const row = stores.find((x) => x.id === id)!;
      const position = (i + 1) * 10;
      if (row.position === position) continue;
      const updated = await s.providers.update(p.tenantId, id, { position });
      if (updated) await admin.recordVersion(updated, body.reason ?? 'sign-in order changed', p.userId ?? null);
    }
    await audit(req, 'identity.provider.reordered', { stores: body.ids.length }, { before, after: body.ids });
    res.json((await s.providers.list(p.tenantId)).map((x) => ({ id: x.id, name: x.name, position: x.position })));
  });

  // ---------- versions (B-181) ----------

  r.get('/identity-providers/:id/versions', ...gate, async (req, res) => {
    const row = await load(req);
    res.json({ available: await admin.installed(), versions: await admin.history(row.tenant_id, row.id) });
  });

  // ---------- archive and restore (B-185) ----------

  r.post('/identity-providers/:id/archive', ...fresh, async (req, res) => {
    const p = principalOf(req);
    const row = await load(req);
    assertKindAllowed(p, row.kind);
    const body = parseBody(z.object({ revokeSessions: z.boolean().default(false), revokeApiKeys: z.boolean().default(false), reason: reasonSchema }), req.body ?? {});
    if (!(await admin.installed())) throw storeStateMissing();
    if (row.managed_by === 'config') throw conflict('This store is managed by the configuration file; remove it there.');
    if (row.kind === 'local') throw conflict('The local store is the break-glass way in; disable it instead of archiving it.');
    if (row.enabled && !(await s.providers.list(p.tenantId)).some((x) => x.enabled && x.id !== row.id)) throw conflict('This is the only enabled user store; nobody could sign in without it.');
    const out = await admin.archive(row, p.userId ?? '', body);
    await admin.recordVersion(out.row, body.reason ?? 'archived', p.userId ?? null);
    await audit(req, 'identity.store.archived', { provider: row.id, name: row.name, kind: row.kind }, { before: row.enabled ? 'enabled' : 'disabled', users: out.users, sessionsRevoked: out.sessionsRevoked, apiKeysRevoked: out.apiKeysRevoked, ...(body.reason ? { reason: body.reason } : {}) });
    res.json({ store: storeView(out.row), users: out.users, sessionsRevoked: out.sessionsRevoked, apiKeysRevoked: out.apiKeysRevoked });
  });

  r.post('/identity-providers/:id/restore', ...fresh, async (req, res) => {
    const p = principalOf(req);
    const row = await load(req);
    assertKindAllowed(p, row.kind);
    const body = parseBody(z.object({ to: z.enum(['previous', 'disabled']).default('previous'), reason: reasonSchema }), req.body ?? {});
    const restored = await admin.restore(row, body.to);
    await admin.recordVersion(restored, body.reason ?? 'restored from the archive', p.userId ?? null);
    await audit(req, 'identity.store.restored', { provider: row.id, name: row.name, kind: row.kind }, { to: restored.enabled ? 'enabled' : 'disabled', ...(body.reason ? { reason: body.reason } : {}) });
    res.json({ store: storeView(restored), ...(await admin.keptCounts(restored)) });
  });

  // ---------- backups (B-186) ----------

  r.get('/identity-store-backups', ...gate, async (req, res) => {
    res.json({ available: await backups.installed(), backups: await backups.list(principalOf(req).tenantId) });
  });

  /** A backup of one store: `save: true` keeps it in the blob store, otherwise it is the response (a download). */
  r.post('/identity-providers/:id/backups', ...gate, async (req, res) => {
    const p = principalOf(req);
    const row = await load(req);
    assertKindAllowed(p, row.kind);
    const body = parseBody(z.object({ save: z.boolean().default(false) }), req.body ?? {});
    if (body.save) {
      const saved = await backups.save(row, p.userId ?? null);
      await audit(req, 'identity.store.backup.created', { provider: row.id, name: row.name, backup: saved.id }, { where: 'blob', bytes: saved.bytes, sha256: saved.sha256, counts: saved.counts });
      return void res.status(201).json(saved);
    }
    const archive = await backups.build(row);
    await audit(req, 'identity.store.backup.downloaded', { provider: row.id, name: row.name, backup: archive.id }, { where: 'download', counts: archive.counts });
    res.setHeader('Content-Disposition', `attachment; filename="store-${row.name.replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase()}-${archive.id}.json"`);
    res.json(archive);
  });

  r.get('/identity-store-backups/:id/download', ...gate, async (req, res) => {
    const p = principalOf(req);
    const archive = await backups.read(p.tenantId, String(req.params.id));
    assertKindAllowed(p, archive.source.store.kind);
    await audit(req, 'identity.store.backup.downloaded', { provider: archive.source.store.id, name: archive.source.store.name, backup: archive.id }, { where: 'blob' });
    res.setHeader('Content-Disposition', `attachment; filename="store-${archive.source.store.name.replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase()}-${archive.id}.json"`);
    res.json(archive);
  });

  r.delete('/identity-store-backups/:id', ...gate, async (req, res) => {
    const p = principalOf(req);
    if (!(await backups.remove(p.tenantId, String(req.params.id)))) throw notFound('Store backup');
    await audit(req, 'identity.store.backup.deleted', { backup: String(req.params.id) });
    res.status(204).end();
  });

  /**
   * Restores a backup into this tenant: an archive in the body (a download) or a saved backup by id. The signature is
   * verified first; a refused archive is audited. `dryRun` reports every change without making one.
   */
  r.post('/identity-store-backups/restore', ...fresh, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z
        .object({ archive: z.unknown().optional(), backupId: z.string().length(26).optional(), mode: z.enum(['same', 'new']).default('same'), name: z.string().trim().min(1).max(100).optional(), dryRun: z.boolean().default(true) })
        .refine((b) => (b.archive === undefined) !== (b.backupId === undefined), 'Give either an archive or a backupId'),
      req.body
    );
    const archive = body.backupId ? await backups.read(p.tenantId, body.backupId) : backups.parseArchive(body.archive);
    assertKindAllowed(p, archive.source.store.kind);
    // QA-1 (B-186): under dual control a restore is a proposal another identity admin approves; this admin sees the
    // dry run. An archive given inline is kept as an uploaded backup first, so the approver restores the same bytes.
    const dual = !body.dryRun && (await governance.dualControl(p.tenantId)).on;
    let report;
    try {
      report = await backups.restore(p, archive, { mode: body.mode, ...(body.name ? { name: body.name } : {}), dryRun: body.dryRun || dual, ctx: { ip: ip(req), traceId: req.traceId } });
    } catch (err) {
      if (err instanceof HttpProblem && err.status === 422) await audit(req, 'identity.store.backup.refused', { backup: archive.id, store: archive.source.store.name }, { reason: (err.extensions as Record<string, unknown> | undefined)?.reason ?? null, detail: err.detail });
      throw err;
    }
    if (dual) {
      let backupId = body.backupId;
      if (!backupId) {
        const text = Buffer.from(JSON.stringify(body.archive), 'utf8');
        backupId = (await backups.upload(p.tenantId, p.userId ?? null, (async function* () { yield text; })(), STORE_BACKUP_UPLOAD_MAX_BYTES)).id;
      }
      const counts = Object.entries(report.summary).filter(([k]) => !k.endsWith('.unchanged')).map(([k, v]) => `${v} ${k}`).join(', ');
      const proposal = await governance.propose(govActor(req), { kind: 'store.restore', providerId: report.target.id, name: report.target.name, payload: { backupId, archiveId: archive.id, mode: body.mode, ...(body.name ? { name: body.name } : {}) }, summary: `Restore backup ${archive.id} of ${archive.source.store.name} (made ${new Date(archive.createdAt).toISOString()}) into ${report.target.created ? 'a new store' : 'the store'} ${report.target.name}: ${counts || 'no changes'}.` });
      await audit(req, 'identity.store.backup.restore_previewed', { backup: archive.id, provider: report.target.id, name: report.target.name }, { mode: body.mode, created: report.target.created, sourceTenant: archive.source.tenant.id, summary: report.summary, proposal: proposal.id });
      return void res.status(202).json({ ...report, proposal: governance.view(proposal, p.userId ?? null) });
    }
    await audit(req, body.dryRun ? 'identity.store.backup.restore_previewed' : 'identity.store.backup.restored', { backup: archive.id, provider: report.target.id, name: report.target.name }, { mode: body.mode, created: report.target.created, sourceTenant: archive.source.tenant.id, summary: report.summary });
    res.json(report);
  });

  return r;
}

/** What the console gets for a store (secrets are references, never values). */
export const storeView = (p: ProviderRow) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  position: p.position,
  enabled: p.enabled,
  state: p.state,
  stateBefore: p.state_before,
  archivedAt: p.archived_at,
  config: p.config,
  managedBy: p.managed_by,
  createdAt: p.created_at,
  updatedAt: p.updated_at
});
