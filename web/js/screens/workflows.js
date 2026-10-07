(function () {
  // Workflows, backed by /api/workflows, /api/workflow-runs and /api/workflow-approvals. The canvas edits the draft
  // graph locally; every change is validated by the server (acyclic, port schemas along edges, label ceilings, limits)
  // and the problems point at the step. Save writes the draft (with the revision it was loaded at), Publish makes it
  // the next version. Runs execute on the server as checkpointed jobs; their steps arrive over the socket
  // (workflow.run, workflow.step) and paint the canvas of the version the run is pinned to.
  // Sprint 32e (B-3910): every step kind the server has (record, notify, webhook, sub, agent, map, loop; skills on model
  // steps, approval forms, vault references), event and schedule triggers, retries and failure edges, and the tabs of
  // the board: run history, triggers and callers (/workflows/:id/triggers, /workflows/:id/callers), versions with
  // bundles (/workflows/:id/bundle, /workflows/import), approvals waiting on me, and dead letters with redrive.
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
  // kind: palette label, worker class (the dot). The two palette groups follow the board; the board's remaining
  // proposals (skill step, script, media preset, query, plugin action) are not offered: the server has no such kinds.
  const KINDS = { trigger: ['Trigger', 'control'], model: ['Model call', 'Thinking'], transform: ['Transform', 'Doing'], branch: ['Branch', 'control'], guardrail: ['Guardrail check', 'control'], approval: ['Approval', 'control'], http: ['HTTP call', 'Doing'], calc: ['Calculate', 'Calculating'], wait: ['Wait', 'control'], tool: ['Tool or MCP call', 'Doing'], record: ['Record', 'Doing'], notify: ['Notify', 'Doing'], webhook: ['Webhook', 'Doing'], sub: ['Sub-workflow', 'Doing'], agent: ['Agent run', 'Thinking'], map: ['Map (fan-out)', 'control'], loop: ['Loop (bounded)', 'control'] };
  const PALETTE = ['model', 'transform', 'branch', 'guardrail', 'approval', 'http', 'calc', 'wait', 'tool', 'record', 'notify', 'webhook'].map((k) => [k, KINDS[k][0], KINDS[k][1]]);
  const PALETTE_WF2 = ['sub', 'agent', 'map', 'loop'].map((k) => [k, KINDS[k][0], KINDS[k][1]]);
  const CLS = Object.fromEntries(Object.keys(KINDS).map((k) => [k, KINDS[k][1]]));
  // Kinds a retry policy makes no sense for (server/src/workflows/retry.ts), and kinds that write.
  const NO_RETRY = { trigger: 1, approval: 1, wait: 1, branch: 1, sub: 1, agent: 1, map: 1, loop: 1 };
  const WRITES = { record: 1, notify: 1, webhook: 1 };
  const host = (u) => String(u || '').replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  /** `Bearer vault:apps/erp#token` as its parts, for the vault reference editor. */
  function vaultParts(v) {
    const m = /^((Bearer|Basic|Token) )?vault:([^#\s]+)#(\S+)$/.exec(v || '');
    return m ? { scheme: m[2] || 'raw', path: m[3], key: m[4] } : { scheme: v ? 'literal' : 'none', path: '', key: '' };
  }
  const authOf = (c) => { const h = c.headers || {}; const k = Object.keys(h).find((x) => x.toLowerCase() === 'authorization'); return k ? h[k] : ''; };
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
      case 'trigger': return c.source === 'api' ? 'API or console' : c.source === 'event' ? 'event ' + (c.event || 'not set') : c.source === 'schedule' ? (c.cron ? 'cron ' + c.cron + ' UTC' : 'an app\'s schedule trigger') : c.source === 'record' ? 'an app\'s record trigger' : 'manual from the console';
      case 'model': return 'profile ' + (c.profile || 'not set') + (c.skills && c.skills.length ? ' + skill ' + c.skills.join(', ') : c.format === 'json' ? ', JSON schema' : ', text');
      case 'transform': return 'fields ' + Object.keys(c.fields || {}).join(', ');
      case 'branch': return c.left + ' ' + c.op + (c.right != null && c.op !== 'truthy' && c.op !== 'exists' ? ' ' + c.right : '');
      case 'guardrail': return 'checkpoint ' + (c.checkpoint || 'context');
      case 'approval': return 'role: ' + (c.role || 'not set');
      case 'http': return (c.method || 'GET') + ' ' + String(c.url || '').replace(/^https?:\/\//, '');
      case 'calc': return 'calc ' + (c.expression || '');
      case 'wait': return 'timer ' + dur(c.ms || 0);
      case 'tool': return (c.tool || 'no tool') + (c.args && typeof c.args === 'object' ? ', ' + Object.keys(c.args).length + ' arguments' : '');
      case 'record': return (c.action || 'create') + ' ' + (c.entity || 'entity not set') + (c.action === 'transition' && c.to ? ' → ' + c.to : '');
      case 'notify': return 'notify ' + ((c.users || []).concat((c.roles || []).map((r) => 'role ' + r)).join(', ') || 'nobody yet') + (c.email ? ', email' : '');
      case 'webhook': return 'signed POST ' + (host(c.url) || 'no endpoint');
      case 'sub': return 'workflow ' + (c.workflow || 'not set') + (c.version ? ' v' + c.version : '');
      case 'agent': return 'agent ' + (c.agent || 'not set') + ', awaited';
      case 'map': return 'map over ' + (c.over || '…') + ', ' + (c.maxParallel || 10) + ' at once';
      case 'loop': return 'up to ' + (c.max || 5) + ' iterations' + (c.while ? ' while ' + c.while.left + ' ' + c.while.op : '');
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
      tool: { tool: (st.tools && st.tools[0] && st.tools[0].name) || '', approverRole: 'workflow-admin' },
      record: { action: 'create', app: (st.apps && st.apps[0] && st.apps[0].name) || '', entity: '', values: {} },
      notify: { users: [], roles: ['workflow-admin'], title: 'A workflow run needs a look', body: '', email: false },
      webhook: { url: 'https://hooks.internal/workflows', event: 'workflow.webhook' },
      sub: { workflow: ((st.callees && st.callees.workflows || []).find((w) => !st.wf || w.id !== st.wf.id) || {}).name || '' },
      agent: { agent: ((st.callees && st.callees.agents || [])[0] || {}).name || '' },
      map: { over: '{{input.items}}', profile, prompt: 'Summarise {{item}} in one sentence.', maxParallel: 10, maxItems: 200, as: 'results' },
      loop: { profile, prompt: 'Improve this draft: {{last}}', max: 5 }
    }[kind] || {};
  }

  // ---------- data ----------
  function loadList() {
    const st = S();
    const opt = (perm, url, pick) => (App.can(perm) ? App.get(url).then(pick || ((x) => x)).catch(() => null) : Promise.resolve(null));
    return Promise.all([App.get('/api/workflows'), App.get('/api/workflow-approvals'), App.can('chat:read') ? App.get('/api/chat/profiles').catch(() => []) : Promise.resolve([]), App.get('/api/workflow-tools').catch(() => []),
      App.get('/api/workflow-callees').catch(() => null), opt('records:read', '/api/apps', (x) => x.apps), opt('secrets:read', '/api/vault/kv', (x) => x.secrets), opt(['workflows:manage', 'webhooks:manage', 'plugins:manage'], '/api/events/catalogue')])
      .then(([list, approvals, profiles, tools, callees, apps, vault, catalogue]) => { Object.assign(st, { list, approvals, profiles, tools, callees: callees || { workflows: [], agents: [], skills: [], limits: {} }, apps, vault, catalogue, appDetail: st.appDetail || {}, loaded: true, loadError: null }); });
  }
  /** An app's entities and forms, for the record step and approval forms (fetched once per app). */
  function loadApp(ref) {
    const st = S(); st.appDetail = st.appDetail || {};
    if (!ref || st.appDetail[ref] || !App.can('records:read')) return;
    const app = (st.apps || []).find((a) => a.id === ref || a.name === ref);
    if (!app) return;
    st.appDetail[ref] = { loading: true };
    App.get('/api/apps/' + enc(app.id)).then((d) => { st.appDetail[ref] = d; st.appDetail[app.id] = d; st.appDetail[app.name] = d; schedule(); }).catch(() => { st.appDetail[ref] = { failed: true }; schedule(); });
  }
  /** What the lower tabs show: the own trigger and callers, and dead letters (workflow admins). */
  function loadTab(tab) {
    const st = S(); if (!st.wfId) return;
    const id = st.wfId;
    if (tab === 'callers') {
      Promise.all([App.get('/api/workflows/' + enc(id) + '/triggers?limit=20').catch(() => null), App.get('/api/workflows/' + enc(id) + '/callers').catch(() => null)])
        .then(([t, c]) => { if (st.wfId === id) { st.triggerView = t; st.callers = c; st.tabLoaded = 'callers:' + id; schedule(); } });
    } else if (tab === 'dead' && App.can('workflows:manage')) {
      App.get('/api/workflow-dead-letters?workflow=' + enc(id)).then((d) => { if (st.wfId === id) { st.dead = d.items; st.tabLoaded = 'dead:' + id; schedule(); } }).catch(() => { st.dead = []; st.tabLoaded = 'dead:' + id; schedule(); });
    } else st.tabLoaded = tab + ':' + id;
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
        if (!ACTIVE[d.state]) { loadRuns(); st.tabLoaded = null; st.tabLoading = null; }
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
    id: 'workflows', title: 'Workflows', live: true, summary: 'Graph editor on every server step kind, typed ports, event and schedule triggers, callers, retries and failure edges, versions and bundles, run history, replay, approvals, dead letters',
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
      { title: 'Failed run in the dead letters', tone: 'warn', text: 'A run that fails for good after its retries, with no on-failure edge to take, is a dead letter; a workflow admin redrives it from the failed step.', apply(ctx) {
        const st = ctx.state;
        if (!App.can('workflows:manage')) { ctx.toast('<span>Dead letters are for workflow admins (workflows:manage).</span>', '', 7000); return; }
        st.tab = 'dead'; st.tabLoaded = null; st.tabLoading = null; st.runId = null; st.run = null; ctx.rerender();
      } },
      { title: 'Vault reference refused at save (403)', tone: 'danger', text: 'An HTTP step whose Authorization names a secret the saver cannot read is refused at save with step vault-policy; a literal credential is refused with 400.', apply(ctx) {
        const st = ctx.state; const n = st.draft && st.draft.nodes.find((x) => x.kind === 'http');
        if (n) { st.runId = null; st.run = null; st.sel = n.id; ctx.rerender(); }
        ctx.toast('<span>Authorization takes a vault reference (vault:path#key, optionally after Bearer, Basic or Token). Saving checks that you may read the secret; a secret you cannot read is refused with 403, a literal credential with 400.</span>', '', 8000);
      } },
      { title: 'Delete refused: still in use', tone: 'danger', text: 'Deleting a workflow a published agent lists, or another published workflow runs, is refused (409 Still in use). The used-by view names every agent, workflow tool and workflow step that references it.', apply(ctx) {
        const st = ctx.state;
        if (!App.can('workflows:manage')) { ctx.toast('<span>Deleting workflows is for workflow admins (workflows:manage).</span>', '', 7000); return; }
        st.openUsedBy = 'delete-blocked'; ctx.rerender();
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
        return Object.assign({}, e, { label: iss ? (iss.code === 'cycle' ? 'cycle' : iss.code === 'schema' ? 'schema mismatch' : iss.code) : e.branch === 'failure' ? 'on failure' : e.branch || '', tone: iss ? 'danger' : e.branch === 'failure' ? 'warn' : '', dashed: !!iss || skipped || e.branch === 'false', dotted: !iss && e.branch === 'failure', cycle: iss && iss.code === 'cycle' && byId(e.to).y <= byId(e.from).y });
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
        + edges.map((e) => '<path d="' + path(e) + '" fill="none" stroke="' + (e.tone === 'danger' ? 'var(--danger-fg)' : e.tone === 'warn' ? 'var(--warn-fg)' : 'var(--meter)') + '" stroke-width="' + (e.tone === 'danger' ? 2 : 1.5) + '"' + (e.dotted ? ' stroke-dasharray="2 3"' : e.dashed ? ' stroke-dasharray="4 4"' : '') + ' marker-end="url(#' + (e.tone === 'danger' ? 'wf-arrow-d' : 'wf-arrow') + ')"></path>').join('')
        + edges.filter((e) => e.label).map((e) => { const p = labelPos(e); return '<text x="' + p[0] + '" y="' + p[1] + '" font-size="10" font-weight="600" fill="' + (e.tone === 'danger' ? 'var(--danger-fg)' : e.tone === 'warn' ? 'var(--warn-fg)' : 'var(--muted)') + '" font-family="inherit">' + esc(e.label) + '</text>'; }).join('') + '</svg>';
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
        return UI.panel('Waiting on approval', UI.kv([['Step', esc(stepTitle)], ['Who must approve', 'anyone with the <b>' + esc(a.role) + '</b> role' + (run && run.mode === 'dry' ? ', or you: it is your dry run' : '')], ['Waiting since', esc(when(a.createdAt))], ['Times out', esc(when(a.dueAt)) + ', then the run fails'], ['Data they will see', UI.ctx('shown to the approver', shown || '(nothing configured)', run ? run.label : wf.label)]].concat(a.form ? [['Form', esc(a.form.title || a.form.form) + ' (' + esc(a.form.app) + '), ' + (a.form.fields || []).length + ' fields']] : []).concat(a.answers ? [['Answers', '<span class="mono">' + esc(JSON.stringify(a.answers)) + '</span>']] : []), 1)
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
            if (s.state === 'waiting' && d.retryAt) return 'retry ' + esc(d.retries || 1) + ' at ' + esc(when(d.retryAt)) + (d.lastError ? ' after: ' + esc(d.lastError) : '');
            if (s.state === 'waiting' && (n.kind === 'sub' || n.kind === 'agent' || n.kind === 'map' || n.kind === 'loop')) return 'waiting on ' + (run.children || []).filter((k) => k.step === n.id && ACTIVE[k.state]).length + ' child run(s)';
            if (s.state === 'waiting') return n.kind === 'wait' ? 'waiting until ' + esc(when(s.resumeAt || d.resumeAt)) : 'waiting on ' + esc((pending.find((a) => a.nodeId === n.id) || {}).role || 'an approver');
            if (d.mocked) return 'mocked in the dry run';
            if (n.kind === 'model') return (d.tokens != null ? d.tokens.toLocaleString() + ' tokens, ' : '') + dur(d.ms || 0) + (d.model ? ', ' + esc(d.model) : '');
            if (n.kind === 'calc') return d.exact ? 'exact' : 'rounded';
            if (n.kind === 'http') return 'HTTP ' + esc(d.status);
            if (n.kind === 'branch') return 'condition ' + (d.result ? 'true' : 'false');
            if (n.kind === 'guardrail') return 'guardrails: ' + esc(d.action || 'allow');
            if (n.kind === 'tool') return esc(d.tool || 'tool') + ' ' + esc(d.version || '') + (d.approvedBy ? ', approved at ' + esc(d.approvedBy) : '') + (d.toolMs != null ? ', ' + dur(d.toolMs) : '') + (d.warning ? ', ' + esc(d.warning) : '');
            if (n.kind === 'approval' && d.approvedBy) return 'approved';
            const o = s.output && typeof s.output === 'object' ? s.output : {};
            if (n.kind === 'notify' && o.notified != null) return o.notified + ' told, ' + (o.skipped || 0) + ' skipped';
            if (n.kind === 'webhook' && o.delivery) return 'delivery ' + esc(String(o.delivery).slice(-6)) + ' queued';
            if (n.kind === 'record' && o.id) return 'record ' + esc(String(o.id).slice(-6)) + (o.state ? ', ' + esc(o.state) : '');
            if (n.kind === 'sub' && o.run) return 'child run ' + esc(shortId(o.run)) + ' finished';
            if (n.kind === 'agent' && o.run) return 'agent run ' + esc(String(o.run).slice(-6)) + ' finished';
            if (n.kind === 'map' && o.count != null) return o.count + ' items';
            if (n.kind === 'loop' && o.iterations != null) return o.iterations + ' iterations, stopped at ' + esc(o.stopped || 'max');
            if (n.kind === 'model' && Array.isArray(d.toolCalls) && d.toolCalls.length) return (d.tokens != null ? d.tokens.toLocaleString() + ' tokens, ' : '') + d.toolCalls.length + ' tool call(s) through ' + esc((d.skills || []).join(', '));
            if (s.detail && s.detail.failedEdge) return 'failed; took the on-failure edge';
            return s.state + (d.ms != null ? ', ' + dur(d.ms) : '');
          };
          const replayable = nodes.filter((n) => n.kind !== 'trigger' && stepOf(n.id));
          insp = '<div class="hstack"><div class="eyebrow grow">Run: ' + esc(shortId(run.id)) + '</div>' + UI.iconbtn('x', 'Back to the draft', { cls: 'sm ghost', attrs: 'data-closerun' }) + '</div>'
            + '<div class="hstack wrap gap6">' + runPill(rs) + UI.label(run.label, { sm: true }) + (run.mode === 'dry' ? UI.pill('dry run', 'outline') : UI.pill('v' + run.version, 'outline')) + '</div>'
            + UI.kv([['Trigger', esc(trig)], ['Started', esc(when(run.startedAt || run.createdAt))], ['Duration', run.startedAt ? dur((run.finishedAt || Date.now()) - run.startedAt) + (run.finishedAt ? '' : ' so far') : 'queued'], ['Runs as', 'delegated from ' + esc(run.createdByName || 'the person who started it')], ['Engine', 'job queue, ' + run.steps.filter((s) => s.state === 'passed').length + ' checkpoints'], ['Tokens', (run.tokens || 0).toLocaleString()]], 1)
            + (run.error && !pending.length ? UI.notice(esc(run.error), run.state === 'cancelled' ? 'warn' : 'danger') : '')
            + (run.caller || run.chain || (run.children || []).length || (run.items || []).length ? '<div class="eyebrow">Chain</div>' + UI.kv([].concat(run.caller ? [['Called by', run.caller.kind === 'workflow-run' ? '<a href="#" data-openwfrun="' + esc(run.caller.id) + '">workflow run ' + esc(shortId(run.caller.id)) + '</a>' + (run.caller.node ? ', step ' + esc(run.caller.node) : '') : run.caller.kind === 'agent-run' ? '<a href="#" data-goagentrun="' + esc(run.caller.id) + '">agent run ' + esc(String(run.caller.id).slice(-6)) + '</a>' : esc(run.caller.kind + ' ' + run.caller.id)]] : [])
              .concat(run.chain ? [['Chain', '<span class="mono">' + esc(String(run.chain.id).slice(-8)) + '</span>' + (run.caller ? '' : ', the root') + ' ' + UI.btn('Chain tree', { size: 'xs', kind: 'ghost', icon: 'branch', attrs: 'data-gochain="' + esc(run.chain.id) + '" data-chainnode="' + esc(run.chain.node || '') + '"' })]] : [])
              .concat((run.children || []).map((k) => [esc((byId(k.step) || {}).title || k.step || 'child'), (k.kind === 'workflow-run' ? '<a href="#" data-openwfrun="' + esc(k.id) + '">workflow run ' + esc(shortId(k.id)) + '</a>' : '<a href="#" data-goagentrun="' + esc(k.id) + '">agent ' + esc(k.agent || '') + '</a>') + ' ' + runPill(k.state) + (k.error ? ' <span class="muted">' + esc(k.error) + '</span>' : '')]))
              .concat(Object.keys((run.items || []).reduce((m, i) => { m[i.nodeId] = 1; return m; }, {})).map((id) => { const its = run.items.filter((i) => i.nodeId === id); const ok = its.filter((i) => i.state === 'passed').length; const bad = its.find((i) => i.state === 'failed'); return [esc((byId(id) || {}).title || id), ok + ' of ' + its.length + ' items passed' + (bad ? ', item ' + bad.index + ' failed: ' + esc(bad.error || '') : '')]; })), 1) : '')
            + (run.held || []).filter((h) => h.at && h.at.run !== run.id).map((h) => UI.notice('<b>Held down the chain, depth ' + esc(String(h.path && h.path.length ? h.path[h.path.length - 1].depth : '')) + '.</b> <span class="mono">' + esc(h.tool || 'a call') + '</span> waits on ' + esc(h.approvers || 'an approver') + '; this run waits with it.<div class="wf-path" style="margin-top:6px;font-size:12px;overflow-wrap:anywhere">' + (h.path || []).map((x) => esc(x.name || x.kind)).join(' › ') + '</div>', 'info', UI.btn(h.canDecide ? 'Decide in the chain tree' : 'Open the chain tree', { size: 'sm', attrs: 'data-gochain="' + esc(run.chain ? run.chain.id : '') + '" data-chainnode="' + esc(h.node) + '"' }))).join('')
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
        const cat = st.catalogue;
        const eventOpts = cat ? (cat.groups || []).map((g) => ({ value: g.pattern, label: g.pattern + ' (group)' })).filter((g) => g.value !== '*').concat((cat.types || []).map((t) => ({ value: t.type, label: t.type + (t.status === 'reserved' ? ' (reserved)' : '') }))) : [];
        if (c.event && !eventOpts.some((o) => o.value === c.event)) eventOpts.unshift({ value: c.event, label: c.event });
        const action = (kind) => {
          // What a map runs for each item, or a loop each iteration: a model prompt, a registry tool or a workflow.
          const ak = c.tool != null ? 'tool' : c.workflow != null ? 'workflow' : 'model';
          const wfs = ((st.callees || {}).workflows || []).filter((w) => w.id !== wf.id).map((w) => ({ value: w.name, label: w.name + ' v' + w.version }));
          if (c.workflow && !wfs.some((w) => w.value === c.workflow)) wfs.unshift({ value: c.workflow, label: c.workflow + ' (not published here)' });
          const tls = (st.tools || []).map((x) => ({ value: x.name, label: x.name + ' · ' + x.sideEffect }));
          if (c.tool && !tls.some((x) => x.value === c.tool)) tls.unshift({ value: c.tool, label: c.tool + ' (not published here)' });
          return UI.field(kind === 'map' ? 'Each item runs' : 'Each iteration runs', UI.select([{ value: 'model', label: 'a model prompt' }, { value: 'tool', label: 'a registry tool' }, { value: 'workflow', label: 'a published workflow' }], ak, 'data-action' + ro))
            + (ak === 'model' ? '<div class="grid2" style="gap:10px">' + UI.field('Profile', profiles.length ? cfgSel('profile', profiles, c.profile) : cfgIn('profile', c.profile)) + UI.field('Answer', cfgSel('format', [{ value: 'text', label: 'text' }, { value: 'json', label: 'JSON' }], c.format || 'text')) + '</div>' + UI.field('Prompt', cfgTa('prompt', c.prompt, 3), kind === 'map' ? 'Reads {{item}} and {{index}}' : 'Reads {{iteration}}, {{last}} and {{results}}') : '')
            + (ak === 'tool' ? UI.field('Tool', cfgSel('tool', [{ value: '', label: 'choose a tool' }].concat(tls), c.tool || ''), 'A write tool needs an Approval step before this one on every path: items never pause one by one') + UI.field('Arguments', cfgTa('args', lines(c.args), 2, 'query: {{item}}'), 'One per line: name: template. Empty: ' + (kind === 'map' ? 'the item itself' : 'the step\'s input')) : '')
            + (ak === 'workflow' ? UI.field('Workflow', cfgSel('workflow', [{ value: '', label: 'choose a workflow' }].concat(wfs), c.workflow || ''), 'Runs as a child in this run\'s chain; default input ' + (kind === 'map' ? '{item, index}' : '{iteration, last, results}')) : '');
        };
        if (n.kind === 'trigger') fields = UI.field('Trigger', cfgSel('source', [{ value: 'manual', label: 'manual from the console' }, { value: 'api', label: 'API or console' }, { value: 'event', label: 'event from the catalogue' }, { value: 'schedule', label: 'schedule (UTC cron)' }, { value: 'record', label: 'record (an app\'s record trigger)' }], c.source || 'manual'), c.source === 'event' || c.source === 'schedule' ? 'Starts by itself once a version is published, as the person who published it' : c.source === 'record' ? 'An app\'s record trigger (Apps → Triggers) starts it with the record as the input' : 'Runs start from the console or POST /api/workflows/:id/runs')
          + (c.source === 'event' ? UI.field('Catalogue event', eventOpts.length ? cfgSel('event', [{ value: '', label: 'choose an event' }].concat(eventOpts), c.event || '') : cfgIn('event', c.event, { placeholder: 'file.uploaded' }), 'A type, or a group such as file.*. Only events naming this workflow\'s workspace and at or below its label start it; events of its own runs and chain never do.') : '')
          + (c.source === 'schedule' ? UI.field('Cron (UTC)', cfgIn('cron', c.cron, { placeholder: '0 6 * * 1' }), 'Five fields. Each due time is claimed once across instances. Leave it empty when an app\'s schedule trigger starts the workflow.') : '')
          + (c.source === 'record' ? '<div class="muted" style="font-size:12px">Record triggers live on the app: <a href="#" data-goapps>open Apps</a>. The run input is {event, app, entity, record, trigger}.</div>' : '');
        else if (n.kind === 'model') fields = UI.field('Profile', profiles.length ? cfgSel('profile', profiles, c.profile) : cfgIn('profile', c.profile), c.profile ? '<a href="#" data-goprofile="' + esc(c.profile) + '">Open profile</a>' : 'Published profiles only; the call goes through the gateway')
          + '<div class="grid2" style="gap:10px">' + UI.field('Think level', cfgSel('think', [{ value: '', label: 'profile default' }, 'off', 'low', 'medium', 'high'], c.think || '')) + UI.field('Answer', cfgSel('format', [{ value: 'text', label: 'text' }, { value: 'json', label: 'JSON (output schema)' }], c.format || 'text')) + '</div>'
          + UI.field('Prompt template', cfgTa('prompt', c.prompt, 4), 'Reads {{input.…}} and {{steps.&lt;id&gt;.…}} of earlier steps')
          + UI.field('Skills', (((st.callees || {}).skills || []).length || (c.skills || []).length ? '<div class="hstack wrap gap6">' + ((st.callees || {}).skills || []).map((k) => ({ name: k.name, sub: k.version })).concat((c.skills || []).filter((x) => !((st.callees || {}).skills || []).some((k) => k.name === x)).map((x) => ({ name: x, sub: 'not published here' }))).map((k) => { const on = (c.skills || []).indexOf(k.name) >= 0; return UI.chip(esc(k.name) + ' <span class="muted">' + esc(k.sub) + '</span>', on, 'data-skill="' + esc(k.name) + '"' + ro); }).join('') + '</div>' : '<div class="muted" style="font-size:12px">No skills are published to this workspace.</div>'), 'Up to 8. Their instructions join the system prompt and their tools are offered through the dispatcher; a write tool runs only after an Approval step on every path.');
        else if (n.kind === 'transform') fields = UI.field('Fields', cfgTa('fields', lines(c.fields), 3, 'summary: {{steps.summarise.text}}'), 'One per line: name: template');
        else if (n.kind === 'branch') fields = UI.field('Left', cfgIn('left', c.left)) + '<div class="grid2" style="gap:10px">' + UI.field('Operator', cfgSel('op', OPS, c.op)) + UI.field('Right', cfgIn('right', c.right, { placeholder: c.op === 'truthy' || c.op === 'exists' ? 'not used' : '' })) + '</div><div class="muted" style="font-size:12px">Edges out of a branch carry true or false; the other side is skipped.</div>';
        else if (n.kind === 'guardrail') fields = UI.field('Checkpoint', cfgSel('checkpoint', CHECKPOINTS, c.checkpoint || 'context')) + UI.field('Text to check', cfgTa('text', c.text, 2)) + UI.field('Approver when rules ask for one', cfgSel('approverRole', ROLES, c.approverRole || 'workflow-admin'), 'Block fails the step; redact passes the masked text on') + UI.field('Approval timeout', cfgIn('approvalTimeoutMs', Math.round((c.approvalTimeoutMs || 86400000) / 3600000), { type: 'number' }), 'Hours. The run fails if nobody decides in time');
        else if (n.kind === 'approval') {
          if (c.form) loadApp(c.form.app);
          const fa = c.form ? (st.appDetail || {})[c.form.app] : null;
          const apps = (st.apps || []).map((a) => ({ value: a.name, label: a.title || a.name }));
          if (c.form && !apps.some((a) => a.value === c.form.app)) apps.unshift({ value: c.form.app, label: c.form.app + ' (not visible to you)' });
          const forms = fa && fa.forms ? fa.forms.map((f) => ({ value: f.name, label: (f.title || f.name) + ' · ' + f.entity })) : [];
          if (c.form && c.form.form && !forms.some((f) => f.value === c.form.form)) forms.unshift({ value: c.form.form, label: c.form.form });
          fields = UI.field('Role', cfgSel('role', ROLES, c.role)) + UI.field('Timeout', cfgIn('timeoutMs', Math.round((c.timeoutMs || 86400000) / 3600000), { type: 'number' }), 'Hours. The run fails if nobody decides in time') + UI.field('Data the approver sees', cfgTa('show', c.show, 2, '{{steps.summarise.text}}'))
            + UI.field('Form the approver fills in', '<div class="grid2" style="gap:10px">' + UI.select([{ value: '', label: 'none: approve or reject' }].concat(apps), c.form ? c.form.app : '', 'data-formapp aria-label="App"' + ro) + (c.form ? UI.select([{ value: '', label: fa && fa.loading ? 'loading…' : 'choose a form' }].concat(forms), c.form.form || '', 'data-formname aria-label="Form"' + ro) : '') + '</div>', apps.length ? 'An app form: its answers, validated like a submission, become the output {…input, approved, by, answers}. Nothing is written to the app.' : 'Forms come from Apps; you need records:read to pick one.');
        }
        else if (n.kind === 'http') fields = '<div class="grid2" style="gap:10px;grid-template-columns:90px 1fr">' + UI.field('Method', cfgSel('method', ['GET', 'POST', 'PUT'], c.method || 'GET')) + UI.field('URL', cfgIn('url', c.url)) + '</div>' + UI.field('Body', cfgTa('body', c.body, 2)) + UI.field('Headers', cfgTa('headers', lines(Object.fromEntries(Object.keys(c.headers || {}).filter((k) => k.toLowerCase() !== 'authorization').map((k) => [k, c.headers[k]]))), 2, 'X-Request-Source: exprsn'), 'Content-Type, Accept and X- headers; Authorization below')
          + (() => {
            const a = vaultParts(authOf(c)); const vs = (st.vault || []).map((x) => ({ value: x.path, label: 'kv/' + x.path + ' · ' + x.label }));
            if (a.path && !vs.some((x) => x.value === a.path)) vs.unshift({ value: a.path, label: 'kv/' + a.path });
            return UI.field('Authorization from the vault', '<div class="grid2" style="gap:10px;grid-template-columns:100px 1fr">' + UI.select([{ value: 'none', label: 'none' }, 'Bearer', 'Basic', 'Token', { value: 'raw', label: 'as is' }], a.path ? a.scheme : 'none', 'data-vscheme aria-label="Scheme"' + ro) + (st.vault ? UI.select([{ value: '', label: 'choose a secret' }].concat(vs), a.path, 'data-vpath aria-label="Secret path"' + ro) : UI.input(a.path, { placeholder: 'apps/erp', attrs: 'data-vpath aria-label="Secret path"' + ro })) + '</div>' + UI.input(a.key, { placeholder: 'key, such as token', attrs: 'data-vkey aria-label="Key in the secret"' + ro }),
              (a.scheme === 'literal' ? '<span style="color:var(--danger-fg)">A literal credential is refused at save.</span> ' : '') + (authOf(c) ? 'Sent as <span class="mono">' + esc(authOf(c)) + '</span>, resolved when the step runs as the run\'s owner. ' : '') + 'Saving checks you may read the secret (403 vault-policy otherwise).' + (App.can('secrets:read') ? ' <a href="#" data-govault>Vault</a>' : ''));
          })()
          + '<div class="muted" style="font-size:12px">Internal hosts only: private addresses, never link-local or the internet. The host cannot come from a template.</div>';
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
        } else if (n.kind === 'record') {
          loadApp(c.app);
          const apps = (st.apps || []).map((a) => ({ value: a.name, label: a.title || a.name }));
          if (c.app && !apps.some((a) => a.value === c.app)) apps.unshift({ value: c.app, label: c.app + (st.apps ? ' (not visible to you)' : '') });
          const ad = (st.appDetail || {})[c.app];
          const ent = ad && ad.entities ? ad.entities.find((e) => e.name === c.entity || e.id === c.entity) : null;
          const ents = ad && ad.entities ? ad.entities.map((e) => ({ value: e.name, label: e.title || e.name })) : [];
          if (c.entity && !ents.some((e) => e.value === c.entity)) ents.unshift({ value: c.entity, label: c.entity });
          const states = ent && ent.definition && ent.definition.states ? ent.definition.states.states.map((x) => x.name) : [];
          const fieldNames = ent && ent.definition ? (ent.definition.fields || []).map((f) => f.name) : [];
          fields = '<div class="grid2" style="gap:10px">' + UI.field('Action', cfgSel('action', ['create', 'update', 'transition'], c.action || 'create')) + UI.field('App', apps.length ? cfgSel('app', [{ value: '', label: 'choose an app' }].concat(apps), c.app || '') : cfgIn('app', c.app, { placeholder: 'crm' })) + '</div>'
            + UI.field('Entity', ents.length ? cfgSel('entity', [{ value: '', label: 'choose an entity' }].concat(ents), c.entity || '') : cfgIn('entity', c.entity, { placeholder: ad && ad.loading ? 'loading…' : 'deal' }))
            + (c.action !== 'create' ? UI.field('Record', cfgIn('record', c.record, { placeholder: '{{input.record.id}}' }), 'A template giving the record id') : '')
            + (c.action === 'transition' ? UI.field('To state', states.length ? cfgSel('to', [{ value: '', label: 'choose a state' }].concat(states), c.to || '') : cfgIn('to', c.to, { placeholder: 'approved' }), 'Only a transition the entity lists; refused otherwise') : '')
            + UI.field('Values', cfgTa('values', lines(c.values), 3, (fieldNames[0] || 'title') + ': {{steps.summarise.text}}'), 'One per line: field: template.' + (fieldNames.length ? ' Fields: ' + esc(fieldNames.join(', ')) : ''))
            + '<div class="muted" style="font-size:12px">Writes as the run\'s owner (records:write). A new record is at least the run\'s label; writing a record below it blocks the step. Mocked in dry runs; never fires this workflow\'s own triggers.' + (App.can('records:read') ? ' <a href="#" data-goapps>Open Apps</a>' : '') + '</div>';
        } else if (n.kind === 'notify') {
          fields = UI.field('Users', cfgIn('users', (c.users || []).join(', '), { placeholder: '{{input.record.owner}}, mara.okafor' }), 'Comma-separated templates giving user ids or usernames')
            + UI.field('Roles', '<div class="hstack wrap gap6">' + ROLES.map((r) => UI.chip(esc(r), (c.roles || []).indexOf(r) >= 0, 'data-nrole="' + esc(r) + '"' + ro)).join('') + '</div>')
            + UI.field('Title', cfgIn('title', c.title)) + UI.field('Body', cfgTa('body', c.body, 2))
            + '<div class="grid2" style="gap:10px">' + UI.field('Email', cfgSel('email', [{ value: 'false', label: 'in-app only' }, { value: 'true', label: 'in-app and email' }], String(!!c.email))) + UI.field('Opens', cfgIn('route', c.route, { placeholder: 'workflows?run=…' }), 'Console route; the run by default') + '</div>'
            + '<div class="muted" style="font-size:12px">Only active users cleared for the step\'s label are told (members only, in a members-only workspace); the rest are skipped and counted. Output {notified, skipped}.</div>';
        } else if (n.kind === 'webhook') {
          fields = UI.field('Endpoint', cfgIn('url', c.url, { placeholder: 'https://hooks.internal/workflows' }), 'Fixed, no templates. Refused at save when the operator\'s or the tenant\'s outbound host rules do not allow it.')
            + UI.field('Event type', cfgIn('event', c.event || 'workflow.webhook'), 'Under workflow., such as workflow.vendor.approved')
            + UI.field('Body', cfgTa('body', typeof c.body === 'string' ? c.body : lines(c.body), 2, 'empty: the step\'s input'), 'One per line field: template, or one template; empty sends the step\'s input')
            + '<div class="muted" style="font-size:12px">One delivery per run and step, signed with the tenant\'s Ed25519 webhook key, with the webhook path\'s retries and breaker. Output {webhook, delivery, event}; mocked in dry runs.</div>';
        } else if (n.kind === 'sub') {
          const wfs = ((st.callees || {}).workflows || []).filter((w) => w.id !== wf.id).map((w) => ({ value: w.name, label: w.name + ' v' + w.version + ' · ' + w.label }));
          if (c.workflow && !wfs.some((w) => w.value === c.workflow)) wfs.unshift({ value: c.workflow, label: c.workflow + ' (not published here)' });
          const callee = ((st.callees || {}).workflows || []).find((w) => w.name === c.workflow || w.id === c.workflow);
          fields = UI.field('Workflow', cfgSel('workflow', [{ value: '', label: wfs.length ? 'choose a workflow' : 'no other workflow is published here' }].concat(wfs), c.workflow || ''), callee ? 'Takes <span class="mono">' + esc(fmtSchema(callee.input)) + '</span>' + (list.some((x) => x.id === callee.id) ? '. <a href="#" data-opensub="' + esc(callee.id) + '">Open it</a>' : '') : 'Published workflows of this workspace')
            + '<div class="grid2" style="gap:10px">' + UI.field('Pinned version', cfgIn('version', c.version, { type: 'number', placeholder: callee ? 'v' + callee.version : 'published' })) + UI.field('Input', cfgTa('input', typeof c.input === 'string' ? c.input : lines(c.input), 2, 'period: {{input.period}}'), 'One per line field: template; empty: this step\'s input') + '</div>'
            + '<div class="muted" style="font-size:12px">The child runs as this run\'s owner under the higher label, in this run\'s chain. When it waits on an approval, this step and the run wait; cancelling the run cancels it. Output {run, output}.</div>';
        } else if (n.kind === 'agent') {
          const ags = ((st.callees || {}).agents || []).map((a) => ({ value: a.name, label: a.name + ' ' + a.version + ' · ' + a.label }));
          if (c.agent && !ags.some((a) => a.value === c.agent)) ags.unshift({ value: c.agent, label: c.agent + ' (not published here)' });
          const ag = ((st.callees || {}).agents || []).find((a) => a.name === c.agent);
          const b = c.budgets || {}; const bud = (k, label) => UI.field(label, UI.input(b[k] != null ? b[k] : '', { type: 'number', placeholder: ag && ag.budgets && ag.budgets[k] != null ? String(ag.budgets[k]) : 'agent\'s', attrs: 'data-budget="' + k + '"' + ro }));
          fields = UI.field('Agent', cfgSel('agent', [{ value: '', label: ags.length ? 'choose an agent' : 'no agent is published here' }].concat(ags), c.agent || ''), ag && ag.description ? esc(ag.description) : 'Published registry agents')
            + UI.field('Task', cfgTa('input', c.input, 2, 'Write meeting notes from {{steps.summary.text}}'), 'A template; empty: this step\'s input as JSON')
            + '<div class="grid2" style="gap:10px">' + bud('steps', 'Steps') + bud('tokens', 'Tokens') + bud('wallSeconds', 'Seconds') + bud('toolCalls', 'Tool calls') + '</div>'
            + '<div class="muted" style="font-size:12px">Runs as this run\'s owner under the agent\'s ceiling; the step waits without a worker and continues when the agent run ends. Output {run, text}.</div>';
        } else if (n.kind === 'map') {
          fields = UI.field('Over', cfgIn('over', c.over, { placeholder: '{{steps.frames.frames}}' }), 'A template rendering to a list') + action('map')
            + '<div class="grid2" style="gap:10px">' + UI.field('At once', cfgIn('maxParallel', c.maxParallel, { type: 'number', placeholder: '10' }), '1 to 20') + UI.field('Most items', cfgIn('maxItems', c.maxItems, { type: 'number', placeholder: '200' }), 'A run\'s maps cover at most ' + (((st.callees || {}).limits || {}).maxItems || 200)) + '</div>'
            + UI.field('Results field', cfgIn('as', c.as, { placeholder: 'results' }))
            + '<div class="muted" style="font-size:12px">Each item is a checkpoint, so a map resumes without running finished items again; the first failing item fails the step.</div>';
        } else if (n.kind === 'loop') {
          const w = c.while || {};
          fields = action('loop')
            + UI.field('While', '<div class="grid2" style="gap:6px;grid-template-columns:1fr 90px 1fr">' + UI.input(w.left || '', { placeholder: '{{last.done}}', attrs: 'data-while="left" aria-label="While: left"' + ro }) + UI.select(OPS, w.op || 'ne', 'data-while="op" aria-label="While: operator"' + ro) + UI.input(w.right == null ? '' : String(w.right), { placeholder: 'true', attrs: 'data-while="right" aria-label="While: right"' + ro }) + '</div>', 'Checked before every iteration; empty: run until the most iterations')
            + UI.field('Most iterations', cfgIn('max', c.max, { type: 'number', placeholder: '5' }), '1 to 40; each beyond the first counts toward the ' + L.maxSteps + '-step limit')
            + '<div class="muted" style="font-size:12px">Output {iterations, last, results, stopped: condition | max}.</div>';
        }
        const mine = issuesOf(n.id);
        const schemaErr = mine.find((x) => x.code === 'schema');
        const issueHtml = mine.filter((x) => x !== schemaErr).map((x) => UI.notice((x.code === 'label' ? '<b>Blocked by label ceiling.</b> ' : x.code === 'cycle' ? '<b>Cycle.</b> ' : x.code === 'unavailable' ? '<b>Not available.</b> ' : '') + esc(x.message), x.warning ? 'warn' : 'danger')).join('')
          + (schemaErr ? UI.notice('<b>Schema mismatch.</b> ' + esc(schemaErr.message), 'danger', editable ? UI.btn('Fix', { size: 'sm', attrs: 'data-fixschema', title: 'Accept what arrives as this step\'s input port' }) : '') : '');
        const schemaBox = (key, s, hint) => (editable ? UI.field(hint, UI.textarea(s ? json(s) : '', { rows: 3, placeholder: '{ "type": "object", "properties": { … }, "required": [ … ] }', attrs: 'data-schema="' + key + '"' + (schemaErr && key === 'input' ? ' style="border-color:var(--danger-fg)"' : '') })) : '')
          + '<pre class="codebox" style="' + (schemaErr && key === 'input' ? 'border-color:var(--danger-fg)' : '') + '">' + esc(s ? fmtSchema(s) : key === 'input' ? 'accepts whatever the steps before it send' : 'object') + '</pre>';
        const toolOf = n.kind === 'tool' ? (st.tools || []).find((x) => x.name === c.tool) : null;
        const rp = n.retry;
        const retry = rp ? rp.max + ' more attempt' + (rp.max === 1 ? '' : 's') + ', ' + (rp.backoff || 'exponential') + ' from ' + dur(rp.delayMs || 5000) : n.kind === 'model' ? 'retried after a restart; the gateway falls back within the profile' : n.kind === 'calc' || n.kind === 'transform' || n.kind === 'branch' ? 'freely, deterministic' : n.kind === 'http' ? (c.method && c.method !== 'GET' ? 'a replay sends it again' : 'safe to repeat') : n.kind === 'tool' ? (toolOf && toolOf.sideEffect !== 'read' ? 'a replay calls it again, after a new approval' : 'safe to repeat') : WRITES[n.kind] ? 'a replay sends it again' : 'not applicable';
        const writes = WRITES[n.kind] || (n.kind === 'http' && c.method && c.method !== 'GET') || (toolOf && toolOf.sideEffect !== 'read');
        const retryBox = NO_RETRY[n.kind] ? '' : UI.field('Retry after a failure', '<div class="grid2" style="gap:6px;grid-template-columns:1fr 1fr 1fr">' + UI.select([{ value: '0', label: 'no retry' }, { value: '1', label: '1 more' }, { value: '2', label: '2 more' }, { value: '3', label: '3 more' }, { value: '5', label: '5 more' }], String(rp ? rp.max : 0), 'data-retry="max" aria-label="Retries"' + ro) + (rp ? UI.input(Math.round((rp.delayMs || 5000) / 1000), { type: 'number', attrs: 'data-retry="delayMs" aria-label="First wait in seconds"' + ro }) + UI.select(['exponential', 'fixed'], rp.backoff || 'exponential', 'data-retry="backoff" aria-label="Backoff"' + ro) : '') + '</div>', rp ? 'Seconds before the first retry. The step waits without a worker; label and guardrail blocks and rejections are not retried.' + (writes ? ' This step writes: a retry may write twice.' : '') : 'A failing step fails the run unless an on-failure edge leaves it.');
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
          + retryBox
          + (outs.length ? '<div class="eyebrow">' + (n.kind === 'branch' ? 'Decision edges' : 'Connects to') + '</div><div class="vstack gap4">' + outs.map((e) => '<div class="hstack gap6" style="font-size:12px">' + (e.branch === 'failure' ? UI.pill('on failure', 'warn') : '') + '<span class="grow">' + esc((byId(e.to) || {}).title || e.to) + (e.branch === 'failure' ? ' receives {error, step}' : '') + '</span>' + (n.kind === 'branch' && e.branch !== 'failure' ? UI.btn(e.branch || 'set', { size: 'xs', kind: 'ghost', attrs: 'data-flip="' + esc(e.to) + '"' + (editable ? '' : ' disabled'), title: 'Switch between true and false' }) : '') + (editable ? UI.iconbtn('x', 'Remove the edge to ' + ((byId(e.to) || {}).title || e.to), { cls: 'sm ghost', attrs: 'data-unlink="' + esc(e.to) + '"' }) : '') + '</div>').join('') + '</div>' : '')
          + '<div class="hstack wrap">' + (editable ? UI.btn(st.connectFrom === n.id && !st.connectFailure ? 'Pick a target' : 'Connect from here', { size: 'sm', icon: 'link', attrs: 'data-connect', cls: st.connectFrom === n.id && !st.connectFailure ? 'active' : '' }) : '') + (editable && n.kind !== 'trigger' ? UI.btn(st.connectFrom === n.id && st.connectFailure ? 'Pick the failure target' : 'Connect on failure', { size: 'sm', icon: 'branch', attrs: 'data-connectfail', cls: st.connectFrom === n.id && st.connectFailure ? 'active' : '' }) : '') + (n.kind !== 'trigger' ? UI.btn('Replay step', { size: 'sm', kind: 'ghost', icon: 'refresh', attrs: 'data-replaystepbtn' }) : '') + '</div>'
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

      const palBtn = (p) => '<button type="button" data-add="' + p[0] + '" title="' + esc(editable ? 'Add ' + p[1] + ' (' + p[2] + ')' : manage ? 'Close the run to edit the draft' : 'Editing needs the workflows:manage permission') + '"' + (editable ? '' : ' disabled') + '><span>' + esc(p[1]) + '</span><i class="' + (p[2] === 'Thinking' ? 'think' : p[2] === 'Doing' ? 'do' : p[2] === 'Calculating' ? 'calc' : '') + '"></i></button>';
      // ---- lower tabs (the board's): runs, triggers and callers, versions, approvals waiting on me, dead letters ----
      const tab = st.tab || 'runs';
      if (st.tabLoaded !== tab + ':' + wf.id && st.tabLoading !== tab + ':' + wf.id) { st.tabLoading = tab + ':' + wf.id; loadTab(tab); }
      const tabReady = st.tabLoaded === tab + ':' + wf.id;
      const myApprovals = st.approvals || [];
      const deadOpen = (st.dead || []).filter((d) => d.state === 'open' && st.tabLoaded === 'dead:' + wf.id).length;
      const tabItems = [{ id: 'runs', label: 'Run history', count: runs.length }, { id: 'callers', label: 'Triggers and callers' }, { id: 'versions', label: 'Versions', count: wf.versions.length }, { id: 'approvals', label: 'Approvals waiting on me', count: myApprovals.length }].concat(manage ? [{ id: 'dead', label: 'Dead letters', count: st.tabLoaded === 'dead:' + wf.id ? deadOpen : undefined }] : []);
      const lower = (runsTable) => {
        if (tab === 'runs') return runsTable + '<div class="hstack"><span class="muted grow" style="font-size:12px">Runs pin the version they started on. Workflow admins see everyone\'s runs; others their own. Outputs above your clearance are withheld.</span>' + UI.btn('Open in Runs', { size: 'sm', kind: 'ghost', attrs: 'data-goruns' }) + '</div>';
        if (!tabReady && tab !== 'versions' && tab !== 'approvals') return UI.notice('Loading…', 'info');
        if (tab === 'callers') {
          const tv = st.triggerView || {}; const t = tv.trigger; const cs = st.callers || { appTriggers: [], workflows: [], tools: [], plugins: [], lastRuns: {} };
          const lr = (k) => { const x = cs.lastRuns && cs.lastRuns[k]; return x ? esc(when(x.at)) + ' ' + runPill(x.state) + (x.count > 1 ? ' <span class="muted">' + x.count + ' runs</span>' : '') : 'never'; };
          const trig = st.draft.nodes.find((n) => n.kind === 'trigger'); const tc = (trig && trig.config) || {};
          const own = t ? UI.panel('Own trigger', UI.kv([['Kind', t.kind === 'event' ? 'event <span class="mono">' + esc(t.event) + '</span>' : 'schedule <span class="mono">' + esc(t.cron) + '</span> UTC'], ['State', UI.pill(t.enabled ? 'enabled' : 'off', t.enabled ? 'ok' : 'outline')], ['Version', 'v' + esc(t.version)], ['Runs as', 'the person who published v' + esc(t.version)], ['Next run', t.nextRunAt ? esc(when(t.nextRunAt)) : t.kind === 'event' ? 'on the next matching event' : '—'], ['Last fired', t.lastFiredAt ? esc(when(t.lastFiredAt)) + (t.lastResult ? ', ' + esc(t.lastResult) : '') : 'never']], 2)
              + (manage ? '<div class="hstack">' + UI.btn(t.enabled ? 'Turn off' : 'Turn on', { size: 'sm', attrs: 'data-trigtoggle' }) + '<span class="muted" style="font-size:12px">' + (t.kind === 'schedule' ? 'Turning it on again recomputes the next due time.' : 'Events that arrive while it is off start nothing.') + '</span></div>' : '')
              + ((tv.firings || []).length ? UI.table(['Firing', 'Event', 'State', 'Run', 'Reason', 'At'], tv.firings.map((f) => ['<span class="mono">' + esc(String(f.id).slice(-6)) + '</span>', esc(f.event || (t.kind === 'schedule' ? 'schedule' : '')), UI.pill(f.state, f.state === 'started' ? 'ok' : f.state === 'skipped' ? 'warn' : 'info'), f.runId ? '<a href="#" data-openrun="' + esc(f.runId) + '" class="mono">' + esc(shortId(f.runId)) + '</a>' : '—', esc(f.reason || ''), esc(when(f.createdAt))]), { clickable: false, minWidth: '640px', cls: 'bare' }) : '<div class="muted" style="font-size:12px">It has not fired yet.</div>'), {})
            : (tc.source === 'event' || (tc.source === 'schedule' && tc.cron) ? UI.notice('The draft\'s ' + (tc.source === 'event' ? 'event trigger (' + esc(tc.event || 'no event yet') + ')' : 'schedule (' + esc(tc.cron) + ')') + ' is written when you publish; it then starts runs as you.', 'info') : '');
          const rows = [{ cells: ['<b>manual and API</b>', 'Console or POST /api/workflows/:id/runs (agents:run)', 'whoever starts it', lr('manual') === 'never' ? lr('api') : lr('manual'), UI.pill(wf.publishedVersion ? 'always' : 'after publishing', wf.publishedVersion ? 'ok' : 'outline'), ''] }]
            .concat(cs.appTriggers.map((x) => ({ cells: ['<b>' + esc(x.kind) + ' trigger</b>', esc((x.appTitle || x.appName) + ' → ' + (x.entityTitle || x.entity || '')) + ': ' + esc(x.kind === 'record' ? x.events.join(', ') : 'cron ' + (x.cron || '') + ' UTC'), esc(x.ownerName || 'its owner'), x.lastRunAt ? esc(when(x.lastRunAt)) + (x.lastResult ? ' <span class="muted">' + esc(x.lastResult) + '</span>' : '') : 'never', UI.pill(x.enabled ? 'enabled' : 'off', x.enabled ? 'ok' : 'outline'), App.can('records:read') ? UI.btn('Open', { size: 'xs', kind: 'ghost', attrs: 'data-goapp="' + esc(x.appName) + '"' }) : ''] })))
            .concat(cs.workflows.map((x) => ({ cells: ['<b>' + (x.kind === 'sub' ? 'sub-workflow step' : x.kind + ' step') + '</b>', esc(x.workflow + ' → ' + x.stepTitle) + (x.version ? ', pinned v' + esc(x.version) : '') + ' (' + esc(x.in) + ')', 'the parent run\'s owner', lr('workflow'), UI.pill(/published/.test(x.in) ? 'published' : 'draft', /published/.test(x.in) ? 'ok' : 'info'), list.some((w) => w.id === x.workflowId) ? UI.btn('Open', { size: 'xs', kind: 'ghost', attrs: 'data-opensub="' + esc(x.workflowId) + '"' }) : ''] })))
            .concat(cs.tools.map((x) => ({ cells: ['<b>tool call</b>', esc(x.name + ' ' + x.version) + ' pins v' + esc(x.workflowVersion) + '; agents await its approvals', 'the calling agent run\'s owner', lr('tool'), UI.pill(String(x.status).replace('_', ' '), x.status === 'published' ? 'ok' : x.status === 'in_review' ? 'info' : 'outline'), App.can('tools:manage') ? UI.btn('Open', { size: 'xs', kind: 'ghost', attrs: 'data-gotool="' + esc(x.id) + '"' }) : ''] })))
            .concat(cs.plugins.map((x) => ({ cells: ['<b>plugin action</b>', esc(x.name || x.key) + ' (call:workflow) may start any published workflow', esc(x.installedByName || 'the installer'), lr('plugin'), UI.pill(x.state, x.state === 'enabled' ? 'ok' : 'outline'), App.can('plugins:manage') ? UI.btn('Open', { size: 'xs', kind: 'ghost', attrs: 'data-goplugin="' + esc(x.key) + '"' }) : ''] })));
          return UI.notice('<b>How runs start.</b> Manual and API runs, the workflow\'s own event or schedule trigger (as the person who published the version), an app\'s record and schedule triggers (as the trigger\'s owner), another workflow\'s sub-workflow, map or loop step, a plugin\'s call:workflow action (as the installer), and a tool call when it is published as a tool. Every run is a node of one chain.', 'info')
            + own
            + UI.table(['Caller', 'Detail', 'Runs as', 'Last run', 'State', ''], rows, { clickable: false, minWidth: '820px' })
            + '<div class="hstack wrap">' + (App.can('apps:design') ? UI.btn('Add a trigger in Apps', { size: 'sm', attrs: 'data-goapps' }) : '') + UI.btn('Refresh', { size: 'sm', kind: 'ghost', icon: 'refresh', attrs: 'data-retab' }) + '</div>';
        }
        if (tab === 'versions') {
          const vrows = [['draft', UI.pill(st.unsaved ? 'unsaved' : 'draft', st.unsaved ? 'warn' : ''), 'revision ' + wf.draftRev, esc(when(wf.updatedAt)), '']].concat(wf.versions.map((x) => ['v' + x.version, UI.pill(x.state, x.state === 'published' ? 'ok' : 'warn'), esc(x.note || ''), esc(when(x.publishedAt)), UI.btn('Diff against the draft', { size: 'xs', attrs: 'data-diffv="' + x.version + '"' })]));
          return UI.table(['Version', 'State', 'Note', 'Changed', ''], vrows, { clickable: false, minWidth: '640px' }) + (st.diffOut ? UI.notice(st.diffOut, '') : '')
            + UI.notice('Saving the draft sends the revision you loaded; a save after someone else\'s is refused. Runs pin the version they started on; publishing a new version does not change runs in progress.', 'info')
            + (manage ? '<div class="hstack wrap">' + UI.btn('Export bundle', { size: 'sm', icon: 'download', attrs: 'data-export' }) + UI.btn('Import bundle', { size: 'sm', icon: 'upload', attrs: 'data-import' }) + UI.btn('Used by', { size: 'sm', attrs: 'data-wfusedby' }) + UI.btn('Delete workflow', { size: 'sm', kind: 'danger', attrs: 'data-delwf' }) + '<span class="muted" style="font-size:12px">exprsn-workflow/1, signed; tool, profile, app, vault and trigger references are re-bound on import.</span></div>' : '');
        }
        if (tab === 'approvals') return UI.table(['Workflow', 'Run', 'Step', 'Role', 'Due', 'Mode', ''], myApprovals.map((a) => ['<b>' + esc(a.workflow || '') + '</b>', '<span class="mono">' + esc(shortId(a.runId)) + '</span>', esc(a.step || a.nodeId) + (a.form ? ' ' + UI.pill('form', 'outline') : ''), '<span class="mono">' + esc(a.role) + '</span>', esc(when(a.dueAt)), a.mode === 'dry' ? UI.pill('dry run', 'outline') : 'run', '<span class="hstack gap6" style="justify-content:flex-end">' + UI.btn('Open', { size: 'xs', kind: 'ghost', attrs: 'data-openapproval="' + esc(a.workflowId) + '|' + esc(a.runId) + '"' }) + (a.canDecide ? UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-approve="' + esc(a.id) + '"' }) : '') + '</span>']), { clickable: false, minWidth: '760px', emptyTitle: 'Nothing waits on you', emptyText: 'Approvals appear here when a run pauses for a role you hold.' })
          + '<div class="muted" style="font-size:12px">Across every workflow you may see. You decide when you hold the role and are cleared for the run\'s label; a dry run\'s approvals wait on whoever started it.</div>';
        const dl = st.dead || [];
        return UI.table(['Run', 'Failed step', 'Error', 'Failed', 'State', ''], dl.map((d) => ['<a href="#" data-openrun="' + esc(d.runId) + '" class="mono">' + esc(shortId(d.runId)) + '</a>', esc(d.nodeId ? ((st.draft.nodes.find((n) => n.id === d.nodeId) || {}).title || d.nodeId) : '—'), esc(d.error || ''), esc(when(d.failedAt)), UI.pill(d.state, d.state === 'open' ? 'warn' : 'ok') + (d.redriveRunId ? ' <a href="#" data-openrun="' + esc(d.redriveRunId) + '" class="mono">' + esc(shortId(d.redriveRunId)) + '</a>' : ''), d.state === 'open' ? UI.btn('Redrive', { size: 'xs', kind: 'primary', attrs: 'data-redrive="' + esc(d.id) + '"' }) : '']), { clickable: false, minWidth: '720px', emptyTitle: 'No dead letters', emptyText: 'A run that fails for good, after its retries and with no on-failure edge to take, lands here.' })
          + '<div class="muted" style="font-size:12px">A redrive replays the run from the failed step; the steps before it keep their checkpoints. Each dead letter is redriven once.</div>';
      };

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
        + '<div class="leftpane w170" aria-label="Step palette"><div class="eyebrow">Steps</div><div class="wf-palette">' + PALETTE.map(palBtn).join('') + '</div><div class="eyebrow" style="margin-top:12px">Chaining and iteration</div><div class="wf-palette">' + PALETTE_WF2.map(palBtn).join('') + '</div><div class="muted" style="font-size:11px;margin-top:auto">Click a step to add it to the canvas. Dot: thinking, doing or calculating worker class. Drag steps to arrange them.</div></div>'
        + '<div class="page wf-page">'
        + '<div class="wf-toolbar">' + UI.select(workflows, wf.id, 'data-wf aria-label="Workflow" style="width:auto"') + UI.pill(published ? 'published' : 'draft', published ? 'ok' : '') + (st.unsaved ? UI.pill('unsaved changes', 'warn') : '') + '<span class="muted" style="font-size:12px">trigger: ' + esc(trigger ? subOf(trigger) : 'none') + ' · engine job queue · limits ' + L.maxSteps + ' steps, ' + Math.round(L.maxTokens / 1000) + 'k tokens, ' + hours(L.maxRunTimeoutMs) + '</span>' + (approvalsHere.length ? '<a href="#" class="right" data-pending style="font-size:12px">' + approvalsHere.length + ' run' + (approvalsHere.length > 1 ? 's' : '') + ' waiting on approval</a>' : '') + (manage ? UI.btn('New workflow', { size: 'sm', icon: 'plus', attrs: 'data-newwf', cls: approvalsHere.length ? '' : 'right' }) : '') + '</div>'
        + (st.kbd ? UI.notice('<b>Keyboard operation.</b> Arrow keys move between nodes, Enter opens the inspector, C starts a connection from the selected port, Shift and an arrow completes it, Delete removes the step, Escape cancels.', 'info', UI.btn('Dismiss', { size: 'sm', attrs: 'data-dismisskbd' })) : '')
        + (st.connectFrom && !viewing ? UI.notice((st.connectFailure ? 'Connecting the <b>on-failure</b> edge from <b>' : 'Connecting from <b>') + esc((byId(st.connectFrom) || {}).title) + '</b>. Click a target step, or press Escape.' + (st.connectFailure ? ' The target receives {error, step} when the step fails for good.' : ''), 'accent', UI.btn('Cancel', { size: 'sm', attrs: 'data-cancelconnect' })) : '')
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
        + '<span class="muted right" style="font-size:12px">' + nodes.length + (nodes.length === 1 ? ' step, ' : ' steps, ') + graph.edges.length + (graph.edges.length === 1 ? ' edge' : ' edges') + (viewing ? '' : blocking ? ', <span style="color:var(--danger-fg)">' + blocking + ' problem' + (blocking === 1 ? '' : 's') + '</span>' : v.warnings.length ? ', ' + v.warnings.length + ' warning' + (v.warnings.length === 1 ? '' : 's') : ', valid') + '</span></div>'
        + '<div class="wf-lower">' + UI.tabs(tabItems, tab, 'aria-label="Workflow details"') + '<div class="vstack gap6">' + lower(UI.table(['Run', 'Trigger', 'Started', 'Duration', 'Label', 'State'], runs.map((r) => ({ cells: ['<span class="mono">' + esc(shortId(r.id)) + '</span>', esc(r.mode === 'dry' ? 'dry run, ' + (r.createdByName || '') : r.trigger === 'replay' ? 'replay of ' + shortId(r.replayOf) : (/^workflow:/.test(r.trigger) ? 'sub-workflow of ' + shortId(r.trigger.slice(9)) : r.trigger.split(':')[0]) + ', ' + (r.createdByName || '')), esc(when(r.startedAt || r.createdAt)), r.startedAt ? dur((r.finishedAt || Date.now()) - r.startedAt) : '—', UI.label(r.label, { sm: true }), runPill(runState(r))], attrs: 'data-run="' + esc(r.id) + '"', selected: st.runId === r.id })), { cls: 'bare', minWidth: '0', emptyTitle: 'No runs yet', emptyText: wf.publishedVersion ? 'Start a run of the published version, or dry run the draft.' : 'Dry run the draft, or publish it and start a run.' })) + '</div></div>'
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
      const addEdge = (from, to, failure) => {
        const g = st.draft; const a = g.nodes.find((x) => x.id === from);
        if (from === to) return;
        if (g.edges.some((e) => e.from === from && e.to === to)) { toast('Those steps are already connected.', 'warn'); return; }
        const e = { from, to };
        if (failure) e.branch = 'failure';
        else if (a && a.kind === 'branch') e.branch = g.edges.some((x) => x.from === from && x.branch === 'true') ? 'false' : 'true';
        if (failure) { g.edges.push(e); changed('Connected on failure: when ' + esc(a ? a.title : from) + ' fails for good, ' + esc((g.nodes.find((x) => x.id === to) || {}).title || to) + ' receives {error, step} and the run goes on.'); return; }
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
        const a = (run && run.approvals.find((x) => x.id === id)) || (st.approvals || []).find((x) => x.id === id); if (!a) return;
        const title = a.step || (byId(a.nodeId) || {}).title || a.nodeId;
        const after = () => { if (run) loadRun(run.id); loadRuns(); };
        const rlabel = run && run.id === a.runId ? run.label : a.label || wf.label;
        if (approve && a.form) {
          const f = a.form; const fid = (x) => 'wf-ans-' + x.name;
          const input = (x) => (x.options && x.options.length ? UI.select([{ value: '', label: 'choose' }].concat(x.options.map((o) => (typeof o === 'object' ? { value: String(o.value), label: String(o.label || o.value) } : String(o)))), '', 'data-ans="' + esc(x.name) + '" id="' + fid(x) + '"') : x.type === 'boolean' ? UI.select([{ value: '', label: 'choose' }, { value: 'true', label: 'yes' }, { value: 'false', label: 'no' }], '', 'data-ans="' + esc(x.name) + '" data-bool id="' + fid(x) + '"') : x.type === 'text' || x.type === 'long_text' ? UI.textarea('', { rows: 2, attrs: 'data-ans="' + esc(x.name) + '" id="' + fid(x) + '"' }) : UI.input('', { type: x.type === 'number' || x.type === 'integer' ? 'number' : x.type === 'date' ? 'date' : 'text', attrs: 'data-ans="' + esc(x.name) + '"' + (x.type === 'number' || x.type === 'integer' ? ' data-num' : '') + ' id="' + fid(x) + '"' }));
          ctx.modal({ title: 'Approve step: ' + esc(title), body: '<p class="fg2" style="margin:0">' + esc(f.title || f.form) + ' (' + esc(f.app) + '). The answers are validated like a submission of the form and become the step\'s output; they are audited with your decision.</p>'
              + (f.fields || []).map((x) => UI.field(esc(x.label || x.name) + (x.required ? ' <span class="muted">(required)</span>' : ''), input(x), x.help ? esc(x.help) : '')).join('') + '<div data-anserr></div>',
            actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(esc(f.submitLabel || 'Approve'), { kind: 'primary', attrs: 'data-go' }),
            onMount(m) {
              m.querySelector('[data-go]').addEventListener('click', async (ev) => {
                const answers = {};
                m.querySelectorAll('[data-ans]').forEach((el) => { const v = el.value.trim(); if (v === '') return; answers[el.dataset.ans] = el.hasAttribute('data-bool') ? v === 'true' : el.hasAttribute('data-num') ? Number(v) : v; });
                ev.target.disabled = true;
                try { await App.post('/api/workflow-approvals/' + enc(id), { decision: 'approve', answers }); App.closeOverlay(); toast('Approved with your answers. The run continues; its steps report on the canvas.', 'ok'); after(); }
                catch (err) { ev.target.disabled = false; const pr = (err.problem && err.problem.problems) || []; m.querySelector('[data-anserr]').innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc((err.problem && err.problem.detail) || err.message) + (pr.length ? '<br>' + pr.map((x) => esc(typeof x === 'string' ? x : x.message || JSON.stringify(x))).join('<br>') : ''), 'danger'); }
              });
            } });
          return;
        }
        if (approve) {
          const ok = await ctx.confirm({ title: 'Approve step: ' + title, tag: 'approval', tone: 'info', body: '<p class="fg2" style="margin:0">Your decision is written to the audit chain and the run continues from this step.</p>', kv: [['Role', esc(a.role)], ['Label', UI.label(rlabel, { sm: true })]], ok: 'Approve' });
          if (!ok) return;
          try { await App.post('/api/workflow-approvals/' + enc(id), { decision: 'approve' }); toast('Approved. The run continues; its steps report on the canvas.', 'ok'); after(); } catch (err) { App.fail(err, 'Could not approve'); }
          return;
        }
        ctx.modal({ title: 'Reject approval ' + UI.pill('reject', 'danger'), body: UI.field('Reason', UI.textarea('', { placeholder: 'Sent to the run owner', rows: 2, attrs: 'data-reason' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-go' }),
          onMount(m) {
            m.querySelector('[data-go]').addEventListener('click', async () => {
              const reason = m.querySelector('[data-reason]').value.trim() || null; App.closeOverlay();
              try { await App.post('/api/workflow-approvals/' + enc(id), { decision: 'reject', reason }); toast('Rejected. The run ended; the owner can see your reason.', 'warn'); after(); } catch (err) { App.fail(err, 'Could not reject'); }
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
        if (st.connectFrom && !viewing && st.connectFrom !== id) { const from = st.connectFrom; const fail = !!st.connectFailure; st.connectFrom = null; st.connectFailure = false; addEdge(from, id, fail); return; }
        st.sel = id; ctx.rerender();
      });
      ctx.on('click', '[data-add]', (e, t) => {
        if (!editable) return;
        const p = PALETTE.concat(PALETTE_WF2).find((x) => x[0] === t.dataset.add); const ns = st.draft.nodes;
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
        if (k === 'fields' || k === 'values') c[k] = unlines(raw);
        else if (k === 'headers') { const auth = authOf(c); c.headers = unlines(raw); Object.keys(c.headers).forEach((h) => { if (h.toLowerCase() === 'authorization') delete c.headers[h]; }); if (auth) c.headers.Authorization = auth; }
        else if (k === 'users') { c.users = raw.split(',').map((x) => x.trim()).filter(Boolean); }
        else if (k === 'email') c.email = raw === 'true';
        else if (k === 'version' || k === 'maxParallel' || k === 'maxItems' || k === 'max') { if (raw.trim() === '') delete c[k]; else c[k] = Math.round(Number(raw)); }
        else if ((k === 'input' || k === 'body') && (n.kind === 'sub' || n.kind === 'webhook' || n.kind === 'map' || n.kind === 'loop')) { const t = raw.trim(); if (!t) delete c[k]; else if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(t) && !/^\s*\{/.test(t)) c[k] = unlines(t); else c[k] = t; }
        else if ((k === 'route' || k === 'to' || k === 'record' || k === 'cron' || k === 'event' || k === 'as' || k === 'input' || k === 'prompt' && n.kind !== 'model') && !raw.trim()) delete c[k];
        else if (k === 'source') { c.source = raw; if (raw !== 'event') delete c.event; if (raw !== 'schedule') delete c.cron; if (n.title === 'Trigger: manual' || /^Trigger: /.test(n.title)) n.title = 'Trigger: ' + raw; }
        else if (k === 'app' && n.kind === 'record') { c.app = raw; c.entity = ''; delete c.to; loadApp(raw); }
        else if (k === 'timeoutMs' || k === 'approvalTimeoutMs') c[k] = Math.max(1, Number(raw) || 24) * 3600000;
        else if (k === 'ms') c[k] = Math.max(1, Number(raw) || 60) * 1000;
        else if (k === 'right') { const s = raw.trim(); if (s === '') delete c.right; else c.right = s === 'true' ? true : s === 'false' ? false : !isNaN(Number(s)) ? Number(s) : s; }
        else if (k === 'args' && raw.trim()) c[k] = unlines(raw);
        else if ((k === 'think' || k === 'body' || k === 'args') && !raw.trim()) delete c[k];
        else c[k] = raw;
        after(t);
      });
      // Sprint 32e: the Workflows 2 editors.
      ctx.on('change', '[data-retry]', (e, t) => {
        const n = selNode(); if (!n || !editable) return;
        const k = t.dataset.retry;
        if (k === 'max') { const m = Number(t.value); if (!m) delete n.retry; else n.retry = Object.assign({ delayMs: 5000, backoff: 'exponential' }, n.retry || {}, { max: m }); }
        else if (n.retry && k === 'delayMs') n.retry.delayMs = Math.min(3600000, Math.max(1000, Math.round(Number(t.value) || 5) * 1000));
        else if (n.retry) n.retry.backoff = t.value;
        after(t);
      });
      ctx.on('click', '[data-skill]', (e, t) => { const n = selNode(); if (!n || !editable) return; const c = n.config; c.skills = c.skills || []; const i = c.skills.indexOf(t.dataset.skill); if (i >= 0) c.skills.splice(i, 1); else c.skills.push(t.dataset.skill); if (!c.skills.length) delete c.skills; changed(i >= 0 ? 'Skill removed.' : 'Skill ' + esc(t.dataset.skill) + ' attached: its instructions and tools load into the step when it runs.'); });
      ctx.on('click', '[data-nrole]', (e, t) => { const n = selNode(); if (!n || !editable) return; const c = n.config; c.roles = c.roles || []; const i = c.roles.indexOf(t.dataset.nrole); if (i >= 0) c.roles.splice(i, 1); else c.roles.push(t.dataset.nrole); changed(); });
      ctx.on('change', '[data-formapp]', (e, t) => { const n = selNode(); if (!n || !editable) return; if (!t.value) delete n.config.form; else { n.config.form = { app: t.value, form: '' }; loadApp(t.value); } changed(t.value ? 'Choose the form the approver fills in.' : 'No form: the approver approves or rejects.'); });
      ctx.on('change', '[data-formname]', (e, t) => { const n = selNode(); if (!n || !editable || !n.config.form) return; n.config.form.form = t.value; changed(t.value ? 'The approver fills in this form; the answers become the step\'s output.' : ''); });
      ctx.on('change', '[data-vscheme], [data-vpath], [data-vkey]', (e, t) => {
        const n = selNode(); if (!n || !editable) return; const c = n.config; c.headers = c.headers || {};
        const sc = ctx.$('[data-vscheme]').value; const path = (ctx.$('[data-vpath]').value || '').trim().replace(/^kv\//, ''); const key = (ctx.$('[data-vkey]').value || '').trim() || 'token';
        Object.keys(c.headers).forEach((h) => { if (h.toLowerCase() === 'authorization') delete c.headers[h]; });
        if (path && sc !== 'none') c.headers.Authorization = (sc === 'raw' ? '' : sc + ' ') + 'vault:' + path + '#' + key;
        after(t);
      });
      ctx.on('change', '[data-budget]', (e, t) => { const n = selNode(); if (!n || !editable) return; const c = n.config; c.budgets = c.budgets || {}; if (t.value.trim() === '') delete c.budgets[t.dataset.budget]; else c.budgets[t.dataset.budget] = Math.round(Number(t.value)); if (!Object.keys(c.budgets).length) delete c.budgets; after(t); });
      ctx.on('change', '[data-while]', (e, t) => {
        const n = selNode(); if (!n || !editable) return; const c = n.config; const w = Object.assign({ left: '', op: 'ne' }, c.while || {});
        const k = t.dataset.while; const v = t.value.trim();
        if (k === 'right') { if (v === '') delete w.right; else w.right = v === 'true' ? true : v === 'false' ? false : !isNaN(Number(v)) ? Number(v) : v; } else w[k] = v;
        if (!w.left) delete c.while; else c.while = w;
        after(t);
      });
      ctx.on('change', '[data-action]', (e, t) => {
        const n = selNode(); if (!n || !editable) return; const c = n.config;
        ['profile', 'prompt', 'format', 'tool', 'args', 'workflow', 'version', 'input'].forEach((k) => delete c[k]);
        if (t.value === 'model') Object.assign(c, { profile: (st.profiles && st.profiles[0] && st.profiles[0].name) || '', prompt: n.kind === 'map' ? 'Summarise {{item}} in one sentence.' : 'Improve this draft: {{last}}' });
        else if (t.value === 'tool') c.tool = (st.tools && st.tools[0] && st.tools[0].name) || '';
        else c.workflow = (((st.callees || {}).workflows || []).find((w) => w.id !== wf.id) || {}).name || '';
        changed();
      });
      ctx.on('click', '[data-tab]', (e, t) => { if (t.closest('.wf-lower')) { st.tab = t.dataset.tab; st.diffOut = null; ctx.rerender(); } });
      ctx.on('click', '[data-retab]', () => { st.tabLoaded = null; st.tabLoading = null; ctx.rerender(); });
      ctx.on('click', '[data-trigtoggle]', async () => {
        const t = st.triggerView && st.triggerView.trigger; if (!t) return;
        try { await App.patch('/api/workflows/' + enc(wf.id) + '/triggers', { enabled: !t.enabled }); toast(t.enabled ? 'Trigger turned off. Nothing starts the workflow by itself until it is on again.' : 'Trigger on again' + (t.kind === 'schedule' ? '; its next due time was recomputed.' : '.'), t.enabled ? 'warn' : 'ok'); st.tabLoaded = null; st.tabLoading = null; ctx.rerender(); }
        catch (err) { App.fail(err, 'Could not change the trigger'); }
      });
      ctx.on('click', '[data-redrive]', async (e, t) => {
        const d = (st.dead || []).find((x) => x.id === t.dataset.redrive); if (!d) return;
        const ok = await ctx.confirm({ title: 'Redrive the failed run', tag: 'redrive', tone: 'info', body: '<p class="fg2" style="margin:0">A new run replays ' + esc(shortId(d.runId)) + ' from the step that failed. The steps before it keep their checkpoints.</p>', kv: [['Run', '<span class="mono">' + esc(shortId(d.runId)) + '</span>'], ['From', esc(d.nodeId || 'the start')], ['Error', esc(d.error || '')]], ok: 'Redrive' });
        if (!ok) return;
        try { const out = await App.post('/api/workflow-dead-letters/' + enc(d.id) + '/redrive', {}); toast('Redriven as <span class="mono">' + esc(shortId(out.redriveRunId)) + '</span>.', 'ok'); st.tabLoaded = null; st.tabLoading = null; loadRuns(); ctx.rerender(); }
        catch (err) { App.fail(err, 'Could not redrive'); }
      });
      ctx.on('click', '[data-openrun]', (e, t) => { e.preventDefault(); st.runId = t.dataset.openrun; st.run = null; st.runError = null; ctx.rerender(); });
      ctx.on('click', '[data-openwfrun]', (e, t) => {
        e.preventDefault(); const id = t.dataset.openwfrun;
        App.get('/api/workflow-runs/' + enc(id)).then((r) => { if (r.workflowId !== st.wfId) { st.wfId = r.workflowId; st.wf = null; st.draft = null; st.unsaved = false; st.tabLoaded = null; } st.runId = r.id; st.run = r; st.runError = null; ctx.rerender(); }).catch((err) => App.fail(err, 'Could not open the run'));
      });
      ctx.on('click', '[data-goagentrun]', (e, t) => { e.preventDefault(); ctx.navigate('runs', { run: t.dataset.goagentrun }); });
      ctx.on('click', '[data-opensub]', async (e, t) => {
        e.preventDefault(); const id = t.dataset.opensub; if (!list.some((x) => x.id === id)) return;
        if (st.unsaved) { const ok = await ctx.confirm({ title: 'Discard unsaved changes', tag: 'draft', tone: 'warn', body: '<p class="fg2" style="margin:0">The changes to ' + esc(wf.name) + ' are not saved. Open the other workflow anyway?</p>', ok: 'Discard and open' }); if (!ok) return; }
        st.wfId = id; st.wf = null; st.draft = null; st.runId = null; st.run = null; st.problem = null; st.unsaved = false; st.tabLoaded = null; ctx.rerender();
      });
      ctx.on('click', '[data-goapp]', (e, t) => ctx.navigate('apps', { app: t.dataset.goapp, tab: 'triggers' }));
      ctx.on('click', '[data-goapps]', (e) => { e.preventDefault(); ctx.navigate('apps'); });
      ctx.on('click', '[data-goplugin]', (e, t) => ctx.navigate('plugins', { id: t.dataset.goplugin }));
      ctx.on('click', '[data-govault]', (e) => { e.preventDefault(); ctx.navigate('vault'); });
      ctx.on('click', '[data-openapproval]', (e, t) => { const [w, r] = t.dataset.openapproval.split('|'); if (w !== st.wfId) { st.wfId = w; st.wf = null; st.draft = null; st.unsaved = false; st.tabLoaded = null; } st.runId = r; st.run = null; st.runError = null; ctx.rerender(); });
      ctx.on('click', '[data-diffv]', (e, t) => {
        const x = wf.versions.find((y) => String(y.version) === t.dataset.diffv); if (!x) return; const g = x.graph;
        const a = new Map(g.nodes.map((n) => [n.id, n])); const b = new Map(st.draft.nodes.map((n) => [n.id, n]));
        const added = st.draft.nodes.filter((n) => !a.has(n.id)).map((n) => n.title); const removed = g.nodes.filter((n) => !b.has(n.id)).map((n) => n.title);
        const edited = st.draft.nodes.filter((n) => a.has(n.id) && JSON.stringify(Object.assign({}, a.get(n.id), { x: 0, y: 0 })) !== JSON.stringify(Object.assign({}, n, { x: 0, y: 0 }))).map((n) => n.title);
        const ek = (ed) => ed.from + '>' + ed.to + (ed.branch || ''); const ea = g.edges.map(ek), eb = st.draft.edges.map(ek);
        const edges = eb.filter((k) => ea.indexOf(k) < 0).length + ea.filter((k) => eb.indexOf(k) < 0).length;
        const parts = [];
        if (added.length) parts.push('adds ' + added.join(', ')); if (removed.length) parts.push('removes ' + removed.join(', ')); if (edited.length) parts.push('changes ' + edited.join(', ')); if (edges) parts.push(edges + ' edge' + (edges === 1 ? '' : 's') + ' differ');
        st.diffOut = '<b>v' + esc(x.version) + ' against the draft.</b> ' + esc(parts.length ? 'The draft ' + parts.join('; ') + '.' : 'The draft matches this version, apart from where steps sit on the canvas.');
        ctx.rerender();
      });
      ctx.on('click', '[data-delwf]', () => wfUsedBy(wf, 'delete'));
      ctx.on('click', '[data-wfusedby]', () => wfUsedBy(wf, 'view'));
      ctx.on('click', '[data-gochain]', (e, t) => { e.preventDefault(); if (t.dataset.gochain) ctx.navigate('runs', Object.assign({ chain: t.dataset.gochain }, t.dataset.chainnode ? { node: t.dataset.chainnode } : {})); });
      /** GET /api/workflows/:id/used-by, then the delete (refused with 409 while a published agent or workflow uses it). */
      async function wfUsedBy(w, mode) {
        let u;
        try { u = await App.get('/api/workflows/' + enc(w.id) + '/used-by'); } catch (err) { App.fail(err, 'Used by could not be loaded'); return; }
        const VIA = { workflow: 'lists it as a workflow it may start', 'workflow-tool': 'is its workflow tool', 'sub-workflow': 'runs it as a sub-workflow', 'agent-step': 'runs it in an agent step', 'tool-step': 'calls it in a tool step', delegate: 'delegates to it', tool: 'calls it as a tool', skill: 'loads it', 'model-skill': 'loads it in a model step' };
        const usedBy = u.usedBy || [];
        const blockers = usedBy.filter((x) => x.live && (x.kind === 'agent' || x.kind === 'workflow'));
        const blocked = mode === 'delete' && !!u.deleteBlocked;
        const table = UI.table(['Kind', 'Name', 'Version', 'Status', 'How it references ' + (u.name || w.name), 'Live'], usedBy.map((x) => [esc(x.kind), '<b>' + esc(x.name) + '</b>', '<span class="mono">' + esc(x.version == null ? '' : x.version) + '</span>', UI.pill(String(x.status || '').replace('_', ' ')), esc(VIA[x.via] || x.via) + ' <span class="muted mono">' + esc(x.via) + '</span>', x.live ? UI.pill('live', 'warn') : UI.pill('not live', 'outline')]), { clickable: false, minWidth: '640px', emptyTitle: 'Nothing uses ' + (u.name || w.name), emptyText: 'No agent, workflow tool or other workflow references it.' });
        const note = mode === 'delete' ? (blocked ? UI.notice('<b>Delete refused (Still in use).</b> ' + esc(w.name) + ' is used by ' + esc(blockers.map((x) => x.kind + ' ' + x.name + (x.version != null ? ' ' + x.version : '')).join('; ')) + '. Remove it from them first. A workflow tool entry does not block the delete; it becomes unavailable.', 'danger') : UI.notice('The workflow, its versions and its run history are deleted. This is refused while a run is queued, running or waiting.' + (usedBy.length ? ' What still references it stops reaching it.' : ''), 'warn'))
          : UI.notice('Agents that list it, workflow tools, and other workflows\' sub-workflow, map, loop and agent steps. Drafts are listed but not live.' + (u.deleteBlocked ? ' Deleting it is refused while a live agent or workflow uses it.' : ''), 'info');
        ctx.modal({ cls: 'wide', title: (mode === 'delete' ? 'Delete ' : 'Used by: ') + esc(w.name), body: note + table, actions: UI.btn(mode === 'delete' ? 'Cancel' : 'Close', { attrs: 'data-close' }) + (mode === 'delete' ? UI.btn('Delete workflow', { kind: 'danger', attrs: 'data-ok', disabled: blocked, title: blocked ? 'Refused while a published agent or workflow uses it' : '' }) : ''), onMount(m) {
          const ok = m.querySelector('[data-ok]'); if (!ok) return;
          ok.addEventListener('click', async () => {
            App.closeOverlay();
            try { await App.del('/api/workflows/' + enc(w.id)); st.list = (st.list || []).filter((x) => x.id !== w.id); if (st.wfId === w.id) { st.wfId = null; st.wf = null; st.draft = null; st.runId = null; st.run = null; st.unsaved = false; st.tab = 'runs'; } ctx.rerender(); toast(esc(w.name) + ' deleted. The audit log keeps the record.', 'ok'); } catch (err) { App.fail(err, 'Could not delete the workflow'); }
          });
        } });
      }
      if (st.openUsedBy) {
        const mode = st.openUsedBy; st.openUsedBy = null;
        setTimeout(async () => {
          const pool = [wf].concat((st.list || []).filter((x) => x.id !== wf.id)).slice(0, 8);
          for (const w of pool) { try { const u = await App.get('/api/workflows/' + enc(w.id) + '/used-by'); if (u.deleteBlocked) { wfUsedBy(w, 'delete'); return; } } catch (err) { /* next */ } }
          toast('No workflow is used by a published agent or workflow yet, so nothing blocks a delete. Its used-by view lists what references it.', '', 7000);
          wfUsedBy(wf, 'view');
        }, 30);
      }
      ctx.on('click', '[data-export]', async () => {
        let bundle;
        try { bundle = await App.get('/api/workflows/' + enc(wf.id) + '/bundle'); } catch (err) { App.fail(err, 'Could not export the workflow'); return; }
        const text = JSON.stringify(bundle, null, 2);
        ctx.modal({ title: 'Export ' + esc(wf.name), cls: 'wide', body: UI.notice('The signed bundle of ' + (bundle.version ? 'v' + esc(bundle.version) : 'the draft') + ': the graph and its references, signed with the KMS key ' + esc(bundle.key || '') + '. Runs, versions, the registry tool and app triggers are not part of it. Audited workflow.exported.', 'info') + UI.code(text.slice(0, 40000), 'json'),
          actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Download bundle', { kind: 'primary', icon: 'download', attrs: 'data-dl' }),
          onMount(m) {
            m.querySelector('[data-dl]').addEventListener('click', () => {
              const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
              const a = document.createElement('a'); a.href = url; a.download = wf.name + '.workflow.json'; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              App.closeOverlay(); toast(esc(wf.name) + '.workflow.json downloaded.', 'ok');
            });
          } });
      });
      ctx.on('click', '[data-import]', () => {
        ctx.modal({ title: 'Import a workflow bundle', body: UI.field('Bundle (exprsn-workflow/1)', UI.textarea('', { rows: 7, placeholder: '{ "format": "exprsn-workflow/1", … }', attrs: 'data-ib' })) + '<div class="hstack wrap gap6">' + UI.btn('Read a file', { size: 'sm', icon: 'upload', attrs: 'data-ibfile' }) + '<input type="file" accept="application/json,.json" data-ibinput hidden aria-label="Bundle file"></div>'
            + UI.field('Name', UI.input('', { placeholder: 'the bundle\'s name', attrs: 'data-ibname' }), 'Lower-case letters, digits and hyphens; a name in use is refused')
            + UI.notice('The signature is checked before anything else: a bundle changed after signing is refused. References are re-bound by name; the workflow arrives as a draft in this workspace and its trigger starts nothing until you publish.', 'info') + '<div data-iberr></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Import', { kind: 'primary', attrs: 'data-ibgo' }),
          onMount(m) {
            const fileIn = m.querySelector('[data-ibinput]');
            m.querySelector('[data-ibfile]').addEventListener('click', () => fileIn.click());
            fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; if (f) f.text().then((txt) => { m.querySelector('[data-ib]').value = txt; }); });
            m.querySelector('[data-ibgo]').addEventListener('click', async (ev) => {
              const errEl = m.querySelector('[data-iberr]');
              let bundle; try { bundle = JSON.parse(m.querySelector('[data-ib]').value); } catch (x) { errEl.innerHTML = UI.notice('The bundle is not JSON.', 'danger'); return; }
              const body = { bundle }; const name = m.querySelector('[data-ibname]').value.trim(); if (name) body.name = name;
              ev.target.disabled = true;
              try {
                const out = await App.post('/api/workflows/import', body);
                App.closeOverlay();
                const w = out.workflow; st.list = [w].concat(list.filter((x) => x.id !== w.id)); st.wfId = w.id; st.wf = null; st.draft = null; st.runId = null; st.run = null; st.tab = 'runs'; st.unsaved = false;
                const missing = (out.bindings || []).filter((b) => b.status === 'missing');
                ctx.rerender(); toast('Signature verified. ' + esc(w.name) + ' imported as a draft; ' + (out.bindings || []).filter((b) => b.status === 'bound').length + ' references bound' + (missing.length ? ', ' + missing.length + ' missing: ' + esc(missing.map((b) => b.from).join(', ')) : '') + '.', missing.length ? 'warn' : 'ok', 7000);
              } catch (err) { ev.target.disabled = false; errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + ' ' + esc((err.problem && err.problem.title) || '') + '</b> ' + esc((err.problem && err.problem.detail) || err.message), 'danger'); }
            });
          } });
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
      ctx.on('click', '[data-connect]', () => { st.connectFrom = st.connectFrom === st.sel && !st.connectFailure ? null : st.sel; st.connectFailure = false; ctx.rerender(); });
      ctx.on('click', '[data-connectfail]', () => { st.connectFrom = st.connectFrom === st.sel && st.connectFailure ? null : st.sel; st.connectFailure = !!st.connectFrom; ctx.rerender(); });
      ctx.on('click', '[data-cancelconnect]', () => { st.connectFrom = null; st.connectFailure = false; ctx.rerender(); });
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
      ctx.on('click', '[data-newwf]', newWorkflow);
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
          App.get('/api/workflow-callees').then((c) => { st.callees = c; schedule(); }).catch(() => undefined);
          st.tabLoaded = null; st.tabLoading = null;
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
