import { test, expect, open, expectLive, toast, confirmDialog, ready } from './support/fixtures';

test.describe('Zones', () => {
  test('seeds the default zones, proposes a new zone and a second system admin approves it', async ({ page, as }) => {
    await open(page, 'zones');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('No zones defined');
    await page.locator('[data-seed]').first().click();
    await confirmDialog(page, 'Seed zones');
    await toast(page, /Created .*inference.*Audit event written/);
    await expect(page.locator('#main')).toContainText('sandbox');

    // Propose a new zone: it becomes a draft that the proposer cannot approve.
    await page.locator('[data-propose]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-pz]').selectOption('new zone');
    await modal.locator('[data-pid]').fill('lab');
    await modal.locator('[data-pmax]').selectOption('internal');
    await modal.locator('[data-pcidr]').fill('10.250.0.0/24');
    await modal.locator('[data-preason]').fill('CHG-2291 evaluation lab');
    await modal.locator('[data-pgo]').click();
    await toast(page, 'Zone lab proposed as draft v1. Another system admin must approve it.');

    const second = await as('root2');
    await second.goto('/#/zones');
    await ready(second, 'zones');
    await second.locator('#main tr[data-zone="lab"]').click();
    await second.locator('#main [data-diff]').first().click();
    const diff = second.locator('#overlay .modal');
    await expect(diff).toContainText('Rendered diff, lab v1');
    await expect(diff).toContainText('NetworkPolicy');
    await diff.locator('[data-approve]').click();
    await expect(second.locator('#toasts')).toContainText('lab v1 applied');
    await expect(second.locator('#main tr[data-zone="lab"]')).not.toContainText('draft');
  });
});
