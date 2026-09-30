# Incident response

How to classify an incident, what to do in the first fifteen minutes, and the containment steps Exprsn-AI offers:
revoking sessions and API keys, rotating secrets and keys, disabling a tenant, preserving the audit chain, blocking
content with a guardrail, and taking an Ollama instance out of service.

In the commands, `exprsn-ai <command>` is the server's CLI with the same environment and secrets as the server:
`docker compose exec app node server/dist/cli.js <command>` (Compose),
`kubectl exec deploy/exprsn-ai -- node server/dist/cli.js <command>` (Kubernetes), or on bare metal the command line
the installer prints (`node /opt/exprsn-ai/server/dist/cli.js` run as `exprsn-ai` with the credential files). Its
commands are `migrate`, `admin:create`, `audit:verify` and `kms:rotate`. Console paths name the screens; the matching
API routes are in [api.md](../api.md) and [identity.md](../identity.md).

## Severity

| Level | Examples | Response | Who is told |
| --- | --- | --- | --- |
| **SEV1** | Confirmed access to another tenant's data; `DATA_KEY`, OpenBao token or database credentials exposed; audit chain broken; sealed data readable by someone not cleared | Immediately, around the clock. Incident lead named within 15 minutes | Security officer, platform owner, affected tenants' administrators; regulators and customers per contract and law |
| **SEV2** | An account or API key taken over; a guardrail bypass producing restricted content; an admin acting outside policy; a whole Ollama pool down | Within 1 hour, around the clock | Security officer, platform owner, affected tenant administrators |
| **SEV3** | One instance unhealthy; elevated error rates; a guardrail false-positive storm; a failed directory sync | Within 1 business day | Platform team |
| **SEV4** | A single user's problem with no data exposure | Normal queue | The user |

Raise the level as soon as evidence points to data leaving a tenant or a clearance boundary. Lower it only after the
incident lead agrees.

## First 15 minutes

1. **Name an incident lead** and open an incident record (ticket or channel). Write every action with its time there;
   the audit chain records what the server did, the record says why.
2. **Preserve evidence before changing anything that destroys it.** Note the time window, the tenants, users and
   trace ids involved (every error response and log line carries the trace id). Save logs from the window (JSON on
   stdout: `docker compose logs app`, `journalctl -u exprsn-ai`, `kubectl logs`). Do not restart instances just to
   clear symptoms: a chat stream in progress is lost on restart.
3. **Verify the audit chain** for each affected tenant and keep the output:
   `exprsn-ai audit:verify --tenant <slug> | tee audit-verify-<slug>-$(date +%FT%H%M).json`. Exit code 2 means the
   chain or a signed checkpoint is broken; that alone is SEV1.
4. **Contain** with the narrowest step that stops the harm (next sections): revoke a session, disable a user, block
   a pattern, drain an instance, disable a profile, disable a tenant. Prefer steps that can be undone.
5. **Decide on escalation** with the severity table, and send the first notice (template at the end).

## Sessions and API keys

| Scope | Action | Effect |
| --- | --- | --- |
| One session | Admin > Identity, the user's sessions, "Revoke session" (`DELETE /api/admin/sessions/:id`) | The session ends; its sockets close at once on every instance |
| One user | Admin > Identity, the user, disable (`PATCH /api/admin/users/:id {state: disabled}`) | Every session revoked and every API key revoked; sign-in refused. A disabled user in LDAP or SQL stays disabled here until re-enabled |
| One user's factors | Admin > Identity, the user, reset second factors (`POST /api/admin/users/:id/reset-mfa`) | Factors removed and sessions revoked; the user enrols again at next sign-in. Use when a factor may have been enrolled by someone else |
| Role or clearance change | Admin > Identity, the user (roles, clearance) | Sessions revoked so the change applies at the next request |
| Own sessions and keys | Personal settings, "Sign out other sessions"; Personal settings, API keys, revoke | For a user who suspects their own account |
| Everyone, all tenants | Rotate `SESSION_SECRET` (below) | Every session, API key and recovery code becomes invalid |

