import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom, isUniqueViolation } from '../../audit/chain.js';
import { LABELS, type Label } from '../../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { conflict } from '../../http/problem.js';
import { connectionView, ENGINES } from '../../connections/service.js';
import { isVaultRef } from '../../vault/policy.js';
import type { Services } from '../../services.js';

const endpoint = z.string().trim().min(3).max(300).regex(/^[A-Za-z0-9.:[\]/_-]+$/, 'host:port, or a URL for OpenSearch');
const objectName = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.*$-]+$/);

/**
 * Data connections (`connections:manage`): register, settings, sealed credentials, test, schema introspection and
 * allow-list, the data browser (classified, read-only, capped and masked) and CSV export. Every change and every
 * query, refused or run, is audited.
 */
export function connectionAdminRoutes(s: Services): Router {
  const r = Router();
  r.use(['/connections'], noStore, requireAuth());
  const manage = requirePermission(s, 'connections:manage');
  const c = s.connections;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, label, ...(detail ? { detail } : {}), traceId: req.traceId });
  };
  const view = async (tenantId: string, id: string) => ({ ...connectionView(await c.get(tenantId, id), (await c.usage(tenantId)).get(id) ?? []), lease: c.lease(id) });
  const ctx = (req: Request) => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

  r.get('/connections', manage, async (req, res) => {
    const p = principalOf(req);
    const usage = await c.usage(p.tenantId);
    res.json((await c.list(p.tenantId)).map((x) => connectionView(x, usage.get(x.id) ?? [])));
  });

  r.get('/connections/:id', manage, async (req, res) => {
    res.json(await view(principalOf(req).tenantId, String(req.params.id)));
  });

  r.post('/connections', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z
        .object({
          name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lower-case letters, digits and dashes'),
          engine: z.string(),
          endpoint,
          database: z.string().trim().max(200).nullable().default(null),
          zone: z.string().trim().regex(/^[a-z0-9-]{1,63}$/).default('data'),
          label: z.enum(LABELS).default('internal'),
          rowLimit: z.number().int().min(1).max(10_000).default(500),
          timeoutS: z.number().int().min(1).max(300).default(10),
          tls: z.boolean().default(false),
          username: z.string().trim().min(1).max(200).nullable().default(null),
          password: z.string().max(1000).nullable().default(null),
          /** OpenBao database role: the connection takes short-lived accounts from `<mount>/creds/<role>`. */
          baoRole: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,128}$/).nullable().default(null)
        })
        .strict(),
      req.body
    );
    if (!(ENGINES as readonly string[]).includes(body.engine)) throw conflict('That engine is not installed on this platform. Register offers PostgreSQL, MySQL and OpenSearch.');
    // Sprint 25 (B-1705): a vault password reference must be readable by the admin saving it; it resolves as them.
    if (body.username && body.password && isVaultRef(body.password)) await s.vault.assertRefsReadable(p, [body.password], { ip: ip(req), traceId: req.traceId });
    try {
      await s.zones.assertMemberFits('connection', body.zone, body.label).catch(async (err: unknown) => {
        await s.audit.append({ tenantId: p.tenantId, action: 'connection.register.refused', kind: 'admin', actor: actorFrom(p, ip(req)), target: { name: body.name }, label: body.label, detail: { zone: body.zone, reason: (err as Error).message }, traceId: req.traceId });
        throw err;
      });
      const row = await c.create(p, { ...body, engine: body.engine as 'postgres' | 'opensearch' | 'mysql' });
      await audit(req, 'connection.registered', { connection: row.id, name: row.name }, row.label, { engine: row.engine, endpoint: row.endpoint, zone: row.zone, account: row.account, credentialSource: row.credential_source, baoRole: row.bao_role, passwordFromVault: !!row.vault_owner });
      res.status(201).json(await view(p.tenantId, row.id));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A connection with that name exists.');
      throw err;
    }
  });

  r.patch('/connections/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({ endpoint: endpoint.optional(), database: z.string().trim().max(200).nullable().optional(), zone: z.string().trim().regex(/^[a-z0-9-]{1,63}$/).optional(), label: z.enum(LABELS).optional(), rowLimit: z.number().int().min(1).max(10_000).optional(), timeoutS: z.number().int().min(1).max(300).optional(), tls: z.boolean().optional(), ops: z.enum(['read', 'write']).optional() }).strict(),
      req.body
    );
    if (body.ops === 'write') throw conflict('Writes are not available on registered connections in this release: every query runs on a read-only account in a read-only transaction.');
    if (body.zone !== undefined || body.label !== undefined) {
      const cur = await c.get(p.tenantId, String(req.params.id));
      await s.zones.assertMemberFits('connection', body.zone ?? cur.zone, body.label ?? cur.label);
    }
    const row = await c.update(p, String(req.params.id), body);
    await audit(req, 'connection.updated', { connection: row.id, name: row.name }, row.label, { changed: Object.keys(body), version: row.version });
    res.json(await view(p.tenantId, row.id));
  });

  r.put('/connections/:id/credential', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.union([z.object({ username: z.string().trim().min(1).max(200), password: z.string().max(1000) }).strict(), z.object({ baoRole: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,128}$/) }).strict()]), req.body);
    if ('password' in body && isVaultRef(body.password)) await s.vault.assertRefsReadable(p, [body.password], { ip: ip(req), traceId: req.traceId });
    const row = 'baoRole' in body ? await c.setDynamicRole(p, String(req.params.id), body.baoRole) : await c.setCredential(p, String(req.params.id), body.username, body.password);
    await audit(req, 'connection.credential.rotated', { connection: row.id, name: row.name }, row.label, { account: row.account, credentialSource: row.credential_source, baoRole: row.bao_role, passwordFromVault: !!row.vault_owner, version: row.version });
    res.json(await view(p.tenantId, row.id));
  });

  r.delete('/connections/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const row = await c.get(p.tenantId, String(req.params.id));
    await c.remove(p, row.id);
    await audit(req, 'connection.removed', { connection: row.id, name: row.name }, row.label);
    res.status(204).end();
  });

  r.post('/connections/:id/test', manage, async (req, res) => {
    const p = principalOf(req);
    const out = await c.test(p.tenantId, String(req.params.id));
    const row = await c.get(p.tenantId, String(req.params.id));
    await audit(req, 'connection.tested', { connection: row.id, name: row.name }, row.label, { ok: out.ok, health: out.health, ms: out.ms });
    res.json(out);
  });

  r.post('/connections/:id/schema', manage, async (req, res) => {
    const p = principalOf(req);
    const out = await c.refreshSchema(p.tenantId, String(req.params.id));
    const row = await c.get(p.tenantId, String(req.params.id));
    await audit(req, 'connection.schema.refreshed', { connection: row.id, name: row.name }, row.label, out);
    res.json({ ...out, connection: await view(p.tenantId, row.id) });
  });

  r.put('/connections/:id/allow-list', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ objects: z.array(objectName).max(2000), piiColumns: z.array(z.string().trim().min(3).max(300)).max(5000).default([]) }).strict(), req.body);
    const row = await c.setAllowList(p, String(req.params.id), body.objects, body.piiColumns);
    await audit(req, 'connection.allow-list.saved', { connection: row.id, name: row.name }, row.label, { objects: row.allow_list, piiColumns: row.pii_columns, version: row.version });
    res.json(await view(p.tenantId, row.id));
  });

  const querySchema = z.object({ query: z.string().min(1).max(20_000), object: objectName.nullable().optional(), confirmUnparsed: z.boolean().default(false) }).strict();

  r.post('/connections/:id/query', manage, async (req, res) => {
    const body = parseBody(querySchema, req.body);
    res.json(await c.run(ctx(req), String(req.params.id), body));
  });

  r.post('/connections/:id/export', manage, async (req, res) => {
    const body = parseBody(querySchema, req.body);
    const out = await c.exportCsv(ctx(req), String(req.params.id), body);
    res.setHeader('Content-Disposition', `attachment; filename="${out.file}"`);
    res.setHeader('X-Label', out.label);
    res.type('text/csv').send(out.csv);
  });

  /** Syncs every knowledge source that reads from this connection. */
  r.post('/connections/:id/sync', manage, async (req, res) => {
    const p = principalOf(req);
    const row = await c.get(p.tenantId, String(req.params.id));
    const used = (await c.usage(p.tenantId)).get(row.id) ?? [];
    const jobs = [];
    for (const u of used) jobs.push((await s.knowledge.sync(p.userId, await s.knowledge.source(p.tenantId, u.sourceId))).jobId);
    await audit(req, 'connection.synced', { connection: row.id, name: row.name }, row.label, { sources: used.length });
    res.status(202).json({ jobs });
  });

  return r;
}
