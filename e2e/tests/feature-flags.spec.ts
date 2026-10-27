import type { Page } from '@playwright/test';
import { test, expect, open, apiAs } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.0, Sprint 52 (B-167 to B-169): Platform › Feature flags, its own route #/feature-flags, and the console's
 * `data-feature-flag` gate. Two flags are seeded through the API (one live, one deprecated long enough to be stale); the tab
 * lists them, the detail dialog shows the levels, and an element gated on the live flag is hidden until this tenant
 * turns it on. Accessibility in Standard and Enhanced, light and dark; no sideways scrolling at 320 and 640 px.
 */

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void; flags: { refresh(force: boolean): Promise<Record<string, unknown>> } } };

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
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
}

test.describe('Feature flags', () => {
  const GATE = 'e2e-gate';
  const OLD = 'e2e-old-flag';

  test.beforeAll(async () => {
    const root = await apiAs('root');
    try {
      // Defining a flag needs a recent sign-in.
      await root.post('/api/me/step-up', { password: serverState().password });
      const list = await root.get('/api/admin/feature-flags');
      expect(list.available).toBe(true);
      const has = (k: string) => list.flags.some((f: { key: string }) => f.key === k);
      if (!has(GATE)) await root.post('/api/admin/feature-flags', { key: GATE, type: 'boolean', defaultValue: false, state: 'active', description: 'Gates an element in the e2e suite', owner: 'e2e' });
      if (!has(OLD)) {
        await root.post('/api/admin/feature-flags', { key: OLD, type: 'variant', defaultValue: 'calm', options: { variants: ['calm', 'loud'] }, description: 'Reviewed long ago', owner: 'e2e', reviewAt: '2020-01-01' });
      }
      // Start with the gate off for this tenant.
      await root.del(`/api/admin/feature-flags/${GATE}/tenant`).catch(() => undefined);
    } finally {
      await root.close();
    }
  });

  test('lists the flags on Platform, with the detail dialog and the explanation', async ({ page }) => {
    await open(page, 'platform?tab=flags');
    const main = page.locator('#main');
    await expect(main.getByText(GATE, { exact: true })).toBeVisible();
    await expect(main.locator('tr', { hasText: OLD }).getByText('stale')).toBeVisible();
    await accessible(page, 'Platform › Feature flags');
    await reflow(page, 'Platform › Feature flags');

    await main.getByRole('button', { name: `Open ${GATE}` }).click();
    const dialog = page.locator('#overlay .modal').filter({ hasText: 'Default and rollout' });
    await expect(dialog).toBeVisible();
    await accessible(page, 'Feature flags: detail dialog');
    await dialog.getByRole('button', { name: 'Why this tenant sees it' }).click();
    const why = page.locator('#overlay .modal').filter({ hasText: `Why this tenant sees ${GATE}` });
    await expect(why.getByText(/from (default|tenant|platform|plan|workspace)/)).toBeVisible();
    await accessible(page, 'Feature flags: explanation dialog');
    await why.getByRole('button', { name: 'Close' }).click();

    await main.getByRole('button', { name: 'Define a flag' }).click();
    await expect(page.locator('#overlay .modal').filter({ hasText: 'Define a feature flag' })).toBeVisible();
    await accessible(page, 'Feature flags: define dialog');
  });

  test('opens on its own route', async ({ page }) => {
    await open(page, 'feature-flags');
    await expect(page.locator('#main h1')).toHaveText('Feature flags');
    await expect(page.locator('#main').getByText(GATE, { exact: true })).toBeVisible();
    await accessible(page, 'Feature flags (own route)');
    await reflow(page, 'Feature flags (own route)');
  });

  test('hides a data-feature-flag element until the flag is on', async ({ page }) => {
    await open(page, 'feature-flags');
    // A screen's markup, as a render would add it.
    await page.evaluate((k) => {
      const box = document.createElement('div');
      box.innerHTML = `<p id="e2e-on" data-feature-flag="${k}">Shown while on</p><p id="e2e-off" data-feature-flag="!${k}">Shown while off</p><p id="e2e-unknown" data-feature-flag="no-such-flag">Never</p>`;
      document.querySelector('#main .page')!.appendChild(box);
    }, GATE);
    await expect(page.locator('#e2e-on')).toBeHidden();
    await expect(page.locator('#e2e-off')).toBeVisible();
    await expect(page.locator('#e2e-unknown')).toBeHidden();
    await expect(page.locator('#e2e-on')).toHaveAttribute('data-feature-flag-off', '');

    const root = await apiAs('root');
    try {
      await root.put(`/api/admin/feature-flags/${GATE}/tenant`, { value: true });
    } finally {
      await root.close();
    }
    await page.evaluate(() => (window as unknown as AppGlobal).App.flags.refresh(true));
    await expect(page.locator('#e2e-on')).toBeVisible();
    await expect(page.locator('#e2e-off')).toBeHidden();
    await expect(page.locator('#e2e-unknown')).toBeHidden();

    // A re-render keeps gating: the element is put in again and judged at once.
    await page.evaluate((k) => {
      const p = document.createElement('p');
      p.id = 'e2e-late';
      p.setAttribute('data-feature-flag', '!' + k);
      p.textContent = 'Added later';
      document.querySelector('#main .page')!.appendChild(p);
    }, GATE);
    await expect(page.locator('#e2e-late')).toBeHidden();

    const again = await apiAs('root');
    try {
      await again.del(`/api/admin/feature-flags/${GATE}/tenant`);
    } finally {
      await again.close();
    }
  });
});
