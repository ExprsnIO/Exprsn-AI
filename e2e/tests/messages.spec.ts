import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, ready, apiAs, confirmDialog, toast } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';

/** Both checkers in Standard and Enhanced (the design-state sweep sees this screen mostly empty, as a system admin). */
async function checkAll(page: Page, where: string): Promise<void> {
  for (const mode of ['aa', 'aaa'] as const) {
    await page.evaluate((m) => (window as unknown as { App: { setA11y(x: string): void } }).App.setA11y(m), mode);
    await expectAccessible(page, `${where} (${mode})`);
    await expectAxeClean(page, mode, `${where} (${mode})`);
  }
  await page.evaluate(() => (window as unknown as { App: { setA11y(x: string): void } }).App.setA11y('aa'));
}

// B-3411: Messages and the workspace feed, for every member. The done-when: a blocked user's message never appears on
// the screen, neither live (over the conversation's socket room) nor after a reload, while other people's messages do
// arrive live.

test.describe('Messages and feed', () => {
  test.use({ user: 'member' });

  test("a blocked person's messages never appear, live or after a reload", async ({ page, as }) => {
    test.setTimeout(90_000);
    const member = await apiAs('member');
    const ops = await apiAs('ops');
    const people = (await member.get('/api/social/people')) as { userId: string; username: string }[];
    const asha = people.find((p) => p.username === 'mladmin')!;
    const ines = people.find((p) => p.username === 'ops')!;
    expect(asha && ines).toBeTruthy();
    const stamp = Date.now();
    const title = `Close room ${stamp}`;
    const conv = await member.post('/api/messaging/conversations', { kind: 'group', title, memberIds: [asha.userId, ines.userId] });

    // Asha writes from her own browser, through the console, before anyone blocks her.
    const ashaPage = await as('mladmin');
    await open(ashaPage, `messages?convo=${conv.id}`);
    await expectLive(ashaPage);
    await ashaPage.locator('[data-draft]').fill(`Before the block ${stamp}`);
    await ashaPage.locator('[data-send]').click();
    await toast(ashaPage, 'Sent.');

    // The member sees it, then blocks Asha from the People view.
    await open(page, `messages?convo=${conv.id}`);
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main.locator('.messages-thread')).toContainText(`Before the block ${stamp}`);
    await page.locator('[data-view] [data-seg="people"]').click();
    await page.locator('[data-block]').click();
    await page.locator('#overlay [data-pp]').selectOption(asha.userId);
    await page.locator('#overlay [data-ppgo]').click();
    await confirmDialog(page, 'Block');
    await toast(page, 'Asha Patel blocked.');
    await expect(main.locator('table')).toContainText('Asha Patel');

    // Back in the conversation her earlier message is gone.
    await page.locator('[data-view] [data-seg="messages"]').click();
    await page.locator(`[data-convo="${conv.id}"]`).click();
    await expect(main).toContainText(title);
    await expect(main.locator('.messages-thread')).not.toContainText(`Before the block ${stamp}`);

    // Asha writes again from her console; Ines writes too. Ines's message arrives live, Asha's never does.
    await ashaPage.locator('[data-draft]').fill(`After the block ${stamp}`);
    await ashaPage.locator('[data-send]').click();
    await toast(ashaPage, 'Sent.');
    await ops.post(`/api/messaging/conversations/${conv.id}/messages`, { body: `Live from Ines ${stamp}` });
    await expect(main.locator('.messages-thread')).toContainText(`Live from Ines ${stamp}`);
    await expect(main.locator('.messages-thread')).not.toContainText(`After the block ${stamp}`);
    await expect(main.locator('.messages-thread')).not.toContainText(`Before the block ${stamp}`);

    // And after a reload.
    await page.reload();
    await ready(page, 'messages');
    await page.locator(`[data-convo="${conv.id}"]`).click();
    await expect(main.locator('.messages-thread')).toContainText(`Live from Ines ${stamp}`);
    await expect(main.locator('.messages-thread')).not.toContainText(`After the block ${stamp}`);
    await expect(main.locator('.messages-thread')).not.toContainText(`Before the block ${stamp}`);
    // Asha's own console still shows her messages.
    await expect(ashaPage.locator('.messages-thread')).toContainText(`After the block ${stamp}`);

    // Unblock through the console, so the other specs see the people as they were.
    await page.locator('[data-view] [data-seg="people"]').click();
    await page.locator(`[data-unblock="${asha.userId}"]`).click();
    await toast(page, 'Unblocked.');
    await member.close();
    await ops.close();
  });

  test('starts a direct conversation, replies and posts to the workspace feed', async ({ page }) => {
    const stamp = Date.now();
    await open(page, 'messages');
    await expectLive(page);
    const main = page.locator('#main');

    // A direct conversation with Ines from the New conversation dialog.
    await page.locator('[data-newconvo]').first().click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('New conversation');
    const ines = await modal.locator('[data-nt] option', { hasText: 'Ines Duarte' }).getAttribute('value');
    await modal.locator('[data-nt]').selectOption(ines!);
    await modal.locator('[data-ngo]').click();
    await toast(page, /Direct conversation started|already have a direct conversation/);
    await expect(main.locator('h1')).toHaveText('Ines Duarte');
    await page.locator('[data-draft]').fill(`Hello Ines ${stamp}`);
    await page.locator('[data-send]').click();
    await expect(main.locator('.messages-thread')).toContainText(`Hello Ines ${stamp}`);

    // A post to the workspace feed, with a hashtag, and a reaction on it.
    await page.locator('[data-view] [data-seg="feed"]').click();
    await page.locator('[data-fseg] [data-seg="ws"]').click();
    await page.locator('[data-pdraft]').fill(`Close checklist ${stamp} #close${stamp}`);
    await page.locator('[data-post]').click();
    await toast(page, 'Published.');
    const post = main.locator('.messages-post', { hasText: `Close checklist ${stamp}` });
    await expect(post).toBeVisible();
    await post.locator('[data-kind="like"]').click();
    await expect(post.locator('[data-kind="like"]')).toHaveAttribute('aria-pressed', 'true');
    // The hashtag opens the tag feed with the post.
    await post.locator(`[data-gotag="close${stamp}"]`).first().click();
    await expect(main.locator('h1')).toHaveText(`#close${stamp}`);
    await expect(main.locator('.messages-post', { hasText: `Close checklist ${stamp}` })).toBeVisible();
  });

  test('the conversation, thread, feed and people views pass the accessibility checks with content', async ({ page }) => {
    test.setTimeout(120_000);
    const member = await apiAs('member');
    const ops = await apiAs('ops');
    const people = (await member.get('/api/social/people')) as { userId: string; username: string }[];
    const ines = people.find((p) => p.username === 'ops')!;
    const stamp = Date.now();
    const conv = await member.post('/api/messaging/conversations', { kind: 'group', title: `Checks ${stamp}`, memberIds: [ines.userId] });
    const first = await ops.post(`/api/messaging/conversations/${conv.id}/messages`, { body: `Accruals are in ${stamp}.` });
    await ops.post(`/api/messaging/conversations/${conv.id}/messages`, { body: 'Which inputs did the calc use?', threadId: first.id });
    await member.post('/api/feed/posts', { body: `Checklist published ${stamp} #checks` });
    const list = await member.post('/api/social/lists', { name: `Checks ${stamp}` });
    await member.post(`/api/social/lists/${list.id}/members`, { userId: ines.userId });
    await member.close();
    await ops.close();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, `messages?convo=${conv.id}`);
      await page.locator('[data-view] [data-seg="messages"]').click();
      await page.locator(`[data-convo="${conv.id}"]`).click();
      await expect(page.locator('.messages-thread')).toContainText(`Accruals are in ${stamp}.`);
      await checkAll(page, `conversation, ${scheme}`);
      for (const tab of ['pins', 'settings']) {
        await page.locator(`[data-insptabs] [data-tab="${tab}"]`).click();
        await checkAll(page, `conversation ${tab}, ${scheme}`);
      }
      await page.locator('[data-insptabs] [data-tab="people"]').click();
      await page.locator(`[data-msg="${first.id}"] [data-thread]`).first().click();
      await expect(page.locator('#overlay .drawer')).toContainText('Which inputs did the calc use?');
      await checkAll(page, `thread drawer, ${scheme}`);
      await page.keyboard.press('Escape');
      await page.locator('[data-view] [data-seg="feed"]').click();
      await page.locator('[data-fseg] [data-seg="ws"]').click();
      await expect(page.locator('.messages-post', { hasText: `Checklist published ${stamp}` })).toBeVisible();
      await checkAll(page, `workspace feed, ${scheme}`);
      await page.locator('[data-view] [data-seg="people"]').click();
      await page.locator('[data-ptabs] [data-tab="lists"]').click();
      await expect(page.locator('#main')).toContainText('Ines Duarte');
      await checkAll(page, `people lists, ${scheme}`);
    }
    // Reflow (WCAG 1.4.10) with content: no sideways scrolling at 320 px in the conversation and the feed.
    await page.setViewportSize({ width: 320, height: 800 });
    const sideways = () => page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
    await page.locator('[data-view] [data-seg="messages"]').click();
    await page.locator(`[data-convo="${conv.id}"]`).click();
    await expect(page.locator('.messages-thread')).toContainText(`Accruals are in ${stamp}.`);
    expect(await sideways()).toBeLessThanOrEqual(1);
    await page.locator('[data-view] [data-seg="feed"]').click();
    await expect(page.locator('.messages-post').first()).toBeVisible();
    expect(await sideways()).toBeLessThanOrEqual(1);
  });
});
