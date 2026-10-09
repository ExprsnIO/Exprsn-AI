(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  // 1.7.0 (B-12301): GET /api/catalog: the workspace form of a conversation's capabilities, through one profile.
  // `available: false` is an entry the profile's allow-list hides ("not on this profile") with the profiles that offer it.
  const PROFILES = [{ name: 'chat-default', display: 'Chat default' }, { name: 'analyst', display: 'Analyst' }, { name: 'coder', display: 'Coder' }];
  const E = (kind, name, o) => Object.assign({ kind, name, key: kind + ':' + name, version: '1.0.0', label: 'internal', description: '', purpose: '', examples: [], category: 'Other', side: null, available: true, profiles: [], missing: [], isNew: false }, o);
  const ENTRIES = [
    E('workflow', 'summarise-contract', { version: 'v2', description: 'Summarises a contract: the parties, the term, the obligations and the risks, with the clauses cited.', purpose: 'Read a contract and get a one-page summary you can forward.', examples: ['Summarise this contract for me', 'What are the termination terms in the Fabrikam MSA?'], category: 'Documents', isNew: true }),
    E('agent', 'Contract reviewer', { version: '1.2.0', description: 'Reviews an agreement against the playbook and lists the clauses that need a lawyer.', purpose: 'Check a contract before it is signed.', examples: ['Review this NDA for unusual terms'], category: 'Documents', label: 'confidential' }),
    E('skill', 'contract-redline', { version: '2.1.0', description: 'Marks changes against the standard template in redline style.', purpose: 'Answers that show what changed against the template.', examples: ['Redline this clause against our template'], category: 'Documents', available: false, profiles: ['analyst'] }),
    E('tool', 'ledger.query', { version: '1.1.2', side: 'read', description: 'Reads posted ledger lines by cost centre and period.', purpose: 'Look up what was posted, without leaving the chat.', examples: ['What did FIELD-SALES post in September?'], category: 'Finance', label: 'confidential', available: false, profiles: ['analyst'] }),
    E('workflow', 'quarterly-variance', { version: 'v1', description: 'Compares actuals with budget per cost centre and drafts the variance note for approval.', purpose: 'The quarter\'s variance note, drafted and sent for sign-off.', examples: ['Draft the Q3 variance note'], category: 'Finance' }),
    E('agent', 'Data analyst', { version: '4.2.0', description: 'Answers questions over the ledger and the Finance KB with exact calculations.', purpose: 'Questions about the numbers, answered with sources.', examples: ['How far over budget was travel in Q3?'], category: 'Finance', label: 'confidential' }),
    E('tool', 'calculate', { version: 'built-in', side: 'read', description: 'Exact arithmetic by the calculation worker.', purpose: 'Sums and percentages computed exactly, not by the model.', examples: ['What is 17.5% of 48,210?'], category: 'Built in' }),
    E('skill', 'concise', { description: 'Answers in one sentence with the figure first and the source second.', purpose: 'Short answers.', examples: ['What is the refund window?'], category: 'Writing' }),
    E('agent', 'Meeting helper', { version: '0.9.0', description: 'Turns meeting notes into actions and owners.', missing: ['purpose', 'examples', 'category'] })
  ];
  const TRIGGER = { workflow: '/', tool: '/', agent: '@', skill: '+' };
  const callOf = (e) => TRIGGER[e.kind] + e.name;
  const composeOf = (e, example) => (e.kind === 'agent' ? '@' + e.name + ': ' + (example || '') : callOf(e) + ' ' + (example || ''));
  const KIND_LABEL = { workflow: 'Workflows', agent: 'Agents', tool: 'Tools', skill: 'Skills' };

  App.register({
    id: 'catalog', title: 'Catalogue', summary: 'What you can do: the workflows, agents, tools and skills you may use here, by category, with how to call them',
    crumb: ['Catalogue'],
    commands: [{ label: 'Open the catalogue', sub: 'Catalogue', run(app) { app.navigate('catalog'); } }],
    states: [
      { title: 'Newly published', tone: 'info', text: 'A notice links here: the entry is highlighted with a "New" pill, and its card says how to call it.', apply(ctx) { ctx.state.sel = 'workflow:summarise-contract'; ctx.state.fromNotice = true; ctx.rerender(); } },
      { title: 'Not on this profile', tone: 'warn', text: 'An entry the profile\'s allow-list hides is listed as "not on this profile" with the profiles that offer it; switching profile makes it callable.', apply(ctx) { ctx.state.hidden = true; ctx.state.sel = 'tool:ledger.query'; ctx.rerender(); } },
      { title: 'Entry without examples', tone: 'neutral', text: 'An entry published before the catalogue fields existed is listed with what it has, under Other, and opens Chat with only its call filled in.', apply(ctx) { ctx.state.sel = 'agent:Meeting helper'; ctx.rerender(); } },
      { title: 'Nothing published yet', tone: 'neutral', text: 'No workflow, agent, tool or skill is published to this workspace for you yet.', apply(ctx) { ctx.state.empty = true; ctx.rerender(); } },
      { title: 'Above your clearance', tone: 'neutral', text: 'Entries above your clearance are never listed, not even as "not on this profile". The count says nothing about them.', apply(ctx) { ctx.state.clearance = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (st.profile === undefined) st.profile = 'chat-default';
      if (st.kind === undefined) st.kind = 'all';
      if (st.hidden === undefined) st.hidden = true;
      if (ctx.params.entry) { st.sel = ctx.params.entry; st.fromNotice = true; delete ctx.params.entry; }
      const q = (st.query || '').toLowerCase();
      const viaAnalyst = st.profile === 'analyst';
      const all = st.empty ? [] : ENTRIES.map((e) => (viaAnalyst && !e.available ? Object.assign({}, e, { available: true, profiles: [] }) : e));
      const list = all.filter((e) => (st.kind === 'all' || e.kind === st.kind) && (st.hidden || e.available) && (!q || (e.name + ' ' + e.description + ' ' + e.purpose + ' ' + e.examples.join(' ')).toLowerCase().includes(q)));
      const cats = [];
      list.forEach((e) => { if (cats.indexOf(e.category) < 0) cats.push(e.category); });
      cats.sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
      const sel = all.find((e) => e.key === st.sel) || null;

      const cardHtml = (e) => '<div class="cat-card' + (e.available ? '' : ' off') + (sel && sel.key === e.key ? ' on' : '') + '" data-entry="' + esc(e.key) + '">'
        + '<div class="hstack wrap gap6"><button type="button" class="cat-name" data-open="' + esc(e.key) + '">' + esc(e.name) + '</button>' + UI.pill(e.kind, 'outline') + (e.side && e.side !== 'read' ? UI.pill(e.side, 'warn') : '') + (e.isNew ? UI.pill('new', 'info') : '') + '<span class="right">' + UI.label(e.label, { sm: true }) + '</span></div>'
        + '<div class="fg2 cat-desc">' + esc(e.description) + '</div>'
        + (e.examples[0] ? '<div class="cat-ex">"' + esc(e.examples[0]) + '"</div>' : '')
        + '<div class="hstack wrap gap6"><span class="mono cat-call">' + esc(callOf(e)) + '</span>'
        + (e.available ? '<span class="right">' + UI.btn('Use in Chat', { size: 'sm', attrs: 'data-use="' + esc(e.key) + '" aria-label="Use ' + esc(e.name) + ' in Chat"' }) + '</span>'
          : '<span class="muted cat-off">Not on this profile. Offered by ' + e.profiles.map(esc).join(', ') + '</span><span class="right">' + UI.btn('Switch to ' + esc(e.profiles[0]), { size: 'sm', kind: 'ghost', attrs: 'data-switch="' + esc(e.profiles[0]) + '"' }) + '</span>')
        + '</div></div>';

      const inspector = sel ? '<aside class="inspector w320 cat-insp">'
        + '<div class="hstack wrap gap6"><span class="mono" style="font-size:14px">' + esc(sel.name) + '</span>' + UI.pill(sel.kind, 'outline') + UI.label(sel.label, { sm: true }) + '</div>'
        + (st.fromNotice && sel.isNew ? UI.notice('Published to Finance Ops on 9 October. You were notified once; notices are in Settings.', 'info') : '')
        + (sel.available ? '' : UI.notice('<b>Not on this profile.</b> ' + esc(st.profile) + '\'s allow-list leaves it out. ' + esc(sel.profiles.join(', ')) + ' offer' + (sel.profiles.length === 1 ? 's' : '') + ' it.', 'warn'))
        + UI.kv([['Call', '<span class="mono">' + esc(callOf(sel)) + '</span>'], ['Category', esc(sel.category)], ['Purpose', sel.purpose ? esc(sel.purpose) : '<span class="muted">Not given</span>'], ['Version', '<span class="mono">' + esc(sel.version) + '</span>'], ['How to call it', sel.kind === 'agent' ? 'Type @ in the composer, pick the agent, and say what it should do.' : sel.kind === 'skill' ? 'Type + in the composer; the skill rides on the conversation until you remove it.' : sel.kind === 'workflow' ? 'Type / in the composer and pick the workflow; its input is a short form.' : 'Type / in the composer, or let the model call it when it needs it.']], 1)
        + '<div class="eyebrow">Example prompts</div>'
        + (sel.examples.length ? '<div class="vstack gap6">' + sel.examples.map((x, i) => '<div class="hstack gap6"><span class="grow cat-ex">"' + esc(x) + '"</span>' + (sel.available ? UI.btn('Use', { size: 'xs', attrs: 'data-useex="' + i + '" aria-label="Use the example ' + esc(x) + '"' }) : '') + '</div>').join('') + '</div>' : '<div class="muted" style="font-size:12px">No example yet. Its owner can add some in the Registry.</div>')
        + '<div class="hstack">' + (sel.available ? UI.btn('Use in Chat', { kind: 'primary', attrs: 'data-use="' + esc(sel.key) + '"' }) : UI.btn('Switch to ' + esc(sel.profiles[0]), { kind: 'primary', attrs: 'data-switch="' + esc(sel.profiles[0]) + '"' })) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close-insp' }) + '</div>'
        + '</aside>' : '';

      const counts = { available: all.filter((e) => e.available).length, off: all.filter((e) => !e.available).length };
      root.innerHTML = '<style>'
        + '.cat-page > *{flex-shrink:0}.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}'
        + '.cat-card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);min-width:0}.cat-card.on{border-color:var(--accent);background:var(--accent-tint)}.cat-card.off{background:var(--panel2)}'
        + '.cat-name{all:unset;cursor:pointer;font-weight:600;overflow-wrap:anywhere}.cat-name:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.cat-desc{font-size:13px}.cat-ex{font-size:13px;font-style:italic;color:var(--fg2);overflow-wrap:anywhere}.cat-call{font-size:12px;overflow-wrap:anywhere}.cat-off{font-size:12px}'
        + '.cat-head{display:flex;align-items:baseline;gap:8px;margin:18px 0 8px}.cat-head h2{font-size:15px;margin:0}'
        + '</style>'
        + '<div class="page cat-page">' + UI.pagehead('What you can do', 'Workflows, agents, tools and skills you may use in <b>Finance Ops</b> through profile <b>' + esc(st.profile) + '</b>. Pick one to open Chat with it filled in.', '<span class="hstack gap6"><label class="sr" for="cat-profile">Profile</label>' + UI.select(PROFILES.map((p) => ({ value: p.name, label: p.display })), st.profile, 'id="cat-profile" data-profile') + '</span>')
        + (st.clearance ? UI.notice('Entries above your clearance (internal) are never listed here, not even as "not on this profile".', 'info') : '')
        + '<div class="toolbar">' + UI.search('Search names, descriptions and examples', 'data-search', st.query) + UI.seg([{ id: 'all', label: 'All' }, { id: 'workflow', label: 'Workflows' }, { id: 'agent', label: 'Agents' }, { id: 'tool', label: 'Tools' }, { id: 'skill', label: 'Skills' }], st.kind, 'data-kind') + UI.toggle('Show what this profile leaves out', st.hidden, 'data-hidden data-manual') + '<span class="muted right" style="font-size:12px">' + counts.available + ' you can call, ' + counts.off + ' not on this profile</span></div>'
        + (all.length ? (list.length ? cats.map((c) => '<div class="cat-head"><h2>' + esc(c) + '</h2><span class="muted" style="font-size:12px">' + list.filter((e) => e.category === c).length + '</span></div><div class="cat-grid">' + list.filter((e) => e.category === c).map(cardHtml).join('') + '</div>').join('') : UI.empty('Nothing matches', 'Try another word, or show every kind.'))
          : UI.empty('Nothing published for you yet', 'When a workflow, agent, tool or skill is published to Finance Ops within your clearance, it shows here and you get a notice.'))
        + '</div>' + inspector;

      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-kind] [data-seg]', (e, t) => { st.kind = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-hidden]', () => { st.hidden = !st.hidden; ctx.rerender(); });
      ctx.on('change', '[data-profile]', (e, t) => { st.profile = t.value; ctx.rerender(); ctx.toast('Listing what you can call through ' + esc(t.value) + '.'); });
      ctx.on('click', '[data-open]', (e, t) => { st.sel = t.dataset.open; st.fromNotice = false; ctx.rerender(); });
      ctx.on('click', '[data-close-insp]', () => { st.sel = null; ctx.rerender(); });
      ctx.on('click', '[data-switch]', (e, t) => { st.profile = t.dataset.switch; ctx.rerender(); ctx.toast('Profile set to ' + esc(t.dataset.switch) + '. Its entries are callable now.', 'ok'); });
      const use = (e, example) => { App.stateFor('chat').convo = 'new'; App.stateFor('chat').fill = composeOf(e, example); ctx.navigate('chat', { fill: e.key }); };
      ctx.on('click', '[data-use]', (e, t) => { const x = all.find((y) => y.key === t.dataset.use); if (x) use(x, x.examples[0]); });
      ctx.on('click', '[data-useex]', (e, t) => { if (sel) use(sel, sel.examples[+t.dataset.useex]); });
    }
  });
})();
