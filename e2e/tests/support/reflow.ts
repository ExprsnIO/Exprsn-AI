import type { Page } from '@playwright/test';

// B-1102 (WCAG 1.4.10 Reflow): what makes the screen on `page` scroll in two dimensions or stick out past the window,
// at whatever width the page has. The page never scrolls sideways; the only things that may are tables, code and the
// workflow canvas (a diagram, which 1.4.10 exempts), and each of those is a named keyboard stop with a scrollbar that
// stays visible (data-scrolls); nothing is cut off at the edge. Used by y-reflow.spec.ts and by specs that check a
// view inside a screen (the chain tree in Runs).
export function reflowProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}${(el.textContent ?? '').trim() ? ` "${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)}"` : ''}`;
    const doc = document.scrollingElement!;
    if (doc.scrollWidth > window.innerWidth + 1) out.push(`the page scrolls sideways by ${doc.scrollWidth - window.innerWidth} px`);
    const scrollers: Element[] = [];
    for (const el of Array.from(document.querySelectorAll('#app *'))) {
      if (!(el instanceof HTMLElement) || !el.offsetParent) continue;
      const cs = getComputedStyle(el);
      const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (!x) continue;
      scrollers.push(el);
      if (!el.matches('.tablewrap,.codebox,pre,[data-scroll-x]')) out.push(`${name(el)} scrolls sideways`);
      else if (!el.hasAttribute('data-scrolls') || el.tabIndex < 0 || !el.getAttribute('aria-label')) out.push(`${name(el)} scrolls sideways without a visible, named affordance`);
      // Code and diagrams (the workflow canvas) need two dimensions to mean anything; WCAG 1.4.10 exempts them.
      if (y && !el.matches('.codebox,pre,[data-scroll-2d]')) out.push(`${name(el)} scrolls in two dimensions`);
    }
    // Nothing inside the page may stick out past the window edge unless it sits in a sideways scroller.
    for (const el of Array.from(document.querySelectorAll('#main *'))) {
      if (!(el instanceof HTMLElement) || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.right <= window.innerWidth + 1) continue;
      if (scrollers.some((s) => s.contains(el))) continue;
      let clipped = false;
      for (let p = el.parentElement; p; p = p.parentElement) if (getComputedStyle(p).overflowX === 'hidden' && p.getBoundingClientRect().right <= window.innerWidth + 1) clipped = true;
      out.push(`${name(el)} ${clipped ? 'is cut off' : 'sticks out'} at the right edge (${Math.round(r.right)} px)`);
    }
    return [...new Set(out)].slice(0, 12);
  });
}
