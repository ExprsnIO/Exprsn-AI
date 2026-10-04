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
  on the public sign-in, SAML, device and Kerberos endpoints; shared across instances through one atomic Redis script
  when `REDIS_URL` is set. 20 failed bearer credentials a minute from one address get 429 for every bearer request
  from it until the window ends.
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

- First-factor enrolment: `admin:create --enrol-link` (1.2.0) gives the first admin a single-use link that sets the
  password and opens a session that can only enrol a second factor, so that account is never usable with a password
  alone. Admins created with a password (the CLI without the flag, or by an identity admin in the console) still enrol
  their factor at first sign-in and are protected by the password until then; have them sign in and enrol promptly.
- Guardrails: while an answer streams, the deterministic `model-output` rules screen it sentence by sentence and the
  guard-model and classifier rules check the text so far in the background (Sprint 16). With
  `CHAT_GUARD_HOLDBACK_SENTENCES` ≥ 1 (the default) a sentence is shown only after a clean verdict covers it; with 0
  it is shown at once and a verdict can only stop what follows, so text the guard model would block can be shown and
  is replaced afterwards. A background check that cannot run stops release; the rest is shown after the full check.
  Thinking is screened like the answer, and since 1.3.0 the full check on the finished answer covers the thinking as
  well: thinking it blocks or holds is withheld (the answer itself is decided by its own check), and thinking already
  shown while streaming is replaced when the client reloads the answer. A phrase that spans a sentence boundary is
  blocked when its second half arrives, but the first half may have been shown. Tool results shown in chat pass the
  same screen (the model still receives them, checked at `context`). A `require-approval` on the prompt (`user-input`)
  holds it for a reviewer in chat and compare (every column waits), and holds a `/v1` request sent with an API key
  (`202`, then `GET /v1/held/:id`); a hold that comes from a check that could not run still refuses the turn, and a
  `/v1` request sent with an OAuth access token is still refused rather than held (the token could expire or be revoked
  while a reviewer decides). An approved `/v1` request runs as its sender with the key's scopes at approval time; a
  revoked or expired key, or a disabled owner, fails it. The request and its answer are kept sealed in `api_holds`;
  there is no retention period for held API requests yet.
- The trained classifier is a hashed-word linear head: its precision and recall are only as good as each tenant's
  labelled cases (the console warns below 200 per label).
- Knowledge: row-level access for database sources comes from an access column the curator names (groups or users per
  row) or, for PostgreSQL (Sprint 23), from the database's own row security: the source reads as one mapped role per
  group, and a policy change applies at the next sync (sources sync on their schedule, not when a policy changes).
  Role-mapped sources read the whole object per role (up to 5000 rows each) and cannot replicate. Groups are matched
  against the groups the user's identities carried at their last sign-in or directory sync, so a change in the
  directory applies from then. The crawler and buckets on their own endpoints reach internal hosts (and those in
  `KNOWLEDGE_ALLOWED_HOSTS`) with every dialled address checked; the crawler has no authentication (a site that needs
  a login cannot be crawled), does not run JavaScript, and indexes what any internal client could fetch, so the
  source's label floor must reflect the site. Rows the reader may not see are dropped after ranking candidates, so a result list can be shorter than
  asked. Logical replication (PostgreSQL tables with `pgoutput`) needs `wal_level=logical`, a publication the database
  owner creates and the REPLICATION attribute on the connection's account; replicated changes are applied as they
  arrive (no back-pressure beyond one transaction at a time), and a delete is matched by the id column only when it is
  the primary key or the table has `REPLICA IDENTITY FULL`. A slot whose stream stops keeps WAL on the database until
  the stream resumes or the source is removed (which drops it). Views and MySQL sources sync by watermark. A
  citation's passage is chosen by word overlap with the answer (the best-matching sentences of the chunk), not by the
  model saying what it quoted.
