# OWASP ASVS 4.0.3 level 2 assessment

This is the Sprint 10 review of the application server (`server/src`) and its deployment files against the
[OWASP Application Security Verification Standard 4.0.3](https://github.com/OWASP/ASVS/tree/v4.0.3/4.0), level 2.
It covers the code on the `claude/determined-hawking-n7wmk1` branch as of 30 September 2026. Where the review found a
gap that was safe to close, the fix landed with it (listed under [Fixes from this review](#fixes-from-this-review),
tested in `server/test/asvs.test.ts`). The rest are follow-ups at the end of each chapter and in
[security.md](security.md#known-gaps-tracked-in-the-plan).

Statuses, per requirement group:

- **Met**: every L2 requirement in the group is satisfied by code or deployment defaults, with the evidence named.
- **Partly**: some requirements are satisfied and the rest are named as follow-ups.
- **Not met**: the group's main requirement is not satisfied.
- **N/A**: the group does not apply to this application (the reason is given).

Evidence cites `file:line` under `server/src/` unless another root is named, and test names from `server/test/`.

## Summary

| Chapter | Met | Partly | Not met | N/A |
| --- | ---: | ---: | ---: | ---: |
| V1 Architecture | 7 | 5 | 0 | 2 |
| V2 Authentication | 4 | 5 | 0 | 1 |
| V3 Session management | 3 | 3 | 0 | 1 |
| V4 Access control | 2 | 1 | 0 | 0 |
| V5 Validation, sanitization and encoding | 3 | 2 | 0 | 0 |
| V6 Stored cryptography | 3 | 1 | 0 | 0 |
| V7 Error handling and logging | 3 | 1 | 0 | 0 |
| V8 Data protection | 1 | 2 | 0 | 0 |
| V9 Communication | 1 | 1 | 0 | 0 |
| V10 Malicious code | 2 | 0 | 0 | 1 |
| V11 Business logic | 0 | 1 | 0 | 0 |
| V12 Files and resources | 3 | 3 | 0 | 0 |
| V13 API and web service | 1 | 1 | 0 | 2 |
| V14 Configuration | 4 | 1 | 0 | 0 |
| **Total (71 groups)** | **37** | **27** | **0** | **7** |

No group is "not met" outright, but several individual requirements are, and they are named in the partly rows:
self-service password change (2.1.5), a full breached-password check (2.1.7), user notification of authentication
changes (2.2.3), user revocation of OAuth grants (3.5.1), re-authentication before sensitive account changes (3.7.1),
and shared (cross-instance) rate limits (11.1.4).

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
| 1.6 Cryptographic architecture | Met | Per-tenant data keys wrapped by a KMS (`platform/datakeys.ts`, `platform/kms.ts`), key rotation by version (`cli.ts kms:rotate`), offboarding destroys keys | Key-encryption keys cannot be re-wrapped (known gap) |
| 1.7 Errors, logging and auditing architecture | Met | pino JSON logs with trace ids (`observability/index.ts`), audit hash chain with KMS-signed checkpoints (`audit/chain.ts`, `audit/checkpoints.ts`), SIEM stream (`audit/siem.ts`) | |
| 1.8 Data protection and privacy architecture | Met | Labels `public < internal < confidential < restricted` on data, clearance on users (`authz/labels.ts`); sealed content at rest | |
| 1.9 Communications architecture | Partly | Internal networks for database and Ollama in Compose (`deploy/docker/compose.yml`), mTLS per Ollama instance (`gateway/ollama.ts:121`), LDAPS with verification (`identity/providers/ldap.ts:49`) | Connections between the app and PostgreSQL/MySQL/Redis are encrypted only when the operator's URL asks for it; no setting refuses plaintext database links (1.9.1) |
| 1.10 Malicious software architecture | Met | Source control with CI gates and dependency review (Dependabot, `npm audit`) | |
| 1.11 Business logic architecture | Partly | Business flows are documented in `docs/api.md`; jobs and runs are checkpointed and idempotent (`platform/jobs.ts`) | 1.11.2 (no shared unsynchronised state): rate limits are per instance in memory (`http/app.ts:112`), so limits multiply with instances |
| 1.12 Secure file upload architecture | Partly | Uploads stored sealed in the blob store outside the web root, served with server-chosen types and `nosniff` (`chat/attachments.ts`, `routes/media.ts:21`) | Downloads of user files are same-origin (no separate download domain, 1.12.2); mitigated by server-chosen content types and CSP |
| 1.13 API architecture | N/A | Placeholder group in 4.0.3 | |
| 1.14 Configuration architecture | Partly | Container and systemd hardening (`deploy/`), Helm chart with NetworkPolicy, zod-validated configuration (`config/index.ts`); no unsupported client-side technology (1.14.6) | 1.14.5 (sandboxing) is per feature: scripts run in docker or podman without gVisor or Firecracker (known gap) |

## V2 Authentication

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 2.1 Password security | Partly | Local accounts: at least 12 and up to 256 characters, no composition rules, no truncation (argon2id), the username refused, common and service-named passwords refused (`identity/passwords.ts:46-74`); login accepts up to 1024 characters (`routes/auth.ts:16`); passwords are never logged (redaction, `observability/index.ts:9`) | 2.1.5 and 2.1.6: there is no self-service password change for local accounts, and no admin password reset (local accounts are bootstrap and break-glass accounts; directory accounts change passwords in their store). 2.1.7: the list is short and local, not a breached-password corpus (a k-anonymity or offline HIBP check is the follow-up). 2.1.8 (strength meter) and 2.1.11 (paste) are console concerns |
| 2.2 General authenticator security | Partly | Lockout per account and per address in the database (`identity/lockout.ts`), 5 attempts by default (`config/index.ts:204`); `/api/auth` limited to 30 requests per minute (`http/app.ts:113`); sign-in and callback pages outside `/api` limited (this review); failures and successes audited (`routes/auth.ts:94`); TOTP and WebAuthn as second factors; test "locks an account after repeated failures" | 2.2.3 (notify the user after changes to authentication details) is audited but not notified to the user |
| 2.3 Authenticator lifecycle | Partly | Initial passwords are set by an admin under the policy (`routes/admin/users.ts:75`); TOTP enrolment is forced for admin roles on first sign-in | 2.3.1: there is no forced change of an admin-set initial password on first use; see Known gaps for first-factor enrolment |
| 2.4 Credential storage | Met | argon2id m=19456, t=2, p=1 (`identity/passwords.ts:6`), SQL stores accept only argon2 or bcrypt and never plain or unsalted digests (test "never accepts plain-text or unknown hash formats") | |
| 2.5 Credential recovery | Partly | No knowledge-based questions or password hints; recovery codes stored as HMACs and single-use (`identity/mfa.ts:166-190`); admins can reset factors, forcing re-enrolment | 2.5.2/2.5.6: there is no self-service password recovery for local accounts (by design: directory accounts recover in their store) |
| 2.6 Look-up secret verifier | Met | Ten recovery codes, random, HMAC'd at rest, each usable once (`identity/mfa.ts:170`); test "accepts a recovery code once" | |
| 2.7 Out-of-band verifier | N/A | No SMS, email or push authenticators | |
| 2.8 One-time verifier | Met | TOTP 30 s step, window 1, single use per step (`identity/mfa.ts:16`, `:98`), sealed seeds; five failures end the pending session (`routes/auth.ts:59`); test "requires TOTP on later sign-ins and rejects a replayed code"; the last factor of an admin cannot be removed (this review) | |
| 2.9 Cryptographic verifier | Met | WebAuthn passkeys with signature counters and origin and RP ID checks (`identity/mfa.ts:130-160`) | |
| 2.10 Service authentication | Partly | API keys are 256-bit, HMAC'd, scoped, expiring (`identity/apikeys.ts:55`); OAuth client secrets shown once and stored as digests (test "shows a client secret once and stores only its digest"); service secrets passed as files | Signing keys are sealed with the platform data key rather than held in the KMS (known gap) |

## V3 Session management

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 3.1 Fundamental session management | Met | Session tokens only in cookies, never in URLs (`http/middleware.ts:200-217`) | |
| 3.2 Session binding | Met | 256-bit random tokens (`identity/sessions.ts:178`), HMAC'd in the database; rotated when a factor completes (`identity/sessions.ts:224`); a new sign-in revokes the session the browser held (this review, `routes/auth.ts:124`) | |
| 3.3 Session termination | Partly | Logout revokes server-side (`routes/auth.ts:223`); idle 30 min and absolute 12 h timeouts (`config/index.ts:200-201`); users see and revoke their sessions (`routes/me.ts:90-110`); disabling a user ends sessions and keys (test "disables a user and ends their sessions and keys") | 3.3.3: no password change exists to offer "sign out other sessions" after it (the separate "revoke others" action exists) |
| 3.4 Cookie-based session management | Met | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` (`http/middleware.ts:202-209`); production refuses non-HTTPS cookies (`config/index.ts:242`); the upstream-federation cookie is `HttpOnly`, `Lax` (or `None; Secure` for SAML POST) and lives 10 minutes | |
| 3.5 Token-based session management | Partly | OAuth access tokens are ES256 JWTs with `typ at+jwt`, audience and tenant checks, and live-grant checks (`federation/oidc.ts:706-717`, `federation/service.ts:100`); refresh tokens rotate with family revocation (test "rotates refresh tokens and revokes the family…"); clients revoke through RFC 7009 and admins disable clients with their tokens | 3.5.1: users cannot list or revoke the OAuth grants and consents they gave to applications themselves (only by admins disabling the client or the user); access tokens are not individually revocable (known gap; at most 30 minutes) |
| 3.6 Federated re-authentication | N/A | Level 3 only | |
| 3.7 Defenses against session management exploits | Partly | Admin roles need an MFA-verified session for every admin request (`http/middleware.ts:343`); API keys cannot create keys or manage factors (test "cannot create keys or manage factors with a key") | 3.7.1: creating API keys, removing factors and regenerating recovery codes need a signed-in browser session but no fresh re-authentication (step-up with a recent-MFA window and a console prompt is the follow-up) |

## V4 Access control

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 4.1 General access control design | Met | Enforced server-side on every route with deny by default (`http/middleware.ts:318-360`); the tenant always comes from the principal; tests in `policy.test.ts` and "keeps members out of admin routes and audits the denial" | |
| 4.2 Operation level access control | Met | Resource ownership checked in services (for example `routes/me.ts:81`, `routes/chat.ts:133`); CSRF tokens bound to the session plus `Origin` checks (`http/middleware.ts:302`); tests "refuses state changes without the CSRF token", "refuses cross-origin state changes" | |
| 4.3 Other access control considerations | Partly | Admin interfaces need MFA (`authz/permissions.ts` `requiresMfa`); grant rules stop escalation (`routes/admin/users.ts:77-79`); directory listing is off (static files only from `WEB_ROOT`) | 4.3.1 is met for admin roles; dual control covers baseline guardrails, zones and model approval, but adding or revoking a bundle signer key is single-person (known gap) |

## V5 Validation, sanitization and encoding

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 5.1 Input validation | Met | zod schemas with length caps on every `/api` route (`parseBody`, `http/middleware.ts:362`), JSON bodies capped at 256 kB (`http/app.ts:106`), form bodies at 64 kB or 1 MB with parameter limits (`routes/federation-public.ts:71-72`); repeated OAuth parameters refused; allow-lists for URLs and redirect URIs (`federation/oidc.ts:328`, `routes/federation-public.ts:28`) | |
| 5.2 Sanitization and sandboxing | Partly | Guardrail regexes use RE2 (`guardrails/regex.ts`); child processes use argument arrays with no shell (`media/runner.ts:51`, `scripts/runner.ts:93`, `knowledge/sources.ts` git); scripts run in a network-less, read-only, capability-free container | 5.2.6 (SSRF): MCP servers, upstream IdPs, mirrors, the staging hook and ACME are checked after DNS with connect-time pinning (`mcp/hosts.ts`), workflow HTTP steps allow internal addresses only (`workflows/http.ts:138`), git sources refuse link-local hosts (this review); pool instances, zone health endpoints, connections, image backends and the trainer are operator-chosen URLs without an address check. Git's own DNS lookup is not pinned to the checked address |
| 5.3 Output encoding and injection prevention | Met | Knex bound parameters; the only interpolated SQL uses validated collection names and numeric dimensions (`platform/vectors.ts:49`, `:143`); LDAP filter escaping (`identity/providers/ldap.ts:9`, tests "escapes filter metacharacters"); HTML escaping on server-rendered pages (`routes/federation-public.ts:23`); model output rendered as text in the console | |
| 5.4 Memory, string and unsafe code | Met | Node.js memory-safe runtime; native modules limited to argon2, better-sqlite3 and RE2 | |
| 5.5 Deserialization prevention | Partly | JSON only with `strict: true`; the SAML XML parser refuses DOCTYPE and entity declarations and caps depth (`federation/xml.ts:135`, `:205`) and inflation (`federation/saml.ts:203`); pickle model checkpoints refused (`gateway`) | 5.5.2 is met for XML; 5.5.3 is met; YAML (`yaml` package) is parsed from admin input in guardrail rules and identity configuration with the default (safe) schema, but there is no size cap beyond the 256 kB body limit |

## V6 Stored cryptography

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 6.1 Data classification | Met | Labels on conversations, attachments, knowledge and exports; tenant content sealed at rest (`platform/datakeys.ts`) | |
| 6.2 Algorithms | Met | AES-256-GCM with row-bound associated data (`platform/datakeys.ts:125-140`, `crypto/index.ts:21`), HMAC-SHA-256, argon2id, ES256 and RS256 signatures; no ECB, CBC or MD5 for security (MD5 appears only as a feature hash in `guardrails/linear.ts:18`) | |
| 6.3 Random values | Met | `crypto.randomBytes` for tokens, keys, nonces and codes (`crypto/index.ts:7`); the one security-adjacent `Math.random` (the password-timing dummy) replaced (this review) | |
| 6.4 Secret management | Partly | OpenBao transit adapter for key-encryption keys (`platform/kms.ts`), secrets as files (`config/index.ts:7`), secret references in configuration (`identity/secrets.ts`) | 6.4.2: with `KMS_PROVIDER=local` the key-encryption key is `DATA_KEY` in process memory; OIDC and SAML signing keys are unsealed in memory (known gap) |

## V7 Error handling and logging

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 7.1 Log content | Met | Authorization and cookie headers, CSRF tokens, passwords, secrets, tokens and codes redacted, and credential-bearing query parameters removed from logged URLs (`observability/index.ts:9-58`, this review); session ids in audit are HMACs, never tokens | |
| 7.2 Log processing | Met | Every sign-in success and failure, MFA step, and access-control denial is audited (`routes/auth.ts`, `http/middleware.ts:347`); tests "writes sign-ins to the audit chain", "keeps members out of admin routes and audits the denial" | |
| 7.3 Log protection | Met | pino writes JSON (no log injection through newlines); the audit chain is append-only and hash-linked with KMS-signed checkpoints, and verification is read-only (`audit/chain.ts`, `audit/checkpoints.ts`, tests in `audit.test.ts`); time from the server clock with skew measured against the database | Clock skew is measured against the database, not NTP (known gap) |
| 7.4 Error handling | Partly | One error handler returns RFC 9457 problems with a trace id and a generic message for unexpected errors (`http/app.ts:165-180`); public readiness, federation error pages and userinfo no longer echo internal errors (this review) | 7.4.1: admin-only diagnostic routes (store tests, MCP and connection checks, `routes/admin/identity.ts:125`, `routes/admin/federation.ts:474`) deliberately show driver messages to identity and platform admins; review whether any include secrets |

## V8 Data protection

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 8.1 General data protection | Partly | No sensitive data cached server-side outside the sealed stores; `no-store` on every API answer (this review) and on federation pages; backups are sealed and drilled (`ops/backups.ts`) | 8.1.6: backups cover the database only (blob store and KMS keys need their own tooling, known gap) |
| 8.2 Client-side data protection | Met | `Cache-Control: no-store` on API and protocol answers (`http/app.ts:105`, `routes/federation-public.ts:87`); the console stores only the theme and a signed-in flag, and the federation resume address in `sessionStorage` | |
| 8.3 Sensitive private data | Partly | Tokens and secrets never in URLs except where OAuth and SAML require them (codes, SAML messages), and those are redacted from logs (this review); exports clearance-gated and audited; offboarding destroys keys then purges (`tenancy/offboarding.ts`); memory export and forget (`memory/service.ts`) | 8.3.4/8.3.8: no per-user data retention schedule for conversations (tenant offboarding and manual deletion only) |

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
| 11.1 Business logic security | Partly | Sequential flows enforced server-side (sign-in stages, lifecycles, approvals, dual control); quotas shared through the database (`tenancy/quotas.ts`); rate limits on `/api` (600 per minute per user or address), `/api/auth` (30), OAuth token endpoints (60) and browser sign-in endpoints (120, this review); guardrail and flag queues alert on anomalies | 11.1.4: rate limits live in each instance's memory, so N instances allow N times the limit (a Redis-backed limiter when `REDIS_URL` is set is the follow-up); failed bearer-token attempts are answered before the `/api` limiter (keys are 256-bit, so brute force is not practical, but the attempts are not throttled) |

## V12 Files and resources

| Group | Status | Evidence | Follow-up |
| --- | --- | --- | --- |
| 12.1 File upload | Met | Size caps on every raw upload (`ATTACHMENT_MAX_BYTES`, `MEDIA_MAX_BYTES`, `PLATFORM_BUNDLE_MAX_BYTES`; `routes/chat.ts:117`); media duration, resolution and stream caps; decompression caps (`federation/saml.ts:203`); per-tenant quotas | |
| 12.2 File integrity | Met | Types sniffed from bytes, not names or declared types (`chat/attachments.ts:41`); ClamAV when configured (`chat/attachments.ts:103`); classification before use | |
| 12.3 File execution | Met | File names validated (`routes/chat.ts:119`) and never used as paths (blob keys are ids); git subpaths confined to the checkout (`knowledge/sources.ts` `gitItems`); no uploaded file is executed or included | |
| 12.4 File storage | Partly | Uploads sealed in the blob store outside the web root | Files are not stored on a separate host or domain; mitigated by sealing and server-chosen content types |
| 12.5 File download | Partly | Server-chosen content types with `nosniff` and `Content-Disposition` (`routes/media.ts:21`, `routes/images.ts:74`); filenames sanitised (`routes/media.ts:18`, `routes/admin/platform.ts:203`) | 12.5.2: media assets are served `inline` from the app origin; their types are fixed server-side (image, audio, video or `application/octet-stream`), which keeps HTML and script out, but a sandboxing `Content-Security-Policy: sandbox` on user-content responses would add depth |
| 12.6 SSRF protection | Partly | See 5.2.6: allow-lists and post-DNS checks with connect pinning for MCP, federation and platform operations; internal-only workflow HTTP; git refuses link-local hosts (this review) | Operator-chosen service URLs (pool instances, zone endpoints, connections, image backends) are trusted without an address check |

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

## Follow-ups not fixed in this sprint

These are larger than a minimal fix, or change console behaviour owned elsewhere:

1. Re-authentication (step-up) for sensitive account changes: API key creation, factor removal, recovery-code
   regeneration and session revocation should need a recent second factor (for example within 15 minutes), with a
   console prompt that re-verifies and retries (3.7.1).
2. Self-service password change for local accounts, requiring the current password, and a "sign out other sessions"
   choice after it; admin password reset with a forced change at next sign-in (2.1.5, 2.1.6, 2.3.1, 3.3.3).
3. A full breached-password check for local accounts: an offline HIBP k-anonymity range file or a larger bundled
   list (2.1.7).
4. Shared rate limits across instances (Redis-backed `rate-limiter-flexible` when `REDIS_URL` is set), and a limiter
   on failed bearer-token and API-key attempts (11.1.4, 2.2.1).
5. User notification (console and email) when a factor, API key or session set changes (2.2.3).
6. Address checks for operator-chosen service URLs (pool instances, zone endpoints, connections, image backends),
   and pinning git's connection to the checked address (5.2.6, 12.6.1).
7. `Content-Security-Policy: sandbox` on inline user-content responses (media and image previews) (12.5.2).
8. A setting that refuses plaintext connections to the database and Redis in production (1.9.1, 9.2.2).
9. Conversation retention schedules per tenant (8.3.8).
10. A "Connected applications" list where users see and revoke the OAuth grants and consents they gave (3.5.1).
