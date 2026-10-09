# Exprsn-AI

Self-hosted, multi-tenant control plane and chat interface for Ollama-served models.

**Status:** version `1.6.0`. Sprints 0 to 9 are done: identity and access; tenancy, quotas, audit
and platform services (KMS with per-tenant keys, blob store, job queue, notifications, Redis fan-out, directory sync);
the Ollama gateway (pools, instances, the model catalogue with dual-control approval, profiles with canary and
rollback); chat and compare with streaming, branches, attachments, exact calculation and metering; guardrails at eleven
checkpoints with classifiers and a flag queue; knowledge bases with hybrid search, memory and read-only data
connections; the tool registry, MCP servers, agent runs and a script sandbox; workflows, media processing and image
generation; and training, network zones, platform operations (signed import bundles, mirrors, ACME, backups and
restore drills) and federation (OIDC provider, SAML IdP, upstream OIDC and SAML, Kerberos, device flow). Every console
screen is live. Sprint 10 added a Helm chart with NetworkPolicies, supply-chain scanning, a streaming load test,
runbooks, an OWASP ASVS level 2 review, AA and AAA accessibility modes and a Playwright suite across the console
(release candidate `1.0.0-rc.1`). Sprints 11 to 15 make up 1.1.0: password change and reset, a breached-password
check, step-up re-authentication and security notices; streaming output guardrails, held answers and resumable
streams; an OpenAI-compatible API, signed webhooks, a prompt library, conversation sharing and export, and billing
statements; token revocation, logout, PAR, DPoP, SAML single logout and signing in OpenBao; and shared rate limits, key
re-wrap, ACME dns-01, blob-store backups with restore, and sandboxed media. Sprints 16 to 19 make up 1.2.0: knowledge,
memory and server-side tools on `/v1`, the guard model while streaming, held prompts, live and anonymous sharing;
new-sign-in notices, a password strength meter, upstream step-up, DPoP nonces, SAML metadata by URL and enrolment
links; automated WCAG A/AA and reflow checks; checks on operator service URLs, backend TLS, consistent backups, ACME
account binding and certificate hooks, and sealed training data; and MySQL and replicated PostgreSQL knowledge sources
with row access, ordered and Ed25519-signed webhooks, per-tenant price books with Stripe reconciliation, and workflow
tools agent runs can await. Sprints 20 to 23 make up 1.3.0: an optional signer process that keeps private keys out of
the application, KMS-held webhook keys, HTTP Message Signatures and CI steps that sign and attest the image; held `/v1`
requests, a Responses API subset, profile evaluations with a publish gate and scheduled agent runs; OpenTelemetry
tracing, Prometheus rules and Grafana dashboards, safe rolling upgrades, key escrow, zones applied in-cluster and an NTP
quorum; and S3 and web-crawl knowledge sources, PostgreSQL row security, webhook order across instances, proration and
Stripe refunds, and axe-core in the accessibility checks. Sprints 24 to 28 make up 1.4.0, the server features of exprsn-platform
re-implemented here: a certificate authority with OCSP and an ACME server, a secrets vault with dynamic database
leases, the event catalogue and plugins; AT-Protocol keys, DIDs, a labeler, sign-in and firehose ingest; moderation
actions and appeals, a file store, low-code data apps, groups and events with iCalendar feeds, customer-service chat and
email channels, person-to-person messaging, a workspace feed, and a load test of the event and data paths. Sprints 29
to 34 make up 1.5.0: console screens for those features (Certificates, Vault, Plugins and events, Apps, Files,
Moderation, Groups and events, Channels, Messages and feed, Roles and access, AT-Protocol); permission matrices, custom
roles, effective access and access reviews; CalDAV, CardDAV and WebDAV for the file store with DAV-only app passwords;
model-based memory management and MongoDB connections; an AT-Protocol personal data server with feed generators;
import repositories and model import; Workflows 2 (sub-workflow, agent, map and loop steps, event and schedule
triggers, failure edges and dead letters, signed bundles, domain built-in tools) on one chain context, with agents
delegating to agents, skills composing, checks at publish and a chain view; and profiles and presence
([Backlog-1.5.0.md](Backlog-1.5.0.md)). Sprints 35 to 39 make up 1.6.0: model servers beyond Ollama (Apple Foundation
Models, MLX, llama.cpp) and the platform administration screens; groups depth, blob deduplication and image
classification in Knowledge; the HTTP tool kind, prompt-injection defence, SCIM and the MCP server; the AI inventory,
analytics, audit export, red-team suites, agent identities and handoffs, row and field policies, DLP and legal hold;
C2PA content credentials, versioned chat artifacts, app packages with environments and promotion, data model drafts,
AI field fills, outside tables, entity APIs and app embedding ([Backlog-1.6.0.md](Backlog-1.6.0.md)). See
[Sprints.md](Sprints.md) and [CHANGELOG.md](CHANGELOG.md).

