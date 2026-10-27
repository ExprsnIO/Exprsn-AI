import { test as setup, expect, signedIn, signInAndEnrol, signInPassword, signInWithTotp } from './support/fixtures';
import { authFile, serverState, type User } from './support/state';

// Each account signs in once through the sign-in screen; the specs reuse the session cookie.
// root and ops already have an authenticator (second-factor step); root2 and mladmin enrol one at first sign-in
// (their roles require it); member has no admin role and signs in with a password alone.
const flows: Record<Exclude<User, 'enrol'>, 'totp' | 'enrol' | 'password'> = { root: 'totp', ops: 'totp', root2: 'enrol', mladmin: 'enrol', member: 'password' };

setup.use({ user: null });

for (const [user, flow] of Object.entries(flows) as [User, string][]) {
  setup(`sign in ${user} (${flow})`, async ({ page }) => {
    const st = serverState();
    await page.goto(st.url + '/');
    await expect(page.locator('#u')).toBeVisible();
    if (flow === 'totp') await signInWithTotp(page, user, st.totp[user]!);
    else if (flow === 'enrol') await signInAndEnrol(page, user);
    else await signInPassword(page, user);
    await signedIn(page);
    await page.context().storageState({ path: authFile(user) });
  });
}
