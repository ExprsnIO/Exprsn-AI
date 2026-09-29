import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Test } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ComfyUiBackend, createBackends, DiffusersBackend, fillWorkflow, type GenerateProgress } from '../src/images/backends.js';
import { addText, encodePng, readText } from '../src/images/png.js';
import type { Guardrails } from '../src/guardrails/types.js';
import { localUser, login, type Client, type Harness } from './helpers.js';
import { FakeImageBackend, FakeSafety, harness8 } from './sprint8-fakes.js';

const binary = (t: Test) =>
  t.buffer(true).parse((res, cb) => {
    const b: Buffer[] = [];
    res.on('data', (c: Buffer) => b.push(c));
    res.on('end', () => cb(null, Buffer.concat(b)));
  });

describe('image workers', () => {
  let server: Server | null = null;
  let dir: string | null = null;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server!.close(r));
      server = null;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };

  it('fills a ComfyUI workflow template keeping value types', () => {
    const wf = { '3': { inputs: { seed: '{{seed}}', steps: '{{steps}}', text: 'a {{prompt}}, detailed' } }, '5': { inputs: { width: '{{width}}', height: '{{height}}' } } };
    expect(fillWorkflow(wf, { seed: 7, steps: 20, prompt: 'barn', width: 1024, height: 768 })).toEqual({ '3': { inputs: { seed: 7, steps: 20, text: 'a barn, detailed' } }, '5': { inputs: { width: 1024, height: 768 } } });
  });

  it('drives ComfyUI through /prompt, /history and /view', async () => {
    const png = encodePng(2, 2, Buffer.alloc(12, 9));
    let submitted: { prompt: Record<string, { inputs: Record<string, unknown> }> } | null = null;
    let polls = 0;
    const url = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/prompt') {
          submitted = JSON.parse(body);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ prompt_id: 'p1' }));
        } else if (req.url === '/history/p1') {
          polls++;
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(polls < 2 ? {} : { p1: { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }));
        } else if (req.url?.startsWith('/view?')) {
          expect(req.url).toBe('/view?filename=out.png&subfolder=&type=output');
          res.writeHead(200, { 'content-type': 'image/png' }).end(png);
        } else res.writeHead(404).end();
      });
    });
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-comfy-'));
    const wfFile = path.join(dir, 'sdxl.json');
    writeFileSync(wfFile, JSON.stringify({ '6': { inputs: { text: '{{prompt}}' } }, '3': { inputs: { seed: '{{seed}}', steps: '{{steps}}' } } }));
    const b = new ComfyUiBackend('comfyui-sdxl', { id: 'comfyui-sdxl', kind: 'comfyui', url, workflow: wfFile, model: 'sdxl-base', concurrency: 1, steps: 30, timeoutMs: 20_000 });
    const progress: GenerateProgress[] = [];
    const out = await b.generate({ prompt: 'warehouse', width: 1024, height: 768, seed: 42, steps: 30 }, { signal: new AbortController().signal, onProgress: (p) => progress.push(p) });
    expect(out.image.equals(png)).toBe(true);
    expect(submitted!.prompt['6']!.inputs.text).toBe('warehouse');
    expect(submitted!.prompt['3']!.inputs).toEqual({ seed: 42, steps: 30 });
    expect(progress[0]).toEqual({ stage: 'Queued on the worker' });
  }, 15_000);

  it('reads step progress from a diffusers worker that streams NDJSON', async () => {
    const png = encodePng(2, 2, Buffer.alloc(12, 3));
    let got: Record<string, unknown> = {};
    const url = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ step: 1, steps: 2 }) + '\n');
        res.write(JSON.stringify({ step: 2, steps: 2 }) + '\n');
        res.end(JSON.stringify({ image: png.toString('base64'), gpu_seconds: 3.5, nsfw_score: 0.01 }) + '\n');
      });
    });
    const [b] = createBackends(JSON.stringify([{ id: 'diffusers-sdxl', kind: 'diffusers', url, model: 'sdxl-base' }]));
    expect(b).toBeInstanceOf(DiffusersBackend);
    const progress: GenerateProgress[] = [];
    const out = await b!.generate({ prompt: 'truck', width: 768, height: 768, seed: 1, steps: 2 }, { signal: new AbortController().signal, onProgress: (p) => progress.push(p) });
    expect(got).toMatchObject({ prompt: 'truck', width: 768, height: 768, seed: 1, num_inference_steps: 2, model: 'sdxl-base' });
    expect(progress).toEqual([{ stage: 'Denoising', step: 1, steps: 2 }, { stage: 'Denoising', step: 2, steps: 2 }]);
    expect(out).toMatchObject({ gpuMs: 3500, safety: 0.01 });
    expect(out.image.equals(png)).toBe(true);
    expect(() => createBackends('[{"id":"x","kind":"comfyui","url":"http://h"}]')).toThrow(/workflow file/);
  });

  it('adds and reads PNG text chunks', () => {
    const png = encodePng(1, 1, Buffer.from([1, 2, 3]));
    const withText = addText(png, 'exprsn-provenance', '{"a":1}');
    expect(readText(withText)).toEqual({ 'exprsn-provenance': '{"a":1}' });
  });
});

