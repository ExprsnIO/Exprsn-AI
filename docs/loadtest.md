# Load test of the streaming path

`server/loadtest/stream.ts` measures the chat streaming path end to end: a signed-in user posts a message
(`POST /api/chat`), the gateway queues it for a slot on an Ollama instance, and the answer streams back over Socket.io
as `chat.status`, `chat.chunk` and `chat.done` events. Each simulated user has its own session and socket and sends its
messages one after another, so the number of users is the number of concurrent streams.

The script lives outside `server/src` and `server/test`: it is not built into the image and not part of `npm test`,
`npm run lint` or `npm run typecheck`. It uses only packages already in the workspace (`socket.io-client`, `otplib`,
`tsx`) and the test helpers.

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
| `--max-error-rate`, `--max-p95-ttft-ms`, `--max-p99-ttft-ms`, `--max-p95-total-ms`, `--min-tokens-per-s` | error rate 0.01 | Thresholds |
| `--json` | | Summary as JSON |

## Limits of the measurement

- The in-process harness uses SQLite in memory and the local KMS. PostgreSQL or MySQL, OpenBao and Redis add network
  round trips to every sealed chunk and every bus message; measure a staging stack before sizing production.
- A single load-generator process tops out at a few thousand sockets; start several with different account lists for
  more.
- The fake Ollama streams at a fixed rate and does not model GPU memory pressure or model loads beyond the first. The
  gateway's memory planner, anti-thrash limit and rolling upgrades need real instances to measure.