In a directory-backed tenant, also disable the account in the directory, or JIT provisioning brings access back at the
next sign-in with the directory's groups.

## Rotating secrets and keys

### `SESSION_SECRET`

`SESSION_SECRET` keys session ids, CSRF tokens, API-key digests and recovery-code digests. Rotate it when it may have
been exposed. There is no overlap period: all sessions end, every API key stops working and must be reissued, and
every user's recovery codes must be regenerated (Personal settings, second factors).

```sh
openssl rand -hex 32 > session_secret.new
# Compose:     replace deploy/docker/secrets/session_secret.txt, then: docker compose up -d app
# Bare metal:  install -m 0600 session_secret.new /etc/exprsn-ai/credentials/session_secret && systemctl restart exprsn-ai
# Kubernetes:  kubectl create secret generic exprsn-ai --from-file=session_secret=session_secret.new \
#                --from-literal=... --dry-run=client -o yaml | kubectl apply -f -   (keep the other keys)
#              kubectl rollout restart deploy/exprsn-ai
```

Every instance must get the new value in the same change; an instance still on the old value rejects the new
sessions.

### Tenant data keys: `exprsn-ai kms:rotate`

```sh
exprsn-ai kms:rotate --tenant <slug>
```

Starts a new version of the tenant's data key. New content is sealed with it; content sealed earlier stays readable
with the older versions, which remain in the database (wrapped by the key-encryption key). The rotation is written to
the tenant's audit chain as `kms.key.rotated`. Use it when a copy of the database may have been taken: content written
after the rotation cannot be opened with that copy, even together with the key-encryption key.

### `DATA_KEY` (local KMS) and OpenBao keys

`DATA_KEY` is the key-encryption key of the local KMS: every tenant's data keys are wrapped with keys derived from it,
and audit checkpoints are signed with it. Replacing it in place makes every existing data key unreadable, and the
server has no command in this release that re-wraps the data keys under a new `DATA_KEY`. Switching `KMS_PROVIDER`
has the same effect. So:

- If `DATA_KEY` alone is exposed (no database copy): treat as SEV1, restrict who can reach the database and its
  backups, rotate the database credentials, and run `kms:rotate` for every tenant so that newer content does not
  depend on data keys that may be copied later.
- If `DATA_KEY` and a database copy are exposed together: all sealed content up to that copy must be treated as
  disclosed. Notify per the severity table. `kms:rotate` for every tenant limits the disclosure to content sealed
  before the rotation.
- Plan a re-wrap or a migration to OpenBao with the maintainers before changing `DATA_KEY`.

With OpenBao, rotate a transit key in OpenBao (`bao write -f <mount>/keys/<prefix>tenant-<tenant id>/rotate`); keys the
server wraps afterwards (for example by a `kms:rotate`) use the new version, and older versions keep decrypting until
you raise `min_decryption_version`. Revoke an exposed OpenBao token in OpenBao, issue a new one with the same policy,
and replace `OPENBAO_TOKEN` (restart the instances).

### Other credentials

Database URL, Redis URL, S3 secret, SMTP URL, SIEM token and metrics token: rotate at the source, replace the secret
file or Kubernetes Secret, restart the instances. LDAP bind passwords and SQL store connection strings are read at use
time (`file:` and `env:` references in the identity YAML), so a new `file:` value needs no restart. MCP server
credentials are rotated in Admin > MCP servers.

## Disabling a tenant

