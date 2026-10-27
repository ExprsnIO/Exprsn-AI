/*
 * 2.0.x: editing and dropping through connections (ddl-edit.ts). An edited table is diffed against a hand-written
 * description and written as each dialect's ALTER, DROP and RENAME statements in a safe order; replaced indexes,
 * drops on every engine, and edits of non-SQL objects as their API operations. What a vendor cannot do in place is a
 * problem, a change that loses data is destructive, and the hash follows the statements.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, DdlProblem, type DdlPlan } from '../src/connections/ddl.js';
import { describeTarget, editKinds, widens } from '../src/connections/ddl-edit.js';
import type { DescribedColumn, DocumentDescription, ObjectDescription, TableDescription } from '../src/connections/ddl-edit-types.js';
import type { Engine } from '../src/connections/engines.js';

const ctx = (engine: Engine, database: string | null = 'db', options: Record<string, unknown> = {}) => ({ engine, database, account: 'app', options });
const plan = (engine: Engine, def: unknown, current: ObjectDescription | null = null, database: string | null = 'db', options: Record<string, unknown> = {}): DdlPlan => buildPlan(engine, ctx(engine, database, options), def, current);
const problems = (engine: Engine, def: unknown, current: ObjectDescription | null = null, database: string | null = 'db', options: Record<string, unknown> = {}): string[] => {
  try {
    plan(engine, def, current, database, options);
  } catch (err) {
    if (err instanceof DdlProblem) return err.problems;
    throw err;
  }
  return [];
};

const col = (name: string, type: DescribedColumn['type'], extra: Partial<DescribedColumn> = {}): DescribedColumn => ({ name, type, rawType: type?.type ?? 'unknown', nullable: true, default: null, identity: false, comment: null, ...extra });
const table = (name: string, columns: DescribedColumn[], extra: Partial<TableDescription> = {}): TableDescription => ({ kind: 'table', name, columns, primaryKey: null, uniques: [], foreignKeys: [], checks: [], indexes: [], comment: null, options: {}, ...extra });
/** The form as the console sends it back unchanged: every described column with `from`. */
const formOf = (t: TableDescription, extra: Record<string, unknown> = {}) => ({
  kind: 'alter-table',
  name: t.name,
  columns: t.columns.map((c) => ({ from: c.name, name: c.name, type: c.type, nullable: c.nullable, identity: c.identity, ...(c.default ? { default: c.default.kind === 'literal' ? { kind: 'literal', value: c.default.value } : { kind: 'expression', sql: c.default.value } } : {}), ...(c.comment ? { comment: c.comment } : {}) })),
  primaryKey: t.primaryKey?.columns ?? [],
  uniques: t.uniques.map((u) => ({ name: u.name, columns: u.columns })),
  foreignKeys: t.foreignKeys.map((f) => ({ name: f.name, columns: f.columns, refTable: f.refTable, refColumns: f.refColumns, ...(f.onDelete && f.onDelete !== 'NO ACTION' ? { onDelete: f.onDelete } : {}) })),
  checks: t.checks.map((c) => ({ name: c.name, expression: c.expression })),
  ...extra
});
type Form = ReturnType<typeof formOf>;
const edit = (f: Form, change: (cols: Record<string, unknown>[]) => void, extra: Record<string, unknown> = {}) => {
  const cols = f.columns.map((c) => ({ ...c })) as Record<string, unknown>[];
  change(cols);
  return { ...f, columns: cols, ...extra };
};

// PostgreSQL: sales.orders(id bigint identity pk, note varchar(200), amount numeric(12,2) not null default 0, status text) with a FK and a check.
const pgOrders = table(
  'sales.orders',
  [
    col('id', { type: 'bigint' }, { nullable: false, identity: true, rawType: 'bigint' }),
    col('note', { type: 'varchar', length: 200 }, { rawType: 'character varying(200)', comment: 'free text' }),
    col('amount', { type: 'numeric', precision: 12, scale: 2 }, { nullable: false, default: { kind: 'literal', value: '0' }, rawType: 'numeric(12,2)' }),
    col('status', { type: 'text' }),
    col('customer_id', { type: 'integer' })
  ],
  {
    primaryKey: { name: 'orders_pkey', columns: ['id'] },
    uniques: [{ name: 'uq_orders_note', columns: ['note'] }],
    foreignKeys: [{ name: 'fk_orders_customer', columns: ['customer_id'], refTable: 'sales.customers', refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }],
    checks: [{ name: 'ck_orders_amount', expression: 'CHECK ((amount >= (0)::numeric))' }],
    indexes: [
      { name: 'orders_pkey', columns: [{ name: 'id' }], unique: true, method: 'btree', where: null, include: [], constraint: true },
      { name: 'ix_orders_status', columns: [{ name: 'status' }], unique: false, method: 'btree', where: null, include: [], constraint: false }
    ],
    comment: 'Orders'
  }
);

describe('describe targets and edit kinds', () => {
  it('names what must be described before planning', () => {
    expect(describeTarget('postgres', { kind: 'alter-table', name: 'sales.orders' })).toEqual({ kind: 'table', name: 'sales.orders' });
    expect(describeTarget('postgres', { kind: 'replace-index', from: 'ix', table: 'sales.orders' })).toEqual({ kind: 'table', name: 'sales.orders' });
    expect(describeTarget('mongodb', { kind: 'edit', objectKind: 'collection', name: 'events', definition: {} })).toEqual({ kind: 'collection', name: 'events' });
    expect(describeTarget('redis', { kind: 'edit', objectKind: 'stream-group', name: 'workers', definition: { key: 'orders:events', group: 'workers' } })).toEqual({ kind: 'stream-group', name: 'orders:events' });
    expect(describeTarget('postgres', { kind: 'drop', objectKind: 'table', name: 't' })).toBeNull();
    expect(describeTarget('postgres', { kind: 'function', name: 'f', orReplace: true })).toBeNull();
    expect(describeTarget('postgres', null)).toBeNull();
  });

  it('lists the edit kinds and drops per engine', () => {
    expect(editKinds('postgres')).toEqual({ edit: ['alter-table', 'replace-index', 'procedure', 'function'], drop: ['table', 'view', 'index', 'procedure', 'function', 'dataset'] });
    expect(editKinds('snowflake')).toEqual({ edit: ['alter-table', 'procedure', 'function'], drop: ['table', 'view', 'procedure', 'function', 'dataset'] });
    expect(editKinds('oracle').drop).toEqual(['table', 'view', 'index', 'procedure', 'function']);
    expect(editKinds('cloudflare-d1').drop).toEqual(['table', 'view', 'index']);
    expect(editKinds('mongodb')).toEqual({ edit: ['collection'], drop: ['collection', 'index'] });
    expect(editKinds('opensearch')).toEqual({ edit: ['search-index'], drop: ['search-index'] });
    expect(editKinds('dynamodb')).toEqual({ edit: ['table'], drop: ['table', 'index'] });
    expect(editKinds('cosmos-nosql')).toEqual({ edit: ['container'], drop: ['container', 'dataset'] });
    expect(editKinds('influxdb')).toEqual({ edit: [], drop: ['dataset'] });
    expect(editKinds('redis')).toEqual({ edit: ['stream-group'], drop: ['stream-group'] });
    expect(editKinds('rabbitmq')).toEqual({ edit: [], drop: ['queue', 'exchange', 'binding'] });
  });
});

