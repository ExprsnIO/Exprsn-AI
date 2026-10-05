import { request as pwRequest, type Page } from '@playwright/test';
import { test, expect, open, expectLive, confirmDialog, toast, ready, signedIn, settle } from './support/fixtures';
import { authFile, serverState, type User } from './support/state';
import { freshStep, totp } from './support/totp';

// B-3413: the 1.4.0 identity additions on the live screens. Identity: the tenant's sign-up and MFA policy, sign-ups
// waiting for approval, invitations, CSV imports, DID bindings, GitHub and AT-Protocol user stores. Settings: the
// account's address, email codes, trusted devices and DID. Sign in: self-registration under the policy and the
// "trust this browser" option at the second-factor step.

const STRONG = 'violet harbour lanterns drift 42';
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);

/** The API as `user`, with PUT and DELETE too (for seeding and restoring the tenant policy). */
async function admin(user: User = 'root') {
  const ctx = await pwRequest.newContext({ baseURL: serverState().url, storageState: authFile(user) });
  const csrf = (await (await ctx.get('/api/auth/session')).json()).csrf as string;
  const headers = { 'x-csrf-token': csrf, origin: serverState().url };
  const check = async (r: Awaited<ReturnType<typeof ctx.get>>) => {
    if (!r.ok()) throw new Error(`${r.url()} -> ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };
  return {
    get: async (u: string) => check(await ctx.get(u)),
    post: async (u: string, data: object = {}) => check(await ctx.post(u, { data, headers })),
    put: async (u: string, data: object) => check(await ctx.put(u, { data, headers })),
    del: async (u: string) => check(await ctx.delete(u, { headers })),
    close: () => ctx.dispose()
  };
}

const CLOSED = { mode: 'closed', domains: [], requireEmailVerification: false, roles: ['member'], clearance: 'internal', workspaceId: null };
const MFA_OFF = { require: 'off', roles: [], graceDays: 0, trustedDeviceDays: 0 };
async function restorePolicy() {
  const api = await admin();
  try {
    await api.put('/api/admin/identity-policy/signup', CLOSED);
    await api.put('/api/admin/identity-policy/mfa', MFA_OFF);
  } finally {
    await api.close();
  }
}

/** Waits until the TOTP step after `step` has begun, so a code is not refused as already used. */
async function nextStep(step: number): Promise<void> {
  while (Math.floor(Date.now() / 30_000) <= step) await new Promise((r) => setTimeout(r, 500));
  await freshStep();
}

async function signedOutPage(browser: import('@playwright/test').Browser, watch: { attach(p: Page, who?: string): void }): Promise<{ page: Page; close: () => Promise<void> }> {
  // An explicit empty storage state: a new context would otherwise take the test's signed-in one.
  const ctx = await browser.newContext({ baseURL: serverState().url, viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  watch.attach(page, 'visitor');
  return { page, close: () => ctx.close() };
}

test.describe('Identity additions', () => {
  test.afterAll(restorePolicy);

  test('changes the sign-up and MFA policy from the console', async ({ page }) => {
    await restorePolicy();
    await open(page, 'identity?tab=policy');
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main.getByRole('tab', { name: /Sign-up and MFA policy/ })).toHaveAttribute('aria-selected', 'true');
    await expect(main).toContainText('Self-registration (B-1801, B-1802)');
    await expect(main.locator('[data-pol="signup.mode"]')).toHaveValue('closed');

    await main.locator('[data-pol="signup.mode"]').selectOption('approval');
    await main.locator('[data-pol="signup.domains"]').fill('example.internal\n*.example.internal');
    await main.locator('[data-pol="signup.domains"]').blur();
    await main.locator('[data-pol="mfa.trustedDeviceDays"]').fill('14');
    await main.locator('[data-pol="mfa.trustedDeviceDays"]').blur();
    await expect(main).toContainText('Unsaved changes.');
    await main.locator('[data-savepolicy]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('example.internal, *.example.internal');
    await expect(modal).toContainText('14 days');
    await confirmDialog(page, 'Save');
    await toast(page, 'Policy saved.');
    await settle(page);
    await expect(main).not.toContainText('Unsaved changes.');
    await expect(main.locator('[data-pol="signup.mode"]')).toHaveValue('approval');
    await expect(main.locator('[data-pol="mfa.trustedDeviceDays"]')).toHaveValue('14');

    const api = await admin();
    const pol = await api.get('/api/admin/identity-policy');
    await api.close();
    expect(pol.signup).toMatchObject({ mode: 'approval', domains: ['example.internal', '*.example.internal'], requireEmailVerification: false });
    expect(pol.mfa.trustedDeviceDays).toBe(14);

    // Widening the requirement restarts the grace period, and the screen says so.
    await main.locator('[data-pol="mfa.require"]').selectOption('roles');
    await main.locator('[data-polmfarole="knowledge-curator"]').check();
    await main.locator('[data-pol="mfa.graceDays"]').fill('30');
    await main.locator('[data-pol="mfa.graceDays"]').blur();
    await main.locator('[data-savepolicy]').click();
    await expect(page.locator('#overlay .modal')).toContainText('restarts the grace period');
    await confirmDialog(page, 'Save');
    await toast(page, 'graceRestarted');
    await expect(main).toContainText('the grace period restarted');
    await restorePolicy();
  });

  test('a self-registered account waits for approval, then signs in', async ({ page, browser, watch }) => {
    const api = await admin();
    await api.put('/api/admin/identity-policy/signup', { ...CLOSED, mode: 'approval', domains: ['example.internal'] });
    await api.close();
    const name = 'signup-' + uniq();
    const other = 'refused-' + uniq();
    watch.allow.push(/POST \/api\/auth\/login -> 403/, /POST \/api\/auth\/register -> 403/);

    const visitor = await signedOutPage(browser, watch);
    const v = visitor.page;
    try {
      await v.goto('/#/signin');
      await v.getByRole('link', { name: 'Create an account' }).click();
      await expect(v.locator('form')).toContainText('open with approval');
      const fill = async (user: string, email: string) => {
        await v.locator('#ru').fill(user);
        await v.locator('#rn').fill('New ' + user);
        await v.locator('#re').fill(email);
        await v.locator('#pn').fill(STRONG);
        await v.locator('#pa').fill(STRONG);
        await v.getByRole('button', { name: 'Create account' }).click();
      };
      // An address outside the allowed domains is refused.
      await fill(other, other + '@elsewhere.example');
      await expect(v.locator('form .notice.danger')).toBeVisible();
      await fill(name, name + '@example.internal');
      await expect(v.locator('form')).toContainText('Account created and waiting for approval.');
      await v.getByRole('button', { name: 'Back to sign in' }).click();
      await v.locator('#u').fill(name);
      await v.locator('#p').fill(STRONG);
      await v.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(v.locator('form .notice.danger')).toContainText('waiting for an admin to approve');

      // The identity admin approves it from the Identity screen.
      await open(page, 'identity?tab=policy');
      await page.locator('[data-policyseg] [data-seg="signups"]').click();
      const row = page.locator('#main tr', { hasText: name });
      await expect(row).toContainText('pending');
      await row.getByRole('button', { name: 'Approve ' + name }).click();
      await confirmDialog(page, 'Approve');
      await toast(page, name + ' approved and active.');
      await page.locator('[data-signupseg] [data-seg="approved"]').click();
      await expect(page.locator('#main tr', { hasText: name })).toContainText('approved');

      await v.locator('#p').fill(STRONG);
      await v.getByRole('button', { name: 'Sign in', exact: true }).click();
      await signedIn(v);
    } finally {
      await visitor.close();
      await restorePolicy();
    }
  });

  test('rejects a sign-up with a reason', async ({ page }) => {
    const api = await admin();
    await api.put('/api/admin/identity-policy/signup', { ...CLOSED, mode: 'approval' });
    const name = 'reject-' + uniq();
    try {
      const anon = await pwRequest.newContext({ baseURL: serverState().url, storageState: { cookies: [], origins: [] } });
      const r = await anon.post('/api/auth/register', { data: { username: name, displayName: 'To Reject', email: name + '@example.internal', password: STRONG }, headers: { origin: serverState().url } });
      expect(r.status(), await r.text()).toBe(201);
      await anon.dispose();
      await open(page, 'identity?tab=policy');
      await page.locator('[data-policyseg] [data-seg="signups"]').click();
      await page.locator('#main tr', { hasText: name }).getByRole('button', { name: 'Reject ' + name }).click();
      const modal = page.locator('#overlay .modal');
      await modal.locator('[data-rreason]').selectOption('Wrong tenant');
      await modal.locator('[data-rgo]').click();
      await toast(page, name + ' rejected.');
      const list = await api.get('/api/admin/signups?state=rejected');
      expect(list.find((x: { username: string }) => x.username === name)).toMatchObject({ state: 'rejected', reason: 'Wrong tenant' });
    } finally {
      await api.close();
      await restorePolicy();
    }
  });

  test('verification and invitation links open on the sign-in page, and a link that is not valid says so', async ({ browser, watch }) => {
    watch.allow.push(/POST \/api\/auth\/(email\/verify|invitations\/preview) -> 400/);
    const visitor = await signedOutPage(browser, watch);
    try {
      for (const [kind, title] of [['verify', 'Confirm your email address'], ['invitation', 'Join by invitation']] as const) {
        await visitor.page.goto('/?' + kind + '#/signin?' + kind + '=' + 'Q'.repeat(43));
        await expect(visitor.page.locator('form')).toContainText(title);
        await expect(visitor.page.locator('form .notice.danger')).toContainText('Invalid link');
        // The token is taken out of the address at once.
        expect(visitor.page.url()).not.toContain('Q'.repeat(43));
        await visitor.page.locator('form [data-backtoform]').first().click();
        await expect(visitor.page.locator('#u')).toBeVisible();
      }
    } finally {
      await visitor.close();
    }
  });

  test('the invitation dialog reports why an invitation cannot be sent', async ({ page, watch }) => {
    // The suite's server has no SMTP, so the server refuses (409) and the dialog shows its reason.
    watch.allow.push(/POST \/api\/invitations -> 409/);
    await open(page, 'identity?tab=policy');
    await page.locator('[data-policyseg] [data-seg="invitations"]').click();
    await expect(page.locator('#main')).toContainText('No invitations');
    await page.locator('#main [data-invite]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-iemail]').fill('invitee-' + uniq() + '@example.internal');
    await modal.locator('[data-isend]').click();
    await expect(modal.locator('.notice.danger')).toContainText('Email is not configured');
    await modal.locator('[data-close]').first().click();
  });

  test('a CSV import dry run reports conflicts, then the accepted rows are applied', async ({ page }) => {
    const a = 'imp' + uniq();
    const b = 'imp' + uniq() + 'b';
    const csv = ['kind,username,display_name,email,roles,clearance,workspace,provider,group', `user,${a},Imported One,${a}@example.internal,member,internal,,,`, `user,${b},Imported Two,${b}@example.internal,member,internal,,,`, `user,${b},Imported Twice,${b}x@example.internal,member,internal,,,`].join('\n');
    await open(page, 'identity?tab=imports');
    await expectLive(page);
    await page.locator('#main [data-import]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-csv]').fill(csv);
    await expect(modal.locator('[data-dry]')).toBeChecked();
    await modal.locator('[data-igo]').click();
    await toast(page, 'Import queued. Audited user.import.dry_run.');
    const report = page.locator('#main .panel', { hasText: 'dry run, nothing changed' });
    await expect(report).toBeVisible({ timeout: 15_000 });
    await expect(report).toContainText('conflict');
    await expect(report.locator('tr', { hasText: a })).toContainText('create');

    await report.locator('[data-applyimport]').click();
    await confirmDialog(page, 'Apply');
    await toast(page, 'Audited user.import.requested.');
    await expect(page.locator('#main .notice.ok, #main .panel', { hasText: /applied|Report for/ }).first()).toBeVisible({ timeout: 15_000 });
    const api = await admin();
    await expect.poll(async () => (await api.get('/api/admin/users?q=' + a)).length, { timeout: 15_000 }).toBe(1);
    await api.close();
  });

  test('AT-Protocol accounts: lists bindings and checks an account step by step', async ({ page, watch }) => {
    watch.allow.push(/POST \/api\/admin\/atproto\/accounts\/check -> 4\d\d/);
    await open(page, 'identity?tab=dids');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText(/No bindings|verified|challenge pending/);
    await page.locator('#main [data-checkaccount]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-chk]').fill('did:web:169.254.169.254');
    await modal.locator('[data-chkrun]').click();
    await expect(modal.locator('#chk-out .notice')).toBeVisible({ timeout: 15_000 });
    await expect(modal.locator('#chk-out')).not.toContainText('Checking');
    await modal.locator('[data-close]').first().click();
  });

  test('adds a GitHub store from Identity, shows it in the chain and on the sign-in page', async ({ page, browser, watch }) => {
    const name = 'GitHub ' + uniq();
    await open(page, 'identity?tab=upstream');
    await page.locator('#main [data-addstore]').click();
    await ready(page, 'directories');
    const modal = page.locator('#overlay .modal');
    await expect(modal.locator('[data-skind]')).toHaveValue('github');
    await expect(modal).toContainText('federation/github/callback');
    await modal.locator('[data-sname]').fill(name);
    await modal.locator('[data-ssave]').click();
    await toast(page, 'Store added.');
    let id = '';
    const api = await admin();
    try {
      const store = (await api.get('/api/admin/identity-providers')).find((p: { name: string }) => p.name === name);
      expect(store).toMatchObject({ kind: 'github', enabled: true });
      id = store.id;

      await open(page, 'identity?tab=upstream');
      const row = page.locator('#main tr', { hasText: name });
      await expect(row).toContainText('github');
      await row.getByRole('button', { name: 'Settings of ' + name }).click();
      const drawer = page.locator('#overlay');
      await expect(drawer).toContainText('allowedOrgs');
      await drawer.locator('[data-storetest]').click();
      await expect(drawer.locator('[data-storeout] .notice')).toContainText(/Connection test (passed|failed)/, { timeout: 20_000 });
      await page.keyboard.press('Escape');
      await expect(page.locator('#overlay .drawer')).toHaveCount(0);

      const visitor = await signedOutPage(browser, watch);
      await visitor.page.goto('/#/signin');
      await expect(visitor.page.getByRole('button', { name: 'Continue with GitHub (' + name + ')' })).toBeVisible();
      await visitor.close();

      // Disabling it from the drawer takes it out of the sign-in options.
      await row.getByRole('button', { name: 'Settings of ' + name }).click();
      await page.locator('#overlay [data-storetoggle]').click();
      await toast(page, 'disabled.');
      expect((await api.get('/api/admin/identity-providers')).find((p: { id: string }) => p.id === id).enabled).toBe(false);
    } finally {
      if (id) await api.del('/api/admin/identity-providers/' + id).catch(() => undefined);
      await api.close();
    }
  });
});

test.describe('Settings: trusted devices and the AT-Protocol account', () => {
  test.use({ user: null });
  test.afterAll(restorePolicy);

  test('a member enrols a factor, trusts this browser at the second-factor step, then forgets it', async ({ page, watch }) => {
    test.setTimeout(120_000);
    watch.allow.push(/POST \/api\/me\/atproto\/claim -> 4\d\d/, /POST \/api\/me\/email\/verify -> 4\d\d/);
    const username = 'traveller-' + uniq();
    const api = await admin();
    try {
      await api.put('/api/admin/identity-policy/mfa', { ...MFA_OFF, trustedDeviceDays: 30 });
      await api.post('/api/admin/users', { username, displayName: 'Tara Veller', email: username + '@example.internal', clearance: 'internal', roles: ['member'], password: STRONG, mustChange: false });
    } finally {
      await api.close();
    }

    await page.goto('/#/settings');
    await page.locator('#u').fill(username);
    await page.locator('#p').fill(STRONG);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await signedIn(page);
    await ready(page, 'settings');
    await expectLive(page);
    const main = page.locator('#main');
    await expect(main).toContainText(username + '@example.internal');
    // An account an admin created counts as having a proven address.
    await expect(main.locator('.pill', { hasText: /^verified$/ }).first()).toBeVisible();
    await expect(main).toContainText('Trusted devices, 30 days');
    await expect(main).toContainText('No trusted devices');

    // An authenticator, added in Settings.
    await main.locator('[data-addtotp]').click();
    const key = main.locator('.notice', { hasText: 'Add this key to your authenticator app' }).locator('.mono').first();
    const secret = (await key.innerText()).replace(/\s+/g, '');
    await freshStep();
    const step = Math.floor(Date.now() / 30_000);
    await main.locator('[data-totpcode]').fill(totp(secret));
    await main.locator('[data-totpconfirm]').click();
    await toast(page, 'Authenticator added.');
    if (await main.locator('[data-codesdone]').count()) await main.locator('[data-codesdone]').click();

    // The AT-Protocol link refuses an address it may not fetch, and says why.
    await main.locator('[data-atlink]').first().click();
    const link = page.locator('#overlay .modal');
    await link.locator('[data-ataccount]').fill('did:web:169.254.169.254');
    await link.locator('[data-atclaim]').click();
    await expect(link.locator('[data-aterr] .notice.danger')).toBeVisible({ timeout: 15_000 });
    await link.locator('[data-close]').first().click();

    // Sign out, then in again with the factor, asking to trust this browser.
    await main.locator('[data-signout]').click();
    await expect(page.locator('#u')).toBeVisible();
    await page.locator('#u').fill(username);
    await page.locator('#p').fill(STRONG);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Six-digit code from your authenticator')).toBeVisible();
    await page.getByLabel('Trust this browser for 30 days').check();
    await nextStep(step);
    await page.locator('#otp').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await signedIn(page);
    await toast(page, 'This browser is trusted until');

    await page.goto('/#/settings');
    await ready(page, 'settings');
    await expect(main.locator('tr', { hasText: /Chrom|Browser/ }).first()).toBeVisible();
    await expect(main).toContainText('This browser skips the second factor.');
    await main.locator('[data-forgetdevices]').click();
    await confirmDialog(page, 'Forget all');
    await toast(page, '1 trusted device forgotten.');
    await expect(main).toContainText('No trusted devices');
  });
});
