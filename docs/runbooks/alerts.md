# Alerts

What each alert in `deploy/observability/prometheus/exprsn-ai.rules.yml` and, for the cloud plane (1.9.99-final,
B-10702), `exprsn-ai-cloud.rules.yml` means and what to do first. The dashboards in
`deploy/observability/grafana/` (overview, operations and cloud) show the same metrics over time; `deploy/observability/README.md`
explains how to load both. Every request and job also has a trace id (the `X-Trace-Id` header, problem details and log
lines); with `OTEL_EXPORTER_OTLP_ENDPOINT` set, the same id finds its trace in the tracing backend.

## ExprsnHighErrorRate

More than 5 % of requests answered 5xx for 10 minutes. Look at the logs for `unhandled error` lines and their
`trace_id`, and at `/readyz` on each instance: a database, KMS, blob store or (when it is configured) Redis outage shows there first. If one route
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

## Cloud plane (1.9.99-final, B-10702)

The cloud dashboard (`exprsn-ai-cloud.json`) shows each of these over time. Every cloud step is in the deployment's
operation journal (Deployments, a deployment, Operations) with its error and the provider's request id; the audit chain
has the same as `cloud.*` events. The full runbooks (B-10704): [credential compromise](cloud-credential-compromise.md),
[a stuck operation](cloud-stuck-operation.md), [a region outage](cloud-region-failover.md),
[budget exceeded](cloud-budget-exceeded.md), [a spot interruption storm](cloud-spot-storm.md), [drift](cloud-drift.md),
[restoring a database](cloud-database-restore.md).

## ExprsnCloudOperationsFailing

Three or more steps of one kind failed within 15 minutes. Open the journal of the deployments applying now: a `403`
names a missing permission (run the account's validation: it lists what each feature lacks), a `409` or `422` names a
spec the provider refuses, `unreachable` or `circuit_open` an outage (see ExprsnCloudBreakerOpen). Failed creates are
retried with the same idempotency key, so a retry never makes a second copy.

## ExprsnCloudApplyFailed

An apply ended failed. The deployment is marked failed and offers a rollback to its last verified state. Read the
failing step's error in the journal, fix the spec or the permission, and plan again; the new plan resumes from what
exists.

## ExprsnCloudApplySlow

Successful applies take more than an hour at the 90th percentile. Clusters, node groups and databases take tens of
minutes on every provider; more than that usually means throttling (the throttling panels) or a long-running operation
that is polled at its maximum interval.

## ExprsnCloudStepsStuck

Steps have waited on a provider's long-running operation for hours. Queue `cloud.poll` for the deployment (Operations,
Jobs) if no poll runs; if the provider shows the operation finished, the next poll settles it; if the provider lost it,
cancel the apply and plan again.

## ExprsnCloudThrottled

More than a fifth of the calls to one provider were throttled or held by the local limiter for 15 minutes. Applies and
drift slow down but complete. Lower `CLOUD_DRIFT_MINUTES` pressure (fewer drift runs), spread applies, or raise the
provider's quota; the limiter's own rates are in `docs/cloud.md`.

## ExprsnCloudBreakerOpen

A provider account's circuit breaker stayed open for 10 minutes: its calls fail fast. Check the provider's status page
and the account's validation (an expired or revoked credential trips it too). It closes by itself after a successful
half-open call.

## ExprsnCloudDriftOpen

A drift finding stayed undecided for six hours. Open the deployment's drift findings and revert (plan back to the
desired state), adopt (make the observed state the desired one) or ignore the field. An unexplained change to a firewall
or a role is a security event: follow [incident-response.md](incident-response.md).

## ExprsnCloudBudgetForecastOver

An account's forecast passes its monthly budget. Scale down (GPU pools to their minimum or to zero), destroy what is
not needed, or raise the budget, before actual spend reaches it and the hard stop refuses plans that add cost.

## ExprsnCloudBudgetHardStop

The hard stop is engaged: plans that add monthly cost are refused with `budget_exceeded`. Scale-down and destroy still
run. Raise the budget, wait for next month, or have two FinOps admins propose and approve an override (at most 7 days).

## ExprsnCloudCostIngestFailing

No billing cost fetch for one provider has succeeded for a day (job `cloud.costs.ingest`, audit `cloud.costs.failed`
with the provider's error). Usually the billing credential lacks a permission (Cost Explorer, Cost Management Reader,
the DigitalOcean billing scope) or was revoked: run the account's validation. After three days without billing data
the budgets use estimates again, which the cloud dashboard's spend source panel shows.

## ExprsnCloudGpuIdle

GPU nodes have been provisioned for three hours without serving a healthy gateway pool instance. Scale the pool down or
to zero, or join the nodes to a pool if they were meant to serve. Until Sprint 60 (B-104) a node of a GPU node group is
always counted idle, since it cannot be matched to a gateway instance yet.

## ExprsnCloudSpendAnomaly

A service's daily spend in a cloud account is well above its 14-day baseline (B-10606, job `cloud.anomalies.detect`
after each billing fetch): at least four robust deviations (median and MAD), 50 % and 50 in the account's currency
above the median. Open Cloud spend, Anomalies (`#/cloud-spend?tab=anomalies`): the inspector names the top
contributors with their extra over their own baseline (the deployment, the region, the `exprsn:` tags, the service),
and the audit event `cloud.anomaly.detected` has the same. Typical causes are traffic through a NAT gateway after a
node replacement (image pulls; a gateway endpoint for the registry keeps them inside the VPC), a batch through a cloud
model profile, or a resource left running. Fix the cause, then acknowledge the anomaly with a note: repeat notices for
the same account and service stop for three days, and the alert clears once no anomaly of the last seven days is open.
