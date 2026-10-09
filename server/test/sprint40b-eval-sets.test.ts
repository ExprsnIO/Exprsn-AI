import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_SAMPLES } from '../src/guardrails/classifiers.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { startFakeClassifierWorker, startFakeDataHub, type FakeClassifierWorker, type FakeDataHub } from './sprint40b-fakes.js';

/**
 * Sprint 40b (1.7.0), B-3806: classifier eval sets and imported engines. Rows of a hub dataset become the cases of an
 * eval set with minimum-sample warnings, a classifier built on them is trained and shows precision and recall per
 * label; a text-classification model imported with target `classifiers` is a classifier with the `imported` engine,
 * scored by the classifier worker and evaluated on the same set.
 */

const send = (c: Client, method: 'post' | 'patch' | 'put' | 'delete', url: string, body: unknown = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body as object);

describe('Sprint 40b: eval sets and imported classifier engines', () => {
  let h: Harness;
  let hub: FakeDataHub;
  let worker: FakeClassifierWorker;
  let a: Client;
  let b: Client;
  let hubId: string;
  const run = () => h.s.jobs.runDue(50);
  const drain = async () => {
    for (let i = 0; i < 12; i++) if (!(await run())) return;
  };

  beforeAll(async () => {
    [hub, worker] = await Promise.all([startFakeDataHub(), startFakeClassifierWorker()]);
    h = await harness({ IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0', IMPORT_PART_BYTES: '1024', CLASSIFIER_WORKER_URL: worker.url }, { classifierWorkerFetch: worker.fetch });
    await localUser(h, 'eva', ['model-admin', 'tenant-admin', 'guardrail-admin'], 'restricted');
    await localUser(h, 'evb', ['model-admin'], 'restricted');
    await localUser(h, 'evlegal', ['legal-review'], 'restricted');
    [a, b] = [await loginAdmin(h, 'eva'), await loginAdmin(h, 'evb')];
    // The phrasebank's licence joins the tenant's allow-list (the legal-review role keeps that list).
    const legal = await loginAdmin(h, 'evlegal');
    const settings = (await legal.agent.get('/api/imports/settings').expect(200)).body as { allowedLicences: string[] };
    await send(legal, 'put', '/api/imports/settings/licences', { allowedLicences: [...settings.allowedLicences, 'cc-by-nc-sa-4.0'] }).expect(200);
    const p = await send(a, 'post', '/api/imports/repositories', { name: 'hub (fake)', type: 'hf', baseUrl: hub.url, region: 'Global', kinds: ['model', 'dataset'], harvestMinutes: null });
    if (p.status !== 201) throw new Error(JSON.stringify(p.body));
    await send(b, 'post', `/api/imports/repositories/${p.body.id}/confirm`, {}).expect(200);
    await drain();
    hubId = p.body.id;
  }, 120_000);

  afterAll(async () => {
    await h.close();
    await Promise.all([hub.close(), worker.close()]);
  });

  it('turns a hub dataset\'s rows into an eval set with minimum-sample warnings, builds a classifier on it and evaluates it per label', async () => {
    const detail = (await a.agent.get(`/api/imports/repositories/${hubId}/dataset?id=acme/banking`).expect(200)).body;
    expect(detail.resources.map((r: { name: string; split: string | null; format: string }) => [r.name, r.split, r.format])).toEqual([['train.csv', 'train', 'csv'], ['test.csv', 'test', 'csv']]);
    expect(detail.configurations[0].splits).toEqual(['train', 'test']);
    const body = { repositoryId: hubId, item: 'acme/banking', splits: ['train', 'test'], target: 'classifiers', label: 'internal', classifiers: { evalSet: 'banking-intents', textColumn: 'text', labelColumn: 'label', classifier: { mode: 'new', name: 'Banking intents', engine: 'linear' } } };
    const plan = (await send(a, 'post', '/api/imports/dataset-plan', body).expect(200)).body;
    expect(plan.blocked, JSON.stringify(plan.checks)).toBe(false);
    expect(plan.schema.columns.map((c: { name: string }) => c.name)).toEqual(['text', 'label']);
    const created = (await send(a, 'post', '/api/imports/datasets', body).expect(201)).body;
    await drain();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
    expect(imp.result.evalSet).toMatchObject({ name: 'banking-intents', cases: 425, counts: { refund: 220, card_lost: 205 }, short: [] });
    expect(imp.result.evalSet.classifier.evaluateJob).toBeTruthy();
    // The previews read the first split only; the job read both.
    expect(hub.downloads.slice(-2)).toEqual(['acme/banking:train.csv', 'acme/banking:test.csv']);
    // Below the minimum per label, the import warns (the second resource of the phrasebank has 30 rows).
    const small = (await send(a, 'post', '/api/imports/datasets', { repositoryId: hubId, item: 'acme/phrasebank', target: 'classifiers', label: 'internal', classifiers: { evalSet: 'phrasebank', textColumn: 'sentence', labelColumn: 'sentiment', classifier: { mode: 'none' } } }).expect(201)).body;
    await drain();
    const smallImp = (await a.agent.get(`/api/imports/${small.id}`).expect(200)).body;
    expect(smallImp.state, JSON.stringify(smallImp.log)).toBe('complete');
    expect(smallImp.result.evalSet.short.sort()).toEqual(['negative', 'positive']);
    expect(smallImp.result.warnings[0]).toContain(`Below ${MIN_SAMPLES} samples`);
    expect((await a.agent.get('/api/eval-sets').expect(200)).body.map((x: { name: string; cases: number }) => `${x.name}:${x.cases}`)).toEqual(expect.arrayContaining(['banking-intents:425', 'phrasebank:30']));

    // The classifier was trained on the set and shows precision and recall per label on the Classifiers screen's data.
    const c = (await a.agent.get(`/api/admin/classifiers/${imp.classifierId}`).expect(200)).body;
    expect(c).toMatchObject({ name: 'Banking intents', engine: 'linear', dataset: 'banking-intents', status: 'draft' });
    expect(c.samples).toEqual({ refund: 220, card_lost: 205 });
    expect(c.trained).toBeTruthy();
    expect(Object.keys(c.metrics.perLabel).sort()).toEqual(['card_lost', 'refund']);
    expect(c.metrics.perLabel.refund.precision).toBeGreaterThan(0.5);
    expect(c.metrics.perLabel.refund.recall).toBeGreaterThan(0.5);
  }, 120_000);

  it('imports a text-classification model as a classifier with the imported engine, served by the classifier worker', async () => {
    const plan = (await send(a, 'post', '/api/imports/plan', { repositoryId: hubId, item: 'acme/intent-cls', target: 'classifiers', label: 'internal' }).expect(200)).body;
    expect(plan.blocked, JSON.stringify(plan.checks)).toBe(false);
    expect(plan.checks.find((x: { name: string }) => x.name === 'Serving path')).toMatchObject({ result: 'passed' });
    expect(plan.conversion.needed).toBe(false);
    const created = (await send(a, 'post', '/api/imports', { repositoryId: hubId, item: 'acme/intent-cls', target: 'classifiers', label: 'internal' }).expect(201)).body;
    expect(created.target).toBe('classifiers');
    await drain();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
    expect(imp.classifierId).toBeTruthy();
    expect(imp.model).toBeNull();
    expect(imp.manifest.classifier.labels).toEqual(['refund', 'card_lost']);
    const c = (await a.agent.get(`/api/admin/classifiers/${imp.classifierId}`).expect(200)).body;
    expect(c).toMatchObject({ engine: 'imported', status: 'draft' });
    expect(c.labels.map((l: { label: string }) => l.label)).toEqual(['refund', 'card_lost']);
    // Scored by the worker, which is told the staged files by their blob keys.
    const row = (await h.s.guard.classifiers.get(h.tenantId, imp.classifierId))!;
    const score = await h.s.guard.classifiers.score(h.tenantId, row, 'My card is lost, please block it', 'internal');
    expect(score.top).toMatchObject({ label: 'card_lost' });
    expect(score.engine).toBe('imported');
    expect(worker.calls[0]!.model).toBe(imp.ref);
    const files = (row.config.model!.files as { name: string; key: string }[]).map((f) => f.name).sort();
    expect(files).toEqual(['config.json', 'model.safetensors', 'tokenizer.json']);
    for (const f of row.config.model!.files) expect(await h.s.blobs.get(f.key)).not.toBeNull();
    // Evaluated on the imported eval set: precision and recall per label.
    await send(a, 'patch', `/api/admin/classifiers/${imp.classifierId}`, { dataset: 'banking-intents' }).expect(200);
    await send(a, 'post', `/api/admin/classifiers/${imp.classifierId}/evaluate`).expect(202);
    await drain();
    const after = (await a.agent.get(`/api/admin/classifiers/${imp.classifierId}`).expect(200)).body;
    expect(after.metrics.samples).toBe(425);
    expect(after.metrics.perLabel.card_lost.recall).toBe(1);
    expect(after.metrics.perLabel.refund.precision).toBe(1);
  }, 120_000);
});
