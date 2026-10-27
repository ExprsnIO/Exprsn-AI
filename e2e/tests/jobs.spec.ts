import { test, expect, open, expectLive, toast, settle, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

// 1.6.0 (B-4203, B-4207): Jobs and queues. A type paused and resumed from the screen, the jobs the other specs
// queued with their inspector, the dead letters and the tenant cache; every tab and design state free of axe and
// reflow findings.

type AppGlobal = { App: { screens: Record<string, { states?: unknown[] }>; applyState(i: number): void; closeOverlay(): void; setA11y(m: string | null): void } };

async function checkAll(page: Page, where: string): Promise<void> {
  await expectAccessible(page, where);
  await expectAxeClean(page, 'aa', where);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y('aaa'));
  await expectAccessible(page, `${where}, Enhanced`);
  await expectAxeClean(page, 'aaa', `${where}, Enhanced`);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y('aa'));
}

const TABS = ['queues', 'jobs', 'schedules', 'deadletters', 'cache'];

async function tab(page: Page, id: string): Promise<void> {
  await page.locator(`#main [role="tab"][data-tab="${id}"]`).click();
  await settle(page);
}

test.describe('Jobs and queues', () => {
  test('pauses a job type from the screen and resumes it', async ({ page }) => {
    await open(page, 'jobs');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('database polling');
    const row = page.locator('#main tr[data-type="pool.upgrade"]');
    await row.click();
    const insp = page.locator('#main aside.inspector');
    await expect(insp).toContainText('pool.upgrade');
    await insp.locator('[data-pausetype]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Pause pool.upgrade');
    await modal.locator('[data-reason]').fill('e2e: maintenance window');
    await modal.locator('[data-rok]').click();
    await toast(page, 'pool.upgrade paused. Audited jobs.type.paused.');
    await expect(row).toContainText('paused');
    await expect(insp).toContainText('e2e: maintenance window');
    await expect(page.locator('#main .toolbar')).toContainText('1 paused');

    await insp.locator('[data-resumetype]').click();
    await toast(page, /pool\.upgrade resumed/);
    await expect(row).toContainText('active');
  });

  test('lists jobs with payload keys only, and the cache, dead letters and schedules tabs', async ({ page }) => {
    await open(page, 'jobs?tab=jobs');
    await expect(page.locator('#main [role="tab"][data-tab="jobs"]')).toHaveAttribute('aria-selected', 'true');
    const rows = page.locator('#main tr[data-job]');
    if (await rows.count()) {
      await rows.first().click();
      await expect(page.locator('#main aside.inspector')).toContainText('Payload keys');
      await expect(page.locator('#main aside.inspector')).toContainText('Values are never shown here');
    }
    // Filter by state: every row shown is in that state.
    await page.locator('#main [data-jobstate]').selectOption('succeeded');
    await settle(page);
    for (const t of await page.locator('#main tr[data-job] .pill').allTextContents()) expect(t).toBe('succeeded');

    await tab(page, 'deadletters');
    await expect(page.locator('#main')).toContainText(/No dead letters|Redrive/);

    await tab(page, 'schedules');
    await expect(page.locator('#main')).toContainText(/No schedules here|scheduled/);

    await tab(page, 'cache');
    await expect(page.locator('#main')).toContainText('memory');
    await page.locator('#main tr[data-ns="plugins"] [data-invalidate]').click();
    await page.locator('#overlay .modal [data-ok]').click();
    await toast(page, 'plugins invalidated on every instance. Audited jobs.cache.invalidated.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`every tab and design state passes the WCAG checks and axe-core (${scheme})`, async ({ page, watch }) => {
      test.setTimeout(240_000);
      watch.allow.push(/ -> 404$/, / -> 409$/);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await open(page, 'jobs');
      for (const t of TABS) {
        await tab(page, t);
        await checkAll(page, `jobs, ${t} (${scheme})`);
      }
      const n = await page.evaluate(() => ((window as unknown as AppGlobal).App.screens.jobs?.states ?? []).length);
      expect(n).toBe(5);
      for (let i = 0; i < n; i++) {
        await page.evaluate((k) => (window as unknown as AppGlobal).App.applyState(k), i);
        await page.waitForTimeout(250);
        await settle(page);
        await checkAll(page, `jobs, state ${i + 1} of ${n} (${scheme})`);
      }
      // The pause dialog, with its reason field.
      await tab(page, 'queues');
      await page.locator('#main tr[data-type="pool.upgrade"]').click();
      await page.locator('#main aside.inspector [data-pausetype]').click();
      await expect(page.locator('#overlay .modal')).toBeVisible();
      await checkAll(page, `jobs, pause dialog (${scheme})`);
      await page.locator('#overlay .modal [data-close]').click();
    });
  }

  for (const width of [320, 640]) {
    test(`every tab reflows at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'jobs');
      const failures: string[] = [];
      for (const t of TABS) {
        await tab(page, t);
        await page.waitForTimeout(250);
        for (const p of await reflowProblems(page)) failures.push(`${t}: ${p}`);
      }
      await tab(page, 'queues');
      await page.locator('#main tr[data-type="pool.upgrade"]').click();
      await page.locator('#main aside.inspector [data-pausetype]').click();
      await expect(page.locator('#overlay .modal')).toBeVisible();
      for (const p of await reflowProblems(page)) failures.push(`pause dialog: ${p}`);
      expect(failures).toEqual([]);
    });
  }
});
