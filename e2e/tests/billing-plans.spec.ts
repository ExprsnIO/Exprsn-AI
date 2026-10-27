import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, toast, apiAs, confirmDialog } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.0, Sprint 51 (B-162, B-166): Usage and audit › Billing. A platform admin proposes a plan, a second one (root2,
 * through the API) approves it, the tenant subscribes, previews a seat change with its proration, changes it, pauses,
 * resumes and cancels at period end; discounts and promotion codes are listed. Accessibility in Standard and Enhanced,
 * light and dark; no sideways scrolling at 320 and 640 px.
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
  const modal = page.locator('#overlay .modal').filter({ hasText: 'Confirm it is you' });
  const asked = await modal.waitFor({ timeout: 2500 }).then(() => true).catch(() => false);
  if (!asked) return;
  await modal.locator('[data-supw]').fill(serverState().password);
  await modal.locator('[data-sugo]').click();
}

test.describe('Usage and audit › Billing: plans and the subscription', () => {
  test('proposes, approves, subscribes, changes seats, pauses and cancels at period end', async ({ page, watch }) => {
    watch.allow.push(/ -> 401$/); // step-up, when the session is older than the window
    const key = `e2e-team-${Date.now().toString(36)}`;
    await open(page, 'usage-audit?tab=billing');
    await expectLive(page);
    const plans = page.locator('#main section[data-bp="plans"]');
    await expect(plans).toBeVisible();

    // A platform admin proposes a plan; it is not subscribable until a second one approves it.
    await page.locator('[data-bpnew]').click();
    const m = page.locator('#overlay .modal');
    await m.locator('[data-bpname]').fill('E2E Team');
    await m.locator('[data-bpkey]').fill(key);
    await m.locator('[data-pf="price"]').first().fill('30');
    await m.locator('[data-pf="seat"]').first().fill('10');
    await m.locator('[data-allow="prompt_tokens"]').fill('1000000');
    await m.locator('[data-bpent]').fill('feature.export = true');
    await accessible(page, 'Billing, new plan dialog');
    await m.locator('[data-bpsave]').click();
    await stepUpIfAsked(page);
    await toast(page, 'Plan proposed');
    const row = plans.locator('tr', { hasText: 'E2E Team' });
    await expect(row).toContainText('pending');
    await expect(row).toContainText('another platform admin approves it');

    const root2 = await apiAs('root2');
    try {
      const list = await root2.get('/api/admin/billing/plans');
      const plan = list.plans.find((x: { key: string }) => x.key === key);
      await root2.post(`/api/admin/billing/plans/${plan.id}/versions/1/approve`, {});
    } finally {
      await root2.close();
    }
    await page.reload();
    await expect(page.locator('#main section[data-bp="plans"] tr', { hasText: 'E2E Team' })).toContainText('30.00 USD');

    // Subscribe, unless an earlier run left a subscription.
    const sub = page.locator('#main section[data-bp="subscription"]');
    if (await sub.locator('[data-bpsub]').count()) {
      await sub.locator('[data-bpsub]').click();
      const s = page.locator('#overlay .modal');
      await s.locator('[data-bsplan]').selectOption({ label: 'E2E Team' });
      await s.locator('[data-bsanchor]').fill('1');
      await s.locator('[data-bssave]').click();
      await toast(page, 'Subscribed');
    }
    await expect(sub).toContainText('This period');
    await accessible(page, 'Billing with a subscription');

    // A seat change, previewed with its proration, then applied.
    await sub.locator('[data-bpchange]').click();
    const c = page.locator('#overlay .modal');
    await c.locator('[data-bcseats]').fill(String(Number(await sub.locator('.kv').innerText().then((t) => (/Seats\s+(\d+)/.exec(t) || [])[1] || '1')) + 2));
    await c.locator('[data-bcpreview]').click();
    await expect(c.locator('[data-bcout]')).toContainText('Due now');
    await accessible(page, 'Billing, change dialog with a preview');
    await c.locator('[data-bcsave]').click();
    await toast(page, 'Subscription changed');
    await expect(sub).toContainText('Seats changed');

    // Pause, resume, cancel at period end and keep.
    await sub.locator('[data-bppause]').click();
    await confirmDialog(page, 'Pause');
    await toast(page, 'Subscription paused');
    await expect(sub).toContainText('Paused');
    await sub.locator('[data-bpresume]').click();
    await confirmDialog(page, 'Resume');
    await toast(page, 'Subscription resumed');
    await sub.locator('[data-bpcancel]').click();
    await confirmDialog(page, 'Cancel at period end');
    await toast(page, 'ends at the end of the period');
    await expect(sub).toContainText('After that the tenant is billed by usage alone');
    await accessible(page, 'Billing, ending at period end');
    await sub.locator('[data-bpkeep]').click();
    await confirmDialog(page, 'Keep it');
    await toast(page, 'renews as usual');

    await expect(page.locator('#main section[data-bp="discounts"]')).toContainText('Promotion codes');
    await accessible(page, 'Usage and audit › Billing');
    await reflow(page, 'Usage and audit › Billing');
  });
});
