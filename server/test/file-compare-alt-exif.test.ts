import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { exifOrientation, stripBuffer, StripError, stripGif, stripStream, stripWebp } from '../src/files/exif.js';
import { COMPARE_LIMITS } from '../src/files/service.js';
import type { PreviewKind, PreviewRenderer } from '../src/files/preview.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import type { GuardInput } from '../src/guardrails/types.js';
import { crc32, encodePng } from '../src/images/png.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, type Harness } from './helpers.js';
import { drain, seedRetrieval } from './retrieval-seed.js';

/*
 * 1.8.0, Sprint 47 (B-142): version compare, alt text and description on images, and EXIF, GPS and other metadata
 * taken out of the copies the file store serves, with the original kept as it was uploaded.
 */

// ---------- fixtures: images that carry metadata ----------

const SECRETS = ['GPS-SECRET', 'TestCam', 'xmp-secret', 'iptc-secret', 'comment-secret', 'trailing-secret', 'thumb-secret'];

/** A big-endian TIFF block: IFD0 with Make, Orientation 6 and a GPS IFD with latitude and an area text. */
function tiff(): Buffer {
  const b = Buffer.alloc(134);
  b.write('MM', 0, 'latin1');
  b.writeUInt16BE(42, 2);
  b.writeUInt32BE(8, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: number | Buffer) => {
    b.writeUInt16BE(tag, at);
    b.writeUInt16BE(type, at + 2);
    b.writeUInt32BE(count, at + 4);
    if (Buffer.isBuffer(value)) value.copy(b, at + 8);
    else if (type === 3) b.writeUInt16BE(value, at + 8);
    else b.writeUInt32BE(value, at + 8);
  };
  b.writeUInt16BE(3, 8);
  entry(10, 0x010f, 2, 8, 50); // Make
  entry(22, 0x0112, 3, 1, 6); // Orientation: rotated 90°
  entry(34, 0x8825, 4, 1, 58); // GPS IFD
  b.writeUInt32BE(0, 46);
  b.write('TestCam\0', 50, 'latin1');
  b.writeUInt16BE(3, 58);
  entry(60, 0x0001, 2, 2, Buffer.from('N\0\0\0', 'latin1'));
  entry(72, 0x0002, 5, 3, 100);
  entry(84, 0x001c, 7, 10, 124);
  b.writeUInt32BE(0, 96);
  [38, 1, 43, 1, 2034, 100].forEach((v, i) => b.writeUInt32BE(v, 100 + i * 4));
  b.write('GPS-SECRET', 124, 'latin1');
  return b;
}

const seg = (marker: number, payload: Buffer) => {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(0xff00 | marker, 0);
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
};

/** Entropy-coded data with a stuffed FF 00 and a restart marker, which must pass untouched. */
const SCAN = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);
const ICC = Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), Buffer.from('icc-profile-bytes', 'latin1')]);

/** A JPEG with EXIF (GPS), XMP, an ICC profile, Photoshop/IPTC, a comment, a JFIF thumbnail, MPF and trailing data. */
function exifJpeg(): Buffer {
  const jfif = Buffer.concat([Buffer.from('JFIF\0\x01\x02\x00\x00\x01\x00\x01\x01\x01', 'latin1'), Buffer.from('thumb-secret', 'latin1').subarray(0, 3)]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.concat([jfif, Buffer.from('thumb-secret', 'latin1')])),
    seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff()])),
    seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>xmp-secret</x:xmpmeta>', 'latin1')),
    seg(0xe2, ICC),
    seg(0xe2, Buffer.from('MPF\0mpf-index', 'latin1')),
    seg(0xed, Buffer.from('Photoshop 3.0\0iptc-secret', 'latin1')),
    seg(0xfe, Buffer.from('comment-secret', 'latin1')),
    seg(0xdb, Buffer.alloc(65, 1)), // DQT
    seg(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0])), // SOF0
    seg(0xc4, Buffer.alloc(20, 2)), // DHT
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), // SOS
    SCAN,
    Buffer.from([0xff, 0xd9]),
    Buffer.from('trailing-secret', 'latin1')
  ]);
}

