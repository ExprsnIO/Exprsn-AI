// Apps, saved views of the Records tab (the exprsn-platform low-code port, docs/decisions/lowcode-port.md, follow-up
// 1): a named configuration of one entity's records (table or board and the board's grouping, filters, search, sort,
// the visible columns in their order, rows per page), private or shared with the app's readers. A view stores only
// these settings; the records still come from the records routes with the reader's own policies and clearance.
// `apps.js` calls App.appsViewsPrepare(ctx, app, ent, deps) before it builds the records query (it applies a chosen
// or default view) and App.appsViews(ctx, app, ent, deps) for the picker's markup. State lives in ctx.state.vw.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const SIZES = [10, 25, 50, 100, 200];
  const DEFAULT_SORT = [{ field: 'updatedAt', dir: 'desc' }];
  const CSS = '#main .apps-views{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);min-width:0}'
    + '#main .apps-views select{width:auto;max-width:100%;min-width:0}#main .apps-views .apps-vstate{font-size:12px}'
    + '#main .apps-vorder{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}#main .apps-vorder li{display:flex;align-items:center;gap:6px;min-width:0}#main .apps-vorder li span{flex:1;min-width:0;overflow-wrap:anywhere}';

  const url = (app, ent) => '/api/apps/' + enc(app.id) + '/entities/' + enc(ent.id) + '/views';
  const vwOf = (st) => st.vw || (st.vw = { lists: {}, sel: {}, busy: {}, ent: null, errors: {} });

  /** The settings in one spelling, so that a view and the screen compare equal when they show the same records. */
  function norm(s) {
    s = s || {};
    const cols = s.columns && Array.isArray(s.columns.fields) ? { fields: s.columns.fields.slice(), meta: (s.columns.meta || []).slice().sort() } : null;
    return {
      layout: s.layout === 'board' ? 'board' : 'table',
      groupBy: s.layout === 'board' ? s.groupBy || null : null,
      // 1.8.0 (B-128): a relation's matches filter keeps its where
      filters: (s.filters || []).map((f) => (f.where ? { field: f.field, op: f.op, where: f.where } : { field: f.field, op: f.op, value: f.value === undefined ? null : f.value })),
      filterMode: (s.filters || []).length > 1 && s.filterMode === 'or' ? 'or' : 'and',
      state: s.state || null,
      q: s.q || '',
      sort: ((s.sort || []).filter((x) => x.field).length ? s.sort.filter((x) => x.field) : DEFAULT_SORT).map((x) => ({ field: x.field, dir: x.dir === 'desc' ? 'desc' : 'asc' })),
      columns: cols,
      pageSize: SIZES.indexOf(s.pageSize) >= 0 ? s.pageSize : 25
    };
  }
  /** What the Records tab shows now, as view settings. */
  function snapshot(st, ent) {
    const c = st.cols && st.cols[ent.id];
    return norm({
      layout: st.recView === 'board' ? 'board' : 'table',
      groupBy: (st.boardBy && st.boardBy[ent.id]) || null,
      filters: (st.filters || []).map((f) => (f.where ? { field: f.field, op: f.op, where: f.where } : { field: f.field, op: f.op, value: f.value })),
      filterMode: st.filterMode,
      state: st.stateFilter && st.stateFilter !== 'all' ? st.stateFilter : null,
      q: st.query || '',
      sort: st.sorts || [],
      columns: c && Array.isArray(c.fields) ? { fields: c.fields, meta: (c.meta || []).filter((m) => m !== 'state' || (ent.definition && ent.definition.states)) } : null,
      pageSize: st.pageSize || 25
    });
  }
  /** Shows a view's settings on the Records tab (or the tab's own defaults for null). */
  function apply(st, ent, settings, deps) {
    const s = norm(settings || { sort: DEFAULT_SORT });
    st.recView = s.layout;
    st.boardBy = st.boardBy || {};
    if (s.groupBy) st.boardBy[ent.id] = s.groupBy;
    st.filters = s.filters.map((f) => (f.where ? { field: f.field, op: f.op, where: f.where } : { field: f.field, op: f.op, value: f.value }));
    st.filterMode = s.filterMode;
    st.stateFilter = s.state || 'all';
    st.query = s.q;
    st.sorts = s.sort.length ? s.sort : DEFAULT_SORT.slice();
    st.cols = st.cols || {};
    if (s.columns) st.cols[ent.id] = { fields: s.columns.fields, meta: s.columns.meta.concat(ent.definition && ent.definition.states ? [] : ['state']) };
    else delete st.cols[ent.id]; // back to the browser's own choice of columns, or the entity's defaults
    st.pageSize = s.pageSize;
    st.board = {}; st.selected = {};
    if (deps.resetPaging) deps.resetPaging(); else { st.page = 0; st.cursors = [null]; }
    deps.invalidate();
  }
  /** Whether the screen still shows a view: a view without columns or a grouping takes whatever the screen has. */
  function sameSettings(view, now) {
    const a = norm(view); const b = norm(now);
    if (!a.columns) a.columns = b.columns;
    if (a.layout === 'board' && !a.groupBy) a.groupBy = b.groupBy;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function load(ctx, app, ent, deps) {
    const st = ctx.state; const vw = vwOf(st);
    if (vw.busy[ent.id]) return;
    vw.busy[ent.id] = true;
    App.get(url(app, ent))
      .then((d) => {
        vw.lists[ent.id] = d; vw.errors[ent.id] = null;
        // The person's default view is applied the first time the entity is opened in this visit.
        if (vw.sel[ent.id] === undefined) {
          const def = d.defaultView && d.views.find((v) => v.id === d.defaultView);
          vw.sel[ent.id] = def ? def.id : null;
          if (def && st.entity === ent.id) apply(st, ent, def.settings, deps);
        }
      })
      .catch((err) => { vw.errors[ent.id] = err; if (vw.sel[ent.id] === undefined) vw.sel[ent.id] = null; })
      .finally(() => { vw.busy[ent.id] = false; deps.refresh(); });
  }

  App.appsViewsPrepare = function (ctx, app, ent, deps) {
    const st = ctx.state; const vw = vwOf(st);
    const list = vw.lists[ent.id];
    if (!list && !vw.errors[ent.id]) load(ctx, app, ent, deps);
    if (vw.ent !== ent.id) {
      // Coming back to an entity (its filters were reset on the way out) shows its chosen view again.
      vw.ent = ent.id;
      const v = list && vw.sel[ent.id] ? list.views.find((x) => x.id === vw.sel[ent.id]) : null;
      if (v) apply(st, ent, v.settings, deps);
    }
  };

  App.appsViews = function (ctx, app, ent, deps) {
    const st = ctx.state; const vw = vwOf(st);
    const list = vw.lists[ent.id];
    if (vw.errors[ent.id]) {
      ctx.on('click', '[data-vreload]', () => { vw.errors[ent.id] = null; ctx.rerender(); });
      return '<style>' + CSS + '</style><div class="apps-views">' + '<span class="muted" style="font-size:12px">Saved views could not be loaded: ' + esc(deps.detailOf(vw.errors[ent.id])) + '</span>' + UI.btn('Try again', { size: 'xs', attrs: 'data-vreload' }) + '</div>';
    }
    if (!list) return '<style>' + CSS + '</style><div class="apps-views"><span class="muted" style="font-size:12px">Loading saved views…</span></div>';
    const views = list.views;
    const sel = vw.sel[ent.id] ? views.find((v) => v.id === vw.sel[ent.id]) || null : null;
    if (vw.sel[ent.id] && !sel) vw.sel[ent.id] = null;
    const now = snapshot(st, ent);
    const dirty = sel ? !sameSettings(sel.settings, now) : false;
    const mine = views.filter((v) => v.mine && !v.shared);
    const shared = views.filter((v) => v.shared);
    const opt = (v) => '<option value="' + esc(v.id) + '"' + (sel && sel.id === v.id ? ' selected' : '') + '>' + esc(v.name) + (v.isDefault ? ' (default)' : '') + '</option>';
    const select = '<label for="apps-viewsel" style="font-size:12px;font-weight:600">Saved view</label><select class="select" id="apps-viewsel" data-viewsel aria-describedby="apps-vstate">'
      + '<option value=""' + (sel ? '' : ' selected') + '>No view (this tab\'s defaults)</option>'
      + (mine.length ? '<optgroup label="My views">' + mine.map(opt).join('') + '</optgroup>' : '')
      + (shared.length ? '<optgroup label="Shared with the app\'s readers">' + shared.map(opt).join('') + '</optgroup>' : '')
      + '</select>';
    const stateText = sel ? (dirty ? 'Unsaved changes to ' + sel.name : (sel.shared ? 'Shared view' : 'Private view') + (sel.isDefault ? ', your default' : '')) : (views.length ? views.length + ' saved view' + (views.length === 1 ? '' : 's') : 'No saved views yet');
    const stateHtml = '<span id="apps-vstate" class="apps-vstate" role="status">' + (sel && dirty ? UI.pill('Unsaved changes', 'warn') : '<span class="muted">' + esc(stateText) + '</span>') + '</span>';
    const can = sel && sel.canEdit;
    const buttons = (can && dirty ? UI.btn('Save', { size: 'xs', kind: 'primary', attrs: 'data-vsave', title: 'Save the current layout and query into ' + sel.name }) : '')
      + (sel && dirty ? UI.btn('Discard changes', { size: 'xs', kind: 'ghost', attrs: 'data-vdiscard' }) : '')
      + UI.btn('Save as…', { size: 'xs', attrs: 'data-vsaveas' })
      + (can ? UI.btn('Rename', { size: 'xs', attrs: 'data-vrename' }) : '')
      + (can && list.canShare ? '<button type="button" class="btn xs' + (sel.shared ? ' active' : '') + '" data-vshare aria-pressed="' + (sel.shared ? 'true' : 'false') + '">Shared with readers</button>' : '')
      + (sel ? UI.btn(sel.isDefault ? 'Clear default' : 'Set as default', { size: 'xs', attrs: 'data-vdefault' }) : '')
      + (st.recView !== 'board' ? UI.btn('Column order', { size: 'xs', attrs: 'data-vorder' }) : '')
      + (can ? UI.btn('Delete', { size: 'xs', kind: 'ghost', attrs: 'data-vdelete', title: 'Delete the view ' + sel.name }) : '')
      // 1.8.0 (B-124): deliver the chosen view (or, without one, the entity's records) on a schedule (apps-subscriptions.js)
      + (App.appsSubscribeButton ? App.appsSubscribeButton(sel ? { app: app.id, appTitle: app.title, kind: 'view', id: sel.id, title: sel.name } : { app: app.id, appTitle: app.title, kind: 'records', id: ent.id, title: ent.title || ent.name }) : '');
    const html = '<style>' + CSS + '</style><div class="apps-views" role="group" aria-label="Saved views of ' + esc(ent.title || ent.name) + '">' + select + stateHtml + '<span class="grow"></span>' + buttons + '</div>';

    // ----- events -----
    const reload = (focusSel) => { vw.lists[ent.id] = null; load(ctx, app, ent, deps); ctx.rerender(); if (focusSel) { const el = ctx.$(focusSel); if (el) el.focus(); } };
    const after = (fn) => { const d = vw.lists[ent.id]; if (d) fn(d); };
    const focus = (selector) => { const el = ctx.$(selector) || ctx.$('[data-viewsel]'); if (el) el.focus(); };
    ctx.on('change', '[data-viewsel]', (e, t) => {
      const v = views.find((x) => x.id === t.value) || null;
      vw.sel[ent.id] = v ? v.id : null;
      apply(st, ent, v ? v.settings : null, deps);
      ctx.rerender(); focus('[data-viewsel]');
    });
    ctx.on('click', '[data-vdiscard]', () => { if (!sel) return; apply(st, ent, sel.settings, deps); ctx.rerender(); focus('[data-vsaveas]'); });
    ctx.on('click', '[data-vsave]', async () => {
      if (!sel) return;
      try { await App.patch(url(app, ent) + '/' + enc(sel.id), { settings: now }); ctx.toast('Saved ' + esc(sel.name) + '. Audited app.view.updated.', 'ok'); reload('[data-vsaveas]'); }
      catch (err) { App.fail(err, 'The view was not saved'); }
    });
    ctx.on('click', '[data-vsaveas]', () => {
      deps.modal({ title: 'Save as a view of ' + esc(ent.title || ent.name),
        body: '<p class="fg2" style="margin:0;font-size:12px">Keeps the layout' + (now.layout === 'board' ? ' and grouping' : '') + ', filters, search, sort, columns and rows per page. Opening a view shows each reader only the records they may read.</p>'
          + UI.field('Name', UI.input(sel && dirty ? sel.name + ' (copy)' : '', { attrs: 'data-vs-name maxlength="100" autocomplete="off"' }))
          + (list.canShare ? UI.check('Share with everyone who reads this app\'s records', false, 'data-vs-shared') : '<span class="muted" style="font-size:12px">The view is private to you. Sharing a view needs the app design right.</span>')
          + UI.check('Make it my default for ' + (ent.title || ent.name), false, 'data-vs-default') + '<div data-vs-err></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save view', { kind: 'primary', attrs: 'data-vs-ok' }),
        onMount(m) {
          const input = m.querySelector('[data-vs-name]'); if (input) input.focus();
          const ok = async () => {
            const name = input.value.trim(); const err = m.querySelector('[data-vs-err]');
            if (!name) { err.innerHTML = UI.notice('A view needs a name.', 'warn'); input.focus(); return; }
            const sh = m.querySelector('[data-vs-shared]'); const df = m.querySelector('[data-vs-default]');
            try {
              const v = await App.post(url(app, ent), { name, shared: !!(sh && sh.checked), settings: now });
              if (df && df.checked) await App.put(url(app, ent) + '/default', { view: v.id });
              vw.sel[ent.id] = v.id; App.closeOverlay();
              ctx.toast('Saved the view ' + esc(v.name) + (v.shared ? ', shared with the app\'s readers' : '') + '. Audited app.view.created.', 'ok');
              reload('[data-viewsel]');
            } catch (e2) { err.innerHTML = UI.notice(esc(deps.detailOf(e2)), 'danger'); }
          };
          m.querySelector('[data-vs-ok]').addEventListener('click', ok);
          input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ok(); } });
        } });
    });
    ctx.on('click', '[data-vrename]', () => {
      if (!sel) return;
      deps.modal({ title: 'Rename ' + esc(sel.name),
        body: UI.field('Name', UI.input(sel.name, { attrs: 'data-vr-name maxlength="100" autocomplete="off"' })) + '<div data-vr-err></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Rename', { kind: 'primary', attrs: 'data-vr-ok' }),
        onMount(m) {
          const input = m.querySelector('[data-vr-name]'); input.focus(); input.select();
          const ok = async () => {
            const name = input.value.trim(); const err = m.querySelector('[data-vr-err]');
            if (!name) { err.innerHTML = UI.notice('A view needs a name.', 'warn'); return; }
            try { await App.patch(url(app, ent) + '/' + enc(sel.id), { name }); App.closeOverlay(); ctx.toast('Renamed to ' + esc(name) + '. Audited app.view.updated.', 'ok'); reload('[data-vrename]'); }
            catch (e2) { err.innerHTML = UI.notice(esc(deps.detailOf(e2)), 'danger'); }
          };
          m.querySelector('[data-vr-ok]').addEventListener('click', ok);
          input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ok(); } });
        } });
    });
    ctx.on('click', '[data-vshare]', async () => {
      if (!sel) return;
      const to = !sel.shared;
      const ok = await ctx.confirm({ title: (to ? 'Share ' : 'Stop sharing ') + sel.name, tone: to ? 'info' : 'warn', body: '<p class="fg2" style="margin:0">' + (to ? 'Everyone who reads this app\'s records will see the view. It stores only settings: each of them sees only the records their own policies and clearance allow.' : 'Only the view\'s owner will see it again; readers who chose it as their default go back to the tab\'s defaults.') + '</p>', kv: [['View', esc(sel.name)], ['Label', UI.label(sel.label, { sm: true })]], ok: to ? 'Share' : 'Stop sharing' });
      if (!ok) return;
      try { await App.patch(url(app, ent) + '/' + enc(sel.id), { shared: to }); ctx.toast(esc(sel.name) + (to ? ' is shared with the app\'s readers.' : ' is private again.') + ' Audited app.view.updated.', 'ok'); reload('[data-vshare]'); }
      catch (err) { App.fail(err, 'The view was not changed'); }
    });
    ctx.on('click', '[data-vdefault]', async () => {
      if (!sel) return;
      const clear = sel.isDefault;
      try { await App.put(url(app, ent) + '/default', { view: clear ? null : sel.id }); ctx.toast(clear ? 'No default view for ' + esc(ent.title || ent.name) + ' now.' : esc(sel.name) + ' opens first on ' + esc(ent.title || ent.name) + '. Audited app.view.default.', 'ok'); after((d) => { d.defaultView = clear ? null : sel.id; d.views.forEach((v) => { v.isDefault = !clear && v.id === sel.id; }); }); ctx.rerender(); focus('[data-vdefault]'); }
      catch (err) { App.fail(err, 'The default was not changed'); }
    });
    ctx.on('click', '[data-vdelete]', async () => {
      if (!sel) return;
      const ok = await ctx.confirm({ title: 'Delete the view ' + sel.name, tone: 'danger', body: '<p class="fg2" style="margin:0">The view goes for everyone' + (sel.shared ? ' it is shared with' : '') + '; the records are not touched. The screen keeps its current layout and query.</p>', kv: [['View', esc(sel.name)], ['Shared', sel.shared ? 'yes' : 'no']], ok: 'Delete view' });
      if (!ok) return;
      try { await App.del(url(app, ent) + '/' + enc(sel.id)); vw.sel[ent.id] = null; ctx.toast('Deleted the view ' + esc(sel.name) + '. Audited app.view.deleted.', 'warn'); reload('[data-viewsel]'); }
      catch (err) { App.fail(err, 'The view was not deleted'); }
    });
    ctx.on('click', '[data-vorder]', () => {
      let order = (deps.shown || []).slice();
      const fieldsOf = ent.definition.fields || [];
      const title = (n) => { const f = fieldsOf.find((x) => x.name === n); return f ? f.title || f.name : n; };
      const listHtml = () => order.map((n, i) => '<li><span>' + esc(title(n)) + '</span>' + UI.btn('Up', { size: 'xs', attrs: 'data-vo-up="' + i + '" aria-label="Move ' + esc(title(n)) + ' up"', disabled: i === 0 }) + UI.btn('Down', { size: 'xs', attrs: 'data-vo-down="' + i + '" aria-label="Move ' + esc(title(n)) + ' down"', disabled: i === order.length - 1 }) + '</li>').join('');
      deps.modal({ title: 'Column order of ' + esc(ent.title || ent.name),
        body: '<p class="fg2" style="margin:0;font-size:12px">The order of the visible field columns. Choose which columns show with Columns; save the order into a view with Save or Save as.</p>' + (order.length ? '<ol class="apps-vorder" data-vo-list aria-label="Visible columns in order">' + listHtml() + '</ol>' : UI.notice('No field column is visible.', 'info')),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Apply', { kind: 'primary', attrs: 'data-vo-ok' }),
        onMount(m) {
          const ol = m.querySelector('[data-vo-list]');
          if (ol) ol.addEventListener('click', (ev) => {
            const b = ev.target.closest('button'); if (!b || b.disabled) return;
            const up = b.hasAttribute('data-vo-up'); const i = +(up ? b.dataset.voUp : b.dataset.voDown); const j = up ? i - 1 : i + 1;
            const x = order[i]; order[i] = order[j]; order[j] = x;
            ol.innerHTML = listHtml();
            const again = ol.querySelector(up ? '[data-vo-up="' + j + '"]' : '[data-vo-down="' + j + '"]') || ol.querySelector('[data-vo-' + (up ? 'down' : 'up') + '="' + j + '"]');
            if (again) again.focus();
          });
          m.querySelector('[data-vo-ok]').addEventListener('click', () => {
            st.cols = st.cols || {};
            st.cols[ent.id] = { fields: order, meta: (deps.meta || []).concat(ent.definition.states ? [] : ['state']) };
            App.closeOverlay(); ctx.rerender(); focus('[data-vorder]');
          });
        } });
    });
    return html;
  };
})();
