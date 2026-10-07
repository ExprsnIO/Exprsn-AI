# Training worker contract

The orchestrator (this server) drives a GPU training worker over HTTP: a Python service running Unsloth, Axolotl or
HF TRL/PEFT on CUDA, ROCm or MLX. `server/src/training/trainer.ts` is the orchestrator's side of the contract and
`server/test/fake-trainer.ts` is a fake worker that implements it for the tests and the console suite. This page is
the contract for whoever writes or maintains the Python worker.

The worker is configured with `TRAINER_URL` (and `TRAINER_TOKEN` when it expects a bearer token). Mutual TLS from the
orchestrator to the worker uses `TRAINER_CA_FILE`, `TRAINER_CERT_FILE` and `TRAINER_KEY_FILE`.

## Versions

| Version | Since | What changes |
| --- | --- | --- |
| 1 | 1.0.0 (Sprint 9) | `POST /v1/runs` carries the scrubbed dataset rows in plaintext; checkpoints and GGUF files stay in the worker's own store |
| 2 | 1.2.0 (Sprint 18) | The rows arrive encrypted with a run key the worker fetches once; checkpoints and GGUF files are uploaded to the platform, which seals them under the tenant key |

The worker says which version it speaks in `GET /v1/info` (`contract`, absent means 1). Version 2 only adds fields:
every version-1 request and answer keeps its shape. A worker that reports 1 is refused unless the operator sets
`TRAINER_PLAINTEXT_FALLBACK=true`; the job then waits with the reason "The training worker speaks contract 1".

## Endpoints the worker serves

All bodies are JSON. Errors are any non-2xx status with `{error}` or `{detail}`.

| Endpoint | Request | Answer |
| --- | --- | --- |
| `GET /v1/info` | — | `{contract: 2, container, trainers: [...], accelerators: [...], gpus: {total, free}}` |
| `POST /v1/runs` | v1: `{spec, data}`; v2: `{spec, contract: 2, sealed}` (below) | `{id}` |
| `GET /v1/runs/:id` | — | `{state: queued\|running\|checkpointed\|preempted\|succeeded\|failed\|cancelled, step, steps, epoch, loss, points: [{step, loss}], checkpoint: {step, ref, at} \| null, gpuMs, error, container}` |
| `POST /v1/runs/:id/checkpoint` | `{reason: pause\|preempt\|window\|quota\|duration}` | `{step, ref, at}`: writes a checkpoint at the current step, stops and releases the GPUs |
| `POST /v1/runs/:id/cancel` | `{}` | anything; stops after the current step and keeps the last checkpoint |
| `POST /v1/evals` | `{model, base, checkpoint, suite, hardware}` | `{score, base, passed, total}` |
| `POST /v1/convert` | `{job, name, checkpoint, baseModel, quantization}` | `{name, artifact, digest, sizeBytes, quantization, tool}`: the GGUF pushed to the registry the pools pull from (and, in v2, uploaded to the platform) |
| `POST /v1/convert` for an import (1.5.0, B-3803) | `{job, name, checkpoint, baseModel, quantization, source: {kind: import, repository, item, revision, files: [{name, artifact, sha256, bytes, format}], artifacts: {url, token, expiresAt}}}` | As above. The worker reads each staged file with `GET <artifacts.url>/<artifact>` (the grant's bearer), checks its `sha256`, converts the safetensors (or, with `quantization: as-is`, packages the published GGUF unchanged), pushes the model where the pools pull from and may upload the GGUF with `PUT <artifacts.url>/<name>?kind=gguf`. `digest` is what the pools will report for the pushed model; the platform pins it on the draft |

`spec` is `{job, name, baseModel, baseDigest, method, trainer, hardware, steps, checkpointEvery, dataset: {id, name,
version, hash, rows, splits}, resumeFrom: {step, ref, at} | null}`. A run resumes from `resumeFrom` when it is set.

## Version 2: sealed rows

`sealed` in the submit request:

```json
{
  "contract": 2,
  "cipher": "aes-256-gcm",
  "iv": "<base64, 12 bytes>",
  "tag": "<base64, 16 bytes>",
  "ciphertext": "<base64>",
  "aad": "exprsn-train:<job>:<grant>",
  "sha256": "<hex of the plaintext>",
  "rows": 1200,
  "key": { "url": "https://ai.corp.internal/trainer/v1/keys/<grant>", "token": "<bearer>", "expiresAt": 1759300000000 },
  "artifacts": { "url": "https://ai.corp.internal/trainer/v1/artifacts/<grant>", "token": "<bearer>", "expiresAt": 1759400000000 }
}
```

1. `POST key.url` with `Authorization: Bearer <key.token>` before `key.expiresAt` (`TRAINER_KEY_TTL_SECONDS`, 15
   minutes by default). The answer is `{key: <base64, 32 bytes>, cipher: "aes-256-gcm"}`. The key is released once:
   a second fetch answers `410`, a wrong token `401`, a missing client certificate `403`. Every release and refusal is
   audited.
2. Decrypt `ciphertext` with AES-256-GCM (`iv`, `tag`, `aad` as associated data) and check that the SHA-256 of the
   result is `sha256`. The plaintext is the scrubbed dataset as JSON Lines, as in version 1.
3. Keep the key and the rows in memory or on encrypted scratch for the run only, and clear them when it ends.

## Version 2: artefacts held by the platform

With `Authorization: Bearer <artifacts.token>` (valid for the run's maximum duration plus a day; a resubmit replaces
it):

| Call | Body | Answer |
| --- | --- | --- |
| `PUT <artifacts.url>/<name>?kind=checkpoint\|gguf\|other` | the file, streamed (`application/octet-stream`), up to `TRAINER_ARTIFACT_MAX_BYTES` | `201 {ref: "exprsn-artifact:<name>", name, sha256, bytes}` |
| `GET <artifacts.url>/<name>` | — | the file, streamed, with `X-Artifact-SHA256`; a body that fails authentication is cut off, never completed |

`<name>` is letters, digits, dots, dashes and underscores (up to 200). Uploading the same name again replaces it.
Report checkpoints with `ref: "exprsn-artifact:<name>"`; when a run resumes, `spec.resumeFrom.ref` carries that ref
and the worker reads the checkpoint back with `GET`. Convert uploads the GGUF with `kind=gguf` and may report
`artifact: "exprsn-artifact:<name>"`. The platform encrypts each artefact with its own AES-256-GCM key, sealed under
the tenant's data key, in its blob store (`training/<tenant>/jobs/<job>/artifacts/<name>`). The worker should delete
its local copies once the upload answers `201`.

## Transport

The worker reaches the platform at `TRAINER_CALLBACK_URL` (default `PUBLIC_URL`) under `/trainer/v1/`; these paths
take no session, only the grant tokens. When `TRAINER_CLIENT_CERT_SHA256` is set, the calls must also present the
worker's client certificate with that SHA-256 fingerprint: either on this server's own TLS socket, or through a
reverse proxy that terminates mTLS, verifies the certificate and forwards its fingerprint as `X-Client-Cert-SHA256`
(accepted only from addresses `TRUST_PROXY` trusts; the proxy must strip the header from other clients).