describe('alter-table: PostgreSQL', () => {
  const f = formOf(pgOrders);

  it('says when nothing changed, and when the table is gone', () => {
    expect(problems('postgres', f, pgOrders)).toEqual(['Nothing to change.']);
    expect(problems('postgres', f, null)).toEqual(['The table sales.orders does not exist.']);
    expect(problems('postgres', f, { ...pgOrders, kind: 'view' }).join(' ')).toMatch(/is a view/);
  });

  it('adds, drops and renames columns in a safe order', () => {
    const p = plan(
      'postgres',
      edit(f, (cols) => {
        cols.splice(3, 1); // drop status
        cols[1]!.name = 'remark'; // rename note
        cols.push({ name: 'shipped_at', type: { type: 'timestamptz' }, comment: "when it's shipped" });
      }, { uniques: [{ name: 'uq_orders_note', columns: ['remark'] }] }),
      pgOrders
    );
    expect(p.statements).toEqual([
      'ALTER TABLE "sales"."orders" DROP COLUMN "status"',
      'ALTER TABLE "sales"."orders" RENAME COLUMN "note" TO "remark"',
      'ALTER TABLE "sales"."orders" ADD COLUMN "shipped_at" timestamptz',
      `COMMENT ON COLUMN "sales"."orders"."shipped_at" IS 'when it''s shipped'`
    ]);
    expect(p).toMatchObject({ kind: 'alter-table', object: 'sales.orders', transactional: true, destructive: true, confirmName: 'sales.orders', touches: ['sales.orders'] });
  });

  it('changes a type with USING, nullability, defaults, comments and identity', () => {
    const p = plan(
      'postgres',
      edit(f, (cols) => {
        cols[0]!.identity = false; // drop identity (stays NOT NULL)
        cols[0]!.nullable = false;
        cols[2]!.type = { type: 'numeric', precision: 14, scale: 2 }; // widening
        cols[2]!.nullable = true;
        cols[2]!.default = { kind: 'expression', sql: '1 + 1' };
        cols[3]!.type = { type: 'integer' }; // text → integer: group change, USING added
        cols[1]!.comment = undefined;
        cols[4]!.type = { type: 'bigint' };
      }),
      pgOrders
    );
    expect(p.statements).toEqual([
      'ALTER TABLE "sales"."orders" ALTER COLUMN "id" DROP IDENTITY',
      'COMMENT ON COLUMN "sales"."orders"."note" IS NULL',
      'ALTER TABLE "sales"."orders" ALTER COLUMN "amount" TYPE numeric(14, 2)',
      'ALTER TABLE "sales"."orders" ALTER COLUMN "amount" DROP NOT NULL',
      'ALTER TABLE "sales"."orders" ALTER COLUMN "amount" SET DEFAULT 1 + 1',
      'ALTER TABLE "sales"."orders" ALTER COLUMN "status" TYPE integer USING "status"::integer',
      'ALTER TABLE "sales"."orders" ALTER COLUMN "customer_id" TYPE bigint'
    ]);
    // text → integer can lose data; numeric(12,2) → (14,2) and integer → bigint cannot.
    expect(p.destructive).toBe(true);
    expect(p.notes.join(' ')).toMatch(/Changing status from text to integer can lose data/);
    expect(p.notes.join(' ')).not.toMatch(/Changing amount/);

    const using = plan('postgres', edit(f, (cols) => (cols[3]!.type = { type: 'integer' }), { using: { status: "CASE WHEN status = 'x' THEN 1 END" } }), pgOrders);
    expect(using.statements).toEqual([`ALTER TABLE "sales"."orders" ALTER COLUMN "status" TYPE integer USING CASE WHEN status = 'x' THEN 1 END`]);
    expect(problems('postgres', edit(f, (cols) => (cols[3]!.type = { type: 'integer' }), { using: { status: 'x; DROP TABLE t' } }), pgOrders).join(' ')).toMatch(/USING expression of status/);

    const widen = plan('postgres', edit(f, (cols) => (cols[1]!.type = { type: 'varchar', length: 400 })), pgOrders);
    expect(widen).toMatchObject({ statements: ['ALTER TABLE "sales"."orders" ALTER COLUMN "note" TYPE varchar(400)'], destructive: false, confirmName: null });
    const narrow = plan('postgres', edit(f, (cols) => (cols[1]!.type = { type: 'varchar', length: 50 })), pgOrders);
    expect(narrow).toMatchObject({ destructive: true, confirmName: 'sales.orders' });

    const addIdentity = plan('postgres', edit(f, (cols) => Object.assign(cols[4]!, { identity: true })), pgOrders);
    expect(addIdentity.statements).toEqual(['ALTER TABLE "sales"."orders" ALTER COLUMN "customer_id" SET NOT NULL', 'ALTER TABLE "sales"."orders" ALTER COLUMN "customer_id" ADD GENERATED BY DEFAULT AS IDENTITY']);
  });

  it('treats a described default and the form default as the same value', () => {
    // '0' described, 0 in the form: no change.
    expect(problems('postgres', edit(f, (cols) => (cols[2]!.default = { kind: 'literal', value: 0 })), pgOrders)).toEqual(['Nothing to change.']);
    expect(plan('postgres', edit(f, (cols) => (cols[2]!.default = null)), pgOrders).statements).toEqual(['ALTER TABLE "sales"."orders" ALTER COLUMN "amount" DROP DEFAULT']);
    expect(plan('postgres', edit(f, (cols) => (cols[2]!.default = { kind: 'literal', value: 5 })), pgOrders).statements).toEqual(['ALTER TABLE "sales"."orders" ALTER COLUMN "amount" SET DEFAULT 5']);
  });

  it('drops, changes and adds constraints, then comments and renames the table last', () => {
    const p = plan(
      'postgres',
      {
        ...f,
        uniques: [{ columns: ['status'] }],
        foreignKeys: [{ name: 'fk_orders_customer', columns: ['customer_id'], refTable: 'sales.customers', refColumns: ['id'], onDelete: 'CASCADE' }],
        checks: [{ name: 'ck_orders_amount', expression: 'amount > 0' }],
        primaryKey: ['id', 'customer_id'],
        comment: 'All orders',
        rename: 'orders2'
      },
      pgOrders
    );
    expect(p.statements).toEqual([
      'ALTER TABLE "sales"."orders" DROP CONSTRAINT "fk_orders_customer"',
      'ALTER TABLE "sales"."orders" DROP CONSTRAINT "ck_orders_amount"',
      'ALTER TABLE "sales"."orders" DROP CONSTRAINT "uq_orders_note"',
      'ALTER TABLE "sales"."orders" DROP CONSTRAINT "orders_pkey"',
      'ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id", "customer_id")',
      'ALTER TABLE "sales"."orders" ADD CONSTRAINT "uq_orders_status" UNIQUE ("status")',
      'ALTER TABLE "sales"."orders" ADD CONSTRAINT "fk_orders_customer" FOREIGN KEY ("customer_id") REFERENCES "sales"."customers" ("id") ON DELETE CASCADE',
      'ALTER TABLE "sales"."orders" ADD CONSTRAINT "ck_orders_amount" CHECK (amount > 0)',
      `COMMENT ON TABLE "sales"."orders" IS 'All orders'`,
      'ALTER TABLE "sales"."orders" RENAME TO "orders2"'
    ]);
    expect(p.touches).toEqual(['sales.orders', 'sales.customers']);
    expect(p.destructive).toBe(false);
    expect(p.notes.join(' ')).toMatch(/moves to the new name orders2/);
  });

  it('keeps a check whose text the database reports differently, and refuses unknown columns', () => {
    expect(problems('postgres', { ...f, checks: [{ name: 'ck_orders_amount', expression: 'amount >= (0)::numeric' }] }, pgOrders)).toEqual(['Nothing to change.']);
    expect(problems('postgres', { ...f, uniques: [{ columns: ['nope'] }] }, pgOrders).join(' ')).toMatch(/names nope, which is not a column/);
    expect(problems('postgres', edit(f, (cols) => (cols[0]!.from = 'missing')), pgOrders).join(' ')).toMatch(/missing is not a column of sales.orders/);
  });

  it('keeps renamed constraint columns matched through the rename', () => {
    const p = plan('postgres', edit(f, (cols) => (cols[4]!.name = 'client_id'), { foreignKeys: [{ name: 'fk_orders_customer', columns: ['client_id'], refTable: 'sales.customers', refColumns: ['id'] }] }), pgOrders);
    expect(p.statements).toEqual(['ALTER TABLE "sales"."orders" RENAME COLUMN "customer_id" TO "client_id"']);
    expect(p.destructive).toBe(false);
  });

  it('hashes the plan: same inputs, same hash; a different description, a different hash', () => {
    const def = edit(f, (cols) => (cols[1]!.type = { type: 'varchar', length: 400 }));
    expect(plan('postgres', def, pgOrders).hash).toBe(plan('postgres', def, pgOrders).hash);
    // A column added by someone else between preview and apply: the same definition now drops it.
    const changed = { ...pgOrders, columns: [...pgOrders.columns, col('added_since', { type: 'text' })] };
    const other = plan('postgres', def, changed);
    expect(other.statements[0]).toBe('ALTER TABLE "sales"."orders" DROP COLUMN "added_since"');
    expect(other.hash).not.toBe(plan('postgres', def, pgOrders).hash);
    // A description that changes nothing in the statements keeps the hash (what runs is what was reviewed).
    const same = { ...pgOrders, columns: pgOrders.columns.map((c) => (c.name === 'note' ? { ...c, type: { type: 'varchar', length: 300 } } : c)) };
    expect(plan('postgres', def, same).hash).toBe(plan('postgres', def, pgOrders).hash);
  });
});

