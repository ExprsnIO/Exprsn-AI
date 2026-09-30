# Deploying Exprsn-AI

Exprsn-AI runs as one Node.js process per host, or several behind a load balancer when Redis is configured (the
Socket.io adapter, the BullMQ job queue and the cross-instance bus all use it), in front of an application database,
a blob store and Ollama nodes. TLS terminates in front of it.

## Configuration

All settings are environment variables. Secrets may be given as `<NAME>_FILE` pointing at a file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:8080` | The address users open. Its origin is the only one allowed for state changes and sockets; its host is the WebAuthn relying party |
| `NODE_ENV` | `development` | `production` requires an `https://` `PUBLIC_URL` (or `COOKIE_SECURE=true`) and refuses insecure LDAP |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | Listen address |
| `TRUST_PROXY` | `loopback` | Express trust-proxy setting for the TLS proxy (`loopback`, `uniquelocal`, an address, or a hop count) |
| `DB_CLIENT` | `sqlite` | `pg`, `mysql` or `sqlite` |
| `DATABASE_URL` (`_FILE`) | — | Required for `pg` and `mysql` |
| `SQLITE_FILENAME` | `./data/exprsn-ai.sqlite` | For `sqlite` |
| `DB_MIGRATE_ON_START` | `true` | Otherwise run `exprsn-ai migrate` before starting |
| `SESSION_SECRET` (`_FILE`) | — | 32+ random bytes; keys session, CSRF and API-key digests |
| `DATA_KEY` (`_FILE`) | — | 32 bytes, base64; the local KMS master key that wraps each tenant's data key. Required with `KMS_PROVIDER=local` |
| `KMS_PROVIDER` | `local` | `local` or `openbao` (OpenBao or Vault transit) |
| `OPENBAO_ADDR`, `OPENBAO_TOKEN` (`_FILE`), `OPENBAO_TRANSIT_MOUNT`, `OPENBAO_KEY_PREFIX`, `OPENBAO_CA_FILE` | —, —, `transit`, `exprsn-`, — | Transit engine address and token; one key per tenant (`exprsn-tenant-<id>`), one for audit checkpoints. The token needs create, encrypt, decrypt, hmac, verify, update-config and delete on those keys |
| (OpenBao signing, Sprint 14) | — | With `KMS_PROVIDER=openbao` the OIDC (ES256, `ecdsa-p256`) and SAML (RS256, `rsa-2048`) signing keys are created in transit as `<OPENBAO_KEY_PREFIX>fed-<kid>` and every token, assertion and logout message is signed there (`sign/<key>/sha2-256`), so no private signing key enters the process. The token also needs create, read and sign on those keys. The SAML SP decryption key stays sealed locally |
| `DPOP_PROOF_MAX_AGE_SECONDS` | `60` | How old a DPoP proof (RFC 9449) may be; its `jti` is remembered that long (in the database, shared by all instances) so it cannot be replayed. The API checks the proof's `htu` against `PUBLIC_URL` |
| `BLOB_STORE` | `fs` | `fs` or `s3` (MinIO, Ceph, SeaweedFS, AWS) |
| `BLOB_DIR` | `./data/blobs` | For `fs` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (`_FILE`), `S3_FORCE_PATH_STYLE` | —, `us-east-1`, —, —, —, `true` | For `s3` |
| `REDIS_URL` (`_FILE`) | — | Enables BullMQ, the Socket.io Redis adapter and the cross-instance bus: required to run more than one instance |
| `JOB_QUEUE` | `auto` | `db` (database polling), `bullmq`, or `auto` (BullMQ when `REDIS_URL` is set) |
| `JOB_POLL_MS`, `JOB_CONCURRENCY`, `WORKERS_ENABLED` | `1000`, `4`, `true` | Job workers on this instance; set `WORKERS_ENABLED=false` for web-only instances |
| `SMTP_URL` (`_FILE`), `SMTP_FROM` | — | Notification email (`smtp://` or `smtps://`); without it notifications reach the console only |
| `SIEM_URL`, `SIEM_TOKEN` (`_FILE`) | — | Audit events are POSTed there as NDJSON batches (Splunk HEC raw, Elastic, Vector, Fluent Bit, Logstash) |
| `DIRECTORY_SYNC_MINUTES`, `AUDIT_CHECKPOINT_MINUTES` | `60`, `60` | Directory sync and signed audit checkpoints per tenant (0 turns off) |
| `OLLAMA_POLL_MS`, `OLLAMA_TIMEOUT_MS` | `5000`, `4000` | Instance polling (`/api/version`, `/api/ps`, `/api/tags`) |
| `OLLAMA_MAX_INFLIGHT`, `OLLAMA_QUEUE_TIMEOUT_MS` | `4`, `120000` | Default parallel requests per instance (instances may set their own) and how long a request waits for a slot |
| `OLLAMA_MAX_LOADS_PER_10_MIN` | `6` | Anti-thrash limit per instance |
| `ATTACHMENT_MAX_BYTES` | `10485760` | Largest chat attachment |
| `CLAMD_HOST`, `CLAMD_PORT` | —, `3310` | ClamAV daemon for attachment scanning; without it attachments get the type check and classifier only |
| `MCP_ALLOWED_HOSTS` | — | MCP servers must resolve to internal addresses; this comma-separated list of hostnames (`*.example.com`) and CIDR networks allows others |
| `IDENTITY_ALLOWED_HOSTS` | — | The same for LDAP directories and SQL user-store databases, checked before every connection |
| `CONNECTIONS_ALLOWED_HOSTS` | — | The same for data connections (PostgreSQL, OpenSearch); PostgreSQL dials the checked address, OpenSearch never follows redirects |
| `SECRET_REF_ENV` | — | Environment variables user stores and upstream IdPs may reference as `env:NAME`: names or `PREFIX*` patterns, comma-separated. Empty means none. The server's own settings (and their `_FILE` forms) are refused whatever this says |
| `SECRET_REF_DIRS` | `/run/secrets,/run/credentials,/etc/exprsn-ai/credentials` | Directories `file:` references must resolve inside (symlinks followed); the server's own secret files are refused |
| `MCP_TIMEOUT_MS`, `MCP_POLL_MINUTES` | `15000`, `15` | MCP request timeout; how often every server's tools are re-listed and re-hashed (0 turns off) |
| `SCRIPT_RUNNER` | `auto` | Script sandbox: `docker` or `podman` CLI (`auto` uses whichever answers), or `none` to refuse script runs. The server's user must be allowed to run containers (rootless Podman is recommended) |
| `SCRIPT_IMAGE_PYTHON`, `SCRIPT_IMAGE_NODE` | `python:3.13-slim`, `node:22-slim` | Images for Python and JavaScript scripts; pin digests and mirror them internally, as nothing is pulled from outside at run time in an air-gapped install |
| `WORKFLOW_HTTP_HOSTS`, `WORKFLOW_HTTP_ALLOW_LOOPBACK` | —, `false` | Workflow HTTP steps call private addresses only; this comma-separated host list narrows them further |
| `MEDIA_FFMPEG`, `MEDIA_FFPROBE`, `MEDIA_ENCODER` | `ffmpeg`, `ffprobe`, `auto` | Media worker binaries; `auto` uses NVENC when the GPU offers it, else the CPU (`nvenc`, `cpu` force one) |
| `MEDIA_MAX_BYTES`, `MEDIA_MAX_DURATION_S`, `MEDIA_MAX_WIDTH`, `MEDIA_MAX_HEIGHT`, `MEDIA_MAX_STREAMS` | 512 MiB, `7200`, `1920`, `1080`, `4` | Caps checked by ffprobe before any processing |
| `MEDIA_WHISPER_BIN`, `MEDIA_WHISPER_MODEL`, `MEDIA_WORK_DIR` | — | whisper.cpp for transcripts (without it the transcribe preset is unavailable); scratch directory for media jobs |
| `IMAGE_BACKENDS` | `[]` | Image workers as JSON: `[{id, kind: comfyui\|diffusers, url, label?, model?, workflow?, concurrency?}]` |
| `IMAGE_SAFETY_URL`, `IMAGE_SAFETY_THRESHOLD` | —, `0.5` | Image-safety classifier for generated images and video frames; without it images are marked "not classified" |
| `OPENAI_STREAM_MODE` | `checked` | The OpenAI-compatible API at `/v1`: `checked` streams an answer after the output guardrail has passed it; `live` streams tokens as they are generated (a later block can only end the stream with `finish_reason: content_filter`) |
| `WEBHOOK_ALLOWED_HOSTS` | — | Webhook endpoints must resolve to internal addresses; this comma list (hosts, `*.domain`, CIDRs) allows others. Tenants can narrow further on the Tenants screen |
| `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETRY_BASE_MS` | `10000`, `6`, `30000` | Per-attempt timeout; attempts per delivery; first retry delay, doubling each attempt (capped at six hours) |
| `WEBHOOK_BREAKER_THRESHOLD`, `WEBHOOK_BREAKER_COOLDOWN_MS` | `5`, `300000` | Consecutive failed attempts that open an endpoint's circuit breaker, and how long it stays open before a trial delivery |
| `BILLING_PROVIDER` | `none` | `stripe` lets a system admin push a finished month's statement as a Stripe invoice |
| `STRIPE_SECRET_KEY` (`_FILE`), `STRIPE_API_URL`, `STRIPE_DAYS_UNTIL_DUE` | —, `https://api.stripe.com`, `30` | Stripe restricted key (invoice items and invoices, write), API base (a mirror or proxy in air-gapped installs), invoice terms |
| `BILLING_CLOSE_MINUTES` | `360` | How often the scheduler closes last month's statements (0 turns off) |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | `30`, `12` | Session lifetime |
| `LOCKOUT_MAX_ATTEMPTS`, `LOCKOUT_WINDOW_MINUTES`, `LOCKOUT_DURATION_MINUTES` | `5`, `15`, `15` | Sign-in lockout |
| `STEPUP_WINDOW_SECONDS` | `300` | Creating API keys, removing a second factor and regenerating recovery codes need a password or factor check this recent (signing in counts) |
| `BREACHED_PASSWORDS` | `off` | Breached-password check for new local passwords: `hibp` (the k-anonymity range API: only the first five hex characters of the SHA-1 leave the server), `file` (a local list), `both`, or `off`. If a source cannot be reached the password is accepted and `password.breach_check.unavailable` is audited |
| `BREACHED_HIBP_URL`, `BREACHED_TIMEOUT_MS` | `https://api.pwnedpasswords.com`, `3000` | Range API base (`GET <url>/range/<prefix>`); point it at an internal mirror in air-gapped sites |
| `BREACHED_FILE` | — | Required for `file` and `both`: uppercase SHA-1 hashes, one per line, sorted, optionally followed by `:count` (the format of HIBP's "ordered by hash" download). Searched in place by binary search, never loaded into memory |
| `PASSWORD_RESET_MINUTES`, `PASSWORD_RESET_PER_HOUR` | `60`, `5` | Lifetime of emailed reset links; reset requests per hour per identifier and per account (four times that per client address). Needs `SMTP_URL` |
| `PASSWORD_INVITE_HOURS` | `72` | Lifetime of invitation links for local accounts created without a password |
| `DEFAULT_TENANT` | `default` | Tenant used when sign-in names none |
| `IDENTITY_CONFIG` | — | Path to the identity YAML ([identity.md](identity.md)) |
| `METRICS_TOKEN` (`_FILE`) | — | Bearer token for `/metrics`; without it `/metrics` is off in production |
| `LOG_LEVEL` | `info` | pino level |
| `CHAT_STREAM_LEASE_SECONDS`, `CHAT_RETENTION_SWEEP_MINUTES` | `30`, `60` | Sprint 12: a streaming answer whose instance has been silent this long is marked interrupted (the user can continue it); how often each tenant's conversation retention policy runs (0 turns it off). The stream catch-up buffer uses Redis when `REDIS_URL` is set, otherwise the database |

Generate secrets with `openssl rand -hex 32` (session) and `openssl rand -base64 32` (data key).

## Docker Compose

```sh
cd deploy/docker
./gen-secrets.sh                                   # writes secrets/*.txt, mode 600
cp ../config/identity.example.yaml identity.yaml   # edit: your OpenLDAP and SQL user stores
echo -n 'ldap-service-password' > secrets/ldap_bind_password.txt
PUBLIC_URL=https://ai.example.internal docker compose up -d --build
docker compose exec app node server/dist/cli.js admin:create --username root --display-name "Platform admin"
```

The app container runs read-only as a non-root user with all capabilities dropped. PostgreSQL sits on an internal
network. `docker compose --profile inference up -d` adds Ollama on its own internal network; add `-f compose.gpu.yml`
for NVIDIA GPUs.

For development with every kind of user store and seed users (OpenLDAP, a PostgreSQL table, a MySQL table):

```sh
docker compose -f deploy/docker/compose.dev.yml up --build
```

and sign in at http://localhost:8080 as `mokafor` / `Northwind-Dev-Password-1` (system admin from the `ai-admins`
LDAP group; enrols TOTP at first sign-in), `jlee` / `Northwind-Dev-Password-2` (member), `apatel` /
`Northwind-Dev-Password-3` (PostgreSQL table) or `partner1` / `Northwind-Dev-Password-4` (MySQL table).

