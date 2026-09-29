# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What's here

Exprsn-AI is a self-hosted, multi-tenant control plane and chat interface for Ollama-served models. The repository
has three parts:

| Path | What it is |
| --- | --- |
| `server/` | The application server (npm workspace `@exprsn-ai/server`): Node.js 22, TypeScript strict, Express 5, Socket.io 4, Knex |
| `web/` | The console the server serves: the prototype's screen modules, wired to the API screen by screen |
| `design/prototype/` | The clickable design prototype. It is the specification for behaviour and copy, with example data only |
| `deploy/` | Dockerfile, Compose (production, development, GPU), bare-metal systemd unit and installer, example identity YAML |
| `docs/` | `PLAN.md` (decisions and rules), `identity.md`, `security.md`, `deploy.md` |
| `Sprints.md` | Sprint status: what each sprint delivered or will deliver, and which screens it makes live |

Sprints 0 (foundations) and 1 (identity and access) are done. Only **Sign in**, **Settings** and **User stores** are
live in the console; every other screen shows a "Prototype data" banner naming the sprint that connects it. Check
`Sprints.md` before starting work so you build the next sprint's scope, not a later one.

## Commands

From the repository root (npm workspaces; Node 22+):

```sh
npm ci
npm run dev                  # tsx watch server/src/index.ts, http://localhost:8080 (needs the env from server/.env)
npm run lint                 # eslint server/src server/test
npm run typecheck            # tsc --noEmit
npm test                     # vitest: unit and API tests on in-memory SQLite
npm test -w server -- test/policy.test.ts   # one test file (add -t "<name>" for one test)
npm run build                # tsc to server/dist
npm run cli -w server -- <migrate | admin:create | audit:verify>
npm run test:integration -w server           # needs TEST_PG_URL, TEST_MYSQL_URL, TEST_LDAP_URL, TEST_LDAP_INSECURE, TEST_LDAP_BIND_PW
for f in web/js/app.js web/js/screens/*.js; do node --check "$f"; done   # console scripts must parse (CI checks this)
```

Local setup: `cp server/.env.example server/.env`, fill `SESSION_SECRET` (`openssl rand -hex 32`) and `DATA_KEY`
(`openssl rand -base64 32`), then `set -a; . server/.env; set +a`. The full stack with seeded OpenLDAP, PostgreSQL and
MySQL user stores is `docker compose -f deploy/docker/compose.dev.yml up --build` (seed logins are in the header of
that file).

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, build and the console parse check; integration tests
against real PostgreSQL 17, MySQL 8.4 and OpenLDAP; and a container build that must answer `/readyz`.

Prototype commands, run from `design/prototype/`:

```sh
node build.mjs              # regenerate index.html, screens/<id>.html and dist/artifact.html from the sources
npm install && npm run smoke                        # Playwright: every screen, light + dark, every state; exit 1 on error
npm run shot -- <route> [out.png] [width] [dark]    # screenshot #/<route>, signed in
```

Run `node build.mjs` before smoke/shot. In cloud sessions set `CHROME=/opt/pw-browsers/chromium` and don't run
`playwright install`.

## Server architecture (`server/src`)

- **`index.ts`** starts the HTTP server, Socket.io and graceful shutdown; **`cli.ts`** is the `exprsn-ai` CLI;
  **`bootstrap.ts`** seeds the default tenant and identity YAML; **`services.ts`** builds the `Services` object
  (config, db, logger, metrics, audit, repos, identity chain, sessions, API keys, MFA) passed to every route factory.
- **`config/`**: zod-validated environment. `SESSION_SECRET`, `DATA_KEY`, `DATABASE_URL`, `METRICS_TOKEN` may be given
  as `<NAME>_FILE`. Production refuses non-HTTPS cookies.
- **`http/app.ts`** composes the app: trace ids, pino-http, Helmet (CSP `script-src 'self'`), compression, health
  routes, then `/api` (JSON 256 kB limit → `authenticate` → `csrfProtection` → rate limits → routers), then the static
  console with SPA fallback. **`http/middleware.ts`** has `authenticate`, `csrfProtection`, `requireAuth`,
  `requirePermission`, `parseBody`; **`http/problem.ts`** has the RFC 9457 `HttpProblem` helpers.
- **`routes/`**: `auth.ts` (`/api/auth`: login, MFA steps, logout), `me.ts` (`/api/me`: profile, sessions, API keys,
  factor enrolment), `admin/identity.ts` (user stores, test login, group mappings), `admin/users.ts` (roles, users,
  sessions), `admin/audit.ts` (read and verify), `health.ts` (`/healthz`, `/readyz`, `/metrics`).
