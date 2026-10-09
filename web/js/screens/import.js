(function () {
  const { UI, esc } = App;

  // 1.7.0, Sprint 40b (B-3807): the Import screen, live. One guided path from a confirmed repository to a draft model
  // (B-3803), a classifier engine (B-3806), a training dataset version (B-3804), a classifier eval set (B-3806) or a
  // knowledge set (B-3805); the Imports queue with cancel, retry and logs; the Repositories tab with dual control.
  // Everything on this screen comes from /api/imports/*.
  const STEPS = [['source', 'Source'], ['browse', 'Browse'], ['select', 'Select'], ['review', 'Review'], ['destination', 'Destination'], ['confirm', 'Confirm']];
  const TARGETS = [{ id: 'training', label: 'Training dataset' }, { id: 'classifiers', label: 'Classifier eval set' }, { id: 'knowledge', label: 'Knowledge set' }, { id: 'store', label: 'Store only' }];
  const enc = encodeURIComponent;
  const overlayOpen = () => !!document.getElementById('overlay');
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || false;
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Request failed';
  const when = (t) => (t ? new Date(t).toLocaleString() : '');
  const bytes = (n) => n == null ? '' : n >= 1e12 ? (n / 1e12).toFixed(1) + ' TB' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const stateTone = (s) => s === 'complete' ? 'ok' : s === 'refused' || s === 'failed' ? 'danger' : s === 'cancelled' ? '' : s === 'running' ? 'info' : 'warn';
  const repoTone = (r) => r.state === 'pending' ? 'warn' : r.state === 'rejected' || r.status === 'unreachable' || r.status === 'needs token' ? 'danger' : r.status === 'reachable' ? 'ok' : r.state === 'disabled' ? '' : 'warn';
  const checkTone = (c) => c.result === 'passed' ? 'ok' : c.result === 'refused' ? 'danger' : c.result === 'warning' || c.result === 'waiting' ? 'warn' : 'info';
  const isModel = (st) => st.kind === 'model';
  const repoOf = (st, id) => (st.repos || []).find((r) => r.id === (id || st.repo));
  const LIVE = ['queued', 'waiting on licence', 'queued for bundle', 'running'];

  function reset(st, kind, target) {
    st.tab = 'new'; st.kind = kind || st.kind || 'model'; st.target = target || (st.kind === 'model' ? 'models' : 'training');
    st.step = 'source'; st.repo = null; st.query = ''; st.facets = {}; st.browse = null; st.browseKey = null; st.item = null; st.detail = null; st.detailKey = null;
    st.picked = {}; st.form = {}; st.plan = null; st.planKey = null; st.planError = null; st.running = null; st.job = null; st.gateBusy = false;
  }

  // ---------- loading ----------
  function load(ctx, st) {
    const key = 'base';
    if (st.loadKey === key || st.loadBusy) return;
    st.loadBusy = true;
    Promise.all([App.get('/api/imports/types'), App.get('/api/imports/repositories'), App.get('/api/imports?limit=200'), App.get('/api/imports/quota').catch(() => null), App.get('/api/imports/settings').catch(() => null)])
      .then(([types, repos, imports, quota, settings]) => { st.types = types; st.repos = repos; st.imports = imports.imports; st.counts = imports.counts; st.quota = quota; st.settings = settings; st.loadKey = key; st.loadError = null; })
      .catch((err) => { st.loadError = err; st.loadKey = key; })
      .finally(() => { st.loadBusy = false; if (App.state.route === 'import' && !overlayOpen()) ctx.rerender(); else st.dirty = true; });
  }
  async function reloadImports(st) {
    const out = await App.get('/api/imports?limit=200');
    st.imports = out.imports; st.counts = out.counts;
  }
  async function reloadRepos(st) { st.repos = await App.get('/api/imports/repositories'); }

  // ---------- the wizard: source, browse, select, review, destination, confirm ----------
  function stepSource(st) {
    const repos = (st.repos || []).filter((r) => r.kinds.includes(st.kind) && r.state !== 'rejected');
    const card = (r) => '<button type="button" class="imp-repo' + (st.repo === r.id ? ' on' : '') + (r.state !== 'active' ? ' off' : '') + '" data-repo="' + esc(r.id) + '" aria-pressed="' + (st.repo === r.id ? 'true' : 'false') + '">'
      + '<span class="hstack"><b>' + esc(r.name) + '</b>' + UI.pill(r.state === 'active' ? r.status : r.state, repoTone(r)) + '</span>'
      + '<span class="muted mono" style="font-size:11px">' + esc(r.host) + '</span><span class="fg2" style="font-size:12px">' + esc(r.typeName) + ' · ' + esc(r.region) + (r.snapshotItems ? ' · ' + num(r.snapshotItems) + ' in the snapshot' : '') + '</span></button>';
    return '<div class="vstack gap12">'
      + '<div class="hstack wrap gap12"><span class="fg2">Import a</span>' + UI.seg([{ id: 'model', label: 'Model' }, { id: 'dataset', label: 'Dataset' }], st.kind, 'data-kindseg') + '<span class="muted" style="font-size:12px">' + (st.kind === 'model' ? 'Models become draft tags in the catalogue, or classifier engines.' : 'Datasets become training versions, classifier eval sets, knowledge sets, or are stored.') + '</span></div>'
      + (repos.length ? '<div class="imp-repos">' + repos.map(card).join('') + '</div>' : UI.empty('No repository offers ' + st.kind + 's', 'A model admin adds repositories under the Repositories tab; a second admin confirms them.', App.can('imports:repositories') ? UI.btn('Repositories', { size: 'sm', attrs: 'data-gotab="repos"' }) : ''))
      + '</div>';
  }

  function loadBrowse(ctx, st) {
    const r = repoOf(st); if (!r) return;
    const facetQs = Object.keys(st.facets).filter((k) => st.facets[k]).map((k) => '&facet.' + enc(k) + '=' + enc(st.facets[k])).join('');
    const key = r.id + '|' + st.kind + '|' + (st.query || '') + facetQs;
    if (st.browseKey === key || st.browseBusy === key) return;
    st.browseBusy = key;
    App.get('/api/imports/repositories/' + enc(r.id) + '/catalog?kind=' + st.kind + '&q=' + enc(st.query || '') + '&limit=50' + facetQs)
      .then((out) => { st.browse = out; st.browseKey = key; st.browseError = null; })
      .catch((err) => { st.browseError = err; st.browseKey = key; })
      .finally(() => { st.browseBusy = null; if (App.state.route === 'import' && !overlayOpen()) ctx.rerender(); });
  }
  function stepBrowse(ctx, st) {
    const r = repoOf(st);
    loadBrowse(ctx, st);
    const b = st.browse;
    const facetCol = b ? '<div class="imp-facets">' + b.facets.map((f) => '<div><div class="eyebrow" style="margin-bottom:4px">' + esc(f.label) + '</div>' + f.values.slice(0, 8).map((v) => UI.listItem(esc(v.value) + ' <span class="muted">' + num(v.count) + '</span>', '', { active: v.selected, attrs: 'data-facet="' + esc(f.key) + '" data-v="' + esc(v.value) + '"' })).join('') + '</div>').join('') + '</div>' : '';
    const chips = Object.keys(st.facets).filter((k) => st.facets[k]).map((k) => UI.chip(esc(k) + ': ' + esc(st.facets[k]), true, 'data-clearfacet="' + esc(k) + '" aria-label="Remove filter ' + esc(k) + '"')).join('');
    const rows = b ? b.items.map((it) => ({ cells: ['<b>' + esc(it.name) + '</b>' + (it.name !== it.itemId ? '<div class="muted mono" style="font-size:11px">' + esc(it.itemId) + '</div>' : ''), esc(it.publisher || ''), esc(it.classification || ''), it.licence ? UI.pill(it.licence, it.licenceAllowed ? 'ok' : 'warn') : '', esc(it.formats.join(', ')), it.sizeBytes != null ? bytes(it.sizeBytes) : '', it.gated ? UI.pill('gated', 'warn') : ''], attrs: 'data-item="' + esc(it.itemId) + '" class="row' + (st.item === it.itemId ? ' active' : '') + '" tabindex="0"' })) : [];
    return '<div class="vstack gap12">'
      + '<div class="toolbar">' + UI.search('Search ' + (r ? r.name : ''), 'data-search', st.query) + (b ? '<span class="muted" style="font-size:12px">' + (b.source === 'live' ? 'Live search' : 'Snapshot' + (b.snapshotAt ? ' of ' + esc(when(b.snapshotAt)) : '')) + (b.liveReason ? ': ' + esc(b.liveReason) : '') + ' · ' + num(b.total) + ' items</span>' : '') + '</div>'
      + (chips ? '<div class="hstack wrap gap6">' + chips + '</div>' : '')
      + (st.browseError ? UI.problem('The catalogue could not be read', detailOf(st.browseError), traceOf(st.browseError)) : !b ? UI.notice('Loading the catalogue…', 'info') : '<div class="imp-browse">' + facetCol + '<div>' + UI.table(['Item', 'Publisher', 'Classification', 'Licence', 'Formats', 'Size', ''], rows, { clickable: true, emptyTitle: 'Nothing matches', emptyText: 'Try other words or clear a filter.' }) + '</div></div>')
      + '</div>';
  }

  function loadDetail(ctx, st) {
    const r = repoOf(st); if (!r || !st.item) return;
    const key = r.id + '|' + st.kind + '|' + st.item;
    if (st.detailKey === key || st.detailBusy === key) return;
    st.detailBusy = key;
    App.get('/api/imports/repositories/' + enc(r.id) + (isModel(st) ? '/item?id=' : '/dataset?id=') + enc(st.item))
      .then((d) => { st.detail = d; st.detailKey = key; st.detailError = null; if (!isModel(st) && !st.picked.init) { st.picked = { init: true }; d.resources.forEach((x) => { if (x.api !== 'file' || ['csv', 'tsv', 'json', 'jsonl', 'ndjson'].includes(x.format)) st.picked['r:' + x.id] = true; }); } })
      .catch((err) => { st.detailError = err; st.detailKey = key; })
      .finally(() => { st.detailBusy = null; if (App.state.route === 'import' && !overlayOpen()) ctx.rerender(); });
  }
  const selectedResources = (st) => (st.detail && st.detail.resources ? st.detail.resources.filter((x) => st.picked['r:' + x.id]) : []);
  const selectedFiles = (st) => (st.detail && st.detail.files ? st.detail.files.filter((f) => st.picked['f:' + f.name]) : []);
  const selectedVariants = (st) => (st.detail && st.detail.variants ? st.detail.variants.filter((v) => st.picked['v:' + v.id]) : []);
  function stepSelect(ctx, st) {
    loadDetail(ctx, st);
    const d = st.detail;
    if (st.detailError) return UI.problem('The item could not be read', detailOf(st.detailError), traceOf(st.detailError)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-retrydetail' }) + '</div>';
    if (!d) return UI.notice('Reading ' + esc(st.item || '') + '…', 'info');
    if (isModel(st)) {
      const gate = d.gated && d.access !== 'granted';
      return '<div class="vstack gap12">'
        + (gate ? UI.notice('<b>Gated repository.</b> The source lists no files until the licence gate is accepted with the recorded token (access: ' + esc(d.access) + ').', 'warn', UI.btn(st.gateBusy ? 'Accepting…' : 'Accept the gate', { size: 'sm', kind: 'primary', attrs: 'data-gate', disabled: st.gateBusy })) : '')
        + UI.kv([['Revision', '<span class="mono">' + esc(String(d.revision || '').slice(0, 19)) + '</span>'], ['Licence', esc(d.licence || 'not stated') + ' <span class="muted">(' + esc(d.licenceSource || '') + ')</span>'], ['Classification', esc(d.classification || '')], ['Parameters', esc(d.parameters || '')], ['Capabilities', esc((d.capabilities || []).join(', '))]], 2)
        + (d.variants && d.variants.length ? UI.panel('Variants (GGUF builds)', UI.table(['', 'Variant', 'Quantization', 'Size'], d.variants.map((v) => [UI.check('', !!st.picked['v:' + v.id], 'data-pick="v:' + esc(v.id) + '" aria-label="Select variant ' + esc(v.id) + '"'), '<span class="mono">' + esc(v.id) + '</span>', esc(v.quantization || ''), bytes(v.size)]), { clickable: false })) : '')
        + UI.panel('Files', d.files && d.files.length ? UI.table(['', 'File', 'Format', 'Size', 'Pin'], d.files.map((f) => [UI.check('', !!st.picked['f:' + f.name], 'data-pick="f:' + esc(f.name) + '" aria-label="Select file ' + esc(f.name) + '"'), '<span class="mono">' + esc(f.name) + '</span>', f.format === 'pickle' ? UI.pill('pickle', 'danger') : UI.pill(f.format, f.format === 'safetensors' || f.format === 'gguf' ? 'ok' : ''), bytes(f.size), '<span class="mono muted" style="font-size:11px">' + esc(String(f.pin || '').slice(0, 19)) + '</span>']), { clickable: false }) : UI.empty('No files listed', gate ? 'Accept the gate to list them.' : 'The source lists no files at this revision.'))
        + UI.notice('Nothing selected: safetensors (with their metadata) or the Q4_K_M GGUF are taken by default. Pickle files are refused before anything is written.', 'info')
        + '</div>';
    }
    const cfgs = d.configurations || [];
    const rows = d.resources.map((x) => [UI.check('', !!st.picked['r:' + x.id], 'data-pick="r:' + esc(x.id) + '" aria-label="Select resource ' + esc(x.name) + '"'), '<b>' + esc(x.name) + '</b>' + (x.config ? '<div class="muted" style="font-size:11px">' + esc(x.config) + '</div>' : ''), x.api !== 'file' ? UI.pill(x.api + ' API', 'info') : UI.pill(x.format, ['csv', 'tsv', 'json', 'jsonl', 'ndjson'].includes(x.format) ? 'ok' : 'danger'), x.split ? UI.pill(x.split, 'outline') : '', bytes(x.bytes), x.rows != null ? num(x.rows) : '']);
    return '<div class="vstack gap12">'
      + UI.kv([['Publisher', esc(d.publisher || '')], ['Licence', esc(d.licence || 'not stated') + ' <span class="muted">(' + esc(d.licenceSource || '') + ')</span>'], ['Updates', esc(d.frequency || 'not stated')], ['Revision', '<span class="mono">' + esc(String(d.revision || '').slice(0, 25)) + '</span>'], ['Configurations', esc(cfgs.map((c) => c.name + (c.splits.length ? ' (' + c.splits.join(', ') + ')' : '')).join('; ') || 'one')]], 2)
      + UI.panel('Resources', UI.table(['', 'Resource', 'Read as', 'Split', 'Size', 'Rows'], rows, { clickable: false }) + '<div class="muted" style="font-size:12px;margin-top:6px">CSV, TSV, JSON and JSON Lines files are streamed; the CKAN datastore, Socrata, SDMX, e-Stat and OGD APIs are read page by page. Other formats are refused at the review step.</div>')
      + UI.field('Sample', '<div class="hstack gap6">' + UI.input(st.form.sample || '', { placeholder: 'every row', attrs: 'data-f="sample" inputmode="numeric" aria-label="Sample rows"' }) + '<span class="muted" style="font-size:12px">rows at most; a dataset above the import quota must be sampled</span></div>')
      + '</div>';
  }

  function planBody(st) {
    const r = repoOf(st);
    const f = st.form;
    if (isModel(st)) {
      const body = { repositoryId: r.id, item: st.item, target: st.target === 'classifiers' ? 'classifiers' : 'models', label: f.label || 'internal' };
      const vs = selectedVariants(st), fs = selectedFiles(st);
      if (vs.length) body.variants = vs.map((v) => v.id); else if (fs.length) body.files = fs.map((x) => x.name);
      if (f.licence) body.licence = f.licence; if (f.attribution) body.attribution = f.attribution; if (f.tag) body.tag = f.tag; if (f.quant) body.quantization = f.quant; if (f.notes) body.notes = f.notes;
      if (f.exception) body.exception = { reason: f.exceptionReason || null };
      return body;
    }
    const body = { repositoryId: r.id, item: st.item, resources: selectedResources(st).map((x) => x.id), target: st.target, label: f.label || 'internal' };
    if (f.sample && Number(f.sample) > 0) body.sample = Math.floor(Number(f.sample));
    if (f.licence) body.licence = f.licence; if (f.attribution) body.attribution = f.attribution; if (f.notes) body.notes = f.notes;
    if (f.exception) body.exception = { reason: f.exceptionReason || null };
    // The destination's details go along once they are filled in; the review step plans without them.
    if (st.target === 'training' && f.name) body.training = { name: f.name, ...(f.textCol ? { textColumn: f.textCol } : {}), ...(f.labelCol ? { labelColumn: f.labelCol } : {}), ...(f.conv ? { conversationData: true } : {}) };
    if (st.target === 'classifiers' && f.evalSet && (f.textCol || columnsOf(st)[0]) && (f.labelCol || columnsOf(st)[0])) body.classifiers = { evalSet: f.evalSet, textColumn: f.textCol || columnsOf(st)[0], labelColumn: f.labelCol || columnsOf(st)[0], classifier: f.clsMode === 'new' ? { mode: 'new', name: f.clsName || null, engine: f.clsEngine || 'linear' } : f.clsMode === 'existing' ? { mode: 'existing', ref: f.clsRef || null } : { mode: 'none' } };
    if (st.target === 'knowledge' && (f.kbId || ((f.kbName || (st.detail && st.detail.name)) && (f.embed || (st.embedModels || [])[0])))) body.knowledge = { ...(f.kbId ? { kbId: f.kbId } : { name: f.kbName || (st.detail && st.detail.name) || null, embedModel: f.embed || (st.embedModels || [])[0] || null }), ...(f.titleCol ? { titleColumn: f.titleCol } : {}), textColumns: (f.textCols || '').split(',').map((x) => x.trim()).filter(Boolean), metadataColumns: (f.metaCols || '').split(',').map((x) => x.trim()).filter(Boolean), ...(f.groupBy ? { groupBy: f.groupBy } : {}), schedule: f.schedule || 'publisher', dropPii: !!f.dropPii };
    return body;
  }
  function loadPlan(ctx, st) {
    if (!st.item || !repoOf(st)) return;
    let body; try { body = planBody(st); } catch (err) { st.planError = err; return; }
    const key = JSON.stringify(body);
    if (st.planKey === key || st.planBusy === key) return;
    st.planBusy = key;
    App.post(isModel(st) ? '/api/imports/plan' : '/api/imports/dataset-plan', body)
      .then((p) => { st.plan = p; st.planKey = key; st.planError = null; })
      .catch((err) => { st.planError = err; st.planKey = key; st.plan = null; })
      .finally(() => { st.planBusy = null; if (App.state.route === 'import' && !overlayOpen()) ctx.rerender(); });
  }
  const columnsOf = (st) => (st.plan && st.plan.schema ? st.plan.schema.columns.map((c) => c.name) : []);
  function stepReview(ctx, st) {
    loadPlan(ctx, st);
    const p = st.plan;
    const f = st.form;
    const lic = p ? p.licence : null;
    const unknown = lic && (lic.id === 'unknown' || lic.id === 'other');
    const licences = (st.settings && st.settings.allowedLicences) || [];
    const form = '<div class="formgrid" style="--cols:3">'
      + UI.field('Licence recorded on the manifest', unknown || !p ? UI.select([{ value: '', label: 'Choose…' }].concat(licences.map((l) => ({ value: l, label: l }))).concat(f.licence && !licences.includes(f.licence) ? [{ value: f.licence, label: f.licence }] : []), f.licence || '', 'data-f="licence" aria-label="Licence"') : UI.input(lic.id, { readonly: true, attrs: 'aria-label="Licence"' }), p ? (unknown ? 'The source states none: record one to continue.' : 'Read from ' + esc(lic.source) + (lic.allowed ? ', on the allow-list' : ', outside the allow-list')) : '')
      + UI.field('Classification label', UI.select(['public', 'internal', 'confidential', 'restricted'], f.label || 'internal', 'data-f="label" aria-label="Label"'), 'The rows and what they become carry it')
      + UI.field('Attribution', UI.input(f.attribution || '', { attrs: 'data-f="attribution" aria-label="Attribution"', placeholder: 'Publisher, source, DOI' }), 'Shown on the manifest')
      + '</div>'
      + (lic && lic.needsException ? '<div class="formgrid" style="--cols:2">' + UI.field('Licence exception', UI.check('Request an exception from legal review', !!f.exception, 'data-f="exception"'), lic.id + ' is outside the tenant\'s allow-list; the import waits until the legal-review role decides') + UI.field('Justification', UI.textarea(f.exceptionReason || '', { rows: 2, attrs: 'data-f="exceptionReason" aria-label="Justification"' })) + '</div>' : '');
    const schema = p && p.schema && p.schema.columns.length ? UI.panel('Schema preview (' + num(p.schema.previewRows) + ' rows from ' + esc(p.schema.from || '') + ')', UI.table(['Column', 'Type', 'PII', 'Sample'], p.schema.columns.map((c) => [esc(c.name), esc(c.type), c.pii.length ? UI.pill(c.pii.join(', '), 'warn') : '', '<span class="muted" style="font-size:12px">' + esc(c.sample || '') + '</span>']), { clickable: false })) : '';
    return '<div class="vstack gap12">'
      + (st.planError ? UI.problem('The plan could not be made', detailOf(st.planError), traceOf(st.planError)) : !p ? UI.notice('Checking the selection against the policy…', 'info') : UI.table(['Check', 'Result', 'Detail'], p.checks.map((c) => ['<b>' + esc(c.name) + '</b>', UI.pill(c.result, checkTone(c)), '<span class="fg2">' + esc(c.detail) + '</span>']), { clickable: false }))
      + (p && p.blocked ? UI.notice('A check is failing. Fix it or go back and change the selection; Next stays disabled.', 'danger') : p && p.waiting ? UI.notice('The import will wait on legal review.', 'warn') : '')
      + UI.panel('Licence and label', form)
      + schema
      + (p && !isModel(st) ? UI.kv([['Source', esc(p.repository.name) + ', ' + esc(p.item)], ['Resources', esc(p.selected.map((x) => x.name).join(', '))], ['Size', (p.sizeBytes != null ? bytes(p.sizeBytes) : 'unknown') + (p.quota.sample ? ', sampled to ' + num(p.quota.sample) + ' rows' : '')], ['Quota', bytes(p.quota.remainingBytes) + ' left of ' + bytes(p.quota.maxBytes)]], 2) : '')
      + (p && isModel(st) ? UI.kv([['Source', esc(p.repository.name) + ', ' + esc(p.item) + (p.revision ? ' @ ' + esc(String(p.revision).slice(0, 19)) : '')], ['Selected', esc((p.variant ? [p.variant] : p.selected).join(', '))], ['Size', bytes(p.sizeBytes)], ['Mode', esc(p.mode)]], 2) : '')
      + '</div>';
  }

  function stepDestination(ctx, st) {
    const f = st.form;
    const cols = columnsOf(st);
    const colSel = (name, value, hint, allowNone) => UI.field(name, UI.select((allowNone ? [{ value: '', label: 'none' }] : []).concat(cols.map((c) => ({ value: c, label: c }))), value || (allowNone ? '' : cols[0] || ''), 'data-f="' + esc(hint) + '" aria-label="' + esc(name) + '"'));
    if (isModel(st)) {
      const p = st.plan;
      return '<div class="vstack gap12">'
        + '<div class="hstack wrap gap12"><span class="fg2">Register as</span>' + UI.seg([{ id: 'models', label: 'Draft model' }, { id: 'classifiers', label: 'Classifier engine' }], st.target === 'classifiers' ? 'classifiers' : 'models', 'data-targetseg') + '</div>'
        + (st.target === 'classifiers' ? UI.notice('Registers in <b>Classifiers</b> as an imported engine served by the classifier worker (text-classification models); nothing is placed on a pool. Name its eval set and evaluate it there.', 'info') : UI.notice('Registers in the model catalogue as a draft tag; evaluation, approval and placement follow as for any model.', 'info'))
        + '<div class="formgrid" style="--cols:3">'
        + UI.field('Tag', UI.input(f.tag || (p ? p.tag : ''), { attrs: 'data-f="tag" aria-label="Tag"' }), st.target === 'classifiers' ? 'The classifier\'s name' : 'The Ollama tag the gateway resolves')
        + (st.target !== 'classifiers' && p && p.conversion && p.conversion.needed ? UI.field('Convert to GGUF', UI.select(['Q4_K_M', 'Q5_K_M', 'Q8_0', 'F16'], f.quant || 'Q4_K_M', 'data-f="quant" aria-label="Quantization"'), 'On the training pool') : '')
        + UI.field('Notes', UI.input(f.notes || '', { attrs: 'data-f="notes" aria-label="Notes"' }))
        + '</div></div>';
    }
    let form = '';
    if (st.target === 'training') form = '<div class="formgrid" style="--cols:3">' + UI.field('Dataset name', UI.input(f.name || '', { placeholder: 'lower-case-with-dashes', attrs: 'data-f="name" aria-label="Dataset name"' }), 'A new version of an existing name, or v1 of a new one') + colSel('Text column', f.textCol, 'textCol', true) + colSel('Label or response column', f.labelCol, 'labelCol', true) + '</div>'
      + '<div class="hstack wrap gap12">' + UI.check('Conversation data (needs the tenant opt-in)', !!f.conv, 'data-f="conv"') + '</div>'
      + UI.notice('Rows are scrubbed, hashed and sealed as a version under Training, Datasets, with its manifest and scrub report, as a pipeline\'s rows would be.', 'info');
    else if (st.target === 'classifiers') form = '<div class="formgrid" style="--cols:3">' + UI.field('Eval set', UI.input(f.evalSet || '', { placeholder: 'banking-intents', attrs: 'data-f="evalSet" aria-label="Eval set"' }), 'Named cases under Classifiers') + colSel('Text column', f.textCol, 'textCol', false) + colSel('Label column', f.labelCol, 'labelCol', false) + '</div>'
      + '<div class="formgrid" style="--cols:3">' + UI.field('Classifier', UI.select([{ value: 'none', label: 'Only the eval set' }, { value: 'new', label: 'New classifier on this set' }, { value: 'existing', label: 'An existing classifier (by slug)' }], f.clsMode || 'none', 'data-f="clsMode" aria-label="Classifier"'))
      + (f.clsMode === 'new' ? UI.field('Name', UI.input(f.clsName || '', { attrs: 'data-f="clsName" aria-label="Classifier name"' })) + UI.field('Engine', UI.select([{ value: 'linear', label: 'Embedding + linear head (trained on the set)' }, { value: 'llm', label: 'LLM with JSON output' }, { value: 'guard', label: 'Guard model' }], f.clsEngine || 'linear', 'data-f="clsEngine" aria-label="Engine"')) : f.clsMode === 'existing' ? UI.field('Slug', UI.input(f.clsRef || '', { attrs: 'data-f="clsRef" aria-label="Classifier slug"' })) : '') + '</div>'
      + UI.notice('Labels under 200 samples are marked unreliable; a classifier cannot publish on them. Precision and recall per label appear on the Classifiers screen after the evaluation.', 'warn');
    else if (st.target === 'knowledge') form = '<div class="formgrid" style="--cols:3">'
      + UI.field('Knowledge base', UI.select([{ value: '', label: 'New knowledge base' }].concat((st.kbs || []).map((k) => ({ value: k.id, label: k.name }))), f.kbId || '', 'data-f="kbId" aria-label="Knowledge base"'))
      + (!f.kbId ? UI.field('Name', UI.input(f.kbName || (st.detail ? st.detail.name : ''), { attrs: 'data-f="kbName" aria-label="Knowledge base name"' })) + UI.field('Embedding model', UI.select((st.embedModels || []).map((m) => ({ value: m, label: m })), f.embed || (st.embedModels || [])[0] || '', 'data-f="embed" aria-label="Embedding model"')) : '')
      + '</div><div class="formgrid" style="--cols:3">' + colSel('Title column', f.titleCol, 'titleCol', true) + UI.field('Text columns', UI.input(f.textCols || '', { placeholder: 'every column not in metadata', attrs: 'data-f="textCols" aria-label="Text columns"' }), 'Comma separated') + UI.field('Metadata columns', UI.input(f.metaCols || '', { placeholder: 'shown with citations', attrs: 'data-f="metaCols" aria-label="Metadata columns"' }), 'Comma separated')
      + '</div><div class="formgrid" style="--cols:3">' + colSel('Group rows by', f.groupBy, 'groupBy', true) + UI.field('Refresh schedule', UI.select([{ value: 'publisher', label: 'As the publisher updates' + (st.plan && st.plan.frequency ? ' (' + st.plan.frequency + ')' : '') }, { value: 'daily', label: 'daily' }, { value: 'weekly', label: 'weekly' }, { value: 'monthly', label: 'monthly' }, { value: 'manual', label: 'manual' }], f.schedule || 'publisher', 'data-f="schedule" aria-label="Refresh schedule"')) + '</div>'
      + '<div class="hstack wrap gap12">' + UI.check('Drop flagged PII columns from the documents', !!f.dropPii, 'data-f="dropPii"') + '</div>'
      + UI.notice('Each row becomes a document with a citation back to the row; a refresh re-reads the source and swaps changed rows only, the rest keep serving.', 'info');
    else form = UI.notice('The rows are stored sealed with the tenant key, with the manifest, and nowhere else.', 'info');
    return '<div class="vstack gap12"><div class="hstack wrap gap12"><span class="fg2">Create</span>' + UI.seg(TARGETS, st.target, 'data-targetseg') + '</div>' + form + '</div>';
  }

  function summaryKv(st) {
    const p = st.plan; const r = repoOf(st); const f = st.form;
    const creates = isModel(st) ? (st.target === 'classifiers' ? 'Classifiers: imported engine ' + (f.tag || (p && p.tag) || '') : 'Models: draft tag ' + (f.tag || (p && p.tag) || '')) : st.target === 'training' ? 'Training dataset ' + (f.name || '') : st.target === 'classifiers' ? 'Classifier eval set ' + (f.evalSet || '') : st.target === 'knowledge' ? 'Knowledge set ' + (f.kbId ? ((st.kbs || []).find((k) => k.id === f.kbId) || {}).name || '' : f.kbName || '') : 'Stored rows';
    return [['Source', esc(r ? r.name : '') + ', ' + esc(st.item || '')], ['Creates', esc(creates)], ['Size', p && p.sizeBytes != null ? bytes(p.sizeBytes) + (p.quota && p.quota.sample ? ', sampled to ' + num(p.quota.sample) + ' rows' : '') : 'unknown'], ['Licence', esc(p ? p.licence.id : '') + (p && p.licence.needsException ? ', exception requested' : '')], ['Label', esc(f.label || 'internal')]];
  }
  function stepConfirm(ctx, st) {
    const j = st.job;
    let body = UI.kv(summaryKv(st), 2);
    if (!j) body += '<div class="hstack gap6" style="margin-top:8px">' + UI.btn(st.starting ? 'Starting…' : 'Start import', { kind: 'primary', attrs: 'data-start', disabled: !!st.starting }) + UI.btn('Back to destination', { kind: 'ghost', attrs: 'data-step="destination"' }) + '</div>';
    else {
      const live = LIVE.includes(j.state);
      body += '<div class="divider"></div><div class="hstack"><b>' + esc(j.ref) + '</b>' + UI.pill(j.state, stateTone(j.state)) + '<span class="muted right" style="font-size:12px">' + esc(j.stage || j.note || '') + '</span></div>'
        + (live ? UI.meter(j.stage || 'Queued', j.progress + '%', j.progress, 'accent') : '') + UI.timeline((j.log || []).slice(-8).map((l) => ({ title: esc(l.title), meta: esc(l.meta), tone: l.tone })));
      if (j.state === 'complete') body += UI.notice('<b>' + esc(j.note || 'Done') + '</b>', 'ok', openButton(j)) + (j.result && j.result.warnings && j.result.warnings.length ? UI.notice(esc(j.result.warnings[0]), 'warn') : '');
      else if (j.state === 'refused' || j.state === 'failed') body += UI.notice('<b>' + esc(j.error || j.note || j.state) + '</b>', 'danger', j.state === 'failed' ? UI.btn('Retry', { size: 'sm', attrs: 'data-retry="' + esc(j.id) + '"' }) : '');
      else if (j.state === 'waiting on licence') body += UI.notice('Waiting on the legal-review decision; the import continues when the exception is granted.', 'warn');
      body += '<div class="hstack gap6" style="margin-top:8px">' + (live ? UI.btn('Cancel import', { kind: 'danger', size: 'sm', attrs: 'data-cancel="' + esc(j.id) + '"' }) : '') + UI.btn('Import another', { kind: 'ghost', size: 'sm', attrs: 'data-another' }) + UI.btn('Imports queue', { kind: 'ghost', size: 'sm', attrs: 'data-gotab="imports"' }) + '</div>';
    }
    return '<div class="vstack gap12">' + UI.panel('Summary', body) + '</div>';
  }
  function openButton(j) {
    if (j.kind === 'model' && j.target === 'classifiers' && j.classifierId) return UI.btn('Open in Classifiers', { size: 'sm', attrs: 'data-open="classifiers" data-id="' + esc(j.classifierId) + '"' });
    if (j.kind === 'model') return UI.btn('Open in Models', { size: 'sm', attrs: 'data-open="models" data-id="' + esc(j.model ? j.model.name : '') + '"' });
    if (j.target === 'training') return UI.btn('Open in Training', { size: 'sm', attrs: 'data-open="training"' });
    if (j.target === 'classifiers') return UI.btn('Open in Classifiers', { size: 'sm', attrs: 'data-open="classifiers" data-id="' + esc(j.classifierId || '') + '"' });
    if (j.target === 'knowledge') return UI.btn('Open knowledge set', { size: 'sm', attrs: 'data-open="knowledge" data-id="' + esc(j.kbId || '') + '"' });
    return '';
  }

  // ---------- Imports and Repositories tabs, inspector ----------
  function tabImports(st) {
    const q = (st.jobQuery || '').toLowerCase();
    const list = (st.imports || []).filter((j) => !q || (j.ref + ' ' + j.item + ' ' + (j.repository.name || '') + ' ' + j.target + ' ' + j.state).toLowerCase().includes(q));
    const c = st.counts || {};
    return '<div class="toolbar">' + UI.search('Filter imports', 'data-jobsearch', st.jobQuery) + '<span class="muted right" style="font-size:12px">' + num(c.total) + ' imports · ' + num(c.running) + ' running · ' + num(c.waiting) + ' waiting · ' + num(c.queued) + ' queued</span></div>'
      + UI.table(['Import', 'Kind', 'Item', 'Source', 'Creates', 'Progress', 'State', 'Started', 'By'], list.map((j) => ({ cells: ['<b>' + esc(j.ref) + '</b>', esc(j.kind), '<span class="mono">' + esc(j.itemName || j.item) + '</span>', esc(j.repository.name || ''), esc(j.note && j.state === 'complete' ? j.note : j.target), LIVE.includes(j.state) ? UI.meter('', j.progress + '%', j.progress, 'accent') : '', UI.pill(j.state, stateTone(j.state)), esc(when(j.startedAt || j.createdAt)), esc(j.requestedByName || '')], attrs: 'data-job="' + esc(j.id) + '" class="row' + (st.jobSel === j.id ? ' active' : '') + '" tabindex="0"' })), { clickable: true, minWidth: '1000px', emptyTitle: 'No imports yet', emptyText: 'Start one under New import.' })
      + UI.notice('Every import records its source, revision, digest or hash, licence and the requester on a signed manifest, and writes an audit entry. Refused imports write nothing.', 'info');
  }
  function tabRepos(st) {
    const repos = st.repos || [];
    return '<div class="toolbar"><span class="fg2">' + repos.filter((r) => r.status === 'reachable' && r.state === 'active').length + ' of ' + repos.length + ' repositories reachable</span><span class="right">' + (App.can('imports:repositories') ? UI.btn('Add repository', { kind: 'primary', attrs: 'data-addrepo' }) : '') + '</span></div>'
      + UI.table(['Repository', 'Region', 'Offers', 'Protocol', 'Credential', 'Snapshot', 'State'], repos.map((r) => ({ cells: ['<b>' + esc(r.name) + '</b><div class="muted mono" style="font-size:11px">' + esc(r.host) + '</div>', esc(r.region), esc(r.kinds.map((k) => k + 's').join(', ')), '<span style="font-size:12px">' + esc(r.protocol) + '</span>', r.credential && r.credential.recorded ? 'recorded' : r.credential && r.credential.required ? UI.pill('needed', 'warn') : 'none', r.snapshotAt ? esc(when(r.snapshotAt)) + ' · ' + num(r.snapshotItems) : '', UI.pill(r.state === 'active' ? r.status : r.state, repoTone(r))], attrs: 'data-reporow="' + esc(r.id) + '" class="row' + (st.repoSel === r.id ? ' active' : '') + '" tabindex="0"' })), { clickable: true, minWidth: '960px', emptyTitle: 'No repositories', emptyText: 'Add one: a Hugging Face compatible hub, an Ollama registry, a CKAN or DCAT-AP portal, an SDMX provider, OpenML, InvenioRDM, Kaggle or the bundle share.' })
      + UI.notice('A repository is proposed by one admin and confirmed by another before its hosts join the staging-proxy allow-list and it is harvested. Credentials live in the vault.', 'info');
  }
  function inspector(st) {
    if (st.tab === 'imports') {
      const j = (st.imports || []).find((x) => x.id === st.jobSel) || (st.imports || [])[0];
      if (!j) return '<aside class="inspector w360">' + UI.empty('No import selected', 'Pick one from the queue.') + '</aside>';
      const live = LIVE.includes(j.state);
      return '<aside class="inspector w360"><div class="hstack"><b>' + esc(j.ref) + '</b>' + UI.pill(j.state, stateTone(j.state)) + '</div><div class="imp-name">' + esc(j.itemName || j.item) + '</div>'
        + UI.kv([['Source', esc(j.repository.name || '')], ['Creates', esc(j.target)], ['Licence', esc(j.licence || '') + (j.licenceStatus !== 'allowed' ? ' (' + esc(j.licenceStatus) + ')' : '')], ['Label', UI.label(j.label, { sm: true })], ['Size', j.kind === 'dataset' ? num(j.rowsTotal) + ' rows' + (j.sampleRows ? ' (sample ' + num(j.sampleRows) + ')' : '') : bytes(j.sizeBytes)], ['Started', esc(when(j.startedAt))], ['By', esc(j.requestedByName || '')], ['Note', esc(j.note || '')]], 1)
        + (live ? UI.meter(j.stage || 'Queued', j.progress + '%', j.progress, 'accent') : '') + UI.timeline((j.log || []).slice(-6).map((l) => ({ title: esc(l.title), meta: esc(l.meta), tone: l.tone })))
        + '<div class="hstack wrap gap6">' + (live ? UI.btn('Cancel', { kind: 'danger', size: 'sm', attrs: 'data-cancel="' + esc(j.id) + '"' }) : '') + (j.state === 'failed' || j.state === 'cancelled' ? UI.btn('Retry', { size: 'sm', attrs: 'data-retry="' + esc(j.id) + '"' }) : '') + UI.btn('Log', { size: 'sm', attrs: 'data-log="' + esc(j.id) + '"' }) + (j.state === 'complete' ? openButton(j) : '') + '</div></aside>';
    }
    if (st.tab === 'repos') {
      const r = (st.repos || []).find((x) => x.id === st.repoSel) || (st.repos || [])[0];
      if (!r) return '<aside class="inspector w360">' + UI.empty('No repository', 'Add one to import from.') + '</aside>';
      const can = App.can('imports:repositories');
      const mine = App.me && r.requestedBy === App.me.id;
      return '<aside class="inspector w360"><div class="hstack"><b>' + esc(r.name) + '</b>' + UI.pill(r.state === 'active' ? r.status : r.state, repoTone(r)) + '</div><div class="muted mono" style="font-size:12px">' + esc(r.baseUrl) + '</div>'
        + UI.kv([['Type', esc(r.typeName)], ['Region', esc(r.region)], ['Offers', esc(r.kinds.join(', '))], ['Protocol', esc(r.protocol)], ['Credential', r.credential && r.credential.recorded ? esc(r.credential.ref || 'recorded') : 'none'], ['Hosts', esc([r.host].concat(r.extraHosts || []).join(', '))], ['Harvest', r.harvestMinutes ? 'every ' + r.harvestMinutes + ' min' : 'manual'], ['Snapshot', r.snapshotAt ? esc(when(r.snapshotAt)) + ', ' + num(r.snapshotItems) + ' items' : 'none yet'], ['Status', esc(r.statusDetail || '')], ['Licence policy', esc(r.licencePolicy || '')]], 1)
        + (r.state === 'pending' ? UI.notice(mine ? 'You proposed this repository; a second admin confirms it.' : 'Proposed by another admin: confirm or reject it.', 'warn') : '')
        + '<div class="hstack wrap gap6">' + (can && r.state === 'pending' && !mine ? UI.btn('Confirm', { kind: 'primary', size: 'sm', attrs: 'data-repoact="confirm"' }) + UI.btn('Reject', { kind: 'danger', size: 'sm', attrs: 'data-repoact="reject"' }) : '') + (can && r.state === 'active' ? UI.btn('Check', { size: 'sm', attrs: 'data-repoact="check"' }) + UI.btn('Harvest now', { size: 'sm', attrs: 'data-repoact="harvest"' }) + UI.btn('Disable', { size: 'sm', attrs: 'data-repoact="disable"' }) : '') + (can && r.state === 'disabled' ? UI.btn('Enable', { size: 'sm', attrs: 'data-repoact="enable"' }) : '') + (can && r.state !== 'rejected' ? UI.btn('Edit', { size: 'sm', attrs: 'data-editrepo' }) + UI.btn('Remove', { kind: 'ghost', size: 'sm', attrs: 'data-repoact="remove"' }) : '') + '</div></aside>';
    }
    const r = repoOf(st);
    const d = st.detail;
    if (!d || !st.item) return '<aside class="inspector w360">' + (r ? '<div class="hstack"><b>' + esc(r.name) + '</b>' + UI.pill(r.state === 'active' ? r.status : r.state, repoTone(r)) + '</div>' + UI.kv([['Protocol', esc(r.protocol)], ['Region', esc(r.region)], ['Snapshot', r.snapshotAt ? esc(when(r.snapshotAt)) : 'none'], ['Licence policy', esc(r.licencePolicy || '')]], 1) : UI.empty('Choose a repository', 'The inspector shows the repository, then the item you select.')) + (st.quota ? UI.kv([['Dataset quota', bytes(st.quota.usedBytes.datasets) + ' of ' + bytes(st.quota.maxBytes) + ' used']], 1) : '') + '</aside>';
    const kv = isModel(st) ? [['Revision', '<span class="mono">' + esc(String(d.revision || '').slice(0, 19)) + '</span>'], ['Licence', esc(d.licence || 'not stated')], ['Classification', esc(d.classification || '')], ['Parameters', esc(d.parameters || '')], ['Files', num((d.files || []).length)], ['Variants', num((d.variants || []).length)]] : [['Publisher', esc(d.publisher || '')], ['Licence', esc(d.licence || 'not stated')], ['Updates', esc(d.frequency || '')], ['Resources', num(d.resources.length)], ['Selected', esc(selectedResources(st).map((x) => x.name).join(', ') || 'none')]];
    return '<aside class="inspector w360"><div class="imp-name">' + esc(d.name || st.item) + '</div><div class="mono muted" style="font-size:12px">' + esc(st.item) + '</div>' + (d.description ? '<p class="fg2" style="margin:0;font-size:13px">' + esc(String(d.description).slice(0, 400)) + '</p>' : '') + UI.kv(kv, 1) + (d.landingPage ? '<a class="mono" style="font-size:12px" href="' + esc(d.landingPage) + '" target="_blank" rel="noopener">Open the card on the source</a>' : '') + '</aside>';
  }

  // ---------- the running import ----------
  function pollJob(ctx, st) {
    if (!st.running || st.pollTimer) return;
    st.pollTimer = setTimeout(async () => {
      st.pollTimer = null;
      try {
        const j = await App.get('/api/imports/' + enc(st.running));
        st.job = j;
        await reloadImports(st).catch(() => undefined);
        if (!LIVE.includes(j.state)) { st.running = null; if (App.state.route === 'import') App.toast('<b>' + esc(j.ref) + '</b> ' + esc(j.state) + (j.note ? ': ' + esc(j.note) : '') + '.', j.state === 'complete' ? 'ok' : 'danger', 6000); }
      } catch (err) { st.running = null; st.jobError = err; }
      if (App.state.route === 'import' && !overlayOpen()) ctx.rerender(); else st.dirty = true;
    }, 1200);
  }

  App.register({
    id: 'import', title: 'Import', section: 'admin', crumb: (st) => ['Admin', 'Import', st.tab === 'imports' ? 'Imports' : st.tab === 'repos' ? 'Repositories' : (STEPS.find((s) => s[0] === st.step) || STEPS[0])[1]], live: true,
    summary: 'Model and dataset import wizard: browse repositories, record licence and label, register draft models, dataset versions, classifier eval sets and knowledge sets',
    commands: [
      { label: 'Import a model from a repository', sub: 'Import', run(app) { reset(app.stateFor('import'), 'model', 'models'); app.render(); } },
      { label: 'Import a dataset', sub: 'Import', run(app) { reset(app.stateFor('import'), 'dataset', 'training'); app.render(); } },
      { label: 'Create a knowledge set from a dataset', sub: 'Import', run(app) { reset(app.stateFor('import'), 'dataset', 'knowledge'); app.render(); } },
      { label: 'Imports queue', sub: 'Import', run(app) { app.stateFor('import').tab = 'imports'; app.render(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.loadKey && !st.loadError) load(ctx, st);
      const sig = JSON.stringify(ctx.params);
      if (sig !== '{}' && sig !== st.lastParams) {
        st.lastParams = sig; const p = ctx.params;
        if (p.tab) { if (!st.tab) reset(st); st.tab = p.tab; if (p.import) st.jobSel = p.import; }
        else { reset(st, p.kind || 'model', p.target); if (p.repo) { st.repo = p.repo; st.step = 'browse'; } if (p.item && p.repo) { st.item = p.item; st.step = 'select'; } }
      }
      if (!st.tab) reset(st);
      if (st.running) pollJob(ctx, st);
      // The inspector shows the picked item from the browse step on; its details load once.
      if (st.tab === 'new' && st.item && st.loadKey) loadDetail(ctx, st);
      if (st.loadError) { root.innerHTML = '<div class="page">' + UI.pagehead('Import models and datasets', '') + UI.problem('Import could not be loaded', detailOf(st.loadError), traceOf(st.loadError)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-reload' }) + '</div></div>'; ctx.on('click', '[data-reload]', () => { st.loadError = null; st.loadKey = null; ctx.rerender(); }); return; }
      if (!st.loadKey) { root.innerHTML = '<div class="page">' + UI.pagehead('Import models and datasets', 'Loading…') + '</div>'; return; }
      // The destination step needs the knowledge bases and embedding models once.
      if (st.tab === 'new' && st.step === 'destination' && st.target === 'knowledge' && !st.kbs && !st.kbsBusy) {
        st.kbsBusy = true;
        Promise.all([App.get('/api/knowledge/bases').catch(() => []), App.get('/api/knowledge/models').catch(() => [])]).then(([kbs, models]) => { st.kbs = kbs; st.embedModels = ((models && models.embedding) || []).map((m) => m.name).filter(Boolean); }).finally(() => { st.kbsBusy = false; if (App.state.route === 'import' && !overlayOpen()) ctx.rerender(); });
      }
      const stepIdx = STEPS.findIndex((s) => s[0] === st.step);
      const p = st.plan;
      const canNext = { source: !!st.repo && (repoOf(st) || {}).state === 'active', browse: !!st.item, select: !!st.detail && (isModel(st) ? !(st.detail.gated && st.detail.access !== 'granted') : selectedResources(st).length > 0), review: !!p && !p.blocked && !(p.licence && (p.licence.id === 'unknown' || p.licence.id === 'other')) && !(p.licence && p.licence.needsException && !st.form.exception), destination: isModel(st) ? true : st.target === 'training' ? !!st.form.name : st.target === 'classifiers' ? !!(st.form.evalSet && (st.form.textCol || columnsOf(st)[0]) && (st.form.labelCol || columnsOf(st)[0])) : st.target === 'knowledge' ? !!(st.form.kbId || (st.form.kbName || (st.detail && st.detail.name)) && (st.form.embed || (st.embedModels || [])[0])) : true }[st.step];
      const stepper = '<div class="imp-steps" role="list">' + STEPS.map((s, i) => '<button type="button" role="listitem" data-step="' + s[0] + '" class="' + (s[0] === st.step ? 'cur' : i < stepIdx ? 'done' : '') + '"' + (i > stepIdx ? ' disabled' : '') + (s[0] === st.step ? ' aria-current="step"' : '') + '><span class="n">' + (i + 1) + '</span>' + esc(s[1]) + '</button>').join('') + '</div>';
      const titles = { source: 'Choose where to import from', browse: 'Browse ' + (repoOf(st) ? repoOf(st).name : ''), select: 'Select from ' + (st.detail ? st.detail.name : st.item || ''), review: 'Policy checks, licence and label', destination: 'Where it lands', confirm: 'Confirm and start' };
      const stepBody = st.tab !== 'new' ? '' : st.step === 'source' ? stepSource(st) : st.step === 'browse' ? stepBrowse(ctx, st) : st.step === 'select' ? stepSelect(ctx, st) : st.step === 'review' ? stepReview(ctx, st) : st.step === 'destination' ? stepDestination(ctx, st) : stepConfirm(ctx, st);
      const footer = st.step === 'confirm' ? '' : '<div class="imp-foot">' + UI.btn('Back', { attrs: 'data-back', disabled: stepIdx === 0 }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-cancelwiz' }) + '<span class="grow"></span>' + UI.btn('Next', { kind: 'primary', attrs: 'data-next', disabled: !canNext }) + '</div>';
      const wizard = stepper + '<div class="panel"><div class="phead"><div class="eyebrow">Step ' + (stepIdx + 1) + ' of 6</div><span class="fg2" style="font-weight:600">' + esc(titles[st.step]) + '</span></div>' + stepBody + footer + '</div>';
      root.innerHTML = '<style>'
        + '#main .imp-steps{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:10px}#main .imp-steps button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:5px;background:transparent;font:inherit;font-size:12px;font-weight:500;color:var(--muted);cursor:pointer}#main .imp-steps button .n{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--line);font-size:11px}#main .imp-steps button.cur{color:var(--fg);background:var(--panel2)}#main .imp-steps button.cur .n,#main .imp-steps button.done .n{background:var(--panel2);color:var(--fg);border-color:var(--accent);font-weight:600}#main .imp-steps button:disabled{cursor:default;opacity:.6}'
        + '#main .imp-repos{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}#main .imp-repo{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);text-align:left;font:inherit;color:var(--fg);cursor:pointer}#main .imp-repo.on{outline:2px solid var(--accent);outline-offset:-1px}#main .imp-repo.off{opacity:.65}'
        + '#main .imp-browse{display:grid;gap:14px;grid-template-columns:200px minmax(0,1fr)}#main .imp-facets{display:flex;flex-direction:column;gap:12px}#main .imp-facets .listlink{padding:4px 8px}'
        + '#main .imp-foot{display:flex;align-items:center;gap:8px;padding-top:10px;border-top:1px solid var(--line);margin-top:10px}#main .imp-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}'
        + '@media (max-width:1100px){#main .imp-browse{grid-template-columns:1fr}#main .imp-facets{flex-direction:row;flex-wrap:wrap}}'
        + '</style>'
        + '<div class="page">'
        + UI.pagehead('Import models and datasets', 'Browse repositories, record licence and label, and register the result in the catalogue, under Training, Classifiers or as a knowledge set', UI.btn('New import', { kind: st.tab === 'new' ? 'ghost' : 'primary', attrs: 'data-newimport' }))
        + UI.tabs([{ id: 'new', label: 'New import' }, { id: 'imports', label: 'Imports', count: (st.imports || []).length }, { id: 'repos', label: 'Repositories', count: (st.repos || []).length }], st.tab)
        + (st.tab === 'new' ? wizard : st.tab === 'imports' ? tabImports(st) : tabRepos(st))
        + '</div>'
        + inspector(st);

      const go = (step) => { st.step = step; ctx.rerender(); };
      const fail = (err, what) => App.fail(err, what);
      ctx.on('click', '.tabs [data-tab]', (e, t) => { st.tab = t.dataset.tab; if (st.tab === 'imports') reloadImports(st).then(() => ctx.rerender()).catch(() => undefined); ctx.rerender(); });
      ctx.on('click', '[data-gotab]', (e, t) => { st.tab = t.dataset.gotab; ctx.rerender(); });
      ctx.on('click', '[data-newimport], [data-another]', () => { reset(st, st.kind); ctx.rerender(); });
      ctx.on('click', '[data-cancelwiz]', async () => { if (!st.repo || await ctx.confirm({ title: 'Discard this import?', body: '<p class="fg2" style="margin:0">Nothing has been fetched. The selection and form are cleared.</p>', ok: 'Discard', tone: 'danger' })) { reset(st, st.kind); ctx.rerender(); } });
      ctx.on('click', '[data-step]', (e, t) => { if (!t.disabled) go(t.dataset.step); });
      ctx.on('click', '[data-back]', () => go(STEPS[Math.max(0, stepIdx - 1)][0]));
      ctx.on('click', '[data-next]', () => { if (canNext) go(STEPS[Math.min(STEPS.length - 1, stepIdx + 1)][0]); });
      ctx.on('click', '[data-kindseg] button', (e, t) => { reset(st, t.dataset.seg, t.dataset.seg === 'model' ? 'models' : 'training'); ctx.rerender(); });
      ctx.on('click', '[data-repo]', (e, t) => { const r = repoOf(st, t.dataset.repo); if (!r) return; if (r.state !== 'active') { ctx.toast('<b>' + esc(r.name) + '</b> is ' + esc(r.state) + '. ' + (r.state === 'pending' ? 'A second admin confirms it under Repositories.' : 'Enable it under Repositories.'), 'warn'); return; } st.repo = r.id; st.item = null; st.detail = null; st.detailKey = null; st.browse = null; st.browseKey = null; st.facets = {}; st.picked = {}; st.plan = null; st.planKey = null; ctx.rerender(); });
      ctx.on('dblclick', '[data-repo]', (e, t) => { if (st.repo === t.dataset.repo) go('browse'); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; clearTimeout(st.searchTimer); st.searchTimer = setTimeout(() => { const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } }, 300); });
      ctx.on('click', '[data-facet]', (e, t) => { st.facets[t.dataset.facet] = st.facets[t.dataset.facet] === t.dataset.v ? null : t.dataset.v; ctx.rerender(); });
      ctx.on('click', '[data-clearfacet]', (e, t) => { st.facets[t.dataset.clearfacet] = null; ctx.rerender(); });
      const pickItem = (id) => { st.item = id; st.detail = null; st.detailKey = null; st.picked = {}; st.plan = null; st.planKey = null; st.form = Object.assign({}, st.form, { tag: '', name: '' }); ctx.rerender(); };
      ctx.on('click', 'tr.row[data-item]', (e, t) => pickItem(t.dataset.item));
      ctx.on('keydown', 'tr.row[data-item]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickItem(t.dataset.item); } });
      ctx.on('dblclick', 'tr.row[data-item]', () => go('select'));
      ctx.on('click', '[data-retrydetail]', () => { st.detailError = null; st.detailKey = null; ctx.rerender(); });
      ctx.on('change', '[data-pick]', (e, t) => { st.picked[t.dataset.pick] = t.checked; st.plan = null; st.planKey = null; ctx.rerender(); });
      ctx.on('click', '[data-gate]', async () => { const r = repoOf(st); st.gateBusy = true; ctx.rerender(); try { await App.post('/api/imports/repositories/' + enc(r.id) + '/gate', { item: st.item }); st.detailKey = null; st.detail = null; ctx.toast('Gate accepted with the recorded token; the files are listed now.', 'ok'); } catch (err) { fail(err, 'The gate was not accepted'); } st.gateBusy = false; ctx.rerender(); });
      ctx.on('input', '[data-f]', (e, t) => { st.form[t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value; if (['licence', 'label', 'attribution', 'sample', 'exception', 'exceptionReason'].includes(t.dataset.f)) { clearTimeout(st.planTimer); st.planTimer = setTimeout(() => { st.planKey = null; if (st.step === 'review') ctx.rerender(); }, 600); } });
      ctx.on('change', '[data-f]', (e, t) => { st.form[t.dataset.f] = t.type === 'checkbox' ? t.checked : t.value; if (t.tagName === 'SELECT' || t.type === 'checkbox') { st.planKey = null; ctx.rerender(); } });
      ctx.on('click', '[data-targetseg] button', (e, t) => { st.target = t.dataset.seg; st.planKey = null; ctx.rerender(); });
      ctx.on('click', '[data-start]', async () => {
        st.starting = true; ctx.rerender();
        try {
          const j = await App.post(isModel(st) ? '/api/imports' : '/api/imports/datasets', Object.assign(planBody(st), isModel(st) ? {} : { final: true }));
          st.job = j; st.running = LIVE.includes(j.state) ? j.id : null; st.starting = false;
          await reloadImports(st).catch(() => undefined);
          ctx.toast('<b>' + esc(j.ref) + '</b> ' + (j.state === 'waiting on licence' ? 'waits on legal review.' : j.state === 'queued for bundle' ? 'queued for the bundle.' : 'started. Audit entry written.'), 'ok');
        } catch (err) {
          st.starting = false;
          const p = err && err.problem;
          if (p && p.import) { st.job = p.import; await reloadImports(st).catch(() => undefined); ctx.toast('<b>' + esc(p.import.ref) + '</b> refused: ' + esc(p.detail || ''), 'danger', 6000); } else fail(err, 'The import was not started');
        }
        ctx.rerender();
      });
      ctx.on('click', '[data-open]', (e, t) => { const r = t.dataset.open; const id = t.dataset.id; ctx.navigate(r, r === 'models' ? { model: id } : r === 'training' ? { tab: 'datasets' } : r === 'classifiers' ? { classifier: id } : r === 'knowledge' ? { kb: id } : {}); });
      ctx.on('click', '[data-cancel]', async (e, t) => { const ok = await ctx.confirm({ title: 'Cancel this import?', tone: 'danger', body: '<p class="fg2" style="margin:0">Partial downloads are discarded; nothing is registered.</p>', ok: 'Cancel import' }); if (!ok) return; try { const j = await App.post('/api/imports/' + enc(t.dataset.cancel) + '/cancel'); if (st.job && st.job.id === j.id) { st.job = j; st.running = null; } await reloadImports(st); ctx.toast('<b>' + esc(j.ref) + '</b> cancelled.', 'ok'); } catch (err) { fail(err, 'Not cancelled'); } ctx.rerender(); });
      ctx.on('click', '[data-retry]', async (e, t) => { try { const j = await App.post('/api/imports/' + enc(t.dataset.retry) + '/retry'); if (st.job && st.job.id === j.id) { st.job = j; st.running = j.id; } await reloadImports(st); ctx.toast('<b>' + esc(j.ref) + '</b> retried; downloads resume from the parts already stored.', 'ok'); } catch (err) { fail(err, 'Not retried'); } ctx.rerender(); });
      ctx.on('input', '[data-jobsearch]', (e, t) => { st.jobQuery = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-jobsearch]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', 'tr.row[data-job]', (e, t) => { st.jobSel = t.dataset.job; ctx.rerender(); });
      ctx.on('keydown', 'tr.row[data-job]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.jobSel = t.dataset.job; ctx.rerender(); } });
      ctx.on('click', '[data-log]', (e, t) => { const j = (st.imports || []).find((x) => x.id === t.dataset.log); if (!j) return; ctx.drawer({ title: 'Import log, ' + esc(j.ref), body: UI.kv([['Item', '<span class="mono">' + esc(j.item) + '</span>'], ['Source', esc(j.repository.name || '')], ['Creates', esc(j.target)], ['State', UI.pill(j.state, stateTone(j.state))], ['Manifest', j.manifest ? '<span class="mono" style="font-size:11px">' + esc(JSON.stringify(j.manifest.signature || {})) + '</span>' : 'none yet']], 1) + UI.timeline((j.log || []).map((l) => ({ title: esc(l.title) + ' <span class="muted" style="font-size:11px">' + esc(when(l.at)) + '</span>', meta: esc(l.meta), tone: l.tone }))) + (j.checks && j.checks.length ? '<div class="eyebrow" style="margin-top:10px">Checks at request time</div>' + UI.table(['Check', 'Result', 'Detail'], j.checks.map((c) => [esc(c.name), UI.pill(c.result, checkTone(c)), '<span class="fg2">' + esc(c.detail) + '</span>']), { clickable: false }) : ''), onMount(m) { App.a11yPass(m); } }); });
      // repositories
      ctx.on('click', 'tr.row[data-reporow]', (e, t) => { st.repoSel = t.dataset.reporow; ctx.rerender(); });
      ctx.on('keydown', 'tr.row[data-reporow]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.repoSel = t.dataset.reporow; ctx.rerender(); } });
      ctx.on('click', '[data-repoact]', async (e, t) => {
        const r = (st.repos || []).find((x) => x.id === st.repoSel) || (st.repos || [])[0]; if (!r) return;
        const act = t.dataset.repoact;
        try {
          if (act === 'remove') { if (!(await ctx.confirm({ title: 'Remove ' + esc(r.name) + '?', tone: 'danger', body: '<p class="fg2" style="margin:0">Its snapshot is dropped and its hosts leave the allow-list. Past imports keep their manifests.</p>', ok: 'Remove' }))) return; await App.del('/api/imports/repositories/' + enc(r.id)); ctx.toast('<b>' + esc(r.name) + '</b> removed.', 'ok'); }
          else if (act === 'harvest') { await App.post('/api/imports/repositories/' + enc(r.id) + '/harvest'); ctx.toast('Snapshot refresh queued for <b>' + esc(r.name) + '</b>.', 'ok'); }
          else if (act === 'check') { const out = await App.post('/api/imports/repositories/' + enc(r.id) + '/check'); ctx.toast('<b>' + esc(r.name) + '</b>: ' + esc(out.statusDetail || out.status), out.status === 'reachable' ? 'ok' : 'warn'); }
          else { const out = await App.post('/api/imports/repositories/' + enc(r.id) + '/' + act, {}); ctx.toast('<b>' + esc(r.name) + '</b> ' + esc(out.state === 'active' ? (act === 'confirm' ? 'confirmed; harvest queued' : 'enabled') : out.state) + '.', 'ok'); }
          await reloadRepos(st);
        } catch (err) { fail(err, 'Repository change failed'); }
        ctx.rerender();
      });
      const typeOptions = () => (st.types || []).map((x) => ({ value: x.type, label: x.name + (x.example ? ' (' + x.example.replace(/^https?:\/\//, '').split('/')[0] + ')' : '') }));
      ctx.on('click', '[data-addrepo]', () => ctx.modal({ title: 'Add repository', cls: 'wide', body: '<div class="formgrid" style="--cols:2">' + UI.field('Type', UI.select(typeOptions(), 'hf', 'data-rt aria-label="Type"')) + UI.field('Name', UI.input('', { placeholder: 'Hugging Face Hub', attrs: 'data-rn aria-label="Name"' })) + UI.field('Base URL', UI.input('', { placeholder: 'https://huggingface.co', attrs: 'data-ru aria-label="Base URL"' })) + UI.field('Region', UI.input('Global', { attrs: 'data-rr aria-label="Region"' })) + UI.field('Credential', UI.input('', { type: 'password', placeholder: 'token, key or username:key (kept in the vault)', attrs: 'data-rc aria-label="Credential"' })) + UI.field('Harvest', UI.select([{ value: '', label: 'manual' }, { value: '60', label: 'hourly' }, { value: '1440', label: 'daily' }, { value: '10080', label: 'weekly' }], '1440', 'data-rh aria-label="Harvest schedule"')) + '</div>' + UI.notice('Proposed now; a second admin confirms it before it is harvested and its hosts join the allow-list.', 'info'), actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn('Propose', { kind: 'primary', attrs: 'data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', async () => { const body = { type: m.querySelector('[data-rt]').value, name: m.querySelector('[data-rn]').value.trim(), region: m.querySelector('[data-rr]').value.trim() || 'Global' }; const u = m.querySelector('[data-ru]').value.trim(); if (u) body.baseUrl = u; const c = m.querySelector('[data-rc]').value; if (c) body.credential = c; const hv = m.querySelector('[data-rh]').value; body.harvestMinutes = hv ? Number(hv) : null; try { const out = await App.post('/api/imports/repositories', body); App.closeOverlay(); await reloadRepos(st); st.repoSel = out.id; st.tab = 'repos'; ctx.toast('<b>' + esc(out.name) + '</b> proposed; a second admin confirms it.', 'ok'); ctx.rerender(); } catch (err) { fail(err, 'Repository not proposed'); } }); } }));
      ctx.on('click', '[data-editrepo]', () => { const r = (st.repos || []).find((x) => x.id === st.repoSel) || (st.repos || [])[0]; if (!r) return; ctx.drawer({ title: 'Edit ' + esc(r.name), body: '<div class="vstack gap12">' + UI.field('Name', UI.input(r.name, { attrs: 'data-en aria-label="Name"' })) + UI.field('Region', UI.input(r.region, { attrs: 'data-er aria-label="Region"' })) + UI.field('Licence policy', UI.textarea(r.licencePolicy || '', { rows: 3, attrs: 'data-ep aria-label="Licence policy"' })) + UI.field('Harvest', UI.select([{ value: '', label: 'manual' }, { value: '60', label: 'hourly' }, { value: '1440', label: 'daily' }, { value: '10080', label: 'weekly' }], r.harvestMinutes ? String(r.harvestMinutes) : '', 'data-eh aria-label="Harvest schedule"')) + UI.field('Credential', UI.input('', { type: 'password', placeholder: 'leave empty to keep the recorded one', attrs: 'data-ec aria-label="Credential"' })) + '</div>', actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', async () => { const body = { name: m.querySelector('[data-en]').value.trim(), region: m.querySelector('[data-er]').value.trim(), licencePolicy: m.querySelector('[data-ep]').value.trim() || null }; const hv = m.querySelector('[data-eh]').value; body.harvestMinutes = hv ? Number(hv) : null; const c = m.querySelector('[data-ec]').value; if (c) body.credential = c; try { await App.patch('/api/imports/repositories/' + enc(r.id), body); App.closeOverlay(); await reloadRepos(st); ctx.toast('<b>' + esc(body.name) + '</b> saved.', 'ok'); ctx.rerender(); } catch (err) { fail(err, 'Not saved'); } }); } }); });
    }
  });
})();
