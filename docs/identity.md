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
| `oidc` | an upstream OpenID Connect provider (we are the relying party) | Sign-in by redirect; no passwords, no directory sync. See [Upstream federation](#upstream-federation) |
| `saml` | an upstream SAML 2.0 identity provider (we are the service provider) | Same; signed assertions only |
| `atproto` | AT-Protocol accounts (we are an OAuth client of each account's own authorization server; 1.4.0) | Sign-in by redirect after the person gives their handle; a DID bound to a user signs in as that user, others are provisioned with their DID as their only group. See `docs/api.md`, Sprint 26b |

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

Tenant admins write these references, so the operator decides what they can reach:

- an `env:` name must be on `SECRET_REF_ENV` (names or `PREFIX*` patterns; empty by default, so no `env:` reference
  works until the operator lists some);
- a `file:` path must resolve, following symlinks, inside one of `SECRET_REF_DIRS` (by default `/run/secrets`,
  `/run/credentials` and `/etc/exprsn-ai/credentials`);
- the server's own settings (`DATA_KEY`, `DATABASE_URL`, `SESSION_SECRET` and every other variable in
  [deploy.md](deploy.md), with their `_FILE` forms) and the files those `_FILE` variables name are never readable,
  whatever the lists say.

A reference that breaks these rules is refused when the store is saved and again when it is read.

LDAP directories and the databases behind SQL stores must resolve to internal addresses unless
`IDENTITY_ALLOWED_HOSTS` names them; the host is checked before every connection, before any password is sent. A
SQLite store can never be the application's own database.

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

Changing someone's roles, resetting their factors and ending their sessions (Users, Sessions, and the Sessions tab of
Federation, including their OAuth grants) all need the same thing: roles that could grant every role the person
holds. An identity admin can sign a member out but not a system admin; anyone can end their own sessions.

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
3. If an admin set or reset the account's local password (or created the account with a password), the session then
   moves to stage `password`: only `POST /api/me/password` is allowed until the user chooses their own password.
4. Sessions end after `SESSION_IDLE_MINUTES` of inactivity or `SESSION_ABSOLUTE_HOURS` in total, on sign-out, or when
   revoked (by the user, an admin, or disabling the account). Revocation closes the session's live connections.

Five failed attempts lock the account for `LOCKOUT_DURATION_MINUTES`; the client address has a higher limit.

