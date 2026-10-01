# Alerts

What each alert in `deploy/observability/prometheus/exprsn-ai.rules.yml` means and what to do first. The dashboards in
`deploy/observability/grafana/` (overview and operations) show the same metrics over time; `deploy/observability/README.md`
explains how to load both. Every request and job also has a trace id (the `X-Trace-Id` header, problem details and log
lines); with `OTEL_EXPORTER_OTLP_ENDPOINT` set, the same id finds its trace in the tracing backend.

## ExprsnHighErrorRate

More than 5 % of requests answered 5xx for 10 minutes. Look at the logs for `unhandled error` lines and their
`trace_id`, and at `/readyz` on each instance: a database, KMS or blob store outage shows there first. If one route
dominates (the overview dashboard's "Slowest routes" and the logs' `req.url`), check the dependency it uses (Ollama
pools for chat, the OpenBao token for sealing). Follow [incident-response.md](incident-response.md) if it persists.

## ExprsnSlowRequests

The 95th percentile request time is above 2.5 s for 15 minutes. Streamed answers return at once and are not counted.
Usual causes: a saturated database pool (`DB_POOL_MAX`), a slow KMS (OpenBao) on every sealed read, or event loop lag
(see below). Traces show which span takes the time.

## ExprsnEventLoopLag

p99 event loop lag above 500 ms: the process is CPU-bound. Check for a large import, export or reindex running on the
web instances; split workers from web instances (`WORKERS_ENABLED=false` on web pods and a separate worker release) or
add replicas.

## ExprsnMemoryHigh

Resident memory above 1.5 GB for 15 minutes. Compare with the job and socket counts; a steady climb with flat traffic is
a leak worth a heap snapshot (`node --heapsnapshot-signal=SIGUSR2`). Raise the pod's memory limit only after looking.

## ExprsnSignInFailures

More than one failed sign-in a second for 10 minutes: password guessing, or a user store that stopped answering. Check
Admin > Audit for `auth.login.failed` by address and the lockout counters; for a store outage, "Test a login" under
Admin > User stores.

## ExprsnJobBacklog

A due job has waited more than 15 minutes. Check that some instance runs workers (`WORKERS_ENABLED`), that
`ExprsnSchemaBehind` is not firing (old instances refuse jobs by design), and with BullMQ that Redis answers. The
operations dashboard's "Jobs by state" shows whether jobs run at all.

## ExprsnJobsFailing

More than 10 jobs failed (after their retries) in the last hour. Admin > Usage and audit lists failed jobs with their
error; the most common cause is a dependency that refuses (Ollama, the trainer, a webhook receiver).

## ExprsnRateLimitsPerInstance

Redis is configured (`REDIS_URL`) but has not answered on this instance for a minute, so the rate limits, the
failed-credential throttle and the denial cap count per instance: a client spread over N instances gets N times each
limit. The Platform screen shows the same warning. Restore Redis; the warning clears by itself within
`RATELIMIT_PROBE_SECONDS` of Redis answering. The BullMQ queue, the bus and the Socket.io adapter also depend on Redis,
so expect slower job pickup (the database poll catches lost dispatches every 30 s) until it is back.

## ExprsnSchemaBehind

An instance runs a build older than the database's newest migration: a newer release migrated the database. That
instance takes no jobs and reports not ready on purpose. Normally this is a rolling upgrade in progress; if it lasts,
finish the rollout ([upgrade.md](upgrade.md)), or, if the new release was abandoned, restore the pre-upgrade backup
and roll every instance back. `exprsn-ai migrate --check` (exit 4) confirms which migrations the old build lacks.

## ExprsnZonePolicyDrift

With `ZONES_APPLY=kubernetes`, a zone NetworkPolicy in the cluster differs from what the server applied, or was
deleted. Zones (Applied in the cluster) names the policy and the first field that differs, and the audit chain has a
`zone.cluster.drift` event. If the change was an emergency fix, propose it as a zone change so it survives; otherwise
"Apply now" puts the approved policy back.

## ExprsnZonePolicyApplyFailing

Applying a zone NetworkPolicy failed for 15 minutes. The detail on the Zones screen carries the Kubernetes status:
403 means the service account lacks the Role in that namespace (`zonesApply.namespaces` in the chart), 404 a missing
namespace (the server does not create them), and no answer an egress policy without the API server
(`networkPolicy.egress.kubernetesApi`).

## ExprsnClockSkew

The median offset against the NTP servers is above 2 s; TOTP, Kerberos and certificate checks start failing at 5 s.
Fix time synchronisation on the node (chrony or systemd-timesyncd). Platform shows each NTP server's offset; a server
named as an outlier disagrees with the others and may be lying or misconfigured.

## ExprsnTraceExportDropping

The OTLP collector is slow, refusing or unreachable, so spans are dropped instead of held in memory. Requests are not
affected. Check the collector and `OTEL_EXPORTER_OTLP_ENDPOINT`; raise `OTEL_BSP_MAX_QUEUE_SIZE` only if the collector
is healthy but bursts exceed the queue, or lower `OTEL_TRACES_SAMPLE_RATIO`.
