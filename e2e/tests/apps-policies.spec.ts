import { test, expect, open, expectLive, toast, confirmDialog, apiAs, ready } from './support/fixtures';
import { expectAxeClean } from './support/axe';

/*
 * 1.6.0, Sprint 38c (B-8101 to B-8103): a designer adds a row and field policy on the Apps screen, explain says what a
 * member gets, and the member's Records tab shows only the rows the policy allows with the masked field.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: import('@playwright/test').Page) => page.locator('#overlay .modal');

test.describe('Apps: policies', () => {
  test('a policy narrows a member to their region and masks a field; explain names it', async ({ page, as }) => {
    const id = uniq();
    const appName = `deals_${id}`;
    const root = await apiAs('root');
    const me = await root.get('/api/me');
    const ws = me.workspaces[0];
    const memberId = ((await root.get('/api/admin/users')) as { username: string; id: string }[]).find((u) => u.username === 'member')?.id;
    expect(memberId).toBeTruthy();
    await root.patch(`/api/admin/users/${memberId}`, { attributes: { region: 'emea' } });
    await root.post('/api/apps', { name: appName, title: `Deals ${id}`, label: 'internal', workspaceId: ws.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'deal', title: 'Deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 }, { name: 'region', type: 'string', indexed: true, maxLength: 20 }, { name: 'ssn', type: 'string', maxLength: 20 }] } });
    for (const [title, region, ssn] of [['Contoso', 'emea', '123-45-6789'], ['Tailspin', 'apac', '555-66-7777']]) await root.post(`/api/apps/${appName}/entities/deal/records`, { values: { title, region, ssn } });
    await root.close();

    // The designer creates the policy on the screen.
    await open(page, 'apps');
    await expectLive(page);
    await page.locator('#main .leftpane [data-app]', { hasText: `Deals ${id}` }).click();
    await page.locator('[data-tab="policies"]').click();
    await expect(page.locator('#main')).toContainText('No policies');
    await page.locator('[data-newpolicy]').click();
    await modal(page).locator('[data-pname]').fill('Own region');
    await modal(page).locator('[data-pentity]').selectOption('deal');
    await modal(page).locator('[data-skind="0"]').selectOption('role');
    await modal(page).locator('[data-svalue="0"]').fill('member');
    await modal(page).locator('[data-prfield]').selectOption('region');
    await modal(page).locator('[data-prvalue]').fill('$user.attributes.region');
    await modal(page).locator('[data-grant="ssn:unmasked"]').uncheck();
    await modal(page).locator('[data-grant="ssn:mask"]').selectOption('last4');
    await modal(page).locator('[data-psave]').click();
    await toast(page, 'Policy Own region created');
    await expect(page.locator('#main')).toContainText('region eq $user.attributes.region');
    await expect(page.locator('#main')).toContainText('ssn: masked last4');

    // Explain for the member: the policy names them, the field is masked.
    await page.locator('[data-exuser]').fill('member');
    await page.locator('[data-exfield]').selectOption('ssn');
    await page.locator('[data-explain]').click();
    await expect(page.locator('#main')).toContainText('1 of 1 name this reader');
    await expect(page.locator('#main')).toContainText('masked last4');
    await expect(page.locator('#main')).toContainText('by Own region');
    await expectAxeClean(page, 'aa', 'Apps, Policies tab with explain');

    // An unknown placeholder is refused before the request.
    await page.locator('[data-newpolicy]').click();
    await modal(page).locator('[data-pname]').fill('Bad');
    await modal(page).locator('[data-prfield]').selectOption('region');
    await modal(page).locator('[data-prvalue]').fill('$user.region');
    await modal(page).locator('[data-psave]').click();
    await toast(page, 'Unknown placeholder');
    await page.keyboard.press('Escape');

    // The member reaches the emea row only, with the SSN masked.
    const member = await as('member');
    await open(member, 'apps');
    await expectLive(member);
    await member.locator('#main .leftpane [data-app]', { hasText: `Deals ${id}` }).click();
    await member.locator('[data-tab="records"]').click();
    await expect(member.locator('#main')).toContainText('Contoso');
    await expect(member.locator('#main')).not.toContainText('Tailspin');
    // The SSN is not indexed, so it shows in the inspector once the row is selected: masked.
    await member.locator('#main tr[data-rec]', { hasText: 'Contoso' }).first().click();
    await expect(member.locator('#main')).toContainText('***-**-6789');
    await expect(member.locator('#main')).not.toContainText('123-45-6789');
    await expect(member.locator('[data-tab="policies"]')).toHaveCount(0);
  });

  test('a policy is removed again from the screen', async ({ page }) => {
    const id = uniq();
    const appName = `clean_${id}`;
    const root = await apiAs('root');
    const ws = (await root.get('/api/me')).workspaces[0];
    await root.post('/api/apps', { name: appName, title: `Clean ${id}`, label: 'internal', workspaceId: ws.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'item', title: 'Item', label: 'internal', definition: { fields: [{ name: 'name', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 }] } });
    await root.post(`/api/apps/${appName}/policies`, { name: 'Everyone', subjects: [{ kind: 'everyone' }] });
    await root.close();
    await open(page, 'apps');
    await ready(page, 'apps');
    await page.locator('#main .leftpane [data-app]', { hasText: `Clean ${id}` }).click();
    await page.locator('[data-tab="policies"]').click();
    await expect(page.locator('#main')).toContainText('Everyone');
    await page.locator('[data-delpolicy]').first().click();
    await confirmDialog(page, 'Remove');
    await toast(page, 'Policy Everyone removed');
    await expect(page.locator('#main')).toContainText('No policies');
  });
});
