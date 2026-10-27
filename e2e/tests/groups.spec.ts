import { test, expect, open, expectLive, confirmDialog, toast, apiAs } from './support/fixtures';

// B-3409: Groups and events. Seeding goes through the API as the accounts concerned; the steps under test go through
// the console.

const tomorrow = (h: number) => {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:00`;
};

test.describe('Groups and events', () => {
  test('creates a group and an event from the screen, and invites a member', async ({ page }) => {
    const name = `Close crew ${Date.now()}`;
    await open(page, 'groups');
    await expectLive(page);
    await page.locator('[data-newgroup]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-gname]').fill(name);
    await modal.locator('[data-gvis]').selectOption('public');
    await modal.locator('[data-gjoin]').selectOption('request');
    await modal.getByRole('button', { name: 'Create', exact: true }).click();
    await toast(page, `${name} created; you are its owner.`);
    await expect(page.locator('#main h1')).toHaveText(name);

    // An event on the calendar.
    await page.getByRole('tab', { name: /Events/ }).click();
    await page.locator('[data-newevent]').click();
    await page.locator('#overlay [data-etitle]').fill('Flash report review');
    await page.locator('#overlay [data-eloc]').fill('Room 4.02');
    await page.locator('#overlay').getByRole('button', { name: 'Create event' }).click();
    await toast(page, 'Event created.');
    await expect(page.locator('#main tr', { hasText: 'Flash report review' })).toContainText('scheduled');
    await expect(page.locator('aside.inspector')).toContainText('Flash report review');

    // An invitation through the picker of people in the workspace.
    await page.getByRole('tab', { name: /Members/ }).click();
    await page.locator('[data-invite]').first().click();
    const pick = page.locator('#overlay [data-iuser]');
    const sam = pick.locator('option', { hasText: 'Sam Rivera' });
    await sam.waitFor({ state: 'attached' });
    await pick.selectOption({ value: (await sam.getAttribute('value'))! });
    await page.locator('#overlay').getByRole('button', { name: 'Send invitation' }).click();
    await toast(page, 'Invitation sent; the invitee is notified.');
    await expect(page.locator('#main tr', { hasText: 'Sam Rivera' })).toContainText('pending');

    const member = await apiAs('member');
    const mine = (await member.get('/api/group-requests')) as { groupName: string; kind: string }[];
    expect(mine.some((r) => r.groupName === name && r.kind === 'invite')).toBe(true);
    await member.close();
  });

  test('cancelling an event from the screen notifies its attendees', async ({ page }) => {
    const name = `Offsite planning ${Date.now()}`;
    const root = await apiAs('root');
    const member = await apiAs('member');
    const group = await root.post('/api/groups', { name, visibility: 'public', joinMode: 'open' });
    await member.post(`/api/groups/${group.id}/join`);
    const event = await root.post(`/api/groups/${group.id}/events`, { title: 'Budget walkthrough', start: tomorrow(9), end: tomorrow(10), timeZone: 'UTC', reminders: [60] });
    await member.post(`/api/calendar/events/${event.id}/rsvp`, { response: 'going' });
    // A full event beside it (one place, taken), for the "Capacity reached" design state the accessibility sweep shows.
    const full = await root.post(`/api/groups/${group.id}/events`, { title: 'Audit walkthrough (small room)', start: tomorrow(12), end: tomorrow(13), timeZone: 'UTC', capacity: 1 });
    await member.post(`/api/calendar/events/${full.id}/rsvp`, { response: 'going' });

    await open(page, `groups?id=${group.id}&event=${event.id}`);
    await expectLive(page);
    await expect(page.locator('aside.inspector')).toContainText('Budget walkthrough');
    await expect(page.locator('aside.inspector')).toContainText('1 going');
    await page.locator('[data-cancelevent]').click();
    await page.locator('#overlay [data-creason]').fill('Moved into the close kickoff');
    await confirmDialog(page, 'Cancel event');
    await toast(page, 'Budget walkthrough cancelled; 1 attendee notified.');
    await expect(page.locator('#main')).toContainText('1 attendee was (going or maybe) notified');
    await expect(page.locator('#main tr', { hasText: 'Budget walkthrough' })).toContainText('cancelled');

    // The attendee has the notice, without the event's title or the reason.
    const notes = (await member.get('/api/me/notifications')) as { items: { title: string; body: string | null; route: string | null }[] };
    const n = notes.items.find((x) => x.title === `An event in ${name} was cancelled`);
    expect(n, JSON.stringify(notes.items.map((x) => x.title))).toBeTruthy();
    expect(`${n!.title} ${n!.body ?? ''}`).not.toContain('Budget walkthrough');
    expect(`${n!.title} ${n!.body ?? ''}`).not.toContain('Moved into');
    expect(n!.route).toBe(`groups?id=${group.id}&event=${event.id}`);
    await root.close();
    await member.close();
  });

  test.describe('as a member', () => {
    test.use({ user: 'member' });
    test('joins an open group and answers an event from the screen', async ({ page }) => {
      const name = `Travel policy ${Date.now()}`;
      const root = await apiAs('root');
      const group = await root.post('/api/groups', { name, visibility: 'public', joinMode: 'open', description: 'Drafting the travel policy.' });
      const event = await root.post(`/api/groups/${group.id}/events`, { title: 'Policy Q&A', start: tomorrow(14), end: tomorrow(15), timeZone: 'UTC' });
      await root.close();

      await open(page, `groups?id=${group.id}`);
      await expectLive(page);
      await expect(page.locator('#main')).toContainText('Drafting the travel policy.');
      await page.locator('[data-join]').click();
      await confirmDialog(page, 'Join');
      await toast(page, `Joined ${name} as member.`);
      await expect(page.locator('#main .pagehead')).toContainText('your role: member');

      await page.getByRole('tab', { name: /Events/ }).click();
      await expect(page.locator('aside.inspector')).toContainText('Policy Q&A');
      // A member has no moderator controls.
      await expect(page.locator('[data-cancelevent]')).toHaveCount(0);
      await expect(page.locator('[data-newevent]')).toHaveCount(0);
      await page.locator('[data-rsvp] [data-seg="going"]').click();
      await toast(page, 'RSVP: going.');
      await expect(page.locator(`#main tr[data-event="${event.id}"]`)).toContainText('1 going');
    });
  });
});