// The same table in the other dialects' naming.
const simple = (name: string, t: Record<string, DescribedColumn['type']>, extra: Partial<TableDescription> = {}) =>
  table(name, [col('id', t.id!, { nullable: false }), col('note', t.note!, { default: { kind: 'literal', value: 'x' } }), col('qty', t.qty!, { nullable: false })], { primaryKey: { name: 'pk_orders', columns: ['id'] }, ...extra });

describe('alter-table: MySQL', () => {
  const my = simple('shop.orders', { id: { type: 'INT' }, note: { type: 'VARCHAR', length: 200 }, qty: { type: 'INT' } }, { primaryKey: { name: 'PRIMARY', columns: ['id'] }, uniques: [{ name: 'uq_note', columns: ['note'] }], foreignKeys: [{ name: 'fk_x', columns: ['qty'], refTable: 'shop.x', refColumns: ['id'], onDelete: null, onUpdate: null }], checks: [{ name: 'ck_qty', expression: '(`qty` > 0)' }] });
  const f = formOf(my);

  it('restates the whole column in one MODIFY COLUMN', () => {
    const p = plan('mysql', edit(f, (cols) => Object.assign(cols[1]!, { type: { type: 'VARCHAR', length: 300 }, comment: 'n' })), my);
    expect(p.statements).toEqual(["ALTER TABLE `shop`.`orders` MODIFY COLUMN `note` VARCHAR(300) NULL DEFAULT 'x' COMMENT 'n'"]);
    expect(p).toMatchObject({ transactional: false, destructive: false });
    const id = plan('mysql', edit(f, (cols) => Object.assign(cols[0]!, { identity: true })), my);
    expect(id.statements).toEqual(['ALTER TABLE `shop`.`orders` MODIFY COLUMN `id` INT AUTO_INCREMENT NOT NULL']);
  });

  it('renames, drops and adds columns, constraints with their MySQL forms, and renames the table', () => {
    const p = plan(
      'mysql',
      edit(f, (cols) => {
        cols[1]!.name = 'remark';
        cols.splice(2, 1);
        cols.push({ name: 'qty2', type: { type: 'INT', unsigned: true }, nullable: false, default: { kind: 'literal', value: 1 } });
      }, { uniques: [], foreignKeys: [], checks: [], primaryKey: ['qty2'], comment: 'it\'s', rename: 'orders_old' }),
      my
    );
    expect(p.statements).toEqual([
      'ALTER TABLE `shop`.`orders` DROP FOREIGN KEY `fk_x`',
      'ALTER TABLE `shop`.`orders` DROP CHECK `ck_qty`',
      'ALTER TABLE `shop`.`orders` DROP INDEX `uq_note`',
      'ALTER TABLE `shop`.`orders` DROP PRIMARY KEY',
      'ALTER TABLE `shop`.`orders` DROP COLUMN `qty`',
      'ALTER TABLE `shop`.`orders` RENAME COLUMN `note` TO `remark`',
      'ALTER TABLE `shop`.`orders` ADD COLUMN `qty2` INT UNSIGNED NOT NULL DEFAULT 1',
      'ALTER TABLE `shop`.`orders` ADD CONSTRAINT `PRIMARY` PRIMARY KEY (`qty2`)',
      "ALTER TABLE `shop`.`orders` COMMENT = 'it''s'",
      'RENAME TABLE `shop`.`orders` TO `shop`.`orders_old`'
    ]);
    expect(p.notes).toContain('This database commits each DDL statement on its own: if a later statement fails, the earlier ones stay.');
    expect(p.destructive).toBe(true);
  });
});

describe('alter-table: SQL Server', () => {
  const ms = simple('dbo.orders', { id: { type: 'INT' }, note: { type: 'NVARCHAR', length: 200 }, qty: { type: 'INT' } });
  ms.columns[1]!.defaultConstraint = 'DF__orders__note__1234';
  ms.indexes = [{ name: 'ix_note', columns: [{ name: 'note' }], unique: false, method: 'nonclustered', where: null, include: [], constraint: false }];
  const f = formOf(ms);

  it('changes defaults through named constraints and restates nullability', () => {
    const p = plan('mssql', edit(f, (cols) => Object.assign(cols[1]!, { default: { kind: 'literal', value: 'y' }, nullable: false })), ms);
    expect(p.statements).toEqual([
      'ALTER TABLE [dbo].[orders] ALTER COLUMN [note] NVARCHAR(200) NOT NULL',
      'ALTER TABLE [dbo].[orders] DROP CONSTRAINT [DF__orders__note__1234]',
      "ALTER TABLE [dbo].[orders] ADD CONSTRAINT [df_orders_note] DEFAULT N'y' FOR [note]"
    ]);
    expect(p.transactional).toBe(true);
  });

  it('drops a column after its default constraint and indexes, renames with sp_rename, adds without COLUMN', () => {
    const p = plan(
      'mssql',
      edit(f, (cols) => {
        cols.splice(1, 1);
        cols[1]!.name = 'quantity';
        cols.push({ name: 'flag', type: { type: 'BIT' }, nullable: false, default: { kind: 'literal', value: false } });
      }, { rename: 'orders2' }),
      ms
    );
    expect(p.statements).toEqual([
      'ALTER TABLE [dbo].[orders] DROP CONSTRAINT [DF__orders__note__1234]',
      'DROP INDEX [ix_note] ON [dbo].[orders]',
      'ALTER TABLE [dbo].[orders] DROP COLUMN [note]',
      "EXEC sp_rename N'dbo.orders.qty', N'quantity', N'COLUMN'",
      'ALTER TABLE [dbo].[orders] ADD [flag] BIT NOT NULL CONSTRAINT [df_orders_flag] DEFAULT 0',
      "EXEC sp_rename N'dbo.orders', N'orders2'"
    ]);
  });

  it('refuses identity changes and leaves comments out', () => {
    expect(problems('mssql', edit(f, (cols) => Object.assign(cols[2]!, { identity: true })), ms).join(' ')).toMatch(/SQL Server cannot make an existing column an identity column/);
    const c = plan('mssql', edit(f, (cols) => Object.assign(cols[2]!, { comment: 'q', nullable: true })), ms);
    expect(c.notes.join(' ')).toMatch(/comment is left out/);
    expect(c.statements).toEqual(['ALTER TABLE [dbo].[orders] ALTER COLUMN [qty] INT NULL']);
  });
});

