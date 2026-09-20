(function () {
  const { UI, esc } = App;

  const LANES = { think: 'Thinking', do: 'Doing', calc: 'Calculating' };
  const RUNS = [
    { id: '7f3a', agent: 'Data analyst agent', started: '14:02:11', by: 'Mara Okafor', dur: 'finished in 14.6 s', status: 'failed step', label: 'confidential', convo: 'c1', convoTitle: 'Q3 travel overrun', steps: [1, 2, 3, 4, 5, 6, 7], sum: { think: '3 steps, 2,914 tokens', do: '2 calls, 1.9 s', calc: '2 results, 0.04 CPU-s' }, budget: { steps: [7, 20], tokens: [2914, 10000] } },
    { id: '7e91', agent: 'Data analyst agent', started: '13:41:05', by: 'Mara Okafor', dur: 'finished in 9.8 s', status: 'succeeded', label: 'confidential', convo: 'c4', convoTitle: 'Reconcile card feed', steps: [1, 2, 3, 4, 5], sum: { think: '2 steps, 2,306 tokens', do: '1 call, 0.8 s', calc: '2 results, 0.04 CPU-s' }, budget: { steps: [5, 20], tokens: [2306, 10000] } },
    { id: '7d40', agent: 'quarterly-variance v1', started: '13:12:48', by: 'Mara Okafor', dur: 'waiting 12 min', status: 'waiting on approval', label: 'confidential', convo: 'c1', convoTitle: 'Q3 travel overrun', steps: [1, 2, 3, 4, 5, 6], waiting: true, sum: { think: '2 steps, 2,306 tokens', do: '1 call, 1 waiting', calc: '2 results, 0.04 CPU-s' }, budget: { steps: [6, 20], tokens: [2306, 10000] } },
    { id: '7c22', agent: 'Data analyst agent', started: '11:58:30', by: 'Sam Reyes', dur: 'stopped after 41.2 s', status: 'budget stop', label: 'internal', convo: 'c4', convoTitle: 'Reconcile card feed', steps: [1, 2, 3, 4, 5, 6, 7], budgetStop: true, sum: { think: '12 steps, 9,860 tokens', do: '6 calls, 7.4 s', calc: '2 results, 0.05 CPU-s' }, budget: { steps: [20, 20], tokens: [9860, 10000] } }
  ];
  const STEPS = {
    1: { n: 1, lane: 'think', title: 'Plan', meta: 'high, 1,102 tok', body: 'proposal: query ledger, then compute overrun',
      kv: [['Proposal', '<span class="mono">query ledger, then compute overrun</span>'], ['Thinking level', 'high, 1,102 tokens'], ['Profile', '<a href="#" data-goprofile="analyst">analyst</a> on <span class="mono">qwen2.5:32b-q4_K_M</span>'], ['Output', 'a tool call: ledger.query with cost_centre filter'], ['Checkpoints', 'Cedar allowed; proposed-tool-call rule passed'], ['Label', UI.label('confidential', { sm: true })]] },
    2: { n: 2, lane: 'do', title: 'ledger.query', meta: 'read-only, 0.8 s', body: 'SELECT cost_centre, q3_actual, q3_budget ... 14 rows',
      kv: [['Tool', '<span class="mono">ledger.query</span> via connection ledger-ro'], ['Side effect class', UI.pill('read-only', 'ok')], ['Duration', '0.8 s'], ['Acted as', 'Mara Okafor, delegated token, scope <span class="mono">ledger:read</span>'], ['Result', '14 rows, 1.2 KB, stored as a Context-tier segment'], ['Idempotent', 'yes, retried freely'], ['Label', UI.label('confidential', { sm: true })]] },
    3: { n: 3, lane: 'calc', title: 'calc.evaluate', meta: '28 digits, cache miss', body: '(412880 - 361500) / 361500 = 0.142130...',
      kv: [['Expression', '<span class="mono">(412880 - 361500) / 361500</span>'], ['Result', '<span class="mono">0.1421300138312586445366528354</span>'], ['Shown as', '14.2%'], ['Input hashes', '<span class="mono">a41c..9e02, 77b0..13fd</span>'], ['Library', '<span class="mono">calc 1.4.0, decimal128</span>'], ['Label', UI.label('confidential', { sm: true })], ['Cache', 'miss, stored for this tenant']] },
    4: { n: 4, lane: 'calc', title: 'calc.table', meta: '14 rows in, 6 out', body: 'group by cost_centre, sum(actual - budget)',
      kv: [['Expression', '<span class="mono">group by cost_centre, sum(actual - budget)</span>'], ['Result', '6 rows; largest FIELD-SALES 38,420.00, LIS-ONBOARD 36,310.00'], ['Shown as', 'table of 6 cost centres'], ['Input hashes', '<span class="mono">77b0..13fd</span>'], ['Library', '<span class="mono">calc 1.4.0, duckdb 1.1 embedded, no file or network</span>'], ['Label', UI.label('confidential', { sm: true })], ['Cache', 'miss, stored for this tenant']] },
    5: { n: 5, lane: 'think', title: 'Draft answer', meta: 'medium, 1,204 tok', body: 'proposal: final text with 2 citations',
      kv: [['Proposal', 'final text with 2 citations'], ['Thinking level', 'medium, 1,204 tokens'], ['Profile', '<a href="#" data-goprofile="analyst">analyst</a>'], ['Grounding', '3 figures checked against calc results, 0 ungrounded'], ['Citations', 'ledger.query result; Q3 cost centre review.pdf p. 4'], ['Label', UI.label('confidential', { sm: true })]] },
    6: { n: 6, lane: 'do', title: 'jira-internal.create_issue', meta: 'write, 1.1 s', body: 'not retried: tool is not idempotent. HTTP 502 from upstream', failed: true,
      kv: [['Tool', '<span class="mono">jira-internal.create_issue</span> (MCP server jira-internal)'], ['Side effect class', UI.pill('write', 'warn')], ['Confirmed by', 'Mara Okafor at 14:02:19, in chat'], ['Outcome', '<span style="color:var(--danger-fg)">HTTP 502 from upstream after 1.1 s</span>'], ['Retry', 'not retried: tool is not idempotent and carries no idempotency key'], ['Acted as', 'Mara Okafor, delegated token, scope <span class="mono">jira:write</span>'], ['Label', UI.label('confidential', { sm: true })]] },
    7: { n: 7, lane: 'think', title: 'Report failure', meta: 'low, 608 tok', body: 'proposal: tell the user the issue was not created',
      kv: [['Proposal', 'tell the user the issue was not created'], ['Thinking level', 'low, 608 tokens'], ['Profile', '<a href="#" data-goprofile="chat-default">chat-default</a> (cheaper profile for reporting)'], ['Input', 'the step 6 failure as a Context-tier segment'], ['Label', UI.label('confidential', { sm: true })]] }
  };
  const DIVIDERS = { 1: 'Policy allowed, tool ceiling confidential, confirmed by M. Okafor' };
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const statusPill = (s) => UI.pill(s, s === 'succeeded' ? 'ok' : s === 'failed step' ? 'danger' : s === 'waiting on approval' ? 'info' : s === 'budget stop' ? 'warn' : s === 'running' ? 'info' : '');

  App.register({
    id: 'runs', title: 'Runs', summary: 'Agent run timeline by worker class, step inspector, budget, replay',
    crumb: (st, params) => ['Runs', (params && params.run) || st.run || '7f3a'],
    label: (st, params) => (RUNS.find((r) => r.id === ((params && params.run) || st.run || '7f3a')) || RUNS[0]).label,
    commands: [{ label: 'Replay a run from a step', sub: 'Runs', run(app) { app.stateFor('runs').openReplay = true; app.render(); } }],
    states: [
      { title: 'Proposal denied', tone: 'danger', text: 'Cedar denied the tool call: the tool\'s egress ceiling is internal and the run is confidential. The thinking step receives the denial as data.', apply(ctx) { ctx.state.run = '7f3a'; ctx.state.denied = true; ctx.state.sel = 2; ctx.rerender(); } },
      { title: 'Budget stop', tone: 'warn', text: 'The run stopped at 20 of 20 steps. The last checkpoint is kept and the owner can raise the limit and resume.', apply(ctx) { ctx.state.run = '7c22'; ctx.state.sel = 7; ctx.state.resumed = false; ctx.rerender(); } },
      { title: 'Traceable figure', tone: 'ok', text: 'Selecting a number in the final answer highlights the calculating step that produced it.', apply(ctx) { ctx.state.run = '7f3a'; ctx.state.showAnswer = true; ctx.state.sel = 3; ctx.rerender(); setTimeout(() => { const a = ctx.$('#runs-answer'); if (a) a.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 30); } },
      { title: 'Waiting on approval', tone: 'info', text: 'A doing step shows who must approve and how long it has waited.', apply(ctx) { ctx.state.run = '7d40'; ctx.state.sel = 6; ctx.state.decided = null; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.run) { st.run = ctx.params.run; delete ctx.params.run; }
      st.run = st.run || '7f3a'; st.query = st.query || ''; st.extra = st.extra || [];
      const allRuns = st.extra.concat(RUNS);
      const run = allRuns.find((r) => r.id === st.run) || RUNS[0];
      if (st.sel == null || !run.steps.includes(st.sel)) st.sel = run.id === '7f3a' ? 3 : run.steps[run.steps.length - 1];
      const denied = st.denied && run.id === '7f3a';
      const waiting = run.waiting && !st.decided;
      const budgetStop = run.budgetStop && !st.resumed;
      const status = denied ? 'failed step' : run.waiting ? (st.decided === 'approve' ? 'succeeded' : st.decided === 'deny' ? 'failed step' : run.status) : run.budgetStop ? (st.resumed ? 'running' : run.status) : run.status;

      // Steps for this run, with state overrides.
      const step = (n) => {
        const s = Object.assign({}, STEPS[n]);
        if (denied && n === 2) { s.meta = 'denied by Cedar'; s.body = 'not run: tool egress ceiling internal, run label confidential'; s.failed = true; s.kv = [['Tool', '<span class="mono">ledger.query</span>'], ['Decision', UI.pill('denied', 'danger')], ['Policy', '<span class="mono">tenant-egress v4</span>, evaluated in 3 ms'], ['Reason', 'the tool\'s egress ceiling is internal and the run is confidential'], ['Returned to', 'step 5 as a Context-tier segment labelled <span class="mono">policy.denial</span>'], ['Label', UI.label('confidential', { sm: true })]]; }
        if (run.waiting && n === 6) {
          if (waiting) { s.meta = 'write, waiting 12 min'; s.body = 'waiting on approval: Mara Okafor (tool admin), requested 13:12:56'; s.failed = false; s.waiting = true; s.kv = [['Tool', '<span class="mono">jira-internal.create_issue</span>'], ['Side effect class', UI.pill('write', 'warn')], ['Must approve', 'Mara Okafor, tool admin for jira-internal'], ['Requested', '13:12:56, from the run, not from chat'], ['Waited', '12 min of a 60 min window'], ['If nobody approves', 'the step fails and step 7 reports it'], ['Label', UI.label('confidential', { sm: true })]]; }
          else if (st.decided === 'approve') { s.meta = 'write, 1.0 s'; s.body = 'created FIN-1188 in jira-internal as Mara Okafor'; s.failed = false; s.kv = [['Tool', '<span class="mono">jira-internal.create_issue</span>'], ['Side effect class', UI.pill('write', 'warn')], ['Approved by', 'Mara Okafor, 13:25:10'], ['Result', 'FIN-1188 created'], ['Label', UI.label('confidential', { sm: true })]]; }
          else { s.meta = 'write, denied'; s.body = 'denied by Mara Okafor; nothing was written'; s.failed = true; s.kv = [['Tool', '<span class="mono">jira-internal.create_issue</span>'], ['Decision', UI.pill('denied', 'danger')], ['Denied by', 'Mara Okafor, 13:25:10'], ['Returned to', 'the next thinking step as data']]; }
        }
        return s;
      };
      const steps = run.steps.map(step);
      const laneSum = Object.assign({}, run.sum);
      if (denied) laneSum.do = '1 call denied, 1 call 1.1 s';

      const card = (s) => '<div class="runs-card' + (s.failed ? ' failed' : '') + (s.waiting ? ' waiting' : '') + (st.sel === s.n ? ' selected' : '') + '" data-step="' + s.n + '" role="button" tabindex="0"><div class="runs-ch"><span style="font-size:13px;font-weight:600">' + esc(s.title) + '</span><span class="muted" style="font-size:12px">' + esc(s.meta) + '</span></div><div class="mono fg2" style="overflow-wrap:anywhere">' + esc(s.body) + '</div></div>';
      const rows = steps.map((s) => {
        let h = '<div class="runs-row"><div class="runs-n num">' + s.n + '</div>' + ['think', 'do', 'calc'].map((l) => '<div>' + (s.lane === l ? card(s) : '') + '</div>').join('') + '</div>';
        if (DIVIDERS[s.n]) h += '<div class="runs-div"><div></div><div class="runs-divline' + (denied ? ' danger' : '') + '"><span class="rule"></span><span>' + (denied ? 'Policy denied: tool egress ceiling internal, run is confidential. The denial goes back to the thinking step as data.' : esc(DIVIDERS[s.n])) + '</span><span class="rule"></span></div></div>';
        if (s.waiting) h += '<div class="runs-div"><div></div><div class="runs-divline info"><span class="rule"></span><span>Approval requested from Mara Okafor, 12 min ago. The run holds its checkpoint until a decision.</span><span class="rule"></span></div></div>';
        return h;
      }).join('');

      const selStep = steps.find((s) => s.n === st.sel) || steps[0];
      const inspectorActions = selStep.lane === 'calc' ? UI.btn('Copy with provenance', { attrs: 'data-copyprov' })
        : selStep.waiting ? '<div class="hstack gap6">' + UI.btn('Approve', { kind: 'primary', attrs: 'data-approve' }) + UI.btn('Deny', { attrs: 'data-deny' }) + '</div>'
        : selStep.failed ? UI.btn('Replay from this step', { icon: 'refresh', attrs: 'data-replay="' + selStep.n + '"' })
        : selStep.n === 5 ? UI.btn(st.showAnswer ? 'Hide final answer' : 'Show final answer', { attrs: 'data-toggleanswer' })
        : selStep.lane === 'think' ? UI.btn('Show thinking trace', { icon: 'brain', attrs: 'data-trace="' + selStep.n + '"' })
        : UI.btn('Show result segment', { attrs: 'data-segment="' + selStep.n + '"' });

      const answer = st.showAnswer && run.id === '7f3a' ? '<section class="panel" id="runs-answer"><div class="phead"><div class="eyebrow">Final answer, step 5</div><span class="muted" style="font-size:12px">Select a figure to see the calculating step that produced it</span></div><div class="serif" style="font-size:15px;line-height:1.6">Travel spend for Q3 came to <button type="button" class="runs-fig" data-fig="4">412,880 EUR</button> against a budget of 361,500 EUR, an overrun of <button type="button" class="runs-fig' + (st.sel === 3 ? ' on' : '') + '" data-fig="3">14.2%</button>. Two cost centres account for most of it: Field Sales at <button type="button" class="runs-fig' + (st.sel === 4 ? ' on' : '') + '" data-fig="4">38,420 EUR</button> over and the Lisbon onboarding programme at <button type="button" class="runs-fig' + (st.sel === 4 ? ' on' : '') + '" data-fig="4">36,310 EUR</button> over. The Jira issue was not created; the upstream returned an error.</div></section>' : '';

      const budgetNotice = budgetStop ? UI.notice('<b>Budget stop.</b> The run stopped at 20 of 20 steps. The last checkpoint is kept; raise the limit to resume from step 21.', 'warn', UI.btn('Raise limit and resume', { size: 'sm', attrs: 'data-raise' })) : st.resumed && run.budgetStop ? UI.notice('Step limit raised to 40 by Mara Okafor. The run resumed from the kept checkpoint at step 21.', 'ok') : '';
      const stepsUsed = run.budget.steps[0], stepsMax = st.resumed && run.budgetStop ? 40 : run.budget.steps[1];

      root.innerHTML = '<style>'
        + '.runs-list{display:flex;flex-direction:column;gap:2px}.runs-page > *{flex-shrink:0}'
        + '.runs-lanes,.runs-row{display:grid;grid-template-columns:28px repeat(3,minmax(0,1fr));gap:10px;align-items:start}'
        + '.runs-lane{display:flex;justify-content:space-between;align-items:center;gap:4px 8px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--line)}'
        + '.runs-lane .ln{display:inline-flex;align-items:center;gap:4px;padding:1px 8px 1px 5px;border:1px solid var(--line);border-radius:4px;font-size:12px;font-weight:600;color:var(--fg2);background:var(--panel);white-space:nowrap}.runs-lane .ls{font-size:12px;color:var(--fg2)}'
        + '.runs-n{font-size:12px;color:var(--muted);padding-top:9px}.runs-ch{display:flex;justify-content:space-between;align-items:baseline;gap:2px 8px;flex-wrap:wrap}.runs-ch > span:first-child{overflow-wrap:anywhere;min-width:0}'
        + '.runs-card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:6px;min-width:0;cursor:pointer}.runs-card:hover{border-color:var(--muted)}.runs-card.selected{background:var(--accent-tint);border-color:var(--accent)}.runs-card.failed{border-color:var(--danger-fg)}.runs-card.waiting{border-color:var(--info-fg);border-style:dashed}'
        + '.runs-div{display:grid;grid-template-columns:28px minmax(0,1fr);gap:10px}.runs-divline{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted)}.runs-divline .rule{flex-grow:1;height:1px;background:var(--line)}.runs-divline.danger{color:var(--danger-fg)}.runs-divline.info{color:var(--info-fg)}'
        + '.runs-fig{font:inherit;font-family:var(--sans);font-size:13px;font-weight:600;padding:0 5px;border:1px solid var(--line);border-radius:4px;background:var(--panel);cursor:pointer;color:var(--fg)}.runs-fig:hover,.runs-fig.on{border-color:var(--ok-fg);background:var(--ok-bg);color:var(--ok-fg)}'
        + '@media (max-width:900px){.runs-lanes{display:none}.runs-row{grid-template-columns:28px 1fr}.runs-row > div:empty{display:none}}'
        + '</style>'
        + '<div class="leftpane"><div class="hstack"><div class="eyebrow grow">Recent runs</div>' + UI.iconbtn('refresh', 'Refresh', { cls: 'sm ghost', attrs: 'data-refresh' }) + '</div>' + UI.search('Filter runs', 'data-search', st.query).replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="runs-list">' + allRuns.filter((r) => !st.query || (r.id + ' ' + r.agent + ' ' + r.status + ' ' + r.by).toLowerCase().includes(st.query.toLowerCase())).map((r) => UI.listItem('<span class="mono">' + esc(r.id) + '</span>', esc(r.agent) + ' · ' + esc(r.started) + ', ' + esc(r.by), { active: r.id === run.id, attrs: 'data-run="' + esc(r.id) + '"', right: statusPill(r.id === run.id ? status : r.status) })).join('') + '</div>'
        + '<div class="muted" style="font-size:12px;margin-top:auto">Runs from agents, workflows and background jobs in Finance Ops. Cost and latency break down by worker class.</div></div>'
        + '<div class="page runs-page">'
        + UI.pagehead('Run ' + run.id + ', ' + run.agent, 'Started ' + esc(run.started) + ' by ' + esc(run.by) + ', ' + esc(run.dur) + ' · ' + statusPill(status) + ' · from <a href="#" data-goconvo="' + esc(run.convo) + '">' + esc(run.convoTitle) + '</a>', UI.btn('Open trace', { attrs: 'data-opentrace' }) + UI.btn('Replay from step', { attrs: 'data-replay="' + (steps.find((s) => s.failed) || { n: 1 }).n + '"' }))
        + budgetNotice
        + '<div class="runs-lanes"><div></div>' + ['think', 'do', 'calc'].map((l) => '<div class="runs-lane"><span class="ln">' + UI.icon(l === 'think' ? 'brain' : l === 'do' ? 'play' : 'calc', 12) + esc(LANES[l]) + '</span><span class="ls">' + esc(laneSum[l]) + '</span></div>').join('') + '</div>'
        + rows
        + (budgetStop ? '<div class="runs-row"><div class="runs-n">…</div><div class="muted" style="grid-column:2/-1;font-size:12px">Steps 8 to 20 collapsed. The run reached its step limit while looping on ledger.query pagination.</div></div>' : '')
        + answer
        + '<div style="margin-top:6px"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div>'
        + '<aside class="inspector"><div class="hstack"><div class="eyebrow grow">Step ' + selStep.n + ', ' + esc(LANES[selStep.lane].toLowerCase()) + '</div>' + (selStep.failed ? UI.pill('failed', 'danger') : selStep.waiting ? UI.pill('waiting', 'info') : '') + '</div>'
        + UI.kv(selStep.kv, 1)
        + inspectorActions
        + '<div class="eyebrow">Budget</div>'
        + UI.meter('Steps', stepsUsed + ' of ' + stepsMax, (stepsUsed / stepsMax) * 100, stepsUsed >= stepsMax ? 'danger' : stepsUsed / stepsMax > 0.8 ? 'warn' : '')
        + UI.meter('Tokens', fmt(run.budget.tokens[0]) + ' of ' + fmt(run.budget.tokens[1]), (run.budget.tokens[0] / run.budget.tokens[1]) * 100, run.budget.tokens[0] / run.budget.tokens[1] > 0.9 ? 'warn' : '')
        + '<div class="muted" style="font-size:12px">Metered per class: tokens for thinking, calls and seconds for doing, CPU-seconds for calculating. Trace <span class="mono">' + TRACE.slice(0, 8) + '…</span></div>'
        + '</aside>';

      ctx.on('click', '[data-run]', (e, t) => { st.run = t.dataset.run; st.sel = null; st.showAnswer = false; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-refresh]', () => ctx.toast('Run list refreshed over /ws.'));
      ctx.on('click', '.runs-card', (e, t) => { st.sel = +t.dataset.step; ctx.rerender(); });
      ctx.on('keydown', '.runs-card', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = +t.dataset.step; ctx.rerender(); } });
      ctx.on('click', '[data-fig]', (e, t) => { st.sel = +t.dataset.fig; ctx.rerender(); setTimeout(() => { const c = ctx.$('.runs-card.selected'); if (c) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 20); });
      ctx.on('click', '[data-toggleanswer]', () => { st.showAnswer = !st.showAnswer; ctx.rerender(); });
      ctx.on('click', '[data-goconvo]', (e, t) => { e.preventDefault(); ctx.navigate('chat', { convo: t.dataset.goconvo }); });
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', '[data-copyprov]', () => ctx.toast('Copied <b>' + (selStep.n === 3 ? '14.2%' : '6 rows') + '</b> with expression, input hashes, library version and label.', 'ok'));
      ctx.on('click', '[data-trace]', (e, t) => { const s = STEPS[+t.dataset.trace]; ctx.drawer({ title: 'Thinking trace, step ' + s.n, body: UI.kv([['Level', esc(s.meta)], ['Profile', 'analyst, <span class="mono">qwen2.5:32b-q4_K_M</span>']], 2) + '<div style="padding:10px 12px;border-left:2px solid var(--line);font-size:13px;color:var(--fg2);font-style:italic">' + (s.n === 1 ? 'The user wants a variance and a cause. The ledger holds Q3 actuals by cost centre; query it with a cost_centre filter, then hand the arithmetic to calc so the percentage is exact. Cite the Finance KB for the Lisbon exception before attributing the overrun.' : 'The issue was not created and the tool must not be retried. Tell the user plainly, keep the figures from step 5, and offer to create the issue manually.') + '</div>' + UI.notice('Thinking output is a proposal only. Nothing ran until the checkpoint below allowed it.', 'info'), actions: UI.btn('Close', { attrs: 'data-close' }) }); });
      ctx.on('click', '[data-segment]', () => ctx.modal({ title: 'Result segment, step ' + selStep.n, body: UI.ctx('ledger.query, 14 rows', 'cost_centre, q3_actual, q3_budget\nFIELD-SALES, 188420.00, 150000.00\nLIS-ONBOARD, 96310.00, 60000.00\nTREASURY, 41200.00, 44000.00\n… 11 more rows', 'confidential') + '<div class="fg2">Returned to the orchestrator as a labelled Context-tier segment and fed to the next thinking step.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) }));
      ctx.on('click', '[data-opentrace]', () => ctx.modal({ cls: 'wide', title: 'Trace ' + '<span class="mono">' + TRACE + '</span>', body: UI.table(['Span', 'worker.class', 'Started', 'Duration', 'Status'], [
        ['orchestrator.run', '—', '14:02:11.020', '14.6 s', UI.pill(status)],
        ['think.plan', 'think', '14:02:11.041', '4.8 s', UI.pill('ok')], ['policy.cedar', '—', '14:02:15.902', '3 ms', UI.pill(denied ? 'denied' : 'allowed')],
        ['do.ledger.query', 'do', '14:02:16.110', denied ? '—' : '0.8 s', UI.pill(denied ? 'skipped' : 'ok', denied ? 'outline' : 'ok')], ['calc.evaluate', 'calc', '14:02:16.930', '2 ms', UI.pill('ok')], ['calc.table', 'calc', '14:02:16.940', '38 ms', UI.pill('ok')],
        ['think.draft', 'think', '14:02:17.001', '6.9 s', UI.pill('ok')], ['do.jira-internal.create_issue', 'do', '14:02:24.310', '1.1 s', UI.pill('HTTP 502', 'danger')], ['think.report', 'think', '14:02:25.480', '1.9 s', UI.pill('ok')]
      ], { clickable: false, minWidth: '0' }) + '<div class="hstack"><span class="muted grow" style="font-size:12px">Every span carries worker.class, so cost and latency break down by class. Spans go to the tenant\'s OpenTelemetry collector.</span>' + UI.btn('Copy trace ID', { size: 'sm', attrs: 'data-copy="' + TRACE + '"' }) + '</div>', actions: UI.btn('Close', { attrs: 'data-close' }), onMount(m) { m.querySelector('[data-copy]').addEventListener('click', () => ctx.toast('Copied ' + TRACE)); } }));
      ctx.on('click', '[data-replay]', (e, t) => openReplay(+t.dataset.replay));
      ctx.on('click', '[data-raise]', async () => { const ok = await ctx.confirm({ title: 'Raise the step limit and resume', tone: 'primary', ok: 'Raise to 40 and resume', body: '<div class="fg2">The run keeps its checkpoint after step 20. Raising the limit applies to this run only; the agent\'s default stays at 20.</div>', kv: [['Run', '<span class="mono">' + esc(run.id) + '</span>'], ['Owner', esc(run.by)], ['Steps', '20 of 20 used'], ['Tokens', '9,860 of 10,000 used']] }); if (!ok) return; st.resumed = true; ctx.rerender(); ctx.toast('Limit raised to 40. Run ' + esc(run.id) + ' resumed from step 21.', 'ok'); });
      ctx.on('click', '[data-approve]', async () => { const ok = await ctx.confirm({ title: 'Approve jira-internal.create_issue', tag: 'write', tone: 'primary', ok: 'Approve', body: '<div class="fg2">The doing worker runs the call with your delegated token. The action is logged to audit with you as approver.</div>', kv: [['Project', 'FIN'], ['Summary', 'Q3 variance review'], ['Tool ceiling', 'confidential'], ['Waited', '12 min']] }); if (!ok) return; st.decided = 'approve'; ctx.rerender(); ctx.toast('Approved. FIN-1188 created in jira-internal as Mara Okafor.', 'ok'); });
      ctx.on('click', '[data-deny]', async () => { const ok = await ctx.confirm({ title: 'Deny this action', tone: 'danger', ok: 'Deny', body: '<div class="fg2">Nothing is written. The agent receives the denial as data and its next thinking step decides how to report it.</div>' }); if (!ok) return; st.decided = 'deny'; ctx.rerender(); ctx.toast('Denied. The run continues with the denial as data.'); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));

      function openReplay(from) {
        ctx.modal({ title: 'Replay from step', body: UI.field('Start from', UI.select(steps.map((s) => ({ value: String(s.n), label: 'Step ' + s.n + ', ' + s.title + ' (' + LANES[s.lane].toLowerCase() + ')' })), String(from), 'data-from')) + UI.notice('Replay starts from the checkpoint before the chosen step. Earlier results are reused from the run record; later steps run again as a new run with the same label and budget.', 'info') + UI.kv([['Source run', '<span class="mono">' + esc(run.id) + '</span>'], ['New run', '<span class="mono">' + esc(run.id.slice(0, 3)) + 'b</span>'], ['Budget', stepsMax + ' steps, 10,000 tokens'], ['Label', UI.label(run.label, { sm: true })]], 2), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Replay', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', () => { const n = +m.querySelector('[data-from]').value; App.closeOverlay(); const nid = run.id.slice(0, 3) + 'b'; if (!st.extra.find((r) => r.id === nid)) st.extra.unshift(Object.assign({}, run, { id: nid, started: '14:31:02', by: 'Mara Okafor', dur: 'running, from step ' + n, status: 'running', waiting: false, budgetStop: false })); ctx.toast('Replay queued as run <span class="mono">' + nid + '</span> from step ' + n + '.', 'ok'); st.run = nid; st.sel = n; ctx.rerender(); });
        } });
      }
      if (st.openReplay) { st.openReplay = false; setTimeout(() => openReplay((steps.find((s) => s.failed) || { n: 1 }).n), 30); }
    }
  });
})();
