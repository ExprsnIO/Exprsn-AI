# Classifier model fixture

`tiny-bert/` is a real sequence-classification model, small enough to keep here (about 90 kB): a two-layer BERT with
32 hidden units over a 27-word vocabulary and the labels `complaint` and `praise`, written as safetensors. It was made
by `services/classifier-worker/selftest.py --export <dir>` in the workspace this server runs in (random weights, then
200 training steps on thirty toy sentences), so it has no upstream and no licence of its own.

`server/test/integration/classifier-worker.test.ts` imports it from a fake hub and has a real classifier worker load
and run it (`TEST_CLASSIFIER_WORKER_URL`). The unit suite uses `server/test/fake-classifier-worker.ts` instead and
needs no Python.
