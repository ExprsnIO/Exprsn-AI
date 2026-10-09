import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import { mongoAccount } from '../connections/mongo.js';
import { checkHost, parseAllowList, type AllowList } from '../mcp/hosts.js';

/*
 * The built-in database engines behind tenant leases (B-1704): PostgreSQL and MySQL. An engine logs in with its admin
 * account and runs statements from a fixed set only:
 *
 *   PostgreSQL  CREATE ROLE "<user>" WITH LOGIN … PASSWORD '<pw>' VALID UNTIL '<ts>'; GRANT CONNECT ON DATABASE;
 *               GRANT USAGE ON SCHEMA; GRANT <privileges> ON ALL TABLES IN SCHEMA (and sequences for read-write);
 *               ALTER ROLE … VALID UNTIL (renew); REVOKE … then DROP ROLE (revoke and expiry).
 *   MySQL       CREATE USER '<user>'@'<host>' IDENTIFIED BY '<pw>'; GRANT <privileges> ON `<db>`.*; DROP USER.
 *
 *   MongoDB     (1.6.0, B-4802) createUser in the engine's database (default `admin`) with `read` or `readWrite` on
 *               each of the role's databases and the lease's expiry in `customData`; updateUser (renew moves
 *               `customData` only: MongoDB accounts carry no expiry, the sweeper enforces it); killAllSessionsByPattern
 *               then dropUser (revoke and expiry). Commands are documents, never strings: there is nothing to splice.
 *
 * Nothing from a request is spliced into SQL as text: user names are generated here (`exai_<role>_<12 hex>`), passwords
 * are random, schema and database names are checked against a strict identifier pattern when they are saved and are
 * quoted per dialect again here, and the only parameters that vary are bound where the protocol allows it (the
 * existence checks). Utility statements (CREATE ROLE, GRANT) cannot take bind parameters, which is why every value in
 * them is generated or validated, then quoted.
 */

export type Dialect = 'postgres' | 'mysql' | 'mongodb';
export const DIALECTS: readonly Dialect[] = ['postgres', 'mysql', 'mongodb'];
export type Privileges = 'read' | 'readwrite';
export const PRIVILEGES: readonly Privileges[] = ['read', 'readwrite'];

/** A schema (PostgreSQL) or database (MySQL, MongoDB) name a role may be granted on. */
export const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
/** A role name as saved: it becomes part of generated user names. */
export const ROLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** Generated user names: short enough for MySQL (32 characters). */
export const LEASE_USER = /^exai_[a-z0-9_]{1,10}_[0-9a-f]{12}$/;

export interface EngineTarget {
  dialect: Dialect;
  endpoint: string;
  database: string | null;
  tls: boolean;
  adminUsername: string;
  adminPassword: string;
  /** MySQL account host for generated users (`%` by default). Unused by PostgreSQL and MongoDB. */
  userHost: string;
}

export interface LeaseGrant {
  privileges: Privileges;
  /** PostgreSQL schemas, or MySQL databases. */
  schemas: string[];
}

/** One admin session's worth of operations against a target database. */
export interface DbAdmin {
  /** The server version and whether the admin account can create and drop accounts. */
  test(timeoutMs: number): Promise<{ version: string; canCreate: boolean; detail: string }>;
  createUser(username: string, password: string, validUntil: Date, grant: LeaseGrant): Promise<void>;
  /** Moves the account's expiry (PostgreSQL `VALID UNTIL`; MySQL has no equivalent and the sweeper enforces it). */
  extend(username: string, validUntil: Date): Promise<void>;
  /** Ends the account's sessions where the admin may, revokes its grants and drops it. Idempotent. */
  dropUser(username: string, grant: LeaseGrant): Promise<void>;
  exists(username: string): Promise<boolean>;
}

export type DbAdminFactory = (t: EngineTarget) => DbAdmin;

// ---------- names, passwords, quoting ----------

export function leaseUsername(role: string): string {
  const name = `exai_${role.replace(/[^a-z0-9_]/g, '').slice(0, 10) || 'role'}_${randomBytes(6).toString('hex')}`;
  if (!LEASE_USER.test(name)) throw new Error('Could not generate a safe user name.');
  return name;
}

