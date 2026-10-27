import { z } from 'zod';

/*
 * 1.9.0: the catalogue of data connection engines. One entry per engine says what family it is (SQL, search or
 * document), which SQL dialect its queries are classified and bound in, how it is reached (a TCP protocol dialled at
 * the checked address, or HTTPS through the guarded dispatcher), what the "database" field means for it, and the
 * engine's own settings (`data_connections.options`, never a secret: credentials stay in the sealed `credential`).
 * The console's Register dialog is drawn from `engineCatalogue()`, so a new engine needs no console change.
 */

export const ENGINES = ['postgres', 'opensearch', 'mysql', 'mongodb', 'mssql', 'azure-sql', 'oracle', 'snowflake', 'bigquery', 'redis', 'rabbitmq', 'prometheus', 'influxdb', 'documentdb', 'cosmos-mongodb', 'do-mongodb', 'dynamodb', 'cosmos-nosql', 'cloudflare-d1'] as const;
export type Engine = (typeof ENGINES)[number];

/** How a SQL engine's text is lexed, bound and classified (see dialects.ts). */
export type DialectId = 'postgres' | 'mysql' | 'tsql' | 'oracle' | 'snowflake' | 'bigquery' | 'sqlite';

/** A plain SQL identifier as an engine setting (schema, warehouse, role). */
const sqlName = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/, 'a plain name: letters, digits, _ and $');

const none = z.object({}).strict();

/** A CA bundle on this server: an absolute path to a .pem, .crt or .cer file (1.9.99-final, B-10304). */
const caFile = z.string().trim().max(400).regex(/^\/(?!.*\/\.\.(\/|$))[A-Za-z0-9_./ -]+\.(pem|crt|cer)$/, 'an absolute path to a .pem file');

