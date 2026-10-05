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
- Custom roles (1.5.0, B-3302) are built only from catalogue permissions and never hold a permission their creator, or
  for a pending version its approver, does not hold; a custom role is granted only by holders of its `grantableBy`
  roles who also hold every permission it carries, and it resolves only inside its own tenant. A role holding an admin
  permission (outside the member baseline) changes only when a second holder of `roles:manage` approves the version,
  and `requiresMfa` cannot be lower than the built-in roles granting the same permissions require. The zone ceiling and
  clearance steps still apply to everything a custom role grants.
- Every route declares what it requires in one table (`server/src/authz/routes.ts`, B-3304); the test suite fails
  for a route that is not declared or whose middleware disagrees with its entry. Access reviews (B-3305) remove a
  revoked grant at once, and the member's sockets leave the permission rooms it gave.

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

- Import repositories and model import (1.5.0, Sprint 30, B-3801 to B-3803): the allow-list is enforced by the
  platform's own egress (each hop of a redirect checked, credentials never forwarded along one); with
  `IMPORT_PROXY_URL` the connection is the proxy's, and the proxy must enforce the exported allow-list itself
  (`GET /api/imports/proxy-allowlist`): the platform cannot check the addresses the proxy dials. Hugging Face gates that
  the publisher approves by hand stay pending; the platform only sends the access request with the recorded token and
  records the acceptance once a file is readable. The licence is read from the model card at the pinned commit or the
  Ollama license layer and recognised from a fixed list; a card that misstates its licence is recorded as stated (legal
  review sees the source in the manifest). Staged weights are kept unsealed and content-addressed under
  `imports/blobs/` (public repository content; the copies handed to the training worker are sealed per tenant), and
  nothing expires them yet. Ollama registry imports pin the manifest digest and stage the layers, but the pools still
  pull the tag from the registry their Ollama is configured for (the registry itself, or an internal mirror): the
  platform does not serve the staged layers to Ollama, and on an air-gapped instance the pools need the bundle's
  models in that mirror. Classifier engines, speech and other non-Ollama models are refused until B-3806. Repository
  credentials resolve as the user who saved them (B-1705), so that user needs `secrets:read` and the vault path; a
  model admin without vault access records repositories without credentials. DCAT-AP, SDMX and OpenML have no search
  API, so they browse their snapshot only; OpenML licences are read for the first `detailLimit` datasets of a harvest.
  Dataset import (B-3804) is not built: its quota check (`admitDataset`) exists but nothing calls it yet.
- Permission matrices and custom roles (1.5.0, Sprint 29): custom roles are the tenant's; a workspace cannot define
  its own (the open decision in `Backlog-1.5.0.md` is settled that way for now). The roles in force are held in each
  instance's memory and reloaded through the bus when they change, so an instance without `REDIS_URL` sees another
  instance's change only after a restart (as for every bus-driven cache); a single instance applies it at once. The
  route registry checks the `requireAuth`, `requirePermission` and `requireAnyPermission` middleware only: a route
  declared `authenticated` or with a permission its handler checks itself is taken at its word, and conditions a
  handler adds (ownership, membership, clearance) are not in the table. Workflow approval steps and low-code state
  machines still name built-in roles only. Access reviews cover direct grants; roles and memberships from group
  mappings or the directory are reviewed at the mapping, since a removed row would come back at the next sign-in or
  sync. Reviewers are assigned per item (the grant's admins and the member's directory manager); the manager comes
  only from LDAP stores (`managerAttribute`) and SQL user tables (`columns.manager`), and only when the manager is a
  user linked to the same store (matched on the external id, ignoring case but not spacing within a DN); upstream
  OIDC and SAML claims, SCIM and the local store carry none, so their members are reviewed by admins only. Workspaces
  have no admin role of their own: a workspace's admins are the tenant admins and its members holding `roles:manage`.
  A grant whose only possible reviewer is its member (a sole tenant admin reviewing their own membership) stays
  unassigned to anyone else but the campaign's creator, and is escalated when overdue. A review does not snapshot API keys: a key's scopes only narrow its owner's roles, so revoking the role is
  enough. The effective-access matrix shows at most 100 workspaces and 100 users per answer, and its cells are the
  policy decision only: `member` says separately whether the user may act in the workspace.

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
  read of a secret are.
