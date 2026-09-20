(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  const W = 176, H = 74; // node card size on the canvas
  const PALETTE = [['model', 'Model call', 'Thinking'], ['tool', 'Tool or MCP call', 'Doing'], ['agent', 'Agent run', 'Thinking'], ['script', 'Script', 'Doing'], ['media', 'Media', 'Doing'], ['query', 'Query', 'Doing'], ['calc', 'Calculate', 'Calculating'], ['branch', 'Branch', 'control'], ['map', 'Map', 'Thinking'], ['loop', 'Loop', 'control'], ['approval', 'Approval', 'control'], ['wait', 'Wait', 'control'], ['sub', 'Sub-workflow', 'Doing']];
  const BASE_NODES = [
    { id: 'n1', type: 'trigger', title: 'Trigger: file uploaded', sub: 'event upload.received, video/*', cls: 'control', x: 20, y: 24, out: '{ "file": MinIORef,\n  "mime": string }' },
    { id: 'n2', type: 'media', title: 'Sample frames', sub: 'preset frames-1fps', cls: 'Doing', x: 230, y: 24, inp: '{ "file": MinIORef }', out: '{ "frames": MinIORef[] }', preset: 'frames-1fps' },
    { id: 'n3', type: 'map', title: 'Caption frames', sub: 'map over frames, profile vision', cls: 'Thinking', x: 440, y: 24, inp: '{ "frames": MinIORef[] }', out: '{ "captions": string[] }', profile: 'vision' },
    { id: 'n4', type: 'media', title: 'Transcribe audio', sub: 'preset transcribe-srt', cls: 'Doing', x: 440, y: 152, inp: '{ "file": MinIORef }', out: '{ "transcript": string }', preset: 'transcribe-srt' },
    { id: 'n5', type: 'model', title: 'Summarise', sub: 'profile analyst, JSON schema', cls: 'Thinking', x: 230, y: 152, inp: '{ "captions": string[],\n  "transcript": string }', out: '{ "summary": string,\n  "topics": string[],\n  "actions": string[] }', profile: 'analyst', think: 'high' },
    { id: 'n6', type: 'calc', title: 'Word and cost totals', sub: 'calc.table', cls: 'Calculating', x: 230, y: 282, inp: '{ "summary": string,\n  "transcript": string }', out: '{ "words": integer,\n  "cost_eur": decimal }' },
    { id: 'n7', type: 'tool', title: 'Post to chat channel', sub: 'mail.send_internal', cls: 'Doing', x: 20, y: 282, danger: true, tool: 'mail.send_internal', inp: '{ "summary": string,\n  "words": integer }', out: '{ "message_id": string }' },
    { id: 'n8', type: 'approval', title: 'Approval', sub: 'role: knowledge curator', cls: 'control', x: 440, y: 282, role: 'knowledge curator', inp: '{ "summary": string,\n  "topics": string[] }', out: '{ "approved": boolean,\n  "by": string }' },
    { id: 'n9', type: 'tool', title: 'Add to knowledge base', sub: 'kb.add_document', cls: 'Doing', x: 440, y: 412, tool: 'kb.add_document', inp: '{ "summary": string,\n  "approved": boolean }', out: '{ "document_id": string }' },
    { id: 'n10', type: 'tool', title: 'Notify owner', sub: 'blocked by label ceiling', cls: 'Doing', x: 230, y: 412, danger: true, tool: 'jira-internal.create_issue', inp: '{ "message_id": string }', out: '{ "issue": string }' }
  ];
  const BASE_EDGES = [
    { from: 'n1', to: 'n2', label: 'video' }, { from: 'n2', to: 'n3', label: 'frames[]' }, { from: 'n3', to: 'n4', label: 'captions[]' }, { from: 'n4', to: 'n5' }, { from: 'n5', to: 'n6', label: 'Summary' },
    { from: 'n6', to: 'n7' }, { from: 'n6', to: 'n8' }, { from: 'n8', to: 'n9' }, { from: 'n7', to: 'n10', label: 'blocked: ceiling internal', tone: 'danger', dashed: true }
  ];
  const ORDER = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10'];
  const RUNS = [
    { id: 'wf.21c4', trigger: 'town-hall-sept.mp4 uploaded', started: '19 Sep 09:14', duration: '6 m 12 s', label: 'internal', state: 'waiting on approval', approver: 'knowledge curator', since: '19 Sep 09:20', done: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'] },
    { id: 'wf.21b9', trigger: 'manual, M. Okafor', started: '18 Sep 16:40', duration: '4 m 51 s', label: 'internal', state: 'succeeded', done: ORDER },
    { id: 'wf.21a2', trigger: 'site-walk.mov uploaded', started: '18 Sep 11:02', duration: '1 m 03 s', label: 'internal', state: 'resumed after restart', done: ['n1', 'n2', 'n3', 'n4'], checkpoint: 'n4' }
  ];
  const WORKFLOWS = [{ id: 'video-to-notes', label: 'video-to-notes v3 draft' }, { id: 'video-to-notes-v2', label: 'video-to-notes v2 published' }, { id: 'quarterly-variance', label: 'quarterly-variance v1 published' }, { id: 'contract-redline', label: 'contract-redline v2 published' }];
  const clsPill = (c) => c === 'control' ? UI.pill('control', '') : UI.pill(c, 'outline');
  const statusPill = (s) => !s ? '' : UI.pill(s, s === 'passed' ? 'ok' : s === 'running' ? 'info' : s === 'waiting on approval' ? 'info' : s === 'blocked' || s === 'failed' ? 'danger' : s === 'skipped' ? 'outline' : '');
  const runPill = (s) => UI.pill(s, s === 'succeeded' ? 'ok' : s === 'waiting on approval' || s === 'running' ? 'info' : s === 'resumed after restart' ? 'warn' : s === 'failed' || s === 'rejected' ? 'danger' : '');

  let bound = false; const cur = {};

  App.register({
    id: 'workflows', title: 'Workflows', summary: 'Graph editor, typed ports, versions, triggers, run history, replay, approvals',
    crumb(st) { return ['Workflows', 'Video to notes', 'v3 ' + (st.published ? 'published' : 'draft')]; }, label: 'internal',
    commands: [{ label: 'Dry run video-to-notes v3', sub: 'Workflows', run(app) { app.stateFor('workflows').autoRun = true; app.render(); } }],
    states: [
      { title: 'Cycle rejected', tone: 'danger', text: 'Publishing fails because Summarise feeds back into Caption frames. The offending edge is highlighted.', apply(ctx) { const st = ctx.state; st.cycle = true; st.problem = 'cycle'; st.sel = 'n5'; st.run = null; ctx.rerender(); } },
      { title: 'Schema mismatch', tone: 'danger', text: 'The edge turns red where an output port does not match the next input port, with both schemas shown.', apply(ctx) { const st = ctx.state; st.mismatch = true; st.sel = 'n5'; st.run = null; ctx.rerender(); } },
      { title: 'Paused on approval', tone: 'info', text: 'The run shows who must approve, since when, and the data they will see.', apply(ctx) { const st = ctx.state; st.run = 'wf.21c4'; st.sel = 'n8'; st.status = {}; RUNS[0].done.forEach((n) => { st.status[n] = 'passed'; }); st.status.n8 = 'waiting on approval'; st.status.n10 = 'blocked'; ctx.rerender(); } },
      { title: 'Keyboard operation', tone: 'neutral', text: 'Arrow keys move between nodes, Enter opens the inspector, C starts a connection from the selected port.', apply(ctx) { ctx.state.kbd = true; ctx.rerender(); const c = ctx.$('.wf-canvas'); if (c) c.focus(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.run) { st.run = ctx.params.run; delete ctx.params.run; }
      if (ctx.params.step) { st.sel = ctx.params.step; delete ctx.params.step; }
      st.sel = st.sel || 'n5'; st.status = st.status || {}; st.added = st.added || []; st.addedEdges = st.addedEdges || []; st.runs = st.runs || []; st.edits = st.edits || {}; st.wf = st.wf || 'video-to-notes'; st.removed = st.removed || [];
      cur.ctx = ctx; cur.st = st;
      const nodes = BASE_NODES.concat(st.added).filter((n) => st.removed.indexOf(n.id) < 0).map((n) => Object.assign({}, n, st.edits[n.id] || {}));
      const byId = (id) => nodes.find((n) => n.id === id);
      let edges = BASE_EDGES.concat(st.addedEdges).filter((e) => byId(e.from) && byId(e.to));
      if (st.cycle) edges = edges.concat([{ from: 'n5', to: 'n3', label: 'cycle', tone: 'danger', cycle: true }]);
      if (st.mismatch) edges = edges.map((e) => e.from === 'n4' && e.to === 'n5' ? Object.assign({}, e, { tone: 'danger', label: 'schema mismatch', mismatch: true }) : e);
      const sel = byId(st.sel) || nodes[0];
      const runs = RUNS.concat(st.runs);
      const run = st.run ? runs.find((r) => r.id === st.run) : null;
      const canvasH = Math.max(560, nodes.reduce((m, n) => Math.max(m, n.y + H + 40), 0));
      const running = !!st.running;

      // ---- edges (SVG) ----
      const path = (e) => {
        const a = byId(e.from), b = byId(e.to);
        if (e.cycle) return 'M' + (a.x + W / 2 + 30) + ' ' + a.y + ' V' + (b.y + H + 26) + ' H' + (b.x + W / 2) + ' V' + (b.y + H + 2);
        if (b.x > a.x + W - 1 && Math.abs(b.y - a.y) < 2) return 'M' + (a.x + W) + ' ' + (a.y + H / 2) + ' H' + b.x;
        if (b.x + W < a.x + 1 && Math.abs(b.y - a.y) < 2) return 'M' + a.x + ' ' + (a.y + H / 2) + ' H' + (b.x + W);
        if (Math.abs(b.x - a.x) < 2) return 'M' + (a.x + W / 2) + ' ' + (b.y > a.y ? a.y + H : a.y) + ' V' + (b.y > a.y ? b.y : b.y + H);
        return 'M' + (a.x + W / 2) + ' ' + (b.y > a.y ? a.y + H : a.y) + ' V' + (b.y + H / 2) + ' H' + (b.x > a.x ? b.x : b.x + W);
      };
      const labelPos = (e) => { const a = byId(e.from), b = byId(e.to); if (e.cycle) return [a.x + W / 2 + 34, a.y - 6]; if (Math.abs(b.y - a.y) < 2) return [(b.x > a.x ? a.x : b.x) + W + 4, a.y + H / 2 - 8]; if (Math.abs(b.x - a.x) < 2) return [a.x + W / 2 + 6, (b.y > a.y ? a.y + H : b.y + H) + 30]; return [a.x + W / 2 + 8, b.y + H / 2 - 8]; };
      const svg = '<svg width="700" height="' + canvasH + '" viewBox="0 0 700 ' + canvasH + '" aria-hidden="true" style="position:absolute;left:0;top:0"><defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="var(--meter)"></path></marker><marker id="wf-arrow-d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="var(--danger-fg)"></path></marker></defs>'
        + edges.map((e) => '<path d="' + path(e) + '" fill="none" stroke="' + (e.tone === 'danger' ? 'var(--danger-fg)' : 'var(--meter)') + '" stroke-width="' + (e.tone === 'danger' ? 2 : 1.5) + '"' + (e.dashed ? ' stroke-dasharray="4 4"' : '') + ' marker-end="url(#' + (e.tone === 'danger' ? 'wf-arrow-d' : 'wf-arrow') + ')"></path>').join('')
        + edges.filter((e) => e.label).map((e) => { const p = labelPos(e); return '<text x="' + p[0] + '" y="' + p[1] + '" font-size="10" fill="' + (e.tone === 'danger' ? 'var(--danger-fg)' : 'var(--muted)') + '" font-family="inherit">' + esc(e.label) + '</text>'; }).join('') + '</svg>';
      const nodeHtml = nodes.map((n) => '<button type="button" class="wf-node' + (n.id === sel.id ? ' sel' : '') + (n.danger ? ' danger' : '') + (st.connectFrom === n.id ? ' connecting' : '') + '" data-node="' + n.id + '" style="left:' + n.x + 'px;top:' + n.y + 'px"><span class="wf-port in"></span><span class="wf-port out"></span><div class="t">' + esc(n.title) + '</div><div class="s">' + esc(n.sub) + '</div><div class="hstack gap4">' + clsPill(n.cls) + statusPill(st.status[n.id]) + '</div></button>').join('');

      // ---- inspector ----
      const limits = '<div class="eyebrow">Workflow limits</div>' + UI.meter('Steps', nodes.length + ' of 40', nodes.length / 40 * 100) + UI.meter('Fan-out', 'up to 200 frames', 60) + UI.meter('Tokens', '48k of 200k', 24) + UI.meter('Timeout', '6 m of 2 h', 5);
      let insp;
      if (run) {
        const waiting = run.state === 'waiting on approval';
        insp = '<div class="hstack"><div class="eyebrow grow">Run: ' + esc(run.id) + '</div>' + UI.iconbtn('x', 'Back to step', { cls: 'sm ghost', attrs: 'data-closerun' }) + '</div>'
          + '<div class="hstack gap6">' + runPill(run.state) + UI.label(run.label, { sm: true }) + '</div>'
          + UI.kv([['Trigger', esc(run.trigger)], ['Started', esc(run.started)], ['Duration', esc(run.duration)], ['Runs as', run.trigger.startsWith('manual') ? 'delegated token, Mara Okafor' : 'workflow service account'], ['Engine', 'Temporal, workflow ' + esc(run.id) + ', 3 checkpoints']], 1)
          + (waiting ? UI.panel('Waiting on approval', UI.kv([['Who must approve', 'any <b>' + esc(run.approver) + '</b> in Finance Ops (3 people)'], ['Waiting since', esc(run.since) + ' <span class="muted">23 h</span>'], ['Times out', '20 Sep 09:20, then the run fails'], ['Data they will see', UI.ctx('summary, topics', '{ "summary": "Town hall covered Q3 travel overrun, hiring freeze, Lisbon onboarding…", "topics": ["travel", "hiring", "onboarding"] }', 'internal')]], 1) + '<div class="hstack">' + UI.btn('Reject', { size: 'sm', attrs: 'data-runreject' }) + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-runapprove' }) + '</div>', { cls: 'tint' }) : '')
          + (run.state === 'resumed after restart' ? UI.notice('The worker restarted at 11:03. Temporal replayed history to checkpoint <b>Transcribe audio</b> and continued with no step run twice.', 'warn') : '')
          + '<div class="eyebrow">Steps</div>' + UI.timeline(nodes.filter((n) => n.id !== 'n10' || run.done.indexOf('n7') >= 0).map((n) => ({ title: esc(n.title), text: run.done.indexOf(n.id) >= 0 ? (n.cls === 'Thinking' ? '1,204 tokens, 9 s' : n.cls === 'Calculating' ? 'exact, 12 ms' : n.cls === 'control' ? 'passed' : 'sandbox, 2.1 s') : n.id === 'n8' && waiting ? 'waiting on ' + esc(run.approver) : n.id === 'n10' ? 'blocked: ceiling internal' : 'not started', meta: run.done.indexOf(n.id) >= 0 ? 'checkpoint ' + n.id : '', tone: run.done.indexOf(n.id) >= 0 ? 'ok' : n.id === 'n8' && waiting ? 'accent' : n.id === 'n10' ? 'danger' : '' })))
          + '<div class="vstack gap6" style="margin-top:auto">' + UI.field('Replay from checkpoint', UI.select(run.done.map((id) => ({ value: id, label: byId(id) ? byId(id).title : id })), run.checkpoint || run.done[run.done.length - 1], 'data-replaystep')) + '<div class="hstack wrap">' + UI.btn('Replay step', { size: 'sm', icon: 'refresh', attrs: 'data-replay' }) + UI.btn('Open in Runs', { size: 'sm', kind: 'ghost', attrs: 'data-goruns' }) + '</div></div>';
      } else {
        const n = sel; const status = st.status[n.id];
        let fields = '';
        if (n.type === 'trigger') fields = UI.field('Trigger', UI.select(['event upload.received', 'event document.indexed', 'event flag.raised', 'cron schedule', 'manual from chat or console', 'API', 'internal webhook'], 'event upload.received', 'data-edit="sub"')) + UI.field('Filter', UI.input('mime: video/*'), 'Only matching events start a run');
        else if (n.type === 'model') fields = UI.field('Profile', UI.select(['analyst', 'chat-default', 'fast', 'coder'], n.profile || 'analyst', 'data-edit="profile"'), '<a href="#" data-goprofile="' + esc(n.profile || 'analyst') + '">Open profile</a>') + UI.field('Think level', UI.select(['off', 'low', 'medium', 'high'], n.think || 'high', 'data-edit="think"')) + UI.field('Prompt template', UI.input('prompts/meeting-summary@v2'));
        else if (n.type === 'map') fields = UI.field('Over', UI.input('$.steps.frames.output', { readonly: true })) + UI.field('Step profile', UI.select(['vision', 'analyst', 'fast'], n.profile || 'vision', 'data-edit="profile"')) + UI.field('Max parallel', UI.input('20', { type: 'number' }), 'Fan-out cap 200 items per run');
        else if (n.type === 'media') fields = UI.field('Preset', UI.select(['frames-1fps', 'frames-0.2fps', 'extract-audio', 'transcribe-srt', 'thumbnail'], n.preset || 'frames-1fps', 'data-edit="preset"')) + UI.field('Worker', UI.input('media pool, FFmpeg 7', { readonly: true }));
        else if (n.type === 'calc') fields = UI.field('Tool', UI.select(['calc.table', 'calc.evaluate', 'calc.stats', 'calc.units', 'calc.dates'], 'calc.table', 'data-edit="sub"')) + UI.field('Expression', UI.textarea('SELECT count_words(transcript) AS words,\n       words * 0.0004 AS cost_eur', { rows: 2 })) + '<div class="muted" style="font-size:12px">Exact, deterministic; the result records inputs, method and precision.</div>';
        else if (n.type === 'tool') fields = UI.field('Tool', UI.select(['mail.send_internal', 'kb.add_document', 'jira-internal.create_issue', 'ledger.query', 'kb.delete_documents'], n.tool || 'kb.add_document', 'data-edit="tool"'), '<a href="#" data-goreg>Open in Registry</a>') + UI.field('Arguments', UI.textarea(n.tool === 'kb.add_document' ? '{ kb: "team-notes", body: $.steps.notes.summary }' : n.tool === 'mail.send_internal' ? '{ to: "finance-ops@northwind.local", body: $.steps.summary }' : '{ project: "FIN", summary: $.steps.summary }', { rows: 2 })) + UI.kv([['Side effect', UI.pill(n.tool === 'kb.delete_documents' ? 'destructive' : 'write', n.tool === 'kb.delete_documents' ? 'danger' : 'warn')], ['Confirmation', 'always, by the run owner']], 2) + (n.id === 'n10' ? UI.notice('<b>Blocked by label ceiling.</b> jira-internal.create_issue has ceiling <b>internal</b>; the incoming data is labelled internal too, but the Post to chat channel output was raised to <b>confidential</b> by the Finance KB reference. Lower the input or pick a tool with a higher ceiling.', 'danger', '<a href="#" data-goguard>Rules</a>') : '');
        else if (n.type === 'approval') fields = UI.field('Role', UI.select(['knowledge curator', 'workspace-editor', 'finance approver', 'tool admin'], n.role || 'knowledge curator', 'data-edit="role"')) + UI.field('Timeout', UI.input('24 h'), 'The run fails if nobody decides in time') + (status === 'waiting on approval' ? UI.panel('Waiting on approval', UI.kv([['Who must approve', 'any <b>' + esc(n.role || 'knowledge curator') + '</b> in Finance Ops'], ['Waiting since', 'just now'], ['Data they will see', UI.ctx('summary, topics', '{ "summary": "…", "topics": ["travel", "hiring"] }', 'internal')]], 1) + '<div class="hstack">' + UI.btn('Reject', { size: 'sm', attrs: 'data-runreject' }) + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-runapprove' }) + '</div>', { cls: 'tint' }) : '');
        else if (n.type === 'agent') fields = UI.field('Agent', UI.select(['Data analyst', 'Meeting notes', 'Support triage'], 'Meeting notes')) + UI.field('Limits', UI.input('20 steps, 10,000 tokens, 120 s', { readonly: true }));
        else if (n.type === 'script') fields = UI.field('Script', UI.select(['clean_card_feed.py', 'monthly_variance.py', 'parse_gateway_logs.mjs'], 'clean_card_feed.py'), '<a href="#" data-goscripts>Open in Scripts</a>') + UI.field('Runtime', UI.input('Python 3.13, no network', { readonly: true }));
        else if (n.type === 'query') fields = UI.field('Connection', UI.select(['ledger (Postgres, read-only)', 'search index'], 'ledger (Postgres, read-only)')) + UI.field('Query', UI.textarea('SELECT cost_centre, sum(amount) FROM ledger WHERE period = $1 GROUP BY 1', { rows: 2 }));
        else if (n.type === 'branch' || n.type === 'loop') fields = UI.field('Condition', UI.input(n.type === 'branch' ? '$.steps.approve.approved == true' : '$.iteration < 5')) + (n.type === 'loop' ? UI.field('Max iterations', UI.input('5', { type: 'number' })) : '');
        else if (n.type === 'wait') fields = UI.field('Wait for', UI.select(['timer', 'internal event'], 'timer')) + UI.field('Duration', UI.input('30 m'));
        else if (n.type === 'sub') fields = UI.field('Workflow', UI.select(['quarterly-variance v1', 'contract-redline v2'], 'quarterly-variance v1'));
        const mismatchBlock = st.mismatch && n.id === 'n5' ? UI.notice('<b>Schema mismatch.</b> Transcribe audio outputs <span class="mono">{ transcript: string }</span> but this input port expects <span class="mono">captions: string[]</span> as well. Connect Caption frames or make captions optional.', 'danger', UI.btn('Fix', { size: 'sm', attrs: 'data-fixmismatch' })) : '';
        insp = '<div class="hstack"><div class="eyebrow grow">Step: ' + esc(n.title) + '</div>' + UI.iconbtn('trash', 'Remove step', { cls: 'sm ghost', attrs: 'data-remove' }) + '</div>'
          + '<div class="hstack gap6">' + clsPill(n.cls) + statusPill(status) + (n.cls !== 'control' ? '<span class="muted" style="font-size:12px">' + (n.cls === 'Thinking' ? 'task queue think' : n.cls === 'Calculating' ? 'task queue calc' : 'task queue do') + '</span>' : '') + '</div>'
          + mismatchBlock + fields
          + (n.inp ? '<div class="eyebrow">Input port</div><pre class="codebox" style="' + (st.mismatch && n.id === 'n5' ? 'border-color:var(--danger-fg)' : '') + '">' + esc(n.inp) + '</pre>' : '')
          + (st.mismatch && n.id === 'n5' ? '<div class="eyebrow">Incoming from Transcribe audio</div><pre class="codebox" style="border-color:var(--danger-fg)">' + esc(byId('n4').out) + '</pre>' : '')
          + (n.out ? '<div class="eyebrow">Output schema</div><pre class="codebox">' + esc(n.out) + '</pre>' : '')
          + UI.kv([['Label in', UI.label(n.id === 'n10' ? 'confidential' : 'internal', { sm: true })], ['Runs as', n.type === 'trigger' ? 'not applicable' : 'workflow service account'], ['Retry', n.cls === 'Thinking' ? '2, then fallback chain' : n.cls === 'Calculating' ? 'freely, deterministic' : n.type === 'tool' ? 'only with an idempotency key' : 'none']], 1)
          + '<div class="hstack wrap">' + UI.btn(st.connectFrom === n.id ? 'Pick a target' : 'Connect from here', { size: 'sm', icon: 'link', attrs: 'data-connect', cls: st.connectFrom === n.id ? 'active' : '' }) + UI.btn('Replay step', { size: 'sm', kind: 'ghost', icon: 'refresh', attrs: 'data-replaystepbtn' }) + '</div>'
          + limits;
      }

      const problem = st.problem === 'cycle' ? UI.problem('Cycle rejected', 'Publishing failed: Summarise feeds back into Caption frames. Workflows must be acyclic; use a Loop step with a bound instead. The offending edge is highlighted on the canvas.', 'b1c2d3e4f5a6978877665544332211aa') : st.problem === 'mismatch' ? UI.problem('Schema mismatch', 'Publishing failed: the output port of Transcribe audio does not match the input port of Summarise. Both schemas are shown in the inspector.', 'c4d5e6f7a8b9101112131415161718ab') : '';
      const pendingApprovals = runs.filter((r) => r.state === 'waiting on approval').length;

      root.innerHTML = '<style>'
        + '.wf-page > *{flex-shrink:0}.wf-insp > *{flex-shrink:0}'
        + '.wf-palette{display:flex;flex-direction:column;gap:2px}.wf-palette button{display:flex;align-items:center;justify-content:space-between;gap:6px;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:5px;background:var(--panel);font-size:12px;color:var(--fg);cursor:pointer;text-align:left;font-family:inherit}.wf-palette button:hover{border-color:var(--muted)}.wf-palette button i{width:6px;height:6px;border-radius:50%;background:var(--meter);flex-shrink:0}.wf-palette button i.think{background:var(--info-fg)}.wf-palette button i.do{background:var(--warn-fg)}.wf-palette button i.calc{background:var(--ok-fg)}'
        + '.wf-scroll{overflow:auto;border:1px solid var(--line);border-radius:6px;background:var(--panel2);background-image:radial-gradient(var(--line2) 1px, transparent 1px);background-size:16px 16px}'
        + '.wf-canvas{position:relative;width:700px;outline:none}.wf-canvas:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}'
        + '.wf-node{position:absolute;width:' + W + 'px;height:' + H + 'px;display:flex;flex-direction:column;gap:3px;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:6px;box-shadow:0 1px 2px rgba(0,0,0,.05);text-align:left;cursor:pointer;font-family:inherit;color:var(--fg);overflow:hidden}'
        + '.wf-node .t{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wf-node .s{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wf-node .pill{height:18px;font-size:11px}'
        + '.wf-node:hover{border-color:var(--muted)}.wf-node.sel{border:2px solid var(--accent);padding:7px 9px}.wf-node.danger{border-color:var(--danger-fg)}.wf-node.connecting{box-shadow:0 0 0 3px var(--accent-tint)}'
        + '.wf-port{position:absolute;top:50%;width:7px;height:7px;border-radius:50%;background:var(--panel);border:1px solid var(--muted);transform:translateY(-50%)}.wf-port.in{left:-4px}.wf-port.out{right:-4px}'
        + '.wf-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}'
        + '</style>'
        + '<div class="leftpane w170"><div class="eyebrow">Steps</div><div class="wf-palette">' + PALETTE.map((p) => '<button type="button" data-add="' + p[0] + '" title="Add ' + esc(p[1]) + ' (' + p[2] + ')"><span>' + esc(p[1]) + '</span><i class="' + (p[2] === 'Thinking' ? 'think' : p[2] === 'Doing' ? 'do' : p[2] === 'Calculating' ? 'calc' : '') + '"></i></button>').join('') + '</div><div class="muted" style="font-size:11px;margin-top:auto">Click a step to add it to the canvas. Dot: thinking, doing or calculating worker class.</div></div>'
        + '<div class="page wf-page">'
        + '<div class="wf-toolbar">' + UI.select(WORKFLOWS.map((w) => ({ value: w.id, label: w.label })), st.wf, 'data-wf style="width:auto"') + UI.pill(st.published ? 'published' : 'draft', st.published ? 'ok' : '') + '<span class="muted" style="font-size:12px">trigger: upload.received, video/* · engine Temporal · limits 40 steps, 200k tokens, 2 h</span>' + (pendingApprovals ? '<a href="#" class="right" data-pending style="font-size:12px">' + pendingApprovals + ' run' + (pendingApprovals > 1 ? 's' : '') + ' waiting on approval</a>' : '') + UI.btn('Versions', { size: 'sm', kind: 'ghost', attrs: 'data-versions' }) + '</div>'
        + (st.kbd ? UI.notice('<b>Keyboard operation.</b> Arrow keys move between nodes, Enter opens the inspector, C starts a connection from the selected port, Delete removes the step, Escape cancels.', 'info', UI.btn('Dismiss', { size: 'sm', attrs: 'data-dismisskbd' })) : '')
        + (st.connectFrom ? UI.notice('Connecting from <b>' + esc((byId(st.connectFrom) || {}).title) + '</b>. Click a target step, or press Escape.', 'accent', UI.btn('Cancel', { size: 'sm', attrs: 'data-cancelconnect' })) : '')
        + problem
        + '<div class="wf-scroll"><div class="wf-canvas" tabindex="0" aria-label="Workflow canvas" style="height:' + canvasH + 'px">' + svg + nodeHtml + '<div style="position:absolute;right:12px;top:12px;display:flex;gap:6px">' + UI.btn(running ? 'Running' : 'Dry run', { size: 'sm', icon: 'play', attrs: 'data-dryrun', disabled: running }) + '</div></div></div>'
        + '<div class="wf-toolbar">' + UI.btn('Dry run', { size: 'sm', icon: 'play', attrs: 'data-dryrun', disabled: running }) + UI.btn('Publish as tool', { size: 'sm', attrs: 'data-pubtool' }) + UI.btn(st.published ? 'Published' : 'Publish', { size: 'sm', kind: 'primary', attrs: 'data-publish', disabled: st.published }) + (Object.keys(st.status).length ? UI.btn('Clear run', { size: 'sm', kind: 'ghost', attrs: 'data-clearrun' }) : '') + '<span class="muted right" style="font-size:12px">' + nodes.length + ' steps, ' + edges.length + ' edges</span></div>'
        + UI.panel('Run history', UI.table(['Run', 'Trigger', 'Started', 'Duration', 'Label', 'State'], runs.map((r) => ({ cells: ['<span class="mono">' + esc(r.id) + '</span>', esc(r.trigger), esc(r.started), esc(r.duration), UI.label(r.label, { sm: true }), runPill(r.state)], attrs: 'data-run="' + esc(r.id) + '"', selected: run && run.id === r.id })), { cls: 'bare', minWidth: '0' }), { actions: UI.btn('Open in Runs', { size: 'sm', kind: 'ghost', attrs: 'data-goruns' }), cls: 'pad0' }).replace('class="panel pad0"', 'class="panel" style="padding:14px"')
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
        + '<aside class="inspector w300 wf-insp">' + insp + '</aside>';

      if (st.autoRun) { st.autoRun = false; setTimeout(() => dryRun(ctx), 50); }
      if (bound) return; bound = true;

      const on = ctx.on;
      const nodesNow = () => { const s = cur.st; return BASE_NODES.concat(s.added).filter((n) => s.removed.indexOf(n.id) < 0).map((n) => Object.assign({}, n, s.edits[n.id] || {})); };
      on('click', '[data-node]', (e, t) => {
        const st = cur.st; const id = t.dataset.node;
        if (st.connectFrom && st.connectFrom !== id) { const from = st.connectFrom; st.connectFrom = null; const creates = BASE_EDGES.concat(st.addedEdges).some((x) => x.from === id && x.to === from); st.addedEdges.push({ from, to: id, label: 'result', tone: creates ? 'danger' : '' }); if (creates) { st.problem = 'cycle'; cur.ctx.toast('That edge creates a cycle. Publishing is blocked until it is removed.', 'danger'); } else cur.ctx.toast('Connected. The output schema is checked against the target input port.'); cur.ctx.rerender(); return; }
        st.sel = id; st.run = null; cur.ctx.rerender();
      });
      on('click', '[data-add]', (e, t) => {
        const st = cur.st; const p = PALETTE.find((x) => x[0] === t.dataset.add); const ns = nodesNow();
        const slots = []; [24, 152, 282, 412, 542, 672].forEach((y) => [20, 230, 440].forEach((x) => slots.push([x, y])));
        const free = slots.find((s) => !ns.some((n) => Math.abs(n.x - s[0]) < 10 && Math.abs(n.y - s[1]) < 10)) || [20, 24 + 130 * Math.ceil(ns.length / 3)];
        const id = 'n' + (Date.now() % 100000);
        const sub = p[0] === 'model' ? 'profile chat-default, JSON schema' : p[0] === 'tool' ? 'kb.add_document' : p[0] === 'agent' ? 'Meeting notes agent' : p[0] === 'script' ? 'clean_card_feed.py, Python 3.13' : p[0] === 'media' ? 'preset extract-audio' : p[0] === 'query' ? 'ledger, read-only' : p[0] === 'calc' ? 'calc.evaluate' : p[0] === 'approval' ? 'role: workspace-editor' : p[0] === 'wait' ? 'timer 30 m' : p[0] === 'sub' ? 'quarterly-variance v1' : p[0] === 'map' ? 'map over list' : p[0] === 'loop' ? 'bounded, 5 iterations' : 'condition';
        st.added.push({ id, type: p[0], title: p[1], sub, cls: p[2], x: free[0], y: free[1], inp: '{ "input": any }', out: '{ "result": any }', tool: 'kb.add_document', profile: 'chat-default', think: 'medium', preset: 'extract-audio', role: 'workspace-editor' });
        st.sel = id; st.run = null; st.published = false; cur.ctx.rerender(); cur.ctx.toast(esc(p[1]) + ' added as a ' + (p[2] === 'control' ? 'control' : p[2].toLowerCase()) + ' step. Connect it from another step\'s output port.');
      });
      on('click', '[data-remove]', async () => { const st = cur.st; const n = nodesNow().find((x) => x.id === st.sel); if (!n) return; const ok = await cur.ctx.confirm({ title: 'Remove step ' + esc(n.title), tag: 'edit', tone: 'warn', body: '<p class="fg2" style="margin:0">Edges into and out of the step are removed. Published versions are unchanged until you publish again.</p>', ok: 'Remove' }); if (ok) { st.removed.push(n.id); st.addedEdges = st.addedEdges.filter((e) => e.from !== n.id && e.to !== n.id); st.sel = 'n1'; st.published = false; cur.ctx.rerender(); cur.ctx.toast(esc(n.title) + ' removed.'); } });
      on('change', '[data-edit]', (e, t) => { const st = cur.st; const k = t.dataset.edit; st.edits[st.sel] = st.edits[st.sel] || {}; st.edits[st.sel][k] = t.value; const n = nodesNow().find((x) => x.id === st.sel); if (n) { if (k === 'profile' && n.type === 'model') st.edits[st.sel].sub = 'profile ' + t.value + ', JSON schema'; if (k === 'profile' && n.type === 'map') st.edits[st.sel].sub = 'map over frames, profile ' + t.value; if (k === 'preset') st.edits[st.sel].sub = 'preset ' + t.value; if (k === 'tool') { st.edits[st.sel].sub = t.value; st.edits[st.sel].danger = false; } if (k === 'role') st.edits[st.sel].sub = 'role: ' + t.value; if (k === 'sub') st.edits[st.sel].sub = t.value; } st.published = false; cur.ctx.rerender(); cur.ctx.toast('Draft updated. Publish to make the change live.'); });
      on('click', '[data-connect]', () => { const st = cur.st; st.connectFrom = st.connectFrom === st.sel ? null : st.sel; cur.ctx.rerender(); });
      on('click', '[data-cancelconnect]', () => { cur.st.connectFrom = null; cur.ctx.rerender(); });
      on('click', '[data-dismisskbd]', () => { cur.st.kbd = false; cur.ctx.rerender(); });
      on('click', '[data-fixmismatch]', () => { cur.st.mismatch = false; if (cur.st.problem === 'mismatch') cur.st.problem = null; cur.ctx.rerender(); cur.ctx.toast('Caption frames reconnected. Ports match.', 'ok'); });
      on('click', '[data-run]', (e, t) => { const st = cur.st; st.run = t.dataset.run; const r = RUNS.concat(st.runs).find((x) => x.id === st.run); st.status = {}; r.done.forEach((n) => { st.status[n] = 'passed'; }); if (r.state === 'waiting on approval') { st.status.n8 = 'waiting on approval'; st.status.n10 = 'blocked'; } if (r.state === 'succeeded') st.status.n10 = 'skipped'; if (r.checkpoint) st.status.n5 = 'running'; cur.ctx.rerender(); });
      on('click', '[data-closerun]', () => { cur.st.run = null; cur.ctx.rerender(); });
      on('click', '[data-clearrun]', () => { cur.st.status = {}; cur.st.run = null; cur.ctx.rerender(); });
      on('click', '[data-pending]', (e) => { e.preventDefault(); cur.ctx.app.applyState(2); });
      on('click', '[data-goruns]', () => cur.ctx.navigate('runs'));
      on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); cur.ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      on('click', '[data-goreg]', (e) => { e.preventDefault(); const n = nodesNow().find((x) => x.id === cur.st.sel); cur.ctx.navigate('registry', { entry: (n && n.tool) || 'kb.search' }); });
      on('click', '[data-goguard]', (e) => { e.preventDefault(); cur.ctx.navigate('guardrails'); });
      on('click', '[data-goscripts]', (e) => { e.preventDefault(); cur.ctx.navigate('scripts'); });
      on('change', '[data-wf]', (e, t) => { if (t.value === 'video-to-notes') { cur.st.wf = t.value; cur.ctx.rerender(); return; } cur.ctx.toast('Only video-to-notes v3 is built in this prototype. Other workflows open the same editor.'); t.value = 'video-to-notes'; });
      on('click', '[data-versions]', () => cur.ctx.modal({ title: 'Versions of video-to-notes', body: UI.table(['Version', 'State', 'Changed', 'By', ''], [['v3', UI.pill(cur.st.published ? 'published' : 'draft', cur.st.published ? 'ok' : ''), 'today', 'Mara Okafor', ''], ['v2', UI.pill('published', 'ok'), '11 Sep', 'Mara Okafor', UI.btn('Diff against v3', { size: 'sm', attrs: 'data-close data-diffv' })], ['v1', UI.pill('deprecated', 'warn'), '28 Aug', 'J. Lindqvist', '']], { clickable: false, minWidth: '0' }) + UI.notice('Runs pin the version they started on. Publishing v3 does not change runs in progress.', 'info'), actions: UI.btn('Close', { attrs: 'data-close' }), onMount(m) { m.querySelector('[data-diffv]').addEventListener('click', () => cur.ctx.toast('v3 adds Word and cost totals (calc.table) and Post to chat channel; Approval role changed from workspace-editor to knowledge curator.', '', 6000)); } }));
      on('click', '[data-dryrun]', () => dryRun(cur.ctx));
      on('click', '[data-runapprove]', async () => { const ctx = cur.ctx; const st = cur.st; const ok = await ctx.confirm({ title: 'Approve step: Add to knowledge base', tag: 'approval', tone: 'info', body: '<p class="fg2" style="margin:0">Your decision is written to the audit chain and the run continues with kb.add_document on the workflow service account.</p>', kv: [['Role', 'knowledge curator'], ['Data', 'summary, topics (internal)']], ok: 'Approve' }); if (!ok) return; st.status.n8 = 'passed'; st.status.n9 = 'running'; const r = RUNS.concat(st.runs).find((x) => x.id === st.run); ctx.rerender(); setTimeout(() => { st.status.n9 = 'passed'; if (r) { r.state = 'succeeded'; r.done = r.done.concat(['n8', 'n9']); } ctx.rerender(); ctx.toast('Approved. Add to knowledge base ran; the run succeeded.', 'ok'); }, 900); });
      on('click', '[data-runreject]', async () => { const ctx = cur.ctx; const st = cur.st; const ok = await ctx.confirm({ title: 'Reject approval', tag: 'reject', tone: 'danger', body: UI.field('Reason', UI.textarea('', { placeholder: 'Sent to the run owner', rows: 2 })), ok: 'Reject' }); if (!ok) return; st.status.n8 = 'failed'; st.status.n9 = 'skipped'; const r = RUNS.concat(st.runs).find((x) => x.id === st.run); if (r) r.state = 'rejected'; ctx.rerender(); ctx.toast('Rejected. The run ended without publishing; owner notified.', 'warn'); });
      on('click', '[data-replay]', async () => { const ctx = cur.ctx; const st = cur.st; const sel = ctx.$('[data-replaystep]'); const step = sel ? sel.value : 'n4'; const n = nodesNow().find((x) => x.id === step); const ok = await ctx.confirm({ title: 'Replay from ' + esc(n ? n.title : step), tag: 'replay', tone: 'info', body: '<p class="fg2" style="margin:0">Temporal restores the checkpoint before this step and re-runs it and everything after with the same inputs. Tool calls with side effects ask for confirmation again.</p>', kv: [['Run', st.run], ['Checkpoint', step], ['Inputs', 'retained per label, internal']], ok: 'Replay' }); if (!ok) return; ORDER.slice(ORDER.indexOf(step)).forEach((id) => { delete st.status[id]; }); st.status[step] = 'running'; ctx.rerender(); ctx.toast('Replaying from ' + esc(n ? n.title : step) + '. Follow it in Runs.', 'ok'); setTimeout(() => { st.status[step] = 'passed'; ctx.rerender(); }, 1200); });
      on('click', '[data-replaystepbtn]', () => { const st = cur.st; st.status[st.sel] = 'running'; cur.ctx.rerender(); setTimeout(() => { st.status[st.sel] = 'passed'; cur.ctx.rerender(); cur.ctx.toast('Step replayed with the last run\'s inputs. Output matches the checkpoint.', 'ok'); }, 1000); });
      on('click', '[data-publish]', async () => {
        const ctx = cur.ctx; const st = cur.st;
        if (st.cycle || st.addedEdges.some((e) => e.tone === 'danger')) { st.problem = 'cycle'; ctx.rerender(); ctx.toast('Publish refused: the graph contains a cycle.', 'danger'); return; }
        if (st.mismatch) { st.problem = 'mismatch'; ctx.rerender(); ctx.toast('Publish refused: a port schema does not match.', 'danger'); return; }
        const ok = await ctx.confirm({ title: 'Publish video-to-notes v3', tag: 'publish', tone: 'info', body: '<p class="fg2" style="margin:0">Publishing checks the graph is acyclic, every port matches, labels propagate within ceilings, and limits are set. Notify owner is blocked by its ceiling and will fail at run time unless fixed.</p>', kv: [['Steps', String(nodesNow().length)], ['Trigger', 'upload.received, video/*'], ['Max label', 'internal'], ['Warnings', '1: Notify owner ceiling']], ok: 'Publish v3' });
        if (ok) { st.published = true; st.problem = null; ctx.rerender(); ctx.toast('video-to-notes v3 published. New uploads start on v3; runs in progress stay on v2.', 'ok', 5000); }
      });
      on('click', '[data-pubtool]', () => { const ctx = cur.ctx; ctx.modal({ title: 'Publish as tool', body: '<p class="fg2" style="margin:0">A published workflow becomes a registry tool, so agents and other workflows can call it. It goes through the normal tool review.</p><div class="formgrid">' + UI.field('Tool name', UI.input('workflow.video_to_notes')) + UI.field('Side-effect class', UI.select(['read-only', 'write', 'destructive', 'external-comms'], 'write')) + UI.field('Max label', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal')) + UI.field('Confirmation', UI.select(['always', 'never'], 'always')) + '</div>' + UI.code('{ "input": { "file": "MinIORef" },\n  "output": { "summary": "string", "document_id": "string" } }', 'json'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Submit to Registry', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('workflow.video_to_notes 0.1.0 submitted as a draft tool. <a href="#/registry?tab=review" style="color:inherit">Open the review queue</a>', 'ok', 6000); }); } }); });
      on('keydown', '.wf-canvas', (e) => {
        const st = cur.st; const ns = nodesNow(); const s = ns.find((x) => x.id === st.sel) || ns[0]; if (!s) return;
        const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
        if (dir) { e.preventDefault(); let best = null, bd = 1e9; ns.forEach((n) => { if (n.id === s.id) return; const dx = n.x - s.x, dy = n.y - s.y; const along = dx * dir[0] + dy * dir[1]; if (along <= 0) return; const off = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]); const d = along + off * 2; if (d < bd) { bd = d; best = n; } }); if (best) { if (st.connectFrom && st.connectFrom !== best.id && e.shiftKey) { st.addedEdges.push({ from: st.connectFrom, to: best.id, label: 'result' }); st.connectFrom = null; } st.sel = best.id; st.run = null; cur.ctx.rerender(); const c = cur.ctx.$('.wf-canvas'); if (c) c.focus(); } return; }
        if (e.key === 'Enter') { e.preventDefault(); const f = cur.ctx.$('.inspector select, .inspector input'); if (f) f.focus(); return; }
        if (e.key === 'c' || e.key === 'C') { e.preventDefault(); st.connectFrom = st.connectFrom ? null : s.id; cur.ctx.rerender(); const c = cur.ctx.$('.wf-canvas'); if (c) c.focus(); return; }
        if (e.key === 'Escape') { st.connectFrom = null; cur.ctx.rerender(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); const b = cur.ctx.$('[data-remove]'); if (b) b.click(); }
      });
      on('click', '.state-card', (e, t) => cur.ctx.app.applyState(+t.dataset.state));
    }
  });

  function dryRun(ctx) {
    const st = ctx.state; if (st.running) return;
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n10', 'n8', 'n9'].filter((id) => st.removed.indexOf(id) < 0).concat(st.added.map((n) => n.id));
    st.status = {}; st.run = null; st.running = true;
    const id = 'wf.21c' + (7 + st.runs.length);
    const rec = { id, trigger: 'dry run, M. Okafor', started: 'just now', duration: '0 s', label: 'internal', state: 'running', done: [], mocked: true };
    st.runs.unshift(rec); st.sel = ids[0];
    ctx.rerender(); ctx.toast('Dry run started with mocked tools. Steps report on the canvas.');
    let i = 0; const t0 = Date.now();
    const fmt = () => { const s = Math.round((Date.now() - t0) / 1000); return Math.floor(s / 60) + ' m ' + String(s % 60).padStart(2, '0') + ' s'; };
    const tick = () => {
      if (i > 0) { const prev = ids[i - 1]; if (st.status[prev] === 'running') { st.status[prev] = prev === 'n10' ? 'blocked' : 'passed'; if (prev !== 'n10') rec.done.push(prev); } }
      rec.duration = fmt();
      if (i >= ids.length) { st.running = false; rec.state = rec.done.indexOf('n8') >= 0 ? 'succeeded' : 'waiting on approval'; ctx.rerender(); ctx.toast(rec.state === 'succeeded' ? 'Dry run succeeded.' : 'Dry run finished the branch; waiting on approval.', 'ok'); return; }
      const id = ids[i];
      if (id === 'n8') { st.status.n8 = 'waiting on approval'; st.sel = 'n8'; rec.state = 'waiting on approval'; st.running = false; st.run = rec.id; i++; ctx.rerender(); ctx.toast('Approval step reached. Approve or reject in the inspector.', '', 5000); return; }
      if (id === 'n9' && st.status.n8 !== 'passed') { st.status.n9 = 'skipped'; i++; ctx.rerender(); st.timer = setTimeout(tick, 350); return; }
      st.status[id] = 'running'; st.sel = id; i++; ctx.rerender();
      st.timer = setTimeout(tick, id === 'n3' || id === 'n5' ? 900 : 520);
    };
    st.timer = setTimeout(tick, 300);
  }
})();