## Bare metal (systemd)

```sh
sudo deploy/baremetal/install.sh
sudoedit /etc/exprsn-ai/exprsn-ai.env /etc/exprsn-ai/identity.yaml /etc/exprsn-ai/credentials/database_url
sudo systemctl enable --now exprsn-ai
```

The installer builds from the checkout, installs to `/opt/exprsn-ai` (keeping the previous release as
`/opt/exprsn-ai.old`), creates the `exprsn-ai` system user, generates the session secret and data key as systemd
credentials, and installs a hardened unit (`ProtectSystem=strict`, no capabilities, system-call filter, only
`/var/lib/exprsn-ai` writable). If Node.js is not at `/usr/bin/node`, adjust `ExecStart`.

Put nginx or HAProxy in front for TLS and set `TRUST_PROXY` to its address. Forward WebSocket upgrades for
`/socket.io/`. Preparing Ollama GPU nodes: [deploy/baremetal/ollama-node.md](../deploy/baremetal/ollama-node.md).

## Kubernetes (Helm)

The chart in [deploy/helm/exprsn-ai](../deploy/helm/exprsn-ai/README.md) runs the application server as a Deployment
with a Service, an Ingress, a PodDisruptionBudget, an optional HorizontalPodAutoscaler and ServiceMonitor, and
NetworkPolicies that mirror the network zones. PostgreSQL or MySQL, Redis, the S3 store, OpenBao, the directory and the
Ollama nodes are external; Ollama instances are registered in the console as usual.

