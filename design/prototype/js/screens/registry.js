(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  const TOOLS = [
    { id: 'kb.search', kind: 'tool', side: 'read-only', version: '2.3.0', label: 'confidential', egress: 'none', status: 'published', owner: 'Platform tools team', scopes: 'kb:read', confirm: 'never', rate: '600 per user per hour', secrets: 'none', hint: 'readOnlyHint: true (applied after review)', hash: 'a3f19c02', impl: 'Built-in TypeScript', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', true]] },
    { id: 'ledger.query', kind: 'tool', side: 'read-only', version: '1.1.2', label: 'confidential', egress: 'data', status: 'published', owner: 'Finance systems', scopes: 'ledger:read', confirm: 'never', rate: '120 per user per hour', secrets: 'ref: ledger-ro-dsn', hint: 'none (OpenAPI operation)', hash: '5c0e77b1', impl: 'OpenAPI operation, ledger-api v4', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', true]] },
    { id: 'jira-internal.create_issue', kind: 'tool', side: 'write', version: '1.0.4', label: 'confidential', egress: 'app-internal', status: 'published', owner: 'Platform tools team', scopes: 'tools:invoke, jira:write', confirm: 'always', rate: '30 per user per hour', secrets: 'per-user token vault', hint: 'destructiveHint: false (untrusted, class set at review)', hash: 'e2b84d10', impl: 'MCP server tool, jira-internal', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', true]] },
    { id: 'kb.delete_documents', kind: 'tool', side: 'destructive', version: '1.2.0', label: 'confidential', egress: 'none', status: 'published', owner: 'Platform tools team', scopes: 'kb:admin', confirm: 'always', rate: '10 per user per hour', secrets: 'none', hint: 'destructiveHint: true (applied after review)', hash: '91d0c4ee', impl: 'Built-in TypeScript', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', true]] },
    { id: 'mail.send_internal', kind: 'tool', side: 'external-comms', version: '0.9.0', label: 'internal', egress: 'mail-relay', status: 'in review', owner: 'Platform tools team', scopes: 'tools:invoke', confirm: 'always', rate: '20 per user per hour', secrets: 'ref: smtp-relay-cred', hint: 'openWorldHint: false (untrusted, not applied)', hash: '7fa2c913', impl: 'Built-in TypeScript', submitted: '18 Sep, Platform tools team', checks: [['Schema valid', true], ['Dependency scan clean', true], ['Declared egress matches observed', false]], egressNote: 'Observed a connection to ldap.northwind.internal that is not declared.' },
    { id: 'catalog.get_item', kind: 'tool', side: 'read-only', version: '1.0.0', label: 'internal', egress: 'public: api.partner.example', status: 'published', owner: 'Platform tools team', scopes: 'tools:invoke', confirm: 'never', rate: '120 per user per hour', secrets: 'vault:apis/catalog#token, resolved as the author', hint: 'none (HTTP tool)', hash: '0b7e2a91', impl: 'HTTP request', http: { method: 'GET', url: 'https://api.partner.example/v1/items/{id}', params: 'id (path, string)', headers: 'Authorization: Bearer vault:apis/catalog#token', pointer: '/data/name', timeout: '10 s', cap: '64 KB', calls: '212 in the last day, 1 failed, median 140 ms' }, checks: [['Schema valid', true], ['HTTP request', true], ['Secrets scan', true]] },
    { id: 'crm.update_contact', kind: 'tool', side: 'write', version: '0.2.0', label: 'confidential', egress: 'internal: crm.northwind.internal', status: 'draft', owner: 'Mara Okafor', scopes: 'tools:invoke', confirm: 'always', rate: '30 per user per hour', secrets: 'vault:apps/crm#token, resolved as the author', hint: 'none (HTTP tool)', hash: '6d40c2f8', impl: 'HTTP request', http: { method: 'PATCH', url: 'https://crm.northwind.internal/api/contacts/{contactId}', params: 'contactId (path, string); other arguments as the JSON body', headers: 'Authorization: Bearer vault:apps/crm#token', pointer: '/contact', timeout: '15 s', cap: '64 KB', calls: 'no calls yet' }, checks: [['Schema valid', true], ['HTTP request', true], ['Secrets scan', true]] },
    { id: 'report.generate (script)', kind: 'tool', side: 'write', version: '0.3.1', label: 'internal', egress: 'none', status: 'draft', owner: 'Mara Okafor', scopes: 'tools:invoke', confirm: 'always', rate: '60 per user per hour', secrets: 'none', hint: 'none (script-backed tool)', hash: 'c48b12a7', impl: 'Script-backed, monthly_variance.py', checks: [['Schema valid', true], ['Dependency scan clean', false], ['Declared egress matches observed', true]], egressNote: 'openpyxl 3.0.9 has a known advisory; the curated wheel set carries 3.1.5.' }
  ];
  const SKILLS = [
    { id: 'close-checklist', kind: 'skill', contents: 'Instructions, 2 reference files', version: '1.2.0', label: 'confidential', tools: 'feed.post', deps: ['variance-analysis'], status: 'published', owner: 'Finance systems', scopes: 'skills:load', confirm: 'not applicable', rate: 'not applicable', secrets: 'none', hint: 'none', hash: '0c5e91d2', impl: 'Versioned archive, manifest v1', checks: [['Manifest valid', true], ['Reference files scanned', true], ['Referenced tools published', true]] },
    { id: 'variance-analysis', kind: 'skill', contents: 'Instructions, 3 reference files, calc.table', version: '3.0.0', label: 'confidential', tools: 'ledger.query, calc.*', status: 'published', owner: 'Finance systems', scopes: 'skills:load', confirm: 'not applicable', rate: 'not applicable', secrets: 'none', hint: 'none', hash: '4d81f0aa', impl: 'Versioned archive, manifest v1', checks: [['Manifest valid', true], ['Reference files scanned', true], ['Referenced tools published', true]] },
    { id: 'contract-redline', kind: 'skill', contents: 'Instructions, 5 reference files', version: '2.1.0', label: 'internal', tools: 'kb.search', status: 'published', owner: 'Legal ops', scopes: 'skills:load', confirm: 'not applicable', rate: 'not applicable', secrets: 'none', hint: 'none', hash: 'b02e6c51', impl: 'Versioned archive, manifest v1', checks: [['Manifest valid', true], ['Reference files scanned', true], ['Referenced tools published', true]] },
    { id: 'meeting-notes', kind: 'skill', contents: 'Instructions, 1 reference file, imported MCP prompt', version: '1.0.0', label: 'internal', tools: 'kb.add_document', status: 'in review', owner: 'Knowledge team', scopes: 'skills:load', confirm: 'not applicable', rate: 'not applicable', secrets: 'none', hint: 'imported from MCP prompt report-tools/meeting-notes', hash: '6ea3d7f4', impl: 'Versioned archive, manifest v1', submitted: '19 Sep, Knowledge team', checks: [['Manifest valid', true], ['Reference files scanned', true], ['Referenced tools published', true]] },
    { id: 'travel-policy-lookup', kind: 'skill', contents: 'Instructions only', version: '0.2.0', label: 'internal', tools: 'kb.search', status: 'draft', owner: 'Mara Okafor', scopes: 'skills:load', confirm: 'not applicable', rate: 'not applicable', secrets: 'none', hint: 'none', hash: '19c7a8d3', impl: 'Versioned archive, manifest v1', checks: [['Manifest valid', true], ['Reference files scanned', true], ['Referenced tools published', true]] }
  ];
  const AGENTS = [
    { id: 'Close planner', kind: 'agent', profile: 'plan: analyst at medium', version: '1.0.0', label: 'confidential', tools: 'none', delegates: ['Close broker'], workflows: [], inputSchema: '', outputSchema: '', skills: 'none', kbs: 'Finance KB', guard: 'Finance baseline v12', limits: '20 steps, 20,000 tokens, 600 s, 8 tool calls', status: 'published', owner: 'Finance systems', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '20 runs per user per day', secrets: 'none held; RFC 8693 token exchange per run', hint: 'none', hash: '3a61f0c8', impl: 'Agent definition v2', checks: [['Definition valid', true], ['All tools and skills published', true], ['Limits within workspace policy', true]] },
    { id: 'Close broker', kind: 'agent', profile: 'plan: analyst at medium', version: '1.0.0', label: 'confidential', tools: 'none', delegates: ['Clerk'], workflows: ['quarterly-variance'], inputSchema: '{ "type": "object", "properties": { "task": { "type": "string" } }, "required": ["task"] }', outputSchema: '{ "type": "object", "properties": { "posted": { "type": "boolean" }, "variance": { "type": "string" } }, "required": ["posted"] }', skills: 'none', kbs: 'none', guard: 'Finance baseline v12', limits: '18 steps, 18,000 tokens, 600 s, 6 tool calls', status: 'published', owner: 'Finance systems', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '40 runs per user per day', secrets: 'none held', hint: 'none', hash: '7b0d2e95', impl: 'Agent definition v2', checks: [['Definition valid', true], ['All tools and skills published', true], ['Limits within workspace policy', true], ['Schema valid', true]] },
    { id: 'Clerk', kind: 'agent', profile: 'plan: general-8b at low', version: '1.0.0', label: 'confidential', tools: 'feed.post, ledger.query', delegates: [], workflows: [], inputSchema: '', outputSchema: '', skills: 'close-checklist v1.2', kbs: 'none', guard: 'Finance baseline v12', limits: '14 steps, 14,000 tokens, 600 s, 4 tool calls', status: 'published', owner: 'Finance systems', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '40 runs per user per day', secrets: 'none held', hint: 'none', hash: '5f19c3a0', impl: 'Agent definition v2', checks: [['Definition valid', true], ['All tools and skills published', true], ['Limits within workspace policy', true]] },
    { id: 'Data analyst', kind: 'agent', profile: 'plan: analyst at high, tool selection: general-8b at low', version: '4.2.0', label: 'confidential', tools: 'kb.search, ledger.query, calc.*, jira-internal.create_issue', skills: 'variance-analysis v3', kbs: 'Finance KB, Travel policy', guard: 'Finance baseline v12', limits: '20 steps, 10,000 tokens, 120 s, 8 tool calls', status: 'published', owner: 'Finance systems', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '40 runs per user per day', secrets: 'none held; RFC 8693 token exchange per run', hint: 'none', hash: 'd7a10b3e', impl: 'Agent definition v2', checks: [['Definition valid', true], ['All tools and skills published', true], ['Limits within workspace policy', true]] },
    { id: 'Meeting notes', kind: 'agent', profile: 'plan: analyst at medium, captions: vision at low', version: '1.0.0', label: 'internal', tools: 'kb.add_document, calc.table', skills: 'meeting-notes v1', kbs: 'Team notes', guard: 'Default baseline v9', limits: '30 steps, 60,000 tokens, 600 s, 12 tool calls', status: 'in review', owner: 'Knowledge team', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '20 runs per user per day', secrets: 'none held; RFC 8693 token exchange per run', hint: 'none', hash: '2f9e5c60', impl: 'Agent definition v2', submitted: '19 Sep, Knowledge team', checks: [['Definition valid', true], ['All tools and skills published', false], ['Limits within workspace policy', true]], egressNote: 'Skill meeting-notes v1 is still in review. Publish the skill first or remove it.' },
    { id: 'Support triage', kind: 'agent', profile: 'plan: chat-default at medium', version: '0.4.0', label: 'internal', tools: 'kb.search, jira-internal.create_issue', delegates: ['Meeting notes'], workflows: [], inputSchema: '', outputSchema: '', skills: 'none', kbs: 'Policy KB', guard: 'Default baseline v9', limits: '12 steps, 6,000 tokens, 60 s, 4 tool calls', status: 'draft', owner: 'People Ops', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '100 runs per user per day', secrets: 'none held', hint: 'none', hash: '8b3c41f9', impl: 'Agent definition v2', checks: [['Definition valid', true], ['All tools and skills published', true], ['Limits within workspace policy', true]] },
    { id: 'Code reviewer', kind: 'agent', profile: 'plan: coder at medium', version: '2.0.1', label: 'internal', tools: 'gitlab-onprem.get_merge_request', skills: 'none', kbs: 'Engineering wiki', guard: 'Default baseline v9', limits: '16 steps, 20,000 tokens, 180 s, 6 tool calls', status: 'deprecated', replacement: 'Code reviewer 3.0', owner: 'Platform lab', scopes: 'agents:run, tools:invoke', confirm: 'by side-effect class', rate: '40 runs per user per day', secrets: 'none held', hint: 'none', hash: 'e51a9d27', impl: 'Agent definition v2', checks: [['Definition valid', true], ['All tools and skills published', true], ['Limits within workspace policy', true]] }
  ];
  const ALL = TOOLS.concat(SKILLS, AGENTS);
  // GET /api/admin/registry/:id/used-by: what references an entry, how (via) and whether it may reach it now (live).
  const U = (kind, name, version, status, via, live) => ({ kind, name, version, status, via, live });
  const USED_BY = {
    'variance-analysis': [U('skill', 'close-checklist', '1.2.0', 'published', 'sub-skill', true), U('agent', 'Data analyst', '4.2.0', 'published', 'skill', true), U('workflow', 'video-to-notes', 'v2', 'published', 'model-skill', true)],
    'close-checklist': [U('agent', 'Clerk', '1.0.0', 'published', 'skill', true)],
    'ledger.query': [U('agent', 'Data analyst', '4.2.0', 'published', 'tool', true), U('agent', 'Clerk', '1.0.0', 'published', 'tool', true), U('skill', 'variance-analysis', '3.0.0', 'published', 'skill-tool', true), U('workflow', 'quarterly-variance', 'v1', 'published', 'tool-step', true)],
    'jira-internal.create_issue': [U('agent', 'Data analyst', '4.2.0', 'published', 'tool', true), U('agent', 'Support triage', '0.4.0', 'draft', 'tool', false), U('workflow', 'vendor-onboarding-review', 'v1', 'published', 'tool-step', true)],
    'kb.search': [U('agent', 'Data analyst', '4.2.0', 'published', 'tool', true), U('agent', 'Support triage', '0.4.0', 'draft', 'tool', false), U('skill', 'contract-redline', '2.1.0', 'published', 'skill-tool', true)],
    'Clerk': [U('agent', 'Close broker', '1.0.0', 'published', 'delegate', true)],
    'Close broker': [U('agent', 'Close planner', '1.0.0', 'published', 'delegate', true)],
    'Meeting notes': [U('agent', 'Support triage', '0.4.0', 'draft', 'delegate', false), U('workflow', 'video-to-notes', 'v3 draft', 'draft', 'agent-step', false)],
    'meeting-notes': [U('agent', 'Meeting notes', '1.0.0', 'in review', 'skill', false), U('workflow', 'video-to-notes', 'v3 draft', 'draft', 'model-skill', false)]
  };
  const OTHER_VERSIONS = { 'Code reviewer': [{ version: '3.0.0', status: 'published' }], 'variance-analysis': [{ version: '2.4.0', status: 'retired' }] };
  const VIA_TEXT = { delegate: 'delegates to it', workflow: 'lists it as a workflow', tool: 'calls it as a tool', skill: 'loads it as a skill', 'sub-skill': 'builds on it', 'skill-tool': 'needs it as a skill tool', 'sub-workflow': 'runs it as a sub-workflow', 'agent-step': 'runs it in an agent step', 'model-skill': 'loads it in a model step', 'tool-step': 'calls it in a tool step', 'workflow-tool': 'is its workflow tool' };
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
      { title: 'Retire refused: still in use', tone: 'danger', text: 'Retiring the last callable version of a skill a published agent uses is refused, naming the agent. The used-by view lists every referrer and how it reaches the entry.', apply(ctx) { const st = ctx.state; st.over = st.over || {}; st.over['close-checklist'] = 'deprecated'; st.tab = 'skills'; st.sel = 'close-checklist'; st.retireRefused = true; ctx.rerender(); usedByModal(ctx, find('close-checklist'), 'retire'); } },
      { title: 'Chain reference not published', tone: 'danger', text: 'Support triage delegates to Meeting notes, which is still in review. The Chain references check fails and Approve stays disabled until the delegate is published or removed.', apply(ctx) { const st = ctx.state; st.tab = 'agents'; st.sel = 'Support triage'; ctx.rerender(); } },
      { title: 'Test harness', tone: 'info', text: 'Runs the tool in the sandbox with sample arguments and shows the typed result and label.', apply(ctx) { ctx.state.tab = 'tools'; ctx.state.sel = 'ledger.query'; ctx.state.harnessOpen = true; ctx.rerender(); runHarness(ctx); } },
      { title: 'HTTP host refused', tone: 'danger', text: 'A test call to a host that resolves to a cloud metadata address, an internal host the operator has not named, or a public host off the tenant\'s list is refused before anything is sent.', apply(ctx) { ctx.state.tab = 'tools'; ctx.rerender(); httpForm(ctx, { url: 'http://169.254.169.254/latest/meta-data/{path}', test: 'refused' }); } },
      { title: 'Literal credential refused', tone: 'danger', text: 'Saving an HTTP tool with a literal Authorization header, API key query parameter or secret body field is refused: credentials go in as vault references, resolved at call time.', apply(ctx) { ctx.state.tab = 'tools'; ctx.rerender(); httpForm(ctx, { header: 'Bearer 9f3ab21c7d4e5f6a', literal: true }); } }
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
      st.edits = st.edits || {};
      const ed = (e) => Object.assign({}, e, st.edits[e.id] || {});
      const chainProblems = (e0) => {
        const e = ed(e0); const out = [];
        const stOf = (id) => { const x = entries.find((y) => y.id === id); return x ? status(x) : null; };
        const LBL = ['public', 'internal', 'confidential', 'restricted'];
        (e.delegates || []).forEach((d) => { const s2 = stOf(d); const x = entries.find((y) => y.id === d); if (s2 !== 'published' && s2 !== 'deprecated') out.push('Delegate ' + d + (s2 ? ' is ' + s2 + ', not published.' : ' is not in the registry.')); else if (x && LBL.indexOf(x.label) > LBL.indexOf(e.label)) out.push('Delegate ' + d + ' carries ' + x.label + ', above this agent\'s ceiling.'); if (d === e.id) out.push('The agent delegates to itself.'); });
        (e.workflows || []).forEach((w) => { if (['quarterly-variance', 'vendor-onboarding-review', 'video-to-notes'].indexOf(w) < 0) out.push('Workflow ' + w + ' has no published version in Finance Ops.'); });
        (e.deps || []).forEach((d) => { const s2 = stOf(d); if (s2 !== 'published' && s2 !== 'deprecated') out.push('Skill ' + d + (s2 ? ' is ' + s2 + ', not published.' : ' is not in the registry.')); });
        return out;
      };
      const checksFor = (e) => { const base = e.checks.map((c) => { const ok = c[1] || (e.id === 'mail.send_internal' && c[0].startsWith('Declared egress') && st.egressFixed); return [c[0], ok]; }); return e.kind === 'tool' ? base : base.concat([['Chain references', !chainProblems(e).length]]); };
      const checks = checksFor(sel);
      const checksOk = checks.every((c) => c[1]);

      const rowAttrs = (e) => 'data-entry="' + esc(e.id) + '"';
      let table;
      if (st.tab === 'tools') table = UI.table(['Tool', 'Side effect', 'Version', 'Max label', 'Egress', 'Status'], tools.map((e) => ({ cells: ['<span style="font-weight:600">' + esc(e.id) + '</span>', sidePill(e.side), '<span class="mono">' + esc(e.version) + '</span>', UI.label(e.label, { sm: true }), esc(e.egress), statusPill(status(e))], attrs: rowAttrs(e), selected: e.id === sel.id })), { emptyTitle: 'No tools match', emptyText: 'Clear the search or the status filter.' });
      else if (st.tab === 'skills') table = UI.table(['Skill', 'Contents', 'Version', 'Max label', 'Tools', 'Status'], skills.map((e) => ({ cells: ['<span style="font-weight:600">' + esc(e.id) + '</span>', esc(e.contents), '<span class="mono">' + esc(e.version) + '</span>', UI.label(e.label, { sm: true }), '<span class="mono">' + esc(e.tools) + '</span>', statusPill(status(e))], attrs: rowAttrs(e), selected: e.id === sel.id })), { emptyTitle: 'No skills match', emptyText: 'Clear the search or the status filter.' });
      else if (st.tab === 'agents') table = UI.table(['Agent', 'Profile per step', 'Tools', 'Version', 'Max label', 'Status'], agents.map((e) => ({ cells: ['<span style="font-weight:600">' + esc(e.id) + '</span>', esc(e.profile), '<span class="mono" style="white-space:normal">' + esc(e.tools) + '</span>', '<span class="mono">' + esc(e.version) + '</span>', UI.label(e.label, { sm: true }), statusPill(status(e))], attrs: rowAttrs(e), selected: e.id === sel.id })), { emptyTitle: 'No agents match', emptyText: 'Clear the search or the status filter.' });
      else table = UI.table(['Entry', 'Kind', 'Submitted', 'Automated checks', 'Waiting', 'Status'], review.map((e) => { const c = checksFor(e); const bad = c.filter((x) => !x[1]).length; return { cells: ['<span style="font-weight:600">' + esc(e.id) + '</span>', esc(e.kind), esc(e.submitted || 'today, ' + e.owner), bad ? UI.pill(bad + ' failing', 'danger') : UI.pill('all passed', 'ok'), e.submitted && e.submitted.startsWith('18') ? '2 days' : '1 day', statusPill(status(e))], attrs: rowAttrs(e), selected: e.id === sel.id }; }), { emptyTitle: 'The review queue is empty', emptyText: 'Submitted entries appear here after their automated checks finish.' });

      const agentCard = (a0) => { const a = ed(a0); return UI.panel('Agent: ' + a.id, UI.kv([['Profile per step', esc(a.profile)], ['Tools', esc(a.tools)], ['Delegates', esc((a.delegates || []).map((d) => 'agent:' + d).join(', ') || 'none')], ['Workflows', esc((a.workflows || []).map((w) => 'workflow:' + w).join(', ') || 'none')], ['Typed answer', a.outputSchema ? 'output schema set; delegating agents get the parsed object' : 'text'], ['Skills', esc(a.skills)], ['Knowledge bases', esc(a.kbs)], ['Guardrail profile', '<a href="#" data-goguard>' + esc(a.guard) + '</a>'], ['Limits', esc(a.limits)]], 3), { actions: UI.btn('Open in chat', { size: 'sm', attrs: 'data-gochat="' + esc(a.id) + '"' }) + UI.btn('Profile', { size: 'sm', kind: 'ghost', attrs: 'data-goprofile' }) }); };
      const agentShown = st.tab === 'agents' && sel.kind === 'agent' ? sel : st.tab === 'review' ? null : AGENTS.find((a) => a.id === 'Data analyst');

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
        + UI.kv([['Owner', esc(sel.owner)], ['Version', '<span class="mono">' + esc(sel.version) + '</span> <span class="muted">' + esc(selStatus) + '</span>'], ['Schema hash', '<span class="mono">' + esc(sel.hash) + '</span> ' + UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copy="' + esc(sel.hash) + '"' })], ['Implemented as', esc(sel.impl)], ['Required scopes', '<span class="mono">' + esc(sel.scopes) + '</span>'], ['Ceiling label', UI.label(sel.label, { sm: true })], ['Confirmation required', esc(sel.confirm) + (sel.side && sel.side !== 'read-only' ? ' <span class="muted">(' + esc(sel.side) + ' class)</span>' : '')], ['Rate limit', esc(sel.rate)], ['Secrets', '<span class="mono">' + esc(sel.secrets) + '</span>'], ['MCP hint', esc(sel.hint)]].concat(sel.http ? [['Request', '<span class="mono" style="overflow-wrap:anywhere">' + esc(sel.http.method + ' ' + sel.http.url) + '</span>'], ['Parameters', esc(sel.http.params)], ['Headers', '<span class="mono" style="overflow-wrap:anywhere">' + esc(sel.http.headers) + '</span>'], ['Response', esc('JSON pointer ' + sel.http.pointer + ', at most ' + sel.http.cap + ', ' + sel.http.timeout + ' timeout')], ['Calls', esc(sel.http.calls)], ['Outbound guard', 'resolved once, every address checked, connection pinned, redirects not followed']] : []).concat(chainRows(ed(sel))).concat([['Used by', usedByText(sel) + ' ' + UI.btn('Used by', { kind: 'ghost', size: 'xs', attrs: 'data-usedby' })]]), 1)
        + '<div class="hstack"><div class="eyebrow grow">Automated checks</div>' + UI.btn('Re-run', { kind: 'ghost', size: 'xs', icon: 'refresh', attrs: 'data-recheck' }) + '</div>'
        + '<div class="vstack gap4">' + checks.map((c) => '<div class="hstack" style="color:var(--' + (c[1] ? 'ok-fg' : 'danger-fg') + ')">' + UI.icon(c[1] ? 'check' : 'x', 14) + '<span style="color:var(--fg)">' + esc(c[0]) + '</span></div>').join('')
        + (!checksOk && sel.egressNote ? '<div style="font-size:12px;color:var(--danger-fg)">' + esc(sel.egressNote) + '</div>' : '') + (sel.kind !== 'tool' ? chainProblems(sel).map((x) => '<div style="font-size:12px;color:var(--danger-fg)">' + esc(x) + '</div>').join('') : '') + '</div>'
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
        + '<div class="page registry-page">' + UI.pagehead('Registry', 'Nothing reaches a tenant before review', UI.btn('Allowed hosts', { attrs: 'data-hosts' }) + UI.btn('Open test harness', { attrs: 'data-harness-open' }) + UI.btn('New HTTP tool', { attrs: 'data-newhttp' }) + UI.btn('Submit entry', { kind: 'primary', attrs: 'data-submit' }))
        + (st.showEgress && !st.egressFixed ? UI.notice('<b>Undeclared egress.</b> mail.send_internal opened a connection to <span class="mono">ldap.northwind.internal</span> during checks. Approve stays disabled until the owner declares or removes the destination.', 'danger', UI.btn('Declare destination', { size: 'sm', attrs: 'data-declare' })) : '')
        + UI.tabs([{ id: 'tools', label: 'Tools', count: entries.filter((e) => e.kind === 'tool').length }, { id: 'skills', label: 'Skills', count: entries.filter((e) => e.kind === 'skill').length }, { id: 'agents', label: 'Agents', count: entries.filter((e) => e.kind === 'agent').length }, { id: 'review', label: 'Review queue', count: review.length }], st.tab)
        + '<div class="toolbar">' + UI.search('Search by name, owner or tool', 'data-search', st.query) + UI.seg([{ id: 'all', label: 'All' }].concat(VERSIONS.map((v) => ({ id: v, label: v }))), st.filter, 'data-statusseg') + '<span class="muted right" style="font-size:12px">Lifecycle: draft, in review, published, deprecated, retired</span></div>'
        + (st.tab === 'review' ? UI.notice('Entries wait here after automated checks (schema, dependency scan, declared egress). A tool admin approves and picks the publish scope; workspace admins then enable entries for members.', 'info') : '')
        + table
        + (agentShown ? agentCard(agentShown) : '')
        + '</div>'
        + inspector;

      if (st.openSubmit) { st.openSubmit = false; setTimeout(() => submitEntry(ctx), 30); }
      if (bound) return; bound = true;

      // ---- events (bound once; read cur.ctx / cur.st) ----
      const on = ctx.on;
      on('click', '[data-tab]', (e, t) => { cur.st.tab = t.dataset.tab; cur.ctx.rerender(); });
      on('click', '[data-statusseg] [data-seg]', (e, t) => { cur.st.filter = t.dataset.seg; cur.ctx.rerender(); });
      on('input', '[data-search]', (e, t) => { cur.st.query = t.value; const v = t.value; cur.ctx.rerender(); const i = cur.ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      on('click', 'tr.row[data-entry]', (e, t) => { cur.st.sel = t.dataset.entry; cur.st.harness = null; cur.ctx.rerender(); });
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
      on('click', '[data-deprecate]', () => { const e = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel); usedByModal(cur.ctx, e, 'deprecate'); });
      on('click', '[data-retire]', () => { const e = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel); usedByModal(cur.ctx, e, 'retire'); });
      on('click', '[data-usedby]', () => { const e = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel); usedByModal(cur.ctx, e, 'view'); });
      on('click', '[data-restore]', () => { const e = find(cur.st.sel); cur.st.over[e.id] = 'published'; cur.ctx.rerender(); cur.ctx.toast(esc(e.id) + ' restored to published.', 'ok'); });
      on('click', '[data-publishmore]', () => publishScope(cur.ctx, find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel)));
      on('click', '[data-editentry]', () => { const e = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel); if (e.kind === 'tool') cur.ctx.toast('Tool drafts are edited in their source: script, OpenAPI document or MCP server. The registry only records the entry.'); else editChain(cur.ctx, e); });
      on('click', '[data-submit]', () => submitEntry(cur.ctx));
      on('click', '[data-newhttp]', () => httpForm(cur.ctx, {}));
      on('click', '[data-hosts]', () => hostsDrawer(cur.ctx));
      on('click', '[data-entrylink]', (e, t) => { e.preventDefault(); const x = find(t.dataset.entrylink); if (!x) return; cur.st.sel = x.id; cur.st.tab = x.kind === 'tool' ? 'tools' : x.kind + 's'; cur.ctx.rerender(); });
      on('click', '[data-gowf]', (e, t) => { e.preventDefault(); cur.ctx.navigate('workflows', { wf: t.dataset.gowf }); });
    }
  });

  /** Inspector rows for the chain fields (Sprint 34): an agent's delegates, workflows and schemas, a skill's dependencies. */
  function chainRows(e) {
    if (e.kind === 'agent') return [['Delegates', (e.delegates || []).length ? (e.delegates || []).map((d) => '<a href="#" data-entrylink="' + esc(d) + '" class="mono">agent:' + esc(d) + '</a>').join(', ') : 'none'], ['Workflows', (e.workflows || []).length ? (e.workflows || []).map((w) => '<a href="#" data-gowf="' + esc(w) + '" class="mono">workflow:' + esc(w) + '</a>').join(', ') : 'none'], ['Input schema', e.inputSchema ? '<span class="mono">' + esc(e.inputSchema) + '</span>' : '<span class="muted">none: delegates send {task: string}</span>'], ['Output schema', e.outputSchema ? '<span class="mono">' + esc(e.outputSchema) + '</span>' : '<span class="muted">none: the answer is text</span>']];
    if (e.kind === 'skill') { const closure = []; const walk = (id) => { const x = ALL.find((y) => y.id === id); if (!x || closure.indexOf(id) >= 0) return; (x.deps || []).forEach(walk); closure.push(id); }; walk(e.id); return [['Builds on', (e.deps || []).length ? (e.deps || []).map((d) => '<a href="#" data-entrylink="' + esc(d) + '" class="mono">' + esc(d) + '</a>').join(', ') : 'none'], ['Loads', esc(closure.join(', ')) + ' <span class="muted">(dependencies first, each once)</span>']]; }
    return [];
  }
  function usedByOf(e) {
    const list = USED_BY[e.id] || [];
    const other = (OTHER_VERSIONS[e.id] || []).filter((v) => v.status === 'published' || v.status === 'deprecated');
    return { list, other: OTHER_VERSIONS[e.id] || [], retireBlocked: !other.length && list.some((u) => u.live) };
  }
  function usedByText(e) { const u = usedByOf(e).list; const live = u.filter((x) => x.live).length; return u.length ? esc(u.length + ' referrer' + (u.length === 1 ? '' : 's') + ', ' + live + ' live') : 'nothing yet'; }

  /** The used-by view (GET /api/admin/registry/:id/used-by) before deprecating or retiring, or on its own. */
  function usedByModal(ctx, e, mode) {
    const st = ctx.state; const u = usedByOf(e); const live = u.list.filter((x) => x.live);
    const names = live.map((x) => x.kind + ' ' + x.name + ' ' + x.version).join('; ');
    const table = UI.table(['Kind', 'Name', 'Version', 'Status', 'How it references ' + e.id, 'Live'], u.list.map((x) => [esc(x.kind), '<b>' + esc(x.name) + '</b>', '<span class="mono">' + esc(x.version) + '</span>', UI.pill(x.status), esc(VIA_TEXT[x.via] || x.via) + ' <span class="muted mono">' + esc(x.via) + '</span>', x.live ? UI.pill('live', 'warn') : UI.pill('not live', 'outline')]), { clickable: false, minWidth: '640px', emptyTitle: 'Nothing references ' + e.id, emptyText: 'No agent, skill or workflow in this tenant names it.' });
    const versions = u.other.length ? '<div class="muted" style="font-size:12px">Other versions: ' + u.other.map((v) => esc(v.version + ' ' + v.status)).join(', ') + '</div>' : '<div class="muted" style="font-size:12px">No other version of ' + esc(e.id) + ' is published or deprecated.</div>';
    const blocked = mode === 'retire' && u.retireBlocked;
    const note = mode === 'retire' ? (blocked ? UI.notice('<b>Retire refused (409 Still in use).</b> ' + esc(e.id) + ' is used by ' + esc(names) + '. Publish another version, or remove it from them first.', 'danger') : UI.notice('Retiring removes ' + esc(e.id) + ' ' + esc(e.version) + ' from routing. ' + (live.length ? 'Live referrers reach another published version.' : 'Nothing live reaches it.') + ' The entry stays resolvable for audit.', 'warn'))
      : mode === 'deprecate' ? UI.notice('Deprecated entries stay callable. ' + (live.length ? esc(live.length) + ' live referrer' + (live.length === 1 ? '' : 's') + ' keep working and show a warning in run details with the replacement.' : 'Nothing live references it.'), 'warn') + UI.field('Replacement', UI.input(e.replacement || e.id.split(' ')[0] + ' ' + (parseInt(e.version, 10) + 1) + '.0', { attrs: 'data-repl' }))
        : UI.notice('Built from the reference graph across agents, skills, tools and published workflow versions. Drafts are listed but not live.', 'info');
    ctx.modal({ cls: 'wide', title: (mode === 'retire' ? 'Retire ' : mode === 'deprecate' ? 'Deprecate ' : 'Used by: ') + esc(e.id) + ' ' + UI.pill(e.version, 'outline'), body: note + table + versions,
      actions: UI.btn(mode === 'view' ? 'Close' : 'Cancel', { attrs: 'data-close' }) + (mode === 'retire' ? UI.btn('Retire', { kind: 'danger', attrs: 'data-ok', disabled: blocked, title: blocked ? 'Refused while a live entry uses the last callable version' : '' }) : mode === 'deprecate' ? UI.btn('Deprecate', { kind: 'primary', attrs: 'data-ok' }) : ''),
      onMount(m) {
        const ok = m.querySelector('[data-ok]'); if (!ok) return;
        ok.addEventListener('click', () => { App.closeOverlay(); st.over = st.over || {}; if (mode === 'retire') { st.over[e.id] = 'retired'; ctx.rerender(); ctx.toast(esc(e.id) + ' retired. It stays resolvable for audit.', 'danger', 5000); } else { st.over[e.id] = 'deprecated'; ctx.rerender(); ctx.toast(esc(e.id) + ' deprecated. Runs now show a warning.', 'warn'); } });
      } });
  }

  /** Editing an agent's or skill's chain fields in its draft (PATCH /api/admin/registry/:id). */
  function editChain(ctx, e) {
    const st = ctx.state; const cur0 = Object.assign({}, e, (st.edits || {})[e.id] || {});
    const agents = ALL.filter((x) => x.kind === 'agent' && x.id !== e.id).map((x) => x.id);
    const skills = ALL.filter((x) => x.kind === 'skill' && x.id !== e.id).map((x) => x.id);
    const body = e.kind === 'agent'
      ? '<div class="formgrid">' + UI.field('Delegates (agents it may call)', UI.input((cur0.delegates || []).join(', '), { attrs: 'data-delegates list="registry-agents"', placeholder: 'Close broker, Clerk' }), 'Each is offered as the tool agent:<name> and runs as a child run in the chain, within this run\'s remaining budget') + UI.field('Workflows (it may start and await)', UI.input((cur0.workflows || []).join(', '), { attrs: 'data-workflows', placeholder: 'quarterly-variance' }), 'Offered as workflow:<name>; no need to publish them as tools')
        + '<div class="span2">' + UI.field('Input schema (JSON Schema, optional)', UI.textarea(cur0.inputSchema || '', { rows: 3, attrs: 'data-inschema', placeholder: '{ "type": "object", "properties": { "task": { "type": "string" } } }' }), 'What a delegating agent sends; without one it sends {task: string}') + UI.field('Output schema (JSON Schema, optional)', UI.textarea(cur0.outputSchema || '', { rows: 3, attrs: 'data-outschema' }), 'The answer is parsed as JSON and checked against it; a delegating agent gets the object') + '</div></div>'
        + '<datalist id="registry-agents">' + agents.map((a) => '<option value="' + esc(a) + '">').join('') + '</datalist>'
      : UI.field('Skills it builds on', UI.input((cur0.deps || []).join(', '), { attrs: 'data-deps list="registry-skills"', placeholder: 'variance-analysis' }), 'Loading this skill loads them first, each once, and offers the tools of the whole closure') + '<datalist id="registry-skills">' + skills.map((a) => '<option value="' + esc(a) + '">').join('') + '</datalist>';
    ctx.modal({ cls: 'wide', title: 'Edit draft ' + esc(e.id) + ' ' + esc(e.version), body: body + UI.notice('Saving re-runs the automated checks, Chain references among them: every delegate, skill and workflow published, none above this entry\'s ceiling, and no cycle that cannot end.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save and re-run checks', { kind: 'primary', attrs: 'data-ok' }), onMount(m) {
      m.querySelector('[data-ok]').addEventListener('click', () => {
        const list = (sel) => { const x = m.querySelector(sel); return x ? x.value.split(',').map((v) => v.trim()).filter(Boolean) : []; };
        const txt = (sel) => { const x = m.querySelector(sel); return x ? x.value.trim() : ''; };
        for (const k of ['[data-inschema]', '[data-outschema]']) { const v = txt(k); if (v) { try { JSON.parse(v); } catch (err) { ctx.toast('A schema is not valid JSON: ' + esc(err.message), 'danger'); return; } } }
        App.closeOverlay(); st.edits = st.edits || {};
        st.edits[e.id] = e.kind === 'agent' ? { delegates: list('[data-delegates]'), workflows: list('[data-workflows]'), inputSchema: txt('[data-inschema]'), outputSchema: txt('[data-outschema]') } : { deps: list('[data-deps]') };
        ctx.rerender(); ctx.toast('Draft ' + esc(e.id) + ' saved. Checks re-ran.', 'ok');
      });
    } });
  }

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
      const result = e.http ? '"Widget"\n(GET api.partner.example answered 200 in 140 ms; /data/name of 1.2 KB; reached the model as untrusted content, source http)' : e.id === 'ledger.query' ? 'cost_centre, q3_actual, q3_budget\nFIELD-SALES, 188420.00, 150000.00\nrows: 1, elapsed: 212 ms' : e.id === 'mail.send_internal' ? '{ "accepted": true, "message_id": "<9f1c@mail-relay>", "relay": "mail-relay.northwind.internal" }' : e.kind === 'tool' ? '{ "hits": 3, "top": "Travel policy 2026, section 4.2", "score": 0.83 }' : '{ "ok": true, "steps": 4, "tokens": 1204 }';
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

  // B-8904: the tenant's list of allowed hosts (GET and PUT /api/admin/integrations/hosts).
  const HOSTS = ['api.partner.example', '*.stripe.com', '203.0.113.0/24'];
  function hostsDrawer(ctx) {
    const draw = () => '<div class="vstack gap6">' + (HOSTS.length ? HOSTS.map((h, i) => '<div class="hstack"><span class="mono grow">' + esc(h) + '</span>' + UI.btn('Remove', { kind: 'ghost', size: 'xs', attrs: 'data-rmhost="' + i + '"' }) + '</div>').join('') : UI.empty('No public hosts', 'HTTP tools reach only the internal hosts the operator names.')) + '</div>'
      + '<div class="hstack gap6">' + UI.input('', { placeholder: 'api.example.com, *.example.com or 203.0.113.0/24', attrs: 'data-newhost aria-label="Host to allow"' }) + UI.btn('Add', { size: 'sm', attrs: 'data-addhost' }) + '</div>'
      + UI.notice('HTTP tools call a public host only when it is on this list. Internal hosts need the operator\'s SERVICE_ALLOWED_HOSTS; cloud metadata addresses are always refused. Workflow HTTP steps and webhooks read the same list.', 'info');
    ctx.drawer({ title: 'Allowed hosts', body: '<div data-hostsbody>' + draw() + '</div>', actions: UI.btn('Close', { attrs: 'data-close' }),
      onMount(d) {
        const body = d.querySelector('[data-hostsbody]');
        body.addEventListener('click', (e) => {
          const rm = e.target.closest('[data-rmhost]');
          if (rm) { const h = HOSTS.splice(Number(rm.dataset.rmhost), 1)[0]; body.innerHTML = draw(); ctx.toast(esc(h) + ' removed. Audited tenant.hosts.updated.', 'warn'); return; }
          if (e.target.closest('[data-addhost]')) { const v = body.querySelector('[data-newhost]').value.trim().toLowerCase(); if (!v) return; if (!/^(\*\.)?[a-z0-9.-]+(\/\d+)?$/.test(v)) { ctx.toast(esc(v) + ' is not a hostname, *.domain, address or CIDR network.', 'danger'); return; } HOSTS.push(v); body.innerHTML = draw(); ctx.toast(esc(v) + ' added. Audited tenant.hosts.updated.', 'ok'); }
        });
      } });
  }

  /** B-8904: an HTTP tool's draft: method, URL template, parameters from the schema, vault references, mapping, test call. */
  function httpForm(ctx, o) {
    const VAULT = ['apis/catalog#token', 'apps/crm#token', 'apps/billing/stripe#key'];
    const url0 = o.url || 'https://api.partner.example/v1/items/{id}';
    const params = (u) => (u.match(/\{([A-Za-z_][\w-]*)\}/g) || []).map((x) => x.slice(1, -1));
    const body = '<div class="formgrid">' + UI.field('Name', UI.input('catalog.get_price', { attrs: 'data-hn' })) + UI.field('Version', UI.input('0.1.0', { attrs: 'data-hv' }))
      + UI.field('Method', UI.select(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], 'GET', 'data-hm'), 'GET is read; other methods are write, or destructive if you choose it')
      + UI.field('Max label', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal'))
      + '<div class="span2">' + UI.field('URL template', UI.input(url0, { attrs: 'class="input mono" data-hu' }).replace('class="input" ', ''), 'The host is fixed. {name} in the path or query takes the argument of that name, percent-encoded.') + '</div>'
      + '<div class="span2" data-hparams>' + UI.field('Parameters from the input schema', '<div class="mono">' + esc(params(url0).map((x) => x + ' (path, string, required)').join(', ') || 'none') + '</div>') + '</div>'
      + UI.field('Header', UI.input('Authorization', { attrs: 'data-hhn' })) + UI.field('Value', UI.input(o.header || 'Bearer vault:apis/catalog#token', { attrs: 'class="input mono" data-hhv' }).replace('class="input" ', ''), 'Credentials only as vault:path#key, resolved at call time as you')
      + UI.field('Vault reference', '<div class="hstack gap6">' + UI.select(VAULT, VAULT[0], 'data-hvault aria-label="Vault reference"') + UI.btn('Insert', { size: 'sm', attrs: 'data-hinsert' }) + '</div>', 'Paths you may read under the vault policies')
      + UI.field('Response mapping', UI.input('/data/price', { attrs: 'class="input mono" data-hp' }).replace('class="input" ', ''), 'A JSON pointer, or empty for the whole body')
      + UI.field('Timeout, seconds', UI.input('10', { type: 'number' })) + UI.field('Answer cap, KB', UI.input('64', { type: 'number' }))
      + '</div>'
      + '<div data-hresult></div>'
      + UI.notice('Every call goes through the outbound address guard (resolved once, every address checked, the connection pinned, redirects not followed), the tool-call guardrail, the rate limit and the untrusted-content checkpoint. Calls are metered and audited with host, method, status, size and latency, never a secret.', 'info');
    ctx.modal({ cls: 'wide', title: 'New HTTP tool', body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Test call', { icon: 'play', attrs: 'data-htest' }) + UI.btn('Save draft and run checks', { kind: 'primary', attrs: 'data-hsave' }),
      onMount(m) {
        const res = m.querySelector('[data-hresult]');
        const literal = () => !/^((Bearer|Basic|Token) )?vault:\S+$/.test(m.querySelector('[data-hhv]').value.trim()) && /^(authorization|cookie)$|token|key|secret/i.test(m.querySelector('[data-hhn]').value);
        const refused = (u) => /169\.254\.|\/\/10\.|\/\/192\.168\./.test(u) ? (/169\.254\./.test(u) ? '169.254.169.254 is a cloud metadata address and is always refused.' : 'The host is an internal address. HTTP tools reach internal hosts only when the operator names them in SERVICE_ALLOWED_HOSTS.') : HOSTS.some((h) => u.indexOf('//' + h.replace('*.', '')) >= 0 || (h.startsWith('*.') && u.indexOf(h.slice(1)) >= 0)) ? null : 'The host is a public address that is not on this tenant\'s list of allowed hosts. A tenant admin adds it under Allowed hosts.';
        m.querySelector('[data-hu]').addEventListener('input', (e) => { m.querySelector('[data-hparams]').innerHTML = UI.field('Parameters from the input schema', '<div class="mono">' + esc(params(e.target.value).map((x) => x + ' (path, string, required)').join(', ') || 'none') + '</div>'); });
        m.querySelector('[data-hinsert]').addEventListener('click', () => { m.querySelector('[data-hhv]').value = 'Bearer vault:' + m.querySelector('[data-hvault]').value; });
        const test = () => {
          const u = m.querySelector('[data-hu]').value; const why = refused(u);
          res.innerHTML = why ? UI.problem('Egress refused', 'egress_refused: ' + why + ' Nothing was sent.', 'trace 4f1c02aa') : UI.kv([['Outcome', UI.pill('ok', 'ok')], ['Status', '200 in 140 ms'], ['Mapped value', '<span class="mono">19.99</span>'], ['Untrusted content', 'checked, nothing detected']], 2);
        };
        m.querySelector('[data-htest]').addEventListener('click', test);
        if (o.test) test();
        if (o.literal) res.innerHTML = UI.problem('Invalid request', 'The header Authorization carries a credential: use a vault reference (vault:path#key, optionally after Bearer, Basic or Token), never a literal.', 'trace 9a0d61e2');
        m.querySelector('[data-hsave]').addEventListener('click', () => {
          if (literal()) { res.innerHTML = UI.problem('Invalid request', 'The header ' + esc(m.querySelector('[data-hhn]').value) + ' carries a credential: use a vault reference (vault:path#key, optionally after Bearer, Basic or Token), never a literal.', 'trace 9a0d61e2'); return; }
          const name = m.querySelector('[data-hn]').value.trim() || 'catalog.get_price'; const method = m.querySelector('[data-hm]').value; const u = m.querySelector('[data-hu]').value;
          App.closeOverlay();
          const st = ctx.state; st.added = st.added || [];
          st.added.push({ id: name, kind: 'tool', side: method === 'GET' ? 'read-only' : 'write', version: m.querySelector('[data-hv]').value || '0.1.0', label: 'internal', egress: 'public', status: 'draft', owner: 'Mara Okafor', scopes: 'tools:invoke', confirm: method === 'GET' ? 'never' : 'always', rate: 'none', secrets: m.querySelector('[data-hhv]').value.replace(/^(Bearer|Basic|Token) /, '') + ', resolved as the author', hint: 'none (HTTP tool)', hash: Math.random().toString(16).slice(2, 10), impl: 'HTTP request', http: { method, url: u, params: params(u).map((x) => x + ' (path, string)').join(', ') || 'none', headers: m.querySelector('[data-hhn]').value + ': ' + m.querySelector('[data-hhv]').value, pointer: m.querySelector('[data-hp]').value || '(whole body)', timeout: '10 s', cap: '64 KB', calls: 'no calls yet' }, checks: [['Schema valid', true], ['HTTP request', true], ['Secrets scan', true]] });
          st.sel = name; st.tab = 'tools'; ctx.rerender(); ctx.toast('Draft ' + esc(name) + ' saved. Checks pass; submit it for review.', 'ok');
        });
      } });
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
