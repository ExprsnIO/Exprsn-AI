/* Exprsn-AI console — shell, router, API client and UI helpers.
   Screens register themselves with App.register({...}); see design/prototype/CONTRACT.md.
   The server decides what a user may do; the console only hides what the server would refuse. */
(function () {
  'use strict';

  // ---------- tiny helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const on = (root, event, sel, fn) => root.addEventListener(event, (e) => { const t = e.target.closest(sel); if (t && root.contains(t)) fn(e, t); });
  const uid = (() => { let n = 0; return (p) => (p || 'id') + '-' + (++n); })();

  // ---------- icons (stroke set, 24 viewBox) ----------
  const ICONS = {
    chat: 'M4 5h16v11H9l-5 4z', compare: 'M4 4h7v16H4zM13 4h7v16h-7z', runs: 'M4 6h10M4 12h16M4 18h7',
    knowledge: 'M5 4h13v16H5zM9 4v16', memory: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5', workflows: 'M4 4h6v5H4zM14 15h6v5h-6zM7 9v4h10v2',
    scripts: 'M9 7l-5 5 5 5M15 7l5 5-5 5', media: 'M4 5h16v14H4zM8 5v14M16 5v14', images: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4',
    models: 'M4 7h16v4H4zM4 13h16v4H4zM7 9h.01M7 15h.01', profiles: 'M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21a8 8 0 0 1 16 0', pools: 'M3 6h18v5H3zM3 13h18v5H3zM7 8.5h.01M7 15.5h.01',
    registry: 'M12 3l4 2v5l-4 2-4-2V5zM6 13l4 2v5l-4 2-4-2v-5zM18 13l4 2v5l-4 2-4-2v-5z', mcp: 'M6 3h12v6H6zM6 15h12v6H6zM12 9v6', guardrails: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    flags: 'M5 3v18M5 4h12l-3 4 3 4H5', classifiers: 'M4 7h6v4H4zM14 7h6v4h-6zM9 15h6v4H9z', connections: 'M4 7a8 3 0 0 1 16 0v10a8 3 0 0 1-16 0zM4 7a8 3 0 0 0 16 0M4 12a8 3 0 0 0 16 0',
    training: 'M4 20V10M10 20V4M16 20v-8M22 20H2', tenants: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6', identity: 'M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 21a7 7 0 0 1 14 0M17 7l3 3', zones: 'M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18M3 12a9 9 0 0 1 18 0',
    audit: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5', platform: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4', bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20h4', plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6L6 18', check: 'M5 12l4 4L19 7',
    chev: 'M9 6l6 6-6 6', chevd: 'M6 9l6 6 6-6', menu: 'M4 7h16M4 12h16M4 17h16', sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z', copy: 'M8 8h12v12H8zM4 16V4h12', refresh: 'M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5', edit: 'M4 20h4l11-11-4-4L4 16zM13 7l4 4',
    branch: 'M6 4v8a4 4 0 0 0 4 4h4M6 4a2 2 0 1 0 0 .01M18 16a2 2 0 1 0 0 .01M6 20a2 2 0 1 0 0 .01', flag: 'M5 3v18M5 4h12l-3 4 3 4H5', attach: 'M8 12l7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l8-8', send: 'M4 12l16-8-6 16-2-6z',
    play: 'M7 5v14l11-7z', stop: 'M6 6h12v12H6z', pause: 'M7 5v14M17 5v14', lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3', key: 'M14 10a4 4 0 1 0-3.5 4L12 15.5h2V18h2.5v2.5H20V17l-6-6z',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01', warn: 'M12 3l10 18H2zM12 10v4M12 17h.01', thumb: 'M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2l-1 7a2 2 0 0 1-2 2H7', download: 'M12 4v12M6 10l6 6 6-6M4 20h16',
    filter: 'M4 5h16l-6 8v6l-4-2v-4z', sort: 'M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4', dots: 'M5 12h.01M12 12h.01M19 12h.01', link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2', brain: 'M9 4a3 3 0 0 0-3 3v10a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM15 4a3 3 0 0 1 3 3v10a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3z',
    calc: 'M6 3h12v18H6zM9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', upload: 'M12 20V8M6 14l6-6 6 6M4 4h16', undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3', map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
    // Sprint 30 (B-3402 to B-3404, B-3407, B-3408): the trust, apps and files screens
    certificates: 'M12 3l2.5 2 3-.5.5 3 2 2.5-2 2.5-.5 3-3-.5L12 17l-2.5-2-3 .5-.5-3L4 10l2-2.5.5-3 3 .5zM9 17l-1 5 4-2 4 2-1-5', vault: 'M4 4h16v16H4zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 10v2M20 8h2M20 16h2',
    plugins: 'M9 3v4M15 3v4M6 7h12v5a6 6 0 0 1-12 0zM12 18v3', files: 'M3 6h6l2 2h10v11H3z', apps: 'M4 4h16v16H4zM4 9h16M9 9v11'
  };
  const icon = (name, size, extra) => {
    const d = ICONS[name] || ICONS.info;
    return '<svg width="' + (size || 15) + '" height="' + (size || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' + (extra || '') + '><path d="' + d + '"></path></svg>';
  };

  // ---------- UI string components ----------
  const LEVELS = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  const UI = {
    esc, icon, uid,
    label(level, opts) {
      level = String(level || 'internal').toLowerCase(); const n = LEVELS[level] || 2; opts = opts || {};
      let bars = ''; for (let i = 1; i <= 4; i++) bars += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
      return '<span class="label ' + level + (opts.sm ? ' sm' : '') + '" title="Classification: ' + level + '"><span class="bars" aria-hidden="true">' + bars + '</span>' + level + '</span>';
    },
    pill(text, kind) {
      if (!kind) {
        const t = String(text).toLowerCase();
        kind = /succeed|approved|published|verified|healthy|passed|ready|active|ok|connected|allowed|resolved|synced|enabled|loaded|complete/.test(t) ? 'ok'
          : /fail|error|reject|refused|critical|destructive|denied|revoked|blocked|unhealthy|down|expired|breach|high/.test(t) ? 'danger'
          : /warn|deprecated|preempt|pending|degraded|stale|medium|withheld|shadow|expiring|drift|late/.test(t) ? 'warn'
          : /review|running|evaluated|write|in progress|indexing|loading|scheduled|queued-next|canary|proposed/.test(t) ? 'info' : '';
      }
      return '<span class="pill ' + (kind || '') + '">' + esc(text) + '</span>';
    },
    chip(text, on, attrs) { return '<button type="button" class="chip' + (on ? ' on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" ' + (attrs || '') + '>' + text + '</button>'; },
    btn(label, opts) {
      opts = opts || {};
      const cls = ['btn', opts.kind || '', opts.size || '', opts.cls || ''].join(' ').trim();
      return '<button type="button" class="' + cls + '" ' + (opts.attrs || '') + (opts.disabled ? ' disabled' : '') + (opts.title ? ' title="' + esc(opts.title) + '"' : '') + '>' + (opts.icon ? icon(opts.icon, 14) : '') + esc(label) + '</button>';
    },
    iconbtn(name, title, opts) { opts = opts || {}; return '<button type="button" class="iconbtn ' + (opts.cls || '') + '" aria-label="' + esc(title) + '" title="' + esc(title) + '" ' + (opts.attrs || '') + '>' + icon(name, opts.size || 15) + (opts.dot ? '<span class="dot"></span>' : '') + '</button>'; },
    pagehead(title, sub, actions) {
      return '<div class="pagehead"><div><h1>' + esc(title) + '</h1>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>' + (actions ? '<div class="actions">' + actions + '</div>' : '') + '</div>';
    },
    panel(title, body, opts) {
      opts = opts || {};
      return '<section class="panel ' + (opts.cls || '') + '" ' + (opts.attrs || '') + '>' + (title !== null && title !== undefined ? '<div class="phead"><div class="eyebrow">' + esc(title) + '</div>' + (opts.actions ? '<div class="hstack gap6">' + opts.actions + '</div>' : '') + '</div>' : '') + body + '</section>';
    },
    kv(pairs, cols) {
      return '<div class="kv" style="--cols:' + (cols || 2) + '">' + pairs.map((p) => '<div><div class="k">' + esc(p[0]) + '</div><div class="v">' + p[1] + '</div></div>').join('') + '</div>';
    },
    table(cols, rows, opts) {
      opts = opts || {};
      // An empty header (an actions column) still gets a name for screen readers.
      const th = cols.map((c) => { const o = typeof c === 'string' ? { label: c } : c; return '<th scope="col"' + (o.right ? ' class="r"' : '') + (o.width ? ' style="width:' + o.width + '"' : '') + '>' + (o.label ? esc(o.label) : '<span class="sr">' + esc(o.srLabel || 'Actions') + '</span>') + '</th>'; }).join('');
      const tr = rows.map((r, i) => {
        const cells = Array.isArray(r) ? r : r.cells;
        const attrs = Array.isArray(r) ? '' : (r.attrs || '');
        const sel = (!Array.isArray(r) && r.selected) || opts.selected === i;
        return '<tr class="' + (opts.clickable !== false ? 'row' : '') + (sel ? ' selected' : '') + '" data-row="' + i + '" ' + attrs + '>' + cells.map((c, j) => { const o = typeof cols[j] === 'string' ? {} : cols[j] || {}; return '<td' + (o.right ? ' class="r"' : '') + '>' + c + '</td>'; }).join('') + '</tr>';
      }).join('');
      const empty = rows.length ? '' : '<tr><td colspan="' + cols.length + '"><div class="empty"><h3>' + esc(opts.emptyTitle || 'Nothing here yet') + '</h3><p>' + esc(opts.emptyText || '') + '</p></div></td></tr>';
      return '<div class="tablewrap ' + (opts.cls || '') + '" ' + (opts.attrs || '') + '><table class="dt" style="' + (opts.minWidth ? 'min-width:' + opts.minWidth : '') + '"><thead><tr>' + th + '</tr></thead><tbody>' + tr + empty + '</tbody></table></div>';
    },
    tabs(items, active, attrs) {
      // The ARIA tabs pattern: a tablist of tabs with one in the tab order (arrow keys, Home and End move between them,
      // see the keydown handler); App.a11yPass gives each tab an id and ties the selected one to App.tabPanel, the one panel
      // holding everything after the list.
      return '<div class="tabs" role="tablist" aria-label="Sections" ' + (attrs || '') + '>' + items.map((t) => { const o = typeof t === 'string' ? { id: t, label: t } : t; const on = o.id === active; return '<button type="button" role="tab" data-tab="' + esc(o.id) + '" class="' + (on ? 'active' : '') + '" aria-selected="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '">' + esc(o.label) + (o.count != null ? ' <span class="count">' + o.count + '</span>' : '') + '</button>'; }).join('') + '</div>';
    },
    seg(items, active, attrs) {
      return '<div class="seg" role="group" ' + (attrs || '') + '>' + items.map((t) => { const o = typeof t === 'string' ? { id: t, label: t } : t; return '<button type="button" data-seg="' + esc(o.id) + '" class="' + (o.id === active ? 'active' : '') + '" aria-pressed="' + (o.id === active ? 'true' : 'false') + '">' + esc(o.label) + '</button>'; }).join('') + '</div>';
    },
    // The label points at the first form control in `control` (reusing its id if it has one) and the hint describes it.
    // A control that is not a form element (a toggle, a group of checks) is labelled as a group instead.
    field(label, control, hint) {
      const hid = hint ? uid('fh') : null;
      const hintHtml = hint ? '<div class="hint" id="' + hid + '">' + hint + '</div>' : '';
      const m = /<(input|select|textarea)\b([^>]*)>/i.exec(control);
      if (!m) { const gid = uid('fl'); return '<div class="field" role="group" aria-labelledby="' + gid + '"' + (hid ? ' aria-describedby="' + hid + '"' : '') + '><span class="fl" id="' + gid + '">' + esc(label) + '</span>' + control + hintHtml + '</div>'; }
      const own = /\sid="([^"]+)"/.exec(m[2]);
      const id = own ? own[1] : uid('f');
      const add = (own ? '' : ' id="' + id + '"') + (hid && !/aria-describedby=/.test(m[2]) ? ' aria-describedby="' + hid + '"' : '');
      const ctl = control.slice(0, m.index) + '<' + m[1] + add + control.slice(m.index + 1 + m[1].length);
      return '<div class="field"><label for="' + esc(id) + '">' + esc(label) + '</label>' + ctl + hintHtml + '</div>';
    },
    input(value, opts) { opts = opts || {}; return '<input class="input" type="' + (opts.type || 'text') + '" value="' + esc(value) + '" placeholder="' + esc(opts.placeholder || '') + '" ' + (opts.attrs || '') + (opts.readonly ? ' readonly' : '') + '>'; },
    textarea(value, opts) { opts = opts || {}; return '<textarea class="textarea" placeholder="' + esc(opts.placeholder || '') + '" ' + (opts.attrs || '') + ' style="' + (opts.rows ? 'min-height:' + (opts.rows * 20 + 16) + 'px' : '') + '">' + esc(value) + '</textarea>'; },
    select(options, value, attrs) { return '<select class="select" ' + (attrs || '') + '>' + options.map((o) => { const v = typeof o === 'string' ? o : o.value, l = typeof o === 'string' ? o : o.label; return '<option value="' + esc(v) + '"' + (v === value ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') + '</select>'; },
    toggle(label, on, attrs) { return '<button type="button" class="toggle' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" ' + (attrs || '') + '><span class="sw"></span><span>' + esc(label) + '</span></button>'; },
    check(label, on, attrs) { return '<label class="check"><input type="checkbox"' + (on ? ' checked' : '') + ' ' + (attrs || '') + '><span>' + esc(label) + '</span></label>'; },
    search(placeholder, attrs, value) { return '<div class="search">' + icon('search', 14) + '<input type="search" placeholder="' + esc(placeholder) + '" value="' + esc(value || '') + '" aria-label="' + esc(placeholder) + '" ' + (attrs || '') + '></div>'; },
    meter(label, valueText, pct, tone) { return '<div class="meter ' + (tone || '') + '"><div class="mrow"><span>' + esc(label) + '</span><span class="num">' + esc(valueText) + '</span></div><div class="track" aria-hidden="true"><div class="fill" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></div></div></div>'; },
    notice(text, kind, action) { return '<div class="notice ' + (kind || 'info') + '">' + icon(kind === 'danger' || kind === 'warn' ? 'warn' : 'info', 15) + '<span class="grow">' + text + '</span>' + (action || '') + '</div>'; },
    empty(title, text, action) { return '<div class="empty"><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' + (action ? '<div>' + action + '</div>' : '') + '</div>'; },
    // trace === false omits the trace row (for problems that did not come from a request).
    problem(title, text, trace) { return '<div class="problem"><div class="ptitle">' + esc(title) + '</div><div class="ptext">' + esc(text) + '</div>' + (trace === false ? '</div>' : '<div class="trace"><span>Trace</span><span class="mono">' + esc(trace || '4bf92f3577b34da6a3ce929d0e0e4736') + '</span>' + UI.btn('Copy', { kind: 'ghost', size: 'sm', attrs: 'data-copy="' + esc(trace || '4bf92f3577b34da6a3ce929d0e0e4736') + '"' }) + '</div></div>'); },
    ctx(title, body, level) { return '<div class="ctxblock"><div class="chead"><span><span class="eyebrow">Context data</span>' + esc(title) + '</span>' + (level ? UI.label(level, { sm: true }) : '') + '</div><pre>' + esc(body) + '</pre></div>'; },
    code(text, lang) { const lines = String(text).split('\n'); return '<pre class="codebox" data-lang="' + esc(lang || '') + '">' + lines.map((l, i) => '<span class="ln" aria-hidden="true">' + (i + 1) + '</span>' + esc(l)).join('\n') + '</pre>'; },
    reviewbar(text, actions) { return '<div class="reviewbar"><span class="grow">' + text + '</span>' + (actions || '') + '</div>'; },
    stat(n, label, detail) { return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + esc(label) + '</div>' + (detail ? '<div class="d">' + detail + '</div>' : '') + '</div>'; },
    spark(values, hiIndex) { const m = Math.max.apply(null, values) || 1; return '<span class="spark" aria-hidden="true">' + values.map((v, i) => '<i style="height:' + Math.max(2, Math.round((v / m) * 22)) + 'px" class="' + (i === hiIndex ? 'hi' : '') + '"></i>').join('') + '</span>'; },
    timeline(items) { return '<div class="timeline">' + items.map((it, i) => '<div class="tl"><div class="dotcol"><i class="' + (it.tone || '') + '"></i>' + (i < items.length - 1 ? '<b></b>' : '') + '</div><div class="tbody"><div style="font-weight:600">' + it.title + '</div>' + (it.text ? '<div class="fg2" style="font-size:12px">' + it.text + '</div>' : '') + (it.meta ? '<div class="muted" style="font-size:12px">' + it.meta + '</div>' : '') + '</div></div>').join('') + '</div>'; },
    listItem(title, sub, opts) { opts = opts || {}; return '<button type="button" class="listlink' + (opts.active ? ' active' : '') + '" ' + (opts.attrs || '') + '><span><span class="t">' + title + '</span>' + (sub ? '<span class="s">' + sub + '</span>' : '') + '</span>' + (opts.right || '') + '</button>'; },
  };

  // ---------- Data shared across screens ----------
  const DATA = {
    tenant: { name: 'Northwind', workspace: 'Finance Ops' },
    workspaces: [
      { name: 'Finance Ops', tenant: 'Northwind tenant', label: 'confidential' },
      { name: 'People Ops', tenant: 'Northwind tenant', label: 'internal' },
      { name: 'Field Sales', tenant: 'Northwind tenant', label: 'internal' },
      { name: 'Platform lab', tenant: 'Contoso tenant', label: 'public' }
    ],
    user: { name: 'Mara Okafor', initials: 'MO', username: 'mokafor', roles: ['Member', 'Model admin', 'Tool admin', 'Flag reviewer', 'System admin'], clearance: 'confidential' },
    notifications: [
      { title: 'Flag F-2291 escalated', sub: 'High severity, timer 40 min left', route: 'flags' },
      { title: 'Workflow approval pending', sub: 'video-to-notes v3, step 5 waits on you', route: 'workflows' },
      { title: 'Import bundle 2026-38 verified', sub: '4 models, 2 MCP images', route: 'platform' },
      { title: 'Training job finished', sub: 'finance-lora-v3, eval 0.81', route: 'training' }
    ]
  };

  // ---------- Navigation model ----------
  // `perm` is the permission the server checks for the screen's API; the item is hidden without it.
  // `live` marks screens backed by the server; the rest still show prototype data (see docs/PLAN.md for their sprint).
  const NAV = [
    { group: null, items: [
      { id: 'chat', label: 'Chat', icon: 'chat', perm: 'chat:read', live: true }, { id: 'compare', label: 'Compare', icon: 'compare', perm: 'inference:invoke', live: true }, { id: 'runs', label: 'Runs', icon: 'runs', perm: 'agents:run', live: true },
      { id: 'knowledge', label: 'Knowledge', icon: 'knowledge', perm: 'knowledge:read', live: true }, { id: 'memory', label: 'Memory', icon: 'memory', perm: 'memory:write', live: true }, { id: 'workflows', label: 'Workflows', icon: 'workflows', perm: 'agents:run', live: true },
      { id: 'scripts', label: 'Scripts', icon: 'scripts', perm: 'scripts:run', live: true }, { id: 'media', label: 'Media', icon: 'media', perm: 'chat:write', live: true }, { id: 'images', label: 'Images', icon: 'images', perm: 'images:generate', live: true },
      // Sprint 30 (B-3408, B-3407): files and low-code apps
      { id: 'files', label: 'Files', icon: 'files', perm: 'files:read', live: true }, { id: 'apps', label: 'Apps', icon: 'apps', perm: 'records:read', live: true }
    ] },
    { group: 'Admin', items: [
      { id: 'models', label: 'Models', icon: 'models', perm: 'models:manage', live: true }, { id: 'profiles', label: 'Profiles', icon: 'profiles', perm: 'profiles:manage', live: true }, { id: 'pools', label: 'Pools', icon: 'pools', perm: 'pools:manage', live: true },
      { id: 'registry', label: 'Registry', icon: 'registry', perm: 'tools:manage', live: true }, { id: 'mcp-servers', label: 'MCP servers', icon: 'mcp', perm: 'mcp:manage', live: true }, { id: 'guardrails', label: 'Guardrails', icon: 'guardrails', perm: 'guardrails:manage', live: true },
      { id: 'flags', label: 'Flags', icon: 'flags', perm: 'flags:review', live: true }, { id: 'classifiers', label: 'Classifiers', icon: 'classifiers', perm: 'classifiers:manage', live: true }, { id: 'connections', label: 'Connections', icon: 'connections', perm: 'connections:manage', live: true },
      { id: 'training', label: 'Training', icon: 'training', perm: 'training:manage', live: true }, { id: 'tenants', label: 'Tenants', icon: 'tenants', perm: 'tenant:manage', live: true },
      { id: 'directories', label: 'User stores', icon: 'identity', perm: 'identity:manage', live: true }, { id: 'identity', label: 'Identity', icon: 'key', perm: 'identity:manage', live: true },
      // Sprint 30 (B-3402 to B-3404): the trust screens
      { id: 'certificates', label: 'Certificates', icon: 'certificates', perm: 'pki:manage', live: true }, { id: 'vault', label: 'Vault', icon: 'vault', perm: 'secrets:admin', live: true }, { id: 'plugins', label: 'Plugins and events', icon: 'plugins', perm: 'plugins:manage', live: true },
      { id: 'zones', label: 'Zones', icon: 'zones', perm: 'zones:manage', live: true }, { id: 'usage-audit', label: 'Usage and audit', icon: 'audit', perm: 'audit:read', live: true }, { id: 'platform', label: 'Platform', icon: 'platform', perm: 'platform:manage', live: true }
    ] }
  ];
  const NAV_BY_ID = {}; NAV.forEach((g) => g.items.forEach((it) => { NAV_BY_ID[it.id] = it; }));
  // Screens outside the sidebar that everyone signed in may open.
  const OPEN_ROUTES = { signin: true, settings: true, components: true, 'not-found': true, shared: true };
  // Sprint 16: pages that also open signed-out, without the shell (an anonymous share link).
  const PUBLIC_ROUTES = { shared: true };

  // ---------- App ----------
  const screens = {};
  const state = { route: null, params: {}, screenState: {}, theme: null, signedIn: false, navOpen: false, csrf: null, booted: false };
  try { state.theme = localStorage.getItem('exprsn.theme'); } catch (e) { /* storage unavailable */ }

  // ---------- Accessibility preferences ----------
  // state.a11y is 'aa' (Standard), 'aaa' (Enhanced) or null (follow the system: Enhanced when the browser asks for more
  // contrast). Stored in this browser like the theme. state.singleKeys turns the "?" shortcut on or off (WCAG 2.1.4).
  state.a11y = null; state.singleKeys = true;
  try {
    const a = localStorage.getItem('exprsn.a11y');
    if (a === 'aa' || a === 'aaa') state.a11y = a;
    else { const old = JSON.parse(localStorage.getItem('exprsn.prefs') || '{}'); if (old && old.contrast === 'AAA') state.a11y = 'aaa'; }
    state.singleKeys = localStorage.getItem('exprsn.singlekeys') !== 'off';
  } catch (e) { /* storage unavailable */ }
  const media = (q) => (window.matchMedia ? window.matchMedia(q) : null);
  const moreContrast = media('(prefers-contrast: more)');
  const applyA11y = () => {
    const eff = state.a11y === 'aaa' || (!state.a11y && moreContrast && moreContrast.matches) ? 'aaa' : 'aa';
    document.documentElement.setAttribute('data-a11y', eff);
    return eff;
  };
  applyA11y();
  if (moreContrast) { const f = () => { if (!state.a11y) applyA11y(); }; if (moreContrast.addEventListener) moreContrast.addEventListener('change', f); else if (moreContrast.addListener) moreContrast.addListener(f); }

  // ---------- API client ----------
  // JSON over fetch with the session cookie; unsafe methods carry the session's CSRF token.
  // Errors are RFC 9457 problem details: the thrown Error has .status and .problem (with trace_id).
  class ApiError extends Error { constructor(problem) { super(problem.detail || problem.title || 'Request failed'); this.status = problem.status; this.problem = problem; } }
  async function api(method, url, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
    let res;
    try { res = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw new ApiError({ status: 0, title: 'Network error', detail: 'The server could not be reached.' }); }
    if (res.status === 204) return null;
    const type = res.headers.get('content-type') || '';
    const data = /json/.test(type) ? await res.json() : null;
    if (!res.ok) {
      const problem = data || { status: res.status, title: res.statusText };
      if (res.status === 401 && !problem.step_up && !/^\/api\/auth\//.test(url) && state.signedIn) App.sessionEnded('Your session ended. Sign in again.');
      throw new ApiError(problem);
    }
    return data;
  }

  const App = {
    UI, DATA, NAV, screens, state, $, $$, on, esc, icon, ApiError,
    me: null, socket: null,
    api,
    get: (url) => api('GET', url), post: (url, body) => api('POST', url, body === undefined ? {} : body), patch: (url, body) => api('PATCH', url, body), del: (url) => api('DELETE', url),
    can(perm) { return !!(App.me && App.me.permissions.indexOf(perm) >= 0); },
    canOpen(route) { if (OPEN_ROUTES[route]) return true; const it = NAV_BY_ID[route]; return !it || App.can(it.perm); },
    isLive(route) { const it = NAV_BY_ID[route]; return OPEN_ROUTES[route] || !!(it && it.live) || !!(screens[route] && screens[route].live); },
    /** Shows a problem's title, detail and trace id in a toast. */
    fail(err, what) { const p = (err && err.problem) || {}; App.toast('<span><b>' + esc(what || p.title || 'Request failed') + '</b> ' + esc(p.detail || (err && err.message) || '') + (p.trace_id ? '<span class="mono muted" style="display:block;font-size:11px">trace ' + esc(p.trace_id) + '</span>' : '') + '</span>', 'danger', 7000); },
    register(def) { screens[def.id] = def; },
    navigate(route, params) {
      const q = params ? '?' + Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&') : '';
      if (App.fileMode && !screens[route]) { location.href = App.hrefFor(route) + q; return; }
      location.hash = '#/' + route + q;
    },
    // In file mode (one HTML page per screen) a route that is not in this page lives in <route>.html.
    fileMode: false, defaultRoute: null,
    hrefFor(route) { return App.fileMode && !screens[route] ? route + '.html#/' + route : '#/' + route; },
    parse() {
      const h = location.hash.replace(/^#\/?/, '');
      const [path, qs] = h.split('?');
      const params = {};
      (qs || '').split('&').filter(Boolean).forEach((p) => { const i = p.indexOf('='); const k = i < 0 ? p : p.slice(0, i), v = i < 0 ? '' : p.slice(i + 1); params[k] = decodeURIComponent(v); });
      return { route: path || App.defaultRoute || (state.signedIn ? 'chat' : 'signin'), params };
    },
    stateFor(id) { return state.screenState[id] || (state.screenState[id] = {}); },
    /** Loads the signed-in user, connects the socket, and opens the first screen they may use. */
    async signIn(session) {
      if (session && session.csrf) state.csrf = session.csrf;
      const me = await api('GET', '/api/me');
      App.setMe(me); state.signedIn = true; App.connectSocket();
      const next = state.afterSignIn && App.canOpen(state.afterSignIn) ? state.afterSignIn : App.firstRoute();
      // Keep the parameters of the address the user came in on (a deep link such as #/models?model=…).
      const hash = next === state.afterSignIn && state.afterSignInHash ? state.afterSignInHash : null;
      state.afterSignIn = null; state.afterSignInHash = null;
      if (hash) { if (location.hash === hash) App.render(); else location.hash = hash; return; }
      App.navigate(next); if (App.parse().route === next) App.render();
    },
    async signOut() {
      let r = null; try { r = await api('POST', '/api/auth/logout'); } catch (e) { /* already gone */ }
      App.sessionEnded();
      // Front-channel logout (B-808): the signed-out page loads each application's logout frame, then returns here.
      if (r && typeof r.next === 'string' && /^\/(t\/[a-z0-9][a-z0-9-]{0,62}\/)?oauth\/logged-out\?handle=[A-Za-z0-9_-]+$/.test(r.next)) location.assign(r.next);
    },
    /** Clears local state after sign-out, revocation or expiry. */
    sessionEnded(message) {
      const was = state.signedIn; state.signedIn = false; state.csrf = null; App.me = null; state.screenState = {};
      if (App.socket) { App.socket.close(); App.socket = null; }
      if (message && was) App.toast(esc(message), 'warn', 6000);
      App.navigate('signin'); if (App.parse().route === 'signin') App.render();
    },
    setMe(me) {
      App.me = me;
      // The accessibility mode is stored with the account and follows the user to every browser (B-501).
      if (me.preferences && me.preferences.a11y) App.setA11y(me.preferences.a11y === 'system' ? null : me.preferences.a11y);
      const name = me.user.displayName || me.user.username;
      DATA.user = { name, initials: name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(), username: me.user.username, roles: me.roles.map((r) => r.name), clearance: me.user.clearance };
      const cur = me.workspaces.find((w) => w.id === me.workspace) || me.workspaces[0];
      DATA.tenant = { name: me.tenant ? me.tenant.name : '', workspace: cur ? cur.name : (me.tenant ? me.tenant.name : ''), workspaceId: cur ? cur.id : null, label: cur ? cur.label : null };
      DATA.workspaces = me.workspaces.map((w) => ({ id: w.id, name: w.name, tenant: (me.tenant ? me.tenant.name : '') + ' tenant', label: w.label }));
      DATA.notifications = [];
      App.loadNotifications();
    },
    /** Unread notifications for the bell; new ones arrive over the socket. */
    async loadNotifications() {
      try {
        const r = await api('GET', '/api/me/notifications');
        DATA.notifications = r.items.filter((n) => !n.read).map((n) => ({ id: n.id, title: n.title, sub: n.body || '', route: n.route || '' }));
        DATA.notificationEmail = r.email;
        if (state.route !== 'signin') App.renderHeader();
      } catch (e) { /* the bell stays empty */ }
    },
    /** Switches the session's workspace on the server, then re-renders everything that scopes to it. */
    async switchWorkspace(id) {
      try {
        await api('PUT', '/api/me/workspace', { workspaceId: id });
        const w = DATA.workspaces.find((x) => x.id === id);
        App.me.workspace = id; DATA.tenant.workspace = w.name; DATA.tenant.workspaceId = w.id; DATA.tenant.label = w.label;
        state.screenState = {};
        App.renderSidebar(); App.toast('Switched to ' + esc(w.name) + '. Conversations, knowledge and quotas now scope to it.'); App.render();
      } catch (err) { App.fail(err, 'Could not switch workspace'); }
    },
    firstRoute() { for (const g of NAV) for (const it of g.items) if (App.can(it.perm)) return it.id; return 'settings'; },
    connectSocket() {
      if (!window.io || App.socket) return;
      const sock = window.io({ path: '/socket.io', transports: ['websocket', 'polling'], withCredentials: true });
      sock.on('session.revoked', () => App.sessionEnded('This session was signed out.'));
      sock.on('connect_error', (e) => { if (e && e.message === 'unauthorized') { sock.close(); } });
      sock.on('notification', (n) => {
        if (!n || n.read) return;
        DATA.notifications.unshift({ id: n.id, title: n.title, sub: n.body || '', route: n.route || '' });
        App.renderHeader(); App.toast('<b>' + esc(n.title) + '</b>' + (n.body ? ' ' + esc(n.body) : ''), 'warn', 6000);
      });
      App.socket = sock;
    },
    /** Asks the server whether this browser already has a session, then renders. */
    async boot() {
      try {
        const s = await api('GET', '/api/auth/session');
        state.csrf = s.csrf || null;
        // A reload keeps the screen in the address bar rather than jumping to the first one.
        if (s.authenticated) { const r = App.parse().route; if (r !== 'signin' && location.hash) { state.afterSignIn = r; state.afterSignInHash = location.hash; } await App.signIn(s); state.booted = true; return; }
        state.pendingSession = s.stage ? s : null;
      } catch (e) { /* offline: sign-in shows the error */ }
      state.booted = true;
      const r = App.parse().route; if (PUBLIC_ROUTES[r]) { App.render(); return; }
      if (r !== 'signin') { state.afterSignIn = r; state.afterSignInHash = location.hash || null; }
      App.navigate('signin'); App.render();
    },
    /** Sets the accessibility mode: 'aa', 'aaa' or null to follow the system. */
    setA11y(mode) {
      state.a11y = mode === 'aa' || mode === 'aaa' ? mode : null; applyA11y();
      try { state.a11y ? localStorage.setItem('exprsn.a11y', state.a11y) : localStorage.removeItem('exprsn.a11y'); localStorage.removeItem('exprsn.prefs'); } catch (e) { /* storage unavailable */ }
    },
    /** The mode in effect: 'aaa' or 'aa'. */
    a11yMode() { return document.documentElement.getAttribute('data-a11y') === 'aaa' ? 'aaa' : 'aa'; },
    prefersReducedMotion() { const m = media('(prefers-reduced-motion: reduce)'); return App.a11yMode() === 'aaa' || !!(m && m.matches); },
    setSingleKeys(on) { state.singleKeys = !!on; try { localStorage.setItem('exprsn.singlekeys', on ? 'on' : 'off'); } catch (e) { /* storage unavailable */ } },
    setTheme(t) { state.theme = t; if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); try { t ? localStorage.setItem('exprsn.theme', t) : localStorage.removeItem('exprsn.theme'); } catch (e) {} App.renderHeader(); },
    isDark() { return state.theme === 'dark' || (!state.theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); },

    // ----- toasts -----
    // #toasts is a polite live region; a danger toast is an alert. A toast stays while hovered or focused, has a close
    // button, and lasts longer in Enhanced mode (WCAG 2.2.1).
    toast(msg, kind, ms) {
      const host = $('#toasts');
      const el = document.createElement('div'); el.className = 'toast ' + (kind || '');
      if (kind === 'danger') el.setAttribute('role', 'alert');
      el.innerHTML = '<span class="tmsg">' + msg + '</span><button type="button" class="tclose" aria-label="Dismiss">' + icon('x', 13) + '</button>';
      host.appendChild(el);
      let left = (ms || 3200) * (App.a11yMode() === 'aaa' ? 3 : 1), started = Date.now(), timer = null;
      const start = () => { started = Date.now(); timer = setTimeout(() => el.remove(), left); };
      const pause = () => { if (timer) { clearTimeout(timer); timer = null; left = Math.max(1500, left - (Date.now() - started)); } };
      el.addEventListener('mouseenter', pause); el.addEventListener('focusin', pause);
      el.addEventListener('mouseleave', () => { if (!timer && !el.contains(document.activeElement)) start(); });
      el.addEventListener('focusout', (e) => { if (!timer && !el.contains(e.relatedTarget)) start(); });
      el.querySelector('.tclose').addEventListener('click', () => { pause(); el.remove(); });
      start();
    },

    // ----- modal / confirm / drawer -----
    // Shared by modal() and drawer(): the overlay closes on backdrop click, Esc (see the keydown handler below) and any
    // [data-close] inside it; Tab stays inside it; focus goes back where it was when it closes; opts.onClose runs once on close.
    openOverlay(ov, opts) {
      App.closeOverlay();
      ov.id = 'overlay'; ov._onClose = opts.onClose || null; ov._returnTo = document.activeElement;
      document.body.appendChild(ov);
      // Everything behind the dialog is inert while it is open (aria-modal alone is not honoured everywhere).
      const appEl = $('#app'); if (appEl) appEl.setAttribute('inert', '');
      ov.addEventListener('click', (e) => { if (e.target === ov) App.closeOverlay(); });
      on(ov, 'click', '[data-close]', () => App.closeOverlay());
      ov.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const f = $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', ov).filter((el) => el.offsetParent !== null);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || !ov.contains(document.activeElement))) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      });
      if (opts.onMount) opts.onMount(ov.firstChild, ov);
      if (!ov.contains(document.activeElement)) { const f = ov.querySelector('[autofocus]') || ov.querySelector('input:not([type="hidden"]),select,textarea,button'); if (f) f.focus(); else { ov.firstChild.setAttribute('tabindex', '-1'); ov.firstChild.focus(); } }
      return ov.firstChild;
    },
    modal(opts) {
      const ov = document.createElement('div'); ov.className = 'overlay' + (opts.center ? ' center' : '');
      const hid = uid('dlg');
      ov.innerHTML = '<div class="modal ' + (opts.cls || '') + '" role="dialog" aria-modal="true" ' + (opts.title ? 'aria-labelledby="' + hid + '"' : 'aria-label="' + esc(opts.label || 'Dialog') + '"') + '>' + (opts.title ? '<h2 id="' + hid + '">' + opts.title + '</h2>' : '') + '<div class="vstack gap12">' + (opts.body || '') + '</div>' + (opts.actions ? '<div class="mfoot">' + opts.actions + '</div>' : '') + '</div>';
      return App.openOverlay(ov, opts);
    },
    confirm(opts) {
      return new Promise((resolve) => {
        let ok = false;
        App.modal({
          title: esc(opts.title) + (opts.tag ? ' ' + UI.pill(opts.tag, opts.tone || 'danger') : ''),
          body: (opts.body || '') + (opts.kv ? UI.kv(opts.kv, 2) : ''),
          actions: UI.btn(opts.cancel || 'Cancel', { attrs: 'data-close' }) + UI.btn(opts.ok || 'Confirm', { kind: opts.tone === 'danger' ? 'danger' : 'primary', attrs: 'data-ok' }),
          onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { ok = true; App.closeOverlay(); }); },
          onClose() { resolve(ok); }
        });
      });
    },
    drawer(opts) {
      const ov = document.createElement('div'); ov.className = 'overlay'; ov.style.padding = '0';
      const hid = uid('dlg');
      ov.innerHTML = '<div class="drawer" role="dialog" aria-modal="true" ' + (opts.title ? 'aria-labelledby="' + hid + '"' : 'aria-label="' + esc(opts.label || 'Panel') + '"') + '><div class="hstack"><h2 class="grow" id="' + hid + '">' + (opts.title || '') + '</h2>' + UI.iconbtn('x', 'Close', { attrs: 'data-close', cls: 'ghost' }) + '</div>' + (opts.body || '') + (opts.actions ? '<div class="hstack wrap" style="margin-top:auto">' + opts.actions + '</div>' : '') + '</div>';
      return App.openOverlay(ov, opts);
    },
    closeOverlay() {
      const o = $('#overlay');
      if (o) {
        const back = o._returnTo, done = o._onClose; o._onClose = null;
        o.remove();
        const appEl = $('#app'); if (appEl) appEl.removeAttribute('inert');
        if (back && back.focus && document.contains(back)) back.focus({ preventScroll: true });
        else { const m = $('#main'); const h = m && m.querySelector('h1'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } else if (m) m.focus({ preventScroll: true }); }
        if (done) done();
      }
      $$('.popover').forEach((p) => p.remove());
    },

    // ----- command palette -----
    palette() {
      const items = [];
      NAV.forEach((g) => g.items.forEach((it) => { if (App.can(it.perm)) items.push({ group: 'Go to', label: it.label, sub: g.group ? 'Admin console' : 'Workspace', run: () => App.navigate(it.id) }); }));
      items.push({ group: 'Go to', label: 'Personal settings', sub: 'Profile, connected accounts, API keys', run: () => App.navigate('settings') });
      items.push({ group: 'Go to', label: 'Screen map', sub: 'Every screen you can open', run: () => App.map() });
      items.push({ group: 'Go to', label: 'Design system sheet', sub: 'Shared components', run: () => App.navigate('components') });
      Object.keys(screens).filter((id) => App.canOpen(id)).forEach((id) => (screens[id].commands || []).forEach((c) => items.push({ group: 'Commands', label: c.label, sub: c.sub || screens[id].title, run: () => { if (c.route !== false) App.navigate(id, c.params); setTimeout(() => c.run && c.run(App), 60); } })));
      items.push({ group: 'Commands', label: 'Switch theme', sub: 'Light, dark or system', run: () => App.setTheme(App.isDark() ? 'light' : 'dark') });
      items.push({ group: 'Commands', label: 'Sign out', sub: 'End this session', run: () => App.signOut() });
      // An ARIA 1.2 combobox: focus stays in the input, arrows move aria-activedescendant through the listbox.
      let active = 0, filtered = items;
      const m = App.modal({ cls: 'palette-host', body: '', label: 'Command palette' });
      m.className = 'palette';
      m.innerHTML = '<input type="text" placeholder="Search or run a command" aria-label="Search or run a command" id="palette-input" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" autocomplete="off" spellcheck="false">'
        + '<div class="plist" id="palette-list" role="listbox" aria-label="Screens and commands"></div><div class="sr" role="status" aria-live="polite" id="palette-count"></div>';
      const list = m.querySelector('#palette-list'), input = m.querySelector('input'), count = m.querySelector('#palette-count');
      const draw = () => {
        let g = null; let html = '';
        filtered.forEach((it, i) => {
          if (it.group !== g) { if (g !== null) html += '</div>'; g = it.group; html += '<div role="group" aria-label="' + esc(g) + '"><div class="pgroup" aria-hidden="true">' + esc(g) + '</div>'; }
          html += '<div class="pitem ' + (i === active ? 'active' : '') + '" role="option" id="palette-opt-' + i + '" aria-selected="' + (i === active ? 'true' : 'false') + '" data-i="' + i + '"><span>' + esc(it.label) + '</span><span class="ps">' + esc(it.sub || '') + '</span>' + (i === active ? '<span class="pk" aria-hidden="true">↵</span>' : '') + '</div>';
        });
        if (g !== null) html += '</div>';
        list.innerHTML = html || '<div class="pgroup">No matches</div>';
        if (filtered.length) { input.setAttribute('aria-activedescendant', 'palette-opt-' + active); const a = list.querySelector('#palette-opt-' + active); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' }); }
        else input.removeAttribute('aria-activedescendant');
      };
      const announce = () => { count.textContent = filtered.length ? filtered.length + (filtered.length === 1 ? ' result' : ' results') : 'No matches'; };
      input.addEventListener('input', () => { const q = input.value.toLowerCase().trim(); filtered = items.filter((it) => !q || (it.label + ' ' + (it.sub || '')).toLowerCase().includes(q)); active = 0; draw(); announce(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { active = Math.min(filtered.length - 1, active + 1); draw(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
        else if (e.key === 'Home' && e.ctrlKey) { active = 0; draw(); e.preventDefault(); }
        else if (e.key === 'End' && e.ctrlKey) { active = Math.max(0, filtered.length - 1); draw(); e.preventDefault(); }
        else if (e.key === 'Enter') { const it = filtered[active]; if (it) { App.closeOverlay(); it.run(); } }
      });
      on(list, 'click', '.pitem', (e, t) => { const it = filtered[+t.dataset.i]; App.closeOverlay(); it.run(); });
      draw(); input.focus();
    },

    // ----- prototype map -----
    map() {
      const groups = [
        ['Conversation', ['signin', 'chat', 'compare', 'runs']], ['Knowledge, memory and media', ['knowledge', 'memory', 'media', 'images']],
        ['Models and training', ['models', 'profiles', 'pools', 'training']], ['Build', ['registry', 'mcp-servers', 'workflows', 'scripts', 'connections']],
        ['Govern', ['guardrails', 'flags', 'classifiers', 'usage-audit']], ['Platform administration', ['tenants', 'directories', 'identity', 'zones', 'platform', 'settings', 'components']]
      ];
      const body = groups.map((g) => '<div class="vstack"><div class="eyebrow">' + g[0] + '</div><div class="map-grid">' + g[1].map((id) => { const s = screens[id]; return s && App.canOpen(id) ? '<button type="button" class="map-card" data-go="' + id + '"><span class="t">' + esc(s.title) + '</span><span class="s">' + esc(s.summary || '') + '</span></button>' : ''; }).join('') + '</div></div>').join('');
      App.modal({ cls: 'wide', title: 'Screen map', body: '<p class="fg2" style="margin:0">Every screen you can open. Screens marked as prototype data still show the design boards\' example content.</p>' + body, onMount(m) { on(m, 'click', '[data-go]', (e, t) => { App.closeOverlay(); App.navigate(t.dataset.go); }); } });
    },

    // ----- popovers -----
    // Opens `pop` inside `host` for the button `trigger`: marks the trigger expanded, moves focus to the first item and
    // lets Esc close it and return focus to the trigger (see the keydown handler below).
    openPopover(trigger, host, pop) {
      pop._trigger = trigger; pop.setAttribute('role', 'dialog'); if (!pop.hasAttribute('aria-label')) pop.setAttribute('aria-label', (pop.querySelector('.ph') || {}).textContent || 'Menu');
      host.appendChild(pop); trigger.setAttribute('aria-expanded', 'true');
      const first = pop.querySelector('button:not([disabled]),a[href]'); if (first) first.focus(); else { pop.setAttribute('tabindex', '-1'); pop.focus(); }
      return pop;
    },
    closePopovers(refocus) {
      $$('.popover').forEach((p) => { const t = p._trigger; p.remove(); if (t) { t.setAttribute('aria-expanded', 'false'); if (refocus && document.contains(t)) t.focus(); } });
    },

    // ----- shell rendering -----
    renderSidebar() {
      const cur = state.route;
      const side = $('#sidebar');
      side.innerHTML = '<button type="button" class="tenant" id="tenant-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="Workspace: ' + esc(DATA.tenant.workspace) + ', ' + esc(DATA.tenant.name) + ' tenant. Switch workspace"><span><b>' + esc(DATA.tenant.workspace) + '</b><small>' + esc(DATA.tenant.name) + ' tenant</small></span><span class="sw">switch</span></button>'
        + NAV.map((g) => ({ group: g.group, items: g.items.filter((it) => App.can(it.perm)) })).filter((g) => g.items.length).map((g) => (g.group ? '<div class="navhead" id="navhead-' + esc(g.group) + '">' + g.group + '</div>' : '') + '<div class="navlist"' + (g.group ? ' role="group" aria-labelledby="navhead-' + esc(g.group) + '"' : '') + '>' + g.items.map((it) => '<a href="' + App.hrefFor(it.id) + '" class="' + (cur === it.id ? 'active' : '') + '"' + (cur === it.id ? ' aria-current="page"' : '') + '>' + icon(it.icon) + esc(it.label) + (it.count ? '<span class="count ' + (it.hot ? 'hot' : '') + '">' + it.count + '</span>' : '') + '</a>').join('') + '</div>').join('')
        + '<a href="' + App.hrefFor('settings') + '" class="me ' + (cur === 'settings' ? 'active' : '') + '"' + (cur === 'settings' ? ' aria-current="page"' : '') + ' aria-label="Settings for ' + esc(DATA.user.name) + '"><span class="avatar" aria-hidden="true">' + DATA.user.initials + '</span><span>' + esc(DATA.user.name) + '</span></a>';
      $('#tenant-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const existing = $('.popover', side); if (existing) { App.closePopovers(); return; }
        const pop = document.createElement('div'); pop.className = 'popover'; pop.style.cssText = 'position:fixed;left:8px;top:52px;right:auto;width:260px';
        pop.innerHTML = '<div class="ph">Switch workspace</div>' + DATA.workspaces.map((w) => '<button type="button" class="pi" data-ws="' + esc(w.id) + '"><span class="hstack"><span class="t grow">' + esc(w.name) + '</span>' + UI.label(w.label, { sm: true }) + '</span><span class="s">' + esc(w.tenant) + '</span></button>').join('') + (DATA.workspaces.length ? '' : '<div class="pi"><span class="s">No workspaces yet. A tenant admin creates them.</span></div>') + (App.can('tenant:manage') ? '<div class="divider"></div><button type="button" class="pi" data-go="tenants"><span class="t">Manage tenants and workspaces</span></button>' : '');
        App.openPopover(e.currentTarget, side, pop);
        on(pop, 'click', '[data-ws]', (ev, t) => { pop.remove(); if (t.dataset.ws !== DATA.tenant.workspaceId) App.switchWorkspace(t.dataset.ws); });
        on(pop, 'click', '[data-go]', (ev, t) => { pop.remove(); App.navigate(t.dataset.go); });
      });
    },
    renderHeader() {
      const s = screens[state.route]; if (!s) return;
      const crumb = typeof s.crumb === 'function' ? s.crumb(App.stateFor(s.id), state.params) : (s.crumb || [s.section === 'admin' ? 'Admin' : null, s.title]);
      const lbl = typeof s.label === 'function' ? s.label(App.stateFor(s.id), state.params) : s.label;
      // Re-rendering the header replaces its buttons; keep keyboard focus on the one that had it (theme, bell).
      const had = document.activeElement && $('#header').contains(document.activeElement) ? document.activeElement.id : null;
      $('#header').innerHTML = '<div class="hstack" style="min-width:0">' + UI.iconbtn('menu', 'Menu', { cls: 'menubtn', attrs: 'id="menu-btn" aria-controls="sidebar" aria-expanded="' + (state.navOpen ? 'true' : 'false') + '"' }) + '<nav class="crumbs" aria-label="Breadcrumb">' + crumb.filter(Boolean).map((c, i, a) => (i < a.length - 1 ? '<span class="c1">' + esc(c) + '</span><span class="sep" aria-hidden="true">/</span>' : '<span class="c2" aria-current="page">' + esc(c) + '</span>')).join('') + (lbl ? UI.label(lbl) : '') + '</nav></div>'
        + '<div class="htools relative">' + '<button type="button" class="cmdbtn" id="cmd-btn" aria-label="Search or run a command" aria-keyshortcuts="Control+K" aria-haspopup="dialog"><span>Search or run a command</span><kbd aria-hidden="true">Ctrl K</kbd></button>' + UI.iconbtn(App.isDark() ? 'sun' : 'moon', App.isDark() ? 'Switch to light theme' : 'Switch to dark theme', { attrs: 'id="theme-btn"' }) + UI.iconbtn('bell', DATA.notifications.length ? 'Notifications, ' + DATA.notifications.length + ' unread' : 'Notifications', { attrs: 'id="bell-btn" aria-haspopup="dialog" aria-expanded="false"', dot: DATA.notifications.length > 0 }) + '</div>';
      if (had) { const f = document.getElementById(had); if (f) f.focus(); }
      $('#cmd-btn').addEventListener('click', () => App.palette());
      $('#theme-btn').addEventListener('click', () => App.setTheme(App.isDark() ? 'light' : 'dark'));
      $('#menu-btn').addEventListener('click', (e) => { state.navOpen = !state.navOpen; $('#app').classList.toggle('nav-open', state.navOpen); e.currentTarget.setAttribute('aria-expanded', state.navOpen ? 'true' : 'false'); if (state.navOpen) { const a = $('#sidebar a.active') || $('#sidebar a,#sidebar button'); if (a) a.focus(); } });
      $('#bell-btn').addEventListener('click', (e) => {
        e.stopPropagation(); const host = $('#header .htools'); const ex = $('.popover', host); if (ex) { App.closePopovers(); return; }
        const trigger = e.currentTarget; const pop = document.createElement('div'); pop.className = 'popover';
        pop.innerHTML = '<div class="ph">Notifications</div>' + (DATA.notifications.length ? '' : '<div class="pi"><span class="s">Nothing new.</span></div>') + DATA.notifications.map((n) => '<button type="button" class="pi" data-go="' + esc(n.route) + '" data-nid="' + esc(n.id) + '"><span class="t">' + esc(n.title) + '</span><span class="s">' + esc(n.sub) + '</span></button>').join('') + '<div class="divider"></div><div class="hstack"><span class="muted grow" style="font-size:12px">Delivered live to the console' + (DATA.notificationEmail ? ' and by email.' : '.') + '</span>' + UI.btn('Mark all read', { kind: 'ghost', size: 'sm', attrs: 'data-read' + (DATA.notifications.length ? '' : ' disabled') }) + '</div>';
        App.openPopover(trigger, host, pop);
        const markRead = (ids) => api('POST', '/api/me/notifications/read', ids ? { ids } : {}).catch((err) => App.fail(err, 'Could not mark read'));
        on(pop, 'click', '[data-go]', (ev, t) => { pop.remove(); DATA.notifications = DATA.notifications.filter((n) => n.id !== t.dataset.nid); markRead([t.dataset.nid]); App.renderHeader(); if (t.dataset.go && App.canOpen(t.dataset.go)) App.navigate(t.dataset.go); });
        on(pop, 'click', '[data-read]', () => { pop.remove(); DATA.notifications = []; markRead(); App.renderHeader(); });
      });
    },
    applyState(i) {
      const s = screens[state.route]; const st = s.states[i]; if (!st) return;
      const ctx = App.ctx(s);
      if (st.apply) st.apply(ctx); else App.toast('<b>' + esc(st.title) + '</b> — ' + esc(st.text), st.tone === 'danger' ? 'danger' : st.tone === 'warn' ? 'warn' : '', 6000);
    },
    ctx(s) {
      return {
        app: App, UI, DATA, params: state.params, state: App.stateFor(s.id),
        navigate: App.navigate, toast: App.toast, modal: App.modal, confirm: App.confirm, drawer: App.drawer,
        rerender: () => App.render(), root: $('#main'), $: (sel) => $(sel, $('#main')), $$: (sel) => $$(sel, $('#main')), on: (ev, sel, fn) => on($('#main'), ev, sel, fn)
      };
    },
    render() {
      const r = App.parse(); const entering = r.route !== state.route || location.hash !== state.lastHash; const prevRoute = state.route;
      state.route = r.route; state.params = r.params; state.lastHash = location.hash;
      // Live screens refetch whenever they are entered, so data is never older than the visit.
      if (entering && state.screenState[r.route]) state.screenState[r.route].loaded = false;
      if (App.fileMode) {
        if (!screens[state.route] && state.route !== 'not-found') { location.replace(App.hrefFor(state.route) + (location.hash.split('?')[1] ? '?' + location.hash.split('?')[1] : '')); return; }
      } else if (!state.signedIn && state.route !== 'signin' && !PUBLIC_ROUTES[state.route]) { if (state.booted) state.afterSignIn = state.route; state.route = 'signin'; }
      else if (state.signedIn && state.route === 'signin') { state.route = App.firstRoute(); }
      let s = screens[state.route] || screens['not-found'];
      if (state.signedIn && !App.canOpen(state.route)) s = screens.forbidden;
      const bare = state.route === 'signin' || (!state.signedIn && !!PUBLIC_ROUTES[state.route]);
      const app = $('#app'); app.classList.toggle('signed-out', bare); app.classList.remove('nav-open'); state.navOpen = false;
      App.closeOverlay();
      // A fresh element each render: listeners a screen attached through ctx.on (or directly on root) go with the old one,
      // so a re-render or a route change never leaves a previous render's handlers running.
      if (App._banner) { App._banner.remove(); App._banner = null; }
      const old = $('#main');
      // A re-render of the same screen puts keyboard focus back on the matching element; entering a screen moves focus
      // to its heading so screen readers announce it (WCAG 2.4.3). The first render after boot leaves focus alone.
      const routeChanged = state.route !== prevRoute;
      const keep = routeChanged || !old.contains(document.activeElement) ? null : document.activeElement === old ? { main: true } : App.focusKey(document.activeElement, old);
      const moveFocus = routeChanged && state.rendered && !$('#overlay');
      const main = document.createElement('main'); main.id = 'main'; main.className = 'main'; main.setAttribute('tabindex', '-1'); main.setAttribute('aria-label', s.title || 'Exprsn-AI');
      old.replaceWith(main);
      document.title = (s.title || 'Exprsn-AI') + ' · Exprsn-AI';
      if (!bare) { App.renderSidebar(); App.renderHeader(); }
      if (state.signedIn && !App.isLive(s.id) && s.id !== 'forbidden') {
        const it = NAV_BY_ID[s.id];
        const banner = document.createElement('div'); banner.className = 'notice warn'; banner.setAttribute('role', 'note');
        banner.style.cssText = 'position:sticky;top:0;z-index:5;border-radius:0;border-left:0;border-right:0;margin:0';
        banner.innerHTML = icon('info', 15) + '<span class="grow"><b>Prototype data.</b> This screen shows example data and changes nothing' + (it && it.sprint ? '; it is connected to the server in sprint ' + it.sprint : '') + '.</span>';
        main.parentNode.insertBefore(banner, main); App._banner = banner;
      }
      try { s.render(main, App.ctx(s)); } catch (err) { main.innerHTML = '<div class="page">' + UI.problem('This screen failed to render', String(err && err.message || err)) + '</div>'; console.error(err); }
      // global delegated behaviours inside main
      main.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => App.toast('Copied ' + esc(b.dataset.copy))));
      window.scrollTo(0, 0);
      App.a11yPass(main);
      if (!main.contains(document.activeElement) && !$('#overlay')) {
        if (keep) App.restoreFocus(keep, main);
        else if (moveFocus) { const h = main.querySelector('h1'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } else main.focus({ preventScroll: true }); }
      }
      state.rendered = true;
    },

    // ----- accessibility helpers -----
    /** Describes a focused element well enough to find its counterpart after the screen re-renders. */
    focusKey(el, root) {
      const cssq = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
      const caret = typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null;
      if (el.tagName === 'H1') return { sel: 'h1', index: 0 };
      // Ids that uid() made change on every render, so they cannot find the element again.
      if (el.id && !/^[a-z]+-\d+$/.test(el.id)) return { sel: '#' + cssq(el.id), index: 0, caret };
      const attrs = Array.prototype.filter.call(el.attributes, (a) => /^data-/.test(a.name) || a.name === 'name' || a.name === 'aria-label');
      if (attrs.length) { const sel = el.tagName.toLowerCase() + attrs.map((a) => '[' + a.name + '="' + cssq(a.value) + '"]').join(''); return { sel, index: Math.max(0, $$(sel, root).indexOf(el)), caret }; }
      const path = []; let n = el; while (n && n !== root && n.parentNode) { path.unshift(Array.prototype.indexOf.call(n.parentNode.children, n)); n = n.parentNode; }
      return { path, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60), caret };
    },
    restoreFocus(key, root) {
      let el = null;
      if (key.main) { root.focus({ preventScroll: true }); return; }
      try { if (key.sel) { const all = $$(key.sel, root); el = all[key.index] || all[0] || null; } } catch (e) { el = null; }
      if (el && el.tagName === 'H1') el.setAttribute('tabindex', '-1');
      if (!el && key.path) { el = root; for (const i of key.path) { el = el && el.children[i]; } if (el && (el.tagName !== key.tag || (el.textContent || '').trim().slice(0, 60) !== key.text)) el = null; }
      if (!el || typeof el.focus !== 'function') return;
      el.focus({ preventScroll: true });
      if (key.caret && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(key.caret[0], key.caret[1]); } catch (e) { /* not a text field */ } }
      const r = el.getBoundingClientRect(); if ((r.bottom < 0 || r.top > window.innerHeight) && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    },
    /** The one tabpanel for a tab list (B-1103): everything after the list up to the next tab list, wrapped in a
     *  single element when it is more than one (the wrapper repeats the parent's flex layout, so nothing moves). */
    tabPanel(list) {
      const parent = list.parentElement; if (!parent) return null;
      const after = [];
      for (let n = list.nextElementSibling; n && n.getAttribute('role') !== 'tablist'; n = n.nextElementSibling) if (!/^(STYLE|SCRIPT|TEMPLATE)$/.test(n.tagName)) after.push(n);
      if (!after.length) return null;
      const first = after[0];
      const usable = (el) => /^(DIV|SECTION)$/.test(el.tagName) && (!el.getAttribute('role') || el.getAttribute('role') === 'tabpanel');
      if (after.length === 1 && usable(first)) return first;
      const cs = getComputedStyle(parent);
      if (/grid/.test(cs.display)) return usable(first) ? first : null;
      const focused = document.activeElement;
      let wrap = first.hasAttribute('data-tabpanel-wrap') ? first : null;
      if (!wrap) {
        wrap = document.createElement('div'); wrap.setAttribute('data-tabpanel-wrap', '');
        if (/flex/.test(cs.display)) wrap.style.cssText = 'display:flex;flex-direction:' + cs.flexDirection + ';flex-wrap:' + cs.flexWrap + ';align-items:' + cs.alignItems + ';gap:' + cs.gap + ';flex:1 0 auto;min-width:0';
        parent.insertBefore(wrap, first);
      }
      after.forEach((el) => { if (el !== wrap) wrap.appendChild(el); });
      if (focused && focused !== document.activeElement && document.contains(focused) && typeof focused.focus === 'function') focused.focus({ preventScroll: true });
      return wrap;
    },
    /** Fills in what screens leave out: names for icon-only buttons and placeholder-only fields, header scope, and
     *  keyboard access to clickable table rows (Enter or Space clicks the row; see the keydown handler). */
    a11yPass(root) {
      if (!root) return;
      $$('button:not([aria-label]):not([aria-labelledby])', root).forEach((b) => { if (!b.textContent.trim() && b.title) b.setAttribute('aria-label', b.title); });
      $$('input:not([type="hidden"]):not([aria-label]):not([aria-labelledby]),select:not([aria-label]):not([aria-labelledby]),textarea:not([aria-label]):not([aria-labelledby])', root).forEach((f) => {
        if (f.labels && f.labels.length) return; const n = f.getAttribute('placeholder') || f.getAttribute('title'); if (n) f.setAttribute('aria-label', n);
      });
      $$('thead th:not([scope])', root).forEach((th) => th.setAttribute('scope', 'col'));
      $$('table.dt tbody tr.row:not([tabindex])', root).forEach((tr) => tr.setAttribute('tabindex', '0'));
      // Scrolling tables and code (B-1102): a keyboard stop, a name, and data-scrolls, which app.css gives a scrollbar
      // that stays visible, so a table that is wider than a narrow window reads as scrollable.
      $$('.tablewrap,.codebox,pre,[data-scroll-x]', root).forEach((el) => {
        const scrolls = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        if (scrolls && !el.hasAttribute('data-scrolls')) {
          el.setAttribute('data-scrolls', '');
          if (!el.hasAttribute('tabindex')) { el.setAttribute('tabindex', '0'); el.setAttribute('data-scroll-tab', ''); }
          if (!el.getAttribute('role')) el.setAttribute('role', 'region');
          if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.matches('.codebox,pre') ? 'Code, scrollable' : el.hasAttribute('data-scroll-2d') ? 'Diagram, scrollable' : 'Table, scrolls sideways');
        } else if (!scrolls && el.hasAttribute('data-scrolls')) {
          el.removeAttribute('data-scrolls');
          if (el.hasAttribute('data-scroll-tab')) { el.removeAttribute('tabindex'); el.removeAttribute('data-scroll-tab'); el.removeAttribute('role'); el.removeAttribute('aria-label'); }
        }
      });
      // Tabs: ids, one tab in the tab order, and the selected tab labels the panel that follows the list.
      $$('[role="tablist"]', root).forEach((list) => {
        const tabs = $$('[role="tab"]', list); if (!tabs.length) return;
        tabs.forEach((t) => { if (!t.id) t.id = uid('tab'); });
        const cur = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
        if (!cur && !tabs.some((t) => t.getAttribute('tabindex') === '0')) tabs[0].setAttribute('tabindex', '0');
        const panel = cur ? App.tabPanel(list) : null;
        if (!panel) return;
        if (!panel.id) panel.id = uid('tabpanel');
        panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', cur.id);
        tabs.forEach((t) => { if (t === cur) t.setAttribute('aria-controls', panel.id); else t.removeAttribute('aria-controls'); });
      });
    }
  };

  // not-found screen
  App.register({ id: 'not-found', title: 'Not found', crumb: ['Not found'], render(root, ctx) { root.innerHTML = '<div class="page">' + UI.problem('No such screen', 'The route in the address bar does not match a screen in the console.', false) + '<div>' + UI.btn('Open the screen map', { kind: 'primary', attrs: 'data-map' }) + '</div></div>'; ctx.on('click', '[data-map]', () => App.map()); } });
  App.register({ id: 'forbidden', title: 'Not permitted', crumb: ['Not permitted'], render(root, ctx) { const it = NAV_BY_ID[state.route]; root.innerHTML = '<div class="page">' + UI.problem('You do not have access to ' + (it ? it.label : 'this screen'), 'It needs the ' + (it ? it.perm : '') + ' permission, which none of your roles grant. An identity admin can map your directory group to a role that does.', false) + '<div>' + UI.btn('Back to your workspace', { kind: 'primary', attrs: 'data-home' }) + '</div></div>'; ctx.on('click', '[data-home]', () => App.navigate(App.firstRoute())); } });

  // global events
  let tabTurn = 0;
  window.addEventListener('hashchange', App.render);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('#palette-input')) App.closeOverlay(); else App.palette(); }
    else if (e.key === 'Escape') {
      if ($('.popover') && !$('#overlay')) { App.closePopovers(true); return; }
      if (state.navOpen && !$('#overlay')) { state.navOpen = false; $('#app').classList.remove('nav-open'); const mb = $('#menu-btn'); if (mb) { mb.setAttribute('aria-expanded', 'false'); mb.focus(); } return; }
      App.closeOverlay();
    }
    else if (e.key === '?' && state.singleKeys && !e.ctrlKey && !e.metaKey && !e.altKey && !/input|textarea|select/i.test(document.activeElement.tagName) && !document.activeElement.isContentEditable && !$('#overlay')) { App.map(); }
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('table.dt tbody tr.row')) { e.preventDefault(); e.target.click(); }
    else if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.matches && e.target.matches('[role="tab"]')) {
      // Tabs: arrows move to the previous or next tab (wrapping), Home and End to the first and last; selection follows focus.
      const tabs = $$('[role="tab"]', e.target.closest('[role="tablist"]') || document); const i = tabs.indexOf(e.target);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      e.preventDefault(); if (!tabs[n] || tabs[n] === e.target) return;
      const want = tabs[n].dataset.tab; tabs[n].focus(); tabs[n].click();
      // A screen that loads the new tab's data re-renders more than once; keep focus on the tab while it settles.
      let tries = 0; const turn = ++tabTurn;
      const keep = () => {
        if (turn !== tabTurn) return; // a later key press took over
        const a = document.activeElement;
        if (!a || a === document.body || a.id === 'main') { const t = $$('[role="tab"]').find((x) => x.dataset.tab === want); if (t) t.focus(); }
        if (++tries < 10) setTimeout(keep, 100);
      };
      setTimeout(keep, 0);
    }
  });
  // Screens that update part of their DOM without a full render (streaming, lazy panels) still get the a11y pass.
  let passTimer = null;
  const schedulePass = () => { if (passTimer) return; passTimer = setTimeout(() => { passTimer = null; App.a11yPass($('#main')); App.a11yPass($('#overlay')); }, 150); };
  if (window.MutationObserver) document.addEventListener('DOMContentLoaded', () => new MutationObserver(schedulePass).observe(document.body, { childList: true, subtree: true }));
  // A narrower window (or zoom) can make a table scroll: the pass marks it again (B-1102).
  window.addEventListener('resize', schedulePass);
  document.addEventListener('click', (e) => {
    const sk = e.target.closest && e.target.closest('#skip-link');
    if (sk) { e.preventDefault(); const m = $('#main'); if (m) { const h = m.querySelector('h1'); if (h) { h.setAttribute('tabindex', '-1'); h.focus(); } else m.focus(); } }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.popover') && !e.target.closest('#tenant-btn') && !e.target.closest('#bell-btn')) App.closePopovers(); });
  // generic behaviours: toggles, tabs, segs, chips
  document.addEventListener('click', (e) => {
    const tg = e.target.closest('.toggle'); if (tg && !tg.dataset.manual) { tg.classList.toggle('on'); tg.setAttribute('aria-checked', tg.classList.contains('on') ? 'true' : 'false'); }
    const ch = e.target.closest('.chip[data-toggle]'); if (ch) { ch.classList.toggle('on'); ch.setAttribute('aria-pressed', ch.classList.contains('on') ? 'true' : 'false'); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    if (state.theme) document.documentElement.setAttribute('data-theme', state.theme);
    App.boot();
  });
  window.App = App;
})();
