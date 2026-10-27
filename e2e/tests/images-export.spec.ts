import { test, expect, open, expectLive, toast, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 2026-10-16: Images › Export. One image as JPEG XL with its options (bits, HDR, region of interest, tiles), two as one
// GIF animation, JPEG refused for two, and an export saved into Files. The e2e server's converter is a fake that says
// in its notes which options reached it (e2e/server.ts); the real one is the sandboxed exprsn-imgconv container.

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };
const dialog = (page: Page) => page.locator('#overlay .modal');

async function exportDialog(page: Page) {
  await page.locator('[data-export]').click();
  await expect(dialog(page).locator('h2')).toHaveText('Export');
}

test.describe('Images: export', () => {
  test.beforeAll(async () => {
    const root = await apiAs('root');
    const have = ((await root.get('/api/images')) as { state: string }[]).filter((i) => i.state === 'succeeded').length;
    if (have < 2) await root.post('/api/images', { prompt: 'A lighthouse on a rocky coast at dusk, watercolour', backend: (await root.get('/api/images/backends')).backends[0].id, width: 1024, height: 768, count: 2, label: 'internal' });
  });

  test('exports JPEG XL with its options, two images as a GIF animation, and checks the dialog', async ({ page }) => {
    await open(page, 'images');
    await expectLive(page);
    await expect.poll(() => page.locator('.images-card img').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await page.locator('.images-card').first().click();
    await exportDialog(page);
    const d = dialog(page);
    await d.locator('[data-x="format"]').selectOption('jxl');
    await d.locator('[data-x="bitDepth"]').selectOption('16');
    await d.locator('[data-x="hdr"]').selectOption('pq');
    await expect(d.locator('[data-x="sdrWhite"]')).toHaveValue('203');
    await d.locator('[data-x="roi"]').check();
    await d.locator('[data-x="roiX"]').fill('25');
    await d.locator('[data-x="roiY"]').fill('40');
    await d.locator('[data-x="tile"]').selectOption('512');
    await d.locator('[data-x="lossless"]').check();
    // Both checkers, Standard and Enhanced, light and dark; and the dialog reflows.
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await expectAccessible(page, `images export dialog (${scheme})`);
      for (const mode of ['aa', 'aaa'] as const) {
        await page.evaluate((m) => (window as unknown as AppGlobal).App.setA11y(m), mode);
        await expectAxeClean(page, mode, `images export dialog (${scheme}, ${mode})`);
      }
      await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y(null));
    }
    await page.emulateMedia({ colorScheme: 'light' });
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(300);
      expect.soft(await reflowProblems(page), `images export dialog at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const [jxl] = await Promise.all([page.waitForEvent('download'), d.locator('[data-xgo]').click()]);
    expect(jxl.suggestedFilename()).toMatch(/^image-[a-z0-9]+\.jxl$/);
    await toast(page, 'JPEG XL: bit_depth 16, hdr "pq", lossless true');
    await expect(page.locator('#toasts .toast').last()).toContainText('roi {"x":0.25,"y":0.4}');
    await expect(page.locator('#toasts .toast').last()).toContainText('tile_size 512');

    // Two images: one animation; JPEG holds one.
    await exportDialog(page);
    await d.locator('[data-xpick]').nth(1).check();
    await expect(d.locator('legend', { hasText: 'Images (2 chosen)' })).toBeVisible();
    await d.locator('[data-x="format"]').selectOption('jpg');
    await expect(d).toContainText('JPEG holds one image');
    await expect(d.locator('[data-xgo]')).toBeDisabled();
    await d.locator('[data-x="format"]').selectOption('gif');
    await d.locator('[data-x="frameMs"]').fill('250');
    const [gif] = await Promise.all([page.waitForEvent('download'), d.locator('[data-xgo]').click()]);
    expect(gif.suggestedFilename()).toBe('images-2.gif');
    await toast(page, '2 frames');
  });

  test('saves an export into Files in the chosen workspace', async ({ page }) => {
    await open(page, 'images');
    await expectLive(page);
    await page.locator('.images-card').first().click();
    await exportDialog(page);
    const d = dialog(page);
    await d.locator('[data-x="format"]').selectOption('webp');
    await d.locator('[data-x="quality"]').fill('82');
    await d.locator('[data-xto] [data-seg="files"]').click();
    await expect(d.locator('[data-x="workspaceId"]')).toBeVisible();
    await expect(d.locator('[data-x="folderId"]')).toBeEnabled();
    await d.locator('[data-x="name"]').fill('lighthouse-export');
    await expect(d.locator('[data-xgo]')).toHaveText('Save to Files');
    await expectAxeClean(page, 'aa', 'images export to Files');
    const ws = await d.locator('[data-x="workspaceId"]').inputValue();
    await d.locator('[data-xgo]').click();
    await toast(page, 'Saved to Files as lighthouse-export.webp');
    const root = await apiAs('root');
    const listing = await root.get('/api/files/browse?workspace=' + encodeURIComponent(ws));
    expect((listing.files as { name: string }[]).map((f) => f.name)).toContain('lighthouse-export.webp');
  });
});
