import type { Page } from '@playwright/test';
import { test, expect, open, expectLive, confirmDialog, toast, apiAs } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.9.0, Sprint 55 (B-190, B-191, B-195): Identity › Sign-in policy. An identity admin sets a password policy (a longer
 * minimum, "not too close to the old one", a forced expiry, which is warned about), saves it and reads what is in
 * force and from where; sets the tenant's OAuth defaults; edits one OIDC client's token settings in its inspector;
 * and reads "what applies to this person" on a user's page. Accessibility in Standard and Enhanced, light and dark; no
 * sideways scrolling at 320 and 640 px. The policy and defaults are removed afterwards.
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

test.describe('Identity › Sign-in policy', () => {
  const clientName = 'E2E policy client ' + Date.now().toString(36);

  test.afterAll(async () => {
    const root = await apiAs('root');
    try {
      await root.del('/api/admin/signin-policy');
      await root.put('/api/admin/signin-policy/oauth', {});
    } finally {
      await root.close();
    }
  });

  test('saves a policy and OAuth defaults, shows the sources, edits a client and shows what applies', async ({ page }) => {
    await open(page, 'identity?tab=signin');
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main).toContainText('In force now');
    await expect(main).toContainText('No tenant policy');
    await expect(main.locator('tr', { hasText: 'password.minLength' })).toContainText('platform floor');
    await accessible(page, 'Identity › Sign-in policy (platform values)');

    await main.getByLabel('Minimum length').fill('14');
    await main.getByLabel('Expire after (days)').fill('90');
    await expect(main).toContainText('Forced expiry makes people choose weaker');
    await main.getByText('Refuse a new password too close to the old one').click();
    await main.locator('[data-sipsave]').click();
    await confirmDialog(page, 'Save policy');
    await toast(page, 'Sign-in policy saved');
    await expect(main).toContainText('NIST SP 800-63B advises against forced expiry');
    await expect(main.locator('tr', { hasText: 'password.minLength' })).toContainText('this tenant');
    await expect(main.locator('tr', { hasText: 'password.minLength' })).toContainText('14');
    await expect(main.locator('tr', { hasText: 'lockout.maxAttempts' })).toContainText('platform');

    await main.getByLabel('Authorization code lifetime (seconds)').fill('30');
    await main.locator('[data-sipoauth]').click();
    await confirmDialog(page, 'Save');
    await toast(page, 'OAuth defaults saved');
    await expect(main).toContainText('codes 30 s');
    await accessible(page, 'Identity › Sign-in policy (tenant policy)');
    await reflow(page, 'Identity › Sign-in policy');

    // One client's own token settings, in the OIDC clients inspector.
    const root = await apiAs('root');
    try {
      await root.post('/api/admin/federation/oidc/clients', { name: clientName, type: 'third party', redirectUris: ['https://app.example.test/cb'], scopes: ['openid', 'chat:read'], grants: ['authorization_code', 'refresh_token'] });
    } finally {
      await root.close();
    }
    await open(page, 'identity?tab=clients&client=' + encodeURIComponent(clientName));
    const insp = page.locator('aside.inspector');
    await expect(insp).toContainText('Token settings');
    await expect(insp).toContainText('30 s');
    await insp.locator('[data-ocsedit]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Token settings, ' + clientName);
    await modal.getByLabel('Requests a minute').fill('120');
    await modal.getByLabel('Consent screen').selectOption('on');
    await accessible(page, 'Identity › OIDC clients, token settings dialog');
    await modal.locator('[data-ocssave]').click();
    await toast(page, 'Token settings of');
    await expect(insp).toContainText('120 a minute');
    await expect(insp).toContainText('Consent screen');

    // What applies to a person, on their user page.
    await open(page, 'directories?tab=users');
    await page.locator('#main tr[data-user]').first().click();
    const drawer = page.locator('#overlay .drawer');
    await expect(drawer).toContainText('What applies to this person');
    await expect(drawer).toContainText('at least 14');
    await expect(drawer).toContainText('this tenant');
    await accessible(page, 'User Stores › user, what applies');
  });
});
