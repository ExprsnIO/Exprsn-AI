# Deploying Exprsn-AI

Exprsn-AI runs as one Node.js process per host (more behind a load balancer from Sprint 2, when the Socket.io Redis
adapter lands), in front of an application database and, from Sprint 3, Ollama nodes. TLS terminates in front of it.

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
| `DATA_KEY` (`_FILE`) | — | 32 bytes, base64; seals TOTP seeds at rest |
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

- **Health:** `/healthz` (process up), `/readyz` (database reachable and migrated; 503 while draining).
- **Metrics:** `/metrics` with `Authorization: Bearer $METRICS_TOKEN`.
- **Logs:** JSON on stdout; every line carries the request's trace id, which is also in every error response.
- **Shutdown:** SIGTERM stops accepting connections, closes sockets and the database, and exits within 25 s.
- **Audit:** `exprsn-ai audit:verify --tenant <slug>` exits 2 when the chain is broken.
- **Backups:** back up the application database. Sessions and lockout counters can be lost safely; the audit chain
  and users cannot.