describe('alter-table: Oracle', () => {
  const ora = table('HR.ORDERS', [col('ID', { type: 'NUMBER', precision: 10, scale: 0 }, { nullable: false, identity: true }), col('NOTE', { type: 'VARCHAR2', length: 200 }, { default: { kind: 'literal', value: 'x' } })], { primaryKey: { name: 'PK_ORDERS', columns: ['ID'] } });
  const f = formOf(ora);

  it('uses MODIFY, DROP (…), ADD (…) and folds names to upper case', () => {
    const p = plan(
      'oracle',
      edit(f, (cols) => {
        Object.assign(cols[0]!, { identity: false });
        Object.assign(cols[1]!, { type: { type: 'VARCHAR2', length: 100 }, nullable: false, default: null, comment: 'n' });
        cols.push({ name: 'created', type: { type: 'TIMESTAMP' }, default: { kind: 'expression', sql: 'SYSTIMESTAMP' }, nullable: false });
      }, { primaryKey: [], rename: 'orders_v2' }),
      ora,
      'FREEPDB1',
      { schema: 'hr' }
    );
    expect(p.statements).toEqual([
      'ALTER TABLE "HR"."ORDERS" DROP PRIMARY KEY',
      'ALTER TABLE "HR"."ORDERS" MODIFY ("ID" DROP IDENTITY)',
      'ALTER TABLE "HR"."ORDERS" MODIFY ("NOTE" VARCHAR2(100))',
      'ALTER TABLE "HR"."ORDERS" MODIFY ("NOTE" NOT NULL)',
      'ALTER TABLE "HR"."ORDERS" MODIFY ("NOTE" DEFAULT NULL)',
      `COMMENT ON COLUMN "HR"."ORDERS"."NOTE" IS 'n'`,
      'ALTER TABLE "HR"."ORDERS" ADD ("CREATED" TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL)',
      'ALTER TABLE "HR"."ORDERS" RENAME TO "ORDERS_V2"'
    ]);
    expect(p).toMatchObject({ destructive: true, transactional: false });
    const drop = plan('oracle', edit(f, (cols) => cols.splice(1, 1)), ora, 'FREEPDB1', { schema: 'hr' });
    expect(drop.statements).toEqual(['ALTER TABLE "HR"."ORDERS" DROP ("NOTE")']);
    expect(problems('oracle', edit(formOf({ ...ora, columns: [{ ...ora.columns[0]!, identity: false }, ora.columns[1]!] }), (cols) => Object.assign(cols[0]!, { identity: true })), { ...ora, columns: [{ ...ora.columns[0]!, identity: false }, ora.columns[1]!] }).join(' ')).toMatch(/Oracle cannot make an existing column an identity column/);
  });
});

describe('alter-table: Snowflake', () => {
  const sf = table('PUBLIC.ORDERS', [col('ID', { type: 'NUMBER', precision: 10, scale: 0 }, { nullable: false }), col('NOTE', { type: 'VARCHAR', length: 100 }, { default: { kind: 'literal', value: 'x' }, comment: 'c' })]);
  const f = formOf(sf);

  it('widens in place and refuses narrowing or new defaults', () => {
    const p = plan('snowflake', edit(f, (cols) => Object.assign(cols[1]!, { type: { type: 'VARCHAR', length: 200 }, nullable: false, default: null, comment: undefined }), { rename: 'orders2', comment: 'T' }), sf);
    expect(p.statements).toEqual([
      'ALTER TABLE "PUBLIC"."ORDERS" ALTER COLUMN "NOTE" SET DATA TYPE VARCHAR(200)',
      'ALTER TABLE "PUBLIC"."ORDERS" ALTER COLUMN "NOTE" SET NOT NULL',
      'ALTER TABLE "PUBLIC"."ORDERS" ALTER COLUMN "NOTE" DROP DEFAULT',
      'ALTER TABLE "PUBLIC"."ORDERS" ALTER COLUMN "NOTE" UNSET COMMENT',
      `ALTER TABLE "PUBLIC"."ORDERS" SET COMMENT = 'T'`,
      'ALTER TABLE "PUBLIC"."ORDERS" RENAME TO "PUBLIC"."ORDERS2"'
    ]);
    expect(p.destructive).toBe(false);
    expect(plan('snowflake', edit(f, (cols) => Object.assign(cols[0]!, { type: { type: 'NUMBER', precision: 20, scale: 0 } })), sf).statements).toEqual(['ALTER TABLE "PUBLIC"."ORDERS" ALTER COLUMN "ID" SET DATA TYPE NUMBER(20, 0)']);
    expect(problems('snowflake', edit(f, (cols) => Object.assign(cols[1]!, { type: { type: 'VARCHAR', length: 50 } })), sf).join(' ')).toMatch(/only to a longer VARCHAR/);
    expect(problems('snowflake', edit(f, (cols) => Object.assign(cols[0]!, { type: { type: 'NUMBER', precision: 20, scale: 2 } })), sf).join(' ')).toMatch(/same scale/);
    expect(problems('snowflake', edit(f, (cols) => Object.assign(cols[1]!, { default: { kind: 'literal', value: 'y' } })), sf).join(' ')).toMatch(/cannot give an existing column a new default/);
    expect(problems('snowflake', { ...f, checks: [{ expression: 'ID > 0' }] }, sf).join(' ')).toMatch(/Snowflake has no CHECK/);
  });
});

describe('alter-table: BigQuery', () => {
  const bq = table('ds.orders', [col('id', { type: 'INT64' }, { nullable: false }), col('note', { type: 'STRING', length: 100 }), col('amount', { type: 'NUMERIC' })]);
  const f = formOf(bq);

  it('widens, relaxes NOT NULL, sets options and refuses the rest', () => {
    const p = plan(
      'bigquery',
      edit(f, (cols) => {
        Object.assign(cols[0]!, { type: { type: 'NUMERIC' }, nullable: true });
        Object.assign(cols[1]!, { type: { type: 'STRING' }, comment: 'n', default: { kind: 'literal', value: 'x' } });
        cols.push({ name: 'at', type: { type: 'TIMESTAMP' }, default: { kind: 'expression', sql: 'CURRENT_TIMESTAMP()' } });
      }, { primaryKey: ['id'], comment: 'Orders', rename: 'orders2' }),
      bq
    );
    expect(p.statements).toEqual([
      'ALTER TABLE `ds`.`orders` ALTER COLUMN `id` SET DATA TYPE NUMERIC',
      'ALTER TABLE `ds`.`orders` ALTER COLUMN `id` DROP NOT NULL',
      'ALTER TABLE `ds`.`orders` ALTER COLUMN `note` SET DATA TYPE STRING',
      "ALTER TABLE `ds`.`orders` ALTER COLUMN `note` SET DEFAULT 'x'",
      "ALTER TABLE `ds`.`orders` ALTER COLUMN `note` SET OPTIONS(description='n')",
      'ALTER TABLE `ds`.`orders` ADD COLUMN `at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP()',
      'ALTER TABLE `ds`.`orders` ADD PRIMARY KEY (`id`) NOT ENFORCED',
      "ALTER TABLE `ds`.`orders` SET OPTIONS(description='Orders')",
      'ALTER TABLE `ds`.`orders` RENAME TO `orders2`'
    ]);
    expect(p.destructive).toBe(false);
    expect(problems('bigquery', edit(f, (cols) => Object.assign(cols[1]!, { type: { type: 'STRING', length: 50 } })), bq).join(' ')).toMatch(/only by widening/);
    expect(problems('bigquery', edit(f, (cols) => Object.assign(cols[2]!, { type: { type: 'INT64' } })), bq).join(' ')).toMatch(/only by widening/);
    expect(problems('bigquery', edit(f, (cols) => Object.assign(cols[1]!, { nullable: false })), bq).join(' ')).toMatch(/cannot make an existing column NOT NULL/);
    expect(problems('bigquery', edit(f, (cols) => cols.push({ name: 'z', type: { type: 'INT64' }, nullable: false })), bq).join(' ')).toMatch(/cannot add a NOT NULL/);
    const drop = plan('bigquery', { ...edit(f, (cols) => cols.splice(2, 1)), foreignKeys: [{ columns: ['id'], refTable: 'ds.c', refColumns: ['id'] }] }, bq);
    expect(drop.statements).toEqual(['ALTER TABLE `ds`.`orders` DROP COLUMN `amount`', 'ALTER TABLE `ds`.`orders` ADD CONSTRAINT `fk_orders_id` FOREIGN KEY (`id`) REFERENCES `ds`.`c` (`id`) NOT ENFORCED']);
    expect(drop.destructive).toBe(true);
  });
});

