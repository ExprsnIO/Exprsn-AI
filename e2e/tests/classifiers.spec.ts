import { test, expect, open, expectLive } from './support/fixtures';

test.describe('Classifiers', () => {
  test('classifies test text with the PII detector', async ({ page }) => {
    await open(page, 'classifiers');
    await expectLive(page);
    await expect(page.locator('#main h1')).toContainText('PII detector');
    await page.locator('[data-test]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-testtext]').fill('Contact jane.doe@northwind.example or pay into DE89 3704 0044 0532 0130 00.');
    await modal.locator('[data-classify]').click();
    await expect(modal.locator('[data-testresult]')).toContainText('Top label');
    await expect(modal.locator('[data-testresult]')).toContainText(/iban|email/);
    await expect(modal.locator('[data-testresult]')).toContainText('POST /api/classify');
  });
});