- Plugins (1.4.0, Sprints 24c and 25): a plugin is data; its declarative actions run through the existing services and
  its script handler in the script sandbox (no network, never in the server process), each gated by a granted
  capability, and every webhook endpoint it names is checked against the outbound host rules at install, at enable
  and at each delivery. Loop rule: whatever a plugin's work causes carries the chain of plugins behind it (in process
  while the invocation runs, in the invocation row across the job queue, and in the trigger of a workflow run a plugin
  started); an event is never delivered to a plugin already in its chain, and not at all once the chain is
  `PLUGIN_MAX_DEPTH` long; the plugin and webhook deliveries' own job states are never events for plugins. What leaves
  the platform is not traced: a webhook receiver (or a workflow's HTTP step) that calls the API back starts a fresh
  chain, so such a loop is bounded only by `PLUGIN_RATE_PER_MINUTE`. The in-process part of the chain rides an
  AsyncLocalStorage: work an action's callee defers to its own timers or connections opened during the action would
  carry it too, which only ever suppresses deliveries. A script handler holds its invocation's token (shown to it
  once, stored hashed, revoked when it ends); with the default sandbox it cannot use it except over its own stdin and
  stdout, but a sandbox with network could replay it to `/plugin-broker` until it expires or is revoked. The
  `records`, `files`, `groups` and `posts` calls answer `501` until their domains ship. The test suite runs handlers
  as local processes (`server/test/sprint25d-fakes.ts`); the container path is the scripts' and is not exercised in CI.
  Plugin logs and invocation events are sealed, but kept until the plugin is removed from the database by hand (no
  retention yet).
- Event catalogue (1.4.0): an emitted event that does not match its schema is still delivered (counted and logged),
  so a receiver must still validate what it gets. The `post` types are reserved, not emitted (the `record`, `file`,
  `group` and `message` types are emitted since their domains shipped).
- Read-through cache (1.4.0): with Redis, cached values sit in Redis unsealed, so only ids and settings are cached,
  never tenant content (today: each tenant's list of enabled plugins). A Redis failure makes reads go to the database
  (`exprsn_cache_errors_total`); a cached value can outlive a change on an instance that missed the bus message by at
  most its tier's TTL.
- Realtime rooms (1.4.0): groups (`group`) and messaging (`conversation`) register authorisers; a `room.join` for a
  kind nobody registered (`feed`, `channel` until they ship) is refused. Client signals into a room (`room.signal`:
  typing and receipts) are accepted only from a socket in that room, capped per socket (`ROOM_SIGNALS_PER_MINUTE`),
  and relayed only as the domain decides.
- Database leases (1.4.0, B-1704): the built-in engines hold an admin login to each target database (sealed, or a
  `vault:` reference read as the user who registered the engine), so whoever can act as that user's vault policy can
  make accounts there; registration needs `connections:manage` and a zone whose ceiling covers the engine. Only
  PostgreSQL accounts carry their expiry (`VALID UNTIL`); MySQL accounts live until the sweeper drops them, so a
  stopped sweeper (or `VAULT_LEASE_SWEEP_SECONDS=0`) leaves MySQL leases usable past their expiry. Ending a lease's
  open sessions needs `pg_signal_backend` (PostgreSQL) or `CONNECTION_ADMIN` (MySQL) on the admin login; without them
  a session opened before the drop runs on until it disconnects. When the admin login is a vault reference whose
  owner loses read on it, leases can be neither issued nor dropped until it is restored (the sweeper keeps retrying
  and the admins are told). Objects an account created itself (possible on PostgreSQL before 15 through `PUBLIC`'s
  `CREATE` on `public`) are dropped with it.
- Vault references (1.4.0, B-1705): a reference resolves as the user who saved the object (for workflow HTTP steps,
  as the user who started the run), every time it is used; changing that user's policy or disabling them stops the
  reference at its next use, except where a driver already holds an open pool: a SQL user store keeps its database
  pool until the store is saved again or the server restarts (LDAP binds, connections, MCP calls, engines and workflow
  steps read the reference every time). Stores defined in the configuration file have no owner and
  cannot use `vault:` references. Only KV secrets can be referenced, not transit keys or leases.
- Rotation schedules (1.4.0, B-1706): KV secrets cannot be rotated by the server (it does not know how to make the
  next value), so their schedules only notify; transit keys can rotate themselves (`autoRotate`). Notices are checked
  every `VAULT_ROTATION_CHECK_MINUTES`, so one can arrive up to that late.
- AT-Protocol trust (1.4.0, Sprint 25): DAG-CBOR, CIDs, did:key, did:plc and low-S ECDSA are implemented here and
  pinned by known-answer tests from the reference libraries, but have not been run against the live PLC directory,
  Bluesky's AppView or Ozone; treat interoperability as unproven until the interop tests of the Risks table run.
  secp256k1 keys need the signer (OpenBao transit has no secp256k1 key type); under OpenBao only P-256 is offered.
  Making or rotating the platform identity needs `platform:manage` and a recent sign-in, not a second admin. A
  `did:plc` key rotation is applied here only after the directory accepts it; if the directory accepts and this
  server then fails to record it, the identity must be repaired by hand from the directory's log (no reconciliation
  job yet), and a rotation that the directory refuses leaves an unused key in the signer's or OpenBao's custody.
  Labels signed by a retired key are re-signed when next served, so a consumer that cached an old label sees two
  signatures over the same label. Path-form tenant labelers (`<base>/atproto/<slug>`) have a path in their service
  endpoint, which some AT-Protocol clients drop; a tenant that needs broad interoperability should use its own host.
  The `did:web` path is the tenant slug at creation; renaming the tenant does not move it. Tenants that fall back to
  the platform identity share its labels: a value one tenant put on a subject is in force for all of them, and only
  that tenant can withdraw it. Inbound labels are read
  from `subscribeLabels` only (no push), from cursor 0 for a new labeler (a large labeler's history takes several
  pulls of 5,000 messages); a labeler's negation is stored but does not close the flag its earlier label raised.
  The verdict-to-label mapping uses a fixed keyword table over rule names and details. The labeler declaration
  record (`app.bsky.labeler.service`) needs a PDS, which Exprsn-AI does not host, so clients only act on the global
  values (`!hide`, `!warn`, `porn`, `sexual`, `nudity`, `graphic-media`) unless they read this labeler's values some
  other way.