```sh
kubectl create namespace exprsn-ai
kubectl -n exprsn-ai create secret generic exprsn-ai \
  --from-literal=session_secret="$(openssl rand -hex 32)" --from-literal=data_key="$(openssl rand -base64 32)" \
  --from-literal=database_url='postgres://...' --from-literal=redis_url='redis://...' \
  --from-literal=s3_secret_access_key='...'
helm install exprsn-ai deploy/helm/exprsn-ai -n exprsn-ai -f my-values.yaml
kubectl -n exprsn-ai exec -it deploy/exprsn-ai -- node server/dist/cli.js admin:create --username root --display-name "Platform admin"
```

- Secrets are never values in the chart: each `secrets.<NAME>` entry names a key of an existing Secret, mounted as a
  file under `/run/secrets/` and read through `<NAME>_FILE`.
- Pods run as UID 1000 with a read-only root filesystem, no capabilities, no privilege escalation, the `RuntimeDefault`
  seccomp profile and no service-account token. Probes use `/healthz` (startup, liveness) and `/readyz` (readiness).
- Migrations run in an init container (`node server/dist/cli.js migrate`) or a pre-upgrade hook Job, and the chart sets
  `DB_MIGRATE_ON_START=false`.
- The chart refuses to render several replicas without `REDIS_URL`, SQLite, or a plain `http://` `PUBLIC_URL` in
  production.
