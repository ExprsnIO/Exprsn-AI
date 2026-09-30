# Changelog

## 1.1.0

Sprints 11 to 15: the [1.1.0 backlog](Backlog-1.1.0.md), which closes most of the known gaps and ASVS follow-ups of
the release candidate and adds the platform features the 1.0 review found missing. Sprint details are in
[Sprints.md](Sprints.md); the remaining gaps are in [docs/security.md](docs/security.md), [docs/asvs.md](docs/asvs.md)
(now 50 groups met, 14 partly, 7 not applicable) and [docs/accessibility.md](docs/accessibility.md).

### Account and security
- Password change for local accounts in Settings: the current password is required, reuse is refused, and every other
  session and OAuth grant ends.
- Admin password reset (a temporary password or an emailed single-use link) and email invitations; admin-set and reset
  passwords must be changed at the next sign-in, after the second factor.
- Password reset by email from the sign-in screen: the same answer whether or not the account exists, a single-use
  token stored as a digest, throttled; a reset ends sessions and grants and lifts a lockout.
- Breached-password check against the HIBP range API (only a five-character prefix leaves) or an offline file
  (`BREACHED_PASSWORDS`, off by default).
- Step-up re-authentication for creating API keys, removing factors and regenerating recovery codes
  (`STEPUP_WINDOW_SECONDS`).
- Security notices in the console and by email for password, factor, recovery-code, API-key, session and grant
  changes and admin resets; plain-text and HTML email templates with every value escaped.

### Chat
- Output guardrails while an answer streams: text is released a sentence at a time, after the deterministic
  `model-output` rules have screened it; a block stops the model.
- `require-approval` on an answer holds it for review in the Flags queue until a reviewer approves or rejects it.
- Resumable streams across instances: a client catches up from any instance, and an interrupted answer can be
  continued.
- Agent memory write-back through the memory checkpoint, under each agent's memory policy.
- Citations keep the quoted passage; Sources show it within the reader's clearance.
- Conversation retention per tenant, purged by the `chat.retention` job and audited.

### Integrations
- OpenAI-compatible API at `/v1` (models, chat completions with streaming and tools, embeddings) with the same
  profiles, clearance, quotas, guardrails and metering as chat; OAuth tokens scoped `inference:invoke:<profile>` are
  bound to those profiles.
- Signed webhooks for audit actions, job states, flags and approvals, delivered as jobs with retries and a
  per-endpoint breaker, with a delivery log and replay; per-tenant allowed hosts for webhooks and workflow HTTP steps.
- Prompt library of versioned templates with variables, per workspace or tenant, with a picker in chat.
- Read-only conversation sharing with a person, a workspace or an expiring link; Markdown and JSON conversation export.
- Billing: price books, monthly statements from the usage meter, CSV and JSON export, and an optional Stripe invoice
  push.

### Federation
- Connected applications in Settings: users see and remove the applications they allowed.
- Access-token revocation (RFC 7009) through a shared deny-list, and introspection (RFC 7662).
- RP-initiated, front-channel and back-channel logout; `prompt=login` and `max_age`.
- Pushed authorization requests and signed request objects; DPoP sender-constrained tokens.
- SAML single logout in both directions, and encrypted assertions (AES-GCM with RSA-OAEP).
- With OpenBao, OIDC and SAML signing in transit, so no private signing key is in the process.

### Operations
- Rate limits, a throttle on failed bearer credentials (20 a minute per address) and the denial cap share one atomic
  Redis counter across instances.
- `kms:rewrap` moves every data key, checkpoint signature and backup to a new `DATA_KEY` or KMS.
- ACME dns-01 through a signed webhook or RFC 2136 with TSIG, wildcards included; issued certificates are written to
  `ACME_CERT_DIR` on every instance.
- Streamed backups that include the blob store, and `backup:restore` into an empty database; streaming blob stores
  with S3 multipart uploads for large import bundles.
- `PLATFORM_BUNDLE_REQUIRE_CHECKS` makes the bundle scan and staging steps mandatory; signer keys are under dual
  control.
- Media and images served with `Content-Security-Policy: sandbox`, optionally from a separate `MEDIA_ORIGIN`.
- Clock skew against NTP on the platform status; zones enforced when MCP servers and connections are registered.
- MySQL data connections, read-only, and OpenBao dynamic database credentials.

