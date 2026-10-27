import type { Page } from '@playwright/test';
import { test, expect, open, expectLive } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.9.0, Sprint 54 (B-182 to B-184): the new user-store kinds in the store wizard. An admin picks Active Directory,
 * the Microsoft Entra ID and Google Workspace presets (OIDC with a directory pull) and Exprsn platform accounts; each
 * preset fills the generated form (connection, then attributes and groups). Accessibility in Standard and Enhanced,
 * light and dark, on the steps these kinds add fields to; no sideways scrolling at 320 and 640 px. Nothing is saved.
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

async function pick(page: Page, kind: string, preset: string | null): Promise<void> {
  const main = page.locator('#main');
  await main.locator('[data-add]').click();
  const modal = page.locator('#overlay .modal');
  await expect(modal).toContainText('Kind or preset');
  await modal.locator('[data-wname]').fill(`E2E ${kind} ${preset ?? ''}`.trim());
  const button = modal.locator(preset ? `[data-wkind="${kind}"][data-wpreset="${preset}"]` : `[data-wkind="${kind}"]:not([data-wpreset])`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await modal.locator('[data-wnext]').click();
  await expect(modal.locator('h3')).toHaveText('Connection');
}

async function close(page: Page): Promise<void> {
  await page.locator('#overlay .modal [data-close]').first().click();
  await expect(page.locator('#overlay .modal')).toHaveCount(0);
}

test.describe('User stores › Active Directory, cloud directories and Exprsn platform accounts', () => {
  test('each new kind and preset fills the wizard\'s form', async ({ page }) => {
    await open(page, 'directories');
    await expectLive(page);
    const modal = page.locator('#overlay .modal');

    // Active Directory: the domain and a vault reference for the service account; nested groups by DN
    await pick(page, 'ad', 'active-directory');
    await expect(modal.locator('[data-cf="domain"]')).toHaveValue('corp.example.com');
    await expect(modal.locator('[data-cf="bindPassword"]')).toHaveValue('vault:identity/ad#bindPassword');
    await accessible(page, 'Store wizard › Active Directory › connection');
    await reflow(page, 'Store wizard › Active Directory › connection');
    await modal.locator('[data-wnext]').click();
    await expect(modal.locator('h3')).toHaveText('Attributes and groups');
    await expect(modal.locator('[data-cf="baseDN"]')).toHaveValue('DC=corp,DC=example,DC=com');
    await accessible(page, 'Store wizard › Active Directory › attributes');
    await close(page);

    // Microsoft Entra ID: the v2.0 issuer, then the Graph pull with the client credentials grant
    await pick(page, 'oidc', 'entra-id');
    await expect(modal.locator('[data-cf="issuer"]')).toHaveValue('https://login.microsoftonline.com/TENANT-ID/v2.0');
    await modal.locator('[data-wnext]').click();
    await expect(modal.locator('[data-cf="directory.tokenUrl"]')).toHaveValue('https://login.microsoftonline.com/TENANT-ID/oauth2/v2.0/token');
    await expect(modal.locator('[data-cf="directory.clientSecret"]')).toHaveValue('vault:identity/entra#clientSecret');
    await accessible(page, 'Store wizard › Entra ID › attributes and directory');
    await reflow(page, 'Store wizard › Entra ID › attributes and directory');
    await close(page);

    // Google Workspace: Google's issuer, then the Directory API with a service account
    await pick(page, 'oidc', 'google-workspace');
    await expect(modal.locator('[data-cf="issuer"]')).toHaveValue('https://accounts.google.com');
    await modal.locator('[data-wnext]').click();
    await expect(modal.locator('[data-cf="directory.serviceAccount"]')).toHaveValue('vault:identity/google#serviceAccount');
    await close(page);

    // Exprsn platform accounts: the platform's address and the client
    await pick(page, 'exprsn-platform', 'exprsn-platform');
    await expect(modal.locator('[data-cf="platformUrl"]')).not.toHaveValue('');
    await expect(modal.locator('[data-cf="clientSecret"]')).toHaveValue('vault:identity/exprsn-platform#clientSecret');
    await accessible(page, 'Store wizard › Exprsn platform › connection');
    await reflow(page, 'Store wizard › Exprsn platform › connection');
    await close(page);
  });
});