describe('alter-table: SQLite (D1)', () => {
  const lite = table('orders', [col('id', { type: 'INTEGER' }, { nullable: false }), col('note', { type: 'TEXT' }), col('code', { type: 'TEXT' })], {
    primaryKey: { name: null, columns: ['id'] },
    indexes: [{ name: 'ix_code', columns: [{ name: 'code' }], unique: false, method: 'btree', where: null, include: [], constraint: false }]
  });
  const f = formOf(lite);

  it('adds, drops and renames columns and the table', () => {
    const p = plan(
      'cloudflare-d1',
      edit(f, (cols) => {
        cols.splice(1, 1);
        cols[1]!.name = 'sku';
        cols.push({ name: 'qty', type: { type: 'INTEGER' }, nullable: false, default: { kind: 'literal', value: 0 } });
      }, { rename: 'orders2' }),
      lite
    );
    expect(p.statements).toEqual(['ALTER TABLE "orders" DROP COLUMN "note"', 'ALTER TABLE "orders" RENAME COLUMN "code" TO "sku"', 'ALTER TABLE "orders" ADD COLUMN "qty" INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE "orders" RENAME TO "orders2"']);
    expect(p.transactional).toBe(true);
  });

  it('refuses what needs the table rebuilt', () => {
    expect(problems('cloudflare-d1', edit(f, (cols) => Object.assign(cols[1]!, { type: { type: 'BLOB' } })), lite).join(' ')).toMatch(/SQLite cannot change the type of note without rebuilding the table/);
    expect(problems('cloudflare-d1', edit(f, (cols) => Object.assign(cols[1]!, { nullable: false })), lite).join(' ')).toMatch(/rebuilding/);
    expect(problems('cloudflare-d1', edit(f, (cols) => cols.splice(2, 1)), lite).join(' ')).toMatch(/drop code, which is part of an index/);
    expect(problems('cloudflare-d1', { ...f, uniques: [{ columns: ['note'] }] }, lite).join(' ')).toMatch(/constraints without rebuilding/);
    expect(problems('cloudflare-d1', edit(f, (cols) => cols.push({ name: 'z', type: { type: 'TEXT' }, nullable: false })), lite).join(' ')).toMatch(/only with a default other than NULL/);
    expect(problems('cloudflare-d1', edit(f, (cols) => cols.push({ name: 'z', type: { type: 'TEXT' }, default: { kind: 'expression', sql: 'CURRENT_TIMESTAMP' } })), lite).join(' ')).toMatch(/default is an expression/);
  });
});

describe('type widening', () => {
  it('tells widening from changes that can lose data', () => {
    expect(widens('postgres', { type: 'integer' }, { type: 'bigint' })).toBe(true);
    expect(widens('postgres', { type: 'bigint' }, { type: 'integer' })).toBe(false);
    expect(widens('postgres', { type: 'varchar', length: 10 }, { type: 'text' })).toBe(true);
    expect(widens('postgres', { type: 'varchar', length: 10 }, { type: 'varchar' })).toBe(true);
    expect(widens('postgres', { type: 'integer' }, { type: 'numeric', precision: 12, scale: 2 })).toBe(true);
    expect(widens('postgres', { type: 'integer' }, { type: 'numeric', precision: 8, scale: 2 })).toBe(false);
    expect(widens('postgres', { type: 'numeric', precision: 12, scale: 2 }, { type: 'numeric', precision: 12, scale: 4 })).toBe(false);
    expect(widens('mysql', { type: 'INT', unsigned: true }, { type: 'INT' })).toBe(false);
    expect(widens('mysql', { type: 'ENUM', values: ['a'] }, { type: 'ENUM', values: ['a', 'b'] })).toBe(true);
    expect(widens('mysql', { type: 'ENUM', values: ['a', 'b'] }, { type: 'ENUM', values: ['b'] })).toBe(false);
    expect(widens('tsql', { type: 'VARCHAR', length: 100 }, { type: 'NVARCHAR', length: 'max' })).toBe(true);
    expect(widens('tsql', { type: 'NVARCHAR', length: 'max' }, { type: 'NVARCHAR', length: 4000 })).toBe(false);
    expect(widens('postgres', { type: 'text' }, { type: 'integer' })).toBe(false);
    expect(widens('postgres', null, { type: 'integer' })).toBe(false);
  });
});

describe('replace-index', () => {
  const ix = (name: string, constraint = false) => ({ name, columns: [{ name: 'a' }], unique: false, method: 'btree', where: null, include: [], constraint });
  const t = (name: string) => table(name, [col('a', { type: 'integer' }), col('b', { type: 'integer' })], { indexes: [ix('ix_a'), ix('pk_t', true)] });

  it('drops the old index and creates the new one, per dialect', () => {
    const pg = plan('postgres', { kind: 'replace-index', from: 'ix_a', name: 'ix_a', table: 'sales.t', columns: [{ name: 'a' }, { name: 'b', order: 'desc' }] }, t('sales.t'));
    expect(pg).toMatchObject({ kind: 'replace-index', object: 'sales.t:ix_a', statements: ['DROP INDEX "sales"."ix_a"', 'CREATE INDEX "ix_a" ON "sales"."t" ("a", "b" DESC)'], destructive: false, transactional: true, touches: ['sales.t'] });
    expect(pg.notes[0]).toMatch(/dropped and built again/);
    const conc = plan('postgres', { kind: 'replace-index', from: 'ix_a', name: 'ix_a2', table: 't', columns: [{ name: 'a' }], concurrently: true }, t('t'));
    expect(conc.statements).toEqual(['DROP INDEX CONCURRENTLY "ix_a"', 'CREATE INDEX CONCURRENTLY "ix_a2" ON "t" ("a")']);
    expect(conc.transactional).toBe(false);
    expect(plan('mysql', { kind: 'replace-index', from: 'ix_a', name: 'ix_a', table: 'shop.t', columns: [{ name: 'b' }] }, t('shop.t')).statements).toEqual(['DROP INDEX `ix_a` ON `shop`.`t`', 'CREATE INDEX `ix_a` ON `shop`.`t` (`b`)']);
    expect(plan('mssql', { kind: 'replace-index', from: 'ix_a', name: 'ix_a', table: 'dbo.t', columns: [{ name: 'b' }] }, t('dbo.t')).statements).toEqual(['DROP INDEX [ix_a] ON [dbo].[t]', 'CREATE NONCLUSTERED INDEX [ix_a] ON [dbo].[t] ([b])']);
    expect(plan('oracle', { kind: 'replace-index', from: 'IX_A', name: 'ix_a', table: 't', columns: [{ name: 'b' }] }, t('T'), 'FREEPDB1', { schema: 'hr' }).statements).toEqual(['DROP INDEX "HR"."ix_a"', 'CREATE INDEX "HR"."IX_A" ON "T" ("B")']);
    expect(plan('bigquery', { kind: 'replace-index', from: 'ix_a', name: 'ix_a', table: 'ds.t', allColumns: true }, t('ds.t')).statements).toEqual(['DROP SEARCH INDEX `ix_a` ON `ds`.`t`', 'CREATE SEARCH INDEX `ix_a` ON `ds`.`t` (ALL COLUMNS)']);
    expect(plan('cloudflare-d1', { kind: 'replace-index', from: 'ix_a', name: 'ix_a', table: 't', columns: [{ name: 'b' }] }, t('t')).statements).toEqual(['DROP INDEX "ix_a"', 'CREATE INDEX "ix_a" ON "t" ("b")']);
  });

  it('refuses a missing index, a constraint index, and Snowflake', () => {
    expect(problems('postgres', { kind: 'replace-index', from: 'nope', name: 'x', table: 't', columns: [{ name: 'a' }] }, t('t')).join(' ')).toMatch(/nope is not an index of t/);
    expect(problems('postgres', { kind: 'replace-index', from: 'pk_t', name: 'x', table: 't', columns: [{ name: 'a' }] }, t('t')).join(' ')).toMatch(/edit the constraint instead/);
    expect(problems('snowflake', { kind: 'replace-index', from: 'ix_a', name: 'x', table: 't', columns: [{ name: 'a' }] }, t('t')).join(' ')).toMatch(/offers alter-table, procedure, function, not replace-index/);
  });
});

