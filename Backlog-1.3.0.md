# Backlog: 1.3.0

The work after 1.2.0. It closes what `docs/security.md` "Known gaps", the Partly rows of [docs/asvs.md](docs/asvs.md)
and [docs/accessibility.md](docs/accessibility.md) still list after Sprints 16 to 19 where a fix is practical, and adds
the operational features a production install still lacks (tracing, safe upgrades, key escrow, evaluations). Rules as
before: everything follows `docs/PLAN.md` and `CLAUDE.md`; where `/Volumes/Storage/exprsn-platform` has a backend
design worth porting it is re-implemented here, never its UI or CSS. This branch starts from `main` with 1.2.0 and the
dependency fixes (PR #20).

## Sprints

| Sprint | Theme | Migration | Status |
| --- | --- | --- | --- |
| 20 | Keys and supply chain: a signer process, KMS-held webhook keys, signed messages, provenance | `022_keys` | Planned |
| 21 | AI: held prompts everywhere, a stored-response API, evaluations, sharper streaming checks, scheduled agents | `023_ai` | Planned |
| 22 | Operations: tracing, safe upgrades, key escrow, zones applied in-cluster, NTP quorum | `024_ops2` | Planned |
| 23 | Knowledge, integrations and accessibility | `025_integrations3` | Planned |

---

## Sprint 20: Keys and supply chain

| ID | Item | Done when |
| --- | --- | --- |
| B-1201 | A signer process (`exprsn-ai signer`, a separate process on a UNIX socket with its own key file, peer-credential checked) that holds the OIDC and SAML signing keys and the SAML SP decryption key for `KMS_PROVIDER=local`, so the app process never holds them (ASVS 2.10, 6.4.2); `KMS_PROVIDER=openbao` keeps transit | With `SIGNER_SOCKET` set, the app signs tokens and decrypts assertions without any private key in its memory |
| B-1202 | Webhook Ed25519 signing keys held in OpenBao transit (or the signer) instead of sealed under the tenant key | With OpenBao, a webhook signature is made in transit |
| B-1203 | HTTP Message Signatures (RFC 9421) as an option for webhooks and for `/v1` clients that want signed requests (ASVS 13.2.6) | A signed `/v1` request verifies; a tampered header is refused |
| B-1204 | Supply chain: `npm audit signatures` in CI, a SLSA build provenance attestation and a cosign signature on the image, and the SBOM attached to the release (ASVS 14.2.4) | CI fails on a package with an invalid registry signature; the image verifies with `cosign verify` in CI |
| B-1205 | `DATA_KEY` never in the environment: `DATA_KEY_FILE` required in production, and the local KMS key kept only in the signer when one runs | Production refuses `DATA_KEY` given inline when the signer is configured |

## Sprint 21: AI

| ID | Item | Done when |
| --- | --- | --- |
| B-1301 | `/v1` and compare hold a prompt that `require-approval` stops: `/v1` answers `202` with a held-request id and a polling route, compare holds both columns | A held `/v1` request completes after approval and the client fetches the answer |
| B-1302 | `POST /v1/responses` (OpenAI Responses API subset) with `store: true` saving the exchange as a conversation the user sees in chat, and `previous_response_id` threading | A response stored through `/v1/responses` appears in Chat and can be continued |
| B-1303 | Evaluations: eval sets per profile (cases with expected properties: contains, regex, JSON schema, judge rubric with a judge profile), run on demand and before a profile version is published, with scores over time | A profile version whose eval score drops below its threshold cannot be published |
| B-1304 | The full `model-output` check covers thinking as well as the answer | Thinking that a guard-model rule blocks is withheld after the answer finishes |
| B-1305 | A reader removed from a shared workspace loses an open watch at once (membership changes published on the bus) | Removing the member ends their stream without a reload |
| B-1306 | Scheduled agent runs: cron schedules on agent definitions with the owner's current roles, budgets, and a run history; skipped when the owner is disabled | A scheduled agent runs at its time with the owner's permissions |

## Sprint 22: Operations

| ID | Item | Done when |
| --- | --- | --- |
| B-1401 | OpenTelemetry tracing: OTLP/HTTP export (`OTEL_EXPORTER_OTLP_ENDPOINT`) of spans for requests, jobs, gateway calls, guardrail checks and database queries, joined to the W3C trace ids already used; no tenant content in attributes | A chat request produces one trace across HTTP, guardrails, gateway and the job, with no message text |
| B-1402 | Grafana dashboards and Prometheus alert rules in `deploy/observability/` for the existing `/metrics` | `promtool check rules` passes in CI; the dashboard JSON loads |
| B-1403 | Safe upgrades: `migrate --check` (pending migrations, destructive steps), a schema version handshake so an old instance refuses work after a newer migration, and an expand/contract rule for migrations documented and linted | An instance older than the schema stops taking jobs and says why |
| B-1404 | Key escrow: `kms:escrow` splits the local key-encryption key into k-of-n Shamir shares (printed once, each with a check value) and `kms:recover` rebuilds it; documented in the backup runbook | Three of five shares rebuild a key that opens a backup; two do not |
| B-1405 | Zones applied in-cluster: with a service account and `ZONES_APPLY=kubernetes`, rendered NetworkPolicies are applied through the Kubernetes API with server-side apply, and drift is reported | Against a fake API server, a zone change applies its NetworkPolicy and a manual edit shows as drift |
| B-1406 | NTP quorum: several `NTP_SERVER`s, the median offset, and an outlier warning (no authentication, but one spoofed server no longer hides skew) | With one lying server out of three, the reported skew is the honest one |
| B-1407 | Rate-limit health: a metric and a Platform warning while Redis is down and limits count per instance | Stopping Redis shows the warning within a minute |

## Sprint 23: Knowledge, integrations and accessibility

| ID | Item | Done when |
| --- | --- | --- |
| B-1501 | Knowledge from object storage: S3-compatible buckets (prefix, include patterns, ETag-based change detection) through the existing extraction pipeline | A file added to a fake S3 bucket is indexed; a removed one is dropped |
| B-1502 | Knowledge from internal web sites: a crawler with SSRF-safe fetching, robots.txt, sitemap support, depth and page limits, and change detection by ETag/Last-Modified | A two-level internal site is indexed within its limits and never leaves its host |
| B-1503 | Row-level access from PostgreSQL row security: a source can query as a mapped database role per group (`SET ROLE`), so the database's own policies decide | A row a policy hides from a group's role never reaches that group's chunks |
| B-1504 | Webhook order across instances: one delivery lease per ordered endpoint in the database | Ordered events raised on two instances arrive in order |
| B-1505 | Billing: proration for mid-month price changes, and Stripe refunds, credit notes and disputes reconciled | A refunded invoice marks the statement refunded with the amount |
| B-1506 | Accessibility: axe-core added to the e2e package and run on every screen and state in Standard and Enhanced, light and dark, alongside the in-page checker | The suite fails on any axe-core WCAG 2.2 A/AA violation, and on AAA contrast in Enhanced |
| B-1507 | Dialogs and drawers measured for reflow at 320 px and 200 % zoom | A Playwright check opens each screen's main dialog and drawer at 320 px without horizontal scroll |
