import type { ProfileRow } from '../src/gateway/repo.js';
import type { FakeOllama } from './fake-ollama.js';
import type { Harness } from './helpers.js';

const GB = 1_000_000_000;

/** A pool on the fake Ollama with an approved tools-capable model and a published profile, through the repositories. */
export async function seedGateway(h: Harness, ollama: FakeOllama, profile: Partial<ProfileRow> = {}) {
  const repo = h.s.gateway.repo;
  ollama.addAvailable({ name: 'llama3.1:8b', size: 5 * GB, capabilities: ['completion', 'tools'] });
  const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
  await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 4 } });
  const model = await repo.createModel({ name: 'llama3.1:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
  await repo.updateModel(model.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'tools'], size_bytes: 5 * GB });
  await repo.place(model.id, pool.id, 'warm', 'x');
  const t = Date.now();
  const row: ProfileRow = { id: 'GENERAL0000000000000000000', tenant_id: h.tenantId, name: 'general', display_name: 'General', description: null, alias_of: null, model_id: model.id, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t, ...profile };
  await repo.createProfile(row);
  await h.s.gateway.pollAll();
  return { pool, model, profile: row };
}