### Accessibility
- The accessibility mode is stored per user and follows them to another browser.
- `UI.tabs` implements the full ARIA tabs pattern with arrow keys, Home and End.
- Move buttons for workflow steps and Up and Down buttons for classifier levels (WCAG 2.5.7).
- The Chat title is an `h1`.

### Testing
- 411 unit and API tests (1 skipped) across 31 files, with new suites `account.test.ts`, `sprint12.test.ts`,
  `sprint13.test.ts`, `sprint14.test.ts`, `sprint15-access.test.ts` and `sprint15-ops.test.ts`, and fakes for mail and
  the HIBP range API, webhook receivers, Stripe, OpenBao transit and DNS.
- `integration/operations.test.ts`: shared limits across two instances on Redis, and streamed backups restored into
  PostgreSQL and MySQL.
- The test harness serves each app on 127.0.0.1 before SuperTest sees it (`test/loopback.ts`,
  `test/setup-loopback.ts`), which fixes a port-shadowing flake on macOS.

### Upgrade notes
- Migrations `013_account` to `017_ops` run on start (`DB_MIGRATE_ON_START`) or with `exprsn-ai migrate`.
- Chat answers now stream a sentence at a time when `model-output` rules apply (the platform baseline has them), because
  each sentence is screened before it is sent.
- `POST /platform/signers` answers `202` with a proposal once any signer key exists (the first key is still added at
  once, `201`), and revoking a key answers `202`; a second platform admin approves.
- New permissions `webhooks:manage`, `prompts:manage`, `billing:read` and `billing:manage`. Tenant admins get the first
  three, knowledge curators get `prompts:manage`, and system admins hold all of them.
- New settings, all optional with safe defaults: breached passwords (`BREACHED_*`), step-up and password links
  (`STEPUP_WINDOW_SECONDS`, `PASSWORD_RESET_*`, `PASSWORD_INVITE_HOURS`), chat streams and retention
  (`CHAT_STREAM_LEASE_SECONDS`, `CHAT_RETENTION_SWEEP_MINUTES`), `/v1` (`OPENAI_STREAM_MODE`), webhooks (`WEBHOOK_*`),
  billing (`BILLING_*`, `STRIPE_*`), DPoP (`DPOP_PROOF_MAX_AGE_SECONDS`), key re-wrap (`DATA_KEY_PREVIOUS`,
  `KMS_PREVIOUS_PROVIDER`), bundles and backups (`PLATFORM_BUNDLE_REQUIRE_CHECKS`, `PLATFORM_BACKUP_BLOBS`), ACME
  (`ACME_CHALLENGE`, `ACME_DNS_*`, `ACME_CERT_DIR`), media (`MEDIA_ORIGIN`, `MEDIA_URL_TTL_SECONDS`), NTP (`NTP_SERVER`,
  `NTP_TIMEOUT_MS`) and OpenBao database credentials (`OPENBAO_DATABASE_MOUNT`). See [docs/deploy.md](docs/deploy.md).
- New CLI commands: `kms:rewrap` and `backup:restore`.
- Backups now include the blob store by default (`PLATFORM_BACKUP_BLOBS=true`), so they are larger; set it to `false`
  to keep database-only backups.

## Pre-1.0 review fixes

Fixes from the pre-1.0 codebase review, made after `1.0.0-rc.1` and included in 1.1.0.

### Security
- Secret references (`env:`, `file:`) in user stores and upstream IdPs are confined by the operator: `env:` names must
  be on `SECRET_REF_ENV`, `file:` paths inside `SECRET_REF_DIRS`, and the server's own settings and secret files are
  never readable. **Upgrade note:** list the variables your identity YAML references in `SECRET_REF_ENV` (the dev
  Compose file sets `DEV_*`); `file:/run/secrets/...` references keep working.
- LDAP and SQL user stores must be internal hosts unless `IDENTITY_ALLOWED_HOSTS` names them; a SQLite store cannot be
  the application's database. Data connections get the same confinement (`CONNECTIONS_ALLOWED_HOSTS`); PostgreSQL and
  LDAP dial the checked address and OpenSearch never follows redirects.
- A chat stream can only be resumed through the conversation it belongs to.
- Sign-in, "Test a login" and second-factor attempts reserve their place in the lockout count before the credential is
  checked, so parallel requests cannot exceed it.