describe('drops: SQL', () => {
  const drop = (engine: Engine, def: Record<string, unknown>, db: string | null = 'db', options: Record<string, unknown> = {}) => plan(engine, { kind: 'drop', ...def }, null, db, options);
  const refused = (engine: Engine, def: Record<string, unknown>) => problems(engine, { kind: 'drop', ...def }).join(' ');

  it('drops tables and views, marked destructive with the name to confirm', () => {
    const p = drop('postgres', { objectKind: 'table', name: 'sales.orders', ifExists: true, cascade: true });
    expect(p).toMatchObject({ kind: 'drop', object: 'sales.orders', statements: ['DROP TABLE IF EXISTS "sales"."orders" CASCADE'], destructive: true, confirmName: 'sales.orders', touches: ['sales.orders'], transactional: true });
    expect(drop('oracle', { objectKind: 'table', name: 'orders', cascade: true }).statements).toEqual(['DROP TABLE "ORDERS" CASCADE CONSTRAINTS']);
    expect(drop('mssql', { objectKind: 'table', name: 'dbo.orders', ifExists: true }).statements).toEqual(['DROP TABLE IF EXISTS [dbo].[orders]']);
    expect(drop('snowflake', { objectKind: 'view', name: 'v', cascade: true }).statements).toEqual(['DROP VIEW "V" CASCADE']);
    expect(drop('bigquery', { objectKind: 'table', name: 'ds.t' }).statements).toEqual(['DROP TABLE `ds`.`t`']);
    expect(drop('cloudflare-d1', { objectKind: 'view', name: 'v' }).statements).toEqual(['DROP VIEW "v"']);
    expect(refused('mssql', { objectKind: 'table', name: 't', cascade: true })).toMatch(/SQL Server has no CASCADE/);
    expect(refused('oracle', { objectKind: 'table', name: 't', ifExists: true })).toMatch(/IF EXISTS/);
    expect(refused('cloudflare-d1', { objectKind: 'procedure', name: 'p' })).toMatch(/can drop table, view, index, not procedure/);
  });

  it('drops indexes with their table where the dialect names one', () => {
    expect(drop('postgres', { objectKind: 'index', name: 'ix', on: 'sales.orders' })).toMatchObject({ statements: ['DROP INDEX "sales"."ix"'], touches: ['sales.orders'], object: 'sales.orders:ix' });
    expect(drop('mysql', { objectKind: 'index', name: 'ix', on: 'orders' }).statements).toEqual(['DROP INDEX `ix` ON `orders`']);
    expect(drop('mssql', { objectKind: 'index', name: 'ix', on: 'dbo.orders', ifExists: true }).statements).toEqual(['DROP INDEX IF EXISTS [ix] ON [dbo].[orders]']);
    expect(drop('oracle', { objectKind: 'index', name: 'ix', on: 'orders' }, 'FREEPDB1', { schema: 'hr' }).statements).toEqual(['DROP INDEX "HR"."IX"']);
    expect(drop('bigquery', { objectKind: 'index', name: 'ix', on: 'ds.t' }).statements).toEqual(['DROP SEARCH INDEX `ix` ON `ds`.`t`']);
    expect(drop('cloudflare-d1', { objectKind: 'index', name: 'ix', on: 'orders', ifExists: true }).statements).toEqual(['DROP INDEX IF EXISTS "ix"']);
    expect(refused('mysql', { objectKind: 'index', name: 'ix' })).toMatch(/give the table \(on\)/);
    expect(refused('snowflake', { objectKind: 'index', name: 'ix', on: 't' })).toMatch(/not index/);
  });

  it('drops routines, with PostgreSQL and Snowflake signatures and BigQuery through its API', () => {
    expect(drop('postgres', { objectKind: 'function', name: 'add_one', signature: 'integer, text', ifExists: true }).statements).toEqual(['DROP FUNCTION IF EXISTS "add_one"(integer, text)']);
    expect(drop('mysql', { objectKind: 'procedure', name: 'p' }).statements).toEqual(['DROP PROCEDURE `p`']);
    expect(drop('snowflake', { objectKind: 'function', name: 'f', signature: 'NUMBER' }).statements).toEqual(['DROP FUNCTION "F"(NUMBER)']);
    const bq = drop('bigquery', { objectKind: 'function', name: 'ds.f' });
    expect(bq).toMatchObject({ statements: ['DROP FUNCTION `ds`.`f`'], ops: [{ op: 'bigquery.deleteRoutine', datasetId: 'ds', routineId: 'f' }], transactional: false });
    expect(refused('mysql', { objectKind: 'function', name: 'f', signature: 'INT' })).toMatch(/signature applies to PostgreSQL and Snowflake/);
    expect(refused('postgres', { objectKind: 'function', name: 'f', signature: 'integer) (x' })).toMatch(/signature/);
  });

  it('drops datasets and schemas', () => {
    expect(drop('postgres', { objectKind: 'dataset', name: 'reporting', cascade: true }).statements).toEqual(['DROP SCHEMA "reporting" CASCADE']);
    expect(drop('mysql', { objectKind: 'dataset', name: 'shop2', ifExists: true }).statements).toEqual(['DROP DATABASE IF EXISTS `shop2`']);
    expect(drop('mssql', { objectKind: 'dataset', name: 'stage' }).statements).toEqual(['DROP SCHEMA [stage]']);
    expect(drop('snowflake', { objectKind: 'dataset', name: 'stage', cascade: true }).statements).toEqual(['DROP SCHEMA "STAGE" CASCADE']);
    expect(drop('bigquery', { objectKind: 'dataset', name: 'analytics', cascade: true }).ops).toEqual([{ op: 'bigquery.deleteDataset', datasetId: 'analytics', deleteContents: true }]);
    expect(refused('oracle', { objectKind: 'dataset', name: 'x' })).toMatch(/not dataset/);
  });
});

