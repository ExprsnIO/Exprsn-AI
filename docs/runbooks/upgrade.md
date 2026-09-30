# Upgrade and rollback

How to move Exprsn-AI to a new release with no downtime when several instances run, how database migrations behave,
and how to go back. Upgrading the Ollama nodes is a separate, console-driven procedure at the end.

## Before every upgrade

1. **Read the release notes** for migrations, changed variables and removed features. `docs/deploy.md` of the new
   release lists every variable.
2. **Take a backup** of the database and the blob store ([backup-restore.md](backup-restore.md)), and confirm the
   `DATA_KEY` or OpenBao backup exists. This backup is the rollback path when the release migrates the database.
3. **Check health**: `/readyz` answers 200 on every instance, `exprsn-ai audit:verify --tenant <slug>` exits 0, and no
   long job (reindex, export, evaluation, media) is about to start. Running jobs are retried after the restart, but a
   quiet period is simpler.
4. **Know whether the release migrates.** Compare the migrations the database has applied with those the new release
   brings:

   ```sh
   psql "$DATABASE_URL" -Atc "select name from knex_migrations order by id"      # PostgreSQL
   mysql -e "select name from knex_migrations order by id" exprsn_ai              # MySQL
   ```

   The new release's migrations are listed in `server/src/db/migrations/index.ts`. Any name not yet in the table will
   be applied.

## How migrations run

Migrations only move forward and run under Knex's migration lock, so two instances starting together do not apply
the same migration twice; the one that waits finds nothing left to do. (MySQL cannot roll back DDL, so a migration that
fails halfway on MySQL needs the pre-upgrade backup.)

- By default each instance migrates on start (`DB_MIGRATE_ON_START=true`). `/readyz` answers 503 while any migration
  is pending, so a load balancer does not send traffic to an instance whose database is behind.
- With `DB_MIGRATE_ON_START=false`, run `exprsn-ai migrate` before starting the new release. It prints the applied
  migrations or "Already up to date".
- The Helm chart sets `DB_MIGRATE_ON_START=false` and runs `node server/dist/cli.js migrate` itself, in an init
  container of every new pod (default) or in a pre-upgrade hook Job (`migrations.mode: job`).

During a rolling upgrade, old instances keep running against the migrated schema until they are replaced. That is
safe when the new migrations are additive (new tables, new nullable columns or columns with defaults) and drop or
rename nothing the previous release reads. When a release's migrations are not additive, or its notes say so, stop
every instance, migrate, and start the new release instead of rolling.

An older release refuses to start against a database migrated by a newer one (Knex reports migrations it does not
know). That is deliberate: it prevents old code from writing to a schema it does not understand.

## Rolling upgrade

Chat streams live on the instance that runs them. When an instance receives SIGTERM it stops accepting connections,
answers 503 on `/readyz`, closes sockets and exits within 25 seconds; an answer that was still streaming ends where it
was and is kept as stored so far, and the console shows the stored text. Replace instances one at a time, and only when
the previous one is ready, to keep that to a few answers.

### Kubernetes (Helm)

```sh
helm diff upgrade exprsn-ai deploy/helm/exprsn-ai -n exprsn-ai -f my-values.yaml --set image.digest=sha256:...   # with the helm-diff plugin
helm upgrade exprsn-ai deploy/helm/exprsn-ai -n exprsn-ai -f my-values.yaml --set image.digest=sha256:... --wait --timeout 15m
kubectl -n exprsn-ai rollout status deploy/exprsn-ai
```

The Deployment surges one new pod, waits for it to pass `/readyz`, then drains one old pod (`maxSurge: 1`,
`maxUnavailable: 0`); the PodDisruptionBudget keeps at least one pod serving during node drains. Pin the image by
digest, the one CI built and scanned.

### Docker Compose

```sh
cd deploy/docker
docker compose exec -T postgres pg_dump -U exprsn_ai -d exprsn_ai -Fc > pre-upgrade-$(date +%F).dump
EXPRSN_VERSION=1.0.0 docker compose pull app        # or: git pull && docker compose build app
EXPRSN_VERSION=1.0.0 PUBLIC_URL=https://ai.example.internal docker compose up -d app
docker compose logs -f app                          # "Applied: ..." then listening
```

A single Compose app container restarts in place: expect a few seconds of unavailability and interrupted streams.

### Bare metal (systemd)

```sh
cd /path/to/checkout && git fetch && git checkout v1.0.0
sudo deploy/baremetal/install.sh                    # builds, installs to /opt/exprsn-ai, keeps /opt/exprsn-ai.old
sudo systemctl restart exprsn-ai
journalctl -u exprsn-ai -f
```

With several hosts behind a load balancer, take one host out of the pool, upgrade it, wait for `/readyz`, put it back,
then the next.

### After the upgrade

- `/readyz` answers 200 on every instance, and every instance runs the new image or build.
- `exprsn-ai audit:verify --tenant <slug>` exits 0.
- A chat answer streams; an attachment and an export from before the upgrade open.
- Admin > Pools shows the instances healthy; job queues drain.

## Rollback

Pick the path by whether the release applied migrations (see "Know whether the release migrates").

**No new migrations.** Deploy the previous release again:

- Helm: `helm rollback exprsn-ai <previous revision> -n exprsn-ai --wait` (`helm history exprsn-ai` lists revisions).
  Hook Jobs do not run on rollback, and none is needed.
- Compose: `EXPRSN_VERSION=<previous> docker compose up -d app`.
- Bare metal: swap the directories and restart:

  ```sh
  sudo systemctl stop exprsn-ai
  sudo mv /opt/exprsn-ai /opt/exprsn-ai.failed && sudo mv /opt/exprsn-ai.old /opt/exprsn-ai
  sudo systemctl start exprsn-ai
  ```

**Migrations were applied.** The previous release will not start against the migrated database. Choose one:

1. **Roll forward** (preferred): fix the problem in a patch release, or turn the faulty feature off (disable a profile,
   a rule set, a tool) while the fix is made. No data is lost.
2. **Restore**: stop every instance, restore the database backup taken just before the upgrade (and the blob store copy
   taken after it), then deploy the previous release. Everything written since the backup is lost, including audit
   events: record it as an incident ([incident-response.md](incident-response.md)) and follow the verification in
   [backup-restore.md](backup-restore.md).

Do not delete rows from `knex_migrations` to make an older release start: the schema would stay migrated and the old
code would run against it unchecked.

## Rotating secrets during an upgrade

Change one thing at a time. If an upgrade coincides with a secret rotation, do the rotation first, confirm it, then
upgrade. `SESSION_SECRET` rotation signs everyone out; `DATA_KEY` cannot be changed in place (see
[incident-response.md](incident-response.md)).

## Upgrading Ollama nodes

Ollama instances are upgraded from the console, not with the application: Admin > Pools, the pool's rolling upgrade
(`POST /api/admin/pools/:id/upgrade {targetVersion, waitMinutes}`). The job drains one instance at a time, waits for it
to report the target version after you (or your configuration management) upgrade the node, reloads its pinned models
and moves on. To take one node out by hand, drain it (`POST /api/admin/instances/:id/drain`) and undrain it afterwards.
