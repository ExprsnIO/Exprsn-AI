import { test, expect, open, expectLive, confirmDialog, toast, settle } from './support/fixtures';

test.describe('Roles and access', () => {
  test('every cell of the effective-access matrix opens its explain steps', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, 'roles');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('platform:manage');
    await page.getByRole('tab', { name: /Effective access/ }).click();
    await settle(page);
    const matrix = page.locator('[data-effmatrix]');
    await expect(matrix).toBeVisible();
    // Every body cell is one explain control: rows × the area's permissions.
    const rows = await matrix.locator('tbody tr').count();
    const perms = await matrix.locator('thead th').count() - 1;
    expect(rows).toBeGreaterThan(0);
    expect(perms).toBeGreaterThan(5);
    const cells = matrix.locator('tbody td');
    await expect(cells).toHaveCount(rows * perms);
    await expect(matrix.locator('tbody td button.roles-cell[data-cell]')).toHaveCount(rows * perms);
    for (let i = 0; i < rows * perms; i++) {
      const cell = matrix.locator('button.roles-cell').nth(i);
      const allowed = await cell.evaluate((el) => el.classList.contains('allow'));
      if (i % 2) await cell.click();
      else { await cell.focus(); await page.keyboard.press('Enter'); }
      const drawer = page.locator('#overlay .drawer');
      await expect(drawer.locator('[data-explain]')).toBeVisible();
      await expect(drawer.locator('[data-steps] li')).toHaveCount(5);
      await expect(drawer.locator('[data-steps]')).toContainText('role');
      await expect(drawer.locator('[data-steps]')).toContainText('zone ceiling');
      await expect(drawer.locator('.kv')).toContainText(allowed ? 'allow' : 'deny');
      await page.keyboard.press('Escape');
      await expect(page.locator('#overlay')).toHaveCount(0);
      // Focus goes back to the cell that opened it.
      await expect(cell).toBeFocused();
    }
  });

  test('who can lists the holders and opens explain for a row', async ({ page }) => {
    await open(page, 'roles');
    await page.getByRole('button', { name: 'Who can…' }).click();
    await settle(page);
    await page.locator('[data-effperm]').selectOption('platform:manage');
    await settle(page);
    await expect(page.locator('#main')).toContainText('Who can platform:manage');
    const row = page.locator('#main tr[data-cell]', { hasText: 'Mara Okafor' });
    await row.click();
    await expect(page.locator('#overlay .drawer [data-steps] li')).toHaveCount(5);
  });

  test('a custom role with an admin permission waits for a second admin, who approves it', async ({ page, as }) => {
    const name = `Close reviewer ${Date.now().toString(36)}`;
    await open(page, 'roles');
    await page.getByRole('tab', { name: /Custom roles/ }).click();
    await settle(page);
    await page.getByRole('button', { name: 'Create role' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-rn]').fill(name);
    await modal.locator('[data-rd]').fill('Reviews flags during the close.');
    await modal.locator('input[data-rp][value="flags:review"]').check();
    await modal.locator('input[data-rp][value="records:read"]').check();
    await modal.getByRole('button', { name: 'Create', exact: true }).click();
    await toast(page, 'waits for a second admin');
    await expect(page.locator('#main')).toContainText('Dual control pending.');
    await expect(page.locator('#main')).toContainText('You proposed it');

    // The second admin approves it from the same screen.
    const other = await as('root2');
    await open(other, 'roles');
    await other.getByRole('tab', { name: /Custom roles/ }).click();
    await settle(other);
    await other.locator('#main tr[data-role]', { hasText: name }).click();
    await settle(other);
    await other.getByRole('button', { name: 'Approve as second admin' }).click();
    await confirmDialog(other, 'Approve');
    await toast(other, 'approved and in force');
    await expect(other.locator('#main tr[data-role]', { hasText: name })).toContainText('active');

    // Now in the role matrix as a custom role.
    await other.getByRole('tab', { name: /Role matrix/ }).click();
    await settle(other);
    await expect(other.locator('#main .roles-matrix thead')).toContainText(name);
  });

  test('an access review is created and a grant confirmed from the screen', async ({ page }) => {
    const name = `ML admin certification ${Date.now().toString(36)}`;
    await open(page, 'roles');
    await page.getByRole('tab', { name: /Access reviews/ }).click();
    await settle(page);
    await page.locator('[data-newcampaign]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-cn]').fill(name);
    await modal.locator('[data-ck]').selectOption('role');
    await modal.locator('[data-cr]').selectOption('ml-admin');
    await modal.getByRole('button', { name: 'Create', exact: true }).click();
    await toast(page, 'authz.review.created written');
    await settle(page);
    await expect(page.locator('#main h2')).toContainText(name);
    const row = page.locator('#main tr[data-item]', { hasText: 'Asha Patel' });
    await row.getByRole('button', { name: 'Confirm' }).click();
    await toast(page, 'confirmed');
    await expect(row).toContainText('confirmed');
  });
});
