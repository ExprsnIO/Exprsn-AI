# Backlog: 1.1.0

The work planned after `1.0.0-rc.1`. It closes the known gaps listed in [docs/security.md](docs/security.md),
[docs/asvs.md](docs/asvs.md) and [docs/accessibility.md](docs/accessibility.md), and adds the platform features a
1.0 review found missing. Each item names its acceptance test.

## Using exprsn-platform

Where `/Volumes/Storage/exprsn-platform` already solves a problem, its **backend** design is ported. Its
**UI and CSS are never imported**. Console work follows this repository's `web/` conventions and
`design/prototype/CONTRACT.md`.

exprsn-platform is CommonJS, Express 4 and Sequelize. Nothing is copied verbatim. Each item re-implements the design
in strict TypeScript on Knex, and follows the rules in `docs/PLAN.md`: zod, explicit permissions, tenant from the
session, audit, problem+json, sealed tenant content, and cross-instance effects through `s.bus`. Its licence is MIT
(same holder). The **Source** column cites the files each port starts from. **Fixes** lists the weaknesses the port
must not carry over.

## Sprints

| Sprint | Theme | Migration | Status |
| --- | --- | --- | --- |
| 11 | Account self-service and security notifications | `013_account` | **Done** |
| 12 | Chat: streaming guardrails, held turns, resumable streams, agent memory | `014_chat_hold` | **Done** |
| 13 | Integrations: OpenAI-compatible API, webhooks, prompt library, sharing, export, billing | `015_integrations` | **Done** |
| 14 | Federation: OAuth grants and revocation, logout, PAR, DPoP, SAML SLO, KMS signing | `016_federation2` | **Done** |
| 15 | Operations: shared rate limits, key re-wrap, ACME dns-01, backups, streaming blobs, zones, connections | `017_ops` | **Done** |

**Status (1.1.0).** Every item from B-101 to B-504 is delivered; what each sprint built and its tests are in
[Sprints.md](Sprints.md). B-601 (tag `v1.0.0`, publish the image and chart) is left to the maintainers. B-602 is done:
the version is `1.1.0`, and the CHANGELOG, `docs/api.md` and the known gaps are updated.

---

## Sprint 11: Account self-service and security notifications

| ID | Item | Source (exprsn-platform) | Fixes | Done when |
| --- | --- | --- | --- | --- |
| B-101 | Self-service password change for local accounts: current password, policy check, rejects reuse of the current password, revokes the user's other sessions | `services/auth/src/routes/auth.js` `POST /change-password` | Also revoke other sessions and OAuth grants | Changing the password ends every other session; a wrong current password counts toward the lockout |
| B-102 | Admin password reset: an identity admin sets a temporary password or sends a reset link; the account is marked `password_must_change` | `services/auth/src/services/inviteService.js` (hashed single-use token) | — | Admin reset is audited; the old password stops working |
| B-103 | Forced change at first sign-in: an admin-set or reset password puts the session in a `password` stage that can only change the password | none (new) | — | A user with `password_must_change` gets no `/api` access other than the change route |
| B-104 | Password reset by email: request by username or email with the same answer whether or not the account exists; sha256-hashed, single-use, 1-hour token; throttled | `routes/auth.js` `forgot-password` / `reset-password`, `inviteService.js` | The source stores the token in plaintext and returns it in development; store only the hash; revoke sessions on reset | The token works once, expires, and never appears in logs or responses |
| B-105 | Breached-password check: HIBP k-anonymity range API (only the SHA-1 prefix leaves), an offline corpus file, or both (`BREACHED_PASSWORDS=off\|hibp\|file`); fails open with an audit event when HIBP cannot be reached | none (new) | — | A known-breached password is refused; the full hash is never sent (ASVS 2.1.7) |
| B-106 | Step-up re-authentication: sensitive account changes (API key create, factor removal, recovery-code regeneration, password change, grant revocation) need a factor or password within `STEPUP_WINDOW_SECONDS` (default 300); `POST /api/me/step-up` | `oidcService.js` `auth_time` (tracked only) | Enforce it | Outside the window these routes answer 401 `step-up required`; inside they succeed (ASVS 3.7.1) |
| B-109 | Security notifications (console and email) when a user's password, factors, API keys, sessions or grants change | `services/auth/src/services/emailService.js`, `templates/emails/security-alert` | The source alerts only on password change | Every listed change notifies the user; the email carries no secret |
| B-110 | Email templates: plain-text and HTML templates for reset, security alert and invite, rendered with escaping; SMTP stays the transport | `emailService.js` Handlebars templates | — | Templates escape every value |

