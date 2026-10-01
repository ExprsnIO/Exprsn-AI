import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

/**
 * axe-core (B-1506), run beside the in-page checker in `a11y.ts`. The source is evaluated in the page through the
 * DevTools protocol (the console's CSP allows only its own scripts, which does not apply to that), once per document.
 * Standard mode runs the WCAG 2.0, 2.1 and 2.2 A and AA rules; Enhanced mode adds AAA contrast
 * (`color-contrast-enhanced`, 7:1 and 4.5:1 for large text). Only violations fail; "needs review" results do not.
 */

const require = createRequire(import.meta.url);
let source: string | null = null;
const axeSource = (): string => (source ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));

export const AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

export interface AxeFinding {
  rule: string;
  help: string;
  target: string;
  summary: string;
}

type AxeWindow = { axe?: { run(ctx: unknown, opts: unknown): Promise<{ violations: { id: string; help: string; nodes: { target: unknown[]; failureSummary?: string }[] }[] }> } };

export async function axeAudit(page: Page, mode: 'aa' | 'aaa'): Promise<AxeFinding[]> {
  if (!(await page.evaluate(() => !!(window as unknown as AxeWindow).axe))) await page.evaluate(axeSource());
  return page.evaluate(
    async ({ tags, enhanced }) => {
      const axe = (window as unknown as AxeWindow).axe!;
      // With a dialog or drawer open the page behind it is inert; check what the user can reach.
      const overlay = document.querySelector('#overlay');
      const res = await axe.run(overlay ?? document, {
        runOnly: { type: 'tag', values: tags },
        rules: enhanced ? { 'color-contrast-enhanced': { enabled: true } } : {},
        resultTypes: ['violations']
      });
      return res.violations.flatMap((v) =>
        v.nodes.map((n) => ({
          rule: v.id,
          help: v.help,
          target: n.target.map(String).join(' '),
          summary: (n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 220)
        }))
      );
    },
    { tags: AA_TAGS, enhanced: mode === 'aaa' }
  );
}

/** Records axe-core violations as a soft assertion (one run lists every screen that fails), de-duplicated. */
export async function expectAxeClean(page: Page, mode: 'aa' | 'aaa', where: string): Promise<void> {
  const found = await axeAudit(page, mode);
  const lines = [...new Set(found.map((v) => `${v.rule} (${v.help}) at ${v.target}: ${v.summary}`))];
  expect.soft(lines, `axe-core ${mode === 'aaa' ? 'WCAG 2.2 A/AA and AAA contrast' : 'WCAG 2.2 A/AA'} violations on ${where}`).toEqual([]);
}
