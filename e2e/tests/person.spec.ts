import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, ready, apiAs, confirmDialog, toast } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';

/** Both checkers in Standard and Enhanced, here with a filled-in profile (the sweep sees it as a system admin). */
async function checkAll(page: Page, where: string): Promise<void> {
  for (const mode of ['aa', 'aaa'] as const) {
    await page.evaluate((m) => (window as unknown as { App: { setA11y(x: string): void } }).App.setA11y(m), mode);
    await expectAccessible(page, `${where} (${mode})`);
    await expectAxeClean(page, mode, `${where} (${mode})`);
  }
  await page.evaluate(() => (window as unknown as { App: { setA11y(x: string): void } }).App.setA11y('aa'));
}

// A 1×1 PNG, and bytes that only claim to be one.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a49444154789c636000000002000148afa4710000000049454e44ae426082', 'hex');
const NOT_PNG = Buffer.from([1, 2, 0, 3, 4, 5, 6, 7]);

// B-5801: profiles. Done when opening an author from a post shows their profile, and an avatar that fails the scan is
// never shown. B-5802: presence. Done when a member set to busy shows busy to a contact within five seconds and not at
// all to a blocked user.

test.describe('Profiles and presence', () => {
  test.use({ user: 'member' });

  test('a profile written in Settings, with a picture that passed the scan, opens from a post', async ({ page, as }) => {
    test.setTimeout(120_000);
    const member = await apiAs('member');
    const me = await member.get('/api/me');
    await open(page, 'settings');
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main).toContainText('Public profile');
    const stamp = Date.now();
    await main.locator('[data-pron]').fill('they/them');
    await main.locator('[data-bio]').fill(`Accounts payable, Lisbon office ${stamp}.`);
    await main.locator('[data-saveprofile]').click();
    await toast(page, 'Profile saved.');

    // A picture that is not an image: refused by the scan, and never shown.
    await main.locator('[data-avfile]').setInputFiles({ name: 'not-a-picture.png', mimeType: 'image/png', buffer: NOT_PNG });
    await toast(page, 'Picture uploaded');
    await expect.poll(async () => (await member.get('/api/people/me')).avatar.state, { timeout: 20_000 }).toBe('rejected');
    await page.reload();
    await ready(page, 'settings');
    await expect(main).toContainText('Picture refused by the scan.');
    await expect(main.locator('img.settings-avatar')).toHaveCount(0);

    // A real picture: shown once it passed.
    await main.locator('[data-avfile]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
    await toast(page, 'Picture uploaded');
    await expect.poll(async () => (await member.get('/api/people/me')).avatar.state, { timeout: 20_000 }).toBe('ready');
    await page.reload();
    await ready(page, 'settings');
    await expect(main.locator('img.settings-avatar')).toBeVisible();
    await checkAll(page, 'Settings with a public profile');

    // Sam posts in the workspace feed; Ines opens the author from the post.
    const ws = me.workspaces[0];
    const post = await member.post('/api/feed/posts', { workspaceId: ws.id, body: `Supplier statements are reconciled ${stamp}.` });
    const ines = await as('ops');
    await open(ines, `messages?post=${post.id}`);
    await expectLive(ines);
    const article = ines.locator(`[data-post="${post.id}"]`);
    await expect(article).toBeVisible();
    await article.locator('a.messages-who', { hasText: 'Sam Rivera' }).first().click();
    await ready(ines, 'person');
    await expectLive(ines);
    const prof = ines.locator('#main');
    await expect(prof.locator('.person-name')).toContainText('Sam Rivera');
    await expect(prof).toContainText('they/them');
    await expect(prof).toContainText(`Accounts payable, Lisbon office ${stamp}.`);
    const img = prof.locator('img.person-avatar');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)).toBe(1);
    await checkAll(ines, 'Profile of another member');
    await member.close();
  });

  test('a member set to busy shows busy to a contact within five seconds and not at all to a blocked user', async ({ page, as }) => {
    test.setTimeout(120_000);
    const member = await apiAs('member');
    const people = (await member.get('/api/social/people')) as { userId: string; username: string }[];
    const asha = people.find((p) => p.username === 'mladmin')!;
    const sam = (await member.get('/api/me')).user;
    // Sam blocks Asha (the Messages spec may already have; a second block is 200).
    await member.post('/api/social/blocks', { userId: asha.userId });
    await member.put('/api/presence/me', { status: 'auto' });

    // Ines (a contact) and Asha (blocked) both open Sam's profile.
    const ines = await as('ops');
    await open(ines, `person?user=${sam.id}`);
    await expectLive(ines);
    const ashaPage = await as('mladmin');
    await open(ashaPage, `person?user=${sam.id}`);
    await expectLive(ashaPage);
    await expect(ashaPage.locator('#main')).toContainText('Name only.');

    // Sam is connected (this page) and sets himself busy in Settings.
    await open(page, 'settings');
    await expect(ines.locator('#main .person-head')).toContainText('available', { timeout: 10_000 });
    const t0 = Date.now();
    await page.locator('[data-pstatus] [data-seg="busy"]').click();
    await toast(page, 'Status: Busy.');
    await expect(ines.locator('#main .person-head')).toContainText('busy', { timeout: 5_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    // Asha sees no status at all, now or after a reload.
    await ashaPage.waitForTimeout(500);
    for (const s of ['available', 'away', 'busy', 'offline']) await expect(ashaPage.locator('#main .person-head .pill', { hasText: new RegExp(`^${s}$`) })).toHaveCount(0);
    await ashaPage.reload();
    await ready(ashaPage, 'person');
    await expect(ashaPage.locator('#main .person-head')).not.toContainText('busy');
    // The directory on Messages > People shows Sam busy to Ines too.
    await open(ines, 'messages');
    await ines.locator('[data-view] [data-seg="people"]').click();
    await ines.locator('[data-ptabs] [data-tab="directory"]').click();
    await expect(ines.locator('#main table tr', { hasText: 'Sam Rivera' })).toContainText('busy');

    // Back to automatic.
    await page.locator('[data-pstatus] [data-seg="auto"]').click();
    await toast(page, 'Status: Automatic.');
    await member.close();
  });

  test('blocking from a profile leaves the name only', async ({ page }) => {
    const member = await apiAs('member');
    const people = (await member.get('/api/social/people')) as { userId: string; username: string }[];
    const noor = people.find((p) => p.username === 'enrol')!;
    await member.del(`/api/social/blocks/${noor.userId}`).catch(() => undefined);
    await open(page, `person?user=${noor.userId}`);
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main.locator('.person-name')).toContainText('Noor Haddad');
    await main.locator('[data-block]').click();
    await confirmDialog(page, 'Block');
    await toast(page, 'Noor Haddad blocked.');
    await expect(main).toContainText('You blocked Noor Haddad.');
    await expect(main.locator('[data-unblock]')).toBeVisible();
    await main.locator('[data-unblock]').click();
    await toast(page, 'Unblocked.');
    await expect(main.locator('[data-block]')).toBeVisible();
    await member.close();
  });
});
