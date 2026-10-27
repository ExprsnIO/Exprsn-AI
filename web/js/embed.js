/*
 * 1.6.0, Sprint 39d (B-8701, B-8702): the embed pages. Served by the server at /embed/<id> (a public form) and
 * /embed/app/<tenant>/<app> (a signed embed) with frame-ancestors set to the app's allowed host sites; since the
 * low-code port (follow-up 2) also the public link page /form#token=… (not framed), with sections and wizard steps
 * laid out by /js/form-layout.js. No session
 * cookie is read or made: a public page talks to /api/public/embeds by the embed id; a signed page reads the host's
 * token from the fragment (never a query string), exchanges it for an embedded session token it keeps in memory,
 * and calls the app's entity API with it as a bearer.
 */
(function () {
  'use strict';
  const root = document.getElementById('embed');
  if (!root) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const d = root.dataset;
  let bearer = null;

  async function call(method, path, body) {
    const res = await fetch(path, { method, headers: Object.assign({ accept: 'application/json' }, body !== undefined ? { 'content-type': 'application/json' } : {}, bearer ? { authorization: 'Bearer ' + bearer } : {}), body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'omit' });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) { const err = new Error((data && (data.detail || data.title)) || 'HTTP ' + res.status); err.status = res.status; err.problem = data; throw err; }
    return data;
  }
  const notice = (text, kind) => '<div class="notice ' + (kind || 'info') + '"><span class="grow">' + text + '</span></div>';
  const field = (label, control, hint, name) => '<div class="field"><label class="fl" for="f-' + esc(name) + '">' + esc(label) + '</label>' + control + (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') + '</div>';
  const control = (f) => {
    const a = 'name="' + esc(f.name) + '" id="f-' + esc(f.name) + '"' + (f.required ? ' required' : '');
    if (f.type === 'boolean') return '<select class="select" ' + a + '><option value="">empty</option><option value="true">yes</option><option value="false">no</option></select>';
    if (f.options) return '<select class="select" ' + a + '><option value="">choose</option>' + f.options.map((o) => '<option value="' + esc(typeof o === 'string' ? o : o.value) + '">' + esc(typeof o === 'string' ? o : o.label || o.value) + '</option>').join('') + '</select>';
    if (f.type === 'string' && f.multiline) return '<textarea class="textarea" rows="3" ' + a + (f.maxLength ? ' maxlength="' + f.maxLength + '"' : '') + '></textarea>';
    if (f.type === 'number') return '<input class="input" type="number" step="any" ' + a + (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + '>';
    if (f.type === 'date') return '<input class="input" type="' + (f.withTime ? 'datetime-local' : 'date') + '" ' + a + '>';
    return '<input class="input" type="text" ' + a + (f.maxLength ? ' maxlength="' + f.maxLength + '"' : '') + '>';
  };
  const read = (form, fields) => { const v = {}; fields.forEach((f) => { const el = form.querySelector('[name="' + f.name + '"]'); if (!el) return; let x = el.value; if (x === '') return; if (f.type === 'number') x = Number(x); if (f.type === 'boolean') x = x === 'true'; if (f.type === 'date' && f.withTime && x && !/Z|[+-]\d\d:\d\d$/.test(x)) x = x + ':00Z'; v[f.name] = x; }); return v; };
  const L = window.ExprsnFormLayout;

  // ---------- a public form: the embed page (B-8701) and the public link page /form (follow-up 2) ----------
  // Sections and wizard steps come from the form's layout; which fields, sections and steps show, and which are
  // required, is decided by form-layout.js, the mirror of the server's evaluator. The server decides again on submit.
  async function publicForm(io) {
    root.innerHTML = notice('Loading ' + esc(d.title || 'the form') + '…');
    let form;
    try { form = await io.open(); } catch (err) { root.innerHTML = notice('<b>This form is not available.</b> ' + esc(err.message), 'danger'); return; }
    document.title = form.title;
    const byName = {}; form.fields.forEach((f) => { byName[f.name] = f; });
    const st = { values: {}, cur: 0, errors: {}, status: '', banner: '' };
    const show = (v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
    const optLabel = (f, v) => { const o = (f.options || []).filter((x) => (typeof x === 'string' ? x : x.value) === v)[0]; return o ? (typeof o === 'string' ? o : o.label || o.value) : show(v); };
    const pages = (p) => { const list = p.layout.mode === 'wizard' ? p.steps.slice() : ['_page']; if (p.layout.review) list.push('_review'); return list; };
    const stepDef = (p, id) => (id === '_review' ? { id, title: 'Review your answers' } : p.layout.steps.filter((x) => x.id === id)[0] || { id, title: form.title, sections: p.layout.sections.map((s) => s.id) });
    const fieldHtml = (f, pf) => {
      const err = st.errors[f.name];
      const label = f.label + (pf.required ? ' (required)' : '');
      // Required-ness can depend on earlier answers, so it is announced with aria-required, not the static attribute.
      const ctrl = control(Object.assign({}, f, { required: false })).replace(' id="f-', (pf.required ? ' aria-required="true"' : '') + (err ? ' aria-invalid="true" aria-describedby="e-' + esc(f.name) + '"' : '') + ' id="f-');
      return '<div class="ef-field" data-f="' + esc(f.name) + '">' + field(label, ctrl, f.help, f.name) + (err ? '<span class="ef-err" id="e-' + esc(f.name) + '">' + esc(err) + '</span>' : '') + '</div>';
    };
    const sectionHtml = (sec, p, level) => {
      const shown = p.fields.filter((x) => x.section === sec.id && x.visible);
      if (!shown.length) return '';
      const inner = (sec.help ? '<p class="ef-help">' + esc(sec.help) + '</p>' : '') + shown.map((x) => fieldHtml(byName[x.field], x)).join('');
      if (!sec.title) return '<div class="ef-sec ef-plain">' + inner + '</div>';
      const h = '<h' + level + ' class="ef-sech" id="s-' + esc(sec.id) + '">' + esc(sec.title) + '</h' + level + '>';
      const open = !sec.collapsed || shown.some((x) => st.errors[x.field]);
      if (sec.collapsible) return '<details class="ef-sec" data-sec="' + esc(sec.id) + '"' + (open ? ' open' : '') + '><summary>' + h + '</summary>' + inner + '</details>';
      return '<section class="ef-sec" aria-labelledby="s-' + esc(sec.id) + '">' + h + inner + '</section>';
    };
    const reviewHtml = (p) => {
      const secs = {}; p.layout.sections.forEach((s) => { secs[s.id] = s; });
      const groups = (p.layout.mode === 'wizard' ? p.steps : ['_page']).map((sid, i) => {
        const sd = stepDef(p, sid);
        const rows = p.fields.filter((x) => x.step === (p.layout.mode === 'wizard' ? sid : '_page') && x.visible).map((x) => { const f = byName[x.field]; const v = p.values[x.field]; return '<dt>' + esc(f.label) + '</dt><dd>' + (v == null || v === '' ? '<span class="muted">not answered</span>' : esc(optLabel(f, v))) + '</dd>'; }).join('');
        return '<section class="ef-sec" aria-labelledby="r-' + i + '"><div class="hstack gap6 wrap"><h3 class="ef-sech grow" id="r-' + i + '">' + esc(sd.title) + '</h3>' + (p.layout.mode === 'wizard' ? '<button type="button" class="btn sm ghost" data-goto="' + i + '">Change ' + esc(sd.title) + '</button>' : '') + '</div><dl class="ef-review">' + (rows || '<dt class="muted">Nothing asked here.</dt><dd></dd>') + '</dl></section>';
      }).join('');
      return groups;
    };
    const render = (focusHeading) => {
      const p = L.plan(form, st.values);
      const list = pages(p);
      if (st.cur >= list.length) st.cur = list.length - 1;
      const wizard = list.length > 1;
      const id = list[st.cur];
      const sd = stepDef(p, id);
      const secs = {}; p.layout.sections.forEach((s) => { secs[s.id] = s; });
      let body;
      if (id === '_review') body = '<p class="ef-help">Check your answers before you send them.</p>' + reviewHtml(p);
      else body = (sd.help ? '<p class="ef-help">' + esc(sd.help) + '</p>' : '') + (sd.sections || []).map((sid) => secs[sid] ? sectionHtml(secs[sid], p, wizard ? 3 : 2) : '').join('');
      const nav = wizard ? '<nav aria-label="Form steps"><ol class="ef-steps">' + list.map((x, i) => { const t = stepDef(p, x).title; const n = (i + 1) + '. ' + esc(t); if (i === st.cur) return '<li><span class="ef-step cur" aria-current="step">' + n + '</span></li>'; if (i < st.cur) return '<li><button type="button" class="ef-step done" data-goto="' + i + '">' + n + '<span class="ef-sr"> (done)</span></button></li>'; return '<li><span class="ef-step">' + n + '</span></li>'; }).join('') + '</ol></nav><progress class="ef-progress" max="' + list.length + '" value="' + (st.cur + 1) + '" aria-label="Step ' + (st.cur + 1) + ' of ' + list.length + '"></progress>' : '';
      const last = st.cur === list.length - 1;
      const nextLabel = list[st.cur + 1] === '_review' ? 'Review' : 'Next';
      root.innerHTML = '<h1 class="embed-title">' + esc(form.title) + '</h1>' + nav + (st.banner ? notice(st.banner, 'danger') : '')
        + '<form class="embed-form" novalidate>' + (wizard ? '<h2 class="ef-steph" tabindex="-1" data-step-h>' + esc(sd.title) + ' <span class="muted ef-count">Step ' + (st.cur + 1) + ' of ' + list.length + '</span></h2>' : '') + body
        + '<div class="hstack gap6 wrap ef-actions">' + (wizard && st.cur > 0 ? '<button type="button" class="btn" data-back>Back</button>' : '') + (last ? '<button type="submit" class="btn primary">' + esc(form.submitLabel) + '</button>' : '<button type="submit" class="btn primary" data-next>' + esc(nextLabel) + '</button>') + '<span class="muted" data-status role="status">' + esc(st.status) + '</span></div></form>';
      const el = root.querySelector('form');
      Object.keys(st.values).forEach((k) => { const i = el.querySelector('[name="' + k + '"]'); if (i && st.values[k] != null) i.value = typeof st.values[k] === 'string' && byName[k].type === 'date' && byName[k].withTime ? st.values[k].replace(/:00Z$/, '') : String(st.values[k]); });
      const shownKey = p.visible.join(',');
      const sync = () => { const here = form.fields.filter((f) => el.querySelector('[name="' + f.name + '"]')); const v = read(el, here); here.forEach((f) => { if (v[f.name] === undefined) delete st.values[f.name]; else st.values[f.name] = v[f.name]; }); };
      el.addEventListener('input', sync);
      el.addEventListener('change', (e) => {
        sync();
        if (e.target && e.target.name && st.errors[e.target.name]) delete st.errors[e.target.name];
        if (L.plan(form, st.values).visible.join(',') === shownKey) return;
        const name = e.target && e.target.name; render(false);
        const back = name && root.querySelector('[name="' + name + '"]'); if (back) back.focus();
      });
      root.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { sync(); st.cur = +b.dataset.goto; st.status = ''; render(true); }));
      const bk = el.querySelector('[data-back]'); if (bk) bk.addEventListener('click', () => { sync(); st.cur -= 1; st.status = ''; st.banner = ''; render(true); });
      const focusFirstError = () => { const k = Object.keys(st.errors)[0]; const i = k && root.querySelector('[name="' + k + '"]'); if (i) i.focus(); };
      const mark = (missing) => { st.errors = {}; missing.forEach((m) => { st.errors[m.field] = 'Fill in ' + byName[m.field].label + '.'; }); };
      el.addEventListener('submit', async (e) => {
        e.preventDefault(); sync();
        const pl = L.plan(form, st.values);
        const pagesNow = pages(pl);
        const here = pagesNow[st.cur];
        if (!last) {
          // Per-step validation: the required fields of this step only.
          const miss = pl.missing.filter((m) => (here === '_page' ? true : m.step === here));
          if (miss.length) { mark(miss); st.status = 'Fill in ' + miss.map((m) => byName[m.field].label).join(', ') + '.'; render(false); focusFirstError(); return; }
          st.errors = {}; st.status = ''; st.banner = ''; st.cur += 1; render(true); return;
        }
        if (pl.missing.length) {
          mark(pl.missing);
          const at = pagesNow.indexOf(pl.layout.mode === 'wizard' ? pl.missing[0].step : '_page');
          st.cur = at < 0 ? 0 : at; st.status = 'Fill in ' + pl.missing.map((m) => byName[m.field].label).join(', ') + '.'; render(false); focusFirstError(); return;
        }
        const status = el.querySelector('[data-status]'); status.textContent = 'Sending…';
        el.querySelector('button[type=submit]').disabled = true;
        try {
          const out = await io.submit(pl.values);
          root.innerHTML = notice('<b>' + esc(out.message) + '</b>' + (out.held ? ' <span class="muted">It will be reviewed before it is recorded.</span>' : ''), out.held ? 'warn' : 'ok') + '<div><button type="button" class="btn sm" data-again>Send another</button></div>';
          root.querySelector('[data-again]').addEventListener('click', () => { st.values = {}; st.cur = 0; st.errors = {}; st.status = ''; st.banner = ''; render(true); });
          const again = root.querySelector('[data-again]'); if (again) again.focus();
        } catch (err) {
          const probs = (err.problem && Array.isArray(err.problem.problems)) ? err.problem.problems.filter((x) => x && x.field && byName[x.field]) : [];
          st.banner = '<b>Not sent.</b> ' + esc(err.message) + (err.status === 429 ? ' Try again in a minute.' : '');
          st.status = '';
          if (probs.length) { mark(probs); const at = pagesNow.indexOf(probs[0].step || (pl.layout.mode === 'wizard' ? (pl.fields.filter((x) => x.field === probs[0].field)[0] || {}).step : '_page')); if (at >= 0) st.cur = at; }
          render(!probs.length); if (probs.length) focusFirstError();
        }
      });
      if (focusHeading) { const h = root.querySelector('[data-step-h]') || root.querySelector('h1'); if (h) { if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1'); h.focus(); } }
    };
    render(false);
  }

  // ---------- a signed embed (B-8702) ----------
  async function signedApp() {
    const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
    const token = m ? decodeURIComponent(m[1]) : null;
    if (token) history.replaceState(null, '', location.pathname + location.search);
    if (!token) { root.innerHTML = notice('<b>No token.</b> The host site opens this page with its signed token in the fragment (#token=…).', 'danger'); return; }
    root.innerHTML = notice('Signing in to ' + esc(d.title) + '…');
    let session;
    try { session = await call('POST', '/api/public/embeds/session', { tenant: d.tenant, app: d.app, token }); } catch (err) { root.innerHTML = notice('<b>Not signed in.</b> ' + esc(err.message) + ' Ask the host site for a new token.', 'danger'); return; }
    bearer = session.token;
    const expiresIn = Math.max(0, session.expiresAt - Date.now());
    setTimeout(() => { bearer = null; root.innerHTML = notice('<b>This session has ended.</b> Reload the page from the host site for a new one.', 'warn'); }, expiresIn);
    const entities = session.entities;
    const st = { entity: entities[0] ? entities[0].name : null, page: null, cursor: null, q: '' };
    const head = () => '<div class="hstack gap6 wrap embed-head"><h1 class="embed-title grow">' + esc(session.app.title) + '</h1><span class="muted">' + esc(session.user.displayName || session.user.username) + (session.write ? '' : ', read-only') + '</span></div>'
      + (entities.length > 1 ? '<div class="tabs" role="tablist">' + entities.map((e) => '<button type="button" role="tab" class="tab' + (e.name === st.entity ? ' active' : '') + '" aria-selected="' + (e.name === st.entity) + '" data-entity="' + esc(e.name) + '">' + esc(e.title) + '</button>').join('') + '</div>' : '');
    const load = async () => {
      const e = entities.find((x) => x.name === st.entity);
      if (!e) { root.innerHTML = head() + notice('This app has no entity you may reach.', 'warn'); return; }
      root.innerHTML = head() + notice('Loading ' + esc(e.title) + '…');
      try {
        const q = new URLSearchParams(); q.set('limit', '25'); q.set('sort', 'updatedAt:desc'); if (st.q) q.set('q', st.q); if (st.cursor) q.set('cursor', st.cursor);
        st.page = await call('GET', '/api/apps/' + encodeURIComponent(d.app) + '/' + encodeURIComponent(e.name) + '?' + q.toString());
      } catch (err) { root.innerHTML = head() + notice('<b>Could not load ' + esc(e.title) + '.</b> ' + esc(err.message), 'danger'); wire(); return; }
      const shown = e.fields.filter((f) => !f.computed).slice(0, 6);
      const cell = (v) => (v == null ? '<span class="muted">empty</span>' : typeof v === 'object' ? esc(JSON.stringify(v)) : esc(v));
      root.innerHTML = head()
        + '<div class="hstack gap6 wrap"><input class="input" type="search" placeholder="Search" value="' + esc(st.q) + '" data-q aria-label="Search">' + (session.write ? '<button type="button" class="btn primary sm" data-new>New ' + esc(e.title) + '</button>' : '') + '<span class="muted">' + (st.page.total == null ? '' : st.page.total + ' record' + (st.page.total === 1 ? '' : 's')) + '</span></div>'
        + '<div class="tablewrap"><table class="table"><thead><tr>' + shown.map((f) => '<th>' + esc(f.title) + '</th>').join('') + (e.states ? '<th>State</th>' : '') + '<th>Updated</th></tr></thead><tbody>'
        + (st.page.records.length ? st.page.records.map((r) => '<tr>' + shown.map((f) => '<td>' + (r.hidden && r.hidden.indexOf(f.name) >= 0 ? '<span class="muted">hidden</span>' : cell(r.values[f.name])) + '</td>').join('') + (e.states ? '<td>' + esc(r.state || '') + '</td>' : '') + '<td class="muted">' + esc(new Date(r.updatedAt).toLocaleString()) + '</td></tr>').join('') : '<tr><td colspan="' + (shown.length + 2) + '" class="muted">No records.</td></tr>')
        + '</tbody></table></div>'
        + '<div class="hstack gap6">' + (st.page.nextCursor ? '<button type="button" class="btn sm" data-more>Next page</button>' : '') + (st.cursor ? '<button type="button" class="btn sm ghost" data-first>First page</button>' : '') + '</div>'
        + (session.write ? '<form class="embed-form" data-newform hidden><h2 class="embed-sub">New ' + esc(e.title) + '</h2>' + e.fields.filter((f) => !f.computed).map((f) => field(f.title, control(f), null, f.name)).join('') + '<div class="hstack gap6"><button type="submit" class="btn primary">Create</button><button type="button" class="btn ghost" data-cancel>Cancel</button><span class="muted" data-status aria-live="polite"></span></div></form>' : '');
      wire(e);
    };
    const wire = (e) => {
      root.querySelectorAll('[data-entity]').forEach((b) => b.addEventListener('click', () => { st.entity = b.dataset.entity; st.cursor = null; st.q = ''; load(); }));
      const q = root.querySelector('[data-q]'); if (q) q.addEventListener('change', () => { st.q = q.value.trim(); st.cursor = null; load(); });
      const more = root.querySelector('[data-more]'); if (more) more.addEventListener('click', () => { st.cursor = st.page.nextCursor; load(); });
      const first = root.querySelector('[data-first]'); if (first) first.addEventListener('click', () => { st.cursor = null; load(); });
      const nb = root.querySelector('[data-new]'); const nf = root.querySelector('[data-newform]');
      if (nb && nf && e) {
        nb.addEventListener('click', () => { nf.hidden = false; nf.querySelector('input,select,textarea').focus(); });
        nf.querySelector('[data-cancel]').addEventListener('click', () => { nf.hidden = true; });
        nf.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const status = nf.querySelector('[data-status]'); status.textContent = 'Saving…';
          try { await call('POST', '/api/apps/' + encodeURIComponent(d.app) + '/' + encodeURIComponent(e.name), { values: read(nf, e.fields.filter((f) => !f.computed)) }); st.cursor = null; load(); }
          catch (err) { status.textContent = 'Not saved: ' + err.message; }
        });
      }
    };
    load();
  }

  if (d.kind === 'form') publicForm({ open: () => call('POST', '/api/public/embeds/open', { embed: d.embed }), submit: (values) => call('POST', '/api/public/embeds/submit', { embed: d.embed, values }) });
  else if (d.kind === 'link') {
    // The public link page: the token travels in the fragment (never sent to the server in a URL) and in the body.
    const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
    const token = m ? decodeURIComponent(m[1]) : null;
    if (!token) root.innerHTML = notice('<b>No form link.</b> Open the full link you were given; it ends with #token=…', 'danger');
    else publicForm({ open: () => call('POST', '/api/public/forms/open', { token }), submit: (values) => call('POST', '/api/public/forms/submit', { token, values }) });
  } else signedApp();
})();
