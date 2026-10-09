(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l);
  const STATUSES = ['draft', 'in_review', 'published', 'deprecated', 'retired'];
  const statusText = (s) => String(s || '').replace('_', ' ');
  const SIDE = { read: 'read-only', write: 'write', destructive: 'destructive' };
  const IMPL = { builtin: 'Built-in', mcp: 'MCP server tool', script: 'Script-backed', archive: 'Versioned archive', agent: 'Agent definition', workflow: 'Workflow', http: 'HTTP request' };
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  /** `name=value` and `Name: value` lines to an object, and back. */
  const linesTo = (text, sep) => { const out = {}; String(text || '').split('\n').forEach((l) => { const i = l.indexOf(sep); if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + sep.length).trim(); }); return out; };
  const toLines = (obj, sep) => Object.keys(obj || {}).map((k) => k + sep + obj[k]).join('\n');
  /** The `{name}` placeholders of a URL template. */
  const placeholders = (u) => (String(u || '').match(/\{([A-Za-z_][\w-]*)\}/g) || []).map((x) => x.slice(1, -1)).filter((x, i, a) => a.indexOf(x) === i);
  const sidePill = (s) => UI.pill(SIDE[s] || s || 'not applicable', s === 'read' ? 'ok' : s === 'write' ? 'warn' : s === 'destructive' ? 'danger' : 'outline');
  const statusPill = (s) => UI.pill(statusText(s), s === 'published' ? 'ok' : s === 'in_review' ? 'info' : s === 'deprecated' ? 'warn' : s === 'retired' ? 'danger' : '');
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const ago = (ms) => { if (!ms) return ''; const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'; };
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const pretty = (v) => JSON.stringify(v, null, 2);
  const VIA_TEXT = { delegate: 'delegates to it', workflow: 'lists it as a workflow', tool: 'calls it as a tool', skill: 'loads it as a skill', 'sub-skill': 'builds on it', 'skill-tool': 'needs it as a skill tool', 'sub-workflow': 'runs it as a sub-workflow', 'agent-step': 'runs it in an agent step', 'model-skill': 'loads it in a model step', 'tool-step': 'calls it in a tool step', 'workflow-tool': 'is its workflow tool' };
  const listOfNames = (v) => (Array.isArray(v) ? v : []).map(String);

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
      { title: 'Retire refused: still in use', tone: 'danger', text: 'Retiring the last callable version of an entry a published agent, skill or workflow uses is refused, naming them. The used-by view lists every referrer and how it reaches the entry.', apply(ctx) { ctx.state.demo = 'usedby'; ctx.rerender(); } },
      { title: 'Chain reference not published', tone: 'danger', text: 'An agent that delegates to an agent, or a skill that builds on a skill, which is not published fails the Chain references check; Approve stays disabled until it is published or removed.', apply(ctx) { ctx.state.demo = 'chainref'; ctx.rerender(); } },
      { title: 'Test harness', tone: 'info', text: 'Runs the tool once with sample arguments and shows the typed result and label.', apply(ctx) { ctx.state.demo = 'harness'; ctx.rerender(); } },
      { title: 'HTTP host refused', tone: 'danger', text: 'A test call to a host that resolves to a cloud metadata address, an internal host the operator has not named, or a public host off the tenant\'s list is refused before anything is sent.', apply(ctx) { ctx.state.demo = 'egress'; ctx.rerender(); } },
      // 1.7.0 (B-12304): the catalogue card.
      { title: 'Missing for the catalogue', tone: 'danger', text: 'Submitting an entry offered in chat (an agent, a skill, a tool a profile lists) without a purpose, an example prompt and a category is refused, naming the missing field. The entry stays a draft.', apply(ctx) { ctx.state.demo = 'cardmissing'; ctx.rerender(); } },
      { title: 'Catalogue card preview', tone: 'info', text: 'The reviewer sees the card the catalogue will show: purpose, the first example prompt, the call and the category.', apply(ctx) { ctx.state.demo = 'cardpreview'; ctx.rerender(); } },
      { title: 'Literal credential refused', tone: 'danger', text: 'Saving an HTTP tool with a literal Authorization header, API key query parameter or secret body field is refused: credentials go in as vault references, resolved at call time.', apply(ctx) { ctx.state.demo = 'literal'; ctx.rerender(); } }
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
        } else if (d === 'usedby') {
          const live = (x) => x.status === 'published' || x.status === 'deprecated';
          const named = {};
          list.filter(live).forEach((x) => { const def = x.definition || {}; listOfNames(def.agents).concat(listOfNames(def.skills), listOfNames(def.tools)).forEach((n) => { named[n] = true; }); });
          const e = list.find((x) => live(x) && !x.platform && named[x.name]);
          if (e) { st.sel = e.id; st.tab = e.kind === 'tool' ? 'tools' : e.kind + 's'; st.openUsedBy = { id: e.id, mode: e.status === 'deprecated' ? 'retire' : 'view' }; } else st.demoNote = 'No published entry is used by another yet. When an agent or skill names one, its used-by view lists them, and retiring the last version they reach is refused.';
        } else if (d === 'chainref') {
          const e = list.find((x) => (x.checks || []).some((c) => c.name === 'Chain references' && !c.ok));
          if (e) { st.sel = e.id; st.tab = e.status === 'in_review' ? 'review' : e.kind + 's'; } else st.demoNote = 'Every agent and skill passes its Chain references check: each delegate, sub-skill and listed workflow is published and within the ceiling.';
        } else if (d === 'egress') {
          const e = list.find((x) => x.impl === 'http' && x.sideEffect === 'read' && x.status !== 'retired');
          if (e) { st.sel = e.id; st.tab = 'tools'; st.harnessOpen = true; st.harnessRun = true; st.demoNote = 'The test call goes through the outbound address guard. A host off the tenant\'s list (Allowed hosts), an internal host the operator has not named, or a metadata address comes back as egress_refused and nothing is sent.'; }
          else st.demoNote = 'No read-only HTTP tool yet. Create one with Submit entry, kind Tool (HTTP request), and run its test harness: a host off the tenant\'s list comes back as egress_refused and nothing is sent.';
        } else if (d === 'literal') {
          if (App.can('tools:manage')) st.openLiteral = true;
          else st.demoNote = 'Creating HTTP tools needs tools:manage. A literal credential in a header, query parameter or body field is refused on save.';
        } else if (d === 'cardmissing') {
          const miss = (x) => !x.purpose || !(x.examples || []).length || !x.category;
          const e = list.find((x) => x.status === 'draft' && x.kind !== 'tool' && miss(x)) || list.find((x) => !x.platform && x.kind !== 'tool' && miss(x));
          if (e) { st.sel = e.id; st.tab = e.kind + 's'; st.problem = { title: 'Missing for the catalogue', detail: e.name + ' ' + e.version + ' is offered in chat, so the catalogue needs ' + [!e.purpose ? 'a purpose' : '', !(e.examples || []).length ? 'at least one example prompt' : '', !e.category ? 'a category' : ''].filter(Boolean).join(', ') + '. Submitting it as it is would be refused.', trace: null }; }
          else st.demoNote = 'Every agent and skill has its purpose, example prompts and category. One without them is refused at submit, naming what is missing.';
        } else if (d === 'cardpreview') {
          const e = list.find((x) => x.status === 'in_review') || list.find((x) => !x.platform && x.status === 'published');
          if (e) { st.sel = e.id; st.tab = e.status === 'in_review' ? 'review' : e.kind === 'tool' ? 'tools' : e.kind + 's'; st.flashCard = true; } else st.demoNote = 'Nothing waits for review. The inspector of an entry in review shows its catalogue card.';
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
      /** 1.7.0 (B-12304): the reviewer's preview of the catalogue card (`catalogCard` from the detail), with Edit. */
      const cardHtml = (e, d) => {
        const c = d.catalogCard || { call: (e.kind === 'agent' ? '@' : e.kind === 'skill' ? '+' : '/') + e.name, example: (e.examples || [])[0] || null, category: e.category || 'Other', missing: [] };
        const missing = [!e.purpose ? 'purpose' : '', !(e.examples || []).length ? 'example prompt' : '', !e.category ? 'category' : ''].filter(Boolean);
        return '<div class="hstack"><h3 class="eyebrow grow" style="margin:0">Catalogue card</h3>' + (canManage(e) && e.status !== 'retired' ? UI.btn('Edit', { kind: 'ghost', size: 'xs', icon: 'edit', attrs: 'data-cardedit aria-label="Edit the catalogue card"' }) : '') + '</div>'
          + '<div class="reg-card' + (st.flashCard ? ' flash' : '') + '"><div class="hstack wrap gap6"><b style="overflow-wrap:anywhere">' + esc(e.name) + '</b>' + UI.pill(e.kind, 'outline') + '<span class="right">' + UI.label(e.label, { sm: true }) + '</span></div>'
          + '<div class="fg2" style="font-size:13px;overflow-wrap:anywhere">' + esc(e.purpose || e.description || 'No purpose yet.') + '</div>'
          + (c.example ? '<div class="reg-ex">"' + esc(c.example) + '"</div>' : '<div class="muted" style="font-size:12px">No example prompt yet.</div>')
          + '<div class="hstack wrap gap6"><span class="mono" style="font-size:12px;overflow-wrap:anywhere">' + esc(c.call) + '</span><span class="muted right" style="font-size:12px">' + esc(c.category) + '</span></div></div>'
          + (missing.length ? '<div class="muted" style="font-size:12px">' + (d.discoveryRequired ? 'Asked for at submit, since it is offered in chat: ' : d.offeredInChat === false ? 'Not asked for (no published profile offers it in chat): ' : 'Missing: ') + esc(missing.join(', ')) + '</div>' : '');
      };
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
      // 1.6.0 Sprint 38b: the agent's identity (B-7701) and red-team status (B-7001), loaded once per selected agent.
      if (agentShown && App.can('agents:manage')) {
        if (!(st.identity && st.identity.agent === agentShown.name) && st.identityLoading !== agentShown.name) {
          st.identityLoading = agentShown.name;
          App.get('/api/admin/agent-identities/' + encodeURIComponent(agentShown.name)).then((r) => { st.identity = r; }).catch(() => { st.identity = { agent: agentShown.name, identity: null, keys: [] }; }).finally(() => { st.identityLoading = null; if (App.state.route === 'registry') ctx.rerender(); });
        }
        if (!(st.agentRedteam && st.agentRedteam.target && st.agentRedteam.target.id === agentShown.name) && st.rtLoading !== agentShown.name) {
          st.rtLoading = agentShown.name;
          App.get('/api/admin/red-team?targetKind=agent&targetId=' + encodeURIComponent(agentShown.name)).then((r) => { st.agentRedteam = r; }).catch(() => { st.agentRedteam = { target: { id: agentShown.name, version: '' }, suites: [], runs: [], gate: { gated: 0, failing: [], open: true }, categories: [] }; }).finally(() => { st.rtLoading = null; if (App.state.route === 'registry') ctx.rerender(); });
        }
      }
      const agentCard = (a) => { const d = a.definition || {}; const b = d.budgets || {}; return UI.panel('Agent: ' + esc(a.name), UI.kv([['Profile', '<a href="#" data-goprofile="' + esc(d.profile || '') + '">' + esc(d.profile || '') + '</a>'], ['Tools', esc(tools(a).join(', ') || 'none')], ['Delegates', esc(listOfNames(d.agents).map((x) => 'agent:' + x).join(', ') || 'none')], ['Handoffs', esc(listOfNames(d.handoffs).map((x) => 'agent:' + x).join(', ') || 'none') + (listOfNames(d.handoffs).length ? ' <span class="muted">the handed-to run answers</span>' : '')], ['Workflows', esc(listOfNames(d.workflows).map((x) => 'workflow:' + x).join(', ') || 'none')], ['Identity', (st.identity && st.identity.agent === a.name ? (st.identity.identity ? esc(st.identity.identity.roleNames.join(', ')) + ', ceiling ' + esc(st.identity.identity.ceiling) + ', ' + st.identity.keys.length + ' key' + (st.identity.keys.length === 1 ? '' : 's') + (st.identity.identity.enabled ? '' : ' <span class="muted">(off)</span>') : '<span class="muted">none: runs act as their owner</span>') : '<span class="muted">…</span>') + (App.can('agents:manage') ? ' ' + UI.btn('Identity', { size: 'xs', kind: 'ghost', attrs: 'data-identity' }) : '')], ['Red team', (st.agentRedteam && st.agentRedteam.target && st.agentRedteam.target.id === a.name ? (st.agentRedteam.gate.gated ? (st.agentRedteam.gate.open ? 'gated suites passed for ' + esc(st.agentRedteam.target.version) : esc(st.agentRedteam.gate.failing.map((f2) => f2.suite + ': ' + f2.reason).join('; '))) : (st.agentRedteam.suites.length ? st.agentRedteam.suites.length + ' advisory suite' + (st.agentRedteam.suites.length === 1 ? '' : 's') : '<span class="muted">no suite</span>')) : '<span class="muted">…</span>') + (App.can('agents:manage') ? ' ' + UI.btn('Red team', { size: 'xs', kind: 'ghost', attrs: 'data-redteam' }) : '')], ['Typed answer', a.outputSchema ? 'output schema set; delegating agents get the parsed object' : 'text'], ['Skills', esc((d.skills || []).join(', ') || 'none')], ['System prompt', esc(d.systemPrompt ? d.systemPrompt.slice(0, 160) + (d.systemPrompt.length > 160 ? '…' : '') : 'none')], ['Limits', esc(b.steps + ' steps, ' + fmt(b.tokens || 0) + ' tokens, ' + b.wallSeconds + ' s, ' + b.toolCalls + ' tool calls')], ['Memory', d.memory && d.memory.write === 'propose' ? esc('proposes ' + (d.memory.types || []).join(' and ') + ' memories, at most ' + d.memory.maxPerRun + ' per run, for a curator to accept') : 'reads accepted memories, proposes none']], 3), { actions: (App.can('agents:run') && (a.status === 'published' || a.status === 'deprecated') ? UI.btn('Run in Runs', { size: 'sm', attrs: 'data-goruns="' + esc(a.name) + '"' }) : '') + UI.btn('Profile', { size: 'sm', kind: 'ghost', attrs: 'data-goprofile="' + esc(d.profile || '') + '"' }) }); };

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
          ].concat(httpRows(sel, d)).concat(chainRows(sel)).concat([['Used by', esc(((d.profiles || []).map((p) => 'profile ' + p).concat((d.referencedBy || []).map((r) => r.kind + ' ' + r.name + ' ' + r.version))).join(', ') || 'nothing yet') + ' ' + UI.btn('Used by', { kind: 'ghost', size: 'xs', attrs: 'data-usedby' })]]), 1)
          + cardHtml(sel, d)
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

      root.innerHTML = '<style>.registry-page > *{flex-shrink:0}.registry-insp > *{flex-shrink:0}.registry-page .tabs .count{margin-left:2px}.reg-card{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.reg-card.flash{border-color:var(--accent)}.reg-ex{font-size:13px;font-style:italic;color:var(--fg2);overflow-wrap:anywhere}</style>'
        + '<div class="page registry-page">' + UI.pagehead('Registry', 'Nothing reaches a tenant before review', (App.can('tenant:manage') ? UI.btn('Allowed hosts', { attrs: 'data-hosts' }) : '') + UI.btn('Open test harness', { attrs: 'data-harness-open' }) + UI.btn('Submit entry', { kind: 'primary', attrs: 'data-submit', disabled: !App.can('tools:manage') && !App.can('agents:manage') }))
        + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '')
        + UI.tabs([{ id: 'tools', label: 'Tools', count: ofKind('tool').length }, { id: 'skills', label: 'Skills', count: ofKind('skill').length }, { id: 'agents', label: 'Agents', count: ofKind('agent').length }, { id: 'review', label: 'Review queue', count: review.length }], st.tab)
        + '<div class="toolbar">' + UI.search('Search by name, owner or tool', 'data-search', st.query) + UI.seg([{ id: 'all', label: 'All' }].concat(STATUSES.map((v) => ({ id: v, label: statusText(v) }))), st.filter, 'data-statusseg') + '<span class="muted right" style="font-size:12px">Lifecycle: draft, in review, published, deprecated, retired</span></div>'
        + (st.tab === 'review' ? UI.notice('Entries wait here after their automated checks (schema, required fields, description, side effect, secrets scan). A tool admin other than the author approves and picks the publish scope.', 'info') : '')
        + table
        + (agentShown ? agentCard(agentShown) : '')
        + '</div>'
        + inspector;

      // ---- events ----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-statusseg] [data-seg]', (e, t) => { st.filter = t.dataset.seg; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', 'tr.row[data-entry]', (e, t) => { st.sel = t.dataset.entry; st.harness = null; st.harnessArgs = null; st.problem = null; ctx.rerender(); });
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
      st.flashCard = false;
      // 1.7.0 (B-12304): the catalogue card's fields, in any state but retired (they are not part of the schema hash).
      ctx.on('click', '[data-cardedit]', () => {
        ctx.modal({ title: 'Catalogue card for ' + esc(sel.name), body: '<div class="vstack gap8">' + UI.field('Purpose', UI.input(sel.purpose || '', { placeholder: 'What a person gets from it, in one line', attrs: 'data-cpurpose maxlength="500"' })) + UI.field('Example prompts', UI.textarea((sel.examples || []).join('\n'), { rows: 3, placeholder: 'One per line, up to five', attrs: 'data-cexamples' }), 'The first one fills the composer when someone picks it from the catalogue.') + UI.field('Category', UI.input(sel.category || '', { placeholder: 'Documents, Finance, Writing', attrs: 'data-ccat maxlength="60"' })) + UI.notice('These are not part of the schema hash: a published entry gains them without a new version or a new review.', 'info') + '</div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-csave' }),
          onMount(m) {
            m.querySelector('[data-csave]').addEventListener('click', async () => {
              const examples = m.querySelector('[data-cexamples]').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 5);
              const body = { purpose: m.querySelector('[data-cpurpose]').value.trim() || null, examples, category: m.querySelector('[data-ccat]').value.trim() || null };
              App.closeOverlay();
              await act(() => App.put('/api/admin/registry/' + sel.id + '/discovery', body), 'Catalogue card for ' + esc(sel.name) + ' saved.');
            });
          } });
      });
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
      ctx.on('click', '[data-deprecate]', () => usedByModal(sel, 'deprecate'));
      ctx.on('click', '[data-retire]', () => usedByModal(sel, 'retire'));
      ctx.on('click', '[data-usedby]', () => usedByModal(sel, 'view'));
      ctx.on('click', '[data-entrylink]', (e, t) => { e.preventDefault(); const hit = list.find((x) => x.name === t.dataset.entrylink && x.kind === t.dataset.kind && (x.status === 'published' || x.status === 'deprecated')) || list.find((x) => x.name === t.dataset.entrylink && x.kind === t.dataset.kind); if (hit) { st.sel = hit.id; st.tab = hit.kind === 'tool' ? 'tools' : hit.kind + 's'; ctx.rerender(); } else toast('No ' + esc(t.dataset.kind) + ' named ' + esc(t.dataset.entrylink) + ' in this registry.'); });
      ctx.on('click', '[data-gowfname]', (e, t) => { e.preventDefault(); ctx.navigate('workflows', { id: t.dataset.gowfname }); });
      ctx.on('click', '[data-restore]', () => act(() => App.post('/api/admin/registry/' + sel.id + '/lifecycle', { to: 'published' }), esc(sel.name) + ' restored to published.'));
      ctx.on('click', '[data-publishmore]', () => publishScope(sel, 'publish'));
      ctx.on('click', '[data-newversion]', () => {
        const parts = String(sel.version).split('.').map((x) => parseInt(x, 10) || 0);
        ctx.modal({ title: 'New version of ' + esc(sel.name), body: UI.field('Version', UI.input(parts[0] + '.' + (parts[1] + 1) + '.0', { attrs: 'data-ver' }), 'A draft copied from ' + esc(sel.version) + '; it goes through checks and review like any draft.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', async () => { const version = m.querySelector('[data-ver]').value.trim(); App.closeOverlay(); const r = await act(() => App.post('/api/admin/registry/' + sel.id + '/versions', { version }), 'Draft ' + esc(sel.name) + ' ' + esc(version) + ' created.'); if (r && r.id) st.sel = r.id; }); } });
      });
      ctx.on('click', '[data-editentry]', () => entryForm(sel));
      ctx.on('click', '[data-identity]', () => identityModal(agentShown || sel));
      ctx.on('click', '[data-redteam]', () => redTeamModal(agentShown || sel));

      /** B-7701: the agent's identity: roles, ceiling, on or off, and keys minted for it (shown once). */
      function identityModal(e) {
        if (!e || e.kind !== 'agent') return;
        const cur = st.identity && st.identity.agent === e.name ? st.identity : { agent: e.name, identity: null, keys: [] };
        const id = cur.identity;
        const roles = (App.me && App.me.roles) || [];
        const keysTable = (keys) => UI.table(['Key', 'Scopes', 'Owner', 'Expires', 'State', { label: '', right: true }], keys.map((k) => ['<span class="mono">' + esc(k.prefix) + '…</span> ' + esc(k.name), '<span class="mono" style="white-space:normal">' + esc(k.scopes.join(', ')) + '</span>', esc(k.ownerName || ''), esc(when(k.expiresAt)), UI.pill(k.state, k.state === 'active' ? 'ok' : 'danger'), k.state === 'active' ? UI.btn('Revoke', { kind: 'ghost', size: 'xs', attrs: 'data-krevoke="' + esc(k.id) + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'No keys', emptyText: 'A key minted here acts as the agent on your behalf, within the identity\'s roles and the key\'s scopes.' });
        ctx.modal({ cls: 'wide', title: 'Identity of ' + esc(e.name),
          body: '<div class="vstack gap12">' + UI.notice('A run of ' + esc(e.name) + ' acts within <b>both</b> grants: the user\'s permissions narrowed to these roles, and the lower of the user\'s clearance and this ceiling. A tool call the roles do not cover is refused even when an admin starts the run; audit events name the agent beside the user.', 'info')
            + '<div class="formgrid" style="--cols:2">' + UI.field('Roles (ids, comma separated)', UI.input(id ? id.roles.join(', ') : '', { attrs: 'data-iroles', placeholder: 'member' }), 'Roles whose permissions you hold yourself; a role never grants more than its author holds')
            + UI.field('Label ceiling', UI.select(['public', 'internal', 'confidential', 'restricted'], id ? id.ceiling : e.label, 'data-iceil'), 'Runs above it fail before they think') + '</div>'
            + UI.check('Identity on (off: runs act as their owner, and keys are refused)', id ? id.enabled : true, 'data-ion')
            + (id ? UI.kv([['Permissions', '<span class="mono" style="white-space:normal">' + esc(id.permissions.join(', ')) + '</span>'], ['Updated', esc(when(id.updatedAt))]], 2) : '')
            + '<div class="hstack"><div class="eyebrow grow">Keys minted for this identity</div>' + UI.btn('Mint key', { size: 'sm', attrs: 'data-kmint', disabled: !id || !id.enabled }) + '</div><div data-keys>' + keysTable(cur.keys) + '</div><div data-knew></div><div data-ierr></div></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save identity', { kind: 'primary', attrs: 'data-iok' }),
          onMount(m) {
            const err = (msg) => { m.querySelector('[data-ierr]').innerHTML = UI.notice(esc(msg), 'danger'); };
            m.querySelector('[data-iok]').addEventListener('click', async () => {
              const body = { roles: m.querySelector('[data-iroles]').value.split(',').map((r) => r.trim()).filter(Boolean), ceiling: m.querySelector('[data-iceil]').value, enabled: m.querySelector('[data-ion]').checked };
              if (!body.roles.length) { err('An identity needs at least one role.'); return; }
              try { await App.put('/api/admin/agent-identities/' + encodeURIComponent(e.name), body); } catch (e2) { err(e2.message); return; }
              App.closeOverlay(); st.identity = null; ctx.rerender();
              toast('Identity of <b>' + esc(e.name) + '</b> saved: ' + esc(body.roles.join(', ')) + ', ceiling ' + esc(body.ceiling) + (body.enabled ? '.' : ', off.'), 'ok', 5000);
            });
            m.addEventListener('click', async (ev) => {
              const rv = ev.target.closest('[data-krevoke]');
              if (rv) { try { await App.del('/api/admin/agent-identities/' + encodeURIComponent(e.name) + '/keys/' + encodeURIComponent(rv.dataset.krevoke)); } catch (e2) { err(e2.message); return; } const r = await App.get('/api/admin/agent-identities/' + encodeURIComponent(e.name)); st.identity = r; m.querySelector('[data-keys]').innerHTML = keysTable(r.keys); toast('Key revoked. Requests with it are refused from now on.', 'warn'); return; }
              if (!ev.target.closest('[data-kmint]')) return;
              const scopes = (id ? id.permissions : []).filter((p2) => roles.length ? App.can(p2) : true);
              m.querySelector('[data-knew]').innerHTML = '<div class="vstack gap6" data-kform>' + UI.field('Key name', UI.input('ci', { attrs: 'data-kn maxlength="100"' })) + UI.field('Scopes', UI.input(scopes.join(', '), { attrs: 'data-ks' }), 'A subset of the identity\'s permissions you hold too') + UI.field('Lifetime, days', UI.select(['30', '90', '180', '365'], '90', 'data-kt')) + '<div>' + UI.btn('Create key', { kind: 'primary', size: 'sm', attrs: 'data-kcreate' }) + '</div></div>';
              m.querySelector('[data-kcreate]').addEventListener('click', async () => {
                const body = { name: m.querySelector('[data-kn]').value.trim() || 'ci', scopes: m.querySelector('[data-ks]').value.split(',').map((x) => x.trim()).filter(Boolean), ttlDays: Number(m.querySelector('[data-kt]').value) };
                let r;
                try { r = await App.post('/api/admin/agent-identities/' + encodeURIComponent(e.name) + '/keys', body); } catch (e2) { err(e2.message); return; }
                const all = await App.get('/api/admin/agent-identities/' + encodeURIComponent(e.name)); st.identity = all; m.querySelector('[data-keys]').innerHTML = keysTable(all.keys);
                m.querySelector('[data-knew]').innerHTML = UI.notice('<b>Key minted, shown once.</b> <span class="mono" data-newkey>' + esc(r.key) + '</span><br><span class="muted">' + esc(r.notice) + ' A request with it acts as ' + esc(e.name) + ' on your behalf and names the agent in the audit.</span>', 'ok');
              });
            });
          } });
      }

      /** B-7001: the agent's red-team suites; attacks run as child runs of the agent; the gate decides approval of a version. */
      function redTeamModal(e) {
        if (!e || e.kind !== 'agent') return;
        const rt = st.agentRedteam && st.agentRedteam.target && st.agentRedteam.target.id === e.name ? st.agentRedteam : null;
        if (!rt) { toast('Loading the red-team suites…', 'info'); return; }
        const RUN_KIND = { passed: 'ok', failed: 'danger', error: 'danger', queued: 'info', running: 'info' };
        const catName = (c) => { const k = (rt.categories || []).find((y) => y.id === c); return k ? k.label : c; };
        const g = rt.gate;
        const gateText = !g.gated ? 'No suite gates approval. Mark a suite as a gate to require a passing run before a version is approved.' : g.failing.length ? 'Approving a version with the current hash is refused until: ' + g.failing.map((f2) => esc(f2.suite) + ', ' + esc(f2.reason)).join('; ') + '.' : 'Every gated suite passed for ' + esc(rt.target.version) + '. Approval is allowed.';
        const body = UI.notice(gateText, !g.gated ? 'info' : g.failing.length ? 'warn' : 'ok', '<span class="hstack gap6">' + UI.btn('Run red team', { size: 'sm', attrs: 'data-artrun', disabled: !rt.suites.length }) + UI.btn('New suite', { size: 'sm', kind: 'ghost', attrs: 'data-artnew' }) + '</span>')
          + UI.table(['Suite', 'Categories', 'Attacks', 'Threshold', 'Gate', { label: '', right: true }], rt.suites.map((s) => [esc(s.name), esc(s.categories.map(catName).join(', ') || 'none') + (s.cases.length ? ' <span class="muted">+ ' + s.cases.length + ' own</span>' : ''), '<span class="num">' + s.attacks + '</span>', '<span class="num">' + Math.round(s.threshold * 100) + '%</span>', s.gate ? UI.pill('gates approval', 'accent') : UI.pill('advisory', 'outline'), UI.btn(s.gate ? 'Gate off' : 'Gate on', { kind: 'ghost', size: 'xs', attrs: 'data-artgate="' + esc(s.id) + '" data-gateon="' + (s.gate ? '0' : '1') + '"' })]), { clickable: false, minWidth: '0', emptyTitle: 'No suites', emptyText: 'Suites for agents are kept with the agent\'s name, whichever version is published.' })
          + '<div class="eyebrow" style="margin-top:8px">Runs</div>' + UI.table(['When', 'Suite', 'Version', 'Resisted', 'Result', 'By'], rt.runs.slice(0, 20).map((r) => [esc(when(r.createdAt)), esc(r.suite || ''), '<span class="mono">' + esc(r.targetVersion || '') + '</span>', r.attacks ? '<span class="num">' + r.resisted + ' of ' + r.attacks + '</span>' : '—', UI.pill(r.state, RUN_KIND[r.state]) + (r.error ? ' <span class="muted" style="font-size:12px">' + esc(r.error) + '</span>' : ''), esc(r.createdByName || '')]), { clickable: false, minWidth: '0', emptyTitle: 'Not run yet', emptyText: 'Each attack runs as a child run of the agent; a tool call that reaches an outside address fails the attack even when the answer is clean.' })
          + '<div data-arterr></div>';
        ctx.modal({ cls: 'wide', title: 'Red team: ' + esc(e.name) + ' ' + UI.pill(rt.target.version || e.version, 'outline'), body: '<div class="vstack gap12">' + body + '</div>', actions: UI.btn('Close', { attrs: 'data-close' }),
          onMount(m) {
            const err = (msg) => { m.querySelector('[data-arterr]').innerHTML = UI.notice(esc(msg), 'danger'); };
            const refresh = async (msg, kind) => { App.closeOverlay(); st.agentRedteam = null; ctx.rerender(); if (msg) toast(msg, kind || 'ok', 5000); };
            m.addEventListener('click', async (ev) => {
              if (ev.target.closest('[data-artrun]')) { try { await App.post('/api/admin/red-team/run', { targetKind: 'agent', targetId: e.name }); } catch (e2) { err(e2.message); return; } refresh('Red-team run queued: the attacks run as child runs of <b>' + esc(e.name) + '</b>. Open Runs to follow them.'); return; }
              const gt = ev.target.closest('[data-artgate]');
              if (gt) { try { await App.patch('/api/admin/red-team/suites/' + encodeURIComponent(gt.dataset.artgate), { gate: gt.dataset.gateon === '1' }); } catch (e2) { err(e2.message); return; } refresh('Suite gate ' + (gt.dataset.gateon === '1' ? 'on: a passing run is needed before a version is approved.' : 'off.'), gt.dataset.gateon === '1' ? 'ok' : 'warn'); return; }
              if (ev.target.closest('[data-artnew]')) {
                const cats = rt.categories || [];
                m.querySelector('[data-arterr]').innerHTML = '<div class="vstack gap6" data-artform>' + UI.field('Name', UI.input('Agent baseline', { attrs: 'data-arn maxlength="120"' })) + '<div class="vstack gap4">' + cats.map((c) => UI.check(esc(c.label) + ' <span class="muted">(' + c.attacks + ' attacks)</span>', true, 'data-arc="' + esc(c.id) + '"')).join('') + '</div>' + UI.check('Gate approval on this suite', true, 'data-arg') + '<div>' + UI.btn('Create suite', { kind: 'primary', size: 'sm', attrs: 'data-arcreate' }) + '</div></div>';
                m.querySelector('[data-arcreate]').addEventListener('click', async () => {
                  const body2 = { targetKind: 'agent', targetId: e.name, name: m.querySelector('[data-arn]').value.trim() || 'Agent baseline', categories: Array.prototype.filter.call(m.querySelectorAll('[data-arc]'), (c) => c.checked).map((c) => c.dataset.arc), cases: [], threshold: 1, gate: m.querySelector('[data-arg]').checked };
                  try { await App.post('/api/admin/red-team/suites', body2); } catch (e2) { err(e2.message); return; }
                  refresh('Red-team suite <b>' + esc(body2.name) + '</b> created for ' + esc(e.name) + '. Run it to see what the agent resists.');
                });
              }
            });
          } });
      }
      ctx.on('click', '[data-goworkflow]', (e, t) => { e.preventDefault(); ctx.navigate('workflows', { id: t.dataset.goworkflow }); });
      ctx.on('click', '[data-submit]', () => entryForm(null));
      ctx.on('click', '[data-hosts]', () => hostsDrawer());

      if (st.openSubmit) { st.openSubmit = false; setTimeout(() => entryForm(null), 30); }
      if (st.openLiteral) { st.openLiteral = false; setTimeout(() => entryForm(null, { kind: 'http', literal: true }), 30); }
      if (st.openScope) { const e = list.find((x) => x.id === st.openScope); st.openScope = null; if (e) setTimeout(() => publishScope(e, e.status === 'in_review' ? 'review' : 'publish'), 30); }
      if (st.harnessRun) { st.harnessRun = false; setTimeout(runHarness, 30); }
      if (st.openUsedBy) { const o = st.openUsedBy; st.openUsedBy = null; const e = list.find((x) => x.id === o.id); if (e) setTimeout(() => usedByModal(e, o.mode), 30); }

      /** B-8901: an HTTP tool's request, credentials (vault references only), mapping and its calls over the last day. */
      function httpRows(e, d) {
        if (e.impl !== 'http' || !e.definition) return [];
        const x = e.definition; const c = d && d.httpCalls;
        const refs = Object.keys(x.headers || {}).map((k) => k + ': ' + x.headers[k]).concat(Object.keys(x.query || {}).filter((k) => /vault:/.test(x.query[k])).map((k) => k + '=' + x.query[k]));
        return [['Request', '<span class="mono" style="overflow-wrap:anywhere">' + esc(x.method + ' ' + x.url) + '</span>'], ['Parameters', esc(placeholders(x.url).concat(Object.keys(x.query || {})).join(', ') || 'none') + (x.body && x.body.mode !== 'none' ? ' <span class="muted">(body: ' + esc(x.body.mode === 'args' ? 'the other arguments as JSON' : 'template') + ')</span>' : '')], ['Headers', refs.length ? '<span class="mono" style="overflow-wrap:anywhere">' + esc(refs.join('; ')) + '</span>' : 'none'], ['Response', esc((x.response && x.response.pointer ? 'JSON pointer ' + x.response.pointer : 'the whole body') + ', at most ' + Math.round(((x.response && x.response.maxBytes) || 65536) / 1024) + ' KB, ' + Math.round((x.timeoutMs || 10000) / 1000) + ' s timeout')], ['Calls, last day', c ? esc(c.calls + ' call' + (c.calls === 1 ? '' : 's') + ', ' + c.failed + ' failed' + (c.refused ? ' (' + c.refused + ' refused by the address guard)' : '') + (c.medianMs != null ? ', median ' + c.medianMs + ' ms' : '') + (c.last ? '; last ' + c.last.status + ' ' + c.last.outcome + ' from ' + c.last.host : '')) : 'none yet'], ['Outbound guard', 'resolved once, every address checked, connection pinned, redirects not followed']];
      }

      /** B-8904: the tenant's list of allowed hosts (GET and PUT /api/admin/integrations/hosts). */
      async function hostsDrawer() {
        let cur0;
        try { cur0 = await App.get('/api/admin/integrations/hosts'); } catch (err) { App.fail(err, 'Allowed hosts could not be loaded'); return; }
        let hosts = cur0.hosts.slice();
        const draw = () => '<div class="vstack gap6">' + (hosts.length ? hosts.map((h, i) => '<div class="hstack"><span class="mono grow" style="overflow-wrap:anywhere">' + esc(h) + '</span>' + UI.btn('Remove', { kind: 'ghost', size: 'xs', attrs: 'data-rmhost="' + i + '" aria-label="Remove ' + esc(h) + '"' }) + '</div>').join('') : UI.empty('No public hosts', 'HTTP tools reach only the internal hosts the operator names.')) + '</div>'
          + '<div class="hstack gap6">' + UI.input('', { placeholder: 'api.example.com, *.example.com or 203.0.113.0/24', attrs: 'data-newhost aria-label="Host to allow"' }) + UI.btn('Add', { size: 'sm', attrs: 'data-addhost' }) + '</div>'
          + UI.notice('HTTP tools call a public host only when it is on this list. Internal hosts need the operator\'s SERVICE_ALLOWED_HOSTS; cloud metadata addresses are always refused. Workflow HTTP steps and webhooks read the same list: when it has entries, they reach only hosts on it.', 'info');
        ctx.drawer({ title: 'Allowed hosts', body: '<div data-hostsbody>' + draw() + '</div>', actions: UI.btn('Close', { attrs: 'data-close' }),
          onMount(dr) {
            const body = dr.querySelector('[data-hostsbody]');
            const save = async (next, msg) => { try { const r = await App.api('PUT', '/api/admin/integrations/hosts', { hosts: next }); hosts = r.hosts.slice(); body.innerHTML = draw(); toast(msg, 'ok'); } catch (err) { App.fail(err, 'Allowed hosts not saved'); } };
            body.addEventListener('click', (ev) => {
              const rm = ev.target.closest('[data-rmhost]');
              if (rm) { const h = hosts[Number(rm.dataset.rmhost)]; save(hosts.filter((x, i) => i !== Number(rm.dataset.rmhost)), esc(h) + ' removed. Audited tenant.hosts.updated.'); return; }
              if (ev.target.closest('[data-addhost]')) { const v = body.querySelector('[data-newhost]').value.trim().toLowerCase(); if (!v) return; save(hosts.concat([v]), esc(v) + ' added. Audited tenant.hosts.updated.'); }
            });
          } });
      }

      /** Inspector rows for the chain fields (B-4102 to B-4104): an agent's delegates, workflows and schemas, a skill's dependencies. */
      function chainRows(e) {
        const d = e.definition || {};
        const links = (names, kind, prefix) => names.length ? names.map((n) => '<a href="#" data-entrylink="' + esc(n) + '" data-kind="' + kind + '" class="mono">' + esc(prefix + n) + '</a>').join(', ') : 'none';
        const schema = (v, none) => (v ? '<span class="mono" style="overflow-wrap:anywhere">' + esc(JSON.stringify(v).slice(0, 240)) + '</span>' : '<span class="muted">' + none + '</span>');
        if (e.kind === 'agent') return [['Delegates', links(listOfNames(d.agents), 'agent', 'agent:')], ['Handoffs', links(listOfNames(d.handoffs), 'agent', 'agent:')], ['Workflows', listOfNames(d.workflows).length ? listOfNames(d.workflows).map((n) => '<span class="mono">workflow:' + esc(n) + '</span>').join(', ') : 'none'], ['Input schema', schema(e.inputSchema, 'none: delegates send {task: string}')], ['Output schema', schema(e.outputSchema, 'none: the answer is text')]];
        if (e.kind === 'skill') return [['Builds on', links(listOfNames(d.skills), 'skill', '')]];
        return [];
      }

      /** The used-by view (GET /api/admin/registry/:id/used-by) before deprecating or retiring, or on its own. */
      async function usedByModal(e, mode) {
        let u;
        try { u = await App.get('/api/admin/registry/' + e.id + '/used-by'); } catch (err) { App.fail(err, 'Used by could not be loaded'); return; }
        const usedBy = u.usedBy || []; const live = usedBy.filter((x) => x.live);
        const names = live.map((x) => x.kind + ' ' + x.name + ' ' + x.version).join('; ');
        const table = UI.table(['Kind', 'Name', 'Version', 'Status', 'How it references ' + e.name, 'Live'], usedBy.map((x) => [esc(x.kind), '<b>' + esc(x.name) + '</b>', '<span class="mono">' + esc(x.version == null ? '' : x.version) + '</span>', statusPill(x.status), esc(VIA_TEXT[x.via] || x.via) + ' <span class="muted mono">' + esc(x.via) + '</span>', x.live ? UI.pill('live', 'warn') : UI.pill('not live', 'outline')]), { clickable: false, minWidth: '640px', emptyTitle: 'Nothing references ' + e.name, emptyText: 'No agent, skill, tool or workflow in this tenant names it.' });
        const others = u.otherVersions || [];
        const versions = '<div class="muted" style="font-size:12px">' + (others.length ? 'Other versions: ' + others.map((v2) => esc(v2.version + ' ' + statusText(v2.status))).join(', ') : 'No other version of ' + esc(e.name) + '.') + '</div>';
        const blocked = mode === 'retire' && u.retireBlocked;
        const note = mode === 'retire' ? (blocked ? UI.notice('<b>Retire refused (Still in use).</b> ' + esc(e.name) + ' is used by ' + esc(names) + '. Publish another version, or remove it from them first.', 'danger') : UI.notice('Retiring removes ' + esc(e.name) + ' ' + esc(e.version) + ' from routing. ' + (live.length ? 'Live referrers reach another version.' : 'Nothing live reaches it.') + ' The entry stays resolvable for audit.', 'warn'))
          : mode === 'deprecate' ? UI.notice('Deprecated entries stay callable. ' + (live.length ? live.length + ' live referrer' + (live.length === 1 ? '' : 's') + ' keep working and show a warning in run details with the replacement.' : 'Nothing live references it.'), 'warn') + UI.field('Replacement', UI.input(e.name + ' ' + (parseInt(e.version, 10) + 1) + '.0.0', { attrs: 'data-repl' }))
            : (u.retireBlocked ? UI.notice('Retiring this version would be refused: ' + esc(names) + ' still use' + (live.length === 1 ? 's' : '') + ' it and no other version is published or deprecated.', 'warn') : UI.notice('Built from the reference graph across agents, skills, tools and published workflow versions. Drafts are listed but not live.', 'info'));
        ctx.modal({ cls: 'wide', title: (mode === 'retire' ? 'Retire ' : mode === 'deprecate' ? 'Deprecate ' : 'Used by: ') + esc(e.name) + ' ' + UI.pill(e.version, 'outline'), body: note + table + versions,
          actions: UI.btn(mode === 'view' ? 'Close' : 'Cancel', { attrs: 'data-close' }) + (mode === 'retire' ? UI.btn('Retire', { kind: 'danger', attrs: 'data-ok', disabled: blocked, title: blocked ? 'Refused while a live entry uses the last callable version' : '' }) : mode === 'deprecate' ? UI.btn('Deprecate', { kind: 'primary', attrs: 'data-ok' }) : ''),
          onMount(m) {
            const ok = m.querySelector('[data-ok]'); if (!ok) return;
            ok.addEventListener('click', () => {
              if (mode === 'retire') { App.closeOverlay(); act(() => App.post('/api/admin/registry/' + e.id + '/lifecycle', { to: 'retired' }), esc(e.name) + ' retired.', 'danger'); return; }
              const replacement = m.querySelector('[data-repl]').value.trim() || null; App.closeOverlay();
              act(() => App.post('/api/admin/registry/' + e.id + '/lifecycle', { to: 'deprecated', replacement }), esc(e.name) + ' deprecated. Runs now show a warning.', 'warn');
            });
          } });
      }

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

      function entryForm(e, opts) {
        const o = opts || {};
        const kind = o.kind || (e ? (e.impl === 'http' ? 'http' : e.kind) : App.can('tools:manage') ? 'skill' : 'agent');
        const hd = e && e.impl === 'http' ? e.definition || {} : { method: 'GET', url: 'https://api.example.com/v1/items/{id}', query: {}, headers: o.literal ? { Authorization: 'Bearer 9f3ab21c7d4e5f6a8b9c' } : { Authorization: 'Bearer vault:apis/example#token' }, body: { mode: 'none' }, response: { pointer: '/data', maxBytes: 65536 }, timeoutMs: 10000 };
        const d = e ? e.definition || {} : {};
        const b = d.budgets || { steps: 20, tokens: 10000, wallSeconds: 120, toolCalls: 8 };
        const published = list.filter((x) => x.kind === 'tool' && (x.status === 'published' || x.status === 'deprecated')).map((x) => x.name);
        const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);
        const kinds = [];
        if (App.can('tools:manage')) kinds.push({ value: 'skill', label: 'Skill' }, { value: 'tool', label: 'Tool (script-backed)' }, { value: 'http', label: 'Tool (HTTP request)' });
        if (App.can('agents:manage')) kinds.push({ value: 'agent', label: 'Agent' });
        const fields = (k) => {
          const common = UI.field('Name', UI.input(e ? e.name : '', { placeholder: k === 'agent' ? 'Data analyst' : 'namespace.operation', attrs: 'data-name' + (e ? ' readonly' : '') })) + UI.field('Version', UI.input(e ? e.version : '0.1.0', { attrs: 'data-version' + (e ? ' readonly' : '') }))
            + '<div class="span2">' + UI.field('Description', UI.textarea(e ? e.description || '' : '', { rows: 2, attrs: 'data-desc', placeholder: 'What it does, when to use it and what it returns' }), 'At least 40 characters: a model reads this to decide when to use it.') + '</div>'
            + UI.field('Max label', UI.select(LABELS.filter((l) => !me.clearance || rank(l) <= rank(me.clearance)), e ? e.label : 'internal', 'data-label'))
            // 1.7.0 (B-12304): the catalogue card; asked for at submit for anything offered in chat.
            + '<div class="span2">' + UI.field('Purpose', UI.input(e ? e.purpose || '' : '', { placeholder: 'What a person gets from it, in one line', attrs: 'data-purpose maxlength="500"' }), 'Shown on the catalogue card') + '</div>'
            + '<div class="span2">' + UI.field('Example prompts', UI.textarea(e ? (e.examples || []).join('\n') : '', { rows: 2, placeholder: 'One per line, up to five', attrs: 'data-examples' }), 'At least one for an agent, a skill or a tool a profile offers in chat') + '</div>'
            + UI.field('Category', UI.input(e ? e.category || '' : '', { placeholder: 'Documents, Finance, Writing', attrs: 'data-category maxlength="60"' }));
          if (k === 'http') {
            const schema0 = e && e.inputSchema ? e.inputSchema : { type: 'object', properties: placeholders(hd.url).reduce((a, n) => { a[n] = { type: 'string' }; return a; }, {}), required: placeholders(hd.url) };
            const side = e ? e.sideEffect : 'read';
            return common + UI.field('Method', UI.select(METHODS, hd.method, 'data-hmethod'), 'GET is read; other methods are write, or destructive if you choose it')
              + UI.field('Side-effect class', UI.select([{ value: 'write', label: 'write' }, { value: 'destructive', label: 'destructive' }], side === 'destructive' ? 'destructive' : 'write', 'data-hside' + (hd.method === 'GET' ? ' disabled' : '')), hd.method === 'GET' ? 'A GET tool is read-only' : 'write and destructive require confirmation')
              + '<div class="span2">' + UI.field('URL template', UI.input(hd.url, { attrs: 'class="input mono" data-hurl' }).replace('class="input" ', ''), 'The host is fixed; {name} in the path or query takes the argument of that name, percent-encoded') + '</div>'
              + '<div class="span2">' + UI.field('Input schema (JSON Schema)', UI.textarea(pretty(schema0), { rows: 4, attrs: 'data-in' }), 'Every {name} must be one of its properties. ' + UI.btn('Fill from the URL', { kind: 'ghost', size: 'xs', attrs: 'data-hfill' })) + '</div>'
              + UI.field('Query parameters', UI.textarea(toLines(hd.query, '='), { rows: 2, attrs: 'class="textarea mono" data-hquery', placeholder: 'fields={fields}' }).replace('class="textarea" ', ''), 'One name=value per line')
              + UI.field('Headers', UI.textarea(toLines(hd.headers, ': '), { rows: 2, attrs: 'class="textarea mono" data-hheaders', placeholder: 'Authorization: Bearer vault:apis/example#token' }).replace('class="textarea" ', ''), 'One Name: value per line. Credentials only as vault:path#key, resolved at call time as you')
              + UI.field('Vault reference', '<div class="hstack gap6 wrap"><select class="select" data-hvault aria-label="Vault secret" style="flex:1;min-width:0"><option value="">' + (App.can('secrets:read') ? 'Loading vault paths…' : 'Needs secrets:read') + '</option></select>' + UI.input('token', { attrs: 'data-hkey aria-label="Key in the secret" style="width:90px"' }) + UI.btn('Insert', { size: 'sm', attrs: 'data-hinsert' }) + '</div>', 'Adds Authorization: Bearer vault:path#key to the headers')
              + UI.field('Body', UI.select([{ value: 'none', label: 'none' }, { value: 'args', label: 'the other arguments as JSON' }, { value: 'template', label: 'a template' }], (hd.body && hd.body.mode) || 'none', 'data-hbody'), 'A GET tool sends no body')
              + '<div class="span2">' + UI.field('Body template', UI.textarea(hd.body && hd.body.mode === 'template' ? hd.body.template : '', { rows: 2, attrs: 'class="textarea mono" data-htemplate', placeholder: '{ "title": {title}, "api_key": "{vault:apis/example#key}" }' }).replace('class="textarea" ', ''), '{name} becomes the argument as JSON; secret fields take {vault:path#key}') + '</div>'
              + UI.field('Response mapping (JSON pointer)', UI.input((hd.response && hd.response.pointer) || '', { attrs: 'class="input mono" data-hptr', placeholder: '/data/name' }).replace('class="input" ', ''), 'Empty returns the whole body')
              + UI.field('Answer cap, KB', UI.input(String(Math.round(((hd.response && hd.response.maxBytes) || 65536) / 1024)), { type: 'number', attrs: 'data-hcap min="1" max="16384"' }))
              + UI.field('Timeout, seconds', UI.input(String(Math.round((hd.timeoutMs || 10000) / 1000)), { type: 'number', attrs: 'data-htimeout min="1" max="120"' }))
              + UI.field('Output schema (optional)', UI.textarea(e && e.outputSchema ? pretty(e.outputSchema) : '', { rows: 2, attrs: 'data-out' }))
              + '<div class="span2">' + (o.literal ? UI.notice('<b>A literal credential is refused.</b> Saving this draft as it is fails: the Authorization header holds a value, not a vault reference. Pick a vault reference and insert it.', 'danger') : UI.notice('Every call goes through the outbound address guard (resolved once, every address checked, the connection pinned, redirects not followed): internal hosts only as the operator names them, public hosts only from the tenant\'s Allowed hosts. Test it from the harness once it is saved.', 'info')) + '</div>';
          }
          if (k === 'skill') return common + '<div class="span2">' + UI.field('Instructions', UI.textarea(d.instructions || '', { rows: 5, attrs: 'data-instructions' })) + '</div>' + UI.field('Tools it uses', UI.input((d.tools || []).join(', '), { attrs: 'data-tools list="registry-tools"', placeholder: 'calculate, ledger.query' }), 'Published tools only') + UI.field('Skills it builds on', UI.input(listOfNames(d.skills).join(', '), { attrs: 'data-subskills list="registry-skills"', placeholder: 'variance-analysis' }), 'Loading this skill loads them first, each once, and offers the tools of the whole closure');
          if (k === 'agent') return common + UI.field('Model profile', UI.input(d.profile || '', { attrs: 'data-profile', placeholder: 'general' }), 'A profile of this tenant; its model must support tools if the agent has any') + '<div class="span2">' + UI.field('Tools', UI.input((d.tools || []).join(', '), { attrs: 'data-tools list="registry-tools"', placeholder: 'calculate, jira.create_issue' }), 'Published tools only; write and destructive calls pause the run for approval') + UI.field('Skills', UI.input((d.skills || []).join(', '), { attrs: 'data-skills list="registry-skills"' })) + UI.field('System prompt', UI.textarea(d.systemPrompt || '', { rows: 3, attrs: 'data-prompt' })) + '</div>'
            + UI.field('Delegates (agents it may call)', UI.input(listOfNames(d.agents).join(', '), { attrs: 'data-delegates list="registry-agents"', placeholder: 'Close broker, Clerk' }), 'Each is offered as the tool agent:<name> and runs as a child run in the chain, within this run\'s remaining budget')
            + UI.field('Handoffs (agents it may hand the conversation to)', UI.input(listOfNames(d.handoffs).join(', '), { attrs: 'data-handoffs list="registry-agents"', placeholder: 'Billing agent' }), 'Offered like a delegate; the handed-to run\'s answer ends this run as its answer, attributed to the specialist') + UI.field('Workflows (it may start and await)', UI.input(listOfNames(d.workflows).join(', '), { attrs: 'data-workflows', placeholder: 'quarterly-variance' }), 'By name or id, in the run\'s workspace; offered as workflow:<name> without publishing them as tools')
            + '<div class="span2">' + UI.field('Input schema (JSON Schema, optional)', UI.textarea(e && e.inputSchema ? pretty(e.inputSchema) : '', { rows: 3, attrs: 'data-in', placeholder: '{ "type": "object", "properties": { "task": { "type": "string" } } }' }), 'What a delegating agent sends; without one it sends {task: string}') + UI.field('Output schema (JSON Schema, optional)', UI.textarea(e && e.outputSchema ? pretty(e.outputSchema) : '', { rows: 3, attrs: 'data-out' }), 'The answer is parsed as JSON and checked against it; a delegating agent gets the object') + '</div>'
            + UI.field('Steps', UI.input(String(b.steps), { type: 'number', attrs: 'data-b="steps"' })) + UI.field('Tokens', UI.input(String(b.tokens), { type: 'number', attrs: 'data-b="tokens"' })) + UI.field('Wall time, seconds', UI.input(String(b.wallSeconds), { type: 'number', attrs: 'data-b="wallSeconds"' })) + UI.field('Tool calls', UI.input(String(b.toolCalls), { type: 'number', attrs: 'data-b="toolCalls"' }))
            + UI.field('Memory write-back', UI.select([{ value: 'off', label: 'Off: read accepted memories only' }, { value: 'propose', label: 'Propose memories for a curator to accept' }], (d.memory && d.memory.write) || 'off', 'data-memwrite'), 'Runs propose through the memory checkpoint; nothing is kept until a knowledge curator accepts it')
            + UI.field('Proposals per run', UI.input(String((d.memory && d.memory.maxPerRun) || 3), { type: 'number', attrs: 'data-memmax min="1" max="20"' }), 'Progress and tool quirks only');
          return common + UI.field('Script', '<select class="select" data-script><option value="">Loading scripts…</option></select>', 'A tested script; the tool runs it with arguments as JSON on stdin') + UI.field('Side-effect class', UI.select([{ value: 'read', label: 'read-only' }, { value: 'write', label: 'write' }, { value: 'destructive', label: 'destructive' }], 'read', 'data-side'), 'write and destructive require confirmation')
            + '<div class="span2">' + UI.field('Input schema (JSON Schema)', UI.textarea('{\n  "type": "object",\n  "properties": {},\n  "required": []\n}', { rows: 5, attrs: 'data-in' })) + UI.field('Output schema (optional)', UI.textarea('', { rows: 3, attrs: 'data-out' })) + '</div>';
        };
        ctx.modal({
          title: e ? 'Edit draft ' + esc(e.name) + ' ' + esc(e.version) : 'Submit entry',
          cls: 'wide',
          body: '<datalist id="registry-tools">' + published.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>'
            + '<datalist id="registry-agents">' + uniq(list.filter((x) => x.kind === 'agent' && (!e || x.name !== e.name) && x.status !== 'retired').map((x) => x.name)).map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>'
            + '<datalist id="registry-skills">' + uniq(list.filter((x) => x.kind === 'skill' && (!e || x.name !== e.name) && x.status !== 'retired').map((x) => x.name)).map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>'
            + (e ? '' : UI.field('Kind', UI.select(kinds, kind, 'data-kind'), 'Tools come from promoted scripts, HTTP requests and approved MCP servers; this form creates script-backed and HTTP tools.'))
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
            const fillVault = () => {
              const s2 = m.querySelector('[data-hvault]'); if (!s2 || !App.can('secrets:read')) return;
              App.get('/api/vault/kv').then((r) => { const paths = (r.secrets || []).map((x) => x.path); s2.innerHTML = paths.length ? paths.map((x) => '<option value="' + esc(x) + '">' + esc(x) + '</option>').join('') : '<option value="">No secrets you may read</option>'; }).catch(() => { s2.innerHTML = '<option value="">The vault could not be listed</option>'; });
            };
            const wireHttp = () => {
              const fill = m.querySelector('[data-hfill]');
              if (fill) fill.addEventListener('click', () => { const names = placeholders(m.querySelector('[data-hurl]').value); m.querySelector('[data-in]').value = pretty({ type: 'object', properties: names.reduce((a, n) => { a[n] = { type: 'string' }; return a; }, {}), required: names }); });
              const ins = m.querySelector('[data-hinsert]');
              if (ins) ins.addEventListener('click', () => { const path = m.querySelector('[data-hvault]').value; const key = m.querySelector('[data-hkey]').value.trim() || 'token'; if (!path) { toast('Pick a vault path first.', 'warn'); return; } const h = m.querySelector('[data-hheaders]'); const kept = h.value.split('\n').filter((l) => l.trim() && !/^authorization\s*:/i.test(l)); h.value = kept.concat(['Authorization: Bearer vault:' + path + '#' + key]).join('\n'); });
              const meth = m.querySelector('[data-hmethod]');
              if (meth) meth.addEventListener('change', () => { const sd = m.querySelector('[data-hside]'); sd.disabled = meth.value === 'GET'; if (meth.value === 'GET') m.querySelector('[data-hbody]').value = 'none'; });
              fillVault();
            };
            const kindSel = m.querySelector('[data-kind]');
            if (kindSel) kindSel.addEventListener('change', () => { k = kindSel.value; m.querySelector('[data-fields]').innerHTML = fields(k); fillScripts(); wireHttp(); });
            fillScripts();
            wireHttp();
            const val = (sel2) => { const x = m.querySelector(sel2); return x ? x.value : ''; };
            const listOf = (sel2) => val(sel2).split(',').map((x) => x.trim()).filter(Boolean);
            m.querySelector('[data-ok]').addEventListener('click', async () => {
              let body;
              try {
                const common = { description: val('[data-desc]').trim() || null, label: val('[data-label]'), purpose: val('[data-purpose]').trim() || null, examples: val('[data-examples]').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 5), category: val('[data-category]').trim() || null };
                if (k === 'skill') body = Object.assign(common, { definition: Object.assign({}, e ? e.definition || {} : {}, { instructions: val('[data-instructions]'), tools: listOf('[data-tools]'), skills: listOf('[data-subskills]') }) });
                else if (k === 'agent') {
                  const bud = {}; m.querySelectorAll('[data-b]').forEach((x) => { bud[x.dataset.b] = Number(x.value); });
                  const inS = val('[data-in]').trim(); const outS = val('[data-out]').trim();
                  body = Object.assign(common, { definition: Object.assign({}, e ? e.definition || {} : {}, { profile: val('[data-profile]').trim(), systemPrompt: val('[data-prompt]') || null, tools: listOf('[data-tools]'), skills: listOf('[data-skills]'), agents: listOf('[data-delegates]'), handoffs: listOf('[data-handoffs]'), workflows: listOf('[data-workflows]'), budgets: bud, memory: { write: val('[data-memwrite]') || 'off', types: ['progress', 'quirk'], maxPerRun: Number(val('[data-memmax]')) || 3 } }) });
                  if (inS) body.inputSchema = JSON.parse(inS); else if (!e) body.inputSchema = null;
                  body.outputSchema = outS ? JSON.parse(outS) : null;
                }
                else if (k === 'http') {
                  const method = val('[data-hmethod]'); const mode = val('[data-hbody]'); const ptr = val('[data-hptr]').trim();
                  const definition = { method: method, url: val('[data-hurl]').trim(), query: linesTo(val('[data-hquery]'), '='), headers: linesTo(val('[data-hheaders]'), ':'), body: mode === 'template' ? { mode: 'template', template: val('[data-htemplate]') } : { mode: mode }, response: { pointer: ptr || null, maxBytes: Math.max(1, Number(val('[data-hcap]')) || 64) * 1024 }, timeoutMs: Math.max(1, Number(val('[data-htimeout]')) || 10) * 1000 };
                  body = Object.assign(common, { sideEffect: method === 'GET' ? 'read' : val('[data-hside]'), inputSchema: JSON.parse(val('[data-in]') || '{}'), outputSchema: val('[data-out]').trim() ? JSON.parse(val('[data-out]')) : null, definition: definition });
                }
                else body = Object.assign(common, { sideEffect: val('[data-side]'), inputSchema: JSON.parse(val('[data-in]') || '{}'), outputSchema: val('[data-out]').trim() ? JSON.parse(val('[data-out]')) : null, definition: { scriptId: val('[data-script]') } });
              } catch (err) { toast('A schema is not valid JSON: ' + esc(err.message), 'danger'); return; }
              App.closeOverlay();
              if (e) { await act(() => App.patch('/api/admin/registry/' + e.id, body), 'Draft ' + esc(e.name) + ' saved. Checks re-ran.'); return; }
              Object.assign(body, { kind: k === 'http' ? 'tool' : k, name: val('[data-name]').trim(), version: val('[data-version]').trim() || '0.1.0' }, k === 'http' ? { impl: 'http' } : {});
              const r = await act(() => App.post('/api/admin/registry', body), 'Draft ' + esc(body.name) + ' ' + esc(body.version) + ' saved. Its checks ran.');
              if (r && r.id) { st.sel = r.id; st.tab = k === 'tool' || k === 'http' ? 'tools' : k + 's'; }
            });
          }
        });
      }
    }
  });
})();
