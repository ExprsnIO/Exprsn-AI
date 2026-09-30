(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l);
  const STATUSES = ['draft', 'in_review', 'published', 'deprecated', 'retired'];
  const statusText = (s) => String(s || '').replace('_', ' ');
  const SIDE = { read: 'read-only', write: 'write', destructive: 'destructive' };
  const IMPL = { builtin: 'Built-in', mcp: 'MCP server tool', script: 'Script-backed', archive: 'Versioned archive', agent: 'Agent definition', workflow: 'Workflow' };
  const sidePill = (s) => UI.pill(SIDE[s] || s || 'not applicable', s === 'read' ? 'ok' : s === 'write' ? 'warn' : s === 'destructive' ? 'danger' : 'outline');
  const statusPill = (s) => UI.pill(statusText(s), s === 'published' ? 'ok' : s === 'in_review' ? 'info' : s === 'deprecated' ? 'warn' : s === 'retired' ? 'danger' : '');
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const ago = (ms) => { if (!ms) return ''; const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'; };
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const pretty = (v) => JSON.stringify(v, null, 2);

  /** Sample arguments from an input schema: each property's example, default or an empty value of its type. */
  function sampleArgs(schema) {
    const out = {};
    const props = (schema && schema.properties) || {};
    Object.keys(props).forEach((k) => {
      const p = props[k] || {};
      out[k] = p.default !== undefined ? p.default : p.examples && p.examples.length ? p.examples[0] : p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {} : k === 'expression' ? '(1250 * 1.07) / 12' : '';
    });
    return out;
  }

  App.register({
    id: 'registry', title: 'Registry', live: true, section: 'admin', crumb: ['Admin', 'Registry'],
    summary: 'Tools, skills and agents; automated checks; review queue; publish scope; test harness',
    commands: [
      { label: 'Submit a registry entry', sub: 'Registry', run(app) { app.stateFor('registry').openSubmit = true; app.render(); } },
      { label: 'Open the review queue', sub: 'Registry', run(app) { app.stateFor('registry').tab = 'review'; app.render(); } }
    ],
    states: [
      { title: 'Failing check', tone: 'danger', text: 'Approve stays disabled until every automated check passes: schema, required fields, description, side effect and the secrets scan.', apply(ctx) { ctx.state.demo = 'failing'; ctx.rerender(); } },
      { title: 'Publish scope', tone: 'neutral', text: 'Publishing asks whether the whole tenant or named workspaces receive the entry. Workspaces below the entry\'s max label cannot be chosen.', apply(ctx) { ctx.state.demo = 'scope'; ctx.rerender(); } },
      { title: 'Deprecated', tone: 'warn', text: 'Deprecated tools stay callable with a warning in run details and a replacement link.', apply(ctx) { ctx.state.demo = 'deprecated'; ctx.rerender(); } },
      { title: 'Test harness', tone: 'info', text: 'Runs the tool once with sample arguments and shows the typed result and label.', apply(ctx) { ctx.state.demo = 'harness'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      st.tab = st.tab || 'tools'; st.query = st.query || ''; st.filter = st.filter || 'all'; st.details = st.details || {};
      const later = () => { if (App.state.route !== 'registry') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        App.get('/api/admin/registry')
          .then((list) => { st.list = list; st.loaded = true; st.loadError = null; st.details = {}; })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; later(); });
      };
      if (!st.loaded && !st.loadError) load();
      const act = async (fn, okMsg, kind) => {
        try { const r = await fn(); st.problem = null; if (okMsg) toast(okMsg, kind || 'ok', 5000); st.loaded = false; load(); return r || true; }
        catch (err) { const pr = err.problem || {}; if (err.status >= 400 && err.status < 500) st.problem = { title: pr.title || 'Refused', detail: err.message, trace: pr.trace_id }; App.fail(err); ctx.rerender(); return null; }
      };
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Registry', 'Nothing reaches a tenant before review', '')
          + (st.loadError ? UI.problem('The registry could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }

      const list = st.list;
      const me = App.me && App.me.user ? App.me.user : {};
      if (ctx.params.entry) { const want = ctx.params.entry; const hit = list.find((e) => e.id === want || e.name === want); if (hit) { st.sel = hit.id; st.tab = hit.kind === 'tool' ? 'tools' : hit.kind + 's'; } delete ctx.params.entry; }
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }

      // ---- demo states staged from live data ----
      if (st.demo) {
        const d = st.demo; st.demo = null; st.demoNote = null;
        if (d === 'failing') {
          const e = list.find((x) => x.status === 'in_review' && !x.checksPassed) || list.find((x) => !x.checksPassed && !x.platform);
          if (e) { st.sel = e.id; st.tab = e.status === 'in_review' ? 'review' : e.kind === 'tool' ? 'tools' : e.kind + 's'; } else st.demoNote = 'Every entry passes its checks, so Approve is enabled wherever an entry waits for review.';
        } else if (d === 'scope') {
          const e = list.find((x) => (x.status === 'published' || x.status === 'in_review') && !x.platform);
          if (e) { st.sel = e.id; st.openScope = e.id; } else st.demoNote = 'No tenant entry is published or in review yet, so there is no scope to choose.';
        } else if (d === 'deprecated') {
          const e = list.find((x) => x.status === 'deprecated');
          if (e) { st.sel = e.id; st.tab = e.kind === 'tool' ? 'tools' : e.kind + 's'; } else st.demoNote = 'No entry is deprecated. Deprecate a published entry from its inspector to see the warning.';
        } else if (d === 'harness') {
          const e = list.find((x) => x.name === 'calculate' && x.platform) || list.find((x) => x.kind === 'tool');
          if (e) { st.sel = e.id; st.tab = 'tools'; st.harnessOpen = true; st.harnessRun = true; }
        }
      }

      const q = st.query.toLowerCase();
      const match = (e) => (!q || (e.name + ' ' + (e.owner || '') + ' ' + (SIDE[e.sideEffect] || '') + ' ' + ((e.definition && e.definition.tools) || []).join(' ')).toLowerCase().indexOf(q) >= 0) && (st.filter === 'all' || e.status === st.filter);
      const ofKind = (k) => list.filter((e) => e.kind === k);
      const review = list.filter((e) => e.status === 'in_review');
      const shown = st.tab === 'review' ? review.filter(match) : ofKind(st.tab === 'tools' ? 'tool' : st.tab === 'skills' ? 'skill' : 'agent').filter(match);
      if (!list.find((e) => e.id === st.sel)) st.sel = (shown[0] || list[0] || {}).id;
      const sel = list.find((e) => e.id === st.sel);
      const detail = sel ? st.details[sel.id] : null;
      if (sel && !detail && !st.fetching) {
        st.fetching = sel.id;
        App.get('/api/admin/registry/' + sel.id).then((d) => { st.details[sel.id] = d; }).catch(() => { st.details[sel.id] = { versions: [], referencedBy: [], profiles: [], workspaces: [] }; }).finally(() => { st.fetching = null; later(); });
      }
      const rowAttrs = (e) => 'data-entry="' + esc(e.id) + '"';
      const canManage = (e) => App.can(e.kind === 'agent' ? 'agents:manage' : 'tools:manage') && !e.platform;
      const tools = (e) => ((e.definition && e.definition.tools) || []);

      let table;
      const opts = (what) => ({ emptyTitle: 'No ' + what + ' match', emptyText: 'Clear the search or the status filter.' });
      if (st.tab === 'tools') table = UI.table(['Tool', 'Side effect', 'Version', 'Max label', 'Implemented as', 'Status'], shown.map((e) => ({ cells: ['<span style="font-weight:600">' + esc(e.name) + '</span>', sidePill(e.sideEffect), '<span class="mono">' + esc(e.version) + '</span>', UI.label(e.label, { sm: true }), esc(IMPL[e.impl] || e.impl), statusPill(e.status)], attrs: rowAttrs(e), selected: sel && e.id === sel.id })), opts('tools'));
      else if (st.tab === 'skills') table = UI.table(['Skill', 'Contents', 'Version', 'Max label', 'Tools', 'Status'], shown.map((e) => ({ cells: ['<span style="font-weight:600">' + esc(e.name) + '</span>', esc('Instructions, ' + fmt(String((e.definition && e.definition.instructions) || '').length) + ' characters'), '<span class="mono">' + esc(e.version) + '</span>', UI.label(e.label, { sm: true }), '<span class="mono">' + esc(tools(e).join(', ') || 'none') + '</span>', statusPill(e.status)], attrs: rowAttrs(e), selected: sel && e.id === sel.id })), opts('skills'));
      else if (st.tab === 'agents') table = UI.table(['Agent', 'Profile', 'Tools', 'Version', 'Max label', 'Status'], shown.map((e) => ({ cells: ['<span style="font-weight:600">' + esc(e.name) + '</span>', esc((e.definition && e.definition.profile) || ''), '<span class="mono" style="white-space:normal">' + esc(tools(e).join(', ') || 'none') + '</span>', '<span class="mono">' + esc(e.version) + '</span>', UI.label(e.label, { sm: true }), statusPill(e.status)], attrs: rowAttrs(e), selected: sel && e.id === sel.id })), opts('agents'));
      else table = UI.table(['Entry', 'Kind', 'Submitted', 'Automated checks', 'Waiting', 'Status'], shown.map((e) => { const bad = e.checks.filter((c) => !c.ok).length; return { cells: ['<span style="font-weight:600">' + esc(e.name) + '</span> <span class="mono muted">' + esc(e.version) + '</span>', esc(e.kind), esc(when(e.submittedAt) + ', ' + (e.owner || '')), bad ? UI.pill(bad + ' failing', 'danger') : UI.pill('all passed', 'ok'), esc(ago(e.submittedAt)), statusPill(e.status)], attrs: rowAttrs(e), selected: sel && e.id === sel.id }; }), { emptyTitle: 'The review queue is empty', emptyText: 'Submitted entries appear here with their automated checks.' });

      const agentShown = sel && sel.kind === 'agent' && st.tab !== 'review' ? sel : null;
      const agentCard = (a) => { const d = a.definition || {}; const b = d.budgets || {}; return UI.panel('Agent: ' + esc(a.name), UI.kv([['Profile', '<a href="#" data-goprofile="' + esc(d.profile || '') + '">' + esc(d.profile || '') + '</a>'], ['Tools', esc(tools(a).join(', ') || 'none')], ['Skills', esc((d.skills || []).join(', ') || 'none')], ['System prompt', esc(d.systemPrompt ? d.systemPrompt.slice(0, 160) + (d.systemPrompt.length > 160 ? '…' : '') : 'none')], ['Limits', esc(b.steps + ' steps, ' + fmt(b.tokens || 0) + ' tokens, ' + b.wallSeconds + ' s, ' + b.toolCalls + ' tool calls')]], 3), { actions: (App.can('agents:run') && (a.status === 'published' || a.status === 'deprecated') ? UI.btn('Run in Runs', { size: 'sm', attrs: 'data-goruns="' + esc(a.name) + '"' }) : '') + UI.btn('Profile', { size: 'sm', kind: 'ghost', attrs: 'data-goprofile="' + esc(d.profile || '') + '"' }) }); };

      // ---- inspector ----
      let inspector = '<aside class="inspector w360 registry-insp">';
      if (!sel) inspector += UI.empty('Nothing selected', 'Pick an entry to see its checks and actions.');
      else {
        const h = st.harness && st.harness.id === sel.id ? st.harness : null;
        const mine = sel.ownerId && sel.ownerId === me.id;
        const d = detail || {};
        inspector += '<div class="mono" style="font-size:14px">' + esc(sel.name) + '</div>'
          + '<div class="hstack wrap gap6">' + (sel.kind === 'tool' ? sidePill(sel.sideEffect) : UI.pill(sel.kind, 'outline')) + statusPill(sel.status) + UI.label(sel.label, { sm: true }) + (sel.platform ? UI.pill('platform', 'outline') : '') + '</div>'
          + (sel.status === 'deprecated' ? UI.notice('<b>Deprecated.</b> Still callable; every run that uses it shows a warning in run details.' + (sel.replacement ? ' Replacement: <a href="#" data-replacement="' + esc(sel.replacement) + '">' + esc(sel.replacement) + '</a>' : ''), 'warn', canManage(sel) ? UI.btn('Retire', { size: 'sm', attrs: 'data-retire' }) : '') : '')
          + (sel.status === 'retired' ? UI.notice('<b>Retired.</b> Removed from routing; the entry stays resolvable for audit.', 'danger') : '')
          + (sel.reviewNote && sel.status === 'draft' ? UI.notice('<b>Returned by the reviewer.</b> ' + esc(sel.reviewNote), 'warn') : '')
          + (st.problem ? UI.problem(st.problem.title, st.problem.detail, st.problem.trace) : '')
          + UI.kv([
            ['Owner', esc(sel.owner || '')],
            ['Version', '<span class="mono">' + esc(sel.version) + '</span> <span class="muted">' + esc(statusText(sel.status)) + '</span>' + (d.versions && d.versions.length > 1 ? ' <span class="muted">(' + d.versions.length + ' versions)</span>' : '')],
            ['Schema hash', '<span class="mono">' + esc(String(sel.schemaHash).slice(0, 8)) + '</span> ' + UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copyhash="' + esc(sel.schemaHash) + '"' }) + (sel.approvedHash && sel.approvedHash !== sel.schemaHash ? ' <span style="color:var(--danger-fg)">differs from approved</span>' : '')],
            ['Implemented as', esc(IMPL[sel.impl] || sel.impl) + (sel.impl === 'script' && sel.definition ? ' <span class="muted">' + esc(sel.definition.scriptName || '') + ' v' + esc(sel.definition.version) + '</span>' : '') + (sel.impl === 'workflow' && sel.definition ? ' <a href="#" data-goworkflow="' + esc(sel.definition.workflowId) + '">' + esc(sel.definition.workflowName || 'workflow') + ' v' + esc(sel.definition.version) + '</a>' : '')],
            ['Ceiling label', UI.label(sel.label, { sm: true })],
            ['Confirmation required', sel.kind === 'tool' ? esc(sel.confirm) + (sel.sideEffect && sel.sideEffect !== 'read' ? ' <span class="muted">(' + esc(SIDE[sel.sideEffect]) + ' class)</span>' : '') : 'not applicable'],
            ['Rate limit', sel.ratePerHour ? esc(sel.ratePerHour + ' per user per hour') : 'none'],
            ['Publish scope', sel.publishScope === 'workspace' ? esc((d.workspaces || []).map((w) => w.name).join(', ') || sel.publishWorkspaces.length + ' workspaces') : esc(sel.publishScope || 'not published')],
            ['Reviewed by', sel.reviewedBy ? esc(sel.reviewedBy + ', ' + when(sel.reviewedAt)) : 'not yet'],
            ['Used by', esc(((d.profiles || []).map((p) => 'profile ' + p).concat((d.referencedBy || []).map((r) => r.kind + ' ' + r.name + ' ' + r.version))).join(', ') || 'nothing yet')]
          ], 1)
          + '<div class="hstack"><div class="eyebrow grow">Automated checks</div>' + (canManage(sel) ? UI.btn('Re-run', { kind: 'ghost', size: 'xs', icon: 'refresh', attrs: 'data-recheck' }) : '') + '</div>'
          + '<div class="vstack gap4">' + sel.checks.map((c) => '<div class="hstack" style="align-items:flex-start;color:var(--' + (c.ok ? 'ok-fg' : 'danger-fg') + ')">' + UI.icon(c.ok ? 'check' : 'x', 14) + '<span style="color:var(--fg)"><b style="font-weight:600">' + esc(c.name) + '</b><span class="fg2" style="display:block;font-size:12px">' + esc(c.detail) + '</span></span></div>').join('') + (sel.checkedAt ? '<div class="muted" style="font-size:12px">Checked ' + esc(when(sel.checkedAt)) + '</div>' : '') + '</div>'
          + '<div class="hstack wrap">'
          + (!canManage(sel) ? '' : sel.status === 'in_review' ? UI.btn('Reject', { attrs: 'data-reject', disabled: mine, title: mine ? 'Someone other than the author reviews' : '' }) + UI.btn('Approve', { kind: 'primary', attrs: 'data-approve', disabled: !sel.checksPassed || mine, title: mine ? 'Someone other than the author reviews' : sel.checksPassed ? '' : 'Approve stays disabled until the checks pass' })
            : sel.status === 'draft' ? (sel.impl !== 'mcp' && sel.impl !== 'script' && sel.impl !== 'workflow' ? UI.btn('Edit', { attrs: 'data-editentry' }) : '') + UI.btn('Submit for review', { kind: 'primary', attrs: 'data-submitreview' })
              : sel.status === 'published' ? UI.btn('Deprecate', { attrs: 'data-deprecate' }) + UI.btn('Publish to more', { kind: 'primary', attrs: 'data-publishmore' })
                : sel.status === 'deprecated' ? UI.btn('Retire', { kind: 'danger', attrs: 'data-retire' }) + UI.btn('Restore', { attrs: 'data-restore' }) : '')
          + (sel.kind !== 'skill' && sel.status !== 'retired' ? UI.btn('Test harness', { kind: 'ghost', icon: 'play', attrs: 'data-harness-open' }) : '')
          + (canManage(sel) && sel.impl !== 'mcp' && sel.status !== 'draft' && sel.status !== 'in_review' ? UI.btn('New version', { kind: 'ghost', attrs: 'data-newversion' }) : '')
          + '</div>';
        if (st.harnessOpen && sel.kind !== 'skill') {
          const args = st.harnessArgs && st.harnessArgs.id === sel.id ? st.harnessArgs.text : pretty(sampleArgs(sel.inputSchema));
          inspector += '<div class="divider"></div><div class="hstack"><div class="eyebrow grow">Test harness</div>' + UI.iconbtn('x', 'Close harness', { cls: 'sm ghost', attrs: 'data-harness-close' }) + '</div>'
            + (sel.kind === 'agent' ? UI.field('Input for a test run', UI.textarea(st.harnessInput || 'Describe what you can do in two sentences.', { rows: 2, attrs: 'data-hinput' })) : UI.field('Sample arguments', UI.textarea(args, { rows: 4, attrs: 'data-args' }), sel.impl === 'mcp' && sel.sideEffect !== 'read' ? 'Write and destructive MCP tools are not run against live systems here.' : ''))
            + (h && h.phase === 'running' ? UI.meter('Running through the dispatcher', '…', 60, 'accent') : '')
            + (h && h.phase === 'done' ? UI.kv([['Outcome', h.r.ok ? UI.pill('ok', 'ok') : h.r.needsApproval ? UI.pill('held for approval', 'info') : h.r.denied ? UI.pill('denied', 'danger') : UI.pill('failed', 'danger')], ['Typed result', h.r.valid == null ? '<span class="muted">no output schema</span>' : UI.pill(h.r.valid ? 'matches output schema' : 'schema mismatch', h.r.valid ? 'ok' : 'danger')], ['Result label', UI.label(h.r.label || sel.label, { sm: true })], ['Guardrail', esc(h.r.decision || 'not reached')], ['Duration', esc(h.r.durationMs + ' ms')], ['Sandbox', h.r.sandboxed ? 'yes' : 'live system']], 2) + (h.r.ok ? UI.ctx(sel.name + ' result', pretty(h.r.result), sel.label) : UI.notice(esc(h.r.note || h.r.error || ''), h.r.needsApproval ? 'info' : 'danger')) : '')
            + '<div class="hstack">' + UI.btn(h && h.phase === 'running' ? 'Running' : sel.kind === 'agent' ? 'Start a test run' : 'Run test harness', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-harness-run', disabled: (h && h.phase === 'running') || (sel.kind === 'agent' && !App.can('agents:run')) }) + (h && h.runId ? UI.btn('Open in Runs', { size: 'sm', kind: 'ghost', attrs: 'data-openrun="' + esc(h.runId) + '"' }) : '') + '</div>';
        }
      }
      inspector += '</aside>';

      root.innerHTML = '<style>.registry-page > *{flex-shrink:0}.registry-insp > *{flex-shrink:0}.registry-page .tabs .count{margin-left:2px}</style>'
        + '<div class="page registry-page">' + UI.pagehead('Registry', 'Nothing reaches a tenant before review', UI.btn('Open test harness', { attrs: 'data-harness-open' }) + UI.btn('Submit entry', { kind: 'primary', attrs: 'data-submit', disabled: !App.can('tools:manage') && !App.can('agents:manage') }))
        + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '')
        + UI.tabs([{ id: 'tools', label: 'Tools', count: ofKind('tool').length }, { id: 'skills', label: 'Skills', count: ofKind('skill').length }, { id: 'agents', label: 'Agents', count: ofKind('agent').length }, { id: 'review', label: 'Review queue', count: review.length }], st.tab)
        + '<div class="toolbar">' + UI.search('Search by name, owner or tool', 'data-search', st.query) + UI.seg([{ id: 'all', label: 'All' }].concat(STATUSES.map((v) => ({ id: v, label: statusText(v) }))), st.filter, 'data-statusseg') + '<span class="muted right" style="font-size:12px">Lifecycle: draft, in review, published, deprecated, retired</span></div>'
        + (st.tab === 'review' ? UI.notice('Entries wait here after their automated checks (schema, required fields, description, side effect, secrets scan). A tool admin other than the author approves and picks the publish scope.', 'info') : '')
        + table
        + (agentShown ? agentCard(agentShown) : '')
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
        + inspector;

      // ---- events ----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-statusseg] [data-seg]', (e, t) => { st.filter = t.dataset.seg; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', 'tr.row[data-entry]', (e, t) => { st.sel = t.dataset.entry; st.harness = null; st.harnessArgs = null; st.problem = null; ctx.rerender(); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      ctx.on('click', '[data-harness-open]', () => { st.harnessOpen = true; ctx.rerender(); });
      ctx.on('click', '[data-harness-close]', () => { st.harnessOpen = false; st.harness = null; ctx.rerender(); });
      ctx.on('input', '[data-args]', (e, t) => { st.harnessArgs = { id: sel.id, text: t.value }; });
      ctx.on('input', '[data-hinput]', (e, t) => { st.harnessInput = t.value; });
      ctx.on('click', '[data-harness-run]', () => runHarness());
      ctx.on('click', '[data-openrun]', (e, t) => ctx.navigate('runs', { run: t.dataset.openrun }));
      ctx.on('click', '[data-goruns]', (e, t) => ctx.navigate('runs', { agent: t.dataset.goruns }));
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', '[data-replacement]', (e, t) => { e.preventDefault(); const name = t.dataset.replacement.split(' ')[0]; const hit = list.find((x) => x.name === name && x.id !== sel.id); if (hit) { st.sel = hit.id; ctx.rerender(); } else toast('No entry named ' + esc(name) + ' in this registry yet.'); });
      ctx.on('click', '[data-copyhash]', (e, t) => { if (navigator.clipboard) navigator.clipboard.writeText(t.dataset.copyhash).catch(() => undefined); toast('Copied the full schema hash.'); });
      ctx.on('click', '[data-recheck]', () => act(() => App.post('/api/admin/registry/' + sel.id + '/checks'), 'Checks re-ran for ' + esc(sel.name) + '.'));
      ctx.on('click', '[data-submitreview]', async () => {
        const ok = await ctx.confirm({ title: 'Submit ' + esc(sel.name) + ' for review', tag: 'review', tone: 'info', body: '<p class="fg2" style="margin:0">The automated checks run again, then a tool admin other than you reviews it.</p>', kv: [['Version', esc(sel.version)], ['Checks now', sel.checksPassed ? 'all passing' : sel.checks.filter((c) => !c.ok).length + ' failing']], ok: 'Submit' });
        if (ok) act(() => App.post('/api/admin/registry/' + sel.id + '/submit'), esc(sel.name) + ' is in the review queue.');
      });
      ctx.on('click', '[data-approve]', async () => {
        const ok = await ctx.confirm({ title: 'Approve ' + esc(sel.name), tag: sel.kind === 'tool' ? SIDE[sel.sideEffect] : sel.kind, tone: sel.sideEffect === 'destructive' ? 'danger' : 'info', body: '<p class="fg2" style="margin:0">Approval records the schema hash <span class="mono">' + esc(String(sel.schemaHash).slice(0, 8)) + '</span>. If the schema changes later the entry is not callable until a new version is reviewed.</p>', kv: [['Side-effect class', sel.sideEffect ? SIDE[sel.sideEffect] : 'not applicable'], ['Confirmation', sel.confirm], ['Max label', sel.label], ['Reviewer', esc(me.displayName || '')]], ok: 'Approve and choose scope' });
        if (ok) publishScope(sel, 'review');
      });
      ctx.on('click', '[data-reject]', () => {
        const bad = sel.checks.filter((c) => !c.ok).map((c) => c.name + ': ' + c.detail).join('\n');
        ctx.modal({ title: 'Reject ' + esc(sel.name), body: UI.field('Reason for the owner', UI.textarea(bad, { rows: 3, attrs: 'data-reason' })) + UI.notice('The entry returns to draft. The owner is notified and can resubmit after fixing it.', 'warn'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const note = m.querySelector('[data-reason]').value.trim() || null; App.closeOverlay(); act(() => App.post('/api/admin/registry/' + sel.id + '/review', { decision: 'reject', note }), esc(sel.name) + ' rejected and returned to draft. Owner notified.', 'warn'); }); } });
      });
      ctx.on('click', '[data-deprecate]', () => {
        const d = detail || {};
        ctx.modal({ title: 'Deprecate ' + esc(sel.name), body: '<p class="fg2" style="margin:0">Deprecated entries stay callable. Every run that uses one shows a warning in run details with the replacement.</p>' + UI.field('Replacement', UI.input(sel.name + ' ' + (parseInt(sel.version, 10) + 1) + '.0.0', { attrs: 'data-repl' })) + UI.kv([['Used by', esc(((d.profiles || []).length + (d.referencedBy || []).length) + ' profiles, agents or skills')], ['Callable until retired', 'yes']], 2), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Deprecate', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const replacement = m.querySelector('[data-repl]').value.trim() || null; App.closeOverlay(); act(() => App.post('/api/admin/registry/' + sel.id + '/lifecycle', { to: 'deprecated', replacement }), esc(sel.name) + ' deprecated. Runs now show a warning.', 'warn'); }); } });
      });
      ctx.on('click', '[data-retire]', async () => {
        const refs = (detail && detail.referencedBy) || [];
        const ok = await ctx.confirm({ title: 'Retire ' + esc(sel.name), tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">Retiring removes the entry from routing. Agents that still reference it get a typed error. The entry stays resolvable for audit.</p>', kv: [['Still referenced by', esc(refs.map((r) => r.kind + ' ' + r.name + ' ' + r.version).join(', ') || 'nothing')], ['Audit', 'kept']], ok: 'Retire' });
        if (ok) act(() => App.post('/api/admin/registry/' + sel.id + '/lifecycle', { to: 'retired' }), esc(sel.name) + ' retired.' + (refs.length ? ' ' + refs.length + ' referencing entr' + (refs.length === 1 ? 'y' : 'ies') + ' will fail on their next call.' : ''), 'danger');
      });
      ctx.on('click', '[data-restore]', () => act(() => App.post('/api/admin/registry/' + sel.id + '/lifecycle', { to: 'published' }), esc(sel.name) + ' restored to published.'));
      ctx.on('click', '[data-publishmore]', () => publishScope(sel, 'publish'));
      ctx.on('click', '[data-newversion]', () => {
        const parts = String(sel.version).split('.').map((x) => parseInt(x, 10) || 0);
        ctx.modal({ title: 'New version of ' + esc(sel.name), body: UI.field('Version', UI.input(parts[0] + '.' + (parts[1] + 1) + '.0', { attrs: 'data-ver' }), 'A draft copied from ' + esc(sel.version) + '; it goes through checks and review like any draft.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', async () => { const version = m.querySelector('[data-ver]').value.trim(); App.closeOverlay(); const r = await act(() => App.post('/api/admin/registry/' + sel.id + '/versions', { version }), 'Draft ' + esc(sel.name) + ' ' + esc(version) + ' created.'); if (r && r.id) st.sel = r.id; }); } });
      });
      ctx.on('click', '[data-editentry]', () => entryForm(sel));
      ctx.on('click', '[data-goworkflow]', (e, t) => { e.preventDefault(); ctx.navigate('workflows', { id: t.dataset.goworkflow }); });
      ctx.on('click', '[data-submit]', () => entryForm(null));

      if (st.openSubmit) { st.openSubmit = false; setTimeout(() => entryForm(null), 30); }
      if (st.openScope) { const e = list.find((x) => x.id === st.openScope); st.openScope = null; if (e) setTimeout(() => publishScope(e, e.status === 'in_review' ? 'review' : 'publish'), 30); }
      if (st.harnessRun) { st.harnessRun = false; setTimeout(runHarness, 30); }

      async function runHarness() {
        if (!sel) return;
        let body;
        if (sel.kind === 'agent') body = { input: st.harnessInput || 'Describe what you can do in two sentences.' };
        else {
          const text = st.harnessArgs && st.harnessArgs.id === sel.id ? st.harnessArgs.text : pretty(sampleArgs(sel.inputSchema));
          try { body = { arguments: JSON.parse(text || '{}') }; } catch (err) { toast('The sample arguments are not valid JSON.', 'danger'); return; }
        }
        st.harnessOpen = true; st.harness = { id: sel.id, phase: 'running' }; ctx.rerender();
        try {
          const r = await App.post('/api/admin/registry/' + sel.id + '/test', body);
          if (sel.kind === 'agent') { st.harness = { id: sel.id, phase: 'started', runId: r.runId }; toast('Test run started. Open it in Runs to follow the steps.', 'ok'); }
          else { st.harness = { id: sel.id, phase: 'done', r }; toast(r.ok ? 'Harness run finished. Typed result labelled ' + esc(r.label) + '.' : esc(r.note || r.error || 'The call did not complete.'), r.ok ? 'ok' : 'warn'); }
        } catch (err) { st.harness = null; App.fail(err, 'Harness run failed'); }
        later();
      }

      function publishScope(e, mode) {
        const wss = App.DATA.workspaces || [];
        const current = e.publishScope === 'workspace' ? e.publishWorkspaces : [];
        ctx.modal({
          title: (mode === 'review' ? 'Publish ' : 'Publish scope for ') + esc(e.name) + ' ' + UI.pill(e.version, 'outline'),
          body: '<p class="fg2" style="margin:0">Choose whether the whole tenant or named workspaces receive the entry. Workspaces below the entry\'s max label cannot be chosen.</p>'
            + '<div class="vstack gap6">' + UI.check('The whole tenant, every workspace', e.publishScope !== 'workspace', 'data-tenant')
            + wss.map((w) => '<div class="hstack">' + UI.check(w.name, current.indexOf(w.id) >= 0, 'data-ws="' + esc(w.id) + '"' + (rank(w.label) < rank(e.label) ? ' disabled' : '')) + '<span class="muted grow" style="font-size:12px">' + (rank(w.label) < rank(e.label) ? 'ceiling below ' + esc(e.label) : 'workspace') + '</span>' + UI.label(w.label, { sm: true }) + '</div>').join('') + '</div>'
            + (wss.length ? '' : '<div class="muted" style="font-size:12px">You are not a member of any workspace, so only the whole tenant can be chosen here.</div>')
            + UI.kv([['Status after publish', UI.pill('published', 'ok')], ['Schema hash recorded', '<span class="mono">' + esc(String(e.schemaHash).slice(0, 8)) + '</span>']], 2),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Publish', { kind: 'primary', attrs: 'data-ok' }),
          onMount(m) {
            const tenant = m.querySelector('[data-tenant]');
            const boxes = Array.prototype.slice.call(m.querySelectorAll('[data-ws]'));
            const sync = () => boxes.forEach((b) => { if (tenant.checked) b.checked = false; });
            tenant.addEventListener('change', sync);
            boxes.forEach((b) => b.addEventListener('change', () => { if (b.checked) tenant.checked = false; }));
            m.querySelector('[data-ok]').addEventListener('click', () => {
              const workspaces = boxes.filter((b) => b.checked).map((b) => b.dataset.ws);
              const scope = tenant.checked || !workspaces.length ? 'tenant' : 'workspace';
              App.closeOverlay();
              const n = scope === 'tenant' ? 'the whole tenant' : workspaces.length + ' workspace' + (workspaces.length === 1 ? '' : 's');
              if (mode === 'review') act(() => App.post('/api/admin/registry/' + e.id + '/review', { decision: 'approve', scope, workspaces }), esc(e.name) + ' ' + esc(e.version) + ' published to ' + n + '.', 'ok');
              else act(() => App.post('/api/admin/registry/' + e.id + '/publish', { scope, workspaces }), esc(e.name) + ' is now published to ' + n + '.');
            });
          }
        });
      }

      function entryForm(e) {
        const kind = e ? e.kind : App.can('tools:manage') ? 'skill' : 'agent';
        const d = e ? e.definition || {} : {};
        const b = d.budgets || { steps: 20, tokens: 10000, wallSeconds: 120, toolCalls: 8 };
        const published = list.filter((x) => x.kind === 'tool' && (x.status === 'published' || x.status === 'deprecated')).map((x) => x.name);
        const kinds = [];
        if (App.can('tools:manage')) kinds.push({ value: 'skill', label: 'Skill' }, { value: 'tool', label: 'Tool (script-backed)' });
        if (App.can('agents:manage')) kinds.push({ value: 'agent', label: 'Agent' });
        const fields = (k) => {
          const common = UI.field('Name', UI.input(e ? e.name : '', { placeholder: k === 'agent' ? 'Data analyst' : 'namespace.operation', attrs: 'data-name' + (e ? ' readonly' : '') })) + UI.field('Version', UI.input(e ? e.version : '0.1.0', { attrs: 'data-version' + (e ? ' readonly' : '') }))
            + '<div class="span2">' + UI.field('Description', UI.textarea(e ? e.description || '' : '', { rows: 2, attrs: 'data-desc', placeholder: 'What it does, when to use it and what it returns' }), 'At least 40 characters: a model reads this to decide when to use it.') + '</div>'
            + UI.field('Max label', UI.select(LABELS.filter((l) => !me.clearance || rank(l) <= rank(me.clearance)), e ? e.label : 'internal', 'data-label'));
          if (k === 'skill') return common + '<div class="span2">' + UI.field('Instructions', UI.textarea(d.instructions || '', { rows: 5, attrs: 'data-instructions' })) + '</div>' + UI.field('Tools it uses', UI.input((d.tools || []).join(', '), { attrs: 'data-tools list="registry-tools"', placeholder: 'calculate, ledger.query' }), 'Published tools only');
          if (k === 'agent') return common + UI.field('Model profile', UI.input(d.profile || '', { attrs: 'data-profile', placeholder: 'general' }), 'A profile of this tenant; its model must support tools if the agent has any') + '<div class="span2">' + UI.field('Tools', UI.input((d.tools || []).join(', '), { attrs: 'data-tools list="registry-tools"', placeholder: 'calculate, jira.create_issue' }), 'Published tools only; write and destructive calls pause the run for approval') + UI.field('Skills', UI.input((d.skills || []).join(', '), { attrs: 'data-skills' })) + UI.field('System prompt', UI.textarea(d.systemPrompt || '', { rows: 3, attrs: 'data-prompt' })) + '</div>'
            + UI.field('Steps', UI.input(String(b.steps), { type: 'number', attrs: 'data-b="steps"' })) + UI.field('Tokens', UI.input(String(b.tokens), { type: 'number', attrs: 'data-b="tokens"' })) + UI.field('Wall time, seconds', UI.input(String(b.wallSeconds), { type: 'number', attrs: 'data-b="wallSeconds"' })) + UI.field('Tool calls', UI.input(String(b.toolCalls), { type: 'number', attrs: 'data-b="toolCalls"' }));
          return common + UI.field('Script', '<select class="select" data-script><option value="">Loading scripts…</option></select>', 'A tested script; the tool runs it with arguments as JSON on stdin') + UI.field('Side-effect class', UI.select([{ value: 'read', label: 'read-only' }, { value: 'write', label: 'write' }, { value: 'destructive', label: 'destructive' }], 'read', 'data-side'), 'write and destructive require confirmation')
            + '<div class="span2">' + UI.field('Input schema (JSON Schema)', UI.textarea('{\n  "type": "object",\n  "properties": {},\n  "required": []\n}', { rows: 5, attrs: 'data-in' })) + UI.field('Output schema (optional)', UI.textarea('', { rows: 3, attrs: 'data-out' })) + '</div>';
        };
        ctx.modal({
          title: e ? 'Edit draft ' + esc(e.name) + ' ' + esc(e.version) : 'Submit entry',
          cls: 'wide',
          body: '<datalist id="registry-tools">' + published.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>'
            + (e ? '' : UI.field('Kind', UI.select(kinds, kind, 'data-kind'), 'Tools come from promoted scripts and approved MCP servers; this form creates script-backed tools.'))
            + '<div class="formgrid" data-fields>' + fields(kind) + '</div>'
            + UI.notice(e ? 'Saving re-runs the automated checks.' : 'Submitting creates a <b>draft</b> and runs the automated checks. A tool admin other than you reviews it after you submit it. Nothing reaches a tenant before review.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(e ? 'Save and re-run checks' : 'Save draft and run checks', { kind: 'primary', attrs: 'data-ok' }),
          onMount(m) {
            let k = kind;
            const fillScripts = () => {
              const s = m.querySelector('[data-script]'); if (!s) return;
              if (!App.can('scripts:run')) { s.innerHTML = '<option value="">Needs scripts:run to list scripts</option>'; return; }
              App.get('/api/scripts').then((rows) => { const ok = rows.filter((x) => x.status === 'tested' || x.status === 'promoted'); s.innerHTML = ok.length ? ok.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name + ' v' + x.version + ', ' + x.status) + '</option>').join('') : '<option value="">No tested scripts in this workspace</option>'; }).catch(() => { s.innerHTML = '<option value="">Scripts could not be loaded</option>'; });
            };
            const kindSel = m.querySelector('[data-kind]');
            if (kindSel) kindSel.addEventListener('change', () => { k = kindSel.value; m.querySelector('[data-fields]').innerHTML = fields(k); fillScripts(); });
            fillScripts();
            const val = (sel2) => { const x = m.querySelector(sel2); return x ? x.value : ''; };
            const listOf = (sel2) => val(sel2).split(',').map((x) => x.trim()).filter(Boolean);
            m.querySelector('[data-ok]').addEventListener('click', async () => {
              let body;
              try {
                const common = { description: val('[data-desc]').trim() || null, label: val('[data-label]') };
                if (k === 'skill') body = Object.assign(common, { definition: { instructions: val('[data-instructions]'), tools: listOf('[data-tools]') } });
                else if (k === 'agent') { const bud = {}; m.querySelectorAll('[data-b]').forEach((x) => { bud[x.dataset.b] = Number(x.value); }); body = Object.assign(common, { definition: { profile: val('[data-profile]').trim(), systemPrompt: val('[data-prompt]') || null, tools: listOf('[data-tools]'), skills: listOf('[data-skills]'), budgets: bud } }); }
                else body = Object.assign(common, { sideEffect: val('[data-side]'), inputSchema: JSON.parse(val('[data-in]') || '{}'), outputSchema: val('[data-out]').trim() ? JSON.parse(val('[data-out]')) : null, definition: { scriptId: val('[data-script]') } });
              } catch (err) { toast('A schema is not valid JSON: ' + esc(err.message), 'danger'); return; }
              App.closeOverlay();
              if (e) { await act(() => App.patch('/api/admin/registry/' + e.id, body), 'Draft ' + esc(e.name) + ' saved. Checks re-ran.'); return; }
              Object.assign(body, { kind: k, name: val('[data-name]').trim(), version: val('[data-version]').trim() || '0.1.0' });
              const r = await act(() => App.post('/api/admin/registry', body), 'Draft ' + esc(body.name) + ' ' + esc(body.version) + ' saved. Its checks ran.');
              if (r && r.id) { st.sel = r.id; st.tab = k === 'tool' ? 'tools' : k + 's'; }
            });
          }
        });
      }
    }
  });
})();
