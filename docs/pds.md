# The AT-Protocol personal data server

Exprsn-AI hosts AT-Protocol repositories (1.5.0, Sprint 31: B-2901 to B-2906, with B-3004), so that people in a
tenant can be AT-Protocol accounts without a third-party PDS. This page describes the protocol surface at `/xrpc`, how
hosting is switched on, how accounts relate to Exprsn-AI users, and what the PDS does with labels, clearance and
moderation. The admin and self-service routes under `/api` are in [api.md](api.md#sprint-31-150-the-at-protocol-pds-b-2901-to-b-2906-b-3004).

## Hosting

- Off for every tenant. A platform admin (`platform:manage`, recent sign-in) enables it per tenant with
  `PUT /api/admin/pds/tenants/{tid}` (the owner decision of 2026-10-05). Enabling is refused when the deployment is
  air-gapped (`ZONES_AIR_GAPPED`), when the PDS zone (`PDS_ZONE`, default `edge`) has no egress to the network, and
  when neither the signer nor OpenBao transit can hold keys.
- One PDS serves every hosting tenant at `PDS_PUBLIC_URL` (default `ATPROTO_PUBLIC_URL`, then `PUBLIC_URL`). Its DID,
  used as the audience of its tokens and of inter-service tokens sent to it, is `did:web:<that host>`.
- Handles are `<name>.<tenant>.<PDS_HANDLE_DOMAIN>`: the tenant's label is fixed when hosting is first enabled
  (`pds_tenants.handle_domain`). The operator points a wildcard DNS record for `*.<tenant>.<PDS_HANDLE_DOMAIN>` at the
  server, which answers `GET /.well-known/atproto-did` for each hosted handle. A tenant's own handle domain is planned
  for 1.6.
- A tenant admin (`pds:manage`) may lower the blob size limit, narrow the blob types (within `PDS_BLOB_MAX_BYTES` and
  `PDS_BLOB_TYPES`) and require invite codes even when the sign-up policy is open
  (`PATCH /api/admin/pds/settings`).
- Disabling hosting is refused while the tenant still has active accounts.

## Accounts

- Every account belongs to one Exprsn-AI user (`pds_accounts.user_id`, one account per user). The XRPC API works only
  while that user is active, not suspended or banned (B-1904), and still holds `atproto:link`.
- A signed-in user creates their account in the console (`POST /api/me/pds`, recent sign-in). Over XRPC,
  `com.atproto.server.createAccount` creates the Exprsn-AI user and the account together, through the tenant's sign-up
  policy (B-1801): an `open` policy behaves as self-registration (domain list, password checks, roles, clearance,
  email verification); a `closed` or `approval` policy, or a tenant that requires them, needs an invite code. Invite
  codes are issued by `pds:manage` holders (`POST /api/admin/pds/invites`), shown once, stored as an HMAC, with a use
  count and an optional expiry; a valid code stands in for the invitation and the approval.
- A new account gets a `did:plc`. The genesis operation names the repo signing key as `#atproto`, the handle as
  `at://<handle>`, and this PDS as `#atproto_pds` (`AtprotoPersonalDataServer`), and is signed by the account's
  rotation key. Both keys are made in the signer (secp256k1) or OpenBao transit (P-256): the row keeps only the key
  name, the signer's wrapped blob and the public multikey. Every signature (commits, PLC operations, inter-service
  tokens) is made there and folded to low-S.
- Sessions. Bluesky clients sign in with an **app password** (`xxxx-xxxx-xxxx-xxxx`) made in the console
  (`POST /api/me/pds/app-passwords`: a recent sign-in, and a fresh second factor when the user has one). The
  Exprsn-AI password is never accepted over XRPC, so a second factor cannot be bypassed. An app password may be
  privileged (needed to move the account). `createAccount` returns a full-access session directly.
- Tokens: access tokens (`typ: at+jwt`, `PDS_ACCESS_MINUTES`) and refresh tokens (`typ: refresh+jwt`,
  `PDS_REFRESH_DAYS`) are HS256 under a key derived from `SESSION_SECRET`. Both name the session (`jti`), which the
  database tracks: a refresh token is spent once; revoking an app password, deactivation and takedowns end sessions at
  once.

## XRPC endpoints

