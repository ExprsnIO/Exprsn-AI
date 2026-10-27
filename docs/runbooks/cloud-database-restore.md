# Restoring a managed database from a snapshot (1.9.99-final, B-10704)

Use this when a managed database (RDS or Aurora, Azure Database for PostgreSQL or MySQL, a DigitalOcean cluster) lost
data or must be rolled back. A restore always makes a **new** instance; the source is never overwritten, and the new
database is protected (deletion protection, a final snapshot before any delete).

Covered against the fakes by `server/test/cloud-databases.test.ts` (snapshots, restore to a new instance) and
`server/test/cloud-upgrades.test.ts` (the pre-upgrade snapshot's restore under dual control); the walk-through against
the sandbox accounts is the owner's step.

1. **Pick the snapshot.** Cloud data > the database > Snapshots, or
   `GET /api/admin/cloud/deployments/:id/databases/:key/snapshots`: scheduled, on-demand, pre-upgrade and final
   snapshots, with their time and size. To take one now first: `POST .../databases/:key/snapshots` (a recent sign-in).
2. **Restore to a new instance.** `POST /api/admin/cloud/deployments/:id/databases/:key/snapshots/:snapshotId/restore`
   with `{"key":"<new key>"}` (optional `size`; `cloud:deploy`, a recent sign-in). It answers with the `cloud.db.restore`
   job; follow it in Admin > Jobs. The new database is in the same private subnets and data security group.
3. **A pre-upgrade snapshot** (taken by an upgrade) is restored under dual control:
   `POST /api/admin/cloud/deployments/:id/snapshots/:snapshotId/restore` by one admin, then
   `.../restore/approve` by another (`.../restore/reject` refuses it).
4. **Point the app at it.** For a data connection: Connections > the connection > host. For Exprsn-AI's own database:
   [db-move.md](db-move.md) (`exprsn-ai db:move --to <file> --ca-file <ca> --dry-run`, then without `--dry-run`).
5. **Check** the extensions the app needs: `GET /api/admin/cloud/deployments/:id/databases/:key/extensions`.
6. **The old database** stays until you destroy it: destroy takes a final snapshot first and needs a second admin.
