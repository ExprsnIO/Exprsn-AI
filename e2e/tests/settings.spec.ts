import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, ready, expectLive, signInAndEnrol, signInWithTotp, signedIn, confirmDialog, toast } from './support/fixtures';
import { serverState, STATE_DIR } from './support/state';

test.describe('Settings', () => {
  // A fresh account signs in here (first sign-in with enrolment), so signing out does not end a shared session.
  test.use({ user: null });

  test('creates an API key shown once, uses and revokes it, switches theme and signs out', async ({ page, request }) => {
    await page.goto('/#/settings');
    await expect(page.locator('#u')).toBeVisible();
    // First sign-in enrols an authenticator; a retry signs in with the secret kept from that enrolment.
    const kept = path.join(STATE_DIR, 'totp-enrol.txt');
    if (existsSync(kept)) await signInWithTotp(page, 'enrol', readFileSync(kept, 'utf8'));
    else writeFileSync(kept, await signInAndEnrol(page, 'enrol'));
    await signedIn(page);
    // The deep link survives the sign-in.
    await ready(page, 'settings');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Noor Haddad');
    await expect(page.locator('#main')).toContainText('Authenticator app');

    await page.locator('[data-create]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-name]').fill('notebook-desk');
    await modal.locator('[data-go]').click();
    await toast(page, 'Key created. Copy it now');
    const notice = page.locator('#main .notice', { hasText: 'it is shown once' });
    const key = (await notice.locator('.mono').last().innerText()).trim();
    expect(key).toMatch(/^exai_k1_/);

    // The key works as a bearer token for the scopes it carries.
    const url = serverState().url;
    expect((await request.get(`${url}/api/me`, { headers: { authorization: `Bearer ${key}` } })).status()).toBe(200);

    await page.locator('[data-revealdone]').click();
    await expect(page.locator('#main')).not.toContainText(key);
    await page.locator('tr', { hasText: 'notebook-desk' }).locator('[data-revoke]').click();
    await confirmDialog(page);
    await toast(page, 'Key notebook-desk revoked.');
    expect((await request.get(`${url}/api/me`, { headers: { authorization: `Bearer ${key}` } })).status()).toBe(401);

    await page.locator('#main select[data-theme]').selectOption('Dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#main select[data-theme]').selectOption('Light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.locator('[data-signout]').click();
    await expect(page.locator('#u')).toBeVisible();
    await page.goto('/#/settings');
    await expect(page.locator('#u')).toBeVisible();
  });
});