describe('images', () => {
  let h: Harness;
  let backend: FakeImageBackend;
  let safety: FakeSafety;
  let m: Client;
  afterEach(async () => {
    await h.close();
  });

  async function setup(env: Record<string, string> = {}) {
    backend = new FakeImageBackend();
    safety = new FakeSafety();
    h = await harness8(env, { imageBackends: [backend], imageSafety: safety });
    await localUser(h, 'mem', ['member']);
    m = await login(h, 'mem');
  }
  const gen = (body: object) => m.agent.post('/api/images').set('x-csrf-token', m.csrf).send({ backend: 'fake-sdxl', width: 1024, height: 768, ...body });

  it('generates, classifies, signs and seals images, metering GPU seconds', async () => {
    await setup();
    const list = (await m.agent.get('/api/images/backends').expect(200)).body;
    expect(list).toMatchObject({ backends: [{ id: 'fake-sdxl', label: 'fake, sdxl-base', steps: 4 }], safety: { classifier: 'fake-classifier', threshold: 0.5 } });
    const out = (await gen({ prompt: 'Isometric line drawing of a loading bay', count: 2, seed: 1000 }).expect(202)).body;
    expect(out.images).toHaveLength(2);
    expect(out.images.map((i: { seed: number }) => i.seed)).toEqual([1000, 1001]);
    expect(out.images[0]).toMatchObject({ state: 'queued', position: 1, etaMs: null, steps: 4 });
    expect(out.images[1]).toMatchObject({ position: 2 });
    await h.s.jobs.runDue();

    const imgs = (await m.agent.get('/api/images').expect(200)).body;
    expect(imgs.map((i: { state: string }) => i.state)).toEqual(['succeeded', 'succeeded']);
    const img = imgs.find((i: { seed: number }) => i.seed === 1000);
    expect(img).toMatchObject({ gpuSeconds: 1.5, step: 4, safety: { score: 0.02, classifier: 'fake-classifier' }, classified: true, provenance: { signed: true }, prompt: 'Isometric line drawing of a loading bay' });
    // Sealed at rest: prompt and pixels.
    const row = await h.s.db('image_jobs').where({ id: img.id }).first();
    expect(row.prompt).toMatch(/^v2\./);
    expect((await h.s.blobs.get(row.blob_key))!.toString()).toMatch(/^v2\./);

    const file = await binary(m.agent.get(`/api/images/${img.id}/download`)).expect(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="image-.*\.png"$/);
    const manifest = JSON.parse(readText(file.body as Buffer)['exprsn-provenance']!);
    expect(manifest).toMatchObject({ job: img.id, seed: 1000, backend: 'fake-sdxl', model: 'sdxl-base', username: 'mem', label: 'internal', safety: { score: 0.02 }, generator: 'Exprsn-AI' });
    expect(manifest.signature).toMatch(/^local:v1:/);
    const verify = (await m.agent.get(`/api/images/${img.id}/provenance`).expect(200)).body;
    expect(verify).toMatchObject({ verified: true, signature: true, bytesMatch: true, embedded: true });
    expect(await h.s.db('audit_events').where({ action: 'image.downloaded' })).toHaveLength(1);

    // Tampering with the stored manifest breaks the signature.
    const prov = JSON.parse(row.provenance);
    await h.s.db('image_jobs').where({ id: img.id }).update({ provenance: JSON.stringify({ ...prov, seed: 1 }) });
    expect((await m.agent.get(`/api/images/${img.id}/provenance`).expect(200)).body).toMatchObject({ verified: false, signature: false });

    const usage = await h.s.db('usage_records').where({ kind: 'image' });
    expect(usage).toHaveLength(2);
    expect(usage.reduce((s: number, u: { gpu_ms: number }) => s + Number(u.gpu_ms), 0)).toBe(3000);
    // The next request waits behind measured history.
    const next = (await gen({ prompt: 'Another', count: 1 }).expect(202)).body;
    expect(next.images[0].etaMs).toBeGreaterThanOrEqual(0);

    // Send to chat: the picture becomes an attachment, scanned like any upload.
    const att = (await m.agent.post(`/api/images/${img.id}/attach`).set('x-csrf-token', m.csrf).expect(202)).body;
    expect(att).toMatchObject({ state: 'quarantined', label: 'internal' });
    await h.s.jobs.runDue();
    expect((await m.agent.get(`/api/attachments/${att.id}`).expect(200)).body).toMatchObject({ state: 'ready', type: 'image/png' });

    // Vary: same prompt and size, next seed.
    const vary = (await m.agent.post(`/api/images/${img.id}/vary`).set('x-csrf-token', m.csrf).expect(202)).body;
    expect(vary.images[0]).toMatchObject({ seed: 1001, prompt: 'Isometric line drawing of a loading bay' });
  });

  it('blocks a prompt at the image checkpoint before any GPU time is spent', async () => {
    await setup();
    h.s.guardrails = {
      check: async (i) =>
        i.checkpoint === 'image' && /portrait of the/i.test(i.text)
          ? { action: 'block', text: i.text, reason: 'Rule no-real-person-likeness in Finance baseline v12 matched.', findings: [{ ruleId: 'r9', ruleName: 'no-real-person-likeness', action: 'block', stage: 'enforce' }] }
          : { action: 'allow', text: i.text, findings: [] }
    } satisfies Guardrails;
    const r = await gen({ prompt: 'Photo-real portrait of the CFO', count: 4 }).expect(422);
    expect(r.body).toMatchObject({ title: 'Prompt blocked', detail: 'Rule no-real-person-likeness in Finance baseline v12 matched.', rule: 'no-real-person-likeness' });
    expect(await h.s.db('image_jobs')).toHaveLength(0);
    expect(backend.requests).toHaveLength(0);
    await localUser(h, 'rev', ['flag-reviewer']);
    const rep = (await m.agent.post('/api/images/report').set('x-csrf-token', m.csrf).send({ kind: 'prompt', rule: 'no-real-person-likeness', note: 'An illustration, not a likeness.' }).expect(200)).body;
    expect(rep.notified).toBe(1);
    expect(await h.s.db('audit_events').whereIn('action', ['image.prompt.blocked', 'image.reported'])).toHaveLength(2);
  });

  it('discards an unsafe output, still meters it, and raises it to reviewers', async () => {
    await setup();
    await localUser(h, 'rev', ['flag-reviewer']);
    safety.score = () => 0.81;
    const out = (await gen({ prompt: 'Something', count: 1 }).expect(202)).body;
    await h.s.jobs.runDue();
    const img = (await m.agent.get(`/api/images/${out.images[0].id}`).expect(200)).body;
    expect(img).toMatchObject({ state: 'withheld', safety: { score: 0.81 }, gpuSeconds: 1.5 });
    expect((await h.s.db('image_jobs').where({ id: img.id }).first()).blob_key).toBeNull();
    await m.agent.get(`/api/images/${img.id}/download`).expect(409);
    expect(await h.s.db('usage_records').where({ kind: 'image' })).toHaveLength(1);
    expect(await h.s.db('notifications').where({ title: 'Generated image withheld' })).toHaveLength(1);
    expect(await h.s.db('audit_events').where({ action: 'image.withheld' })).toHaveLength(1);
  });

  it('refuses generation once the GPU-second quota is used, and cancels queued jobs', async () => {
    await setup();
    const quota0 = (await m.agent.get('/api/images/quota').expect(200)).body;
    expect(quota0).toMatchObject({ scope: 'tenant', used: 0, limit: null });
    await h.s.quotas.set(h.tenantId, null, { gpuSecondsPerMonth: 2 }, 'test');
    await gen({ prompt: 'One', count: 2 }).expect(202);
    await h.s.jobs.runDue();
    const quota = (await m.agent.get('/api/images/quota').expect(200)).body;
    expect(quota).toMatchObject({ used: 3, limit: 2, raisedBy: 'a system admin' });
    const r = await gen({ prompt: 'Two', count: 1 }).expect(429);
    expect(r.headers['retry-after']).toBeTruthy();
    expect(r.body).toMatchObject({ limit: 'gpu_seconds_per_month', max: 2 });

    await h.s.quotas.set(h.tenantId, null, { gpuSecondsPerMonth: null }, 'test');
    const q = (await gen({ prompt: 'Three', count: 1 }).expect(202)).body;
    const c = (await m.agent.post(`/api/images/${q.images[0].id}/cancel`).set('x-csrf-token', m.csrf).expect(200)).body;
    expect(c.state).toBe('cancelled');
    await h.s.jobs.runDue();
    expect(backend.requests).toHaveLength(2);
    await gen({ prompt: 'Too big', width: 4096, count: 1 }).expect(400);
    await gen({ prompt: 'Too many', count: 9 }).expect(400);
    await gen({ prompt: 'Confidential', label: 'confidential' }).expect(403);
  });
});