- AT-Protocol accounts (1.4.0, Sprint 26, B-1807, B-1808): the OAuth client (PAR, PKCE, DPoP with server nonces,
  `private_key_jwt`, the issuer check through the account's own PDS) has only been run against the local PDS double in
  `server/test/sprint26b-fakes.ts`, never against bsky.social or another real PDS; treat interoperability as unproven.
  Real authorization servers require an https `client_id`, so AT-Protocol sign-in needs `FEDERATION_ISSUER` (or
  `PUBLIC_URL`) on https and reachable from the internet, and outbound https to PDSes, which `SERVICE_INTERNAL_ONLY`
  blocks unless their hosts are allow-listed. Plain http to loopback addresses is accepted outside production only.
  Client assertions are signed with the tenant's OIDC signing key (published at its jwks_uri), not a key of their own.
  Tokens are revoked and discarded after sign-in, so nothing can act on the account's repository; the `atproto` scope
  only. A DID bound to a user signs in as that user without that user's password: binding needs a recent sign-in, and
  an admin role still needs its second factor, but an AT-Protocol user without a local factor cannot step up for
  actions that need a recent sign-in (upstream step-up covers OIDC and SAML only). The profile challenge reads the
  `app.bsky.actor.profile` record, which accounts outside Bluesky may not have (they can link by signing in instead);
  whoever runs the account's PDS can also write that record. The handle stored with a binding is checked when it is set,
  not again later (sign-in checks the handle it uses each time). Handles under `.test` are accepted outside production.
- File store (1.4.0, Sprint 26d): content is sealed in 64 KiB AES-GCM segments under a random key per version, and
  that key is sealed with the tenant key, so offboarding crypto-shreds files with the rest of the tenant's content.
  The quarantine scan reads the whole file twice (type check and classification, then ClamAV); ClamAV refuses streams
  above its `StreamMaxLength` (25 MB by default), which rejects larger files until the operator raises it to
  `FILES_MAX_BYTES`. Zip archives are buffered to find out whether they are Office documents, so larger zips than
  32 MiB are refused; only text, PDF, Word, Excel, PowerPoint, PNG, JPEG, WebP and GIF are accepted. Classification
  for personal and financial data covers text files only (PDFs and Office files are classified when a knowledge
  source indexes them, not in the store). Sharing is per file (not per folder) and read-only; a group share matches
  the groups the reader's identities carried at their last sign-in or directory sync. A link's use is consumed when
  the download starts, so a download that fails part-way still counts. Anonymous links follow the conversation
  settings (one tenant switch for both) and have no landing page or metadata route: the holder can only download.
  Previews are drawn by external tools (ffmpeg, poppler's pdftoppm) on the server, as argument arrays without a
  shell, from a decrypted temporary copy in `FILES_WORK_DIR` (mode 0600, removed afterwards); run them in a
  sandboxed host or container if untrusted PDFs are a concern. A folder used as a knowledge source is indexed on the
  source's schedule, not when a file changes, and only files at or below the knowledge base's label; whoever may read
  the base reads what it indexed, so the curator adding the folder decides who sees its contents. Storage quotas
  count every stored and quarantined version (trash included, previews not); two uploads racing at the limit are
  checked again after they are recorded, so one may be refused that would have fitted after the other failed.
  Files are not yet moderation objects: `FileService.moderationTarget` and `takeDown` are ready for the moderation
  object registry (B-1901) to call.
- Moderation (1.4.0, Sprint 26): a check of a registered object inspects its stored text: a message's content, but
  only a knowledge document's name, a media asset's name and an image's prompt, unless the caller passes the text
  (there is no OCR or transcript step, and the image-safety classifier stays separate). Hiding is a state on the
  object; a knowledge document whose source later syncs changed content goes back to indexing and is no longer
  hidden, and its next check decides again. A suspended or banned user cannot sign in to appeal: they ask an
  administrator, and a reviewer files the appeal for them (`forUserId`). Enforcement reads a cached sanction (the
  short cache tier, cleared over the bus on every change), and a sanction's end is compared at each request, so the
  sweep only records it. A sanction does not revoke API keys or OAuth grants; they are refused while it lasts and work
  again after it. Review queues route a flag when it is created (adding a queue does not route older flags) and
  escalate one level, once; unrouted flags keep the breach notice only. Dead letters are recorded by the instance on
  which the job failed. External providers receive the object's text (up to 32,000 characters) and its type; the
  zone check reads the zone definitions, while the network itself is held by the zone's NetworkPolicy or nftables
  rules. Notices carry the moderator's reason, not the moderated content.
- Firehose ingest (1.4.0, Sprint 27, B-1908): tested against a local Jetstream and relay double only, not yet against
  the public Jetstream or a live relay. Records from subscribeRepos are read from the commit's CAR blocks without
  verifying the commit signature or the repository's Merkle tree against the author's DID document, so a relay could
  hand over records an author never wrote; Jetstream carries no proofs at all. Trust the endpoint you subscribe to.
  Ingested posts are an unregistered moderation type (`atproto-post`): they are checked with their text and get a flag
  and labels, but cannot be reported, hidden or appealed through the object registry (Exprsn-AI does not store them),
  and a deleted post's labels are not withdrawn. Images and video are not fetched; only text and alt text are checked.
  The flag stores the post text (sealed, as for any flag). A consumer is held by one instance through a lease of three
  `FIREHOSE_TICK_MS`; after a crash another instance takes over when the lease runs out and resumes from the last
  stored cursor (at most `FIREHOSE_CHECKPOINT_MS` old), so posts handled since are checked again (a check is idempotent
  per post: one flag). A failed check is retried three times and then counted as `failed` and skipped.
- Groups and events (1.4.0, Sprint 27c). Workspace membership is checked on every request, so a member who leaves
  the workspace loses its groups at once, but their membership and RSVP rows stay (they come back if the user
  rejoins the workspace). Group names are stored in the clear (like file names); descriptions, posts and event titles,
  descriptions and locations are sealed. In-app notices name the group, which a notification row stores in the clear;
  emails carry only the time and a link. Calendar feed URLs are bearer credentials: anyone holding one reads the
  owner's events up to `CALENDAR_FEED_MAX_LABEL` (above it, busy time only) until the owner revokes it, and calendar
  programs fetch them over the network, so a URL in a mail client or third-party calendar should be treated as
  shared. Feed signatures use a key derived from `SESSION_SECRET`; rotating it invalidates every feed (there is no
  per-feed key rotation other than revoking and creating a new one). Feed fetches are not audited one by one (they
  record `lastUsedAt`); creation and revocation are. Events have no recurrence and no VTIMEZONE (times are UTC, which
  RFC 5545 allows); a wall-clock time in a daylight-saving gap moves forward by the gap. Reminders go to attendees
  who said going or maybe, not to every member; capacity is checked in a transaction, which on SQLite and PostgreSQL's
  default isolation can let two simultaneous RSVPs past the last place. Group posts are small discussion content
  (no edit, no attachments, no threads); the workspace feed is B-27.
- Customer-service channels (1.4.0, Sprint 28a, B-23). Customer sessions are public by design: the channel's public
  key is not a secret, so anyone can start an anonymous session on a chat channel that allows them, limited per client
  address (`CHANNELS_SESSIONS_PER_HOUR` and the channel's own `sessionsPerHour`) and per session
  (`messagesPerMinute`); behind a proxy the address is only as good as `TRUST_PROXY`. Set the channel's label to what
  anonymous people may receive (`public` or `internal`): the label limits the profile, agent and pool that answer, not
  what a customer may type. Channels answer from the profile's or agent's prompt only: no knowledge retrieval, memory
  or tools (an agent's tools never run for a customer). Session tokens are bearer credentials for one session (HMAC
  with a key derived from `SESSION_SECRET`, `CHANNELS_SESSION_HOURS`); they cannot be revoked one by one except by
  closing or hiding the session. Identity assertions are signed by the channel's site with the channel's identity
  secret (shown once); a leaked secret lets anyone act as any customer of that channel until it is rotated, and
  assertions carry no audience or nonce, so one is replayable until its `exp` (at most a day). Customers poll for
  answers released by review; there is no customer socket. Transcripts, customer names, addresses and subjects are
  sealed; the `customer_key` that threads email is an HMAC (with `SESSION_SECRET`) of the address, so rotating that
  secret breaks threading for earlier customers (their next mail starts a new session). Email threading trusts
  `In-Reply-To`/`References` only together with the sender address, which a spoofed `From` can still forge where the
  receiving mail server does not enforce SPF/DKIM/DMARC; an attacker who knows a customer's address and one of the
  thread's Message-IDs could add a message to that session (they still never see the replies, which go to the real
  address). IMAP polls read the mailbox read-only and never mark or move messages; messages over 10 MB are skipped.
  The imapflow adapter itself is exercised only against a fake fetcher in the unit tests, not a real IMAP server.
  Mailgun inbound is form-encoded only (routes that forward attachments post multipart, which is refused with `415`);
  Postmark, SendGrid and others use the generic shape through a relay. Bounces from IMAP are read from RFC 3464
  delivery reports only (not from free-text bounce mails). Held replies use the flag queue: a reviewer who can see the
  flag and holds `flags:review` can approve or reject it there; only `channels:review` holders can edit. Retention is
  per channel on last activity; purged sessions' open review flags are closed as rejected directly (without a flag
  event). Channel CSV exports are sealed in the blob store until downloaded by the person who asked, and not deleted
  afterwards, like app exports.
- Email one-time codes (1.4.0, Sprint 28a, B-1806). An email factor is weaker than TOTP or a passkey: whoever reads
  the mailbox has the factor, and email travels through servers outside the deployment. It is offered because some
  users have nothing else; roles that require a second factor accept it too (the MFA policy does not tell factors
  apart yet). The address is the account's address at enrolment, kept sealed in the factor, so a later change of the
  account's address does not move the factor (remove and enrol again). Codes are six digits, valid for
  `MFA_EMAIL_CODE_MINUTES`, single use, bound to the pending session they were sent for, and their wrong guesses count
  in the same lockout as TOTP codes. Step-up re-authentication does not take email codes yet.
- Social relations (1.4.0, Sprint 28b, B-2606). Blocks, mutes, follows and lists are stored in the clear (user ids
  only) and audited under `social.*`, so tenant auditors and `social:manage` holders can see who blocked or follows
  whom (an admin's view of one user's relations is itself audited). A block is checked when a message, post or socket
  event is raised: events already relayed before the block are not withdrawn, and a socket already in a room keeps
  receiving other people's events there (only the blocked pair's events to each other are left out). The contact rule
  applies when a conversation is started or a person added; a conversation that already exists keeps working until
  one of the two blocks the other.
