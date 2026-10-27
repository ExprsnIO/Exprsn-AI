import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, confirmDialog, toast, apiAs } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.0, Sprint 54 (B-181, B-185, B-186): User stores › the store wizard, archive and restore, and backups. An identity
 * admin creates a store in steps from a preset (the forms are generated from the kind's schema), adds a group mapping,
 * puts it first in the sign-in order, tests it (unreachable here: no such database) and saves it; archives it (it
 * moves under Archived), restores it, saves a backup and previews its restore on the Backups tab. Accessibility in
 * Standard and Enhanced, light and dark, on each wizard step; no sideways scrolling at 320 and 640 px. The store is
 * removed afterwards.
 */

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };

async function accessible(page: Page, where: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expectAccessible(page, `${where} (${scheme})`);
    for (const mode of ['aa', 'aaa'] as const) {
      await page.evaluate((m) => (window as unknown as AppGlobal).App.setA11y(m), mode);
      await expectAxeClean(page, mode, `${where} (${scheme}, ${mode})`);
    }
    await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y(null));
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
}

/** Archive and restore need a recent sign-in: answer the step-up dialog when it comes. */
async function stepUpIfAsked(page: Page): Promise<void> {
  const dialog = page.locator('#overlay .modal', { hasText: 'Confirm it is you' });
  if (await dialog.isVisible({ timeout: 1500 }).catch(() => false)) {
    await dialog.locator('[data-supw]').fill(serverState().password);
    await dialog.locator('[data-sugo]').click();
  }
}