const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A PNG with eXIf (GPS), tEXt, iTXt and tIME chunks, an iCCP profile, and data after IEND. */
function exifPng(): Buffer {
  const plain = encodePng(4, 4, Buffer.alloc(48, 200));
  const iend = plain.length - 12;
  return Buffer.concat([
    plain.subarray(0, 33), // signature + IHDR
    pngChunk('iCCP', Buffer.from('icc-profile-bytes\0\0', 'latin1')),
    pngChunk('eXIf', tiff()),
    pngChunk('tEXt', Buffer.from('Comment\0comment-secret', 'latin1')),
    pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0xmp-secret', 'latin1')),
    pngChunk('tIME', Buffer.from([7, 234, 10, 15, 12, 0, 0])),
    plain.subarray(33, iend),
    plain.subarray(iend),
    Buffer.from('trailing-secret', 'latin1')
  ]);
}

const riffChunk = (id: string, data: Buffer) => {
  const h = Buffer.alloc(8);
  h.write(id, 0, 'latin1');
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

function exifWebp(): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x20 | 0x08 | 0x04; // ICC, EXIF, XMP
  const body = Buffer.concat([riffChunk('VP8X', vp8x), riffChunk('ICCP', Buffer.from('icc-profile-bytes', 'latin1')), riffChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0x10, 1, 2])), riffChunk('EXIF', tiff()), riffChunk('XMP ', Buffer.from('xmp-secret', 'latin1'))]);
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

function exifGif(): Buffer {
  const sub = (b: Buffer) => Buffer.concat([Buffer.from([b.length]), b, Buffer.from([0])]);
  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), // 1x1, a global colour table of 2
    Buffer.from([0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0', 'latin1'), sub(Buffer.from([1, 0, 0])).subarray(0, 5),
    Buffer.from([0x21, 0xff, 11]), Buffer.from('XMP DataXMP', 'latin1'), sub(Buffer.from('xmp-secret', 'latin1')),
    Buffer.from([0x21, 0xfe]), sub(Buffer.from('comment-secret', 'latin1')),
    Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), Buffer.from([2, 2, 0x44, 0x01, 0]),
    Buffer.from([0x3b]),
    Buffer.from('trailing-secret', 'latin1')
  ]);
}

const hasAny = (b: Buffer, words: string[]) => words.filter((w) => b.includes(Buffer.from(w, 'latin1')));
/** The GPS IFD tag (0x8825) in either byte order. */
const gpsTag = (b: Buffer) => b.includes(Buffer.from([0x88, 0x25])) || b.includes(Buffer.from([0x25, 0x88]));

async function streamed(type: string, data: Buffer, size: number): Promise<Buffer> {
  async function* chunks() {
    for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
  }
  const out: Buffer[] = [];
  for await (const c of stripStream(type, chunks())) out.push(c);
  return Buffer.concat(out);
}