- NetworkPolicies deny everything in and out of the pods except the ingress controller, DNS and the egress groups you
  fill in (data, directory, inference, sandbox, KMS, mail, SIEM). Nothing allows the internet.
- `SCRIPT_RUNNER` is `none` in the chart, since the pod has no container runtime; run script runners in the sandbox
  zone.

## Runbooks and load testing

- [Backup and restore](runbooks/backup-restore.md): database dumps per dialect, blob store, keys, restore order,
  verification with `exprsn-ai audit:verify`, restore drills.
- [Incident response](runbooks/incident-response.md): severity, first 15 minutes, revoking sessions and API keys,
  rotating `SESSION_SECRET` and data keys, disabling a tenant, audit forensics, guardrail emergency blocks, draining
  Ollama instances.
- [Upgrade and rollback](runbooks/upgrade.md): rolling upgrades, migrations, rollback, Ollama node upgrades.
- [Load test of the streaming path](loadtest.md): `server/loadtest/stream.ts` and the 1.0 targets.

## Operations

- **Health:** `/healthz` (process up), `/readyz` (database reachable and migrated, KMS and blob store answering; 503 while draining).
- **Metrics:** `/metrics` with `Authorization: Bearer $METRICS_TOKEN`.
- **Logs:** JSON on stdout; every line carries the request's trace id, which is also in every error response.
- **Shutdown:** SIGTERM stops accepting connections, closes sockets and the database, and exits within 25 s.
- **Audit:** `exprsn-ai audit:verify --tenant <slug>` checks the chain and its signed checkpoints and exits 2 when
  either is broken. Checkpoints are also written to the blob store under `audit-checkpoints/`.
