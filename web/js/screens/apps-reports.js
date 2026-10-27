// Apps, the Reports tab (1.8.0, Sprint 44, B-122): reports over an entity (with a shared saved view and filters), a
// saved connection query or a REST endpoint; typed parameters bound into the source; a table, a grouped table with
// subtotals and a grand total, or a cross-tab; computed columns in the formula language; sorting; conditional
// formatting shown with colour plus a symbol and words; a title, notes and a page setup for PDF. Every run is the
// viewer's own: their row policies, masks and clearance apply, and totals count only rows they may read.
// apps.js calls App.appsReports(ctx, app, deps) for the tab and App.appsReportsCount(st, app) for its count; the
// designer (apps:design) previews the first 200 rows live. State lives in ctx.state.rp.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const ICON = { none: '', up: '▲', down: '▼', warn: '⚠', check: '✓', flag: '⚑', dot: '●' };
  const ICON_WORD = { none: 'No symbol', up: 'Up', down: 'Down', warn: 'Warning', check: 'Check', flag: 'Flag', dot: 'Dot' };
  const STYLE_WORD = { good: 'Good', warn: 'Warning', bad: 'Attention', info: 'Note', muted: 'Low', strong: 'Key' };
  const RULE_WORD = { gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most', eq: 'equals', ne: 'is not', between: 'between', contains: 'contains', empty: 'is empty', notEmpty: 'is not empty' };
  const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'startsWith', 'exists'];
  const FILTER_WORD = { eq: 'equals', ne: 'is not', gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most', in: 'is one of', contains: 'contains', startsWith: 'starts with', exists: 'has a value' };
  const AGG = ['count', 'sum', 'avg', 'min', 'max'];
  const AGG_WORD = { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum' };
  const LAYOUT_WORD = { table: 'Table', grouped: 'Grouped with totals', crosstab: 'Cross-tab' };
  const SOURCE_WORD = { entity: 'Entity records', query: 'Saved query', rest: 'REST endpoint' };
  const PARAM_TYPES = ['text', 'number', 'date', 'boolean', 'choice'];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const CSS = '#main .apps-rp{display:flex;flex-direction:column;gap:12px;min-width:0}'
    + '#main .apps-rp .rp-grid{display:grid;grid-template-columns:minmax(0,230px) minmax(0,1fr);gap:12px;align-items:start;min-width:0}'
    + '@media (max-width:900px){#main .apps-rp .rp-grid{grid-template-columns:minmax(0,1fr)}}'
    + '#main .apps-rp .rp-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;min-width:0}'
    + '#main .apps-rp .rp-main{display:flex;flex-direction:column;gap:12px;min-width:0}'
    + '#main .apps-rp .rp-params{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;min-width:0}#main .apps-rp .rp-params .field{min-width:0;flex:1 1 160px;max-width:100%}'
    + '#main .apps-rp .rp-row{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;padding:6px 0;border-bottom:1px solid var(--line);min-width:0}'
    + '#main .apps-rp .rp-row .field{min-width:0;flex:1 1 120px;max-width:100%;margin:0}#main .apps-rp .rp-row .field.wide{flex:3 1 220px}'
    + '#main .apps-rp .rp-cols{display:flex;flex-wrap:wrap;gap:4px 14px;min-width:0}'
    + '#main .apps-rp .rp-res td.num,#main .apps-rp .rp-res th.num{text-align:right;font-variant-numeric:tabular-nums}'
    + '#main .apps-rp .rp-res tr.rp-group th{background:var(--panel2);text-align:left;font-weight:600}'
    + '#main .apps-rp .rp-res tr.rp-subtotal td,#main .apps-rp .rp-res tr.rp-subtotal th,#main .apps-rp .rp-res tr.rp-total td,#main .apps-rp .rp-res tr.rp-total th{font-weight:600;background:var(--panel2)}'
    + '#main .apps-rp .rp-res tr.rp-total td,#main .apps-rp .rp-res tr.rp-total th{border-top:2px solid var(--fg)}'
    + '#main .apps-rp .rp-res th[scope=row]{text-align:left;font-weight:600}'
    + '#main .apps-rp .rp-masked{color:var(--muted);font-style:italic}'
    + '#main .apps-rp .rp-f{border-radius:4px;padding:0 4px;white-space:nowrap}#main .apps-rp .rp-f-good{background:var(--ok-bg);color:var(--ok-fg)}#main .apps-rp .rp-f-warn{background:var(--warn-bg);color:var(--warn-fg)}'
    + '#main .apps-rp .rp-f-bad{background:var(--danger-bg);color:var(--danger-fg)}#main .apps-rp .rp-f-info{background:var(--info-bg);color:var(--info-fg)}#main .apps-rp .rp-f-muted{color:var(--muted)}#main .apps-rp .rp-f-strong{font-weight:700}'
    + '#main .apps-rp .rp-ft{font-size:11px;margin-left:4px;color:var(--fg2)}'
    + '#main .apps-rp .rp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}'
    + '#main .apps-rp h2{font-size:16px;margin:0;overflow-wrap:anywhere}#main .apps-rp .rp-notes{white-space:pre-wrap;margin:0;color:var(--fg2);overflow-wrap:anywhere}'
    + '#main .inspector .rp-runs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}#main .inspector .rp-runs li{font-size:12px;min-width:0;overflow-wrap:anywhere}';

  const R = (app) => '/api/apps/' + enc(app.id) + '/reports';
  const detailOf = (err) => (err && ((err.problem && (err.problem.detail || err.problem.title)) || err.message)) || 'Something went wrong.';
  const traceOf = (err) => (err && err.problem && err.problem.traceId) || '';
  const rpOf = (st) => st.rp || (st.rp = {});
  const when = (ms) => { try { return new Date(ms).toLocaleString(); } catch (e) { return String(ms); } };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let previewTimer = null;

  function reset(rp, app) {
    Object.keys(rp).forEach((k) => delete rp[k]);
    Object.assign(rp, { app: app.id, list: null, busy: false, err: null, sel: null, mode: 'run', model: null, params: {}, result: null, runErr: null, running: false, runs: null, runsFor: null, exports: null, exBusy: false, preview: null, previewErr: null, previewBusy: false, views: {}, queries: null, rests: null, knownCols: [] });
  }

  // ---------- data ----------

  function load(ctx, app, deps) {
    const rp = rpOf(ctx.state);
    if (rp.busy) return;
    rp.busy = true;
    App.get(R(app))
      .then((d) => { rp.list = d; rp.err = null; if (rp.sel && !d.reports.some((r) => r.id === rp.sel)) rp.sel = null; if (!rp.sel && d.reports.length && rp.mode === 'run') rp.sel = d.reports[0].id; })
      .catch((err) => { rp.err = err; })
      .finally(() => { rp.busy = false; deps.refresh(); });
  }
  function loadRuns(ctx, app, rep, deps) {
    const rp = rpOf(ctx.state);
    rp.runsFor = rep.id; rp.runs = null;
    App.get(R(app) + '/' + enc(rep.id) + '/runs').then((d) => { if (rp.runsFor === rep.id) rp.runs = d.runs; }).catch(() => { if (rp.runsFor === rep.id) rp.runs = []; }).finally(() => deps.refresh());
  }
  function loadExports(ctx, app, deps) {
    const rp = rpOf(ctx.state);
    if (rp.exBusy) return;
    rp.exBusy = true;
    App.get('/api/apps/' + enc(app.id) + '/exports').then((d) => { rp.exports = d.exports; }).catch(() => { rp.exports = []; }).finally(() => { rp.exBusy = false; deps.refresh(); });
  }
  function loadViews(ctx, app, entName, deps) {
    const rp = rpOf(ctx.state);
    const ent = app.entities.find((e) => e.name === entName);
    if (!ent || rp.views[ent.name]) return;
    rp.views[ent.name] = { list: [] };
    App.get('/api/apps/' + enc(app.id) + '/entities/' + enc(ent.id) + '/views').then((d) => { rp.views[ent.name] = { list: d.views.filter((v) => v.shared) }; }).catch(() => { rp.views[ent.name] = { list: [] }; }).finally(() => deps.refresh());
  }
  function loadSources(ctx, deps) {
    const rp = rpOf(ctx.state);
    if (rp.queries || !App.can('connections:query')) return;
    rp.queries = []; rp.rests = [];
    Promise.all([App.get('/api/connection-queries').catch(() => []), App.get('/api/rest-connections').catch(() => [])]).then(([q, r]) => { rp.queries = q || []; rp.rests = r || []; deps.refresh(); });
  }

  // ---------- the result table ----------

  function fmtNumber(v, col) {
    if (col && col.decimals != null) return v.toFixed(col.decimals);
    return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  function cellText(c, col) {
    if (c.v === null || c.v === undefined) return '';
    if (typeof c.v === 'number') return fmtNumber(c.v, col);
    if (typeof c.v === 'boolean') return c.v ? 'Yes' : 'No';
    const s = String(c.v);
    if (col && col.type === 'datetime' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 10) + ' ' + s.slice(11, 16);
    return s;
  }
  function cellHtml(res, c, col) {
    if (!c) return '<td></td>';
    const num = col && col.type === 'number' && !c.masked;
    if (c.masked) {
      const t = c.v === null || c.v === undefined ? 'masked' : String(c.v);
      return '<td class="rp-masked">' + esc(t) + '<span class="rp-sr"> (masked for you)</span></td>';
    }
    const text = esc(cellText(c, col));
    const f = c.fmt != null ? res.formats[c.fmt] : null;
    if (!f) return '<td' + (num ? ' class="num"' : '') + '>' + text + '</td>';
    const words = f.text || STYLE_WORD[f.style] || '';
    return '<td' + (num ? ' class="num"' : '') + '><span class="rp-f rp-f-' + esc(f.style) + '">' + (ICON[f.icon] ? '<span aria-hidden="true">' + ICON[f.icon] + '</span> ' : '') + text + '</span><span class="rp-ft">' + esc(words) + '</span></td>';
  }
  /** A report result as one accessible table: group headers as row-group headers, subtotal and total rows marked. */
  function resultTable(res, caption) {
    const group = res.layout === 'grouped';
    const span = res.columns.length + (group ? 1 : 0);
    const head = '<tr>' + (group ? '<th scope="col">Group</th>' : '') + res.columns.map((c) => '<th scope="col"' + (c.type === 'number' ? ' class="num"' : '') + '>' + esc(c.title) + (c.masked ? '<span class="rp-sr"> (masked)</span>' : '') + '</th>').join('') + '</tr>';
    const rows = res.lines.map((l) => {
      if (l.kind === 'group') return '<tr class="rp-group"><th scope="rowgroup" colspan="' + span + '" style="padding-left:' + (8 + l.level * 16) + 'px">' + esc(l.label || '') + ' <span class="muted" style="font-weight:400">' + (l.count || 0) + ' row' + (l.count === 1 ? '' : 's') + '</span></th></tr>';
      const lead = group ? (l.kind === 'row' ? '<td></td>' : '<th scope="row" style="padding-left:' + (8 + l.level * 16) + 'px">' + esc(l.label || '') + '</th>') : '';
      return '<tr class="rp-' + l.kind + '">' + lead + res.columns.map((col, i) => cellHtml(res, l.cells[i], col)).join('') + '</tr>';
    }).join('');
    return '<div class="tablewrap"><table class="dt rp-res"><caption class="rp-sr">' + esc(caption) + '</caption><thead>' + head + '</thead><tbody>' + (rows || '<tr><td colspan="' + span + '" class="muted">No rows.</td></tr>') + '</tbody></table></div>';
  }
  function summary(res) {
    const parts = [res.rowsRead + ' source row' + (res.rowsRead === 1 ? '' : 's') + ' read', res.lines.length + ' line' + (res.lines.length === 1 ? '' : 's')];
    if (res.columnsFolded) parts.push(res.columnsFolded + ' column value' + (res.columnsFolded === 1 ? '' : 's') + ' added up as Other');
    const masked = res.columns.filter((c) => c.masked).map((c) => c.title);
    return '<p class="muted" role="status" style="margin:0;font-size:12px">' + esc(parts.join(', ')) + '. ' + (masked.length ? 'Masked for you: ' + esc(masked.join(', ')) + '. ' : '') + '</p>'
      + (res.truncated ? UI.notice('Truncated: more rows matched than the report reads (' + res.rowCap + '). Totals cover the rows read.', 'warn') : '');
  }

  // ---------- the run view ----------

  function paramInput(p, value) {
    const id = 'data-rp-param="' + esc(p.name) + '"';
    const label = p.title || p.name;
    if (p.type === 'boolean') return '<div class="field">' + UI.check(label, value === true || value === 'true', id) + '</div>';
    if (p.type === 'choice') return UI.field(label + (p.required ? ' (required)' : ''), UI.select([{ value: '', label: 'Default' + (p.default != null ? ' (' + p.default + ')' : '') }].concat((p.options || []).map((o) => ({ value: o, label: o }))), value == null ? '' : String(value), id));
    return UI.field(label + (p.required ? ' (required)' : ''), UI.input(value == null ? '' : String(value), { type: p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text', placeholder: p.default != null ? 'Default ' + p.default : '', attrs: id + ' autocomplete="off"' }));
  }
  function paramsFrom(rep, rp) {
    const out = {};
    for (const p of rep.definition.parameters || []) {
      const v = rp.params[p.name];
      if (v === undefined || v === '') continue;
      out[p.name] = v;
    }
    return out;
  }

  function runView(ctx, app, rep, rp, deps) {
    const d = rep.definition;
    const pills = UI.pill(SOURCE_WORD[rep.sourceKind] || rep.sourceKind, 'outline') + ' ' + UI.pill(LAYOUT_WORD[d.layout.kind] || d.layout.kind, 'outline') + ' ' + UI.label(rep.label, { sm: true });
    const actions = '<div class="hstack wrap gap6">'
      + (rep.canRun ? UI.btn('Run', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-rp-run' }) : '')
      + (rep.canRun && App.appsExport ? UI.btn('Export', { size: 'sm', icon: 'download', attrs: 'data-rp-export' }) : '')
      + (App.appsSubscribeButton && rep.canRun ? App.appsSubscribeButton({ app: app.id, appTitle: app.title, kind: 'report', id: rep.id, title: d.title, params: paramsFrom(rep, rp) }) : '')
      + (rep.canEdit ? UI.btn('Edit design', { size: 'sm', icon: 'edit', attrs: 'data-rp-edit' }) + UI.btn('Delete', { size: 'sm', kind: 'ghost', attrs: 'data-rp-delete' }) : '')
      + '</div>';
    const params = (d.parameters || []).length ? '<form class="rp-params" data-rp-form aria-label="Parameters of ' + esc(d.title) + '">' + d.parameters.map((p) => paramInput(p, rp.params[p.name])).join('') + '</form>' : '';
    const needs = !rep.canRun ? UI.notice('This report reads a ' + (rep.sourceKind === 'query' ? 'saved query' : 'REST endpoint') + ' as the person running it, which needs the connections:query right. Ask an administrator for it.', 'warn') : '';
    let result = '';
    if (rp.running) result = UI.notice('Running as you…', 'info');
    else if (rp.runErr) result = UI.problem('The report did not run', detailOf(rp.runErr), traceOf(rp.runErr));
    else if (rp.result && rp.resultFor === rep.id) result = summary(rp.result) + resultTable(rp.result, d.title + ', result');
    else result = '<p class="muted" style="margin:0">Run the report to see its result. It reads the rows you may read, now.</p>';
    return '<section class="panel rp-main" aria-labelledby="rp-title"><div class="hstack wrap gap6" style="justify-content:space-between"><h2 id="rp-title">' + esc(d.title) + '</h2><span class="hstack wrap gap6">' + pills + '</span></div>'
      + (d.notes ? '<p class="rp-notes">' + esc(d.notes) + '</p>' : '')
      + actions + needs + params + '<div data-rp-result>' + result + '</div></section>';
  }

  function inspector(app, rep, rp) {
    const runs = rp.runsFor === rep.id && rp.runs ? rp.runs : null;
    const runList = runs == null ? '<p class="muted" style="margin:0;font-size:12px">Loading…</p>' : !runs.length ? '<p class="muted" style="margin:0;font-size:12px">You have not run this report yet.</p>'
      : '<ul class="rp-runs">' + runs.slice(0, 15).map((x) => '<li>' + UI.pill(x.state === 'succeeded' ? 'Succeeded' : 'Failed', x.state === 'succeeded' ? 'ok' : 'danger') + ' <span>' + esc(when(x.createdAt)) + '</span><br><span class="muted">'
        + esc(x.state === 'succeeded' ? x.rows + ' rows' + (x.truncated ? ', truncated' : '') + ', ' + x.ms + ' ms' : (x.error || '')) + (x.params && Object.keys(x.params).length ? ', ' + Object.keys(x.params).map((k) => k + ' ' + (x.params[k] === null ? 'default' : x.params[k])).join(', ') : '') + '</span>'
        + (x.cached ? '<br>' + UI.btn('Open result', { size: 'xs', attrs: 'data-rp-openrun="' + esc(x.id) + '" aria-label="Open the result of the run at ' + esc(when(x.createdAt)) + '"' }) : '') + '</li>').join('') + '</ul>';
    return '<aside class="inspector w300" aria-label="Report history and exports"><div class="eyebrow">Your runs</div>' + runList
      + '<p class="muted" style="margin:0;font-size:11px">Results are kept, sealed, for ' + rep.definition.cacheMinutes + ' minutes and only for you.</p>'
      + '<div class="eyebrow" style="margin-top:12px">Your exports of this app</div>' + (App.appsExport ? App.appsExport.list(rp.exports || [], app) : '') + '</aside>';
  }

  // ---------- the designer ----------

  function blank(app) {
    const ent = app.entities[0];
    return { name: '', label: '', isNew: true, version: null, def: { title: 'New report', notes: '', source: { kind: 'entity', entity: ent ? ent.name : '', view: null, filters: [], filterMode: 'and', q: '', state: null }, srcParams: [], parameters: [], columns: [], computed: [], layout: { kind: 'table' }, sort: [], formatting: [], page: { size: 'a4', orientation: 'portrait', breakGroups: false }, rowCap: 10000, cacheMinutes: 15 } };
  }
  function modelOf(rep) {
    const def = clone(rep.definition);
    def.srcParams = def.source.kind !== 'entity' ? Object.entries(def.source.params || {}).map(([k, v]) => ({ k, v: v && typeof v === 'object' ? '$' + v.param : String(v) })) : [];
    def.columns = (def.columns || []).map((c) => c.key);
    if (def.source.kind === 'entity') def.source.filters = (def.source.filters || []).map((f) => Object.assign({}, f, { value: showVal(f.value) }));
    def.formatting = (def.formatting || []).map((r) => Object.assign({}, r, { value: r.value == null ? '' : String(r.value), value2: r.value2 == null ? '' : String(r.value2), text: r.text || '' }));
    def.parameters = (def.parameters || []).map((p) => Object.assign({}, p, { title: p.title || '', default: p.default == null ? '' : String(p.default), options: (p.options || []).join(', ') }));
    return { name: rep.name, label: rep.label, isNew: false, version: rep.version, id: rep.id, def };
  }
  function showVal(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return '$' + v.param;
    if (Array.isArray(v)) return v.join(', ');
    return v == null ? '' : String(v);
  }
  function fieldOf(app, entName, name) { const e = app.entities.find((x) => x.name === entName); return e ? (e.definition.fields || []).find((f) => f.name === name) : null; }
  function parseFilterValue(app, entName, f) {
    const t = String(f.value == null ? '' : f.value).trim();
    if (f.op === 'exists') return t === 'false' ? false : undefined;
    if (t.charAt(0) === '$' && /^\$[a-z][a-z0-9_]*$/.test(t)) return { param: t.slice(1) };
    const fd = fieldOf(app, entName, f.field);
    const one = (x) => (fd && fd.type === 'number' && x !== '' && !isNaN(Number(x)) ? Number(x) : fd && fd.type === 'boolean' ? x === 'true' : x);
    if (f.op === 'in') return t.split(',').map((x) => x.trim()).filter(Boolean).map(one);
    return one(t);
  }
  const numOr = (v) => (v === '' || v == null || isNaN(Number(v)) ? v : Number(v));
  /** The model as the API's report definition (unknown keys would be refused). */
  function toDefinition(app, m) {
    const d = m.def;
    const src = d.source.kind === 'entity'
      ? { kind: 'entity', entity: d.source.entity, view: d.source.view || null, filters: (d.source.filters || []).filter((f) => f.field).map((f) => { const v = parseFilterValue(app, d.source.entity, f); return v === undefined ? { field: f.field, op: f.op } : { field: f.field, op: f.op, value: v }; }), filterMode: d.source.filterMode || 'and', q: d.source.q || '', state: d.source.state || null }
      : Object.assign({ kind: d.source.kind }, d.source.kind === 'query' ? { query: d.source.query || '' } : { connection: d.source.connection || '', endpoint: d.source.endpoint || '' }, { params: (d.srcParams || []).filter((x) => x.k).reduce((o, x) => { const t = String(x.v || '').trim(); o[x.k] = /^\$[a-z][a-z0-9_]*$/.test(t) ? { param: t.slice(1) } : numOr(t); return o; }, {}) });
    const layout = d.layout.kind === 'grouped' ? { kind: 'grouped', groupBy: (d.layout.groupBy || []).filter(Boolean), aggregates: (d.layout.aggregates || []).map((a) => (a.op === 'count' ? { op: 'count' } : { op: a.op, column: a.column || '' })), subtotals: d.layout.subtotals !== false, grandTotal: d.layout.grandTotal !== false }
      : d.layout.kind === 'crosstab' ? { kind: 'crosstab', rows: (d.layout.rows || []).filter(Boolean), column: d.layout.column || '', values: (d.layout.values || []).map((a) => (a.op === 'count' ? { op: 'count' } : { op: a.op, column: a.column || '' })), rowTotals: d.layout.rowTotals !== false, columnTotals: d.layout.columnTotals !== false, maxColumns: Number(d.layout.maxColumns) || 20 }
        : { kind: 'table' };
    return {
      title: (d.title || '').trim() || 'Untitled report',
      notes: d.notes || '',
      source: src,
      parameters: (d.parameters || []).filter((p) => p.name).map((p) => { const o = { name: p.name, type: p.type || 'text', required: !!p.required }; if (p.title) o.title = p.title; if (p.default !== '' && p.default != null) o.default = p.type === 'number' ? numOr(p.default) : p.type === 'boolean' ? p.default === 'true' : p.default; if (p.type === 'choice') o.options = String(p.options || '').split(',').map((x) => x.trim()).filter(Boolean); return o; }),
      columns: (d.columns || []).map((k) => ({ key: k })),
      computed: (d.computed || []).filter((c) => c.name && c.formula).map((c) => (c.title ? { name: c.name, title: c.title, formula: c.formula } : { name: c.name, formula: c.formula })),
      layout,
      sort: (d.sort || []).filter((x) => x.column).map((x) => ({ column: x.column, dir: x.dir === 'desc' ? 'desc' : 'asc' })),
      formatting: (d.formatting || []).filter((r) => r.column).map((r) => { const o = { column: r.column, when: r.when, style: r.style, icon: r.icon || 'none' }; if (r.when !== 'empty' && r.when !== 'notEmpty' && r.value !== '') o.value = numOr(r.value); if (r.when === 'between' && r.value2 !== '' && !isNaN(Number(r.value2))) o.value2 = Number(r.value2); if (r.text) o.text = r.text; return o; }),
      page: { size: d.page.size, orientation: d.page.orientation, breakGroups: !!d.page.breakGroups },
      rowCap: Math.max(1, Math.min(50000, Number(d.rowCap) || 10000)),
      cacheMinutes: Math.max(0, Math.min(1440, Number(d.cacheMinutes) || 0))
    };
  }
  /** The columns the designer offers: the entity's fields and the record's own columns, or what a preview showed. */
  function columnsFor(app, m, rp) {
    const d = m.def;
    let base = [];
    if (d.source.kind === 'entity') {
      const e = app.entities.find((x) => x.name === d.source.entity);
      if (e) base = (e.definition.fields || []).filter((f) => f.type !== 'relation').map((f) => ({ key: f.name, title: f.title || f.name })).concat(e.definition.states ? [{ key: 'state', title: 'State' }] : []).concat([{ key: 'id', title: 'Id' }, { key: 'label', title: 'Label' }, { key: 'createdAt', title: 'Created' }, { key: 'updatedAt', title: 'Updated' }]);
    } else base = (rp.knownCols || []).map((k) => ({ key: k, title: k }));
    return base.concat((d.computed || []).filter((c) => c.name).map((c) => ({ key: c.name, title: (c.title || c.name) + ' (computed)' })));
  }
  function setPath(obj, path, v) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { const k = /^\d+$/.test(parts[i]) ? +parts[i] : parts[i]; if (o[k] == null) o[k] = /^\d+$/.test(parts[i + 1]) ? [] : {}; o = o[k]; }
    const last = /^\d+$/.test(parts[parts.length - 1]) ? +parts[parts.length - 1] : parts[parts.length - 1];
    o[last] = v;
  }
  const f = (label, control, cls) => { const h = UI.field(label, control); return cls ? h.replace('<div class="field"', '<div class="field ' + cls + '"') : h; };
  const inp = (path, value, o) => UI.input(value == null ? '' : String(value), { type: (o && o.type) || 'text', placeholder: (o && o.ph) || '', attrs: 'data-rp-f data-path="' + esc(path) + '"' + (o && o.kind ? ' data-kind="' + o.kind + '"' : '') + (o && o.list ? ' list="' + o.list + '"' : '') + ' autocomplete="off"' + (o && o.attrs ? ' ' + o.attrs : '') });
  const sel = (path, options, value, struct, kind) => UI.select(options, value == null ? '' : String(value), 'data-rp-f data-path="' + esc(path) + '"' + (struct ? ' data-struct' : '') + (kind ? ' data-kind="' + kind + '"' : ''));
  const del = (path, what) => UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-rp-del="' + esc(path) + '" aria-label="Remove ' + esc(what) + '"' });
  const add = (path, what) => UI.btn('Add ' + what, { size: 'xs', icon: 'plus', attrs: 'data-rp-add="' + esc(path) + '"' });
  const colPick = (path, value, cols, label, allowNone) => f(label, sel(path, (allowNone ? [{ value: '', label: 'Choose a column' }] : []).concat(cols.map((c) => ({ value: c.key, label: c.title }))).concat(value && !cols.some((c) => c.key === value) ? [{ value, label: value }] : []), value, false));

  function designer(ctx, app, rp) {
    const m = rp.model;
    const d = m.def;
    const cols = columnsFor(app, m, rp);
    const ent = d.source.kind === 'entity' ? app.entities.find((e) => e.name === d.source.entity) : null;
    const views = ent && rp.views[ent.name] ? rp.views[ent.name].list : [];
    const queryOk = App.can('connections:query');
    const sources = [{ value: 'entity', label: SOURCE_WORD.entity }].concat(queryOk ? [{ value: 'query', label: SOURCE_WORD.query }, { value: 'rest', label: SOURCE_WORD.rest }] : []);
    const paramNames = (d.parameters || []).filter((p) => p.name).map((p) => '$' + p.name);

    const basics = UI.panel('Report', '<div class="formgrid">'
      + (m.isNew ? f('Name (its handle in the app)', inp('name', m.name, { ph: 'lower-case letters, digits and _' })) : f('Name', '<input class="input" value="' + esc(m.name) + '" readonly aria-readonly="true">'))
      + f('Title', inp('def.title', d.title))
      + f('Label', sel('label', [{ value: '', label: 'The lowest the source allows' }].concat(LABELS.map((l) => ({ value: l, label: l }))), m.label, false))
      + '</div>' + f('Notes (shown above the result and in the PDF)', UI.textarea(d.notes || '', { rows: 2, attrs: 'data-rp-f data-path="def.notes"' })));

    let srcBody = '<div class="formgrid">' + f('Read from', sel('def.source.kind', sources, d.source.kind, true));
    if (d.source.kind === 'entity') {
      srcBody += f('Entity', sel('def.source.entity', app.entities.map((e) => ({ value: e.name, label: e.title || e.name })), d.source.entity, true))
        + f('Shared saved view (optional)', sel('def.source.view', [{ value: '', label: 'None: the entity\'s records' }].concat(views.map((v) => ({ value: v.id, label: v.name }))), d.source.view || '', true, 'nullable'))
        + f('Search (optional)', inp('def.source.q', d.source.q || '', { ph: 'words in indexed text fields' }))
        + (ent && ent.definition.states ? f('State', sel('def.source.state', [{ value: '', label: 'Every state' }].concat(ent.definition.states.states.map((s) => ({ value: s.name, label: s.name }))), d.source.state || '', false, 'nullable')) : '')
        + '</div><div class="eyebrow" style="margin-top:8px">Filters</div><p class="muted" style="margin:0;font-size:12px">Indexed fields only. A value of $name takes a parameter; a filter whose parameter is left empty is left out.' + (paramNames.length ? ' Parameters: ' + esc(paramNames.join(', ')) + '.' : '') + '</p>'
        + (d.source.filters || []).map((x, i) => '<div class="rp-row">' + f('Field', sel('def.source.filters.' + i + '.field', [{ value: '', label: 'Choose a field' }].concat((ent ? ent.definition.fields : []).filter((fd) => fd.indexed || fd.unique).map((fd) => ({ value: fd.name, label: fd.title || fd.name }))).concat([{ value: 'state', label: 'State' }, { value: 'createdAt', label: 'Created' }, { value: 'updatedAt', label: 'Updated' }]), x.field, false))
          + f('Test', sel('def.source.filters.' + i + '.op', FILTER_OPS.map((o) => ({ value: o, label: FILTER_WORD[o] })), x.op, false)) + f('Value or $parameter', inp('def.source.filters.' + i + '.value', x.value), 'wide') + del('def.source.filters.' + i, 'filter ' + (i + 1)) + '</div>').join('')
        + '<div class="hstack wrap gap6" style="margin-top:6px">' + add('def.source.filters', 'filter') + ((d.source.filters || []).length > 1 ? f('Combine', sel('def.source.filterMode', [{ value: 'and', label: 'All filters' }, { value: 'or', label: 'Any filter' }], d.source.filterMode || 'and', false)) : '') + '</div>';
    } else {
      if (d.source.kind === 'query') srcBody += f('Saved query', sel('def.source.query', [{ value: '', label: 'Choose a saved query' }].concat((rp.queries || []).map((q) => ({ value: q.name, label: (q.title || q.name) + ' (' + q.connection + ')' }))), d.source.query || '', true));
      else {
        const conn = (rp.rests || []).find((c) => c.name === d.source.connection);
        srcBody += f('REST connection', sel('def.source.connection', [{ value: '', label: 'Choose a connection' }].concat((rp.rests || []).map((c) => ({ value: c.name, label: c.title || c.name }))), d.source.connection || '', true))
          + f('Endpoint', sel('def.source.endpoint', [{ value: '', label: 'Choose an endpoint' }].concat((conn ? conn.endpoints : []).map((e) => ({ value: e.name, label: e.title || e.name }))), d.source.endpoint || '', true));
      }
      srcBody += '</div><p class="muted" style="margin:6px 0 0;font-size:12px">Runs as the person running the report, who needs connections:query. A value of $name takes a parameter.</p>'
        + (d.srcParams || []).map((x, i) => '<div class="rp-row">' + f('Source parameter', inp('def.srcParams.' + i + '.k', x.k)) + f('Value or $parameter', inp('def.srcParams.' + i + '.v', x.v), 'wide') + del('def.srcParams.' + i, 'source parameter ' + (x.k || i + 1)) + '</div>').join('')
        + '<div style="margin-top:6px">' + add('def.srcParams', 'source parameter') + '</div>';
    }
    const source = UI.panel('Source', srcBody);

    const parameters = UI.panel('Parameters', '<p class="muted" style="margin:0;font-size:12px">Asked for on each run; the default applies when left empty.</p>'
      + (d.parameters || []).map((p, i) => '<div class="rp-row">' + f('Name', inp('def.parameters.' + i + '.name', p.name, { ph: 'region' })) + f('Title', inp('def.parameters.' + i + '.title', p.title)) + f('Type', sel('def.parameters.' + i + '.type', PARAM_TYPES, p.type || 'text', true))
        + f('Default', inp('def.parameters.' + i + '.default', p.default)) + (p.type === 'choice' ? f('Options (comma-separated)', inp('def.parameters.' + i + '.options', p.options), 'wide') : '')
        + '<div class="field">' + UI.check('Required', !!p.required, 'data-rp-f data-path="def.parameters.' + i + '.required" data-kind="bool"') + '</div>' + del('def.parameters.' + i, 'parameter ' + (p.name || i + 1)) + '</div>').join('')
      + '<div style="margin-top:6px">' + add('def.parameters', 'parameter') + '</div>');

    const columns = UI.panel('Columns', '<p class="muted" style="margin:0 0 6px;font-size:12px">The columns shown, in this order; none chosen shows every field.</p>'
      + (cols.length ? '<fieldset class="rp-cols" style="border:0;margin:0;padding:0"><legend class="rp-sr">Columns shown</legend>' + cols.map((c) => UI.check(c.title, (d.columns || []).indexOf(c.key) >= 0, 'data-rp-col="' + esc(c.key) + '"')).join('') + '</fieldset>' : '<p class="muted" style="margin:0;font-size:12px">Preview the report to see the source\'s columns.</p>')
      + '<div class="eyebrow" style="margin-top:10px">Computed columns</div><p class="muted" style="margin:0;font-size:12px">The formula language of formula fields, over the columns above (and computed columns before it).</p>'
      + (d.computed || []).map((c, i) => '<div class="rp-row">' + f('Name', inp('def.computed.' + i + '.name', c.name, { ph: 'margin' })) + f('Title', inp('def.computed.' + i + '.title', c.title || '')) + f('Formula', inp('def.computed.' + i + '.formula', c.formula, { ph: 'amount - cost' }), 'wide') + del('def.computed.' + i, 'computed column ' + (c.name || i + 1)) + '</div>').join('')
      + '<div style="margin-top:6px">' + add('def.computed', 'computed column') + '</div>');

    let layoutBody = '<div class="formgrid">' + f('Layout', sel('def.layout.kind', ['table', 'grouped', 'crosstab'].map((k) => ({ value: k, label: LAYOUT_WORD[k] })), d.layout.kind, true)) + '</div>';
    const aggRows = (key, list) => (list || []).map((a, i) => '<div class="rp-row">' + f('Total', sel('def.layout.' + key + '.' + i + '.op', AGG.map((o) => ({ value: o, label: AGG_WORD[o] })), a.op, true)) + (a.op === 'count' ? '' : colPick('def.layout.' + key + '.' + i + '.column', a.column, cols, 'Of column', true)) + del('def.layout.' + key + '.' + i, (key === 'values' ? 'value ' : 'total ') + (i + 1)) + '</div>').join('');
    if (d.layout.kind === 'grouped') {
      layoutBody += '<div class="eyebrow" style="margin-top:8px">Group by (up to 3)</div>' + (d.layout.groupBy || []).map((g, i) => '<div class="rp-row">' + colPick('def.layout.groupBy.' + i, g, cols, 'Level ' + (i + 1), true) + del('def.layout.groupBy.' + i, 'group level ' + (i + 1)) + '</div>').join('')
        + ((d.layout.groupBy || []).length < 3 ? '<div style="margin-top:6px">' + add('def.layout.groupBy', 'group level') + '</div>' : '')
        + '<div class="eyebrow" style="margin-top:8px">Totals</div>' + aggRows('aggregates', d.layout.aggregates) + '<div style="margin-top:6px">' + add('def.layout.aggregates', 'total') + '</div>'
        + '<div class="hstack wrap gap6" style="margin-top:6px">' + UI.check('Subtotal each group', d.layout.subtotals !== false, 'data-rp-f data-path="def.layout.subtotals" data-kind="bool"') + UI.check('Grand total', d.layout.grandTotal !== false, 'data-rp-f data-path="def.layout.grandTotal" data-kind="bool"') + '</div>';
    } else if (d.layout.kind === 'crosstab') {
      layoutBody += '<div class="eyebrow" style="margin-top:8px">Row fields (up to 3)</div>' + (d.layout.rows || []).map((g, i) => '<div class="rp-row">' + colPick('def.layout.rows.' + i, g, cols, 'Row field ' + (i + 1), true) + del('def.layout.rows.' + i, 'row field ' + (i + 1)) + '</div>').join('')
        + ((d.layout.rows || []).length < 3 ? '<div style="margin-top:6px">' + add('def.layout.rows', 'row field') + '</div>' : '')
        + '<div class="formgrid" style="margin-top:6px">' + colPick('def.layout.column', d.layout.column, cols, 'Column field', true) + f('Distinct columns at most (the rest add up in Other)', inp('def.layout.maxColumns', d.layout.maxColumns == null ? 20 : d.layout.maxColumns, { type: 'number', kind: 'num', attrs: 'min="1" max="50"' })) + '</div>'
        + '<div class="eyebrow" style="margin-top:8px">Values</div>' + aggRows('values', d.layout.values) + ((d.layout.values || []).length < 4 ? '<div style="margin-top:6px">' + add('def.layout.values', 'value') + '</div>' : '')
        + '<div class="hstack wrap gap6" style="margin-top:6px">' + UI.check('Row totals', d.layout.rowTotals !== false, 'data-rp-f data-path="def.layout.rowTotals" data-kind="bool"') + UI.check('Column totals', d.layout.columnTotals !== false, 'data-rp-f data-path="def.layout.columnTotals" data-kind="bool"') + '</div>';
    }
    layoutBody += '<div class="eyebrow" style="margin-top:8px">Sort</div>' + (d.sort || []).map((x, i) => '<div class="rp-row">' + colPick('def.sort.' + i + '.column', x.column, cols, 'Column', true) + f('Order', sel('def.sort.' + i + '.dir', [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], x.dir || 'asc', false)) + del('def.sort.' + i, 'sort ' + (i + 1)) + '</div>').join('')
      + ((d.sort || []).length < 5 ? '<div style="margin-top:6px">' + add('def.sort', 'sort') + '</div>' : '');
    const layout = UI.panel('Layout and sorting', layoutBody);

    const formatting = UI.panel('Conditional formatting', '<p class="muted" style="margin:0;font-size:12px">The first rule that matches a cell styles it, with a symbol and words as well as colour. Masked cells are never formatted.</p>'
      + (d.formatting || []).map((r, i) => '<div class="rp-row">' + colPick('def.formatting.' + i + '.column', r.column, cols.concat([{ key: 'count', title: 'Counts' }]), 'Column', true)
        + f('When', sel('def.formatting.' + i + '.when', Object.keys(RULE_WORD).map((o) => ({ value: o, label: RULE_WORD[o] })), r.when, true))
        + (r.when === 'empty' || r.when === 'notEmpty' ? '' : f('Value', inp('def.formatting.' + i + '.value', r.value)))
        + (r.when === 'between' ? f('And', inp('def.formatting.' + i + '.value2', r.value2, { type: 'number' })) : '')
        + f('Style', sel('def.formatting.' + i + '.style', Object.keys(STYLE_WORD).map((s) => ({ value: s, label: STYLE_WORD[s] })), r.style, false))
        + f('Symbol', sel('def.formatting.' + i + '.icon', Object.keys(ICON_WORD).map((s) => ({ value: s, label: (ICON[s] ? ICON[s] + ' ' : '') + ICON_WORD[s] })), r.icon || 'none', false))
        + f('Words shown', inp('def.formatting.' + i + '.text', r.text, { ph: 'over target', attrs: 'maxlength="40"' })) + del('def.formatting.' + i, 'formatting rule ' + (i + 1)) + '</div>').join('')
      + '<div style="margin-top:6px">' + add('def.formatting', 'rule') + '</div>');

    const page = UI.panel('Page and limits', '<div class="formgrid">'
      + f('Paper', sel('def.page.size', [{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'US Letter' }], d.page.size, false))
      + f('Orientation', sel('def.page.orientation', [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }], d.page.orientation, false))
      + f('Rows read at most', inp('def.rowCap', d.rowCap, { type: 'number', kind: 'num', attrs: 'min="1" max="50000"' }))
      + f('Keep results (minutes, 0 for none)', inp('def.cacheMinutes', d.cacheMinutes, { type: 'number', kind: 'num', attrs: 'min="0" max="1440"' }))
      + '</div>' + (d.layout.kind === 'grouped' ? UI.check('PDF: a new page for each top-level group', !!d.page.breakGroups, 'data-rp-f data-path="def.page.breakGroups" data-kind="bool"') : ''));

    const preview = '<section class="panel" aria-labelledby="rp-prev-h"><div class="hstack wrap gap6" style="justify-content:space-between"><div class="eyebrow" id="rp-prev-h">Live preview (the first 200 rows, as you)</div>' + UI.btn('Refresh preview', { size: 'xs', icon: 'refresh', attrs: 'data-rp-preview-now' }) + '</div><div data-rp-preview>' + previewHtml(rp) + '</div></section>';
    const bar = '<div class="hstack wrap gap6">' + UI.btn(m.isNew ? 'Create report' : 'Save changes', { kind: 'primary', size: 'sm', attrs: 'data-rp-save' }) + UI.btn('Cancel', { size: 'sm', attrs: 'data-rp-cancel' }) + '<span data-rp-saveerr></span></div>';
    return '<div class="rp-main" role="form" aria-label="' + (m.isNew ? 'New report' : 'Design of ' + esc(d.title)) + '">' + bar + basics + source + parameters + columns + layout + formatting + page + preview + bar.replace('data-rp-saveerr', 'data-rp-saveerr2') + '</div>';
  }
  function previewHtml(rp) {
    if (rp.previewErr) return UI.notice('<b>' + esc(String(rp.previewErr.status || '')) + '</b> ' + esc(detailOf(rp.previewErr)), 'warn');
    if (!rp.preview) return '<p class="muted" style="margin:0">' + (rp.previewBusy ? 'Computing the preview…' : 'The preview appears here as you design.') + '</p>';
    return (rp.previewBusy ? '<p class="muted" role="status" style="margin:0;font-size:12px">Updating…</p>' : '') + summary(rp.preview.result) + resultTable(rp.preview.result, 'Preview');
  }
  function schedulePreview(ctx, app, delay) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => runPreview(ctx, app), delay == null ? 600 : delay);
  }
  function paintPreview(ctx) {
    const el = ctx.$('[data-rp-preview]');
    if (el) { el.innerHTML = previewHtml(rpOf(ctx.state)); if (App.a11yPass) App.a11yPass(el); }
  }
  async function runPreview(ctx, app) {
    const rp = rpOf(ctx.state);
    if (!rp.model || rp.mode !== 'design') return;
    const def = toDefinition(app, rp.model);
    if (def.source.kind === 'query' && !def.source.query) return;
    if (def.source.kind === 'rest' && (!def.source.connection || !def.source.endpoint)) return;
    const stamp = (rp.previewStamp = (rp.previewStamp || 0) + 1);
    rp.previewBusy = true; paintPreview(ctx);
    try {
      const out = await App.post(R(app) + '/preview', { definition: def });
      if (stamp !== rp.previewStamp) return;
      rp.preview = out; rp.previewErr = null;
      // a query's or endpoint's columns, for the column pickers
      if (def.source.kind !== 'entity' && def.layout.kind === 'table' && !def.columns.length) rp.knownCols = out.result.columns.filter((c) => !c.computed).map((c) => c.key);
    } catch (err) { if (stamp !== rp.previewStamp) return; rp.previewErr = err; }
    rp.previewBusy = false;
    paintPreview(ctx);
  }

  const DEFAULTS = {
    'def.source.filters': () => ({ field: '', op: 'eq', value: '' }),
    'def.srcParams': () => ({ k: '', v: '' }),
    'def.parameters': (m) => ({ name: 'p' + ((m.def.parameters || []).length + 1), title: '', type: 'text', default: '', required: false, options: '' }),
    'def.computed': (m) => ({ name: 'calc' + ((m.def.computed || []).length + 1), title: '', formula: '' }),
    'def.layout.groupBy': () => '',
    'def.layout.rows': () => '',
    'def.layout.aggregates': () => ({ op: 'count' }),
    'def.layout.values': () => ({ op: 'count' }),
    'def.sort': () => ({ column: '', dir: 'asc' }),
    'def.formatting': () => ({ column: '', when: 'gt', value: '0', value2: '', style: 'good', icon: 'none', text: '' })
  };
  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[/^\d+$/.test(k) ? +k : k]), obj); }

  // ---------- the tab ----------

  App.appsReportsCount = function (st, app) {
    const rp = st.rp;
    return rp && rp.app === app.id && rp.list ? rp.list.reports.length : null;
  };

  App.appsReports = function (ctx, app, deps) {
    const st = ctx.state; const rp = rpOf(st);
    if (rp.app !== app.id) reset(rp, app);
    if (!rp.list && !rp.err) load(ctx, app, deps);
    if (rp.exports == null) loadExports(ctx, app, deps);
    const style = '<style>' + CSS + '</style>';
    if (rp.err) {
      ctx.on('click', '[data-rp-reload]', () => { rp.err = null; ctx.rerender(); });
      return { body: style + '<div class="apps-rp">' + UI.problem('Reports could not be loaded', detailOf(rp.err), traceOf(rp.err)) + '<div>' + UI.btn('Try again', { attrs: 'data-rp-reload' }) + '</div></div>', inspector: '' };
    }
    if (!rp.list) return { body: style + '<div class="apps-rp">' + UI.notice('Loading reports…', 'info') + '</div>', inspector: '' };
    const reports = rp.list.reports;
    const canDesign = rp.list.canDesign;
    const rep = rp.sel ? reports.find((r) => r.id === rp.sel) : null;
    if (rp.mode === 'run' && rep && rp.runsFor !== rep.id) loadRuns(ctx, app, rep, deps);
    if (rp.mode === 'design' && rp.model) {
      if (rp.model.def.source.kind === 'entity') loadViews(ctx, app, rp.model.def.source.entity, deps); else loadSources(ctx, deps);
      if (!rp.preview && !rp.previewErr && !rp.previewBusy) schedulePreview(ctx, app, 50);
    }

    const list = '<nav aria-label="Reports of ' + esc(app.title || app.name) + '"><ul class="rp-list">' + (reports.length ? reports.map((r) => '<li>' + UI.listItem(esc(r.title), esc(SOURCE_WORD[r.sourceKind] + ', ' + (LAYOUT_WORD[r.definition.layout.kind] || '')), { active: rp.mode === 'run' && r.id === rp.sel, attrs: 'data-rp-sel="' + esc(r.id) + '"' + (rp.mode === 'run' && r.id === rp.sel ? ' aria-current="true"' : '') }) + '</li>').join('') : '<li class="muted" style="font-size:12px">No reports yet.</li>') + '</ul></nav>';
    const head = '<div class="hstack wrap gap6" style="justify-content:space-between"><p class="muted" style="margin:0;font-size:12px;flex:1 1 240px;min-width:0">A report reads its source as the person running it: their policies, masks and clearance apply, and totals count only the rows they may read.</p>' + (canDesign ? UI.btn('New report', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-rp-new' }) : '') + '</div>';
    let main;
    let insp = '';
    if (rp.mode === 'design' && rp.model) main = designer(ctx, app, rp);
    else if (rep) { main = runView(ctx, app, rep, rp, deps); insp = inspector(app, rep, rp); }
    else main = UI.empty('No report selected', reports.length ? 'Choose a report to run it.' : canDesign ? 'Create a report: a table, a grouped table with totals or a cross-tab over this app\'s records, a saved query or a REST endpoint.' : 'No report has been designed for this app yet.', canDesign && !reports.length ? UI.btn('New report', { kind: 'primary', attrs: 'data-rp-new' }) : '');
    const body = style + '<div class="apps-rp">' + head + '<div class="rp-grid">' + list + main + '</div></div>';

    // ----- events -----
    const rerenderFocus = (selector) => { ctx.rerender(); const el = selector && ctx.$(selector); if (el) el.focus(); };
    ctx.on('click', '[data-rp-sel]', (e, t) => { rp.mode = 'run'; rp.sel = t.dataset.rpSel; rp.result = null; rp.runErr = null; rp.params = {}; rerenderFocus('[data-rp-sel="' + t.dataset.rpSel + '"]'); });
    ctx.on('click', '[data-rp-new]', () => { rp.mode = 'design'; rp.model = blank(app); rp.preview = null; rp.previewErr = null; rerenderFocus('[data-path="name"]'); });
    ctx.on('click', '[data-rp-edit]', () => { if (!rep) return; rp.mode = 'design'; rp.model = modelOf(rep); rp.preview = null; rp.previewErr = null; rerenderFocus('[data-path="def.title"]'); });
    ctx.on('click', '[data-rp-cancel]', () => { rp.mode = 'run'; rp.model = null; clearTimeout(previewTimer); rerenderFocus(rp.sel ? '[data-rp-sel="' + rp.sel + '"]' : '[data-rp-new]'); });
    ctx.on('change', '[data-rp-param]', (e, t) => { rp.params[t.dataset.rpParam] = t.type === 'checkbox' ? t.checked : t.value; });
    ctx.on('input', '[data-rp-param]', (e, t) => { if (t.type !== 'checkbox') rp.params[t.dataset.rpParam] = t.value; });
    ctx.on('submit', '[data-rp-form]', (e) => { e.preventDefault(); const b = ctx.$('[data-rp-run]'); if (b) b.click(); });
    ctx.on('click', '[data-rp-run]', async () => {
      if (!rep) return;
      rp.running = true; rp.runErr = null; ctx.rerender();
      try {
        const out = await App.post(R(app) + '/' + enc(rep.id) + '/run', { params: paramsFrom(rep, rp) });
        rp.result = out.result; rp.resultFor = rep.id;
        ctx.toast('Ran ' + esc(rep.definition.title) + ': ' + out.run.rows + ' rows' + (out.run.truncated ? ', truncated' : '') + '. Audited app.report.run.', 'ok');
      } catch (err) { rp.runErr = err; }
      rp.running = false; rp.runsFor = null;
      rerenderFocus('[data-rp-run]');
    });
    ctx.on('click', '[data-rp-openrun]', async (e, t) => {
      if (!rep) return;
      try { const out = await App.get(R(app) + '/' + enc(rep.id) + '/runs/' + enc(t.dataset.rpOpenrun)); rp.result = out.result; rp.resultFor = rep.id; rp.runErr = null; rp.params = Object.assign({}, out.run.params || {}); Object.keys(rp.params).forEach((k) => { if (rp.params[k] === null) delete rp.params[k]; }); rerenderFocus('[data-rp-run]'); ctx.toast('Showing the kept result of the run at ' + esc(when(out.run.createdAt)) + '.', 'info'); }
      catch (err) { App.fail(err, 'The result could not be opened'); rp.runsFor = null; ctx.rerender(); }
    });
    ctx.on('click', '[data-rp-export]', () => {
      if (!rep || !App.appsExport) return;
      App.appsExport.open(ctx, { app, kind: 'report', id: rep.id, title: rep.definition.title, params: paramsFrom(rep, rp), rows: rp.result && rp.resultFor === rep.id ? rp.result.rowsRead : null, deps, onQueued: () => { rp.exports = null; } });
    });
    ctx.on('click', '[data-rp-delete]', async () => {
      if (!rep) return;
      const ok = await ctx.confirm({ title: 'Delete the report ' + rep.definition.title, tone: 'danger', body: '<p class="fg2" style="margin:0">The design and its run history go; the records are not touched.</p>', kv: [['Report', esc(rep.name)]], ok: 'Delete report' });
      if (!ok) return;
      try { await App.del(R(app) + '/' + enc(rep.id)); rp.sel = null; rp.list = null; rp.result = null; ctx.toast('Deleted the report ' + esc(rep.definition.title) + '. Audited app.report.deleted.', 'warn'); ctx.rerender(); }
      catch (err) { App.fail(err, 'The report was not deleted'); }
    });

    // designer
    const onField = (e, t, isChange) => {
      if (!rp.model) return;
      const path = t.dataset.path; const kind = t.dataset.kind || '';
      let v = t.type === 'checkbox' ? t.checked : t.value;
      if (kind === 'num') v = v === '' ? '' : Number(v);
      if (kind === 'nullable') v = v || null;
      if (path === 'name' || path === 'label') rp.model[path] = v;
      else setPath(rp.model, path, v);
      if (path === 'def.source.kind') { rp.model.def.source = v === 'entity' ? { kind: 'entity', entity: app.entities[0] ? app.entities[0].name : '', view: null, filters: [], filterMode: 'and', q: '', state: null } : v === 'query' ? { kind: 'query', query: '' } : { kind: 'rest', connection: '', endpoint: '' }; rp.model.def.srcParams = []; rp.preview = null; rp.knownCols = []; }
      if (path === 'def.source.entity') { rp.model.def.source.view = null; rp.model.def.source.filters = []; rp.model.def.source.state = null; }
      if (path === 'def.source.connection') rp.model.def.source.endpoint = '';
      if (path === 'def.layout.kind') rp.model.def.layout = v === 'grouped' ? { kind: 'grouped', groupBy: [''], aggregates: [{ op: 'count' }], subtotals: true, grandTotal: true } : v === 'crosstab' ? { kind: 'crosstab', rows: [''], column: '', values: [{ op: 'count' }], rowTotals: true, columnTotals: true, maxColumns: 20 } : { kind: 'table' };
      if (isChange && t.hasAttribute('data-struct')) rerenderFocus('[data-path="' + path + '"]');
      schedulePreview(ctx, app);
    };
    ctx.on('change', '[data-rp-f]', (e, t) => onField(e, t, true));
    ctx.on('input', '[data-rp-f]', (e, t) => { if (t.tagName !== 'SELECT' && t.type !== 'checkbox') onField(e, t, false); });
    ctx.on('change', '[data-rp-col]', (e, t) => {
      if (!rp.model) return;
      const key = t.dataset.rpCol; const list = rp.model.def.columns || (rp.model.def.columns = []);
      const at = list.indexOf(key);
      if (t.checked && at < 0) list.push(key); else if (!t.checked && at >= 0) list.splice(at, 1);
      schedulePreview(ctx, app);
    });
    ctx.on('click', '[data-rp-add]', (e, t) => {
      if (!rp.model) return;
      const path = t.dataset.rpAdd;
      let arr = getPath(rp.model, path);
      if (!Array.isArray(arr)) { arr = []; setPath(rp.model, path, arr); }
      arr.push((DEFAULTS[path] || (() => ({})))(rp.model));
      rerenderFocus('[data-path^="' + path + '.' + (arr.length - 1) + '"]');
      schedulePreview(ctx, app);
    });
    ctx.on('click', '[data-rp-del]', (e, t) => {
      if (!rp.model) return;
      const path = t.dataset.rpDel; const cut = path.lastIndexOf('.');
      const arr = getPath(rp.model, path.slice(0, cut));
      if (Array.isArray(arr)) arr.splice(+path.slice(cut + 1), 1);
      rerenderFocus('[data-rp-add="' + path.slice(0, cut) + '"]');
      schedulePreview(ctx, app);
    });
    ctx.on('click', '[data-rp-preview-now]', () => runPreview(ctx, app));
    ctx.on('click', '[data-rp-save]', async (e, t) => {
      if (!rp.model) return;
      const m = rp.model; const def = toDefinition(app, m);
      const errEl = t.parentElement.querySelector('[data-rp-saveerr],[data-rp-saveerr2]');
      try {
        let out;
        if (m.isNew) { const body = { name: String(m.name || '').trim(), definition: def }; if (m.label) body.label = m.label; out = await App.post(R(app), body); }
        else { const body = { definition: def, version: m.version }; if (m.label) body.label = m.label; out = await App.patch(R(app) + '/' + enc(m.id), body); }
        rp.mode = 'run'; rp.model = null; rp.sel = out.id; rp.list = null; rp.result = null; rp.runsFor = null; clearTimeout(previewTimer);
        ctx.toast((m.isNew ? 'Created the report ' : 'Saved the report ') + esc(out.title) + '. Audited ' + (m.isNew ? 'app.report.created' : 'app.report.updated') + '.', 'ok');
        ctx.rerender();
      } catch (err) { if (errEl) errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); else App.fail(err, 'The report was not saved'); }
    });

    return { body, inspector: insp };
  };
})();
