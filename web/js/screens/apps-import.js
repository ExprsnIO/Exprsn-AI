// Apps, imports into an entity (the low-code port's CSV mapping, extended in Sprint 45, B-127 and B-129, into a
// stepper): the file (uploaded to the file store, which quarantines and scans it), pasted text or a connection (a
// table, a saved query or a REST endpoint); the sheet, header row and range; the mapping with transformations and a
// live preview of 20 rows that the server computes (the same code as the job); the dry run with its per-row report;
// then the import with its progress, cancellation and the failed rows as CSV. "New entity from file" infers the fields
// from the same steps and creates the entity through the design routes. `apps.js` calls App.appsImportCsv(ctx, app,
// ent, deps) from the Records tab and App.appsEntityFromFile(ctx, app, deps) from the Entities tab.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;

  /** RFC 4180: rows of cells, quoted cells with doubled quotes and line breaks (kept for other screens). */
  function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.length > 1 || r[0] !== '');
  }
  const cellOut = (v) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  App.appsCsv = { parse: parseCsv, cell: cellOut };

  const KINDS = [
    { value: 'trim', label: 'Trim and collapse whitespace' },
    { value: 'case', label: 'Change case' },
    { value: 'split', label: 'Split a column' },
    { value: 'merge', label: 'Merge columns' },
    { value: 'fill-down', label: 'Fill down blanks' },
    { value: 'replace', label: 'Replace values' },
    { value: 'parse-date', label: 'Parse dates' },
    { value: 'parse-number', label: 'Parse numbers' },
    { value: 'default', label: 'Default for empty' },
    { value: 'drop-rows', label: 'Drop rows' },
    { value: 'dedupe', label: 'Remove duplicates' }
  ];
  const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY', 'DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY/MM/DD', 'D/M/YYYY', 'M/D/YYYY', 'DD/MM/YY', 'MM/DD/YY', 'YYYYMMDD'];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const TYPES = [{ value: 'string', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'integer', label: 'Whole number' }, { value: 'boolean', label: 'True or false' }, { value: 'date', label: 'Date' }, { value: 'datetime', label: 'Date and time' }, { value: 'enum', label: 'One of a list' }, { value: 'json', label: 'JSON' }];
  const kindLabel = (k) => { const x = KINDS.find((y) => y.value === k); return x ? x.label : k; };
  const cellText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

  function describe(t) {
    const cols = (t.columns || []).join(', ');
    switch (t.kind) {
      case 'trim': return 'Trim ' + cols + (t.collapse === false ? '' : ', inner spaces collapsed');
      case 'case': return 'Make ' + cols + ' ' + t.to + ' case';
      case 'split': return 'Split ' + t.column + ' at "' + t.delimiter + '" into ' + t.into.join(', ');
      case 'merge': return 'Merge ' + cols + ' into ' + t.into + ' with "' + t.separator + '"';
      case 'fill-down': return 'Fill down blanks in ' + cols;
      case 'replace': return 'Replace ' + Object.keys(t.map).length + ' value' + (Object.keys(t.map).length === 1 ? '' : 's') + ' in ' + cols;
      case 'parse-date': return 'Read ' + cols + ' as dates in ' + t.format;
      case 'parse-number': return 'Read ' + cols + ' as numbers with a decimal ' + (t.decimal === ',' ? 'comma' : 'point');
      case 'default': return 'Empty ' + cols + ' becomes "' + t.value + '"';
      case 'drop-rows': return 'Drop rows where ' + t.column + (t.when === 'empty' ? ' is empty' : ' is ' + t.values.join(' or '));
      case 'dedupe': return 'Keep the ' + t.keep + ' row per ' + cols;
      default: return t.kind;
    }
  }

  // A raw-body upload to the file store (App.api always sends JSON).
  async function putRaw(url, file) {
    let res;
    try { res = await fetch(url, { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': 'application/octet-stream', Accept: 'application/json' } }); }
    catch (e) { throw new App.ApiError({ status: 0, title: 'Network error', detail: 'The server could not be reached.' }); }
    const data = /json/.test(res.headers.get('content-type') || '') ? await res.json() : null;
    if (!res.ok) throw new App.ApiError(data || { status: res.status, title: res.statusText });
    return data;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fieldFrom(name, title, type, base) {
    const b = base || {};
    const common = { name, title: title || name, required: !!b.required, indexed: !!b.indexed || !!b.unique, unique: !!b.unique };
    if (type === 'string') return Object.assign(common, { type: 'string', maxLength: b.type === 'string' && b.maxLength ? b.maxLength : 255 }, b.type === 'string' && b.pattern ? { pattern: b.pattern } : {}, b.type === 'string' && b.multiline ? { multiline: true } : {});
    if (type === 'number' || type === 'integer') return Object.assign(common, { type: 'number', integer: type === 'integer' });
    if (type === 'boolean') return Object.assign(common, { type: 'boolean', unique: false, indexed: !!b.indexed });
    if (type === 'date' || type === 'datetime') return Object.assign(common, { type: 'date', withTime: type === 'datetime' });
    if (type === 'enum') return Object.assign(common, { type: 'enum', options: b.type === 'enum' ? b.options : [] });
    return Object.assign(common, { type: 'json', maxBytes: 10000, unique: false, indexed: false });
  }
  const typeOf = (f) => (f.type === 'number' ? (f.integer ? 'integer' : 'number') : f.type === 'date' ? (f.withTime ? 'datetime' : 'date') : f.type);

  /** The stepper; `ent` null is "new entity from file". */
  function open(ctx, app, ent, deps) {
    const isNew = !ent;
    const steps = isNew ? ['Source', 'Sheet and range', 'Fields', 'Create and import'] : ['Source', 'Sheet and range', 'Mapping', 'Dry run', 'Import'];
    const fields = ent ? (ent.definition.fields || []).filter((f) => f.type !== 'formula' && f.type !== 'ai') : [];
    const uniques = fields.filter((f) => f.unique);
    const canConn = App.can('connections:manage') || App.can('connections:query');
    const w = { step: 0, kind: 'file', label: 'internal', file: null, fileState: null, fileErr: null, text: '', format: '', sheet: '', headerRow: '', range: '', jsonPath: '', connKind: 'connection', conns: null, queries: null, rests: null, connId: '', object: '', keyColumn: '', queryId: '', restId: '', endpoint: '', params: {}, transforms: [], adding: '', mapping: {}, upsert: '', upsertMode: 'upsert', sourceKey: '', preview: null, previewErr: null, busy: false, dry: null, run: null, job: null, proposal: null, cols: [], entityName: '', entityTitle: '', entityLabel: '', titleField: '', cron: '0 6 * * *', err: null, seq: 0 };
    let root = null;
    let timer = null;

    const source = () => {
      const opts = {};
      if (w.format) opts.format = w.format;
      if (w.sheet) opts.sheet = w.sheet;
      if (w.headerRow) opts.headerRow = Number(w.headerRow);
      if (w.range.trim()) opts.range = w.range.trim();
      if (w.jsonPath.trim()) opts.jsonPath = w.jsonPath.trim();
      if (w.kind === 'file') return Object.assign({ kind: 'file', fileId: w.file && w.file.id }, opts);
      if (w.kind === 'text') return Object.assign({ kind: 'text', text: w.text }, opts);
      if (w.connKind === 'connection') return Object.assign({ kind: 'connection', connectionId: w.connId, object: w.object }, w.keyColumn ? { keyColumn: w.keyColumn } : {});
      if (w.connKind === 'saved-query') return { kind: 'saved-query', queryId: w.queryId, params: w.params };
      return { kind: 'rest', connectionId: w.restId, endpoint: w.endpoint, params: w.params };
    };
    const ready = () => (w.kind === 'file' ? !!(w.file && w.fileState === 'ready') : w.kind === 'text' ? !!w.text.trim() : w.connKind === 'connection' ? !!(w.connId && w.object) : w.connKind === 'saved-query' ? !!w.queryId : !!(w.restId && w.endpoint));
    const columns = () => (w.preview ? w.preview.columns : []);
    const mappingList = () => Object.keys(w.mapping).filter((c) => w.mapping[c] && columns().indexOf(c) >= 0).map((c) => ({ column: c, field: w.mapping[c] }));
    const guess = (h) => { const k = String(h || '').trim().toLowerCase(); if (k === 'label') return 'label'; const f = fields.find((x) => x.name.toLowerCase() === k || (x.title || '').toLowerCase() === k || x.name.toLowerCase() === k.replace(/[\s-]+/g, '_')); return f ? f.name : ''; };
    const spec = () => Object.assign({ source: source(), transforms: w.transforms, mapping: mappingList() }, w.upsert ? { upsert: { field: w.upsert, mode: w.upsertMode } } : {}, w.sourceKey ? { sourceKey: w.sourceKey } : {});
    const problem = (e) => '<b>' + esc(String(e.status || '')) + '</b> ' + esc(deps.detailOf(e));

    // ---------- server calls ----------

    async function refresh(withChecks) {
      const seq = ++w.seq;
      w.busy = true; draw();
      try {
        const body = { source: source(), transforms: w.transforms };
        if (withChecks && ent && mappingList().length) { body.entity = ent.id; body.mapping = mappingList(); }
        const out = await App.post('/api/apps/' + enc(app.id) + '/imports/preview', body);
        if (seq !== w.seq) return;
        w.preview = out; w.previewErr = null;
        if (out.source.sheet && !w.sheet) w.sheet = out.source.sheet;
        if (ent) out.columns.forEach((c) => { if (w.mapping[c] === undefined) w.mapping[c] = guess(c); });
      } catch (e) { if (seq !== w.seq) return; w.previewErr = e; }
      w.busy = false; draw();
    }
    const later = (withChecks) => { clearTimeout(timer); timer = setTimeout(() => refresh(withChecks), 400); };

    async function infer() {
      w.busy = true; w.err = null; draw();
      try {
        const p = await App.post('/api/apps/' + enc(app.id) + '/imports/infer', { source: source(), transforms: w.transforms });
        w.proposal = p;
        w.cols = p.columns.map((c) => ({ column: c.column, keep: !c.skip, name: c.name, title: c.title, type: typeOf(c.field), base: c.field, required: !!c.field.required, unique: !!c.field.unique, pii: c.pii, sample: c.sample, inferred: c.inferred }));
        if (!w.entityLabel) w.entityLabel = p.label;
        if (!w.titleField) w.titleField = p.titleField || '';
        if (!w.entityName) { const n = ((w.file && w.file.name) || 'imported').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); w.entityName = /^[a-z]/.test(n) ? n.slice(0, 60) : 'imported_' + n.slice(0, 50); }
      } catch (e) { w.err = e; }
      w.busy = false; draw();
    }

    async function upload(file) {
      w.fileErr = null; w.file = null; w.fileState = 'uploading'; w.preview = null; w.sheet = ''; draw();
      try {
        const out = await putRaw('/api/files/uploads?name=' + enc(file.name) + '&label=' + enc(w.label) + (app.workspaceId ? '&workspace=' + enc(app.workspaceId) : ''), file);
        w.file = { id: out.id, name: out.name }; w.fileState = 'quarantined'; draw();
        for (let i = 0; i < 60; i++) {
          await sleep(i < 5 ? 500 : 1500);
          const d = await App.get('/api/files/' + enc(out.id));
          if (d.state === 'ready' || d.state === 'rejected') { w.fileState = d.state; break; }
        }
        if (w.fileState === 'rejected') w.fileErr = 'The file store rejected ' + w.file.name + ' after its scan; see Files for the reason.';
      } catch (e) { w.fileState = null; w.fileErr = deps.detailOf(e); }
      draw();
    }

    async function loadConnections() {
      if (w.conns !== null) return;
      w.conns = []; w.queries = []; w.rests = [];
      const get = (url) => App.get(url).catch(() => []);
      const out = await Promise.all([App.can('connections:manage') ? get('/api/admin/connections') : [], get('/api/connection-queries'), get('/api/rest-connections')]);
      w.conns = out[0] || []; w.queries = out[1] || []; w.rests = out[2] || [];
      draw();
    }

    async function follow(t, key) {
      for (let i = 0; i < 600; i++) {
        let x;
        try { x = await App.get('/api/apps/transfers/' + enc(t.id)); } catch (e) { w[key] = { id: t.id, state: 'unknown', error: deps.detailOf(e) }; break; }
        w[key] = x;
        if (x.jobId && (x.state === 'running' || x.state === 'queued')) {
          try { const jobs = await App.get('/api/me/jobs'); w.job = jobs.find((j) => j.id === x.jobId) || null; } catch (e) { w.job = null; }
        }
        draw();
        if (['succeeded', 'failed', 'cancelled'].indexOf(x.state) >= 0) break;
        await sleep(i < 10 ? 600 : 1500);
      }
      deps.invalidate();
      draw();
    }

    async function queue(dryRun) {
      w.err = null; w.busy = true; draw();
      try {
        const out = await App.post('/api/apps/' + enc(app.id) + '/entities/' + enc(ent.id) + '/imports', Object.assign(spec(), { dryRun }));
        w.busy = false;
        ctx.toast((dryRun ? 'Dry run of ' : 'Import of ') + out.rows + ' rows queued (job apps.import). Audited app.import.queued.');
        await follow(out, dryRun ? 'dry' : 'run');
      } catch (e) { w.busy = false; w.err = e; draw(); }
    }

    async function createAndImport() {
      w.err = null;
      const kept = w.cols.filter((c) => c.keep);
      if (!kept.length) { w.err = { status: '', message: 'Keep at least one column.' }; draw(); return; }
      const body = { source: source(), transforms: w.transforms, entity: { name: w.entityName, title: w.entityTitle || undefined, label: w.entityLabel || undefined, titleField: w.titleField || null, columns: kept.map((c) => ({ column: c.column, field: fieldFrom(c.name, c.title, c.type, Object.assign({}, c.base, { required: c.required, unique: c.unique, indexed: c.unique || (c.base && c.base.indexed) })) })) } };
      if (!body.entity.title) delete body.entity.title;
      w.busy = true; draw();
      try {
        const out = await App.post('/api/apps/' + enc(app.id) + '/imports/entity', body);
        w.busy = false; w.created = out.entity;
        ctx.toast('Entity ' + esc(out.entity.name) + ' created (audited app.entity.created) and ' + out.transfer.rows + ' rows queued.');
        await follow(out.transfer, 'run');
      } catch (e) { w.busy = false; w.err = e; draw(); }
    }

    async function cancel(key) {
      const t = w[key]; if (!t) return;
      try { w[key] = await App.post('/api/apps/transfers/' + enc(t.id) + '/cancel', {}); ctx.toast('Cancel requested. Audited app.import.cancel-requested.'); } catch (e) { App.fail(e, 'Could not cancel'); }
      draw();
    }

    async function saveSchedule() {
      w.err = null;
      try {
        const out = await App.post('/api/apps/' + enc(app.id) + '/entities/' + enc(ent.id) + '/import-schedules', { spec: spec(), cron: w.cron.trim() });
        w.schedule = out;
        ctx.toast('Scheduled: ' + esc(out.schedule || out.cron) + '. It runs as you, checked each time. Audited app.import.schedule.created.');
      } catch (e) { w.err = e; }
      draw();
    }

    // ---------- views ----------

    const stepList = () => '<ol class="apps-ai-steps" aria-label="Import steps">' + steps.map((s, i) => '<li' + (i === w.step ? ' aria-current="step" class="on"' : i < w.step ? ' class="done"' : '') + '><span class="n" aria-hidden="true">' + (i + 1) + '</span><span>' + esc(s) + '</span></li>').join('') + '</ol>';

    function previewTable(withChecks) {
      const p = w.preview;
      if (!p) return '';
      const cols = ent && withChecks ? columns().filter((c) => w.mapping[c]) : columns();
      const shown = cols.length ? cols : columns();
      const checks = {};
      (p.checks || []).forEach((c) => { checks[c.row] = c; });
      const head = ['Row'].concat(shown.map((c) => (ent && w.mapping[c] && withChecks ? c + ' → ' + w.mapping[c] : c))).concat(withChecks && p.checks ? ['Check'] : []);
      const rows = p.rows.map((r) => [String(r.row)].concat(shown.map((c) => '<span class="apps-ai-cell">' + esc(cellText(r.values[c]).slice(0, 80)) + '</span>')).concat(withChecks && p.checks ? [checks[r.row] ? (checks[r.row].outcome === 'failed' ? UI.pill('fails', 'danger') + ' <span class="muted apps-ai-small">' + esc(checks[r.row].problem || '') + '</span>' : UI.pill('ok', 'ok')) : (r.problem ? UI.pill('fails', 'danger') + ' <span class="muted apps-ai-small">' + esc(r.problem) + '</span>' : '')] : []));
      return '<div class="muted apps-ai-small" aria-live="polite">' + p.total + ' row' + (p.total === 1 ? '' : 's') + ' after the transformations' + (p.skipped.count ? ', ' + p.skipped.count + ' skipped' : '') + (p.failed.count ? ', ' + p.failed.count + ' that cannot be converted' : '') + (p.source.truncated ? '; the source has more rows than an import reads' : '') + '. The first ' + Math.min(20, p.rows.length) + ':</div>'
        + UI.table(head, rows, { clickable: false, minWidth: Math.max(360, head.length * 120) + 'px', attrs: 'aria-label="Preview of the first rows"', emptyTitle: 'No rows', emptyText: 'Nothing is left after the transformations.' });
    }

    function sourceStep() {
      const kinds = [{ id: 'file', label: 'A file' }, { id: 'text', label: 'Paste text' }].concat(canConn ? [{ id: 'connection', label: 'From a connection' }] : []);
      let body = UI.seg(kinds, w.kind, 'data-ai-kind aria-label="Where the rows come from"');
      if (w.kind === 'file') {
        body += '<div class="formgrid">' + UI.field('File', '<input type="file" class="input" accept=".xlsx,.xlsm,.csv,.tsv,.tab,.json,.jsonl,.ndjson,.txt" data-ai-file>', 'Excel workbooks, CSV, TSV, JSON and JSON Lines. It goes to the file store, which quarantines and scans it first.') + UI.field('Label of the file', UI.select(LABELS, w.label, 'data-ai-label'), 'The records are at least this label.') + '</div>';
        if (w.fileState) body += UI.notice(w.fileState === 'ready' ? esc(w.file.name) + ' passed its scan and is ready.' : w.fileState === 'rejected' ? esc(w.fileErr || 'Rejected.') : w.fileState === 'uploading' ? 'Uploading…' : esc((w.file && w.file.name) || '') + ' is in quarantine while it is scanned.', w.fileState === 'ready' ? 'ok' : w.fileState === 'rejected' ? 'danger' : 'info');
        else if (w.fileErr) body += UI.notice(esc(w.fileErr), 'danger');
      } else if (w.kind === 'text') {
        body += '<div class="formgrid">' + UI.field('Rows', UI.textarea(w.text, { rows: 6, attrs: 'data-ai-text spellcheck="false" aria-describedby="ai-text-hint"' }), 'CSV with a header row, TSV, a JSON array or JSON Lines; at most 250,000 characters.') + UI.field('Format', UI.select([{ value: '', label: 'Detect' }, 'csv', 'tsv', 'json', 'jsonl'], w.format, 'data-ai-format'), '') + '</div>';
      } else {
        body += UI.seg([{ id: 'connection', label: 'A table' }, { id: 'saved-query', label: 'A saved query' }, { id: 'rest', label: 'A REST endpoint' }], w.connKind, 'data-ai-connkind aria-label="Kind of connection source"');
        if (w.conns === null) body += '<div class="muted">Loading connections…</div>';
        else if (w.connKind === 'connection') {
          const c = w.conns.find((x) => x.id === w.connId);
          const objs = c ? c.schema.filter((o) => o.allowed) : [];
          body += !App.can('connections:manage') ? UI.notice('Reading a table needs the connections:manage right.', 'warn') : '<div class="formgrid">' + UI.field('Connection', UI.select([{ value: '', label: 'Choose a connection' }].concat(w.conns.map((x) => ({ value: x.id, label: x.name + ' (' + x.engine + ', ' + x.label + ')' }))), w.connId, 'data-ai-conn'), '') + UI.field('Table, view or collection', UI.select([{ value: '', label: objs.length ? 'Choose one on the allow-list' : 'Nothing on the allow-list' }].concat(objs.map((o) => ({ value: o.name, label: o.name }))), w.object, 'data-ai-object'), 'Read masked, after the db-query guardrail.') + UI.field('Key column', UI.select([{ value: '', label: 'None' }].concat(((objs.find((o) => o.name === w.object) || { columns: [] }).columns).map((x) => ({ value: x.name, label: x.name }))), w.keyColumn, 'data-ai-key'), 'Pages through the table by this column and keys the rows, so a re-import updates what it made.') + '</div>';
        } else if (w.connKind === 'saved-query') {
          const q = w.queries.find((x) => x.id === w.queryId);
          body += '<div class="formgrid">' + UI.field('Saved query', UI.select([{ value: '', label: w.queries.length ? 'Choose a published query' : 'No published queries' }].concat(w.queries.map((x) => ({ value: x.id, label: (x.title || x.name) + ' (' + x.label + ')' }))), w.queryId, 'data-ai-query'), '') + (q ? (q.params || []).map((p) => UI.field('Parameter ' + p.name, UI.input(w.params[p.name] == null ? '' : String(w.params[p.name]), { attrs: 'data-ai-param="' + esc(p.name) + '"' }), p.type + (p.required ? ', required' : ''))).join('') : '') + '</div>';
        } else {
          const r = w.rests.find((x) => x.id === w.restId);
          const e = r ? r.endpoints.find((x) => x.name === w.endpoint) : null;
          body += '<div class="formgrid">' + UI.field('REST connection', UI.select([{ value: '', label: w.rests.length ? 'Choose a connection' : 'No REST connections' }].concat(w.rests.map((x) => ({ value: x.id, label: (x.title || x.name) + ' (' + x.label + ')' }))), w.restId, 'data-ai-rest'), '') + UI.field('Endpoint', UI.select([{ value: '', label: 'Choose an endpoint' }].concat((r ? r.endpoints : []).map((x) => ({ value: x.name, label: x.title || x.name }))), w.endpoint, 'data-ai-endpoint'), '') + (e ? (e.params || []).map((p) => UI.field('Parameter ' + p.name, UI.input(w.params[p.name] == null ? '' : String(w.params[p.name]), { attrs: 'data-ai-param="' + esc(p.name) + '"' }), p.type + (p.required ? ', required' : ''))).join('') : '') + '</div>';
        }
      }
      return body;
    }

    function sheetStep() {
      const p = w.preview;
      let body = '';
      const fileLike = w.kind !== 'connection';
      if (fileLike) {
        const fmt = p ? p.source.format : '';
        body += '<div class="formgrid">'
          + (p && p.source.sheets ? UI.field('Sheet', UI.select(p.source.sheets.map((s) => ({ value: s.name, label: s.name + (s.hidden ? ' (hidden)' : '') })), w.sheet || p.source.sheet, 'data-ai-sheet'), '') : '')
          + (fmt !== 'json' && fmt !== 'jsonl' ? UI.field('Header row', UI.input(w.headerRow, { type: 'number', attrs: 'data-ai-header min="1" inputmode="numeric"', placeholder: p && p.source.headerRow ? String(p.source.headerRow) : 'first row with a value' }), 'The row that names the columns.') + UI.field('Range', UI.input(w.range, { attrs: 'data-ai-range', placeholder: 'A3:F200' }), 'Optional: columns by letter, rows by number.') : '')
          + (fmt === 'json' ? UI.field('Path to the rows', UI.input(w.jsonPath, { attrs: 'data-ai-jsonpath', placeholder: 'data.items' }), 'Optional: the array of rows inside the document.') : '')
          + '</div>';
      }
      if (w.previewErr) body += UI.notice(problem(w.previewErr), 'danger');
      if (p) body += UI.kv([['Format', esc(p.source.format)], ['Rows read', String(p.source.rows)], ['Columns', String(p.source.columns.length)], ['Label of the data', UI.label(p.source.label, { sm: true })]], 2) + previewTable(false);
      else if (!w.previewErr) body += '<div class="muted" aria-live="polite">Reading the source…</div>';
      return body;
    }

    function transformsPanel() {
      const cols = columns();
      let body = '<div class="eyebrow">Transformations, applied in order</div>';
      body += w.transforms.length ? '<ol class="apps-ai-tlist">' + w.transforms.map((t, i) => '<li><span class="grow">' + esc(describe(t)) + '</span><span class="hstack gap4">' + UI.btn('Up', { size: 'xs', attrs: 'data-ai-tup="' + i + '" aria-label="Move step ' + (i + 1) + ' up"' + (i === 0 ? ' disabled' : '') }) + UI.btn('Down', { size: 'xs', attrs: 'data-ai-tdown="' + i + '" aria-label="Move step ' + (i + 1) + ' down"' + (i === w.transforms.length - 1 ? ' disabled' : '') }) + UI.iconbtn('trash', 'Remove step ' + (i + 1), { attrs: 'data-ai-tdel="' + i + '"', cls: 'sm ghost' }) + '</span></li>').join('') + '</ol>' : '<div class="muted apps-ai-small">None yet.</div>';
      body += '<div class="formgrid">' + UI.field('Add a transformation', UI.select([{ value: '', label: 'Choose one' }].concat(KINDS), w.adding, 'data-ai-add'), '') + '</div>';
      if (w.adding) {
        const colSel = (attr, multi, label) => UI.field(label, '<select class="select" ' + attr + (multi ? ' multiple size="' + Math.min(5, Math.max(2, cols.length)) + '"' : '') + '>' + (multi ? '' : '<option value="">Choose a column</option>') + cols.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('') + '</select>', multi ? 'Hold Ctrl or Command to pick several.' : '');
        const k = w.adding;
        let form = '';
        if (['trim', 'case', 'fill-down', 'replace', 'parse-date', 'parse-number', 'default', 'dedupe', 'merge'].indexOf(k) >= 0) form += colSel('data-ai-tcols', true, 'Columns');
        if (k === 'split' || k === 'drop-rows') form += colSel('data-ai-tcol', false, 'Column');
        if (k === 'case') form += UI.field('To', UI.select([{ value: 'upper', label: 'UPPER' }, { value: 'lower', label: 'lower' }, { value: 'title', label: 'Title Case' }, { value: 'sentence', label: 'Sentence case' }], 'title', 'data-ai-to'), '');
        if (k === 'split') form += UI.field('Delimiter', UI.input(',', { attrs: 'data-ai-delim maxlength="10"' }), '') + UI.field('New columns', UI.input('', { attrs: 'data-ai-into', placeholder: 'first, last' }), 'Comma-separated names; the last takes the rest.');
        if (k === 'merge') form += UI.field('Into', UI.input('', { attrs: 'data-ai-mergeinto', placeholder: 'full_name' }), '') + UI.field('Separator', UI.input(' ', { attrs: 'data-ai-sep maxlength="10"' }), '');
        if (k === 'replace') form += UI.field('Replacements', UI.textarea('', { rows: 3, attrs: 'data-ai-map', placeholder: 'n/a => \nY => yes' }), 'One per line: value => replacement. Exact matches only.');
        if (k === 'parse-date') form += UI.field('Format', UI.select(DATE_FORMATS, 'DD/MM/YYYY', 'data-ai-dfmt'), '') + UI.check('With a time', false, 'data-ai-withtime');
        if (k === 'parse-number') form += UI.field('Decimal mark', UI.select([{ value: '.', label: 'Point (1,234.5)' }, { value: ',', label: 'Comma (1.234,5)' }], '.', 'data-ai-dec'), '');
        if (k === 'default') form += UI.field('Value', UI.input('', { attrs: 'data-ai-defval' }), '');
        if (k === 'drop-rows') form += UI.field('When', UI.select([{ value: 'empty', label: 'It is empty' }, { value: 'equals', label: 'It equals one of' }], 'empty', 'data-ai-when'), '') + UI.field('Values', UI.input('', { attrs: 'data-ai-dropvals', placeholder: 'n/a, TOTAL' }), 'Comma-separated, for "equals".');
        if (k === 'dedupe') form += UI.field('Keep', UI.select([{ value: 'first', label: 'The first row' }, { value: 'last', label: 'The last row' }], 'first', 'data-ai-keep'), '');
        body += '<div class="apps-ai-addform"><div class="formgrid">' + form + '</div><div class="hstack gap6">' + UI.btn('Add step', { size: 'sm', kind: 'primary', attrs: 'data-ai-tok' }) + UI.btn('Cancel', { size: 'sm', attrs: 'data-ai-tcancel' }) + '</div></div>';
      }
      return body;
    }

    function mappingStep() {
      const cols = columns();
      const targets = [{ value: '', label: 'Skip this column' }, { value: 'label', label: 'label (the record\'s label)' }].concat(fields.map((f) => ({ value: f.name, label: (f.title ? f.title + ' (' + f.name + ')' : f.name) + (f.required ? ', required' : '') })));
      const chosen = mappingList().map((m) => m.field);
      const dup = chosen.filter((c, i) => chosen.indexOf(c) !== i);
      const missing = fields.filter((f) => f.required && chosen.indexOf(f.name) < 0).map((f) => f.name);
      let body = transformsPanel();
      body += '<div class="eyebrow">Columns</div>' + UI.table(['Column', 'Imports into', 'First values'], cols.map((c, i) => ['<span class="mono">' + esc(c) + '</span>', UI.select(targets, w.mapping[c] || '', 'data-ai-map-col="' + i + '" aria-label="Field for column ' + esc(c) + '"'), '<span class="muted apps-ai-small">' + esc(((w.preview && w.preview.rows) || []).slice(0, 3).map((r) => cellText(r.values[c])).join(' · ').slice(0, 80)) + '</span>']), { clickable: false, minWidth: '0', attrs: 'aria-label="Column mapping"' });
      if (dup.length) body += UI.notice('Two columns import into ' + esc(dup.join(', ')) + '; keep one.', 'warn');
      if (missing.length) body += UI.notice('No column imports into the required ' + esc(missing.join(', ')) + '; those rows will fail.', 'warn');
      body += '<div class="formgrid">' + UI.field('Existing records', UI.select([{ value: '', label: 'Create a record for every row' }].concat(uniques.map((f) => ({ value: f.name, label: 'Update the record with the same ' + f.name }))), w.upsert, 'data-ai-upsert'), uniques.length ? 'Upsert matches on a unique field.' : 'The entity has no unique field to match on.')
        + (w.upsert ? UI.field('Rows that match no record', UI.select([{ value: 'upsert', label: 'Create them' }, { value: 'update-only', label: 'Skip them' }], w.upsertMode, 'data-ai-upsertmode'), '') : '')
        + (w.kind === 'connection' ? UI.field('Source key', UI.select([{ value: '', label: 'None' }].concat(cols.map((c) => ({ value: c, label: c }))), w.sourceKey, 'data-ai-sourcekey'), 'A re-import updates the record each keyed row made.') : '') + '</div>';
      if (w.previewErr) body += UI.notice(problem(w.previewErr), 'danger');
      body += '<div class="eyebrow">Preview</div>' + previewTable(true);
      return body;
    }

    function fieldsStep() {
      const p = w.proposal;
      let body = transformsPanel();
      if (!p) return body + (w.err ? UI.notice(problem(w.err), 'danger') : '<div class="muted" aria-live="polite">Inferring the fields…</div>');
      body += UI.notice('Proposed from ' + p.sampled + ' row' + (p.sampled === 1 ? '' : 's') + '. Rename, retype or skip a column; required and unique are proposed from the data. Flagged columns may hold personal data: check the label.', 'info');
      body += '<div class="formgrid">' + UI.field('Entity name', UI.input(w.entityName, { attrs: 'data-ai-ename maxlength="63" pattern="[a-z][a-z0-9_]*"' }), 'Lower-case letters, digits and _.') + UI.field('Title', UI.input(w.entityTitle, { attrs: 'data-ai-etitle maxlength="200"', placeholder: w.entityName }), '') + UI.field('Label', UI.select(LABELS, w.entityLabel, 'data-ai-elabel'), 'Records are at least this label.') + UI.field('Title field', UI.select([{ value: '', label: 'The first text field' }].concat(w.cols.filter((c) => c.keep && c.type === 'string').map((c) => ({ value: c.name, label: c.name }))), w.titleField, 'data-ai-etf'), 'Shown as each record\'s name.') + '</div>';
      body += UI.table(['Keep', 'Column', 'Field name', 'Type', 'Required', 'Unique', 'Personal data', 'Sample'], w.cols.map((c, i) => [
        '<input type="checkbox" ' + (c.keep ? 'checked ' : '') + 'data-ai-ckeep="' + i + '" aria-label="Keep column ' + esc(c.column) + '">',
        '<span class="mono">' + esc(c.column) + '</span><div class="muted apps-ai-small">' + esc(c.inferred) + '</div>',
        UI.input(c.name, { attrs: 'data-ai-cname="' + i + '" aria-label="Field name for ' + esc(c.column) + '" maxlength="63"' }),
        UI.select(TYPES.filter((t) => t.value !== 'enum' || (c.base && c.base.type === 'enum')), c.type, 'data-ai-ctype="' + i + '" aria-label="Type of ' + esc(c.column) + '"'),
        '<input type="checkbox" ' + (c.required ? 'checked ' : '') + 'data-ai-creq="' + i + '" aria-label="' + esc(c.column) + ' is required">',
        '<input type="checkbox" ' + (c.unique ? 'checked ' : '') + 'data-ai-cuniq="' + i + '" aria-label="' + esc(c.column) + ' is unique">',
        c.pii ? UI.pill(c.pii, 'warn') : '',
        '<span class="muted apps-ai-small">' + esc(c.sample || '') + '</span>'
      ]), { clickable: false, minWidth: '880px', attrs: 'aria-label="Proposed fields"' });
      if (w.err) body += UI.notice(problem(w.err), 'danger');
      return body;
    }

    function summaryOf(x) {
      const s = x.summary || {};
      return '<div class="stats apps-ai-stats">' + (x.dryRun ? UI.stat(String(s.wouldCreate || 0), 'would be created') + UI.stat(String(s.wouldUpdate || 0), 'would be updated') : UI.stat(String(s.created || 0), 'created') + UI.stat(String(s.updated || 0), 'updated')) + UI.stat(String(s.skipped || 0), 'skipped') + UI.stat(String(s.failed || 0), 'failed') + '</div>';
    }

    function transferView(key) {
      const x = w[key];
      if (!x) return '';
      if (x.state === 'queued' || x.state === 'running') {
        const pct = w.job && w.job.progress != null ? w.job.progress : x.state === 'queued' ? 0 : 5;
        return '<div aria-live="polite">' + UI.meter(x.state === 'queued' ? 'Queued' : 'Running', (w.job && w.job.message) || pct + '%', pct) + '</div>' + UI.btn('Cancel the import', { size: 'sm', kind: 'danger', attrs: 'data-ai-cancel="' + key + '"' });
      }
      if (x.state === 'failed' || x.state === 'unknown') return UI.notice('The import failed: ' + esc(x.error || ''), 'danger');
      const issues = (x.report || []).filter((r) => r.outcome === 'failed' || r.outcome === 'skipped');
      return '<div aria-live="polite">' + (x.state === 'cancelled' ? UI.notice('Cancelled. Rows written before the cancel stay.', 'warn') : UI.notice(x.dryRun ? 'Dry run finished: nothing was written. Audited app.import.checked.' : 'Import finished. Audited app.import.completed.', 'ok')) + '</div>' + summaryOf(x)
        + (issues.length ? UI.table(['Row', 'Outcome', 'Reason'], issues.slice(0, 50).map((r) => [String(r.row), UI.pill(r.outcome, r.outcome === 'failed' ? 'danger' : 'warn'), esc(r.problem || '')]), { clickable: false, minWidth: '0', attrs: 'aria-label="Rows that were not written"' }) + (issues.length > 50 ? '<div class="muted apps-ai-small">The first 50 of ' + issues.length + '.</div>' : '') : '')
        + (x.errors ? '<a class="btn sm" href="/api/apps/transfers/' + enc(x.id) + '/errors" download data-ai-errors>Download the failed rows (CSV)</a>' : '');
    }

    function dryStep() {
      return UI.notice('The dry run checks every row as the import would (fields, policies, unique values) and writes nothing.', 'info') + (w.dry ? transferView('dry') : UI.btn('Run the dry run', { kind: 'primary', attrs: 'data-ai-dryrun' + (w.busy ? ' disabled' : '') })) + (w.err ? UI.notice(problem(w.err), 'danger') : '');
    }

    function importStep() {
      const n = (w.dry && w.dry.summary && (w.dry.summary.wouldCreate || 0) + (w.dry.summary.wouldUpdate || 0)) || 0;
      let body = w.run ? transferView('run') + (['succeeded', 'cancelled', 'failed'].indexOf(w.run.state) >= 0 ? UI.btn('Done', { attrs: 'data-ai-finish' }) : '')
        : w.confirming ? UI.notice('Write ' + n + ' record' + (n === 1 ? '' : 's') + ' into ' + esc(ent.title || ent.name) + ' as you, through the record rules and policies? Rows that fail are reported and can be downloaded.', 'warn', '<span class="hstack gap6">' + UI.btn('Confirm the import', { size: 'sm', kind: 'primary', attrs: 'data-ai-confirm' }) + UI.btn('Not yet', { size: 'sm', attrs: 'data-ai-unconfirm' }) + '</span>')
        : UI.btn('Import the rows', { kind: 'primary', attrs: 'data-ai-import' + (w.busy ? ' disabled' : '') });
      if (w.kind === 'connection' && ent) {
        body += '<div class="divider"></div><div class="eyebrow">Schedule</div>' + '<div class="formgrid">' + UI.field('Re-import on a schedule (cron, UTC)', UI.input(w.cron, { attrs: 'data-ai-cron', placeholder: '0 6 * * *' }), 'Runs as you; your rights and clearance are checked at every run.') + '</div>' + UI.btn('Save the schedule', { size: 'sm', attrs: 'data-ai-schedule' }) + (w.schedule ? UI.notice('Scheduled: ' + esc(w.schedule.schedule || w.schedule.cron) + '.', 'ok') : '');
      }
      if (w.err) body += UI.notice(problem(w.err), 'danger');
      return body;
    }

    function createStep() {
      const kept = w.cols.filter((c) => c.keep);
      let body = UI.kv([['Entity', '<span class="mono">' + esc(w.entityName) + '</span>'], ['Label', UI.label(w.entityLabel || 'internal', { sm: true })], ['Fields', String(kept.length)], ['Rows', String(w.proposal ? w.proposal.total : 0)]], 2);
      body += w.run ? transferView('run') : UI.btn('Create the entity and import', { kind: 'primary', attrs: 'data-ai-create' + (w.busy ? ' disabled' : '') });
      if (w.created && w.run && ['succeeded', 'cancelled', 'failed'].indexOf(w.run.state) >= 0) body += UI.btn('Done', { attrs: 'data-ai-done' });
      if (w.err) body += UI.notice(problem(w.err), 'danger');
      return body;
    }

    function canNext() {
      if (w.busy) return false;
      if (w.step === 0) return ready();
      if (w.step === 1) return !!w.preview && !w.previewErr;
      if (!isNew && w.step === 2) { const ch = mappingList().map((m) => m.field); return ch.length > 0 && ch.every((c, i) => ch.indexOf(c) === i); }
      if (isNew && w.step === 2) return !!w.proposal && w.cols.some((c) => c.keep) && /^[a-z][a-z0-9_]{0,62}$/.test(w.entityName);
      if (!isNew && w.step === 3) return !!(w.dry && w.dry.state === 'succeeded');
      return false;
    }

    function draw() {
      if (!root || !document.contains(root)) return;
      // A redraw replaces the step's markup: the focused control is found again by its data-ai-* attribute.
      const keep = document.activeElement && root.contains(document.activeElement) ? (document.activeElement.getAttribute('data-focus-key') || null) : null;
      const content = w.step === 0 ? sourceStep() : w.step === 1 ? sheetStep() : w.step === 2 ? (isNew ? fieldsStep() : mappingStep()) : isNew ? createStep() : w.step === 3 ? dryStep() : importStep();
      const last = w.step === steps.length - 1;
      root.innerHTML = stepList() + '<h3 class="apps-ai-h" tabindex="-1" data-ai-heading>Step ' + (w.step + 1) + ' of ' + steps.length + ': ' + esc(steps[w.step]) + '</h3>' + '<div class="vstack gap12" data-ai-content>' + content + '</div>'
        + '<div class="hstack wrap gap6 apps-ai-nav">' + (w.step > 0 ? UI.btn('Back', { attrs: 'data-ai-back' + ((w.run && (w.run.state === 'running' || w.run.state === 'queued')) ? ' disabled' : '') }) : '') + '<span class="grow"></span>' + (w.busy ? '<span class="muted apps-ai-small" aria-live="polite">Working…</span>' : '') + (last ? '' : UI.btn('Next', { kind: 'primary', attrs: 'data-ai-next' + (canNext() ? '' : ' disabled') })) + '</div>';
      App.a11yPass(root);
      Array.prototype.forEach.call(root.querySelectorAll('button,input,select,textarea,a'), (el) => { const a = Array.prototype.find.call(el.attributes, (x) => /^data-ai-/.test(x.name)); if (a) el.setAttribute('data-focus-key', a.name + ':' + a.value); });
      if (keep) { const el = Array.prototype.find.call(root.querySelectorAll('[data-focus-key]'), (x) => x.getAttribute('data-focus-key') === keep); if (el && !el.disabled) el.focus(); }
    }
    const syncNext = () => { const b = root && root.querySelector('[data-ai-next]'); if (b) b.disabled = !canNext(); };

    function go(step) {
      w.step = step; w.err = null;
      if (step === 1) { w.preview = null; w.previewErr = null; refresh(false); }
      if (step === 2 && !isNew) refresh(true);
      if (step === 2 && isNew) infer();
      draw();
      const h = root.querySelector('[data-ai-heading]'); if (h) h.focus();
    }

    function addTransform() {
      const q = (sel) => root.querySelector(sel);
      const multi = q('[data-ai-tcols]');
      const cols = multi ? Array.prototype.filter.call(multi.options, (o) => o.selected).map((o) => o.value) : [];
      const one = q('[data-ai-tcol]') ? q('[data-ai-tcol]').value : '';
      const k = w.adding;
      let t = null;
      const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
      if (k === 'split' || k === 'drop-rows') { if (!one) { ctx.toast('Choose the column.', 'warn'); return; } }
      else if (!cols.length) { ctx.toast('Choose at least one column.', 'warn'); return; }
      if (k === 'trim') t = { kind: k, columns: cols, collapse: true };
      if (k === 'case') t = { kind: k, columns: cols, to: q('[data-ai-to]').value };
      if (k === 'split') { const into = list(q('[data-ai-into]').value); if (into.length < 2) { ctx.toast('Name at least two new columns.', 'warn'); return; } t = { kind: k, column: one, delimiter: q('[data-ai-delim]').value || ',', into }; }
      if (k === 'merge') { const into = q('[data-ai-mergeinto]').value.trim(); if (cols.length < 2 || !into) { ctx.toast('Choose two columns or more and name the merged one.', 'warn'); return; } t = { kind: k, columns: cols, into, separator: q('[data-ai-sep]').value }; }
      if (k === 'fill-down') t = { kind: k, columns: cols };
      if (k === 'replace') { const map = {}; q('[data-ai-map]').value.split('\n').forEach((line) => { const i = line.indexOf('=>'); if (i > 0 || (i === 0 && line.length > 2)) map[line.slice(0, i).trim()] = line.slice(i + 2).trim(); }); if (!Object.keys(map).length) { ctx.toast('Write one replacement per line: value => replacement.', 'warn'); return; } t = { kind: k, columns: cols, map }; }
      if (k === 'parse-date') t = { kind: k, columns: cols, format: q('[data-ai-dfmt]').value, withTime: q('[data-ai-withtime]').checked };
      if (k === 'parse-number') t = { kind: k, columns: cols, decimal: q('[data-ai-dec]').value };
      if (k === 'default') t = { kind: k, columns: cols, value: q('[data-ai-defval]').value };
      if (k === 'drop-rows') { const when = q('[data-ai-when]').value; const values = list(q('[data-ai-dropvals]').value); if (when === 'equals' && !values.length) { ctx.toast('List the values to drop.', 'warn'); return; } t = { kind: k, column: one, when, values }; }
      if (k === 'dedupe') t = { kind: k, columns: cols, keep: q('[data-ai-keep]').value };
      if (!t) return;
      w.transforms = w.transforms.concat([t]); w.adding = '';
      changed();
    }
    const changed = () => { if (isNew) infer(); else refresh(true); };

    deps.modal({
      title: isNew ? 'New entity from file' : 'Import records into ' + esc(ent.title || ent.name),
      cls: 'wide',
      body: '<style>.apps-ai-steps{display:flex;flex-wrap:wrap;gap:6px 14px;list-style:none;margin:0;padding:0}.apps-ai-steps li{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:13px}.apps-ai-steps li.on{color:var(--fg);font-weight:600}.apps-ai-steps li.done{color:var(--fg2)}.apps-ai-steps .n{display:inline-flex;width:20px;height:20px;border-radius:50%;align-items:center;justify-content:center;border:1px solid var(--line2);font-size:11px}.apps-ai-steps li.on .n{background:var(--accent);color:var(--bg);border-color:var(--accent)}.apps-ai-h{margin:6px 0 0;font-size:15px}.apps-ai-small{font-size:12px}.apps-ai-tlist{margin:0;padding-left:20px}.apps-ai-tlist li{display:flex;align-items:center;gap:8px;padding:2px 0;flex-wrap:wrap}.apps-ai-addform{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--panel2)}.apps-ai-nav{border-top:1px solid var(--line);padding-top:10px}.apps-ai-cell{overflow-wrap:anywhere}.apps-ai-stats{display:flex;flex-wrap:wrap;gap:10px}</style><div class="vstack gap12" data-ai-root></div>',
      actions: UI.btn('Close', { attrs: 'data-close' }),
      onMount(m) {
        root = m.querySelector('[data-ai-root]');
        root.addEventListener('click', (e) => {
          const t = e.target.closest('button,a'); if (!t || t.disabled) return;
          if (t.matches('[data-ai-kind] [data-seg]')) { w.kind = t.dataset.seg; w.preview = null; if (w.kind === 'connection') loadConnections(); draw(); return; }
          if (t.matches('[data-ai-connkind] [data-seg]')) { w.connKind = t.dataset.seg; w.params = {}; draw(); return; }
          if (t.hasAttribute('data-ai-next')) { go(w.step + 1); return; }
          if (t.hasAttribute('data-ai-back')) { go(w.step - 1); return; }
          if (t.hasAttribute('data-ai-tok')) { addTransform(); return; }
          if (t.hasAttribute('data-ai-tcancel')) { w.adding = ''; draw(); return; }
          if (t.hasAttribute('data-ai-tdel')) { w.transforms.splice(+t.dataset.aiTdel, 1); changed(); return; }
          if (t.hasAttribute('data-ai-tup') || t.hasAttribute('data-ai-tdown')) { const i = +(t.dataset.aiTup || t.dataset.aiTdown); const j = t.hasAttribute('data-ai-tup') ? i - 1 : i + 1; const x = w.transforms[i]; w.transforms[i] = w.transforms[j]; w.transforms[j] = x; changed(); return; }
          if (t.hasAttribute('data-ai-dryrun')) { queue(true); return; }
          if (t.hasAttribute('data-ai-import')) { w.confirming = true; draw(); const c = root.querySelector('[data-ai-confirm]'); if (c) c.focus(); return; }
          if (t.hasAttribute('data-ai-unconfirm')) { w.confirming = false; draw(); return; }
          if (t.hasAttribute('data-ai-confirm')) { w.confirming = false; queue(false); return; }
          if (t.hasAttribute('data-ai-finish')) { deps.afterChange({ records: true }); return; }
          if (t.hasAttribute('data-ai-create')) { createAndImport(); return; }
          if (t.hasAttribute('data-ai-cancel')) { cancel(t.dataset.aiCancel); return; }
          if (t.hasAttribute('data-ai-schedule')) { saveSchedule(); return; }
          if (t.hasAttribute('data-ai-done')) { deps.afterChange({ apps: true }); return; }
        });
        root.addEventListener('change', (e) => {
          const t = e.target;
          const d = t.dataset;
          if (t.hasAttribute('data-ai-file')) { const f = t.files && t.files[0]; if (f) upload(f); return; }
          if (t.hasAttribute('data-ai-label')) { w.label = t.value; return; }
          if (t.hasAttribute('data-ai-format')) { w.format = t.value; return; }
          if (t.hasAttribute('data-ai-text')) { w.text = t.value; syncNext(); return; }
          if (t.hasAttribute('data-ai-conn')) { w.connId = t.value; w.object = ''; w.keyColumn = ''; draw(); return; }
          if (t.hasAttribute('data-ai-object')) { w.object = t.value; w.keyColumn = ''; draw(); return; }
          if (t.hasAttribute('data-ai-key')) { w.keyColumn = t.value; draw(); return; }
          if (t.hasAttribute('data-ai-query')) { w.queryId = t.value; w.params = {}; draw(); return; }
          if (t.hasAttribute('data-ai-rest')) { w.restId = t.value; w.endpoint = ''; w.params = {}; draw(); return; }
          if (t.hasAttribute('data-ai-endpoint')) { w.endpoint = t.value; w.params = {}; draw(); return; }
          if (t.hasAttribute('data-ai-param')) { w.params[d.aiParam] = t.value; syncNext(); return; }
          if (t.hasAttribute('data-ai-sheet')) { w.sheet = t.value; w.headerRow = ''; w.range = ''; refresh(false); return; }
          if (t.hasAttribute('data-ai-header')) { w.headerRow = t.value; later(false); return; }
          if (t.hasAttribute('data-ai-range')) { w.range = t.value; later(false); return; }
          if (t.hasAttribute('data-ai-jsonpath')) { w.jsonPath = t.value; later(false); return; }
          if (t.hasAttribute('data-ai-add')) { w.adding = t.value; draw(); return; }
          if (t.hasAttribute('data-ai-map-col')) { w.mapping[columns()[+d.aiMapCol]] = t.value; later(true); draw(); return; }
          if (t.hasAttribute('data-ai-upsert')) { w.upsert = t.value; draw(); return; }
          if (t.hasAttribute('data-ai-upsertmode')) { w.upsertMode = t.value; return; }
          if (t.hasAttribute('data-ai-sourcekey')) { w.sourceKey = t.value; return; }
          if (t.hasAttribute('data-ai-cron')) { w.cron = t.value; return; }
          if (t.hasAttribute('data-ai-ename')) { w.entityName = t.value.trim(); syncNext(); return; }
          if (t.hasAttribute('data-ai-etitle')) { w.entityTitle = t.value; return; }
          if (t.hasAttribute('data-ai-elabel')) { w.entityLabel = t.value; return; }
          if (t.hasAttribute('data-ai-etf')) { w.titleField = t.value; return; }
          if (t.hasAttribute('data-ai-ckeep')) { w.cols[+d.aiCkeep].keep = t.checked; draw(); return; }
          if (t.hasAttribute('data-ai-cname')) { w.cols[+d.aiCname].name = t.value.trim(); return; }
          if (t.hasAttribute('data-ai-ctype')) { w.cols[+d.aiCtype].type = t.value; draw(); return; }
          if (t.hasAttribute('data-ai-creq')) { w.cols[+d.aiCreq].required = t.checked; return; }
          if (t.hasAttribute('data-ai-cuniq')) { w.cols[+d.aiCuniq].unique = t.checked; return; }
        });
        // Typing updates the state without a redraw (a redraw would replace the field under the caret).
        root.addEventListener('input', (e) => {
          const t = e.target; const d = t.dataset;
          if (t.hasAttribute('data-ai-text')) w.text = t.value;
          else if (t.hasAttribute('data-ai-ename')) w.entityName = t.value.trim();
          else if (t.hasAttribute('data-ai-etitle')) w.entityTitle = t.value;
          else if (t.hasAttribute('data-ai-cname')) w.cols[+d.aiCname].name = t.value.trim();
          else if (t.hasAttribute('data-ai-cron')) w.cron = t.value;
          else if (t.hasAttribute('data-ai-param')) w.params[d.aiParam] = t.value;
          else return;
          syncNext();
        });
        draw();
      },
      onClose() { clearTimeout(timer); root = null; }
    });
  }

  App.appsImportCsv = function (ctx, app, ent, deps) { open(ctx, app, ent, deps); };
  App.appsEntityFromFile = function (ctx, app, deps) { open(ctx, app, null, deps); };
})();
