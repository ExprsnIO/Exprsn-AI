import { test, expect, open, expectLive, toast, confirmDialog, ready, type Page } from './support/fixtures';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

// Sprint 40 (B-3807): the Import screen against the import fakes (a CKAN portal and a hub on loopback). The
// repositories are added through the console under dual control, then a dataset goes to Training and to Knowledge,
// a pickle-only model is refused at the Review step, and a licence outside policy waits in the queue.
test.describe('Import', () => {
  test.describe.configure({ mode: 'serial' });

  const row = (page: Page, text: string) => page.locator('#main tbody tr', { hasText: text }).first();
  const next = (page: Page) => page.locator('[data-next]');
  /** Source and Browse: pick the kind and the repository, then the catalogue row. */
  async function pick(page: Page, kind: 'model' | 'dataset', repo: string, item: string) {
    await page.locator(`[data-kindseg] [data-seg="${kind}"]`).click();
    await page.locator('.imp-repo', { hasText: repo }).click();
    await next(page).click();
    await row(page, item).click();
    await next(page).click();
  }

  test('adds repositories under dual control and harvests them', async ({ page, as }) => {
    const { fakes } = serverState();
    await open(page, 'import');
    await expectLive(page);
    await page.locator('.tabs [data-tab="repos"]').click();
    for (const [type, name, url] of [['ckan', 'data.gov (e2e)', `${fakes.ckan}/api/3`], ['hf', 'Hub (e2e)', fakes.hub]] as const) {
      await page.locator('[data-addrepo]').click();
      const modal = page.locator('#overlay .modal');
      await modal.locator('[data-f="type"]').selectOption(type);
      await modal.locator('[data-f="name"]').fill(name);
      await modal.locator('[data-f="baseUrl"]').fill(url);
      await modal.locator('[data-ok]').click();
      await toast(page, 'Repository proposed');
      await expect(row(page, name)).toContainText('pending');
    }
    // Whoever proposed a repository cannot confirm it.
    await row(page, 'data.gov (e2e)').click();
    await expect(page.locator('[data-repoact="confirm"]')).toBeDisabled();

    const second = await as('root2');
    await second.goto('/#/import?tab=repos');
    await ready(second, 'import');
    for (const name of ['data.gov (e2e)', 'Hub (e2e)']) {
      await second.locator('#main tr.row', { hasText: name }).first().click();
      await second.locator('[data-repoact="confirm"]').click();
      await expect(second.locator('#toasts')).toContainText(`${name} confirmed`);
    }
    // The harvest jobs fill the snapshots.
    await expect(async () => {
      await page.locator('[data-reload]').click();
      await expect(row(page, 'data.gov (e2e)')).toContainText('reachable', { timeout: 1000 });
      await expect(row(page, 'Hub (e2e)')).toContainText('reachable', { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await row(page, 'data.gov (e2e)').click();
    await expect(page.locator('.inspector')).toContainText('5 items');
  });

  test('imports a dataset as a training dataset version, with the schema preview and the checks', async ({ page }) => {
    await open(page, 'training');
    await page.locator('[data-tab="datasets"]').click();
    // The entry point on Training opens the wizard for a dataset.
    await page.locator('[data-goimport]').click();
    await ready(page, 'import');
    await pick(page, 'dataset', 'data.gov (e2e)', 'Failed Bank List');
    // Select: the resource, and the schema preview of its first rows.
    await expect(page.locator('#main')).toContainText('banklist.csv');
    await expect(page.locator('#main')).toContainText('Schema preview, first 12 rows');
    await expect(row(page, 'Closing Date')).toContainText('date');
    await next(page).click();
    // Review: the policy checks.
    await expect(row(page, 'Licence')).toContainText('passed');
    await expect(row(page, 'Selection')).toContainText('banklist.csv');
    await page.locator('[data-f="attribution"]').fill('FDIC, data.gov');
    await next(page).click();
    // Destination: a training dataset by default from this entry point.
    await expect(page.locator('[data-targetseg] [data-seg="training"]')).toHaveAttribute('aria-pressed', 'true');
    // A name that sorts after the Training spec's finance-qa, whose dialog offers the first dataset by name.
    await page.locator('[data-f="name"]').fill('imported-banks');
    await page.locator('[data-f="name"]').blur();
    await page.locator('[data-f="promptColumn"]').selectOption('Bank Name');
    await page.locator('[data-f="completionColumn"]').selectOption('Acquiring Institution');
    await expect(page.locator('#main')).toContainText('Training dataset imported-banks v1');
    await next(page).click();
    await expect(page.locator('#main')).toContainText('Training dataset imported-banks v1');
    await page.locator('[data-start]').click();
    await toast(page, 'started. Audit entry written.');
    await expect(page.locator('#main')).toContainText('is ready', { timeout: 30_000 });
    await expect(page.locator('#main .timeline')).toContainText('PII scrub');
    await page.locator('[data-open]').first().click();
    await ready(page, 'training');
    await page.locator('[data-tab="datasets"]').click();
    await expect(page.locator('#main tr', { hasText: 'imported-banks' }).first()).toContainText('12');
  });

  test('creates a knowledge set from a dataset, with a refresh that follows the publisher', async ({ page }) => {
    await page.goto('/#/import?kind=dataset&target=knowledge');
    await ready(page, 'import');
    await pick(page, 'dataset', 'data.gov (e2e)', 'Failed Bank List');
    await expect(page.locator('#main')).toContainText('Schema preview');
    await next(page).click();
    await expect(row(page, 'Licence')).toContainText('passed');
    await next(page).click();
    await expect(page.locator('[data-targetseg] [data-seg="knowledge"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-f="kbName"]').fill('Failed banks');
    await page.locator('[data-f="kbName"]').blur();
    await page.locator('[data-f="titleColumn"]').selectOption('Bank Name');
    await page.locator('[data-f="textColumns"]').fill('Bank Name, City, Acquiring Institution');
    await page.locator('[data-f="textColumns"]').blur();
    await page.locator('[data-f="idColumn"]').selectOption('Cert');
    await page.locator('[data-f="refresh"]').selectOption('publisher');
    await expect(page.locator('#main')).toContainText('New knowledge base Failed banks');
    await next(page).click();
    await page.locator('[data-start]').click();
    await toast(page, 'started. Audit entry written.');
    await expect(page.locator('#main')).toContainText('is ready', { timeout: 60_000 });
    // The queue shows it with its schedule, its log and its manifest.
    await page.locator('.tabs [data-tab="imports"]').click();
    await row(page, 'Knowledge set: Failed banks').click();
    await expect(page.locator('.inspector')).toContainText('12 documents');
    await expect(page.locator('.inspector')).toContainText('next refresh');
    await page.locator('[data-log]').click();
    const drawer = page.locator('#overlay .drawer');
    await expect(drawer).toContainText('exprsn-import-manifest/1');
    await expect(drawer).toContainText('Checks at request time');
    await drawer.locator('[data-close]').last().click();
    await page.locator('[data-open]').first().click();
    await ready(page, 'knowledge');
    await expect(page.locator('#main')).toContainText('Failed banks');
    await expect(page.locator('#main')).toContainText('Imported dataset');
  });

  test('refuses a pickle-only model at the Review step and shows a gated one', async ({ page }) => {
    await open(page, 'models');
    await page.locator('[data-goimport]').click();
    await ready(page, 'import');
    await pick(page, 'model', 'Hub (e2e)', 'acme/pickle-only');
    await expect(page.locator('#main .problem')).toContainText('Import refused: pickle checkpoint');
    await expect(row(page, 'pytorch_model.bin')).toContainText('pickle, refused');
    await expect(next(page)).toBeDisabled();
    // A gated repository: files are listed, the gate is not accepted, Next stays disabled.
    await page.locator('[data-step="browse"]').click();
    await row(page, 'acme/gated-llama').click();
    await next(page).click();
    await expect(page.locator('#main')).toContainText('is gated');
    await expect(page.locator('[data-gate]')).toBeVisible();
    await expect(next(page)).toBeDisabled();
    // A safetensors repository passes the format check; the Review step lists every check.
    await page.locator('[data-step="browse"]').click();
    await row(page, 'acme/tiny-safetensors').click();
    await next(page).click();
    await expect(row(page, 'model.safetensors')).toContainText('accepted');
    await next(page).click();
    await expect(row(page, 'Format')).toContainText('passed');
    await expect(row(page, 'Licence')).toContainText('apache-2.0');
  });

  test('a licence outside policy waits for legal review; the queue cancels it', async ({ page }) => {
    await page.goto('/#/import?kind=dataset&target=classifiers');
    await ready(page, 'import');
    await pick(page, 'dataset', 'Hub (e2e)', 'acme/phrasebank');
    // Select: a configuration, its split and a sample.
    await expect(row(page, 'train')).toContainText('40');
    await page.locator('[data-sampletoggle]').click();
    await page.locator('[data-s="sampleRows"]').fill('30');
    await page.locator('[data-s="sampleRows"]').blur();
    await expect(page.locator('#main')).toContainText('Schema preview');
    await next(page).click();
    await expect(page.locator('#main')).toContainText('outside the tenant allow list');
    await expect(row(page, 'Size and quota')).toContainText('the first 30 rows in publication order');
    await expect(next(page)).toBeDisabled();
    await page.locator('[data-exception]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-f="reason"]').fill('internal evaluation only');
    await modal.locator('[data-ok]').click();
    await toast(page, 'The exception is requested when the import is started.');
    await next(page).click();
    await expect(page.locator('[data-targetseg] [data-seg="classifiers"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-f="classifierName"]').fill('Phrase sentiment');
    await page.locator('[data-f="classifierName"]').blur();
    await expect(page.locator('#main')).toContainText('New draft classifier Phrase sentiment');
    await next(page).click();
    await page.locator('[data-start]').click();
    await toast(page, 'waits for the licence exception');
    await expect(page.locator('#main')).toContainText('waiting on licence');
    await page.locator('.tabs [data-tab="imports"]').click();
    await row(page, 'acme/phrasebank').click();
    await expect(page.locator('.inspector')).toContainText('waits for the legal-review role');
    // Whoever requested the import cannot decide its exception.
    await expect(page.locator('[data-decide]')).toHaveCount(0);
    await page.locator('[data-cancel]').click();
    await confirmDialog(page);
    await toast(page, 'cancelled');
    await expect(row(page, 'acme/phrasebank')).toContainText('cancelled');
  });

  for (const width of [320, 640]) {
    test(`every tab, the repository dialog and the log drawer reflow at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'import');
      const failures: string[] = [];
      for (const t of ['new', 'imports', 'repos']) {
        await page.locator(`.tabs [data-tab="${t}"]`).click();
        for (const p of await reflowProblems(page)) failures.push(`${t}: ${p}`);
      }
      await page.locator('[data-addrepo]').click();
      await expect(page.locator('#overlay .modal')).toBeVisible();
      for (const p of await reflowProblems(page)) failures.push(`add repository dialog: ${p}`);
      await page.locator('#overlay .modal [data-close]').first().click();
      await page.locator('.tabs [data-tab="imports"]').click();
      await page.locator('[data-log]').first().click();
      await expect(page.locator('#overlay .drawer')).toBeVisible();
      for (const p of await reflowProblems(page)) failures.push(`import log drawer: ${p}`);
      expect(failures).toEqual([]);
    });
  }

  test('every state of the board is reachable', async ({ page }) => {
    await open(page, 'import');
    const titles = await page.evaluate(() => (window as unknown as { App: { screens: Record<string, { states: { title: string }[] }> } }).App.screens.import.states.map((s) => s.title));
    expect(titles).toEqual(['Gated repository', 'Pickle refused', 'Licence outside policy', 'PII in the preview', 'Dataset over quota', 'Source rate limited', 'Air-gapped: joins the bundle', 'Knowledge set created']);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [i, title] of titles.entries()) {
        await page.evaluate((n) => (window as unknown as { App: { applyState(i: number): void } }).App.applyState(n), i);
        await expect(page.locator('#main')).toContainText('(Example.)');
        await expect(page.locator('#main')).toContainText(title === 'Pickle refused' ? 'Import refused: pickle checkpoint' : title);
      }
    }
  });
});
