(function () {
  const { UI, esc } = App;

  const KBS = [
    { id: 'finance', name: 'Finance KB', sub: '1,284 documents, synced 2 h ago', label: 'confidential', status: 'published', embed: 'nomic-embed-text', index: 'v7', chunks: '41,208', built: '4 Sep 2026' },
    { id: 'travel', name: 'Travel policy', sub: '42 documents', label: 'internal', status: 'published', embed: 'nomic-embed-text', index: 'v3', chunks: '1,120', built: '28 Aug 2026' },
    { id: 'vendor', name: 'Vendor contracts', sub: '316 documents, index swap pending', label: 'confidential', status: 'published', embed: 'nomic-embed-text', index: 'v5', chunks: '12,940', built: '12 Sep 2026', swap: true },
    { id: 'hr', name: 'HR handbook', sub: '88 documents', label: 'internal', status: 'published', embed: 'nomic-embed-text', index: 'v2', chunks: '2,310', built: '2 Sep 2026' },
    { id: 'public', name: 'Public product docs', sub: '1,020 documents', label: 'public', status: 'published', embed: 'nomic-embed-text', index: 'v11', chunks: '33,870', built: '18 Sep 2026' }
  ];
  const SOURCES = {
    finance: [
      { src: 's3://finance/reports/', mono: true, type: 'S3 prefix', sync: 'watermark 19 Sep 11:40', docs: 912, status: 'synced' },
      { src: 'git: finance/policies', mono: true, type: 'Git repository', sync: 'commit 8c1f2ab', docs: 64, status: 'synced' },
      { src: 'pg: ledger.v_cost_centres', mono: true, type: 'Postgres view', sync: 'updated_at 19 Sep 12:02', docs: 286, status: 'syncing' },
      { src: 'Uploads', type: 'Upload', sync: 'manual', docs: 22, status: '1 quarantined' }
    ],
    travel: [{ src: 'git: finance/policies/travel', mono: true, type: 'Git repository', sync: 'commit 8c1f2ab', docs: 42, status: 'synced' }],
    vendor: [{ src: 's3://legal/contracts/', mono: true, type: 'S3 prefix', sync: 'watermark 18 Sep 23:10', docs: 298, status: 'synced' }, { src: 'Uploads', type: 'Upload', sync: 'manual', docs: 18, status: 'synced' }],
    hr: [{ src: 'git: people/handbook', mono: true, type: 'Git repository', sync: 'commit 41d0e77', docs: 88, status: 'synced' }],
    public: [{ src: 's3://docs/public/', mono: true, type: 'S3 prefix', sync: 'watermark 19 Sep 09:00', docs: 1020, status: 'synced' }]
  };
  const DOCS = {
    finance: [
      { name: 'Q3 cost centre review.pdf', label: 'confidential', origin: 'auto-classifier, PII', chunks: 48, state: 'indexed', source: 's3://finance/reports/', size: '2.1 MB', hash: '9f31..c0de' },
      { name: 'Travel budget 2026.xlsx', label: 'confidential', origin: 'manual', chunks: 31, state: 'indexed', source: 's3://finance/reports/', size: '410 KB', hash: '77b0..13fd' },
      { name: 'Supplier bank details.docx', label: 'restricted', origin: 'auto-classifier, IBAN', chunks: 12, state: 'indexed', source: 'Uploads', size: '84 KB', hash: 'e2a9..5511' },
      { name: 'Board pack August.pdf', label: 'confidential', origin: 'inherited', chunks: 0, state: 'extraction failed', source: 'Uploads', size: '6.4 MB', hash: '1b7c..a8e4' },
      { name: 'Expense policy v7.md', label: 'internal', origin: 'manual', chunks: 19, state: 'unchanged, skipped', source: 'git: finance/policies', size: '31 KB', hash: '5d02..7f19' }
    ],
    travel: [{ name: 'Travel policy v7.md', label: 'internal', origin: 'manual', chunks: 22, state: 'indexed', source: 'git: finance/policies/travel', size: '28 KB', hash: '5d02..7f19' }, { name: 'Per diem table 2026.csv', label: 'internal', origin: 'inherited', chunks: 6, state: 'indexed', source: 'git: finance/policies/travel', size: '9 KB', hash: 'c41a..0b2e' }],
    vendor: [{ name: 'Fabrikam MSA 2025.pdf', label: 'confidential', origin: 'manual', chunks: 64, state: 'indexed', source: 's3://legal/contracts/', size: '1.8 MB', hash: '0aa1..d3c7' }, { name: 'Contoso SOW 4.docx', label: 'confidential', origin: 'inherited', chunks: 18, state: 'indexing', source: 'Uploads', size: '220 KB', hash: '8e44..91b0' }],
    hr: [{ name: 'Handbook 2026.md', label: 'internal', origin: 'manual', chunks: 140, state: 'indexed', source: 'git: people/handbook', size: '210 KB', hash: '2c19..e77a' }],
    public: [{ name: 'Getting started.md', label: 'public', origin: 'manual', chunks: 12, state: 'indexed', source: 's3://docs/public/', size: '14 KB', hash: 'b0b0..1e1e' }]
  };
  const CHUNKS = [
    { doc: 'Q3 cost centre review.pdf, p. 4', terms: 'travel overrun lisbon q3 cost centre variance', v: 0.83, ft: 0.61, rr: 0.91, label: 'confidential' },
    { doc: 'Travel budget 2026.xlsx, sheet Q3', terms: 'travel budget overrun q3 lisbon onboarding', v: 0.79, ft: 0.44, rr: 0.74, label: 'confidential' },
    { doc: 'Expense policy v7.md, section 4.3', terms: 'taxi expense policy receipt approval travel', v: 0.71, ft: 0.52, rr: 0.66, label: 'internal' },
    { doc: 'Supplier bank details.docx, p. 1', terms: 'supplier bank iban payment lisbon', v: 0.68, ft: 0.39, rr: 0.58, label: 'restricted' }
  ];
  const ACCESS = [
    ['Finance Ops members', 'read', 'workspace membership', UI.pill('active', 'ok')],
    ['Knowledge curators', 'manage', 'role knowledge-curator', UI.pill('active', 'ok')],
    ['Data analyst agent', 'read', 'profile analyst, tool ceiling confidential', UI.pill('active', 'ok')],
    ['Field Sales', 'none', 'not shared', UI.pill('no access', 'outline')]
  ];
  const TRACE = '7c1e0a9b4d2f4e8f9a3b5c6d7e8f9a0b';

  App.register({
    id: 'knowledge', title: 'Knowledge', summary: 'Knowledge bases, sources, documents and labels, index, access, test search',
    crumb: (st, params) => ['Knowledge', (KBS.find((k) => k.id === ((params && params.kb) || st.kb || 'finance')) || KBS[0]).name],
    label: (st, params) => (KBS.find((k) => k.id === ((params && params.kb) || st.kb || 'finance')) || KBS[0]).label,
    commands: [{ label: 'Add a knowledge source', sub: 'Knowledge', run(app) { app.stateFor('knowledge').openAdd = true; app.render(); } }],
    states: [
      { title: 'Index swap pending', tone: 'info', text: 'Index v8 is building beside v7 with a new embedding model: 71% complete. Retrieval keeps using v7 until the atomic switch.', apply(ctx) { ctx.state.kb = 'finance'; ctx.state.swap = true; ctx.state.tab = 'index'; ctx.rerender(); } },
      { title: 'Upload quarantined', tone: 'warn', text: 'invoice-scan.pdf is held until the malware scan and classification pass. It cannot be attached or indexed yet.', apply(ctx) { ctx.state.kb = 'finance'; ctx.state.quarantine = true; ctx.state.tab = 'documents'; ctx.rerender(); } },
      { title: 'Extraction failed', tone: 'danger', text: 'Board pack August.pdf is password protected. Shows the error, the trace ID and a retry action.', apply(ctx) { ctx.state.kb = 'finance'; ctx.state.tab = 'documents'; ctx.state.failedOpen = true; ctx.rerender(); } },
      { title: 'Member view', tone: 'neutral', text: 'Members see sources and documents read-only, with no relabel or reindex actions.', apply(ctx) { ctx.state.member = true; ctx.state.tab = 'sources'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.kb) { st.kb = ctx.params.kb; delete ctx.params.kb; }
      st.kb = KBS.find((k) => k.id === st.kb) ? st.kb : 'finance';
      st.tab = st.tab || 'sources'; st.filter = st.filter || ''; st.docq = st.docq || ''; st.query = st.query == null ? 'travel overrun Lisbon' : st.query;
      st.overrides = st.overrides || {}; st.added = st.added || {}; st.searched = st.searched == null ? true : st.searched;
      const kb = KBS.find((k) => k.id === st.kb);
      const member = !!st.member;
      const swap = st.swap || kb.swap;
      const sources = (SOURCES[kb.id] || []).concat(st.added[kb.id] || []);
      const docs = DOCS[kb.id].map((d) => Object.assign({}, d, st.overrides[kb.id + d.name] || {})).concat(st.quarantine && kb.id === 'finance' ? [{ name: 'invoice-scan.pdf', label: 'internal', origin: 'pending', chunks: 0, state: 'quarantined', source: 'Uploads', size: '1.3 MB', hash: 'scan pending' }] : []);
      const kbList = KBS.filter((k) => !st.filter || k.name.toLowerCase().includes(st.filter.toLowerCase()));

      const statePill = (s) => s === 'indexed' || s === 'synced' ? UI.pill(s, 'ok') : s === 'syncing' || s === 'indexing' ? UI.pill(s, 'info') : /quarantin/.test(s) ? UI.pill(s, 'warn') : /failed/.test(s) ? UI.pill(s, 'danger') : UI.pill(s, '');
      const sourcesTable = () => UI.table(['Source', 'Type', 'Sync', 'Documents', 'Status'], sources.map((s) => ({ cells: [s.mono ? '<span class="mono">' + esc(s.src) + '</span>' : esc(s.src), esc(s.type), esc(s.sync), String(s.docs), statePill(s.status)], attrs: 'data-src="' + esc(s.src) + '"' })), { minWidth: '0', emptyTitle: 'No sources yet', emptyText: 'Add an upload, S3 prefix, Git repository or Postgres view.' });
      const docsTable = (list) => UI.table(['Document', 'Label', 'Label origin', 'Chunks', 'State'], list.map((d) => ({ cells: [esc(d.name), UI.label(d.label, { sm: true }), esc(d.origin), String(d.chunks), statePill(d.state)], attrs: 'data-doc="' + esc(d.name) + '"', selected: st.failedOpen && d.state === 'extraction failed' })), { minWidth: '0', emptyTitle: 'No documents match', emptyText: 'Try another word.' });
      const failedDoc = docs.find((d) => d.state === 'extraction failed');
      const failedPanel = st.failedOpen && failedDoc ? '<div class="problem"><div class="ptitle">Extraction failed for ' + esc(failedDoc.name) + '</div><div class="ptext">The PDF is password protected, so the index.document job could not extract text. Upload an unlocked copy, or remove the password and retry. The document keeps its inherited label and stays out of retrieval.</div><div class="trace"><span>Trace</span><span class="mono">' + TRACE + '</span>' + UI.btn('Copy', { kind: 'ghost', size: 'sm', attrs: 'data-copy="' + TRACE + '"' }) + '<span class="right"></span>' + (member ? '' : UI.btn('Retry extraction', { size: 'sm', icon: 'refresh', attrs: 'data-retry="' + esc(failedDoc.name) + '"' })) + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-dismissfail' }) + '</div></div>' : '';
      const qWords = st.query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = st.searched && qWords.length ? CHUNKS.filter((c) => qWords.some((w) => c.terms.includes(w))) : [];
      const visible = hits.filter((c) => c.label !== 'restricted');
      const filtered = hits.length - visible.length;
      const testSearch = () => '<section class="panel"><div class="phead"><div class="eyebrow">Test search</div><span class="muted" style="font-size:12px">Runs with your clearance: confidential. Restricted chunks are filtered inside the query.</span></div>'
        + '<div class="hstack" style="align-items:flex-end"><div class="field grow"><label for="kb-q">Query</label><input class="input" id="kb-q" value="' + esc(st.query) + '" placeholder="What would a user ask?"></div><div>' + UI.btn('Search', { attrs: 'data-search' }) + '</div></div>'
        + (st.searched ? UI.table(['Chunk', 'Vector', 'Full-text', 'Reranker', 'Label'], visible.map((c) => ({ cells: [esc(c.doc), c.v.toFixed(2), c.ft.toFixed(2), c.rr.toFixed(2), UI.label(c.label, { sm: true })], attrs: 'data-chunk="' + esc(c.doc) + '"' })), { minWidth: '0', emptyTitle: 'No chunks match', emptyText: 'Nothing in ' + kb.name + ' scores above the threshold for this query.' }) + '<div class="muted" style="font-size:12px">Hybrid: pgvector HNSW plus full-text, fused with reciprocal rank fusion, then reranked. ' + (filtered ? filtered + ' restricted chunk' + (filtered > 1 ? 's' : '') + ' filtered by clearance before ranking.' : 'No chunks were filtered by clearance.') + '</div>' : '') + '</section>';

      let body = '';
      if (st.tab === 'sources') body = sourcesTable() + '<div class="hstack"><div class="eyebrow grow">Documents</div>' + UI.btn('All documents', { kind: 'ghost', size: 'sm', attrs: 'data-tab="documents"' }) + '</div>' + docsTable(docs.slice(0, 5)) + failedPanel + testSearch();
      else if (st.tab === 'documents') body = '<div class="toolbar">' + UI.search('Search documents', 'data-docq', st.docq) + '<span class="muted" style="font-size:12px">' + docs.length + ' shown of ' + kb.sub.split(' ')[0] + ' documents</span></div>' + docsTable(docs.filter((d) => !st.docq || (d.name + ' ' + d.state + ' ' + d.label).toLowerCase().includes(st.docq.toLowerCase()))) + failedPanel;
      else if (st.tab === 'index') body = '<section class="panel"><div class="phead"><div class="eyebrow">Index ' + esc(kb.index) + '</div>' + UI.pill('serving', 'ok') + '</div>' + UI.kv([['Embedding model', '<span class="mono">' + esc(kb.embed) + '</span> via the gateway, cached by content hash for 30 days'], ['Vector index', 'pgvector HNSW, m 16, ef_construction 200'], ['Full-text', 'Postgres tsvector, english'], ['Chunks', esc(kb.chunks)], ['Chunking', 'structure-aware, 500 to 1,000 tokens with overlap, headings kept as metadata'], ['Reranker', '<span class="mono">bge-reranker-v2-m3</span>, optional per profile'], ['Last full build', esc(kb.built)], ['Label per chunk', 'the higher of the manual label and the auto-classifier result']], 2) + '</section>'
        + (swap ? '<section class="panel"><div class="phead"><div class="eyebrow">Index ' + (kb.id === 'finance' ? 'v8' : 'v6') + ' building</div>' + UI.pill('building', 'info') + '</div>' + UI.meter('Embedding with bge-m3', '71% of ' + esc(kb.chunks) + ' chunks', 71, 'accent') + '<div class="fg2">Built beside ' + esc(kb.index) + ' with the new embedding model. Retrieval keeps using ' + esc(kb.index) + ' until the switch, which is atomic. About 40 minutes left on gpu-small-1.</div>' + (member ? '' : '<div class="hstack">' + UI.btn('Cancel build', { size: 'sm', attrs: 'data-cancelbuild' }) + '</div>') + '</section>' : '');
      else if (st.tab === 'access') body = UI.table(['Principal', 'Access', 'Via', 'State'], ACCESS, { clickable: false, minWidth: '0' }) + UI.notice('Retrieval filters chunks above the reader\'s clearance inside the query, so a search never sees a chunk it may not return. Restricted chunks are returned only to principals with restricted clearance.', 'info') + (member ? '' : '<div>' + UI.btn('Add principal', { icon: 'plus', attrs: 'data-addprincipal' }) + '</div>');
      else body = testSearch();

      root.innerHTML = '<style>.kb-list{display:flex;flex-direction:column;gap:2px}.kb-page > *{flex-shrink:0}</style>'
        + '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Knowledge bases</div>' + (member ? '' : UI.btn('New', { size: 'sm', attrs: 'data-newkb' })) + '</div>' + UI.search('Filter', 'data-filter', st.filter).replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="kb-list">' + kbList.map((k) => UI.listItem(esc(k.name), esc(k.sub), { active: k.id === kb.id, attrs: 'data-kb="' + k.id + '"', right: UI.label(k.label, { sm: true }) })).join('') + (kbList.length ? '' : UI.empty('No knowledge base matches', 'Try another word.')) + '</div></div>'
        + '<div class="page kb-page">'
        + (member ? UI.notice('You are viewing as a member. Sources and documents are read-only; relabel, reindex and source changes need the knowledge curator role.', 'info', '<a href="#" data-leavemember>Back to curator view</a>') : '')
        + UI.pagehead(kb.name, 'Embedding ' + esc(kb.embed) + ', index ' + esc(kb.index) + ', HNSW plus full-text · ' + UI.pill(kb.status, 'ok'), member ? '' : UI.btn('Reindex', { attrs: 'data-reindex' }) + UI.btn('Add source', { kind: 'primary', attrs: 'data-addsource' }))
        + (swap && st.tab !== 'index' ? UI.notice('Index ' + (kb.id === 'finance' ? 'v8' : 'v6') + ' is building beside ' + esc(kb.index) + ' with a new embedding model: 71% complete. Retrieval keeps using ' + esc(kb.index) + ' until the atomic switch.', 'info', '<a href="#" data-tab="index">Index</a>') : '')
        + (st.quarantine && kb.id === 'finance' ? UI.notice('<b>invoice-scan.pdf</b> is held in quarantine until the malware scan and classification pass. It cannot be attached or indexed yet.', 'warn', '<a href="#" data-doc="invoice-scan.pdf">Details</a>') : '')
        + UI.tabs([{ id: 'sources', label: 'Sources' }, { id: 'documents', label: 'Documents' }, { id: 'index', label: 'Index' }, { id: 'access', label: 'Access' }, { id: 'test', label: 'Test search' }], st.tab)
        + body
        + '<div style="margin-top:6px"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div>';

      // ---- events ----
      ctx.on('click', '[data-kb]', (e, t) => { st.kb = t.dataset.kb; st.failedOpen = false; st.docq = ''; ctx.rerender(); });
      ctx.on('input', '[data-filter]', (e, t) => { st.filter = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-filter]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('input', '[data-docq]', (e, t) => { st.docq = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-docq]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-tab]', (e, t) => { e.preventDefault(); st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('input', '#kb-q', (e, t) => { st.query = t.value; });
      ctx.on('keydown', '#kb-q', (e) => { if (e.key === 'Enter') { e.preventDefault(); st.searched = true; ctx.rerender(); } });
      ctx.on('click', '[data-search]', () => { st.searched = true; ctx.rerender(); });
      ctx.on('click', '[data-leavemember]', (e) => { e.preventDefault(); st.member = false; ctx.rerender(); });
      ctx.on('click', '[data-dismissfail]', () => { st.failedOpen = false; ctx.rerender(); });
      ctx.on('click', 'tr[data-chunk]', (e, t) => { const c = CHUNKS.find((x) => x.doc === t.dataset.chunk); ctx.drawer({ title: esc(c.doc), body: UI.kv([['Vector', c.v.toFixed(2)], ['Full-text', c.ft.toFixed(2)], ['Reranker', c.rr.toFixed(2)], ['Label', UI.label(c.label, { sm: true })]], 2) + UI.ctx('Chunk text', c.doc.startsWith('Q3') ? 'Field Sales exceeded its travel allocation in each month of the quarter. The Lisbon onboarding programme carried an approved exception of 38,000 EUR, agreed by the CFO on 2 July.' : c.doc.startsWith('Travel budget') ? 'Q3 travel: budget 361,500.00, actual 412,880.00, variance 51,380.00 (14.2%). LIS-ONBOARD 96,310.00 against 60,000.00.' : 'Taxis after 22:00 need no pre-approval where public transport has stopped running. A receipt is still required.', c.label) + '<div class="muted" style="font-size:12px">Headings and page are kept as chunk metadata and cited as the source ID in answers.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) }); });
      ctx.on('click', 'tr[data-src]', (e, t) => {
        const s = sources.find((x) => x.src === t.dataset.src);
        const quarantined = /quarantin/.test(s.status);
        ctx.drawer({ title: (s.mono ? '<span class="mono">' : '') + esc(s.src) + (s.mono ? '</span>' : ''), body: UI.kv([['Type', esc(s.type)], ['Sync', esc(s.sync)], ['Documents', String(s.docs)], ['Status', statePill(s.status)], ['Schedule', s.type === 'Upload' ? 'manual' : 'every 15 min, incremental by watermark'], ['Label floor', UI.label(kb.label, { sm: true })]], 2)
          + (quarantined ? UI.table(['File', 'Scan', 'Classification', 'Held since'], [['<span class="mono">invoice-scan.pdf</span>', UI.pill('pending', 'warn'), UI.pill('pending', 'warn'), '11 min']], { clickable: false, minWidth: '0' }) + '<div class="fg2">Quarantined uploads cannot be attached or indexed until the malware scan and classification jobs pass.</div>' : '<div class="fg2">Unchanged documents are skipped by content hash. Each document keeps the higher of its manual label and the auto-classifier result.</div>'),
          actions: member ? UI.btn('Close', { attrs: 'data-close' }) : UI.btn('Sync now', { icon: 'refresh', attrs: 'data-syncnow' }) + UI.btn('Remove source', { kind: 'danger', attrs: 'data-removesrc' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(d) {
            const sn = d.querySelector('[data-syncnow]'); if (sn) sn.addEventListener('click', () => { App.closeOverlay(); setOverrideSource(s, 'syncing'); ctx.toast('Sync queued for <span class="mono">' + esc(s.src) + '</span>. Incremental by watermark.', 'ok'); });
            const rm = d.querySelector('[data-removesrc]'); if (rm) rm.addEventListener('click', async () => { App.closeOverlay(); const ok = await ctx.confirm({ title: 'Remove source', tag: 'destructive', tone: 'danger', ok: 'Remove', body: '<div class="fg2">Documents and chunks from this source leave the index at the next build. Cached retrieval results for ' + esc(kb.name) + ' are invalidated by the version bump.</div>', kv: [['Source', esc(s.src)], ['Documents', String(s.docs)]] }); if (ok) { s.removed = true; SOURCES[kb.id] = SOURCES[kb.id].filter((x) => x !== s); st.added[kb.id] = (st.added[kb.id] || []).filter((x) => x !== s); ctx.rerender(); ctx.toast('Source removed. ' + s.docs + ' documents scheduled for removal.'); } });
          } });
      });
      function setOverrideSource(s, status) { s.status = status; s.sync = s.type === 'Upload' ? 'manual' : 'running since 12:14'; ctx.rerender(); }
      ctx.on('click', '[data-doc]', (e, t) => {
        e.preventDefault();
        const d = docs.find((x) => x.name === t.dataset.doc); if (!d) return;
        const failed = d.state === 'extraction failed', quarantined = d.state === 'quarantined';
        ctx.drawer({ title: esc(d.name), body: '<div class="hstack">' + UI.label(d.label) + statePill(d.state) + '</div>' + UI.kv([['Label origin', esc(d.origin)], ['Chunks', String(d.chunks)], ['Source', '<span class="mono">' + esc(d.source) + '</span>'], ['Size', esc(d.size)], ['Content hash', '<span class="mono">' + esc(d.hash) + '</span>'], ['Knowledge base', esc(kb.name)]], 2)
          + (failed ? UI.problem('Extraction failed', 'The PDF is password protected, so the index.document job could not extract text. Upload an unlocked copy, or remove the password and retry.', TRACE) : quarantined ? UI.notice('Held until the malware scan and classification pass. It cannot be attached or indexed yet.', 'warn') : d.state === 'unchanged, skipped' ? '<div class="fg2">The content hash matched the previous build, so extraction and embedding were skipped.</div>' : '<div class="fg2">Chunks carry this label, the tenant, the source version and an ACL. Restricted chunks are never cached.</div>'),
          actions: member || quarantined ? UI.btn('Close', { attrs: 'data-close' }) : (failed ? UI.btn('Retry extraction', { kind: 'primary', icon: 'refresh', attrs: 'data-retry="' + esc(d.name) + '"' }) : UI.btn('Reindex document', { icon: 'refresh', attrs: 'data-reindexdoc' })) + UI.btn('Relabel', { icon: 'edit', attrs: 'data-relabel' }) + UI.btn('Remove', { kind: 'danger', attrs: 'data-removedoc' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(dr) {
            const rl = dr.querySelector('[data-relabel]'); if (rl) rl.addEventListener('click', () => relabel(d));
            const ri = dr.querySelector('[data-reindexdoc]'); if (ri) ri.addEventListener('click', () => { App.closeOverlay(); override(d, { state: 'indexing' }); ctx.toast('index.document queued for ' + esc(d.name) + '. Embeddings come from cache where the hash matches.', 'ok'); });
            const rt = dr.querySelector('[data-retry]'); if (rt) rt.addEventListener('click', () => { App.closeOverlay(); retry(d); });
            const rm = dr.querySelector('[data-removedoc]'); if (rm) rm.addEventListener('click', async () => { App.closeOverlay(); const ok = await ctx.confirm({ title: 'Remove document', tag: 'destructive', tone: 'danger', ok: 'Remove', body: '<div class="fg2">The document and its ' + d.chunks + ' chunks leave the index at the next build. Retrieval cache entries for ' + esc(kb.name) + ' are invalidated.</div>', kv: [['Document', esc(d.name)], ['Label', UI.label(d.label, { sm: true })]] }); if (ok) { override(d, { state: 'removing', chunks: 0 }); ctx.toast('Removal queued for ' + esc(d.name) + '.'); } });
          } });
      });
      function override(d, o) { st.overrides[kb.id + d.name] = Object.assign({}, st.overrides[kb.id + d.name] || {}, o); ctx.rerender(); }
      function retry(d) { ctx.confirm({ title: 'Retry extraction', tone: 'primary', ok: 'Retry', body: '<div class="fg2">Runs index.document again for this file. If the password is still set the job fails with the same trace.</div>', kv: [['Document', esc(d.name)], ['Last error', 'password protected'], ['Trace', '<span class="mono">' + TRACE.slice(0, 12) + '…</span>']] }).then((ok) => { if (!ok) return; st.failedOpen = false; override(d, { state: 'indexing', chunks: 0 }); ctx.toast('Extraction retried for ' + esc(d.name) + '. Job index.document queued.', 'ok'); }); }
      ctx.on('click', '[data-retry]', (e, t) => { const d = docs.find((x) => x.name === t.dataset.retry); if (d) retry(d); });
      function relabel(d) {
        ctx.modal({ title: 'Relabel ' + esc(d.name), body: UI.field('Label', UI.select(['public', 'internal', 'confidential', 'restricted'], d.label, 'data-lbl'), 'A manual label can raise the auto-classifier result but not lower it below the classifier\'s finding.') + UI.field('Reason', UI.textarea('', { placeholder: 'Recorded in the audit log', rows: 2, attrs: 'data-reason' })) + UI.notice('Chunks take the new label at the next build. Cached retrieval results for ' + esc(kb.name) + ' are invalidated by the version bump.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Relabel', { kind: 'primary', attrs: 'data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { const l = m.querySelector('[data-lbl]').value; const auto = /auto-classifier/.test(d.origin); if (auto && ['public', 'internal', 'confidential', 'restricted'].indexOf(l) < ['public', 'internal', 'confidential', 'restricted'].indexOf(d.label)) { ctx.toast('Refused: the auto-classifier found ' + esc(d.origin.split(', ')[1]) + ', so the label cannot go below ' + esc(d.label) + '.', 'danger'); return; } App.closeOverlay(); override(d, { label: l, origin: 'manual' }); ctx.toast(esc(d.name) + ' relabelled ' + esc(l) + '. Audit entry written.', 'ok'); }); } });
      }
      ctx.on('click', '[data-reindex]', async () => { const ok = await ctx.confirm({ title: 'Reindex ' + esc(kb.name), tone: 'primary', ok: 'Start build', body: '<div class="fg2">A new index builds beside ' + esc(kb.index) + '. Retrieval keeps using ' + esc(kb.index) + ' until the build completes and the switch is atomic. Unchanged documents are skipped by hash.</div>', kv: [['Embedding model', '<span class="mono">bge-m3</span> (new)'], ['Chunks', esc(kb.chunks)], ['Estimated', 'about 2 h on gpu-small-1'], ['Cost', 'embeddings not in cache: about 61%']] }); if (!ok) return; st.swap = true; st.tab = 'index'; ctx.rerender(); ctx.toast('Index ' + (kb.id === 'finance' ? 'v8' : 'v6') + ' is building beside ' + esc(kb.index) + '.', 'ok'); });
      ctx.on('click', '[data-cancelbuild]', async () => { const ok = await ctx.confirm({ title: 'Cancel the index build', tone: 'danger', ok: 'Cancel build', body: '<div class="fg2">The partial index is discarded. Retrieval is unaffected because ' + esc(kb.index) + ' never stopped serving.</div>' }); if (!ok) return; st.swap = false; kb.swap = false; ctx.rerender(); ctx.toast('Build cancelled. ' + esc(kb.index) + ' keeps serving.'); });
      ctx.on('click', '[data-addsource]', () => openAdd());
      function openAdd() {
        ctx.drawer({ title: 'Add source to ' + esc(kb.name), body: UI.field('Type', UI.select(['Upload', 'S3 prefix', 'Git repository', 'Postgres view'], 'S3 prefix', 'data-type')) + UI.field('Location', UI.input('', { placeholder: 's3://bucket/prefix/, git: org/repo, pg: schema.view', attrs: 'data-loc' }), 'Credentials come from the connection, never from this form.') + UI.field('Label floor', UI.select(['public', 'internal', 'confidential', 'restricted'], kb.label, 'data-floor'), 'Documents get at least this label; the auto-classifier can raise it.') + UI.field('Sync', UI.select(['every 15 min, incremental', 'hourly', 'daily', 'manual'], 'every 15 min, incremental')) + UI.notice('Uploads go to quarantine first. Other sources are read with the connection\'s allow-list and sync by watermark.', 'info'), actions: UI.btn('Add and sync', { kind: 'primary', attrs: 'data-go' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }), onMount(d) {
          d.querySelector('[data-go]').addEventListener('click', () => { const loc = d.querySelector('[data-loc]').value.trim(); const type = d.querySelector('[data-type]').value; if (!loc && type !== 'Upload') { ctx.toast('Give the source a location.'); return; } App.closeOverlay(); (st.added[kb.id] = st.added[kb.id] || []).push({ src: loc || 'Uploads', mono: !!loc, type, sync: 'first sync running', docs: 0, status: 'syncing' }); st.tab = 'sources'; ctx.rerender(); ctx.toast('Source added. First sync started; documents appear as they are extracted.', 'ok'); });
          setTimeout(() => { const i = d.querySelector('[data-loc]'); if (i) i.focus(); }, 30);
        } });
      }
      ctx.on('click', '[data-newkb]', () => ctx.modal({ title: 'New knowledge base', body: UI.field('Name', UI.input('', { placeholder: 'Treasury KB', attrs: 'data-name' })) + UI.field('Label floor', UI.select(['public', 'internal', 'confidential'], 'internal')) + UI.field('Embedding model', UI.select(['nomic-embed-text', 'bge-m3'], 'nomic-embed-text'), 'Changing it later builds a new index beside the old one.') + UI.field('Shared with', UI.select(['Finance Ops members', 'Curators only'], 'Finance Ops members')), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { const n = m.querySelector('[data-name]').value.trim(); if (!n) { ctx.toast('Give it a name.'); return; } App.closeOverlay(); if (!KBS.find((k) => k.name === n)) { const id = 'kb' + (KBS.length + 1); KBS.push({ id, name: n, sub: '0 documents', label: 'internal', status: 'draft', embed: 'nomic-embed-text', index: 'v1', chunks: '0', built: 'not yet' }); SOURCES[id] = []; DOCS[id] = []; st.kb = id; } ctx.rerender(); ctx.toast('Created ' + esc(n) + '. Add a source to start indexing.', 'ok'); }); } }));
      ctx.on('click', '[data-addprincipal]', () => ctx.modal({ title: 'Share ' + esc(kb.name), body: UI.field('Principal', UI.select(['Field Sales (workspace)', 'People Ops (workspace)', 'Contracts agent (agent)', 'Sam Reyes (user)'], 'Field Sales (workspace)')) + UI.field('Access', UI.select(['read', 'manage'], 'read')) + UI.notice('Sharing does not lift the clearance filter: readers still see only chunks at or below their clearance.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Share', { kind: 'primary', attrs: 'data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { App.closeOverlay(); ACCESS[3] = ['Field Sales', 'read', 'shared by Mara Okafor', UI.pill('active', 'ok')]; ctx.rerender(); ctx.toast('Shared with Field Sales. Audit entry written.', 'ok'); }); } }));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (st.openAdd) { st.openAdd = false; setTimeout(openAdd, 30); }
    }
  });
})();
