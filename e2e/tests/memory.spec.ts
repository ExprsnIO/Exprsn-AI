import { test, expect, open, expectLive, toast } from './support/fixtures';

test.describe('Memory', () => {
  test('adds a personal memory and forgets it', async ({ page }) => {
    await open(page, 'memory');
    await expectLive(page);
    await expect(page.getByText('Nothing remembered yet')).toBeVisible();
    await page.getByRole('button', { name: 'Add a memory' }).first().click();
    const drawer = page.locator('#overlay .drawer');
    await drawer.locator('[data-text]').fill('Reports in thousands of EUR unless asked otherwise');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await toast(page, 'Saved as');
    await expect(page.locator('#main').getByText('Reports in thousands of EUR unless asked otherwise').first()).toBeVisible();

    await page.locator('[data-forget]').click();
    await page.locator('#overlay .modal').getByRole('button', { name: 'Forget everywhere' }).click();
    await expect(page.getByText('Nothing remembered yet')).toBeVisible();
  });
});
