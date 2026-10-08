import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

// 1.6.0 (Sprint 36a, B-4401 to B-4405): groups depth, live. Channels inside a group (their own members and posts, the
// label floor), Discover ranked by shared members and activity, Trending after a burst of joins, places with a
// distance filter, and the tenant's categories managed from Social and messaging (removing one leaves its groups
// uncategorised). The screens, their new design states and their new dialogs pass the WCAG checker and axe-core
// (Standard and Enhanced, light and dark) and reflow at 320 and 640 px.

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void; applyState(i: number): void; closeOverlay(): void; screens: Record<string, { states?: { title: string }[] }> } };

const BERLIN = { lat: 52.52, lon: 13.405 };
const POTSDAM = { lat: 52.3906, lon: 13.0645 };
const LISBON = { lat: 38.7223, lon: -9.1393 };

function dialogReflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const box = document.querySelector('#overlay > .modal, #overlay > .drawer') as HTMLElement | null;
    if (!box) return ['no dialog open'];
    const doc = document.scrollingElement!;
    if (doc.scrollWidth > window.innerWidth + 1) out.push(`the page scrolls sideways by ${doc.scrollWidth - window.innerWidth} px`);
    if (box.scrollWidth > box.clientWidth + 1) out.push(`the dialog scrolls sideways by ${box.scrollWidth - box.clientWidth} px`);
    const edge = Math.min(window.innerWidth, box.getBoundingClientRect().right);
    const scrollers = Array.from(box.querySelectorAll('*')).filter((el) => el instanceof HTMLElement && /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1);
    for (const el of scrollers) if (!el.matches('.tablewrap,.codebox,pre,textarea,[data-scroll-x]')) out.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} scrolls sideways`);
    for (const el of Array.from(box.querySelectorAll('*'))) {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.right <= edge + 1 || scrollers.some((s) => s.contains(el))) continue;
      out.push(`${el.tagName.toLowerCase()}.${el.className} sticks out (${Math.round(r.right)} px of ${Math.round(edge)})`);
    }
    return [...new Set(out)].slice(0, 10);
  });
}

/** The in-page checker, then axe-core in Standard and Enhanced, light and dark. */
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
  await page.emulateMedia({ colorScheme: 'light' });
}

async function reflow(page: Page, where: string, dialog = false): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(200);
    expect.soft(dialog ? await dialogReflow(page) : await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

async function tab(page: Page, label: RegExp): Promise<void> {
  await settle(page);
  await expect(async () => {
    await page.locator('.tabs [data-tab]', { hasText: label }).first().click();
    await expect(page.locator('.tabs [data-tab][aria-selected="true"]', { hasText: label })).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await settle(page);
}

async function mode(page: Page, label: string): Promise<void> {
  await page.locator('[data-modeseg] [data-seg]', { hasText: label }).click();
  await settle(page);
}

test.describe('Groups depth (B-4401 to B-4405)', () => {
  test.describe.configure({ timeout: 300_000 });
  // Stable for the whole run (a failed test restarts the worker and reloads this file): the server's port.
  const stamp = `p${new URL(serverState().url).port}`;
  const close = `Depth close ${stamp}`;
  const potsdam = `Potsdam site ${stamp}`;
  const lisbon = `Lisbon office ${stamp}`;

  test('categories are managed from Social and messaging; a group gets a category, a place and a channel with its own members and posts', async ({ page }) => {
    const ws = serverState().workspace;
    // B-4405: categories from the Social and messaging screen.
    await open(page, 'social?tab=groups');
    await expectLive(page);
    for (const name of [`Projects ${stamp}`, `Teams ${stamp}`]) {
      await page.locator('[data-catnew]').click();
      const m = page.locator('#overlay .modal');
      await expect(m).toContainText('New group category');
      if (name.startsWith('Projects')) {
        await accessible(page, 'New category dialog');
        await reflow(page, 'New category dialog', true);
      }
      await m.locator('[data-catname]').fill(name);
      await m.getByRole('button', { name: 'Create' }).click();
      await toast(page, `${name} added`);
    }
    await expect(page.locator('tr', { hasText: `Projects ${stamp}` })).toBeVisible();

    const root = await apiAs('root');
    const cats = (await root.get('/api/group-categories')) as { id: string; name: string }[];
    const projects = cats.find((c) => c.name === `Projects ${stamp}`)!;
    await root.post('/api/groups', { workspaceId: ws.id, name: close, visibility: 'public', joinMode: 'open', categoryId: projects.id, location: { name: 'Berlin office', ...BERLIN } });
    await root.post('/api/groups', { workspaceId: ws.id, name: potsdam, visibility: 'public', joinMode: 'open', location: { name: 'Potsdam site', ...POTSDAM } });
    await root.post('/api/groups', { workspaceId: ws.id, name: lisbon, visibility: 'public', joinMode: 'open', location: { name: 'Lisbon office', ...LISBON } });

    // The group shows its category and place.
    await open(page, 'groups');
    await expectLive(page);
    await page.locator('[data-group]', { hasText: close }).click();
    await settle(page);
    await expect(page.locator('#main h1')).toHaveText(close);
    await expect(page.locator('#main .panel', { hasText: 'About' })).toContainText('Berlin office');
    await expect(page.locator('#main .panel', { hasText: 'About' })).toContainText(`Projects ${stamp}`);

    // B-4401: a channel from the Channels tab, with its own members and posts.
    await tab(page, /^Channels/);
    await page.locator('[data-newchannel]').click();
    const cm = page.locator('#overlay .modal');
    await expect(cm).toContainText(`New channel in ${close}`);
    await accessible(page, 'New channel dialog');
    await reflow(page, 'New channel dialog', true);
    await cm.locator('[data-cname]').fill('Accruals');
    await cm.locator('[data-cvis]').selectOption('private');
    await cm.getByRole('button', { name: 'Create channel' }).click();
    await toast(page, 'Accruals created; you are its owner');
    await expect(page.locator('tr[data-channel]', { hasText: 'Accruals' })).toBeVisible();
    await accessible(page, 'Groups, Channels tab');
    await reflow(page, 'Groups, Channels tab');
    await page.locator('tr[data-channel]', { hasText: 'Accruals' }).click();
    await settle(page);
    await expect(page.locator('#main h1')).toHaveText('Accruals');
    await expect(page.locator('#main')).toContainText(`Channel of ${close}`);
    await tab(page, /^Posts/);
    await page.locator('[data-draft]').fill('Accruals above 25k need a ticket');
    await page.locator('[data-post]').click();
    await toast(page, 'Posted.');
    await expect(page.locator('article.groups-post', { hasText: 'Accruals above 25k' })).toBeVisible();
    await accessible(page, 'Groups, a channel');
    await reflow(page, 'Groups, a channel');

    // The group's own feed does not hold the channel's post; the member, who has not joined the group, is refused.
    const channel = (await root.get(`/api/groups/${(await root.get('/api/groups')).find((g: { name: string }) => g.name === close).id}/channels`))[0];
    expect((await root.get(`/api/groups/${channel.parentId}/posts`)).map((x: { body: string }) => x.body)).not.toContain('Accruals above 25k need a ticket');
    expect((await root.get(`/api/groups/${channel.id}/members`)).length).toBe(1);
    await page.locator('[data-backparent]').click();
    await settle(page);
    await expect(page.locator('#main h1')).toHaveText(close);
    await root.close();
  });

  test('the distance and category filters ask the server; Trending shows a burst of joins after one run', async ({ page }) => {
    const root = await apiAs('root');
    // B-4403: within 50 km of Berlin: the Berlin and Potsdam groups, not Lisbon, nearest first.
    await open(page, 'groups');
    await page.locator('[data-fnear]').click();
    const nm = page.locator('#overlay .modal');
    await expect(nm).toContainText('Distance filter');
    await accessible(page, 'Distance filter dialog');
    await reflow(page, 'Distance filter dialog', true);
    await nm.locator('[data-npoint]').fill(`${BERLIN.lat}, ${BERLIN.lon}`);
    await nm.locator('[data-nkm]').selectOption('50');
    await nm.getByRole('button', { name: 'Apply' }).click();
    await settle(page);
    const names = page.locator('.leftpane [data-group]');
    await expect(names.filter({ hasText: close })).toHaveCount(1);
    await expect(names.filter({ hasText: potsdam })).toHaveCount(1);
    await expect(names.filter({ hasText: lisbon })).toHaveCount(0);
    await expect(names.first()).toContainText(close);
    await expect(names.filter({ hasText: potsdam })).toContainText('km');
    await page.locator('[data-fnear]').click();
    await page.locator('#overlay .modal').getByRole('button', { name: 'Clear' }).click();
    await settle(page);
    await expect(names.filter({ hasText: lisbon })).toHaveCount(1);

    // B-4405: the category filter.
    await page.locator('[data-fcat]').click();
    await page.locator('.dropdown button', { hasText: `Projects ${stamp}` }).click();
    await settle(page);
    await expect(names.filter({ hasText: close })).toHaveCount(1);
    await expect(names.filter({ hasText: potsdam })).toHaveCount(0);
    await page.locator('[data-fcat]').click();
    await page.locator('.dropdown button', { hasText: 'Any category' }).click();
    await settle(page);

    // B-4404: a burst of joins, one run from Social and messaging, then the Trending list.
    const member = await apiAs('member');
    const lis = (await root.get('/api/groups')).find((g: { name: string }) => g.name === lisbon);
    await member.post(`/api/groups/${lis.id}/join`);
    await open(page, 'social?tab=groups');
    await page.locator('[data-rungroups]').click();
    await toast(page, 'groups.trending queued');
    await expect(page.locator('.panel', { hasText: 'Trending groups' }).locator('tr', { hasText: lisbon })).toBeVisible({ timeout: 15_000 });
    await accessible(page, 'Social and messaging, Groups with categories and trending');
    await reflow(page, 'Social and messaging, Groups with categories and trending');
    await open(page, 'groups');
    await mode(page, 'Trending');
    await expect(page.locator('.leftpane [data-group]', { hasText: lisbon })).toContainText('join');
    await accessible(page, 'Groups, Trending');
    await reflow(page, 'Groups, Trending');
    await member.close();
    await root.close();
  });

  test.describe('as a member', () => {
    test.use({ user: 'member' });
    test('Discover lists joinable groups ranked by the server, never above the viewer’s clearance', async ({ page }) => {
      const root = await apiAs('root');
      const mem = await apiAs('member');
      const ws = serverState().workspace;
      // Sam Rivera is cleared for internal; this public group is labelled confidential.
      await root.post('/api/groups', { workspaceId: ws.id, name: `Above ${stamp}`, visibility: 'public', joinMode: 'open', label: 'confidential' });
      await open(page, 'groups');
      await expectLive(page);
      await mode(page, 'Discover');
      const items = page.locator('.leftpane [data-group]');
      await expect(items.filter({ hasText: potsdam })).toHaveCount(1);
      await expect(items.filter({ hasText: potsdam })).toContainText('shared member');
      await expect(items.filter({ hasText: `Above ${stamp}` })).toHaveCount(0);
      // What the server answered is what the list shows: ranked, joinable, never above the clearance.
      const disc = (await mem.get('/api/groups/discover')) as { groups: { name: string; label: string; role: string | null }[] };
      expect(disc.groups.every((g) => g.role === null)).toBe(true);
      expect(disc.groups.map((g) => g.name)).not.toContain(`Above ${stamp}`);
      await accessible(page, 'Groups, Discover');
      await reflow(page, 'Groups, Discover');
      // Joining from Discover.
      await items.filter({ hasText: potsdam }).click();
      await settle(page);
      await page.locator('[data-join]').click();
      await confirmDialog(page, 'Join');
      await toast(page, `Joined ${potsdam}`);
      await mem.close();
      await root.close();
    });
  });

  test('removing a category leaves its groups uncategorised, not hidden', async ({ page }) => {
    await open(page, 'social?tab=groups');
    const row = page.locator('.panel', { hasText: 'Group categories' }).locator('tr', { hasText: `Projects ${stamp}` });
    await expect(row).toContainText('1');
    await row.locator('[data-catremove]').click();
    await confirmDialog(page, 'Remove category');
    await toast(page, `Projects ${stamp} removed; 1 group uncategorised`);
    await expect(page.locator('#main')).toContainText('still listed, now uncategorised');
    await open(page, 'groups');
    await page.locator('[data-fcat]').click();
    await page.locator('.dropdown button', { hasText: 'Uncategorised' }).click();
    await settle(page);
    await expect(page.locator('.leftpane [data-group]', { hasText: close })).toHaveCount(1);
  });

  test('the new design states pass the accessibility checks and reflow', async ({ page }) => {
    for (const route of ['groups', 'social']) {
      await open(page, route);
      const titles = await page.evaluate((r) => ((window as unknown as AppGlobal).App.screens[r]!.states || []).map((s) => s.title), route);
      const ours = ['Channel below the group\'s label', 'Discover never shows a group above your clearance', 'Distance filter', 'Trending after a burst of joins', 'Uncategorised after a category is removed', 'Category removed, groups uncategorised'];
      for (const [i, title] of titles.entries()) {
        if (!ours.includes(title)) continue;
        await page.evaluate((k) => (window as unknown as AppGlobal).App.applyState(k), i);
        await settle(page);
        await expect(page.getByText('This screen failed to render')).toHaveCount(0);
        await accessible(page, `${route}: ${title}`);
        await reflow(page, `${route}: ${title}`);
      }
    }
  });
});
