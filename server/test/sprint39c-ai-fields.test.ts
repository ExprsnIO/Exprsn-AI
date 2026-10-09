import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiFieldsAffected, aiPromptRefs, checkDefinition, entityDefinitionSchema, renderAiPrompt } from '../src/apps/schema.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { seedGateway } from './seed-gateway.js';
import { clients } from './sprint39c-helpers.js';

/*
 * 1.6.0, Sprint 39c: B-8401 AI field prompts built from field references and formula functions, regenerated once when
 * a referenced field changes; B-8402 a fill of an AI field over every row as a job with an estimate, progress and a
 * cancel.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AI field prompts (B-8401)', () => {
  const def = (prompt: string) => entityDefinitionSchema.parse({ fields: [{ name: 'name', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'notes', type: 'string' }, { name: 'summary', type: 'ai', profile: 'general', prompt }] });

  it('accepts field names and formulas in placeholders, refuses what it cannot read, and renders them', () => {
    expect(checkDefinition(def('Summarise {{name}} worth {{round(amount * 1.2, 2)}} ({{upper(name)}})'), new Set(['e']))).toEqual([]);
    expect(checkDefinition(def('{{process}}'), new Set(['e']))[0]).toMatch(/summary: the prompt reads \{\{process\}\}/);
    expect(checkDefinition(def('{{upper(summary)}}'), new Set(['e']))[0]).toMatch(/summary is not a field/);
    const d = def('Summarise {{name}} worth {{round(amount * 1.2, 2)}} ({{upper(name)}})');
    const ai = d.fields.find((f) => f.type === 'ai')!;
    expect([...aiPromptRefs(d, ai as never)].sort()).toEqual(['amount', 'name']);
    expect(renderAiPrompt(d, ai as never, { name: 'ada', amount: 10, notes: 'x' })).toBe('Summarise ada worth 12 (ADA)');
    expect(aiFieldsAffected(d, new Set(['notes']))).toEqual([]);
    expect(aiFieldsAffected(d, new Set(['amount']))).toEqual(['summary']);
    expect(aiFieldsAffected(d, null)).toEqual(['summary']);
  });
});

describe('AI fields through the API (B-8401, B-8402)', () => {
  let h: Harness;
  let wsId: string;
  let ollama: FakeOllama;
  let calls: string[];

  beforeEach(async () => {
    h = await harness({ APPS_AI_DEBOUNCE_MS: '300' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    ollama = await new FakeOllama().start();
    await seedGateway(h, ollama);
    calls = [];
    ollama.reply = (msgs) => {
      const p = msgs[msgs.length - 1]!.content;
      calls.push(p);
      return { content: `Short: ${p.replace(/^Summarise: /, '')}` };
    };
  });
  afterEach(async () => {
    await ollama.stop().catch(() => undefined);
    await h.close();
  });

  const entity = { name: 'note', definition: { fields: [{ name: 'text', type: 'string', required: true }, { name: 'tag', type: 'string' }, { name: 'summary', type: 'ai', profile: 'general', prompt: 'Summarise: {{upper(text)}}', indexed: true }] } };

  it('regenerates once after a burst of edits to a referenced field, and not at all for an unreferenced one', async () => {
    const c = clients(h, wsId);
    const d = await c.designer();
    const m = await c.member('mia');
    await d.post('/api/apps', { name: 'notes', label: 'internal', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/notes/entities', entity).expect(201);
    const rec = (await m.post('/api/apps/notes/entities/note/records', { values: { text: 'the plan' } }).expect(201)).body;
    expect(rec.aiState).toBe('pending');
    await drain(h);
    expect(calls).toHaveLength(0); // not due yet: the fill waits for the quiet window
    await sleep(350);
    await drain(h);
    expect(calls).toEqual(['Summarise: THE PLAN']);
    expect((await m.get(`/api/apps/notes/entities/note/records/${rec.id}`).expect(200)).body).toMatchObject({ aiState: 'filled', values: { summary: 'Short: THE PLAN' } });

    // three quick edits of the referenced field: one regeneration, with the last value
    await m.patch(`/api/apps/notes/entities/note/records/${rec.id}`, { values: { text: 'v1' } }).expect(200);
    await m.patch(`/api/apps/notes/entities/note/records/${rec.id}`, { values: { text: 'v2' } }).expect(200);
    await m.patch(`/api/apps/notes/entities/note/records/${rec.id}`, { values: { text: 'v3' } }).expect(200);
    expect((await h.s.db('jobs').where({ type: 'apps.ai-fill', state: 'queued' })).length).toBeLessThanOrEqual(2);
    await sleep(650);
    await drain(h);
    expect(calls.filter((x) => x.startsWith('Summarise: V'))).toEqual(['Summarise: V3']);
    expect((await m.get(`/api/apps/notes/entities/note/records/${rec.id}`).expect(200)).body.values.summary).toBe('Short: V3');

    // an edit of a field the prompt does not read leaves the summary alone and asks nothing
    const n = calls.length;
    const after = (await m.patch(`/api/apps/notes/entities/note/records/${rec.id}`, { values: { tag: 'x' } }).expect(200)).body;
    expect(after.aiState).toBe('filled');
    await sleep(350);
    await drain(h);
    expect(calls).toHaveLength(n);
    expect(after.values.summary).toBe('Short: V3');
  });

  it('estimates and fills a field over every row as one job with progress, and a cancel stops it midway', async () => {
    const c = clients(h, wsId);
    const d = await c.designer();
    await d.post('/api/apps', { name: 'notes', label: 'internal', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/notes/entities', { name: 'note', definition: { fields: [{ name: 'text', type: 'string', required: true }, { name: 'summary', type: 'ai', profile: 'general', prompt: 'Summarise: {{text}}', maxLength: 200 }] } }).expect(201);
    // 60 records whose fills failed (the model answered nothing), so the field is empty everywhere
    ollama.reply = () => ({ content: '' });
    await d.post('/api/apps/notes/entities/note/records/bulk', { create: Array.from({ length: 60 }, (_, i) => ({ values: { text: `item ${i}` } })) }).expect(200);
    await sleep(350);
    await drain(h);
    expect((await h.s.db('app_records').where({ ai_state: 'failed' })).length).toBe(60);
    ollama.reply = (msgs) => {
      const p = msgs[msgs.length - 1]!.content;
      calls.push(p);
      return { content: `S:${p.slice(-2)}` };
    };
    await h.s.analytics.setPrice(h.tenantId, { scope: 'model', ref: 'llama3.1:8b', currency: 'EUR', inputPerMillion: 1, outputPerMillion: 10, gpuHour: 0, note: null }, d.user.id);
    const est = (await d.post('/api/apps/notes/entities/note/ai/estimate', { field: 'summary', scope: 'empty' }).expect(200)).body;
    expect(est).toMatchObject({ records: 60, capped: false, model: 'llama3.1:8b', currency: 'EUR' });
    expect(est.promptTokens).toBeGreaterThan(60 * 10);
    expect(est.cost).toBeGreaterThan(0);
    await d.post('/api/apps/notes/entities/note/ai/estimate', { field: 'text', scope: 'all' }).expect(400);

    // a fill that is cancelled after a few records
    const fill = (await d.post('/api/apps/notes/entities/note/ai/fills', { field: 'summary', scope: 'empty' }).expect(202)).body;
    expect(fill).toMatchObject({ state: 'queued', total: 60, scope: 'empty' });
    await d.post('/api/apps/notes/entities/note/ai/fills', { field: 'summary', scope: 'all' }).expect(409); // one at a time
    let cancelled = false;
    ollama.reply = (msgs) => {
      const p = msgs[msgs.length - 1]!.content;
      calls.push(p);
      if (calls.length === 3 && !cancelled) {
        cancelled = true;
        void d.post(`/api/apps/notes/entities/note/ai/fills/${fill.id}/cancel`).then(() => undefined);
      }
      return { content: `S:${p.slice(-2)}` };
    };
    await drain(h);
    // the queue reports a cancelled job at once; the handler finishes the record it was on, then stops
    const settled = async () => {
      let last = -1;
      for (let i = 0; i < 40; i++) {
        const n = (await h.s.db('app_records').where({ entity_id: (await h.s.db('app_entities').first('id'))!.id, ai_state: 'filled' })).length;
        if (n === last) return n;
        last = n;
        await sleep(100);
      }
      return last;
    };
    const filledCount = await settled();
    const done = (await d.get(`/api/apps/notes/entities/note/ai/fills/${fill.id}`).expect(200)).body;
    expect(done.state).toBe('cancelled');
    expect(done.done).toBeGreaterThanOrEqual(2); // the cancel aborts the job's signal: it stops before the next call
    expect(done.done).toBeLessThan(60);
    expect(done.promptTokens).toBeGreaterThan(0);
    await d.post(`/api/apps/notes/entities/note/ai/fills/${fill.id}/cancel`).expect(409);

    // the rest, uncancelled: only the empties are filled
    const filled = filledCount;
    calls = [];
    const fill2 = (await d.post('/api/apps/notes/entities/note/ai/fills', { field: 'summary', scope: 'empty' }).expect(202)).body;
    expect(fill2.total).toBe(60 - filled);
    await drain(h);
    const end = (await d.get(`/api/apps/notes/entities/note/ai/fills/${fill2.id}`).expect(200)).body;
    expect(end).toMatchObject({ state: 'succeeded', done: 60 - filled, failed: 0 });
    expect(calls).toHaveLength(60 - filled);
    const list = (await d.get('/api/apps/notes/entities/note/ai/fills').expect(200)).body.fills;
    expect(list.map((f: { state: string }) => f.state)).toEqual(['succeeded', 'cancelled']);
    const rows = (await d.post('/api/apps/notes/entities/note/records/query', { limit: 100 }).expect(200)).body.records;
    expect(rows.every((r: { values: { summary?: string } }) => r.values.summary?.startsWith('S:'))).toBe(true);
    expect(await h.s.audit.list(h.tenantId, { action: 'app.ai.fill.started' })).toHaveLength(2);
    expect(await h.s.audit.list(h.tenantId, { action: 'app.ai.fill.cancelled' })).toHaveLength(1);
    // the fill is metered like any model use
    expect(Number((await h.s.db('usage_records').where({ tenant_id: h.tenantId }).sum({ n: 'output_tokens' }).first())!.n)).toBeGreaterThan(0);
  });
});
