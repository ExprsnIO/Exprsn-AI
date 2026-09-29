(function () {
  const { UI, esc } = App;

  const CONVOS = [
    { id: 'c1', title: 'Q3 travel overrun', meta: 'analyst, 2 min ago', label: 'confidential', profile: 'analyst' },
    { id: 'c2', title: 'Vendor contract summary', meta: 'chat-default, 1 h ago', label: 'internal', profile: 'chat-default' },
    { id: 'c3', title: 'Rewrite onboarding email', meta: 'fast, yesterday', label: 'public', profile: 'fast' },
    { id: 'c4', title: 'Reconcile card feed', meta: 'Data analyst agent, Mon', label: 'confidential', profile: 'Data analyst agent' },
    { id: 'c5', title: 'Policy wording check', meta: 'chat-default, Mon', label: 'internal', profile: 'chat-default' }
  ];
  const PROFILES = [
    { id: 'analyst', model: 'qwen2.5:32b-q4_K_M', ceiling: 'confidential', thinking: 'high' },
    { id: 'chat-default', model: 'llama3.1:8b-q5_K_M', ceiling: 'confidential', thinking: 'medium' },
    { id: 'fast', model: 'llama3.1:8b-q5_K_M', ceiling: 'internal', thinking: 'off' },
    { id: 'coder', model: 'qwen2.5-coder:32b-q4_K_M', ceiling: 'internal', thinking: 'medium' },
    { id: 'Data analyst agent', model: 'qwen2.5:32b-q4_K_M', ceiling: 'confidential', thinking: 'high', agent: true }
  ];
  const THREADS = {
    c1: [
      { role: 'user', text: 'How far over budget was travel in Q3, and what explains it? Use the Finance KB and the ledger.' },
      { role: 'assistant', thinking: { secs: 6, level: 'medium', tokens: 412, text: 'The user wants a variance and a cause. Query the ledger for Q3 travel actuals by cost centre, then look for an approved exception in the Finance KB before attributing the overrun.' },
        raised: 'Finance KB', ctx: { title: 'ledger.query, 14 rows', level: 'confidential', body: 'cost_centre, q3_actual, q3_budget\nFIELD-SALES, 188420.00, 150000.00\nLIS-ONBOARD, 96310.00, 60000.00' },
        paras: ['Travel spend for Q3 came to 412,880 EUR against a budget of 361,500 EUR, an overrun of <button type="button" class="btn xs" data-calc="(412880-361500)/361500 = 0.1421">14.2%</button><a href="#" class="cite" data-cite="1">1</a>. Two cost centres account for most of it: Field Sales and the Lisbon onboarding programme<a href="#" class="cite" data-cite="2">2</a>.', 'The approved exception for Lisbon covers 38,000 EUR of the difference, so the unexplained overrun is closer to 13,380 EUR<a href="#" class="cite" data-cite="1">1</a>.'],
        meta: 'analyst, qwen2.5:32b, 1,204 tokens, 9.1 s', branch: [2, 2],
        confirm: { title: 'Confirm action: create Jira issue', tool: 'jira-internal.create_issue', args: 'project=FIN  summary="Q3 travel overrun review"', note: 'Acts as you through Data analyst agent. Tool ceiling: confidential.' },
        memory: 'Reports travel figures in EUR, net of VAT' }
    ],
    c2: [
      { role: 'user', text: 'Summarise the Fabrikam maintenance contract, especially termination terms.' },
      { role: 'assistant', thinking: { secs: 2, level: 'low', tokens: 96, text: 'Find the termination clause and notice period.' }, ctx: { title: 'Contracts KB, Fabrikam MSA 2025.pdf, page 11', level: 'internal', body: 'Either party may terminate for convenience on ninety (90) days written notice.' },
        paras: ['The contract runs to 31 March 2027 with automatic annual renewal. Either side can terminate for convenience on 90 days written notice<a href="#" class="cite" data-cite="2">2</a>, and Northwind can terminate for cause within 30 days of an unremedied breach.', 'Service credits cap at 15% of the monthly fee; there is no uncapped liability clause.'], meta: 'chat-default, llama3.1:8b, 640 tokens, 3.2 s', branch: [1, 1] }
    ],
    c3: [
      { role: 'user', text: 'Make this onboarding email friendlier and shorter.' },
      { role: 'assistant', paras: ['Welcome to Northwind. Your laptop and badge are ready at the front desk from 9:00 on Monday, and your buddy, Sam, will meet you there. Bring photo ID. See you then.'], meta: 'fast, llama3.1:8b, 118 tokens, 0.9 s', branch: [1, 1] }
    ],
    c4: [
      { role: 'user', text: 'Reconcile last week\'s card feed against the ledger and list unmatched lines.' },
      { role: 'assistant', thinking: { secs: 14, level: 'high', tokens: 1880, text: 'Plan: pull card transactions, join on amount and date within two days, report residue.' }, ctx: { title: 'cards.query, 212 rows joined to ledger.query, 209 rows', level: 'confidential', body: 'unmatched: 3 lines, total 1,842.10 EUR' },
        paras: ['Three card lines have no ledger match: two Lisbon hotel charges of 412.00 EUR each on 12 and 13 September, and one 1,018.10 EUR airfare on 9 September. All three sit under LIS-ONBOARD<a href="#" class="cite" data-cite="1">1</a>.'], meta: 'Data analyst agent, qwen2.5:32b, 2,904 tokens, 21.4 s', branch: [1, 1] }
    ],
    c5: [
      { role: 'user', text: 'Does the expense policy allow taxis after 22:00 without pre-approval?' },
      { role: 'assistant', ctx: { title: 'Policy KB, Travel policy v7.md, section 4.3', level: 'internal', body: 'Taxis after 22:00 need no pre-approval where public transport has stopped running.' },
        paras: ['Yes, when public transport has stopped for the night. Section 4.3 of Travel policy v7 waives pre-approval for taxis after 22:00 in that case<a href="#" class="cite" data-cite="2">2</a>; a receipt is still required.'], meta: 'chat-default, llama3.1:8b, 402 tokens, 2.1 s', branch: [1, 1] }
    ]
  };
  const SOURCES = {
    c1: [{ n: 1, title: 'ledger.query result', sub: 'Tool result, 14 rows, this turn' }, { n: 2, title: 'Q3 cost centre review.pdf', sub: 'Finance KB, page 4, score 0.83' }],
    c2: [{ n: 1, title: 'Fabrikam MSA 2025.pdf', sub: 'Contracts KB, page 3, score 0.91' }, { n: 2, title: 'Fabrikam MSA 2025.pdf', sub: 'Contracts KB, page 11, score 0.88' }],
    c3: [], c4: [{ n: 1, title: 'cards.query ⋈ ledger.query', sub: 'Tool result, 3 rows, this turn' }], c5: [{ n: 2, title: 'Travel policy v7.md', sub: 'Policy KB, section 4.3, score 0.94' }]
  };

  App.register({
    id: 'chat', title: 'Chat', summary: 'Conversation list, thinking trace, citations, tool confirmations, memory proposals',
    crumb: (st) => ['Chat', (CONVOS.find((c) => c.id === (st.convo || 'c1')) || CONVOS[0]).title],
    label: (st) => (CONVOS.find((c) => c.id === (st.convo || 'c1')) || CONVOS[0]).label,
    commands: [
      { label: 'New conversation', sub: 'Chat', run(app) { app.stateFor('chat').convo = 'new'; app.render(); } },
      { label: 'Run a workflow from this conversation', sub: 'Chat', run(app) { app.stateFor('chat').runWorkflow = true; app.render(); } }
    ],
    states: [
      { title: 'Model cold start', tone: 'neutral', text: 'analyst is loading on gpu-large-2, about 20 s. The composer stays usable and the message queues.', apply(ctx) { ctx.state.cold = true; ctx.rerender(); setTimeout(() => { ctx.state.cold = false; ctx.rerender(); ctx.toast('analyst is warm on gpu-large-2. Queued message sent.', 'ok'); }, 6000); } },
      { title: 'Guardrail stop', tone: 'danger', text: 'Streaming stops at the sentence boundary. The partial answer is replaced with the rule name and a report link.', apply(ctx) { ctx.state.guardStop = true; ctx.rerender(); } },
      { title: 'Stream resumed', tone: 'info', text: 'Connection dropped at event 212 and resumed with no duplicate text. A quiet marker shows the gap.', apply(ctx) { ctx.state.resumed = true; ctx.rerender(); } },
      { title: 'Ungrounded figure', tone: 'warn', text: 'A number with no calc result or cited source gets a dotted underline and a flag entry.', apply(ctx) { ctx.state.ungrounded = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.convo) { st.convo = ctx.params.convo; }
      st.convo = st.convo || 'c1'; st.sent = st.sent || {}; st.decided = st.decided || {}; st.memories = st.memories || {}; st.query = st.query || '';
      st.thinking = st.thinking || {}; st.level = st.level || 'medium';
      const isNew = st.convo === 'new';
      const convo = isNew ? { id: 'new', title: 'New conversation', label: 'internal', profile: st.profile || 'chat-default' } : CONVOS.find((c) => c.id === st.convo) || CONVOS[0];
      if (st.profile) convo.profile = st.profile;
      const prof = PROFILES.find((p) => p.id === convo.profile) || PROFILES[1];
      const thread = (isNew ? [] : THREADS[convo.id] || []).concat(st.sent[convo.id] || []);
      const sources = SOURCES[convo.id] || [];
      const list = CONVOS.filter((c) => !st.query || c.title.toLowerCase().includes(st.query.toLowerCase()));

      const renderMsg = (m, i) => {
        if (m.role === 'user') return '<div class="msg user"><div class="bubble">' + esc(m.text) + '</div><div class="uactions">' + UI.iconbtn('edit', 'Edit and branch', { cls: 'sm ghost', attrs: 'data-edit="' + i + '"' }) + '</div></div>';
        if (m.streaming) return '<div class="msg ai"><div class="thinkbar"><span>' + (m.phase === 'thinking' ? 'Thinking at level ' + esc(st.level) + '…' : 'Answering…') + '</span><span class="muted">' + UI.btn('Stop', { kind: 'ghost', size: 'xs', attrs: 'data-stop' }) + '</span></div><div class="answer serif">' + m.partial + '<span class="blink">▍</span></div></div>';
        const open = st.thinking[i];
        let h = '<div class="msg ai">';
        if (m.thinking) h += '<button type="button" class="thinkbar" data-think="' + i + '"><span>' + UI.icon('brain', 13) + ' Thought for ' + m.thinking.secs + ' s at level ' + esc(m.thinking.level) + ', ' + m.thinking.tokens + ' tokens</span><span>' + (open ? 'Hide' : 'Show') + '</span></button>' + (open ? '<div class="thinktrace">' + esc(m.thinking.text) + '</div>' : '');
        if (m.raised) h += '<div class="raised"><span class="rule"></span>Label raised to ' + UI.label('confidential', { sm: true }) + ' by ' + esc(m.raised) + '<span class="rule"></span></div>';
        if (m.ctx) h += UI.ctx(m.ctx.title, m.ctx.body, m.ctx.level);
        if (st.guardStop && i === thread.length - 1) {
          h += '<div class="answer serif"><p>' + m.paras[0].replace(/<a[^>]*>\d<\/a>/g, '') + '</p></div>' + UI.notice('<b>Stopped by guardrail</b> Finance baseline v12, rule <span class="mono">no-personal-data-in-summaries</span>. The rest of this answer was withheld at the sentence boundary.', 'danger', '<a href="#" data-report="' + i + '">Report</a>');
        } else {
          h += '<div class="answer serif">' + m.paras.map((p, pi) => '<p>' + (st.ungrounded && pi === m.paras.length - 1 ? p.replace('13,380 EUR', '<span class="ungrounded" title="No calculation result or cited source backs this figure. Logged to flags.">13,380 EUR</span>') : p) + (st.resumed && pi === 0 ? '<span class="gap" title="Connection dropped at event 212 and resumed"> ⋯ </span>' : '') + '</p>').join('') + '</div>';
        }
        h += '<div class="mactions">' + UI.iconbtn('copy', 'Copy', { cls: 'sm', attrs: 'data-copy="answer"' }) + UI.iconbtn('refresh', 'Regenerate', { cls: 'sm', attrs: 'data-regen="' + i + '"' }) + UI.iconbtn('branch', 'Branch from here', { cls: 'sm', attrs: 'data-branchmsg="' + i + '"' }) + UI.iconbtn('flag', 'Report this answer', { cls: 'sm', attrs: 'data-report="' + i + '"' }) + (m.branch ? '<span class="hstack gap4">' + UI.iconbtn('chev', 'Previous branch', { cls: 'sm ghost', attrs: 'data-branch="prev" style="transform:rotate(180deg)"' }) + '<span>Branch ' + m.branch[0] + ' of ' + m.branch[1] + '</span>' + UI.iconbtn('chev', 'Next branch', { cls: 'sm ghost', attrs: 'data-branch="next"' }) + '</span>' : '') + '<span class="right muted">' + esc(m.meta || '') + '</span></div>';
        if (m.confirm && !st.decided[convo.id + i]) h += '<div class="confirmcard"><div class="hstack"><b>' + esc(m.confirm.title) + '</b>' + UI.pill('write', 'warn') + '</div><div class="mono fg2">' + esc(m.confirm.tool) + '  ' + esc(m.confirm.args) + '</div><div class="hstack wrap"><span class="fg2 grow" style="font-size:12px">' + esc(m.confirm.note) + '</span><span class="hstack gap6">' + UI.btn('Deny', { size: 'sm', attrs: 'data-deny="' + i + '"' }) + UI.btn('Allow once', { kind: 'primary', size: 'sm', attrs: 'data-allow="' + i + '"' }) + '</span></div></div>';
        if (m.confirm && st.decided[convo.id + i]) h += '<div class="decided ' + (st.decided[convo.id + i] === 'allow' ? 'ok' : '') + '">' + UI.icon(st.decided[convo.id + i] === 'allow' ? 'check' : 'x', 13) + (st.decided[convo.id + i] === 'allow' ? ' Created <a href="#" data-jira>FIN-1187</a> in jira-internal as Mara Okafor. Logged to audit.' : ' Denied. The agent was told the action was refused and continued without it.') + '</div>';
        if (m.memory && !st.memories[convo.id + i]) h += '<div class="memprop"><span class="grow">Remember: "' + esc(m.memory) + '"</span>' + UI.btn('Save', { size: 'sm', attrs: 'data-memsave="' + i + '"' }) + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-memdismiss="' + i + '"' }) + '</div>';
        return h + '</div>';
      };

      root.innerHTML = '<style>'
        + '.chat-list{display:flex;flex-direction:column;gap:2px}'
        + '.chat-thread{display:flex;flex-direction:column;gap:14px;padding:20px 24px;max-width:760px;width:100%;margin:0 auto}'
        + '.msg.user{display:flex;justify-content:flex-end;align-items:flex-end;gap:6px}.msg.user .bubble{max-width:560px;padding:10px 14px;background:var(--bubble);border-radius:12px 12px 2px 12px;font-size:14px}.msg.user .uactions{opacity:0}.msg.user:hover .uactions{opacity:1}'
        + '.msg.ai{display:flex;flex-direction:column;gap:10px;max-width:640px}'
        + '.thinkbar{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);font-size:12px;color:var(--fg2);cursor:pointer;font-family:inherit;text-align:left}.thinkbar span{display:inline-flex;align-items:center;gap:6px}'
        + '.thinktrace{padding:10px 12px;border-left:2px solid var(--line);font-size:13px;color:var(--fg2);font-style:italic}'
        + '.raised{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}.raised .rule{flex-grow:1;height:1px;background:var(--line)}'
        + '.answer{font-size:16px;line-height:1.55}.answer p{margin:0 0 10px}.answer p:last-child{margin:0}.answer .cite{display:inline-block;margin-left:2px;font-size:11px;font-weight:700;vertical-align:super;text-decoration:none;font-family:var(--sans)}.answer .btn.xs{vertical-align:baseline;font-family:var(--sans);margin:0 2px}'
        + '.answer .ungrounded{border-bottom:2px dotted var(--warn-fg);cursor:help}.answer .gap{color:var(--muted);font-size:12px}'
        + '.mactions{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);flex-wrap:wrap}'
        + '.confirmcard{display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--accent-tint);border:1px solid var(--accent);border-radius:6px}'
        + '.decided{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--fg2)}.decided.ok{color:var(--ok-fg)}'
        + '.memprop{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px dashed var(--line);border-radius:6px;font-size:13px}'
        + '.composer{border-top:1px solid var(--line);background:var(--bg);padding:12px 24px 16px}.composer .inner{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:8px}'
        + '.composer textarea{width:100%;min-height:64px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:14px;resize:vertical;line-height:1.4}'
        + '.src{display:flex;gap:8px;align-items:flex-start;padding:8px;border-radius:5px;cursor:pointer}.src:hover,.src.hi{background:var(--accent-tint)}.src .n{width:18px;height:18px;border-radius:50%;background:var(--sel);font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}'
        + '.coldbar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--info-bg);color:var(--info-fg);font-size:12px;border-radius:6px}'
        + '</style>'
        + '<div class="leftpane">' + UI.btn('New conversation', { icon: 'plus', cls: 'block', attrs: 'data-new' }) + UI.search('Search conversations', 'data-search', st.query).replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="chat-list">' + list.map((c) => UI.listItem(esc(c.title), esc(c.meta), { active: c.id === convo.id, attrs: 'data-convo="' + c.id + '"', right: UI.label(c.label, { sm: true }) })).join('') + (list.length ? '' : UI.empty('No conversations match', 'Try another word or start a new conversation.')) + '</div></div>'
        + '<div class="page tight" style="display:flex;flex-direction:column">'
        + '<div class="grow" style="overflow:auto"><div class="chat-thread" id="thread">'
        + (st.cold ? '<div class="coldbar">' + UI.icon('clock', 14) + '<span class="grow"><b>' + esc(prof.id) + '</b> is loading on gpu-large-2, about 20 s. Your message will send when it is warm.</span><span class="skeleton" style="width:80px"></span></div>' : '')
        + (thread.length ? thread.map(renderMsg).join('') : UI.empty('Start with a question', 'Pick a profile, attach files or a knowledge base, and ask. Answers cite their sources and show their label.', UI.btn('Ask about Q3 travel', { size: 'sm', attrs: 'data-suggest' })))
        + (st.runWorkflow ? '<div class="panel" style="gap:8px"><div class="phead"><div class="eyebrow">Run workflow: video-to-notes v3</div>' + UI.pill('running', 'info') + '</div>' + UI.timeline([{ title: 'Extract frames', text: 'media worker, 48 frames', tone: 'ok' }, { title: 'Transcribe audio', text: 'whisper, 12 min of audio', tone: 'ok' }, { title: 'Summarise', text: 'analyst, thinking medium', tone: 'accent' }, { title: 'Guardrail check', text: 'waiting', tone: '' }]) + '<div>' + UI.btn('Open in Runs', { size: 'sm', attrs: 'data-goruns' }) + '</div></div>' : '')
        + '</div></div>'
        + '<div class="composer"><div class="inner"><div class="hstack wrap gap6"><span class="relative">' + UI.chip(UI.icon('profiles', 12) + ' ' + esc(prof.id) + (prof.agent ? '' : ' · ' + esc(prof.model.split(':')[0])), true, 'data-pick="profile"') + '</span><span class="relative">' + UI.chip(UI.icon('knowledge', 12) + ' Finance KB', true, 'data-pick="kb"') + '</span>' + UI.chip('Travel policy', true, 'data-toggle') + UI.chip(UI.icon('attach', 12) + ' q3-ledger.csv, scanned ' + UI.label('confidential', { sm: true }), true, 'data-attach') + '<span class="relative">' + UI.chip(UI.icon('brain', 12) + ' Thinking: ' + esc(st.level), false, 'data-pick="level"') + '</span></div>'
        + '<label class="sr" for="composer">Message</label><textarea id="composer" placeholder="Ask about the Finance KB, attach a file, or type / for a workflow"></textarea>'
        + '<div class="hstack"><div class="hstack gap6">' + UI.iconbtn('attach', 'Attach a file', { attrs: 'data-attachbtn' }) + UI.iconbtn('workflows', 'Run a workflow', { attrs: 'data-wf' }) + UI.iconbtn('images', 'Generate an image', { attrs: 'data-img' }) + '</div><div class="hstack right gap12"><span class="muted num" style="font-size:12px">18,400 of 32,768 context tokens</span>' + UI.btn('Send', { kind: 'primary', icon: 'send', attrs: 'data-send' }) + '</div></div></div></div></div>'
        + '<aside class="inspector w300"><div class="eyebrow">Sources</div><div class="vstack gap4" id="sources">' + (sources.length ? sources.map((s) => '<div class="src" data-src="' + s.n + '"><span class="n">' + s.n + '</span><span><span style="font-weight:600;display:block">' + esc(s.title) + '</span><span class="muted" style="font-size:12px">' + esc(s.sub) + '</span></span></div>').join('') : '<div class="muted" style="font-size:12px">No sources cited in this conversation.</div>') + '</div>'
        + '<div class="eyebrow">This turn</div>' + UI.kv([['Profile', '<a href="#" data-goprofile>' + esc(prof.id) + '</a>'], ['Model', '<span class="mono">' + esc(prof.model) + '</span>'], ['Guardrails', 'Finance baseline v12, ' + (st.guardStop ? '<span style="color:var(--danger-fg)">1 stop</span>' : '0 triggers')], ['Calculations', st.ungrounded ? '2 exact, <span style="color:var(--warn-fg)">1 ungrounded figure</span>' : '2 exact, 0 ungrounded figures'], ['Trace', '<span class="mono">4bf92f3577b34da6</span> ' + UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copy="4bf92f3577b34da6"' })]], 1)
        + '<div class="eyebrow">Quota today</div>' + UI.meter('Tokens', '310k of 500k', 62) + UI.meter('GPU-seconds this month', '16,380 of 18,000', 91, 'warn') + '</aside>';

      // ---- events ----
      ctx.on('click', '[data-convo]', (e, t) => { st.convo = t.dataset.convo; st.guardStop = st.resumed = st.ungrounded = false; ctx.rerender(); });
      ctx.on('click', '[data-new]', () => { st.convo = 'new'; ctx.rerender(); setTimeout(() => { const c = ctx.$('#composer'); if (c) c.focus(); }, 30); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-think]', (e, t) => { st.thinking[t.dataset.think] = !st.thinking[t.dataset.think]; ctx.rerender(); });
      ctx.on('click', '.cite', (e, t) => { e.preventDefault(); const s = ctx.$('.src[data-src="' + t.dataset.cite + '"]'); ctx.$$('.src').forEach((x) => x.classList.remove('hi')); if (s) { s.classList.add('hi'); s.scrollIntoView({ block: 'nearest' }); } });
      ctx.on('click', '.src', (e, t) => {
        const s = sources.find((x) => String(x.n) === t.dataset.src);
        ctx.drawer({ title: esc(s.title), body: '<div class="fg2">' + esc(s.sub) + '</div>' + UI.kv([['Label', UI.label(convo.label)], ['Retrieved', 'hybrid search, rerank 0.83']], 2) + UI.ctx('Passage used', s.title.includes('query') ? 'cost_centre, q3_actual, q3_budget\nFIELD-SALES, 188420.00, 150000.00\nLIS-ONBOARD, 96310.00, 60000.00' : 'Field Sales exceeded its travel allocation in each month of the quarter. The Lisbon onboarding programme carried an approved exception of 38,000 EUR.', convo.label), actions: UI.btn('Open in Knowledge', { attrs: 'data-close data-gokb' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { d.querySelector('[data-gokb]').addEventListener('click', () => ctx.navigate('knowledge', { kb: 'finance' })); } });
      });
      ctx.on('click', '[data-calc]', (e, t) => { ctx.modal({ title: 'Exact calculation', body: UI.code(t.dataset.calc, 'calc') + '<div class="fg2">Computed by the calculating worker, not by the model. Inputs come from the ledger.query result on this turn.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) }); });
      ctx.on('click', '[data-allow]', (e, t) => { st.decided[convo.id + t.dataset.allow] = 'allow'; ctx.rerender(); ctx.toast('jira-internal.create_issue ran as Mara Okafor. Audit entry written.', 'ok'); });
      ctx.on('click', '[data-deny]', (e, t) => { st.decided[convo.id + t.dataset.deny] = 'deny'; ctx.rerender(); ctx.toast('Action denied. Nothing was written.'); });
      ctx.on('click', '[data-memsave]', (e, t) => { st.memories[convo.id + t.dataset.memsave] = 'saved'; ctx.rerender(); ctx.toast('Saved to your memories as <b>internal</b>. Manage it under Memory.', 'ok'); });
      ctx.on('click', '[data-memdismiss]', (e, t) => { st.memories[convo.id + t.dataset.memdismiss] = 'dismissed'; ctx.rerender(); });
      ctx.on('click', '[data-report]', (e, t) => { e.preventDefault(); ctx.modal({ title: 'Report this answer', body: UI.field('Reason', UI.select(['Wrong or unsupported figure', 'Leaked something it should not', 'Guardrail stopped a legitimate answer', 'Offensive or unsafe', 'Other'], 'Wrong or unsupported figure')) + UI.field('Details', UI.textarea('', { placeholder: 'What should the reviewer look at?', rows: 3 })) + UI.notice('The flagged span, this turn\'s trace and label go to the flag queue. Reviewers see the conversation only up to this turn.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send to flag queue', { kind: 'primary', attrs: 'data-sendflag' }), onMount(m) { m.querySelector('[data-sendflag]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Flag F-2297 created, severity medium. <a href="#/flags?id=F-2297" style="color:inherit">Open</a>', 'ok', 6000); }); } }); });
      ctx.on('click', '[data-regen]', (e, t) => { stream(ctx, st, convo, thread, thread[+t.dataset.regen - 1].text, true); });
      ctx.on('click', '[data-branchmsg]', (e, t) => { ctx.toast('Branch 3 of 3 created from this turn. Earlier branches stay in the tree.'); const m = thread[+t.dataset.branchmsg]; if (m.branch) m.branch = [m.branch[1] + 1, m.branch[1] + 1]; ctx.rerender(); });
      ctx.on('click', '[data-branch]', (e, t) => { const m = thread.find((x) => x.branch); if (!m) return; m.branch[0] = t.dataset.branch === 'next' ? Math.min(m.branch[1], m.branch[0] + 1) : Math.max(1, m.branch[0] - 1); ctx.rerender(); });
      ctx.on('click', '[data-edit]', (e, t) => { const m = thread[+t.dataset.edit]; ctx.$('#composer').value = m.text; ctx.$('#composer').focus(); ctx.toast('Editing creates a new branch from this turn when you send.'); });
      ctx.on('click', '[data-suggest]', () => { ctx.$('#composer').value = 'How far over budget was travel in Q3, and what explains it?'; ctx.$('#composer').focus(); });
      ctx.on('click', '[data-send]', () => send(ctx, st, convo, thread));
      ctx.on('keydown', '#composer', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ctx, st, convo, thread); } });
      ctx.on('click', '[data-stop]', () => { const m = thread[thread.length - 1]; if (m && m.streaming) { clearTimeout(st.timer); thread.pop(); st.sent[convo.id].pop(); ctx.rerender(); ctx.toast('Cancelled. The GPU slot is released through the gateway.'); } });
      ctx.on('click', '[data-pick]', (e, t) => {
        const host = t.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
        const d = document.createElement('div'); d.className = 'dropdown'; d.style.top = 'auto'; d.style.bottom = 'calc(100% + 4px)';
        if (t.dataset.pick === 'profile') d.innerHTML = '<div class="dh">Profiles allowed by policy</div>' + PROFILES.map((p) => '<button type="button" data-prof="' + esc(p.id) + '" class="' + (p.id === prof.id ? 'on' : '') + '"><span class="grow">' + esc(p.id) + (p.agent ? ' <span class="pill outline">agent</span>' : '') + '</span>' + UI.label(p.ceiling, { sm: true }) + '</button>').join('') + '<div class="dh">Hidden: 2 profiles above your clearance</div>';
        else if (t.dataset.pick === 'kb') d.innerHTML = '<div class="dh">Knowledge bases</div>' + ['Finance KB', 'Policy KB', 'Contracts KB', 'Engineering wiki'].map((k, i) => '<button type="button" data-kb="' + k + '" class="' + (i === 0 ? 'on' : '') + '">' + k + '</button>').join('');
        else d.innerHTML = '<div class="dh">Thinking level, ceiling high</div>' + ['off', 'low', 'medium', 'high'].map((l) => '<button type="button" data-level="' + l + '" class="' + (l === st.level ? 'on' : '') + '">' + l + '</button>').join('');
        host.appendChild(d);
        d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; if (b.dataset.prof) { st.profile = b.dataset.prof; ctx.toast('Profile set to ' + esc(b.dataset.prof) + ' for this conversation.'); } if (b.dataset.level) { st.level = b.dataset.level; } if (b.dataset.kb) { ctx.toast(b.dataset.kb + ' attached to this conversation.'); } d.remove(); ctx.rerender(); });
      });
      ctx.on('click', '[data-attach], [data-attachbtn]', () => ctx.modal({ title: 'Attachments', body: UI.table(['File', 'Scan', 'Label', 'Size'], [['<span class="mono">q3-ledger.csv</span>', UI.pill('clean', 'ok'), UI.label('confidential', { sm: true }), '84 KB']], { clickable: false, minWidth: '0' }) + UI.notice('Uploads go to quarantine first. They join the context only after the scan and classification jobs pass.', 'info'), actions: UI.btn('Upload another', { icon: 'upload', attrs: 'data-close data-up' }) + UI.btn('Done', { kind: 'primary', attrs: 'data-close' }), onMount(m) { m.querySelector('[data-up]').addEventListener('click', () => ctx.toast('travel-exceptions.xlsx queued: scanning, then classifying.', '', 4000)); } }));
      ctx.on('click', '[data-wf]', () => ctx.modal({ title: 'Run a workflow', body: '<div class="vstack gap6">' + ['video-to-notes v3', 'quarterly-variance v1', 'contract-redline v2'].map((w, i) => UI.listItem(esc(w), i === 0 ? 'Media, transcribe, summarise, guardrail check' : i === 1 ? 'Ledger query, calculate, draft, approval' : 'Contracts KB, diff, draft', { attrs: 'data-runwf' })).join('') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }), onMount(m) { m.querySelectorAll('[data-runwf]').forEach((b) => b.addEventListener('click', () => { App.closeOverlay(); st.runWorkflow = true; ctx.rerender(); ctx.toast('Workflow started. Steps report live below the thread.'); })); } }));
      ctx.on('click', '[data-goruns]', () => ctx.navigate('runs'));
      ctx.on('click', '[data-img]', () => ctx.navigate('images'));
      ctx.on('click', '[data-goprofile]', (e) => { e.preventDefault(); ctx.navigate('profiles', { profile: prof.id }); });
      ctx.on('click', '[data-jira]', (e) => { e.preventDefault(); ctx.toast('External links open after a confirmation because jira-internal is an allow-listed internal domain.'); });
      const th = ctx.$('#thread'); if (th) th.scrollTop = th.scrollHeight;
      if (ctx.params.convo) { delete ctx.params.convo; }
    }
  });

  function send(ctx, st, convo, thread) {
    const ta = ctx.$('#composer'); const text = (ta.value || '').trim(); if (!text) { ctx.toast('Type a message first.'); return; }
    ta.value = '';
    stream(ctx, st, convo, thread, text, false);
  }
  function stream(ctx, st, convo, thread, text, regen) {
    const key = convo.id; st.sent[key] = st.sent[key] || [];
    if (!regen) st.sent[key].push({ role: 'user', text });
    if (st.cold) { ctx.toast('Queued until analyst is warm.'); return; }
    const answer = 'Based on the ledger and the Finance KB, the figure you are asking about is grounded in the same Q3 rows as before. Field Sales remains the largest contributor, and the Lisbon exception still explains most of the rest. I can break this down by month if that helps.';
    const msg = { role: 'assistant', streaming: true, phase: 'thinking', partial: '' }; st.sent[key].push(msg);
    ctx.rerender();
    const words = answer.split(' '); let i = 0;
    const tick = () => {
      if (msg.phase === 'thinking') { msg.phase = 'answer'; st.timer = setTimeout(tick, 400); ctx.rerender(); return; }
      msg.partial += (i ? ' ' : '') + esc(words[i]); i++;
      const el = ctx.$('.msg.ai:last-of-type .answer'); if (el) el.innerHTML = msg.partial + '<span class="blink">▍</span>';
      if (i < words.length) st.timer = setTimeout(tick, 45); else { delete msg.streaming; msg.thinking = { secs: 3, level: st.level, tokens: 210, text: 'Reuse the Q3 rows already in context; no new tool call is needed.' }; msg.paras = [answer + '<a href="#" class="cite" data-cite="1">1</a>']; msg.meta = (st.profile || convo.profile) + ', ' + (words.length * 2 + 60) + ' tokens, ' + (2 + Math.round(words.length / 20)) + '.4 s'; msg.branch = regen ? [2, 2] : [1, 1]; ctx.rerender(); }
    };
    st.timer = setTimeout(tick, st.level === 'off' ? 50 : 1200);
  }
})();
