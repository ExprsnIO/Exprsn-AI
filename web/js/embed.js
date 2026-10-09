/*
 * 1.6.0, Sprint 39d (B-8701, B-8702): the embed pages. Served by the server at /embed/<id> (a public form) and
 * /embed/app/<tenant>/<app> (a signed embed) with frame-ancestors set to the app's allowed host sites. No session
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
  const visible = (f, values) => { const c = f.visibleIf; if (!c) return true; const v = values[c.field]; if (c.op === 'truthy') return !!v; if (c.op === 'falsy') return !v; if (c.op === 'eq') return v === c.value; if (c.op === 'in') return Array.isArray(c.value) && c.value.indexOf(v) >= 0; return true; };

  // ---------- a public form (B-8701) ----------
  async function publicForm() {
    root.innerHTML = notice('Loading ' + esc(d.title) + '…');
    let form;
    try { form = await call('POST', '/api/public/embeds/open', { embed: d.embed }); } catch (err) { root.innerHTML = notice('<b>This form is not available.</b> ' + esc(err.message), 'danger'); return; }
    document.title = form.title;
    const render = (values) => {
      root.innerHTML = '<h1 class="embed-title">' + esc(form.title) + '</h1><form class="embed-form" novalidate>' + form.fields.map((f) => '<div data-f="' + esc(f.name) + '"' + (visible(f, values || {}) ? '' : ' hidden') + '>' + field(f.label, control(f), f.help, f.name) + '</div>').join('') + '<div class="hstack gap6"><button type="submit" class="btn primary">' + esc(form.submitLabel) + '</button><span class="muted" data-status aria-live="polite"></span></div></form>';
      const el = root.querySelector('form');
      if (values) form.fields.forEach((f) => { const i = el.querySelector('[name="' + f.name + '"]'); if (i && values[f.name] != null) i.value = String(values[f.name]); });
      el.addEventListener('input', () => { const v = read(el, form.fields); form.fields.forEach((f) => { const box = el.querySelector('[data-f="' + f.name + '"]'); if (box) box.hidden = !visible(f, v); }); });
      el.addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = read(el, form.fields);
        const missing = form.fields.filter((f) => f.required && visible(f, values) && values[f.name] == null);
        const status = el.querySelector('[data-status]');
        if (missing.length) { status.textContent = 'Fill in ' + missing.map((f) => f.label).join(', ') + '.'; el.querySelector('[name="' + missing[0].name + '"]').focus(); return; }
        status.textContent = 'Sending…';
        el.querySelector('button[type=submit]').disabled = true;
        try {
          const out = await call('POST', '/api/public/embeds/submit', { embed: d.embed, values });
          root.innerHTML = notice('<b>' + esc(out.message) + '</b>' + (out.held ? ' <span class="muted">It will be reviewed before it is recorded.</span>' : ''), out.held ? 'warn' : 'ok') + '<div><button type="button" class="btn sm" data-again>Send another</button></div>';
          root.querySelector('[data-again]').addEventListener('click', () => render(null));
        } catch (err) {
          el.querySelector('button[type=submit]').disabled = false;
          status.textContent = '';
          const box = document.createElement('div'); box.innerHTML = notice('<b>Not sent.</b> ' + esc(err.message) + (err.status === 429 ? ' Try again in a minute.' : ''), 'danger'); el.prepend(box.firstChild);
        }
      });
    };
    render(null);
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

  if (d.kind === 'form') publicForm(); else signedApp();
})();
