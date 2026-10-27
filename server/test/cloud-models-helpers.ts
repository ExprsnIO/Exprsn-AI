/*
 * 1.9.99-final, Sprint 60 (B-10502, B-10503, B-10509): what the cloud model backend suites share: a harness with two
 * model admins, an approved catalogue entry on a cloud instance, a profile on it, and a chat turn run to its end.
 * Every provider is an in-process fake; the account credentials are stand-ins for `s.cloud.credentials`.
 */
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);

export interface ModelsWorld {
  h: Harness;
  admin: Client;
  member: Client;
}

export async function modelsWorld(): Promise<ModelsWorld> {
  const h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', OLLAMA_POLL_MS: '600000' });
  await localUser(h, 'cma', ['model-admin', 'tenant-admin', 'cloud-operator', 'tool-admin', 'member'], 'confidential');
  const admin = await loginAdmin(h, 'cma');
  const id = (await h.s.db('users').where({ username: 'cma' }).first('id')).id as string;
  await post(admin, '/api/vault/policies', { subjectKind: 'user', subject: id, path: '*', capabilities: ['*'], description: 'cloud model servers' }).expect(201);
  await localUser(h, 'cmm', ['member'], 'internal');
  const member = await login(h, 'cmm');
  return { h, admin, member };
}

/** A pool, a cloud instance through the instance route, an approved model on it and a published profile `name`. */
export async function cloudProfile(w: ModelsWorld, o: { pool: string; instance: Record<string, unknown>; serverModel: string; profile: string; tools?: string[] }) {
  const pool = (await post(w.admin, '/api/admin/pools', { name: o.pool, accelerator: 'cpu', labelCeiling: 'internal' }).expect(201)).body;
  const res = await post(w.admin, `/api/admin/pools/${pool.id}/instances`, { kind: 'openai', deploy: 'docker', ...o.instance });
  if (res.status !== 201) throw new Error(`instance: ${res.status} ${JSON.stringify(res.body)}`);
  const inst = res.body;
  const mres = await post(w.admin, '/api/admin/models', { serverInstanceId: inst.id, serverModel: o.serverModel, license: { name: 'Provider terms' }, label: 'internal' });
  if (mres.status !== 201) throw new Error(`model: ${mres.status} ${JSON.stringify(mres.body)}`);
  const model = mres.body;
  await w.h.s.db('models').where({ id: model.id }).update({ state: 'approved' });
  const t = Date.now();
  const pid = `PR${Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(24, '0')}`.slice(0, 26);
  await w.h.s.gateway.repo.createProfile({ id: pid, tenant_id: w.h.tenantId, name: o.profile, display_name: o.profile, description: null, alias_of: null, model_id: model.id, pool_id: pool.id, num_ctx: 4096, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: o.tools ?? [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t } as never);
  return { pool, inst, model, profileId: pid };
}

/** Sends a chat message on a profile and waits for the answer to finish. */
export async function chatTurn(w: ModelsWorld, profile: string, content: string) {
  const sent = await post(w.member, '/api/chat', { content, profile }).expect(202);
  let msg: { state: string; id: string } | undefined;
  for (let i = 0; i < 2400; i++) {
    msg = await w.h.s.db('messages').where({ id: sent.body.messageId }).first();
    if (msg && ['complete', 'failed', 'held', 'blocked'].includes(msg.state)) break;
    await sleep(25);
  }
  return { sent: sent.body as { messageId: string; conversationId: string }, state: msg?.state ?? 'missing' };
}
