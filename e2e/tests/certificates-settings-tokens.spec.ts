import type { Page } from '@playwright/test';
import { test, expect, open, apiAs, toast } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.0, Sprint 55 (B-187, B-188, B-195): Certificates › Settings and Certificates › Tokens. A tenant setting is saved
 * from the console and shows its source; a root change is proposed by one platform admin and approved by the second
 * (root2) in another browser; a CA token is issued, shown once, checked and revoked. Accessibility in Standard and
 * Enhanced, light and dark, for both tabs and the token dialog; no sideways scrolling at 320 and 640 px.
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

/** Answers the step-up check (B-106) if the server asks for a fresh sign-in, then waits for `done`. */
async function stepUpThen(page: Page, done: RegExp): Promise<void> {
  const stepUp = page.locator('#overlay .modal', { hasText: 'Confirm it is you' });
  const ok = page.locator('#toasts .toast').filter({ hasText: done }).first();
  await expect(stepUp.or(ok)).toBeVisible();
  if (await stepUp.isVisible()) {
    await stepUp.locator('[data-supw]').fill(serverState().password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(ok).toBeVisible();
  }
}

test.describe('Certificates › Settings and Tokens', () => {
  test.beforeAll(async () => {
    // The CA hierarchy the tabs work on: a platform root and this tenant's issuing CA (made through the API if missing).
    const root = await apiAs('root');
    try {
      await root.post('/api/me/step-up', { password: serverState().password });
      const issuers = (await root.get('/api/pki/issuers')).issuers as { kind: string; state: string }[];
      if (!issuers.some((i) => i.kind === 'root' && i.state === 'active')) await root.post('/api/pki/issuers', { kind: 'root', commonName: 'E2E Platform Root CA' });
      if (!issuers.some((i) => i.kind === 'intermediate' && i.state === 'active')) await root.post('/api/pki/issuers', { kind: 'intermediate' });
    } finally {
      await root.close();
    }
  });

  test('saves a tenant setting with its source, and puts a root change under dual control', async ({ page, as, watch }) => {
    watch.allow.push(/PUT \/api\/pki\/settings -> 401$/, /\/approve -> 401$/);
    await open(page, 'certificates?tab=settings');
    const main = page.locator('#main');
    const ocsp = main.locator('[data-csgroup="ocsp"]');
    await expect(ocsp).toBeVisible();
    await expect(main.locator('[data-csgroup="members"]')).toContainText('Off by default');
    await accessible(page, 'Certificates › Settings (this tenant)');
    await reflow(page, 'Certificates › Settings (this tenant)');

    // A tenant may tighten the OCSP answer validity; the source becomes "this tenant".
    await ocsp.locator('[data-cs="ocsp.validityMinutes"]').fill('15');
    await ocsp.locator('[data-cssave="ocsp"]').click();
    await toast(page, /Saved: ocsp\.validityMinutes/);
    await expect(main.locator('[data-csgroup="ocsp"] .certificates-cs-row', { hasText: 'OCSP answer validity' })).toContainText('this tenant');
    // Out of range: refused, with the reason in the panel.
    watch.allow.push(/PUT \/api\/pki\/settings -> 422$/);
    await main.locator('[data-cs="ocsp.cacheSeconds"]').fill('9999999');
    await main.locator('[data-cssave="ocsp"]').click();
    await expect(main.locator('[data-cserr="ocsp"]')).toContainText(/OCSP cache/);

    // The platform's root: a proposal for the second platform admin.
    await main.locator('[data-csscope] [data-seg="platform"]').click();
    const rootPanel = main.locator('[data-csgroup="root"]');
    await expect(rootPanel).toContainText('second admin');
    await rootPanel.locator('[data-cs="root.keyType"]').selectOption('ecdsa-p384');
    await rootPanel.locator('[data-cssave="root"]').click();
    await page.locator('#overlay .modal').getByRole('button', { name: 'Propose', exact: true }).click();
    await stepUpThen(page, /Saved for a second platform admin/);
    await expect(main.getByText('Waiting for a second platform admin')).toBeVisible();
    await accessible(page, 'Certificates › Settings (platform, a proposal waiting)');
    await reflow(page, 'Certificates › Settings (platform)');

    // root2 approves it in another browser; nothing is re-keyed until the next rotation.
    const second = await as('root2');
    await open(second, 'certificates?tab=settings');
    await second.locator('#main [data-csscope] [data-seg="platform"]').click();
    await second.locator('#main [data-csapprove]').first().click();
    await second.locator('#overlay .modal').getByRole('button', { name: 'Approve', exact: true }).click();
    await stepUpThen(second, /Approved/);
    const api = await apiAs('root');
    try {
      const view = await api.get('/api/pki/settings');
      expect(view.platform.find((x: { key: string }) => x.key === 'root.keyType').value).toBe('ecdsa-p384');
      expect(view.issuers.root.keyType).not.toBe('ecdsa-p384');
      // Put things back for other specs (a proposal again, approved by the API as root2).
      await api.post('/api/me/step-up', { password: serverState().password });
      const back = await api.put('/api/pki/settings', { scope: 'platform', reset: ['root.keyType'] });
      const r2 = await apiAs('root2');
      try {
        await r2.post('/api/me/step-up', { password: serverState().password });
        await r2.post(`/api/pki/settings/proposals/${back.proposal.id}/approve`, {});
      } finally {
        await r2.close();
      }
      await api.put('/api/pki/settings', { scope: 'tenant', reset: ['ocsp.validityMinutes'] });
    } finally {
      await api.close();
    }
  });

  test('issues a CA token shown once, checks it and revokes it', async ({ page }) => {
    await open(page, 'certificates?tab=tokens');
    const main = page.locator('#main');
    await expect(main.getByText('Token signers')).toBeVisible();
    await accessible(page, 'Certificates › Tokens');
    await reflow(page, 'Certificates › Tokens');

    await main.locator('[data-ctissue]').click();
    const m = page.locator('#overlay .modal').filter({ hasText: 'Issue a CA token' });
    await m.locator('[data-ctrid]').fill('https://files.e2e.internal/docs/');
    await m.locator('[data-ctperm="append"]').check();
    await m.locator('[data-ctlabel]').fill('e2e docs');
    await accessible(page, 'Certificates › Tokens: issue dialog');
    await m.getByRole('button', { name: 'Issue', exact: true }).click();
    await toast(page, 'Token issued.');
    const shown = main.locator('.certificates-ct-token');
    await expect(shown).toBeVisible();
    const token = (await shown.textContent())!.trim();
    expect(token).toMatch(/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
    await expect(main.locator('tr', { hasText: 'https://files.e2e.internal/docs/' }).first()).toContainText('read, append');
    await reflow(page, 'Certificates › Tokens with a new token');
    await main.locator('[data-ctdone]').click();
    await expect(main.locator('.certificates-ct-token')).toHaveCount(0);

    // Check it: introspection says it is active.
    await main.locator('[data-ctcheck]').click();
    const c = page.locator('#overlay .modal').filter({ hasText: 'Check a token' });
    await c.locator('[data-ctin]').fill(token);
    await c.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(c.locator('[data-ctout]')).toContainText('Active.');
    await c.getByRole('button', { name: 'Close' }).click();

    // Revoke it.
    await main.locator('tr', { hasText: 'https://files.e2e.internal/docs/' }).first().getByRole('button', { name: /Revoke/ }).click();
    await page.locator('#overlay .modal').getByRole('button', { name: 'Revoke', exact: true }).click();
    await toast(page, 'Token revoked.');
    const api = await apiAs('root');
    try {
      expect((await api.post('/api/pki/tokens/introspect', { token })).active).toBe(false);
    } finally {
      await api.close();
    }
  });
});
