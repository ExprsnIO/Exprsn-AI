import { test as base, expect, request as pwRequest, type APIRequestContext, type Browser, type Page, type TestInfo } from '@playwright/test';
import { authFile, serverState, type User } from './state';
import { freshStep, totp } from './totp';

export { expect };

interface Watch {
  /** Problems seen so far: console errors, page errors, failed requests and 4xx/5xx responses. */
  problems: string[];
  /** Responses matching one of these (method and path, e.g. /POST \/api\/x/) are expected to fail. */
  allow: RegExp[];
  /** Watches another page (a second user's browser) the same way. */
  attach(page: Page, who?: string): void;
}

type Fixtures = {
  user: User | null;
  watch: Watch;
  /** Opens a second browser context signed in as another account, watched like the main page. */
  as: (user: User) => Promise<Page>;
};

/**
 * `user` picks the signed-in account (its storage state comes from auth.setup.ts); null means signed out.
 * `watch` is automatic: every test fails if the page logged a console error, threw, or got a failed or 4xx/5xx
 * response that the test did not declare with `watch.allow.push(/…/)`.
 */
export const test = base.extend<Fixtures>({
  user: ['root', { option: true }],
  baseURL: async ({}, use) => use(serverState().url),
  storageState: async ({ user }, use) => use(user ? authFile(user) : { cookies: [], origins: [] }),
  watch: [
    async ({ page }, use, testInfo: TestInfo) => {
      const w: Watch = { problems: [], allow: [], attach: (p, who) => watchPage(p, who ? `${who} ` : '') };
      const allowed = (s: string) => w.allow.some((r) => r.test(s));
      const watchPage = (page: Page, tag: string) => {
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        // The browser also logs each failed response; those are judged by the response listener below.
        if (/^Failed to load resource/.test(text)) return;
        w.problems.push(`${tag}[console] ${text}`);
      });
      page.on('pageerror', (e) => w.problems.push(`${tag}[pageerror] ${e.stack ?? e.message}`));
      page.on('requestfailed', (r) => {
        const f = r.failure()?.errorText ?? '';
        // Navigations, re-renders and closed sockets abort requests in flight; that is not a failure of the console.
        if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(f) || /\/socket\.io\//.test(r.url())) return;
        const line = `${r.method()} ${new URL(r.url()).pathname}`;
        if (!allowed(line)) w.problems.push(`${tag}[requestfailed] ${line} ${f}`);
      });
      page.on('response', async (r) => {
        if (r.status() < 400) return;
        const u = new URL(r.url());
        if (u.origin !== new URL(serverState().url).origin) return;
        const line = `${r.request().method()} ${u.pathname}${u.search} -> ${r.status()}`;
        if (allowed(line)) return;
        let body = '';
        try { body = (await r.text()).slice(0, 300); } catch { /* gone */ }
        w.problems.push(`${tag}[http] ${line} ${body}`);
      });
      };
      watchPage(page, '');
      await use(w);
      if (w.problems.length) {
        await testInfo.attach('console-problems', { body: w.problems.join('\n'), contentType: 'text/plain' });
      }
      expect(w.problems, 'console errors, page errors or failed requests').toEqual([]);
    },
    { auto: true }
  ],
  as: async ({ browser, watch }, use) => {
    const contexts: Awaited<ReturnType<Browser['newContext']>>[] = [];
    await use(async (user) => {
      const ctx = await browser.newContext({ storageState: authFile(user), baseURL: serverState().url, viewport: { width: 1440, height: 900 } });
      contexts.push(ctx);
      const p = await ctx.newPage();
      watch.attach(p, user);
      return p;
    });
    for (const c of contexts) await c.close();
  }
});

/**
 * An API client signed in as `user` (its session cookie), sending the session's CSRF token on unsafe requests.
 * For seeding what a test needs before its own steps; the steps under test go through the console.
 */