A system admin sets the tenant's state to disabled (Admin > Tenants, or `PATCH /api/admin/tenants/:tid
{state: disabled}`; no one can disable their own tenant). Every request from that tenant's sessions and API keys is then
refused, because the tenant's state is checked each time a request is authenticated. To close live connections at the
same moment, also revoke the tenant's sessions (Admin > Identity, sessions) or disable its users. Re-enabling restores
access; nothing is deleted.

**Offboarding is not containment.** `POST /api/admin/tenants/:tid/offboard` destroys the tenant's keys
(crypto-shredding), revokes every session and key and queues the purge. It cannot be undone and destroys evidence.
Use it only when the tenant is leaving and the incident record is closed.

## Audit: verification and forensics

- **Verify**: `exprsn-ai audit:verify --tenant <slug>` (or Admin > Usage and audit, "Verify chain"). The output names the first
  broken row (`brokenAt`), the last good checkpoint and whether the administrators were notified. Signed checkpoints are
  also stored in the blob store under `audit-checkpoints/<tenant id>/`, outside the database, so tampering with the
  database cannot rewrite them.
- **Export for forensics**: Admin > Usage and audit, filter by time window, actor or action, then export (a CSV job; exports
  above the exporter's clearance are refused unless filtered). Download the file, record its SHA-256 in the incident
  record (`sha256sum`), and keep it in the evidence store. The SIEM stream (`SIEM_URL`) holds an independent copy of
  every event since it was turned on.
- **Correct, never edit**: mistakes in the record are fixed with correction rows (Admin > Usage and audit, the event, a
  correction), which append to the chain. Never change audit rows in the database: the chain breaks and
  `audit:verify` reports it.
- **Database snapshot**: for SEV1, take a database dump and a blob copy now (see [backup-restore.md](backup-restore.md))
  and keep them with the evidence, separately from `DATA_KEY`.

## Guardrail emergency block

To stop a prompt, answer or tool call pattern in one tenant at once:

1. Admin > Guardrails, the tenant's rule set, add a rule to the draft: the checkpoint (`user-input`, `model-output`,
   `tool-call`, `context`...), a mechanism (an RE2 `pattern`, a `pii` or `secrets` detector, or a `meta` value such as
   a tool name) and the action `block`. Test it on sample text first ("Test", `POST /api/admin/guardrails/test`).
2. New rules start in shadow. Promote it to enforce (`POST /api/admin/guardrails/sets/:id/promote {ruleId}`) and publish
   the draft (`POST /api/admin/guardrails/sets/:id/draft/publish`). Checks use the published set from the next request.
3. For every tenant at once, the rule belongs in the platform baseline, which publishes only when a second platform
   guardrail admin approves (dual control). Page the second approver as part of the incident.

When the threat is one model or profile rather than a pattern, disable the profile instead (Admin > Profiles,
`POST /api/admin/profiles/:id/publish {status: disabled}`): chats can no longer choose it, and fallbacks still apply.

## Taking an Ollama instance or pool out

- **One instance**: Admin > Pools, the instance, "Drain" (`POST /api/admin/instances/:id/drain`). The gateway stops
  routing to it, waits for its running requests to finish, and unloads its models. "Undrain" returns it to service.
  To stop it at once without waiting, disable it (`PATCH /api/admin/instances/:id {state: disabled}`).
- **A whole pool**: drain or disable each instance. Profiles on that pool then fail or use their configured fallback,
  so check that fallbacks point at a pool whose label ceiling still fits.
- **A suspected tampered model**: disable the profiles that use it, drain the instances that hold it, and compare the
  model's digest with the approved digest (Admin > Models). The Ollama nodes sit on an internal network only; if a node
  is suspected compromised, isolate it at the network level too.

## Closing

- Confirm containment held for at least one full business cycle.
- Undo temporary blocks that are no longer needed (drained instances, disabled profiles, emergency rules), each with an
  audit reason.
- Run `audit:verify` for every affected tenant again and attach the output.
- Write the review within five business days: timeline, root cause, what worked, what did not, and follow-up actions
  with owners.

## Communication template

```
Subject: [SEV<n>] Exprsn-AI incident <id>: <short description>, <status: investigating | contained | resolved>

What happened:   <one or two sentences, facts only>
When:            first seen <UTC time>; contained <UTC time or "not yet">
Who is affected: <tenants / workspaces / users, or "no customer data affected">
Data involved:   <none | labels involved (public, internal, confidential, restricted) | unknown, being assessed>
What we did:     <containment steps, for example "revoked sessions for 3 accounts, disabled profile X">
What you should do: <for example "sign in again", "reissue API keys", "no action needed">
Next update:     <UTC time>
Contact:         <incident lead, channel>
```

Send updates at the stated time even when there is nothing new; say so.
