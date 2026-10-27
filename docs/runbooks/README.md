# Runbooks

Operational procedures for Exprsn-AI. Each one covers Docker Compose (`deploy/docker/`), bare metal with systemd
(`deploy/baremetal/`) and Kubernetes with the Helm chart (`deploy/helm/exprsn-ai/`).

| Runbook | Use it when |
| --- | --- |
| [backup-restore.md](backup-restore.md) | Setting up backups, restoring after data loss, running a restore drill |
| [incident-response.md](incident-response.md) | Something is wrong: severity levels, the first 15 minutes, revoking access, rotating secrets and keys, disabling a tenant, audit forensics, guardrail emergency blocks, draining Ollama instances, the notice template |
| [upgrade.md](upgrade.md) | Moving to a new release, running migrations, rolling back, upgrading Ollama nodes |
| [emergency-seal.md](emergency-seal.md) | The keys must stop being usable now: sealing the vault on every instance (dual control or break-glass) and unsealing it with the escrow quorum (1.8.0) |
| [alerts.md](alerts.md) | A Prometheus alert from `deploy/observability/prometheus/exprsn-ai.rules.yml` fired: what it means and what to do |
| [db-move.md](db-move.md) | Moving the install's database onto a managed PostgreSQL (RDS, Azure, DigitalOcean) and rolling the move back (1.9.99-final) |
| [cloud-credential-compromise.md](cloud-credential-compromise.md) | A cloud credential may be in someone else's hands: disable the account, cut the trust or revoke the token, replace it, check what it did (1.9.99-final) |
| [cloud-stuck-operation.md](cloud-stuck-operation.md) | An apply, destroy or rollback waits on a provider operation that does not finish (`ExprsnCloudStepsStuck`) |
| [cloud-region-failover.md](cloud-region-failover.md) | A cloud region is down: fail over to a standby deployment in another region |
| [cloud-budget-exceeded.md](cloud-budget-exceeded.md) | A budget's forecast or actual spend passed it, or plans are refused with `budget_exceeded` |
| [cloud-spot-storm.md](cloud-spot-storm.md) | Many spot GPU nodes are reclaimed at once |
| [cloud-drift.md](cloud-drift.md) | A managed resource differs from its desired spec (`ExprsnCloudDriftOpen`) |
| [cloud-database-restore.md](cloud-database-restore.md) | A managed database must be restored from a snapshot (always to a new instance) |
| [cloud-sandbox-nightly.md](cloud-sandbox-nightly.md) | The nightly sandbox job (B-10804): what it does, its safety rules, how the owner enables it |

The cloud runbooks' API sequences for credential compromise, a stuck operation, budget exceeded and drift run against
the fakes in `server/test/runbooks.test.ts`; walking each one through against the sandbox accounts is the owner's step
(open decision 18).

## Conventions

- `exprsn-ai <command>` is the server's CLI, run with the same environment and secrets as the server:
  - Compose: `docker compose exec app node server/dist/cli.js <command>`
  - Kubernetes: `kubectl exec deploy/<release> -- node server/dist/cli.js <command>`
  - Bare metal: `node /opt/exprsn-ai/server/dist/cli.js <command>` as the `exprsn-ai` user, with the variables from
    `/etc/exprsn-ai/exprsn-ai.env` and `SESSION_SECRET_FILE`, `DATA_KEY_FILE` and `DATABASE_URL_FILE` pointing at the
    files in `/etc/exprsn-ai/credentials/` (the installer prints the full command line)
- The CLI's commands are `migrate`, `admin:create`, `audit:verify [--tenant <slug>]` and `kms:rotate [--tenant <slug>]`
  (the full list is `exprsn-ai --help`; 1.3.0 adds `migrate --check`, `kms:escrow` and `kms:recover`).
  `audit:verify` exits 2 when the chain or a signed checkpoint is broken.
- Console locations are written as screen names (Admin > Pools); the API routes behind them are in
  [api.md](../api.md) and [identity.md](../identity.md).
- Health: `/healthz` (process up), `/readyz` (database reachable and migrated, KMS and blob store answering; 503 while
  draining), `/metrics` (Prometheus, bearer `METRICS_TOKEN`).

Related: [deploy.md](../deploy.md) (configuration and deployment), [security.md](../security.md) (controls and known
gaps), [loadtest.md](../loadtest.md) (streaming load test and targets).
