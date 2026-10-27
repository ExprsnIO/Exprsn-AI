(function () {
  const { UI, esc } = App;

  /*
   * Files: the table builder (#/file-query?query=<id> or ?file=<id>), a Power Query style editor. A query is a source
   * (a sheet of an Excel, OpenDocument or CSV file, a JSON file, or another saved query) and a list of applied steps;
   * the server runs it as the signed-in person over the files it names (server/src/files/documents/query.ts) and this
   * screen shows a page of the result after the selected step. Close & load writes the result into a new spreadsheet
   * or a sheet of an existing one; Refresh writes it there again. Nothing runs in the browser but the drawing.
   */

  const ID = 'file-query';
  const enc = encodeURIComponent;
  const TYPES = ['text', 'number', 'integer', 'date', 'datetime', 'boolean', 'email', 'url'];
  const TYPE_ICON = { any: 'ABC 123', text: 'ABC', number: '1.2', integer: '123', date: 'Date', datetime: 'Date time', boolean: 'T/F', email: '@', url: 'URL' };
  const OPS = [['eq', 'equals'], ['ne', 'does not equal'], ['gt', 'is greater than'], ['gte', 'is greater than or equal to'], ['lt', 'is less than'], ['lte', 'is less than or equal to'], ['contains', 'contains'], ['not-contains', 'does not contain'], ['starts', 'begins with'], ['ends', 'ends with'], ['empty', 'is empty'], ['not-empty', 'is not empty']];
  const AGGS = [['sum', 'Sum'], ['avg', 'Average'], ['median', 'Median'], ['min', 'Min'], ['max', 'Max'], ['count', 'Count values'], ['count-rows', 'Count rows'], ['count-distinct', 'Count distinct'], ['first', 'First'], ['last', 'Last'], ['concat', 'Join text']];
  const JOINS = [['left', 'Left outer (all from first, matching from second)'], ['inner', 'Inner (only matching rows)'], ['right', 'Right outer (all from second, matching from first)'], ['full', 'Full outer (all rows from both)'], ['left-anti', 'Left anti (rows only in first)'], ['right-anti', 'Right anti (rows only in second)']];
  const PAGE = 200;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const plural = (n, w) => Number(n).toLocaleString('en-US') + ' ' + w + (n === 1 ? '' : 's');
  const opLabel = (op) => (OPS.find((o) => o[0] === op) || [op, op])[1];
  const shown = (v) => (v == null ? '' : v === true ? 'TRUE' : v === false ? 'FALSE' : String(v));

  // ---------- samples for the states (no server needed) ----------
  const SAMPLE = {
    query: { id: null, name: 'Sales by region', label: 'internal', output: null },
    def: { source: { kind: 'file', fileId: '01J0000000000000000000FILE', sheet: 'Sales', header: true }, steps: [{ op: 'change-type', columns: [{ column: 'Amount', type: 'number' }] }, { op: 'filter', match: 'all', conditions: [{ column: 'Region', op: 'ne', value: 'Test' }] }, { op: 'group', by: ['Region'], aggregates: [{ as: 'Total', fn: 'sum', column: 'Amount' }, { as: 'Deals', fn: 'count-rows' }] }] },
    preview: { columns: [{ name: 'Region', type: 'text' }, { name: 'Total', type: 'number' }, { name: 'Deals', type: 'integer' }], rows: [['North', 1250.5, 2], ['South', 300, 1], ['West', 88, 1]], rowCount: 3, offset: 0, applied: 3, steps: 3, error: null, warnings: [{ step: 0, message: '1 value in Amount could not be read as number and is now empty.' }], label: 'internal', profile: [{ column: 'Region', empty: 0, distinct: 3 }, { column: 'Total', empty: 0, distinct: 3 }, { column: 'Deals', empty: 0, distinct: 2 }] },
    sourceName: 'sales.xlsx'
  };

  // ---------- step descriptions ----------
  const list = (a) => (a || []).join(', ');
  function stepTitle(s) {
    switch (s.op) {
      case 'promote-headers': return 'Promoted headers';
      case 'demote-headers': return 'Demoted headers';
      case 'change-type': return 'Changed type: ' + s.columns.map((c) => c.column + ' to ' + c.type).join(', ');
      case 'rename': return 'Renamed: ' + s.columns.map((c) => c.from + ' to ' + c.to).join(', ');
      case 'remove-columns': return 'Removed columns: ' + list(s.columns);
      case 'keep-columns': return 'Chose columns: ' + list(s.columns);
      case 'reorder': return 'Reordered columns';
      case 'duplicate-column': return 'Duplicated ' + s.column + ' as ' + s.as;
      case 'filter': return 'Filtered rows: ' + s.conditions.map((c) => c.column + ' ' + (c.op === 'in' ? 'is one of ' + (c.values || []).length + ' values' : opLabel(c.op) + (c.op === 'empty' || c.op === 'not-empty' ? '' : ' ' + shown(c.value)))).join(s.match === 'any' ? ' or ' : ' and ');
      case 'sort': return 'Sorted by ' + s.keys.map((k) => k.column + (k.desc ? ' descending' : '')).join(', ');
      case 'distinct': return 'Removed duplicates' + (s.columns && s.columns.length ? ' by ' + list(s.columns) : '');
      case 'keep-rows': return s.mode === 'range' ? 'Kept ' + s.count + ' rows from row ' + s.from : 'Kept ' + s.mode + ' ' + s.count + ' rows';
      case 'remove-rows': return s.mode === 'blank' ? 'Removed blank rows' : s.mode === 'alternate' ? 'Removed alternate rows' : 'Removed ' + s.mode + ' ' + s.count + ' rows';
      case 'fill': return 'Filled ' + s.direction + ': ' + list(s.columns);
      case 'replace': return 'Replaced "' + s.find + '" with "' + s.replace + '" in ' + list(s.columns);
      case 'replace-empty': return 'Replaced empty in ' + list(s.columns) + ' with ' + shown(s.value);
      case 'text': return 'Formatted ' + list(s.columns) + ': ' + s.fn;
      case 'number': return 'Calculated ' + list(s.columns) + ': ' + s.fn + (s.value != null ? ' ' + s.value : '');
      case 'split': return 'Split ' + s.column + ' by "' + s.delimiter + '"';
      case 'merge-columns': return 'Merged ' + list(s.columns) + ' into ' + s.as;
      case 'custom': return 'Added custom column ' + s.as;
      case 'conditional': return 'Added conditional column ' + s.as;
      case 'index': return 'Added index column ' + (s.as || 'Index');
      case 'group': return 'Grouped by ' + (list(s.by) || 'all rows');
      case 'pivot': return 'Pivoted ' + s.column + ' (' + s.fn + ' of ' + s.values + ')';
      case 'unpivot': return s.others ? 'Unpivoted other columns' : 'Unpivoted ' + list(s.columns);
      case 'transpose': return 'Transposed table';
      case 'append': return 'Appended ' + plural(s.sources.length, 'table');
      case 'merge': return 'Merged queries (' + s.kind + ') on ' + list(s.left);
      default: return s.op;
    }
  }

  // ---------- state ----------
  const routeKey = (params) => JSON.stringify({ query: (params && params.query) || null, file: (params && params.file) || null, sheet: (params && params.sheet) || null });
  function reset(st, params) {
    Object.keys(st).forEach((k) => delete st[k]);
    Object.assign(st, { key: routeKey(params), query: null, def: null, sel: -1, cols: [], preview: null, previewing: false, seq: 0, dirty: false, queries: null, nav: null, error: null, loaded: false, loading: false, tab: 'home', sourceName: null, saving: false, demo: false, offset: 0 });
  }
  const steps = (st) => (st.def ? st.def.steps : []);
  const columns = (st) => (st.preview && st.preview.columns) || [];
  const colNames = (st) => columns(st).map((c) => c.name);
  const selCols = (st) => st.cols.filter((c) => colNames(st).indexOf(c) >= 0);

  function markDirty(st) { st.dirty = true; }

  /** Redraws, but never under an open dialog (a redraw closes it): waits until the dialog is gone. */
  function redraw(ctx) {
    const st = ctx.state;
    if (App.state.route !== ID) return;
    if (!document.querySelector('#overlay .modal, #overlay .drawer')) { st.redrawWait = false; ctx.rerender(); return; }
    if (st.redrawWait) return;
    st.redrawWait = true;
    const tick = () => { if (App.state.route !== ID) { st.redrawWait = false; return; } if (document.querySelector('#overlay .modal, #overlay .drawer')) setTimeout(tick, 250); else { st.redrawWait = false; ctx.rerender(); } };
    setTimeout(tick, 250);
  }

  function refresh(ctx) {
    const st = ctx.state;
    if (st.demo || !st.def) { redraw(ctx); return Promise.resolve(); }
    const seq = ++st.seq; st.previewing = true; redraw(ctx);
    return App.post('/api/files/queries/preview', { definition: st.def, upto: st.sel + 1, offset: st.offset || 0, limit: PAGE, queryId: (st.query && st.query.id) || undefined }).then((p) => {
      if (seq !== st.seq) return;
      st.preview = p; st.previewError = null;
      st.cols = selCols(st);
    }).catch((err) => { if (seq === st.seq) { st.previewError = err; st.preview = st.preview && st.preview.columns ? st.preview : null; } })
      .finally(() => { if (seq === st.seq) { st.previewing = false; redraw(ctx); } });
  }

  function addStep(ctx, step, replaceAt) {
    const st = ctx.state; const s = steps(st);
    if (replaceAt != null) { s[replaceAt] = step; st.sel = replaceAt; }
    else {
      const at = st.sel + 1;
      if (at < s.length) ctx.toast('Inserted after the selected step. The steps after it now read its result.', 'warn', 5000);
      s.splice(at, 0, step); st.sel = at;
    }
    st.offset = 0; markDirty(st); refresh(ctx);
  }

  function loadQueries(ctx) {
    const st = ctx.state;
    if (st.demo) { st.queries = []; return; }
    App.get('/api/files/queries').then((qs) => { st.queries = qs; redraw(ctx); }).catch(() => { st.queries = []; });
  }

  async function start(ctx) {
    const st = ctx.state; const params = ctx.params;
    st.loading = true;
    try {
      if (params.query) {
        const q = await App.get('/api/files/queries/' + enc(params.query));
        st.query = q; st.def = q.definition; st.sel = st.def.steps.length - 1;
        st.sourceName = await sourceName(st.def.source);
      } else if (params.file) {
        const t = await App.get('/api/files/' + enc(params.file) + '/tables');
        st.query = { id: null, name: t.file.name.replace(/\.[^.]+$/, ''), label: t.label, output: null };
        if (t.sheets.length > 1 && !params.sheet) { st.nav = t; }
        else await begin(st, { kind: 'file', fileId: t.file.id, sheet: params.sheet || (t.sheets[0] && t.sheets[0].name) || null, header: true }, t.file.name);
      }
      st.loaded = true;
    } catch (err) { st.error = err; st.loaded = true; }
    st.loading = false;
    loadQueries(ctx);
    if (st.def) await refresh(ctx); else ctx.rerender();
  }

  /** A new query on a source: the source, then the types the values read as (Power Query's first Changed type). */
  async function begin(st, source, name) {
    st.def = { source, steps: [] };
    st.sourceName = name || null;
    try {
      const d = await App.post('/api/files/queries/detect', { definition: st.def });
      const typed = (d.columns || []).filter((c) => c.type !== 'text');
      if (typed.length) st.def.steps.push({ op: 'change-type', columns: typed.map((c) => ({ column: c.column, type: c.type })) });
    } catch (e) { /* the preview shows why */ }
    st.sel = st.def.steps.length - 1; st.dirty = true;
  }

  async function sourceName(src) {
    try {
      if (src.kind === 'query') { const q = await App.get('/api/files/queries/' + enc(src.queryId)); return 'Query: ' + q.name; }
      const f = await App.get('/api/files/' + enc(src.fileId)); return f.name + (src.sheet ? ' › ' + src.sheet : '');
    } catch (e) { return src.kind === 'query' ? 'a saved query' : 'a file'; }
  }

  // ---------- dialogs ----------
  const colOptions = (st, chosen) => colNames(st).map((n) => ({ value: n, label: n })).concat(chosen && colNames(st).indexOf(chosen) < 0 ? [{ value: chosen, label: chosen + ' (not in this table)' }] : []);
  const checks = (names, on, attr) => '<div class="fq-checks" role="group">' + names.map((n) => UI.check(n, on.indexOf(n) >= 0, attr + '="' + esc(n) + '"')).join('') + '</div>';
  const picked = (m, attr) => Array.from(m.querySelectorAll('[' + attr + ']')).filter((x) => x.checked).map((x) => x.getAttribute(attr));
  const valueOf = (raw) => { const t = String(raw); if (t === '') return null; if (/^-?\d+(\.\d+)?$/.test(t.trim())) return Number(t.trim()); if (/^(true|false)$/i.test(t.trim())) return /^true$/i.test(t.trim()); return t; };

  function dialog(ctx, title, body, onOk, opts) {
    ctx.modal({ title: esc(title), cls: (opts && opts.wide) ? 'wide' : '', body: body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn((opts && opts.ok) || 'OK', { kind: 'primary', attrs: 'data-fq-ok' }), onMount(m) {
      const go = () => { try { const step = onOk(m); if (step === false) return; App.closeOverlay(); } catch (e) { ctx.toast(esc(e.message), 'danger'); } };
      m.querySelector('[data-fq-ok]').addEventListener('click', go);
      if (opts && opts.mount) opts.mount(m);
    } });
  }
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };

  function needCols(ctx, n) {
    const c = selCols(ctx.state);
    if (c.length < (n || 1)) { ctx.toast((n || 1) > 1 ? 'Select at least ' + n + ' columns first (Ctrl or Shift and click their headers).' : 'Select a column first: click its header.', 'warn'); return null; }
    return c;
  }

  function chooseColumns(ctx, init, at) {
    const st = ctx.state; const on = init ? init.columns : colNames(st);
    dialog(ctx, 'Choose columns', '<p class="fg2" style="margin:0">Keep these columns, in this order.</p>' + checks(colNames(st), on, 'data-fq-c'), (m) => { const c = picked(m, 'data-fq-c'); need(c.length, 'Choose at least one column.'); addStep(ctx, { op: 'keep-columns', columns: c }, at); });
  }
  function rowsDialog(ctx, kind, init, at) {
    const keep = kind === 'keep-rows';
    const modes = keep ? [['top', 'Keep top rows'], ['bottom', 'Keep bottom rows'], ['range', 'Keep a range of rows']] : [['top', 'Remove top rows'], ['bottom', 'Remove bottom rows'], ['blank', 'Remove blank rows'], ['alternate', 'Remove alternate rows']];
    const i = init || { mode: 'top', count: 1, from: 1, keep: 1 };
    dialog(ctx, keep ? 'Keep rows' : 'Remove rows', '<div class="formgrid">' + UI.field('What', UI.select(modes.map((x) => ({ value: x[0], label: x[1] })), i.mode, 'data-fq-mode')) + UI.field('Number of rows', UI.input(String(i.count != null ? i.count : 1), { type: 'number', attrs: 'data-fq-count min="0"' })) + UI.field(keep ? 'First row (range)' : 'Rows to keep (alternate)', UI.input(String(keep ? i.from || 1 : i.keep || 1), { type: 'number', attrs: 'data-fq-from min="1"' })) + '</div>', (m) => {
      const mode = m.querySelector('[data-fq-mode]').value; const count = Math.max(0, parseInt(m.querySelector('[data-fq-count]').value, 10) || 0); const from = Math.max(1, parseInt(m.querySelector('[data-fq-from]').value, 10) || 1);
      addStep(ctx, keep ? { op: 'keep-rows', mode, count, from } : { op: 'remove-rows', mode, count, keep: from }, at);
    });
  }
  function sortDialog(ctx, init, at) {
    const st = ctx.state; const keys = init ? init.keys : selCols(st).map((c) => ({ column: c, desc: false }));
    const row = (k, i) => '<div class="hstack gap6 fq-row">' + UI.field('Column ' + (i + 1), UI.select([{ value: '', label: '(none)' }].concat(colOptions(st, k && k.column)), (k && k.column) || '', 'data-fq-sc="' + i + '"')) + UI.field('Order', UI.select([{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], k && k.desc ? 'desc' : 'asc', 'data-fq-so="' + i + '"')) + '</div>';
    dialog(ctx, 'Sort rows', [0, 1, 2].map((i) => row(keys[i], i)).join(''), (m) => {
      const out = [0, 1, 2].map((i) => ({ column: m.querySelector('[data-fq-sc="' + i + '"]').value, desc: m.querySelector('[data-fq-so="' + i + '"]').value === 'desc' })).filter((k) => k.column);
      need(out.length, 'Choose a column to sort by.'); addStep(ctx, { op: 'sort', keys: out }, at);
    });
  }
  function typeDialog(ctx, init, at) {
    const st = ctx.state; const cols = init ? init.columns.map((c) => c.column) : needCols(ctx); if (!cols) return;
    const cur = init ? init.columns[0].type : 'text';
    dialog(ctx, 'Change type of ' + cols.join(', '), UI.field('Type', UI.select(TYPES, cur, 'data-fq-type')) + UI.check('Dates are day first (31/12/2026)', !!(init && init.dayFirst), 'data-fq-dayfirst') + '<p class="muted" style="font-size:12px;margin:0">Values that do not read as the type become empty; the step says how many.</p>', (m) => {
      const type = m.querySelector('[data-fq-type]').value; addStep(ctx, { op: 'change-type', columns: cols.map((c) => ({ column: c, type })), dayFirst: m.querySelector('[data-fq-dayfirst]').checked }, at);
    });
    void st;
  }
  function renameDialog(ctx, init, at) {
    const from = init ? init.columns[0].from : (needCols(ctx) || [])[0]; if (!from) return;
    dialog(ctx, 'Rename ' + from, UI.field('New name', UI.input(init ? init.columns[0].to : from, { attrs: 'data-fq-name maxlength="200"' })), (m) => { const to = m.querySelector('[data-fq-name]').value.trim(); need(to, 'Give a name.'); addStep(ctx, { op: 'rename', columns: [{ from, to }] }, at); });
  }
  function replaceDialog(ctx, init, at) {
    const cols = init ? init.columns : needCols(ctx); if (!cols) return;
    const i = init || { find: '', replace: '', match: 'whole', caseSensitive: false };
    dialog(ctx, 'Replace values in ' + cols.join(', '), '<div class="formgrid">' + UI.field('Value to find', UI.input(i.find, { attrs: 'data-fq-find' }), 'Leave empty to replace empty cells.') + UI.field('Replace with', UI.input(i.replace, { attrs: 'data-fq-rep' })) + UI.field('Match', UI.select([{ value: 'whole', label: 'Whole cell' }, { value: 'contains', label: 'Inside the text' }], i.match, 'data-fq-match')) + '</div>' + UI.check('Match case', i.caseSensitive, 'data-fq-case'), (m) => {
      addStep(ctx, { op: 'replace', columns: cols, find: m.querySelector('[data-fq-find]').value, replace: m.querySelector('[data-fq-rep]').value, match: m.querySelector('[data-fq-match]').value, caseSensitive: m.querySelector('[data-fq-case]').checked }, at);
    });
  }
  function splitDialog(ctx, init, at) {
    const column = init ? init.column : (needCols(ctx) || [])[0]; if (!column) return;
    const i = init || { delimiter: ',', mode: 'each' };
    dialog(ctx, 'Split ' + column + ' by delimiter', '<div class="formgrid">' + UI.field('Delimiter', UI.input(i.delimiter, { attrs: 'data-fq-delim maxlength="20"' }), 'For a tab, type \\t.') + UI.field('Split at', UI.select([{ value: 'each', label: 'Each occurrence' }, { value: 'first', label: 'The first one' }, { value: 'last', label: 'The last one' }], i.mode, 'data-fq-smode')) + UI.field('New column names', UI.input((i.into || []).join(', '), { attrs: 'data-fq-into', placeholder: column + '.1, ' + column + '.2' }), 'Optional, comma separated. The last takes what is left.') + '</div>', (m) => {
      const d = m.querySelector('[data-fq-delim]').value.replace(/\\t/g, '\t'); need(d, 'Give a delimiter.');
      const into = m.querySelector('[data-fq-into]').value.split(',').map((x) => x.trim()).filter(Boolean);
      addStep(ctx, Object.assign({ op: 'split', column, delimiter: d, mode: m.querySelector('[data-fq-smode]').value }, into.length ? { into } : {}), at);
    });
  }
  function textDialog(ctx, init, at) {
    const cols = init ? init.columns : needCols(ctx); if (!cols) return;
    const i = init || { fn: 'trim' };
    const fns = [['trim', 'Trim spaces'], ['clean', 'Clean (remove control characters)'], ['lower', 'lower case'], ['upper', 'UPPER CASE'], ['title', 'Capitalize Each Word'], ['prefix', 'Add prefix'], ['suffix', 'Add suffix'], ['length', 'Length'], ['first', 'First characters'], ['last', 'Last characters']];
    dialog(ctx, 'Format ' + cols.join(', '), '<div class="formgrid">' + UI.field('Format', UI.select(fns.map((x) => ({ value: x[0], label: x[1] })), i.fn, 'data-fq-fn')) + UI.field('Text (prefix, suffix)', UI.input(i.value || '', { attrs: 'data-fq-val' })) + UI.field('Count (first, last)', UI.input(String(i.count != null ? i.count : 1), { type: 'number', attrs: 'data-fq-cnt min="0"' })) + '</div>', (m) => {
      const fn = m.querySelector('[data-fq-fn]').value; const step = { op: 'text', columns: cols, fn };
      if (fn === 'prefix' || fn === 'suffix') step.value = m.querySelector('[data-fq-val]').value;
      if (fn === 'first' || fn === 'last') step.count = Math.max(0, parseInt(m.querySelector('[data-fq-cnt]').value, 10) || 0);
      addStep(ctx, step, at);
    });
  }
  function numberDialog(ctx, init, at) {
    const cols = init ? init.columns : needCols(ctx); if (!cols) return;
    const i = init || { fn: 'round', digits: 0 };
    const fns = [['round', 'Round'], ['abs', 'Absolute value'], ['negate', 'Negate'], ['add', 'Add'], ['subtract', 'Subtract'], ['multiply', 'Multiply'], ['divide', 'Divide'], ['percent-of', 'Percent of']];
    dialog(ctx, 'Calculate ' + cols.join(', '), '<div class="formgrid">' + UI.field('Operation', UI.select(fns.map((x) => ({ value: x[0], label: x[1] })), i.fn, 'data-fq-fn')) + UI.field('Value', UI.input(i.value != null ? String(i.value) : '', { type: 'number', attrs: 'data-fq-val step="any"' })) + UI.field('Decimal places (round)', UI.input(String(i.digits || 0), { type: 'number', attrs: 'data-fq-dig min="0" max="15"' })) + '</div>', (m) => {
      const fn = m.querySelector('[data-fq-fn]').value; const step = { op: 'number', columns: cols, fn };
      const v = m.querySelector('[data-fq-val]').value;
      if (['add', 'subtract', 'multiply', 'divide', 'percent-of'].indexOf(fn) >= 0) { need(v !== '' && isFinite(Number(v)), 'Give a number.'); step.value = Number(v); }
      if (fn === 'round') step.digits = Math.max(0, Math.min(15, parseInt(m.querySelector('[data-fq-dig]').value, 10) || 0));
      addStep(ctx, step, at);
    });
  }
  function replaceEmptyDialog(ctx, init, at) {
    const cols = init ? init.columns : needCols(ctx); if (!cols) return;
    dialog(ctx, 'Replace empty values in ' + cols.join(', '), UI.field('With', UI.input(init ? shown(init.value) : '', { attrs: 'data-fq-val' }), 'Numbers and TRUE or FALSE are kept as such.'), (m) => addStep(ctx, { op: 'replace-empty', columns: cols, value: valueOf(m.querySelector('[data-fq-val]').value) }, at));
  }

  async function filterDialog(ctx, column, init, at) {
    const st = ctx.state;
    column = column || (init && init.conditions[0].column) || (needCols(ctx) || [])[0]; if (!column) return;
    let vals = null;
    try { vals = st.demo ? { values: [], distinct: 0 } : await App.post('/api/files/queries/values', { definition: st.def, upto: st.sel + 1, column, queryId: (st.query && st.query.id) || undefined }); } catch (err) { App.fail(err, 'Could not list the values'); return; }
    const c0 = (init && init.conditions[0]) || { op: 'eq', value: '' };
    const c1 = (init && init.conditions[1]) || { op: 'eq', value: '' };
    const inSet = c0.op === 'in' ? (c0.values || []).map(shown) : null;
    const valueList = '<div class="fq-checks" role="group" aria-label="Values">' + vals.values.map((x, i) => UI.check((x.value == null || x.value === '' ? '(empty)' : shown(x.value)) + ' (' + x.count + ')', inSet ? inSet.indexOf(shown(x.value)) >= 0 : true, 'data-fq-v="' + i + '"')).join('') + '</div>' + (vals.distinct > vals.values.length ? '<span class="muted" style="font-size:12px">The ' + vals.values.length + ' most common of ' + plural(vals.distinct, 'value') + ' are listed.</span>' : '');
    const cond = (c, i) => '<div class="hstack gap6 fq-row">' + UI.field('Condition ' + (i + 1), UI.select([{ value: '', label: i ? '(none)' : '(choose)' }].concat(OPS.map((o) => ({ value: o[0], label: opLabel(o[0]) }))), c.op === 'in' ? '' : i && !init ? '' : c.op, 'data-fq-op="' + i + '"')) + UI.field('Value', UI.input(c.op === 'in' ? '' : shown(c.value), { attrs: 'data-fq-cv="' + i + '"' })) + '</div>';
    ctx.modal({ title: 'Filter rows by ' + esc(column), cls: 'wide', body: '<div role="tablist" class="tabs" aria-label="Filter kind">' + ['Values', 'Conditions'].map((t, i) => '<button type="button" role="tab" data-fq-ft="' + i + '" aria-selected="' + ((inSet || !init ? 0 : 1) === i ? 'true' : 'false') + '" class="' + ((inSet || !init ? 0 : 1) === i ? 'active' : '') + '">' + t + '</button>').join('') + '</div>'
      + '<div data-fq-fp="0"' + (inSet || !init ? '' : ' hidden') + '>' + UI.btn('Select all', { size: 'xs', kind: 'ghost', attrs: 'data-fq-all' }) + UI.btn('Clear', { size: 'xs', kind: 'ghost', attrs: 'data-fq-none' }) + valueList + '</div>'
      + '<div data-fq-fp="1"' + (inSet || !init ? ' hidden' : '') + '>' + cond(c0, 0) + UI.field('Combine', UI.select([{ value: 'all', label: 'And' }, { value: 'any', label: 'Or' }], (init && init.match) || 'all', 'data-fq-match')) + cond(c1, 1) + UI.check('Match case', !!c0.caseSensitive, 'data-fq-case') + '</div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('OK', { kind: 'primary', attrs: 'data-fq-ok' }), onMount(m) {
      let mode = inSet || !init ? 0 : 1;
      m.querySelectorAll('[data-fq-ft]').forEach((b) => b.addEventListener('click', () => { mode = +b.dataset.fqFt; m.querySelectorAll('[data-fq-ft]').forEach((x) => { const on = +x.dataset.fqFt === mode; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); }); m.querySelectorAll('[data-fq-fp]').forEach((p) => { p.hidden = +p.dataset.fqFp !== mode; }); }));
      m.querySelector('[data-fq-all]').addEventListener('click', () => m.querySelectorAll('[data-fq-v]').forEach((x) => { x.checked = true; }));
      m.querySelector('[data-fq-none]').addEventListener('click', () => m.querySelectorAll('[data-fq-v]').forEach((x) => { x.checked = false; }));
      m.querySelector('[data-fq-ok]').addEventListener('click', () => {
        let step;
        if (mode === 0) {
          const on = Array.from(m.querySelectorAll('[data-fq-v]')).filter((x) => x.checked).map((x) => vals.values[+x.dataset.fqV].value);
          if (!on.length) { ctx.toast('Keep at least one value.', 'warn'); return; }
          if (on.length === vals.values.length && vals.distinct === vals.values.length) { App.closeOverlay(); return; }
          step = { op: 'filter', match: 'all', conditions: [{ column, op: 'in', values: on, caseSensitive: true }] };
        } else {
          const cs = m.querySelector('[data-fq-case]').checked;
          const conds = [0, 1].map((i) => ({ op: m.querySelector('[data-fq-op="' + i + '"]').value, raw: m.querySelector('[data-fq-cv="' + i + '"]').value })).filter((c) => c.op).map((c) => Object.assign({ column, op: c.op, caseSensitive: cs }, c.op === 'empty' || c.op === 'not-empty' ? {} : { value: valueOf(c.raw) }));
          if (!conds.length) { ctx.toast('Choose a condition.', 'warn'); return; }
          step = { op: 'filter', match: m.querySelector('[data-fq-match]').value, conditions: conds };
        }
        App.closeOverlay(); addStep(ctx, step, at);
      });
    } });
  }

  function groupDialog(ctx, init, at) {
    const st = ctx.state; const by = init ? init.by : selCols(st);
    const aggs = init ? clone(init.aggregates) : [{ as: 'Count', fn: 'count-rows' }];
    const aggRow = (a, i) => '<div class="hstack gap6 fq-row" data-fq-agg="' + i + '">' + UI.field('New column', UI.input(a.as, { attrs: 'data-fq-as maxlength="200"' })) + UI.field('Operation', UI.select(AGGS.map((x) => ({ value: x[0], label: x[1] })), a.fn, 'data-fq-afn')) + UI.field('Column', UI.select([{ value: '', label: '(none)' }].concat(colOptions(st, a.column)), a.column || '', 'data-fq-acol')) + UI.iconbtn('x', 'Remove this aggregation', { attrs: 'data-fq-arm="' + i + '"', cls: 'sm ghost' }) + '</div>';
    const draw = (m) => { m.querySelector('[data-fq-aggs]').innerHTML = aggs.map(aggRow).join(''); m.querySelectorAll('[data-fq-arm]').forEach((b) => b.addEventListener('click', () => { read(m); aggs.splice(+b.dataset.fqArm, 1); draw(m); })); };
    const read = (m) => { m.querySelectorAll('[data-fq-agg]').forEach((r) => { const i = +r.dataset.fqAgg; aggs[i] = { as: r.querySelector('[data-fq-as]').value.trim(), fn: r.querySelector('[data-fq-afn]').value, column: r.querySelector('[data-fq-acol]').value || undefined }; }); };
    dialog(ctx, 'Group by', '<div class="eyebrow">Group by</div>' + checks(colNames(st), by, 'data-fq-by') + '<div class="eyebrow">Aggregations</div><div data-fq-aggs class="vstack gap6"></div>' + UI.btn('Add aggregation', { size: 'xs', icon: 'plus', attrs: 'data-fq-addagg' }), (m) => {
      read(m); const out = aggs.filter((a) => a.as);
      need(out.length, 'Add an aggregation.');
      out.forEach((a) => need(a.fn === 'count-rows' || a.column, a.as + ': choose a column for ' + a.fn + '.'));
      addStep(ctx, { op: 'group', by: picked(m, 'data-fq-by'), aggregates: out.map((a) => Object.assign({ as: a.as, fn: a.fn }, a.fn !== 'count-rows' ? { column: a.column } : {})) }, at);
    }, { wide: true, mount(m) { draw(m); m.querySelector('[data-fq-addagg]').addEventListener('click', () => { read(m); aggs.push({ as: 'Sum', fn: 'sum' }); draw(m); }); } });
  }
  function pivotDialog(ctx, init, at) {
    const st = ctx.state; const column = init ? init.column : (needCols(ctx) || [])[0]; if (!column) return;
    dialog(ctx, 'Pivot ' + column, '<p class="fg2" style="margin:0">Each value of ' + esc(column) + ' becomes a column.</p><div class="formgrid">' + UI.field('Values column', UI.select(colOptions(st, init && init.values).filter((o) => o.value !== column), (init && init.values) || '', 'data-fq-pv')) + UI.field('Aggregate', UI.select(AGGS.filter((x) => x[0] !== 'count-rows').map((x) => ({ value: x[0], label: x[1] })), (init && init.fn) || 'sum', 'data-fq-pf')) + '</div>', (m) => addStep(ctx, { op: 'pivot', column, values: m.querySelector('[data-fq-pv]').value, fn: m.querySelector('[data-fq-pf]').value }, at));
  }
  function unpivot(ctx, others) {
    const cols = needCols(ctx); if (!cols) return;
    addStep(ctx, { op: 'unpivot', columns: cols, others: !!others, attribute: 'Attribute', value: 'Value' });
  }
  function customDialog(ctx, init, at) {
    const st = ctx.state; const i = init || { as: 'Custom', formula: '' };
    dialog(ctx, 'Custom column', '<div class="formgrid">' + UI.field('New column name', UI.input(i.as, { attrs: 'data-fq-as maxlength="200"' })) + UI.field('Type', UI.select([{ value: '', label: 'Detect from the results' }].concat(TYPES.map((t) => ({ value: t, label: t }))), i.type || '', 'data-fq-ty')) + '</div>'
      + UI.field('Formula', UI.textarea(i.formula, { attrs: 'data-fq-f class="textarea fq-mono" spellcheck="false" maxlength="2000"', rows: 4, placeholder: '[Unit price] * [Quantity]' }), 'Columns as [Name]. Operators + - * / & and comparisons; functions such as If, Round, Upper, Left, DateDiff, Coalesce. Rows the formula cannot finish are empty.')
      + '<div class="eyebrow">Columns</div><div class="fq-insert">' + colNames(st).map((n) => UI.chip(esc(n), false, 'data-fq-ins="' + esc(n) + '"')).join('') + '</div>', (m) => {
      const as = m.querySelector('[data-fq-as]').value.trim(); const f = m.querySelector('[data-fq-f]').value.trim(); const ty = m.querySelector('[data-fq-ty]').value;
      need(as, 'Give the column a name.'); need(f, 'Write a formula.');
      addStep(ctx, Object.assign({ op: 'custom', as, formula: f }, ty ? { type: ty } : {}), at);
    }, { wide: true, mount(m) { const ta = m.querySelector('[data-fq-f]'); m.querySelectorAll('[data-fq-ins]').forEach((b) => b.addEventListener('click', () => { const t = '[' + b.dataset.fqIns + ']'; const s = ta.selectionStart || ta.value.length; ta.value = ta.value.slice(0, s) + t + ta.value.slice(ta.selectionEnd || s); ta.focus(); ta.selectionStart = ta.selectionEnd = s + t.length; })); } });
  }
  function conditionalDialog(ctx, init, at) {
    const st = ctx.state; const rules = init ? clone(init.rules) : [{ column: selCols(st)[0] || colNames(st)[0] || '', op: 'eq', value: '', then: '' }];
    const ruleRow = (r, i) => '<div class="hstack gap6 fq-row wrap" data-fq-rule="' + i + '">' + UI.field(i ? 'Else if' : 'If', UI.select(colOptions(st, r.column), r.column, 'data-fq-rc')) + UI.field('Operator', UI.select(OPS.map((o) => ({ value: o[0], label: o[1] })), r.op, 'data-fq-ro')) + UI.field('Value', UI.input(shown(r.value), { attrs: 'data-fq-rv' })) + UI.field('Then', UI.input(shown(r.then), { attrs: 'data-fq-rt' })) + UI.iconbtn('x', 'Remove this rule', { attrs: 'data-fq-rrm="' + i + '"', cls: 'sm ghost' }) + '</div>';
    const read = (m) => { m.querySelectorAll('[data-fq-rule]').forEach((r) => { rules[+r.dataset.fqRule] = { column: r.querySelector('[data-fq-rc]').value, op: r.querySelector('[data-fq-ro]').value, value: valueOf(r.querySelector('[data-fq-rv]').value), then: valueOf(r.querySelector('[data-fq-rt]').value) }; }); };
    const draw = (m) => { m.querySelector('[data-fq-rules]').innerHTML = rules.map(ruleRow).join(''); m.querySelectorAll('[data-fq-rrm]').forEach((b) => b.addEventListener('click', () => { read(m); if (rules.length > 1) rules.splice(+b.dataset.fqRrm, 1); draw(m); })); };
    dialog(ctx, 'Conditional column', UI.field('New column name', UI.input(init ? init.as : 'Custom', { attrs: 'data-fq-as maxlength="200"' })) + '<div data-fq-rules class="vstack gap6"></div>' + UI.btn('Add clause', { size: 'xs', icon: 'plus', attrs: 'data-fq-addrule' }) + UI.field('Else', UI.input(init ? shown(init.otherwise) : '', { attrs: 'data-fq-else' })), (m) => {
      read(m); const as = m.querySelector('[data-fq-as]').value.trim(); need(as, 'Give the column a name.');
      addStep(ctx, { op: 'conditional', as, rules: rules.map((r) => Object.assign({ column: r.column, op: r.op, then: r.then, caseSensitive: false }, r.op === 'empty' || r.op === 'not-empty' ? {} : { value: r.value })), otherwise: valueOf(m.querySelector('[data-fq-else]').value) }, at);
    }, { wide: true, mount(m) { draw(m); m.querySelector('[data-fq-addrule]').addEventListener('click', () => { read(m); rules.push({ column: colNames(st)[0] || '', op: 'eq', value: '', then: '' }); draw(m); }); } });
  }
  function indexDialog(ctx, init, at) {
    const i = init || { as: 'Index', start: 1, step: 1 };
    dialog(ctx, 'Index column', '<div class="formgrid">' + UI.field('Name', UI.input(i.as, { attrs: 'data-fq-as maxlength="200"' })) + UI.field('Starting index', UI.input(String(i.start), { type: 'number', attrs: 'data-fq-st' })) + UI.field('Increment', UI.input(String(i.step), { type: 'number', attrs: 'data-fq-inc' })) + '</div>', (m) => addStep(ctx, { op: 'index', as: m.querySelector('[data-fq-as]').value.trim() || 'Index', start: parseInt(m.querySelector('[data-fq-st]').value, 10) || 0, step: parseInt(m.querySelector('[data-fq-inc]').value, 10) || 1 }, at));
  }
  function mergeColumnsDialog(ctx, init, at) {
    const cols = init ? init.columns : needCols(ctx, 2); if (!cols) return;
    dialog(ctx, 'Merge columns ' + cols.join(', '), '<div class="formgrid">' + UI.field('Separator', UI.input(init ? init.separator : ' ', { attrs: 'data-fq-sep maxlength="20"' })) + UI.field('New column name', UI.input(init ? init.as : 'Merged', { attrs: 'data-fq-as maxlength="200"' })) + '</div>', (m) => { const as = m.querySelector('[data-fq-as]').value.trim(); need(as, 'Give the column a name.'); addStep(ctx, { op: 'merge-columns', columns: cols, separator: m.querySelector('[data-fq-sep]').value, as }, at); });
  }
  function duplicateDialog(ctx) {
    const column = (needCols(ctx) || [])[0]; if (!column) return;
    dialog(ctx, 'Duplicate ' + column, UI.field('Name of the copy', UI.input(column + ' - Copy', { attrs: 'data-fq-as maxlength="200"' })), (m) => addStep(ctx, { op: 'duplicate-column', column, as: m.querySelector('[data-fq-as]').value.trim() || column + ' - Copy' }));
  }

  /** Picks another table: a sheet of a file found by name, or a saved query. Calls back with a source and its columns. */
  function pickSource(ctx, title, done) {
    const st = ctx.state;
    const qs = (st.queries || []).filter((q) => !st.query || q.id !== st.query.id);
    ctx.modal({ title: esc(title), cls: 'wide', body: '<div role="tablist" class="tabs" aria-label="Source kind"><button type="button" role="tab" data-fq-sk="file" class="active" aria-selected="true">A file</button><button type="button" role="tab" data-fq-sk="query" aria-selected="false">A saved query</button></div>'
      + '<div data-fq-skp="file" class="vstack gap6">' + UI.search('Search files by name', 'data-fq-q') + '<div data-fq-hits class="vstack gap4" aria-live="polite"><span class="muted" style="font-size:12px">Excel (.xlsx, .xls), OpenDocument (.ods), CSV and JSON files.</span></div><div data-fq-sheets></div>' + UI.check('The first row holds the column names', true, 'data-fq-hdr') + '</div>'
      + '<div data-fq-skp="query" hidden class="vstack gap4">' + (qs.length ? qs.map((q) => UI.listItem(esc(q.name), esc((q.description || '') + ' ' + q.label), { attrs: 'data-fq-pickq="' + esc(q.id) + '"' })).join('') : '<span class="muted">No other saved queries in this workspace.</span>') + '</div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Use this table', { kind: 'primary', attrs: 'data-fq-use', disabled: true }), onMount(m) {
      let chosen = null; let timer = null; const use = m.querySelector('[data-fq-use]');
      m.querySelectorAll('[data-fq-sk]').forEach((b) => b.addEventListener('click', () => { m.querySelectorAll('[data-fq-sk]').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); }); m.querySelectorAll('[data-fq-skp]').forEach((p) => { p.hidden = p.dataset.fqSkp !== b.dataset.fqSk; }); }));
      const hits = m.querySelector('[data-fq-hits]'); const sheets = m.querySelector('[data-fq-sheets]');
      const choose = async (id) => {
        sheets.innerHTML = UI.notice('Reading the file…', 'info'); use.disabled = true;
        try {
          const t = await App.get('/api/files/' + enc(id) + '/tables');
          chosen = { file: t.file, tables: t };
          sheets.innerHTML = t.sheets.length > 1 || t.sheets[0].name ? UI.field('Sheet', UI.select(t.sheets.map((s) => ({ value: s.name, label: s.name + ' (' + plural(s.rows, 'row') + ')' })), t.sheets[0].name, 'data-fq-sheet')) : '<span class="muted">' + esc(t.file.name) + ': ' + esc(t.sheets[0].columns.join(', ')) + '</span>';
          use.disabled = false;
        } catch (err) { sheets.innerHTML = UI.notice(esc(err.message), 'danger'); }
      };
      m.querySelector('[data-fq-q]').addEventListener('input', (e) => {
        const q = e.target.value.trim(); if (timer) clearTimeout(timer);
        if (!q) return;
        timer = setTimeout(() => App.get('/api/files/search?q=' + enc(q)).then((rs) => {
          const ok = rs.filter((f) => /csv|spreadsheet|excel|json|opendocument\.spreadsheet|ms-excel/.test(f.type || '') || /\.(csv|tsv|xlsx|xls|ods|json)$/i.test(f.name));
          hits.innerHTML = ok.length ? ok.slice(0, 20).map((f) => UI.listItem(esc(f.name), esc(f.label), { attrs: 'data-fq-pickf="' + esc(f.id) + '"' })).join('') : '<span class="muted">No table files match.</span>';
          hits.querySelectorAll('[data-fq-pickf]').forEach((b) => b.addEventListener('click', () => { hits.querySelectorAll('[data-fq-pickf]').forEach((x) => x.classList.toggle('active', x === b)); choose(b.dataset.fqPickf); }));
        }).catch((err) => { hits.innerHTML = UI.notice(esc(err.message), 'danger'); }), 250);
      });
      m.querySelectorAll('[data-fq-pickq]').forEach((b) => b.addEventListener('click', async () => {
        App.closeOverlay();
        const q = qs.find((x) => x.id === b.dataset.fqPickq);
        try { const p = await App.post('/api/files/queries/preview', { definition: { source: { kind: 'query', queryId: q.id }, steps: [] }, limit: 1 }); done({ kind: 'query', queryId: q.id }, p.columns.map((c) => c.name), 'Query: ' + q.name); }
        catch (err) { App.fail(err, 'Could not read the query'); }
      }));
      use.addEventListener('click', () => {
        if (!chosen) return;
        const sel = m.querySelector('[data-fq-sheet]'); const name = sel ? sel.value : null;
        const sh = chosen.tables.sheets.find((s) => s.name === name) || chosen.tables.sheets[0];
        App.closeOverlay();
        done({ kind: 'file', fileId: chosen.file.id, sheet: name || null, header: m.querySelector('[data-fq-hdr]').checked }, sh.columns, chosen.file.name + (name ? ' › ' + name : ''));
      });
    } });
  }

  function mergeDialog(ctx, init, at) {
    const st = ctx.state;
    const open = (source, otherCols, label) => {
      const i = init || { left: [selCols(st)[0] || colNames(st)[0]], right: [], kind: 'left', prefix: '' };
      const pair = (k) => '<div class="hstack gap6 fq-row">' + UI.field('This table ' + (k + 1), UI.select([{ value: '', label: '(none)' }].concat(colOptions(st, i.left[k])), i.left[k] || '', 'data-fq-l="' + k + '"')) + UI.field(esc(label) + ' ' + (k + 1), UI.select([{ value: '', label: '(none)' }].concat(otherCols.map((n) => ({ value: n, label: n }))), i.right[k] || (k === 0 && otherCols.indexOf(i.left[0]) >= 0 ? i.left[0] : ''), 'data-fq-r="' + k + '"')) + '</div>';
      dialog(ctx, 'Merge with ' + label, '<p class="fg2" style="margin:0">Rows match where the key columns are equal.</p>' + [0, 1, 2].map(pair).join('') + '<div class="formgrid">' + UI.field('Join kind', UI.select(JOINS.map((x) => ({ value: x[0], label: x[1] })), i.kind, 'data-fq-jk')) + UI.field('Prefix for its columns', UI.input(i.prefix != null ? i.prefix : '', { attrs: 'data-fq-px maxlength="60"', placeholder: 'e.g. Customer.' }), 'Needed when both tables have a column with the same name.') + '</div>' + UI.check('Match text case', i.caseSensitive !== false, 'data-fq-mcase'), (m) => {
        const left = []; const right = [];
        [0, 1, 2].forEach((k) => { const l = m.querySelector('[data-fq-l="' + k + '"]').value; const r = m.querySelector('[data-fq-r="' + k + '"]').value; if (l && r) { left.push(l); right.push(r); } });
        need(left.length, 'Pair at least one key column of each table.');
        const px = m.querySelector('[data-fq-px]').value;
        addStep(ctx, Object.assign({ op: 'merge', source, left, right, kind: m.querySelector('[data-fq-jk]').value, caseSensitive: m.querySelector('[data-fq-mcase]').checked }, px ? { prefix: px } : {}), at);
      }, { wide: true });
    };
    if (init) { sourceName(init.source).then((name) => App.post('/api/files/queries/preview', { definition: { source: init.source, steps: [] }, limit: 1 }).then((p) => open(init.source, p.columns.map((c) => c.name), name))).catch((err) => App.fail(err, 'Could not read the other table')); return; }
    pickSource(ctx, 'Merge queries: choose the second table', open);
  }
  function appendDialog(ctx) {
    pickSource(ctx, 'Append queries: choose a table to add below', (source, cols, label) => { addStep(ctx, { op: 'append', sources: [source] }); ctx.toast('Appended ' + esc(label) + '. Columns are matched by name.', 'ok'); });
  }

  function advancedEditor(ctx) {
    const st = ctx.state;
    dialog(ctx, 'Advanced editor', '<p class="fg2" style="margin:0">The query as JSON: its source and applied steps. The server checks it when you apply it.</p>' + UI.textarea(JSON.stringify(st.def, null, 2), { attrs: 'data-fq-json class="textarea fq-mono" spellcheck="false" aria-label="Query definition"', rows: 18 }), (m) => {
      let def; try { def = JSON.parse(m.querySelector('[data-fq-json]').value); } catch (e) { throw new Error('The JSON is not valid: ' + e.message); }
      need(def && def.source && Array.isArray(def.steps || []), 'The query needs a source and a list of steps.');
      st.def = { source: def.source, steps: def.steps || [] }; st.sel = st.def.steps.length - 1; markDirty(st); refresh(ctx);
      sourceName(st.def.source).then((n) => { st.sourceName = n; ctx.rerender(); });
    }, { wide: true, ok: 'Apply' });
  }

  const EDITORS = {
    'keep-columns': (ctx, s, i) => chooseColumns(ctx, s, i), 'keep-rows': (ctx, s, i) => rowsDialog(ctx, 'keep-rows', s, i), 'remove-rows': (ctx, s, i) => rowsDialog(ctx, 'remove-rows', s, i),
    sort: (ctx, s, i) => sortDialog(ctx, s, i), 'change-type': (ctx, s, i) => typeDialog(ctx, s, i), rename: (ctx, s, i) => renameDialog(ctx, s, i), replace: (ctx, s, i) => replaceDialog(ctx, s, i),
    split: (ctx, s, i) => splitDialog(ctx, s, i), text: (ctx, s, i) => textDialog(ctx, s, i), number: (ctx, s, i) => numberDialog(ctx, s, i), 'replace-empty': (ctx, s, i) => replaceEmptyDialog(ctx, s, i),
    filter: (ctx, s, i) => filterDialog(ctx, null, s, i), group: (ctx, s, i) => groupDialog(ctx, s, i), pivot: (ctx, s, i) => pivotDialog(ctx, s, i), custom: (ctx, s, i) => customDialog(ctx, s, i),
    conditional: (ctx, s, i) => conditionalDialog(ctx, s, i), index: (ctx, s, i) => indexDialog(ctx, s, i), 'merge-columns': (ctx, s, i) => mergeColumnsDialog(ctx, s, i), merge: (ctx, s, i) => mergeDialog(ctx, s, i)
  };

  // ---------- saving and loading ----------
  async function save(ctx, then) {
    const st = ctx.state;
    if (st.demo) { ctx.toast('This is a sample query; open a file from Files to build one.', 'warn'); return false; }
    if (!st.query.id) {
      return new Promise((resolve) => {
        dialog(ctx, 'Save query', UI.field('Name', UI.input(st.query.name || 'Query', { attrs: 'data-fq-qn maxlength="200"' })) + UI.field('Description', UI.input(st.query.description || '', { attrs: 'data-fq-qd maxlength="2000"' })), (m) => {
          const name = m.querySelector('[data-fq-qn]').value.trim(); need(name, 'Give the query a name.');
          App.post('/api/files/queries', { name, description: m.querySelector('[data-fq-qd]').value.trim() || null, definition: st.def }).then((q) => {
            st.query = q; st.dirty = false; ctx.toast('Saved the query ' + esc(q.name) + '.', 'ok'); loadQueries(ctx);
            // The address names the saved query without a route change (which would close the next dialog).
            history.replaceState(null, '', '#/' + ID + '?query=' + enc(q.id)); App.state.params = { query: q.id }; st.key = routeKey({ query: q.id });
            ctx.rerender(); resolve(true); if (then) then();
          }).catch((err) => { App.fail(err, 'Could not save the query'); resolve(false); });
        }, { ok: 'Save' });
      });
    }
    st.saving = true; ctx.rerender();
    let ok = false;
    try { st.query = await App.patch('/api/files/queries/' + enc(st.query.id), { name: st.query.name, definition: st.def }); st.dirty = false; ok = true; ctx.toast('Saved.', 'ok'); loadQueries(ctx); }
    catch (err) { App.fail(err, 'Could not save the query'); }
    st.saving = false; ctx.rerender();
    if (ok && then) then();
    return ok;
  }

  function loadDialog(ctx) {
    const st = ctx.state;
    if (st.preview && st.preview.error) { ctx.toast('The query stops at step ' + (st.preview.error.step + 1) + '. Fix or delete that step before loading.', 'danger'); return; }
    const go = () => {
      const files = App.stateFor('files'); const folderId = files && files.data && files.data.folder ? files.data.folder.id : null;
      const out = st.query.output;
      ctx.modal({ title: 'Close and load to', cls: 'wide', body: '<div role="radiogroup" aria-label="Where" class="vstack gap6">'
        + '<label class="check"><input type="radio" name="fq-where" value="new" checked><span>A new file</span></label>'
        + '<label class="check"><input type="radio" name="fq-where" value="existing"><span>A sheet of an existing workbook (replaced when the sheet exists)</span></label></div>'
        + '<div data-fq-w="new" class="formgrid">' + UI.field('File name', UI.input(st.query.name, { attrs: 'data-fq-fn maxlength="255"' })) + UI.field('Format', UI.select([{ value: 'xlsx', label: 'Excel workbook (.xlsx)' }, { value: 'ods', label: 'OpenDocument spreadsheet (.ods)' }, { value: 'csv', label: 'CSV (.csv)' }], 'xlsx', 'data-fq-fk')) + UI.field('Sheet name', UI.input(st.query.name.slice(0, 31), { attrs: 'data-fq-sn maxlength="31"' })) + '</div>'
        + '<div data-fq-w="existing" hidden class="vstack gap6">' + UI.search('Search workbooks by name', 'data-fq-wq') + '<div data-fq-whits class="vstack gap4" aria-live="polite">' + (out ? UI.listItem('The file it was last loaded into', esc(out.sheet), { attrs: 'data-fq-wf="' + esc(out.fileId) + '"' }) : '') + '</div>' + UI.field('Sheet name', UI.input((out && out.sheet) || st.query.name.slice(0, 31), { attrs: 'data-fq-wsn maxlength="31"' })) + '</div>'
        + '<p class="muted" style="font-size:12px;margin:0">The result is written as a new version and scanned like an upload. Its label is at least ' + esc((st.preview && st.preview.label) || st.query.label) + ', the highest label of the files it reads. Refresh writes the same place again.</p>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Load', { kind: 'primary', attrs: 'data-fq-load' }), onMount(m) {
        let fileId = null; let timer = null;
        m.querySelectorAll('input[name="fq-where"]').forEach((r) => r.addEventListener('change', () => { m.querySelectorAll('[data-fq-w]').forEach((p) => { p.hidden = p.dataset.fqW !== r.value || !r.checked; }); }));
        const hits = m.querySelector('[data-fq-whits]');
        const wire = () => hits.querySelectorAll('[data-fq-wf]').forEach((b) => b.addEventListener('click', () => { fileId = b.dataset.fqWf; hits.querySelectorAll('[data-fq-wf]').forEach((x) => x.classList.toggle('active', x === b)); }));
        wire();
        m.querySelector('[data-fq-wq]').addEventListener('input', (e) => {
          const q = e.target.value.trim(); if (timer) clearTimeout(timer); if (!q) return;
          timer = setTimeout(() => App.get('/api/files/search?q=' + enc(q)).then((rs) => { const ok = rs.filter((f) => /\.(xlsx|ods|csv)$/i.test(f.name)); hits.innerHTML = ok.length ? ok.slice(0, 20).map((f) => UI.listItem(esc(f.name), esc(f.label), { attrs: 'data-fq-wf="' + esc(f.id) + '"' })).join('') : '<span class="muted">No .xlsx, .ods or .csv files match.</span>'; wire(); }).catch(() => {}), 250);
        });
        m.querySelector('[data-fq-load]').addEventListener('click', async () => {
          const where = m.querySelector('input[name="fq-where"]:checked').value;
          let target;
          if (where === 'new') { const name = m.querySelector('[data-fq-fn]').value.trim(); if (!name) { ctx.toast('Give the file a name.', 'warn'); return; } target = { mode: 'new', name, kind: m.querySelector('[data-fq-fk]').value, folderId, sheet: m.querySelector('[data-fq-sn]').value.trim() || undefined }; }
          else { if (!fileId) { ctx.toast('Choose a workbook.', 'warn'); return; } target = { mode: 'existing', fileId, sheet: m.querySelector('[data-fq-wsn]').value.trim() || undefined }; }
          const btn = m.querySelector('[data-fq-load]'); btn.disabled = true; btn.textContent = 'Loading…';
          try {
            const r = await App.post('/api/files/queries/' + enc(st.query.id) + '/load', { target });
            App.closeOverlay(); st.query = r.query; ctx.rerender();
            ctx.toast('Loaded ' + plural(r.rows, 'row') + ' into ' + esc(r.file.name) + ' › ' + esc(r.sheet) + ' (version ' + esc(r.version) + ').', 'ok', 7000);
          } catch (err) { btn.disabled = false; btn.textContent = 'Load'; App.fail(err, 'Could not load the query'); }
        });
      } });
    };
    if (!st.query.id || st.dirty) save(ctx, go); else go();
  }

  async function refreshOutput(ctx) {
    const st = ctx.state;
    if (st.dirty && !(await save(ctx))) return;
    try { const r = await App.post('/api/files/queries/' + enc(st.query.id) + '/refresh', {}); st.query = r.query; ctx.toast('Refreshed ' + esc(r.file.name) + ' › ' + esc(r.sheet) + ': ' + plural(r.rows, 'row') + ', version ' + esc(r.version) + '.', 'ok', 6000); ctx.rerender(); }
    catch (err) { App.fail(err, 'Could not refresh'); }
  }

  // ---------- drawing ----------
  const STYLE = '<style>'
    + '#main .fq-page{gap:12px}'
    + '#main .fq-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);gap:12px;align-items:start}'
    + '#main .fq-layout>aside.inspector{width:auto;min-width:0;border:1px solid var(--line);border-radius:8px}'
    + '@media (max-width:900px){#main .fq-layout{grid-template-columns:minmax(0,1fr)}}'
    + '#main .fq-ribbon{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}'
    + '#main .fq-sep{width:1px;align-self:stretch;background:var(--line);margin:0 4px}'
    + '#main .fq-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}#main .fq-bar .fq-step{font-family:var(--mono);color:var(--fg2);overflow-wrap:anywhere}'
    + '#main .fq-gridwrap{overflow:auto;max-height:62vh;max-width:100%;border:1px solid var(--line);border-radius:8px;background:var(--panel)}'
    + '#main .fq-grid{border-collapse:separate;border-spacing:0;font-size:13px}'
    + '#main .fq-grid th,#main .fq-grid td{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:3px 8px;min-width:80px;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;color:var(--fg)}'
    + '#main .fq-grid thead th{position:sticky;top:0;z-index:2;background:var(--panel2);padding:0}'
    + '#main .fq-grid thead th.sel{background:var(--accent-tint);box-shadow:inset 0 -2px 0 var(--accent)}'
    + '#main .fq-grid .fq-h{display:flex;align-items:center;gap:4px;padding:3px 4px 3px 8px}#main .fq-grid .fq-hb{all:unset;cursor:pointer;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:600}#main .fq-grid .fq-hb:focus-visible{outline:2px solid var(--accent)}'
    + '#main .fq-grid .fq-ty{font-family:var(--mono);font-size:10px;color:var(--fg2);border:1px solid var(--line);border-radius:3px;padding:0 3px;flex-shrink:0}'
    + '#main .fq-grid .fq-q{font-size:11px;font-weight:400;color:var(--fg2);padding:0 8px 3px;display:block}'
    + '#main .fq-grid .rn{position:sticky;left:0;z-index:1;background:var(--panel2);min-width:44px;text-align:right;color:var(--fg2)}#main .fq-grid thead .rn{z-index:3;padding:3px 8px}'
    + '#main .fq-grid td.num{text-align:right;font-variant-numeric:tabular-nums}#main .fq-grid td.nul{color:var(--fg2);font-style:italic}#main .fq-grid td.sel{background:var(--accent-tint)}'
    + '#main .fq-steps{display:flex;flex-direction:column;gap:2px}'
    + '#main .fq-stepi{display:flex;align-items:center;gap:2px;border-radius:6px}#main .fq-stepi.active{background:var(--accent-tint)}#main .fq-stepi .listlink{flex:1;min-width:0}#main .fq-stepi .listlink .t{overflow-wrap:anywhere}'
    + '#main .fq-stepi.bad .t{color:var(--danger-fg)}'
    + '.modal .fq-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,200px),1fr));gap:4px;max-height:300px;overflow:auto;padding:4px 0}'
    + '.modal .fq-row{align-items:end;flex-wrap:wrap}.modal .fq-row .field{flex:1 1 160px;min-width:0}'
    + '.modal .fq-mono{font-family:var(--mono);font-size:13px;width:100%;box-sizing:border-box}.modal .fq-insert{display:flex;flex-wrap:wrap;gap:4px}'
    + '</style>';

  function ribbon(st) {
    const b = (label, attr, opts) => UI.btn(label, Object.assign({ size: 'xs', kind: 'ghost', attrs: 'data-fq-cmd="' + attr + '"' }, opts || {}));
    const sep = '<span class="fq-sep" aria-hidden="true"></span>';
    const tabs = '<div role="tablist" aria-label="Ribbon" class="tabs">' + [['home', 'Home'], ['transform', 'Transform'], ['add', 'Add column']].map((t) => '<button type="button" role="tab" data-fq-tab="' + t[0] + '" aria-selected="' + (st.tab === t[0] ? 'true' : 'false') + '" tabindex="' + (st.tab === t[0] ? '0' : '-1') + '" class="' + (st.tab === t[0] ? 'active' : '') + '">' + t[1] + '</button>').join('') + '</div>';
    let body;
    if (st.tab === 'transform') body = b('Data type', 'type') + b('Detect data types', 'detect') + b('Rename', 'rename') + sep + b('Replace values', 'replace') + b('Replace empty', 'replace-empty') + b('Fill down', 'fill-down') + b('Fill up', 'fill-up') + sep + b('Split column', 'split') + b('Format', 'text') + b('Calculate', 'number') + sep + b('Pivot column', 'pivot') + b('Unpivot columns', 'unpivot') + b('Unpivot other columns', 'unpivot-others') + b('Transpose', 'transpose') + b('Use first row as headers', 'promote') + b('Use headers as first row', 'demote');
    else if (st.tab === 'add') body = b('Custom column', 'custom') + b('Conditional column', 'conditional') + b('Index column', 'index') + b('Duplicate column', 'duplicate') + b('Merge columns', 'merge-columns');
    else body = b('Choose columns', 'choose') + b('Remove columns', 'remove-cols') + b('Remove other columns', 'remove-others') + sep + b('Keep rows', 'keep-rows') + b('Remove rows', 'remove-rows') + b('Remove duplicates', 'distinct') + b('Remove blank rows', 'remove-blank') + sep + b('Sort', 'sort') + b('Filter', 'filter') + b('Group by', 'group') + sep + b('Merge queries', 'merge') + b('Append queries', 'append') + sep + b('Advanced editor', 'advanced');
    return tabs + '<div class="fq-ribbon" role="toolbar" aria-label="' + esc(st.tab === 'add' ? 'Add column' : st.tab === 'transform' ? 'Transform' : 'Home') + '">' + body + '</div>';
  }

  function gridHtml(st) {
    const p = st.preview; const cols = p.columns; const sel = selCols(st);
    const quality = {}; (p.profile || []).forEach((q) => { quality[q.column] = q; });
    let h = '<table class="fq-grid" aria-label="Preview of the result" aria-rowcount="' + (p.rowCount + 1) + '"><thead><tr><th scope="col" class="rn"><span class="sr">Row</span></th>';
    cols.forEach((c) => {
      const on = sel.indexOf(c.name) >= 0; const q = quality[c.name];
      h += '<th scope="col" class="' + (on ? 'sel' : '') + '" aria-sort="none"><span class="fq-h"><span class="fq-ty" title="Type: ' + esc(c.type) + '">' + esc(TYPE_ICON[c.type] || c.type) + '</span><button type="button" class="fq-hb" data-fq-col="' + esc(c.name) + '" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + esc(c.name) + ', ' + esc(c.type) + '. Click to select; Ctrl or Shift to add.">' + esc(c.name) + '</button><span class="relative">' + UI.iconbtn('chevd', 'Column menu of ' + c.name, { attrs: 'data-fq-cmenu="' + esc(c.name) + '" aria-haspopup="menu"', cls: 'sm ghost', size: 12 }) + '</span></span>'
        + (q ? '<span class="fq-q">' + esc(plural(q.distinct, 'distinct value')) + (q.empty ? ', ' + esc(q.empty) + ' empty' : '') + '</span>' : '') + '</th>';
    });
    h += '</tr></thead><tbody>';
    p.rows.forEach((r, i) => {
      h += '<tr><th scope="row" class="rn">' + (p.offset + i + 1) + '</th>';
      cols.forEach((c, j) => { const v = r[j]; h += '<td class="' + (v == null ? 'nul ' : typeof v === 'number' ? 'num ' : '') + (sel.indexOf(c.name) >= 0 ? 'sel' : '') + '">' + (v == null ? 'null' : esc(shown(v))) + '</td>'; });
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }

  function stepsHtml(st) {
    const s = steps(st); const err = st.preview && st.preview.error;
    const warnAt = {}; ((st.preview && st.preview.warnings) || []).forEach((w) => { (warnAt[w.step] = warnAt[w.step] || []).push(w.message); });
    const item = (i, title, editable) => '<div role="listitem" class="fq-stepi' + (st.sel === i ? ' active' : '') + (err && err.step === i ? ' bad' : '') + '">' + UI.listItem(esc(title), err && err.step === i ? esc(err.message) : warnAt[i] ? esc(warnAt[i].join(' ')) : '', { active: st.sel === i, attrs: 'data-fq-sel="' + i + '" aria-current="' + (st.sel === i ? 'step' : 'false') + '"' })
      + (i >= 0 ? (editable ? UI.iconbtn('edit', 'Edit step ' + (i + 2), { attrs: 'data-fq-edit="' + i + '"', cls: 'sm ghost', size: 13 }) : '') + (i > 0 ? UI.btn('↑', { size: 'xs', kind: 'ghost', attrs: 'data-fq-up="' + i + '" aria-label="Move step ' + (i + 2) + ' up" title="Move up"' }) : '') + UI.iconbtn('x', 'Delete step ' + (i + 2), { attrs: 'data-fq-del="' + i + '"', cls: 'sm ghost', size: 13 }) : '') + '</div>';
    return '<div class="fq-steps" role="list" aria-label="Applied steps">' + item(-1, 'Source: ' + (st.sourceName || 'the source table'), false) + s.map((x, i) => item(i, stepTitle(x), !!EDITORS[x.op])).join('') + '</div>';
  }

  function headerHtml(st) {
    const q = st.query; const p = st.preview;
    const sub = UI.label((p && p.label) || q.label || 'internal', { sm: true }) + ' ' + UI.pill('Table query', 'outline') + (p ? ' <span class="muted">' + esc(plural(p.rowCount, 'row')) + ', ' + esc(plural(p.columns.length, 'column')) + '</span>' : '')
      + (st.dirty ? ' ' + UI.pill('Unsaved changes', 'warn') : '') + (q.output ? ' <span class="muted">loaded into a file' + (q.refreshedAt ? ', refreshed ' + esc(new Date(q.refreshedAt).toLocaleString()) : '') + '</span>' : '') + (q.refreshError ? ' ' + UI.pill('Last refresh failed', 'danger') : '') + (st.demo ? ' ' + UI.pill('Sample', 'info') : '');
    const actions = UI.btn('Back to Files', { kind: 'ghost', attrs: 'data-fq-back' }) + UI.btn('Rename', { attrs: 'data-fq-rename' }) + (q.id ? UI.btn('Delete query', { kind: 'ghost', attrs: 'data-fq-delete' }) : '') + (q.output ? UI.btn('Refresh', { icon: 'refresh', attrs: 'data-fq-refresh' }) : '') + UI.btn(st.saving ? 'Saving…' : 'Save', { attrs: 'data-fq-save', disabled: st.saving }) + UI.btn('Close and load…', { kind: 'primary', attrs: 'data-fq-loadto' });
    return UI.pagehead(q.name || 'Table query', sub, actions);
  }

  function sidePane(st) {
    const qs = st.queries;
    return '<aside class="inspector vstack gap12" aria-label="Query settings">'
      + '<div class="eyebrow">Applied steps</div>' + stepsHtml(st)
      + '<span class="muted" style="font-size:12px">Select a step to see the table after it; new steps go after the selected one.</span>'
      + '<div class="divider"></div><div class="hstack"><div class="eyebrow grow">Queries in this workspace</div>' + UI.btn('New', { size: 'xs', icon: 'plus', attrs: 'data-fq-new' }) + '</div>'
      + (qs == null ? '<span class="muted">Loading…</span>' : qs.length ? '<div class="vstack gap4">' + qs.map((q) => UI.listItem(esc(q.name), esc(q.label) + (q.refreshError ? ', refresh failed' : q.output ? ', loaded' : ''), { active: st.query && st.query.id === q.id, attrs: 'data-fq-open="' + esc(q.id) + '"' })).join('') + '</div>' : '<span class="muted" style="font-size:12px">No saved queries yet.</span>')
      + '</aside>';
  }

  function bodyHtml(st) {
    const p = st.preview; const err = p && p.error; const s = steps(st);
    let main = ribbon(st);
    const cur = st.sel >= 0 ? stepTitle(s[st.sel]) : 'Source: ' + (st.sourceName || '');
    main += '<div class="fq-bar"><span class="eyebrow">Step ' + (st.sel + 2) + ' of ' + (s.length + 1) + '</span><span class="fq-step" aria-live="polite">' + esc(cur) + '</span>' + (st.previewing ? '<span class="muted">Running…</span>' : '') + '</div>';
    if (st.previewError) main += UI.notice('<b>' + esc(st.previewError.problem && st.previewError.problem.title ? st.previewError.problem.title : 'The query could not run') + '.</b> ' + esc(st.previewError.message), 'danger');
    if (err) main += UI.notice('<b>Step ' + (err.step + 2) + ' stops the query.</b> ' + esc(err.message) + ' The table before it is shown.', 'danger', UI.btn('Go to step', { size: 'sm', kind: 'ghost', attrs: 'data-fq-sel="' + err.step + '"' }));
    if (p && p.columns) {
      main += '<div class="fq-gridwrap" role="region" aria-label="Result rows, scrollable" tabindex="0">' + gridHtml(st) + '</div>';
      const end = p.offset + p.rows.length;
      main += '<div class="hstack gap6 wrap"><span class="muted" style="font-size:12px">Rows ' + (p.rows.length ? p.offset + 1 : 0) + ' to ' + end + ' of ' + p.rowCount.toLocaleString('en-US') + '. ' + (selCols(st).length ? 'Selected: ' + esc(selCols(st).join(', ')) + '.' : 'Click a column header to select it.') + '</span>'
        + UI.btn('Previous rows', { size: 'xs', attrs: 'data-fq-page="-1"', disabled: p.offset === 0 }) + UI.btn('Next rows', { size: 'xs', attrs: 'data-fq-page="1"', disabled: end >= p.rowCount }) + '</div>';
    } else if (!st.previewError) main += UI.notice('Running the query…', 'info');
    return '<div class="fq-layout"><div class="vstack gap8" style="min-width:0">' + main + '</div>' + sidePane(st) + '</div>';
  }

  function navigatorHtml(st) {
    const t = st.nav;
    return UI.pagehead('Choose a table', esc(t.file.name) + ' ' + UI.label(t.label, { sm: true }), UI.btn('Back to Files', { kind: 'ghost', attrs: 'data-fq-back' }))
      + '<p class="fg2" style="margin:0">' + esc(t.file.name) + ' has ' + t.sheets.length + ' sheets. Choose the one the query starts from; other sheets can be merged or appended later.</p>'
      + UI.table(['Sheet', 'Rows', 'Columns', { label: '', srLabel: 'Actions' }], t.sheets.map((s, i) => [esc(s.name), '<span class="num">' + esc(s.rows) + '</span>', esc(s.columns.slice(0, 8).join(', ') + (s.columns.length > 8 ? ', …' : '')), UI.btn('Use ' + s.name, { size: 'xs', kind: 'primary', attrs: 'data-fq-nav="' + i + '"' })]), { clickable: false, minWidth: '0' });
  }

  // ---------- commands ----------
  function command(ctx, cmd) {
    const st = ctx.state; const cols = () => needCols(ctx);
    switch (cmd) {
      case 'choose': return chooseColumns(ctx);
      case 'remove-cols': { const c = cols(); if (c) addStep(ctx, { op: 'remove-columns', columns: c }); return; }
      case 'remove-others': { const c = cols(); if (c) addStep(ctx, { op: 'keep-columns', columns: c }); return; }
      case 'keep-rows': return rowsDialog(ctx, 'keep-rows');
      case 'remove-rows': return rowsDialog(ctx, 'remove-rows');
      case 'remove-blank': return addStep(ctx, { op: 'remove-rows', mode: 'blank', count: 0, keep: 1 });
      case 'distinct': return addStep(ctx, { op: 'distinct', columns: selCols(st) });
      case 'sort': return sortDialog(ctx);
      case 'filter': return filterDialog(ctx);
      case 'group': return groupDialog(ctx);
      case 'merge': return mergeDialog(ctx);
      case 'append': return appendDialog(ctx);
      case 'advanced': return advancedEditor(ctx);
      case 'type': return typeDialog(ctx);
      case 'detect': {
        App.post('/api/files/queries/detect', { definition: st.def, upto: st.sel + 1, queryId: (st.query && st.query.id) || undefined }).then((d) => {
          const want = selCols(st); const pick = (d.columns || []).filter((c) => !want.length || want.indexOf(c.column) >= 0);
          if (!pick.length) { ctx.toast('No columns to type.', 'warn'); return; }
          addStep(ctx, { op: 'change-type', columns: pick.map((c) => ({ column: c.column, type: c.type })) });
        }).catch((err) => App.fail(err, 'Could not detect the types'));
        return;
      }
      case 'rename': return renameDialog(ctx);
      case 'replace': return replaceDialog(ctx);
      case 'replace-empty': return replaceEmptyDialog(ctx);
      case 'fill-down': case 'fill-up': { const c = cols(); if (c) addStep(ctx, { op: 'fill', columns: c, direction: cmd === 'fill-up' ? 'up' : 'down' }); return; }
      case 'split': return splitDialog(ctx);
      case 'text': return textDialog(ctx);
      case 'number': return numberDialog(ctx);
      case 'pivot': return pivotDialog(ctx);
      case 'unpivot': return unpivot(ctx, false);
      case 'unpivot-others': return unpivot(ctx, true);
      case 'transpose': return addStep(ctx, { op: 'transpose' });
      case 'promote': return addStep(ctx, { op: 'promote-headers' });
      case 'demote': return addStep(ctx, { op: 'demote-headers' });
      case 'custom': return customDialog(ctx);
      case 'conditional': return conditionalDialog(ctx);
      case 'index': return indexDialog(ctx);
      case 'duplicate': return duplicateDialog(ctx);
      case 'merge-columns': return mergeColumnsDialog(ctx);
    }
  }

  function columnMenu(ctx, anchor, name) {
    const st = ctx.state; st.cols = [name];
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const items = [['asc', 'Sort ascending'], ['desc', 'Sort descending'], ['filter', 'Filter…'], ['type', 'Change type…'], ['rename', 'Rename…'], ['remove-cols', 'Remove'], ['remove-others', 'Remove other columns'], ['duplicate', 'Duplicate column…'], ['replace', 'Replace values…'], ['fill-down', 'Fill down'], ['split', 'Split column…'], ['group', 'Group by…'], ['unpivot-others', 'Unpivot other columns']];
    const d = document.createElement('div'); d.className = 'dropdown'; d.setAttribute('role', 'menu');
    d.innerHTML = items.map((it) => '<button type="button" role="menuitem" data-v="' + it[0] + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    const first = d.querySelector('button'); if (first) first.focus();
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { d.remove(); anchor.focus(); } });
    d.addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return; d.remove();
      const v = b.dataset.v;
      if (v === 'asc' || v === 'desc') addStep(ctx, { op: 'sort', keys: [{ column: name, desc: v === 'desc' }] });
      else if (v === 'filter') filterDialog(ctx, name);
      else command(ctx, v);
    });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  function wire(ctx) {
    const st = ctx.state;
    const leave = async () => {
      if (st.dirty && !st.demo) { const ok = await ctx.confirm({ title: 'Leave without saving', tone: 'danger', body: '<p class="fg2" style="margin:0">The changes to this query are not saved.</p>', ok: 'Leave', cancel: 'Stay' }); if (!ok) return; }
      st.dirty = false; ctx.navigate('files');
    };
    ctx.on('click', '[data-fq-back]', leave);
    if (st.nav) {
      ctx.on('click', '[data-fq-nav]', async (e, t) => { const s = st.nav.sheets[+t.dataset.fqNav]; const f = st.nav.file; st.nav = null; await begin(st, { kind: 'file', fileId: f.id, sheet: s.name, header: true }, f.name + ' › ' + s.name); refresh(ctx); });
      return;
    }
    ctx.on('click', '[data-fq-tab]', (e, t) => { st.tab = t.dataset.fqTab; ctx.rerender(); const b = ctx.$('[data-fq-tab="' + st.tab + '"]'); if (b) b.focus(); });
    ctx.on('keydown', '[data-fq-tab]', (e, t) => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const ids = ['home', 'transform', 'add']; st.tab = ids[(ids.indexOf(t.dataset.fqTab) + (e.key === 'ArrowRight' ? 1 : 2)) % 3]; ctx.rerender(); const b = ctx.$('[data-fq-tab="' + st.tab + '"]'); if (b) b.focus(); });
    ctx.on('click', '[data-fq-cmd]', (e, t) => { if (st.demo && ['detect', 'filter', 'merge', 'append'].indexOf(t.dataset.fqCmd) >= 0) { ctx.toast('This is a sample query; open a file from Files to run steps.', 'warn'); return; } command(ctx, t.dataset.fqCmd); });
    ctx.on('click', '[data-fq-col]', (e, t) => { const n = t.dataset.fqCol; if (e.ctrlKey || e.metaKey || e.shiftKey) st.cols = st.cols.indexOf(n) >= 0 ? st.cols.filter((x) => x !== n) : st.cols.concat([n]); else st.cols = st.cols.length === 1 && st.cols[0] === n ? [] : [n]; ctx.rerender(); const b = ctx.$('[data-fq-col="' + CSS.escape(n) + '"]'); if (b) b.focus(); });
    ctx.on('click', '[data-fq-cmenu]', (e, t) => { e.stopPropagation(); columnMenu(ctx, t, t.dataset.fqCmenu); });
    ctx.on('click', '[data-fq-sel]', (e, t) => { st.sel = +t.dataset.fqSel; st.offset = 0; refresh(ctx); });
    ctx.on('click', '[data-fq-edit]', (e, t) => { const i = +t.dataset.fqEdit; const s = steps(st)[i]; const ed = EDITORS[s.op]; if (!ed) return; st.sel = i - 1; refresh(ctx).then(() => ed(ctx, clone(s), i)); });
    ctx.on('click', '[data-fq-up]', (e, t) => { const i = +t.dataset.fqUp; if (i <= 0) return; const s = steps(st); const x = s[i]; s[i] = s[i - 1]; s[i - 1] = x; st.sel = i - 1; markDirty(st); refresh(ctx); });
    ctx.on('click', '[data-fq-del]', async (e, t) => {
      const i = +t.dataset.fqDel; const s = steps(st);
      if (i < s.length - 1) { const ok = await ctx.confirm({ title: 'Delete step', tone: 'danger', body: '<p class="fg2" style="margin:0">' + esc(stepTitle(s[i])) + '. The steps after it will read the table without it, and may stop if they need what it made.</p>', ok: 'Delete step' }); if (!ok) return; }
      s.splice(i, 1); st.sel = Math.min(st.sel, s.length - 1); if (st.sel >= i) st.sel = Math.max(-1, st.sel - (st.sel === i ? 1 : 0)); markDirty(st); refresh(ctx);
    });
    ctx.on('click', '[data-fq-page]', (e, t) => { const p = st.preview; st.offset = Math.max(0, Math.min(p.rowCount - 1, p.offset + (+t.dataset.fqPage) * PAGE)); refresh(ctx); });
    ctx.on('click', '[data-fq-save]', () => save(ctx));
    ctx.on('click', '[data-fq-loadto]', () => { if (st.demo) { ctx.toast('This is a sample query; open a file from Files to load one.', 'warn'); return; } loadDialog(ctx); });
    ctx.on('click', '[data-fq-refresh]', () => refreshOutput(ctx));
    ctx.on('click', '[data-fq-rename]', () => dialog(ctx, 'Rename query', UI.field('Name', UI.input(st.query.name, { attrs: 'data-fq-qn maxlength="200"' })), (m) => { const n = m.querySelector('[data-fq-qn]').value.trim(); need(n, 'Give a name.'); st.query.name = n; markDirty(st); ctx.rerender(); }));
    ctx.on('click', '[data-fq-delete]', async () => {
      const ok = await ctx.confirm({ title: 'Delete query ' + esc(st.query.name), tone: 'danger', body: '<p class="fg2" style="margin:0">The query and its steps are deleted. Files it loaded stay as they are.</p>', ok: 'Delete query' }); if (!ok) return;
      try { await App.del('/api/files/queries/' + enc(st.query.id)); st.dirty = false; ctx.toast('Deleted the query.', 'ok'); ctx.navigate('files'); } catch (err) { App.fail(err, 'Could not delete the query'); }
    });
    const away = async (params) => {
      if (st.dirty && !st.demo) { const ok = await ctx.confirm({ title: 'Open without saving', tone: 'danger', body: '<p class="fg2" style="margin:0">The changes to ' + esc(st.query.name) + ' are not saved.</p>', ok: 'Open', cancel: 'Stay' }); if (!ok) return; }
      st.dirty = false; ctx.navigate(ID, params);
    };
    ctx.on('click', '[data-fq-open]', (e, t) => { if (!st.query || st.query.id !== t.dataset.fqOpen) away({ query: t.dataset.fqOpen }); });
    ctx.on('click', '[data-fq-new]', () => pickSource(ctx, 'New query: choose a table', (source) => away(source.kind === 'file' ? Object.assign({ file: source.fileId }, source.sheet ? { sheet: source.sheet } : {}) : { query: source.queryId })));
    ctx.on('keydown', '.fq-page', (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(ctx); } });
  }

  // ---------- states (sample query, no server needed) ----------
  function demo(ctx, extra) {
    const st = ctx.state; reset(st, App.state.params);
    Object.assign(st, { demo: true, loaded: true, query: clone(SAMPLE.query), def: clone(SAMPLE.def), sel: SAMPLE.def.steps.length - 1, preview: clone(SAMPLE.preview), queries: [], sourceName: SAMPLE.sourceName }, extra || {});
    ctx.rerender();
  }

  window.addEventListener('beforeunload', (e) => { const st = App.stateFor(ID); if (App.state.route === ID && st.dirty && !st.demo) { e.preventDefault(); e.returnValue = ''; } });

  App.register({
    id: ID, title: 'Table builder', live: true,
    summary: 'Power Query style queries over Excel, OpenDocument, CSV and JSON files: applied steps, merge and append, loaded into spreadsheets',
    crumb: (st) => ['Files', (st.query && st.query.name) || 'Table builder'],
    label: (st) => (st.preview && st.preview.label) || (st.query && st.query.label) || null,
    states: [
      { title: 'Grouped query', tone: 'ok', text: 'A query on a sheet with three applied steps: types changed, rows filtered, grouped by region with a sum and a count.', apply(ctx) { demo(ctx, { cols: ['Region'] }); } },
      { title: 'Step error', tone: 'danger', text: 'A step names a column an earlier step removed. The query stops there, the table before it is shown, and the step is marked in Applied steps.',
        apply(ctx) { const p = clone(SAMPLE.preview); p.error = { step: 2, message: 'There is no column Amount. Columns: Region, Rep, Total.' }; p.applied = 2; demo(ctx, { preview: p, dirty: true }); } }
    ],
    render(root, ctx) {
      const st = ctx.state; const params = ctx.params || {};
      const key = routeKey(params);
      // Another query or file in the address: start again (leaving with unsaved changes is confirmed before navigating).
      if (st.key !== key && !(st.demo && !params.query && !params.file)) { reset(st, params); st.key = key; }
      const shell = (inner) => STYLE + '<div class="page fq-page">' + inner + '</div>';
      const back = UI.btn('Back to Files', { kind: 'ghost', attrs: 'data-fq-back' });
      if (!st.demo && !params.query && !params.file && !st.def) {
        root.innerHTML = shell(UI.pagehead('Table builder', 'Build a table from spreadsheets, CSV and JSON files with applied steps, then load it into a workbook.', back) + UI.empty('Start from a table', 'Choose a sheet of an Excel, OpenDocument or CSV file, a JSON file, or a saved query. In Files, a table file also has New table query.', UI.btn('Choose a table', { kind: 'primary', attrs: 'data-fq-new' })));
        ctx.on('click', '[data-fq-back]', () => ctx.navigate('files'));
        if (st.queries == null) loadQueries(ctx);
        ctx.on('click', '[data-fq-new]', () => pickSource(ctx, 'New query: choose a table', (source) => ctx.navigate(ID, source.kind === 'file' ? Object.assign({ file: source.fileId }, source.sheet ? { sheet: source.sheet } : {}) : { query: source.queryId })));
        return;
      }
      if (!st.demo && !st.loaded && !st.loading) start(ctx);
      if (st.error) {
        root.innerHTML = shell(UI.pagehead('Table builder', '', back) + UI.problem(st.error.status === 404 ? 'Not found' : 'The query could not be opened', st.error.message, st.error.problem && st.error.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-fq-retry' }) + '</div>');
        ctx.on('click', '[data-fq-back]', () => ctx.navigate('files'));
        ctx.on('click', '[data-fq-retry]', () => { reset(st, params); st.key = key; ctx.rerender(); });
        return;
      }
      if (st.nav) { root.innerHTML = shell(navigatorHtml(st)); wire(ctx); return; }
      if (!st.def || !st.query) { root.innerHTML = shell(UI.pagehead('Table builder', '', back) + UI.notice('Loading…', 'info')); ctx.on('click', '[data-fq-back]', () => ctx.navigate('files')); return; }
      root.innerHTML = shell(headerHtml(st) + bodyHtml(st));
      wire(ctx);
    }
  });
})();
