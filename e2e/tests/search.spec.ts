import { test, expect, open, expectLive, settle, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.0, Sprint 52 (B-170 to B-173): the Search screen. The box is a combobox driven by the keyboard alone ("/" opens
 * it, the arrow keys move through the suggestions, Escape closes them, Enter searches) and its counts are announced in
 * a status region; the results, the chat and post filters and the index tab pass the WCAG checker and axe-core
 * (Standard and Enhanced, light and dark) and reflow at 320 and 640 px. A post and a file are seeded through the API as
 * the member, and the tenant's index is turned on as root; the steps under test go through the console.
 */

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };
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

/** The member's post and file with an unusual word in them; the tenant's index on and built. */
async function seed(word: string): Promise<void> {
  const root = await apiAs('root');
  const st = await root.get('/api/admin/search');
  if (st.installed && !st.enabled) await root.post('/api/admin/search/enable', {});
  await expect.poll(async () => (await root.get('/api/admin/search')).state, { timeout: 30_000 }).toBe('ready');
  await root.close();
  const api = await apiAs('member');
  const ws = serverState().workspace.id;
  await api.post('/api/feed/posts', { workspaceId: ws, body: `The ${word} plan for the spring, with a ${word} budget` });
  const session = await (await api.ctx.get('/api/auth/session')).json();
  const r = await api.ctx.put(`/api/files/uploads?${new URLSearchParams({ name: `${word}-notes.txt`, workspace: ws }).toString()}`, { data: Buffer.from('notes'), headers: { 'x-csrf-token': session.csrf as string, origin: serverState().url, 'content-type': 'application/octet-stream' } });
  if (r.status() !== 202) throw new Error(`upload: ${r.status()} ${await r.text()}`);
  const id = (await r.json()).id as string;
  await expect.poll(async () => (await api.get(`/api/files/${id}`)).state, { timeout: 20_000 }).toBe('ready');
  // the post is indexed after its write
  await expect.poll(async () => (await api.get(`/api/search/posts?q=${word}`)).items.length, { timeout: 20_000 }).toBe(1);
  await api.close();
}

test.describe('Search (Sprint 52)', () => {
  test.use({ user: 'member' });

  test('the box is a combobox: "/" opens it, arrows move, Escape closes, Enter searches; counts are announced', async ({ page }) => {
    const word = `heliotrope${uid()}`.slice(0, 20).toLowerCase();
    await seed(word);
    await open(page, 'chat');
    await page.locator('#main h1').first().focus();
    await page.keyboard.press('/');
    await expect(page).toHaveURL(/#\/search/);
    const box = page.getByRole('combobox', { name: 'Search' });
    await expect(box).toBeFocused();
    await expectLive(page);

    await box.pressSequentially(word.slice(0, 8), { delay: 30 });
    const list = page.getByRole('listbox', { name: 'Suggestions' });
    await expect(list).toBeVisible();
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#search-status')).toContainText(/suggestion/);
    await expect(list.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    const first = list.getByRole('option').first();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(box).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
    await page.keyboard.press('ArrowUp');
    await expect(list.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(box).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();
    await expect(box).toBeFocused();

    // Enter with no suggestion chosen searches for what was typed (a beginning followed by * matches the word)
    await box.fill(`${word.slice(0, 8)}*`);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/q=/);
    await settle(page);
    await expect(page.getByRole('heading', { name: /Posts and comments/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Files/ })).toBeVisible();
    await expect(page.locator('#search-status')).toContainText(/result/);
    await expect(page.locator('#main mark').first()).toContainText(new RegExp(word.slice(0, 8), 'i'));

    // a suggestion opens its result: back in the box, choose the file
    await box.focus();
    await box.fill(word);
    await expect(list.getByRole('option', { name: new RegExp(`${word}-notes`) })).toBeVisible();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowDown');
      const name = await page.evaluate(() => { const id = document.getElementById('search-q')!.getAttribute('aria-activedescendant'); return id ? document.getElementById(id)!.textContent : ''; });
      if (name && name.includes(`${word}-notes`)) break;
    }
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/files\?file=/);
  });

  test('results, filters and the open list pass the checkers and reflow', async ({ page }) => {
    const word = `marigold${uid()}`.slice(0, 18).toLowerCase();
    await seed(word);
    await open(page, `search?q=${word}`);
    await expectLive(page);
    await expect(page.getByRole('heading', { name: /Posts and comments/ })).toBeVisible();
    await accessible(page, 'Search, all sources');
    await reflow(page, 'Search, all sources');

    // the list of suggestions, open
    const box = page.getByRole('combobox', { name: 'Search' });
    await box.focus();
    await box.fill(word.slice(0, 6));
    await expect(page.getByRole('listbox', { name: 'Suggestions' })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await accessible(page, 'Search, suggestions open');
    await reflow(page, 'Search, suggestions open');
    await page.keyboard.press('Escape');

    // the post filters
    await page.getByRole('tab', { name: 'Posts', exact: true }).click();
    await expect(page).toHaveURL(/source=posts/);
    await settle(page);
    await expect(page.getByRole('group', { name: 'Filters' })).toBeVisible();
    await page.getByLabel('Show').selectOption('post');
    await settle(page);
    await expect(page.locator('.search-hit')).toHaveCount(1);
    await accessible(page, 'Search, posts with filters');
    await reflow(page, 'Search, posts with filters');

    // the chat filters
    await page.getByRole('tab', { name: 'Chats', exact: true }).click();
    await settle(page);
    await page.getByRole('checkbox', { name: 'A link' }).check();
    await settle(page);
    await expect(page.getByText('Nothing found')).toBeVisible();
    await accessible(page, 'Search, chats with filters');
    await reflow(page, 'Search, chats with filters');
  });

  test.describe('as a tenant admin', () => {
    test.use({ user: 'root' });

    test('the index tab shows its state and its actions go through a confirmation', async ({ page }) => {
      await open(page, 'search?source=index');
      await expectLive(page);
      await expect(page.getByText('Search index', { exact: true }).first()).toBeVisible();
      await accessible(page, 'Search, the index');
      await reflow(page, 'Search, the index');
      const on = page.getByRole('button', { name: 'Turn the index on' });
      if (await on.count()) {
        await on.click();
        await page.getByRole('dialog').getByRole('button', { name: 'Turn on' }).click();
        await expect(page.getByText('The index is on; the backfill is running.')).toBeVisible();
      }
      await expect(page.getByRole('button', { name: 'Rotate the key' })).toBeVisible();
    });
  });
});
