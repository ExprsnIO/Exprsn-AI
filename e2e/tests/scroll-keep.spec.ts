import { test, expect, open, expectLive } from './support/fixtures';

// 2026-10-20 (owner's bug report): a re-render of the same screen (socket events, polling, ctx.rerender) jumped the page
// back to the top. It now keeps the scroll position of the window and of every scrolled element; a route change still
// starts at the top.

type AppGlobal = { App: { render(): void } };

async function scroller(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const all = [document.querySelector('#main'), ...Array.from(document.querySelectorAll('#main *'))] as HTMLElement[];
    const el = all.find((e) => e && e.scrollHeight > e.clientHeight + 150 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));
    if (!el) return null;
    el.setAttribute('data-e2e-scroller', '');
    el.scrollTop = 120;
    return el.scrollTop;
  });
}

for (const route of ['settings', 'usage-audit', 'knowledge']) {
  test(`${route}: a re-render keeps the scroll position, a new route starts at the top`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await open(page, route);
    await expectLive(page);
    const before = await scroller(page);
    test.skip(!before, `${route} does not overflow at this height`);
    await page.evaluate(() => (window as unknown as AppGlobal).App.render());
    await expect.poll(() => page.evaluate(() => {
      const all = [document.querySelector('#main'), ...Array.from(document.querySelectorAll('#main *'))] as HTMLElement[];
      return Math.max(...all.filter(Boolean).map((e) => e.scrollTop));
    }), { timeout: 3000 }).toBeGreaterThanOrEqual(before! - 2);
    await open(page, 'chat');
    await open(page, route);
    await expectLive(page);
    const after = await page.evaluate(() => {
      const all = [document.querySelector('#main'), ...Array.from(document.querySelectorAll('#main *'))] as HTMLElement[];
      return Math.max(window.scrollY, ...all.filter(Boolean).map((e) => e.scrollTop));
    });
    expect(after).toBe(0);
  });
}
