import type request from 'supertest';
import type { Label } from '../src/authz/labels.js';
import { encodePng } from '../src/images/png.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * 1.9.0, Sprint 53 (B-177 to B-179): what the album suites share. Migrations 135 and 136 are applied here when the
 * build has not registered them yet (they are guarded by hasTable, as the e2e server does).
 */

export async function albumHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const h = await harness(overrides);
  const db = h.s.db;
  if (!(await db.schema.hasTable('albums'))) await (await import('../src/db/migrations/135_albums.js')).up(db);
  if (!(await db.schema.hasTable('album_share_links'))) await (await import('../src/db/migrations/136_album_links.js')).up(db);
  h.s.files.albums.resetSchemaCache();
  h.s.files.albums.notifyWindowMs = 0;
  return h;
}

/** A small PNG; `seed` makes its pixels (and so its content) different. */
export const png = (seed = 1): Buffer => encodePng(4, 4, Buffer.alloc(48, seed % 256));

export const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const parts: Buffer[] = [];
  res.on('data', (c: Buffer) => parts.push(c));
  res.on('end', () => cb(null, Buffer.concat(parts)));
};

export interface Member {
  user: { id: string };
  agent: ReturnType<typeof request.agent>;
  get(path: string): request.Test;
  post(path: string, body?: object): request.Test;
  put(path: string, body?: object): request.Test;
  patch(path: string, body?: object): request.Test;
  del(path: string): request.Test;
  /** Uploads a file to the file store (a workspace) and waits for its scan. */
  upload(name: string, data: Buffer, q?: Record<string, string>): Promise<{ id: string; label: Label; state: string }>;
}

export async function member(h: Harness, name: string, workspaces: string[], o: { roles?: string[]; clearance?: Label } = {}): Promise<Member> {
  const u = await localUser(h, name, o.roles ?? ['member'], o.clearance ?? 'internal');
  for (const w of workspaces) await h.s.tenants.addMember(w, u.id);
  const c = await login(h, name);
  const csrf = c.csrf;
  const send = (method: 'post' | 'put' | 'patch' | 'delete', path: string, body?: object) => c.agent[method](path).set('x-csrf-token', csrf).send(body ?? {});
  return {
    user: u,
    agent: c.agent,
    get: (p) => c.agent.get(p),
    post: (p, b) => send('post', p, b),
    put: (p, b) => send('put', p, b),
    patch: (p, b) => send('patch', p, b),
    del: (p) => c.agent.delete(p).set('x-csrf-token', csrf),
    upload: async (fileName, data, q = {}) => {
      const res = await c.agent.put(`/api/files/uploads?${new URLSearchParams({ name: fileName, workspace: workspaces[0]!, ...q }).toString()}`).set('x-csrf-token', csrf).set('content-type', 'application/octet-stream').send(data);
      if (res.status !== 202) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
      await drain(h);
      const f = await h.s.db('files').where({ id: res.body.id }).first('id', 'label', 'state');
      return f as { id: string; label: Label; state: string };
    }
  };
}

export const audits = async (h: Harness, action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null; actor: string; label: string }[];

/** Turns anonymous links on for the tenant (B-706's setting, which album share links follow). */
export async function allowAnonymousLinks(h: Harness, maxHours = 72): Promise<void> {
  const row = { anonymous_links: true, anonymous_max_hours: maxHours, updated_by: null, updated_at: Date.now() };
  const n = await h.s.db('chat_sharing_settings').where({ tenant_id: h.tenantId }).update(row);
  if (!n) await h.s.db('chat_sharing_settings').insert({ tenant_id: h.tenantId, ...row });
}

export { drain };
