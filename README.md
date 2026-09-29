# Exprsn-AI

Self-hosted, multi-tenant control plane and chat interface for Ollama-served models.

- **Server** (`server/`): Node.js 22, TypeScript, Express 5 and Socket.io. Users sign in against a per-tenant chain of
  user stores (OpenLDAP, PostgreSQL / MySQL / SQLite user tables, local accounts), with second factors, role and
  clearance based access, and a tamper-evident audit chain. The application database is PostgreSQL, MySQL or SQLite.
- **Console** (`web/`): the user workspace and admin console, served by the server. Screens built from the design
  prototype are connected to the API sprint by sprint; the rest show a "Prototype data" banner.
- **Design prototype** (`design/prototype/`): the clickable specification. Open `design/prototype/index.html`.

Plan and status: [docs/PLAN.md](docs/PLAN.md). Identity: [docs/identity.md](docs/identity.md).
Deployment: [docs/deploy.md](docs/deploy.md). Security: [docs/security.md](docs/security.md).

## Run it locally

```sh
npm ci
cp server/.env.example server/.env        # then fill in the two secrets it lists
set -a; . server/.env; set +a
npm run cli -w server -- admin:create --username root --display-name "Platform admin"
npm run dev                                # http://localhost:8080
```

Sign in as `root`; the console asks you to set up an authenticator app first (admin roles require a second factor).
Add your OpenLDAP or SQL user store under **Admin → User stores**, map directory groups to roles, and use
**Test a login** to check it.

Everything at once, with seeded OpenLDAP, PostgreSQL and MySQL user stores:

```sh
docker compose -f deploy/docker/compose.dev.yml up --build
```

## Checks

```sh
npm run lint && npm run typecheck && npm test      # unit and API tests on in-memory SQLite
TEST_PG_URL=postgres://… TEST_MYSQL_URL=mysql://… TEST_LDAP_URL=ldap://… TEST_LDAP_INSECURE=true TEST_LDAP_BIND_PW=… \
  npm run test:integration -w server              # user stores against real servers (CI runs these)
```
