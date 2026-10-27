(function () {
  const { UI, esc } = App;

  /*
   * 2.0.0 file management: the editor for documents in the file store (#/file-edit?file=<id>), opened from Files.
   * The server reads a file's current version into a model (server/src/files/documents/model.ts) and writes an edited
   * model back as a new version, which is scanned like any upload. Markdown and OpenDocument text are a RichDoc drawn
   * here as DOM nodes built from the model (never HTML from the server) in a contenteditable region and read back by a
   * whitelist walk; CSV, Excel and OpenDocument spreadsheets are a Workbook drawn as a grid.
   */

  const ID = 'file-edit';
  const enc = encodeURIComponent;
  const COLUMN_TYPES = ['text', 'number', 'integer', 'date', 'datetime', 'boolean', 'email', 'url'];
  const KIND_NAMES = { markdown: 'Markdown', text: 'Text', csv: 'CSV', xlsx: 'Excel workbook', ods: 'OpenDocument spreadsheet', odt: 'OpenDocument text', xls: 'Excel 97-2003 workbook' };
  const EXT = { markdown: '.md', text: '.txt', csv: '.csv', xlsx: '.xlsx', ods: '.ods', odt: '.odt', xls: '.xls' };
  const isSheet = (k) => k === 'csv' || k === 'xlsx' || k === 'ods' || k === 'xls';
  const isRich = (k) => k === 'markdown' || k === 'odt';
  const ROW_PAGE = 200;
  const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
  const safeHref = (h) => { const v = String(h || '').trim(); return SAFE_HREF.test(v) && v.length <= 2048 ? v : null; };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // ---------- samples for the states (no server document needed) ----------
  const SAMPLE_DOC = { blocks: [
    { type: 'heading', level: 1, runs: [{ text: 'Quarterly plan' }] },
    { type: 'paragraph', runs: [{ text: 'Goals for the quarter, ' }, { text: 'in order', b: true }, { text: '. See the ' }, { text: 'finance handbook', href: 'https://example.com/handbook' }, { text: '.' }] },
    { type: 'list', ordered: false, items: [{ runs: [{ text: 'Close the books' }], checked: true }, { runs: [{ text: 'Review vendors' }], checked: false }] },
    { type: 'quote', runs: [{ text: 'Plans change; the review date does not.' }] },
    { type: 'table', header: true, rows: [[[{ text: 'Owner' }], [{ text: 'Due' }]], [[{ text: 'Ann' }], [{ text: '2026-11-01' }]]] }
  ] };
  const SAMPLE_WB = { sheets: [{ name: 'Vendors', header: true, columns: [{ name: 'name', type: 'text', required: true }, { name: 'amount', type: 'number' }, { name: 'due', type: 'date' }], rows: [
    [{ v: 'name' }, { v: 'amount' }, { v: 'due' }],
    [{ v: 'Acme' }, { v: 1200.5 }, { v: '2026-10-01' }],
    [{ v: 'Globex' }, { v: 'n/a' }, { v: '31/09/2026' }],
    [{ v: 'Initech' }, { v: 300 }, { v: '2026-12-15' }, ],
    [{ v: 'Total', b: true }, { v: null, f: 'SUM(B2:B4)', b: true }, { v: null }]
  ] }] };
  const SAMPLE_REPORT = { changedCells: 4, removedRows: 1, removedColumns: 0, duplicateRows: 1, invalidCount: 2, requiredMissing: 0, invalid: [{ row: 2, col: 1, value: 'n/a', reason: 'Not a number' }, { row: 2, col: 2, value: '31/09/2026', reason: 'Not a date' }] };

  // ---------- cells and columns ----------
  const letter = (i) => { let n = i + 1; let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const ref = (r, c) => letter(c) + (r + 1);
  const cellAt = (sh, r, c) => (sh.rows[r] && sh.rows[r][c]) || null;
  const ncols = (sh) => Math.max(1, sh.columns.length, sh.rows.reduce((m, r) => Math.max(m, r.length), 0));
  const nrows = (sh) => Math.max(1, sh.rows.length);
  const shown = (cell) => {
    if (!cell) return '';
    if (cell.v == null) return cell.f ? '=' + cell.f : '';
    if (cell.v === true) return 'TRUE';
    if (cell.v === false) return 'FALSE';
    return String(cell.v);
  };
  const raw = (cell) => (cell ? (cell.f ? '=' + cell.f : cell.v == null ? '' : cell.v === true ? 'TRUE' : cell.v === false ? 'FALSE' : String(cell.v)) : '');
  const colName = (sh, c) => { if (sh.header) { const h = cellAt(sh, 0, c); const t = h && h.v != null ? String(h.v) : ''; if (t) return t; } const col = sh.columns[c]; return (col && col.name) || letter(c); };
  const colType = (sh, c) => (sh.columns[c] && sh.columns[c].type) || 'text';
  function ensureColumns(sh) {
    const n = ncols(sh);
    for (let c = 0; c < n; c++) if (!sh.columns[c]) sh.columns[c] = { name: sh.header ? colName(sh, c) : letter(c), type: 'text' };
  }
  function ensureCell(sh, r, c) {
    while (sh.rows.length <= r) sh.rows.push([]);
    const row = sh.rows[r];
    while (row.length <= c) row.push({ v: null });
    if (!row[c]) row[c] = { v: null };
    return row[c];
  }
  /** A typed entry: `=…` is a formula; numbers and booleans in typed columns become values of their type. */
  function parseEntry(text, type) {
    if (text === '') return { v: null };
    if (text.length > 1 && text[0] === '=') return { v: null, f: text.slice(1) };
    if ((type === 'number' || type === 'integer') && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text.trim())) return { v: Number(text.trim()) };
    if (type === 'boolean' && /^(true|false)$/i.test(text.trim())) return { v: /^true$/i.test(text.trim()) };
    return { v: text };
  }

  // ---------- rich text: model to DOM ----------
  function runNode(run) {
    let node = document.createTextNode('');
    const frag = document.createDocumentFragment();
    String(run.text || '').split('\n').forEach((part, i) => { if (i) frag.appendChild(document.createElement('br')); if (part) frag.appendChild(document.createTextNode(part)); });
    node = frag;
    const wrap = (tag) => { const el = document.createElement(tag); el.appendChild(node); node = el; };
    if (run.code) wrap('code');
    if (run.s) wrap('s');
    if (run.u) wrap('u');
    if (run.i) wrap('em');
    if (run.b) wrap('strong');
    const href = safeHref(run.href);
    if (href) { const a = document.createElement('a'); a.href = href; a.rel = 'noopener noreferrer'; a.target = '_blank'; a.appendChild(node); node = a; }
    return node;
  }
  function fillRuns(el, runs) {
    (runs || []).forEach((r) => el.appendChild(runNode(r)));
    if (!el.childNodes.length) el.appendChild(document.createElement('br'));
  }
  function listNode(list, editable) {
    const el = document.createElement(list.ordered ? 'ol' : 'ul');
    if (list.ordered && list.start && list.start !== 1) el.setAttribute('start', String(list.start));
    (list.items || []).forEach((it) => {
      const li = document.createElement('li');
      if (typeof it.checked === 'boolean') {
        li.className = 'fe-task';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = it.checked; cb.setAttribute('contenteditable', 'false'); cb.setAttribute('aria-label', 'Done'); if (!editable) cb.disabled = true;
        li.appendChild(cb); li.appendChild(document.createTextNode(' '));
      }
      (it.runs || []).forEach((r) => li.appendChild(runNode(r)));
      if (!(it.runs || []).length && typeof it.checked !== 'boolean') li.appendChild(document.createElement('br'));
      if (it.children && it.children.items && it.children.items.length) li.appendChild(listNode(it.children, editable));
      el.appendChild(li);
    });
    return el;
  }
  function blockNode(b, editable) {
    switch (b.type) {
      case 'heading': { const h = document.createElement('h' + Math.min(6, Math.max(1, b.level || 1))); fillRuns(h, b.runs); return h; }
      case 'list': return listNode(b, editable);
      case 'quote': { const q = document.createElement('blockquote'); const p = document.createElement('p'); fillRuns(p, b.runs); q.appendChild(p); return q; }
      case 'code': { const pre = document.createElement('pre'); if (b.lang) pre.setAttribute('data-lang', String(b.lang).slice(0, 40)); const code = document.createElement('code'); code.textContent = b.text || ''; pre.appendChild(code); return pre; }
      case 'table': {
        const t = document.createElement('table');
        const rows = b.rows || [];
        let body = null;
        rows.forEach((row, i) => {
          const head = b.header && i === 0;
          let sect;
          if (head) { sect = document.createElement('thead'); t.appendChild(sect); } else { if (!body) { body = document.createElement('tbody'); t.appendChild(body); } sect = body; }
          const tr = document.createElement('tr');
          (row || []).forEach((cell) => { const td = document.createElement(head ? 'th' : 'td'); if (head) td.setAttribute('scope', 'col'); fillRuns(td, cell); tr.appendChild(td); });
          sect.appendChild(tr);
        });
        return t;
      }
      case 'hr': return document.createElement('hr');
      default: { const p = document.createElement('p'); fillRuns(p, b.runs); return p; }
    }
  }
  function drawDoc(el, doc, editable) {
    while (el.firstChild) el.removeChild(el.firstChild);
    const blocks = (doc && doc.blocks) || [];
    blocks.forEach((b) => el.appendChild(blockNode(b, editable)));
    if (!blocks.length) { const p = document.createElement('p'); p.appendChild(document.createElement('br')); el.appendChild(p); }
  }

  // ---------- rich text: DOM to model (a whitelist walk) ----------
  const MARKS = ['b', 'i', 'u', 's', 'code', 'href'];
  const sameMarks = (a, b) => MARKS.every((k) => (a[k] || undefined) === (b[k] || undefined));
  function pushRun(out, text, marks) {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && sameMarks(last, marks)) { last.text += text; return; }
    const r = { text };
    MARKS.forEach((k) => { if (marks[k]) r[k] = marks[k]; });
    out.push(r);
  }
  function inlineRuns(node, marks, out, skipLists) {
    if (node.nodeType === 3) { pushRun(out, node.nodeValue.replace(/ /g, ' ').replace(/[\r\n]+/g, ' '), marks); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') { pushRun(out, '\n', marks); return; }
    if (tag === 'INPUT' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'IMG') return;
    if (skipLists && (tag === 'UL' || tag === 'OL')) return;
    const m = Object.assign({}, marks);
    if (tag === 'STRONG' || tag === 'B') m.b = true;
    else if (tag === 'EM' || tag === 'I') m.i = true;
    else if (tag === 'U' || tag === 'INS') m.u = true;
    else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') m.s = true;
    else if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') m.code = true;
    else if (tag === 'A') { const h = safeHref(node.getAttribute('href')); if (h) m.href = h; }
    else if (tag === 'SPAN' || tag === 'FONT') {
      const st = node.style || {};
      if (/^(bold|[6-9]00)$/.test(st.fontWeight || '')) m.b = true;
      if (st.fontStyle === 'italic') m.i = true;
      if (/underline/.test(st.textDecoration || st.textDecorationLine || '')) m.u = true;
      if (/line-through/.test(st.textDecoration || st.textDecorationLine || '')) m.s = true;
    }
    for (let c = node.firstChild; c; c = c.nextSibling) inlineRuns(c, m, out, skipLists);
  }
  const trimRuns = (runs) => {
    while (runs.length && /^\s*$/.test(runs[runs.length - 1].text) && runs[runs.length - 1].text.indexOf('\n') >= 0) runs.pop();
    if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\n+$/, '');
    if (runs.length && !runs[runs.length - 1].text) runs.pop();
    return runs;
  };
  const runsOf = (el, skipLists) => { const out = []; for (let c = el.firstChild; c; c = c.nextSibling) inlineRuns(c, {}, out, skipLists); return trimRuns(out); };
  function readList(el) {
    const list = { type: 'list', ordered: el.tagName === 'OL', items: [] };
    const start = parseInt(el.getAttribute('start') || '', 10);
    if (list.ordered && start > 1) list.start = start;
    for (let li = el.firstElementChild; li; li = li.nextElementSibling) {
      if (li.tagName !== 'LI') { if (li.tagName === 'UL' || li.tagName === 'OL') { const sub = readList(li); const prev = list.items[list.items.length - 1]; if (prev && !prev.children) prev.children = { ordered: sub.ordered, items: sub.items }; else list.items = list.items.concat(sub.items); } continue; }
      const item = { runs: runsOf(li, true) };
      if (item.runs.length && item.runs[0].text) item.runs[0].text = item.runs[0].text.replace(/^\s+/, '');
      if (item.runs.length && !item.runs[0].text) item.runs.shift();
      const cb = li.querySelector(':scope > input[type="checkbox"]');
      if (cb) item.checked = !!cb.checked;
      const sub = li.querySelector(':scope > ul, :scope > ol');
      if (sub) { const s = readList(sub); item.children = { ordered: s.ordered, items: s.items }; }
      list.items.push(item);
    }
    return list;
  }
  const BLOCKISH = /^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|PRE|TABLE|HR|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|FIGURE|DL|ADDRESS|FIELDSET|DETAILS)$/;
  function domToBlocks(root) {
    const blocks = [];
    let pending = [];
    const flush = () => { const runs = trimRuns(pending); pending = []; if (runs.length && runs.some((r) => r.text.trim())) blocks.push({ type: 'paragraph', runs }); };
    for (let n = root.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || (n.nodeType === 1 && !BLOCKISH.test(n.tagName))) {
        if (n.nodeType === 1 && n.tagName === 'BR' && !pending.length) continue;
        inlineRuns(n, {}, pending, false);
        continue;
      }
      if (n.nodeType !== 1) continue;
      flush();
      const tag = n.tagName;
      if (/^H[1-6]$/.test(tag)) { const runs = runsOf(n); if (runs.length) blocks.push({ type: 'heading', level: Number(tag[1]), runs }); }
      else if (tag === 'P') { const runs = runsOf(n); blocks.push({ type: 'paragraph', runs }); }
      else if (tag === 'UL' || tag === 'OL') { const l = readList(n); if (l.items.length) blocks.push(l); }
      else if (tag === 'BLOCKQUOTE') {
        const parts = [];
        const inner = domToBlocks(n);
        inner.forEach((b, i) => { if (i) parts.push({ text: '\n' }); (b.runs || (b.text ? [{ text: b.text }] : [])).forEach((r) => parts.push(r)); });
        const runs = []; parts.forEach((r) => pushRun(runs, r.text, r));
        if (runs.length) blocks.push({ type: 'quote', runs: trimRuns(runs) });
      }
      else if (tag === 'PRE') { const b = { type: 'code', text: n.textContent.replace(/\n$/, '') }; const lang = n.getAttribute('data-lang') || ((n.querySelector('code') || {}).className || '').replace(/^.*language-/, ''); if (lang && /^[\w+#.-]{1,40}$/.test(lang)) b.lang = lang; blocks.push(b); }
      else if (tag === 'TABLE') {
        const rows = []; let header = false;
        Array.prototype.forEach.call(n.querySelectorAll('tr'), (tr, i) => {
          const cells = Array.prototype.filter.call(tr.children, (c) => c.tagName === 'TD' || c.tagName === 'TH');
          if (i === 0 && (tr.parentElement.tagName === 'THEAD' || (cells.length && cells.every((c) => c.tagName === 'TH')))) header = true;
          rows.push(cells.map((c) => runsOf(c)));
        });
        if (rows.length) blocks.push({ type: 'table', header, rows });
      }
      else if (tag === 'HR') blocks.push({ type: 'hr' });
      else domToBlocks(n).forEach((b) => blocks.push(b));
    }
    flush();
    // Empty paragraphs in the middle are spacing the editor made; keep none.
    return blocks.filter((b) => b.type !== 'paragraph' || (b.runs && b.runs.some((r) => r.text.trim())));
  }
  const domToDoc = (el) => ({ blocks: domToBlocks(el) });

  // ---------- module-level guards ----------
  window.addEventListener('beforeunload', (e) => {
    const st = App.stateFor(ID);
    if (App.state.route === ID && st.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  const timers = { poll: null, capture: null, save: null };
  const clearTimers = () => { Object.keys(timers).forEach((k) => { if (timers[k]) { clearTimeout(timers[k]); timers[k] = null; } }); };
  window.addEventListener('hashchange', () => { if (App.parse().route !== ID && timers.poll) { clearTimeout(timers.poll); timers.poll = null; } });

  // ---------- loading ----------
  function reset(st, fileId) {
    clearTimers();
    Object.keys(st).forEach((k) => delete st[k]);
    Object.assign(st, { fileId: fileId || null, loading: false, waits: 0, tab: 'edit', sheet: 0, sel: { r: 0, c: 0 }, rowsShown: ROW_PAGE, invalid: {}, notesOpen: true });
  }
  function rerender(ctx) {
    if (App.state.route !== ID) return;
    if (document.getElementById('overlay')) { ctx.state.redraw = true; return; }
    capture(ctx);
    ctx.rerender();
  }
  /** Reads the rich editor back into the model (it is the source of truth only while it is on the page). */
  function capture(ctx) {
    const st = ctx.state;
    const el = document.querySelector('#main [data-fe-rich]');
    // Only edits are read back: after a load the model is newer than what the page still shows.
    if (el && st.dirty && st.data && isRich(st.data.kind) && st.tab === 'edit' && el.getAttribute('contenteditable') === 'true') st.doc = domToDoc(el);
  }
  function applyLoaded(st, d) {
    // saveKind: the kind a save writes; an .xls workbook is saved as an .xlsx copy (the server never writes .xls).
    st.data = { file: d.file, kind: d.kind, saveKind: d.saveKind || d.kind, version: d.version, editable: d.editable !== false, notes: d.notes || [] };
    st.doc = d.doc || null; st.text = d.text != null ? d.text : null;
    st.workbook = d.workbook || null; st.delimiter = d.delimiter || ',';
    if (st.workbook) st.workbook.sheets.forEach(ensureColumns);
    st.dirty = false; st.error = null; st.waiting = false; st.unsupported = null; st.conflict = null;
    if (st.sheet >= ((st.workbook && st.workbook.sheets.length) || 1)) st.sheet = 0;
  }
  function load(ctx, quiet) {
    const st = ctx.state; const id = st.fileId;
    if (!id) return Promise.resolve();
    if (!quiet) st.loading = true;
    return App.get('/api/files/' + enc(id) + '/document').then((d) => {
      if (st.fileId !== id) return;
      applyLoaded(st, d); st.loaded = true;
    }).catch((err) => {
      if (st.fileId !== id) return;
      st.loaded = true;
      if (err.status === 409) {
        st.waiting = true;
        if (st.waits++ < 40) { if (timers.poll) clearTimeout(timers.poll); timers.poll = setTimeout(() => { timers.poll = null; if (App.state.route === ID && st.fileId === id) load(ctx, true); }, 1500); }
        else st.waitGaveUp = true;
        return;
      }
      if (err.status === 415) {
        st.unsupported = { message: err.message };
        return App.get('/api/files/' + enc(id)).then((f) => { st.unsupported.file = f; }).catch(() => {});
      }
      st.error = err;
    }).finally(() => { st.loading = false; rerender(ctx); });
  }

  // ---------- saving ----------
  function payload(st) {
    const k = st.data.kind;
    if (k === 'markdown') return st.tab === 'source' ? { text: st.text || '' } : { doc: st.doc || { blocks: [] } };
    if (k === 'odt') return { doc: st.doc || { blocks: [] } };
    if (k === 'text') return { text: st.text || '' };
    return { workbook: st.workbook, delimiter: st.delimiter || ',' };
  }
  async function save(ctx) {
    const st = ctx.state;
    if (!st.data || !st.data.editable || st.saving || st.demo) { if (st.demo) ctx.toast('This is a sample document; open a file from Files to save.', 'warn'); return; }
    if (st.data.saveKind && st.data.saveKind !== st.data.kind) { saveAs(ctx); return; }
    capture(ctx);
    st.saving = true; markSaving(ctx, true);
    const id = st.fileId;
    try {
      const out = await App.put('/api/files/' + enc(id) + '/document', Object.assign({ kind: st.data.kind, baseVersion: st.data.version }, payload(st)));
      const v = out.version || {};
      st.dirty = false;
      if (out.file) st.data.file = out.file;
      if (v.state === 'ready') { st.data.version = v.number; st.pending = null; ctx.toast('Saved as version ' + esc(v.number) + '.', 'ok'); }
      else if (v.state === 'rejected') { st.dirty = true; ctx.toast('Version ' + esc(v.number) + ' was rejected by the scan: ' + esc(v.reason || 'no reason given') + '.', 'danger', 8000); }
      else { st.pending = { number: v.number, polls: 0 }; ctx.toast('Saved as version ' + esc(v.number) + '; the scan is still running.', 'ok'); watchPending(ctx); }
    } catch (err) {
      const p = err.problem || {};
      if (err.status === 409 && (p.latest != null || /newer|meanwhile|base/i.test(err.message || ''))) { st.conflict = { latest: p.latest != null ? p.latest : null, message: err.message }; openConflict(ctx); }
      else App.fail(err, 'Could not save');
    } finally { st.saving = false; rerender(ctx); }
  }
  function watchPending(ctx) {
    const st = ctx.state; const id = st.fileId;
    if (!st.pending) return;
    if (timers.save) clearTimeout(timers.save);
    timers.save = setTimeout(() => {
      timers.save = null;
      if (st.fileId !== id || !st.pending) return;
      App.get('/api/files/' + enc(id) + '/versions').then((list) => {
        const v = (list || []).find((x) => x.number === st.pending.number);
        if (v && v.state === 'ready') {
          st.data.version = v.number; st.pending = null;
          ctx.toast('Version ' + esc(v.number) + ' passed its scan.', 'ok');
          if (!st.dirty) return load(ctx, true);
          rerender(ctx);
        } else if (v && v.state === 'rejected') {
          st.pending = null; st.dirty = true; ctx.toast('Version ' + esc(v.number) + ' was rejected by the scan: ' + esc(v.reason || '') + '. Your edits are still here.', 'danger', 8000); rerender(ctx);
        } else if (st.pending.polls++ < 40) watchPending(ctx);
        else { st.pending = null; rerender(ctx); }
      }).catch(() => { if (st.pending && st.pending.polls++ < 40) watchPending(ctx); });
    }, 1500);
  }
  function markSaving(ctx, on) { const b = ctx.$('[data-fe-save]'); if (b) { b.disabled = on; b.textContent = on ? 'Saving…' : 'Save'; } }
  function copyName(name, kind, from) {
    const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(name || 'Untitled');
    // A copy in another format (an .xls saved as .xlsx) keeps the name and takes the new extension.
    if (from && from !== kind) return (m[1] || 'Untitled') + (EXT[kind] || '');
    return (m[1] || 'Untitled') + ' copy' + (m[2] || EXT[kind] || '');
  }
  function saveAs(ctx, opts) {
    const st = ctx.state; capture(ctx);
    const f = st.data.file || {};
    const kind = st.data.saveKind || st.data.kind;
    const body0 = Object.assign({ kind }, payload(st));
    const converting = kind !== st.data.kind;
    ctx.modal({ title: converting ? 'Save as ' + esc(KIND_NAMES[kind] || kind) : (opts && opts.conflict) ? 'Save my changes as a copy' : 'Save as a copy', body: UI.field('Name', UI.input(copyName(f.name, kind, st.data.kind), { attrs: 'data-fe-copyname maxlength="255"' }), 'A new file in the same folder, with the same label (' + esc(f.label || 'internal') + '). The original stays as it is.' + (converting ? ' ' + esc(KIND_NAMES[st.data.kind] || st.data.kind) + ' files are read here but not written.' : '')), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save copy', { kind: 'primary', attrs: 'data-fe-copyok' }), onMount(m) {
      const go = async () => {
        const name = m.querySelector('[data-fe-copyname]').value.trim();
        if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name)) { ctx.toast('Names are 1 to 255 characters without / or \\ or control characters.', 'danger'); return; }
        try {
          const out = await App.post('/api/files/documents', Object.assign({ name, folderId: f.folderId || null, label: f.label }, body0));
          App.closeOverlay();
          st.dirty = false;
          ctx.toast('Saved a copy as ' + esc(out.name) + '.', 'ok');
          ctx.navigate(ID, { file: out.id });
        } catch (err) { App.fail(err, 'Could not save the copy'); }
      };
      m.querySelector('[data-fe-copyok]').addEventListener('click', go);
      m.querySelector('[data-fe-copyname]').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    } });
  }
  function conflictText(st) {
    const n = st.conflict && st.conflict.latest != null ? st.conflict.latest : null;
    return (n != null ? 'Someone saved version ' + esc(n) + ' meanwhile.' : 'A newer version was saved meanwhile.') + ' Your edits were made on version ' + esc(st.data ? st.data.version : '') + '. Reload to see the newer version (your changes are lost), or save your changes as a copy.';
  }
  function openConflict(ctx) {
    const st = ctx.state;
    ctx.modal({ title: 'A newer version was saved', body: UI.notice(conflictText(st), 'warn'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reload', { kind: 'danger', attrs: 'data-fe-reload' }) + UI.btn('Save as a copy', { kind: 'primary', attrs: 'data-fe-conflictcopy' }), onMount(m) {
      m.querySelector('[data-fe-reload]').addEventListener('click', () => { App.closeOverlay(); st.dirty = false; st.conflict = null; st.waits = 0; load(ctx); });
      m.querySelector('[data-fe-conflictcopy]').addEventListener('click', () => { App.closeOverlay(); setTimeout(() => saveAs(ctx, { conflict: true }), 0); });
    } });
  }

  // ---------- rich editor ----------
  const BLOCK_CHOICES = [{ value: 'p', label: 'Paragraph' }, { value: 'h1', label: 'Heading 1' }, { value: 'h2', label: 'Heading 2' }, { value: 'h3', label: 'Heading 3' }, { value: 'h4', label: 'Heading 4' }, { value: 'h5', label: 'Heading 5' }, { value: 'h6', label: 'Heading 6' }, { value: 'blockquote', label: 'Quote' }, { value: 'pre', label: 'Code block' }];
  function richToolbar() {
    const tb = (cmd, label, text, toggle) => '<button type="button" class="btn sm ghost fe-tb" data-fe-cmd="' + cmd + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"' + (toggle ? ' aria-pressed="false"' : '') + '>' + text + '</button>';
    return '<div class="fe-toolbar" role="toolbar" aria-label="Formatting">'
      + UI.select(BLOCK_CHOICES, 'p', 'data-fe-block aria-label="Block style"')
      + tb('bold', 'Bold (Ctrl B)', '<b>B</b>', true) + tb('italic', 'Italic (Ctrl I)', '<i>I</i>', true) + tb('underline', 'Underline (Ctrl U)', '<u>U</u>', true) + tb('strikeThrough', 'Strikethrough', '<s>S</s>', true) + tb('code', 'Inline code', '<span class="mono">{ }</span>', false)
      + tb('link', 'Link (Ctrl K)', 'Link', false)
      + '<span class="fe-sep" aria-hidden="true"></span>'
      + tb('insertUnorderedList', 'Bulleted list', '• List', false) + tb('insertOrderedList', 'Numbered list', '1. List', false) + tb('task', 'Task list', '☐ Tasks', false)
      + tb('quote', 'Quote', '❝ Quote', false) + tb('codeblock', 'Code block', 'Code', false) + tb('table', 'Insert a table', 'Table', false) + tb('insertHorizontalRule', 'Horizontal rule', '―', false)
      + '<span class="fe-sep" aria-hidden="true"></span>'
      + tb('undo', 'Undo', 'Undo', false) + tb('redo', 'Redo', 'Redo', false)
      + '</div>';
  }
  function wireRich(ctx, el, editable) {
    const st = ctx.state;
    drawDoc(el, st.doc, editable);
    if (!editable) return;
    let range = null;
    const keep = () => { const s = window.getSelection(); if (s && s.rangeCount && el.contains(s.anchorNode)) range = s.getRangeAt(0).cloneRange(); updatePressed(); };
    const restore = () => { el.focus(); if (range) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); } };
    const changed = () => { if (!st.dirty) { st.dirty = true; const d = ctx.$('[data-fe-dirty]'); if (d) d.hidden = false; } if (timers.capture) clearTimeout(timers.capture); timers.capture = setTimeout(() => { timers.capture = null; if (document.contains(el)) st.doc = domToDoc(el); }, 400); };
    const exec = (cmd, arg) => { restore(); try { document.execCommand(cmd, false, arg); } catch (e) { /* unsupported */ } keep(); changed(); };
    const insertHtml = (html) => exec('insertHTML', html);
    const updatePressed = () => {
      ctx.$$('[data-fe-cmd][aria-pressed]').forEach((b) => { let on = false; try { on = document.queryCommandState(b.dataset.feCmd); } catch (e) { on = false; } b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('active', on); });
      const blockSel = ctx.$('[data-fe-block]');
      if (blockSel && range) { let n = range.startContainer; while (n && n !== el && !(n.nodeType === 1 && /^(P|H[1-6]|BLOCKQUOTE|PRE|LI|DIV)$/.test(n.tagName))) n = n.parentNode; let v = 'p'; for (let x = n; x && x !== el; x = x.parentNode) if (x.nodeType === 1 && /^(H[1-6]|BLOCKQUOTE|PRE)$/.test(x.tagName)) { v = x.tagName.toLowerCase(); break; } blockSel.value = v; }
    };
    const linkDialog = () => {
      const selText = range ? range.toString() : '';
      ctx.modal({ title: 'Add a link', body: UI.field('Address', UI.input('https://', { attrs: 'data-fe-url autocomplete="off"' }), 'http, https or mailto addresses only.') + (selText ? '' : UI.field('Text', UI.input('', { attrs: 'data-fe-urltext' }), 'Shown in the document; the address when left empty.')), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add link', { kind: 'primary', attrs: 'data-fe-urlok' }), onMount(m) {
        const go = () => {
          const url = safeHref(m.querySelector('[data-fe-url]').value);
          if (!url) { ctx.toast('Links must start with http://, https:// or mailto:.', 'danger'); return; }
          const t = m.querySelector('[data-fe-urltext]');
          App.closeOverlay();
          setTimeout(() => {
            if (selText) exec('createLink', url);
            else insertHtml('<a href="' + esc(url) + '">' + esc((t && t.value.trim()) || url) + '</a>');
          }, 0);
        };
        m.querySelector('[data-fe-urlok]').addEventListener('click', go);
        m.querySelector('[data-fe-url]').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      } });
    };
    const tableDialog = () => ctx.modal({ title: 'Insert a table', body: '<div class="formgrid">' + UI.field('Rows', UI.input(3, { type: 'number', attrs: 'data-fe-trows min="1" max="100"' })) + UI.field('Columns', UI.input(3, { type: 'number', attrs: 'data-fe-tcols min="1" max="20"' })) + '</div>' + UI.check('First row is a header', true, 'data-fe-thead'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Insert', { kind: 'primary', attrs: 'data-fe-tok' }), onMount(m) {
      m.querySelector('[data-fe-tok]').addEventListener('click', () => {
        const r = Math.max(1, Math.min(100, parseInt(m.querySelector('[data-fe-trows]').value, 10) || 3)); const c = Math.max(1, Math.min(20, parseInt(m.querySelector('[data-fe-tcols]').value, 10) || 3)); const head = m.querySelector('[data-fe-thead]').checked;
        let html = '<table>';
        for (let i = 0; i < r; i++) { const h = head && i === 0; html += (h ? '<thead>' : i === (head ? 1 : 0) ? '<tbody>' : '') + '<tr>' + new Array(c).fill(h ? '<th scope="col">Heading</th>' : '<td><br></td>').join('') + '</tr>' + (h ? '</thead>' : ''); }
        html += (r > (head ? 1 : 0) ? '</tbody>' : '') + '</table><p><br></p>';
        App.closeOverlay(); setTimeout(() => insertHtml(html), 0);
      });
    } });
    const inlineCode = () => {
      restore();
      const s = window.getSelection(); const text = s ? s.toString() : '';
      insertHtml('<code>' + esc(text || 'code') + '</code>&#8203;');
    };
    const taskList = () => {
      exec('insertUnorderedList');
      const s = window.getSelection(); let n = s && s.anchorNode;
      while (n && n !== el && !(n.nodeType === 1 && n.tagName === 'LI')) n = n.parentNode;
      const list = n && n !== el ? n.parentNode : null;
      if (list) Array.prototype.forEach.call(list.children, (li) => { if (li.tagName === 'LI' && !li.querySelector(':scope > input[type="checkbox"]')) { li.className = 'fe-task'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.setAttribute('contenteditable', 'false'); cb.setAttribute('aria-label', 'Done'); li.insertBefore(document.createTextNode(' '), li.firstChild); li.insertBefore(cb, li.firstChild); } });
      changed();
    };
    const command = (cmd) => {
      if (cmd === 'link') { keep(); linkDialog(); }
      else if (cmd === 'code') inlineCode();
      else if (cmd === 'task') taskList();
      else if (cmd === 'quote') exec('formatBlock', '<blockquote>');
      else if (cmd === 'codeblock') exec('formatBlock', '<pre>');
      else if (cmd === 'table') { keep(); tableDialog(); }
      else exec(cmd);
    };
    ctx.$$('[data-fe-cmd]').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => command(b.dataset.feCmd));
    });
    const blockSel = ctx.$('[data-fe-block]');
    if (blockSel) blockSel.addEventListener('change', () => exec('formatBlock', '<' + blockSel.value + '>'));
    ['keyup', 'mouseup', 'focus'].forEach((ev) => el.addEventListener(ev, keep));
    el.addEventListener('input', changed);
    el.addEventListener('change', changed);
    el.addEventListener('blur', () => { if (st.dirty && document.contains(el)) st.doc = domToDoc(el); });
    el.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'i' || k === 'u') { e.preventDefault(); keep(); exec(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline'); }
      else if (k === 'k') { e.preventDefault(); e.stopPropagation(); keep(); linkDialog(); }
    });
    // Paste goes through the same whitelist as the read-back: plain text as text, HTML as the blocks it holds.
    el.addEventListener('paste', (e) => {
      const cd = e.clipboardData; if (!cd) return;
      e.preventDefault();
      const html = cd.getData('text/html');
      if (html && window.DOMParser) {
        const body = new DOMParser().parseFromString(html, 'text/html').body;
        const doc = domToDoc(body);
        const box = document.createElement('div'); drawDoc(box, doc, true);
        const single = doc.blocks.length === 1 && doc.blocks[0].type === 'paragraph';
        keep(); insertHtml(single ? box.firstChild.innerHTML : box.innerHTML);
      } else { keep(); exec('insertText', cd.getData('text/plain')); }
    });
    el.addEventListener('drop', (e) => { e.preventDefault(); });
  }

  // ---------- spreadsheet grid ----------
  function currentSheet(st) { return st.workbook ? st.workbook.sheets[st.sheet] || st.workbook.sheets[0] : null; }
  function gridHtml(st, sh, editable) {
    const cols = ncols(sh); const rows = nrows(sh);
    const upto = Math.min(rows, st.rowsShown || ROW_PAGE);
    let h = '<table class="fe-grid" role="grid" aria-label="' + esc('Sheet ' + sh.name) + '" aria-rowcount="' + (rows + 1) + '" aria-colcount="' + (cols + 1) + '"' + (editable ? '' : ' aria-readonly="true"') + '><thead><tr><th scope="col" class="rn"><span class="sr">Row</span></th>';
    for (let c = 0; c < cols; c++) h += '<th scope="col" title="' + esc(colName(sh, c) + ', ' + colType(sh, c)) + '"><span class="fe-cl">' + letter(c) + '</span> ' + esc(colName(sh, c)) + ' <span class="fe-ct">' + esc(colType(sh, c)) + ((sh.columns[c] && sh.columns[c].required) ? ', required' : '') + '</span></th>';
    h += '</tr></thead><tbody>';
    for (let r = 0; r < upto; r++) {
      h += '<tr' + (sh.header && r === 0 ? ' class="hdr"' : '') + '><th scope="row" class="rn">' + (r + 1) + '</th>';
      for (let c = 0; c < cols; c++) {
        const cell = cellAt(sh, r, c); const isSel = st.sel.r === r && st.sel.c === c; const bad = st.invalid[r + ':' + c];
        const cls = (isSel ? 'sel ' : '') + (bad ? 'bad ' : '') + (cell && cell.b ? 'b ' : '') + (cell && cell.i ? 'i ' : '') + (cell && cell.f && cell.v == null ? 'fx ' : '') + (cell && typeof cell.v === 'number' ? 'num' : '');
        h += '<td tabindex="' + (isSel ? '0' : '-1') + '" data-r="' + r + '" data-c="' + c + '" class="' + cls + '" aria-selected="' + (isSel ? 'true' : 'false') + '"' + (bad ? ' title="' + esc(ref(r, c) + ': ' + bad) + '"' : '') + '>' + esc(shown(cell)) + (bad ? '<span class="sr"> (' + esc(bad) + ')</span>' : '') + '</td>';
      }
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }
  function sheetTabs(st, editable) {
    const wb = st.workbook;
    const multi = st.data && st.data.kind !== 'csv';
    if (!multi) return '';
    return '<div class="hstack wrap gap6"><div role="tablist" aria-label="Sheets" class="tabs fe-sheets">' + wb.sheets.map((s, i) => '<button type="button" role="tab" data-fe-sheet="' + i + '" aria-selected="' + (i === st.sheet ? 'true' : 'false') + '" tabindex="' + (i === st.sheet ? '0' : '-1') + '" class="' + (i === st.sheet ? 'active' : '') + '">' + esc(s.name) + '</button>').join('') + '</div>'
      + (editable ? UI.btn('Add sheet', { size: 'xs', kind: 'ghost', icon: 'plus', attrs: 'data-fe-addsheet' }) + UI.btn('Rename sheet', { size: 'xs', kind: 'ghost', attrs: 'data-fe-renamesheet' }) + UI.btn('Delete sheet', { size: 'xs', kind: 'ghost', attrs: 'data-fe-delsheet', disabled: wb.sheets.length < 2 }) : '') + '</div>';
  }
  function sheetToolbar(st, editable) {
    if (!editable) return '';
    const cell = cellAt(currentSheet(st), st.sel.r, st.sel.c);
    const tg = (attr, label, text, on) => '<button type="button" class="btn sm ghost' + (on ? ' active' : '') + '" ' + attr + ' aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + text + '</button>';
    return '<div class="fe-toolbar" role="toolbar" aria-label="Sheet">'
      + tg('data-fe-bold', 'Bold cell', '<b>B</b>', !!(cell && cell.b)) + tg('data-fe-italic', 'Italic cell', '<i>I</i>', !!(cell && cell.i))
      + '<span class="fe-sep" aria-hidden="true"></span>'
      + UI.btn('Row above', { size: 'xs', kind: 'ghost', attrs: 'data-fe-row="above"' }) + UI.btn('Row below', { size: 'xs', kind: 'ghost', attrs: 'data-fe-row="below"' }) + UI.btn('Delete row', { size: 'xs', kind: 'ghost', attrs: 'data-fe-delrow' })
      + '<span class="fe-sep" aria-hidden="true"></span>'
      + UI.btn('Add column', { size: 'xs', kind: 'ghost', attrs: 'data-fe-addcol' }) + UI.btn('Rename column', { size: 'xs', kind: 'ghost', attrs: 'data-fe-renamecol' }) + UI.btn('Remove column', { size: 'xs', kind: 'ghost', attrs: 'data-fe-delcol' }) + UI.btn('Define columns', { size: 'xs', attrs: 'data-fe-defcols' })
      + '<span class="fe-sep" aria-hidden="true"></span>'
      + UI.toggle('Header row', !!currentSheet(st).header, 'data-fe-header')
      + UI.btn('Detect types', { size: 'xs', attrs: 'data-fe-infer' }) + UI.btn('Format and normalise', { size: 'xs', kind: 'primary', attrs: 'data-fe-normalise' })
      + (st.normUndo ? UI.btn('Undo normalise', { size: 'xs', kind: 'ghost', attrs: 'data-fe-undonorm' }) : '')
      + '</div>';
  }
  function wireGrid(ctx, editable) {
    const st = ctx.state;
    const host = ctx.$('[data-fe-gridhost]'); if (!host) return;
    const fx = ctx.$('[data-fe-fx]'); const fxRef = ctx.$('[data-fe-fxref]');
    const sh = () => currentSheet(st);
    const markDirty = () => { st.dirty = true; const d = ctx.$('[data-fe-dirty]'); if (d) d.hidden = false; };
    const syncBar = () => {
      const s = sh(); const cell = cellAt(s, st.sel.r, st.sel.c);
      if (fxRef) fxRef.textContent = ref(st.sel.r, st.sel.c);
      if (fx && document.activeElement !== fx) fx.value = raw(cell);
      ctx.$$('[data-fe-bold]').forEach((b) => { const on = !!(cell && cell.b); b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('active', on); });
      ctx.$$('[data-fe-italic]').forEach((b) => { const on = !!(cell && cell.i); b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('active', on); });
      const info = ctx.$('[data-fe-selinfo]'); if (info) { const bad = st.invalid[st.sel.r + ':' + st.sel.c]; info.textContent = colName(s, st.sel.c) + ' (' + colType(s, st.sel.c) + ')' + (bad ? '. ' + bad : ''); }
    };
    const draw = (focus) => {
      const s = sh();
      st.sel.r = Math.max(0, Math.min(st.sel.r, nrows(s) - 1)); st.sel.c = Math.max(0, Math.min(st.sel.c, ncols(s) - 1));
      if (st.sel.r >= (st.rowsShown || ROW_PAGE)) st.rowsShown = Math.ceil((st.sel.r + 1) / ROW_PAGE) * ROW_PAGE;
      host.innerHTML = gridHtml(st, s, editable);
      const more = ctx.$('[data-fe-more]'); const count = ctx.$('[data-fe-rowcount]');
      if (count) count.textContent = plural(nrows(s), 'row') + ', ' + plural(ncols(s), 'column') + (nrows(s) > (st.rowsShown || ROW_PAGE) ? '; showing the first ' + Math.min(nrows(s), st.rowsShown) : '');
      if (more) more.hidden = nrows(s) <= (st.rowsShown || ROW_PAGE);
      syncBar();
      if (focus) { const td = host.querySelector('td[tabindex="0"]'); if (td) td.focus(); }
    };
    st.drawGrid = draw;
    const td = (r, c) => host.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
    const select = (r, c, focus) => {
      const s = sh(); r = Math.max(0, Math.min(r, nrows(s) - 1)); c = Math.max(0, Math.min(c, ncols(s) - 1));
      const old = td(st.sel.r, st.sel.c); if (old) { old.classList.remove('sel'); old.setAttribute('tabindex', '-1'); old.setAttribute('aria-selected', 'false'); }
      st.sel = { r, c };
      let cur = td(r, c);
      if (!cur) { draw(focus); return; }
      cur.classList.add('sel'); cur.setAttribute('tabindex', '0'); cur.setAttribute('aria-selected', 'true');
      if (focus) cur.focus();
      syncBar();
    };
    const commit = (r, c, text) => {
      const s = sh();
      const cell = ensureCell(s, r, c);
      const parsed = parseEntry(text, colType(s, c));
      if (raw(cell) === text) return false;
      cell.v = parsed.v; if (parsed.f) cell.f = parsed.f; else delete cell.f;
      if (s.header && r === 0 && s.columns[c]) s.columns[c].name = text;
      delete st.invalid[r + ':' + c];
      markDirty();
      return true;
    };
    const edit = (start) => {
      if (!editable) return;
      const r = st.sel.r; const c = st.sel.c; const cellEl = td(r, c); if (!cellEl) return;
      const before = raw(cellAt(sh(), r, c));
      const input = document.createElement('input');
      input.className = 'fe-cellin'; input.setAttribute('aria-label', 'Cell ' + ref(r, c)); input.value = start != null ? start : before;
      cellEl.textContent = ''; cellEl.appendChild(input); input.focus();
      if (start == null) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
      let done = false;
      const finish = (save, dr, dc) => {
        if (done) return; done = true;
        if (save) commit(r, c, input.value);
        draw(false);
        select(r + (dr || 0), c + (dc || 0), true);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1, 0); }
        else if (e.key === 'Tab') { e.preventDefault(); finish(true, 0, e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, 0, 0); }
        else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey) { e.preventDefault(); finish(true, e.key === 'ArrowUp' ? -1 : 1, 0); }
        e.stopPropagation();
      });
      input.addEventListener('blur', () => finish(true, 0, 0));
    };
    host.addEventListener('click', (e) => { const cellEl = e.target.closest('td[data-r]'); if (!cellEl || e.target.tagName === 'INPUT') return; select(+cellEl.dataset.r, +cellEl.dataset.c, true); });
    host.addEventListener('dblclick', (e) => { const cellEl = e.target.closest('td[data-r]'); if (cellEl && e.target.tagName !== 'INPUT') edit(null); });
    host.addEventListener('keydown', (e) => {
      const cellEl = e.target.closest && e.target.closest('td[data-r]'); if (!cellEl || e.target.tagName === 'INPUT') return;
      const r = st.sel.r, c = st.sel.c; const s = sh();
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (moves[e.key]) { e.preventDefault(); select(r + moves[e.key][0], c + moves[e.key][1], true); }
      else if (e.key === 'Home') { e.preventDefault(); select(e.ctrlKey ? 0 : r, 0, true); }
      else if (e.key === 'End') { e.preventDefault(); select(e.ctrlKey ? nrows(s) - 1 : r, ncols(s) - 1, true); }
      else if (e.key === 'PageDown') { e.preventDefault(); select(r + 20, c, true); }
      else if (e.key === 'PageUp') { e.preventDefault(); select(r - 20, c, true); }
      else if (e.key === 'Tab') { if (c + (e.shiftKey ? -1 : 1) >= 0 && c + (e.shiftKey ? -1 : 1) < ncols(s)) { e.preventDefault(); select(r, c + (e.shiftKey ? -1 : 1), true); } }
      else if (!editable) return;
      else if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); edit(null); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (commit(r, c, '')) { draw(false); select(r, c, true); } }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'i')) { e.preventDefault(); toggleMark(e.key === 'b' ? 'b' : 'i'); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); edit(e.key); }
    });
    const toggleMark = (k) => { const s = sh(); const cell = ensureCell(s, st.sel.r, st.sel.c); if (cell[k]) delete cell[k]; else cell[k] = true; markDirty(); draw(true); };
    if (fx) {
      fx.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(st.sel.r, st.sel.c, fx.value); draw(false); select(st.sel.r + 1, st.sel.c, true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fx.value = raw(cellAt(sh(), st.sel.r, st.sel.c)); select(st.sel.r, st.sel.c, true); }
      });
      fx.addEventListener('change', () => { if (commit(st.sel.r, st.sel.c, fx.value)) draw(false); });
    }
    ctx.on('click', '[data-fe-more]', () => { st.rowsShown = (st.rowsShown || ROW_PAGE) + ROW_PAGE; draw(false); });
    if (!editable) { draw(false); return; }
    ctx.on('click', '[data-fe-bold]', () => toggleMark('b'));
    ctx.on('click', '[data-fe-italic]', () => toggleMark('i'));
    ctx.on('click', '[data-fe-row]', (e, t) => { const s = sh(); const at = st.sel.r + (t.dataset.feRow === 'below' ? 1 : 0); s.rows.splice(Math.min(at, s.rows.length), 0, []); st.invalid = {}; markDirty(); st.sel.r = at; draw(true); });
    ctx.on('click', '[data-fe-delrow]', async () => {
      const s = sh(); if (nrows(s) <= 1) { ctx.toast('A sheet keeps at least one row.', 'warn'); return; }
      const ok = await ctx.confirm({ title: 'Delete row ' + (st.sel.r + 1), tone: 'danger', body: '<p class="fg2" style="margin:0">The row and its cells go. Formulas that point at rows below are not rewritten.</p>', ok: 'Delete row' });
      if (!ok) return; s.rows.splice(st.sel.r, 1); st.invalid = {}; markDirty(); draw(true);
    });
    ctx.on('click', '[data-fe-addcol]', () => columnDialog(ctx, null, markDirty));
    ctx.on('click', '[data-fe-renamecol]', () => columnDialog(ctx, st.sel.c, markDirty));
    ctx.on('click', '[data-fe-delcol]', async () => {
      const s = sh(); const c = st.sel.c;
      if (ncols(s) <= 1) { ctx.toast('A sheet keeps at least one column.', 'warn'); return; }
      const ok = await ctx.confirm({ title: 'Remove column ' + letter(c) + ' (' + colName(s, c) + ')', tone: 'danger', body: '<p class="fg2" style="margin:0">Every cell in the column goes, in ' + plural(nrows(s), 'row') + '. Formulas that point at columns to the right are not rewritten.</p>', ok: 'Remove column' });
      if (!ok) return;
      s.rows.forEach((row) => { if (row.length > c) row.splice(c, 1); }); s.columns.splice(c, 1); st.invalid = {}; markDirty(); draw(true);
    });
    ctx.on('click', '[data-fe-defcols]', () => defineColumns(ctx, markDirty));
    ctx.on('click', '[data-fe-header]', () => { const s = sh(); s.header = !s.header; markDirty(); rerender(ctx); });
    ctx.on('click', '[data-fe-infer]', async () => {
      try { const out = await App.post('/api/files/table/infer', { sheet: sh() }); const s = sh(); (out.columns || []).forEach((col, i) => { s.columns[i] = Object.assign({}, s.columns[i] || {}, { name: col.name != null ? col.name : colName(s, i), type: col.type || 'text' }); }); markDirty(); ctx.toast('Column types detected: ' + esc(s.columns.map((x) => x.name + ' ' + x.type).join(', ')) + '.', 'ok', 6000); rerender(ctx); }
      catch (err) { App.fail(err, 'Could not detect the types'); }
    });
    ctx.on('click', '[data-fe-normalise]', () => normaliseDialog(ctx, markDirty));
    ctx.on('click', '[data-fe-undonorm]', () => { if (!st.normUndo) return; st.workbook.sheets[st.normUndo.index] = st.normUndo.sheet; st.normUndo = null; st.invalid = {}; markDirty(); ctx.toast('Normalising undone.', 'ok'); rerender(ctx); });
    draw(false);
  }
  function columnDialog(ctx, at, markDirty) {
    const st = ctx.state; const s = currentSheet(st);
    const adding = at == null;
    const col = adding ? { name: '', type: 'text' } : (s.columns[at] || { name: colName(s, at), type: colType(s, at) });
    const name0 = adding ? '' : colName(s, at);
    ctx.modal({ title: adding ? 'Add a column' : 'Rename column ' + letter(at), body: '<div class="formgrid">' + UI.field('Name', UI.input(name0, { attrs: 'data-fe-cname maxlength="200"' }), s.header ? 'Written in the header row.' : 'Kept with the column\'s definition.') + UI.field('Type', UI.select(COLUMN_TYPES, col.type || 'text', 'data-fe-ctype'), 'Used by normalising to check and convert the values.') + (adding ? UI.field('Where', UI.select([{ value: 'right', label: 'Right of ' + letter(st.sel.c) }, { value: 'left', label: 'Left of ' + letter(st.sel.c) }, { value: 'end', label: 'At the end' }], 'right', 'data-fe-cwhere')) : '') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(adding ? 'Add column' : 'Save', { kind: 'primary', attrs: 'data-fe-cok' }), onMount(m) {
      m.querySelector('[data-fe-cok]').addEventListener('click', () => {
        const name = m.querySelector('[data-fe-cname]').value.trim(); const type = m.querySelector('[data-fe-ctype]').value;
        if (!name) { ctx.toast('Give the column a name.', 'warn'); return; }
        if (adding) {
          const where = m.querySelector('[data-fe-cwhere]').value; const n = ncols(s);
          const c = where === 'end' ? n : where === 'left' ? st.sel.c : st.sel.c + 1;
          ensureColumns(s);
          s.rows.forEach((row) => { if (row.length >= c) row.splice(c, 0, { v: null }); });
          s.columns.splice(c, 0, { name, type });
          if (s.header) ensureCell(s, 0, c).v = name;
          st.sel.c = c;
        } else {
          ensureColumns(s);
          s.columns[at] = Object.assign({}, s.columns[at], { name, type });
          if (s.header) ensureCell(s, 0, at).v = name;
        }
        markDirty(); App.closeOverlay(); rerender(ctx);
      });
    } });
  }
  function defineColumns(ctx, markDirty) {
    const st = ctx.state; const s = currentSheet(st);
    ensureColumns(s);
    const sheetKind = st.data && st.data.kind !== 'csv';
    let cols = s.columns.map((c, i) => ({ name: colName(s, i), type: c.type || 'text', required: !!c.required, width: c.width || '', from: i }));
    const rowHtml = () => cols.map((c, i) => [
      '<span class="mono">' + letter(i) + '</span>',
      UI.input(c.name, { attrs: 'data-dc-name="' + i + '" aria-label="Name of column ' + letter(i) + '" maxlength="200"' }),
      UI.select(COLUMN_TYPES, c.type, 'data-dc-type="' + i + '" aria-label="Type of column ' + letter(i) + '"'),
      '<input type="checkbox" data-dc-req="' + i + '"' + (c.required ? ' checked' : '') + ' aria-label="Column ' + letter(i) + ' is required">',
      '<span class="hstack gap4">' + UI.btn('←', { size: 'xs', kind: 'ghost', attrs: 'data-dc-up="' + i + '" aria-label="Move column ' + letter(i) + ' left"', disabled: i === 0 }) + UI.btn('→', { size: 'xs', kind: 'ghost', attrs: 'data-dc-down="' + i + '" aria-label="Move column ' + letter(i) + ' right"', disabled: i === cols.length - 1 }) + '</span>'
    ].concat(sheetKind ? [UI.input(c.width, { type: 'number', attrs: 'data-dc-width="' + i + '" min="2" max="255" aria-label="Width of column ' + letter(i) + ' in characters"' })] : []));
    const heads = ['Col', 'Name', 'Type', 'Required', { label: '', srLabel: 'Order' }].concat(sheetKind ? ['Width'] : []);
    const tableHtml = () => UI.table(heads, rowHtml(), { clickable: false, minWidth: '520px' });
    ctx.modal({ title: 'Define columns of ' + esc(s.name), cls: 'wide', body: '<p class="fg2" style="margin:0">Names' + (s.header ? ' are written to the header row' : ' are kept with the columns') + '. Types and required are what normalising checks and converts. Moving a column moves its cells.</p><div data-dc-table>' + tableHtml() + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save columns', { kind: 'primary', attrs: 'data-dc-ok' }), onMount(m) {
      const read = () => cols.forEach((c, i) => { c.name = m.querySelector('[data-dc-name="' + i + '"]').value.trim(); c.type = m.querySelector('[data-dc-type="' + i + '"]').value; c.required = m.querySelector('[data-dc-req="' + i + '"]').checked; const w = m.querySelector('[data-dc-width="' + i + '"]'); c.width = w ? w.value : ''; });
      const redraw = () => { m.querySelector('[data-dc-table]').innerHTML = tableHtml(); };
      m.addEventListener('click', (e) => {
        const up = e.target.closest('[data-dc-up]'); const down = e.target.closest('[data-dc-down]');
        if (!up && !down) return;
        read();
        const i = +(up ? up.dataset.dcUp : down.dataset.dcDown); const j = up ? i - 1 : i + 1;
        if (j < 0 || j >= cols.length) return;
        const t = cols[i]; cols[i] = cols[j]; cols[j] = t; redraw();
        const again = m.querySelector(up ? '[data-dc-up="' + j + '"]' : '[data-dc-down="' + j + '"]'); if (again) again.focus();
      });
      m.querySelector('[data-dc-ok]').addEventListener('click', () => {
        read();
        if (cols.some((c) => !c.name)) { ctx.toast('Every column needs a name.', 'warn'); return; }
        const order = cols.map((c) => c.from);
        if (order.some((f, i) => f !== i)) s.rows = s.rows.map((row) => order.map((f) => row[f] || { v: null }));
        s.columns = cols.map((c) => { const out = { name: c.name, type: c.type }; if (c.required) out.required = true; const w = parseFloat(c.width); if (w > 0) out.width = w; return out; });
        if (s.header) cols.forEach((c, i) => { ensureCell(s, 0, i).v = c.name; });
        st.invalid = {}; markDirty(); App.closeOverlay(); ctx.toast('Columns saved in the editor; save the file to keep them.', 'ok'); rerender(ctx);
      });
    } });
  }
  function reportHtml(report) {
    const r = report || {};
    const inv = (r.invalid || []).slice(0, 50);
    return UI.kv([['Cells changed', '<span class="num">' + (r.changedCells || 0) + '</span>'], ['Rows removed', '<span class="num">' + (r.removedRows || 0) + '</span>'], ['Columns removed', '<span class="num">' + (r.removedColumns || 0) + '</span>'], ['Duplicate rows', '<span class="num">' + (r.duplicateRows || 0) + '</span>'], ['Invalid cells', '<span class="num">' + (r.invalidCount != null ? r.invalidCount : (r.invalid || []).length) + '</span>'], ['Required cells empty', '<span class="num">' + (r.requiredMissing || 0) + '</span>']], 3)
      + (inv.length ? UI.table(['Cell', 'Value', 'Why'], inv.map((x) => [ '<span class="mono">' + esc(x.ref || ref(x.row, x.col)) + '</span>', esc(x.value == null ? '' : String(x.value)), esc(x.reason || '') ]), { clickable: false, minWidth: '0' }) + ((r.invalidCount || 0) > inv.length ? '<span class="muted" style="font-size:12px">The first ' + inv.length + ' of ' + r.invalidCount + ' are listed; all are outlined in the grid.</span>' : '') : '');
  }
  function normaliseDialog(ctx, markDirty) {
    const st = ctx.state; const s = currentSheet(st); const index = st.sheet;
    const o = st.normOptions || { trim: true, collapseSpaces: true, emptyMarkers: 'n/a, N/A, NA, null, -', coerce: true, dayFirst: false, removeEmptyRows: true, removeEmptyColumns: false, dedupe: false, padRows: true, textCase: 'none', headerCase: 'none' };
    const ch = (k, label) => UI.check(label, !!o[k], 'data-nm="' + k + '"');
    ctx.modal({ title: 'Format and normalise ' + esc(s.name), cls: 'wide', body: '<p class="fg2" style="margin:0">Cleans the values by the column types (Define columns). Nothing changes until you apply the result, and you can undo it before saving.</p>'
      + '<div class="fe-nmgrid">' + ch('trim', 'Trim spaces at the ends') + ch('collapseSpaces', 'Collapse repeated spaces') + ch('coerce', 'Convert values to their column type') + ch('dayFirst', 'Dates are day first (31/12/2026)') + ch('removeEmptyRows', 'Remove empty rows') + ch('removeEmptyColumns', 'Remove empty columns') + ch('dedupe', 'Remove duplicate rows') + ch('padRows', 'Give every row every column') + '</div>'
      + '<div class="formgrid">' + UI.field('Empty markers', UI.input(o.emptyMarkers, { attrs: 'data-nm-empty' }), 'Values read as empty, comma separated.') + UI.field('Text case', UI.select([{ value: 'none', label: 'Leave as is' }, { value: 'lower', label: 'lower case' }, { value: 'upper', label: 'UPPER CASE' }, { value: 'title', label: 'Title Case' }], o.textCase, 'data-nm-text')) + UI.field('Header names', UI.select([{ value: 'none', label: 'Leave as is' }, { value: 'snake', label: 'snake_case' }, { value: 'title', label: 'Title Case' }, { value: 'lower', label: 'lower case' }], o.headerCase, 'data-nm-head')) + '</div>'
      + '<div data-nm-out aria-live="polite" class="vstack gap6"></div>',
    actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Preview', { attrs: 'data-nm-go' }) + UI.btn('Apply', { kind: 'primary', attrs: 'data-nm-apply', disabled: true }), onMount(m) {
      let result = null;
      const options = () => {
        const out = {};
        ['trim', 'collapseSpaces', 'coerce', 'dayFirst', 'removeEmptyRows', 'removeEmptyColumns', 'dedupe', 'padRows'].forEach((k) => { out[k] = m.querySelector('[data-nm="' + k + '"]').checked; });
        out.emptyMarkers = m.querySelector('[data-nm-empty]').value.split(',').map((x) => x.trim()).filter(Boolean);
        out.textCase = m.querySelector('[data-nm-text]').value; out.headerCase = m.querySelector('[data-nm-head]').value;
        st.normOptions = Object.assign({}, out, { emptyMarkers: out.emptyMarkers.join(', ') });
        return out;
      };
      const outEl = m.querySelector('[data-nm-out]'); const apply = m.querySelector('[data-nm-apply]');
      m.querySelector('[data-nm-go]').addEventListener('click', async () => {
        outEl.innerHTML = UI.notice('Normalising…', 'info'); apply.disabled = true;
        try { result = await App.post('/api/files/table/normalize', { sheet: s, options: options() }); outEl.innerHTML = reportHtml(result.report); apply.disabled = false; }
        catch (err) { result = null; outEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(err.message), 'danger'); }
      });
      apply.addEventListener('click', () => {
        if (!result || !result.sheet) return;
        st.normUndo = { index, sheet: clone(s) };
        const next = result.sheet; ensureColumns(next);
        st.workbook.sheets[index] = next;
        st.invalid = {};
        ((result.report && result.report.invalid) || []).forEach((x) => { if (x.row != null && x.col != null) st.invalid[x.row + ':' + x.col] = x.reason || 'Invalid value'; });
        st.lastReport = result.report;
        markDirty(); App.closeOverlay();
        ctx.toast('Normalised: ' + esc((result.report && result.report.changedCells) || 0) + ' cells changed. Invalid cells are outlined.', 'ok', 6000);
        rerender(ctx);
      });
    } });
  }

  // ---------- page ----------
  const STYLE = '<style>'
    + '#main .fe-page{gap:12px}'
    + '#main .fe-toolbar{display:flex;flex-wrap:wrap;gap:4px;align-items:center}'
    + '#main .fe-toolbar .select{width:auto;min-width:9em}'
    + '#main .fe-toolbar .btn.active{background:var(--accent-tint);border-color:var(--accent)}'
    + '#main .fe-sep{width:1px;align-self:stretch;background:var(--line);margin:0 4px}'
    + '#main .fe-rich{min-height:340px;border:1px solid var(--line);border-radius:8px;padding:16px 20px;background:var(--panel);color:var(--fg);line-height:1.6;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box}'
    + '#main .fe-rich:focus{outline:2px solid var(--accent);outline-offset:1px}'
    + '#main .fe-rich h1,#main .fe-rich h2,#main .fe-rich h3,#main .fe-rich h4,#main .fe-rich h5,#main .fe-rich h6{margin:.6em 0 .3em;line-height:1.3}'
    + '#main .fe-rich p{margin:.4em 0}#main .fe-rich ul,#main .fe-rich ol{margin:.4em 0;padding-left:1.6em}'
    + '#main .fe-rich li.fe-task{list-style:none;margin-left:-1.3em}'
    + '#main .fe-rich blockquote{margin:.5em 0;padding:2px 12px;border-left:3px solid var(--line2);color:var(--fg2)}'
    + '#main .fe-rich pre{background:var(--panel2);padding:10px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono);font-size:13px}'
    + '#main .fe-rich code{font-family:var(--mono);font-size:.92em;background:var(--panel2);padding:0 3px;border-radius:3px}#main .fe-rich pre code{background:none;padding:0}'
    + '#main .fe-rich a{color:var(--accent);text-decoration:underline}'
    + '#main .fe-rich table{border-collapse:collapse;display:block;max-width:100%;overflow-x:auto;margin:.5em 0}'
    + '#main .fe-rich td,#main .fe-rich th{border:1px solid var(--line);padding:4px 8px;min-width:4em;vertical-align:top}#main .fe-rich th{background:var(--panel2);text-align:left}'
    + '#main .fe-rich hr{border:0;border-top:1px solid var(--line);margin:1em 0}'
    + '#main .fe-source{width:100%;min-height:420px;font-family:var(--mono);font-size:13px;box-sizing:border-box}'
    + '#main .fe-fbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}#main .fe-fbar .ref{font-family:var(--mono);min-width:4em;font-weight:600}#main .fe-fbar .input{flex:1 1 220px;min-width:0}'
    + '#main .fe-gridwrap{overflow:auto;max-height:62vh;max-width:100%;border:1px solid var(--line);border-radius:8px;background:var(--panel)}'
    + '#main .fe-grid{border-collapse:separate;border-spacing:0;font-size:13px}'
    + '#main .fe-grid th,#main .fe-grid td{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:3px 8px;min-width:72px;max-width:260px;height:26px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;color:var(--fg)}'
    + '#main .fe-grid thead th{position:sticky;top:0;z-index:2;background:var(--panel2);font-weight:600}'
    + '#main .fe-grid .rn{position:sticky;left:0;z-index:1;background:var(--panel2);min-width:44px;text-align:right;color:var(--fg2);font-weight:400}#main .fe-grid thead .rn{z-index:3}'
    + '#main .fe-grid .fe-cl{font-family:var(--mono);color:var(--fg2)}#main .fe-grid .fe-ct{font-weight:400;font-size:11px;color:var(--fg2)}'
    + '#main .fe-grid tr.hdr td{font-weight:600;background:var(--panel2)}'
    + '#main .fe-grid td.num{text-align:right;font-variant-numeric:tabular-nums}#main .fe-grid td.b{font-weight:700}#main .fe-grid td.i{font-style:italic}#main .fe-grid td.fx{color:var(--fg2);font-family:var(--mono)}'
    + '#main .fe-grid td:focus{outline:none}#main .fe-grid td.sel{box-shadow:inset 0 0 0 2px var(--accent)}'
    + '#main .fe-grid td.bad{box-shadow:inset 0 0 0 2px var(--danger-fg);background:var(--danger-bg)}#main .fe-grid td.bad.sel{box-shadow:inset 0 0 0 2px var(--accent),inset 0 0 0 4px var(--danger-fg)}'
    + '#main .fe-grid .fe-cellin{width:100%;min-width:120px;border:0;font:inherit;background:var(--bg);color:var(--fg);padding:0;outline:none}'
    + '#main .fe-sheets{flex-wrap:wrap}'
    + '.modal .fe-nmgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:6px}'
    + '</style>';

  function headerHtml(st) {
    const d = st.data; const f = d.file || {};
    const sub = UI.label(f.label || 'internal', { sm: true }) + ' ' + UI.pill(KIND_NAMES[d.kind] || d.kind, 'outline') + ' <span class="muted">version ' + esc(d.version) + '</span>'
      + (d.editable ? '' : ' ' + UI.pill('Read only', 'warn'))
      + ' <span data-fe-dirty' + (st.dirty ? '' : ' hidden') + '>' + UI.pill('Unsaved changes', 'warn') + '</span>'
      + (st.pending ? ' ' + UI.pill('Version ' + st.pending.number + ' scanning', 'info') : '')
      + (st.demo ? ' ' + UI.pill('Sample', 'info') : '');
    const actions = UI.btn('Back to Files', { kind: 'ghost', attrs: 'data-fe-back' })
      + (st.demo ? '' : '<a class="btn" href="/api/files/' + esc(enc(st.fileId)) + '/content" download data-fe-download>Download</a>')
      + (isSheet(d.kind) && !st.demo ? UI.btn('New table query', { attrs: 'data-fe-query' }) : '')
      + (d.editable ? (d.saveKind && d.saveKind !== d.kind ? UI.btn('Save as ' + (EXT[d.saveKind] || d.saveKind) + '…', { kind: 'primary', attrs: 'data-fe-saveas' }) : UI.btn('Save as…', { attrs: 'data-fe-saveas' }) + UI.btn(st.saving ? 'Saving…' : 'Save', { kind: 'primary', attrs: 'data-fe-save', disabled: st.saving })) : '');
    return UI.pagehead(f.name || 'Document', sub, actions);
  }
  function bodyHtml(st) {
    const d = st.data; const k = d.kind; const editable = d.editable;
    let out = '';
    if (d.notes && d.notes.length && st.notesOpen) out += UI.notice('<b>Read with changes.</b> ' + d.notes.map((n) => esc(n)).join(' ') + (editable ? ' Saving writes the document as shown here.' : ''), 'warn', UI.btn('Dismiss', { size: 'sm', kind: 'ghost', attrs: 'data-fe-notes' }));
    if (st.conflict) out += UI.notice(conflictText(st), 'warn', UI.btn('Reload', { size: 'sm', kind: 'ghost', attrs: 'data-fe-reloadinline' }) + UI.btn('Save as a copy', { size: 'sm', attrs: 'data-fe-copyinline' }));
    if (isRich(k)) {
      if (k === 'markdown') out += '<div role="tablist" aria-label="Editor mode" class="tabs">' + [['edit', 'Edit'], ['source', 'Markdown source']].map((t) => '<button type="button" role="tab" data-fe-tab="' + t[0] + '" aria-selected="' + (st.tab === t[0] ? 'true' : 'false') + '" tabindex="' + (st.tab === t[0] ? '0' : '-1') + '" class="' + (st.tab === t[0] ? 'active' : '') + '">' + t[1] + '</button>').join('') + '</div>';
      if (k === 'markdown' && st.tab === 'source') out += '<div class="vstack gap6">' + UI.textarea(st.text || '', { attrs: 'data-fe-src class="textarea fe-source" aria-label="Markdown source" spellcheck="false"' + (editable ? '' : ' readonly') }) + '<span class="muted" style="font-size:12px">Saving from here writes this text as it is. Switching back to Edit reads it into the editor.</span></div>';
      else out += '<div class="vstack gap6">' + (editable ? richToolbar() : '') + '<div class="fe-rich" data-fe-rich role="textbox" aria-multiline="true" aria-label="' + esc((d.file && d.file.name) || 'Document') + '"' + (editable ? ' contenteditable="true" spellcheck="true"' : ' aria-readonly="true" contenteditable="false" tabindex="0"') + '></div>'
        + (editable ? '<span class="muted" style="font-size:12px">Ctrl or Cmd with B, I, U and K for bold, italic, underline and links; Ctrl S saves. Pasted text keeps headings, lists, links, tables and bold or italic, nothing else.</span>' : '') + '</div>';
    } else if (k === 'text') {
      out += UI.textarea(st.text || '', { attrs: 'data-fe-text class="textarea fe-source" aria-label="Text" spellcheck="true"' + (editable ? '' : ' readonly') });
    } else if (isSheet(k) && st.workbook) {
      const s = currentSheet(st);
      out += sheetTabs(st, editable) + sheetToolbar(st, editable)
        + '<div class="fe-fbar"><span class="ref" data-fe-fxref aria-live="polite">' + esc(ref(st.sel.r, st.sel.c)) + '</span>' + '<input class="input" data-fe-fx aria-label="Value or formula of the selected cell" placeholder="Value, or =formula"' + (editable ? '' : ' readonly') + '><span class="muted" style="font-size:12px" data-fe-selinfo></span></div>'
        + (editable ? '<span class="muted" style="font-size:12px">Arrow keys move; type, Enter or F2 to edit; Delete clears. A formula starts with = and is calculated when the file is opened in a spreadsheet.' + (k === 'csv' ? ' CSV keeps values only: formulas and bold or italic are written as text or dropped.' : '') + '</span>' : '')
        + (st.lastReport ? '<details class="fe-report"><summary>Last normalise report</summary>' + reportHtml(st.lastReport) + '</details>' : '')
        + '<div class="fe-gridwrap" role="region" aria-label="' + esc('Cells of ' + s.name + ', scrollable') + '" data-fe-gridhost></div>'
        + '<div class="hstack gap6"><span class="muted" style="font-size:12px" data-fe-rowcount></span>' + UI.btn('Show more rows', { size: 'xs', attrs: 'data-fe-more hidden' }) + '</div>';
    }
    return out;
  }

  function wirePage(ctx) {
    const st = ctx.state; const d = st.data; const editable = d.editable;
    const leave = async () => {
      capture(ctx);
      if (st.dirty && !st.demo) {
        const ok = await ctx.confirm({ title: 'Leave without saving', tone: 'danger', body: '<p class="fg2" style="margin:0">Your changes to ' + esc((d.file && d.file.name) || 'this document') + ' are not saved. They stay here until you open another file, but are lost if the page is closed.</p>', ok: 'Leave', cancel: 'Stay' });
        if (!ok) return;
      }
      ctx.navigate('files', st.demo || !st.fileId ? undefined : { file: st.fileId });
    };
    ctx.on('click', '[data-fe-back]', leave);
    ctx.on('click', '[data-fe-query]', () => { capture(ctx); if (st.dirty) ctx.toast('The query reads the saved file, not your unsaved edits.', 'warn', 5000); ctx.navigate('file-query', Object.assign({ file: st.fileId }, st.workbook && st.workbook.sheets[st.sheet] && st.data.kind !== 'csv' ? { sheet: st.workbook.sheets[st.sheet].name } : {})); });
    ctx.on('click', '[data-fe-save]', () => save(ctx));
    ctx.on('click', '[data-fe-saveas]', () => { if (st.demo) { ctx.toast('This is a sample document; open a file from Files to save.', 'warn'); return; } saveAs(ctx); });
    ctx.on('click', '[data-fe-notes]', () => { st.notesOpen = false; rerender(ctx); });
    ctx.on('click', '[data-fe-reloadinline]', () => { if (st.demo) { st.conflict = null; rerender(ctx); return; } st.dirty = false; st.conflict = null; st.waits = 0; load(ctx); });
    ctx.on('click', '[data-fe-copyinline]', () => { if (st.demo) { ctx.toast('This is a sample document; open a file from Files to save.', 'warn'); return; } saveAs(ctx, { conflict: true }); });
    ctx.on('keydown', '.fe-page', (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); if (editable) save(ctx); } });
    ctx.on('click', '[data-fe-tab]', async (e, t) => {
      const want = t.dataset.feTab; if (want === st.tab) return;
      try {
        if (want === 'source') { capture(ctx); if (st.demo) st.text = '# Sample\n\nThe source of a sample document is not converted.'; else st.text = (await App.post('/api/files/document-convert', { kind: 'markdown', doc: st.doc || { blocks: [] } })).text; }
        else if (!st.demo) st.doc = (await App.post('/api/files/document-convert', { kind: 'markdown', text: st.text || '' })).doc;
        st.tab = want; ctx.rerender();
      } catch (err) { App.fail(err, 'Could not convert the Markdown'); }
    });
    const src = ctx.$('[data-fe-src]') || ctx.$('[data-fe-text]');
    if (src) src.addEventListener('input', () => { st.text = src.value; if (!st.dirty) { st.dirty = true; const x = ctx.$('[data-fe-dirty]'); if (x) x.hidden = false; } });
    const rich = ctx.$('[data-fe-rich]');
    if (rich) wireRich(ctx, rich, editable);
    if (isSheet(d.kind) && st.workbook) {
      wireGrid(ctx, editable);
      ctx.on('click', '[data-fe-sheet]', (e, t) => { st.sheet = +t.dataset.feSheet; st.sel = { r: 0, c: 0 }; st.rowsShown = ROW_PAGE; st.invalid = {}; ctx.rerender(); const tab = ctx.$('[data-fe-sheet="' + st.sheet + '"]'); if (tab) tab.focus(); });
      ctx.on('keydown', '[data-fe-sheet]', (e, t) => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); e.stopPropagation(); const n = st.workbook.sheets.length; st.sheet = (+t.dataset.feSheet + (e.key === 'ArrowRight' ? 1 : -1) + n) % n; st.sel = { r: 0, c: 0 }; st.invalid = {}; ctx.rerender(); const tab = ctx.$('[data-fe-sheet="' + st.sheet + '"]'); if (tab) tab.focus(); });
      if (editable) {
        const markDirty = () => { st.dirty = true; };
        ctx.on('click', '[data-fe-addsheet]', () => {
          const taken = st.workbook.sheets.map((s) => s.name.toLowerCase()); let n = st.workbook.sheets.length + 1; while (taken.indexOf(('Sheet' + n).toLowerCase()) >= 0) n++;
          st.workbook.sheets.push({ name: 'Sheet' + n, header: false, columns: [{ name: 'A', type: 'text' }], rows: [[{ v: null }]] });
          st.sheet = st.workbook.sheets.length - 1; st.sel = { r: 0, c: 0 }; markDirty(); ctx.rerender();
        });
        ctx.on('click', '[data-fe-renamesheet]', () => {
          const s = currentSheet(st);
          ctx.modal({ title: 'Rename sheet ' + esc(s.name), body: UI.field('Name', UI.input(s.name, { attrs: 'data-fe-sname maxlength="31"' }), 'Up to 31 characters, without : \\ / ? * [ or ]; unique in the workbook.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Rename', { kind: 'primary', attrs: 'data-fe-snok' }), onMount(m) {
            m.querySelector('[data-fe-snok]').addEventListener('click', () => {
              const name = m.querySelector('[data-fe-sname]').value.trim();
              if (!name || name.length > 31 || /[:\\/?*[\]]/.test(name)) { ctx.toast('Sheet names are 1 to 31 characters without : \\ / ? * [ or ].', 'danger'); return; }
              if (st.workbook.sheets.some((x, i) => i !== st.sheet && x.name.toLowerCase() === name.toLowerCase())) { ctx.toast('Another sheet already has that name.', 'danger'); return; }
              s.name = name; markDirty(); App.closeOverlay(); rerender(ctx);
            });
          } });
        });
        ctx.on('click', '[data-fe-delsheet]', async () => {
          const s = currentSheet(st); if (st.workbook.sheets.length < 2) return;
          const ok = await ctx.confirm({ title: 'Delete sheet ' + esc(s.name), tone: 'danger', body: '<p class="fg2" style="margin:0">The sheet and its ' + plural(nrows(s), 'row') + ' go when you save. Formulas on other sheets that point at it are not rewritten.</p>', ok: 'Delete sheet' });
          if (!ok) return; st.workbook.sheets.splice(st.sheet, 1); st.sheet = Math.max(0, st.sheet - 1); st.sel = { r: 0, c: 0 }; st.invalid = {}; markDirty(); ctx.rerender();
        });
      }
    }
  }

  // ---------- states (sample documents, no server needed) ----------
  function demo(ctx, kind, extra) {
    const st = ctx.state;
    reset(st, null);
    st.demo = true; st.loaded = true; st.demoParam = App.state.params.file || null;
    const file = { id: null, name: kind === 'csv' ? 'vendors.csv' : 'plan.md', label: 'internal', folderId: null };
    st.data = { file, kind, version: 3, editable: true, notes: [] };
    if (kind === 'csv') { st.workbook = clone(SAMPLE_WB); st.workbook.sheets.forEach(ensureColumns); st.delimiter = ','; }
    else { st.doc = clone(SAMPLE_DOC); st.text = null; }
    Object.assign(st, extra || {});
    ctx.rerender();
  }

  App.register({
    id: ID, title: 'Edit file', live: true,
    summary: 'Markdown, text, CSV, Excel and OpenDocument files edited in place and saved as new versions',
    crumb: (st) => ['Files', (st.data && st.data.file && st.data.file.name) || 'Edit file'],
    label: (st) => (st.data && st.data.file ? st.data.file.label : null),
    states: [
      { title: 'Scan running', tone: 'info', text: 'The file has no version that passed its scan yet (409). The editor waits and opens it as soon as the scan finishes.',
        apply(ctx) { const st = ctx.state; reset(st, null); st.demo = true; st.demoParam = App.state.params.file || null; st.loaded = true; st.waiting = true; st.demoName = 'notes.md'; ctx.rerender(); } },
      { title: 'Newer version saved meanwhile', tone: 'warn', text: 'Saving on an old base version is refused (409). Reload to see the newer version, or save your changes as a copy.',
        apply(ctx) { demo(ctx, 'markdown', { dirty: true, conflict: { latest: 4 } }); } },
      { title: 'Not editable here', tone: 'neutral', text: 'PDF, Word, images and other types are not edited here (415); they can be downloaded.',
        apply(ctx) { const st = ctx.state; reset(st, null); st.demo = true; st.demoParam = App.state.params.file || null; st.loaded = true; st.unsupported = { message: 'Files of type application/pdf are not edited here.', file: { name: 'contract.pdf', label: 'confidential', type: 'application/pdf' } }; ctx.rerender(); } },
      { title: 'Normalise report', tone: 'ok', text: 'After Format and normalise: the counts of what changed, and the invalid cells outlined in the grid.',
        apply(ctx) { demo(ctx, 'csv', { lastReport: SAMPLE_REPORT, invalid: { '2:1': 'Not a number', '2:2': 'Not a date' }, dirty: true }); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const wanted = ctx.params.file || null;
      if (wanted && wanted !== st.fileId && !(st.demo && st.demoParam === wanted)) { reset(st, wanted); }
      else if (!st.fileId && !st.demo && !st.data) reset(st, null);
      // Entering the screen again reloads the document, unless it has edits that are not saved yet.
      if (st.fileId && !st.demo && !st.loading && !st.loaded && (!st.data || !st.dirty)) { st.waits = 0; load(ctx); }
      st.redraw = false;

      const shell = (inner) => STYLE + '<div class="page fe-page">' + inner + '</div>';
      const back = UI.btn('Back to Files', { kind: 'ghost', attrs: 'data-fe-back' });
      const backOnly = () => ctx.on('click', '[data-fe-back]', () => ctx.navigate('files', st.fileId ? { file: st.fileId } : undefined));

      if (!st.fileId && !st.demo) {
        root.innerHTML = shell(UI.pagehead('Edit file', 'Markdown, text, CSV, Excel and OpenDocument files open here from Files.', '') + UI.empty('Open a document from Files', 'Select a Markdown, text, CSV, Excel or OpenDocument file in Files and choose Open, or create a new document there.', UI.btn('Go to Files', { kind: 'primary', attrs: 'data-fe-gofiles' })));
        ctx.on('click', '[data-fe-gofiles]', () => ctx.navigate('files'));
        return;
      }
      if (st.unsupported) {
        const f = st.unsupported.file || {};
        root.innerHTML = shell(UI.pagehead(f.name || 'File', f.label ? UI.label(f.label, { sm: true }) : '', back) + UI.notice('<b>This type is not edited here.</b> ' + esc(st.unsupported.message || '') + ' Markdown, text, CSV, Excel (.xlsx, and .xls saved as .xlsx) and OpenDocument (.odt, .ods) files are.', 'info', st.demo ? '' : '<a class="btn sm" href="/api/files/' + esc(enc(st.fileId)) + '/content" download>Download</a>'));
        backOnly();
        return;
      }
      if (st.error) {
        root.innerHTML = shell(UI.pagehead('Edit file', '', back) + UI.problem(st.error.status === 404 ? 'File not found' : 'The document could not be opened', st.error.message, st.error.problem && st.error.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-fe-retry' }) + '</div>');
        backOnly();
        ctx.on('click', '[data-fe-retry]', () => { st.error = null; st.loaded = false; st.waits = 0; ctx.rerender(); });
        return;
      }
      if (st.waiting && !st.data) {
        root.innerHTML = shell(UI.pagehead(st.demoName || 'Edit file', '', back) + UI.notice(st.waitGaveUp ? '<b>The scan is taking a while.</b> The file has no version that passed its scan yet. Try again in a minute.' : '<b>The scan is running.</b> The file has no version that passed its scan yet (409); it opens here as soon as the scan finishes.', st.waitGaveUp ? 'warn' : 'info', st.waitGaveUp ? UI.btn('Try again', { size: 'sm', attrs: 'data-fe-retry' }) : ''));
        backOnly();
        ctx.on('click', '[data-fe-retry]', () => { st.waitGaveUp = false; st.waits = 0; load(ctx); });
        return;
      }
      if (!st.data) { root.innerHTML = shell(UI.pagehead('Edit file', '', back) + UI.notice('Loading…', 'info')); backOnly(); return; }

      root.innerHTML = shell(headerHtml(st) + bodyHtml(st));
      wirePage(ctx);
    }
  });
})();