All under `/xrpc/<nsid>` on the PDS host, outside `/api` (no cookie, no CSRF), with CORS open for browser clients.
Errors are AT-Protocol's `{ "error": "…", "message": "…" }`. Every address is limited to `PDS_RATE_PER_MINUTE`
calls; sign-ups and sign-ins to 30 a minute, and failed sign-ins to 10 per identifier in 15 minutes; writes to
`PDS_WRITES_PER_HOUR` operations per account. The route permission registry declares the public ones `public` and the
rest `atproto:link`.

| Method | NSID | Auth | Notes |
| --- | --- | --- | --- |
| GET | `com.atproto.server.describeServer` | none | `did`, `availableUserDomains`, `inviteCodeRequired` |
| POST | `com.atproto.server.createAccount` | none (a service token with `did`) | `handle`, `email`, `password`, `inviteCode`; with `did` and `Authorization: Bearer <service token>` (from the old PDS, `lxm` createAccount, audience this PDS) the account migrates in, deactivated |
| POST | `com.atproto.server.createSession` | none | `identifier` (handle, DID or email) and an app password |
| POST | `com.atproto.server.refreshSession` | refresh token | spends it, returns the next pair |
| POST | `com.atproto.server.deleteSession` | refresh token | |
| GET | `com.atproto.server.getSession` | access | `active`, `status`, `didDoc`, `email`, `emailConfirmed` |
| POST | `com.atproto.server.activateAccount` | access | a migrated account only once its DID names this PDS; then `#account` and `#sync` |
| POST | `com.atproto.server.deactivateAccount` | access | |
| GET | `com.atproto.server.checkAccountStatus` | access | migration progress |
| GET | `com.atproto.server.getServiceAuth` | access | `aud`, `exp` (at most an hour), `lxm`; createAccount (or no `lxm`) needs a privileged app password |
| GET | `com.atproto.identity.resolveHandle` | none | this PDS's handles, then DNS or HTTPS through the service URL checks |
| GET | `com.atproto.identity.getRecommendedDidCredentials` | access | |
| POST | `com.atproto.identity.requestPlcOperationSignature` | privileged | sends a notification; the code comes from the console |
| POST | `com.atproto.identity.signPlcOperation` | privileged | `token` from `POST /api/me/pds/plc-token`, and the fields to change |
| POST | `com.atproto.identity.submitPlcOperation` | access | the operation must name this PDS, the account's key, its rotation key and its handle |
| POST | `com.atproto.identity.updateHandle` | access | within the tenant's domain |
| POST | `com.atproto.repo.createRecord` | access | `repo`, `collection`, `rkey?`, `record`, `validate?`, `swapCommit?` |
| POST | `com.atproto.repo.putRecord` | access | `swapRecord` (null: must not exist) |
| POST | `com.atproto.repo.deleteRecord` | access | no change when absent |
| POST | `com.atproto.repo.applyWrites` | access | up to 200 writes, one commit |
| POST | `com.atproto.repo.uploadBlob` | access | the raw body |
| POST | `com.atproto.repo.importRepo` | access | a CAR file, deactivated (migrating) accounts only |
| GET | `com.atproto.repo.listMissingBlobs` | access | |
| GET | `com.atproto.repo.getRecord`, `listRecords`, `describeRepo` | none | |
| GET | `com.atproto.sync.getRepo` (`since?`), `getRecord`, `getBlocks`, `getBlob`, `listBlobs` (`since?`), `getLatestCommit`, `getRepoStatus`, `listRepos` | none | CAR files are `application/vnd.ipld.car` |
| WS | `com.atproto.sync.subscribeRepos` (`cursor?`) | none | the firehose; see below |

Reads of a repo that does not exist, is taken down or deactivated answer `RepoNotFound`, `RepoTakendown` or
`RepoDeactivated` (400).

Not in this release: `app.bsky.*` proxying to an AppView (clients that read timelines through the PDS need the
AppView configured on their side), `app.bsky.actor.getPreferences`/`putPreferences`, OAuth sign-in to the PDS, email
confirmation and password reset over XRPC (the console does those), `com.atproto.admin.*`, `deleteAccount`, and
`com.atproto.server.reserveSigningKey` (the migration uses `getRecommendedDidCredentials` after `createAccount`).

## Repositories (B-2902)

