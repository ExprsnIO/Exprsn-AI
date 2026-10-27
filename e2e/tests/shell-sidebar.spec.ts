import { test, expect, open, settle, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.7.x (2026-10-15): the shell's sidebar is an accordion of groups (workspace groups, then the Admin section grouped by
// domain) that collapses to a 64 px icon rail whose groups open as flyouts, and every screen's side panels
// (`.inspector`, `.leftpane`) can be hidden to a strip. Each state passes the WCAG checker and axe-core (Standard and
// Enhanced, light and dark) and reflows at 320 and 640 px; the choices survive a reload.

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
  await page.emulateMedia({ colorScheme: 'light' });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(200);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

test.describe('the sidebar accordion and icon rail', () => {
  test.beforeEach(async ({ page }) => {
    // Once per test, not on every load: the reloads below check that the choices were kept.
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('shell-reset')) { sessionStorage.setItem('shell-reset', '1'); localStorage.removeItem('exprsn.nav'); localStorage.removeItem('exprsn.panels'); } } catch { /* none */ } });
  });

  test('groups expand and collapse, the current screen\'s group is open, and the choice is remembered', async ({ page }) => {
    await open(page, 'chat');
    const side = page.locator('#sidebar');
    await expect(side.locator('#navsec-admin')).toHaveText('Admin');
    // Workspace groups start open, admin groups closed; the group holding the current screen is open.
    await expect(side.locator('#navhead-assistant')).toHaveAttribute('aria-expanded', 'true');
    await expect(side.locator('#navhead-ai')).toHaveAttribute('aria-expanded', 'false');
    await expect(side.locator('#navlist-ai')).toBeHidden();
    await side.locator('#navhead-ai').click();
    await expect(side.locator('#navhead-ai')).toHaveAttribute('aria-expanded', 'true');
    await expect(side.locator('#navlist-ai a[href="#/models"]')).toBeVisible();
    await side.locator('#navhead-know').press('Enter');
    await expect(side.locator('#navlist-know')).toBeHidden();
    await accessible(page, 'sidebar, groups');
    await page.reload(); await settle(page);
    await expect(side.locator('#navhead-ai')).toHaveAttribute('aria-expanded', 'true');
    await expect(side.locator('#navhead-know')).toHaveAttribute('aria-expanded', 'false');
    // Opening a screen in a closed group opens that group.
    await open(page, 'vault');
    await expect(side.locator('#navhead-security')).toHaveAttribute('aria-expanded', 'true');
    await expect(side.locator('#navlist-security a[href="#/vault"]')).toHaveAttribute('aria-current', 'page');
  });

  test('the sidebar collapses to a 64 px rail; a group opens as a flyout; the rail is remembered', async ({ page }) => {
    await open(page, 'chat');
    const side = page.locator('#sidebar');
    await side.locator('#nav-rail-btn').click();
    await expect(page.locator('#app')).toHaveClass(/nav-rail/);
    await expect(side.locator('#nav-rail-btn')).toHaveAttribute('aria-pressed', 'true');
    expect(Math.round((await side.boundingBox())!.width)).toBe(64);
    // Every link keeps an accessible name although its text is hidden.
    await expect(side.locator('a[href="#/chat"]')).toHaveAttribute('title', 'Chat');
    await side.locator('#navhead-ai').click();
    const fly = side.locator('.popover.navfly');
    await expect(fly).toBeVisible();
    await expect(fly.locator('a[href="#/models"]')).toBeFocused();
    await accessible(page, 'sidebar rail, flyout open');
    await page.keyboard.press('Escape');
    await expect(fly).toHaveCount(0);
    await side.locator('#navhead-ai').click();
    await page.locator('.popover.navfly a[href="#/profiles"]').click();
    await expect(page).toHaveURL(/#\/profiles/);
    await settle(page);
    await expect(side.locator('.navgroup.here #navhead-ai')).toHaveCount(1);
    await page.reload(); await settle(page);
    await expect(page.locator('#app')).toHaveClass(/nav-rail/);
    await accessible(page, 'sidebar rail');
    await reflow(page, 'sidebar rail');
    await side.locator('#nav-rail-btn').click();
    await expect(page.locator('#app')).not.toHaveClass(/nav-rail/);
  });
});

test.describe('collapsible side panels', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('shell-reset')) { sessionStorage.setItem('shell-reset', '1'); localStorage.removeItem('exprsn.panels'); } } catch { /* none */ } });
  });

  test('Chat\'s conversation panel hides to a strip and comes back, remembered per screen', async ({ page }) => {
    await open(page, 'chat');
    const panel = page.locator('aside.inspector.ch-side');
    await expect(panel).toBeVisible();
    const toggle = panel.locator('> .panel-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(panel).toHaveClass(/pcollapsed/);
    await expect(panel.locator('> .panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.locator('> .panel-toggle')).toBeFocused();
    expect(Math.round((await panel.boundingBox())!.width)).toBeLessThanOrEqual(44);
    await accessible(page, 'chat, panel hidden');
    await reflow(page, 'chat, panel hidden');
    await page.reload(); await settle(page);
    await expect(page.locator('aside.inspector.ch-side')).toHaveClass(/pcollapsed/);
    // Another screen's panel keeps its own state.
    await open(page, 'models');
    const other = page.locator('#main aside.inspector').first();
    if (await other.count()) await expect(other).not.toHaveClass(/pcollapsed/);
    await open(page, 'chat');
    await page.locator('aside.inspector.ch-side > .panel-toggle').click();
    await expect(page.locator('aside.inspector.ch-side')).not.toHaveClass(/pcollapsed/);
    await accessible(page, 'chat, panel shown');
  });

  test('every screen\'s side panels get a labelled toggle', async ({ page }) => {
    for (const route of ['knowledge', 'workflows', 'vault', 'registry', 'jobs']) {
      await open(page, route);
      const panels = page.locator('#main .inspector, #main .leftpane');
      const n = await panels.count();
      for (let i = 0; i < n; i++) {
        const b = panels.nth(i).locator('> .panel-toggle');
        await expect(b, `${route} panel ${i}`).toHaveCount(1);
        await expect(b).toHaveAttribute('aria-label', /^(Hide|Show) /);
      }
    }
  });
});