- **`identity/`**: the per-tenant store chain (`chain.ts`), adapters in `providers/` (`ldap.ts`, `sql.ts`,
  `local.ts`), JIT provisioning, sessions, MFA (TOTP, WebAuthn, recovery codes), lockout, API keys, secret sealing.
- **`authz/`**: `permissions.ts` (permission catalogue and the 13 built-in roles), `labels.ts` (clearance labels
  `public < internal < confidential < restricted`), `policy.ts` (the single decision pipeline: role → scopes →
  tenant → clearance → zone ceiling).
- **`audit/chain.ts`**: append-only per-tenant SHA-256 hash chain. **`repos/`**: tenant-scoped data access.
- **`db/`**: Knex for `pg`, `mysql`, `sqlite`. Migrations are **imported** in `db/migrations/index.ts`, not discovered
  on disk: a new migration needs a file `00N_name.ts` and an entry in that map. Keep the schema dialect-agnostic.
- **`realtime/socket.ts`**: Socket.io with the cookie-session handshake; the server joins each socket to its user,
  tenant and session rooms.
- Tests live in `server/test/` (`helpers.ts` builds an app on in-memory SQLite and signs users in, including TOTP);
  `server/test/integration/` runs the stores against real servers.

### Rules for server code (from `docs/PLAN.md`)

- Every route validates input with zod, requires authentication and an explicit permission, takes the tenant from
  the session (never the body), filters output by clearance, writes an audit event for every change, and fails with
  problem+json carrying the trace id.
- Secrets are shown once and stored hashed or sealed. Dual control where the boards require it.
- Socket rooms are decided by the server from the principal; revoking a session closes its sockets.
- The prototype's infrastructure maps to interfaces (`JobQueue`, `Kms`, `BlobStore`, `VectorStore`) with a
  single-node adapter plus a scalable one; see the table in `docs/PLAN.md`.

## Console (`web/`)

- Same runtime model as the prototype: plain HTML/CSS/ES2017, classic `<script>` tags sharing the global `App`, no
  build step. `web/index.html` lists every screen's `<script>` tag by hand (there is no `build.mjs` here) and loads
  `/socket.io/socket.io.min.js`. No inline scripts (CSP).
- `web/js/app.js` extends the prototype shell with the API client (`App.get/post/patch/del`, CSRF header, problem
  details as `ApiError`, `App.fail` toast), `App.me` and `App.can(perm)`, and the `NAV` entries' `perm`, `live` and
  `sprint` fields. A screen without `live: true` gets the "Prototype data" banner.
- To make a screen live: copy or adapt it from `design/prototype/js/screens/<id>.js` into `web/js/screens/<id>.js`,
  replace `DATA` with API calls, set `live: true` on its `NAV` entry (or on the `App.register` definition), and only do
  so when every control on it is backed by the server. `directories.js` (User stores) exists only in `web/`.

## Design prototype (`design/prototype/`)

- `shell.html` is the source template; `build.mjs` inlines it into the committed outputs `index.html` and
  `screens/<id>.html` (plus gitignored `dist/artifact.html`). Never hand-edit the outputs; edit sources, rebuild,
  commit both.
- `js/app.js` holds the router (`#/<id>?params`), `NAV`, `DATA`, `UI` helpers, command palette (Ctrl K), prototype map
  (`?`), theme, toasts, modals, drawers and the "States" popover. Only the theme and `exprsn.signedIn` persist.
- **`CONTRACT.md` is the authoritative spec for writing a screen module** (in both `design/prototype/` and `web/`).
  Adding a prototype screen: add the module, add its `<script>` tag to `shell.html`, add a `NAV` entry if needed,
  rebuild.

### Rules from CONTRACT.md that are easy to miss

- Screens must not modify `app.js` or `app.css`. Put screen-only CSS in a `<style>` block inside `root`, with selectors
  prefixed by the screen id.
- Inline styles may use CSS variables only (`var(--fg)`, `--panel`, `--accent`, `--warn-bg`…), never literal colours.
- Handlers registered with `ctx.on` are dropped on every re-render and route change. Register them inside `render`
  each time. Keep UI state in `ctx.state` and re-render the whole screen after a change.
- Each board's "States to design from this page" section becomes the screen's `states` array, each with an `apply`;
  render the strip with `UI.states(list)`.
- Reproduce the board faithfully and don't invent features, but make every control do something. Primary actions go
  through confirm → toast → visible change. Plain copy: no exclamation marks, emoji or lorem ipsum.
- Escape data with `UI.esc`, and use `type="button"` on buttons.

## Keeping docs current

When a sprint's work lands, update its row and section in `Sprints.md`, move screens to live in `web/js/app.js`, and
adjust `docs/security.md` "Known gaps" and this file if commands or structure changed.
