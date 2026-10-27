import Database from 'better-sqlite3';
import { test, expect, open, expectLive, ready, confirmDialog, apiAs, toast, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

// 1.9.99-final, Sprint 61 (B-10508): the Models screen's cloud parts against the e2e server's Bedrock fake (inside the
// AWS fake; nothing reaches AWS). The provider filter; the cloud catalogue lists what the account offers in a region and
// imports Claude 3 Haiku as a draft; it is evaluated on the Bedrock instance and approved by a second admin; its card
// shows provider and account, region, price (refreshed from the AWS Price List fake), residency, the provider guardrail
// layer (a Bedrock Guardrail set from the card) and AI Gateway. The screen, the catalogue and the card's dialogs pass
// the WCAG checker and axe-core (Standard and Enhanced, light and dark) and reflow at 320 and 640 px. The spec removes
// what it made, so the Models spec after it sees the catalogue as the server seeded it.

const HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';
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
    await page.waitForTimeout(200);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

test.describe('Models: cloud backends', () => {
  let poolId = '';
  let instanceId = '';

  test.beforeAll(async () => {
    const bedrock = serverState().fakes.bedrock;
    if (!bedrock) throw new Error('the e2e server did not start the Bedrock fake');
    const api = await apiAs('root');
    const pool = await api.post('/api/admin/pools', { name: 'bedrock-e2e', accelerator: 'cpu', labelCeiling: 'internal' });
    poolId = pool.id;
    instanceId = (await api.post(`/api/admin/pools/${pool.id}/instances`, { name: 'bedrock-eu-central-1', kind: 'bedrock', deploy: 'docker', cloud: { accountId: bedrock.accountId, region: 'eu-central-1' } })).id;
    await api.close();
  });

  test.afterAll(async () => {
    // Removes the imported model and the Bedrock instance and pool, so later specs see the catalogue as seeded.
    const file = serverState().dbFile;
    if (file) {
      const db = new Database(file);
      try {
        const ids = (db.prepare('SELECT id FROM models WHERE name = ?').all(HAIKU) as { id: string }[]).map((r) => r.id);
        for (const id of ids) {
          db.prepare('DELETE FROM placements WHERE model_id = ?').run(id);
          db.prepare('DELETE FROM cloud_model_entries WHERE model_id = ?').run(id);
          db.prepare('DELETE FROM models WHERE id = ?').run(id);
        }
        db.prepare('DELETE FROM placements WHERE pool_id = ?').run(poolId);
        db.prepare('DELETE FROM instances WHERE id = ?').run(instanceId);
        db.prepare('DELETE FROM pools WHERE id = ?').run(poolId);
      } finally {
        db.close();
      }
    }
  });

  test('imports a Bedrock model from the cloud catalogue, evaluates it and a second admin approves it', async ({ page, as }) => {
    await open(page, 'models');
    await expectLive(page);

    // The provider filter: every seeded model is an Ollama model.
    await page.getByRole('button', { name: 'Provider: all' }).click();
    await page.locator('.dropdown button', { hasText: 'Bedrock' }).click();
    await expect(page.locator('#main')).toContainText('0 of');
    await page.getByRole('button', { name: 'Provider: Bedrock' }).click();
    await page.locator('.dropdown button', { hasText: 'all' }).first().click();

    // The cloud catalogue: the account's models in eu-central-1, with model access and the ceiling.
    await page.getByRole('button', { name: 'Cloud catalogue' }).click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Models the connected cloud accounts offer');
    await modal.locator('[data-f="account"]').selectOption({ label: 'aws-bedrock (Bedrock)' });
    await modal.locator('[data-f="region"]').selectOption('eu-central-1');
    await modal.getByRole('button', { name: 'List models' }).click();
    const haikuRow = modal.getByRole('row', { name: new RegExp(`^${HAIKU.replace(/\./g, '\\.')} `) });
    await expect(haikuRow).toContainText('granted');
    await expect(modal.locator('tr', { hasText: 'meta.llama3-8b-instruct-v1:0' })).toContainText('Model access is not granted');
    await accessible(page, 'models, cloud catalogue');
    await reflow(page, 'models, cloud catalogue');
    await modal.getByRole('button', { name: `Import ${HAIKU}` }).click();
    const imp = page.locator('#overlay .modal');
    await expect(imp).toContainText(`Import ${HAIKU} as a draft`);
    await expect(imp.locator('[data-f="label"]')).toHaveValue('internal');
    await imp.getByRole('button', { name: 'Import draft' }).click();
    await toast(page, 'registered as a draft from aws-bedrock');

    // The row: provider Bedrock, the region, a draft; the provider filter finds it.
    const row = page.locator('#main tr', { hasText: HAIKU });
    await expect(row).toContainText('Bedrock');
    await expect(row).toContainText('eu-central-1');
    await expect(row).toContainText('draft');
    await page.getByRole('button', { name: 'Provider: all' }).click();
    await page.locator('.dropdown button', { hasText: 'Bedrock' }).click();
    await expect(page.locator('#main')).toContainText('1 of');
    await row.click();

    // The card: provider and account, region, price, residency, the guardrail layer, AI Gateway.
    const card = page.locator('#main .inspector');
    await expect(card).toContainText('account aws-bedrock');
    await expect(card).toContainText('Runs in eu-central-1 only.');
    await expect(card).toContainText('Not attested: the ceiling stays internal.');
    await expect(card).toContainText('none on the provider side');
    await expect(card).toContainText('Exprsn-AI\'s own checkpoints run before and after it');
    await expect(card.locator('.kv > div', { hasText: 'AI Gateway' })).toContainText('off');
    // The price: the sheet's (unverified) until the AWS Price List answers; then the API's, dated.
    await card.getByRole('button', { name: 'Refresh prices' }).click();
    await toast(page, 'Prices refreshed from the AWS Price List API');
    await expect(card.locator('.kv > div', { hasText: 'Price' })).toContainText('$0.25 in, $1.25 out per 1M tokens');
    await expect(card.locator('.kv > div', { hasText: 'Price' })).toContainText('AWS Price List, effective 2026-10-01');

    // The provider guardrail, set from the card (Bedrock confirms it exists).
    await card.getByRole('button', { name: 'Set guardrail' }).click();
    const gm = page.locator('#overlay .modal');
    await gm.locator('[data-f="gid"]').fill(serverState().fakes.bedrock!.guardrail);
    await gm.locator('[data-f="gver"]').fill('1');
    await accessible(page, 'models, Bedrock Guardrail dialog');
    await reflow(page, 'models, Bedrock Guardrail dialog');
    await gm.getByRole('button', { name: 'Save guardrail' }).click();
    await toast(page, 'Bedrock Guardrail gre2e01 on');
    await expect(card.locator('.kv > div', { hasText: 'Provider guardrail' })).toContainText('Bedrock Guardrail gre2e01 version 1, attached to Converse');

    // Evaluate on the Bedrock instance; the requester cannot approve (dual control).
    await page.locator('[data-evaluate]').click();
    await confirmDialog(page, 'Run evaluation');
    await expect(row).toContainText('evaluated', { timeout: 30_000 });
    await expect(page.locator('[data-approve]')).toBeDisabled();
    await accessible(page, 'models, a Bedrock model\'s card');
    await reflow(page, 'models, a Bedrock model\'s card');

    const second = await as('root2');
    await second.goto('/#/models');
    await ready(second, 'models');
    await second.locator('#main tr', { hasText: HAIKU }).click();
    await expect(second.locator('[data-approve]')).toBeEnabled();
    await second.locator('[data-approve]').click();
    await confirmDialog(second, 'Approve');
    await expect(second.locator('#main tr', { hasText: HAIKU })).toContainText('approved');
  });
});
