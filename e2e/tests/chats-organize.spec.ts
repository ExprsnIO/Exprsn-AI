import { test, expect, open, expectLive } from './support/fixtures';
import { expectAxeClean } from './support/axe';

// 2026-10-15: conversation folders, message groups and the export formats. (Named to run after chat.spec.ts, which
// expects an empty conversation list.)
test.describe('Chat folders, message groups and exports', () => {
  test('files a conversation in a folder, groups messages and exports the group', async ({ page }) => {
    await open(page, 'chat');
    await expectLive(page);
    await page.locator('[data-pick="profile"]').click();
    await page.locator('.ch-dd [data-prof="general"]').click();
    await page.locator('#ch-composer').fill('Folder test question');
    await page.locator('#ch-composer').press('Enter');
    await expect(page.locator('.ch-msg.ch-ai .ch-answer').last()).toContainText('Fake answer to: Folder test question', { timeout: 20_000 });
    await expect(page.locator('.ch-caret')).toHaveCount(0);

    // A folder, then the conversation moved into it with the keyboard-operable dialog.
    await page.locator('[data-chfnew]').click();
    await page.locator('[data-chfname]').fill('Projects');
    await page.locator('[data-chfok]').click();
    const head = page.locator('[data-chftoggle]').filter({ hasText: 'Projects' });
    await expect(head).toBeVisible();
    const row = page.locator('.ch-crow').filter({ hasText: 'Folder test question' }).first();
    await row.locator('[data-chmove]').click();
    await page.locator('.ch-fpick label').filter({ hasText: 'Projects' }).locator('input').check();
    await page.locator('[data-chmok]').click();
    await expect(page.locator('.ch-fgroup').filter({ hasText: 'Projects' }).locator('[data-convo]')).toHaveCount(1);
    await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });
    await expectAxeClean(page, 'aa', 'chat with a folder');

    // Collapsing is remembered across a reload.
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.ch-fgroup').filter({ hasText: 'Projects' }).locator('[data-convo]')).toHaveCount(0);
    await page.reload();
    await expectLive(page);
    await expect(page.locator('[data-chftoggle]').filter({ hasText: 'Projects' })).toHaveAttribute('aria-expanded', 'false');
    await page.locator('[data-chftoggle]').filter({ hasText: 'Projects' }).click();

    // Filtering to the folder.
    await page.locator('[data-chffilter]').selectOption({ label: 'Projects' });
    await expect(page.locator('[data-convo]')).toHaveCount(1);
    await page.locator('[data-chffilter]').selectOption('all');

    // Select both messages and save them as a group, then open it.
    await page.locator('[data-convo]').filter({ hasText: 'Folder test question' }).first().click();
    await page.locator('.ch-head [data-chselect]').click();
    const boxes = page.locator('[data-chsel]');
    await expect(boxes).toHaveCount(2);
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(page.locator('.ch-selbar')).toContainText('2 messages selected');
    await page.locator('[data-chgsave]').click();
    await page.locator('[data-chgname]').fill('final answer');
    await page.locator('[data-chgok]').click();
    await expect(page.locator('[data-chgopen]').filter({ hasText: 'final answer' })).toBeVisible();
    await expect(page.locator('.ch-ingroup')).toHaveCount(2);
    await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });
    await expectAxeClean(page, 'aa', 'chat with a message group open');

    // Export the group as a PDF.
    await page.locator('[data-chgexport]').first().click();
    await page.locator('[data-xfmt]').selectOption('pdf');
    await page.locator('[data-xgo]').click();
    const link = page.locator('[data-xstate] a[download]');
    await expect(link).toBeVisible({ timeout: 20_000 });
    await expect(link).toHaveAttribute('download', /-group-[0-9a-z]{6}\.pdf$/);
    const res = await page.request.get((await link.getAttribute('href'))!);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
