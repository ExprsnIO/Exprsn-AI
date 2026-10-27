# Load test of the streaming path

`server/loadtest/stream.ts` measures the chat streaming path end to end: a signed-in user posts a message
(`POST /api/chat`), the gateway queues it for a slot on an Ollama instance, and the answer streams back over Socket.io
as `chat.status`, `chat.chunk` and `chat.done` events. Each simulated user has its own session and socket and sends its
messages one after another, so the number of users is the number of concurrent streams.

The script lives outside `server/src` and `server/test`: it is not built into the image and not part of `npm test` or
`npm run lint` (CI lints `server/loadtest` separately; `npm run typecheck` covers it). It uses only packages already in
the workspace (`socket.io-client`, `otplib`, `tsx`) and the test helpers. `npm run loadtest -- <options>` runs it from
the repository root.

Since 1.4.0 a second script, `server/loadtest/platform.ts`, measures the event and data paths: webhook fan-out,
low-code record writes, the OCSP responder and firehose ingest. See [Platform scenarios](#platform-scenarios-140).

## What it reports

| Measurement | Meaning |
| --- | --- |
| `POST /api/chat (ms)` | Round trip of the request that starts the answer: authentication, CSRF, rate limit, guardrail input check, conversation insert, gateway admission. The answer is `202` before any token |
| `time to first token (ms)` | From sending the request to the first `chat.chunk` for that message. Includes queueing for a slot, a cold model load, and the first token from Ollama |
| `answer complete (ms)` | From sending the request to `chat.done` |
| `stream tokens/s` | Output tokens of one answer (from `usage.outputTokens` on `chat.done`) over the time from its first chunk to `chat.done` |
| aggregate tokens/s, answers/s | Totals over the measured window (after every user has signed in and connected) |
| errors | Non-`202` answers, answers that end in a state other than `complete`, and answers that time out, grouped by reason |
| queued for a slot | Answers that waited for an instance slot (a `chat.status` with a queue position) |

Percentiles are nearest-rank p50, p95 and p99. `--json` prints the same summary as JSON for CI or a spreadsheet.

## In-process run (no services needed)

The default builds the server exactly as the tests do (`server/test/helpers.ts`: in-memory SQLite, local KMS, a
temporary blob directory), starts one or more fake Ollama instances (`server/test/fake-ollama.ts`), seeds a pool with
an approved model and a published profile, creates the users as tenant members and listens on a random local port:

```sh
npx tsx server/loadtest/stream.ts --users 50 --messages 4
npx tsx server/loadtest/stream.ts --users 200 --messages 2 --parallel 8 --instances 4 --reply-words 128 --delay-ms 15
```

This exercises everything on the server side of the stream (sessions, guardrail checks, the gateway's slot leases and
queue, sealing each chunk at rest, the Socket.io fan-out and metering) without a GPU. The fake instance answers each
request with `--reply-words` tokens, `--delay-ms` apart, and serves `--parallel` requests at a time; everything above
that waits in the gateway's queue. In-process, each simulated user signs in from its own documentation address
(`198.18.0.0/15`) through `X-Forwarded-For`, which the harness trusts on loopback, so the sign-in rate limit (30 a
minute per address) does not slow the setup.

Sample output (a laptop, 50 users, 4 parallel slots, 64-word answers at 10 ms per token):

```
Signed in and connected 50 of 50 users in 2.2 s against http://127.0.0.1:33135.

Messages 200, completed 200, errors 0 (0.00 %), queued for a slot 196
Wall time 34.1 s, 5.87 answers/s, 375.5 tokens/s aggregate

                                  p50      p95      p99      max
  POST /api/chat (ms)            13.7    380.5    434.0    444.5
  time to first token (ms)     7556.6   8157.3   8231.4   8402.4
  answer complete (ms)         8223.4   8833.4   8907.2   9072.3
  stream tokens/s                94.4     96.2     97.0     97.3
```

Here the fake instance is the bottleneck on purpose: four slots of about 0.65 s each serve 200 answers, so time to
first token is queueing time. With `--parallel 8 --ramp-ms 2000` and 20 users the same machine shows p95 time to first
token near 20 ms and p95 `POST /api/chat` near 17 ms, which is the server's own overhead. At the 1.0 target settings
below (50 users, 64 slots) the same machine measured p95 `POST /api/chat` 38 ms, p95 time to first token 62 ms, p99
77 ms and a median of 75 tokens/s per stream against a nominal 100.

## Against a running stack

1. Start the stack, for example the development Compose file:

   ```sh
   docker compose -f deploy/docker/compose.dev.yml up --build
   ```

2. Start a fake Ollama where the application can reach it, and leave it running:

   ```sh
   npx tsx server/loadtest/stream.ts --fake-ollama 11500 --reply-words 64 --delay-ms 20
   ```

   From the Compose containers the host is `http://host.docker.internal:11500` on Docker Desktop, or the Docker bridge
   gateway address (often `http://172.17.0.1:11500`) on Linux. To measure real inference instead, skip this step and
   use a pool of real Ollama instances.

3. In the console, as a pool and model admin: register the URL as an instance of a new pool (Admin > Pools), approve
   the model `llama3.1:8b` and place it on that pool (Admin > Models; the fake instance lists it and answers a pull),
   and publish a profile named `general` on it (Admin > Profiles). Give the profile a label the load-test users are
   cleared for.

4. Run the load against accounts that can use the profile. Accounts that must present a second factor need their TOTP
   secret after a second colon; accounts that still have to enrol one cannot be used.

   ```sh
   LOADTEST_USERS='jlee:Northwind-Dev-Password-2,apatel:Northwind-Dev-Password-3' \
     npx tsx server/loadtest/stream.ts --url http://localhost:8080 --profile general --users 40 --messages 5
   ```

   The account list is reused round-robin, so 40 users over two accounts means 20 sessions per account, each with its
   own socket. Sign-ins beyond 30 a minute from one address wait for the limiter's `Retry-After`. The general API
   limit (600 requests a minute per user) and the tenant's quotas (Admin > Tenants) also apply; raise the quota of the
   test tenant or use more accounts for long runs.

Run the load generator on a different machine from the server when measuring a production-shaped deployment, and
watch `/metrics` (gateway queue depth, slot use, socket connections, event-loop lag) during the run.

## Targets for 1.0

These are the release targets, measured against the in-process harness on a CI runner (they bound the server's own
overhead, since the fake instance's speed is fixed) and against a staging stack with real GPUs (where time to first
token also includes model speed):

| Target | In-process, 50 users, `--parallel 16 --instances 4` (64 slots, no queueing) | Staging, per GPU instance at its configured parallelism |
| --- | --- | --- |
| Error rate | 0 % | below 1 % |
| p95 `POST /api/chat` | below 100 ms | below 250 ms |
| p95 time to first token | below 250 ms | below 1.5 s with the model warm and a free slot |
| p99 time to first token | below 500 ms | below 3 s |
| p50 stream tokens/s | at least 70 % of the fake instance's nominal rate (1000 / `--delay-ms`; one user alone reaches about 93 % of it) | at least 90 % of the same model's rate measured directly against Ollama with one client |
| Queueing | answers beyond the pool's slots wait and complete, none fail, until `OLLAMA_QUEUE_TIMEOUT_MS` | same |

Thresholds are options, and the script exits 1 when one is exceeded:

```sh
npx tsx server/loadtest/stream.ts --users 50 --messages 4 --parallel 16 --instances 4 \
  --max-error-rate 0 --max-p95-ttft-ms 250 --max-p99-ttft-ms 500 --min-tokens-per-s 70
```

Exit codes: `0` every threshold holds, `1` a threshold is exceeded, `2` the setup failed (no user could sign in, or the
in-process server did not start).

## Guard model while streaming (Sprint 16)

`--guard-model` also publishes a guard-model rule at `model-output` (the fake guard model answers "safe"), so every
answer is checked in the background while it streams; `--holdback <n>` sets `CHAT_GUARD_HOLDBACK_SENTENCES` and
`--sentence-words <n>` puts a sentence end every n words in the fake answers. Measured in-process on a laptop, 20
users, 3 messages each, 64-word answers with a sentence every 8 words, 10 ms per token:

| Pool | Screening | Time to first token p50 / p95 | Answer complete p50 / p95 | Answers/s |
| --- | --- | --- | --- | --- |
| 64 slots (no queueing) | none | 80 / 86 ms | 734 / 749 ms | 22.3 |
| 64 slots | guard model, hold-back 0 | 78 / 83 ms | 716 / 730 ms | 22.8 |
| 64 slots | guard model, hold-back 1 | 88 / 94 ms | 710 / 741 ms | 22.8 |
| 8 slots | none | 917 / 1446 ms | 1572 / 2098 ms | 10.2 |
| 8 slots, the guard model on the same pool | guard model, hold-back 0 | 603 / 1146 ms | 1562 / 2672 ms | 9.9 |
| 8 slots, the guard model on the same pool | guard model, hold-back 1 | 1509 / 1962 ms | 1561 / 2690 ms | 10.0 |

With free slots, hold-back 1 costs about one guard-model call on the first sentence and nothing on throughput. When
the guard model competes for the same saturated pool as the answers, its checks queue behind them: nothing
deadlocks (the generation never waits for a verdict) and throughput holds, but the text of each answer arrives at the
end, after the full check. Serve the guard model from its own pool (or give it reserved slots) to keep streaming
smooth; `CHAT_GUARD_STREAM_CONCURRENCY` caps the background checks one instance runs at once.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--url` | (in-process) | Target a running server; accounts come from `LOADTEST_USERS` (`user:password[:totp-secret],...`) |
| `--users` | 20 | Concurrent users, each with a session and a socket |
| `--messages` | 5 | Messages per user, one after another |
| `--think-ms` | 0 | Pause between a user's messages |
| `--ramp-ms` | 2000 | Spread the users' first messages over this window |
| `--profile` | `general` | Profile to chat with |
| `--prompt` | a short request | Message text (a counter is appended) |
| `--tenant` | the server's `DEFAULT_TENANT` | Tenant to sign in to |
| `--timeout` | 120000 | Give up on one answer after this long (in-process also sets `OLLAMA_QUEUE_TIMEOUT_MS`) |
| `--reply-words` | 64 | Tokens in each fake answer |
| `--delay-ms` | 10 | Delay between fake tokens |
| `--parallel` | 8 | Parallel requests per fake instance (in-process) |
| `--instances` | 1 | Fake instances in the pool (in-process) |
| `--fake-ollama <port>` | | Only run a fake Ollama on that port, for a pool instance in a running stack |
| `--sentence-words` | 0 | End a sentence every n words of the fake answer |
| `--guard-model` | off | Publish a guard-model rule at `model-output` (in-process), so answers are checked while they stream |
| `--holdback` | the server's default | `CHAT_GUARD_HOLDBACK_SENTENCES` for the in-process server |
| `--max-error-rate`, `--max-p95-ttft-ms`, `--max-p99-ttft-ms`, `--max-p95-total-ms`, `--min-tokens-per-s` | error rate 0.01 | Thresholds |
| `--json` | | Summary as JSON |

## Platform scenarios (1.4.0)

`server/loadtest/platform.ts` (B-2105) loads the paths 1.4.0 added or made busier: plugin and record events fanned out
to webhooks, low-code records, the certificate authority's OCSP responder and AT-Protocol firehose ingest (the "Event
volume" risk in `Backlog-1.4.0.md`). The application runs in a process of its own, `server/loadtest/platform-server.ts`,
started the way `src/index.ts` starts it: configuration from the environment, migrations, bootstrap, the HTTP app, the
job workers and every schedule. Next to it runs the signer (`exprsn-ai signer`, its own process, holding the
key-encryption key, the CA keys and the labeler key). The script itself is the outside world: a webhook receiver, a
Jetstream, OCSP relying parties and the users of a low-code app. It seeds a workspace, users, an app with an entity of
indexed and unique fields, a root and a tenant intermediate (P-256) with 40 leaf certificates (4 revoked), a
moderation rule set and the tenant's labeler, then runs the scenarios in order. The application is asked for counts it
cannot be observed for from outside (breaker state, the firehose queue, moderation objects) over the `fork` IPC channel.

```sh
npm run loadtest:platform                                   # every scenario, SQLite in memory, a free port
npm run loadtest:platform -- --db postgres://postgres@127.0.0.1:55478/load --port 55471
npm run loadtest:platform -- --scenarios ocsp,firehose --duration 10 --json
```

`--db` takes `sqlite` (the default, in memory) or a `postgres://` or `mysql://` URL of an **empty** database (the run
seeds a fresh tenant; drop and create the database between runs). Exit codes: `0` every target met, `1` a target
missed, `2` the setup failed.