export const OPTION_SCHEMAS = {
  postgres: none,
  opensearch: none,
  mysql: none,
  mongodb: none,
  mssql: z
    .object({
      /** The default schema unqualified names resolve to. */
      schema: sqlName.default('dbo'),
      /** Sent as ApplicationIntent: ReadOnly routes to a readable secondary in an availability group. */
      applicationIntent: z.enum(['ReadOnly', 'ReadWrite']).default('ReadOnly')
    })
    .strict(),
  'azure-sql': z
    .object({
      schema: sqlName.default('dbo'),
      /** `sql`: a contained or server login. `entra-service-principal`: the account is the app's client id, the secret its client secret. */
      auth: z.enum(['sql', 'entra-service-principal']).default('sql'),
      /** The Microsoft Entra tenant (directory) id or domain, for `entra-service-principal`. */
      entraTenantId: z.string().trim().regex(/^[A-Za-z0-9.-]{3,100}$/).optional(),
      applicationIntent: z.enum(['ReadOnly', 'ReadWrite']).default('ReadOnly')
    })
    .strict(),
  oracle: z
    .object({
      /** The schema unqualified names resolve to; the account's own schema when absent. */
      schema: sqlName.optional(),
      /** With TLS: the server certificate's full distinguished name, matched instead of the host name. */
      sslServerCertDN: z.string().trim().max(500).regex(/^[^<>"\n]*$/).optional()
    })
    .strict(),
  snowflake: z
    .object({
      /** `key-pair`: the secret is the user's PKCS#8 private key (PEM). `pat`: a programmatic access token. */
      auth: z.enum(['key-pair', 'pat']).default('key-pair'),
      warehouse: sqlName.optional(),
      role: sqlName.optional(),
      schema: sqlName.default('PUBLIC')
    })
    .strict(),
  bigquery: z
    .object({
      /** Where jobs run (US, EU or a region such as europe-west2); the dataset's location when absent. */
      location: z.string().trim().regex(/^[A-Za-z0-9-]{2,40}$/).optional(),
      /** A query that would bill more bytes than this fails before it runs. */
      maximumBytesBilled: z.number().int().min(10_000_000).max(1e15).optional()
    })
    .strict(),
  // 1.9.0, second round: key-value, queue and time-series engines.
  redis: z
    .object({
      /** How many keys one SCAN-based read may walk before it stops. */
      scanLimit: z.number().int().min(100).max(100_000).default(10_000)
    })
    .strict(),
  rabbitmq: z
    .object({
      /** `on`: messages can be peeked (fetched and requeued at once, which marks them redelivered). Off by default. */
      peek: z.enum(['off', 'on']).default('off')
    })
    .strict(),
  prometheus: z
    .object({
      /** The range a query covers when it names none, as a Prometheus duration (5m, 1h, 7d). */
      defaultRange: z.string().trim().regex(/^\d{1,5}[smhdwy]$/).default('1h'),
      /** At most this many points per series in a range query (the step grows to fit). */
      maxPoints: z.number().int().min(10).max(11_000).default(1_000)
    })
    .strict(),
  influxdb: z
    .object({
      /** `v1`: InfluxQL with a user and password. `v2`: InfluxQL through the v1 compatibility API with a token. `v3`: SQL or InfluxQL with a token. */
      version: z.enum(['v1', 'v2', 'v3']).default('v2'),
      /** v1 and v2: the retention policy; the database's default when absent. */
      retentionPolicy: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
      /** v3: the query language. */
      language: z.enum(['influxql', 'sql']).default('influxql')
    })
    .strict(),
  // 1.9.99-final, Sprint 59 (B-10304): document and key-value stores in the clouds, read-only (open decision 15).
  documentdb: z
    .object({
      /** The Amazon RDS CA bundle (global-bundle.pem) as a file on this server, for TLS. */
      tlsCaFile: caFile.optional(),
      /** `secondaryPreferred` sends reads to replicas (the cluster's reader endpoint). */
      readPreference: z.enum(['primary', 'primaryPreferred', 'secondaryPreferred']).default('secondaryPreferred')
    })
    .strict(),
  'cosmos-mongodb': z.object({ tlsCaFile: caFile.optional() }).strict(),
  'do-mongodb': z.object({ tlsCaFile: caFile.optional() }).strict(),
  dynamodb: z
    .object({
      /** The signing region; read from the endpoint (dynamodb.<region>.amazonaws.com or its VPC endpoint) when absent. */
      region: z.string().trim().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'a region such as eu-west-1').optional(),
      /** `on`: strongly consistent reads on the table (not on global secondary indexes). */
      consistentRead: z.enum(['off', 'on']).default('off'),
      /** How many pages of 1 MB one read may fetch before it stops (and says the result is capped). */
      maxPages: z.number().int().min(1).max(50).default(10)
    })
    .strict(),
  'cosmos-nosql': z
    .object({
      /** `key`: the account key (a read-only key). `entra-service-principal`: the account is the client id, the secret its client secret. */
      auth: z.enum(['key', 'entra-service-principal']).default('key'),
      entraTenantId: z.string().trim().regex(/^[A-Za-z0-9.-]{3,100}$/).optional()
    })
    .strict(),
  // 1.9.99-final, Sprint 61 (B-10907): Cloudflare D1 through its query API, read-only. No settings of its own.
  'cloudflare-d1': none
} as const satisfies Record<Engine, z.ZodTypeAny>;

export type EngineOptions<E extends Engine = Engine> = z.infer<(typeof OPTION_SCHEMAS)[E]>;

export interface OptionField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select';
  choices?: { value: string; label: string }[];
  placeholder?: string;
  help: string;
  /** Shown only when another option has this value. */
  when?: { option: string; value: string };
}

export interface EngineInfo {
  id: Engine;
  title: string;
  family: 'sql' | 'search' | 'document' | 'keyvalue' | 'queue' | 'timeseries';
  dialect: DialectId | null;
  /** `tcp`: the driver dials the checked address. `https`: requests go through the guarded dispatcher. */
  transport: 'tcp' | 'https';
  endpointHint: string;
  defaultPort: number | null;
  database: { label: string; required: boolean; placeholder: string; help: string } | null;
  /** TLS is always on (HTTPS engines, Azure SQL). */
  tlsRequired: boolean;
  /** OpenBao's database engine can issue its accounts. */
  dynamicCredentials: boolean;
  /** Tables and views can be a knowledge source (read by watermark). */
  knowledgeSource: boolean;
  credential: { usernameLabel: string; usernameRequired: boolean; secretLabel: string; secretHelp: string; multiline: boolean };
  options: OptionField[];
  /** What the data browser's query box takes, in a few words (the console falls back to its own text). */
  queryHint?: string;
  /** Example queries the data browser offers; `{object}` is replaced by the object picked in the schema tree. */
  examples?: { label: string; query: string }[];
  /** What the schema tree calls the objects (tables, keys, queues, metrics, measurements). */
  objectNoun?: string;
}

