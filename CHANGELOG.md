# Changelog

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
