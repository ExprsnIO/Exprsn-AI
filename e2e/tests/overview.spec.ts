import { test, expect, open, expectLive, toast, settle, type Page } from './support/fixtures';
import { serverState } from './support/state';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

// 1.6.0 (B-4202, B-4207): the Overview. Draining an instance from the screen (with a confirm and, when the sign-in is
// old, a step-up), alerts acknowledged tenant-wide, and the screen and its design states free of axe and reflow
// findings. The e2e server runs a second instance registry (`e2e-peer:2`) so a drain does not stop this server's jobs.

type AppGlobal = { App: { screens: Record<string, { states?: unknown[] }>; applyState(i: number): void; closeOverlay(): void; setA11y(m: string | null): void; state: { screenState: Record<string, unknown> }; render(): void } };

async function checkAll(page: Page, where: string): Promise<void> {
  await expectAccessible(page, where);
  await expectAxeClean(page, 'aa', where);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y('aaa'));
  await expectAccessible(page, `${where}, Enhanced`);
  await expectAxeClean(page, 'aaa', `${where}, Enhanced`);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y('aa'));
}

/** Runs the console's step-up dialog when the server asks for a recent sign-in. */
async function stepUpIfAsked(page: Page): Promise<void> {
  const modal = page.locator('#overlay .modal');
  const asked = await modal.filter({ hasText: 'Confirm it is you' }).waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
  if (!asked) return;
  await modal.locator('[data-supw]').fill(serverState().password);
  await modal.locator('[data-sugo]').click();
}

test.describe('Overview', () => {
  test('lists the instances with their checks and drains one after a confirm', async ({ page, watch }) => {
    // The first drain attempt may answer 401 step_up when the session is older than the step-up window.
    watch.allow.push(/POST \/api\/admin\/overview\/instances\/.*\/drain -> 401$/);
    await open(page, 'overview');
    await expectLive(page);
    await expect(page.locator('#main h1')).toHaveText('Overview');
    const peer = page.locator('#main tr[data-inst="e2e-peer:2"]');
    await expect(peer).toBeVisible();
    await expect(page.locator('#main tr[data-inst]')).toHaveCount(2);
    await expect(page.locator('#main')).toContainText('Instances ready');

    await peer.click();
    const insp = page.locator('#main aside.inspector');
    await expect(insp).toContainText('/readyz checks');
    await expect(insp).toContainText('e2e-peer:2');
    await insp.locator('[data-drain]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Drain e2e-peer:2');
    await modal.locator('[data-ok]').click();
    await stepUpIfAsked(page);
    await toast(page, /e2e-peer:2 is draining.*Audit event written/);
    await expect(peer).toContainText('draining');
    await expect(page.locator('#main aside.inspector [data-drain]')).toBeDisabled();

    // The drain is in the audit chain.
    await open(page, 'overview');
    await expect(page.locator('#main')).toContainText('platform.instance.drained');
  });

  test('acknowledges an open alert for the tenant, or shows that none is open', async ({ page }) => {
    await open(page, 'overview');
    const ack = page.locator('#main [data-ack]');
    if (await ack.count()) {
      const n = await ack.count();
      await ack.first().click();
      await page.locator('#overlay .modal [data-ok]').click();
      await toast(page, 'Alert acknowledged. Audit event written.');
      await expect(page.locator('#main [data-ack]')).toHaveCount(n - 1);
    } else {
      await expect(page.locator('#main')).toContainText('No open alerts');
      await expect(page.locator('#main [data-ackall]')).toBeDisabled();
    }
    // The window segment reloads the counters.
    await page.locator('#main [data-window] [data-seg="7d"]').click();
    await settle(page);
    await expect(page.locator('#main')).toContainText('The last 7 days');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the screen and its design states pass the WCAG checks and axe-core (${scheme})`, async ({ page, watch }) => {
      test.setTimeout(180_000);
      watch.allow.push(/ -> 404$/, / -> 409$/);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await open(page, 'overview');
      await page.locator('#main tr[data-inst]').first().click();
      await checkAll(page, `overview (${scheme})`);
      const n = await page.evaluate(() => ((window as unknown as AppGlobal).App.screens.overview?.states ?? []).length);
      expect(n).toBe(5);
      for (let i = 0; i < n; i++) {
        await page.evaluate((k) => (window as unknown as AppGlobal).App.applyState(k), i);
        await page.waitForTimeout(250);
        await settle(page);
        await checkAll(page, `overview, state ${i + 1} of ${n} (${scheme})`);
        await page.evaluate(() => { const { App } = window as unknown as AppGlobal; App.closeOverlay(); });
      }
    });
  }

  for (const width of [320, 640]) {
    test(`reflows at ${width} px, with the drain dialog open too`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'overview');
      await page.waitForTimeout(250);
      expect(await reflowProblems(page)).toEqual([]);
      await page.locator('#main tr[data-inst]').first().click();
      await page.waitForTimeout(250);
      expect(await reflowProblems(page)).toEqual([]);
      // The drain dialog (cancelled), then the tenant admin view (a design state).
      await page.locator('#main tr[data-inst]').first().click();
      await page.locator('#main aside.inspector [data-drain]').click();
      await expect(page.locator('#overlay .modal')).toBeVisible();
      expect(await reflowProblems(page)).toEqual([]);
      await page.locator('#overlay .modal [data-close]').click();
      await page.evaluate(() => (window as unknown as AppGlobal).App.applyState(4));
      await page.waitForTimeout(250);
      expect(await reflowProblems(page)).toEqual([]);
    });
  }
});
