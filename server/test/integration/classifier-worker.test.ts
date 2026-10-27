/*
 * 1.7.0 (B-3806): imported classifier engines against a real classifier worker (docs/classifier-worker.md). The
 * block runs when its variable is set:
 *
 *   TEST_CLASSIFIER_WORKER_URL    the tiny BERT classifier in test/fixtures/classifier/tiny-bert is imported from a
 *   (+ TEST_CLASSIFIER_WORKER_TOKEN)  fake hub; the worker checks the files, loads the safetensors weights and answers
 *                                  the labels; the draft model is pinned by the digest; an eval set gives precision
 *                                  and recall per label from the model's own scores; the model's evaluation is the
 *                                  worker's digest check and smoke test; a file the worker lost is pushed again
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifierModelDigest } from '../../src/guardrails/classifier-worker.js';
import { harness, localUser, loginAdmin, type Client } from '../helpers.js';
import { drain } from '../retrieval-seed.js';
import { startFakeHub } from '../sprint30-imports-fakes.js';

const url = process.env.TEST_CLASSIFIER_WORKER_URL;
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/classifier/tiny-bert');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const send = (c: Client, method: 'post', u: string, body: unknown = {}) => c.agent[method](u).set('x-csrf-token', c.csrf).send(body as object);

describe.skipIf(!url)('an imported classifier model on a real classifier worker', () => {
  it('imports, loads, evaluates and scores the tiny BERT fixture', async () => {
    const token = process.env.TEST_CLASSIFIER_WORKER_TOKEN;
    const hub = await startFakeHub();
    const h = await harness({ IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0', IMPORT_REFRESH_TICK_MINUTES: '0', OLLAMA_POLL_MS: '600000', CLASSIFIER_WORKER_URL: url!, ...(token ? { CLASSIFIER_WORKER_TOKEN: token } : {}) });
    try {
      await localUser(h, 'cwa', ['model-admin', 'guardrail-admin'], 'restricted');
      await localUser(h, 'cwb', ['model-admin'], 'restricted');
      const [a, b] = [await loginAdmin(h, 'cwa'), await loginAdmin(h, 'cwb')];
      const files = readdirSync(dir).sort().map((name) => ({ name, bytes: readFileSync(path.join(dir, name)) }));
      hub.repos.set('acme/tiny-bert', { id: 'acme/tiny-bert', sha: sha256('acme/tiny-bert').slice(0, 40), licence: 'apache-2.0', pipeline: 'text-classification', gated: false, downloads: 1, library: 'transformers', files: files.map((f) => ({ ...f, lfs: f.name.endsWith('.safetensors') })) });
      const repo = await send(a, 'post', '/api/imports/repositories', { name: 'Hub (fake)', type: 'hf', baseUrl: hub.url, region: 'Global', kinds: ['model'] }).expect(201);
      await send(b, 'post', `/api/imports/repositories/${repo.body.id}/confirm`).expect(200);
      await drain(h);
      const req = await send(a, 'post', '/api/imports', { repositoryId: repo.body.id, item: 'acme/tiny-bert', label: 'internal', classifier: { name: 'Tone' } }).expect(201);
      await drain(h);
      const imp = (await a.agent.get(`/api/imports/${req.body.id}`).expect(200)).body;
      expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
      const digest = classifierModelDigest(files.map((f) => ({ name: f.name, sha256: sha256(f.bytes) })));
      expect(imp.model).toMatchObject({ name: 'tiny-bert:classifier', state: 'draft', expectedDigest: digest });
      expect(imp.manifest.classifier).toMatchObject({ digest, labels: ['complaint', 'praise'], multiLabel: false, architecture: 'BertForSequenceClassification', maxLength: 32 });
      const info = await h.s.classifierWorker.info();
      expect(info.models).toContain(digest);
      // The model's own scores on labelled sentences: words it was trained on, in sentences it never saw.
      const cases = [
        ...['terrible late delivery', 'the order was broken', 'wrong product refund', 'this app is terrible', 'late support very late', 'broken app'].map((text) => ({ text, expected: 'complaint' })),
        ...['love this great app', 'thanks very fast support', 'perfect delivery', 'the service was great', 'fast order thanks', 'love the product'].map((text) => ({ text, expected: 'praise' }))
      ];
      await send(a, 'post', `/api/admin/classifiers/${imp.result.classifier.id}/samples`, { items: cases }).expect(201);
      await send(a, 'post', `/api/admin/classifiers/${imp.result.classifier.id}/evaluate`).expect(202);
      await drain(h);
      const cls = (await a.agent.get(`/api/admin/classifiers/${imp.result.classifier.id}`).expect(200)).body;
      expect(cls.metrics).toMatchObject({ samples: 12, errors: 0 });
      // A toy model: it gets most of them, and what it gets wrong shows in the rates (one label's false positives
      // are the other's misses).
      const { complaint, praise } = cls.metrics.perLabel as Record<string, { n: number; tp: number; fp: number; fn: number; precision: number; recall: number }>;
      expect([complaint!.n, praise!.n]).toEqual([6, 6]);
      expect(complaint!.tp + praise!.tp).toBeGreaterThanOrEqual(10);
      expect(complaint!.fp).toBe(praise!.fn);
      expect(praise!.fp).toBe(complaint!.fn);
      expect(complaint!.precision).toBeCloseTo(complaint!.tp / (complaint!.tp + complaint!.fp), 3);
      expect(praise!.recall).toBeCloseTo(praise!.tp / 6, 3);
      // The conformance run of the model, then a score from the draft classifier.
      await send(a, 'post', `/api/admin/models/${imp.model.id}/evaluate`).expect(202);
      await drain(h);
      const model = (await h.s.gateway.repo.model(imp.model.id))!;
      expect(model.evaluation!.tests.map((t) => [t.name, t.ok])).toEqual([['Digest check', true], ['Classification smoke test', true]]);
      expect(model.state).toBe('evaluated');
      const out = (await send(a, 'post', '/api/classify', { classifier: 'tone', text: 'thanks, great service', label: 'internal' }).expect(200)).body;
      expect(out.top.label).toBe('praise');
      expect(out.scores.praise + out.scores.complaint).toBeCloseTo(1, 3);
    } finally {
      await h.close();
      await hub.close();
    }
  });
});
