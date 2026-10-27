import { test, expect, open, expectLive, toast, settle, apiAs, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.9.99-final, Sprint 62 (B-10607, B-10606): the Cloud spend screen, live from the `finops` board. The e2e server seeds
 * an AWS account billing in EUR (aws-spend) with 15 days of ingested rows, the NAT gateway cost tripled yesterday, a
 * fresh billing fetch, a 300 EUR budget past its hard stop and the anomaly the check found; the DigitalOcean account
 * (do-gpu) has no billing fetch, so its figures are estimates. Nothing reaches a cloud. Every tab and every state on the
 * board is reachable through App.applyState, passes the WCAG checker and axe-core (Standard and Enhanced) in light and
 * dark, and reflows at 320 and 640 px; the budget, override and acknowledge dialogs too; acknowledging is audited.
 */

type AppGlobal = { App: { screens: Record<string, { states?: { title: string }[] }>; applyState(i: number): void; closeOverlay(): void; setA11y(m: string | null): void } };

const STATES = ['No accounts connected', 'Loading', 'Ingestion failed', 'Budget hard stop', 'Anomaly detected', 'Permission denied', 'Estimates only'];
const TABS = ['overview', 'budgets', 'showback', 'anomalies', 'tokens', 'sources'];

async function checkAll(page: Page, where: string): Promise<void> {
  await expectAccessible(page, where);
  await expectAxeClean(page, 'aa', where);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y('aaa'));
  await expectAccessible(page, `${where}, Enhanced`);
  await expectAxeClean(page, 'aaa', `${where}, Enhanced`);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y(null));
}

async function tab(page: Page, id: string): Promise<void> {
  await page.locator(`#main [role="tab"][data-tab="${id}"]`).click();
  await settle(page);
}

async function applyState(page: Page, title: string): Promise<void> {
  const i = await page.evaluate((t) => ((window as unknown as AppGlobal).App.screens['cloud-spend']?.states ?? []).findIndex((s) => s.title === t), title);
  expect(i, title).toBeGreaterThanOrEqual(0);
  await page.evaluate((k) => (window as unknown as AppGlobal).App.applyState(k), i);
  await page.waitForTimeout(250);
  await settle(page);
}

/** What each board state shows once applied. */
async function expectState(page: Page, title: string): Promise<void> {
  const main = page.locator('#main');
  if (title === 'No accounts connected') await expect(main).toContainText('No cloud accounts connected');
  if (title === 'Loading') await expect(main).toContainText('Loading spend from cloud_costs');
  if (title === 'Ingestion failed') { await expect(main.locator('[role="tab"][data-tab="sources"]')).toHaveAttribute('aria-selected', 'true'); await expect(main).toContainText('Ingestion failed'); }
  if (title === 'Budget hard stop') { await expect(main.locator('[role="tab"][data-tab="budgets"]')).toHaveAttribute('aria-selected', 'true'); await expect(main.locator('aside.inspector')).toContainText('aws-spend'); await expect(main.locator('aside.inspector')).toContainText('budget_exceeded'); }
  if (title === 'Anomaly detected') { await expect(main.locator('[role="tab"][data-tab="anomalies"]')).toHaveAttribute('aria-selected', 'true'); await expect(main.locator('aside.inspector')).toContainText('Top contributors'); await expect(main.locator('aside.inspector')).toContainText('Amazon VPC NAT Gateway'); }
  if (title === 'Permission denied') await expect(main).toContainText('You need finops:read');
  if (title === 'Estimates only') { await expect(main).toContainText('Some figures are estimates'); await expect(main.locator('aside.inspector')).toContainText('Estimates only.'); await expect(main.locator('aside.inspector')).not.toContainText('aws-spend'); }
}

