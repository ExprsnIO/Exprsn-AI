import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifierModelDigest, HttpClassifierWorker } from '../src/guardrails/classifier-worker.js';
import { classifierLabels, servedFile } from '../src/imports/classifier-models.js';
import { startFakeClassifierWorker, type FakeClassifierWorker } from './fake-classifier-worker.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { pickle, safetensors, startFakeHub, type FakeHub } from './sprint30-imports-fakes.js';

/**
 * Sprint 40 (1.7.0), B-3806, second half: imported classifier engines. A text-classification model from a hub goes
 * through the model import, is checked and loaded by the classifier worker (a fake that speaks the contract), is
 * registered as a draft model pinned by its digest, and serves a classifier of the `imported` engine: measured on an
 * imported eval set while a draft, published only once the model is evaluated and approved under dual control.
 */

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const send = (c: Client, method: 'post' | 'patch' | 'put' | 'delete', url: string, body: unknown = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body as object);

describe('classifier models: the digest, the labels and the files the worker takes (B-3806)', () => {
  it('pins a model by the sha256sum listing of its files, whatever their order', () => {
    const files = [{ name: 'model.safetensors', sha256: sha256('w') }, { name: 'config.json', sha256: sha256('c') }];
    const listing = `${sha256('c')}  config.json\n${sha256('w')}  model.safetensors\n`;
    expect(classifierModelDigest(files)).toBe(`sha256:${sha256(listing)}`);
    expect(classifierModelDigest([...files].reverse())).toBe(classifierModelDigest(files));
    expect(classifierModelDigest([files[0]!, { name: 'config.json', sha256: sha256('other') }])).not.toBe(classifierModelDigest(files));
  });

  it('reads the labels from config.json and refuses what is not a classifier', () => {
    expect(classifierLabels({ id2label: { 1: 'POSITIVE', 0: 'NEGATIVE' }, architectures: ['DistilBertForSequenceClassification'] })).toEqual({ labels: ['NEGATIVE', 'POSITIVE'], multiLabel: false, architecture: 'DistilBertForSequenceClassification' });
    expect(classifierLabels({ id2label: { 0: 'toxic', 1: 'insult' }, problem_type: 'multi_label_classification', model_type: 'roberta' })).toMatchObject({ multiLabel: true, architecture: 'roberta' });
    expect(() => classifierLabels({ model_type: 'bert' })).toThrow(/names no labels/);
    expect(() => classifierLabels({ id2label: { 0: 'score' } })).toThrow(/one output/);
    expect(() => classifierLabels({ id2label: { 0: 'a', 2: 'b' } })).toThrow(/not 0 to n-1/);
    expect(() => classifierLabels({ id2label: { 0: 'a', 1: 'a' } })).toThrow(/same label twice/);
    expect(() => classifierLabels({ id2label: { 0: 'a', 1: 'b' }, problem_type: 'regression' })).toThrow(/regression/);
    expect(() => classifierLabels({ id2label: { 0: 'a', 1: 'b' }, auto_map: { AutoModel: 'modeling.Custom' } })).toThrow(/never run/);
    expect(() => classifierLabels({ id2label: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i, `l${i}`])) })).toThrow(/at most 100/);
  });

  it('takes weights and configuration from the root of a repository only', () => {
    expect(servedFile({ name: 'model.safetensors', format: 'safetensors' })).toBe(true);
    expect(servedFile({ name: 'vocab.txt', format: 'metadata' })).toBe(true);
    expect(servedFile({ name: 'README.md', format: 'metadata' })).toBe(false);
    expect(servedFile({ name: 'onnx/model.onnx', format: 'onnx' })).toBe(false);
    expect(servedFile({ name: 'onnx/config.json', format: 'metadata' })).toBe(false);
    expect(servedFile({ name: 'pytorch_model.bin', format: 'pickle' })).toBe(false);
  });

  it('refuses a worker address the service policy refuses, before any call', async () => {
    const w = new HttpClassifierWorker({ url: 'http://169.254.169.254/', timeoutMs: 1000 });
    await expect(w.info()).rejects.toThrow(/address is refused/);
  });
});