const PASSWORD = { usernameLabel: 'Account', usernameRequired: true, secretLabel: 'Password', secretHelp: 'Sealed with the tenant key; it is never shown again. A vault: reference is read at every use.', multiline: false };

const CATALOGUE: Record<Engine, EngineInfo> = {
  postgres: { id: 'postgres', title: 'PostgreSQL', family: 'sql', dialect: 'postgres', transport: 'tcp', endpointHint: 'host:5432', defaultPort: 5432, database: { label: 'Database', required: false, placeholder: 'ledger', help: 'The database to connect to.' }, tlsRequired: false, dynamicCredentials: true, knowledgeSource: true, credential: PASSWORD, options: [] },
  mysql: { id: 'mysql', title: 'MySQL', family: 'sql', dialect: 'mysql', transport: 'tcp', endpointHint: 'host:3306', defaultPort: 3306, database: { label: 'Database', required: false, placeholder: 'shop', help: 'Unqualified names resolve to this database.' }, tlsRequired: false, dynamicCredentials: true, knowledgeSource: true, credential: PASSWORD, options: [] },
  opensearch: { id: 'opensearch', title: 'OpenSearch', family: 'search', dialect: null, transport: 'https', endpointHint: 'https://host:9200', defaultPort: 9200, database: null, tlsRequired: false, dynamicCredentials: false, knowledgeSource: false, credential: { ...PASSWORD, usernameRequired: false }, options: [] },
  mongodb: { id: 'mongodb', title: 'MongoDB', family: 'document', dialect: null, transport: 'tcp', endpointHint: 'host:27017', defaultPort: 27017, database: { label: 'Database', required: true, placeholder: 'catalog', help: 'The database whose collections the connection reads.' }, tlsRequired: false, dynamicCredentials: false, knowledgeSource: true, credential: PASSWORD, options: [] },
  mssql: {
    id: 'mssql',
    title: 'SQL Server',
    family: 'sql',
    dialect: 'tsql',
    transport: 'tcp',
    // A named instance is reached by its port (the SQL Browser service is never asked).
    endpointHint: 'host:1433',
    defaultPort: 1433,
    database: { label: 'Database', required: true, placeholder: 'Sales', help: 'The database to connect to; three-part names in it resolve here.' },
    tlsRequired: false,
    dynamicCredentials: false,
    knowledgeSource: true,
    credential: { ...PASSWORD, secretHelp: 'A SQL login with SELECT only (db_datareader). Sealed with the tenant key, or a vault: reference.' },
    options: [
      { name: 'schema', label: 'Default schema', type: 'text', placeholder: 'dbo', help: 'Unqualified table names resolve to this schema.' },
      { name: 'applicationIntent', label: 'Application intent', type: 'select', choices: [{ value: 'ReadOnly', label: 'Read only (readable secondary)' }, { value: 'ReadWrite', label: 'Read and write (primary)' }], help: 'ReadOnly routes to a readable secondary in an availability group. Queries are read-only either way.' }
    ]
  },
  'azure-sql': {
    id: 'azure-sql',
    title: 'Azure SQL',
    family: 'sql',
    dialect: 'tsql',
    transport: 'tcp',
    endpointHint: 'server.database.windows.net:1433',
    defaultPort: 1433,
    database: { label: 'Database', required: true, placeholder: 'sales-db', help: 'Azure SQL Database connects to one database.' },
    tlsRequired: true,
    dynamicCredentials: false,
    knowledgeSource: true,
    credential: { usernameLabel: 'Account or client id', usernameRequired: true, secretLabel: 'Password or client secret', secretHelp: 'For a SQL login, its password. For a service principal, the app registration\'s client secret. Sealed, or a vault: reference.', multiline: false },
    options: [
      { name: 'auth', label: 'Authentication', type: 'select', choices: [{ value: 'sql', label: 'SQL login' }, { value: 'entra-service-principal', label: 'Microsoft Entra service principal' }], help: 'A service principal signs in with its client id and secret; login.microsoftonline.com must be on the operator\'s CONNECTIONS_ALLOWED_HOSTS.' },
      { name: 'entraTenantId', label: 'Entra tenant id', type: 'text', placeholder: '00000000-0000-0000-0000-000000000000', help: 'The directory (tenant) id or domain of the app registration.', when: { option: 'auth', value: 'entra-service-principal' } },
      { name: 'schema', label: 'Default schema', type: 'text', placeholder: 'dbo', help: 'Unqualified table names resolve to this schema.' },
      { name: 'applicationIntent', label: 'Application intent', type: 'select', choices: [{ value: 'ReadOnly', label: 'Read only (read scale-out replica)' }, { value: 'ReadWrite', label: 'Read and write (primary)' }], help: 'ReadOnly uses the read scale-out replica where the tier has one.' }
    ]
  },
  oracle: {
    id: 'oracle',
    title: 'Oracle Database',
    family: 'sql',
    dialect: 'oracle',
    transport: 'tcp',
    endpointHint: 'host:1521',
    defaultPort: 1521,
    database: { label: 'Service name', required: true, placeholder: 'FREEPDB1', help: 'The database service name (a pluggable database\'s service).' },
    tlsRequired: false,
    dynamicCredentials: false,
    knowledgeSource: true,
    credential: { ...PASSWORD, secretHelp: 'An account with SELECT on the tables it reads, nothing more. Sealed, or a vault: reference.' },
    options: [
      { name: 'schema', label: 'Default schema', type: 'text', placeholder: 'HR', help: 'Unqualified names resolve to this schema; the account\'s own schema when empty.' },
      { name: 'sslServerCertDN', label: 'Server certificate DN', type: 'text', placeholder: 'CN=db.example.com,O=Example', help: 'With TLS on, the server certificate\'s full distinguished name. The checked address is dialled, so the host name cannot be matched; without a DN, TLS connections are refused.' }
    ]
  },
  snowflake: {
    id: 'snowflake',
    title: 'Snowflake',
    family: 'sql',
    dialect: 'snowflake',
    transport: 'https',
    endpointHint: 'orgname-account.snowflakecomputing.com',
    defaultPort: 443,
    database: { label: 'Database', required: true, placeholder: 'ANALYTICS', help: 'The database statements run in.' },
    tlsRequired: true,
    dynamicCredentials: false,
    knowledgeSource: true,
    credential: { usernameLabel: 'User', usernameRequired: true, secretLabel: 'Private key or token', secretHelp: 'Key pair: the user\'s unencrypted PKCS#8 private key in PEM. Token: a programmatic access token. Sealed, or a vault: reference.', multiline: true },
    options: [
      { name: 'auth', label: 'Authentication', type: 'select', choices: [{ value: 'key-pair', label: 'Key pair (JWT)' }, { value: 'pat', label: 'Programmatic access token' }], help: 'The SQL API is called over HTTPS through the egress guard; the account host must be on CONNECTIONS_ALLOWED_HOSTS.' },
      { name: 'warehouse', label: 'Warehouse', type: 'text', placeholder: 'REPORTING_WH', help: 'The warehouse queries run on; the user\'s default when empty.' },
      { name: 'role', label: 'Role', type: 'text', placeholder: 'REPORTING_READER', help: 'A role with SELECT only; the user\'s default role when empty.' },
      { name: 'schema', label: 'Default schema', type: 'text', placeholder: 'PUBLIC', help: 'Unqualified table names resolve to this schema.' }
    ]
  },
  bigquery: {
    id: 'bigquery',
    title: 'BigQuery',
    family: 'sql',
    dialect: 'bigquery',
    transport: 'https',
    endpointHint: 'bigquery.googleapis.com',
    defaultPort: 443,
    database: { label: 'Project id', required: true, placeholder: 'my-analytics-project', help: 'The Google Cloud project queries run and are billed in.' },
    tlsRequired: true,
    dynamicCredentials: false,
    knowledgeSource: true,
    credential: { usernameLabel: 'Service account', usernameRequired: false, secretLabel: 'Service account key (JSON)', secretHelp: 'The service account\'s JSON key, with BigQuery Data Viewer and Job User only. Sealed, or a vault: reference. oauth2.googleapis.com must be on CONNECTIONS_ALLOWED_HOSTS too.', multiline: true },
    options: [
      { name: 'location', label: 'Location', type: 'text', placeholder: 'EU', help: 'Where query jobs run (US, EU or a region). Schema listing reads this region\'s INFORMATION_SCHEMA.' },
      { name: 'maximumBytesBilled', label: 'Maximum bytes billed', type: 'number', placeholder: '10000000000', help: 'A query that would bill more fails before it runs.' }
    ]
  }
,
  redis: {
    id: 'redis',
    title: 'Redis',
    family: 'keyvalue',
    dialect: null,
    transport: 'tcp',
    endpointHint: 'host:6379',
    defaultPort: 6379,
    database: { label: 'Database number', required: false, placeholder: '0', help: 'The logical database (0 to 15) when the server has several.' },
    tlsRequired: false,
    dynamicCredentials: false,
    knowledgeSource: false,
    credential: { usernameLabel: 'ACL user', usernameRequired: false, secretLabel: 'Password', secretHelp: 'An ACL user allowed read commands only (+@read -@write -@dangerous) on the key patterns it needs. Sealed, or a vault: reference.', multiline: false },
    options: [{ name: 'scanLimit', label: 'Scan limit', type: 'number', placeholder: '10000', help: 'How many keys one read may walk with SCAN before it stops.' }],
    queryHint: 'One read command: GET, MGET, HGETALL, HMGET, LRANGE, SMEMBERS, ZRANGE, XRANGE, TYPE, TTL, SCAN with MATCH',
    examples: [
      { label: 'Keys', query: 'SCAN 0 MATCH {object} COUNT 100' },
      { label: 'Hash', query: 'HGETALL {object}' }
    ],
    objectNoun: 'key pattern'
  },
  rabbitmq: {
    id: 'rabbitmq',
    title: 'RabbitMQ',
    family: 'queue',
    dialect: null,
    transport: 'https',
    endpointHint: 'https://rabbit.internal:15671',
    defaultPort: 15671,
    database: { label: 'Virtual host', required: false, placeholder: '/', help: 'The virtual host whose queues are read; every host the user may see when empty.' },
    tlsRequired: false,
    dynamicCredentials: false,
    knowledgeSource: false,
    credential: { ...PASSWORD, usernameLabel: 'User', secretHelp: 'A user tagged monitoring (or none) with read permission on the queues only, through the management API. Sealed, or a vault: reference.' },
    options: [{ name: 'peek', label: 'Peek at messages', type: 'select', choices: [{ value: 'off', label: 'Off: counts and rates only' }, { value: 'on', label: 'On: fetch and requeue at once' }], help: 'Peeking takes messages and puts them straight back, which marks them redelivered and can reorder a queue. Off by default.' }],
    queryHint: 'queues, queue <vhost>/<name>, exchanges, bindings <vhost>/<queue>, or peek <vhost>/<name> [count]',
    examples: [
      { label: 'Queues', query: 'queues' },
      { label: 'One queue', query: 'queue {object}' }
    ],
    objectNoun: 'queue'
  },
  prometheus: {
    id: 'prometheus',
    title: 'Prometheus',
    family: 'timeseries',
    dialect: null,
    transport: 'https',
    endpointHint: 'https://prometheus.internal:9090',
    defaultPort: 9090,
    database: null,
    tlsRequired: false,
    dynamicCredentials: false,
    knowledgeSource: false,
    credential: { usernameLabel: 'User', usernameRequired: false, secretLabel: 'Password or token', secretHelp: 'With a user, basic authentication; without, a bearer token. Leave both empty for a Prometheus without authentication. Sealed, or a vault: reference.', multiline: false },
    options: [
      { name: 'defaultRange', label: 'Default range', type: 'text', placeholder: '1h', help: 'The range a query covers when it names none.' },
      { name: 'maxPoints', label: 'Points per series', type: 'number', placeholder: '1000', help: 'Range queries return at most this many points per series; the step grows to fit.' }
    ],
    queryHint: 'PromQL, as an instant query; or JSON {"query", "start", "end", "step"} for a range',
    examples: [
      { label: 'Now', query: '{object}' },
      { label: 'Rate, 5m', query: 'sum by (job) (rate({object}[5m]))' }
    ],
    objectNoun: 'metric'
  },
  influxdb: {
    id: 'influxdb',
    title: 'InfluxDB',
    family: 'timeseries',
    dialect: null,
    transport: 'https',
    endpointHint: 'https://influx.internal:8086',
    defaultPort: 8086,
    database: { label: 'Database or bucket', required: true, placeholder: 'telemetry', help: 'v1 and v3: the database. v2: the bucket, mapped to a database through the v1 compatibility API (DBRP).' },
    tlsRequired: false,
    dynamicCredentials: false,
    knowledgeSource: false,
    credential: { usernameLabel: 'User', usernameRequired: false, secretLabel: 'Password or token', secretHelp: 'v1: the user\'s password. v2 and v3: a read-only token (leave the user empty). Sealed, or a vault: reference.', multiline: false },
    options: [
      { name: 'version', label: 'Version', type: 'select', choices: [{ value: 'v1', label: 'InfluxDB 1.x' }, { value: 'v2', label: 'InfluxDB 2.x' }, { value: 'v3', label: 'InfluxDB 3' }], help: 'Which API the connection speaks. Flux is not offered: it can write.' },
      { name: 'retentionPolicy', label: 'Retention policy', type: 'text', placeholder: 'autogen', help: 'v1 and v2: the retention policy; the database\'s default when empty.' },
      { name: 'language', label: 'Query language', type: 'select', choices: [{ value: 'influxql', label: 'InfluxQL' }, { value: 'sql', label: 'SQL' }], help: 'v3 reads SQL or InfluxQL.', when: { option: 'version', value: 'v3' } }
    ],
    queryHint: 'One InfluxQL SELECT or SHOW (v3: or SQL, as set)',
    examples: [
      { label: 'Last hour', query: 'SELECT mean(*) FROM "{object}" WHERE time > now() - 1h GROUP BY time(5m)' },
      { label: 'Fields', query: 'SHOW FIELD KEYS FROM "{object}"' }
    ],
    objectNoun: 'measurement'
  },
  // 1.9.99-final, Sprint 59 (B-10304): the MongoDB driver with each service's TLS and authentication quirks.
  documentdb: {
    id: 'documentdb',
    title: 'Amazon DocumentDB',
    family: 'document',
    dialect: null,
    transport: 'tcp',
    endpointHint: 'cluster.cluster-ro-xxxx.eu-west-1.docdb.amazonaws.com:27017',
    defaultPort: 27017,
    database: { label: 'Database', required: true, placeholder: 'catalog', help: 'The database whose collections the connection reads.' },
    tlsRequired: false,
    dynamicCredentials: false,
    knowledgeSource: true,
    credential: { ...PASSWORD, secretHelp: 'A DocumentDB user with the read role on the database only. Sealed with the tenant key, or a vault: reference.' },
    options: [
      { name: 'tlsCaFile', label: 'CA bundle file', type: 'text', placeholder: '/etc/exprsn/ca/rds-global-bundle.pem', help: 'With TLS on (the DocumentDB default), the Amazon RDS CA bundle installed on this server. A connection made from a cloud account carries it.' },
      { name: 'readPreference', label: 'Read preference', type: 'select', choices: [{ value: 'secondaryPreferred', label: 'Replicas first (reader endpoint)' }, { value: 'primaryPreferred', label: 'Primary first' }, { value: 'primary', label: 'Primary only' }], help: 'Reads only either way.' }
    ],
    queryHint: 'JSON: {"find": "<collection>", "filter": {…}} or {"aggregate": "<collection>", "pipeline": […]}',
    objectNoun: 'collection'
  },
  'cosmos-mongodb': {
    id: 'cosmos-mongodb',
    title: 'Azure Cosmos DB for MongoDB (vCore)',
    family: 'document',
    dialect: null,
    transport: 'tcp',
    endpointHint: 'cluster.mongocluster.cosmos.azure.com:10260',
    defaultPort: 10260,
    database: { label: 'Database', required: true, placeholder: 'catalog', help: 'The database whose collections the connection reads.' },
    tlsRequired: true,
    dynamicCredentials: false,
    knowledgeSource: true,
    credential: { ...PASSWORD, secretHelp: 'A cluster user with read access to the database only. Sealed with the tenant key, or a vault: reference.' },
    options: [{ name: 'tlsCaFile', label: 'CA bundle file', type: 'text', placeholder: '/etc/ssl/cert.pem', help: 'Only when the cluster\'s certificate does not chain to a public CA (a private endpoint behind inspection).' }],
    queryHint: 'JSON: {"find": "<collection>", "filter": {…}} or {"aggregate": "<collection>", "pipeline": […]}',
    objectNoun: 'collection'
  },
  'do-mongodb': {
    id: 'do-mongodb',
    title: 'DigitalOcean Managed MongoDB',
    family: 'document',
    dialect: null,
    transport: 'tcp',
    endpointHint: 'db-mongodb-fra1-12345-0.b.db.ondigitalocean.com:27017',
    defaultPort: 27017,
    database: { label: 'Database', required: true, placeholder: 'admin', help: 'The database whose collections the connection reads.' },
    tlsRequired: true,
    dynamicCredentials: false,
    knowledgeSource: true,
    credential: { ...PASSWORD, secretHelp: 'A database user with the read role; write it admin/<user> (DigitalOcean users authenticate in admin). Sealed, or a vault: reference.' },
    options: [{ name: 'tlsCaFile', label: 'CA bundle file', type: 'text', placeholder: '/etc/exprsn/ca/do-mongodb.crt', help: 'The cluster\'s CA certificate (control panel, Connection details), installed on this server. A connection made from a cloud account carries it.' }],
    queryHint: 'JSON: {"find": "<collection>", "filter": {…}} or {"aggregate": "<collection>", "pipeline": […]}',
    objectNoun: 'collection'
  },
  dynamodb: {
    id: 'dynamodb',
    title: 'Amazon DynamoDB',
    family: 'keyvalue',
    dialect: null,
    transport: 'https',
    endpointHint: 'https://dynamodb.eu-west-1.amazonaws.com',
    defaultPort: 443,
    database: null,
    tlsRequired: false,
    dynamicCredentials: false,
    knowledgeSource: false,
    credential: { usernameLabel: 'Access key id', usernameRequired: true, secretLabel: 'Secret access key', secretHelp: 'An IAM key allowed dynamodb:Query, dynamodb:PartiQLSelect, dynamodb:DescribeTable and dynamodb:ListTables only. Sealed, or a vault: reference. The endpoint (or its VPC endpoint) must be on CONNECTIONS_ALLOWED_HOSTS unless it is internal.', multiline: false },
    options: [
      { name: 'region', label: 'Region', type: 'text', placeholder: 'eu-west-1', help: 'The signing region; read from the endpoint when empty.' },
      { name: 'consistentRead', label: 'Consistent reads', type: 'select', choices: [{ value: 'off', label: 'Eventually consistent' }, { value: 'on', label: 'Strongly consistent (tables only)' }], help: 'Strongly consistent reads cost twice the read capacity.' },
      { name: 'maxPages', label: 'Pages per read', type: 'number', placeholder: '10', help: 'How many 1 MB pages one read may fetch before it stops.' }
    ],
    queryHint: 'PartiQL SELECT … FROM "<table>" WHERE <partition key> = …, or JSON {"Query": {"TableName": …, "KeyConditionExpression": …}}; Scan and writes are refused',
    examples: [
      { label: 'By key', query: 'SELECT * FROM "{object}" WHERE pk = \'…\'' },
      { label: 'Query', query: '{"Query": {"TableName": "{object}", "KeyConditionExpression": "pk = :p", "ExpressionAttributeValues": {":p": {"S": "…"}}}}' }
    ],
    objectNoun: 'table'
  },
  'cosmos-nosql': {
    id: 'cosmos-nosql',
    title: 'Azure Cosmos DB for NoSQL',
    family: 'document',
    dialect: null,
    transport: 'https',
    endpointHint: 'https://account.documents.azure.com',
    defaultPort: 443,
    database: { label: 'Database', required: true, placeholder: 'catalog', help: 'The database whose containers the connection reads.' },
    tlsRequired: true,
    dynamicCredentials: false,
    knowledgeSource: false,
    credential: { usernameLabel: 'Client id (service principal)', usernameRequired: false, secretLabel: 'Account key or client secret', secretHelp: 'A read-only account key; or, for a service principal with the Cosmos DB Built-in Data Reader role, its client secret. Sealed, or a vault: reference.', multiline: false },
    options: [
      { name: 'auth', label: 'Authentication', type: 'select', choices: [{ value: 'key', label: 'Account key' }, { value: 'entra-service-principal', label: 'Microsoft Entra service principal' }], help: 'A service principal signs in with its client id and secret; login.microsoftonline.com must be on CONNECTIONS_ALLOWED_HOSTS.' },
      { name: 'entraTenantId', label: 'Entra tenant id', type: 'text', placeholder: '00000000-0000-0000-0000-000000000000', help: 'The directory (tenant) id of the app registration.', when: { option: 'auth', value: 'entra-service-principal' } }
    ],
    queryHint: 'One SQL SELECT (SELECT TOP 10 * FROM c WHERE c.status = "open"); or JSON {"container", "query", "parameters"}',
    examples: [
      { label: 'Top 10', query: 'SELECT TOP 10 * FROM c' },
      { label: 'Count', query: 'SELECT VALUE COUNT(1) FROM c' }
    ],
    objectNoun: 'container'
  },
  // 1.9.99-final, Sprint 61 (B-10907): a D1 database as a read-only data connection, never Exprsn-AI's own database.
  'cloudflare-d1': {
    id: 'cloudflare-d1',
    title: 'Cloudflare D1',
    family: 'sql',
    dialect: 'sqlite',
    transport: 'https',
    endpointHint: 'https://api.cloudflare.com',
    defaultPort: 443,
    database: { label: 'Database id', required: true, placeholder: '00000000-0000-0000-0000-000000000000', help: 'The D1 database\'s id (UUID), from the dashboard or wrangler d1 list.' },
    tlsRequired: true,
    dynamicCredentials: false,
    knowledgeSource: true,
    credential: { usernameLabel: 'Cloudflare account id', usernameRequired: true, secretLabel: 'API token', secretHelp: 'A Cloudflare API token scoped to D1 on this account only. D1 has no read-only role: Exprsn-AI refuses every write before it is sent. Sealed, or a vault: reference. api.cloudflare.com must be on CONNECTIONS_ALLOWED_HOSTS.', multiline: false },
    options: [],
    queryHint: 'One SQLite SELECT (or WITH … SELECT); writes, PRAGMA, ATTACH and schema changes are refused',
    examples: [
      { label: 'First rows', query: 'SELECT * FROM {object} LIMIT 50' },
      { label: 'Count', query: 'SELECT count(*) AS n FROM {object}' }
    ],
    objectNoun: 'table'
  }
};

