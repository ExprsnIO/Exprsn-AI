# Exprsn-AI

Self-hosted, multi-tenant control plane and chat interface for Ollama-served models.

**Status:** Sprints 0 to 4 are done: identity and access; tenancy, quotas, audit and platform services (KMS with
per-tenant keys, blob store, job queue, notifications, Redis fan-out, directory sync); the Ollama gateway (pools,
instances, the model catalogue with dual-control approval, profiles with canary and rollback); and chat and compare
with streaming, branches, attachments, exact calculation and metering. In the console, **Sign in**, **Settings**,
**User stores**, **Tenants**, **Usage and audit**, **Models**, **Pools**, **Profiles**, **Chat** and **Compare** are
live; the other screens show example data with a "Prototype data" banner until their sprint connects them. Next is
Sprint 5: guardrails, classifiers and flags. See [Sprints.md](Sprints.md).

## What's in the repository

| Path | Contents |
| --- | --- |
| [`server/`](server) | Node.js 22, TypeScript, Express 5 and Socket.io. Users sign in against a per-tenant chain of user stores (OpenLDAP, PostgreSQL / MySQL / SQLite user tables, local accounts), with TOTP, passkeys and recovery codes, role and clearance based access, API keys, and a per-tenant SHA-256 audit chain with signed checkpoints. It is the only component that talks to Ollama. The application database is PostgreSQL, MySQL or SQLite (Knex); Redis, OpenBao, S3 and SMTP are optional |
| [`web/`](web) | The user workspace and admin console, served by the server. Plain HTML, CSS and JavaScript with no build step and a strict CSP |
| [`design/prototype/`](design/prototype/README.md) | The clickable specification (27 screens, example data). Open `design/prototype/index.html` in a browser |
| [`deploy/`](deploy) | Dockerfile; Compose for production, development and GPU hosts; systemd unit and installer for bare metal; an example identity YAML |
| [`docs/`](docs) | [Plan and decisions](docs/PLAN.md), [API](docs/api.md), [identity](docs/identity.md), [deployment](docs/deploy.md), [security](docs/security.md) |

## Run it locally

Requires Node.js 22 or later.

```sh
npm ci
cp server/.env.example server/.env        # then fill in SESSION_SECRET and DATA_KEY as it describes
set -a; . server/.env; set +a
npm run cli -w server -- admin:create --username root --display-name "Platform admin"
npm run dev                                # http://localhost:8080
```

Sign in as `root`; the console asks you to set up an authenticator app first (admin roles require a second factor).
Add your OpenLDAP or SQL user store under **Admin → User stores**, map directory groups to roles, and use
**Test a login** to check it. Stores can also be declared in a YAML file named by `IDENTITY_CONFIG`
(see [deploy/config/identity.example.yaml](deploy/config/identity.example.yaml)).

Everything at once, with seeded OpenLDAP, PostgreSQL and MySQL user stores:

```sh
docker compose -f deploy/docker/compose.dev.yml up --build
```

The seed accounts and their development passwords are listed at the top of
[`deploy/docker/compose.dev.yml`](deploy/docker/compose.dev.yml) (`mokafor` is a system admin on OpenLDAP).

The `exprsn-ai` CLI (`npm run cli -w server -- <command>`, or `node server/dist/cli.js` in the image) has `migrate`,
`admin:create` and `audit:verify`.

For production (Docker Compose or bare-metal systemd, TLS, secrets as files, Ollama nodes) see
[docs/deploy.md](docs/deploy.md).

## Checks

```sh
npm run lint && npm run typecheck && npm test      # unit and API tests on in-memory SQLite
for f in web/js/app.js web/js/screens/*.js; do node --check "$f"; done
TEST_PG_URL=postgres://… TEST_MYSQL_URL=mysql://… TEST_LDAP_URL=ldap://… TEST_LDAP_INSECURE=true TEST_LDAP_BIND_PW=… \
  npm run test:integration -w server              # user stores against real servers
```

CI runs all of these, builds the container image and checks that it answers `/readyz`.

The prototype has its own Playwright smoke test: `cd design/prototype && node build.mjs && npm install && npm run smoke`.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
