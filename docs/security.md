# Security model

This page lists the controls in place as of Sprint 4 and what later sprints add. Report vulnerabilities privately to
the maintainers rather than in issues.

## Authentication

- Passwords are verified by the user store that owns the account; the application stores passwords only for local
  accounts (argon2id, OWASP parameters). SQL stores must hold argon2 or bcrypt hashes.
- LDAP: LDAPS or StartTLS with certificate verification (TLS 1.2+, optional private CA). Empty passwords are refused
  before any bind (they would be an unauthenticated bind). Filter values are escaped per RFC 4515.
- SQL stores: identifiers from configuration are validated as plain names and quoted; values are bound parameters.
- One password is never tried against a second store (see [identity.md](identity.md#chain-rules)); response time
  does not reveal whether an account exists.
- Lockout per account and per client address, shared across instances through the database.
- Second factors: TOTP with single use per time step and sealed seeds; WebAuthn passkeys with signature counters;
  recovery codes stored as HMACs. Admin roles require a verified factor for every admin request.

## Sessions and requests

- The browser holds only an opaque 256-bit token in a `__Host-` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`).
  The database stores its HMAC. Idle and absolute timeouts; the token is rotated when a second factor completes.
- State-changing requests need the session's CSRF token (HMAC-bound to the session) and, when present, a matching
  `Origin`. Socket.io connections are accepted only from the configured origin with a fully signed-in session.
- Revoking a session or disabling a user takes effect on the next request and closes live sockets.
- API keys are HMAC'd at rest, shown once, and never widen their owner's permissions.
- Helmet headers: strict CSP (`default-src 'self'`, no inline script, `frame-ancestors 'none'`), HSTS behind HTTPS,
  `no-referrer`, `nosniff`. JSON bodies are capped at 256 KB. Rate limits per user and per address, and per address
  on the public sign-in, SAML, device and Kerberos endpoints.
- Every API answer is `Cache-Control: no-store`. Request logs redact authorization codes, state, PKCE verifiers,
  device codes, SAML messages and tokens from URLs, and the CSRF header. `/readyz` names a failing dependency
  without its error detail.
- Signing in again with a password ends the session the browser already held.
- The OWASP ASVS 4.0.3 level 2 assessment, with evidence and follow-ups, is in [asvs.md](asvs.md).

## Authorisation

- One evaluator for every request: role → credential scopes → tenant → clearance → zone. Denials name the failing
  step and are audited: the first 20 per principal per minute in full, then one `authz.denied.suppressed` event with
  the count per route, so a caller cannot flood the chain.
- Sign-in, "Test a login" and second-factor attempts are counted before the credential is checked (an atomic
  reservation), so parallel guesses cannot get past the lockout.
- Tenant isolation: every repository method takes the tenant id from the principal; nothing reads a tenant from the
  request body.
- Grant rules prevent privilege escalation: only a system admin can grant system admin, roles can be granted only by
  the roles listed for them, clearance cannot be granted above the granter's own, and admins cannot change their own
  access.

## Audit

Per-tenant SHA-256 hash chain over canonical JSON (every field, including the previous hash). Rows are never updated
or deleted by the application; verification is read-only. Events above the reader's clearance are returned without
content.

- **Signed checkpoints:** hourly (and on demand) the head of each chain is HMAC-signed by the KMS, with a key the
  database never holds, and a copy is written to the blob store. Verification recomputes the chain and checks every
  checkpoint, so history rewritten consistently (every hash recomputed) still fails at the first checkpoint after
  the change. A failed verification notifies tenant admins and auditors in the console and by email.
- **Corrections** are new rows that reference the row they correct; the original stays.
- **Exports** never contain rows above the requester's clearance: a selection that would is refused with the count,
  and the filtered export records how many rows it left out. Export files are written and sealed with the tenant key
  in parts of about 1 MiB (each bound to its position), and downloads stream them, so neither holds the file in
  memory; downloads are audited.
- **SIEM:** every event is streamed as it is appended (NDJSON over HTTPS, bearer token).

## Secrets

Configuration holds references (`env:`, `file:`), never values. The server reads secret files at use time. Container
and systemd deployments pass secrets as files (Docker secrets, systemd credentials), not environment variables.

References are written by tenant admins (user stores, upstream IdPs), so what they can reach is the operator's
choice: `env:` names must be on `SECRET_REF_ENV`, `file:` paths must resolve inside `SECRET_REF_DIRS`, and the
server's own settings and secret files are never readable. Without this, an LDAP store pointed at a host the admin
controls would receive `DATA_KEY` as its bind password, and a SQL store on `DATABASE_URL` would turn "Test a login"
into a password oracle for every tenant. LDAP and SQL store hosts, data connections, MCP servers, workflow HTTP steps,
mirrors and upstream IdPs are all confined to internal addresses (plus their allow-lists), never link-local.

## Encryption at rest

Envelope encryption with a data key per tenant (and one for platform secrets such as TOTP seeds). Data keys are
random AES-256 keys stored only wrapped by a key-encryption key in the KMS: OpenBao/Vault transit, or locally a key
derived from `DATA_KEY`. Conversation titles, message content, thinking and calculation steps, attachments and export
files are sealed with AES-256-GCM under the tenant's data key, with the row's identity as associated data, so a
ciphertext moved to another row or tenant does not open. Keys rotate by version (`exprsn-ai kms:rotate`); old
versions stay readable. Offboarding destroys every version of the tenant's key, in OpenBao too, and every instance
drops its cached copies at once, so the tenant's sealed data is unreadable before the purge job deletes it.

## Model serving

- Only the gateway talks to Ollama, over internal networks, optionally with mutual TLS per instance.
- Models enter through an import request: pickle checkpoints are refused, the pulled blob's digest must match the
  digest pinned in the request (the blob is deleted otherwise), and only GGUF and safetensors formats are accepted.
- Approval is dual control (not the requester), needs a recorded licence and a passing conformance run; a model
  that fails the tool-calling test has its tools capability withheld.
- A profile carries a label: users need that clearance to pick it, and a conversation labelled above it cannot use
  it (the zone step of the policy). Pools carry a label ceiling, and requests are only routed to pools cleared for
  the conversation's label.
- Chat attachments are quarantined, type-checked from their bytes, scanned with ClamAV when configured, and
  classified for payment cards, IBANs, national identifiers, emails and phone numbers before a chat can use them;
  a file classified above its owner's clearance or the workspace ceiling is rejected.
- Model output is rendered as text in the console, never as HTML.

## Deployment hardening

Container: non-root, read-only root filesystem, all capabilities dropped, `no-new-privileges`, internal networks for
the database and Ollama. systemd: `ProtectSystem=strict`, `NoNewPrivileges`, empty capability set, system-call
filter, private `/tmp`, only the state directory writable.

## Known gaps, tracked in the plan

- First-factor enrolment: an admin with no second factor enrols one at first sign-in, so until then the account is
  protected by its password alone. Have new admins sign in and enrol promptly; an identity admin can reset factors
  (which forces re-enrolment) if an account may have been enrolled by someone else.
- Guardrails: the model-output check runs on the finished (or stopped) answer. While it streams the user sees the
  text, and a block or redaction replaces it afterwards; the guard model is not yet run sentence by sentence during
  streaming. In chat, `require-approval` refuses the turn, because chat has no approval flow to hold it in.
- The trained classifier is a hashed-word linear head: its precision and recall are only as good as each tenant's
  labelled cases (the console warns below 200 per label).
- Knowledge: row-level permissions of source databases are not mapped to chunk access; a database source's chunks
  carry the connection's label and the knowledge base's access. Database sources sync by watermark on a schedule (no
  logical replication). Chat citations show the source, not the passage, which is not stored with the answer.
- Data connections: PostgreSQL and OpenSearch only; a username and password sealed with the tenant key (no OpenBao
  dynamic credentials yet); writes through a connection are refused outright. Hosts must be internal unless
  `CONNECTIONS_ALLOWED_HOSTS` names them; a failed test still reports reachability for internal addresses.
- SQL user stores: the database host is checked before connecting, but the driver resolves the name again when it
  dials (LDAP stores and data connections dial the checked address). The connection string comes from a reference the
  operator allowed, which narrows the window to someone who controls that DNS name.
- The denial cap is counted per instance (the lockout is in the database, shared by all): a caller whose requests
  are spread across N instances gets up to N times 20 full denial events per minute.
- Scripts need docker or podman on the host; with `SCRIPT_RUNNER=none`, or when no runtime answers, runs are refused.
  The sandbox relies on the container runtime's isolation (no gVisor or Firecracker).
- Tools: in chat, profiles offer only read-only tools that need no confirmation; write and destructive tools need an
  approval, which agent runs and workflows provide. MCP servers are checked against internal addresses after DNS
  resolution; hosts in `MCP_ALLOWED_HOSTS` (never link-local) are trusted by the operator. Tool results pass the
  `context` checkpoint (`meta.via: tool-result`) before the model sees them: a block withholds the result (the call
  itself has already run), a redaction replaces it. Agent runs read agent
  memories but do not write them yet.
- Workflows: the HTTP step may call any private address (narrowed by `WORKFLOW_HTTP_HOSTS` when set; there is no
  per-tenant host list yet). Run events go live only to the person who started the run; approvers see pending
  approvals through `GET /api/workflow-approvals` and the notification. A workflow published as a tool is pinned to one
  version, cannot be called from another workflow, and when it pauses for an approval its caller gets an error while
  the run continues on its own; a tool step's own approval pause has a fixed 24-hour timeout.
- Images and media frames are checked by the classifier at `IMAGE_SAFETY_URL`; without one, images are marked "not
  classified" rather than blocked.
- A chat stream lives on the instance that runs it: if that instance stops, the answer ends where it was and is
  kept as stored so far. Resume after a restart shows the stored text, not a continuation.
- Training: the orchestrator sends the scrubbed rows of a dataset to the training worker in the submit request, so
  they are in plaintext in transit to it and on its scratch storage for the run; run the worker inside the training
  zone over TLS, with encrypted scratch that it clears after each run. Checkpoints and GGUF artefacts live in the
  worker's object store under its own keys, not the tenant's data keys. The draft model's GGUF is pulled by name from the registry the worker pushes to; the gateway does not import a
  GGUF file directly.
- Zones: rendered NetworkPolicy, Compose and nftables files are downloaded and deployed by an operator; the platform
  does not apply them itself (the Helm chart in Sprint 10 can consume them). MCP server and connection registration do
  not yet consult zones (a member in the external or an undefined zone is reported on the Zones screen, not refused).
- Zones: seeding the default set is a single system-admin action (it can only add zones and never lowers what a zone
  holds); every later change needs a second system admin.
- Import bundles are held in memory while they are verified and promoted (the blob store API is buffer-based), so
  `PLATFORM_BUNDLE_MAX_BYTES` is capped below 2 GiB; multi-gigabyte model bundles need a streaming blob path.
  Promotion writes into the mirror store in the blob store; pushing into Harbor, Verdaccio, devpi or the Trivy
  server is left to each mirror's own sync from `mirrors/<kind>/`.
- Without `PLATFORM_TRIVY_BIN` or `PLATFORM_STAGING_URL` the scan and staging steps are recorded as "not
  configured" and a bundle can still be promoted; there is no setting yet that makes them mandatory. Adding or
  revoking a signer key is audited but not under dual control.
- ACME: http-01 only (no dns-01), so every name must reach this server on port 80 from the CA; no ACME external
  account binding. Renewed certificates are stored and can be exported, but nothing reloads a listener or pushes the
  key to the services that use it.
- Backups cover the application database only: blob store contents (attachments, exports, media, checkpoints) and
  the KMS key material must be backed up with their own tooling, and a backup cannot be opened without the KMS key.
  The dump is logical and held in memory (fine for single-node sizes; use native `pg_dump` or `mysqldump` at scale),
  SQLite dumps are not taken inside one transaction, and there is no restore command into a live database yet: the
  drill proves a backup is readable and complete, it does not restore production. Tables outside the portable
  schema (`vectors_pg`) are listed as skipped in the drill and rebuilt by reindexing.
- Clock skew is measured against the database server, not against NTP.
- Federation: the SAML IdP signs the assertion, not the whole response, with RSA-SHA256 only; SP metadata is pasted,
  never fetched. Upstream SAML accepts only exclusive C14N with RSA-SHA256 or ECDSA-SHA256 over SHA-256 digests and
  refuses IdP-initiated responses; upstream SAML's browser binding needs HTTPS (a `SameSite=None; Secure` cookie).
  Encrypted assertions use AES-GCM with RSA-OAEP only (CBC and RSA 1.5 are refused, so an IdP that only offers those
  must send them unencrypted).
- Logout: front-channel logout relies on the browser loading the relying parties' pages in frames with their own
  cookies, which browsers that block third-party cookies prevent; back-channel logout does not depend on the browser.
  Signing out in the console (`POST /api/auth/logout`) reaches back-channel clients only; front-channel frames and
  SP-initiated upstream SAML logout happen at `/oauth/logout`. SAML SPs that only take HTTP-POST single logout are not
  told when another SP or a relying party starts the sign-out (their sessions end at their own timeout).
  `prompt=login` and `max_age` re-authentication sign the current session out first, which also signs the user out of
  that session's other applications.
- DPoP: the server does not issue `DPoP-Nonce` values (RFC 9449 section 8 is optional), so a proof's freshness rests on
  `iat` within `DPOP_PROOF_MAX_AGE_SECONDS` and the single-use `jti`. The API checks `htu` against `PUBLIC_URL`, so a
  reverse proxy that serves the API under another origin or path prefix makes DPoP-bound calls fail.
- Token introspection answers only for tokens issued to the calling client; a separate resource server that needs to
  introspect other clients' tokens is not supported.
- Kerberos needs the optional `kerberos` npm module (GSSAPI bindings) and a keytab on the host; it is not bundled.
  Mapping takes the principal's user part and looks it up in the tenant's user stores; realms map to tenants only
  through the per-tenant realm allow-list.
- Signing keys: with `KMS_PROVIDER=local` the OIDC and SAML signing keys are sealed with the platform data key and
  held unsealed in memory while in use (with OpenBao they are signed in transit and never enter the process). The SAML
  SP decryption key for upstream encrypted assertions is always sealed locally, also with OpenBao (transit's RSA
  decryption does not offer the OAEP variants IdPs use). Turning on OpenBao replaces the signing keys at once: SAML
  service providers must re-import the IdP metadata for the new certificate.
- Key-encryption keys cannot be re-wrapped: changing `DATA_KEY` or `KMS_PROVIDER` makes existing tenant data keys
  unreadable. `kms:rotate` adds a data-key version under the same key-encryption key.
- Sensitive account changes (creating API keys, removing a second factor, regenerating recovery codes) need a
  signed-in browser session but not a fresh re-authentication; step-up with a recent-factor window is planned (ASVS
  3.7.1).
- Local accounts have no self-service password change and no admin password reset, and an admin-set initial password
  is not forced to change at first sign-in. The password policy refuses a short local list of common passwords, not a
  full breached-password corpus (ASVS 2.1.5 to 2.1.7, 2.3.1).
- Users cannot list or revoke the OAuth grants and consents they gave to applications; only admins can, by disabling
  the client or the user (ASVS 3.5.1).
- Failed bearer-token and API-key attempts are refused before the `/api` rate limiter, so they are not throttled
  (keys are 256-bit random).
- Pool instance, zone endpoint, connection and image backend URLs are chosen by operators and are not checked against
  internal or link-local addresses. Git sources refuse link-local hosts, but git's own DNS lookup is not pinned to the
  checked address.
- Media and image previews are served inline from the console's origin with server-chosen content types; there is no
  `CSP: sandbox` and no separate download domain.
- Users are not notified (console or email) when their factors, API keys or sessions change; the changes are audited
  only.
- Rate limits are per instance (in memory); quotas are shared through the database.