describe('drops: the other engines', () => {
  const drop = (engine: Engine, def: Record<string, unknown>, db: string | null = 'db', options: Record<string, unknown> = {}) => plan(engine, { kind: 'drop', ...def }, null, db, options);

  it('writes each store\'s operation', () => {
    expect(drop('mongodb', { objectKind: 'collection', name: 'events' })).toMatchObject({ ops: [{ op: 'mongo.dropCollection', name: 'events' }], statements: ['db.events.drop()'], touches: ['events'], destructive: true, confirmName: 'events' });
    expect(drop('mongodb', { objectKind: 'index', name: 'by_at', on: 'events' })).toMatchObject({ ops: [{ op: 'mongo.dropIndex', collection: 'events', index: 'by_at' }], statements: ['db.events.dropIndex("by_at")'], touches: ['events'] });
    expect(drop('opensearch', { objectKind: 'search-index', name: 'docs' })).toMatchObject({ ops: [{ op: 'opensearch.deleteIndex', index: 'docs' }], statements: ['DELETE /docs'] });
    expect(drop('dynamodb', { objectKind: 'table', name: 'Orders' }).ops).toEqual([{ op: 'dynamodb.deleteTable', input: { TableName: 'Orders' } }]);
    expect(drop('dynamodb', { objectKind: 'index', name: 'byCustomer', on: 'Orders' })).toMatchObject({ ops: [{ op: 'dynamodb.updateTable', input: { TableName: 'Orders', GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: 'byCustomer' } }] } }], touches: ['Orders'] });
    expect(drop('cosmos-nosql', { objectKind: 'container', name: 'items' }, 'catalog')).toMatchObject({ ops: [{ op: 'cosmos.deleteContainer', id: 'items' }], statements: ['DELETE /dbs/catalog/colls/items'] });
    expect(drop('cosmos-nosql', { objectKind: 'dataset', name: 'catalog' }).ops).toEqual([{ op: 'cosmos.deleteDatabase', id: 'catalog' }]);
    expect(drop('influxdb', { objectKind: 'dataset', name: 'metrics' }, 'telemetry', { version: 'v1' })).toMatchObject({ ops: [{ op: 'influx.dropDatabase', name: 'metrics' }], statements: ['DROP DATABASE "metrics"'] });
    expect(drop('redis', { objectKind: 'stream-group', name: 'workers', on: 'orders:events' })).toMatchObject({ ops: [{ op: 'redis.xgroupDestroy', key: 'orders:events', group: 'workers' }], statements: ['XGROUP DESTROY orders:events workers'], touches: ['orders:events'] });
    expect(drop('rabbitmq', { objectKind: 'queue', name: 'jobs' }, '/')).toMatchObject({ ops: [{ op: 'rabbit.deleteQueue', vhost: '/', name: 'jobs', ifEmpty: true, ifUnused: true }], statements: ['DELETE /api/queues/%2F/jobs?if-empty=true&if-unused=true'], touches: ['//jobs'] });
    expect(drop('rabbitmq', { objectKind: 'queue', name: 'jobs', ifEmpty: false, on: 'app' }).statements).toEqual(['DELETE /api/queues/app/jobs']);
    expect(drop('rabbitmq', { objectKind: 'exchange', name: 'events', on: 'app' })).toMatchObject({ ops: [{ op: 'rabbit.deleteExchange', vhost: 'app', name: 'events', ifUnused: true }], statements: ['DELETE /api/exchanges/app/events?if-unused=true'] });
    expect(drop('rabbitmq', { objectKind: 'binding', name: 'events', on: 'app', destination: 'jobs', destinationType: 'queue' })).toMatchObject({
      ops: [{ op: 'rabbit.unbind', vhost: 'app', source: 'events', destination: 'jobs', destinationType: 'q', propertiesKey: '~' }],
      statements: ['DELETE /api/bindings/app/e/events/q/jobs/~'],
      touches: ['app/jobs']
    });
    expect(drop('rabbitmq', { objectKind: 'binding', name: 'events', on: 'app', destination: 'audit', destinationType: 'exchange', propertiesKey: 'order.*' }).ops[0]).toMatchObject({ destinationType: 'e', propertiesKey: 'order.*' });
  });

  it('refuses what the store cannot drop', () => {
    const refused = (engine: Engine, def: Record<string, unknown>, db: string | null = 'db', options: Record<string, unknown> = {}) => problems(engine, { kind: 'drop', ...def }, null, db, options).join(' ');
    expect(refused('opensearch', { objectKind: 'search-index', name: 'logs-*' })).toMatch(/no wildcards/);
    expect(refused('mongodb', { objectKind: 'index', name: '_id_', on: 'events' })).toMatch(/_id index/);
    expect(refused('redis', { objectKind: 'stream-group', name: 'workers' })).toMatch(/stream key/);
    expect(refused('rabbitmq', { objectKind: 'exchange', name: 'amq.direct' })).toMatch(/reserved/);
    expect(refused('rabbitmq', { objectKind: 'binding', name: 'events' })).toMatch(/destination/);
    expect(refused('influxdb', { objectKind: 'dataset', name: 'm' }, 'db', { version: 'v2' })).toMatch(/buckets/);
    expect(refused('mongodb', { objectKind: 'table', name: 'x' })).toMatch(/can drop collection, index, not table/);
  });
});

