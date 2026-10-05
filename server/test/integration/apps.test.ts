/*
 * Sprint 27b (1.4.0), low-code apps, against real databases. SQLite always runs (in memory) as the reference; each
 * other block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 029_apps; a duplicate unique value refused (B-2201), concurrently too;
 *                                  the same filters, sorts, searches and aggregations return the same rows in the same
 *                                  order as on SQLite (B-2202), including mixed case, accents, wildcards, empty values
 *                                  and ties
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import type { Filter, Sort } from '../../src/apps/query.js';
import { entityDefinitionSchema } from '../../src/apps/schema.js';
import { testConfig } from '../helpers.js';

const ROWS: Record<string, unknown>[] = [
  { code: 'A-1', name: 'alpha', city: 'Zürich', amount: 50, due: '2026-03-01', tier: 'gold', active: true },
  { code: 'A-2', name: 'Alpha', city: 'zurich', amount: 5, due: '2026-01-15', tier: 'Silver', active: false },
  { code: 'B-1', name: 'Bravo_1', city: 'Oslo', amount: 500, due: '2026-02-01', tier: 'bronze' },
  { code: 'B-2', name: 'bravo%', amount: 50, tier: 'gold', active: true },
  { code: 'C-1', name: 'Ça va', city: 'Paris', amount: -2.5, due: '2025-12-31', active: false },
  { code: 'C-2', name: 'charlie', city: 'oslo', amount: 0, due: '2026-03-01', tier: 'silver' },
  { code: 'D-1', name: 'Δelta', city: 'Athens', amount: 1e6, due: '2026-03-01T10:00:00Z', tier: 'gold', active: true },
  { code: 'D-2', name: 'delta', city: '', amount: 50, tier: 'Gold' }
];

const QUERIES: { name: string; filter?: Filter; sort?: Sort; q?: string }[] = [
  { name: 'eq text ignores case', filter: { field: 'name', op: 'eq', value: 'ALPHA' }, sort: [{ field: 'code', dir: 'asc' }] },
  { name: 'accents are not folded', filter: { field: 'city', op: 'eq', value: 'zurich' } },
  { name: 'ne includes empty', filter: { field: 'tier', op: 'ne', value: 'gold' }, sort: [{ field: 'code', dir: 'desc' }] },
  { name: 'numbers', filter: { and: [{ field: 'amount', op: 'gte', value: 0 }, { field: 'amount', op: 'lt', value: 500 }] }, sort: [{ field: 'amount', dir: 'desc' }, { field: 'code', dir: 'asc' }] },
  { name: 'in', filter: { field: 'tier', op: 'in', value: ['SILVER', 'bronze'] }, sort: [{ field: 'name', dir: 'asc' }] },
  { name: 'dates', filter: { field: 'due', op: 'gte', value: '2026-02-01' }, sort: [{ field: 'due', dir: 'asc' }, { field: 'code', dir: 'asc' }] },
  { name: 'exists false', filter: { field: 'due', op: 'exists', value: false }, sort: [{ field: 'code', dir: 'asc' }] },
  { name: 'booleans', filter: { field: 'active', op: 'eq', value: true }, sort: [{ field: 'code', dir: 'asc' }] },
  { name: 'contains with literal wildcards', filter: { field: 'name', op: 'contains', value: '_1' } },
  { name: 'percent literal', filter: { field: 'name', op: 'contains', value: '%' } },
  { name: 'startsWith', filter: { field: 'name', op: 'startsWith', value: 'BR' }, sort: [{ field: 'name', dir: 'desc' }] },
  { name: 'or with not', filter: { or: [{ field: 'city', op: 'eq', value: 'oslo' }, { not: { field: 'amount', op: 'lte', value: 100 } }] }, sort: [{ field: 'code', dir: 'asc' }] },
  { name: 'text sort is byte order, empty last', sort: [{ field: 'city', dir: 'asc' }, { field: 'code', dir: 'asc' }] },
  { name: 'text sort descending, empty last', sort: [{ field: 'city', dir: 'desc' }, { field: 'code', dir: 'asc' }] },
  { name: 'unicode names sort', sort: [{ field: 'name', dir: 'asc' }, { field: 'code', dir: 'asc' }] },
  { name: 'ties fall back to id order', sort: [{ field: 'tier', dir: 'asc' }] },
  { name: 'search', q: 'ALP', sort: [{ field: 'code', dir: 'asc' }] },
  { name: 'formula', filter: { field: 'double', op: 'gt', value: 99 }, sort: [{ field: 'double', dir: 'asc' }, { field: 'code', dir: 'asc' }] },
  { name: 'state and system fields', filter: { and: [{ field: 'state', op: 'eq', value: 'new' }, { field: 'createdAt', op: 'gt', value: 0 }] }, sort: [{ field: 'code', dir: 'asc' }] }
];

const DEFINITION = entityDefinitionSchema.parse({
  fields: [
    { name: 'code', type: 'string', required: true, indexed: true, unique: true, maxLength: 20 },
    { name: 'name', type: 'string', indexed: true, maxLength: 100 },
    { name: 'city', type: 'string', indexed: true, maxLength: 100 },
    { name: 'amount', type: 'number', indexed: true },
    { name: 'due', type: 'date', indexed: true, withTime: true },
    { name: 'tier', type: 'enum', indexed: true, options: [{ value: 'gold' }, { value: 'silver' }, { value: 'bronze' }] },
    { name: 'active', type: 'boolean', indexed: true },
    { name: 'double', type: 'formula', expression: 'amount * 2', indexed: true }
  ],
  states: { initial: 'new', states: [{ name: 'new' }, { name: 'done' }], transitions: [{ from: ['new'], to: 'done' }] }
});

async function scenario(client: 'sqlite' | 'pg' | 'mysql', url?: string) {
  const cfg = testConfig(client === 'sqlite' ? {} : { DB_CLIENT: client, DATABASE_URL: url! });
  const db = createDb(cfg);
  if (client !== 'sqlite') await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
  await migrate(db);
  const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
  const drain = async () => {
    for (let i = 0; i < 20; i++) if (!(await s.jobs.runDue())) return;
  };
  try {
    expect(await db.schema.hasTable('app_record_values')).toBe(true);
    await bootstrap(s);
    const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
    const ws = await s.tenants.createWorkspace(tenant.id, 'Apps', 'confidential');
    const u = await s.users.create(tenant.id, { username: 'ada', displayName: 'Ada', clearance: 'internal' });
    await s.users.update(tenant.id, u.id, { clearance_direct: 'internal' });
    await s.users.setRoles(u.id, 'direct', ['workflow-admin', 'member']);
    await s.tenants.addMember(ws.id, u.id);
    const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
    p.workspaceId = ws.id;
    const actor = { principal: p, source: 'api' as const };
    const app = await s.apps.create(actor, { name: 'dialects', label: 'internal', workspaceId: ws.id });
    const { entity } = await s.apps.createEntity(actor, app.id, { name: 'thing', definition: DEFINITION });
    const codes = new Map<string, string>();
    for (const v of ROWS) {
      const r = await s.apps.createRecord(actor, app, entity, { values: v });
      codes.set(r.id, String(v.code));
    }
    await drain();

    // B-2201: a duplicate unique value is refused, also when two writes race for it
    await expect(s.apps.createRecord(actor, app, entity, { values: { code: 'a-1' } })).rejects.toMatchObject({ status: 409, extensions: { field: 'code' } });
    const race = await Promise.allSettled([1, 2, 3].map(() => s.apps.createRecord(actor, app, entity, { values: { code: 'RACE' } })));
    expect(race.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const winner = race.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>;
    await s.apps.removeRecord(actor, app, entity, winner.value.id);

    // B-2202: the outcome of every query, as codes in order
    const out: Record<string, string[]> = {};
    for (const q of QUERIES) {
      const r = await s.apps.query(p, app.id, entity.id, { ...(q.filter ? { filter: q.filter } : {}), ...(q.sort ? { sort: q.sort } : {}), ...(q.q ? { q: q.q } : {}), limit: 200 });
      out[q.name] = r.records.map((x) => String(x.values.code));
    }
    const agg = await s.apps.aggregate(p, app.id, entity.id, { groupBy: 'tier', metrics: [{ op: 'count' }, { op: 'sum', field: 'amount' }, { op: 'min', field: 'due' }] });
    const page = await s.apps.query(p, app.id, entity.id, { sort: [{ field: 'amount', dir: 'asc' }, { field: 'code', dir: 'asc' }], limit: 3, offset: 3 });
    return { out, agg: agg.groups, page: { total: page.total, codes: page.records.map((x) => String(x.values.code)) }, ids: new Map([...codes].map(([id, code]) => [code, id])) };
  } finally {
    await s.close();
    await db.destroy();
  }
}

/** What the queries must return, worked out by hand from ROWS; every dialect must match it exactly. */
const EXPECTED: Record<string, string[]> = {
  'eq text ignores case': ['A-1', 'A-2'],
  'accents are not folded': ['A-2'],
  'ne includes empty': ['C-2', 'C-1', 'B-1', 'A-2'],
  numbers: ['A-1', 'B-2', 'D-2', 'A-2', 'C-2'],
  in: ['A-2', 'B-1', 'C-2'],
  dates: ['B-1', 'A-1', 'C-2', 'D-1'],
  'exists false': ['B-2', 'D-2'],
  booleans: ['A-1', 'B-2', 'D-1'],
  'contains with literal wildcards': ['B-1'],
  'percent literal': ['B-2'],
  startsWith: ['B-1', 'B-2'], // '_' (0x5F) sorts after '%' (0x25)
  'or with not': ['B-1', 'C-2', 'D-1'],
  'text sort is byte order, empty last': ['D-1', 'B-1', 'C-2', 'C-1', 'A-2', 'A-1', 'B-2', 'D-2'],
  'text sort descending, empty last': ['A-1', 'A-2', 'C-1', 'B-1', 'C-2', 'D-1', 'B-2', 'D-2'],
  'unicode names sort': ['A-1', 'A-2', 'B-2', 'B-1', 'C-2', 'D-2', 'C-1', 'D-1'],
  search: ['A-1', 'A-2'],
  formula: ['A-1', 'B-2', 'D-2', 'B-1', 'D-1'],
  'state and system fields': ['A-1', 'A-2', 'B-1', 'B-2', 'C-1', 'C-2', 'D-1', 'D-2']
};

