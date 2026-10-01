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
    crumb: (st) => ['Runs'].concat(st.run ? [shortId(st.run)] : []),
    label: (st) => (st.view && st.view.id === st.run ? st.view.label : null),
    commands: [
      { label: 'Start an agent run', sub: 'Runs', run(app) { app.stateFor('runs').openStart = true; app.render(); } },
      { label: 'Replay a run from a step', sub: 'Runs', run(app) { app.stateFor('runs').openReplay = true; app.render(); } }
    ],
    states: [
      { title: 'Proposal denied', tone: 'danger', text: 'The tool-call checkpoint or a label ceiling refused a call. The thinking step receives the denial as data.', apply(ctx) { ctx.state.demo = 'denied'; ctx.rerender(); } },
      { title: 'Budget stop', tone: 'warn', text: 'The run stopped at its step, token, time or tool-call limit. The last checkpoint is kept and the owner can raise the limit and resume.', apply(ctx) { ctx.state.demo = 'budget'; ctx.rerender(); } },
      { title: 'Traceable figure', tone: 'ok', text: 'Selecting a number in the final answer highlights the calculating step that produced it.', apply(ctx) { ctx.state.demo = 'figure'; ctx.rerender(); } },
      { title: 'Waiting on approval', tone: 'info', text: 'A doing step shows who must approve and how long it has waited.', apply(ctx) { ctx.state.demo = 'waiting'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      st.query = st.query || ''; st.scope = st.scope || 'mine';
      const admin = App.can('agents:manage') || App.can('tools:manage');
      const later = () => { if (App.state.route !== 'runs') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      const fetchRun = (id) => App.get('/api/runs/' + id).then((v) => { st.view = v; }).catch((err) => { st.view = { id, error: err }; });
      const load = () => {
        if (st.loading) { st.again = true; return; }
        st.loading = true;
        App.get('/api/runs' + (st.scope === 'all' || !App.can('agents:run') ? '?all=true' : ''))
          .then((runs) => { st.runs = runs; st.loaded = true; st.loadError = null; if (ctx.params.run) { st.run = ctx.params.run; delete ctx.params.run; } if (!st.run || (!runs.find((r) => r.id === st.run) && !(st.view && st.view.id === st.run))) st.run = runs[0] ? runs[0].id : null; return st.run ? fetchRun(st.run) : null; })
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
      }
      const v = st.view && st.view.id === st.run ? st.view : null;
      if (st.run && !v && !st.fetching) { st.fetching = true; fetchRun(st.run).finally(() => { st.fetching = false; later(); }); }
      if (v && st.demoFor && !v.error) {
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
        + '<div class="runs-list">' + shown.map((r) => UI.listItem('<span class="mono">' + esc(shortId(r.id)) + '</span>', esc(r.agent) + ' · ' + esc(clock(r.createdAt)) + ', ' + esc(r.by || ''), { active: r.id === st.run, attrs: 'data-run="' + esc(r.id) + '"', right: statusPill(r.state) })).join('') + (shown.length ? '' : UI.empty(runs.length ? 'No runs match' : 'No runs yet', runs.length ? 'Try another word.' : 'Start a run of a published agent.')) + '</div>'
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
        + '</style>';

      let page;
      let inspector = '';
      if (!st.run) page = '<div class="page runs-page">' + UI.pagehead('Runs', 'Agent runs, step by step', '') + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '') + UI.empty('No runs yet', 'Start a run of a published agent; its thinking, doing and calculating steps appear here as they happen.', App.can('agents:run') ? UI.btn('Start a run', { kind: 'primary', attrs: 'data-start' }) : '') + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';
      else if (!v) page = '<div class="page">' + UI.notice('Loading…', 'info') + '</div>';
      else if (v.error) page = '<div class="page">' + UI.problem('The run could not be loaded', v.error.message, v.error.problem && v.error.problem.trace_id) + '</div>';
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
          if (s.state === 'waiting' && s.meta.awaiting) return 'waiting on workflow run ' + String(s.meta.awaiting.id || '').slice(-6).toLowerCase() + ', started ' + clock(s.createdAt);
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
          else if (s.state === 'waiting' && s.meta.awaiting) h += divider('info', 'The workflow waits on ' + esc(s.meta.approvers || 'its approvers') + '. This run holds its checkpoint and continues with the result when the workflow finishes.');
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
            if (sel.state === 'waiting' && sel.meta.awaiting) kv.push(['Waiting on', 'workflow run <span class="mono">' + esc(String(sel.meta.awaiting.id || '').slice(-6).toLowerCase()) + '</span>'], ['Started', esc(clock(sel.createdAt))], ['Waited', Math.round((Date.now() - sel.createdAt) / 60000) + ' min'], ['When it finishes', 'this run continues with its result, or its failure']);
            else if (sel.state === 'waiting') kv.push(['Must approve', esc(sel.meta.approvers || '')], ['Requested', esc(clock(sel.createdAt)) + ', from the run'], ['Waited', Math.round((Date.now() - sel.createdAt) / 60000) + ' min'], ['If nobody approves', 'the run keeps its checkpoint; cancel it to stop']);
            else kv.push(['Outcome', sel.state === 'ok' ? UI.pill('ok', 'ok') : '<span style="color:var(--danger-fg)">' + esc(d.error || sel.state) + '</span>'], ['Duration', secs(sel.meta.durationMs)], ['Guardrail', esc(sel.meta.decision || 'not reached')], ['Typed result', sel.meta.valid == null ? '<span class="muted">no output schema</span>' : UI.pill(sel.meta.valid ? 'matches output schema' : 'schema mismatch', sel.meta.valid ? 'ok' : 'danger')]);
            if (ap) kv.push([ap.decision === 'approved' ? 'Approved by' : 'Rejected by', esc(ap.by || '') + (ap.note ? ': ' + esc(ap.note) : '')]);
            kv.push(['Label', UI.label(v.label, { sm: true })]);
            const canDecide = sel.state === 'waiting' && !sel.meta.awaiting && (sel.meta.sideEffect === 'destructive' ? App.can('tools:manage') && !owner : owner || App.can('tools:manage'));
            actions = sel.state === 'waiting' ? (canDecide ? '<div class="hstack gap6">' + UI.btn('Approve', { kind: 'primary', attrs: 'data-approve' }) + UI.btn('Deny', { attrs: 'data-deny' }) + '</div>' : UI.notice(sel.meta.awaiting ? 'Waiting for the workflow to finish. Its approvers decide on the Workflows screen.' : 'Waiting for ' + esc(sel.meta.approvers || 'an approver') + '.', 'info'))
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
            : v.state === 'waiting' ? UI.notice('<b>' + (steps.some((x) => x.state === 'waiting' && x.meta.awaiting) ? 'Waiting on a workflow.' : 'Waiting on approval.') + '</b> ' + esc(v.error || ''), 'info')
              : v.state === 'cancelled' ? UI.notice(esc(v.error || 'Cancelled.'), 'warn') : '';
        const canControl = owner || App.can('agents:manage');
        page = '<div class="page runs-page">'
          + UI.pagehead('Run ' + shortId(v.id) + ', ' + esc(v.agent) + ' ' + esc(v.agentVersion), 'Started ' + esc(clock(v.startedAt || v.createdAt)) + ' by ' + esc(v.by || '') + ', ' + esc(duration(v)) + ' · ' + statusPill(v.state) + (v.replayOf ? ' · replay of <a href="#" data-run="' + esc(v.replayOf) + '">' + esc(shortId(v.replayOf)) + '</a> from step ' + v.replayFrom : '') + ' · profile <a href="#" data-goprofile="' + esc(v.profile || '') + '">' + esc(v.profile || '') + '</a>',
            (canControl && active(v.state) ? UI.btn('Cancel run', { attrs: 'data-cancel' }) : '') + (canControl && steps.length ? UI.btn('Replay from step', { attrs: 'data-replay="' + (steps.find(bad) || { n: 1 }).n + '"' }) : ''))
          + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '')
          + notice
          + UI.panel('Request', '<div class="fg2" style="white-space:pre-wrap">' + esc(clip(v.input, 2000)) + '</div>')
          + '<div class="runs-lanes"><div></div>' + ['think', 'do', 'calc'].map((l) => '<div class="runs-lane"><span class="ln">' + UI.icon(l === 'think' ? 'brain' : l === 'do' ? 'play' : 'calc', 12) + esc(LANES[l]) + '</span><span class="ls">' + esc(laneSum[l]) + '</span></div>').join('') + '</div>'
          + (rows || '<div class="muted">No steps yet.</div>')
          + answer
          + '<div style="margin-top:6px"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';
      }
      root.innerHTML = style + left + page + inspector;

      // ---- events ----
      const run = v && !v.error ? v : null;
      const sel = run ? run.steps.find((s) => s.n === st.sel) : null;
      ctx.on('click', '[data-run]', (e, t) => { e.preventDefault(); st.run = t.dataset.run; st.sel = null; st.showAnswer = false; st.view = null; st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-scope] [data-seg]', (e, t) => { st.scope = t.dataset.seg; load(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const val = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(val.length, val.length); });
      ctx.on('click', '[data-refresh]', () => { load(); toast('Runs refreshed.'); });
      ctx.on('click', '.runs-card', (e, t) => { st.sel = +t.dataset.step; ctx.rerender(); });
      ctx.on('keydown', '.runs-card', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = +t.dataset.step; ctx.rerender(); } });
      ctx.on('click', '[data-fig]', (e, t) => { st.sel = +t.dataset.fig; ctx.rerender(); setTimeout(() => { const c = ctx.$('.runs-card.selected'); if (c) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 20); });
      ctx.on('click', '[data-toggleanswer]', () => { st.showAnswer = !st.showAnswer; ctx.rerender(); });
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
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
    }
  });
})();
