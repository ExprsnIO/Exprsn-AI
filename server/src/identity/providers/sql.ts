import { realpathSync } from 'node:fs';
import { connect as netConnect, isIP, Socket } from 'node:net';
import path from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { checkHost, parseAllowList, type AllowList } from '../../mcp/hosts.js';
import { resolveSecret } from '../secrets.js';
import { burnPasswordCheck, hashScheme, verifyPassword } from '../passwords.js';
import { timed, type AuthResult, type ExternalUser, type IdentityProvider, type SqlConfig, type Step } from './types.js';

type Row = Record<string, unknown>;

const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 't' || v === 'true' || v === 'y' || v === 'Y';

export function parseGroups(v: unknown): string[] {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s) as unknown;
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }
  return s.split(',').map((g) => g.trim()).filter(Boolean);
}

/**
 * A user table in an existing PostgreSQL, MySQL or SQLite database. Column names come from configuration
 * (validated as plain identifiers and quoted by Knex); values are always bound parameters.
 * The connection is read-only in intent: grant this account SELECT on the user (and group) table only.
 */
export class SqlProvider implements IdentityProvider {
  readonly kind = 'sql' as const;
  private knex: Knex | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly cfg: SqlConfig,
    private readonly outbound: { allow: AllowList; refusedSqliteFiles: string[] } = { allow: parseAllowList(''), refusedSqliteFiles: [] }
  ) {}

  /**
   * The store's database may only be an internal host (or one on IDENTITY_ALLOWED_HOSTS), and a SQLite store may not
   * be the application's own database file: either would turn "Test a login" into an oracle for someone else's data.
   * Returns the checked addresses of a network store, which is then dialled by address (B-809).
   */
  private async checkTarget(conn: string): Promise<{ host: string; port: number; addresses: string[] } | null> {
    if (this.cfg.dialect === 'sqlite') {
      const real = (p: string) => {
        try {
          return realpathSync(p);
        } catch {
          return path.resolve(p);
        }
      };
      if (this.outbound.refusedSqliteFiles.some((f) => real(f) === real(conn))) throw new Error('The store cannot be the application\'s own database.');
      return null;
    }
    let url: URL;
    try {
      url = new URL(conn);
    } catch {
      throw new Error('The connection must be a URL (postgres://… or mysql://…).');
    }
    const { addresses } = await checkHost(url.hostname, this.outbound.allow);
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (this.cfg.dialect === 'pg' ? 5432 : 3306), addresses };
  }

  /**
   * The driver settings for one new pool connection. The host is resolved and checked for every connection, and the
   * driver dials exactly the checked address through its `stream` option, so a name that re-resolves somewhere else
   * after the check (DNS rebinding) is never dialled. TLS still verifies the configured name.
   */
  private async settings(conn: string, steps?: Step[]): Promise<Record<string, unknown>> {
    const target = await timed(steps, 'Check the database host', () => this.checkTarget(conn));
    const t = target!;
    const address = t.addresses[0]!;
    // Refresh the settings (and so re-check the host) for every new connection.
    const expirationChecker = () => true;
    if (this.cfg.dialect === 'pg') {
      const stream = () => {
        const sock = new Socket();
        const dial = sock.connect.bind(sock) as (port: number, host: string) => Socket;
        // node-postgres calls connect(port, host) with the configured name; dial the checked address instead.
        (sock as unknown as { connect: (port: number) => Socket }).connect = (port: number) => dial(port, address);
        return sock;
      };
      return { connectionString: conn, statement_timeout: this.cfg.timeoutMs, stream, expirationChecker };
    }
    // mysql2 takes a connected stream; its TLS upgrade verifies the configured host name.
    const stream = () => netConnect({ host: address, port: t.port, family: isIP(address) });
    return { uri: conn, connectTimeout: this.cfg.timeoutMs, stream, expirationChecker };
  }

  private async db(steps?: Step[]): Promise<Knex> {
    if (this.knex) return this.knex;
    const conn = resolveSecret(this.cfg.connection);
    if (this.cfg.dialect === 'sqlite') await timed(steps, 'Check the database file', () => this.checkTarget(conn));
    // The first check runs now, so a refused host fails the test with its own step before any pool exists.
    else await this.settings(conn, steps);
    if (this.knex) return this.knex;
    const pool = { min: 0, max: 4, acquireTimeoutMillis: this.cfg.timeoutMs };
    switch (this.cfg.dialect) {
      case 'pg':
        this.knex = knexFactory({ client: 'pg', connection: (() => this.settings(conn)) as unknown as Knex.StaticConnectionConfig, pool });
        break;
      case 'mysql':
        this.knex = knexFactory({ client: 'mysql2', connection: (() => this.settings(conn)) as unknown as Knex.StaticConnectionConfig, pool });
        break;
      case 'sqlite':
        this.knex = knexFactory({ client: 'better-sqlite3', connection: { filename: conn, options: { readonly: true, fileMustExist: true } } as Knex.Sqlite3ConnectionConfig, useNullAsDefault: true, pool: { min: 1, max: 1 } });
        break;
    }
    return this.knex;
  }

  private async findRow(username: string, steps?: Step[]): Promise<Row | null> {
    const c = this.cfg.columns;
    const cols = [c.id, c.username, c.passwordHash, c.displayName, c.email, c.disabled, c.groups].filter((x): x is string => !!x);
    const rows = await timed(
      steps,
      `Query ${this.cfg.table}`,
      async () => {
        const q = (await this.db())(this.cfg.table).select(cols).limit(2);
        if (this.cfg.caseInsensitive) q.whereRaw('LOWER(??) = ?', [c.username, username.toLowerCase()]);
        else q.where(c.username, username);
        return (await q) as Row[];
      },
      (r) => `${r.length} row${r.length === 1 ? '' : 's'}`
    );
    if (rows.length > 1) throw new Error(`More than one row in ${this.cfg.table} matches this username`);
    return rows[0] ?? null;
  }

  private async groupsFor(row: Row, steps?: Step[]): Promise<string[]> {
    const groups = this.cfg.columns.groups ? parseGroups(row[this.cfg.columns.groups]) : [];
    const gt = this.cfg.groupTable;
    if (gt) {
      const key = row[this.cfg.columns.id ?? this.cfg.columns.username];
      const rows = await timed(steps, `Query ${gt.table}`, async () => (await this.db())(gt.table).select(gt.groupColumn).where(gt.userColumn, key as string) as Promise<Row[]>, (r) => `${r.length} groups`);
      groups.push(...rows.map((r) => String(r[gt.groupColumn])));
    }
    return [...new Set(groups)];
  }

  private toUser(row: Row, groups: string[]): ExternalUser {
    const c = this.cfg.columns;
    const username = String(row[c.username]);
    return {
      externalId: String(row[c.id ?? c.username]),
      username,
      displayName: c.displayName && row[c.displayName] ? String(row[c.displayName]) : username,
      email: c.email && row[c.email] ? String(row[c.email]) : null,
      groups
    };
  }

  async authenticate(username: string, password: string, steps?: Step[]): Promise<AuthResult> {
    if (!password) return { status: 'invalid' };
    try {
      const row = await this.findRow(username, steps);
      if (!row) return { status: 'not_found' };
      const hash = String(row[this.cfg.columns.passwordHash] ?? '');
      if (hashScheme(hash) === 'unsupported') {
        await burnPasswordCheck(password);
        steps?.push({ title: 'Verify password', ok: false, detail: 'Unsupported hash format (argon2 or bcrypt required)' });
        return { status: 'invalid' };
      }
      const ok = await timed(steps, `Verify ${hashScheme(hash)} hash`, () => verifyPassword(hash, password), (v) => (v ? 'match' : 'no match'));
      if (!ok) return { status: 'invalid' };
      if (this.cfg.columns.disabled && truthy(row[this.cfg.columns.disabled])) return { status: 'disabled' };
      return { status: 'ok', user: this.toUser(row, await this.groupsFor(row, steps)) };
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    }
  }

  async lookup(username: string, steps?: Step[]): Promise<ExternalUser | null> {
    const row = await this.findRow(username, steps);
    if (!row) return null;
    return this.toUser(row, await this.groupsFor(row, steps));
  }

  async test(steps: Step[]): Promise<boolean> {
    try {
      const db = await this.db(steps);
      await timed(steps, `Connect (${this.cfg.dialect})`, () => db.raw('select 1'));
      const c = this.cfg.columns;
      const cols = [c.id, c.username, c.passwordHash, c.displayName, c.email, c.disabled, c.groups].filter((x): x is string => !!x);
      await timed(steps, `Read columns of ${this.cfg.table}`, () => db(this.cfg.table).select(cols).limit(0));
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.knex?.destroy();
    this.knex = null;
  }
}
