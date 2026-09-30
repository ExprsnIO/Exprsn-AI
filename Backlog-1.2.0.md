# Backlog: 1.2.0

The work after 1.1.0. It closes what `docs/security.md` "Known gaps", the Partly rows of [docs/asvs.md](docs/asvs.md)
and [docs/accessibility.md](docs/accessibility.md) still list after Sprints 11 to 15. Each item names its acceptance test.
Rules as for 1.1.0: everything follows `docs/PLAN.md` and `CLAUDE.md`, and where
`/Volumes/Storage/exprsn-platform` has a backend design worth porting it is re-implemented here (never its UI or CSS).

## Sprints

| Sprint | Theme | Migration | Status |
| --- | --- | --- | --- |
| 16 | Chat and AI depth: `/v1` context and tools, guard model while streaming, held prompts, live sharing, finer retention | `018_chat_depth` | **Done** |
| 17 | Identity and security, and accessibility | `019_identity3` | **Done** |
| 18 | Platform hardening: operator URL checks, TLS to backends, consistent backups, ACME, training data protection | `020_platform3` | **Done** |
| 19 | Knowledge, integrations and workflows | `021_integrations2` | **Done** |

**Status (1.2.0).** Every item from B-701 to B-1104 is delivered; what each sprint built and its tests are in
[Sprints.md](Sprints.md), and the changes are in [CHANGELOG.md](CHANGELOG.md). One item deviates from its wording:
B-1101 does not run axe-core. The Playwright suite uses an in-page checker (`e2e/tests/support/a11y.ts`) modelled on
axe's WCAG A/AA rules, because axe-core is not a dependency of the suite; it covers a subset of those rules and runs in
the Standard mode only (see [docs/accessibility.md](docs/accessibility.md#known-gaps)). What each sprint left open is
in the "Known gaps" of [docs/security.md](docs/security.md) and under "Follow-ups not fixed" in
[docs/asvs.md](docs/asvs.md).

- Sprint 16: done. Open: the final guard-model check covers the answer, not the thinking; a reader removed from a
  workspace keeps an open watch until they reconnect; `/v1` and compare refuse a prompt that would be held.
- Sprint 17: done. B-1101 as above.
- Sprint 18: done. Open: `REQUIRE_BACKEND_TLS` is off by default; an object deleted during a backup is missing from it;
  Harbor takes OCI layout tars only; the SOA primary is not followed; a streamed checkpoint is authenticated only at
  its end; the trainer's client certificate check relies on the mTLS proxy.
- Sprint 19: done. Open: row access comes from the configured column, not the database's grants; a replication slot
  holds WAL while its stream is stopped; ordered delivery is per instance; the Ed25519 key is sealed, not held in the
  KMS; Stripe refunds and disputes are not reconciled; a chat caller of a paused workflow tool gets an error rather than
  a pending result.

---

## Sprint 16: Chat and AI depth

| ID | Item | Done when |
| --- | --- | --- |
| B-701 | `/v1` context: chat's knowledge and memory context providers on request (`X-Exprsn-Knowledge: <ids>`, `X-Exprsn-Memory: on`), with citations returned in an `exprsn` extension field; clearance and label rules as in chat | A `/v1` answer cites a knowledge base the caller may read, and never one they may not |
| B-702 | `/v1` server tools: `X-Exprsn-Tools: profile` offers the profile's read-only tools (calculate, registry, MCP) and runs them server-side through the dispatcher, returning only the final answer | A `/v1` request with profile tools gets a calculated result without the client running the tool |
| B-703 | Guard model while streaming: after each released sentence window the guard model and classifiers check the text so far in the background, with a configurable hold-back (`CHAT_GUARD_HOLDBACK_SENTENCES`, default 1) so a model verdict can stop release before the next window; tool results shown in chat pass the stream screen | A phrase only the guard model blocks is never released when hold-back ≥ 1 |
| B-704 | `require-approval` on `user-input` holds the prompt: the turn waits in the Flags queue, and generation starts only when a reviewer approves | A held prompt generates nothing until approved; a rejected one tells the user |
| B-705 | Live sharing: readers of a shared conversation see an answer while it streams (socket rooms decided by the server from the share) | A shared reader receives `chat.chunk` for the owner's streaming answer, and loses it at once on revoke |
| B-706 | Anonymous share links, opt-in per tenant (`sharing.anonymousLinks`), only for conversations labelled `public`, expiring, rate-limited, audited | An anonymous link opens a public conversation signed-out; it never opens an internal one |
| B-707 | Retention per workspace and per user (the shortest applicable period wins) | A workspace with a shorter period purges its conversations first |
| B-708 | Prompt templates pass the `user-input` guardrail checkpoint when saved and published | A template containing a blocked secret cannot be published |

## Sprint 17: Identity, security and accessibility

| ID | Item | Done when |
| --- | --- | --- |
| B-801 | New sign-in notices: a sign-in from a new device (a long-lived signed device cookie) or a new network (/24 or /48) sends a security notice (ASVS 2.2.3) | The first sign-in from a new browser notifies; the second does not |
| B-802 | Password strength meter in the console (entropy estimate, the policy's rules, the breached result when enabled) on change, reset and admin set (ASVS 2.1.8); Platform status warns when `BREACHED_PASSWORDS=off` | The meter shows on every password form; the warning appears on Platform |
| B-803 | Step-up for upstream OIDC and SAML users: re-authentication at the upstream IdP (`prompt=login`/`max_age=0`, SAML `ForceAuthn`) counts as step-up | An upstream OIDC user without a local factor can create an API key after re-authenticating upstream |
| B-804 | Admin password reset can also revoke the account's API keys (checkbox, default on) | Reset with the option ends the user's keys |
| B-805 | DPoP nonces (`DPoP-Nonce`, RFC 9449 §8) and a configurable API base for `htu` behind a proxy prefix (`API_PUBLIC_URL`) | A proof without the current nonce gets `use_dpop_nonce`; a prefixed deployment accepts proofs |
| B-806 | Introspection for registered resource servers (a client flag `introspect: any`, under `identity:manage` with dual control) | A resource server can introspect another client's token; an ordinary client still cannot |
| B-807 | SAML: optionally sign the whole response; SP and upstream IdP metadata fetched from a URL (SSRF-checked, refreshed daily, certificate change needs approval) | A fetched metadata change of certificate waits for approval |
| B-808 | Console sign-out runs front-channel logout (the signed-out page with frames) as well as back-channel | Signing out in the console loads each front-channel URI |
| B-809 | SQL user stores dial the checked address (pin DNS like LDAP and data connections) | A store whose name re-resolves to a link-local address after the check is refused |
| B-810 | First admin enrolment: `admin:create --enrol-link` issues a single-use enrolment link, so the first admin never works with password only | An admin created with the link must use it before any admin route |
| B-1101 | Playwright runs axe on the States popover states, drawers and a streaming chat, in light and dark | The suite fails on any WCAG A/AA violation there |
| B-1102 | Reflow at 320 px and 200 % zoom: tables collapse to cards or scroll with a visible affordance; no two-dimensional scroll | A Playwright reflow check passes on every screen |
| B-1103 | `UI.tabs` wraps all of a tab's content in one tabpanel | axe shows one tabpanel per tab list with every sibling inside |
| B-1104 | `--faint` meets 4.5:1 in Standard wherever it carries text | Contrast check passes on line numbers and breadcrumbs |

## Sprint 18: Platform hardening

| ID | Item | Done when |
| --- | --- | --- |
| B-901 | Operator-chosen service URLs (pool instances, zone endpoints, connections, image backends, trainer) checked against link-local and metadata addresses and pinned at connect, with an explicit allow-list (ASVS 12.6) | A pool instance pointing at 169.254.169.254 is refused |
| B-902 | `REQUIRE_BACKEND_TLS`: in production refuse plaintext PostgreSQL, MySQL, Redis, S3 and OpenBao links unless allowed per link (ASVS 1.9.1) | Production with `sslmode=disable` refuses to start with the setting on |
| B-903 | Point-in-time consistent backups: the dump runs in one repeatable-read (PostgreSQL, MySQL) or one read transaction (SQLite), and the blob archive includes exactly the objects the dump references (a manifest from the snapshot) | A blob written during a backup is neither missing nor orphaned after restore |
| B-904 | ACME external account binding; RFC 2136 over TCP with fallback and SOA discovery; certificate push hooks (a reload command or a signed webhook per certificate) | An EAB order completes against the fake ACME; a renewal calls the hook |
| B-905 | Training data protection: rows sealed with a per-job key the worker fetches once over mTLS; checkpoints and GGUF sealed under the tenant key in our blob store | The submit request carries no plaintext rows |
| B-906 | `kms:rewrap` also re-signs image provenance and training model cards | After a re-wrap, old images still verify |
| B-907 | Input limits: YAML depth and alias caps for guardrail rules and identity config (ASVS 5.5); diagnostic messages scrubbed of secrets before they reach admins (ASVS 7.4.1) | A billion-laughs YAML is refused; a driver message with a password shows it masked |
| B-908 | Zones: re-check existing MCP servers and connections when zones are first defined, with a guided move | Pre-existing members outside their zone are listed with a one-click proposal to move |
| B-909 | Import bundles: push promoted artefacts to Harbor (OCI), Verdaccio (npm) and devpi (PyPI) through their APIs | A promoted npm package appears in a fake Verdaccio |

## Sprint 19: Knowledge, integrations and workflows

| ID | Item | Done when |
| --- | --- | --- |
| B-1001 | MySQL tables as knowledge sources (watermark sync like PostgreSQL) | A MySQL view feeds a knowledge base |
| B-1002 | Row-level access for database knowledge sources: a column maps rows to groups or users, carried onto chunks and enforced at retrieval | A member not in a row's group never retrieves its chunk |
| B-1003 | PostgreSQL logical replication for knowledge sources (optional, `pgoutput`), falling back to watermarks | An update in the source reaches the index within seconds |
| B-1004 | Webhooks: optional ordered delivery per endpoint, and Ed25519 signatures with a published public key as an alternative to the shared secret | Ordered deliveries arrive in event order; an Ed25519 signature verifies with the published key |
| B-1005 | Billing: per-tenant price books, currency per tenant, tax rates, and Stripe inbound webhook reconciliation (paid, failed, voided) | A paid Stripe invoice marks the statement paid |
| B-1006 | Workflows: a workflow tool that pauses returns a pending result the caller can await (async tool result); approval timeouts configurable per step; run events go live to approvers | A calling agent run resumes when the workflow's approval completes |
| B-1007 | `IMAGE_SAFETY_REQUIRED`: without a classifier, images are withheld rather than marked "not classified" | With the setting on and no classifier, generation returns withheld |
| B-1008 | Scripts: an optional gVisor runtime (`SCRIPT_RUNTIME=runsc`) for docker | The runner passes `--runtime=runsc` and reports it |