describe('B-142: the metadata stripper', () => {
  it('JPEG: EXIF with GPS, XMP, IPTC, comments, MPF, the JFIF thumbnail and trailing data go; ICC, Orientation and the scan stay', async () => {
    const original = exifJpeg();
    const copy = Buffer.from(original);
    const clean = await stripBuffer('image/jpeg', original);
    expect(original.equals(copy)).toBe(true); // the input is not changed
    expect(hasAny(clean, SECRETS)).toEqual([]);
    expect(gpsTag(clean)).toBe(false);
    expect(clean.includes(Buffer.from('MPF\0', 'latin1'))).toBe(false);
    expect(clean.includes(ICC)).toBe(true);
    expect(clean.includes(Buffer.concat([SCAN, Buffer.from([0xff, 0xd9])]))).toBe(true);
    expect(clean.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    // The orientation survives as a one-tag EXIF block, so the photo is not shown on its side.
    const app1 = clean.indexOf(Buffer.from([0xff, 0xe1]));
    expect(app1).toBeGreaterThan(0);
    expect(exifOrientation(clean.subarray(app1 + 4, app1 + 2 + clean.readUInt16BE(app1 + 2)))).toBe(6);
    expect(exifOrientation(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff()]))).toBe(6);
    // Streamed in small pieces it gives the same bytes.
    for (const size of [1, 3, 7, 64]) expect((await streamed('image/jpeg', original, size)).equals(clean)).toBe(true);
  });

  it('PNG: eXIf, text chunks, tIME and trailing data go; iCCP and the image data stay', async () => {
    const original = exifPng();
    const clean = await stripBuffer('image/png', original);
    expect(hasAny(clean, SECRETS)).toEqual([]);
    for (const t of ['eXIf', 'tEXt', 'iTXt', 'tIME']) expect(clean.includes(Buffer.from(t, 'latin1'))).toBe(false);
    for (const t of ['IHDR', 'iCCP', 'IDAT', 'IEND']) expect(clean.includes(Buffer.from(t, 'latin1'))).toBe(true);
    expect(clean.subarray(-8, -4).toString('latin1')).toBe('IEND');
    for (const size of [1, 5, 100]) expect((await streamed('image/png', original, size)).equals(clean)).toBe(true);
  });

  it('WebP and GIF: metadata chunks and extensions go, flags and sizes are right', () => {
    const w = stripWebp(exifWebp());
    expect(hasAny(w, SECRETS)).toEqual([]);
    expect(w.includes(Buffer.from('icc-profile-bytes', 'latin1'))).toBe(true);
    expect(w.readUInt32LE(4)).toBe(w.length - 8);
    expect(w[20]! & 0x0c).toBe(0);
    expect(w[20]! & 0x20).toBe(0x20);
    const g = stripGif(exifGif());
    expect(hasAny(g, SECRETS)).toEqual([]);
    expect(g.includes(Buffer.from('NETSCAPE2.0', 'latin1'))).toBe(true);
    expect(g.subarray(-1)[0]).toBe(0x3b);
  });

  it('fails closed on what does not parse, and leaves other types alone', async () => {
    await expect(stripBuffer('image/jpeg', Buffer.from([0xff, 0xd8, 0x12, 0x34]))).rejects.toBeInstanceOf(StripError);
    await expect(stripBuffer('image/png', Buffer.from('not a png'))).rejects.toBeInstanceOf(StripError);
    expect(() => stripWebp(Buffer.from('RIFF\x40\0\0\0WEBPVP8X\xff\0\0\0', 'latin1'))).toThrow(StripError);
    expect(() => stripGif(Buffer.from('GIF89a\x01\0\x01\0\0\0\0\x99', 'latin1'))).toThrow(StripError);
    const text = Buffer.from('GPS-SECRET in a text file');
    expect(await stripBuffer('text/plain', text)).toBe(text);
  });
});

// ---------- the file store ----------

/** A preview renderer that copies the original's metadata into the preview, as a careless converter might. */
class LeakyRenderer implements PreviewRenderer {
  readonly name = 'leaky';
  calls: PreviewKind[] = [];
  async render(kind: PreviewKind, _type: string, _input: string, output: string): Promise<void> {
    this.calls.push(kind);
    await writeFile(output, exifPng());
  }
}

