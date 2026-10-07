(function () {
  const { UI, esc } = App;

  const LEVELS = ['public', 'internal', 'confidential', 'restricted'];
  const MIN = 200;
  const COST = { deterministic: 'Negligible', linear: 'Very low', guard: 'Medium', llm: 'High', vision: 'High' };
  const SUB = { deterministic: 'deterministic, negligible cost', linear: 'word features plus trained linear head', guard: 'guard model through the gateway', llm: 'LLM with JSON output, high cost', vision: 'vision model scoring images, high cost' };
  const ENGINE = { deterministic: 'deterministic', linear: 'trained linear head', guard: 'guard model', llm: 'LLM with JSON output', vision: 'vision model' };
  const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/heic';
  /** A picked file as base64 (without the data: prefix). */
  const readB64 = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = () => reject(new Error('The file could not be read.')); r.readAsDataURL(file); });
  const SAMPLE = { pii: 'Pay supplier Fabrikam at DE89 3704 0044 0532 0130 00, contact anna.ruiz@fabrikam.example, +351 21 555 0199.', secrets: 'export OPENAI_KEY=sk-9f3ab21c7d4e5f6a8b9c0d1e2f3a4b5c6d7e and rotate weekly', safety: 'If the supplier misses the date again, the safest route is to talk to them before invoking clause 9.' };
  const enc = encodeURIComponent;
  const fmt = (v) => (v == null ? 'n/a' : Number(v).toFixed(2));
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const overlayOpen = () => !!document.getElementById('overlay');
  /** Precision and recall at a threshold, from the scores the last evaluation kept. */
  const at = (points, t) => {
    if (!points || !points.length) return null;
    let tp = 0, fp = 0, fn = 0;
    points.forEach((p) => { const hit = p[0] > 0 && p[0] >= t; if (hit && p[1]) tp++; else if (hit) fp++; else if (p[1]) fn++; });
    return { p: tp + fp ? tp / (tp + fp) : null, r: tp + fn ? tp / (tp + fn) : null };
  };

  const live = { sock: null, onJob: null, handler: null };
  const detach = () => { if (live.sock && live.onJob) live.sock.off('job.progress', live.onJob); live.sock = null; live.onJob = null; };
  const attach = () => {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.onJob = (e) => { if (App.state.route !== 'classifiers') { detach(); return; } if (live.handler) live.handler(e); };
    live.sock.on('job.progress', live.onJob);
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'classifiers') detach(); });

  App.register({
    id: 'classifiers', title: 'Classifiers', live: true, section: 'admin',
    summary: 'Classifier registry, thresholds, evaluation, label names, batch runs',
    crumb: (st) => { const c = (st.list || []).find((x) => x.id === st.sel); return ['Admin', 'Classifiers'].concat(c ? [c.name] : []); },
    commands: [
      { label: 'Test text against a classifier', sub: 'Classifiers', run(app) { app.stateFor('classifiers').openTest = true; app.render(); } },
      { label: 'Run batch classification', sub: 'Classifiers', run(app) { app.stateFor('classifiers').startBatch = true; app.render(); } }
    ],
    states: [
      { title: 'Reorder refused', tone: 'danger', text: 'Dragging a level shows why order is fixed: ceilings and high-water marks depend on it.', apply(ctx) { tryReorder(ctx, ['internal', 'public', 'confidential', 'restricted']); } },
      { title: 'Eval set too small', tone: 'warn', text: 'Below 200 samples per label the page warns that precision and recall are not reliable.', apply(ctx) { const st = ctx.state; const c = (st.list || []).find((x) => x.labels.some((l) => ((x.samples || {})[l.label] || 0) < MIN)); if (c) { st.sel = c.id; st.label = c.labels.find((l) => ((c.samples || {})[l.label] || 0) < MIN).label; } st.tab = 'evaluation'; st.smallWarn = true; ctx.rerender(); } },
      { title: 'Batch run', tone: 'info', text: 'classify.batch shows progress, the label distribution so far and a cancel action.', apply(ctx) { ctx.state.startBatch = true; ctx.rerender(); } },
      { title: 'Highest wins', tone: 'neutral', text: 'Where manual, auto and inherited labels differ, the page shows all three and marks the highest as effective.', apply(ctx) { const st = ctx.state; const c = (st.list || []).find((x) => x.labels.every((l) => LEVELS.indexOf(l.label) >= 0)); if (c) st.sel = c.id; st.tab = 'usage'; st.highest = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.thr = st.thr || {}; st.tab = st.tab || 'evaluation';
      const later = () => { if (App.state.route !== 'classifiers') return; if (overlayOpen()) { setTimeout(later, 250); return; } ctx.rerender(); };
      const load = (quiet) => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/admin/classifiers'), App.get('/api/admin/label-names').catch(() => null)])
          .then(([list, names]) => { st.list = list; if (names) st.names = names; st.loaded = true; st.loadError = null; })
          .catch((err) => { if (!quiet) st.loadError = err; })
          .finally(() => { st.loading = false; later(); });
      };
      if (!st.loaded && !st.loadError) load();
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Classifiers', 'One registry for auto-labelling and guardrails', '') + (st.loadError ? UI.problem('Classifiers could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      if (ctx.params.classifier) { const hit = st.list.find((x) => x.id === ctx.params.classifier || x.slug === ctx.params.classifier); if (hit) st.sel = hit.id; delete ctx.params.classifier; }
      const c = st.list.find((x) => x.id === st.sel) || st.list[0];
      st.sel = c.id;
      if (!c.labels.some((l) => l.label === st.label)) st.label = c.labels[c.labels.length - 1].label;
      const lab = c.labels.find((l) => l.label === st.label);
      const key = c.id + '/' + lab.label;
      const thr = st.thr[key] != null ? st.thr[key] : lab.threshold;
      const samples = c.samples || {};
      const n = (l) => samples[l] || 0;
      const metrics = c.metrics;
      const perLabel = (l) => (metrics && metrics.perLabel[l]) || null;
      const pts = (l) => (metrics && metrics.points[l]) || null;
      const cur = at(pts(lab.label), thr);
      const alt = at(pts(lab.label), Math.max(0.05, Math.round((thr - 0.15) * 100) / 100));
      const small = n(lab.label) < MIN;
      const shortLabels = c.labels.filter((l) => n(l.label) < MIN);
      const canWrite = !c.platform || App.can('platform:manage');
      const names = st.names || { public: 'Public', internal: 'Internal', confidential: 'Confidential', restricted: 'Restricted' };
      const batch = st.batch && st.batch.classifierId === c.id ? st.batch : null;
      const running = !!(batch && (batch.state === 'queued' || batch.state === 'running'));

      const evalTab = (st.smallWarn || (shortLabels.length && c.status === 'draft') ? UI.notice('<b>Eval set too small.</b> ' + (shortLabels.length ? shortLabels.map((l) => esc(l.label) + ' has ' + n(l.label)).join(', ') + ' samples.' : 'Every label has at least ' + MIN + ' samples.') + ' Below ' + MIN + ' per label, precision and recall are not reliable and thresholds should not be tuned from them.', 'warn', '<a href="#" data-addsamples>Add labelled cases</a>') : '')
        + (!metrics ? UI.notice('No evaluation yet. Run batch classification over the dataset <span class="mono">' + esc(c.dataset || '') + '</span> to measure precision and recall.', 'info') : metrics.errors ? UI.notice(metrics.errors + ' of ' + metrics.samples + ' cases could not be classified in the last run.', 'warn') : '')
        + UI.table(['Label', { label: 'Precision', right: true }, { label: 'Recall', right: true }, { label: 'Threshold', right: true }, { label: 'Eval samples', right: true }, 'Note'], c.labels.map((l) => {
          const t = st.thr[c.id + '/' + l.label]; const m = perLabel(l.label); const cv = t != null ? at(pts(l.label), t) : null;
          return { cells: [esc(l.label), cv ? fmt(cv.p) : fmt(m && m.precision), cv ? fmt(cv.r) : fmt(m && m.recall), '<span class="mono">' + (t != null ? t : l.threshold).toFixed(2) + '</span>' + (t != null && t !== l.threshold ? ' ' + UI.pill('unsaved', 'warn') : ''), n(l.label).toLocaleString('en-GB'), n(l.label) < MIN ? UI.pill('small sample', 'warn') : c.engine === 'deterministic' && (l.label === 'iban' || l.label === 'payment_card') ? UI.pill('checksum verified', 'ok') : ''], attrs: 'data-label="' + esc(l.label) + '"', selected: l.label === lab.label };
        }), { minWidth: '0' })
        + '<div class="cols"><div class="grow">' + UI.panel('Threshold preview: ' + lab.label,
          '<div class="hstack gap12"><label class="fl" style="font-size:12px;font-weight:600;white-space:nowrap" for="thr-range">Threshold ' + thr.toFixed(2) + '</label><input type="range" id="thr-range" min="5" max="95" step="' + (small ? 5 : 1) + '" value="' + Math.round(thr * 100) + '" data-thr style="flex-grow:1;accent-color:var(--accent)"' + (canWrite ? '' : ' disabled') + '></div>'
          + UI.kv([['Precision at ' + thr.toFixed(2), cur ? fmt(cur.p) : 'no evaluation'], ['Recall at ' + thr.toFixed(2), cur ? fmt(cur.r) : 'no evaluation'], ['At ' + Math.max(0.05, thr - 0.15).toFixed(2), alt ? 'precision ' + fmt(alt.p) + ', recall ' + fmt(alt.r) : 'no evaluation'], ['Eval set', n(lab.label).toLocaleString('en-GB') + ' samples' + (small ? ': too few to trust below 0.05 steps' : '')]], 4)
          + '<div class="hstack">' + UI.btn('Save threshold', { kind: 'primary', size: 'sm', attrs: 'data-savethr', disabled: thr === lab.threshold || !canWrite }) + UI.btn('Reset', { kind: 'ghost', size: 'sm', attrs: 'data-resetthr', disabled: thr === lab.threshold }) + '<span class="muted" style="font-size:12px">' + (canWrite ? 'Saving creates version ' + (c.version + 1) + ' and re-labels nothing until a batch run.' : 'Platform classifiers are changed by platform admins.') + '</span></div>') + '</div>'
        + '<div style="width:360px;flex-shrink:0">' + UI.panel('Tenant names for the four levels',
          (st.reorder ? UI.notice('<b>Reorder refused.</b> ' + esc(st.reorder), 'danger', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-reorderok' })) : '')
          + LEVELS.map((lv, i) => '<div class="hstack" draggable="true" data-drag="' + lv + '">' + UI.icon('sort', 12) + UI.label(lv, { sm: true }) + '<span style="color:var(--muted);white-space:nowrap">is shown as</span><div class="field grow"><label class="sr" for="name-' + lv + '">Name for ' + lv + '</label>' + UI.input(names[lv], { attrs: 'data-name="' + lv + '"' }).replace('<input', '<input id="name-' + lv + '"') + '</div>'
            // Buttons do what dragging does (WCAG 2.5.7); the server explains why the order is fixed.
            + UI.btn('Up', { size: 'xs', kind: 'ghost', attrs: 'data-levelmove="' + lv + ',-1" aria-label="Move ' + lv + ' up"' + (i === 0 ? ' disabled' : '') }) + UI.btn('Down', { size: 'xs', kind: 'ghost', attrs: 'data-levelmove="' + lv + ',1" aria-label="Move ' + lv + ' down"' + (i === LEVELS.length - 1 ? ' disabled' : '') }) + '</div>').join('')
          + '<span class="muted" style="font-size:12px">Levels can be renamed. Their order is fixed.</span>') + '</div></div>';

      const detail = c.engine === 'deterministic' ? (c.family === 'secrets' ? 'Private key headers, cloud key shapes, bearer token formats, Shannon entropy over 20+ character tokens' : 'Patterns with Luhn and IBAN checksums and national identifier check digits')
        : c.engine === 'guard' ? 'Profile <span class="mono">' + esc(c.profile || '') + '</span> through the gateway, categories S1 to S14'
        : c.engine === 'vision' ? 'Profile <span class="mono">' + esc(c.profile || '') + '</span> (a model that reads images) through the gateway; a score from 0 to 1 per label, answered in JSON and validated against the label set' + (c.instructions ? '. Instructions: ' + esc(c.instructions) : '')
        : c.engine === 'linear' ? 'Hashed words and word pairs, one logistic head per label' + (c.trained ? ', trained ' + esc(when(c.trained.at)) + ' on ' + c.trained.samples + ' cases' : ', not trained yet')
        : 'Profile <span class="mono">' + esc(c.profile || '') + '</span>, JSON answer with label and confidence';
      const definition = UI.panel('Definition', UI.kv([
        ['Engine', esc(ENGINE[c.engine])], ['Relative cost', COST[c.engine]], ['Version', 'v' + c.version + ' · ' + UI.pill(c.status, c.status === 'published' ? 'ok' : '')], ['Owner', esc(c.owner || '')],
        ['Label set', c.labels.map((l) => '<span class="mono">' + esc(l.label) + '</span>').join(', ')], ['Eval dataset', '<span class="mono">' + esc(c.dataset || '') + '</span> (' + Object.keys(samples).reduce((a, k) => a + samples[k], 0).toLocaleString('en-GB') + ' cases)'],
        [c.engine === 'deterministic' ? 'Detectors' : c.engine === 'linear' ? 'Features and head' : 'Model', detail],
        ['API', c.engine === 'vision' ? '<span class="mono">POST /api/classify</span> with an image (base64); knowledge bases name it to label their images; evaluation runs as a job' : '<span class="mono">POST /api/classify</span> synchronous for short text; evaluation and training run as jobs']
      ], 2) + (c.engine !== 'deterministic' ? UI.code(JSON.stringify(c.engine === 'vision' ? { classifier: c.slug, image: '<base64>', label: 'internal' } : { classifier: c.slug, text: '…', label: 'internal' }, null, 1).replace(/\n\s*/g, ' '), 'json') : '')
        + '<div class="hstack wrap">' + UI.btn(c.engine === 'vision' ? 'Add image samples' : 'Add labelled cases', { size: 'sm', attrs: 'data-addsamples' }) + (c.engine === 'linear' ? UI.btn('Train on the dataset', { size: 'sm', attrs: 'data-train', disabled: running || !canWrite }) : '') + (c.status === 'draft' ? UI.btn('Publish', { kind: 'primary', size: 'sm', attrs: 'data-publish', disabled: !canWrite }) : '') + '</div>');
      const versions = st.versions && st.versions.id === c.id ? st.versions.list : null;

      const users = (c.usage || []).map((u) => u.rule);
      const thresholds = UI.panel('Thresholds', UI.table(['Label', { label: 'Threshold', right: true }, 'Below threshold', 'Guardrail use'], c.labels.map((l) => { const t = st.thr[c.id + '/' + l.label]; return { cells: [esc(l.label), '<span class="mono">' + (t != null ? t : l.threshold).toFixed(2) + '</span>', c.engine === 'deterministic' ? 'not reported' : 'next lower label', esc(users.slice(0, 3).join(', ') + (users.length > 3 ? ' and ' + (users.length - 3) + ' more' : ''))], attrs: 'data-label="' + esc(l.label) + '"', selected: l.label === lab.label }; }), { minWidth: '0' }) + '<div class="muted" style="font-size:12px">Pick a label and tune it on the Evaluation tab. Deterministic detectors report 1.00 on a checksum match; the entropy detector scores bits per character over 7.</div>'
        + (versions ? UI.table(['Version', 'Change', 'When'], versions.map((v) => ['v' + v.version, esc(v.note || ''), esc(when(v.createdAt))]), { clickable: false, minWidth: '0' }) : ''));

      const highest = st.highest ? UI.panel('Label sources: effective label', c.labels.every((l) => LEVELS.indexOf(l.label) >= 0)
        ? '<div class="formgrid" style="--cols:2">' + UI.field('Manual label on the document', UI.select(LEVELS, st.hManual || 'internal', 'data-hmanual')) + UI.field('Inherited from the knowledge base', UI.select(LEVELS, st.hInherit || 'internal', 'data-hinherit')) + '</div>'
          + UI.field('Text for the auto-classifier', UI.textarea(st.hText || 'Q3 travel came to 412,880 EUR against a budget of 361,500 EUR. The rest is unexplained pending the CFO review.', { rows: 2, attrs: 'data-htext' })) + '<div>' + UI.btn('Classify', { size: 'sm', attrs: 'data-hrun' }) + '</div>'
          + (st.hResult ? (() => { const auto = st.hResult.hits.length ? st.hResult.hits.sort((a, b) => LEVELS.indexOf(b) - LEVELS.indexOf(a))[0] : 'public'; const all = [['Manual label on the document', st.hManual || 'internal', 'set by an editor'], ['Auto-classifier ' + c.name + ' v' + c.version, auto, 'score ' + fmt(st.hResult.scores[auto] || 0) + ' at threshold ' + fmt((c.labels.find((l) => l.label === auto) || { threshold: 0 }).threshold)], ['Inherited from the knowledge base', st.hInherit || 'internal', 'knowledge base default']]; const top = all.reduce((a, x) => (LEVELS.indexOf(x[1]) > LEVELS.indexOf(a) ? x[1] : a), 'public'); return UI.notice((new Set(all.map((x) => x[1]))).size > 1 ? 'The sources disagree. The highest wins, so the document is <b>' + esc(top) + '</b>.' : 'All three agree on <b>' + esc(top) + '</b>.', 'info') + UI.table(['Source', 'Label', 'Set by', 'Effective'], all.map((x) => [esc(x[0]), UI.label(x[1], { sm: true }), esc(x[2]), x[1] === top ? UI.pill('effective', 'ok') : '']), { clickable: false, minWidth: '0' }); })() : '')
          + '<div class="hstack">' + UI.btn('Hide', { kind: 'ghost', size: 'sm', attrs: 'data-hidehighest' }) + '</div>'
        : UI.notice('This classifier\'s labels are not the four levels, so it does not set a document\'s label. Pick a classifier labelled public, internal, confidential and restricted.', 'info', UI.btn('Hide', { kind: 'ghost', size: 'sm', attrs: 'data-hidehighest' }))) : '';
      const usage = highest + UI.panel('Used by', UI.table(['Rule set', 'Rule', 'Checkpoint', ''], (c.usage || []).map((u) => ['<b>' + esc(u.set) + '</b>', esc(u.rule), esc(u.checkpoint), UI.btn('Open', { kind: 'ghost', size: 'xs', attrs: 'data-gorule="' + esc(u.ruleId) + '"' })]), { clickable: false, minWidth: '0', emptyTitle: 'Not used yet', emptyText: 'Guardrail rules with the classifier mechanism name it by ' + c.slug + '.' }) + '<div class="muted" style="font-size:12px">Label sources are manual, auto-classifier or inherited. The highest wins. <a href="#" data-showhighest>Show an example</a></div>');

      const dist = batch && batch.message ? batch.message.replace(/^[^:]*:\s*/, '') : '';
      const batchPanel = batch ? UI.panel('Batch run: classify.batch ' + batch.jobId.slice(-6).toLowerCase(), UI.meter('Cases classified', batch.message ? batch.message.split(':')[0] : batch.state, batch.progress || 0, 'accent')
        + (dist ? '<div class="hstack wrap gap12">' + dist.split(', ').map((x) => { const i = x.lastIndexOf(' '); const l = x.slice(0, i); return '<span class="hstack gap6">' + (LEVELS.indexOf(l) >= 0 ? UI.label(l, { sm: true }) : '<span class="mono">' + esc(l) + '</span>') + '<span class="num">' + esc(x.slice(i + 1)) + '</span></span>'; }).join('') + '</div>' : '')
        + '<div class="hstack">' + (batch.state === 'succeeded' ? UI.pill('complete', 'ok') + '<span class="muted" style="font-size:12px">Precision and recall are updated on the Evaluation tab. Report only: no labels were written.</span>' + UI.btn('Close', { kind: 'ghost', size: 'sm', attrs: 'data-closebatch' })
          : batch.state === 'failed' || batch.state === 'cancelled' ? UI.pill(batch.state, 'danger') + '<span class="muted" style="font-size:12px">' + esc(batch.error || '') + '</span>' + UI.btn('Close', { kind: 'ghost', size: 'sm', attrs: 'data-closebatch' })
          : UI.pill('running', 'info') + '<span class="muted" style="font-size:12px">Lower priority than chat on the same pools. Started ' + esc(batch.started) + '.</span>' + UI.btn('Cancel', { size: 'sm', attrs: 'data-cancelbatch' })) + '</div>', { cls: 'tint' }) : '';

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .cls-left{width:300px}'
        + '#main .cls-list{display:flex;flex-direction:column;gap:2px}'
        + '#main [data-drag]{cursor:grab}#main [data-drag].over{outline:1px dashed var(--danger-fg);border-radius:4px}'
        + '</style>'
        + '<div class="leftpane cls-left"><div class="hstack"><div class="eyebrow grow">Classifiers</div>' + UI.btn('New', { size: 'sm', attrs: 'data-new' }) + '</div>'
        + '<div class="cls-list">' + st.list.map((x) => UI.listItem(esc(x.name), esc(SUB[x.engine] + (x.platform ? ', platform' : '')), { active: x.id === c.id, attrs: 'data-cls="' + x.id + '"', right: UI.pill(x.status, x.status === 'published' ? 'ok' : '') })).join('') + '</div>'
        + '<div class="divider"></div><div class="muted" style="font-size:12px">Five engines behind one registry. The same classifiers drive auto-labelling and guardrails; vision classifiers label the images in knowledge bases.</div></div>'
        + '<div class="page">'
        + UI.pagehead(c.name, esc(c.description || ''), UI.btn('Run batch classification', { attrs: 'data-batch', disabled: running }) + UI.btn(c.engine === 'vision' ? 'Test image' : 'Test text', { kind: 'primary', attrs: 'data-test' }))
        + batchPanel
        + UI.tabs([{ id: 'definition', label: 'Definition' }, { id: 'thresholds', label: 'Thresholds' }, { id: 'evaluation', label: 'Evaluation' }, { id: 'usage', label: 'Usage', count: (c.usage || []).length }], st.tab)
        + (st.tab === 'definition' ? definition : st.tab === 'thresholds' ? thresholds : st.tab === 'usage' ? usage : evalTab)
        + '</div>';

      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      live.handler = (e) => {
        if (!st.batch || st.batch.jobId !== e.id) return;
        Object.assign(st.batch, { state: e.state, progress: e.progress, message: e.message || st.batch.message, error: e.error });
        if (e.state === 'succeeded') { toast('classify.batch finished: ' + esc(st.batch.message || ''), 'ok', 6000); load(true); }
        else if (e.state === 'failed') toast('<b>classify.batch failed.</b> ' + esc(e.error || ''), 'danger', 8000);
        later();
      };
      attach();
      if (st.tab === 'thresholds' && !(st.versions && st.versions.id === c.id) && st.versionsFor !== c.id) { st.versionsFor = c.id; App.get('/api/admin/classifiers/' + enc(c.id)).then((dt) => { st.versions = { id: c.id, list: dt.versions }; later(); }).catch(() => undefined); }
      if (st.openTest) { st.openTest = false; openTest(ctx, c); }
      if (st.startBatch) { st.startBatch = false; startBatch(ctx, c, load); }

      // ---- events ----
      ctx.on('click', '[data-cls]', (e, t) => { st.sel = t.dataset.cls; st.smallWarn = false; st.highest = false; st.hResult = null; ctx.rerender(); });
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', 'tr.row[data-label]', (e, t) => { st.label = t.dataset.label; st.tab = 'evaluation'; ctx.rerender(); });
      ctx.on('input', '[data-thr]', (e, t) => { st.thr[key] = +t.value / 100; ctx.rerender(); const r = ctx.$('[data-thr]'); if (r) r.focus(); });
      ctx.on('click', '[data-savethr]', () => {
        const body = {}; body[lab.label] = thr;
        App.patch('/api/admin/classifiers/' + enc(c.id), { thresholds: body }).then((x) => { delete st.thr[key]; toast('Threshold for ' + esc(lab.label) + ' saved as v' + x.version + '. Guardrail rules using it pick up the change on their next evaluation.', 'ok'); load(true); }).catch((err) => App.fail(err, 'Threshold not saved'));
      });
      ctx.on('click', '[data-resetthr]', () => { delete st.thr[key]; ctx.rerender(); });
      ctx.on('change', '[data-name]', (e, t) => {
        const body = { names: {} }; body.names[t.dataset.name] = t.value;
        App.api('PUT', '/api/admin/label-names', body).then(() => { st.names = Object.assign({}, names); st.names[t.dataset.name] = t.value; toast('Level name saved: ' + esc(t.dataset.name) + ' is shown as "' + esc(t.value) + '".', 'ok'); }).catch((err) => App.fail(err, 'Name not saved'));
      });
      ctx.on('dragstart', '[data-drag]', (e, t) => { e.dataTransfer.effectAllowed = 'move'; st.dragging = t.dataset.drag; });
      ctx.on('dragover', '[data-drag]', (e, t) => { e.preventDefault(); t.classList.add('over'); });
      ctx.on('dragleave', '[data-drag]', (e, t) => { t.classList.remove('over'); });
      ctx.on('drop', '[data-drag]', (e, t) => {
        e.preventDefault();
        if (!st.dragging || st.dragging === t.dataset.drag) return;
        const order = LEVELS.filter((x) => x !== st.dragging); order.splice(order.indexOf(t.dataset.drag), 0, st.dragging);
        tryReorder(ctx, order);
      });
      ctx.on('click', '[data-levelmove]', (e, t) => {
        const [lv, d] = t.dataset.levelmove.split(','); const order = LEVELS.slice(); const i = order.indexOf(lv); const j = i + Number(d);
        if (i < 0 || j < 0 || j >= order.length) return;
        order.splice(i, 1); order.splice(j, 0, lv); tryReorder(ctx, order);
      });
      ctx.on('click', '[data-reorderok]', () => { st.reorder = null; ctx.rerender(); });
      ctx.on('click', '[data-test]', () => openTest(ctx, c));
      ctx.on('click', '[data-batch]', () => startBatch(ctx, c, load));
      ctx.on('click', '[data-cancelbatch]', () => App.post('/api/me/jobs/' + enc(st.batch.jobId) + '/cancel').then(() => { st.batch.state = 'cancelled'; toast('classify.batch cancelled. Metrics from the last complete run stay.', 'warn'); later(); }).catch((err) => App.fail(err)));
      ctx.on('click', '[data-closebatch]', () => { st.batch = null; ctx.rerender(); });
      ctx.on('click', '[data-showhighest]', (e) => { e.preventDefault(); st.highest = true; ctx.rerender(); });
      ctx.on('click', '[data-hidehighest]', () => { st.highest = false; st.hResult = null; ctx.rerender(); });
      ctx.on('change', '[data-hmanual]', (e, t) => { st.hManual = t.value; ctx.rerender(); });
      ctx.on('change', '[data-hinherit]', (e, t) => { st.hInherit = t.value; ctx.rerender(); });
      ctx.on('input', '[data-htext]', (e, t) => { st.hText = t.value; });
      ctx.on('click', '[data-hrun]', () => App.post('/api/classify', { classifier: c.slug, text: st.hText || ctx.$('[data-htext]').value }).then((r) => { st.hResult = r; ctx.rerender(); }).catch((err) => App.fail(err, 'Not classified')));
      ctx.on('click', '[data-gorule]', (e, t) => ctx.navigate('guardrails', { rule: t.dataset.gorule }));
      ctx.on('click', '[data-train]', () => App.post('/api/admin/classifiers/' + enc(c.id) + '/train').then((r) => { st.batch = { jobId: r.jobId, classifierId: c.id, state: 'queued', progress: 0, started: new Date().toTimeString().slice(0, 5) }; toast('Training queued on ' + esc(c.dataset || '') + '. It evaluates on the held-out fifth when done.', 'ok'); later(); }).catch((err) => App.fail(err, 'Training not started')));
      ctx.on('click', '[data-publish]', async () => {
        const ok = await ctx.confirm({ title: 'Publish classifier', tag: 'publish', tone: 'info', body: '<p style="margin:0" class="fg2">Guardrail rules and auto-labelling may use a published classifier. It needs an evaluation of this version with at least ' + MIN + ' samples per label.</p>', kv: [['Classifier', esc(c.name)], ['Version', 'v' + c.version], ['Smallest label', shortLabels.length ? esc(shortLabels[0].label) + ', ' + n(shortLabels[0].label) + ' samples' : 'every label has ' + MIN + ' or more']], ok: 'Publish' });
        if (!ok) return;
        App.post('/api/admin/classifiers/' + enc(c.id) + '/publish').then(() => { toast(esc(c.name) + ' v' + c.version + ' is published.', 'ok'); load(true); }).catch((err) => { if (err.problem && err.problem.title === 'Eval set too small') { st.smallWarn = true; st.tab = 'evaluation'; ctx.rerender(); } App.fail(err, 'Not published'); });
      });
      ctx.on('click', '[data-addsamples]', (e) => { e.preventDefault(); addSamples(ctx, c, load); });
      ctx.on('click', '[data-new]', () => ctx.modal({ title: 'New classifier', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'for example Supplier risk', attrs: 'data-n' })) + UI.field('Engine', UI.select([{ value: 'linear', label: 'Word features plus trained linear head, very low cost' }, { value: 'guard', label: 'Guard model (llama-guard3, shieldgemma, granite3-guardian), medium cost' }, { value: 'llm', label: 'General LLM with JSON output, high cost' }, { value: 'vision', label: 'Vision model scoring images, high cost' }], 'linear', 'data-e')) + UI.field('Labels', UI.input('', { placeholder: 'comma separated', attrs: 'data-l' })) + UI.field('Profile (guard, LLM and vision engines)', UI.input('', { placeholder: 'the profile that routes to the model', attrs: 'data-p' }), 'A vision classifier needs a profile whose model reads images.') + '</div>' + UI.notice('New classifiers start as drafts. They publish only after an eval run with at least ' + MIN + ' samples per label; a vision classifier\'s samples are images.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-create' }),
        onMount(m) {
          m.querySelector('[data-create]').addEventListener('click', () => {
            const body = { name: m.querySelector('[data-n]').value.trim(), engine: m.querySelector('[data-e]').value, labels: m.querySelector('[data-l]').value.split(',').map((x) => x.trim()).filter(Boolean) };
            const p = m.querySelector('[data-p]').value.trim(); if (p) body.profile = p;
            if (!body.name || !body.labels.length) { toast('Give the classifier a name and at least one label.', 'warn'); return; }
            App.post('/api/admin/classifiers', body).then((x) => { App.closeOverlay(); st.sel = x.id; st.tab = 'definition'; toast('Draft classifier created. Add labelled cases to ' + esc(x.dataset) + ', then ' + (x.engine === 'linear' ? 'train it.' : 'evaluate it.'), 'ok'); load(true); }).catch((err) => App.fail(err, 'Not created'));
          });
        } }));
    }
  });

  function tryReorder(ctx, order) {
    const st = ctx.state;
    App.api('PUT', '/api/admin/label-names', { order: order, names: {} }).then(() => { st.reorder = null; ctx.rerender(); })
      .catch((err) => { st.reorder = err.message; st.tab = 'evaluation'; ctx.rerender(); ctx.toast('Reorder refused. Level order is fixed.', 'danger'); });
  }

  function openTest(ctx, c) {
    if (c.engine === 'vision') { openImageTest(ctx, c); return; }
    const sample = SAMPLE[c.slug] || 'Q3 travel came to 412,880 EUR against a budget of 361,500 EUR. The Lisbon exception covers 38,000 EUR; the rest is unexplained pending the CFO review.';
    const render = (r) => {
      const top = r.top;
      return '<div class="vstack" style="gap:8px">' + c.labels.map((l) => { const s = r.scores[l.label] || 0; const hit = r.hits.indexOf(l.label) >= 0; return UI.meter(l.label + (hit ? ' · above threshold' : ''), s.toFixed(2), s * 100, hit ? 'accent' : ''); }).join('') + '</div>'
        + UI.notice(top ? 'Top label <b>' + esc(top.label) + '</b> at ' + top.score.toFixed(2) + '. ' + (c.engine === 'deterministic' ? 'Deterministic detectors report 1.00 on a checksum match.' : 'Scores come from the ' + esc(ENGINE[c.engine]) + '.') : 'No label scored.', 'info')
        + '<div class="muted mono" style="font-size:11px">POST /api/classify  classifier=' + esc(c.slug) + '  ' + r.ms + ' ms  v' + r.version + '</div>';
    };
    ctx.modal({ cls: 'wide', title: 'Test text: ' + esc(c.name), body: UI.field('Text', UI.textarea(sample, { rows: 4, attrs: 'data-testtext' })) + '<div data-testresult></div><div class="muted" style="font-size:12px">Synchronous for short text. Nothing here is stored or labelled.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Classify', { kind: 'primary', attrs: 'data-classify' }),
      onMount(m) {
        const out = m.querySelector('[data-testresult]');
        const run = () => { out.innerHTML = '<div class="muted">Classifying…</div>'; App.post('/api/classify', { classifier: c.slug, text: m.querySelector('[data-testtext]').value }).then((r) => { out.innerHTML = render(r); }).catch((err) => { out.innerHTML = UI.problem(err.problem && err.problem.title || 'Not classified', err.message, err.problem && err.problem.trace_id); }); };
        m.querySelector('[data-classify]').addEventListener('click', run);
        run();
      } });
  }

  /** B-8802: a vision classifier is tested with an image file; nothing is stored or labelled. */
  function openImageTest(ctx, c) {
    const render = (r) => '<div class="vstack" style="gap:8px">' + c.labels.map((l) => { const sc = r.scores[l.label] || 0; const hit = r.hits.indexOf(l.label) >= 0; return UI.meter(l.label + (hit ? ' · above threshold' : ' · below threshold'), sc.toFixed(2), sc * 100, hit ? 'accent' : ''); }).join('') + '</div>'
      + UI.notice(r.top ? 'Top label <b>' + esc(r.top.label) + '</b> at ' + r.top.score.toFixed(2) + '. Scores come from the vision model\'s JSON answer.' : 'No label scored.', 'info')
      + '<div class="muted mono" style="font-size:11px">POST /api/classify  classifier=' + esc(c.slug) + '  image  ' + r.ms + ' ms  v' + r.version + '</div>';
    ctx.modal({ cls: 'wide', title: 'Test an image: ' + esc(c.name), body: UI.field('Image', '<input type="file" class="input" accept="' + IMAGE_ACCEPT + '" data-testfile>', 'PNG, JPEG, WebP, GIF or HEIC, sent to the profile ' + esc(c.profile || '') + ' as it is. Nothing is stored or labelled.') + '<div data-testresult></div>', actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Classify', { kind: 'primary', attrs: 'data-classify' }),
      onMount(m) {
        const out = m.querySelector('[data-testresult]');
        m.querySelector('[data-classify]').addEventListener('click', async () => {
          const f = m.querySelector('[data-testfile]').files[0];
          if (!f) { out.innerHTML = UI.notice('Choose an image first.', 'warn'); return; }
          out.innerHTML = '<div class="muted">Classifying…</div>';
          try { const r = await App.post('/api/classify', { classifier: c.slug, image: await readB64(f) }); out.innerHTML = render(r); }
          catch (err) { out.innerHTML = UI.problem((err.problem && err.problem.title) || 'Not classified', err.message, err.problem && err.problem.trace_id); }
        });
      } });
  }

  /** B-8805: image cases in the eval-set format, one raw upload per image. */
  function addImageSamples(ctx, c, load) {
    ctx.modal({ title: 'Add image samples to ' + esc(c.dataset || ''), body: UI.field('Images', '<input type="file" class="input" multiple accept="' + IMAGE_ACCEPT + '" data-files>', 'PNG, JPEG, WebP, GIF or HEIC. Each image is checked by type and sealed with the tenant key.') + UI.field('Label they carry', UI.select(c.labels.map((l) => l.label).concat(['none']), c.labels[0].label, 'data-expected')) + UI.field('Data label', UI.select(LEVELS, 'internal', 'data-dlabel')) + '<div data-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add samples', { kind: 'primary', attrs: 'data-add' }),
      onMount(m) {
        m.querySelector('[data-add]').addEventListener('click', async () => {
          const files = Array.prototype.slice.call(m.querySelector('[data-files]').files || []);
          if (!files.length) { m.querySelector('[data-err]').innerHTML = UI.notice('Choose at least one image.', 'warn'); return; }
          const q = '?expected=' + enc(m.querySelector('[data-expected]').value) + '&label=' + enc(m.querySelector('[data-dlabel]').value);
          let added = 0; const failed = [];
          for (const f of files) {
            try {
              const r = await fetch('/api/admin/classifiers/' + enc(c.id) + '/samples/image' + q, { method: 'PUT', body: f, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': f.type || 'application/octet-stream', Accept: 'application/json' } });
              if (r.status === 401) { App.sessionEnded('Your session ended. Sign in again.'); return; }
              if (!r.ok) { let p = null; try { p = await r.json(); } catch (e2) { /* not JSON */ } failed.push(f.name + ': ' + ((p && (p.detail || p.title)) || r.statusText)); } else added++;
            } catch (e2) { failed.push(f.name + ': the server could not be reached.'); }
          }
          App.closeOverlay();
          if (added) ctx.toast(added + ' image sample' + (added === 1 ? '' : 's') + ' added to ' + esc(c.dataset || '') + '. Run an evaluation before publishing.', 'ok');
          if (failed.length) ctx.toast('<b>Not added.</b> ' + esc(failed.join('; ')), 'danger', 8000);
          load(true);
        });
      } });
  }

  function startBatch(ctx, c, load) {
    const st = ctx.state;
    App.get('/api/eval-sets').then((sets) => {
      const mine = sets.find((x) => x.name === c.dataset);
      ctx.modal({ title: 'Run batch classification', body: UI.field('Scope', UI.select([{ value: c.dataset || '', label: (c.dataset || 'no dataset') + ', ' + (mine ? mine.cases.toLocaleString('en-GB') : 0) + ' labelled cases' }], c.dataset || '')) + UI.field('Apply', UI.select(['Report only: precision and recall, write nothing'], 'Report only: precision and recall, write nothing')) + UI.notice('Runs as a <span class="mono">classify.batch</span> job. Progress is pushed over /ws. Cost is ' + esc(COST[c.engine].toLowerCase()) + (c.engine === 'guard' || c.engine === 'llm' ? ', one model call per case through the gateway' : '') + '. Writing labels to knowledge bases comes with them in sprint 6.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Start job', { kind: 'primary', attrs: 'data-start', disabled: !mine }),
        onMount(m) {
          m.querySelector('[data-start]').addEventListener('click', () => {
            App.post('/api/admin/classifiers/' + encodeURIComponent(c.id) + '/evaluate').then((r) => { App.closeOverlay(); st.batch = { jobId: r.jobId, classifierId: c.id, state: 'queued', progress: 0, started: new Date().toTimeString().slice(0, 5) }; ctx.rerender(); ctx.toast('classify.batch queued. Progress shows on this page.', 'ok'); poll(ctx, load); }).catch((err) => App.fail(err, 'Not started'));
          });
        } });
    }).catch((err) => App.fail(err));
  }

  /** The socket reports progress; this polls as a fallback until the job ends. */
  function poll(ctx, load) {
    const st = ctx.state; const b = st.batch;
    if (!b || (b.state !== 'queued' && b.state !== 'running')) return;
    setTimeout(() => {
      App.get('/api/me/jobs').then((jobs) => { const j = jobs.find((x) => x.id === b.jobId); if (j && st.batch === b) { const was = b.state; Object.assign(b, { state: j.state, progress: j.progress, message: j.message || b.message, error: j.error }); if (was !== 'succeeded' && j.state === 'succeeded') load(true); } })
        .catch(() => undefined).finally(() => { if (App.state.route === 'classifiers' && !document.getElementById('overlay')) ctx.rerender(); poll(ctx, load); });
    }, 2500);
  }

  function addSamples(ctx, c, load) {
    if (c.engine === 'vision') { addImageSamples(ctx, c, load); return; }
    ctx.modal({ cls: 'wide', title: 'Add labelled cases to ' + esc(c.dataset || ''), body: UI.field('Cases, one per line: label, a tab or " | ", then the text', UI.textarea('', { rows: 8, placeholder: c.labels[0].label + ' | an example that carries this label\nnone | an example that carries no label', attrs: 'data-lines' })) + UI.notice('Labels: ' + c.labels.map((l) => '<span class="mono">' + esc(l.label) + '</span>').join(', ') + ', or <span class="mono">none</span>. Cases are sealed with the tenant key. Confirmed flags add cases to their rule\'s set.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add cases', { kind: 'primary', attrs: 'data-add' }),
      onMount(m) {
        m.querySelector('[data-add]').addEventListener('click', () => {
          const items = m.querySelector('[data-lines]').value.split('\n').map((l) => { const i = l.indexOf('\t') >= 0 ? l.indexOf('\t') : l.indexOf(' | '); if (i < 0) return null; const sep = l[i] === '\t' ? 1 : 3; return { expected: l.slice(0, i).trim(), text: l.slice(i + sep).trim() }; }).filter((x) => x && x.expected && x.text);
          if (!items.length) { ctx.toast('No cases found. Put the label, a tab or " | ", then the text on each line.', 'warn'); return; }
          App.post('/api/admin/classifiers/' + encodeURIComponent(c.id) + '/samples', { items: items }).then((r) => { App.closeOverlay(); ctx.toast(r.added + ' case' + (r.added === 1 ? '' : 's') + ' added to ' + esc(c.dataset || '') + '.', 'ok'); load(true); }).catch((err) => App.fail(err, 'Cases not added'));
        });
      } });
  }
})();
