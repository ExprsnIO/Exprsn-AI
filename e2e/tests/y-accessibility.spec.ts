import { test, expect, open, settle, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { SCREENS } from './support/sweep';

// B-1101: the in-page WCAG A/AA check on every screen, on each of its design states (the States popover, which also
// opens the screens' drawers and dialogs), and on a streaming chat answer, in light and dark. Runs after the primary
// specs (file order), so screens hold data.

type AppGlobal = { App: { screens: Record<string, { states?: unknown[] }>; applyState(i: number): void; closeOverlay(): void; state: { screenState: Record<string, unknown>; route: string }; render(): void } };

const statesOf = (page: Page, route: string) => page.evaluate((r) => ((window as unknown as AppGlobal).App.screens[r]?.states ?? []).length, route);

async function reset(page: Page, route: string): Promise<void> {
  const moved = await page.evaluate((r) => {
    const { App } = window as unknown as AppGlobal;
    App.closeOverlay();
    App.state.screenState[r] = {};
    if (App.state.route !== r) return true;
    App.render();
    return false;
  }, route);
  if (moved) await open(page, route);
  else await settle(page);
}

/**
 * The API allows 600 requests a minute per user; applying and resetting every design state reloads screens quickly,
 * so the sweep keeps itself under 450 a minute rather than tripping the limit.
 */
function pacer(page: Page): () => Promise<void> {
  const seen: number[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) seen.push(Date.now()); });
  return async () => {
    for (;;) {
      while (seen.length && seen[0]! < Date.now() - 60_000) seen.shift();
      if (seen.length < 450) return;
      await page.waitForTimeout(Math.max(250, seen[0]! + 60_000 - Date.now()));
    }
  };
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`Accessibility, ${scheme}`, () => {
    test(`every screen and its design states pass the WCAG A/AA check (${scheme})`, async ({ page, watch }) => {
      test.setTimeout(900_000);
      // Design states may point at data this server does not have (a missing row answers 404); that is not what is checked here.
      watch.allow.push(/ -> 404$/, / -> 409$/);
      await page.emulateMedia({ colorScheme: scheme });
      const pace = pacer(page);
      for (const route of [...SCREENS, 'settings']) {
        await test.step(route, async () => {
          await pace();
          await open(page, route);
          await expectAccessible(page, `${route} (${scheme})`);
          const n = await statesOf(page, route);
          for (let i = 0; i < n; i++) {
            await pace();
            await page.evaluate((k) => (window as unknown as AppGlobal).App.applyState(k), i);
            await page.waitForTimeout(250);
            await settle(page);
            await expectAccessible(page, `${route}, state ${i + 1} of ${n} (${scheme})`);
            await reset(page, route);
          }
        });
      }
    });

    test(`a streaming chat answer passes the check (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 'chat');
      const box = page.locator('#main textarea').first();
      await box.fill('Tell me a long story about lighthouses, please.');
      await box.press('Enter');
      // Check while the answer streams, then again when it has finished.
      await expect(page.locator('#main [data-streaming], #main .streaming, #main [aria-busy="true"]').first()).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
      await expectAccessible(page, `chat while streaming (${scheme})`);
      await settle(page);
      await page.waitForTimeout(500);
      await expectAccessible(page, `chat after the answer (${scheme})`);
    });

    test(`the sign-in screen passes the check (${scheme})`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: scheme, storageState: { cookies: [], origins: [] } });
      const page = await ctx.newPage();
      await page.goto((await import('./support/state')).serverState().url + '/#/signin');
      await expect(page.locator('#u')).toBeVisible();
      await expectAccessible(page, `sign-in (${scheme})`);
      await ctx.close();
    });
  });
}
