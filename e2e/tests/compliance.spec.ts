import { test, expect, open, expectLive, toast, confirmDialog, apiAs } from './support/fixtures';
import { expectAxeClean } from './support/axe';

/*
 * 1.6.0, Sprint 38c: the Compliance tab of Usage and audit. A DLP rule is created and tried (B-7601); a legal hold is
 * requested by one admin and approved by another, then released (B-7602); a compliance export is requested and comes
 * back ready (B-7603).
 */
const tab = async (page: import('@playwright/test').Page) => {
  await open(page, 'usage-audit');
  await expectLive(page);
  await page.locator('[data-tab="compliance"]').click();
  await expect(page.locator('#main')).toContainText('DLP: classification');
};

test.describe('Compliance', () => {
  test('DLP rules are kept and tried on a text', async ({ page, watch }) => {
    watch.allow.push(/DELETE \/api\/compliance\/dlp\/patterns/);
    await tab(page);
    const modal = page.locator('#overlay .modal');
    await page.locator('[data-patnew]').click();
    await modal.locator('[data-pname]').fill('Project codes');
    await modal.locator('[data-pexpr]').fill('PROJ-\\d{4}');
    await modal.locator('[data-psave]').click();
    await toast(page, 'Pattern Project codes created');
    await page.locator('[data-dlpnew]').click();
    await modal.locator('[data-rname]').fill('Cards and codes');
    await modal.locator('[data-rdet="payment_card"]').check();
    await modal.locator('[data-rdet^="pattern:"]').first().check();
    await modal.locator('[data-raction]').selectOption('redact');
    await modal.locator('[data-rsave]').click();
    await toast(page, 'DLP rule Cards and codes created');
    await expect(page.locator('#main')).toContainText('payment card, pattern Project codes');
    await page.locator('[data-dlptext]').fill('Pay 4111 1111 1111 1111 for PROJ-1234');
    await page.locator('[data-dlptry]').click();
    await expect(page.locator('#main')).toContainText('Cards and codes');
    await expect(page.locator('#main')).toContainText('[redacted payment card] for [redacted pattern:Project codes]');
    await expectAxeClean(page, 'aa', 'Usage and audit, Compliance tab');
    // A pattern in use cannot go.
    await page.locator('[data-patdel]').first().click();
    await confirmDialog(page, 'Remove');
    await expect(page.locator('#main')).toContainText('detects with this pattern');
    await page.locator('[data-dlpdel]').first().click();
    await confirmDialog(page, 'Remove');
    await toast(page, 'Rule Cards and codes removed');
    await page.locator('[data-patdel]').first().click();
    await confirmDialog(page, 'Remove');
    await toast(page, 'Pattern removed');
  });

  test('a legal hold goes through dual control and a compliance export is written', async ({ page, as }) => {
    const root = await apiAs('root');
    const member = ((await root.get('/api/admin/users')) as { username: string; id: string }[]).find((u) => u.username === 'member')!;
    const me = await root.get('/api/me');
    await root.close();
    await tab(page);
    const modal = page.locator('#overlay .modal');
    await page.locator('[data-holdnew]').click();
    await modal.locator('[data-hsubject]').fill(member.id);
    await modal.locator('[data-hreason]').fill('Litigation 2026-17: preserve everything.');
    const approver = modal.locator('[data-happrover]');
    await approver.selectOption({ label: 'Jon Lee (root2)' });
    await modal.locator('[data-hsave]').click();
    await toast(page, 'Hold requested');
    await expect(page.locator('#main')).toContainText('Litigation 2026-17');
    await expect(page.locator('[data-hold]').first()).toContainText('pending');
    // The requester cannot approve: only Withdraw is offered; the second admin approves.
    await expect(page.locator('[data-holdwithdraw]')).toHaveCount(1);
    const second = await as('root2');
    await tab(second);
    await second.locator('[data-holddecide$=":approved"]').first().click();
    await confirmDialog(second, 'Approve');
    await toast(second, 'Hold active');
    await expect(second.locator('[data-hold]').first()).toContainText('active');
    await second.locator('[data-holdrelease]').first().click();
    await confirmDialog(second, 'Release');
    await toast(second, 'Hold released');

    // An export for the member over the last 90 days.
    await page.locator('[data-cmpreload]').first().click();
    await page.locator('[data-cxnew]').click();
    await modal.locator('[data-cxuser]').fill(member.id);
    await modal.locator('[data-cxsave]').click();
    await toast(page, /Export compliance-[a-z0-9]+\.jsonl queued/);
    await expect(async () => {
      await page.locator('[data-cmpreload]').first().click();
      await expect(page.locator('#main')).toContainText('ready', { timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    expect(me.user.username).toBe('root');
  });
});