- Data connections: PostgreSQL, MySQL and OpenSearch; a username and password sealed with the tenant key, or (SQL
  engines) OpenBao dynamic database credentials. Dynamic leases are held per instance and revoked when a connection
  is removed, its credential changes, or the instance shuts down cleanly; an instance that dies leaves its lease to
  expire at its TTL. Writes through a connection are refused outright. Hosts must be internal unless
  `CONNECTIONS_ALLOWED_HOSTS` names them; a failed test still reports reachability for internal addresses. The MySQL
  classifier refuses vendor syntax it cannot lex safely rather than asking for confirmation.
- With `REDIS_URL` set, rate limits, the failed-bearer throttle and the denial cap are shared by every instance; while
  Redis is unreachable (and without it) they are counted per instance, so a caller spread across N instances gets up
  to N times each limit. Since 1.3.0 an outage is visible: each instance probes Redis every `RATELIMIT_PROBE_SECONDS`,
  the Platform screen warns, and `exprsn_ratelimit_degraded` drives the `ExprsnRateLimitsPerInstance` alert; the limits
  themselves are still per instance until Redis answers. The failed-bearer throttle is per address: clients behind one
  NAT share it.
- Scripts need docker or podman on the host; with `SCRIPT_RUNNER=none`, or when no runtime answers, runs are refused.
  The sandbox relies on the container runtime's isolation unless `SCRIPT_RUNTIME=runsc` puts containers under gVisor
  (the host must have it installed and registered with the engine); there is no Firecracker option.
- Tools: in chat, profiles offer only read-only tools that need no confirmation; write and destructive tools need an
  approval, which agent runs and workflows provide. MCP servers are checked against internal addresses after DNS
  resolution; hosts in `MCP_ALLOWED_HOSTS` (never link-local) are trusted by the operator. Tool results pass the
  `context` checkpoint (`meta.via: tool-result`) before the model sees them: a block withholds the result (the call
  itself has already run), a redaction replaces it. Agent runs propose memories only through the `remember` tool
  when their definition allows it; a model without tool calling cannot propose any.
- Workflows: the HTTP step may call any private address (narrowed by `WORKFLOW_HTTP_HOSTS` and by the tenant's
  allowed hosts when they are set). Run events go live to the person who started the run and to the holders of the
  approval roles it asked for. A workflow published as a tool is pinned to one version and cannot be called from
  another workflow; when it pauses for an approval an agent run awaits it, but chat and the registry test harness get
  an error while the run continues on its own.
- Images and media frames are checked by the classifier at `IMAGE_SAFETY_URL`; without one, images are marked "not
  classified" rather than blocked unless `IMAGE_SAFETY_REQUIRED` is set, which withholds them (the default is off, so
  a platform without a classifier still generates images).
- Resumable streams: an answer is marked interrupted only after `CHAT_STREAM_LEASE_SECONDS` without a heartbeat, and
  the stored text is the last snapshot (up to two seconds behind what clients saw). Continuing it relies on the
  model carrying on from an assistant prefill, which Ollama supports but a model may phrase imperfectly. An answer
  interrupted before its full `model-output` check ran shows what passed the streaming screen until it is continued
  or regenerated. Without Redis the catch-up buffer lives in the database; running several instances still needs Redis
  for the bus and the socket adapter.
- Conversation retention deletes conversations by last activity; the shortest of the tenant's, the workspace's and
  the owner's periods applies (Sprint 16). Periods are set by tenant admins; users cannot set their own. Usage
  records, audit events and flags that quote a purged answer are kept under their own rules.
- Training (worker contract 2, [training-worker.md](training-worker.md)): rows travel encrypted and the run key is
  released once, but the worker necessarily holds the decrypted rows (and the key) in memory or scratch for the run;
  run it inside the training zone with encrypted scratch that it clears. Checkpoints and GGUF files uploaded to the
  platform are sealed under the tenant key; the worker is trusted to delete its local copies. A checkpoint read back
  is streamed before its GCM tag is checked at the end (a failing read is cut off, not completed). The draft model's
  GGUF is still pulled by name from the registry the worker pushes to; the gateway does not import a GGUF file
  directly. The client-certificate check relies on the proxy that terminates mTLS when the server does not.
  `TRAINER_PLAINTEXT_FALLBACK` brings back contract 1 (plaintext rows) for an old worker.
