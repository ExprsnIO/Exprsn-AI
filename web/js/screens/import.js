(function () {
  const { UI, esc } = App;

  // Import (Sprint 40, B-3807): the wizard, the Imports queue and the Repositories tab, on /api/imports…
  // A model goes to the catalogue as a draft tag; a dataset to Training, Classifiers, Knowledge or the dataset store.
  const enc = encodeURIComponent;
  const STEPS = [['source', 'Source'], ['browse', 'Browse'], ['select', 'Select'], ['review', 'Review'], ['destination', 'Destination'], ['confirm', 'Confirm']];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const TARGETS = [{ id: 'training', label: 'Training dataset' }, { id: 'classifiers', label: 'Classifier eval set' }, { id: 'knowledge', label: 'Knowledge set' }, { id: 'store', label: 'Store only' }];
  const TARGET_PERM = { training: 'training:manage', classifiers: 'classifiers:manage', knowledge: 'knowledge:manage', store: null };
  const REFRESHES = [['manual', 'manual'], ['daily', 'daily'], ['weekly', 'weekly'], ['monthly', 'monthly'], ['quarterly', 'quarterly'], ['yearly', 'yearly'], ['publisher', 'follow the publisher']];
  const SPLITS = ['80 / 10 / 10', '90 / 5 / 5', '70 / 15 / 15'];
  const HARVESTS = [['', 'manual'], ['1440', 'daily'], ['10080', 'weekly'], ['43200', 'every 30 days']];
  const LIVE = ['queued', 'waiting on licence', 'queued for bundle', 'running'];
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const num = (n) => (n == null ? '' : Number(n).toLocaleString('en-GB'));
  const size = (b) => (b == null ? 'not stated' : b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' kB' : b + ' bytes');
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || false;
  const overlayOpen = () => !!document.getElementById('overlay');
  const statusKind = (s) => (s === 'reachable' ? 'ok' : s === 'disabled' || s === 'unknown' ? '' : s === 'unreachable' ? 'danger' : 'warn');
  const stateKind = (s) => (s === 'complete' ? 'ok' : s === 'refused' || s === 'failed' ? 'danger' : s === 'cancelled' || s === 'waiting on licence' ? 'warn' : 'info');
  const checkKind = (r) => (r === 'passed' ? 'ok' : r === 'refused' ? 'danger' : r === 'info' ? 'info' : 'warn');
  const slug = (s) => String(s || '').split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'dataset';
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const live = { timer: null };
  /** UI.select with [value, label] pairs as well as plain strings. */
  const pick = (options, value, attrs) => UI.select(options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o)), value, attrs);

  // The board's states, shown as an example panel over the live page (the data they need is not always there).
  const EXAMPLES = {
    gated: ['warn', 'Gated repository', 'A gated repository lists no files until the licence gate is accepted with the recorded token. Next stays disabled on the Select step until then; the acceptance is recorded with the account and the date.'],
    pickle: ['danger', 'Import refused: pickle checkpoint', 'The only weights published are a pickle checkpoint. Only GGUF and safetensors are accepted. Nothing is written and no tag is registered; the refusal stays on the Imports queue.'],
    licence: ['danger', 'Licence outside policy', 'A licence that is not on the tenant allow-list needs an exception. Request one on the Review step; the import waits in the queue until the legal-review role grants or refuses it.'],
    pii: ['warn', 'PII in the preview', 'The schema preview flags columns the detectors or the column name point at. The scrub masks what it finds before rows are stored, and the report is on the manifest; flagged columns can be dropped instead.'],
    quota: ['warn', 'Dataset over quota', 'A selection above the dataset quota, or above the rows one import keeps, is refused. Give a row limit to import a sample (the first rows in publication order) or pick a smaller configuration.'],
    rate: ['warn', 'Source rate limited', 'The source is rate limiting the staging proxy. Browsing answers from the snapshot, live search is off until the backoff ends, and queued fetches resume then.'],
    bundle: ['info', 'Air-gapped: joins the bundle', 'With no outbound path a model request joins the weekly bundle: staging fetches, scans and signs, and the import continues here after the transfer. Datasets arrive through the training staging area instead.'],
    knowledge: ['ok', 'Knowledge set created', 'A dataset becomes a knowledge set with a refresh schedule. Rows are documents with citations back to the row; every refresh shows on the Imports queue and keeps the last good rows if it fails.']
  };

  function reset(st, kind, target) {
    Object.assign(st, { tab: 'new', step: 'source', kind: kind || st.kind || 'model', repo: null, item: null, detail: null, detailError: null, preview: null, previewError: null, catalog: null, catalogKey: null, query: '', facets: {}, sel: null, form: {}, plan: null, planKey: null, planError: null, exception: null, running: null, startError: null });
    st.target = st.kind === 'model' ? 'models' : (target && target !== 'models' ? target : 'training');
  }

  /** A confirm dialog whose fields ([data-f]) are read when OK is pressed; resolves to their values or null. */
  function ask(ctx, o) {
    return new Promise((resolve) => {
      let out = null;
      ctx.modal({
        title: esc(o.title) + (o.tag ? ' ' + UI.pill(o.tag, o.tone || 'warn') : ''),
        cls: o.wide ? 'wide' : '',
        body: (o.body || '') + (o.kv ? UI.kv(o.kv, 2) : ''),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(o.ok || 'Confirm', { kind: o.tone === 'danger' ? 'danger' : 'primary', attrs: 'data-ok' }),
        onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', () => {
            out = {}; m.querySelectorAll('[data-f]').forEach((el) => { out[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; });
            App.closeOverlay();
          });
        },
        onClose() { resolve(out); }
      });
    });
  }

  App.register({
    id: 'import', title: 'Import', section: 'admin', live: true,
    summary: 'Model and dataset import wizard: browse repositories, record licence and label, register draft models, dataset versions, classifier eval sets and knowledge sets',
    crumb: (st) => ['Admin', 'Import', st.tab === 'imports' ? 'Imports' : st.tab === 'repos' ? 'Repositories' : (STEPS.find((s) => s[0] === st.step) || STEPS[0])[1]],
    commands: [
      { label: 'Import a model from a repository', sub: 'Import', run(app) { reset(app.stateFor('import'), 'model'); app.render(); } },
      { label: 'Import a dataset', sub: 'Import', run(app) { reset(app.stateFor('import'), 'dataset', 'training'); app.render(); } },
      { label: 'Create a knowledge set from a dataset', sub: 'Import', run(app) { reset(app.stateFor('import'), 'dataset', 'knowledge'); app.render(); } }
    ],
    states: [
      { title: 'Gated repository', tone: 'warn', text: 'A gated model lists no files until the licence gate is accepted with the recorded token. Next stays disabled.', apply(ctx) { reset(ctx.state, 'model'); ctx.state.example = 'gated'; ctx.rerender(); } },
      { title: 'Pickle refused', tone: 'danger', text: 'The repository publishes only a pickle checkpoint. The format check fails, nothing is written and no tag is registered.', apply(ctx) { reset(ctx.state, 'model'); ctx.state.example = 'pickle'; ctx.rerender(); } },
      { title: 'Licence outside policy', tone: 'danger', text: 'A licence outside the tenant allow list. The import waits on a licence exception from legal.', apply(ctx) { reset(ctx.state, 'dataset', 'training'); ctx.state.example = 'licence'; ctx.rerender(); } },
      { title: 'PII in the preview', tone: 'warn', text: 'The preview flags columns. The scrub masks what it finds before rows are stored.', apply(ctx) { reset(ctx.state, 'dataset', 'knowledge'); ctx.state.example = 'pii'; ctx.rerender(); } },
      { title: 'Dataset over quota', tone: 'warn', text: 'A dataset above the quota. Only a sample or a smaller configuration can be imported.', apply(ctx) { reset(ctx.state, 'dataset', 'training'); ctx.state.example = 'quota'; ctx.rerender(); } },
      { title: 'Source rate limited', tone: 'warn', text: 'The source is rate limiting the staging proxy. Browsing falls back to the snapshot and downloads queue with backoff.', apply(ctx) { reset(ctx.state, 'model'); ctx.state.example = 'rate'; ctx.rerender(); } },
      { title: 'Air-gapped: joins the bundle', tone: 'info', text: 'With no outbound path, the request joins the weekly bundle.', apply(ctx) { reset(ctx.state, 'model'); ctx.state.example = 'bundle'; ctx.rerender(); } },
      { title: 'Knowledge set created', tone: 'ok', text: 'A dataset becomes a knowledge set with a refresh schedule; rows are documents with citations back to the row.', apply(ctx) { reset(ctx.state, 'dataset', 'knowledge'); ctx.state.tab = 'imports'; ctx.state.example = 'knowledge'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (live.timer) { clearTimeout(live.timer); live.timer = null; }
      const sig = JSON.stringify(ctx.params);
      if (sig !== '{}' && sig !== st.lastParams) {
        st.lastParams = sig; const p = ctx.params;
        if (p.tab) { if (!st.step) reset(st); st.tab = p.tab; if (p.import) st.job = p.import; } else reset(st, p.kind === 'dataset' ? 'dataset' : 'model', p.target);
        st.example = null;
      }
      if (!st.tab) reset(st);
      const canRepos = App.can('imports:repositories');
      const canReview = App.can('imports:review');
      const me = App.me && App.me.user ? App.me.user : {};

      // ---------- loading ----------
      const refresh = () => {
        if (App.state.route !== 'import' || overlayOpen()) return;
        // The focused field keeps its selection, not only the caret: a poll's re-render between selecting a field's text
        // and typing over it put the caret at the start, and the typing landed in front of the old value (QA-1).
        const active = document.activeElement; const key = active && active.dataset ? (active.dataset.f || (active.hasAttribute('data-search') ? '__search' : null)) : null; const pos = key && active.selectionStart != null ? active.selectionStart : null; const end = pos != null && active.selectionEnd != null ? active.selectionEnd : pos;
        const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0;
        ctx.rerender();
        const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top;
        if (key) { const el = key === '__search' ? ctx.$('[data-search]') : ctx.$('[data-f="' + key + '"]'); if (el) { el.focus(); if (pos != null && el.setSelectionRange) { try { el.setSelectionRange(pos, end); } catch (e) { /* not a text field */ } } } }
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/imports/repositories'), App.get('/api/imports/types'), App.get('/api/imports/settings'), App.get('/api/imports?limit=100'), App.get('/api/imports/exceptions').catch(() => [])])
          .then(([repos, types, settings, q, exceptions]) => { Object.assign(st, { repos, types, settings, jobs: q.imports, counts: q.counts, exceptions, loaded: true, loadedAt: Date.now(), loadError: null }); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; refresh(); });
      };
      const reloadJobs = async () => {
        try { const q = await App.get('/api/imports?limit=100'); st.jobs = q.imports; st.counts = q.counts; st.exceptions = await App.get('/api/imports/exceptions').catch(() => st.exceptions); } catch (err) { /* the next poll tries again */ }
        refresh();
      };
      const reloadRepos = async () => { try { st.repos = await App.get('/api/imports/repositories'); } catch (err) { App.fail(err, 'Could not refresh repositories'); } refresh(); };

      if (!st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Import models and datasets', 'Browse repositories, record licence and label, and register the result in the catalogue, under Training, Classifiers or as a knowledge set')
          + (st.loadError ? UI.problem('Import could not be loaded', st.loadError.message, traceOf(st.loadError)) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : '<div class="muted" role="status">Loading repositories and imports.</div>') + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; load(); });
        if (!st.loadError) load();
        return;
      }

      // Coming back to the screen after a while: what others did since (a confirmation, a harvest, a refresh) is read again.
      if (Date.now() - (st.loadedAt || 0) > 20000 && !st.loading && !overlayOpen()) { st.loadedAt = Date.now(); load(); }

      const repoOf = (id) => st.repos.find((r) => r.id === id) || null;
      const repo = repoOf(st.repo);
      const bundle = st.settings.connectivity === 'bundle';
      const isModel = st.kind === 'model';
      const allowed = (lic) => st.settings.allowedLicences.indexOf(lic) >= 0;
      const usable = (r) => r.state === 'active' && r.kinds.indexOf(st.kind) >= 0 && (isModel ? r.modelImport : (st.types.find((t) => t.type === r.type) || {}).datasetImport);

      // ---------- wizard data ----------
      const catalogKey = () => [st.repo, st.kind, st.query, JSON.stringify(st.facets)].join('|');
      const loadCatalog = () => {
        const key = catalogKey();
        if (st.catalogKey === key || st.catalogLoading === key) return;
        st.catalogLoading = key;
        const q = '?kind=' + st.kind + '&limit=100&q=' + enc(st.query || '') + Object.keys(st.facets).filter((k) => st.facets[k]).map((k) => '&facet.' + k + '=' + enc(st.facets[k])).join('');
        App.get('/api/imports/repositories/' + st.repo + '/catalog' + q)
          .then((c) => { if (st.catalogLoading !== key) return; st.catalog = c; st.catalogError = null; st.catalogKey = key; const i = st.repos.findIndex((r) => r.id === c.repository.id); if (i >= 0) st.repos[i] = c.repository; })
          .catch((err) => { if (st.catalogLoading === key) { st.catalogError = err; st.catalogKey = key; st.catalog = null; } })
          .finally(() => { if (st.catalogLoading === key) { st.catalogLoading = null; refresh(); } });
      };
      const selectionBody = () => {
        const s = st.sel || {};
        const b = { repositoryId: st.repo, item: st.item.itemId };
        if (s.config) b.config = s.config;
        const sp = Object.keys(s.splits || {}).filter((k) => s.splits[k]); if (sp.length) b.splits = sp;
        const rs = Object.keys(s.resources || {}).filter((k) => s.resources[k]); if (rs.length) b.resources = rs;
        if (s.start) b.startPeriod = s.start;
        if (s.end) b.endPeriod = s.end;
        return b;
      };
      const loadPreview = () => {
        const body = selectionBody(); const key = JSON.stringify(body);
        if (st.previewKey === key) return;
        st.previewKey = key; st.preview = null; st.previewError = null; st.plan = null; st.planKey = null;
        App.post('/api/imports/datasets/preview', body)
          .then((p) => { if (st.previewKey !== key) return; st.preview = p; defaults(p); })
          .catch((err) => { if (st.previewKey === key) st.previewError = err; })
          .finally(() => { if (st.previewKey === key) refresh(); });
      };
      /** Destination defaults from the preview's suggestions, so the first plan is already a whole request. */
      function defaults(p) {
        const f = st.form; const cols = p.columns.map((c) => c.name); const sg = p.suggested || {};
        const text = (sg.text && sg.text[0]) || cols[0] || '';
        if (!f.name) f.name = slug(st.item.itemId);
        if (!f.promptColumn || cols.indexOf(f.promptColumn) < 0) f.promptColumn = text;
        if (f.completionColumn == null || (f.completionColumn && cols.indexOf(f.completionColumn) < 0)) f.completionColumn = sg.completion && sg.completion !== text ? sg.completion : '';
        if (!f.textColumn || cols.indexOf(f.textColumn) < 0) f.textColumn = text;
        if (!f.labelColumn || cols.indexOf(f.labelColumn) < 0) f.labelColumn = sg.label || cols[cols.length - 1] || '';
        if (!f.classifierName) f.classifierName = st.item.name || slug(st.item.itemId);
        if (!f.kbName) f.kbName = st.item.name || st.item.itemId;
        if (f.titleColumn == null || (f.titleColumn && cols.indexOf(f.titleColumn) < 0)) f.titleColumn = sg.title || '';
        if (!f.textColumns) f.textColumns = ((sg.text && sg.text.length ? sg.text : cols.slice(0, 3))).join(', ');
        if (f.metadataColumns == null) f.metadataColumns = cols.filter((c) => list(f.textColumns).indexOf(c) < 0).slice(0, 4).join(', ');
        if (f.idColumn == null) f.idColumn = sg.id || '';
      }
      const loadDetail = () => {
        const key = st.repo + '|' + st.item.itemId;
        if (st.detailKey === key) return;
        st.detailKey = key; st.detail = null; st.detailError = null; st.preview = null; st.previewKey = null;
        App.get('/api/imports/repositories/' + st.repo + (isModel ? '/item?id=' : '/dataset?id=') + enc(st.item.itemId))
          .then((d) => {
            if (st.detailKey !== key) return;
            st.detail = d;
            if (isModel) {
              const s = { variants: {}, files: {} };
              // One GGUF variant (each registers its own tag), or the safetensors files with their metadata.
              const gg = d.files.filter((f) => f.format === 'gguf'); const stf = d.files.filter((f) => f.format === 'safetensors');
              if (d.variants.length && !stf.length) s.variants[(d.variants.find((v) => /q4_k_m/i.test(v.id)) || d.variants[0]).id] = true;
              else if (stf.length) d.files.forEach((f) => { if (f.format === 'safetensors' || f.format === 'metadata') s.files[f.name] = true; });
              else if (gg.length) s.files[gg[0].name] = true;
              st.sel = s;
            } else {
              const s = { config: d.configurations.length ? d.configurations[0].id : null, splits: {}, resources: {}, sample: false, sampleRows: '1000', start: '', end: '' };
              d.splits.filter((x) => x.config === s.config).forEach((x) => { s.splits[x.id] = true; });
              const readable = d.resources.filter((r) => r.access !== 'unsupported');
              const first = readable.find((r) => r.access !== 'file') || readable.find((r) => r.format !== 'zip' && r.format !== 'xml') || readable[0];
              if (first) s.resources[first.id] = true;
              if (d.rows != null && d.quota && d.rows > d.quota.maxRows) s.sample = true;
              st.sel = s;
              if (!(d.gated && d.access !== 'granted') && (d.splits.length || first)) loadPreview();
            }
          })
          .catch((err) => { if (st.detailKey === key) st.detailError = err; })
          .finally(() => { if (st.detailKey === key) refresh(); });
      };
      const requestBody = () => {
        const f = st.form; const s = st.sel || {};
        if (isModel) {
          const b = { repositoryId: st.repo, item: st.item.itemId, label: f.label || 'internal' };
          if (st.detail && st.detail.revision && repo.type !== 'bundle') b.revision = String(st.detail.revision).slice(0, 100);
          const vs = Object.keys(s.variants || {}).filter((k) => s.variants[k]); const fs = Object.keys(s.files || {}).filter((k) => s.files[k]);
          if (repo.type === 'ollama') { if (vs.length) b.revision = vs[0]; } else if (vs.length) b.variants = vs; else if (fs.length) b.files = fs;
          if (f.tag) b.tag = f.tag;
          // 1.7.0 (B-3806): a text-classification model goes to the classifier worker: no conversion, no pool, and a
          // draft classifier over it for someone who may manage classifiers.
          const asClassifier = st.plan && st.plan.serving === 'classifier';
          if (f.quant && !asClassifier) b.quantization = f.quant;
          if (f.pool && !asClassifier) b.poolId = f.pool;
          if (asClassifier && App.can('classifiers:manage')) b.classifier = f.classifierDraftOff ? { create: false } : { name: (f.classifierDraft || '').trim() || null };
          if (f.notes) b.notes = f.notes;
          if (f.licence) b.licence = f.licence;
          if (f.attribution) b.attribution = f.attribution;
          if (st.exception) b.exception = { reason: st.exception.reason || null };
          return b;
        }
        const b = Object.assign(selectionBody(), { target: st.target, label: f.label || 'internal' });
        if (s.sample) b.sample = { rows: Math.max(1, parseInt(String(s.sampleRows).replace(/[^0-9]/g, ''), 10) || 1000) };
        if (f.dropPii && st.preview) { const d = st.preview.columns.filter((c) => c.pii).map((c) => c.name); if (d.length) b.dropColumns = d; }
        if (f.licence) b.licence = f.licence;
        if (f.attribution) b.attribution = f.attribution;
        if (st.exception) b.exception = { reason: st.exception.reason || null };
        if (st.target === 'training') { const p = (f.splits || SPLITS[0]).split('/').map((x) => parseInt(x, 10)); b.training = { name: f.name || slug(st.item.itemId), promptColumn: f.promptColumn || null, completionColumn: f.completionColumn || null, splits: { train: p[0], val: p[1], test: p[2] } }; }
        else if (st.target === 'classifiers') { b.classifier = { textColumn: f.textColumn || '', labelColumn: f.labelColumn || '', minPerLabel: Math.max(1, parseInt(f.minPerLabel, 10) || 200) }; if (f.classifier) { b.classifier.classifierId = f.classifier; b.classifier.mode = f.caseMode || 'add'; } else { b.classifier.name = f.classifierName || slug(st.item.itemId); b.classifier.engine = f.engine || 'linear'; if (f.engine && f.engine !== 'linear' && f.profile) b.classifier.profile = f.profile; } }
        else if (st.target === 'knowledge') { b.knowledge = { titleColumn: f.titleColumn || null, textColumns: list(f.textColumns), metadataColumns: list(f.metadataColumns), idColumn: f.idColumn || null, groupBy: f.docMode === 'group' ? (f.groupBy || null) : null, refresh: f.refresh || 'manual' }; if (!b.knowledge.textColumns.length) b.knowledge.textColumns = [f.textColumn || '']; if (f.kb) b.knowledge.knowledgeBaseId = f.kb; else { b.knowledge.name = f.kbName || st.item.name || st.item.itemId; b.knowledge.embedModel = f.embedModel || ((st.opts && st.opts.embedding && st.opts.embedding[0]) || {}).name || null; if (f.workspace) b.knowledge.workspaceId = f.workspace; } }
        else b.store = Object.assign({ name: f.name || slug(st.item.itemId) }, f.retention ? { retentionDays: parseInt(f.retention, 10) } : {});
        return b;
      };
      const loadPlan = () => {
        const body = requestBody(); const key = JSON.stringify(body);
        if (st.planKey === key) return;
        st.planKey = key; st.planError = null;
        App.post(isModel ? '/api/imports/plan' : '/api/imports/datasets/plan', body)
          .then((p) => { if (st.planKey === key) st.plan = p; })
          .catch((err) => { if (st.planKey === key) { st.planError = err; st.plan = null; } })
          .finally(() => { if (st.planKey === key) refresh(); });
      };
      /** What the destination forms offer: knowledge bases, embedding models, workspaces, classifiers, pools. */
      const loadOpts = () => {
        if (st.opts || st.optsLoading) return;
        st.optsLoading = true;
        const maybe = (perm, url) => (App.can(perm) ? App.get(url).catch(() => null) : Promise.resolve(null));
        Promise.all([maybe('knowledge:read', '/api/knowledge/models'), maybe('knowledge:read', '/api/knowledge/bases'), maybe('knowledge:read', '/api/knowledge/principals'), maybe('classifiers:manage', '/api/admin/classifiers'), maybe('pools:manage', '/api/admin/pools')])
          .then(([models, bases, principals, classifiers, pools]) => { st.opts = { embedding: models ? (models.embedding || []).filter((m) => m.state === 'approved') : [], bases: (bases || []).filter((k) => k.access === 'manage' || k.access == null), workspaces: principals ? principals.workspaces || [] : [], classifiers: (classifiers || []).filter((c) => !c.platform && c.engine !== 'vision'), pools: Array.isArray(pools) ? pools : (pools && pools.pools) || [] }; })
          .finally(() => { st.optsLoading = false; refresh(); });
      };

      if (st.tab === 'new') {
        if (st.step === 'browse' && st.repo) loadCatalog();
        if ((st.step === 'select' || st.step === 'review' || st.step === 'destination' || st.step === 'confirm') && st.item) loadDetail();
        if ((st.step === 'review' || st.step === 'destination' || st.step === 'confirm') && st.detail && (isModel || st.preview)) { loadOpts(); if (!st.running) loadPlan(); }
      }

      const d = st.detail; const plan = st.plan;
      const checks = plan ? plan.checks : [];
      // The Destination check belongs to its own step; the Review step gates on the rest.
      const policyBlocked = checks.some((c) => c.result === 'refused' && c.name !== 'Destination');
      const licence = plan ? plan.licence : null;
      const needsLicence = !!licence && !licence.allowed && !licence.needsException;
      const needsException = !!licence && licence.needsException && !st.exception;
      const gateOpen = isModel && d && d.gated && d.access !== 'granted';

      // ---------- steps ----------
      function stepSource() {
        const repos = st.repos.filter((r) => r.kinds.indexOf(st.kind) >= 0 && r.state !== 'rejected');
        const card = (r) => '<button type="button" class="imp-repo' + (st.repo === r.id ? ' on' : '') + (usable(r) ? '' : ' off') + '" data-repo="' + esc(r.id) + '" aria-pressed="' + (st.repo === r.id ? 'true' : 'false') + '">'
          + '<span class="hstack"><b class="grow">' + esc(r.name) + '</b>' + UI.pill(r.state === 'pending' ? 'waiting for confirmation' : r.status, r.state === 'pending' ? 'warn' : statusKind(r.status)) + '</span>'
          + '<span class="muted" style="font-size:12px">' + esc(r.host) + ' · ' + esc(r.region) + '</span>'
          + '<span class="fg2" style="font-size:12px">' + (r.snapshotAt ? num(r.snapshotItems) + ' in the snapshot of ' + esc(when(r.snapshotAt)) : 'no snapshot yet') + '</span>'
          + '<span class="hstack gap4 wrap">' + r.kinds.map((k) => UI.pill(k === 'model' ? 'models' : 'datasets', 'outline')).join('') + '</span></button>';
        return '<div class="vstack gap12">'
          + '<div class="hstack wrap gap12"><span class="fg2">What are you importing?</span>' + UI.seg([{ id: 'model', label: 'A model' }, { id: 'dataset', label: 'A dataset' }], st.kind, 'data-kindseg') + '<span class="muted" style="font-size:12px">' + repos.length + ' ' + (repos.length === 1 ? 'repository offers ' : 'repositories offer ') + (isModel ? 'models' : 'datasets') + '. Catalogue snapshots come through the staging proxy; live search needs a reachable source.</span></div>'
          + (repos.length ? '<div class="imp-repos">' + repos.map(card).join('') + '</div>' : UI.empty('No repository offers ' + (isModel ? 'models' : 'datasets') + ' yet', 'A model admin adds repositories on the Repositories tab; a second admin confirms each before it is harvested.', UI.btn('Open Repositories', { size: 'sm', attrs: 'data-gotab="repos"' })))
          + (bundle && !isModel ? UI.notice('This instance is air-gapped, so a dataset is not fetched from its source. Datasets arrive as JSON Lines in the training staging area and are registered under Training.', 'info') : '')
          + '</div>';
      }

      function stepBrowse() {
        const c = st.catalog;
        if (st.catalogError) return UI.problem('The catalogue could not be read', st.catalogError.message, traceOf(st.catalogError));
        if (!c) return '<div class="muted" role="status">Reading the catalogue of ' + esc(repo.name) + '.</div>';
        const facetCol = '<div class="imp-facets">' + c.facets.map((f) => '<div class="vstack gap4"><div class="eyebrow">' + esc(f.label) + '</div>' + f.values.slice(0, 12).map((v) => '<button type="button" class="listlink' + (v.selected ? ' active' : '') + '" aria-pressed="' + (v.selected ? 'true' : 'false') + '" data-facet="' + esc(f.key) + '" data-v="' + esc(v.value) + '"><span><span class="t" style="font-weight:500">' + esc(v.value) + '</span></span><span class="muted num" style="font-size:12px">' + v.count + '</span></button>').join('') + '</div>').join('') + '</div>';
        const chips = Object.keys(st.facets).filter((k) => st.facets[k]).map((k) => UI.chip(esc(k) + ': ' + esc(st.facets[k]) + ' <span class="x" aria-hidden="true">×</span>', true, 'data-clearfacet="' + esc(k) + '" aria-label="Clear the filter ' + esc(k) + '"')).join('');
        const sel = st.item ? st.item.itemId : null;
        const lic = (m) => UI.pill(m.licence || 'unknown', m.licenceAllowed ? 'ok' : m.licence === 'unknown' || m.licence === 'other' || !m.licence ? 'warn' : 'danger');
        const table = isModel
          ? UI.table(['Repository', 'Classification', 'Formats', 'Licence', 'Size', 'Updated', 'Access'], c.items.map((m) => ({ cells: ['<span class="mono">' + esc(m.itemId) + '</span>' + (m.publisher ? '<div class="muted" style="font-size:12px">' + esc(m.publisher) + '</div>' : ''), esc(m.classification || ''), esc(m.formats.join(', ')), lic(m), esc(m.sizeBytes == null ? '' : size(m.sizeBytes)), esc((m.updated || '').slice(0, 10)), m.gated ? UI.pill('gated', 'warn') : UI.pill('open', 'ok')], selected: sel === m.itemId, attrs: 'data-item="' + esc(m.itemId) + '"' })), { emptyTitle: 'No models match', emptyText: 'Clear a filter or change the search.', minWidth: '0' })
          : UI.table(['Dataset', 'Publisher', 'Classification', 'Formats', 'Licence', 'Updates'], c.items.map((m) => ({ cells: ['<b>' + esc(m.name) + '</b><div class="mono muted" style="font-size:11px">' + esc(m.itemId) + '</div>', esc(m.publisher || ''), esc(m.classification || ''), esc(m.formats.join(', ')), lic(m), esc(((m.facets || {}).updates || [])[0] || '')], selected: sel === m.itemId, attrs: 'data-item="' + esc(m.itemId) + '"' })), { emptyTitle: 'No datasets match', emptyText: 'Clear a filter or change the search.', minWidth: '0' });
        return '<div class="vstack gap12">'
          + (repo.status === 'rate limited' ? UI.notice('<b>' + esc(repo.name) + '</b> is rate limiting the staging proxy. Showing the snapshot' + (repo.snapshotAt ? ' from ' + esc(when(repo.snapshotAt)) : '') + '; live search is off until ' + esc(when(repo.backoffUntil)) + '.', 'warn', UI.btn('Retry', { size: 'sm', attrs: 'data-retry' })) : repo.status === 'needs token' ? UI.notice('<b>' + esc(repo.name) + '</b> needs a credential the tenant has not recorded. Fetches are refused until one is added under Repositories.', 'warn', UI.btn('Open Repositories', { size: 'sm', attrs: 'data-gotab="repos"' })) : '')
          + '<div class="toolbar">' + UI.search('Search ' + repo.name, 'data-search', st.query) + UI.btn('Search', { size: 'sm', attrs: 'data-dosearch' }) + chips + '<span class="muted right" style="font-size:12px">' + c.items.length + ' of ' + num(c.total) + ' · ' + (c.source === 'live' ? 'live search' : 'snapshot') + '</span></div>'
          + (c.source !== 'live' && c.liveReason && st.query ? '<div class="muted" style="font-size:12px">' + esc(c.liveReason) + '</div>' : '')
          + '<div class="imp-browse">' + facetCol + '<div class="vstack gap6" style="min-width:0">' + table + '</div></div></div>';
      }

      function stepSelect() {
        if (st.detailError) return UI.problem((isModel ? 'The model' : 'The dataset') + ' could not be read from the source', st.detailError.message, traceOf(st.detailError)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-redetail' }) + '</div>';
        if (!d) return '<div class="muted" role="status">Reading ' + esc(st.item.itemId) + ' from ' + esc(repo.name) + '.</div>';
        const s = st.sel;
        if (isModel) {
          let body = '<div class="vstack gap12">';
          if (gateOpen) body += UI.notice('<b>' + esc(d.itemId) + '</b> is gated. Files cannot be fetched until the licence gate is accepted on ' + esc(repo.host) + ' with the recorded token.', 'warn', UI.btn('Accept gate with recorded token', { size: 'sm', attrs: 'data-gate', disabled: bundle }));
          if (d.variants.length) body += '<div class="vstack gap6"><div class="eyebrow">' + (repo.type === 'ollama' ? 'Tags to pull' : 'GGUF variants to register') + '</div>' + UI.table([{ label: 'Pick', width: '44px' }, 'Variant', 'Quantization', 'Size', 'Digest'], d.variants.map((v) => ({ cells: [UI.check('', !!s.variants[v.id], 'data-pickv="' + esc(v.id) + '" aria-label="Variant ' + esc(v.id) + '"' + (gateOpen ? ' disabled' : '')), '<span class="mono">' + esc(v.id) + '</span>', esc(v.quantization || ''), esc(size(v.size)), '<span class="mono muted" style="font-size:12px">' + esc((v.digest || '').slice(0, 19)) + '</span>'] })), { clickable: false, minWidth: '0' }) + '</div>';
          const files = d.files.filter((f) => f.format !== 'manifest');
          if (files.length && repo.type !== 'ollama') body += '<div class="vstack gap6"><div class="eyebrow">Repository files, revision ' + esc(String(d.revision || '').slice(0, 12)) + '</div>' + UI.table([{ label: 'Pick', width: '44px' }, 'File', 'Format', 'Size', 'Status'], files.map((f) => ({ cells: [UI.check('', !!s.files[f.name], 'data-pickf="' + esc(f.name) + '" aria-label="File ' + esc(f.name) + '"' + (gateOpen || f.format === 'pickle' || f.format === 'onnx' || f.format === 'other' ? ' disabled' : '')), '<span class="mono">' + esc(f.name) + '</span>', esc(f.format), esc(size(f.size)), f.format === 'pickle' ? UI.pill('pickle, refused', 'danger') : f.format === 'onnx' || f.format === 'other' ? UI.pill('not imported', '') : UI.pill('accepted', 'ok')] })), { clickable: false, minWidth: '0' }) + '</div>';
          if (d.files.some((f) => f.format === 'pickle') && !d.files.some((f) => f.format === 'gguf' || f.format === 'safetensors')) body += UI.problem('Import refused: pickle checkpoint', 'The only weights published are pickle checkpoints. Only GGUF and safetensors are accepted. Nothing is written and no tag is registered. Ask the publisher for safetensors or pick a mirror that has them.', false);
          else if (d.classification === 'text-classification' && repo.type !== 'ollama') body += UI.notice('A text-classification model is served as published by the classifier worker: safetensors weights with the configuration and tokenizer files in the repository\'s root, no conversion. It registers as a draft model pinned by its digest, and a classifier can be made over it.', 'info');
          else if (Object.keys(s.files).some((k) => s.files[k] && /\.safetensors$/i.test(k))) body += UI.notice('Safetensors are converted to GGUF on the training pool. Choose a quantization under Destination; the result registers as a draft tag with its own digest.', 'info');
          return body + '</div>';
        }
        const pv = st.preview; const flagged = pv ? pv.columns.filter((c) => c.pii) : [];
        const mine = d.splits.filter((x) => x.config === s.config);
        const over = d.quota && ((d.sizeBytes != null && d.sizeBytes > d.quota.maxBytes - d.quota.usedBytes) || (d.rows != null && d.rows > d.quota.maxRows));
        return '<div class="vstack gap12">'
          + (d.gated ? (d.access === 'granted' ? UI.notice('<b>' + esc(d.itemId) + '</b> is gated. The recorded token reads its Parquet files from ' + esc(repo.host) + ' itself; the dataset viewer never receives the token.', 'info') : UI.problem('Gated dataset', 'The hub lists no files of this dataset for the repository token. Record a token for the repository and accept the dataset\'s terms on ' + repo.host + ' with that account; it can be imported then.', false)) : '')
          + (over && !s.sample ? UI.notice('<b>' + esc(d.name) + '</b> is ' + (d.rows != null ? num(d.rows) + ' rows' : esc(size(d.sizeBytes))) + ', above what one import may keep (' + esc(size(d.quota.maxBytes - d.quota.usedBytes)) + ' of quota left, ' + num(d.quota.maxRows) + ' rows). Import a sample, or pick a smaller configuration.', 'warn', UI.btn('Import a sample instead', { size: 'sm', attrs: 'data-sample' })) : '')
          + '<div class="formgrid" style="--cols:3">'
          + (d.configurations.length ? UI.field(repo.type === 'sdmx' ? 'Series key' : 'Configuration', repo.type === 'sdmx' ? UI.input(s.config === 'all' ? '' : s.config || '', { placeholder: 'all series, or M.I15.CP00.EA20', attrs: 'data-s="config"' }) : pick(d.configurations.map((c) => c.id), s.config, 'data-s="config"'), repo.type === 'sdmx' ? 'Dimension values joined by dots; empty for every series' : d.configurations.length + (d.configurations.length === 1 ? ' configuration published' : ' configurations published')) : '')
          + UI.field('Row limit', s.sample ? UI.input(s.sampleRows, { attrs: 'data-s="sampleRows" inputmode="numeric"' }) : UI.input('all rows', { readonly: true }), s.sample ? 'The first rows in publication order' : 'Every row of the selection')
          + UI.field('Sample', '<div style="height:30px;display:flex;align-items:center">' + UI.toggle('Sample rows only', !!s.sample, 'data-sampletoggle data-manual') + '</div>')
          + (repo.type === 'sdmx' ? UI.field('From period', UI.input(s.start, { placeholder: '2020-01', attrs: 'data-s="start"' })) + UI.field('To period', UI.input(s.end, { placeholder: 'now', attrs: 'data-s="end"' })) : '')
          + '</div>'
          + (mine.length ? '<div class="vstack gap6"><div class="eyebrow">Splits</div>' + UI.table([{ label: 'Pick', width: '44px' }, 'Split', 'Rows'], mine.map((x) => ({ cells: [UI.check('', !!s.splits[x.id], 'data-picks="' + esc(x.id) + '" aria-label="Split ' + esc(x.id) + '"'), '<span class="mono">' + esc(x.id) + '</span>', x.rows == null ? '<span class="muted">not stated</span>' : num(x.rows)] })), { clickable: false, minWidth: '0' }) + '</div>' : '')
          + (d.resources.length ? '<div class="vstack gap6"><div class="eyebrow">Resources</div>' + UI.table([{ label: 'Pick', width: '44px' }, 'Resource', 'Format', 'Size', 'How it is read'], d.resources.map((r) => ({ cells: [UI.check('', !!s.resources[r.id], 'data-pickr="' + esc(r.id) + '" aria-label="Resource ' + esc(r.name) + '"' + (r.access === 'unsupported' ? ' disabled' : '')), '<span class="mono">' + esc(r.name) + '</span>', esc(r.format), esc(r.access === 'file' || r.access === 'unsupported' ? size(r.size) : 'streamed'), r.access === 'unsupported' ? UI.pill('not read', '') + ' <span class="muted" style="font-size:12px">' + esc(r.note || '') + '</span>' : '<span class="fg2">' + esc(r.note || (r.access === 'file' ? 'downloaded and parsed' : r.access)) + '</span>'] })), { clickable: false, minWidth: '0' }) + '</div>' : '')
          + '<div class="vstack gap6"><div class="eyebrow">Schema preview' + (pv ? ', first ' + num(pv.rows) + ' rows' : '') + '</div>'
          + (st.previewError ? UI.problem('The preview could not be read', st.previewError.message, traceOf(st.previewError)) : !pv ? (d.gated && d.access !== 'granted' ? '' : '<div class="muted" role="status">Reading the first rows.</div>') : UI.table(['Column', 'Type', 'Sample value', 'PII'], pv.columns.map((c) => ['<b>' + esc(c.name) + '</b>', esc(c.type), '<span class="fg2">' + esc(c.sample == null ? '' : c.sample) + '</span>', c.pii ? UI.pill(c.pii, 'warn') : '<span class="muted">none</span>']), { clickable: false, minWidth: '0', emptyTitle: 'No rows', emptyText: 'The selection has no rows.' }))
          + (flagged.length ? UI.notice(flagged.length + (flagged.length > 1 ? ' columns' : ' column') + ' flagged. The scrub masks what the detectors find before rows are stored; flagged columns can be dropped under Destination.', 'warn') : '') + '</div></div>';
      }

      const checksTable = (rows) => UI.table(['Check', 'Result', 'Detail'], rows.map((c) => ['<b>' + esc(c.name) + '</b>', UI.pill(c.result, checkKind(c.result)), '<span class="fg2">' + esc(c.detail) + '</span>']), { clickable: false, minWidth: '0' });
      const planWait = () => (st.planError ? UI.problem('The checks could not be run', st.planError.message, traceOf(st.planError)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-replan' }) + '</div>' : '<div class="muted" role="status">Running the checks.</div>');

      function stepReview() {
        if (!plan) return planWait();
        const f = st.form;
        const form = '<div class="formgrid" style="--cols:3">'
          + UI.field('Licence recorded on the manifest', needsLicence || licence.recorded ? UI.input(f.licence || '', { placeholder: 'apache-2.0, cc-by-4.0…', attrs: 'data-f="licence" data-replanon' }) : UI.input(licence.id, { readonly: true }), needsLicence || licence.recorded ? 'The source states none; record what its card says' : 'Read from ' + licence.source)
          + UI.field('Max classification label', pick(LABELS.slice(0, Math.max(1, LABELS.indexOf(me.clearance || 'internal') + 1)), f.label || 'internal', 'data-f="label"'), isModel ? 'Highest data label the model may serve' : 'Label floor for the rows and documents created from it')
          + UI.field('Attribution', UI.input(f.attribution || '', { placeholder: (st.item.publisher ? st.item.publisher + ', ' : '') + repo.name, attrs: 'data-f="attribution" maxlength="500"' }), 'Recorded on the manifest')
          + '</div>' + (licence.needsException ? '<div class="hstack wrap gap12">' + UI.btn(st.exception ? 'Exception will be requested' : 'Request licence exception', { size: 'sm', attrs: 'data-exception', disabled: !!st.exception }) + (st.exception ? '<span class="fg2" style="font-size:12px">The import is queued and waits for the legal-review role to decide.</span>' : '') + '</div>' : '');
        const sel = isModel ? (plan.variant ? plan.variant : '') + (plan.selected && plan.selected.length ? (plan.variant ? '; ' : '') + plan.selected.length + ' files' : '') : (plan.selection.splits.length ? plan.selection.splits.join(', ') + (plan.selection.config ? ' · ' + plan.selection.config : '') : plan.selection.resources.map((r) => r.name).join(', '));
        return '<div class="vstack gap12">'
          + checksTable(checks.filter((c) => c.name !== 'Destination'))
          + (policyBlocked ? UI.notice('A check is failing. Fix it or go back and change the selection; Next stays disabled.', 'danger') : needsLicence ? UI.notice('Record the licence to continue.', 'warn') : needsException ? UI.notice('This licence is outside the tenant allow list. Request an exception to continue; the import then waits in the queue for legal review.', 'warn') : '')
          + UI.panel('Licence and label', form)
          + UI.panel('What will be fetched', UI.kv([['Source', esc(repo.name) + (plan.revision ? ', ' + esc(String(plan.revision).slice(0, 19)) : '')], ['Items', esc(sel || 'nothing yet')], ['Size', esc(plan.sizeBytes ? size(plan.sizeBytes) : isModel ? size(0) : 'not stated by the source') + (plan.sample ? ' (sample of ' + num(plan.sample) + ' rows)' : '')], ['Digests', isModel ? 'pinned at request time; the fetched file must match' : 'sha256 of the rows kept, recorded on the manifest']], 2))
          + '</div>';
      }

      function stepDestination() {
        if (!plan) return planWait();
        const f = st.form; const o = st.opts || {};
        const dest = checks.find((c) => c.name === 'Destination');
        const destNote = dest ? UI.notice('<b>' + esc(plan.creates || plan.tag || '') + '</b> ' + esc(dest.detail), dest.result === 'refused' ? 'danger' : dest.result === 'passed' ? 'info' : 'warn') : '';
        if (isModel && plan.serving === 'classifier') {
          // 1.7.0 (B-3806): the classifier worker serves it; the catalogue keeps its digest, licence, label and approval.
          const may = App.can('classifiers:manage');
          return '<div class="vstack gap12">'
            + UI.notice('Registers in the <b>Model catalog</b> as a draft classifier model, served by the classifier worker as published. Its evaluation and approval are under Models; a classifier that uses it publishes once it is approved.', 'info')
            + '<div class="formgrid" style="--cols:3">'
            + UI.field('Tag', UI.input(f.tag || plan.tag, { attrs: 'data-f="tag" data-replanon maxlength="200"' }), 'The name the model has in the catalogue')
            + (may ? UI.field('Draft classifier', UI.input(f.classifierDraft || '', { attrs: 'data-f="classifierDraft" maxlength="100"' + (f.classifierDraftOff ? ' disabled' : ''), placeholder: 'named after the tag' }), 'Made over the model with its labels, under Classifiers') + UI.field('Classifier', pick([['', 'create a draft classifier'], ['off', 'do not create one']], f.classifierDraftOff ? 'off' : '', 'data-f="classifierDraftOff"'), 'One can be created later under Classifiers') : '')
            + UI.field('Notes', UI.input(f.notes || '', { attrs: 'data-f="notes" maxlength="1000"' }), 'Shown on the model in the catalogue')
            + '</div>' + (may ? '' : UI.notice('You do not hold classifiers:manage, so only the model is registered. Someone who does creates the classifier under Classifiers, engine "Imported model".', 'warn')) + destNote + '</div>';
        }
        if (isModel) {
          const pools = (o.pools || []).map((p) => [p.id, p.name]);
          return '<div class="vstack gap12">'
            + UI.notice('Registers in the <b>Model catalog</b> as a draft tag. Evaluation, approval and placement follow the usual lifecycle.', 'info')
            + '<div class="formgrid" style="--cols:3">'
            + UI.field('Tag', UI.input(f.tag || plan.tag, { attrs: 'data-f="tag" data-replanon maxlength="200"' }), 'The tag the gateway resolves')
            + (plan.conversion.needed && plan.conversion.quantization !== 'as-is' ? UI.field('Convert to GGUF', pick(['Q4_K_M', 'Q5_K_M', 'Q8_0', 'F16'], f.quant || plan.conversion.quantization || 'Q4_K_M', 'data-f="quant"'), 'Converted and quantized on the training pool') : '')
            + (pools.length ? UI.field('Pull onto pool', pick([['', 'none, place it later']].concat(pools), f.pool || '', 'data-f="pool"'), 'Placed and pulled once the draft is registered') : '')
            + UI.field('Notes', UI.input(f.notes || '', { attrs: 'data-f="notes" maxlength="1000"' }), 'Shown on the model in the catalogue')
            + '</div>' + destNote + '</div>';
        }
        const cols = st.preview ? st.preview.columns.map((c) => c.name) : [];
        const none = [['', 'none']].concat(cols.map((c) => [c, c]));
        const flagged = st.preview ? st.preview.columns.filter((c) => c.pii).length : 0;
        const noPerm = TARGET_PERM[st.target] && !App.can(TARGET_PERM[st.target]);
        let form = '';
        if (st.target === 'training') form = '<div class="formgrid" style="--cols:3">'
          + UI.field('Dataset name', UI.input(f.name || '', { attrs: 'data-f="name" data-replanon maxlength="63"' }), 'A new version of this name is registered under Training')
          + UI.field('Prompt or text column', pick(cols, f.promptColumn, 'data-f="promptColumn"'))
          + UI.field('Response or label column', pick(none, f.completionColumn || '', 'data-f="completionColumn"'), 'None: the rows are text only')
          + UI.field('Splits', pick(SPLITS, f.splits || SPLITS[0], 'data-f="splits"'), 'Train, validation and test, in percent')
          + '</div>';
        else if (st.target === 'classifiers') form = '<div class="formgrid" style="--cols:3">'
          + UI.field('Classifier', pick([['', 'New classifier']].concat((o.classifiers || []).map((c) => [c.id, c.name])), f.classifier || '', 'data-f="classifier"'))
          + (f.classifier ? UI.field('Existing cases', pick([['add', 'add to the eval set'], ['replace', 'replace the eval set']], f.caseMode || 'add', 'data-f="caseMode"')) : UI.field('Name', UI.input(f.classifierName || '', { attrs: 'data-f="classifierName" data-replanon maxlength="100"' })) + UI.field('Engine', pick([['linear', 'embedding and linear head'], ['llm', 'model with a JSON answer'], ['guard', 'guard model']], f.engine || 'linear', 'data-f="engine"')) + (f.engine && f.engine !== 'linear' ? UI.field('Profile', UI.input(f.profile || '', { attrs: 'data-f="profile" data-replanon maxlength="63"' }), 'The profile that routes to its model') : ''))
          + UI.field('Text column', pick(cols, f.textColumn, 'data-f="textColumn"'))
          + UI.field('Label column', pick(cols, f.labelColumn, 'data-f="labelColumn"'))
          + UI.field('Minimum samples per label', UI.input(f.minPerLabel || '200', { attrs: 'data-f="minPerLabel" inputmode="numeric"' }), 'Labels below it are reported with the import')
          + '</div>' + UI.notice('The rows become the evaluation set. A linear head is trained and measured by a job the import queues; the classifier stays a draft under Classifiers.', 'info');
        else if (st.target === 'knowledge') form = '<div class="formgrid" style="--cols:3">'
          + UI.field('Knowledge base', pick([['', 'New knowledge base']].concat((o.bases || []).map((k) => [k.id, k.name])), f.kb || '', 'data-f="kb"'))
          + (f.kb ? '' : UI.field('Knowledge set name', UI.input(f.kbName || '', { attrs: 'data-f="kbName" data-replanon maxlength="200"' })) + UI.field('Embedding model', pick((o.embedding || []).map((m) => m.name), f.embedModel || ((o.embedding || [])[0] || {}).name || '', 'data-f="embedModel"'), (o.embedding || []).length ? 'Approved embedding models' : 'No approved embedding model in the catalogue') + UI.field('Workspace', pick([['', 'Tenant-wide']].concat((o.workspaces || []).map((w) => [w.id, w.name])), f.workspace || '', 'data-f="workspace"')))
          + UI.field('Document body', pick([['row', 'one document per row'], ['group', 'group rows by a column']], f.docMode || 'row', 'data-f="docMode"'))
          + (f.docMode === 'group' ? UI.field('Group by', pick(cols, f.groupBy || cols[0], 'data-f="groupBy"')) : '')
          + UI.field('Title column', pick(none, f.titleColumn || '', 'data-f="titleColumn"'))
          + UI.field('Text columns', UI.input(f.textColumns || '', { attrs: 'data-f="textColumns" data-replanon' }), 'Embedded and searchable; comma separated')
          + UI.field('Metadata columns', UI.input(f.metadataColumns || '', { attrs: 'data-f="metadataColumns" data-replanon' }), 'Shown with the cited row')
          + UI.field('Row id column', pick(none, f.idColumn || '', 'data-f="idColumn"'), 'None: the id the source gives the row, or its position')
          + UI.field('Refresh schedule', pick(REFRESHES.map((r) => (r[0] === 'publisher' ? ['publisher', 'follow the publisher' + (d && d.updates ? ' (' + d.updates + ')' : '')] : r)), f.refresh || 'manual', 'data-f="refresh"'), 'Fetch, scrub and re-index again on this cadence')
          + '</div>';
        else form = '<div class="formgrid" style="--cols:3">' + UI.field('Dataset name', UI.input(f.name || '', { attrs: 'data-f="name" data-replanon maxlength="63"' })) + UI.field('Retention', pick([['', 'keep'], ['90', '90 days'], ['365', '1 year']], f.retention || '', 'data-f="retention"')) + '</div>' + UI.notice('Stored sealed with its manifest and hash only. Nothing is scrubbed or indexed.', 'info');
        return '<div class="vstack gap12">'
          + '<div class="hstack wrap gap12"><span class="fg2">Create</span>' + UI.seg(TARGETS, st.target, 'data-targetseg') + '</div>'
          + (noPerm ? UI.notice('Creating a ' + esc(TARGETS.find((t) => t.id === st.target).label.toLowerCase()) + ' needs <span class="mono">' + esc(TARGET_PERM[st.target]) + '</span>, which your roles do not grant.', 'warn') : '')
          + form
          + (st.target !== 'store' && flagged ? '<div class="hstack wrap gap12">' + UI.check('Drop the ' + flagged + ' flagged PII ' + (flagged > 1 ? 'columns' : 'column') + ' instead of masking', !!f.dropPii, 'data-f="dropPii"') + '</div>' : '')
          + destNote + '</div>';
      }

      const resultRoute = (j) => {
        const r = j.result || {};
        return j.kind === 'model' ? ['models', j.model ? { model: j.model.name } : {}] : r.knowledge ? ['knowledge', { kb: r.knowledge.kbId }] : r.classifier ? ['classifiers', { classifier: r.classifier.id }] : r.training ? ['training', {}] : null;
      };
      const jobTarget = (j) => {
        const r = j.result || {};
        return j.kind === 'model' ? 'Models, draft tag ' + ((j.options && j.options.tag) || '') + (r.classifier ? '; draft classifier ' + r.classifier.name : '') : r.training ? 'Training dataset ' + r.training.name + ' v' + r.training.version : r.classifier ? 'Classifier eval set: ' + r.classifier.name : r.knowledge ? 'Knowledge set: ' + r.knowledge.name : r.store ? 'Dataset store: ' + r.store.name : (TARGETS.find((t) => t.id === j.target) || { label: j.target }).label + (j.options && j.options.knowledge ? ': ' + j.options.knowledge.name : j.options && j.options.training ? ' ' + j.options.training.name : '');
      };
      const timeline = (j) => UI.timeline((j.log || []).map((l) => ({ title: esc(l.title), text: esc(l.meta || ''), meta: esc(when(l.at)), tone: l.tone === 'danger' ? 'danger' : l.tone === 'warn' ? 'warn' : l.tone === 'ok' ? 'ok' : '' })));

      function stepConfirm() {
        const job = st.running ? st.jobs.find((j) => j.id === st.running) : null;
        if (!plan && !job) return planWait();
        const f = st.form;
        let body = '';
        if (plan) body += UI.kv([['Source', esc(repo.name) + ', ' + esc(st.item.itemId)], ['Creates', esc(isModel ? 'Models: draft tag ' + plan.tag : plan.creates)], ['Size', esc(plan.sizeBytes ? size(plan.sizeBytes) : 'not stated by the source') + (plan.sample ? ', sample of ' + num(plan.sample) + ' rows' : '')], ['Licence', esc(licence.id) + (st.exception ? ', exception requested' : '')], ['Label', UI.label(f.label || 'internal', { sm: true })], ['Mode', plan.mode === 'bundle' ? 'joins the weekly bundle' : 'direct through ' + (st.settings.viaProxy ? 'the staging proxy' : 'the import egress')], ['Requested by', esc(me.displayName || me.username || '')], ['Approvals', isModel ? 'a model admin approves the draft after its evaluation' : st.exception ? 'the legal-review role decides the licence exception first' : 'none before the rows are stored']], 2);
        if (st.startError) body += UI.problem(st.startError.problem && st.startError.problem.title ? st.startError.problem.title : 'The import was not started', st.startError.message, traceOf(st.startError));
        if (!job) body += '<div class="hstack">' + UI.btn(plan && plan.mode === 'bundle' ? 'Queue for the bundle' : 'Start import', { kind: 'primary', attrs: 'data-start', disabled: !plan || plan.blocked || needsLicence || needsException || st.starting }) + UI.btn('Back to destination', { kind: 'ghost', attrs: 'data-step="destination"' }) + '</div>';
        else {
          body += '<div class="divider"></div><div class="hstack"><b>' + esc(job.ref) + '</b>' + UI.pill(job.state, stateKind(job.state)) + '<span class="muted right" style="font-size:12px">' + esc(job.note || job.stage || '') + '</span></div>'
            + UI.meter(job.state === 'complete' ? 'Done' : job.stage || 'Progress', job.progress + '%', job.progress, job.state === 'complete' ? '' : 'accent') + timeline(job);
          const to = resultRoute(job);
          if (job.state === 'complete') body += UI.notice('<b>' + esc(jobTarget(job)) + '</b> is ready.', 'ok', (to ? UI.btn('Open result', { size: 'sm', attrs: 'data-open="' + esc(job.id) + '"' }) : '') + UI.btn('Import another', { kind: 'ghost', size: 'sm', attrs: 'data-another' }));
          else if (job.state === 'waiting on licence' || job.state === 'queued for bundle') body += UI.notice(job.state === 'waiting on licence' ? 'Queued. The import runs when the licence exception is granted; you are notified either way.' : 'Queued. Staging fetches, scans and signs; the import continues here after the transfer.', 'info', UI.btn('Import another', { kind: 'ghost', size: 'sm', attrs: 'data-another' }));
          else if (LIVE.indexOf(job.state) < 0) body += UI.notice(esc(job.error || job.note || 'The import did not complete.'), 'danger', UI.btn('Open in Imports', { size: 'sm', attrs: 'data-gojob="' + esc(job.id) + '"' }) + UI.btn('Import another', { kind: 'ghost', size: 'sm', attrs: 'data-another' }));
        }
        return '<div class="vstack gap12">' + UI.panel('Summary', body) + '</div>';
      }

      // ---------- inspector ----------
      const curJob = () => st.jobs.find((x) => x.id === st.job) || st.jobs[0] || null;
      const curRepo = () => repoOf(st.repoSel) || st.repos[0] || null;
      function inspector() {
        if (st.tab === 'imports') {
          const j = curJob();
          if (!j) return '<aside class="inspector w360">' + UI.empty('No imports yet', 'Requests appear here with their checks, log and manifest.') + '</aside>';
          const exc = j.exception; const to = resultRoute(j); const cls = j.result && j.result.classifier;
          return '<aside class="inspector w360"><div class="hstack"><b>' + esc(j.ref) + '</b>' + UI.pill(j.state, stateKind(j.state)) + '</div><div class="imp-name">' + esc(j.itemName || j.item) + '</div>'
            + UI.kv([['Source', esc(j.repository.name || '')], ['Creates', esc(jobTarget(j))], ['Size', esc(size(j.storedBytes || j.sizeBytes))], ['Licence', esc(j.licence || '') + (j.licenceStatus !== 'allowed' ? ', ' + esc(j.licenceStatus) : '')], ['Requested', esc(when(j.createdAt))], ['By', esc(j.requestedByName || 'schedule')], ['Note', esc(j.note || j.error || '')]], 1)
            + (LIVE.indexOf(j.state) >= 0 ? UI.meter(j.stage || 'Progress', j.progress + '%', j.progress, 'accent') : '')
            + (cls && cls.short && cls.short.length ? UI.notice(cls.short.length + (cls.short.length > 1 ? ' labels are' : ' label is') + ' below ' + num(cls.minimum) + ' samples: ' + esc(cls.short.slice(0, 6).map((x) => x.label + ' has ' + x.samples).join(', ')) + '. Precision and recall are unreliable until the eval set has more.', 'warn') : '')
            + (exc && exc.state === 'pending' ? UI.notice('Licence exception <b>' + esc(exc.ref) + '</b> waits for the legal-review role.', 'warn', canReview && j.requestedBy !== me.id ? UI.btn('Grant', { size: 'sm', attrs: 'data-decide="grant" data-exc="' + esc(exc.id) + '"' }) + UI.btn('Refuse', { kind: 'danger', size: 'sm', attrs: 'data-decide="refuse" data-exc="' + esc(exc.id) + '"' }) : '') : '')
            + timeline(j)
            + '<div class="hstack wrap gap6">' + (LIVE.indexOf(j.state) >= 0 ? UI.btn('Cancel', { kind: 'danger', size: 'sm', attrs: 'data-cancel="' + esc(j.id) + '"' }) : '') + (j.state === 'failed' || j.state === 'cancelled' ? UI.btn('Retry', { size: 'sm', attrs: 'data-retryjob="' + esc(j.id) + '"' }) : '') + (j.state === 'refused' ? UI.btn('Import from another source', { size: 'sm', attrs: 'data-newkind="' + esc(j.kind) + '"' }) : '') + (j.state === 'complete' && to ? UI.btn('Open result', { size: 'sm', attrs: 'data-open="' + esc(j.id) + '"' }) : '') + (j.state === 'complete' && j.result && j.result.store && j.storedBytes > 0 ? '<a class="btn sm" href="/api/imports/' + esc(j.id) + '/rows" download>Download rows</a>' : '') + UI.btn('Import log', { kind: 'ghost', size: 'sm', attrs: 'data-log="' + esc(j.id) + '"' }) + '</div></aside>';
        }
        if (st.tab === 'repos') {
          const r = curRepo();
          if (!r) return '<aside class="inspector w360">' + UI.empty('No repositories', 'Add the first repository; a second admin confirms it before the first harvest.') + '</aside>';
          const mine = r.requestedBy === me.id;
          return '<aside class="inspector w360"><div class="hstack"><b>' + esc(r.name) + '</b>' + UI.pill(r.state === 'active' ? r.status : r.state, r.state === 'active' ? statusKind(r.status) : r.state === 'pending' ? 'warn' : '') + '</div><div class="muted mono" style="font-size:12px;overflow-wrap:anywhere">' + esc(r.baseUrl) + '</div>'
            + UI.kv([['Type', esc(r.typeName)], ['Region', esc(r.region)], ['Offers', esc(r.kinds.map((k) => k + 's').join(', '))], ['Protocol', esc(r.protocol)], ['Credential', r.credential.recorded ? 'recorded in the vault' : r.credential.required ? 'required, not recorded' : r.credential.kind ? 'none recorded' : 'not used'], ['Allow-list', esc([r.host].concat(r.extraHosts || []).join(', '))], ['Harvest', r.harvestMinutes ? 'every ' + (r.harvestMinutes >= 1440 ? Math.round(r.harvestMinutes / 1440) + ' d' : r.harvestMinutes + ' min') + (r.nextHarvestAt ? ', next ' + esc(when(r.nextHarvestAt)) : '') : 'manual'], ['Snapshot', r.snapshotAt ? num(r.snapshotItems) + ' items, ' + esc(when(r.snapshotAt)) : 'none'], ['Status', esc(r.statusDetail || r.status)], ['Licence policy', esc(r.licencePolicy || 'the tenant allow list')]], 1)
            + (r.state === 'pending' ? UI.notice(mine ? 'Waiting for a second admin to confirm. Its hosts join the allow-list and the first harvest runs on confirmation.' : 'Proposed by another admin. Confirm it to add its hosts to the allow-list and start the first harvest.', 'warn') : '')
            + '<div class="hstack wrap gap6">'
            + (r.state === 'pending' ? UI.btn('Confirm', { kind: 'primary', size: 'sm', attrs: 'data-repoact="confirm"', disabled: !canRepos || mine }) + UI.btn('Reject', { kind: 'danger', size: 'sm', attrs: 'data-repoact="reject"', disabled: !canRepos || mine }) : '')
            + (r.state === 'active' ? UI.btn('Edit', { size: 'sm', attrs: 'data-editrepo', disabled: !canRepos }) + UI.btn('Refresh snapshot', { size: 'sm', attrs: 'data-repoact="harvest"', disabled: !canRepos }) + UI.btn('Check', { size: 'sm', attrs: 'data-repoact="check"', disabled: !canRepos }) + UI.btn('Disable', { kind: 'danger', size: 'sm', attrs: 'data-repoact="disable"', disabled: !canRepos }) : '')
            + (r.state === 'disabled' ? UI.btn('Enable', { size: 'sm', attrs: 'data-repoact="enable"', disabled: !canRepos }) : '')
            + (r.state !== 'active' ? UI.btn('Delete', { kind: 'ghost', size: 'sm', attrs: 'data-repoact="delete"', disabled: !canRepos }) : '')
            + '</div></aside>';
        }
        if (!st.item) {
          return '<aside class="inspector w360">' + (repo ? '<div class="hstack"><b>' + esc(repo.name) + '</b>' + UI.pill(repo.status, statusKind(repo.status)) + '</div>' + UI.kv([['Protocol', esc(repo.protocol)], ['Credential', repo.credential.recorded ? 'recorded in the vault' : 'none recorded'], ['Snapshot', repo.snapshotAt ? esc(when(repo.snapshotAt)) + ', ' + num(repo.snapshotItems) + ' items' : 'none'], ['Licence policy', esc(repo.licencePolicy || 'the tenant allow list')]], 1) + UI.notice('Browsing uses the catalogue snapshot. Files, digests and licences are read again from the source when the import runs.', 'info') : UI.empty('Pick a source', 'Choose a repository to browse its catalogue.')) + '</aside>';
        }
        const it = st.item;
        const head = '<div class="hstack wrap gap6">' + UI.pill(repo.name, 'outline') + (it.classification ? UI.pill(it.classification, 'info') : '') + (it.gated ? UI.pill('gated', 'warn') : '') + UI.pill(it.licence || 'unknown', it.licenceAllowed ? 'ok' : 'warn') + '</div>';
        const kv = isModel
          ? [['Publisher', esc(it.publisher || '')], ['Formats', esc((it.formats || []).join(', '))], ['Size', esc(size(it.sizeBytes))], ['Updated', esc((it.updated || '').slice(0, 10))]].concat(d && st.step !== 'browse' ? [['Revision', '<span class="mono">' + esc(String(d.revision || '').slice(0, 19)) + '</span>'], ['Parameters', esc(d.parameters || '')], ['Capabilities', esc((d.capabilities || []).join(', '))], ['Licence read from', esc(d.licenceSource || '')]] : [])
          : [['Publisher', esc(it.publisher || '')], ['Formats', esc((it.formats || []).join(', '))], ['Updates', esc(((it.facets || {}).updates || [])[0] || (d && d.updates) || 'not stated')], ['Size', esc(size(d ? d.sizeBytes : it.sizeBytes))]].concat(d && st.step !== 'browse' ? [['Rows', d.rows == null ? 'not stated' : num(d.rows)], ['Revision', '<span class="mono">' + esc(String(d.revision || '').slice(0, 19)) + '</span>'], ['Columns', st.preview ? st.preview.columns.length + ', ' + st.preview.flagged + ' flagged' : '']] : []);
        return '<aside class="inspector w360"><div class="imp-name">' + esc(it.name || it.itemId) + '</div><div class="mono muted" style="font-size:12px;overflow-wrap:anywhere">' + esc(it.itemId) + '</div>' + head + (it.description ? '<p class="fg2" style="margin:0;font-size:13px">' + esc(it.description.slice(0, 400)) + '</p>' : '') + UI.kv(kv, 1)
          + (st.step !== 'browse' ? '<div class="divider"></div><div class="eyebrow">Destination</div><div class="fg2">' + esc(isModel ? 'Model catalog' : TARGETS.find((t) => t.id === st.target).label) + '</div>' : '<div class="hstack wrap gap6">' + UI.btn('Select', { kind: 'primary', size: 'sm', attrs: 'data-step="select"' }) + '</div>') + '</aside>';
      }

      // ---------- tabs ----------
      function tabImports() {
        const q = (st.jobQuery || '').toLowerCase();
        const rows = st.jobs.filter((j) => !q || (j.ref + ' ' + j.item + ' ' + j.itemName + ' ' + (j.repository.name || '') + ' ' + jobTarget(j) + ' ' + j.state).toLowerCase().indexOf(q) >= 0);
        const cur = curJob();
        return '<div class="toolbar">' + UI.search('Filter imports', 'data-jobsearch', st.jobQuery) + '<span class="muted right" style="font-size:12px">' + rows.length + ' imports · ' + st.counts.running + ' running · ' + (st.counts.waiting + st.counts.queued) + ' waiting</span></div>'
          + UI.table(['Import', 'Kind', 'Item', 'Source', 'Creates', 'Progress', 'State', 'Requested', 'By'], rows.map((j) => ({ cells: ['<b>' + esc(j.ref) + '</b>', esc(j.kind), '<span class="mono">' + esc(j.item) + '</span>', esc(j.repository.name || ''), esc(jobTarget(j)), LIVE.indexOf(j.state) >= 0 ? '<span class="num">' + j.progress + '%</span>' : '<span class="muted">' + (j.state === 'complete' ? 'done' : 'ended') + '</span>', UI.pill(j.state, stateKind(j.state)), esc(when(j.createdAt)), esc(j.requestedByName || 'schedule')], selected: !!cur && j.id === cur.id, attrs: 'data-job="' + esc(j.id) + '"' })), { emptyTitle: st.jobs.length ? 'No imports match' : 'No imports yet', emptyText: st.jobs.length ? 'Change the filter.' : 'Start one on the New import tab.' })
          + UI.notice('Every import records its source, revision, digest or hash, licence and the user who requested it on the manifest, and writes an audit entry. Refused imports write nothing.', 'info');
      }
      function tabRepos() {
        const cur = curRepo();
        return '<div class="toolbar"><span class="fg2">' + st.repos.filter((r) => r.state === 'active' && r.status === 'reachable').length + ' of ' + st.repos.length + ' repositories reachable through ' + (st.settings.viaProxy ? 'the staging proxy' : 'the import egress') + '</span><span class="right">' + UI.btn('Add repository', { kind: 'primary', attrs: 'data-addrepo', disabled: !canRepos }) + '</span></div>'
          + UI.table(['Repository', 'Region', 'Offers', 'Type', 'Credential', 'Snapshot', 'Status'], st.repos.map((r) => ({ cells: ['<b>' + esc(r.name) + '</b><div class="muted mono" style="font-size:11px">' + esc(r.host) + '</div>', esc(r.region), esc(r.kinds.map((k) => k + 's').join(', ')), esc(r.typeName), r.credential.recorded ? 'recorded' : r.credential.required ? 'required' : 'none', r.snapshotAt ? esc(when(r.snapshotAt)) : 'none', UI.pill(r.state === 'active' ? r.status : r.state, r.state === 'active' ? statusKind(r.status) : r.state === 'pending' ? 'warn' : '')], selected: !!cur && r.id === cur.id, attrs: 'data-reporow="' + esc(r.id) + '"' })), { emptyTitle: 'No repositories', emptyText: 'Add a repository to browse and import from it.' })
          + UI.notice('Repository types: ' + esc(st.types.map((t) => t.name).join(', ')) + '. Outbound calls reach only the hosts of confirmed repositories. Credentials are stored in the vault and never shown again.', 'info');
      }

      // ---------- page ----------
      const stepIdx = STEPS.findIndex((s) => s[0] === st.step);
      const s = st.sel || {};
      const picked = isModel ? Object.keys(s.variants || {}).some((k) => s.variants[k]) || Object.keys(s.files || {}).some((k) => s.files[k]) : (d && d.splits.length ? Object.keys(s.splits || {}).some((k) => s.splits[k]) : Object.keys(s.resources || {}).some((k) => s.resources[k]));
      const canNext = {
        source: !!repo && usable(repo) && !(bundle && !isModel),
        browse: !!st.item,
        select: !!d && picked && !gateOpen && !(d.gated && d.access !== 'granted' && !isModel) && (isModel || !!st.preview),
        review: !!plan && !policyBlocked && !needsLicence && !needsException,
        destination: !!plan && !plan.blocked && !needsLicence && !needsException,
        confirm: false
      }[st.step];
      const stepper = '<div class="imp-steps" role="group" aria-label="Import steps">' + STEPS.map((x, i) => '<button type="button" data-step="' + x[0] + '" class="' + (x[0] === st.step ? 'cur' : i < stepIdx ? 'done' : '') + '"' + (x[0] === st.step ? ' aria-current="step"' : '') + (i > stepIdx || st.running ? ' disabled' : '') + '><span class="n">' + (i + 1) + '</span>' + esc(x[1]) + '</button>' + (i < STEPS.length - 1 ? '<span class="sep" aria-hidden="true">›</span>' : '')).join('') + '</div>';
      const stepTitle = { source: 'Choose where to import from', browse: 'Browse ' + (repo ? repo.name : ''), select: st.item ? 'Select from ' + (st.item.name || st.item.itemId) : '', review: 'Policy checks, licence and label', destination: 'Where it goes', confirm: 'Confirm and run' }[st.step];
      const stepBody = st.tab !== 'new' ? '' : st.step === 'source' ? stepSource() : st.step === 'browse' ? stepBrowse() : st.step === 'select' ? stepSelect() : st.step === 'review' ? stepReview() : st.step === 'destination' ? stepDestination() : stepConfirm();
      const footer = st.step === 'confirm' ? '' : '<div class="imp-foot">' + UI.btn('Back', { attrs: 'data-back', disabled: stepIdx === 0 }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-cancelwiz' }) + '<span class="grow"></span>' + (st.step === 'browse' && !st.item ? '<span class="muted" style="font-size:12px">Select a row to continue</span>' : '') + UI.btn(st.step === 'destination' ? 'Review summary' : 'Next', { kind: 'primary', attrs: 'data-next', disabled: !canNext }) + '</div>';
      const ex = st.example ? EXAMPLES[st.example] : null;
      const example = ex ? (ex[0] === 'danger' ? UI.problem(ex[1], ex[2] + ' (Example.)', false) : UI.notice('<b>' + esc(ex[1]) + '</b> ' + esc(ex[2]) + ' (Example.)', ex[0])) : '';
      const wizard = stepper + '<div class="panel"><div class="phead"><div class="eyebrow">Step ' + (stepIdx + 1) + ' of 6</div><span class="fg2" style="font-weight:600">' + esc(stepTitle) + '</span></div>' + stepBody + footer + '</div>';

      root.innerHTML = '<style>'
        + '.imp-steps{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.imp-steps button{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 8px;border:0;border-radius:5px;background:transparent;font:inherit;font-size:12px;font-weight:500;color:var(--fg2);cursor:pointer}.imp-steps button:hover:not([disabled]){background:var(--sel);color:var(--fg)}.imp-steps button[disabled]{cursor:default}.imp-steps button.cur{color:var(--fg);font-weight:700}.imp-steps .n{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--line);font-size:11px}.imp-steps .cur .n{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.imp-steps .done .n{background:var(--fg2);color:var(--bg);border-color:var(--fg2)}.imp-steps .sep{color:var(--muted)}'
        + '.imp-repos{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}.imp-repo{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);text-align:left;font:inherit;color:var(--fg);cursor:pointer;min-width:0}.imp-repo:hover{border-color:var(--muted)}.imp-repo.on{border-color:var(--accent);background:var(--accent-tint)}.imp-repo.off{border-style:dashed}'
        + '.imp-browse{display:grid;gap:14px;grid-template-columns:200px minmax(0,1fr)}.imp-facets{display:flex;flex-direction:column;gap:12px;min-width:0}.imp-facets .listlink{padding:4px 8px}'
        + '.imp-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--line)}'
        + '.imp-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}'
        + '@media (max-width:1100px){.imp-browse{grid-template-columns:1fr}.imp-facets{flex-direction:row;flex-wrap:wrap}}'
        + '</style>'
        + '<div class="page">'
        + UI.pagehead('Import models and datasets', 'Browse repositories, record licence and label, and register the result in the catalogue, under Training, Classifiers or as a knowledge set', '<span class="fg2" style="font-size:12px">Connectivity: ' + (bundle ? 'weekly bundle' : 'direct') + ' · ' + esc(size(st.settings.quota.usedBytes.datasets)) + ' of ' + esc(size(st.settings.quota.maxBytes)) + ' dataset quota used</span>' + UI.iconbtn('refresh', 'Refresh', { attrs: 'data-reload', cls: 'sm ghost' }) + UI.btn('New import', { kind: 'primary', attrs: 'data-newimport' }))
        + UI.tabs([{ id: 'new', label: 'New import' }, { id: 'imports', label: 'Imports', count: st.jobs.length }, { id: 'repos', label: 'Repositories', count: st.repos.length }], st.tab)
        + example
        + (st.tab === 'new' ? wizard : st.tab === 'imports' ? tabImports() : tabRepos())
        + '</div>'
        + inspector();

      // Poll while an import is queued or running, so the queue and the Confirm step move without a reload.
      if (st.jobs.some((j) => j.state === 'queued' || j.state === 'running')) live.timer = setTimeout(() => { live.timer = null; if (App.state.route === 'import') reloadJobs(); }, 2500);

      // ---------- handlers ----------
      const go = (step) => { st.step = step; ctx.rerender(); };
      // A change event also fires when a re-render removes the focused field (its blur); rendering again inside that
      // render would pull the page from under it, so a field's change renders on the next tick.
      const later = () => setTimeout(() => { if (App.state.route === 'import' && !overlayOpen()) refresh(); }, 0);
      const act = async (fn, what) => { try { return await fn(); } catch (err) { App.fail(err, what); return undefined; } };
      ctx.on('click', '[data-reload]', () => { st.catalogKey = null; load(); });
      ctx.on('click', '.tabs [data-tab]', (e, t) => { st.tab = t.dataset.tab; st.example = null; ctx.rerender(); if (st.tab === 'imports') reloadJobs(); });
      ctx.on('click', '[data-gotab]', (e, t) => { st.tab = t.dataset.gotab; ctx.rerender(); });
      ctx.on('click', '[data-newimport]', () => { reset(st, st.kind); st.example = null; ctx.rerender(); });
      ctx.on('click', '[data-another]', () => { reset(st, st.kind, st.target); ctx.rerender(); });
      ctx.on('click', '[data-newkind]', (e, t) => { reset(st, t.dataset.newkind); ctx.rerender(); });
      ctx.on('click', '[data-cancelwiz]', async () => { if (!st.repo || await ctx.confirm({ title: 'Discard this import?', body: '<p class="fg2" style="margin:0">Nothing has been fetched. The selection and form are cleared.</p>', ok: 'Discard', tone: 'danger' })) { reset(st, st.kind); ctx.rerender(); } });
      ctx.on('click', '[data-step]', (e, t) => { if (!t.disabled) go(t.dataset.step); });
      ctx.on('click', '[data-back]', () => go(STEPS[Math.max(0, stepIdx - 1)][0]));
      ctx.on('click', '[data-next]', () => go(STEPS[Math.min(STEPS.length - 1, stepIdx + 1)][0]));
      ctx.on('click', '[data-kindseg] button', (e, t) => { if (t.dataset.seg === st.kind) return; reset(st, t.dataset.seg, st.target); ctx.rerender(); });
      ctx.on('click', '[data-repo]', (e, t) => {
        const r = repoOf(t.dataset.repo);
        if (!usable(r)) { ctx.toast('<b>' + esc(r.name) + '</b> ' + (r.state === 'pending' ? 'waits for a second admin to confirm it.' : r.state === 'disabled' ? 'is disabled. Enable it under Repositories.' : isModel ? 'does not import models.' : 'can be browsed, but its datasets cannot be fetched (' + esc(r.typeName) + ').'), 'warn'); return; }
        Object.assign(st, { repo: r.id, item: null, detail: null, detailKey: null, facets: {}, query: '', catalog: null, catalogKey: null }); ctx.rerender();
      });
      ctx.on('dblclick', '[data-repo]', (e, t) => { if (st.repo === t.dataset.repo && canNext) go('browse'); });
      const search = () => { const i = ctx.$('[data-search]'); if (i && i.value !== st.query) { st.query = i.value; ctx.rerender(); } };
      ctx.on('click', '[data-dosearch]', search);
      ctx.on('keydown', '[data-search]', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      ctx.on('click', '[data-facet]', (e, t) => { st.facets[t.dataset.facet] = st.facets[t.dataset.facet] === t.dataset.v ? null : t.dataset.v; ctx.rerender(); });
      ctx.on('click', '[data-clearfacet]', (e, t) => { st.facets[t.dataset.clearfacet] = null; ctx.rerender(); });
      ctx.on('click', 'tr.row[data-item]', (e, t) => { const it = st.catalog.items.find((x) => x.itemId === t.dataset.item); if (!it) return; Object.assign(st, { item: it, detail: null, detailKey: null, sel: null, form: {}, plan: null, planKey: null, preview: null, previewKey: null, exception: null }); ctx.rerender(); });
      ctx.on('dblclick', 'tr.row[data-item]', () => go('select'));
      ctx.on('click', '[data-retry]', async () => { const r = await act(() => App.post('/api/imports/repositories/' + st.repo + '/check'), 'The source could not be checked'); if (r) { const i = st.repos.findIndex((x) => x.id === r.id); if (i >= 0) st.repos[i] = r; st.catalogKey = null; ctx.rerender(); ctx.toast(r.status === 'reachable' ? '<b>' + esc(r.name) + '</b> answers again.' : '<b>' + esc(r.name) + '</b> is still ' + esc(r.status) + '. The snapshot stays in use.', r.status === 'reachable' ? 'ok' : 'warn'); } });
      ctx.on('click', '[data-redetail]', () => { st.detailKey = null; ctx.rerender(); });
      ctx.on('click', '[data-replan]', () => { st.planKey = null; ctx.rerender(); });
      // select step
      ctx.on('change', '[data-pickv]', (e, t) => { st.sel.variants = {}; if (t.checked) { st.sel.variants[t.dataset.pickv] = true; st.sel.files = {}; } st.form.tag = ''; ctx.rerender(); });
      ctx.on('change', '[data-pickf]', (e, t) => { st.sel.files[t.dataset.pickf] = t.checked; if (t.checked) st.sel.variants = {}; st.form.tag = ''; ctx.rerender(); });
      ctx.on('change', '[data-picks]', (e, t) => { st.sel.splits[t.dataset.picks] = t.checked; ctx.rerender(); if (Object.keys(st.sel.splits).some((k) => st.sel.splits[k])) loadPreview(); });
      ctx.on('change', '[data-pickr]', (e, t) => { st.sel.resources[t.dataset.pickr] = t.checked; ctx.rerender(); if (Object.keys(st.sel.resources).some((k) => st.sel.resources[k])) loadPreview(); });
      ctx.on('change', '[data-s]', (e, t) => {
        const k = t.dataset.s; st.sel[k] = k === 'config' && repo.type === 'sdmx' ? (t.value.trim() || 'all') : t.value;
        if (k === 'config' && repo.type !== 'sdmx') { st.sel.splits = {}; d.splits.filter((x) => x.config === t.value).forEach((x) => { st.sel.splits[x.id] = true; }); }
        st.planKey = null; later(); if (k !== 'sampleRows') loadPreview();
      });
      ctx.on('click', '[data-sample]', () => { st.sel.sample = true; ctx.rerender(); });
      ctx.on('click', '[data-sampletoggle]', () => { st.sel.sample = !st.sel.sample; ctx.rerender(); });
      ctx.on('click', '[data-gate]', async () => {
        const ok = await ctx.confirm({ title: 'Accept the licence gate for ' + d.itemId, tag: 'gated', tone: 'warn', body: '<p class="fg2" style="margin:0">The gate is accepted on ' + esc(repo.host) + ' with the repository\'s recorded token. The acceptance is recorded with the account and the date.</p>', kv: [['Licence', esc(d.licence || 'unknown')], ['Repository', esc(repo.name)]], ok: 'Accept gate' });
        if (!ok) return;
        const r = await act(() => App.post('/api/imports/repositories/' + st.repo + '/gate', { item: d.itemId }), 'The gate was not accepted');
        if (r) { st.detailKey = null; ctx.rerender(); ctx.toast('Gate accepted' + (r.account ? ' as ' + esc(r.account) : '') + '. Files are readable now.', 'ok'); }
      });
      // forms
      ctx.on('input', '[data-f]', (e, t) => { if (t.type !== 'checkbox' && t.tagName !== 'SELECT') st.form[t.dataset.f] = t.value; });
      ctx.on('change', '[data-f]', (e, t) => {
        st.form[t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value;
        if (t.tagName === 'SELECT' || t.type === 'checkbox' || t.hasAttribute('data-replanon')) later();
      });
      ctx.on('click', '[data-exception]', async () => {
        const out = await ask(ctx, { title: 'Request a licence exception', tag: 'legal review', body: UI.field('Justification', UI.textarea('', { placeholder: 'Internal evaluation only; no commercial output derived from the rows', rows: 3, attrs: 'data-f="reason" maxlength="1000"' })) + UI.notice('The legal-review role grants or refuses exceptions. The import waits in the queue and runs when the exception is granted.', 'info'), kv: [['Licence', esc(licence.id)], ['Item', esc(st.item.itemId)]], ok: 'Request with the import' });
        if (!out) return;
        st.exception = { reason: out.reason || '' }; ctx.rerender(); ctx.toast('The exception is requested when the import is started.', 'ok');
      });
      ctx.on('click', '[data-targetseg] button', (e, t) => { st.target = t.dataset.seg; ctx.rerender(); });
      // confirm
      ctx.on('click', '[data-start]', async () => {
        st.starting = true; st.startError = null; ctx.rerender();
        try {
          const j = await App.post(isModel ? '/api/imports' : '/api/imports/datasets', requestBody());
          st.running = j.id; st.job = j.id; st.jobs = [j].concat(st.jobs.filter((x) => x.id !== j.id));
          ctx.toast('<b>' + esc(j.ref) + '</b> ' + (j.state === 'waiting on licence' ? 'waits for the licence exception.' : j.state === 'queued for bundle' ? 'queued for the bundle.' : 'started. Audit entry written.'), 'ok');
        } catch (err) { st.startError = err; }
        st.starting = false; await reloadJobs();
      });
      const openResult = (id) => { const j = st.jobs.find((x) => x.id === id); const to = j && resultRoute(j); if (to) ctx.navigate(to[0], to[1]); };
      ctx.on('click', '[data-open]', (e, t) => openResult(t.dataset.open));
      ctx.on('click', '[data-gojob]', (e, t) => { st.tab = 'imports'; st.job = t.dataset.gojob; ctx.rerender(); });
      // imports tab
      ctx.on('input', '[data-jobsearch]', (e, t) => { st.jobQuery = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-jobsearch]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', 'tr.row[data-job]', (e, t) => { st.job = t.dataset.job; ctx.rerender(); });
      ctx.on('click', '[data-cancel]', async (e, t) => {
        const j = st.jobs.find((x) => x.id === t.dataset.cancel);
        const ok = await ctx.confirm({ title: 'Cancel ' + j.ref, tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">What was fetched so far is discarded and nothing is registered. The audit entry records the cancellation.</p>', ok: 'Cancel import' });
        if (!ok) return;
        if (await act(() => App.post('/api/imports/' + j.id + '/cancel'), 'The import was not cancelled')) ctx.toast(esc(j.ref) + ' cancelled.', 'warn');
        reloadJobs();
      });
      ctx.on('click', '[data-retryjob]', async (e, t) => { const j = await act(() => App.post('/api/imports/' + t.dataset.retryjob + '/retry'), 'The import was not retried'); if (j) ctx.toast('<b>' + esc(j.ref) + '</b> queued again.', 'ok'); reloadJobs(); });
      ctx.on('click', '[data-decide]', async (e, t) => {
        const grant = t.dataset.decide === 'grant';
        const out = await ask(ctx, { title: (grant ? 'Grant' : 'Refuse') + ' the licence exception', tag: 'legal review', tone: grant ? 'warn' : 'danger', body: UI.field('Note', UI.input('', { attrs: 'data-f="note" maxlength="1000"' }), 'Recorded with the decision'), ok: grant ? 'Grant exception' : 'Refuse exception' });
        if (!out) return;
        if (await act(() => App.post('/api/imports/exceptions/' + t.dataset.exc + '/decision', { decision: t.dataset.decide, note: out.note || null }), 'The exception was not decided')) ctx.toast(grant ? 'Exception granted. The import continues.' : 'Exception refused. Nothing is fetched.', grant ? 'ok' : 'warn');
        reloadJobs();
      });
      ctx.on('click', '[data-log]', (e, t) => {
        const j = st.jobs.find((x) => x.id === t.dataset.log);
        const text = (j.log || []).map((l, i) => '[' + String(i + 1).padStart(2, '0') + '] ' + new Date(l.at).toISOString() + ' ' + l.title + (l.meta ? ': ' + l.meta : '')).join('\n');
        ctx.drawer({
          title: 'Import log, ' + esc(j.ref),
          body: UI.kv([['Item', '<span class="mono">' + esc(j.item) + '</span>'], ['Source', esc(j.repository.name || '')], ['Creates', esc(jobTarget(j))], ['State', UI.pill(j.state, stateKind(j.state))]], 1)
            + (j.checks && j.checks.length ? '<div class="eyebrow">Checks at request time</div>' + checksTable(j.checks) : '')
            + '<div class="eyebrow">Log</div>' + UI.code(text || 'No entries yet.', 'log')
            + (j.manifest ? '<div class="eyebrow">Manifest</div>' + UI.code(JSON.stringify(j.manifest, null, 2), 'json') : ''),
          actions: UI.btn('Download log', { icon: 'download', attrs: 'data-dl' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(dr) {
            dr.querySelector('[data-dl]').addEventListener('click', () => {
              const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text + '\n' + (j.manifest ? '\n' + JSON.stringify(j.manifest, null, 2) + '\n' : '')], { type: 'text/plain' })); a.download = j.ref + '.log'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            });
          }
        });
      });
      // repositories tab
      ctx.on('click', 'tr.row[data-reporow]', (e, t) => { st.repoSel = t.dataset.reporow; ctx.rerender(); });
      ctx.on('click', '[data-repoact]', async (e, t) => {
        const r = curRepo(); const a = t.dataset.repoact;
        if (a === 'disable' || a === 'delete' || a === 'reject') {
          const ok = await ctx.confirm({ title: (a === 'disable' ? 'Disable ' : a === 'delete' ? 'Delete ' : 'Reject ') + r.name, tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">' + (a === 'disable' ? 'Running imports from this repository finish; new ones are refused and the snapshot stops refreshing. Scheduled knowledge set refreshes that depend on it fail with a notice.' : a === 'delete' ? 'The repository and its catalogue snapshot are removed. Imports already made keep their manifests.' : 'The proposal is closed; its hosts never join the allow-list.') + '</p>', ok: a === 'disable' ? 'Disable' : a === 'delete' ? 'Delete' : 'Reject' });
          if (!ok) return;
        }
        const url = '/api/imports/repositories/' + r.id;
        const out = await act(() => (a === 'delete' ? App.del(url) : App.post(url + '/' + a)), 'The repository was not changed');
        if (out === undefined) return;
        ctx.toast('<b>' + esc(r.name) + '</b> ' + ({ confirm: 'confirmed. The first harvest is queued.', reject: 'rejected.', enable: 'enabled.', disable: 'disabled.', delete: 'deleted.', harvest: 'snapshot refresh queued.', check: 'is ' + esc(out.status || 'checked') + '.' }[a]), a === 'disable' || a === 'reject' || a === 'delete' ? 'warn' : 'ok');
        if (a === 'delete') st.repoSel = null;
        reloadRepos();
      });
      ctx.on('click', '[data-editrepo]', async () => {
        const r = curRepo();
        const out = await ask(ctx, { title: 'Edit ' + r.name, wide: true, body: '<div class="formgrid" style="--cols:2">' + UI.field('Name', UI.input(r.name, { attrs: 'data-f="name" maxlength="120"' })) + UI.field('Region', UI.input(r.region, { attrs: 'data-f="region" maxlength="40"' })) + (r.credential.kind ? UI.field('Replace credential', UI.input('', { type: 'password', placeholder: 'Leave empty to keep the stored one', attrs: 'data-f="credential" autocomplete="off"' }), r.credential.kind) : '') + UI.field('Harvest schedule', pick(HARVESTS, String(r.harvestMinutes || ''), 'data-f="harvest"')) + '<div class="span2">' + UI.field('Licence policy', UI.textarea(r.licencePolicy || '', { rows: 2, attrs: 'data-f="policy" maxlength="1000"' })) + '</div></div>', ok: 'Save' });
        if (!out) return;
        const body = { name: out.name.trim() || r.name, region: out.region.trim() || r.region, licencePolicy: out.policy.trim() || null, harvestMinutes: out.harvest ? parseInt(out.harvest, 10) : null };
        if (out.credential) body.credential = out.credential;
        if (await act(() => App.patch('/api/imports/repositories/' + r.id, body), 'The repository was not saved')) ctx.toast('<b>' + esc(body.name) + '</b> saved. Audit entry written.', 'ok');
        reloadRepos();
      });
      ctx.on('click', '[data-addrepo]', async () => {
        const types = st.types;
        const out = await ask(ctx, { title: 'Add repository', wide: true, body: '<div class="formgrid" style="--cols:2">' + UI.field('Type', pick(types.map((t) => [t.type, t.name]), 'ckan', 'data-f="type"')) + UI.field('Name', UI.input('', { placeholder: 'data.gov.uk', attrs: 'data-f="name" maxlength="120"' })) + UI.field('Base URL', UI.input('', { placeholder: 'https://catalog.data.gov', attrs: 'data-f="baseUrl" maxlength="500"' }), 'Not needed for signed bundles') + UI.field('Region', UI.input('Global', { attrs: 'data-f="region" maxlength="40"' })) + UI.field('Credential', UI.input('', { type: 'password', placeholder: 'Optional; stored in the vault', attrs: 'data-f="credential" autocomplete="off"' })) + UI.field('Harvest schedule', pick(HARVESTS, '1440', 'data-f="harvest"')) + UI.field('Extra hosts', UI.input('', { placeholder: 'cdn.example.org, files.example.org', attrs: 'data-f="hosts"' }), 'Redirect and download hosts for the allow-list') + UI.field('Licence policy', UI.input('', { attrs: 'data-f="policy" maxlength="1000"' })) + '</div>' + UI.notice('Outbound calls reach only allow-listed hosts. Adding a repository is dual-controlled: a second admin confirms before the first harvest.', 'info'), ok: 'Send for confirmation' });
        if (!out) return;
        const body = { type: out.type, name: out.name.trim(), region: out.region.trim() || 'Global', harvestMinutes: out.harvest ? parseInt(out.harvest, 10) : null };
        if (out.baseUrl.trim()) body.baseUrl = out.baseUrl.trim();
        if (out.credential) body.credential = out.credential;
        if (list(out.hosts).length) body.extraHosts = list(out.hosts);
        if (out.policy.trim()) body.licencePolicy = out.policy.trim();
        const r = await act(() => App.post('/api/imports/repositories', body), 'The repository was not proposed');
        if (r) { st.repoSel = r.id; ctx.toast('Repository proposed. Waiting for a second admin to confirm; the allow-list updates on confirmation.', 'ok', 5000); }
        reloadRepos();
      });
      if (ctx.app.renderHeader) ctx.app.renderHeader();
    }
  });
})();