- The format is the AT-Protocol repository v3: records in a Merkle search tree (`server/src/atproto/pds/mst.ts`,
  rebuilt canonically from the record list on each commit), a signed commit `{ did, version: 3, data, rev, prev:
  null, sig }`, DAG-CBOR and CIDv1 (SHA-256), CAR v1 for exports. It is pinned byte for byte by the CC0
  `atproto-interop-tests` fixtures (key heights, the sync 1.1 commit proofs with their roots and proof blocks, the data
  model, lexicon and syntax vectors) and by vectors from `@atproto/repo` 0.11.0 (MST roots, and a signed repository
  read, verified and written again): `server/test/sprint31a-repo.test.ts` and `sprint31a-lexicon.test.ts`.
- The same code is the relay side's (B-3604, `server/src/atproto/commit.ts`): the firehose reads a `#commit`'s CAR with
  `pds/car.ts`, proves each operation with the MST walk in `pds/mst.ts` (`mstLookup`) and checks the signature over
  `pds/repo.ts`'s `commitSigningBytes`. There is one MST, CAR and commit encoding; the vectors in
  `server/test/fixtures/atproto/` (`sprint31b-feeds.test.ts`) run against it as well.
- Records are validated against their lexicon (`validate: true` requires a known lexicon, unset validates the known
  ones, `false` skips). The bundled lexicons are every Bluesky record type and what they reference
  (`server/src/atproto/pds/lexicon-docs.ts`, generated by `server/test/gen-lexicons.ts`). A record must be at most
  1 MiB; its blobs must be this account's and have passed the scan.
- A commit is one transaction: a compare-and-swap on the repo's `rev`, the records and the new blocks, the blocks
  nothing references any more deleted, and the `#commit` event sequenced. Writes are audited (`pds.repo.committed`:
  counts and collections, never the content).

## Blobs (B-2903)

`uploadBlob` streams into quarantine, sealed as file content is (`files/crypt.ts`, under the tenant key), counting the
size against the tenant's limit. Before it answers: the type is read from the bytes (PNG, JPEG, WebP, GIF, MP4) and
must be accepted for the tenant; ClamAV scans every byte when `CLAMD_HOST` is set (an unreachable scanner refuses the
upload, 503). Only then does the blob leave quarantine. A blob that fails is deleted and recorded as rejected
(`pds.blob.rejected`); no record can use it and `getBlob` never serves it. Blobs are served with their sniffed type,
`Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`. Blobs no record uses are deleted a day after their
upload (`pds.trim`, hourly).

## The firehose and relays (B-2904)

- Every commit, handle change and account state change is an event with the next `seq`, taken from a counter row as
  the last statement of the change's own transaction, so events become visible in seq order on PostgreSQL, MySQL and
  SQLite. `#commit` events carry `blocks` (a CAR with the commit, the new tree nodes, the new records and the covering
  proof of every operation), `ops` with each changed record's previous CID (`prev`), `prevData` (the previous tree
  root) and `since`, as sync 1.1 asks; `#identity`, `#account` and `#sync` as the reference PDS sends them.
- `subscribeRepos` without a cursor follows new events; with `cursor=N` it replays every event after N and then
  follows. A cursor past the newest event is `FutureCursor`; one older than `PDS_BACKFILL_HOURS` gets
  `#info OutdatedCursor` and starts at the oldest event kept. Events older than the window (and a day) are deleted. At
  most `PDS_SUBSCRIBERS_MAX` streams per instance; a consumer more than 16 MiB behind is dropped with
  `ConsumerTooSlow`. Every instance's subscribers hear of new events over the bus.
- After a change, `com.atproto.sync.requestCrawl` (`{ hostname }`) goes to each relay in `PDS_RELAYS`, at most every
  `PDS_CRAWL_MINUTES` per relay across instances, through the service URL checks. A platform admin can send it at once
  (`POST /api/admin/pds/crawl`).

## Deactivation, takedowns and migration (B-2905)

- Deactivation (by the account or a `pds:manage` admin) answers `RepoDeactivated`, ends the sessions, and sends
  `#account { active: false, status: "deactivated" }`. Activation reverses it.
- A takedown is a moderation action (B-1903) on the `pds-repo` object: `POST /api/admin/pds/accounts/{id}/takedown`,
  or a reviewer acting on a flag raised by a report of the repo. The repo answers `RepoTakendown`, its blobs are not
  served, its sessions end, `#account { status: "takendown" }` is sequenced, and the tenant's labeler (or the
  platform's, B-1610) publishes `!takedown` on the DID. The owner is told and may appeal; an upheld appeal or
  `POST /api/admin/pds/accounts/{id}/restore` restores the previous state and negates the label.
