import { afterEach, describe, expect, it } from 'vitest';
import { screenedToolText } from '../src/chat/service.js';
import { loadPrincipal } from '../src/http/middleware.js';
import type { EditOp, EditResult, GenerateRequest, ImageEditor } from '../src/images/backends.js';
import { describeOps, imageSize, parseOps } from '../src/images/edits.js';
import { encodePng, readText } from '../src/images/png.js';
import { imageTools } from '../src/registry/builtin/image-catalog.js';
import { localUser, type Harness } from './helpers.js';
import { FakeImageBackend, FakeSafety, harness8 } from './sprint8-fakes.js';

/** A worker that may be down, and may take a reference picture. */
class Worker extends FakeImageBackend {
  up = true;
  constructor(
    id: string,
    readonly restyles = false
  ) {
    super(id);
  }
  async available(): Promise<boolean> {
    return this.up;
  }
}

/** The CPU editor: records each edit and answers with a picture of the size the ops ask for (or 8 x 6). */
class FakeEditor implements ImageEditor {
  calls: { bytes: number; ops: EditOp[] }[] = [];
  async edit(image: Buffer, ops: EditOp[]): Promise<EditResult> {
    this.calls.push({ bytes: image.length, ops });
    const w = Number(ops.find((o) => o.op === 'resize')?.width ?? 8);
    const out = encodePng(w, 6, Buffer.alloc(w * 6 * 3, 90));
    return { image: out, width: w, height: 6, ms: 3 };
  }
}

