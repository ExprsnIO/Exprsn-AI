# Deploying Exprsn-AI

Exprsn-AI runs as one Node.js process per host, or several behind a load balancer when Redis is configured (the
Socket.io adapter, the BullMQ job queue and the cross-instance bus all use it), in front of an application database,
a blob store and Ollama nodes. TLS terminates in front of it. More than one server process on a database needs
Redis, and the server refuses to start without it: see [Redis and more than one process](#redis-and-more-than-one-process).

## Configuration

All settings are environment variables. Secrets may be given as `<NAME>_FILE` pointing at a file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:8080` | The address users open. Its origin, with `TRUSTED_ORIGINS`, is what state changes and sockets are allowed from; its host is the WebAuthn relying party |
| `TRUSTED_ORIGINS` | empty | Other origins people reach the server at (comma-separated, such as a LAN name or IP address behind the proxy), accepted like `PUBLIC_URL`'s by the cross-origin checks and the socket. Cookies and links still follow `PUBLIC_URL`; passkeys follow the trusted origin the page is on when it is a secure context (https, or localhost), with that host as the relying party |
| `NODE_ENV` | `development` | `production` requires an `https://` `PUBLIC_URL` (or `COOKIE_SECURE=true`) and refuses insecure LDAP |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | Listen address |
| `TRUST_PROXY` | `loopback` | Express trust-proxy setting for the TLS proxy (`loopback`, `uniquelocal`, an address, or a hop count). 1.9.99-final (B-10901): the keyword `cloudflare` in the list (`loopback,cloudflare`; never with `true`) puts the install behind the Cloudflare front door: `CF-Connecting-IP` is the client address only from Cloudflare's ranges or the tunnel connector, and dropped from anyone else; without it no Cloudflare header is read ([cloud.md](cloud.md#cloudflare-front-door-b-10901-to-b-10904)) |
| `CLOUDFLARE_TUNNEL_PEERS` | (empty) | 1.9.99-final (B-10901): the tunnel connector's addresses (addresses, ranges, `loopback`, `uniquelocal`, `linklocal`), believed only as the socket's own peer; with `cloudflare` in `TRUST_PROXY` only. Empty by default since the B-10803 review (it was `loopback`): name the connector, and never an address a local proxy such as nginx also uses |
| `CLOUDFLARE_IP_RANGES` | shipped list | 1.9.99-final (B-10901): replaces the shipped list of Cloudflare's egress ranges (comma-separated) until a release carries a change |
| `CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_SCOPE` | —, —, `admin` | 1.9.99-final (B-10904): the server's own Cloudflare Access check: the Access application's audience tag (64 hex, comma-separated), the team (`<team>.cloudflareaccess.com`), and what it protects (`admin`: /api/admin and /admin; `host`: everything but the machine and public paths). A protected request then also needs a valid `Cf-Access-Jwt-Assertion`; it never replaces the session |
| `DB_CLIENT` | `sqlite` | `pg`, `mysql` or `sqlite` |
| `DATABASE_URL` (`_FILE`) | — | Required for `pg` and `mysql` |
| `SQLITE_FILENAME` | `./data/exprsn-ai.sqlite` | For `sqlite` |
| `DB_MIGRATE_ON_START` | `true` | Otherwise run `exprsn-ai migrate` before starting |
| `SESSION_SECRET` (`_FILE`) | — | 32+ random bytes. Since 1.7.0 it is version 1 of the vault's platform keys (sessions, CSRF, API keys, links): changing it later changes nothing once the server has opened the scope; rotate the keys at `/api/admin/platform/vault` instead |
| `DATA_KEY` (`_FILE`) | — | 32 bytes, base64; the local KMS master key that wraps each tenant's data key. Required with `KMS_PROVIDER=local` unless the signer runs (`SIGNER_SOCKET`). Since Sprint 20, production accepts it only as `DATA_KEY_FILE`, and not at all with the signer |
| `KMS_PROVIDER` | `local` | `local`, `openbao` (OpenBao or Vault transit), or since 1.9.99-final `aws-kms` or `azure-keyvault` (B-10208) |
| `OPENBAO_ADDR`, `OPENBAO_TOKEN` (`_FILE`), `OPENBAO_TRANSIT_MOUNT`, `OPENBAO_KEY_PREFIX`, `OPENBAO_CA_FILE` | —, —, `transit`, `exprsn-`, — | Transit engine address and token; one key per tenant (`exprsn-tenant-<id>`), one for audit checkpoints. The token needs create, encrypt, decrypt, hmac, verify, update-config and delete on those keys |
| (OpenBao signing, Sprint 14) | — | With `KMS_PROVIDER=openbao` the OIDC (ES256, `ecdsa-p256`) and SAML (RS256, `rsa-2048`) signing keys are created in transit as `<OPENBAO_KEY_PREFIX>fed-<kid>` and every token, assertion and logout message is signed there (`sign/<key>/sha2-256`), so no private signing key enters the process. The token also needs create, read and sign on those keys. The SAML SP decryption key stays sealed locally |
| `KMS_AWS_REGION` | — | 1.9.99-final (B-10208), `KMS_PROVIDER=aws-kms`: the AWS region of the KMS keys (one symmetric key per tenant as `alias/<OPENBAO_KEY_PREFIX>tenant-<id>`, with automatic yearly rotation; one ECC_NIST_P256 signing key per signing name as `alias/<name>-mac`). See [Keys and blobs on a cloud](#keys-and-blobs-on-a-cloud-1999-final-b-10208) |
| `KMS_AWS_ENDPOINT` | `https://kms.<region>.amazonaws.com` | The KMS endpoint (an interface VPC endpoint's DNS name, for example); a host outside `*.amazonaws.com` must be named in `SERVICE_ALLOWED_HOSTS` |
| `KMS_AWS_ROLE_ARN` | — | The role the install assumes with its web identity token (STS `AssumeRoleWithWebIdentity`); goes with `KMS_AWS_WEB_IDENTITY_TOKEN_FILE` |
| `KMS_AWS_WEB_IDENTITY_TOKEN_FILE` | — | The web identity token file, read again at every session refresh (on EKS the projected service-account token, `/var/run/secrets/eks.amazonaws.com/serviceaccount/token`) |
| `KMS_AWS_STS_URL` | `CLOUD_AWS_STS_URL` | The STS endpoint for the web identity session (a regional one, such as `https://sts.eu-central-1.amazonaws.com`) |
| `KMS_AWS_ACCESS_KEY_ID` | — | Instead of a web identity: a vaulted IAM key pair, with `KMS_AWS_SECRET_ACCESS_KEY_FILE` |
| `KMS_AWS_SECRET_ACCESS_KEY` (`_FILE`) | — | The secret key of `KMS_AWS_ACCESS_KEY_ID`. Production accepts it only as `KMS_AWS_SECRET_ACCESS_KEY_FILE` |
| `KMS_AWS_DELETION_DAYS` | `7` | Destroying a tenant's keys (offboarding) schedules the KMS keys for deletion after this many days (7 to 30) and removes their aliases at once |
| `KMS_AZURE_VAULT_URL` | — | 1.9.99-final (B-10208), `KMS_PROVIDER=azure-keyvault`: the vault (`https://<vault>.vault.azure.net`); one RSA-3072 key per tenant wraps its data keys (RSA-OAEP-256), one EC P-256 key per signing name (`<name>-mac`) signs. The identity needs the Key Vault Crypto Officer role (create, get, wrap, unwrap, sign, delete; purge to crypto-shred at once) |
| `KMS_AZURE_HSM` | `false` | HSM-backed keys (`RSA-HSM`, `EC-HSM`; a Premium vault) |
| `AZURE_IDENTITY_TENANT_ID` | — | 1.9.99-final (B-10208): the Entra tenant of the install's own identity, for `azure-keyvault` and `BLOB_STORE=azure` |
| `AZURE_IDENTITY_CLIENT_ID` | — | The client id of the install's identity (a managed identity or an app registration with a federated credential) |
| `AZURE_IDENTITY_FEDERATED_TOKEN_FILE` | — | Workload identity: the federated token file used as the client assertion (on AKS `/var/run/secrets/azure/tokens/azure-identity-token`), read again at every token refresh |
| `AZURE_IDENTITY_CLIENT_SECRET` (`_FILE`) | — | Instead of workload identity: the app registration's client secret. Production accepts it only as `AZURE_IDENTITY_CLIENT_SECRET_FILE` |
| `DPOP_PROOF_MAX_AGE_SECONDS` | `60` | How old a DPoP proof (RFC 9449) may be; its `jti` is remembered that long (in the database, shared by all instances) so it cannot be replayed. The API checks the proof's `htu` against `PUBLIC_URL` |
| `BLOB_STORE` | `fs` | `fs`, `s3` (MinIO, Ceph, SeaweedFS, AWS S3, DigitalOcean Spaces, Cloudflare R2) or since 1.9.99-final `azure` (the Azure Blob API, B-10208) |
| `BLOB_DIR` | `./data/blobs` | For `fs` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (`_FILE`), `S3_FORCE_PATH_STYLE` | —, `us-east-1`, —, —, —, `true` | For `s3` |
| `BLOB_AZURE_ENDPOINT` | — | For `azure`: the storage account's blob endpoint (`https://<account>.blob.core.windows.net`, or a private endpoint) |
| `BLOB_AZURE_CONTAINER` | — | For `azure`: the container (created beforehand; the identity needs Storage Blob Data Contributor on it) |
| `BLOB_AZURE_ACCOUNT` | — | For `azure` with Shared Key: the account name, when the endpoint does not start with it |
| `BLOB_AZURE_ACCOUNT_KEY` (`_FILE`) | — | For `azure`: the account key (Shared Key) instead of the install's Entra identity. Production accepts it only as `BLOB_AZURE_ACCOUNT_KEY_FILE` |
| `REDIS_URL` (`_FILE`) | — | Enables BullMQ, the Socket.io Redis adapter and the cross-instance bus: required to run more than one server process on a database (1.7.0, B-9001: a process that is one of several refuses to start without it, and with it `/readyz` fails while Redis does not answer) |
| `SERVER_REPLICAS` | `1` | 1.7.0 (B-9001): how many server processes the install runs, as its deployment knows it (the Helm chart sets it from the replica count or the autoscaler's maximum). Above 1 the server refuses to start without `REDIS_URL` |
| `JOB_QUEUE` | `auto` | `db` (database polling), `bullmq`, or `auto` (BullMQ when `REDIS_URL` is set) |
| `JOB_POLL_MS`, `JOB_CONCURRENCY`, `WORKERS_ENABLED` | `1000`, `4`, `true` | Job workers on this instance; set `WORKERS_ENABLED=false` for web-only instances (another process then runs the jobs, so `REDIS_URL` is required) |
| `JOB_TYPE_LIMITS` | `knowledge.sync=2` | The most jobs of one type an instance runs at once, as `type=n` pairs separated by commas. To lift the default, give the type as many as `JOB_CONCURRENCY` (an empty value counts as unset and keeps the default). Long jobs of one type (a crawl's sync) then leave worker slots for everything else. Per instance, like `JOB_CONCURRENCY` |
| `SMTP_URL` (`_FILE`), `SMTP_FROM` | — | Notification email (`smtp://` or `smtps://`); without it notifications reach the console only |
| `SIEM_URL`, `SIEM_TOKEN` (`_FILE`) | — | Audit events are POSTed there as NDJSON batches (Splunk HEC raw, Elastic, Vector, Fluent Bit, Logstash) |
| `SIEM_TENANT_MAX_DESTINATIONS` | `5` | Audit streaming per tenant (1.6.0): how many proposed or active SIEM destinations a tenant may have |
| `DIRECTORY_SYNC_MINUTES`, `AUDIT_CHECKPOINT_MINUTES` | `60`, `60` | Directory sync and signed audit checkpoints per tenant (0 turns off) |
| `OLLAMA_POLL_MS`, `OLLAMA_TIMEOUT_MS` | `5000`, `4000` | Instance polling (`/api/version`, `/api/ps`, `/api/tags`) |
| `OLLAMA_MAX_INFLIGHT`, `OLLAMA_QUEUE_TIMEOUT_MS` | `4`, `120000` | Default parallel requests per instance (instances may set their own) and how long a request waits for a slot |
| `OLLAMA_MAX_LOADS_PER_10_MIN` | `6` | Anti-thrash limit per instance |
| `OLLAMA_LOAD_TIMEOUT_MS` | `300000` | How long chat and embeddings wait for Ollama's first response, including a cold model load; raise it for large models on slow storage |
| `ATTACHMENT_MAX_BYTES` | `10485760` | Largest chat attachment |
| `CLAMD_HOST`, `CLAMD_PORT` | —, `3310` | ClamAV daemon for attachment scanning; without it attachments get the type check and classifier only |
| `MCP_ALLOWED_HOSTS` | — | MCP servers must resolve to internal addresses; this comma-separated list of hostnames (`*.example.com`) and CIDR networks allows others |
| `IDENTITY_ALLOWED_HOSTS` | — | The same for LDAP directories and SQL user-store databases, checked before every connection |
| `CONNECTIONS_ALLOWED_HOSTS` | — | The same for data connections (PostgreSQL, MySQL, OpenSearch, MongoDB); PostgreSQL, MySQL and MongoDB dial the checked address, OpenSearch never follows redirects |
| `SECRET_REF_ENV` | — | Environment variables user stores and upstream IdPs may reference as `env:NAME`: names or `PREFIX*` patterns, comma-separated. Empty means none. The server's own settings (and their `_FILE` forms) are refused whatever this says |
| `SECRET_REF_DIRS` | `/run/secrets,/run/credentials,/etc/exprsn-ai/credentials` | Directories `file:` references must resolve inside (symlinks followed); the server's own secret files are refused |
| `MCP_TIMEOUT_MS`, `MCP_POLL_MINUTES` | `15000`, `15` | MCP request timeout; how often every server's tools are re-listed and re-hashed (0 turns off) |
| `SCRIPT_RUNNER` | `auto` | Script sandbox: `docker` or `podman` CLI (`auto` uses whichever answers), or `none` to refuse script runs. The server's user must be allowed to run containers (rootless Podman is recommended) |
| `SCRIPT_IMAGE_PYTHON`, `SCRIPT_IMAGE_NODE` | `python:3.13-slim`, `node:22-slim` | Images for Python and JavaScript scripts; pin digests and mirror them internally, as nothing is pulled from outside at run time in an air-gapped install |
| `SCRIPT_IMAGE_TOOLS` | `exprsn-ai/scripts:1` | Image for Bash, sh, Perl, Ruby, Tcl, Lua, PHP, awk, jq and SQL (SQLite) scripts, with jq, sqlite3, miller, xmlstarlet, bc and the coreutils for shell scripts; build it with `docker build -t exprsn-ai/scripts:1 deploy/docker/script-tools`. TypeScript scripts run on `SCRIPT_IMAGE_NODE` |
| `SCRIPT_IMAGE_POWERSHELL` | `mcr.microsoft.com/powershell:lts-ubuntu-22.04` | Image for PowerShell scripts |
| `WORKFLOW_HTTP_HOSTS`, `WORKFLOW_HTTP_ALLOW_LOOPBACK` | —, `false` | Workflow HTTP steps call private addresses, and public hosts the tenant's list of allowed hosts names (1.7.0); this comma-separated host list narrows the private ones further |
| `HTTP_TOOL_TIMEOUT_MS`, `HTTP_TOOL_MAX_RESPONSE_BYTES` | `30000`, `1048576` | 1.6.0, Sprint 37a: HTTP tools in the registry (B-89). The most a tool's timeout and answer cap may be. Every call goes through the outbound address guard: cloud metadata addresses never, internal hosts only when `SERVICE_ALLOWED_HOSTS` names them, public hosts only from the tenant's list of allowed hosts (Registry, Allowed hosts). In a Helm install with the default-deny network policy, the pods also need an egress rule to those hosts |
| `CHAIN_MAX_DEPTH`, `WORKFLOW_MAX_DEPTH`, `AGENT_MAX_DEPTH`, `CHAIN_MAX_TOKENS`, `CHAIN_MAX_STEPS`, `CHAIN_MAX_WALL_SECONDS`, `CHAIN_MAX_GPU_SECONDS` | `8`, `3`, `3`, `200000`, `400`, `7200`, `3600` | 1.5.0 (B-4101): the chain context. A chain of invocations (agent runs, workflow runs, tool calls, skill loads…) is at most `CHAIN_MAX_DEPTH` deep across kinds, with at most `WORKFLOW_MAX_DEPTH` nested workflow runs and `AGENT_MAX_DEPTH` nested agent runs; a root without budgets of its own (a chat turn, a plugin action, an app trigger) gets the `CHAIN_MAX_*` budgets (GPU seconds are the cost meter). Every instance must use the same values |
| `MEDIA_FFMPEG`, `MEDIA_FFPROBE`, `MEDIA_ENCODER` | `ffmpeg`, `ffprobe`, `auto` | Media worker binaries; `auto` uses NVENC when the GPU offers it, else the CPU (`nvenc`, `cpu` force one) |
| `MEDIA_MAX_BYTES`, `MEDIA_MAX_DURATION_S`, `MEDIA_MAX_WIDTH`, `MEDIA_MAX_HEIGHT`, `MEDIA_MAX_STREAMS` | 512 MiB, `7200`, `1920`, `1080`, `4` | Caps checked by ffprobe before any processing |
| `MEDIA_WHISPER_BIN`, `MEDIA_WHISPER_MODEL`, `MEDIA_WORK_DIR` | — | whisper.cpp for transcripts (without it the transcribe preset is unavailable); scratch directory for media jobs |
| `IMAGE_BACKENDS` | `[]` | Image workers as JSON: `[{id, kind: comfyui\|diffusers, url, label?, model?, workflow?, concurrency?, steps?, sizes?}]`. `sizes` lists what the model was made for as `"WIDTHxHEIGHT"`, the default first (each side 256 to 2048, a multiple of 8); the Images screen offers those for that worker, and its general list when none are given |
| `IMAGE_SAFETY_URL`, `IMAGE_SAFETY_THRESHOLD` | —, `0.5` | Image-safety classifier for generated images and video frames; without it images are marked "not classified" |
| `OPENAI_STREAM_MODE` | `checked` | The OpenAI-compatible API at `/v1`: `checked` streams an answer after the output guardrail has passed it; `live` streams tokens as they are generated (a later block can only end the stream with `finish_reason: content_filter`) |
| `WEBHOOK_ALLOWED_HOSTS` | — | Webhook endpoints must resolve to internal addresses; this comma list (hosts, `*.domain`, CIDRs) allows others. Tenants can narrow further on the Tenants screen |
| `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETRY_BASE_MS` | `10000`, `6`, `30000` | Per-attempt timeout; attempts per delivery; first retry delay, doubling each attempt (capped at six hours) |
| `WEBHOOK_BREAKER_THRESHOLD`, `WEBHOOK_BREAKER_COOLDOWN_MS` | `5`, `300000` | Consecutive failed attempts that open an endpoint's circuit breaker, and how long it stays open before a trial delivery |
| `BILLING_PROVIDER` | `none` | `stripe` lets a system admin push a finished month's statement as a Stripe invoice |
| `STRIPE_SECRET_KEY` (`_FILE`), `STRIPE_API_URL`, `STRIPE_DAYS_UNTIL_DUE` | —, `https://api.stripe.com`, `30` | Stripe restricted key (invoice items and invoices, write), API base (a mirror or proxy in air-gapped installs), invoice terms |
| `BILLING_CLOSE_MINUTES` | `360` | How often the scheduler closes last month's statements (0 turns off) |
| `API_RATE_PER_MINUTE` | `600` | Requests a minute per user (or per address when signed out) across `/api`; shared across instances with Redis |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | `30`, `12` | Session lifetime |
| `LOCKOUT_MAX_ATTEMPTS`, `LOCKOUT_WINDOW_MINUTES`, `LOCKOUT_DURATION_MINUTES` | `5`, `15`, `15` | Sign-in lockout |
| `STEPUP_WINDOW_SECONDS` | `300` | Creating API keys, removing a second factor and regenerating recovery codes need a password or factor check this recent (signing in counts) |
| `BREACHED_PASSWORDS` | `off` | Breached-password check for new local passwords: `hibp` (the k-anonymity range API: only the first five hex characters of the SHA-1 leave the server), `file` (a local list), `both`, or `off`. If a source cannot be reached the password is accepted and `password.breach_check.unavailable` is audited |
| `BREACHED_HIBP_URL`, `BREACHED_TIMEOUT_MS` | `https://api.pwnedpasswords.com`, `3000` | Range API base (`GET <url>/range/<prefix>`); point it at an internal mirror in air-gapped sites |
| `BREACHED_FILE` | — | Required for `file` and `both`: uppercase SHA-1 hashes, one per line, sorted, optionally followed by `:count` (the format of HIBP's "ordered by hash" download). Searched in place by binary search, never loaded into memory |
| `PASSWORD_RESET_MINUTES`, `PASSWORD_RESET_PER_HOUR` | `60`, `5` | Lifetime of emailed reset links; reset requests per hour per identifier and per account (four times that per client address). Needs `SMTP_URL` |
| `PASSWORD_INVITE_HOURS` | `72` | Lifetime of invitation links for local accounts created without a password, and of `admin:create --enrol-link` links |
| `SIGNIN_NOTICES` | `true` | Security notice for a sign-in from a new browser (a signed, long-lived device cookie) or a new network (/24 or /48 of the client address; set the trusted proxy so it is the real one) |
| `DPOP_NONCES`, `DPOP_NONCE_SECONDS` | `false`, `300` | Require server-issued DPoP nonces (RFC 9449 section 8): a proof without the current `DPoP-Nonce` gets `use_dpop_nonce`. Turn on once your DPoP clients retry with the nonce |
| `API_PUBLIC_URL` | — | The public base of the API when a reverse proxy serves it under another origin or path prefix (for example `https://gw.example.internal/ai`); DPoP proofs for API calls must name `<API_PUBLIC_URL>/api/...` as `htu` |
| `FEDERATION_METADATA_REFRESH_HOURS` | `24` | How often SAML metadata registered by URL (service providers and upstream identity providers) is fetched again; a changed certificate or endpoint waits for an identity admin's approval |
| `DEFAULT_TENANT` | `default` | Tenant used when sign-in names none |
| `IDENTITY_CONFIG` | — | Path to the identity YAML ([identity.md](identity.md)) |
| `METRICS_TOKEN` (`_FILE`) | — | Bearer token for `/metrics`; without it `/metrics` is off in production |
| `LOG_LEVEL` | `info` | pino level |
| `CHAT_STREAM_LEASE_SECONDS`, `CHAT_RETENTION_SWEEP_MINUTES` | `30`, `60` | Sprint 12: a streaming answer whose instance has been silent this long is marked interrupted (the user can continue it); how often each tenant's conversation retention policy runs (0 turns it off). The stream catch-up buffer uses Redis when `REDIS_URL` is set, otherwise the database |
| `CHAT_GUARD_HOLDBACK_SENTENCES`, `CHAT_GUARD_STREAM_CONCURRENCY` | `1`, `16` | Sprint 16: the guard-model and classifier rules check streamed answers in the background. Hold-back is how many screened sentences may wait for a verdict before generation pauses (0 shows each sentence at once, so a verdict can only stop what follows); the concurrency caps background checks per instance (further checks queue, they never block the event loop) |
| `CHAT_ARTIFACT_MIN_CHARS`, `CHAT_ARTIFACT_MAX_BYTES` | `80`, `262144` | 1.6.0 (B-8001): a fenced block in an answer becomes an artifact from this many characters, up to this many bytes (longer blocks stay in the answer only) |
| `CHAT_ARTIFACT_RAW_TTL_SECONDS` | `600` | 1.6.0 (B-8001): how long a sandboxed artifact render link (the iframe's URL) stays valid |
| `AGENT_SCHEDULE_TICK_SECONDS` | `60` | Sprint 21: how often due agent schedules are looked for; a scheduled run starts at most this long after its time (UTC cron, as the owner with their roles at that moment) |
| `VAULT_KV_MAX_VERSIONS` | `10` | Sprint 24: versions a new secrets-vault KV path keeps (1 to 100); older versions are removed as new ones are written, and each path's metadata can change its own limit (`docs/api.md`) |
| `VAULT_LEASE_DEFAULT_TTL_SECONDS`, `VAULT_LEASE_MAX_TTL_SECONDS`, `VAULT_LEASE_SWEEP_SECONDS` | `3600`, `86400`, `60` | Sprint 25: database leases from the built-in PostgreSQL and MySQL engines (`docs/api.md`). Engines' TTLs default to the first and may not pass the second; the expiry sweeper drops ended accounts every `VAULT_LEASE_SWEEP_SECONDS` (`0` turns it off, which leaves MySQL accounts usable past their expiry). Engines dial internal hosts only unless `CONNECTIONS_ALLOWED_HOSTS` names them |
| `VAULT_ROTATION_CHECK_MINUTES`, `VAULT_ROTATION_NOTICE_DAYS` | `60`, `7` | Sprint 25: how often vault rotation schedules are checked (`0` turns it off) and how many days before a secret or transit key falls due its owner is told |
| `VAULT_ANOMALY_BURST`, `VAULT_ANOMALY_BURST_SECONDS`, `VAULT_ANOMALY_HISTORY_DAYS`, `VAULT_ANOMALY_MIN_HISTORY` | `5`, `60`, `30`, `20` | 1.6.0 (B-4803): reveal anomalies. Reveals over the API are kept this many days; the `VAULT_ANOMALY_BURST`-th reveal of a secret by one caller within `VAULT_ANOMALY_BURST_SECONDS`, a reveal from a new address, or one at an hour of the day the secret (with at least `VAULT_ANOMALY_MIN_HISTORY` reveals) was never revealed in raises a flag for its owner. `0` bursts turns detection off |
| `VAULT_SHARE_MAX_DAYS` | `0` | 1.6.0 (B-4801): the longest a KV secret may be shared, in days (also the default expiry of a share); `0` lets shares run until revoked |
| `DLP_MAX_TEXT_BYTES` | `1048576` | 1.6.0 (B-7601): how many characters of an answer, agent output or text upload DLP inspects; the rest keeps its label |
| `COMPLIANCE_EXPORT_MAX_ROWS`, `COMPLIANCE_EXPORT_MAX_DAYS` | `100000`, `0` | 1.6.0 (B-7603): the most objects a compliance export writes (conversations count their messages; more fails the export) and the longest range it may cover in days (`0`: any) |
| `APPS_PACKAGE_MAX_BYTES` | `8000000` | 1.6.0 (B-8201): the most bytes an app package may be (the design, and the records when asked for); a larger one is refused with 413 |
| `APPS_DEPLOYMENT_HISTORY_DAYS` | `365` | 1.6.0 (B-8203): how long a pipeline's deployment history is kept |
| `APPS_GIT_TIMEOUT_MS`, `APPS_GIT_ALLOW_FILE` | `300000`, `false` | 1.6.0 (B-8204): how long a git export or import waits for the repository, and whether `file://` repositories on this host are accepted beside `https://` (tests and air-gapped mirrors) |

| `APP_EMBED_MAX_TTL_SECONDS`, `APP_EMBED_SESSION_PER_MINUTE` | `3600`, `30` | 1.6.0 (B-8702): the longest an embedded session lives whatever an app's own setting says (60 s to a day), and how many host tokens an address may exchange for sessions a minute |
| `IDENTITY_SCIM_MAX_RESULTS`, `IDENTITY_SCIM_RATE_PER_MINUTE`, `IDENTITY_SCIM_TOKEN_MAX_DAYS` | `200`, `1200`, `365` | 1.6.0 (B-7201): SCIM 2.0 at `/scim/v2`: resources per list page, requests per minute per address, and the longest a SCIM token lives (`0`: until revoked) |
| `SHARE_ANONYMOUS_PER_MINUTE` | `30` | Sprint 16: anonymous share links opened per client address per minute (anonymous links are off until a tenant admin allows them; set `TRUST_PROXY` correctly so the address is the client's) |
| `DATA_KEY_PREVIOUS` (`_FILE`), `KMS_PREVIOUS_PROVIDER` | — | Sprint 15: the previous key-encryption key while `kms:rewrap` runs (below). Reads fall back to it; nothing new is wrapped with it |
| `SIGNER_SOCKET`, `SIGNER_TOKEN` (`_FILE`), `SIGNER_TIMEOUT_MS` | —, —, `5000` | Sprint 20: the signer process's UNIX socket and the token it expects (production: `SIGNER_TOKEN_FILE` only). With `KMS_PROVIDER=local` the key-encryption key and the OIDC, SAML and webhook private keys then stay in the signer (below) |
| `HTTP_SIGNATURE_MAX_AGE_SECONDS` | `300` | Sprint 20: how far a `/v1` request's RFC 9421 `created` time may be from the server's clock |
| `PKI_PUBLIC_URL`, `PKI_CRL_MINUTES`, `PKI_CRL_VALIDITY_HOURS`, `PKI_OCSP_VALIDITY_MINUTES`, `PKI_OCSP_CACHE_SECONDS`, `PKI_OCSP_SIGNER_DAYS`, `PKI_PUBLIC_RATE_PER_MINUTE` | `PUBLIC_URL`, `60`, `24`, `60`, `300`, `30`, `600` | Sprint 24: the certificate authority. Its keys are made and used only in the signer (`SIGNER_SOCKET`) or OpenBao transit (`KMS_PROVIDER=openbao`). Issued certificates point at `PKI_PUBLIC_URL` for `/pki/crl/<issuer>.crl`, `/pki/ocsp` and `/pki/ca/<issuer>.crt`, which must be reachable by relying parties over plain HTTP or HTTPS (they are signed and need no session). CRLs are signed every `PKI_CRL_MINUTES` and after each revocation and are valid for `PKI_CRL_VALIDITY_HOURS` (which must be longer); OCSP answers are valid for `PKI_OCSP_VALIDITY_MINUTES` and cached per instance for `PKI_OCSP_CACHE_SECONDS`; delegated responder certificates last `PKI_OCSP_SIGNER_DAYS`; the public routes allow `PKI_PUBLIC_RATE_PER_MINUTE` requests per address |
| `ATPROTO_PUBLIC_URL`, `ATPROTO_PLC_URL`, `ATPROTO_PUBLIC_RATE_PER_MINUTE`, `ATPROTO_SUBSCRIBERS_MAX`, `ATPROTO_LABEL_PULL_MINUTES` | `PUBLIC_URL`, `https://plc.directory`, `600`, `200`, `5` | 1.4.0, Sprint 25: AT-Protocol trust. Service DIDs' label and rotation keys are made and used only in the signer (secp256k1 and P-256) or OpenBao transit (P-256 only; transit has no secp256k1). The platform's `did:web` is the host of `ATPROTO_PUBLIC_URL`, and tenants without a host of their own get `did:web:<that host>:atproto:<slug>`: serve `/.well-known/did.json`, `/.well-known/atproto-did`, `/atproto/` and `/xrpc/` from that host over HTTPS, and pass WebSocket upgrades on `/xrpc/com.atproto.label.subscribeLabels` and `/atproto/*/xrpc/…` through the proxy. A tenant with its own host needs its DNS and TLS pointing at the same service (the `Host` header picks the identity). `did:plc` operations are submitted to `ATPROTO_PLC_URL` and external labelers' DIDs resolved through the service URL checks (`SERVICE_ALLOWED_HOSTS`, `SERVICE_INTERNAL_ONLY`: with internal-only on, name `plc.directory` and the labelers' hosts there). The public routes allow `ATPROTO_PUBLIC_RATE_PER_MINUTE` requests per address, each instance at most `ATPROTO_SUBSCRIBERS_MAX` label streams; trusted labelers are read every `ATPROTO_LABEL_PULL_MINUTES` |
| `MODERATION_SWEEP_SECONDS`, `MODERATION_EXTERNAL_PROVIDERS`, `MODERATION_PROVIDER_TIMEOUT_MS` | `60`, `false`, `5000` | 1.4.0, Sprint 26: moderation. The sweep escalates flags in routed review queues past their SLA and ends suspensions and bans whose time is up (`0` turns the sweep off; enforcement still compares the end time). External moderation providers (`POST /api/moderation/providers`) send content off the site, so they are refused unless `MODERATION_EXTERNAL_PROVIDERS` is on, and then only in a zone whose egress allow-list reaches a public range or the external zone (`ZONES_AIR_GAPPED=false`); their calls go through the service URL checks (`SERVICE_ALLOWED_HOSTS`, `SERVICE_INTERNAL_ONLY`: with internal-only on, name the provider's host there) and wait at most `MODERATION_PROVIDER_TIMEOUT_MS` |
| `ATPROTO_STREAM_POLL_SECONDS` | `5` | 1.7.0 (B-9002): how often an instance with open `subscribeLabels` or `subscribeRepos` streams reads the newest seq from the database, behind the bus. A label or repo event whose bus message was lost (Redis restarting, a worker that could not publish) reaches its subscribers within this long instead of never; an instance with no subscriber asks nothing |
| `FIREHOSE_TICK_MS`, `FIREHOSE_CHECKPOINT_MS`, `FIREHOSE_QUEUE_MAX`, `FIREHOSE_BACKOFF_MAX_MS`, `FIREHOSE_IDLE_MS`, `FIREHOSE_MAX_PER_TENANT` | `10000`, `5000`, `1000`, `60000`, `90000`, `10` | 1.4.0, Sprint 27: AT-Protocol firehose ingest (`/api/atproto/firehose`). Consumers run on worker instances (`WORKERS_ENABLED`), each subscription on one instance at a time through a lease renewed every `FIREHOSE_TICK_MS` (it lasts three ticks, so after a crash another instance takes over within about that). The cursor is stored every `FIREHOSE_CHECKPOINT_MS` and at shutdown; a consumer pauses its socket when `FIREHOSE_QUEUE_MAX` messages wait, reconnects with backoff up to `FIREHOSE_BACKOFF_MAX_MS`, and after `FIREHOSE_IDLE_MS` without a message. Endpoints go through the service URL checks (`SERVICE_ALLOWED_HOSTS`, `SERVICE_INTERNAL_ONLY`: with internal-only on, name the Jetstream or relay host there, for example `jetstream2.us-east.bsky.network`). Each checked post is one guardrail check and, on a verdict, a flag and signed labels: use a sample rate and allow-lists rather than the whole network |
| `FIREHOSE_REJECT_AUDITS`, `FEEDS_MAX_PER_TENANT`, `FEED_ITEMS_MAX`, `FEED_PRUNE_MINUTES` | `20`, `20`, `50000`, `15` | 1.5.0, Sprint 31: relay commits that fail verification are audited at most `FIREHOSE_REJECT_AUDITS` times a minute per subscription (the rest are counted). Feed generators (`/api/atproto/feeds`) per tenant, posts kept per feed, and how often feed indexes are pruned to their retention (0: never). Repo and AppView DIDs are resolved through the service URL checks: with `SERVICE_INTERNAL_ONLY` on, allow the PLC directory (`ATPROTO_PLC_URL`) and the did:web hosts you expect |
| `PDS_PUBLIC_URL`, `PDS_HANDLE_DOMAIN`, `PDS_ZONE`, `PDS_RELAYS`, `PDS_CRAWL_MINUTES`, `PDS_BACKFILL_HOURS`, `PDS_SUBSCRIBERS_MAX`, `PDS_BLOB_MAX_BYTES`, `PDS_BLOB_TYPES`, `PDS_ACCESS_MINUTES`, `PDS_REFRESH_DAYS`, `PDS_RATE_PER_MINUTE`, `PDS_WRITES_PER_HOUR`, `PDS_IMPORT_MAX_BYTES` | `ATPROTO_PUBLIC_URL` then `PUBLIC_URL`, its host name, `edge`, none, `20`, `72`, `200`, `52428800`, `image/png,image/jpeg,image/webp,image/gif,video/mp4`, `60`, `60`, `3000`, `5000`, `67108864` | 1.5.0, Sprint 31: the AT-Protocol PDS (`docs/pds.md`). Off until a platform admin enables it per tenant, which needs the signer or OpenBao for account keys and a `PDS_ZONE` with egress (not with `ZONES_AIR_GAPPED`). Serve `/xrpc/` and `/.well-known/atproto-did` of `PDS_PUBLIC_URL` over HTTPS and pass WebSocket upgrades on `/xrpc/com.atproto.sync.subscribeRepos` through the proxy; point a wildcard DNS record `*.<tenant>.<PDS_HANDLE_DOMAIN>` at the same service for each hosting tenant (handles resolve over HTTPS). `did:plc` operations go to `ATPROTO_PLC_URL`, and `requestCrawl` to each of `PDS_RELAYS`, through the service URL checks (with `SERVICE_INTERNAL_ONLY`, name `plc.directory` and the relays in `SERVICE_ALLOWED_HOSTS`). Blobs go through ClamAV when `CLAMD_HOST` is set (its `StreamMaxLength` must allow `PDS_BLOB_MAX_BYTES`). The interop run against the reference AppView is `interop/run.ts` |
| `GROUP_INVITE_DAYS`, `GROUP_REQUEST_DAYS`, `CALENDAR_FEED_PER_MINUTE`, `CALENDAR_FEED_MAX_LABEL` | `7`, `14`, `60`, `internal` | 1.4.0, Sprint 27c: groups and events. Group invitations expire after `GROUP_INVITE_DAYS` and join requests after `GROUP_REQUEST_DAYS`. Signed calendar feeds (`/calendar/feeds/…`, public, outside `/api`) are rate-limited per client address (`CALENDAR_FEED_PER_MINUTE`) and show events labelled above `CALENDAR_FEED_MAX_LABEL` only as busy time, because calendar programs copy feeds to other servers. Feed signatures use a key derived from `SESSION_SECRET`: rotating it invalidates every feed URL (owners create new ones) |
| `CHANNELS_SESSIONS_PER_HOUR`, `CHANNELS_SESSION_HOURS`, `CHANNELS_REPLY_TIMEOUT_MS`, `CHANNELS_IMAP_POLL_SECONDS`, `CHANNELS_IMAP_BATCH`, `CHANNELS_WEBHOOK_PER_MINUTE`, `CHANNELS_WEBHOOK_TOLERANCE_SECONDS`, `CHANNELS_RETENTION_SWEEP_MINUTES` | `30`, `24`, `60000`, `60`, `50`, `120`, `300`, `60` | 1.4.0, Sprint 28a: customer-service channels. New customer sessions are limited per client address across all channels (`CHANNELS_SESSIONS_PER_HOUR`; each channel also has its own limit) and their tokens last `CHANNELS_SESSION_HOURS` (signed with a key derived from `SESSION_SECRET`: rotating it ends every customer session and breaks the threading of email customers seen before). An answer waits at most `CHANNELS_REPLY_TIMEOUT_MS` for the model. Email channels' IMAP mailboxes are polled every `CHANNELS_IMAP_POLL_SECONDS` (`0` turns polling off; webhooks still work), `CHANNELS_IMAP_BATCH` messages a poll; IMAP and SMTP hosts must pass `SERVICE_ALLOWED_HOSTS`/`SERVICE_INTERNAL_ONLY` and the tenant's allowed hosts. Mail webhooks are limited per channel and refuse signatures older than the tolerance. Retention purges run every `CHANNELS_RETENTION_SWEEP_MINUTES`. Channels without SMTP settings send through `SMTP_URL` |
| `MFA_EMAIL_CODE_MINUTES`, `MFA_EMAIL_SENDS_PER_HOUR` | `10`, `5` | 1.4.0, Sprint 28a (B-1806): email one-time codes as a second factor (needs `SMTP_URL`). A code is valid for the minutes given and works once; a user is sent at most this many codes an hour. Wrong codes count in the same lockout as TOTP codes (`LOCKOUT_MAX_ATTEMPTS`) |
| `MESSAGING_MAX_MEMBERS`, `MESSAGING_EMBED_MODEL`, `MESSAGING_SUMMARY_PROFILE`, `MESSAGING_SUMMARY_MAX_MESSAGES`, `ROOM_SIGNALS_PER_MINUTE` | `256`, —, `general`, `200`, `60` | 1.4.0, Sprint 28b: messaging. A group conversation holds at most `MESSAGING_MAX_MEMBERS` people. `MESSAGING_EMBED_MODEL` names an approved embedding model (cleared for the conversations' labels) and turns on semantic search; messages are embedded by the `messaging.embed` job and their vectors kept in the vector store (collection `dm-messages`). Without it search is by keyword only. Summaries and catch-up digests use the profile `MESSAGING_SUMMARY_PROFILE` unless the request names one, over at most `MESSAGING_SUMMARY_MAX_MESSAGES` messages. `ROOM_SIGNALS_PER_MINUTE` caps the typing and receipt signals one socket sends into realtime rooms |
| `FEED_POST_MAX_CHARS`, `FEED_HOME_FANOUT_MAX`, `FEED_TRENDING_MINUTES`, `FEED_TRENDING_HOURS`, `FEED_DIGEST_PROFILE`, `FEED_DIGEST_TOP`, `FEED_DIGEST_MAX_LABEL` | `5000`, `1000`, `60`, `72`, empty, `5`, `internal` | 1.4.0, Sprint 28c: the workspace feed (`/api/feed`). Posts and comments are at most `FEED_POST_MAX_CHARS` characters. A new post reaches the open home feeds of at most `FEED_HOME_FANOUT_MAX` followers live (one bus message each; `0` turns the home fan-out off, workspace and group rooms still update). The `feed.trending` job counts hashtags every `FEED_TRENDING_MINUTES` (`0` turns it off) over the last `FEED_TRENDING_HOURS`. The `feed.digest` job runs hourly on worker instances and writes each workspace's digest of the last complete week (Monday 00:00 UTC) once: its `FEED_DIGEST_TOP` posts labelled up to `FEED_DIGEST_MAX_LABEL`, summarised by the workspace's digest profile (`PUT /api/feed/workspaces/:id/settings`) or `FEED_DIGEST_PROFILE`; the profile must be published, approved and labelled at least as high as the posts it reads. Empty `FEED_DIGEST_PROFILE` means no digest unless a workspace names a profile |
| `PKI_ACME_URL`, `PKI_ACME_ORDER_HOURS`, `PKI_ACME_NONCE_MINUTES`, `PKI_ACME_RATE_PER_MINUTE`, `PKI_ACME_HTTP_PORT`, `PKI_ACME_INTERNAL_ONLY`, `PKI_ACME_ALLOWED_HOSTS`, `PKI_ACME_DNS_SERVERS`, `PKI_EXPIRY_NOTICE_DAYS`, `PKI_EXPIRY_SWEEP_MINUTES` | `PKI_PUBLIC_URL`, `24`, `60`, `120`, `80`, `false`, empty, system resolver, `30,7`, `360` | Sprint 25: the ACME server at `/pki/acme/<tenant>/directory` (closed until a tenant admin opens it with `PUT /api/pki/acme`) and expiry notices. Orders last `PKI_ACME_ORDER_HOURS` and nonces `PKI_ACME_NONCE_MINUTES` (stored in the database, so clients may be balanced across instances); writes allow `PKI_ACME_RATE_PER_MINUTE` per address on top of `PKI_PUBLIC_RATE_PER_MINUTE`. http-01 is fetched from `PKI_ACME_HTTP_PORT` of each name through the service address checks (`PKI_ACME_INTERNAL_ONLY` refuses public addresses unless `PKI_ACME_ALLOWED_HOSTS` names them); dns-01 asks `PKI_ACME_DNS_SERVERS` (`host[:port]`, comma-separated) or the system resolver. The `pki.expiry` job runs every `PKI_EXPIRY_SWEEP_MINUTES` (0 turns it off) and notifies owners at `PKI_EXPIRY_NOTICE_DAYS`. See `docs/pki.md` |
| `PUSH_DEVICE_IDLE_DAYS`, `NOTIFICATION_DIGEST_MINUTES` | `90`, `5` | 1.9.0, Sprint 49 (B-150, B-153): push devices not seen for `PUSH_DEVICE_IDLE_DAYS` are deleted by the daily `push.devices.prune` job; notifications held for a digest or by quiet hours are sent by the `notifications.digest` job every `NOTIFICATION_DIGEST_MINUTES`. 0 turns either off |
| `NTP_SERVER`, `NTP_TIMEOUT_MS` | —, `2000` | Sprint 15: SNTP server (`host` or `host:port`) for the clock-skew check on the Platform screen |
| `MEDIA_ORIGIN`, `MEDIA_URL_TTL_SECONDS` | —, `300` | Sprint 15: a second host name for this deployment that serves media and images through signed short-lived URLs (point it at the same instances; it answers `/media-content/*` only) |
| `OPENBAO_DATABASE_MOUNT` | `database` | Sprint 15: OpenBao database secrets engine for dynamic data-connection credentials (uses `OPENBAO_ADDR` and `OPENBAO_TOKEN`; the token needs read on `<mount>/creds/<role>` and update on `sys/leases/renew` and `sys/leases/revoke`) |
| `PLATFORM_BUNDLE_REQUIRE_CHECKS` | `false` | Sprint 15: refuse to promote a bundle whose vulnerability scan or staging deploy did not run |
| `PLATFORM_BACKUP_BLOBS` | `true` | Sprint 15: backups also archive the blob store |
| `ACME_CHALLENGE`, `ACME_DNS_PROVIDER`, `ACME_DNS_WAIT_SECONDS` | `http-01`, `none`, `5` | Sprint 15: `dns-01` publishes TXT records through `webhook` or `rfc2136`; Sprint 58 (B-10206) adds `route53`, `azure-dns` and `digitalocean` (through a cloud account) |
| `ACME_DNS_CLOUD_ACCOUNT`, `ACME_DNS_CLOUD_ZONE` | unset | Sprint 58 (B-10206): the cloud account (id or name) whose credential writes the dns-01 TXT records, and the zones it may write in (comma list; required for `azure-dns` and `digitalocean`) |
| `CLOUD_BUDGET_CHECK_MINUTES` | `60` | Sprint 58 (B-10602): how often budget alerts are checked and expired overrides ended (0: only after applies) |
| `HELM_BIN` | `helm` | Sprint 58 (B-10203): the pinned Helm 3.19.0 binary the deploy worker installs Kubernetes releases with (a path, or `helm` on the PATH); another version is refused. See [The deploy worker's Helm](#the-deploy-workers-helm-1999-final-b-10203-open-decision-7) |
| `ACME_DNS_WEBHOOK_URL`, `ACME_DNS_WEBHOOK_SECRET` (`_FILE`) | — | The signed DNS hook (below) |
| `ACME_DNS_RFC2136_SERVER`, `ACME_DNS_RFC2136_ZONE`, `ACME_DNS_TSIG_NAME`, `ACME_DNS_TSIG_SECRET` (`_FILE`), `ACME_DNS_TSIG_ALGORITHM` | —, —, —, —, `hmac-sha256` | RFC 2136 dynamic update: the zone's primary, the zone, and the TSIG key (secret in base64, as in a BIND key file) |
| `ACME_CERT_DIR` | — | Sprint 15: every instance writes issued and renewed certificates here as `<name>/fullchain.pem`, `cert.pem`, `chain.pem`, `privkey.pem` |
| `KNOWLEDGE_REPLICATION`, `KNOWLEDGE_REPLICATION_TICK_MS` | `on`, `10000` | Sprint 19: logical replication for PostgreSQL knowledge sources that ask for it (`off` keeps every source on watermarks); how often each worker instance claims and renews streams (a lease lasts three ticks). The database needs `wal_level=logical`, a publication for the table and an account with the REPLICATION attribute |
| `STRIPE_WEBHOOK_SECRET` (`_FILE`), `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | —, `300` | Sprint 19: the signing secret of the Stripe webhook endpoint pointed at `https://<host>/billing/stripe/webhook` (events `invoice.paid`, `invoice.payment_failed`, `invoice.voided`); unset, the route answers 404 |
| `IMAGE_SAFETY_REQUIRED` | `false` | Sprint 19: without an image-safety classifier, withhold generated images and sampled video frames instead of marking them "not classified" |
| `IMAGE_C2PA` | `on` | 1.6.0 (B-7901): sign generated PNGs with a C2PA manifest from the tenant's content-credentials certificate (`off`: the HMAC manifest only) |
| `SCRIPT_RUNTIME` | — | Sprint 19: OCI runtime for script containers, e.g. `runsc` for gVisor (install it and register it with the engine, `docker info` must list it); runs are refused when the engine does not know it |
| `SERVICE_ALLOWED_HOSTS`, `SERVICE_INTERNAL_ONLY` | —, `false` | Sprint 18: pool instance, zone endpoint, image backend and trainer URLs may point at loopback, private and (unless `SERVICE_INTERNAL_ONLY`) public addresses, never at cloud metadata (169.254.169.254, fd00:ec2::254, 100.100.100.200, 192.0.0.192), link-local or unspecified ones. The list (hosts, `*.domain`, CIDRs) admits a link-local service network and, with `SERVICE_INTERNAL_ONLY`, public hosts; metadata addresses are never admitted. Names are checked when saved and again at every connection |
| `REQUIRE_BACKEND_TLS`, `BACKEND_TLS_EXEMPT` | `false`, — | Sprint 18: with `NODE_ENV=production`, refuse to start when a link to PostgreSQL (`sslmode=require`, `verify-ca` or `verify-full`), MySQL (an `ssl` parameter, e.g. `?ssl={"rejectUnauthorized":true}`), Redis (`rediss://`), S3 (`https://`) or OpenBao (`https://`) would be plaintext. SQLite is exempt. Exempt one link by name (`database`, `redis`, `s3`, `openbao`), for example a Redis sidecar on loopback or a mesh that adds mTLS |
| `ACME_EAB_KID`, `ACME_EAB_HMAC_KEY` (`_FILE`) | — | Sprint 18: external account binding for CAs that require it (the key id and base64url MAC key they issue); used when the ACME account is first created |
| `ACME_DNS_RFC2136_TRANSPORT` | `auto` | Sprint 18: `auto` sends updates over UDP and repeats them over TCP when the answer is truncated or UDP gets none; `udp` or `tcp` force one. `ACME_DNS_RFC2136_ZONE` may be left out: the zone is then the owner of the SOA record the server returns for `_acme-challenge.<name>` |
| `ACME_RELOAD_COMMANDS`, `ACME_HOOK_TIMEOUT_MS` | `{}`, `30000` | Sprint 18: reload commands certificates can name as push hooks, as JSON `{"name": ["/path", "arg"]}` (argument arrays, no shell; run on every instance after its sink writes the files, with `CERT_NAME`, `CERT_SERIAL`, `CERT_NOT_AFTER` and `CERT_DIR` set) |
| `TRAINER_CALLBACK_URL` | `PUBLIC_URL` | Sprint 18: the base URL the training worker calls back for run keys and artefacts (`/trainer/v1/...`, outside `/api`) |
| `TRAINER_PLAINTEXT_FALLBACK` | `false` | Sprint 18: let a worker on contract 1 receive dataset rows in plaintext; off, such a worker is refused and jobs wait saying so |
| `TRAINER_KEY_TTL_SECONDS`, `TRAINER_ARTIFACT_MAX_BYTES` | `900`, 64 GiB | Sprint 18: how long a run key waits to be fetched (once); the largest checkpoint or GGUF upload |
| `TRAINER_CLIENT_CERT_SHA256` | — | Sprint 18: SHA-256 fingerprint of the worker's client certificate; key and artefact calls must present it (on this server's TLS socket, or as `X-Client-Cert-SHA256` from a proxy that `TRUST_PROXY` trusts and that verified the certificate) |
| `TRAINER_CA_FILE`, `TRAINER_CERT_FILE`, `TRAINER_KEY_FILE` | — | Sprint 18: mutual TLS from the orchestrator to the worker |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | — | Sprint 22: OpenTelemetry tracing over OTLP/HTTP JSON. Spans go to `<endpoint>/v1/traces` (or the full traces URL); unset, nothing is traced. Requests, jobs, gateway calls, guardrail checks and database queries are spans of the request's W3C trace (the `X-Trace-Id`); no tenant content is recorded |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_SERVICE_NAME` | —, `10000`, `exprsn-ai` | Sprint 22: collector request headers (`name=value,…`, e.g. an API key), the export timeout (ms) and the `service.name` resource attribute |
| `OTEL_TRACES_SAMPLE_RATIO`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_SCHEDULE_DELAY` | `1`, `2048`, `5000` | Sprint 22: share of new traces recorded (a caller's sampled flag wins); spans held for export (more are dropped and counted); the export interval (ms) |
| `SCHEMA_CHECK_SECONDS` | `30` | Sprint 22: how often each instance compares its migrations with the database's; an instance older than the schema takes no jobs and is not ready (0: at start and on `/readyz` only) |
| `ZONES_APPLY` | `off` | Sprint 22: `kubernetes` applies each zone's rendered NetworkPolicy through the Kubernetes API (server-side apply) after every approved change and checks for drift. Needs a service account allowed to get, list, create and patch networkpolicies in the zone namespaces (the chart's `zonesApply`) |
| `ZONES_APPLY_API_URL`, `ZONES_APPLY_TOKEN_FILE`, `ZONES_APPLY_CA_FILE` | in-cluster | Sprint 22: the API server (default `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT`), the bearer token file (re-read on every call) and the CA, defaulting to the pod's service-account files |
| `ZONES_APPLY_FIELD_MANAGER`, `ZONES_APPLY_DRIFT_MINUTES` | `exprsn-ai`, `15` | Sprint 22: the server-side apply field manager; how often live policies are compared with what was applied (0: on request) |
| `NTP_SERVER`, `NTP_OUTLIER_MS` | —, `1000` | Sprint 22: `NTP_SERVER` takes a comma list; with three or more servers the clock skew is the median of those that agree, and a server further than `NTP_OUTLIER_MS` from the median is named as an outlier |
| `RATELIMIT_PROBE_SECONDS` | `15` | Sprint 22: how often each instance pings Redis, so the Platform warning and `exprsn_ratelimit_degraded` show that limits count per instance within a minute of Redis stopping |
| `KNOWLEDGE_ALLOWED_HOSTS`, `KNOWLEDGE_FETCH_TIMEOUT_MS` | —, `30000` | Sprint 23: knowledge sources that fetch over HTTP (a bucket on its own S3-compatible endpoint, a web site and the hosts its images are on) reach internal addresses only, unless this list (hosts, `*.domain`, CIDRs) names them; link-local and cloud metadata addresses never. Every connection's address is checked when it is dialled. The timeout applies to each request |
| `CACHE_STORE`, `CACHE_TTL_SHORT_SECONDS`, `CACHE_TTL_MEDIUM_SECONDS`, `CACHE_TTL_LONG_SECONDS`, `CACHE_MAX_ENTRIES` | `auto`, `10`, `60`, `600`, `10000` | 1.4.0 (B-2102): the tenant-scoped read-through cache. `auto` keeps values in Redis when `REDIS_URL` is set (shared by every instance) and in each process otherwise; `redis` requires `REDIS_URL`. Changes are announced on the bus, so every instance drops the entry. The TTLs are the tiers callers choose from; `CACHE_MAX_ENTRIES` bounds the memory store (least recently used go first). Metrics: `exprsn_cache_requests_total{ns,result}`, `exprsn_cache_invalidations_total`, `exprsn_cache_errors_total` |
| `PLUGIN_RATE_PER_MINUTE`, `PLUGIN_CONCURRENCY`, `PLUGIN_MAX_DEPTH`, `PLUGIN_SCRIPT_TIMEOUT_SECONDS`, `PLUGIN_SCRIPT_MEMORY_MB`, `PLUGIN_MAX_CALLS`, `PLUGINS_REQUIRE_SIGNED` | `120`, `2`, `3`, `30`, `256`, `50`, `scripts` | 1.4.0 (B-2003 to B-2005): plugins that run. Each event reaches a plugin as a `plugin.invoke` job, at most `PLUGIN_RATE_PER_MINUTE` a minute and `PLUGIN_CONCURRENCY` at once per plugin (across instances); a chain of plugin-caused events stops after `PLUGIN_MAX_DEPTH` plugins. Script handlers run in the script sandbox (`SCRIPT_RUNNER`, `SCRIPT_RUNTIME` for gVisor) with the timeout and memory given, and may make `PLUGIN_MAX_CALLS` brokered calls a run. `PLUGINS_REQUIRE_SIGNED`: which plugins must come from a promoted, signed import bundle: `scripts` (default), `all` or `none`. Metrics: `exprsn_plugin_invocations_total{result}`, `exprsn_plugin_dropped_total{reason}`, `exprsn_plugin_calls_total{api,status}` |
| `FILES_MAX_BYTES`, `FILES_TRASH_DAYS`, `FILES_PURGE_MINUTES`, `FILES_PREVIEW_MAX_BYTES`, `FILES_PREVIEW_PX`, `FILES_PDFTOPPM`, `FILES_WORK_DIR` | 1 GiB, `30`, `60`, 50 MiB, `512`, `pdftoppm`, system temp | 1.4.0, Sprint 26d: the file store. One upload may be `FILES_MAX_BYTES` (streamed into the blob store, never held in memory); with `CLAMD_HOST` set, raise clamd's `StreamMaxLength` to at least this, or larger files fail their scan. Trashed files are purged `FILES_TRASH_DAYS` after they went to the trash by the `files.purge` job every `FILES_PURGE_MINUTES` (0 turns it off). Previews of images and PDFs up to `FILES_PREVIEW_MAX_BYTES` are drawn at most `FILES_PREVIEW_PX` wide with `MEDIA_FFMPEG` (images) and poppler's `pdftoppm` (`FILES_PDFTOPPM`, PDFs), in `FILES_WORK_DIR`; without the tool a preview is `unavailable`. Storage quotas are set per tenant (system admins) and per workspace (tenant admins) through the API |
| `EMAIL_VERIFY_HOURS`, `INVITATION_DAYS`, `SIGNUP_PER_HOUR`, `USER_IMPORT_MAX_BYTES`, `USER_IMPORT_MAX_ROWS` | `48`, `7`, `10`, `2097152`, `5000` | 1.4.0 (B-1801 to B-1805): lifetime of email verification links and of invitations by workspace admins; self-registrations per client address an hour (sign-up itself is closed until a tenant admin opens it with `PUT /api/admin/identity-policy/signup`); the largest CSV and most rows a user import (`POST /api/admin/user-imports`, `exprsn-ai users import`) accepts. Verification and invitations need `SMTP_URL`. GitHub user stores reach GitHub (or GitHub Enterprise Server) through the service URL checks: with `SERVICE_INTERNAL_ONLY` on, name `github.com` and `api.github.com` in `SERVICE_ALLOWED_HOSTS` |
| `APPS_PUBLIC_FORM_PER_MINUTE`, `APPS_IMPORT_MAX_BYTES`, `APPS_IMPORT_MAX_ROWS`, `APPS_EXPORT_MAX_ROWS`, `APPS_BULK_MAX`, `APPS_TRIGGER_MAX_DEPTH`, `APPS_SCHEDULE_TICK_SECONDS` | `10`, `200000`, `10000`, `100000`, `500`, `3`, `60` | 1.4.0, Sprint 27 (B-2201 to B-2208): low-code apps. Public form submissions per client address a minute (each form also has its own limit, `ratePerMinute`); the largest CSV import (it travels in the JSON body, so at most 250 kB) and its rows; the most records one CSV export writes; operations in one bulk write; how deep a chain of record triggers may go; how often schedule triggers are checked (0 turns them off). AI fields and drafts use the tenant's published profiles through the gateway; app bundles are signed with the KMS key `<OPENBAO_KEY_PREFIX>app-bundles` |
| `APPS_DELIVERY_ATTACH_MAX_BYTES`, `APPS_DELIVERY_MAX_ATTEMPTS`, `APPS_DELIVERY_PAUSE_AFTER`, `APPS_DELIVERY_MIN_INTERVAL_MINUTES` | `5000000`, `3`, `3`, `60` | 1.8.0, Sprint 44 (B-124): scheduled deliveries of app views, reports and dashboards. The largest file attached to an email or put in a webhook body (a larger one goes to the recipient's file store and the email links to it); attempts per run, with the job queue's backoff; failed runs in a row before a subscription pauses and its owner is told; the shortest time between two runs of a schedule. Email goes through `SMTP_URL`; due times are checked every `APPS_SCHEDULE_TICK_SECONDS` |
| `APPS_HELD_MAX_PER_FORM`, `APPS_HELD_KEEP_DAYS` | `200`, `30` | 1.6.0 (B-4701): public form submissions held by the `user-input` guardrail that may wait per form (past it a held value is refused), and how long a decided one is kept |
| `APPS_AI_DEBOUNCE_MS`, `APPS_AI_FILL_MAX_ROWS`, `APPS_SOURCE_PULL_MAX_ROWS` | `2000`, `10000`, `10000` | 1.6.0 (B-8401, B-8402, B-8501): the quiet window after which an edit regenerates the AI fields that read it (0: at once, every time); the most records one fill of an AI field covers; the most rows one pull from an outside table reads (a capped pull removes nothing) |
| `WORKFLOW_EVENT_RATE_PER_MINUTE`, `WORKFLOW_EVENT_MAX_DEPTH`, `WORKFLOW_SCHEDULE_TICK_SECONDS` | `60`, `3`, `60` | 1.5.0, Sprint 32b (B-3903): workflows started by their own triggers. Firings a minute per event trigger (in the shared counter store, so one limit across instances with `REDIS_URL`; events past it are dropped and audited once a minute as `workflow.trigger.throttled`); the longest chain of workflows an event may come from before it is dropped; how often schedule triggers are checked (0 turns them off). Workflow bundles are signed with the KMS key `<OPENBAO_KEY_PREFIX>workflow-bundles` |
| `PLATFORM_SETTINGS_OVERRIDES`, `INSTANCE_NAME`, `PLATFORM_INSTANCE_REPORT_SECONDS` | `true`, the host name, `30` | 1.6.0 (B-4205): whether the Configuration screen may override settings from the database (each override needs a second platform admin; hot settings apply at once, restart ones at the next start); the name each instance reports what it reads under, and how often it reports. Give every instance its own `INSTANCE_NAME` when several share a host name (containers) |
| `BLOBS_VERIFY_MINUTES`, `BLOBS_ORPHAN_GRACE_HOURS`, `BLOBS_DRY_RUN_MINUTES` | `1440`, `24`, `60` | 1.6.0 (B-4204): how often the blob integrity check `ops.blobs.verify` runs (0: only from Storage); how old an unreferenced object must be before it counts as an orphan; how long a dry run of orphan deletion stays valid |

Generate secrets with `openssl rand -hex 32` (session) and `openssl rand -base64 32` (data key).

## Redis and more than one process

Redis is required for any install with more than one server process on one database (1.7.0, decision D17). The bus
carries what every process must hear at once: session revocations, role and guardrail-set reloads, drains, job
cancels, notifications for sockets held elsewhere, and the announcements of new PDS events and labels. Without Redis
the bus reaches only the process that published, so a web process would never hear what a worker process made.

A server process therefore refuses to start without `REDIS_URL`, and its exit message says which of these it found
(B-9001):

- `WORKERS_ENABLED=false`: this is an API process, and another process runs its jobs.
- `SERVER_REPLICAS` above 1: the deployment says it runs several.
- Another instance's live heartbeat in the database (`platform_instances`, written every 30 seconds by every server
  process and removed at a clean shutdown). A heartbeat is live for 95 seconds. A row left by a process of the same
  host that was killed is not counted (its pid is gone) and is removed, so a single process restarts at once after a
  crash; a row from another host counts until it is 95 seconds old.

The CLI (`migrate`, `admin:create`, backups) and scripts that use the server's services against the database are not
server processes: they write no heartbeat and are not refused.

With `REDIS_URL` set, `/readyz` has a `redis` check: the bus's subscriber connection must be up and its publisher
must answer a PING within two seconds. While it fails the instance answers 503 with `checks.redis: "unavailable"`
(the cause is in the log, not in the public answer), a load balancer sends it nothing new, and the Overview shows it
as not ready. It keeps running and turns ready again when Redis answers. Redis being down when a process starts does
not stop it from starting; it starts unready.

What this means per deployment:

| Deployment | Requirement |
| --- | --- |
| Bare metal (systemd) | One `exprsn-ai` unit on one host needs no Redis. A second unit or host on the same database (more API hosts behind the load balancer, or a worker host with the API hosts on `WORKERS_ENABLED=false`) needs `REDIS_URL` in every unit's environment or credentials; start Redis first. A unit started without it fails with the reason in `journalctl -u exprsn-ai` |
| Docker Compose | `compose.yml` and `compose.dev.yml` run Redis and set `REDIS_URL` on the app, and the app waits for Redis to be healthy. Scaling the app (`docker compose up --scale app=2`) or adding a worker service needs nothing more. Removing the Redis service leaves one process, which still starts; a second would not |
| Kubernetes (Helm) | The chart refuses to render more than one replica (or an autoscaler maximum above 1) without `secrets.REDIS_URL`, and sets `SERVER_REPLICAS` from that number so the server makes the same check. A release with `config.workersEnabled: false` beside a workers-only release needs the secret in both. With one replica and no Redis the chart uses the `Recreate` strategy (the old pod stops before the new one starts): a surge pod would find the old pod's heartbeat and refuse to start |

A managed cache as `REDIS_URL` (1.9.99-final, B-10305) must suit BullMQ and the bus: cluster mode off (one keyspace on
one primary; ElastiCache with cluster mode disabled, Azure Cache for Redis without shards, Azure Managed Redis with the
`NoCluster` policy, DigitalOcean Managed Valkey; never MemoryDB, which is always clustered), `maxmemory-policy
noeviction` (the providers' defaults evict: `volatile-lru` on ElastiCache and Azure, an LRU policy on DigitalOcean) and
TLS (`rediss://`). A deployment's provisioned cache is made that way and refused by the planner otherwise
([cloud.md](cloud.md#caches-as-redis_url)); for a cache you bring, `/readyz` reports `checks.redis: "incompatible:
..."` when it is not (the instance keeps serving; fix the cache's parameter group or configuration).

Behind the bus, the PDS's `subscribeRepos` and the labelers' `subscribeLabels` streams also read the database
(B-9002): every `ATPROTO_STREAM_POLL_SECONDS` (default 5) an instance with open streams reads the newest seq and sends
its subscribers what they have not had. The bus announcement makes delivery immediate; the poll makes it certain. A
label made in a worker process while Redis restarts reaches a subscriber on another process within one interval, in
seq order, exactly once (each connection reads from its own cursor).

## Docker Compose

```sh
cd deploy/docker
./gen-secrets.sh                                   # writes secrets/*.txt, mode 600
cp ../config/identity.example.yaml identity.yaml   # edit: your OpenLDAP and SQL user stores
echo -n 'ldap-service-password' > secrets/ldap_bind_password.txt
PUBLIC_URL=https://ai.example.internal docker compose up -d --build
docker compose exec app node server/dist/cli.js admin:create --username root --display-name "Platform admin"
```

With `--enrol-link` instead of a password, `admin:create` prints a single-use link (valid for `PASSWORD_INVITE_HOURS`)
that sets the password and then asks for the second factor before anything else, so the first admin is never
usable with a password alone. Hand the link over a trusted channel.

The app container runs read-only as a non-root user with all capabilities dropped. PostgreSQL sits on an internal
network. `docker compose --profile inference up -d` adds Ollama on its own internal network; add `-f compose.gpu.yml`
for NVIDIA GPUs.

For development with every kind of user store and seed users (OpenLDAP, a PostgreSQL table, a MySQL table):

```sh
docker compose -f deploy/docker/compose.dev.yml up --build
```

and sign in at http://localhost:8080 as `mokafor` / `Northwind-Dev-Password-1` (system admin from the `ai-admins`
LDAP group; enrols TOTP at first sign-in), `jlee` / `Northwind-Dev-Password-2` (member), `apatel` /
`Northwind-Dev-Password-3` (PostgreSQL table) or `partner1` / `Northwind-Dev-Password-4` (MySQL table).

## Bare metal (systemd)

```sh
sudo deploy/baremetal/install.sh                        # build this checkout (the same as --from-source)
sudoedit /etc/exprsn-ai/exprsn-ai.env /etc/exprsn-ai/identity.yaml /etc/exprsn-ai/credentials/database_url
sudo systemctl enable --now exprsn-ai
```

Since 1.9.99-final (B-10204) the installer also takes a mode. With no mode, or with `--from-source`, it builds the
checkout as it always did (it prints a note saying so). `--from-release` installs a release tarball instead,
verified before anything from it runs:

```sh
sudo install.sh --from-release https://releases.example.com/exprsn-ai-1.0.0.tar.gz --sha256 <64 hex digits> \
  [--bundle <cosign bundle URL> --cert-identity-regexp '<signer identity>'] [--start]
install.sh --from-release file:///tmp/exprsn-ai-1.0.0.tar.gz --sha256 <digest> --dry-run   # verify only, no root
```

1. The tarball is downloaded (https only, TLS 1.2 or later, no redirect to another scheme; `file://` for a local
   copy; `--archive <file>` uses one already downloaded) into a private temporary directory.
2. Its sha256 is compared with `--sha256`. On a mismatch the download is deleted and the install refused (exit 3):
   nothing is extracted and nothing from it runs.
3. With `--bundle`, the cosign bundle is verified with `cosign verify-blob` (keyless; the certificate identity
   `--cert-identity-regexp` and issuer `--cert-oidc-issuer`, GitHub Actions by default); a bundle without an identity,
   no cosign on the host, or a signature that does not verify refuses (exit 4).
4. The entries must all lie under `exprsn-ai/` (no absolute path, no `..`), links must stay inside the tree, and the
   tree must hold a built release (`server/dist/index.js`, `cli.js`, `web/`, the unit and the env example); otherwise
   exit 5. `--dry-run` stops here.
5. The tree is installed as with `--from-source` (`/opt/exprsn-ai`, the previous one kept as `.old`); a bundled
   `node/bin/node` is used when the release carries one, else Node.js 22 must be installed.

Options for a host built by a cloud deployment (the user data passes them, [cloud.md](cloud.md#vm-and-container-targets-b-10204-b-10205)):
`--kms openbao|aws-kms|azure-keyvault` (no `DATA_KEY` is generated or loaded), `--credentials-list <file>` (lines
`<credential> <VARIABLE>`) and `--credentials-wrapped <file>` (JSON `{addr, token}`: a single-use OpenBao
response-wrapping token; the installer unwraps it once over https, writes each credential under
`/etc/exprsn-ai/credentials/`, seals it with `systemd-creds encrypt` where that works and writes the unit's
`LoadCredential=` or `LoadCredentialEncrypted=` lines with `<VARIABLE>_FILE=%d/<credential>`; a token that was already
used refuses with exit 6), `--start`. Every outcome is an `exprsn-install: <state> ...` line, also on the console
when run as root, which the deployment's readiness check reads. The release tarball and its bundle are not built by
CI yet (the image is cosign-signed; the tarball job is a follow-up), so `--bundle` is for releases signed by hand
with `cosign sign-blob --bundle`.

The installer (`--from-source`) builds from the checkout, installs to `/opt/exprsn-ai` (keeping the previous release as
`/opt/exprsn-ai.old`), creates the `exprsn-ai` system user, generates the session secret and data key as systemd
credentials, and installs a hardened unit (`ProtectSystem=strict`, no capabilities, system-call filter, only
`/var/lib/exprsn-ai` writable). If Node.js is not at `/usr/bin/node`, adjust `ExecStart`.

Put nginx or HAProxy in front for TLS and set `TRUST_PROXY` to its address. Forward WebSocket upgrades for
`/socket.io/`. Preparing Ollama GPU nodes: [deploy/baremetal/ollama-node.md](../deploy/baremetal/ollama-node.md).

### Apple silicon nodes: `fm serve`, MLX and llama.cpp beside Ollama (1.6.0)

Since 1.6.0 (B-43) an instance can be a Chat Completions server instead of Ollama (`kind: openai`). On a Mac with
macOS 27 that is Apple's on-device Foundation Model through `fm serve`; `mlx_lm.server` and llama.cpp's
`llama-server` work the same way. They run beside Ollama on the node and join a pool whose accelerator is `metal`.
They hold their own models: the gateway does not pull, load or unload on them (those requests are skipped and
recorded), and models are registered from what the server lists, with no digest.

1. Check the model: `fm available` should print "System model available" (Apple Intelligence enabled for the user
   that runs it). `fm respond 'Say ready'` answers on the device. The Private Cloud Compute model (`pcc`) is listed by
   `fm serve` but refused outside Apple's own clients, and is never offered for registration.
2. Run `fm serve` on a Unix socket under launchd, as the user that runs Exprsn AI. A LaunchAgent in that user's
   session (`~/Library/LaunchAgents/io.exprsn.fm-serve.plist`) is what has been tried; a LaunchDaemon without a login
   session may not reach the model:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>io.exprsn.fm-serve</string>
     <key>ProgramArguments</key><array>
       <string>/usr/bin/fm</string><string>serve</string><string>--socket</string><string>/Users/exprsn/run/fm.sock</string>
     </array>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardErrorPath</key><string>/Users/exprsn/Library/Logs/fm-serve.log</string>
   </dict></plist>
   ```

   ```sh
   mkdir -p ~/run && chmod 700 ~/run
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.exprsn.fm-serve.plist
   curl --unix-socket ~/run/fm.sock http://localhost/health    # {"status":"fm serve is running","models":[…]}
   ```

   Keep the socket path under 104 characters (the macOS limit) and in a directory only the service user can open:
   `fm serve` has no authentication of its own, so the socket's permissions are the access control. A socket works
   only when the Exprsn AI server runs on the same Mac. For a server elsewhere, run `fm serve --host 127.0.0.1 --port
   1976` and publish it through a reverse proxy that terminates TLS (with a client certificate, which the instance's
   mutual TLS settings present) or checks a bearer token; never bind `fm serve` to `0.0.0.0`.
3. In the console, Admin → Pools: add a pool with accelerator `metal` (for example `apple-silicon`, in the
   `inference` zone, with the label ceiling the data needs). Then Admin → Models → Model servers → Register model
   server: the pool, a name (`mac-studio-1-fm`), kind Chat Completions server, transport Unix socket, the socket path.
   The instance shows healthy with version `fm serve`, and a probe records whether tool calls and JSON schema output
   work. By API: `POST /api/admin/pools/<pool id>/instances {"name": "mac-studio-1-fm", "kind": "openai",
   "socketPath": "/Users/exprsn/run/fm.sock", "deploy": "baremetal"}`.
4. Admin → Models → Request import → Held by a model server: pick `system`, record the licence (Apple's terms for the
   Foundation Models framework), choose the label. It is registered as a draft, placed warm on the pool, with nothing
   pulled. Run the evaluation (it runs on that instance), and have a second administrator approve it. A profile on
   that model and pool then answers in chat, streams, calls read-only tools and is metered like an Ollama model.
5. Embeddings: `fm serve` has no `/v1/embeddings`. Keep the embedding and guard models (`qwen3-embedding:0.6b`, the
   guard profile's model) on an Ollama pool in the same zone; knowledge, memory and the guard use those whatever
   model the chat profile runs on.

Alternatives on the same node, each registered the same way with a URL instead of a socket:

- MLX: `mlx_lm.server --model mlx-community/Qwen3-4B-4bit --host 127.0.0.1 --port 8080`. It has no `/health`; the
  gateway uses `/v1/models` for health. Its model ids (`mlx-community/Qwen3-4B-4bit`) are the catalogue names.
- llama.cpp: `llama-server -m qwen2.5-7b-instruct-q4_k_m.gguf --alias qwen2.5-7b-instruct --jinja --host 127.0.0.1
  --port 8081 --api-key "$TOKEN"` (`--jinja` for tool calls, `--embeddings` on a separate instance to serve an
  embedding model). Give the token in the form; it is stored in your tenant's vault (you need `secrets:write` and
  `secrets:read`) and never shown again. The context length comes from its `/props`.

Ollama-only settings (`num_ctx`, `keep_alive`, thinking) are not sent to these servers; the instance's events record
which were left out. Upgrades of these servers are the operator's: the pool's rolling Ollama upgrade skips them.

## Kubernetes (Helm)

The chart in [deploy/helm/exprsn-ai](../deploy/helm/exprsn-ai/README.md) runs the application server as a Deployment
with a Service, an Ingress, a PodDisruptionBudget, an optional HorizontalPodAutoscaler and ServiceMonitor, and
NetworkPolicies that mirror the network zones. PostgreSQL or MySQL, Redis, the S3 store, OpenBao, the directory and the
Ollama nodes are external; Ollama instances are registered in the console as usual.

```sh
kubectl create namespace exprsn-ai
kubectl -n exprsn-ai create secret generic exprsn-ai \
  --from-literal=session_secret="$(openssl rand -hex 32)" --from-literal=data_key="$(openssl rand -base64 32)" \
  --from-literal=database_url='postgres://...' --from-literal=redis_url='redis://...' \
  --from-literal=s3_secret_access_key='...'
helm install exprsn-ai deploy/helm/exprsn-ai -n exprsn-ai -f my-values.yaml
kubectl -n exprsn-ai exec -it deploy/exprsn-ai -- node server/dist/cli.js admin:create --username root --display-name "Platform admin"
```

- Secrets are never values in the chart: each `secrets.<NAME>` entry names a key of an existing Secret, mounted as a
  file under `/run/secrets/` and read through `<NAME>_FILE`.
- Pods run as UID 1000 with a read-only root filesystem, no capabilities, no privilege escalation, the `RuntimeDefault`
  seccomp profile and no service-account token. Probes use `/healthz` (startup, liveness) and `/readyz` (readiness).
- Migrations run in an init container (`node server/dist/cli.js migrate`) or a pre-upgrade hook Job, and the chart sets
  `DB_MIGRATE_ON_START=false`.
- The chart refuses to render several replicas without `REDIS_URL`, SQLite, or a plain `http://` `PUBLIC_URL` in
  production. It passes the highest replica count the release can reach as `SERVER_REPLICAS`, and the server refuses
  to start as one of several without Redis (B-9001); with Redis, the readiness probe fails while Redis does not
  answer, so a pod cut off from it is taken out of the Service until it answers again.
- NetworkPolicies deny everything in and out of the pods except the ingress controller, DNS and the egress groups you
  fill in (data, directory, inference, sandbox, KMS, mail, SIEM). Nothing allows the internet.
- `SCRIPT_RUNNER` is `none` in the chart, since the pod has no container runtime; run script runners in the sandbox
  zone.
- Zones applied in-cluster (Sprint 22): `zonesApply.enabled` with `zonesApply.namespaces` (the zone namespaces, which
  must exist) creates in each a Role allowing get, list, create and patch on networkpolicies and binds it to the
  server's service account, mounts that account's token and sets `ZONES_APPLY=kubernetes`. Allow egress to the API
  server in `networkPolicy.egress.kubernetesApi`. Off by default: the pod then has no token.
- Cloud KMS (1.9.99-final, B-10208): `config.kms.provider` also takes `aws-kms` and `azure-keyvault`. Give their
  settings (`KMS_AWS_*`, `KMS_AZURE_VAULT_URL`, `AZURE_IDENTITY_*`) in `config.extra`, the projected service-account
  token (audience `sts.amazonaws.com` or `api://AzureADTokenExchange`) in `extraVolumes` and `extraVolumeMounts`, and
  leave `secrets.DATA_KEY` empty. A Kubernetes deployment made from the console with `clusterKeys` gets exactly this.

### The deploy worker's Helm (1.9.99-final, B-10203, open decision 7)

Kubernetes deployments made from the console are installed by the server itself with a pinned Helm 3 binary
(`HELM_BIN`, default `helm` on the PATH; Helm **3.19.0**: any other version is refused). The chart in
`deploy/helm/exprsn-ai` is the source; the values come from the deployment spec (`docs/cloud.md`, "Kubernetes target
and upgrades"). Helm runs as a child process with an argument array (never a shell), a private working directory and
environment, and the cluster's kubeconfig in a private temporary file that is deleted afterwards.

- **This install (dev):** `HELM_BIN` is set in `env.sh` to `toolchain/helm/bin/helm` (Helm 3.19.0 for darwin-arm64,
  from `https://get.helm.sh/helm-v3.19.0-darwin-arm64.tar.gz`, sha256
  `31513e1193da4eb4ae042eb5f98ef9aca7890cfa136f4707c8d4f70e2115bef6`, checked before unpacking).
- **The worker image:** add Helm 3.19.0 for linux-amd64 (`helm-v3.19.0-linux-amd64.tar.gz`, sha256
  `a7f81ce08007091b86d8bd696eb4d86b8d0f2e1b9f6c714be62f82f96a594496`), verify the archive before unpacking, set
  `HELM_BIN`, and copy `deploy/helm/exprsn-ai` to `/app/deploy/helm/exprsn-ai` (the server finds the chart there).
  The Dockerfile does not do this yet.
- **CI:** `cloud-kubernetes.test.ts` renders and lints the chart (`helm template`, `helm lint --strict`) with each
  provider's derived values when `HELM_BIN` points at Helm 3.19.0, and skips that test, saying so, otherwise. Install
  the same pinned release (verified by its `.sha256sum`) in the job and export `HELM_BIN` to run it; the cluster
  operations are played against a fake cluster and need no Kubernetes.

## Cloud (2.0.0: the 1.9.99-final epic, Sprints 56 to 62)

From a running install, the console connects AWS, Azure, DigitalOcean and Cloudflare accounts and uses them in both
directions: it deploys Exprsn-AI (Kubernetes, VMs, container platforms, the Cloudflare app tier, a front door for an
on-prem install) and it uses their services (managed databases as its own database or as data connections, managed
caches as `REDIS_URL`, GPU pools, cloud model backends, object stores, billing data). The design and every
provider's setup are in [cloud.md](cloud.md); the routes in [api.md](api.md); the threat model and the known gaps in
[security.md](security.md). This page covers what an operator configures on the server:

- **Nothing changes until an account is added.** The cloud routes need migrations `146_cloud_accounts` onwards
  (expand only: `exprsn-ai migrate --check` exits 2 on a 1.9.9-qa database, and a rolling upgrade is safe). Without
  them every cloud route answers `503` `migration_pending`.
- **Who may:** the permissions `cloud:read`, `cloud:deploy`, `cloud:admin`, `finops:read`, `finops:manage` and the
  built-in roles `cloud-admin`, `cloud-operator` and `finops-analyst` ([permissions.md](permissions.md)); platform
  accounts also need `platform:manage`.
- **Egress:** the server calls the providers' APIs directly (AWS SDK v3, ARM, the DigitalOcean API v2, the Cloudflare
  API v4) through the cloud transport, which allows only the providers' API hosts (`CLOUD_PROVIDER_HOSTS`; a private endpoint
  is named in `SERVICE_ALLOWED_HOSTS`) and refuses metadata addresses everywhere; open outbound HTTPS to them from the app's network.
- **Credentials** are federated short-lived sessions (AWS, Azure) from the federation issuer, or tokens and keys in
  the tenant vault, never in the environment. The install's own cloud identity (for a cloud KMS or Azure Blob) is the
  workload identity, or a secret given only as a file in production: `KMS_AWS_SECRET_ACCESS_KEY_FILE`,
  `AZURE_IDENTITY_CLIENT_SECRET_FILE`, `BLOB_AZURE_ACCOUNT_KEY_FILE`.
- **The federation issuer** (`CLOUD_ISSUER_URL`) must be reachable by AWS STS and Entra from the internet: only its
  discovery document and JWKS, published to a public bucket or served on `/cloud-issuer` (open decision 2).

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLOUD_ISSUER_URL` | `PUBLIC_URL` + `/cloud-issuer` | The federation issuer the clouds trust, apart from the console's OIDC issuer (B-10005) |
| `CLOUD_ISSUER_TOKEN_SECONDS` | `300` | Lifetime of a token minted for STS or Entra (60 to 3600) |
| `CLOUD_ISSUER_PUBLISH_LEAD_MINUTES` | `15` | A new issuer key is published this long before it signs |
| `CLOUD_ISSUER_ROTATION_DAYS` | `90` | Issuer key rotation (0: only by hand) |
| `CLOUD_ISSUER_CHECK_MINUTES` | `30` | How often the published JWKS is compared with the issuer's keys (0: never) |
| `CLOUD_AZURE_SIGNING_ALG` | `ES256` | `ES256` or `RS256` for tokens with the Azure audience (open decision 3) |
| `CLOUD_SESSION_SECONDS` | `3600` | Length of a federated or vaulted session, cached per instance and refreshed at two thirds |
| `CLOUD_AWS_KEY_ROTATION_DAYS`, `CLOUD_AWS_KEY_OVERLAP_MINUTES` | `90`, `15` | Vaulted AWS keys replaced automatically (0: never), the old key deleted after the overlap |
| `CLOUD_AZURE_SECRET_DAYS` | `180` | Lifetime of Azure client secrets added through Graph |
| `CLOUD_CREDENTIAL_NOTICE_DAYS` | `14` | Notices before a vaulted token expires (DigitalOcean, Cloudflare, an Azure secret Graph cannot replace) |
| `CLOUD_CREDENTIAL_CHECK_MINUTES` | `15` | The credential sweep: rotations due, overlaps ended, expiry notices (0: never) |
| `CLOUD_DRIFT_MINUTES` | `15` | How often `cloud.drift` reads every managed resource (0: never) |
| `CLOUD_ORPHAN_SWEEP_HOURS` | `24` | How often `cloud.orphans` looks for tagged resources nothing knows (0: never) |
| `CLOUD_AUTO_ROLLBACK` | `true` | A failed apply of a deployment that passed verify rolls its replaceable resources back |
| `CLOUD_BUDGET_CHECK_MINUTES` | `60` | How often due budget alerts are sent and expired overrides end (0: only after applies) |
| `CLOUD_HTTP_TIMEOUT_MS` | `15000` | Timeout of a provider API call |
| `CLOUD_AWS_STS_URL`, `CLOUD_AWS_IAM_URL`, `CLOUD_AZURE_AUTHORITY`, `CLOUD_AZURE_GRAPH_URL` | the public endpoints | Provider endpoints (the tests point them at fakes) |
| `HELM_BIN` | `helm` | The pinned Helm 3.19.0 the deploy worker installs releases with ([below](#the-deploy-workers-helm-1999-final-b-10203-open-decision-7)) |

The front door (`TRUST_PROXY` with `cloudflare`, `CLOUDFLARE_*`) is in [Behind Cloudflare](#behind-cloudflare-1999-final-b-10901-to-b-10904);
cloud KMS and Azure Blob (`KMS_PROVIDER=aws-kms | azure-keyvault`, `BLOB_STORE=azure`) in
[Keys and blobs on a cloud](#keys-and-blobs-on-a-cloud-1999-final-b-10208); `ACME_DNS_PROVIDER=route53 | azure-dns |
digitalocean` with `ACME_DNS_CLOUD_ACCOUNT` in [ACME certificates](#acme-certificates); moving this install's
database in [Moving to a managed database](#moving-to-a-managed-database-1999-final-b-10302). Upgrading from 1.9.9-qa:
[release-2.0.0.md](release-2.0.0.md).

## Behind Cloudflare (1.9.99-final, B-10901 to B-10904)

Any install (Compose, bare metal, Helm, or a cloud deployment) can sit behind the Cloudflare front door instead of
ACME: Cloudflare DNS for its name, edge TLS with Full (strict) to the origin, an optional Cloudflare Tunnel so no
inbound port is open, WAF and rate limit rules mirroring the server's own limits, and optionally Cloudflare Access in
front of the admin console. Set it up under Admin > Cloud > Front door or `POST /api/admin/cloud/edge`; the full
behaviour is in [cloud.md](cloud.md#cloudflare-front-door-b-10901-to-b-10904). Cloudflare's edge sees decrypted
traffic: keep data labelled `restricted` off an install behind it (open decision 5, [security.md](security.md)).

With a tunnel, run the connector beside the app (the token comes from the vault into a file:
`exprsn-ai cloud:tunnel-token --edge <name> --out <file>`, mode 0600, never printed):

- **Compose**: `docker compose -f compose.yml -f compose.tunnel.yml up -d` with the token in
  `secrets/cloudflared_token.txt` (owned by uid 65532). The app publishes no port.
- **Bare metal**: `deploy/baremetal/exprsn-cloudflared.service` with the token at
  `/etc/exprsn-ai/credentials/cloudflared_token`; set `HOST=127.0.0.1` and `TRUST_PROXY=loopback,cloudflare` in
  `exprsn-ai.env` and close 80 and 443 in the host firewall.
- **Helm**: `cloudflared.enabled: true` with `cloudflared.tokenSecret` naming a Secret made from the token file,
  `ingress.enabled: false`, `config.trustProxy: uniquelocal,cloudflare` (`ci/tunnel-values.yaml` is the example the
  chart is linted with). The connector is its own Deployment with its own NetworkPolicy, and the server's ingress
  policy admits only the connector's pods.

Without a tunnel (a public origin), keep the origin's certificate valid for the name (the ACME one keeps renewing:
the http-01 challenge passes the edge) and set `TRUST_PROXY` to your proxy's list plus `cloudflare`.

## Runbooks and load testing

- [Backup and restore](runbooks/backup-restore.md): database dumps per dialect, blob store, keys, restore order,
  verification with `exprsn-ai audit:verify`, restore drills.
- [Incident response](runbooks/incident-response.md): severity, first 15 minutes, revoking sessions and API keys,
  rotating `SESSION_SECRET` and data keys, disabling a tenant, audit forensics, guardrail emergency blocks, draining
  Ollama instances.
- [Upgrade and rollback](runbooks/upgrade.md): rolling upgrades, migrations, rollback, Ollama node upgrades.
- [Load test of the streaming path](loadtest.md): `server/loadtest/stream.ts` and the 1.0 targets.

## Operations

- **Health:** `/healthz` (process up), `/readyz` (database reachable and migrated, KMS and blob store answering; 503 while draining).
- **Metrics:** `/metrics` with `Authorization: Bearer $METRICS_TOKEN`. Sprint 22 adds job, rate-limit, schema, zone
  drift, clock and trace-export series; Grafana dashboards and Prometheus alert rules for them are in
  [deploy/observability](../deploy/observability/README.md), each alert explained in
  [runbooks/alerts.md](runbooks/alerts.md).
- **Tracing (Sprint 22):** set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OpenTelemetry collector (or Tempo, Jaeger with
  OTLP/HTTP). A chat request is one trace: the HTTP span, guardrail checks, the gateway's Ollama calls (which receive
  the `traceparent`), database queries and the jobs it queued. Attributes are a fixed allow-list of metadata.
- **Upgrades (Sprint 22):** `exprsn-ai migrate --check` lists what `migrate` would apply and any destructive
  (contract) steps; an instance older than the database schema stops taking jobs and reports not ready
  ([upgrade.md](runbooks/upgrade.md)).
- **Key escrow (Sprint 22):** `exprsn-ai kms:escrow --shares 5 --threshold 3` splits `DATA_KEY` into Shamir shares
  and `kms:recover` rebuilds it ([backup-restore.md](runbooks/backup-restore.md#keys)).
- **Logs:** JSON on stdout; every line carries the request's trace id, which is also in every error response.
- **Shutdown:** SIGTERM stops accepting connections, closes sockets and the database, and exits within 25 s.
- **Audit:** `exprsn-ai audit:verify --tenant <slug>` checks the chain and its signed checkpoints and exits 2 when
  either is broken. Checkpoints are also written to the blob store under `audit-checkpoints/`.
- **Keys:** `exprsn-ai kms:rotate --tenant <slug>` starts a new data-key version; older values stay readable.
  Offboarding a tenant destroys its keys (crypto-shredding) and cannot be undone.
- **Changing the key-encryption key (Sprint 15):** to replace `DATA_KEY`, set the new value as `DATA_KEY` and the
  old one as `DATA_KEY_PREVIOUS` on every instance and restart them (reads fall back to the old key, new keys use the
  new one); then run `exprsn-ai kms:rewrap`. It re-wraps every data key, re-signs audit checkpoints and rewrites each
  backup's archive key and manifest, verifies that everything opens with the new key alone, and exits 2 if not; it is
  safe to run again. When it reports verified, remove `DATA_KEY_PREVIOUS`. To move from the local KMS to OpenBao, set
  `KMS_PROVIDER=openbao` with `KMS_PREVIOUS_PROVIDER=local` (the old `DATA_KEY` stays set, or goes in
  `DATA_KEY_PREVIOUS`); from OpenBao to local, `KMS_PROVIDER=local`, the new `DATA_KEY` and
  `KMS_PREVIOUS_PROVIDER=openbao` with `OPENBAO_ADDR` and `OPENBAO_TOKEN` still set. Since 1.9.99-final the same works for
  `KMS_PROVIDER=aws-kms` and `azure-keyvault` (and back: `KMS_PREVIOUS_PROVIDER=aws-kms` with its settings still set);
  see [Keys and blobs on a cloud](#keys-and-blobs-on-a-cloud-1999-final-b-10208).
- **The signer (Sprint 20):** `exprsn-ai signer` is a separate process that holds the local key-encryption key (what
  `DATA_KEY` was; the same value keeps every existing data key readable, no re-wrap needed) and every private key the
  app creates: OIDC (ES256), SAML (RS256), the SAML SP decryption key (RSA-OAEP) and webhook Ed25519 keys. It needs
  only `SIGNER_SOCKET`, `SIGNER_KEY_FILE` and `SIGNER_TOKEN_FILE` (both files mode 0600), plus `SIGNER_SOCKET_MODE=0660`
  when the app runs as another user in the socket directory's group. The app then sets `SIGNER_SOCKET` and
  `SIGNER_TOKEN_FILE` (the same token) and no `DATA_KEY`. Bare metal: `deploy/baremetal/exprsn-signer.service` (its
  header has the setup); Kubernetes: `signer.enabled` in the Helm chart runs it as a native sidecar with the key mounted
  into it alone. Existing federation and webhook keys sealed in the app are replaced by signer-held ones on first use
  (the old public keys stay published for the overlap window; SAML partners re-import the metadata). If the signer is
  down, everything that needs a key fails closed and `/readyz` reports the KMS unavailable.
- **Rate limits (Sprint 15):** with `REDIS_URL` set, the API limits, the failed-credential throttle and the denial
  cap are shared by all instances (one atomic Lua script per hit); if Redis stops answering they fall back to
  per-instance memory counters rather than letting requests through. Since Sprint 22 the Platform screen warns while that lasts.
- **Backups:** back up the application database and the blob store together, and the KMS (OpenBao) or `DATA_KEY`
  separately from both: without the key, sealed conversations, attachments and exports cannot be read. Sessions,
  lockout counters and Redis can be lost safely; the audit chain and users cannot.
- **Several instances:** set `REDIS_URL` on every instance; since 1.7.0 (B-9001) a server process that is one of
  several refuses to start without it, and `/readyz` fails while a configured Redis does not answer (see
  [Redis and more than one process](#redis-and-more-than-one-process)). Chat streams are served by the instance that
  runs them; stop requests, session revocations and notifications reach every instance through Redis.

## Keys and blobs on a cloud (1.9.99-final, B-10208)

An install deployed to a cloud can keep its key-encryption keys in that cloud's KMS and its blobs in its object store:

| Cloud | KMS | Blob store |
| --- | --- | --- |
| AWS | `KMS_PROVIDER=aws-kms` | `BLOB_STORE=s3` with the bucket's regional endpoint |
| Azure | `KMS_PROVIDER=azure-keyvault` | `BLOB_STORE=azure` |
| DigitalOcean | OpenBao or the signer (DigitalOcean has no KMS API) | `BLOB_STORE=s3` with the Spaces endpoint (`https://<region>.digitaloceanspaces.com`, `S3_FORCE_PATH_STYLE=false`) |
| Cloudflare | OpenBao or the signer; the Cloudflare app tier itself needs OpenBao transit (below) | `BLOB_STORE=s3` with the R2 endpoint (`https://<account>.r2.cloudflarestorage.com`, `S3_REGION=auto`) |

**R2 (1.9.99-final, Sprint 61, B-10906).** `BLOB_STORE=s3`, `S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com`
(`https://<account id>.eu.r2.cloudflarestorage.com` for a bucket in the EU jurisdiction, `.fedramp.` for FedRAMP),
`S3_REGION=auto`, `S3_FORCE_PATH_STYLE=true`, `S3_BUCKET`, and an R2 API token's access key id as `S3_ACCESS_KEY_ID`
with its secret in `S3_SECRET_ACCESS_KEY_FILE`. Files, backups (`backup:create`, `backup:restore` read and write the
configured store), training artefacts and export bundles all go there. A bucket Exprsn-AI provisions on a Cloudflare
account takes the jurisdiction its region names (`r2-eu`, `r2-fedramp`), checked against the account's regions,
ceilings and the tenant's residency like any placement.

**The Cloudflare app tier (1.9.99-final, Sprint 61, B-10905).** A deployment spec with `compute.shape: cloudflare`
runs the signed image on Cloudflare Containers behind a Worker (which serves the console's static files), reaches
PostgreSQL through Hyperdrive (a provisioned or an on-prem database through a tunnel with an Access service token, an
existing one directly unless `databaseVia: tunnel`) and keeps blobs on R2. Nothing yet runs the `cloudflared`
connector beside the data tier: start it there by hand from the shipped unit, Compose file or chart (a known gap,
[security.md](security.md#known-gaps-tracked-in-the-plan)). Redis must come from a managed cache on another
provider (`compute.cloudflare.redisUrlRef`): a TLS endpoint with authentication that Cloudflare's egress ranges may
reach (open decision 19). Keys stay in OpenBao transit (`keys.provider: openbao`). See
[cloud.md](cloud.md#cloudflare-app-tier-r2-d1-and-ai-gateway-b-10905-to-b-10908).

What the cloud KMSes hold: one key per tenant (and one for platform-wide secrets) wraps that tenant's data keys, so
content is still sealed in the database with per-tenant data keys and only those small keys go to the KMS. The
associated data (`dek:<tenant>:<version>`) is bound into every wrap: the AWS encryption context, or its digest inside
the Key Vault wrapped bytes. Audit checkpoints, backup manifests, image provenance and model cards are signed in the KMS
with an ES256 key per signing name (neither cloud offers HMAC keys in both), verified with its public key; a signature
names the key or key version that made it, so after a signing-key rotation the checkpoints signed before still verify.
OIDC, SAML, PKI and webhook keys keep their own custody (the signer or sealed keys): the cloud KMS adapters do not offer
general key creation, because neither cloud holds every key type those features use (Ed25519, secp256k1).

**How a deployed install gets its KMS credential.** The KMS cannot use a cloud account from the console: those
credentials sit in the vault, which the KMS's own keys open. The install's identity therefore comes from its own
environment, read explicitly, and never from the instance metadata service (every call goes through the cloud
transport and the egress guard, which refuses metadata addresses; no SDK default credential chain runs):

- **AWS, EKS:** IAM roles for service accounts. Annotate the pod's service account with the role, then set
  `KMS_AWS_ROLE_ARN` to the role and `KMS_AWS_WEB_IDENTITY_TOKEN_FILE` to the projected token
  (`/var/run/secrets/eks.amazonaws.com/serviceaccount/token`). The server calls STS `AssumeRoleWithWebIdentity` itself
  and refreshes the one-hour session at two thirds of its life, reading the token file again each time.
- **AWS, EC2 or ECS without a web identity:** a dedicated IAM user's key pair, `KMS_AWS_ACCESS_KEY_ID` with
  `KMS_AWS_SECRET_ACCESS_KEY_FILE` (a Docker secret, systemd credential or mounted secret), rotated by hand. The
  instance role is not used: IMDSv2 stays closed to the app.
- **Azure, AKS:** workload identity. Federate the managed identity (or app registration) with the cluster's issuer and
  the service account; set `AZURE_IDENTITY_TENANT_ID`, `AZURE_IDENTITY_CLIENT_ID` and
  `AZURE_IDENTITY_FEDERATED_TOKEN_FILE` (`/var/run/secrets/azure/tokens/azure-identity-token`). The token file is the
  client assertion for Entra; tokens for Key Vault and Storage are refreshed at two thirds of their life.
- **Azure, VMs or Container Apps without workload identity:** an app registration's secret,
  `AZURE_IDENTITY_CLIENT_SECRET_FILE`.

Production refuses `KMS_AWS_SECRET_ACCESS_KEY`, `AZURE_IDENTITY_CLIENT_SECRET` and `BLOB_AZURE_ACCOUNT_KEY` given
inline in the environment, as it does `DATA_KEY`: only the `_FILE` forms (or a federated identity, which has no
secret). With `REQUIRE_BACKEND_TLS`, plain-http KMS and Blob endpoints are refused unless `kms` or `azure-blob` is in
`BACKEND_TLS_EXEMPT`. Private endpoints outside `*.amazonaws.com`, `*.vault.azure.net` and `*.blob.core.windows.net`
must be named in `SERVICE_ALLOWED_HOSTS`.

**Permissions.** AWS: `kms:CreateKey`, `kms:TagResource`, `kms:EnableKeyRotation`, `kms:CreateAlias`,
`kms:UpdateAlias`, `kms:DeleteAlias`, `kms:DescribeKey`, `kms:ListKeys`, `kms:Encrypt`, `kms:Decrypt`, `kms:Sign`,
`kms:GetPublicKey` and `kms:ScheduleKeyDeletion`, best limited by the `exprsn:key-name` tag and the alias prefix.
Azure: Key Vault Crypto Officer on the vault (or create, get, list, wrapKey, unwrapKey, sign, delete and purge key
permissions), and Storage Blob Data Contributor on the container.

**Moving an existing install** from the local KMS: set `KMS_PROVIDER=aws-kms` (or `azure-keyvault`) with its
settings, `KMS_PREVIOUS_PROVIDER=local` and the old key as `DATA_KEY_PREVIOUS` (or leave `DATA_KEY` set), restart,
run `exprsn-ai kms:rewrap` until it reports verified, check `exprsn-ai audit:verify`, then remove the previous key.
Destroying a tenant (offboarding) schedules its AWS keys for deletion after `KMS_AWS_DELETION_DAYS` and removes the
aliases at once (so nothing opens again), or deletes and purges its Key Vault keys (the purge needs the purge
permission; without it the key stays soft-deleted for the vault's retention). Moving blobs between stores is the
Storage screen's migration (B-4204); the Azure store answers the same `BlobStore` calls as the others (ranged reads of
8 MiB, block uploads, prefix listing).

## Moving to a managed database (1.9.99-final, B-10302)

An install's own database moves onto a managed PostgreSQL (RDS or Aurora PostgreSQL, Azure Database for PostgreSQL
Flexible Server, DigitalOcean Managed PostgreSQL, or any PostgreSQL 13 or later) with `exprsn-ai db:move`, a guided,
resumable operation: a dry run, then backup, restore, a read-only window, `migrate --check` and the switch of
`DATABASE_URL`. The source may be SQLite, MySQL or PostgreSQL; the blob store stays where it is. The runbook with the
rollback is [runbooks/db-move.md](runbooks/db-move.md); the design is in [cloud.md](cloud.md#own-database-and-caches-b-10302-b-10305).

1. **The URL as a file.** The install must read its URL from a file (`DATABASE_URL_FILE`: a systemd credential, a
   Docker secret, a Kubernetes Secret file), since the switch rewrites that file. Move an inline `DATABASE_URL` to one
   first.
2. **The target.** An empty database with pgvector allowed (Azure: add `VECTOR` to `azure.extensions`), reachable from
   this host over its private endpoint, a user that owns the database. Size it for the connections:
   `DB_POOL_MAX × instances + 5` must fit in its `max_connections` less the reserved slots (RDS `db.t4g.medium` 450,
   Azure `Standard_B2s` 429, DigitalOcean `db-s-2vcpu-4gb` 97); lower `DB_POOL_MAX`, add a pooler or take a larger size
   otherwise.
3. **The CA bundle as a file.** RDS and Aurora: `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`.
   Azure: DigiCert Global Root G2 and Microsoft RSA Root CA 2017 in one file. DigitalOcean: the cluster's CA
   (Databases → the cluster → Download CA certificate, or `GET /v2/databases/<id>/ca`). The move connects with
   `sslmode=verify-full&sslrootcert=<file>` and refuses a connection that is not encrypted.
4. **The target URL in a file** (mode 0600), e.g. `postgres://exprsn:...@db.internal:5432/exprsn`.
5. **Dry run:** `exprsn-ai db:move --to /etc/exprsn-ai/target-url --ca-file /etc/exprsn-ai/rds-ca.pem --dry-run`. It
   prints every check (TLS, version, pgvector, empty target, connection budget, the URL file) and the window's
   estimate; it changes nothing. Pass `--instances <n>` when more instances will use the target than run now.
6. **The move:** the same without `--dry-run` (`--yes` to skip the prompt). The window opens: every instance refuses
   changes with `503 read_only_window` and the job queue waits; the backup is restored, verified (every row and
   `audit:verify` for every tenant on the target) and `migrate --check` must be clean before the switch. The window's
   bound is 30 minutes (`--window-minutes`); the dry run refuses a move estimated past it.
7. **Restart every instance**: they read `DATABASE_URL` at start. The old URL is kept as `<file>.previous`; the old
   database stays read-only for seven days (`--keep-old-days`).
8. **Check:** `/readyz`, `exprsn-ai audit:verify`, a conversation opened in the console. Then
   `exprsn-ai db:move --finish`; drop the old database when you are sure.

A crash mid-move resumes with `exprsn-ai db:move --resume` (each step is recorded as it finishes). `--status` shows
the open move. From the console the same move is asked for and approved by two platform cloud admins
(`/api/admin/cloud/db-moves`), the target URL and CA bundle given as vault references. For a deployment the console
made with a provisioned data tier, `--to <deployment>` takes the URL and CA bundle the deployment's database was wired
with.

## Sprint 42: the vault moves (1.7.0)

Three steps, deployable one at a time and in this order. Each has an expand-only migration that changes no existing
row; the previous build runs against the database after each. Nothing happens at start-up or at migrate time: each
step has one action an operator takes, and each action can be taken back. No step rotates or retires a platform key.

### Sessions and API keys as leases (migration `066_credential_leases`)

| | |
| --- | --- |
| Migration | Adds the nullable `api_keys.store_lease_id`. Sessions need no column |
| At start | Nothing. With `CREDENTIAL_STORE` unset or `table`, sessions and keys are made as before |
| The action | Set `CREDENTIAL_STORE=leases` and restart. From then on a new session is a lease (its cookie value starts `l1.`) and a new key is `exai_k2_...` |
| Check | An existing session still answers without signing in again. A new sign-in: no new row in `sessions`, one row in `vault_leases` with `kind = 'session'`. Signing out sets that row's `state` to `revoked`. A new key works as a bearer token, and revoking it ends its lease |
| Taking it back | Set `CREDENTIAL_STORE=table` and restart. Lease sessions and `exai_k2_` keys issued meanwhile stay valid until they end: both stores are always read |
| Previous build | Runs at any time. It does not read leases, so lease sessions are signed out and `exai_k2_` keys refused while it runs; rows of `sessions` and `exai_k1_` keys are unaffected. Nothing is lost: the newer build reads the leases again. A key revoked under the previous build has its lease ended when the newer build starts (and every 15 minutes while both run). A lease session the previous build could not see is not ended by a sign-out everywhere done under it: to go back for good, set `table`, wait `SESSION_ABSOLUTE_HOURS` (or end the sessions from Users) and only then run the previous build |
| No way back | None |

More than one server process needs Redis (as since Sprint 41): a revoked lease is dropped everywhere over the bus,
and otherwise within `VAULT_LEASE_CACHE_MS`.

### Signing keys as vault keys (migration `067_signing_key_registry`)

| | |
| --- | --- |
| Migration | Creates `vault_signing_keys`; adds the nullable `vault_transit_keys.custody` |
| At start | Nothing is registered |
| The action | `POST /api/vault/signing-keys/register` in each tenant (and `POST /api/admin/platform/vault/signing-keys/register` for the platform's own). It writes one row per key with the key's domain, id, backend and path. Then grant `list` (and `manage`, to rotate) on `transit/signing` under Policies |
| Check | `GET /api/vault/signing-keys` lists the keys with `backend` as each is held (`signer` when the signer made it). The JWKS, a SAML metadata document and a certificate chain are byte for byte what they were: no key changed |
| Taking it back | `DELETE /api/vault/signing-keys/:id` for each, or delete the rows of `vault_signing_keys`. The keys are untouched either way |
| Previous build | Runs; it ignores the table. A held transit key made in the meantime cannot sign under it |
| No way back | Rotating a key (from the vault or its own screen) is a rotation like any other: the previous key stays published for its overlap and is then gone. Registering does not rotate |

### Third-party credentials in the vault (migration `068_credential_refs`)

| | |
| --- | --- |
| Migration | Adds a nullable reference column beside each sealed credential (eight columns on seven tables) |
| At start | Nothing moves; every integration reads its sealed value |
| The action | `GET /api/vault/credential-moves` to see what is sealed outside the vault, then `POST /api/vault/credential-moves` (repeat while `remaining` is not 0). Per credential: the vault secret is written at `integrations/<kind>/<id>`, read back and compared, then the reference is recorded. A grant of read and write on `kv/integrations/<kind>` to the service `integration.<kind>` is made once per kind |
| Check | The counts show `sealed: 0`. A webhook delivery still verifies with its secret, a connection test still passes, a channel still signs. `failed` lists any row that was left as it was, with the reason |
| Taking it back | `POST /api/vault/credential-moves/restore`: the references are removed and the integrations read their sealed values, which were kept current. The vault secrets stay for an admin to destroy |
| Previous build | Runs at any time, before or after the move: it reads the sealed values. A credential changed under the previous build is not written to the vault, so the vault's copy goes stale: run `restore` before going back, or `restore` and move again after returning |
| No way back | None in this step. Removing the sealed values, after which only the vault holds them, is a later step and is not built |

Back up the database before each action, as before any change to how credentials are read.

## The PDS on the public network (1.7.0, B-11401)

What it takes for an account hosted here to be seen on the AT-Protocol network: the PLC directory, a relay that
crawls the PDS, and the public AppView that indexes what the relay passes on. Nothing here happens by itself:
`PDS_RELAYS` is empty unless set, so no relay is asked to crawl, and an account's `did:plc` is registered only
when a person creates the account. Each step below reaches services outside the site and leaves public records
(a DID in plc.directory, posts in the network's indexes), which cannot be fully taken back.

| Step | What to set or do |
| --- | --- |
| Public host | `PDS_PUBLIC_URL=https://pds.example.org`, served over HTTPS with a certificate the public trusts (ACME, above). The proxy passes `/xrpc/` and `/.well-known/atproto-did`, and WebSocket upgrades on `/xrpc/com.atproto.sync.subscribeRepos` (a relay holds that connection open) |
| Handles | `PDS_HANDLE_DOMAIN=example.org`, and per hosting tenant a wildcard DNS record `*.<tenant>.example.org` (A/AAAA, or a CNAME) pointing at the same service: a handle resolves over HTTPS at `https://<handle>/.well-known/atproto-did` |
| Zone and egress | `PDS_ZONE` names a zone with egress to the network (not `ZONES_AIR_GAPPED`). With `SERVICE_INTERNAL_ONLY`, list `plc.directory` and the relay hosts in `SERVICE_ALLOWED_HOSTS` |
| PLC directory | `ATPROTO_PLC_URL=https://plc.directory` (the default). A new account's genesis operation is signed by its rotation key in the signer and sent there |
| Relay | `PDS_RELAYS=https://bsky.network` (the value to use; the setting's default is empty). After a change the PDS sends `com.atproto.sync.requestCrawl` to each relay, at most every `PDS_CRAWL_MINUTES`; the admin route `POST /api/admin/pds/crawl` sends it at once |
| Backfill | `PDS_BACKFILL_HOURS` (72) is how far back a relay that reconnects with a cursor is replayed. A cursor older than what is kept, or below the oldest event the hourly trim left, is told `#info OutdatedCursor` and continues from the oldest event kept (defect F8, fixed in 1.7.0) |

**The check (B-11401's "done when").** Create a test account in a hosting tenant (AT-Protocol, PDS, accounts),
write a post as it (`com.atproto.repo.createRecord`, collection `app.bsky.feed.post`, or a cross-posted feed post,
B-11402), then:

1. `https://plc.directory/<did>` answers the account's DID document, naming `PDS_PUBLIC_URL` as `#atproto_pds`.
2. `https://<handle>/.well-known/atproto-did` answers the DID.
3. `POST /api/admin/pds/crawl` reports status 200 from each relay.
4. Within a few minutes `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=<did>` lists the post,
   and `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=<handle>` resolves the handle.

If step 4 does not list the post: the relay's view of the PDS is at
`https://bsky.network/xrpc/com.atproto.sync.getRepoStatus?did=<did>` (an `active: false` repo is not indexed), and
the PDS log names every `requestCrawl` answer. Deleting the test account afterwards
(`com.atproto.server.deleteAccount`) tombstones its repo for the relay; the `did:plc` stays in the directory.

## Platform operations

### Backups and restore drills

- The app backs up its own database into the blob store every `PLATFORM_BACKUP_MINUTES` (default a day; 0 turns it
  off), keeps the newest `PLATFORM_BACKUP_RETAIN` (14), and runs a restore drill every `PLATFORM_DRILL_MINUTES`
  (default a week) into a scratch SQLite file under `PLATFORM_DRILL_DIR` (default the OS temp dir; give it room for a
  copy of the database). Targets: `PLATFORM_BACKUP_RPO_MINUTES` (1 day) and `PLATFORM_BACKUP_RTO_MINUTES` (4 h).
- Each backup is encrypted with a key wrapped by the KMS key `<OPENBAO_KEY_PREFIX>platform-backups` and signed by
  it: keep `DATA_KEY` (local KMS) or the OpenBao transit keys backed up separately. Since Sprint 15 the dump is
  streamed and each backup also archives the blob store (`PLATFORM_BACKUP_BLOBS`); the archives live in the blob
  store under `platform/backups/`, so copy that prefix somewhere else (another bucket, offline media) to survive the
  loss of the store itself.
- Restore (Sprint 15): stop every instance, point the configuration at an empty database (and blob store), then run
  `exprsn-ai backup:restore --backup <id>`, adding `--from <dir>` when the backup files are in a copy of the blob store
  rather than the configured one (a directory holding `platform/backups/<id>.*`). It migrates the schema, checks the
  manifest signature, authenticates both archives in a first pass, restores every row in one transaction (foreign
  keys checked at commit), then writes the blob objects. A database that already has tenants, users or audit events is
  refused; `--force --confirm "replace all data"` empties it first. Start the instances afterwards.
- By hand: `exprsn-ai backup:create`, then `exprsn-ai backup:restore-drill [--backup <id>]` (exit code 2 on failure),
  for example from a systemd timer or before an upgrade.

### ACME certificates

- Set `ACME_DIRECTORY_URL` to the internal CA's ACME directory (https in production; `ACME_CA_FILE` for a private
  root), and optionally `ACME_CONTACT`. The CA validates http-01 by fetching
  `http://<name>/.well-known/acme-challenge/<token>` on port 80, so route port 80 for each certificate name to the
  app (the reverse proxy must pass `/.well-known/acme-challenge/` through without redirecting it to HTTPS or
  requiring authentication).
- Renewal runs every `ACME_CHECK_MINUTES` (6 h) and renews `ACME_RENEW_DAYS` (30) before expiry. Install renewed
  certificates with the deploy tooling: `GET /api/admin/platform/certificates/:id/chain` and the audited
  `POST …/key`, or set `ACME_CERT_DIR` and let the reverse proxy read and reload the files each instance writes there.
- dns-01 (Sprint 15), for wildcards or names the CA cannot reach on port 80: `ACME_CHALLENGE=dns-01` and either
  `ACME_DNS_PROVIDER=rfc2136` (a TSIG key allowed to update `_acme-challenge` TXT records in the zone, for example BIND
  `update-policy { grant acme-update. wildcard *.corp.internal. TXT; };`) or `ACME_DNS_PROVIDER=webhook` (an internal
  hook that verifies `X-Exprsn-Signature` and updates your DNS; see `docs/api.md`). Since Sprint 58 (B-10206) also
  `ACME_DNS_PROVIDER=route53`, `azure-dns` or `digitalocean` with `ACME_DNS_CLOUD_ACCOUNT` (a connected cloud account
  whose deploy credential may change the zone's TXT records) and `ACME_DNS_CLOUD_ZONE`; the CA may be public (with
  `ACME_EAB_*` when it asks) or the Exprsn-AI CA's own directory. Renewed certificates reach a cloud load balancer
  through the hook kinds `aws-acm`, `azure-appgw` and `do-lb` (see `docs/cloud.md`).
- Sprint 18: a CA that requires external account binding gets it from `ACME_EAB_KID` and `ACME_EAB_HMAC_KEY`. RFC 2136
  updates fall back to TCP (the TSIG key must be allowed over TCP too) and can find the zone from the SOA record.
  Certificates can have push hooks (Platform screen, Certificates, Hooks): a reload command from `ACME_RELOAD_COMMANDS`
  runs on every instance after the new files are written, and a signed webhook tells deploy tooling on another host;
  its secret is shown once and verifies `X-Exprsn-Signature` exactly like the DNS hook.

### Import bundles

- `PLATFORM_BUNDLE_REQUIRE_CHECKS=true` makes the scan and the staging deploy mandatory. Signer keys are under dual
  control: after the first, a second platform admin approves every added or revoked key on the Platform screen.
- `PLATFORM_TRIVY_BIN` (and `PLATFORM_TRIVY_CACHE_DIR` holding the offline vulnerability database) enables the scan;
  `PLATFORM_STAGING_URL` is an internal service that receives `{bundle, digest, contents, files}` and answers
  `{ok, detail}`. Mirror URLs, the staging hook and probes must resolve to internal addresses; `PLATFORM_ALLOWED_HOSTS`
  adds exceptions.
- Sprint 18: an image, npm or PyPI mirror can have a push target (Platform screen, Mirrors, Push target): after each
  promotion the files go to Harbor (an OCI registry: give the project and a robot account; images must be OCI image
  layout tars), Verdaccio (a token) or devpi (the `user/index` and a user's password) through their HTTP APIs. The
  target must be an internal host (`PLATFORM_ALLOWED_HOSTS` for others); the secret is stored sealed. Every file's
  outcome is listed on the bundle, and a push can be repeated.

### Backups (Sprint 18)

- The dump now reads one snapshot for the whole database (repeatable read on PostgreSQL and MySQL; on SQLite a read
  transaction on a second connection, which needs the default WAL mode), and the blob archive holds exactly the
  objects the snapshot's rows name (plus `mirrors/` and `training/staging/`, which no row names). An object written
  during the backup, or one with no row, is left out.

### Training worker (Sprint 18)

- The worker speaks contract 2 ([training-worker.md](training-worker.md)): rows are sent encrypted and it fetches the run key
  once from `TRAINER_CALLBACK_URL`; checkpoints and GGUF files are uploaded back and sealed under the tenant key. Route
  `/trainer/v1/` from the training zone to the app, require the worker's client certificate at the proxy and set
  `TRAINER_CLIENT_CERT_SHA256`. A contract-1 worker is refused unless `TRAINER_PLAINTEXT_FALLBACK=true`.

### Knowledge sources (Sprint 23)

- **S3-compatible buckets.** A source can name its own endpoint (MinIO, Ceph, another account's S3) with an access key
  that is sealed with the tenant key; include patterns (`**/*.md`) narrow the prefix. Endpoints outside the internal
  network need `KNOWLEDGE_ALLOWED_HOSTS` (for AWS, e.g. `*.amazonaws.com`).
- **Internal web sites.** The crawler sends `User-Agent: ExprsnAI-Knowledge/1.0`, so a site can give it its own
  robots.txt group. It stays on the start page's scheme, host and port, follows robots.txt and the sitemap, and
  re-checks pages with `If-None-Match`/`If-Modified-Since`. A robots.txt that answers 5xx or not at all stops the crawl
  (the site is treated as closed); a missing one (4xx) allows everything.
- **Public web sites, their images and their changes.** A site outside the internal network is crawled only when
  `KNOWLEDGE_ALLOWED_HOSTS` names its host; the list is the operator's statement of which outside sites are
  reputable enough to index. With `media` a source also fetches the pictures of its pages, from the site itself or
  from another host the list names (a site's image host, such as `upload.wikimedia.org`), and the base's vision
  profile writes a caption and reads the text in each: a small vision or OCR model is enough, and every picture is
  one model call, so `maxMedia` bounds what a sync costs. With `changes` each sync after the first records the pages
  it found new, changed and gone, with the line diff of the text (`GET /api/knowledge/bases/:id/changes`, the tool
  `knowledge_changes`).
- **Row security through PostgreSQL roles.** A PostgreSQL source can map directory groups to database roles; each
  sync reads the table once per role inside a read-only transaction under `SET LOCAL ROLE`, so the table's row
  security policies decide which group retrieves which row. The database owner sets it up once:

  ```sql
  ALTER TABLE notices ENABLE ROW LEVEL SECURITY;            -- FORCE as well if a mapped role owns the table
  CREATE ROLE kb_finance NOLOGIN;                            -- one role per group, never superuser or BYPASSRLS
  CREATE POLICY finance_rows ON notices FOR SELECT TO kb_finance USING (region IN ('finance', 'all'));
  GRANT SELECT ON notices TO kb_finance;
  -- The connection's login: a member of each mapped role, without inheriting it (PostgreSQL 16+), and SELECT on the
  -- table only so that schema introspection lists it; no policy names the login, so it reads no rows by itself.
  GRANT kb_finance TO exprsn_reader WITH INHERIT FALSE;
  GRANT SELECT ON notices TO exprsn_reader;
  ```

  The server refuses a mapping when the role does not exist, the login is not a member, the role is a superuser or
  has BYPASSRLS, the role may not select the table, the table does not enable row security (or a mapped role owns it
  without FORCE), or the object is a view that is not `security_invoker` (PostgreSQL 15+). With OpenBao dynamic
  credentials, put the `GRANT … TO "{{name}}" WITH INHERIT FALSE` in the role's creation statements. Role-mapped
  sources sync by full reads (up to 5000 rows per role) and cannot use logical replication, which bypasses policies.

### Webhooks and billing (Sprint 23)

- Ordered webhooks now take their positions from a counter row per endpoint (`webhook_order`) and send under a lease
  in that row, so several instances deliver one endpoint's events strictly in order, one at a time. A lease outlives a
  crashed holder by `WEBHOOK_TIMEOUT_MS` plus 30 seconds.
- Price book changes can take effect from an earlier moment of the current month; the month's statement is prorated
  by the prices in effect when each usage record was written. Subscribe the Stripe endpoint also to `charge.refunded`,
  `credit_note.created`, `credit_note.updated`, `credit_note.voided`, `charge.dispute.created`,
  `charge.dispute.updated` and `charge.dispute.closed` to reconcile refunds, credit notes and disputes.
