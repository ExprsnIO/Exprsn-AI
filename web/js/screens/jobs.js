(function () {
  const { UI, esc } = App;

  // 1.6.0 (B-4203): Jobs and queues. The one JobQueue (BullMQ on Redis, or database polling), the Scheduler, the dead
  // letters of the domains that keep them, and the tenant cache as a tab (Q1). System admins see every tenant's jobs
  // with a tenant filter; tenant admins their own (Q9).
  const STATE_KIND = { queued: 'info', running: 'info', succeeded: 'ok', failed: 'danger', cancelled: 'warn', preempted: 'warn' };
  const STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'preempted'];
  const WINDOW_LABEL = { '1h': 'last hour', '24h': 'last 24 h', '7d': 'last 7 days' };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const clock = (t) => { if (!t) return '—'; const d = new Date(t); const today = new Date(); return (d.toDateString() === today.toDateString() ? '' : d.getDate() + ' ' + MON[d.getMonth()] + ' ') + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const ms = (n) => (n == null ? '—' : n >= 60000 ? (n / 60000).toFixed(n >= 600000 ? 0 : 1) + ' min' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + ' s' : n + ' ms');
  const every = (n) => (n % 86400000 === 0 ? n / 86400000 + ' d' : n % 3600000 === 0 ? n / 3600000 + ' h' : n % 60000 === 0 ? n / 60000 + ' min' : Math.round(n / 1000) + ' s');
  const mins = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m + ' min'; };
  const until = (t) => { if (!t) return 'paused'; const s = Math.round((t - Date.now()) / 1000); return s <= 60 ? 'in 1 min' : s < 3600 ? 'in ' + Math.round(s / 60) + ' min' : 'at ' + clock(t); };
  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + ' %' : '—');
  const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const backendLabel = (b) => (b === 'bullmq' ? 'BullMQ on Redis' : 'database polling');

  /** A dialog that asks for a reason (required or not) and resolves with it, or null when cancelled. */
  const askReason = (ctx, o) => new Promise((resolve) => {
    let out = null;
    ctx.modal({ title: esc(o.title) + (o.tag ? ' ' + UI.pill(o.tag, o.tone || 'warn') : ''),
      body: '<p class="fg2" style="margin:0">' + o.body + '</p>' + UI.field(o.required ? 'Reason' : 'Reason (optional)', UI.input('', { attrs: 'data-reason maxlength="500"' })) + (o.kv ? UI.kv(o.kv, 2) : '') + '<div data-rerr role="alert"></div>',
      actions: UI.btn(o.cancel || 'Cancel', { attrs: 'data-close' }) + UI.btn(o.ok, { kind: o.tone === 'danger' ? 'danger' : 'primary', attrs: 'data-rok' }),
      onMount(m) {
        const input = m.querySelector('[data-reason]'); input.focus();
        const go = () => { const v = input.value.trim(); if (o.required && !v) { m.querySelector('[data-rerr]').innerHTML = UI.notice('Say why.', 'warn'); input.focus(); return; } out = v; App.closeOverlay(); };
        m.querySelector('[data-rok]').addEventListener('click', go);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      },
      onClose() { resolve(out); } });
  });

  App.register({
    id: 'jobs', title: 'Jobs and queues', section: 'admin', crumb: ['Admin', 'Jobs and queues'], live: true,
    summary: 'Every queue, job and schedule; failed work, dead letters and the tenant cache',
    commands: [
      { label: 'Retry failed jobs', sub: 'Jobs and queues', run(app) { const s = app.stateFor('jobs'); s.tab = 'jobs'; s.jobState = 'failed'; s.loaded = false; s.openRetryAll = true; app.render(); } },
      { label: 'Run a schedule now', sub: 'Jobs and queues', run(app) { const s = app.stateFor('jobs'); s.tab = 'schedules'; s.openRunNow = true; app.render(); } }
    ],
    states: [
      { title: 'Queue backlog growing', tone: 'warn', text: 'A type whose oldest queued job has waited 15 min or more: the notice names it and links to Dead letters.',
        apply(ctx) { const st = ctx.state; st.tab = 'queues'; const q = st.data && st.data.queues; const t = q ? q.items.filter((x) => x.oldestQueuedAt).sort((a, b) => a.oldestQueuedAt - b.oldestQueuedAt)[0] : null; if (t) { st.selType = t.type; st.domain = 'all'; st.typeQuery = ''; } else ctx.toast('No queue is backing up: nothing is waiting.', 'ok', 4000); ctx.rerender(); } },
      { title: 'Job failed with trace', tone: 'danger', text: 'A job that gave up: the inspector shows the error, the payload keys and the trace id to copy into the collector.',
        apply(ctx) { const st = ctx.state; st.tab = 'jobs'; st.jobState = 'failed'; st.jobType = 'all'; st.jobQuery = ''; st.window = '7d'; st.selJob = null; st.loaded = false; ctx.rerender(); } },
      { title: 'Instance behind claims no jobs', tone: 'info', text: 'An instance behind the schema or draining claims nothing; the others carry every queue. The notice links to Overview.',
        apply(ctx) { const st = ctx.state; st.tab = 'queues'; const q = st.data && st.data.queues; if (!q || !q.instances.notClaiming.length) ctx.toast('Every instance is claiming jobs.', 'ok', 4000); ctx.rerender(); } },
      { title: 'Dead letter redriven', tone: 'ok', text: 'Redriving a dead letter queues it again as a job (or replays the workflow run) and it leaves Dead letters, with a toast and an audit event.',
        apply(ctx) { const st = ctx.state; st.tab = 'deadletters'; const dl = st.data && st.data.dead && st.data.dead.items[0]; if (dl) st.selDead = dl.id; else ctx.toast('No dead letters: nothing has given up.', 'ok', 4000); ctx.rerender(); } },
      { title: 'Database polling backend', tone: 'neutral', text: 'A single-node install: JOB_QUEUE=database, CACHE_STORE=memory. The backend pill and the cache store say so, with the per-instance notice when there is more than one instance.',
        apply(ctx) { const st = ctx.state; st.tab = 'cache'; const q = st.data && st.data.queues; if (q && q.backend !== 'db') ctx.toast('This server queues on BullMQ (Redis).', '', 4000); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const DEFAULTS = { tab: 'queues', tenant: 'all', typeQuery: '', domain: 'all', jobState: 'all', jobType: 'all', window: '24h', jobQuery: '', details: {} };
      Object.keys(DEFAULTS).forEach((k) => { if (st[k] === undefined) st[k] = DEFAULTS[k]; });
      if (location.hash !== st.paramsHash) {
        st.paramsHash = location.hash;
        if (ctx.params.tab) st.tab = ctx.params.tab;
        if (ctx.params.id) { st.tab = 'jobs'; st.selJob = ctx.params.id; st.jobState = 'all'; st.jobType = 'all'; st.window = '7d'; st.loaded = false; }
      }
      const platform = App.can('platform:manage');
      const tq = platform && st.tenant !== 'all' ? 'tenant=' + encodeURIComponent(st.tenant) : '';
      const jobsUrl = () => {
        const p = [];
        if (st.jobState !== 'all') p.push('state=' + st.jobState);
        if (st.jobType !== 'all') p.push('type=' + encodeURIComponent(st.jobType));
        p.push('window=' + st.window);
        if (/^[0-9A-Za-z]{1,32}$/.test(st.jobQuery.trim())) p.push('q=' + encodeURIComponent(st.jobQuery.trim()));
        if (tq) p.push(tq);
        return '/api/admin/jobs?' + p.join('&');
      };

      // ---------- loading ----------
      const refresh = () => {
        if (App.state.route !== 'jobs') return;
        if (document.getElementById('overlay')) { st.dirty = true; return; }
        ctx.rerender();
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([
          App.get('/api/admin/queues' + (tq ? '?' + tq : '')), App.get(jobsUrl()), App.get('/api/admin/schedules'), App.get('/api/admin/dead-letters'), App.get('/api/admin/cache'),
          platform ? App.get('/api/admin/tenants').catch(() => []) : Promise.resolve([])
        ])
          .then((r) => { st.data = { queues: r[0], jobs: r[1], schedules: r[2], dead: r[3], cache: r[4], tenants: r[5] }; st.details = {}; st.loadError = null; st.loaded = true; })
          .catch((err) => { st.loadError = err; st.loaded = true; })
          .finally(() => {
            st.loading = false;
            if (st.timer) clearTimeout(st.timer);
            st.timer = setTimeout(() => { st.timer = null; if (App.state.route === 'jobs' && !document.getElementById('overlay')) { st.loaded = false; ctx.rerender(); } }, 15000);
            refresh();
          });
      };
      if (!st.loaded) load();
      const reloadJobs = () => App.get(jobsUrl()).then((j) => { st.data.jobs = j; refresh(); }).catch((err) => App.fail(err));

      if (!st.data) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Jobs and queues', 'Every queue, job and schedule on the one JobQueue; the work that gave up, and the tenant cache.')
          + (st.loadError ? UI.problem('Jobs and queues could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-retry' }) + '</div>' : '<div class="muted" role="status">Loading…</div>') + '</div>';
        ctx.on('click', '[data-retry]', () => { st.loadError = null; st.loaded = false; ctx.rerender(); });
        return;
      }

      const D = st.data, Q = D.queues;
      const types = Q.items;
      const paused = types.filter((t) => t.paused).length;
      const jobs = D.jobs.items;
      const counts = D.jobs.counts;
      const domains = Array.from(new Set(types.map((t) => t.domain))).sort();
      const tabs = UI.tabs([{ id: 'queues', label: 'Queues', count: types.length }, { id: 'jobs', label: 'Jobs', count: counts.queued + counts.running }, { id: 'schedules', label: 'Schedules', count: D.schedules.items.length }, { id: 'deadletters', label: 'Dead letters', count: D.dead.items.length }, { id: 'cache', label: 'Cache' }], st.tab);
      const tenantPick = platform ? UI.select([{ value: 'all', label: 'Every tenant' }].concat((D.tenants || []).map((t) => ({ value: t.id, label: t.name }))), st.tenant, 'data-tenant aria-label="Tenant" style="width:auto;max-width:100%"') : '';
      const me = (App.me && (App.me.displayName || App.me.username)) || 'you';
      let body = '', insp = '';

      // ---------------- Queues ----------------
      if (st.tab === 'queues') {
        const q = st.typeQuery.toLowerCase();
        const rows = types.filter((t) => (st.domain === 'all' || t.domain === st.domain) && (!q || (t.type + ' ' + t.domain + ' ' + (t.description || '')).toLowerCase().indexOf(q) >= 0));
        if (!rows.some((t) => t.type === st.selType)) st.selType = rows.length ? rows[0].type : null;
        const sel = types.find((t) => t.type === st.selType);
        const backlog = types.filter((t) => t.oldestQueuedAt && Date.now() - t.oldestQueuedAt >= 15 * 60000).sort((a, b) => a.oldestQueuedAt - b.oldestQueuedAt)[0];
        const behind = Q.instances.notClaiming;
        body += (backlog ? UI.notice('<b>' + esc(backlog.type) + ' is backing up:</b> ' + num(backlog.queued) + ' queued, the oldest for ' + esc(mins(backlog.oldestQueuedAt)) + (backlog.paused ? '. The type is paused.' : '. A target that keeps failing retries with backoff; see what gave up in Dead letters.'), 'warn', UI.btn('Open dead letters', { size: 'sm', attrs: 'data-godead' })) : '')
          + (behind.length ? UI.notice('<b>' + behind.map((i) => esc(i.id)).join(', ') + (behind.length === 1 ? ' claims' : ' claim') + ' no jobs</b> (' + behind.map((i) => esc(i.reason)).join('; ') + '). ' + (Q.instances.claiming ? Q.instances.claiming + ' other instance' + (Q.instances.claiming === 1 ? ' carries' : 's carry') + ' every queue.' : 'No instance is claiming.'), 'info', UI.btn('Open Overview', { size: 'sm', attrs: 'data-gooverview' })) : '')
          + '<div class="toolbar">' + UI.search('Filter by type, domain, description', 'data-typesearch aria-label="Filter job types"', st.typeQuery)
          + UI.select([{ value: 'all', label: 'Every domain' }].concat(domains.map((x) => ({ value: x, label: x }))), st.domain, 'data-domain aria-label="Domain" style="width:auto;max-width:100%"') + tenantPick
          + UI.pill(backendLabel(Q.backend), Q.backend === 'bullmq' ? 'info' : 'outline') + (paused ? UI.pill(paused + ' paused', 'warn') : '') + '<span class="muted right" style="font-size:12px">' + rows.length + ' types, JOB_CONCURRENCY ' + Q.concurrency + ' per instance, ' + Q.instances.claiming + ' of ' + Q.instances.total + ' instance' + (Q.instances.total === 1 ? '' : 's') + ' claiming</span></div>'
          + UI.table(['Type', 'Domain', { label: 'Queued', right: true }, { label: 'Running', right: true }, 'Oldest queued', { label: 'Failed 24 h', right: true }, { label: 'p95', right: true }, 'Timeout', 'State'], rows.map((t) => ({ cells: ['<span class="mono" style="font-weight:600">' + esc(t.type) + '</span>', esc(t.domain), '<span class="num">' + num(t.queued) + '</span>', '<span class="num">' + t.running + '</span>', t.oldestQueuedAt ? (Date.now() - t.oldestQueuedAt >= 15 * 60000 ? '<span style="color:var(--warn-fg)">' + esc(mins(t.oldestQueuedAt)) + '</span>' : esc(mins(t.oldestQueuedAt))) : '<span class="muted">—</span>', '<span class="num"' + (t.failed24h >= 10 ? ' style="color:var(--danger-fg)"' : '') + '>' + t.failed24h + '</span>', '<span class="num">' + ms(t.p95Ms) + '</span>', '<span class="mono" style="font-size:11px">' + ms(t.timeoutMs) + '</span>', UI.pill(t.paused ? 'paused' : t.registered ? 'active' : 'not registered here', t.paused ? 'warn' : t.registered ? 'ok' : 'neutral')], attrs: 'data-type="' + esc(t.type) + '"', selected: t.type === st.selType })), { minWidth: '980px', emptyTitle: 'No types match', emptyText: 'Clear the filter or pick another domain.' })
          + '<span class="muted" style="font-size:12px">One queue, one table: every job type is a handler registered on the JobQueue (' + esc(backendLabel(Q.backend)) + '); the scheduler queues the recurring ones. A paused type keeps queuing and stops claiming on every instance within one poll.' + (platform ? '' : ' Counts are your tenant\'s.') + '</span>';
        if (sel) {
          const last = jobs.filter((j) => j.type === sel.type).slice(0, 5);
          insp = '<div class="hstack"><div class="eyebrow grow">Job type</div>' + UI.pill(sel.paused ? 'paused' : 'active', sel.paused ? 'warn' : 'ok') + '</div><div class="mono" style="font-size:15px;font-weight:600;overflow-wrap:anywhere">' + esc(sel.type) + '</div><div class="fg2" style="font-size:12px">' + esc(sel.description || 'No description is recorded for this type.') + '</div>'
            + (sel.pause ? UI.notice('Paused by ' + esc(sel.pause.byName || 'an administrator') + ' at ' + esc(clock(sel.pause.at)) + (sel.pause.reason ? ': ' + esc(sel.pause.reason) : '') + '.', 'warn') : '')
            + UI.kv([['Domain', esc(sel.domain)], ['Timeout', '<span class="mono">' + ms(sel.timeoutMs) + '</span>'], ['Concurrency', '<span class="mono">JOB_CONCURRENCY ' + Q.concurrency + '</span>'], ['Queued, running', num(sel.queued) + ', ' + sel.running], ['Failed 24 h', String(sel.failed24h)], ['Succeeded 24 h', String(sel.succeeded24h)]], 2)
            + '<div class="eyebrow">Duration</div><div class="hstack"><div class="grow"><div class="kv" style="--cols:2"><div><div class="k">p50</div><div class="v num">' + ms(sel.p50Ms) + '</div></div><div><div class="k">p95</div><div class="v num">' + ms(sel.p95Ms) + '</div></div></div></div>' + UI.spark(sel.series, sel.series.length - 1) + '</div><span class="muted" style="font-size:11px">Queued per 3 h over the last day, latest right.</span>'
            + '<div class="eyebrow">Last five jobs</div>' + (last.length ? UI.table(['Job', 'State', 'When'], last.map((j) => ['<a href="#/jobs?tab=jobs" class="mono" data-openjob="' + esc(j.id) + '">' + esc(j.id.slice(-8)) + '</a>', UI.pill(j.state, STATE_KIND[j.state]), esc(clock(j.createdAt))]), { clickable: false, minWidth: '0', cls: 'bare' }) : '<span class="muted" style="font-size:12px">No jobs of this type in the Jobs tab\'s window.</span>')
            + '<div class="hstack wrap gap6">' + (platform ? (sel.paused ? UI.btn('Resume', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-resumetype' }) : UI.btn('Pause type', { size: 'sm', icon: 'pause', attrs: 'data-pausetype', disabled: !sel.registered })) : '') + UI.btn('Retry all failed', { size: 'sm', icon: 'refresh', attrs: 'data-retrytype', disabled: !sel.failed24h }) + UI.btn('Jobs of this type', { size: 'sm', kind: 'ghost', attrs: 'data-jobsfor="' + esc(sel.type) + '"' }) + '</div>'
            + '<span class="muted" style="font-size:12px">' + (platform ? '' : 'Pausing a type acts on every tenant and needs a system admin. ') + 'Audit entries: jobs.type.paused, jobs.type.resumed, jobs.retried.</span>';
        }
      }
      // ---------------- Jobs ----------------
      if (st.tab === 'jobs') {
        if (!jobs.some((j) => j.id === st.selJob)) st.selJob = jobs.length ? jobs[0].id : null;
        const row = jobs.find((j) => j.id === st.selJob) || null;
        const sel = row && (st.details[row.id] || row);
        if (row && !st.details[row.id] && !st.detailLoading) {
          st.detailLoading = row.id;
          App.get('/api/admin/jobs/' + encodeURIComponent(row.id)).then((x) => { st.details[row.id] = x; }).catch(() => { st.details[row.id] = row; }).finally(() => { st.detailLoading = null; refresh(); });
        }
        body += '<div class="toolbar">' + UI.search('Job id or trace id', 'data-jobsearch aria-label="Job id or trace id"', st.jobQuery)
          + UI.select([{ value: 'all', label: 'Every state' }].concat(STATES.map((x) => ({ value: x, label: x.charAt(0).toUpperCase() + x.slice(1) }))), st.jobState, 'data-jobstate aria-label="State" style="width:auto;max-width:100%"')
          + UI.select([{ value: 'all', label: 'Every type' }].concat(types.map((x) => ({ value: x.type, label: x.type }))), st.jobType, 'data-jobtype aria-label="Type" style="width:auto;max-width:100%"') + tenantPick
          + UI.seg([{ id: '1h', label: '1 h' }, { id: '24h', label: '24 h' }, { id: '7d', label: '7 d' }], st.window, 'data-window aria-label="Window"') + UI.btn('Retry failed', { size: 'sm', icon: 'refresh', attrs: 'data-retryall', disabled: !counts.failed }) + '<span class="muted right" style="font-size:12px">' + jobs.length + ' shown, ' + counts.queued + ' queued, ' + counts.running + ' running, ' + counts.failed + ' failed in the ' + WINDOW_LABEL[st.window] + '</span></div>'
          + UI.table(['Job', 'Type', 'Tenant and workspace', 'State', 'Progress', { label: 'Attempts', right: true }, 'Created', 'Started', 'Duration', 'Node'], jobs.map((j) => ({ cells: ['<span class="mono" style="font-weight:600" title="' + esc(j.id) + '">' + esc(j.id.slice(-8)) + '</span>', '<span class="mono" style="font-size:12px">' + esc(j.type) + '</span>', esc(j.tenantName || j.tenantId) + (j.workspaceName ? ' <span class="muted">/ ' + esc(j.workspaceName) + '</span>' : ''), UI.pill(j.state, STATE_KIND[j.state]), j.state === 'running' || j.state === 'preempted' || j.state === 'failed' ? '<div style="min-width:90px">' + UI.meter('', j.progress + ' %', j.progress, j.state === 'failed' ? 'danger' : j.state === 'preempted' ? 'warn' : 'accent') + '</div>' : j.state === 'succeeded' ? '<span class="muted">done</span>' : '<span class="muted">—</span>', '<span class="num">' + j.attempts + '</span>', esc(clock(j.createdAt)), esc(clock(j.startedAt)), esc(ms(j.durationMs)), j.node ? '<span class="mono" style="font-size:12px">' + esc(j.node) + '</span>' : '<span class="muted">—</span>'], attrs: 'data-job="' + esc(j.id) + '"', selected: j.id === st.selJob })), { minWidth: '1040px', emptyTitle: 'No jobs match', emptyText: 'Widen the window or clear the filters.' })
          + '<span class="muted" style="font-size:12px">Jobs carry their tenant and the principal that started them; ' + (platform ? 'as a system admin you see every tenant\'s, or one with the tenant filter.' : 'you see your tenant\'s.') + ' Payloads are shown as keys only. Progress is what the worker reports.</span>';
        if (sel) {
          insp = '<div class="hstack"><div class="eyebrow grow">Job</div>' + UI.pill(sel.state, STATE_KIND[sel.state]) + '</div><div class="mono" style="font-size:14px;font-weight:600;overflow-wrap:anywhere">' + esc(sel.id) + '</div><div class="mono fg2" style="font-size:12px">' + esc(sel.type) + '</div>'
            + UI.kv([['Tenant', esc(sel.tenantName || sel.tenantId) + (sel.workspaceName ? ', ' + esc(sel.workspaceName) : '')], ['Attempts', sel.attempts + ' of ' + sel.maxAttempts], ['Created', esc(clock(sel.createdAt))], ['Started', esc(sel.startedAt ? clock(sel.startedAt) : 'not yet')], ['Duration', esc(ms(sel.durationMs))], ['Node', sel.node ? '<span class="mono" style="overflow-wrap:anywhere">' + esc(sel.node) + '</span>' : 'not claimed'], ['Started by', esc(sel.createdByName || (sel.createdBy ? sel.createdBy : 'the scheduler'))]], 2)
            + '<div class="eyebrow">Payload keys</div><div class="hstack wrap gap4">' + (sel.payloadKeys.length ? sel.payloadKeys.map((k) => '<span class="pill outline mono">' + esc(k) + '</span>').join('') : '<span class="muted" style="font-size:12px">none</span>') + '</div><span class="muted" style="font-size:11px">Values are never shown here: they can carry tenant content.</span>'
            + (sel.message ? UI.kv([['Message', esc(sel.message)]], 1) : '')
            + (sel.error && sel.state === 'failed' ? UI.problem('Failed after ' + sel.attempts + (sel.attempts === 1 ? ' attempt' : ' attempts'), sel.error, sel.traceId) : sel.error ? UI.kv([['Last error', esc(sel.error)]], 1) : '')
            + '<div class="eyebrow">Trace</div>' + (sel.traceId ? '<div class="hstack gap6"><span class="mono" style="font-size:11px;overflow-wrap:anywhere">' + esc(sel.traceId) + '</span>' + UI.iconbtn('copy', 'Copy trace id', { cls: 'sm ghost', attrs: 'data-copytrace' }) + '</div><span class="muted" style="font-size:11px">Look it up in the collector at OTEL_EXPORTER_OTLP_ENDPOINT.</span>' : '<span class="muted" style="font-size:12px">' + (D.jobs.tracing ? 'No trace: it was queued outside a recorded request.' : 'Tracing is off: OTEL_EXPORTER_OTLP_ENDPOINT is unset.') + '</span>')
            + (sel.timeline ? '<div class="eyebrow">Progress</div>' + UI.timeline(sel.timeline.map((e) => ({ title: esc(e.title), text: e.text ? esc(e.text) : '', meta: esc(clock(e.at)), tone: e.tone }))) : '')
            + '<div class="hstack wrap gap6">' + (sel.state === 'queued' || sel.state === 'running' ? UI.btn('Cancel', { kind: 'danger', size: 'sm', icon: 'stop', attrs: 'data-canceljob' }) : '') + (sel.state === 'failed' || sel.state === 'cancelled' || sel.state === 'preempted' ? UI.btn(sel.state === 'preempted' ? 'Resume' : 'Retry', { kind: 'primary', size: 'sm', icon: 'refresh', attrs: 'data-retryjob' }) : '') + UI.btn('Type', { size: 'sm', kind: 'ghost', attrs: 'data-opentype="' + esc(sel.type) + '"' }) + '</div>'
            + '<span class="muted" style="font-size:12px">Audit entries: jobs.cancelled, jobs.retried. job.progress reaches the starter\'s sockets.</span>';
        }
      }
      // ---------------- Schedules ----------------
      if (st.tab === 'schedules') {
        const rows = D.schedules.items;
        if (!rows.some((s) => s.name === st.selSched)) st.selSched = rows.length ? rows[0].name : null;
        const sel = rows.find((s) => s.name === st.selSched);
        const resultOf = (s) => (s.last ? (s.last.state === 'failed' ? '<span style="color:var(--danger-fg)">' + esc(s.last.result) + '</span>' : esc(s.last.result)) : '<span class="muted">not run yet</span>');
        body += '<div class="toolbar">' + UI.pill(rows.filter((s) => !s.paused).length + ' scheduled', 'ok') + (rows.some((s) => s.paused) ? UI.pill(rows.filter((s) => s.paused).length + ' paused', 'warn') : '') + '<span class="muted right" style="font-size:12px">The Scheduler queues each once per bucket; two instances never run the same bucket twice.</span></div>'
          + UI.table(['Schedule', 'Every', 'Last run', 'Next run', 'Last result', 'Targets', 'State'], rows.map((s) => ({ cells: ['<span class="mono" style="font-weight:600">' + esc(s.name) + '</span>', '<span class="mono" style="font-size:11px">' + esc(s.setting ? s.setting + ' (' + every(s.everyMs) + ')' : every(s.everyMs)) + '</span>', esc(s.last ? clock(s.last.at) : '—'), s.paused ? '<span class="muted">paused</span>' : esc(until(s.nextAt)), resultOf(s), esc(s.targets === 'platform' ? 'platform' : s.targets), UI.pill(s.paused ? 'paused' : 'scheduled', s.paused ? 'warn' : 'ok')], attrs: 'data-sched="' + esc(s.name) + '"', selected: sel && s.name === sel.name })), { minWidth: '980px', emptyTitle: 'No schedules here', emptyText: 'The instance that answered registers no schedules (WORKERS_ENABLED=false).' })
          + '<span class="muted" style="font-size:12px">Recurring work runs as the tenant it targets; platform-wide schedules run in the default tenant. A paused schedule queues nothing, and the buckets it misses are not caught up.</span>';
        if (sel) {
          insp = '<div class="hstack"><div class="eyebrow grow">Schedule</div>' + UI.pill(sel.paused ? 'paused' : 'scheduled', sel.paused ? 'warn' : 'ok') + '</div><div class="mono" style="font-size:15px;font-weight:600;overflow-wrap:anywhere">' + esc(sel.name) + '</div><div class="fg2" style="font-size:12px">' + esc(sel.description || 'Queues the ' + sel.type + ' job for each target once per period.') + '</div>'
            + (sel.pause ? UI.notice('Paused at ' + esc(clock(sel.pause.at)) + (sel.pause.reason ? ': ' + esc(sel.pause.reason) : '') + '. Alerts that depend on it go quiet too.', 'warn') : '')
            + UI.kv([['Every', '<span class="mono" style="font-size:11px">' + esc(every(sel.everyMs)) + '</span>'], ['Job type', '<span class="mono" style="font-size:11px">' + esc(sel.type) + '</span>'], ['Targets', esc(sel.targets)], ['Next run', sel.paused ? 'paused' : esc(until(sel.nextAt))], ['Last result', resultOf(sel)], ['Period set by', sel.setting ? '<a href="#/configuration" class="mono" data-gosetting="' + esc(sel.setting) + '" style="font-size:11px">' + esc(sel.setting) + '</a>' : '<span class="muted">fixed in code</span>']], 2)
            + '<div class="eyebrow">Last five runs</div>' + (sel.runs.length ? UI.table(['When', 'Result', 'Took'], sel.runs.map((r) => [esc(clock(r.at)) + (r.manual ? ' <span class="muted" style="font-size:11px">run now</span>' : ''), r.state === 'failed' ? '<span style="color:var(--danger-fg)">' + esc(r.result) + '</span>' : esc(r.result), esc(ms(r.durationMs))]), { clickable: false, minWidth: '0', cls: 'bare' }) : '<span class="muted" style="font-size:12px">No runs recorded yet.</span>')
            + (platform ? '<div class="hstack wrap gap6">' + UI.btn('Run now', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-runnow' }) + (sel.paused ? UI.btn('Resume', { size: 'sm', attrs: 'data-resumesched' }) : UI.btn('Pause', { size: 'sm', icon: 'pause', attrs: 'data-pausesched' })) + '</div>' : '<span class="muted" style="font-size:12px">Running or pausing a schedule acts on every tenant and needs a system admin.</span>')
            + '<span class="muted" style="font-size:12px">Audit entries: jobs.schedule.run, jobs.schedule.paused, jobs.schedule.resumed.</span>';
        }
      }
      // ---------------- Dead letters ----------------
      if (st.tab === 'deadletters') {
        const rows = D.dead.items;
        if (!rows.some((x) => x.id === st.selDead)) st.selDead = rows.length ? rows[0].id : null;
        const sel = rows.find((x) => x.id === st.selDead);
        const SRC = { moderation: 'Moderation dead-letter queue', workflow: 'Workflow run' };
        body += '<div class="toolbar"><span class="muted" style="font-size:12px">Everything that gave up in your tenant, from the domains that keep dead letters' + (D.dead.sources.length ? ' (' + D.dead.sources.map((x) => esc(SRC[x])).join(', ') + ')' : '') + '. Redrive queues it again; discard records why it was dropped.</span></div>'
          + (D.dead.sources.length ? '' : UI.notice('Dead letters need moderation:manage (moderation jobs) or workflows:manage (workflow runs).', 'info'))
          + UI.table(['Source', 'Item', 'Reason', { label: 'Attempts', right: true }, 'Failed', { label: 'Actions', right: true }], rows.map((x) => ({ cells: ['<span style="font-weight:600">' + esc(SRC[x.source]) + '</span>', '<span class="mono" style="font-size:12px">' + esc(x.item) + '</span>', '<span class="fg2" style="font-size:12px">' + esc(x.reason || '—') + '</span>', '<span class="num">' + (x.attempts == null ? '—' : x.attempts) + '</span>', esc(clock(x.lastFailedAt)), UI.btn('Redrive', { size: 'xs', attrs: 'data-redrive="' + esc(x.id) + '" aria-label="Redrive ' + esc(x.item) + '"' }) + ' ' + UI.btn('Discard', { size: 'xs', kind: 'danger', attrs: 'data-discard="' + esc(x.id) + '" aria-label="Discard ' + esc(x.item) + '"' })], attrs: 'data-dead="' + esc(x.id) + '"', selected: x.id === st.selDead })), { minWidth: '980px', emptyTitle: 'No dead letters', emptyText: 'Nothing has given up.' });
        if (sel) {
          insp = '<div class="eyebrow">Dead letter</div><div style="font-size:15px;font-weight:600">' + esc(SRC[sel.source]) + '</div><div class="mono fg2" style="font-size:12px;overflow-wrap:anywhere">' + esc(sel.item) + '</div>'
            + UI.kv([['Reason', esc(sel.reason || '—')], ['Attempts', sel.attempts == null ? '—' : String(sel.attempts)], ['Failed', esc(clock(sel.lastFailedAt))], ['Redrives as', '<span class="mono">' + esc(sel.redrivesAs) + '</span>']], 1)
            + '<div class="hstack wrap gap6">' + UI.btn('Redrive', { kind: 'primary', size: 'sm', icon: 'refresh', attrs: 'data-redrive="' + esc(sel.id) + '"' }) + UI.btn('Discard', { kind: 'danger', size: 'sm', icon: 'trash', attrs: 'data-discard="' + esc(sel.id) + '"' }) + UI.btn('Open in ' + (sel.source === 'moderation' ? 'Moderation' : 'Workflows'), { size: 'sm', kind: 'ghost', attrs: 'data-godomain="' + esc(sel.id) + '"' }) + '</div>'
            + '<span class="muted" style="font-size:12px">Audit entries: ' + (sel.source === 'moderation' ? 'moderation.job.redriven' : 'workflow.dead_letter.redriven') + ', jobs.deadletter.discarded.</span>';
        }
      }
      // ---------------- Cache ----------------
      if (st.tab === 'cache') {
        const C = D.cache;
        const items = C.items;
        const total = items.reduce((a, x) => a + x.requests, 0), hits = items.reduce((a, x) => a + x.hits, 0), invL = items.reduce((a, x) => a + x.invalidations.local, 0), invB = items.reduce((a, x) => a + x.invalidations.bus, 0);
        const counted = items.every((x) => x.entries != null);
        const entries = items.reduce((a, x) => a + (x.entries || 0), 0);
        if (!items.some((x) => x.ns === st.selNs)) st.selNs = items.length ? items[0].ns : null;
        const sel = items.find((x) => x.ns === st.selNs);
        const ttl = (tier) => (tier ? 'CACHE_TTL_' + tier.toUpperCase() + '_SECONDS (' + C.ttlSeconds[tier] + ' s)' : '—');
        body += (C.store === 'memory' && C.instances > 1 ? UI.notice('<b>CACHE_STORE is memory on ' + C.instances + ' instances:</b> each keeps its own cache (CACHE_MAX_ENTRIES ' + num(C.maxEntries) + ', least recently used first) and invalidations travel over the bus, so a write on one instance clears the entry on the others within the bus delay.', 'info') : '')
          + '<div class="stats">' + UI.stat(esc(C.store === 'redis' ? 'Redis' : 'memory'), 'Store', C.store === 'redis' ? 'shared, REDIS_URL' : 'per instance') + UI.stat(counted ? num(entries) : '—', 'Entries', counted ? 'your tenant, on this instance' : 'not counted in a shared store') + UI.stat(pct(hits, total), 'Hit rate', 'this instance since it started, ' + num(total) + ' reads') + UI.stat(num(invL + invB), 'Invalidations', num(invL) + ' local, ' + num(invB) + ' from the bus') + '</div>'
          + UI.table(['Namespace', 'Tier', 'TTL', { label: 'Requests', right: true }, { label: 'Hit rate', right: true }, { label: 'Invalidations', right: true }, { label: 'Entries', right: true }, { label: 'Actions', right: true }], items.map((x) => ({ cells: ['<span style="font-weight:600" class="mono">' + esc(x.ns) + '</span>', x.tier ? UI.pill(x.tier, x.tier === 'short' ? 'info' : x.tier === 'long' ? 'outline' : '') : '<span class="muted">—</span>', '<span class="mono" style="font-size:11px">' + esc(ttl(x.tier)) + '</span>', '<span class="num">' + num(x.requests) + '</span>', '<span class="num"' + (x.requests && x.hits / x.requests < 0.85 ? ' style="color:var(--warn-fg)"' : '') + '>' + pct(x.hits, x.requests) + '</span>', '<span class="num">' + (x.invalidations.local + x.invalidations.bus) + '</span>', '<span class="num">' + (x.entries == null ? '—' : num(x.entries)) + '</span>', UI.btn('Invalidate', { size: 'xs', attrs: 'data-invalidate="' + esc(x.ns) + '" aria-label="Invalidate ' + esc(x.ns) + '"' })], attrs: 'data-ns="' + esc(x.ns) + '"', selected: x.ns === st.selNs })), { minWidth: '940px' })
          + '<span class="muted" style="font-size:12px">The tenant cache (B-2102) keys on tenant, namespace and key; a miss runs the loader once and concurrent misses wait for it. Counted in exprsn_cache_requests_total and exprsn_cache_invalidations_total.</span>';
        if (sel) {
          insp = '<div class="eyebrow">Namespace</div><div style="font-size:15px;font-weight:600" class="mono">' + esc(sel.ns) + '</div>' + (sel.description ? '<div class="fg2" style="font-size:12px">' + esc(sel.description) + '</div>' : '')
            + UI.kv([['Tier', esc(sel.tier || 'not read yet')], ['TTL', '<span class="mono" style="font-size:11px">' + esc(ttl(sel.tier)) + '</span>'], ['Requests', num(sel.requests)], ['Hit rate', pct(sel.hits, sel.requests)], ['Invalidations', sel.invalidations.local + ' local, ' + sel.invalidations.bus + ' from the bus'], ['Entries', sel.entries == null ? 'not counted' : num(sel.entries)]], 2)
            + (sel.requests >= 20 && sel.hits / sel.requests < 0.85 ? UI.notice('Hit rate below 85 %: frequent writes or a short tier. A longer CACHE_TTL_' + String(sel.tier || 'short').toUpperCase() + '_SECONDS trades freshness for load.', 'warn') : '')
            + '<div>' + UI.btn('Invalidate namespace', { size: 'sm', icon: 'refresh', attrs: 'data-invalidate="' + esc(sel.ns) + '"' }) + '</div>'
            + '<span class="muted" style="font-size:12px">Invalidation is broadcast over the bus; every instance drops your tenant\'s entries. Audited jobs.cache.invalidated.</span>';
        }
      }

      root.innerHTML = '<style>#main > .page > *{flex-shrink:0}#main .jobs-insp .kv .v{font-size:12px}#main .jobs-insp .meter{min-width:0}#main .page td .num{white-space:nowrap}</style>'
        + '<div class="page">' + UI.pagehead('Jobs and queues', 'Every queue, job and schedule on the one JobQueue; the work that gave up, and the tenant cache.', UI.pill(backendLabel(Q.backend), Q.backend === 'bullmq' ? 'info' : 'outline') + UI.btn('Run a schedule', { attrs: 'data-goschedules' }) + UI.btn('Retry failed jobs', { kind: 'primary', icon: 'refresh', attrs: 'data-retryall', disabled: !counts.failed }))
        + tabs + body + '</div>'
        + (insp ? '<aside class="inspector w360 jobs-insp" aria-label="Inspector">' + insp + '</aside>' : '');

      // ---- events ----
      const reloadAll = () => { st.loaded = false; ctx.rerender(); };
      const act = (p, ok) => p.then((r) => { if (ok) ctx.toast(ok, 'ok', 5000); return r; }).catch((err) => { App.fail(err); reloadAll(); return undefined; });
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-goschedules]', () => { st.tab = 'schedules'; ctx.rerender(); });
      ctx.on('click', '[data-godead]', () => { st.tab = 'deadletters'; ctx.rerender(); });
      ctx.on('click', '[data-gooverview]', () => ctx.navigate('overview'));
      ctx.on('click', '[data-gosetting]', (e, t) => { e.preventDefault(); if (App.screens && App.screens.configuration) ctx.navigate('configuration', { q: t.dataset.gosetting }); else ctx.toast(esc(t.dataset.gosetting) + ' is set in the server\'s environment (docs/deploy.md).', '', 4000); });
      ctx.on('change', '[data-domain]', (e, t) => { st.domain = t.value; ctx.rerender(); });
      ctx.on('change', '[data-tenant]', (e, t) => { st.tenant = t.value; reloadAll(); });
      ctx.on('change', '[data-jobstate]', (e, t) => { st.jobState = t.value; reloadJobs(); });
      ctx.on('change', '[data-jobtype]', (e, t) => { st.jobType = t.value; reloadJobs(); });
      ctx.on('click', '[data-window] [data-seg]', (e, t) => { st.window = t.dataset.seg; reloadJobs(); });
      ctx.on('input', '[data-typesearch]', (e, t) => { st.typeQuery = t.value; ctx.rerender(); });
      ctx.on('input', '[data-jobsearch]', (e, t) => { st.jobQuery = t.value; if (st.searchTimer) clearTimeout(st.searchTimer); st.searchTimer = setTimeout(() => { st.searchTimer = null; const v = st.jobQuery.trim(); if (!v || /^[0-9A-Za-z]{1,32}$/.test(v)) reloadJobs(); }, 300); });
      ctx.on('click', 'tr[data-type]', (e, t) => { st.selType = t.dataset.type; ctx.rerender(); });
      ctx.on('click', 'tr[data-job]', (e, t) => { st.selJob = t.dataset.job; ctx.rerender(); });
      ctx.on('click', 'tr[data-sched]', (e, t) => { st.selSched = t.dataset.sched; ctx.rerender(); });
      ctx.on('click', 'tr[data-dead]', (e, t) => { if (e.target.closest('button')) return; st.selDead = t.dataset.dead; ctx.rerender(); });
      ctx.on('click', 'tr[data-ns]', (e, t) => { if (e.target.closest('button')) return; st.selNs = t.dataset.ns; ctx.rerender(); });
      ctx.on('click', '[data-openjob]', (e, t) => { e.preventDefault(); st.tab = 'jobs'; st.selJob = t.dataset.openjob; ctx.rerender(); });
      ctx.on('click', '[data-jobsfor]', (e, t) => { st.tab = 'jobs'; st.jobType = t.dataset.jobsfor; st.jobState = 'all'; st.window = '7d'; reloadJobs(); });
      ctx.on('click', '[data-opentype]', (e, t) => { st.tab = 'queues'; st.selType = t.dataset.opentype; st.domain = 'all'; st.typeQuery = ''; ctx.rerender(); });

      // queues
      const selType = types.find((x) => x.type === st.selType);
      ctx.on('click', '[data-pausetype]', () => askReason(ctx, { title: 'Pause ' + selType.type, tag: 'stops claiming', body: 'Jobs of this type keep being queued and none is claimed until it is resumed; running ones finish. Every instance honours the pause within one poll, for every tenant.', kv: [['Queued now', num(selType.queued)], ['Running', String(selType.running)]], ok: 'Pause' })
        .then((reason) => { if (reason == null) return; act(App.post('/api/admin/queues/' + encodeURIComponent(selType.type) + '/pause', reason ? { reason } : {}), esc(selType.type) + ' paused. Audited jobs.type.paused.').then((r) => { if (r) { D.queues = r; refresh(); } }); }));
      ctx.on('click', '[data-resumetype]', () => act(App.post('/api/admin/queues/' + encodeURIComponent(selType.type) + '/resume', {}), esc(selType.type) + ' resumed; claiming starts at the next poll. Audited jobs.type.resumed.').then((r) => { if (r) { D.queues = r; refresh(); } }));
      const retryFailed = (type) => {
        const n = type ? selType.failed24h : counts.failed;
        if (!n) { ctx.toast('No failed jobs in the window.'); return; }
        ctx.confirm({ title: type ? 'Retry failed ' + type + ' jobs' : 'Retry ' + n + ' failed jobs', tone: 'info', body: '<p class="fg2" style="margin:0">Each failed job ' + (type ? 'of this type in the last 24 h' : 'in the ' + WINDOW_LABEL[st.window]) + (platform && st.tenant === 'all' ? ', in every tenant,' : '') + ' is queued again with its payload and a fresh attempt count. Jobs whose cause is still there will fail again and say so.</p>', kv: [['Failed', String(n)], ['By', esc(me)]], ok: 'Retry' })
          .then((ok) => { if (!ok) return; const b = { window: type ? '24h' : st.window }; if (type) b.type = type; if (platform && st.tenant !== 'all') b.tenant = st.tenant; act(App.post('/api/admin/jobs/retry-failed', b)).then((r) => { if (!r) return; ctx.toast(r.retried + ' job' + (r.retried === 1 ? '' : 's') + ' queued again. Audited jobs.retried.', 'ok'); if (!type) { st.tab = 'jobs'; st.jobState = 'all'; } reloadAll(); }); });
      };
      ctx.on('click', '[data-retrytype]', () => retryFailed(selType.type));
      ctx.on('click', '[data-retryall]', () => retryFailed(null));
      if (st.openRetryAll && st.loaded) { st.openRetryAll = false; setTimeout(() => retryFailed(null), 50); }

      // jobs
      const selJob = jobs.find((x) => x.id === st.selJob);
      const afterJob = (r, msg) => { if (!r) return; st.details[r.id] = r; ctx.toast(msg, r.state === 'cancelled' ? 'warn' : 'ok'); reloadJobs(); };
      ctx.on('click', '[data-copytrace]', () => { try { navigator.clipboard.writeText(selJob.traceId); } catch (e) { /* no clipboard */ } ctx.toast('Trace id copied.'); });
      ctx.on('click', '[data-canceljob]', () => askReason(ctx, { title: 'Cancel ' + selJob.id.slice(-8), tone: 'danger', tag: 'after the current step', body: 'A queued job is dropped at once; a running one stops after its current step and keeps any checkpoint. The starter is told over their sockets.', kv: [['Type', esc(selJob.type)], ['Progress', selJob.progress + ' %']], ok: 'Cancel job', cancel: 'Keep running' })
        .then((reason) => { if (reason == null) return; act(App.post('/api/admin/jobs/' + encodeURIComponent(selJob.id) + '/cancel', reason ? { reason } : {})).then((r) => afterJob(r, esc(selJob.id.slice(-8)) + ' cancelled. Audited jobs.cancelled.')); }));
      ctx.on('click', '[data-retryjob]', () => ctx.confirm({ title: (selJob.state === 'preempted' ? 'Resume ' : 'Retry ') + selJob.id.slice(-8), tone: 'info', body: '<p class="fg2" style="margin:0">Queues the job again with the same payload and a fresh attempt count; its last error stays until the next attempt, and the audit chain keeps who did it.</p>', kv: [['Type', esc(selJob.type)], ['Attempts so far', String(selJob.attempts)]], ok: selJob.state === 'preempted' ? 'Resume' : 'Retry' })
        .then((ok) => { if (!ok) return; act(App.post('/api/admin/jobs/' + encodeURIComponent(selJob.id) + '/retry', {})).then((r) => afterJob(r, esc(selJob.id.slice(-8)) + ' queued again. Audited jobs.retried.')); }));

      // schedules
      const selSched = D.schedules.items.find((x) => x.name === st.selSched);
      const runNow = () => { if (!selSched) { ctx.toast('No schedules here.'); return; } if (!platform) { ctx.toast('Running a schedule needs a system admin.', 'warn'); return; } ctx.confirm({ title: 'Run ' + selSched.name + ' now', tone: 'info', body: '<p class="fg2" style="margin:0">Queues one run outside its bucket for ' + esc(selSched.targets) + '. The next scheduled run is unchanged.</p>', kv: [['Targets', esc(selSched.targets)], ['Next scheduled', esc(until(selSched.nextAt))]], ok: 'Run now' })
        .then((ok) => { if (!ok) return; act(App.post('/api/admin/schedules/' + encodeURIComponent(selSched.name) + '/run', {})).then((r) => { if (!r) return; ctx.toast(esc(selSched.name) + ': ' + r.queued + ' job' + (r.queued === 1 ? '' : 's') + ' queued. Audited jobs.schedule.run.', 'ok'); reloadAll(); }); }); };
      ctx.on('click', '[data-runnow]', runNow);
      if (st.openRunNow && st.loaded) { st.openRunNow = false; setTimeout(runNow, 50); }
      ctx.on('click', '[data-pausesched]', () => askReason(ctx, { title: 'Pause ' + selSched.name, tag: 'skips buckets', body: 'No run is queued until it is resumed; the buckets it misses are not caught up. Alerts that depend on it (RPO, drift, expiry) go quiet too.', ok: 'Pause' })
        .then((reason) => { if (reason == null) return; act(App.post('/api/admin/schedules/' + encodeURIComponent(selSched.name) + '/pause', reason ? { reason } : {}), esc(selSched.name) + ' paused. Audited jobs.schedule.paused.').then((r) => { if (r) { D.schedules = r; refresh(); } }); }));
      ctx.on('click', '[data-resumesched]', () => act(App.post('/api/admin/schedules/' + encodeURIComponent(selSched.name) + '/resume', {}), esc(selSched.name) + ' resumed. Audited jobs.schedule.resumed.').then((r) => { if (r) { D.schedules = r; refresh(); } }));

      // dead letters
      const deadOf = (id) => D.dead.items.find((x) => x.id === id);
      ctx.on('click', '[data-redrive]', (e, t) => { const x = deadOf(t.dataset.redrive); if (!x) return; ctx.confirm({ title: 'Redrive ' + x.item.split(',')[0], tone: 'info', body: '<p class="fg2" style="margin:0">' + (x.source === 'moderation' ? 'Queues a new <span class="mono">' + esc(x.redrivesAs) + '</span> job with the original payload.' : 'Replays the workflow run from the step that failed.') + ' If the cause is still there it fails again and comes back here.</p>', kv: [['Source', esc(x.source)], ['Attempts so far', x.attempts == null ? '—' : String(x.attempts)]], ok: 'Redrive' })
        .then((ok) => { if (!ok) return; act(App.post('/api/admin/dead-letters/' + x.source + '/' + encodeURIComponent(x.id) + '/redrive', {})).then((r) => { if (!r) return; ctx.toast(r.jobId ? 'Redriven as job ' + esc(r.jobId.slice(-8)) + ' (queued). Audited moderation.job.redriven.' : 'Redriven as run ' + esc(String(r.runId || '').slice(-8)) + '. Audited workflow.dead_letter.redriven.', 'ok'); if (r.jobId) { st.tab = 'jobs'; st.selJob = r.jobId; st.jobState = 'all'; st.jobType = 'all'; st.jobQuery = ''; } reloadAll(); }); }); });
      ctx.on('click', '[data-discard]', (e, t) => { const x = deadOf(t.dataset.discard); if (!x) return; askReason(ctx, { title: 'Discard ' + x.item.split(',')[0], tone: 'danger', tag: 'destructive', required: true, body: 'The item is dropped for good; the reason, the attempts and your note stay in the audit chain.' + (x.source === 'moderation' ? ' For a moderation item the flag stays open for a reviewer.' : ''), kv: [['Source', esc(x.source)]], ok: 'Discard' })
        .then((reason) => { if (!reason) return; act(App.post('/api/admin/dead-letters/' + x.source + '/' + encodeURIComponent(x.id) + '/discard', { reason })).then((r) => { if (!r) return; D.dead = r; refresh(); ctx.toast('Discarded. Audited jobs.deadletter.discarded.', 'danger'); }); }); });
      ctx.on('click', '[data-godomain]', (e, t) => { const x = deadOf(t.dataset.godomain); if (x) ctx.navigate(x.link.route, x.link.params); });

      // cache
      ctx.on('click', '[data-invalidate]', (e, t) => { const x = D.cache.items.find((c) => c.ns === t.dataset.invalidate); if (!x) return; ctx.confirm({ title: 'Invalidate ' + x.ns, tone: 'info', tag: 'broadcast', body: '<p class="fg2" style="margin:0">Drops every entry of the namespace for your tenant and publishes the invalidation on the bus, so every instance drops its own. The next read runs the loader once.</p>', kv: [['Entries', x.entries == null ? 'not counted' : num(x.entries)], ['Store', D.cache.store === 'redis' ? 'Redis, shared' : 'memory, per instance']], ok: 'Invalidate' })
        .then((ok) => { if (!ok) return; act(App.post('/api/admin/cache/' + encodeURIComponent(x.ns) + '/invalidate', {}), esc(x.ns) + ' invalidated on every instance. Audited jobs.cache.invalidated.').then((r) => { if (r) { D.cache = r; st.selNs = x.ns; refresh(); } }); }); });
    }
  });
})();
