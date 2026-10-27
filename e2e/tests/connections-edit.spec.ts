import { test, expect, open, expectLive, toast, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 2.0.x: schema editing on the Connections screen's Schema designer tab. The objects panel lists the connection's
 * objects (GET /objects), Edit opens the create form filled from the description (GET /objects/describe), the Changes
 * list follows the form, Preview sends an alter-table definition, and a plan that loses data needs the table's name
 * typed back before Apply (also in the Drop dialog). The connection is the outside table at crm.internal (a SQLite
 * stand-in behind the real connection flow); the edit routes are answered in the browser here, so the spec drives
 * the console against the contract in server/src/connections/ddl-edit-types.ts whatever the drivers support.
 */

const HASH = 'a'.repeat(64);

async function quiet(page: Page): Promise<void> {
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 15_000 });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const description = {
  kind: 'table',
  name: 'public.customers',
  columns: [
    { name: 'id', type: { type: 'integer' }, rawType: 'integer', nullable: false, default: null, identity: true, comment: null },
    { name: 'name', type: { type: 'varchar', length: 200 }, rawType: 'character varying(200)', nullable: false, default: null, identity: false, comment: 'Trading name' },
    { name: 'tier', type: { type: 'text' }, rawType: 'text', nullable: true, default: { kind: 'literal', value: 'silver' }, identity: false, comment: null },
    { name: 'balance', type: { type: 'numeric', precision: 12, scale: 2 }, rawType: 'numeric(12,2)', nullable: true, default: null, identity: false, comment: null },
    { name: 'search', type: null, rawType: 'tsvector', nullable: true, default: null, identity: false, comment: null }
  ],
  primaryKey: { name: 'customers_pkey', columns: ['id'] },
  uniques: [{ name: 'customers_name_key', columns: ['name'] }],
  foreignKeys: [],
  checks: [{ name: 'customers_balance_check', expression: 'balance >= 0' }],
  indexes: [
    { name: 'customers_pkey', columns: [{ name: 'id' }], unique: true, method: 'btree', where: null, include: [], constraint: true },
    { name: 'ix_customers_tier', columns: [{ name: 'tier' }], unique: false, method: 'btree', where: null, include: [], constraint: false }
  ],
  comment: null,
  options: {}
};

const plan = (statements: string[], destructive: boolean) => ({ engine: 'postgres', kind: 'alter-table', object: 'public.customers', statements, ops: [], transactional: true, touches: ['public.customers'], notes: [], destructive, confirmName: destructive ? 'public.customers' : null, hash: HASH });