## Sprint 12: Chat

| ID | Item | Source (exprsn-platform) | Fixes | Done when |
| --- | --- | --- | --- | --- |
| B-201 | Sentence-by-sentence output guardrails during streaming: buffer to a sentence or line boundary (or 240 characters), re-screen the whole buffer with the deterministic checks, release only screened text; block stops the generation | `services/cortex/src/engine/streamGuard.js` | — | A blocked phrase is never sent to the socket; the final check still runs on the finished answer |
| B-202 | `require-approval` holds a chat turn: the answer is stored held, a reviewer approves or rejects, and the user sees it on approval | `cortex/src/engine/jobs.js` `resolveReview`, `routes/reviews.js` | — | A held answer is invisible until approved; a rejected one is withdrawn |
| B-203 | Resumable streams across instances: stream chunks published on the bus with sequence numbers and a bounded Redis/DB buffer; a client that reconnects to any instance catches up; after the generating instance stops, the stored partial is marked interrupted and can be continued | none (new) | — | Catch-up works from a second instance; resume continues from the stored text |
| B-204 | Agent memory write-back: agent runs propose memories through the existing proposal flow (the `memory` checkpoint), subject to the agent's memory policy | none (new) | — | A run produces a proposal the owner can accept |
| B-205 | Citations store the passage (chunk id and span) with the answer; the Sources list shows it | none | — | Sources show the quoted passage, filtered by the reader's clearance |
| B-206 | Per-user conversation retention (ASVS 8.3.4): a tenant policy deletes conversations older than N days, as a scheduled job | none | — | Old conversations are purged and the purge is audited |

## Sprint 13: Integrations

| ID | Item | Source (exprsn-platform) | Fixes | Done when |
| --- | --- | --- | --- | --- |
| B-301 | OpenAI-compatible API: `GET /v1/models`, `POST /v1/chat/completions` (streaming SSE and non-streaming, tools), `POST /v1/embeddings`; API-key or OAuth bearer; profiles appear as models; guardrails, quotas, metering and audit as in chat | `cortex/src/lib/llama.js`, `backends/ollama.js` (the client side of the same wire format) | — | The official `openai` npm client can list models, chat, stream and embed |
| B-302 | Outbound webhooks: tenant subscriptions to event types (audit actions, job states, flags, approvals), HMAC-SHA256 over `timestamp.body`, a per-subscription secret shown once, retries with exponential backoff as jobs, per-endpoint circuit breaker, delivery log, replay; internal-host checks with a per-tenant allow-list | `services/plugins/src/services/webhookDispatcher.js`, `PluginDelivery` model | Deliveries run as jobs, not inline; SSRF checks | A delivery is signed and verifiable; a failing endpoint retries, then opens the breaker |
| B-303 | Per-tenant host allow-list for workflow HTTP steps and webhooks | none | — | A host outside the tenant's list is refused |
| B-304 | Prompt library: versioned prompt templates with `{{variables}}`, per workspace or tenant, label, lifecycle, use from chat and the API | none | — | A template is inserted into chat with its variables filled |
| B-305 | Conversation sharing: share a conversation read-only with users or a workspace in the tenant, or through a link with an expiry, within the conversation's label; revoke | `services/filevault` share links (reference) | Links are hashed tokens; never across tenants | A shared reader can see but not write; revocation ends access at once |
| B-306 | Conversation export: Markdown and JSON as a job, clearance-gated and audited | none | — | The export contains the active branch and citations |
| B-307 | Billing: price books per model and meter kind, monthly statements per tenant from the usage meter, CSV and JSON export, optional Stripe invoice push behind `BILLING_PROVIDER=stripe` | `src/exprsn-payments/` (legacy, reference only) | Driven by the existing meter | A month's statement totals match the usage report |

## Sprint 14: Federation