- Zones: rendered Compose and nftables files are downloaded and deployed by an operator. NetworkPolicies are too,
  unless `ZONES_APPLY=kubernetes` (1.3.0): the server then applies each zone's policy with server-side apply after
  every approved change and reports drift (edited or deleted policies) on the Zones screen, in the audit chain and as
  an alert. It does not create the zone namespaces, does not delete policies of zones that are removed, and the drift
  check compares the fields it set (a field added by hand to an existing rule, without changing a list's length, is
  not noticed). The service account needs only get, list, create and patch on networkpolicies in the zone namespaces
  (the chart's `zonesApply` Role); its token is then mounted in the pod. MCP server and connection registration
  are refused in an undefined or external zone, or above its ceiling, only once zones are defined; members registered
  before that are listed on the Zones screen (and admins are told when the first zones appear), each with a move
  proposal that a second system admin approves. MCP servers carry no label, so only their zone is checked.
- Zones: seeding the default set is a single system-admin action (it can only add zones and never lowers what a zone
  holds); every later change needs a second system admin.
- Import bundles stream through verification and promotion (a 3 GiB bundle verifies with flat memory); S3 uploads
  use 16 MiB multipart parts, so one object is capped at about 160 GiB. Promotion writes into the mirror store in the blob store and,
  where a mirror has a push target, into Harbor (OCI image layout tars only; `docker save` archives are not
  converted), Verdaccio or devpi through their APIs. npm tarballs and wheels are read into memory to push (capped at
  512 MiB); image layers are streamed. The Trivy database, model weights, OS packages and OpenTofu providers are still
  left to each mirror's own sync from `mirrors/<kind>/`.
- Without `PLATFORM_TRIVY_BIN` or `PLATFORM_STAGING_URL` the scan and staging steps are recorded as "not
  configured" and a bundle can still be promoted unless `PLATFORM_BUNDLE_REQUIRE_CHECKS` is set. Adding and revoking
  signer keys is under dual control, except the very first key, which one platform admin registers (as with the
  default zone set); revoking a compromised key therefore also waits for a second admin.
- ACME: http-01, or dns-01 through a signed webhook or RFC 2136 (TSIG) dynamic update over UDP with a TCP fallback;
  external account binding when the CA requires it. When the zone is not configured it is taken from the SOA record,
  but updates still go to the configured server (the SOA's primary name is not followed). Issued certificates are
  written to `ACME_CERT_DIR` on every instance and can run push hooks (a reload command named by the operator, or a
  signed webhook that carries the chain); services that need the private key elsewhere still take it through the
  audited export.
- Backups cover the application database and the blob store; the KMS key material must be backed up with its own
  tooling, and a backup cannot be opened without the KMS key. The dump reads one snapshot and the blob archive holds
  exactly the objects the snapshot's rows name (plus the content-addressed mirrors and pipeline staging, which no row
  names, archived as listed); an object deleted while the backup runs is missing from it although its row is in the
  snapshot. Objects whose keys are derived rather than stored are covered by a fixed list (audit export parts, bundle
  transfers). With an in-memory SQLite database the dump holds the only connection, so other queries wait until it
  ends. The dump is logical (streamed, a page at a time). `backup:restore`
  restores into the configured database (tested on the engine the backup came from) with every instance stopped; it
  refuses a database with tenants, users or audit events unless forced with the confirmation phrase, and blob objects
  are written after the database commits. Tables outside the portable schema (`vectors_pg`) are skipped in the drill
  and rebuilt by reindexing.
- Clock skew is measured against the database server, and against NTP when `NTP_SERVER` is set. SNTP is
  unauthenticated (no NTS); since 1.3.0 `NTP_SERVER` takes several servers and the reported skew is the median of the
  ones that agree, with outliers named, so one lying or spoofed server no longer hides skew. An attacker who controls
  the path to most of the servers still can; it is a check, not a time source.
- Federation: the SAML IdP signs with RSA-SHA256 only: the assertion always, and the whole response too when the
  service provider is set to it. SP and upstream IdP metadata can be fetched from a URL (through the upstream host
  checks) and are refreshed every `FEDERATION_METADATA_REFRESH_HOURS`; a changed certificate or endpoint waits for an
  identity admin's approval, and metadata naming another entity ID is refused. Pasted metadata is never refreshed. Upstream SAML accepts only exclusive C14N with RSA-SHA256 or ECDSA-SHA256 over SHA-256 digests and
  refuses IdP-initiated responses; upstream SAML's browser binding needs HTTPS (a `SameSite=None; Secure` cookie).
  Encrypted assertions use AES-GCM with RSA-OAEP only (CBC and RSA 1.5 are refused, so an IdP that only offers those
  must send them unencrypted).
- Logout: front-channel logout relies on the browser loading the relying parties' pages in frames with their own
  cookies, which browsers that block third-party cookies prevent; back-channel logout does not depend on the browser.
  Signing out in the console (`POST /api/auth/logout`) reaches back-channel clients and, through the signed-out page
  it opens, front-channel clients and SAML SPs with a redirect-binding logout endpoint; SP-initiated upstream SAML
  logout still happens only at `/oauth/logout`. SAML SPs that only take HTTP-POST single logout are not
  told when another SP or a relying party starts the sign-out (their sessions end at their own timeout).
  `prompt=login` and `max_age` re-authentication sign the current session out first, which also signs the user out of
  that session's other applications.
- DPoP: server nonces (RFC 9449 section 8) are required only with `DPOP_NONCES=true` (off by default, so clients
  that cannot retry with a nonce keep working); without them a proof's freshness rests on `iat` within
  `DPOP_PROOF_MAX_AGE_SECONDS` and the single-use `jti`. Nonces are an HMAC of the time window, valid for one to two
  `DPOP_NONCE_SECONDS` periods on every instance. Set `API_PUBLIC_URL` when a proxy serves the API under another origin
  or path prefix, or DPoP-bound API calls fail the `htu` check.
- Token introspection: a client registered as a resource server (`introspect: any`, set under dual control) sees every
  client's access tokens in its tenant; refresh tokens introspect only for the client they were issued to.
- Kerberos needs the optional `kerberos` npm module (GSSAPI bindings) and a keytab on the host; it is not bundled.
  Mapping takes the principal's user part and looks it up in the tenant's user stores; realms map to tenants only
  through the per-tenant realm allow-list.
- Signing keys (Sprint 20): with `KMS_PROVIDER=local` and the signer process (`exprsn-ai signer`, `SIGNER_SOCKET`),
  the key-encryption key and the OIDC, SAML, SAML SP decryption and webhook Ed25519 private keys live only in the
  signer; the app stores opaque wrapped blobs it cannot open. Data keys are still unwrapped into the app's memory
  (content is sealed there). Node cannot read a UNIX socket peer's uid (`SO_PEERCRED`), so the signer does not check
  the caller's credentials: access rests on the socket directory and socket permissions (0700/0600, or 0750/0660 for
  a shared group) and a shared token every connection must present first; run the signer as its own user so the
  app's user cannot read the signer's key file. Anyone who can reach the socket with the token can have the signer
  sign or decrypt (it never exports a key). The signer signs the bytes it is sent (at most 512 KiB since 1.4.0, for CRLs; 64 KiB before), not a digest,
  because node:crypto cannot sign a precomputed digest with ECDSA or Ed25519. Without the signer, the local KMS keeps
  the federation and webhook keys sealed with the data keys and unsealed in memory while in use. With OpenBao, OIDC,
  SAML and webhook signatures are made in transit; the SAML SP decryption key is then still sealed locally (transit's
  RSA decryption does not offer the OAEP variants IdPs use). Turning on OpenBao or the signer replaces the signing
  keys at once (the old public keys stay published for the overlap): SAML service providers must re-import the IdP
  metadata, and upstream IdPs the SP encryption certificate (the replaced decryption key is still tried while it is
  published).
