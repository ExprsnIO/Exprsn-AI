import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.9.0, Sprint 49 (B-150, B-153, B-154): Settings › Devices (list, rename, revoke, last seen, platform) and
 * Settings › Notifications (the kinds × channels table with named checkboxes and "when" selects, mandatory kinds
 * locked, quiet hours per weekday and the time zone), and the tenant's defaults under Tenants › Notifications.
 * Axe-clean in Standard and Enhanced, light and dark, and reflowing at 320 and 640 px.
 */

const modal = (page: Page) => page.locator('#overlay .modal');

async function checkAll(page: Page, where: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const mode of ['aa', 'aaa'] as const) {
      await page.evaluate((m) => (window as unknown as { App: { setA11y(x: string): void } }).App.setA11y(m), mode);
      await expectAccessible(page, `${where} (${scheme}, ${mode})`);
      await expectAxeClean(page, mode, `${where} (${scheme}, ${mode})`);
    }
  }
  await page.evaluate(() => (window as unknown as { App: { setA11y(x: string): void } }).App.setA11y('aa'));
  await page.emulateMedia({ colorScheme: 'light' });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Settings: devices and notifications', () => {
  test.use({ user: 'member' });

  test('lists, renames and revokes a device; never shows its token', async ({ page }) => {
    test.setTimeout(120_000);
    const member = await apiAs('member');
    const token = 'e2e-fcm-token-' + Date.now().toString(36);
    const dev = await member.post('/api/me/devices', { platform: 'android', provider: 'fcm', appId: 'net.exprsn.e2e', name: 'E2E phone', token });
    try {
      await open(page, 'settings?tab=security');
      await expectLive(page);
      const panel = page.locator('#main [data-settings-devices]');
      await expect(panel).toContainText('E2E phone');
      await expect(panel).toContainText(dev.fingerprint);
      await expect(panel).toContainText('Android');
      await expect(panel).toContainText('Google (FCM)');
      await expect(page.locator('#main')).not.toContainText(token);
      await checkAll(page, 'Settings with devices');
      await reflow(page, 'Settings with devices');

      await panel.getByRole('button', { name: 'Rename E2E phone' }).click();
      await modal(page).locator('[data-sdname]').fill('E2E tablet');
      await modal(page).getByRole('button', { name: 'Rename', exact: true }).click();
      await toast(page, 'Device renamed.');
      await expect(panel).toContainText('E2E tablet');

      await panel.getByRole('button', { name: 'Revoke E2E tablet' }).click();
      await confirmDialog(page, 'Revoke');
      await toast(page, 'E2E tablet revoked.');
      await expect(panel.locator(`[data-sdrow="${dev.id}"]`)).toContainText('revoked');
    } finally {
      await member.del(`/api/me/devices/${dev.id}`).catch(() => undefined);
      await member.close();
    }
  });

  test('chooses channels and timing per kind, quiet hours and a time zone; mandatory kinds are locked', async ({ page }) => {
    test.setTimeout(120_000);
    const member = await apiAs('member');
    try {
      await open(page, 'settings?tab=preferences');
      await expectLive(page);
      const panel = page.locator('#main [data-settings-notifications]');
      const table = panel.getByRole('table', { name: /kinds by channel/ });
      await expect(table).toBeVisible();
      // Headers: one per channel; a row header per kind.
      for (const ch of ['In the app', 'Email', 'Push', 'Live (WebSocket)']) await expect(table.getByRole('columnheader', { name: ch, exact: true })).toBeVisible();
      await expect(table.getByRole('rowheader', { name: /Security alerts/ })).toBeVisible();
      // Security alerts are locked, with the reason.
      const secPush = table.getByRole('checkbox', { name: 'Push for Security alerts' });
      await expect(secPush).toBeChecked();
      await expect(secPush).toBeDisabled();
      await expect(panel).toContainText('Nobody can turn them off');

      await table.getByRole('checkbox', { name: 'Push for Workflows' }).uncheck();
      await table.getByRole('combobox', { name: 'Email timing for Workflows' }).selectOption('daily');
      await panel.getByRole('checkbox', { name: 'Quiet hours on Saturday' }).check();
      await panel.getByLabel('Saturday, quiet from').fill('22:30');
      await panel.getByLabel('Saturday, quiet until').fill('07:15');
      await panel.getByLabel('Time zone').selectOption('Europe/Lisbon');
      await checkAll(page, 'Settings › Notifications with changes');
      await reflow(page, 'Settings › Notifications');
      await panel.getByRole('button', { name: 'Save notification settings' }).click();
      await toast(page, 'Notification settings saved.');

      const saved = await member.get('/api/me/notification-preferences');
      expect(saved.timeZone).toBe('Europe/Lisbon');
      expect(saved.quietHours.sat).toEqual({ start: '22:30', end: '07:15' });
      const wf = saved.kinds.find((k: { id: string }) => k.id === 'workflow');
      expect(wf.channels.push).toMatchObject({ enabled: false, source: 'you' });
      expect(wf.channels.email).toMatchObject({ enabled: true, timing: 'daily', source: 'you' });
      await expect(table.getByRole('checkbox', { name: 'Push for Workflows' })).not.toBeChecked();

      await panel.getByRole('button', { name: 'Back to the defaults' }).click();
      await confirmDialog(page, 'Use the defaults');
      await toast(page, 'Back to the defaults.');
      expect((await member.get('/api/me/notification-preferences')).saved).toBe(false);
    } finally {
      await member.del('/api/me/notification-preferences').catch(() => undefined);
      await member.close();
    }
  });
});

test.describe('Tenants: notification defaults', () => {
  test.use({ user: 'root' });

  test('a tenant admin makes a kind mandatory, which shows locked to people', async ({ page }) => {
    test.setTimeout(120_000);
    const root = await apiAs('root');
    const member = await apiAs('member');
    try {
      await open(page, 'tenants');
      await expectLive(page);
      await page.locator('#main .listlink').filter({ hasText: 'Default' }).filter({ hasText: 'tenant' }).first().click();
      await page.locator('#main [data-ttab="notifications"]').click();
      const panel = page.locator('#main [data-tenant-notifications]');
      await expect(panel).toBeVisible();
      const table = panel.getByRole('table', { name: /Tenant defaults/ });
      await expect(table.getByRole('checkbox', { name: 'Mandatory for Security alerts' })).toBeDisabled();
      await checkAll(page, 'Tenants › Notifications');
      await reflow(page, 'Tenants › Notifications');
      await table.getByRole('checkbox', { name: 'Mandatory for Workflows' }).check();
      await panel.getByRole('button', { name: 'Save defaults' }).click();
      await confirmDialog(page, 'Make mandatory');
      await toast(page, 'Defaults saved.');
      const wf = (await member.get('/api/me/notification-preferences')).kinds.find((k: { id: string }) => k.id === 'workflow');
      expect(wf).toMatchObject({ mandatory: true, lockedBy: 'tenant' });
    } finally {
      await root.put('/api/admin/notification-defaults', { kinds: { workflow: null } }).catch(() => undefined);
      await root.close();
      await member.close();
    }
  });
});