## What's in the repository

| Path | Contents |
| --- | --- |
| [`server/`](server) | Node.js 22, TypeScript, Express 5 and Socket.io. Users sign in against a per-tenant chain of user stores (OpenLDAP, PostgreSQL / MySQL / SQLite user tables, local accounts), with TOTP, passkeys and recovery codes, role and clearance based access, API keys, and a per-tenant SHA-256 audit chain with signed checkpoints. It is the only component that talks to Ollama. The application database is PostgreSQL, MySQL or SQLite (Knex); Redis, OpenBao, S3 and SMTP are optional |
| [`web/`](web) | The user workspace and admin console, served by the server. Plain HTML, CSS and JavaScript with no build step and a strict CSP |
| [`design/prototype/`](design/prototype/README.md) | The clickable specification (51 screens, example data). Open `design/prototype/index.html` in a browser |
| [`deploy/`](deploy) | Dockerfile; Compose for production, development and GPU hosts; a Helm chart with NetworkPolicies; systemd unit and installer for bare metal; an example identity YAML |
| [`e2e/`](e2e/README.md) | The Playwright suite that drives every console screen against a real server and test fakes |
| [`docs/`](docs) | [Plan and decisions](docs/PLAN.md), [API](docs/api.md), [identity](docs/identity.md), [deployment](docs/deploy.md), [security](docs/security.md), [ASVS assessment](docs/asvs.md), [accessibility](docs/accessibility.md), [runbooks](docs/runbooks/README.md), [load testing](docs/loadtest.md) |

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
`admin:create`, `tenant:create` (with `--template` since 1.6.0), `audit:verify`, `audit:verify-export` (an exported JSONL
window against its checkpoint, 1.6.0), `c2pa:verify` (a generated image's content credentials, 1.6.0), `kms:rotate`,
`kms:rewrap`, `kms:escrow`, `backup:create` and `backup:restore-drill`.

For production (Docker Compose or bare-metal systemd, TLS, secrets as files, Ollama nodes) see
[docs/deploy.md](docs/deploy.md).

## Checks

```sh
npm run lint && npm run typecheck && npm test      # unit and API tests on in-memory SQLite
for f in web/js/*.js web/js/screens/*.js; do node --check "$f"; done
TEST_PG_URL=postgres://… TEST_MYSQL_URL=mysql://… TEST_LDAP_URL=ldap://… TEST_LDAP_INSECURE=true TEST_LDAP_BIND_PW=… \
  npm run test:integration -w server              # user stores against real servers
# B-3605: the email channel's IMAP adapter against GreenMail (prints NODE_EXTRA_CA_CERTS, TEST_IMAP_URL, TEST_IMAP_SMTP_URL)
server/test/integration/greenmail.sh /tmp/greenmail
```

CI runs all of these, builds the container image and checks that it answers `/readyz`.

The prototype has its own Playwright smoke test: `cd design/prototype && node build.mjs && npm install && npm run smoke`.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
