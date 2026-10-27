import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDoc, imageInfo, inline, parseMarkdown, type ExportDoc } from '../src/chat/export-doc.js';
import { renderDoc, rtfText, toHtml } from '../src/chat/export-formats.js';
import { winAnsi } from '../src/chat/export-pdf.js';
import { zipBytes, zipEntries } from '../src/imports/zip.js';
import { zip } from '../src/platform/zip-writer.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, type Harness } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

/** A tiny PNG: `type` 2 is RGB, 6 is RGBA, 8-bit, filter 0 on every row. */
function png(width: number, height: number, type: 2 | 6): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = type;
  const ch = type === 6 ? 4 : 3;
  const raw = Buffer.alloc((width * ch + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width * ch; x++) raw[y * (width * ch + 1) + 1 + x] = (x * 40 + y * 70) & 0xff;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const RICH = [
  '## Plan',
  '',
  'This is **bold**, *italic* and `code`, with <script>alert(1)</script> in it.',
  '',
  '- first point',
  '- second point',
  '  - nested point',
  '1. step one',
  '2. step two',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| alpha | 1 |',
  '| beta | 2 |',
  '',
  '```js',
  'const x = 1 < 2;',
  '```',
  '',
  '> a quoted line',
  '',
  'Café, naïve, 東京 and an emoji 🙂.'
].join('\n');

function sampleDoc(withImage = true): ExportDoc {
  const t = {
    id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    title: 'Launch <plan> & notes',
    label: 'internal' as const,
    owner: { id: 'u', name: 'Owner' },
    createdAt: Date.UTC(2026, 9, 15, 9),
    updatedAt: Date.UTC(2026, 9, 15, 10),
    artifacts: [],
    messages: [
      { id: 'm1', role: 'user' as const, content: 'What is the plan?', state: 'complete', profile: null, model: null, label: 'internal' as const, citations: [], tools: [], createdAt: Date.UTC(2026, 9, 15, 9, 1), completedAt: null },
      { id: 'm2', role: 'assistant' as const, content: RICH, state: 'complete', profile: 'general', model: 'llama3.1:8b', label: 'internal' as const, citations: [{ n: 1, kb: 'Handbook', document: 'launch.md', label: 'internal' }], tools: [], createdAt: Date.UTC(2026, 9, 15, 9, 2), completedAt: Date.UTC(2026, 9, 15, 9, 2) }
    ]
  };
  const pic = png(3, 2, 6);
  const images = new Map(withImage ? [['m1', [{ alt: 'Attached picture dot.png', data: pic, type: 'image/png' as const, width: 3, height: 2 }, { alt: 'Picture: a secret', missing: 'not available to you' }]]] : []);
  return buildDoc(t, { by: 'owner', at: '2026-10-15T10:00:00.000Z', images });
}

const unzip = async (buf: Buffer) => {
  const entries = zipEntries(buf);
  const out = new Map<string, Buffer>();
  for (const e of entries) out.set(e.name, await zipBytes(buf, e, { used: 0, max: 50_000_000 }));
  return { entries, files: out };
};

/** Every stream of a PDF, inflated when it is Flate-compressed. */
function pdfStreams(pdf: Buffer): string[] {
  const s = pdf.toString('latin1');
  const out: string[] = [];
  const re = /<<([^]*?)>>\nstream\n/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const start = m.index + m[0].length;
    const len = Number(/\/Length (\d+)/.exec(m[1]!)![1]);
    const data = pdf.subarray(start, start + len);
    out.push(/FlateDecode/.test(m[1]!) && !/Image/.test(m[1]!) ? inflateSync(data).toString('latin1') : data.toString('latin1'));
  }
  return out;
}