- Messaging (1.4.0, Sprint 28b, B-26). Messages and conversation titles are sealed with the tenant key (the row id as
  associated data); there is no end-to-end encryption, by design, so the server (and so a tenant's operators with the
  key) can read them, which is what lets search, summaries and moderation work. The keyword index holds keyed hashes
  of words (as knowledge does), which reveal which messages share a word to someone with database access but not the
  word; vectors for semantic search (`MESSAGING_EMBED_MODEL`) are stored unsealed in the vector store, like knowledge
  vectors, and are approximately invertible. A deleted message keeps its row as a tombstone (author, times, edit count)
  and loses its body, attachments list, terms, vector and reactions; earlier sealed bodies of an edited message are
  overwritten, not kept, and backups taken before the delete still hold them until they expire. Attachments are file
  ids from the file store: a file must have passed its scan and lie in a workspace every member can read it through,
  but trashing, re-labelling or taking down the file later is the file store's business (the message shows its state).
  Direct conversations have no workspace: they need the two people to share one now, so losing that common workspace
  hides the conversation from both. A member added to a group conversation reads from the moment they were added.
  Receipts, typing and presence are not audited (they are not changes to content); presence is the time a socket last
  joined or left the room, not a live status, and reflects only sockets in that conversation's room. Summaries and
  digests send the visible messages (up to `MESSAGING_SUMMARY_MAX_MESSAGES`, each cut to 2,000 characters) to the
  profile's model through the gateway and meter it like workflow model calls; they run in the request, not as a job.
  Notifications name the sender (and that it was a group conversation), never the text or the title.
