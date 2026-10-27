(function () {
  /*
   * 2.0.0 (file management): the Files screen's Dashboard and Reports views, over the current folder and everything
   * below it (or the whole workspace at its root), within the reader's clearance. files.js calls
   * App.filesReports.render(ctx, st, scope) for the view's HTML and wire(ctx, st, scope) for its events; this module
   * keeps its own state in st.rep and loads from /api/file-reports.
   */
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const GB = 1024 * 1024 * 1024, MB = 1024 * 1024, KB = 1024;
  const fmtBytes = (n) => n == null ? '' : n >= GB ? (n / GB).toFixed(1) + ' GB' : n >= MB ? (n / MB).toFixed(1) + ' MB' : n >= KB ? Math.round(n / KB) + ' KB' : n + ' B';
  const fmtNum = (n) => n == null ? '' : Number(n).toLocaleString();
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const day = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const monthName = (m) => { const p = String(m).split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, 1)).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }); };
  const plural = (n, one, many) => fmtNum(n) + ' ' + (n === 1 ? one : (many || one + 's'));
  const canWrite = () => App.can('files:write');
  const SHOWN = 500;

  const KINDS = [
    { value: 'inventory', label: 'Inventory: every file' },
    { value: 'largest', label: 'Largest files' },
    { value: 'stale', label: 'Unchanged for 180 days' },
    { value: 'duplicates', label: 'Duplicate files' },
    { value: 'shared', label: 'Shared files' },
    { value: 'activity', label: 'Activity by person and month' },
    { value: 'by-owner', label: 'Storage by owner' },
    { value: 'by-type', label: 'Storage by type' }
  ];

  const CSS = '<style>'
    + '#main .frep-kpis{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))}'
    + '#main .frep-kpi{display:block;width:100%;text-align:left;font:inherit;color:inherit;padding:0;border:0;background:none;cursor:pointer;border-radius:6px}'
    + '#main .frep-kpi .stat{height:100%}#main .frep-kpi:hover .stat{border-color:var(--muted)}'
    + '#main .frep-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}'
    + '#main .frep-card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:6px}'
    + '#main .frep-card h3{margin:0;font-size:13px;font-weight:600}'
    + '#main .frep-bars{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}'
    + '#main .frep-bar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;font-size:12px}'
    + '#main .frep-bar .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)}'
    + '#main .frep-bar .v{font-variant-numeric:tabular-nums;color:var(--fg);text-align:right}'
    + '#main .frep-bar .t{grid-column:1 / -1;height:6px;border-radius:3px;background:var(--bar-off,var(--panel2));overflow:hidden}'
    + '#main .frep-bar .t i{display:block;height:100%;background:var(--accent);border-radius:3px}'
    + '#main .frep-tl{width:100%;height:auto;display:block}'
    + '#main .frep-tl .col{fill:var(--accent)}#main .frep-tl .ax{fill:var(--muted);font-size:10px;font-family:var(--sans)}#main .frep-tl .val{fill:var(--fg2);font-size:10px;font-family:var(--sans)}'
    + '#main .frep-tl .base{stroke:var(--line)}'
    + '#main .frep-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}'
    + '#main .frep-list li{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-top:1px solid var(--line);font-size:12px;min-width:0}#main .frep-list li:first-child{border-top:0}'
    + '#main .frep-list .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#main .frep-list .m{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}'
    + '#main .frep-link{background:none;border:0;padding:0;color:var(--accent);font:inherit;text-align:left;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#main .frep-link:hover{text-decoration:underline}'
    + '#main .frep-tags{display:flex;flex-wrap:wrap;gap:6px}'
    + '#main .frep-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}'
    + '#main .frep-tools .field{min-width:min(100%,240px)}'
    + '#main .frep-path{overflow-wrap:anywhere}'
    + '#main details.frep-more summary{cursor:pointer;font-size:12px;color:var(--muted)}'
    + '</style>';

  const scopeQuery = (scope) => (scope && scope.folderId ? 'folder=' + enc(scope.folderId) : '');
  const scopeName = (scope) => (scope && scope.folderId ? scope.folderName : (scope && scope.workspaceName) || 'this workspace');

  function rerender(ctx) {
    if (App.state.route !== 'files') return;
    if (document.getElementById('overlay')) { ctx.state.dirty = true; return; }
    const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0;
    ctx.rerender();
    const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top;
  }

  function rep(st) { return st.rep || (st.rep = { kind: 'inventory' }); }

  function loadSummary(ctx, scope) {
    const r = rep(ctx.state); const key = (scope.folderId || '') + '|' + (App.me ? App.me.workspace : '');
    r.sumKey = key; r.sumLoading = true; r.sumError = null;
    App.get('/api/file-reports/summary' + (scopeQuery(scope) ? '?' + scopeQuery(scope) : '')).then((d) => { if (r.sumKey === key) r.summary = d; })
      .catch((err) => { if (r.sumKey === key) { r.summary = null; r.sumError = err; } })
      .finally(() => { if (r.sumKey === key) { r.sumLoading = false; rerender(ctx); } });
  }

  function loadReport(ctx, scope) {
    const r = rep(ctx.state); const key = r.kind + '|' + (scope.folderId || '') + '|' + (App.me ? App.me.workspace : '');
    r.repKey = key; r.repLoading = true; r.repError = null;
    App.get('/api/file-reports/' + enc(r.kind) + (scopeQuery(scope) ? '?' + scopeQuery(scope) : '')).then((d) => { if (r.repKey === key) r.report = d; })
      .catch((err) => { if (r.repKey === key) { r.report = null; r.repError = err; } })
      .finally(() => { if (r.repKey === key) { r.repLoading = false; rerender(ctx); } });
  }

  // ---------- charts ----------

  /** Horizontal bars as a list: each row says its name and value in text; the bar itself is decoration. */
  function bars(title, items, value, label, detail) {
    if (!items.length) return '<div class="frep-card"><h3>' + esc(title) + '</h3><span class="muted" style="font-size:12px">Nothing to show.</span></div>';
    const max = Math.max.apply(null, items.map(value)) || 1;
    return '<div class="frep-card"><h3 id="frep-h-' + esc(title.replace(/\W+/g, '-').toLowerCase()) + '">' + esc(title) + '</h3><ul class="frep-bars" aria-labelledby="frep-h-' + esc(title.replace(/\W+/g, '-').toLowerCase()) + '">'
      + items.map((it) => '<li class="frep-bar"><span class="k" title="' + esc(label(it)) + '">' + esc(label(it)) + '</span><span class="v">' + detail(it) + '</span><span class="t" aria-hidden="true"><i style="width:' + Math.max(1, Math.round((value(it) / max) * 100)) + '%"></i></span></li>').join('')
      + '</ul></div>';
  }

  /** The twelve months as columns of versions added, with the counts written on them and a table to read instead. */
  function timeline(tl) {
    const W = 600, H = 150, top = 16, bottom = 22, gap = 8;
    const max = Math.max.apply(null, tl.map((m) => m.versions)) || 1;
    const bw = (W - gap * (tl.length - 1)) / tl.length;
    const total = tl.reduce((a, m) => a + m.versions, 0);
    const peak = tl.reduce((a, m) => (m.versions > a.versions ? m : a), tl[0] || { versions: 0, month: '' });
    const aria = plural(total, 'version') + ' added in the last 12 months' + (total ? ', most in ' + monthName(peak.month) + ' ' + String(peak.month).slice(0, 4) + ' (' + fmtNum(peak.versions) + ')' : '') + '.';
    const cols = tl.map((m, i) => {
      const h = Math.round(((H - top - bottom) * m.versions) / max); const x = i * (bw + gap); const y = H - bottom - h;
      return '<rect class="col" x="' + x.toFixed(1) + '" y="' + y + '" width="' + bw.toFixed(1) + '" height="' + Math.max(m.versions ? 2 : 0, h) + '" rx="2"></rect>'
        + (m.versions ? '<text class="val" x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4) + '" text-anchor="middle">' + fmtNum(m.versions) + '</text>' : '')
        + '<text class="ax" x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(monthName(m.month)) + '</text>';
    }).join('');
    const table = UI.table(['Month', { label: 'Created', right: true }, { label: 'Updated', right: true }, { label: 'Versions', right: true }, { label: 'Added', right: true }], tl.slice().reverse().map((m) => [esc(m.month), fmtNum(m.created), fmtNum(m.updated), fmtNum(m.versions), esc(fmtBytes(m.bytesAdded))]), { clickable: false, minWidth: '0' });
    return '<div class="frep-card" style="grid-column:1 / -1"><h3>Versions added per month</h3>'
      + '<svg class="frep-tl" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(aria) + '"><line class="base" x1="0" x2="' + W + '" y1="' + (H - bottom) + '" y2="' + (H - bottom) + '"></line>' + cols + '</svg>'
      + '<details class="frep-more"><summary>Show as a table</summary>' + table + '</details></div>';
  }

  function fileList(title, list, meta) {
    return '<div class="frep-card"><h3>' + esc(title) + '</h3>' + (list.length ? '<ul class="frep-list">' + list.map((f) => '<li><span class="n"><button type="button" class="frep-link" data-frep-open="' + esc(f.id) + '" data-frep-folder="' + esc(f.folderId || '') + '" title="' + esc(f.path) + '">' + esc(f.path) + '</button></span><span class="m">' + meta(f) + '</span></li>').join('') + '</ul>' : '<span class="muted" style="font-size:12px">No files.</span>') + '</div>';
  }

  const kpi = (n, label, detail, report) => report
    ? '<button type="button" class="frep-kpi" data-frep-report="' + esc(report) + '" aria-label="' + esc(label + ': ' + n.replace(/<[^>]+>/g, '') + '. Open the report.') + '">' + UI.stat(n, label, detail) + '</button>'
    : UI.stat(n, label, detail);

  // ---------- views ----------

  function renderDashboard(ctx, st, scope) {
    const r = rep(st);
    const key = (scope.folderId || '') + '|' + (App.me ? App.me.workspace : '');
    if (r.sumKey !== key && !r.sumLoading) loadSummary(ctx, scope);
    const head = UI.pagehead('Dashboard', esc(scopeName(scope)) + (scope.folderId ? ' and its subfolders' : ', every folder') + '. Files within your clearance; shared-with-me files are not counted.', UI.btn('Reports', { icon: 'files', attrs: 'data-frep-goto="reports"' }) + UI.btn('Refresh', { kind: 'ghost', attrs: 'data-frep-refresh' }));
    if (r.sumError) return CSS + head + UI.problem('The dashboard could not be loaded', r.sumError.message, r.sumError.problem && r.sumError.problem.trace_id);
    const d = r.sumKey === key ? r.summary : null;
    if (!d) return CSS + head + UI.notice('Loading…', 'info');
    const t = d.totals;
    const kpis = '<div class="frep-kpis">'
      + kpi(fmtNum(t.files), 'Files', esc(plural(t.folders, 'folder')), 'inventory')
      + kpi(esc(fmtBytes(t.bytes)), 'Current size', esc(fmtBytes(t.versionBytes)) + ' with every version', 'largest')
      + kpi(fmtNum(t.versions), 'Versions', t.files ? (t.versions / t.files).toFixed(1) + ' per file' : '', 'activity')
      + kpi(fmtNum(t.shared), 'Shared', esc(plural(d.shares.activeLinks, 'live link')) + (d.shares.groupGrants ? ', ' + esc(plural(d.shares.groupGrants, 'group grant')) : ''), 'shared')
      + kpi(fmtNum(d.stale.files), 'Unchanged ' + d.stale.days + ' days', esc(fmtBytes(d.stale.bytes)), 'stale')
      + kpi(fmtNum(d.duplicates.files), 'Duplicates', d.duplicates.groups ? esc(plural(d.duplicates.groups, 'group')) + ', ' + esc(fmtBytes(d.duplicates.wastedBytes)) + ' repeated' : 'None', 'duplicates')
      + kpi(fmtNum(t.tagged), 'Tagged', t.files ? Math.round((t.tagged / t.files) * 100) + '% of files' : '', null)
      + kpi(fmtNum(t.trashFiles), 'In the trash', esc(fmtBytes(t.trashBytes)) + ' until purged', null)
      + (t.pending || t.rejected ? kpi(fmtNum(t.pending + t.rejected), 'Not ready', esc(fmtNum(t.pending)) + ' scanning, ' + esc(fmtNum(t.rejected)) + ' rejected', null) : '')
      + '</div>';
    const sizeAndCount = (it) => esc(fmtBytes(it.bytes)) + ' · ' + esc(plural(it.files, 'file'));
    const charts = '<div class="frep-grid">'
      + bars('By type', d.byType, (x) => x.bytes, (x) => x.name, sizeAndCount)
      + bars('By folder', d.byFolder.filter((x) => x.files || !x.direct), (x) => x.bytes, (x) => (x.direct ? x.name + ' (directly)' : x.name), sizeAndCount)
      + bars('By label', d.byLabel, (x) => x.files, (x) => x.label, sizeAndCount)
      + bars('By owner', d.byOwner, (x) => x.bytes, (x) => x.ownerName || 'Unknown', sizeAndCount)
      + timeline(d.timeline)
      + fileList('Largest', d.largest, (f) => esc(fmtBytes(f.size)))
      + fileList('Recently changed', d.recent, (f) => esc(day(f.updatedAt)))
      + '<div class="frep-card"><h3>Tags</h3>' + (d.byTag.length ? '<div class="frep-tags">' + d.byTag.map((x) => UI.chip(esc(x.tag) + ' <span class="muted">' + fmtNum(x.files) + '</span>', false, 'data-frep-tag="' + esc(x.tag) + '" aria-label="Files tagged ' + esc(x.tag) + ', ' + esc(plural(x.files, 'file')) + '"')).join('') + '</div>' : '<span class="muted" style="font-size:12px">No tags yet. Tags make files findable in search.</span>') + '</div>'
      + '</div>';
    return CSS + head + kpis + charts + '<span class="muted" style="font-size:11px">Computed ' + esc(when(d.generatedAt)) + '. Sizes are current versions; "with every version" counts every stored version.</span>';
  }

  function cell(c, v) {
    if (v == null || v === '') return '<span class="muted">–</span>';
    if (c.type === 'bytes') return '<span class="num" title="' + esc(fmtNum(v)) + ' bytes">' + esc(fmtBytes(v)) + '</span>';
    if (c.type === 'number') return '<span class="num">' + esc(fmtNum(v)) + '</span>';
    if (c.type === 'datetime') return esc(when(v));
    if (c.type === 'date') return esc(day(v));
    if (c.key === 'sha256' || c.key === 'cid') return '<span class="mono" style="font-size:11px" title="' + esc(v) + '">' + esc(String(v).slice(0, 16)) + '…</span>';
    return esc(String(v));
  }

  function renderReports(ctx, st, scope) {
    const r = rep(st);
    const key = r.kind + '|' + (scope.folderId || '') + '|' + (App.me ? App.me.workspace : '');
    if (r.repKey !== key && !r.repLoading) loadReport(ctx, scope);
    const q = scopeQuery(scope);
    const url = (fmt) => '/api/file-reports/' + enc(r.kind) + '?' + (q ? q + '&' : '') + 'format=' + fmt;
    const head = UI.pagehead('Reports', esc(scopeName(scope)) + (scope.folderId ? ' and its subfolders' : ', every folder') + '. Within your clearance; exports and saved copies are audited.', UI.btn('Dashboard', { icon: 'files', attrs: 'data-frep-goto="dashboard"' }));
    const d = r.repKey === key ? r.report : null;
    const tools = '<div class="frep-tools">' + UI.field('Report', UI.select(KINDS, r.kind, 'data-frep-kind'))
      + '<a class="btn sm" href="' + esc(url('csv')) + '" download data-frep-export="csv">Export CSV</a>'
      + '<a class="btn sm" href="' + esc(url('xlsx')) + '" download data-frep-export="xlsx">Export Excel</a>'
      + (canWrite() ? UI.btn('Save here as CSV', { size: 'sm', attrs: 'data-frep-save="csv"', disabled: !d }) + UI.btn('Save here as Excel', { size: 'sm', attrs: 'data-frep-save="xlsx"', disabled: !d }) : '')
      + '</div>';
    const saved = r.saved ? UI.notice('<b>' + esc(r.saved.name) + '</b> saved in ' + esc(r.saved.where) + ' as ' + esc(r.saved.label) + ' (it is scanned like any upload). Audited file.report.saved.', 'ok', UI.btn('Open it', { size: 'sm', attrs: 'data-frep-open="' + esc(r.saved.id) + '" data-frep-folder="' + esc(r.saved.folderId || '') + '"' }) + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-frep-dismiss' })) : '';
    let body;
    if (r.repError) body = UI.problem('The report could not be loaded', r.repError.message, r.repError.problem && r.repError.problem.trace_id);
    else if (!d) body = UI.notice('Loading…', 'info');
    else {
      const rows = d.rows.slice(0, SHOWN);
      const cols = d.columns.map((c) => (c.type === 'number' || c.type === 'bytes' ? { label: c.title, right: true } : c.title));
      const tableRows = rows.map((row) => d.columns.map((c) => (c.key === 'path' && row.id ? '<button type="button" class="frep-link frep-path" data-frep-open="' + esc(row.id) + '" style="white-space:normal">' + esc(row.path) + '</button>' : c.key === 'path' ? '<span class="frep-path">' + esc(row.path) + '</span>' : cell(c, row[c.key]))));
      body = '<div class="muted" style="font-size:12px">' + esc(d.title) + ': ' + esc(plural(d.rows.length, 'row')) + (d.truncated ? ' (cut at 10,000; narrow the folder)' : '') + '. Highest label listed: ' + esc(d.label) + '.</div>'
        + (d.rows.length > SHOWN ? UI.notice('Showing the first ' + SHOWN + ' rows here; the exports have all ' + fmtNum(d.rows.length) + '.', 'info') : '')
        + UI.table(cols, tableRows, { clickable: false, minWidth: Math.min(1400, 140 * d.columns.length) + 'px', emptyTitle: 'Nothing to report', emptyText: 'No file in this folder matches this report.' });
    }
    return CSS + head + tools + saved + body;
  }

  function openFile(ctx, st, id, folderId) {
    st.view = 'folder'; st.folder = folderId || null; st.sel = id; st.query = ''; st.tagFilter = null; st.results = null; st.loaded = false; st.detail = null;
    ctx.rerender();
  }

  App.filesReports = {
    render(ctx, st, scope) { return st.view === 'reports' ? renderReports(ctx, st, scope) : renderDashboard(ctx, st, scope); },
    wire(ctx, st, scope) {
      const r = rep(st);
      ctx.on('click', '[data-frep-goto]', (e, t) => { st.view = t.dataset.frepGoto; ctx.rerender(); });
      ctx.on('click', '[data-frep-refresh]', () => { r.sumKey = null; r.summary = null; ctx.rerender(); });
      ctx.on('click', '[data-frep-report]', (e, t) => { r.kind = t.dataset.frepReport; r.repKey = null; st.view = 'reports'; ctx.rerender(); });
      ctx.on('click', '[data-frep-tag]', (e, t) => { st.view = 'folder'; st.tagFilter = t.dataset.frepTag; st.query = ''; st.loaded = false; ctx.rerender(); });
      ctx.on('click', '[data-frep-open]', (e, t) => {
        const id = t.dataset.frepOpen; const folder = t.dataset.frepFolder;
        if (folder !== undefined && folder !== '') { openFile(ctx, st, id, folder); return; }
        if (folder === '' && t.hasAttribute('data-frep-folder')) { openFile(ctx, st, id, null); return; }
        App.get('/api/files/' + enc(id)).then((f) => openFile(ctx, st, id, f.folderId)).catch((err) => App.fail(err, 'Could not open the file'));
      });
      ctx.on('change', '[data-frep-kind]', (e, t) => { r.kind = t.value; r.repKey = null; r.report = null; r.saved = null; ctx.rerender(); });
      ctx.on('click', '[data-frep-export]', (e, t) => ctx.toast('Exporting ' + esc((KINDS.find((k) => k.value === r.kind) || {}).label || r.kind) + ' as ' + (t.dataset.frepExport === 'csv' ? 'CSV' : 'Excel') + '. Audited file.report.exported.', 'ok'));
      ctx.on('click', '[data-frep-dismiss]', () => { r.saved = null; ctx.rerender(); });
      ctx.on('click', '[data-frep-save]', async (e, t) => {
        const fmt = t.dataset.frepSave; t.disabled = true;
        try {
          const out = await App.post('/api/file-reports/' + enc(r.kind) + '/save', scope.folderId ? { folderId: scope.folderId, format: fmt } : { format: fmt });
          r.saved = { id: out.id, name: out.name, label: out.label, folderId: out.folderId, where: scope.folderId ? scope.folderName : scope.workspaceName };
          ctx.toast(esc(out.name) + ' saved (202). Audited file.report.saved.', 'ok');
          rerender(ctx);
        } catch (err) { t.disabled = false; App.fail(err, 'Could not save the report'); }
      });
    }
  };
})();
