import { test, expect, open, settle, type Page } from './support/fixtures';
import { SCREENS, SWEEP } from './support/sweep';

// B-1507 (WCAG 1.4.10 Reflow) for dialogs and drawers: at 320 CSS pixels (400 % zoom) and 640 (200 % zoom), each
// screen's dialogs and drawers, opened through its design states (the boards' "States to design from this page",
// which open them with example content), and then through the screen's own controls until it has shown a dialog and a
// drawer (with every unsafe API call answered 409 by the test, so nothing changes on the server), fit the window:
// neither the page nor the dialog scrolls sideways, and nothing in the dialog sticks out past its edge, except tables,
// code and diagrams in a named sideways scroller (as on the screens themselves).

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

/** What is open ('modal', 'drawer' or null) and its reflow problems. */
function measure(page: Page): Promise<{ kind: 'modal' | 'drawer' | null; problems: string[] }> {
  return page.evaluate(() => {
    const ov = document.querySelector('#overlay');
    const box = ov?.querySelector(':scope > .modal, :scope > .drawer') as HTMLElement | null;
    if (!ov || !box || box.classList.contains('palette-host')) return { kind: null, problems: [] };
    const kind = box.classList.contains('drawer') ? ('drawer' as const) : ('modal' as const);
    const out: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}${(el.textContent ?? '').trim() ? ` "${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)}"` : ''}`;
    const doc = document.scrollingElement!;
    if (doc.scrollWidth > window.innerWidth + 1) out.push(`the page scrolls sideways by ${doc.scrollWidth - window.innerWidth} px`);
    if (ov.scrollWidth > ov.clientWidth + 1) out.push(`the overlay scrolls sideways by ${ov.scrollWidth - ov.clientWidth} px`);
    if (box.scrollWidth > box.clientWidth + 1) out.push(`the ${kind} scrolls sideways by ${box.scrollWidth - box.clientWidth} px`);
    const edge = Math.min(window.innerWidth, box.getBoundingClientRect().right);
    if (box.getBoundingClientRect().right > window.innerWidth + 1) out.push(`the ${kind} is wider than the window (${Math.round(box.getBoundingClientRect().width)} px)`);
    const scrollers: Element[] = [];
    for (const el of Array.from(box.querySelectorAll('*'))) {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (!(/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1)) continue;
      scrollers.push(el);
      if (!el.matches('.tablewrap,.codebox,pre,textarea,[data-scroll-x]')) out.push(`${name(el)} scrolls sideways`);
    }
    for (const el of Array.from(box.querySelectorAll('*'))) {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.right <= edge + 1) continue;
      if (scrollers.some((s) => s.contains(el))) continue;
      out.push(`${name(el)} sticks out at the right edge (${Math.round(r.right)} px of ${Math.round(edge)})`);
    }
    return { kind, problems: [...new Set(out)].slice(0, 10) };
  });
}

/**
 * Candidate controls on the screen that may open a dialog or a drawer, most likely first: actions named like a form
 * ("New", "Add", "Edit"…), then other buttons, then clickable rows and cards (which open detail drawers). Controls
 * whose name reads like a change (remove, revoke, approve…) are left out; tabs, segments and design-state cards too.
 */
async function candidates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const risky = /delete|remove|revoke|disable|enable|stop|cancel|sign out|approve|deny|reject|rotate|purge|forget|reset|send|sync|retry|pull|promote|publish|apply|accept|pause|resume|verify|regenerate|leave|switch|log ?out|unshare|archive|restore|dismiss|copy|download|next|previous|back/i;
    const formy = /^(new|add|create|register|invite|upload|import|edit|configure|connect|propose|share|define|compose|start|schedule|details|view|open)\b/i;
    const seen = new Set<string>();
    const ranked: { sel: string; rank: number }[] = [];
    let k = 0;
    const els = Array.from(document.querySelectorAll('#main button, #main a[href="#"], #main tr[tabindex], #main tr.row, #main [role="button"], #main .listlink, #main [data-open], #main [data-doc], #main [data-src]'));
    for (const el of els) {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
      if (el.matches(':disabled,[aria-disabled="true"],[role="tab"],.state-card,[data-state],[data-tab],[data-seg],.seg button,.tabs *') || el.closest('.states,.seg,.tabs,[role="tablist"]')) continue;
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (risky.test(name)) continue;
      const key = el.tagName + '|' + name.slice(0, 40) + '|' + Array.from(el.attributes).filter((a) => a.name.startsWith('data-')).map((a) => a.name).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      el.setAttribute('data-reflow-candidate', String(k));
      ranked.push({ sel: `[data-reflow-candidate="${k}"]`, rank: formy.test(name) ? 0 : el.tagName === 'BUTTON' ? 1 : 2 });
      k++;
    }
    return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.sel);
  });
}

/** The controls' indexes are stamped on the current render; after a reset the screen renders again and re-stamps. */
async function clickCandidate(page: Page, i: number): Promise<boolean> {
  let list = await candidates(page);
  // A screen still rendering its data has no controls yet (seen on a loaded CI runner on Platform): wait for them
  // rather than conclude it has none.
  for (let tries = 0; i === 0 && !list.length && tries < 20; tries++) {
    await page.waitForTimeout(250);
    list = await candidates(page);
  }
  const sel = list[i];
  if (!sel) return false;
  await page.locator(sel).first().click({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  await settle(page);
  return true;
}

/**
 * Screens whose dialogs and drawers the sweep reaches with the suite's data. If it stopped opening them, the check
 * would pass vacuously; every other screen is measured whenever it opens one.
 */
const MODALS = SCREENS.filter((r) => !['memory', 'flags'].includes(r)).concat('settings').filter((r) => SWEEP.includes(r));
const DRAWERS = ['knowledge', 'memory', 'scripts', 'media', 'models', 'pools', 'training'].filter((r) => SWEEP.includes(r));

for (const width of [320, 640]) {
  test(`dialogs and drawers reflow at ${width} px`, async ({ page, watch }) => {
    test.setTimeout(600_000);
    // Design states may point at data this server does not have, and the sweep answers unsafe calls with 409 itself.
    watch.allow.push(/ -> 404$/, / -> 409$/);
    await page.setViewportSize({ width, height: 800 });
    const failures: string[] = [];
    const opened: Record<string, Set<string>> = {};
    for (const route of SWEEP) {
      await test.step(route, async () => {
        await open(page, route);
        const seen = (opened[route] = new Set());
        const n = await statesOf(page, route);
        for (let i = 0; i < n; i++) {
          await page.evaluate((k) => (window as unknown as AppGlobal).App.applyState(k), i);
          await page.waitForTimeout(250);
          await settle(page);
          const m = await measure(page);
          if (m.kind) {
            seen.add(m.kind);
            for (const p of m.problems) failures.push(`${route}, state ${i + 1} (${m.kind}): ${p}`);
          }
          await reset(page, route);
        }
        // Then the screen's own controls, until it has shown both a dialog and a drawer (or the controls run out).
        // Nothing may change on the server meanwhile: unsafe API calls are answered 409 without reaching it.
        await page.route('**/api/**', (r) => (['GET', 'HEAD'].includes(r.request().method()) ? r.fallback() : r.fulfill({ status: 409, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not during the reflow check', status: 409 }) })));
        try {
          for (let i = 0; i < 25 && !(seen.has('modal') && seen.has('drawer')); i++) {
            if (!(await clickCandidate(page, i))) break;
            const m = await measure(page);
            if (m.kind && !seen.has(m.kind)) {
              seen.add(m.kind);
              for (const p of m.problems) failures.push(`${route}, control ${i + 1} (${m.kind}): ${p}`);
            }
            if (m.kind || (await page.evaluate(() => (window as unknown as AppGlobal).App.state.route)) !== route) await reset(page, route);
          }
        } finally {
          await page.unroute('**/api/**');
          await reset(page, route);
        }
      });
    }
    const covered = Object.entries(opened).map(([r, s]) => `${r}: ${[...s].sort().join(' and ') || 'none'}`);
    test.info().annotations.push({ type: 'opened', description: covered.join('; ') });
    expect(failures).toEqual([]);
    const missing = [
      ...MODALS.filter((r) => !opened[r]?.has('modal')).map((r) => `${r}: no dialog opened`),
      ...DRAWERS.filter((r) => !opened[r]?.has('drawer')).map((r) => `${r}: no drawer opened`)
    ];
    expect(missing, covered.join('\n')).toEqual([]);
  });
}