- Certificate authority (Sprint 24): issuer and OCSP responder keys are made and used only in the signer or OpenBao
  transit; with neither the CA refuses to make keys. Creating, rotating or re-issuing the root needs `platform:manage`
  and a recent sign-in, not a second admin (no dual control yet). Tenant intermediates carry no name constraints: a
  tenant admin with `pki:manage` sets their own profiles, so administrator issuance (the API and `exprsn-ai pki`)
  checks names against policy but not domain control; only ACME orders (Sprint 25) also prove control of each name
  (see the ACME paragraph below and `docs/pki.md`). Anyone who trusts the platform root trusts every tenant's
  issuance; trust a tenant's intermediate rather than the root where that matters. CRLs are full CRLs only
  (no delta, indirect or partitioned CRLs; no `certificateHold`), and a CRL's to-be-signed list is capped by the
  signer at 512 KiB (roughly 10,000 entries; expired certificates drop off). OCSP request signatures are ignored
  (no requestor is trusted), responder certificates carry `ocsp-nocheck` and are short-lived (`PKI_OCSP_SIGNER_DAYS`)
  instead of being checked, and answers are cached per instance: a revocation clears them on every instance through
  the bus, which needs `REDIS_URL` across instances. Issued certificates have a CN-only subject; other CSR attributes
  and extensions besides subjectAltName are ignored.