export const engineInfo = (e: Engine): EngineInfo => CATALOGUE[e];

/** 2.0.x: how the console groups data connections (REST and non-REST API connections are grouped in rest.ts). */
export type EngineCategory = 'relational' | 'nosql' | 'messaging' | 'timeseries';
export const CATEGORY_TITLES: Record<EngineCategory, string> = { relational: 'Relational databases', nosql: 'NoSQL and search', messaging: 'Messaging and cache', timeseries: 'Time series' };
export function categoryOf(e: Engine): EngineCategory {
  const f = CATALOGUE[e].family;
  if (f === 'sql') return 'relational';
  if (f === 'queue' || e === 'redis') return 'messaging';
  if (f === 'timeseries') return 'timeseries';
  return 'nosql';
}
export const isEngine = (e: string): e is Engine => (ENGINES as readonly string[]).includes(e);
export const engineTitle = (e: string): string => (isEngine(e) ? CATALOGUE[e].title : e);
export const isSqlEngine = (e: string): boolean => isEngine(e) && CATALOGUE[e].family === 'sql';

/** What the console's Register dialog is drawn from. */
export const engineCatalogue = (installed: readonly Engine[]): EngineInfo[] => ENGINES.filter((e) => installed.includes(e)).map((e) => CATALOGUE[e]);

/** An engine's settings, checked and with defaults; problems as plain sentences. */
export function parseOptions(engine: Engine, raw: unknown): { options: Record<string, unknown>; problems: string[] } {
  const r = OPTION_SCHEMAS[engine].safeParse(raw ?? {});
  if (!r.success) return { options: {}, problems: r.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`) };
  const options = r.data as Record<string, unknown>;
  const problems: string[] = [];
  if ((engine === 'azure-sql' || engine === 'cosmos-nosql') && options.auth === 'entra-service-principal' && !options.entraTenantId) problems.push('A service principal needs the Entra tenant id.');
  return { options, problems };
}
