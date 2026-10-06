import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, open, ready, expectLive, signInAndEnrol, signInWithTotp, signedIn, confirmDialog, toast } from './support/fixtures';
import { serverState, STATE_DIR } from './support/state';
import { freshStep, totp } from './support/totp';

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

test.describe('Settings: app passwords for DAV clients (B-3415)', () => {
  test('shows the discovery URLs, creates one after a fresh second factor, and a revoked one is refused by the next DAV request', async ({ page, request }) => {
    const url = serverState().url;
    await open(page, 'settings');
    await expectLive(page);
    const panel = page.locator('#main .panel', { hasText: 'App passwords for DAV clients' });
    await expect(panel).toContainText(`${url}/.well-known/caldav`);
    await expect(panel).toContainText(`${url}/.well-known/carddav`);
    await expect(panel).toContainText(`${url}/dav/`);
    // B-32 (Sprint 34): the WebDAV row is the file store's collection, and it answers.
    await expect(panel).toContainText(`${url}/dav/files/`);
    await expect(panel).toContainText('root');

    await panel.locator('[data-davcreate]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toBeVisible();
    // The setup signed root in minutes ago, usually longer ago than the step-up window: then the second factor is
    // asked for first, and the password is not offered (it does not count for an app password).
    if (await modal.getByRole('heading', { name: 'Confirm with your second factor' }).isVisible()) {
      await expect(modal.locator('[data-supw]')).toHaveCount(0);
      await freshStep();
      await modal.locator('[data-sucode]').fill(totp(serverState().totp.root!));
      await modal.locator('[data-sugo]').click();
    }
    await expect(modal.getByRole('heading', { name: 'Create an app password' })).toBeVisible();
    await modal.locator('[data-davname]').fill('e2e calendar');
    await expect(modal.locator('[data-davscope="caldav"]')).toBeChecked();
    await modal.locator('[data-davscope="webdav"]').check();
    await modal.locator('[data-davgo]').click();
    await toast(page, 'App password created.');
    const secret = (await panel.locator('[data-davsecret]').innerText()).trim();
    expect(secret).toMatch(/^exai_d1_[0-9a-f]{12}_/);

    // A DAV client signs in with the username and the app password; the API never accepts it.
    const basic = { authorization: 'Basic ' + Buffer.from(`root:${secret}`).toString('base64'), depth: '0' };
    expect((await request.fetch(`${url}/dav/`, { method: 'PROPFIND', headers: basic })).status()).toBe(207);
    expect((await request.fetch(`${url}/dav/files/`, { method: 'PROPFIND', headers: { ...basic, depth: '1' } })).status()).toBe(207);
    expect((await request.get(`${url}/api/me`, { headers: { authorization: `Bearer ${secret}` } })).status()).toBe(401);

    await panel.locator('[data-davdone]').click();
    await expect(page.locator('#main')).not.toContainText(secret);
    // Reload so the list shows the last use.
    await page.reload();
    await ready(page, 'settings');
    const row = page.locator('#main tr', { hasText: 'e2e calendar' });
    await expect(row).toContainText('CalDAV');
    await expect(row).toContainText('just now');
    await row.locator('[data-davrevoke]').click();
    await confirmDialog(page);
    await toast(page, 'App password for e2e calendar revoked.');
    await expect(page.locator('#main tr', { hasText: 'e2e calendar' })).toContainText('revoked');
    // The acceptance: the next DAV request with it is refused.
    const refused = await request.fetch(`${url}/dav/`, { method: 'PROPFIND', headers: basic });
    expect(refused.status()).toBe(401);
    expect(refused.headers()['www-authenticate']).toMatch(/^Basic /);
  });
});