- Workspace feed (1.4.0, Sprint 28c, B-27). Post bodies, comments and digest summaries are sealed; hashtags (lower
  case), reactions, bookmarks, the trending counts and each digest's ranked post ids are stored in the clear so they
  can be queried and counted. Realtime feed events carry ids only and are filtered when raised: people whose stored
  clearance is below the post's label and everyone in a block with the author are left out, but someone who joined a
  workspace room learns that a post id exists before fetching it (the fetch applies clearance, blocks and group
  membership again). A block hides content from the moment it is made; events already relayed are not withdrawn, and
  a digest summary written before a block may still name the blocked person (its post list is filtered at read). The
  digest is written by a model from the posts' text: it is screened at `model-output`, but a summary can misstate a
  post. Only posts wait for review: an edit or comment that a rule would hold is refused instead, and a quoted repost
  is held like a post. Group posts' hashtags are left out of trending; a workspace's trending tags are visible to its
  members at each label they are cleared for, so a tag used only in internal posts is visible to every internal
  reader. The home fan-out uses stored workspace and group membership: tenant admins who read every workspace get
  their followed people's posts on the next load rather than live. Comments are not threaded beyond `parentId` (no
  depth limit) and send no notifications.
- Identity gaps (1.4.0, Sprint 26a). Self-registration is closed unless a tenant admin opens it; its accounts get only
  the member, flag-reviewer or knowledge-curator roles. Sign-up answers say whether a username or address is taken
  (as most registration forms do); they are throttled per client address and per address. Email verification is off
  until a tenant turns it on; addresses that an admin typed, imported or invited count as proven, and directory
  accounts' addresses belong to the directory. There is no per-workspace admin role yet: `members:invite` is a
  tenant-wide permission (tenant and identity admins), limited to the inviter's own workspaces and to roles they may
  grant. A trusted device skips the second factor for the tenant's `trustedDeviceDays`, but never for accounts whose
  roles require a second factor (admins) or that are marked as needing one: those are asked for it on every sign-in.
  For everyone else it is bound to the device cookie, so a stolen cookie together with the password passes until the
  period ends or the user's sessions are revoked (a plain sign-out keeps the trust). The MFA grace period starts when
  the requirement last widened, not per user. GitHub sign-in reads organisation and team membership once per sign-in;
  leaving a team takes effect at the next sign-in (there is no directory sync for GitHub), and an organisation that
  restricts OAuth app access hides its membership until the app is approved there. Step-up re-authentication through
  GitHub is not offered (GitHub has no `prompt=login`); GitHub accounts step up with a second factor. CSV imports create accounts with a
  password nobody knows: the users need an invitation link (`sendInvites`) or a reset by an admin.
