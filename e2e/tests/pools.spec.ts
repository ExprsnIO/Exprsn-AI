import { test, expect, open, expectLive, toast } from './support/fixtures';

test.describe('Pools', () => {
  test('shows the live instance, adds a pool and loads a model through the memory planner', async ({ page }) => {
    await open(page, 'pools');
    await expectLive(page);
    const instance = page.locator('#main [data-inst]', { hasText: 'gpu-a-1' }).first();
    await expect(instance).toContainText('healthy');
    await expect(instance).toContainText('0.12.3');

    await page.locator('[data-addpool]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-pname]').fill('gpu-e2e');
    await modal.locator('[data-pceil]').selectOption('internal');
    await modal.locator('[data-pdesc]').fill('Pool added by the end-to-end suite');
    await modal.locator('[data-psave]').click();
    await toast(page, 'Pool gpu-e2e added');
    await expect(page.locator('#main')).toContainText(/gpu-e2e, cuda, zone inference, ceiling internal/i);

    await page.locator('[data-load]').click();
    const load = page.locator('#overlay .modal');
    await load.locator('[data-lmodel]').selectOption('llama-guard3:1b');
    await expect(load.locator('[data-plan]')).not.toContainText('Asking the memory planner');
    await load.locator('[data-do]').click();
    await expect(instance).toContainText('llama-guard3:1b', { timeout: 20_000 });
  });
});
