import { test, expect, open, expectLive, toast, confirmDialog } from './support/fixtures';
import type { Page } from '@playwright/test';

async function newWorkflow(page: Page, name: string, desc: string): Promise<void> {
  const first = page.locator('[data-new]').first();
  if (await first.count()) await first.click();
  else await page.locator('[data-wf]').selectOption('__new');
  const modal = page.locator('#overlay .modal');
  await modal.locator('[data-name]').fill(name);
  await modal.locator('[data-desc]').fill(desc);
  await modal.locator('[data-go]').click();
  await toast(page, `${name} created as a draft with a manual trigger`);
}

/** A select or input in the inspector bound to a config key; changes go through the server's validation. */
const cfg = (page: Page, key: string) => page.locator(`.inspector [data-c="${key}"]`);

test.describe('Workflows', () => {
  test('creates a workflow, publishes it and runs the published version', async ({ page }) => {
    await open(page, 'workflows');
    await expectLive(page);
    await newWorkflow(page, 'expense-notes', 'Turns an expense claim into notes for the controller');

    await page.locator('.wf-toolbar [data-publish]').click();
    await confirmDialog(page, 'Publish');
    await toast(page, 'expense-notes v1 published');

    await page.locator('.wf-toolbar [data-startrun]').click();
    const run = page.locator('#overlay .modal');
    await expect(run).toContainText('Start a run of v1');
    await run.locator('[data-go]').click();
    await toast(page, /Run .* started/);
    await expect(page.locator('#main tr', { hasText: 'manual, Mara Okafor' }).first()).toContainText('succeeded', { timeout: 20_000 });
  });

  test('B-3910: event triggers, Workflows 2 steps, failure edges, callers, versions, bundles and dead letters', async ({ page, watch }) => {
    // A tampered bundle is refused by the server; the dialog shows why.
    watch.allow.push(/POST \/api\/workflows\/import -> 422$/);
    await open(page, 'workflows');
    await expectLive(page);

    // The callee: started by a catalogue event once published.
    await newWorkflow(page, 'wf2-intake', 'Files a note when a document is uploaded');
    await page.locator('.wf-node[data-node="trigger"]').click();
    await cfg(page, 'source').selectOption('event');
    await cfg(page, 'event').selectOption('file.uploaded');
    await expect(page.locator('.wf-node[data-node="trigger"]')).toContainText('event file.uploaded');
    await page.locator('.wf-toolbar [data-publish]').click();
    await confirmDialog(page, 'Publish');
    await toast(page, 'wf2-intake v1 published');

    await page.locator('.wf-lower [data-tab="callers"]').click();
    const own = page.locator('.wf-lower .panel', { hasText: 'Own trigger' });
    await expect(own).toContainText('file.uploaded');
    await expect(own).toContainText('enabled');
    await own.locator('[data-trigtoggle]').click();
    await toast(page, 'Trigger turned off');
    await expect(page.locator('.wf-lower .panel', { hasText: 'Own trigger' })).toContainText('off');
    await page.locator('.wf-lower [data-trigtoggle]').click();
    await toast(page, 'Trigger on again');

    // The caller: a sub-workflow step, a notice on its failure edge with a retry, a map over a list.
    await newWorkflow(page, 'wf2-parent', 'Runs the intake as a sub-workflow and tells the admins when it fails');
    await page.locator('.wf-palette [data-add="sub"]').click();
    await cfg(page, 'workflow').selectOption('wf2-intake');
    await expect(page.locator('.wf-node[data-node="sub1"]')).toContainText('workflow wf2-intake');
    await page.locator('.wf-palette [data-add="notify"]').click();
    await cfg(page, 'title').fill('The intake failed: {{steps.sub1.error}}');
    await cfg(page, 'title').blur();
    await page.locator('.inspector [data-retry="max"]').selectOption('2');
    await expect(page.locator('.inspector')).toContainText('This step writes: a retry may write twice.');

    // Re-wire: the notice runs on the sub-workflow's failure edge, not after it.
    await page.locator('.wf-node[data-node="sub1"]').click();
    await page.locator('.inspector [data-unlink="notify1"]').click();
    await page.locator('.inspector [data-connectfail]').click();
    await page.locator('.wf-node[data-node="notify1"]').click();
    await toast(page, 'Connected on failure');
    await expect(page.locator('.inspector')).toContainText('on failure');

    await page.locator('.wf-node[data-node="trigger"]').click();
    await page.locator('.wf-palette [data-add="map"]').click();
    await expect(page.locator('.inspector')).toContainText('Each item runs');
    await page.locator('.wf-toolbar [data-save]').click();
    await toast(page, /Draft saved as revision/);

    // The callee now lists the parent among its callers.
    await page.locator('[data-wf]').selectOption({ label: 'wf2-intake v1 published' });
    await page.locator('.wf-lower [data-tab="callers"]').click();
    await expect(page.locator('.wf-lower tr', { hasText: 'sub-workflow step' })).toContainText('wf2-parent');

    // Versions: export the signed bundle, and a tampered one is refused on import.
    await page.locator('.wf-lower [data-tab="versions"]').click();
    await page.locator('.wf-lower [data-export]').click();
    const exp = page.locator('#overlay .modal');
    await expect(exp).toContainText('exprsn-workflow/1');
    await exp.locator('[data-close]').first().click();
    const bundle = (await page.evaluate(() => (window as unknown as { App: { get(u: string): Promise<unknown> } }).App.get('/api/workflows/wf2-intake/bundle'))) as { workflow: { description: string | null } };
    bundle.workflow.description = 'changed after signing';
    await page.locator('.wf-lower [data-import]').click();
    const imp = page.locator('#overlay .modal');
    await imp.locator('[data-ib]').fill(JSON.stringify(bundle));
    await imp.locator('[data-ibname]').fill('wf2-tampered');
    await imp.locator('[data-ibgo]').click();
    await expect(imp.locator('[data-iberr]')).toContainText('422');
    await imp.locator('[data-close]').first().click();

    // Dead letters and the approvals across workflows.
    await page.locator('.wf-lower [data-tab="dead"]').click();
    await expect(page.locator('.wf-lower')).toContainText('No dead letters');
    await page.locator('.wf-lower [data-tab="approvals"]').click();
    await expect(page.locator('.wf-lower')).toContainText(/Nothing waits on you|Approve/);
  });
});
