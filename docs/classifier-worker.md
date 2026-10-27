# Classifier worker contract

Ollama serves no sequence-classification heads. A text-classification model imported from a repository (B-3806) is
therefore served by a classifier worker: a small service that loads safetensors weights with transformers and scores
text. This server pushes it the files an import pulled and verified, and calls it to score.
`server/src/guardrails/classifier-worker.ts` is the server's side of the contract and
`server/test/fake-classifier-worker.ts` is a fake worker that implements it for the unit tests. This page is the
contract for whoever writes or maintains a worker.

The worker is configured with `CLASSIFIER_WORKER_URL` (and `CLASSIFIER_WORKER_TOKEN`, or
`CLASSIFIER_WORKER_TOKEN_FILE`, when it expects a bearer token). `CLASSIFIER_WORKER_CA_FILE` is a CA bundle for its
TLS certificate. The address is checked like every operator service URL (`SERVICE_ALLOWED_HOSTS`,
`SERVICE_INTERNAL_ONLY`), as a literal when the server reads its configuration and again when each connection is made. Without
`CLASSIFIER_WORKER_URL`, text-classification models are refused at the import plan and an imported classifier cannot
score.

## What the worker must and must not do

- It fetches nothing. A model is the files this server sent it. A worker with network access to a model hub is
  outside the contract.
- It checks every file against the SHA-256 it was sent with, on arrival and again before each load, and it
  recomputes the model digest from those hashes. A file that does not match is not loaded.
- It loads safetensors weights only, from the model's own directory, and never runs code from a repository
  (`trust_remote_code` off). It refuses a pickle or zip file by its first bytes, whatever the file is called.
- It keeps no text. Texts are scored in memory and are not written to a log.

## The model digest

A model is named by one digest, which the model catalogue pins as the draft's expected digest:

```
sha256( for each file, sorted by name:  "<sha256 of the file, lower-case hex>  <name>\n" )
```

That is the output of `sha256sum` over the files, sorted by name, hashed again. The files are the safetensors
weights and the configuration and tokenizer files from the root of the repository (`config.json`, `tokenizer.json`,
`tokenizer_config.json`, `vocab.txt`, `special_tokens_map.json`, a SentencePiece `.model` and so on). File names
are one path segment: letters, digits, dot, dash and underscore, at most 200 characters.

## Endpoints the worker serves

Bodies are JSON unless noted. Errors are a non-2xx status with `{error}` or `{detail}`. In a path, `<digest>` is the
64 hex characters without the `sha256:` prefix.

| Endpoint | Request | Answer |
| --- | --- | --- |
| `GET /v1/info` | — | `{contract: 1, runtime, device, models: ["sha256:<hex>", …]}`: the models it holds complete and verified |
| `PUT /v1/models/<digest>/files/<name>` | The file's bytes (`application/octet-stream`), with `x-sha256: <hex>` and `content-length` | `{name, sha256, bytes}`. `422` when the bytes do not match the hash, the file is a pickle or zip by its contents, or the name is not model data |
| `POST /v1/models/<digest>/load` | `{files: [{name, sha256}]}`: every file of the model | `{labels: [...], multiLabel, maxLength, architecture, device}` once every file matches, the digest of the list is `<digest>` and the model is in memory. `404` with `{code: "missing", missing: [names]}` for files it does not hold or that no longer match. `422` when the list does not add up to the digest or the weights cannot be loaded as a sequence classifier |
| `POST /v1/classify` | `{model: "sha256:<hex>", texts: [...]}` (at most 256 texts) | `{results: [{scores: {<label>: 0..1}}]}`, one entry per text, in order, with a score for every label. `404` with `{code: "missing"}` when the model is not in memory |

`labels` are the model's own, in the order of `id2label` in its `config.json`. A model with `problem_type:
multi_label_classification` is scored with a sigmoid per label (`multiLabel: true`); any other with a softmax over
the labels. Text longer than `maxLength` tokens is truncated.

A `404` with `code: "missing"` is how the server learns the worker lost a model (a restart, a new machine, a cleared
directory). It pushes the named files again from the import's content-addressed blobs
(`imports/blobs/sha256/<hash>`), calls `load`, and repeats the call once. Any other error is reported to the caller
as it is: the classifier is unavailable, and a guardrail rule that uses it fails as a guard-model rule does when its
model is down.

## What the server sends, and when

1. **Import** (`imports.model` job, after every file is downloaded and its pin verified): `load`, then `PUT` for each
   file the worker reports missing, then `load` again. The labels the worker answers must be the ones read from
   `config.json`; the import is refused otherwise, and when the worker answers `422`. Only then is the draft model
   registered, with the digest as its expected digest.
2. **Model evaluation** (`model.evaluate` job): `load` (the "Digest check") and one `classify` call with a fixed
   sentence (the "Classification smoke test"). Both passing moves the draft to `evaluated`.
3. **Scoring** (`POST /api/classify`, a classifier's evaluation job, guardrail rules): one `classify` call per text.
   Text is sent only when the model's label covers the text's label and the text is within
   `CLASSIFIER_WORKER_LABEL_CEILING`. A published classifier scores only with an approved (or deprecated) model; a
   draft classifier may be measured on a draft model.

## The reference worker

The workspace this server is developed in runs `services/classifier-worker/worker.py` (FastAPI, transformers and
torch, on Metal or the CPU), started by `bin/exprsn start classifier` on `127.0.0.1:8199`. Its `selftest.py` builds a
tiny BERT classifier and drives every endpoint and refusal above without a network. That model is also the fixture
`server/test/fixtures/classifier/tiny-bert/`, which `server/test/integration/classifier-worker.test.ts` imports
through a fake hub into a real worker when `TEST_CLASSIFIER_WORKER_URL` is set.
