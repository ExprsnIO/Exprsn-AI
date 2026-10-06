(function () {
  const { UI, esc } = App;

  // 1.6.0 (B-4202): the Overview, first in the Admin group (Q3). GET /api/admin/overview; acknowledge alerts tenant-wide
  // (Q15); drain an instance with a confirm and a recent sign-in (Q14).
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const clock = (ms) => { const d = new Date(ms); const today = new Date(); return (d.toDateString() === today.toDateString() ? '' : d.getDate() + ' ' + MON[d.getMonth()] + ' ') + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const ago = (ms) => { if (!ms) return 'never'; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + ' s'; if (s < 3600) return Math.floor(s / 60) + ' min'; if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min'; return Math.floor(s / 86400) + ' d ' + Math.floor((s % 86400) / 3600) + ' h'; };
  const until = (ms) => { const s = Math.round((ms - Date.now()) / 1000); if (s <= 60) return 'in 1 min'; if (s < 3600) return 'in ' + Math.round(s / 60) + ' min'; if (s < 86400) return 'at ' + clock(ms); return clock(ms); };
  const bytes = (n) => { if (n == null) return 'unknown'; const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; let v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return (i ? v.toFixed(v >= 100 ? 0 : 1) : v) + ' ' + u[i]; };
  const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const stateKind = (s) => (s === 'ready' ? 'ok' : s === 'not ready' ? 'danger' : s === 'draining' ? 'warn' : 'neutral');
  const checkPill = (v) => (v == null ? '<span class="muted">—</span>' : v === 'ok' ? UI.pill('ok', 'ok') : v === 'draining' ? UI.pill('draining', 'warn') : UI.pill(String(v).replace(/^behind: .*/, 'behind'), 'danger'));
  const WINDOW_LABEL = { '1h': 'the last hour', '24h': 'the last 24 hours', '7d': 'the last 7 days' };

  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">Draining an instance needs a fresh check of who you are. ' + (pw && totp ? 'Enter your password or a code from your authenticator.' : pw ? 'Enter your password.' : totp ? 'Enter a code from your authenticator.' : 'Sign out and sign in again.') + '</div>'
        + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
        + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
        + '<div data-suerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + (pw || totp ? UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }) : ''),
      onMount(m) {
        const err = m.querySelector('[data-suerr]'); const first = m.querySelector('input'); if (first) first.focus();
        const go = async () => {
          const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
          const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
          if (!pwv && !code) { err.innerHTML = UI.notice('Enter your password or a code.', 'warn'); return; }
          try { await App.post('/api/me/step-up', pwv ? { password: pwv } : { code }); ok = true; App.closeOverlay(); }
          catch (e) { err.innerHTML = UI.notice(esc((e.problem && e.problem.detail) || e.message), 'danger'); }
        };
        const b = m.querySelector('[data-sugo]'); if (b) b.addEventListener('click', go);
        m.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }));
      },
      onClose() { resolve(ok); } });
  });
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) return undefined;
      return fn();
    }
  };

  App.register({
    id: 'overview', title: 'Overview', section: 'admin', crumb: ['Admin', 'Overview'], live: true,
    summary: 'Open alerts, counters, instance health, scheduled work and capacity',
    commands: [
      { label: 'Acknowledge every alert', sub: 'Overview', run(app) { const s = app.stateFor('overview'); s.openAckAll = true; app.render(); } },
      { label: 'Drain an instance', sub: 'Overview', run(app) { const s = app.stateFor('overview'); s.openDrain = true; app.render(); } }
    ],
    states: [
      { title: 'Instance behind the schema', tone: 'danger', text: 'An instance started on a build older than the database: /readyz answers 503 with checks.schema "behind", it claims no jobs, and the alert and inspector name the migration.',
        apply(ctx) { const st = ctx.state; st.preview = false; const i = ((st.data && st.data.instances) || []).find((x) => x.schema && x.schema.state === 'behind'); if (i) st.sel = i.id; else ctx.toast('No instance is behind the schema. Every instance runs a build that knows the database\'s migrations.', 'ok', 5000); ctx.rerender(); } },
      { title: 'Rate limits degraded', tone: 'warn', text: 'Redis is configured and not answering, so each instance counts limits on its own. The alert, the capacity panel and the inspector name the fallback.',
        apply(ctx) { const st = ctx.state; st.preview = false; const i = ((st.data && st.data.instances) || []).find((x) => x.runtime && x.runtime.rateLimit && x.runtime.rateLimit.degraded); if (i) st.sel = i.id; else ctx.toast('Rate limits are not degraded: ' + ((st.data && st.data.capacity && st.data.capacity.rateLimit.kind === 'redis') ? 'Redis answers the probe.' : 'counters are in memory (no REDIS_URL), which is never degraded.'), 'ok', 5000); ctx.rerender(); } },
      { title: 'Backup RPO missed', tone: 'danger', text: 'A backup older than PLATFORM_BACKUP_RPO_MINUTES raises a platform alert that admins acknowledge; it opens Platform, Backups.',
        apply(ctx) { const st = ctx.state; st.preview = false; const a = ((st.data && st.data.alerts) || []).find((x) => x.kind === 'rpo'); st.focusAlert = a ? a.key : null; if (!a) ctx.toast('The backup is within its RPO, or its alert was acknowledged.', 'ok', 5000); ctx.rerender(); } },
      { title: 'Everything healthy', tone: 'ok', text: 'No open alerts, every instance ready and current. The alert area shows the empty state and nothing on the page is red.',
        apply(ctx) { const st = ctx.state; st.preview = false; st.sel = null; const n = ((st.data && st.data.alerts) || []).length; if (n) ctx.toast(n + ' alert' + (n === 1 ? ' is' : 's are') + ' open; acknowledge ' + (n === 1 ? 'it' : 'them') + ' or put the cause right.', 'warn', 5000); ctx.rerender(); } },
      { title: 'Tenant admin view', tone: 'neutral', text: 'A tenant admin without platform:manage sees the counters, scheduled work and recent audit of their tenant; the instances table and capacity panel are replaced by a notice.',
        apply(ctx) { const st = ctx.state; st.preview = true; st.sel = null; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.window = st.window || '24h';
      if (ctx.params.instance && st.paramInstance !== ctx.params.instance) { st.paramInstance = ctx.params.instance; st.sel = ctx.params.instance; }

      const refresh = () => {
        if (App.state.route !== 'overview') return;
        if (document.getElementById('overlay')) { st.dirty = true; return; }
        ctx.rerender();
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        App.get('/api/admin/overview?window=' + encodeURIComponent(st.window))
          .then((d) => { st.data = d; st.loadError = null; st.loaded = true; })
          .catch((err) => { st.loadError = err; st.loaded = true; })
          .finally(() => {
            st.loading = false;
            if (st.timer) clearTimeout(st.timer);
            // Instances beat every heartbeatSeconds; the page follows at that pace while it is open.
            st.timer = setTimeout(() => { st.timer = null; if (App.state.route === 'overview' && !document.getElementById('overlay')) { st.loaded = false; ctx.rerender(); } }, Math.max(10, (st.data && st.data.heartbeatSeconds) || 30) * 1000);
            refresh();
          });
      };
      if (!st.loaded) load();

      if (!st.data) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Overview', 'What needs attention now, and whether every instance is healthy')
          + (st.loadError ? UI.problem('The overview could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-retry' }) + '</div>' : '<div class="muted" role="status">Loading…</div>') + '</div>';
        ctx.on('click', '[data-retry]', () => { st.loadError = null; st.loaded = false; ctx.rerender(); });
        return;
      }

      const d = st.data;
      const platform = d.scope === 'platform' && !st.preview;
      const c = d.counters;
      const instances = platform ? (d.instances || []) : [];
      const live = instances.filter((i) => i.state !== 'not answering');
      const ready = instances.filter((i) => i.state === 'ready').length;
      if (st.sel && !instances.some((i) => i.id === st.sel)) st.sel = null;
      const sel = instances.find((i) => i.id === st.sel) || null;
      const windowLabel = WINDOW_LABEL[st.window];
      const shown = st.preview ? d.alerts.filter((a) => a.kind === 'pki') : d.alerts;
      const me = (App.me && (App.me.displayName || App.me.username)) || 'you';

      // ---- alerts ----
      const alerts = shown.length
        ? '<div class="vstack">' + shown.map((a) => '<div' + (st.focusAlert === a.key ? ' class="overview-focus"' : '') + '>' + UI.notice('<b>' + esc(a.title) + '.</b> ' + esc(a.text) + ' <span class="muted" style="font-size:12px">Since ' + esc(clock(a.since)) + '.</span>', a.tone,
          '<div class="hstack gap6">' + UI.btn(a.open.label, { size: 'sm', attrs: 'data-openalert="' + esc(a.key) + '"' }) + UI.btn('Acknowledge', { size: 'sm', kind: 'ghost', attrs: 'data-ack="' + esc(a.key) + '" aria-label="Acknowledge: ' + esc(a.title) + '"' }) + '</div>') + '</div>').join('') + '</div>'
        : UI.empty('No open alerts', !platform ? 'Nothing in your tenant needs attention. Platform alerts (instances, backups, zones) go to system admins.' : st.acked ? 'Everything acknowledged. New alerts arrive here first; acknowledgements are tenant-wide and in the audit chain.' : 'Nothing needs attention. Alerts from the backup watch, the schema handshake, zone drift, certificate expiry and the rate-limit probe appear here first.');

      // ---- counters ----
      const oldest = c.oldestQueuedAt ? 'oldest ' + ago(c.oldestQueuedAt).replace(' ago', '') : 'none waiting';
      const stats = '<div class="stats">'
        + (platform ? UI.stat('<span class="num">' + ready + ' <span class="muted" style="font-size:14px">of ' + instances.length + '</span></span>', 'Instances ready', ready < instances.length ? '<span style="color:var(--danger-fg)">' + (instances.length - ready) + ' not ready</span>' : 'all current') : '')
        + UI.stat(num(c.queued), 'Queued jobs', esc(oldest) + (c.jobsScope === 'all tenants' ? ', all tenants' : ''))
        + UI.stat(num(c.running), 'Running jobs', c.runningOn != null ? 'on ' + c.runningOn + ' instance' + (c.runningOn === 1 ? '' : 's') : 'in your tenant')
        + UI.stat(num(c.failed), 'Failed jobs', 'in ' + esc(windowLabel) + ' · <a href="#/jobs?tab=jobs" data-go="jobs" data-tab="jobs">Jobs</a>')
        + '<button type="button" class="stat" data-go="flags" style="text-align:left;cursor:pointer;font:inherit;color:inherit"><div class="n">' + num(c.flags.open) + '</div><div class="l">Open flags</div><div class="d">' + (c.flags.overdue ? '<span style="color:var(--warn-fg)">' + c.flags.overdue + ' overdue</span>' : 'none overdue') + '</div></button>'
        + '<button type="button" class="stat" data-go="channels" style="text-align:left;cursor:pointer;font:inherit;color:inherit"><div class="n">' + num(c.heldReplies) + '</div><div class="l">Held replies</div><div class="d">waiting for a reviewer</div></button>'
        + UI.stat(num(c.signins), 'Sign-ins', esc(windowLabel) + (c.refusedBySanction ? ', <span style="color:var(--warn-fg)">' + c.refusedBySanction + ' refused by sanction</span>' : ''))
        + (platform && c.sockets ? UI.stat(num(c.sockets.total), 'Sockets', 'on ' + c.sockets.instances + ' instance' + (c.sockets.instances === 1 ? '' : 's')) : UI.stat(num(c.workspaces), 'Workspaces', 'in your tenant'))
        + '</div>';

      // ---- instances ----
      const claimed = (i) => i.state === 'not answering' ? '<span class="muted">—</span>' : '<span class="num">' + i.jobsClaimed + '</span>' + (i.state === 'not ready' && i.schema.state === 'behind' ? ' <span class="muted" style="font-size:11px">claims none while behind</span>' : i.state === 'draining' ? ' <span class="muted" style="font-size:11px">claims none, draining</span>' : '');
      const instTable = !platform
        ? UI.notice('Instance health is visible to system admins. Your tenant\'s counters, scheduled work and recent audit are shown; ask a system admin about instances and capacity.', 'info')
        : UI.table(['Instance', 'Role', 'Version', 'Schema', 'Database', 'KMS', 'Blobs', { label: 'Jobs claimed', right: true }, 'Started', 'State'], instances.map((i) => ({
          cells: ['<span class="mono" style="font-weight:600">' + esc(i.id) + '</span>' + (i.self ? ' <span class="muted" style="font-size:11px">this one</span>' : ''), esc(i.role), '<span class="mono">' + esc(i.version) + '</span>',
            checkPill(i.checks.schema), checkPill(i.checks.database), checkPill(i.checks.kms), checkPill(i.checks.blobs), claimed(i), esc(ago(i.startedAt)), UI.pill(i.state, stateKind(i.state))],
          attrs: 'data-inst="' + esc(i.id) + '"', selected: i.id === st.sel
        })), { minWidth: '940px', emptyTitle: 'No instance has reported', emptyText: 'Instances write a heartbeat when they start. One that runs without the console\'s server process (the CLI) does not appear.' })
        + '<span class="muted" style="font-size:12px">Instances register themselves on start and report /readyz and a heartbeat every ' + esc(String(d.heartbeatSeconds)) + ' s. An instance behind the schema stops claiming jobs and answers 503 until it runs the current build. Drain stops new work; nothing is restarted from the console.</span>';

      // ---- panels ----
      const lastKind = (s) => !s.last ? 'neutral' : s.last.state === 'succeeded' ? 'ok' : s.last.state === 'failed' ? 'danger' : 'info';
      const schedPanel = UI.panel('Scheduled work', (d.schedules.items.length ? '<div class="vstack gap6">' + d.schedules.items.map((s) => '<div class="hstack" style="font-size:12px"><span class="mono grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis">' + esc(s.name) + '</span><span class="muted num" style="white-space:nowrap">' + esc(until(s.nextAt)) + '</span>' + UI.pill(s.last ? (s.last.state === 'succeeded' ? 'ok' : s.last.state) : 'not run', lastKind(s)) + '</div>').join('') + '</div>' : '<div class="muted" style="font-size:12px">No schedules are registered on the instance that answered (an instance with WORKERS_ENABLED=false runs none).</div>')
        + (d.schedules.total ? '<span class="muted" style="font-size:11px">The next ' + d.schedules.items.length + ' of ' + d.schedules.total + ' schedules; every active tenant is a target unless the schedule is platform-wide.</span>' : ''), { actions: UI.btn('All schedules', { size: 'xs', kind: 'ghost', attrs: 'data-go="jobs" data-tab="schedules"' }) });
      const auditPanel = UI.panel('Recent audit', d.audit == null ? '<div class="muted" style="font-size:12px">Reading the audit chain needs audit:read.</div>' : d.audit.length ? '<div class="vstack gap6">' + d.audit.map((a) => '<div style="font-size:12px;min-width:0"><div class="hstack gap6"><span style="font-weight:600;white-space:nowrap">' + (a.redacted ? '<span class="muted">above your clearance</span>' : esc(a.actor)) + '</span><span class="mono grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis">' + esc(a.action) + '</span><span class="muted num" style="white-space:nowrap">' + esc(clock(a.ts)) + '</span></div>' + (a.object ? '<div class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(a.object) + '</div>' : '') + '</div>').join('') + '</div>' : '<div class="muted" style="font-size:12px">No audit events yet.</div>', { actions: App.can('audit:read') ? UI.btn('Usage and audit', { size: 'xs', kind: 'ghost', attrs: 'data-go="usage-audit"' }) : '' });
      const cap = d.capacity;
      const capPanel = !platform || !cap ? '' : UI.panel('Capacity', '<div class="vstack gap12">'
        + (cap.database.pool ? UI.meter('Database (' + esc(cap.database.client) + ')', bytes(cap.database.bytes) + ', ' + cap.database.pool.used + ' of ' + cap.database.pool.max + ' connections', Math.round(100 * cap.database.pool.used / cap.database.pool.max), cap.database.pool.used / cap.database.pool.max > 0.9 ? 'danger' : '') : UI.kv([['Database (' + esc(cap.database.client) + ')', esc(bytes(cap.database.bytes))]], 1))
        + UI.kv([['Vectors (' + esc(cap.vectors.store) + ')', num(cap.vectors.count)], ['Blob store (' + esc(cap.blobs.kind) + ')', cap.blobs.ok ? UI.pill('answering', 'ok') : UI.pill('unavailable', 'danger')], ['Cache store', esc(cap.cache.kind)]], 1)
        + UI.meter('Rate-limit store (' + esc(cap.rateLimit.kind) + ')', cap.rateLimit.kind === 'memory' ? 'in memory, per instance' : cap.rateLimit.degraded ? 'degraded: counting per instance' : 'shared, answering', 100, cap.rateLimit.degraded ? 'danger' : '')
        + '</div>', { actions: UI.btn('Platform', { size: 'xs', kind: 'ghost', attrs: 'data-go="platform"' }) });

      // ---- inspector ----
      let insp = '';
      if (sel && platform) {
        const rl = sel.runtime && sel.runtime.rateLimit; const tr = sel.runtime && sel.runtime.tracing;
        const checks = ['database', 'migrations', 'schema', 'kms', 'blobs', 'shutdown'].map((k) => [k, checkPill(sel.checks[k])]);
        insp = '<div class="hstack"><div class="eyebrow grow">Selected instance</div>' + UI.pill(sel.state, stateKind(sel.state)) + '</div>'
          + '<div style="font-size:15px;font-weight:600;overflow-wrap:anywhere" class="mono">' + esc(sel.id) + '</div><div class="fg2" style="font-size:12px">' + esc(sel.role) + ', ' + esc(sel.version) + ' on ' + esc(sel.node) + ', pid ' + sel.pid + '</div>'
          + (sel.schema.state === 'behind' ? UI.notice('<b>Behind the schema.</b> ' + esc(sel.schema.detail || '') + '. /readyz answers 503 and this instance claims no jobs. Deploy the current build here; it recovers on its own once its migrations match the database.', 'danger') : '')
          + (sel.state === 'draining' ? UI.notice('Draining since ' + esc(clock(sel.drainedAt || sel.heartbeatAt)) + ': no new jobs, /readyz answers 503; ' + sel.jobsClaimed + ' job' + (sel.jobsClaimed === 1 ? '' : 's') + ' finish first. Restart it to end the drain.', 'warn') : '')
          + (sel.state === 'not answering' ? UI.notice('No heartbeat since ' + esc(clock(sel.heartbeatAt)) + '. It went away without a clean shutdown, or cannot reach the database. Its row is removed a day after its last beat.', 'warn') : '')
          + '<div class="eyebrow">/readyz checks</div>' + UI.kv(checks, 2)
          + '<div class="eyebrow">Runtime</div>' + UI.kv([['Uptime', esc(dur((sel.state === 'not answering' ? sel.heartbeatAt : Date.now()) - sel.startedAt)) + ' <span class="muted">since ' + esc(clock(sel.startedAt)) + '</span>'], ['Heartbeat', esc(ago(sel.heartbeatAt))], ['Jobs claimed', String(sel.jobsClaimed) + (sel.runtime && sel.runtime.workersEnabled === false ? ' <span class="muted">(workers off)</span>' : '')], ['Sockets', String(sel.sockets)],
            ['Rate-limit store', rl ? (rl.degraded ? '<span style="color:var(--warn-fg)">per instance (Redis probe failing since ' + esc(clock(rl.since)) + ')</span>' : rl.kind === 'redis' ? 'Redis, shared' : 'in memory, this instance') : '—'],
            ['Tracing', tr ? (tr.enabled ? 'exported ' + num(tr.exported) + ', dropped ' + tr.dropped + ', failed ' + tr.failed : 'off (OTEL_EXPORTER_OTLP_ENDPOINT unset)') : '—'],
            ['NTP offset', sel.runtime && sel.runtime.ntpOffsetMs != null ? (sel.runtime.ntpOffsetMs > 0 ? '+' : '') + sel.runtime.ntpOffsetMs + ' ms' : '<span class="muted">not measured (NTP_SERVER unset)</span>']], 1)
          + (d.metricsUrl ? '<div class="eyebrow">Metrics</div><div class="hstack"><span class="mono grow" style="font-size:11px;overflow-wrap:anywhere">' + esc(d.metricsUrl) + '</span>' + UI.iconbtn('copy', 'Copy the metrics URL', { cls: 'sm ghost', attrs: 'data-copymetrics' }) + '</div><span class="muted" style="font-size:11px">' + (d.metricsToken ? 'Token protected (METRICS_TOKEN): scrape it with the bearer header. Each instance answers for itself behind the load balancer.' : 'No METRICS_TOKEN is set, so the endpoint is not served in production.') + '</span>' : '')
          + '<div class="hstack wrap gap6">' + UI.btn(sel.state === 'draining' ? 'Draining' : 'Drain', { size: 'sm', icon: 'pause', attrs: 'data-drain', disabled: sel.state === 'draining' || sel.state === 'not answering' }) + '</div>'
          + '<span class="muted" style="font-size:12px">Audit entries: platform.instance.drained, platform.alert.acknowledged. Nothing is restarted from the console.</span>';
      } else if (platform) {
        insp = '<div class="eyebrow">Instances</div><div class="fg2" style="font-size:12px">Select an instance for its /readyz checks, tracing, clock and rate-limit store, and to drain it.</div>'
          + '<div class="eyebrow">Window</div><div class="fg2" style="font-size:12px">The counters cover ' + esc(windowLabel) + '. Alerts, instances and capacity are always current.</div>';
      }

      root.innerHTML = '<style>#main .overview-focus{outline:2px solid var(--accent);outline-offset:2px;border-radius:var(--r-md,8px)}#main > .page > .stats,#main > .page > .vstack,#main > .page > .tablewrap{flex-shrink:0}</style><div class="page">'
        + UI.pagehead('Overview', platform ? 'What needs attention now, and whether every instance is healthy' : 'Your tenant: counters, scheduled work and recent audit', '<div class="hstack gap6 wrap">' + UI.seg([{ id: '1h', label: '1 h' }, { id: '24h', label: '24 h' }, { id: '7d', label: '7 d' }], st.window, 'data-window aria-label="Counters window"') + UI.btn('Acknowledge all', { attrs: 'data-ackall', disabled: !shown.length }) + '</div>')
        + (st.preview ? UI.notice('Showing what a tenant admin sees. ' + UI.btn('Back to the platform view', { size: 'xs', attrs: 'data-unpreview' }), 'info') : '')
        + '<div class="hstack"><h2 class="eyebrow grow" style="margin:0">Alerts</h2><span class="muted" style="font-size:12px">' + (shown.length ? shown.length + ' open, newest first' : 'none open') + '</span></div>' + alerts
        + '<h2 class="eyebrow" style="margin:0">' + esc(windowLabel.charAt(0).toUpperCase() + windowLabel.slice(1)) + '</h2>' + stats
        + (platform ? '<h2 class="eyebrow" style="margin:0">Instances</h2>' : '') + instTable
        + '<div class="' + (platform ? 'grid3' : 'grid2') + '">' + schedPanel + auditPanel + capPanel + '</div>'
        + '</div>' + (insp ? '<aside class="inspector w360" aria-label="Inspector">' + insp + '</aside>' : '');

      // ---- handlers ----
      ctx.on('click', '[data-window] [data-seg]', (e, t) => { st.window = t.dataset.seg; st.loaded = false; ctx.rerender(); });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go, t.dataset.tab ? { tab: t.dataset.tab } : undefined); });
      ctx.on('click', 'tr[data-inst]', (e, t) => { st.sel = t.dataset.inst; st.focusAlert = null; ctx.rerender(); });
      ctx.on('click', '[data-unpreview]', () => { st.preview = false; ctx.rerender(); });
      ctx.on('click', '[data-openalert]', (e, t) => { const a = d.alerts.find((x) => x.key === t.dataset.openalert); if (!a) return; if (a.open.instance) { st.sel = a.open.instance; ctx.rerender(); } else ctx.navigate(a.open.route, a.open.params); });
      const ack = (keys) => {
        const list = d.alerts.filter((a) => keys.indexOf(a.key) >= 0);
        if (!list.length) { ctx.toast('No open alerts', '', 1800); return; }
        ctx.confirm({ title: list.length === 1 ? 'Acknowledge alert' : 'Acknowledge ' + list.length + ' alerts', tag: 'tenant-wide', tone: 'info', body: '<p class="fg2" style="margin:0">The alert' + (list.length === 1 ? ' leaves' : 's leave') + ' this page for every administrator of the tenant. The condition is not changed; a watch that finds a new occurrence raises it again. Audited as platform.alert.acknowledged.</p>', kv: [['Alerts', list.map((a) => esc(a.title)).join('; ')], ['By', esc(me)]], ok: 'Acknowledge' })
          .then((ok) => {
            if (!ok) return;
            App.post('/api/admin/overview/alerts/acknowledge', { keys: list.map((a) => a.key) })
              .then((r) => { d.alerts = r.alerts; st.acked = (st.acked || 0) + list.length; st.focusAlert = null; ctx.rerender(); ctx.toast((list.length === 1 ? 'Alert' : list.length + ' alerts') + ' acknowledged. Audit event written.', 'ok'); })
              .catch((err) => { App.fail(err, 'Not acknowledged'); st.loaded = false; ctx.rerender(); });
          });
      };
      ctx.on('click', '[data-ack]', (e, t) => ack([t.dataset.ack]));
      ctx.on('click', '[data-ackall]', () => ack(shown.map((a) => a.key)));
      const drain = (inst) => ctx.confirm({ title: 'Drain ' + inst.id, tag: 'no new work', tone: 'info', body: '<p class="fg2" style="margin:0">The instance stops claiming jobs, reports draining on /readyz so the load balancer sends it nothing new, and finishes what it has. Undo by restarting it. You may be asked to confirm it is you. Audited as platform.instance.drained.</p>', kv: [['Instance', esc(inst.id) + ' on ' + esc(inst.node)], ['In flight', inst.jobsClaimed + ' job' + (inst.jobsClaimed === 1 ? '' : 's') + ', ' + inst.sockets + ' socket' + (inst.sockets === 1 ? '' : 's')]], ok: 'Drain' })
        .then(async (ok) => {
          if (!ok) return;
          try {
            const r = await withStepUp(ctx, () => App.post('/api/admin/overview/instances/' + encodeURIComponent(inst.id) + '/drain', {}));
            if (!r) return;
            const k = d.instances.findIndex((x) => x.id === r.id); if (k >= 0) d.instances[k] = r;
            st.sel = r.id; ctx.rerender();
            ctx.toast(esc(r.id) + ' is draining; ' + r.jobsClaimed + ' job' + (r.jobsClaimed === 1 ? '' : 's') + ' finish first. Audit event written.', 'ok', 5000);
          } catch (err) { App.fail(err, 'Not drained'); st.loaded = false; ctx.rerender(); }
        });
      ctx.on('click', '[data-drain]', () => { if (sel) drain(sel); });
      ctx.on('click', '[data-copymetrics]', () => { try { navigator.clipboard.writeText(d.metricsUrl); } catch (e) { /* no clipboard */ } ctx.toast('Metrics URL copied', 'ok', 1800); });

      if (st.openAckAll) { st.openAckAll = false; setTimeout(() => ack(shown.map((a) => a.key)), 60); }
      if (st.openDrain) {
        st.openDrain = false;
        if (!platform) ctx.toast('Draining an instance needs platform:manage.', 'warn');
        else { const i = sel || live.find((x) => x.state === 'ready'); if (i) { st.sel = i.id; setTimeout(() => drain(i), 60); } else ctx.toast('No instance is ready to drain.', 'warn'); }
      }
    }
  });
})();