test.describe('User stores › store wizard, archive and backups', () => {
  const name = 'E2E wizard store ' + Date.now().toString(36);

  test.afterAll(async () => {
    const root = await apiAs('root');
    try {
      const stores = (await root.get('/api/admin/identity-providers')) as { id: string; name: string; state: string }[];
      const local = stores.find((s) => s.name === 'Local accounts');
      for (const s of stores.filter((x) => x.name.startsWith('E2E wizard store'))) {
        if (s.state === 'archived') await root.post(`/api/admin/identity-providers/${s.id}/restore`, { to: 'disabled' }).catch(() => undefined);
        await root.del(`/api/admin/identity-providers/${s.id}`).catch(() => undefined);
      }
      if (local) await root.put('/api/admin/identity-providers/order', { ids: (await root.get('/api/admin/identity-providers')).map((x: { id: string }) => x.id) }).catch(() => undefined);
      for (const b of (await root.get('/api/admin/identity-store-backups')).backups as { id: string; providerName: string }[]) if (b.providerName.startsWith('E2E wizard store')) await root.del(`/api/admin/identity-store-backups/${b.id}`).catch(() => undefined);
    } finally {
      await root.close();
    }
  });

  test('creates a store in steps, archives and restores it, and backs it up', async ({ page, watch }) => {
    // Archive and restore answer 401 step_up when the session's sign-in is not recent; the dialog handles it.
    watch.allow.push(/POST \/api\/admin\/identity-(providers\/[0-9A-Z]{26}\/(archive|restore)|store-backups\/restore) -> 401/);
    await open(page, 'directories');
    await expectLive(page);
    const main = page.locator('#main');
    await main.locator('[data-add]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Kind or preset');

    // Step 1: name and a preset.
    await modal.locator('[data-wname]').fill(name);
    await modal.locator('[data-wkind="sql"][data-wpreset="sqlite"]').click();
    await expect(modal.locator('[data-wkind="sql"][data-wpreset="sqlite"]')).toHaveAttribute('aria-pressed', 'true');
    await accessible(page, 'Store wizard › kind or preset');
    await reflow(page, 'Store wizard › kind or preset');
    await modal.locator('[data-wnext]').click();

    // Step 2: connection, filled from the preset; the secret is a reference.
    await expect(modal.locator('h3')).toHaveText('Connection');
    await expect(modal.locator('[data-cf="connection"]')).toHaveValue('file:/run/secrets/hr-sqlite-path');
    await modal.locator('[data-cf="table"]').fill('staff');
    await accessible(page, 'Store wizard › connection');
    await reflow(page, 'Store wizard › connection');
    await modal.locator('[data-wnext]').click();

    // Step 3: attributes and groups, with one mapping.
    await expect(modal.locator('h3')).toHaveText('Attributes and groups');
    await expect(modal.locator('[data-cf="columns.username"]')).toHaveValue('username');
    await modal.locator('[data-wmadd]').click();
    await modal.locator('[data-wmg]').fill('finance-ops');
    await accessible(page, 'Store wizard › attributes and groups');
    await modal.locator('[data-wnext]').click();

    // Step 4: sign-in order: the new store first.
    await expect(modal.locator('h3')).toHaveText('Sign-in order');
    const last = modal.locator('.stw-order li').last();
    await expect(last).toContainText('(new)');
    while (!(await modal.locator('.stw-order li').first().textContent())!.includes('(new)')) await modal.locator('.stw-order li', { hasText: '(new)' }).locator('[data-wup]').click();
    await modal.locator('[data-wnext]').click();

    // Step 5: the test with an account; there is no such database here, so it is unreachable.
    await expect(modal.locator('h3')).toHaveText('Test');
    await modal.locator('[data-wtu]').fill('jdoe');
    await modal.locator('[data-wtp]').fill('not kept anywhere');
    await modal.locator('[data-wtest]').click();
    await expect(modal).toContainText(/Result: (unreachable|error)/);
    await expect(modal.locator('[data-wtp]')).toHaveValue('');
    await accessible(page, 'Store wizard › test');
    await reflow(page, 'Store wizard › test');
    await modal.locator('[data-wnext]').click();

    // Step 6: review and save (disabled: it cannot connect).
    await expect(modal.locator('h3')).toHaveText('Review');
    await modal.locator('[data-wenable]').uncheck();
    await modal.locator('[data-wreason]').fill('E2E: the wizard');
    await accessible(page, 'Store wizard › review');
    await modal.locator('[data-wsave]').click();
    await toast(page, 'Store ' + name + ' added.');
    await expect(main.locator('tr[data-store]').first()).toContainText(name);

    // Versions in the form editor.
    await main.locator('tr[data-store]', { hasText: name }).click();
    await main.locator('[data-sversions]').click();
    await modal.locator('[data-seg="versions"]').click();
    await expect(modal).toContainText('Version 1');
    await expect(modal).toContainText('E2E: the wizard');
    await accessible(page, 'Store form editor › versions');
    await modal.locator('[data-close]').first().click();

    // Archive: it moves under Archived; restore puts it back as it was.
    await main.locator('[data-sarchive]').click();
    await confirmDialog(page, 'Archive');
    await stepUpIfAsked(page);
    await toast(page, name + ' archived.');
    await expect(main).toContainText('Archived');
    await main.locator('tr[data-store]', { hasText: name }).click();
    await expect(main.locator('aside.inspector')).toContainText('archived');
    await accessible(page, 'User stores › archived store');
    await reflow(page, 'User stores › archived store');
    await main.locator('[data-srestore]:not([data-srestore="disabled"])').click();
    await stepUpIfAsked(page);
    await toast(page, name + ' restored disabled.');

    // A backup saved to the blob store, and its restore previewed on the Backups tab.
    await main.locator('tr[data-store]', { hasText: name }).click();
    await main.locator('[data-sbackup]').click();
    await modal.locator('[data-bsave]').click();
    await toast(page, 'Backup saved.');
    await main.locator('[data-tab="backups"]').click();
    await expect(main.locator('tr', { hasText: name })).toBeVisible();
    await main.locator('tr', { hasText: name }).locator('[data-brestore]').click();
    await stepUpIfAsked(page);
    await expect(main).toContainText('Restore preview');
    await expect(main).toContainText('finance-ops');
    await accessible(page, 'User stores › backups');
    await reflow(page, 'User stores › backups');
    await main.locator('[data-bdiscard]').click();
    await expect(main).not.toContainText('Restore preview');
  });
});
