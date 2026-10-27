import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.7.0 (Sprint 42, B-9705, B-9707): a custom role made on the Members tab and given to a member; an event kept as a
// draft and published; the waitlist and an answer that waits for an organiser in the attendees drawer. The views and
// their dialogs pass the WCAG checker and axe-core (Standard and Enhanced, light and dark) and reflow at 320 and 640 px.

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

const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

test.describe('Groups: custom roles and event extras (Sprint 42)', () => {
  test('an owner makes a custom role, gives it to a member, and the member can do what it lists', async ({ page }) => {
    const name = `Role play ${Date.now()}`;
    const root = await apiAs('root');
    const member = await apiAs('member');
    const group = await root.post('/api/groups', { name, visibility: 'public', joinMode: 'open' });
    await member.post(`/api/groups/${group.id}/join`);

    await open(page, `groups?id=${group.id}&tab=members`);
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Roles');
    await page.locator('[data-rolenew]').click();
    await page.locator('[data-rname]').fill('Organiser');
    // The role starts with posting and answering events; give it events and take posting away.
    await page.locator('[data-right="events"]').click();
    await page.locator('[data-right="post"]').click();
    await accessible(page, 'groups: the new role dialog');
    await reflow(page, 'groups: the new role dialog');
    await confirmDialog(page, 'Create role');
    await toast(page, /Role created\./);
    await expect(page.locator('#main')).toContainText('Organiser');

    const roles = await root.get(`/api/groups/${group.id}/roles`);
    const role = roles.custom.find((r: { name: string }) => r.name === 'Organiser');
    expect(role.rights.sort()).toEqual(['events', 'read', 'rsvp']);
    const me = ((await root.get(`/api/groups/${group.id}/members`)) as { userId: string; role: string }[]).find((m) => m.role === 'member')!;
    await root.patch(`/api/groups/${group.id}/members/${me.userId}`, { customRoleId: role.id });
    // the one and not the other
    await member.post(`/api/groups/${group.id}/events`, { title: 'By the organiser', start: soon(48), durationMinutes: 30, timeZone: 'UTC' });
    await expect(member.post(`/api/groups/${group.id}/posts`, { body: 'Hello' })).rejects.toThrow(/403/);

    await open(page, `groups?id=${group.id}&tab=members`);
    await expect(page.locator('#main table').first()).toContainText('Organiser');
    await settle(page);
    await accessible(page, 'groups: the Members tab with a custom role');
    await reflow(page, 'groups: the Members tab with a custom role');
  });

  test('an event is kept as a draft and published; the waitlist and an answer awaiting approval are the organisers’ to see', async ({ page }) => {
    const name = `Extras ${Date.now()}`;
    const root = await apiAs('root');
    const member = await apiAs('member');
    const other = await apiAs('mladmin');
    const group = await root.post('/api/groups', { name, visibility: 'public', joinMode: 'open' });
    await member.post(`/api/groups/${group.id}/join`);
    await other.post(`/api/groups/${group.id}/join`);

    await open(page, `groups?id=${group.id}&tab=events`);
    await expectLive(page);
    await page.locator('[data-newevent]').click();
    await page.locator('[data-etitle]').fill('Studio visit');
    await page.locator('[data-ekind]').selectOption('hybrid');
    await page.locator('[data-eurl]').fill('https://meet.example.com/studio');
    await page.locator('[data-evis]').selectOption('members');
    await page.locator('[data-ewaitlist]').click();
    await page.locator('[data-edraft]').click();
    await accessible(page, 'groups: the event dialog with the extras');
    await reflow(page, 'groups: the event dialog with the extras');
    await page.locator('#overlay [data-esave]').click();
    await toast(page, /Draft saved\./);
    await expect(page.locator('#main')).toContainText('draft');
    // a member does not see the draft
    const seen = (await member.get(`/api/groups/${group.id}/events`)) as { title: string }[];
    expect(seen.map((e) => e.title)).not.toContain('Studio visit');
    await settle(page);
    await accessible(page, 'groups: a draft event');
    await page.locator('[data-publishevent]').click();
    await confirmDialog(page, 'Publish');
    await toast(page, /Published\./);
    expect(((await member.get(`/api/groups/${group.id}/events`)) as { title: string }[]).map((e) => e.title)).toContain('Studio visit');

    // a full event with a waitlist and approval: the member waits for approval, the other for a place
    const full = await root.post(`/api/groups/${group.id}/events`, { title: 'Small table', start: soon(72), durationMinutes: 60, timeZone: 'UTC', capacity: 1, waitlist: true, rsvpApproval: true });
    await root.post(`/api/calendar/events/${full.id}/rsvp`, { response: 'going' });
    expect(await member.post(`/api/calendar/events/${full.id}/rsvp`, { response: 'going' })).toMatchObject({ response: 'pending' });
    expect(await other.post(`/api/calendar/events/${full.id}/rsvp`, { response: 'going' })).toMatchObject({ response: 'pending' });
    await open(page, `groups?id=${group.id}&event=${full.id}`);
    await expect(page.locator('aside[aria-label="Selected event"]')).toContainText('2 awaiting approval');
    await page.locator('[data-attendees]').click();
    await expect(page.locator('#overlay')).toContainText('awaiting approval');
    await accessible(page, 'groups: the attendees drawer with answers awaiting approval');
    await reflow(page, 'groups: the attendees drawer with answers awaiting approval');
    await page.locator('#overlay [data-rsvpdecide="approve"]').first().click();
    await toast(page, /approved and on the waitlist|is going/);
    await settle(page);
    await expect(page.locator('aside[aria-label="Selected event"]')).toContainText('1 on the waitlist');
    // the place frees up: the first on the waitlist takes it
    const freed = await root.post(`/api/calendar/events/${full.id}/rsvp`, { response: 'declined' });
    expect(freed).toMatchObject({ promoted: 1 });
    await open(page, `groups?id=${group.id}&event=${full.id}`);
    await settle(page);
    await accessible(page, 'groups: an event with a waitlist and a deadline');
    await reflow(page, 'groups: an event with a waitlist and a deadline');
  });
});
