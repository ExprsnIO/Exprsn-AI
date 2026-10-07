(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l);
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const ago = (ms) => { if (!ms) return ''; const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
  const size = (n) => (n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const KIND = { upload: 'Upload', s3: 'S3 prefix', git: 'Git repository', database: 'Database table, view or collection', web: 'Internal web site' };
  const ENGINE = { postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB' };
  const csvList = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const REPL = { starting: 'starting', streaming: 'streaming changes', fallback: 'watermarks (replication unavailable)', stopped: 'stopped' };
  const SCHED = { '15m': 'every 15 min, incremental', hourly: 'hourly', daily: 'daily', manual: 'manual' };
  const BUSY_DOC = ['quarantined', 'scanning', 'queued', 'indexing'];
  const STORE = { db: 'table scan with cosine similarity in the database', pgvector: 'pgvector on PostgreSQL' };

  const srcName = (s) => (s.kind === 'upload' ? 'Uploads' : s.kind === 'git' ? 'git: ' + s.location : s.kind === 'database' ? (s.config.engine === 'mysql' ? 'mysql: ' : s.config.engine === 'mongodb' ? 'mongo: ' : 'pg: ') + (s.config.object || s.location) : s.location);
  const syncText = (s) => {
    if (s.kind === 'upload') return 'manual';
    if (s.state === 'syncing') return 'running';
    if (!s.lastSyncAt) return 'not synced yet';
    if (s.kind === 'git' && s.watermark) return 'commit ' + String(s.watermark).slice(0, 7);
    if (s.kind === 'database' && s.replication && s.replication.state === 'streaming') return 'replication, ' + (s.replication.lastChangeAt ? 'last change ' + ago(s.replication.lastChangeAt) : 'no change yet');
    if (s.kind === 'web') return 'crawl, ' + ago(s.lastSyncAt);
    if (s.kind === 'database' && s.config.roleMappings) return 'full read as ' + s.config.roleMappings.length + ' role' + (s.config.roleMappings.length === 1 ? '' : 's') + ', ' + ago(s.lastSyncAt);
    if (s.kind === 'database') return (s.config.watermarkColumn || 'full read') + (s.watermark ? ' ' + s.watermark : '') + ', ' + ago(s.lastSyncAt);
    return 'synced ' + ago(s.lastSyncAt);
  };
  const srcStatus = (s, quarantined) => (s.state === 'failed' ? 'failed' : s.state === 'syncing' ? 'syncing' : s.kind === 'upload' && quarantined ? quarantined + ' quarantined' : s.lastSyncAt || s.kind === 'upload' ? 'synced' : 'queued');
  const statePill = (s) => (s === 'indexed' || s === 'synced' || s === 'serving' ? UI.pill(s, 'ok') : s === 'syncing' || s === 'indexing' || s === 'queued' || s === 'scanning' || s === 'building' ? UI.pill(s, 'info') : /quarantin/.test(s) ? UI.pill(s, 'warn') : /failed|rejected/.test(s) ? UI.pill(s, 'danger') : UI.pill(s, ''));
  const docState = (d) => (d.state === 'failed' ? 'extraction failed' : d.state === 'unchanged' ? 'unchanged, skipped' : d.state);
  const origin = (d) => d.labelOrigin || 'inherited';

  function cur(st) { return (st.bases || []).find((k) => k.id === st.kb) || null; }

  App.register({
    id: 'knowledge', title: 'Knowledge', live: true, summary: 'Knowledge bases, sources, documents and labels, index, access, test search',
    crumb: (st) => ['Knowledge'].concat(cur(st) ? [cur(st).name] : []),
    label: (st) => (cur(st) ? cur(st).label : null),
    commands: [{ label: 'Add a knowledge source', sub: 'Knowledge', run(app) { app.stateFor('knowledge').openAdd = true; app.render(); } }],
    states: [
      { title: 'Index swap pending', tone: 'info', text: 'A new index builds beside the serving one, for example with a new embedding model. Retrieval keeps using the serving index until the atomic switch.', apply(ctx) { ctx.state.demo = 'swap'; ctx.rerender(); } },
      { title: 'Upload quarantined', tone: 'warn', text: 'An upload is held until the type check, malware scan and classification pass. It cannot be attached or indexed yet.', apply(ctx) { ctx.state.demo = 'quarantine'; ctx.rerender(); } },
      { title: 'Extraction failed', tone: 'danger', text: 'A document that could not be read (for example a password-protected PDF) shows the error, the trace ID and a retry action.', apply(ctx) { ctx.state.demo = 'failed'; ctx.rerender(); } },
      { title: 'Member view', tone: 'neutral', text: 'Members see sources and documents read-only, with no relabel or reindex actions.', apply(ctx) { ctx.state.member = true; ctx.state.tab = 'sources'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      st.tab = st.tab || 'sources'; st.filter = st.filter || ''; st.docq = st.docq || ''; st.query = st.query || '';
      st.detail = st.detail || {}; st.docs = st.docs || {}; st.access = st.access || {};
      // Re-rendering closes any open dialog, so data that arrives while one is open waits until it closes.
      const later = () => { if (App.state.route !== 'knowledge') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/knowledge/bases'), App.get('/api/knowledge/models').catch(() => null)])
          .then(([bases, models]) => { Object.assign(st, { bases, models, loaded: true, loadError: null }); if (st.kb && st.detail[st.kb]) loadKb(st.kb); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; later(); });
      };
      const loadKb = (id) => {
        if (!id || st.kbLoading === id) return;
        st.kbLoading = id;
        Promise.all([App.get('/api/knowledge/bases/' + enc(id)), App.get('/api/knowledge/bases/' + enc(id) + '/documents?limit=500')])
          .then(([d, docs]) => { st.detail[id] = d; st.docs[id] = docs; const i = (st.bases || []).findIndex((k) => k.id === id); if (i >= 0) st.bases[i] = Object.assign({}, st.bases[i], d); })
          .catch((err) => { st.detail[id] = { error: err }; })
          .finally(() => { st.kbLoading = null; later(); });
      };
      const loadAccess = (id) => { App.get('/api/knowledge/bases/' + enc(id) + '/access').then((a) => { st.access[id] = a; later(); }).catch((err) => { st.access[id] = { error: err }; later(); }); };
      if (!st.loaded && !st.loading) st.paramHash = null;
      if (!st.loaded && !st.loadError) load();
      const refresh = () => { load(); if (st.kb) loadKb(st.kb); if (st.kb && st.access[st.kb]) loadAccess(st.kb); };
      /** Runs one server call; refusals show as a toast with the problem's detail and trace. */
      const act = async (fn, okMsg) => {
        try { const r = await fn(); if (okMsg) toast(okMsg, 'ok', 5000); refresh(); return r || true; } catch (err) { App.fail(err); return null; }
      };

      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Knowledge', 'Knowledge bases, sources, documents and labels', '')
          + (st.loadError ? UI.problem('Knowledge bases could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }

      const bases = st.bases;
      // The shell re-reads the hash on every render, so a link's parameters apply once per visit.
      if (ctx.params.kb && st.paramHash !== location.hash) { st.kb = ctx.params.kb; st.paramHash = location.hash; }
      if (!bases.find((k) => k.id === st.kb)) st.kb = bases[0] ? bases[0].id : null;
      const curator = App.can('knowledge:manage');
      const models = st.models || { embedding: [], rerankers: [] };
      const myClearance = (App.me && App.me.user && App.me.user.clearance) || 'internal';
      const myLabels = LABELS.filter((l) => rank(l) <= rank(myClearance));

      // ---- demo states: find a base in live data that shows the state, or say why none does ----
      if (st.demo) {
        const d = st.demo; st.demo = null; st.demoNote = null; st.member = false;
        if (d === 'swap') { const b = bases.find((k) => k.building); if (b) { st.kb = b.id; st.tab = 'index'; } else st.demoNote = 'No index is building right now. Reindex starts a build beside the serving index; this page then shows its progress.'; }
        else if (d === 'quarantine') { const b = bases.find((k) => st.detail[k.id] && st.detail[k.id].quarantined); if (b) { st.kb = b.id; st.tab = 'documents'; st.docq = 'quarantined'; } else st.demoNote = 'Nothing is in quarantine. An upload waits there while its type, malware scan and classification are checked, usually for a few seconds.'; }
        else if (d === 'failed') { const b = bases.find((k) => (st.docs[k.id] || []).some((x) => x.state === 'failed')); if (b) { st.kb = b.id; st.tab = 'documents'; st.failedOpen = true; } else st.demoNote = 'No document failed extraction in the bases loaded so far.'; }
      }

      const kb = cur(st);
      if (kb && !st.detail[kb.id]) loadKb(kb.id);
      const det = kb ? st.detail[kb.id] : null;
      const manage = !st.member && kb && (curator || kb.access === 'manage');
      const docs = kb ? st.docs[kb.id] || [] : [];
      const sources = det && det.sources ? det.sources : [];
      const quarantinedDocs = docs.filter((x) => x.state === 'quarantined' || x.state === 'scanning');
      const busy = !!(kb && (kb.building || sources.some((s) => s.state === 'syncing') || docs.some((x) => BUSY_DOC.indexOf(x.state) >= 0)));
      if (busy && !st.poll) st.poll = setTimeout(() => { st.poll = null; if (App.state.route === 'knowledge' && st.kb) loadKb(st.kb); }, 3000);
      if (st.tab === 'access' && kb && !st.access[kb.id]) loadAccess(kb.id);
      const kbList = bases.filter((k) => !st.filter || k.name.toLowerCase().indexOf(st.filter.toLowerCase()) >= 0);
      const subOf = (k) => k.documents + ' document' + (k.documents === 1 ? '' : 's') + (k.building ? ', index swap pending' : k.lastSyncAt ? ', synced ' + ago(k.lastSyncAt) : '') + (k.status === 'draft' ? ', draft' : '');

      const sourcesTable = () => UI.table(['Source', 'Type', 'Sync', 'Documents', 'Status'], sources.map((s) => ({ cells: [s.kind === 'upload' ? 'Uploads' : '<span class="mono">' + esc(srcName(s)) + '</span>', esc(KIND[s.kind]), esc(syncText(s)), String(s.documents), statePill(srcStatus(s, quarantinedDocs.length))], attrs: 'data-src="' + esc(s.id) + '"' })), { minWidth: '0', emptyTitle: 'No sources yet', emptyText: 'Add an upload, S3 prefix, Git repository, database view or collection, or internal web site.' });
      const docsTable = (list) => UI.table(['Document', 'Label', 'Label origin', 'Chunks', 'State'], list.map((d) => ({ cells: [esc(d.name), UI.label(d.label, { sm: true }), esc(origin(d)), String(d.chunks), statePill(docState(d))], attrs: 'data-doc="' + esc(d.id) + '"', selected: st.failedOpen && d.state === 'failed' })), { minWidth: '0', emptyTitle: docs.length ? 'No documents match' : 'No documents yet', emptyText: docs.length ? 'Try another word.' : 'Add a source or upload a file. Documents appear as they are extracted.' });
      const failedDoc = docs.find((d) => d.state === 'failed');
      const failedPanel = st.failedOpen && failedDoc ? '<div class="problem"><div class="ptitle">Extraction failed for ' + esc(failedDoc.name) + '</div><div class="ptext">' + esc(failedDoc.error || 'The document could not be read.') + ' The document keeps its label and stays out of retrieval until a retry succeeds.</div><div class="trace"><span>Trace</span><span class="mono">' + esc(failedDoc.traceId || 'none') + '</span>' + (failedDoc.traceId ? UI.btn('Copy', { kind: 'ghost', size: 'sm', attrs: 'data-copy="' + esc(failedDoc.traceId) + '"' }) : '') + '<span class="right"></span>' + (manage ? UI.btn('Retry extraction', { size: 'sm', icon: 'refresh', attrs: 'data-retry="' + esc(failedDoc.id) + '"' }) : '') + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-dismissfail' }) + '</div></div>' : '';

      const res = kb && st.results && st.results.kb === kb.id ? st.results : null;
      const testSearch = () => '<section class="panel"><div class="phead"><div class="eyebrow">Test search</div><span class="muted" style="font-size:12px">Runs with your clearance: ' + esc(myClearance) + '. Chunks above it are filtered inside the query.</span></div>'
        + '<div class="hstack" style="align-items:flex-end"><div class="field grow"><label for="kb-q">Query</label><input class="input" id="kb-q" value="' + esc(st.query) + '" placeholder="What would a user ask?"></div><div>' + UI.btn(st.searching ? 'Searching…' : 'Search', { attrs: 'data-search', disabled: !!st.searching }) + '</div></div>'
        + (res && res.error ? UI.problem('Search failed', res.error.message, res.error.problem && res.error.problem.trace_id) : '')
        + (res && res.hits ? (res.vectorSkipped ? UI.notice('Vector ranking was skipped: ' + esc(res.vectorSkipped) + ' Keyword ranking still ran.', 'warn') : '')
          + UI.table(['Chunk', 'Vector', 'Full-text', 'Reranker', 'Label'], res.hits.map((c, i) => ({ cells: [esc(c.document) + (c.heading ? ', ' + esc(c.heading) : '') + (c.withheld ? ' ' + UI.pill('withheld', 'warn') : ''), c.vector == null ? '–' : c.vector.toFixed(2), c.keyword == null ? '–' : c.keyword.toFixed(2), c.rerank == null ? '–' : c.rerank.toFixed(2), UI.label(c.label, { sm: true })], attrs: 'data-chunk="' + i + '"' })), { minWidth: '0', emptyTitle: 'No chunks match', emptyText: 'Nothing in ' + kb.name + ' scores for this query at or below your clearance.' })
          + '<div class="muted" style="font-size:12px">Hybrid: vector similarity (' + esc(STORE[res.vectorStore] || res.vectorStore) + ') plus BM25 full-text, fused with reciprocal rank fusion' + (kb.reranker ? ', then reranked by ' + esc(kb.reranker) : '') + '. Chunks above ' + esc(res.ceiling) + ' were filtered by clearance before ranking.</div>' : '') + '</section>';

      const serving = kb && kb.serving;
      const building = kb && kb.building;
      const indexTab = () => (serving ? '<section class="panel"><div class="phead"><div class="eyebrow">Index v' + serving.version + '</div>' + UI.pill('serving', 'ok') + '</div>' + UI.kv([['Embedding model', '<span class="mono">' + esc(serving.embedModel) + '</span> via the gateway, cached by content hash for 30 days'], ['Vector index', esc(STORE[det && det.vectorStore] || 'database')], ['Full-text', 'BM25 over keyed-hash terms, filtered by label'], ['Chunks', String(serving.chunks)], ['Chunking', 'structure-aware, about ' + kb.chunking.tokens + ' tokens with ' + kb.chunking.overlap + ' overlap, headings kept as metadata'], ['Reranker', kb.reranker ? '<span class="mono">' + esc(kb.reranker) + '</span>' : 'none'], ['Last full build', esc(when(serving.builtAt) || 'not yet')], ['Label per chunk', 'the higher of the manual label, the source floor and the auto-classifier result']], 2) + (serving.message ? UI.notice(esc(serving.message), 'warn') : '') + '</section>' : UI.empty('No serving index', 'Reindex builds one.'))
        + (building ? '<section class="panel"><div class="phead"><div class="eyebrow">Index v' + building.version + ' building</div>' + UI.pill('building', 'info') + '</div>' + UI.meter('Embedding with ' + esc(building.embedModel), building.progress + '%' + (building.message ? ', ' + esc(building.message) : ''), building.progress, 'accent') + '<div class="fg2">Built beside v' + (serving ? serving.version : '?') + (serving && building.embedModel !== serving.embedModel ? ' with a new embedding model' : '') + '. Retrieval keeps using v' + (serving ? serving.version : '?') + ' until the switch, which is atomic.</div>' + (manage ? '<div class="hstack">' + UI.btn('Cancel build', { size: 'sm', attrs: 'data-cancelbuild' }) + '</div>' : '') + '</section>' : '')
        + (det && det.indexes && det.indexes.length ? UI.table(['Version', 'Embedding model', 'Chunks', 'State', 'Built'], det.indexes.map((i) => ['v' + i.version, '<span class="mono">' + esc(i.embedModel) + '</span>', String(i.chunks), statePill(i.state), esc(when(i.builtAt || i.createdAt)) + (i.error ? ' <span class="muted">' + esc(i.error) + '</span>' : '')]), { clickable: false, minWidth: '0' }) : '');

      const accessTab = () => {
        const a = kb ? st.access[kb.id] : null;
        if (!a) return UI.notice('Loading…', 'info');
        if (a.error) return UI.problem('Access could not be loaded', a.error.message, a.error.problem && a.error.problem.trace_id);
        const ws = kb.workspaceId && App.me && (App.me.workspaces || []).find((w) => w.id === kb.workspaceId);
        const rows = [['Knowledge curators', 'manage', 'role knowledge-curator', UI.pill('active', 'ok'), '']]
          .concat(kb.sharing === 'members' ? [[ws ? esc(ws.name) + ' members' : kb.workspaceId ? 'Workspace members' : 'Everyone in the tenant', 'read', kb.workspaceId ? 'workspace membership' : 'tenant-wide base', UI.pill('active', 'ok'), '']] : [])
          .concat(a.map((g) => [esc(g.name), esc(g.access), g.kind === 'profile' ? 'profile: retrieval in chat' : g.kind === 'workspace' ? 'shared with the workspace' : 'shared with the user', UI.pill('active', 'ok'), manage ? UI.btn('Remove', { kind: 'ghost', size: 'xs', attrs: 'data-unshare="' + esc(g.id) + '"' }) : '']));
        return UI.table(['Principal', 'Access', 'Via', 'State', ''], rows, { clickable: false, minWidth: '0' }) + UI.notice('Retrieval filters chunks above the reader\'s clearance inside the query, so a search never sees a chunk it may not return. Restricted chunks are returned only to principals with restricted clearance.', 'info') + (manage ? '<div>' + UI.btn('Add principal', { icon: 'plus', attrs: 'data-addprincipal' }) + '</div>' : '');
      };

      let body = '';
      if (!kb) body = UI.empty('No knowledge bases yet', curator ? 'Create one, then add an upload, S3 prefix, Git repository or Postgres view as a source.' : 'No knowledge base is shared with you or your workspace yet.', curator ? UI.btn('New knowledge base', { kind: 'primary', attrs: 'data-newkb' }) : '');
      else if (det && det.error) body = UI.problem('This knowledge base could not be loaded', det.error.message, det.error.problem && det.error.problem.trace_id);
      else if (!det) body = UI.notice('Loading…', 'info');
      else if (st.tab === 'sources') body = sourcesTable() + '<div class="hstack"><div class="eyebrow grow">Documents</div>' + UI.btn('All documents', { kind: 'ghost', size: 'sm', attrs: 'data-tab="documents"' }) + '</div>' + docsTable(docs.slice(0, 5)) + failedPanel + testSearch();
      else if (st.tab === 'documents') { const shown = docs.filter((d) => !st.docq || (d.name + ' ' + docState(d) + ' ' + d.label).toLowerCase().indexOf(st.docq.toLowerCase()) >= 0); body = '<div class="toolbar">' + UI.search('Search documents', 'data-docq', st.docq) + '<span class="muted" style="font-size:12px">' + shown.length + ' shown of ' + docs.length + ' documents at or below your clearance</span>' + (manage ? '<span class="right">' + UI.btn('Upload files', { size: 'sm', icon: 'upload', attrs: 'data-upload' }) + '</span>' : '') + '</div>' + docsTable(shown) + failedPanel; }
      else if (st.tab === 'index') body = indexTab();
      else if (st.tab === 'access') body = accessTab();
      else body = testSearch();

      root.innerHTML = '<style>.kb-list{display:flex;flex-direction:column;gap:2px}.kb-page > *{flex-shrink:0}.knowledge-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0 10px}</style>'
        + '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Knowledge bases</div>' + (curator && !st.member ? UI.btn('New', { size: 'sm', attrs: 'data-newkb' }) : '') + '</div>' + UI.search('Filter', 'data-filter', st.filter).replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="kb-list">' + kbList.map((k) => UI.listItem(esc(k.name), esc(subOf(k)), { active: kb && k.id === kb.id, attrs: 'data-kb="' + esc(k.id) + '"', right: UI.label(k.label, { sm: true }) })).join('') + (kbList.length || !bases.length ? '' : UI.empty('No knowledge base matches', 'Try another word.')) + '</div></div>'
        + '<div class="page kb-page">'
        + (st.member ? UI.notice('You are viewing as a member. Sources and documents are read-only; relabel, reindex and source changes need the knowledge curator role.', 'info', '<a href="#" data-leavemember>Back to curator view</a>') : '')
        + (st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-dismissnote' })) : '')
        + (kb ? UI.pagehead(esc(kb.name), 'Embedding ' + esc(kb.embedModel) + ', index v' + (serving ? serving.version : '–') + ', vector plus full-text · ' + UI.pill(kb.status, kb.status === 'published' ? 'ok' : '') + (kb.description ? '<div class="muted" style="font-size:12px">' + esc(kb.description) + '</div>' : ''),
          manage ? UI.btn('Edit', { kind: 'ghost', attrs: 'data-editkb' }) + (kb.status === 'draft' ? UI.btn('Publish', { attrs: 'data-publish' }) : '') + UI.btn('Reindex', { attrs: 'data-reindex' }) + UI.btn('Add source', { kind: 'primary', attrs: 'data-addsource' }) : '')
          + (kb.status === 'draft' ? UI.notice('This knowledge base is a draft. Chat retrieves only from published bases.', 'warn') : '')
          + (building && st.tab !== 'index' ? UI.notice('Index v' + building.version + ' is building beside v' + (serving ? serving.version : '?') + ': ' + building.progress + '% complete. Retrieval keeps using v' + (serving ? serving.version : '?') + ' until the atomic switch.', 'info', '<a href="#" data-tab="index">Index</a>') : '')
          + (quarantinedDocs.length ? UI.notice('<b>' + esc(quarantinedDocs[0].name) + '</b>' + (quarantinedDocs.length > 1 ? ' and ' + (quarantinedDocs.length - 1) + ' more are' : ' is') + ' held in quarantine until the malware scan and classification pass. It cannot be attached or indexed yet.', 'warn', '<a href="#" data-doc="' + esc(quarantinedDocs[0].id) + '">Details</a>') : '')
          + UI.tabs([{ id: 'sources', label: 'Sources' }, { id: 'documents', label: 'Documents' }, { id: 'index', label: 'Index' }, { id: 'access', label: 'Access' }, { id: 'test', label: 'Test search' }], st.tab) : UI.pagehead('Knowledge', 'Knowledge bases, sources, documents and labels', ''))
        + body
        + '</div>';

      // ---- events ----
      ctx.on('click', '[data-kb]', (e, t) => { st.kb = t.dataset.kb; st.failedOpen = false; st.docq = ''; ctx.rerender(); });
      ctx.on('input', '[data-filter]', (e, t) => { st.filter = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-filter]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('input', '[data-docq]', (e, t) => { st.docq = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-docq]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-tab]', (e, t) => { e.preventDefault(); st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-leavemember]', (e) => { e.preventDefault(); st.member = false; ctx.rerender(); });
      ctx.on('click', '[data-dismissnote]', () => { st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-dismissfail]', () => { st.failedOpen = false; ctx.rerender(); });
      ctx.on('click', '[data-copy]', (e, t) => { if (navigator.clipboard) navigator.clipboard.writeText(t.dataset.copy).then(() => toast('Trace ID copied.'), () => toast('Copy failed.', 'warn')); });
      if (!kb) { ctx.on('click', '[data-newkb]', () => newKb()); if (st.openAdd) st.openAdd = false; return; }

      const search = async () => {
        const i = ctx.$('#kb-q'); if (i) st.query = i.value;
        if (!st.query.trim()) { toast('Type a query first.'); return; }
        st.searching = true; ctx.rerender();
        try { const r = await App.post('/api/knowledge/search', { kbIds: [kb.id], query: st.query.trim(), k: 10 }); st.results = Object.assign({ kb: kb.id }, r); }
        catch (err) { st.results = { kb: kb.id, error: err }; }
        st.searching = false; later();
      };
      ctx.on('input', '#kb-q', (e, t) => { st.query = t.value; });
      ctx.on('keydown', '#kb-q', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      ctx.on('click', '[data-search]', search);
      ctx.on('click', 'tr[data-chunk]', (e, t) => {
        const c = res && res.hits[+t.dataset.chunk]; if (!c) return;
        ctx.drawer({ title: esc(c.document) + (c.heading ? ', ' + esc(c.heading) : ''), body: UI.kv([['Vector', c.vector == null ? '–' : c.vector.toFixed(3)], ['Full-text', c.keyword == null ? '–' : c.keyword.toFixed(3)], ['Fused (RRF)', c.fused == null ? '–' : c.fused.toFixed(4)], ['Reranker', c.rerank == null ? '–' : c.rerank.toFixed(2)], ['Label', UI.label(c.label, { sm: true })], ['Source', '<span class="mono">' + esc(c.source || '') + '</span>']], 2)
          + (c.withheld ? UI.notice('Withheld by the context checkpoint: ' + esc(c.withheld), 'warn') : UI.ctx('Chunk text', c.text || '', c.label)) + '<div class="muted" style="font-size:12px">Headings and page are kept as chunk metadata and cited as the source in answers.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) });
      });

      ctx.on('click', 'tr[data-src]', (e, t) => {
        const s = sources.find((x) => x.id === t.dataset.src); if (!s) return;
        const status = srcStatus(s, quarantinedDocs.length);
        ctx.drawer({ title: s.kind === 'upload' ? 'Uploads' : '<span class="mono">' + esc(srcName(s)) + '</span>', body: UI.kv([['Type', esc(KIND[s.kind])], ['Sync', esc(syncText(s))], ['Documents', String(s.documents)], ['Status', statePill(status)], ['Schedule', esc(SCHED[s.schedule] || s.schedule) + (s.kind === 'database' ? ', incremental by watermark' : s.kind === 'upload' ? '' : ', unchanged documents skipped')], ['Label floor', UI.label(s.labelFloor, { sm: true })]].concat(s.kind === 'git' && s.config.ref ? [['Ref', '<span class="mono">' + esc(s.config.ref) + '</span>']] : [])
            .concat(s.kind === 's3' ? [['Endpoint', s.config.endpoint ? '<span class="mono">' + esc(s.config.endpoint) + '</span> with its own keys (sealed)' : 'the platform\'s S3 storage'], ['Include', s.config.include && s.config.include.length ? s.config.include.map((g) => '<span class="mono">' + esc(g) + '</span>').join(', ') : 'every indexable file under the prefix']] : [])
            .concat(s.kind === 'web' ? [['Crawl', 'up to ' + esc(String(s.config.maxPages)) + ' pages, ' + esc(String(s.config.maxDepth)) + ' link' + (s.config.maxDepth === 1 ? '' : 's') + ' deep' + (s.config.pathPrefix ? ', under <span class="mono">' + esc(s.config.pathPrefix) + '</span>' : '') + (s.config.sitemap ? ', with the sitemap' : '')], ['Rules', 'stays on this site, follows robots.txt, re-checks pages by ETag or Last-Modified']] : [])
            .concat(s.kind === 'database' && s.config.roleMappings ? [['Row security', 'read as ' + s.config.roleMappings.map((m) => '<span class="mono">' + esc(m.role) + '</span> for ' + esc(m.group)).join(', ') + '; the database\'s policies decide which group retrieves each row']] : [])
            .concat(s.kind === 'database' && s.config.fields ? [['Indexed fields', s.config.fields.map((f) => '<span class="mono">' + esc(f) + '</span>').join(', ') + '; id <span class="mono">' + esc(s.config.idColumn || '_id') + '</span>']] : [])
            .concat(s.kind === 'database' && s.config.accessColumn ? [['Row access', 'column <span class="mono">' + esc(s.config.accessColumn) + '</span> names the ' + (s.config.accessKind === 'user' ? 'users' : 'directory groups') + ' who may retrieve each row']] : [])
            .concat(s.kind === 'database' && s.replication ? [['Replication', esc(REPL[s.replication.state] || s.replication.state) + (s.replication.lsn ? ', at <span class="mono">' + esc(s.replication.lsn) + '</span>' : '')], ['Slot and publication', '<span class="mono">' + esc(s.replication.slot || '') + '</span>, <span class="mono">' + esc(s.replication.publication || '') + '</span>']] : []), 2)
          + (s.replication && s.replication.error ? UI.notice('<b>Replication is not running;</b> the source syncs by watermark on its schedule. ' + esc(s.replication.error), 'warn') : '')
          + (s.lastError ? UI.problem('Last sync failed', s.lastError, s.lastTrace) : '')
          + (s.kind === 'upload' && quarantinedDocs.length ? UI.table(['File', 'State', 'Label', 'Held since'], quarantinedDocs.map((d) => ['<span class="mono">' + esc(d.name) + '</span>', statePill(d.state), UI.label(d.label, { sm: true }), esc(ago(d.createdAt))]), { clickable: false, minWidth: '0' }) + '<div class="fg2">Quarantined uploads cannot be attached or indexed until the type check, malware scan and classification pass.</div>' : '<div class="fg2">Unchanged documents are skipped by version or content hash. Each document keeps the higher of its manual label, the floor and the auto-classifier result.</div>'),
          actions: !manage ? UI.btn('Close', { attrs: 'data-close' }) : (s.kind === 'upload' ? UI.btn('Upload files', { icon: 'upload', attrs: 'data-up' }) : UI.btn('Sync now', { icon: 'refresh', attrs: 'data-syncnow', disabled: s.state === 'syncing' })) + UI.btn('Remove source', { kind: 'danger', attrs: 'data-removesrc' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(d) {
            const up = d.querySelector('[data-up]'); if (up) up.addEventListener('click', () => { App.closeOverlay(); pickFiles(); });
            const sn = d.querySelector('[data-syncnow]'); if (sn) sn.addEventListener('click', () => { App.closeOverlay(); act(() => App.post('/api/knowledge/sources/' + enc(s.id) + '/sync'), 'Sync queued for <span class="mono">' + esc(srcName(s)) + '</span>. Unchanged documents are skipped.'); });
            const rm = d.querySelector('[data-removesrc]'); if (rm) rm.addEventListener('click', async () => { App.closeOverlay(); const ok = await ctx.confirm({ title: 'Remove source', tag: 'destructive', tone: 'danger', ok: 'Remove', body: '<div class="fg2">Its documents, chunks and vectors leave every index of ' + esc(kb.name) + ' now.</div>', kv: [['Source', esc(srcName(s))], ['Documents', String(s.documents)]] }); if (ok) act(() => App.del('/api/knowledge/sources/' + enc(s.id)), 'Source removed with its ' + s.documents + ' documents. Audit entry written.'); });
          } });
      });

      ctx.on('click', '[data-doc]', (e, t) => {
        e.preventDefault();
        const d = docs.find((x) => x.id === t.dataset.doc); if (!d) return;
        const failed = d.state === 'failed' || d.state === 'rejected', quarantined = d.state === 'quarantined' || d.state === 'scanning';
        ctx.drawer({ title: esc(d.name), body: '<div class="hstack">' + UI.label(d.label) + statePill(docState(d)) + '</div>' + UI.kv([['Label origin', esc(origin(d))], ['Chunks', String(d.chunks)], ['Source', '<span class="mono">' + esc(d.source || '') + '</span>'], ['Type', esc(d.type || 'not detected yet')], ['Size', esc(size(d.size))], ['Content hash', '<span class="mono">' + esc(d.sha256 ? d.sha256.slice(0, 4) + '..' + d.sha256.slice(-4) : '') + '</span>'], ['Knowledge base', esc(kb.name)], ['Indexed', esc(when(d.indexedAt) || 'not yet')]], 2)
          + (failed ? UI.problem(d.state === 'rejected' ? 'Upload rejected' : 'Extraction failed', d.error || 'The document could not be read.', d.traceId) : quarantined ? UI.notice('Held until the malware scan and classification pass. It cannot be attached or indexed yet.', 'warn') : d.state === 'unchanged' ? '<div class="fg2">The content hash matched the previous build, so extraction and embedding were skipped.</div>' : '<div class="fg2">Chunks carry this label, the tenant, the source version and an ACL.</div>'),
          actions: !manage || quarantined ? UI.btn('Close', { attrs: 'data-close' }) : (d.state === 'rejected' ? '' : failed ? UI.btn('Retry extraction', { kind: 'primary', icon: 'refresh', attrs: 'data-retry="' + esc(d.id) + '"' }) : UI.btn('Reindex document', { icon: 'refresh', attrs: 'data-reindexdoc' })) + UI.btn('Relabel', { icon: 'edit', attrs: 'data-relabel' }) + UI.btn('Remove', { kind: 'danger', attrs: 'data-removedoc' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(dr) {
            const rl = dr.querySelector('[data-relabel]'); if (rl) rl.addEventListener('click', () => relabel(d));
            const ri = dr.querySelector('[data-reindexdoc]'); if (ri) ri.addEventListener('click', () => { App.closeOverlay(); act(() => App.post('/api/knowledge/documents/' + enc(d.id) + '/reindex'), 'Reindex queued for ' + esc(d.name) + '. Embeddings come from cache where the text is unchanged.'); });
            const rt = dr.querySelector('[data-retry]'); if (rt) rt.addEventListener('click', () => { App.closeOverlay(); retry(d); });
            const rm = dr.querySelector('[data-removedoc]'); if (rm) rm.addEventListener('click', async () => { App.closeOverlay(); const ok = await ctx.confirm({ title: 'Remove document', tag: 'destructive', tone: 'danger', ok: 'Remove', body: '<div class="fg2">The document and its ' + d.chunks + ' chunks leave every index now. A synced document stays removed, so the next sync does not bring it back.</div>', kv: [['Document', esc(d.name)], ['Label', UI.label(d.label, { sm: true })]] }); if (ok) act(() => App.del('/api/knowledge/documents/' + enc(d.id)), esc(d.name) + ' removed. Audit entry written.'); });
          } });
      });
      function retry(d) {
        ctx.confirm({ title: 'Retry extraction', tone: 'primary', ok: 'Retry', body: '<div class="fg2">Runs extraction and embedding again for this file. If the cause is still there the job fails with a new trace.</div>', kv: [['Document', esc(d.name)], ['Last error', esc(d.error || '')], ['Trace', '<span class="mono">' + esc((d.traceId || '').slice(0, 12)) + '…</span>']] })
          .then((ok) => { if (!ok) return; st.failedOpen = false; act(() => App.post('/api/knowledge/documents/' + enc(d.id) + '/reindex'), 'Extraction retried for ' + esc(d.name) + '.'); });
      }
      ctx.on('click', '[data-retry]', (e, t) => { const d = docs.find((x) => x.id === t.dataset.retry); if (d) retry(d); });
      function relabel(d) {
        ctx.modal({ title: 'Relabel ' + esc(d.name), body: UI.field('Label', UI.select(myLabels, d.label, 'data-lbl'), 'A manual label can raise the auto-classifier result but not lower it below the classifier\'s finding or the source floor.') + UI.field('Reason', UI.textarea('', { placeholder: 'Recorded in the audit log', rows: 2, attrs: 'data-reason' })) + UI.notice('Chunks take the new label at once; the clearance filter applies to it on the next query.', 'info') + '<div data-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Relabel', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            const l = m.querySelector('[data-lbl]').value;
            try { await App.patch('/api/knowledge/documents/' + enc(d.id), { label: l, reason: m.querySelector('[data-reason]').value.trim() }); App.closeOverlay(); toast(esc(d.name) + ' relabelled ' + esc(l) + '. Audit entry written.', 'ok'); refresh(); }
            catch (err) { const p = err.problem || {}; m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(err.message), 'danger'); }
          });
        } });
      }

      ctx.on('click', '[data-reindex]', () => {
        const emb = models.embedding.filter((m) => rank(m.label) >= rank(kb.label)).map((m) => m.name);
        if (emb.indexOf(kb.embedModel) < 0) emb.unshift(kb.embedModel);
        ctx.modal({ title: 'Reindex ' + esc(kb.name), body: '<div class="fg2">A new index builds beside ' + (serving ? 'v' + serving.version : 'the serving index') + '. Retrieval keeps using it until the build completes and the switch is atomic. Embeddings of unchanged text come from the cache.</div>' + UI.field('Embedding model', UI.select(emb, kb.embedModel, 'data-emb'), 'A different model builds a new index with new vectors; only approved embedding models cleared for ' + esc(kb.label) + ' are listed.') + UI.kv([['Chunks', String(serving ? serving.chunks : 0)], ['Documents', String(kb.documents)]], 2),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Start build', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
            m.querySelector('[data-go]').addEventListener('click', async () => { const e2 = m.querySelector('[data-emb]').value; App.closeOverlay(); const r = await act(() => App.post('/api/knowledge/bases/' + enc(kb.id) + '/reindex', e2 !== kb.embedModel ? { embedModel: e2 } : {})); if (r) { st.tab = 'index'; toast('Index v' + r.version + ' is building beside ' + (serving ? 'v' + serving.version : 'the serving index') + '.', 'ok'); } });
          } });
      });
      ctx.on('click', '[data-cancelbuild]', async () => { const ok = await ctx.confirm({ title: 'Cancel the index build', tone: 'danger', ok: 'Cancel build', body: '<div class="fg2">The partial index is discarded. Retrieval is unaffected because ' + (serving ? 'v' + serving.version : 'the serving index') + ' never stopped serving.</div>' }); if (ok) act(() => App.post('/api/knowledge/bases/' + enc(kb.id) + '/cancel-build'), 'Build cancelled. ' + (serving ? 'v' + serving.version : 'The serving index') + ' keeps serving.'); });
      ctx.on('click', '[data-publish]', async () => { const ok = await ctx.confirm({ title: 'Publish ' + esc(kb.name), tone: 'primary', ok: 'Publish', body: '<div class="fg2">Chat retrieves from published bases attached to a conversation or a profile, up to each reader\'s clearance.</div>' }); if (ok) act(() => App.patch('/api/knowledge/bases/' + enc(kb.id), { status: 'published' }), esc(kb.name) + ' published.'); });
      ctx.on('click', '[data-editkb]', () => {
        const rr = [{ value: '', label: 'none' }].concat(models.rerankers.map((m) => ({ value: m.name, label: m.name })));
        ctx.modal({ title: 'Edit ' + esc(kb.name), body: '<div class="formgrid">' + UI.field('Name', UI.input(kb.name, { attrs: 'data-name' })) + UI.field('Label floor', UI.select(myLabels, kb.label, 'data-lbl'), 'Raising it relabels indexed chunks at once.') + UI.field('Reranker', UI.select(rr, kb.reranker || '', 'data-rr')) + UI.field('Shared with', UI.select([{ value: 'members', label: kb.workspaceId ? 'Workspace members' : 'Everyone in the tenant' }, { value: 'curators', label: 'Curators only' }], kb.sharing, 'data-sharing')) + UI.field('Chunk size, tokens', UI.input(String(kb.chunking.tokens), { type: 'number', attrs: 'data-tokens' })) + UI.field('Overlap, tokens', UI.input(String(kb.chunking.overlap), { type: 'number', attrs: 'data-overlap' })) + UI.field('Status', UI.select(['draft', 'published'], kb.status, 'data-status')) + '</div>' + UI.field('Description', UI.textarea(kb.description || '', { rows: 2, attrs: 'data-desc' })) + UI.notice('A new chunk size applies at the next reindex.', 'info') + '<div data-err></div>',
          actions: UI.btn('Delete base', { kind: 'danger', attrs: 'data-del' }) + '<span class="grow"></span>' + UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
            const err = (e2) => { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((e2.problem && e2.problem.title) || 'Not saved') + '.</b> ' + esc(e2.message), 'danger'); };
            m.querySelector('[data-go]').addEventListener('click', async () => {
              const v = (s) => m.querySelector(s).value;
              try { await App.patch('/api/knowledge/bases/' + enc(kb.id), { name: v('[data-name]').trim(), label: v('[data-lbl]'), reranker: v('[data-rr]') || null, sharing: v('[data-sharing]'), status: v('[data-status]'), description: v('[data-desc]').trim() || null, chunking: { tokens: Math.round(+v('[data-tokens]')), overlap: Math.round(+v('[data-overlap]')) } }); App.closeOverlay(); toast('Saved. Audit entry written.', 'ok'); refresh(); }
              catch (e2) { err(e2); }
            });
            m.querySelector('[data-del]').addEventListener('click', async () => {
              App.closeOverlay();
              const ok = await ctx.confirm({ title: 'Delete ' + esc(kb.name), tag: 'cannot be undone', tone: 'danger', ok: 'Delete', body: '<div class="fg2">Deletes the base, its sources, documents, chunks, vectors and stored files. Conversations that cited it keep their citations.</div>', kv: [['Documents', String(kb.documents)], ['Chunks', String(kb.chunks)]] });
              if (ok && await act(() => App.del('/api/knowledge/bases/' + enc(kb.id)), esc(kb.name) + ' deleted. Audit entry written.')) { delete st.detail[kb.id]; st.bases = st.bases.filter((k) => k.id !== kb.id); st.kb = null; ctx.rerender(); }
            });
          } });
      });

      ctx.on('click', '[data-addsource]', () => openAdd());
      function openAdd() {
        const needConns = () => (st.conns ? Promise.resolve(st.conns) : App.get('/api/knowledge/connections').then((c) => { st.conns = c; return c; }).catch(() => { st.conns = []; return []; }));
        ctx.drawer({ title: 'Add source to ' + esc(kb.name), body: UI.field('Type', UI.select([{ value: 'upload', label: 'Upload' }, { value: 's3', label: 'S3 prefix' }, { value: 'git', label: 'Git repository' }, { value: 'database', label: 'Database table, view or collection' }, { value: 'web', label: 'Internal web site' }], 's3', 'data-type'))
          + '<div data-loc-wrap>' + UI.field('Location', UI.input('', { placeholder: 's3://bucket/prefix/', attrs: 'data-loc' }), '<span data-loc-hint>The platform\'s S3 storage, or a bucket on its own endpoint below.</span>') + '</div>'
          + '<div data-s3-wrap>' + UI.field('Include', UI.input('', { placeholder: '**/*.md, policies/*.pdf', attrs: 'data-incl' }), 'Optional. Patterns relative to the prefix, comma separated: * within a folder, ** across folders.')
            + UI.field('Endpoint', UI.input('', { placeholder: 'https://minio.example.internal (empty: the platform\'s storage)', attrs: 'data-ep' }), 'An S3-compatible endpoint on the internal network, or one an operator allows.')
            + '<div class="knowledge-two">' + UI.field('Region', UI.input('us-east-1', { attrs: 'data-region' })) + UI.field('Access key id', UI.input('', { attrs: 'data-akid autocomplete="off"' })) + '</div>'
            + UI.field('Secret access key', UI.input('', { type: 'password', attrs: 'data-secret autocomplete="new-password"' }), 'Sealed with the tenant key and never shown again.')
            + UI.check('Path-style addressing (bucket in the path)', true, 'data-pathstyle') + '</div>'
          + '<div data-web-wrap hidden><div class="knowledge-two">' + UI.field('Link depth', UI.input('2', { type: 'number', attrs: 'data-depth min="0" max="5"' }), 'Links followed from the start page.') + UI.field('Page limit', UI.input('100', { type: 'number', attrs: 'data-pages min="1" max="1000"' })) + '</div>'
            + UI.field('Path prefix', UI.input('', { placeholder: '/handbook/ (empty: the whole site)', attrs: 'data-prefix' }))
            + UI.check('Also read the pages the sitemap lists', true, 'data-sitemap')
            + '<div class="fg2">The crawl stays on the start page\'s site, follows robots.txt, and fetches only internal addresses (or hosts an operator allows). Unchanged pages are recognised by ETag or Last-Modified.</div></div>'
          + '<div data-git-wrap hidden>' + UI.field('Ref', UI.input('', { placeholder: 'main (default branch when empty)', attrs: 'data-ref' })) + UI.field('Path', UI.input('', { placeholder: 'docs/ (whole repository when empty)', attrs: 'data-path' })) + '</div>'
          + '<div data-db-wrap hidden>' + UI.field('Connection', '<select class="select" data-conn aria-label="Connection"><option value="">Loading…</option></select>', 'PostgreSQL, MySQL and MongoDB connections registered on the Connections screen.') + UI.field('View, table or collection', '<select class="select" data-obj aria-label="View, table or collection"></select>', 'Only objects on the connection\'s allow-list.')
            + '<div data-mongo-wrap hidden>' + UI.field('Fields to index', UI.input('', { placeholder: 'title, body, customer.name', attrs: 'data-fields' }), 'Comma separated; dotted paths reach into sub-documents. Only these fields become document text; empty indexes the text fields of the sampled schema.')
            + '<div class="knowledge-two">' + UI.field('Id field', UI.input('_id', { attrs: 'data-idf' })) + UI.field('Watermark field', UI.input('', { placeholder: 'updatedAt', attrs: 'data-wmf' }), 'Optional. A date or number that grows on every change; without one each sync reads the collection again.') + '</div></div>'
            + UI.field('Row access column', '<select class="select" data-acol aria-label="Row access column"></select>', 'Optional. Each row lists who may retrieve it; readers not on a row\'s list never get its text. An empty value lets nobody read the row.')
            + UI.field('The column names', UI.select([{ value: 'group', label: 'directory groups' }, { value: 'user', label: 'users (username or email)' }], 'group', 'data-akind aria-label="What the access column names"'))
            + '<div data-roles-wrap>' + UI.field('Row security by role', UI.textarea('', { placeholder: 'finance = kb_finance\nops = kb_ops', rows: 3, attrs: 'data-roles' }), 'Optional, PostgreSQL. One group = database role per line: rows are read as each role, so the table\'s row security policies decide which group retrieves each row. Instead of an access column; the source then syncs by full reads.') + '</div>'
            + '<div data-repl-wrap>' + UI.check('Stream changes with logical replication (PostgreSQL tables)', false, 'data-repl') + UI.field('Publication', UI.input('exprsn_knowledge', { attrs: 'data-pub aria-label="Publication"' }), 'The database owner creates it for the table; the connection\'s account needs the REPLICATION attribute. Without them the source keeps syncing by watermark.') + '</div></div>'
          + '<div data-file-wrap hidden>' + UI.field('Files', '<input type="file" multiple data-files class="input">', 'Text, Markdown, CSV, JSON, HTML, PDF with a text layer, DOCX.') + '</div>'
          + UI.field('Label floor', UI.select(myLabels.filter((l) => rank(l) >= rank(kb.label)), kb.label, 'data-floor'), 'Documents get at least this label; the auto-classifier can raise it.')
          + '<div data-sched-wrap>' + UI.field('Sync', UI.select([{ value: '15m', label: 'every 15 min, incremental' }, { value: 'hourly', label: 'hourly' }, { value: 'daily', label: 'daily' }, { value: 'manual', label: 'manual' }], '15m', 'data-sched')) + '</div>'
          + UI.notice('Uploads go to quarantine first. Other sources sync by version, watermark or page validators; database sources read only the connection\'s allow-list.', 'info') + '<div data-err></div>',
          actions: UI.btn('Add and sync', { kind: 'primary', attrs: 'data-go' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }), onMount(d) {
            const q = (s) => d.querySelector(s);
            const connOf = () => (st.conns || []).find((x) => x.id === q('[data-conn]').value);
            const fillCols = () => { const c = connOf(); const cols = c && c.columns ? c.columns[q('[data-obj]').value] || [] : []; q('[data-acol]').innerHTML = '<option value="">none: the base\'s access decides</option>' + cols.map((x) => '<option value="' + esc(x) + '">' + esc(x) + '</option>').join(''); };
            const fillObjs = () => {
              const c = connOf(); const mongo = !!c && c.engine === 'mongodb';
              q('[data-obj]').innerHTML = c ? c.objects.map((o) => '<option value="' + esc(o) + '">' + esc(o) + '</option>').join('') || '<option value="">No allow-listed objects</option>' : '';
              q('[data-repl-wrap]').hidden = !c || c.engine !== 'postgres'; q('[data-roles-wrap]').hidden = !c || c.engine !== 'postgres';
              q('[data-mongo-wrap]').hidden = !mongo;
              if (mongo) { const cols = c.columns[q('[data-obj]').value] || []; const wm = q('[data-wmf]'); if (!wm.value) wm.value = cols.indexOf('updatedAt') >= 0 ? 'updatedAt' : cols.indexOf('updated_at') >= 0 ? 'updated_at' : ''; }
              fillCols();
            };
            const sync = () => {
              const t = q('[data-type]').value;
              q('[data-loc-wrap]').hidden = t === 'upload' || t === 'database'; q('[data-git-wrap]').hidden = t !== 'git'; q('[data-db-wrap]').hidden = t !== 'database'; q('[data-file-wrap]').hidden = t !== 'upload'; q('[data-sched-wrap]').hidden = t === 'upload'; q('[data-s3-wrap]').hidden = t !== 's3'; q('[data-web-wrap]').hidden = t !== 'web';
              q('[data-loc]').placeholder = t === 'git' ? 'https://git.example.internal/org/repo.git' : t === 'web' ? 'https://intranet.example.internal/' : 's3://bucket/prefix/';
              q('[data-loc-hint]').textContent = t === 'git' ? 'An https:// repository the server may read.' : t === 'web' ? 'The start page of an internal site.' : 'The platform\'s S3 storage, or a bucket on its own endpoint below.';
              if (t === 'database') needConns().then((cs) => { q('[data-conn]').innerHTML = cs.length ? cs.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.name) + ' (' + esc(ENGINE[c.engine] || c.engine) + ', ' + esc(c.label) + ')</option>').join('') : '<option value="">No database connection registered</option>'; fillObjs(); });
            };
            q('[data-type]').addEventListener('change', sync); q('[data-conn]').addEventListener('change', fillObjs); q('[data-obj]').addEventListener('change', () => { const c = connOf(); if (c && c.engine === 'mongodb') { q('[data-wmf]').value = ''; fillObjs(); } else fillCols(); }); sync();
            q('[data-go]').addEventListener('click', async () => {
              const t = q('[data-type]').value; const floor = q('[data-floor]').value;
              const showErr = (e2) => { q('[data-err]').innerHTML = UI.notice('<b>' + esc((e2.problem && e2.problem.title) || 'Refused') + '.</b> ' + esc(e2.message), 'danger'); };
              if (t === 'upload') { const files = q('[data-files]').files; if (!files || !files.length) { toast('Choose at least one file.'); return; } App.closeOverlay(); uploadFiles(files, floor); return; }
              const body = { kind: t, labelFloor: floor, schedule: q('[data-sched]').value };
              if (t === 'database') {
                body.connectionId = q('[data-conn]').value; body.location = q('[data-obj]').value; if (!body.connectionId || !body.location) { toast('Pick a connection and an allow-listed view or collection.'); return; }
                const mc = connOf();
                if (mc && mc.engine === 'mongodb') {
                  const fields = csvList(q('[data-fields]').value); if (fields.length) body.fields = fields;
                  const idf = q('[data-idf]').value.trim(); if (idf) body.idColumn = idf;
                  const wmf = q('[data-wmf]').value.trim(); body.watermarkColumn = wmf || null;
                }
                if (q('[data-acol]').value) { body.accessColumn = q('[data-acol]').value; body.accessKind = q('[data-akind]').value; }
                const c = connOf(); if (c && c.engine === 'postgres' && q('[data-repl]').checked) { body.replication = true; body.publication = q('[data-pub]').value.trim() || 'exprsn_knowledge'; }
                if (c && c.engine === 'postgres' && q('[data-roles]').value.trim()) {
                  const maps = q('[data-roles]').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return i < 0 ? null : { group: l.slice(0, i).trim(), role: l.slice(i + 1).trim() }; });
                  if (maps.some((m) => !m || !m.group || !m.role)) { toast('Write each mapping as group = role.'); return; }
                  body.roleMappings = maps;
                }
              }
              else { body.location = q('[data-loc]').value.trim(); if (!body.location) { toast('Give the source a location.'); return; } }
              if (t === 'git') { const r = q('[data-ref]').value.trim(); const p = q('[data-path]').value.trim(); if (r) body.ref = r; if (p) body.path = p; }
              if (t === 's3') {
                const incl = q('[data-incl]').value.split(',').map((x) => x.trim()).filter(Boolean); if (incl.length) body.include = incl;
                const ep = q('[data-ep]').value.trim();
                if (ep) { body.endpoint = ep; body.region = q('[data-region]').value.trim() || 'us-east-1'; body.accessKeyId = q('[data-akid]').value.trim(); body.secretAccessKey = q('[data-secret]').value; body.pathStyle = q('[data-pathstyle]').checked; if (!body.accessKeyId || !body.secretAccessKey) { toast('A bucket on its own endpoint needs its access key id and secret.'); return; } }
              }
              if (t === 'web') { body.maxDepth = Math.max(0, Math.min(5, Number(q('[data-depth]').value) || 0)); body.maxPages = Math.max(1, Math.min(1000, Number(q('[data-pages]').value) || 100)); const px = q('[data-prefix]').value.trim(); if (px) body.pathPrefix = px; body.sitemap = q('[data-sitemap]').checked; }
              try { await App.post('/api/knowledge/bases/' + enc(kb.id) + '/sources', body); App.closeOverlay(); st.tab = 'sources'; toast('Source added. First sync started; documents appear as they are extracted.', 'ok'); refresh(); }
              catch (e2) { showErr(e2); }
            });
            setTimeout(() => { const i = q('[data-loc]'); if (i) i.focus(); }, 30);
          } });
      }
      const pickFiles = () => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.style.display = 'none';
        inp.addEventListener('change', () => { if (inp.files && inp.files.length) uploadFiles(inp.files, kb.label); inp.remove(); });
        document.body.appendChild(inp); inp.click();
      };
      async function uploadFiles(files, label) {
        let ok = 0; const failed = [];
        for (const file of Array.prototype.slice.call(files)) {
          try {
            const r = await fetch('/api/knowledge/bases/' + enc(kb.id) + '/uploads?name=' + enc(file.name) + '&label=' + enc(label), { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' } });
            if (r.status === 401) { App.sessionEnded('Your session ended. Sign in again.'); return; }
            if (!r.ok) { let p = null; try { p = await r.json(); } catch (e2) { /* not JSON */ } failed.push(file.name + ': ' + ((p && (p.detail || p.title)) || r.statusText)); } else ok++;
          } catch (e2) { failed.push(file.name + ': the server could not be reached.'); }
        }
        st.tab = 'documents';
        if (ok) toast(ok + ' file' + (ok === 1 ? '' : 's') + ' uploaded to quarantine. Indexing starts once the scan and classification pass.', 'ok', 5000);
        if (failed.length) toast('<b>Not uploaded.</b> ' + esc(failed.join('; ')), 'danger', 8000);
        refresh();
      }
      ctx.on('click', '[data-upload]', pickFiles);

      function newKb() {
        const emb = models.embedding.map((m) => ({ value: m.name, label: m.name + ' (up to ' + m.label + ')' }));
        const ws = App.me && App.me.workspace ? (App.me.workspaces || []).find((w) => w.id === App.me.workspace) : null;
        ctx.modal({ title: 'New knowledge base', body: UI.field('Name', UI.input('', { placeholder: 'Treasury KB', attrs: 'data-name' })) + UI.field('Label floor', UI.select(myLabels, 'internal', 'data-lbl')) + UI.field('Embedding model', emb.length ? UI.select(emb, emb[0].value, 'data-emb') : UI.select([{ value: '', label: 'No approved embedding model' }], '', 'data-emb disabled'), emb.length ? 'Changing it later builds a new index beside the old one.' : 'Import and approve an embedding model on the Models screen first.') + UI.field('Shared with', UI.select([{ value: 'members', label: ws ? esc(ws.name) + ' members' : 'Everyone in the tenant' }, { value: 'curators', label: 'Curators only' }], 'members', 'data-sharing')) + '<div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-go', disabled: !emb.length }), onMount(m) {
            m.querySelector('[data-go]').addEventListener('click', async () => {
              const n = m.querySelector('[data-name]').value.trim(); if (!n) { toast('Give it a name.'); return; }
              try { const r = await App.post('/api/knowledge/bases', { name: n, label: m.querySelector('[data-lbl]').value, embedModel: m.querySelector('[data-emb]').value, sharing: m.querySelector('[data-sharing]').value }); App.closeOverlay(); st.bases = st.bases.concat([r]); st.detail[r.id] = r; st.docs[r.id] = []; st.kb = r.id; st.tab = 'sources'; toast('Created ' + esc(n) + ' as a draft. Add a source to start indexing.', 'ok'); refresh(); }
              catch (e2) { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((e2.problem && e2.problem.title) || 'Not created') + '.</b> ' + esc(e2.message), 'danger'); }
            });
          } });
      }
      ctx.on('click', '[data-newkb]', newKb);

      ctx.on('click', '[data-unshare]', async (e, t) => { const g = (st.access[kb.id] || []).find((x) => x.id === t.dataset.unshare); if (!g) return; const ok = await ctx.confirm({ title: 'Remove access', tone: 'danger', ok: 'Remove', body: '<div class="fg2">' + esc(g.name) + ' loses ' + esc(g.access) + ' access to ' + esc(kb.name) + '.</div>' }); if (ok) act(() => App.del('/api/knowledge/bases/' + enc(kb.id) + '/access/' + enc(g.id)), 'Access removed. Audit entry written.'); });
      ctx.on('click', '[data-addprincipal]', async () => {
        let pr;
        try { pr = st.principals || (st.principals = await App.get('/api/knowledge/principals')); } catch (err) { App.fail(err); return; }
        const opts = pr.workspaces.map((w) => ({ value: 'workspace:' + w.id, label: w.name + ' (workspace)' })).concat(pr.profiles.map((p) => ({ value: 'profile:' + p.id, label: p.name + ' (profile)' })), pr.users.map((u) => ({ value: 'user:' + u.id, label: u.name + ' (user)' })));
        ctx.modal({ title: 'Share ' + esc(kb.name), body: UI.field('Principal', UI.select(opts, opts[0] && opts[0].value, 'data-who')) + UI.field('Access', UI.select(['read', 'manage'], 'read', 'data-acc'), 'A profile reads only: retrieval in chat for conversations on that profile.') + UI.notice('Sharing does not lift the clearance filter: readers still see only chunks at or below their clearance.', 'info') + '<div data-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Share', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            const who = m.querySelector('[data-who]').value.split(':'); const o = opts.find((x) => x.value === who.join(':'));
            try { st.access[kb.id] = await App.post('/api/knowledge/bases/' + enc(kb.id) + '/access', { kind: who[0], id: who[1], access: m.querySelector('[data-acc]').value }); App.closeOverlay(); toast('Shared with ' + esc(o ? o.label : '') + '. Audit entry written.', 'ok'); ctx.rerender(); }
            catch (e2) { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((e2.problem && e2.problem.title) || 'Refused') + '.</b> ' + esc(e2.message), 'danger'); }
          });
        } });
      });
      if (st.openAdd) { st.openAdd = false; if (manage) setTimeout(openAdd, 30); }
    }
  });
})();
