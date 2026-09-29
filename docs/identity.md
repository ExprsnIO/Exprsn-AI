# Identity: user stores, sign-in and access

## User stores

Each tenant has an ordered chain of user stores. A store is one of:

| Kind | Where users live | Notes |
| --- | --- | --- |
| `ldap` | OpenLDAP or any LDAPv3 directory | Service bind → search with `userFilter` → bind as the user → groups by search (`member`, `uniqueMember`, `memberUid`) or `memberOf`. LDAPS or StartTLS; `allowInsecure` only outside production |
| `sql` + `dialect: pg` | a user table in PostgreSQL | Column names from configuration; values always bound as parameters |
| `sql` + `dialect: mysql` | a user table in MySQL / MariaDB | Same adapter |
| `sql` + `dialect: sqlite` | a user table in a SQLite file | Opened read-only |
| `local` | the application database | Bootstrap and break-glass accounts, created with `exprsn-ai admin:create` or in the console |

SQL stores accept **argon2** and **bcrypt** hashes. Rows with any other format (plain text, unsalted digests) never
authenticate. Give the store a database account with `SELECT` on the user and group tables only.

Groups for SQL stores come from a column on the user row (comma-separated or a JSON array), a separate table
(`groupTable`), or both.

### Chain rules

Stores are asked in `position` order (lowest first):

1. The store does not know the username → ask the next store.
2. The store knows the username and the password is wrong, or the account is disabled there → **stop**. A password
   is never tried against a second store.
3. The store cannot be reached or is misconfigured → skip it, record the error in the audit event, and continue.

When no store knows the user, the server still spends the time of a password check, so response time does not
reveal whether an account exists. Every failure returns the same message and counts toward lockout.

### Secrets

Configuration never contains secret values. Use references:

- `env:NAME` reads an environment variable of the server process;
- `file:/absolute/path` reads a file (a Docker secret, systemd credential, or mounted vault file) at use time, so
  rotating it needs no restart.

### Managing stores

- **In the console:** Admin → User stores. Add, edit, reorder, enable or disable, and test the connection. "Test a
  login" runs the real chain for a username and password, shows each step, the groups returned, and the roles and
  clearance they would map to, without creating a session.
- **In a file:** `IDENTITY_CONFIG=/etc/exprsn-ai/identity.yaml` (see
  [`deploy/config/identity.example.yaml`](../deploy/config/identity.example.yaml)). Stores declared there are
  applied at every start and marked "managed by config"; the console can test, reorder and enable or disable them,
  but not edit them.

The last enabled store of a tenant cannot be disabled or removed.

## From store account to user

The first successful sign-in links the store account to a user in the application database, keyed on
**(store, external id)**: the DN for LDAP, the id column (or username) for SQL. If a user with the same username is
already linked to a *different* store, sign-in is refused (`identity_conflict`) rather than merged, so an account in
one store can never take over an account from another.

Roles and clearance:

- **Group mappings** map a group (DN or name, compared case-insensitively) to a role and a clearance, optionally only
  for one store. A user in several mapped groups gets every mapped role and the highest clearance.
- A store may grant **default roles** (`member`, `auditor`, `flag-reviewer`, `knowledge-curator`; never an admin role)
  when no mapping matches, for stores that have no groups.
- **Direct** roles and clearance can be granted in the console. Only a system admin can grant system admin; admins
  cannot change their own roles, clearance or state.
- A user with no role from any source is refused (`no_mapped_group`).

Mapped roles and clearance are recomputed at every sign-in. Changing a user's access in the console ends their
sessions so the change applies on the next request.

## Roles

| Role | Grants | Second factor |
| --- | --- | --- |
| System admin | everything, across tenants | required |
| Tenant admin | tenant, users, identity, usage, audit | required |
| Identity admin | user stores, mappings, users, sessions | required |
| Model admin | models, pools, profiles | required |
| Guardrail admin | guardrails, classifiers, flags | required |
| Tool admin | registry, agents, MCP servers | required |
| Knowledge curator | knowledge bases | — |
| ML admin | training | required |
| Workflow admin | workflows, scripts | required |
| Connection admin | data connections | required |
| Flag reviewer | the review queue | — |
| Member | chat, knowledge, tools within clearance | — |
| Auditor | audit chain and usage, nothing else | required |

The full permission lists are in [`server/src/authz/permissions.ts`](../server/src/authz/permissions.ts).

## Sign-in, sessions and second factors

1. `POST /api/auth/login` with username and password (and `tenant`, or the server's `DEFAULT_TENANT`).
2. If the user has a second factor, the session is at stage `mfa` for five minutes: TOTP, a passkey, or a recovery
   code completes it. If the user's roles require one and none is set up, the stage is `enroll`, and only factor
   enrolment is allowed. Completing either issues a **new** session token.
3. Sessions end after `SESSION_IDLE_MINUTES` of inactivity or `SESSION_ABSOLUTE_HOURS` in total, on sign-out, or when
   revoked (by the user, an admin, or disabling the account). Revocation closes the session's live connections.

Five failed attempts lock the account for `LOCKOUT_DURATION_MINUTES`; the client address has a higher limit.

## API keys

Created in Settings from a browser session. `exai_k1_<prefix>_<secret>`, shown once. A key's scopes are a subset of
its owner's permissions at creation, and every request intersects them with the owner's current roles, so demoting
or disabling the owner applies to their keys immediately. Use as `Authorization: Bearer exai_k1_…`.

## Audit

Every sign-in, failure, refusal, second-factor event, denial (`authz.denied` with the failing step) and admin change
is appended to the tenant's hash chain. `POST /api/admin/audit/verify` (or `exprsn-ai audit:verify`) recomputes it
from the first event; a break is reported, never repaired.