describe('chat export document', () => {
  it('reads Markdown into headings, runs, lists, tables, code and quotes', () => {
    const blocks = parseMarkdown(RICH);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'item', 'item', 'item', 'item', 'item', 'table', 'code', 'para', 'para']);
    expect(inline('a **b** *c* `d` [e](https://x.test)')).toEqual([{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd', code: true }, { text: ' e (https://x.test)' }]);
    const items = blocks.filter((b) => b.kind === 'item') as { level: number; ordered: boolean; n: number }[];
    expect(items.map((i) => [i.level, i.ordered, i.n])).toEqual([[0, false, 0], [0, false, 0], [1, false, 0], [0, true, 1], [0, true, 2]]);
    expect(imageInfo(png(3, 2, 2))).toEqual({ type: 'image/png', width: 3, height: 2 });
  });

  it('writes a ZIP that the reader opens', async () => {
    const z = zip([{ name: 'mimetype', data: 'x/y', store: true }, { name: 'a/b.txt', data: 'hello '.repeat(100) }]);
    const { entries, files } = await unzip(z);
    expect(entries.map((e) => [e.name, e.method])).toEqual([['mimetype', 0], ['a/b.txt', 8]]);
    expect(files.get('a/b.txt')!.toString()).toBe('hello '.repeat(100));
  });

  it('html is self-contained and escapes every piece of text', () => {
    const html = toHtml(sampleDoc());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<title>Launch &lt;plan&gt; &amp; notes</title>');
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain('[Picture: a secret: not available to you]');
    // Nothing outside the file is referenced.
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
  });

  it('docx and odt are ZIP archives with their XML parts, the text and the picture', async () => {
    const docx = await unzip(renderDoc('docx', sampleDoc()));
    expect([...docx.files.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml', 'word/media/image1.png']));
    const document = docx.files.get('word/document.xml')!.toString('utf8');
    expect(document).toContain('<w:document');
    expect(document).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(document).toContain('<w:tbl>');
    expect(document).toContain('r:embed="rIdImg1"');
    expect(document).toContain('東京');
    expect(docx.files.get('word/_rels/document.xml.rels')!.toString()).toContain('media/image1.png');

    const odtBuf = renderDoc('odt', sampleDoc());
    const odt = await unzip(odtBuf);
    expect(odt.entries[0]).toMatchObject({ name: 'mimetype', method: 0 });
    expect(odt.files.get('mimetype')!.toString()).toBe('application/vnd.oasis.opendocument.text');
    expect(odtBuf.toString('latin1', 30, 38)).toBe('mimetype');
    expect([...odt.files.keys()]).toEqual(expect.arrayContaining(['META-INF/manifest.xml', 'content.xml', 'styles.xml', 'meta.xml', 'Pictures/image1.png']));
    const content = odt.files.get('content.xml')!.toString('utf8');
    expect(content).toContain('<office:document-content');
    expect(content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(content).toContain('<table:table ');
    expect(content).toContain('xlink:href="Pictures/image1.png"');
    expect(odt.files.get('META-INF/manifest.xml')!.toString()).toContain('Pictures/image1.png');
  });

  it('pdf has a header, an xref table, the text and the picture', () => {
    const pdf = renderDoc('pdf', sampleDoc());
    const s = pdf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toMatch(/\nxref\n0 \d+\n0000000000 65535 f \n/);
    expect(s).toMatch(/startxref\n\d+\n%%EOF\n$/);
    // The xref offset points at the table.
    const at = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(at, at + 4)).toBe('xref');
    const text = pdfStreams(pdf).join('\n');
    expect(text).toContain('(What is the plan?) Tj');
    expect(text).toContain('<script>alert\\(1\\)</script>');
    expect(text).toContain('/Im1 Do');
    expect(s).toContain('/Subtype /Image');
    expect(s).toContain('/SMask');
    expect(s).toContain('/BaseFont /Helvetica');
    // Characters WinAnsi cannot hold become "?"; Latin-1 ones are kept.
    expect(winAnsi('Café 東')).toEqual(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x3f]));
    expect(text).toContain('Caf\\351, na\\357ve, ?? and an emoji ?.');
  });

  it('paginates long conversations', () => {
    const d = sampleDoc(false);
    d.blocks = Array.from({ length: 400 }, (_, i) => ({ kind: 'para' as const, runs: [{ text: `Paragraph ${i} with enough words to wrap across the line more than once, `.repeat(3) }] }));
    const s = renderDoc('pdf', d).toString('latin1');
    const count = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]);
    expect(count).toBeGreaterThan(10);
  });

  it('rtf and txt', () => {
    const rtf = renderDoc('rtf', sampleDoc()).toString('latin1');
    expect(rtf.startsWith('{\\rtf1')).toBe(true);
    expect(rtf.endsWith('}')).toBe(true);
    expect(rtf).toContain('\\pngblip');
    expect(rtf).toContain('\\trowd');
    expect(rtfText('a{b}\\c é')).toBe('a\\{b\\}\\\\c \\u233?');
    expect(rtfText('🙂')).toBe('\\u-10179?\\u-8638?');
    const txt = renderDoc('txt', sampleDoc()).toString('utf8');
    expect(txt).toContain('Launch <plan> & notes\n=====');
    expect(txt).toContain('| alpha | 1     |');
    expect(txt).toContain('    const x = 1 < 2;');
    expect(txt).toContain('[Picture: Attached picture dot.png');
  });
});

