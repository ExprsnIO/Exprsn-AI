import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, toast, apiAs } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.9-qa (QA-1): User stores › a Microsoft Entra ID store with its Graph directory › "Import users". The dry run
 * counts what the import would do (two accounts to make, one disabled in the directory left out) and changes nothing;
 * the run makes the two accounts with the mapped role, with the job's progress shown. Accessibility in Standard and
 * Enhanced, light and dark, on the dialog before and after the dry run; no sideways scrolling at 320 and 640 px. The
 * store is archived afterwards; the two accounts stay, as test data.
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

test.describe('User stores › import a cloud directory', () => {
  const name = 'E2E Entra import ' + Date.now().toString(36);
  let storeId = '';

  test.beforeAll(async () => {
    const graph = serverState().fakes.graph!;
    const root = await apiAs('root');
    try {
      const me = await root.get('/api/me');
      await root.post('/api/vault/policies', { subjectKind: 'user', subject: me.user.id, path: 'kv/identity/e2e-entra', capabilities: ['*'] }).catch(() => undefined);
      await root.put('/api/vault/kv/data/identity/e2e-entra', { data: { clientSecret: graph.clientSecret, rpSecret: 'e2e-rp-secret' } });
      const store = await root.post('/api/admin/identity-providers', {
        name,
        kind: 'oidc',
        enabled: false,
        config: { issuer: graph.url, clientId: 'e2e-rp', clientSecret: 'vault:identity/e2e-entra#rpSecret', usernameClaim: 'preferred_username', subjectClaim: 'oid', directory: { api: 'msgraph', tokenUrl: graph.tokenUrl, apiUrl: `${graph.url}/v1.0`, clientId: graph.clientId, clientSecret: 'vault:identity/e2e-entra#clientSecret' } }
      });
      storeId = store.id;
      await root.post('/api/admin/group-mappings', { providerId: storeId, group: 'E2E Staff', role: 'member', clearance: 'internal' });
    } finally {
      await root.close();
    }
  });

  test.afterAll(async () => {
    const root = await apiAs('root');
    try {
      if (storeId) {
        await root.post(`/api/admin/identity-providers/${storeId}/archive`, {}).catch(() => undefined);
        await root.del(`/api/admin/identity-providers/${storeId}`).catch(() => undefined);
      }
    } finally {
      await root.close();
    }
  });

  test('dry run first, then the import makes the accounts as a first sign-in would', async ({ page }) => {
    await open(page, `directories?store=${storeId}`);
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main.locator('aside.inspector')).toContainText(name);
    await main.locator('[data-dimport]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('A dry run comes first and changes nothing.');
    await expect(modal.locator('[data-dirun]')).toHaveCount(0);
    await accessible(page, 'Directory import › before the dry run');
    await reflow(page, 'Directory import › before the dry run');

    await modal.locator('[data-didry]').click();
    await expect(modal).toContainText('Dry run finished');
    await expect(modal).toContainText('Directory users');
    await expect(modal).toContainText('disabled in the directory');
    await expect(modal.locator('[data-dirun]')).toHaveText('Import 2 accounts');
    await accessible(page, 'Directory import › after the dry run');
    await reflow(page, 'Directory import › after the dry run');

    await modal.locator('[data-dirun]').click();
    await expect(modal).toContainText('Import finished');
    await expect(modal).toContainText('Accounts made or linked');
    await toast(page, /Import finished: 2 accounts made or linked/);
    await modal.locator('[data-close]').first().click();

    await page.locator('[data-tab="users"]').click();
    await expect(main).toContainText('nia@contoso.test');
    await expect(main).toContainText('oli@contoso.test');
    await expect(main).not.toContainText('pax@contoso.test');
  });
});