| Scenario | What happens | What is measured |
| --- | --- | --- |
| Webhook fan-out | `--endpoints` webhooks (default 10) subscribe to `record.*`; `record.created` events are emitted at `--events-per-s` (default 10) for `--duration` seconds, so 100 deliveries a second. Phase 1: every endpoint answers at once. Phase 2: the last endpoint answers after `--slow-ms` (3 s), past `WEBHOOK_TIMEOUT_MS` (1 s in the run) | Latency from the delivery being queued to the receiver having it, for the healthy endpoints; deliveries a second; lost and duplicate deliveries; HMAC signatures checked on every delivery; in phase 2 how many attempts reach the slow endpoint and whether its breaker opened (once) |
| Record writes | `--concurrency` clients (16) over `--users` signed-in members (128, so the per-user API limit is not what is measured; 64 were enough until the queries got faster in 1.5.0). Phase 1 creates records (one in 25 reuses an existing title in another case, which must be refused as a duplicate); phase 2 updates the indexed `amount` and `stage`; phase 3 runs filtered, sorted, paged queries on indexed fields (an `and` of an enum and a number range, a title prefix, a date range with an offset) | Requests a second and latency per phase, and the query p95 of each of the three query bodies; duplicates refused and accepted; records stored against records created |
| OCSP | `--concurrency` relying parties post requests for the 40 serials to `/pki/ocsp`, each from its own documentation address (the public limit is per address). Phase 1 sends a nonce, so every answer is built and signed by the delegated responder key in the signer; phase 2 sends none, so the responder's cache answers | Signed answers a second and latency; every answer is parsed and its status (good or revoked) checked |
| Firehose | A fake Jetstream holds `--posts` posts (20,000, one in ten with a pattern the moderation rule flags) and sends them as fast as the socket takes them. A third of the way it drops the connection (as a relay drops a slow consumer); two thirds of the way the subscription is stopped and started (as a restart does). Every post goes through the moderation check | Posts checked a second from the first connection to the last cursor; posts lost and checked twice (from `moderation_objects`); the consumer queue's maximum against `FIREHOSE_QUEUE_MAX` (1000), how often the socket was paused, and that every reconnection asked for a cursor |

