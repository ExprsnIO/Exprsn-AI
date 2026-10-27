import type { Test } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConvertResult } from '../src/images/export.js';
import { localUser, login, type Client, type Harness } from './helpers.js';
import { FakeImageBackend, FakeSafety, harness8 } from './sprint8-fakes.js';

// 2026-10-16: exports of generated images as WebP, GIF, JPEG XL, JPEG, PNG or PDF, downloaded or saved into Files,
// through the sandboxed converter (a fake here: what it is asked is recorded).

const binary = (t: Test) =>
  t.buffer(true).parse((res, cb) => {
    const b: Buffer[] = [];
    res.on('data', (c: Buffer) => b.push(c));
    res.on('end', () => cb(null, Buffer.concat(b)));
  });

describe('image exports', () => {
  let h: Harness;
  let m: Client;
  let asked: Record<string, unknown>[];
  afterEach(async () => {
    await h.close();
  });

  async function setup(withConverter = true) {
    h = await harness8({}, { imageBackends: [new FakeImageBackend()], imageSafety: new FakeSafety() });
    await localUser(h, 'mem', ['member']);
    await localUser(h, 'other', ['member']);
    m = await login(h, 'mem');
    asked = [];
    if (withConverter)
      h.s.imageExports.converter = async (_p, args): Promise<ConvertResult> => {
        asked.push(args);
        const to = String(args.to);
        const frames = Array.isArray(args.frames) ? args.frames.length : 1;
        return { mediaType: { jxl: 'image/jxl', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', pdf: 'application/pdf', png: 'image/png' }[to]!, content: Buffer.from(`${to.toUpperCase()}:${frames}`).toString('base64'), encoding: 'base64', width: 1024, height: 768, frames, notes: [`made ${to}`], warnings: [] };
      };
  }
  const post = (c: Client, path: string, body: object) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body);
  async function images(count: number): Promise<string[]> {
    await post(m, '/api/images', { backend: 'fake-sdxl', width: 1024, height: 768, prompt: 'A lighthouse at dawn', count, seed: 7 }).expect(202);
    await h.s.jobs.runDue();
    return ((await m.agent.get('/api/images').expect(200)).body as { id: string; state: string }[]).filter((i) => i.state === 'succeeded').map((i) => i.id);
  }

  it('says whether exports work here, and refuses with 503 without the converter', async () => {
    await setup(false);
    const [id] = await images(1);
    expect((await m.agent.get('/api/images/export').expect(200)).body).toEqual({ available: false, formats: ['webp', 'gif', 'jxl', 'jpg', 'png', 'pdf'] });
    const r = await post(m, '/api/images/export', { ids: [id], format: 'webp' }).expect(503);
    expect(r.body.detail).toContain('exprsn-imgconv.image_convert');
  });

  it('downloads one image as JPEG XL with every option passed to the converter, and audits the sources', async () => {
    await setup();
    const [id] = await images(1);
    expect((await m.agent.get('/api/images/export').expect(200)).body.available).toBe(true);
    const options = { lossless: true, bit_depth: 16, hdr: 'pq', sdr_white: 203, roi: { x: 0.5, y: 0.25 }, tile_size: 512, progressive: true, effort: 8 };
    const r = await binary(post(m, '/api/images/export', { ids: [id], format: 'jxl', options })).expect(200);
    expect(r.headers['content-type']).toBe('image/jxl');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="image-${id!.toLowerCase()}.jxl"`);
    expect((r.body as Buffer).toString()).toBe('JXL:1');
    const notes = JSON.parse(decodeURIComponent(String(r.headers['x-export-notes'])));
    expect(notes).toMatchObject({ width: 1024, height: 768, frames: 1, label: 'internal' });
    expect(notes.notes).toEqual(['made jxl', expect.stringContaining('C2PA')]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ to: 'jxl', metadata: 'strip', ...options });
    expect(Buffer.from(String(asked[0]!.base64), 'base64').subarray(1, 4).toString()).toBe('PNG');
    const a = await h.s.db('audit_events').where({ action: 'image.exported' }).first();
    const detail = typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail;
    expect(detail).toMatchObject({ format: 'jxl', to: 'download', frames: 1, bytes: 5, images: [{ id, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
  });

  it('makes several images one animation or one PDF page each; JPEG holds one image', async () => {
    await setup();
    const ids = await images(3);
    expect(ids).toHaveLength(3);
    const g = await binary(post(m, '/api/images/export', { ids, format: 'gif', options: { frame_ms: 400, loop: 0 } })).expect(200);
    expect((g.body as Buffer).toString()).toBe('GIF:3');
    expect(g.headers['content-disposition']).toBe('attachment; filename="images-3.gif"');
    expect(asked[0]).toMatchObject({ to: 'gif', frame_ms: 400, loop: 0 });
    expect((asked[0]!.frames as { base64: string; name: string }[]).map((f) => f.name)).toEqual(ids.map((i) => `image-${i.toLowerCase()}.png`));
    expect(asked[0]!.base64).toBeUndefined();
    await binary(post(m, '/api/images/export', { ids, format: 'pdf', name: 'Lighthouse sheet' })).expect(200).then((r) => expect(r.headers['content-disposition']).toBe('attachment; filename="Lighthouse sheet.pdf"'));
    const j = await post(m, '/api/images/export', { ids: ids.slice(0, 2), format: 'jpg' }).expect(422);
    expect(j.body.detail).toContain('JPG holds one image');
  });

  it('saves into Files at the image\'s label; another member cannot export the image', async () => {
    await setup();
    const [id] = await images(1);
    // Files live in a workspace: without one it is refused, as an upload is
    await post(m, '/api/images/export', { ids: [id], format: 'webp', to: 'files' }).expect(409);
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Studio', 'confidential')).id;
    await h.s.tenants.addMember(ws, (await h.s.db('users').where({ tenant_id: h.tenantId, username: 'mem' }).first('id')).id);
    const r = await post(m, '/api/images/export', { ids: [id], format: 'webp', options: { quality: 82 }, to: 'files', workspaceId: ws, name: 'lighthouse' }).expect(201);
    expect(r.body.file).toMatchObject({ name: 'lighthouse.webp', workspaceId: ws });
    expect(r.body.export).toMatchObject({ name: 'lighthouse.webp', mediaType: 'image/webp', frames: 1, label: 'internal' });
    const file = await h.s.db('files').where({ id: r.body.file.id }).first();
    expect(file).toBeTruthy();
    const a = await h.s.db('audit_events').where({ action: 'image.exported' }).first();
    expect(JSON.parse(String(a.target))).toMatchObject({ file: r.body.file.id });
    const other = await login(h, 'other');
    await post(other, '/api/images/export', { ids: [id], format: 'webp' }).expect(404);
  });

  it('checks the options before converting', async () => {
    await setup();
    const [id] = await images(1);
    await post(m, '/api/images/export', { ids: [id], format: 'jxl', options: { bit_depth: 9 } }).expect(400);
    await post(m, '/api/images/export', { ids: [id], format: 'jxl', options: { tile_size: 300 } }).expect(400);
    await post(m, '/api/images/export', { ids: [id], format: 'jxl', options: { hdr: 'dolby' } }).expect(400);
    await post(m, '/api/images/export', { ids: [id], format: 'jxl', options: { shell: 'rm -rf' } }).expect(400);
    await post(m, '/api/images/export', { ids: [id], format: 'bmp' }).expect(400);
    await post(m, '/api/images/export', { ids: [id], format: 'webp', name: '../x' }).expect(400);
    expect(asked).toHaveLength(0);
  });
});
