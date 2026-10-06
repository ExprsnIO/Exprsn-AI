import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, open, ready, settle, expectLive, toast, confirmDialog, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

// 1.6.0, Sprint 35c: Storage (B-4204) and Configuration (B-4205) live, with their share of B-4207 (accessibility and
// reflow): axe-core and the in-page checker in Standard and Enhanced, light and dark, on every tab and design state,
// and reflow at 320 and 640 px for the screens and their dialogs.

type AppGlobal = { App: { screens: Record<string, { states?: unknown[] }>; applyState(i: number): void; closeOverlay(): void; setA11y(m: string | null): void; state: { screenState: Record<string, unknown>; route: string }; render(): void } };

async function checkAll(page: Page, where: string): Promise<void> {
  await expectAccessible(page, where);
  await expectAxeClean(page, 'aa', where);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y('aaa'));
  await expectAccessible(page, `${where}, Enhanced`);
  await expectAxeClean(page, 'aaa', `${where}, Enhanced`);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y('aa'));
}

/** Neither the page nor an open dialog scrolls sideways, and nothing in the dialog sticks out. */
function overlayProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const ov = document.querySelector('#overlay');
    const box = ov?.querySelector(':scope > .modal, :scope > .drawer') as HTMLElement | null;
    if (!ov || !box) return ['no dialog open'];
    if (document.scrollingElement!.scrollWidth > window.innerWidth + 1) out.push('the page scrolls sideways');
    if (ov.scrollWidth > ov.clientWidth + 1) out.push('the overlay scrolls sideways');
    if (box.scrollWidth > box.clientWidth + 1) out.push('the dialog scrolls sideways');
    if (box.getBoundingClientRect().right > window.innerWidth + 1) out.push('the dialog is wider than the window');
    for (const el of Array.from(box.querySelectorAll('*'))) {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
      if (el.closest('.tablewrap,.codebox,pre,textarea')) continue;
      if (el.getBoundingClientRect().right > Math.min(window.innerWidth, box.getBoundingClientRect().right) + 1) out.push(`${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 30)}" sticks out`);
    }
    return [...new Set(out)].slice(0, 8);
  });
}

/** Loads the page afresh at the address it is on (a goto to the same address changes nothing). */
async function reload(page: Page, route: string): Promise<void> {
  await page.reload();
  await ready(page, route);
}

const STORAGE_TABS = ['stores', 'usage', 'quarantine', 'integrity', 'purges'];

