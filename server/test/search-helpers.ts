import type { Label } from '../src/authz/labels.js';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import type { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * 1.9.0, Sprint 52 (B-170 to B-173): what the search suites share. Migrations 138 and 139 are applied here when the
 * build has not registered them yet (guarded by hasTable, as the e2e server does).
 */

export async function applySearchMigrations(h: Harness): Promise<void> {
  const db = h.s.db;
  if (!(await db.schema.hasTable('search_postings'))) await (await import('../src/db/migrations/138_search_index.js')).up(db);
  if (!(await db.schema.hasTable('search_state'))) await (await import('../src/db/migrations/139_search_state.js')).up(db);
  h.s.search.index.resetSchemaCache();
}

export async function searchHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const h = await harness(overrides);
  await applySearchMigrations(h);
  return h;
}

export type Person = Awaited<ReturnType<typeof person>>;

export async function person(h: Harness, name: string, workspaces: string[], o: { roles?: string[]; clearance?: Label } = {}) {
  const user = await localUser(h, name, o.roles ?? ['member'], o.clearance ?? 'internal');
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return {
    user,
    ...c,
    post: (p: string, b?: object) => send('post', p, b),
    put: (p: string, b?: object) => send('put', p, b),
    patch: (p: string, b?: object) => send('patch', p, b),
    del: (p: string) => send('delete', p),
    get: (p: string) => c.agent.get(p),
    principal: async (): Promise<Principal> => (await loadPrincipal(h.s, h.tenantId, user.id, {}))!
  };
}

/** A tenant administrator's principal, for the index's administration through the service. */
export async function adminPrincipal(h: Harness, name = 'tadmin'): Promise<Principal> {
  const u = await localUser(h, name, ['tenant-admin'], 'confidential');
  return (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
}

/** Lets the background index writes finish, then runs due jobs (the backfill among them). */
export async function settle(h: Harness): Promise<void> {
  await h.s.search.index.drain();
  await drain(h);
  await h.s.search.index.drain();
}

/** Turns the index on for the tenant and runs its backfill to the end. */
export async function enableIndex(h: Harness, p?: Principal): Promise<void> {
  await h.s.search.index.enable({ p: p ?? (await adminPrincipal(h)), ip: null });
  await settle(h);
}

export const count = async (h: Harness, table: string, where: Record<string, unknown> = {}): Promise<number> => Number(((await h.s.db(table).where(where).count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);

/** A pool on the fake Ollama with an approved embedding model and a completion model (for meaning and knowledge). */
export async function seedEmbeddings(h: Harness, ollama: FakeOllama): Promise<void> {
  const repo = h.s.gateway.repo;
  const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
  await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 8 } });
  const ids: Record<string, string> = {};
  for (const [name, caps] of [
    ['nomic-embed-text', ['embedding']],
    ['llama3.1:8b', ['completion']]
  ] as const) {
    ollama.addAvailable({ name, size: 1e9, capabilities: [...caps] });
    const m = await repo.createModel({ name, source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: [...caps], size_bytes: 1e9 });
    await repo.place(m.id, pool.id, 'warm', 'x');
    ids[name] = m.id;
  }
  const t = Date.now();
  const general: ProfileRow = { id: 'GENERAL'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'general', display_name: 'General', description: null, alias_of: null, model_id: ids['llama3.1:8b']!, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
  await repo.createProfile(general);
  await h.s.gateway.pollAll();
}

export { drain };
