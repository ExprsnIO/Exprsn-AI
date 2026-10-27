import { deflateSync } from 'node:zlib';
import { test, expect, open, expectLive, ready, settle, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.0, Sprint 53 (B-177 to B-179): an album's grid and its slideshow, by keyboard (alt text shown, reduced motion
 * respected); an album share link's page and an upload link's page, signed out. Each view and the slideshow pass the
 * WCAG checker and axe-core (Standard and Enhanced, light and dark) and reflow at 320 and 640 px. Albums, files and
 * links are seeded through the API as the member; the steps under test go through the console.
 */

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** A 1x1 PNG whose grey level is `n` (so each upload is a different file). */
function png(n: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, n % 256]))), chunk('IEND', Buffer.alloc(0))]);
}

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

/** The member's album of three public pictures (one with alt text), in the e2e workspace. */
async function seedAlbum(title: string): Promise<{ id: string; api: Awaited<ReturnType<typeof apiAs>> }> {
  const api = await apiAs('member');
  const ws = serverState().workspace.id;
  const session = await (await api.ctx.get('/api/auth/session')).json();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await api.ctx.put(`/api/files/uploads?${new URLSearchParams({ name: `${title}-${i + 1}.png`, workspace: ws, label: 'public' }).toString()}`, { data: png(40 + i * 60), headers: { 'x-csrf-token': session.csrf as string, origin: serverState().url, 'content-type': 'image/png' } });
    if (r.status() !== 202) throw new Error(`upload: ${r.status()} ${await r.text()}`);
    ids.push((await r.json()).id);
  }
  for (const id of ids) await expect.poll(async () => (await api.get(`/api/files/${id}`)).state, { timeout: 20_000 }).toBe('ready');
  await api.put(`/api/files/${ids[0]}/meta`, { altText: 'A red kite over the hill' });
  const album = await api.post('/api/albums', { kind: 'workspace', title, description: 'Pictures from the walk', workspaceId: ws, label: 'public' });
  await api.post(`/api/albums/${album.id}/items`, { fileIds: ids });
  return { id: album.id, api };
}

test.describe('Albums (Sprint 53)', () => {
  test.use({ user: 'member' });

  test('the grid and the slideshow work by keyboard, with alt text shown', async ({ page }) => {
    const title = `Walk ${uid()}`;
    const { id, api } = await seedAlbum(title);
    await api.close();

    await open(page, 'albums');
    await expectLive(page);
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
    await accessible(page, 'Albums, the list');
    await reflow(page, 'Albums, the list');

    await open(page, `albums?album=${id}`);
    await expectLive(page);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const tiles = page.locator('#main .albums-tile');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.first().locator('img')).toHaveAttribute('alt', 'A red kite over the hill');
    await settle(page);
    await accessible(page, 'Albums, an album');
    await reflow(page, 'Albums, an album');

    // the slideshow: Enter on a tile opens it, the arrows move, Home and End jump, Escape closes and returns focus
    await tiles.first().focus();
    await page.keyboard.press('Enter');
    const show = page.locator('#overlay .modal.albums-show');
    await expect(show).toBeVisible();
    await expect(show.locator('[data-alt]')).toHaveText('A red kite over the hill');
    await expect(show.locator('[data-pos]')).toContainText('Photo 1 of 3');
    // reduced motion: no autoplay is offered
    await expect(show.locator('[data-play]')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(show.locator('[data-pos]')).toContainText('Photo 2 of 3');
    await expect(show.locator('[data-alt]')).toContainText('no alt text was written');
    await page.keyboard.press('End');
    await expect(show.locator('[data-pos]')).toContainText('Photo 3 of 3');
    await page.keyboard.press('ArrowRight');
    await expect(show.locator('[data-pos]')).toContainText('Photo 1 of 3');
    await accessible(page, 'Albums, the slideshow');
    await reflow(page, 'Albums, the slideshow');
    await page.keyboard.press('Escape');
    await expect(show).toHaveCount(0);
    await expect(tiles.first()).toBeFocused();
  });
});

test.describe('Album links, signed out (Sprint 53)', () => {
  test.use({ user: null });

  test('a share link shows the album\'s grid and slideshow without signing in', async ({ page }) => {
    const title = `Shared walk ${uid()}`;
    const root = await apiAs('root');
    const me = await root.get('/api/me');
    await root.put(`/api/admin/tenants/${me.tenant.id}/sharing`, { anonymousLinks: true });
    await root.close();
    const { id, api } = await seedAlbum(title);
    const link = await api.post(`/api/albums/${id}/share-links`, { mode: 'download', expiresInHours: 24 });
    await api.close();

    await page.goto('/#/shared?t=' + link.token);
    await ready(page, 'shared');
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    // the token is taken out of the address bar at once
    expect(page.url()).not.toContain(link.token);
    const tiles = page.locator('#main .alb-tile');
    await expect(tiles).toHaveCount(3);
    await settle(page);
    await accessible(page, 'Album share link');
    await reflow(page, 'Album share link');
    await tiles.nth(1).focus();
    await page.keyboard.press('Enter');
    const show = page.locator('#overlay .modal.albums-show');
    await expect(show.locator('[data-pos]')).toContainText('Photo 2 of 3');
    await page.keyboard.press('ArrowLeft');
    await expect(show.locator('[data-alt]')).toHaveText('A red kite over the hill');
    await accessible(page, 'Album share link, the slideshow');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Download all' })).toBeVisible();
  });

  test('an upload link asks the uploader\'s name and sends photos to the album', async ({ page }) => {
    const title = `Party ${uid()}`;
    const { id, api } = await seedAlbum(title);
    const link = await api.post(`/api/albums/${id}/upload-links`, { maxFiles: 5, expiresInHours: 24 });

    await page.goto('/#/shared?t=' + link.token);
    await ready(page, 'shared');
    await expect(page.getByRole('heading', { name: `Send photos to ${title}` })).toBeVisible();
    await accessible(page, 'Album upload link');
    await reflow(page, 'Album upload link');
    await page.getByLabel('Your name').fill('Aunt Jo');
    await page.locator('#main [data-ufiles]').setInputFiles({ name: 'cake.png', mimeType: 'image/png', buffer: png(200) });
    await expect(page.locator('#main')).toContainText(/cake\.png: (received|added)/, { timeout: 20_000 });
    await expect(page.locator('#main')).toContainText('Up to 4 more files');
    await accessible(page, 'Album upload link, after sending');

    // the owner sees it with the name as given, and it joins the album once its scan passed
    await expect.poll(async () => ((await api.get(`/api/albums/${id}/uploads`)) as { uploaderName: string; state: string }[]).map((u) => `${u.uploaderName}:${u.state}`), { timeout: 20_000 }).toEqual(['Aunt Jo:added']);
    await api.close();
  });
});
