# A cloud region outage and failover to a standby (1.9.99-final, B-10704)

Use this when the region a deployment runs in is down or degraded (the provider's status page, every step failing with
`unreachable` or `circuit_open`, `ExprsnCloudBreakerOpen`) and the service must run from another region.

Not walked through against the fakes: a failover needs a second region of a real account. It is the owner's step
against the sandbox accounts (open decision 18).

**What exists.** Within a region, `ha: true` on the deployment spec gives a standby database in another zone (RDS
Multi-AZ, Aurora reader, Azure zone-redundant HA, a DigitalOcean standby node), a replicated cache and three zones, and
the provider fails over by itself. **Across regions** Exprsn-AI keeps no live replica: the standby is a second
deployment in another region of the account's allow-list, kept small, and the data follows by snapshot. Plan the RPO
around the snapshot schedule (`PUT /api/admin/cloud/deployments/:id/databases/:key/schedule`).

## Before an outage

1. Allow the standby region on the account (Cloud accounts > the account > Regions, at the ceiling and residency the
   data needs; raising a ceiling is a proposal for a second admin).
2. Create the standby: `POST /api/admin/cloud/deployments` with `{"name":"<name>-standby","accountId":...,"region":"<other>"}`,
   then plan and apply its graph (Deployments > the deployment > Plans) with GPU pools at `min: 0`.
3. Schedule database snapshots on the primary and copy them to the standby region with the provider's own tool (RDS
   `copy-db-snapshot`, Azure geo-redundant backup, DigitalOcean has no cross-region copy: dump and restore).

## During the outage

1. Stop changes in the failed region: let running applies end or cancel them ([cloud-stuck-operation.md](cloud-stuck-operation.md)).
2. Restore the latest copied snapshot into the standby as a new database
   ([cloud-database-restore.md](cloud-database-restore.md)), or `exprsn-ai db:move` onto it for the install's own
   database ([db-move.md](db-move.md)).
3. Scale the standby's pools up: `POST /api/admin/pools/:id/scale`.
4. Move traffic: the front door's or the zone's DNS record to the standby's load balancer through a reviewed plan on the
   standby deployment (a `dns_record`), or the Cloudflare front door's origin (`docs/cloud.md`, front door).
5. Verify: `POST /api/admin/cloud/deployments/:id/verify` on the standby.

## After

Fail back the same way once the region is healthy, then destroy what is no longer needed
(`POST /api/admin/cloud/deployments/:id/destroy`; protected databases need a second admin and a final snapshot).
