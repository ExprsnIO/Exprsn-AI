# Backup and restore

What must be backed up, how, in which order to restore it, and how to prove a restore worked. The commands match the
three deployment shapes in [deploy.md](../deploy.md): Docker Compose (`deploy/docker/compose.yml`), bare metal with
systemd (`deploy/baremetal/`) and Kubernetes (`deploy/helm/exprsn-ai/`). The Platform screen's backups and restore
drills run the same steps on a schedule and record their results; this runbook is the manual procedure and the
reference when the console itself is unavailable.

## What to back up

| Item | Where it lives | Why it matters | Loss is |
| --- | --- | --- | --- |
| Application database | PostgreSQL, MySQL or the SQLite file (`SQLITE_FILENAME`) | Tenants, users, roles, the audit hash chain, conversations (sealed), rule sets, pools, profiles, wrapped data keys | Unrecoverable |
| Blob store | `BLOB_DIR` (default `/var/lib/exprsn-ai/blobs`) or the S3 bucket | Attachments, exports, media and images (sealed), audit checkpoints under `audit-checkpoints/` | Unrecoverable for those files |
| Key-encryption key | `DATA_KEY` with `KMS_PROVIDER=local`; the OpenBao transit keys with `KMS_PROVIDER=openbao` | Unwraps every tenant's data keys and signs audit checkpoints. Without it, sealed content and checkpoint signatures cannot be verified | Unrecoverable: every sealed value is lost |
| `SESSION_SECRET` | Secret file, systemd credential or Kubernetes Secret | Keys session ids, CSRF tokens, API-key digests and recovery-code digests | Recoverable: everyone signs in again, API keys and recovery codes must be reissued |
| Configuration | `exprsn-ai.env` or Helm values, `identity.yaml`, LDAP and SQL store secrets, TLS material | Rebuilding the deployment | Recoverable from your configuration management |
| Redis | `REDIS_URL` | Job queue (BullMQ), Socket.io adapter, bus | Safe to lose: queued jobs that had not started are lost and must be started again |

Sessions, lock-out counters and Redis may be lost safely; the audit chain, users and wrapped keys may not.

**Keep the key apart from the data.** A database backup together with `DATA_KEY` opens every sealed conversation. Store
`DATA_KEY` (and `SESSION_SECRET`) in a different system from the database and blob backups, with different access:
a password manager or a hardware-backed vault, two sealed copies held by different people, or the organisation's
secrets escrow. With OpenBao, back up OpenBao itself (below); the transit keys the server creates are not exportable.

## Consistency

Take the database dump first, then copy the blob store. A blob referenced by a database row is always written before
the row, so a blob copy that ends after the dump contains every blob the dump refers to; extra blobs written in
between are harmless. Doing it the other way round can leave rows that point at missing files.

Keep backups for at least as long as the audit retention the organisation requires; the audit chain is only complete
when the oldest backup still in use connects to the live chain.

## Database

Credentials below are placeholders; use the database account in `DATABASE_URL`, or a dedicated read-only backup role.

### PostgreSQL

```sh
# Compose (service "postgres", database and user exprsn_ai)
docker compose -f deploy/docker/compose.yml exec -T postgres \
  pg_dump -U exprsn_ai -d exprsn_ai --format=custom --no-owner --no-privileges > exprsn-ai-$(date +%F).dump

# Bare metal or Kubernetes, against the server named in DATABASE_URL
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file=exprsn-ai-$(date +%F).dump
pg_restore --list exprsn-ai-$(date +%F).dump > /dev/null   # the archive is readable
```

