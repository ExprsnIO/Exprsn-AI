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
| `DATA_KEY` (`_FILE`) | — | 32 bytes, base64; the local KMS master key that wraps each tenant's data key. Required with `KMS_PROVIDER=local` unless the signer runs (`SIGNER_SOCKET`). Since Sprint 20, production accepts it only as `DATA_KEY_FILE`, and not at all with the signer |
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
| `OLLAMA_LOAD_TIMEOUT_MS` | `300000` | How long chat and embeddings wait for Ollama's first response, including a cold model load; raise it for large models on slow storage |
| `ATTACHMENT_MAX_BYTES` | `10485760` | Largest chat attachment |
| `CLAMD_HOST`, `CLAMD_PORT` | —, `3310` | ClamAV daemon for attachment scanning; without it attachments get the type check and classifier only |
| `MCP_ALLOWED_HOSTS` | — | MCP servers must resolve to internal addresses; this comma-separated list of hostnames (`*.example.com`) and CIDR networks allows others |
| `IDENTITY_ALLOWED_HOSTS` | — | The same for LDAP directories and SQL user-store databases, checked before every connection |
| `CONNECTIONS_ALLOWED_HOSTS` | — | The same for data connections (PostgreSQL, MySQL, OpenSearch); PostgreSQL and MySQL dial the checked address, OpenSearch never follows redirects |
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
| `API_RATE_PER_MINUTE` | `600` | Requests a minute per user (or per address when signed out) across `/api`; shared across instances with Redis |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | `30`, `12` | Session lifetime |
| `LOCKOUT_MAX_ATTEMPTS`, `LOCKOUT_WINDOW_MINUTES`, `LOCKOUT_DURATION_MINUTES` | `5`, `15`, `15` | Sign-in lockout |
| `STEPUP_WINDOW_SECONDS` | `300` | Creating API keys, removing a second factor and regenerating recovery codes need a password or factor check this recent (signing in counts) |
| `BREACHED_PASSWORDS` | `off` | Breached-password check for new local passwords: `hibp` (the k-anonymity range API: only the first five hex characters of the SHA-1 leave the server), `file` (a local list), `both`, or `off`. If a source cannot be reached the password is accepted and `password.breach_check.unavailable` is audited |
| `BREACHED_HIBP_URL`, `BREACHED_TIMEOUT_MS` | `https://api.pwnedpasswords.com`, `3000` | Range API base (`GET <url>/range/<prefix>`); point it at an internal mirror in air-gapped sites |
| `BREACHED_FILE` | — | Required for `file` and `both`: uppercase SHA-1 hashes, one per line, sorted, optionally followed by `:count` (the format of HIBP's "ordered by hash" download). Searched in place by binary search, never loaded into memory |
| `PASSWORD_RESET_MINUTES`, `PASSWORD_RESET_PER_HOUR` | `60`, `5` | Lifetime of emailed reset links; reset requests per hour per identifier and per account (four times that per client address). Needs `SMTP_URL` |
| `PASSWORD_INVITE_HOURS` | `72` | Lifetime of invitation links for local accounts created without a password, and of `admin:create --enrol-link` links |
| `SIGNIN_NOTICES` | `true` | Security notice for a sign-in from a new browser (a signed, long-lived device cookie) or a new network (/24 or /48 of the client address; set the trusted proxy so it is the real one) |
| `DPOP_NONCES`, `DPOP_NONCE_SECONDS` | `false`, `300` | Require server-issued DPoP nonces (RFC 9449 section 8): a proof without the current `DPoP-Nonce` gets `use_dpop_nonce`. Turn on once your DPoP clients retry with the nonce |
| `API_PUBLIC_URL` | — | The public base of the API when a reverse proxy serves it under another origin or path prefix (for example `https://gw.example.internal/ai`); DPoP proofs for API calls must name `<API_PUBLIC_URL>/api/...` as `htu` |
| `FEDERATION_METADATA_REFRESH_HOURS` | `24` | How often SAML metadata registered by URL (service providers and upstream identity providers) is fetched again; a changed certificate or endpoint waits for an identity admin's approval |
| `DEFAULT_TENANT` | `default` | Tenant used when sign-in names none |
| `IDENTITY_CONFIG` | — | Path to the identity YAML ([identity.md](identity.md)) |
| `METRICS_TOKEN` (`_FILE`) | — | Bearer token for `/metrics`; without it `/metrics` is off in production |
| `LOG_LEVEL` | `info` | pino level |
| `CHAT_STREAM_LEASE_SECONDS`, `CHAT_RETENTION_SWEEP_MINUTES` | `30`, `60` | Sprint 12: a streaming answer whose instance has been silent this long is marked interrupted (the user can continue it); how often each tenant's conversation retention policy runs (0 turns it off). The stream catch-up buffer uses Redis when `REDIS_URL` is set, otherwise the database |
| `CHAT_GUARD_HOLDBACK_SENTENCES`, `CHAT_GUARD_STREAM_CONCURRENCY` | `1`, `16` | Sprint 16: the guard-model and classifier rules check streamed answers in the background. Hold-back is how many screened sentences may wait for a verdict before generation pauses (0 shows each sentence at once, so a verdict can only stop what follows); the concurrency caps background checks per instance (further checks queue, they never block the event loop) |
| `AGENT_SCHEDULE_TICK_SECONDS` | `60` | Sprint 21: how often due agent schedules are looked for; a scheduled run starts at most this long after its time (UTC cron, as the owner with their roles at that moment) |
| `SHARE_ANONYMOUS_PER_MINUTE` | `30` | Sprint 16: anonymous share links opened per client address per minute (anonymous links are off until a tenant admin allows them; set `TRUST_PROXY` correctly so the address is the client's) |
| `DATA_KEY_PREVIOUS` (`_FILE`), `KMS_PREVIOUS_PROVIDER` | — | Sprint 15: the previous key-encryption key while `kms:rewrap` runs (below). Reads fall back to it; nothing new is wrapped with it |
| `SIGNER_SOCKET`, `SIGNER_TOKEN` (`_FILE`), `SIGNER_TIMEOUT_MS` | —, —, `5000` | Sprint 20: the signer process's UNIX socket and the token it expects (production: `SIGNER_TOKEN_FILE` only). With `KMS_PROVIDER=local` the key-encryption key and the OIDC, SAML and webhook private keys then stay in the signer (below) |
| `HTTP_SIGNATURE_MAX_AGE_SECONDS` | `300` | Sprint 20: how far a `/v1` request's RFC 9421 `created` time may be from the server's clock |
| `PKI_PUBLIC_URL`, `PKI_CRL_MINUTES`, `PKI_CRL_VALIDITY_HOURS`, `PKI_OCSP_VALIDITY_MINUTES`, `PKI_OCSP_CACHE_SECONDS`, `PKI_OCSP_SIGNER_DAYS`, `PKI_PUBLIC_RATE_PER_MINUTE` | `PUBLIC_URL`, `60`, `24`, `60`, `300`, `30`, `600` | Sprint 24: the certificate authority. Its keys are made and used only in the signer (`SIGNER_SOCKET`) or OpenBao transit (`KMS_PROVIDER=openbao`). Issued certificates point at `PKI_PUBLIC_URL` for `/pki/crl/<issuer>.crl`, `/pki/ocsp` and `/pki/ca/<issuer>.crt`, which must be reachable by relying parties over plain HTTP or HTTPS (they are signed and need no session). CRLs are signed every `PKI_CRL_MINUTES` and after each revocation and are valid for `PKI_CRL_VALIDITY_HOURS` (which must be longer); OCSP answers are valid for `PKI_OCSP_VALIDITY_MINUTES` and cached per instance for `PKI_OCSP_CACHE_SECONDS`; delegated responder certificates last `PKI_OCSP_SIGNER_DAYS`; the public routes allow `PKI_PUBLIC_RATE_PER_MINUTE` requests per address |
| `NTP_SERVER`, `NTP_TIMEOUT_MS` | —, `2000` | Sprint 15: SNTP server (`host` or `host:port`) for the clock-skew check on the Platform screen |
| `MEDIA_ORIGIN`, `MEDIA_URL_TTL_SECONDS` | —, `300` | Sprint 15: a second host name for this deployment that serves media and images through signed short-lived URLs (point it at the same instances; it answers `/media-content/*` only) |
| `OPENBAO_DATABASE_MOUNT` | `database` | Sprint 15: OpenBao database secrets engine for dynamic data-connection credentials (uses `OPENBAO_ADDR` and `OPENBAO_TOKEN`; the token needs read on `<mount>/creds/<role>` and update on `sys/leases/renew` and `sys/leases/revoke`) |
| `PLATFORM_BUNDLE_REQUIRE_CHECKS` | `false` | Sprint 15: refuse to promote a bundle whose vulnerability scan or staging deploy did not run |
| `PLATFORM_BACKUP_BLOBS` | `true` | Sprint 15: backups also archive the blob store |
| `ACME_CHALLENGE`, `ACME_DNS_PROVIDER`, `ACME_DNS_WAIT_SECONDS` | `http-01`, `none`, `5` | Sprint 15: `dns-01` publishes TXT records through `webhook` or `rfc2136` |
| `ACME_DNS_WEBHOOK_URL`, `ACME_DNS_WEBHOOK_SECRET` (`_FILE`) | — | The signed DNS hook (below) |
| `ACME_DNS_RFC2136_SERVER`, `ACME_DNS_RFC2136_ZONE`, `ACME_DNS_TSIG_NAME`, `ACME_DNS_TSIG_SECRET` (`_FILE`), `ACME_DNS_TSIG_ALGORITHM` | —, —, —, —, `hmac-sha256` | RFC 2136 dynamic update: the zone's primary, the zone, and the TSIG key (secret in base64, as in a BIND key file) |
| `ACME_CERT_DIR` | — | Sprint 15: every instance writes issued and renewed certificates here as `<name>/fullchain.pem`, `cert.pem`, `chain.pem`, `privkey.pem` |
| `KNOWLEDGE_REPLICATION`, `KNOWLEDGE_REPLICATION_TICK_MS` | `on`, `10000` | Sprint 19: logical replication for PostgreSQL knowledge sources that ask for it (`off` keeps every source on watermarks); how often each worker instance claims and renews streams (a lease lasts three ticks). The database needs `wal_level=logical`, a publication for the table and an account with the REPLICATION attribute |
| `STRIPE_WEBHOOK_SECRET` (`_FILE`), `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | —, `300` | Sprint 19: the signing secret of the Stripe webhook endpoint pointed at `https://<host>/billing/stripe/webhook` (events `invoice.paid`, `invoice.payment_failed`, `invoice.voided`); unset, the route answers 404 |
| `IMAGE_SAFETY_REQUIRED` | `false` | Sprint 19: without an image-safety classifier, withhold generated images and sampled video frames instead of marking them "not classified" |
| `SCRIPT_RUNTIME` | — | Sprint 19: OCI runtime for script containers, e.g. `runsc` for gVisor (install it and register it with the engine, `docker info` must list it); runs are refused when the engine does not know it |
| `SERVICE_ALLOWED_HOSTS`, `SERVICE_INTERNAL_ONLY` | —, `false` | Sprint 18: pool instance, zone endpoint, image backend and trainer URLs may point at loopback, private and (unless `SERVICE_INTERNAL_ONLY`) public addresses, never at cloud metadata (169.254.169.254, fd00:ec2::254, 100.100.100.200, 192.0.0.192), link-local or unspecified ones. The list (hosts, `*.domain`, CIDRs) admits a link-local service network and, with `SERVICE_INTERNAL_ONLY`, public hosts; metadata addresses are never admitted. Names are checked when saved and again at every connection |
| `REQUIRE_BACKEND_TLS`, `BACKEND_TLS_EXEMPT` | `false`, — | Sprint 18: with `NODE_ENV=production`, refuse to start when a link to PostgreSQL (`sslmode=require`, `verify-ca` or `verify-full`), MySQL (an `ssl` parameter, e.g. `?ssl={"rejectUnauthorized":true}`), Redis (`rediss://`), S3 (`https://`) or OpenBao (`https://`) would be plaintext. SQLite is exempt. Exempt one link by name (`database`, `redis`, `s3`, `openbao`), for example a Redis sidecar on loopback or a mesh that adds mTLS |
| `ACME_EAB_KID`, `ACME_EAB_HMAC_KEY` (`_FILE`) | — | Sprint 18: external account binding for CAs that require it (the key id and base64url MAC key they issue); used when the ACME account is first created |
| `ACME_DNS_RFC2136_TRANSPORT` | `auto` | Sprint 18: `auto` sends updates over UDP and repeats them over TCP when the answer is truncated or UDP gets none; `udp` or `tcp` force one. `ACME_DNS_RFC2136_ZONE` may be left out: the zone is then the owner of the SOA record the server returns for `_acme-challenge.<name>` |
| `ACME_RELOAD_COMMANDS`, `ACME_HOOK_TIMEOUT_MS` | `{}`, `30000` | Sprint 18: reload commands certificates can name as push hooks, as JSON `{"name": ["/path", "arg"]}` (argument arrays, no shell; run on every instance after its sink writes the files, with `CERT_NAME`, `CERT_SERIAL`, `CERT_NOT_AFTER` and `CERT_DIR` set) |
| `TRAINER_CALLBACK_URL` | `PUBLIC_URL` | Sprint 18: the base URL the training worker calls back for run keys and artefacts (`/trainer/v1/...`, outside `/api`) |
| `TRAINER_PLAINTEXT_FALLBACK` | `false` | Sprint 18: let a worker on contract 1 receive dataset rows in plaintext; off, such a worker is refused and jobs wait saying so |
| `TRAINER_KEY_TTL_SECONDS`, `TRAINER_ARTIFACT_MAX_BYTES` | `900`, 64 GiB | Sprint 18: how long a run key waits to be fetched (once); the largest checkpoint or GGUF upload |
| `TRAINER_CLIENT_CERT_SHA256` | — | Sprint 18: SHA-256 fingerprint of the worker's client certificate; key and artefact calls must present it (on this server's TLS socket, or as `X-Client-Cert-SHA256` from a proxy that `TRUST_PROXY` trusts and that verified the certificate) |
| `TRAINER_CA_FILE`, `TRAINER_CERT_FILE`, `TRAINER_KEY_FILE` | — | Sprint 18: mutual TLS from the orchestrator to the worker |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | — | Sprint 22: OpenTelemetry tracing over OTLP/HTTP JSON. Spans go to `<endpoint>/v1/traces` (or the full traces URL); unset, nothing is traced. Requests, jobs, gateway calls, guardrail checks and database queries are spans of the request's W3C trace (the `X-Trace-Id`); no tenant content is recorded |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_SERVICE_NAME` | —, `10000`, `exprsn-ai` | Sprint 22: collector request headers (`name=value,…`, e.g. an API key), the export timeout (ms) and the `service.name` resource attribute |
| `OTEL_TRACES_SAMPLE_RATIO`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_SCHEDULE_DELAY` | `1`, `2048`, `5000` | Sprint 22: share of new traces recorded (a caller's sampled flag wins); spans held for export (more are dropped and counted); the export interval (ms) |
| `SCHEMA_CHECK_SECONDS` | `30` | Sprint 22: how often each instance compares its migrations with the database's; an instance older than the schema takes no jobs and is not ready (0: at start and on `/readyz` only) |
| `ZONES_APPLY` | `off` | Sprint 22: `kubernetes` applies each zone's rendered NetworkPolicy through the Kubernetes API (server-side apply) after every approved change and checks for drift. Needs a service account allowed to get, list, create and patch networkpolicies in the zone namespaces (the chart's `zonesApply`) |
| `ZONES_APPLY_API_URL`, `ZONES_APPLY_TOKEN_FILE`, `ZONES_APPLY_CA_FILE` | in-cluster | Sprint 22: the API server (default `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT`), the bearer token file (re-read on every call) and the CA, defaulting to the pod's service-account files |
| `ZONES_APPLY_FIELD_MANAGER`, `ZONES_APPLY_DRIFT_MINUTES` | `exprsn-ai`, `15` | Sprint 22: the server-side apply field manager; how often live policies are compared with what was applied (0: on request) |
| `NTP_SERVER`, `NTP_OUTLIER_MS` | —, `1000` | Sprint 22: `NTP_SERVER` takes a comma list; with three or more servers the clock skew is the median of those that agree, and a server further than `NTP_OUTLIER_MS` from the median is named as an outlier |
| `RATELIMIT_PROBE_SECONDS` | `15` | Sprint 22: how often each instance pings Redis, so the Platform warning and `exprsn_ratelimit_degraded` show that limits count per instance within a minute of Redis stopping |
| `KNOWLEDGE_ALLOWED_HOSTS`, `KNOWLEDGE_FETCH_TIMEOUT_MS` | —, `30000` | Sprint 23: knowledge sources that fetch over HTTP (a bucket on its own S3-compatible endpoint, an internal web site) reach internal addresses only, unless this list (hosts, `*.domain`, CIDRs) names them; link-local and cloud metadata addresses never. Every connection's address is checked when it is dialled. The timeout applies to each request |

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

With `--enrol-link` instead of a password, `admin:create` prints a single-use link (valid for `PASSWORD_INVITE_HOURS`)
that sets the password and then asks for the second factor before anything else, so the first admin is never
usable with a password alone. Hand the link over a trusted channel.

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
- Zones applied in-cluster (Sprint 22): `zonesApply.enabled` with `zonesApply.namespaces` (the zone namespaces, which
  must exist) creates in each a Role allowing get, list, create and patch on networkpolicies and binds it to the
  server's service account, mounts that account's token and sets `ZONES_APPLY=kubernetes`. Allow egress to the API
  server in `networkPolicy.egress.kubernetesApi`. Off by default: the pod then has no token.

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
- **Metrics:** `/metrics` with `Authorization: Bearer $METRICS_TOKEN`. Sprint 22 adds job, rate-limit, schema, zone
  drift, clock and trace-export series; Grafana dashboards and Prometheus alert rules for them are in
  [deploy/observability](../deploy/observability/README.md), each alert explained in
  [runbooks/alerts.md](runbooks/alerts.md).
- **Tracing (Sprint 22):** set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OpenTelemetry collector (or Tempo, Jaeger with
  OTLP/HTTP). A chat request is one trace: the HTTP span, guardrail checks, the gateway's Ollama calls (which receive
  the `traceparent`), database queries and the jobs it queued. Attributes are a fixed allow-list of metadata.
- **Upgrades (Sprint 22):** `exprsn-ai migrate --check` lists what `migrate` would apply and any destructive
  (contract) steps; an instance older than the database schema stops taking jobs and reports not ready
  ([upgrade.md](runbooks/upgrade.md)).
- **Key escrow (Sprint 22):** `exprsn-ai kms:escrow --shares 5 --threshold 3` splits `DATA_KEY` into Shamir shares
  and `kms:recover` rebuilds it ([backup-restore.md](runbooks/backup-restore.md#keys)).
- **Logs:** JSON on stdout; every line carries the request's trace id, which is also in every error response.
- **Shutdown:** SIGTERM stops accepting connections, closes sockets and the database, and exits within 25 s.
- **Audit:** `exprsn-ai audit:verify --tenant <slug>` checks the chain and its signed checkpoints and exits 2 when
  either is broken. Checkpoints are also written to the blob store under `audit-checkpoints/`.
- **Keys:** `exprsn-ai kms:rotate --tenant <slug>` starts a new data-key version; older values stay readable.
  Offboarding a tenant destroys its keys (crypto-shredding) and cannot be undone.
- **Changing the key-encryption key (Sprint 15):** to replace `DATA_KEY`, set the new value as `DATA_KEY` and the
  old one as `DATA_KEY_PREVIOUS` on every instance and restart them (reads fall back to the old key, new keys use the
  new one); then run `exprsn-ai kms:rewrap`. It re-wraps every data key, re-signs audit checkpoints and rewrites each
  backup's archive key and manifest, verifies that everything opens with the new key alone, and exits 2 if not; it is
  safe to run again. When it reports verified, remove `DATA_KEY_PREVIOUS`. To move from the local KMS to OpenBao, set
  `KMS_PROVIDER=openbao` with `KMS_PREVIOUS_PROVIDER=local` (the old `DATA_KEY` stays set, or goes in
  `DATA_KEY_PREVIOUS`); from OpenBao to local, `KMS_PROVIDER=local`, the new `DATA_KEY` and
  `KMS_PREVIOUS_PROVIDER=openbao` with `OPENBAO_ADDR` and `OPENBAO_TOKEN` still set.
- **The signer (Sprint 20):** `exprsn-ai signer` is a separate process that holds the local key-encryption key (what
  `DATA_KEY` was; the same value keeps every existing data key readable, no re-wrap needed) and every private key the
  app creates: OIDC (ES256), SAML (RS256), the SAML SP decryption key (RSA-OAEP) and webhook Ed25519 keys. It needs
  only `SIGNER_SOCKET`, `SIGNER_KEY_FILE` and `SIGNER_TOKEN_FILE` (both files mode 0600), plus `SIGNER_SOCKET_MODE=0660`
  when the app runs as another user in the socket directory's group. The app then sets `SIGNER_SOCKET` and
  `SIGNER_TOKEN_FILE` (the same token) and no `DATA_KEY`. Bare metal: `deploy/baremetal/exprsn-signer.service` (its
  header has the setup); Kubernetes: `signer.enabled` in the Helm chart runs it as a native sidecar with the key mounted
  into it alone. Existing federation and webhook keys sealed in the app are replaced by signer-held ones on first use
  (the old public keys stay published for the overlap window; SAML partners re-import the metadata). If the signer is
  down, everything that needs a key fails closed and `/readyz` reports the KMS unavailable.
- **Rate limits (Sprint 15):** with `REDIS_URL` set, the API limits, the failed-credential throttle and the denial
  cap are shared by all instances (one atomic Lua script per hit); if Redis stops answering they fall back to
  per-instance memory counters rather than letting requests through. Since Sprint 22 the Platform screen warns while that lasts.
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
  it: keep `DATA_KEY` (local KMS) or the OpenBao transit keys backed up separately. Since Sprint 15 the dump is
  streamed and each backup also archives the blob store (`PLATFORM_BACKUP_BLOBS`); the archives live in the blob
  store under `platform/backups/`, so copy that prefix somewhere else (another bucket, offline media) to survive the
  loss of the store itself.
- Restore (Sprint 15): stop every instance, point the configuration at an empty database (and blob store), then run
  `exprsn-ai backup:restore --backup <id>`, adding `--from <dir>` when the backup files are in a copy of the blob store
  rather than the configured one (a directory holding `platform/backups/<id>.*`). It migrates the schema, checks the
  manifest signature, authenticates both archives in a first pass, restores every row in one transaction (foreign
  keys checked at commit), then writes the blob objects. A database that already has tenants, users or audit events is
  refused; `--force --confirm "replace all data"` empties it first. Start the instances afterwards.
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
  `POST …/key`, or set `ACME_CERT_DIR` and let the reverse proxy read and reload the files each instance writes there.
- dns-01 (Sprint 15), for wildcards or names the CA cannot reach on port 80: `ACME_CHALLENGE=dns-01` and either
  `ACME_DNS_PROVIDER=rfc2136` (a TSIG key allowed to update `_acme-challenge` TXT records in the zone, for example BIND
  `update-policy { grant acme-update. wildcard *.corp.internal. TXT; };`) or `ACME_DNS_PROVIDER=webhook` (an internal
  hook that verifies `X-Exprsn-Signature` and updates your DNS; see `docs/api.md`).
- Sprint 18: a CA that requires external account binding gets it from `ACME_EAB_KID` and `ACME_EAB_HMAC_KEY`. RFC 2136
  updates fall back to TCP (the TSIG key must be allowed over TCP too) and can find the zone from the SOA record.
  Certificates can have push hooks (Platform screen, Certificates, Hooks): a reload command from `ACME_RELOAD_COMMANDS`
  runs on every instance after the new files are written, and a signed webhook tells deploy tooling on another host;
  its secret is shown once and verifies `X-Exprsn-Signature` exactly like the DNS hook.

### Import bundles

- `PLATFORM_BUNDLE_REQUIRE_CHECKS=true` makes the scan and the staging deploy mandatory. Signer keys are under dual
  control: after the first, a second platform admin approves every added or revoked key on the Platform screen.
- `PLATFORM_TRIVY_BIN` (and `PLATFORM_TRIVY_CACHE_DIR` holding the offline vulnerability database) enables the scan;
  `PLATFORM_STAGING_URL` is an internal service that receives `{bundle, digest, contents, files}` and answers
  `{ok, detail}`. Mirror URLs, the staging hook and probes must resolve to internal addresses; `PLATFORM_ALLOWED_HOSTS`
  adds exceptions.
- Sprint 18: an image, npm or PyPI mirror can have a push target (Platform screen, Mirrors, Push target): after each
  promotion the files go to Harbor (an OCI registry: give the project and a robot account; images must be OCI image
  layout tars), Verdaccio (a token) or devpi (the `user/index` and a user's password) through their HTTP APIs. The
  target must be an internal host (`PLATFORM_ALLOWED_HOSTS` for others); the secret is stored sealed. Every file's
  outcome is listed on the bundle, and a push can be repeated.

### Backups (Sprint 18)

- The dump now reads one snapshot for the whole database (repeatable read on PostgreSQL and MySQL; on SQLite a read
  transaction on a second connection, which needs the default WAL mode), and the blob archive holds exactly the
  objects the snapshot's rows name (plus `mirrors/` and `training/staging/`, which no row names). An object written
  during the backup, or one with no row, is left out.

### Training worker (Sprint 18)

- The worker speaks contract 2 ([training-worker.md](training-worker.md)): rows are sent encrypted and it fetches the run key
  once from `TRAINER_CALLBACK_URL`; checkpoints and GGUF files are uploaded back and sealed under the tenant key. Route
  `/trainer/v1/` from the training zone to the app, require the worker's client certificate at the proxy and set
  `TRAINER_CLIENT_CERT_SHA256`. A contract-1 worker is refused unless `TRAINER_PLAINTEXT_FALLBACK=true`.

### Knowledge sources (Sprint 23)

- **S3-compatible buckets.** A source can name its own endpoint (MinIO, Ceph, another account's S3) with an access key
  that is sealed with the tenant key; include patterns (`**/*.md`) narrow the prefix. Endpoints outside the internal
  network need `KNOWLEDGE_ALLOWED_HOSTS` (for AWS, e.g. `*.amazonaws.com`).
- **Internal web sites.** The crawler sends `User-Agent: ExprsnAI-Knowledge/1.0`, so a site can give it its own
  robots.txt group. It stays on the start page's scheme, host and port, follows robots.txt and the sitemap, and
  re-checks pages with `If-None-Match`/`If-Modified-Since`. A robots.txt that answers 5xx or not at all stops the crawl
  (the site is treated as closed); a missing one (4xx) allows everything.
- **Row security through PostgreSQL roles.** A PostgreSQL source can map directory groups to database roles; each
  sync reads the table once per role inside a read-only transaction under `SET LOCAL ROLE`, so the table's row
  security policies decide which group retrieves which row. The database owner sets it up once:

  ```sql
  ALTER TABLE notices ENABLE ROW LEVEL SECURITY;            -- FORCE as well if a mapped role owns the table
  CREATE ROLE kb_finance NOLOGIN;                            -- one role per group, never superuser or BYPASSRLS
  CREATE POLICY finance_rows ON notices FOR SELECT TO kb_finance USING (region IN ('finance', 'all'));
  GRANT SELECT ON notices TO kb_finance;
  -- The connection's login: a member of each mapped role, without inheriting it (PostgreSQL 16+), and SELECT on the
  -- table only so that schema introspection lists it; no policy names the login, so it reads no rows by itself.
  GRANT kb_finance TO exprsn_reader WITH INHERIT FALSE;
  GRANT SELECT ON notices TO exprsn_reader;
  ```

  The server refuses a mapping when the role does not exist, the login is not a member, the role is a superuser or
  has BYPASSRLS, the role may not select the table, the table does not enable row security (or a mapped role owns it
  without FORCE), or the object is a view that is not `security_invoker` (PostgreSQL 15+). With OpenBao dynamic
  credentials, put the `GRANT … TO "{{name}}" WITH INHERIT FALSE` in the role's creation statements. Role-mapped
  sources sync by full reads (up to 5000 rows per role) and cannot use logical replication, which bypasses policies.

### Webhooks and billing (Sprint 23)

- Ordered webhooks now take their positions from a counter row per endpoint (`webhook_order`) and send under a lease
  in that row, so several instances deliver one endpoint's events strictly in order, one at a time. A lease outlives a
  crashed holder by `WEBHOOK_TIMEOUT_MS` plus 30 seconds.
- Price book changes can take effect from an earlier moment of the current month; the month's statement is prorated
  by the prices in effect when each usage record was written. Subscribe the Stripe endpoint also to `charge.refunded`,
  `credit_note.created`, `credit_note.updated`, `credit_note.voided`, `charge.dispute.created`,
  `charge.dispute.updated` and `charge.dispute.closed` to reconcile refunds, credit notes and disputes.