describe('edits of the other engines', () => {
  const doc = (kind: DocumentDescription['kind'], name: string, definition: Record<string, unknown>, indexes?: Record<string, unknown>[]): DocumentDescription => ({ kind, name, definition, ...(indexes ? { indexes } : {}) });
  const ed = (engine: Engine, objectKind: string, name: string, definition: Record<string, unknown>, current: ObjectDescription | null, db: string | null = 'db') => plan(engine, { kind: 'edit', objectKind, name, definition }, current, db);
  const edProblems = (engine: Engine, objectKind: string, name: string, definition: Record<string, unknown>, current: ObjectDescription | null) => problems(engine, { kind: 'edit', objectKind, name, definition }, current).join(' ');

  it('MongoDB: a new validator through collMod; capped and time series cannot change', () => {
    const cur = doc('collection', 'events', { name: 'events', fields: [{ name: 'at', bsonType: 'date', required: true }, { name: 'odd', bsonType: 'javascript', required: false }], additionalProperties: true, validationLevel: 'strict', validationAction: 'error' });
    const def = { fields: [{ name: 'at', bsonType: 'date', required: true }, { name: 'odd', bsonType: 'javascript', required: false }, { name: 'kind', bsonType: 'string' }], validationAction: 'warn' };
    const p = ed('mongodb', 'collection', 'events', def, cur);
    expect(p.ops).toEqual([
      { op: 'mongo.collMod', name: 'events', options: { validator: { $jsonSchema: { bsonType: 'object', required: ['at'], properties: { at: { bsonType: 'date' }, odd: { bsonType: 'javascript' }, kind: { bsonType: 'string' } } } }, validationLevel: 'strict', validationAction: 'warn' } }
    ]);
    expect(p).toMatchObject({ kind: 'edit', touches: ['events'], destructive: false });
    expect(edProblems('mongodb', 'collection', 'events', { ...def, fields: [{ name: 'odd', bsonType: 'nonsense' }] }, cur)).toMatch(/definition.fields.0.bsonType/);
    expect(edProblems('mongodb', 'collection', 'events', { fields: cur.definition.fields, capped: { size: 4096 } }, cur)).toMatch(/capped/);
    expect(edProblems('mongodb', 'collection', 'events', { fields: cur.definition.fields }, cur)).toBe('Nothing to change.');
    expect(edProblems('mongodb', 'collection', 'events', {}, null)).toMatch(/does not exist/);
  });

  it('OpenSearch: new fields mapped, replicas set; changed fields and shards refused', () => {
    const cur = doc('search-index', 'docs', { name: 'docs', shards: 1, replicas: 1, dynamic: 'true', fields: [{ name: 'title', type: 'text', analyzer: 'english' }] });
    const p = ed('opensearch', 'search-index', 'docs', { shards: 1, replicas: 2, fields: [{ name: 'title', type: 'text', analyzer: 'english' }, { name: 'at', type: 'date', format: 'strict_date_optional_time' }] }, cur);
    expect(p.ops).toEqual([
      { op: 'opensearch.putMapping', index: 'docs', body: { properties: { at: { type: 'date', format: 'strict_date_optional_time' } } } },
      { op: 'opensearch.putSettings', index: 'docs', body: { index: { number_of_replicas: 2 } } }
    ]);
    expect(p.statements[0]).toMatch(/^PUT \/docs\/_mapping/);
    expect(edProblems('opensearch', 'search-index', 'docs', { shards: 1, fields: [{ name: 'title', type: 'keyword' }] }, cur)).toMatch(/cannot change a mapped field/);
    expect(edProblems('opensearch', 'search-index', 'docs', { shards: 1, fields: [] }, cur)).toMatch(/cannot remove a mapped field/);
    expect(edProblems('opensearch', 'search-index', 'docs', { shards: 3, fields: cur.definition.fields }, cur)).toMatch(/primary shards/);
  });

  it('DynamoDB: billing, one call per index added or removed, time to live; keys cannot change', () => {
    const gsi = { name: 'byCustomer', partitionKey: { name: 'customerId', type: 'S' }, projection: 'ALL', nonKeyAttributes: [] };
    const cur = doc('table', 'Orders', { name: 'Orders', partitionKey: { name: 'id', type: 'S' }, billingMode: 'PAY_PER_REQUEST', indexes: [gsi] }, [gsi]);
    const p = ed(
      'dynamodb',
      'table',
      'Orders',
      { partitionKey: { name: 'id', type: 'S' }, billingMode: 'PROVISIONED', readCapacity: 5, writeCapacity: 5, indexes: [{ name: 'byStatus', partitionKey: { name: 'status', type: 'S' }, readCapacity: 1, writeCapacity: 1 }], ttlAttribute: 'expires' },
      cur
    );
    expect(p.ops).toEqual([
      { op: 'dynamodb.updateTable', input: { TableName: 'Orders', BillingMode: 'PROVISIONED', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } } },
      { op: 'dynamodb.updateTable', input: { TableName: 'Orders', GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: 'byCustomer' } }] } },
      {
        op: 'dynamodb.updateTable',
        input: {
          TableName: 'Orders',
          AttributeDefinitions: [{ AttributeName: 'status', AttributeType: 'S' }],
          GlobalSecondaryIndexUpdates: [{ Create: { IndexName: 'byStatus', KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' }, ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } } }]
        }
      },
      { op: 'dynamodb.updateTimeToLive', input: { TableName: 'Orders', TimeToLiveSpecification: { Enabled: true, AttributeName: 'expires' } } }
    ]);
    expect(p).toMatchObject({ destructive: true, confirmName: 'Orders' });
    expect(p.statements.map((s) => s.split(' ')[0])).toEqual(['UpdateTable', 'UpdateTable', 'UpdateTable', 'UpdateTimeToLive']);
    expect(edProblems('dynamodb', 'table', 'Orders', { partitionKey: { name: 'pk', type: 'S' }, indexes: [gsi] }, cur)).toMatch(/key cannot be changed/);
  });

  it('Cosmos DB: replace the container with its full body; partition and unique keys cannot change', () => {
    const cur = doc('container', 'items', { name: 'items', partitionKeyPaths: ['/tenantId'], uniqueKeys: [], excludedPaths: [] });
    const p = ed('cosmos-nosql', 'container', 'items', { partitionKeyPaths: ['/tenantId'], defaultTtl: 3600, excludedPaths: ['/blob/*'] }, cur, 'catalog');
    expect(p.ops).toEqual([
      {
        op: 'cosmos.replaceContainer',
        body: { id: 'items', partitionKey: { paths: ['/tenantId'], kind: 'Hash', version: 2 }, defaultTtl: 3600, indexingPolicy: { indexingMode: 'consistent', automatic: true, includedPaths: [{ path: '/*' }], excludedPaths: [{ path: '/blob/*' }] } }
      }
    ]);
    expect(p.statements[0]).toMatch(/^PUT \/dbs\/catalog\/colls\/items/);
    expect(edProblems('cosmos-nosql', 'container', 'items', { partitionKeyPaths: ['/other'] }, cur)).toMatch(/partition key cannot be changed/);
    expect(edProblems('cosmos-nosql', 'container', 'items', { partitionKeyPaths: ['/tenantId'], uniqueKeys: [['/sku']] }, cur)).toMatch(/unique keys cannot be changed/);
  });

  it('Redis: move a consumer group with SETID', () => {
    const cur = doc('stream-group', 'orders:events', { key: 'orders:events', groups: [{ name: 'workers', lastDeliveredId: '0-0', consumers: 2, pending: 0 }] });
    const p = ed('redis', 'stream-group', 'workers', { key: 'orders:events', group: 'workers', startId: '$' }, cur);
    expect(p).toMatchObject({ ops: [{ op: 'redis.xgroupSetId', key: 'orders:events', group: 'workers', id: '$' }], statements: ['XGROUP SETID orders:events workers $'], touches: ['orders:events'], object: 'orders:events' });
    expect(edProblems('redis', 'stream-group', 'other', { key: 'orders:events', group: 'other', startId: '0' }, cur)).toMatch(/other is not a consumer group/);
  });

  it('RabbitMQ: queues and exchanges cannot be altered', () => {
    expect(problems('rabbitmq', { kind: 'edit', objectKind: 'queue', name: 'jobs', definition: {} }).join(' ')).toMatch(/RabbitMQ cannot change a queue once it is declared/);
    expect(problems('influxdb', { kind: 'edit', objectKind: 'collection', name: 'x', definition: {} }).join(' ')).toMatch(/created and dropped, not edited/);
    expect(problems('mongodb', { kind: 'alter-table', name: 'x', columns: [{ name: 'a' }] }).join(' ')).toMatch(/no tables to alter/);
  });
});

describe('round trips of what the console sends back', () => {
  const d1Current = { kind: 'table' as const, name: 'main.items', columns: [
    { name: 'id', type: { type: 'INTEGER' }, rawType: 'INTEGER', nullable: false, default: null, identity: true, comment: null },
    { name: 'qty', type: { type: 'INTEGER' }, rawType: 'INTEGER', nullable: true, default: { kind: 'literal' as const, value: '0' }, identity: false, comment: null },
    { name: 'pid', type: { type: 'INTEGER' }, rawType: 'INTEGER', nullable: true, default: null, identity: false, comment: null }],
    primaryKey: { name: null, columns: ['id'] }, uniques: [{ name: '', columns: ['qty', 'pid'] }], foreignKeys: [{ name: '', columns: ['pid'], refTable: 'main.parents', refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }], checks: [{ name: '', expression: 'qty >= 0' }], indexes: [], comment: null, options: {} };
  const ctxOf = (engine: 'cloudflare-d1' | 'mysql') => ({ engine, database: 'db', account: 'a', options: {} });
  const unchanged = (cur: typeof d1Current) => ({ kind: 'alter-table', name: cur.name, columns: cur.columns.map((c) => ({ from: c.name, name: c.name, type: c.type, nullable: c.nullable, default: c.default, identity: c.identity })), primaryKey: ['id'], uniques: cur.uniques, foreignKeys: cur.foreignKeys, checks: cur.checks });

  it('matches SQLite constraints that have no name by what they say', () => {
    expect(() => buildPlan('cloudflare-d1', ctxOf('cloudflare-d1'), unchanged(d1Current), d1Current)).toThrow(/Nothing to change/);
    const added = unchanged(d1Current);
    added.columns.push({ name: 'note', type: { type: 'TEXT' } } as never);
    expect(buildPlan('cloudflare-d1', ctxOf('cloudflare-d1'), added, d1Current).statements).toEqual(['ALTER TABLE "main"."items" ADD COLUMN "note" TEXT']);
  });

  it('keeps an uncatalogued type as the database reports it when the form sends no type', () => {
    const cur = { ...d1Current, name: 'shop.items', primaryKey: { name: 'PRIMARY', columns: ['id'] }, uniques: [], foreignKeys: [], checks: [], columns: [{ name: 'id', type: { type: 'INT' }, rawType: 'int', nullable: false, default: null, identity: true, comment: null }, { name: 'shape', type: null, rawType: 'polygon', nullable: true, default: null, identity: false, comment: null }] };
    const form = { kind: 'alter-table', name: 'shop.items', columns: [{ from: 'id', name: 'id', type: { type: 'INT' }, nullable: false, identity: true }, { from: 'shape', name: 'shape', nullable: false }], primaryKey: ['id'] };
    const p = buildPlan('mysql', ctxOf('mysql'), form, cur as never);
    expect(p.statements).toEqual(['ALTER TABLE `shop`.`items` MODIFY COLUMN `shape` polygon NOT NULL']);
    expect(p.destructive).toBe(false);
  });
});
