import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, confirmDialog, toast, apiAs } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.9-qa, Sprint QA-1 (Sprint 54 leftovers): User stores › Governance. Another identity admin (ops) proposes a
 * configuration change of a store; root sees it under Governance (dual control is on: the tenant has several identity
 * admins), approves it with a recent sign-in, sets a backup schedule and exports the store's users as CSV from the
 * store's panel, archives the store and is told when it can be purged. Accessibility in Standard and Enhanced, light
 * and dark; no sideways scrolling at 320 and 640 px.
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

async function stepUpIfAsked(page: Page): Promise<void> {
  const dialog = page.locator('#overlay .modal', { hasText: 'Confirm it is you' });
  if (await dialog.isVisible({ timeout: 1500 }).catch(() => false)) {
    await dialog.locator('[data-supw]').fill(serverState().password);
    await dialog.locator('[data-sugo]').click();
  }
}

test.describe('User stores › governance', () => {
  const name = 'E2E governance store ' + Date.now().toString(36);
  const SQL = { dialect: 'sqlite', connection: 'file:/run/secrets/hr-sqlite-path', table: 'staff', columns: { id: 'id', username: 'login', passwordHash: 'pw', displayName: 'full_name' } };
  let storeId = '';

  test.beforeAll(async () => {
    const ops = await apiAs('ops');
    try {
      storeId = (await ops.post('/api/admin/identity-providers', { name, kind: 'sql', position: 900, enabled: false, config: SQL })).id;
      const out = await ops.patch(`/api/admin/identity-providers/${storeId}`, { config: { ...SQL, defaultClearance: 'public' }, reason: 'e2e: default clearance' });
      expect(out.proposal).toMatchObject({ kind: 'store.config', state: 'pending' });
    } finally {
      await ops.close();
    }
  });

  test.afterAll(async () => {
    const ops = await apiAs('ops');
    try {
      for (const p of (await ops.get('/api/admin/identity-store-proposals?state=pending')) as { id: string; mine: boolean; name: string }[]) if (p.mine && p.name.startsWith('E2E governance store')) await ops.post(`/api/admin/identity-store-proposals/${p.id}/withdraw`).catch(() => undefined);
      if (storeId) await ops.del(`/api/admin/identity-providers/${storeId}/backup-schedule`).catch(() => undefined);
    } finally {
      await ops.close();
    }
  });

  test('approves another admin\'s change, schedules backups, exports users, and tells when an archived store can be purged', async ({ page, watch }) => {
    watch.allow.push(/POST \/api\/admin\/(identity-store-proposals\/[0-9A-Z]{26}\/approve|identity-providers\/[0-9A-Z]{26}\/(archive|purge)) -> (401|409)/);
    await open(page, 'directories?tab=governance');
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main).toContainText('Dual control is on');
    const row = main.locator('tr', { hasText: name });
    await expect(row).toContainText('Configuration change');
    await expect(row).toContainText('config.defaultClearance');
    await accessible(page, 'User stores › Governance');
    await reflow(page, 'User stores › Governance');

    await row.getByRole('button', { name: 'Approve' }).click();
    await confirmDialog(page, 'Approve');
    await stepUpIfAsked(page);
    await toast(page, 'Approved and applied');
    await expect(main.locator('tr', { hasText: name }).getByRole('button', { name: 'Approve' })).toHaveCount(0);

    // The store's panel: a backup schedule, and the users as CSV.
    await open(page, 'directories?tab=stores&store=' + storeId);
    const inspector = main.locator('aside.inspector');
    await expect(inspector).toContainText(name);
    await inspector.getByRole('button', { name: 'Backup schedule' }).click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Backups to keep');
    await accessible(page, 'Backup schedule dialog');
    await modal.locator('[data-schfreq]').selectOption('weekly');
    await modal.getByRole('button', { name: 'Save schedule' }).click();
    await toast(page, 'Backup schedule saved');

    await inspector.getByRole('button', { name: 'Export users (CSV)' }).click();
    const download = page.waitForEvent('download');
    await confirmDialog(page, 'Export CSV');
    expect((await download).suggestedFilename()).toMatch(/-users\.csv$/);
    await toast(page, 'Users exported');

    // Archived: the panel says from when it can be purged, and purging before then is refused with the date.
    await inspector.getByRole('button', { name: 'Archive' }).click();
    await confirmDialog(page, 'Archive');
    await stepUpIfAsked(page);
    await toast(page, 'archived');
    await main.locator('tr', { hasText: name }).click();
    await expect(inspector).toContainText('It can be purged from');
    await accessible(page, 'User stores › archived store with purge date');
    await inspector.getByRole('button', { name: 'Purge' }).click();
    await confirmDialog(page, 'Purge store');
    await stepUpIfAsked(page);
    await toast(page, /can be removed from/);
  });
});
