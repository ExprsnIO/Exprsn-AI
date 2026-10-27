import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.7.0 (Sprint 42, B-9701, B-9702, B-9209): an invite link made from the Members tab and used by its code, a member
// banned and the ban lifted, and the Vault's reference owners. The views and their dialogs pass the WCAG checker and
// axe-core (Standard and Enhanced, light and dark) and reflow at 320 and 640 px.

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

test.describe('Groups: invite links and bans; Vault: reference owners (Sprint 42)', () => {
  test('a moderator makes an invite link, a member joins by its code, is banned, and the ban is lifted', async ({ page }) => {
    const name = `Inner circle ${Date.now()}`;
    const root = await apiAs('root');
    const member = await apiAs('member');
    const other = await apiAs('mladmin');
    const group = await root.post('/api/groups', { name, visibility: 'private', joinMode: 'invite' });

    await open(page, `groups?id=${group.id}&tab=members`);
    await expectLive(page);
    await page.locator('[data-newlink]').click();
    await page.locator('[data-lmax]').fill('1');
    await accessible(page, 'groups: the new invite link dialog');
    await reflow(page, 'groups: the new invite link dialog');
    await confirmDialog(page, 'Make link');
    const code = await page.locator('[data-linkcode]').inputValue();
    expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    await expect(page.locator('#overlay')).toContainText('not shown again');
    await accessible(page, 'groups: the invite link made dialog');
    await page.locator('#overlay [data-close]').click();

    // the code admits one person; the next is refused, and the list says the link is used up
    expect(await member.post('/api/group-invites/redeem', { code: code.toLowerCase() })).toMatchObject({ joined: true, groupId: group.id });
    await expect(other.post('/api/group-invites/redeem', { code })).rejects.toThrow(/410|admitted/i);
    await open(page, `groups?id=${group.id}&tab=members`);
    await expect(page.locator('#main')).toContainText('used up');
    await expect(page.locator('#main')).not.toContainText(code);

    // the member is banned from the list, with a reason the moderators read, and the ban is lifted
    const banButton = page.locator('[data-ban]:not([disabled])').first();
    await banButton.click();
    await page.locator('[data-bdays]').fill('3');
    await page.locator('[data-breason]').fill('Posting adverts');
    await accessible(page, 'groups: the ban dialog');
    await reflow(page, 'groups: the ban dialog');
    await confirmDialog(page, 'Apply');
    await toast(page, /banned\./);
    await expect(page.locator('#main')).toContainText('Posting adverts');
    await expect(page.locator('#main')).toContainText('banned');
    await expect(member.post(`/api/groups/${group.id}/join`)).rejects.toThrow(/403|banned/i);
    await settle(page);
    await accessible(page, 'groups: the Members tab with an invite link and a ban');
    await reflow(page, 'groups: the Members tab with an invite link and a ban');
    await page.locator('[data-liftban]').first().click();
    await confirmDialog(page, 'Lift');
    await toast(page, /Lifted\./);
    await expect(page.locator('#main')).toContainText('Nobody is banned or suspended');
    await root.close();
    await member.close();
    await other.close();
  });

  test('Join with a code looks the code up before joining', async ({ page, watch }) => {
    watch.allow.push(/group-invites\/lookup/);
    const root = await apiAs('root');
    const name = `Code club ${Date.now()}`;
    const group = await root.post('/api/groups', { name, visibility: 'hidden', joinMode: 'invite' });
    const link = await root.post(`/api/groups/${group.id}/invite-links`, { maxUses: 5 });
    await open(page, 'groups');
    await expectLive(page);
    await page.locator('[data-joincode]').click();
    await page.locator('[data-jcode]').fill('00000-00000-00000-00000');
    await accessible(page, 'groups: the join with a code dialog');
    await reflow(page, 'groups: the join with a code dialog');
    await confirmDialog(page, 'Look up');
    await toast(page, 'No invite link with that code is open to you.');
    // the owner is a member already: the dialog says so and takes no place on the link
    await page.locator('[data-joincode]').click();
    await page.locator('[data-jcode]').fill(link.code);
    await confirmDialog(page, 'Look up');
    await toast(page, new RegExp(`already a member of ${name}`));
    expect(((await root.get(`/api/groups/${group.id}/invite-links`)) as { uses: number }[])[0]!.uses).toBe(0);
    await root.close();
  });

  test('the Vault lists reference owners and refuses a handover the owner holds no grant for', async ({ page, watch }) => {
    watch.allow.push(/vault\/reference-owners/);
    await open(page, 'vault');
    await expectLive(page);
    await page.locator('[data-tab="policies"]').click();
    await expect(page.locator('#main')).toContainText('Reference owners');
    await page.locator('[data-newrefowner]').click();
    await page.locator('[data-roref]').fill('vault:apps/none#password');
    await accessible(page, 'vault: the hand over a reference dialog');
    await reflow(page, 'vault: the hand over a reference dialog');
    await page.locator('[data-rosave]').click();
    await toast(page, /Not handed over|not found/i);
    await page.locator('#overlay [data-close]').click();
    await settle(page);
    await accessible(page, 'vault: Policies with reference owners');
    await reflow(page, 'vault: Policies with reference owners');
  });
});
