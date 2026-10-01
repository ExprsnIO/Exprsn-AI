import { expect, type Page } from '@playwright/test';

/**
 * An in-page accessibility check for the WCAG 2.2 A and AA rules the console can break (B-1101). It is modelled on
 * axe-core's rules of the same names, which the suite does not depend on: colour contrast (1.4.3, with alpha and
 * opacity blended), names for buttons, links, fields, images, frames and dialogs (4.1.2, 1.1.1, 2.4.4), valid roles
 * and ARIA references, required parents and children (1.3.1), one tab panel per tab list holding everything after it
 * (B-1103), no focusable content under aria-hidden, keyboard access to scrolling regions (2.1.1), nested
 * interactive controls, lists, the document language and title. Elements behind an open dialog are skipped, as the
 * dialog makes them inert; disabled controls are exempt from contrast (1.4.3).
 */
export interface Violation {
  rule: string;
  target: string;
  detail: string;
}

export async function audit(page: Page): Promise<Violation[]> {
  return page.evaluate(() => {
    const out: { rule: string; target: string; detail: string }[] = [];
    const overlay = document.querySelector('#overlay');
    const scope: Element = overlay ?? document.body;
    const describe = (el: Element): string => {
      const parts: string[] = [];
      let n: Element | null = el;
      for (let i = 0; n && i < 4 && n !== document.body; i++, n = n.parentElement) {
        const id = n.id ? `#${n.id}` : '';
        const cls = typeof n.className === 'string' && n.className.trim() ? `.${n.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
        const data = Array.from(n.attributes).find((a) => a.name.startsWith('data-'));
        parts.unshift(`${n.tagName.toLowerCase()}${id}${cls}${data ? `[${data.name}]` : ''}`);
      }
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `${parts.join(' > ')}${text ? ` "${text}"` : ''}`;
    };
    const add = (rule: string, el: Element, detail: string) => out.push({ rule, target: describe(el), detail });
    const visible = (el: Element): boolean => {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
      if (el.closest('[hidden],[inert]') && !(overlay && overlay.contains(el))) return false;
      if (el.closest('[inert]') && overlay && !overlay.contains(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const all = (sel: string): Element[] => Array.from(scope.querySelectorAll(sel)).filter((el) => !(overlay === null && el.closest('#overlay')));

    // ---------- accessible names (a simplified accname) ----------
    const nameOf = (el: Element): string => {
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        if (t) return t;
      }
      const label = el.getAttribute('aria-label');
      if (label && label.trim()) return label.trim();
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        const labels = Array.from(el.labels ?? []).map((l) => l.textContent ?? '').join(' ').trim();
        if (labels) return labels;
        if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) return el.value;
      }
      if (el instanceof HTMLImageElement) return el.alt ?? '';
      const text = Array.from(el.childNodes).map((c) => (c.nodeType === Node.TEXT_NODE ? c.textContent : c instanceof Element && getComputedStyle(c).display !== 'none' && c.getAttribute('aria-hidden') !== 'true' ? (c instanceof HTMLImageElement ? c.alt : c.getAttribute('aria-label') ?? c.textContent) : '')).join('').trim();
      if (text) return text;
      return (el.getAttribute('title') ?? '').trim();
    };

    // ---------- document ----------
    if (!document.documentElement.lang) add('html-has-lang', document.documentElement, 'The page has no lang attribute.');
    if (!document.title.trim()) add('document-title', document.documentElement, 'The page has no title.');
    const vp = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
    if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(vp)) add('meta-viewport', document.documentElement, 'Zoom is disabled.');

    // ---------- names ----------
    for (const el of all('button,[role="button"],[role="tab"],[role="menuitem"],[role="switch"],[role="checkbox"]:not(input),[role="option"]')) {
      if (visible(el) && !nameOf(el)) add('button-name', el, 'A control has no accessible name.');
    }
    for (const el of all('a[href]')) if (visible(el) && !nameOf(el)) add('link-name', el, 'A link has no accessible name.');
    for (const el of all('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),select,textarea,[role="textbox"],[role="combobox"],[role="searchbox"]')) {
      if (visible(el) && !nameOf(el)) add('label', el, 'A form field has no label.');
    }
    for (const el of all('img')) if (visible(el) && !el.hasAttribute('alt')) add('image-alt', el, 'An image has no alt attribute.');
    for (const el of all('[role="img"]')) if (visible(el) && !nameOf(el) && el.getAttribute('aria-hidden') !== 'true') add('role-img-alt', el, 'An element with role img has no name.');
    for (const el of all('iframe')) if (!el.getAttribute('title')) add('frame-title', el, 'A frame has no title.');
    for (const el of all('[role="dialog"],[role="alertdialog"],dialog')) if (visible(el) && !nameOf(el)) add('aria-dialog-name', el, 'A dialog has no name.');

    // ---------- roles and ARIA references ----------
    const ROLES = new Set(['alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'cell', 'checkbox', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'dialog', 'document', 'feed', 'figure', 'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem', 'generic', 'mark', 'code', 'emphasis', 'strong', 'deletion', 'insertion', 'subscript', 'superscript', 'time', 'paragraph', 'blockquote', 'caption']);
    for (const el of all('[role]')) {
      const role = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0]!;
      if (!ROLES.has(role)) add('aria-roles', el, `Unknown role "${role}".`);
    }
    for (const el of all('[aria-labelledby],[aria-describedby],[aria-controls]')) {
      for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        for (const id of v.split(/\s+/)) {
          const matches = document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length;
          if (matches === 0) add('aria-valid-attr-value', el, `${attr} names #${id}, which does not exist.`);
          else if (matches > 1) add('duplicate-id-aria', el, `${attr} names #${id}, which is not unique.`);
        }
      }
    }
    const PARENT: Record<string, string[]> = { tab: ['tablist'], option: ['listbox', 'group'], menuitem: ['menu', 'menubar', 'group'], listitem: ['list'], row: ['table', 'grid', 'rowgroup', 'treegrid'] };
    for (const [role, parents] of Object.entries(PARENT)) {
      for (const el of all(`[role="${role}"]`)) {
        let p = el.parentElement;
        while (p && ['none', 'presentation', 'generic'].includes(p.getAttribute('role') ?? '')) p = p.parentElement;
        const pr = p?.getAttribute('role') ?? (p && role === 'listitem' && /^(UL|OL)$/.test(p.tagName) ? 'list' : '');
        if (!parents.includes(pr)) add('aria-required-parent', el, `role ${role} is not inside ${parents.join(' or ')}.`);
      }
    }
    for (const el of all('[role="tablist"]')) {
      const tabs = Array.from(el.querySelectorAll('[role="tab"]'));
      if (!tabs.length) {
        add('aria-required-children', el, 'A tab list has no tabs.');
        continue;
      }
      // B-1103: one tab panel per tab list, holding everything that follows the list.
      const selected = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
      if (!selected || !visible(el)) continue;
      const after: Element[] = [];
      for (let n = el.nextElementSibling; n && n.getAttribute('role') !== 'tablist'; n = n.nextElementSibling) if (!/^(STYLE|SCRIPT|TEMPLATE)$/.test(n.tagName)) after.push(n);
      if (!after.length) continue;
      if (after.length !== 1) add('tabpanel', el, `${after.length} siblings follow the tab list; they belong in one tab panel.`);
      else if (after[0]!.getAttribute('role') !== 'tabpanel') add('tabpanel', el, 'The content after the tab list is not a tab panel.');
      else if (after[0]!.getAttribute('aria-labelledby') !== selected.id) add('tabpanel', el, 'The tab panel is not labelled by the selected tab.');
    }

    // ---------- keyboard ----------
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),iframe,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
    for (const el of all('[aria-hidden="true"]')) {
      const f = Array.from(el.querySelectorAll(FOCUSABLE)).concat(el.matches(FOCUSABLE) ? [el] : []).filter((x) => visible(x));
      if (f.length) add('aria-hidden-focus', el, 'Focusable content is inside aria-hidden.');
    }
    for (const el of all('*')) {
      if (!(el instanceof HTMLElement) || !visible(el)) continue;
      const cs = getComputedStyle(el);
      const sx = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const sy = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (!sx && !sy) continue;
      if (el === document.body || el === document.documentElement) continue;
      const selfFocusable = el.tabIndex >= 0 && el.matches(FOCUSABLE);
      if (!selfFocusable && !el.querySelector(FOCUSABLE)) add('scrollable-region-focusable', el, 'A scrolling region cannot be reached with the keyboard.');
    }
    for (const el of all('button,a[href],[role="button"],[role="link"],[role="tab"]')) {
      if (visible(el) && el.querySelector('button,a[href],input,select,textarea,[role="button"],[role="link"]')) add('nested-interactive', el, 'An interactive control contains another.');
    }
    for (const el of all('ul,ol')) {
      if (el.getAttribute('role')) continue;
      for (const c of Array.from(el.children)) if (!/^(LI|SCRIPT|TEMPLATE)$/.test(c.tagName)) add('list', el, `A list contains a <${c.tagName.toLowerCase()}>.`);
    }

    // ---------- contrast (1.4.3) ----------
    type Rgba = [number, number, number, number];
    const parse = (c: string): Rgba | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      return [0, 1, 2].map((i) => (top[i]! * top[3] + bottom[i]! * bottom[3] * (1 - top[3])) / a).concat(a) as Rgba;
    };
    const lum = (c: Rgba) => {
      const v = [c[0], c[1], c[2]].map((x) => {
        const s = x / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
    };
    const background = (el: Element): Rgba | null => {
      const layers: Rgba[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) return null;
        const bg = parse(cs.backgroundColor);
        if (bg && bg[3] > 0) layers.push(bg);
        if (bg && bg[3] >= 1) break;
      }
      let c: Rgba = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) c = over(layers[i]!, c);
      return c;
    };
    const opacity = (el: Element): number => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return o;
    };
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent || !t.textContent.trim()) continue;
      const el = t.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (!overlay && el.closest('#overlay')) continue;
      if (!visible(el) || el.closest('select,option,script,style,noscript,[disabled],[aria-disabled="true"],button:disabled,.btn[disabled]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const cs = getComputedStyle(el);
      if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') continue;
      const fg = parse(cs.color);
      const bg = background(el);
      if (!fg || !bg) continue;
      const o = opacity(el);
      const shown = over([fg[0], fg[1], fg[2], fg[3] * o], bg);
      const l1 = lum(shown);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio + 0.01 < need) add('color-contrast', el, `Contrast ${ratio.toFixed(2)}:1 is below ${need}:1 (${cs.color} on rgb(${bg.slice(0, 3).map(Math.round).join(', ')}), ${cs.fontSize}).`);
    }
    return out;
  });
}

/** Records the violations (a soft assertion, so one run lists every screen that fails), de-duplicated. */
export async function expectAccessible(page: Page, where: string): Promise<void> {
  const found = await audit(page);
  const lines = [...new Set(found.map((v) => `${v.rule}: ${v.detail} at ${v.target}`))];
  expect.soft(lines, `WCAG A/AA problems on ${where}`).toEqual([]);
}