The run sets `WEBHOOK_TIMEOUT_MS=1000`, `WEBHOOK_RETRY_BASE_MS=1000`, a breaker cool-down of four times `--duration`
(so the open breaker stays open through the phase), `FIREHOSE_TICK_MS=1000`, `FIREHOSE_CHECKPOINT_MS=1000` and
`FIREHOSE_BACKOFF_MAX_MS=1000`; everything else, including `JOB_CONCURRENCY` (4) and `JOB_POLL_MS` (1000), keeps the
application's defaults (`--job-concurrency` and `--job-poll-ms` change them). `JOB_QUEUE=db`: the reference setup has no
Redis.

### Reference setup

The targets are judged on this setup, which is a developer workstation rather than a server, and the numbers below
come from it:

- Apple M2 Max (12 cores), 32 GB, macOS. For 1.4.0's runs the project, its `node_modules` and Node 24 lived on an
  external USB drive, where start-up and the first module loads are slow (seeding took from 2 to 250 s between runs);
  for 1.5.0's on the internal SSD (seeding about 5 s). The measured phases run from memory either way.
- PostgreSQL 18.6 from the project toolchain, a throwaway cluster (`initdb`, `pg_ctl`) with its data on the internal
  disk under `/private/tmp`, default settings except `max_connections=100`; the application's pool is the default
  `DB_POOL_MAX=10`.
