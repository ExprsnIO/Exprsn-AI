(function () {
  const { UI, esc } = App;

  const CONVOS = [
    { id: 'c1', title: 'Q3 travel overrun', meta: 'analyst, 2 min ago', label: 'confidential', profile: 'analyst' },
    { id: 'c2', title: 'Vendor contract summary', meta: 'chat-default, 1 h ago', label: 'internal', profile: 'chat-default' },
    { id: 'c3', title: 'Rewrite onboarding email', meta: 'fast, yesterday', label: 'public', profile: 'fast' },
    { id: 'c4', title: 'Reconcile card feed', meta: 'Data analyst agent, Mon', label: 'confidential', profile: 'Data analyst agent' },
    { id: 'c5', title: 'Policy wording check', meta: 'chat-default, Mon', label: 'internal', profile: 'chat-default' },
    { id: 'c6', title: 'Landing page draft', meta: 'coder, Tue', label: 'internal', profile: 'coder' },
    { id: 'c7', title: 'Vendor onboarding (tools and agents)', meta: 'chat-default, 5 min ago', label: 'confidential', profile: 'chat-default' }
  ];
  // 1.7.0 (B-4001): what this conversation may call: the profile's tools, the published agents and skills within the
  // conversation's ceiling, the workspace's published workflows. Hidden entries carry the reason.
  const CAPS = {
    tools: [
      { name: 'calculate', side: 'read', confirm: 'never', desc: 'Exact arithmetic by the calculation worker.' },
      { name: 'jira-internal.lookup_issue', side: 'read', confirm: 'never', desc: 'Looks up an issue by key.', schema: ['key'] },
      { name: 'jira-internal.create_issue', side: 'write', confirm: 'always', desc: 'Creates an issue.', schema: ['project', 'summary'] },
      { name: 'vendors.delete_record', side: 'destructive', confirm: 'always', desc: 'Deletes a vendor record.', schema: ['vendor'] }
    ],
    agents: [{ name: 'Data analyst agent', desc: 'Pulls the ledger and reconciles figures.', offered: true }, { name: 'Vendor desk', desc: 'Onboards a vendor: checks, forms, approvals.', offered: false }],
    skills: [{ name: 'Finance tone', desc: 'Answers in the finance team\'s house style.' }, { name: 'One sentence', desc: 'Answers in one sentence.' }, { name: 'Cite everything', desc: 'Every figure cites a source.' }],
    workflows: [{ name: 'vendor-onboarding v4', desc: 'Checks, the DPA, a sign-off, then the record.', schema: ['vendor', 'country'] }, { name: 'quarterly-variance v1', desc: 'Variance report from the ledger.', schema: ['quarter'] }],
    hidden: [{ name: 'agent:Payroll agent', reason: 'its ceiling is internal; the conversation is confidential' }, { name: 'skill:Public voice', reason: 'its ceiling is internal; the conversation is confidential' }]
  };
  // 1.7.0 (B-4002 to B-4009): the conversation's cards, as the invocations endpoint lists them.
  const CARDS = {
    c7: [
      { id: 'i1', kind: 'tool', name: 'jira-internal.lookup_issue', side: 'read', by: 'user', state: 'done', args: { key: 'FIN-1188' }, result: '{"key":"FIN-1188","status":"Open","assignee":"m.okafor"}' },
      { id: 'i2', kind: 'tool', name: 'jira-internal.create_issue', side: 'write', by: 'model', state: 'awaiting', approval: 'owner', args: { project: 'FIN', summary: 'Vendor onboarding: Fabrikam' }, expires: 'in 23 h' },
      // 1.7.0 (B-11703): a plan card: the model's plan before any tool runs, decided by the owner.
      { id: 'i6', kind: 'plan', name: 'plan', by: 'model', state: 'awaiting', approval: 'owner', expires: 'in 23 h', steps: [{ title: 'Pull last week\'s card transactions', tools: ['cards.query'], data: ['the card feed, 7 days'] }, { title: 'Join them to the ledger on amount and date within two days', tools: ['ledger.query', 'calc.table'], data: ['ledger lines for the same days'] }, { title: 'Report the lines without a match', tools: [], data: [] }], offered: ['cards.query', 'ledger.query', 'calc.table', 'jira-internal.create_issue'] },
      { id: 'i3', kind: 'agent', name: 'Vendor desk', by: 'user', state: 'running', run: 'r-7f31', chain: 'ch-2a19', steps: [{ n: 1, lane: 'think', title: 'Plan', state: 'ok' }, { n: 2, lane: 'do', title: 'vendors.lookup', state: 'ok' }, { n: 3, lane: 'do', title: 'vendors.create_record', state: 'waiting' }] },
      { id: 'i4', kind: 'workflow', name: 'vendor-onboarding v4', by: 'user', state: 'running', run: 'wf-c044', chain: 'ch-2a19', approvals: [{ id: 'ap-1', step: 'Sign-off', role: 'workflow-admin', shows: 'DPA for Fabrikam, country DE' }] }
    ]
  };
  const SKILLS_ON = { c7: [{ name: 'Finance tone', mode: 'sticky' }, { name: 'One sentence', mode: 'once' }] };

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
    c6: [
      { role: 'user', text: 'Draft a landing page for the expense tool, with a sign-up form.' },
      { role: 'assistant', paras: ['Here is a first draft of the page and the script that validates the form. Both open in the artifacts panel, where each turn that changes them adds a version.'], meta: 'coder, qwen2.5-coder:32b, 1,420 tokens, 11.2 s',
        artifacts: [{ key: 'index.html', version: 1 }, { key: 'form.js', version: 1 }] },
      { role: 'user', text: 'Make the heading say Northwind Expenses and add a privacy note under the form.' },
      { role: 'assistant', paras: ['Done: the heading reads Northwind Expenses and a privacy note sits under the form. index.html is now at version 2; form.js did not change, so it stays at version 1.'], meta: 'coder, qwen2.5-coder:32b, 980 tokens, 7.4 s',
        artifacts: [{ key: 'index.html', version: 2 }] }
    ],
    c5: [
      { role: 'user', text: 'Does the expense policy allow taxis after 22:00 without pre-approval?' },
      { role: 'assistant', ctx: { title: 'Policy KB, Travel policy v7.md, section 4.3', level: 'internal', body: 'Taxis after 22:00 need no pre-approval where public transport has stopped running.' },
        paras: ['Yes, when public transport has stopped for the night. Section 4.3 of Travel policy v7 waives pre-approval for taxis after 22:00 in that case<a href="#" class="cite" data-cite="2">2</a>; a receipt is still required.'], meta: 'chat-default, llama3.1:8b, 402 tokens, 2.1 s', branch: [1, 1] }
    ]
  };
  // B-8001: artifacts an answer produced, with every version (the panel shows one, the switcher the others).
  const ARTIFACTS = {
    c6: [
      { id: 'a1', key: 'index.html', kind: 'html', language: 'html', versions: [
        { version: 1, turn: 2, bytes: 412, content: '<!doctype html>\n<html><head><style>body{font-family:system-ui;margin:40px}h1{color:#1d4ed8}</style></head><body><h1>Expense tool</h1><p>Expense reports, reconciled by Friday.</p></body></html>' },
        { version: 2, turn: 4, bytes: 538, content: '<!doctype html>\n<html><head><style>body{font-family:system-ui;margin:40px}h1{color:#1d4ed8}</style></head><body><h1>Northwind Expenses</h1><p>Expense reports, reconciled by Friday.</p><form><label>Email <input type=email></label> <button>Sign up</button></form><p style=\'font-size:12px;color:#555\'>We keep your address only to send the invitation.</p></body></html>' }
      ] },
      { id: 'a2', key: 'form.js', kind: 'code', language: 'js', versions: [
        { version: 1, turn: 2, bytes: 236, content: 'const form = document.querySelector(\'form\');\nform.addEventListener(\'submit\', (e) => {\n  const email = form.querySelector(\'input[type=email]\').value.trim();\n  if (!/^[^@]+@[^@]+$/.test(email)) {\n    e.preventDefault();\n    alert(\'Enter a valid email address.\');\n  }\n});\n' }
      ] }
    ]
  };
  THREADS.c7 = [
    { role: 'user', text: '/tool jira-internal.lookup_issue key=FIN-1188' },
    { role: 'tool', card: 'i1' },
    { role: 'user', text: 'Open the onboarding issue for Fabrikam and get the vendor desk started.' },
    { role: 'assistant', paras: ['I have drafted the Jira issue, which waits for your approval on the card below, and I can hand the onboarding to the vendor desk once you confirm.'], meta: 'chat-default, llama3.1:8b, 310 tokens, 2.1 s', proposed: 'i2' },
    { role: 'user', text: '@Vendor desk: Onboard Fabrikam GmbH (DE), include the recent turns.' },
    { role: 'agent', card: 'i3' },
    { role: 'user', text: '/workflow vendor-onboarding v4 vendor=Fabrikam country=DE' },
    { role: 'workflow', card: 'i4' }
  ];
  const SOURCES = {
    c1: [{ n: 1, title: 'ledger.query result', sub: 'Tool result, 14 rows, this turn' }, { n: 2, title: 'Q3 cost centre review.pdf', sub: 'Finance KB, page 4, score 0.83' }],
    c2: [{ n: 1, title: 'Fabrikam MSA 2025.pdf', sub: 'Contracts KB, page 3, score 0.91' }, { n: 2, title: 'Fabrikam MSA 2025.pdf', sub: 'Contracts KB, page 11, score 0.88' }],
    c7: [{ n: 1, title: 'jira-internal.lookup_issue result', sub: 'Tool result, this turn' }],
    c3: [], c4: [{ n: 1, title: 'cards.query ⋈ ledger.query', sub: 'Tool result, 3 rows, this turn' }], c5: [{ n: 2, title: 'Travel policy v7.md', sub: 'Policy KB, section 4.3, score 0.94' }], c6: []
  };

  // 1.7.0 (B-12301): "What you can do" on a new chat: the catalogue's entries for this profile, a few per category.
  const DISCOVER = [
    { cat: 'Documents', items: [{ kind: 'workflow', name: 'summarise-contract', desc: 'A one-page summary of a contract, clauses cited.', example: 'Summarise this contract for me' }, { kind: 'agent', name: 'Contract reviewer', desc: 'Lists the clauses that need a lawyer.', example: 'Review this NDA for unusual terms' }] },
    { cat: 'Finance', items: [{ kind: 'workflow', name: 'quarterly-variance', desc: 'The variance note, drafted for sign-off.', example: 'Draft the Q3 variance note' }, { kind: 'agent', name: 'Data analyst', desc: 'Questions about the numbers, with sources.', example: 'How far over budget was travel in Q3?' }] },
    { cat: 'Writing', items: [{ kind: 'skill', name: 'concise', desc: 'One sentence, the figure first.', example: 'What is the refund window?' }] }
  ];
  const TRIG = { workflow: '/', tool: '/', agent: '@', skill: '+' };
  const composeOf = (it) => (it.kind === 'agent' ? '@' + it.name + ': ' + it.example : TRIG[it.kind] + it.name + ' ' + it.example);
  // 1.7.0 (B-12303): POST /api/catalog/suggestions ranks these by the embedding profile's similarity to the draft.
  const SUGGEST = [
    { key: 'workflow:summarise-contract', kind: 'workflow', name: 'summarise-contract', words: ['summar', 'contract', 'agreement', 'msa'], example: 'Summarise this contract for me' },
    { key: 'agent:Contract reviewer', kind: 'agent', name: 'Contract reviewer', words: ['contract', 'nda', 'review', 'clause'], example: 'Review this NDA for unusual terms' },
    { key: 'workflow:quarterly-variance', kind: 'workflow', name: 'quarterly-variance', words: ['variance', 'budget', 'quarter', 'q3'], example: 'Draft the Q3 variance note' },
    { key: 'tool:calculate', kind: 'tool', name: 'calculate', words: ['percent', 'sum', 'total', 'calculate'], example: 'What is 17.5% of 48,210?' }
  ];
  function suggestFor(st, convo, text) {
    const t = text.toLowerCase(); const gone = (st.dismissed && st.dismissed[convo.id]) || [];
    return SUGGEST.map((x) => ({ x, n: x.words.filter((w) => t.includes(w)).length })).filter((r) => r.n && gone.indexOf(r.x.key) < 0).sort((a, b) => b.n - a.n).slice(0, 3).map((r) => r.x);
  }
  function suggestHtml(st, convo) {
    if (st.suggestOff) return '<div class="suggestrow muted" style="font-size:12px">Suggestions are off for profile ' + esc(st.profile || convo.profile) + '.</div>';
    const list = st.suggestions || [];
    if (!list.length) return '';
    return '<div class="suggestrow" role="group" aria-label="Suggested for this message"><span class="muted" style="font-size:12px">Suggested:</span>' + list.map((x) => '<span class="schip"><button type="button" class="chip" data-usesug="' + esc(x.key) + '">' + UI.pill(x.kind, 'outline') + ' <span class="mono">' + esc(TRIG[x.kind] + x.name) + '</span></button><button type="button" class="iconbtn sm ghost" data-dismisssug="' + esc(x.key) + '" aria-label="Dismiss the suggestion ' + esc(x.name) + '">' + UI.icon('x', 12) + '</button></span>').join('') + '</div>';
  }
  function discoverHtml() {
    return '<div class="discover panel"><div class="phead"><div class="eyebrow">What you can do</div><a href="#/catalog" data-gocat>See the whole catalogue</a></div>'
      + '<div class="fg2" style="font-size:13px">Published to Finance Ops for you, through this profile. Pick one to fill the composer.</div>'
      + DISCOVER.map((g) => '<div class="dcat"><div class="muted" style="font-size:12px;font-weight:600">' + esc(g.cat) + '</div>' + g.items.map((it) => '<button type="button" class="ditem" data-discover="' + esc(it.kind + ':' + it.name) + '"><span class="mono">' + esc(TRIG[it.kind] + it.name) + '</span><span class="desc">' + esc(it.desc) + '</span><span class="ex">"' + esc(it.example) + '"</span></button>').join('') + '</div>').join('')
      + '</div>';
  }

  App.register({
    id: 'chat', title: 'Chat', summary: 'Conversation list, thinking trace, citations, tools, agents, skills and workflows from the composer, approval and run cards, memory proposals',
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
      { title: 'Ungrounded figure', tone: 'warn', text: 'A number with no calc result or cited source gets a dotted underline and a flag entry.', apply(ctx) { ctx.state.ungrounded = true; ctx.rerender(); } },
      { title: 'Artifact edited in a later turn', tone: 'info', text: 'An answer that changes index.html adds version 2; version 1 stays in the switcher. HTML renders in a sandboxed frame, code as text.', apply(ctx) { ctx.state.convo = 'c6'; ctx.state.artifact = { id: 'a1', version: 2 }; ctx.rerender(); } },
      { title: 'Write tool awaiting approval', tone: 'warn', text: 'The model proposed jira-internal.create_issue mid-answer. A write tool runs only on the owner\'s approval; the card waits a day, then expires and is recorded.', apply(ctx) { ctx.state.convo = 'c7'; ctx.state.cards = {}; ctx.rerender(); } },
      { title: 'Tool call held for review', tone: 'info', text: 'A rule on the tool-call checkpoint held the call. It shows as held and runs only when a reviewer approves it in the Flags queue.', apply(ctx) { ctx.state.convo = 'c7'; ctx.state.cards = { i2: 'held' }; ctx.rerender(); } },
      { title: 'Card denied', tone: 'danger', text: 'A denied card leaves no side effect; the turn records it so the model does not try again blindly.', apply(ctx) { ctx.state.convo = 'c7'; ctx.state.cards = { i2: 'denied' }; ctx.rerender(); } },
      { title: 'Card expired', tone: 'neutral', text: 'Nobody decided the card within its day: expired, audited, nothing ran.', apply(ctx) { ctx.state.convo = 'c7'; ctx.state.cards = { i2: 'expired' }; ctx.rerender(); } },
      { title: 'Agent run from the chat', tone: 'info', text: '@Vendor desk started a run bound to this conversation; its steps stream into the card, it shows in Runs with a link back, and cancel stops it.', apply(ctx) { ctx.state.convo = 'c7'; ctx.state.cards = {}; ctx.rerender(); } },
      { title: 'Agent answered', tone: 'neutral', text: 'The run ended: its answer is a turn attributed to the agent, which the next turn sees as such.', apply(ctx) { ctx.state.convo = 'c7'; ctx.state.cards = { i3: 'done' }; ctx.rerender(); } },
      { title: 'Workflow waiting on an approval', tone: 'info', text: '/workflow started vendor-onboarding v4; its sign-off is a card here, and approving it here resumes the chain. A call held anywhere in the chain is decided from this root too.', apply(ctx) { ctx.state.convo = 'c7'; ctx.state.wfDecided = {}; ctx.rerender(); } },
      { title: 'Skill for one turn', tone: 'neutral', text: '"One sentence" is on for this turn only; "Finance tone" is sticky. Removing a chip leaves its instructions out of the very next turn.', apply(ctx) { ctx.state.convo = 'c7'; ctx.rerender(); } },
      { title: 'Hidden above the ceiling', tone: 'warn', text: 'The pickers never list an agent or skill whose ceiling is below the conversation\'s label; calling one by name is refused the same way.', apply(ctx) { ctx.state.convo = 'c7'; ctx.rerender(); setTimeout(() => { const ta = ctx.$('#composer'); if (ta) { ta.value = '@'; ta.dispatchEvent(new Event('input', { bubbles: true })); } }, 30); } },
      { title: 'What you can do on a new chat', tone: 'info', text: 'A new chat lists, by category, the workflows, agents and skills published to the workspace for you through this profile. Picking one fills the composer with its call and an example prompt.', apply(ctx) { ctx.state.convo = 'new'; ctx.rerender(); } },
      { title: 'Suggestions while typing', tone: 'info', text: 'While you type, up to three entries whose description and examples match the draft show as chips, ranked by the embedding profile. No chat model is called.', apply(ctx) { ctx.state.convo = 'c2'; ctx.state.suggestOff = false; ctx.rerender(); setTimeout(() => { const ta = ctx.$('#composer'); if (ta) { ta.value = 'summarise this contract'; ta.dispatchEvent(new Event('input', { bubbles: true })); } }, 30); } },
      { title: 'Suggestion dismissed', tone: 'neutral', text: 'A dismissed suggestion stays away for the rest of this conversation, and comes back in another.', apply(ctx) { const st = ctx.state; st.convo = 'c2'; st.suggestOff = false; st.dismissed = st.dismissed || {}; st.dismissed.c2 = ['workflow:summarise-contract']; ctx.rerender(); setTimeout(() => { const ta = ctx.$('#composer'); if (ta) { ta.value = 'summarise this contract'; ta.dispatchEvent(new Event('input', { bubbles: true })); } }, 30); } },
      { title: 'Suggestions off for the profile', tone: 'neutral', text: 'A profile admin turned composer suggestions off for this profile; the pickers still work.', apply(ctx) { ctx.state.convo = 'c2'; ctx.state.suggestOff = true; ctx.rerender(); } },
      { title: 'Plan awaiting approval', tone: 'info', text: 'A plan-first profile drafts a plan (steps, tools, data) before any tool runs and shows it as a card. Approve it as drafted or edited, or decline it; write tools keep their own cards.', apply(ctx) { ctx.state.convo = 'c4'; ctx.state.plan = { c4: 'awaiting' }; ctx.state.planEdited = false; ctx.rerender(); } },
      { title: 'Plan approved as edited', tone: 'ok', text: 'The answer ran under the edited plan: only the tools it names were offered, and the plan is recorded on the message and in the chain.', apply(ctx) { ctx.state.convo = 'c4'; ctx.state.plan = { c4: 'approved' }; ctx.state.planEdited = true; ctx.rerender(); } },
      { title: 'Plan declined', tone: 'neutral', text: 'A declined plan ends the turn without running anything; the model is told on the next turn.', apply(ctx) { ctx.state.convo = 'c4'; ctx.state.plan = { c4: 'declined' }; ctx.rerender(); } },
      { title: 'Answer checked', tone: 'ok', text: 'A profile with reflection on gets a second pass over the answer against the question, its citations and tool results. The badge shows what it checked.', apply(ctx) { ctx.state.convo = 'c4'; ctx.state.plan = {}; ctx.state.checked = { c4: 'ok' }; ctx.rerender(); } },
      { title: 'Answer revised by reflection', tone: 'warn', text: 'The second pass found a figure the tool results do not support and revised the answer. The original stays one click away; the revised text went through the same output screen.', apply(ctx) { ctx.state.convo = 'c1'; ctx.state.checked = { c1: 'revised' }; ctx.rerender(); } },
      { title: 'Thinking shown to nobody', tone: 'neutral', text: 'The workspace policy keeps thinking from everyone: the stream carries none and the message holds only the token count. Reviewers-only hides it from the author too.', apply(ctx) { ctx.state.convo = 'c1'; ctx.state.policy = 'nobody'; ctx.rerender(); } },
      { title: 'Thinking budget near its limit', tone: 'warn', text: 'A notice near the limit of the profile\'s or the workspace\'s daily thinking budget; at the limit, turns think at low rather than being refused.', apply(ctx) { ctx.state.convo = 'c1'; ctx.state.policy = 'author'; ctx.state.budget = { used: 8400, limit: 10000, who: 'analyst' }; ctx.rerender(); } },
      { title: 'Thinking budget spent', tone: 'warn', text: 'The budget is spent for today: the turn ran at low instead of medium, the message says so, and the usage summary counts the drop.', apply(ctx) { ctx.state.convo = 'c1'; ctx.state.policy = 'author'; ctx.state.budget = { used: 10000, limit: 10000, who: 'analyst', spent: true }; ctx.rerender(); } },
      { title: 'Artifact open for a share reader', tone: 'neutral', text: 'A reader of a shared conversation sees the versions of the shown turns, read only, with the same sandboxed render.', apply(ctx) { ctx.state.convo = 'c6'; ctx.state.artifact = { id: 'a2', version: 1 }; ctx.state.readerView = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.convo) { st.convo = ctx.params.convo; }
      st.convo = st.convo || 'c1'; st.sent = st.sent || {}; st.decided = st.decided || {}; st.memories = st.memories || {}; st.query = st.query || '';
      st.thinking = st.thinking || {}; st.level = st.level || 'medium';
      // 1.7.0 (B-11701 to B-11704): the thinking policy in force, the budget notice, plan cards and reflection badges.
      st.policy = st.policy || 'author'; st.budget = st.budget || null; st.plan = st.plan || {}; st.checked = st.checked || {};
      const isNew = st.convo === 'new';
      const convo = isNew ? { id: 'new', title: 'New conversation', label: 'internal', profile: st.profile || 'chat-default' } : CONVOS.find((c) => c.id === st.convo) || CONVOS[0];
      if (st.profile) convo.profile = st.profile;
      const prof = PROFILES.find((p) => p.id === convo.profile) || PROFILES[1];
      let thread = (isNew ? [] : THREADS[convo.id] || []).concat(st.sent[convo.id] || []);
      const planState = st.plan[convo.id];
      if (planState && convo.id === 'c4') thread = [thread[0], { role: 'plan', card: 'i6' }].concat(planState === 'approved' ? thread.slice(1) : []);
      const sources = SOURCES[convo.id] || [];
      const list = CONVOS.filter((c) => !st.query || c.title.toLowerCase().includes(st.query.toLowerCase()));

      const cardsOf = CARDS[convo.id] || [];
      const cardState = (c) => (st.cards && st.cards[c.id]) || c.state;
      const sidePill = (side) => UI.pill(side, side === 'read' ? 'outline' : side === 'write' ? 'warn' : 'danger');
      const stateTone = { done: 'ok', awaiting: 'warn', held: 'info', running: 'info', denied: 'danger', expired: 'neutral', failed: 'danger', cancelled: 'neutral' };
      const argsText = (args) => Object.keys(args || {}).map((k) => k + '=' + JSON.stringify(args[k])).join('  ');
      /** B-4002, B-4003: a tool card: the call, who proposed it, its state and the decision buttons or the result. */
      const toolCard = (c) => {
        const state = cardState(c);
        let h = '<div class="card ' + state + '" data-card="' + c.id + '"><div class="hstack gap6"><b>' + esc(c.name) + '</b>' + sidePill(c.side) + UI.pill(state, stateTone[state]) + '<span class="muted" style="font-size:12px">' + (c.by === 'model' ? 'proposed by the model' : 'called by you') + '</span></div>'
          + '<div class="mono fg2" style="font-size:12px">' + esc(argsText(c.args)) + '</div>';
        if (state === 'awaiting') h += '<div class="fg2" style="font-size:12px">' + (c.approval === 'owner+reviewer' ? 'A destructive tool a rule flagged: your approval first, then the guardrail\'s approver in the Flags queue.' : 'A write tool runs only on your approval. Acts as you; audited.') + ' Expires ' + esc(c.expires || 'in 24 h') + '.</div><div class="hstack gap6">' + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-approve="' + c.id + '"' }) + UI.btn('Deny', { kind: 'ghost', size: 'sm', attrs: 'data-deny="' + c.id + '"' }) + '</div>';
        else if (state === 'held') h += '<div class="fg2" style="font-size:12px">' + UI.icon('clock', 12) + ' Held by the tool-call guardrail. It runs when a reviewer approves it in the Flags queue (F-2301).</div>';
        else if (state === 'done') h += '<div class="eyebrow">Result</div>' + UI.code(c.result || '{"ok":true}', 'json') + '<div class="muted" style="font-size:11px">The model sees this call and its result on the next turn.</div>';
        else if (state === 'denied') h += '<div class="fg2" style="font-size:12px">' + UI.icon('x', 12) + ' Denied by you. Nothing ran; the model is told on the next turn.</div>';
        else if (state === 'expired') h += '<div class="fg2" style="font-size:12px">The card expired before it was decided. Nothing ran.</div>';
        else if (state === 'failed') h += '<div class="fg2" style="font-size:12px">' + esc(c.error || 'The tool failed.') + '</div>';
        return h + '</div>';
      };
      /** B-4004: an agent run bound to the conversation: its steps stream in; the answer becomes the turn. */
      const agentCard = (c) => {
        const state = cardState(c);
        let h = '<div class="card ' + state + '" data-card="' + c.id + '"><div class="hstack gap6">' + UI.icon('agents', 13) + '<b>' + esc(c.name) + '</b>' + UI.pill(state, stateTone[state]) + '<span class="muted" style="font-size:12px">run <a href="#" class="mono" data-goruns>' + esc(c.run) + '</a>' + (c.chain ? ' · <a href="#" data-gochain>chain tree</a>' : '') + '</span></div>';
        if (state === 'running') h += UI.timeline(c.steps.map((s) => ({ title: s.n + '. ' + s.title, text: s.lane + (s.state === 'waiting' ? ', waiting for approval (decide on the Runs screen or from the chain)' : ''), tone: s.state === 'ok' ? 'ok' : s.state === 'waiting' ? 'warn' : 'info' }))) + '<div class="hstack gap6">' + UI.btn('Cancel run', { kind: 'ghost', size: 'sm', attrs: 'data-cancelrun="' + c.id + '"' }) + '<span class="muted" style="font-size:12px">Budgets, approvals and cancel as in Runs. The answer lands here, attributed to the agent.</span></div>';
        else if (state === 'done') h += '<div class="answer serif"><p>Fabrikam GmbH is onboarded as vendor V-2291: tax id checked, DPA on file, bank details verified. The record awaits the finance sign-off.</p></div><div class="muted" style="font-size:12px">Answer by agent ' + esc(c.name) + '. The next turn sees it attributed.</div>';
        else if (state === 'cancelled') h += '<div class="fg2" style="font-size:12px">Cancelled from the chat. The run stopped; what it reached is on the Runs screen.</div>';
        return h + '</div>';
      };
      /** B-4009: a workflow run started here: its approvals are cards; approving resumes the chain. */
      const wfCard = (c) => {
        const state = cardState(c);
        const decided = st.wfDecided && st.wfDecided[c.id];
        let h = '<div class="card ' + state + '" data-card="' + c.id + '"><div class="hstack gap6">' + UI.icon('workflows', 13) + '<b>' + esc(c.name) + '</b>' + UI.pill(state, stateTone[state]) + '<span class="muted" style="font-size:12px">run <span class="mono">' + esc(c.run) + '</span> · <a href="#" data-gochain>chain tree</a></span></div>';
        if (state === 'running' && !decided) h += c.approvals.map((a) => '<div class="approval"><div class="hstack gap6"><b>Approval: ' + esc(a.step) + '</b>' + UI.pill(a.role, 'outline') + '</div><div class="fg2" style="font-size:12px">' + esc(a.shows) + '</div><div class="hstack gap6">' + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-wfapprove="' + c.id + '"' }) + UI.btn('Reject', { kind: 'ghost', size: 'sm', attrs: 'data-wfreject="' + c.id + '"' }) + '<span class="muted" style="font-size:12px">A call held anywhere in this chain is decided from here too.</span></div></div>').join('');
        else if (state === 'running' && decided) h += UI.timeline([{ title: 'Checks', text: 'passed', tone: 'ok' }, { title: 'Sign-off', text: 'approved by you, from this conversation', tone: 'ok' }, { title: 'Create record', text: 'running', tone: 'info' }]);
        else if (state === 'done') h += '<div class="answer serif"><p>vendor-onboarding v4 finished: checks passed, DPA signed off, record V-2291 created.</p></div>';
        else if (state === 'cancelled') h += '<div class="fg2" style="font-size:12px">Cancelled from the chat.</div>';
        return h + '</div>';
      };
      /** B-11703: the plan card: the steps, the tools each names, the data it needs; approve as drafted or edited, or decline. */
      const planCard = (c) => {
        const state = planState === 'approved' ? 'approved' : planState === 'declined' ? 'denied' : 'awaiting';
        const steps = st.planEdited ? c.steps.map((s, k) => (k === 1 ? Object.assign({}, s, { title: 'Join them to the ledger on amount and date within three days' }) : s)) : c.steps;
        let h = '<div class="card ' + state + ' chat-plan" data-card="' + c.id + '"><div class="hstack gap6">' + UI.icon('brain', 13) + '<b>Plan</b>' + UI.pill(state, stateTone[state] || 'ok') + '<span class="muted" style="font-size:12px">proposed by the model before any tool runs</span></div>'
          + '<ol>' + steps.map((s) => '<li>' + esc(s.title) + (s.tools.length ? ' <span class="mono fg2">' + esc(s.tools.join(', ')) + '</span>' : '') + (s.data.length ? '<div class="muted" style="font-size:12px">needs ' + esc(s.data.join(', ')) + '</div>' : '') + '</li>').join('') + '</ol>';
        if (state === 'awaiting') h += '<div class="fg2" style="font-size:12px">Approved, the answer runs under this plan and only the tools it names are offered; write tools keep their own cards. Declined, nothing runs. Expires ' + esc(c.expires) + '.</div><div class="hstack gap6 wrap">' + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-planapprove' }) + UI.btn('Edit', { size: 'sm', attrs: 'data-planedit' }) + UI.btn('Decline', { kind: 'ghost', size: 'sm', attrs: 'data-plandecline' }) + '</div>';
        else if (state === 'approved') h += '<div class="fg2" style="font-size:12px">' + UI.icon('check', 12) + ' Approved by you' + (st.planEdited ? ', step 2 edited' : ' as drafted') + '. The answer below ran under it; the plan is on the message and in the chain.</div>';
        else h += '<div class="fg2" style="font-size:12px">' + UI.icon('x', 12) + ' Declined by you. Nothing ran; the model is told on the next turn.</div>';
        return h + '</div>';
      };
      /** B-11704: the "checked" badge: what the second pass verified, or the revised answer with the original a click away. */
      const checkedBadge = (key) => {
        const c = st.checked[key]; if (!c) return '';
        if (c === 'ok') return '<div class="chat-checked ok">' + UI.pill('checked', 'ok') + '<span>Second pass by <b>analyst</b>: the answer matches the question, both citations hold, the tool results support every figure. No findings.</span>' + UI.btn('Details', { kind: 'ghost', size: 'xs', attrs: 'data-checked="' + key + '"' }) + '</div>';
        return '<div class="chat-checked warn">' + UI.pill('revised', 'warn') + '<span>Second pass by <b>analyst</b> found one problem: the 13,380 EUR figure has no calculation result or cited source behind it. The answer was revised and screened again.</span>' + UI.btn(st.showOriginal ? 'Show revised' : 'Show original', { kind: 'ghost', size: 'xs', attrs: 'data-original' }) + '</div>';
      };
      const thinkBar = (m, i, open) => {
        const dropped = st.budget && st.budget.spent;
        if (st.policy === 'nobody') return '<div class="thinkbar"><span>' + UI.icon('brain', 13) + ' Thought for ' + m.thinking.secs + ' s, ' + m.thinking.tokens + ' tokens. Kept from everyone by the workspace policy.</span></div>';
        if (st.policy === 'reviewers') return '<div class="thinkbar"><span>' + UI.icon('brain', 13) + ' Thought for ' + m.thinking.secs + ' s, ' + m.thinking.tokens + ' tokens. Shown to reviewers only by the workspace policy.</span></div>';
        return '<button type="button" class="thinkbar" data-think="' + i + '"><span>' + UI.icon('brain', 13) + ' Thought for ' + m.thinking.secs + ' s at level ' + (dropped ? 'low, dropped from ' + esc(m.thinking.level) + ': the daily thinking budget for ' + esc(st.budget.who) + ' is spent' : esc(m.thinking.level)) + ', ' + m.thinking.tokens + ' tokens</span><span>' + (open ? 'Hide' : 'Show') + '</span></button>' + (open ? '<div class="thinktrace">' + esc(m.thinking.text) + '</div>' : '');
      };
      const renderMsg = (m, i) => {
        if (m.role === 'plan') { const c = cardsOf.find((x) => x.id === m.card); return c ? '<div class="msg ai turn-plan">' + planCard(c) + '</div>' : ''; }
        if (m.role === 'tool' || m.role === 'agent' || m.role === 'workflow') {
          const c = cardsOf.find((x) => x.id === m.card); if (!c) return '';
          return '<div class="msg ai turn-' + m.role + '">' + (m.role === 'tool' ? toolCard(c) : m.role === 'agent' ? agentCard(c) : wfCard(c)) + '</div>';
        }
        if (m.role === 'user') return '<div class="msg user"><div class="bubble">' + esc(m.text) + '</div><div class="uactions">' + UI.iconbtn('edit', 'Edit and branch', { cls: 'sm ghost', attrs: 'data-edit="' + i + '"' }) + '</div></div>';
        if (m.streaming) return '<div class="msg ai"><div class="thinkbar"><span>' + (m.phase === 'thinking' ? 'Thinking at level ' + esc(st.level) + '…' : 'Answering…') + '</span><span class="muted">' + UI.btn('Stop', { kind: 'ghost', size: 'xs', attrs: 'data-stop' }) + '</span></div><div class="answer serif">' + m.partial + '<span class="blink">▍</span></div></div>';
        const open = st.thinking[i];
        let h = '<div class="msg ai">';
        if (m.thinking) h += thinkBar(m, i, open);
        if (m.raised) h += '<div class="raised"><span class="rule"></span>Label raised to ' + UI.label('confidential', { sm: true }) + ' by ' + esc(m.raised) + '<span class="rule"></span></div>';
        if (m.ctx) h += UI.ctx(m.ctx.title, m.ctx.body, m.ctx.level);
        if (st.guardStop && i === thread.length - 1) {
          h += '<div class="answer serif"><p>' + m.paras[0].replace(/<a[^>]*>\d<\/a>/g, '') + '</p></div>' + UI.notice('<b>Stopped by guardrail</b> Finance baseline v12, rule <span class="mono">no-personal-data-in-summaries</span>. The rest of this answer was withheld at the sentence boundary.', 'danger', '<a href="#" data-report="' + i + '">Report</a>');
        } else {
          h += '<div class="answer serif">' + m.paras.map((p, pi) => '<p>' + (st.checked[convo.id] === 'revised' && !st.showOriginal && pi === m.paras.length - 1 ? p.replace('13,380 EUR', '<span style="background:var(--warn-bg)" title="Revised by the second pass: the original figure had no calculation result or cited source behind it.">an amount the ledger result does not give</span>') : st.ungrounded && pi === m.paras.length - 1 ? p.replace('13,380 EUR', '<span class="ungrounded" title="No calculation result or cited source backs this figure. Logged to flags.">13,380 EUR</span>') : p) + (st.resumed && pi === 0 ? '<span class="gap" title="Connection dropped at event 212 and resumed"> ⋯ </span>' : '') + '</p>').join('') + '</div>';
        }
        if (m.artifacts) h += '<div class="hstack wrap gap6">' + m.artifacts.map((a) => UI.chip(UI.icon(a.key.endsWith('.html') ? 'images' : 'scripts', 12) + ' ' + esc(a.key) + ' <span class="muted">v' + a.version + '</span>', st.artifact && st.artifact.id === (ARTIFACTS[convo.id] || []).find((x) => x.key === a.key).id && st.artifact.version === a.version, 'data-artifact="' + esc((ARTIFACTS[convo.id] || []).find((x) => x.key === a.key).id) + '" data-version="' + a.version + '"')).join('') + '</div>';
        if (m.paras && st.checked[convo.id] && i === thread.length - 1) h += checkedBadge(convo.id);
        h += '<div class="mactions">' + UI.iconbtn('copy', 'Copy', { cls: 'sm', attrs: 'data-copy="answer"' }) + UI.iconbtn('refresh', 'Regenerate', { cls: 'sm', attrs: 'data-regen="' + i + '"' }) + UI.iconbtn('branch', 'Branch from here', { cls: 'sm', attrs: 'data-branchmsg="' + i + '"' }) + UI.iconbtn('flag', 'Report this answer', { cls: 'sm', attrs: 'data-report="' + i + '"' }) + (m.branch ? '<span class="hstack gap4">' + UI.iconbtn('chev', 'Previous branch', { cls: 'sm ghost', attrs: 'data-branch="prev" style="transform:rotate(180deg)"' }) + '<span>Branch ' + m.branch[0] + ' of ' + m.branch[1] + '</span>' + UI.iconbtn('chev', 'Next branch', { cls: 'sm ghost', attrs: 'data-branch="next"' }) + '</span>' : '') + '<span class="right muted">' + esc(m.meta || '') + '</span></div>';
        if (m.confirm && !st.decided[convo.id + i]) h += '<div class="confirmcard"><div class="hstack"><b>' + esc(m.confirm.title) + '</b>' + UI.pill('write', 'warn') + '</div><div class="mono fg2">' + esc(m.confirm.tool) + '  ' + esc(m.confirm.args) + '</div><div class="hstack wrap"><span class="fg2 grow" style="font-size:12px">' + esc(m.confirm.note) + '</span><span class="hstack gap6">' + UI.btn('Deny', { size: 'sm', attrs: 'data-deny="' + i + '"' }) + UI.btn('Allow once', { kind: 'primary', size: 'sm', attrs: 'data-allow="' + i + '"' }) + '</span></div></div>';
        if (m.confirm && st.decided[convo.id + i]) h += '<div class="decided ' + (st.decided[convo.id + i] === 'allow' ? 'ok' : '') + '">' + UI.icon(st.decided[convo.id + i] === 'allow' ? 'check' : 'x', 13) + (st.decided[convo.id + i] === 'allow' ? ' Created <a href="#" data-jira>FIN-1187</a> in jira-internal as Mara Okafor. Logged to audit.' : ' Denied. The agent was told the action was refused and continued without it.') + '</div>';
        if (m.proposed) { const c = cardsOf.find((x) => x.id === m.proposed); if (c) h += toolCard(c); }
        if (m.memory && !st.memories[convo.id + i]) h += '<div class="memprop"><span class="grow">Remember: "' + esc(m.memory) + '"</span>' + UI.btn('Save', { size: 'sm', attrs: 'data-memsave="' + i + '"' }) + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-memdismiss="' + i + '"' }) + '</div>';
        return h + '</div>';
      };

      root.innerHTML = '<style>'
        + '.chat-plan ol{margin:4px 0 0;padding-left:20px;font-size:13px;line-height:1.5}.chat-plan li{margin:2px 0}'
        + '.chat-checked{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--fg2);padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel2)}.chat-checked.ok{border-color:var(--ok-fg)}.chat-checked.warn{border-color:var(--warn-fg)}.chat-checked > span{flex:1 1 240px}'
        + '.chat-list{display:flex;flex-direction:column;gap:2px}'
        + '.discover{display:flex;flex-direction:column;gap:10px}.discover .phead{display:flex;justify-content:space-between;align-items:center;gap:8px}.discover .dcat{display:flex;flex-direction:column;gap:4px}'
        + '.ditem{all:unset;display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;cursor:pointer}.ditem:hover{background:var(--accent-tint)}.ditem:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.ditem .desc{font-size:12px;color:var(--fg2)}.ditem .ex{font-size:12px;font-style:italic;color:var(--muted);overflow-wrap:anywhere}'
        + '.suggestrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.suggestrow .schip{display:inline-flex;align-items:center;gap:2px}'

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
        + '.card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.card.awaiting{border-color:var(--warn-fg);background:var(--warn-bg)}.card.held{border-color:var(--info-fg)}.card.denied,.card.failed{border-color:var(--danger-fg)}.card .approval{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--accent);border-radius:6px;background:var(--accent-tint)}'
        + '.skillchips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.skillchips .chip .x{margin-left:4px;opacity:.7}'
        + '.picker{position:absolute;left:0;bottom:calc(100% + 4px);min-width:360px;max-width:520px;z-index:30}.picker .dh{display:flex;justify-content:space-between}.picker button .desc{display:block;font-size:11px;color:var(--muted)}.picker button .side{float:right}'
        + '.composer{border-top:1px solid var(--line);background:var(--bg);padding:12px 24px 16px}.composer .inner{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:8px}'
        + '.composer textarea{width:100%;min-height:64px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:14px;resize:vertical;line-height:1.4}'
        + '.src{display:flex;gap:8px;align-items:flex-start;padding:8px;border-radius:5px;cursor:pointer}.src:hover,.src.hi{background:var(--accent-tint)}.src .n{width:18px;height:18px;border-radius:50%;background:var(--sel);font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}'
        + '.coldbar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--info-bg);color:var(--info-fg);font-size:12px;border-radius:6px}'
        + '.chat-art{display:flex;flex-direction:column;gap:8px}.chat-art .ahead{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.chat-art .ahead .right{margin-left:auto}'
        + '.chat-art iframe{width:100%;height:300px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}.chat-art pre{margin:0;max-height:320px;overflow:auto;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);font-size:12px;line-height:1.45}'
        + '.chat-art .alist{display:flex;flex-direction:column;gap:2px}'
        + '</style>'
        + '<div class="leftpane">' + UI.btn('New conversation', { icon: 'plus', cls: 'block', attrs: 'data-new' }) + UI.search('Search conversations', 'data-search', st.query).replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="chat-list">' + list.map((c) => UI.listItem(esc(c.title), esc(c.meta), { active: c.id === convo.id, attrs: 'data-convo="' + c.id + '"', right: UI.label(c.label, { sm: true }) })).join('') + (list.length ? '' : UI.empty('No conversations match', 'Try another word or start a new conversation.')) + '</div></div>'
        + '<div class="page tight" style="display:flex;flex-direction:column">'
        + '<div class="grow" style="overflow:auto"><div class="chat-thread" id="thread">'
        + (st.cold ? '<div class="coldbar">' + UI.icon('clock', 14) + '<span class="grow"><b>' + esc(prof.id) + '</b> is loading on gpu-large-2, about 20 s. Your message will send when it is warm.</span><span class="skeleton" style="width:80px"></span></div>' : '')
        + (thread.length ? thread.map(renderMsg).join('') : UI.empty('Start with a question', 'Pick a profile, attach files or a knowledge base, and ask. Answers cite their sources and show their label.', UI.btn('Ask about Q3 travel', { size: 'sm', attrs: 'data-suggest' })) + discoverHtml())
        + (st.runWorkflow ? '<div class="panel" style="gap:8px"><div class="phead"><div class="eyebrow">Run workflow: video-to-notes v3</div>' + UI.pill('running', 'info') + '</div>' + UI.timeline([{ title: 'Extract frames', text: 'media worker, 48 frames', tone: 'ok' }, { title: 'Transcribe audio', text: 'whisper, 12 min of audio', tone: 'ok' }, { title: 'Summarise', text: 'analyst, thinking medium', tone: 'accent' }, { title: 'Guardrail check', text: 'waiting', tone: '' }]) + '<div>' + UI.btn('Open in Runs', { size: 'sm', attrs: 'data-goruns' }) + '</div></div>' : '')
        + '</div></div>'
        + (st.budget ? UI.notice('<b>Thinking budget' + (st.budget.spent ? ' spent.' : ' near its limit.') + '</b> ' + st.budget.used.toLocaleString('en-GB') + ' of ' + st.budget.limit.toLocaleString('en-GB') + ' thinking tokens today for <b>' + esc(st.budget.who) + '</b>. ' + (st.budget.spent ? 'Turns think at low until midnight UTC rather than being refused.' : 'At the limit, turns think at low rather than being refused.'), 'warn') : '')
        + '<div class="composer"><div class="inner"><div class="hstack wrap gap6"><span class="relative">' + UI.chip(UI.icon('profiles', 12) + ' ' + esc(prof.id) + (prof.agent ? '' : ' · ' + esc(prof.model.split(':')[0])), true, 'data-pick="profile"') + '</span><span class="relative">' + UI.chip(UI.icon('knowledge', 12) + ' Finance KB', true, 'data-pick="kb"') + '</span>' + UI.chip('Travel policy', true, 'data-toggle') + UI.chip(UI.icon('attach', 12) + ' q3-ledger.csv, scanned ' + UI.label('confidential', { sm: true }), true, 'data-attach') + '<span class="relative">' + UI.chip(UI.icon('brain', 12) + ' Thinking: ' + esc(st.level), false, 'data-pick="level"') + '</span></div>'
        + '<div class="skillchips" data-region="skills">' + skillChips(st, convo) + '</div>'
        + '<div data-region="suggest">' + suggestHtml(st, convo) + '</div>'
        + '<div class="relative" data-region="picker">' + (st.picker ? pickerHtml(st, convo) : '') + '</div>'
        + '<label class="sr" for="composer">Message</label><textarea id="composer" placeholder="Ask something. Type / for a tool or workflow, @ for an agent, + for a skill." aria-describedby="composer-hint"></textarea>'
        + '<span id="composer-hint" class="sr">Slash opens the tool and workflow picker, at opens the agent picker, plus opens the skill picker; arrow keys move, Enter picks, Escape closes.</span>'
        + '<div class="hstack"><div class="hstack gap6">' + UI.iconbtn('attach', 'Attach a file', { attrs: 'data-attachbtn' }) + UI.iconbtn('workflows', 'Run a workflow', { attrs: 'data-wf' }) + UI.iconbtn('images', 'Generate an image', { attrs: 'data-img' }) + '</div><div class="hstack right gap12"><span class="muted num" style="font-size:12px">18,400 of 32,768 context tokens</span>' + UI.btn('Send', { kind: 'primary', icon: 'send', attrs: 'data-send' }) + '</div></div></div></div></div>'
        + '<aside class="inspector w300">' + artifactsHtml(st, convo) + '<div class="eyebrow">Sources</div><div class="vstack gap4" id="sources">' + (sources.length ? sources.map((s) => '<div class="src" data-src="' + s.n + '"><span class="n">' + s.n + '</span><span><span style="font-weight:600;display:block">' + esc(s.title) + '</span><span class="muted" style="font-size:12px">' + esc(s.sub) + '</span></span></div>').join('') : '<div class="muted" style="font-size:12px">No sources cited in this conversation.</div>') + '</div>'
        + '<div class="eyebrow">This turn</div>' + UI.kv([['Profile', '<a href="#" data-goprofile>' + esc(prof.id) + '</a>'], ['Model', '<span class="mono">' + esc(prof.model) + '</span>'], ['Thinking', esc(st.level) + ', ceiling ' + esc(prof.thinking) + '; ' + (st.policy === 'nobody' ? 'kept from everyone' : st.policy === 'reviewers' ? 'shown to reviewers' : 'shown to you') + ' by policy'], ['Guardrails', 'Finance baseline v12, ' + (st.guardStop ? '<span style="color:var(--danger-fg)">1 stop</span>' : '0 triggers')], ['Calculations', st.ungrounded ? '2 exact, <span style="color:var(--warn-fg)">1 ungrounded figure</span>' : '2 exact, 0 ungrounded figures'], ['Trace', '<span class="mono">4bf92f3577b34da6</span> ' + UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copy="4bf92f3577b34da6"' })]], 1)
        + '<div class="eyebrow">Quota today</div>' + UI.meter('Tokens', '310k of 500k', 62) + UI.meter('GPU-seconds this month', '16,380 of 18,000', 91, 'warn') + '</aside>';

      // ---- events ----
      ctx.on('click', '[data-convo]', (e, t) => { st.convo = t.dataset.convo; st.guardStop = st.resumed = st.ungrounded = false; ctx.rerender(); });
      ctx.on('click', '[data-new]', () => { st.convo = 'new'; ctx.rerender(); setTimeout(() => { const c = ctx.$('#composer'); if (c) c.focus(); }, 30); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-think]', (e, t) => { st.thinking[t.dataset.think] = !st.thinking[t.dataset.think]; ctx.rerender(); });
      // B-11703, B-11704: plan decisions and the reflection badge.
      ctx.on('click', '[data-planapprove]', () => { st.plan[convo.id] = 'approved'; st.planEdited = false; ctx.rerender(); ctx.toast('Plan approved. The answer runs under it; only the tools it names are offered.', 'ok'); });
      ctx.on('click', '[data-plandecline]', () => { st.plan[convo.id] = 'declined'; ctx.rerender(); ctx.toast('Plan declined. Nothing ran; the model is told on the next turn.'); });
      ctx.on('click', '[data-planedit]', () => ctx.modal({ title: 'Edit the plan', body: '<div class="vstack gap8">' + UI.field('Step 1', UI.input('Pull last week\'s card transactions', { attrs: 'data-ps="1"' })) + UI.field('Step 2', UI.input('Join them to the ledger on amount and date within three days', { attrs: 'data-ps="2"' })) + UI.field('Step 3', UI.input('Report the lines without a match', { attrs: 'data-ps="3"' })) + '<div class="fg2" style="font-size:12px">A step can only name tools this conversation can call: cards.query, ledger.query, calc.table, jira-internal.create_issue.</div></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Approve as edited', { kind: 'primary', attrs: 'data-planok' }), onMount(el) { el.querySelector('[data-planok]').addEventListener('click', () => { App.closeOverlay(); st.plan[convo.id] = 'approved'; st.planEdited = true; ctx.rerender(); ctx.toast('Plan approved as edited. The answer runs under it.', 'ok'); }); } }));
      ctx.on('click', '[data-checked]', () => ctx.drawer({ title: 'Checked by analyst', body: UI.kv([['Question', 'answered: the reconciliation and the unmatched lines'], ['Citations', '1 of 1 holds: cards.query ⋈ ledger.query, 3 rows'], ['Tool results', 'every figure traces to a result'], ['Findings', 'none'], ['Metered', '640 tokens to this conversation'], ['Screened', 'no revised answer; nothing to screen']], 1) }));
      ctx.on('click', '[data-original]', () => { st.showOriginal = !st.showOriginal; ctx.rerender(); });
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
      // 1.7.0 (B-4007): keyboard-first pickers: "/" tools and workflows, "@" agents, "+" skills, from an empty composer.
      ctx.on('input', '#composer', (e, t) => {
        const v = t.value;
        const open = /^[/@+]$/.test(v) ? v : (st.picker && v.startsWith(st.picker.key) ? st.picker.key : null);
        if (open && (!st.picker || st.picker.key !== open)) st.picker = { key: open, q: v.slice(1), i: 0 };
        else if (st.picker && open) st.picker.q = v.slice(1);
        else if (st.picker && !open) st.picker = null;
        const host = ctx.$('[data-region="picker"]'); if (host) host.innerHTML = st.picker ? pickerHtml(st, convo) : '';
        // B-12303: suggestions after a pause in typing (debounced on the client), never while a picker is open.
        clearTimeout(st.suggestTimer);
        st.suggestTimer = setTimeout(() => { st.suggestions = st.picker || st.suggestOff || v.trim().length < 3 ? [] : suggestFor(st, convo, v); const r = ctx.$('[data-region="suggest"]'); if (r) r.innerHTML = suggestHtml(st, convo); }, 300);
      });
      ctx.on('click', '[data-usesug]', (e, t) => { const x = SUGGEST.find((y) => y.key === t.dataset.usesug); const ta = ctx.$('#composer'); if (!x || !ta) return; ta.value = x.kind === 'agent' ? '@' + x.name + ': ' + ta.value : TRIG[x.kind] + x.name + ' ' + ta.value; st.suggestions = []; ctx.$('[data-region="suggest"]').innerHTML = ''; ta.focus(); ctx.toast((x.kind === 'agent' ? 'Enter starts a run of ' : x.kind === 'skill' ? 'Enter adds ' : 'Enter opens ') + esc(x.name) + ' with your text.'); });
      ctx.on('click', '[data-dismisssug]', (e, t) => { st.dismissed = st.dismissed || {}; st.dismissed[convo.id] = (st.dismissed[convo.id] || []).concat([t.dataset.dismisssug]); st.suggestions = (st.suggestions || []).filter((x) => x.key !== t.dataset.dismisssug); ctx.$('[data-region="suggest"]').innerHTML = suggestHtml(st, convo); const ta = ctx.$('#composer'); if (ta) ta.focus(); ctx.toast('Dismissed for the rest of this conversation.'); });
      ctx.on('click', '[data-discover]', (e, t) => { let it = null; DISCOVER.forEach((g) => g.items.forEach((x) => { if (x.kind + ':' + x.name === t.dataset.discover) it = x; })); const ta = ctx.$('#composer'); if (it && ta) { ta.value = composeOf(it); ta.focus(); } });
      ctx.on('click', '[data-gocat]', (e) => { e.preventDefault(); ctx.navigate('catalog'); });
      ctx.on('keydown', '#composer', (e) => {
        if (!st.picker) return;
        const items = pickerItems(st, convo);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); st.picker.i = (st.picker.i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(1, items.length); ctx.$('[data-region="picker"]').innerHTML = pickerHtml(st, convo); }
        else if (e.key === 'Escape') { st.picker = null; ctx.$('[data-region="picker"]').innerHTML = ''; }
        else if (e.key === 'Enter' && items.length) { e.preventDefault(); e.stopImmediatePropagation(); pick(ctx, st, convo, items[st.picker.i]); }
      });
      ctx.on('click', '[data-pickitem]', (e, t) => { const items = pickerItems(st, convo); pick(ctx, st, convo, items[+t.dataset.pickitem]); });
      ctx.on('click', '[data-rmskill]', (e, t) => { st.skills = st.skills || {}; st.skills[convo.id] = (st.skills[convo.id] || SKILLS_ON[convo.id] || []).filter((x) => x.name !== t.dataset.rmskill); ctx.rerender(); ctx.toast('Skill removed. The very next turn goes without its instructions.'); });
      ctx.on('click', '[data-approve]', (e, t) => { st.cards = st.cards || {}; const c = (CARDS[convo.id] || []).find((x) => x.id === t.dataset.approve); st.cards[c.id] = c.approval === 'owner+reviewer' ? 'held' : 'done'; c.result = c.result || '{"key":"FIN-1203","created":true}'; ctx.rerender(); ctx.toast(c.approval === 'owner+reviewer' ? 'Your approval is recorded; the guardrail\'s approver decides next in the Flags queue.' : esc(c.name) + ' ran as you. Audit entry chat.tool.approved written.', 'ok'); });
      ctx.on('click', '[data-deny]', (e, t) => { st.cards = st.cards || {}; st.cards[t.dataset.deny] = 'denied'; ctx.rerender(); ctx.toast('Denied. Nothing ran; the model is told on the next turn.'); });
      ctx.on('click', '[data-cancelrun]', (e, t) => { st.cards = st.cards || {}; st.cards[t.dataset.cancelrun] = 'cancelled'; ctx.rerender(); ctx.toast('Run cancelled from the chat; the Runs screen shows what it reached.'); });
      ctx.on('click', '[data-wfapprove]', (e, t) => { st.wfDecided = st.wfDecided || {}; st.wfDecided[t.dataset.wfapprove] = true; ctx.rerender(); ctx.toast('Sign-off approved from this conversation; the chain resumes.', 'ok'); });
      ctx.on('click', '[data-wfreject]', (e, t) => { st.cards = st.cards || {}; st.cards[t.dataset.wfreject] = 'cancelled'; ctx.rerender(); ctx.toast('Sign-off rejected; the run ends and the turn says so.'); });
      ctx.on('click', '[data-gochain]', (e) => { e.preventDefault(); ctx.navigate('runs', { chain: 'ch-2a19' }); });
      ctx.on('click', '[data-toolgo]', () => { const m = ctx.$('#overlay .modal'); const name = m.dataset.tool; const vals = Array.prototype.map.call(m.querySelectorAll('[data-arg]'), (x) => x.dataset.arg + '=' + JSON.stringify(x.value)).join('  '); ctx.closeOverlay(); ctx.$('#composer').value = ''; st.picker = null; ctx.toast('/tool ' + esc(name) + ' ' + esc(vals) + ' sent through the dispatcher and the tool-call guardrail.', 'ok'); });
      ctx.on('keydown', '#composer', (e) => { if (st.picker) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ctx, st, convo, thread); } });
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
      ctx.on('click', '[data-artifact]', (e, t) => { st.artifact = { id: t.dataset.artifact, version: Number(t.dataset.version) }; ctx.rerender(); });
      ctx.on('change', '[data-artversion]', (e, t) => { st.artifact = { id: st.artifact.id, version: Number(t.value) }; ctx.rerender(); });
      ctx.on('click', '[data-artprev], [data-artnext]', (e, t) => { const a = (ARTIFACTS[convo.id] || []).find((x) => x.id === st.artifact.id); const n = st.artifact.version + (t.hasAttribute('data-artnext') ? 1 : -1); if (a && n >= 1 && n <= a.versions.length) { st.artifact = { id: a.id, version: n }; ctx.rerender(); } });
      ctx.on('click', '[data-artclose]', () => { st.artifact = null; ctx.rerender(); });
      ctx.on('click', '[data-artcopy]', () => ctx.toast('Artifact copied to the clipboard.', 'ok'));
      ctx.on('click', '[data-goruns]', () => ctx.navigate('runs'));
      ctx.on('click', '[data-img]', () => ctx.navigate('images'));
      ctx.on('click', '[data-goprofile]', (e) => { e.preventDefault(); ctx.navigate('profiles', { profile: prof.id }); });
      ctx.on('click', '[data-jira]', (e) => { e.preventDefault(); ctx.toast('External links open after a confirmation because jira-internal is an allow-listed internal domain.'); });
      const th = ctx.$('#thread'); if (th) th.scrollTop = th.scrollHeight;
      if (ctx.params.convo) { delete ctx.params.convo; }
      // B-12301: "Use in Chat" from the catalogue opens a new chat with the composer filled in.
      if (st.fill) { const f = st.fill; st.fill = null; setTimeout(() => { const ta = ctx.$('#composer'); if (ta) { ta.value = f; ta.focus(); } }, 30); }
      if (ctx.params.fill) delete ctx.params.fill;
    }
  });

  /** B-4005: the skills on the conversation, as chips with their mode; a sticky one stays, a once one lasts one turn. */
  function skillChips(st, convo) {
    const on = (st.skills && st.skills[convo.id]) || SKILLS_ON[convo.id] || [];
    if (!on.length) return '';
    return '<span class="muted" style="font-size:12px">Skills:</span>' + on.map((s) => UI.chip(UI.icon('skills', 11) + ' ' + esc(s.name) + ' <span class="muted">' + (s.mode === 'once' ? 'this turn' : 'sticky') + '</span><span class="x" aria-hidden="true">×</span>', true, 'data-rmskill="' + esc(s.name) + '" aria-label="Remove skill ' + esc(s.name) + '"')).join('');
  }
  /** B-4007: the items a picker lists, filtered by what follows the key. */
  function pickerItems(st, convo) {
    const q = (st.picker.q || '').toLowerCase();
    const hit = (x) => !q || x.name.toLowerCase().includes(q);
    if (st.picker.key === '/') return CAPS.tools.filter(hit).map((t) => ({ kind: 'tool', name: t.name, desc: t.desc, side: t.side, schema: t.schema })).concat(CAPS.workflows.filter(hit).map((w) => ({ kind: 'workflow', name: w.name, desc: w.desc, schema: w.schema })));
    if (st.picker.key === '@') return CAPS.agents.filter(hit).map((a) => ({ kind: 'agent', name: a.name, desc: a.desc + (a.offered ? ' Also offered to the model.' : '') }));
    return CAPS.skills.filter(hit).map((s) => ({ kind: 'skill', name: s.name, desc: s.desc }));
  }
  function pickerHtml(st, convo) {
    const items = pickerItems(st, convo);
    const title = st.picker.key === '/' ? 'Tools and workflows this conversation may call' : st.picker.key === '@' ? 'Agents you may start here' : 'Skills to add';
    const hidden = CAPS.hidden.filter((h) => (st.picker.key === '@' ? h.name.startsWith('agent:') : st.picker.key === '+' ? h.name.startsWith('skill:') : false));
    return '<div class="dropdown picker" role="listbox" aria-label="' + esc(title) + '"><div class="dh"><span>' + esc(title) + '</span><span class="muted">↑↓ Enter Esc</span></div>'
      + (items.length ? items.map((it, i) => '<button type="button" role="option" aria-selected="' + (i === st.picker.i ? 'true' : 'false') + '" class="' + (i === st.picker.i ? 'on' : '') + '" data-pickitem="' + i + '">' + (it.side ? '<span class="side">' + UI.pill(it.side, it.side === 'read' ? 'outline' : it.side === 'write' ? 'warn' : 'danger') + '</span>' : it.kind === 'workflow' ? '<span class="side">' + UI.pill('workflow', 'outline') + '</span>' : '') + esc(it.name) + '<span class="desc">' + esc(it.desc) + '</span></button>').join('') : '<div class="muted" style="padding:8px 12px;font-size:12px">Nothing matches.</div>')
      + (hidden.length ? '<div class="muted" style="padding:6px 12px;font-size:11px;border-top:1px solid var(--line)">Not listed: ' + hidden.map((h) => esc(h.name.split(':')[1]) + ' (' + esc(h.reason) + ')').join('; ') + '</div>' : '') + '</div>';
  }
  function pick(ctx, st, convo, it) {
    st.picker = null; const ta = ctx.$('#composer'); ctx.$('[data-region="picker"]').innerHTML = '';
    if (it.kind === 'skill') { st.skills = st.skills || {}; const on = (st.skills[convo.id] || SKILLS_ON[convo.id] || []).filter((x) => x.name !== it.name); on.push({ name: it.name, mode: 'sticky' }); st.skills[convo.id] = on; ta.value = ''; ctx.rerender(); ctx.toast('Skill ' + esc(it.name) + ' added, sticky. Its instructions join the system prompt from the next turn.', 'ok'); return; }
    if (it.kind === 'agent') { ta.value = '@' + it.name + ': '; ta.focus(); ctx.toast('Say what the agent should do. Enter starts a run bound to this conversation.'); return; }
    // A tool or workflow: a form from its input schema, or text the profile turns into arguments.
    ctx.modal({ title: (it.kind === 'tool' ? 'Call ' : 'Start ') + esc(it.name), body: '<div class="vstack gap8"><div class="fg2" style="font-size:13px">' + esc(it.desc) + (it.side && it.side !== 'read' ? ' A ' + it.side + ' tool waits for your approval on a card before it runs.' : '') + '</div>' + (it.schema || []).map((f) => UI.field(f, UI.input('', { attrs: 'data-arg="' + esc(f) + '"' }))).join('') + UI.field('Or describe it', UI.textarea('', { rows: 2, placeholder: 'Free text the profile\'s model turns into arguments' })) + '</div>', actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn(it.kind === 'tool' ? 'Call' : 'Start', { kind: 'primary', attrs: 'data-toolgo' }) });
    const m = ctx.$('#overlay .modal'); if (m) m.dataset.tool = it.name;
  }

  /** B-8001: the artifacts of the conversation, and the one open with its version switcher and sandboxed render. */
  function artifactsHtml(st, convo) {
    const list = ARTIFACTS[convo.id] || [];
    if (!list.length) return '';
    let h = '<div class="chat-art"><div class="eyebrow">Artifacts</div>';
    const open = st.artifact ? list.find((a) => a.id === st.artifact.id) : null;
    if (open) {
      const v = open.versions.find((x) => x.version === st.artifact.version) || open.versions[open.versions.length - 1];
      h += '<div class="ahead"><b class="mono">' + esc(open.key) + '</b>' + UI.pill(open.kind, 'outline') + (st.readerView ? UI.pill('read only', 'outline') : '') + '<span class="right hstack gap4">' + UI.iconbtn('chevron-left', 'Earlier version', { cls: 'sm', attrs: 'data-artprev' + (v.version === 1 ? ' disabled' : '') })
        + UI.select(open.versions.map((x) => ({ value: String(x.version), label: 'v' + x.version + ', turn ' + x.turn })), String(v.version), 'data-artversion aria-label="Version"') + UI.iconbtn('chevron-right', 'Later version', { cls: 'sm', attrs: 'data-artnext' + (v.version === open.versions.length ? ' disabled' : '') }) + '</span></div>';
      h += open.kind === 'html' ? '<iframe sandbox="allow-scripts" title="' + esc(open.key) + ' version ' + v.version + '" srcdoc="' + esc(v.content) + '"></iframe>' : '<pre>' + esc(v.content) + '</pre>';
      h += '<div class="hstack gap6"><span class="muted" style="font-size:12px">' + v.bytes + ' bytes, from turn ' + v.turn + (open.kind === 'html' ? ', rendered in a sandbox with no access to this page' : '') + '</span>' + UI.btn('Copy', { size: 'sm', attrs: 'data-artcopy' }) + UI.btn('Close', { kind: 'ghost', size: 'sm', attrs: 'data-artclose' }) + '</div>';
    }
    h += '<div class="alist">' + list.map((a) => UI.listItem(esc(a.key), a.versions.length + ' version' + (a.versions.length > 1 ? 's' : '') + ', ' + a.kind, { active: !!(open && open.id === a.id), attrs: 'data-artifact="' + a.id + '" data-version="' + a.versions.length + '"', right: '<span class="muted">v' + a.versions.length + '</span>' })).join('') + '</div></div>';
    return h;
  }
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