- Ending someone's session (Users, Sessions, Federation) or OAuth grant needs roles that could grant theirs.
- Tool results pass the `context` guardrail checkpoint before the model sees them.
- A message cannot raise a conversation above its workspace's ceiling.
- Scheduled training jobs run with their owner's current roles and are skipped when the owner is disabled, gone or no
  longer allowed to submit.
- Authorisation denials are capped per principal (20 a minute in full, then one summary event).
- CI actions, kubeconform and base images are pinned by SHA, checksum and digest.

### Reliability
- One instance with unreadable mTLS files no longer stops gateway polling for every instance.
- Bootstrap no longer fails at start when a workspace the identity file declares has been archived.
- A response that fails after it started streaming is closed at once instead of waiting for the request timeout.
- Data-key rotation reaches every instance (a bus event, and the active key is re-read at least every five minutes).
- A throwing event-bus listener no longer breaks the publisher or other listeners.
- The gateway queue no longer adds an abort listener per wait round.
- The Compare screen detaches its socket listeners and timers when you leave it.

### Other
- Audit and usage exports are written and downloaded in sealed parts instead of in memory.
- User creation is one transaction; tenant-wide session revocation lives in `SessionService`.
- The Users and Tenants lists no longer query per row.
- The CI parse check covers `web/js/federation.js`.
- New Playwright specs for refusal states (a user store referencing a server secret, a connection to a public host).

## 1.0.0-rc.1

The first release candidate: every screen of the design prototype backed by the server. Sprint details are in
[Sprints.md](Sprints.md); the open items are the known gaps in [docs/security.md](docs/security.md), the follow-ups in
[docs/asvs.md](docs/asvs.md) and the gaps in [docs/accessibility.md](docs/accessibility.md).

### Sprint 10: hardening
- Helm chart (`deploy/helm/exprsn-ai`) with a hardened Deployment, migrations as an init container or hook Job,
  secrets from existing Kubernetes Secrets, and default-deny NetworkPolicies mirroring the zones.
- CI: npm audit, CycloneDX SBOMs of the workspace and the image, a Trivy image scan, Helm lint and render, the
  streaming load test and the Playwright console suite; Dependabot. The runtime image no longer ships npm, yarn or
  corepack.
- The OWASP ASVS 4.0.3 level 2 assessment (`docs/asvs.md`) and its fixes: `no-store` on every API answer, no internal
  errors on public pages, rate limits on the public sign-in endpoints, redaction of codes and tokens in request logs, a
  local-account password policy, protection of an admin's last second factor, the old session ended on a new
  password sign-in, and link-local hosts refused for git sources.
- Accessibility: Standard (AA) and Enhanced (AAA) modes, landmarks and skip link, labelled fields, accessible dialogs,
  popovers, toasts and command palette, focus management.
- Streaming load test (`server/loadtest/stream.ts`, `docs/loadtest.md`) and runbooks for backup and restore, incident
  response and upgrades (`docs/runbooks/`).
- Fixes: the Connections screen no longer fails to render when no connection is registered; "Test a login" counts
  directly granted roles; page loads no longer count against the sign-in rate limit.

### Sprint 9: training, zones, platform, federation
- Training: datasets with PII scrub, approval by a second ML admin for confidential data, training windows, a
  fair-share queue, checkpoints and resume, evals per hardware class, GGUF conversion to a draft model.
- Zones: versioned zone definitions with dual control, ceilings enforced by the gateway, rendered NetworkPolicy,
  Compose and nftables, endpoint health.
- Platform: signed import bundles verified in seven steps, mirrors, ACME certificates, data key rotation, backups and
  restore drills (`backup:create`, `backup:restore-drill`).
- Identity: OIDC provider (ES256 JWKS with rotation, clients, PKCE, refresh rotation, device flow, token exchange),
  SAML IdP, upstream OIDC and SAML user stores, Kerberos SPNEGO; OAuth access tokens accepted by the API.

### Sprints 0 to 8
Foundations, identity and access, tenancy and audit, the Ollama gateway, chat and compare, guardrails, knowledge,
memory and connections, the registry, MCP servers, agent runs and scripts, workflows, media and images. See
[Sprints.md](Sprints.md).
