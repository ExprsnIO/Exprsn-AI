import { test, expect, ready, expectLive, signInPassword, signedIn } from './support/fixtures';
import { serverState } from './support/state';

test.describe('Sign in', () => {
  test.use({ user: null });

  test('refuses a wrong password with a problem notice', async ({ page, watch }) => {
    watch.allow.push(/POST \/api\/auth\/login -> 401/);
    await page.goto('/');
    await expect(page.locator('#u')).toBeVisible();
    await expect(page.getByText('Prototype data.')).toHaveCount(0);
    await page.locator('#u').fill('member');
    await page.locator('#p').fill('wrong password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('form .notice.danger')).toBeVisible();
    await expect(page.locator('#sidebar .me')).toHaveCount(0);
    // Missing details are caught before any request.
    await page.locator('#p').fill('');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('form')).toContainText('Enter your username and password.');
  });

  test('a member signs in with a password, keeps the deep link and sees only workspace screens', async ({ page }) => {
    await page.goto('/#/knowledge');
    await expect(page.locator('#u')).toBeVisible();
    await signInPassword(page, 'member');
    await signedIn(page);
    await ready(page, 'knowledge');
    await expectLive(page);
    const nav = page.locator('#sidebar');
    for (const label of ['Chat', 'Compare', 'Runs', 'Knowledge', 'Memory', 'Workflows', 'Media', 'Images']) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    for (const label of ['Scripts', 'Models', 'Pools', 'Guardrails', 'Tenants', 'Zones', 'Platform', 'Identity']) await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0);
    await expect(nav).not.toContainText('Admin');
    void serverState;
  });
});

test.describe('Forbidden', () => {
  test.use({ user: 'member' });

  test('an admin screen shows "not permitted" to a member and leads back to the workspace', async ({ page }) => {
    // A deep link to a screen the account may not open lands on its first screen; following a link to it while
    // signed in shows the "not permitted" page.
    await page.goto('/#/models');
    await ready(page, 'chat');
    await page.evaluate(() => { location.hash = '#/models'; });
    await page.waitForFunction(() => (window as unknown as { App: { state: { route: string } } }).App.state.route === 'models');
    await expect(page.locator('#main')).toContainText('You do not have access to Models');
    await expect(page.locator('#main')).toContainText('models:manage');
    await expect(page.getByText('Prototype data.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to your workspace' }).click();
    await ready(page, 'chat');
    await expect(page.locator('#main')).toContainText('Start with a question');
  });
});
