import { test, expect, open, expectLive, settle, apiAs, confirmDialog, toast, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.9-qa (B-173 and B-169, the Sprint 52 leftovers): saved searches (save, list, run, rename, delete), searching
 * within one conversation from Messages, a search result's link that opens the exact message (older pages loaded,
 * focus moved to it, announced; a plain notice when it is gone), and a feature-flag gate that changes on an open page
 * without a reload. The pages pass the WCAG checker and axe-core (Standard and Enhanced, light and dark) and reflow
 * at 320 and 640 px. Data is seeded through the API; the steps under test go through the console.
 */

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void; flags: { live(): boolean } } };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

async function indexOn(): Promise<void> {
  const root = await apiAs('root');
  try {
    const st = await root.get('/api/admin/search');
    if (st.installed && !st.enabled) await root.post('/api/admin/search/enable', {});
    await expect.poll(async () => (await root.get('/api/admin/search')).state, { timeout: 30_000 }).toBe('ready');
  } finally {
    await root.close();
  }
}

/** A group conversation of the member's with ops, with `n` messages; returns its id and the messages' ids, oldest first. */
async function conversation(title: string, bodies: string[]): Promise<{ id: string; ids: string[] }> {
  const member = await apiAs('member');
  try {
    const people = (await member.get('/api/social/people')) as { userId: string; username: string }[];
    const ops = people.find((p) => p.username === 'ops')!;
    expect(ops).toBeTruthy();
    const conv = await member.post('/api/messaging/conversations', { kind: 'group', title, workspaceId: serverState().workspace.id, memberIds: [ops.userId] });
    const ids: string[] = [];
    for (const body of bodies) ids.push((await member.post(`/api/messaging/conversations/${conv.id}/messages`, { body })).id);
    return { id: conv.id, ids };
  } finally {
    await member.close();
  }
}