| ID | Item | Source (exprsn-platform) | Fixes | Done when |
| --- | --- | --- | --- | --- |
| B-107 | Users list and revoke their own OAuth grants and consents | `services/auth/src/routes/oauth2.js` (revocation model) | The source has no consent records | Revoking a grant ends its tokens at once (ASVS 3.5.1) |
| B-108 | OAuth token revocation (RFC 7009) and introspection (RFC 7662); access tokens individually revocable through a deny-list checked by `authenticate` | `oauth2.js` `POST /revoke`, `POST /introspect` | — | A revoked access token is refused before it expires; other clients' tokens introspect as `active:false` |
| B-401 | OIDC RP-initiated logout (`end_session_endpoint`), front-channel and back-channel logout (logout tokens to registered clients) | `oidcService.js` (advertised, not built) | Build the routes | Sign-out reaches every client with a back-channel URI |
| B-402 | `prompt=login` and `max_age` force re-authentication | none | — | An old session is asked to sign in again |
| B-403 | PAR (RFC 9126) and request objects (signed JAR, RFC 9101) | none | — | A pushed request's `request_uri` works once |
| B-404 | DPoP (RFC 9449) sender-constrained access tokens | none | — | A DPoP-bound token without a valid proof is refused |
| B-405 | SAML single logout (IdP and SP) and encrypted assertions (AES-256-GCM with RSA-OAEP) | `services/auth/src/routes/saml.js`, `config/saml.js` (`decryptionPvk`) | — | An SP's LogoutRequest ends the session; an encrypted assertion is accepted |
| B-408 | Signing in the KMS: OIDC and SAML signing through OpenBao transit when `KMS_PROVIDER=openbao`, so private keys never enter the process | none | — | With OpenBao, no private signing key is in memory |

## Sprint 15: Operations

| ID | Item | Source (exprsn-platform) | Fixes | Done when |
| --- | --- | --- | --- | --- |
| B-111 | Throttle failed bearer-token and API-key attempts per address | `shared/middleware/rateLimiter.js` | — | 20 bad bearer tokens a minute from one address get 429 |
| B-406 | Distributed rate limits: when `REDIS_URL` is set, rate limits and the denial cap use one atomic Redis counter (a Lua script), falling back to memory otherwise | `shared/middleware/rateLimiter.js`, `services/ca/middleware/rateLimit.js` | The source's sliding window is not atomic and fails open; use one Lua script | Two instances share one limit |
| B-407 | Key-encryption-key re-wrap: `kms:rewrap` re-wraps every tenant data key under a new `DATA_KEY` or KMS key without re-encrypting content | `services/vault/src/services/keyService.js` (versioned DEKs) | The source cannot re-wrap | After a re-wrap under a new key, all data reads; the old key can be removed |
| B-409 | ACME dns-01 through a DNS provider interface (RFC 2136 dynamic update and a webhook hook); certificate reload: renewal publishes an event, and a file sink writes the PEMs for the reverse proxy | `services/ca/acme/validation.js` (dns-01 TXT checks, server side) | — | A dns-01 order completes against the fake ACME server |
| B-410 | Backups of the blob store; streamed dumps (no longer held in memory); restore into a live database with a CLI command and a guard | `scripts/backup/pg-backup.sh`, `pg-restore.sh` | — | A backup restores into an empty database and the app starts on it |
| B-411 | Streaming blob path: `BlobStore.putStream`/`getStream` for filesystem and S3, used by import bundles, so `PLATFORM_BUNDLE_MAX_BYTES` can exceed 2 GiB | `services/filevault` `downloadService.streamFile` | The source buffers uploads | A 3 GiB bundle is verified with flat memory |
| B-412 | A setting that makes the bundle scan and staging steps mandatory; dual control for adding and revoking signer keys | none | — | Unscanned bundles cannot be promoted when required |
| B-413 | Sandboxed media: previews served with `Content-Security-Policy: sandbox` and optionally from a separate `MEDIA_ORIGIN` | none | — | Previews carry the sandbox header |
| B-414 | Clock skew against NTP (SNTP query to `NTP_SERVER`) alongside the database check | none | — | Platform status shows NTP skew |
| B-415 | Zones: MCP server and connection registration refuse a zone above the label ceiling or undefined | none | — | Registration outside a zone fails |
| B-416 | Data connections: MySQL driver; OpenBao dynamic database credentials | `services/vault/src/services/dynamicService.js` (a stub: creates no role) | Actually issue credentials | A MySQL connection queries read-only |

## Accessibility (built with Sprint 11)

| ID | Item | Done when |
| --- | --- | --- |
| B-501 | The accessibility mode is stored per user (profile appearance field), not per browser | The mode follows the user to another browser |
| B-502 | The full ARIA tabs pattern in `UI.tabs` (tablist, tabpanel, arrow keys) | axe and the keyboard walk pass |
| B-503 | Single-pointer alternatives for the Workflows canvas and Classifier level reorder (WCAG 2.5.7) | Both can be done with buttons |
| B-504 | Chat has an `h1` | Screen-reader heading list includes it |

## Release

| ID | Item |
| --- | --- |
| B-601 | Tag `v1.0.0` and publish the image and chart (maintainers) before 1.1 work merges to `main` |
| B-602 | Version `1.1.0`, the CHANGELOG, `docs/api.md`, and the known-gaps sections updated as each item lands |
