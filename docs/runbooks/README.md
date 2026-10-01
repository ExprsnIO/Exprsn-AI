# Runbooks

Operational procedures for Exprsn-AI. Each one covers Docker Compose (`deploy/docker/`), bare metal with systemd
(`deploy/baremetal/`) and Kubernetes with the Helm chart (`deploy/helm/exprsn-ai/`).

| Runbook | Use it when |
| --- | --- |
| [backup-restore.md](backup-restore.md) | Setting up backups, restoring after data loss, running a restore drill |
| [incident-response.md](incident-response.md) | Something is wrong: severity levels, the first 15 minutes, revoking access, rotating secrets and keys, disabling a tenant, audit forensics, guardrail emergency blocks, draining Ollama instances, the notice template |
| [upgrade.md](upgrade.md) | Moving to a new release, running migrations, rolling back, upgrading Ollama nodes |
| [alerts.md](alerts.md) | A Prometheus alert from `deploy/observability/prometheus/exprsn-ai.rules.yml` fired: what it means and what to do |

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
