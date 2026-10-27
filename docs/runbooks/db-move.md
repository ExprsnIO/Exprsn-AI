# Moving the database to a managed PostgreSQL, and back

Moving this install's own database onto RDS or Aurora PostgreSQL, Azure Database for PostgreSQL Flexible Server,
DigitalOcean Managed PostgreSQL or another PostgreSQL, and rolling the move back (1.9.99-final, B-10302). The command
is `exprsn-ai db:move` (see [Conventions](README.md#conventions) for how to run the CLI per deployment); the console's
form of it is under dual control (`/api/admin/cloud/db-moves`). Background: [deploy.md](../deploy.md#moving-to-a-managed-database-1999-final-b-10302)
and [cloud.md](../cloud.md#own-database-and-caches-b-10302-b-10305).

## Before

- [ ] A backup and a passing restore drill from the last day (`exprsn-ai backup:restore-drill`).
- [ ] The install reads its URL from a file (`DATABASE_URL_FILE`); note the file's path.
- [ ] The target database exists, is empty, allows pgvector (Azure: `azure.extensions` lists `VECTOR`), and its user
      owns it. It is reachable from this host on its private endpoint.
- [ ] The provider's CA bundle is a file on this host (RDS global bundle; Azure DigiCert Global Root G2 and Microsoft
      RSA Root CA 2017; DigitalOcean the cluster's CA).
- [ ] The target URL is in a file readable by the service user only (`chmod 600`).
- [ ] A maintenance notice: changes are refused for the window (the dry run estimates it; the bound is 30 minutes).
- [ ] Every instance can be restarted right after the switch (systemd units, Compose services, the Helm release).

## Dry run

```sh
exprsn-ai db:move --to /etc/exprsn-ai/target-url --ca-file /etc/exprsn-ai/db-ca.pem --dry-run [--instances 3]
```

Every line must say `ok`. What a `FAIL` means:

| Check | Fix |
| --- | --- |
| `tls` | The connection is not encrypted or the certificate does not verify: the CA file, the host name in the URL (the endpoint's own name, not an IP), `sslmode` |
| `ca_file` | Give `--ca-file` with the provider's bundle |
| `connections` | `DB_POOL_MAX × instances + 5` is more than `max_connections` less the reserved slots: lower `DB_POOL_MAX`, run fewer instances, add a pooler (RDS Proxy, PgBouncer) or take a larger size |
| `empty` | The target holds tenants, users or audit events: use a new database |
| `extensions` | Allow pgvector on the target |
| `source_schema` | Run `exprsn-ai migrate` on the source first |
| `switch_file` | Set `DATABASE_URL_FILE`, or pass `--switch-file` |
| `window` | The estimate passes the bound: move at a quieter time with a larger bound (`--window-minutes`), or archive first |

## The move

```sh
exprsn-ai db:move --to /etc/exprsn-ai/target-url --ca-file /etc/exprsn-ai/db-ca.pem
```

It prints each step (`preflight`, `schema`, `read_only`, `backup`, `restore`, `verify`, `migrate_check`, `switch`).
When it says `switched`:

1. Restart every instance now. Until then they serve reads from the old database and refuse changes.
2. `curl -fsS https://<host>/readyz` on each instance; `exprsn-ai audit:verify` (exit 0).
3. Open a conversation in the console; make a change.
4. Keep the old database for the keep window (seven days by default). It is read-only.
5. When you are sure: `exprsn-ai db:move --finish`, then drop the old database.

If it stops, it says at which step and why. `exprsn-ai db:move --status` shows the record; `--resume` continues at
the step that did not finish (a backup or restore is taken again when the source changed during the window, which is
what `verify` checks). A console move that stopped resumes through its job's retry, or with `--resume`.

## Rollback

Before the switch (the move failed or you stop it): `exprsn-ai db:move --rollback`. The window closes and the install
is writable again on its own database. The target is left as it is: drop it or reuse it for the next attempt.

After the switch, within the keep window:

```sh
exprsn-ai db:move --rollback
```

It puts the old URL back in the URL file (from `<file>.previous`), lifts the old database's read-only default, and
puts the new database in a read-only window. Then restart every instance. It refuses when the new database took
writes since the switch (it lists the tables): those writes would be lost. Either move back with a move in the other
direction (`db:move --to <old url file>` onto an emptied old database), or accept the loss:
`exprsn-ai db:move --rollback --discard-new-writes`.

## The sandbox run against RDS (the owner's step, open decision 18)

The tests move an install into a throwaway local PostgreSQL with TLS and pgvector
(`server/test/integration/cloud-db-move-pg.test.ts`, `TEST_MOVE_PG_URL`, `TEST_MOVE_PG_CA`). The run against a real
RDS needs the sandbox AWS account and is the owner's:

1. In the sandbox account, an RDS for PostgreSQL 17 instance (`db.t4g.medium`, no public access, in the lab VPC),
   reachable from a lab install (a VM in the VPC, or a bastion tunnel); download the RDS global bundle.
2. On the lab install (never the live one): seed it (a few tenants, users, conversations), run
   `exprsn-ai backup:restore-drill`, then the dry run and the move as above.
3. Record: the window (`switched ...; window <n> s`), the row count, `exprsn-ai audit:verify` on the moved install
   (verified), the conversation count before and after (equal), and `/readyz`.
4. Roll back and move again once, to check the rollback on RDS.
5. Delete the instance and its snapshots; check the sandbox's budget.
