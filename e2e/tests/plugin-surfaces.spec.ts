import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.7.0 (Sprint 43, B-11203): plugin UI surfaces. A declarative plugin's surfaces are approved from Plugins and events;
// its settings surface is drawn there and its record surface beside a record in Apps, by the console's own helpers.
// Disabling a surface takes it away. The panels pass the WCAG checker and axe-core and reflow at 320 and 640 px.

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };

// The manifest of server/test/sprint43-plugin-surfaces.test.ts (FIXTURE).
const FIXTURE = {
  key: 'deal-notes',
  name: 'Deal notes',
  version: '1.0.0',
  kind: 'declarative',
  capabilities: ['read:records', 'write:records'],
  optionalCapabilities: ['write:records'],
  ui: [
    { id: 'about', slot: 'settings', title: 'Deal notes', blocks: [{ type: 'text', text: 'Shows a summary of a deal beside it.' }] },
    {
      id: 'deal-summary',
      slot: 'record',
      title: 'Deal summary',
      app: 'crm',
      entity: 'deal',
      capabilities: ['read:records'],
      data: { deal: { api: 'records.read', with: { app: 'crm', entity: 'deal', id: '{{context.record}}' } } },
      blocks: [
        { type: 'text', text: 'From the record you are looking at.' },
        { type: 'kv', data: 'deal', items: [{ label: 'Title', path: 'record.values.title' }, { label: 'Amount', path: 'record.values.amount' }] }
      ]
    },
    {
      id: 'deal-close',
      slot: 'record',
      title: 'Close the deal',
      app: 'crm',
      entity: 'deal',
      capabilities: ['write:records'],
      actions: { close: { api: 'records.write', with: { app: 'crm', entity: 'deal', action: 'update', id: '{{context.record}}', values: { amount: 0 } } } },
      blocks: [{ type: 'action', label: 'Zero the amount', action: 'close', confirm: 'Set the amount to zero?' }]
    }
  ]
};

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
    await page.waitForTimeout(200);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

test.describe('Plugin UI surfaces (Sprint 43)', () => {
  test('surfaces are approved from Plugins, drawn in their slots, and a disabled one goes away', async ({ page }) => {
    const root = await apiAs('root');
    const app = await root.post('/api/apps', { name: 'crm', title: 'CRM', label: 'internal', workspaceId: null });
    await root.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', maxLength: 120, indexed: true }, { name: 'amount', type: 'number' }] } });
    await root.post('/api/apps/crm/entities/deal/records', { values: { title: 'Northwind renewal', amount: 1200 }, label: 'internal' });
    const plugin = await root.post('/api/admin/plugins', { manifest: FIXTURE, grants: ['read:records'], maxLabel: 'internal' });
    await root.post(`/api/admin/plugins/${plugin.id}/enable`, { reason: 'e2e' });

    // approve the settings surface and the record surface from the inspector; the write surface waits for its grant
    await open(page, `plugins?id=${plugin.id}`);
    await expectLive(page);
    const insp = page.locator('.plugins-insp');
    await expect(insp).toContainText('UI surfaces');
    await expect(insp.getByRole('button', { name: 'Approve the surface Close the deal' })).toBeDisabled();
    await insp.getByRole('button', { name: 'Approve the surface Deal notes' }).click();
    await confirmDialog(page, 'Approve');
    await toast(page, 'Deal notes approved');
    await insp.getByRole('button', { name: 'Approve the surface Deal summary' }).click();
    await confirmDialog(page, 'Approve');
    await toast(page, 'Deal summary approved');
    const settings = insp.locator('[data-psurf]');
    await expect(settings).toHaveCount(1);
    await expect(settings).toContainText('Deal notes · Deal notes');
    await expect(settings).toContainText('Shows a summary of a deal beside it.');
    await settle(page);
    await accessible(page, 'plugins: the inspector with UI surfaces');
    await reflow(page, 'plugins: the inspector with UI surfaces');

    // the record surface beside a deal reads it as the viewer
    await open(page, `apps?app=${app.id}&tab=records`);
    await expectLive(page);
    await page.locator('tr[data-rec]').first().click();
    const panel = page.locator('aside[aria-label="Record"] [data-psurf]');
    await expect(panel).toHaveCount(1);
    await expect(panel).toContainText('Deal summary · Deal notes');
    await expect(panel).toContainText('Northwind renewal');
    await expect(panel).toContainText('1200');
    await settle(page);
    await accessible(page, 'apps: a record with a plugin surface');
    await reflow(page, 'apps: a record with a plugin surface');

    // disabling the surface from Plugins takes it away from the record
    await open(page, `plugins?id=${plugin.id}`);
    await page.locator('.plugins-insp').getByRole('button', { name: 'Disable the surface Deal summary' }).click();
    await confirmDialog(page, 'Disable');
    await toast(page, 'Deal summary disabled');
    await open(page, `apps?app=${app.id}&tab=records`);
    await page.locator('tr[data-rec]').first().click();
    await expect(page.locator('aside[aria-label="Record"]')).toContainText('Northwind renewal');
    await expect(page.locator('aside[aria-label="Record"] [data-psurf]')).toHaveCount(0);
    await root.close();
  });
});