- ACME server (Sprint 25, B-1605): each tenant's directory is unauthenticated by design (the JWS signatures and the
  challenges are the authentication), rate-limited per address and closed until a tenant admin opens it. Orders are
  bounded by the directory's server profile and every name is proven by http-01 or dns-01; every object is stored
  and looked up by tenant and owning account. Limits: dns identifiers only (no IP identifiers, RFC 8738), no
  `notBefore`/`notAfter`, no authorization reuse across orders (each order validates its names again), no
  pre-authorization (`newAuthz`), no ACME Renewal Information (RFC 9773), and one validation attempt per challenge
  from one vantage point (no multi-perspective validation): an attacker who controls the path between Exprsn-AI and a
  name's server or resolver can obtain a certificate for that name, within what the profile allows. http-01 follows
  redirects to https without checking the certificate (as RFC 8555 permits). With `PKI_ACME_INTERNAL_ONLY` off (the
  default) http-01 may connect to public addresses; it never connects to cloud metadata or other link-local addresses
  and only fetches the fixed challenge path, but anyone can make the server connect to port `PKI_ACME_HTTP_PORT` of a
  name the profile allows. External account binding is optional per tenant; its MAC keys are sealed with the tenant
  key. Account deactivation and administrator revocation do not revoke certificates already issued.
- Certificate export and lifecycle (Sprint 25, B-1606): PKCS#12 files use PBES2/AES-256-CBC with an HMAC-SHA256 MAC,
  which readers older than OpenSSL 1.1.1 may not open (no legacy RC2/3DES variant is offered). A key made with
  `generateKey` exists in the app process while it is wrapped into the PKCS#12 file and is only as safe as the
  password the caller chose and the channel the response travels over; it is never stored. Renewal without a CSR
  keeps the old key, which is the wrong choice after a key compromise (send a new CSR and revoke the old
  certificate). Expiry notices go to the requesting user or to the tenant's `pki:manage` holders; ACME account
  contacts are not emailed.
- HTTP Message Signatures (RFC 9421, Sprint 20): a subset (`@method`, `@target-uri`, `@authority`, `@path`,
  `@query`, header fields; no component parameters; `ed25519` and `hmac-sha256`). A signed `/v1` request is accepted
  within `HTTP_SIGNATURE_MAX_AGE_SECONDS` of its `created` time and nonces are not remembered, so a captured request
  can be replayed within that window over a broken TLS link. `@target-uri` is checked against `PUBLIC_URL`; a proxy
  that serves `/v1` under another origin or prefix breaks verification.
