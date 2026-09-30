import { test, expect, open, expectLive, toast } from './support/fixtures';

test.describe('Scripts', () => {
  test('creates a script draft that passes its checks and runs it in the sandbox', async ({ page }) => {
    await open(page, 'scripts');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('fake answering');
    await page.locator('[data-new]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-lang]').selectOption('python');
    await modal.locator('[data-name]').fill('totals.py');
    await modal.locator('[data-src]').fill('import json, sys\nrows = json.load(sys.stdin) if not sys.stdin.isatty() else []\nprint("hello from the sandbox")\n');
    await modal.locator('[data-ok]').click();
    await toast(page, 'Draft totals.py created. Its checks ran.');
    await expect(page.locator('#main h1')).toContainText('totals.py');

    await page.locator('[data-runonce]').click();
    // The fake sandbox answers; the run and its stdout show on the screen.
    await expect(page.locator('#main')).toContainText('hello from the fake sandbox', { timeout: 20_000 });
  });
});