Local accounts can change their password in Settings (the current password is required and a wrong one counts toward
the lockout; the change signs out every other session and OAuth grant), reset it with a single-use link by email from
the sign-in screen, and be reset by an identity admin (a temporary password to change at next sign-in, or a link).
Directory accounts change their password in the directory. New passwords pass the policy and, with
`BREACHED_PASSWORDS`, a breached-password check. Creating API keys, removing a factor and regenerating recovery codes
need a password or factor check within `STEPUP_WINDOW_SECONDS` (signing in counts); Settings asks for it when needed.
The account owner gets a security notice (console and email) for each of these changes. Routes: [api.md](api.md#sprint-11-account-self-service).

## Federation (Sprint 9)

The server is an OpenID Connect provider and a SAML 2.0 IdP for applications, a relying party or service provider to
on-prem identity providers, and accepts Kerberos SPNEGO. Everything is configured per tenant on the **Identity**
screen (permission `identity:manage`; admin roles need an MFA-verified session) and every change is audited.

### Issuers and endpoints

The default tenant's issuer is `FEDERATION_ISSUER` (default `PUBLIC_URL`); every other tenant's is
`<issuer>/t/<tenant slug>`, and its endpoints live under that prefix. The default tenant is served at the root only, so
each tenant has exactly one issuer. Each tenant has its own signing keys, clients, SAML service providers and upstream
providers; tokens carry `tenant` (slug) and `tid` claims, and a session in one tenant never authorizes another
tenant's client.

| Path (under the issuer) | What it is |
| --- | --- |
| `/.well-known/openid-configuration`, `/.well-known/jwks.json` | Discovery and the key set (CORS open, cached 5 minutes) |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata (the discovery document); also at the path-inserted `/.well-known/oauth-authorization-server/t/<slug>` and `/.well-known/openid-configuration/t/<slug>` on the host (1.6.0) |
| `/oauth/register` | RFC 7591 dynamic client registration, only when the tenant allows it (1.6.0, see "MCP clients" below) |
| `/oauth/authorize` | Authorization code flow with the console session; consent page when needed |
| `/oauth/token` | `authorization_code`, `refresh_token`, `client_credentials`, device code, token exchange (60 requests a minute per address) |
| `/oauth/userinfo`, `/oauth/revoke`, `/oauth/device_authorization`, `/device` | Userinfo, RFC 7009 revocation, RFC 8628 device authorization and its verification page |
| `/saml/metadata`, `/saml/sso`, `/saml/continue` | IdP metadata, SSO (HTTP-Redirect and HTTP-POST bindings), and the response page |
| `/federation/oidc/start`, `/federation/oidc/callback` | Upstream OIDC sign-in |
| `/federation/saml/start`, `/federation/saml/acs`, `/federation/saml/<provider id>` | Upstream SAML sign-in, the ACS, and our SP metadata (its URL is our entity ID) |
| `/auth/negotiate` | Kerberos SPNEGO sign-in |

These paths sit outside `/api`: they parse their own form bodies and are not CSRF-checked by header; forms that change
state (the consent page) carry a token bound to the session and are refused cross-origin.

### Signing keys

OIDC tokens are signed with ES256 (P-256). Private keys are generated with node:crypto, stored as PKCS#8 sealed with
the platform data key (bound to the key id), and never leave the server. A key moves through `next` (published in
the JWKS, not signing) → `signing` → `verify only` (still published for `OIDC_KEY_OVERLAP_DAYS`, default 14, so tokens
it signed keep verifying) → removed. A scheduled job publishes the next key `OIDC_KEY_OVERLAP_DAYS` before the signing
key reaches `OIDC_KEY_ROTATION_DAYS` (default 90) and switches over when it is due. "Rotate signing key" does the same
now; the API's `immediate: true` (a suspected compromise) makes the new key sign at once.

The SAML IdP signs with a separate RSA-2048 key and a self-signed certificate (valid three years), because SAML
service providers widely support RSA-SHA256 and not ECDSA.

### Clients

| Type | Secret | Grants | Consent |
| --- | --- | --- | --- |
| confidential, BFF (`first_party`) | yes | authorization code, refresh, device, token exchange | pre-consented when the tenant allows it |
| public | none | authorization code with PKCE, device, refresh | asked |
| service account (`service`) | yes | client credentials, token exchange | not applicable |
| third party | yes | authorization code, refresh, device, token exchange | asked on first use, remembered 90 days |

- Redirect URIs match exactly: https, http on a loopback address, or a private-use scheme; wildcards and fragments are
  refused. A wrong redirect URI or unknown client shows an error page and never redirects.
- PKCE with S256 is required for public clients and, by default, for every client (`plain` is refused).
- Client secrets (`xs_live_…`) are shown once, at creation or rotation, and stored as an HMAC digest. Rotation stops
  the old secret at once. Disabling a client revokes its refresh tokens and makes its access tokens fail.
- A service-account client gets a user (`svc-<name>`, role `member`, no password); its tokens carry that user as the
  subject, and their scopes narrow the user's roles. Grant it more roles in User stores if it needs them.

**Scopes** are the identity scopes (`openid profile email groups offline_access`), every permission
(`chat:read`, `models:manage`, …), `resource:*` on a client's allow-list, and `inference:invoke:<profile>`. The
grant is requested ∩ the client's allow-list ∩ the user's current permissions, so scopes never widen a role; it is
re-intersected at every refresh. **Claims**: `profile` gives `name` and `preferred_username`; `email` gives `email`;
`groups` gives `groups` (from the user's store), `roles` and `clearance`.

**Tokens.** Access tokens are JWTs (`typ: at+jwt`, ES256, `kid`), 5, 10 or 30 minutes per client, with `aud`
(`<issuer>/api` unless a `resource` is given: since 1.6.0 the code and refresh grants carry the resource named at the
authorization endpoint, which must be `<issuer>/api` or one of the tenant's MCP endpoints, RFC 8707), `scope`, `client_id`, `tenant`, `tid`, `sid` (the grant),
`models` (the client's allowed models) and, after token exchange, `act`. ID tokens add `nonce`, `auth_time`, `amr`
(`pwd`, `otp`, `hwk`, `kerberos`, `fed`, `mfa`) and `at_hash`. Refresh tokens are opaque, stored as digests, and
rotated on every use; a family lives 8 hours (24 hours for clients with the device grant) from its first token.
Presenting a rotated refresh token again revokes the whole family and is audited (`oidc.refresh.reused`). A replayed
authorization code revokes what it produced. Revoking the console session behind a grant, or the user being disabled,
ends it at the next refresh.

**Token exchange** (RFC 8693) takes an access token from this issuer as `subject_token` and returns a narrower one for
the calling confidential client, with `act: {sub: <client id>}`.

### MCP clients (1.6.0, B-7102)

Each workspace can publish an MCP server (Identity, **MCP server** tab): `<base>/mcp/<tenant slug>/<workspace id>`,
where the base is `API_PUBLIC_URL` or the origin of `PUBLIC_URL`. The server is an OAuth 2.1 resource server of the
tenant's issuer, so an MCP client such as Claude Desktop follows the MCP authorization flow with no secret in the URL:

1. Its first request gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`. The protected resource metadata
   (RFC 9728) names this tenant's issuer and the MCP scopes (`tools:invoke agents:run inference:invoke knowledge:read
   records:read records:write`).
2. The client reads the issuer's metadata (RFC 8414) and needs a client: an identity admin creates a public client
   with its redirect URI under OIDC clients, or, with **self-registration** on, the client registers itself at
   `/oauth/register` (RFC 7591: authorization code with PKCE and refresh only, HTTPS or loopback redirect URIs, the
   MCP scopes; listed on the MCP server tab and disabled like any client). Self-registration is off by default.
3. The person signs in to the console (or already is), sees the consent page for the client and the scopes (narrowed
   by their roles), and the client gets a code, then tokens, naming the server's URL as the `resource` (RFC 8707). The
   access token's audience is that URL; it is refused by the API and by every other workspace's server, and an API
   token is refused by the MCP server.
4. Every call acts as that person, at most at the label the workspace publishes at, and writes wait for the person's
   approval under Settings, **MCP access**, where the connection URLs are listed too.

A workspace can require DPoP-bound tokens. Before 1.6.0 an MCP client could only reach Exprsn-AI through a separate MCP
service holding a service account's credential (as the platform-tools service on one deployment does); a workspace's
MCP server makes that unnecessary, since each person connects as themselves.

The reverse direction, Exprsn-AI connecting each person to someone else's authorization-protected MCP server, is on the
MCP servers screen (OAuth for users: discovery with RFC 9728, RFC 8414 and RFC 7591, or endpoints and a client entered
by hand) and in Settings, MCP access (connect and disconnect); see `docs/api.md`, Sprint 37b.

### Signing in through the console

`/oauth/authorize` and `/saml/continue` use the console session cookie. That cookie is `SameSite=Strict`, so it is
not sent on a redirect from another site: those requests get a small page whose script (`web/js/federation.js`, no
inline scripts) re-checks the session from our origin and resumes, or keeps the address in `sessionStorage` and opens
the console sign-in, which resumes it when sign-in (including the second factor) finishes. Resume addresses are
limited to our own `/oauth/authorize`, `/saml/continue` and `/device` paths.

### Device flow (RFC 8628)

`POST /oauth/device_authorization` gives a device code, a user code (`XXXX-XXXX`, consonants only) and the
verification URI `<issuer>/device`. Codes live `DEVICE_CODE_MINUTES` (15); the device polls the token endpoint no more
than every `DEVICE_POLL_SECONDS` (5) and gets `authorization_pending`, `slow_down` (interval +5 s), `access_denied` or
`expired_token`. The user approves on the verification page as the user signed in to the browser
(`GET/POST /api/auth/device`); the scopes are intersected with that user's permissions.

### SAML IdP

Service providers are registered from pasted metadata (nothing is fetched): entity ID, HTTP-POST ACS URLs, signing
certificate, NameID format and `AuthnRequestsSigned`. SP-initiated SSO over HTTP-Redirect (DEFLATE) or HTTP-POST; the
request must name a registered SP and a registered ACS URL, and is signature-checked when the SP asked for signed
requests. The response is a `samlp:Response` whose assertion carries an enveloped XML-DSig signature (RSA-SHA256,
exclusive C14N, SHA-256), `InResponseTo`, `Recipient`, the SP as audience, a validity of `SAML_ASSERTION_MINUTES` (5)
and attributes `uid`, `email`, `displayName`, `groups`, `roles` and `clearance` (renamed per SP with an attribute
map). NameID: email, a pairwise persistent id (HMAC of the SP and user), the username, or transient. The response is
posted by a form (auto-submitted by `web/js/federation.js`); the page's CSP allows that one ACS origin. An SP whose
certificate has expired can be enabled only with signed requests off.

The XML code (`server/src/federation/xml.ts`) is deliberately strict: no DOCTYPE or entity declarations, no processing
instructions, no unbound prefixes, comments dropped and adjacent text merged.

### Upstream federation

An upstream provider is a user store of kind `oidc` or `saml` in the tenant's chain, added from the Identity screen
("Add upstream provider") or YAML/API like other stores. Its hosts must resolve to internal addresses (the air gap)
unless `FEDERATION_ALLOWED_HOSTS` names them; every connection is re-checked at dial time. It appears on the sign-in
screen as "Sign in with <name>".

- **OIDC**: authorization code with PKCE (S256), `nonce` and `state`. The ID token is verified against the provider's
  JWKS (RS256 or ES256; refetched once on an unknown `kid`): signature, issuer, audience, `azp`, expiry and nonce. The
  client secret is a secret reference (`env:` or `file:`). Register `<issuer>/federation/oidc/callback` at the provider.
- **SAML**: an AuthnRequest over HTTP-Redirect; the response posted to `<issuer>/federation/saml/acs` must answer that
  request (`InResponseTo`), name our ACS as recipient and our entity ID as audience, be inside its validity window
  (2 minutes skew), and carry exactly one assertion, signed (itself, or inside a signed response) by a certificate
  from the IdP metadata. Encrypted and unsolicited (IdP-initiated) assertions are refused.
- The browser round trip carries a single-use handle (`state` / `RelayState`) bound to a short-lived cookie in the
  browser that started it, so a copied response cannot be completed elsewhere.
- Claims or attributes become the store account: the subject (or NameID) is the external id, the username claim
  (`preferred_username` by default) or attribute the username, and the groups claim or attribute feeds the tenant's
  group mappings, exactly as for LDAP. Upstream users are never disabled by directory sync.

### Kerberos SPNEGO

`GET /auth/negotiate` answers `401 WWW-Authenticate: Negotiate`; a browser with a domain sign-in and this site in its
intranet zone retries with a ticket. The ticket is verified by `s.kerberos` (`server/src/federation/kerberos.ts`),
which uses the optional `kerberos` npm module with the keytab in `KERBEROS_KEYTAB` and the service
`KERBEROS_SERVICE` (`HTTP@ai.example.internal`); without both, Kerberos reports itself unavailable and the sign-in
screen does not offer it. The principal (`alice@CORP.EXAMPLE`) must be in an accepted realm (tenant setting; empty
accepts any) and its user part is looked up in the tenant's user stores in order; the store that knows it supplies the
groups, and provisioning continues as for a password sign-in. A mutual-authentication token is returned when the
library gives one.

### Second factors after federated sign-in

Upstream and Kerberos sign-ins count as the first factor only. A user who has a second factor, or whose roles require
one, lands in the `mfa` or `enroll` stage exactly as after a password, and finishes it in the console. Tokens issued
from a session record the factors in `amr`.

### Test a login

The Identity screen's "Test a login" runs the real pieces without creating a session: Kerberos availability and realm
policy, the store lookup, group mappings, second factors, and a token signed with the current key and verified
against the published JWKS with a test audience. "Device code" issues a real device code for a client that allows the
grant.

## API keys

Created in Settings from a browser session. `exai_k1_<prefix>_<secret>`, shown once. A key's scopes are a subset of
its owner's permissions at creation, and every request intersects them with the owner's current roles, so demoting
or disabling the owner applies to their keys immediately. Use as `Authorization: Bearer exai_k1_…`.

## Audit

Every sign-in, failure, refusal, second-factor event, denial (`authz.denied` with the failing step) and admin change
is appended to the tenant's hash chain. `POST /api/admin/audit/verify` (or `exprsn-ai audit:verify`) recomputes it
from the first event; a break is reported, never repaired.