- Supply chain (Sprint 20): `npm audit signatures`, the SLSA provenance attestation, the cosign keyless signature and
  its verification, and the release SBOM upload run only in GitHub Actions (on pushes to `main` and on `v*` tags, with
  the workflow's OIDC token) and were validated with actionlint, not run from this repository; they assume the image
  is published to GHCR as `ghcr.io/<owner>/<repo>`.
- Key-encryption keys are re-wrapped with `kms:rewrap` (data keys, checkpoint signatures, backup archives and
  manifests). Image provenance manifests (the row and the copy inside the PNG) and training model cards are re-signed
  too; a model card whose signed fields changed after registration cannot be verified with the previous key and is
  reported as failed rather than re-signed. OpenBao's own key
  versions are rotated and re-wrapped in OpenBao (`transit/keys/<name>/rotate`, `transit/rewrap`).
- Step-up (`STEPUP_WINDOW_SECONDS`) accepts the password only from accounts whose store checks passwords (local, LDAP,
  SQL). A session from an upstream OIDC or SAML provider steps up by signing in there again (`prompt=login` and
  `max_age=0`, or `ForceAuthn`); it counts only when the IdP reports a fresh authentication (`auth_time` or
  `AuthnInstant` after the request), as the same upstream account, redeemed by the same console session. An IdP that
  ignores these requests cannot be used for step-up.
- New sign-in notices tell a device by a long-lived signed cookie, so a cleared cookie jar or a private window counts
  as a new browser; a network is the /24 or /48 of the address the server sees (`req.ip`, so configure the trusted
  proxy). An account's first sign-in is recorded without a notice. With `BREACHED_PASSWORDS` using the range API, the
  strength meter queries it (k-anonymity prefix only) as the user types, throttled per session or link.
- The breached-password check is off by default (`BREACHED_PASSWORDS=off`): the range API is on the internet, so an
  air-gapped site needs an internal mirror or the offline file. When a source cannot be reached the password is
  accepted (fail open) and `password.breach_check.unavailable` is audited. Directory passwords (LDAP, SQL) are never
  checked here; the directory's own policy applies.
- A password reset request answers the same whether or not the account exists, but the server does a little more
  work (a token row and an email hand-off) when it does, so response time is not strictly constant. Reset and invite
  links need `SMTP_URL`. An admin password reset ends the account's sessions and OAuth grants and, unless the admin
  unticks it, its API keys.
- OpenAI-compatible API (`/v1`): requests are stateless and nothing is stored as a conversation. Knowledge and memory
  context apply only when asked for (`X-Exprsn-Knowledge`, `X-Exprsn-Memory`), and the profile's read-only tools run
  on the server only with `X-Exprsn-Tools: profile` (write and destructive tools are never offered there); otherwise
  the client's tools are offered and their calls returned to it. A `require-approval` on the prompt refuses the
  request (there is no conversation to hold it in). Citations come back in the `exprsn` extension field, which strict
  OpenAI clients ignore. An OAuth
  token whose only inference scopes are `inference:invoke:<profile>` is bound to those profiles (by name or alias) in
  chat, agent runs and `/v1`; embeddings are not profiles and stay open to it. With `OPENAI_STREAM_MODE=live` tokens are sent before the output guardrail has run, so a later block
  can only end the stream with `finish_reason: content_filter`; the default `checked` mode sends the answer after the
  check, at the cost of time to first token.
- Webhooks: a delivery carries the audit event's target and detail (within the webhook's label ceiling) to the
  endpoint, so the endpoint must be trusted with them. Deliveries are not ordered unless the webhook asks for it; ordered
  delivery keeps the order in which events were queued across all instances (a position counter and a delivery lease
  per endpoint in the database, Sprint 23). Two events raised at the same moment on two instances are ordered by
  which one queued first, not by a clock, and receivers should still de-duplicate by the event id (a replay reuses
  it). The HMAC secret is sealed at rest and shared with the receiver; Ed25519 signing uses a per-tenant key
  whose private half is sealed with the tenant key and held in memory while signing (not in the KMS). Endpoint names are resolved again when dialled; every address is checked in the dispatcher's lookup
  against the operator's rules and the tenant's list, as for MCP servers.