- The load generator, the application, the signer and PostgreSQL on the same machine, over loopback. The machine was
  shared with other builds and test runs while measuring, so single runs vary (see the records query below); the
  table gives a representative run.

A CI or reference server (Linux, 4 or more dedicated cores, PostgreSQL on its own SSD, the generator on another host)
is expected to do at least as well on latency; throughput there is bounded by the database for records and the
firehose, and by the job slots for webhooks. CI runs the scenarios on SQLite in memory on a shared runner with the
`ci` target set (`--targets ci`: latencies times three, rates divided by three).

### Targets and results

PostgreSQL, the reference setup, default options (15 s per phase), two full runs on fresh databases with 1.5.0 (the
record query changes of B-3601; each run delivers 2850 webhooks, writes about 31,000 records, answers about 320,000
OCSP requests and checks 20,000 posts):

| Target | Reference | Run 1 | Run 2 |
| --- | --- | --- | --- |
| Webhooks: healthy endpoints, p95 queued to received | below 500 ms | 6 ms | 8 ms |
| Webhooks: healthy endpoints while one hangs, p95 | below 2 s | 107 ms (p99 647) | 117 ms (p99 647) |
| Webhooks: deliveries a second (100 offered) | at least 90 | 100 | 100 |
| Webhooks: lost deliveries | none | 0 of 2850 | 0 of 2850 |
| Webhooks: attempts reaching the hanging endpoint | at most 8 (the breaker threshold of 5, plus attempts in flight when it opens) | 6, breaker opened once | 6, breaker opened once |
| Records: p95 create, p95 update | below 100 ms | 18.3 ms, 18.5 ms | 19.0 ms, 19.2 ms |
| Records: writes a second | at least 300 | 1020 (create 1059) | 991 (create 1014) |
| Records: p95 filtered query (about 15,500 records, 50 a page) | below 250 ms | 65 ms (420 a second) | 62 ms (465 a second) |
| Records: errors (a duplicate accepted, a failed request, a record missing) | none | 0 (661 duplicates refused) | 0 (633 duplicates refused) |
| OCSP: signed answers a second, p95 | at least 1000, below 50 ms | 6513, 3.9 ms | 6524, 4.0 ms |
| OCSP: cached answers a second | at least 3000 | 14836 | 14877 |
| OCSP: wrong or failed answers | none | 0 | 0 |
| Firehose: posts checked a second | at least 300 | 1042 | 1062 |
| Firehose: posts lost, posts checked twice | none | 0, 0 | 0, 0 |
| Firehose: queue above `FIREHOSE_QUEUE_MAX` | at most 250 (one socket read) | 95 (max 1095, paused 23 times) | 87 (max 1087, paused 22 times) |

