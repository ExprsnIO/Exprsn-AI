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
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | `30`, `12` | Session lifetime |
| `LOCKOUT_MAX_ATTEMPTS`, `LOCKOUT_WINDOW_MINUTES`, `LOCKOUT_DURATION_MINUTES` | `5`, `15`, `15` | Sign-in lockout |
| `DEFAULT_TENANT` | `default` | Tenant used when sign-in names none |
| `IDENTITY_CONFIG` | — | Path to the identity YAML ([identity.md](identity.md)) |
| `METRICS_TOKEN` (`_FILE`) | — | Bearer token for `/metrics`; without it `/metrics` is off in production |
| `LOG_LEVEL` | `info` | pino level |

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
