(function () {
  const { UI, esc } = App;

  // Sidebar entry: first item of the Admin group (app.js is left untouched, as Sprint 29 asked).
  (function addNav() { const g = App.NAV.find((x) => x.group === 'Admin'); if (g && !g.items.some((i) => i.id === 'overview')) g.items.unshift({ id: 'overview', label: 'Overview', icon: 'grid' }); })();

  // ---- example data: alerts, instances, schedules, audit and capacity for the Northwind deployment (now: 19 Sep 2026, 14:10) ----
  // Live (1.6.0, B-4202): instances are the server processes, each writing its own heartbeat row; the signer and the
  // training and image workers keep their health on their own screens. Capacity is what the server can measure.
  const ALERTS0 = () => [
    { id: 'al-5', tone: 'danger', title: 'Instance api-2 is behind the schema', text: 'Migration 032_dav is applied in the database and unknown to the build on api-2. The instance answers /readyz with 503 and claims no jobs until it runs the current build.', since: '13:29', open: { label: 'Open instance', inst: 'api-2' }, action: 'platform.alert.acknowledged', kind: 'schema' },
    { id: 'al-4', tone: 'danger', title: 'Backup store MinIO is 22 min past its RPO', text: 'The last consistent backup finished at 12:08; PLATFORM_BACKUP_RPO_MINUTES is 60. ops.backup.watch raised the alert at 13:30 and will clear it when the next backup lands.', since: '13:30', open: { label: 'Open backups', route: 'platform', params: { tab: 'backups' } }, kind: 'rpo' },
    { id: 'al-3', tone: 'warn', title: '3 certificates expire within 7 days', text: 'media.northwind.local (22 Sep), ldap-sync client (24 Sep) and the OCSP delegated signer (25 Sep). Renewal runs through internal ACME on the certificate sweep; the client certificate needs a new CSR.', since: '12:00', open: { label: 'Open certificates', route: 'certificates' }, kind: 'certs' },
    { id: 'al-2', tone: 'warn', title: 'Zone policy drift on data in-cluster', text: 'The NetworkPolicy for zone data differs from what was applied (ingress rule 2, a port was added by hand). zones.cluster.drift found it at 11:48; applying puts it right.', since: '11:48', open: { label: 'Open zones', route: 'zones' }, kind: 'drift' },
    { id: 'al-1', tone: 'warn', title: 'Rate limits counting per instance', text: 'Redis at redis.northwind.local:6379 has not answered the probe since 09:12. Each instance counts limits on its own until it does, so a client can send up to twice its allowance.', since: '09:12', open: { label: 'Open platform', route: 'platform' }, kind: 'ratelimit' }
  ];
  const INSTANCES0 = () => [
    { id: 'api-1', role: 'api, jobs', kind: 'app', version: '1.5.0-rc.1', schema: 'current', schemaDetail: '032_dav applied, nothing pending', database: 'ok', kms: 'ok', blobs: 'ok', claimed: 5, started: '3 d ago', startedAt: '16 Sep 2026 09:02', state: 'ready', node: 'node-a.northwind.local', pid: 2148, uptime: '3 d 5 h', tracing: { exported: 184210, dropped: 0, failed: 0 }, ntp: { offsetMs: -4, agreed: ['ntp1.northwind.local', 'ntp2.northwind.local'], outliers: [] }, ratelimit: 'per instance (Redis probe failing since 09:12)', shutdown: 'ok', metrics: 'https://api-1.northwind.local:8443/metrics', sockets: 201 },
    { id: 'api-2', role: 'api, jobs', kind: 'app', version: '1.5.0-rc.1', schema: 'behind', schemaDetail: 'behind: migration 032_dav is in the database and not in this build', database: 'ok', kms: 'ok', blobs: 'ok', claimed: 0, claimedNote: 'claims none while behind', started: '41 min ago', startedAt: '19 Sep 2026 13:29', state: 'not ready', node: 'node-b.northwind.local', pid: 917, uptime: '41 min', tracing: { exported: 2210, dropped: 0, failed: 0 }, ntp: { offsetMs: 11, agreed: ['ntp1.northwind.local', 'ntp2.northwind.local'], outliers: [] }, ratelimit: 'per instance (Redis probe failing since 09:12)', shutdown: 'ok', metrics: 'https://api-2.northwind.local:8443/metrics', sockets: 117 }
  ];
  const SCHEDULES = [
    { name: 'audit.checkpoint', due: 'in 4 min', last: 'ok' }, { name: 'zones.cluster.drift', due: 'in 11 min', last: 'drift found' }, { name: 'guardrails.sweep', due: 'in 1 min', last: 'ok' },
    { name: 'ops.backup.watch', due: 'in 14 min', last: 'RPO missed' }, { name: 'pki.crl', due: 'in 2 h', last: 'ok' }, { name: 'ops.backup.create', due: 'at 23:00', last: 'ok' }
  ];
  const AUDIT = [
    { actor: 'platform-ops', action: 'platform.alert.raised', object: 'schema behind, api-2', at: '13:29' }, { actor: 'Jonas Lindqvist', action: 'zone.cluster.check', object: 'data: drift', at: '11:48' },
    { actor: 'Mara Okafor', action: 'plugin.grants.updated', object: 'erp-record-sync', at: '11:20' }, { actor: 'Felix Brandt', action: 'record.transitioned', object: 'INV-2291 approved → paid', at: '10:55' },
    { actor: 'Lena Hoffmann', action: 'file.shared', object: 'onboarding-pack.pdf, link', at: '10:31' }, { actor: 'Noor Rahimi', action: 'group.event.cancelled', object: 'Payroll clinic, 12 notified', at: '10:02' },
    { actor: 'platform-ops', action: 'ratelimit.degraded', object: 'redis.northwind.local', at: '09:12' }, { actor: 'Mara Okafor', action: 'auth.login', object: 'TOTP, Chrome on macOS', at: '08:51' }
  ];
  const COUNTS = { '1h': { queued: 41, oldest: '4 min', running: 7, failed: 1, signins: 38, refused: 0 }, '24h': { queued: 41, oldest: '4 min', running: 7, failed: 5, signins: 212, refused: 2 }, '7d': { queued: 41, oldest: '4 min', running: 7, failed: 23, signins: 1480, refused: 6 } };
  const stateKind = (s) => s === 'ready' ? 'ok' : s === 'not ready' ? 'danger' : s === 'draining' ? 'warn' : 'info';
  const checkPill = (v) => v == null ? '<span class="muted">—</span>' : v === 'ok' || /^sealed/.test(v) ? UI.pill(v, 'ok') : v === 'behind' ? UI.pill('behind 032_dav', 'danger') : v === 'current' ? UI.pill(v, 'ok') : UI.pill(v, 'danger');

  const init = (st) => {
    if (st.alerts) return;
    st.alerts = ALERTS0(); st.instances = INSTANCES0(); st.window = '24h'; st.sel = null; st.tenantView = false; st.redisOk = false; st.acked = 0;
  };
  const healthy = (st) => { st.alerts = []; st.redisOk = true; st.instances.forEach((i) => { i.state = 'ready'; if (i.id === 'api-2') { i.schema = 'current'; i.schemaDetail = '032_dav applied, nothing pending'; i.claimed = 4; delete i.claimedNote; i.version = '1.5.0-rc.2'; } i.ratelimit = i.kind === 'app' ? 'Redis, shared' : i.ratelimit; }); };

  App.register({
    id: 'overview', title: 'Overview', section: 'admin', crumb: ['Admin', 'Overview'],
    summary: 'Open alerts, counters, instance health, scheduled work and capacity',
    commands: [
      { label: 'Acknowledge every alert', sub: 'Overview', run(app) { const s = app.stateFor('overview'); init(s); s.openAckAll = true; app.render(); } },
      { label: 'Drain an instance', sub: 'Overview', run(app) { const s = app.stateFor('overview'); init(s); s.sel = s.sel || 'api-1'; s.openDrain = true; app.render(); } }
    ],
    states: [
      { title: 'Instance behind the schema', tone: 'danger', text: 'api-2 started on an older build after migration 032_dav was applied: /readyz answers 503 with checks.schema "behind", the instance claims no jobs, and the alert and inspector say which migration.', apply(ctx) { init(ctx.state); const st = ctx.state; st.tenantView = false; if (!st.alerts.some((a) => a.kind === 'schema')) st.alerts.unshift(ALERTS0()[0]); const i = st.instances.find((x) => x.id === 'api-2'); i.schema = 'behind'; i.schemaDetail = 'behind: migration 032_dav is in the database and not in this build'; i.state = 'not ready'; i.claimed = 0; i.claimedNote = 'claims none while behind'; st.sel = 'api-2'; ctx.rerender(); } },
      { title: 'Rate limits degraded', tone: 'warn', text: 'Redis is configured and not answering, so each instance counts limits on its own (exprsn_ratelimit_degraded). The alert, the capacity meter and the inspector name the fallback.', apply(ctx) { init(ctx.state); const st = ctx.state; st.tenantView = false; st.redisOk = false; if (!st.alerts.some((a) => a.kind === 'ratelimit')) st.alerts.push(ALERTS0()[4]); st.instances.forEach((i) => { if (i.kind === 'app') i.ratelimit = 'per instance (Redis probe failing since 09:12)'; }); st.sel = 'api-1'; ctx.rerender(); } },
      { title: 'Backup RPO missed', tone: 'danger', text: 'A store past PLATFORM_BACKUP_RPO_MINUTES raises a platform alert that admins acknowledge; it is listed first and opens Platform › Backups.', apply(ctx) { init(ctx.state); const st = ctx.state; st.tenantView = false; st.alerts = st.alerts.filter((a) => a.kind !== 'rpo'); st.alerts.unshift(ALERTS0()[1]); ctx.rerender(); } },
      { title: 'Everything healthy', tone: 'ok', text: 'No open alerts, every instance ready and current, Redis answering. The alert area shows the empty state and nothing on the page is red.', apply(ctx) { init(ctx.state); const st = ctx.state; st.tenantView = false; healthy(st); st.sel = null; ctx.rerender(); } },
      { title: 'Tenant admin view', tone: 'neutral', text: 'A tenant admin without platform:manage sees the counters, scheduled work and recent audit of their tenant; the instances table and capacity panel are replaced by a notice.', apply(ctx) { init(ctx.state); ctx.state.tenantView = true; ctx.state.sel = null; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; init(st);
      if (ctx.params.instance) { st.sel = ctx.params.instance; delete ctx.params.instance; }
      const c = COUNTS[st.window]; const ready = st.instances.filter((i) => i.state === 'ready').length;
      const sel = st.instances.find((i) => i.id === st.sel);
      const windowLabel = { '1h': 'the last hour', '24h': 'the last 24 hours', '7d': 'the last 7 days' }[st.window];

      // ---- alerts ----
      const shown = st.tenantView ? st.alerts.filter((a) => a.kind === 'certs') : st.alerts;
      const alerts = shown.length
        ? '<div class="vstack">' + shown.map((a) => UI.notice('<b>' + esc(a.title) + '.</b> ' + esc(a.text) + ' <span class="muted" style="font-size:12px">Since ' + esc(a.since) + '.</span>', a.tone,
          '<div class="hstack gap6">' + UI.btn(a.open.label, { size: 'sm', attrs: 'data-openalert="' + a.id + '"' }) + UI.btn('Acknowledge', { size: 'sm', kind: 'ghost', attrs: 'data-ack="' + a.id + '"' }) + '</div>')).join('') + '</div>'
        : UI.empty('No open alerts', st.tenantView ? 'Nothing in your tenant needs attention. Platform alerts (instances, backups, zones) go to system admins.' : st.acked ? 'Everything acknowledged. New alerts arrive here first, then as notifications; acknowledgements are tenant-wide and in the audit chain.' : 'Nothing needs attention. Alerts from the backup watch, the schema guard, zone drift, the certificate sweep and the rate-limit probe appear here first.');

      // ---- counters ----
      const stats = '<div class="stats">'
        + (st.tenantView ? '' : UI.stat('<span class="num">' + ready + ' <span class="muted" style="font-size:14px">of ' + st.instances.length + '</span></span>', 'Instances ready', ready < st.instances.length ? '<span style="color:var(--danger-fg)">' + (st.instances.length - ready) + ' not ready</span>' : 'all current'))
        + UI.stat(c.queued, 'Queued jobs', 'oldest ' + esc(c.oldest)) + UI.stat(c.running, 'Running jobs', 'on ' + st.instances.filter((i) => i.kind === 'app' && i.claimed).length + ' instance' + (st.instances.filter((i) => i.kind === 'app' && i.claimed).length === 1 ? '' : 's'))
        + UI.stat(c.failed, 'Failed jobs', 'in ' + esc(windowLabel) + ' · <a href="#" data-go="jobs" data-tab="jobs">Jobs</a>')
        + '<button type="button" class="stat" data-go="flags" style="text-align:left;cursor:pointer;font:inherit">' + '<div class="n">14</div><div class="l">Open flags</div><div class="d"><span style="color:var(--warn-fg)">4 overdue</span></div></button>'
        + '<button type="button" class="stat" data-go="channels" style="text-align:left;cursor:pointer;font:inherit">' + '<div class="n">3</div><div class="l">Held replies</div><div class="d">waiting for a reviewer</div></button>'
        + UI.stat(c.signins, 'Sign-ins', esc(windowLabel) + (c.refused ? ', <span style="color:var(--warn-fg)">' + c.refused + ' refused by sanction</span>' : ''))
        + (st.tenantView ? UI.stat(3, 'Workspaces', 'Finance Ops, People Ops, Field Sales') : UI.stat(st.instances.filter((i) => i.kind === 'app').reduce((n, i) => n + (i.sockets || 0), 0), 'Sockets', 'on ' + st.instances.filter((i) => i.kind === 'app').length + ' instances'))
        + '</div>';

      // ---- instances ----
      const instTable = st.tenantView
        ? UI.notice('Instance health is visible to system admins. Your workspace counters, scheduled work and recent audit are shown; ask a system admin about instances and capacity.', 'info')
        : UI.table(['Instance', 'Role', 'Version', 'Schema', 'Database', 'KMS', 'Blobs', { label: 'Jobs claimed', right: true }, 'Started', 'State'], st.instances.map((i) => ({
          cells: ['<span class="mono" style="font-weight:600">' + esc(i.id) + '</span>', esc(i.role), '<span class="mono">' + esc(i.version) + '</span>',
            i.schema == null ? '<span class="muted">—</span>' : checkPill(i.schema), i.database == null ? '<span class="muted">no database</span>' : checkPill(i.database), checkPill(i.kms), checkPill(i.blobs),
            i.claimed == null ? '<span class="muted">—</span>' : '<span class="num">' + i.claimed + '</span>' + (i.claimedNote ? ' <span class="muted" style="font-size:11px">' + esc(i.claimedNote) + '</span>' : ''), esc(i.started), UI.pill(i.state, stateKind(i.state))],
          attrs: 'data-inst="' + esc(i.id) + '"', selected: i.id === st.sel
        })), { minWidth: '940px' })
        + (st.tenantView ? '' : '<span class="muted" style="font-size:12px">Instances register themselves on start and report /readyz and a heartbeat every ' + 30 + ' s. An instance behind the schema stops claiming jobs and answers 503 until it runs the current build. Drain stops new work; nothing is restarted from the console.</span>');

      // ---- panels ----
      const lastKind = (l) => l === 'ok' ? 'ok' : l === 'RPO missed' ? (st.alerts.some((a) => a.kind === 'rpo') ? 'danger' : 'ok') : l === 'drift found' ? (st.alerts.some((a) => a.kind === 'drift') ? 'warn' : 'ok') : 'warn';
      const schedPanel = UI.panel('Scheduled work', '<div class="vstack gap6">' + SCHEDULES.map((s) => '<div class="hstack" style="font-size:12px"><span class="mono grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis">' + esc(s.name) + '</span><span class="muted num" style="white-space:nowrap">' + esc(s.due) + '</span>' + UI.pill(lastKind(s.last) === 'ok' ? 'ok' : s.last, lastKind(s.last)) + '</div>').join('') + '</div><span class="muted" style="font-size:11px">The next six of ' + 27 + ' schedules; every active tenant is a target unless the schedule is platform-wide.</span>', { actions: UI.btn('All schedules', { size: 'xs', kind: 'ghost', attrs: 'data-go="jobs" data-tab="schedules"' }) });
      const auditRows = AUDIT.filter((a) => !st.tenantView || a.actor !== 'platform-ops');
      const auditPanel = UI.panel('Recent audit', '<div class="vstack gap6">' + auditRows.map((a) => '<div style="font-size:12px;min-width:0"><div class="hstack gap6"><span style="font-weight:600;white-space:nowrap">' + esc(a.actor) + '</span><span class="mono grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis">' + esc(a.action) + '</span><span class="muted num" style="white-space:nowrap">' + esc(a.at) + '</span></div><div class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(a.object) + '</div></div>').join('') + '</div>', { actions: UI.btn('Usage and audit', { size: 'xs', kind: 'ghost', attrs: 'data-go="usage-audit"' }) });
      const capPanel = st.tenantView ? '' : UI.panel('Capacity', '<div class="vstack gap12">' + UI.meter('Database (pg)', '48 GiB, 34 of 100 connections', 34, '') + UI.kv([['Vectors (pgvector)', '11,204,880'], ['Blob store (s3)', UI.pill('answering', 'ok')], ['Cache store', 'redis']], 1) + UI.meter('Rate-limit store (redis)', st.redisOk ? 'shared, answering' : 'degraded: counting per instance', 100, st.redisOk ? '' : 'danger') + '</div>', { actions: UI.btn('Platform', { size: 'xs', kind: 'ghost', attrs: 'data-go="platform"' }) });

      // ---- inspector ----
      let insp = '';
      if (sel && !st.tenantView) {
        const checks = sel.kind === 'app'
          ? [['database', checkPill(sel.database)], ['migrations', sel.schema === 'behind' ? UI.pill('1 unknown', 'danger') : UI.pill('ok', 'ok')], ['schema', sel.schema === 'behind' ? UI.pill('behind', 'danger') : UI.pill('ok', 'ok')], ['kms', checkPill(sel.kms)], ['blobs', checkPill(sel.blobs)], ['shutdown', UI.pill(sel.state === 'draining' ? 'draining' : 'ok', sel.state === 'draining' ? 'warn' : 'ok')]]
          : [['heartbeat', esc(sel.heartbeat)], ['contract', esc(sel.contract)], ['kms', checkPill(sel.kms)], ['blobs', checkPill(sel.blobs)], ['shutdown', UI.pill(sel.state === 'draining' ? 'draining' : 'ok', sel.state === 'draining' ? 'warn' : 'ok')]];
        insp = '<div class="hstack"><div class="eyebrow grow">Selected instance</div>' + UI.pill(sel.state, stateKind(sel.state)) + '</div>'
          + '<div style="font-size:15px;font-weight:600" class="mono">' + esc(sel.id) + '</div><div class="fg2" style="font-size:12px">' + esc(sel.role) + ', ' + esc(sel.version) + ' on ' + esc(sel.node) + ', pid ' + sel.pid + '</div>'
          + (sel.detail ? '<div class="fg2" style="font-size:12px">' + esc(sel.detail) + '</div>' : '')
          + (sel.schema === 'behind' ? UI.notice('<b>Behind the schema.</b> ' + esc(sel.schemaDetail) + '. /readyz answers 503 and this instance claims no jobs. Deploy the current build here; it recovers on its own once its migrations match the database.', 'danger') : '')
          + (sel.state === 'draining' ? UI.notice('Draining: no new jobs or streams; ' + (sel.claimed || 0) + ' job' + (sel.claimed === 1 ? '' : 's') + ' and open streams finish first.', 'warn') : '')
          + '<div class="eyebrow">/readyz checks</div>' + UI.kv(checks, 2)
          + (sel.kind === 'app' ? '<div class="eyebrow">Runtime</div>' + UI.kv([['Uptime', esc(sel.uptime) + ' <span class="muted">since ' + esc(sel.startedAt) + '</span>'], ['Jobs claimed', sel.claimed + (sel.claimedNote ? ' <span class="muted">(' + esc(sel.claimedNote) + ')</span>' : '')], ['Sockets', String(sel.sockets)], ['Rate-limit store', sel.ratelimit.indexOf('per instance') === 0 ? '<span style="color:var(--warn-fg)">' + esc(sel.ratelimit) + '</span>' : esc(sel.ratelimit)], ['Tracing', 'exported ' + sel.tracing.exported.toLocaleString() + ', dropped ' + sel.tracing.dropped + ', failed ' + sel.tracing.failed], ['NTP offset', (sel.ntp.offsetMs > 0 ? '+' : '') + sel.ntp.offsetMs + ' ms <span class="muted">median of ' + sel.ntp.agreed.join(', ') + (sel.ntp.outliers.length ? '; outlier ' + esc(sel.ntp.outliers.join(', ')) : '; no outliers') + '</span>']], 1)
            : '<div class="eyebrow">Runtime</div>' + UI.kv([['Uptime', esc(sel.uptime) + ' <span class="muted">since ' + esc(sel.startedAt) + '</span>'], ['Work', sel.claimed == null ? 'signing requests only' : sel.claimed + ' job' + (sel.claimed === 1 ? '' : 's') + (sel.claimedNote ? ' (' + esc(sel.claimedNote) + ')' : '')]], 1))
          + (sel.metrics ? '<div class="eyebrow">Metrics</div><div class="hstack"><span class="mono grow" style="font-size:11px;overflow-wrap:anywhere">' + esc(sel.metrics) + '</span>' + UI.iconbtn('copy', 'Copy the metrics URL', { cls: 'sm ghost', attrs: 'data-copymetrics' }) + '</div><span class="muted" style="font-size:11px">Token protected (METRICS_TOKEN): scrape it with the bearer header. Each instance answers for itself behind the load balancer.</span>' : '<span class="muted" style="font-size:12px">The signer exposes no HTTP endpoint and no metrics; its health is the socket heartbeat.</span>')
          + '<div class="hstack wrap gap6">' + UI.btn(sel.state === 'draining' ? 'Draining' : 'Drain', { size: 'sm', icon: 'pause', attrs: 'data-drain', disabled: sel.state === 'draining' || sel.kind === 'signer' }) + '</div>'
          + '<span class="muted" style="font-size:12px">Audit entries: platform.instance.drained, platform.alert.acknowledged. Nothing is restarted from the console.</span>';
      } else if (!st.tenantView) {
        insp = '<div class="eyebrow">Instances</div><div class="fg2" style="font-size:12px">Select an instance for its /readyz checks, tracing, clock and rate-limit store, and to drain it.</div>'
          + '<div class="eyebrow">Window</div><div class="fg2" style="font-size:12px">The counters cover ' + esc(windowLabel) + '. Alerts, instances and capacity are always current.</div>';
      }

      root.innerHTML = '<style>.overview-stat.stat{border:1px solid var(--line)}.main > .page > .stats,.main > .page > .vstack,.main > .page > .tablewrap{flex-shrink:0}</style><div class="page">'
        + UI.pagehead('Overview', st.tenantView ? 'Your tenant: counters, scheduled work and recent audit' : 'What needs attention now, and whether every instance is healthy', '<div class="hstack gap6">' + UI.seg([{ id: '1h', label: '1 h' }, { id: '24h', label: '24 h' }, { id: '7d', label: '7 d' }], st.window, 'data-window') + UI.btn('Acknowledge all', { attrs: 'data-ackall', disabled: !shown.length }) + '</div>')
        + '<div class="hstack"><div class="eyebrow grow">Alerts</div><span class="muted" style="font-size:12px">' + (shown.length ? shown.length + ' open, newest first' : 'none open') + '</span></div>' + alerts
        + '<div class="eyebrow">' + esc(windowLabel.charAt(0).toUpperCase() + windowLabel.slice(1)) + '</div>' + stats
        + (st.tenantView ? '' : '<div class="eyebrow">Instances</div>') + instTable
        + '<div class="' + (st.tenantView ? 'grid2' : 'grid3') + '">' + schedPanel + auditPanel + capPanel + '</div>'
        + '</div>' + (insp ? '<aside class="inspector w360">' + insp + '</aside>' : '');

      // ---- handlers ----
      ctx.on('click', '[data-seg]', (e, t) => { if (t.closest('[data-window]')) { st.window = t.dataset.seg; ctx.rerender(); } });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go, t.dataset.tab ? { tab: t.dataset.tab } : undefined); });
      ctx.on('click', 'tr.row[data-inst]', (e, t) => { st.sel = t.dataset.inst; ctx.rerender(); });
      ctx.on('click', '[data-openalert]', (e, t) => { const a = st.alerts.find((x) => x.id === t.dataset.openalert); if (!a) return; if (a.open.inst) { st.sel = a.open.inst; ctx.rerender(); } else ctx.navigate(a.open.route, a.open.params); });
      const ack = (ids) => ctx.confirm({ title: ids.length === 1 ? 'Acknowledge alert' : 'Acknowledge ' + ids.length + ' alerts', tag: 'tenant-wide', tone: 'info', body: '<p class="fg2" style="margin:0">The alert' + (ids.length === 1 ? ' leaves' : 's leave') + ' this page for every administrator of the tenant. The condition is not changed; a watch that still finds it raises it again. Audited as platform.alert.acknowledged.</p>', kv: [['Alerts', ids.map((id) => esc(st.alerts.find((a) => a.id === id).title)).join('; ')], ['By', 'Mara Okafor']], ok: 'Acknowledge' }).then((ok) => { if (!ok) return; st.alerts = st.alerts.filter((a) => !ids.includes(a.id)); st.acked += ids.length; ctx.rerender(); ctx.toast((ids.length === 1 ? 'Alert' : ids.length + ' alerts') + ' acknowledged. Audit event written.', 'ok'); });
      ctx.on('click', '[data-ack]', (e, t) => ack([t.dataset.ack]));
      ctx.on('click', '[data-ackall]', () => ack(shown.map((a) => a.id)));
      const drain = (inst) => ctx.confirm({ title: 'Drain ' + esc(inst.id), tag: 'no new work', tone: 'info', body: '<p class="fg2" style="margin:0">The instance stops claiming jobs and taking new streams, finishes what it has, and reports draining on /readyz so the load balancer sends it nothing new. Undo by restarting it. Audited as platform.instance.drained.</p>', kv: [['Instance', esc(inst.id) + ' on ' + esc(inst.node)], ['In flight', (inst.claimed || 0) + ' job' + (inst.claimed === 1 ? '' : 's') + (inst.sockets ? ', ' + inst.sockets + ' sockets' : '')]], ok: 'Drain' }).then((ok) => { if (!ok) return; inst.state = 'draining'; ctx.rerender(); ctx.toast(esc(inst.id) + ' is draining; ' + (inst.claimed || 0) + ' job' + (inst.claimed === 1 ? '' : 's') + ' finish first. Audit event written.', 'ok', 5000); });
      ctx.on('click', '[data-drain]', () => { if (sel) drain(sel); });
      ctx.on('click', '[data-copymetrics]', () => { if (sel && sel.metrics) ctx.toast('Metrics URL copied', 'ok', 1800); });
      if (st.openAckAll) { st.openAckAll = false; if (st.alerts.length) setTimeout(() => ack(st.alerts.map((a) => a.id)), 60); else ctx.toast('No open alerts', '', 1800); }
      if (st.openDrain) { st.openDrain = false; const i = st.instances.find((x) => x.id === st.sel); if (i) setTimeout(() => drain(i), 60); }
    }
  });
})();
