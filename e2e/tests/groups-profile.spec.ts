import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.7.0 (Sprint 42, B-9703, B-9704, B-9708): a group's tags, website and member limit from Settings, the member search
// on the server, and "Notify attendees" with the event's notices. The views pass the WCAG checker and axe-core
// (Standard and Enhanced, light and dark) and reflow at 320 and 640 px.

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };

const tomorrow = (h: number) => {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:00`;
};

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

test.describe('Groups: profile fields, member search and notices (Sprint 42)', () => {
  test('an owner sets tags, a website and a member limit; a full group refuses the next join', async ({ page }) => {
    const name = `Type club ${Date.now()}`;
    const root = await apiAs('root');
    const member = await apiAs('member');
    const group = await root.post('/api/groups', { name, visibility: 'public', joinMode: 'open' });

    await open(page, `groups?id=${group.id}`);
    await expectLive(page);
    await page.locator('[data-stags]').fill('Type Design, #kerning, kerning');
    await page.locator('[data-ssite]').fill('https://example.test/type');
    await page.locator('[data-slimit]').fill('1');
    await page.locator('[data-savesettings]').click();
    await toast(page, 'Settings saved.');
    await expect(page.locator('#main .groups-profile')).toContainText('type design');
    await expect(page.locator('#main .groups-profile')).toContainText('kerning');
    await expect(page.locator('#main .groups-site')).toHaveAttribute('href', 'https://example.test/type');
    await expect(page.locator('#main .groups-site')).toHaveAttribute('rel', /noopener/);
    await expect(page.locator('#main')).toContainText(`${name} is full.`);
    await expect(page.locator('[data-stags]')).toHaveValue('type design, kerning');

    // the server refuses the next join, and says why
    await expect(member.post(`/api/groups/${group.id}/join`)).rejects.toThrow(/409|full|limit/i);
    expect(((await root.get(`/api/groups/${group.id}`)) as { members: number; full: boolean }).members).toBe(1);

    await settle(page);
    await accessible(page, 'groups: a full group with tags and a website');
    await reflow(page, 'groups: a full group with tags and a website');
    await root.close();
    await member.close();
  });

  test('the Members tab searches on the server, and an organiser notifies an event’s attendees', async ({ page }) => {
    const name = `Offsite crew ${Date.now()}`;
    const root = await apiAs('root');
    const member = await apiAs('member');
    const group = await root.post('/api/groups', { name, visibility: 'public', joinMode: 'open' });
    await member.post(`/api/groups/${group.id}/join`);
    const event = await root.post(`/api/groups/${group.id}/events`, { title: 'Budget walkthrough', start: tomorrow(9), end: tomorrow(10), timeZone: 'UTC' });
    await member.post(`/api/calendar/events/${event.id}/rsvp`, { response: 'going' });

    await open(page, `groups?id=${group.id}`);
    await expectLive(page);
    await page.getByRole('tab', { name: /Members/ }).click();
    await expect(page.locator('#main')).toContainText('Showing 2 of 2, oldest membership first.');
    await page.locator('[data-msearch]').fill('Sam');
    await page.locator('[data-msearch]').press('Enter');
    await expect(page.locator('#main')).toContainText('Showing 1 of 1 matching');
    await expect(page.locator('#main tr', { hasText: 'Sam Rivera' })).toHaveCount(1);
    await accessible(page, 'groups: member search');
    await reflow(page, 'groups: member search');
    await page.locator('[data-msearch]').fill('nobody-by-that-name');
    await page.locator('[data-msearchgo]').click();
    await expect(page.locator('#main')).toContainText('No member matches');
    await page.locator('[data-msearchclear]').click();
    await expect(page.locator('#main')).toContainText('Showing 2 of 2');

    // notify attendees, then read the notice back
    await open(page, `groups?id=${group.id}&event=${event.id}`);
    await expect(page.locator('aside.inspector')).toContainText('Budget walkthrough');
    await page.locator('[data-notify]').click();
    await page.locator('#overlay [data-nmsg]').fill('We start in room 2; bring the proofs.');
    await confirmDialog(page, 'Send');
    await toast(page, '1 attendee notified.');
    await page.locator('[data-notices]').click();
    await expect(page.locator('#overlay .drawer')).toContainText('We start in room 2; bring the proofs.');
    await page.locator('#overlay [data-close]').first().click();

    const notes = (await member.get('/api/me/notifications')) as { items?: { kind: string; title: string; body: string | null }[] } | { kind: string; title: string; body: string | null }[];
    const list = Array.isArray(notes) ? notes : notes.items ?? [];
    const notice = list.find((n) => n.kind === 'event.notice');
    expect(notice, 'the attendee is notified').toBeTruthy();
    expect(`${notice!.title}${notice!.body ?? ''}`).not.toContain('proofs');
    await root.close();
    await member.close();
  });
});
