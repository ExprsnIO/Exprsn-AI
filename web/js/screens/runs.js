(function () {
  const { UI, esc } = App;

  const LANES = { think: 'Thinking', do: 'Doing', calc: 'Calculating' };
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const SIDE = { read: 'read-only', write: 'write', destructive: 'destructive' };
  const STATE_TEXT = { queued: 'queued', running: 'running', waiting: 'waiting on approval', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', budget: 'budget stop' };
  const statusPill = (s) => UI.pill(STATE_TEXT[s] || s, s === 'succeeded' ? 'ok' : s === 'failed' ? 'danger' : s === 'waiting' || s === 'running' || s === 'queued' ? 'info' : s === 'budget' ? 'warn' : '');
  const sidePill = (s) => UI.pill(SIDE[s] || s || 'read-only', s === 'write' ? 'warn' : s === 'destructive' ? 'danger' : 'ok');
  const fmt = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const shortId = (id) => String(id || '').slice(-6).toLowerCase();
  const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const secs = (ms) => (ms == null ? '' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s');
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
  const active = (s) => s === 'queued' || s === 'running' || s === 'waiting';
  const KIND_TEXT = { 'agent-run': 'agent run', 'tool-call': 'tool call', 'workflow-run': 'workflow run', 'skill-load': 'skill', 'chat-turn': 'chat turn', 'plugin-action': 'plugin action', 'app-trigger': 'app trigger' };
  const NODE_TONE = { running: 'info', succeeded: 'ok', failed: 'danger', refused: 'danger', waiting: 'info', cancelled: 'warn' };
  const flatten = (n) => (n ? [n].concat((n.children || []).reduce((a, k) => a.concat(flatten(k)), [])) : []);
  const nodeTitle = (n) => (n.name || n.callee || n.kind) + (n.kind === 'agent-run' || n.kind === 'workflow-run' ? ' ' + shortId(n.ref) : '');
  const pathHtml = (path) => '<span class="runs-path">' + (path || []).map((x, i) => (i ? '<span class="sep" aria-hidden="true">›</span>' : '') + '<span><span class="muted">' + esc(KIND_TEXT[x.kind] || x.kind) + '</span> <b>' + esc(x.name || x.ref) + '</b></span>').join('') + '</span>';
  const duration = (r) => r.finishedAt && r.startedAt ? 'finished in ' + secs(r.finishedAt - r.startedAt) : r.state === 'waiting' ? 'waiting' : r.state === 'budget' ? 'stopped at its budget' : r.startedAt ? 'running for ' + secs(Date.now() - r.startedAt) : 'queued';

  // ---------- live updates: run.step and run.state for the signed-in user ----------
  const live = { sock: null, onEvent: null, timer: null, refresh: null };
  const detach = () => { if (live.sock) { live.sock.off('run.step', live.onEvent); live.sock.off('run.state', live.onEvent); } live.sock = null; live.onEvent = null; if (live.timer) { clearTimeout(live.timer); live.timer = null; } };
  const attach = () => {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.onEvent = () => {
      if (App.state.route !== 'runs') { detach(); return; }
      if (live.timer) return;
      // At most one refresh every 500 ms while a run streams steps.
      live.timer = setTimeout(() => { live.timer = null; if (live.refresh) live.refresh(); }, 500);
    };
    live.sock.on('run.step', live.onEvent);
    live.sock.on('run.state', live.onEvent);
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'runs') detach(); });

  /** Numbers in the answer that equal a calculating step's result (as rounded there), for the traceable figure. */
  function traceFigures(text, steps) {
    const calcs = steps.filter((s) => s.lane === 'calc' && s.state === 'ok' && s.detail && s.detail.result && s.detail.result.decimal != null).map((s) => ({ n: s.n, v: Number(String(s.detail.result.decimal).replace(/\.{3}$/, '')) }));
    if (!calcs.length) return esc(text);
    return esc(text).replace(/-?\d[\d,]*(?:\.\d+)?%?/g, (tok) => {
      const raw = tok.replace(/[,%]/g, '');
      const dec = (raw.split('.')[1] || '').length;
      const val = Number(raw);
      const hit = calcs.find((c) => isFinite(c.v) && Math.abs(c.v - val) <= 0.5 * Math.pow(10, -dec) + 1e-12);
      return hit ? '<button type="button" class="runs-fig" data-fig="' + hit.n + '">' + tok + '</button>' : tok;
    });
  }

  App.register({
    id: 'runs', title: 'Runs', live: true,
    summary: 'Agent run timeline by lane, step inspector, approvals, budget, replay',
    crumb: (st) => ['Runs'].concat(st.chain ? ['chain ' + shortId(st.chain)] : st.run ? [shortId(st.run)] : []),
    label: (st) => (st.chain ? (st.chainView && st.chainView.id === st.chain ? st.chainView.label : null) : st.view && st.view.id === st.run ? st.view.label : null),
    commands: [
      { label: 'Open the chain tree of this run', sub: 'Runs', run(app) { const st = app.stateFor('runs'); if (st.view && st.view.chain) { st.chain = st.view.chain.id; st.node = st.view.chain.node; app.render(); } } },
      { label: 'Start an agent run', sub: 'Runs', run(app) { app.stateFor('runs').openStart = true; app.render(); } },
      { label: 'Replay a run from a step', sub: 'Runs', run(app) { app.stateFor('runs').openReplay = true; app.render(); } }
    ],
    states: [
      { title: 'Proposal denied', tone: 'danger', text: 'The tool-call checkpoint or a label ceiling refused a call. The thinking step receives the denial as data.', apply(ctx) { ctx.state.demo = 'denied'; ctx.rerender(); } },
      { title: 'Budget stop', tone: 'warn', text: 'The run stopped at its step, token, time or tool-call limit. The last checkpoint is kept and the owner can raise the limit and resume.', apply(ctx) { ctx.state.demo = 'budget'; ctx.rerender(); } },
      { title: 'Traceable figure', tone: 'ok', text: 'Selecting a number in the final answer highlights the calculating step that produced it.', apply(ctx) { ctx.state.demo = 'figure'; ctx.rerender(); } },
      { title: 'Waiting on approval', tone: 'info', text: 'A doing step shows who must approve and how long it has waited.', apply(ctx) { ctx.state.demo = 'waiting'; ctx.rerender(); } },
      { title: 'Chain tree', tone: 'neutral', text: 'A run that delegated opens its chain as a tree: every agent run, tool call, skill load and workflow run under the root, with timing, tokens, labels and guardrail decisions. The tree\'s token total equals what the chain metered.', apply(ctx) { ctx.state.demo = 'chain'; ctx.rerender(); } },
      { title: 'Held three levels down', tone: 'info', text: 'A write call held in a delegate\'s delegate pauses the whole chain. It is approved from the root run, with the path from the root to the call shown.', apply(ctx) { ctx.state.demo = 'held'; ctx.rerender(); } },
      { title: 'Child failed with a typed error', tone: 'danger', text: 'A child that stops at its budget, is cancelled or fails reaches its caller as a typed error (an agent sees it as a tool error starting child_<type>); the node records the errorType.', apply(ctx) { ctx.state.demo = 'childfail'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      st.query = st.query || ''; st.scope = st.scope || 'mine';
      // The route's params are parsed from the hash on every render: act on them once per hash.
      if (st.seenHash !== location.hash) {
        st.seenHash = location.hash;
        if (ctx.params.run && ctx.params.run !== st.run) { st.run = ctx.params.run; st.view = null; st.sel = null; st.chain = null; }
        if (ctx.params.chain) { st.chain = ctx.params.chain; st.node = ctx.params.node || null; st.chainView = null; st.chainError = null; }
      }
      const admin = App.can('agents:manage') || App.can('tools:manage');
      const later = () => { if (App.state.route !== 'runs') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      const fetchRun = (id) => App.get('/api/runs/' + id).then((v) => { st.view = v; }).catch((err) => { st.view = { id, fetchError: err }; });
      const fetchChain = (id) => App.get('/api/chains/' + encodeURIComponent(id)).then((c) => { if (st.chain === id) { st.chainView = c; st.chainError = null; } }).catch((err) => { if (st.chain === id) { st.chainView = null; st.chainError = err; } });
      const load = () => {
        if (st.loading) { st.again = true; return; }
        st.loading = true;
        App.get('/api/runs' + (st.scope === 'all' || !App.can('agents:run') ? '?all=true' : ''))
          .then((runs) => { st.runs = runs; st.loaded = true; st.loadError = null; if (!st.run || (!runs.find((r) => r.id === st.run) && !(st.view && st.view.id === st.run))) st.run = runs[0] ? runs[0].id : null; return Promise.all([st.run ? fetchRun(st.run) : null, st.chain ? fetchChain(st.chain) : null]); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; if (st.again) { st.again = false; load(); return; } later(); });
      };
      live.refresh = load;
      attach();
      if (!st.loaded && !st.loadError) load();
      const act = async (fn, okMsg, kind) => {
        try { const r = await fn(); if (okMsg) toast(okMsg, kind || 'ok', 5000); load(); return r || true; }
        catch (err) { App.fail(err); return null; }
      };
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Runs', 'Agent runs, step by step', '') + (st.loadError ? UI.problem('Runs could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      if (ctx.params.agent) { st.openStart = ctx.params.agent; delete ctx.params.agent; }

      const runs = st.runs;

      // ---- demo states staged from live data ----
      if (st.demo) {
        const d = st.demo; st.demo = null; st.demoNote = null;
        const find = (f, note) => { const r = runs.find(f); if (r) { st.run = r.id; st.sel = null; st.view = null; st.demoFor = d; } else st.demoNote = note; return r; };
        if (d === 'denied') find((r) => r.state === 'succeeded' || r.state === 'failed', 'No finished run yet. A denied call shows as a red doing step with the reason given back to the model.');
        else if (d === 'budget') find((r) => r.state === 'budget', 'No run has hit its budget. A run that does stops with its checkpoint kept, and the owner can raise the limit here.');
        else if (d === 'waiting') find((r) => r.state === 'waiting', 'No run is waiting on approval. A write or destructive call pauses the run and shows who must approve.');
        else if (d === 'figure') { if (find((r) => r.state === 'succeeded', 'No finished run yet. Figures in a final answer link to the calculating step that produced them.')) st.showAnswer = true; }
        else if (d === 'chain' || d === 'held' || d === 'childfail') {
          const kids = (r) => runs.filter((k) => k.caller && k.caller.id === r.id);
          const pick = d === 'chain' ? runs.find((r) => r.chain && !r.caller && kids(r).length) || runs.find((r) => r.chain)
            : d === 'held' ? runs.find((r) => r.chain && r.caller && r.state === 'waiting') || runs.find((r) => r.chain && r.state === 'waiting')
              : runs.find((r) => r.chain && r.caller && (r.state === 'failed' || r.state === 'budget' || r.state === 'cancelled'));
          if (pick) { st.chain = pick.chain.id; st.node = null; st.chainView = null; st.chainPick = d; }
          else st.demoNote = d === 'chain' ? 'No run has a chain yet. Start a run; an agent that delegates opens its chain here as a tree.' : d === 'held' ? 'Nothing is held in a chain. A write call held anywhere in a chain pauses it, and is decided here from the root.' : 'No child run has failed. A child that stops reaches its caller as a typed error, shown on its node here.';
        }
      }
      const v = st.view && st.view.id === st.run ? st.view : null;
      if (st.run && !v && !st.fetching) { st.fetching = true; fetchRun(st.run).finally(() => { st.fetching = false; later(); }); }
      if (v && st.demoFor && !v.fetchError) {
        const d = st.demoFor; st.demoFor = null;
        const pick = d === 'denied' ? v.steps.find((s) => s.state === 'denied' || s.state === 'rejected') : d === 'waiting' ? v.steps.find((s) => s.state === 'waiting') : d === 'figure' ? v.steps.find((s) => s.lane === 'calc') : v.steps[v.steps.length - 1];
        if (pick) st.sel = pick.n;
        else if (d === 'denied') st.demoNote = 'This run had no denied call. When the checkpoint refuses one, its doing step turns red and the next thinking step receives the reason.';
        else if (d === 'figure') st.demoNote = 'This run has no calculating step, so no figure in its answer is traceable.';
      }

      const q = st.query.toLowerCase();
      const shown = runs.filter((r) => !q || (r.id + ' ' + r.agent + ' ' + (STATE_TEXT[r.state] || r.state) + ' ' + (r.by || '')).toLowerCase().indexOf(q) >= 0);
      const left = '<div class="leftpane"><div class="hstack"><div class="eyebrow grow">Recent runs</div>' + UI.iconbtn('refresh', 'Refresh', { cls: 'sm ghost', attrs: 'data-refresh' }) + (App.can('agents:run') ? UI.btn('Start', { size: 'sm', attrs: 'data-start' }) : '') + '</div>'
        + (App.can('agents:run') || App.can('agents:manage') ? '<div>' + UI.btn('Schedules', { size: 'sm', kind: 'ghost', icon: 'clock', attrs: 'data-schedules' }) + '</div>' : '')
        + (admin && App.can('agents:run') ? UI.seg([{ id: 'mine', label: 'Mine' }, { id: 'all', label: 'Tenant' }], st.scope, 'data-scope') : '')
        + UI.search('Filter runs', 'data-search', st.query).replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="runs-list">' + shown.map((r) => UI.listItem('<span class="mono">' + esc(shortId(r.id)) + '</span>', esc(r.agent) + (r.handedTo ? ' → ' + esc(r.handedTo.agent) : '') + ' · ' + esc(clock(r.createdAt)) + ', ' + esc(r.by || ''), { active: r.id === st.run, attrs: 'data-run="' + esc(r.id) + '"', right: statusPill(r.state) })).join('') + (shown.length ? '' : UI.empty(runs.length ? 'No runs match' : 'No runs yet', runs.length ? 'Try another word.' : 'Start a run of a published agent.')) + '</div>'
        + '<div class="muted" style="font-size:12px;margin-top:auto">Thinking steps call the model through the gateway, doing steps call tools through the tool-call checkpoint, calculating steps use the exact calculator.</div></div>';

      const style = '<style>'
        + '.runs-list{display:flex;flex-direction:column;gap:2px}.runs-page > *{flex-shrink:0}'
        + '.runs-lanes,.runs-row{display:grid;grid-template-columns:28px repeat(3,minmax(0,1fr));gap:10px;align-items:start}'
        + '.runs-lane{display:flex;justify-content:space-between;align-items:center;gap:4px 8px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--line)}'
        + '.runs-lane .ln{display:inline-flex;align-items:center;gap:4px;padding:1px 8px 1px 5px;border:1px solid var(--line);border-radius:4px;font-size:12px;font-weight:600;color:var(--fg2);background:var(--panel);white-space:nowrap}.runs-lane .ls{font-size:12px;color:var(--fg2)}'
        + '.runs-n{font-size:12px;color:var(--muted);padding-top:9px}.runs-ch{display:flex;justify-content:space-between;align-items:baseline;gap:2px 8px;flex-wrap:wrap}.runs-ch > span:first-child{overflow-wrap:anywhere;min-width:0}'
        + '.runs-card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;background:var(--panel);border:1px solid var(--line);border-radius:6px;min-width:0;cursor:pointer}.runs-card:hover{border-color:var(--muted)}.runs-card.selected{background:var(--accent-tint);border-color:var(--accent)}.runs-card.failed{border-color:var(--danger-fg)}.runs-card.waiting{border-color:var(--info-fg);border-style:dashed}.runs-card.reused{opacity:.75}'
        + '.runs-div{display:grid;grid-template-columns:28px minmax(0,1fr);gap:10px}.runs-divline{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted)}.runs-divline .rule{flex-grow:1;height:1px;background:var(--line)}.runs-divline.danger{color:var(--danger-fg)}.runs-divline.info{color:var(--info-fg)}'
        + '.runs-fig{font:inherit;font-family:var(--sans);font-size:13px;font-weight:600;padding:0 5px;border:1px solid var(--line);border-radius:4px;background:var(--panel);cursor:pointer;color:var(--fg)}.runs-fig:hover,.runs-fig.on{border-color:var(--ok-fg);background:var(--ok-bg);color:var(--ok-fg)}'
        + '@media (max-width:900px){.runs-lanes{display:none}.runs-row{grid-template-columns:28px 1fr}.runs-row > div:empty{display:none}}'
        + '.runs-tree{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;min-width:0}.runs-tree .runs-tree{padding-left:12px;margin-left:10px;border-left:1px solid var(--line)}'
        + '.runs-node{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;width:100%;min-width:0;text-align:left;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--fg);font:inherit;font-size:13px;cursor:pointer}'
        + '.runs-node:hover{background:var(--panel2)}.runs-node.selected{background:var(--accent-tint);border-color:var(--accent)}.runs-node.held{border-color:var(--info-fg);border-style:dashed}'
        + '.runs-node .nk{font-size:11px;color:var(--fg2);border:1px solid var(--line);border-radius:4px;padding:0 5px;white-space:nowrap}.runs-node .nn{font-weight:600;overflow-wrap:anywhere;min-width:0}.runs-node .nm{font-size:12px;color:var(--fg2);margin-left:auto;white-space:nowrap}'
        + '.runs-path{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;font-size:12px}.runs-path .sep{color:var(--muted)}.runs-path b{font-weight:600;overflow-wrap:anywhere}'
        + '@media (max-width:640px){.runs-tree .runs-tree{padding-left:6px;margin-left:4px}}'
        + '</style>';

      if (st.chain) { renderChain(); return; }
      let page;
      let inspector = '';
      if (!st.run) page = '<div class="page runs-page">' + UI.pagehead('Runs', 'Agent runs, step by step', '') + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '') + UI.empty('No runs yet', 'Start a run of a published agent; its thinking, doing and calculating steps appear here as they happen.', App.can('agents:run') ? UI.btn('Start a run', { kind: 'primary', attrs: 'data-start' }) : '') + '</div>';
      else if (!v) page = '<div class="page">' + UI.notice('Loading…', 'info') + '</div>';
      else if (v.fetchError) page = '<div class="page">' + UI.problem('The run could not be loaded', v.fetchError.message, v.fetchError.problem && v.fetchError.problem.trace_id) + '</div>';
      else {
        const me = App.me && App.me.user ? App.me.user : {};
        const owner = v.userId === me.id;
        const steps = v.steps;
        if (st.sel == null || !steps.find((s) => s.n === st.sel)) { const w = steps.find((s) => s.state === 'waiting' || s.state === 'failed' || s.state === 'denied'); st.sel = w ? w.n : steps.length ? steps[steps.length - 1].n : null; }
        const sel = steps.find((s) => s.n === st.sel);
        const lanes = v.lanes;
        const laneSum = { think: lanes.think.steps + ' step' + (lanes.think.steps === 1 ? '' : 's') + ', ' + fmt(lanes.think.tokens) + ' tokens', do: lanes.do.calls + ' call' + (lanes.do.calls === 1 ? '' : 's') + ', ' + secs(lanes.do.ms) + (lanes.do.waiting ? ', ' + lanes.do.waiting + ' waiting' : '') + (lanes.do.denied ? ', ' + lanes.do.denied + ' denied' : ''), calc: lanes.calc.results + ' result' + (lanes.calc.results === 1 ? '' : 's') + ', ' + secs(lanes.calc.ms) };
        const bodyOf = (s) => {
          const d = s.detail || {};
          if (s.lane === 'think') return (s.meta.proposal && s.meta.proposal.length ? 'proposal: call ' + s.meta.proposal.join(', ') : 'answer: ' + clip(d.content, 120));
          if (s.state === 'waiting' && s.meta.awaiting) return 'waiting on ' + (s.meta.awaiting.kind === 'agent-run' ? 'agent run ' : 'workflow run ') + shortId(s.meta.awaiting.id) + ', started ' + clock(s.createdAt);
          if (s.state === 'waiting') return 'waiting on approval: ' + (s.meta.approvers || '') + ', requested ' + clock(s.createdAt);
          if (s.lane === 'calc') return (d.arguments && d.arguments.expression ? d.arguments.expression : '') + (d.result && d.result.decimal ? ' = ' + clip(d.result.decimal, 24) : d.error ? ': ' + clip(d.error, 80) : '');
          return d.error ? clip(d.error, 120) : clip(JSON.stringify(d.result), 120);
        };
        const metaOf = (s) => s.lane === 'think' ? fmt(s.meta.tokens) + ' tok' : (s.lane === 'do' ? (SIDE[s.meta.sideEffect] || '') + ', ' : '') + (s.state === 'waiting' ? 'waiting ' + Math.round((Date.now() - s.createdAt) / 60000) + ' min' : s.state === 'denied' ? 'denied' : s.state === 'rejected' ? 'rejected' : secs(s.meta.durationMs));
        const bad = (s) => s.state === 'failed' || s.state === 'denied' || s.state === 'rejected';
        const card = (s) => '<div class="runs-card' + (bad(s) ? ' failed' : '') + (s.state === 'waiting' ? ' waiting' : '') + (s.meta.reused ? ' reused' : '') + (st.sel === s.n ? ' selected' : '') + '" data-step="' + s.n + '" role="button" tabindex="0"><div class="runs-ch"><span style="font-size:13px;font-weight:600">' + esc(s.title) + '</span><span class="muted" style="font-size:12px">' + esc(metaOf(s)) + '</span></div><div class="mono fg2" style="overflow-wrap:anywhere">' + esc(bodyOf(s)) + '</div></div>';
        const rows = steps.map((s) => {
          let h = '<div class="runs-row"><div class="runs-n num">' + s.n + '</div>' + ['think', 'do', 'calc'].map((l) => '<div>' + (s.lane === l ? card(s) : '') + '</div>').join('') + '</div>';
          const divider = (tone, text) => '<div class="runs-div"><div></div><div class="runs-divline' + (tone ? ' ' + tone : '') + '"><span class="rule"></span><span>' + text + '</span><span class="rule"></span></div></div>';
          if (s.state === 'denied') h += divider('danger', 'Refused: ' + esc(clip((s.detail || {}).error, 160)) + ' The reason goes back to the thinking step as data.');
          else if (s.state === 'rejected') h += divider('danger', 'Rejected by ' + esc((s.meta.approval && s.meta.approval.by) || 'the approver') + '. Nothing was run; the next thinking step hears why.');
          else if (s.state === 'waiting' && s.meta.awaiting && s.meta.awaiting.kind === 'agent-run') h += divider('info', 'Waiting on the child run ' + esc(shortId(s.meta.awaiting.id)) + '. This run holds its checkpoint and continues with the child\'s answer or its typed error.');
          else if (s.state === 'waiting' && s.meta.awaiting) h += divider('info', 'The workflow waits on ' + esc(s.meta.approvers || 'its approvers') + '. This run holds its checkpoint and continues with the result when the workflow finishes.');
          else if (s.state === 'waiting' && v.caller) h += divider('info', 'Held for approval. The chain waits; the call is decided from the root, where the path is shown.');
          else if (s.state === 'waiting') h += divider('info', 'Approval requested from ' + esc(s.meta.approvers || 'an approver') + ', ' + Math.round((Date.now() - s.createdAt) / 60000) + ' min ago. The run holds its checkpoint until a decision.');
          else if (s.lane !== 'think' && s.meta.approval) h += divider('', 'Approved by ' + esc(s.meta.approval.by || '') + '.');
          if (s.meta.warning) h += divider('', esc(s.meta.warning));
          return h;
        }).join('');

        // Inspector for the selected step.
        let kv = [];
        let actions = '';
        if (sel) {
          const d = sel.detail || {};
          if (sel.lane === 'think') {
            kv = [['Proposal', sel.meta.proposal && sel.meta.proposal.length ? '<span class="mono">call ' + esc(sel.meta.proposal.join(', ')) + '</span>' : 'final answer'], ['Tokens', fmt(sel.meta.tokens)], ['Profile', '<a href="#" data-goprofile="' + esc(sel.meta.profile) + '">' + esc(sel.meta.profile) + '</a> on <span class="mono">' + esc(sel.meta.model) + '</span>'], ['Duration', secs(sel.meta.durationMs)], ['Output', esc(clip(d.content, 300)) || '<span class="muted">none, only tool calls</span>'], ['Label', UI.label(v.label, { sm: true })]];
            actions = (!sel.meta.proposal || !sel.meta.proposal.length) && v.output ? UI.btn(st.showAnswer ? 'Hide final answer' : 'Show final answer', { attrs: 'data-toggleanswer' }) : UI.btn('Show thinking trace', { icon: 'brain', attrs: 'data-trace' });
          } else if (sel.lane === 'calc') {
            kv = [['Expression', '<span class="mono">' + esc((d.arguments || {}).expression || '') + '</span>'], ['Result', d.result ? '<span class="mono">' + esc(d.result.decimal) + '</span>' : '<span style="color:var(--danger-fg)">' + esc(d.error || '') + '</span>'], ['Exact fraction', d.result ? '<span class="mono">' + esc(clip(d.result.fraction, 80)) + '</span>' + (d.result.exact ? '' : ' <span class="muted">decimal is rounded</span>') : ''], ['Tool', '<span class="mono">' + esc(sel.meta.tool) + ' ' + esc(sel.meta.version || '') + '</span>'], ['Duration', secs(sel.meta.durationMs)], ['Guardrail', esc(sel.meta.decision || 'not reached')], ['Label', UI.label(v.label, { sm: true })]];
            actions = d.result ? UI.btn('Copy with provenance', { attrs: 'data-copyprov' }) : bad(sel) ? UI.btn('Replay from this step', { icon: 'refresh', attrs: 'data-replay="' + sel.n + '"' }) : '';
          } else {
            const ap = sel.meta.approval;
            kv = [['Tool', '<span class="mono">' + esc(sel.meta.tool || sel.title) + '</span> ' + esc(sel.meta.version || '') + (sel.meta.impl === 'mcp' ? ' <span class="muted">(MCP server ' + esc(String(sel.meta.tool).split('.')[0]) + ')</span>' : '')], ['Side effect class', sidePill(sel.meta.sideEffect)], ['Tool ceiling', sel.meta.ceiling ? UI.label(sel.meta.ceiling, { sm: true }) : ''], ['Arguments', '<span class="mono">' + esc(clip(JSON.stringify(d.arguments || {}), 300)) + '</span>']];
            if (sel.state === 'waiting' && sel.meta.awaiting) kv.push(['Waiting on', sel.meta.awaiting.kind === 'agent-run' ? 'agent run <a href="#" data-run="' + esc(sel.meta.awaiting.id) + '" class="mono">' + esc(shortId(sel.meta.awaiting.id)) + '</a>' : 'workflow run <a href="#" data-gowfrun="' + esc(sel.meta.awaiting.id) + '" class="mono">' + esc(shortId(sel.meta.awaiting.id)) + '</a>'], ['Started', esc(clock(sel.createdAt))], ['Waited', Math.round((Date.now() - sel.createdAt) / 60000) + ' min'], ['When it finishes', 'this run continues with its result, or its failure']);
            else if (sel.state === 'waiting') kv.push(['Must approve', esc(sel.meta.approvers || '')], ['Requested', esc(clock(sel.createdAt)) + ', from the run'], ['Waited', Math.round((Date.now() - sel.createdAt) / 60000) + ' min'], ['If nobody approves', 'the run keeps its checkpoint; cancel it to stop']);
            else kv.push(['Outcome', sel.state === 'ok' ? UI.pill('ok', 'ok') : '<span style="color:var(--danger-fg)">' + esc(d.error || sel.state) + '</span>'], ['Duration', secs(sel.meta.durationMs)], ['Guardrail', esc(sel.meta.decision || 'not reached')], ['Typed result', sel.meta.valid == null ? '<span class="muted">no output schema</span>' : UI.pill(sel.meta.valid ? 'matches output schema' : 'schema mismatch', sel.meta.valid ? 'ok' : 'danger')]);
            if (ap) kv.push([ap.decision === 'approved' ? 'Approved by' : 'Rejected by', esc(ap.by || '') + (ap.note ? ': ' + esc(ap.note) : '')]);
            kv.push(['Label', UI.label(v.label, { sm: true })]);
            const canDecide = sel.state === 'waiting' && !sel.meta.awaiting && (sel.meta.sideEffect === 'destructive' ? App.can('tools:manage') && !owner : owner || App.can('tools:manage'));
            const chainBtn = v.chain ? UI.btn('Open the chain tree', { kind: 'ghost', attrs: 'data-openchain' }) : '';
            actions = sel.state === 'waiting' && sel.meta.awaiting ? '<div class="hstack gap6 wrap">' + (sel.meta.awaiting.kind === 'agent-run' ? UI.btn('Open the child run', { attrs: 'data-run="' + esc(sel.meta.awaiting.id) + '"' }) : UI.btn('Open the workflow run', { attrs: 'data-gowfrun="' + esc(sel.meta.awaiting.id) + '"' })) + chainBtn + '</div>'
              : sel.state === 'waiting' && v.caller ? UI.notice('Held for the chain this run belongs to. It is decided from the root, where the path from the root is shown.', 'info', v.chain ? UI.btn('Open the chain tree', { size: 'sm', attrs: 'data-openchain' }) : '')
              : sel.state === 'waiting' ? (canDecide ? '<div class="hstack gap6">' + UI.btn('Approve', { kind: 'primary', attrs: 'data-approve' }) + UI.btn('Deny', { attrs: 'data-deny' }) + '</div>' : UI.notice(sel.meta.awaiting ? 'Waiting for the workflow to finish. Its approvers decide on the Workflows screen.' : 'Waiting for ' + esc(sel.meta.approvers || 'an approver') + '.', 'info'))
              : bad(sel) ? UI.btn('Replay from this step', { icon: 'refresh', attrs: 'data-replay="' + sel.n + '"' }) : UI.btn('Show result segment', { attrs: 'data-segment' });
          }
        }
        const b = v.budgets; const u = v.usage;
        const meter = (label, used, max, text) => UI.meter(label, text || fmt(used) + ' of ' + fmt(max), max ? (used / max) * 100 : 0, used >= max ? 'danger' : used / max > 0.8 ? 'warn' : '');
        inspector = '<aside class="inspector">' + (sel ? '<div class="hstack"><div class="eyebrow grow">Step ' + sel.n + ', ' + esc(LANES[sel.lane].toLowerCase()) + '</div>' + (bad(sel) ? UI.pill(sel.state, 'danger') : sel.state === 'waiting' ? UI.pill('waiting', 'info') : sel.meta.reused ? UI.pill('reused', 'outline') : '') + '</div>' + UI.kv(kv, 1) + actions : UI.empty('No steps yet', v.state === 'queued' ? 'The run is queued for a worker.' : ''))
          + '<div class="eyebrow">Budget</div>'
          + meter('Steps', u.steps, b.steps) + meter('Tokens', u.tokens, b.tokens) + meter('Wall time', u.wallMs / 1000, b.wallSeconds, secs(u.wallMs) + ' of ' + b.wallSeconds + ' s') + meter('Tool calls', u.toolCalls, b.toolCalls)
          + '<div class="muted" style="font-size:12px">Metered per lane: tokens for thinking, calls and seconds for doing, results for calculating. Checkpoints after steps ' + esc(v.checkpoints.join(', ')) + '.</div></aside>';

        const answer = st.showAnswer && v.output ? '<section class="panel" id="runs-answer"><div class="phead"><div class="eyebrow">Final answer, step ' + (steps.length ? steps[steps.length - 1].n : '') + '</div><span class="muted" style="font-size:12px">Select a figure to see the calculating step that produced it</span></div><div class="serif" style="font-size:15px;line-height:1.6;white-space:pre-wrap">' + traceFigures(v.output, steps) + '</div></section>' : '';
        const notice = v.state === 'budget' ? UI.notice('<b>Budget stop.</b> ' + esc(v.error || '') + ' The last checkpoint is kept; raise the limit to resume from it.', 'warn', owner || App.can('agents:manage') ? UI.btn('Raise limit and resume', { size: 'sm', attrs: 'data-raise' }) : '')
          : v.state === 'failed' ? UI.notice('<b>Failed.</b> ' + esc(v.error || ''), 'danger', owner || App.can('agents:manage') ? UI.btn('Replay from step', { size: 'sm', attrs: 'data-replay="' + (steps.find(bad) || steps[steps.length - 1] || { n: 1 }).n + '"' }) : '')
            : v.state === 'waiting' ? UI.notice('<b>' + (steps.some((x) => x.state === 'waiting' && x.meta.awaiting && x.meta.awaiting.kind === 'agent-run') ? 'Waiting on a child run.' : steps.some((x) => x.state === 'waiting' && x.meta.awaiting) ? 'Waiting on a workflow.' : 'Waiting on approval.') + '</b> ' + esc(v.error || ''), 'info')
              : v.state === 'cancelled' ? UI.notice(esc(v.error || 'Cancelled.'), 'warn') : '';
        const canControl = owner || App.can('agents:manage');
        page = '<div class="page runs-page">'
          + UI.pagehead('Run ' + shortId(v.id) + ', ' + esc(v.agent) + ' ' + esc(v.agentVersion), 'Started ' + esc(clock(v.startedAt || v.createdAt)) + ' by ' + esc(v.by || '') + ', ' + esc(duration(v)) + ' · ' + statusPill(v.state) + (v.handedTo ? ' · answered by <b>' + esc(v.handedTo.agent) + '</b>, handed off to run <a href="#" data-run="' + esc(v.handedTo.run) + '" class="mono">' + esc(shortId(v.handedTo.run)) + '</a>' : '') + (v.caller ? ' · ' + (v.caller.kind === 'agent-run' ? 'delegated by run <a href="#" data-run="' + esc(v.caller.id) + '" class="mono">' + esc(shortId(v.caller.id)) + '</a>' : v.caller.kind === 'workflow-run' ? 'started by workflow run <a href="#" data-gowfrun="' + esc(v.caller.id) + '" class="mono">' + esc(shortId(v.caller.id)) + '</a>' : 'started by ' + esc(v.caller.kind)) : '') + (v.replayOf ? ' · replay of <a href="#" data-run="' + esc(v.replayOf) + '">' + esc(shortId(v.replayOf)) + '</a> from step ' + v.replayFrom : '') + ' · profile <a href="#" data-goprofile="' + esc(v.profile || '') + '">' + esc(v.profile || '') + '</a>',
            (v.chain ? UI.btn('Chain tree', { icon: 'branch', attrs: 'data-openchain' }) : '') + (canControl && active(v.state) ? UI.btn('Cancel run', { attrs: 'data-cancel' }) : '') + (canControl && steps.length ? UI.btn('Replay from step', { attrs: 'data-replay="' + (steps.find(bad) || { n: 1 }).n + '"' }) : ''))
          + (v.caller && v.caller.kind === 'chat-turn' ? UI.notice('Started from a conversation. ' + (v.caller.conversationId ? '<a href="#/chat?id=' + esc(v.caller.conversationId) + '" data-goconv="' + esc(v.caller.conversationId) + '">Open the conversation</a>; the answer lands there, attributed to ' + esc(v.agent) + '.' : 'The answer lands there, attributed to ' + esc(v.agent) + '.'), 'info') : '')
          + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '')
          + (v.held || []).map((h) => heldNotice(v.chain ? v.chain.id : '', h)).join('')
          + notice
          + (v.handedTo ? UI.notice('<b>Handed off.</b> ' + esc(v.agent) + ' handed the conversation to <b>' + esc(v.handedTo.agent) + '</b> with the context it chose; the answer is ' + esc(v.handedTo.agent) + '\'s and this run ended with it.', 'info', UI.btn('Open run ' + esc(shortId(v.handedTo.run)), { size: 'sm', attrs: 'data-run="' + esc(v.handedTo.run) + '"' })) : '')
          + ((v.children || []).length ? UI.panel('Delegated and started', UI.kv(v.children.map((k) => [k.kind === 'agent-run' ? 'agent run' : 'workflow run', (k.kind === 'agent-run' ? '<a href="#" data-run="' + esc(k.id) + '" class="mono">' + esc(shortId(k.id)) + '</a> ' + esc(k.agent || '') : '<a href="#" data-gowfrun="' + esc(k.id) + '" class="mono">' + esc(shortId(k.id)) + '</a>') + ' ' + statusPill(k.state) + ' ' + UI.label(k.label, { sm: true }) + (k.error ? '<div class="fg2" style="font-size:12px;overflow-wrap:anywhere">' + esc(clip(k.error, 200)) + '</div>' : '')]), 1), { actions: v.chain ? UI.btn('Chain tree', { size: 'sm', kind: 'ghost', attrs: 'data-openchain' }) : '' }) : '')
          + UI.panel('Request', '<div class="fg2" style="white-space:pre-wrap">' + esc(clip(v.input, 2000)) + '</div>')
          + '<div class="runs-lanes"><div></div>' + ['think', 'do', 'calc'].map((l) => '<div class="runs-lane"><span class="ln">' + UI.icon(l === 'think' ? 'brain' : l === 'do' ? 'play' : 'calc', 12) + esc(LANES[l]) + '</span><span class="ls">' + esc(laneSum[l]) + '</span></div>').join('') + '</div>'
          + (rows || '<div class="muted">No steps yet.</div>')
          + answer
          + '</div>';
      }
      root.innerHTML = style + left + page + inspector;

      // ---- events ----
      const run = v && !v.fetchError ? v : null;
      const sel = run ? run.steps.find((s) => s.n === st.sel) : null;
      ctx.on('click', '[data-run]', (e, t) => { e.preventDefault(); st.run = t.dataset.run; st.sel = null; st.showAnswer = false; st.view = null; st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-scope] [data-seg]', (e, t) => { st.scope = t.dataset.seg; load(); });
      ctx.on('click', '[data-goconv]', (e, t) => { e.preventDefault(); ctx.navigate('chat', { id: t.dataset.goconv }); });
      ctx.on('click', '[data-openchain]', () => { if (!run || !run.chain) return; st.chain = run.chain.id; st.node = (run.held || []).length ? run.held[0].node : run.chain.node; st.chainView = null; st.chainError = null; ctx.rerender(); });
      ctx.on('click', '[data-gowfrun]', (e, t) => { e.preventDefault(); ctx.navigate('workflows', { run: t.dataset.gowfrun }); });
      bindHeld(run && run.chain ? run.chain.id : null, (run && run.held) || []);
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const val = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(val.length, val.length); });
      ctx.on('click', '[data-refresh]', () => { load(); toast('Runs refreshed.'); });
      ctx.on('click', '.runs-card', (e, t) => { st.sel = +t.dataset.step; ctx.rerender(); });
      ctx.on('keydown', '.runs-card', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = +t.dataset.step; ctx.rerender(); } });
      ctx.on('click', '[data-fig]', (e, t) => { st.sel = +t.dataset.fig; ctx.rerender(); setTimeout(() => { const c = ctx.$('.runs-card.selected'); if (c) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 20); });
      ctx.on('click', '[data-toggleanswer]', () => { st.showAnswer = !st.showAnswer; ctx.rerender(); });
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', '[data-start]', () => startModal(''));
      ctx.on('click', '[data-schedules]', () => schedulesModal());
      ctx.on('click', '[data-copyprov]', () => {
        const d = sel.detail;
        const text = d.arguments.expression + ' = ' + d.result.decimal + ' (exactly ' + d.result.fraction + '); run ' + run.id + ' step ' + sel.n + ', ' + sel.meta.tool + ' ' + (sel.meta.version || '') + ', label ' + run.label;
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => undefined);
        toast('Copied <b>' + esc(clip(d.result.decimal, 24)) + '</b> with its expression, exact fraction, run, step and label.', 'ok');
      });
      ctx.on('click', '[data-trace]', () => { const d = sel.detail || {}; ctx.drawer({ title: 'Thinking trace, step ' + sel.n, body: UI.kv([['Tokens', fmt(sel.meta.tokens)], ['Profile', esc(sel.meta.profile) + ', <span class="mono">' + esc(sel.meta.model) + '</span>']], 2) + '<div style="padding:10px 12px;border-left:2px solid var(--line);font-size:13px;color:var(--fg2);font-style:italic;white-space:pre-wrap">' + esc(d.thinking || d.content || 'The model gave no thinking text for this step.') + '</div>' + (d.toolCalls && d.toolCalls.length ? UI.code(JSON.stringify(d.toolCalls, null, 2), 'json') : '') + UI.notice('Thinking output is a proposal only. Nothing ran until the tool-call checkpoint allowed it.', 'info'), actions: UI.btn('Close', { attrs: 'data-close' }) }); });
      ctx.on('click', '[data-segment]', () => ctx.modal({ title: 'Result segment, step ' + sel.n, body: UI.ctx(sel.title + ' result', JSON.stringify((sel.detail || {}).result, null, 2), run.label) + '<div class="fg2">Returned to the model as the tool\'s message and fed to the next thinking step.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) }));
      ctx.on('click', '[data-replay]', (e, t) => openReplay(+t.dataset.replay));
      ctx.on('click', '[data-cancel]', async () => { const ok = await ctx.confirm({ title: 'Cancel run ' + esc(shortId(run.id)), tone: 'danger', ok: 'Cancel run', cancel: 'Keep running', body: '<div class="fg2">The run stops at once. Steps so far and their checkpoints are kept; you can replay from any of them.</div>' }); if (ok) act(() => App.post('/api/runs/' + run.id + '/cancel'), 'Run ' + esc(shortId(run.id)) + ' cancelled.', 'warn'); });
      ctx.on('click', '[data-raise]', () => {
        const b = run.budgets; const u = run.usage;
        const next = { steps: Math.min(100, Math.max(b.steps, u.steps) * 2), tokens: Math.min(200000, Math.max(b.tokens, u.tokens) * 2), wallSeconds: Math.min(3600, Math.max(b.wallSeconds, Math.ceil(u.wallMs / 1000)) * 2), toolCalls: Math.min(100, Math.max(b.toolCalls, u.toolCalls) * 2) };
        ctx.modal({ title: 'Raise the limit and resume', body: '<div class="fg2">The run keeps its checkpoint. Raising the limit applies to this run only; the agent\'s default stays as it is.</div><div class="formgrid">' + UI.field('Steps (used ' + u.steps + ')', UI.input(String(next.steps), { type: 'number', attrs: 'data-b="steps"' })) + UI.field('Tokens (used ' + fmt(u.tokens) + ')', UI.input(String(next.tokens), { type: 'number', attrs: 'data-b="tokens"' })) + UI.field('Wall time, seconds (used ' + Math.ceil(u.wallMs / 1000) + ')', UI.input(String(next.wallSeconds), { type: 'number', attrs: 'data-b="wallSeconds"' })) + UI.field('Tool calls (used ' + u.toolCalls + ')', UI.input(String(next.toolCalls), { type: 'number', attrs: 'data-b="toolCalls"' })) + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Raise and resume', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const budgets = {}; m.querySelectorAll('[data-b]').forEach((x) => { budgets[x.dataset.b] = Number(x.value); }); App.closeOverlay(); act(() => App.post('/api/runs/' + run.id + '/resume', { budgets }), 'Limits raised. Run ' + esc(shortId(run.id)) + ' resumed from its checkpoint.'); }); } });
      });
      const decide = async (decision) => {
        const d = sel.detail || {};
        if (decision === 'approve') {
          const ok = await ctx.confirm({ title: 'Approve ' + esc(sel.title), tag: SIDE[sel.meta.sideEffect], tone: 'primary', ok: 'Approve', body: '<div class="fg2">The doing step runs the call with ' + (sel.meta.impl === 'mcp' ? 'the server\'s credentials for the run\'s owner' : 'the tool\'s sandbox') + '. The decision is written to the audit chain with you as approver.</div>', kv: [['Arguments', '<span class="mono">' + esc(clip(JSON.stringify(d.arguments || {}), 200)) + '</span>'], ['Tool ceiling', esc(sel.meta.ceiling || '')], ['Waited', Math.round((Date.now() - sel.createdAt) / 60000) + ' min']] });
          if (ok) act(() => App.post('/api/runs/' + run.id + '/steps/' + sel.n + '/decision', { decision: 'approve' }), 'Approved. The run continues from its checkpoint.');
          return;
        }
        ctx.modal({ title: 'Deny this action', body: '<div class="fg2">Nothing is run. The agent receives the denial as data and its next thinking step decides how to report it.</div>' + UI.field('Reason (given to the model and the owner)', UI.textarea('', { rows: 2, attrs: 'data-note' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Deny', { kind: 'danger', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const note = m.querySelector('[data-note]').value.trim() || null; App.closeOverlay(); act(() => App.post('/api/runs/' + run.id + '/steps/' + sel.n + '/decision', { decision: 'reject', note }), 'Denied. The run continues with the denial as data.', 'warn'); }); } });
      };
      ctx.on('click', '[data-approve]', () => decide('approve'));
      ctx.on('click', '[data-deny]', () => decide('reject'));

      function atKey(h) { return h.at.kind === 'agent-run' ? 's' + h.at.step : 'a' + h.at.approval; }
      function heldNotice(chainId, h) {
        const name = h.path && h.path.length ? h.path[h.path.length - 1].name : '';
        const buttons = h.canDecide && chainId ? '<span class="hstack gap6">' + UI.btn('Reject', { size: 'sm', attrs: 'data-heldreject="' + esc(h.node) + '|' + esc(atKey(h)) + '"' }) + UI.btn('Approve', { size: 'sm', kind: 'primary', attrs: 'data-heldapprove="' + esc(h.node) + '|' + esc(atKey(h)) + '"' }) + '</span>' : '';
        return UI.notice('<b>Held down the chain, depth ' + esc(String(h.path && h.path.length ? h.path[h.path.length - 1].depth : '')) + '.</b> <span class="mono">' + esc(h.tool || 'a call') + '</span>' + (h.sideEffect ? ' (' + esc(SIDE[h.sideEffect] || h.sideEffect) + ')' : '') + ' in ' + esc(name) + (h.since ? ', waiting since ' + esc(clock(h.since)) : '') + ' on ' + esc(h.approvers || 'an approver') + '. The whole chain waits' + (h.canDecide ? '; decide it here, at the root.' : '.') + '<div style="margin-top:6px">' + pathHtml(h.path) + '</div>', 'info', buttons);
      }
      /** Approve and reject a call held anywhere in the chain, from the root (POST /api/chains/:id/held/:node/decision). */
      function bindHeld(chainId, held) {
        if (!chainId) return;
        const find = (key) => { const i = key.indexOf('|'); return held.find((h) => h.node === key.slice(0, i) && atKey(h) === key.slice(i + 1)); };
        const send = (h, decision, note) => act(() => App.post('/api/chains/' + encodeURIComponent(chainId) + '/held/' + encodeURIComponent(h.node) + '/decision', Object.assign({ decision, note: note || null }, h.at.kind === 'agent-run' ? { step: h.at.step } : { approval: h.at.approval })), decision === 'approve' ? 'Approved from the root. The chain resumes where it waited.' : 'Rejected from the root. The agent hears why and goes on.', decision === 'approve' ? 'ok' : 'warn').then(() => { if (st.chain) fetchChain(st.chain).then(later); });
        ctx.on('click', '[data-heldapprove]', async (e, t) => {
          const h = find(t.dataset.heldapprove); if (!h) return;
          const ok = await ctx.confirm({ title: 'Approve ' + esc(h.tool || 'the call') + ' from the root', tag: SIDE[h.sideEffect] || h.sideEffect || '', tone: 'primary', ok: 'Approve', body: '<div class="fg2">The call runs where it waits, as the chain\'s principal; every run above it continues when it returns. Written to the audit chain as chain.held.decided.</div>' + pathHtml(h.path), kv: [['Chain', '<span class="mono">' + esc(shortId(chainId)) + '</span>'], ['Waits in', esc(h.at.kind === 'agent-run' ? 'agent run ' + shortId(h.at.run) + ', step ' + h.at.step : 'workflow run ' + shortId(h.at.run) + ', step ' + h.at.step)]] });
          if (ok) send(h, 'approve');
        });
        ctx.on('click', '[data-heldreject]', (e, t) => {
          const h = find(t.dataset.heldreject); if (!h) return;
          ctx.modal({ title: 'Reject ' + esc(h.tool || 'the call'), body: '<div class="fg2">Nothing is run. The agent or workflow where it waits is told who rejected it and why.</div>' + pathHtml(h.path) + UI.field('Reason (given to the agent and the owner)', UI.textarea('', { rows: 2, attrs: 'data-note' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const note = m.querySelector('[data-note]').value.trim(); App.closeOverlay(); send(h, 'reject', note); }); } });
        });
      }

      function openReplay(from) {
        if (!run || !run.steps.length) return;
        ctx.modal({ title: 'Replay from step', body: UI.field('Start from', UI.select(run.steps.map((s) => ({ value: String(s.n), label: 'Step ' + s.n + ', ' + s.title + ' (' + LANES[s.lane].toLowerCase() + ')' })), String(from), 'data-from')) + UI.notice('Replay starts from the checkpoint before the chosen step. Earlier steps are reused from the run record; later steps run again as a new run with the same label and budget. Approvals are asked for again.', 'info') + UI.kv([['Source run', '<span class="mono">' + esc(shortId(run.id)) + '</span>'], ['Budget', run.budgets.steps + ' steps, ' + fmt(run.budgets.tokens) + ' tokens'], ['Label', UI.label(run.label, { sm: true })]], 2), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Replay', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => { const n = +m.querySelector('[data-from]').value; App.closeOverlay(); const r = await act(() => App.post('/api/runs/' + run.id + '/replay', { fromStep: n }), 'Replay queued from step ' + n + '.'); if (r && r.id) { st.run = r.id; st.sel = null; st.view = null; } });
        } });
      }
      function startModal(agentName) {
        App.get('/api/agents').then((agents) => {
          if (!agents.length) { toast('No agent is published to this workspace yet. Publish one in the Registry.', 'warn'); return; }
          const me = App.me && App.me.user ? App.me.user : {};
          const pick = agents.find((a) => a.name === agentName) || agents[0];
          ctx.modal({ title: 'Start an agent run', body: UI.field('Agent', UI.select(agents.map((a) => ({ value: a.id, label: a.name + ' ' + a.version + (a.deprecated ? ' (deprecated)' : '') })), pick.id, 'data-agent')) + '<div data-agentinfo></div>' + UI.field('Request', UI.textarea('', { rows: 4, attrs: 'data-input', placeholder: 'What should the agent do?' })) + UI.field('Data label', UI.select(LABELS.filter((l) => !me.clearance || LABELS.indexOf(l) <= LABELS.indexOf(me.clearance)), 'internal', 'data-label'), 'The run may not exceed the agent\'s ceiling or the workspace\'s'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Start run', { kind: 'primary', attrs: 'data-ok' }), onMount(m) {
            const info = () => { const a = agents.find((x) => x.id === m.querySelector('[data-agent]').value); m.querySelector('[data-agentinfo]').innerHTML = UI.kv([['Profile', esc(a.profile)], ['Tools', esc(a.tools.join(', ') || 'none')], ['Limits', esc(a.budgets.steps + ' steps, ' + fmt(a.budgets.tokens) + ' tokens, ' + a.budgets.wallSeconds + ' s')], ['Ceiling', UI.label(a.label, { sm: true })]], 2) + (a.deprecated ? UI.notice('Deprecated' + (a.replacement ? '; use ' + esc(a.replacement) : '') + '.', 'warn') : ''); };
            m.querySelector('[data-agent]').addEventListener('change', info); info();
            m.querySelector('[data-ok]').addEventListener('click', async () => { const body = { agent: m.querySelector('[data-agent]').value, input: m.querySelector('[data-input]').value.trim(), label: m.querySelector('[data-label]').value }; if (!body.input) { toast('Write a request for the agent first.', 'warn'); return; } App.closeOverlay(); const r = await act(() => App.post('/api/runs', body), 'Run started. Steps appear as they happen.'); if (r && r.id) { st.run = r.id; st.sel = null; st.view = null; st.scope = 'mine'; } });
          } });
        }).catch((err) => App.fail(err, 'Agents could not be loaded'));
      }
      /**
       * Scheduled runs (B-1306): each starts at its UTC cron time as its owner, with the roles and memberships the
       * owner holds then; a disabled owner or one who lost access gets a skip in the history instead of a run.
       */
      function schedulesModal() {
        const me = App.me && App.me.user ? App.me.user : {};
        const when2 = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
        const OUT = { started: 'ok', skipped: 'warn', failed: 'danger' };
        let list = []; let agents = []; let hist = null; let err = null;
        const fetchAll = () => Promise.all([App.get('/api/agent-schedules' + (App.can('agents:run') ? '' : '?all=true')), App.can('agents:run') ? App.get('/api/agents') : Promise.resolve([])]).then(([a, b]) => { list = a; agents = b; err = null; }).catch((e) => { err = e; });
        const draw = (host) => {
          const rows = list.map((x) => [esc(x.name) + (x.mine ? '' : '<div class="muted" style="font-size:12px">' + esc(x.owner || '') + '</div>'), esc(x.agent), '<span class="mono">' + esc(x.cron) + '</span><div class="muted" style="font-size:12px">next ' + esc(x.enabled ? when2(x.nextRunAt) : 'paused') + '</div>', UI.label(x.label, { sm: true }), esc(clip(x.lastResult || 'not run yet', 80)),
            '<span class="hstack wrap gap6" style="justify-content:flex-end">' + UI.btn(x.enabled ? 'Pause' : 'Resume', { size: 'xs', kind: 'ghost', attrs: 'data-sctoggle="' + esc(x.id) + '"' }) + UI.btn('History', { size: 'xs', kind: 'ghost', attrs: 'data-schist="' + esc(x.id) + '"' }) + UI.btn('Delete', { size: 'xs', kind: 'ghost', attrs: 'data-scdel="' + esc(x.id) + '"' }) + '</span>']);
          host.innerHTML = (err ? UI.notice(esc(err.message), 'danger') : '')
            + UI.table(['Schedule', 'Agent', 'When (UTC)', 'Label', 'Last', { label: '', right: true }], rows, { clickable: false, minWidth: '0', emptyTitle: 'No schedules', emptyText: 'A schedule starts a run of an agent at set times, as you.' })
            + (hist ? '<div class="eyebrow">History of ' + esc(hist.name) + '</div>' + UI.table(['Due', 'Outcome', 'Run', 'Why'], hist.rows.map((h2) => [esc(when2(h2.dueAt)), UI.pill(h2.outcome, OUT[h2.outcome]), h2.runId ? '<a href="#" data-scrun="' + esc(h2.runId) + '" class="mono">' + esc(shortId(h2.runId)) + '</a> ' + (h2.runState ? statusPill(h2.runState) : '') : '—', esc(h2.reason || '')]), { clickable: false, minWidth: '0', emptyTitle: 'Not due yet', emptyText: 'Runs and skips appear here at each due time.' }) : '')
            + (App.can('agents:run') ? '<div class="eyebrow">New schedule</div>' + (agents.length ? '<div class="formgrid" style="--cols:2">'
              + UI.field('Name', UI.input('', { attrs: 'data-scname maxlength="120"', placeholder: 'Morning report' }))
              + UI.field('Agent', UI.select(agents.map((a) => ({ value: a.name, label: a.name + ' ' + a.version })), agents[0].name, 'data-scagent'))
              + UI.field('Cron (minute hour day month weekday, UTC)', UI.input('0 7 * * 1-5', { attrs: 'data-sccron class="input mono" maxlength="120"' }).replace('class="input" ', ''), 'For example 0 7 * * 1-5 for 07:00 on weekdays')
              + UI.field('Data label', UI.select(LABELS.filter((l) => !me.clearance || LABELS.indexOf(l) <= LABELS.indexOf(me.clearance)), 'internal', 'data-sclabel'))
              + '</div>' + UI.field('Request', UI.textarea('', { rows: 3, attrs: 'data-scinput', placeholder: 'What should the agent do each time?' }))
              + '<div data-scerr></div><div>' + UI.btn('Add schedule', { kind: 'primary', attrs: 'data-scadd' }) + '</div>' : UI.notice('No agent is published to this workspace yet. Publish one in the Registry.', 'info')) : '');
        };
        fetchAll().then(() => {
          ctx.modal({ title: 'Scheduled runs', cls: 'wide', body: '<div class="vstack gap12" data-schost></div>', actions: UI.btn('Close', { attrs: 'data-close' }), onClose() { load(); }, onMount(m) {
            const host = m.querySelector('[data-schost]');
            const redraw = () => fetchAll().then(() => draw(host));
            draw(host);
            host.addEventListener('click', async (e) => {
              const t = e.target.closest('button,a'); if (!t) return;
              try {
                if (t.dataset.sctoggle) { const x = list.find((y) => y.id === t.dataset.sctoggle); await App.patch('/api/agent-schedules/' + x.id, { enabled: !x.enabled }); toast('Schedule ' + esc(x.name) + (x.enabled ? ' paused.' : ' resumed.')); await redraw(); }
                else if (t.dataset.schist) { const x = list.find((y) => y.id === t.dataset.schist); hist = { name: x.name, rows: await App.get('/api/agent-schedules/' + x.id + '/history') }; draw(host); }
                else if (t.dataset.scdel && !t.dataset.armed) { t.dataset.armed = '1'; t.textContent = 'Confirm delete'; }
                else if (t.dataset.scdel) { const x = list.find((y) => y.id === t.dataset.scdel); await App.del('/api/agent-schedules/' + x.id); hist = null; toast('Schedule ' + esc(x.name) + ' deleted. Audit entry written.'); await redraw(); }
                else if (t.dataset.scrun) { e.preventDefault(); App.closeOverlay(); st.run = t.dataset.scrun; st.sel = null; st.view = null; load(); }
                else if (t.hasAttribute('data-scadd')) {
                  const val = (sel) => host.querySelector(sel).value.trim();
                  const body = { name: val('[data-scname]'), agent: val('[data-scagent]'), cron: val('[data-sccron]'), label: val('[data-sclabel]'), input: val('[data-scinput]') };
                  if (!body.name || !body.input) { host.querySelector('[data-scerr]').innerHTML = UI.notice('Give the schedule a name and a request.', 'danger'); return; }
                  await App.post('/api/agent-schedules', body); toast('Schedule ' + esc(body.name) + ' added. It runs as you at each due time.', 'ok'); await redraw();
                }
              } catch (e2) { const box = host.querySelector('[data-scerr]'); if (box) box.innerHTML = UI.notice(esc(e2.message), 'danger'); else App.fail(e2); }
            });
          } });
        });
      }
      if (st.openStart) { const a = typeof st.openStart === 'string' ? st.openStart : ''; st.openStart = false; setTimeout(() => startModal(a), 30); }
      if (st.openReplay) { st.openReplay = false; if (run) setTimeout(() => openReplay((run.steps.find((s) => s.state === 'failed' || s.state === 'denied') || { n: 1 }).n), 30); }

      /** The chain tree (GET /api/chains/:id, B-4107): the tree on the page, the selected node in the inspector. */
      function renderChain() {
        const c = st.chainView && st.chainView.id === st.chain ? st.chainView : null;
        if (!c && !st.chainError && !st.chainFetching) { st.chainFetching = true; fetchChain(st.chain).finally(() => { st.chainFetching = false; later(); }); }
        const head = (sub, actions) => UI.pagehead('Chain ' + esc(shortId(st.chain)), sub, actions);
        const back = UI.btn(st.run ? 'Back to run ' + esc(shortId(st.run)) : 'Back to runs', { attrs: 'data-backrun' });
        let page; let insp = '';
        if (st.chainError) page = '<div class="page runs-page">' + head('', back) + UI.problem('The chain could not be loaded', st.chainError.message, st.chainError.problem && st.chainError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-chainreload' }) + '</div></div>';
        else if (!c) page = '<div class="page runs-page">' + head('', back) + UI.notice('Loading…', 'info') + '</div>';
        else {
          const all = flatten(c.root);
          if (st.chainPick) {
            const d = st.chainPick; st.chainPick = null;
            const hit = d === 'held' ? all.find((n) => (n.held || []).length) : d === 'childfail' ? all.find((n) => n.errorType && n.kind === 'agent-run') || all.find((n) => n.errorType) : null;
            if (hit) st.node = hit.id;
            else if (d === 'held') st.demoNote = 'Nothing is held in this chain now. A write call held anywhere in it pauses the chain and is decided here.';
            else if (d === 'childfail') st.demoNote = 'No node of this chain failed with a typed error.';
          }
          if (!st.node || !all.find((n) => n.id === st.node)) { const h = all.find((n) => (n.held || []).length); st.node = h ? h.id : c.root ? c.root.id : null; }
          const sel = all.find((n) => n.id === st.node);
          const b = c.budgets || {}; const u = c.used || {}; const t = c.totals || {};
          const row = (n) => '<li><button type="button" class="runs-node' + (sel && n.id === sel.id ? ' selected' : '') + ((n.held || []).length ? ' held' : '') + '" data-node="' + esc(n.id) + '" aria-current="' + (sel && n.id === sel.id ? 'true' : 'false') + '"><span class="nk">' + esc(KIND_TEXT[n.kind] || n.kind) + '</span><span class="nn">' + esc(nodeTitle(n)) + '</span>' + UI.pill((n.held || []).length ? 'held' : n.state, (n.held || []).length ? 'info' : NODE_TONE[n.state] || '') + (n.errorType ? UI.pill(n.errorType, 'danger') : '') + '<span class="nm">' + (n.subtree && n.subtree.tokens ? fmt(n.subtree.tokens) + ' tok · ' : '') + esc(n.durationMs != null ? secs(n.durationMs) : n.state === 'waiting' ? 'waiting' : n.state === 'running' ? 'running' : '') + '</span></button>'
            + ((n.children || []).length ? '<ul class="runs-tree">' + n.children.map(row).join('') + '</ul>' : '') + '</li>';
          const rootLink = c.root && c.root.kind === 'agent-run' ? 'run <a href="#" data-run="' + esc(c.root.ref) + '" class="mono">' + esc(shortId(c.root.ref)) + '</a>' : c.root && c.root.kind === 'workflow-run' ? 'workflow run <a href="#" data-gowfrun="' + esc(c.root.ref) + '" class="mono">' + esc(shortId(c.root.ref)) + '</a>' : esc(c.root ? KIND_TEXT[c.root.kind] || c.root.kind : '');
          const chainTone = c.state === 'done' ? 'ok' : c.state === 'stopped' ? 'warn' : 'info';
          page = '<div class="page runs-page">'
            + head('Started by ' + esc((c.principal && c.principal.name) || '') + ' from ' + rootLink + ' · ' + UI.pill(c.state, chainTone) + ' · ' + UI.label(c.label, { sm: true }) + ' high-water mark', back + UI.btn('Refresh chain', { kind: 'ghost', icon: 'refresh', attrs: 'data-chainreload' }))
            + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '')
            + (c.held || []).map((h) => heldNotice(c.id, h)).join('')
            + (c.state === 'stopped' ? UI.notice('<b>The chain stopped.</b> ' + esc(c.stopReason || ''), 'warn') : '')
            + '<div class="stats">' + UI.stat(String(c.nodes), 'Nodes', 'depth ' + c.maxDepth + ' of ' + ((c.limits && c.limits.maxDepth) || '')) + UI.stat(fmt(u.tokens), 'Tokens', 'of ' + fmt(b.tokens) + ' for the chain') + UI.stat(fmt(u.steps), 'Steps', 'of ' + fmt(b.steps)) + UI.stat(esc(secs(u.wallMs || 0)), 'Wall time', 'of ' + esc(secs(b.wallMs || 0))) + UI.stat(esc(secs(u.gpuMs || 0)), 'GPU time', 'the cost meter') + '</div>'
            + UI.panel('Invocations', c.root ? '<ul class="runs-tree" aria-label="Chain tree">' + row(c.root) + '</ul>' : UI.empty('No nodes', 'The chain has no root node.'), { actions: '<span class="muted" style="font-size:12px">Siblings in the order they began</span>' })
            + '<div class="muted" style="font-size:12px">The tree\'s token total, ' + fmt(t.tokens) + ', ' + (t.tokens === u.tokens ? 'equals' : 'differs from') + ' what the chain metered (' + fmt(u.tokens) + '). The principal never changes and the label only rises along the chain.</div>'
            + '</div>';
          if (sel) {
            const g = sel.guardrails || [];
            const runLink = sel.kind === 'agent-run' ? '<a href="#" data-run="' + esc(sel.ref) + '" class="mono">' + esc(shortId(sel.ref)) + '</a>' : sel.kind === 'workflow-run' ? '<a href="#" data-gowfrun="' + esc(sel.ref) + '" class="mono">' + esc(shortId(sel.ref)) + '</a>' : '<span class="muted">none, part of its parent run</span>';
            const rp = sel.replay;
            const opts = rp ? (rp.fromStep ? rp.fromStep.map((n) => ({ value: String(n), label: 'Step ' + n })) : (rp.fromNode || []).map((n) => ({ value: n, label: n }))) : [];
            const canReplay = rp && opts.length && (App.can('agents:run') || App.can('agents:manage'));
            const audit = sel.audit || [];
            insp = '<aside class="inspector w360"><div class="hstack"><div class="eyebrow grow">' + esc(KIND_TEXT[sel.kind] || sel.kind) + ', depth ' + sel.depth + '</div>' + UI.pill((sel.held || []).length ? 'held' : sel.state, (sel.held || []).length ? 'info' : NODE_TONE[sel.state] || '') + '</div>'
              + '<div class="mono" style="font-size:14px;overflow-wrap:anywhere">' + esc(nodeTitle(sel)) + '</div>'
              + (sel.error ? (sel.errorType || sel.state === 'failed' || sel.state === 'refused' || sel.state === 'cancelled' ? UI.notice('<b>' + esc(sel.errorType || sel.state) + '.</b> ' + esc(clip(sel.error, 400)), 'danger') : UI.notice(esc(clip(sel.error, 400)), 'info')) : '')
              + UI.kv([['Run', runLink], ['Calls', sel.callee ? '<span class="mono">' + esc(sel.callee) + '</span>' : '<span class="muted">none</span>'], ['Label', UI.label(sel.label, { sm: true })], ['Guardrail decision', esc(sel.decision || (g.length ? g.map((x) => x.checkpoint + ' ' + x.action).join(', ') : 'none here'))], ['Tokens', fmt(sel.usage.tokens) + ' here, ' + fmt(sel.subtree.tokens) + ' with what it called'], ['Steps', fmt(sel.usage.steps) + ' here, ' + fmt(sel.subtree.steps) + ' in the subtree'], ['Wall time', esc(secs(sel.usage.wallMs))], ['GPU time', esc(secs(sel.usage.gpuMs))], ['Began', esc(clock(sel.createdAt))], ['Duration', sel.durationMs != null ? esc(secs(sel.durationMs)) : esc(sel.state)], ['Typed error', sel.errorType ? '<span class="mono">' + esc(sel.errorType) + '</span>' : 'none']], 1)
              + (g.length ? '<div class="eyebrow">Guardrail decisions</div>' + UI.kv(g.slice(0, 12).map((x) => [esc(x.checkpoint), UI.pill(x.action, x.action === 'allow' ? 'ok' : x.action === 'block' ? 'danger' : 'warn') + ' ' + UI.label(x.label, { sm: true }) + ' <span class="muted">' + esc(clock(x.at)) + '</span>']), 1) : '')
              + ((sel.held || []).length ? '<div class="eyebrow">Held here</div>' + sel.held.map((h0) => { const h = (c.held || []).find((x) => x.node === sel.id && atKey(x) === atKey(h0)) || Object.assign({ node: sel.id, path: [] }, h0); return UI.kv([['Call', '<span class="mono">' + esc(h0.tool || '') + '</span> ' + (h0.sideEffect ? UI.pill(SIDE[h0.sideEffect] || h0.sideEffect, h0.sideEffect === 'destructive' ? 'danger' : 'warn') : '')], ['Waiting since', esc(h0.since ? clock(h0.since) : '')], ['Who decides', esc(h0.approvers || '')]], 1) + (h0.canDecide ? '<div class="hstack gap6">' + UI.btn('Reject', { attrs: 'data-heldreject="' + esc(h.node) + '|' + esc(atKey(h)) + '"' }) + UI.btn('Approve', { kind: 'primary', attrs: 'data-heldapprove="' + esc(h.node) + '|' + esc(atKey(h)) + '"' }) + '</div>' : UI.notice('Waiting for ' + esc(h0.approvers || 'an approver') + '.', 'info')); }).join('') : '')
              + (canReplay ? '<div class="eyebrow">Replay</div>' + UI.field(rp.fromStep ? 'From step' : 'From workflow step', UI.select(opts, opts[0].value, 'data-replayfrom')) + '<div>' + UI.btn('Replay from this node', { icon: 'refresh', attrs: 'data-replaynode' }) + '</div><div class="muted" style="font-size:12px">Runs again as a new chain with the same principal and label; earlier steps are reused from the checkpoints and approvals are asked for again.</div>' : '<div class="muted" style="font-size:12px">' + (rp ? 'Replaying needs agents:run.' : esc(KIND_TEXT[sel.kind] || sel.kind) + ' nodes do not replay on their own; replay the run above them.') + '</div>')
              + (audit.length ? '<div class="eyebrow">Audit entries</div><div class="vstack gap4">' + audit.slice(0, 8).map((a) => '<a href="#" data-auditev="' + esc(a.id) + '" class="listlink"><span class="mono">' + esc(a.action) + '</span> <span class="muted">' + esc(clock(a.ts)) + '</span></a>').join('') + '</div>' : '')
              + '</aside>';
          }
        }
        root.innerHTML = style + left + page + insp;
        const c2 = c;
        ctx.on('click', '[data-node]', (e, t) => { st.node = t.dataset.node; ctx.rerender(); const b2 = ctx.$('[data-node="' + st.node + '"]'); if (b2) b2.focus(); });
        ctx.on('click', '[data-run]', (e, t) => { e.preventDefault(); st.chain = null; st.chainView = null; st.run = t.dataset.run; st.sel = null; st.view = null; st.demoNote = null; ctx.rerender(); });
        ctx.on('click', '[data-backrun]', () => { st.chain = null; st.chainView = null; st.demoNote = null; ctx.rerender(); });
        ctx.on('click', '[data-chainreload]', () => { st.chainError = null; fetchChain(st.chain).then(later); });
        ctx.on('click', '[data-gowfrun]', (e, t) => { e.preventDefault(); ctx.navigate('workflows', { run: t.dataset.gowfrun }); });
        ctx.on('click', '[data-auditev]', (e, t) => { e.preventDefault(); ctx.navigate('usage-audit', { event: t.dataset.auditev, tab: 'audit' }); });
        ctx.on('click', '[data-scope] [data-seg]', (e, t) => { st.scope = t.dataset.seg; load(); });
        ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const val = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(val.length, val.length); });
        ctx.on('click', '[data-refresh]', () => { load(); toast('Runs refreshed.'); });
        ctx.on('click', '[data-start]', () => startModal(''));
        ctx.on('click', '[data-schedules]', () => schedulesModal());
        if (!c2) return;
        bindHeld(c2.id, c2.held || []);
        ctx.on('click', '[data-replaynode]', async () => {
          const sel = flatten(c2.root).find((n) => n.id === st.node); if (!sel || !sel.replay) return;
          const raw = ctx.$('[data-replayfrom]').value;
          const body = sel.replay.fromStep ? { fromStep: Number(raw) } : { fromNode: raw };
          const ok = await ctx.confirm({ title: 'Replay ' + esc(nodeTitle(sel)), tone: 'primary', ok: 'Replay', body: '<div class="fg2">The ' + esc(KIND_TEXT[sel.kind]) + ' runs again from ' + (sel.replay.fromStep ? 'step ' : '') + esc(raw) + ' as the root of a new chain, at ' + esc(sel.label) + '. Approvals are asked for again. Audited chain.node.replayed.</div>', kv: [['Chain', '<span class="mono">' + esc(shortId(c2.id)) + '</span>'], ['Node', esc(nodeTitle(sel)) + ', depth ' + sel.depth]] });
          if (!ok) return;
          const r = await act(() => App.post(sel.replay.href, body), 'Replay queued as a new chain from ' + (sel.replay.fromStep ? 'step ' : '') + esc(raw) + '.');
          if (r && r.kind === 'agent-run') { st.chain = null; st.chainView = null; st.run = r.run; st.sel = null; st.view = null; ctx.rerender(); }
          else if (r && r.kind === 'workflow-run') ctx.navigate('workflows', { run: r.run });
        });
      }
    }
  });
})();