- Migration follows <https://atproto.com/guides/account-migration>. Into Exprsn-AI: `createAccount` with `did` and a
  service token, `importRepo` (the CAR must verify against the DID's current `#atproto` key: hashes, signature and
  canonical tree; the records are committed again with the new key), `listMissingBlobs` and `uploadBlob`,
  `getRecommendedDidCredentials`, the old PDS's `signPlcOperation`, `submitPlcOperation` (checked before it goes to
  the PLC directory), `activateAccount`. Out of Exprsn-AI: `getServiceAuth` (privileged), `getRepo`, `listBlobs` and
  `getBlob`, `signPlcOperation` with the code the console shows once (`POST /api/me/pds/plc-token`, recent sign-in,
  15 minutes), then `deactivateAccount`.

## Feed generator records (B-3004)

`POST /api/admin/pds/feed-generators` writes an `app.bsky.feed.generator` record naming the generator's service DID,
into a repo the PDS hosts for the tenant (`target.kind: hosted`, through the commit pipeline and lexicon validation)
or an external account (`target.kind: external`: an identifier and an app password used for this call only, the
account's PDS from `pdsUrl` or its DID document, every address through the service URL checks). The record is read
back and must name the DID. `PdsFeeds.publishRecord(by, tenantId, target, rkey, record)` takes a ready record value,
as the feed generator service builds it (`feedGenerators.recordFor(row, generatorDid)`), after which the caller records
the publication (`feedGenerators.markPublished`).

A feed defined under `/api/atproto/feeds` (B-3001 to B-3003) is published with `feedId` in place of the metadata:
`{target, feedId}`. The record is the generator's own for that feed (its record key, display name and description,
and `did` the tenant's AT-Protocol identity, the feed generator's service DID; `409` while the tenant has none), and
the feed then records the publication (`published: {did, uri, cid, at}`, audited `atproto.feed.published`), so its
`at://` URI is the published record's. Withdrawing the record (`POST /api/admin/pds/feed-generators/:id/withdraw`)
forgets the publication on every feed published as it (audited `atproto.feed.unpublished`); the feed's URI falls back
to the generator's DID. In code (`PdsFeeds.publishFeed`):

```ts
const g = await s.feedGenerators.generator(tenantId);
const out = await s.pds.feeds.publishRecord(by, tenantId, target, row.rkey, s.feedGenerators.recordFor(row, g.did));
await s.feedGenerators.markPublished(by, row, { did: out.repo, uri: out.uri, cid: out.cid });
```

## Labels, clearance and zones

- AT-Protocol content is public by protocol. Everything a PDS repository holds is labelled `public` in Exprsn-AI's
  terms, and the audit events of the PDS carry the label `public` (hosting changes `internal`).
- Nothing flows from the rest of Exprsn-AI into a repository: an account writes its own records and blobs, and B-3004
  writes generator metadata an admin types. No route copies conversations, files, knowledge or records of any label
  into a repo; such a feature would have to accept only `public` data.
- Hosting is refused where repositories cannot be public: an air-gapped deployment or a PDS zone without egress.
  Zones' label ceilings never block it (`public` is the lowest label), and clearance does not apply to reading a
  public repo.
- Labels about hosted repos are published through the tenant's labeler (B-1610): `!takedown` on takedown, withdrawn on
  restore. Labels from other labelers are not applied to what the PDS serves.

## Interoperability (B-2906)

`interop/run.ts` runs Exprsn-AI's PDS against the reference development environment (`@atproto/dev-env`'s PLC
directory and the Bluesky AppView with its data plane on PostgreSQL), in one process: it creates an account over XRPC,
writes a profile and a post, checks the exported repo with `@atproto/repo`'s `verifyRepoCar`, and waits until the
AppView, reading Exprsn-AI's `subscribeRepos` (and verifying each commit against the DID document and its proofs),
serves the post through `app.bsky.feed.getPosts` and the profile through `app.bsky.actor.getProfile`.

```sh
cd interop && npm ci && cd ..
INTEROP_PG_URL=postgres://user:pass@127.0.0.1:5432/db npx --prefix interop tsx interop/run.ts [--base-port 55601]
```

It uses ports `base` to `base+3`. CI runs it as the `interop` job against a PostgreSQL service container. In the
development environment the AppView reads the PDS directly, as it would a relay; a separate relay process
(`bluesky-social/indigo`) is not part of `@atproto/dev-env`, and the relay side is covered by the relay double in
`server/test/sprint31a-fakes.ts`.
