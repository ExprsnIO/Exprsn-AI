import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.7.0 (Sprint 42, B-9706, B-9709): a group's owner acts on a reported post from the Cases tab (assign, hide), and
// links a conversation to the group from its overview. The views and their dialogs pass the WCAG checker and axe-core
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

test.describe('Groups: cases for moderators and the linked conversation (Sprint 42)', () => {
  test('an owner assigns and hides a reported post, and links a conversation to the group', async ({ page }) => {
    const name = `Case club ${Date.now()}`;
    const root = await apiAs('root');
    const member = await apiAs('member');
    const other = await apiAs('mladmin');
    const group = await root.post('/api/groups', { name, visibility: 'public', joinMode: 'open' });
    await member.post(`/api/groups/${group.id}/join`);
    await other.post(`/api/groups/${group.id}/join`);
    const post = await member.post(`/api/groups/${group.id}/posts`, { body: 'Buy my fonts, cheap, today only' });
    const report = await other.post('/api/moderation/reports', { type: 'group-post', id: post.id, reason: 'Spam' });

    await open(page, `groups?id=${group.id}&tab=cases`);
    await expectLive(page);
    await expect(page.locator('#main')).toContainText(report.flag.ref);
    await expect(page.locator('#main')).toContainText('any moderator');
    await settle(page);
    await accessible(page, 'groups: the Cases tab with an open case');
    await reflow(page, 'groups: the Cases tab with an open case');

    // assign it, then hide the post
    await page.locator('[data-caseassign]').first().click();
    await expect(page.locator('#overlay [data-cwho]')).toBeVisible();
    await accessible(page, 'groups: the assign case dialog');
    await reflow(page, 'groups: the assign case dialog');
    await page.locator('#overlay [data-cwho]').selectOption({ index: 1 });
    await confirmDialog(page, 'Assign');
    await toast(page, /Assigned\./);
    await expect(page.locator('#main')).not.toContainText('any moderator');

    await page.locator('[data-caseact]').first().click();
    await page.locator('#overlay [data-cact]').selectOption('hide');
    await page.locator('#overlay [data-cnote]').fill('Advertising');
    await accessible(page, 'groups: the act on case dialog');
    await reflow(page, 'groups: the act on case dialog');
    await confirmDialog(page, 'Apply');
    await toast(page, /group\.case\.hide/);
    await expect(page.locator('#main')).toContainText('confirmed');
    const posts = (await other.get(`/api/groups/${group.id}/posts`)) as { id: string; state: string; body: string | null }[];
    expect(posts.filter((x) => x.id === post.id && x.state !== 'hidden' && x.body)).toHaveLength(0);

    // the overview links a conversation; its members are the group's
    await open(page, `groups?id=${group.id}&tab=overview`);
    await expect(page.locator('#main')).toContainText('No conversation is linked to this group');
    await page.locator('[data-linkconv]').click();
    await accessible(page, 'groups: the link a conversation dialog');
    await confirmDialog(page, 'Link');
    await toast(page, /Linked\./);
    await expect(page.locator('[data-openconv]')).toBeVisible();
    await settle(page);
    await accessible(page, 'groups: the overview with a linked conversation');
    await reflow(page, 'groups: the overview with a linked conversation');
    const conv = (await member.get(`/api/groups/${group.id}/conversation`)) as { linked: boolean; conversationId: string };
    expect(conv.linked).toBe(true);
    expect(await member.get(`/api/messaging/conversations/${conv.conversationId}`)).toMatchObject({ groupId: group.id, members: 3 });

    // in Messages, a group's conversation offers no member controls of its own
    await page.locator('[data-openconv]').click();
    await expect(page.locator('#main')).toContainText(name);
    await expect(page.locator('[data-leave]')).toHaveCount(0);
    await root.close();
    await member.close();
    await other.close();
  });
});