/** 32 random characters plus one of each character class, for servers with a password policy. */
export function leasePassword(): string {
  return `${randomBytes(24).toString('base64url')}aZ7-`;
}

const SAFE_LITERAL = /^[\x20-\x5b\x5d-\x7e]*$/; // printable ASCII without the backslash

export function pgIdent(name: string): string {
  if (!name || name.includes('\0')) throw new Error('Invalid identifier.');
  return '"' + name.replace(/"/g, '""') + '"';
}

export function pgLiteral(value: string): string {
  if (!SAFE_LITERAL.test(value)) throw new Error('Refusing a literal with control characters or a backslash.');
  return "'" + value.replace(/'/g, "''") + "'";
}

export function mysqlIdent(name: string): string {
  if (!name || name.includes('\0')) throw new Error('Invalid identifier.');
  return '`' + name.replace(/`/g, '``') + '`';
}

export function mysqlString(value: string): string {
  if (!SAFE_LITERAL.test(value)) throw new Error('Refusing a literal with control characters or a backslash.');
  return "'" + value.replace(/'/g, "''") + "'";
}

const assertUser = (u: string) => {
  if (!LEASE_USER.test(u)) throw new Error('Refusing a user name this engine did not generate.');
};
const assertSchemas = (g: LeaseGrant) => {
  if (!g.schemas.length || g.schemas.some((s) => !SCHEMA_NAME.test(s))) throw new Error('Refusing a schema name outside the allowed pattern.');
};

// ---------- statements (pure, so they are tested on their own) ----------

const pgTablePrivs = (p: Privileges) => (p === 'readwrite' ? 'SELECT, INSERT, UPDATE, DELETE' : 'SELECT');

export const pgStatements = {
  create(username: string, password: string, validUntil: Date, database: string | null, g: LeaseGrant): string[] {
    assertUser(username);
    assertSchemas(g);
    const u = pgIdent(username);
    const out = [`CREATE ROLE ${u} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD ${pgLiteral(password)} VALID UNTIL ${pgLiteral(validUntil.toISOString())}`];
    if (database) out.push(`GRANT CONNECT ON DATABASE ${pgIdent(database)} TO ${u}`);
    for (const s of g.schemas) {
      out.push(`GRANT USAGE ON SCHEMA ${pgIdent(s)} TO ${u}`);
      out.push(`GRANT ${pgTablePrivs(g.privileges)} ON ALL TABLES IN SCHEMA ${pgIdent(s)} TO ${u}`);
      if (g.privileges === 'readwrite') out.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${pgIdent(s)} TO ${u}`);
    }
    return out;
  },
  extend(username: string, validUntil: Date): string[] {
    assertUser(username);
    return [`ALTER ROLE ${pgIdent(username)} VALID UNTIL ${pgLiteral(validUntil.toISOString())}`];
  },
  revoke(username: string, database: string | null, g: LeaseGrant): string[] {
    assertUser(username);
    assertSchemas(g);
    const u = pgIdent(username);
    const out = [`ALTER ROLE ${u} NOLOGIN`];
    for (const s of g.schemas) {
      out.push(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${pgIdent(s)} FROM ${u}`);
      out.push(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${pgIdent(s)} FROM ${u}`);
      out.push(`REVOKE ALL PRIVILEGES ON SCHEMA ${pgIdent(s)} FROM ${u}`);
    }
    if (database) out.push(`REVOKE ALL PRIVILEGES ON DATABASE ${pgIdent(database)} FROM ${u}`);
    return out;
  },
  drop(username: string): string[] {
    assertUser(username);
    return [`DROP ROLE IF EXISTS ${pgIdent(username)}`];
  }
};

export const mysqlStatements = {
  account(username: string, host: string): string {
    assertUser(username);
    return `${mysqlString(username)}@${mysqlString(host)}`;
  },
  create(username: string, password: string, host: string, g: LeaseGrant): string[] {
    assertSchemas(g);
    const a = mysqlStatements.account(username, host);
    const privs = g.privileges === 'readwrite' ? 'SELECT, INSERT, UPDATE, DELETE' : 'SELECT';
    return [`CREATE USER ${a} IDENTIFIED BY ${mysqlString(password)}`, ...g.schemas.map((s) => `GRANT ${privs} ON ${mysqlIdent(s)}.* TO ${a}`)];
  },
  drop(username: string, host: string): string[] {
    return [`DROP USER IF EXISTS ${mysqlStatements.account(username, host)}`];
  }
};

/** MongoDB (1.6.0, B-4802): the commands, as documents, run against the engine's user database. */
export const mongoCommands = {
  create(username: string, password: string, validUntil: Date, g: LeaseGrant): Record<string, unknown> {
    assertUser(username);
    assertSchemas(g);
    if (g.schemas.some((d) => d.includes('$') || d === 'admin' || d === 'local' || d === 'config')) throw new Error('Refusing a MongoDB database name a lease may not be granted on.');
    const role = g.privileges === 'readwrite' ? 'readWrite' : 'read';
    return { createUser: username, pwd: password, roles: g.schemas.map((db) => ({ role, db })), customData: { exprsnLease: true, validUntil: validUntil.toISOString() }, mechanisms: ['SCRAM-SHA-256'] };
  },
  extend(username: string, validUntil: Date): Record<string, unknown> {
    assertUser(username);
    return { updateUser: username, customData: { exprsnLease: true, validUntil: validUntil.toISOString() } };
  },
  killSessions(username: string, userDb: string): Record<string, unknown> {
    assertUser(username);
    return { killAllSessionsByPattern: [{ users: [{ user: username, db: userDb }] }] };
  },
  drop(username: string): Record<string, unknown> {
    assertUser(username);
    return { dropUser: username };
  }
};

// ---------- connections ----------

const hostPort = (endpoint: string, defaultPort: number): { host: string; port: number } => {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(endpoint.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, ''));
  return { host: m?.[1] ?? endpoint, port: m?.[2] ? Number(m[2]) : defaultPort };
};

const TIMEOUT_MS = 15_000;

/** PostgreSQL: the admin account needs CREATEROLE, and grant options on what its roles may read or write. */
export class PostgresAdmin implements DbAdmin {
  constructor(
    private readonly t: EngineTarget,
    private readonly allow: AllowList
  ) {}

  private async session<T>(fn: (c: pg.Client) => Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
    const { host, port } = hostPort(this.t.endpoint, 5432);
    // Resolve and check once, then dial the checked address (TLS still verifies the name), as data connections do.
    const { addresses } = await checkHost(host, this.allow);
    const c = new pg.Client({
      host: addresses[0],
      port,
      database: this.t.database ?? undefined,
      user: this.t.adminUsername,
      password: this.t.adminPassword,
      ssl: this.t.tls ? { rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }) } : undefined,
      connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
      statement_timeout: timeoutMs,
      query_timeout: timeoutMs + 2000,
      application_name: 'exprsn-ai-leases'
    });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  private async tx(c: pg.Client, statements: string[]): Promise<void> {
    await c.query('BEGIN');
    try {
      for (const sql of statements) await c.query(sql);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  test(timeoutMs: number) {
    return this.session(async (c) => {
      const r = await c.query<{ version: string; createrole: boolean; superuser: boolean }>('SELECT version() AS version, rolcreaterole AS createrole, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user');
      const row = r.rows[0];
      const canCreate = !!row && (row.createrole || row.superuser);
      return { version: row?.version ?? 'unknown', canCreate, detail: canCreate ? `${this.t.adminUsername} can create roles.` : `${this.t.adminUsername} lacks CREATEROLE; leases cannot be issued.` };
    }, timeoutMs);
  }

  createUser(username: string, password: string, validUntil: Date, grant: LeaseGrant) {
    return this.session((c) => this.tx(c, pgStatements.create(username, password, validUntil, this.t.database, grant)));
  }

  extend(username: string, validUntil: Date) {
    return this.session((c) => this.tx(c, pgStatements.extend(username, validUntil)));
  }

  exists(username: string) {
    return this.session(async (c) => (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username])).rowCount! > 0);
  }

  dropUser(username: string, grant: LeaseGrant) {
    return this.session(async (c) => {
      if (!(await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username])).rowCount) return;
      // One by one: a schema dropped since the lease was issued must not keep the account alive. DROP ROLE below is
      // what decides; it fails while any grant remains.
      for (const sql of pgStatements.revoke(username, this.t.database, grant)) await c.query(sql).catch(() => undefined);
      // Open sessions keep running after DROP ROLE; end them where the admin may (pg_signal_backend or a superuser).
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [username]).catch(() => undefined);
      try {
        await this.tx(c, pgStatements.drop(username));
      } catch (err) {
        // Objects the account created itself (where PUBLIC may create, as before PostgreSQL 15) block the drop.
        if ((err as { code?: string }).code !== '2BP01') throw err;
        await this.tx(c, [`DROP OWNED BY ${pgIdent(username)}`, ...pgStatements.drop(username)]);
      }
    });
  }
}

/** MySQL: the admin account needs CREATE USER and the grant option on the databases its roles name. */
export class MysqlAdmin implements DbAdmin {
  constructor(
    private readonly t: EngineTarget,
    private readonly allow: AllowList
  ) {}

  private async session<T>(fn: (c: mysql.Connection) => Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
    const { host, port } = hostPort(this.t.endpoint, 3306);
    const { addresses } = await checkHost(host, this.allow);
    const c = await mysql.createConnection({
      host: addresses[0],
      port,
      database: this.t.database ?? undefined,
      user: this.t.adminUsername,
      password: this.t.adminPassword,
      ssl: this.t.tls ? { rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }) } : undefined,
      connectTimeout: Math.min(timeoutMs, 10_000),
      multipleStatements: false,
      charset: 'utf8mb4'
    });
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  test(timeoutMs: number) {
    return this.session(async (c) => {
      const [v] = (await c.query('SELECT VERSION() AS version')) as unknown as [{ version: string }[]];
      const [g] = (await c.query('SHOW GRANTS FOR CURRENT_USER()')) as unknown as [Record<string, string>[]];
      const text = g.map((r) => Object.values(r)[0] ?? '').join('\n');
      const canCreate = /\bALL PRIVILEGES ON \*\.\*|CREATE USER/i.test(text);
      return { version: v[0]?.version ?? 'unknown', canCreate, detail: canCreate ? `${this.t.adminUsername} can create users.` : `${this.t.adminUsername} lacks CREATE USER; leases cannot be issued.` };
    }, timeoutMs);
  }

  createUser(username: string, password: string, _validUntil: Date, grant: LeaseGrant) {
    return this.session(async (c) => {
      const [create, ...grants] = mysqlStatements.create(username, password, this.t.userHost, grant);
      await c.query(create!);
      try {
        for (const sql of grants) await c.query(sql);
      } catch (err) {
        // CREATE USER and GRANT commit on their own in MySQL: undo the account by hand.
        await c.query(mysqlStatements.drop(username, this.t.userHost)[0]!).catch(() => undefined);
        throw err;
      }
    });
  }

  /** MySQL accounts carry no expiry time; the sweeper drops them when the lease ends. */
  async extend(): Promise<void> {}

  exists(username: string) {
    return this.session(async (c) => {
      try {
        await c.query(`SHOW GRANTS FOR ${mysqlStatements.account(username, this.t.userHost)}`);
        return true;
      } catch (err) {
        if ((err as { errno?: number }).errno === 1141) return false; // ER_NONEXISTING_GRANT
        throw err;
      }
    });
  }

  dropUser(username: string) {
    return this.session(async (c) => {
      // End its sessions where the admin may (CONNECTION_ADMIN); DROP USER does not end them.
      try {
        const [rows] = (await c.query('SELECT ID AS id FROM information_schema.PROCESSLIST WHERE USER = ?', [username])) as unknown as [{ id: number }[]];
        for (const r of rows) await c.query('KILL ?', [Number(r.id)]).catch(() => undefined);
      } catch {
        // no PROCESS privilege: the account is dropped all the same
      }
      await c.query(mysqlStatements.drop(username, this.t.userHost)[0]!);
    });
  }
}

/**
 * MongoDB (1.6.0, B-4802): the admin account needs `createUser`, `dropUser` and `grantRole` on the engine's database
 * (the userAdmin role there, or userAdminAnyDatabase), and `killAnySession` to end a dropped account's sessions (else
 * they run until they close). The admin authenticates against `admin` unless its name is written `<authdb>/<user>`;
 * leased users live in the engine's database (default `admin`) and authenticate there.
 */
export class MongoAdmin implements DbAdmin {
  constructor(
    private readonly t: EngineTarget,
    private readonly allow: AllowList
  ) {}

  private get userDb(): string {
    return this.t.database || 'admin';
  }

  private async session<T>(fn: (c: MongoClient) => Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
    const { host, port } = hostPort(this.t.endpoint, 27017);
    const { addresses } = await checkHost(host, this.allow);
    const address = addresses[0]!;
    // The checked address is pinned through `lookup`, so DNS cannot rebind; TLS still verifies the name.
    const pinned = (_h: string, opts: { all?: boolean } | number | undefined, cb: (err: Error | null, a: string | { address: string; family: number }[], family?: number) => void) => {
      const family = isIP(address);
      if (typeof opts === 'object' && opts?.all) cb(null, [{ address, family }]);
      else cb(null, address, family);
    };
    const { user, authSource } = mongoAccount(this.t.adminUsername, 'admin');
    const c = new MongoClient(`mongodb://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`, {
      directConnection: true,
      tls: this.t.tls,
      lookup: pinned as never,
      serverSelectionTimeoutMS: Math.min(timeoutMs, 10_000),
      connectTimeoutMS: Math.min(timeoutMs, 10_000),
      socketTimeoutMS: timeoutMs + 5000,
      maxPoolSize: 1,
      retryReads: false,
      retryWrites: false,
      appName: 'exprsn-ai-leases',
      auth: { username: user ?? this.t.adminUsername, password: this.t.adminPassword },
      authSource
    });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.close().catch(() => undefined);
    }
  }

  test(timeoutMs: number) {
    return this.session(async (c) => {
      const info = (await c.db('admin').command({ buildInfo: 1 })) as { version?: string };
      const status = (await c.db(this.userDb).command({ connectionStatus: 1, showPrivileges: true })) as { authInfo?: { authenticatedUserPrivileges?: { resource?: { db?: string; anyResource?: boolean; cluster?: boolean }; actions?: string[] }[] } };
      const privs = status.authInfo?.authenticatedUserPrivileges ?? [];
      const on = (action: string) => privs.some((p) => (p.actions ?? []).includes(action) && (p.resource?.anyResource || p.resource?.db === '' || p.resource?.db === this.userDb));
      const canCreate = on('createUser') && on('dropUser') && on('grantRole');
      return { version: info.version ? `MongoDB ${info.version}` : 'unknown', canCreate, detail: canCreate ? `${this.t.adminUsername} can create users in ${this.userDb}.` : `${this.t.adminUsername} lacks createUser, dropUser or grantRole on ${this.userDb}; leases cannot be issued.` };
    }, timeoutMs);
  }

  createUser(username: string, password: string, validUntil: Date, grant: LeaseGrant) {
    return this.session(async (c) => {
      await c.db(this.userDb).command(mongoCommands.create(username, password, validUntil, grant));
    });
  }

  /** MongoDB accounts carry no expiry: the new time is recorded in `customData`; the sweeper drops the account. */
  extend(username: string, validUntil: Date) {
    return this.session(async (c) => {
      await c.db(this.userDb).command(mongoCommands.extend(username, validUntil));
    });
  }

  exists(username: string) {
    return this.session(async (c) => {
      const r = (await c.db(this.userDb).command({ usersInfo: { user: username, db: this.userDb } })) as { users?: unknown[] };
      return (r.users ?? []).length > 0;
    });
  }

  dropUser(username: string) {
    return this.session(async (c) => {
      // End its sessions where the admin may (killAnySession); dropUser does not end them.
      await c.db('admin').command(mongoCommands.killSessions(username, this.userDb)).catch(() => undefined);
      try {
        await c.db(this.userDb).command(mongoCommands.drop(username));
      } catch (err) {
        if ((err as { code?: number }).code !== 11) throw err; // UserNotFound: already gone
      }
    });
  }
}

/** Engines dial internal hosts only, unless CONNECTIONS_ALLOWED_HOSTS names the host or its network. */
export const createDbAdmins =
  (allow: AllowList = parseAllowList('')): DbAdminFactory =>
  (t) =>
    t.dialect === 'postgres' ? new PostgresAdmin(t, allow) : t.dialect === 'mongodb' ? new MongoAdmin(t, allow) : new MysqlAdmin(t, allow);