test.describe('Saved searches, search within, jump to the message (1.9.9-qa)', () => {
  test.use({ user: 'member' });

  test('saves a search with its filters, lists it, runs, renames and deletes it', async ({ page }) => {
    const word = `saffron${uid()}`.slice(0, 18).toLowerCase();
    await indexOn();
    const api = await apiAs('member');
    await api.post('/api/feed/posts', { workspaceId: serverState().workspace.id, body: `A ${word} note for the spring` });
    await expect.poll(async () => (await api.get(`/api/search/posts?q=${word}`)).items.length, { timeout: 20_000 }).toBe(1);
    expect((await api.get('/api/search/saved')).available).toBe(true);
    await api.close();

    await open(page, `search?q=${word}&source=posts`);
    await expectLive(page);
    await settle(page);
    await page.getByLabel('Show').selectOption('post');
    await settle(page);
    await page.getByRole('button', { name: 'Save this search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save this search' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('kind: post')).toBeVisible();
    await accessible(page, 'Save this search dialog');
    await dialog.getByLabel('Name').fill(`Spring ${word}`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await toast(page, `Saved as Spring ${word}.`);

    // the landing page lists it; running it searches with its filters
    await open(page, 'search');
    const saved = page.getByRole('region', { name: /Saved searches/ });
    await expect(saved.getByRole('button', { name: `Spring ${word}`, exact: true })).toBeVisible();
    await expect(saved).toContainText('kind: post');
    await accessible(page, 'Search, saved searches');
    await reflow(page, 'Search, saved searches');
    await saved.getByRole('button', { name: `Spring ${word}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`q=${word}`));
    await expect(page.locator('.search-hit')).toHaveCount(1);
    await expect(page.locator('#main mark').first()).toContainText(word);
    await expect(page.getByLabel('Show')).toHaveValue('post');

    // rename, then delete
    await open(page, 'search');
    await page.getByRole('button', { name: `Rename Spring ${word}` }).click();
    const rename = page.getByRole('dialog', { name: 'Rename saved search' });
    await rename.getByLabel('Name').fill(`Autumn ${word}`);
    await rename.getByRole('button', { name: 'Rename' }).click();
    await toast(page, `Renamed to Autumn ${word}.`);
    await page.getByRole('button', { name: `Delete Autumn ${word}` }).click();
    await confirmDialog(page, 'Delete');
    await toast(page, `Deleted Autumn ${word}.`);
    await expect(page.getByRole('button', { name: `Autumn ${word}`, exact: true })).toHaveCount(0);
  });

  test('searches within one conversation from Messages', async ({ page }) => {
    const word = `juniper${uid()}`.slice(0, 18).toLowerCase();
    await indexOn();
    const here = await conversation(`Within ${word}`, [`The ${word} plan is ready`]);
    await conversation(`Elsewhere ${word}`, [`Another ${word} plan elsewhere`]);
    const api = await apiAs('member');
    await expect.poll(async () => (await api.get(`/api/search/messages?q=${word}`)).items.length, { timeout: 20_000 }).toBe(2);
    await api.close();

    await open(page, `messages?convo=${here.id}`);
    await expectLive(page);
    await page.locator('[data-msearch]').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Search in this conversation' }).click();
    await expect(page).toHaveURL(/#\/search\?source=chats&conversation=/);
    const box = page.getByRole('combobox', { name: 'Search' });
    await expect(box).toBeFocused();
    await expect(page.getByText(`Searching only in the conversation Within ${word}.`)).toBeVisible();
    await accessible(page, 'Search within a conversation');
    await reflow(page, 'Search within a conversation');
    await box.fill(word);
    await page.keyboard.press('Enter');
    await settle(page);
    await expect(page.locator('.search-hit')).toHaveCount(1);
    await expect(page.locator('.search-hit')).toContainText(`Within ${word}`);
    // Search everywhere drops the conversation
    await page.getByRole('button', { name: 'Search everywhere' }).click();
    await settle(page);
    await expect(page.locator('.search-hit')).toHaveCount(2);
  });

  test('a result opens the exact message: older pages loaded, focus moved, announced; a gone message gets a notice', async ({ page }) => {
    test.setTimeout(120_000);
    const word = `tamarind${uid()}`.slice(0, 18).toLowerCase();
    await indexOn();
    const bodies = [`The ${word} decision, first of all`].concat(Array.from({ length: 55 }, (_, i) => `Filler message ${i + 1}`));
    const conv = await conversation(`Long ${word}`, bodies);
    const first = conv.ids[0]!;
    const api = await apiAs('member');
    await expect.poll(async () => (await api.get(`/api/search/messages?q=${word}`)).items.length, { timeout: 20_000 }).toBe(1);
    const gone = (await api.post(`/api/messaging/conversations/${conv.id}/messages`, { body: 'Soon deleted' })).id as string;
    await api.del(`/api/messaging/messages/${gone}`);
    await api.close();

    // from the search result's link
    await open(page, `search?q=${word}&source=chats`);
    await settle(page);
    const hit = page.locator('.search-hit a').first();
    await expect(hit).toHaveAttribute('href', `#/messages?convo=${conv.id}&message=${first}`);
    await hit.click();
    const target = page.locator(`[data-msg="${first}"]`);
    await expect(target).toBeFocused({ timeout: 15_000 });
    await expect(target).toHaveClass(/messages-jumped/);
    await expect(target).toContainText(`The ${word} decision`);
    await expect(page.locator('#messages-jumpstatus')).toContainText('Showing the linked message');
    await accessible(page, 'Messages, jumped to a message');
    await reflow(page, 'Messages, jumped to a message');

    // a deleted message: its tombstone, marked, with a plain notice
    await open(page, `messages?convo=${conv.id}&message=${gone}`);
    await expect(page.locator(`[data-msg="${gone}"]`)).toBeFocused({ timeout: 15_000 });
    await expect(page.getByText('That message was deleted. Its place in the conversation is marked.', { exact: true })).toBeVisible();
    // one the reader cannot see (or that never was): the same plain notice, nothing else
    await open(page, `messages?convo=${conv.id}&message=01J00000000000000000000000`);
    await expect(page.getByText('That message is no longer there: it was deleted, or you can no longer see it.', { exact: true })).toBeVisible();
    await expect(page.locator('#messages-jumpstatus')).toContainText('no longer there');
    await accessible(page, 'Messages, linked message gone');
  });

  test('a feature-flag gate changes on an open page, without a reload', async ({ page }) => {
    const KEY = 'e2e-live-gate';
    const root = await apiAs('root');
    try {
      await root.post('/api/me/step-up', { password: serverState().password });
      const list = await root.get('/api/admin/feature-flags');
      if (!list.flags.some((f: { key: string }) => f.key === KEY)) await root.post('/api/admin/feature-flags', { key: KEY, type: 'boolean', defaultValue: false, state: 'active', description: 'Changes live in the e2e suite', owner: 'e2e' });
      await root.del(`/api/admin/feature-flags/${KEY}/tenant`).catch(() => undefined);
    } finally {
      await root.close();
    }
    await open(page, 'search');
    await expectLive(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as AppGlobal).App.flags.live())).toBe(true);
    await page.evaluate((k) => {
      const box = document.createElement('div');
      box.innerHTML = `<p id="e2e-live-on" data-feature-flag="${k}">The new way is on</p><p id="e2e-live-off" data-feature-flag="!${k}">The old way</p>`;
      document.querySelector('#main .page')!.appendChild(box);
    }, KEY);
    await expect(page.locator('#e2e-live-on')).toBeHidden();
    await expect(page.locator('#e2e-live-off')).toBeVisible();
    const marker = await page.evaluate(() => { (window as unknown as { __noReload: number }).__noReload = 1; return 1; });

    const admin = await apiAs('root');
    try {
      await admin.put(`/api/admin/feature-flags/${KEY}/tenant`, { value: true });
      await expect(page.locator('#e2e-live-on')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#e2e-live-off')).toBeHidden();
      await accessible(page, 'Search, a live flag gate on');
      await admin.del(`/api/admin/feature-flags/${KEY}/tenant`);
      await expect(page.locator('#e2e-live-on')).toBeHidden({ timeout: 10_000 });
      await expect(page.locator('#e2e-live-off')).toBeVisible();
    } finally {
      await admin.close();
    }
    // the same page all along: no reload happened
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(marker);
  });
});