- Low-code apps (1.4.0, Sprint 27, B-22). Records are sealed with the tenant key (the record id as associated data),
  but sealed values cannot be filtered in SQL, so the design is deliberate: a designer marks the fields that may be
  filtered, sorted, searched and aggregated `indexed`, and those values (lower-cased text, numbers, dates as epoch
  milliseconds, booleans) are also stored **in clear** in `app_record_values`, readable by anyone with database
  access. Mark only fields that are not sensitive; everything else (notes, JSON, unindexed text, AI fields unless
  marked) stays only in the sealed record. A `unique` field stores an unkeyed SHA-256 of the entity, field and
  normalised value in `app_unique_values`; a low-entropy value (a small number, a common word) can be guessed from
  it by someone with database access. Indexed text is compared lower-cased after Unicode NFC, byte-wise (no accent
  folding, no locale collation: `é` sorts after `z`), and is at most 255 characters, so an indexed text field has a
  `maxLength` of at most 255; uniqueness is case-insensitive. Filters cover a tested subset (`eq`, `ne`, `gt`, `gte`,
  `lt`, `lte`, `in`, `contains`, `startsWith`, `exists`, with `and`, `or`, `not`), with the same results on every
  dialect; PostgreSQL's plans differ only in its collated, partial value indexes (031b). Offset pagination stops at
  100,000; a cursor (keyset paging, B-3601, 1.5.0) goes further at the cost of the first page, but each page still
  counts every match for `total`, so an entity with very many matching records costs that count on every page (an
  estimated total is not offered yet). A cursor is opaque but not sealed: it carries the last record's sort values
  and id, which the caller has just read, and is checked against the sort it is sent with. An existing field cannot become unique while the entity has records, and
  a field's type cannot change then. Formulas are parsed and walked (no `eval`), read only the entity's own non-computed
  fields, and give null on any error; they are computed on write (and by the reindex job), so `today()` and `now()`
  are the time of the last write. AI fields are filled by a job after the write, fail soft (an error leaves the field
  empty, recorded in `aiError` and audited) and are cleared when their inputs change until the job fills them again; a
  record written by a public form is filled with no person behind it (only the profile's label is checked). Public
  forms take only listed, visible fields, never files, references or user, workspace or record lookups, are limited per
  address (`APPS_PUBLIC_FORM_PER_MINUTE`) and per form, and screen every text value at `user-input`; a held value is
  refused rather than held for review. A form's link token is shown once and stored as an HMAC with `SESSION_SECRET`,
  so rotating that secret ends every public form link. Triggers run as their owner with what the owner holds when they
  fire; chains stop at `APPS_TRIGGER_MAX_DEPTH`, and a workflow's own record steps never fire its own triggers, but two
  workflows that update each other's entities stop only at that depth. A trigger's run input holds the record's values,
  sealed in the run like any workflow input. App bundles are signed with an HMAC key in the KMS
  (`<OPENBAO_KEY_PREFIX>app-bundles`), so they verify only on installations that share that key (the same `DATA_KEY`
  or OpenBao transit key); bundles between unrelated installations would need the offline-signed import bundles
  (B-2005), which do not carry apps yet. Bundles carry the design only (no records, triggers or form links). CSV
  exports are sealed in the blob store until downloaded by the person who asked, and are not deleted afterwards; the
  CSV of an import is dropped from its row once the job has run. A CSV import travels in the JSON body, so it is at
  most `APPS_IMPORT_MAX_BYTES` (200 kB by default, under the API's 256 kB limit).
- Gateway slots: a chat turn's own requests (embeddings, guard-model verdicts on the streamed text and on tool results,
  tools that call a model) ride on the slot the turn holds instead of queueing for it (Sprint 26a), so Ollama may
  receive more concurrent requests on that instance than its `parallel` setting while a turn's verdicts run, and
  queues them itself. The `/v1` API, agent runs and workflows still lease a separate slot for each call they make.
