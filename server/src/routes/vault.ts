import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { effectivePermissions } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, forbidden, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { CAPABILITIES, SUBJECT_KINDS, type Subjects } from '../vault/policy.js';
import { TRANSIT_KEY_TYPES } from '../vault/transit.js';

/*
 * The secrets vault (Sprint 24: B-1701 KV secrets, B-1702 transit, B-1703 policies). Every route needs a vault
 * permission (`secrets:read` to read and use keys, `secrets:write` to write and soft-delete, `secrets:admin` to
 * destroy, manage transit keys and edit policies) and then the path policy for the capability it uses. Values and
 * plaintext appear only in the response that carries them; the audit chain records paths and versions.
 */

const versionNum = z.number().int().min(1).max(1_000_000_000);
const kvValue = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, 'Keys are 1 to 128 letters, digits, dot, dash and underscore'), z.string().max(64 * 1024)).refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 200, 'A secret holds 1 to 200 keys');
const b64 = z.string().max(400_000).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Base64');
const ciphertext = z.string().min(1).max(400_000);
const batchMax = 100;
const capability = z.enum(CAPABILITIES);

/** The `*path` wildcard of a route as a string. */
const wildPath = (req: Request): string => {
  const p = (req.params as Record<string, string | string[]>).path;
  return Array.isArray(p) ? p.join('/') : String(p ?? '');
};

const buf = (v: string | null | undefined): Buffer | null => (v == null ? null : Buffer.from(v, 'base64'));

