import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { serverState } from './support/state';

// B-3407: the Apps screen, live. An entity designed on the screen accepts a record that the grid then shows; the grid
// pages with the records API's cursor; forms, the state machine and triggers are driven through the screen too.

const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');

async function pickApp(page: Page, title: string): Promise<void> {
  await page.locator('#main .leftpane [data-app]', { hasText: title }).click();
  await expect(page.locator('#main .page h1, #main .page .pagehead').first()).toContainText(title);
}

test.describe('Apps', () => {
  test('designs an app and an entity on the screen, and the entity accepts a record that the grid shows', async ({ page }) => {
    const id = uniq();
    const appName = `vendors_${id}`;
    await open(page, 'apps');
    await expectLive(page);

    // A new app in the current workspace.
    await page.locator('#main [data-newapp]').first().click();
    await modal(page).locator('[data-na-name]').fill(appName);
    await modal(page).locator('[data-na-title]').fill(`Vendors ${id}`);
    await modal(page).locator('[data-na-ok]').click();
    await toast(page, `App ${appName} created`);
    await expect(page.locator('#main .page')).toContainText(`Vendors ${id}`);

    // An entity with a first field, then typed fields: a number, an enum and a formula.
    await page.locator('#main [data-newentity]').first().click();
    await modal(page).locator('[data-ne-name]').fill('vendor');
    await modal(page).locator('[data-ne-title]').fill('Vendor');
    await modal(page).locator('[data-ne-fname]').fill('name');
    await modal(page).locator('[data-ne-freq]').check();
    await modal(page).locator('[data-ne-ok]').click();
    await toast(page, 'Entity vendor created');

    const addField = async (name: string, type: string, fill?: (m: ReturnType<typeof modal>) => Promise<void>) => {
      await page.locator('#main [data-addfield]').click();
      const m = modal(page);
      await m.locator('[data-ff="name"]').fill(name);
      await m.locator('[data-ff="type"]').selectOption(type);
      if (fill) await fill(m);
      await m.locator('[data-ff-ok]').click();
      await toast(page, `Field ${name} added.`);
      await expect(page.locator(`#main tr[data-field="${name}"]`)).toBeVisible();
    };
    await addField('spend', 'number', async (m) => { await m.locator('[data-ff="indexed"]').check(); await m.locator('[data-ff="min"]').fill('0'); });
    await addField('country', 'enum', async (m) => { await m.locator('[data-ff="indexed"]').check(); await m.locator('[data-ff="options"]').fill('DE\nFR\nPT'); });
    await addField('tier', 'formula', async (m) => {
      await m.locator('[data-ff="expression"]').fill('if(spend > 1000, "major", "standard")');
      await expect(m.locator('[data-fcheck]')).toContainText('Looks right');
    });
    await expect(page.locator('#main tr[data-field="tier"]')).toContainText('if(spend > 1000');

    // The state machine: draft (initial) and approved, with a submit transition.
    await page.locator('#main [data-addsm]').click();
    await modal(page).locator('[data-sm-init]').fill('draft');
    await modal(page).locator('[data-sm-ok]').click();
    await toast(page, 'State machine added.');
    await page.locator('#main [data-addstate]').click();
    await modal(page).locator('[data-as-name]').fill('approved');
    await modal(page).locator('[data-as-ok]').click();
    await toast(page, 'State approved added.');
    await page.locator('#main [data-addtrans]').click();
    await modal(page).locator('[data-at-name]').fill('approve');
    await modal(page).locator('[data-at-to]').selectOption('approved');
    await modal(page).locator('[data-at-from="draft"]').check();
    await modal(page).locator('[data-at-ok]').click();
    await toast(page, 'Transition added.');
    await expect(page.locator('#main svg.apps-sm')).toHaveAttribute('aria-label', /states draft, approved, initial draft/);

    // A record through the screen, then in the grid with its computed formula and initial state.
    await page.locator('#main [data-tab="records"]').click();
    await expect(page.locator('#main')).toContainText('No records yet');
    await page.locator('#main [data-newrec]').click();
    const rm = modal(page);
    await rm.locator('[data-fv="name"]').fill(`Fabrikam ${id}`);
    await rm.locator('[data-fv="spend"]').fill('4200');
    await rm.locator('[data-fv="country"]').selectOption('DE');
    await rm.locator('[data-rec-ok]').click();
    await toast(page, /Record .* created in draft/);
    const row = page.locator('#main tr[data-rec]', { hasText: `Fabrikam ${id}` });
    await expect(row).toBeVisible();
    await expect(row).toContainText('draft');
    await expect(page.locator('#main .inspector')).toContainText('major');

    // A filter on an indexed field narrows the grid on the server.
    await page.locator('#main [data-addfilter]').click();
    await modal(page).locator('[data-af-field]').selectOption('spend');
    await modal(page).locator('[data-af-op]').selectOption('gt');
    await modal(page).locator('[data-af-value]').fill('5000');
    await modal(page).locator('[data-af-ok]').click();
    await expect(page.locator('#main')).toContainText('No records match');
    await page.locator('#main [data-clearfilters]').click();
    await expect(row).toBeVisible();

    // The transition the state machine allows.
    await row.click();
    await page.locator('#main .inspector [data-transition="approved"]').click();
    await modal(page).locator('[data-tr-ok]').click();
    await toast(page, /is now approved/);
    await expect(row).toContainText('approved');
  });

  test('pages through the records with the cursor the API returns', async ({ page }) => {
    const id = uniq();
    const api = await apiAs('root');
    const app = await api.post('/api/apps', { name: `paged_${id}`, title: `Paged ${id}`, workspaceId: serverState().workspace.id });
    await api.post(`/api/apps/${app.id}/entities`, { name: 'item', title: 'Item', definition: { fields: [{ name: 'n', type: 'number', indexed: true }] } });
    await api.post(`/api/apps/${app.id}/entities/item/records/bulk`, { create: Array.from({ length: 30 }, (_, i) => ({ values: { n: i + 1 } })) });
    await api.close();

    await open(page, 'apps');
    await pickApp(page, `Paged ${id}`);
    await page.locator('#main [data-tab="records"]').click();
    await page.locator('#main [data-sort]').click();
    await modal(page).locator('[data-so-f="0"]').selectOption('n');
    await modal(page).locator('[data-so-d="0"]').selectOption('asc');
    await modal(page).locator('[data-so-ok]').click();
    await expect(page.locator('#main')).toContainText('Showing 1 to 25 of 30');
    await page.locator('#main [data-next]').click();
    await expect(page.locator('#main')).toContainText('Showing 26 to 30 of 30');
    await expect(page.locator('#main tr[data-rec]')).toHaveCount(5);
    await expect(page.locator('#main tr[data-rec]').first()).toContainText('26');
    await expect(page.locator('#main [data-next]')).toBeDisabled();
    await page.locator('#main [data-prev]').click();
    await expect(page.locator('#main')).toContainText('Showing 1 to 25 of 30');
  });

  test('builds a form, submits it, and adds a trigger on a published workflow', async ({ page }) => {
    const id = uniq();
    const api = await apiAs('root');
    const app = await api.post('/api/apps', { name: `intake_${id}`, title: `Intake ${id}`, workspaceId: serverState().workspace.id });
    await api.post(`/api/apps/${app.id}/entities`, { name: 'lead', title: 'Lead', definition: { fields: [{ name: 'company', type: 'string', required: true, indexed: true, maxLength: 120 }, { name: 'size', type: 'number', indexed: true }, { name: 'notes', type: 'string', multiline: true }] } });
    const wf = await api.post('/api/workflows', { name: `lead-welcome-${id}` });
    await api.post(`/api/workflows/${wf.id}/publish`, {});
    await api.close();

    await open(page, 'apps');
    await pickApp(page, `Intake ${id}`);
    await page.locator('#main [data-tab="forms"]').click();
    await page.locator('#main [data-newform]').click();
    await modal(page).locator('[data-nf-name]').fill('lead_intake');
    await modal(page).locator('[data-nf-title]').fill('Lead intake');
    await modal(page).locator('[data-nf-ok]').click();
    await toast(page, 'Form lead_intake created.');

    // Add the size field, then notes shown only when size is given.
    await page.locator('#main [data-fadd]').click();
    await modal(page).locator('[data-xf-field]').selectOption('size');
    await modal(page).locator('[data-xf-ok]').click();
    await page.locator('#main [data-fadd]').click();
    await modal(page).locator('[data-xf-field]').selectOption('notes');
    await modal(page).locator('[data-xf-cf]').selectOption('size');
    await modal(page).locator('[data-xf-cop]').selectOption('truthy');
    await modal(page).locator('[data-xf-ok]').click();
    await page.locator('#main [data-fsave]').click();
    await toast(page, 'Form saved.');
    await expect(page.locator('#main tr[data-form]')).toContainText('3');

    // The preview hides notes until size has a value, then the submission writes a record.
    const preview = page.locator('#main .apps-preview');
    await expect(preview.locator('[data-fv="notes"]')).toHaveCount(0);
    await preview.locator('[data-fv="company"]').fill(`Contoso ${id}`);
    await preview.locator('[data-fv="size"]').fill('40');
    await preview.locator('[data-fv="size"]').blur();
    await expect(preview.locator('[data-fv="notes"]')).toBeVisible();
    await page.locator('#main [data-ftest]').click();
    await toast(page, /201: .*Audited app.form.submitted/);
    await expect(page.locator('#main')).toContainText('201 Submitted.');
    await page.locator('#main [data-tab="records"]').click();
    await expect(page.locator('#main tr[data-rec]', { hasText: `Contoso ${id}` })).toContainText('form');

    // A record trigger on the published workflow, then disabled.
    await page.locator('#main [data-tab="triggers"]').click();
    await page.locator('#main [data-tadd]').click();
    await modal(page).locator('[data-tr-ev="updated"]').check();
    await modal(page).locator('[data-tr-ok]').click();
    await toast(page, 'Trigger added; it runs as you.');
    const trow = page.locator('#main tr', { hasText: `lead-welcome-${id}` });
    await expect(trow).toContainText('created, updated');
    await trow.locator('[data-ttoggle]').click();
    await toast(page, 'Trigger disabled.');
    await expect(trow.locator('[data-ttoggle]')).toHaveAttribute('aria-checked', 'false');
    await trow.locator('[data-tdel]').click();
    await confirmDialog(page, 'Delete');
    await toast(page, 'Trigger deleted.');
  });

  test.describe('as a member', () => {
    test.use({ user: 'member' });
    test('a member adds a record to an app it may not design', async ({ page }) => {
      const id = uniq();
      const api = await apiAs('root');
      const app = await api.post('/api/apps', { name: `assets_${id}`, title: `Assets ${id}`, workspaceId: serverState().workspace.id });
      await api.post(`/api/apps/${app.id}/entities`, { name: 'asset', title: 'Asset', definition: { fields: [{ name: 'tag', type: 'string', required: true, indexed: true, unique: true, maxLength: 40 }] } });
      await api.close();

      await open(page, 'apps');
      await expectLive(page);
      await expect(page.locator('#main [data-newapp]')).toHaveCount(0);
      await pickApp(page, `Assets ${id}`);
      await expect(page.locator('#main [data-editapp], #main [data-addfield], #main [data-tab="triggers"]')).toHaveCount(0);
      await page.locator('#main [data-tab="records"]').click();
      await page.locator('#main [data-newrec]').click();
      await modal(page).locator('[data-fv="tag"]').fill(`NW-${id}`);
      await modal(page).locator('[data-rec-ok]').click();
      await toast(page, /Record .* created/);
      await expect(page.locator('#main tr[data-rec]', { hasText: `NW-${id}` })).toBeVisible();
    });
  });
});
