(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  const TOOLS = [
    { id: 'kb.search', kind: 'tool', side: 'read-only', version: '2.3.0', label: 'confidential', egress: 'none', status: 'published', owner: 'Platform tools team', scopes: 'kb:read', confirm: 'never', rate: '600 per user per hour', secrets: 'none', hint: 'readOnlyHint: true (applied after review)', hash: 'a3f19c02', impl: 'Built-in TypeScript', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', true]] },
    { id: 'ledger.query', kind: 'tool', side: 'read-only', version: '1.1.2', label: 'confidential', egress: 'data', status: 'published', owner: 'Finance systems', scopes: 'ledger:read', confirm: 'never', rate: '120 per user per hour', secrets: 'ref: ledger-ro-dsn', hint: 'none (OpenAPI operation)', hash: '5c0e77b1', impl: 'OpenAPI operation, ledger-api v4', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', true]] },
    { id: 'jira-internal.create_issue', kind: 'tool', side: 'write', version: '1.0.4', label: 'confidential', egress: 'app-internal', status: 'published', owner: 'Platform tools team', scopes: 'tools:invoke, jira:write', confirm: 'always', rate: '30 per user per hour', secrets: 'per-user token vault', hint: 'destructiveHint: false (untrusted, class set at review)', hash: 'e2b84d10', impl: 'MCP server tool, jira-internal', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', true]] },
    { id: 'kb.delete_documents', kind: 'tool', side: 'destructive', version: '1.2.0', label: 'confidential', egress: 'none', status: 'published', owner: 'Platform tools team', scopes: 'kb:admin', confirm: 'always', rate: '10 per user per hour', secrets: 'none', hint: 'destructiveHint: true (applied after review)', hash: '91d0c4ee', impl: 'Built-in TypeScript', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', true]] },
    { id: 'mail.send_internal', kind: 'tool', side: 'external-comms', version: '0.9.0', label: 'internal', egress: 'mail-relay', status: 'in review', owner: 'Platform tools team', scopes: 'tools:invoke', confirm: 'always', rate: '20 per user per hour', secrets: 'ref: smtp-relay-cred', hint: 'openWorldHint: false (untrusted, not applied)', hash: '7fa2c913', impl: 'Built-in TypeScript', submitted: '18 Sep, Platform tools team', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', false]], egressNote: 'Observed a connection to ldap.northwind.internal that is not declared.' },
    { id: 'report.generate (script)', kind: 'tool', side: 'write', version: '0.3.1', label: 'internal', egress: 'none', status: 'draft', owner: 'Mara Okafor', scopes: 'tools:invoke', confirm: 'always', rate: '60 per user per hour', secrets: 'none', hint: 'none (script-backed tool)', hash: 'c48b12a7', impl: 'Script-backed, monthly_variance.py', checks: [['Schema valid', true], ['Dependency scan clean', false], ['Declared egress matches observed', true]], egressNote: 'openpyxl 3.0.9 has a known advisory; the curated wheel set carries 3.1.5.' }
  ];
  const SKILLS = [
    { id: 'variance-analysis', kind: 'skill', contents: 'Instructions, 3 reference files, calc.table', version: '3.0.0', label: 'confidential', tools: 'ledger.query, calc.*', status: 'published', owner: 'Finance systems', scopes: 'skills:load', confirm: 'not applicable', rate: 'not applicable', secrets: 'none', hint: 'none', hash: '4d81f0aa', impl: 'Versioned archive, manifest v1', checks: [['Manifest valid', true], ['Reference files scanned', true], ['Referenced tools published', true]] },
    { id: 'contract-redline', kind: 'skill', contents: 'Instructions, 5 reference files', version: '2.1.0', label: 'internal', tools: 'kb.search', status: 'published', owner: 'Legal ops', scopes: 'skills:load', confirm: 'not applicable', rate: 'not applicable', secrets: 'none', hint: 'none', hash: 'b02e6c51', impl: 'Versioned archive, manifest v1', checks: [['Manifest valid', true], ['Reference files scanned', true], ['Referenced tools published', true]] },
    { id: 'meeting-notes', kind: 'skill', contents: 'Instructions, 1 reference file, imported MCP prompt', version: '1.0.0', label: 'internal', tools: 'kb.add_document', status: 'in review', owner: 'Knowledge team', scopes: 'skills:load', confirm: 'not applicable', rate: 'not applicable', secrets: 'none', hint: 'imported from MCP prompt report-tools/meeting-notes', hash: '6ea3d7f4', impl: 'Versioned archive, manifest v1', submitted: '19 Sep, Knowledge team', checks: [['Manifest valid', true], ['Reference files scanned', true], ['Referenced tools published', true]] },
    { id: 'travel-policy-lookup', kind: 'skill', contents: 'Instructions only', version: '0.2.0', label: 'internal', tools: 'kb.search', status: 'draft', owner: 'Mara Okafor', scopes: 'skills:load', confirm: 'not applicable', rate: 'not applicable', secrets: 'none', hint: 'none', hash: '19c7a8d3', impl: 'Versioned archive, manifest v1', checks: [['Manifest valid', true], ['Reference files scanned', true], ['Referenced tools published', true]] }
  ];
  const AGENTS = [
    { id: 'Data analyst', kind: 'agent', profile: 'plan: analyst at high, tool selection: general-8b at low', version: '4.2.0', label: 'confidential', tools: 'kb.search, ledger.query, calc.*, jira-internal.create_issue', skills: 'variance-analysis v3', kbs: 'Finance KB, Travel policy', guard: 'Finance baseline v12', limits: '20 steps, 10,000 tokens, 120 s, 8 tool calls', status: 'published', owner: 'Finance systems', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '40 runs per user per day', secrets: 'none held; RFC 8693 token exchange per run', hint: 'none', hash: 'd7a10b3e', impl: 'Agent definition v2', checks: [['Definition valid', true], ['All tools and skills published', true], ['Limits within workspace policy', true]] },
    { id: 'Meeting notes', kind: 'agent', profile: 'plan: analyst at medium, captions: vision at low', version: '1.0.0', label: 'internal', tools: 'kb.add_document, calc.table', skills: 'meeting-notes v1', kbs: 'Team notes', guard: 'Default baseline v9', limits: '30 steps, 60,000 tokens, 600 s, 12 tool calls', status: 'in review', owner: 'Knowledge team', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '20 runs per user per day', secrets: 'none held; RFC 8693 token exchange per run', hint: 'none', hash: '2f9e5c60', impl: 'Agent definition v2', submitted: '19 Sep, Knowledge team', checks: [['Definition valid', true], ['All tools and skills published', false], ['Limits within workspace policy', true]], egressNote: 'Skill meeting-notes v1 is still in review. Publish the skill first or remove it.' },
    { id: 'Support triage', kind: 'agent', profile: 'plan: chat-default at medium', version: '0.4.0', label: 'internal', tools: 'kb.search, jira-internal.create_issue', skills: 'none', kbs: 'Policy KB', guard: 'Default baseline v9', limits: '12 steps, 6,000 tokens, 60 s, 4 tool calls', status: 'draft', owner: 'People Ops', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '100 runs per user per day', secrets: 'none held', hint: 'none', hash: '8b3c41f9', impl: 'Agent definition v2', checks: [['Definition valid', true], ['All tools and skills published', true], ['Limits within workspace policy', true]] },
    { id: 'Code reviewer', kind: 'agent', profile: 'plan: coder at medium', version: '2.0.1', label: 'internal', tools: 'gitlab-onprem.get_merge_request', skills: 'none', kbs: 'Engineering wiki', guard: 'Default baseline v9', limits: '16 steps, 20,000 tokens, 180 s, 6 tool calls', status: 'deprecated', replacement: 'Code reviewer 3.0', owner: 'Platform lab', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '40 runs per user per day', secrets: 'none held', hint: 'none', hash: 'e51a9d27', impl: 'Agent definition v2', checks: [['Definition valid', true], ['All tools and skills published', true], ['Limits within workspace policy', true]] }
  ];
  const ALL = TOOLS.concat(SKILLS, AGENTS);
  const find = (id) => ALL.find((e) => e.id === id);
  const sidePill = (s) => UI.pill(s, s === 'read-only' ? 'ok' : s === 'write' ? 'warn' : s === 'destructive' ? 'danger' : 'info');
  const statusPill = (s) => UI.pill(s, s === 'published' ? 'ok' : s === 'in review' ? 'info' : s === 'deprecated' ? 'warn' : s === 'retired' ? 'danger' : '');
  const VERSIONS = ['draft', 'in review', 'published', 'deprecated', 'retired'];

  let bound = false; const cur = {};

  App.register({
    id: 'registry', title: 'Registry', summary: 'Tools, skills and agents; review queue; test harness', section: 'admin', crumb: ['Admin', 'Registry'],
    commands: [
      { label: 'Submit a registry entry', sub: 'Registry', run(app) { app.stateFor('registry').openSubmit = true; app.render(); } },
      { label: 'Open the review queue', sub: 'Registry', run(app) { app.stateFor('registry').tab = 'review'; app.render(); } }
    ],
    states: [
      { title: 'Undeclared egress', tone: 'danger', text: 'Approve stays disabled until the owner declares or removes the destination.', apply(ctx) { ctx.state.tab = 'tools'; ctx.state.sel = 'mail.send_internal'; ctx.state.egressFixed = false; ctx.state.showEgress = true; ctx.rerender(); } },
      { title: 'Publish scope', tone: 'neutral', text: 'Publishing asks which tenants or workspaces receive the entry. Workspace admins then enable it for members.', apply(ctx) { ctx.state.sel = ctx.state.sel || 'mail.send_internal'; ctx.rerender(); publishScope(ctx, find(ctx.state.sel)); } },
      { title: 'Deprecated', tone: 'warn', text: 'Deprecated tools stay callable with a warning in run details and a replacement link.', apply(ctx) { const st = ctx.state; st.tab = 'tools'; st.over = st.over || {}; const id = (st.sel && find(st.sel) && find(st.sel).kind === 'tool' && (st.over[st.sel] || find(st.sel).status) === 'published') ? st.sel : 'ledger.query'; st.over[id] = 'deprecated'; st.sel = id; ctx.rerender(); } },
      { title: 'Test harness', tone: 'info', text: 'Runs the tool in the sandbox with sample arguments and shows the typed result and label.', apply(ctx) { ctx.state.tab = 'tools'; ctx.state.sel = 'ledger.query'; ctx.state.harnessOpen = true; ctx.rerender(); runHarness(ctx); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.entry) { st.sel = ctx.params.entry; const e = find(st.sel); if (e) st.tab = e.kind === 'tool' ? 'tools' : e.kind === 'skill' ? 'skills' : 'agents'; delete ctx.params.entry; }
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }
      st.tab = st.tab || 'tools'; st.sel = st.sel || 'mail.send_internal'; st.query = st.query || ''; st.over = st.over || {}; st.added = st.added || [];
      if (st.egressFixed === undefined) st.egressFixed = false;
      st.filter = st.filter || 'all';
      cur.ctx = ctx; cur.st = st;

      const entries = ALL.concat(st.added);
      const status = (e) => st.over[e.id] || e.status;
      const q = st.query.toLowerCase();
      const match = (e) => (!q || (e.id + ' ' + e.owner + ' ' + (e.side || '') + ' ' + (e.tools || '')).toLowerCase().includes(q)) && (st.filter === 'all' || status(e) === st.filter);
      const tools = entries.filter((e) => e.kind === 'tool' && match(e));
      const skills = entries.filter((e) => e.kind === 'skill' && match(e));
      const agents = entries.filter((e) => e.kind === 'agent' && match(e));
      const review = entries.filter((e) => status(e) === 'in review');
      const sel = entries.find((e) => e.id === st.sel) || entries[4];
      const selStatus = status(sel);
      const checksFor = (e) => e.checks.map((c) => { const ok = c[1] || (e.id === 'mail.send_internal' && c[0].startsWith('Declared egress') && st.egressFixed); return [c[0], ok]; });
      const checks = checksFor(sel);
      const checksOk = checks.every((c) => c[1]);

      const rowAttrs = (e) => 'data-entry="' + esc(e.id) + '"';
      let table;
      if (st.tab === 'tools') table = UI.table(['Tool', 'Side effect', 'Version', 'Max label', 'Egress', 'Status'], tools.map((e) => ({ cells: ['<span style="font-weight:600">' + esc(e.id) + '</span>', sidePill(e.side), '<span class="mono">' + esc(e.version) + '</span>', UI.label(e.label, { sm: true }), esc(e.egress), statusPill(status(e))], attrs: rowAttrs(e), selected: e.id === sel.id })), { emptyTitle: 'No tools match', emptyText: 'Clear the search or the status filter.' });
      else if (st.tab === 'skills') table = UI.table(['Skill', 'Contents', 'Version', 'Max label', 'Tools', 'Status'], skills.map((e) => ({ cells: ['<span style="font-weight:600">' + esc(e.id) + '</span>', esc(e.contents), '<span class="mono">' + esc(e.version) + '</span>', UI.label(e.label, { sm: true }), '<span class="mono">' + esc(e.tools) + '</span>', statusPill(status(e))], attrs: rowAttrs(e), selected: e.id === sel.id })), { emptyTitle: 'No skills match', emptyText: 'Clear the search or the status filter.' });
      else if (st.tab === 'agents') table = UI.table(['Agent', 'Profile per step', 'Tools', 'Version', 'Max label', 'Status'], agents.map((e) => ({ cells: ['<span style="font-weight:600">' + esc(e.id) + '</span>', esc(e.profile), '<span class="mono" style="white-space:normal">' + esc(e.tools) + '</span>', '<span class="mono">' + esc(e.version) + '</span>', UI.label(e.label, { sm: true }), statusPill(status(e))], attrs: rowAttrs(e), selected: e.id === sel.id })), { emptyTitle: 'No agents match', emptyText: 'Clear the search or the status filter.' });
      else table = UI.table(['Entry', 'Kind', 'Submitted', 'Automated checks', 'Waiting', 'Status'], review.map((e) => { const c = checksFor(e); const bad = c.filter((x) => !x[1]).length; return { cells: ['<span style="font-weight:600">' + esc(e.id) + '</span>', esc(e.kind), esc(e.submitted || 'today, ' + e.owner), bad ? UI.pill(bad + ' failing', 'danger') : UI.pill('all passed', 'ok'), e.submitted && e.submitted.startsWith('18') ? '2 days' : '1 day', statusPill(status(e))], attrs: rowAttrs(e), selected: e.id === sel.id }; }), { emptyTitle: 'The review queue is empty', emptyText: 'Submitted entries appear here after their automated checks finish.' });

      const agentCard = (a) => UI.panel('Agent: ' + a.id, UI.kv([['Profile per step', esc(a.profile)], ['Tools', esc(a.tools)], ['Skills', esc(a.skills)], ['Knowledge bases', esc(a.kbs)], ['Guardrail profile', '<a href="#" data-goguard>' + esc(a.guard) + '</a>'], ['Limits', esc(a.limits)]], 3), { actions: UI.btn('Open in chat', { size: 'sm', attrs: 'data-gochat="' + esc(a.id) + '"' }) + UI.btn('Profile', { size: 'sm', kind: 'ghost', attrs: 'data-goprofile' }) });
      const agentShown = st.tab === 'agents' && sel.kind === 'agent' ? sel : st.tab === 'review' ? null : AGENTS[0];

      // harness panel
      let harness = '';
      if (st.harnessOpen) {
        const h = st.harness || {};
        harness = '<div class="divider"></div><div class="hstack"><div class="eyebrow grow">Test harness</div>' + UI.iconbtn('x', 'Close harness', { cls: 'sm ghost', attrs: 'data-harness-close' }) + '</div>'
          + UI.field('Sample arguments', UI.textarea(sel.kind === 'tool' ? (sel.id === 'ledger.query' ? '{ "cost_centre": "FIELD-SALES", "period": "2026-Q3" }' : sel.id === 'mail.send_internal' ? '{ "to": "finance-ops@northwind.local", "subject": "Test" }' : '{ "query": "travel policy exceptions", "top_k": 3 }') : '{ "input": "sample" }', { rows: 2, attrs: 'data-args' }))
          + (h.phase === 'running' ? UI.meter(h.step, h.pct + '%', h.pct, 'accent') : h.phase === 'done' ? UI.meter('Finished in 1.8 s', '100%', 100) : '')
          + (h.phase === 'done' ? UI.kv([['Typed result', UI.pill(h.valid ? 'matches output schema' : 'schema mismatch', h.valid ? 'ok' : 'danger')], ['Result label', UI.label(sel.label, { sm: true }) + ' <span class="muted">Context tier</span>'], ['Sandbox', 'gVisor, egress ' + esc(sel.egress) + ', 240 ms'], ['Output size', '1.4 KB of 64 KB cap']], 2) + UI.ctx(sel.id + ' result', h.result, sel.label) : '')
          + '<div class="hstack">' + UI.btn(h.phase === 'running' ? 'Running' : 'Run test harness', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-harness-run', disabled: h.phase === 'running' }) + (h.phase === 'done' ? UI.btn('Open in Runs', { size: 'sm', kind: 'ghost', attrs: 'data-goruns' }) : '') + '</div>';
      }

      const deprecatedNote = selStatus === 'deprecated' ? UI.notice('<b>Deprecated.</b> Still callable; every run that uses it shows a warning in run details. Replacement: <a href="#" data-replacement>' + esc(sel.replacement || (sel.id.split(' ')[0] + ' ' + (parseInt(sel.version, 10) + 1) + '.0')) + '</a>', 'warn', UI.btn('Retire', { size: 'sm', attrs: 'data-retire' })) : '';
      const retiredNote = selStatus === 'retired' ? UI.notice('<b>Retired.</b> Removed from routing; the entry stays resolvable for audit.', 'danger') : '';

      const inspector = '<aside class="inspector w360 registry-insp">'
        + '<div class="mono" style="font-size:14px">' + esc(sel.id) + '</div>'
        + '<div class="hstack wrap gap6">' + (sel.side ? sidePill(sel.side) : UI.pill(sel.kind, 'outline')) + statusPill(selStatus) + UI.label(sel.label, { sm: true }) + '</div>'
        + deprecatedNote + retiredNote
        + UI.kv([['Owner', esc(sel.owner)], ['Version', '<span class="mono">' + esc(sel.version) + '</span> <span class="muted">' + esc(selStatus) + '</span>'], ['Schema hash', '<span class="mono">' + esc(sel.hash) + '</span> ' + UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copy="' + esc(sel.hash) + '"' })], ['Implemented as', esc(sel.impl)], ['Required scopes', '<span class="mono">' + esc(sel.scopes) + '</span>'], ['Ceiling label', UI.label(sel.label, { sm: true })], ['Confirmation required', esc(sel.confirm) + (sel.side && sel.side !== 'read-only' ? ' <span class="muted">(' + esc(sel.side) + ' class)</span>' : '')], ['Rate limit', esc(sel.rate)], ['Secrets', '<span class="mono">' + esc(sel.secrets) + '</span>'], ['MCP hint', esc(sel.hint)]], 1)
        + '<div class="hstack"><div class="eyebrow grow">Automated checks</div>' + UI.btn('Re-run', { kind: 'ghost', size: 'xs', icon: 'refresh', attrs: 'data-recheck' }) + '</div>'
        + '<div class="vstack gap4">' + checks.map((c) => '<div class="hstack" style="color:var(--' + (c[1] ? 'ok-fg' : 'danger-fg') + ')">' + UI.icon(c[1] ? 'check' : 'x', 14) + '<span style="color:var(--fg)">' + esc(c[0]) + '</span></div>').join('')
        + (!checksOk && sel.egressNote ? '<div style="font-size:12px;color:var(--danger-fg)">' + esc(sel.egressNote) + '</div>' : '') + '</div>'
        + (sel.id === 'mail.send_internal' && !st.egressFixed ? '<div class="hstack wrap gap6">' + UI.btn('Declare ldap.northwind.internal', { size: 'sm', attrs: 'data-declare' }) + UI.btn('Ask owner', { size: 'sm', kind: 'ghost', attrs: 'data-askowner' }) + '</div>' : '')
        + (st.lastHarness && st.lastHarness.id === sel.id ? '<div class="eyebrow">Test harness results</div>' + UI.kv([['Last run', esc(st.lastHarness.when)], ['Result', UI.pill('typed result, ' + sel.label, 'ok')]], 2) : '')
        + '<div class="hstack wrap">'
        + (selStatus === 'in review' ? UI.btn('Reject', { attrs: 'data-reject' }) + UI.btn('Approve', { kind: 'primary', attrs: 'data-approve', disabled: !checksOk, title: checksOk ? '' : 'Approve stays disabled until the checks pass' })
          : selStatus === 'draft' ? UI.btn('Edit', { attrs: 'data-editentry' }) + UI.btn('Submit for review', { kind: 'primary', attrs: 'data-submitreview' })
            : selStatus === 'published' ? UI.btn('Deprecate', { attrs: 'data-deprecate' }) + UI.btn('Publish to more', { kind: 'primary', attrs: 'data-publishmore' })
              : selStatus === 'deprecated' ? UI.btn('Retire', { kind: 'danger', attrs: 'data-retire' }) + UI.btn('Restore', { attrs: 'data-restore' }) : '')
        + UI.btn('Test harness', { kind: 'ghost', icon: 'play', attrs: 'data-harness-open' }) + '</div>'
        + harness + '</aside>';

      root.innerHTML = '<style>.registry-page > *{flex-shrink:0}.registry-insp > *{flex-shrink:0}.registry-page .tabs .count{margin-left:2px}</style>'
        + '<div class="page registry-page">' + UI.pagehead('Registry', 'Nothing reaches a tenant before review', UI.btn('Open test harness', { attrs: 'data-harness-open' }) + UI.btn('Submit entry', { kind: 'primary', attrs: 'data-submit' }))
        + (st.showEgress && !st.egressFixed ? UI.notice('<b>Undeclared egress.</b> mail.send_internal opened a connection to <span class="mono">ldap.northwind.internal</span> during checks. Approve stays disabled until the owner declares or removes the destination.', 'danger', UI.btn('Declare destination', { size: 'sm', attrs: 'data-declare' })) : '')
        + UI.tabs([{ id: 'tools', label: 'Tools', count: entries.filter((e) => e.kind === 'tool').length }, { id: 'skills', label: 'Skills', count: entries.filter((e) => e.kind === 'skill').length }, { id: 'agents', label: 'Agents', count: entries.filter((e) => e.kind === 'agent').length }, { id: 'review', label: 'Review queue', count: review.length }], st.tab)
        + '<div class="toolbar">' + UI.search('Search by name, owner or tool', 'data-search', st.query) + UI.seg([{ id: 'all', label: 'All' }].concat(VERSIONS.map((v) => ({ id: v, label: v }))), st.filter, 'data-statusseg') + '<span class="muted right" style="font-size:12px">Lifecycle: draft, in review, published, deprecated, retired</span></div>'
        + (st.tab === 'review' ? UI.notice('Entries wait here after automated checks (schema, dependency scan, declared egress). A tool admin approves and picks the publish scope; workspace admins then enable entries for members.', 'info') : '')
        + table
        + (agentShown ? agentCard(agentShown) : '')
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
        + inspector;

      if (st.openSubmit) { st.openSubmit = false; setTimeout(() => submitEntry(ctx), 30); }
      if (bound) return; bound = true;

      // ---- events (bound once; read cur.ctx / cur.st) ----
      const on = ctx.on;
      on('click', '[data-tab]', (e, t) => { cur.st.tab = t.dataset.tab; cur.ctx.rerender(); });
      on('click', '[data-statusseg] [data-seg]', (e, t) => { cur.st.filter = t.dataset.seg; cur.ctx.rerender(); });
      on('input', '[data-search]', (e, t) => { cur.st.query = t.value; const v = t.value; cur.ctx.rerender(); const i = cur.ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      on('click', 'tr.row[data-entry]', (e, t) => { cur.st.sel = t.dataset.entry; cur.st.harness = null; cur.ctx.rerender(); });
      on('click', '.state-card', (e, t) => cur.ctx.app.applyState(+t.dataset.state));
      on('click', '[data-harness-open]', () => { cur.st.harnessOpen = true; cur.ctx.rerender(); });
      on('click', '[data-harness-close]', () => { cur.st.harnessOpen = false; cur.st.harness = null; cur.ctx.rerender(); });
      on('click', '[data-harness-run]', () => runHarness(cur.ctx));
      on('click', '[data-goruns]', () => cur.ctx.navigate('runs'));
      on('click', '[data-goguard]', (e) => { e.preventDefault(); cur.ctx.navigate('guardrails'); });
      on('click', '[data-goprofile]', () => cur.ctx.navigate('profiles', { profile: 'analyst' }));
      on('click', '[data-gochat]', (e, t) => cur.ctx.navigate('chat', { convo: t.dataset.gochat === 'Data analyst' ? 'c4' : 'new' }));
      on('click', '[data-replacement]', (e) => { e.preventDefault(); cur.ctx.toast('The replacement entry opens in the same registry tab.'); });
      on('click', '[data-declare]', () => {
        const ctx = cur.ctx;
        ctx.modal({ title: 'Declare egress destination', body: UI.field('Destination', UI.input('ldap.northwind.internal:636', { readonly: true })) + UI.field('Zone', UI.select(['app-internal', 'data', 'mail-relay'], 'app-internal')) + UI.field('Reason', UI.textarea('Resolves recipient addresses against the directory before relaying.', { rows: 2 })) + UI.notice('The owner is recorded on the declaration. Checks re-run against the declared set.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Declare and re-run checks', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { App.closeOverlay(); cur.st.egressFixed = true; cur.st.showEgress = false; ctx.rerender(); ctx.toast('Egress declared. Checks pass; Approve is enabled.', 'ok'); }); } });
      });
      on('click', '[data-askowner]', () => cur.ctx.toast('Asked Platform tools team to declare or remove ldap.northwind.internal. The entry stays in review.'));
      on('click', '[data-recheck]', () => { cur.ctx.toast('Checks queued in the sandbox. Results replace the list when they finish.'); setTimeout(() => cur.ctx.toast('Checks finished with the same results.'), 1500); });
      on('click', '[data-approve]', async () => {
        const ctx = cur.ctx; const e = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel);
        const ok = await ctx.confirm({ title: 'Approve ' + esc(e.id), tag: e.side || e.kind, tone: e.side === 'destructive' ? 'danger' : 'info', body: '<p class="fg2" style="margin:0">Approval records the schema hash <span class="mono">' + esc(e.hash) + '</span>. If the schema changes later the entry is disabled until re-reviewed.</p>', kv: [['Side-effect class', e.side || 'not applicable'], ['Confirmation', e.confirm], ['Max label', e.label], ['Reviewer', 'Mara Okafor']], ok: 'Approve and choose scope' });
        if (ok) publishScope(ctx, e);
      });
      on('click', '[data-reject]', () => {
        const ctx = cur.ctx; const e = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel);
        ctx.modal({ title: 'Reject ' + esc(e.id), body: UI.field('Reason for the owner', UI.textarea(e.egressNote || '', { rows: 3, attrs: 'data-reason' })) + UI.notice('The entry returns to draft. The owner can resubmit after fixing the checks.', 'warn'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { App.closeOverlay(); cur.st.over[e.id] = 'draft'; ctx.rerender(); ctx.toast(esc(e.id) + ' rejected and returned to draft. Owner notified.', 'warn'); }); } });
      });
      on('click', '[data-submitreview]', async () => {
        const ctx = cur.ctx; const e = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel);
        const ok = await ctx.confirm({ title: 'Submit ' + esc(e.id) + ' for review', tag: 'review', tone: 'info', body: '<p class="fg2" style="margin:0">Automated checks run first: schema, dependency scan and declared egress. A tool admin reviews after they finish.</p>', kv: [['Version', e.version], ['Owner', e.owner]], ok: 'Submit' });
        if (ok) { cur.st.over[e.id] = 'in review'; e.submitted = 'today, ' + e.owner; ctx.rerender(); ctx.toast(esc(e.id) + ' is in the review queue.', 'ok'); }
      });
      on('click', '[data-deprecate]', async () => {
        const ctx = cur.ctx; const e = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel);
        const ok = await ctx.confirm({ title: 'Deprecate ' + esc(e.id), tag: 'deprecated', tone: 'warn', body: '<p class="fg2" style="margin:0">Deprecated entries stay callable. Every run that uses one shows a warning in run details with a link to the replacement.</p>' + UI.field('Replacement', UI.input(e.replacement || e.id.split(' ')[0] + ' ' + (parseInt(e.version, 10) + 1) + '.0')), kv: [['Used by', e.kind === 'tool' ? '3 agents, 2 workflows' : '1 workspace'], ['Callable until retired', 'yes']], ok: 'Deprecate' });
        if (ok) { cur.st.over[e.id] = 'deprecated'; ctx.rerender(); ctx.toast(esc(e.id) + ' deprecated. Runs now show a warning.', 'warn'); }
      });
      on('click', '[data-retire]', async () => {
        const ctx = cur.ctx; const e = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel);
        const ok = await ctx.confirm({ title: 'Retire ' + esc(e.id), tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">Retiring removes the entry from routing. Agents and workflows that still reference it fail with a typed error. The entry stays resolvable for audit.</p>', kv: [['Still referenced by', '1 workflow: quarterly-variance v1'], ['Audit', 'kept']], ok: 'Retire' });
        if (ok) { cur.st.over[e.id] = 'retired'; ctx.rerender(); ctx.toast(esc(e.id) + ' retired. quarterly-variance v1 will fail its next run.', 'danger', 5000); }
      });
      on('click', '[data-restore]', () => { const e = find(cur.st.sel); cur.st.over[e.id] = 'published'; cur.ctx.rerender(); cur.ctx.toast(esc(e.id) + ' restored to published.', 'ok'); });
      on('click', '[data-publishmore]', () => publishScope(cur.ctx, find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel)));
      on('click', '[data-editentry]', () => cur.ctx.toast('Drafts are edited in their source: script, OpenAPI document or MCP server. The registry only records the entry.'));
      on('click', '[data-submit]', () => submitEntry(cur.ctx));
    }
  });

  function runHarness(ctx) {
    const st = ctx.state; const e = find(st.sel) || st.added.find((x) => x.id === st.sel);
    st.harnessOpen = true;
    const steps = [['Starting sandbox', 15], ['Validating arguments with ajv', 35], ['Cedar authorisation', 50], ['Calling ' + e.id, 80], ['Classifying output', 95]];
    let i = 0;
    st.harness = { phase: 'running', step: steps[0][0], pct: steps[0][1] };
    ctx.rerender();
    const tick = () => {
      i++;
      if (i < steps.length) { st.harness = { phase: 'running', step: steps[i][0], pct: steps[i][1] }; ctx.rerender(); st.htimer = setTimeout(tick, 420); return; }
      const result = e.id === 'ledger.query' ? 'cost_centre, q3_actual, q3_budget\nFIELD-SALES, 188420.00, 150000.00\nrows: 1, elapsed: 212 ms' : e.id === 'mail.send_internal' ? '{ "accepted": true, "message_id": "<9f1c@mail-relay>", "relay": "mail-relay.northwind.internal" }' : e.kind === 'tool' ? '{ "hits": 3, "top": "Travel policy 2026, section 4.2", "score": 0.83 }' : '{ "ok": true, "steps": 4, "tokens": 1204 }';
      st.harness = { phase: 'done', valid: true, result };
      st.lastHarness = { id: e.id, when: 'just now, sandbox run 1.8 s' };
      ctx.rerender();
      ctx.toast('Harness run finished. Typed result labelled ' + esc(e.label) + '.', 'ok');
    };
    clearTimeout(st.htimer); st.htimer = setTimeout(tick, 420);
  }

  function publishScope(ctx, e) {
    const scopes = [['Northwind tenant', 'all workspaces', true], ['Finance Ops', 'Northwind', true], ['People Ops', 'Northwind', false], ['Field Sales', 'Northwind', false], ['Platform lab', 'Contoso tenant', false]];
    ctx.modal({
      title: 'Publish ' + esc(e.id) + ' ' + UI.pill(e.version, 'outline'),
      body: '<p class="fg2" style="margin:0">Choose which tenants or workspaces receive the entry. Workspace admins then enable it for their members; nothing is enabled automatically.</p>'
        + '<div class="vstack gap6">' + scopes.map((s, i) => '<div class="hstack">' + UI.check(s[0], s[2], 'data-scope="' + i + '"') + '<span class="muted grow" style="font-size:12px">' + s[1] + '</span>' + (i === 4 ? UI.label('public', { sm: true }) : UI.label(i === 1 ? 'confidential' : 'internal', { sm: true })) + '</div>').join('') + '</div>'
        + (e.label === 'confidential' ? UI.notice('Platform lab has ceiling <b>public</b>, below this entry\'s max label. It is listed but cannot be selected.', 'warn') : '')
        + UI.kv([['Status after publish', UI.pill('published', 'ok')], ['Schema hash recorded', '<span class="mono">' + esc(e.hash) + '</span>']], 2),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Publish', { kind: 'primary', attrs: 'data-ok' }),
      onMount(m) {
        const pl = m.querySelector('[data-scope="4"]'); if (pl && e.label === 'confidential') pl.disabled = true;
        m.querySelector('[data-ok]').addEventListener('click', () => { const n = Array.prototype.filter.call(m.querySelectorAll('[data-scope]'), (c) => c.checked).length; App.closeOverlay(); ctx.state.over[e.id] = 'published'; ctx.state.showEgress = false; ctx.rerender(); ctx.toast(esc(e.id) + ' ' + esc(e.version) + ' published to ' + n + ' scope' + (n === 1 ? '' : 's') + '. Workspace admins can now enable it.', 'ok', 5000); });
      }
    });
  }

  function submitEntry(ctx) {
    ctx.modal({
      title: 'Submit entry',
      body: '<div class="formgrid">' + UI.field('Kind', UI.select(['Tool', 'Skill', 'Agent'], 'Tool', 'data-kind')) + UI.field('Implemented as', UI.select(['Built-in TypeScript', 'OpenAPI operation', 'MCP server tool', 'Script-backed tool', 'Versioned archive', 'Agent definition'], 'OpenAPI operation'))
        + UI.field('Name', UI.input('', { placeholder: 'namespace.operation', attrs: 'data-name' })) + UI.field('Version', UI.input('0.1.0', { attrs: 'data-version' }))
        + UI.field('Side-effect class', UI.select(['read-only', 'write', 'destructive', 'external-comms'], 'write', 'data-side'), 'write, destructive and external-comms require user confirmation by default')
        + UI.field('Max label', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal', 'data-label'))
        + UI.field('Required scopes', UI.input('tools:invoke')) + UI.field('Allowed egress zones', UI.input('none', {}), 'Every observed destination must be declared here')
        + '<div class="span2">' + UI.field('Rate limit', UI.input('60 per user per hour')) + '</div></div>'
        + UI.notice('Submitting creates a <b>draft</b>. Automated checks run, then a tool admin reviews it. Nothing reaches a tenant before review.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save draft and run checks', { kind: 'primary', attrs: 'data-ok' }),
      cls: 'wide',
      onMount(m) {
        m.querySelector('[data-ok]').addEventListener('click', () => {
          const name = (m.querySelector('[data-name]').value || '').trim() || 'ledger.export'; const kind = m.querySelector('[data-kind]').value.toLowerCase(); const side = m.querySelector('[data-side]').value; const label = m.querySelector('[data-label]').value; const version = m.querySelector('[data-version]').value || '0.1.0';
          App.closeOverlay();
          const st = ctx.state; st.added = st.added || [];
          const entry = { id: name, kind, side: kind === 'tool' ? side : undefined, version, label, egress: 'none', status: 'draft', owner: 'Mara Okafor', scopes: 'tools:invoke', confirm: side === 'read-only' ? 'never' : 'always', rate: '60 per user per hour', secrets: 'none', hint: 'none', hash: Math.random().toString(16).slice(2, 10), impl: 'OpenAPI operation', contents: 'Instructions only', tools: 'none', profile: 'plan: chat-default at medium', skills: 'none', kbs: 'none', guard: 'Default baseline v9', limits: '12 steps, 6,000 tokens, 60 s, 4 tool calls', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', true]] };
          st.added.push(entry); st.sel = name; st.tab = kind === 'tool' ? 'tools' : kind + 's';
          ctx.rerender(); ctx.toast('Draft ' + esc(name) + ' ' + esc(version) + ' saved. Checks are running in the sandbox.', 'ok');
        });
      }
    });
  }
})();
