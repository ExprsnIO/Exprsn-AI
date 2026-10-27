// Workflows, Sprint 46 (Automation): decision tables (B-131, /api/decision-tables) and the designer's Switch (B-132)
// and Decision steps. `workflows.js` shows the Decision tables view with App.wfDecisions(root, ctx, deps) when its
// state's `view` is "decisions" (#/workflows?view=decisions), and asks App.wfSteps for the inspector of a switch or
// decision step (App.wfSteps.fields[kind](n, st, ro)), the text under a node (App.wfSteps.sub), the case of a new
// switch edge (App.wfSteps.nextCase) and the handlers (App.wfSteps.bind(ctx, deps), once per render). The view's state
// lives in ctx.state.dec; deps.later() re-renders when a fetch lands.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const TYPES = ['string', 'number', 'boolean', 'date'];
  const POLICIES = [{ value: 'first', label: 'First: the first rule that matches' }, { value: 'unique', label: 'Unique: at most one rule may match' }, { value: 'priority', label: 'Priority: by the order of output values' }, { value: 'any', label: 'Any: matching rules must agree' }, { value: 'collect', label: 'Collect: every matching rule' }];
  const AGGS = [{ value: '', label: 'a list of every result' }, { value: 'sum', label: 'sum' }, { value: 'min', label: 'min' }, { value: 'max', label: 'max' }, { value: 'count', label: 'count of matches' }];
  const CSS = '.dec-grid td{padding:2px 4px;vertical-align:middle}.dec-grid th{white-space:nowrap}.dec-grid input.input{min-width:110px;height:28px;font-family:var(--mono);font-size:12px}.dec-grid td.dec-n{font-size:12px;color:var(--muted);white-space:nowrap}.dec-grid tr[data-dec-state="bad"] td{background:var(--danger-bg)}.dec-grid tr[data-dec-state="warn"] td{background:var(--warn-bg)}.dec-grid th.dec-out{border-left:2px solid var(--line2)}.dec-grid td.dec-out{border-left:2px solid var(--line2)}.dec-sub{font-size:12px;color:var(--muted)}.dec-cols .input,.dec-cols .select{height:28px}.dec-help{font-size:12px;color:var(--muted);overflow-wrap:anywhere}';

  // ---------- cells as text (the server parses them: decisions/table.ts parseCell) ----------
  const lit = (v) => (v === null || v === undefined ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v));
  const SYM = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' };
  function cellText(t) {
    if (!t) return '-';
    switch (t.op) {
      case 'any': return '-';
      case 'empty': return 'is empty';
      case 'eq': return lit(t.value);
      case 'between': return '[' + lit(t.min) + '..' + lit(t.max) + ']';
      case 'in': return 'in (' + t.values.map(lit).join(', ') + ')';
      case 'not_in': return 'not in (' + t.values.map(lit).join(', ') + ')';
      case 'contains': return 'contains ' + lit(t.value);
      case 'starts_with': return 'starts with ' + lit(t.value);
      default: return SYM[t.op] + ' ' + lit(t.value);
    }
  }
  const outText = (v) => (v === null || v === undefined ? '' : String(v));
  function outValue(text, type) {
    const s = String(text == null ? '' : text).trim();
    if (s === '' || s === 'null') return null;
    if (type === 'number' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (type === 'boolean' && (s === 'true' || s === 'false')) return s === 'true';
    return s.replace(/^"(.*)"$/, '$1');
  }
  const listText = (vs) => (vs || []).map(String).join(', ');
  const listOf = (text, type) => String(text || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => outValue(x, type));

  /** The server's definition as the editor holds it: cells as text. */
  function toLocal(d) {
    return {
      inputs: d.inputs.map((c) => Object.assign({}, c)),
      outputs: d.outputs.map((c) => Object.assign({}, c, c.values ? { values: c.values.slice() } : {})),
      hitPolicy: d.hitPolicy || 'first',
      aggregation: d.aggregation || '',
      rules: d.rules.map((r) => ({ id: r.id, note: r.note || '', when: Object.fromEntries(d.inputs.map((c) => [c.name, cellText(r.when[c.name])])), then: Object.fromEntries(d.outputs.map((c) => [c.name, outText(r.then[c.name])])) }))
    };
  }
  /** The editor's definition as the API takes it (text cells; outputs typed by their column). */
  function toApi(l) {
    return {
      inputs: l.inputs.map((c) => ({ name: c.name, type: c.type })),
      outputs: l.outputs.map((c) => Object.assign({ name: c.name, type: c.type }, c.values && c.values.length ? { values: c.values } : {}, c.default !== undefined && c.default !== null ? { default: c.default } : {})),
      hitPolicy: l.hitPolicy,
      aggregation: l.hitPolicy === 'collect' && l.aggregation ? l.aggregation : null,
      rules: l.rules.map((r) => Object.assign({ when: Object.fromEntries(l.inputs.map((c) => [c.name, r.when[c.name] || '-']).filter((x) => x[1] !== '-' && x[1] !== '')), then: Object.fromEntries(l.outputs.map((c) => [c.name, outValue(r.then[c.name], c.type)])) }, r.id ? { id: r.id } : {}, r.note ? { note: r.note } : {}))
    };
  }
  const freshName = (list, base) => { let i = 1; while (list.some((c) => c.name === base + i)) i++; return base + i; };

  // ---------- the Decision tables view ----------
  function state(ctx) { const st = ctx.state; st.dec = st.dec || { tab: 'rules' }; return st.dec; }

  function loadList(ctx, deps) {
    const d = state(ctx); d.listLoading = true;
    App.get('/api/decision-tables').then((list) => { d.list = list; d.listError = null; }).catch((err) => { d.listError = err; }).finally(() => { d.listLoading = false; deps.later(); });
  }
  function loadTable(ctx, deps, id) {
    const d = state(ctx); d.loading = id;
    return App.get('/api/decision-tables/' + enc(id)).then((t) => { if (d.selId !== id) return; d.table = t; d.local = toLocal(t.draft); d.dirty = false; d.check = t.check; d.problem = null; d.result = null; d.error = null; })
      .catch((err) => { d.error = err; }).finally(() => { d.loading = null; deps.later(); });
  }
  function checkSoon(ctx, deps) {
    const d = state(ctx); clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      if (!d.table) return; const id = d.table.id; const local = d.local;
      App.post('/api/decision-tables/' + enc(id) + '/check', { definition: toApi(local) }).then((c) => { if (d.local === local) { d.check = c; d.parse = null; deps.later(); } })
        .catch((err) => { if (d.local === local) { d.parse = (err.problem && err.problem.detail) || err.message; deps.later(); } });
    }, 400);
  }

  App.wfDecisions = function (root, ctx, deps) {
    const d = state(ctx);
    const manage = App.can('workflows:manage');
    const toast = (html, kind) => ctx.toast('<span>' + html + '</span>', kind || '', 6000);
    if (ctx.params.table) { d.selId = ctx.params.table; d.table = null; delete ctx.params.table; }
    if (!d.list && !d.listLoading && !d.listError) loadList(ctx, deps);
    const list = d.list || [];
    if (d.list && (!d.selId || !list.some((t) => t.id === d.selId || t.name === d.selId))) { d.selId = list[0] ? list[0].id : null; d.table = null; }
    const sel = list.find((t) => t.id === d.selId || t.name === d.selId);
    if (sel && d.selId !== sel.id) d.selId = sel.id;
    if (sel && (!d.table || d.table.id !== sel.id) && d.loading !== sel.id && !d.error) loadTable(ctx, deps, sel.id);
    const t = d.table && sel && d.table.id === sel.id ? d.table : null;
    const L = t ? d.local : null;
    const ro = manage ? '' : ' disabled';

    const back = UI.btn('Back to workflows', { size: 'sm', kind: 'ghost', attrs: 'data-dec-back' });
    const left = '<div class="leftpane w260" aria-label="Decision tables"><div class="hstack"><div class="eyebrow grow">Decision tables</div>' + (manage ? UI.iconbtn('plus', 'New decision table', { cls: 'sm ghost', attrs: 'data-dec-new' }) : '') + '</div>'
      + (d.listError ? UI.problem('The tables could not be loaded', d.listError.message, false) : !d.list ? UI.notice('Loading…', 'info') : list.length ? '<div class="vstack gap4">' + list.map((x) => UI.listItem(esc(x.title || x.name), esc(x.name) + ' · ' + esc(x.hitPolicy) + ' · ' + x.rules + ' rule' + (x.rules === 1 ? '' : 's') + ' · ' + (x.publishedVersion ? 'v' + x.publishedVersion : 'draft'), { active: sel && x.id === sel.id, attrs: 'data-dec-sel="' + esc(x.id) + '"', right: UI.label(x.label, { sm: true }) })).join('') + '</div>' : '<div class="muted" style="font-size:12px">No decision tables yet.</div>')
      + (manage ? '<div class="hstack wrap gap6" style="margin-top:auto">' + UI.btn('New table', { size: 'sm', icon: 'plus', attrs: 'data-dec-new' }) + UI.btn('Import', { size: 'sm', icon: 'upload', attrs: 'data-dec-import' }) + '</div>' : '') + '</div>';

    let body;
    if (!d.list) body = UI.notice('Loading…', 'info');
    else if (!sel) body = UI.empty('No decision tables', manage ? 'A decision table decides values from inputs by rules, with a hit policy. Workflow Decision steps, app flows and the decision.evaluate tool use its published versions.' : 'A workflow admin creates and publishes them.', manage ? UI.btn('New table', { kind: 'primary', icon: 'plus', attrs: 'data-dec-new' }) : '');
    else if (d.error) body = UI.problem('The table could not be loaded', d.error.message, (d.error.problem && d.error.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-dec-retry' }) + '</div>';
    else if (!t) body = UI.notice('Loading the table…', 'info');
    else {
      const chk = d.check || { ok: true, errors: [], warnings: [] };
      const ids = (chk.definition ? chk.definition.rules : t.draft.rules).map((r) => r.id);
      const ruleIssues = (i) => chk.errors.filter((e) => e.rule && ids.indexOf(e.rule) === i).concat(chk.warnings.filter((w) => w.rule && ids.indexOf(w.rule) === i).map((w) => Object.assign({ warning: true }, w)));
      const published = t.publishedVersion && !t.dirty && !d.dirty;
      const tab = d.tab || 'rules';
      const head = '<div class="hstack wrap gap6"><h2 class="serif" style="margin:0;font-size:20px;overflow-wrap:anywhere">' + esc(t.title || t.name) + '</h2>' + UI.label(t.label, { sm: true }) + UI.pill(published ? 'v' + t.publishedVersion + ' published' : t.publishedVersion ? 'v' + t.publishedVersion + ' published, draft changed' : 'draft', published ? 'ok' : '') + (d.dirty ? UI.pill('unsaved changes', 'warn') : '') + '</div>'
        + '<div class="dec-sub mono">' + esc(t.name) + (t.description ? ' · ' + esc(t.description) : '') + '</div>';
      const policy = '<div class="formgrid">' + UI.field('Hit policy', UI.select(POLICIES, L.hitPolicy, 'data-dec-policy' + ro)) + (L.hitPolicy === 'collect' ? UI.field('Collect as', UI.select(AGGS, L.aggregation || '', 'data-dec-agg' + ro), 'With an aggregation the table has one output column') : '') + '</div>';
      const issues = (d.parse ? UI.notice('<b>A cell cannot be read.</b> ' + esc(d.parse), 'danger') : '')
        + (chk.errors.length ? UI.notice('<b>' + chk.errors.length + ' problem' + (chk.errors.length === 1 ? '' : 's') + ' to fix before publishing.</b><ul style="margin:4px 0 0 18px;padding:0">' + chk.errors.slice(0, 8).map((e) => '<li>' + esc(e.message) + '</li>').join('') + '</ul>', 'danger') : '')
        + (chk.warnings.length ? UI.notice(chk.warnings.slice(0, 6).map((w) => esc(w.message)).join('<br>'), 'warn') : '')
        + (d.problem ? UI.problem(d.problem.title, d.problem.detail, d.problem.trace || false) : '');
      let content = '';
      if (tab === 'rules') {
        const cols = [{ label: '#', width: '44px' }].concat(L.inputs.map((c) => ({ label: (c.label || c.name) + ' (' + c.type + ')' }))).concat(L.outputs.map((c) => ({ label: '→ ' + (c.label || c.name) + ' (' + c.type + ')' }))).concat([{ label: 'Note' }, { label: '', srLabel: 'Move or remove' }]);
        const rows = L.rules.map((r, i) => {
          const iss = ruleIssues(i); const bad = iss.some((x) => !x.warning); const warn = !bad && iss.length;
          const cells = ['<span title="' + esc(iss.map((x) => x.message).join(' ')) + '">' + (i + 1) + (r.id ? ' <span class="mono">' + esc(r.id) + '</span>' : '') + '</span>']
            .concat(L.inputs.map((c, j) => UI.input(r.when[c.name] || '-', { attrs: 'data-dec-cell="' + i + ',' + j + '" data-dec-in="' + esc(c.name) + '" aria-label="Rule ' + (i + 1) + ', ' + esc(c.name) + ' test"' + ro })))
            .concat(L.outputs.map((c, j) => UI.input(r.then[c.name] == null ? '' : r.then[c.name], { attrs: 'data-dec-cell="' + i + ',' + (L.inputs.length + j) + '" data-dec-out="' + esc(c.name) + '" aria-label="Rule ' + (i + 1) + ', ' + esc(c.name) + ' output"' + ro })))
            .concat([UI.input(r.note || '', { attrs: 'data-dec-cell="' + i + ',' + (L.inputs.length + L.outputs.length) + '" data-dec-note aria-label="Rule ' + (i + 1) + ' note"' + ro }), manage ? '<span class="hstack gap4">' + UI.btn('Up', { size: 'xs', kind: 'ghost', attrs: 'data-dec-rup="' + i + '" aria-label="Move rule ' + (i + 1) + ' up"', disabled: i === 0 }) + UI.btn('Down', { size: 'xs', kind: 'ghost', attrs: 'data-dec-rdown="' + i + '" aria-label="Move rule ' + (i + 1) + ' down"', disabled: i === L.rules.length - 1 }) + UI.iconbtn('trash', 'Remove rule ' + (i + 1), { cls: 'sm ghost', attrs: 'data-dec-rdel="' + i + '"' }) + '</span>' : '']);
          return { cells, attrs: bad ? 'data-dec-state="bad"' : warn ? 'data-dec-state="warn"' : '' };
        });
        content = UI.table(cols, rows, { clickable: false, cls: 'dec-grid', attrs: 'data-scroll-x role="region" aria-label="Rules of ' + esc(t.name) + '"', minWidth: '640px', emptyTitle: 'No rules yet', emptyText: 'Add a rule: a test for each input (- matches anything) and a value for each output.' })
          + (manage ? '<div class="hstack wrap gap6">' + UI.btn('Add rule', { size: 'sm', icon: 'plus', attrs: 'data-dec-radd' }) + UI.btn('Add input column', { size: 'sm', attrs: 'data-dec-cadd="in"' }) + UI.btn('Add output column', { size: 'sm', attrs: 'data-dec-cadd="out"' }) + '</div>' : '')
          + '<div class="dec-help">Tests: <span class="mono">-</span> (anything), <span class="mono">"gold"</span> or <span class="mono">= 5</span>, <span class="mono">≠ 5</span>, <span class="mono">&lt; 5</span>, <span class="mono">≤ 5</span>, <span class="mono">&gt; 5</span>, <span class="mono">≥ 5</span>, <span class="mono">[1..5]</span> (between, inclusive), <span class="mono">in ("EU", "UK")</span>, <span class="mono">not in (…)</span>, <span class="mono">contains "x"</span>, <span class="mono">starts with "x"</span>, <span class="mono">is empty</span>. Dates are written 2026-01-31. Arrow keys move between cells; Enter moves down. An empty input matches only - and is empty.</div>';
      } else if (tab === 'columns') {
        const colRow = (c, i, kind, n) => '<div class="hstack wrap gap6 dec-cols" style="align-items:flex-end;border-bottom:1px solid var(--line);padding:6px 0">'
          + UI.field(kind === 'in' ? 'Input ' + (i + 1) : 'Output ' + (i + 1), UI.input(c.name, { attrs: 'data-dec-cname="' + kind + ',' + i + '"' + ro }))
          + UI.field('Type', UI.select(TYPES, c.type, 'data-dec-ctype="' + kind + ',' + i + '"' + ro))
          + (kind === 'out' ? UI.field('Values, highest priority first', UI.input(listText(c.values), { placeholder: 'optional, comma-separated', attrs: 'data-dec-cvals="' + i + '"' + ro })) + UI.field('Default when nothing matches', UI.input(c.default == null ? '' : String(c.default), { placeholder: 'none', attrs: 'data-dec-cdef="' + i + '"' + ro })) : '')
          + (manage ? '<span class="hstack gap4">' + UI.btn('Earlier', { size: 'xs', kind: 'ghost', attrs: 'data-dec-cmove="' + kind + ',' + i + ',-1" aria-label="Move ' + esc(c.name) + ' earlier"', disabled: i === 0 }) + UI.btn('Later', { size: 'xs', kind: 'ghost', attrs: 'data-dec-cmove="' + kind + ',' + i + ',1" aria-label="Move ' + esc(c.name) + ' later"', disabled: i === n - 1 }) + UI.iconbtn('trash', 'Remove column ' + c.name, { cls: 'sm ghost', attrs: 'data-dec-cdel="' + kind + ',' + i + '"' }) + '</span>' : '') + '</div>';
        content = UI.panel('Input columns', L.inputs.map((c, i) => colRow(c, i, 'in', L.inputs.length)).join('') || '<div class="muted" style="font-size:12px">No inputs: every rule matches every input.</div>', { actions: manage ? UI.btn('Add input column', { size: 'xs', attrs: 'data-dec-cadd="in"' }) : '' })
          + UI.panel('Output columns', L.outputs.map((c, i) => colRow(c, i, 'out', L.outputs.length)).join(''), { actions: manage ? UI.btn('Add output column', { size: 'xs', attrs: 'data-dec-cadd="out"' }) : '' })
          + '<div class="dec-help">Renaming a column keeps its cells. A workflow Decision step maps run fields to the input columns and the output columns into the run; the priority hit policy ranks the matching rules by the order of the values listed here.</div>';
      } else if (tab === 'test') {
        const vopts = [{ value: 'draft', label: 'the saved draft' }].concat(t.publishedVersion ? [{ value: 'published', label: 'the published version (v' + t.publishedVersion + ')' }] : []).concat(t.versions.map((v) => ({ value: String(v.version), label: 'v' + v.version + (v.state === 'published' ? ' (published)' : '') })));
        const vals = d.testInputs || {};
        const r = d.result;
        content = '<div class="formgrid">' + L.inputs.map((c) => UI.field(esc(c.label || c.name) + ' <span class="muted">(' + c.type + ')</span>', c.type === 'boolean' ? UI.select([{ value: '', label: 'empty' }, 'true', 'false'], vals[c.name] == null ? '' : String(vals[c.name]), 'data-dec-tin="' + esc(c.name) + '"') : UI.input(vals[c.name] == null ? '' : String(vals[c.name]), { type: c.type === 'date' ? 'date' : c.type === 'number' ? 'number' : 'text', attrs: 'data-dec-tin="' + esc(c.name) + '"', placeholder: 'empty' }))).join('') + UI.field('Evaluate', UI.select(vopts, d.testVersion || 'draft', 'data-dec-tver')) + '</div>'
          + '<div class="hstack wrap gap6">' + UI.btn('Evaluate', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-dec-test' }) + (d.dirty && (d.testVersion || 'draft') === 'draft' ? '<span class="dec-sub">Your unsaved changes are saved first.</span>' : '') + '</div>'
          + (d.testError ? UI.notice('<b>' + esc(d.testError.title) + '.</b> ' + esc(d.testError.detail), 'danger') : '')
          + (r ? UI.panel('Result', UI.notice(esc(r.summary), r.matched.length ? 'ok' : 'info')
              + UI.kv([['Hit policy', esc(r.hitPolicy) + (r.aggregation ? ', ' + esc(r.aggregation) : '')], ['Evaluated', r.version ? 'v' + esc(r.version) : 'the draft'], ['Matched', r.matched.length ? r.matched.map((m) => '<span class="mono">' + esc(m.rule) + '</span>').join(', ') : 'nothing']].concat(Object.keys(r.outputs || {}).map((k) => [esc(k), '<span class="mono">' + esc(JSON.stringify(r.outputs[k])) + '</span>'])), 2)
              + UI.table(['Rule', 'Matched', 'Why'], r.explanation.map((x) => ['<span class="mono">' + esc(x.rule) + '</span>', UI.pill(x.matched ? 'matched' : 'no', x.matched ? 'ok' : 'outline'), x.tests.length ? x.tests.map((y) => esc(y.column) + ' ' + esc(JSON.stringify(y.value)) + ' ' + esc(y.test) + (y.passed ? '' : ' (fails)')).join('; ') : 'tests nothing']), { clickable: false, attrs: 'aria-label="Explanation"' }), {}) : '');
      } else {
        content = UI.table(['Version', 'State', 'Rules', 'Note', 'Published', ''], [['draft', UI.pill(d.dirty ? 'unsaved' : 'draft', d.dirty ? 'warn' : ''), String(L.rules.length), 'revision ' + esc(t.draftRev), esc(when(t.updatedAt)), '']].concat(t.versions.map((v) => ['v' + v.version, UI.pill(v.state, v.state === 'published' ? 'ok' : 'warn'), String(v.rules), esc(v.note || ''), esc(when(v.publishedAt)), '<span class="hstack gap4">' + UI.btn('Test', { size: 'xs', kind: 'ghost', attrs: 'data-dec-vtest="' + v.version + '"' }) + (manage ? UI.btn('Export', { size: 'xs', kind: 'ghost', attrs: 'data-dec-export="' + v.version + '"' }) : '') + '</span>'])), { clickable: false, minWidth: '560px' })
          + UI.notice('Publishing checks the draft and makes it the next version. Workflow Decision steps without a pinned version use the latest published one when a run reaches them; a pinned step keeps its version.', 'info')
          + (manage ? '<div class="hstack wrap gap6">' + UI.btn('Used by', { size: 'sm', attrs: 'data-dec-used' }) + UI.btn('Delete table', { size: 'sm', kind: 'danger', attrs: 'data-dec-del' }) + '</div>' : '');
      }
      body = head + policy
        + '<div class="hstack wrap gap6">' + (manage ? UI.btn('Save draft', { size: 'sm', attrs: 'data-dec-save', disabled: !d.dirty }) + UI.btn(published ? 'Published' : 'Publish', { size: 'sm', kind: 'primary', attrs: 'data-dec-publish', disabled: !!published }) + UI.btn('Export', { size: 'sm', icon: 'download', attrs: 'data-dec-export="' + (t.publishedVersion || 'draft') + '"' }) : '') + '<span class="dec-sub">' + L.inputs.length + ' input' + (L.inputs.length === 1 ? '' : 's') + ', ' + L.outputs.length + ' output' + (L.outputs.length === 1 ? '' : 's') + ', ' + L.rules.length + ' rule' + (L.rules.length === 1 ? '' : 's') + (chk.errors.length ? ', <span style="color:var(--danger-fg)">' + chk.errors.length + ' problem' + (chk.errors.length === 1 ? '' : 's') + '</span>' : ', valid') + '</span></div>'
        + issues
        + UI.tabs([{ id: 'rules', label: 'Rules', count: L.rules.length }, { id: 'columns', label: 'Columns' }, { id: 'test', label: 'Test' }, { id: 'versions', label: 'Versions', count: t.versions.length }], tab, 'aria-label="Decision table"')
        + '<div class="vstack gap6">' + content + '</div>';
    }

    root.innerHTML = '<style>' + CSS + '</style>' + left + '<div class="page">' + UI.pagehead('Decision tables', 'Rules that decide values from inputs, versioned and tested; used by workflow Decision steps, app flows and the decision.evaluate tool', back) + body + '</div>';

    // ---------- handlers ----------
    const changed = (rerender) => { d.dirty = true; d.problem = null; checkSoon(ctx, deps); if (rerender) ctx.rerender(); else ctx.$$('[data-dec-save]').forEach((b) => { b.disabled = false; }); };
    ctx.on('click', '[data-dec-back]', () => deps.back());
    ctx.on('click', '[data-dec-sel]', async (e, el) => {
      if (d.dirty && !(await ctx.confirm({ title: 'Discard unsaved changes', tag: 'draft', tone: 'warn', body: '<p class="fg2" style="margin:0">The changes to this table are not saved. Open the other table anyway?</p>', ok: 'Discard and open' }))) return;
      d.selId = el.dataset.decSel; d.table = null; d.dirty = false; d.result = null; d.testError = null; d.check = null; d.parse = null; ctx.rerender();
    });
    ctx.on('click', '[data-dec-retry]', () => { d.error = null; ctx.rerender(); });
    ctx.on('click', '[data-tab]', (e, el) => { if (!el.closest('.page')) return; d.tab = el.dataset.tab; ctx.rerender(); });
    ctx.on('click', '[data-dec-new]', () => {
      const mine = LABELS.filter((l) => !App.me || LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance));
      ctx.modal({ title: 'New decision table', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'discounts', attrs: 'data-n' }), 'Lower-case letters, digits, _ . and -; steps name the table by it') + UI.field('Label', UI.select(mine, 'internal', 'data-l'), 'A workflow above it cannot use the table') + '</div>' + UI.field('Title', UI.input('', { placeholder: 'Order discounts', attrs: 'data-t' })) + UI.field('Description', UI.textarea('', { rows: 2, attrs: 'data-desc' })) + '<div class="dec-sub">It starts with one number input, one text output and the first hit policy. Edit the columns and rules, test it and publish.</div><div data-err></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-go' }),
        onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            try {
              const v = await App.post('/api/decision-tables', { name: m.querySelector('[data-n]').value.trim(), label: m.querySelector('[data-l]').value, title: m.querySelector('[data-t]').value.trim() || null, description: m.querySelector('[data-desc]').value.trim() || null, definition: { inputs: [{ name: 'amount', type: 'number' }], outputs: [{ name: 'result', type: 'string' }], hitPolicy: 'first', rules: [{ when: { amount: '>= 1000' }, then: { result: 'review' } }, { when: {}, then: { result: 'approve' } }] } });
              App.closeOverlay(); d.list = null; d.selId = v.id; d.table = null; d.tab = 'rules'; ctx.rerender();
              toast(esc(v.name) + ' created as a draft with two rules. Edit the rules, test and publish.', 'ok');
            } catch (err) { m.querySelector('[data-err]').innerHTML = UI.notice(esc((err.problem && err.problem.detail) || err.message), 'danger'); }
          });
        } });
    });
    ctx.on('click', '[data-dec-import]', () => {
      ctx.modal({ title: 'Import a decision table', body: UI.field('Export (exprsn-decision/1)', UI.textarea('', { rows: 7, placeholder: '{ "format": "exprsn-decision/1", … }', attrs: 'data-ib' })) + '<div class="hstack wrap gap6">' + UI.btn('Read a file', { size: 'sm', icon: 'upload', attrs: 'data-ibfile' }) + '<input type="file" accept="application/json,.json" data-ibinput hidden aria-label="Export file"></div>' + UI.field('Name', UI.input('', { placeholder: 'the export\'s name', attrs: 'data-ibname' }), 'A name in use is refused') + UI.notice('The table arrives as a draft, never published; its cells are read and checked like an edit.', 'info') + '<div data-err></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Import', { kind: 'primary', attrs: 'data-go' }),
        onMount(m) {
          const fileIn = m.querySelector('[data-ibinput]');
          m.querySelector('[data-ibfile]').addEventListener('click', () => fileIn.click());
          fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; if (f) f.text().then((txt) => { m.querySelector('[data-ib]').value = txt; }); });
          m.querySelector('[data-go]').addEventListener('click', async () => {
            let doc; try { doc = JSON.parse(m.querySelector('[data-ib]').value); } catch (x) { m.querySelector('[data-err]').innerHTML = UI.notice('The export is not JSON.', 'danger'); return; }
            const body = { export: doc }; const name = m.querySelector('[data-ibname]').value.trim(); if (name) body.name = name;
            try { const v = await App.post('/api/decision-tables/import', body); App.closeOverlay(); d.list = null; d.selId = v.id; d.table = null; ctx.rerender(); toast(esc(v.name) + ' imported as a draft.', 'ok'); }
            catch (err) { m.querySelector('[data-err]').innerHTML = UI.notice(esc((err.problem && err.problem.detail) || err.message), 'danger'); }
          });
        } });
    });
    if (!t) return;
    const save = async (quiet) => {
      if (!d.dirty) return true;
      try {
        const v = await App.put('/api/decision-tables/' + enc(t.id) + '/draft', { definition: toApi(d.local), rev: t.draftRev });
        d.table = v; d.local = toLocal(v.draft); d.dirty = false; d.check = v.check; d.parse = null; d.problem = null;
        const i = (d.list || []).findIndex((x) => x.id === v.id); if (i >= 0) d.list[i] = Object.assign({}, d.list[i], { rules: v.draft.rules.length, hitPolicy: v.draft.hitPolicy, draftRev: v.draftRev });
        if (!quiet) toast('Draft saved as revision ' + v.draftRev + '. Publish to make it the next version.', 'ok');
        return true;
      } catch (err) { d.problem = { title: (err.problem && err.problem.title) || 'Not saved', detail: (err.problem && err.problem.detail) || err.message, trace: err.problem && err.problem.trace_id }; App.fail(err, 'Could not save the draft'); return false; }
      finally { ctx.rerender(); }
    };
    ctx.on('change', '[data-dec-policy]', (e, el) => { L.hitPolicy = el.value; if (el.value !== 'collect') L.aggregation = ''; changed(true); });
    ctx.on('change', '[data-dec-agg]', (e, el) => { L.aggregation = el.value; changed(true); });
    ctx.on('change', '[data-dec-cell]', (e, el) => {
      const i = Number(el.dataset.decCell.split(',')[0]); const r = L.rules[i]; if (!r) return;
      if (el.hasAttribute('data-dec-in')) r.when[el.dataset.decIn] = el.value.trim() || '-';
      else if (el.hasAttribute('data-dec-out')) r.then[el.dataset.decOut] = el.value;
      else r.note = el.value.trim();
      changed(false);
    });
    // The grid's keyboard: arrows move between cells (left and right at the edge of the text), Enter moves down.
    ctx.on('keydown', '[data-dec-cell]', (e, el) => {
      const [i, j] = el.dataset.decCell.split(',').map(Number);
      const at = (r, c) => ctx.$('[data-dec-cell="' + r + ',' + c + '"]');
      let to = null;
      if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) to = at(i + 1, j);
      else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) to = at(i - 1, j);
      else if (e.key === 'ArrowRight' && el.selectionStart === el.value.length && el.selectionEnd === el.value.length) to = at(i, j + 1);
      else if (e.key === 'ArrowLeft' && el.selectionStart === 0 && el.selectionEnd === 0) to = at(i, j - 1);
      if (!to) return;
      e.preventDefault();
      el.dispatchEvent(new Event('change', { bubbles: true }));
      to.focus(); if (typeof to.select === 'function') to.select();
    });
    ctx.on('click', '[data-dec-radd]', () => { L.rules.push({ id: '', note: '', when: {}, then: Object.fromEntries(L.outputs.map((c) => [c.name, ''])) }); changed(true); const f = ctx.$('[data-dec-cell="' + (L.rules.length - 1) + ',0"]'); if (f) f.focus(); });
    const moveRule = (i, by) => { const j = i + by; if (j < 0 || j >= L.rules.length) return; const x = L.rules[i]; L.rules[i] = L.rules[j]; L.rules[j] = x; changed(true); };
    ctx.on('click', '[data-dec-rup]', (e, el) => moveRule(Number(el.dataset.decRup), -1));
    ctx.on('click', '[data-dec-rdown]', (e, el) => moveRule(Number(el.dataset.decRdown), 1));
    ctx.on('click', '[data-dec-rdel]', async (e, el) => {
      const i = Number(el.dataset.decRdel);
      if (!(await ctx.confirm({ title: 'Remove rule ' + (i + 1), tag: 'edit', tone: 'warn', body: '<p class="fg2" style="margin:0">The rule leaves the draft. Published versions keep it until you publish again.</p>', ok: 'Remove' }))) return;
      L.rules.splice(i, 1); changed(true); toast('Rule ' + (i + 1) + ' removed. Save the draft to keep it.');
    });
    ctx.on('click', '[data-dec-cadd]', (e, el) => {
      const isIn = el.dataset.decCadd === 'in'; const all = L.inputs.concat(L.outputs);
      const c = { name: freshName(all, isIn ? 'input' : 'output'), type: 'string' };
      if (isIn) L.inputs.push(c); else { L.outputs.push(c); L.rules.forEach((r) => { r.then[c.name] = ''; }); }
      changed(true); toast((isIn ? 'Input' : 'Output') + ' column ' + esc(c.name) + ' added. Name and type it under Columns.');
    });
    const colOf = (spec) => { const p = spec.split(','); return { list: p[0] === 'in' ? L.inputs : L.outputs, kind: p[0], i: Number(p[1]), by: Number(p[2] || 0) }; };
    ctx.on('change', '[data-dec-cname]', (e, el) => {
      const x = colOf(el.dataset.decCname); const c = x.list[x.i]; const name = el.value.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) { toast('Column names are letters, digits and _, starting with a letter or _.', 'warn'); el.value = c.name; return; }
      if (L.inputs.concat(L.outputs).some((y) => y !== c && y.name === name)) { toast('Another column is named ' + esc(name) + '.', 'warn'); el.value = c.name; return; }
      L.rules.forEach((r) => { const m = x.kind === 'in' ? r.when : r.then; if (c.name in m) { m[name] = m[c.name]; delete m[c.name]; } });
      c.name = name; changed(true);
    });
    ctx.on('change', '[data-dec-ctype]', (e, el) => { const x = colOf(el.dataset.decCtype); x.list[x.i].type = el.value; changed(true); });
    ctx.on('change', '[data-dec-cvals]', (e, el) => { const c = L.outputs[Number(el.dataset.decCvals)]; const vs = listOf(el.value, c.type); if (vs.length) c.values = vs; else delete c.values; changed(false); });
    ctx.on('change', '[data-dec-cdef]', (e, el) => { const c = L.outputs[Number(el.dataset.decCdef)]; const v = outValue(el.value, c.type); if (v === null) delete c.default; else c.default = v; changed(false); });
    ctx.on('click', '[data-dec-cmove]', (e, el) => { const x = colOf(el.dataset.decCmove); const j = x.i + x.by; if (j < 0 || j >= x.list.length) return; const tmp = x.list[x.i]; x.list[x.i] = x.list[j]; x.list[j] = tmp; changed(true); });
    ctx.on('click', '[data-dec-cdel]', async (e, el) => {
      const x = colOf(el.dataset.decCdel); const c = x.list[x.i];
      if (x.kind === 'out' && L.outputs.length === 1) { toast('A table keeps at least one output column.', 'warn'); return; }
      if (!(await ctx.confirm({ title: 'Remove column ' + c.name, tag: 'edit', tone: 'warn', body: '<p class="fg2" style="margin:0">Its cells in every rule are removed with it.</p>', ok: 'Remove' }))) return;
      x.list.splice(x.i, 1); L.rules.forEach((r) => { delete (x.kind === 'in' ? r.when : r.then)[c.name]; }); changed(true);
    });
    ctx.on('click', '[data-dec-save]', () => save(false));
    ctx.on('click', '[data-dec-publish]', async () => {
      if (!(await save(true))) return;
      const chk = d.check || {};
      if (chk.errors && chk.errors.length) { toast('Fix the ' + chk.errors.length + ' problem' + (chk.errors.length === 1 ? '' : 's') + ' listed above before publishing.', 'danger'); return; }
      ctx.modal({ title: 'Publish ' + esc(d.table.name), body: '<p class="fg2" style="margin:0">The draft becomes version ' + ((d.table.versions[0] ? d.table.versions[0].version : 0) + 1) + '. Decision steps that do not pin a version use it from their next run.</p>' + (chk.warnings && chk.warnings.length ? UI.notice(chk.warnings.map((w) => esc(w.message)).join('<br>'), 'warn') : '') + UI.field('Note', UI.input('', { placeholder: 'What changed', attrs: 'data-note' })),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Publish', { kind: 'primary', attrs: 'data-go' }),
        onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            App.closeOverlay();
            try {
              const out = await App.post('/api/decision-tables/' + enc(d.table.id) + '/publish', { note: m.querySelector('[data-note]').value.trim() || null });
              d.table = out.table; d.local = toLocal(out.table.draft); d.check = out.table.check; d.dirty = false;
              const i = (d.list || []).findIndex((x) => x.id === out.table.id); if (i >= 0) d.list[i] = Object.assign({}, d.list[i], { publishedVersion: out.version });
              toast(esc(out.table.name) + ' v' + out.version + ' published' + (out.warnings.length ? ', with ' + out.warnings.length + ' warning' + (out.warnings.length === 1 ? '' : 's') : '') + '.', 'ok');
            } catch (err) { d.problem = { title: (err.problem && err.problem.title) || 'Not published', detail: (err.problem && err.problem.detail) || err.message, trace: err.problem && err.problem.trace_id }; App.fail(err, 'The table was not published'); }
            ctx.rerender();
          });
        } });
    });
    ctx.on('change', '[data-dec-tin]', (e, el) => { d.testInputs = d.testInputs || {}; const c = L.inputs.find((x) => x.name === el.dataset.decTin); const v = el.value; d.testInputs[el.dataset.decTin] = v === '' ? null : c && c.type === 'number' && !isNaN(Number(v)) ? Number(v) : c && c.type === 'boolean' ? v === 'true' : v; });
    ctx.on('change', '[data-dec-tver]', (e, el) => { d.testVersion = el.value; ctx.rerender(); });
    ctx.on('click', '[data-dec-vtest]', (e, el) => { d.testVersion = el.dataset.decVtest; d.tab = 'test'; ctx.rerender(); });
    ctx.on('click', '[data-dec-test]', async () => {
      ctx.$$('[data-dec-tin]').forEach((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
      const ver = d.testVersion || 'draft';
      if (ver === 'draft' && d.dirty && !(await save(true))) return;
      try {
        d.result = await App.post('/api/decision-tables/' + enc(t.id) + '/test', { version: ver === 'draft' || ver === 'published' ? ver : Number(ver), inputs: d.testInputs || {} });
        d.testError = null;
        toast(d.result.matched.length ? 'Evaluated: ' + d.result.matched.length + ' rule' + (d.result.matched.length === 1 ? '' : 's') + ' matched.' : 'Evaluated: no rule matched.', 'ok');
      } catch (err) { d.result = null; d.testError = { title: (err.problem && err.problem.title) || 'Refused', detail: (err.problem && err.problem.detail) || err.message }; }
      ctx.rerender();
    });
    ctx.on('click', '[data-dec-export]', async (e, el) => {
      const v = el.dataset.decExport; let doc;
      try { doc = await App.get('/api/decision-tables/' + enc(t.id) + '/export' + (v === 'draft' ? '?version=draft' : '?version=' + enc(v))); } catch (err) { App.fail(err, 'Could not export the table'); return; }
      const text = JSON.stringify(doc, null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = t.name + '.decision.json'; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(esc(t.name) + '.decision.json downloaded (' + (doc.version ? 'v' + esc(doc.version) : 'the draft') + ').', 'ok');
    });
    ctx.on('click', '[data-dec-used]', async () => {
      try { const u = await App.get('/api/decision-tables/' + enc(t.id) + '/used-by'); ctx.modal({ title: 'Used by', body: u.usedBy.length ? UI.table(['Workflow', 'Version', 'Steps'], u.usedBy.map((x) => [esc(x.workflow), 'v' + esc(x.version), esc(x.steps.join(', '))]), { clickable: false }) : '<p class="fg2" style="margin:0">No published workflow uses ' + esc(t.name) + '.</p>', actions: UI.btn('Close', { attrs: 'data-close' }) }); } catch (err) { App.fail(err, 'Could not look it up'); }
    });
    ctx.on('click', '[data-dec-del]', async () => {
      if (!(await ctx.confirm({ title: 'Delete ' + t.name, tag: 'delete', tone: 'danger', body: '<p class="fg2" style="margin:0">The table and every version are deleted. A table a published workflow uses is refused.</p>', ok: 'Delete' }))) return;
      try { await App.del('/api/decision-tables/' + enc(t.id)); d.list = null; d.selId = null; d.table = null; toast(esc(t.name) + ' deleted.', 'warn'); ctx.rerender(); }
      catch (err) { App.fail(err, 'The table was not deleted'); }
    });
  };

  // ---------- the designer's Switch and Decision steps ----------
  const MATCHES = [{ value: 'equals', label: 'equals' }, { value: 'in', label: 'is one of' }, { value: 'range', label: 'is a number from … up to' }];
  const scal = (s) => { const x = String(s).trim(); return x === 'true' ? true : x === 'false' ? false : x !== '' && !isNaN(Number(x)) ? Number(x) : x; };
  const caseText = (k) => (k.match === 'equals' ? '= ' + lit(k.value) : k.match === 'in' ? 'in (' + (k.values || []).map(lit).join(', ') + ')' : (k.min != null ? k.min : '…') + ' to under ' + (k.max != null ? k.max : '…'));
  const lines = (obj) => Object.keys(obj || {}).map((k) => k + ': ' + obj[k]).join('\n');
  const unlines = (text) => { const o = {}; String(text).split('\n').forEach((l) => { const i = l.indexOf(':'); if (i > 0) { const k = l.slice(0, i).trim(); if (k) o[k] = l.slice(i + 1).trim(); } }); return o; };
  function tables(st, later) {
    if (st.decTables || st.decTablesLoading) return st.decTables || [];
    st.decTablesLoading = true;
    App.get('/api/decision-tables').then((x) => { st.decTables = x; }).catch(() => { st.decTables = []; }).finally(() => { st.decTablesLoading = false; if (later) later(); });
    return [];
  }
  function tableDetail(st, name, later) {
    st.decDetail = st.decDetail || {};
    const row = (st.decTables || []).find((x) => x.name === name || x.id === name);
    if (!row || st.decDetail[row.id]) return row ? st.decDetail[row.id] : null;
    st.decDetail[row.id] = { loading: true };
    App.get('/api/decision-tables/' + enc(row.id)).then((v) => { st.decDetail[row.id] = v; if (later) later(); }).catch(() => { st.decDetail[row.id] = { failed: true }; });
    return st.decDetail[row.id];
  }

  App.wfSteps = {
    kinds: { switch: ['Switch', 'control'], decision: ['Decision', 'Doing'] },
    defaults(kind, st) {
      if (kind === 'switch') return { value: '{{input.amount}}', cases: [{ label: 'small', match: 'range', max: 1000 }, { label: 'large', match: 'range', min: 1000 }] };
      const t = (st.decTables || []).find((x) => x.publishedVersion);
      return { table: t ? t.name : '' };
    },
    sub(n) {
      const c = n.config || {};
      if (n.kind === 'switch') return (c.value || '?') + ': ' + (c.cases || []).map((k) => k.label).concat('default').join(', ');
      if (n.kind === 'decision') return 'table ' + (c.table || 'not set') + (c.version ? ' v' + c.version : ', latest');
      return '';
    },
    /** The case a new edge out of a switch takes: the first case not yet connected, else default. */
    nextCase(n, edges) {
      const used = edges.filter((e) => e.from === n.id && e.case).map((e) => e.case.toLowerCase());
      const k = ((n.config || {}).cases || []).find((x) => used.indexOf(x.label.toLowerCase()) < 0);
      return k ? k.label : used.indexOf('default') < 0 ? 'default' : null;
    },
    /** The run view's line for a finished step. */
    stepText(n, s) {
      const d = (s && s.detail) || {};
      if (n.kind === 'switch' && d.case) return 'took the case ' + esc(d.case);
      if (n.kind === 'decision' && d.table) return esc(d.table) + ' v' + esc(d.version) + ': ' + (d.matched && d.matched.length ? 'matched ' + esc(d.matched.join(', ')) : 'no rule matched');
      return null;
    },
    fields: {
      switch(n, st, ro) {
        const c = n.config || {}; const cases = c.cases || [];
        return UI.field('Value', UI.input(c.value || '', { placeholder: '{{input.amount}}', attrs: 'data-sw="value"' + ro }), 'A context path such as {{input.amount}}, or text built from several ({{input.region}}-{{input.tier}})')
          + '<div class="eyebrow">Cases, checked in order</div><div class="vstack gap6">' + cases.map((k, i) => '<div class="vstack gap4" style="border:1px solid var(--line);border-radius:6px;padding:6px">'
            + '<div class="grid2" style="gap:6px">' + UI.input(k.label, { attrs: 'data-swc="' + i + ',label" aria-label="Case ' + (i + 1) + ' label"' + ro }) + UI.select(MATCHES, k.match, 'data-swc="' + i + ',match" aria-label="Case ' + (i + 1) + ' test"' + ro) + '</div>'
            + (k.match === 'range' ? '<div class="grid2" style="gap:6px">' + UI.input(k.min == null ? '' : String(k.min), { type: 'number', placeholder: 'from (any)', attrs: 'data-swc="' + i + ',min" aria-label="Case ' + (i + 1) + ' from"' + ro }) + UI.input(k.max == null ? '' : String(k.max), { type: 'number', placeholder: 'up to (any)', attrs: 'data-swc="' + i + ',max" aria-label="Case ' + (i + 1) + ' up to, not including"' + ro }) + '</div>'
              : UI.input(k.match === 'in' ? (k.values || []).join(', ') : k.value == null ? '' : String(k.value), { placeholder: k.match === 'in' ? 'acme, globex' : 'value', attrs: 'data-swc="' + i + ',' + (k.match === 'in' ? 'values' : 'value') + '" aria-label="Case ' + (i + 1) + ' value' + (k.match === 'in' ? 's, comma-separated' : '') + '"' + ro }))
            + (ro ? '' : '<div class="hstack gap4">' + UI.btn('Earlier', { size: 'xs', kind: 'ghost', attrs: 'data-swmove="' + i + ',-1" aria-label="Move case ' + esc(k.label) + ' earlier"', disabled: i === 0 }) + UI.btn('Later', { size: 'xs', kind: 'ghost', attrs: 'data-swmove="' + i + ',1" aria-label="Move case ' + esc(k.label) + ' later"', disabled: i === cases.length - 1 }) + UI.iconbtn('trash', 'Remove case ' + k.label, { cls: 'sm ghost', attrs: 'data-swdel="' + i + '"' }) + '</div>') + '</div>').join('') + '</div>'
          + (ro ? '' : '<div>' + UI.btn('Add case', { size: 'xs', icon: 'plus', attrs: 'data-swadd', disabled: cases.length >= 9 }) + '</div>')
          + '<div class="muted" style="font-size:12px">The first case that matches is taken, else default; exactly one edge runs and the others are skipped. Connect every case and the default: each edge names its case under Connects to. The output is the input with {case}.</div>';
      },
      decision(n, st, ro, later) {
        const c = n.config || {};
        const ts = tables(st, later).filter((x) => x.publishedVersion || x.name === c.table);
        const opts = [{ value: '', label: ts.length ? 'choose a table' : 'no table is published yet' }].concat(ts.map((x) => ({ value: x.name, label: x.name + ' · v' + (x.publishedVersion || '-') + ' · ' + x.label })));
        if (c.table && !ts.some((x) => x.name === c.table)) opts.push({ value: c.table, label: c.table + ' (not published here)' });
        const det = c.table ? tableDetail(st, c.table, later) : null;
        const cols = det && det.draft ? det.draft : null;
        return UI.field('Decision table', UI.select(opts, c.table || '', 'data-dc="table"' + ro), (c.table ? '<a href="#" data-dcopen="' + esc(c.table) + '">Open the table</a>. ' : '') + 'Published tables of the tenant at or below this workflow\'s label')
          + '<div class="grid2" style="gap:10px">' + UI.field('Version', UI.input(c.version == null ? '' : String(c.version), { type: 'number', placeholder: 'latest', attrs: 'data-dc="version"' + ro }), 'Empty: the latest when the run reaches it') + UI.field('No rule matches', UI.select([{ value: 'continue', label: 'go on' }, { value: 'fail', label: 'fail the step' }], c.noMatch || 'continue', 'data-dc="noMatch"' + ro)) + '</div>'
          + UI.field('Inputs', UI.textarea(lines(c.inputs), { rows: 3, placeholder: cols ? cols.inputs.map((x) => x.name + ': {{input.' + x.name + '}}').join('\n') : 'amount: {{input.total}}', attrs: 'data-dc="inputs"' + ro }), 'One per line, column: template.' + (cols ? ' Columns: ' + esc(cols.inputs.map((x) => x.name + ' (' + x.type + ')').join(', ')) + '.' : '') + ' Empty: the fields of the same names in the source below, or in the step\'s input')
          + UI.field('Source', UI.input(c.source || '', { placeholder: '{{input.record.values}}', attrs: 'data-dc="source"' + ro }), 'Without inputs: a template giving an object whose fields the columns read')
          + UI.field('Outputs', UI.textarea(lines(c.outputs), { rows: 2, placeholder: cols ? cols.outputs.map((x) => x.name + ': ' + x.name).join('\n') : 'discount: discount', attrs: 'data-dc="outputs"' + ro }), 'One per line, field: output column.' + (cols ? ' Outputs: ' + esc(cols.outputs.map((x) => x.name).join(', ')) + '.' : '') + ' Empty: every output under its own name')
          + '<div class="muted" style="font-size:12px">Evaluated as the run\'s owner, with no code run; the output is the mapped values and {matched}, at the table\'s label. A broken unique or any hit policy fails the step.</div>';
      }
    },
    /** The inspector's case picker on an edge out of a switch. */
    edgeCase(n, e, editable) {
      const opts = ((n.config || {}).cases || []).map((k) => k.label).concat('default');
      if (e.case && opts.indexOf(e.case) < 0) opts.push(e.case);
      return UI.select([{ value: '', label: 'no case' }].concat(opts.map((o) => ({ value: o, label: o }))), e.case || '', 'data-swedge="' + esc(e.to) + '" aria-label="Case of the edge to ' + esc(e.to) + '"' + (editable ? '' : ' disabled'));
    },
    bind(ctx, deps) {
      const st = ctx.state;
      const node = () => { const n = deps.selNode(); return n && deps.editable ? n : null; };
      ctx.on('change', '[data-sw]', (e, el) => { const n = node(); if (!n) return; n.config.value = el.value; deps.after(el); });
      ctx.on('change', '[data-swc]', (e, el) => {
        const n = node(); if (!n) return; const [i, k] = el.dataset.swc.split(','); const c = n.config.cases[Number(i)]; if (!c) return;
        const v = el.value;
        if (k === 'label') c.label = v.trim();
        else if (k === 'match') { const keep = { label: c.label, match: v }; if (v === 'equals') keep.value = ''; if (v === 'in') keep.values = []; Object.keys(c).forEach((x) => delete c[x]); Object.assign(c, keep); }
        else if (k === 'value') c.value = v.trim() === '' ? null : scal(v);
        else if (k === 'values') c.values = v.split(',').map((x) => x.trim()).filter(Boolean).map(scal);
        else if (k === 'min' || k === 'max') { if (v.trim() === '') delete c[k]; else c[k] = Number(v); }
        deps.after(el);
      });
      ctx.on('click', '[data-swadd]', () => { const n = node(); if (!n) return; const cs = n.config.cases = n.config.cases || []; let i = cs.length + 1; while (cs.some((k) => k.label === 'case' + i)) i++; cs.push({ label: 'case' + i, match: 'equals', value: '' }); deps.changed('Case case' + i + ' added. Connect it from this step to the step it leads to.'); });
      ctx.on('click', '[data-swdel]', (e, el) => { const n = node(); if (!n) return; const i = Number(el.dataset.swdel); const k = n.config.cases[i]; n.config.cases.splice(i, 1); deps.graph().edges.forEach((x) => { if (x.from === n.id && x.case === k.label) delete x.case; }); deps.changed('Case ' + esc(k.label) + ' removed; an edge that took it needs another case.'); });
      ctx.on('click', '[data-swmove]', (e, el) => { const n = node(); if (!n) return; const [i, by] = el.dataset.swmove.split(',').map(Number); const cs = n.config.cases; const j = i + by; if (j < 0 || j >= cs.length) return; const x = cs[i]; cs[i] = cs[j]; cs[j] = x; deps.changed(); });
      ctx.on('change', '[data-swedge]', (e, el) => { const n = deps.selNode(); if (!n || !deps.editable) return; const ed = deps.graph().edges.find((x) => x.from === n.id && x.to === el.dataset.swedge); if (!ed) return; if (el.value) ed.case = el.value; else delete ed.case; deps.changed('The edge takes the case ' + esc(el.value || 'none') + '.'); });
      ctx.on('change', '[data-dc]', (e, el) => {
        const n = node(); if (!n) return; const k = el.dataset.dc; const v = el.value; const c = n.config;
        if (k === 'version') { if (v.trim() === '') delete c.version; else c.version = Math.round(Number(v)); }
        else if (k === 'inputs' || k === 'outputs') { const o = unlines(v); if (Object.keys(o).length) c[k] = o; else delete c[k]; }
        else if (k === 'source') { if (v.trim()) c.source = v.trim(); else delete c.source; }
        else if (k === 'noMatch') c.noMatch = v;
        else c[k] = v;
        deps.after(el);
      });
      ctx.on('click', '[data-dcopen]', (e, el) => { e.preventDefault(); const row = (st.decTables || []).find((x) => x.name === el.dataset.dcopen); st.dec = st.dec || { tab: 'rules' }; if (row) { st.dec.selId = row.id; st.dec.table = null; } deps.openDecisions(); });
    }
  };

  // Decision tables as a screen of their own in the sidebar's Build group (2026-10-15): the same view the Workflows
  // screen shows at #/workflows?view=decisions, with its own route so the sidebar marks it as the current page.
  App.register({
    id: 'decisions', title: 'Decision tables', live: true,
    summary: 'Rule tables with typed columns and hit policies, used by the decision workflow step, app flows and the decision.evaluate tool.',
    crumb: (st) => ['Build', 'Decision tables'].concat(st.dec && st.dec.table ? [st.dec.table.name] : []),
    label: (st) => (st.dec && st.dec.table ? st.dec.table.label : null),
    render(root, ctx) {
      let timer = null;
      const later = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          if (App.state.route !== 'decisions') return;
          if (document.getElementById('overlay')) { later(); return; }
          App.render();
        }, 300);
      };
      App.wfDecisions(root, ctx, { later, back() { ctx.navigate('workflows'); } });
    }
  });
})();
