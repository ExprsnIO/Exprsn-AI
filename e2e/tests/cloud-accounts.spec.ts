import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, confirmDialog, toast, apiAs } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.99-final, Sprint 56 (B-10002, B-10008, B-10009): Cloud › Accounts. Another system admin (ops) proposes a
 * platform AWS account; root sees it pending, approves it with a recent sign-in and it becomes connected. Root then
 * connects a Cloudflare account through the wizard (federation shown unavailable with the reason, the token checklist,
 * the regions) and it waits as pending. Accessibility in Standard and Enhanced, light and dark; no sideways scrolling
 * at 320 and 640 px, for the list, the wizard and the regions dialog. Sprint 58 (B-10602): root sets a monthly budget
 * on the approved account from the inspector; the Budget column shows it (the dialog checked the same way).
 */

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };

async function accessible(page: Page, where: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expectAccessible(page, `${where} (${scheme})`);
    for (const mode of ['aa', 'aaa'] as const) {
      await page.evaluate((m) => (window as unknown as AppGlobal).App.setA11y(m), mode);
      await expectAxeClean(page, mode, `${where} (${scheme}, ${mode})`);
    }
    await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y(null));
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
}

async function stepUpIfAsked(page: Page): Promise<void> {
  const dialog = page.locator('#overlay .modal', { hasText: 'Confirm it is you' });
  if (await dialog.isVisible({ timeout: 1500 }).catch(() => false)) {
    await dialog.locator('[data-supw]').fill(serverState().password);
    await dialog.locator('[data-sugo]').click();
  }
}

test.describe('Cloud › Accounts', () => {
  const suffix = Date.now().toString(36);
  const aws = `e2e-aws-${suffix}`;
  const cf = `e2e-cf-${suffix}`;

  test.beforeAll(async () => {
    const ops = await apiAs('ops');
    try {
      const out = await ops.post('/api/admin/cloud/accounts', {
        name: aws,
        provider: 'aws',
        scope: 'platform',
        providerIds: { awsAccountId: '777788889999' },
        credential: { mode: 'federated', params: { roleArn: 'arn:aws:iam::777788889999:role/exprsn-ai-deploy' } },
        regions: [{ region: 'eu-central-1' }, { region: 'us-east-1' }]
      });
      expect(out.proposal).toMatchObject({ kind: 'account.add', state: 'pending' });
    } finally {
      await ops.close();
    }
  });

  test.afterAll(async () => {
    const root = await apiAs('root');
    const ops = await apiAs('ops');
    try {
      for (const p of (await root.get('/api/admin/cloud/proposals?state=pending')) as { id: string; mine: boolean; summary: string }[]) {
        if (p.mine && p.summary.includes(suffix)) await root.post(`/api/admin/cloud/proposals/${p.id}/withdraw`).catch(() => undefined);
      }
      const accounts = ((await root.get('/api/admin/cloud/accounts')) as { accounts: { id: string; name: string; state: string }[] }).accounts;
      for (const a of accounts.filter((x) => x.name === aws && x.state !== 'pending')) {
        await root.del(`/api/admin/cloud/accounts/${a.id}/budget`).catch(() => undefined);
        const rm = await ops.del(`/api/admin/cloud/accounts/${a.id}`).catch(() => null);
        if (rm && rm.proposal) await root.post(`/api/admin/cloud/proposals/${rm.proposal.id}/approve`).catch(() => undefined);
      }
    } finally {
      await root.close();
      await ops.close();
    }
  });

  test('approves another admin\'s account, then connects a Cloudflare account that waits for approval', async ({ page, watch }) => {
    watch.allow.push(/POST \/api\/admin\/cloud\/proposals\/[0-9A-Z]{26}\/approve -> 401/);
    await open(page, 'cloud');
    await expectLive(page);
    const main = page.locator('#main');
    const row = main.locator('tr', { hasText: aws });
    await expect(row).toContainText('pending approval');
    await row.click();
    const insp = page.locator('aside.inspector');
    await expect(insp).toContainText('Waiting for a second cloud admin');
    await expect(insp).toContainText('cloud-account:');
    await accessible(page, 'Cloud accounts');
    await reflow(page, 'Cloud accounts');

    await insp.getByRole('button', { name: 'Approve' }).click();
    await confirmDialog(page, 'Approve');
    await stepUpIfAsked(page);
    await toast(page, 'Approved and applied');
    await expect(main.locator('tr', { hasText: aws })).toContainText('connected');

    // The regions dialog: zones and ceilings per region.
    await main.locator('tr', { hasText: aws }).click();
    await insp.getByRole('button', { name: 'Edit regions' }).click();
    const dialog = page.locator('#overlay .modal', { hasText: 'Regions for' });
    await expect(dialog).toContainText('cloud-eu');
    await accessible(page, 'Cloud accounts › Regions');
    await reflow(page, 'Cloud accounts › Regions');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // The wizard: Cloudflare offers no federation; the checklist names Containers Edit.
    await main.getByRole('button', { name: 'Connect account' }).first().click();
    await expect(main).toContainText('Step 1 of 4');
    await main.locator('[data-pick="cloudflare"]').click();
    await main.locator('[data-f="name"]').fill(cf);
    await accessible(page, 'Cloud accounts › Connect');
    await reflow(page, 'Cloud accounts › Connect');
    await main.getByRole('button', { name: 'Next' }).click();
    await expect(main.locator('[data-mode="federated"]')).toBeDisabled();
    await expect(main).toContainText('no workload identity federation');
    await main.locator('[data-ref="token"]').fill(`vault:cloud/${cf}#api_token`);
    await main.getByRole('button', { name: 'Next' }).click();
    await main.locator('[data-id-field="cloudflareAccountId"]').fill('0123456789abcdef0123456789abcdef');
    await expect(main).toContainText('Containers Edit');
    await main.getByRole('button', { name: 'Next' }).click();
    await expect(main).toContainText('Step 4 of 4');
    await main.getByRole('button', { name: 'Submit for approval' }).click();
    await confirmDialog(page, 'Send proposal');
    await toast(page, 'is listed as pending approval');
    await expect(main.locator('tr', { hasText: cf })).toContainText('pending approval');
    await expect(insp).toContainText('Token permission checklist');
    await expect(insp).toContainText(`vault:cloud/${cf}#api_token`);

    // Sprint 58 (B-10602): a monthly budget on the connected AWS account, set from the inspector.
    await main.locator('tr', { hasText: aws }).click();
    await expect(insp).toContainText('Monthly budget');
    await expect(main.locator('tr', { hasText: aws })).toContainText('none');
    await insp.getByRole('button', { name: 'Set budget' }).click();
    const budget = page.locator('#overlay .modal', { hasText: 'Monthly budget for' });
    await budget.locator('[data-amount]').fill('500');
    await accessible(page, 'Cloud accounts › Budget');
    await reflow(page, 'Cloud accounts › Budget');
    await budget.getByRole('button', { name: 'Save budget' }).click();
    await toast(page, 'Budget saved');
    await expect(main.locator('tr', { hasText: aws })).toContainText('0 % of 500.00 USD');
    await expect(insp).toContainText('Alerts at 50, 80 and 100 %');
    await expect(insp.getByRole('button', { name: 'Change budget' })).toBeVisible();
  });
});
