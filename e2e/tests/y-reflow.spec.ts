import { test, expect, open } from './support/fixtures';
import { SWEEP } from './support/sweep';
import { reflowProblems } from './support/reflow';

// B-1102 (WCAG 1.4.10 Reflow): at 320 CSS pixels (1280 px at 400 % zoom) and 640 (200 % zoom) no screen scrolls in
// two dimensions. The page never scrolls sideways; the only things that may are tables, code and the workflow canvas
// (a diagram, which 1.4.10 exempts), and each of those is a named keyboard stop with a scrollbar that stays visible
// (data-scrolls); nothing is cut off at the edge.

for (const width of [320, 640]) {
  test(`every screen reflows at ${width} px`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height: 800 });
    const failures: string[] = [];
    for (const route of SWEEP) {
      await open(page, route);
      // Let the a11y pass mark scrolling tables after the resize and render.
      await page.waitForTimeout(250);
      const problems = await reflowProblems(page);
      for (const p of problems) failures.push(`${route}: ${p}`);
    }
    expect(failures).toEqual([]);
  });
}
