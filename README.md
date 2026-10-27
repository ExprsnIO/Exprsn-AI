<div align="center">

# Exprsn AI

**A self-hosted, multi-tenant control plane and chat interface for your own models.**

[![Version](https://img.shields.io/badge/version-2.0.0%20%22GM%22-blue)](docs/release-2.0.0.md)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](server/tsconfig.json)
[![Licence](https://img.shields.io/badge/licence-Apache%202.0-lightgrey)](LICENSE)

[Quick start](#quick-start) · [Features](#features) · [Documentation](#documentation) · [Development](#development) · [Changelog](CHANGELOG.md)

</div>

---

Exprsn AI runs chat, agents, knowledge and tools on models you host (Ollama, Apple Foundation Models, MLX, llama.cpp
or any OpenAI-compatible server), for many tenants at once, with identity, guardrails and an audit trail built in.
Everything is served by one Node.js server with a web console and a native Apple app.

> **Current release:** `2.0.0` "GM" (2026-10-21). See the [release notes](docs/release-2.0.0.md) and, for work since
> then, the **Unreleased** section of the [changelog](CHANGELOG.md).

## Features

| Area | What you get |
| --- | --- |
| 💬 **Chat and models** | Streaming chat and side-by-side compare, branches, attachments, artifacts, sharing and export · an OpenAI-compatible API (`/v1`, Responses subset) · a gateway with pools, profiles, canaries and fallback across Ollama, MLX, llama.cpp, Apple and cloud model servers · evaluations, training and model import |
| 🛡️ **Safety and governance** | Guardrails at every checkpoint (rules, classifiers, a guard model, prompt-injection defence, DLP) · held answers and a review queue · moderation and appeals · AI inventory and legal hold · a tamper-evident audit chain with signed checkpoints · an [OWASP ASVS L2](docs/asvs.md) review |
| 🔐 **Identity and access** | Per-tenant user stores (OpenLDAP, SQL, local, upstream OIDC and SAML, SCIM) · TOTP and passkeys · roles, custom roles, clearance labels and network zones · its own OIDC provider and SAML IdP |
| 📚 **Knowledge and data** | Knowledge bases with hybrid search and reviewed, versioned references · a **Docs portal** that publishes knowledge bases as documentation sites · memory · data connections to SQL, document, search, key-value, queue and time-series engines, with a **Schema designer** to create, edit and drop objects · REST, GraphQL, SOAP and OData APIs |
| 🛠️ **Building** | Tool registry and MCP servers (and an MCP server of its own) · agents with schedules and handoffs · skills · sandboxed scripts · durable workflows and decision tables · low-code apps with charts, reports and dashboards · media processing and image generation with content credentials |
| 🏗️ **Platform** | Certificate authority with OCSP and ACME · secrets vault with leases and escrow · files with WebDAV, CalDAV and CardDAV · groups, events, channels, messaging and a feed · an AT-Protocol PDS · cloud deployments on AWS, Azure, DigitalOcean and Cloudflare with FinOps · backups and restore drills |
| 🖥️ **Clients** | A web console where every screen is live, with AA and AAA accessibility modes · a native [macOS, iPhone and iPad app](apple/README.md) |

## Quick start

You need **Node.js 22** or later.

```sh
npm ci
cp server/.env.example server/.env      # fill in SESSION_SECRET and DATA_KEY as the file describes
set -a; . server/.env; set +a
npm run cli -w server -- admin:create --username root --display-name "Platform admin"
npm run dev                              # → http://localhost:8080
```

1. Sign in as `root`. Admin roles need a second factor, so the console asks you to set up an authenticator app first.
2. Add your OpenLDAP or SQL user store under **Admin → User stores**, map directory groups to roles, and use
   **Test a login** to check it. Stores can also be declared in YAML: see
   [`identity.example.yaml`](deploy/config/identity.example.yaml).

### Everything at once with Docker

```sh
docker compose -f deploy/docker/compose.dev.yml up --build
```

This starts the server with seeded OpenLDAP, PostgreSQL and MySQL user stores. The seed accounts are listed at the top
of [`compose.dev.yml`](deploy/docker/compose.dev.yml) (`mokafor` is a system admin).

### In production

Docker Compose, Kubernetes (Helm) or bare-metal systemd, with TLS, file-based secrets and separate Ollama nodes: see
the [deployment guide](docs/deploy.md).

### The CLI

`npm run cli -w server -- <command>` (or `node server/dist/cli.js` in the image):

| Command | Does |
| --- | --- |
| `migrate` | Applies database migrations |
| `admin:create`, `tenant:create` | Creates the first administrator or a tenant |
| `audit:verify` | Checks the audit chain and its signed checkpoints |
| `kms:rotate`, `kms:rewrap`, `kms:escrow`, `kms:recover` | Rotates, re-wraps, escrows and recovers keys |
| `signer` | Runs the process that keeps private keys out of the application |
| `backup:create`, `backup:restore-drill`, `backup:restore` | Backs up and restores |

Run `npm run cli -w server -- --help` for the full list.

## Documentation

| Topic | Read |
| --- | --- |
| Release notes and upgrade | [2.0.0 release notes](docs/release-2.0.0.md) · [Changelog](CHANGELOG.md) · [Sprints](Sprints.md) |
| Design | [Plan and decisions](docs/PLAN.md) · [Screen contract](docs/screen-contract.md) |
| API | [API reference](docs/api.md) · [OpenAPI](docs/openapi.json) · [Permissions](docs/permissions.md) |
| Running it | [Deployment](docs/deploy.md) · [Cloud](docs/cloud.md) · [Runbooks](docs/runbooks/README.md) · [Load testing](docs/loadtest.md) |
| Identity and security | [Identity](docs/identity.md) · [Security model and known gaps](docs/security.md) · [ASVS assessment](docs/asvs.md) |
| Accessibility | [Accessibility modes and checks](docs/accessibility.md) |

## Repository layout

| Path | Contents |
| --- | --- |
| [`server/`](server) | The application server: Node.js 22, TypeScript, Express 5, Socket.io and Knex on PostgreSQL, MySQL or SQLite. The only component that talks to model servers. Redis, OpenBao, S3 and SMTP are optional |
| [`web/`](web) | The web console, served by the server: plain HTML, CSS and JavaScript, no build step, strict CSP |
| [`apple/`](apple/README.md) | The native macOS, iPhone and iPad client (SwiftUI, no dependencies) |
| [`deploy/`](deploy) | Dockerfile, Compose files, a Helm chart with NetworkPolicies, and a systemd unit and installer |
| [`e2e/`](e2e/README.md) | The Playwright suite that drives every console screen |
| [`interop/`](interop) | Runs the AT-Protocol PDS against the reference AppView |
| [`docs/`](docs) | Design, API, operations and security documentation |

## Development

```sh
npm run lint && npm run typecheck && npm test     # unit and API tests on in-memory SQLite
for f in web/js/*.js web/js/screens/*.js; do node --check "$f"; done    # console scripts must parse
```

Integration tests run against real servers when their variables are set:

```sh
TEST_PG_URL=postgres://… TEST_MYSQL_URL=mysql://… \
TEST_LDAP_URL=ldap://… TEST_LDAP_INSECURE=true TEST_LDAP_BIND_PW=… \
  npm run test:integration -w server

server/test/integration/greenmail.sh /tmp/greenmail   # the email channel's IMAP adapter against GreenMail
```

CI runs all of these, builds the container image and checks it answers `/readyz`. On `main` it also pushes, attests
and signs the image as `ghcr.io/exprsnio/exprsn-ai`.

New console screens follow the [screen contract](docs/screen-contract.md).

## About this repository

The history here starts from the 2.0.0 tree on 2026-10-27, and `main` is the only branch. Planning backlogs
(`Backlog-*.md`) are kept beside the code but not in git.

## Licence

[Apache License 2.0](LICENSE).
