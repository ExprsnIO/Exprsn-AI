import type { MongoFlavour } from './mongo.js';

/*
 * 1.9.99-final, Sprint 59 (B-10304): the MongoDB-compatible managed services, read through the one MongoDB driver of
 * 1.5.0 and 1.6.0 (`mongo.ts`: direct connection to the checked address, `find` and `aggregate` only, an allow-listed
 * stage set, no server-side JavaScript, `retryWrites` and `retryReads` off). What differs per service:
 *
 * - Amazon DocumentDB: TLS with the Amazon RDS CA bundle (`global-bundle.pem`, installed on this server and named in
 *   the `tlsCaFile` setting, or carried by the connection's cloud link), SCRAM-SHA-1, `retryWrites=false` (DocumentDB
 *   refuses retryable writes; the driver never writes anyway), `readPreference=secondaryPreferred` for the reader
 *   endpoint, and no `connectionStatus` privileges: Test connection says the account's privileges cannot be read.
 *   Stages DocumentDB does not run are refused before anything is sent.
 * - Azure Cosmos DB for MongoDB (vCore): TLS always (a public CA), SCRAM-SHA-256, `retryWrites=false`; the host is
 *   `<cluster>.mongocluster.cosmos.azure.com` (or its private endpoint).
 * - DigitalOcean Managed MongoDB: TLS always with the cluster's own CA (from the control panel, or fetched by the
 *   cloud connect action from `/v2/databases/<id>/ca`), accounts in `admin` (write the account `admin/<user>`), and a
 *   `mongodb+srv` name: Register takes one member's `host:27017`, as the driver dials the checked address directly.
 */

export type MongoService = 'documentdb' | 'cosmos-mongodb' | 'do-mongodb';

export const MONGO_SERVICES: Record<MongoService, MongoFlavour> = {
  documentdb: {
    title: 'Amazon DocumentDB',
    authMechanism: 'SCRAM-SHA-1',
    unsupportedStages: new Set(['$setWindowFields', '$densify', '$fill', '$graphLookup']),
    privileges: false
  },
  'cosmos-mongodb': {
    title: 'Azure Cosmos DB for MongoDB',
    authMechanism: 'SCRAM-SHA-256',
    unsupportedStages: new Set(['$setWindowFields', '$densify', '$fill']),
    privileges: false
  },
  'do-mongodb': {
    title: 'DigitalOcean Managed MongoDB',
    privileges: true
  }
};