describe('Sprint 40: an imported text-classification model as a classifier engine (B-3806)', () => {
  let h: Harness;
  let hub: FakeHub;
  let worker: FakeClassifierWorker;
  let a: Client; // model admin and guardrail admin: imports the model and manages classifiers
  let b: Client; // the second model admin, who approves
  let m: Client; // a model admin without classifiers:manage
  let hubId: string;
  let modelId: string;
  let classifierId: string;

  const LABELS = ['card_arrival', 'refund', 'top_up'];
  const config = (extra: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ model_type: 'distilbert', architectures: ['DistilBertForSequenceClassification'], id2label: { 0: 'card_arrival', 1: 'refund', 2: 'top_up' }, label2id: { card_arrival: 0, refund: 1, top_up: 2 }, ...extra }));
  const addRepo = (id: string, files: [string, Buffer][], pipeline = 'text-classification') =>
    hub.repos.set(id, { id, sha: sha256(id).slice(0, 40), licence: 'apache-2.0', pipeline, gated: false, downloads: 10, library: 'transformers', files: files.map(([name, bytes]) => ({ name, bytes, lfs: /\.(safetensors|bin|onnx)$/.test(name) })) });
  const requested = async (c: Client, body: object) => {
    const res = await send(c, 'post', '/api/imports', body);
    if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    await drain(h);
    return (await c.agent.get(`/api/imports/${res.body.id}`).expect(200)).body;
  };

  beforeAll(async () => {
    [hub, worker] = await Promise.all([startFakeHub(), startFakeClassifierWorker({ token: 'worker-secret' })]);
    worker.keywords = { card_arrival: ['card'], refund: ['money back', 'refund'], top_up: ['funds', 'top up'] };
    h = await harness({ IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0', IMPORT_REFRESH_TICK_MINUTES: '0', OLLAMA_POLL_MS: '600000', CLASSIFIER_WORKER_URL: worker.url, CLASSIFIER_WORKER_TOKEN: 'worker-secret', CLASSIFIER_WORKER_LABEL_CEILING: 'confidential' });
    await localUser(h, 'cea', ['model-admin', 'guardrail-admin'], 'restricted');
    await localUser(h, 'ceb', ['model-admin'], 'restricted');
    await localUser(h, 'cem', ['model-admin'], 'restricted');
    [a, b, m] = [await loginAdmin(h, 'cea'), await loginAdmin(h, 'ceb'), await loginAdmin(h, 'cem')];
    addRepo('acme/intent-classifier', [['model.safetensors', safetensors('intent', 6000)], ['config.json', config()], ['tokenizer.json', Buffer.from('{"version":"1.0"}')], ['vocab.txt', Buffer.from('[PAD]\n[UNK]\ncard\nrefund\n')], ['README.md', Buffer.from('# Intent classifier\n')], ['onnx/model.onnx', Buffer.alloc(900, 3)]]);
    addRepo('acme/regressor', [['model.safetensors', safetensors('reg', 3000)], ['config.json', Buffer.from(JSON.stringify({ model_type: 'bert', id2label: { 0: 'LABEL_0' }, problem_type: 'regression' }))]]);
    addRepo('acme/pickled-classifier', [['pytorch_model.bin', pickle()], ['config.json', config()]]);
    addRepo('acme/toxicity', [['model.safetensors', safetensors('tox', 3000)], ['config.json', Buffer.from(JSON.stringify({ model_type: 'roberta', id2label: { 0: 'toxic', 1: 'insult' }, problem_type: 'multi_label_classification' }))]]);
    const p = await send(a, 'post', '/api/imports/repositories', { name: 'Hub (fake)', type: 'hf', baseUrl: hub.url, region: 'Global', kinds: ['model', 'dataset'] });
    if (p.status !== 201) throw new Error(JSON.stringify(p.body));
    await send(b, 'post', `/api/imports/repositories/${p.body.id}/confirm`, {}).expect(200);
    await drain(h);
    hubId = p.body.id as string;
  }, 180_000);

  afterAll(async () => {
    await h.close();
    await Promise.all([hub.close(), worker.close()]);
  });

  it('plans a text-classification model for the classifier worker: safetensors as published, no conversion, no pool', async () => {
    const plan = (await send(a, 'post', '/api/imports/plan', { repositoryId: hubId, item: 'acme/intent-classifier', label: 'internal' }).expect(200)).body;
    expect(plan).toMatchObject({ blocked: false, waiting: false, serving: 'classifier', tag: 'intent-classifier:classifier', conversion: { needed: false, quantization: null }, capabilities: ['classification'] });
    // The README and the ONNX export in a folder are not fetched.
    expect(plan.selected).toEqual(['model.safetensors', 'config.json', 'tokenizer.json', 'vocab.txt']);
    expect(plan.checks.find((c: { name: string }) => c.name === 'Serving path')).toMatchObject({ result: 'passed', detail: expect.stringMatching(/classifier worker/) });
    expect(plan.checks.find((c: { name: string }) => c.name === 'Format')).toMatchObject({ result: 'passed', detail: expect.stringMatching(/1 safetensors file with 3 configuration and tokenizer files/) });
    expect(plan.checks.some((c: { name: string }) => c.name === 'Conversion')).toBe(false);
    // A pool, a folder file and a pickle-only repository are refused at the plan.
    const pooled = (await send(a, 'post', '/api/imports/plan', { repositoryId: hubId, item: 'acme/intent-classifier', poolId: '0'.repeat(26) }).expect(200)).body;
    expect(pooled.checks.find((c: { name: string }) => c.name === 'Serving path')).toMatchObject({ result: 'refused', detail: expect.stringMatching(/not placed on a pool/) });
    const folder = (await send(a, 'post', '/api/imports/plan', { repositoryId: hubId, item: 'acme/intent-classifier', files: ['model.safetensors', 'config.json', 'onnx/model.onnx'] }).expect(200)).body;
    expect(folder.checks.find((c: { name: string }) => c.name === 'Format')).toMatchObject({ result: 'refused', detail: expect.stringMatching(/onnx\/model\.onnx/) });
    const pickled = (await send(a, 'post', '/api/imports/plan', { repositoryId: hubId, item: 'acme/pickled-classifier' }).expect(200)).body;
    expect(pickled.checks.find((c: { name: string }) => c.name === 'Format')).toMatchObject({ result: 'refused', detail: expect.stringMatching(/pickle/) });
    // Without its configuration the labels cannot be read.
    const bare = (await send(a, 'post', '/api/imports/plan', { repositoryId: hubId, item: 'acme/sentiment' }).expect(200)).body;
    expect(bare.checks.find((c: { name: string }) => c.name === 'Format')).toMatchObject({ result: 'refused', detail: expect.stringMatching(/config\.json/) });
  });

  it('imports it: the worker checks every file, the draft is pinned by the model digest, and a draft classifier is made over it', async () => {
    const imp = await requested(a, { repositoryId: hubId, item: 'acme/intent-classifier', label: 'internal', classifier: { name: 'Banking intent' } });
    expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
    const files = hub.repos.get('acme/intent-classifier')!.files.filter((f) => !f.name.includes('/') && f.name !== 'README.md');
    const digest = classifierModelDigest(files.map((f) => ({ name: f.name, sha256: sha256(f.bytes) })));
    expect(imp.model).toMatchObject({ name: 'intent-classifier:classifier', state: 'draft', expectedDigest: digest });
    modelId = imp.model.id;
    const model = (await h.s.gateway.repo.model(modelId))!;
    expect(model).toMatchObject({ format: 'safetensors', capabilities: ['classification'], import_state: 'pulled', digest: digest.slice(7), label: 'internal', state: 'draft', family: 'DistilBertForSequenceClassification' });
    expect(model.license).toMatchObject({ name: 'apache-2.0' });
    // The worker holds exactly the verified files, each call made with the worker's token.
    const held = worker.models.get(digest.slice(7))!;
    expect([...held.keys()].sort()).toEqual(files.map((f) => f.name).sort());
    for (const f of files) expect(held.get(f.name)!.equals(f.bytes)).toBe(true);
    expect(worker.calls.every((c) => c.authorization === 'Bearer worker-secret')).toBe(true);
    expect(worker.calls.filter((c) => c.method === 'PUT')).toHaveLength(4);
    expect(imp.manifest).toMatchObject({ format: 'exprsn-import-manifest/1', model: { expectedDigest: digest }, classifier: { digest, labels: LABELS, multiLabel: false, maxLength: 512 } });
    expect(imp.manifest.signature.value).toMatch(/^local:v1:/);
    expect(imp.log.map((l: { title: string }) => l.title)).toEqual(expect.arrayContaining(['Loaded on the classifier worker', 'Registered', 'Draft classifier created']));
    // The draft classifier: the model's labels, the imported engine.
    expect(imp.result).toMatchObject({ model: { name: 'intent-classifier:classifier', digest }, labels: LABELS, classifier: { name: 'Banking intent', slug: 'banking-intent', evalSet: 'banking-intent-eval' } });
    classifierId = imp.result.classifier.id;
    const cls = (await a.agent.get(`/api/admin/classifiers/${classifierId}`).expect(200)).body;
    expect(cls).toMatchObject({ engine: 'imported', status: 'draft', model: 'intent-classifier:classifier', multiLabel: false, metrics: null });
    expect(cls.labels.map((l: { label: string }) => l.label)).toEqual(LABELS);
    expect(await h.s.db('audit_events').where({ action: 'classifier.created' }).first()).toBeDefined();
    // No pool pulls or holds it.
    expect((await send(a, 'post', `/api/admin/models/${modelId}/pull`, { poolId: '0'.repeat(26) })).status).toBeGreaterThanOrEqual(404);
    const models = (await a.agent.get('/api/admin/classifier-models').expect(200)).body;
    expect(models.worker).toMatchObject({ available: true, labelCeiling: 'confidential' });
    expect(models.models).toEqual([expect.objectContaining({ name: 'intent-classifier:classifier', state: 'draft', labels: LABELS, import: imp.ref })]);
  });

  it('an imported eval set shows precision and recall per label on the draft classifier', async () => {
    const res = await send(a, 'post', '/api/imports/datasets', { repositoryId: hubId, item: 'acme/intents', target: 'classifiers', label: 'internal', classifier: { classifierId, textColumn: 'text', labelColumn: 'label' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await drain(h);
    const imp = (await a.agent.get(`/api/imports/${res.body.id}`).expect(200)).body;
    expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
    expect(imp.result.classifier).toMatchObject({ created: false, engine: 'imported', cases: 510 });
    const cls = (await a.agent.get(`/api/admin/classifiers/${classifierId}`).expect(200)).body;
    expect(cls.metrics).toMatchObject({ samples: 510, heldOut: false, errors: 0 });
    // The fake scores by keyword and every row says its label's word, so the worker's scores make each rate 1.
    expect(cls.metrics.perLabel.card_arrival).toMatchObject({ n: 170, tp: 170, precision: 1, recall: 1 });
    expect(cls.metrics.perLabel.refund).toMatchObject({ n: 170, tp: 170, precision: 1, recall: 1 });
    expect(cls.metrics.perLabel.top_up).toMatchObject({ n: 170, tp: 170, precision: 1, recall: 1 });
    // Every text went to the worker for the pinned model.
    expect(worker.calls.filter((c) => c.path === '/v1/classify').length).toBeGreaterThanOrEqual(510);
  });

  it('publishes only with enough samples, a fresh evaluation and an approved model', async () => {
    const tenantId = h.tenantId;
    await send(a, 'post', `/api/admin/classifiers/${classifierId}/publish`).expect(409); // 170 samples a label
    await h.s.guard.classifiers.addCases(tenantId, 'banking-intent-eval', LABELS.flatMap((l, i) => Array.from({ length: 30 }, (_, n) => ({ text: `${['my card', 'a refund', 'top up'][i]} please ${n}`, expected: l }))), null);
    await send(a, 'post', `/api/admin/classifiers/${classifierId}/evaluate`).expect(202);
    await drain(h);
    const draft = await send(a, 'post', `/api/admin/classifiers/${classifierId}/publish`).expect(409);
    expect(draft.body.detail).toMatch(/intent-classifier:classifier is draft.*approved model/);
    // The model's own evaluation is the worker's digest check and a smoke test; approval is dual control.
    await send(a, 'post', `/api/admin/models/${modelId}/lifecycle`, { to: 'approved' }).expect(409);
    await send(a, 'post', `/api/admin/models/${modelId}/evaluate`).expect(202);
    await drain(h);
    const evaluated = (await h.s.gateway.repo.model(modelId))!;
    expect(evaluated.state).toBe('evaluated');
    expect(evaluated.evaluation).toMatchObject({ instance: 'classifier worker', passed: 2, total: 2 });
    expect(evaluated.evaluation!.tests.map((t) => t.name)).toEqual(['Digest check', 'Classification smoke test']);
    await send(a, 'post', `/api/admin/models/${modelId}/lifecycle`, { to: 'approved' }).expect(403); // the requester
    await send(b, 'post', `/api/admin/models/${modelId}/lifecycle`, { to: 'approved' }).expect(200);
    const published = (await send(a, 'post', `/api/admin/classifiers/${classifierId}/publish`).expect(200)).body;
    expect(published.status).toBe('published');
  });

  it('scores text through the worker within the model\'s label and the worker\'s ceiling', async () => {
    const out = (await send(a, 'post', '/api/classify', { classifier: 'banking-intent', text: 'I want my money back for this order', label: 'internal' }).expect(200)).body;
    expect(out).toMatchObject({ engine: 'imported', top: { label: 'refund', score: 0.9 }, hits: ['refund'] });
    // The model is approved for internal data: confidential text is not sent to it.
    const above = await send(a, 'post', '/api/classify', { classifier: 'banking-intent', text: 'refund', label: 'confidential' }).expect(503);
    expect(above.body.detail).toMatch(/approved for data up to internal/);
    const sent = worker.calls.filter((c) => c.path === '/v1/classify').length;
    await send(a, 'post', '/api/classify', { classifier: 'banking-intent', text: 'refund', label: 'restricted' }).expect(503);
    expect(worker.calls.filter((c) => c.path === '/v1/classify')).toHaveLength(sent);
    // A worker error is an unavailable classifier, not a verdict.
    worker.failNext = 500;
    const down = await send(a, 'post', '/api/classify', { classifier: 'banking-intent', text: 'refund', label: 'internal' }).expect(503);
    expect(down.body.detail).toMatch(/out of memory/);
  });

  it('pushes the verified files again when the worker no longer holds the model', async () => {
    worker.forget();
    const puts = worker.calls.filter((c) => c.method === 'PUT').length;
    const out = (await send(a, 'post', '/api/classify', { classifier: 'banking-intent', text: 'Where is my card', label: 'internal' }).expect(200)).body;
    expect(out.top).toMatchObject({ label: 'card_arrival' });
    expect(worker.calls.filter((c) => c.method === 'PUT').length - puts).toBe(4);
    // A blob that changed since the import is not what the catalogue pinned: the worker refuses it and nothing is scored.
    worker.forget();
    const weights = hub.repos.get('acme/intent-classifier')!.files.find((f) => f.name === 'model.safetensors')!.bytes;
    const key = `imports/blobs/sha256/${sha256(weights)}`;
    const tampered = Buffer.from(weights);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    await h.s.blobs.put(key, tampered, 'application/octet-stream');
    const bad = await send(a, 'post', '/api/classify', { classifier: 'banking-intent', text: 'Where is my card', label: 'internal' }).expect(503);
    expect(bad.body.detail).toMatch(/does not match its sha256/);
    await h.s.blobs.put(key, weights, 'application/octet-stream');
    await send(a, 'post', '/api/classify', { classifier: 'banking-intent', text: 'Where is my card', label: 'internal' }).expect(200);
  });

  it('refuses a regression head with nothing registered, and makes no classifier for someone who may not manage them', async () => {
    const reg = await requested(a, { repositoryId: hubId, item: 'acme/regressor' });
    expect(reg).toMatchObject({ state: 'refused', error: expect.stringMatching(/regression head/), model: null });
    expect(await h.s.gateway.repo.modelByName('regressor:classifier')).toBeUndefined();
    const tox = await requested(m, { repositoryId: hubId, item: 'acme/toxicity', classifier: { name: 'Toxicity' } });
    expect(tox.state, JSON.stringify(tox.log)).toBe('complete');
    expect(tox.result).toMatchObject({ labels: ['toxic', 'insult'], multiLabel: true, classifier: null });
    expect(tox.log.find((l: { title: string }) => l.title === 'No classifier created').meta).toMatch(/classifiers:manage/);
    expect(await h.s.guard.classifiers.get(h.tenantId, 'toxicity')).toBeUndefined();
    // Someone who may creates it on the Classifiers screen, with some of the model's labels; a label it lacks is refused.
    await send(a, 'post', '/api/admin/classifiers', { name: 'Toxicity', engine: 'imported', model: 'toxicity:classifier', labels: ['toxic', 'threat'] }).expect(422);
    await send(a, 'post', '/api/admin/classifiers', { name: 'Toxicity', engine: 'imported', labels: ['toxic'] }).expect(422);
    await send(a, 'post', '/api/admin/classifiers', { name: 'Toxicity', engine: 'imported', model: 'no-such:classifier' }).expect(404);
    const made = (await send(a, 'post', '/api/admin/classifiers', { name: 'Toxicity', engine: 'imported', model: 'toxicity:classifier', labels: ['toxic'] }).expect(201)).body;
    expect(made).toMatchObject({ engine: 'imported', model: 'toxicity:classifier', multiLabel: true });
    // A draft classifier is tried on a draft model; each label is scored by itself.
    worker.keywords = { toxic: ['idiot'], insult: ['idiot', 'fool'] };
    const out = (await send(a, 'post', '/api/classify', { classifier: 'toxicity', text: 'you idiot', label: 'internal' }).expect(200)).body;
    expect(out.scores).toEqual({ toxic: 0.9 });
    // The other engines still need labels of their own and name no model.
    await send(a, 'post', '/api/admin/classifiers', { name: 'Empty', engine: 'linear', labels: [] }).expect(422);
    await send(a, 'post', '/api/admin/classifiers', { name: 'Wrong', engine: 'linear', labels: ['x'], model: 'toxicity:classifier' }).expect(422);
  });
});
