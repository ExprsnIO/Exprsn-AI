import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, open, expectLive, toast, confirmDialog, apiAs } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.8.0, Sprint 48 (B-144, B-145): Platform › Security scans (a result, its findings, an exception approved by a
 * second admin, the policy) and Platform › Vault seal (proposed by one platform admin, approved by another, then
 * unsealed on the unseal page with two of the e2e server's three escrow shares).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const TRIVY = JSON.parse(readFileSync(path.join(here, '..', '..', 'server', 'test', 'fixtures', 'security', 'trivy-image.json'), 'utf8')) as object;
const escrow = () => (serverState() as unknown as { escrow: { id: string; threshold: number; shares: string[] } }).escrow;

async function reflow(page: import('@playwright/test').Page, where: string) {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(350);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
}

/** Runs the console's step-up dialog when the server asks for a recent sign-in (sessions older than the window). */
async function stepUpIfAsked(page: import('@playwright/test').Page): Promise<void> {
  const modal = page.locator('#overlay .modal');
  const asked = await modal.filter({ hasText: 'Confirm it is you' }).waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
  if (!asked) return;
  await modal.locator('[data-supw]').fill(serverState().password);
  await modal.locator('[data-sugo]').click();
}

test.describe('Security scans and the vault seal', () => {
  test('shows a scan result and its findings, and an exception waits for a second admin', async ({ page, as, watch }) => {
    // In a long run the second admin's session is older than the step-up window: the first approve answers 401 step_up.
    watch.allow.push(/POST \/api\/admin\/security\/exceptions\/.*\/approve -> 401$/);
    const root = await apiAs('root');
    try {
      const r = await root.ctx.put(`/api/admin/security/scans/upload?kind=script-image&scannedAt=${Date.now()}`, { data: TRIVY, headers: { 'x-csrf-token': (await (await root.ctx.get('/api/auth/session')).json()).csrf, origin: serverState().url } });
      expect(r.status()).toBe(201);
    } finally {
      await root.close();
    }
    await open(page, 'platform');
    await expectLive(page);
    await page.locator('[data-tab="scans"]').click();
    await expect(page.locator('#main')).toContainText('Gate policy');
    await expect(page.locator('#main')).toContainText('allowed with a warning');
    const row = page.locator('#main tr', { hasText: 'Script image' }).first();
    await expect(row).toContainText('trivy');
    await expectAxeClean(page, 'aa', 'Platform › Security scans');
    await reflow(page, 'Platform › Security scans');

    await row.locator('[data-scan-view]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('CVE-2026-1001');
    await expect(modal).toContainText('openssl');
    await modal.locator('[data-ex-new="0"]').click();
    await modal.locator('[data-ex-reason]').fill('Not reachable: the image never terminates TLS.');
    await modal.locator('[data-ex-send]').click();
    await toast(page, 'Exception requested.');
    const ex = page.locator('#main tr', { hasText: 'Not reachable' }).first();
    await expect(ex).toContainText('pending');
    // The requester may only withdraw; a second platform admin approves.
    await expect(ex.locator('[data-ex-approve]')).toHaveCount(0);
    const other = await as('root2');
    await open(other, 'platform?tab=scans');
    const row2 = other.locator('#main tr', { hasText: 'Not reachable' }).first();
    await row2.locator('[data-ex-approve]').click();
    await confirmDialog(other, 'Approve');
    await stepUpIfAsked(other);
    await toast(other, 'Exception approved');
    await expect(other.locator('#main tr', { hasText: 'Not reachable' }).first()).toContainText('accepted by Jon Lee');
  });

  test('seals the vault under dual control and unseals it with two of three shares', async ({ page, as, watch }) => {
    // While sealed the consoles' own requests are refused on purpose (503 Vault sealed).
    watch.allow.push(/ -> 503$/);
    watch.allow.push(/POST \/api\/admin\/platform\/vault\/seal\/proposals(\/.*\/approve)? -> 401$/);
    await open(page, 'platform');
    await page.locator('[data-tab="seal"]').click();
    await expect(page.locator('#main')).toContainText('matches the running key');
    await expectAxeClean(page, 'aa', 'Platform › Vault seal');
    await reflow(page, 'Platform › Vault seal');
    await page.locator('[data-seal-propose]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-sp-reason]').fill('End-to-end drill of the emergency seal');
    await modal.locator('[data-sp-ok]').click();
    await stepUpIfAsked(page);
    await toast(page, 'Seal proposed.');
    await expect(page.locator('#main')).toContainText('A seal waits for a second platform admin');
    await expect(page.locator('[data-seal-approve]')).toHaveCount(0);

    const other = await as('root2');
    await open(other, 'platform?tab=seal');
    await other.locator('[data-seal-approve]').click();
    await confirmDialog(other, 'Seal the vault');
    await stepUpIfAsked(other);
    await other.waitForURL(/\/unseal\.html$/);
    await expect(other.locator('h1')).toHaveText('Unseal the vault');
    await expect(other.locator('#unseal-status')).toContainText('The vault is sealed');
    await expect(other.locator('#unseal-status')).toContainText('0 of 2');
    // Everything that needs a key refuses meanwhile; health answers.
    const api = await other.request.get('/api/me');
    expect(api.status()).toBe(503);
    expect((await api.json()).title).toBe('Vault sealed');
    expect((await other.request.get('/healthz')).status()).toBe(200);
    await expectAxeClean(other, 'aa', 'Unseal page');
    await reflow(other, 'Unseal page');

    const shares = escrow().shares;
    await other.locator('#unseal-share').fill(shares[0]!);
    await other.locator('#unseal-submit').click();
    await expect(other.locator('#unseal-result')).toContainText('1 of 2 shares are in');
    await expect(other.locator('#unseal-status')).toContainText('1 of 2');
    await other.locator('#unseal-share').fill(shares[2]!);
    await other.locator('#unseal-submit').click();
    await expect(other.locator('#unseal-result')).toContainText('The vault is unsealed.');
    await expect(other.locator('#unseal-title')).toHaveText('The vault is not sealed');

    // The console works again with the sessions it had.
    await page.goto('about:blank');
    await open(page, 'platform');
    await page.locator('[data-tab="seal"]').click();
    await expect(page.locator('#main')).toContainText(/unsealed/);
    expect((await page.request.get('/api/me')).status()).toBe(200);
  });
});