export async function apiAs(user: User): Promise<{ ctx: APIRequestContext; get: (u: string) => Promise<any>; post: (u: string, body?: object) => Promise<any>; patch: (u: string, body?: object) => Promise<any>; close: () => Promise<void> }> {
  const ctx = await pwRequest.newContext({ baseURL: serverState().url, storageState: authFile(user) });
  const session = await (await ctx.get('/api/auth/session')).json();
  const headers = { 'x-csrf-token': session.csrf as string, origin: serverState().url };
  const check = async (r: Awaited<ReturnType<APIRequestContext['get']>>) => {
    if (!r.ok()) throw new Error(`${r.url()} -> ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };
  return {
    ctx,
    get: async (u) => check(await ctx.get(u)),
    post: async (u, body = {}) => check(await ctx.post(u, { data: body, headers })),
    patch: async (u, body = {}) => check(await ctx.patch(u, { data: body, headers })),
    close: () => ctx.dispose()
  };
}

/** Opens a console route and waits until the screen has rendered and finished its first load. */
export async function open(page: Page, route: string): Promise<void> {
  await page.goto('/#/' + route);
  await ready(page, route.split('?')[0]!);
}

/** Waits until the router shows `route` and the screen is no longer loading. */
export async function ready(page: Page, route: string): Promise<void> {
  await page.waitForFunction((r) => {
    const w = window as unknown as { App?: { state: { route: string; booted: boolean } } };
    return !!w.App && w.App.state.booted && w.App.state.route === r && document.querySelector('#main')!.children.length > 0;
  }, route);
  await settle(page);
}

/** Waits for "Loading…" placeholders to go and for the network to be quiet. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.locator('#main').getByText(/^Loading…$|^Loading\.\.\.$/)).toHaveCount(0, { timeout: 15_000 });
}

/** The console is live on this screen: no "Prototype data" banner and no render failure. */
export async function expectLive(page: Page): Promise<void> {
  await expect(page.getByText('Prototype data.')).toHaveCount(0);
  await expect(page.getByText('This screen failed to render')).toHaveCount(0);
}

/** Accepts the console's confirm dialog (the primary button in the modal). */
export async function confirmDialog(page: Page, ok?: string | RegExp): Promise<void> {
  const modal = page.locator('#overlay .modal');
  await expect(modal).toBeVisible();
  await (ok ? modal.getByRole('button', { name: ok }) : modal.locator('[data-ok]')).click();
}

/** Expects a toast whose text matches. */
export async function toast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('#toasts .toast').filter({ hasText: text }).first()).toBeVisible();
}

/** Signs in through the sign-in screen with a password and, when asked, the authenticator code. */
export async function signInWithTotp(page: Page, username: string, secret: string): Promise<void> {
  await page.locator('#u').fill(username);
  await page.locator('#p').fill(serverState().password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Six-digit code from your authenticator')).toBeVisible();
  await freshStep();
  await page.locator('#otp').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
}

/** First sign-in of an account whose roles need a second factor: enrols an authenticator and returns its secret. */
export async function signInAndEnrol(page: Page, username: string): Promise<string> {
  await page.locator('#u').fill(username);
  await page.locator('#p').fill(serverState().password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Set up a second factor')).toBeVisible();
  await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
  const key = page.locator('form .mono').first();
  await expect(key).toBeVisible();
  const secret = (await key.innerText()).replace(/\s+/g, '');
  await freshStep();
  await page.locator('#otp').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.getByText('Recovery codes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'I have stored them' }).click();
  return secret;
}

/** Signs in with a password only (accounts without admin roles). */
export async function signInPassword(page: Page, username: string): Promise<void> {
  await page.locator('#u').fill(username);
  await page.locator('#p').fill(serverState().password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Waits for the signed-in shell (sidebar with the user's avatar). */
export async function signedIn(page: Page): Promise<void> {
  await expect(page.locator('#sidebar .me')).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { App: { state: { signedIn: boolean } } }).App.state.signedIn);
}
