import { deflateRawSync, deflateSync } from 'node:zlib';
import type { ProfileRow } from '../src/gateway/repo.js';
import { createDb, migrate } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices, type ServiceOverrides } from '../src/services.js';
import { bootstrap } from '../src/bootstrap.js';
import type { FakeOllama } from './fake-ollama.js';
import { localUser, login, testConfig, type Harness } from './helpers.js';

/** The standard test harness, with service overrides (fake drivers, a Git fetcher that may read file://). */
export async function harnessWith(overrides: ServiceOverrides, env: Record<string, string> = {}): Promise<Harness> {
  const cfg = testConfig(env);
  const db = createDb(cfg);
  await migrate(db);
  const s = createServices(cfg, db, createLogger('silent', false), new Metrics(), overrides);
  await bootstrap(s);
  const tenant = await s.tenants.bySlug(cfg.DEFAULT_TENANT);
  return {
    s,
    app: createApp(s),
    tenantId: tenant!.id,
    close: async () => {
      await s.close();
      await db.destroy();
    }
  };
}

const GB = 1_000_000_000;

/**
 * A pool on the fake Ollama with two approved embedding models, a completion model (also the reranker) and a
 * published `general` profile labelled confidential, created through the repositories.
 */
export async function seedRetrieval(h: Harness, ollama: FakeOllama) {
  const repo = h.s.gateway.repo;
  const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
  await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 8 } });
  const models: Record<string, string> = {};
  for (const [name, caps] of [
    ['nomic-embed-text', ['embedding']],
    ['bge-m3', ['embedding']],
    ['llama3.1:8b', ['completion', 'tools']]
  ] as const) {
    ollama.addAvailable({ name, size: 1 * GB, capabilities: [...caps] });
    const m = await repo.createModel({ name, source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: [...caps], size_bytes: GB });
    await repo.place(m.id, pool.id, 'warm', 'x');
    models[name] = m.id;
  }
  const t = Date.now();
  const general: ProfileRow = { id: 'GENERAL'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'general', display_name: 'General', description: null, alias_of: null, model_id: models['llama3.1:8b']!, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: 'Be brief.', fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
  await repo.createProfile(general);
  await h.s.gateway.pollAll();
  return { pool, models, general };
}

/** Signs in a user with the given roles; returns helpers that send the CSRF header. */
export async function client(h: Harness, name: string, roles: string[], clearance: 'public' | 'internal' | 'confidential' | 'restricted' = 'internal') {
  const user = await localUser(h, name, roles, clearance);
  const c = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return { user, agent: c.agent, csrf: c.csrf, cookie: c.cookie, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), put: (p: string, b?: object) => send('put', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
}

/** Runs queued jobs until none are left (jobs may enqueue more). */
export async function drain(h: Harness): Promise<void> {
  for (let i = 0; i < 20; i++) if (!(await h.s.jobs.runDue())) return;
}

// ---------- document builders ----------

/** A minimal zip (deflated entries) with a central directory. */
export function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function docx(paragraphs: { text: string; style?: string }[]): Buffer {
  const body = paragraphs.map((p) => `<w:p>${p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${p.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  return zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>` });
}

/** A one-page PDF whose content stream (Flate-compressed) shows the given lines. */
export function pdf(lines: string[], opts: { encrypted?: boolean } = {}): Buffer {
  const content = 'BT /F1 12 Tf 72 720 Td ' + lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l.replace(/([()\\])/g, '\\$1')}) Tj`).join(' ') + ' ET';
  const stream = deflateSync(Buffer.from(content, 'latin1'));
  const parts = [
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n', 'latin1'),
    Buffer.from(`4 0 obj << /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    stream,
    Buffer.from(`\nendstream\nendobj\ntrailer << /Root 1 0 R${opts.encrypted ? ' /Encrypt 5 0 R' : ''} >>\n%%EOF\n`, 'latin1')
  ];
  return Buffer.concat(parts);
}
