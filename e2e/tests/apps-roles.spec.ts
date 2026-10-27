import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.8.0, Sprint 48 (B-143): app-local roles. A designer adds a role on the Roles tab, a policy names it, the tab says
 * what the role can do, the designer gives it to a person found with the picker, and that person's Records tab shows
 * what the policy allows; explain names the role. Axe (AA) and reflow at 320 and 640 px.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(350);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
}

test.describe('Apps: roles', () => {
  test('a role is added, named by a policy, given to a person, and decides what they read', async ({ page, as }) => {
    const id = uniq();
    const appName = `claims_${id}`;
    const title = `Claims ${id}`;
    const root = await apiAs('root');
    const ws = (await root.get('/api/me')).workspaces[0];
    await root.post('/api/apps', { name: appName, title, label: 'internal', workspaceId: ws.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'claim', title: 'Claim', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 }, { name: 'amount', type: 'number', indexed: true, min: 0 }] } });
    for (const [t, amount] of [['Small claim', 50], ['Large claim', 5000]] as const) await root.post(`/api/apps/${appName}/entities/claim/records`, { values: { title: t, amount } });

    // The designer adds the role on the Roles tab.
    await open(page, 'apps');
    await expectLive(page);
    await page.locator('#main .leftpane [data-app]', { hasText: title }).click();
    await page.locator('[data-tab="roles"]').click();
    await expect(page.locator('#main')).toContainText('No roles yet');
    await page.locator('[data-ar-new]').click();
    await modal(page).locator('[data-ar-name]').fill('Clerk');
    await modal(page).locator('[data-ar-descr]').fill('Enters small claims');
    await modal(page).locator('[data-ar-ok]').click();
    await toast(page, 'Role Clerk added');
    await expect(page.locator('#main')).toContainText('No policy names Clerk yet');

    // A policy names it; the tab then says what the role can do.
    await root.post(`/api/apps/${appName}/policies`, { name: 'Clerks', entity: 'claim', subjects: [{ kind: 'app_role', value: 'Clerk' }], rows: { field: 'amount', op: 'lt', value: 1000 } });
    await root.close();
    await page.locator('[data-tab="policies"]').click();
    await expect(page.locator('#main')).toContainText('Clerks');
    await page.locator('[data-tab="roles"]').click();
    await expect(page.locator('#main')).toContainText('What Clerk can do');
    await expect(page.locator('#main')).toContainText('amount < 1000');

    // The person picker finds the member; assigning asks first.
    await page.locator('[data-ar-q]').fill('member');
    await page.locator('[data-ar-find]').click();
    await page.getByRole('button', { name: /Assign Sam Rivera \(member\)/ }).click();
    await confirmDialog(page, 'Assign');
    await toast(page, 'now holds Clerk');
    await expect(page.locator('#main')).toContainText('Sam Rivera (member)');
    await expect(page.locator('#main')).toContainText('Person');
    // the toasts fade out first (axe would read one mid-fade)
    await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });
    await expectAxeClean(page, 'aa', 'Apps, Roles tab');
    await reflow(page, 'Apps, Roles tab');

    // The other kinds of holder show their own pickers.
    await page.locator('[data-ar-kind]').selectOption('workspace');
    await expect(page.locator('[data-ar-ws]')).toBeVisible();
    await page.locator('[data-ar-kind]').selectOption('group');
    await expect(page.locator('[data-ar-group]')).toBeVisible();

    // Explain names the role that gave the grant.
    await page.locator('[data-tab="policies"]').click();
    await page.locator('[data-exuser]').fill('member');
    await page.locator('[data-explain]').click();
    await expect(page.locator('#main')).toContainText('Clerk (directly)');
    await expect(page.locator('#main')).toContainText('(app role Clerk)');

    // The member reads the small claim only, and has no Roles tab.
    const member = await as('member');
    await open(member, 'apps');
    await expectLive(member);
    await member.locator('#main .leftpane [data-app]', { hasText: title }).click();
    await member.locator('[data-tab="records"]').click();
    await expect(member.locator('#main')).toContainText('Small claim');
    await expect(member.locator('#main')).not.toContainText('Large claim');
    await expect(member.locator('[data-tab="roles"]')).toHaveCount(0);
  });
});