`pg_dump` takes a consistent snapshot without blocking the server. Continuous archiving (WAL shipping with pgBackRest,
Barman or a managed service's point-in-time recovery) is recommended in addition, for a recovery point of minutes.

### MySQL

```sh
mysqldump --single-transaction --quick --routines --triggers --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 -h db.internal -u exprsn_ai -p exprsn_ai > exprsn-ai-$(date +%F).sql
```

`--single-transaction` gives a consistent InnoDB snapshot without locking tables. Keep binary logs for point-in-time
recovery.

### SQLite (single node)

Copying the file while the server runs can produce a torn copy. Use the online backup API, either with the `sqlite3`
shell or with the `better-sqlite3` module the server already ships:

```sh
sqlite3 /var/lib/exprsn-ai/exprsn-ai.sqlite ".backup '/var/backups/exprsn-ai-$(date +%F).sqlite'"

# without the sqlite3 shell (run from /opt/exprsn-ai so the module resolves)
cd /opt/exprsn-ai && sudo -u exprsn-ai node -e "
  const db = require('better-sqlite3')('/var/lib/exprsn-ai/exprsn-ai.sqlite', { readonly: true });
  db.backup(process.argv[1]).then(() => console.log('ok'));" /var/lib/exprsn-ai/backup-$(date +%F).sqlite
```

## Blob store

```sh
# Compose: the "appdata" volume holds blobs/ (the project is named exprsn-ai)
docker run --rm -v exprsn-ai_appdata:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/exprsn-ai-blobs-$(date +%F).tgz -C /data blobs

# Bare metal
tar czf /var/backups/exprsn-ai-blobs-$(date +%F).tgz -C /var/lib/exprsn-ai blobs

# S3 or MinIO (with the MinIO client; aws s3 sync works the same way)
mc mirror --preserve exprsn/exprsn-ai backup/exprsn-ai-$(date +%F)
```

With S3, turn on bucket versioning (and object lock where available) so a deleted or overwritten object can be
recovered without a restore. The blob contents are sealed with the tenant keys, so the backup copies need no further
encryption to protect their content, but their names and sizes are visible.

## Keys

- **Local KMS.** Back up the `DATA_KEY` value once, when it is generated, and again only if it is ever replaced. It is
  in `deploy/docker/secrets/data_key.txt` (Compose), `/etc/exprsn-ai/credentials/data_key` (bare metal) or the
  `data_key` key of the Kubernetes Secret. The per-tenant data keys themselves are in the database (wrapped), so
  `exprsn-ai kms:rotate` needs no new key backup.
- **OpenBao.** Take Raft snapshots (`bao operator raft snapshot save exprsn-ai-bao-$(date +%F).snap`) on a schedule,
  and keep the unseal or recovery keys under the organisation's key ceremony. The server's keys are
  `<OPENBAO_KEY_PREFIX>tenant-<tenant id>` (one per tenant), `<OPENBAO_KEY_PREFIX>platform` and
  `<OPENBAO_KEY_PREFIX>audit-checkpoints` in the `OPENBAO_TRANSIT_MOUNT` engine. They are created with
  `deletion_allowed`, so the token given to the server must be the only one allowed to delete them, and snapshots are
  the only way back from an accidental deletion.
- **`SESSION_SECRET`.** Back it up with `DATA_KEY`. Restoring without it works but signs everyone out and invalidates
  API keys and recovery codes.

## Restore

Restore into a stopped deployment, in this order. A partial restore (database without blobs, or either without the
key) starts, but sealed content fails to open.

1. **Stop the servers** (and job workers), so nothing writes during the restore:
   `docker compose stop app`, `systemctl stop exprsn-ai`, or `kubectl scale deploy/exprsn-ai --replicas=0`.
2. **Keys first.** Put the original `DATA_KEY` back in its secret file or Kubernetes Secret, or restore the OpenBao
   snapshot (`bao operator raft snapshot restore -force <file>`) and unseal. Restore `SESSION_SECRET` too if you have
   it. Do not generate new ones: new keys cannot open the restored data.
3. **Database.** Restore into an empty database of the same dialect:

   ```sh
   # PostgreSQL
   createdb -O exprsn_ai exprsn_ai_restore
   pg_restore --no-owner --role=exprsn_ai -d exprsn_ai_restore exprsn-ai-2026-09-30.dump
   # MySQL
   mysql -u root -p -e 'CREATE DATABASE exprsn_ai_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'
   mysql -u exprsn_ai -p exprsn_ai_restore < exprsn-ai-2026-09-30.sql
   # SQLite
   install -o exprsn-ai -g exprsn-ai -m 0600 backup-2026-09-30.sqlite /var/lib/exprsn-ai/exprsn-ai.sqlite
   ```

   Point `DATABASE_URL` at the restored database (or rename it into place).
4. **Blob store.** Extract or mirror the copy taken after that dump back to `BLOB_DIR` or the bucket, owned by the
   service user (`exprsn-ai` on bare metal, UID 1000 in the container).
5. **Migrate and start.** Start one instance first. It migrates on start unless `DB_MIGRATE_ON_START=false`, in which
   case run `exprsn-ai migrate` (in the container: `node server/dist/cli.js migrate`; with the Helm chart the init
   container or hook Job does it). Restoring a backup taken on an older release onto a newer one is supported, since
   migrations only move forward; restoring onto an older release than the backup is not.
6. **Verify** (next section), then start the remaining instances and re-enable schedules.
7. **Record it.** A restore rewinds the audit chain to the backup: events after the backup point are gone. Write the
   incident down, and note that audit checkpoint files under `audit-checkpoints/` newer than the restored chain head
   are evidence of the gap, not corruption.

## Verify

```sh
# Readiness: database reachable and migrated, KMS and blob store answering
curl -fsS https://ai.example.internal/readyz

# Audit chain and signed checkpoints, per tenant; exit code 2 means broken
exprsn-ai audit:verify --tenant default
```

`audit:verify` recomputes the tenant's hash chain from the restored rows and checks each signed checkpoint with the
KMS. A checkpoint that does not verify after a restore usually means the wrong `DATA_KEY` or OpenBao snapshot. On
Compose run it as `docker compose exec app node server/dist/cli.js audit:verify --tenant <slug>`; on Kubernetes as
`kubectl exec deploy/exprsn-ai -- node server/dist/cli.js audit:verify --tenant <slug>`; on bare metal with the same
credentials as the unit (the installer prints the full command line). To check every tenant:

```sh
for t in $(psql "$DATABASE_URL" -Atc "select slug from tenants where state = 'active'"); do
  echo "== $t"; exprsn-ai audit:verify --tenant "$t" || echo "BROKEN: $t"
done
```

Then, signed in to the console:

- open an older conversation in a tenant with sealed content, and download an attachment and an export: both prove
  the data keys unwrap and the blob store matches the database;
- sign in through each user store (Admin > User stores, "Test a login");
- check that pools report their instances healthy (Admin > Pools) and a chat answer streams.

## Restore drills

Run a drill at least quarterly, and after any change to the database, the KMS or the blob store:

1. Restore the latest backup into an isolated environment (a separate namespace, Compose project or host) with no
   route to production inference, directories or mail. Use the production `DATA_KEY` or an OpenBao snapshot restored
   into an isolated OpenBao, handled under the same controls as production.
2. Run the verification above. Record the recovery point (backup age), the recovery time (from start to a verified
   `audit:verify`), and anything that failed.
3. Destroy the drill environment, including its copy of the key.

The Platform screen's backups and restore drills keep this record in the console and write it to the audit chain.
