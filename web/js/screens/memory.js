(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const TABS = ['mine', 'workspace', 'agents'];
  const enc = encodeURIComponent;
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const short = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
  const DAY = 86400000;
  const EXPIRY = [{ value: '', label: 'never' }, { value: '30', label: 'in 30 days' }, { value: '90', label: 'in 90 days' }, { value: '365', label: 'in a year' }, { value: 'date', label: 'on a date…' }];

  const from = (m) => (m.origin === 'chat' ? 'Chat, ' + short(m.createdAt) : m.origin === 'extraction' ? 'Extraction, ' + short(m.createdAt) : m.scope === 'workspace' ? (m.author || 'a member') + ', ' + short(m.createdAt) : m.scope === 'agent' ? 'Agent, ' + short(m.createdAt) : 'You told me, ' + short(m.createdAt));
  const expires = (m) => (m.expiresAt ? day(m.expiresAt) : 'none');
  const by = (m) => (m.state === 'proposed' ? (m.origin === 'extraction' ? 'Post-turn extraction job' : (m.author || 'a member') + ', proposed') : m.acceptedBy ? (m.author && m.author !== m.acceptedBy ? m.author + ', accepted by ' + m.acceptedBy : 'You, accepted a proposal') : m.author || 'You');

  App.register({
    id: 'memory', title: 'Memory', live: true, summary: 'Own memories, workspace and agent memories, proposals, editor, forget everywhere',
    crumb: ['Memory'],
    commands: [{ label: 'Add a memory', sub: 'Memory', run(app) { app.stateFor('memory').openAdd = true; app.render(); } }],
    states: [
      { title: 'Forget', tone: 'danger', text: 'Confirmation states that the record, its embeddings and every cache entry are deleted in all backends, and that this cannot be undone.', apply(ctx) { ctx.state.tab = 'mine'; ctx.state.empty = false; ctx.state.forgetNow = true; ctx.rerender(); } },
      { title: 'Restricted disabled', tone: 'warn', text: 'Tenant policy does not allow restricted memories. A proposal at that level is refused with the reason.', apply(ctx) { ctx.state.tab = 'mine'; ctx.state.empty = false; ctx.state.refused = { text: null, reason: 'Tenant policy does not allow restricted memories. A memory or proposal at that level is refused and nothing is saved.' }; ctx.rerender(); } },
      { title: 'Workspace scope', tone: 'neutral', text: 'Curators see team conventions, glossary and contacts with the author of each entry.', apply(ctx) { ctx.state.tab = 'workspace'; ctx.state.empty = false; ctx.state.sel = null; ctx.rerender(); } },
      { title: 'Nothing remembered', tone: 'neutral', text: 'Empty state explains what memory is, that it is off until something is accepted, and how to add the first entry.', apply(ctx) { ctx.state.tab = 'mine'; ctx.state.empty = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      if (!st.loaded) st.paramHash = null;
      // The shell re-reads the hash on every render, so a link's parameters apply once per visit.
      if (ctx.params.tab && st.paramHash !== location.hash) { st.tab = ctx.params.tab; st.paramHash = location.hash; }
      st.tab = TABS.indexOf(st.tab) >= 0 ? st.tab : 'mine'; st.query = st.query || ''; st.type = st.type || 'all'; st.stateF = st.stateF || 'all';
      st.data = st.data || {};
      const later = () => { if (App.state.route !== 'memory') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      const load = (tab) => {
        if (st.loading === tab) return;
        st.loading = tab;
        App.get('/api/memory?tab=' + tab).then((d) => { st.data[tab] = d; st.loadError = null; }).catch((err) => { st.loadError = err; }).finally(() => { st.loading = null; later(); });
      };
      const refresh = () => { load(st.tab); };
      const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg, 'ok', 5000); refresh(); return r || true; } catch (err) { App.fail(err); return null; } };

      // Entering the screen clears `loaded`: refetch the open tab, keeping what is shown until it arrives.
      if (!st.loaded) { st.loaded = true; if (st.data[st.tab]) load(st.tab); }
      const data = st.data[st.tab];
      if (!data) {
        if (!st.loadError) load(st.tab);
        root.innerHTML = '<div class="page">' + UI.pagehead('Memory', 'Everything remembered about you. You can change or delete any of it.', '')
          + (st.loadError ? UI.problem('Memory could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }

      const curator = data.curator;
      const ws = data.workspace;
      const all = data.items;
      const rows = st.empty ? [] : all.filter((m) => (!st.query || (m.text + ' ' + from(m) + ' ' + (m.author || '') + ' ' + (m.ownerId || '')).toLowerCase().indexOf(st.query.toLowerCase()) >= 0) && (st.type === 'all' || m.type === st.type) && (st.stateF === 'all' || m.state === st.stateF));
      if (!rows.find((m) => m.id === st.sel)) st.sel = rows.length ? rows[0].id : null;
      const sel = rows.find((m) => m.id === st.sel);
      const types = ['all'].concat(all.map((m) => m.type).filter((t, i, a) => a.indexOf(t) === i));
      const states = ['all', 'active', 'proposed', 'superseded'];
      const proposed = all.filter((m) => m.state === 'proposed');
      const canDecide = (m) => m.state === 'proposed' && (m.scope === 'user' || curator);
      const canEdit = (m) => m.scope === 'user' || curator;
      const allowedLabels = LABELS.filter((l) => (data.policy.restricted || l !== 'restricted') && (!App.me || !App.me.user || LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance)));
      const statePill = (s) => (s === 'active' ? UI.pill(s, 'ok') : s === 'proposed' ? UI.pill(s, 'info') : UI.pill(s, ''));
      const backend = String(data.backend || 'database');

      const cols = st.tab === 'mine' ? ['Memory', 'Type', 'Label', 'Came from', 'Expires', 'State'] : st.tab === 'workspace' ? ['Memory', 'Type', 'Label', 'Author', 'Expires', 'State'] : ['Memory', 'Agent', 'Label', 'Written by', 'Expires', 'State'];
      const cells = (m) => (st.tab === 'mine' ? [esc(m.text), esc(m.type), UI.label(m.label, { sm: true }), esc(from(m)), esc(expires(m)), statePill(m.state)]
        : st.tab === 'workspace' ? [esc(m.text), esc(m.type), UI.label(m.label, { sm: true }), esc(m.author || ''), esc(expires(m)), statePill(m.state)]
          : [esc(m.text), esc(m.ownerId || ''), UI.label(m.label, { sm: true }), esc(from(m)), esc(expires(m)), statePill(m.state)]);

      const sourceLink = (m) => (m.source ? '<a href="#" data-goconvo="' + esc(m.source.conversationId) + '">' + esc(m.source.title || 'a conversation') + '</a>' : esc(from(m)));
      const scopeText = (m) => (m.scope === 'user' ? 'you, across conversations' : m.scope === 'workspace' ? esc(ws ? ws.name : 'the workspace') : esc(m.ownerId || 'the agent') + ', across runs');
      const inspector = sel ? '<div class="hstack"><div class="eyebrow grow">Selected memory</div>' + statePill(sel.state) + '</div><div style="font-size:15px;font-weight:600">' + esc(sel.text) + '</div>'
        + UI.kv([['Label', UI.label(sel.label, { sm: true }) + (canEdit(sel) && sel.state === 'active' ? ' ' + UI.btn('Relabel', { kind: 'ghost', size: 'xs', attrs: 'data-relabel' }) : '')], ['Source', sourceLink(sel)], ['Written by', esc(by(sel))], ['Expires', esc(sel.expiresAt ? day(sel.expiresAt) : 'never')], ['Backend', esc(sel.backend) + (sel.embedded ? ', with a vector' : '')], ['Scope', scopeText(sel)]], 1)
        + '<div class="eyebrow">History</div><div class="fg2 vstack gap4" style="font-size:12px">' + (sel.history || []).map((h) => '<span>v' + h.version + ', ' + esc(short(h.at)) + ': ' + esc(h.note) + (h.actor ? ' (' + esc(h.actor) + ')' : '') + '</span>').join('') + '</div>'
        + (sel.state === 'proposed' ? (canDecide(sel) ? '<div class="hstack gap6">' + UI.btn('Accept', { kind: 'primary', attrs: 'data-accept="' + esc(sel.id) + '"' }) + UI.btn('Reject', { attrs: 'data-reject="' + esc(sel.id) + '"' }) + '</div>' : '<div class="muted" style="font-size:12px">Waiting for a curator of ' + esc(ws ? ws.name : 'the workspace') + '.</div>')
          : canEdit(sel) ? '<div class="hstack wrap gap6">' + (sel.state === 'active' ? UI.btn('Edit', { attrs: 'data-edit' }) + UI.btn('Set expiry', { attrs: 'data-expiry' }) : '') + UI.btn('Forget', { kind: 'danger', attrs: 'data-forget' }) + '</div>' : '')
        + '<div class="muted" style="font-size:12px">Forget removes the record, its versions, its vector and export files that could hold it from ' + esc(backend) + '. Writes are audited.</div>'
        : '<div class="eyebrow">Selected memory</div>' + UI.empty('Nothing selected', st.empty || !all.length ? 'Memory is empty. Add an entry or accept a proposal to see it here.' : 'Select a row to see its label, source, history and actions.');

      const retention = st.tab === 'workspace' ? 'Curators edit any entry; members propose. Expired entries are purged hourly.' : st.tab === 'agents' ? 'Agents write within their limits; you can forget any entry.' : 'Your memories keep until you forget them or they expire. ' + (data.policy.restricted ? '' : 'Restricted memories are disabled by tenant policy.');
      const empty = st.empty || (!all.length && !st.query);
      const emptyHtml = st.tab === 'mine' ? UI.empty('Nothing remembered yet', 'Memory is labelled facts and summaries that outlive a conversation: your preferences, your current project, team conventions. It stays off until you accept a proposal in chat or add an entry here. Everything can be edited, relabelled or forgotten, and forgetting removes it from every backend.', UI.btn('Add a memory', { kind: 'primary', icon: 'plus', attrs: 'data-add' }) + (st.empty && all.length ? ' ' + UI.btn('Show my memories', { kind: 'ghost', attrs: 'data-unempty' }) : ''))
        : st.tab === 'workspace' ? (ws ? UI.empty('No workspace memories yet', 'Team conventions, glossary entries and contacts for ' + esc(ws.name) + ' appear here. Members propose; curators accept.', UI.btn('Add a memory', { kind: 'primary', icon: 'plus', attrs: 'data-add' })) : UI.empty('No workspace selected', 'Switch to a workspace from the header to see its memories.'))
          : UI.empty('No agent memories yet', 'Agents write progress state and known tool quirks here within their limits. Agent runs arrive with the registry and runs.');

      root.innerHTML = '<style>.mem-page > *{flex-shrink:0}</style>'
        + '<div class="page mem-page">'
        + UI.pagehead('Memory', st.tab === 'mine' ? 'Everything remembered about you. You can change or delete any of it.' : st.tab === 'workspace' ? 'Team conventions, glossary and contacts' + (ws ? ' for ' + esc(ws.name) : '') + ', with the author of each entry.' : 'What agents remember across runs: progress state and known tool quirks.',
          (st.tab === 'mine' || curator ? UI.btn(st.tab === 'mine' ? 'Export mine' : 'Export', { icon: 'download', attrs: 'data-export' + (all.length ? '' : ' disabled') }) : '') + (st.tab === 'agents' ? '' : UI.btn('Add a memory', { kind: 'primary', icon: 'plus', attrs: 'data-add' })))
        + UI.tabs([{ id: 'mine', label: 'Mine', count: data.counts.mine }, { id: 'workspace', label: 'Workspace', count: data.counts.workspace }, { id: 'agents', label: 'Agents', count: data.counts.agents }], st.tab)
        + (st.refused ? UI.notice('<b>' + (st.refused.text ? 'Refused.</b> "' + esc(st.refused.text) + '": ' : 'Restricted disabled.</b> ') + esc(st.refused.reason), 'warn', (App.canOpen('guardrails') ? '<a href="#" data-goguard>Rules</a> ' : '') + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-dismissrefused' })) : '')
        + (st.exp ? UI.notice(st.exp.state === 'ready' ? 'Export <span class="mono">' + esc(st.exp.file) + '</span> is ready: ' + st.exp.rows + ' entries, labelled ' + esc(st.exp.label || 'internal') + '.' : st.exp.state === 'failed' ? 'The export failed. Try again.' : 'Export of <span class="mono">' + esc(st.exp.file) + '</span> is running.', st.exp.state === 'failed' ? 'danger' : st.exp.state === 'ready' ? 'ok' : 'info', (st.exp.state === 'ready' ? UI.btn('Download', { size: 'sm', icon: 'download', attrs: 'data-download' }) : '') + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-dismissexp' })) : '')
        + (proposed.length && !st.empty ? UI.notice(proposed.length + ' proposed ' + (proposed.length > 1 ? 'memories are' : 'memory is') + ' waiting for ' + (st.tab === 'workspace' ? 'a curator' : 'you') + '. Nothing is saved until ' + (st.tab === 'workspace' ? 'it is accepted' : 'you accept it') + '.', 'info', canDecide(proposed[0]) ? UI.btn('Review', { size: 'sm', attrs: 'data-review' }) : '') : '')
        + (empty ? emptyHtml
          : '<div class="toolbar mem-filters">' + UI.search('Search memories', 'data-search', st.query).replace('class="search"', 'class="search" style="width:320px"') + '<span class="relative">' + UI.btn('Type: ' + st.type, { icon: 'chevd', attrs: 'data-pick="type"' }) + '</span><span class="relative">' + UI.btn('State: ' + st.stateF, { icon: 'chevd', attrs: 'data-pick="state"' }) + '</span><span class="muted right" style="font-size:12px">' + esc(retention) + '</span></div>'
          + UI.table(cols, rows.map((m) => ({ cells: cells(m), attrs: 'data-id="' + esc(m.id) + '"', selected: m.id === st.sel })), { minWidth: '0', emptyTitle: 'No memories match', emptyText: 'Try another word or clear the filters.' }))
        + '<div style="margin-top:6px"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div>'
        + '<aside class="inspector">' + inspector + '</aside>';

      // ---- events ----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; st.type = 'all'; st.stateF = 'all'; st.sel = null; st.empty = false; if (st.data[st.tab]) refresh(); ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', 'tr[data-id]', (e, t) => { st.sel = t.dataset.id; ctx.rerender(); });
      ctx.on('click', '[data-unempty]', () => { st.empty = false; ctx.rerender(); });
      ctx.on('click', '[data-dismissrefused]', () => { st.refused = null; ctx.rerender(); });
      ctx.on('click', '[data-dismissexp]', () => { st.exp = null; ctx.rerender(); });
      ctx.on('click', '[data-goguard]', (e) => { e.preventDefault(); ctx.navigate('guardrails'); });
      ctx.on('click', '[data-goconvo]', (e, t) => { e.preventDefault(); ctx.navigate('chat', { convo: t.dataset.goconvo }); });
      ctx.on('click', '[data-pick]', (e, t) => {
        const host = t.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
        const d = document.createElement('div'); d.className = 'dropdown';
        const isType = t.dataset.pick === 'type'; const opts = isType ? types : states; const cur = isType ? st.type : st.stateF;
        d.innerHTML = '<div class="dh">' + (isType ? 'Memory type' : 'State') + '</div>' + opts.map((o) => '<button type="button" data-opt="' + esc(o) + '" class="' + (o === cur ? 'on' : '') + '">' + esc(o) + '</button>').join('');
        host.appendChild(d);
        d.addEventListener('click', (ev) => { const b = ev.target.closest('[data-opt]'); if (!b) return; if (isType) st.type = b.dataset.opt; else st.stateF = b.dataset.opt; d.remove(); ctx.rerender(); });
      });

      const refusal = (err, text) => { const p = err.problem || {}; if (err.status === 422 || err.status === 403) { st.refused = { text, reason: err.message || p.title }; ctx.rerender(); } App.fail(err, p.title || 'Refused'); };
      const accept = (id) => { const m = all.find((x) => x.id === id); act(() => App.post('/api/memory/' + enc(id) + '/accept'), 'Saved as <b>' + esc(m ? m.label : '') + '</b>. It enters prompts as a labelled memory block.').then((r) => { if (r) st.sel = id; }); };
      const reject = (id) => act(() => App.post('/api/memory/' + enc(id) + '/reject'), 'Proposal rejected. Nothing was saved, and the same text is not proposed again.');
      ctx.on('click', '[data-review]', () => {
        const p = proposed[0]; if (!p) return;
        ctx.modal({ title: 'Proposed memory', body: '<div class="serif" style="font-size:16px">"' + esc(p.text) + '"</div>' + UI.kv([['Proposed by', esc(by(p))], ['From', sourceLink(p)], ['Label', UI.label(p.label, { sm: true }) + ' <span class="muted">high-water mark of its sources</span>'], ['Checkpoint', UI.pill('passed', 'ok') + ' <span class="muted">PII rules, label check, no credentials</span>'], ['Expires', esc(p.expiresAt ? day(p.expiresAt) : 'never')], ['Backend', esc(p.backend)]], 2) + UI.notice('Nothing is saved until you accept. Rejecting discards the proposal and tells the extraction job not to propose it again.', 'info'),
          actions: UI.btn('Reject', { attrs: 'data-rej' }) + UI.btn('Accept', { kind: 'primary', attrs: 'data-acc' }), onMount(m) { m.querySelector('[data-acc]').addEventListener('click', () => { App.closeOverlay(); accept(p.id); }); m.querySelector('[data-rej]').addEventListener('click', () => { App.closeOverlay(); reject(p.id); }); } });
      });
      ctx.on('click', '[data-accept]', (e, t) => accept(t.dataset.accept));
      ctx.on('click', '[data-reject]', (e, t) => reject(t.dataset.reject));

      const expiryField = (val) => UI.field('Expires', UI.select(EXPIRY, val ? 'date' : '', 'data-expsel') + '<input type="date" class="input" data-expdate style="margin-top:6px" ' + (val ? 'value="' + new Date(val).toISOString().slice(0, 10) + '"' : 'hidden') + '>', 'Expired memories leave retrieval at once and are purged from every backend within the hour.');
      const wireExpiry = (el) => { const s = el.querySelector('[data-expsel]'); const dt = el.querySelector('[data-expdate]'); s.addEventListener('change', () => { dt.hidden = s.value !== 'date'; }); };
      /** The chosen expiry as epoch ms, null for never; throws on a missing or past date. */
      const expiryOf = (el) => {
        const v = el.querySelector('[data-expsel]').value;
        if (!v) return null;
        if (v !== 'date') return Date.now() + Number(v) * DAY;
        const d = el.querySelector('[data-expdate]').value; if (!d) throw new Error('Pick a date.');
        const t = new Date(d + 'T23:59:59').getTime(); if (t <= Date.now()) throw new Error('The expiry is in the past.');
        return t;
      };
      ctx.on('click', '[data-edit]', () => {
        if (!sel) return;
        ctx.drawer({ title: 'Edit memory', body: UI.field('Memory', UI.textarea(sel.text, { rows: 3, attrs: 'data-text' }), 'Saving creates a new version. The old text stays in the history.') + UI.field('Label', UI.select(allowedLabels, sel.label, 'data-lbl'), data.policy.restricted ? 'Not below the label of its source.' : 'Restricted is disabled by tenant policy.') + expiryField(sel.expiresAt) + UI.notice('The memory checkpoint runs again on save: PII rules, label check and a ban on credentials.', 'info') + '<div data-err></div>',
          actions: UI.btn('Save', { kind: 'primary', attrs: 'data-go' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }), onMount(d) {
            wireExpiry(d);
            d.querySelector('[data-go]').addEventListener('click', async () => {
              const text = d.querySelector('[data-text]').value.trim(); if (!text) { toast('A memory needs some text.'); return; }
              let expiresAt; try { expiresAt = expiryOf(d); } catch (e2) { toast(esc(e2.message)); return; }
              try { const r = await App.patch('/api/memory/' + enc(sel.id), { text, label: d.querySelector('[data-lbl]').value, expiresAt }); App.closeOverlay(); toast('Saved as v' + r.version + '. The previous version stays in the history.', 'ok'); refresh(); }
              catch (err) { const p = err.problem || {}; d.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(err.message), 'danger'); }
            });
          } });
      });
      ctx.on('click', '[data-relabel]', () => {
        if (!sel) return;
        ctx.modal({ title: 'Relabel memory', body: '<div class="fg2">"' + esc(sel.text) + '"</div>' + UI.field('Label', UI.select(allowedLabels, sel.label, 'data-lbl'), 'A memory cannot go below the high-water mark of its sources' + (sel.sourceLabel ? ' (' + esc(sel.sourceLabel) + ')' : '') + '.') + '<div data-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Relabel', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            const l = m.querySelector('[data-lbl]').value;
            try { await App.patch('/api/memory/' + enc(sel.id), { label: l }); App.closeOverlay(); toast('Relabelled <b>' + esc(l) + '</b>. Audit entry written.', 'ok'); refresh(); }
            catch (err) { const p = err.problem || {}; m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(err.message), 'danger'); }
          });
        } });
      });
      ctx.on('click', '[data-expiry]', () => {
        if (!sel) return;
        ctx.modal({ title: 'Set expiry', body: '<div class="fg2">"' + esc(sel.text) + '"</div>' + expiryField(sel.expiresAt), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
          wireExpiry(m);
          m.querySelector('[data-go]').addEventListener('click', () => { let v; try { v = expiryOf(m); } catch (e2) { toast(esc(e2.message)); return; } App.closeOverlay(); act(() => App.patch('/api/memory/' + enc(sel.id), { expiresAt: v }), v ? 'Expires ' + esc(day(v)) + '.' : 'Set to never expire.'); });
        } });
      });
      const forget = async () => {
        if (!sel) return;
        const n = (sel.history || []).length || 1;
        const ok = await ctx.confirm({ title: 'Forget this memory', tag: 'cannot be undone', tone: 'danger', ok: 'Forget everywhere', body: '<div class="fg2">"' + esc(sel.text) + '"</div><div class="fg2">This deletes the record, its embeddings and every export file that could hold it in all backends. Conversations that already used it are unchanged; future prompts will not see it. This cannot be undone.</div>', kv: [['Record and history', esc(backend) + ', ' + n + ' version' + (n > 1 ? 's' : '')], ['Embeddings', sel.embedded ? 'one vector' : 'none stored'], ['Export files', 'any of yours that could include it'], ['Audit', 'a forget entry is written']] });
        if (!ok) return;
        try { const r = await App.del('/api/memory/' + enc(sel.id)); toast('Forgotten: ' + r.versions + ' version' + (r.versions === 1 ? '' : 's') + ', ' + r.vectors + ' vector' + (r.vectors === 1 ? '' : 's') + ', ' + r.exports + ' export file' + (r.exports === 1 ? '' : 's') + ' deleted. Audit entry written.', 'ok', 6000); st.sel = null; refresh(); }
        catch (err) { App.fail(err); }
      };
      ctx.on('click', '[data-forget]', forget);
      const pollExport = () => {
        if (!st.exp || st.exp.state === 'ready' || st.exp.state === 'failed') return;
        App.get('/api/memory/exports/' + enc(st.exp.id)).then((x) => { st.exp = Object.assign(st.exp, x); later(); if (x.state !== 'ready' && x.state !== 'failed') setTimeout(pollExport, 1500); }).catch((err) => { App.fail(err); st.exp = null; later(); });
      };
      ctx.on('click', '[data-export]', async () => {
        const conf = all.filter((m) => m.label === 'confidential' || m.label === 'restricted').length;
        const tab = st.tab;
        ctx.modal({ title: 'Export ' + (tab === 'mine' ? 'my memories' : tab + ' memories'), body: (conf ? UI.notice('The export includes ' + conf + ' confidential ' + (conf > 1 ? 'entries' : 'entry') + '. The file carries the highest label in it and the export is logged to audit.', 'warn') : '') + UI.field('Format', UI.select([{ value: 'json', label: 'JSON with labels and provenance' }, { value: 'csv', label: 'CSV' }], 'json', 'data-fmt')) + UI.kv([['Entries', String(all.length)], ['Includes', 'text, label, source, author, expiry, versions']], 2),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Export', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
            m.querySelector('[data-go]').addEventListener('click', async () => { const format = m.querySelector('[data-fmt]').value; App.closeOverlay(); try { const r = await App.post('/api/memory/exports', { tab, format }); st.exp = { id: r.id, file: r.file, state: 'queued' }; toast('Export of ' + all.length + ' memories queued. A download appears here when it is ready.', 'ok'); ctx.rerender(); setTimeout(pollExport, 800); } catch (err) { App.fail(err); } });
          } });
      });
      ctx.on('click', '[data-download]', async () => {
        const x = st.exp; if (!x) return;
        try {
          const res = await fetch('/api/memory/exports/' + enc(x.id) + '/download', { credentials: 'same-origin' });
          if (!res.ok) { let p = null; try { p = await res.json(); } catch (e2) { /* not JSON */ } throw new App.ApiError(p || { status: res.status, title: res.statusText }); }
          const url = URL.createObjectURL(await res.blob());
          const a = document.createElement('a'); a.href = url; a.download = x.file; a.style.display = 'none';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          toast('Downloaded ' + esc(x.file) + '. The download is written to the audit chain.', 'ok');
        } catch (err) { App.fail(err, 'Download failed'); }
      });
      function openAdd() {
        const wsOk = !!ws;
        const scopes = [{ value: 'user', label: 'Me' }].concat(wsOk ? [{ value: 'workspace', label: 'Workspace: ' + ws.name + (curator ? '' : ' (proposal)') }] : []);
        const typesFor = (s) => (s === 'workspace' ? data.policy.types.workspace : data.policy.types.mine);
        const opt = (list) => list.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('');
        const scope0 = st.tab === 'workspace' && wsOk ? 'workspace' : 'user';
        ctx.drawer({ title: 'Add a memory', body: UI.field('What should be remembered?', UI.textarea('', { rows: 3, placeholder: 'Reports in thousands of EUR unless asked otherwise', attrs: 'data-text' })) + UI.field('Scope', UI.select(scopes, scope0, 'data-scope'), wsOk ? (curator ? '' : 'A workspace entry from a member is a proposal until a curator accepts it.') : 'Switch to a workspace to add a workspace memory.') + UI.field('Type', '<select class="select" data-type>' + opt(typesFor(scope0)) + '</select>') + UI.field('Label', UI.select(LABELS.filter((l) => !App.me || !App.me.user || LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance)), 'internal', 'data-lbl'), data.policy.restricted ? '' : 'Restricted is disabled by tenant policy; a memory at that level is refused.') + expiryField(null) + UI.notice('The memory checkpoint runs before saving: PII rules, label check and a ban on storing credentials.', 'info') + '<div data-err></div>',
          actions: UI.btn('Save', { kind: 'primary', attrs: 'data-go' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }), onMount(d) {
            wireExpiry(d);
            d.querySelector('[data-scope]').addEventListener('change', (e) => { d.querySelector('[data-type]').innerHTML = opt(typesFor(e.target.value)); });
            d.querySelector('[data-go]').addEventListener('click', async () => {
              const text = d.querySelector('[data-text]').value.trim(); if (!text) { toast('Write what should be remembered.'); return; }
              let expiresAt; try { expiresAt = expiryOf(d); } catch (e2) { toast(esc(e2.message)); return; }
              const scope = d.querySelector('[data-scope]').value; const lbl = d.querySelector('[data-lbl]').value;
              try {
                const r = await App.post('/api/memory', { text, scope, type: d.querySelector('[data-type]').value, label: lbl, expiresAt });
                App.closeOverlay(); st.tab = scope === 'workspace' ? 'workspace' : 'mine'; st.empty = false; st.sel = r.id; st.query = ''; st.type = 'all'; st.stateF = 'all'; st.refused = null;
                toast(r.state === 'proposed' ? 'Proposed to the curators of ' + esc(ws ? ws.name : 'the workspace') + '. Nothing is saved until one accepts it.' : 'Saved as <b>' + esc(r.label) + '</b>. Audit entry written.', 'ok');
                if (st.data[st.tab]) refresh(); else ctx.rerender();
              } catch (err) {
                const p = err.problem || {};
                if (err.status === 422 || err.status === 403) { App.closeOverlay(); refusal(err, text); return; }
                d.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(p.title || 'Not saved') + '.</b> ' + esc(err.message), 'danger');
              }
            });
            setTimeout(() => { const i = d.querySelector('[data-text]'); if (i) i.focus(); }, 30);
          } });
      }
      ctx.on('click', '[data-add]', openAdd);
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (st.openAdd) { st.openAdd = false; setTimeout(openAdd, 30); }
      if (st.forgetNow) { st.forgetNow = false; if (sel && canEdit(sel) && sel.state !== 'proposed') setTimeout(forget, 40); else toast('Add or accept a memory first; forgetting it then shows this confirmation.'); }
    }
  });
})();
