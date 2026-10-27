import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.7.0 (Sprint 43, B-9801 to B-9805): social groups as access subjects. A folder granted to a group from Files, a
// vault grant to a social group from the Policies tab, a knowledge base shared with a group, an app scoped to a group,
// and the departed-members switch of a group a manager reads. The new dialogs pass the WCAG checker and axe-core
// (Standard and Enhanced, light and dark) and reflow at 320 and 640 px.

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
    await page.waitForTimeout(200);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

test.describe('Groups as access subjects (Sprint 43)', () => {
  test('a folder is shared with a group from Files and the grant revoked', async ({ page }) => {
    const root = await apiAs('root');
    const stamp = Date.now();
    const group = await root.post('/api/groups', { name: `Readers ${stamp}`, visibility: 'private', joinMode: 'invite' });
    const folder = await root.post('/api/files/folders', { name: `Shared plans ${stamp}` });

    await open(page, `files?folder=${folder.id}`);
    await expectLive(page);
    await page.locator('[data-foldergroups]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('No group reads this folder');
    await modal.locator('[data-fg-group]').selectOption(group.id);
    await accessible(page, 'files: the share a folder with a group dialog');
    await reflow(page, 'files: the share a folder with a group dialog');
    await modal.locator('[data-fg-add]').click();
    await toast(page, new RegExp(`shared with Readers ${stamp}`));
    await expect(modal).toContainText(`Readers ${stamp}`);
    const grants = (await root.get(`/api/files/folders/${folder.id}/group-grants`)) as { id: string; groupId: string }[];
    expect(grants.map((g) => g.groupId)).toEqual([group.id]);
    await accessible(page, 'files: the folder dialog with a group grant');

    await modal.getByRole('button', { name: `Revoke the grant to Readers ${stamp}` }).click();
    await toast(page, 'Grant revoked');
    await expect(modal).toContainText('No group reads this folder');
    expect(await root.get(`/api/files/folders/${folder.id}/group-grants`)).toEqual([]);
    await page.locator('#overlay [data-close]').first().click();
    await root.close();
  });

  test('the Vault grants a path to a social group and explain names it', async ({ page }) => {
    const root = await apiAs('root');
    const stamp = Date.now();
    const name = `Vault circle ${stamp}`;
    const group = await root.post('/api/groups', { name, visibility: 'private', joinMode: 'invite' });

    await open(page, 'vault');
    await expectLive(page);
    await page.locator('[data-tab="policies"]').click();
    await page.locator('[data-newgrant]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-gkind]').selectOption('social_group');
    await modal.locator('[data-gsubject]').selectOption(group.id);
    await modal.locator('[data-gpath]').fill(`kv/circle${stamp}`);
    await accessible(page, 'vault: the add grant dialog with a social group');
    await reflow(page, 'vault: the add grant dialog with a social group');
    await modal.locator('[data-gsave]').click();
    await toast(page, 'Grant added');
    await expect(page.locator('#main')).toContainText(`social group ${name}`);

    // the owner of the group is in it: explain lists it among the caller's social groups
    await page.locator('[data-expath]').fill(`kv/circle${stamp}/db`);
    await page.locator('[data-explain]').click();
    await expect(page.locator('[data-explain-out]')).toContainText('Allowed');
    await expect(page.locator('[data-explain-out]')).toContainText(name);
    await settle(page);
    await accessible(page, 'vault: Policies with a social group grant');
    await reflow(page, 'vault: Policies with a social group grant');

    const grant = ((await root.get('/api/vault/policies')).policies as { id: string; subjectKind: string; subject: string }[]).find((g) => g.subjectKind === 'social_group' && g.subject === group.id);
    expect(grant).toBeTruthy();
    await root.del(`/api/vault/policies/${grant!.id}`);
    await root.close();
  });

  test('a knowledge base is shared with a group', async ({ page }) => {
    const root = await apiAs('root');
    const stamp = Date.now();
    const name = `KB readers ${stamp}`;
    const group = await root.post('/api/groups', { name, visibility: 'private', joinMode: 'invite' });
    const kb = await root.post('/api/knowledge/bases', { name: `Group KB ${stamp}`, embedModel: 'nomic-embed-text' });

    await open(page, `knowledge?kb=${kb.id}`);
    await expectLive(page);
    await page.locator('[data-tab="access"]').click();
    await page.locator('[data-addprincipal]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-wkind]').selectOption('social_group');
    await modal.locator('[data-who]').selectOption(`social_group:${group.id}`);
    await modal.locator('[data-acc]').selectOption('read');
    await accessible(page, 'knowledge: the share dialog with a group');
    await reflow(page, 'knowledge: the share dialog with a group');
    await modal.getByRole('button', { name: 'Share' }).click();
    await toast(page, new RegExp(`Shared with ${name}`));
    await expect(page.locator('#main')).toContainText(name);
    await expect(page.locator('#main')).toContainText('shared with the group');
    const access = (await root.get(`/api/knowledge/bases/${kb.id}/access`)) as { kind: string; name: string }[];
    expect(access.some((a) => a.kind === 'social_group' && a.name === name)).toBe(true);
    await root.close();
  });

  test('an app is scoped to a group and the scope cleared', async ({ page }) => {
    const root = await apiAs('root');
    const stamp = Date.now();
    const name = `App owners ${stamp}`;
    const group = await root.post('/api/groups', { name, visibility: 'private', joinMode: 'invite' });
    const app = await root.post('/api/apps', { name: `scoped_${stamp}`, label: 'internal', groupId: group.id });
    expect(app.groupId).toBe(group.id);

    await open(page, `apps?app=${app.id}`);
    await expectLive(page);
    await expect(page.locator('#main')).toContainText(`Scoped to group ${name}`);
    await page.locator('[data-appgroup]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal.locator('[data-gs-group]')).toHaveValue(group.id);
    await accessible(page, 'apps: the group scope dialog');
    await reflow(page, 'apps: the group scope dialog');
    await modal.locator('[data-gs-group]').selectOption('');
    await modal.locator('[data-gs-ok]').click();
    await toast(page, 'No longer scoped to a group');
    await expect(page.locator('#main')).not.toContainText(`Scoped to group ${name}`);
    expect((await root.get(`/api/apps/${app.id}`)).groupId).toBeNull();
    await root.del(`/api/apps/${app.id}`);
    await root.close();
  });

  test('a manager lists departed members of a group', async ({ page }) => {
    const root = await apiAs('root');
    const group = await root.post('/api/groups', { name: `Departures ${Date.now()}`, visibility: 'private', joinMode: 'invite' });
    await open(page, `groups?id=${group.id}&tab=members`);
    await expectLive(page);
    const toggle = page.getByRole('switch', { name: 'Show departed members' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    const asked = page.waitForRequest((r) => r.url().includes(`/api/groups/${group.id}/members`) && r.url().includes('departed=1'));
    await toggle.click();
    await asked;
    await settle(page);
    await expect(page.getByRole('switch', { name: 'Show departed members' })).toHaveAttribute('aria-checked', 'true');
    // the owner is active: no notice that the group has no owner
    await expect(page.locator('#main')).not.toContainText('This group has no active owner');
    await accessible(page, 'groups: Members with departed members shown');
    await root.close();
  });
});