- Conversation sharing: readers of a user or workspace share can watch an answer stream (Sprint 16), answer text only
  (no thinking); a revocation, a label rising above them, or (since 1.3.0) leaving the shared workspace (removed by an
  admin, or through a group mapping or the directory) ends it at once on every instance. Signed-in link shares open the transcript but
  do not stream. Anonymous links are off by default per tenant, open only conversations labelled `public` at that
  moment, expire within the tenant's limit (72 hours by default), are rate-limited per client address
  (`SHARE_ANONYMOUS_PER_MINUTE`, shared through Redis when set) and are audited with the address; anyone holding the
  link can read the conversation until then, and the address is only as reliable as the proxy settings.
- Stored API responses (1.3.0): `POST /v1/responses` with `store: true` saves the exchange as a chat conversation of
  the caller (in the key's workspace, `X-Workspace`), subject to chat retention; `previous_response_id` continues only
  the caller's own stored responses. Function calls returned to the caller are stored with the answer so a following
  function result matches them; function results and images in a stored turn are kept as text in the question.
  `store` defaults to false, unlike OpenAI's API.
- Evaluations (1.3.0): eval cases and results are sealed with the tenant key. A run answers each case with the saved
  profile through the gateway and the `model-output` checkpoint and is metered as `api` usage of whoever started it.
  The publish gate keys runs to a hash of the settings that shape an answer (model, pool, context, temperature,
  thinking, system prompt, tools, label), not to the canary model: a canary is not evaluated. A judge profile is an
  LLM: its verdict is only as reliable as the model, and an unreadable verdict scores 0. Overrides need a second
  profile admin.
- Scheduled agent runs (1.3.0): a schedule runs as its owner with the roles, clearance and workspace memberships they
  hold at its due time, never more; a due time missed while no instance was running fires once at the next tick, not
  once per missed time. Cron expressions are UTC.
- Billing: there is no currency conversion; a tenant with a currency is priced only from books in it. Proration
  (Sprint 23) follows price changes within a book by the moment they take effect; moving a tenant to another book
  mid-month prices the whole month from the book in effect when the statement is computed.
  Taxes are flat percentages of the priced subtotal, without tax registration numbers, exemptions or jurisdictions.
  The Stripe webhook reconciles paid, failed and voided invoices by the Stripe-Signature HMAC with a timestamp
  tolerance, and (Sprint 23) refunds, credit notes and disputes. A refund or dispute is matched only when it names the
  invoice or the charge or payment intent recorded from the invoice's paid event; credit notes are recorded with their
  amounts but do not change the statement's state. Statements are computed from `usage_records`, so usage deleted
  with a tenant's data is gone from later recomputations; push a finished month to keep it.
- Prompt templates pass the `user-input` checkpoint when they are saved and when a version is published (Sprint 16);
  a template published before a rule existed stays usable until it is published again, and the filled text still
  passes the checkpoint when it is sent.
- Operator-chosen service URLs (pool instances, zone endpoints, image backends, the training worker) refuse cloud
  metadata, link-local and unspecified addresses when saved and at every connection (the address dialled is the one
  checked); loopback and private addresses are the normal case and stay allowed, and public addresses are allowed
  too unless `SERVICE_INTERNAL_ONLY` is set. Image backends and the trainer come from the environment, so a refused
  address shows up when they are called, not at start. Git sources refuse link-local hosts, but git's own DNS lookup
  is not pinned to the checked address.
- `REQUIRE_BACKEND_TLS` is off by default, so an upgraded production deployment keeps starting with plaintext
  backend links until the operator turns it on; it checks the connection settings (sslmode, `rediss://`, `https://`),
  not the certificate the server presents, which is left to each driver's own verification.
- Diagnostic messages are masked by pattern (credentials in URLs, `key=value` secrets, authorization values, private
  keys) and, for data connections, by the connection's own password; a driver that reports a secret in another form
  (a bare value with no key name) is masked only when it is the connection's password.
- Media and image files are served with `Content-Security-Policy: sandbox` and `nosniff`; without `MEDIA_ORIGIN`
  they still come from the console's origin (sandboxed, so script in them cannot reach it). Signed media URLs are
  bearer URLs for their lifetime (`MEDIA_URL_TTL_SECONDS`).
- Security notices cover password, factor, recovery-code, API-key and session changes; a new sign-in does not send
  one. Email notices need `SMTP_URL` and an address on the account.
- Without `REDIS_URL`, rate limits are per instance (in memory); quotas are shared through the database.
- Tracing (1.3.0): spans go to `OTEL_EXPORTER_OTLP_ENDPOINT` over OTLP/HTTP JSON with only allow-listed attribute keys
  (method, route template, status, table and operation, job type, guardrail checkpoint and outcome, model name); SQL
  text, URLs with query strings, message text and error messages are never recorded. The exporter does not use TLS
  client certificates; put the collector on the internal network or behind a sidecar, and give an API key through
  `OTEL_EXPORTER_OTLP_HEADERS` (an environment variable, with no `_FILE` form yet).
- Key escrow (1.3.0): `kms:escrow` splits only the local key-encryption key, `DATA_KEY` or, when the signer holds it, the signer's key file
  (`--key-file`; with OpenBao, use its own recovery shares) and
  prints the shares to standard output once; run it on a terminal, not in a logged CI job. Shares of an earlier escrow
  stay valid for the key they were made from: after a key change (`kms:rewrap`), make a new escrow and destroy the old
  shares. `kms:recover` writes the key to a new file with mode 0600, never to standard output.
- Schema handshake (1.3.0): an instance whose build is older than the database's newest migration stops taking jobs
  and reports not ready, but keeps answering requests that reach it until its load balancer drains it. Expand-only
  migrations keep the previous release working during a rolling upgrade; a contract step (marked `// contract:`) needs
  every old instance stopped first, which `migrate --check` reports.
- Secrets vault (1.4.0, B-1701 to B-1703): KV values and transit key material are sealed with the tenant data key, so
  they are as strong as its key-encryption key (local `DATA_KEY`, the signer, or OpenBao transit when
  `KMS_PROVIDER=openbao`) and are crypto-shredded with the tenant. Transit operations themselves run in the app
  process: the material is opened in memory for each call and never exported, but it is not held by OpenBao transit
  or the signer the way the OIDC and webhook keys are; an OpenBao-native transit backend (named keys in OpenBao, its
  own `min_decryption_version`) is not built. Vault paths and transit names are lower case only, so they compare the
  same way on every database. A grant to a directory group follows the groups the user's stores reported at the last
  sign-in or sync. Encrypt and verify calls are not audited (they reveal nothing); decrypt, rewrap, sign and every
  read of a secret are. `vault:path#key` references in other features (B-1705), rotation schedules (B-1706) and
  dynamic database leases (B-1704) follow in Sprint 25.
- Plugins (1.4.0, Sprint 24c): manifests, grants and the lifecycle are enforced, but nothing runs a plugin yet:
  enabling one only marks it enabled. Declarative actions (each checked against its granted capability) and script
  handlers in the sandbox arrive later in 1.4.0; until then a script plugin is stored and cannot be enabled, and a
  manifest's `webhook.url` is not checked against the outbound host rules (it will be when plugin deliveries use the
  webhook path).
- Event catalogue (1.4.0): an emitted event that does not match its schema is still delivered (counted and logged),
  so a receiver must still validate what it gets. The `record`, `file`, `group`, `message` and `post` types are
  reserved, not emitted.
- Read-through cache (1.4.0): with Redis, cached values sit in Redis unsealed, so only ids and settings are cached,
  never tenant content (today: each tenant's list of enabled plugins). A Redis failure makes reads go to the database
  (`exprsn_cache_errors_total`); a cached value can outlive a change on an instance that missed the bus message by at
  most its tier's TTL.
- Realtime rooms (1.4.0): the generic mechanism is in place, but no domain registers an authoriser yet, so every
  `room.join` is refused until messaging, groups, feeds or channels ship.