describe('chat export formats through the API', () => {
  let h: Harness;
  let ollama: FakeOllama;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    await seedGateway(h, ollama, { label: 'internal' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function user(name: string) {
    const u = await localUser(h, name, ['member'], 'internal');
    const c = await login(h, name);
    await h.s.db('users').where({ id: u.id }).update({ clearance: 'internal' });
    return { ...u, ...c, post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b) };
  }

  const download = async (o: Awaited<ReturnType<typeof user>>, id: string) =>
    o.agent
      .get(`/api/conversation-exports/${id}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      })
      .expect(200);

  it('exports in every format with the right type and name, embedding the pictures the requester may read', async () => {
    ollama.reply = () => ({ content: RICH });
    const owner = await user('owner');
    const reader = await user('reader');
    const sent = await owner.post('/api/chat', { content: 'Give me the plan <b>now</b>', profile: 'general' }).expect(202);
    await until(async () => (await h.s.db('messages').where({ id: sent.body.messageId }).first()).completed_at != null);
    const cid = sent.body.conversationId as string;
    // An attached picture on the question (attached directly: the profile's model has no vision).
    const a = await h.s.attachments.upload({ tenantId: h.tenantId, workspaceId: null, userId: owner.id, name: 'dot.png', declaredType: 'image/png', label: 'internal', data: png(4, 3, 2) });
    await h.s.jobs.runDue();
    expect((await h.s.attachments.get(h.tenantId, a.id))!.state).toBe('ready');
    await h.s.db('messages').where({ id: sent.body.userMessageId }).update({ attachments: JSON.stringify([a.id]) });

    const expected: Record<string, [string, string]> = {
      docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
      odt: ['application/vnd.oasis.opendocument.text', 'odt'],
      pdf: ['application/pdf', 'pdf'],
      html: ['text/html; charset=utf-8', 'html'],
      txt: ['text/plain; charset=utf-8', 'txt'],
      rtf: ['application/rtf', 'rtf']
    };
    const files: Record<string, Buffer> = {};
    for (const [format, [type, ext]] of Object.entries(expected)) {
      const x = await owner.post(`/api/conversations/${cid}/exports`, { format }).expect(202);
      expect(x.body.file).toMatch(new RegExp(`^conversation-\\d{4}-\\d{2}-\\d{2}-[0-9a-z]{6}\\.${ext}$`));
      await h.s.jobs.runDue();
      expect((await owner.agent.get(`/api/conversation-exports/${x.body.id}`).expect(200)).body).toMatchObject({ state: 'ready', format });
      const res = await download(owner, x.body.id);
      expect(res.headers['content-type']).toBe(type);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${x.body.file}"`);
      files[format] = res.body as Buffer;
      // Stored sealed.
      const row = await h.s.db('conversation_exports').where({ id: x.body.id }).first();
      expect((await h.s.blobs.get(row.blob_key))!.toString('utf8')).not.toContain('Give me the plan');
    }
    const html = files.html!.toString('utf8');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<b>now</b>');
    expect(html).toContain('Give me the plan &lt;b&gt;now&lt;/b&gt;');
    expect(html).toContain('data:image/png;base64,');
    expect(files.pdf!.toString('latin1', 0, 5)).toBe('%PDF-');
    expect(pdfStreams(files.pdf!).join('\n')).toContain('(Give me the plan <b>now</b>) Tj');
    expect(files.rtf!.toString('latin1').startsWith('{\\rtf1')).toBe(true);
    expect(files.txt!.toString('utf8')).toContain('[Attached picture dot.png: not embedded in plain text]');
    const docx = await unzip(files.docx!);
    expect(docx.files.get('word/document.xml')!.toString()).toContain('Give me the plan &lt;b&gt;now&lt;/b&gt;');
    expect(docx.files.has('word/media/image1.png')).toBe(true);
    const odt = await unzip(files.odt!);
    expect(odt.files.get('content.xml')!.toString()).toContain('&lt;script&gt;');

    // A reader with a share gets the text, but the owner's attached picture only as a placeholder.
    await owner.post(`/api/conversations/${cid}/shares`, { kind: 'user', userId: reader.id }).expect(201);
    const rx = await reader.post(`/api/conversations/${cid}/exports`, { format: 'html' }).expect(202);
    await h.s.jobs.runDue();
    const rhtml = (await download(reader, rx.body.id)).body.toString('utf8') as string;
    expect(rhtml).toContain('Give me the plan');
    expect(rhtml).not.toContain('data:image/png');
    expect(rhtml).toContain('[Attached picture dot.png: not available to you]');

    await owner.post(`/api/conversations/${cid}/exports`, { format: 'xlsx' }).expect(400);
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['conversation.export.requested', 'conversation.export.ready', 'conversation.export.downloaded']));
  });
});
