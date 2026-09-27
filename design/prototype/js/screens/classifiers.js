(function () {
  const { UI, esc } = App;

  const LEVELS = ['public', 'internal', 'confidential', 'restricted'];
  const CLASSIFIERS = [
    { id: 'pii', name: 'PII detector', engine: 'deterministic', sub: 'deterministic, negligible cost', status: 'published', cost: 'Negligible', desc: 'Regex, checksums and entropy for personal data. Used by 9 guardrail rules, column masking on 4 connections and auto-labelling in every knowledge base.', version: 7, owner: 'Platform', dataset: 'pii-eval-2026-06 (4,410 samples)',
      labels: [{ label: 'email', p: 0.99, r: 0.98, thr: 0.5, n: 1802 }, { label: 'phone', p: 0.96, r: 0.91, thr: 0.5, n: 1210 }, { label: 'iban', p: 1.0, r: 0.99, thr: 0.5, n: 902, note: 'checksum verified' }, { label: 'national-id', p: 0.94, r: 0.88, thr: 0.5, n: 496 }],
      usage: [['Guardrails', 'PII-IBAN, PII in prompts, PII in proposed memory and 6 more', 'guardrails'], ['Connections', 'Column masking on ledger-ro, hr-warehouse, app-logs, contracts-index', 'connections'], ['Knowledge', 'Auto-labelling in Finance KB, Contracts KB, Policy KB, Engineering wiki', 'knowledge']] },
    { id: 'secrets', name: 'Secrets and keys', engine: 'deterministic', sub: 'deterministic', status: 'published', cost: 'Negligible', desc: 'Private key headers, cloud access keys, bearer tokens and high-entropy strings. Used by 4 guardrail rules at input, output, memory and script checkpoints.', version: 5, owner: 'Platform', dataset: 'secrets-eval-2026-05 (2,120 samples)',
      labels: [{ label: 'private-key', p: 1.0, r: 1.0, thr: 0.5, n: 640 }, { label: 'cloud-access-key', p: 0.99, r: 0.97, thr: 0.5, n: 720 }, { label: 'bearer-token', p: 0.93, r: 0.90, thr: 0.5, n: 560 }, { label: 'high-entropy', p: 0.81, r: 0.95, thr: 0.6, n: 200, note: 'entropy 4.2 bits' }],
      usage: [['Guardrails', 'Secrets and private keys (input and output), Secrets in memory, Hard-coded credentials', 'guardrails']] },
    { id: 'finance', name: 'Finance sensitivity', engine: 'embedding + linear head', sub: 'embedding plus linear head', status: 'published', cost: 'Very low', desc: 'Embedding plus trained linear head on nomic-embed-text. Used for auto-labelling in 3 knowledge bases and 2 guardrail rules.', version: 3, owner: 'Mara Okafor', dataset: 'finance-labels-2026-08 (4,980 samples)',
      labels: [{ label: 'public', p: 0.97, r: 0.93, thr: 0.50, n: 1210 }, { label: 'internal', p: 0.91, r: 0.94, thr: 0.55, n: 2044 }, { label: 'confidential', p: 0.94, r: 0.89, thr: 0.60, n: 1630 }, { label: 'restricted', p: 0.98, r: 0.71, thr: 0.80, n: 96, note: 'small sample' }],
      usage: [['Knowledge', 'Auto-labelling in Finance KB, Contracts KB, Policy KB', 'knowledge'], ['Guardrails', 'Label ceiling across workspaces, Restricted leaves the tenant', 'guardrails'], ['Training', 'Retrained from confirmed flags every Sunday 02:00', 'training']] },
    { id: 'safety', name: 'Safety categories', engine: 'guard model', sub: 'guard model llama-guard3', status: 'published', cost: 'Medium', desc: 'llama-guard3:8b through the gateway on gpu-small-1. Categories S1 to S13; used by 3 guardrail rules at model output, image and media checkpoints.', version: 2, owner: 'Platform', dataset: 'safety-eval-2026-07 (3,300 samples)',
      labels: [{ label: 'S1 violent crimes', p: 0.95, r: 0.92, thr: 0.5, n: 420 }, { label: 'S4 child exploitation', p: 0.99, r: 0.97, thr: 0.3, n: 310 }, { label: 'S6 specialised advice', p: 0.82, r: 0.88, thr: 0.6, n: 880 }, { label: 'S11 self-harm', p: 0.96, r: 0.94, thr: 0.4, n: 390 }],
      usage: [['Guardrails', 'Safety categories, Image prompt safety, Frame safety', 'guardrails'], ['Pools', 'gpu-small-1, pinned, 2 replicas', 'pools']] },
    { id: 'contract', name: 'Contract type', engine: 'LLM with JSON schema', sub: 'LLM with JSON schema, high cost', status: 'draft', cost: 'High', desc: 'qwen2.5:32b-q4_K_M with a JSON-schema output over the first two pages. Few examples so far; intended for Contracts KB metadata.', version: 1, owner: 'Tomasz Weber', dataset: 'contract-types-2026-09 (188 samples)',
      labels: [{ label: 'MSA', p: 0.90, r: 0.86, thr: 0.5, n: 62, note: 'small sample' }, { label: 'SOW', p: 0.84, r: 0.80, thr: 0.5, n: 58, note: 'small sample' }, { label: 'NDA', p: 0.97, r: 0.95, thr: 0.5, n: 44, note: 'small sample' }, { label: 'Lease', p: 0.71, r: 0.60, thr: 0.5, n: 24, note: 'small sample' }],
      usage: [['Knowledge', 'Proposed for Contracts KB metadata (not yet bound)', 'knowledge']] }
  ];
  const curve = (l, t) => { const d = t - l.thr; return { p: Math.max(0.5, Math.min(0.995, l.p + d * 0.55)), r: Math.max(0.2, Math.min(0.995, l.r - d * 1.0)) }; };

  App.register({
    id: 'classifiers', title: 'Classifiers', summary: 'Classifier registry, thresholds, evaluation, label names, batch runs', section: 'admin',
    crumb: (st) => ['Admin', 'Classifiers', (CLASSIFIERS.find((c) => c.id === st.sel) || CLASSIFIERS[2]).name],
    commands: [
      { label: 'Test text against a classifier', sub: 'Classifiers', run(app) { app.stateFor('classifiers').openTest = true; app.render(); } },
      { label: 'Run batch classification', sub: 'Classifiers', run(app) { app.stateFor('classifiers').startBatch = true; app.render(); } }
    ],
    states: [
      { title: 'Reorder refused', tone: 'danger', text: 'Dragging a level shows why order is fixed: ceilings and high-water marks depend on it.', apply(ctx) { ctx.state.reorder = true; ctx.rerender(); } },
      { title: 'Eval set too small', tone: 'warn', text: 'Below 200 samples per label the page warns that precision and recall are not reliable.', apply(ctx) { const st = ctx.state; st.sel = 'finance'; st.tab = 'evaluation'; st.label = 'restricted'; st.smallWarn = true; ctx.rerender(); } },
      { title: 'Batch run', tone: 'info', text: 'classify.batch shows progress, the label distribution so far and a cancel action.', apply(ctx) { ctx.state.startBatch = true; ctx.rerender(); } },
      { title: 'Highest wins', tone: 'neutral', text: 'Where manual, auto and inherited labels differ, the page shows all three and marks the highest as effective.', apply(ctx) { const st = ctx.state; st.sel = 'finance'; st.tab = 'usage'; st.highest = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.classifier) { st.sel = ctx.params.classifier; delete ctx.params.classifier; }
      st.sel = st.sel || 'finance'; st.tab = st.tab || 'evaluation'; st.names = st.names || { public: 'Public', internal: 'Internal', confidential: 'Confidential', restricted: 'Strictly confidential' }; st.thr = st.thr || {};
      const c = CLASSIFIERS.find((x) => x.id === st.sel) || CLASSIFIERS[2];
      if (!c.labels.some((l) => l.label === st.label)) st.label = c.labels[c.labels.length - 1].label;
      const lab = c.labels.find((l) => l.label === st.label);
      const key = c.id + '/' + lab.label; const thr = st.thr[key] != null ? st.thr[key] : lab.thr;
      const at = curve(lab, thr); const alt = curve(lab, Math.max(0.05, Math.round((thr - 0.15) * 100) / 100));
      const small = lab.n < 200;
      const anySmall = c.labels.some((l) => l.n < 200);

      const evalTab = (st.smallWarn || (c.status === 'draft' && anySmall) ? UI.notice('<b>Eval set too small.</b> ' + c.labels.filter((l) => l.n < 200).map((l) => esc(l.label) + ' has ' + l.n).join(', ') + ' samples. Below 200 per label, precision and recall are not reliable and thresholds should not be tuned from them.', 'warn', '<a href="#" data-gotraining>Add samples in Training</a>') : '')
        + UI.table(['Label', { label: 'Precision', right: true }, { label: 'Recall', right: true }, { label: 'Threshold', right: true }, { label: 'Eval samples', right: true }, 'Note'], c.labels.map((l) => { const t = st.thr[c.id + '/' + l.label]; const cv = t != null ? curve(l, t) : null; return { cells: [esc(l.label), cv ? cv.p.toFixed(2) : l.p.toFixed(2), cv ? cv.r.toFixed(2) : l.r.toFixed(2), '<span class="mono">' + (t != null ? t : l.thr).toFixed(2) + '</span>' + (t != null && t !== l.thr ? ' ' + UI.pill('unsaved', 'warn') : ''), l.n.toLocaleString('en-GB'), l.note ? UI.pill(l.note, l.note === 'small sample' ? 'warn' : 'ok') : ''], attrs: 'data-label="' + esc(l.label) + '"', selected: l.label === lab.label }; }), { minWidth: '0' })
        + '<div class="cols"><div class="grow">' + UI.panel('Threshold preview: ' + lab.label,
          '<div class="hstack gap12"><label class="fl" style="font-size:12px;font-weight:600;white-space:nowrap" for="thr-range">Threshold ' + thr.toFixed(2) + '</label><input type="range" id="thr-range" min="5" max="95" step="' + (small ? 5 : 1) + '" value="' + Math.round(thr * 100) + '" data-thr style="flex-grow:1;accent-color:var(--accent)"></div>'
          + UI.kv([['Precision at ' + thr.toFixed(2), at.p.toFixed(2)], ['Recall at ' + thr.toFixed(2), at.r.toFixed(2)], ['At ' + Math.max(0.05, thr - 0.15).toFixed(2), 'precision ' + alt.p.toFixed(2) + ', recall ' + alt.r.toFixed(2)], ['Eval set', lab.n.toLocaleString('en-GB') + ' samples' + (small ? ': too few to trust below 0.05 steps' : '')]], 4)
          + '<div class="hstack">' + UI.btn('Save threshold', { kind: 'primary', size: 'sm', attrs: 'data-savethr', disabled: thr === lab.thr }) + UI.btn('Reset', { kind: 'ghost', size: 'sm', attrs: 'data-resetthr', disabled: thr === lab.thr }) + '<span class="muted" style="font-size:12px">Saving creates version ' + (c.version + 1) + ' and re-labels nothing until a batch run.</span></div>') + '</div>'
        + '<div style="width:360px;flex-shrink:0">' + UI.panel('Tenant names for the four levels',
          (st.reorder ? UI.notice('<b>Reorder refused.</b> The order public, internal, confidential, restricted is fixed. Model and zone ceilings, tool egress and the high-water mark all compare levels by position.', 'danger', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-reorderok' })) : '')
          + LEVELS.map((lv) => '<div class="hstack" draggable="true" data-drag="' + lv + '">' + UI.icon('sort', 12) + UI.label(lv, { sm: true }) + '<span style="color:var(--faint);white-space:nowrap">is shown as</span><div class="field grow"><label class="sr" for="name-' + lv + '">Name for ' + lv + '</label>' + UI.input(st.names[lv], { attrs: 'data-name="' + lv + '"' }).replace('<input', '<input id="name-' + lv + '"') + '</div></div>').join('')
          + '<span class="muted" style="font-size:12px">Levels can be renamed. Their order is fixed.</span>') + '</div></div>';

      const definition = UI.panel('Definition', UI.kv([
        ['Engine', esc(c.engine)], ['Relative cost', esc(c.cost)], ['Version', 'v' + c.version + ' · ' + UI.pill(c.status)], ['Owner', esc(c.owner)],
        ['Label set', c.labels.map((l) => '<span class="mono">' + esc(l.label) + '</span>').join(', ')], ['Eval dataset', '<a href="#" data-gotraining>' + esc(c.dataset) + '</a>'],
        [c.engine === 'deterministic' ? 'Detectors' : c.engine === 'guard model' ? 'Model' : c.engine.indexOf('embedding') === 0 ? 'Embedding model and head' : 'Model and schema', c.engine === 'deterministic' ? 'RE2 patterns, Luhn and IBAN checksums, Shannon entropy over 20+ char tokens' : c.engine === 'guard model' ? '<span class="mono">llama-guard3:8b</span> on gpu-small-1, categories S1 to S13' : c.engine.indexOf('embedding') === 0 ? '<span class="mono">nomic-embed-text</span> 768 d, logistic head trained 8 Sep, weights 12 KB' : '<span class="mono">qwen2.5:32b-q4_K_M</span>, <span class="mono">format: json_schema</span>, 4 examples in the prompt'],
        ['API', '<span class="mono">POST /api/classify</span> synchronous for short text; <span class="mono">classify.batch</span> jobs for bulk']
      ], 2) + (c.engine !== 'deterministic' ? UI.code(c.engine === 'guard model' ? '{ "classifier": "safety", "text": "…", "categories": ["S1", "S4", "S6", "S11"] }' : c.engine.indexOf('LLM') === 0 ? '{\n  "classifier": "contract",\n  "schema": { "type": "object", "properties": { "type": { "enum": ["MSA", "SOW", "NDA", "Lease"] }, "confidence": { "type": "number" } } }\n}' : '{ "classifier": "finance", "labels": ["public", "internal", "confidential", "restricted"], "embedding": "nomic-embed-text" }', 'json') : ''));

      const thresholds = UI.panel('Thresholds', UI.table(['Label', { label: 'Threshold', right: true }, 'Below threshold', 'Guardrail use'], c.labels.map((l) => { const t = st.thr[c.id + '/' + l.label]; return { cells: [esc(l.label), '<span class="mono">' + (t != null ? t : l.thr).toFixed(2) + '</span>', esc(l.label === 'restricted' ? 'falls back to confidential' : c.engine === 'deterministic' ? 'not reported' : 'next lower label'), esc(l.label === 'restricted' ? 'Restricted leaves the tenant blocks at 0.80' : l.label === 'confidential' ? 'Label ceiling across workspaces' : '')], attrs: 'data-label="' + esc(l.label) + '"', selected: l.label === lab.label }; }), { minWidth: '0' }) + '<div class="muted" style="font-size:12px">Pick a label and tune it on the Evaluation tab. Deterministic detectors have fixed thresholds; entropy detectors expose the bit threshold instead.</div>');

      const usage = (st.highest ? UI.panel('Label sources: Q3 cost centre review.pdf', UI.notice('Three sources disagree. The highest wins, so the document is <b>confidential</b>.', 'info') + UI.table(['Source', 'Label', 'Set by', 'Effective'], [['Manual label on the document', UI.label('internal', { sm: true }), 'Tomasz Weber, 2 Sep', ''], ['Auto-classifier Finance sensitivity v3', UI.label('confidential', { sm: true }), 'score 0.87 at threshold 0.60', UI.pill('effective', 'ok')], ['Inherited from Finance KB', UI.label('internal', { sm: true }), 'Knowledge base default', '']], { clickable: false, minWidth: '0' }) + '<div class="hstack">' + UI.btn('Open in Knowledge', { size: 'sm', attrs: 'data-goknowledge' }) + UI.btn('Hide', { kind: 'ghost', size: 'sm', attrs: 'data-hidehighest' }) + '</div>') : '')
        + UI.panel('Used by', UI.table(['Area', 'Consumers', ''], c.usage.map((u) => ['<b>' + esc(u[0]) + '</b>', esc(u[1]), UI.btn('Open', { kind: 'ghost', size: 'xs', attrs: 'data-go="' + u[2] + '"' })]), { clickable: false, minWidth: '0' }) + '<div class="muted" style="font-size:12px">Label sources are manual, auto-classifier or inherited. The highest wins. <a href="#" data-showhighest>Show an example</a></div>');

      const batch = st.batch ? UI.panel('Batch run: classify.batch ' + esc(st.batch.id), UI.meter('Documents classified', st.batch.done.toLocaleString('en-GB') + ' of ' + st.batch.total.toLocaleString('en-GB'), st.batch.done / st.batch.total * 100, 'accent')
        + '<div class="hstack wrap gap12">' + c.labels.map((l, i) => '<span class="hstack gap6">' + UI.label(LEVELS.indexOf(l.label) >= 0 ? l.label : 'internal', { sm: true }).replace(LEVELS.indexOf(l.label) >= 0 ? '' : 'internal</span>', esc(l.label) + '</span>') + '<span class="num">' + Math.round(st.batch.done * [0.31, 0.44, 0.22, 0.03][i]).toLocaleString('en-GB') + '</span></span>').join('') + '</div>'
        + '<div class="hstack">' + (st.batch.done >= st.batch.total ? UI.pill('complete', 'ok') + '<span class="muted" style="font-size:12px">Labels applied. Chunks above a user\'s clearance drop out of retrieval at the next query.</span>' + UI.btn('Close', { kind: 'ghost', size: 'sm', attrs: 'data-closebatch' }) : UI.pill('running', 'info') + '<span class="muted" style="font-size:12px">Lower priority than chat on the same pool. Started ' + esc(st.batch.started) + '.</span>' + UI.btn('Cancel', { size: 'sm', attrs: 'data-cancelbatch' })) + '</div>', { cls: 'tint' }) : '';

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .cls-left{width:300px}'
        + '#main .cls-list{display:flex;flex-direction:column;gap:2px}'
        + '#main [data-drag]{cursor:grab}#main [data-drag].over{outline:1px dashed var(--danger-fg);border-radius:4px}'
        + '</style>'
        + '<div class="leftpane cls-left"><div class="hstack"><div class="eyebrow grow">Classifiers</div>' + UI.btn('New', { size: 'sm', attrs: 'data-new' }) + '</div>'
        + '<div class="cls-list">' + CLASSIFIERS.map((x) => UI.listItem(esc(x.name), esc(x.sub), { active: x.id === c.id, attrs: 'data-cls="' + x.id + '"', right: UI.pill(x.status, x.status === 'published' ? 'ok' : '') })).join('') + '</div>'
        + '<div class="divider"></div><div class="muted" style="font-size:12px">Four engines behind one registry. The same classifiers drive auto-labelling and guardrails.</div></div>'
        + '<div class="page">'
        + UI.pagehead(c.name, esc(c.desc), UI.btn('Run batch classification', { attrs: 'data-batch', disabled: !!(st.batch && st.batch.done < st.batch.total) }) + UI.btn('Test text', { kind: 'primary', attrs: 'data-test' }))
        + batch
        + UI.tabs([{ id: 'definition', label: 'Definition' }, { id: 'thresholds', label: 'Thresholds' }, { id: 'evaluation', label: 'Evaluation' }, { id: 'usage', label: 'Usage', count: c.usage.length }], st.tab)
        + (st.tab === 'definition' ? definition : st.tab === 'thresholds' ? thresholds : st.tab === 'usage' ? usage : evalTab)
        + '<div style="margin-top:auto"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      if (st.openTest) { st.openTest = false; openTest(ctx, c); }
      if (st.startBatch) { st.startBatch = false; startBatch(ctx, c); }
      if (st.batch && st.batch.done < st.batch.total && !st.batchTimer) tickBatch(ctx);

      // ---- events ----
      ctx.on('click', '[data-cls]', (e, t) => { st.sel = t.dataset.cls; st.smallWarn = false; st.highest = false; ctx.rerender(); });
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', 'tr.row[data-label]', (e, t) => { st.label = t.dataset.label; st.tab = 'evaluation'; ctx.rerender(); });
      ctx.on('input', '[data-thr]', (e, t) => { st.thr[key] = +t.value / 100; ctx.rerender(); const r = ctx.$('[data-thr]'); if (r) r.focus(); });
      ctx.on('click', '[data-savethr]', () => { lab.thr = thr; lab.p = at.p; lab.r = at.r; delete st.thr[key]; c.version += 1; ctx.rerender(); ctx.toast('Threshold for ' + esc(lab.label) + ' saved as v' + c.version + '. Guardrail rules using it pick up the change on their next evaluation.', 'ok'); });
      ctx.on('click', '[data-resetthr]', () => { delete st.thr[key]; ctx.rerender(); });
      ctx.on('change', '[data-name]', (e, t) => { st.names[t.dataset.name] = t.value; ctx.toast('Level name saved. Badges show "' + esc(t.value) + '" for ' + esc(t.dataset.name) + ' from the next page load.', 'ok'); });
      ctx.on('dragstart', '[data-drag]', (e, t) => { e.dataTransfer.effectAllowed = 'move'; st.dragging = t.dataset.drag; });
      ctx.on('dragover', '[data-drag]', (e, t) => { e.preventDefault(); t.classList.add('over'); });
      ctx.on('dragleave', '[data-drag]', (e, t) => { t.classList.remove('over'); });
      ctx.on('drop', '[data-drag]', (e, t) => { e.preventDefault(); if (st.dragging && st.dragging !== t.dataset.drag) { st.reorder = true; ctx.rerender(); ctx.toast('Reorder refused. Level order is fixed.', 'danger'); } });
      ctx.on('click', '[data-reorderok]', () => { st.reorder = false; ctx.rerender(); });
      ctx.on('click', '[data-test]', () => openTest(ctx, c));
      ctx.on('click', '[data-batch]', () => startBatch(ctx, c));
      ctx.on('click', '[data-cancelbatch]', () => { clearTimeout(st.batchTimer); st.batchTimer = null; const b = st.batch; st.batch = null; ctx.rerender(); ctx.toast('classify.batch ' + esc(b.id) + ' cancelled after ' + b.done.toLocaleString('en-GB') + ' documents. Labels already written stay.', 'warn'); });
      ctx.on('click', '[data-closebatch]', () => { st.batch = null; ctx.rerender(); });
      ctx.on('click', '[data-showhighest]', (e) => { e.preventDefault(); st.highest = true; ctx.rerender(); });
      ctx.on('click', '[data-hidehighest]', () => { st.highest = false; ctx.rerender(); });
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('click', '[data-goknowledge]', () => ctx.navigate('knowledge'));
      ctx.on('click', '[data-gotraining]', (e) => { e.preventDefault(); ctx.navigate('training'); });
      ctx.on('click', '[data-new]', () => ctx.modal({ title: 'New classifier', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'for example Supplier risk' })) + UI.field('Engine', UI.select([{ value: 'deterministic', label: 'Deterministic detectors (regex, checksums, entropy), negligible cost' }, { value: 'embedding', label: 'Embedding plus trained linear head, very low cost' }, { value: 'guard', label: 'Guard model (llama-guard3, shieldgemma, granite3-guardian), medium cost' }, { value: 'llm', label: 'General LLM with JSON-schema output, high cost' }], 'embedding')) + UI.field('Labels', UI.input('', { placeholder: 'comma separated' })) + UI.field('Eval dataset', UI.select(['Create from confirmed flags', 'Pick in Training'], 'Create from confirmed flags')) + '</div>' + UI.notice('New classifiers start as drafts. They publish only after an eval run with at least 200 samples per label.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-create' }), onMount(m) { m.querySelector('[data-create]').addEventListener('click', () => { const name = m.querySelector('input').value || 'New classifier'; App.closeOverlay(); CLASSIFIERS.push({ id: 'new-' + Date.now(), name, engine: 'embedding + linear head', sub: 'embedding plus linear head', status: 'draft', cost: 'Very low', desc: 'Draft. Add an eval dataset and labels, then train the head.', version: 1, owner: 'Mara Okafor', dataset: 'none yet', labels: [{ label: 'positive', p: 0, r: 0, thr: 0.5, n: 0, note: 'small sample' }, { label: 'negative', p: 0, r: 0, thr: 0.5, n: 0, note: 'small sample' }], usage: [] }); st.sel = CLASSIFIERS[CLASSIFIERS.length - 1].id; st.tab = 'definition'; ctx.rerender(); ctx.toast('Draft classifier created.', 'ok'); }); } }));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });

  function openTest(ctx, c) {
    const sample = c.id === 'finance' ? 'Q3 travel came to 412,880 EUR against a budget of 361,500 EUR. The Lisbon exception covers 38,000 EUR; the rest is unexplained pending the CFO review.' : c.id === 'pii' ? 'Pay supplier Fabrikam at DE89 3704 0044 0532 0130 00, contact anna.ruiz@fabrikam.example, +351 21 555 0199.' : c.id === 'secrets' ? 'export OPENAI_KEY=sk-9f3ab21c7d4e5f6a8b9c0d1e2f3a4b5c6d7e and rotate weekly' : c.id === 'safety' ? 'If the supplier misses the date again, the safest route is to talk to them before invoking clause 9.' : 'MASTER SERVICES AGREEMENT between Northwind B.V. and Fabrikam Ltd, effective 1 April 2025, initial term 24 months.';
    const resultFor = (text) => {
      if (c.id === 'finance') { const conf = /CFO|budget|EUR|salary|ledger/i.test(text); return [['public', 0.03], ['internal', conf ? 0.21 : 0.62], ['confidential', conf ? 0.87 : 0.30], ['restricted', /salary|payroll|merger/i.test(text) ? 0.83 : 0.05]]; }
      if (c.id === 'pii') return [['email', /@/.test(text) ? 1 : 0], ['phone', /\+?\d[\d ]{8,}/.test(text) ? 0.96 : 0], ['iban', /[A-Z]{2}\d{2}[ \d]{12,}/.test(text) ? 1 : 0], ['national-id', 0]];
      if (c.id === 'secrets') return [['private-key', /BEGIN/.test(text) ? 1 : 0], ['cloud-access-key', /AKIA/.test(text) ? 1 : 0], ['bearer-token', /sk-|Bearer/.test(text) ? 0.98 : 0], ['high-entropy', /[A-Za-z0-9]{28,}/.test(text) ? 0.91 : 0.1]];
      if (c.id === 'safety') return [['S1 violent crimes', 0.01], ['S4 child exploitation', 0.0], ['S6 specialised advice', /clause|legal|terminate/i.test(text) ? 0.44 : 0.05], ['S11 self-harm', 0.0]];
      return [['MSA', /master services/i.test(text) ? 0.92 : 0.2], ['SOW', 0.05], ['NDA', /non-disclosure|confidentiality/i.test(text) ? 0.9 : 0.02], ['Lease', 0.01]];
    };
    const render = (text) => { const rs = resultFor(text); const top = rs.slice().sort((a, b) => b[1] - a[1])[0]; return '<div class="vstack" style="gap:8px">' + rs.map((r) => { const l = c.labels.find((x) => x.label === r[0]); const hit = r[1] >= (l ? (ctx.state.thr[c.id + '/' + l.label] != null ? ctx.state.thr[c.id + '/' + l.label] : l.thr) : 0.5); return UI.meter(r[0] + (hit ? ' · above threshold' : ''), r[1].toFixed(2), r[1] * 100, hit ? 'accent' : ''); }).join('') + '</div>' + UI.notice(c.id === 'finance' ? 'Effective label <b>' + esc(top[0]) + '</b>. Where a manual or inherited label is higher, the highest wins.' : 'Top label <b>' + esc(top[0]) + '</b> at ' + top[1].toFixed(2) + '. ' + (c.engine === 'deterministic' ? 'Deterministic detectors report 1.00 on a checksum match.' : 'Scores come from ' + esc(c.engine) + '.'), 'info') + '<div class="muted mono" style="font-size:11px">POST /api/classify  classifier=' + esc(c.id) + '  ' + (c.engine === 'deterministic' ? '0.4 ms' : c.engine === 'guard model' ? '212 ms' : c.engine.indexOf('LLM') === 0 ? '3.1 s' : '18 ms') + '  label ' + (c.id === 'finance' ? esc(top[0]) : 'internal') + '</div>'; };
    ctx.modal({ cls: 'wide', title: 'Test text: ' + esc(c.name), body: UI.field('Text', UI.textarea(sample, { rows: 4, attrs: 'data-testtext' })) + '<div data-testresult>' + render(sample) + '</div>' + '<div class="muted" style="font-size:12px">Synchronous for short text. Nothing here is stored or labelled.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Classify', { kind: 'primary', attrs: 'data-classify' }), onMount(m) { m.querySelector('[data-classify]').addEventListener('click', () => { m.querySelector('[data-testresult]').innerHTML = render(m.querySelector('[data-testtext]').value); }); } });
  }

  function startBatch(ctx, c) {
    const st = ctx.state;
    ctx.modal({ title: 'Run batch classification', body: UI.field('Scope', UI.select(c.id === 'finance' ? ['Finance KB, 12,480 documents', 'Contracts KB, 4,812 chunks', 'Policy KB, 1,020 documents'] : c.id === 'contract' ? ['Contracts KB, 4,812 chunks'] : ['Finance KB, 12,480 documents', 'All knowledge bases, 31,204 documents'], c.id === 'contract' ? 'Contracts KB, 4,812 chunks' : 'Finance KB, 12,480 documents')) + UI.field('Apply', UI.select(['Write labels (highest wins)', 'Report only, write nothing'], 'Write labels (highest wins)')) + UI.notice('Runs as a <span class="mono">classify.batch</span> job at lower priority on the same pools. Progress is pushed over /ws. ' + (c.engine.indexOf('LLM') === 0 ? 'At high cost per document this uses about 4 GPU-hours.' : 'Cost is ' + esc(c.cost.toLowerCase()) + '.'), 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Start job', { kind: 'primary', attrs: 'data-start' }), onMount(m) { m.querySelector('[data-start]').addEventListener('click', () => { App.closeOverlay(); const total = /Contracts/.test(m.querySelector('select').value) ? 4812 : /All/.test(m.querySelector('select').value) ? 31204 : 12480; st.batch = { id: 'cb-' + String(Date.now()).slice(-5), total, done: 0, started: new Date().toTimeString().slice(0, 5) }; ctx.rerender(); ctx.toast('classify.batch queued. Progress shows on this page and under Runs.', 'ok'); }); } });
  }

  function tickBatch(ctx) {
    const st = ctx.state;
    st.batchTimer = setTimeout(() => {
      st.batchTimer = null; if (!st.batch) return;
      st.batch.done = Math.min(st.batch.total, st.batch.done + Math.round(st.batch.total / 9));
      if (ctx.app.state.route === 'classifiers') ctx.rerender(); else if (st.batch.done < st.batch.total) tickBatch(ctx);
      if (st.batch.done >= st.batch.total) ctx.toast('classify.batch ' + esc(st.batch.id) + ' finished: ' + st.batch.total.toLocaleString('en-GB') + ' documents labelled.', 'ok');
    }, 900);
  }
})();
