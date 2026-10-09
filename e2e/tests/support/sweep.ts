import { test, expect, ready, expectLive, type Page } from './fixtures';

// Every sidebar screen, in the order of the NAV table in web/js/app.js, plus Settings (opened from the avatar) and,
// since 1.5.0 (B-5801), the Profile page (opened from people's names).
export const SCREENS = ['chat', 'compare', 'runs', 'knowledge', 'memory', 'workflows', 'scripts', 'media', 'images', 'files', 'apps', 'groups', 'messages', 'overview', 'models', 'profiles', 'pools', 'registry', 'mcp-servers', 'guardrails', 'flags', 'classifiers', 'moderation', 'channels', 'social', 'connections', 'training', 'import', 'tenants', 'roles', 'directories', 'identity', 'certificates', 'vault', 'plugins', 'atproto', 'zones', 'usage-audit', 'analytics', 'jobs', 'storage', 'configuration', 'platform'];

/** The routes the accessibility and reflow specs walk: every screen and Settings, or only E2E_ONLY (comma-separated)
 *  while writing a screen. */
export const SWEEP: string[] = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(',').map((r) => r.trim()).filter(Boolean) : [...SCREENS, 'settings', 'person'];

export async function sweep(page: Page, routes: string[], shots: string | null) {
  const background: Record<string, string> = {};
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const route of routes) {
      await test.step(`${route} (${scheme})`, async () => {
        await page.evaluate((r) => { location.hash = '#/' + r; }, route);
        await ready(page, route);
        await expectLive(page);
        expect(await page.evaluate(() => (window as unknown as { App: { isDark(): boolean } }).App.isDark())).toBe(scheme === 'dark');
        await expect(page.locator('#main')).not.toBeEmpty();
        if (shots) await page.screenshot({ path: `${shots}/${route}-${scheme}.png` });
      });
    }
    background[scheme] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  }
  // The dark theme really applies: the page background differs.
  expect(background.dark).not.toBe(background.light);
}


/** The sidebar check and the light and dark sweep as a system admin and as a member, under a describe title. */
export function everyScreen(title: string): void {
  test.describe(title, () => {
    test('the sidebar lists every console screen, all of them live', async ({ page }) => {
      await page.goto('/#/chat');
      await ready(page, 'chat');
      const nav = await page.evaluate(() => (window as unknown as { App: { NAV: { items: { id: string; live?: boolean }[] }[] } }).App.NAV.flatMap((g) => g.items.map((i) => ({ id: i.id, live: !!i.live }))));
      expect(nav.map((i) => i.id).sort()).toEqual([...SCREENS].sort());
      expect(nav.filter((i) => !i.live)).toEqual([]);
      // A system admin sees every one of them in the sidebar.
      for (const id of SCREENS) await expect(page.locator(`#sidebar a[href="#/${id}"]`)).toHaveCount(1);
    });

    test('a system admin opens every screen in light and dark without errors', async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      await page.goto('/#/chat');
      await ready(page, 'chat');
      await sweep(page, [...SCREENS, 'settings', 'person'], process.env.E2E_SCREENSHOTS ? testInfo.outputPath('shots') : null);
    });

    test.describe('as a member', () => {
      test.use({ user: 'member' });
      test('a member opens each screen it may use in light and dark without errors', async ({ page }) => {
        await page.goto('/#/chat');
        await ready(page, 'chat');
        const allowed = await page.evaluate((all) => all.filter((r) => (window as unknown as { App: { canOpen(r: string): boolean } }).App.canOpen(r)), SCREENS);
        expect(allowed).toEqual(['chat', 'compare', 'runs', 'knowledge', 'memory', 'workflows', 'media', 'images', 'files', 'apps', 'groups', 'messages']);
        await sweep(page, [...allowed, 'settings', 'person'], null);
      });
    });
  });
}
