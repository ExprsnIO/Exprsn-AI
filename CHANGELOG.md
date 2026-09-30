# Changelog

## Unreleased

Fixes from the pre-1.0 codebase review.

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