test.describe('Storage', () => {
  test('an orphan found by the integrity check is deleted from the screen after a dry run', async ({ page }) => {
    const key = `scratch/e2e/leftover-${Date.now()}.bin`;
    const file = path.join(serverState().blobDir, key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.alloc(4096, 1));
    const old = (Date.now() - 3 * 86_400_000) / 1000;
    utimesSync(file, old, old);

    await open(page, 'storage');
    await expectLive(page);
    await page.locator('[data-tab="integrity"]').click();
    await page.locator('#main .panel [data-runverify]').click();
    await page.locator('#overlay [data-vgo]').click();
    await toast(page, /Verification queued/);
    const row = page.locator('#main tr', { hasText: key });
    await expect(async () => {
      await page.locator('[data-tab="integrity"]').click();
      await expect(row).toContainText('orphan', { timeout: 1000 });
    }).toPass({ timeout: 30_000 });

    await page.locator('[data-delorphans]').click();
    await toast(page, /^Dry run: \d+ orphans?, .* would be deleted\. Nothing changed\./);
    await expect(page.locator('#main .notice', { hasText: 'Dry run:' })).toBeVisible();
    expect(existsSync(file)).toBe(true);
    await page.locator('[data-delorphans]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText(key);
    await modal.locator('[data-rok]').click();
    await expect(modal.locator('[data-rerr]')).toContainText('at least 3 characters');
    await modal.locator('[data-reason]').fill('left behind by the end-to-end suite');
    await modal.locator('[data-rok]').click();
    await toast(page, /orphans? deleted; .* freed\. Audit event platform\.blobs\.orphans\.deleted written\./);
    await expect(row).toContainText('orphan, deleted');
    expect(existsSync(file)).toBe(false);
  });

  test('shows the stores, usage, quarantine scanner and purge schedules from the server', async ({ page }) => {
    await open(page, 'storage');
    await expect(page.locator('#main table')).toContainText('Blob store');
    await expect(page.locator('#main table')).toContainText('Database');
    await expect(page.locator('#main .notice', { hasText: 'Filesystem store on one node' })).toBeVisible();
    await page.locator('tr[data-store="db"]').click();
    await expect(page.locator('aside.inspector')).toContainText('SQLite');
    await page.locator('[data-tab="usage"]').click();
    await expect(page.locator('#main')).toContainText(serverState().workspace.name);
    await page.locator('[data-usageby] [data-seg="kind"]').click();
    await expect(page.locator('#main table')).toContainText('Knowledge uploads');
    await page.locator('[data-tab="quarantine"]').click();
    await expect(page.locator('#main .panel', { hasText: 'Scanner' })).toContainText('CLAMD_HOST is unset');
    await page.locator('[data-tab="purges"]').click();
    await expect(page.locator('#main table')).toContainText('files.purge');
    await page.locator('#main a[data-purgewhere="0"]').click();
    await expect(page).toHaveURL(/#\/configuration\?q=FILES_TRASH_DAYS/);
    await expect(page.locator('aside.inspector')).toContainText('FILES_TRASH_DAYS');
  });
});

test.describe('Configuration', () => {
  test('an override applies only after a second platform admin approves', async ({ page, as, watch }) => {
    watch.allow.push(/POST \/api\/admin\/platform\/settings\/PLATFORM_BACKUP_RETAIN\/proposals -> 422/);
    await open(page, 'configuration?q=PLATFORM_BACKUP_RETAIN');
    await expectLive(page);
    const insp = page.locator('aside.inspector');
    await expect(insp).toContainText('PLATFORM_BACKUP_RETAIN');
    await expect(insp).toContainText('hot');
    await insp.locator('[data-propose]').click();
    const drawer = page.locator('#overlay .drawer');
    await drawer.locator('[data-ov-value]').fill('0');
    await drawer.locator('[data-ov-reason]').fill('the audit asks for three weeks');
    await drawer.locator('[data-ov-submit]').click();
    // The server checks the value against the configuration's schema before anything is proposed.
    await expect(drawer.locator('[data-ov-problem]')).toContainText('Value refused (422)');
    await drawer.locator('[data-ov-value]').fill('21');
    await drawer.locator('[data-ov-submit]').click();
    await toast(page, /proposed; waiting for a second platform admin/);
    await expect(page.locator('#main tr', { hasText: 'PLATFORM_BACKUP_RETAIN' })).toContainText('override pending');
    // The proposer can withdraw, not approve.
    await expect(insp.locator('[data-approve]')).toHaveCount(0);
    await expect(insp.locator('[data-withdraw]')).toBeVisible();
    await expect(insp).toContainText('14');

    const second = await as('root2');
    await open(second, 'configuration?q=PLATFORM_BACKUP_RETAIN');
    await second.locator('aside.inspector [data-approve]').click();
    await confirmDialog(second, 'Approve');
    await toast(second, /PLATFORM_BACKUP_RETAIN applied on every instance/);
    await expect(second.locator('#main tr', { hasText: 'PLATFORM_BACKUP_RETAIN' })).toContainText('override');

    await reload(page, 'configuration');
    await expect(insp).toContainText('21');
    await expect(insp.locator('.timeline')).toContainText('approved');

    // Put it back: removing the override is a proposal too, approved by the other admin.
    await insp.locator('[data-unset]').click();
    await drawer.locator('[data-ov-reason]').fill('back to the environment value');
    await drawer.locator('[data-ov-submit]').click();
    await toast(page, /Removal of the override of/);
    await reload(second, 'configuration');
    await second.locator('aside.inspector [data-approve]').click();
    await confirmDialog(second, 'Approve');
    await toast(second, /applied on every instance/);
    await reload(page, 'configuration');
    await expect(page.locator('#main tr', { hasText: 'PLATFORM_BACKUP_RETAIN' })).toContainText('default');
  });

  test('a secret shows its length and source, never its value; settings that reach the database are not overridable', async ({ page }) => {
    await open(page, 'configuration?q=SESSION_SECRET');
    const insp = page.locator('aside.inspector');
    await expect(insp).toContainText('set, 64 characters');
    await expect(insp).toContainText('never the value');
    await expect(insp.locator('[data-propose]')).toHaveCount(0);
    await expect(insp).toContainText('Not overridable here');
    await page.locator('[data-chip="secrets"]').click();
    await expect(page.locator('#main tbody tr').first()).toContainText(/set|unset/);
    await page.locator('[data-export]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('SESSION_SECRET=********');
    await modal.locator('[data-close]').first().click();
  });
});

test.describe('Storage and Configuration, accessibility and reflow (B-4207)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`every tab and design state passes axe-core and the in-page checks (${scheme})`, async ({ page, watch }) => {
      test.setTimeout(300_000);
      watch.allow.push(/ -> 404$/, / -> 409$/);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const tab of STORAGE_TABS) {
        await open(page, `storage?tab=${tab}`);
        await checkAll(page, `storage ${tab} (${scheme})`);
      }
      await open(page, 'configuration');
      await checkAll(page, `configuration (${scheme})`);
      for (const route of ['storage', 'configuration']) {
        await open(page, route);
        const n = await page.evaluate((r) => ((window as unknown as AppGlobal).App.screens[r]?.states ?? []).length, route);
        expect(n).toBe(5);
        for (let i = 0; i < n; i++) {
          await page.evaluate((k) => (window as unknown as AppGlobal).App.applyState(k), i);
          await page.waitForTimeout(250);
          await settle(page);
          await checkAll(page, `${route}, state ${i + 1} (${scheme})`);
          await page.evaluate((r) => { const { App } = window as unknown as AppGlobal; App.closeOverlay(); App.state.screenState[r] = {}; App.render(); }, route);
          await settle(page);
        }
      }
    });
  }

  for (const width of [320, 640]) {
    test(`the screens and their dialogs reflow at ${width} px`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 800 });
      const failures: string[] = [];
      for (const tab of STORAGE_TABS) {
        await open(page, `storage?tab=${tab}`);
        await page.waitForTimeout(250);
        for (const p of await reflowProblems(page)) failures.push(`storage ${tab}: ${p}`);
      }
      await open(page, 'configuration');
      await page.waitForTimeout(250);
      for (const p of await reflowProblems(page)) failures.push(`configuration: ${p}`);
      const dialogs: [string, string, string][] = [
        ['storage?tab=stores', '[data-migrate]', 'migrate'],
        ['storage?tab=integrity', '#main .panel [data-runverify]', 'verify'],
        ['storage?tab=usage', 'aside.inspector [data-quota]', 'quota'],
        ['configuration?q=PLATFORM_BACKUP_RETAIN', 'aside.inspector [data-propose]', 'propose override'],
        ['configuration', '[data-export]', 'export'],
        ['configuration', '[data-diff]', 'diff']
      ];
      for (const [route, button, name] of dialogs) {
        await open(page, route);
        await page.locator(button).first().click();
        await expect(page.locator('#overlay')).toBeVisible();
        for (const p of await overlayProblems(page)) failures.push(`${name} dialog: ${p}`);
        await page.evaluate(() => (window as unknown as AppGlobal).App.closeOverlay());
      }
      expect(failures).toEqual([]);
    });
  }
});
