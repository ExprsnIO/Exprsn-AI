# The nightly sandbox job (1.9.99-final, B-10804)

`exprsn-ai cloud:sandbox-run` runs one cycle on each dedicated sandbox account (AWS, Azure, DigitalOcean, Cloudflare;
open decision 18: the owner's accounts, capped at their monthly budget): deploy a small graph (a network and a firewall;
an R2 bucket on Cloudflare), verify, introduce drift by hand at the provider (SSH opened on the firewall; the bucket
deleted on Cloudflare), detect and revert it, upgrade (a reviewed plan that changes the graph in place), verify again,
destroy, and check that nothing tagged for the account is left. A sweeper before and after deletes what carries the
account's `exprsn:managed` and `exprsn:account` tags and is older than a day. `.github/workflows/cloud-nightly.yml`
runs it at 03:17 UTC. The code is `server/src/cloud/sandbox-run.ts` and `server/src/cli/cloud-sandbox.ts`; the tests
(`server/test/cloud-sandbox-run.test.ts`) run the whole cycle against the DigitalOcean and Cloudflare fakes only.

## Safety

- **Sandbox accounts only.** An account needs `cloud_accounts.sandbox` (migration `167_cloud_sandbox_flag`, not
  registered yet; without it every account is refused). Marking (`--mark`) needs a budget and refuses an account that
  holds any deployment the job did not make.
- **Never past the budget.** An account without a budget, or at or past it (actual or forecast), is refused before any
  provider call; the budget is asked again before deploy and upgrade, and an override never counts. Past it, the cycle
  goes straight to destroy and the sweep.
- **Never untagged resources.** The sweeper lists with the adapters' managed-only filter and checks the tags again
  (or, where the provider keeps none, the `exprsn-<account>-` name prefix); databases are never swept (destroy takes
  their final snapshot). A resource whose age the provider does not report is recorded when first seen and deleted a
  day later, never sooner.
- `--dry-run` changes nothing: the checks and the list of what the sweeper would delete.

## Enabling it (the owner's steps)

1. A separate control plane for the sandbox (its own database and `DATA_KEY`), never production's.
2. Apply migration `167_cloud_sandbox_flag` there (register it in `server/src/db/migrations/index.ts` when it is
   scheduled), add the four accounts with their credentials, validate them, and set each budget:
   `PUT /api/admin/cloud/accounts/:id/budget` with `{"amount":500,"hardStop":"actual"}`.
3. Mark them: `exprsn-ai cloud:sandbox-run --mark <id> --as <username>`.
4. Try once by hand: `exprsn-ai cloud:sandbox-run --accounts <id,id,id,id> --as <username> --dry-run`, then without
   `--dry-run`.
5. In GitHub: an environment `cloud-sandbox` with the secrets `SANDBOX_DATABASE_URL`, `SANDBOX_DATA_KEY`,
   `SANDBOX_SESSION_SECRET`; the variables `CLOUD_SANDBOX_ACCOUNTS` and `CLOUD_SANDBOX_AS`; then
   `CLOUD_SANDBOX_ENABLED=true`.
6. Done when seven nightly runs in a row pass with nothing left: `exprsn-ai cloud:sandbox-run --history <id>`
   (`consecutivePasses`); each run's report is the `sandbox-report` artifact and a `cloud_sandbox_runs` row.

Exit codes: 0 every account passed (or the dry run finished), 2 a cycle failed or an account was refused, 64 usage.
