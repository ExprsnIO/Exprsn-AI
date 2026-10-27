import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page, type Locator } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.9.0: the Settings › Notifications table (titles that wrap and are never cut off, groups that collapse by mouse
 * and keyboard, Enable all and Disable all for the table, a group and a channel, which change the form only and leave
 * mandatory kinds alone, saying so; the person still customises single cells and saves), the same table for the
 * tenant's defaults, and notification templates in Tenants › Notifications: made in the editor, applied to a person
 * with a preview, and shown to that person as "Based on template". Axe-clean in Standard and Enhanced, light and dark,
 * and reflowing at 320 and 640 px.
 */

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

/** Kind titles and descriptions that are cut off (their text wider than their box). */
function cutOff(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => Array.from(root.querySelectorAll('.sn-title,.sn-desc'))
    .filter((el) => (el as HTMLElement).offsetParent && el.scrollWidth > el.clientWidth + 1)
    .map((el) => `${(el.textContent ?? '').trim().slice(0, 40)} (${el.scrollWidth} > ${el.clientWidth})`));
}

async function reflowAndWrap(page: Page, scope: Locator, where: string): Promise<void> {
  expect(await cutOff(scope), `${where} at 1440 px`).toEqual([]);
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
    expect(await cutOff(scope), `${where} cut off at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Settings: the notifications table', () => {
  test.use({ user: 'member' });

  test('wraps titles, collapses groups by keyboard, and bulk changes stay in the form until saved', async ({ page }) => {
    test.setTimeout(150_000);
    const member = await apiAs('member');
    await member.del('/api/me/notification-preferences').catch(() => undefined);
    // Every kind but Security alerts (mandatory), counted from the catalogue so a new kind does not break the counts.
    const unlockedKinds = ((await member.get('/api/me/notification-preferences')).kinds as unknown[]).length - 1;
    try {
      await open(page, 'settings?tab=preferences');
      await expectLive(page);
      const panel = page.locator('#main [data-settings-notifications]');
      const table = panel.getByRole('table', { name: /kinds by channel/ });
      await expect(table).toBeVisible();
      await reflowAndWrap(page, panel, 'Settings › Notifications');

      // Disclosures: a button per group with aria-expanded; the mouse and the keyboard both work.
      const admin = table.getByRole('button', { name: /^Administration/ });
      await expect(admin).toHaveAttribute('aria-expanded', 'true');
      await admin.click();
      await expect(admin).toHaveAttribute('aria-expanded', 'false');
      await expect(table.getByRole('rowheader', { name: /Sign-ups waiting for approval/ })).toBeHidden();
      const work = table.getByRole('button', { name: /^Your work/ });
      await work.focus();
      await page.keyboard.press('Enter');
      await expect(work).toHaveAttribute('aria-expanded', 'false');
      await expect(table.getByRole('checkbox', { name: 'Push for Workflows' })).toBeHidden();
      await page.keyboard.press('Space');
      await expect(work).toHaveAttribute('aria-expanded', 'true');
      await expect(table.getByRole('checkbox', { name: 'Push for Workflows' })).toBeVisible();
      await panel.getByRole('button', { name: 'Collapse all', exact: true }).click();
      for (const g of ['Account and security', 'Your work', 'People and groups', 'Administration', 'Platform']) await expect(table.getByRole('button', { name: new RegExp('^' + g) })).toHaveAttribute('aria-expanded', 'false');
      await panel.getByRole('button', { name: 'Expand all', exact: true }).click();
      await expect(admin).toHaveAttribute('aria-expanded', 'true');

      // Disable all: every kind but the mandatory one, said politely; nothing saved yet.
      const status = panel.locator('[data-snlive="p"]');
      await expect(status).toHaveAttribute('role', 'status');
      await panel.getByRole('button', { name: 'Disable all', exact: true }).click();
      await expect(status).toContainText(`${unlockedKinds} kinds turned off; Security alerts is mandatory and stays on.`);
      await expect(table.getByRole('checkbox', { name: 'Push for Workflows' })).not.toBeChecked();
      await expect(table.getByRole('checkbox', { name: 'Email for Messages' })).not.toBeChecked();
      await expect(table.getByRole('checkbox', { name: 'Push for Security alerts' })).toBeChecked();
      await expect(table.getByRole('combobox', { name: 'Push timing for Workflows' })).toBeDisabled();
      await expect(panel.locator('[data-sndirty]')).toHaveText('Unsaved changes');
      expect((await member.get('/api/me/notification-preferences')).saved).toBe(false);

      // Per group, then per channel.
      await table.getByRole('button', { name: 'Enable all: Your work' }).click();
      await expect(status).toContainText('Your work: 11 kinds turned on');
      await expect(table.getByRole('checkbox', { name: 'Push for Workflows' })).toBeChecked();
      await expect(table.getByRole('checkbox', { name: 'Push for Messages' })).not.toBeChecked();
      await panel.getByRole('button', { name: 'Enable all: Email' }).click();
      await expect(status).toContainText(`Email turned on for ${unlockedKinds} kinds`);
      await expect(table.getByRole('checkbox', { name: 'Email for Messages' })).toBeChecked();
      await expect(table.getByRole('checkbox', { name: 'Push for Messages' })).not.toBeChecked();

      // Single cells still work after a bulk action.
      await table.getByRole('checkbox', { name: 'Push for Messages' }).check();
      await table.getByRole('combobox', { name: 'Push timing for Messages' }).selectOption('hourly');
      await table.getByRole('checkbox', { name: 'Email for Feed' }).uncheck();
      await checkAll(page, 'Settings › Notifications after bulk changes');
      await panel.getByRole('button', { name: 'Save notification settings' }).click();
      await toast(page, 'Notification settings saved.');

      const saved = await member.get('/api/me/notification-preferences');
      const k = (id: string) => saved.kinds.find((x: { id: string }) => x.id === id);
      expect(k('message').channels.push).toMatchObject({ enabled: true, timing: 'hourly', source: 'you' });
      expect(k('message').channels.in_app).toMatchObject({ enabled: false, source: 'you' });
      // Off and on again is what was loaded, so it is not saved as a choice.
      expect(k('workflow').channels.push).toMatchObject({ enabled: true, source: 'default' });
      expect(k('feed').channels.email).toMatchObject({ enabled: false, source: 'you' });
      expect(k('chat').channels.email).toMatchObject({ enabled: true });
      expect(k('security').channels.push).toMatchObject({ enabled: true, source: 'mandatory' });
    } finally {
      await member.del('/api/me/notification-preferences').catch(() => undefined);
      await member.close();
    }
  });
});

test.describe('Tenants: notification templates', () => {
  test.use({ user: 'root' });

  test('makes a template, applies it to a person with a preview, and the person sees where their settings came from', async ({ page }) => {
    test.setTimeout(180_000);
    const root = await apiAs('root');
    const member = await apiAs('member');
    // Every kind but Security alerts (mandatory), counted from the catalogue so a new kind does not break the counts.
    const unlockedKinds = ((await member.get('/api/me/notification-preferences')).kinds as unknown[]).length - 1;
    const name = 'E2E focus ' + Date.now().toString(36);
    let id: string | null = null;
    await member.del('/api/me/notification-preferences').catch(() => undefined);
    try {
      await open(page, 'tenants');
      await expectLive(page);
      await page.locator('#main .listlink').filter({ hasText: 'Default' }).filter({ hasText: 'tenant' }).first().click();
      await page.locator('#main [data-ttab="notifications"]').click();
      const defaults = page.locator('#main [data-tenant-notifications]');
      await expect(defaults.getByRole('table', { name: /Tenant defaults/ })).toBeVisible();
      const templates = page.locator('#main [data-tenant-templates]');
      await expect(templates).toBeVisible();

      // The defaults table: no cut-off text, and the same disclosures and bulk tools.
      await expect(defaults.getByRole('button', { name: /^Platform/ })).toHaveAttribute('aria-expanded', 'true');
      await defaults.getByRole('button', { name: 'Disable all: Push' }).click();
      await expect(defaults.locator('[data-snlive="t"]')).toContainText(`Push turned off for ${unlockedKinds} kinds; Security alerts is mandatory and stays on.`);
      await expect(defaults.getByRole('checkbox', { name: 'Push for Messages' })).not.toBeChecked();
      await expect(defaults.locator('[data-tndirty]')).toHaveText('Unsaved changes');

      // A new template in the editor.
      await templates.getByRole('button', { name: 'New template' }).click();
      const editor = page.locator('#main [data-template-editor]');
      await expect(editor).toBeVisible();
      await editor.getByLabel('Name').fill(name);
      await editor.getByLabel('Description').fill('Quiet evenings');
      const etable = editor.getByRole('table', { name: /Template: notification kinds/ });
      await expect(etable.getByRole('checkbox', { name: 'Push for Security alerts' })).toBeDisabled();
      await etable.getByRole('button', { name: 'Disable all: People and groups' }).click();
      await expect(editor.locator('[data-snlive="x"]')).toContainText('People and groups: 7 kinds turned off. Save the template to keep the change.');
      await etable.getByRole('checkbox', { name: 'Push for Messages' }).check();
      await editor.getByRole('checkbox', { name: 'Quiet hours on Friday' }).check();
      await editor.getByLabel('Daily and weekly digests at').selectOption('9');
      await checkAll(page, 'Tenants › Notifications with the template editor');
      await reflowAndWrap(page, page.locator('#main'), 'Tenants › Notifications with the template editor');
      await editor.getByRole('button', { name: 'Save template' }).click();
      await toast(page, 'Template saved.');
      await expect(templates).toContainText(name + ' saved as version 1.');
      const listed = (await root.get('/api/admin/notification-templates')).templates.find((t: { name: string }) => t.name === name);
      id = listed.id;
      expect(listed).toMatchObject({ version: 1, description: 'Quiet evenings', digestHour: 9, quietHours: { fri: { start: '22:00', end: '07:00' } } });
      expect(listed.kinds.feed.push).toEqual({ enabled: false, timing: 'instant' });
      expect(listed.kinds.message.push).toEqual({ enabled: true, timing: 'instant' });
      expect(listed.kinds.security).toBeUndefined();

      // Apply it to the member: preview first, then replace.
      await templates.getByRole('button', { name: 'Apply ' + name }).click();
      const dialog = page.locator('#overlay .modal');
      await dialog.getByLabel('Usernames').fill('member');
      await dialog.getByRole('radio', { name: /Replace/ }).check();
      await dialog.getByRole('button', { name: 'Preview' }).click();
      await expect(dialog.locator('[data-apres]')).toContainText('Would reach 1 person');
      await checkAll(page, 'Apply a notification template');
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await toast(page, 'Template applied.');
      await expect(templates).toContainText('Applied to 1 person');

      const mine = await member.get('/api/me/notification-preferences');
      expect(mine.template).toMatchObject({ name, version: 1, mode: 'replace', changedKinds: 0 });
      expect(mine.kinds.find((x: { id: string }) => x.id === 'feed').channels.push).toMatchObject({ enabled: false, source: 'you' });
      expect(mine.digestHour).toBe(9);

      // Deleting it leaves the member's settings alone.
      await templates.getByRole('button', { name: 'Delete ' + name }).click();
      await confirmDialog(page, 'Delete');
      await toast(page, 'deleted.');
      id = null;
      const after = await member.get('/api/me/notification-preferences');
      expect(after.template).toBeNull();
      expect(after.kinds.find((x: { id: string }) => x.id === 'feed').channels.push).toMatchObject({ enabled: false, source: 'you' });
    } finally {
      if (id) await root.del(`/api/admin/notification-templates/${id}`).catch(() => undefined);
      await member.del('/api/me/notification-preferences').catch(() => undefined);
      await root.close();
      await member.close();
    }
  });
});

test.describe('Settings: based on a template', () => {
  test.use({ user: 'member' });

  test('says which template the settings came from and how many kinds were changed since', async ({ page }) => {
    test.setTimeout(120_000);
    const root = await apiAs('root');
    const member = await apiAs('member');
    let id: string | null = null;
    try {
      const t = await root.post('/api/admin/notification-templates', { name: 'E2E based ' + Date.now().toString(36), kinds: { feed: { email: { enabled: false, timing: 'instant' } } } });
      id = t.id;
      await root.post(`/api/admin/notification-templates/${t.id}/apply`, { mode: 'replace', target: { kind: 'users', usernames: ['member'] } });
      await member.put('/api/me/notification-preferences', { kinds: { chat: { push: { enabled: false, timing: 'instant' } } } });
      await open(page, 'settings?tab=preferences');
      await expectLive(page);
      const panel = page.locator('#main [data-settings-notifications]');
      await expect(panel).toContainText(`Based on template ${t.name}, version 1. You changed 1 kind since.`);
      await checkAll(page, 'Settings › Notifications based on a template');
    } finally {
      if (id) await root.del(`/api/admin/notification-templates/${id}`).catch(() => undefined);
      await member.del('/api/me/notification-preferences').catch(() => undefined);
      await root.close();
      await member.close();
    }
  });
});