test.describe('Cloud spend', () => {
  test('shows the month, the hard stop, the anomaly with its contributors, showback, model tokens and sources', async ({ page }) => {
    await open(page, 'cloud-spend');
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main).toContainText('aws-spend');
    await expect(main).toContainText('Hard stop:');
    await expect(main).toContainText('Daily spend by provider');
    await expect(main.locator('svg.cloud-spend-chart')).toHaveCount(1);
    await expect(main).toContainText('Some figures are estimates');

    await tab(page, 'budgets');
    await main.locator('tr.row[data-acct]').filter({ hasText: 'aws-spend' }).click();
    await expect(main.locator('aside.inspector')).toContainText('Hard stop.');
    await expect(main.locator('aside.inspector')).toContainText('EUR 300');

    await tab(page, 'anomalies');
    const an = main.locator('tr.row[data-an]').filter({ hasText: 'aws-spend' });
    await expect(an).toContainText('Amazon VPC NAT Gateway +200 %');
    await an.click();
    const insp = main.locator('aside.inspector');
    await expect(insp).toContainText('Top contributors');
    await expect(insp).toContainText('eu-central-1');
    await expect(insp).toContainText('EUR 60.00 a day');

    await tab(page, 'showback');
    await expect(main).toContainText('Allocation rules');
    await main.locator('[data-sb] [data-seg="tenant"]').click();
    await expect(main.locator('[data-sb] [data-seg="tenant"]')).toHaveAttribute('aria-pressed', 'true');

    await tab(page, 'tokens');
    await expect(main).toContainText(/Cloud model calls are priced when they are metered/);

    await tab(page, 'sources');
    await expect(main).toContainText('Cost Explorer GetCostAndUsage');
    await expect(main.locator('tr').filter({ hasText: 'aws-spend' })).toContainText('used by the budget');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`every tab and board state passes the WCAG checks and axe-core (${scheme})`, async ({ page }) => {
      test.setTimeout(300_000);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await open(page, 'cloud-spend');
      for (const t of TABS) {
        await tab(page, t);
        await checkAll(page, `cloud-spend, ${t} (${scheme})`);
      }
      const titles = await page.evaluate(() => ((window as unknown as AppGlobal).App.screens['cloud-spend']?.states ?? []).map((s) => s.title));
      expect(titles).toEqual(STATES);
      for (const title of STATES) {
        await open(page, 'cloud-spend');
        await applyState(page, title);
        await expectState(page, title);
        await checkAll(page, `cloud-spend, state "${title}" (${scheme})`);
      }
      // The dialogs: the budget, the override request and the acknowledgement.
      await open(page, 'cloud-spend');
      await applyState(page, 'Budget hard stop');
      await page.locator('#main aside.inspector [data-budget]').click();
      await expect(page.locator('#overlay .modal')).toContainText('Budget for aws-spend');
      await checkAll(page, `cloud-spend, budget dialog (${scheme})`);
      await page.locator('#overlay .modal [data-close]').first().click();
      await page.locator('#main aside.inspector [data-override]').click();
      await expect(page.locator('#overlay .modal')).toContainText('Request budget override');
      await checkAll(page, `cloud-spend, override dialog (${scheme})`);
      await page.locator('#overlay .modal [data-close]').first().click();
      await applyState(page, 'Anomaly detected');
      await page.locator('#main aside.inspector [data-ack]').click();
      await expect(page.locator('#overlay .modal')).toContainText('Acknowledge anomaly');
      await checkAll(page, `cloud-spend, acknowledge dialog (${scheme})`);
      await page.locator('#overlay .modal [data-close]').first().click();
    });
  }

  for (const width of [320, 640]) {
    test(`every tab, state and dialog reflows at ${width} px`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'cloud-spend');
      for (const t of TABS) {
        await tab(page, t);
        expect.soft(await reflowProblems(page), `${t} at ${width} px`).toEqual([]);
      }
      for (const title of STATES) {
        await applyState(page, title);
        expect.soft(await reflowProblems(page), `state "${title}" at ${width} px`).toEqual([]);
      }
      await applyState(page, 'Budget hard stop');
      await page.locator('#main aside.inspector [data-budget]').click();
      await expect(page.locator('#overlay .modal')).toBeVisible();
      expect.soft(await reflowProblems(page), `budget dialog at ${width} px`).toEqual([]);
      await page.locator('#overlay .modal [data-close]').first().click();
    });
  }

  test('acknowledges the anomaly with a note, audited, and sets a budget', async ({ page }) => {
    await open(page, 'cloud-spend?tab=anomalies');
    const main = page.locator('#main');
    await main.locator('tr.row[data-an]').filter({ hasText: 'aws-spend' }).click();
    await main.locator('aside.inspector [data-ack]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-acknote]').fill('Image pulls after a node replacement');
    await modal.locator('[data-ackgo]').click();
    await toast(page, /acknowledged\. Audit entry cloud\.anomaly\.acknowledged written/);
    await expect(main.locator('tr.row[data-an]').filter({ hasText: 'aws-spend' })).toContainText('acknowledged');
    const root = await apiAs('root');
    const list = (await root.get('/api/admin/cloud/anomalies?state=acknowledged')) as { anomalies: { note: string; account: { name: string } }[] };
    expect(list.anomalies.find((a) => a.account.name === 'aws-spend')?.note).toBe('Image pulls after a node replacement');
    expect(((await root.get('/api/admin/audit?action=cloud.anomaly.acknowledged&limit=5')) as unknown[]).length).toBeGreaterThan(0);

    // A budget for do-gpu, with alerts only.
    await open(page, 'cloud-spend?tab=budgets');
    await main.locator('[data-budget][aria-label="Set budget for do-gpu"]').click();
    await modal.locator('[data-f="amount"]').fill('2000');
    await modal.locator('[data-f="stop"]').selectOption('off');
    await modal.locator('[data-save]').click();
    await toast(page, /Budget for do-gpu set to USD 2,000/);
    const b = (await root.get('/api/admin/cloud/budgets')) as { budgets: { account: { name: string }; status: { budget: { amount: number; hardStop: string } } }[] };
    expect(b.budgets.find((x) => x.account.name === 'do-gpu')?.status.budget).toMatchObject({ amount: 2000, hardStop: 'off' });
    await root.del(`/api/admin/cloud/accounts/${encodeURIComponent((await root.get('/api/admin/cloud/costs')).accounts.find((a: { account: { name: string } }) => a.account.name === 'do-gpu').account.id)}/budget`);
    await root.close();
  });
});
