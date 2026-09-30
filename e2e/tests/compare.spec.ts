import { test, expect, open, expectLive } from './support/fixtures';

test.describe('Compare', () => {
  test('sends one prompt to two profiles and streams both answers', async ({ page }) => {
    await open(page, 'compare');
    await expectLive(page);
    await page.locator('#cp-input').fill('Summarise the travel policy');
    await page.getByRole('button', { name: 'Send to 2' }).click();
    for (const col of ['analyst', 'general']) {
      await expect(page.locator('#main').getByText('Fake answer to: Summarise the travel policy').first()).toBeVisible({ timeout: 20_000 });
      void col;
    }
    await expect(page.locator('#main').getByText('Fake answer to: Summarise the travel policy')).toHaveCount(2, { timeout: 20_000 });
    // The comparison is kept in the list on the left.
    await expect(page.locator('#main').getByText('No comparisons yet')).toHaveCount(0);
  });
});
