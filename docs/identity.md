# Identity: user stores, sign-in and access

## User stores

Each tenant has an ordered chain of user stores. A store is one of:

| Kind | Where users live | Notes |
| --- | --- | --- |
| `ldap` | OpenLDAP or any LDAPv3 directory | Service bind → search with `userFilter` → bind as the user → groups by search (`member`, `uniqueMember`, `memberUid`) or `memberOf`. LDAPS or StartTLS; `allowInsecure` only outside production |
| `sql` + `dialect: pg` | a user table in PostgreSQL | Column names from configuration; values always bound as parameters |
| `sql` + `dialect: mysql` | a user table in MySQL / MariaDB | Same adapter |
| `sql` + `dialect: sqlite` | a user table in a SQLite file | Opened read-only |
| `local` | the application database | Bootstrap and break-glass accounts, created with `exprsn-ai admin:create` or in the console |
| `ad` | Windows Active Directory (1.9.0) | LDAPS or StartTLS only; sAMAccountName or userPrincipalName sign-in, nested groups, objectGUID links, AD account flags and bind codes, domain controllers from DNS. See [Active Directory](#active-directory-190-b-182) |
| `oidc` | an upstream OpenID Connect provider (we are the relying party) | Sign-in by redirect; no passwords. No directory sync unless the store has a directory pull (Microsoft Graph, Google Directory API; 1.9.0). See [Upstream federation](#upstream-federation) and [Cloud directory presets](#cloud-directory-presets-190-b-183) |
| `saml` | an upstream SAML 2.0 identity provider (we are the service provider) | Same; signed assertions only |
| `atproto` | AT-Protocol accounts (we are an OAuth client of each account's own authorization server; 1.4.0) | Sign-in by redirect after the person gives their handle; a DID bound to a user signs in as that user, others are provisioned with their DID as their only group. See `docs/api.md`, Sprint 26b |
| `exprsn-platform` | Exprsn platform accounts (1.9.0) | Sign-in by redirect to the platform's OAuth 2.0 server (code with PKCE); platform organisations and roles become groups. See [Exprsn platform accounts](#exprsn-platform-accounts-190-b-184) |
| `scim` | users and groups pushed by an identity provider (Entra ID, Okta) over SCIM 2.0 (1.6.0) | No passwords and no directory sync: the provider creates, changes and deprovisions users at `/scim/v2`; they sign in through the upstream stores the SCIM store names. See [SCIM 2.0 provisioning](#scim-20-provisioning) |

SQL stores accept **argon2** and **bcrypt** hashes. Rows with any other format (plain text, unsalted digests) never
authenticate. Give the store a database account with `SELECT` on the user and group tables only.

Groups for SQL stores come from a column on the user row (comma-separated or a JSON array), a separate table
(`groupTable`), or both.

### Chain rules

Stores are asked in `position` order (lowest first):

1. The store does not know the username → ask the next store.
2. The store knows the username and the password is wrong, or the account is disabled there → **stop**. A password
   is never tried against a second store.
3. The store cannot be reached or is misconfigured → skip it, record the error in the audit event, and continue.

When no store knows the user, the server still spends the time of a password check, so response time does not
reveal whether an account exists. Every failure returns the same message and counts toward lockout.

### Secrets

Configuration never contains secret values. Use references:

- `env:NAME` reads an environment variable of the server process;
- `file:/absolute/path` reads a file (a Docker secret, systemd credential, or mounted vault file) at use time, so
  rotating it needs no restart.

Tenant admins write these references, so the operator decides what they can reach:

- an `env:` name must be on `SECRET_REF_ENV` (names or `PREFIX*` patterns; empty by default, so no `env:` reference
  works until the operator lists some);
- a `file:` path must resolve, following symlinks, inside one of `SECRET_REF_DIRS` (by default `/run/secrets`,
  `/run/credentials` and `/etc/exprsn-ai/credentials`);
- the server's own settings (`DATA_KEY`, `DATABASE_URL`, `SESSION_SECRET` and every other variable in
  [deploy.md](deploy.md), with their `_FILE` forms) and the files those `_FILE` variables name are never readable,
  whatever the lists say.

A reference that breaks these rules is refused when the store is saved and again when it is read.

LDAP directories and the databases behind SQL stores must resolve to internal addresses unless
`IDENTITY_ALLOWED_HOSTS` names them; the host is checked before every connection, before any password is sent. A
SQLite store can never be the application's own database.

### Managing stores

- **In the console:** Admin → User stores. Add, edit, reorder, enable or disable, and test the connection. "Test a
  login" runs the real chain for a username and password, shows each step, the groups returned, and the roles and
  clearance they would map to, without creating a session.
- **In a file:** `IDENTITY_CONFIG=/etc/exprsn-ai/identity.yaml` (see
  [`deploy/config/identity.example.yaml`](../deploy/config/identity.example.yaml)). Stores declared there are
  applied at every start and marked "managed by config"; the console can test, reorder and enable or disable them,
  but not edit them.

The last enabled store of a tenant cannot be disabled or removed.

### The store wizard and form editor (1.9.0, B-181)

"Add user store" opens a wizard: **kind or preset**, **connection**, **attributes and groups** (with the store's first
group mappings), **sign-in order**, **test with a real account**, **review**. Every form is generated from the kind's
zod schema by the kind registry (`server/src/identity/providers/kinds.ts`, `GET /api/admin/identity-store-kinds`), so a
new kind (Active Directory, the cloud presets, Exprsn platform accounts) needs no console change: a kind registers
`{ kind, title, description?, config (zod), schema (sections per step, field labels and help), presets?, signIn,
platform?, test(config, credentials, ctx) }`. Fields the layout does not place appear under "Other settings"; a field
whose schema is `secretRef` takes a reference (`vault:path#key`, `env:NAME`, `file:/path`), never a value. Each step
is checked by the server (`POST …/identity-store-kinds/<kind>/check` with `step`). The test signs in as the account
(or only looks it up without a password) through an uncached provider built as the chain would build it
(`IdentityChain.probe`): the password goes to the store for that one call, is never stored, logged or audited (the
username is), and counts toward the account's lockout. Saving with `test: { username }` ("test before save") refuses
the store with 409 when it cannot connect or find the account. Editing an existing store opens the form editor (Form,
JSON as the advanced view, and Versions).

**Versions** (migration `140_identity_store_state`): every saved change (create, edit, order, archive, restore) is a
numbered version with the reason given, who and when, in `identity_provider_versions`; the Versions tab shows each one
with its diff against the one before. Configurations hold references only, so a version is safe to show.

### Archiving and restoring a store (1.9.0, B-185)

**Archive** (`POST /api/admin/identity-providers/:id/archive`, a recent sign-in needed) sets the store `archived` and
`enabled = false` together, so the sign-in chain, directory sync, the redirect sign-in options and SCIM all leave it
out (even a build that does not know the state). Its users keep their accounts; anyone with another way in (a local
password, another store) still signs in that way. Optionally the sessions started through it end at once, and the API
keys of users who have no other store are revoked. Its configuration, group mappings and identity links stay,
read-only (changing or enabling it is refused with 409), and it is listed under "Archived". **Restore** puts it back as
it was before (enabled or disabled), or disabled for review when asked (`to: disabled`). The local store (the
break-glass way in), a store managed by the configuration file and the only enabled store cannot be archived. Audited
`identity.store.archived` and `identity.store.restored`. Removing a store needs it archived first and a retention
period passed (below, 1.9.9-qa); without migration 142 it works as before.

### Store backups (1.9.0, B-186)

A backup of one store (`POST /api/admin/identity-providers/:id/backups`) is an `exprsn-store-backup/1` archive: the
store, all its configuration versions (secrets stay references), its group mappings (workspaces by name), its identity
links with the linked accounts' names and state, and for `local` and `sql` stores the accounts' second factors, plus
for `local` their password hashes. The payload is sealed with a fresh AES-256-GCM key wrapped by the KMS under
`<OPENBAO_KEY_PREFIX>identity-store-backups`, and the archive is HMAC-signed by the KMS under the same name: it opens
only on this installation (any of its tenants), and a changed byte, another key or another installation's signature is
refused (422, audited `identity.store.backup.refused`). It is downloaded, or saved to the blob store
(`identity/store-backups/<tenant>/<id>.json`, listed in `identity_store_backups`, migration `141_identity_store_backups`;
without it, saving answers 503 and a download still works).

**Restore** (`POST /api/admin/identity-store-backups/restore`, a recent sign-in needed) goes into the restoring admin's
own tenant: into the same store (by id in the same tenant, else by name and kind; the local store for a local backup)
or as a new store, which starts disabled. `dryRun` (the default) lists every change and makes none. A mapping whose
role is not in this tenant, that the admin cannot grant, above their clearance or naming a missing workspace is skipped
and listed; vault references must be readable by the admin, as when saving by hand. Missing accounts are created only
for `local` and `sql` stores (others link again at their next sign-in); existing passwords, factors and links are never
overwritten; TOTP and email factors are re-sealed for their new ids; recovery codes come back only into the same
account (they are bound to its id); directly granted roles are not carried. Audited `identity.store.backup.created`,
`.downloaded`, `.deleted`, `.restore_previewed`, `.restored` and `.refused`.

**Large backups** (1.9.9-qa): `PUT /api/admin/identity-store-backups/upload` takes the backup file itself as the raw
body (the API's 256 kB JSON limit does not apply; at most 50 MB, larger answers 413), streams it to the blob store,
checks its format, signature and seal and keeps it as a saved backup with origin `upload` (audited
`identity.store.backup.uploaded`; a refused file is audited `.refused` and nothing is kept). It is then previewed and
restored by id like any saved backup. The console's "Restore from a file" uses it whenever saved backups are available.

### Store governance (1.9.9-qa, Sprint QA-1)

Migration `142_identity_store_governance` (`identity/store-governance.ts`, routes in
`routes/admin/identity-store-governance.ts`, the console's User stores › Governance tab). Without it every feature here
answers 503 `migration_pending` and stores are changed, restored and removed as before.

- **Dual control.** A change of a store's connection or attribute configuration (`PATCH …/identity-providers/:id`
  with a `config` that differs), restoring a backup (`dryRun: false`), purging an archived store and turning dual
  control off become proposals (`identity_store_proposals`) that a second identity admin approves
  (`POST /api/admin/identity-store-proposals/:id/approve`, a recent sign-in needed, `platform:manage` too for a platform
  store). The answer is `202` with the proposal (and, for a restore, the dry run). The proposer cannot approve (403,
  `step: dual-control`) or reject; they can withdraw. A configuration proposal whose store changed since is closed as
  `superseded` (409 `stale`), never applied over the newer change. An inline archive restored under dual control is
  first kept as an uploaded backup, so the approver restores the same bytes. The name, sign-in order and enabling or
  disabling a store stay single-admin. One pending proposal per kind and store. The other identity admins are notified;
  the proposer hears the decision. Audited `identity.store.proposal.created`, `.approved`, `.rejected`, `.withdrawn`,
  `.superseded`, and the applied change under its own action (`identity.provider.updated`,
  `identity.store.backup.restored`, `identity.store.purged`, `identity.store.settings.updated`) with the proposal id.
- **The setting** (`GET`/`PUT /api/admin/identity-store-governance`, a recent sign-in to change): `dualControl` is
  `auto` (the default: on when the tenant has two or more active identity admins, else off, with a warning on the
  screen), `on` or `off` (for single-admin installations). Turning it off while it is in force is itself a proposal.
  `purgeAfterDays` (1 to 3650, default 30) applies at once.
- **Purge.** An archived store may be removed only `purgeAfterDays` after it was archived
  (`POST /api/admin/identity-providers/:id/purge`, or `DELETE …/identity-providers/:id`, a recent sign-in needed).
  Earlier, or a store that is not archived, answers 409 with `purgeableAt` and the date in the detail. Its identity
  links (the accounts stay and lose that store's identity), group mappings, versions, backup schedule and pending
  proposals go; saved backups are kept. Audited `identity.store.purged`.
- **Scheduled backups** (`GET`/`PUT`/`DELETE /api/admin/identity-providers/:id/backup-schedule`, `…/run` for one now as
  a job): daily or weekly, keeping a count (`keepCount`, default 7) and/or an age (`keepDays`). The Scheduler queues
  `identity.store.backups.due` every 15 minutes for each tenant with a due schedule (claimed once across instances);
  each run saves a backup with origin `schedule` and prunes the store's scheduled backups beyond the count or older
  than the age, never the newest; backups made by hand or uploaded are not pruned. A failure is recorded on the
  schedule, audited `identity.store.backup.failed` and notified to every identity admin. Audited
  `identity.store.backup.created` (system actor), `.pruned`, `.schedule.updated`, `.schedule.removed`.
- **CSV export of a store's users** (`POST /api/admin/identity-providers/:id/users-export`, `identity:manage` and
  `users:manage`): the accounts linked to the store with username, display name, email, state, the store's groups and
  last sign-in; never password hashes, factors or keys. Accounts above the requester's clearance are left out and
  counted (`X-Omitted`). Up to 1,000 accounts it is the response; above that (or with `job: true`) the job
  `identity.store.users.export` writes it sealed under the tenant key to the blob store, and only the requester
  downloads it (`GET /api/admin/identity-store-exports/:jobId`). Audited `identity.store.users.exported` and
  `.export_requested`.

### Active Directory (1.9.0, B-182)

The kind `ad` (`server/src/identity/providers/ad.ts`) is an LDAP store with Active Directory's rules:

- **Domain controllers** come from `urls` (tried in order) or, when it is empty, from DNS SRV records of `domain`:
  `_ldap._tcp.<site>._sites.<domain>` first when `site` is set, then `_ldap._tcp.<domain>`; with `globalCatalog`,
  `_gc._tcp` and port 3269 (LDAPS) or 3268 (StartTLS) for a forest of several domains. Records are cached for five
  minutes and ordered as RFC 2782 says, drawn again every time: lowest priority first, and within a priority a
  weighted-random draw (a record of weight 60 beside one of 30 and one of 10 is first about 60% of the time; weight 0
  only on a draw of 0 or when it is the last left; a target of `.` is skipped). The controller that answered last is
  tried first, and an unreachable one fails over to the next. Each host is checked against `IDENTITY_ALLOWED_HOSTS` as for LDAP.
- **TLS only:** LDAPS, or `ldap://` with `startTLS: true`, with the certificate verified (`caFile` for a private CA).
  A plain `ldap://` URL without StartTLS is refused when saved and when the store is built, in development too
  (there is no `allowInsecure`).
- **Sign-in name:** `signInAttribute` `either` (default: `sAMAccountName`, also typed as `DOMAIN\name`, or
  `userPrincipalName`), `sAMAccountName` or `userPrincipalName` (a bare name gets `@<domain>`), ANDed with
  `userFilter` (default `(&(objectCategory=person)(objectClass=user))`). The username here is the sAMAccountName or
  the UPN (`usernameFrom`; in a forest, only the UPN is unique).
- **The link is `objectGUID`** as GUID text (`01234567-89ab-cdef-0123-456789abcdef`), which survives renames and
  moves; directory sync looks the account up by it (`lookupById`), so a renamed account stays the same account.
- **Groups:** with `nestedGroups` (default), a paged search (`pageSize`, default 500) under `groupBase` (default
  `baseDN`) for `(member:1.2.840.113556.1.4.1941:=<user DN>)`, so groups inside groups count, at most `maxGroups`;
  otherwise the direct `memberOf`. Named by DN (default, unique) or cn (`groupNameAttribute`).
- **Large `memberOf` (1.9.9-qa):** with nesting off, an account in more groups than AD's MaxValRange (1,500 by
  default) gets `memberOf;range=0-1499` back; the rest is read with base searches for `memberOf;range=<next>-*` until
  a range ends in `*`, at most `maxGroups` values (the step "Read memberOf by range" says how many in how many ranges).
- **The primary group (1.9.9-qa):** `primaryGroupID` (513, Domain Users, for most accounts) is in neither `memberOf`
  nor the in-chain search. With `primaryGroup` (default on), its SID (the account's `objectSid` with the last
  sub-authority replaced by `primaryGroupID`) is looked up under the account's own domain (its DN's `DC=` part, which
  with the Global Catalog may not be `baseDN`) and the group is one of the account's groups, named as the others,
  so a mapping can name `CN=Domain Users,CN=Users,DC=…`. Found groups are cached for five minutes; a primary group
  that cannot be read is a step in the test, never a refused sign-in. Groups the primary group itself belongs to are
  not followed.
- **Account state**, before any password is sent: disabled (`userAccountControl` 0x2), locked
  (`msDS-User-Account-Control-Computed` 0x10, or `lockoutTime` when that is absent) and expired (`accountExpires`) are
  refused as disabled. After the right password: "must change at next logon" (`pwdLastSet` 0) and an expired
  password (the computed 0x800000 bit or `msDS-UserPasswordExpiryTimeComputed`, unless `DONT_EXPIRE_PASSWORD`) are
  refused too. The bind codes in AD's error (`data 52e` wrong password, `525`, `530`, `531`, `532` password expired,
  `533` disabled, `701` account expired, `773` must change, `775` locked) are read the same way.
- **Words:** an expired password, a password that must change and an expired account are told to the person in
  words (403 with `reason` `password_expired`, `must_change` or `account_expired`), since they come only after the
  right password; a locked or disabled account gets the usual "invalid username or password" (the audit's
  `auth.login.failed` carries `refusal`). The admin's test steps show every reason.
- **Directory sync:** a disabled or expired account reads as gone (the user is disabled, with the safety stop); a
  locked one is still there.

Presets: one domain from DNS, a forest through the Global Catalog, and named domain controllers.

### Cloud directory presets (1.9.0, B-183)

Presets fill a kind's form (endpoints, scopes, claim and attribute names, how groups are named) and can be edited
afterwards; the upper-case words (`TENANT-ID`, `YOUR-ORG`, `REALM`) are what only the admin knows. They are
registered in `server/src/identity/providers/store-kinds.ts` on the existing kinds:

| Provider | Kind | Preset | Notes |
| --- | --- | --- | --- |
| Microsoft Entra ID | `oidc` | `entra-id` | v2.0 issuer, `preferred_username`, link by `oid`; users and groups from Microsoft Graph |
| Microsoft Entra ID | `scim` | `entra-id-scim` | SCIM push; name the Entra sign-in store |
| Google Workspace | `oidc` | `google-workspace` | username `email`; users and groups from the Admin SDK Directory API |
| Google Workspace | `scim` | `google-workspace-scim` | Google pushes SCIM only to apps in its catalogue; the OIDC preset is the usual one |
| Okta | `oidc`, `saml`, `scim` | `okta`, `okta-saml`, `okta-scim` | default authorization server; a `groups` claim or attribute |
| Keycloak | `oidc`, `saml`, `scim` | `keycloak`, `keycloak-saml`, `keycloak-scim` | a realm; a group membership mapper named `groups` |
| Authentik | `oidc`, `saml`, `scim` | `authentik`, `authentik-saml`, `authentik-scim` | its default property mappings |
| FreeIPA | `ldap` | `freeipa` | `cn=users,cn=accounts`, groups under `cn=groups,cn=accounts` by cn |
| 389 Directory Server | `ldap` | `389ds` | `ou=People`, `groupOfUniqueNames` or `groupOfNames` under `ou=Groups` by cn |

**The directory pull.** An `oidc` store may carry `directory` (`server/src/identity/providers/cloud-directory.ts`):

- `api: msgraph`: `tokenUrl` (`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`), `apiUrl` (default
  `https://graph.microsoft.com/v1.0`), `clientId` and `clientSecret`; the **client credentials grant** with scope
  `https://graph.microsoft.com/.default` (the app needs `User.Read.All` and `GroupMember.Read.All`). A user by id or
  userPrincipalName; their groups by `transitiveMemberOf` (nested included, `@odata.nextLink` followed on the API's
  own origin only), by `displayName` or `id`, optionally security groups only.
- `api: google`: `serviceAccount` (the JSON key) and `subject` (the admin it acts as, domain-wide delegation),
  `tokenUrl` (default `https://oauth2.googleapis.com/token`), `apiUrl` (default
  `https://admin.googleapis.com/admin/directory/v1`), `customer` (default `my_customer`); a signed RS256 assertion
  (RFC 7523 JWT bearer; Google offers no client credentials grant for this) with the read-only directory scopes.
  Users by id or primary email (suspended or archived read as gone), their groups by address or name.
- Credentials are **`vault:` references only** (env: and file: are refused for these fields), read as the admin who
  saved the store; the access token lives in memory until it expires and is never stored or shown.
- Every call goes through the **egress guard** (`guardedRequest` with `SERVICE_ALLOWED_HOSTS` and
  `SERVICE_INTERNAL_ONLY`: resolved once, every address checked, the connection pinned, no redirects, answers capped
  at 4 MB); `tokenUrl` and `apiUrl` are checked when the store is saved (400 `service_url`), and must be `https://`
  (`http://` only on this host).
- With a directory, the store **joins directory sync** with its safety stop: users are looked up by their directory
  id (`subjectClaim: oid` makes Entra ID's link the id Graph knows), groups refreshed, and disabled or removed accounts
  disabled here. At **sign-in** the groups come from the directory too, named as sync names them (never the ID token's
  group ids at one and names at the other); a directory that cannot be read, or no longer has the account, refuses the
  sign-in. "Test connection" checks discovery, the grant and a first page of users and groups; the wizard's test looks
  the test account up in the directory.
- **Incremental sync by Graph delta (1.9.9-qa):** for a Graph directory, directory sync keeps a pair of delta links
  per store (`directory_sync_state`, migration `143_directory_sync_state`): `/users/delta` and `/groups/delta`
  (with `members`). A run with saved links reads only the changes and looks up only the linked accounts they name:
  accounts whose own properties changed or that were removed, members added to or removed from a group, and every
  transitive member of a group that changed itself (renamed: what mappings name changed) or was added to or removed
  from another group. A 410 (the link expired), a deleted group (its members went with it), more than 100 pages of
  changes or more than 25 such groups, or a delta that cannot be read make the run a **full pull** (every linked
  account looked up, as before); the links for the next run are taken with `$deltatoken=latest` before a full pull
  starts, so nothing changing during it is missed. Links are saved only after a run that completed (an aborted run,
  by the safety stop or an unreadable directory, reads the same changes again). The report says `mode: delta` or
  `full` and why (`fullBecause`); without the migration every run is a full pull. **Google:** the Directory API has
  no incremental listing of users or memberships (only `users.watch` push notifications to a public address), so a
  Google directory is always pulled in full.
- **Full import before first sign-in (1.9.9-qa):** User stores › the store › **Import users**, or
  `POST /api/admin/identity-providers/{id}/directory-imports` (`identity:manage` and `users:manage`), reads every
  user of the directory (Graph `/users`, Google `users.list`, page by page, at most 100,000) and their groups, and
  makes their accounts here exactly as just-in-time provisioning does at a first sign-in: roles, clearance and
  workspaces from the group mappings (or the store's default roles), linked by the directory id. Not created: an
  account disabled or suspended in the directory, one with no mapped group, one whose username is linked to another
  store (a conflict, never merged), one whose roles or clearance are beyond the importer's own; an account already
  linked is left to directory sync, and an existing unlinked account with the same username is linked, as at a
  first sign-in. A **dry run** comes first (it changes nothing and counts each outcome, with a per-user list); the
  run must name a dry run of the same store from the last 24 hours. Both are the job `directory.import` with
  progress; one import of a store at a time. The import does not count as a sign-in. Audited
  `identity.directory_import.dry_run`, `.requested` and `.completed`, and `user.created` (`via: directory-import`) for
  each account. Without migration 143 the import answers 409.

### Exprsn platform accounts (1.9.0, B-184)

The kind `exprsn-platform` (`server/src/federation/exprsn-platform.ts`) signs people in through the Exprsn
platform's OAuth 2.0 authorization server (`services/auth`, mounted at `/api/oauth2`). Changing a store of this kind
also needs `platform:manage`. Register this server as a client on the platform with the redirect URI
`<issuer>/federation/exprsn-platform/callback`.

- **Configuration:** `platformUrl` (the preset starts from `PLATFORM_LOWCODE_URL`; https, or http on this host),
  `clientId`, `clientSecret` (a `vault:` reference; leave it out for a public client), `scopes` (default
  `openid profile email`), the paths (`/api/oauth2/authorize`, `token`, `userinfo`, `revoke`), `membershipsPath`
  (optional), `usernameClaim` (default `email`), `organizationsClaim` and `rolesClaim`, `allowedOrganizations`,
  `requireVerifiedEmail` (default true).
- **Sign-in:** `GET /federation/exprsn-platform/start?provider=<id>` → the platform's authorize endpoint with
  `state` (single use, bound to the browser by the `exai_fed` cookie) and PKCE S256 → the callback exchanges the code
  with the verifier (Basic client authentication for a confidential client) → userinfo with the access token, and
  the memberships endpoint when named → the token is revoked at the platform (best effort) and never stored.
- **Account mapping:** the link is the platform's account id (`sub`), so a changed address stays linked; the
  username is the verified address (an unverified one refuses the sign-in); a username already linked to another
  store is refused, not merged. Organisations become groups `org:<slug>` and `org:<slug>/<role>`, platform roles
  `role:<name>`; with `allowedOrganizations`, an account outside them is refused and only those organisations reach
  the mappings.
- **Refused:** a replayed or foreign callback, a code obtained for another PKCE challenge (the platform answers
  `invalid_grant`), the platform's own `error`, a disabled or archived store. Every request goes through the egress
  guard with the service policy; the platform address is checked when saved.
- The platform's userinfo answers `sub`, `name`, `email` and `email_verified` today; organisations and roles are read
  when it (or the memberships endpoint) gives them. **No platform endpoint gives them for this token yet**
  (1.9.9-qa finding): `GET /api/organizations` (each organisation with the member's `role`) and
  `GET /api/roles/users/{userId}/permissions` take a platform session or a CA token, not the OAuth access token, and
  `/api/internal/users/{userId}/orgs` takes a service credential and answers ids only. What `membershipsPath` needs on
  the platform: `GET /api/oauth2/memberships` with `Authorization: Bearer <OAuth access token>` (checked as userinfo
  checks it, `oauth2Service.getAccessToken`), granted by a scope such as `organizations`, answering
  `{"sub": "<user id>", "organizations": [{"slug": "acme", "name": "Acme", "role": "owner|admin|member|guest"}],
  "roles": ["<role slug>"]}` from the active `organization_members` rows (owners as `owner`) and the user's system and
  organisation roles (`Role.slug`). Until it exists, leave `membershipsPath` empty.

#### Platform CA tokens on the API (1.9.0, B-184)

A tenant may accept the platform CA's tokens as bearer credentials on `/api` (and `/v1`)
(`server/src/federation/platform-tokens.ts`). Off until a store sets `acceptApiTokens`; existing sign-in and sessions
are unchanged.

- **The token.** The platform's CA (`services/ca/services/token.js`) keeps each token as a row and answers
  `POST /api/tokens/generate` with the full object: `id`, `version`, `issuer` (`domain`, `certificateSerial`),
  `permissions` (`read`, `write`, `append`, `update`, `delete`), `resource` (`url`: a pattern), `data` (`userId`,
  `email`, …), `issuedAt`, `notBefore`, `expiresAt` (ms), `expiryType`, `checksum`, `signature`: RSA-PSS SHA-256 (salt
  32) by a token-signing certificate the CA issued; since the platform's QA-1 fix also `sigVersion: 2` and `userId`
  (the platform account holding it). It is not a JWT. The caller sends that object as base64url JSON:
  `Authorization: Bearer eyJ…` (no dots; the platform's bare token id is not accepted, as it cannot be verified here).
- **Store settings** (the "API tokens" section of the form): `acceptApiTokens` (default false), `tokenIssuer` (the
  CA's domain, `issuer.domain`), `tokenTrustAnchor` (a PEM bundle: the CA certificate, and the token-signing
  certificates it issued), `tokenJwksUrl` (optional: keys whose `x5c` certificate the anchor issued, fetched through
  the egress guard, cached 10 minutes), `tokenValidateUrl` (the CA's `POST /api/tokens/validate`), `tokenServiceId` and
  `tokenServiceToken` (a `vault:` reference; sent as `X-Service-ID` and `X-Service-Token`), `apiAudience` (this
  server's API address; the token's resource must match it with the CA's own matcher: exact, `*` in one segment, or a
  prefix ending in `/`), `scopeMap` (lines `read=chat:read knowledge:read`), `tokenCacheSeconds` (default 30, at most
  300), `requireSignedClaims` (1.9.9-qa, default false: refuse v1 tokens, below), `adminTokensWithoutMfa` (2026-10-21,
  default false: see Permissions). With `acceptApiTokens` every field
  but the JWKS address is required. Changes are audited with the store (`identity.provider.updated`).
- **The service token** (1.9.9-qa): `tokenServiceToken` is HMAC-SHA256 of `tokenServiceId` keyed with the platform's
  `SERVICE_TOKEN_SECRET` (its `shared/utils/serviceToken.js`). The setup step `scripts/exprsn-platform-api-tokens.mjs`
  (in `bin/exprsn-setup`) derives it from the platform's `.env` for every store that opted in, keeps it in the
  tenant's vault at the store's reference (label confidential, a read and write grant on that one path for the store's
  vault owner, who is the tenant's first admin when the store had none), sets the reference and owner on the store
  when missing, and reads it back as the store will. It writes nothing when the token is unchanged, prints no secret,
  and does nothing when no store opts in. The platform keeps no list of service ids, so nothing is registered there.
- **The tenant** is the one whose active, enabled store opted in with the token's CA domain and a trust anchor its
  signature verifies under; never the token's claims or the body. When more than one tenant's store matches, the
  request names one with `X-Exprsn-Tenant: <slug>` (`/api` has no per-tenant path), and that tenant must have a
  matching store; otherwise `401` with `error: tenant_ambiguous`.
- **Checks:** the signature under a signing certificate the anchor issued (both within their validity); `expiresAt`
  and `notBefore` with 60 seconds' skew, and only `expiryType: time` (use-counted and persistent tokens are refused);
  then the CA's validation endpoint, asked by the token id with the audience as its resource (revocation, a revoked
  signing certificate or an inactive scope there refuses), its answer cached for `tokenCacheSeconds`, never past the
  token's expiry. Two signature schemes (`federation/canonical-json.ts`; shared vectors with the platform in
  `server/test/fixtures/canonical-json-vectors.json`):
  - **v2** (`sigVersion: 2`, every token the platform issues since its QA-1 fix): the signature covers the canonical
    JSON (keys sorted at every depth, no whitespace, RFC 8785 style) of every presented field but `signature` and
    `checksum`, nested ones included. A token that names a trusted signing certificate but whose signature does not
    cover what it presents (a changed bit, account, resource or added field) is refused `signature_invalid`. Its signed
    bits, resource and `data.userId` must also equal the CA's answer (`claims_mismatch`); the CA is still asked, for
    revocation and use counts. Dropping or changing `sigVersion` makes the v2 signature fail (`bad_signature`).
  - **v1** (no `sigVersion`): the platform signed its nested objects as `{}` (its `JSON.stringify` replacer applied at
    every depth), so the account, permission bits and resource are taken from the CA's answer, not the presented
    object; a presented `data.userId` that differs is refused (`claims_mismatch`). A store with `requireSignedClaims`
    refuses them (`unsigned_claims`, without asking the CA), and the platform itself refuses them after its v1 sunset
    (`TOKEN_SIG_V1_SUNSET`, default 2026-11-18; its answer `SIGNATURE_SCHEME_RETIRED` is `unsigned_claims` here).
- **The person** is the account linked to the platform account id through that store in `user_identities` (the same
  link sign-in makes). No link, a disabled or deleted account or tenant, a disabled or archived store: `401`. No
  account is created from a token.
- **Permissions:** the account's own roles, narrowed to the permissions `scopeMap` gives the token's true bits; a bit
  without a line grants nothing (an empty table: nothing). Clearance and workspaces (`X-Workspace`) as for an API key.
  It is an API credential: no CSRF token, and it never satisfies step-up or a browser-only route (`403`
  `step: credential`). Admin roles that need a second factor (2026-10-21) work only with a v2 token carrying the
  CA's signed `mfa: true`, which the platform stamps on tokens minted from a login verified with a second factor (and
  on tokens minted with such a token as the bearer; a refresh without one drops it). The CA's answer must agree
  (`claims_mismatch`). Any other token leaves those roles unusable (`403` `step: mfa`) unless the store sets
  `adminTokensWithoutMfa`. The audit actor carries
  `via: platform-token:<store>`.
- **Refusals** are `401` problem+json with `error: invalid_token` (or `tenant_ambiguous`) and `reason`
  (`tenant_mismatch`, `bad_signature`, `signature_invalid`, `unsigned_claims`, `expired`, `not_yet_valid`, `no_expiry`, `wrong_audience`, `revoked`,
  `claims_mismatch`, `unlinked`, `account_disabled`; `503` `platform_unavailable` when the CA cannot be asked). They
  count towards the failed-credential limit and are audited as `identity.platform_token.refused` with the reason (at
  most once a minute per tenant, store and reason; never the token or its id). Acceptances are not audited per
  request. A token no store accepts gets the answer any unknown token gets, unaudited.

## From store account to user

The first successful sign-in links the store account to a user in the application database, keyed on
**(store, external id)**: the DN for LDAP, the id column (or username) for SQL. If a user with the same username is
already linked to a *different* store, sign-in is refused (`identity_conflict`) rather than merged, so an account in
one store can never take over an account from another.

Roles and clearance:

- **Group mappings** map a group (DN or name, compared case-insensitively) to a role and a clearance, optionally only
  for one store. A user in several mapped groups gets every mapped role and the highest clearance.
- A store may grant **default roles** (`member`, `auditor`, `flag-reviewer`, `knowledge-curator`; never an admin role)
  when no mapping matches, for stores that have no groups.
- **Direct** roles and clearance can be granted in the console. Only a system admin can grant system admin; admins
  cannot change their own roles, clearance or state.
- A user with no role from any source is refused (`no_mapped_group`).

Mapped roles and clearance are recomputed at every sign-in. Changing a user's access in the console ends their
sessions so the change applies on the next request.

Changing someone's roles, resetting their factors and ending their sessions (Users, Sessions, and the Sessions tab of
Federation, including their OAuth grants) all need the same thing: roles that could grant every role the person
holds. An identity admin can sign a member out but not a system admin; anyone can end their own sessions.

## Roles

| Role | Grants | Second factor |
| --- | --- | --- |
| System admin | everything, across tenants | required |
| Tenant admin | tenant, users, identity, usage, audit | required |
| Identity admin | user stores, mappings, users, sessions | required |
| Model admin | models, pools, profiles | required |
| Guardrail admin | guardrails, classifiers, flags | required |
| Tool admin | registry, agents, MCP servers | required |
| Knowledge curator | knowledge bases | — |
| ML admin | training | required |
| Workflow admin | workflows, scripts | required |
| Connection admin | data connections | required |
| Flag reviewer | the review queue | — |
| Member | chat, knowledge, tools within clearance | — |
| Auditor | audit chain and usage, nothing else | required |

The full permission lists are in [`server/src/authz/permissions.ts`](../server/src/authz/permissions.ts).

## Sign-in, sessions and second factors

1. `POST /api/auth/login` with username and password (and `tenant`, or the server's `DEFAULT_TENANT`).
2. If the user has a second factor, the session is at stage `mfa` for five minutes: TOTP, a passkey, or a recovery
   code completes it. If the user's roles require one and none is set up, the stage is `enroll`, and only factor
   enrolment is allowed. Completing either issues a **new** session token.
3. If an admin set or reset the account's local password (or created the account with a password), the session then
   moves to stage `password`: only `POST /api/me/password` is allowed until the user chooses their own password.
4. Sessions end after `SESSION_IDLE_MINUTES` of inactivity or `SESSION_ABSOLUTE_HOURS` in total, on sign-out, or when
   revoked (by the user, an admin, or disabling the account). Revocation closes the session's live connections.

Five failed attempts lock the account for `LOCKOUT_DURATION_MINUTES`; the client address has a higher limit. A tenant's
sign-in policy may lower the attempts and change the window and duration (below).

Local accounts can change their password in Settings (the current password is required and a wrong one counts toward
the lockout; the change signs out every other session and OAuth grant), reset it with a single-use link by email from
the sign-in screen, and be reset by an identity admin (a temporary password to change at next sign-in, or a link).
Directory accounts change their password in the directory. New passwords pass the policy and, with
`BREACHED_PASSWORDS`, a breached-password check. Creating API keys, removing a factor and regenerating recovery codes
need a password or factor check within `STEPUP_WINDOW_SECONDS` (signing in counts); Settings asks for it when needed.
The account owner gets a security notice (console and email) for each of these changes. Routes: [api.md](api.md#sprint-11-account-self-service).

## The tenant sign-in policy (1.9.0, B-190)

Identity › Sign-in policy sets what a tenant asks of passwords, sign-ins and sessions. A tenant sets only what it wants
to change; everything else is the platform's. Without a policy (or with one that sets nothing) sign-in behaves exactly
as before. Code: `identity/signin-policy.ts`; routes: [api.md](api.md#sprint-55-190-unreleased-the-tenant-sign-in-policy-and-oauth-client-settings-b-190-b-191).

| Part | What it sets | Bounds |
| --- | --- | --- |
| Passwords | minimum and maximum length; character classes (lower case, upper case, digit, symbol), off by default (NIST SP 800-63B); "not too close to the old password"; a history of the last n; a forced expiry, off by default and warned about | minimum never below 12; history 0 to 24; expiry 0 to 730 days |
| Lockout | failed attempts, the counting window, the lockout duration | attempts at most `LOCKOUT_MAX_ATTEMPTS` |
| Sessions | idle timeout, absolute lifetime, step-up window | at most `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`, `STEPUP_WINDOW_SECONDS` (a tenant only shortens them) |
| Second factors | which kinds people may use and enrol: authenticator apps (TOTP), passkeys, email codes | at least one |

**One path for every password.** Changing it in Settings, a reset or invitation link, sign-up, an admin creating an
account or setting a password, and a CSV import with the `password` column all go through
`SigninPolicies.checkNewPassword`, in this order:

1. The policy: length, the character classes the tenant turned on, the username, common passwords and the service's
   name, then "not too close to the old one" (only when the person typed the old one: a case- and space-insensitive
   edit distance of at most a quarter of the length, or most of the old password kept as one run), then the history
   (the current password and the last n, compared by verifying each argon2 hash; only argon2 hashes are kept, and only
   while the tenant keeps a history).
2. The tenant's deny words (`s.passwordDenyWords`, B-194).
3. The leaked-password lists (`s.leakedPasswords`, B-193), which decide what a hit means (refuse or warn) and whether
   an unavailable list fails open (accepted, audited `password.breach_check.unavailable`) or closed (503).

The CSV import checks a `password` cell when it plans (a refused one is an error row with the reason, never the
password) and sets it only for new local accounts, which change it at their first sign-in. SCIM never takes a
password (its `password` attribute is not kept), so there is nothing to check there.

**At sign-in.** The lockout uses the tenant's settings. A correct local password that no longer meets the policy, or
is older than a forced expiry, is accepted: the session starts in the `password` stage (after the second factor) and
the person chooses a new one; the answer says why (`passwordChange.reason`), and it is audited
`identity.policy.change_required`. Nobody is locked out by a policy change. Session lifetimes and the step-up window
are the tenant's from the next request. The second-factor step offers only allowed kinds; an account whose factors are
all of another kind keeps using them and is refused only new factors of that kind.

**What applies to this person.** The user page (User stores › Users) shows the policy that applies to a person and
where each value comes from (platform floor, platform, this tenant, default), with their password's age and expiry,
whether a second factor is required and why, and any factor they hold that the tenant no longer allows.

## OAuth and OIDC client settings (1.9.0, B-191)

The tenant's OAuth defaults (on the Sign-in policy tab) and each client's own token settings (in the client's
inspector under OIDC clients) decide:

- the authorization code lifetime (60 seconds by default), and the access and refresh lifetimes new clients get; each
  client keeps its own access and refresh lifetimes;
- PKCE for every client, or only for public clients and those that ask for it (a public client always must);
- the consent screen: the tenant's consent settings, or always or never for one client (a self-registered client
  always asks; `prompt=consent` always asks). The consents a person gave are listed in Settings › Connected
  applications, where removing one also ends the client's tokens (audited `oidc.consent.withdrawn`);
- a rate limit per client at the token, PAR and device endpoints (429 with `Retry-After`);
- refresh-token rotation: rotated on every use, with a reused token revoking its whole family (kept in
  `oidc_refresh_families` and shown in the inspector), or, for confidential clients only, kept until it expires.

Code: `federation/client-settings.ts`. Without migration 130 every value is the previous one.

## Leaked-password lists and deny words (1.9.0, B-192 to B-195)

Platform › Leaked passwords holds lists of passwords known to be leaked, and the tenant's checks against them. Code:
`identity/leaked/` (`s.leakedPasswords`) and `identity/deny-words.ts` (`s.passwordDenyWords`); routes:
[api.md](api.md#sprint-55-190-unreleased-leaked-password-lists-checks-against-them-and-tenant-deny-words-b-192-to-b-195).
Without migration `131_leaked_password_lists`, or with no lists, every check is the `BREACHED_*` one of before.

**Lists.** A list is platform-wide (`platform:manage`, checked for every tenant) or one tenant's own
(`identity:manage`, the permission the Identity admin and Tenant admin roles already hold for user stores and the
sign-in policy). Its hash is SHA-1 (what Have I Been Pwned publishes) or NTLM, fixed when it is made. A version is
imported from the console or `exprsn-ai passwords:import` as:

- HIBP's "ordered by hash" format, `HASH:COUNT` lines (SHA-1 or NTLM; count 0 padding is dropped, counts are never
  kept);
- one hex hash per line;
- plain text, one password per line, hashed as the upload streams in and dropped at once: never stored, never logged
  (invalid lines are reported by number, never by content).

The import is staged as binary digests, then built by the job `passwords.list.build` (progress, duplicates removed and
counted): sorted shards by hash prefix in the blob store (2, 4 or 6 hex characters, about 65,000 hashes a shard) with a
Bloom filter in front (`LEAKED_BLOOM_FP_RATE`, 0.1% by default). Every import is a new version; a built version becomes
the active one unless the import said not to, and any built version can be made active again (replace or roll back).
An HIBP mirror (a platform list, an explicit action) fetches all 16^5 ranges of the range API at `LEAKED_MIRROR_RPS`
into a version; a stopped mirror resumes from its cursor. Audited `passwords.list.*`.

**Checks.** Every password set (Settings, a reset or invitation link, sign-up, an admin setting one, a CSV import)
goes through the pipeline above; its third step asks every enabled list that applies (the platform's and the
tenant's), then HIBP online and the local file where `BREACHED_*` allows. The person is told only that the password
was found in a leaked list, never which list or how often. When a list cannot be read, the tenant's fail mode decides:
open (the default, as before: accepted) or closed (refused with 503); either way it is audited
`password.breach_check.unavailable`.

**At sign-in.** A local account's password is checked against the list versions added since it was last checked (one
Bloom-filter lookup per new version; `leaked_password_checks` keeps when and against which versions). Found, the
tenant's choice applies: require a change (the default: signed in once, then the `password` stage, and
`must_change` holds until it is changed), warn (signed in, told by a security notice), or block (refused at every
sign-in until the password is reset). Audited `password.leaked.signin`. The report under Platform › Leaked passwords
(this tenant) lists the accounts found and whether they changed their password since.

**Deny words.** A tenant lists up to 200 words it forbids inside passwords (its name, products, places), optionally
with one of its guardrail term lists (B-156) used as more of them. They are matched with the term lists' normaliser:
case, accents, compatibility forms, Cyrillic and Greek lookalikes and leetspeak (`4` and `@` for a, `3` for e, `0` for
o, `1` for i and l, `5` and `$` for s, `7` for t) folded on both sides, and anywhere in the password: as written, with
spaced-out letters joined, and with every separator removed. A word shorter than three letters after folding is
ignored. The refusal names the word (`reason: deny_word`): it is the tenant's own word, not a secret.

**CLI.** `passwords:import` (a file or stdin, built in the CLI process with progress), `passwords:lists`, and
`passwords:check`, a k-anonymous self-check: the password is read without echo, hashed locally, and only the first
five hex characters of each hash go to each source (this server's lists, and the range API when `BREACHED_PASSWORDS`
allows it or `--online`); the suffixes that come back are compared locally. Exit 2 when found.

## Federation (Sprint 9)

The server is an OpenID Connect provider and a SAML 2.0 IdP for applications, a relying party or service provider to
on-prem identity providers, and accepts Kerberos SPNEGO. Everything is configured per tenant on the **Identity**
screen (permission `identity:manage`; admin roles need an MFA-verified session) and every change is audited.

### Issuers and endpoints

The default tenant's issuer is `FEDERATION_ISSUER` (default `PUBLIC_URL`); every other tenant's is
`<issuer>/t/<tenant slug>`, and its endpoints live under that prefix. The default tenant is served at the root only, so
each tenant has exactly one issuer. Each tenant has its own signing keys, clients, SAML service providers and upstream
providers; tokens carry `tenant` (slug) and `tid` claims, and a session in one tenant never authorizes another
tenant's client.

| Path (under the issuer) | What it is |
| --- | --- |
| `/.well-known/openid-configuration`, `/.well-known/jwks.json` | Discovery and the key set (CORS open, cached 5 minutes) |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata (the discovery document); also at the path-inserted `/.well-known/oauth-authorization-server/t/<slug>` and `/.well-known/openid-configuration/t/<slug>` on the host (1.6.0) |
| `/oauth/register` | RFC 7591 dynamic client registration, only when the tenant allows it (1.6.0, see "MCP clients" below) |
| `/oauth/authorize` | Authorization code flow with the console session; consent page when needed |
| `/oauth/token` | `authorization_code`, `refresh_token`, `client_credentials`, device code, token exchange (60 requests a minute per address) |
| `/oauth/userinfo`, `/oauth/revoke`, `/oauth/device_authorization`, `/device` | Userinfo, RFC 7009 revocation, RFC 8628 device authorization and its verification page |
| `/saml/metadata`, `/saml/sso`, `/saml/continue` | IdP metadata, SSO (HTTP-Redirect and HTTP-POST bindings), and the response page |
| `/federation/oidc/start`, `/federation/oidc/callback` | Upstream OIDC sign-in |
| `/federation/saml/start`, `/federation/saml/acs`, `/federation/saml/<provider id>` | Upstream SAML sign-in, the ACS, and our SP metadata (its URL is our entity ID) |
| `/auth/negotiate` | Kerberos SPNEGO sign-in |

These paths sit outside `/api`: they parse their own form bodies and are not CSRF-checked by header; forms that change
state (the consent page) carry a token bound to the session and are refused cross-origin.

### Signing keys

OIDC tokens are signed with ES256 (P-256). Private keys are generated with node:crypto, stored as PKCS#8 sealed with
the platform data key (bound to the key id), and never leave the server. A key moves through `next` (published in
the JWKS, not signing) → `signing` → `verify only` (still published for `OIDC_KEY_OVERLAP_DAYS`, default 14, so tokens
it signed keep verifying) → removed. A scheduled job publishes the next key `OIDC_KEY_OVERLAP_DAYS` before the signing
key reaches `OIDC_KEY_ROTATION_DAYS` (default 90) and switches over when it is due. "Rotate signing key" does the same
now; the API's `immediate: true` (a suspected compromise) makes the new key sign at once.

The SAML IdP signs with a separate RSA-2048 key and a self-signed certificate (valid three years), because SAML
service providers widely support RSA-SHA256 and not ECDSA.

### Clients

| Type | Secret | Grants | Consent |
| --- | --- | --- | --- |
| confidential, BFF (`first_party`) | yes | authorization code, refresh, device, token exchange | pre-consented when the tenant allows it |
| public | none | authorization code with PKCE, device, refresh | asked |
| service account (`service`) | yes | client credentials, token exchange | not applicable |
| third party | yes | authorization code, refresh, device, token exchange | asked on first use, remembered 90 days |

- Redirect URIs match exactly: https, http on a loopback address, or a private-use scheme; wildcards and fragments are
  refused. A wrong redirect URI or unknown client shows an error page and never redirects.
- PKCE with S256 is required for public clients and, by default, for every client (`plain` is refused).
- Client secrets (`xs_live_…`) are shown once, at creation or rotation, and stored as an HMAC digest. Rotation stops
  the old secret at once. Disabling a client revokes its refresh tokens and makes its access tokens fail.
- A service-account client gets a user (`svc-<name>`, role `member`, no password); its tokens carry that user as the
  subject, and their scopes narrow the user's roles. Grant it more roles in User stores if it needs them.

**Scopes** are the identity scopes (`openid profile email groups offline_access`), every permission
(`chat:read`, `models:manage`, …), `resource:*` on a client's allow-list, and `inference:invoke:<profile>`. The
grant is requested ∩ the client's allow-list ∩ the user's current permissions, so scopes never widen a role; it is
re-intersected at every refresh. **Claims**: `profile` gives `name` and `preferred_username`; `email` gives `email`;
`groups` gives `groups` (from the user's store), `roles` and `clearance`.

**Tokens.** Access tokens are JWTs (`typ: at+jwt`, ES256, `kid`), 5, 10 or 30 minutes per client, with `aud`
(`<issuer>/api` unless a `resource` is given: since 1.6.0 the code and refresh grants carry the resource named at the
authorization endpoint, which must be `<issuer>/api` or one of the tenant's MCP endpoints, RFC 8707), `scope`, `client_id`, `tenant`, `tid`, `sid` (the grant),
`models` (the client's allowed models) and, after token exchange, `act`. ID tokens add `nonce`, `auth_time`, `amr`
(`pwd`, `otp`, `hwk`, `kerberos`, `fed`, `mfa`) and `at_hash`. Refresh tokens are opaque, stored as digests, and
rotated on every use; a family lives 8 hours (24 hours for clients with the device grant) from its first token.
Presenting a rotated refresh token again revokes the whole family and is audited (`oidc.refresh.reused`). A replayed
authorization code revokes what it produced. Revoking the console session behind a grant, or the user being disabled,
ends it at the next refresh.

**Token exchange** (RFC 8693) takes an access token from this issuer as `subject_token` and returns a narrower one for
the calling confidential client, with `act: {sub: <client id>}`.

### MCP clients (1.6.0, B-7102)

Each workspace can publish an MCP server (Identity, **MCP server** tab): `<base>/mcp/<tenant slug>/<workspace id>`,
where the base is `API_PUBLIC_URL` or the origin of `PUBLIC_URL`. The server is an OAuth 2.1 resource server of the
tenant's issuer, so an MCP client such as Claude Desktop follows the MCP authorization flow with no secret in the URL:

1. Its first request gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`. The protected resource metadata
   (RFC 9728) names this tenant's issuer and the MCP scopes (`tools:invoke agents:run inference:invoke knowledge:read
   records:read records:write`).
2. The client reads the issuer's metadata (RFC 8414) and needs a client: an identity admin creates a public client
   with its redirect URI under OIDC clients, or, with **self-registration** on, the client registers itself at
   `/oauth/register` (RFC 7591: authorization code with PKCE and refresh only, HTTPS or loopback redirect URIs, the
   MCP scopes; listed on the MCP server tab and disabled like any client). Self-registration is off by default.
3. The person signs in to the console (or already is), sees the consent page for the client and the scopes (narrowed
   by their roles), and the client gets a code, then tokens, naming the server's URL as the `resource` (RFC 8707). The
   access token's audience is that URL; it is refused by the API and by every other workspace's server, and an API
   token is refused by the MCP server.
4. Every call acts as that person, at most at the label the workspace publishes at, and writes wait for the person's
   approval under Settings, **MCP access**, where the connection URLs are listed too.

A workspace can require DPoP-bound tokens. Before 1.6.0 an MCP client could only reach Exprsn-AI through a separate MCP
service holding a service account's credential (as the platform-tools service on one deployment does); a workspace's
MCP server makes that unnecessary, since each person connects as themselves.

The reverse direction, Exprsn-AI connecting each person to someone else's authorization-protected MCP server, is on the
MCP servers screen (OAuth for users: discovery with RFC 9728, RFC 8414 and RFC 7591, or endpoints and a client entered
by hand) and in Settings, MCP access (connect and disconnect); see `docs/api.md`, Sprint 37b.

### Signing in through the console

`/oauth/authorize` and `/saml/continue` use the console session cookie. That cookie is `SameSite=Strict`, so it is
not sent on a redirect from another site: those requests get a small page whose script (`web/js/federation.js`, no
inline scripts) re-checks the session from our origin and resumes, or keeps the address in `sessionStorage` and opens
the console sign-in, which resumes it when sign-in (including the second factor) finishes. Resume addresses are
limited to our own `/oauth/authorize`, `/saml/continue` and `/device` paths.

### Device flow (RFC 8628)

`POST /oauth/device_authorization` gives a device code, a user code (`XXXX-XXXX`, consonants only) and the
verification URI `<issuer>/device`. Codes live `DEVICE_CODE_MINUTES` (15); the device polls the token endpoint no more
than every `DEVICE_POLL_SECONDS` (5) and gets `authorization_pending`, `slow_down` (interval +5 s), `access_denied` or
`expired_token`. The user approves on the verification page as the user signed in to the browser
(`GET/POST /api/auth/device`); the scopes are intersected with that user's permissions.

### SAML IdP

Service providers are registered from pasted metadata (nothing is fetched): entity ID, HTTP-POST ACS URLs, signing
certificate, NameID format and `AuthnRequestsSigned`. SP-initiated SSO over HTTP-Redirect (DEFLATE) or HTTP-POST; the
request must name a registered SP and a registered ACS URL, and is signature-checked when the SP asked for signed
requests. The response is a `samlp:Response` whose assertion carries an enveloped XML-DSig signature (RSA-SHA256,
exclusive C14N, SHA-256), `InResponseTo`, `Recipient`, the SP as audience, a validity of `SAML_ASSERTION_MINUTES` (5)
and attributes `uid`, `email`, `displayName`, `groups`, `roles` and `clearance` (renamed per SP with an attribute
map). NameID: email, a pairwise persistent id (HMAC of the SP and user), the username, or transient. The response is
posted by a form (auto-submitted by `web/js/federation.js`); the page's CSP allows that one ACS origin. An SP whose
certificate has expired can be enabled only with signed requests off.

The XML code (`server/src/federation/xml.ts`) is deliberately strict: no DOCTYPE or entity declarations, no processing
instructions, no unbound prefixes, comments dropped and adjacent text merged.

### Upstream federation

An upstream provider is a user store of kind `oidc` or `saml` in the tenant's chain, added from the Identity screen
("Add upstream provider") or YAML/API like other stores. Its hosts must resolve to internal addresses (the air gap)
unless `FEDERATION_ALLOWED_HOSTS` names them; every connection is re-checked at dial time. It appears on the sign-in
screen as "Sign in with <name>".

- **OIDC**: authorization code with PKCE (S256), `nonce` and `state`. The ID token is verified against the provider's
  JWKS (RS256 or ES256; refetched once on an unknown `kid`): signature, issuer, audience, `azp`, expiry and nonce. The
  client secret is a secret reference (`env:` or `file:`). Register `<issuer>/federation/oidc/callback` at the provider.
- **SAML**: an AuthnRequest over HTTP-Redirect; the response posted to `<issuer>/federation/saml/acs` must answer that
  request (`InResponseTo`), name our ACS as recipient and our entity ID as audience, be inside its validity window
  (2 minutes skew), and carry exactly one assertion, signed (itself, or inside a signed response) by a certificate
  from the IdP metadata. Encrypted and unsolicited (IdP-initiated) assertions are refused.
- The browser round trip carries a single-use handle (`state` / `RelayState`) bound to a short-lived cookie in the
  browser that started it, so a copied response cannot be completed elsewhere.
- Claims or attributes become the store account: the subject (or NameID) is the external id, the username claim
  (`preferred_username` by default) or attribute the username, and the groups claim or attribute feeds the tenant's
  group mappings, exactly as for LDAP. Upstream users are never disabled by directory sync.

### Kerberos SPNEGO

`GET /auth/negotiate` answers `401 WWW-Authenticate: Negotiate`; a browser with a domain sign-in and this site in its
intranet zone retries with a ticket. The ticket is verified by `s.kerberos` (`server/src/federation/kerberos.ts`),
which uses the optional `kerberos` npm module with the keytab in `KERBEROS_KEYTAB` and the service
`KERBEROS_SERVICE` (`HTTP@ai.example.internal`); without both, Kerberos reports itself unavailable and the sign-in
screen does not offer it. The principal (`alice@CORP.EXAMPLE`) must be in an accepted realm (tenant setting; empty
accepts any) and its user part is looked up in the tenant's user stores in order; the store that knows it supplies the
groups, and provisioning continues as for a password sign-in. A mutual-authentication token is returned when the
library gives one.

### Second factors after federated sign-in

Upstream and Kerberos sign-ins count as the first factor only. A user who has a second factor, or whose roles require
one, lands in the `mfa` or `enroll` stage exactly as after a password, and finishes it in the console. Tokens issued
from a session record the factors in `amr`.

### Test a login

The Identity screen's "Test a login" runs the real pieces without creating a session: Kerberos availability and realm
policy, the store lookup, group mappings, second factors, and a token signed with the current key and verified
against the published JWKS with a test audience. "Device code" issues a real device code for a client that allows the
grant.

## SCIM 2.0 provisioning

1.6.0 (B-7201, B-7202). A SCIM store (`kind: scim`) holds the users and groups an identity provider pushes to
`<PUBLIC_URL>/scim/v2` (RFC 7643, RFC 7644): Users and Groups with create, replace, patch, delete, filters, paging,
`attributes` and `excludedAttributes`, and weak ETags with `If-Match`. Bulk, `/Me`, `/.search`, sorting and password
changes are not offered (the ServiceProviderConfig says so). The routes are in `docs/api.md`, Sprint 37c.

Set it up under Identity, User stores and federation (or User stores):

1. Add a SCIM store. Name the upstream store (OIDC, SAML or GitHub) of the same provider in `signInStores`: a sign-in
   there whose username is the SCIM `userName` signs in as the SCIM user.
2. Make a SCIM token (shown once) and paste the base URL and the token into the provider's provisioning settings
   (Entra ID: Enterprise application, Provisioning, Tenant URL and Secret Token; Okta: the app's Provisioning tab,
   SCIM connector base URL, unique identifier `userName`, HTTP Header authentication).
3. Add group mappings with the SCIM store as provider and the SCIM group's display name as the group. Members get the
   mapped roles, clearance and workspaces (else the store's `defaultRoles` and `defaultClearance`, empty and
   `internal` by default); after changing mappings, Re-apply group mappings.

What the provider's operations do:

| Operation | Effect |
| --- | --- |
| Create a user | A user of the tenant (the SCIM `id` is the user's id) linked to the store; `userName` becomes the username in lower case. A username of another store is a `409 uniqueness`: a SCIM store never takes over an account |
| Update a user | Name, address, display name and manager follow; the attributes are kept as pushed |
| `active: false` | The user is disabled and, in the same request, their sessions (and sockets), OAuth refresh tokens, API keys and DAV app passwords end: their next request is unauthenticated |
| `active: true` | Re-enabled, if SCIM disabled them; an administrator's own disable stays |
| Delete a user | Disabled and signed out everywhere, unlinked from the store and its groups; the user row stays for the audit history. Pushed again later, the same user is adopted and re-enabled |
| Group membership | Recomputes the members' mapped roles, clearance and workspaces; anyone whose access changed is signed out once |

### Conformance (B-7202)

The Microsoft Entra ID SCIM Validator and Okta's SCIM 2.0 test suite (Runscope) call the service from the internet,
which this installation is not reachable from, so they were **not run** for 1.6.0; B-7202's "the Entra ID validator
passes with no failure" stays open for that external run. In their place, `server/test/sprint37c-scim.test.ts` runs
what those validators check against the real routes, on SQLite (and `test/integration/scim-vault-posts.test.ts` the core
of it on PostgreSQL and MySQL). Result on 2026-10-07: every check below passes.

| Validator check (Entra ID, Okta) | Local test |
| --- | --- |
| Discovery: ServiceProviderConfig, Schemas (User, enterprise User, Group), ResourceTypes | discovery and authentication |
| Requests without a token, with a wrong, expired or revoked token are refused with 401 and the SCIM error schema | discovery and authentication |
| Create a user with the attributes Entra ID maps by default (userName, active, displayName, emails[type eq "work"], name.givenName and familyName, externalId, title, preferredLanguage, phoneNumbers, addresses, enterprise employeeNumber and department) | users: create |
| Create a duplicate user (same userName, other case): 409 uniqueness | users: create |
| Get a user by id; an unknown id is 404 in the SCIM error schema | users: get |
| Filter `userName eq` (other case), `externalId eq` (case-exact), a filter that matches nothing (totalResults 0), an invalid filter (400 invalidFilter) | users: filter |
| PATCH as Entra ID sends it: capitalised `Replace` and `Add`, booleans as `"False"`, `emails[type eq "work"].value`, enterprise `department` and `manager` | users: PATCH (Entra) |
| PATCH as Okta sends it: no path, a value object (`active`, `id` echoed and ignored) | users: PATCH (Okta), deprovisioning |
| Disable a user (`active: false`) and enable again | deprovisioning |
| PUT replaces the whole user (Okta) | users: PUT |
| Paging with startIndex and count; count=0; `attributes` and `excludedAttributes` | users: paging and projection |
| ETags: a stale If-Match is 412 | users: ETags |
| Delete a user: 204, then 404 | users: delete |
| Create a group with members; a duplicate group name (other case) is 409 | groups: create |
| Filter groups by `displayName eq` with `excludedAttributes=members`; get a group without members | groups: filter |
| PATCH group members: Entra ID's `Add`/`Remove` with a value list, Okta's `remove` with `members[value eq "…"]`, `replace` of displayName with a value object | groups: PATCH |
| PUT replaces a group's members; delete a group: 204, then 404 | groups: PUT and delete |
| Group membership maps to roles, clearance and workspaces | groups: roles; deprovisioning |
| Deactivating a user ends their open console session within one request (B-7201's done-when) | deprovisioning |

Known differences from a strict reading of RFC 7644: a `replace` or `add` through a value filter that matches nothing
adds an element made from the filter's `eq` terms (Entra ID relies on it); attributes the schemas do not define are
ignored rather than refused; `password` is accepted and dropped.

## `did:exprsn` (1.7.0, B-113)

`did:exprsn` is the exprsn-platform's self-certifying DID method, which Exprsn-AI resolves and mints.

**The method.** The method-specific id is the public key itself, in the multibase (base58btc) multicodec form a
`did:key` uses: `did:exprsn:zQ3sh...` for a secp256k1 key, `did:exprsn:zDn...` for P-256. Nothing is registered and
no network is asked. The DID document is derived from the DID: `alsoKnownAs` (empty unless the resolving server
knows more), and the key as two verification methods, `#atproto` (service-auth JWTs are verified against it) and
`#atproto_label` (labels are verified against it). A DID whose id is not a valid compressed key on secp256k1 or
P-256 does not resolve. `server/src/atproto/did-exprsn.ts` builds and parses it.

**Resolving.** The server's DID resolver (`DidResolver`, also behind service-auth verification and labeler checks)
resolves `did:exprsn` and `did:key` offline, beside `did:plc` (the PLC directory) and `did:web` (over HTTPS). The
public XRPC method `GET /xrpc/com.exprsn.identity.resolveDid?did=<did>` answers `{ did, didDoc }` for any of the
four; for a `did:exprsn` minted here it adds what this server knows (`alsoKnownAs`).

**A user's own `did:exprsn`** (`GET /api/me/atproto/exprsn-did`, `atproto:link`) is minted the first time it is
asked for: a key is made in the signer (secp256k1) or in OpenBao transit (P-256), and only a reference to it and its
public key are stored (`atproto_exprsn_dids`; audited `atproto.user-did.minted`). Where the user has an account on
this server's PDS, the DID's document names that account's `did:plc` (or `did:web`) in `alsoKnownAs`. Labels and
service-auth tokens signed with the key verify under the DID. Unlike the platform, which derived every user's key
from one secret (`ATPROTO_USER_DID_SECRET`, whose change re-keys every DID), no shared secret is read: each user's key
is its own and stays in the key store.

**Interop.** `server/test/fixtures/atproto/did-exprsn.json` is a DID, its document and a signed label made with the
platform's own resolver and label signer; Exprsn-AI resolves the DID offline and verifies the label.

## API keys

Created in Settings from a browser session. `exai_k1_<prefix>_<secret>`, shown once. A key's scopes are a subset of
its owner's permissions at creation, and every request intersects them with the owner's current roles, so demoting
or disabling the owner applies to their keys immediately. Use as `Authorization: Bearer exai_k1_…`.

## Audit

Every sign-in, failure, refusal, second-factor event, denial (`authz.denied` with the failing step) and admin change
is appended to the tenant's hash chain. `POST /api/admin/audit/verify` (or `exprsn-ai audit:verify`) recomputes it
from the first event; a break is reported, never repaired.