test.describe('Connections: editing the schema', () => {
  const made: { conn?: string } = {};

  test.beforeAll(async () => {
    const root = await apiAs('root');
    const conn = await root.post('/api/admin/connections', { name: `crm-edit-${Date.now().toString(36)}`, engine: 'postgres', endpoint: 'crm.internal:5432', database: 'crm', label: 'internal', username: 'app', password: 'right' });
    await root.post(`/api/admin/connections/${conn.id}/schema`);
    await root.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['public.customers'] });
    made.conn = conn.id;
    await root.close();
  });

  test.afterAll(async () => {
    const root = await apiAs('root');
    if (made.conn) await root.del(`/api/admin/connections/${made.conn}`);
    await root.close();
  });

  test('lists the objects, edits a table with a Changes list, previews it and confirms a destructive plan by name', async ({ page }) => {
    const id = made.conn!;
    const previews: any[] = [];
    const applies: any[] = [];
    await page.route(new RegExp(`/api/admin/connections/${id}/objects$`), (route) => route.fulfill({ json: {
      objects: [
        { name: 'public.customers', kind: 'table', allowed: true },
        { name: 'public.audit_log', kind: 'table', allowed: false },
        { name: 'public.active_customers', kind: 'view', allowed: true },
        { name: 'public.touch_customer', kind: 'function', allowed: true, signature: 'integer' }
      ],
      editable: { edit: ['table', 'index', 'procedure', 'function'], drop: ['table', 'view', 'index', 'procedure', 'function'] }
    } }));
    await page.route(new RegExp(`/api/admin/connections/${id}/objects/describe\\?`), (route) => {
      const u = new URL(route.request().url());
      expect(u.searchParams.get('name')).toBe('public.customers');
      expect(u.searchParams.get('kind')).toBe('table');
      return route.fulfill({ json: { description } });
    });
    await page.route(new RegExp(`/api/admin/connections/${id}/ddl/preview$`), (route) => {
      const body = route.request().postDataJSON();
      previews.push(body);
      const d = body.definition;
      if (d.kind === 'drop') return route.fulfill({ json: { plan: { ...plan(['DROP TABLE "public"."customers"'], true), kind: 'drop' }, blockers: [] } });
      return route.fulfill({ json: { plan: plan(['ALTER TABLE "public"."customers" RENAME COLUMN "tier" TO "level"', 'ALTER TABLE "public"."customers" DROP COLUMN "balance"', 'ALTER TABLE "public"."customers" ADD COLUMN "notes" text'], true), blockers: [] } });
    });
    await page.route(new RegExp(`/api/admin/connections/${id}/ddl/apply$`), (route) => {
      applies.push(route.request().postDataJSON());
      return route.fulfill({ json: { plan: plan([], true), ms: 14, allowListed: false, schemaRefreshed: true } });
    });

    await open(page, 'connections');
    await expectLive(page);
    await page.locator(`[data-conn="${id}"]`).click();
    await page.getByRole('tab', { name: 'Schema designer' }).click();

    // The objects panel: grouped by kind, the allow-list shown, Edit and Drop off for an object outside it.
    const main = page.locator('#main');
    await expect(main.locator('[data-objrow="public.customers"]')).toBeVisible();
    await expect(main.locator('[data-objrow="public.audit_log"]')).toContainText('not allow-listed');
    await expect(main.getByRole('button', { name: 'Edit table public.audit_log' })).toBeDisabled();
    await expect(main.getByRole('button', { name: 'Drop table public.audit_log' })).toBeDisabled();
    await expect(main.getByRole('button', { name: 'Edit view public.active_customers' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Drop view public.active_customers' })).toBeEnabled();
    await expect(main.getByRole('button', { name: 'New table' })).toBeVisible();
    await main.locator('[data-objfilter]').fill('audit');
    await expect(main.locator('[data-objrow="public.customers"]')).toHaveCount(0);
    await main.locator('[data-objfilter]').fill('');
    await expectAxeClean(page, 'aa', 'Connections, the objects panel');

    // New opens the create form as before (kind chips and all), with a way back.
    await main.getByRole('button', { name: 'New table' }).click();
    await expect(main.locator('[data-ddlkind="table"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(main.locator('[data-df="name"]')).toHaveValue('');
    await main.getByRole('button', { name: 'Back to objects' }).click();
    await expect(main.locator('[data-objrow="public.customers"]')).toBeVisible();

    // Edit: the table form, filled from the description.
    await main.getByRole('button', { name: 'Edit table public.customers' }).click();
    await expect(main.getByRole('heading', { name: /Edit table/ })).toBeVisible();
    await expect(main.locator('[data-df="columns.1.name"]')).toHaveValue('name');
    await expect(main.locator('input[readonly][value="tsvector"]')).toBeVisible();
    await expect(main.getByRole('button', { name: 'Change the type of column search' })).toBeVisible();
    await expect(main.locator('[data-ddlchanges]')).toContainText('No changes yet');
    await expect(main.locator('[data-idxedit]')).toHaveCount(1);

    // Rename a column, drop one (struck through, with Undo), add one: the Changes list follows.
    await main.locator('[data-df="columns.2.name"]').fill('level');
    await main.locator('[data-df="columns.2.name"]').press('Tab');
    await expect(main.locator('[data-ddlchanges]')).toContainText('Rename column tier to level');
    await expect(main.getByText('Renamed from')).toBeVisible();
    await main.getByRole('button', { name: 'Remove column 4' }).click();
    await expect(main.locator('.cd-dropped')).toContainText('will be dropped');
    await expect(main.locator('[data-ddlchanges]')).toContainText('Drop column balance (loses data)');
    await main.getByRole('button', { name: 'Keep column balance' }).click();
    await expect(main.locator('.cd-dropped')).toHaveCount(0);
    await main.getByRole('button', { name: 'Remove column 4' }).click();
    await main.locator('[data-dadd="columns"]').click();
    await main.locator('[data-df="columns.5.name"]').fill('notes');
    await main.locator('[data-df="columns.5.name"]').press('Tab');
    await expect(main.locator('[data-ddlchanges]')).toContainText('Add column notes');
    await expectAxeClean(page, 'aa', 'Connections, editing a table');
    await quiet(page);
    await reflow(page, 'connections: editing a table');

    // Preview sends the alter-table definition: from on existing columns, the dropped one left out.
    await main.locator('[data-ddlprev]').click();
    await expect(main.locator('[data-ddlout]')).toContainText('This change loses data');
    const def = previews.at(-1).definition;
    expect(def.kind).toBe('alter-table');
    expect(def.name).toBe('public.customers');
    expect(def.columns.map((c: any) => [c.from ?? null, c.name])).toEqual([['id', 'id'], ['name', 'name'], ['tier', 'level'], ['search', 'search'], [null, 'notes']]);
    expect(def.columns.find((c: any) => c.name === 'search').type).toBeUndefined();
    expect(def.primaryKey).toEqual(['id']);
    expect(def.uniques).toEqual([{ columns: ['name'], name: 'customers_name_key' }]);
    expect(def.checks).toEqual([{ expression: 'balance >= 0', name: 'customers_balance_check' }]);

    // Apply: the danger notice lists what is lost, and the button waits for the name typed exactly.
    await main.locator('[data-ddlapply]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('This change loses data');
    await expect(modal).toContainText('Drop column balance');
    const go = modal.locator('[data-cdgo]');
    await expect(go).toBeDisabled();
    await modal.locator('[data-cdconfirm]').fill('customers');
    await expect(go).toBeDisabled();
    await modal.locator('[data-cdconfirm]').fill('public.customers');
    await expect(go).toBeEnabled();
    await expectAxeClean(page, 'aa', 'Connections, confirming a destructive change');
    await go.click();
    await toast(page, 'Changed');
    expect(applies.at(-1)).toMatchObject({ hash: HASH, confirm: 'public.customers', allowList: false });
    expect(applies.at(-1).definition.kind).toBe('alter-table');
    // Back on the objects panel, read again.
    await expect(main.locator('[data-objrow="public.customers"]')).toBeVisible();

    // Drop: previewed first, then the name typed back.
    await quiet(page);
    await main.getByRole('button', { name: 'Drop table public.customers' }).click();
    const dlg = page.locator('#overlay .modal');
    await expect(dlg).toContainText('DROP TABLE');
    expect(previews.at(-1).definition).toEqual({ kind: 'drop', objectKind: 'table', name: 'public.customers' });
    await dlg.getByText('Drop dependent objects too (CASCADE)').click();
    await expect.poll(() => previews.at(-1).definition.cascade).toBe(true);
    const drop = dlg.locator('[data-pdgo]');
    await expect(drop).toBeDisabled();
    await dlg.locator('[data-cdconfirm]').fill('public.customers');
    await expect(drop).toBeEnabled();
    await expectAxeClean(page, 'aa', 'Connections, the drop dialog');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#overlay')).toHaveCount(0);
    expect(applies).toHaveLength(1);
  });
});
