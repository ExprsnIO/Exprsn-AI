// Workflows, Sprint 47 (Builders' tools, B-139): the Analytics tab of a workflow (/api/workflow-analytics/:id) and the
// "Running now" view (/api/workflow-activity, with the tenant summary from /api/workflow-analytics). `workflows.js`
// calls App.wfAnalyticsTab(ctx, wf, deps) for the tab's markup and App.wfAnalyticsBind(ctx, wf, deps) once per render
// for its handlers, and shows App.wfActivity(root, ctx, deps) when its state's `view` is "activity"
// (#/workflows?view=activity). deps.later() re-renders when a fetch lands; deps.back() returns to the designer;
// deps.openRun(workflowId, runId) opens a run on the canvas. The board refreshes on the workflow.run and
// workflow.step socket events the viewer receives, and every 15 seconds for everyone else's runs.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const RANGES = [{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }];
  const CSS = '.wfan-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.wfan-sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}'
    + '.wfan-chart{border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:8px}.wfan-chart svg{display:block;width:100%;height:140px}'
    + '.wfan-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--fg2)}.wfan-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}'
    + '.wfan-chart rect.bar:hover{opacity:.8}';

  const dur = (ms) => (ms == null ? '—' : ms < 1000 ? ms + ' ms' : ms < 60000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s' : ms < 3600000 ? Math.round(ms / 60000) + ' min' : (ms / 3600000).toFixed(1) + ' h');
  const pct = (r) => (r == null ? '—' : Math.round(r * 1000) / 10 + '%');
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  /** Runs by day, stacked: succeeded (ok), failed (danger), other (neutral), with a 2 px gap and a tooltip per bar. */
  function trendChart(trend, title) {
    if (!trend.length) return '';
    const max = Math.max(1, ...trend.map((d) => d.runs));
    const W = 600, H = 140, pad = 18, bw = (W - 8) / trend.length;
    const y = (v) => ((H - pad) * v) / max;
    const bars = trend.map((d, i) => {
      const x = 4 + i * bw + 1, w = Math.max(1, bw - 2);
      let top = H - pad;
      let first = true;
      const seg = (v, fill) => {
        if (!v) return '';
        const h = y(v); top -= h;
        const gap = first ? 0 : 2; first = false; // a 2 px surface gap between stacked segments
        return '<rect class="bar" x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(1, h - gap).toFixed(1) + '" rx="1.5" fill="' + fill + '"></rect>';
      };
      return '<g><title>' + esc(d.date + ': ' + d.runs + ' runs, ' + d.succeeded + ' succeeded, ' + d.failed + ' failed or rejected, ' + d.other + ' other' + (d.avgMs != null ? ', average ' + dur(d.avgMs) : '')) + '</title>'
        + '<rect x="' + (4 + i * bw).toFixed(1) + '" y="0" width="' + bw.toFixed(1) + '" height="' + H + '" fill="transparent"></rect>'
        + seg(d.succeeded, 'var(--ok-fg)') + seg(d.failed, 'var(--danger-fg)') + seg(d.other, 'var(--meter)') + '</g>';
    }).join('');
    const axis = '<line x1="4" x2="' + (W - 4) + '" y1="' + (H - pad) + '" y2="' + (H - pad) + '" stroke="var(--line2)"></line>'
      + '<text x="4" y="' + (H - 4) + '" font-size="11" fill="var(--muted)" font-family="inherit">' + esc(trend[0].date) + '</text>'
      + '<text x="' + (W - 4) + '" y="' + (H - 4) + '" font-size="11" text-anchor="end" fill="var(--muted)" font-family="inherit">' + esc(trend[trend.length - 1].date) + '</text>'
      + '<text x="4" y="11" font-size="11" fill="var(--muted)" font-family="inherit">' + max + ' runs</text>';
    const days = trend.filter((d) => d.runs);
    return '<div class="wfan-chart"><div class="hstack wrap gap6"><div class="eyebrow grow">' + esc(title) + '</div><div class="wfan-legend" aria-hidden="true"><span><i style="background:var(--ok-fg)"></i>Succeeded</span><span><i style="background:var(--danger-fg)"></i>Failed or rejected</span><span><i style="background:var(--meter)"></i>Other</span></div></div>'
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(title + ': ' + trend.reduce((a, d) => a + d.runs, 0) + ' runs over ' + trend.length + ' days; the table below lists them') + '">' + axis + bars + '</svg>'
      + '<details><summary style="cursor:pointer;font-size:12px">Show the days as a table</summary>' + UI.table(['Day', { label: 'Runs', right: true }, { label: 'Succeeded', right: true }, { label: 'Failed', right: true }, { label: 'Other', right: true }, { label: 'Success', right: true }, { label: 'Average', right: true }], days.map((d) => [esc(d.date), String(d.runs), String(d.succeeded), String(d.failed), String(d.other), pct(d.successRate), dur(d.avgMs)]), { clickable: false, cls: 'bare', minWidth: '0', emptyTitle: 'No runs', emptyText: 'Nothing ran in this range.' }) + '</details></div>';
  }

  // ---------- the Analytics tab ----------

  function loadWf(ctx, wf, deps) {
    const st = ctx.state; st.wfan = st.wfan || {};
    const days = st.wfanDays || '30';
    const key = wf.id + ':' + days;
    st.wfan[key] = { loading: true };
    App.get('/api/workflow-analytics/' + enc(wf.id) + '?days=' + days)
      .then((d) => { st.wfan[key] = { data: d }; })
      .catch((err) => { st.wfan[key] = { error: err }; })
      .finally(() => deps.later());
  }

  App.wfAnalyticsTab = function (ctx, wf, deps) {
    const st = ctx.state; st.wfan = st.wfan || {};
    const days = st.wfanDays || '30';
    const a = st.wfan[wf.id + ':' + days];
    if (!a) { loadWf(ctx, wf, deps); return '<style>' + CSS + '</style>' + UI.notice('Loading the analytics…', 'info'); }
    const head = '<div class="hstack wrap gap6">' + UI.seg(RANGES, days, 'data-wfan-range aria-label="Range"') + UI.btn('Refresh', { size: 'xs', kind: 'ghost', icon: 'refresh', attrs: 'data-wfan-refresh' }) + '</div>';
    if (a.loading) return '<style>' + CSS + '</style>' + head + UI.notice('Loading the analytics…', 'info');
    if (a.error) return '<style>' + CSS + '</style>' + head + UI.problem('The analytics could not be loaded', a.error.message, (a.error.problem && a.error.problem.trace_id) || false);
    const d = a.data;
    return '<style>' + CSS + '</style>' + head
      + '<div class="wfan-sub">' + (d.scope === 'all runs' ? 'Every run of this workflow' : 'Your runs of this workflow') + ' started in the last ' + esc(days) + ' days, within your clearance; dry runs left out. Days are UTC.</div>'
      + '<div class="wfan-stats">' + UI.stat(String(d.runs), 'Runs', d.counts.waiting + d.counts.running + d.counts.queued ? esc(String(d.counts.waiting + d.counts.running + d.counts.queued)) + ' in progress' : '') + UI.stat(pct(d.successRate), 'Success rate', esc(d.counts.succeeded + ' of ' + d.finished + ' finished')) + UI.stat(dur(d.duration.p50Ms), 'Median duration', 'p50') + UI.stat(dur(d.duration.p95Ms), '95th percentile', 'p95 of ' + d.duration.measured) + '</div>'
      + trendChart(d.trend, 'Runs by day')
      + '<div class="grid2" style="gap:12px">'
      + UI.panel('Slowest steps', UI.table(['Step', { label: 'Runs', right: true }, { label: 'Average', right: true }, { label: 'Longest', right: true }], d.slowestSteps.map((x) => [esc(x.title), String(x.runs), dur(x.avgMs), dur(x.maxMs)]), { clickable: false, cls: 'bare', minWidth: '0', emptyTitle: 'No steps timed', emptyText: 'Steps appear once runs finish them.' }))
      + UI.panel('Top failure reasons', UI.table(['Reason', { label: 'Runs', right: true }, 'Last'], d.failureReasons.map((x) => ['<span style="overflow-wrap:anywhere">' + esc(x.reason) + '</span>', String(x.runs), esc(when(x.lastAt))]), { clickable: false, cls: 'bare', minWidth: '0', emptyTitle: 'No failures', emptyText: 'Nothing failed in this range.' })
        + (d.failingSteps.length ? '<div class="wfan-sub">Failing steps: ' + d.failingSteps.map((x) => esc(x.title) + ' (' + x.failures + ')').join(', ') + '</div>' : ''))
      + '</div>';
  };

  App.wfAnalyticsBind = function (ctx, wf, deps) {
    const st = ctx.state;
    ctx.on('click', '[data-wfan-range] [data-seg]', (e, el) => { st.wfanDays = el.dataset.seg; ctx.rerender(); });
    ctx.on('click', '[data-wfan-refresh]', () => { if (st.wfan) delete st.wfan[wf.id + ':' + (st.wfanDays || '30')]; ctx.rerender(); });
    void deps;
  };

  // ---------- Running now ----------

  const live = { sock: null, handler: null, timer: null, soon: null };
  function stopLive() {
    if (live.sock && live.handler) { live.sock.off('workflow.run', live.handler); live.sock.off('workflow.step', live.handler); }
    live.sock = null; live.handler = null;
    if (live.timer) { clearInterval(live.timer); live.timer = null; }
  }
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'workflows') stopLive(); });

  function loadActivity(ctx, deps) {
    const act = ctx.state.act;
    act.loading = true;
    Promise.all([App.get('/api/workflow-activity?limit=200'), App.get('/api/workflow-analytics?days=' + (act.days || '7'))])
      .then(([board, sum]) => { act.board = board; act.sum = sum; act.error = null; act.at = Date.now(); })
      .catch((err) => { act.error = err; })
      .finally(() => { act.loading = false; deps.later(); });
  }

  App.wfActivity = function (root, ctx, deps) {
    const st = ctx.state; st.act = st.act || { days: '7' };
    const act = st.act;
    if (!act.board && !act.loading && !act.error) loadActivity(ctx, deps);
    // Live: socket events for the viewer's runs, polling for everyone else's.
    if (App.socket && live.sock !== App.socket) {
      stopLive();
      live.sock = App.socket;
      live.handler = () => { if (st.view !== 'activity') return; clearTimeout(live.soon); live.soon = setTimeout(() => loadActivity(ctx, deps), 600); };
      live.sock.on('workflow.run', live.handler); live.sock.on('workflow.step', live.handler);
    }
    if (!live.timer) live.timer = setInterval(() => { if (App.parse().route !== 'workflows' || st.view !== 'activity') { stopLive(); return; } if (!document.getElementById('overlay')) loadActivity(ctx, deps); }, 15000);
    const back = UI.btn('Back to workflows', { size: 'sm', kind: 'ghost', attrs: 'data-act-back' });
    let body;
    if (act.error) body = UI.problem('The activity could not be loaded', act.error.message, (act.error.problem && act.error.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-act-retry' }) + '</div>';
    else if (!act.board) body = UI.notice('Loading what is running…', 'info');
    else {
      const b = act.board, s = act.sum;
      const filt = act.filter || 'all';
      const items = b.items.filter((x) => filt === 'all' || x.state === filt);
      const waitText = (x) => x.waitingOn === 'approval' ? 'approval by ' + (x.approval ? x.approval.role : 'a role') + (x.approval && x.approval.dueAt ? ', due ' + when(x.approval.dueAt) : '') : x.waitingOn === 'wait' ? 'a wait until ' + when(x.resumeAt) : x.waitingOn === 'retry' ? 'a retry at ' + when(x.resumeAt) : x.waitingOn === 'child' ? 'a child run' : x.waitingOn ? 'resuming' : '';
      body = '<div class="wfan-stats">' + UI.stat(String(b.counts.running), 'Running') + UI.stat(String(b.counts.waiting), 'Waiting') + UI.stat(String(b.counts.queued), 'Queued') + UI.stat(pct(s.successRate), 'Success rate', 'last ' + esc(act.days) + ' days') + '</div>'
        + '<div class="hstack wrap gap6">' + UI.seg([{ id: 'all', label: 'All (' + b.total + ')' }, { id: 'running', label: 'Running' }, { id: 'waiting', label: 'Waiting' }, { id: 'queued', label: 'Queued' }], filt, 'data-act-filter aria-label="Show"') + UI.btn('Refresh', { size: 'xs', kind: 'ghost', icon: 'refresh', attrs: 'data-act-refresh' }) + '<span class="wfan-sub" aria-live="polite">Updated ' + esc(when(act.at)) + '. ' + (b.scope === 'all runs' ? 'Every run of the workflows you may open.' : 'Your own runs.') + '</span></div>'
        + UI.table(['Workflow', 'Run', 'State', 'Current step', 'Age', 'Owner', 'Label'], items.map((x) => ({ cells: ['<b>' + esc(x.workflow) + '</b>' + (x.version ? ' <span class="muted">v' + x.version + '</span>' : ''), '<a href="#" class="mono" data-act-open="' + esc(x.workflowId) + '|' + esc(x.runId) + '" aria-label="Open run ' + esc(x.runId.slice(-6).toLowerCase()) + ' of ' + esc(x.workflow) + '">' + esc(x.runId.slice(-6).toLowerCase()) + '</a>', UI.pill(x.state === 'waiting' && x.waitingOn === 'approval' ? 'waiting on approval' : x.state, x.state === 'running' ? 'info' : x.state === 'waiting' ? 'warn' : 'outline') + (x.waitingOn ? '<div class="wfan-sub">' + esc(waitText(x)) + '</div>' : ''), x.step ? esc(x.step.title) + ' <span class="muted">' + esc(x.step.kind || '') + '</span>' : '<span class="muted">not started</span>', dur(x.ageMs), esc(x.owner.name || x.owner.id), UI.label(x.label, { sm: true })] })), { clickable: false, minWidth: '720px', attrs: 'data-scroll-x role="region" aria-label="Running now"', emptyTitle: 'Nothing is running', emptyText: 'Runs that are queued, running or waiting on an approval or a wait show here as they happen.' })
        + '<div class="hstack wrap gap6"><div class="eyebrow grow">Workflows over the last ' + esc(act.days) + ' days</div>' + UI.seg(RANGES, act.days, 'data-act-days aria-label="Range"') + '</div>'
        + trendChart(s.trend, 'Runs by day, every workflow')
        + UI.table(['Workflow', { label: 'Runs', right: true }, { label: 'Succeeded', right: true }, { label: 'Failed', right: true }, { label: 'In progress', right: true }, { label: 'Success', right: true }, { label: 'Average', right: true }], s.workflows.map((w) => ({ cells: ['<a href="#" data-act-wf="' + esc(w.workflowId) + '">' + esc(w.name) + '</a>', String(w.runs), String(w.succeeded), String(w.failed), String(w.active), pct(w.successRate), dur(w.avgMs)] })), { clickable: false, minWidth: '640px', attrs: 'data-scroll-x role="region" aria-label="Workflow summary"', emptyTitle: 'No workflows', emptyText: 'Workflows you may open appear here.' });
    }
    root.innerHTML = '<style>' + CSS + '</style><div class="page">' + UI.pagehead('Running now', 'Workflow runs that are queued, running or waiting, with their current step, age and owner, and how each workflow has done lately', back) + body + '</div>';

    ctx.on('click', '[data-act-back]', () => { stopLive(); deps.back(); });
    ctx.on('click', '[data-act-retry]', () => { act.error = null; ctx.rerender(); });
    ctx.on('click', '[data-act-refresh]', () => loadActivity(ctx, deps));
    ctx.on('click', '[data-act-filter] [data-seg]', (e, el) => { act.filter = el.dataset.seg; ctx.rerender(); });
    ctx.on('click', '[data-act-days] [data-seg]', (e, el) => { act.days = el.dataset.seg; loadActivity(ctx, deps); });
    ctx.on('click', '[data-act-open]', (e, el) => { e.preventDefault(); const p = el.dataset.actOpen.split('|'); stopLive(); deps.openRun(p[0], p[1]); });
    ctx.on('click', '[data-act-wf]', (e, el) => { e.preventDefault(); stopLive(); deps.openWorkflow(el.dataset.actWf); });
  };
})();
