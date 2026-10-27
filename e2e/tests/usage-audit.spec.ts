import { test, expect, open, expectLive, confirmDialog, toast, apiAs } from './support/fixtures';

test.describe('Usage and audit', () => {
  test('signs a checkpoint and verifies the audit chain', async ({ page }) => {
    await open(page, 'usage-audit');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Default chain');

    await page.locator('[data-checkpoint]').click();
    await confirmDialog(page);
    await toast(page, /Checkpoint signed at sequence \d+/);

    await page.locator('[data-verify]').click();
    await confirmDialog(page, 'Verify');
    await toast(page, /Default chain verified: [\d,]+ events, \d+ checkpoints/);

    // The audit log tab lists the checkpoint event.
    await page.locator('[data-tab="audit"]').click();
    await expect(page.locator('#main')).toContainText('audit.checkpoint');
  });

  // 1.6.0, Sprint 38a (B-7501): JSONL exports with a chain proof, and SIEM destinations under dual control.
  test('exports a JSONL window with its proof, and a SIEM destination needs a second admin', async ({ page, as, watch }) => {
    await open(page, 'usage-audit?tab=exports');
    await expectLive(page);
    const main = page.locator('#main');
    await main.getByRole('button', { name: 'New export' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-xcontent]').selectOption('jsonl');
    await expect(modal).toContainText('chain proof');
    await modal.locator('[data-xgo]').click();
    await toast(page, /Export queued: Audit JSONL with chain proof/);
    await expect(main.locator('.tablewrap').first()).toContainText('.jsonl');
    await expect.poll(async () => (await main.locator('.tablewrap').first().textContent()) ?? '', { timeout: 20_000 }).toMatch(/ready/);

    // Propose a syslog destination; the proposer cannot approve it (dual control); a second admin can.
    await main.getByRole('button', { name: 'Propose destination' }).click();
    const pm = page.locator('#overlay .modal');
    await pm.locator('[data-sname]').fill('Sentinel (syslog)');
    await pm.locator('[data-skind]').selectOption('syslog');
    await pm.locator('[data-surl]').fill('siem.example.com:6514');
    await pm.locator('[data-sgo]').click();
    await toast(page, /Proposed: Sentinel \(syslog\)/);
    await expect(main).toContainText('awaits a second admin');
    watch.allow.push(/POST \/api\/admin\/audit\/siem\/[^/]+\/approve -> 403/);
    await main.locator('[data-siemapprove]').first().click();
    await toast(page, /Dual control/);
    await expect(main).toContainText('awaits a second admin');

    const other = await as('root2');
    await open(other, 'usage-audit?tab=exports');
    await expect(other.locator('#main')).toContainText('Sentinel (syslog)');
    await other.locator('#main [data-siemapprove]').first().click();
    await toast(other, /now receives this tenant's audit events/);
    await expect(other.locator('#main')).toContainText('active');
    await other.close();

    // The decisions are on the chain.
    const root = await apiAs('root');
    const actions = ((await root.get('/api/admin/audit?limit=50')) as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['audit.siem.proposed', 'audit.siem.approved', 'audit.export.requested']));
    await root.close();
  });
});