type Res = request.Response;
const binary = (res: Res, cb: (err: Error | null, body: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('B-142: version compare, alt text and served copies', () => {
  let h: Harness;
  let wsId: string;
  let otherWs: string;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({}, { previewRenderer: new LeakyRenderer() });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    otherWs = (await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'internal')).id;
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function member(name: string, ws: string[] = [wsId], roles = ['member'], clearance: 'internal' | 'confidential' = 'internal') {
    const u = await localUser(h, name, roles, clearance);
    for (const w of ws) await h.s.tenants.addMember(w, u.id);
    const c = await login(h, name);
    const send = (method: 'post' | 'put', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    return {
      user: u,
      post: (p: string, b?: object) => send('post', p, b),
      put: (p: string, b?: object) => send('put', p, b),
      get: (p: string) => c.agent.get(p),
      upload: (name: string, data: Buffer | string, q: Record<string, string> = {}) => c.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: wsId, ...q }).toString()}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data)),
      version: (id: string, data: Buffer | string) => c.agent.put(`/api/files/${id}/content`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data)),
      download: (path: string) => c.agent.get(path).buffer(true).parse(binary),
      downloadPost: (path: string, body: object) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body).buffer(true).parse(binary)
    };
  }
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];

  it('compares two versions of a text file as hunks, for members cleared for both; refuses other readers and large files', async () => {
    const ann = await member('ann');
    const bob = await member('bob');
    const eve = await member('eve', [otherWs]);
    const up = (await ann.upload('plan.md', '# Plan\n\nOne\nTwo\nThree\n').expect(202)).body;
    await drain(h);
    await ann.version(up.id, '# Plan\n\nOne\n2\nThree\nFour\n').expect(202);
    await drain(h);
    const d = (await bob.get(`/api/files/${up.id}/compare?from=1&to=2`).expect(200)).body;
    expect(d).toMatchObject({ kind: 'text', file: { id: up.id, name: 'plan.md' }, from: { number: 1, type: 'text/markdown' }, to: { number: 2 }, added: 2, removed: 1, same: false, truncated: false });
    const lines = d.hunks.flatMap((x: { lines: { op: string; text: string }[] }) => x.lines.map((l) => l.op + l.text));
    expect(lines).toEqual(expect.arrayContaining(['-Two', '+2', '+Four', ' One']));
    expect(d.hunks[0]).toMatchObject({ fromStart: 1, toStart: 1 });
    expect((await audits('file.versions.compared')).length).toBe(1);
    // the other way round, the same version, a version that does not exist
    expect((await bob.get(`/api/files/${up.id}/compare?from=2&to=1`).expect(200)).body).toMatchObject({ added: 1, removed: 2 });
    await bob.get(`/api/files/${up.id}/compare?from=1&to=1`).expect(400);
    await bob.get(`/api/files/${up.id}/compare?from=1&to=9`).expect(404);
    await bob.get(`/api/files/${up.id}/compare?from=1`).expect(400);
    // not a member of the workspace: not found, even with a share (shared readers see the current version only)
    await eve.get(`/api/files/${up.id}/compare?from=1&to=2`).expect(404);
    await ann.post(`/api/files/${up.id}/shares`, { kind: 'user', userId: eve.user.id }).expect(201);
    await eve.get(`/api/files/${up.id}/compare?from=1&to=2`).expect(404);
    // a version above the reader's clearance
    await ann.version(up.id, '# Plan\n\nConfidential figures\n').expect(202);
    await drain(h);
    await h.s.db('file_versions').where({ file_id: up.id, number: 3 }).update({ label: 'confidential' });
    const p = await bob.get(`/api/files/${up.id}/compare?from=2&to=3`).expect(403);
    expect(p.headers['content-type']).toMatch(/problem\+json/);
    // one-line JSON is spread out so the diff shows the field that changed
    const j = (await ann.upload('cfg.json', '{"a":1,"b":2}').expect(202)).body;
    await drain(h);
    await ann.version(j.id, '{"a":1,"b":3}').expect(202);
    await drain(h);
    const jd = (await ann.get(`/api/files/${j.id}/compare?from=1&to=2`).expect(200)).body;
    expect(jd.hunks.flatMap((x: { lines: { op: string; text: string }[] }) => x.lines.filter((l) => l.op !== ' ').map((l) => l.op + l.text.trim()))).toEqual(['-"b": 2', '+"b": 3']);
    // too large to compare
    const before = COMPARE_LIMITS.maxBytes;
    COMPARE_LIMITS.maxBytes = 20;
    try {
      const big = await ann.get(`/api/files/${up.id}/compare?from=1&to=2`).expect(413);
      expect(big.body).toMatchObject({ title: 'Too large to compare' });
      expect(big.body.detail).toMatch(/Download both versions/);
    } finally {
      COMPARE_LIMITS.maxBytes = before;
    }
  });

  it('compares image versions as their two previews, served without metadata', async () => {
    const ann = await member('ann');
    const up = (await ann.upload('photo.jpg', exifJpeg()).expect(202)).body;
    await drain(h);
    await ann.version(up.id, exifPng()).expect(202);
    await drain(h);
    const d = (await ann.get(`/api/files/${up.id}/compare?from=1&to=2`).expect(200)).body;
    expect(d).toMatchObject({ kind: 'image', from: { number: 1, type: 'image/jpeg', preview: 'ready' }, to: { number: 2, type: 'image/png', preview: 'ready' }, same: false });
    for (const n of [1, 2]) {
      const pv = await ann.download(`/api/files/${up.id}/versions/${n}/preview`).expect(200);
      expect(pv.headers['content-type']).toBe('image/png');
      expect(hasAny(pv.body as Buffer, SECRETS)).toEqual([]);
      expect(gpsTag(pv.body as Buffer)).toBe(false);
    }
    // a text version beside an image is not compared
    await ann.version(up.id, 'now text').expect(202);
    await drain(h);
    expect((await ann.get(`/api/files/${up.id}/compare?from=2&to=3`).expect(415)).body.detail).toMatch(/One version is an image/);
  });

  it('alt text and a description: editors set them, readers see them, search finds them, the change is audited', async () => {
    const ann = await member('ann');
    const bob = await member('bob');
    const eve = await member('eve', [otherWs]);
    const viewer = await member('vic', [wsId], ['viewer']);
    const up = (await ann.upload('bike.png', exifPng()).expect(202)).body;
    await drain(h);
    expect((await ann.get(`/api/files/${up.id}`).expect(200)).body).toMatchObject({ altText: null, description: null, owner: true });
    const out = (await bob.put(`/api/files/${up.id}/meta`, { altText: 'A red bicycle against a white wall', description: 'Shot for the spring catalogue.' }).expect(200)).body;
    expect(out).toMatchObject({ altText: 'A red bicycle against a white wall', description: 'Shot for the spring catalogue.', altVersion: 1, fileId: up.id });
    expect((await ann.get(`/api/files/${up.id}`).expect(200)).body).toMatchObject({ altText: 'A red bicycle against a white wall', altVersion: 1 });
    const alt = await audits('file.alt.updated');
    expect(alt).toHaveLength(1);
    expect(JSON.parse(alt[0]!.detail!)).toEqual({ before: null, after: 'A red bicycle against a white wall' });
    expect(await audits('file.description.updated')).toHaveLength(1);
    // only what changed is audited; null clears
    await bob.put(`/api/files/${up.id}/meta`, { description: null }).expect(200);
    expect(await audits('file.alt.updated')).toHaveLength(1);
    expect(await audits('file.description.updated')).toHaveLength(2);
    // search reads the alt text
    expect((await bob.get('/api/files/search?q=bicycle').expect(200)).body.map((f: { id: string; altText: string }) => [f.id, f.altText])).toEqual([[up.id, 'A red bicycle against a white wall']]);
    // shared readers see it; they and people outside the workspace cannot change it
    await ann.post(`/api/files/${up.id}/shares`, { kind: 'user', userId: eve.user.id }).expect(201);
    expect((await eve.get(`/api/files/${up.id}`).expect(200)).body.altText).toBe('A red bicycle against a white wall');
    await eve.put(`/api/files/${up.id}/meta`, { altText: 'x' }).expect(404);
    const perms = (await viewer.get('/api/me').expect(200)).body.permissions as string[];
    if (!perms.includes('files:write')) await viewer.put(`/api/files/${up.id}/meta`, { altText: 'x' }).expect(403);
    // validation: lengths, control characters, an empty body, unknown keys, files that are not images
    await bob.put(`/api/files/${up.id}/meta`, { altText: 'x'.repeat(1001) }).expect(400);
    await bob.put(`/api/files/${up.id}/meta`, { altText: 'bell\u0007' }).expect(400);
    await bob.put(`/api/files/${up.id}/meta`, {}).expect(400);
    await bob.put(`/api/files/${up.id}/meta`, { alt: 'x' }).expect(400);
    const txt = (await ann.upload('notes.txt', 'hello').expect(202)).body;
    await drain(h);
    expect((await bob.put(`/api/files/${txt.id}/meta`, { altText: 'x' }).expect(409)).body.detail).toMatch(/for images/);
    // the user-input guardrail screens what people write
    const real = h.s.guardrails.check.bind(h.s.guardrails);
    h.s.guardrails.check = async (i: GuardInput) => (i.source?.kind === 'file-meta' && i.text.includes('BLOCKME') ? { action: 'block', text: i.text, findings: [], reason: 'test rule' } : real(i));
    expect((await bob.put(`/api/files/${up.id}/meta`, { altText: 'BLOCKME' }).expect(422)).body).toMatchObject({ step: 'guardrails' });
    // a new version keeps the text and says which version it was written for
    await ann.version(up.id, exifPng()).expect(202);
    await drain(h);
    expect((await ann.get(`/api/files/${up.id}`).expect(200)).body).toMatchObject({ currentVersion: 2, altText: 'A red bicycle against a white wall', altVersion: 1 });
  });

  it('suggests alt text through the vision profile, without metadata, as a suggestion that is not saved', async () => {
    const { pool } = await seedRetrieval(h, ollama);
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'gemma3:12b', size: 8e9, capabilities: ['completion', 'vision'] });
    const m = await repo.createModel({ name: 'gemma3:12b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'vision'], size_bytes: 8e9 });
    await repo.place(m.id, pool.id, 'warm', 'x');
    const t = Date.now();
    const see: ProfileRow = { id: 'SEE'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'see', display_name: 'See', description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
    await repo.createProfile(see);
    await h.s.gateway.pollAll();
    const seen: Buffer[] = [];
    ollama.vision = (_messages, images) => {
      seen.push(...images);
      return JSON.stringify({ alt: 'A red bicycle leaning on a white wall' });
    };
    const ann = await member('ann');
    const up = (await ann.upload('bike.jpg', exifJpeg()).expect(202)).body;
    await drain(h);
    const s = (await ann.post(`/api/files/${up.id}/alt-suggestion`, { profile: 'see' }).expect(200)).body;
    expect(s).toEqual({ suggestion: 'A red bicycle leaning on a white wall', profile: 'see', model: 'gemma3:12b', version: 1, accepted: false });
    expect(seen).toHaveLength(1);
    expect(hasAny(seen[0]!, SECRETS)).toEqual([]);
    expect((await ann.get(`/api/files/${up.id}`).expect(200)).body.altText).toBeNull();
    expect(await audits('file.alt.suggested')).toHaveLength(1);
    // a profile without a vision model is refused
    expect((await ann.post(`/api/files/${up.id}/alt-suggestion`, { profile: 'general' }).expect(409)).body.detail).toMatch(/cannot read images/);
    await ann.post(`/api/files/${up.id}/alt-suggestion`, {}).expect(400);
  });

  it('serves images without EXIF and GPS: downloads, versions, previews, links and avatars; the owner can get the original', async () => {
    const ann = await member('ann');
    const bob = await member('bob');
    const original = exifJpeg();
    const up = (await ann.upload('photo.jpg', original).expect(202)).body;
    await drain(h);
    // the stored original is intact: the owner asks for it and gets the same bytes, metadata and all
    const orig = await ann.download(`/api/files/${up.id}/content?original=1`).expect(200);
    expect((orig.body as Buffer).equals(original)).toBe(true);
    expect(orig.headers['content-length']).toBe(String(original.length));
    // everyone else, and the owner by default, get the cleaned copy
    for (const who of [ann, bob]) {
      for (const path of [`/api/files/${up.id}/content`, `/api/files/${up.id}/versions/1/content`]) {
        const got = await who.download(path).expect(200);
        const body = got.body as Buffer;
        expect(hasAny(body, SECRETS)).toEqual([]);
        expect(gpsTag(body)).toBe(false);
        expect(body.includes(ICC)).toBe(true);
        expect(got.headers['content-security-policy']).toMatch(/^sandbox/);
      }
    }
    // only the owner may ask for the original
    expect((await bob.download(`/api/files/${up.id}/content?original=1`).expect(403)).body).toBeDefined();
    const downloads = (await audits('file.downloaded')).map((a) => JSON.parse(a.detail!));
    expect(downloads.filter((x) => x.original)).toHaveLength(1);
    expect(downloads.filter((x) => x.metadata === 'stripped').length).toBeGreaterThanOrEqual(4);
    // the preview (a renderer that copied the metadata) is stored and served clean
    const pv = await bob.download(`/api/files/${up.id}/preview`).expect(200);
    expect(hasAny(pv.body as Buffer, SECRETS)).toEqual([]);
    // a link: signed-in and anonymous downloads are cleaned, also when the owner uses the link
    const link = (await ann.post(`/api/files/${up.id}/shares`, { kind: 'link', expiresInHours: 24 }).expect(201)).body;
    for (const who of [bob, ann]) {
      const got = await who.downloadPost('/api/file-links/download', { token: link.token }).expect(200);
      expect(hasAny(got.body as Buffer, SECRETS)).toEqual([]);
      expect(gpsTag(got.body as Buffer)).toBe(false);
    }
    await h.s.sharing.setSettings(h.tenantId, ann.user.id, { anonymousLinks: true, anonymousMaxHours: 48 });
    const pub = (await ann.upload('public.png', exifPng(), { label: 'public' }).expect(202)).body;
    await drain(h);
    const anon = (await ann.post(`/api/files/${pub.id}/shares`, { kind: 'link', expiresInHours: 24, anonymous: true }).expect(201)).body;
    const a = await request(h.app).post('/api/public/file-links/download').send({ token: anon.token }).buffer(true).parse(binary).expect(200);
    expect(hasAny(a.body as Buffer, SECRETS)).toEqual([]);
    expect((a.body as Buffer).includes(Buffer.from('IDAT', 'latin1'))).toBe(true);
    // pinned images (avatars, group pictures) are served clean, with their own length
    const pinned = await h.s.files.pinnedContent(h.tenantId, up.id, 1);
    const parts: Buffer[] = [];
    for await (const c of pinned!.stream) parts.push(c);
    expect(hasAny(Buffer.concat(parts), SECRETS)).toEqual([]);
    expect(pinned!.size).toBe(Buffer.concat(parts).length);
    // and the stored original still is what was uploaded
    expect(((await ann.download(`/api/files/${up.id}/versions/1/content?original=true`).expect(200)).body as Buffer).equals(original)).toBe(true);
    // a text file is served as it is, with its length
    const txt = (await ann.upload('gps.txt', 'GPS-SECRET stays in text').expect(202)).body;
    await drain(h);
    const tx = await bob.download(`/api/files/${txt.id}/content`).expect(200);
    expect((tx.body as Buffer).toString()).toBe('GPS-SECRET stays in text');
    expect(tx.headers['content-length']).toBe('24');
  });
});
