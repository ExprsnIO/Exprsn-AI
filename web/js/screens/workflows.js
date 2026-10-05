(function () {
  // Workflows, backed by /api/workflows, /api/workflow-runs and /api/workflow-approvals. The canvas edits the draft
  // graph locally; every change is validated by the server (acyclic, port schemas along edges, label ceilings, limits)
  // and the problems point at the step. Save writes the draft (with the revision it was loaded at), Publish makes it
  // the next version. Runs execute on the server as checkpointed jobs; their steps arrive over the socket
  // (workflow.run, workflow.step) and paint the canvas of the version the run is pinned to.
  const { UI, esc } = App;

  const W = 176, H = 74; // node card size on the canvas
  const enc = encodeURIComponent;
  const S = () => App.stateFor('workflows');
  const visible = () => App.state.route === 'workflows';
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const ROLES = ['workflow-admin', 'knowledge-curator', 'tenant-admin', 'guardrail-admin', 'tool-admin', 'model-admin', 'flag-reviewer', 'connection-admin', 'ml-admin', 'identity-admin', 'auditor', 'member', 'system-admin'];
  const CHECKPOINTS = ['context', 'user-input', 'model-output', 'tool-call', 'memory', 'script', 'db-query', 'media', 'image', 'export', 'context-transfer'];
  const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'truthy', 'exists'];
  const ACTIVE = { queued: 1, running: 1, waiting: 1 };
  // kind, palette label, worker class (the dot)
  const PALETTE = [['model', 'Model call', 'Thinking'], ['transform', 'Transform', 'Doing'], ['http', 'HTTP call', 'Doing'], ['calc', 'Calculate', 'Calculating'], ['branch', 'Branch', 'control'], ['guardrail', 'Guardrail check', 'control'], ['approval', 'Approval', 'control'], ['wait', 'Wait', 'control'], ['tool', 'Tool or MCP call', 'Doing']];
  const CLS = { trigger: 'control', model: 'Thinking', transform: 'Doing', http: 'Doing', calc: 'Calculating', branch: 'control', guardrail: 'control', approval: 'control', wait: 'control', tool: 'Doing' };
  const clsPill = (c) => (c === 'control' ? UI.pill('control', '') : UI.pill(c, 'outline'));
  const statusPill = (s) => (!s ? '' : UI.pill(s, s === 'passed' ? 'ok' : s === 'running' || s === 'waiting on approval' || s === 'waiting' ? 'info' : s === 'blocked' || s === 'failed' ? 'danger' : s === 'skipped' ? 'outline' : ''));
  const runPill = (s) => UI.pill(s, s === 'succeeded' ? 'ok' : s === 'waiting on approval' || s === 'running' || s === 'waiting' || s === 'queued' ? 'info' : s === 'failed' || s === 'rejected' ? 'danger' : s === 'cancelled' ? 'outline' : '');
  const shortId = (id) => 'wf.' + String(id || '').slice(-4).toLowerCase();
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const dur = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000)); return s < 60 ? s + ' s' : Math.floor(s / 60) + ' m ' + String(s % 60).padStart(2, '0') + ' s'; };
  const hours = (ms) => (ms % 3600000 === 0 ? ms / 3600000 + ' h' : Math.round(ms / 60000) + ' min');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const json = (v) => JSON.stringify(v, null, 2);

  /** `{ "summary": string, "topics": string[] }`: a port schema the way the board prints it. */
  function fmtSchema(s) {
    if (!s) return 'any';
    if (s.type === 'array') return fmtSchema(s.items || { type: 'any' }) + '[]';
    if (s.type !== 'object') return s.type;
    const props = Object.keys(s.properties || {});
    if (!props.length) return '{ }';
    const req = s.required || [];
    const parts = props.map((k) => '"' + k + '"' + (req.indexOf(k) >= 0 ? '' : '?') + ': ' + fmtSchema(s.properties[k]));
    return parts.length > 2 ? '{ ' + parts.join(',\n  ') + ' }' : '{ ' + parts.join(', ') + ' }';
  }
  /** A value that matches a port schema, to prefill the run input. */
  function sample(s, name) {
    if (!s) return null;
    if (s.type === 'string') return name || '';
    if (s.type === 'number' || s.type === 'integer') return 0;
    if (s.type === 'boolean') return false;
    if (s.type === 'array') return [];
    if (s.type === 'object') { const o = {}; Object.keys(s.properties || {}).forEach((k) => { o[k] = sample(s.properties[k], k); }); return o; }
    return null;
  }
  const lines = (obj) => Object.keys(obj || {}).map((k) => k + ': ' + obj[k]).join('\n');
  const unlines = (text) => { const o = {}; String(text).split('\n').forEach((l) => { const i = l.indexOf(':'); if (i > 0) { const k = l.slice(0, i).trim(); if (k) o[k] = l.slice(i + 1).trim(); } }); return o; };
  function subOf(n) {
    const c = n.config || {};
    switch (n.kind) {
      case 'trigger': return c.source === 'api' ? 'API or console' : 'manual from the console';
      case 'model': return 'profile ' + (c.profile || 'not set') + (c.format === 'json' ? ', JSON schema' : ', text');
      case 'transform': return 'fields ' + Object.keys(c.fields || {}).join(', ');
      case 'branch': return c.left + ' ' + c.op + (c.right != null && c.op !== 'truthy' && c.op !== 'exists' ? ' ' + c.right : '');
      case 'guardrail': return 'checkpoint ' + (c.checkpoint || 'context');
      case 'approval': return 'role: ' + (c.role || 'not set');
      case 'http': return (c.method || 'GET') + ' ' + String(c.url || '').replace(/^https?:\/\//, '');
      case 'calc': return 'calc ' + (c.expression || '');
      case 'wait': return 'timer ' + dur(c.ms || 0);
      case 'tool': return (c.tool || 'no tool') + (c.args && typeof c.args === 'object' ? ', ' + Object.keys(c.args).length + ' arguments' : '');
      default: return '';
    }
  }
  function defaults(kind, st) {
    const profile = (st.profiles && st.profiles[0] && st.profiles[0].name) || '';
    return {
      model: { profile, prompt: 'Summarise this in three sentences: {{input}}', format: 'text' },
      transform: { fields: { text: '{{input}}' } },
      http: { method: 'GET', url: 'http://service.internal/', headers: {} },
      calc: { expression: '1 + 1' },
      branch: { left: '{{input}}', op: 'truthy' },
      guardrail: { checkpoint: 'context', text: '{{input}}', approverRole: 'workflow-admin' },
      approval: { role: 'workflow-admin', timeoutMs: 24 * 3600000, show: '' },
      wait: { ms: 60000 },
      tool: { tool: (st.tools && st.tools[0] && st.tools[0].name) || '', approverRole: 'workflow-admin' }
    }[kind] || {};
  }

  // ---------- data ----------
  function loadList() {
    const st = S();
    return Promise.all([App.get('/api/workflows'), App.get('/api/workflow-approvals'), App.can('chat:read') ? App.get('/api/chat/profiles').catch(() => []) : Promise.resolve([]), App.get('/api/workflow-tools').catch(() => [])])
      .then(([list, approvals, profiles, tools]) => { Object.assign(st, { list, approvals, profiles, tools, loaded: true, loadError: null }); });
  }
  function loadWorkflow(id, keepDraft) {
    const st = S();
    st.wfLoading = id;
    return Promise.all([App.get('/api/workflows/' + enc(id)), App.get('/api/workflows/' + enc(id) + '/runs?limit=50')])
      .then(([wf, runs]) => {
        if (st.wfId !== id) return;
        st.wf = wf; st.runs = runs; st.wfError = null;
        if (!keepDraft || !st.draft) { st.draft = clone(wf.draft); st.unsaved = false; st.validation = wf.validation; st.parseError = null; }
        if (!st.draft.nodes.some((n) => n.id === st.sel)) st.sel = st.draft.nodes[0] ? st.draft.nodes[0].id : null;
      })
      .catch((err) => { st.wfError = err; })
      .finally(() => { st.wfLoading = null; schedule(); });
  }
  function loadRuns() {
    const st = S(); if (!st.wfId) return;
    App.get('/api/workflows/' + enc(st.wfId) + '/runs?limit=50').then((runs) => { st.runs = runs; schedule(); }).catch(() => undefined);
    App.get('/api/workflow-approvals').then((a) => { st.approvals = a; schedule(); }).catch(() => undefined);
  }
  function loadRun(id) {
    const st = S();
    return App.get('/api/workflow-runs/' + enc(id)).then((r) => { if (st.runId === id) { st.run = r; st.runError = null; } schedule(); }).catch((err) => { if (st.runId === id) st.runError = err; schedule(); });
  }
  /** Validates the local draft on the server, at most every 400 ms. */
  function validateSoon() {
    const st = S();
    clearTimeout(st.vTimer);
    st.vTimer = setTimeout(() => {
      if (!st.wfId || !st.draft) return;
      const id = st.wfId; const graph = st.draft;
      App.post('/api/workflows/' + enc(id) + '/validate', { graph }).then((v) => { if (st.wfId === id && st.draft === graph) { st.validation = v; st.parseError = null; schedule(); } })
        .catch((err) => { if (st.wfId === id) { st.parseError = err.problem ? (err.problem.detail || err.message) : err.message; schedule(); } });
    }, 400);
  }

  // ---------- live updates ----------
  const live = { sock: null, handlers: null, timer: null, runTimer: null };
  function detach() {
    if (live.sock && live.handlers) Object.keys(live.handlers).forEach((ev) => live.sock.off(ev, live.handlers[ev]));
    live.sock = null; live.handlers = null;
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  }
  /** Someone is typing in the inspector: a re-render would take the field away from them. */
  const typing = () => { const a = document.activeElement; return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.closest('#main')); };
  /** Re-renders at most every 300 ms, never while a dialog is open, a field has focus or a step is being dragged. */
  function schedule() {
    if (live.timer) return;
    live.timer = setTimeout(() => {
      live.timer = null;
      if (!visible()) return;
      if (document.getElementById('overlay') || S().dragging || typing()) { schedule(); return; }
      App.render();
    }, 300);
  }
  /** The run view carries outputs and approvals the events leave out: refetch it (throttled) after changes. */
  function refreshRunSoon() {
    if (live.runTimer) return;
    live.runTimer = setTimeout(() => { live.runTimer = null; const st = S(); if (st.runId) loadRun(st.runId); }, 500);
  }
  function attach() {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    const guard = (fn) => (d) => { if (!visible()) { detach(); return; } fn(S(), d || {}); };
    live.handlers = {
      'workflow.run': guard((st, d) => {
        if (d.workflowId !== st.wfId) return;
        const r = (st.runs || []).find((x) => x.id === d.runId);
        if (r) { r.state = d.state; r.error = d.error; } else loadRuns();
        if (!ACTIVE[d.state]) loadRuns();
        if (st.run && st.run.id === d.runId) { st.run.state = d.state; st.run.error = d.error; refreshRunSoon(); }
        schedule();
      }),
      // Sprint 19: approvers hear about approvals on runs they may decide, wherever they are on this screen.
      'workflow.approval': guard((st) => {
        App.get('/api/workflow-approvals').then((a) => { st.approvals = a; schedule(); }).catch(() => undefined);
        if (st.runId) refreshRunSoon();
      }),
      'workflow.step': guard((st, d) => {
        if (d.workflowId !== st.wfId) return;
        const r = (st.runs || []).find((x) => x.id === d.runId);
        if (r) { r.steps = r.steps || {}; r.steps[d.nodeId] = d.state; }
        if (st.run && st.run.id === d.runId) {
          const s = st.run.steps.find((x) => x.nodeId === d.nodeId);
          const upd = { nodeId: d.nodeId, state: d.state, error: d.error, label: d.label, attempts: d.attempts, detail: d.detail || {} };
          if (s) Object.assign(s, upd); else st.run.steps.push(Object.assign({ output: null }, upd));
          if (d.state !== 'running') refreshRunSoon();
        }
        schedule();
      })
    };
    Object.keys(live.handlers).forEach((ev) => live.sock.on(ev, live.handlers[ev]));
  }
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'workflows') detach(); });

  App.register({
    id: 'workflows', title: 'Workflows', live: true, summary: 'Graph editor, typed ports, versions, triggers, run history, replay, approvals',
    crumb(st) { return ['Workflows'].concat(st.wf ? [st.wf.name, st.run ? 'run ' + shortId(st.run.id) : st.wf.publishedVersion && !st.wf.dirty && !st.unsaved ? 'v' + st.wf.publishedVersion + ' published' : 'draft'] : []); },
    label: (st) => (st.wf ? st.wf.label : null),
    commands: [{ label: 'Dry run the open workflow', sub: 'Workflows', run(app) { app.stateFor('workflows').autoRun = true; app.render(); } }],
    states: [
      { title: 'Cycle rejected', tone: 'danger', text: 'Publishing fails because Summarise feeds back into Caption frames. The offending edge is highlighted.', apply(ctx) {
        const st = ctx.state; const e = st.validation && st.validation.errors.find((x) => x.code === 'cycle');
        if (e) { st.runId = null; st.run = null; st.sel = e.nodeId || st.sel; ctx.rerender(); return; }
        ctx.toast('<span>The draft has no cycle. Connect a step back to one before it: the edge turns red and Publish is refused until it is removed.</span>', '', 7000);
      } },
      { title: 'Schema mismatch', tone: 'danger', text: 'The edge turns red where an output port does not match the next input port, with both schemas shown.', apply(ctx) {
        const st = ctx.state; const e = st.validation && st.validation.errors.find((x) => x.code === 'schema');
        if (e) { st.runId = null; st.run = null; st.sel = e.nodeId; ctx.rerender(); return; }
        ctx.toast('<span>Every port matches. Give a step an input port that the steps feeding it do not provide, and the edge turns red with both schemas in the inspector.</span>', '', 7000);
      } },
      { title: 'Paused on approval', tone: 'info', text: 'The run shows who must approve, since when, and the data they will see.', apply(ctx) {
        const st = ctx.state; const r = (st.runs || []).find((x) => x.state === 'waiting');
        if (r) { st.runId = r.id; st.run = null; ctx.rerender(); return; }
        const a = (st.approvals || [])[0];
        if (a) { st.wfId = a.workflowId; st.wf = null; st.draft = null; st.runId = a.runId; st.run = null; ctx.rerender(); return; }
        ctx.toast('<span>No run is waiting on an approval. A run that reaches an Approval step pauses without holding a worker until someone with the role decides.</span>', '', 7000);
      } },
      { title: 'Keyboard operation', tone: 'neutral', text: 'Arrow keys move between nodes, Enter opens the inspector, C starts a connection from the selected port.', apply(ctx) { ctx.state.kbd = true; ctx.rerender(); const c = ctx.$('.wf-canvas'); if (c) c.focus(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      const manage = App.can('workflows:manage');
      if (ctx.params.id) { if (st.wfId !== ctx.params.id) { st.wfId = ctx.params.id; st.wf = null; st.draft = null; } delete ctx.params.id; }
      if (ctx.params.run) { st.runId = ctx.params.run; st.run = null; delete ctx.params.run; }
      if (ctx.params.step) { st.sel = ctx.params.step; delete ctx.params.step; }

      if (!st.loaded && !st.loadError && !st.loading) {
        st.loading = true;
        loadList().catch((err) => { st.loadError = err; }).finally(() => { st.loading = false; schedule(); });
      }
      if (!st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Workflows', 'Graphs of model, transform, check and approval steps, run durably') + (st.loadError ? UI.problem('Workflows could not be loaded', st.loadError.message, (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      attach();

      const newWorkflow = () => {
        const myLabels = LABELS.filter((l) => !App.me || LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance));
        ctx.modal({ title: 'New workflow', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'video-to-notes', attrs: 'data-name' }), 'Lower-case letters, digits and hyphens') + UI.field('Label', UI.select(myLabels, 'internal', 'data-lbl'), 'The label of the run input. Steps can raise it, never lower it.') + '</div>' + UI.field('Description', UI.textarea('', { rows: 2, attrs: 'data-desc' })) + '<div class="muted" style="font-size:12px">The draft starts with a manual trigger. It lives in the current workspace.</div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-go' }),
          onMount(m) {
            m.querySelector('[data-go]').addEventListener('click', async () => {
              try {
                const w = await App.post('/api/workflows', { name: m.querySelector('[data-name]').value.trim(), label: m.querySelector('[data-lbl]').value, description: m.querySelector('[data-desc]').value.trim() || null });
                App.closeOverlay();
                st.list = [w].concat(st.list || []); st.wfId = w.id; st.wf = null; st.draft = null; st.runId = null; st.run = null;
                ctx.rerender(); toast(esc(w.name) + ' created as a draft with a manual trigger. Add steps from the palette.', 'ok');
              } catch (err) { App.fail(err, 'Could not create the workflow'); }
            });
          } });
      };

      const list = st.list || [];
      if (!list.some((w) => w.id === st.wfId)) { st.wfId = list[0] ? list[0].id : null; st.wf = null; st.draft = null; }
      if (!st.wfId) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Workflows', 'Graphs of model, transform, check and approval steps, run durably')
          + UI.empty('No workflows in this workspace', manage ? 'Create one to start from a manual trigger.' : 'A workflow admin creates and publishes them; you can then run them here.', manage ? UI.btn('New workflow', { kind: 'primary', icon: 'plus', attrs: 'data-new' }) : '')
          + '</div>';
        ctx.on('click', '[data-new]', newWorkflow);
        return;
      }
      if ((!st.wf || st.wf.id !== st.wfId) && st.wfLoading !== st.wfId && !st.wfError) loadWorkflow(st.wfId);
      if (!st.wf || st.wf.id !== st.wfId || !st.draft) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Workflows', 'Graphs of model, transform, check and approval steps, run durably') + (st.wfError ? UI.problem('The workflow could not be loaded', st.wfError.message, (st.wfError.problem && st.wfError.problem.trace_id) || false) + '<div class="hstack gap6">' + UI.btn('Try again', { attrs: 'data-rewf' }) + UI.btn('Back to the list', { kind: 'ghost', attrs: 'data-backlist' }) + '</div>' : UI.notice('Loading the workflow…', 'info')) + '</div>';
        ctx.on('click', '[data-rewf]', () => { st.wfError = null; ctx.rerender(); });
        ctx.on('click', '[data-backlist]', () => { st.wfError = null; st.wfId = null; st.loaded = false; ctx.rerender(); });
        return;
      }
      if (st.runId && (!st.run || st.run.id !== st.runId) && !st.runError && st.runLoading !== st.runId) { st.runLoading = st.runId; loadRun(st.runId).finally(() => { st.runLoading = null; }); }

      const wf = st.wf;
      const run = st.runId && st.run && st.run.id === st.runId ? st.run : null;
      const viewing = !!st.runId; // a run is open: its pinned graph is shown read-only
      const editable = manage && !viewing;
      const graph = run ? run.graph : st.draft;
      const nodes = graph.nodes;
      const byId = (id) => nodes.find((n) => n.id === id);
      const v = st.validation || { ok: true, errors: [], warnings: [], labels: {} };
      const issues = viewing ? [] : v.errors.concat(v.warnings.map((x) => Object.assign({ warning: true }, x)));
      const issuesOf = (id) => issues.filter((x) => x.nodeId === id);
      const sel = byId(st.sel) || nodes[0];
      if (sel) st.sel = sel.id;
      const runs = st.runs || [];
      const approvalsHere = (st.approvals || []).filter((a) => a.workflowId === wf.id);

      // statuses on the canvas come from the open run
      const status = {};
      if (run) run.steps.forEach((s) => { status[s.nodeId] = s.state === 'waiting' ? (byId(s.nodeId) && byId(s.nodeId).kind === 'approval' || run.approvals.some((a) => a.nodeId === s.nodeId && a.state === 'pending') ? 'waiting on approval' : 'waiting') : s.state; });
      const runState = (r) => (r.state === 'waiting' && (r.approvals ? r.approvals.some((a) => a.state === 'pending') : Object.keys(r.steps || {}).some((k) => r.steps[k] === 'waiting' && byId(k) && byId(k).kind !== 'wait')) ? 'waiting on approval' : r.state);

      // ---- edges (SVG) ----
      const edgeIssue = (e) => issues.find((x) => !x.warning && x.edge && x.edge.from === e.from && x.edge.to === e.to);
      const edges = graph.edges.filter((e) => byId(e.from) && byId(e.to)).map((e) => {
        const iss = edgeIssue(e);
        const skipped = run && status[e.to] === 'skipped';
        return Object.assign({}, e, { label: iss ? (iss.code === 'cycle' ? 'cycle' : iss.code === 'schema' ? 'schema mismatch' : iss.code) : e.branch || '', tone: iss ? 'danger' : '', dashed: !!iss || skipped, cycle: iss && iss.code === 'cycle' && byId(e.to).y <= byId(e.from).y });
      });
      const canvasW = Math.max(700, nodes.reduce((m, n) => Math.max(m, n.x + W + 40), 0));
      const canvasH = Math.max(560, nodes.reduce((m, n) => Math.max(m, n.y + H + 40), 0));
      const path = (e) => {
        const a = byId(e.from), b = byId(e.to);
        if (e.cycle) return 'M' + (a.x + W / 2) + ' ' + a.y + ' V' + (Math.min(a.y, b.y) - 14) + ' H' + (b.x + W / 2 + 20) + ' V' + b.y;
        if (b.x > a.x + W - 1 && Math.abs(b.y - a.y) < 2) return 'M' + (a.x + W) + ' ' + (a.y + H / 2) + ' H' + b.x;
        if (b.x + W < a.x + 1 && Math.abs(b.y - a.y) < 2) return 'M' + a.x + ' ' + (a.y + H / 2) + ' H' + (b.x + W);
        if (Math.abs(b.x - a.x) < 2) return 'M' + (a.x + W / 2) + ' ' + (b.y > a.y ? a.y + H : a.y) + ' V' + (b.y > a.y ? b.y : b.y + H);
        return 'M' + (a.x + W / 2) + ' ' + (b.y > a.y ? a.y + H : a.y) + ' V' + (b.y + H / 2) + ' H' + (b.x > a.x ? b.x : b.x + W);
      };
      const labelPos = (e) => { const a = byId(e.from), b = byId(e.to); if (e.cycle) return [b.x + W / 2 + 24, Math.min(a.y, b.y) - 18]; if (Math.abs(b.y - a.y) < 2) return [(b.x > a.x ? a.x : b.x) + W + 4, a.y + H / 2 - 8]; if (Math.abs(b.x - a.x) < 2) return [a.x + W / 2 + 6, (b.y > a.y ? a.y + H : b.y + H) + 16]; return [a.x + W / 2 + 8, b.y + H / 2 - 8]; };
      const svg = '<svg width="' + canvasW + '" height="' + canvasH + '" viewBox="0 0 ' + canvasW + ' ' + canvasH + '" aria-hidden="true" style="position:absolute;left:0;top:0"><defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="var(--meter)"></path></marker><marker id="wf-arrow-d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="var(--danger-fg)"></path></marker></defs>'
        + edges.map((e) => '<path d="' + path(e) + '" fill="none" stroke="' + (e.tone === 'danger' ? 'var(--danger-fg)' : 'var(--meter)') + '" stroke-width="' + (e.tone === 'danger' ? 2 : 1.5) + '"' + (e.dashed ? ' stroke-dasharray="4 4"' : '') + ' marker-end="url(#' + (e.tone === 'danger' ? 'wf-arrow-d' : 'wf-arrow') + ')"></path>').join('')
        + edges.filter((e) => e.label).map((e) => { const p = labelPos(e); return '<text x="' + p[0] + '" y="' + p[1] + '" font-size="10" fill="' + (e.tone === 'danger' ? 'var(--danger-fg)' : 'var(--muted)') + '" font-family="inherit">' + esc(e.label) + '</text>'; }).join('') + '</svg>';
      const nodeHtml = nodes.map((n) => {
        const bad = issuesOf(n.id).some((x) => !x.warning) || status[n.id] === 'blocked' || status[n.id] === 'failed';
        return '<button type="button" class="wf-node' + (sel && n.id === sel.id ? ' sel' : '') + (bad ? ' danger' : '') + (st.connectFrom === n.id ? ' connecting' : '') + (editable ? ' movable' : '') + '" data-node="' + esc(n.id) + '" style="left:' + n.x + 'px;top:' + n.y + 'px"><span class="wf-port in"></span><span class="wf-port out"></span><div class="t">' + esc(n.title) + '</div><div class="s">' + esc(subOf(n)) + '</div><div class="hstack gap4">' + clsPill(CLS[n.kind]) + statusPill(status[n.id]) + '</div></button>';
      }).join('');

      // ---- inspector ----
      const tokensUsed = run ? run.tokens || 0 : runs.reduce((m, r) => Math.max(m, r.tokens || 0), 0);
      const fan = nodes.reduce((m, n) => Math.max(m, graph.edges.filter((e) => e.from === n.id).length), 0);
      const L = wf.limits;
      const tokenCap = graph.limits.tokens != null ? graph.limits.tokens : L.maxTokens;
      const timeCap = graph.limits.timeoutMs != null ? graph.limits.timeoutMs : L.maxRunTimeoutMs;
      const longest = runs.reduce((m, r) => Math.max(m, r.startedAt && r.finishedAt ? r.finishedAt - r.startedAt : 0), 0);
      const limits = '<div class="hstack"><div class="eyebrow grow">Workflow limits</div>' + (editable ? UI.btn('Set limits', { size: 'xs', kind: 'ghost', attrs: 'data-limits' }) : '') + '</div>'
        + UI.meter('Steps', nodes.length + ' of ' + L.maxSteps, (nodes.length / L.maxSteps) * 100, nodes.length > L.maxSteps ? 'danger' : '')
        + UI.meter('Fan-out', 'up to ' + fan + ' of ' + L.maxFanOut, (fan / L.maxFanOut) * 100, fan > L.maxFanOut ? 'danger' : '')
        + UI.meter('Tokens', Math.round(tokensUsed / 100) / 10 + 'k of ' + Math.round(tokenCap / 1000) + 'k' + (run ? '' : ', largest run'), tokenCap ? (tokensUsed / tokenCap) * 100 : 0)
        + UI.meter('Timeout', dur(run && run.startedAt ? (run.finishedAt || Date.now()) - run.startedAt : longest) + ' of ' + hours(timeCap), timeCap ? (((run && run.startedAt ? (run.finishedAt || Date.now()) - run.startedAt : longest)) / timeCap) * 100 : 0);

      const approvalPanel = (a, stepTitle) => {
        const shown = a.shown == null ? 'Withheld: the run is above your clearance.' : typeof a.shown === 'string' ? a.shown : json(a.shown);
        return UI.panel('Waiting on approval', UI.kv([['Step', esc(stepTitle)], ['Who must approve', 'anyone with the <b>' + esc(a.role) + '</b> role' + (run && run.mode === 'dry' ? ', or you: it is your dry run' : '')], ['Waiting since', esc(when(a.createdAt))], ['Times out', esc(when(a.dueAt)) + ', then the run fails'], ['Data they will see', UI.ctx('shown to the approver', shown || '(nothing configured)', run ? run.label : wf.label)]], 1)
          + (a.canDecide ? '<div class="hstack">' + UI.btn('Reject', { size: 'sm', attrs: 'data-reject="' + esc(a.id) + '"' }) + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-approve="' + esc(a.id) + '"' }) + '</div>' : '<div class="muted" style="font-size:12px">You do not hold the ' + esc(a.role) + ' role, so you cannot decide this step.</div>'), { cls: 'tint' });
      };

      let insp;
      if (viewing) {
        if (!run) insp = st.runError ? UI.problem('The run could not be loaded', st.runError.message, (st.runError.problem && st.runError.problem.trace_id) || false) + UI.btn('Back to the draft', { size: 'sm', attrs: 'data-closerun' }) : UI.notice('Loading the run…', 'info');
        else {
          const rs = runState(run);
          const stepOf = (id) => run.steps.find((s) => s.nodeId === id);
          const pending = run.approvals.filter((a) => a.state === 'pending');
          const retried = run.steps.filter((s) => s.attempts > 1);
          const reused = run.steps.filter((s) => s.detail && s.detail.reused);
          const trig = run.mode === 'dry' ? 'dry run of draft revision ' + run.draftRev : run.trigger === 'replay' ? 'replay of ' + shortId(run.replayOf) + ' from ' + ((byId(run.replayFrom) || {}).title || run.replayFrom) : run.trigger;
          const stepText = (n, s) => {
            if (!s) return status[n.id] ? '' : 'not started';
            const d = s.detail || {};
            if (s.error) return esc(s.error);
            if (d.reused) return 'reused the checkpoint of ' + esc(shortId(d.reused));
            if (s.state === 'running') return 'running' + (s.attempts > 1 ? ', attempt ' + s.attempts : '');
            if (s.state === 'waiting') return n.kind === 'wait' ? 'waiting until ' + esc(when(s.resumeAt || d.resumeAt)) : 'waiting on ' + esc((pending.find((a) => a.nodeId === n.id) || {}).role || 'an approver');
            if (d.mocked) return 'mocked in the dry run';
            if (n.kind === 'model') return (d.tokens != null ? d.tokens.toLocaleString() + ' tokens, ' : '') + dur(d.ms || 0) + (d.model ? ', ' + esc(d.model) : '');
            if (n.kind === 'calc') return d.exact ? 'exact' : 'rounded';
            if (n.kind === 'http') return 'HTTP ' + esc(d.status);
            if (n.kind === 'branch') return 'condition ' + (d.result ? 'true' : 'false');
            if (n.kind === 'guardrail') return 'guardrails: ' + esc(d.action || 'allow');
            if (n.kind === 'tool') return esc(d.tool || 'tool') + ' ' + esc(d.version || '') + (d.approvedBy ? ', approved at ' + esc(d.approvedBy) : '') + (d.toolMs != null ? ', ' + dur(d.toolMs) : '') + (d.warning ? ', ' + esc(d.warning) : '');
            if (n.kind === 'approval' && d.approvedBy) return 'approved';
            return s.state + (d.ms != null ? ', ' + dur(d.ms) : '');
          };
          const replayable = nodes.filter((n) => n.kind !== 'trigger' && stepOf(n.id));
          insp = '<div class="hstack"><div class="eyebrow grow">Run: ' + esc(shortId(run.id)) + '</div>' + UI.iconbtn('x', 'Back to the draft', { cls: 'sm ghost', attrs: 'data-closerun' }) + '</div>'
            + '<div class="hstack wrap gap6">' + runPill(rs) + UI.label(run.label, { sm: true }) + (run.mode === 'dry' ? UI.pill('dry run', 'outline') : UI.pill('v' + run.version, 'outline')) + '</div>'
            + UI.kv([['Trigger', esc(trig)], ['Started', esc(when(run.startedAt || run.createdAt))], ['Duration', run.startedAt ? dur((run.finishedAt || Date.now()) - run.startedAt) + (run.finishedAt ? '' : ' so far') : 'queued'], ['Runs as', 'delegated from ' + esc(run.createdByName || 'the person who started it')], ['Engine', 'job queue, ' + run.steps.filter((s) => s.state === 'passed').length + ' checkpoints'], ['Tokens', (run.tokens || 0).toLocaleString()]], 1)
            + (run.error && !pending.length ? UI.notice(esc(run.error), run.state === 'cancelled' ? 'warn' : 'danger') : '')
            + pending.map((a) => approvalPanel(a, (byId(a.nodeId) || {}).title || a.nodeId)).join('')
            + (retried.length ? UI.notice('The worker stopped during <b>' + esc(retried.map((s) => (byId(s.nodeId) || {}).title || s.nodeId).join(', ')) + '</b>. The run resumed after its last checkpoint; completed steps were not run again.', 'warn') : '')
            + (reused.length ? UI.notice(reused.length + ' step' + (reused.length === 1 ? '' : 's') + ' reused the checkpoints of ' + esc(shortId(run.replayOf)) + '; the rest ran again.', 'info') : '')
            + '<div class="eyebrow">Steps</div>' + UI.timeline(nodes.map((n) => { const s = stepOf(n.id); const stt = status[n.id]; return { title: '<a href="#" data-stepout="' + esc(n.id) + '">' + esc(n.title) + '</a>', text: stepText(n, s), meta: s && s.state === 'passed' ? 'checkpoint ' + esc(n.id) + (s.label !== run.label ? ', ' + esc(s.label) : '') : '', tone: stt === 'passed' ? 'ok' : stt === 'running' || stt === 'waiting' || stt === 'waiting on approval' ? 'accent' : stt === 'failed' || stt === 'blocked' ? 'danger' : '' }; }))
            + '<div class="vstack gap6" style="margin-top:auto">'
            + (ACTIVE[run.state] ? '<div>' + UI.btn('Cancel run', { size: 'sm', kind: 'danger', attrs: 'data-cancelrun' }) + '</div>'
              : replayable.length ? UI.field('Replay from checkpoint', UI.select(replayable.map((n) => ({ value: n.id, label: n.title })), run.replayFrom && byId(run.replayFrom) ? run.replayFrom : (replayable.find((n) => status[n.id] === 'failed' || status[n.id] === 'blocked') || replayable[replayable.length - 1]).id, 'data-replaystep')) + '<div class="hstack wrap">' + UI.btn('Replay step', { size: 'sm', icon: 'refresh', attrs: 'data-replay' }) + UI.btn('Open in Runs', { size: 'sm', kind: 'ghost', attrs: 'data-goruns' }) + '</div>' : '')
            + '</div>';
        }
      } else if (sel) {
        const n = sel; const c = n.config || {};
        const ro = editable ? '' : ' disabled';
        const cfgSel = (key, opts, val) => UI.select(opts, val == null ? '' : String(val), 'data-c="' + key + '"' + ro);
        const cfgIn = (key, val, o) => UI.input(val == null ? '' : String(val), Object.assign({ attrs: 'data-c="' + key + '"' + ro }, o || {}));
        const cfgTa = (key, val, rows, ph) => UI.textarea(val == null ? '' : String(val), { rows: rows || 2, placeholder: ph || '', attrs: 'data-c="' + key + '"' + ro });
        const profiles = (st.profiles || []).map((p) => ({ value: p.name, label: p.name + ' · ' + p.label }));
        if (c.profile && !profiles.some((p) => p.value === c.profile)) profiles.unshift({ value: c.profile, label: c.profile + ' (not published or not visible)' });
        let fields = '';
        if (n.kind === 'trigger') fields = UI.field('Trigger', cfgSel('source', [{ value: 'manual', label: 'manual from the console' }, { value: 'api', label: 'API or console' }], c.source || 'manual'), 'Runs start from the console or POST /api/workflows/:id/runs');
        else if (n.kind === 'model') fields = UI.field('Profile', profiles.length ? cfgSel('profile', profiles, c.profile) : cfgIn('profile', c.profile), c.profile ? '<a href="#" data-goprofile="' + esc(c.profile) + '">Open profile</a>' : 'Published profiles only; the call goes through the gateway')
          + '<div class="grid2" style="gap:10px">' + UI.field('Think level', cfgSel('think', [{ value: '', label: 'profile default' }, 'off', 'low', 'medium', 'high'], c.think || '')) + UI.field('Answer', cfgSel('format', [{ value: 'text', label: 'text' }, { value: 'json', label: 'JSON (output schema)' }], c.format || 'text')) + '</div>'
          + UI.field('Prompt template', cfgTa('prompt', c.prompt, 4), 'Reads {{input.…}} and {{steps.&lt;id&gt;.…}} of earlier steps');
        else if (n.kind === 'transform') fields = UI.field('Fields', cfgTa('fields', lines(c.fields), 3, 'summary: {{steps.summarise.text}}'), 'One per line: name: template');
        else if (n.kind === 'branch') fields = UI.field('Left', cfgIn('left', c.left)) + '<div class="grid2" style="gap:10px">' + UI.field('Operator', cfgSel('op', OPS, c.op)) + UI.field('Right', cfgIn('right', c.right, { placeholder: c.op === 'truthy' || c.op === 'exists' ? 'not used' : '' })) + '</div><div class="muted" style="font-size:12px">Edges out of a branch carry true or false; the other side is skipped.</div>';
        else if (n.kind === 'guardrail') fields = UI.field('Checkpoint', cfgSel('checkpoint', CHECKPOINTS, c.checkpoint || 'context')) + UI.field('Text to check', cfgTa('text', c.text, 2)) + UI.field('Approver when rules ask for one', cfgSel('approverRole', ROLES, c.approverRole || 'workflow-admin'), 'Block fails the step; redact passes the masked text on') + UI.field('Approval timeout', cfgIn('approvalTimeoutMs', Math.round((c.approvalTimeoutMs || 86400000) / 3600000), { type: 'number' }), 'Hours. The run fails if nobody decides in time');
        else if (n.kind === 'approval') fields = UI.field('Role', cfgSel('role', ROLES, c.role)) + UI.field('Timeout', cfgIn('timeoutMs', Math.round((c.timeoutMs || 86400000) / 3600000), { type: 'number' }), 'Hours. The run fails if nobody decides in time') + UI.field('Data the approver sees', cfgTa('show', c.show, 2, '{{steps.summarise.text}}'));
        else if (n.kind === 'http') fields = '<div class="grid2" style="gap:10px;grid-template-columns:90px 1fr">' + UI.field('Method', cfgSel('method', ['GET', 'POST', 'PUT'], c.method || 'GET')) + UI.field('URL', cfgIn('url', c.url)) + '</div>' + UI.field('Body', cfgTa('body', c.body, 2)) + UI.field('Headers', cfgTa('headers', lines(c.headers), 2, 'X-Request-Source: exprsn'), 'Content-Type, Accept and X- headers only') + '<div class="muted" style="font-size:12px">Internal hosts only: private addresses, never link-local or the internet. The host cannot come from a template.</div>';
        else if (n.kind === 'calc') fields = UI.field('Expression', cfgTa('expression', c.expression, 2), 'Exact arithmetic; placeholders are filled first') + '<div class="muted" style="font-size:12px">Exact, deterministic; the result records the fraction and whether it is exact.</div>';
        else if (n.kind === 'wait') fields = UI.field('Duration', cfgIn('ms', Math.round((c.ms || 60000) / 1000), { type: 'number' }), 'Seconds. The run pauses without holding a worker');
        else if (n.kind === 'tool') {
          const tools = st.tools || [];
          const t = tools.find((x) => x.name === c.tool);
          const opts = tools.map((x) => ({ value: x.name, label: x.name + ' · ' + x.sideEffect + (x.status === 'deprecated' ? ' · deprecated' : '') }));
          if (c.tool && !t) opts.unshift({ value: c.tool, label: c.tool + ' (not published here)' });
          if (!c.tool) opts.unshift({ value: '', label: 'choose a tool' });
          const writes = t && (t.sideEffect !== 'read' || t.confirm === 'always');
          fields = UI.field('Tool', opts.length ? cfgSel('tool', opts, c.tool || '') : cfgIn('tool', c.tool, { placeholder: 'jira.search_issues' }), tools.length ? 'Published registry and MCP tools in this workspace; calls go through the dispatcher and the tool-call guardrail' : 'No tools are published to this workspace yet')
            + (t ? UI.kv([['Side effect', UI.pill(t.sideEffect, t.sideEffect === 'read' ? 'outline' : t.sideEffect === 'write' ? 'warn' : 'danger')], ['Max label', UI.label(t.label, { sm: true })], ['Version', esc(t.version)], ['Takes', '<span class="mono">' + esc(fmtSchema(t.inputSchema)) + '</span>']], 2) + (t.description ? '<div class="muted" style="font-size:12px">' + esc(t.description) + '</div>' : '') : '')
            + UI.field('Arguments', cfgTa('args', typeof c.args === 'string' ? c.args : lines(c.args), 3, 'summary: {{steps.summarise.text}}'), 'One per line: name: template. Empty: the fields of its input that the tool takes')
            + UI.field('Approver before the call', cfgSel('approverRole', ROLES, c.approverRole || 'workflow-admin'), writes ? 'This is a ' + esc(t.sideEffect) + ' tool: unless an Approval step comes before it on every path, the run pauses for this role, then makes the call' : 'Used when the tool-call guardrail holds the call')
            + UI.field('Approval timeout', cfgIn('approvalTimeoutMs', Math.round((c.approvalTimeoutMs || 86400000) / 3600000), { type: 'number' }), 'Hours. When the step pauses for its approver, the run fails if nobody decides in time')
            + '<div class="muted" style="font-size:12px">Dry runs mock the result from the tool\'s output schema and call nothing.</div>';
        }
        const mine = issuesOf(n.id);
        const schemaErr = mine.find((x) => x.code === 'schema');
        const issueHtml = mine.filter((x) => x !== schemaErr).map((x) => UI.notice((x.code === 'label' ? '<b>Blocked by label ceiling.</b> ' : x.code === 'cycle' ? '<b>Cycle.</b> ' : x.code === 'unavailable' ? '<b>Not available.</b> ' : '') + esc(x.message), x.warning ? 'warn' : 'danger')).join('')
          + (schemaErr ? UI.notice('<b>Schema mismatch.</b> ' + esc(schemaErr.message), 'danger', editable ? UI.btn('Fix', { size: 'sm', attrs: 'data-fixschema', title: 'Accept what arrives as this step\'s input port' }) : '') : '');
        const schemaBox = (key, s, hint) => (editable ? UI.field(hint, UI.textarea(s ? json(s) : '', { rows: 3, placeholder: '{ "type": "object", "properties": { … }, "required": [ … ] }', attrs: 'data-schema="' + key + '"' + (schemaErr && key === 'input' ? ' style="border-color:var(--danger-fg)"' : '') })) : '')
          + '<pre class="codebox" style="' + (schemaErr && key === 'input' ? 'border-color:var(--danger-fg)' : '') + '">' + esc(s ? fmtSchema(s) : key === 'input' ? 'accepts whatever the steps before it send' : 'object') + '</pre>';
        const toolOf = n.kind === 'tool' ? (st.tools || []).find((x) => x.name === c.tool) : null;
        const retry = n.kind === 'model' ? 'retried after a restart; the gateway falls back within the profile' : n.kind === 'calc' || n.kind === 'transform' || n.kind === 'branch' ? 'freely, deterministic' : n.kind === 'http' ? (c.method && c.method !== 'GET' ? 'a replay sends it again' : 'safe to repeat') : n.kind === 'tool' ? (toolOf && toolOf.sideEffect !== 'read' ? 'a replay calls it again, after a new approval' : 'safe to repeat') : 'not applicable';
        const outs = graph.edges.filter((e) => e.from === n.id);
        insp = '<div class="hstack"><div class="eyebrow grow">Step: ' + esc(n.title) + '</div>' + (editable ? UI.iconbtn('trash', n.kind === 'trigger' ? 'The trigger cannot be removed' : 'Remove step', { cls: 'sm ghost', attrs: 'data-remove' + (n.kind === 'trigger' ? ' disabled' : '') }) : '') + '</div>'
          + '<div class="hstack gap6">' + clsPill(CLS[n.kind]) + (CLS[n.kind] !== 'control' ? '<span class="muted" style="font-size:12px">' + (CLS[n.kind] === 'Thinking' ? 'gateway slot' : CLS[n.kind] === 'Calculating' ? 'calculation worker' : 'workflow worker') + '</span>' : '') + '</div>'
          + issueHtml
          + UI.field('Title', UI.input(n.title, { attrs: 'data-f="title"' + ro }))
          + fields
          + (n.kind === 'trigger' ? '<div class="eyebrow">Output schema (the run input)</div>' + schemaBox('output', n.output, 'Port schema, JSON')
            : '<div class="eyebrow">Input port</div>' + schemaBox('input', n.input, 'Port schema, JSON (optional)')
              + (schemaErr && schemaErr.actual ? '<div class="eyebrow">Incoming from ' + esc(graph.edges.filter((e) => e.to === n.id).map((e) => (byId(e.from) || {}).title).join(', ')) + '</div><pre class="codebox" style="border-color:var(--danger-fg)">' + esc(fmtSchema(schemaErr.actual)) + '</pre>' : '')
              + ((n.kind === 'model' && c.format === 'json') ? '<div class="eyebrow">Output schema</div>' + schemaBox('output', n.output, 'Port schema, JSON') : ''))
          + '<div class="grid2" style="gap:10px">' + UI.field('Ceiling', UI.select([{ value: '', label: 'none' }].concat(LABELS), n.ceiling || '', 'data-f="ceiling"' + ro), 'Highest label it may handle') + UI.field('Raises to', UI.select([{ value: '', label: 'nothing' }].concat(LABELS), n.raises || '', 'data-f="raises"' + ro), 'Label of data it brings in') + '</div>'
          + (n.kind !== 'trigger' ? UI.field('Step timeout', UI.input(n.timeoutMs ? Math.round(n.timeoutMs / 1000) : '', { type: 'number', placeholder: String(L.defaultStepTimeoutMs / 1000), attrs: 'data-f="timeoutMs"' + ro }), 'Seconds, up to ' + L.maxStepTimeoutMs / 60000 + ' minutes') : '')
          + UI.kv([['Label in', UI.label(v.labels[n.id] || wf.label, { sm: true })], ['Runs as', n.kind === 'trigger' ? 'not applicable' : 'the person who started the run'], ['Retry', esc(retry)]], 1)
          + (outs.length ? '<div class="eyebrow">Connects to</div><div class="vstack gap4">' + outs.map((e) => '<div class="hstack gap6" style="font-size:12px"><span class="grow">' + esc((byId(e.to) || {}).title || e.to) + '</span>' + (n.kind === 'branch' ? UI.btn(e.branch || 'set', { size: 'xs', kind: 'ghost', attrs: 'data-flip="' + esc(e.to) + '"' + (editable ? '' : ' disabled'), title: 'Switch between true and false' }) : '') + (editable ? UI.iconbtn('x', 'Remove the edge to ' + ((byId(e.to) || {}).title || e.to), { cls: 'sm ghost', attrs: 'data-unlink="' + esc(e.to) + '"' }) : '') + '</div>').join('') + '</div>' : '')
          + '<div class="hstack wrap">' + (editable ? UI.btn(st.connectFrom === n.id ? 'Pick a target' : 'Connect from here', { size: 'sm', icon: 'link', attrs: 'data-connect', cls: st.connectFrom === n.id ? 'active' : '' }) : '') + (n.kind !== 'trigger' ? UI.btn('Replay step', { size: 'sm', kind: 'ghost', icon: 'refresh', attrs: 'data-replaystepbtn' }) : '') + '</div>'
          // Moving a step without dragging (WCAG 2.5.7): one button press per 20 px.
          + (editable ? '<div class="hstack wrap gap6" role="group" aria-label="Move this step on the canvas"><span class="muted" style="font-size:12px">Move</span>' + [['left', -20, 0], ['up', 0, -20], ['down', 0, 20], ['right', 20, 0]].map((d) => UI.btn(d[0].charAt(0).toUpperCase() + d[0].slice(1), { size: 'xs', kind: 'ghost', attrs: 'data-nudge="' + d[1] + ',' + d[2] + '" aria-label="Move step ' + d[0] + '"' })).join('') + '</div>' : '')
          + limits;
      } else insp = UI.empty('No steps', 'Add a step from the palette.');

      const problem = st.problem && !viewing ? UI.problem(st.problem.title, st.problem.detail, st.problem.trace || false) + (st.problem.errors && st.problem.errors.length > 1 ? '<div class="vstack gap4">' + st.problem.errors.map((x) => '<a href="#" data-issue="' + esc(x.nodeId || '') + '" style="font-size:12px">' + esc(x.message) + '</a>').join('') + '</div>' : '') : '';
      const blocking = v.errors.length;
      const published = wf.publishedVersion && !wf.dirty && !st.unsaved;
      const trigger = nodes.find((n) => n.kind === 'trigger');
      const workflows = list.map((w) => ({ value: w.id, label: w.name + (w.publishedVersion ? ' v' + w.publishedVersion + ' published' : ' draft') }));
      if (manage) workflows.push({ value: '__new', label: 'New workflow…' });

      root.innerHTML = '<style>'
        + '.wf-page > *{flex-shrink:0}.wf-insp > *{flex-shrink:0}'
        + '.wf-palette{display:flex;flex-direction:column;gap:2px}.wf-palette button{display:flex;align-items:center;justify-content:space-between;gap:6px;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:5px;background:var(--panel);font-size:12px;color:var(--fg);cursor:pointer;text-align:left;font-family:inherit}.wf-palette button:hover{border-color:var(--muted)}.wf-palette button[disabled]{opacity:.45;cursor:not-allowed}.wf-palette button i{width:6px;height:6px;border-radius:50%;background:var(--meter);flex-shrink:0}.wf-palette button i.think{background:var(--info-fg)}.wf-palette button i.do{background:var(--warn-fg)}.wf-palette button i.calc{background:var(--ok-fg)}'
        + '.wf-scroll{overflow:auto;border:1px solid var(--line);border-radius:6px;background:var(--panel2);background-image:radial-gradient(var(--line2) 1px, transparent 1px);background-size:16px 16px}'
        + '.wf-canvas{position:relative;outline:none}.wf-canvas:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}'
        + '.wf-node{position:absolute;width:' + W + 'px;height:' + H + 'px;display:flex;flex-direction:column;gap:3px;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:6px;box-shadow:0 1px 2px rgba(0,0,0,.05);text-align:left;cursor:pointer;font-family:inherit;color:var(--fg);overflow:hidden;touch-action:none}.wf-node.movable{cursor:grab}'
        + '.wf-node .t{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wf-node .s{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wf-node .pill{height:18px;font-size:11px}'
        + '.wf-node:hover{border-color:var(--muted)}.wf-node.sel{border:2px solid var(--accent);padding:7px 9px}.wf-node.danger{border-color:var(--danger-fg)}.wf-node.connecting{box-shadow:0 0 0 3px var(--accent-tint)}'
        + '.wf-port{position:absolute;top:50%;width:7px;height:7px;border-radius:50%;background:var(--panel);border:1px solid var(--muted);transform:translateY(-50%)}.wf-port.in{left:-4px}.wf-port.out{right:-4px}'
        + '.wf-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}'
        + '</style>'
        + '<div class="leftpane w170"><div class="eyebrow">Steps</div><div class="wf-palette">' + PALETTE.map((p) => '<button type="button" data-add="' + p[0] + '" title="' + esc(editable ? 'Add ' + p[1] + ' (' + p[2] + ')' : manage ? 'Close the run to edit the draft' : 'Editing needs the workflows:manage permission') + '"' + (editable ? '' : ' disabled') + '><span>' + esc(p[1]) + '</span><i class="' + (p[2] === 'Thinking' ? 'think' : p[2] === 'Doing' ? 'do' : p[2] === 'Calculating' ? 'calc' : '') + '"></i></button>').join('') + '</div><div class="muted" style="font-size:11px;margin-top:auto">Click a step to add it to the canvas. Dot: thinking, doing or calculating worker class. Drag steps to arrange them.</div></div>'
        + '<div class="page wf-page">'
        + '<div class="wf-toolbar">' + UI.select(workflows, wf.id, 'data-wf aria-label="Workflow" style="width:auto"') + UI.pill(published ? 'published' : 'draft', published ? 'ok' : '') + (st.unsaved ? UI.pill('unsaved changes', 'warn') : '') + '<span class="muted" style="font-size:12px">trigger: ' + esc(trigger ? subOf(trigger) : 'none') + ' · engine job queue · limits ' + L.maxSteps + ' steps, ' + Math.round(L.maxTokens / 1000) + 'k tokens, ' + hours(L.maxRunTimeoutMs) + '</span>' + (approvalsHere.length ? '<a href="#" class="right" data-pending style="font-size:12px">' + approvalsHere.length + ' run' + (approvalsHere.length > 1 ? 's' : '') + ' waiting on approval</a>' : '') + UI.btn('Versions', { size: 'sm', kind: 'ghost', attrs: 'data-versions', cls: approvalsHere.length ? '' : 'right' }) + '</div>'
        + (st.kbd ? UI.notice('<b>Keyboard operation.</b> Arrow keys move between nodes, Enter opens the inspector, C starts a connection from the selected port, Shift and an arrow completes it, Delete removes the step, Escape cancels.', 'info', UI.btn('Dismiss', { size: 'sm', attrs: 'data-dismisskbd' })) : '')
        + (st.connectFrom && !viewing ? UI.notice('Connecting from <b>' + esc((byId(st.connectFrom) || {}).title) + '</b>. Click a target step, or press Escape.', 'accent', UI.btn('Cancel', { size: 'sm', attrs: 'data-cancelconnect' })) : '')
        + (viewing && run ? UI.notice('Showing run <b>' + esc(shortId(run.id)) + '</b> on ' + (run.mode === 'dry' ? 'draft revision ' + run.draftRev : 'version ' + run.version) + '. Runs pin the graph they started on.', 'info', UI.btn('Back to the draft', { size: 'sm', attrs: 'data-closerun' })) : '')
        + (st.conflict ? UI.notice('<b>The draft changed since you opened it.</b> ' + esc(st.conflict) + ' Your unsaved edits stay here until you reload.', 'warn', UI.btn('Reload the draft', { size: 'sm', attrs: 'data-reloaddraft' })) : '')
        + (st.parseError && !viewing ? UI.notice('<b>The draft cannot be checked.</b> ' + esc(st.parseError), 'danger') : '')
        + problem
        + '<div class="wf-scroll" data-scroll-x data-scroll-2d><div class="wf-canvas" tabindex="0" aria-label="Workflow canvas" style="width:' + canvasW + 'px;height:' + canvasH + 'px">' + svg + nodeHtml + '<div style="position:absolute;right:12px;top:12px;display:flex;gap:6px">' + (manage ? UI.btn(st.starting ? 'Starting' : 'Dry run', { size: 'sm', icon: 'play', attrs: 'data-dryrun', disabled: !!st.starting }) : '') + '</div></div></div>'
        + '<div class="wf-toolbar">'
        + (manage ? UI.btn('Dry run', { size: 'sm', icon: 'play', attrs: 'data-dryrun', disabled: !!st.starting }) : '')
        + UI.btn('Start run', { size: 'sm', icon: 'play', attrs: 'data-startrun', disabled: !wf.publishedVersion || !!st.starting, title: wf.publishedVersion ? 'Runs the published version ' + wf.publishedVersion : 'Publish a version first' })
        + (manage ? UI.btn('Publish as tool', { size: 'sm', attrs: 'data-pubtool', disabled: !wf.publishedVersion, title: wf.publishedVersion ? 'Offer v' + wf.publishedVersion + ' as a registry tool, after review' : 'Publish a version first' }) : '')
        + (manage ? UI.btn('Save draft', { size: 'sm', attrs: 'data-save', disabled: !st.unsaved || !!st.saving }) : '')
        + (manage ? UI.btn(published ? 'Published' : 'Publish', { size: 'sm', kind: 'primary', attrs: 'data-publish', disabled: !!published || !!st.saving, title: blocking ? blocking + ' problem' + (blocking === 1 ? '' : 's') + ' to fix first' : '' }) : '')
        + (viewing ? UI.btn('Clear run', { size: 'sm', kind: 'ghost', attrs: 'data-closerun' }) : '')
        + ((wf.tools || []).length ? '<span class="muted" style="font-size:12px">As a tool: ' + wf.tools.map((x) => (App.can('tools:manage') ? '<a href="#" data-gotool="' + esc(x.id) + '">' + esc(x.name) + ' ' + esc(x.version) + '</a>' : esc(x.name) + ' ' + esc(x.version)) + ' ' + UI.pill(x.status.replace('_', ' '), x.status === 'published' ? 'ok' : x.status === 'in_review' ? 'info' : '')).join(', ') + '</span>' : '')
        + '<span class="muted right" style="font-size:12px">' + nodes.length + ' steps, ' + graph.edges.length + ' edges' + (viewing ? '' : blocking ? ', <span style="color:var(--danger-fg)">' + blocking + ' problem' + (blocking === 1 ? '' : 's') + '</span>' : v.warnings.length ? ', ' + v.warnings.length + ' warning' + (v.warnings.length === 1 ? '' : 's') : ', valid') + '</span></div>'
        + UI.panel('Run history', UI.table(['Run', 'Trigger', 'Started', 'Duration', 'Label', 'State'], runs.map((r) => ({ cells: ['<span class="mono">' + esc(shortId(r.id)) + '</span>', esc(r.mode === 'dry' ? 'dry run, ' + (r.createdByName || '') : r.trigger === 'replay' ? 'replay of ' + shortId(r.replayOf) : r.trigger + ', ' + (r.createdByName || '')), esc(when(r.startedAt || r.createdAt)), r.startedAt ? dur((r.finishedAt || Date.now()) - r.startedAt) : '—', UI.label(r.label, { sm: true }), runPill(runState(r))], attrs: 'data-run="' + esc(r.id) + '"', selected: st.runId === r.id })), { cls: 'bare', minWidth: '0', emptyTitle: 'No runs yet', emptyText: wf.publishedVersion ? 'Start a run of the published version, or dry run the draft.' : 'Dry run the draft, or publish it and start a run.' }), { actions: UI.btn('Open in Runs', { size: 'sm', kind: 'ghost', attrs: 'data-goruns' }), cls: 'pad0' }).replace('class="panel pad0"', 'class="panel" style="padding:14px"')
        + '</div>'
        + '<aside class="inspector w300 wf-insp" aria-label="Inspector">' + insp + '</aside>';

      // ---------- editing ----------
      const changed = (msg) => { st.unsaved = true; st.problem = null; validateSoon(); ctx.rerender(); if (msg) toast(msg); };
      // A text field's change fires as it loses focus, often on the press of another control: re-rendering now would
      // swallow that click, so the draft is updated in place and the screen follows once nobody is typing.
      const softChanged = () => {
        st.unsaved = true; st.problem = null; validateSoon();
        ctx.$$('[data-save], [data-publish]').forEach((b) => { b.disabled = false; });
        schedule();
      };
      const after = (t) => (t.tagName === 'SELECT' ? changed() : softChanged());
      const selNode = () => st.draft.nodes.find((x) => x.id === st.sel);
      const addEdge = (from, to) => {
        const g = st.draft; const a = g.nodes.find((x) => x.id === from);
        if (from === to) return;
        if (g.edges.some((e) => e.from === from && e.to === to)) { toast('Those steps are already connected.', 'warn'); return; }
        const e = { from, to };
        if (a && a.kind === 'branch') e.branch = g.edges.some((x) => x.from === from && x.branch === 'true') ? 'false' : 'true';
        g.edges.push(e);
        const back = g.edges.some((x) => x.from === to && x.to === from);
        changed(back ? 'That edge creates a cycle. Publishing is refused until it is removed.' : 'Connected' + (e.branch ? ' on the ' + e.branch + ' side' : '') + '. The output is checked against the target\'s input port.');
      };
      const removeSel = async () => {
        const n = selNode(); if (!n || n.kind === 'trigger') return;
        const ok = await ctx.confirm({ title: 'Remove step ' + n.title, tag: 'edit', tone: 'warn', body: '<p class="fg2" style="margin:0">Edges into and out of the step are removed. Published versions are unchanged until you publish again.</p>', ok: 'Remove' });
        if (!ok) return;
        st.draft.nodes = st.draft.nodes.filter((x) => x.id !== n.id);
        st.draft.edges = st.draft.edges.filter((e) => e.from !== n.id && e.to !== n.id);
        st.sel = st.draft.nodes[0] ? st.draft.nodes[0].id : null;
        changed(esc(n.title) + ' removed. Save the draft to keep it.');
      };
      const save = async (quiet) => {
        if (!st.unsaved) return true;
        st.saving = true;
        try {
          const saved = await App.api('PUT', '/api/workflows/' + enc(wf.id) + '/draft', { graph: st.draft, rev: wf.draftRev });
          st.wf = saved; st.unsaved = false; st.conflict = null; st.validation = saved.validation;
          st.draft = clone(saved.draft);
          const i = list.findIndex((x) => x.id === saved.id); if (i >= 0) list[i] = Object.assign({}, list[i], { draftRev: saved.draftRev, updatedAt: saved.updatedAt });
          if (!quiet) toast('Draft saved as revision ' + saved.draftRev + '. Publish to make it live.', 'ok');
          return true;
        } catch (err) {
          if (err.status === 409) st.conflict = (err.problem && err.problem.detail) || err.message;
          App.fail(err, 'Could not save the draft');
          return false;
        } finally { st.saving = false; ctx.rerender(); }
      };

      // ---- runs ----
      const openRunModal = (dry) => {
        const tr = st.draft.nodes.find((n) => n.kind === 'trigger');
        const pubTrigger = !dry && wf.versions.find((x) => x.version === wf.publishedVersion);
        const schema = dry ? tr && tr.output : pubTrigger && (pubTrigger.graph.nodes.find((n) => n.kind === 'trigger') || {}).output;
        ctx.modal({ title: dry ? 'Dry run the draft' : 'Start a run of v' + wf.publishedVersion, body: '<p class="fg2" style="margin:0">' + (dry ? 'Runs the saved draft. Model and HTTP steps are mocked, guardrails are not consulted and nothing is metered. Approvals wait on you.' + (st.unsaved ? ' Your unsaved changes are saved first.' : '') : 'Runs the published version as you. Each step is checkpointed; approvals pause the run until someone with the role decides.') + '</p>'
          + UI.field('Input (JSON)', UI.textarea(json(sample(schema || { type: 'object' }) || {}), { rows: 5, attrs: 'data-input' }), 'Must match the trigger\'s output schema: <span class="mono">' + esc(fmtSchema(schema || { type: 'object' })) + '</span>')
          + UI.kv([['Label', UI.label(wf.label, { sm: true })], ['Runs as', 'you, ' + esc(App.me ? App.me.user.displayName || App.me.user.username : '')]], 2),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(dry ? 'Dry run' : 'Start run', { kind: 'primary', icon: 'play', attrs: 'data-go' }),
        onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            let input;
            try { input = JSON.parse(m.querySelector('[data-input]').value || '{}'); } catch (e) { toast('The input is not valid JSON: ' + esc(e.message), 'danger'); return; }
            if (!input || typeof input !== 'object' || Array.isArray(input)) { toast('The input must be a JSON object.', 'danger'); return; }
            App.closeOverlay();
            st.starting = true; ctx.rerender();
            try {
              if (dry && !(await save(true))) return;
              const r = await App.post('/api/workflows/' + enc(wf.id) + (dry ? '/dry-run' : '/runs'), { input });
              st.runId = r.id; st.run = null; st.runError = null;
              loadRuns();
              toast((dry ? 'Dry run' : 'Run') + ' <span class="mono">' + esc(shortId(r.id)) + '</span> started. Steps report on the canvas.', 'ok');
            } catch (err) { App.fail(err, dry ? 'The dry run was refused' : 'The run was refused'); } finally { st.starting = false; ctx.rerender(); }
          });
        } });
      };
      const decide = async (id, approve) => {
        const a = run && run.approvals.find((x) => x.id === id); if (!a) return;
        const title = (byId(a.nodeId) || {}).title || a.nodeId;
        if (approve) {
          const ok = await ctx.confirm({ title: 'Approve step: ' + title, tag: 'approval', tone: 'info', body: '<p class="fg2" style="margin:0">Your decision is written to the audit chain and the run continues from this step.</p>', kv: [['Role', esc(a.role)], ['Label', UI.label(run.label, { sm: true })]], ok: 'Approve' });
          if (!ok) return;
          try { await App.post('/api/workflow-approvals/' + enc(id), { decision: 'approve' }); toast('Approved. The run continues; its steps report on the canvas.', 'ok'); loadRun(run.id); loadRuns(); } catch (err) { App.fail(err, 'Could not approve'); }
          return;
        }
        ctx.modal({ title: 'Reject approval ' + UI.pill('reject', 'danger'), body: UI.field('Reason', UI.textarea('', { placeholder: 'Sent to the run owner', rows: 2, attrs: 'data-reason' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-go' }),
          onMount(m) {
            m.querySelector('[data-go]').addEventListener('click', async () => {
              const reason = m.querySelector('[data-reason]').value.trim() || null; App.closeOverlay();
              try { await App.post('/api/workflow-approvals/' + enc(id), { decision: 'reject', reason }); toast('Rejected. The run ended; the owner can see your reason.', 'warn'); loadRun(run.id); loadRuns(); } catch (err) { App.fail(err, 'Could not reject'); }
            });
          } });
      };
      const replay = async (runId, from) => {
        const r = runs.find((x) => x.id === runId) || run; const g = run && run.id === runId ? run.graph : graph;
        const n = g.nodes.find((x) => x.id === from);
        const ok = await ctx.confirm({ title: 'Replay from ' + (n ? n.title : from), tag: 'replay', tone: 'info', body: '<p class="fg2" style="margin:0">A new run starts from this step. Steps before it keep their checkpoints; it and everything after it run again with the same input. HTTP steps that write send again.</p>', kv: [['Run', esc(shortId(runId))], ['Checkpoint', '<span class="mono">' + esc(from) + '</span>'], ['Inputs', 'kept, ' + esc(r ? r.label : wf.label)]], ok: 'Replay' });
        if (!ok) return;
        try { const out = await App.post('/api/workflow-runs/' + enc(runId) + '/replay', { from }); st.runId = out.id; st.run = null; loadRuns(); ctx.rerender(); toast('Replaying from ' + esc(n ? n.title : from) + ' as <span class="mono">' + esc(shortId(out.id)) + '</span>.', 'ok'); } catch (err) { App.fail(err, 'Could not replay'); }
      };

      // ---- events ----
      let drag = null; let suppressClick = false;
      ctx.on('pointerdown', '[data-node]', (e, t) => {
        if (!editable || e.button !== 0) return;
        const n = st.draft.nodes.find((x) => x.id === t.dataset.node); if (!n) return;
        drag = { n, el: t, sx: e.clientX, sy: e.clientY, x: n.x, y: n.y, moved: false };
        const move = (ev) => {
          const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
          drag.moved = true; st.dragging = true;
          drag.n.x = Math.max(0, Math.round((drag.x + dx) / 2) * 2); drag.n.y = Math.max(0, Math.round((drag.y + dy) / 2) * 2);
          drag.el.style.left = drag.n.x + 'px'; drag.el.style.top = drag.n.y + 'px';
        };
        const up = () => {
          window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
          const d = drag; drag = null; st.dragging = false;
          if (d && d.moved) { suppressClick = true; st.sel = d.n.id; st.unsaved = true; ctx.rerender(); }
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      ctx.on('click', '[data-node]', (e, t) => {
        if (suppressClick) { suppressClick = false; return; }
        const id = t.dataset.node;
        if (st.connectFrom && !viewing && st.connectFrom !== id) { const from = st.connectFrom; st.connectFrom = null; addEdge(from, id); return; }
        st.sel = id; ctx.rerender();
      });
      ctx.on('click', '[data-add]', (e, t) => {
        if (!editable) return;
        const p = PALETTE.find((x) => x[0] === t.dataset.add); const ns = st.draft.nodes;
        const slots = []; [24, 152, 282, 412, 542, 672].forEach((y) => [20, 230, 440].forEach((x) => slots.push([x, y])));
        const free = slots.find((s) => !ns.some((n) => Math.abs(n.x - s[0]) < W && Math.abs(n.y - s[1]) < H)) || [20, ns.reduce((m, n) => Math.max(m, n.y), 0) + 130];
        let i = 1; while (ns.some((n) => n.id === p[0] + i)) i++;
        const id = p[0] + i;
        const node = { id, kind: p[0], title: p[1] + (i > 1 ? ' ' + i : ''), x: free[0], y: free[1], config: defaults(p[0], st) };
        ns.push(node);
        const from = st.sel && ns.find((n) => n.id === st.sel && n.id !== id);
        if (from && !st.draft.edges.some((e2) => e2.from === from.id) && from.kind !== 'branch') st.draft.edges.push({ from: from.id, to: id });
        st.sel = id;
        changed(esc(p[1]) + ' added as a ' + (p[2] === 'control' ? 'control' : p[2].toLowerCase()) + ' step' + (from && st.draft.edges.some((e2) => e2.from === from.id && e2.to === id) ? ' after ' + esc(from.title) : '. Connect it from another step\'s output port') + '.');
      });
      ctx.on('click', '[data-remove]', removeSel);
      ctx.on('change', '[data-f]', (e, t) => {
        const n = selNode(); if (!n || !editable) return;
        const k = t.dataset.f; const val = t.value.trim();
        if (k === 'title') { if (!val) { toast('A step needs a title.', 'warn'); t.value = n.title; return; } n.title = val.slice(0, 100); }
        else if (k === 'timeoutMs') { if (val) n.timeoutMs = Math.round(Number(val) * 1000); else delete n.timeoutMs; }
        else if (val) n[k] = val; else delete n[k];
        after(t);
      });
      ctx.on('change', '[data-c]', (e, t) => {
        const n = selNode(); if (!n || !editable) return;
        const k = t.dataset.c; const raw = t.value; const c = n.config = n.config || {};
        if (k === 'fields' || k === 'headers') c[k] = unlines(raw);
        else if (k === 'timeoutMs' || k === 'approvalTimeoutMs') c[k] = Math.max(1, Number(raw) || 24) * 3600000;
        else if (k === 'ms') c[k] = Math.max(1, Number(raw) || 60) * 1000;
        else if (k === 'right') { const s = raw.trim(); if (s === '') delete c.right; else c.right = s === 'true' ? true : s === 'false' ? false : !isNaN(Number(s)) ? Number(s) : s; }
        else if (k === 'args' && raw.trim()) c[k] = unlines(raw);
        else if ((k === 'think' || k === 'body' || k === 'args') && !raw.trim()) delete c[k];
        else c[k] = raw;
        after(t);
      });
      ctx.on('change', '[data-schema]', (e, t) => {
        const n = selNode(); if (!n || !editable) return;
        const k = t.dataset.schema; const raw = t.value.trim();
        if (!raw) { delete n[k]; after(t); return; }
        try { n[k] = JSON.parse(raw); after(t); } catch (err) { toast('The port schema is not valid JSON: ' + esc(err.message), 'danger'); }
      });
      ctx.on('click', '[data-fixschema]', () => {
        const n = selNode(); const iss = n && issuesOf(n.id).find((x) => x.code === 'schema'); if (!iss || !iss.actual) return;
        n.input = iss.actual; changed(esc(n.title) + ' now accepts what arrives. Ports match.');
      });
      ctx.on('click', '[data-unlink]', (e, t) => { const n = selNode(); if (!n) return; st.draft.edges = st.draft.edges.filter((x) => !(x.from === n.id && x.to === t.dataset.unlink)); changed('Edge removed.'); });
      ctx.on('click', '[data-flip]', (e, t) => { const n = selNode(); const ed = n && st.draft.edges.find((x) => x.from === n.id && x.to === t.dataset.flip); if (!ed) return; ed.branch = ed.branch === 'true' ? 'false' : 'true'; changed(); });
      ctx.on('click', '[data-nudge]', (e, t) => {
        if (!editable) return;
        const n = st.draft.nodes.find((x) => x.id === st.sel); if (!n) return;
        const d = t.dataset.nudge.split(',').map(Number);
        n.x = Math.max(0, (n.x || 0) + d[0]); n.y = Math.max(0, (n.y || 0) + d[1]); st.unsaved = true; ctx.rerender();
      });
      ctx.on('click', '[data-connect]', () => { st.connectFrom = st.connectFrom === st.sel ? null : st.sel; ctx.rerender(); });
      ctx.on('click', '[data-cancelconnect]', () => { st.connectFrom = null; ctx.rerender(); });
      ctx.on('click', '[data-dismisskbd]', () => { st.kbd = false; ctx.rerender(); });
      ctx.on('click', '[data-issue]', (e, t) => { e.preventDefault(); if (t.dataset.issue) { st.sel = t.dataset.issue; ctx.rerender(); } });
      ctx.on('click', '[data-limits]', () => {
        ctx.modal({ title: 'Workflow limits', body: '<div class="formgrid">' + UI.field('Token budget per run', UI.input(st.draft.limits.tokens != null ? st.draft.limits.tokens : '', { type: 'number', placeholder: String(L.maxTokens), attrs: 'data-tok' }), 'Up to ' + L.maxTokens.toLocaleString()) + UI.field('Run timeout', UI.input(st.draft.limits.timeoutMs != null ? Math.round(st.draft.limits.timeoutMs / 60000) : '', { type: 'number', placeholder: String(L.maxRunTimeoutMs / 60000), attrs: 'data-to' }), 'Minutes, up to ' + L.maxRunTimeoutMs / 60000) + '</div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Apply to the draft', { kind: 'primary', attrs: 'data-go' }),
          onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { const tok = m.querySelector('[data-tok]').value.trim(); const to = m.querySelector('[data-to]').value.trim(); const lim = {}; if (tok) lim.tokens = Math.round(Number(tok)); if (to) lim.timeoutMs = Math.round(Number(to) * 60000); st.draft.limits = lim; App.closeOverlay(); changed('Limits updated on the draft.'); }); } });
      });
      ctx.on('click', '[data-run]', (e, t) => { st.runId = t.dataset.run; st.run = null; st.runError = null; st.connectFrom = null; ctx.rerender(); });
      ctx.on('click', '[data-closerun]', () => { st.runId = null; st.run = null; st.runError = null; ctx.rerender(); });
      ctx.on('click', '[data-pending]', (e) => { e.preventDefault(); const a = approvalsHere[0]; if (a) { st.runId = a.runId; st.run = null; ctx.rerender(); } });
      ctx.on('click', '[data-goruns]', () => ctx.navigate('runs'));
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', '[data-reloaddraft]', () => { st.conflict = null; st.draft = null; st.wf = null; ctx.rerender(); });
      ctx.on('change', '[data-wf]', async (e, t) => {
        if (t.value === '__new') { t.value = wf.id; newWorkflow(); return; }
        if (st.unsaved) { const ok = await ctx.confirm({ title: 'Discard unsaved changes', tag: 'draft', tone: 'warn', body: '<p class="fg2" style="margin:0">The changes to ' + esc(wf.name) + ' are not saved. Open the other workflow anyway?</p>', ok: 'Discard and open' }); if (!ok) { t.value = wf.id; return; } }
        st.wfId = t.value; st.wf = null; st.draft = null; st.runId = null; st.run = null; st.problem = null; st.conflict = null; st.connectFrom = null; st.unsaved = false; ctx.rerender();
      });
      ctx.on('click', '[data-versions]', () => {
        const diff = (g) => {
          const a = new Map(g.nodes.map((n) => [n.id, n])); const b = new Map(st.draft.nodes.map((n) => [n.id, n]));
          const added = st.draft.nodes.filter((n) => !a.has(n.id)).map((n) => n.title); const removed = g.nodes.filter((n) => !b.has(n.id)).map((n) => n.title);
          const edited = st.draft.nodes.filter((n) => a.has(n.id) && JSON.stringify(Object.assign({}, a.get(n.id), { x: 0, y: 0 })) !== JSON.stringify(Object.assign({}, n, { x: 0, y: 0 }))).map((n) => n.title);
          const ek = (e) => e.from + '>' + e.to + (e.branch || ''); const ea = g.edges.map(ek), eb = st.draft.edges.map(ek);
          const edges = eb.filter((k) => ea.indexOf(k) < 0).length + ea.filter((k) => eb.indexOf(k) < 0).length;
          const parts = [];
          if (added.length) parts.push('adds ' + added.join(', ')); if (removed.length) parts.push('removes ' + removed.join(', ')); if (edited.length) parts.push('changes ' + edited.join(', ')); if (edges) parts.push(edges + ' edge' + (edges === 1 ? '' : 's') + ' differ');
          return parts.length ? 'The draft ' + parts.join('; ') + '.' : 'The draft matches this version, apart from where steps sit on the canvas.';
        };
        const rows = [['draft', UI.pill(st.unsaved ? 'unsaved' : 'draft', st.unsaved ? 'warn' : ''), 'revision ' + wf.draftRev, esc(when(wf.updatedAt)), '']].concat(wf.versions.map((x) => ['v' + x.version, UI.pill(x.state, x.state === 'published' ? 'ok' : 'warn'), esc(x.note || ''), esc(when(x.publishedAt)), UI.btn('Diff against the draft', { size: 'sm', attrs: 'data-diffv="' + x.version + '"' })]));
        ctx.modal({ cls: 'wide', title: 'Versions of ' + esc(wf.name), body: UI.table(['Version', 'State', 'Note', 'Changed', ''], rows, { clickable: false, minWidth: '0' }) + '<div data-diffout></div>' + UI.notice('Runs pin the version they started on. Publishing a new version does not change runs in progress.', 'info'),
          actions: (manage ? UI.btn('Delete workflow', { kind: 'danger', attrs: 'data-delwf' }) : '') + UI.btn('Close', { attrs: 'data-close' }),
          onMount(m) {
            m.querySelectorAll('[data-diffv]').forEach((b) => b.addEventListener('click', () => { const x = wf.versions.find((y) => String(y.version) === b.dataset.diffv); m.querySelector('[data-diffout]').innerHTML = UI.notice('<b>v' + esc(x.version) + ' against the draft.</b> ' + esc(diff(x.graph)), ''); }));
            const del = m.querySelector('[data-delwf]');
            if (del) del.addEventListener('click', async () => {
              App.closeOverlay();
              const ok = await ctx.confirm({ title: 'Delete ' + wf.name, tag: 'delete', tone: 'danger', body: '<p class="fg2" style="margin:0">The workflow, its versions and its run history are deleted. This is refused while a run is queued, running or waiting.</p>', ok: 'Delete workflow' });
              if (!ok) return;
              try { await App.del('/api/workflows/' + enc(wf.id)); st.list = list.filter((x) => x.id !== wf.id); st.wfId = null; st.wf = null; st.draft = null; st.runId = null; st.run = null; st.unsaved = false; ctx.rerender(); toast(esc(wf.name) + ' deleted. The audit log keeps the record.', 'ok'); } catch (err) { App.fail(err, 'Could not delete the workflow'); }
            });
          } });
      });
      ctx.on('click', '[data-gotool]', (e, t) => { e.preventDefault(); ctx.navigate('registry', { entry: t.dataset.gotool }); });
      ctx.on('click', '[data-pubtool]', () => {
        if (!wf.publishedVersion) return;
        const pv = wf.versions.find((x) => x.version === wf.publishedVersion);
        const tr = pv && pv.graph.nodes.find((x) => x.kind === 'trigger');
        const input = tr && tr.output;
        const mine = LABELS.filter((l) => LABELS.indexOf(l) >= LABELS.indexOf(wf.label) && (!App.me || LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance)));
        const prior = (wf.tools || [])[0];
        const bump = prior ? prior.version.replace(/^(\d+)\.(\d+)\..*$/, (m0, a, b) => a + '.' + (Number(b) + 1) + '.0') : '1.0.0';
        ctx.modal({ title: 'Publish ' + esc(wf.name) + ' v' + wf.publishedVersion + ' as a tool',
          body: '<p class="fg2" style="margin:0">Chat, agents and scripts can then call this version as a registry tool. The trigger\'s schema is the tool\'s input; a call starts a run as the caller and returns what the last steps produce, within 5 minutes.</p>'
            + (input && input.type === 'object' ? '' : UI.notice('The published trigger has no object output schema. Give the trigger one and publish again: it becomes the tool\'s input schema.', 'warn'))
            + '<div class="formgrid">' + UI.field('Tool name', UI.input(prior ? prior.name : 'workflow.' + wf.name, { attrs: 'data-tname' }), 'Letters, digits and . _ : -') + UI.field('Version', UI.input(bump, { attrs: 'data-tver' }), 'Semantic version') + '</div>'
            + UI.field('Description', UI.textarea(wf.description || '', { rows: 3, placeholder: 'What it does, when to use it and what it returns', attrs: 'data-tdesc' }), 'At least 40 characters: models choose tools by it')
            + '<div class="formgrid">' + UI.field('Side effect', UI.select([{ value: '', label: 'as the steps imply' }, 'read', 'write', 'destructive'], '', 'data-tside'), 'Never below what the steps do') + UI.field('Max label', UI.select(mine, wf.label, 'data-tlabel'), 'The highest data it may receive') + '</div>'
            + UI.kv([['Input', '<span class="mono">' + esc(fmtSchema(input)) + '</span>'], ['Pinned to', 'v' + wf.publishedVersion]], 2)
            + UI.notice('It goes to review: the registry\'s checks run, and a tool admin other than you approves it on the Registry screen before anything can call it.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Submit for review', { kind: 'primary', attrs: 'data-go' }),
          onMount(m) {
            m.querySelector('[data-go]').addEventListener('click', async (ev) => {
              const body = { name: m.querySelector('[data-tname]').value.trim(), version: m.querySelector('[data-tver]').value.trim(), description: m.querySelector('[data-tdesc]').value.trim() || null, label: m.querySelector('[data-tlabel]').value };
              const side = m.querySelector('[data-tside]').value; if (side) body.sideEffect = side;
              ev.target.disabled = true;
              try {
                const e = await App.post('/api/workflows/' + enc(wf.id) + '/tool', body);
                App.closeOverlay();
                toast(esc(e.name) + ' ' + esc(e.version) + ' passed its checks and is in review. A tool admin approves it on the Registry screen.', 'ok', 6000);
                loadWorkflow(wf.id, true);
              } catch (err) { ev.target.disabled = false; App.fail(err, 'Could not publish as a tool'); }
            });
          } });
      });
      ctx.on('click', '[data-dryrun]', () => openRunModal(true));
      ctx.on('click', '[data-startrun]', () => openRunModal(false));
      ctx.on('click', '[data-save]', () => save(false));
      ctx.on('click', '[data-approve]', (e, t) => decide(t.dataset.approve, true));
      ctx.on('click', '[data-reject]', (e, t) => decide(t.dataset.reject, false));
      ctx.on('click', '[data-cancelrun]', async () => {
        if (!run) return;
        const ok = await ctx.confirm({ title: 'Cancel run ' + shortId(run.id), tag: 'cancel', tone: 'danger', body: '<p class="fg2" style="margin:0">The run stops after the step in progress. Completed checkpoints are kept, so you can replay from any of them.</p>', ok: 'Cancel run', cancel: 'Keep it' });
        if (!ok) return;
        try { await App.post('/api/workflow-runs/' + enc(run.id) + '/cancel'); toast('Run cancelled.'); loadRun(run.id); loadRuns(); } catch (err) { App.fail(err, 'Could not cancel the run'); }
      });
      ctx.on('click', '[data-replay]', () => { if (!run) return; const s = ctx.$('[data-replaystep]'); if (s) replay(run.id, s.value); });
      ctx.on('click', '[data-replaystepbtn]', () => {
        const n = sel; if (!n) return;
        const r = runs.find((x) => !ACTIVE[x.state] && x.steps && x.steps[n.id]);
        if (!r) { toast('No finished run has reached ' + esc(n.title) + ' yet. Dry run the draft or start a run first.', 'warn', 6000); return; }
        replay(r.id, n.id);
      });
      ctx.on('click', '[data-stepout]', (e, t) => {
        e.preventDefault(); if (!run) return;
        const n = byId(t.dataset.stepout); const s = run.steps.find((x) => x.nodeId === t.dataset.stepout);
        ctx.drawer({ title: esc(n ? n.title : t.dataset.stepout) + ' ' + statusPill(status[t.dataset.stepout] || 'not started'), body: UI.kv([['Step', '<span class="mono">' + esc(t.dataset.stepout) + '</span>'], ['Kind', esc(n ? n.kind : '')], ['Label', s ? UI.label(s.label, { sm: true }) : '—'], ['Attempts', s ? String(s.attempts) : '0'], ['Started', s ? esc(when(s.startedAt)) : '—'], ['Finished', s ? esc(when(s.finishedAt)) : '—']], 2)
          + (s && s.error ? UI.notice(esc(s.error), 'danger') : '')
          + '<div class="eyebrow">Output checkpoint</div>' + (s && s.output != null ? UI.code(json(s.output).slice(0, 20000), 'json') : '<div class="muted" style="font-size:12px">No output is stored for this step' + (s ? ' in its ' + esc(s.state) + ' state' : '') + '.</div>')
          + (s && s.detail && Object.keys(s.detail).length ? '<div class="eyebrow">Detail</div>' + UI.code(json(s.detail), 'json') : ''),
          actions: UI.btn('Close', { attrs: 'data-close' }) });
      });
      ctx.on('click', '[data-publish]', async () => {
        if (st.unsaved && !(await save(true))) return;
        const cur = st.wf;
        const vv = st.validation || cur.validation;
        // A draft with problems goes straight to the server, which refuses it and names the step.
        const ok = vv.errors.length > 0 || await ctx.confirm({ title: 'Publish ' + cur.name + ' v' + ((cur.versions[0] ? cur.versions[0].version : 0) + 1), tag: 'publish', tone: 'info', body: '<p class="fg2" style="margin:0">Publishing checks the graph is acyclic, every port matches, labels stay within ceilings, and limits hold. New runs start on the new version; runs in progress stay on theirs.</p>', kv: [['Steps', String(cur.draft.nodes.length)], ['Trigger', esc(trigger ? subOf(trigger) : 'none')], ['Label', UI.label(cur.label, { sm: true })], ['Checks', vv.errors.length ? '<span style="color:var(--danger-fg)">' + vv.errors.length + ' problem' + (vv.errors.length === 1 ? '' : 's') + '</span>' : vv.warnings.length ? vv.warnings.length + ' warning' + (vv.warnings.length === 1 ? '' : 's') + ': ' + esc(vv.warnings[0].message) : 'none']], ok: 'Publish' });
        if (!ok) return;
        try {
          const out = await App.post('/api/workflows/' + enc(cur.id) + '/publish', { note: null });
          st.wf = out.workflow; st.draft = clone(out.workflow.draft); st.validation = out.workflow.validation; st.problem = null;
          const i = list.findIndex((x) => x.id === cur.id); if (i >= 0) list[i] = Object.assign({}, list[i], { publishedVersion: out.version });
          ctx.rerender(); toast(esc(cur.name) + ' v' + out.version + ' published. New runs start on v' + out.version + '; runs in progress stay on their version.', 'ok', 5000);
        } catch (err) {
          const p = err.problem || {};
          if (err.status === 422) {
            const first = (p.errors || [])[0];
            st.problem = { title: first && first.code === 'cycle' ? 'Cycle rejected' : first && first.code === 'schema' ? 'Schema mismatch' : 'Publishing refused', detail: p.detail || err.message, trace: p.trace_id, errors: p.errors || [] };
            if (p.errors) st.validation = { ok: false, errors: p.errors, warnings: p.warnings || [], labels: (st.validation || {}).labels || {} };
            if (first && first.nodeId) st.sel = first.nodeId;
            ctx.rerender(); toast('Publish refused: ' + esc(first ? first.message : p.detail), 'danger', 6000);
          } else App.fail(err, 'Could not publish');
        }
      });
      ctx.on('keydown', '.wf-canvas', (e) => {
        const ns = nodes; const s = ns.find((x) => x.id === st.sel) || ns[0]; if (!s) return;
        const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
        const refocus = () => { const c = ctx.$('.wf-canvas'); if (c) c.focus(); };
        if (dir) {
          e.preventDefault(); let best = null, bd = 1e9;
          ns.forEach((n) => { if (n.id === s.id) return; const dx = n.x - s.x, dy = n.y - s.y; const along = dx * dir[0] + dy * dir[1]; if (along <= 0) return; const off = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]); const d = along + off * 2; if (d < bd) { bd = d; best = n; } });
          if (best) { if (st.connectFrom && e.shiftKey && editable) { const from = st.connectFrom; st.connectFrom = null; st.sel = best.id; addEdge(from, best.id); refocus(); return; } st.sel = best.id; ctx.rerender(); refocus(); }
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); const f = ctx.$('.inspector input:not([disabled]), .inspector select:not([disabled]), .inspector textarea:not([disabled]), .inspector button'); if (f) f.focus(); return; }
        if ((e.key === 'c' || e.key === 'C') && editable) { e.preventDefault(); st.connectFrom = st.connectFrom ? null : s.id; ctx.rerender(); refocus(); return; }
        if (e.key === 'Escape') { st.connectFrom = null; ctx.rerender(); refocus(); return; }
        if ((e.key === 'Delete' || e.key === 'Backspace') && editable) { e.preventDefault(); removeSel(); }
      });
      if (st.autoRun) { st.autoRun = false; if (manage) setTimeout(() => openRunModal(true), 50); }
    }
  });
})();