The rates are well above today's needs on purpose: Bluesky's whole network creates on the order of tens of posts a
second, and a tenant's webhooks see the events of its own users. The targets leave room for a slower server.

**Status.** Every target is met on PostgreSQL in both runs (2026-10-05, the project on the internal SSD; other
sessions' builds and tests may have shared the machine). 1.4.0 missed one: the records query p95, 121 ms in its first run but 758 ms and, in a confirming run on a
quiet machine, 732 ms in the others; the cause and the fix (B-3601, 1.5.0) are in the query note below. The full
SQLite run with `--targets ci`, as CI runs it, meets every target too (records query p95 95 ms against 750 ms; it was
359 ms with 1.4.0). MySQL is not measured.

The record query p95 of each query body, PostgreSQL, the records scenario alone (`--scenarios records`) and the full
runs above:

| Query body | 1.4.0, no planner statistics yet | 1.4.0, with statistics | 1.5.0, no statistics (autovacuum off) | 1.5.0, full runs 1 and 2 |
| --- | --- | --- | --- | --- |
| `stage` eq and `amount` gte, by `amount` desc, 50 a page | 740 ms | 138 ms | 72 ms | 71, 68 ms |
| `title` startsWith, by `title` asc, 25 a page | 575 ms | 80 ms | 39 ms | 36, 35 ms |
| `due` range, by `due` asc, 50 a page at offsets 0 to 200 | 618 ms | 101 ms | 55 ms | 52, 50 ms |
| All three (the target) | 704 ms (28 a second) | 128 ms (183 a second) | 67 ms (359 a second) | 65, 62 ms |

A heavier webhook run (`--events-per-s 50`, 500 deliveries a second, PostgreSQL) delivered 5000 of 5000 at 496 a
second with p95 4 ms, and while one endpoint hung 4500 of 4500 with p95 847 ms (the one-timeout dip described
below), 6 attempts on the hanging endpoint.

### What the load test found and fixed

- **The database job queue ran at most `JOB_CONCURRENCY` jobs per `JOB_POLL_MS`.** Each poll claimed up to four jobs
  and waited for all of them to finish before the next poll a second later, so every webhook delivery, export and
  other job queued behind it, and one slow job held the other slots idle. The first run measured 2.9 deliveries a
  second and a p95 of 21.7 s (4 endpoints, 4 events a second). The queue (`platform/jobs.ts`) now starts claimed jobs
  without waiting for them, fills a slot again as soon as a job finishes, and starts a job queued on this worker at
  once when a slot is free; the poll only finds jobs that became due later or were queued elsewhere. BullMQ mode is
  unchanged.
- **Concurrent failures of one endpoint were lost and the breaker opened late and more than once.** Each attempt wrote
  the failure count it had read before sending, so four attempts timing out together counted as one; the breaker
  opened after about 20 attempts and each straggler announced it again (audit event and admin notice). The count now
  goes up in the database, only the attempt that moves the breaker from closed to open announces it, and only the one
  that finds it open closes it.
- **A failing endpoint could take every job slot.** While its breaker is still closed, an endpoint whose last attempt
  failed now gets at most half the job slots (`JOB_CONCURRENCY / 2`, at least one) from an instance; its other
  deliveries wait until the oldest attempt has had its timeout. Healthy endpoints are not limited.

- **Record queries depended on the planner's statistics, and sorted every match (B-3601, 1.5.0).** The records
  scenario queries an entity whose 15,000 records were all written in the 30 seconds before; PostgreSQL's autovacuum
  visits a database about once a minute, so whether the tables had statistics when the queries ran was chance. Without
  them every condition looks as if it matches one row, and the plan read the entity's records in full from the
  `(tenant_id, entity_id)` index, looked up each condition's value row per record, then sorted every match on
  `case when … is null` keys and a `COLLATE "C"` expression no index provides (about 200 ms of database time per page
  and 80 to 140 ms for its count; 28 queries a second, p95 704 ms). With statistics the same queries took 7 to 40 ms,
  which is why runs varied between 106 and 758 ms. Now (`apps/query.ts`, migration `031b_record_queries`):
  - A page sorted on a value field starts from that field's rows in the value index, `(entity_id, field, v_num,
    record_id)` or `(entity_id, field, v_norm COLLATE "C", record_id COLLATE "C")` (on PostgreSQL partial, `where …
    is not null`), reads them in order and stops at the page; the filter's top-level conditions on the same field are
    tested on that index row (a range or prefix becomes the index range), the others by the value primary key, and
    the record by its primary key. Records without a value come after, in a second query only reached when the first
    runs out. Before: 200 ms; now 0.1 to 7 ms a page, with or without statistics.
  - The count starts from the most selective-looking top-level condition (equality, then lists, prefixes and ranges)
    in the same way, instead of from every record of the entity: 4 to 30 ms.
  - The record itself is matched by tenant but no longer by entity (the value row's entity is the record's), so the
    planner has no index on `app_records` to prefer over the primary key when it has no statistics; without that, the
    first version of this change scanned the entity's records once per value row (100 s queries).
  - Empty values sort last with `NULLS LAST` on PostgreSQL (MySQL and SQLite keep a `case` key; they have no `NULLS
    LAST` or sort NULL first), text compares and sorts with `COLLATE "C"` there, as its indexes are built, and keyset
    paging (`cursor`, `nextCursor`) keeps every page as cheap as the first. SQLite, MySQL and PostgreSQL give the same
    rows in the same order (`server/test/integration/apps.test.ts`: the 19 queries of 1.4.0 and six more, each also
    paged one and three records at a time by cursor and by offset).
- **The harness's 64 users ran into the per-user API limit** (600 requests a minute) once queries got faster: the
  writes of the first two phases use most of each user's minute. The default is now 128 users.

Not fixed, and why:

- When an endpoint starts hanging, its first attempts can still hold every job slot for one `WEBHOOK_TIMEOUT_MS` before
  the first failure marks it (the dip in phase 2: p99 about 640 ms with a 1 s timeout). With the default 10 s timeout
  the other endpoints' deliveries can wait up to 10 s once. Lower `WEBHOOK_TIMEOUT_MS`, or raise `JOB_CONCURRENCY`, where
  that matters; a per-endpoint queue is the real fix and is left for a later release.
- A record query still counts every match for `total`, on every page and when paging by cursor too: the count now
  starts from one condition's index rows, but it grows with the matches (30 ms for 2,700 of 15,500 records). An
  estimated or optional total is left for a later release (the export job already counts only once).
- The firehose queue can pass `FIREHOSE_QUEUE_MAX` by the messages of the socket read under way when it pauses (about
  100 to 200 posts); it stays bounded.

## Limits of the measurement

- The platform scenarios run the load generator, the application, the signer and the database on one machine; the
  generator competes for CPU with what it measures. Run it from another host against a staging stack before sizing.
- The in-process harness uses SQLite in memory and the local KMS. PostgreSQL or MySQL, OpenBao and Redis add network
  round trips to every sealed chunk and every bus message; measure a staging stack before sizing production.
- A single load-generator process tops out at a few thousand sockets; start several with different account lists for
  more.
- The fake Ollama streams at a fixed rate and does not model GPU memory pressure or model loads beyond the first. The
  gateway's memory planner, anti-thrash limit and rolling upgrades need real instances to measure.