- **Keys:** `exprsn-ai kms:rotate --tenant <slug>` starts a new data-key version; older values stay readable.
  Offboarding a tenant destroys its keys (crypto-shredding) and cannot be undone.
- **Backups:** back up the application database and the blob store together, and the KMS (OpenBao) or `DATA_KEY`
  separately from both: without the key, sealed conversations, attachments and exports cannot be read. Sessions,
  lockout counters and Redis can be lost safely; the audit chain and users cannot.
- **Several instances:** set `REDIS_URL` on every instance. Chat streams are served by the instance that runs them;
  stop requests, session revocations and notifications reach every instance through Redis.

## Platform operations

### Backups and restore drills

- The app backs up its own database into the blob store every `PLATFORM_BACKUP_MINUTES` (default a day; 0 turns it
  off), keeps the newest `PLATFORM_BACKUP_RETAIN` (14), and runs a restore drill every `PLATFORM_DRILL_MINUTES`
  (default a week) into a scratch SQLite file under `PLATFORM_DRILL_DIR` (default the OS temp dir; give it room for a
  copy of the database). Targets: `PLATFORM_BACKUP_RPO_MINUTES` (1 day) and `PLATFORM_BACKUP_RTO_MINUTES` (4 h).
- Each backup is encrypted with a key wrapped by the KMS key `<OPENBAO_KEY_PREFIX>platform-backups` and signed by
  it: keep `DATA_KEY` (local KMS) or the OpenBao transit keys backed up separately, and back up the blob store
  (`BLOB_DIR` or the S3 bucket) with the host's or the bucket's own replication. The Platform screen lists both as
  "not covered" and "external" so this stays visible.
- By hand: `exprsn-ai backup:create`, then `exprsn-ai backup:restore-drill [--backup <id>]` (exit code 2 on failure),
  for example from a systemd timer or before an upgrade.

### ACME certificates

- Set `ACME_DIRECTORY_URL` to the internal CA's ACME directory (https in production; `ACME_CA_FILE` for a private
  root), and optionally `ACME_CONTACT`. The CA validates http-01 by fetching
  `http://<name>/.well-known/acme-challenge/<token>` on port 80, so route port 80 for each certificate name to the
  app (the reverse proxy must pass `/.well-known/acme-challenge/` through without redirecting it to HTTPS or
  requiring authentication).
- Renewal runs every `ACME_CHECK_MINUTES` (6 h) and renews `ACME_RENEW_DAYS` (30) before expiry. Install renewed
  certificates with the deploy tooling: `GET /api/admin/platform/certificates/:id/chain` and the audited
  `POST …/key`.

### Import bundles

- `PLATFORM_TRIVY_BIN` (and `PLATFORM_TRIVY_CACHE_DIR` holding the offline vulnerability database) enables the scan;
  `PLATFORM_STAGING_URL` is an internal service that receives `{bundle, digest, contents, files}` and answers
  `{ok, detail}`. Mirror URLs, the staging hook and probes must resolve to internal addresses; `PLATFORM_ALLOWED_HOSTS`
  adds exceptions.
