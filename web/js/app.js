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
    calc: 'M6 3h12v18H6zM9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', upload: 'M12 20V8M6 14l6-6 6 6M4 4h16', undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3', map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6'
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
      return '<span class="label ' + level + (opts.sm ? ' sm' : '') + '" title="Classification: ' + level + '"><span class="bars">' + bars + '</span>' + level + '</span>';
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
    chip(text, on, attrs) { return '<button type="button" class="chip' + (on ? ' on' : '') + '" ' + (attrs || '') + '>' + text + '</button>'; },
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
      const th = cols.map((c) => { const o = typeof c === 'string' ? { label: c } : c; return '<th' + (o.right ? ' class="r"' : '') + (o.width ? ' style="width:' + o.width + '"' : '') + '>' + esc(o.label) + '</th>'; }).join('');
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
      return '<nav class="tabs" aria-label="Sections" ' + (attrs || '') + '>' + items.map((t) => { const o = typeof t === 'string' ? { id: t, label: t } : t; return '<button type="button" data-tab="' + esc(o.id) + '" class="' + (o.id === active ? 'active' : '') + '">' + esc(o.label) + (o.count != null ? ' <span class="count">' + o.count + '</span>' : '') + '</button>'; }).join('') + '</nav>';
    },
    seg(items, active, attrs) {
      return '<div class="seg" ' + (attrs || '') + '>' + items.map((t) => { const o = typeof t === 'string' ? { id: t, label: t } : t; return '<button type="button" data-seg="' + esc(o.id) + '" class="' + (o.id === active ? 'active' : '') + '">' + esc(o.label) + '</button>'; }).join('') + '</div>';
    },
    field(label, control, hint) { const id = uid('f'); return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' + control.replace('<input', '<input id="' + id + '"').replace('<select', '<select id="' + id + '"').replace('<textarea', '<textarea id="' + id + '"') + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>'; },
    input(value, opts) { opts = opts || {}; return '<input class="input" type="' + (opts.type || 'text') + '" value="' + esc(value) + '" placeholder="' + esc(opts.placeholder || '') + '" ' + (opts.attrs || '') + (opts.readonly ? ' readonly' : '') + '>'; },
    textarea(value, opts) { opts = opts || {}; return '<textarea class="textarea" placeholder="' + esc(opts.placeholder || '') + '" ' + (opts.attrs || '') + ' style="' + (opts.rows ? 'min-height:' + (opts.rows * 20 + 16) + 'px' : '') + '">' + esc(value) + '</textarea>'; },
    select(options, value, attrs) { return '<select class="select" ' + (attrs || '') + '>' + options.map((o) => { const v = typeof o === 'string' ? o : o.value, l = typeof o === 'string' ? o : o.label; return '<option value="' + esc(v) + '"' + (v === value ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') + '</select>'; },
    toggle(label, on, attrs) { return '<button type="button" class="toggle' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" ' + (attrs || '') + '><span class="sw"></span><span>' + esc(label) + '</span></button>'; },
    check(label, on, attrs) { return '<label class="check"><input type="checkbox"' + (on ? ' checked' : '') + ' ' + (attrs || '') + '><span>' + esc(label) + '</span></label>'; },
    search(placeholder, attrs, value) { return '<div class="search">' + icon('search', 14) + '<input type="search" placeholder="' + esc(placeholder) + '" value="' + esc(value || '') + '" aria-label="' + esc(placeholder) + '" ' + (attrs || '') + '></div>'; },
    meter(label, valueText, pct, tone) { return '<div class="meter ' + (tone || '') + '"><div class="mrow"><span>' + esc(label) + '</span><span class="num">' + esc(valueText) + '</span></div><div class="track"><div class="fill" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></div></div></div>'; },
    notice(text, kind, action) { return '<div class="notice ' + (kind || 'info') + '">' + icon(kind === 'danger' || kind === 'warn' ? 'warn' : 'info', 15) + '<span class="grow">' + text + '</span>' + (action || '') + '</div>'; },
    empty(title, text, action) { return '<div class="empty"><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' + (action ? '<div>' + action + '</div>' : '') + '</div>'; },
    // trace === false omits the trace row (for problems that did not come from a request).
    problem(title, text, trace) { return '<div class="problem"><div class="ptitle">' + esc(title) + '</div><div class="ptext">' + esc(text) + '</div>' + (trace === false ? '</div>' : '<div class="trace"><span>Trace</span><span class="mono">' + esc(trace || '4bf92f3577b34da6a3ce929d0e0e4736') + '</span>' + UI.btn('Copy', { kind: 'ghost', size: 'sm', attrs: 'data-copy="' + esc(trace || '4bf92f3577b34da6a3ce929d0e0e4736') + '"' }) + '</div></div>'); },
    ctx(title, body, level) { return '<div class="ctxblock"><div class="chead"><span><span class="eyebrow">Context data</span>' + esc(title) + '</span>' + (level ? UI.label(level, { sm: true }) : '') + '</div><pre>' + esc(body) + '</pre></div>'; },
    code(text, lang) { const lines = String(text).split('\n'); return '<pre class="codebox" data-lang="' + esc(lang || '') + '">' + lines.map((l, i) => '<span class="ln">' + (i + 1) + '</span>' + esc(l)).join('\n') + '</pre>'; },
    reviewbar(text, actions) { return '<div class="reviewbar"><span class="grow">' + text + '</span>' + (actions || '') + '</div>'; },
    stat(n, label, detail) { return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + esc(label) + '</div>' + (detail ? '<div class="d">' + detail + '</div>' : '') + '</div>'; },
    spark(values, hiIndex) { const m = Math.max.apply(null, values) || 1; return '<span class="spark" aria-hidden="true">' + values.map((v, i) => '<i style="height:' + Math.max(2, Math.round((v / m) * 22)) + 'px" class="' + (i === hiIndex ? 'hi' : '') + '"></i>').join('') + '</span>'; },
    timeline(items) { return '<div class="timeline">' + items.map((it, i) => '<div class="tl"><div class="dotcol"><i class="' + (it.tone || '') + '"></i>' + (i < items.length - 1 ? '<b></b>' : '') + '</div><div class="tbody"><div style="font-weight:600">' + it.title + '</div>' + (it.text ? '<div class="fg2" style="font-size:12px">' + it.text + '</div>' : '') + (it.meta ? '<div class="muted" style="font-size:12px">' + it.meta + '</div>' : '') + '</div></div>').join('') + '</div>'; },
    listItem(title, sub, opts) { opts = opts || {}; return '<button type="button" class="listlink' + (opts.active ? ' active' : '') + '" ' + (opts.attrs || '') + '><span><span class="t">' + title + '</span>' + (sub ? '<span class="s">' + sub + '</span>' : '') + '</span>' + (opts.right || '') + '</button>'; },
    states(list) { return '<div class="state-strip">' + list.map((s, i) => '<button type="button" class="state-card" data-state="' + i + '"><div class="st ' + (s.tone || 'neutral') + '">' + esc(s.title) + '</div><div class="sd">' + esc(s.text) + '</div></button>').join('') + '</div>'; }
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
      { id: 'knowledge', label: 'Knowledge', icon: 'knowledge', perm: 'knowledge:read', sprint: 6 }, { id: 'memory', label: 'Memory', icon: 'memory', perm: 'memory:write', sprint: 6 }, { id: 'workflows', label: 'Workflows', icon: 'workflows', perm: 'agents:run', sprint: 8 },
      { id: 'scripts', label: 'Scripts', icon: 'scripts', perm: 'scripts:run', live: true }, { id: 'media', label: 'Media', icon: 'media', perm: 'chat:write', sprint: 8 }, { id: 'images', label: 'Images', icon: 'images', perm: 'images:generate', sprint: 8 }
    ] },
    { group: 'Admin', items: [
      { id: 'models', label: 'Models', icon: 'models', perm: 'models:manage', live: true }, { id: 'profiles', label: 'Profiles', icon: 'profiles', perm: 'profiles:manage', live: true }, { id: 'pools', label: 'Pools', icon: 'pools', perm: 'pools:manage', live: true },
      { id: 'registry', label: 'Registry', icon: 'registry', perm: 'tools:manage', live: true }, { id: 'mcp-servers', label: 'MCP servers', icon: 'mcp', perm: 'mcp:manage', live: true }, { id: 'guardrails', label: 'Guardrails', icon: 'guardrails', perm: 'guardrails:manage', live: true },
      { id: 'flags', label: 'Flags', icon: 'flags', perm: 'flags:review', live: true }, { id: 'classifiers', label: 'Classifiers', icon: 'classifiers', perm: 'classifiers:manage', live: true }, { id: 'connections', label: 'Connections', icon: 'connections', perm: 'connections:manage', sprint: 6 },
      { id: 'training', label: 'Training', icon: 'training', perm: 'training:manage', sprint: 9 }, { id: 'tenants', label: 'Tenants', icon: 'tenants', perm: 'tenant:manage', live: true },
      { id: 'directories', label: 'User stores', icon: 'identity', perm: 'identity:manage', live: true }, { id: 'identity', label: 'Identity', icon: 'key', perm: 'identity:manage', sprint: 9 },
      { id: 'zones', label: 'Zones', icon: 'zones', perm: 'zones:manage', sprint: 9 }, { id: 'usage-audit', label: 'Usage and audit', icon: 'audit', perm: 'audit:read', live: true }, { id: 'platform', label: 'Platform', icon: 'platform', perm: 'platform:manage', sprint: 9 }
    ] }
  ];
  const NAV_BY_ID = {}; NAV.forEach((g) => g.items.forEach((it) => { NAV_BY_ID[it.id] = it; }));
  // Screens outside the sidebar that everyone signed in may open.
  const OPEN_ROUTES = { signin: true, settings: true, components: true, 'not-found': true };

  // ---------- App ----------
  const screens = {};
  const state = { route: null, params: {}, screenState: {}, theme: null, signedIn: false, navOpen: false, csrf: null, booted: false };
  try { state.theme = localStorage.getItem('exprsn.theme'); } catch (e) { /* storage unavailable */ }

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
      if (res.status === 401 && !/^\/api\/auth\//.test(url) && state.signedIn) App.sessionEnded('Your session ended. Sign in again.');
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
    async signOut() { try { await api('POST', '/api/auth/logout'); } catch (e) { /* already gone */ } App.sessionEnded(); },
    /** Clears local state after sign-out, revocation or expiry. */
    sessionEnded(message) {
      const was = state.signedIn; state.signedIn = false; state.csrf = null; App.me = null; state.screenState = {};
      if (App.socket) { App.socket.close(); App.socket = null; }
      if (message && was) App.toast(esc(message), 'warn', 6000);
      App.navigate('signin'); if (App.parse().route === 'signin') App.render();
    },
    setMe(me) {
      App.me = me;
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
      const r = App.parse().route; if (r !== 'signin') { state.afterSignIn = r; state.afterSignInHash = location.hash || null; }
      App.navigate('signin'); App.render();
    },
    setTheme(t) { state.theme = t; if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); try { t ? localStorage.setItem('exprsn.theme', t) : localStorage.removeItem('exprsn.theme'); } catch (e) {} App.renderHeader(); },
    isDark() { return state.theme === 'dark' || (!state.theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); },

    // ----- toasts -----
    toast(msg, kind, ms) {
      const host = $('#toasts');
      const el = document.createElement('div'); el.className = 'toast ' + (kind || ''); el.setAttribute('role', 'status'); el.innerHTML = msg;
      host.appendChild(el); setTimeout(() => { el.remove(); }, ms || 3200);
    },

    // ----- modal / confirm / drawer -----
    // Shared by modal() and drawer(): the overlay closes on backdrop click, Esc (see the keydown handler below) and any
    // [data-close] inside it; Tab stays inside it; focus goes back where it was when it closes; opts.onClose runs once on close.
    openOverlay(ov, opts) {
      App.closeOverlay();
      ov.id = 'overlay'; ov._onClose = opts.onClose || null; ov._returnTo = document.activeElement;
      document.body.appendChild(ov);
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
      const f = ov.querySelector('input,select,textarea,button'); if (f) f.focus();
      return ov.firstChild;
    },
    modal(opts) {
      const ov = document.createElement('div'); ov.className = 'overlay' + (opts.center ? ' center' : '');
      ov.innerHTML = '<div class="modal ' + (opts.cls || '') + '" role="dialog" aria-modal="true" aria-label="' + esc(opts.title || 'Dialog') + '">' + (opts.title ? '<h2>' + opts.title + '</h2>' : '') + '<div class="vstack gap12">' + (opts.body || '') + '</div>' + (opts.actions ? '<div class="mfoot">' + opts.actions + '</div>' : '') + '</div>';
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
      ov.innerHTML = '<aside class="drawer" role="dialog" aria-modal="true" aria-label="' + esc(opts.title || 'Panel') + '"><div class="hstack"><h2 class="grow">' + (opts.title || '') + '</h2>' + UI.iconbtn('x', 'Close', { attrs: 'data-close', cls: 'ghost' }) + '</div>' + (opts.body || '') + (opts.actions ? '<div class="hstack wrap" style="margin-top:auto">' + opts.actions + '</div>' : '') + '</aside>';
      return App.openOverlay(ov, opts);
    },
    closeOverlay() {
      const o = $('#overlay');
      if (o) {
        const back = o._returnTo, done = o._onClose; o._onClose = null;
        o.remove();
        if (back && back.focus && document.contains(back)) back.focus({ preventScroll: true });
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
      let active = 0, filtered = items;
      const m = App.modal({ cls: 'palette-host', body: '' });
      m.className = 'palette';
      m.innerHTML = '<input type="text" placeholder="Search or run a command" aria-label="Search or run a command" id="palette-input"><div class="plist" id="palette-list"></div>';
      const list = m.querySelector('#palette-list'), input = m.querySelector('input');
      const draw = () => {
        let g = null; let html = '';
        filtered.forEach((it, i) => { if (it.group !== g) { g = it.group; html += '<div class="pgroup">' + g + '</div>'; } html += '<div class="pitem ' + (i === active ? 'active' : '') + '" data-i="' + i + '"><span>' + esc(it.label) + '</span><span class="ps">' + esc(it.sub || '') + '</span>' + (i === active ? '<span class="pk">↵</span>' : '') + '</div>'; });
        list.innerHTML = html || '<div class="pgroup">No matches</div>';
      };
      input.addEventListener('input', () => { const q = input.value.toLowerCase().trim(); filtered = items.filter((it) => !q || (it.label + ' ' + (it.sub || '')).toLowerCase().includes(q)); active = 0; draw(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { active = Math.min(filtered.length - 1, active + 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); } else if (e.key === 'Enter') { const it = filtered[active]; if (it) { App.closeOverlay(); it.run(); } } });
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
      const body = groups.map((g) => '<div class="vstack"><div class="eyebrow">' + g[0] + '</div><div class="map-grid">' + g[1].map((id) => { const s = screens[id]; return s && App.canOpen(id) ? '<button type="button" class="map-card" data-go="' + id + '"><span class="t">' + esc(s.title) + '</span><span class="s">' + esc(s.summary || '') + ((s.states || []).length ? ' · ' + s.states.length + ' states' : '') + '</span></button>' : ''; }).join('') + '</div></div>').join('');
      App.modal({ cls: 'wide', title: 'Screen map', body: '<p class="fg2" style="margin:0">Every screen you can open. Screens marked as prototype data still show the design boards\' example content; the <b>States</b> button shows the states each board lists.</p>' + body, onMount(m) { on(m, 'click', '[data-go]', (e, t) => { App.closeOverlay(); App.navigate(t.dataset.go); }); } });
    },

    // ----- shell rendering -----
    renderSidebar() {
      const cur = state.route;
      const side = $('#sidebar');
      side.innerHTML = '<button type="button" class="tenant" id="tenant-btn" aria-haspopup="true"><span><b>' + esc(DATA.tenant.workspace) + '</b><small>' + esc(DATA.tenant.name) + ' tenant</small></span><span class="sw">switch</span></button>'
        + NAV.map((g) => ({ group: g.group, items: g.items.filter((it) => App.can(it.perm)) })).filter((g) => g.items.length).map((g) => (g.group ? '<div class="navhead">' + g.group + '</div>' : '') + '<div class="navlist">' + g.items.map((it) => '<a href="' + App.hrefFor(it.id) + '" class="' + (cur === it.id ? 'active' : '') + '">' + icon(it.icon) + esc(it.label) + (it.count ? '<span class="count ' + (it.hot ? 'hot' : '') + '">' + it.count + '</span>' : '') + '</a>').join('') + '</div>').join('')
        + '<a href="' + App.hrefFor('settings') + '" class="me ' + (cur === 'settings' ? 'active' : '') + '"><span class="avatar">' + DATA.user.initials + '</span><span>' + esc(DATA.user.name) + '</span></a>';
      $('#tenant-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const existing = $('.popover', side); if (existing) { existing.remove(); return; }
        const pop = document.createElement('div'); pop.className = 'popover'; pop.style.cssText = 'position:fixed;left:8px;top:52px;right:auto;width:260px';
        pop.innerHTML = '<div class="ph">Switch workspace</div>' + DATA.workspaces.map((w) => '<button type="button" class="pi" data-ws="' + esc(w.id) + '"><span class="hstack"><span class="t grow">' + esc(w.name) + '</span>' + UI.label(w.label, { sm: true }) + '</span><span class="s">' + esc(w.tenant) + '</span></button>').join('') + (DATA.workspaces.length ? '' : '<div class="pi"><span class="s">No workspaces yet. A tenant admin creates them.</span></div>') + (App.can('tenant:manage') ? '<div class="divider"></div><button type="button" class="pi" data-go="tenants"><span class="t">Manage tenants and workspaces</span></button>' : '');
        side.appendChild(pop);
        on(pop, 'click', '[data-ws]', (ev, t) => { pop.remove(); if (t.dataset.ws !== DATA.tenant.workspaceId) App.switchWorkspace(t.dataset.ws); });
        on(pop, 'click', '[data-go]', (ev, t) => { pop.remove(); App.navigate(t.dataset.go); });
      });
    },
    renderHeader() {
      const s = screens[state.route]; if (!s) return;
      const crumb = typeof s.crumb === 'function' ? s.crumb(App.stateFor(s.id), state.params) : (s.crumb || [s.section === 'admin' ? 'Admin' : null, s.title]);
      const lbl = typeof s.label === 'function' ? s.label(App.stateFor(s.id), state.params) : s.label;
      $('#header').innerHTML = '<div class="hstack" style="min-width:0">' + UI.iconbtn('menu', 'Menu', { cls: 'menubtn', attrs: 'id="menu-btn"' }) + '<div class="crumbs">' + crumb.filter(Boolean).map((c, i, a) => (i < a.length - 1 ? '<span class="c1">' + esc(c) + '</span><span class="sep">/</span>' : '<span class="c2">' + esc(c) + '</span>')).join('') + (lbl ? UI.label(lbl) : '') + '</div></div>'
        + '<div class="htools relative">' + ((s.states || []).length ? UI.btn('States', { size: 'sm', icon: 'grid', attrs: 'id="states-btn" title="Design states listed on this board"' }) : '') + '<button type="button" class="cmdbtn" id="cmd-btn"><span>Search or run a command</span><kbd>Ctrl K</kbd></button>' + UI.iconbtn(App.isDark() ? 'sun' : 'moon', App.isDark() ? 'Switch to light theme' : 'Switch to dark theme', { attrs: 'id="theme-btn"' }) + UI.iconbtn('bell', 'Notifications', { attrs: 'id="bell-btn"', dot: DATA.notifications.length > 0 }) + '</div>';
      $('#cmd-btn').addEventListener('click', () => App.palette());
      $('#theme-btn').addEventListener('click', () => App.setTheme(App.isDark() ? 'light' : 'dark'));
      $('#menu-btn').addEventListener('click', () => { state.navOpen = !state.navOpen; $('#app').classList.toggle('nav-open', state.navOpen); });
      $('#bell-btn').addEventListener('click', (e) => {
        e.stopPropagation(); const host = $('#header .htools'); const ex = $('.popover', host); if (ex) { ex.remove(); return; }
        const pop = document.createElement('div'); pop.className = 'popover';
        pop.innerHTML = '<div class="ph">Notifications</div>' + (DATA.notifications.length ? '' : '<div class="pi"><span class="s">Nothing new.</span></div>') + DATA.notifications.map((n) => '<button type="button" class="pi" data-go="' + esc(n.route) + '" data-nid="' + esc(n.id) + '"><span class="t">' + esc(n.title) + '</span><span class="s">' + esc(n.sub) + '</span></button>').join('') + '<div class="divider"></div><div class="hstack"><span class="muted grow" style="font-size:12px">Delivered live to the console' + (DATA.notificationEmail ? ' and by email.' : '.') + '</span>' + UI.btn('Mark all read', { kind: 'ghost', size: 'sm', attrs: 'data-read' + (DATA.notifications.length ? '' : ' disabled') }) + '</div>';
        host.appendChild(pop);
        const markRead = (ids) => api('POST', '/api/me/notifications/read', ids ? { ids } : {}).catch((err) => App.fail(err, 'Could not mark read'));
        on(pop, 'click', '[data-go]', (ev, t) => { pop.remove(); DATA.notifications = DATA.notifications.filter((n) => n.id !== t.dataset.nid); markRead([t.dataset.nid]); App.renderHeader(); if (t.dataset.go && App.canOpen(t.dataset.go)) App.navigate(t.dataset.go); });
        on(pop, 'click', '[data-read]', () => { pop.remove(); DATA.notifications = []; markRead(); App.renderHeader(); });
      });
      const sb = $('#states-btn'); if (sb) sb.addEventListener('click', (e) => {
        e.stopPropagation(); const host = $('#header .htools'); const ex = $('.popover', host); if (ex) { ex.remove(); return; }
        const pop = document.createElement('div'); pop.className = 'popover';
        pop.innerHTML = '<div class="ph">States to design from this page</div>' + s.states.map((st, i) => '<button type="button" class="pi" data-state="' + i + '"><span class="t" style="color:var(--' + ({ danger: 'danger-fg', warn: 'warn-fg', ok: 'ok-fg', info: 'info-fg' }[st.tone] || 'fg') + ')">' + esc(st.title) + '</span><span class="s">' + esc(st.text) + '</span></button>').join('') + '<div class="divider"></div><button type="button" class="pi" data-reset><span class="t">Reset to the board\'s default state</span></button>';
        host.appendChild(pop);
        on(pop, 'click', '[data-state]', (ev, t) => { pop.remove(); App.applyState(+t.dataset.state); });
        on(pop, 'click', '[data-reset]', () => { pop.remove(); state.screenState[s.id] = {}; App.render(); App.toast('Reset'); });
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
      const r = App.parse(); const entering = r.route !== state.route || location.hash !== state.lastHash;
      state.route = r.route; state.params = r.params; state.lastHash = location.hash;
      // Live screens refetch whenever they are entered, so data is never older than the visit.
      if (entering && state.screenState[r.route]) state.screenState[r.route].loaded = false;
      if (App.fileMode) {
        if (!screens[state.route] && state.route !== 'not-found') { location.replace(App.hrefFor(state.route) + (location.hash.split('?')[1] ? '?' + location.hash.split('?')[1] : '')); return; }
      } else if (!state.signedIn && state.route !== 'signin') { if (state.booted) state.afterSignIn = state.route; state.route = 'signin'; }
      else if (state.signedIn && state.route === 'signin') { state.route = App.firstRoute(); }
      let s = screens[state.route] || screens['not-found'];
      if (state.signedIn && !App.canOpen(state.route)) s = screens.forbidden;
      const app = $('#app'); app.classList.toggle('signed-out', state.route === 'signin'); app.classList.remove('nav-open'); state.navOpen = false;
      App.closeOverlay();
      // A fresh element each render: listeners a screen attached through ctx.on (or directly on root) go with the old one,
      // so a re-render or a route change never leaves a previous render's handlers running.
      if (App._banner) { App._banner.remove(); App._banner = null; }
      const main = document.createElement('div'); main.id = 'main'; main.className = 'main'; $('#main').replaceWith(main);
      document.title = (s.title || 'Exprsn-AI') + ' · Exprsn-AI';
      if (state.route !== 'signin') { App.renderSidebar(); App.renderHeader(); }
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
    }
  };

  // not-found screen
  App.register({ id: 'not-found', title: 'Not found', crumb: ['Not found'], render(root, ctx) { root.innerHTML = '<div class="page">' + UI.problem('No such screen', 'The route in the address bar does not match a screen in the console.', false) + '<div>' + UI.btn('Open the screen map', { kind: 'primary', attrs: 'data-map' }) + '</div></div>'; ctx.on('click', '[data-map]', () => App.map()); } });
  App.register({ id: 'forbidden', title: 'Not permitted', crumb: ['Not permitted'], render(root, ctx) { const it = NAV_BY_ID[state.route]; root.innerHTML = '<div class="page">' + UI.problem('You do not have access to ' + (it ? it.label : 'this screen'), 'It needs the ' + (it ? it.perm : '') + ' permission, which none of your roles grant. An identity admin can map your directory group to a role that does.', false) + '<div>' + UI.btn('Back to your workspace', { kind: 'primary', attrs: 'data-home' }) + '</div></div>'; ctx.on('click', '[data-home]', () => App.navigate(App.firstRoute())); } });

  // global events
  window.addEventListener('hashchange', App.render);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('#palette-input')) App.closeOverlay(); else App.palette(); }
    else if (e.key === 'Escape') { App.closeOverlay(); }
    else if (e.key === '?' && !/input|textarea|select/i.test(document.activeElement.tagName)) { App.map(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.popover') && !e.target.closest('#tenant-btn') && !e.target.closest('#bell-btn') && !e.target.closest('#states-btn')) $$('.popover').forEach((p) => p.remove()); });
  // generic behaviours: toggles, tabs, segs, chips
  document.addEventListener('click', (e) => {
    const tg = e.target.closest('.toggle'); if (tg && !tg.dataset.manual) { tg.classList.toggle('on'); tg.setAttribute('aria-checked', tg.classList.contains('on') ? 'true' : 'false'); }
    const ch = e.target.closest('.chip[data-toggle]'); if (ch) ch.classList.toggle('on');
  });
  document.addEventListener('DOMContentLoaded', () => {
    if (state.theme) document.documentElement.setAttribute('data-theme', state.theme);
    App.boot();
  });
  window.App = App;
})();
