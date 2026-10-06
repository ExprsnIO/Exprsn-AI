(function () {
  const { UI, esc } = App;

  // Sidebar entry, added at load so app.js stays untouched (design/platform-admin/README.md): before Platform.
  (function nav() {
    const admin = (App.NAV || []).find((g) => g.group === 'Admin'); if (!admin || admin.items.some((it) => it.id === 'configuration')) return;
    const i = admin.items.findIndex((it) => it.id === 'platform'); const entry = { id: 'configuration', label: 'Configuration', icon: 'settings' };
    if (i < 0) admin.items.push(entry); else admin.items.splice(i, 0, entry);
  })();

  // ---- example data: every setting this build reads (names from server/src/config/index.ts), with where its value came from ----
  const INSTANCES = ['api-1', 'api-2', 'signer-1', 'trainer-gpu-1', 'images-1'];
  const SECTIONS = ['Server and HTTP', 'Database', 'Keys and KMS', 'Blob store and files', 'Jobs and cache', 'Identity and sessions', 'Federation', 'Gateway and Ollama', 'Guardrails and moderation', 'Knowledge and connections', 'Agents, workflows and scripts', 'Media and images', 'Training', 'Zones', 'Platform operations', 'PKI and ACME', 'Vault', 'Channels and email', 'Social and messaging', 'Apps and plugins', 'AT-Protocol', 'Observability', 'Billing'];
  // Fields: name, section, type, constraint, default, value (as read), source env|file|default|override, applies hot|restart, readers (instances that read it), description; secret, deprecated, file, differs {instance: value}
  const S = (name, section, type, constraint, def, value, source, applies, readers, description, extra) => Object.assign({ name, section, type, constraint, def, value, source, applies, readers, description, since: '03 Sep 2026', history: [] }, extra || {});
  const SETTINGS0 = () => [
    S('PUBLIC_URL', 'Server and HTTP', 'url', 'https, no trailing slash', 'http://localhost:8080', 'https://ai.northwind.local', 'env', 'restart', ['api-1', 'api-2'], 'The address users reach the console at. Cookies, OIDC redirects and share links are built from it.'),
    S('LOG_LEVEL', 'Server and HTTP', 'enum', 'fatal, error, warn, info, debug, trace, silent', 'info', 'info', 'default', 'hot', INSTANCES, 'How much each process writes to its log. Tenant content is never logged at any level.'),
    S('TRUST_PROXY', 'Server and HTTP', 'boolean', '', 'false', 'true', 'env', 'restart', ['api-1', 'api-2'], 'Take the client address from X-Forwarded-For. Only behind the edge proxy; the sign-in limiter and audit use the address.'),
    S('SESSION_SECRET', 'Server and HTTP', 'secret', 'at least 32 characters', '', '', 'file', 'restart', ['api-1', 'api-2'], 'Signs session cookies. Changing it signs everyone out.', { secret: true, file: '/run/secrets/session_secret', chars: 64 }),
    S('DB_CLIENT', 'Database', 'enum', 'pg, mysql, sqlite', 'sqlite', 'pg', 'env', 'restart', ['api-1', 'api-2'], 'The database dialect. The core schema uses nothing dialect-specific; migrations run on all three in CI.'),
    S('DATABASE_URL', 'Database', 'secret', 'a connection string', '', '', 'file', 'restart', ['api-1', 'api-2'], 'Where the application database is. The password inside it is why the whole value is a secret.', { secret: true, file: '/run/secrets/database_url', chars: 71 }),
    S('DB_POOL_MAX', 'Database', 'integer', '1 to 200', '10', '25', 'env', 'restart', ['api-1', 'api-2'], 'Connections each instance may hold open. Two instances at 25 fit under PostgreSQL\'s 100.'),
    S('DATA_KEY', 'Keys and KMS', 'secret', '32 bytes, base64', '', '', 'file', 'restart', ['api-1', 'api-2', 'signer-1'], 'The local key-encryption key when KMS_PROVIDER is local. Held by the signer; the application process never sees it after start.', { secret: true, file: '/run/secrets/data_key', chars: 44 }),
    S('DATA_KEY_PREVIOUS', 'Keys and KMS', 'secret', '32 bytes, base64', '', '', 'file', 'restart', ['api-1', 'api-2'], 'The key before the last rotation; reads fall back to it until kms:rewrap has moved everything. Unset it once the rewrap finished.', { secret: true, file: '/run/secrets/data_key_previous', chars: 44, deprecated: 'The rewrap finished on 02 Sep 2026; nothing is sealed with this key any more.' }),
    S('KMS_PROVIDER', 'Keys and KMS', 'enum', 'local, openbao', 'local', 'openbao', 'env', 'restart', ['api-1', 'api-2', 'signer-1'], 'Where data keys are wrapped: the local key, or OpenBao transit.'),
    S('BLOB_STORE', 'Blob store and files', 'enum', 'fs, s3', 'fs', 's3', 'env', 'restart', ['api-1', 'api-2', 'images-1'], 'Where files, media and backups live. More than one instance needs s3 or a shared path for fs.'),
    S('S3_BUCKET', 'Blob store and files', 'string', 'bucket name', '', 'exprsn-blobs', 'env', 'restart', ['api-1', 'api-2', 'images-1'], 'The bucket for BLOB_STORE=s3.'),
    S('S3_ENDPOINT', 'Blob store and files', 'url', 'https', '', 'https://minio.northwind.local', 'env', 'restart', ['api-1', 'api-2', 'images-1'], 'The S3-compatible endpoint (MinIO here). Signed with SigV4; path style when S3_FORCE_PATH_STYLE is on.'),
    S('CLAMD_HOST', 'Blob store and files', 'host', 'host or host:port', '', 'clamd.data.svc', 'env', 'hot', ['api-1', 'api-2'], 'The ClamAV daemon that scans every upload in quarantine. Unset, uploads stay queued and nothing is released unscanned.'),
    S('FILES_TRASH_DAYS', 'Blob store and files', 'integer', '0 to 3650 days', '30', '30', 'default', 'hot', ['api-1', 'api-2'], 'How long a deleted file stays in the trash before files.purge removes it.'),
    S('FILES_PURGE_MINUTES', 'Blob store and files', 'duration', '0 to 10080 minutes', '60', '60', 'default', 'hot', ['api-1', 'api-2'], 'How often the trash purge runs for every active tenant. 0 turns it off.'),
    S('CHAIN_MAX_DEPTH', 'Agents, workflows and scripts', 'integer', '2 to 32', '8', '8', 'default', 'restart', ['api-1', 'api-2'], 'How deep one chain of invocations (chat turn, agent run, workflow run, tool call) may go across kinds.'),
    S('MEDIA_WORK_DIR', 'Media and images', 'string', 'a writable path', '', '/var/lib/exprsn/media', 'env', 'restart', ['api-1', 'api-2'], 'Scratch space for ffmpeg and whisper. Cleared when a job finishes.'),
    S('JOB_QUEUE', 'Jobs and cache', 'enum', 'auto, db, bullmq', 'auto', 'bullmq', 'env', 'restart', ['api-1', 'api-2'], 'The queue backend: BullMQ on Redis, or polling the database. auto picks BullMQ when REDIS_URL is set.'),
    S('JOB_CONCURRENCY', 'Jobs and cache', 'integer', '1 to 64', '4', '8', 'env', 'restart', ['api-1', 'api-2'], 'Jobs each instance runs at once. Media and training jobs count once each however long they run.'),
    S('REDIS_URL', 'Jobs and cache', 'secret', 'redis:// or rediss://', '', '', 'file', 'restart', ['api-1', 'api-2'], 'Redis for the queue, the shared rate limiter and the cache. Without it everything counts per instance.', { secret: true, file: '/run/secrets/redis_url', chars: 52 }),
    S('CACHE_STORE', 'Jobs and cache', 'enum', 'auto, memory, redis', 'auto', 'auto', 'default', 'restart', ['api-1', 'api-2'], 'The tenant cache store. auto uses Redis when REDIS_URL is set, otherwise memory per instance with invalidations over the bus.'),
    S('CACHE_TTL_MEDIUM_SECONDS', 'Jobs and cache', 'duration', '1 to 86400 seconds', '60', '300', 'env', 'hot', ['api-1', 'api-2'], 'Lifetime of the medium tier (profiles, directory groups, the model catalogue).'),
    S('DIRECTORY_SYNC_MINUTES', 'Identity and sessions', 'duration', '0 to 1440 minutes', '60', '30', 'env', 'hot', ['api-1', 'api-2'], 'How often directory.sync pulls groups from every tenant\'s user stores. 0 turns it off.'),
    S('AUDIT_CHECKPOINT_MINUTES', 'Identity and sessions', 'duration', '0 to 1440 minutes', '60', '60', 'default', 'hot', ['api-1', 'api-2'], 'How often each tenant\'s audit chain is checkpointed and signed.'),
    S('SESSION_IDLE_MINUTES', 'Identity and sessions', 'duration', '5 to 1440 minutes', '30', '30', 'default', 'hot', ['api-1', 'api-2'], 'A session with no request for this long ends. Admin roles keep the shorter of this and their policy.'),
    S('BREACHED_PASSWORDS', 'Identity and sessions', 'enum', 'off, hibp, file, both', 'off', 'file', 'env', 'hot', ['api-1', 'api-2'], 'Check new passwords against breached lists. Platform warns while it is off.'),
    S('USER_IMPORT_MAX_ROWS', 'Identity and sessions', 'integer', '1 to 100000 rows', '5000', '5000', 'default', 'hot', ['api-1', 'api-2'], 'The most rows one CSV import of users, memberships and group mappings may carry.'),
    S('DPOP_PROOF_MAX_AGE_SECONDS', 'Federation', 'duration', '10 to 600 seconds', '60', '60', 'default', 'hot', ['api-1', 'api-2'], 'How old a DPoP proof may be. Clients with slow clocks fail above the NTP skew.'),
    S('OLLAMA_MAX_INFLIGHT', 'Gateway and Ollama', 'integer', '1 to 256', '4', '6', 'env', 'hot', ['api-1', 'api-2'], 'Requests the gateway sends to one Ollama instance at once; the rest wait in the queue up to OLLAMA_QUEUE_TIMEOUT_MS.'),
    S('CHAT_RETENTION_SWEEP_MINUTES', 'Guardrails and moderation', 'duration', '0 to 10080 minutes', '60', '60', 'default', 'hot', ['api-1', 'api-2'], 'How often chat.retention applies each workspace\'s retention to conversations.'),
    S('ZONES_APPLY', 'Zones', 'enum', 'off, kubernetes', 'off', 'kubernetes', 'env', 'restart', ['api-1', 'api-2'], 'Apply each zone\'s NetworkPolicy in the cluster with server-side apply; drift is reported on Zones and as an alert.'),
    S('PLATFORM_BACKUP_MINUTES', 'Platform operations', 'duration', '0 to 10080 minutes', '1440', '60', 'env', 'hot', ['api-1', 'api-2'], 'How often ops.backup.create runs. The RPO alert (PLATFORM_BACKUP_RPO_MINUTES) assumes it is kept.', { differs: { 'api-2': '120' } }),
    S('PLATFORM_BACKUP_RETAIN', 'Platform operations', 'integer', '1 to 1000 backups', '14', '14', 'default', 'hot', ['api-1', 'api-2'], 'Backups kept before the oldest is removed.'),
    S('PLATFORM_BUNDLE_REQUIRE_CHECKS', 'Platform operations', 'boolean', '', 'false', 'true', 'env', 'hot', ['api-1', 'api-2'], 'Refuse to promote an import bundle whose scan or staging step did not pass.'),
    S('NTP_SERVER', 'Platform operations', 'list', 'hosts, comma separated', '', 'ntp1.northwind.local, ntp2.northwind.local, ntp3.northwind.local', 'env', 'hot', INSTANCES, 'SNTP servers for the clock check; with several, the median of those that agree is the skew and outliers are named.'),
    S('PKI_CRL_MINUTES', 'PKI and ACME', 'duration', '0 to 10080 minutes', '60', '60', 'default', 'hot', ['api-1', 'api-2'], 'How often pki.crl publishes a numbered CRL for every live issuer.'),
    S('VAULT_LEASE_MAX_TTL_SECONDS', 'Vault', 'duration', '1 to 31622400 seconds', '86400', '43200', 'env', 'hot', ['api-1', 'api-2'], 'The longest a database lease may live, however the request asks.'),
    S('SMTP_URL', 'Channels and email', 'secret', 'smtp:// or smtps://', '', '', 'file', 'hot', ['api-1', 'api-2'], 'The outbox for notices, codes, invitations and channel replies.', { secret: true, file: '/run/secrets/smtp_url', chars: 58 }),
    S('MESSAGING_EMBED_MODEL', 'Social and messaging', 'string', 'an approved embedding model', '', 'nomic-embed-text', 'env', 'hot', ['api-1', 'api-2'], 'Turns on semantic search over messages. Unset, search is keyword only.'),
    S('FEED_TRENDING_MINUTES', 'Social and messaging', 'duration', '0 to 10080 minutes', '60', '15', 'env', 'hot', ['api-1', 'api-2'], 'How often the feed job recomputes trending hashtags over FEED_TRENDING_HOURS.'),
    S('FEED_DIGEST_PROFILE', 'Social and messaging', 'string', 'a published profile', '', 'analyst', 'env', 'hot', ['api-1', 'api-2'], 'The profile that writes the weekly digest. If the model fails, the ranked list is sent as it is.'),
    S('APPS_TRIGGER_MAX_DEPTH', 'Apps and plugins', 'integer', '1 to 10', '3', '3', 'default', 'hot', ['api-1', 'api-2'], 'How many record triggers may chain before the chain stops.'),
    S('PLUGIN_MAX_DEPTH', 'Apps and plugins', 'integer', '1 to 10', '3', '3', 'default', 'hot', ['api-1', 'api-2'], 'How deep an event caused by a plugin may cause further plugin runs.'),
    S('PLUGINS_REQUIRE_SIGNED', 'Apps and plugins', 'enum', 'scripts, all, none', 'scripts', 'scripts', 'default', 'hot', ['api-1', 'api-2'], 'Which plugins must come from a signed import bundle before they can be enabled.'),
    S('WEBHOOK_BREAKER_COOLDOWN_MS', 'Apps and plugins', 'duration', '10 to 86400000 ms', '300000', '300000', 'default', 'hot', ['api-1', 'api-2'], 'How long an outbound webhook\'s breaker stays open after WEBHOOK_BREAKER_THRESHOLD failures.'),
    S('ATPROTO_PUBLIC_URL', 'AT-Protocol', 'url', 'https, public', '', 'https://ai.northwind.local', 'env', 'restart', ['api-1', 'api-2'], 'The https origin the labeler, DID documents and the PDS are served from.'),
    S('OTEL_EXPORTER_OTLP_ENDPOINT', 'Observability', 'url', 'http or https', '', 'http://otel-collector.observability.svc:4318', 'env', 'restart', INSTANCES, 'Where spans go over OTLP/HTTP. Unset, tracing is off and Open trace is disabled on Jobs.'),
    S('OTEL_TRACES_SAMPLE_RATIO', 'Observability', 'number', '0 to 1', '1', '0.25', 'env', 'hot', INSTANCES, 'The share of traces kept. A caller\'s traceparent is always honoured.'),
    S('SCHEMA_CHECK_SECONDS', 'Observability', 'duration', '0 to 3600 seconds', '30', '30', 'default', 'hot', ['api-1', 'api-2'], 'How often an instance checks the database schema against its build and stops claiming jobs when behind.'),
    S('RATELIMIT_PROBE_SECONDS', 'Observability', 'duration', '1 to 600 seconds', '15', '15', 'default', 'hot', ['api-1', 'api-2'], 'How often the Redis rate-limit store is probed; a failure raises exprsn_ratelimit_degraded within a minute.'),
    S('METRICS_TOKEN', 'Observability', 'secret', 'at least 16 characters', '', '', 'file', 'hot', INSTANCES, 'The bearer token Prometheus presents at /metrics.', { secret: true, file: '/run/secrets/metrics_token', chars: 40 }),
    S('BILLING_CLOSE_MINUTES', 'Billing', 'duration', '0 to 10080 minutes', '0', '0', 'default', 'hot', ['api-1', 'api-2'], 'How often billing.close rolls usage into invoices. 0 leaves billing off.')
  ];
  const valueText = (s) => s.secret ? 'set, ' + s.chars + ' characters, from file ' + s.file : (s.value === '' ? 'unset' : s.value);
  const changed = (s) => s.secret ? s.source !== 'default' : s.value !== s.def;
  const differs = (s) => !!(s.differs && Object.keys(s.differs).length);
  const srcKind = (s) => s === 'override' ? 'accent' : s === 'file' ? 'info' : s === 'env' ? 'outline' : '';

  const init = (st) => {
    if (st.settings) return;
    st.settings = SETTINGS0(); st.sel = 'PUBLIC_URL'; st.section = 'all'; st.query = ''; st.chips = {}; st.overrides = 'on'; st.pending = []; st.restartNeeded = []; st.compare = false; st.focusSearch = false;
  };

  App.register({
    id: 'configuration', title: 'Configuration', section: 'admin', crumb: ['Admin', 'Configuration'],
    summary: 'Every setting this build reads, where its value comes from, whether the instances agree, and what a change needs',
    commands: [
      { label: 'Find a setting', sub: 'Configuration', run(app) { const s = app.stateFor('configuration'); init(s); s.focusSearch = true; app.render(); } },
      { label: 'Export settings as .env', sub: 'Configuration', run(app) { const s = app.stateFor('configuration'); init(s); s.openExport = true; app.render(); } }
    ],
    states: [
      { title: 'Instances disagree', tone: 'danger', text: 'PLATFORM_BACKUP_MINUTES is 60 on api-1 and 120 on api-2. The filter chip, the row and the inspector show it.', apply(ctx) { init(ctx.state); const st = ctx.state; st.section = 'all'; st.query = ''; st.chips = { differs: true }; st.sel = 'PLATFORM_BACKUP_MINUTES'; st.compare = true; ctx.rerender(); } },
      { title: 'Restart required', tone: 'warn', text: 'An approved override of JOB_CONCURRENCY applies at the next start; a banner names api-1 and api-2.', apply(ctx) { init(ctx.state); const st = ctx.state; const s = st.settings.find((x) => x.name === 'JOB_CONCURRENCY'); s.value = '12'; s.source = 'override'; s.since = 'just now'; s.history = [{ at: '19 Sep 2026 14:08', actor: 'Mara Okafor', approver: 'Jonas Lindqvist', from: '8', to: '12', reason: 'media backlog' }]; if (!st.restartNeeded.includes('JOB_CONCURRENCY')) st.restartNeeded.push('JOB_CONCURRENCY'); st.section = 'all'; st.chips = {}; st.sel = 'JOB_CONCURRENCY'; ctx.rerender(); } },
      { title: 'Overrides disabled', tone: 'neutral', text: 'Settings are managed in the environment of this deployment: Propose override is replaced by a notice with the name to copy.', apply(ctx) { init(ctx.state); const st = ctx.state; st.overrides = 'off'; st.sel = 'DIRECTORY_SYNC_MINUTES'; st.section = 'all'; st.chips = {}; ctx.rerender(); } },
      { title: 'Secret from file', tone: 'info', text: 'DATA_KEY is selected: the value is never shown, only its length, the file and its mode.', apply(ctx) { init(ctx.state); const st = ctx.state; st.section = 'Keys and KMS'; st.chips = {}; st.query = ''; st.sel = 'DATA_KEY'; ctx.rerender(); } },
      { title: 'Deprecated setting still set', tone: 'warn', text: 'DATA_KEY_PREVIOUS is still set although the rewrap finished on 2 Sep; the row and the inspector say so.', apply(ctx) { init(ctx.state); const st = ctx.state; st.section = 'all'; st.query = ''; st.chips = { deprecated: true }; st.sel = 'DATA_KEY_PREVIOUS'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; init(st);
      if (ctx.params.q) { st.query = ctx.params.q; const m = st.settings.find((s) => s.name.toLowerCase() === ctx.params.q.toLowerCase()); if (m) { st.sel = m.name; st.section = 'all'; } delete ctx.params.q; }
      if (ctx.params.section) { st.section = ctx.params.section; delete ctx.params.section; }
      const q = st.query.trim().toLowerCase();
      const counts = {}; st.settings.forEach((s) => { counts[s.section] = (counts[s.section] || 0) + 1; });
      const rows = st.settings.filter((s) => (st.section === 'all' || s.section === st.section) && (!q || (s.name + ' ' + s.description + ' ' + s.section).toLowerCase().includes(q))
        && (!st.chips.changed || changed(s)) && (!st.chips.secrets || s.secret) && (!st.chips.restart || s.applies === 'restart') && (!st.chips.differs || differs(s)) && (!st.chips.deprecated || s.deprecated));
      if (!rows.some((s) => s.name === st.sel)) st.sel = rows.length ? rows[0].name : null;
      const sel = st.settings.find((s) => s.name === st.sel);
      const nChanged = st.settings.filter(changed).length, nDiffer = st.settings.filter(differs).length, nDep = st.settings.filter((s) => s.deprecated).length;
      const chip = (id, label, n) => '<button type="button" class="chip' + (st.chips[id] ? ' on' : '') + '" data-chip="' + id + '" aria-pressed="' + (st.chips[id] ? 'true' : 'false') + '">' + esc(label) + (n != null ? ' <span class="muted">' + n + '</span>' : '') + '</button>';

      const left = '<div class="leftpane"><div class="eyebrow" style="padding:4px 8px 0">Sections</div><div class="vstack" style="gap:1px">'
        + UI.listItem('All settings', st.settings.length + ' read by this build', { active: st.section === 'all', attrs: 'data-section="all"' })
        + SECTIONS.filter((s) => counts[s]).map((s) => UI.listItem(esc(s), counts[s] + (counts[s] === 1 ? ' setting' : ' settings'), { active: st.section === s, attrs: 'data-section="' + esc(s) + '"' })).join('') + '</div>'
        + '<span class="muted" style="font-size:11px;padding:0 8px">Sections group the settings the way docs/deploy.md does. A setting a worker also reads is shown on it.</span></div>';

      const banner = st.restartNeeded.length ? UI.notice('<b>Restart required.</b> ' + st.restartNeeded.map((n) => '<span class="mono">' + esc(n) + '</span>').join(', ') + ' changed; <span class="mono">api-1</span> and <span class="mono">api-2</span> read the new value at their next start. A rolling restart keeps the console up; this banner clears itself as each instance reports the new value.', 'warn', UI.btn('Check again', { size: 'sm', attrs: 'data-restarted' })) : '';
      const pendingNote = st.pending.length ? UI.notice(st.pending.length + ' override' + (st.pending.length > 1 ? 's wait' : ' waits') + ' for a second platform admin: ' + st.pending.map((p) => '<span class="mono">' + esc(p.name) + '</span>').join(', ') + '.', 'info') : '';

      const table = UI.table(['Setting', 'Value', 'Source', 'Applies', 'Description'], rows.map((s) => ({
        cells: ['<span class="mono" style="font-weight:600">' + esc(s.name) + '</span>' + (s.deprecated ? ' ' + UI.pill('deprecated', 'warn') : '') + (differs(s) ? ' ' + UI.pill('instances differ', 'danger') : '') + (st.pending.some((p) => p.name === s.name) ? ' ' + UI.pill('override pending', 'info') : ''),
          s.secret ? '<span class="muted">' + esc(valueText(s)) + '</span>' : '<span class="mono">' + esc(valueText(s)) + '</span>' + (changed(s) ? '' : ' <span class="muted" style="font-size:11px">default</span>'),
          UI.pill(s.source, srcKind(s.source)), s.applies === 'hot' ? UI.pill('hot', 'ok') : UI.pill('restart', 'outline'), '<span class="fg2" style="font-size:12px">' + esc(s.description) + '</span>'],
        attrs: 'data-setting="' + esc(s.name) + '"', selected: s.name === st.sel
      })), { minWidth: '820px', emptyTitle: 'No setting matches', emptyText: 'Clear the search or the filter chips, or pick another section.' });

      const page = '<div class="page">' + UI.pagehead('Configuration', st.settings.length + ' settings read by build 1.5.0-rc.1 on ' + INSTANCES.length + ' instances. Secrets show their length and file, never their value.', UI.btn('Diff against defaults', { attrs: 'data-diff', icon: 'sort' }) + UI.btn('Export as .env', { attrs: 'data-export', icon: 'download' }))
        + banner + pendingNote
        + '<div class="toolbar">' + UI.search('Find by name or description', 'data-search', st.query) + chip('changed', 'Changed from default', nChanged) + chip('secrets', 'Secrets', st.settings.filter((s) => s.secret).length) + chip('restart', 'Restart required', st.settings.filter((s) => s.applies === 'restart').length) + chip('differs', 'Instances differ', nDiffer) + chip('deprecated', 'Deprecated', nDep) + '<span class="muted right" style="font-size:12px">' + rows.length + ' shown</span></div>'
        + table
        + '<span class="muted" style="font-size:12px">Source: <b>env</b> the process environment, <b>file</b> a secret file under SECRET_REF_DIRS, <b>default</b> the value in the build, <b>override</b> a change approved here. Applies: <b>hot</b> is read on the next use; <b>restart</b> waits for the instance to start again.</span></div>';

      let insp = '';
      if (sel) {
        const perInstance = INSTANCES.filter((i) => sel.readers.includes(i)).map((i) => { const v = sel.differs && sel.differs[i] != null ? sel.differs[i] : (sel.secret ? 'set' : (sel.value === '' ? 'unset' : sel.value)); const off = sel.differs && sel.differs[i] != null; return ['<span class="mono">' + esc(i) + '</span>', (st.compare && off ? '<span class="mono" style="background:var(--warn-bg);color:var(--warn-fg);padding:0 4px;border-radius:3px">' + esc(v) + '</span>' : '<span class="mono">' + esc(v) + '</span>') + (off ? ' ' + UI.pill('differs', 'danger') : '')]; });
        const pend = st.pending.find((p) => p.name === sel.name);
        insp = '<div class="hstack"><div class="eyebrow grow">Selected setting</div>' + UI.pill(sel.source, srcKind(sel.source)) + (sel.applies === 'hot' ? UI.pill('hot', 'ok') : UI.pill('restart', 'outline')) + '</div>'
          + '<div class="mono" style="font-size:14px;font-weight:600;overflow-wrap:anywhere">' + esc(sel.name) + '</div><div class="fg2" style="font-size:12px">' + esc(sel.description) + '</div>'
          + (sel.deprecated ? UI.notice('<b>Deprecated.</b> ' + esc(sel.deprecated) + ' Unset it at the next restart.', 'warn') : '')
          + (sel.secret ? UI.notice('A secret: the console shows its length, file and mode, never the value. Rotate it at the source and restart.', 'info') : '')
          + UI.kv([['Section', esc(sel.section)], ['Type', esc(sel.type) + (sel.constraint ? ', ' + esc(sel.constraint) : '')], ['Default', sel.def === '' ? '<span class="muted">unset</span>' : '<span class="mono">' + esc(sel.def) + '</span>'], ['Current value', sel.secret ? esc(valueText(sel)) : '<span class="mono">' + esc(valueText(sel)) + '</span>'], ['Source', esc(sel.source) + (sel.file ? ', <span class="mono" style="font-size:11px">' + esc(sel.file) + '</span> mode 0400' : '')], ['Since', esc(sel.since)]], 1)
          + '<div class="hstack"><div class="eyebrow grow">Per instance</div>' + UI.btn(st.compare ? 'Stop comparing' : 'Compare instances', { size: 'xs', kind: 'ghost', attrs: 'data-compare' }) + '</div>'
          + UI.table(['Instance', 'Value'], perInstance, { clickable: false, minWidth: '0', cls: 'bare' })
          + (differs(sel) ? UI.notice('The instances read different values. Fix the environment of ' + Object.keys(sel.differs).map((i) => '<span class="mono">' + esc(i) + '</span>').join(', ') + ' and restart it, or approve an override so every instance reads the same.', 'danger') : '')
          + '<div class="eyebrow">History</div>' + (sel.history.length ? UI.timeline(sel.history.map((h) => ({ title: '<span class="mono">' + esc(h.from) + '</span> → <span class="mono">' + esc(h.to) + '</span>', text: 'proposed by ' + esc(h.actor) + ', approved by ' + esc(h.approver) + (h.reason ? ', ' + esc(h.reason) : ''), meta: esc(h.at), tone: 'ok' }))) : '<span class="muted" style="font-size:12px">No override recorded. Changes made in the environment leave no entry here; the deploy log has them.</span>')
          + (pend ? UI.notice('<b>Override pending:</b> <span class="mono">' + esc(pend.value) + '</span> waits for a second platform admin. ' + esc(pend.reason), 'info', UI.btn('Approve as Jonas', { size: 'xs', attrs: 'data-approve="' + esc(pend.name) + '"' }) + UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-withdraw="' + esc(pend.name) + '"' })) : '')
          + '<div class="hstack wrap gap6">' + UI.btn('Copy name', { size: 'sm', icon: 'copy', attrs: 'data-copy' }) + (st.overrides === 'on' && !sel.secret ? UI.btn('Propose override', { kind: 'primary', size: 'sm', icon: 'edit', attrs: 'data-propose', disabled: !!pend }) + (sel.source === 'override' ? UI.btn('Propose removal', { size: 'sm', attrs: 'data-unset', disabled: !!pend }) : '') : '') + '</div>'
          + (st.overrides === 'on' && sel.secret ? UI.notice('Not overridable here: a secret is rotated where it is stored, then the instances restart.', 'info') : '')
          + (st.overrides === 'off' ? UI.notice('Settings are managed in the environment of this deployment. Copy the name, change it where the instances are deployed, and restart if the setting needs it.', 'info') : '<span class="muted" style="font-size:12px">An override needs a second platform admin. A hot setting applies at once; a restart setting waits for the next start and the banner names the instances.</span>');
      }

      root.innerHTML = left + page + (insp ? '<aside class="inspector w360">' + insp + '</aside>' : '');
      if (st.focusSearch) { st.focusSearch = false; const inp = ctx.$('[data-search]'); if (inp && inp.focus) inp.focus(); }
      if (st.openExport) { st.openExport = false; setTimeout(() => exportEnv(), 30); }

      const envLines = (only) => st.settings.filter((s) => !only || changed(s)).map((s) => s.secret ? '# ' + s.name + ' is read from ' + s.file + '\n' + s.name + '=********' : s.name + '=' + (s.value === '' ? '' : s.value)).join('\n');
      const exportEnv = () => ctx.modal({ cls: 'wide', title: 'Export as .env ' + UI.pill('secrets masked', 'info'), body: '<p class="fg2" style="margin:0">Every setting with the value this build reads, in the order of the sections. Secrets are masked; the comment names their file.</p>' + UI.code(envLines(false), 'ini'), actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Copy', { kind: 'primary', attrs: 'data-copyenv' }), onMount(m) { m.querySelector('[data-copyenv]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Copied ' + st.settings.length + ' lines. Audit event written: platform.settings.exported.', 'ok'); }); } });

      ctx.on('click', '[data-section]', (e, t) => { st.section = t.dataset.section; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; ctx.rerender(); const inp = ctx.$('[data-search]'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } });
      ctx.on('click', '[data-chip]', (e, t) => { e.preventDefault(); st.chips[t.dataset.chip] = !st.chips[t.dataset.chip]; ctx.rerender(); });
      ctx.on('click', 'tr.row[data-setting]', (e, t) => { st.sel = t.dataset.setting; ctx.rerender(); });
      ctx.on('click', '[data-compare]', () => { st.compare = !st.compare; ctx.rerender(); });
      ctx.on('click', '[data-copy]', () => ctx.toast('<span class="mono">' + esc(sel.name) + '</span> copied', 'ok'));
      ctx.on('click', '[data-export]', () => exportEnv());
      ctx.on('click', '[data-diff]', () => ctx.modal({ cls: 'wide', title: 'Diff against defaults ' + UI.pill(nChanged + ' changed', 'outline'), body: '<p class="fg2" style="margin:0">Only the settings whose value is not the build\'s default. Lines marked - are the default, + the value read.</p>' + UI.code(st.settings.filter(changed).map((s) => '- ' + s.name + '=' + (s.secret ? '' : s.def) + '\n+ ' + s.name + '=' + (s.secret ? '******** (' + s.file + ')' : s.value) + (differs(s) ? '\n+ ' + s.name + '=' + Object.values(s.differs)[0] + '   # ' + Object.keys(s.differs).join(', ') : '')).join('\n'), 'diff'), actions: UI.btn('Close', { attrs: 'data-close' }) }));
      ctx.on('click', '[data-restarted]', () => ctx.toast('Asked every instance again: ' + st.restartNeeded.map(esc).join(', ') + ' is still read as before on api-1 and api-2 until they start again.', 'warn', 5000));
      ctx.on('click', '[data-propose]', () => {
        ctx.drawer({ title: 'Propose override of <span class="mono">' + esc(sel.name) + '</span>',
          body: '<div class="vstack gap12">' + UI.notice('A second platform admin must approve. ' + (sel.applies === 'hot' ? 'The setting is hot: it applies as soon as approved.' : 'The setting needs a restart: approved, it waits for the next start of each instance.'), 'info')
            + UI.kv([['Type', esc(sel.type) + (sel.constraint ? ', ' + esc(sel.constraint) : '')], ['Current', '<span class="mono">' + esc(valueText(sel)) + '</span>'], ['Default', sel.def === '' ? 'unset' : '<span class="mono">' + esc(sel.def) + '</span>']], 1)
            + UI.field('New value', sel.type === 'enum' ? UI.select(sel.constraint.split(', ').map((v) => ({ value: v, label: v })), sel.value, 'data-ov-value') : sel.type === 'boolean' ? UI.select([{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }], sel.value, 'data-ov-value') : UI.input(sel.value, { attrs: 'data-ov-value', placeholder: sel.constraint }), sel.constraint ? 'Must fit: ' + esc(sel.constraint) : '')
            + UI.field('Reason', UI.textarea('', { rows: 3, attrs: 'data-ov-reason', placeholder: 'Why, and what it should change. Written to the audit chain with the proposal.' }), 'Required.') + '<div data-ov-problem></div></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Submit for approval', { kind: 'primary', attrs: 'data-ov-submit' }),
          onMount(d) {
            d.querySelector('[data-ov-submit]').addEventListener('click', () => {
              const v = d.querySelector('[data-ov-value]').value.trim(), r = d.querySelector('[data-ov-reason]').value.trim(), p = d.querySelector('[data-ov-problem]');
              if (!r) { p.innerHTML = UI.notice('A reason is required.', 'danger'); return; }
              if (sel.type === 'integer' && !/^\d+$/.test(v)) { p.innerHTML = UI.problem('Value refused (422)', sel.name + ' must be an integer, ' + sel.constraint + '.', '7b1e2d3c4a5f6e7d8c9b0a1f2e3d4c5b'); return; }
              if (v === sel.value) { p.innerHTML = UI.notice('That is the current value.', 'warn'); return; }
              st.pending.push({ name: sel.name, value: v, reason: r, actor: 'Mara Okafor', at: 'just now' }); App.closeOverlay(); ctx.rerender(); ctx.toast('Override of <span class="mono">' + esc(sel.name) + '</span> proposed; waiting for a second platform admin. Audit event written.', '', 5000);
            });
          } });
      });
      ctx.on('click', '[data-approve]', (e, t) => { const p = st.pending.find((x) => x.name === t.dataset.approve); const s = st.settings.find((x) => x.name === p.name);
        ctx.confirm({ title: 'Approve override of ' + p.name, tag: 'dual control', tone: 'info', body: '<p class="fg2" style="margin:0">Approving as Jonas Lindqvist, a second platform admin. ' + (s.applies === 'hot' ? 'The value applies on the next use.' : 'The value is stored now and read at the next start of each instance.') + '</p>', kv: [['From', s.secret ? 'set' : (s.value || 'unset')], ['To', p.value], ['Reason', p.reason]], ok: 'Approve' }).then((ok) => { if (!ok) return;
          s.history.push({ at: '19 Sep 2026 14:10', actor: p.actor, approver: 'Jonas Lindqvist', from: s.value || 'unset', to: p.value, reason: p.reason }); if (p.unset) { s.value = s.def; s.source = 'env'; } else { s.value = p.value; s.source = 'override'; } s.since = 'just now'; if (s.differs) delete s.differs; st.pending = st.pending.filter((x) => x !== p);
          if (s.applies === 'restart' && !st.restartNeeded.includes(s.name)) st.restartNeeded.push(s.name);
          ctx.rerender(); ctx.toast(esc(s.name) + (s.applies === 'hot' ? ' applied on every instance.' : ' stored; restart api-1 and api-2 to apply.'), s.applies === 'hot' ? 'ok' : 'warn', 5000); }); });
      ctx.on('click', '[data-unset]', () => { st.pending.push({ name: sel.name, value: 'the environment value', unset: true, reason: 'back to what the deployment sets', actor: 'Mara Okafor', at: 'just now' }); ctx.rerender(); ctx.toast('Removal of the override of <span class="mono">' + esc(sel.name) + '</span> proposed; waiting for a second platform admin. Audit event written.', '', 5000); });
      ctx.on('click', '[data-withdraw]', (e, t) => { st.pending = st.pending.filter((x) => x.name !== t.dataset.withdraw); ctx.rerender(); ctx.toast('Proposal withdrawn. Audit event written.', ''); });
    }
  });
})();
