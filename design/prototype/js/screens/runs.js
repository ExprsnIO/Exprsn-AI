(function () {
  const { UI, esc } = App;

  const LANES = { think: 'Thinking', do: 'Doing', calc: 'Calculating' };
  const RUNS = [
    { id: '8a12', agent: 'Close planner 1.0.0', started: '14:20:04', by: 'Mara Okafor', dur: 'waiting 7 min', status: 'waiting on approval', label: 'confidential', convo: 'c1', convoTitle: 'Q3 travel overrun', steps: [1, 2], map: 'planner', chain: 'n0', sum: { think: '1 step, 1,904 tokens', do: '1 call, 1 waiting', calc: 'none' }, budget: { steps: [2, 20], tokens: [1904, 20000] } },
    { id: '8a13', agent: 'Close broker 1.0.0', started: '14:20:11', by: 'Mara Okafor', dur: 'waiting 7 min', status: 'waiting on approval', label: 'confidential', convo: 'c1', convoTitle: 'Q3 travel overrun', steps: [1, 2, 3, 4], map: 'broker', chain: 'n2', caller: '8a12', sum: { think: '2 steps, 2,210 tokens', do: '2 calls, 1 waiting', calc: 'none' }, budget: { steps: [4, 18], tokens: [2210, 18096] } },
    { id: '8a14', agent: 'Clerk 1.0.0', started: '14:20:52', by: 'Mara Okafor', dur: 'waiting 7 min', status: 'waiting on approval', label: 'confidential', convo: 'c1', convoTitle: 'Q3 travel overrun', steps: [1, 2], map: 'clerk', chain: 'n6', caller: '8a13', sum: { think: '1 step, 1,118 tokens', do: '1 call, 1 waiting', calc: 'none' }, budget: { steps: [2, 14], tokens: [1118, 14706] } },
    { id: '7f3a', agent: 'Data analyst agent', started: '14:02:11', by: 'Mara Okafor', dur: 'finished in 14.6 s', status: 'failed step', label: 'confidential', convo: 'c1', convoTitle: 'Q3 travel overrun', steps: [1, 2, 3, 4, 5, 6, 7], sum: { think: '3 steps, 2,914 tokens', do: '2 calls, 1.9 s', calc: '2 results, 0.04 CPU-s' }, budget: { steps: [7, 20], tokens: [2914, 10000] } },
    { id: '7e91', agent: 'Data analyst agent', started: '13:41:05', by: 'Mara Okafor', dur: 'finished in 9.8 s', status: 'succeeded', label: 'confidential', convo: 'c4', convoTitle: 'Reconcile card feed', steps: [1, 2, 3, 4, 5], sum: { think: '2 steps, 2,306 tokens', do: '1 call, 0.8 s', calc: '2 results, 0.04 CPU-s' }, budget: { steps: [5, 20], tokens: [2306, 10000] } },
    { id: '7d40', agent: 'quarterly-variance v1', started: '13:12:48', by: 'Mara Okafor', dur: 'waiting 12 min', status: 'waiting on approval', label: 'confidential', convo: 'c1', convoTitle: 'Q3 travel overrun', steps: [1, 2, 3, 4, 5, 6], waiting: true, sum: { think: '2 steps, 2,306 tokens', do: '1 call, 1 waiting', calc: '2 results, 0.04 CPU-s' }, budget: { steps: [6, 20], tokens: [2306, 10000] } },
    { id: '7b10', agent: 'Support triage 0.4.0', started: '12:10:03', by: 'Sam Reyes', dur: 'finished in 6.2 s', status: 'succeeded', label: 'internal', convo: 'c2', convoTitle: 'Invoice due date', steps: [8, 9], handedTo: { agent: 'Billing agent', run: '7b11' }, sum: { think: '1 step, 410 tokens', do: '1 handoff, 5.1 s', calc: 'no results' }, budget: { steps: [2, 12], tokens: [410, 12000] } },
    // 1.7.0 (B-11703, B-11705): a plan-first run waits on its plan; its steps carry their thinking level.
    { id: '7e95', agent: 'Data analyst agent', started: '14:31:02', by: 'Mara Okafor', dur: 'waiting 2 min', status: 'waiting on plan', label: 'confidential', convo: 'c4', convoTitle: 'Reconcile card feed', steps: [11, 12, 13, 14], planFirst: true, sum: { think: '2 steps, 1,146 tokens', do: '1 call, 0.6 s', calc: '0 results' }, budget: { steps: [2, 20], tokens: [1146, 10000] } },
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
    8: { n: 8, lane: 'think', title: 'Plan', meta: 'low, 410 tok', body: 'proposal: hand the conversation to agent:Billing agent with the invoice question',
      kv: [['Proposal', '<span class="mono">agent:Billing agent {"task": "A customer asks: when is my invoice due?"}</span>'], ['Thinking level', 'low, 410 tokens'], ['Profile', '<a href="#" data-goprofile="chat-default">chat-default</a>'], ['Tools offered', '<span class="mono">agent_Billing_agent</span> <span class="muted">(handoff: a specialist that answers in this run\'s place), kb_search</span>']] },
    9: { n: 9, lane: 'do', title: 'agent:Billing agent', meta: 'handoff, 5.1 s', body: 'handed off: run 7b11 answered "Your invoice is due on the fifth of next month." and this run ended with it',
      kv: [['Tool', '<span class="mono">agent:Billing agent</span> (handoff listed in the agent definition)'], ['Context handed over', '<span class="mono">A customer asks: when is my invoice due?</span>'], ['Specialist run', '<a href="#" data-run="7b11" class="mono">7b11</a>, Billing agent 1.0.0, succeeded in 5.1 s'], ['Answer', 'Your invoice is due on the fifth of next month.'], ['Attributed to', 'Billing agent: the reader sees who answered; audited agent.run.handed_off'], ['Budget', 'the handed-to run\'s tokens count against this run\'s budget too']] },
    // 1.7.0 (B-11703): the plan step of a plan-first run, the steps under the approved plan and a call outside it.
    11: { n: 11, lane: 'think', title: 'Plan', meta: 'draft, 340 tok', body: 'plan: pull the card feed, join it to the ledger, report the residue', waiting: true, plan: true,
      kv: [['Plan', '<ol style="margin:0;padding-left:18px"><li>Pull last week\'s card transactions <span class="mono">cards.query</span></li><li>Join them to the ledger on amount and date within two days <span class="mono">ledger.query</span>, <span class="mono">calc.table</span></li><li>Report the lines without a match</li></ol>'], ['Tools it names', '<span class="mono">cards.query, ledger.query, calc.table</span>'], ['Thinking level', 'off for the draft; the run thinks at medium, ceiling high'], ['Who decides', 'the run\'s owner, Mara Okafor; approve as drafted or edited, or decline'], ['Label', UI.label('confidential', { sm: true })]] },
    12: { n: 12, lane: 'do', title: 'cards.query', meta: 'read-only, 0.6 s', body: 'SELECT ... FROM card_feed WHERE posted >= date(\'now\', \'-7 days\') ... 41 rows',
      kv: [['Tool', '<span class="mono">cards.query</span>'], ['Plan step', '1 of 3, within the approved plan'], ['Side effect', 'none, read-only'], ['Rows', '41, under the 2,000 cap'], ['Label', UI.label('confidential', { sm: true })]] },
    13: { n: 13, lane: 'think', title: 'Match the lines', meta: 'medium, 806 tok', body: 'proposal: file a Jira issue for the three unmatched lines',
      kv: [['Proposal', '<span class="mono">jira-internal.create_issue</span>'], ['Thinking level', 'medium, 806 tokens, within ceiling high; counted against the run budget'], ['Plan step', 'none: the plan does not name this tool'], ['Label', UI.label('confidential', { sm: true })]] },
    14: { n: 14, lane: 'do', title: 'jira-internal.create_issue', meta: 'write, outside the plan', body: 'waiting: the approved plan does not name jira-internal.create_issue; a new approval is needed', waiting: true, deviation: true,
      kv: [['Tool', '<span class="mono">jira-internal.create_issue</span>'], ['Side effect', UI.pill('write', 'warn')], ['Plan', 'not in it: the plan names cards.query, ledger.query and calc.table'], ['Who decides', 'the run\'s owner, Mara Okafor'], ['Label', UI.label('confidential', { sm: true })]] },
    7: { n: 7, lane: 'think', title: 'Report failure', meta: 'low, 608 tok', body: 'proposal: tell the user the issue was not created',
      kv: [['Proposal', 'tell the user the issue was not created'], ['Thinking level', 'low, 608 tokens'], ['Profile', '<a href="#" data-goprofile="chat-default">chat-default</a> (cheaper profile for reporting)'], ['Input', 'the step 6 failure as a Context-tier segment'], ['Label', UI.label('confidential', { sm: true })]] }
  };
  // Steps of the three runs of the close chain (Close planner delegates to Close broker, which starts a workflow and
  // delegates to Clerk, whose write call is held three levels down).
  const L = () => UI.label('confidential', { sm: true });
  const CHAIN_STEPS = {
    planner: {
      1: { n: 1, lane: 'think', title: 'Plan', meta: 'medium, 1,904 tok', body: 'proposal: call agent:Close broker with the close notice task', kv: [['Proposal', '<span class="mono">agent:Close broker {"task": "Get the September close notice posted."}</span>'], ['Thinking level', 'medium, 1,904 tokens'], ['Profile', '<a href="#" data-goprofile="analyst">analyst</a>'], ['Delegates offered', 'agent:Close broker (from the definition\'s delegates)'], ['Label', L()]] },
      2: { n: 2, lane: 'do', title: 'agent:Close broker', meta: 'delegate, waiting 7 min', body: 'waiting on run 8a13, Close broker 1.0.0, with 18 steps and 18,096 tokens left', waiting: true, awaiting: '8a13', kv: [['Tool', '<span class="mono">agent:Close broker</span> (delegate 1.0.0)'], ['Child run', '<a href="#" data-run="8a13" class="mono">8a13</a>, Close broker 1.0.0'], ['Budgets passed down', '18 steps, 18,096 tokens, 594 s, 6 tool calls: what this run had left'], ['Guardrail', 'tool-call checkpoint allowed'], ['Waiting on', 'the chain: feed.post is held in Clerk, two delegations down'], ['Label', L()]] }
    },
    broker: {
      1: { n: 1, lane: 'think', title: 'Plan', meta: 'medium, 1,240 tok', body: 'proposal: call workflow:quarterly-variance for the figures', kv: [['Proposal', '<span class="mono">workflow:quarterly-variance {"period": "2026-09"}</span>'], ['Thinking level', 'medium, 1,240 tokens'], ['Workflows offered', 'workflow:quarterly-variance (listed in the definition, not published as a tool)'], ['Label', L()]] },
      2: { n: 2, lane: 'do', title: 'workflow:quarterly-variance', meta: 'read, 38.4 s', body: '{run: wr_01J8M4R2, output: {variance: "51380.00"}}, typed by the trigger schema', kv: [['Tool', '<span class="mono">workflow:quarterly-variance</span> v1'], ['Workflow run', '<a href="#" data-gowfrun="wr_01J8M4R2" class="mono">wr_01J8M4R2</a>'], ['Result', '<span class="mono">{"variance": "51380.00"}</span>, valid against the output schema'], ['Duration', '38.4 s'], ['Label', L()]] },
      3: { n: 3, lane: 'think', title: 'Delegate the post', meta: 'low, 970 tok', body: 'proposal: call agent:Clerk to post the notice', kv: [['Proposal', '<span class="mono">agent:Clerk {"task": "Post the September close notice."}</span>'], ['Thinking level', 'low, 970 tokens'], ['Label', L()]] },
      4: { n: 4, lane: 'do', title: 'agent:Clerk', meta: 'delegate, waiting 7 min', body: 'waiting on run 8a14, Clerk 1.0.0', waiting: true, awaiting: '8a14', kv: [['Tool', '<span class="mono">agent:Clerk</span> (delegate 1.0.0)'], ['Child run', '<a href="#" data-run="8a14" class="mono">8a14</a>, Clerk 1.0.0'], ['Budgets passed down', '14 steps, 14,706 tokens, 545 s, 4 tool calls'], ['Waiting on', 'feed.post, held in Clerk'], ['Label', L()]] }
    },
    clerk: {
      1: { n: 1, lane: 'think', title: 'Plan', meta: 'low, 1,118 tok', body: 'proposal: call feed.post with the notice; skills close-checklist and variance-analysis loaded', kv: [['Proposal', '<span class="mono">feed.post {"body": "September close is done: variance 51,380.00 EUR."}</span>'], ['Skills loaded', 'close-checklist 1.2.0, which builds on variance-analysis 3.0.0 (loaded first, once)'], ['Label', L()]] },
      2: { n: 2, lane: 'do', title: 'feed.post', meta: 'write, waiting 7 min', body: 'held for approval; decided at the root run 8a12', waiting: true, held: true, kv: [['Tool', '<span class="mono">feed.post</span> 1.0.0'], ['Side effect class', UI.pill('write', 'warn')], ['Must approve', 'the run\'s owner or a tool admin'], ['Decided from', 'the root run <a href="#" data-run="8a12" class="mono">8a12</a>, where the path is shown'], ['Label', L()]] }
    }
  };
  const DIVIDERS = { 1: 'Policy allowed, tool ceiling confidential, confirmed by M. Okafor' };
  const CHAIN_ID = 'ch_01J8M4QZ';
  const KIND_TEXT = { 'agent-run': 'agent run', 'tool-call': 'tool call', 'workflow-run': 'workflow run', 'skill-load': 'skill', 'chat-turn': 'chat turn', 'plugin-action': 'plugin action', 'app-trigger': 'app trigger' };
  const NODE_STATE = { running: 'info', succeeded: 'ok', failed: 'danger', refused: 'danger', waiting: 'info', cancelled: 'warn' };

  /** The close chain as GET /api/chains/:id returns it, for the scenario in st (held, decided, or a child's budget stop). */
  function chainTree(st) {
    const fail = !!st.chainFail; const dec = st.chainDecided || null; const held = !fail && !dec;
    const N = (id, depth, kind, name, o) => Object.assign({ id, depth, kind, name, ref: null, label: 'confidential', state: 'succeeded', error: null, errorType: null, decision: null, usage: { tokens: 0, steps: 0, wallMs: 0, gpuMs: 0 }, started: '14:20:04', dur: '', guardrails: [], replay: null, held: null, children: [], think: kind === 'agent-run' ? 'medium' : null, thinkingTokens: kind === 'agent-run' ? 1240 : 0, plan: null }, o);
    const u = (tokens, steps, wallMs, gpuMs) => ({ tokens, steps, wallMs, gpuMs });
    const run = held ? 'waiting' : 'succeeded';
    const n9 = fail ? N('n9', 5, 'tool-call', 'ledger.query@1.1.2', { started: '14:20:58', dur: '0.8 s', decision: 'allow', usage: u(0, 0, 800, 0) })
      : N('n9', 5, 'tool-call', 'feed.post@1.0.0', { started: '14:20:58', dur: held ? 'waiting 7 min' : '1.0 s', state: held ? 'waiting' : dec === 'reject' ? 'failed' : 'succeeded', errorType: dec === 'reject' ? 'rejected' : null, error: dec === 'reject' ? 'Rejected by Mara Okafor: not before the controller signs off. Nothing was run.' : null, decision: 'allow', usage: u(0, 0, held ? 0 : 1000, 0) });
    const clerk = N('n6', 4, 'agent-run', 'Clerk', { ref: '8a14', started: '14:20:52', dur: held ? 'waiting 7 min' : fail ? '9.1 s' : '7.6 s', state: fail ? 'failed' : run, errorType: fail ? 'budget' : null, error: fail ? 'Clerk 1.0.0 stopped at its budget: 4 of 4 tool calls' : null, usage: u(held ? 1118 : 1498, held ? 2 : 3, held ? 5400 : 7600, held ? 3100 : 4200), guardrails: [['tool-call', 'allow', '14:20:58']], replay: { fromStep: [1, 2] }, held: held ? { tool: 'feed.post', side: 'write', since: '14:20:58', approvers: 'the run\'s owner or a tool admin', step: 2 } : null,
      children: [N('n7', 5, 'skill-load', 'variance-analysis@3.0.0', { started: '14:20:52', dur: '4 ms', usage: u(0, 0, 4, 0) }), N('n8', 5, 'skill-load', 'close-checklist@1.2.0', { started: '14:20:52', dur: '3 ms', usage: u(0, 0, 3, 0) }), n9] });
    const broker = N('n2', 2, 'agent-run', 'Close broker', { ref: '8a13', started: '14:20:11', think: 'low', thinkingTokens: 970, plan: { steps: ['Get the quarter\'s variance from workflow:quarterly-variance', 'Hand the post to agent:Clerk'], tools: ['workflow:quarterly-variance', 'agent:Clerk'], approvedBy: 'Mara Okafor' }, dur: held ? 'waiting 7 min' : '52.0 s', state: run, usage: u(held ? 2210 : 2750, held ? 4 : 5, held ? 41000 : 43000, held ? 9800 : 11000), guardrails: [['tool-call', 'allow', '14:20:13'], ['tool-call', 'allow', '14:20:51']], replay: { fromStep: [1, 2, 3, 4] },
      children: [
        N('n3', 3, 'tool-call', 'workflow:quarterly-variance', { started: '14:20:13', dur: '38.4 s', decision: 'allow', usage: u(0, 0, 0, 0), children: [N('n4', 4, 'workflow-run', 'quarterly-variance', { ref: 'wr_01J8M4R2', started: '14:20:13', dur: '38.2 s', usage: u(1180, 4, 38200, 6100), guardrails: [['context', 'allow', '14:20:40']], replay: { fromNode: ['ledger', 'variance', 'narrative', 'approve', 'post'] } })] }),
        N('n5', 3, 'tool-call', 'agent:Clerk', { started: '14:20:51', dur: held ? 'waiting 7 min' : '9.1 s', state: fail ? 'failed' : run, errorType: fail ? 'budget' : null, error: fail ? 'child_budget: Clerk 1.0.0 stopped at its budget: 4 of 4 tool calls' : null, decision: 'allow', children: [clerk] })
      ] });
    const rootNode = N('n0', 0, 'agent-run', 'Close planner', { ref: '8a12', dur: held ? 'waiting 7 min' : '1 m 4 s', state: run, usage: u(held ? 1904 : 2516, held ? 2 : 3, held ? 6100 : 8300, held ? 5200 : 6400), guardrails: [['tool-call', 'allow', '14:20:09']], replay: { fromStep: [1, 2] },
      children: [N('n1', 1, 'tool-call', 'agent:Close broker', { started: '14:20:09', dur: held ? 'waiting 7 min' : '55.4 s', state: run, decision: 'allow', children: [broker] })] });
    const sum = (n) => { const s = n.children.map(sum).reduce((a, k) => ({ tokens: a.tokens + k.tokens, steps: a.steps + k.steps, wallMs: a.wallMs + k.wallMs, gpuMs: a.gpuMs + k.gpuMs, nodes: a.nodes + k.nodes }), Object.assign({ nodes: 1 }, n.usage)); n.subtree = s; return s; };
    const totals = sum(rootNode);
    const flat = []; (function walk(n, parent) { n.parent = parent; flat.push(n); n.children.forEach((k) => walk(k, n)); })(rootNode, null);
    const pathTo = (n) => { const out = []; for (let x = n; x; x = x.parent) out.unshift(x); return out; };
    const heldList = flat.filter((n) => n.held).map((n) => ({ node: n, path: pathTo(n) }));
    return { id: CHAIN_ID, state: held ? 'running' : 'done', label: 'confidential', principal: 'Mara Okafor', budgets: { tokens: 20000, steps: 40, wallMs: 600000, gpuMs: 120000 }, used: totals, totals, maxDepth: 5, limit: 8, root: rootNode, flat, held: heldList };
  }
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const statusPill = (s) => UI.pill(s, s === 'succeeded' ? 'ok' : s === 'failed step' ? 'danger' : s === 'waiting on approval' ? 'info' : s === 'budget stop' ? 'warn' : s === 'running' ? 'info' : '');

  const STYLE = '<style>'
    + '.runs-list{display:flex;flex-direction:column;gap:2px}.runs-page > *{flex-shrink:0}'
    + '.runs-tree{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;min-width:0}.runs-tree .runs-tree{padding-left:12px;margin-left:10px;border-left:1px solid var(--line)}'
    + '.runs-node{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;width:100%;min-width:0;text-align:left;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--fg);font:inherit;font-size:13px;cursor:pointer}'
    + '.runs-node:hover{background:var(--panel2)}.runs-node.selected{background:var(--accent-tint);border-color:var(--accent)}.runs-node.held{border-color:var(--info-fg);border-style:dashed}'
    + '.runs-node .nk{font-size:11px;color:var(--fg2);border:1px solid var(--line);border-radius:4px;padding:0 5px;white-space:nowrap}.runs-node .nn{font-weight:600;overflow-wrap:anywhere;min-width:0}.runs-node .nm{font-size:12px;color:var(--muted);margin-left:auto;white-space:nowrap}'
    + '.runs-path{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;font-size:12px}.runs-path .sep{color:var(--muted)}.runs-path b{font-weight:600;overflow-wrap:anywhere}'
    + '</style>';

  function leftPane(st, allRuns, activeId, statusOf) {
    return '<div class="leftpane"><div class="hstack"><div class="eyebrow grow">Recent runs</div>' + UI.iconbtn('refresh', 'Refresh', { cls: 'sm ghost', attrs: 'data-refresh' }) + '</div>' + UI.search('Filter runs', 'data-search', st.query).replace('class="search"', 'class="search" style="width:100%"')
      + '<div class="runs-list">' + allRuns.filter((r) => !st.query || (r.id + ' ' + r.agent + ' ' + r.status + ' ' + r.by).toLowerCase().includes(st.query.toLowerCase())).map((r) => UI.listItem('<span class="mono">' + esc(r.id) + '</span>', esc(r.agent) + ' · ' + esc(r.started) + ', ' + esc(r.by), { active: r.id === activeId, attrs: 'data-run="' + esc(r.id) + '"', right: statusPill(statusOf(r)) })).join('') + '</div>'
      + '<div class="muted" style="font-size:12px;margin-top:auto">Runs from agents, workflows and background jobs in Finance Ops. Cost and latency break down by worker class.</div></div>';
  }

  const nodeTitle = (n) => (n.kind === 'tool-call' || n.kind === 'skill-load' ? n.name : n.name + (n.ref ? ' ' + n.ref : ''));
  const pathHtml = (path) => '<span class="runs-path">' + path.map((n, i) => (i ? '<span class="sep" aria-hidden="true">›</span>' : '') + '<span><span class="muted">' + esc(KIND_TEXT[n.kind]) + '</span> <b>' + esc(n.name) + '</b></span>').join('') + '</span>';

  function heldNotice(h) {
    const x = h.node.held;
    return UI.notice('<b>Held down the chain, depth ' + h.node.depth + '.</b> <span class="mono">' + esc(x.tool) + '</span> (' + esc(x.side) + ') in ' + esc(h.node.name) + ', waiting since ' + esc(x.since) + ' on ' + esc(x.approvers) + '. The whole chain waits; decide it here, at the root.<div style="margin-top:6px">' + pathHtml(h.path) + '</div>', 'info', '<span class="hstack gap6">' + UI.btn('Reject', { size: 'sm', attrs: 'data-heldreject="' + esc(h.node.id) + '"' }) + UI.btn('Approve', { size: 'sm', kind: 'primary', attrs: 'data-heldapprove="' + esc(h.node.id) + '"' }) + '</span>');
  }

  /** Approve and reject a call held in the chain, from the root (POST /api/chains/:id/held/:node/decision). */
  function bindHeld(ctx, chain) {
    const st = ctx.state;
    const find = (id) => chain.held.find((h) => h.node.id === id);
    ctx.on('click', '[data-heldapprove]', async (e, t) => {
      const h = find(t.dataset.heldapprove); if (!h) return;
      const ok = await ctx.confirm({ title: 'Approve ' + esc(h.node.held.tool) + ' from the root', tag: h.node.held.side, tone: 'primary', ok: 'Approve', body: '<div class="fg2">The call runs in ' + esc(h.node.name) + ', where it waits, as Mara Okafor. Every run above it continues when it returns. Written to the audit chain as chain.held.decided and agent.call.approved.</div>' + pathHtml(h.path), kv: [['Chain', '<span class="mono">' + CHAIN_ID + '</span>'], ['Depth', String(h.node.depth)], ['Arguments', '<span class="mono">{"body": "September close is done: variance 51,380.00 EUR."}</span>']] });
      if (!ok) return;
      st.chainDecided = 'approve'; ctx.rerender(); ctx.toast('Approved from the root. Clerk posted the notice and the chain resumed.', 'ok');
    });
    ctx.on('click', '[data-heldreject]', (e, t) => {
      const h = find(t.dataset.heldreject); if (!h) return;
      ctx.modal({ title: 'Reject ' + esc(h.node.held.tool), body: '<div class="fg2">Nothing is run. ' + esc(h.node.name) + ' is told who rejected it and why, and goes on.</div>' + pathHtml(h.path) + UI.field('Reason (given to the agent and the owner)', UI.textarea('Not before the controller signs off.', { rows: 2, attrs: 'data-note' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { App.closeOverlay(); st.chainDecided = 'reject'; ctx.rerender(); ctx.toast('Rejected from the root. Clerk heard why and the chain went on.', 'warn'); }); } });
    });
  }

  /** The chain tree (GET /api/chains/:id): the tree on the page, the selected node in the inspector. */
  function renderChain(root, ctx, chain, allRuns, statusOf) {
    const st = ctx.state;
    const sel = chain.flat.find((n) => n.id === st.node) || chain.root;
    const rootRun = allRuns.find((r) => r.id === chain.root.ref);
    const row = (n) => '<li><button type="button" class="runs-node' + (n.id === sel.id ? ' selected' : '') + (n.held ? ' held' : '') + '" data-node="' + n.id + '" aria-current="' + (n.id === sel.id ? 'true' : 'false') + '"><span class="nk">' + esc(KIND_TEXT[n.kind]) + '</span><span class="nn">' + esc(nodeTitle(n)) + '</span>' + UI.pill(n.held ? 'held' : n.state, n.held ? 'info' : NODE_STATE[n.state] || '') + (n.errorType ? UI.pill(n.errorType, 'danger') : '') + '<span class="nm">' + (n.subtree.tokens ? fmt(n.subtree.tokens) + ' tok · ' : '') + esc(n.dur) + '</span></button>'
      + (n.children.length ? '<ul class="runs-tree">' + n.children.map(row).join('') + '</ul>' : '') + '</li>';
    const b = chain.budgets; const u = chain.used;
    const secsOf = (ms) => (ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s');
    const page = '<div class="page runs-page">'
      + UI.pagehead('Chain ' + CHAIN_ID.slice(-8), 'Started by ' + esc(chain.principal) + ' from run <a href="#" data-run="' + esc(chain.root.ref) + '" class="mono">' + esc(chain.root.ref) + '</a> · ' + UI.pill(chain.state === 'done' ? 'done' : 'running', chain.state === 'done' ? 'ok' : 'info') + ' · ' + UI.label(chain.label, { sm: true }) + ' high-water mark', UI.btn('Back to run ' + esc(chain.root.ref), { attrs: 'data-backrun' }) + UI.btn('Audit entries', { kind: 'ghost', attrs: 'data-chainaudit' }))
      + chain.held.map((h) => heldNotice(h)).join('')
      + (st.chainFail ? UI.notice('<b>Clerk stopped at its budget.</b> Its caller, Close broker, received <span class="mono">child_budget: Clerk 1.0.0 stopped at its budget: 4 of 4 tool calls</span> as a tool error and answered without the post. Replay Clerk from a step to try again as a new chain.', 'danger') : '')
      + '<div class="stats">' + UI.stat(String(chain.totals.nodes), 'Nodes', 'depth ' + chain.maxDepth + ' of ' + chain.limit) + UI.stat(fmt(u.tokens), 'Tokens', 'of ' + fmt(b.tokens) + ' for the chain') + UI.stat(String(u.steps), 'Steps', 'of ' + b.steps) + UI.stat(secsOf(u.wallMs), 'Wall time', 'of ' + secsOf(b.wallMs)) + UI.stat(secsOf(u.gpuMs), 'GPU time', 'the cost meter') + '</div>'
      + UI.panel('Invocations', '<ul class="runs-tree" aria-label="Chain tree">' + row(chain.root) + '</ul>', { actions: '<span class="muted" style="font-size:12px">Siblings in the order they began</span>' })
      + '<div class="muted" style="font-size:12px">The tree\'s token total, ' + fmt(chain.totals.tokens) + ', equals what the chain metered (' + fmt(u.tokens) + '): every charge goes to its node and to the root in the same increment. The principal never changes and the label only rises along the chain.</div>'
      + '</div>';
    const g = sel.guardrails;
    const runLink = sel.kind === 'agent-run' ? '<a href="#" data-run="' + esc(sel.ref) + '" class="mono">' + esc(sel.ref) + '</a>' : sel.kind === 'workflow-run' ? '<a href="#" data-gowfrun="' + esc(sel.ref) + '" class="mono">' + esc(sel.ref) + '</a>' : '<span class="muted">none, part of its parent run</span>';
    const replayOpts = sel.replay ? (sel.replay.fromStep ? sel.replay.fromStep.map((n) => ({ value: String(n), label: 'Step ' + n })) : sel.replay.fromNode.map((n) => ({ value: n, label: n }))) : [];
    const inspector = '<aside class="inspector w360"><div class="hstack"><div class="eyebrow grow">' + esc(KIND_TEXT[sel.kind]) + ', depth ' + sel.depth + '</div>' + UI.pill(sel.held ? 'held' : sel.state, sel.held ? 'info' : NODE_STATE[sel.state] || '') + '</div>'
      + '<div class="mono" style="font-size:14px;overflow-wrap:anywhere">' + esc(nodeTitle(sel)) + '</div>'
      + (sel.error ? UI.notice('<b>' + esc(sel.errorType || 'failed') + '.</b> ' + esc(sel.error), 'danger') : '')
      + UI.kv([['Run', runLink], ['Label', UI.label(sel.label, { sm: true })], ['Guardrail decision', esc(sel.decision || (g.length ? g.map((x) => x[0] + ' ' + x[1]).join(', ') : 'none here'))], ['Tokens', fmt(sel.usage.tokens) + ' here, ' + fmt(sel.subtree.tokens) + ' with what it called'], ['Steps', sel.usage.steps + ' here, ' + sel.subtree.steps + ' in the subtree'], ['Wall time', secsOf(sel.usage.wallMs)], ['GPU time', secsOf(sel.usage.gpuMs)], ['Thinking', sel.think ? esc(sel.think) + ' level, ' + fmt(sel.thinkingTokens) + ' tokens against the run budget' : 'none here'], ['Began', esc(sel.started)], ['Duration', esc(sel.dur)], ['Typed error', sel.errorType ? '<span class="mono">' + esc(sel.errorType) + '</span>' : 'none']], 1)
      + (sel.plan ? '<div class="eyebrow">Plan</div><div class="fg2" style="font-size:12px">Approved by ' + esc(sel.plan.approvedBy) + '; the run followed it as its step list.</div><ol style="margin:4px 0 0;padding-left:18px;font-size:13px">' + sel.plan.steps.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ol><div class="mono fg2" style="font-size:12px">' + esc(sel.plan.tools.join(', ')) + '</div>' : '')
      + (g.length ? '<div class="eyebrow">Guardrail decisions</div>' + UI.kv(g.map((x) => [esc(x[0]), UI.pill(x[1], x[1] === 'allow' ? 'ok' : 'danger') + ' <span class="muted">' + esc(x[2]) + '</span>']), 1) : '')
      + (sel.held ? '<div class="eyebrow">Held here</div>' + UI.kv([['Call', '<span class="mono">' + esc(sel.held.tool) + '</span> ' + UI.pill(sel.held.side, 'warn')], ['Waiting since', esc(sel.held.since)], ['Who decides', esc(sel.held.approvers)]], 1) + '<div class="hstack gap6">' + UI.btn('Reject', { attrs: 'data-heldreject="' + sel.id + '"' }) + UI.btn('Approve', { kind: 'primary', attrs: 'data-heldapprove="' + sel.id + '"' }) + '</div>' : '')
      + (sel.replay ? '<div class="eyebrow">Replay</div>' + UI.field(sel.replay.fromStep ? 'From step' : 'From workflow step', UI.select(replayOpts, replayOpts[0].value, 'data-replayfrom')) + '<div>' + UI.btn('Replay from this node', { icon: 'refresh', attrs: 'data-replaynode' }) + '</div><div class="muted" style="font-size:12px">Runs again as a new chain with the same principal and label; earlier steps are reused from the checkpoints.</div>' : '<div class="muted" style="font-size:12px">' + esc(KIND_TEXT[sel.kind]) + ' nodes do not replay on their own; replay the run above them.</div>')
      + (sel.ref ? '<div>' + UI.btn('Audit entries for ' + esc(sel.ref), { kind: 'ghost', size: 'sm', attrs: 'data-nodeaudit' }) + '</div>' : '')
      + '</aside>';
    root.innerHTML = STYLE + leftPane(st, allRuns, rootRun ? rootRun.id : '', statusOf) + page + inspector;

    ctx.on('click', '[data-node]', (e, t) => { st.node = t.dataset.node; ctx.rerender(); const b2 = ctx.$('[data-node="' + st.node + '"]'); if (b2) b2.focus(); });
    ctx.on('click', '[data-run]', (e, t) => { e.preventDefault(); st.chain = null; st.run = t.dataset.run; st.sel = null; ctx.rerender(); });
    ctx.on('click', '[data-backrun]', () => { st.chain = null; st.run = chain.root.ref; st.sel = null; ctx.rerender(); });
    ctx.on('click', '[data-gowfrun]', (e, t) => { e.preventDefault(); ctx.navigate('workflows', { wf: 'quarterly-variance', run: t.dataset.gowfrun }); });
    ctx.on('click', '[data-chainaudit], [data-nodeaudit]', () => ctx.navigate('usage-audit', { tab: 'audit' }));
    ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
    ctx.on('click', '[data-refresh]', () => ctx.toast('Chain refreshed.'));
    ctx.on('click', '[data-replaynode]', async () => {
      const from = ctx.$('[data-replayfrom]').value;
      const ok = await ctx.confirm({ title: 'Replay ' + esc(nodeTitle(sel)), tone: 'primary', ok: 'Replay', body: '<div class="fg2">The ' + esc(KIND_TEXT[sel.kind]) + ' runs again from ' + (sel.replay.fromStep ? 'step ' : '') + esc(from) + ' as the root of a new chain, as Mara Okafor at ' + esc(sel.label) + '. Approvals are asked for again. Audited chain.node.replayed.</div>', kv: [['Chain', '<span class="mono">' + CHAIN_ID + '</span>'], ['Node', esc(sel.id) + ', depth ' + sel.depth]] });
      if (!ok) return;
      ctx.toast('Replay queued as a new chain from ' + (sel.replay.fromStep ? 'step ' : '') + esc(from) + '.', 'ok');
    });
    bindHeld(ctx, chain);
  }

  App.register({
    id: 'runs', title: 'Runs', summary: 'Agent run timeline by worker class, step inspector, budget, replay',
    crumb: (st, params) => (st.chain || (params && params.chain) ? ['Runs', 'Chain ' + CHAIN_ID.slice(-8)] : ['Runs', (params && params.run) || st.run || '7f3a']),
    label: (st, params) => (RUNS.find((r) => r.id === ((params && params.run) || st.run || '7f3a')) || RUNS[0]).label,
    commands: [{ label: 'Replay a run from a step', sub: 'Runs', run(app) { app.stateFor('runs').openReplay = true; app.render(); } }, { label: 'Open the chain tree of run 8a12', sub: 'Runs', run(app) { const st = app.stateFor('runs'); st.chain = CHAIN_ID; st.node = 'n0'; app.render(); } }],
    states: [
      { title: 'Proposal denied', tone: 'danger', text: 'Cedar denied the tool call: the tool\'s egress ceiling is internal and the run is confidential. The thinking step receives the denial as data.', apply(ctx) { ctx.state.chain = null; ctx.state.run = '7f3a'; ctx.state.denied = true; ctx.state.sel = 2; ctx.rerender(); } },
      { title: 'Budget stop', tone: 'warn', text: 'The run stopped at 20 of 20 steps. The last checkpoint is kept and the owner can raise the limit and resume.', apply(ctx) { ctx.state.chain = null; ctx.state.run = '7c22'; ctx.state.sel = 7; ctx.state.resumed = false; ctx.rerender(); } },
      { title: 'Traceable figure', tone: 'ok', text: 'Selecting a number in the final answer highlights the calculating step that produced it.', apply(ctx) { ctx.state.chain = null; ctx.state.run = '7f3a'; ctx.state.showAnswer = true; ctx.state.sel = 3; ctx.rerender(); setTimeout(() => { const a = ctx.$('#runs-answer'); if (a) a.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 30); } },
      { title: 'Waiting on approval', tone: 'info', text: 'A doing step shows who must approve and how long it has waited.', apply(ctx) { ctx.state.run = '7d40'; ctx.state.sel = 6; ctx.state.decided = null; ctx.state.chain = null; ctx.rerender(); } },
      { title: 'Handed off', tone: 'info', text: 'Support triage handed the conversation to Billing agent with the context it chose. The specialist\'s answer is the run\'s answer, attributed to Billing agent, and the run ended with it.', apply(ctx) { ctx.state.chain = null; ctx.state.run = '7b10'; ctx.state.sel = 9; ctx.rerender(); } },
      { title: 'Chain tree', tone: 'neutral', text: 'A run that delegated opens its chain as a tree: every agent run, tool call, skill load and workflow run under the root, with timing, tokens, labels and guardrail decisions. The tree\'s token total equals what the chain metered.', apply(ctx) { const st = ctx.state; st.chain = CHAIN_ID; st.node = 'n0'; st.chainFail = false; st.chainDecided = null; ctx.rerender(); } },
      { title: 'Held three levels down', tone: 'info', text: 'A write call held in a delegate\'s delegate pauses the whole chain. It is approved from the root run, with the path from the root to the call shown.', apply(ctx) { const st = ctx.state; st.chain = CHAIN_ID; st.node = 'n6'; st.chainFail = false; st.chainDecided = null; ctx.rerender(); } },
      { title: 'Plan awaiting approval', tone: 'info', text: 'A plan-first run drafts its plan as its first step and waits. Nothing runs until the owner approves it as drafted or edited, or declines it.', apply(ctx) { const st = ctx.state; st.chain = null; st.run = '7e95'; st.sel = 11; st.planDecided = null; ctx.rerender(); } },
      { title: 'Call outside the plan', tone: 'warn', text: 'Under an approved plan the run follows the steps it names. A call the plan does not name pauses the run for a new approval; the approved steps still show which plan step they belong to.', apply(ctx) { const st = ctx.state; st.chain = null; st.run = '7e95'; st.planDecided = 'approve'; st.sel = 14; ctx.rerender(); } },
      { title: 'Plan declined', tone: 'neutral', text: 'A declined plan ends the run as cancelled: nothing ran, the chain records the draft and who declined it.', apply(ctx) { const st = ctx.state; st.chain = null; st.run = '7e95'; st.planDecided = 'decline'; st.sel = 11; ctx.rerender(); } },
      { title: 'Thinking per node', tone: 'neutral', text: 'Each agent run in the chain shows the thinking level it ran at and the thinking tokens it spent against the run budget; a run under an approved plan shows the plan.', apply(ctx) { const st = ctx.state; st.chain = CHAIN_ID; st.node = 'n2'; st.chainFail = false; st.chainDecided = null; ctx.rerender(); } },
      { title: 'Child failed with a typed error', tone: 'danger', text: 'Clerk stopped at its budget. Close broker received the failure as a tool error starting child_budget and answered without the post; the node records errorType budget.', apply(ctx) { const st = ctx.state; st.chain = CHAIN_ID; st.node = 'n5'; st.chainFail = true; st.chainDecided = null; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.run) { st.run = ctx.params.run; st.chain = null; delete ctx.params.run; }
      if (ctx.params.chain) { st.chain = CHAIN_ID; st.node = ctx.params.node || 'n0'; delete ctx.params.chain; delete ctx.params.node; }
      st.run = st.run || '7f3a'; st.query = st.query || ''; st.extra = st.extra || [];
      const allRuns = st.extra.concat(RUNS);
      const chain = chainTree(st);
      const nodeOf = (r) => (r.chain ? chain.flat.find((n) => n.id === r.chain) : null);
      const chainStatus = (r) => { const n = nodeOf(r); return !n ? r.status : n.state === 'waiting' ? 'waiting on approval' : n.state === 'failed' ? 'failed step' : n.state === 'succeeded' ? 'succeeded' : n.state; };
      if (st.chain) { renderChain(root, ctx, chain, allRuns, chainStatus); return; }
      const run = allRuns.find((r) => r.id === st.run) || RUNS[0];
      if (st.sel == null || !run.steps.includes(st.sel)) st.sel = run.id === '7f3a' ? 3 : run.steps[run.steps.length - 1];
      const denied = st.denied && run.id === '7f3a';
      const waiting = run.waiting && !st.decided;
      const budgetStop = run.budgetStop && !st.resumed;
      const status = run.chain ? chainStatus(run) : run.planFirst ? (st.planDecided === 'approve' ? 'waiting on approval' : st.planDecided === 'decline' ? 'cancelled' : run.status) : denied ? 'failed step' : run.waiting ? (st.decided === 'approve' ? 'succeeded' : st.decided === 'deny' ? 'failed step' : run.status) : run.budgetStop ? (st.resumed ? 'running' : run.status) : run.status;

      // Steps for this run, with state overrides.
      const step = (n) => {
        const s = Object.assign({}, run.map ? CHAIN_STEPS[run.map][n] : STEPS[n]);
        const cn = nodeOf(run);
        if (cn && s.waiting && cn.state !== 'waiting') {
          s.waiting = false;
          if (s.held) { s.failed = !!st.chainFail || st.chainDecided === 'reject'; s.meta = st.chainFail ? 'not reached' : st.chainDecided === 'reject' ? 'write, rejected' : 'write, 1.0 s'; s.body = st.chainFail ? 'not reached: the run stopped at its budget first' : st.chainDecided === 'reject' ? 'rejected at the root by Mara Okafor; nothing was posted' : 'posted to the Finance Ops feed as Mara Okafor, approved at the root'; }
          else if (st.chainFail && run.map === 'broker') { s.failed = true; s.meta = 'delegate, failed'; s.body = 'child_budget: Clerk 1.0.0 stopped at its budget: 4 of 4 tool calls'; }
          else { s.meta = 'delegate, done'; s.body = 'returned {run, agent, answer} from run ' + s.awaiting; }
        }
        if (denied && n === 2) { s.meta = 'denied by Cedar'; s.body = 'not run: tool egress ceiling internal, run label confidential'; s.failed = true; s.kv = [['Tool', '<span class="mono">ledger.query</span>'], ['Decision', UI.pill('denied', 'danger')], ['Policy', '<span class="mono">tenant-egress v4</span>, evaluated in 3 ms'], ['Reason', 'the tool\'s egress ceiling is internal and the run is confidential'], ['Returned to', 'step 5 as a Context-tier segment labelled <span class="mono">policy.denial</span>'], ['Label', UI.label('confidential', { sm: true })]]; }
        if (run.waiting && n === 6) {
          if (waiting) { s.meta = 'write, waiting 12 min'; s.body = 'waiting on approval: Mara Okafor (tool admin), requested 13:12:56'; s.failed = false; s.waiting = true; s.kv = [['Tool', '<span class="mono">jira-internal.create_issue</span>'], ['Side effect class', UI.pill('write', 'warn')], ['Must approve', 'Mara Okafor, tool admin for jira-internal'], ['Requested', '13:12:56, from the run, not from chat'], ['Waited', '12 min of a 60 min window'], ['If nobody approves', 'the step fails and step 7 reports it'], ['Label', UI.label('confidential', { sm: true })]]; }
          else if (st.decided === 'approve') { s.meta = 'write, 1.0 s'; s.body = 'created FIN-1188 in jira-internal as Mara Okafor'; s.failed = false; s.kv = [['Tool', '<span class="mono">jira-internal.create_issue</span>'], ['Side effect class', UI.pill('write', 'warn')], ['Approved by', 'Mara Okafor, 13:25:10'], ['Result', 'FIN-1188 created'], ['Label', UI.label('confidential', { sm: true })]]; }
          else { s.meta = 'write, denied'; s.body = 'denied by Mara Okafor; nothing was written'; s.failed = true; s.kv = [['Tool', '<span class="mono">jira-internal.create_issue</span>'], ['Decision', UI.pill('denied', 'danger')], ['Denied by', 'Mara Okafor, 13:25:10'], ['Returned to', 'the next thinking step as data']]; }
        }
        return s;
      };
      const steps = run.steps.map(step).filter((s) => !run.planFirst || st.planDecided === 'approve' || s.n === 11);
      if (run.planFirst && st.planDecided) { const pl = steps.find((s) => s.n === 11); pl.waiting = false; pl.failed = st.planDecided === 'decline'; pl.meta = st.planDecided === 'decline' ? 'draft, declined' : st.planEdited ? 'draft, approved as edited' : 'draft, approved'; pl.body = st.planDecided === 'decline' ? 'declined by Mara Okafor; nothing ran' : 'approved by Mara Okafor' + (st.planEdited ? ' with step 2 edited' : '') + '; the run follows it as its step list'; }
      const laneSum = Object.assign({}, run.sum);
      if (denied) laneSum.do = '1 call denied, 1 call 1.1 s';

      const card = (s) => '<div class="runs-card' + (s.failed ? ' failed' : '') + (s.waiting ? ' waiting' : '') + (st.sel === s.n ? ' selected' : '') + '" data-step="' + s.n + '" role="button" tabindex="0"><div class="runs-ch"><span style="font-size:13px;font-weight:600">' + esc(s.title) + '</span><span class="muted" style="font-size:12px">' + esc(s.meta) + '</span></div><div class="mono fg2" style="overflow-wrap:anywhere">' + esc(s.body) + '</div></div>';
      const rows = steps.map((s) => {
        let h = '<div class="runs-row"><div class="runs-n num">' + s.n + '</div>' + ['think', 'do', 'calc'].map((l) => '<div>' + (s.lane === l ? card(s) : '') + '</div>').join('') + '</div>';
        if (DIVIDERS[s.n]) h += '<div class="runs-div"><div></div><div class="runs-divline' + (denied ? ' danger' : '') + '"><span class="rule"></span><span>' + (denied ? 'Policy denied: tool egress ceiling internal, run is confidential. The denial goes back to the thinking step as data.' : esc(DIVIDERS[s.n])) + '</span><span class="rule"></span></div></div>';
        if (s.waiting) h += '<div class="runs-div"><div></div><div class="runs-divline info"><span class="rule"></span><span>' + (s.plan ? 'Waiting for the plan to be approved by the run\'s owner. Nothing runs until then; the draft expires with the run\'s wait limit.' : s.deviation ? 'Call outside the approved plan: jira-internal.create_issue is not in it. A new approval is needed before it runs; the plan can be extended to include it.' : s.awaiting ? 'Waiting on the child run ' + esc(s.awaiting) + '. This run holds its checkpoint and continues with the child\'s answer or its typed error.' : s.held ? 'Held for approval. The chain waits; the call is decided from the root run 8a12.' : 'Approval requested from Mara Okafor, 12 min ago. The run holds its checkpoint until a decision.') + '</span><span class="rule"></span></div></div>';
        return h;
      }).join('');

      const selStep = steps.find((s) => s.n === st.sel) || steps[0];
      const inspectorActions = selStep.lane === 'calc' ? UI.btn('Copy with provenance', { attrs: 'data-copyprov' })
        : selStep.awaiting && selStep.waiting ? '<div class="hstack gap6 wrap">' + UI.btn('Open the child run', { attrs: 'data-run="' + selStep.awaiting + '"' }) + UI.btn('Open the chain tree', { kind: 'ghost', attrs: 'data-openchain' }) + '</div>'
        : selStep.held && selStep.waiting ? UI.notice('Held for the chain rooted at run <span class="mono">8a12</span>. It is decided there, where the path from the root is shown.', 'info', UI.btn('Open the root run', { size: 'sm', attrs: 'data-run="8a12"' }))
        : selStep.plan && selStep.waiting ? '<div class="hstack gap6 wrap">' + UI.btn('Approve plan', { kind: 'primary', attrs: 'data-planapprove' }) + UI.btn('Edit', { attrs: 'data-planedit' }) + UI.btn('Decline', { attrs: 'data-plandecline' }) + '</div>'
        : selStep.deviation && selStep.waiting ? '<div class="hstack gap6 wrap">' + UI.btn('Approve this call', { kind: 'primary', attrs: 'data-devapprove' }) + UI.btn('Deny', { attrs: 'data-devdeny' }) + '</div>'
        : selStep.waiting ? '<div class="hstack gap6">' + UI.btn('Approve', { kind: 'primary', attrs: 'data-approve' }) + UI.btn('Deny', { attrs: 'data-deny' }) + '</div>'
        : selStep.failed ? UI.btn('Replay from this step', { icon: 'refresh', attrs: 'data-replay="' + selStep.n + '"' })
        : selStep.n === 5 ? UI.btn(st.showAnswer ? 'Hide final answer' : 'Show final answer', { attrs: 'data-toggleanswer' })
        : selStep.lane === 'think' ? UI.btn('Show thinking trace', { icon: 'brain', attrs: 'data-trace="' + selStep.n + '"' })
        : UI.btn('Show result segment', { attrs: 'data-segment="' + selStep.n + '"' });

      const answer = st.showAnswer && run.id === '7f3a' ? '<section class="panel" id="runs-answer"><div class="phead"><div class="eyebrow">Final answer, step 5</div><span class="muted" style="font-size:12px">Select a figure to see the calculating step that produced it</span></div><div class="serif" style="font-size:15px;line-height:1.6">Travel spend for Q3 came to <button type="button" class="runs-fig" data-fig="4">412,880 EUR</button> against a budget of 361,500 EUR, an overrun of <button type="button" class="runs-fig' + (st.sel === 3 ? ' on' : '') + '" data-fig="3">14.2%</button>. Two cost centres account for most of it: Field Sales at <button type="button" class="runs-fig' + (st.sel === 4 ? ' on' : '') + '" data-fig="4">38,420 EUR</button> over and the Lisbon onboarding programme at <button type="button" class="runs-fig' + (st.sel === 4 ? ' on' : '') + '" data-fig="4">36,310 EUR</button> over. The Jira issue was not created; the upstream returned an error.</div></section>' : '';

      const budgetNotice = budgetStop ? UI.notice('<b>Budget stop.</b> The run stopped at 20 of 20 steps. The last checkpoint is kept; raise the limit to resume from step 21.', 'warn', UI.btn('Raise limit and resume', { size: 'sm', attrs: 'data-raise' })) : st.resumed && run.budgetStop ? UI.notice('Step limit raised to 40 by Mara Okafor. The run resumed from the kept checkpoint at step 21.', 'ok') : '';
      const stepsUsed = run.budget.steps[0], stepsMax = st.resumed && run.budgetStop ? 40 : run.budget.steps[1];

      root.innerHTML = STYLE + '<style>'
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
        + leftPane(st, allRuns, run.id, (r) => (r.id === run.id ? status : chainStatus(r)))
        + '<div class="page runs-page">'
        + UI.pagehead('Run ' + run.id + ', ' + run.agent, 'Started ' + esc(run.started) + ' by ' + esc(run.by) + ', ' + esc(run.dur) + ' · ' + statusPill(status) + (run.handedTo ? ' · answered by <b>' + esc(run.handedTo.agent) + '</b>, handed off to run <a href="#" data-run="' + esc(run.handedTo.run) + '" class="mono">' + esc(run.handedTo.run) + '</a>' : '') + (run.caller ? ' · delegated by run <a href="#" data-run="' + esc(run.caller) + '" class="mono">' + esc(run.caller) + '</a>' : ' · from <a href="#" data-goconvo="' + esc(run.convo) + '">' + esc(run.convoTitle) + '</a>'), (run.chain ? UI.btn('Chain tree', { icon: 'branch', attrs: 'data-openchain' }) : '') + UI.btn('Open trace', { attrs: 'data-opentrace' }) + UI.btn('Replay from step', { attrs: 'data-replay="' + (steps.find((s) => s.failed) || { n: 1 }).n + '"' }))
        + (run.chain && !run.caller ? chain.held.map((h) => heldNotice(h)).join('') : '')
        + (run.chain && !run.caller && !chain.held.length && chain.state === 'done' ? UI.notice('The chain finished: ' + chain.totals.nodes + ' nodes, ' + fmt(chain.totals.tokens) + ' tokens metered to this root.', 'ok', UI.btn('Chain tree', { size: 'sm', attrs: 'data-openchain' })) : '')
        + budgetNotice
        + (run.handedTo ? UI.notice('<b>Handed off.</b> ' + esc(run.agent.replace(/ [\d.]+$/, '')) + ' handed the conversation to <b>' + esc(run.handedTo.agent) + '</b> with the context it chose; the answer is ' + esc(run.handedTo.agent) + '\'s and this run ended with it.', 'info', UI.btn('Open run ' + esc(run.handedTo.run), { size: 'sm', attrs: 'data-run="' + esc(run.handedTo.run) + '"' })) : '')
        + '<div class="runs-lanes"><div></div>' + ['think', 'do', 'calc'].map((l) => '<div class="runs-lane"><span class="ln">' + UI.icon(l === 'think' ? 'brain' : l === 'do' ? 'play' : 'calc', 12) + esc(LANES[l]) + '</span><span class="ls">' + esc(laneSum[l]) + '</span></div>').join('') + '</div>'
        + rows
        + (budgetStop ? '<div class="runs-row"><div class="runs-n">…</div><div class="muted" style="grid-column:2/-1;font-size:12px">Steps 8 to 20 collapsed. The run reached its step limit while looping on ledger.query pagination.</div></div>' : '')
        + answer
        + ''
        + '</div>'
        + '<aside class="inspector"><div class="hstack"><div class="eyebrow grow">Step ' + selStep.n + ', ' + esc(LANES[selStep.lane].toLowerCase()) + '</div>' + (selStep.failed ? UI.pill('failed', 'danger') : selStep.waiting ? UI.pill('waiting', 'info') : '') + '</div>'
        + UI.kv(selStep.kv, 1)
        + inspectorActions
        + '<div class="eyebrow">Budget</div>'
        + UI.meter('Steps', stepsUsed + ' of ' + stepsMax, (stepsUsed / stepsMax) * 100, stepsUsed >= stepsMax ? 'danger' : stepsUsed / stepsMax > 0.8 ? 'warn' : '')
        + UI.meter('Tokens', fmt(run.budget.tokens[0]) + ' of ' + fmt(run.budget.tokens[1]), (run.budget.tokens[0] / run.budget.tokens[1]) * 100, run.budget.tokens[0] / run.budget.tokens[1] > 0.9 ? 'warn' : '')
        + '<div class="muted" style="font-size:12px">Metered per class: tokens for thinking, calls and seconds for doing, CPU-seconds for calculating. Trace <span class="mono">' + TRACE.slice(0, 8) + '…</span></div>'
        + '</aside>';

      ctx.on('click', '[data-run]', (e, t) => { e.preventDefault(); st.run = t.dataset.run; st.sel = null; st.showAnswer = false; ctx.rerender(); });
      ctx.on('click', '[data-openchain]', () => { st.chain = CHAIN_ID; st.node = run.chain || 'n0'; ctx.rerender(); });
      ctx.on('click', '[data-gowfrun]', (e, t) => { e.preventDefault(); ctx.navigate('workflows', { wf: 'quarterly-variance', run: t.dataset.gowfrun }); });
      bindHeld(ctx, chain);
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
      ctx.on('click', '[data-planapprove]', async () => { const ok = await ctx.confirm({ title: 'Approve the plan', tone: 'primary', ok: 'Approve', body: '<div class="fg2">The run follows these three steps and calls only cards.query, ledger.query and calc.table. A call outside the plan pauses for a new approval; write tools keep their own cards. Audited as agent.plan.approved.</div>' }); if (!ok) return; st.planDecided = 'approve'; st.planEdited = false; st.sel = 12; ctx.rerender(); ctx.toast('Plan approved. The run follows it as its step list.', 'ok'); });
      ctx.on('click', '[data-planedit]', () => ctx.modal({ title: 'Edit the plan', body: '<div class="vstack gap8">' + UI.field('Step 1', UI.input('Pull last week\'s card transactions', { attrs: 'data-ps="1"' })) + UI.field('Step 2', UI.input('Join them to the ledger on amount and date within two days', { attrs: 'data-ps="2"' })) + UI.field('Step 3', UI.input('Report the lines without a match', { attrs: 'data-ps="3"' })) + '<div class="fg2" style="font-size:12px">Tools stay as drafted; a step can only name tools this run can call.</div></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Approve as edited', { kind: 'primary', attrs: 'data-planok' }), onMount(el) { el.querySelector('[data-planok]').addEventListener('click', () => { App.closeOverlay(); st.planDecided = 'approve'; st.planEdited = true; st.sel = 12; ctx.rerender(); ctx.toast('Plan approved as edited. The run follows it as its step list.', 'ok'); }); } }));
      ctx.on('click', '[data-plandecline]', async () => { const ok = await ctx.confirm({ title: 'Decline the plan', tone: 'danger', ok: 'Decline', body: '<div class="fg2">The run ends as cancelled. Nothing ran; the draft stays on the run and in the chain. Audited as agent.plan.declined.</div>' }); if (!ok) return; st.planDecided = 'decline'; ctx.rerender(); ctx.toast('Plan declined. The run ended; nothing ran.', 'warn'); });
      ctx.on('click', '[data-devapprove]', async () => { const ok = await ctx.confirm({ title: 'Approve jira-internal.create_issue outside the plan', tag: 'write', tone: 'primary', ok: 'Approve', body: '<div class="fg2">The plan is extended with this call and the run continues. Audited as agent.plan.approved with the deviation.</div>' }); if (!ok) return; ctx.toast('Call approved; the plan now includes it and the run continues.', 'ok'); });
      ctx.on('click', '[data-devdeny]', async () => { const ok = await ctx.confirm({ title: 'Deny the call outside the plan', tone: 'danger', ok: 'Deny', body: '<div class="fg2">Nothing is written. The run receives the denial as data and keeps to its plan.</div>' }); if (!ok) return; ctx.toast('Denied. The run keeps to its approved plan.'); });
      ctx.on('click', '[data-deny]', async () => { const ok = await ctx.confirm({ title: 'Deny this action', tone: 'danger', ok: 'Deny', body: '<div class="fg2">Nothing is written. The agent receives the denial as data and its next thinking step decides how to report it.</div>' }); if (!ok) return; st.decided = 'deny'; ctx.rerender(); ctx.toast('Denied. The run continues with the denial as data.'); });

      function openReplay(from) {
        ctx.modal({ title: 'Replay from step', body: UI.field('Start from', UI.select(steps.map((s) => ({ value: String(s.n), label: 'Step ' + s.n + ', ' + s.title + ' (' + LANES[s.lane].toLowerCase() + ')' })), String(from), 'data-from')) + UI.notice('Replay starts from the checkpoint before the chosen step. Earlier results are reused from the run record; later steps run again as a new run with the same label and budget.', 'info') + UI.kv([['Source run', '<span class="mono">' + esc(run.id) + '</span>'], ['New run', '<span class="mono">' + esc(run.id.slice(0, 3)) + 'b</span>'], ['Budget', stepsMax + ' steps, 10,000 tokens'], ['Label', UI.label(run.label, { sm: true })]], 2), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Replay', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', () => { const n = +m.querySelector('[data-from]').value; App.closeOverlay(); const nid = run.id.slice(0, 3) + 'b'; if (!st.extra.find((r) => r.id === nid)) st.extra.unshift(Object.assign({}, run, { id: nid, started: '14:31:02', by: 'Mara Okafor', dur: 'running, from step ' + n, status: 'running', waiting: false, budgetStop: false })); ctx.toast('Replay queued as run <span class="mono">' + nid + '</span> from step ' + n + '.', 'ok'); st.run = nid; st.sel = n; ctx.rerender(); });
        } });
      }
      if (st.openReplay) { st.openReplay = false; setTimeout(() => openReplay((steps.find((s) => s.failed) || { n: 1 }).n), 30); }
    }
  });
})();