function check(r: Awaited<ReturnType<typeof scenario>>) {
  for (const [name, codes] of Object.entries(EXPECTED)) expect(r.out[name], name).toEqual(codes);
  // ties fall back to the record id (byte order on every dialect): bronze, gold, silver, then the empty tier
  const byId = (codes: string[]) => [...codes].sort((a, b) => (r.ids.get(a)! < r.ids.get(b)! ? -1 : 1));
  expect(r.out['ties fall back to id order']).toEqual(['B-1', ...byId(['A-1', 'B-2', 'D-1', 'D-2']), ...byId(['A-2', 'C-2']), 'C-1']);
  expect(r.agg).toEqual([
    { key: 'bronze', values: [1, 500, Date.parse('2026-02-01T00:00:00Z')] },
    { key: 'gold', values: [4, 1e6 + 150, Date.parse('2026-03-01T00:00:00Z')] },
    { key: 'silver', values: [2, 5, Date.parse('2026-01-15T00:00:00Z')] },
    { key: null, values: [1, -2.5, Date.parse('2025-12-31T00:00:00Z')] }
  ]);
  expect(r.page).toEqual({ total: 8, codes: ['A-1', 'B-2', 'D-2'] });
}

describe('low-code records across dialects (B-2201, B-2202)', () => {
  it('on SQLite', async () => {
    check(await scenario('sqlite'));
  });
  it.skipIf(!process.env.TEST_PG_URL)('on PostgreSQL', async () => {
    check(await scenario('pg', process.env.TEST_PG_URL));
  });
  it.skipIf(!process.env.TEST_MYSQL_URL)('on MySQL', async () => {
    check(await scenario('mysql', process.env.TEST_MYSQL_URL));
  });
});
