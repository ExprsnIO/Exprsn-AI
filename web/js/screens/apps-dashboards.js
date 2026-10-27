// Apps, the Dashboards tab (1.8.0, Sprint 44, B-121): an app's dashboards, each a grid of cards (charts and number
// tiles from apps-charts.js, a saved view's table, Markdown text the server renders escaped), its filters (a date range
// or a field value, applied by the server to every card that has the field) and its refresh interval. Every card is
// computed by the server as the person looking at it; a card they cannot read says "Not available to you".
// Layout: "Edit layout" stages changes until Save layout. Cards move by dragging or with their Move earlier and Move
// later buttons (the non-drag alternative), and resize with a preset size. A dashboard is private, or shared with the
// app's readers by someone with apps:design. Downloads are static HTML or PDF snapshots computed as the viewer.
// The tab also lists the app's charts, with the chart builder (App.appsChartBuilder) to make and change them.
// `apps.js` calls App.appsDashboards(ctx, app, deps) for the tab; state lives in ctx.state.db.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const SIZES = [{ value: 'small', label: 'Small (a quarter)' }, { value: 'medium', label: 'Medium (a third)' }, { value: 'large', label: 'Large (a half)' }, { value: 'wide', label: 'Wide (two thirds)' }, { value: 'full', label: 'Full width' }];
  const REFRESH = [{ value: '0', label: 'Off' }, { value: '30', label: 'Every 30 seconds' }, { value: '60', label: 'Every minute' }, { value: '300', label: 'Every 5 minutes' }, { value: '900', label: 'Every 15 minutes' }, { value: '3600', label: 'Every hour' }];
  const TYPE_NAMES = { bar: 'Bar', line: 'Line', area: 'Area', pie: 'Pie', donut: 'Donut', scatter: 'Scatter', number: 'Number tile', table: 'Table' };
  const CSS = '#main .adb{display:flex;flex-direction:column;gap:12px;min-width:0}#main .adb-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}#main .adb-bar select{width:auto;max-width:100%;min-width:0}'
    + '#main .adb-filters{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:flex-end;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);margin:0;min-width:0}#main .adb-filters legend{font-weight:600;padding:0 4px}#main .adb-filters .field{margin:0;min-width:0}'
    + '#main .adb-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px;min-width:0}#main .adb-card{min-width:0;display:flex;flex-direction:column;gap:8px;margin:0;overflow-wrap:anywhere}'
    + '#main .adb-small{grid-column:span 3}#main .adb-medium{grid-column:span 4}#main .adb-large{grid-column:span 6}#main .adb-wide{grid-column:span 8}#main .adb-full{grid-column:span 12}'
    + '@media (max-width:1100px){#main .adb-small,#main .adb-medium{grid-column:span 6}#main .adb-large,#main .adb-wide{grid-column:span 12}}@media (max-width:640px){#main .adb-grid > .adb-card{grid-column:1/-1}}'
    + '#main .adb-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}#main .adb-head h2{font-size:15px;margin:0;flex:1 1 auto;min-width:0}#main .adb-edit{display:flex;flex-wrap:wrap;gap:4px;align-items:center}#main .adb-edit select{width:auto;max-width:100%}'
    + '#main .adb-card.drag{opacity:.6}#main .adb-card.drop{box-shadow:0 0 0 2px var(--accent)}#main .adb-na{margin:0;color:var(--fg2);font-style:italic}#main .adb-text{min-width:0}#main .adb-text > :first-child{margin-top:0}#main .adb-text > :last-child{margin-bottom:0}'
    + '#main .adb-charts{display:flex;flex-direction:column;gap:6px}#main .adb-crow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);min-width:0}#main .adb-crow .grow{min-width:0;overflow-wrap:anywhere}';

  const base = (app) => '/api/apps/' + enc(app.id);
  const dbOf = (st) => st.db || (st.db = { key: null, values: {}, edit: false });
  const overlay = () => !!document.querySelector('#overlay .modal, #overlay .drawer');

  function load(ctx, app, deps) {
    const db = dbOf(ctx.state);
    if (db.key === app.id || db.busy === app.id) return;
    db.busy = app.id;
    Promise.all([App.get(base(app) + '/dashboards'), App.get(base(app) + '/charts')])
      .then(([d, c]) => { db.list = d.dashboards; db.canShare = d.canShare; db.charts = c.charts; db.key = app.id; db.err = null; if (!db.list.some((x) => x.id === db.sel)) { db.sel = db.list[0] ? db.list[0].id : null; db.data = null; } })
      .catch((err) => { db.err = err; db.key = app.id; })
      .finally(() => { db.busy = null; deps.refresh(); });
  }
  function loadData(ctx, app, deps, fresh) {
    const db = dbOf(ctx.state);
    const dash = (db.list || []).find((x) => x.id === db.sel);
    if (!dash) return;
    const key = dash.id + ':' + dash.rev + ':' + JSON.stringify(db.values[dash.id] || {});
    if (!fresh && (db.dataKey === key || db.dataBusy === key)) return;
    db.dataBusy = key;
    const mine = db.dataSeq = (db.dataSeq || 0) + 1;
    App.post(base(app) + '/dashboards/' + enc(dash.id) + '/data', { filters: db.values[dash.id] || {}, fresh: !!fresh })
      .then((d) => { if (db.dataSeq !== mine) return; db.data = d; db.dataKey = key; db.dataErr = null; })
      .catch((err) => { if (db.dataSeq !== mine) return; db.dataErr = err; db.dataKey = key; })
      .finally(() => { if (db.dataSeq === mine) db.dataBusy = null; if (!overlay()) deps.refresh(); else ctx.state.dirty = true; });
  }
  function schedule(ctx, app, deps, dash) {
    const db = dbOf(ctx.state);
    clearTimeout(db.timer);
    db.timer = null;
    if (!dash || !dash.refresh || db.edit) return;
    db.timer = setTimeout(() => {
      db.timer = null;
      if (App.state.route !== 'apps' || ctx.state.tab !== 'dashboards' || dbOf(ctx.state).sel !== dash.id) return;
      if (overlay() || document.activeElement && document.activeElement.closest && document.activeElement.closest('#main .adb-filters')) { schedule(ctx, app, deps, dash); return; }
      loadData(ctx, app, deps, false);
    }, dash.refresh * 1000);
  }
  const reset = (db) => { db.key = null; db.dataKey = null; };

  function cardBody(c, deps) {
    if (c.state === 'unavailable') return '<p class="adb-na">Not available to you.</p><p class="muted" style="margin:0;font-size:12px">' + esc(c.reason || '') + '</p>';
    if (c.state === 'error') return UI.problem('This card could not be computed', c.detail || '', false);
    if (c.kind === 'text') return '<div class="adb-text">' + (c.html || '') + '</div>';
    if (c.kind === 'chart') return App.appsChart ? App.appsChart.render(c.chart, { uid: 'adb-' + c.id, width: c.size === 'full' ? 1000 : c.size === 'small' ? 300 : 520 }) + (c.chart.filtersApplied && c.chart.filtersApplied.length === 0 && deps.filtered ? '<span class="muted" style="font-size:12px">The dashboard filters do not apply to this card.</span>' : '') : UI.notice('The chart renderer did not load (apps-charts.js).', 'warn');
    const t = c.table;
    return UI.table(t.columns.map((x) => x.label), t.rows, { clickable: false, emptyTitle: 'No records', emptyText: 'None match, or none you may read.' }) + '<span class="muted" style="font-size:12px">' + t.rows.length + ' of ' + (t.total == null ? t.rows.length : t.total) + ' records' + (deps.filtered && !t.filtersApplied.length ? '; the dashboard filters do not apply' : '') + '.</span>';
  }

  App.appsDashboards = function (ctx, app, deps) {
    const st = ctx.state;
    const db = dbOf(st);
    if (db.key !== app.id) { if (db.key && db.key !== app.id) { db.sel = null; db.data = null; db.edit = false; } load(ctx, app, deps); }
    const head = '<style>' + CSS + '</style>' + (App.appsChart ? App.appsChart.css() : '');
    if (db.err && db.key === app.id) return { body: head + UI.problem('Dashboards could not be loaded', deps.detailOf(db.err), deps.traceOf(db.err)) + '<div>' + UI.btn('Try again', { attrs: 'data-adb-reload' }) + '</div>', inspector: '' };
    if (db.key !== app.id || !db.list) return { body: head + UI.notice('Loading…', 'info'), inspector: '' };
    const dash = db.list.find((x) => x.id === db.sel) || null;
    if (dash) loadData(ctx, app, deps, false);
    const editing = !!(db.edit && dash && dash.canEdit);
    if (editing && (!db.draft || db.draft.id !== dash.id)) db.draft = { id: dash.id, cards: JSON.parse(JSON.stringify(dash.cards)), filters: JSON.parse(JSON.stringify(dash.filters)), refresh: dash.refresh };
    const data = dash && db.data && db.data.id === dash.id ? db.data : null;

    // ----- toolbar -----
    let html = head + '<div class="adb">';
    html += '<div class="adb-bar">'
      + (db.list.length ? '<label class="sr" for="adb-sel">Dashboard</label><select class="select" id="adb-sel" data-adb-sel>' + db.list.map((d) => '<option value="' + esc(d.id) + '"' + (d.id === db.sel ? ' selected' : '') + '>' + esc(d.name + (d.shared ? ' (shared)' : ' (private)')) + '</option>').join('') + '</select>' : '<span class="muted">No dashboards yet.</span>')
      + UI.btn('New dashboard', { size: 'sm', icon: 'plus', attrs: 'data-adb-new' });
    if (dash) {
      html += (dash.canEdit ? UI.btn(editing ? 'Editing layout' : 'Edit layout', { size: 'sm', icon: 'edit', attrs: 'data-adb-edit aria-pressed="' + (editing ? 'true' : 'false') + '"' }) + UI.btn('Rename', { size: 'sm', attrs: 'data-adb-rename' }) : '')
        + (dash.canEdit && db.canShare ? UI.btn(dash.shared ? 'Make private' : 'Share', { size: 'sm', attrs: 'data-adb-share aria-pressed="' + (dash.shared ? 'true' : 'false') + '"' }) : '')
        + (dash.canEdit ? UI.btn('Delete', { size: 'sm', kind: 'ghost', attrs: 'data-adb-delete' }) : '')
        + '<span class="grow"></span>'
        + UI.btn('Refresh', { size: 'sm', icon: 'refresh', attrs: 'data-adb-refresh' })
        + '<a class="btn sm" data-adb-dl="pdf" href="' + base(app) + '/dashboards/' + enc(dash.id) + '/render?format=pdf&filters=' + enc(JSON.stringify(db.values[dash.id] || {})) + '" download>' + UI.icon('download', 14) + '<span>PDF</span></a>'
        + '<a class="btn sm" data-adb-dl="html" href="' + base(app) + '/dashboards/' + enc(dash.id) + '/render?format=html&filters=' + enc(JSON.stringify(db.values[dash.id] || {})) + '" download>' + UI.icon('download', 14) + '<span>HTML</span></a>'
        + (App.appsSubscribeButton ? App.appsSubscribeButton({ app: app.id, appTitle: app.title || app.name, kind: 'dashboard', id: dash.id, title: dash.name }, { size: 'sm' }) : '');
    }
    html += '</div>';
    if (dash) html += '<p class="muted" style="margin:0;font-size:13px">' + esc((dash.shared ? "Shared with the app's readers" : 'Private to ' + (dash.mine ? 'you' : deps.who(dash.ownerId))) + '. ' + (dash.refresh ? 'Refreshes every ' + (REFRESH.find((r) => +r.value === dash.refresh) || { label: dash.refresh + ' s' }).label.replace(/^Every /, '') + '. ' : '') + 'Every card is computed as you: what you see is what you may read.' + (data ? ' Computed ' + new Date(data.computedAt).toLocaleTimeString() + '.' : '')) + (dash.description ? ' ' + esc(dash.description) : '') + '</p>';

    // ----- filters -----
    const filters = editing ? db.draft.filters : dash ? dash.filters : [];
    if (dash && filters.length) {
      const vals = db.values[dash.id] || {};
      html += '<fieldset class="adb-filters"><legend>Filters</legend>' + filters.map((f) => {
        const v = Object.prototype.hasOwnProperty.call(vals, f.id) ? vals[f.id] : f.default || {};
        if (f.kind === 'date') return UI.field(f.label + ' from', UI.input(v.from || '', { type: 'date', attrs: 'data-adb-fv="' + esc(f.id) + '" data-part="from"' })) + UI.field(f.label + ' to', UI.input(v.to || '', { type: 'date', attrs: 'data-adb-fv="' + esc(f.id) + '" data-part="to"' }));
        return UI.field(f.label, UI.input(v.value == null ? '' : String(v.value), { attrs: 'data-adb-fv="' + esc(f.id) + '" data-part="value" maxlength="200"', placeholder: 'any' }));
      }).join('') + '<div class="hstack gap6">' + UI.btn('Apply filters', { size: 'sm', kind: 'primary', attrs: 'data-adb-fapply' }) + UI.btn('Reset', { size: 'sm', attrs: 'data-adb-freset' }) + '</div>'
        + (editing ? '<div class="hstack gap6 wrap">' + filters.map((f) => UI.btn('Remove filter ' + f.label, { size: 'xs', kind: 'ghost', attrs: 'data-adb-fdel="' + esc(f.id) + '"' })).join('') + '</div>' : '') + '</fieldset>';
    }
    if (editing) html += '<div class="adb-bar">' + UI.btn('Add a card', { size: 'sm', icon: 'plus', attrs: 'data-adb-addcard' }) + UI.btn('Add a filter', { size: 'sm', icon: 'filter', attrs: 'data-adb-addfilter' })
      + '<label class="sr" for="adb-refresh">Refresh</label><select class="select" id="adb-refresh" data-adb-refreshsel aria-label="Refresh">' + REFRESH.map((r) => '<option value="' + r.value + '"' + (+r.value === db.draft.refresh ? ' selected' : '') + '>' + esc('Refresh: ' + r.label.toLowerCase()) + '</option>').join('') + '</select>'
      + '<span class="grow"></span>' + UI.btn('Cancel', { size: 'sm', attrs: 'data-adb-cancel' }) + UI.btn('Save layout', { size: 'sm', kind: 'primary', attrs: 'data-adb-save' }) + '</div>'
      + '<p class="muted" style="margin:0;font-size:12px">Drag a card to move it, or use its Move earlier and Move later buttons. Changes are kept when you save the layout.</p>';

    // ----- cards -----
    if (!dash) html += UI.empty(db.list.length ? 'Pick a dashboard' : 'No dashboards yet', 'A dashboard puts charts, number tiles, saved views and notes on one page, each computed as the person looking at it.', UI.btn('New dashboard', { kind: 'primary', attrs: 'data-adb-new' }));
    else if (db.dataErr && !data) html += UI.problem('The dashboard could not be computed', deps.detailOf(db.dataErr), deps.traceOf(db.dataErr));
    else if (!data && !editing) html += UI.notice('Computing the cards…', 'info');
    else {
      const results = {};
      (data ? data.cards : []).forEach((c) => { results[c.id] = c; });
      const cards = editing ? db.draft.cards : dash.cards;
      const filtered = !!(data && data.applied && data.applied.length);
      if (!cards.length) html += UI.empty('No cards yet', dash.canEdit ? 'Edit the layout to add charts, tiles, saved views and notes.' : 'Its owner has not added any cards.', dash.canEdit && !editing ? UI.btn('Edit layout', { attrs: 'data-adb-edit' }) : '');
      html += '<div class="adb-grid" data-adb-grid>' + cards.map((c, i) => {
        const r = results[c.id];
        const chart = c.kind === 'chart' ? (db.charts || []).find((x) => x.id === c.chart) : null;
        const title = c.title || (r && r.title) || (chart ? chart.name : c.kind === 'text' ? 'Note' : c.kind === 'view' ? c.entity : 'Chart');
        const controls = editing ? '<div class="adb-edit">'
          + UI.btn('Move earlier', { size: 'xs', attrs: 'data-adb-up="' + i + '" aria-label="Move ' + esc(title) + ' earlier"', disabled: i === 0 })
          + UI.btn('Move later', { size: 'xs', attrs: 'data-adb-down="' + i + '" aria-label="Move ' + esc(title) + ' later"', disabled: i === cards.length - 1 })
          + '<label class="sr" for="adb-size-' + esc(c.id) + '">Size of ' + esc(title) + '</label><select class="select" id="adb-size-' + esc(c.id) + '" data-adb-size="' + i + '">' + SIZES.map((s) => '<option value="' + s.value + '"' + (s.value === c.size ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') + '</select>'
          + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-adb-rm="' + i + '" aria-label="Remove ' + esc(title) + '"' }) + '</div>' : '';
        const body = r && (!editing || JSON.stringify(dash.cards.find((x) => x.id === c.id) || null) === JSON.stringify(c)) ? cardBody(r, { filtered }) : '<p class="muted" style="margin:0">' + (editing ? 'Shown when the layout is saved.' : 'Computing…') + '</p>';
        return '<section class="panel adb-card adb-' + esc(c.size) + '" data-adb-card="' + i + '" aria-labelledby="adb-h-' + esc(c.id) + '"' + (editing ? ' draggable="true"' : '') + '><div class="adb-head"><h2 id="adb-h-' + esc(c.id) + '">' + esc(title) + '</h2>' + controls + '</div>' + body + '</section>';
      }).join('') + '</div>';
    }

    // ----- charts of the app -----
    const charts = db.charts || [];
    html += '<section class="panel adb-charts" aria-labelledby="adb-charts-h"><div class="adb-head"><h2 id="adb-charts-h">Charts of this app</h2>' + UI.btn('New chart', { size: 'sm', icon: 'plus', attrs: 'data-adb-newchart' }) + '</div>'
      + (charts.length ? charts.map((c) => '<div class="adb-crow"><span class="grow"><strong>' + esc(c.name) + '</strong> <span class="muted">' + esc((TYPE_NAMES[c.definition ? c.definition.type : ''] || 'Chart') + ', over ' + (c.sourceKind === 'entity' ? 'records of ' + ((c.definition && c.definition.source.entity) || '') : c.sourceKind === 'query' ? 'a saved query' : 'a REST endpoint')) + '</span></span>'
        + UI.pill(c.shared ? 'shared' : 'private', c.shared ? 'info' : 'outline') + UI.label(c.label, { sm: true })
        + (c.canEdit ? UI.btn('Edit', { size: 'xs', attrs: 'data-adb-chedit="' + esc(c.id) + '" aria-label="Edit chart ' + esc(c.name) + '"' }) + UI.btn('Delete', { size: 'xs', kind: 'ghost', attrs: 'data-adb-chdel="' + esc(c.id) + '" aria-label="Delete chart ' + esc(c.name) + '"' }) : '') + '</div>').join('') : '<p class="muted" style="margin:0">No charts yet. A chart groups records (or a saved query or REST endpoint) by a field or a date and counts or sums them.</p>')
      + '</section></div>';

    schedule(ctx, app, deps, editing ? null : dash);
    setTimeout(() => { if (App.appsChart) App.appsChart.fit(document.getElementById('main')); }, 0);

    // ----- events -----
    const after = (focusSel) => { ctx.rerender(); if (focusSel) { const el = ctx.$(focusSel); if (el) el.focus(); } };
    const saveDash = (patch, okText) => App.patch(base(app) + '/dashboards/' + enc(dash.id), Object.assign({ rev: dash.rev }, patch))
      .then((d) => { const i = db.list.findIndex((x) => x.id === d.id); db.list[i] = d; db.dataKey = null; ctx.toast(okText + ' Audited app.dashboard.updated.', 'ok'); return d; })
      .catch((err) => { if (err.status === 409) { reset(db); ctx.rerender(); } App.fail(err, 'The dashboard was not saved'); throw err; });
    const chartDeps = Object.assign({}, deps, { canShare: db.canShare });
    ctx.on('click', '[data-adb-reload]', () => { reset(db); db.err = null; ctx.rerender(); });
    ctx.on('change', '[data-adb-sel]', (e, t) => { db.sel = t.value; db.data = null; db.dataKey = null; db.edit = false; db.draft = null; after('[data-adb-sel]'); });
    ctx.on('click', '[data-adb-refresh]', () => { loadData(ctx, app, deps, true); ctx.toast('Recomputing the cards.', '', 1800); });
    ctx.on('click', '[data-adb-new]', () => openNew(ctx, app, deps, db));
    ctx.on('click', '[data-adb-newchart]', () => { if (!App.appsChartBuilder) return; App.appsChartBuilder(ctx, app, chartDeps, null, () => { reset(db); ctx.rerender(); }); });
    ctx.on('click', '[data-adb-chedit]', (e, t) => { const c = charts.find((x) => x.id === t.dataset.adbChedit); if (c && App.appsChartBuilder) App.appsChartBuilder(ctx, app, chartDeps, c, () => { reset(db); ctx.rerender(); }); });
    ctx.on('click', '[data-adb-chdel]', async (e, t) => {
      const c = charts.find((x) => x.id === t.dataset.adbChdel); if (!c) return;
      const ok = await ctx.confirm({ title: 'Delete the chart ' + esc(c.name), tone: 'danger', body: '<p class="fg2" style="margin:0">Cards that show it say the chart is not available. Its saved versions go too.</p>', ok: 'Delete chart' });
      if (!ok) return;
      try { await App.del(base(app) + '/charts/' + enc(c.id)); reset(db); ctx.rerender(); ctx.toast('Deleted the chart ' + esc(c.name) + '. Audited app.chart.deleted.', 'warn'); } catch (err) { App.fail(err, 'The chart was not deleted'); }
    });
    if (!dash) return { body: html, inspector: '' };

    ctx.on('click', '[data-adb-edit]', () => { db.edit = !editing; db.draft = null; after('[data-adb-edit]'); });
    ctx.on('click', '[data-adb-cancel]', () => { db.edit = false; db.draft = null; after('[data-adb-edit]'); });
    ctx.on('click', '[data-adb-save]', () => {
      saveDash({ cards: db.draft.cards, filters: db.draft.filters, refresh: db.draft.refresh }, 'Saved the layout of ' + esc(dash.name) + '.').then(() => { db.edit = false; db.draft = null; after('[data-adb-edit]'); }).catch(() => {});
    });
    ctx.on('change', '[data-adb-refreshsel]', (e, t) => { db.draft.refresh = +t.value; });
    const titleOf = (c) => c.title || (c.kind === 'chart' ? ((db.charts || []).find((x) => x.id === c.chart) || { name: 'the chart' }).name : c.kind === 'text' ? 'the note' : c.entity);
    const move = (from, to) => { const cs = db.draft.cards; if (to < 0 || to >= cs.length) return; const [c] = cs.splice(from, 1); cs.splice(to, 0, c); return c; };
    ctx.on('click', '[data-adb-up]', (e, t) => { const i = +t.dataset.adbUp; const c = move(i, i - 1); if (!c) return; after(i - 1 === 0 ? '[data-adb-down="0"]' : '[data-adb-up="' + (i - 1) + '"]'); ctx.toast('Moved ' + esc(titleOf(c)) + ' to place ' + i + ' of ' + db.draft.cards.length + '.', '', 2000); });
    ctx.on('click', '[data-adb-down]', (e, t) => { const i = +t.dataset.adbDown; const c = move(i, i + 1); if (!c) return; after(i + 1 === db.draft.cards.length - 1 ? '[data-adb-up="' + (i + 1) + '"]' : '[data-adb-down="' + (i + 1) + '"]'); ctx.toast('Moved ' + esc(titleOf(c)) + ' to place ' + (i + 2) + ' of ' + db.draft.cards.length + '.', '', 2000); });
    ctx.on('change', '[data-adb-size]', (e, t) => { db.draft.cards[+t.dataset.adbSize].size = t.value; after('[data-adb-size="' + t.dataset.adbSize + '"]'); });
    ctx.on('click', '[data-adb-rm]', (e, t) => { db.draft.cards.splice(+t.dataset.adbRm, 1); after('[data-adb-addcard]'); });
    ctx.on('dragstart', '[data-adb-card]', (e, t) => { if (!editing) return; db.dragFrom = +t.dataset.adbCard; t.classList.add('drag'); if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.dataset.adbCard); } });
    ctx.on('dragend', '[data-adb-card]', (e, t) => { t.classList.remove('drag'); });
    ctx.on('dragover', '[data-adb-card]', (e, t) => { if (!editing) return; e.preventDefault(); t.classList.add('drop'); });
    ctx.on('dragleave', '[data-adb-card]', (e, t) => { t.classList.remove('drop'); });
    ctx.on('drop', '[data-adb-card]', (e, t) => { if (!editing || db.dragFrom == null) return; e.preventDefault(); const to = +t.dataset.adbCard; move(db.dragFrom, to); db.dragFrom = null; ctx.rerender(); });
    ctx.on('click', '[data-adb-addcard]', () => openAddCard(ctx, app, deps, db));
    ctx.on('click', '[data-adb-addfilter]', () => openAddFilter(ctx, app, deps, db));
    ctx.on('click', '[data-adb-fdel]', (e, t) => { db.draft.filters = db.draft.filters.filter((f) => f.id !== t.dataset.adbFdel); after('[data-adb-addfilter]'); });
    const readFilters = () => {
      const out = {};
      ctx.$$('[data-adb-fv]').forEach((el) => { const id = el.dataset.adbFv; const part = el.dataset.part; out[id] = out[id] || {}; const v = el.value.trim(); if (part === 'value') { if (v) out[id].value = v; } else out[id][part] = v || null; });
      return out;
    };
    ctx.on('click', '[data-adb-fapply]', () => {
      const vals = readFilters();
      const bad = filters.find((f) => f.kind === 'date' && vals[f.id] && vals[f.id].from && vals[f.id].to && vals[f.id].from > vals[f.id].to);
      if (bad) { ctx.toast(esc(bad.label) + ': the start is after the end.', 'warn'); return; }
      db.values[dash.id] = vals; db.dataKey = null; loadData(ctx, app, deps, false); after('[data-adb-fapply]');
    });
    ctx.on('click', '[data-adb-freset]', () => { delete db.values[dash.id]; db.dataKey = null; after('[data-adb-fapply]'); });
    ctx.on('click', '[data-adb-rename]', () => openRename(ctx, app, deps, db, dash, saveDash));
    ctx.on('click', '[data-adb-share]', async () => {
      const ok = await ctx.confirm({ title: dash.shared ? 'Make ' + esc(dash.name) + ' private' : 'Share ' + esc(dash.name), body: '<p class="fg2" style="margin:0">' + (dash.shared ? 'Only its owner will see it.' : "Everyone who reads this app's records sees it. Each card is computed as the person looking at it, so nobody sees more than they may read; cards they cannot read say so.") + '</p>', ok: dash.shared ? 'Make private' : 'Share' });
      if (!ok) return;
      saveDash({ shared: !dash.shared }, dash.shared ? esc(dash.name) + ' is private.' : esc(dash.name) + " is shared with the app's readers.").then(() => after('[data-adb-share]')).catch(() => {});
    });
    ctx.on('click', '[data-adb-delete]', async () => {
      const ok = await ctx.confirm({ title: 'Delete ' + esc(dash.name), tone: 'danger', body: '<p class="fg2" style="margin:0">Deletes the dashboard and its layout. Its charts stay.</p>', ok: 'Delete dashboard' });
      if (!ok) return;
      try { await App.del(base(app) + '/dashboards/' + enc(dash.id)); db.sel = null; db.data = null; reset(db); ctx.rerender(); ctx.toast('Deleted the dashboard ' + esc(dash.name) + '. Audited app.dashboard.deleted.', 'warn'); } catch (err) { App.fail(err, 'The dashboard was not deleted'); }
    });
    ctx.on('click', '[data-adb-dl]', (e, t) => { ctx.toast('Downloading a ' + (t.dataset.adbDl === 'pdf' ? 'PDF' : 'HTML') + ' snapshot computed as you. Audited app.dashboard.rendered.', '', 2500); });
    return { body: html, inspector: '' };
  };

  function openNew(ctx, app, deps, db) {
    const body = '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-nd-name maxlength="100"' })) + '<div class="span2">' + UI.field('Description', UI.textarea('', { rows: 2, attrs: 'data-nd-desc maxlength="1000"' })) + '</div>'
      + (db.canShare ? '<div class="span2">' + UI.check("Share with the app's readers", false, 'data-nd-shared') + '</div>' : '') + '</div><div data-nd-err role="alert"></div>';
    deps.modal({ title: 'New dashboard', body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create dashboard', { kind: 'primary', attrs: 'data-nd-ok' }),
      onMount(m) {
        const name = m.querySelector('[data-nd-name]');
        setTimeout(() => name.focus(), 0);
        const go = async () => {
          const err = m.querySelector('[data-nd-err]'); err.innerHTML = '';
          if (!name.value.trim()) { err.innerHTML = UI.notice('A dashboard needs a name.', 'warn'); name.focus(); return; }
          const shared = m.querySelector('[data-nd-shared]');
          try {
            const d = await App.post(base(app) + '/dashboards', { name: name.value.trim(), description: m.querySelector('[data-nd-desc]').value.trim() || null, shared: !!(shared && shared.checked) });
            App.closeOverlay(); db.list.push(d); db.sel = d.id; db.data = null; db.dataKey = null; db.edit = true; db.draft = null; ctx.rerender();
            const el = ctx.$('[data-adb-addcard]'); if (el) el.focus();
            ctx.toast('Created the dashboard ' + esc(d.name) + '. Add cards, then save the layout. Audited app.dashboard.created.', 'ok');
          } catch (ex) { err.innerHTML = UI.problem('The dashboard was not created', deps.detailOf(ex), deps.traceOf(ex)); }
        };
        m.querySelector('[data-nd-ok]').addEventListener('click', go);
        name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      } });
  }

  function openRename(ctx, app, deps, db, dash, saveDash) {
    const body = '<div class="formgrid">' + UI.field('Name', UI.input(dash.name, { attrs: 'data-rd-name maxlength="100"' })) + '<div class="span2">' + UI.field('Description', UI.textarea(dash.description || '', { rows: 2, attrs: 'data-rd-desc maxlength="1000"' })) + '</div></div><div data-rd-err role="alert"></div>';
    deps.modal({ title: 'Rename ' + esc(dash.name), body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-rd-ok' }),
      onMount(m) {
        const name = m.querySelector('[data-rd-name]');
        setTimeout(() => name.focus(), 0);
        m.querySelector('[data-rd-ok]').addEventListener('click', () => {
          if (!name.value.trim()) { m.querySelector('[data-rd-err]').innerHTML = UI.notice('A dashboard needs a name.', 'warn'); return; }
          saveDash({ name: name.value.trim(), description: m.querySelector('[data-rd-desc]').value.trim() || null }, 'Renamed to ' + esc(name.value.trim()) + '.').then(() => { App.closeOverlay(); ctx.rerender(); }).catch(() => {});
        });
      } });
  }

  function openAddCard(ctx, app, deps, db) {
    const charts = db.charts || [];
    const ents = app.entities;
    const form = (kind) => (kind === 'chart' ? (charts.length ? UI.field('Chart', UI.select(charts.map((c) => ({ value: c.id, label: c.name + (c.shared ? '' : ' (private: only you see it)') })), charts[0].id, 'data-ac-chart')) : UI.notice('This app has no charts yet. Make one with New chart below the dashboard.', 'info'))
      : kind === 'view' ? UI.field('Entity', UI.select(ents.map((e) => ({ value: e.name, label: e.title || e.name })), ents[0] ? ents[0].name : '', 'data-ac-entity')) + UI.field('Saved view', UI.select([{ value: '', label: 'All records' }], '', 'data-ac-view'), 'Shared views show to every reader; a private one only to you.') + UI.field('Rows', UI.input('10', { type: 'number', attrs: 'data-ac-rows min="1" max="50"' }))
      : UI.field('Text (Markdown)', UI.textarea('', { rows: 5, attrs: 'data-ac-md maxlength="5000"' }), 'Headings, lists, bold, italic, code and tables. HTML, links and pictures show as text.'));
    const body = '<div class="formgrid"><div class="span2">' + UI.field('Kind', UI.select([{ value: 'chart', label: 'A chart or number tile' }, { value: 'view', label: "A saved view's table" }, { value: 'text', label: 'Text' }], 'chart', 'data-ac-kind')) + '</div><div class="span2 vstack gap6" data-ac-form>' + form('chart') + '</div>'
      + UI.field('Title', UI.input('', { attrs: 'data-ac-title maxlength="120"', placeholder: 'the chart or view name' })) + UI.field('Size', UI.select(SIZES, 'medium', 'data-ac-size')) + '</div><div data-ac-err role="alert"></div>';
    deps.modal({ title: 'Add a card', body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add card', { kind: 'primary', attrs: 'data-ac-ok' }),
      onMount(m) {
        const views = () => {
          const sel = m.querySelector('[data-ac-entity]'); if (!sel) return;
          const ent = ents.find((e) => e.name === sel.value); if (!ent) return;
          App.get('/api/apps/' + enc(app.id) + '/entities/' + enc(ent.id) + '/views').then((r) => { const v = m.querySelector('[data-ac-view]'); if (v) v.innerHTML = '<option value="">All records</option>' + (r.views || []).map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name + (x.shared ? ' (shared)' : ' (private)')) + '</option>').join(''); }).catch(() => {});
        };
        m.querySelector('[data-ac-kind]').addEventListener('change', (e) => { m.querySelector('[data-ac-form]').innerHTML = form(e.target.value); views(); });
        m.addEventListener('change', (e) => { if (e.target.hasAttribute('data-ac-entity')) views(); });
        setTimeout(() => m.querySelector('[data-ac-kind]').focus(), 0);
        m.querySelector('[data-ac-ok]').addEventListener('click', () => {
          const kind = m.querySelector('[data-ac-kind]').value;
          const err = m.querySelector('[data-ac-err]'); err.innerHTML = '';
          const id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
          const title = m.querySelector('[data-ac-title]').value.trim() || null;
          const size = m.querySelector('[data-ac-size]').value;
          let card;
          if (kind === 'chart') { const c = m.querySelector('[data-ac-chart]'); if (!c) { err.innerHTML = UI.notice('Make a chart first.', 'warn'); return; } card = { id, kind, chart: c.value, title, size }; }
          else if (kind === 'view') card = { id, kind, entity: m.querySelector('[data-ac-entity]').value, view: m.querySelector('[data-ac-view]').value || null, rows: Math.max(1, Math.min(50, parseInt(m.querySelector('[data-ac-rows]').value, 10) || 10)), title, size };
          else { const md = m.querySelector('[data-ac-md]').value; if (!md.trim()) { err.innerHTML = UI.notice('Write the text first.', 'warn'); return; } card = { id, kind, markdown: md, title, size }; }
          if (db.draft.cards.length >= 24) { err.innerHTML = UI.notice('At most 24 cards on one dashboard.', 'warn'); return; }
          db.draft.cards.push(card);
          App.closeOverlay(); ctx.rerender();
          const el = ctx.$('[data-adb-size="' + (db.draft.cards.length - 1) + '"]'); if (el) el.focus();
          ctx.toast('Added the card. Save the layout to keep it.', '', 2500);
        });
      } });
  }

  function openAddFilter(ctx, app, deps, db) {
    const fields = [];
    app.entities.forEach((e) => (e.definition.fields || []).forEach((f) => { if ((f.indexed || f.unique) && fields.indexOf(f.name) < 0 && f.type !== 'json' && f.type !== 'relation') fields.push(f.name); }));
    ['createdAt', 'updatedAt', 'state'].forEach((n) => { if (fields.indexOf(n) < 0) fields.push(n); });
    const body = '<div class="formgrid">' + UI.field('Kind', UI.select([{ value: 'date', label: 'A date range' }, { value: 'value', label: 'A field value' }], 'date', 'data-af2-kind'))
      + UI.field('Field', UI.input('', { attrs: 'data-af2-field list="adb-fields" maxlength="70"', placeholder: 'closed, region, createdAt' }), 'Applies to every card whose source has this field (or column).') + '<datalist id="adb-fields">' + fields.map((f) => '<option value="' + esc(f) + '">').join('') + '</datalist>'
      + UI.field('Label', UI.input('', { attrs: 'data-af2-label maxlength="80"' })) + '</div><div data-af2-err role="alert"></div>';
    deps.modal({ title: 'Add a filter', body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add filter', { kind: 'primary', attrs: 'data-af2-ok' }),
      onMount(m) {
        setTimeout(() => m.querySelector('[data-af2-kind]').focus(), 0);
        m.querySelector('[data-af2-ok]').addEventListener('click', () => {
          const kind = m.querySelector('[data-af2-kind]').value;
          const field = m.querySelector('[data-af2-field]').value.trim();
          const label = m.querySelector('[data-af2-label]').value.trim() || field;
          const err = m.querySelector('[data-af2-err]');
          if (!field) { err.innerHTML = UI.notice('Name the field it filters.', 'warn'); return; }
          if (db.draft.filters.length >= 6) { err.innerHTML = UI.notice('At most 6 filters.', 'warn'); return; }
          let id = field.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z]+/, '') || 'f';
          id = id.slice(0, 24);
          while (db.draft.filters.some((f) => f.id === id)) id = id.slice(0, 24) + Math.floor(Math.random() * 90 + 10);
          db.draft.filters.push({ id, kind, field, label, default: null });
          App.closeOverlay(); ctx.rerender();
          ctx.toast('Added the filter ' + esc(label) + '. Save the layout to keep it.', '', 2500);
        });
      } });
  }
})();
