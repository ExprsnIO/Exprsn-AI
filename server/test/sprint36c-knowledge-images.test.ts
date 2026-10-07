import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseVisionScores } from '../src/guardrails/classifiers.js';
import { loadPrincipal } from '../src/http/middleware.js';
import type { ImageSafety } from '../src/images/safety.js';
import { detectType } from '../src/knowledge/extract.js';
import { imageParts, imageType, indexedText, parseDescription } from '../src/knowledge/images.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { FakeOllama, markedJpeg, markedPng, marksOf } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { client, drain, seedRetrieval, zip } from './retrieval-seed.js';

const GB = 1_000_000_000;

/** A Word document with the given text and pictures under word/media/. */
function docxWithImages(text: string, images: Buffer[]): Buffer {
  const files: Record<string, string | Buffer> = { '[Content_Types].xml': '<Types/>', 'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` };
  images.forEach((img, i) => (files[`word/media/image${i + 1}.${imageType(img) === 'image/jpeg' ? 'jpeg' : 'png'}`] = img));
  return zip(files);
}

/** A PDF with a text line, a JPEG image XObject and an 8-bit RGB Flate image XObject. */
function pdfWithImages(line: string | null, jpeg: Buffer, rgb: { w: number; h: number; data: Buffer }): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  if (line) {
    const content = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${line}) Tj ET`, 'latin1'));
    parts.push(Buffer.from(`1 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  }
  parts.push(Buffer.from(`2 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'), jpeg, Buffer.from('\nendstream\nendobj\n', 'latin1'));
  const flate = deflateSync(rgb.data);
  parts.push(Buffer.from(`3 0 obj\n<< /Type /XObject /Subtype /Image /Width ${rgb.w} /Height ${rgb.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${flate.length} >>\nstream\n`, 'latin1'), flate, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

const noise = (n: number, seed = 7) => {
  const b = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
};

describe('Sprint 36c: images, parts and the vision answer formats', () => {
  it('detects image types from the bytes and takes images out of PDF and Word documents', () => {
    const png = markedPng({ caption: 'A chart', ocr: 'Q3 revenue' });
    expect(imageType(png)).toBe('image/png');
    expect(imageType(markedJpeg({ ocr: 'x' }))).toBe('image/jpeg');
    expect(imageType(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(8)]))).toBe('image/webp');
    expect(imageType(Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(10)]))).toBe('image/gif');
    expect(imageType(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(8)]))).toBe('image/heic');
    expect(imageType(Buffer.from('hello world, plain text'))).toBeNull();
    expect(detectType(png, 'x.png')).toEqual({ type: 'image/png' });

    const docx = docxWithImages('Report', [png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])]);
    const fromWord = imageParts(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(fromWord).toHaveLength(1); // the tiny one is skipped as an icon
    expect(marksOf(fromWord[0]!.data)).toMatchObject({ caption: 'A chart', ocr: 'Q3 revenue' });

    const jpeg = markedJpeg({ caption: 'A receipt', ocr: 'TOTAL 42.00 EUR' });
    const pdf = pdfWithImages('Expense claim', jpeg, { w: 24, h: 24, data: noise(24 * 24 * 3) });
    const fromPdf = imageParts(pdf, 'application/pdf');
    expect(fromPdf.map((p) => p.type)).toEqual(['image/jpeg', 'image/png']);
    expect(marksOf(fromPdf[0]!.data)).toMatchObject({ ocr: 'TOTAL 42.00 EUR' });
  });

  it('validates the vision answers: a caption and text; scores only for known labels, from 0 to 1', () => {
    expect(parseDescription('Sure: {"caption": "A login screen", "text": "Sign in\\nPassword"}')).toEqual({ caption: 'A login screen', text: 'Sign in\nPassword' });
    expect(() => parseDescription('A login screen')).toThrow(/did not answer with a caption/);
    expect(() => parseDescription('{"caption": 3}')).toThrow(/did not answer/);
    expect(indexedText('shot.png', { caption: 'A chart', text: 'Q3' })).toBe('# shot.png\n\nA chart\n\nText in the image:\n\nQ3');
    expect(parseVisionScores('{"scores": {"receipt": 0.9}}', ['receipt', 'diagram'])).toEqual({ receipt: 0.9, diagram: 0 });
    expect(() => parseVisionScores('{"scores": {"cat": 0.9}}', ['receipt'])).toThrow(/cat, which is not one of the labels/);
    expect(() => parseVisionScores('{"scores": {"receipt": 1.5}}', ['receipt'])).toThrow(/not a number from 0 to 1/);
    expect(() => parseVisionScores('{"label": "receipt"}', ['receipt'])).toThrow(/has no scores/);
  });
});

describe('Sprint 36c: image classification in Knowledge', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    h = await harness({ OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  const upload = (c: Awaited<ReturnType<typeof client>>, kbId: string, name: string, data: Buffer, label = 'public') =>
    c.agent.put(`/api/knowledge/bases/${kbId}/uploads?name=${encodeURIComponent(name)}&label=${label}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(data);

  /** The retrieval seed plus a vision model behind the published profile `see`. */
  async function setup() {
    const { pool } = await seedRetrieval(h, ollama);
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'gemma3:12b', size: 8 * GB, capabilities: ['completion', 'vision'] });
    const m = await repo.createModel({ name: 'gemma3:12b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'vision'], size_bytes: 8 * GB });
    await repo.place(m.id, pool.id, 'warm', 'x');
    const t = Date.now();
    const see: ProfileRow = { id: 'SEE'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'see', display_name: 'See', description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
    await repo.createProfile(see);
    await h.s.gateway.pollAll();
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Screens', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
    return { curator, kb };
  }

  async function visionClassifier(admin: Awaited<ReturnType<typeof loginAdmin>>, labels: string[]) {
    const post = (path: string, body: object = {}) => admin.agent.post(path).set('x-csrf-token', admin.csrf).send(body);
    const c = (await post('/api/admin/classifiers', { name: 'Image kinds', engine: 'vision', labels, profile: 'see', instructions: 'Screenshots of forms count as receipts only when they show a total.' }).expect(201)).body;
    return { c, post };
  }

  it('B-8801: an uploaded screenshot is found by a phrase from its text; a flagged image never reaches the index', async () => {
    const { curator, kb } = await setup();
    // Without a vision profile an image cannot be described.
    const early = (await upload(curator, kb.id, 'early.png', markedPng({ caption: 'x', ocr: 'y' })).expect(202)).body;
    await drain(h);
    expect((await curator.get(`/api/knowledge/documents/${early.id}`).expect(200)).body).toMatchObject({ state: 'failed', media: 'image', thumbnail: null });
    expect((await curator.get(`/api/knowledge/documents/${early.id}`).expect(200)).body.error).toMatch(/no vision profile/);

    // The profile must read images, and be cleared for the base's label.
    expect((await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'general' }).expect(409)).body.detail).toMatch(/cannot read images/);
    const set = (await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see' }).expect(200)).body;
    expect(set.visionProfile).toBe('see');
    const models = (await curator.get('/api/knowledge/models').expect(200)).body;
    expect(models.visionProfiles).toEqual([{ name: 'see', displayName: 'See', model: 'gemma3:12b', label: 'confidential' }]);

    // A screenshot: its caption and the text on it become the indexed text.
    const shot = markedPng({ caption: 'A sign-in dialog of the billing portal', ocr: 'Invoice portal\nForgot your passphrase? Call the service desk on extension 4471' });
    const doc = (await upload(curator, kb.id, 'login.png', shot).expect(202)).body;
    expect(doc).toMatchObject({ state: 'quarantined', media: null });
    await drain(h);
    const got = (await curator.get(`/api/knowledge/documents/${doc.id}`).expect(200)).body;
    expect(got).toMatchObject({ state: 'indexed', type: 'image/png', media: 'image', caption: 'A sign-in dialog of the billing portal', visionModel: 'gemma3:12b', thumbnail: `/api/knowledge/documents/${doc.id}/thumbnail`, labels: [], parts: [] });
    expect(got.text).toContain('extension 4471');
    // The description is sealed at rest.
    const row = await h.s.db('knowledge_documents').where({ id: doc.id }).first();
    expect(row.vision).toMatch(/^v2\./);
    expect(row.vision).not.toContain('4471');
    // The vision call was made with the image and metered.
    const call = ollama.requests.find((r) => r.path === '/api/chat' && JSON.stringify(r.body).includes('Describe this image'));
    expect((call!.body.messages as { images?: string[] }[])[1]!.images).toHaveLength(1);
    expect(await h.s.db('usage_records').where({ tenant_id: h.tenantId, model: 'gemma3:12b' }).count({ n: '*' })).toEqual([{ n: 1 }]);

    const found = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'forgot passphrase service desk extension', rerank: false }).expect(200)).body;
    expect(found.hits[0]).toMatchObject({ document: 'login.png', label: 'internal', image: { caption: 'A sign-in dialog of the billing portal', labels: [], thumbnail: `/api/knowledge/documents/${doc.id}/thumbnail` } });
    expect(found.hits[0].image.ocr).toContain('extension 4471');

    // The thumbnail is the image, served only to readers cleared for it, never sniffed.
    const thumb = await curator.agent.get(`/api/knowledge/documents/${doc.id}/thumbnail`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(thumb.headers['content-type']).toBe('image/png');
    expect(thumb.headers['x-content-type-options']).toBe('nosniff');
    expect(thumb.headers['content-security-policy']).toContain('sandbox');
    expect(Buffer.compare(thumb.body as Buffer, shot)).toBe(0);
    await curator.patch(`/api/knowledge/documents/${doc.id}`, { label: 'confidential', reason: 'board only' }).expect(200);
    const member = await client(h, 'mem', ['member'], 'internal');
    await member.get(`/api/knowledge/documents/${doc.id}/thumbnail`).expect(404);
    const blind = (await member.post('/api/knowledge/search', { kbIds: [kb.id], query: 'forgot passphrase service desk extension', rerank: false }).expect(200)).body;
    expect(JSON.stringify(blind)).not.toContain('4471');

    // An image the safety check flags is rejected: deleted, never indexed, audited.
    const safety: ImageSafety = { name: 'test safety', classify: async (img) => ({ score: /UNSAFE/.test(marksOf(img).caption ?? '') ? 0.97 : 0.01, categories: { violence: 0.97 }, classifier: 'test safety' }) };
    h.s.imageSafety = safety;
    const bad = (await upload(curator, kb.id, 'bad.png', markedPng({ caption: 'UNSAFE picture', ocr: 'tripwire phrase zebra' })).expect(202)).body;
    const ok = (await upload(curator, kb.id, 'chart.png', markedPng({ caption: 'A bar chart', ocr: 'Quarterly zebra crossings' })).expect(202)).body;
    await drain(h);
    const rejected = (await curator.get(`/api/knowledge/documents/${bad.id}`).expect(200)).body;
    expect(rejected).toMatchObject({ state: 'rejected', chunks: 0, safetyScore: 0.97, thumbnail: null, caption: null });
    expect(rejected.error).toMatch(/Withheld by the image safety check/);
    expect(await h.s.db('knowledge_chunks').where({ document_id: bad.id }).count({ n: '*' })).toEqual([{ n: 0 }]);
    expect((await h.s.db('knowledge_documents').where({ id: bad.id }).first()).blob_key).toBeNull();
    expect((await curator.get(`/api/knowledge/documents/${ok.id}`).expect(200)).body).toMatchObject({ state: 'indexed', safetyScore: 0.01 });
    const zebra = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'tripwire zebra', rerank: false }).expect(200)).body;
    expect(zebra.hits[0].document).toBe('chart.png');
    expect(JSON.stringify(zebra)).not.toMatch(/bad\.png|tripwire/);
    const withheld = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'knowledge.image.withheld' });
    expect(withheld).toHaveLength(1);
  });

  it('B-8801: the images inside PDF and Word documents become their parts, at least their label, and leave with them', async () => {
    const { curator, kb } = await setup();
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see' }).expect(200);
    // A scanned claim: no text layer, but its pages are images the vision profile reads.
    const scan = pdfWithImages(null, markedJpeg({ caption: 'A taxi receipt', ocr: 'Lisbon Taxi Cooperative TOTAL 42.00 EUR' }), { w: 24, h: 24, data: noise(24 * 24 * 3) });
    const word = docxWithImages('Architecture overview', [markedPng({ caption: 'A network diagram', ocr: 'edge gateway vlan 220' })]);
    const pdfDoc = (await upload(curator, kb.id, 'claim.pdf', scan).expect(202)).body;
    const wordDoc = (await upload(curator, kb.id, 'overview.docx', word, 'confidential').expect(202)).body;
    await drain(h);
    const claim = (await curator.get(`/api/knowledge/documents/${pdfDoc.id}`).expect(200)).body;
    expect(claim).toMatchObject({ state: 'indexed', chunks: 0, media: null });
    expect(claim.parts.map((p: { name: string; state: string; media: string }) => [p.name, p.state, p.media])).toEqual([['claim.pdf, image 1', 'indexed', 'image'], ['claim.pdf, image 2', 'indexed', 'image']]);
    const overview = (await curator.get(`/api/knowledge/documents/${wordDoc.id}`).expect(200)).body;
    expect(overview).toMatchObject({ state: 'indexed', label: 'confidential' });
    expect(overview.parts).toHaveLength(1);
    expect(overview.parts[0]).toMatchObject({ label: 'confidential', parentId: wordDoc.id });

    const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'Lisbon Taxi Cooperative total', rerank: false }).expect(200)).body;
    expect(hit.hits[0]).toMatchObject({ document: 'claim.pdf, image 1', image: { caption: 'A taxi receipt' } });
    // A part cannot be relabelled below its document.
    const part = overview.parts[0];
    expect((await curator.patch(`/api/knowledge/documents/${part.id}`, { label: 'internal' }).expect(409)).body.detail).toMatch(/part of a confidential document/);
    // Re-indexing an unchanged document keeps its parts; removing it removes them.
    await curator.post(`/api/knowledge/documents/${wordDoc.id}/reindex`).expect(202);
    await drain(h);
    expect((await h.s.db('knowledge_documents').where({ parent_id: wordDoc.id })).map((r: { id: string }) => r.id)).toEqual([part.id]);
    await curator.del(`/api/knowledge/documents/${wordDoc.id}`).expect(204);
    expect(await h.s.db('knowledge_documents').where({ parent_id: wordDoc.id }).count({ n: '*' })).toEqual([{ n: 0 }]);
    expect(await h.s.db('knowledge_chunks').where({ document_id: part.id }).count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('B-8802, B-8805: a vision classifier publishes only after an evaluation with 200 image samples per label, then labels the images; a new version re-labels them', async () => {
    const { curator, kb } = await setup();
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see' }).expect(200);
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    const admin = await loginAdmin(h, 'ga');
    const { c, post } = await visionClassifier(admin, ['receipt', 'diagram']);
    expect(c).toMatchObject({ engine: 'vision', profile: 'see', status: 'draft', labels: [{ label: 'receipt', threshold: 0.5 }, { label: 'diagram', threshold: 0.5 }] });

    // Image samples in the eval-set format; text is refused for a vision classifier.
    const receiptImg = markedPng({ scores: { receipt: 0.92, diagram: 0.05 } });
    const diagramImg = markedPng({ scores: { receipt: 0.1, diagram: 0.81 } }, 24, 2);
    expect((await post(`/api/admin/classifiers/${c.id}/samples`, { items: [{ text: 'a receipt', expected: 'receipt' }] }).expect(422)).body.detail).toMatch(/classifies images/);
    const added = (await post(`/api/admin/classifiers/${c.id}/samples`, { items: [{ image: receiptImg.toString('base64'), expected: 'receipt' }, { image: diagramImg.toString('base64'), expected: 'diagram' }] }).expect(201)).body;
    expect(added).toMatchObject({ added: 2, samples: { receipt: 1, diagram: 1 } });
    const raw = await admin.agent.put(`/api/admin/classifiers/${c.id}/samples/image?expected=receipt`).set('x-csrf-token', admin.csrf).set('content-type', 'image/png').send(receiptImg).expect(201);
    expect(raw.body.samples).toEqual({ receipt: 2, diagram: 1 });
    const stored = await h.s.db('eval_cases').where({ eval_set: c.dataset }).whereNotNull('media_key');
    expect(stored).toHaveLength(3);
    expect((await h.s.blobs.get(stored[0].media_key))!.toString()).not.toContain('IHDR');

    // Classifying one image synchronously; text is refused.
    const one = (await post('/api/classify', { classifier: c.slug, image: receiptImg.toString('base64') }).expect(200)).body;
    expect(one).toMatchObject({ engine: 'vision', hits: ['receipt'], scores: { receipt: 0.92, diagram: 0.05 } });
    expect(one.usage).toBeUndefined();
    await post('/api/classify', { classifier: c.slug, text: 'hello' }).expect(422);

    // Below the minimum per label: no publishing, even after an evaluation.
    await post(`/api/admin/classifiers/${c.id}/evaluate`).expect(202);
    await drain(h);
    const evaluated = (await admin.agent.get(`/api/admin/classifiers/${c.id}`).expect(200)).body;
    expect(evaluated.metrics).toMatchObject({ samples: 3, errors: 0, perLabel: { receipt: { precision: 1, recall: 1, n: 2 }, diagram: { precision: 1, recall: 1, n: 1 } } });
    const refused = (await post(`/api/admin/classifiers/${c.id}/publish`).expect(409)).body;
    expect(refused).toMatchObject({ title: 'Eval set too small', minimum: 200 });
    // A draft cannot label a knowledge base's images.
    expect((await curator.patch(`/api/knowledge/bases/${kb.id}`, { imageClassifiers: [c.slug] }).expect(409)).body.detail).toMatch(/draft/);

    // With 200 image samples per label and a fresh evaluation, it publishes.
    const svc = h.s.guard.classifiers;
    await svc.addImageCases(h.tenantId, c.dataset, Array.from({ length: 198 }, () => ({ data: receiptImg, type: 'image/png', expected: 'receipt' })), null);
    await svc.addImageCases(h.tenantId, c.dataset, Array.from({ length: 199 }, () => ({ data: diagramImg, type: 'image/png', expected: 'diagram' })), null);
    await post(`/api/admin/classifiers/${c.id}/evaluate`).expect(202);
    await drain(h);
    expect((await post(`/api/admin/classifiers/${c.id}/publish`).expect(200)).body).toMatchObject({ status: 'published', version: 1 });

    // Images uploaded before the classifier is named are labelled when it is.
    const receipt = (await upload(curator, kb.id, 'taxi.png', markedPng({ caption: 'A taxi receipt', ocr: 'Fare 42.00 EUR', scores: { receipt: 0.88, diagram: 0.02 } }, 24, 3)).expect(202)).body;
    const diagram = (await upload(curator, kb.id, 'net.png', markedPng({ caption: 'A network diagram', ocr: 'Fare zones on the network map', scores: { receipt: 0.3, diagram: 0.77 } }, 24, 4)).expect(202)).body;
    await drain(h);
    const textClassifier = (await post('/api/admin/classifiers', { name: 'Topics', engine: 'llm', labels: ['a', 'b'], profile: 'general' }).expect(201)).body;
    expect((await curator.patch(`/api/knowledge/bases/${kb.id}`, { imageClassifiers: [textClassifier.id] }).expect(409)).body.detail).toMatch(/vision classifiers/);
    expect((await curator.patch(`/api/knowledge/bases/${kb.id}`, { imageClassifiers: [c.slug] }).expect(200)).body.imageClassifiers).toEqual([c.id]);
    await drain(h);
    const labelled = (await curator.get(`/api/knowledge/documents/${receipt.id}`).expect(200)).body;
    expect(labelled.labels).toEqual([
      { label: 'receipt', score: 0.88, hit: true, classifierId: c.id, classifier: 'Image kinds', version: 1 },
      { label: 'diagram', score: 0.02, hit: false, classifierId: c.id, classifier: 'Image kinds', version: 1 }
    ]);
    expect((await curator.get(`/api/knowledge/bases/${kb.id}/labels`).expect(200)).body).toEqual([{ label: 'diagram', documents: 1 }, { label: 'receipt', documents: 1 }]);

    // B-8803: label filters on the search route and the documents list.
    const fare = (q: object) => curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'fare', rerank: false, ...q }).expect(200);
    expect((await fare({})).body.hits.map((x: { document: string }) => x.document).sort()).toEqual(['net.png', 'taxi.png']);
    const onlyReceipts = (await fare({ labels: { any: ['receipt'] } })).body.hits;
    expect([...new Set(onlyReceipts.map((x: { document: string }) => x.document))]).toEqual(['taxi.png']);
    expect(onlyReceipts[0].image.labels[0]).toMatchObject({ label: 'receipt', score: 0.88, hit: true });
    expect((await fare({ labels: { any: ['receipt'], minScore: 0.25 } })).body.hits.map((x: { document: string }) => x.document).sort()).toEqual(['net.png', 'taxi.png']);
    expect((await fare({ labels: { any: ['receipt'], minScore: 0.9 } })).body.hits).toEqual([]);
    expect((await fare({ labels: { all: ['receipt', 'diagram'], minScore: 0.25 } })).body.hits.map((x: { document: string }) => x.document)).toEqual(['net.png']);
    expect((await curator.get(`/api/knowledge/bases/${kb.id}/documents?labels=diagram`).expect(200)).body.map((d: { name: string }) => d.name)).toEqual(['net.png']);
    expect((await curator.get(`/api/knowledge/bases/${kb.id}/documents?media=image`).expect(200)).body).toHaveLength(2);

    // A new version of the published classifier re-labels the images in the background, without re-uploading them.
    const uploadsBefore = await h.s.db('knowledge_documents').where({ kb_id: kb.id }).count({ n: '*' });
    await admin.agent.patch(`/api/admin/classifiers/${c.id}`).set('x-csrf-token', admin.csrf).send({ thresholds: { diagram: 0.8 } }).expect(200);
    await drain(h);
    const relabelled = (await curator.get(`/api/knowledge/documents/${diagram.id}`).expect(200)).body.labels;
    expect(relabelled.find((l: { label: string }) => l.label === 'diagram')).toMatchObject({ score: 0.77, hit: false, version: 2 });
    expect(await h.s.db('knowledge_documents').where({ kb_id: kb.id }).count({ n: '*' })).toEqual(uploadsBefore);
    expect((await fare({ labels: { any: ['diagram'] } })).body.hits).toEqual([]);
    expect(await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'knowledge.reclassified' }).count({ n: '*' })).toEqual([{ n: 2 }]);

    // Re-classify on request, for the base and for one image.
    expect((await curator.post(`/api/knowledge/bases/${kb.id}/reclassify`).expect(202)).body).toMatchObject({ images: 2 });
    await curator.post(`/api/knowledge/documents/${receipt.id}/reclassify`).expect(202);
    await drain(h);
    expect(await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'knowledge.reclassify.started' }).count({ n: '*' })).toEqual([{ n: 1 }]);
    // Labels are metadata at the image's label: a reader below it neither finds nor counts them.
    await curator.patch(`/api/knowledge/documents/${receipt.id}`, { label: 'confidential' }).expect(200);
    await drain(h);
    const member = await client(h, 'mem', ['member'], 'internal');
    expect((await curator.get(`/api/knowledge/bases/${kb.id}/labels`).expect(200)).body).toEqual([{ label: 'receipt', documents: 1 }]);
    expect((await member.get(`/api/knowledge/bases/${kb.id}/labels`).expect(200)).body).toEqual([]);
    expect((await member.post('/api/knowledge/search', { kbIds: [kb.id], query: 'fare', rerank: false, labels: { any: ['receipt'] } }).expect(200)).body.hits).toEqual([]);
    // Dropping the classifier from the base drops its labels.
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { imageClassifiers: [] }).expect(200);
    expect(await h.s.db('knowledge_doc_labels').where({ kb_id: kb.id }).count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('B-8803: knowledge_search, the agent and workflow knowledge step, filters by label at the label of the call', async () => {
    const { curator, kb } = await setup();
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see', status: 'published' }).expect(200);
    await upload(curator, kb.id, 'whiteboard.png', markedPng({ caption: 'A whiteboard', ocr: 'Sprint goals: ship the importer' })).expect(202);
    await upload(curator, kb.id, 'notes.md', Buffer.from('# Notes\n\nSprint goals are set on Mondays.')).expect(202);
    await drain(h);
    const docs = (await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as { id: string; name: string }[];
    const board = docs.find((d) => d.name === 'whiteboard.png')!;
    // A label row as a published classifier would write it.
    await h.s.db('knowledge_doc_labels').insert({ id: 'L'.padEnd(26, '0'), tenant_id: h.tenantId, kb_id: kb.id, document_id: board.id, classifier_id: 'C'.padEnd(26, '0'), classifier_version: 1, label: 'whiteboard', score: 0.9, hit: true, label_rank: 2, created_at: Date.now() });

    const p = (await loadPrincipal(h.s, h.tenantId, curator.user.id, {}))!;
    const call = async (args: Record<string, unknown>, label: 'public' | 'internal' = 'internal') => {
      const { tools } = await h.s.tools.resolve(p, ['knowledge_search'], label);
      return h.s.tools.call({ principal: p, label, approved: false, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
    const all = await call({ kbIds: [kb.id], query: 'sprint goals' });
    expect(all.ok).toBe(true);
    const parsed = all.result as { hits: { document: string; image?: { caption: string; labels: { label: string }[] } }[]; ceiling: string };
    expect(parsed.hits.map((x) => x.document).sort()).toEqual(['notes.md', 'whiteboard.png']);
    const filtered = (await call({ kbIds: [kb.id], query: 'sprint goals', labels: { any: ['whiteboard'] } })).result as typeof parsed;
    expect(filtered.hits.map((x) => x.document)).toEqual(['whiteboard.png']);
    expect(filtered.hits[0]!.image).toMatchObject({ caption: 'A whiteboard', labels: [{ label: 'whiteboard' }] });
    // Called from public data, it searches at public: the internal base's chunks are not read.
    const low = (await call({ kbIds: [kb.id], query: 'sprint goals' }, 'public')).result as typeof parsed;
    expect(low).toMatchObject({ hits: [], ceiling: 'public' });
    // A draft base is refused.
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'draft' }).expect(200);
    expect((await call({ kbIds: [kb.id], query: 'x' })).error).toMatch(/not published/);
  });
});
