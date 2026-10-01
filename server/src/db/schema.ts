import type { Logger } from 'pino';
import type { Db } from './knex.js';
import { migrationSource } from './migrations/index.js';

/*
 * B-1403: safe upgrades.
 *
 * - The schema version handshake. This build knows the migrations in `db/migrations/index.ts`; its highest is the
 *   schema version it was written for. When the database has a migration applied that this build does not know (a
 *   newer release migrated it), this instance is older than the schema: it stops claiming jobs and `/readyz` reports
 *   not ready with the reason, so the load balancer drains it and the newer instances do the work.
 * - `migrate --check`: what `migrate` would apply, and which of those steps are destructive.
 * - The expand/contract rule (docs/PLAN.md): a migration's `up` only adds (expand). Dropping or renaming a column or
 *   table (contract) happens in a later release, once no running build reads the old shape, and the step carries an
 *   explicit `// contract: <reason>` marker on its line or the line above. `destructiveSteps` finds unmarked ones;
 *   server/test/sprint22-ops.test.ts runs it over every migration.
 */

/** Knex's bookkeeping table (the default name; `createDb` does not change it). */
export const MIGRATIONS_TABLE = 'knex_migrations';

/** Every migration name this build knows, in order. */
export async function knownMigrations(): Promise<string[]> {
  return [...(await migrationSource.getMigrations([]))].sort();
}

/** Migrations recorded as applied in the database, in order. Empty when the table does not exist yet. */
export async function appliedMigrations(db: Db): Promise<string[]> {
  if (!(await db.schema.hasTable(MIGRATIONS_TABLE))) return [];
  const rows = (await db(MIGRATIONS_TABLE).select('name')) as { name: string }[];
  // Older Knex versions recorded file names with an extension.
  return rows.map((r) => String(r.name).replace(/\.(ts|js)$/, '')).sort();
}

export interface SchemaStatus {
  /** The highest migration this build knows. */
  code: string | null;
  /** The highest migration applied to the database. */
  database: string | null;
  /** Known migrations not yet applied. */
  pending: string[];
  /** Applied migrations this build does not know: the database is newer than this build. */
  unknown: string[];
  state: 'current' | 'pending' | 'behind';
  /** Plain-language reason when the state is not current. */
  reason: string | null;
}

export async function schemaStatus(db: Db): Promise<SchemaStatus> {
  const [known, applied] = await Promise.all([knownMigrations(), appliedMigrations(db)]);
  const knownSet = new Set(known);
  const appliedSet = new Set(applied);
  const unknown = applied.filter((m) => !knownSet.has(m));
  const pending = known.filter((m) => !appliedSet.has(m));
  const code = known.at(-1) ?? null;
  const database = applied.at(-1) ?? null;
  if (unknown.length) {
    return { code, database, pending, unknown, state: 'behind', reason: `This instance is older than the database schema: the database has ${unknown.join(', ')}, and this build knows migrations up to ${code}. It takes no jobs and reports not ready until it is upgraded.` };
  }
  if (pending.length) return { code, database, pending, unknown, state: 'pending', reason: `${pending.length} migration${pending.length === 1 ? '' : 's'} pending (${pending.join(', ')}): run \`exprsn-ai migrate\`.` };
  return { code, database, pending, unknown, state: 'current', reason: null };
}

/** A destructive step in a migration's `up`. */
export interface DestructiveStep {
  /** The operation, e.g. `dropColumn` or `DROP COLUMN`. */
  op: string;
  /** The source line it was found on (trimmed). */
  line: string;
  /** Whether the step carries the `// contract:` marker. */
  marked: boolean;
}

const DESTRUCTIVE = [
  /\.(dropColumns?|renameColumn|dropTable|dropTableIfExists|renameTable|dropPrimary|dropForeign|dropUnique)\s*\(/,
  /\b(DROP\s+(COLUMN|TABLE)|RENAME\s+(COLUMN|TO)|ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE|MODIFY\s+COLUMN)\b/i
];
const MARKER = /\/\/\s*contract:\s*\S/;

/**
 * Destructive operations in the source of a migration's `up` function (from the .ts file, or `up.toString()` at run
 * time). Each is reported with whether it carries the `// contract: <reason>` marker on its line or the line above.
 */
export function destructiveSteps(source: string): DestructiveStep[] {
  const lines = source.split('\n');
  const out: DestructiveStep[] = [];
  lines.forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, '');
    for (const re of DESTRUCTIVE) {
      const m = re.exec(code);
      if (m) out.push({ op: m[1] ?? m[0], line: raw.trim().slice(0, 200), marked: MARKER.test(raw) || MARKER.test(lines[i - 1] ?? '') });
    }
  });
  return out;
}

/** The `up` function's source text of a migration module source (everything before `down`). */
export function upSource(moduleSource: string): string {
  const start = moduleSource.search(/export\s+async\s+function\s+up\s*\(/);
  if (start < 0) return '';
  const rest = moduleSource.slice(start);
  const end = rest.search(/export\s+async\s+function\s+down\s*\(/);
  return end < 0 ? rest : rest.slice(0, end);
}

export interface MigrateCheck extends SchemaStatus {
  /** Destructive steps in each pending migration's `up`. */
  destructive: { migration: string; steps: DestructiveStep[] }[];
}

/** What `migrate` would do, without doing it. */
export async function migrateCheck(db: Db): Promise<MigrateCheck> {
  const st = await schemaStatus(db);
  const destructive: MigrateCheck['destructive'] = [];
  for (const name of st.pending) {
    const m = (await migrationSource.getMigration(name)) as { up: (...a: unknown[]) => unknown };
    const steps = destructiveSteps(m.up.toString());
    if (steps.length) destructive.push({ migration: name, steps });
  }
  return { ...st, destructive };
}

/**
 * The handshake as a running service: checks the schema now and then and keeps the answer for the job queue and the
 * readiness probe. An instance that falls behind logs the reason once and recovers by itself if the state clears
 * (a rolled-back migration), so nothing here needs a restart.
 */
export class SchemaGuard {
  private status: SchemaStatus | null = null;
  private timer: NodeJS.Timeout | null = null;
  private onBehind: ((s: SchemaStatus) => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly log: Pick<Logger, 'error' | 'info'>,
    private readonly everyMs: number
  ) {}

  /** The last answer (null until the first check). */
  get current(): SchemaStatus | null {
    return this.status;
  }

  /** Why this instance must not take work, or null. Only `behind` refuses: pending migrations are refused at start. */
  refusal(): string | null {
    return this.status?.state === 'behind' ? this.status.reason : null;
  }

  listen(fn: (s: SchemaStatus) => void): void {
    this.onBehind.push(fn);
  }

  async check(): Promise<SchemaStatus> {
    const before = this.status?.state;
    const st = await schemaStatus(this.db);
    this.status = st;
    if (st.state === 'behind' && before !== 'behind') {
      this.log.error({ code: st.code, database: st.database, unknown: st.unknown }, st.reason ?? 'schema is newer than this build');
      for (const fn of this.onBehind) fn(st);
    } else if (before === 'behind' && st.state !== 'behind') this.log.info({ code: st.code, database: st.database }, 'schema handshake: this build matches the database again');
    return st;
  }

  start(): void {
    if (this.timer || this.everyMs <= 0) return;
    const tick = () => void this.check().catch(() => undefined);
    tick();
    this.timer = setInterval(tick, this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