export function vaultRoutes(s: Services): Router {
  const r = Router();
  r.use('/vault', noStore, requireAuth());
  const read = requirePermission(s, 'secrets:read');
  const write = requirePermission(s, 'secrets:write');
  const admin = requirePermission(s, 'secrets:admin');
  const v = s.vault;
  const caller = (req: Request) => v.callerFor(principalOf(req), { ip: ip(req), traceId: req.traceId });

  // ---- KV secrets (B-1701) ----

  r.get('/vault/kv', read, async (req, res) => {
    const q = parseBody(z.object({ prefix: z.string().max(400).optional() }).strict(), req.query);
    res.json({ secrets: await v.list(await caller(req), q.prefix) });
  });

  r.get('/vault/kv/metadata/*path', read, async (req, res) => {
    res.json(await v.metadata(await caller(req), wildPath(req)));
  });

  r.patch('/vault/kv/metadata/*path', write, async (req, res) => {
    const b = parseBody(
      z.object({
        maxVersions: z.number().int().min(1).max(100).optional(),
        casRequired: z.boolean().optional(),
        customMetadata: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(512)).refine((o) => Object.keys(o).length <= 32, 'At most 32 metadata entries').optional(),
        label: z.enum(LABELS).optional()
      }).strict(),
      req.body
    );
    res.json(await v.updateMetadata(await caller(req), wildPath(req), b));
  });

  r.delete('/vault/kv/metadata/*path', admin, async (req, res) => {
    await v.deleteAll(await caller(req), wildPath(req));
    res.status(204).end();
  });

  r.get('/vault/kv/data/*path', read, async (req, res) => {
    const q = parseBody(z.object({ version: z.coerce.number().int().min(1).max(1_000_000_000).optional() }).strict(), req.query);
    res.json(await v.read(await caller(req), wildPath(req), q.version));
  });

  r.put('/vault/kv/data/*path', write, async (req, res) => {
    const b = parseBody(z.object({ data: kvValue, cas: z.number().int().min(0).max(1_000_000_000).optional(), label: z.enum(LABELS).optional() }).strict(), req.body);
    const out = await v.write(await caller(req), wildPath(req), b.data, { ...(b.cas !== undefined ? { cas: b.cas } : {}), ...(b.label ? { label: b.label } : {}) });
    res.status(out.version === 1 ? 201 : 200).json(out);
  });

  const versionsBody = z.object({ versions: z.array(versionNum).min(1).max(100).optional() }).strict();

  r.post('/vault/kv/delete/*path', write, async (req, res) => {
    const b = parseBody(versionsBody, req.body ?? {});
    res.json(await v.softDelete(await caller(req), wildPath(req), b.versions));
  });

  r.post('/vault/kv/undelete/*path', write, async (req, res) => {
    const b = parseBody(z.object({ versions: z.array(versionNum).min(1).max(100) }).strict(), req.body);
    res.json(await v.undelete(await caller(req), wildPath(req), b.versions));
  });

  r.post('/vault/kv/destroy/*path', admin, async (req, res) => {
    const b = parseBody(z.object({ versions: z.array(versionNum).min(1).max(100) }).strict(), req.body);
    res.json(await v.destroyVersions(await caller(req), wildPath(req), b.versions));
  });

  // ---- transit (B-1702) ----

  r.get('/vault/transit/keys', read, async (req, res) => {
    res.json({ keys: await v.listKeys(await caller(req)) });
  });

  r.post('/vault/transit/keys', admin, async (req, res) => {
    const b = parseBody(z.object({ name: z.string().min(1).max(64), type: z.enum(TRANSIT_KEY_TYPES).default('aes256-gcm96'), label: z.enum(LABELS).optional() }).strict(), req.body);
    res.status(201).json(await v.createKey(await caller(req), b));
  });

  r.get('/vault/transit/keys/:name', read, async (req, res) => {
    res.json(await v.getKey(await caller(req), String(req.params.name)));
  });

  r.patch('/vault/transit/keys/:name', admin, async (req, res) => {
    const b = parseBody(z.object({ minDecryptVersion: versionNum.optional(), deletionAllowed: z.boolean().optional() }).strict(), req.body);
    res.json(await v.configureKey(await caller(req), String(req.params.name), b));
  });

  r.post('/vault/transit/keys/:name/rotate', admin, async (req, res) => {
    res.json(await v.rotateKey(await caller(req), String(req.params.name)));
  });

  r.post('/vault/transit/keys/:name/trim', admin, async (req, res) => {
    const b = parseBody(z.object({ minAvailableVersion: versionNum }).strict(), req.body);
    res.json(await v.trimKey(await caller(req), String(req.params.name), b.minAvailableVersion));
  });

  r.delete('/vault/transit/keys/:name', admin, async (req, res) => {
    await v.deleteKey(await caller(req), String(req.params.name));
    res.status(204).end();
  });

  // One item (`plaintext` / `ciphertext`) or `batch`; batches answer item by item.
  const encryptItem = z.object({ plaintext: b64, context: b64.max(4096).optional() }).strict();
  const decryptItem = z.object({ ciphertext, context: b64.max(4096).optional() }).strict();
  const oneOrBatch = <T extends z.ZodObject>(item: T) => z.union([item, z.object({ batch: z.array(item).min(1).max(batchMax) }).strict()]);

  r.post('/vault/transit/encrypt/:name', read, async (req, res) => {
    const b = parseBody(oneOrBatch(encryptItem), req.body);
    const items = ('batch' in b ? b.batch : [b]) as z.infer<typeof encryptItem>[];
    const out = await v.encrypt(await caller(req), String(req.params.name), items.map((i) => ({ plaintext: Buffer.from(i.plaintext, 'base64'), context: buf(i.context) })));
    res.json('batch' in b ? { batch: out.map((ciphertext) => ({ ciphertext })) } : { ciphertext: out[0] });
  });

  r.post('/vault/transit/decrypt/:name', read, async (req, res) => {
    const b = parseBody(oneOrBatch(decryptItem), req.body);
    const items = ('batch' in b ? b.batch : [b]) as z.infer<typeof decryptItem>[];
    const out = await v.decrypt(await caller(req), String(req.params.name), items.map((i) => ({ ciphertext: i.ciphertext, context: buf(i.context) })));
    const view = (o: (typeof out)[number]) => ('plaintext' in o ? { plaintext: o.plaintext.toString('base64') } : o);
    if ('batch' in b) return res.json({ batch: out.map(view) });
    const one = out[0]!;
    if ('error' in one) throw one.status === 400 ? badRequest(one.error) : forbidden(one.error);
    res.json(view(one));
  });

  r.post('/vault/transit/rewrap/:name', read, async (req, res) => {
    const b = parseBody(oneOrBatch(decryptItem), req.body);
    const items = ('batch' in b ? b.batch : [b]) as z.infer<typeof decryptItem>[];
    const out = await v.rewrap(await caller(req), String(req.params.name), items.map((i) => ({ ciphertext: i.ciphertext, context: buf(i.context) })));
    if ('batch' in b) return res.json({ batch: out });
    const one = out[0]!;
    if ('error' in one) throw one.status === 400 ? badRequest(one.error) : forbidden(one.error);
    res.json(one);
  });

  r.post('/vault/transit/sign/:name', read, async (req, res) => {
    const b = parseBody(z.object({ input: b64.max(90_000) }).strict(), req.body);
    res.json(await v.sign(await caller(req), String(req.params.name), Buffer.from(b.input, 'base64')));
  });

  r.post('/vault/transit/verify/:name', read, async (req, res) => {
    const b = parseBody(z.object({ input: b64.max(90_000), signature: z.string().min(1).max(4096) }).strict(), req.body);
    res.json(await v.verify(await caller(req), String(req.params.name), Buffer.from(b.input, 'base64'), b.signature));
  });

  // ---- policies (B-1703) ----

  const grantBody = z.object({
    subjectKind: z.enum(SUBJECT_KINDS),
    subject: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1).max(400),
    capabilities: z.array(z.union([capability, z.literal('*')])).min(1).max(CAPABILITIES.length + 1),
    effect: z.enum(['allow', 'deny']).default('allow'),
    description: z.string().trim().max(500).nullable().optional()
  }).strict();

  r.get('/vault/policies', admin, async (req, res) => {
    res.json({ policies: await v.listGrants(principalOf(req).tenantId) });
  });

  r.post('/vault/policies', admin, async (req, res) => {
    const b = parseBody(grantBody, req.body);
    res.status(201).json(await v.createGrant(await caller(req), b));
  });

  r.patch('/vault/policies/:id', admin, async (req, res) => {
    const b = parseBody(grantBody.pick({ path: true, capabilities: true, effect: true, description: true }).partial().strict(), req.body);
    res.json(await v.updateGrant(await caller(req), parseBody(z.string().length(26), req.params.id), b));
  });

  r.delete('/vault/policies/:id', admin, async (req, res) => {
    await v.deleteGrant(await caller(req), parseBody(z.string().length(26), req.params.id));
    res.status(204).end();
  });

  /**
   * Which grant decides a capability on a path. For yourself with `secrets:read`; for another user or API key of the
   * tenant with `secrets:admin`.
   */
  r.post('/vault/policies/explain', read, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ path: z.string().trim().min(1).max(400), capability, userId: z.string().length(26).optional(), apiKeyId: z.string().length(26).optional() }).strict(), req.body);
    let subjects: Subjects;
    if (b.userId || b.apiKeyId) {
      if (!effectivePermissions(p).has('secrets:admin')) throw forbidden('Explaining the vault policy for someone else needs secrets:admin.', { step: 'role', action: 'secrets:admin' });
      if (b.apiKeyId) {
        const key = (await s.db('api_keys').where({ tenant_id: p.tenantId, id: b.apiKeyId }).first('user_id')) as { user_id: string } | undefined;
        if (!key) throw notFound('API key');
        if (b.userId && b.userId !== key.user_id) throw badRequest('The API key belongs to another user.');
        subjects = await v.subjectsFor(p.tenantId, key.user_id, b.apiKeyId);
      } else {
        if (!(await s.users.get(p.tenantId, b.userId!))) throw notFound('User');
        subjects = await v.subjectsFor(p.tenantId, b.userId!, null);
      }
    } else subjects = (await caller(req)).subjects;
    res.json(await v.explain(p.tenantId, subjects, b.path, b.capability));
  });

  return r;
}
