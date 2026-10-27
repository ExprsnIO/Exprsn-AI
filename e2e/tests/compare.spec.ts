import { test, expect, open, expectLive } from './support/fixtures';

test.describe('Compare', () => {
  test('sends one prompt to two profiles and streams both answers', async ({ page }) => {
    await open(page, 'compare');
    await expectLive(page);
    // Compare starts with every profile the label allows; keep the two this test compares (other specs seed more).
    for (const name of await page.locator('#main [data-remove]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.remove ?? ''))) {
      if (!['analyst', 'general'].includes(name)) await page.locator(`#main [data-remove="${name}"]`).click();
    }
    await page.locator('#cp-input').fill('Summarise the travel policy');
    await page.getByRole('button', { name: 'Send to 2' }).click();
    // Each profile's own column streams its own answer.
    const columns = page.locator('#main .cp-col');
    await expect(columns).toHaveCount(2);
    for (const profile of ['analyst', 'general']) {
      const column = columns.filter({ hasText: new RegExp(profile, 'i') });
      await expect(column).toHaveCount(1);
      await expect(column.getByText('Fake answer to: Summarise the travel policy')).toBeVisible({ timeout: 20_000 });
    }
    // The comparison is kept in the list on the left.
    await expect(page.locator('#main').getByText('No comparisons yet')).toHaveCount(0);
  });
});
