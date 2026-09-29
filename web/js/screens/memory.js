(function () {
  const { UI, esc } = App;

  const MINE = [
    { id: 'm1', text: 'Reports travel figures in EUR, net of VAT', type: 'user', label: 'internal', from: 'Chat, 19 Sep, turn 4', source: { convo: 'c1', title: 'Q3 travel overrun, turn 4' }, expires: 'none', state: 'active', by: 'You, accepted a proposal', backend: 'Postgres', history: ['v2, 19 Sep: added "net of VAT"', 'v1, 3 Aug: "Reports travel figures in EUR"'] },
    { id: 'm2', text: 'Current project: Q3 close for Finance Ops', type: 'user', label: 'internal', from: 'You told me, 12 Sep', expires: '31 Dec 2026', state: 'active', by: 'You', backend: 'Postgres', history: ['v1, 12 Sep: added in chat with "remember that"'] },
    { id: 'm3', text: 'Prefers tables over prose for variance analysis', type: 'user', label: 'public', from: 'Extraction, 9 Sep', source: { convo: 'c4', title: 'Reconcile card feed, turn 2' }, expires: 'none', state: 'proposed', by: 'Post-turn extraction job', backend: 'Postgres, pending', history: ['proposed 9 Sep from Reconcile card feed; passed the memory-write checkpoint'] },
    { id: 'm4', text: 'Cost centre LIS-ONBOARD closes in October', type: 'user', label: 'confidential', from: 'Chat, 2 Sep, turn 11', source: { convo: 'c1', title: 'Q3 travel overrun, turn 11' }, expires: '1 Nov 2026', state: 'superseded', by: 'You, accepted a proposal', backend: 'Postgres', history: ['superseded 12 Sep by "Current project: Q3 close for Finance Ops"', 'v1, 2 Sep'] },
    { id: 'm5', text: 'Manager is covering approvals until 30 Sep', type: 'user', label: 'internal', from: 'You told me, 1 Sep', expires: '30 Sep 2026', state: 'active', by: 'You', backend: 'Postgres', history: ['v1, 1 Sep'] },
    { id: 'm6', text: 'Rolling summary of Q3 travel overrun, 12 turns', type: 'episodic', label: 'confidential', from: 'Background summariser, 19 Sep', source: { convo: 'c1', title: 'Q3 travel overrun' }, expires: 'with the conversation', state: 'active', by: 'Summariser, chat-default', backend: 'Postgres', history: ['regenerated 19 Sep after turn 12', 'regenerated 18 Sep after turn 8'] }
  ];
  const WORKSPACE = [
    { id: 'w1', text: 'Variance is reported as actual minus budget; positive means overspend', type: 'convention', label: 'internal', from: 'Mara Okafor, 4 Aug', author: 'Mara Okafor', expires: 'none', state: 'active', backend: 'Postgres', history: ['v1, 4 Aug'] },
    { id: 'w2', text: '"Close" means the month-end close calendar, not the ledger close job', type: 'glossary', label: 'internal', from: 'Sam Reyes, 11 Aug', author: 'Sam Reyes', expires: 'none', state: 'active', backend: 'Postgres', history: ['v2, 2 Sep: clarified the ledger job', 'v1, 11 Aug'] },
    { id: 'w3', text: 'Cost centre owner for FIELD-SALES: Priya Nair', type: 'contact', label: 'internal', from: 'Sam Reyes, 15 Aug', author: 'Sam Reyes', expires: '31 Mar 2027', state: 'active', backend: 'Postgres', history: ['v1, 15 Aug'] },
    { id: 'w4', text: 'Board pack figures are quoted in thousands of EUR', type: 'convention', label: 'confidential', from: 'Mara Okafor, 3 Sep', author: 'Mara Okafor', expires: 'none', state: 'active', backend: 'Postgres', history: ['v1, 3 Sep'] },
    { id: 'w5', text: 'Treasury contact for FX rates: treasury@northwind.local', type: 'contact', label: 'internal', from: 'Lena Vogt, 18 Sep', author: 'Lena Vogt', expires: 'none', state: 'proposed', backend: 'Postgres, pending', history: ['proposed 18 Sep by a member; waits for a curator'] }
  ];
  const AGENTS = [
    { id: 'a1', text: 'jira-internal.create_issue returned 502 twice under load; report instead of retrying', type: 'tool quirk', agent: 'Data analyst agent', label: 'internal', from: 'Run 7f3a, step 7', run: '7f3a', expires: '19 Dec 2026', state: 'active', backend: 'MongoDB', history: ['v1, 19 Sep, written by the agent within its limits'] },
    { id: 'a2', text: 'Q3 close progress: ledger reconciled, 3 unmatched card lines open', type: 'progress', agent: 'Data analyst agent', label: 'confidential', from: 'Run 7e91', run: '7e91', expires: 'with the run series', state: 'active', backend: 'MongoDB', history: ['v3, 19 Sep', 'v2, 18 Sep', 'v1, 16 Sep'] },
    { id: 'a3', text: 'ledger.query needs a cost_centre filter to stay under 500 rows', type: 'tool quirk', agent: 'Data analyst agent', label: 'internal', from: 'Run 7c22', run: '7c22', expires: '19 Dec 2026', state: 'active', backend: 'MongoDB', history: ['v1, 19 Sep'] },
    { id: 'a4', text: 'Transcripts longer than 40 min need chunked summarisation', type: 'tool quirk', agent: 'video-to-notes v3', label: 'internal', from: 'Workflow run 3311', expires: '19 Dec 2026', state: 'active', backend: 'MongoDB', history: ['v1, 14 Sep'] }
  ];
  const TABS = { mine: MINE, workspace: WORKSPACE, agents: AGENTS };
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];

  App.register({
    id: 'memory', title: 'Memory', summary: 'Own memories, workspace and agent memories, proposals, editor, forget everywhere',
    crumb: ['Memory'],
    commands: [{ label: 'Add a memory', sub: 'Memory', run(app) { app.stateFor('memory').openAdd = true; app.render(); } }],
    states: [
      { title: 'Forget', tone: 'danger', text: 'Confirmation states that the record, its embeddings and every cache entry are deleted in all backends, and that this cannot be undone.', apply(ctx) { ctx.state.tab = 'mine'; ctx.state.empty = false; ctx.state.sel = ctx.state.sel || 'm1'; ctx.rerender(); setTimeout(() => { const b = ctx.$('[data-forget]'); if (b) b.click(); }, 40); } },
      { title: 'Restricted disabled', tone: 'warn', text: 'Tenant policy does not allow restricted memories. A proposal at that level is refused with the reason.', apply(ctx) { ctx.state.tab = 'mine'; ctx.state.empty = false; ctx.state.refused = true; ctx.rerender(); } },
      { title: 'Workspace scope', tone: 'neutral', text: 'Curators see team conventions, glossary and contacts with the author of each entry.', apply(ctx) { ctx.state.tab = 'workspace'; ctx.state.empty = false; ctx.state.sel = 'w1'; ctx.rerender(); } },
      { title: 'Nothing remembered', tone: 'neutral', text: 'Empty state explains what memory is, that it is off until something is accepted, and how to add the first entry.', apply(ctx) { ctx.state.tab = 'mine'; ctx.state.empty = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }
      st.tab = TABS[st.tab] ? st.tab : 'mine'; st.query = st.query || ''; st.type = st.type || 'all'; st.stateF = st.stateF || 'all';
      st.removed = st.removed || {}; st.over = st.over || {}; st.addedRows = st.addedRows || [];
      const all = (st.tab === 'mine' ? MINE.concat(st.addedRows) : TABS[st.tab]).filter((m) => !st.removed[m.id]).map((m) => Object.assign({}, m, st.over[m.id] || {}));
      const rows = st.empty ? [] : all.filter((m) => (!st.query || (m.text + ' ' + m.from + ' ' + (m.agent || '') + ' ' + (m.author || '')).toLowerCase().includes(st.query.toLowerCase())) && (st.type === 'all' || m.type === st.type) && (st.stateF === 'all' || m.state === st.stateF));
      if (!rows.find((m) => m.id === st.sel)) st.sel = rows.length ? rows[0].id : null;
      const sel = rows.find((m) => m.id === st.sel);
      const types = ['all'].concat(all.map((m) => m.type).filter((t, i, a) => a.indexOf(t) === i));
      const states = ['all', 'active', 'proposed', 'superseded'];
      const proposed = all.filter((m) => m.state === 'proposed');
      const canEdit = true;
      const statePill = (s) => s === 'active' ? UI.pill(s, 'ok') : s === 'proposed' ? UI.pill(s, 'info') : s === 'refused' ? UI.pill(s, 'danger') : UI.pill(s, '');

      const cols = st.tab === 'mine' ? ['Memory', 'Type', 'Label', 'Came from', 'Expires', 'State'] : st.tab === 'workspace' ? ['Memory', 'Type', 'Label', 'Author', 'Expires', 'State'] : ['Memory', 'Agent', 'Label', 'Written by', 'Expires', 'State'];
      const cells = (m) => st.tab === 'mine' ? [esc(m.text), esc(m.type), UI.label(m.label, { sm: true }), esc(m.from), esc(m.expires), statePill(m.state)]
        : st.tab === 'workspace' ? [esc(m.text), esc(m.type), UI.label(m.label, { sm: true }), esc(m.author), esc(m.expires), statePill(m.state)]
        : [esc(m.text), esc(m.agent), UI.label(m.label, { sm: true }), esc(m.from), esc(m.expires), statePill(m.state)];

      const sourceLink = (m) => m.source ? '<a href="#" data-goconvo="' + esc(m.source.convo) + '">' + esc(m.source.title) + '</a>' : m.run ? '<a href="#" data-gorun="' + esc(m.run) + '">' + esc(m.from) + '</a>' : esc(m.from);
      const inspector = sel ? '<div class="hstack"><div class="eyebrow grow">Selected memory</div>' + statePill(sel.state) + '</div><div style="font-size:15px;font-weight:600">' + esc(sel.text) + '</div>'
        + UI.kv([['Label', UI.label(sel.label, { sm: true }) + (canEdit ? ' ' + UI.btn('Relabel', { kind: 'ghost', size: 'xs', attrs: 'data-relabel' }) : '')], ['Source', sourceLink(sel)], ['Written by', esc(sel.by || (st.tab === 'workspace' ? sel.author + ', curator' : sel.agent + ', within its limits'))], ['Expires', esc(sel.expires === 'none' ? 'never' : sel.expires)], ['Backend', esc(sel.backend)], ['Scope', st.tab === 'mine' ? 'you, across conversations' : st.tab === 'workspace' ? 'Finance Ops' : esc(sel.agent) + ', across runs']], 1)
        + '<div class="eyebrow">History</div><div class="fg2 vstack gap4" style="font-size:12px">' + sel.history.map((h) => '<span>' + esc(h) + '</span>').join('') + '</div>'
        + (sel.state === 'proposed' ? '<div class="hstack gap6">' + UI.btn('Accept', { kind: 'primary', attrs: 'data-accept="' + sel.id + '"' }) + UI.btn('Reject', { attrs: 'data-reject="' + sel.id + '"' }) + '</div>' : '<div class="hstack wrap gap6">' + UI.btn('Edit', { attrs: 'data-edit' }) + UI.btn('Set expiry', { attrs: 'data-expiry' }) + UI.btn('Forget', { kind: 'danger', attrs: 'data-forget' }) + '</div>')
        + '<div class="muted" style="font-size:12px">Forget removes the record, its embeddings and every cache entry from ' + esc(sel.backend.split(',')[0]) + ' and Redis. Writes are audited.</div>'
        : '<div class="eyebrow">Selected memory</div>' + UI.empty('Nothing selected', st.empty ? 'Memory is empty. Add an entry or accept a proposal to see it here.' : 'Select a row to see its label, source, history and actions.');

      const retention = st.tab === 'workspace' ? 'Retention: workspace memories keep 2 years by tenant policy. Curators edit any entry; members propose.' : st.tab === 'agents' ? 'Retention: agent memories keep 90 days by tenant policy. Agents write within their limits; you can edit or forget any entry.' : 'Retention: your memories keep until you forget them or they expire. Restricted memories are disabled by tenant policy.';

      root.innerHTML = '<style>.mem-page > *{flex-shrink:0}</style>'
        + '<div class="page mem-page">'
        + UI.pagehead('Memory', st.tab === 'mine' ? 'Everything remembered about you. You can change or delete any of it.' : st.tab === 'workspace' ? 'Team conventions, glossary and contacts for Finance Ops, with the author of each entry.' : 'What agents remember across runs: progress state and known tool quirks.', UI.btn(st.tab === 'mine' ? 'Export mine' : 'Export', { icon: 'download', attrs: 'data-export' }) + UI.btn('Add a memory', { kind: 'primary', icon: 'plus', attrs: 'data-add' }))
        + UI.tabs([{ id: 'mine', label: 'Mine', count: MINE.concat(st.addedRows).filter((m) => !st.removed[m.id]).length }, { id: 'workspace', label: 'Workspace', count: WORKSPACE.filter((m) => !st.removed[m.id]).length }, { id: 'agents', label: 'Agents', count: AGENTS.filter((m) => !st.removed[m.id]).length }], st.tab)
        + (st.refused ? UI.notice('<b>Proposal refused.</b> "Supplier IBAN for Contoso payments" was labelled restricted by the memory-write checkpoint. Tenant policy does not allow restricted memories, so nothing was saved.', 'warn', '<a href="#" data-goguard>Rule</a> ' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-dismissrefused' })) : '')
        + (proposed.length && !st.empty ? UI.notice(proposed.length + ' proposed ' + (proposed.length > 1 ? 'memories are' : 'memory is') + ' waiting for ' + (st.tab === 'workspace' ? 'a curator' : 'you') + '. Nothing is saved until ' + (st.tab === 'workspace' ? 'it is' : 'you') + ' accept' + (st.tab === 'workspace' ? 'ed' : '') + ' it.', 'info', UI.btn('Review', { size: 'sm', attrs: 'data-review' })) : '')
        + (st.empty ? UI.empty('Nothing remembered yet', 'Memory is labelled facts and summaries that outlive a conversation: your preferences, your current project, team conventions. It stays off until you accept a proposal in chat or add an entry here. Everything can be edited, relabelled or forgotten, and forgetting removes it from every backend and cache.', UI.btn('Add a memory', { kind: 'primary', icon: 'plus', attrs: 'data-add' }) + ' ' + UI.btn('Show the example set', { kind: 'ghost', attrs: 'data-unempty' }))
          : '<div class="toolbar mem-filters">' + UI.search('Search memories', 'data-search', st.query).replace('class="search"', 'class="search" style="width:320px"') + '<span class="relative">' + UI.btn('Type: ' + st.type, { icon: 'chevd', attrs: 'data-pick="type"' }) + '</span><span class="relative">' + UI.btn('State: ' + st.stateF, { icon: 'chevd', attrs: 'data-pick="state"' }) + '</span><span class="muted right" style="font-size:12px">' + esc(retention) + '</span></div>'
          + UI.table(cols, rows.map((m) => ({ cells: cells(m), attrs: 'data-id="' + m.id + '"', selected: m.id === st.sel })), { minWidth: '0', emptyTitle: 'No memories match', emptyText: 'Try another word or clear the filters.' }))
        + '<div style="margin-top:6px"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div>'
        + '<aside class="inspector">' + inspector + '</aside>';

      // ---- events ----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; st.type = 'all'; st.stateF = 'all'; st.sel = null; st.empty = false; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', 'tr[data-id]', (e, t) => { st.sel = t.dataset.id; ctx.rerender(); });
      ctx.on('click', '[data-unempty]', () => { st.empty = false; ctx.rerender(); });
      ctx.on('click', '[data-dismissrefused]', () => { st.refused = false; ctx.rerender(); });
      ctx.on('click', '[data-goguard]', (e) => { e.preventDefault(); ctx.navigate('guardrails'); });
      ctx.on('click', '[data-goconvo]', (e, t) => { e.preventDefault(); ctx.navigate('chat', { convo: t.dataset.goconvo }); });
      ctx.on('click', '[data-gorun]', (e, t) => { e.preventDefault(); ctx.navigate('runs', { run: t.dataset.gorun }); });
      ctx.on('click', '[data-pick]', (e, t) => {
        const host = t.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
        const d = document.createElement('div'); d.className = 'dropdown';
        const isType = t.dataset.pick === 'type'; const opts = isType ? types : states; const cur = isType ? st.type : st.stateF;
        d.innerHTML = '<div class="dh">' + (isType ? 'Memory type' : 'State') + '</div>' + opts.map((o) => '<button type="button" data-opt="' + esc(o) + '" class="' + (o === cur ? 'on' : '') + '">' + esc(o) + '</button>').join('');
        host.appendChild(d);
        d.addEventListener('click', (ev) => { const b = ev.target.closest('[data-opt]'); if (!b) return; if (isType) st.type = b.dataset.opt; else st.stateF = b.dataset.opt; d.remove(); ctx.rerender(); });
      });
      const set = (id, o) => { st.over[id] = Object.assign({}, st.over[id] || {}, o); };
      ctx.on('click', '[data-review]', () => {
        const p = proposed[0]; if (!p) return;
        ctx.modal({ title: 'Proposed memory', body: '<div class="serif" style="font-size:16px">"' + esc(p.text) + '"</div>' + UI.kv([['Proposed by', esc(p.by || p.author)], ['From', sourceLink(p)], ['Label', UI.label(p.label, { sm: true }) + ' <span class="muted">high-water mark of its sources</span>'], ['Checkpoint', UI.pill('passed', 'ok') + ' <span class="muted">PII rules, label check, no credentials</span>'], ['Expires', esc(p.expires === 'none' ? 'never' : p.expires)], ['Backend', esc(p.backend.split(',')[0])]], 2) + UI.notice('Nothing is saved until you accept. Rejecting discards the proposal and tells the extraction job not to propose it again.', 'info'), actions: UI.btn('Reject', { attrs: 'data-rej' }) + UI.btn('Accept', { kind: 'primary', attrs: 'data-acc' }), onMount(m) { m.querySelector('[data-acc]').addEventListener('click', () => { App.closeOverlay(); accept(p.id); }); m.querySelector('[data-rej]').addEventListener('click', () => { App.closeOverlay(); reject(p.id); }); } });
      });
      function accept(id) { const m = all.find((x) => x.id === id); set(id, { state: 'active', by: st.tab === 'workspace' ? m.author + ', accepted by Mara Okafor' : 'You, accepted a proposal', backend: m.backend.split(',')[0], history: ['accepted 20 Sep by Mara Okafor'].concat(m.history) }); st.sel = id; ctx.rerender(); ctx.toast('Saved as <b>' + esc(m.label) + '</b>. It enters prompts as a labelled Context-tier segment.', 'ok'); }
      function reject(id) { st.removed[id] = true; ctx.rerender(); ctx.toast('Proposal rejected. Nothing was saved.'); }
      ctx.on('click', '[data-accept]', (e, t) => accept(t.dataset.accept));
      ctx.on('click', '[data-reject]', (e, t) => reject(t.dataset.reject));
      ctx.on('click', '[data-edit]', () => {
        if (!sel) return;
        ctx.drawer({ title: 'Edit memory', body: UI.field('Memory', UI.textarea(sel.text, { rows: 3, attrs: 'data-text' }), 'Saving creates a new version. The old text stays in the history.') + UI.field('Label', UI.select(LABELS.slice(0, 3), sel.label, 'data-lbl'), 'Restricted is disabled by tenant policy.') + UI.field('Expires', UI.input(sel.expires === 'none' ? '' : sel.expires, { placeholder: 'never', attrs: 'data-exp' })) + UI.notice('The memory-write checkpoint runs again on save: PII rules, label check and a ban on credentials.', 'info'), actions: UI.btn('Save', { kind: 'primary', attrs: 'data-go' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }), onMount(d) {
          d.querySelector('[data-go]').addEventListener('click', () => { const text = d.querySelector('[data-text]').value.trim(); if (!text) { ctx.toast('A memory needs some text.'); return; } if (/password|secret|token|api key/i.test(text)) { ctx.toast('Refused by the memory-write checkpoint: it looks like a credential.', 'danger'); return; } const lbl = d.querySelector('[data-lbl]').value; const exp = d.querySelector('[data-exp]').value.trim() || 'none'; App.closeOverlay(); const v = sel.history.length + 1; set(sel.id, { text, label: lbl, expires: exp, history: ['v' + v + ', 20 Sep: edited by you'].concat(sel.history) }); ctx.rerender(); ctx.toast('Saved as v' + v + '. Embeddings refreshed; the previous version stays in the history.', 'ok'); });
        } });
      });
      ctx.on('click', '[data-relabel]', () => {
        if (!sel) return;
        ctx.modal({ title: 'Relabel memory', body: '<div class="fg2">"' + esc(sel.text) + '"</div>' + UI.field('Label', UI.select(LABELS, sel.label, 'data-lbl'), 'A memory cannot go below the high-water mark of its sources.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Relabel', { kind: 'primary', attrs: 'data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { const l = m.querySelector('[data-lbl]').value; if (l === 'restricted') { ctx.toast('Refused: tenant policy does not allow restricted memories.', 'danger'); return; } if (LABELS.indexOf(l) < LABELS.indexOf(sel.label) && sel.source) { ctx.toast('Refused: the source turn is ' + esc(sel.label) + ', so the memory cannot be lower.', 'danger'); return; } App.closeOverlay(); set(sel.id, { label: l, history: ['relabelled ' + l + ', 20 Sep by you'].concat(sel.history) }); ctx.rerender(); ctx.toast('Relabelled <b>' + esc(l) + '</b>. Cache entries for this memory were dropped.', 'ok'); }); } });
      });
      ctx.on('click', '[data-expiry]', () => {
        if (!sel) return;
        ctx.modal({ title: 'Set expiry', body: '<div class="fg2">"' + esc(sel.text) + '"</div>' + UI.field('Expires', UI.select(['never', '30 Sep 2026', '31 Dec 2026', '31 Mar 2027', 'with the conversation'], sel.expires === 'none' ? 'never' : sel.expires, 'data-exp'), 'Expired memories leave retrieval at once and are purged from every backend within a day.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { const v = m.querySelector('[data-exp]').value; App.closeOverlay(); set(sel.id, { expires: v === 'never' ? 'none' : v, history: ['expiry set to ' + v + ', 20 Sep by you'].concat(sel.history) }); ctx.rerender(); ctx.toast('Expiry set to ' + esc(v) + '.', 'ok'); }); } });
      });
      ctx.on('click', '[data-forget]', async () => {
        if (!sel) return;
        const ok = await ctx.confirm({ title: 'Forget this memory', tag: 'cannot be undone', tone: 'danger', ok: 'Forget everywhere', body: '<div class="fg2">"' + esc(sel.text) + '"</div><div class="fg2">This deletes the record, its embeddings and every cache entry in all backends. Conversations that already used it are unchanged; future prompts will not see it. This cannot be undone.</div>', kv: [['Record and history', esc(sel.backend.split(',')[0]) + ', ' + sel.history.length + ' version' + (sel.history.length > 1 ? 's' : '')], ['Embeddings', 'pgvector row'], ['Caches', 'Redis: retrieval results, embedding by hash'], ['Audit', 'a forget entry is written']] });
        if (!ok) return;
        st.removed[sel.id] = true; ctx.rerender(); ctx.toast('Forgotten. Deleted from ' + esc(sel.backend.split(',')[0]) + ' and Redis; audit entry written.', 'ok');
      });
      ctx.on('click', '[data-export]', async () => {
        const conf = all.filter((m) => m.label === 'confidential').length;
        const ok = await ctx.confirm({ title: 'Export ' + (st.tab === 'mine' ? 'my memories' : st.tab + ' memories'), tone: 'primary', ok: 'Export', body: (conf ? UI.notice('The export includes ' + conf + ' confidential ' + (conf > 1 ? 'entries' : 'entry') + '. The file is labelled confidential and the export is logged to audit.', 'warn') : '') + UI.field('Format', UI.select(['JSON with labels and provenance', 'CSV'], 'JSON with labels and provenance')), kv: [['Entries', String(all.length)], ['Includes', 'text, label, source, author, expiry, versions']] });
        if (!ok) return; ctx.toast('Export of ' + all.length + ' memories queued. You will get a download link when it is ready.', 'ok');
      });
      function openAdd() {
        ctx.drawer({ title: 'Add a memory', body: UI.field('What should be remembered?', UI.textarea('', { rows: 3, placeholder: 'Reports in thousands of EUR unless asked otherwise', attrs: 'data-text' })) + UI.field('Scope', UI.select(st.tab === 'workspace' ? ['Workspace: Finance Ops', 'Me'] : ['Me', 'Workspace: Finance Ops'], null, 'data-scope')) + UI.field('Type', UI.select(st.tab === 'workspace' ? ['convention', 'glossary', 'contact'] : ['user'], null, 'data-type')) + UI.field('Label', UI.select(LABELS, 'internal', 'data-lbl'), 'Restricted is disabled by tenant policy; a proposal at that level is refused.') + UI.field('Expires', UI.select(['never', '30 Sep 2026', '31 Dec 2026', '31 Mar 2027'], 'never', 'data-exp')) + UI.notice('The memory-write checkpoint runs before saving: PII rules, label check and a ban on storing credentials.', 'info'), actions: UI.btn('Save', { kind: 'primary', attrs: 'data-go' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }), onMount(d) {
          d.querySelector('[data-go]').addEventListener('click', () => {
            const text = d.querySelector('[data-text]').value.trim(); const lbl = d.querySelector('[data-lbl]').value; const exp = d.querySelector('[data-exp]').value; const scope = d.querySelector('[data-scope]').value; const type = d.querySelector('[data-type]').value;
            if (!text) { ctx.toast('Write what should be remembered.'); return; }
            if (lbl === 'restricted') { App.closeOverlay(); st.refused = true; ctx.rerender(); ctx.toast('Refused: tenant policy does not allow restricted memories.', 'danger'); return; }
            if (/password|secret|token|api key/i.test(text)) { ctx.toast('Refused by the memory-write checkpoint: credentials are never stored.', 'danger'); return; }
            App.closeOverlay();
            const id = 'n' + Date.now();
            if (scope.startsWith('Workspace')) { WORKSPACE.push({ id, text, type, label: lbl, from: 'Mara Okafor, 20 Sep', author: 'Mara Okafor', expires: exp === 'never' ? 'none' : exp, state: 'active', backend: 'Postgres', history: ['v1, 20 Sep'] }); st.tab = 'workspace'; }
            else { st.addedRows.push({ id, text, type: 'user', label: lbl, from: 'You told me, 20 Sep', expires: exp === 'never' ? 'none' : exp, state: 'active', by: 'You', backend: 'Postgres', history: ['v1, 20 Sep: added here'] }); st.tab = 'mine'; }
            st.empty = false; st.sel = id; st.query = ''; st.type = 'all'; st.stateF = 'all'; ctx.rerender(); ctx.toast('Saved as <b>' + esc(lbl) + '</b>. Audit entry written.', 'ok');
          });
          setTimeout(() => { const i = d.querySelector('[data-text]'); if (i) i.focus(); }, 30);
        } });
      }
      ctx.on('click', '[data-add]', openAdd);
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (st.openAdd) { st.openAdd = false; setTimeout(openAdd, 30); }
    }
  });
})();
