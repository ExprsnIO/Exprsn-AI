# OWASP ASVS 4.0.3 level 2 assessment

This is the Sprint 10 review of the application server (`server/src`) and its deployment files against the
[OWASP Application Security Verification Standard 4.0.3](https://github.com/OWASP/ASVS/tree/v4.0.3/4.0), level 2.
It covers the code on the `claude/determined-hawking-n7wmk1` branch as of 30 September 2026, and was updated for
release 1.1.0 (the `release/1.1.0` branch) and release 1.2.0 (the `release/1.2.0` branch): rows changed by Sprints 11
to 15 say "since 1.1.0", rows changed by Sprints 16 to 19 say "since 1.2.0", and both cite their tests.
Where the review found a gap that was safe to close, the fix landed with it (listed under
[Fixes from this review](#fixes-from-this-review), tested in `server/test/asvs.test.ts`). The rest are follow-ups at
the end of each chapter and in [security.md](security.md#known-gaps-tracked-in-the-plan).

Statuses, per requirement group:

- **Met**: every L2 requirement in the group is satisfied by code or deployment defaults, with the evidence named.
- **Partly**: some requirements are satisfied and the rest are named as follow-ups.
- **Not met**: the group's main requirement is not satisfied.
- **N/A**: the group does not apply to this application (the reason is given).

Evidence cites `file:line` under `server/src/` unless another root is named, and test names from `server/test/`.

## Summary

| Chapter | Met | Partly | Not met | N/A |
| --- | ---: | ---: | ---: | ---: |
| V1 Architecture | 10 | 2 | 0 | 2 |
| V2 Authentication | 7 | 2 | 0 | 1 |
| V3 Session management | 6 | 0 | 0 | 1 |
| V4 Access control | 3 | 0 | 0 | 0 |
| V5 Validation, sanitization and encoding | 4 | 1 | 0 | 0 |
| V6 Stored cryptography | 3 | 1 | 0 | 0 |
| V7 Error handling and logging | 4 | 0 | 0 | 0 |
| V8 Data protection | 3 | 0 | 0 | 0 |
| V9 Communication | 1 | 1 | 0 | 0 |
| V10 Malicious code | 2 | 0 | 0 | 1 |
| V11 Business logic | 1 | 0 | 0 | 0 |
| V12 Files and resources | 5 | 1 | 0 | 0 |
| V13 API and web service | 1 | 1 | 0 | 2 |
| V14 Configuration | 4 | 1 | 0 | 0 |
| **Total (71 groups)** | **54** | **10** | **0** | **7** |

The 1.0 review (37 met, 27 partly) named individual requirements that were not met: self-service password change
(2.1.5), a full breached-password check (2.1.7), user notification of authentication changes (2.2.3), user revocation
of OAuth grants (3.5.1), re-authentication before sensitive account changes (3.7.1) and shared (cross-instance) rate
limits (11.1.4). Release 1.1.0 (Sprints 11 to 15, [Backlog-1.1.0.md](../Backlog-1.1.0.md)) closed each of them
(2.2.3 except a notice for a sign-in from a new location), and with them the follow-ups on key re-wrap, KMS signing,
NTP skew, blob-store backups, conversation retention, signer dual control and sandboxed media; fourteen groups moved
from partly to met. Release 1.2.0 (Sprints 16 to 19, [Backlog-1.2.0.md](../Backlog-1.2.0.md)) added notices for
sign-ins from a new browser or network (2.2.3), a password strength meter (2.1.8), YAML size, depth and alias caps
(5.5), secrets masked in admin diagnostics (7.4.1) and an optional gVisor runtime for scripts (1.14.5); four more groups
moved from partly to met (1.14, 2.2, 5.5, 7.4). It also added address checks for operator-chosen service URLs (5.2.6,
12.6.1) and a setting that refuses plaintext backend links (1.9.1), which advance their groups without completing them.
No group is "not met"; what remains is named in the partly rows and under
[Follow-ups not fixed](#follow-ups-not-fixed).

## Fixes from this review

| Requirement | Fix | Test (`server/test/asvs.test.ts`) |
| --- | --- | --- |
| 8.2.1, 8.1.1 | Every `/api` answer carries `Cache-Control: no-store` (`http/app.ts:105`); routers such as agents, knowledge, images, media and training did not set it | "sends Cache-Control: no-store on every API answer…" |
| 7.4.1, 14.3.2 | The public `/readyz` reports a failing database, KMS or blob store as `unavailable` and logs the error, instead of returning driver messages with hosts and paths (`routes/health.ts:16-45`) | "keeps dependency errors out of the public readiness answer" |
| 7.4.1 | Public federation error pages show only our own checks (`UpstreamError`, `SamlError`) and a generic sentence for network, internal-address and driver errors, which go to the log (`routes/federation-public.ts:38`, `:453`, `:470`) | "names our own upstream checks…", "does not show an unexpected upstream start failure…" |
| 7.4.1 | `/oauth/userinfo` explains token errors (`JwtError`) but answers anything else generically (`routes/federation-public.ts:323`); the `WWW-Authenticate` value is stripped of quotes, backslashes and line breaks | "answers userinfo failures that are not token errors…" |
| 2.2.1, 11.1.4 | Browser sign-in and callback endpoints outside `/api` (`/oauth/authorize`, `/oauth/userinfo`, `/device`, `/saml/sso`, `/saml/continue`, upstream start and callbacks, `/auth/negotiate`) are throttled to 120 requests per address per minute (`routes/federation-public.ts:109`); the SAML ACS parses up to 1 MB of XML and had no limit | "throttles the browser sign-in and callback endpoints…" |
| 7.1.1, 8.3.1 | Request logs redact the values of credential-bearing query parameters (`code`, `state`, `code_verifier`, `user_code`, `SAMLRequest`, `SAMLResponse`, `RelayState`, tokens) in `url` and `query`, and the `X-CSRF-Token` and `Proxy-Authorization` headers (`observability/index.ts:9-58`, `http/app.ts:63`) | "redacts credential-bearing query parameters in logged URLs" |
| 2.1.7 | Local-account passwords are checked against a short list of the most common 12+ character passwords and service-specific words (`identity/passwords.ts:46-74`) | "refuses common and service-named passwords…", "applies the policy when an admin creates a local account" |
| 2.8, 4.3.1 | A user whose roles require a second factor cannot remove their only factor, even when `mfa_required` was never set on the account (roles granted later or by group mapping) (`routes/me.ts:208`) | "does not let an admin remove their only factor…" |
| 3.2.1 | A password sign-in from a browser that already holds a session revokes that session, as federated sign-ins already did (`routes/auth.ts:124`) | "ends the session a browser held when it signs in again" |
| 12.6.1 | Git knowledge sources refuse link-local, unspecified and multicast hosts (cloud metadata), as IP literals and after DNS resolution (`knowledge/sources.ts`, `mcp/hosts.ts` `isNeverAddress`) | "refuses git sources on link-local, unspecified and multicast addresses" |
| 6.3.1 | The timing-equaliser password hash is made from `crypto.randomBytes`, not `Math.random` (`identity/passwords.ts:37`) | covered by the sign-in tests in `api.test.ts` |

## V1 Architecture, design and threat modeling

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 1.1 Secure software development lifecycle | Partly | Decisions and per-sprint rules in `docs/PLAN.md`; security model in `docs/security.md`; CI runs lint, typecheck, unit and integration tests, `npm audit`, SBOM and Trivy (`.github/workflows/ci.yml:89-120`); Dependabot configured | No written threat model per feature (1.1.2); security user stories are implicit in the plan's rules rather than tracked per story |
| 1.2 Authentication architecture | Met | Low-privilege service accounts per store, secrets by reference (`identity/secrets.ts`); one authentication pipeline (`http/middleware.ts` `authenticate`, `identity/chain.ts`); all paths share lockout and MFA rules (`routes/auth.ts`, `routes/federation-public.ts` `completeSignIn`) | |
| 1.3 Session management architecture | N/A | Level 1 has no requirements here (placeholder group in 4.0.3) | |
| 1.4 Access control architecture | Met | Single policy decision point `authz/policy.ts` (role, scopes, tenant, clearance, zone), enforced server-side by `requirePermission` (`http/middleware.ts:339`); denials audited | |
| 1.5 Input and output architecture | Met | zod validation at every route (`parseBody`), output encoding by the console (`UI.esc`) and the federation pages (`routes/federation-public.ts:23` `esc`); no serialization of untrusted objects | |
| 1.6 Cryptographic architecture | Met | Per-tenant data keys wrapped by a KMS (`platform/datakeys.ts`, `platform/kms.ts`), key rotation by version (`cli.ts kms:rotate`), key-encryption keys re-wrapped under a new `DATA_KEY` or KMS by `kms:rewrap` (`platform/rewrap.ts`, 1.1.0), offboarding destroys keys; test "re-wraps every data key under a new DATA_KEY…" (`sprint15-ops.test.ts`) | |
| 1.7 Errors, logging and auditing architecture | Met | pino JSON logs with trace ids (`observability/index.ts`), audit hash chain with KMS-signed checkpoints (`audit/chain.ts`, `audit/checkpoints.ts`), SIEM stream (`audit/siem.ts`) | |
| 1.8 Data protection and privacy architecture | Met | Labels `public < internal < confidential < restricted` on data, clearance on users (`authz/labels.ts`); sealed content at rest | |
| 1.9 Communications architecture | Partly | Internal networks for database and Ollama in Compose (`deploy/docker/compose.yml`), mTLS per Ollama instance (`gateway/ollama.ts:121`), LDAPS with verification (`identity/providers/ldap.ts:49`); since 1.2.0 `REQUIRE_BACKEND_TLS` refuses to start in production with a plaintext PostgreSQL, MySQL, Redis, S3 or OpenBao link, with per-link exemptions in `BACKEND_TLS_EXEMPT` and SQLite exempt (1.9.1, B-902, `config/index.ts`); tests "production with sslmode=disable refuses to start with REQUIRE_BACKEND_TLS on", "checks MySQL, Redis, S3 and OpenBao links; SQLite is exempt" (`sprint18.test.ts`) | 1.9.1: `REQUIRE_BACKEND_TLS` is off by default, so without it links to PostgreSQL, MySQL, Redis, S3 and OpenBao are encrypted only when the operator's URL asks for it |
| 1.10 Malicious software architecture | Met | Source control with CI gates and dependency review (Dependabot, `npm audit`) | |
| 1.11 Business logic architecture | Met | Business flows are documented in `docs/api.md`; jobs and runs are checkpointed and idempotent (`platform/jobs.ts`); since 1.1.0 rate limits, the failed-credential throttle and the denial cap share one atomic Redis counter across instances when `REDIS_URL` is set (`platform/ratelimit.ts`), and the Helm chart refuses several replicas without Redis; tests "shares one counter between limiters on the same store…" (`sprint15-access.test.ts`), "two instances share one limit…" (`integration/operations.test.ts`) | While Redis is unreachable each instance counts in memory (see [security.md](security.md#known-gaps-tracked-in-the-plan)) |
| 1.12 Secure file upload architecture | Met | Uploads stored sealed in the blob store outside the web root, served with server-chosen types; since 1.1.0 every media file, preview and image is served with `Content-Security-Policy: sandbox` and `nosniff` (`media/origin.ts` `sandboxHeaders`, `routes/media.ts` `sendBytes`), and optionally from a separate origin through signed, short-lived URLs (`MEDIA_ORIGIN`); tests in `sprint15-access.test.ts` ("serves media and previews with a sandbox CSP and nosniff…") | Without `MEDIA_ORIGIN` downloads stay on the app origin, sandboxed |
| 1.13 API architecture | N/A | Placeholder group in 4.0.3 | |
| 1.14 Configuration architecture | Met | Container and systemd hardening (`deploy/`), Helm chart with NetworkPolicy, zod-validated configuration (`config/index.ts`); no unsupported client-side technology (1.14.6); scripts run in a network-less, read-only, capability-free docker or podman container, and since 1.2.0 optionally under gVisor (`SCRIPT_RUNTIME=runsc`, B-1008, `scripts/runner.ts`), refusing to run when the engine lacks the runtime (1.14.5); tests "passes --runtime=runsc to docker and reports it", "refuses runs when docker does not know the runtime, rather than running under runc" (`sprint19-workflows.test.ts`) | gVisor is opt-in; the default is the engine's runc runtime. Firecracker is not supported |

## V2 Authentication

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 2.1 Password security | Partly | Local accounts: at least 12 and up to 256 characters, no composition rules, no truncation (argon2id), the username refused, common and service-named passwords refused (`identity/passwords.ts:46-74`); login accepts up to 1024 characters (`routes/auth.ts:16`); passwords are never logged (redaction, `observability/index.ts:9`). Since 1.1.0: self-service password change with the current password (2.1.5, `routes/me.ts` `POST /password`), admin reset and email reset (2.1.6, `routes/admin/users.ts`, `routes/auth.ts` `/password/forgot`, `/password/reset`), and a breached-password check against the HIBP range API (only a five-character SHA-1 prefix leaves) or an offline sorted file (2.1.7, `identity/breached.ts`); tests in `account.test.ts` ("changes the password, ends every other session and OAuth grant…", "refuses a known-breached password through the range API, sending only the prefix", "searches a sorted hash file without loading it"). Since 1.2.0 every password form in the console shows a strength meter (2.1.8, B-802: entropy estimate, the policy's rules and the breached result, from `POST /api/auth/password/check`), and Platform warns while the breached check is off; tests "rates passwords and lists the policy rules for a signed-in user", "tells Platform when the breached-password check is off" (`sprint17.test.ts`), `e2e/tests/password-meter.spec.ts` | 2.1.7: the breached check is off by default (`BREACHED_PASSWORDS=off`, because the range API is on the internet) and fails open when its source cannot be reached; turn it on with a mirror or the offline file. 2.1.11 (paste) is a console concern |
| 2.2 General authenticator security | Met | Lockout per account and per address in the database (`identity/lockout.ts`), 5 attempts by default (`config/index.ts:204`); `/api/auth` limited to 30 requests per minute (`http/app.ts:113`); sign-in and callback pages outside `/api` limited (this review); failed bearer, API-key and DPoP credentials throttled to 20 a minute per address (`http/middleware.ts` `badBearer`, 1.1.0); failures and successes audited (`routes/auth.ts:94`); TOTP and WebAuthn as second factors; security notices in the console and by email for password, factor, recovery-code, API-key, session and OAuth-grant changes and admin resets (2.2.3, `identity/security-alerts.ts`, 1.1.0); tests "locks an account after repeated failures", "notifies on factor, recovery code, key and session changes, and on admin actions" (`account.test.ts`), "answers 429 to the 21st bad bearer token a minute…" (`sprint15-access.test.ts`); since 1.2.0 a sign-in from a new browser (a signed device cookie) or a new network (/24, /48) sends a notice (2.2.3, B-801, `identity/signin-notices.ts`, `SIGNIN_NOTICES` on by default); tests "notifies the first sign-in from a new browser, and not the second", "groups addresses into /24 and /48 networks" (`sprint17.test.ts`) | An account's very first sign-in only records the browser and network. Email notices need `SMTP_URL` and an address on the account; otherwise the notice is in the console only |
| 2.3 Authenticator lifecycle | Met | Initial passwords are set by an admin under the policy (`routes/admin/users.ts:75`) and, since 1.1.0, must be changed on first use: an admin-set or reset password puts the session in a `password` stage that reaches only the change route (2.3.1, `identity/account.ts`, `http/middleware.ts`); invitation and reset links are random 256-bit tokens stored as digests, single use, expiring after `PASSWORD_INVITE_HOURS` or `PASSWORD_RESET_MINUTES`; TOTP enrolment is forced for admin roles on first sign-in; tests "sets a temporary password: audited, the old one stops working, the next sign-in must change it", "invites by email instead of a password" (`account.test.ts`) | An admin-set temporary password does not expire by time, but it only reaches the change route. Since 1.2.0 `admin:create --enrol-link` gives the first admin a single-use link that sets the password and enrols the second factor (B-810; test "creates an admin who must use the link, and whose session can only enrol a factor" in `sprint17.test.ts`) |
| 2.4 Credential storage | Met | argon2id m=19456, t=2, p=1 (`identity/passwords.ts:6`), SQL stores accept only argon2 or bcrypt and never plain or unsalted digests (test "never accepts plain-text or unknown hash formats") | |
| 2.5 Credential recovery | Met | No knowledge-based questions or password hints; recovery codes stored as HMACs and single-use (`identity/mfa.ts:166-190`); admins can reset factors, forcing re-enrolment. Since 1.1.0, local accounts recover by an emailed single-use link (`routes/auth.ts` `/password/forgot`, `/password/reset`): the same answer whether or not the account exists, the token stored as its sha256 and carried in the URL fragment, throttled, and a reset ends every session and grant and sends a notice; the second factor is still required at the next sign-in; test "stores only the hash, works once, expires, revokes sessions, and never shows the token" (`account.test.ts`) | |
| 2.6 Look-up secret verifier | Met | Ten recovery codes, random, HMAC'd at rest, each usable once (`identity/mfa.ts:170`); test "accepts a recovery code once" | |
| 2.7 Out-of-band verifier | N/A | No SMS, email or push authenticators | |
| 2.8 One-time verifier | Met | TOTP 30 s step, window 1, single use per step (`identity/mfa.ts:16`, `:98`), sealed seeds; five failures end the pending session (`routes/auth.ts:59`); test "requires TOTP on later sign-ins and rejects a replayed code"; the last factor of an admin cannot be removed (this review) | |
| 2.9 Cryptographic verifier | Met | WebAuthn passkeys with signature counters and origin and RP ID checks (`identity/mfa.ts:130-160`) | |
| 2.10 Service authentication | Partly | API keys are 256-bit, HMAC'd, scoped, expiring (`identity/apikeys.ts:55`); OAuth client secrets shown once and stored as digests (test "shows a client secret once and stores only its digest"); service secrets passed as files; with `KMS_PROVIDER=openbao`, OIDC and SAML signing happens in OpenBao transit and no private signing key enters the process (`federation/keys.ts`, 1.1.0; test "signs ID tokens and SAML assertions in the KMS…" in `sprint14.test.ts`) | With `KMS_PROVIDER=local` the signing keys are sealed with the platform data key and unsealed in memory while in use |

## V3 Session management

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 3.1 Fundamental session management | Met | Session tokens only in cookies, never in URLs (`http/middleware.ts:200-217`) | |
| 3.2 Session binding | Met | 256-bit random tokens (`identity/sessions.ts:178`), HMAC'd in the database; rotated when a factor completes (`identity/sessions.ts:224`); a new sign-in revokes the session the browser held (this review, `routes/auth.ts:124`) | |
| 3.3 Session termination | Met | Logout revokes server-side (`routes/auth.ts:223`); idle 30 min and absolute 12 h timeouts (`config/index.ts:200-201`); users see and revoke their sessions (`routes/me.ts:90-110`); a password change or reset ends every other session and OAuth grant (3.3.3, `routes/me.ts`, `routes/auth.ts`, 1.1.0); disabling a user ends sessions and keys (test "disables a user and ends their sessions and keys"); test "changes the password, ends every other session and OAuth grant, and keeps this one" (`account.test.ts`) | |
| 3.4 Cookie-based session management | Met | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` (`http/middleware.ts:202-209`); production refuses non-HTTPS cookies (`config/index.ts:242`); the upstream-federation cookie is `HttpOnly`, `Lax` (or `None; Secure` for SAML POST) and lives 10 minutes | |
| 3.5 Token-based session management | Met | OAuth access tokens are ES256 JWTs with `typ at+jwt`, audience and tenant checks, and live-grant checks (`federation/oidc.ts`, `federation/service.ts`); refresh tokens rotate with family revocation (test "rotates refresh tokens and revokes the family…"); since 1.1.0 users list and remove the applications they allowed in Settings, which ends their tokens at once (3.5.1, `routes/me.ts` `/grants`), and access tokens are individually revocable through a shared deny-list (RFC 7009) with introspection for the issuing client (RFC 7662); tests "ends the grant's tokens at once and notifies the user", "refuses a revoked access token before it expires…" (`sprint14.test.ts`) | |
| 3.6 Federated re-authentication | N/A | Level 3 only | |
| 3.7 Defenses against session management exploits | Met | Admin roles need an MFA-verified session for every admin request (`http/middleware.ts:343`); API keys cannot create keys or manage factors (test "cannot create keys or manage factors with a key"); since 1.1.0 creating an API key, removing a factor and regenerating recovery codes need a password, TOTP or passkey check within `STEPUP_WINDOW_SECONDS` (3.7.1, `http/middleware.ts` `requireRecentAuth`, `routes/me.ts` `POST /step-up`), and a password change needs the current password; tests "lets a fresh sign-in through, asks again outside the window, and accepts the password", "guards factor removal and recovery codes, and accepts a TOTP code" (`account.test.ts`) | |

## V4 Access control

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 4.1 General access control design | Met | Enforced server-side on every route with deny by default (`http/middleware.ts:318-360`); the tenant always comes from the principal; tests in `policy.test.ts` and "keeps members out of admin routes and audits the denial" | |
| 4.2 Operation level access control | Met | Resource ownership checked in services (for example `routes/me.ts:81`, `routes/chat.ts:133`); CSRF tokens bound to the session plus `Origin` checks (`http/middleware.ts:302`); tests "refuses state changes without the CSRF token", "refuses cross-origin state changes" | |
| 4.3 Other access control considerations | Met | Admin interfaces need MFA (`authz/permissions.ts` `requiresMfa`); grant rules stop escalation (`routes/admin/users.ts:77-79`); directory listing is off (static files only from `WEB_ROOT`); dual control covers baseline guardrails, zones, model approval and, since 1.1.0, adding and revoking bundle signer keys (`ops/signers.ts`; test "needs a second platform admin to add or revoke a signer key (after the first)" in `sprint15-ops.test.ts`) | The first signer key is registered by one platform admin |

## V5 Validation, sanitization and encoding

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 5.1 Input validation | Met | zod schemas with length caps on every `/api` route (`parseBody`, `http/middleware.ts:362`), JSON bodies capped at 256 kB (`http/app.ts:106`), form bodies at 64 kB or 1 MB with parameter limits (`routes/federation-public.ts:71-72`); repeated OAuth parameters refused; allow-lists for URLs and redirect URIs (`federation/oidc.ts:328`, `routes/federation-public.ts:28`) | |
| 5.2 Sanitization and sandboxing | Partly | Guardrail regexes use RE2 (`guardrails/regex.ts`); child processes use argument arrays with no shell (`media/runner.ts:51`, `scripts/runner.ts:93`, `knowledge/sources.ts` git); scripts run in a network-less, read-only, capability-free container | 5.2.6 (SSRF): MCP servers, upstream IdPs, mirrors, the staging hook and ACME are checked after DNS with connect-time pinning (`mcp/hosts.ts`), workflow HTTP steps allow internal addresses only (`workflows/http.ts:138`), git sources refuse link-local hosts (this review); since 1.2.0 pool instances, zone health endpoints, image backends and the trainer refuse metadata, link-local and unspecified addresses at save and at connect (`platform/egress.ts`, B-901; tests "a pool instance pointing at 169.254.169.254 is refused…", "checks again when connecting…" in `sprint18.test.ts`), `mcp/hosts.ts` also refuses 100.100.100.200, 192.0.0.192 and fd00:ec2::254, and SQL user stores dial the checked address and re-check it per connection (B-809; test "dials the address it checked, and refuses a name that re-resolves to a link-local address" in `sprint17.test.ts`); connections are internal-only with the metadata addresses refused too. Git's own DNS lookup is not pinned to the checked address |
| 5.3 Output encoding and injection prevention | Met | Knex bound parameters; the only interpolated SQL uses validated collection names and numeric dimensions (`platform/vectors.ts:49`, `:143`); LDAP filter escaping (`identity/providers/ldap.ts:9`, tests "escapes filter metacharacters"); HTML escaping on server-rendered pages (`routes/federation-public.ts:23`); model output rendered as text in the console | |
| 5.4 Memory, string and unsafe code | Met | Node.js memory-safe runtime; native modules limited to argon2, better-sqlite3 and RE2 | |
| 5.5 Deserialization prevention | Met | JSON only with `strict: true`; the SAML XML parser refuses DOCTYPE and entity declarations and caps depth (`federation/xml.ts:135`, `:205`) and inflation (`federation/saml.ts:203`) (5.5.2); pickle model checkpoints refused (`gateway`); YAML from admin input (guardrail rules, identity configuration) is parsed with the default (safe) schema and, since 1.2.0, with size, depth, node and alias caps (`platform/yaml.ts`, B-907): rules take no aliases, the identity file at most 50; test "a billion-laughs YAML is refused, for guardrail rules and for the identity file" (`sprint18.test.ts`) | |

## V6 Stored cryptography

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 6.1 Data classification | Met | Labels on conversations, attachments, knowledge and exports; tenant content sealed at rest (`platform/datakeys.ts`) | |
| 6.2 Algorithms | Met | AES-256-GCM with row-bound associated data (`platform/datakeys.ts:125-140`, `crypto/index.ts:21`), HMAC-SHA-256, argon2id, ES256 and RS256 signatures; no ECB, CBC or MD5 for security (MD5 appears only as a feature hash in `guardrails/linear.ts:18`) | |
| 6.3 Random values | Met | `crypto.randomBytes` for tokens, keys, nonces and codes (`crypto/index.ts:7`); the one security-adjacent `Math.random` (the password-timing dummy) replaced (this review) | |
| 6.4 Secret management | Partly | OpenBao transit adapter for key-encryption keys (`platform/kms.ts`), secrets as files (`config/index.ts:7`), secret references in configuration (`identity/secrets.ts`); since 1.1.0, with OpenBao, OIDC and SAML signing happens in transit (`federation/keys.ts`, B-408), and `kms:rewrap` moves every data key, checkpoint signature and backup to a new key-encryption key (`platform/rewrap.ts`, B-407); tests in `sprint14.test.ts` (with `fake-openbao.ts`) and `sprint15-ops.test.ts` | 6.4.2: with `KMS_PROVIDER=local` the key-encryption key is `DATA_KEY` in process memory and the signing keys are unsealed in memory; the SAML SP decryption key for upstream encrypted assertions is sealed locally even with OpenBao |

## V7 Error handling and logging

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 7.1 Log content | Met | Authorization and cookie headers, CSRF tokens, passwords, secrets, tokens and codes redacted, and credential-bearing query parameters removed from logged URLs (`observability/index.ts:9-58`, this review); session ids in audit are HMACs, never tokens | |
| 7.2 Log processing | Met | Every sign-in success and failure, MFA step, and access-control denial is audited (`routes/auth.ts`, `http/middleware.ts:347`); tests "writes sign-ins to the audit chain", "keeps members out of admin routes and audits the denial" | |
| 7.3 Log protection | Met | pino writes JSON (no log injection through newlines); the audit chain is append-only and hash-linked with KMS-signed checkpoints, and verification is read-only (`audit/chain.ts`, `audit/checkpoints.ts`, tests in `audit.test.ts`); time from the server clock with skew measured against the database and, since 1.1.0, against NTP when `NTP_SERVER` is set (`platform/ntp.ts`, `ops/service.ts`; tests "measures the offset by SNTP…", "shows NTP skew on the platform status" in `sprint15-access.test.ts`) | The SNTP query is unauthenticated (no NTS); it is a check, not a time source |
| 7.4 Error handling | Met | One error handler returns RFC 9457 problems with a trace id and a generic message for unexpected errors (`http/app.ts:165-180`); public readiness, federation error pages and userinfo no longer echo internal errors (this review); since 1.2.0 diagnostic messages, health details and every problem detail are masked for credentials before they leave the server (7.4.1, B-907, `platform/diagnostics.ts`: known secret values, credentials in URLs, secret-named keys, authorization values, private-key blocks); test "a driver message with a password shows it masked" (`sprint18.test.ts`) | Admin-only diagnostic routes (store tests, MCP and connection checks, `routes/admin/identity.ts:125`, `routes/admin/federation.ts:474`) still show driver messages, masked, to identity and platform admins by design |

## V8 Data protection

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 8.1 General data protection | Met | No sensitive data cached server-side outside the sealed stores; `no-store` on every API answer (this review) and on federation pages; backups are sealed and drilled (`ops/backups.ts`) and, since 1.1.0, include the blob store (8.1.6, `PLATFORM_BACKUP_BLOBS`, on by default) and restore into an empty database with `backup:restore` (`ops/restore.ts`); test "restores a backup into an empty database and blob store, and the app starts on it" (`sprint15-ops.test.ts`) | KMS key material is backed up with the KMS's own tooling |
| 8.2 Client-side data protection | Met | `Cache-Control: no-store` on API and protocol answers (`http/app.ts:105`, `routes/federation-public.ts:87`); the console stores only the theme and a signed-in flag, and the federation resume address in `sessionStorage` | |
| 8.3 Sensitive private data | Met | Tokens and secrets never in URLs except where OAuth and SAML require them (codes, SAML messages), and those are redacted from logs (this review); exports clearance-gated and audited; offboarding destroys keys then purges (`tenancy/offboarding.ts`); memory export and forget (`memory/service.ts`); since 1.1.0 a tenant retention period deletes idle conversations with their messages, buffers and unused attachments on a schedule and audits each purge (8.3.4, 8.3.8, `chat/service.ts` retention, `chat.retention` job; test "purges conversations past the tenant retention period, and audits it (B-206)" in `sprint12.test.ts`) | Since 1.2.0 retention can also be set per workspace and per user, and the shortest applicable period wins (B-707; test "a workspace with a shorter retention period purges its conversations first (B-707)" in `sprint16.test.ts`) |

## V9 Communication

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 9.1 Client communication security | Partly | Production refuses non-HTTPS cookies (`config/index.ts:242`); HSTS one year with subdomains behind HTTPS (`http/app.ts` Helmet `strictTransportSecurity`); `upgrade-insecure-requests` | TLS termination is the reverse proxy's or ingress's job; the app does not itself enforce TLS versions or cipher suites (documented in `docs/deploy.md`) |
| 9.2 Server communication security | Met | Outbound TLS verifies certificates everywhere (`rejectUnauthorized: true` in `identity/providers/ldap.ts:50`, `gateway/ollama.ts:121`, `connections/drivers.ts:80`; no `NODE_TLS_REJECT_UNAUTHORIZED` overrides); private CAs by file; LDAP refuses `ldap://` without StartTLS (test "refuses ldap:// without StartTLS"); mTLS to Ollama | |

## V10 Malicious code

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 10.1 Code integrity | N/A | Level 3 only | |
| 10.2 Malicious code search | Met | No phone-home or data collection; outbound calls only to configured services; no time bombs or back doors found in review (search for `Math.random`, `eval`, hidden routes) | |
| 10.3 Application integrity | Met | No auto-update; import bundles verified against signer keys before promotion (`ops/bundles.ts`); the console is served from the app's own origin with `script-src 'self'` (no third-party CDN, so no SRI needed); model blobs pinned by digest | |

## V11 Business logic

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 11.1 Business logic security | Met | Sequential flows enforced server-side (sign-in stages, lifecycles, approvals, dual control); quotas shared through the database (`tenancy/quotas.ts`); rate limits on `/api` (`API_RATE_PER_MINUTE`, 600 a minute per user or address by default), `/api/auth` (30), OAuth token endpoints (60) and browser sign-in endpoints (120, this review); since 1.1.0 they share one atomic Redis counter (a Lua script) across instances when `REDIS_URL` is set (11.1.4, `platform/ratelimit.ts`, B-406), and failed bearer, API-key and DPoP credentials are throttled to 20 a minute per address (B-111); guardrail and flag queues alert on anomalies; tests in `sprint15-access.test.ts` and `integration/operations.test.ts` | Without Redis, or while it is down, limits count per instance; the failed-credential throttle is per address, so clients behind one NAT share it |

## V12 Files and resources

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 12.1 File upload | Met | Size caps on every raw upload (`ATTACHMENT_MAX_BYTES`, `MEDIA_MAX_BYTES`, `PLATFORM_BUNDLE_MAX_BYTES`; `routes/chat.ts:117`); media duration, resolution and stream caps; decompression caps (`federation/saml.ts:203`); per-tenant quotas | |
| 12.2 File integrity | Met | Types sniffed from bytes, not names or declared types (`chat/attachments.ts:41`); ClamAV when configured (`chat/attachments.ts:103`); classification before use | |
| 12.3 File execution | Met | File names validated (`routes/chat.ts:119`) and never used as paths (blob keys are ids); git subpaths confined to the checkout (`knowledge/sources.ts` `gitItems`); no uploaded file is executed or included | |
| 12.4 File storage | Met | Uploads sealed in the blob store outside the web root, under ids, never names; since 1.1.0 media and images can be served from a separate origin that serves nothing else (`MEDIA_ORIGIN`, `media/origin.ts`) | |
| 12.5 File download | Met | Server-chosen content types with `nosniff` and `Content-Disposition` (`routes/media.ts`, `routes/images.ts`); filenames sanitised (`routes/media.ts:18`, `routes/admin/platform.ts:203`); since 1.1.0 every media file, preview and image is served with `Content-Security-Policy: sandbox` (12.5.2, `media/origin.ts` `SANDBOX_CSP`, B-413); tests "serves media and previews with a sandbox CSP and nosniff…", "sandboxes media on the application origin when no media origin is set" (`sprint15-access.test.ts`) | |
| 12.6 SSRF protection | Partly | See 5.2.6: allow-lists and post-DNS checks with connect pinning for MCP, federation and platform operations; internal-only workflow HTTP; git refuses link-local hosts (this review) | Since 1.2.0 operator-chosen service URLs refuse metadata, link-local and unspecified addresses at save and at connect (`platform/egress.ts`, B-901), with `SERVICE_ALLOWED_HOSTS` as the explicit allow-list; public addresses stay allowed for them unless `SERVICE_INTERNAL_ONLY` is set, and git's DNS lookup is not pinned (see 5.2) |

## V13 API and web service

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 13.1 Generic web service security | Met | One encoding (UTF-8 JSON), admin URLs under `/api/admin` with MFA-gated permissions, API keys in the `Authorization` header only, authorization checked per request (not only per URL) | |
| 13.2 RESTful web service | Partly | HTTP methods match actions; zod validates every JSON body; `Content-Type` of JSON routes enforced by `express.json`; CSRF tokens plus `Origin` for cookie sessions; OAuth and SAML endpoints validate their own inputs | 13.2.5 met; 13.2.6: message headers are not signed (not needed for TLS-protected, bearer-authenticated calls) |
| 13.3 SOAP web service | N/A | No SOAP or XML web services beyond SAML, which is covered in 5.5 | |
| 13.4 GraphQL | N/A | No GraphQL endpoints | |

## V14 Configuration

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 14.1 Build and deploy | Met | Repeatable builds (`npm ci`, Dockerfile), CI gates, non-root read-only container with dropped capabilities and `no-new-privileges`, systemd sandbox (`deploy/`), Helm chart | |
| 14.2 Dependency | Partly | Lockfile, `npm audit` and Trivy in CI, Dependabot, CycloneDX SBOM (`.github/workflows/ci.yml:89-120`); the console has no third-party assets | 14.2.4: dependency provenance (signatures) is not verified; 14.2.6: sandboxing of third-party libraries is not attempted |
| 14.3 Unintended security disclosure | Met | Generic 500 answers with trace id (`http/app.ts:174`); `X-Powered-By` off (`http/app.ts:46`); debug off in production (pretty logs only when asked); `/metrics` needs a token and is off in production without one (`routes/health.ts`); `/readyz` no longer echoes errors (this review) | |
| 14.4 HTTP security headers | Met | Helmet on every answer, including root-mounted federation and ACME routes (applied before them in `http/app.ts:70`): CSP with `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; HSTS behind HTTPS; UTF-8 content types; test "sends security headers and a trace id" | `style-src 'unsafe-inline'` is needed for element style attributes set by the console |
| 14.5 HTTP request header validation | Met | Only the methods each route defines; `Origin` checked on state changes (`http/middleware.ts:306`) and on Socket.io handshakes (`realtime/socket.ts`); CORS `*` only on discovery and JWKS, which carry no credentials | |

## Follow-ups not fixed

The 1.0 review listed ten follow-ups. Release 1.1.0 closed eight of them: step-up re-authentication (3.7.1, Sprint 11),
password change, admin reset and forced change (2.1.5, 2.1.6, 2.3.1, 3.3.3, Sprint 11), the breached-password check
(2.1.7, Sprint 11), shared rate limits and the failed-credential throttle (11.1.4, 2.2.1, Sprint 15), security notices
(2.2.3, Sprint 11), sandboxed media (12.5.2, Sprint 15), conversation retention (8.3.8, Sprint 12) and connected
applications (3.5.1, Sprint 14). Release 1.2.0 closed new-sign-in notices (2.2.3, Sprint 17), the strength meter
(2.1.8, Sprint 17), YAML caps (5.5, Sprint 18), masked diagnostics (7.4.1, Sprint 18) and gVisor for scripts (1.14.5,
Sprint 19), and narrowed the first two items below. These remain:

1. Pinning git's connection to the checked address (5.2.6, 12.6.1). Operator-chosen service URLs are checked at save
   and at connect since 1.2.0 (Sprint 18), and SQL user stores dial the checked address (Sprint 17).
2. Backend TLS on by default (1.9.1, 9.2.2). `REQUIRE_BACKEND_TLS` (Sprint 18) refuses plaintext database, Redis, S3
   and OpenBao links in production, but only when the operator turns it on.
3. Key material outside the process with `KMS_PROVIDER=local`, and the SAML SP decryption key in the KMS (6.4.2);
   OpenBao covers key-encryption keys and signing.
4. The breached-password check on by default where a mirror or the offline file is available (2.1.7).
5. A written threat model per feature (1.1.2).
