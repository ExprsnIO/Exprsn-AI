import { test, expect, open, expectLive, toast } from './support/fixtures';

test.describe('Images', () => {
  test('generates an image on the fake worker and shows it with its provenance', async ({ page }) => {
    await open(page, 'images');
    await expectLive(page);
    await expect(page.locator('[data-generate]')).toBeDisabled();
    await page.locator('#images-prompt').fill('A lighthouse on a rocky coast at dusk, watercolour');
    await expect(page.locator('[data-generate]')).toBeEnabled();
    await page.locator('[data-generate]').click();
    await toast(page, 'image.generate job queued');
    await expect(page.locator('.images-card img').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#main')).toContainText('manifest signed by Exprsn-AI');
    // The image itself loads (the img element has pixels, served by /api/images/:id/image).
    await expect.poll(() => page.locator('.images-card img').first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  });
});