describe('image tools (migration 074)', () => {
  let h: Harness;
  let flux: Worker;
  let vega: Worker;
  let editor: FakeEditor;
  afterEach(async () => {
    await h.close();
  });

  async function setup() {
    flux = new Worker('flux2-klein', true);
    vega = new Worker('segmind-vega');
    editor = new FakeEditor();
    h = await harness8({ IMAGE_PREFERENCE: 'flux2-klein,segmind-vega' }, { imageBackends: [vega, flux], imageSafety: new FakeSafety(), imageEditor: editor });
  }

  /** Calls a tool as `username`, running due jobs alongside (a tool waits for an edit's job). */
  async function as(username: string) {
    const u = await localUser(h, username, ['member']);
    const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
    return async (name: string, args: Record<string, unknown> = {}) => {
      const { tools } = await h.s.tools.resolve(p, [name], 'internal');
      const call = h.s.tools.call({ principal: { ...p, mfa: true }, label: 'internal', source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
      let done = false;
      void call.finally(() => (done = true));
      while (!done) {
        await h.s.jobs.runDue();
        await new Promise((r) => setTimeout(r, 50));
      }
      return call;
    };
  }

  it('are seeded as read tools, with schemas that match the editor', async () => {
    await setup();
    const rows = (await h.s.db('registry_entries').where({ impl: 'builtin' }).whereIn('name', imageTools().map((t) => t.name)).orderBy('name')) as { name: string; side_effect: string; status: string; confirm: string }[];
    expect(rows.map((r) => r.name)).toEqual(imageTools().map((t) => t.name).sort());
    expect(rows.every((r) => r.side_effect === 'read' && r.status === 'published' && r.confirm === 'never')).toBe(true);
  });

  it('are screened in chat as the masked call and their summary; other tools as raw JSON', () => {
    const out = { image: { id: '01M4Y4VG02K0ER76W1TV9N13YY' }, summary: 'Made a new picture, 8 x 6, by crop 1:1.' };
    expect(screenedToolText('image_crop', '{"image":"01M4Y4MRDCZKMZAVQ3CWJNBEW1","aspect":"1:1"}', out)).toBe('{"image":"<id>","aspect":"1:1"}\nMade a new picture, 8 x 6, by crop 1:1.');
    // A tool outside the image built-ins cannot choose what is screened with a summary of its own.
    expect(screenedToolText('exprsn-ops.shell', '{"cmd":"x"}', { summary: 'harmless', text: 'anything' })).toBe('{"cmd":"x"}\n{"summary":"harmless","text":"anything"}');
    expect(screenedToolText('image_crop', '{}', 'The picture is failed.')).toBe('{}\nThe picture is failed.');
  });

  it('checks edit operations and describes them', () => {
    expect(parseOps([{ op: 'crop', aspect: '16:9' }, { op: 'style', name: 'vintage', strength: 0.6 }])).toHaveLength(2);
    expect(describeOps(parseOps([{ op: 'crop', aspect: '16:9' }, { op: 'style', name: 'vintage', strength: 0.6 }]))).toBe('crop 16:9, style vintage (0.6)');
    expect(() => parseOps([{ op: 'style', name: 'anime' }])).toThrow(/operation 1/);
    expect(() => parseOps([{ op: 'crop', x: 1 }])).toThrow(/aspect/);
    expect(() => parseOps([])).toThrow();
    expect(() => parseOps(Array.from({ length: 13 }, () => ({ op: 'sharpen' })))).toThrow();
    expect(imageSize(encodePng(5, 3, Buffer.alloc(45)))).toEqual({ width: 5, height: 3 });
  });

  it('generates on the first worker that is up, then edits the picture into a new one', async () => {
    await setup();
    const call = await as('ana');
    flux.up = false;
    const gen = await call('image_generate', { prompt: 'A lighthouse at dusk', width: 1024, height: 768 });
    expect(gen.ok).toBe(true);
    const made = (gen.result as { image: { id: string }; model: string }).image;
    expect(gen.result).toMatchObject({ model: 'fake, sdxl-base', image: { backend: 'fake, sdxl-base' } });
    await h.s.jobs.runDue();
    expect(vega.requests).toHaveLength(1);
    expect(flux.requests).toHaveLength(0);

    const crop = await call('image_crop', { image: made.id, aspect: '1:1' });
    expect(crop.ok).toBe(true);
    const edited = (crop.result as { image: { id: string; state: string; url: string; edit: string; source: unknown } }).image;
    expect(edited).toMatchObject({ state: 'succeeded', edit: 'crop 1:1', source: { kind: 'image', id: made.id }, url: `/api/images/${edited.id}/image` });
    expect(editor.calls[0]!.ops).toEqual([{ op: 'crop', aspect: '1:1' }]);
    // The original is unchanged; the edit is a new picture whose provenance names it.
    const original = await h.s.db('image_jobs').where({ id: made.id }).first();
    expect(original.state).toBe('succeeded');
    const row = await h.s.db('image_jobs').where({ id: edited.id }).first();
    expect(row).toMatchObject({ backend: 'editor', source_kind: 'image', source_id: made.id, width: 8, height: 6 });
    const prov = JSON.parse(row.provenance);
    expect(prov).toMatchObject({ backend: 'editor', derivedFrom: { kind: 'image', id: made.id }, edits: [{ op: 'crop', aspect: '1:1' }] });
    // An edit spends no GPU time.
    expect(await h.s.db('usage_records').where({ kind: 'image' })).toHaveLength(1);
    expect(await h.s.db('audit_events').where({ action: 'image.edited' })).toHaveLength(1);

    // Left out, the image is the newest picture: the edit just made.
    const style = await call('image_style', { image: 'latest', name: 'noir' });
    expect(style.result).toMatchObject({ source: { id: edited.id, picked: true }, image: { edit: 'style noir', state: 'succeeded' } });
    const several = await call('image_edit', { ops: [{ op: 'resize', width: 4 }, { op: 'border', width: 2, color: '#fff' }] });
    expect(several.result).toMatchObject({ image: { width: 4, height: 6 } });
    const stored = await h.s.images.image((await loadPrincipal(h.s, h.tenantId, row.user_id, {}))!, (several.result as { image: { id: string } }).image.id);
    expect(readText(stored.data)['exprsn-provenance']).toMatch(/"edits"/);
  });

  it('refuses what it cannot do, with a reason the model can act on', async () => {
    await setup();
    const call = await as('ben');
    expect((await call('image_crop', { aspect: '1:1' })).error).toMatch(/no picture to work on/);
    expect((await call('image_rotate', { image: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).error).toMatch(/degrees to rotate by, or flip/);
    expect((await call('image_style', { name: 'anime' })).ok).toBe(false);
    flux.up = false;
    vega.up = false;
    expect((await call('image_generate', { prompt: 'x' })).error).toMatch(/None of the image workers/);
  });

  it('restyles on a worker that takes a reference picture, and only for the owner', async () => {
    await setup();
    const call = await as('cy');
    const gen = await call('image_generate', { prompt: 'A red bicycle' });
    const made = (gen.result as { image: { id: string } }).image;
    await h.s.jobs.runDue();
    expect(flux.requests).toHaveLength(1);
    const re = await call('image_restyle', { image: made.id, prompt: 'as a watercolour painting' });
    expect(re.ok).toBe(true);
    await h.s.jobs.runDue();
    const sent = flux.requests[1] as GenerateRequest;
    expect(sent.prompt).toBe('as a watercolour painting');
    expect(Buffer.isBuffer(sent.image)).toBe(true);
    const row = await h.s.db('image_jobs').where({ id: (re.result as { image: { id: string } }).image.id }).first();
    expect(row).toMatchObject({ backend: 'flux2-klein', source_kind: 'image', source_id: made.id, state: 'succeeded' });

    // Someone else cannot name it.
    const other = await as('dee');
    expect((await other('image_crop', { image: made.id, aspect: '1:1' })).error).toMatch(/not found/i);
    // A worker that does not restyle is never asked to.
    flux.up = false;
    expect((await call('image_restyle', { image: made.id, prompt: 'night' })).error).toMatch(/can redraw/);
  });

  it('lists the pictures, newest first', async () => {
    await setup();
    const call = await as('eve');
    await call('image_generate', { prompt: 'One' });
    await call('image_generate', { prompt: 'Two' });
    await h.s.jobs.runDue();
    const list = (await call('image_list', {})).result as { images: { name: string; state: string; kind: string }[] };
    expect(list.images.map((i) => i.name)).toEqual(['Two', 'One']);
    expect(list.images.every((i) => i.kind === 'image' && i.state === 'succeeded')).toBe(true);
  });
});
