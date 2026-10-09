import { test, expect, open, expectLive, apiAs, ready } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';

// 1.7.0, Sprint 40b (B-3804 to B-3807): the Import screen, live. The repositories are seeded and confirmed by the
// harness (an open-data portal with a CKAN datastore and an SDMX flow, a hub with dataset repositories); their
// harvests run on the job queue when the server starts.
test.describe('Import', () => {
  test('the Repositories tab lists the confirmed sources and the Imports tab is empty at first', async ({ page }) => {
    await open(page, 'import?tab=repos');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Open data portal');
    await expect(page.locator('#main')).toContainText('Hub with datasets');
    await expect(page.locator('#main tr[data-reporow]')).toHaveCount(3);
    await page.locator('#main tr[data-reporow]', { hasText: 'Eurostat (SDMX)' }).click();
    await expect(page.locator('#main .inspector')).toContainText('SDMX provider');
    await expectAccessible(page, 'import repositories');
    await expectAxeClean(page, 'aa', 'import repositories');
    await page.locator('.tabs [data-tab="imports"]').click();
    await expect(page.locator('#main')).toContainText('No imports yet');
  });

  test('imports a CKAN datastore as a training dataset: browse, select, review with PII flags, destination, confirm, done', async ({ page }) => {
    await open(page, 'import?kind=dataset&target=training');
    await expectLive(page);
    await expect(page.locator('[data-kindseg] [data-seg="dataset"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-repo]', { hasText: 'Open data portal' }).click();
    await page.locator('[data-next]').click();
    // Browse: the snapshot lists the portal's packages; a search narrows them live.
    await expect(page.locator('#main')).toContainText('Consumer Complaint Database');
    await page.locator('[data-search]').fill('complaint');
    await expect(page.locator('#main tr[data-item]')).toHaveCount(1);
    await page.locator('#main tr[data-item]').first().click();
    await expect(page.locator('#main .inspector')).toContainText('CFPB');
    await page.locator('[data-next]').click();
    // Select: the datastore resource is read through its API, the JSON file as a file.
    await expect(page.locator('#main')).toContainText('ckan-datastore API');
    await expect(page.locator('#main tr', { hasText: 'Complaints (datastore)' }).locator('input[type=checkbox]')).toBeChecked();
    await page.locator('#main tr', { hasText: 'Complaints (JSON)' }).locator('input[type=checkbox]').uncheck();
    await page.locator('[data-f="sample"]').fill('120');
    await page.locator('[data-next]').click();
    // Review: the checks and the schema preview with the e-mail column flagged.
    await expect(page.locator('#main')).toContainText('Schema preview');
    await expect(page.locator('#main tr', { hasText: 'email' }).last()).toContainText('email');
    await expect(page.locator('#main tr', { hasText: 'PII' }).first()).toContainText('warning');
    await expect(page.locator('#main tr', { hasText: 'Licence' }).first()).toContainText('us-pd');
    await page.locator('[data-f="label"]').selectOption('confidential');
    await expectAccessible(page, 'import review');
    await expectAxeClean(page, 'aa', 'import review');
    await page.locator('[data-next]').click();
    // Destination: a training dataset named from the columns the preview found.
    await page.locator('[data-f="name"]').fill('complaints-e2e');
    await page.locator('[data-f="textCol"]').selectOption('narrative');
    await page.locator('[data-f="labelCol"]').selectOption('product');
    await page.locator('[data-next]').click();
    await expect(page.locator('#main')).toContainText('Training dataset complaints-e2e');
    await page.locator('[data-start]').click();
    await expect(page.locator('#main')).toContainText(/IMP-\d{4}-\d+/);
    await expect(page.locator('#main .notice.ok')).toContainText('Training dataset complaints-e2e v1', { timeout: 30_000 });
    await expect(page.locator('#main')).toContainText('120 rows');
    await expectAxeClean(page, 'aa', 'import done');
    // The link lands on Training, where the version is ready with its scrub report.
    await page.locator('[data-open="training"]').click();
    await ready(page, 'training');
    await page.locator('[data-tab="datasets"]').click();
    const row = page.locator('#main tr', { hasText: 'complaints-e2e' }).first();
    await expect(async () => {
      await page.locator('[data-tab="datasets"]').click();
      await expect(row).toContainText('masked, report attached', { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await expect(row).toContainText('Imported from Open data portal');
    // The queue shows the import complete with its log.
    await open(page, 'import?tab=imports');
    await expect(page.locator('#main tr[data-job]').first()).toContainText('complete');
    await page.locator('#main tr[data-job]').first().click();
    await page.locator('[data-log]').click();
    await expect(page.locator('#overlay')).toContainText('Rows fetched');
    await expectAxeClean(page, 'aa', 'import log');
  });

  test('a hub dataset becomes a classifier eval set with a classifier, and a monthly SDMX table a knowledge set', async ({ page }) => {
    // The eval set, from the Classifiers screen's entry point.
    await open(page, 'classifiers');
    await page.locator('[data-goimport]').click();
    await ready(page, 'import');
    await expect(page.locator('[data-kindseg] [data-seg="dataset"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-repo]', { hasText: 'Hub with datasets' }).click();
    await page.locator('[data-next]').click();
    await page.locator('#main tr[data-item]', { hasText: 'acme/banking' }).click();
    await page.locator('[data-next]').click();
    await expect(page.locator('#main')).toContainText('train.csv');
    await page.locator('[data-next]').click();
    await expect(page.locator('#main tr', { hasText: 'Format' }).first()).toContainText('passed');
    await page.locator('[data-next]').click();
    await expect(page.locator('[data-targetseg] [data-seg="classifiers"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-f="evalSet"]').fill('banking-e2e');
    await page.locator('[data-f="textCol"]').selectOption('text');
    await page.locator('[data-f="labelCol"]').selectOption('label');
    await page.locator('[data-f="clsMode"]').selectOption('new');
    await page.locator('[data-f="clsName"]').fill('Banking intents e2e');
    await expectAccessible(page, 'import destination');
    await expectAxeClean(page, 'aa', 'import destination');
    await page.locator('[data-next]').click();
    await page.locator('[data-start]').click();
    await expect(page.locator('#main .notice.ok')).toContainText('Eval set banking-e2e, 425 cases', { timeout: 30_000 });
    await page.locator('[data-open="classifiers"]').click();
    await ready(page, 'classifiers');
    await expect(page.locator('#main')).toContainText('Banking intents e2e');

    // The knowledge set: a new base on the SDMX flow, refreshed monthly as the publisher updates.
    const api = await apiAs('root');
    await open(page, 'import?kind=dataset&target=knowledge');
    await page.locator('[data-repo]', { hasText: 'Eurostat (SDMX)' }).click();
    await page.locator('[data-next]').click();
    await page.locator('#main tr[data-item]').first().click();
    await page.locator('[data-next]').click();
    await expect(page.locator('#main')).toContainText('sdmx API');
    await page.locator('[data-next]').click();
    await expect(page.locator('#main tr', { hasText: 'Quota' }).first()).toContainText('passed');
    await page.locator('[data-next]').click();
    await page.locator('[data-f="kbName"]').fill('Euro area inflation e2e');
    await page.locator('[data-f="titleCol"]').selectOption('TIME_PERIOD');
    await page.locator('[data-f="metaCols"]').fill('geo, FREQ');
    await expect(page.locator('[data-f="schedule"]')).toHaveValue('publisher');
    await page.locator('[data-next]').click();
    await expect(page.locator('#main')).toContainText('Knowledge set Euro area inflation e2e');
    await page.locator('[data-start]').click();
    await expect(page.locator('#main .notice.ok')).toContainText('refresh monthly', { timeout: 30_000 });
    const kbs = (await api.get('/api/knowledge/bases')) as { id: string; name: string }[];
    const kb = kbs.find((x) => x.name === 'Euro area inflation e2e')!;
    expect(kb).toBeTruthy();
    await expect.poll(async () => ((await api.get(`/api/knowledge/bases/${kb.id}/documents?limit=100`)) as unknown[]).length, { timeout: 30_000 }).toBe(24);
    await page.locator('[data-open="knowledge"]').click();
    await ready(page, 'knowledge');
    await expect(page.locator('#main')).toContainText('dataset: Eurostat (SDMX)');
    await api.close();
  });
});
