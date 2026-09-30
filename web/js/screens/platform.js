(function () {
  const { UI, esc } = App;

  const STEP_TONE = { passed: 'ok', failed: 'danger', running: 'accent', skipped: 'warn', waiting: '' };
  const MIRROR_KINDS = [
    { value: 'images', label: 'Container images and charts' }, { value: 'npm', label: 'npm' }, { value: 'pypi', label: 'Python wheels' },
    { value: 'trivy', label: 'Vulnerability databases (Trivy)' }, { value: 'models', label: 'Model weights' }, { value: 'apt', label: 'OS packages' }, { value: 'tofu', label: 'OpenTofu providers' }
  ];
  const CERT_USES = ['TLS', 'mTLS', 'LDAPS', 'CA', 'other'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const when = (ms) => { if (!ms) return ''; const d = new Date(ms); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const day = (ms) => { if (!ms) return ''; const d = new Date(ms); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); };
  const ago = (ms) => { if (!ms) return 'never'; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
  const dur = (ms) => { if (ms == null) return ''; if (ms < 1000) return ms + ' ms'; if (ms < 60000) return (ms / 1000).toFixed(1) + ' s'; if (ms < 3600000) return Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s'; return Math.floor(ms / 3600000) + ' h ' + Math.round((ms % 3600000) / 60000) + ' min'; };
  const size = (n) => { if (n == null) return 'pending'; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(1) + ' GB'; };
  const mins = (m) => (m % 1440 === 0 ? (m / 1440) + (m === 1440 ? ' day' : ' days') : m % 60 === 0 ? (m / 60) + ' h' : m + ' min');
  const pillFor = (t) => UI.pill(t, /verified|clean|passed|in production|^ok$|within target|valid|succeeded|active|healthy|licences ok/.test(t) ? 'ok' : /failed|rejected|missed|quarantined|revoked|expired|unreachable/.test(t) ? 'danger' : /running|expedited|verifying|awaiting|promoting|pending|issuing|queued/.test(t) ? 'info' : /ready/.test(t) ? 'accent' : /older|stale|never|not configured|expir|no scanner/.test(t) ? 'warn' : '');

  // Sprint 18 (B-909): mirrors whose registry can be pushed to through its API.
  const PUSHABLE = { images: 'Harbor (OCI registry)', npm: 'Verdaccio (npm registry)', pypi: 'devpi (package index)' };

  function signatureOf(b) {
    const s = b.steps[1];
    if (s.state === 'passed') return 'verified';
    if (s.state === 'failed') return 'failed';
    if (s.state === 'running') return 'verifying';
    return b.state === 'awaiting transfer' ? 'awaiting transfer' : 'not run';
  }
  function scanOf(b) {
    const scan = b.steps[3], lic = b.steps[4];
    if (scan.state === 'failed') return 'scan failed';
    if (lic.state === 'failed') return 'licence failed';
    if (lic.state === 'passed') return scan.state === 'skipped' ? 'licences ok, no scanner' : 'clean';
    return scan.state === 'running' || lic.state === 'running' ? 'running' : 'not run';
  }
  function stagingOf(b) {
    const s = b.steps[5];
    return s.state === 'passed' ? 'passed' : s.state === 'skipped' ? 'not configured' : s.state === 'failed' ? 'failed' : s.state === 'running' ? 'running' : 'not run';
  }
  const busy = (d) => !!d && ((d.bundles || []).some((b) => b.state === 'verifying' || b.state === 'promoting') || (d.certs || []).some((c) => c.status === 'pending' || c.status === 'issuing') || ((d.backups && d.backups.backups) || []).some((b) => b.state === 'queued' || b.state === 'running') || ((d.backups && d.backups.drills) || []).some((x) => x.state === 'queued' || x.state === 'running'));

  App.register({
    id: 'platform', title: 'Platform', section: 'admin', live: true, summary: 'Import bundles and signatures, mirrors, certificates, secrets health, backups and restore drills',
    commands: [
      { label: 'Start an expedited import', sub: 'Platform', run(app) { app.stateFor('platform').openExpedited = true; app.render(); } },
      { label: 'Run a restore drill', sub: 'Platform', run(app) { app.stateFor('platform').openDrill = true; app.render(); } }
    ],
    states: [
      { title: 'Signature failed', tone: 'danger', text: 'The bundle is quarantined and cannot be promoted. Shows the expected and actual signer.', apply(ctx) { const b = ((ctx.state.data && ctx.state.data.bundles) || []).find((x) => x.steps[1].state === 'failed'); ctx.state.tab = 'imports'; if (b) ctx.state.sel = b.id; else ctx.toast('No bundle has failed its signature check.'); ctx.rerender(); } },
      { title: 'Stale vulnerability data', tone: 'warn', text: 'CI scans are marked as unreliable until a fresh database bundle is imported.', apply(ctx) { ctx.state.tab = 'mirrors'; ctx.state.focusStale = true; ctx.rerender(); } },
      { title: 'Backup target missed', tone: 'danger', text: 'A store past its RPO raises a platform alert and appears first in this table.', apply(ctx) { ctx.state.tab = 'backups'; ctx.rerender(); } },
      { title: 'No outbound links', tone: 'neutral', text: 'Every reference resolves to an internal mirror or document. Nothing opens the internet.', apply(ctx) { ctx.state.tab = 'mirrors'; ctx.state.showLinks = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const self = this;
      st.tab = st.tab || 'imports'; st.q = st.q || '';
      if (location.hash !== st.paramsHash) {
        st.paramsHash = location.hash;
        if (ctx.params.tab) st.tab = ctx.params.tab;
        if (ctx.params.bundle) { st.sel = ctx.params.bundle; st.tab = 'imports'; }
      }

      // ---------- loading ----------
      const refresh = () => {
        if (App.state.route !== 'platform') return;
        if (document.getElementById('overlay')) { st.dirty = true; return; }
        const focused = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute('data-q');
        ctx.rerender();
        if (focused) { const i = document.querySelector('#main [data-q]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
      };
      const onClose = () => { if (st.dirty) { st.dirty = false; refresh(); } };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all(['summary', 'bundles', 'signers', 'mirrors', 'certificates', 'keys', 'backups', 'signers/proposals', 'push-targets'].map((p) => App.get('/api/admin/platform/' + p)))
          .then((r) => {
            st.data = { summary: r[0], bundles: r[1], signers: r[2], mirrors: r[3], certs: r[4], keys: r[5], backups: r[6], proposals: r[7], pushTargets: r[8] };
            st.pushes = {};
            st.loaded = true; st.loadError = null;
          })
          .catch((err) => { st.loadError = err; })
          .finally(() => {
            st.loading = false;
            if (st.timer) { clearTimeout(st.timer); st.timer = null; }
            if (busy(st.data)) st.timer = setTimeout(() => { st.timer = null; if (App.state.route === 'platform') load(); }, 1500);
            refresh();
          });
      };
      if (!st.loaded && !st.loadError) load();
      const reload = () => load();
      const act = (p, ok) => p.then((r) => { if (ok) ctx.toast(ok, 'ok', 5000); reload(); return r; }).catch((err) => { App.fail(err); reload(); });

      if (!st.data) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Imports and platform', 'Everything that runs here arrived through one signed import path') + (st.loadError ? UI.problem('The platform view could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-retry' }) + '</div>' : '<div class="muted">Loading</div>') + '</div>';
        ctx.on('click', '[data-retry]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }

      const d = st.data, sum = d.summary;
      const bundles = d.bundles, mirrors = d.mirrors, certs = d.certs, bk = d.backups;
      if (!st.sel || !bundles.some((b) => b.id === st.sel)) st.sel = bundles.length ? bundles[0].id : null;
      const bundle = bundles.find((b) => b.id === st.sel) || null;
      const lastDrill = bk.drills[0] || null;
      const lastBackup = bk.backups.find((b) => b.state === 'succeeded') || null;
      const trivy = mirrors.filter((m) => m.kind === 'trivy');
      const staleTrivy = trivy.find((m) => m.stale) || null;
      const freshTrivyBundle = bundles.find((b) => b.state === 'ready to promote' && b.report && b.report.byMirror && b.report.byMirror.trivy);

      // ----- header strip -----
      // With NTP_SERVER set the clock is measured against NTP; the database check stays as a second opinion.
      const ntp = sum.clock.ntp || null;
      const skew = ntp && ntp.skewMs != null ? ntp.skewMs : sum.clock.skewMs;
      const skewAgainst = ntp ? (ntp.error ? 'NTP ' + ntp.server + ' did not answer; database: ' + (sum.clock.skewMs == null ? 'unknown' : (sum.clock.skewMs / 1000).toFixed(1) + ' s') : 'NTP ' + ntp.server + ' (stratum ' + ntp.stratum + ')') : sum.clock.against;
      const nextExpiry = sum.certificates.nextExpiry;
      const strip = '<div class="stats">'
        + UI.stat(esc(sum.acme.directoryUrl ? sum.acme.directoryUrl.replace(/^https?:\/\//, '').split('/')[0] : 'Not configured'), 'Internal CA', sum.certificates.total + ' certificates' + (nextExpiry ? ', next expiry in ' + nextExpiry.days + ' days' : ''))
        + UI.stat(esc(sum.kms.kind === 'openbao' ? 'OpenBao' : 'Local KMS') + ' ' + UI.pill(sum.kms.ok ? 'healthy' : 'unhealthy', sum.kms.ok ? 'ok' : 'danger'), 'Secrets', esc(sum.kms.detail))
        + UI.stat(skew == null ? 'unknown' : (skew / 1000).toFixed(1) + ' s' + (skew > 5000 ? ' ' + UI.pill('over 5 s', 'danger') : ''), 'Clock', 'skew against ' + esc(skewAgainst))
        + UI.stat(sum.bundles.ready + ' ready', 'Import bundles', sum.bundles.rejected + ' rejected, ' + sum.bundles.expedited + ' expedited')
        + '</div>';

      const tabs = UI.tabs([{ id: 'imports', label: 'Import bundles', count: bundles.length }, { id: 'mirrors', label: 'Mirrors', count: mirrors.length }, { id: 'certs', label: 'Certificates', count: certs.length }, { id: 'secrets', label: 'Secrets health' }, { id: 'backups', label: 'Backups' }], st.tab);

      let body = '';
      if (st.tab === 'imports') {
        const q = st.q.toLowerCase();
        const rows = bundles.filter((b) => !q || (b.name + ' ' + (b.contents || '') + ' ' + b.state).toLowerCase().indexOf(q) >= 0);
        body = '<div class="hstack wrap">' + UI.search('Search bundles', 'data-q', st.q) + '<span class="muted grow" style="font-size:12px">Weekly bundles for dependencies and databases; models on request; an expedited path for security patches.</span>' + UI.btn('Import bundle', { size: 'sm', icon: 'upload', attrs: 'data-open-import' }) + '</div>'
          + UI.table(['Bundle', 'Contents', 'Signature', 'Scan and licence', 'Staging', 'State', ''], rows.map((b) => ({ cells: ['<b class="mono">' + esc(b.name) + '</b>', esc(b.contents || 'awaiting manifest'), pillFor(signatureOf(b)), pillFor(scanOf(b)), pillFor(stagingOf(b)), pillFor(b.state) + (b.expedited && b.state !== 'in production' ? ' ' + UI.pill('expedited', 'info') : ''), b.state === 'ready to promote' ? UI.btn('Promote', { size: 'xs', kind: 'primary', attrs: 'data-promote="' + esc(b.id) + '"' }) : b.state === 'rejected' ? UI.pill('quarantined', 'danger') : ''], attrs: 'data-bundle="' + esc(b.id) + '"', selected: bundle && b.id === bundle.id })), { minWidth: '760px', emptyTitle: bundles.length ? 'No bundles match' : 'No bundles yet', emptyText: bundles.length ? 'Clear the search.' : 'Import a signed bundle, or start an expedited import for a security patch.' })
          + UI.notice('Nothing inside the deployment reaches the internet. Every artifact enters through this path and is verified against a signature and digest before any service can use it.' + (sum.bundleRequireChecks ? ' The vulnerability scan and the staging deploy are required: a bundle that skipped either cannot be promoted.' : ' The scan and staging steps run when configured; set PLATFORM_BUNDLE_REQUIRE_CHECKS to make them mandatory.'), 'info');
      } else if (st.tab === 'mirrors') {
        const ageText = (m) => (m.lastPromotedAt ? (m.ageDays === 0 ? 'today' : m.ageDays + (m.ageDays === 1 ? ' day' : ' days')) : m.maxAgeDays == null ? 'on request' : 'never promoted');
        body = (staleTrivy ? UI.notice('<b>Stale vulnerability data.</b> ' + esc(staleTrivy.name) + (staleTrivy.lastPromotedAt ? ' is ' + staleTrivy.ageDays + ' days old' : ' has never been promoted') + ', against a policy of ' + staleTrivy.maxAgeDays + ' days. CI scans are unreliable until a fresh database bundle is promoted' + (freshTrivyBundle ? '; ' + esc(freshTrivyBundle.name) + ' carries one.' : '.'), 'warn', freshTrivyBundle ? UI.btn('Promote ' + freshTrivyBundle.name, { size: 'sm', attrs: 'data-promote="' + esc(freshTrivyBundle.id) + '"' }) : '') : st.focusStale ? UI.notice(trivy.length ? 'The vulnerability database mirror is within its policy.' : 'No vulnerability database mirror is registered yet. Add one with the kind Trivy.', trivy.length ? 'ok' : 'info') : '')
          + (st.showLinks ? UI.notice('<b>No outbound links.</b> Every mirror URL must resolve to an internal address, checked when it is added and again at every probe; nothing on this page opens the internet.', 'info') : '')
          + '<div class="hstack wrap"><span class="grow"></span>' + UI.btn('Check all', { size: 'sm', icon: 'refresh', attrs: 'data-check-mirrors', disabled: !mirrors.length }) + UI.btn('Add mirror', { size: 'sm', kind: 'primary', attrs: 'data-add-mirror' }) + '</div>'
          + UI.table(['Mirror', 'Store', 'Freshness', 'Policy', 'Consumer'].concat(st.showLinks ? ['Resolves to'] : []).concat(['Last check', '']), mirrors.map((m) => ['<b>' + esc(m.name) + '</b><div class="muted" style="font-size:11px">' + esc((MIRROR_KINDS.find((k) => k.value === m.kind) || {}).label || m.kind) + '</div>', esc(m.store) + pushLine(m), esc(ageText(m)) + (m.lastBundle ? '<div class="muted mono" style="font-size:11px">' + esc(m.lastBundle) + '</div>' : ''), pillFor(m.policy), esc(m.consumer || '')].concat(st.showLinks ? ['<span class="mono">' + esc(m.host || m.url) + '</span>'] : []).concat([m.lastCheckAt ? pillFor(m.lastCheckOk ? 'ok' : 'unreachable') + '<div class="muted" style="font-size:11px" title="' + esc(m.lastCheckDetail || '') + '">' + esc(ago(m.lastCheckAt)) + '</div>' : '<span class="muted">not checked</span>', '<span class="hstack gap6">' + UI.btn('Check', { size: 'xs', kind: 'ghost', attrs: 'data-check-mirror="' + esc(m.id) + '"' }) + UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-edit-mirror="' + esc(m.id) + '"' }) + (PUSHABLE[m.kind] ? UI.btn('Push target', { size: 'xs', kind: 'ghost', attrs: 'data-push-target="' + esc(m.id) + '"' }) : '') + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-remove-mirror="' + esc(m.id) + '"' }) + '</span>'])), { clickable: false, minWidth: '820px', emptyTitle: 'No mirrors registered', emptyText: 'Add the internal mirrors that promoted bundles feed.' })
          + '<div class="muted" style="font-size:12px">Policy: dependency and database mirrors older than their limit (7 days unless set) are flagged. Model weights are content-addressed by sha256 and never expire. Promotion writes each file into the mirror store at mirrors/&lt;kind&gt;/sha256/&lt;digest&gt;, and, where a push target is set, into the registry through its API (Harbor for images, Verdaccio for npm, devpi for wheels).</div>';
      } else if (st.tab === 'certs') {
        const soon = certs.filter((c) => c.status === 'expiring' || c.status === 'expired').sort((a, b) => a.days - b.days);
        const first = soon[0];
        body = (!sum.acme.directoryUrl ? UI.notice('<b>ACME is not configured.</b> Set ACME_DIRECTORY_URL to the internal CA\'s directory to request and renew certificates here. Certificates can still be tracked for expiry.', 'warn') : '')
          + (first ? UI.notice('<b>' + soon.length + (soon.length === 1 ? ' certificate ' : ' certificates ') + (first.status === 'expired' ? 'has expired' : 'expires in ' + first.days + ' days') + '.</b> ' + esc(first.name) + (first.method === 'acme' ? ' is renewed through the internal ACME endpoint.' : ' was issued elsewhere; renew it there and track the new certificate.'), first.status === 'expired' ? 'danger' : 'warn', first.method === 'acme' ? UI.btn('Renew via ACME', { size: 'sm', attrs: 'data-renew="' + esc(first.id) + '"' }) : '') : UI.notice('No certificate expires within ' + sum.acme.renewDays + ' days.', 'ok'))
          + '<div class="hstack wrap"><span class="grow"></span>' + UI.btn('Track certificate', { size: 'sm', attrs: 'data-track-cert' }) + UI.btn('Request certificate', { size: 'sm', kind: 'primary', attrs: 'data-request-cert', disabled: !sum.acme.directoryUrl }) + '</div>'
          + UI.table(['Certificate', 'Issued to', 'Issuer', 'Expires', 'Use', 'State', ''], certs.map((c) => {
            const state = c.status === 'valid' ? UI.pill('valid, ' + c.days + ' days', 'ok') : c.status === 'expiring' ? UI.pill('expires in ' + c.days + ' days', 'warn') : pillFor(c.status);
            const actions = [];
            if (c.method === 'acme' && c.status !== 'pending' && c.status !== 'issuing') actions.push(UI.btn(c.status === 'failed' ? 'Retry' : 'Renew', { size: 'xs', kind: 'ghost', attrs: 'data-renew="' + esc(c.id) + '"' }));
            if (c.serial) actions.push('<a class="btn ghost xs" href="/api/admin/platform/certificates/' + encodeURIComponent(c.id) + '/chain" download>Chain</a>');
            if (c.method === 'acme' && c.status !== 'revoked') actions.push(UI.btn('Hooks', { size: 'xs', kind: 'ghost', attrs: 'data-cert-hooks="' + esc(c.id) + '"' }));
            if (c.hasKey && c.status !== 'revoked') actions.push(UI.btn('Export key', { size: 'xs', kind: 'ghost', attrs: 'data-export-key="' + esc(c.id) + '"' }));
            if (c.method === 'acme' && c.serial && c.status !== 'revoked') actions.push(UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-revoke="' + esc(c.id) + '"' }));
            if (c.method === 'tracked' || c.status === 'failed' || c.status === 'revoked' || c.status === 'expired') actions.push(UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-remove-cert="' + esc(c.id) + '"' }));
            return ['<span class="mono">' + esc(c.name) + '</span>' + (c.domains.length > 1 ? '<div class="muted" style="font-size:11px">+' + (c.domains.length - 1) + ' names</div>' : '') + (c.error ? '<div class="muted" style="font-size:11px" title="' + esc(c.error) + '">last attempt failed</div>' : ''), esc(c.issuedTo || ''), esc(c.issuer || (c.method === 'acme' ? 'awaiting issue' : '')), esc(c.notAfter ? day(c.notAfter) : ''), esc(c.use), state, '<span class="hstack gap6">' + actions.join('') + '</span>'];
          }), { clickable: false, minWidth: '860px', emptyTitle: 'No certificates yet', emptyText: 'Request one from the internal CA over ACME, or track one issued elsewhere.' })
          + '<div class="grid2">' + UI.panel('Internal CA', UI.kv([['ACME directory', sum.acme.directoryUrl ? '<span class="mono">' + esc(sum.acme.directoryUrl) + '</span>' : 'not configured'], ['Account', sum.acme.registered ? 'registered' + (sum.acme.contact ? ', ' + esc(sum.acme.contact) : '') : 'created on first request'], ['Challenge', sum.acme.challenge === 'dns-01' ? 'dns-01, TXT records published through the ' + esc(sum.acme.dnsProvider || 'DNS provider') + '; wildcards allowed' : 'http-01, answered by this server at /.well-known/acme-challenge'], ['Certificate files', sum.acme.certDir ? 'written to <span class="mono">' + esc(sum.acme.certDir) + '</span> on every instance after each issue and renewal' : 'not written (set ACME_CERT_DIR for the reverse proxy)'], ['Keys', 'ECDSA P-256, a new key at every issue, sealed with the platform data key'], ['Renewal', 'automatic ' + sum.acme.renewDays + ' days before expiry, checked every ' + mins(sum.acme.checkMinutes)]], 1))
          + UI.panel('Why it matters', '<div class="fg2">Kerberos, TOTP and certificate validation all depend on clocks. This server\'s clock is ' + (skew == null ? 'not measured' : (skew / 1000).toFixed(1) + ' s') + ' away from ' + esc(sum.clock.against) + '; the check fails at 5 s.</div><div>' + UI.btn('Open zones', { size: 'sm', kind: 'ghost', attrs: 'data-go="zones"' }) + '</div>') + '</div>';
      } else if (st.tab === 'secrets') {
        const files = sum.secretsFromFiles || [];
        const pending = (d.proposals || []).filter((p) => p.state === 'pending');
        const asFiles = files.filter((f) => f.file).length;
        body = '<div class="grid3">' + UI.stat(UI.pill(sum.kms.ok ? 'healthy' : 'unhealthy', sum.kms.ok ? 'ok' : 'danger'), sum.kms.kind === 'openbao' ? 'OpenBao transit' : 'Local KMS', esc(sum.kms.detail)) + UI.stat(String(d.keys.length), 'Data keys', 'one per tenant plus the platform key, wrapped by the KMS') + UI.stat(asFiles + ' of ' + files.length, 'Secrets mounted as files', 'the rest come from environment variables') + '</div>'
          + '<div class="eyebrow">Data keys</div>' + UI.table(['Key', 'Kind', 'Scope', 'Last rotated', 'Next rotation', { label: 'Versions', right: true }, ''], d.keys.map((k) => ['<span class="mono">' + esc(k.name) + '</span>', 'AES-256-GCM, wrapped by ' + esc(k.kms === 'openbao' ? 'OpenBao' : 'the local KMS'), esc(k.tenant || 'platform'), esc(day(k.rotatedAt)), k.nextRotation < Date.now() ? UI.pill('due', 'warn') : esc(day(k.nextRotation)), k.versions, k.state === 'destroyed' ? UI.pill('destroyed', 'danger') : UI.btn('Rotate', { size: 'xs', kind: 'ghost', attrs: 'data-rotate="' + esc(k.scope) + '" data-rotate-name="' + esc(k.name) + '"' })]), { clickable: false, minWidth: '720px', emptyTitle: 'No data keys yet', emptyText: 'Keys are created the first time something is sealed.' })
          + '<div class="hstack"><div class="eyebrow grow">Import signer keys</div>' + UI.btn('Add signer key', { size: 'sm', attrs: 'data-add-signer' }) + '</div>'
          + (pending.length ? UI.notice('<b>' + pending.length + (pending.length === 1 ? ' signer key change waits' : ' signer key changes wait') + ' for a second platform admin.</b> Adding and revoking signer keys is under dual control: the change applies only when someone other than the proposer approves it.', 'warn') : '')
          + (pending.length ? UI.table(['Change', 'Key', 'Fingerprint', 'Proposed', 'Reason', ''], pending.map((p) => [p.action === 'add' ? UI.pill('add', 'info') : UI.pill('revoke', 'danger'), '<span class="mono">' + esc(p.name) + '</span>', '<span class="mono" title="' + esc(p.fingerprint || '') + '">' + esc(p.short || '') + '</span>', esc((p.proposedByName || 'someone') + ', ' + ago(p.proposedAt)), esc(p.reason || ''), '<span class="hstack gap6">' + (p.mine ? UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-withdraw-signer="' + esc(p.id) + '"' }) : UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-approve-signer="' + esc(p.id) + '"' }) + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-reject-signer="' + esc(p.id) + '"' })) + '</span>']), { clickable: false, minWidth: '720px' }) : '')
          + UI.table(['Key', 'Algorithm', 'Fingerprint', 'Added', 'State', ''], d.signers.map((k) => ['<span class="mono">' + esc(k.name) + '</span>', esc(k.algorithm === 'ed25519' ? 'Ed25519 verify' : 'ECDSA P-256 verify'), '<span class="mono" title="' + esc(k.fingerprint) + '">' + esc(k.short) + '</span>', esc(day(k.createdAt)), k.state === 'revoked' ? UI.pill('revoked', 'danger') + (k.revokeReason ? '<div class="muted" style="font-size:11px">' + esc(k.revokeReason) + '</div>' : '') : UI.pill('active', 'ok'), k.state === 'active' ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-revoke-signer="' + esc(k.id) + '"' }) : '']), { clickable: false, minWidth: '640px', emptyTitle: 'No signer keys', emptyText: 'Register the public half of the offline key that signs import bundles. Until then every bundle fails its signature check.' })
          + '<div class="grid2">' + UI.panel('Health checks', UI.kv([['KMS', UI.pill(sum.kms.ok ? 'healthy' : 'unhealthy', sum.kms.ok ? 'ok' : 'danger') + ' ' + esc(sum.kms.detail)], ['Blob store', UI.pill(sum.blobs.ok ? 'healthy' : 'unhealthy', sum.blobs.ok ? 'ok' : 'danger') + ' ' + esc(sum.blobs.detail)], ['Backups', lastBackup ? 'last ' + esc(ago(lastBackup.createdAt)) + ', KMS-signed' : 'none yet'], ['Secrets as files', files.length ? files.map((f) => '<span class="mono">' + esc(f.name) + '</span> ' + (f.file ? UI.pill('file', 'ok') : UI.pill('env', 'warn'))).join(' ') : 'none set']], 1)) + UI.panel('Where keys are used', '<div class="fg2">Tenant data keys never leave the KMS unwrapped for longer than a cache lifetime. Destroying a tenant key crypto-shreds that tenant. Signer keys only ever verify; their private halves stay offline. To change the key-encryption key (a new DATA_KEY, or moving to OpenBao), set the old one as DATA_KEY_PREVIOUS (or KMS_PREVIOUS_PROVIDER) and run <span class="mono">exprsn-ai kms:rewrap</span>; once it reports verified, the old key can be removed.</div><div class="hstack gap6">' + UI.btn('Open identity keys', { size: 'sm', attrs: 'data-go="identity"' }) + UI.btn('Open tenants', { size: 'sm', kind: 'ghost', attrs: 'data-go="tenants"' }) + '</div>') + '</div>';
      } else {
        const alert = bk.alert;
        const target = 'RPO ' + mins(bk.rpoMinutes) + ', RTO ' + mins(bk.rtoMinutes);
        const dbState = alert ? 'RPO missed' : lastDrill && lastDrill.state === 'failed' ? 'drill failed' : lastBackup ? 'within target' : 'no backup yet';
        const dbName = { sqlite: 'SQLite', pg: 'PostgreSQL', mysql: 'MySQL' }[bk.dbClient] || bk.dbClient;
        const stores = [
          ['<b>Application database (' + esc(dbName) + ')</b>', lastBackup ? esc(ago(lastBackup.createdAt)) + ', ' + esc(size(lastBackup.bytes)) : 'none', lastDrill ? esc(when(lastDrill.createdAt)) + ', ' + esc(lastDrill.state) + (lastDrill.rtoMs != null ? ', ' + esc(dur(lastDrill.rtoMs)) : '') : 'none', esc(target), pillFor(dbState)],
          bk.blobsBackedUp
            ? ['<b>Blob store (' + esc(bk.blobStore === 's3' ? 'S3' : 'filesystem') + ')</b>', lastBackup ? 'archived with the database, ' + esc(ago(lastBackup.createdAt)) : 'none', lastDrill ? 'archive verified in the drill' : 'none', esc(target), pillFor(dbState)]
            : ['<b>Blob store (' + esc(bk.blobStore === 's3' ? 'S3' : 'filesystem') + ')</b>', 'not archived (PLATFORM_BACKUP_BLOBS is off)', 'not drilled', 'replicate or snapshot the bucket or BLOB_DIR', UI.pill('not covered', 'warn')],
          ['<b>Key material (' + esc(bk.kms === 'openbao' ? 'OpenBao' : 'DATA_KEY') + ')</b>', 'kept outside every backup', 'opened in every drill', 'needed to open any backup', UI.pill('external', '')]
        ];
        const drillSteps = lastDrill ? UI.timeline(lastDrill.steps.map((x) => ({ title: esc(x.title), text: x.detail ? esc(x.detail) : '', meta: x.state === 'passed' ? esc(dur(x.ms)) : esc(x.state), tone: STEP_TONE[x.state] }))) + (lastDrill.state === 'passed' || lastDrill.state === 'failed' ? '<div class="fg2" style="font-size:12px">Measured RPO ' + esc(dur(lastDrill.rpoMs)) + ' against ' + esc(dur(lastDrill.rpoTargetMs)) + '; RTO ' + esc(dur(lastDrill.rtoMs)) + ' against ' + esc(dur(lastDrill.rtoTargetMs)) + '. ' + pillFor(lastDrill.withinTarget ? 'within target' : 'target missed') + '</div>' : '') : '<div class="fg2">A drill restores a backup into a scratch SQLite database, never the live one, and checks the manifest signature, the archive digest, every table\'s row count and each tenant\'s audit chain and checkpoints. The measured times are compared with the RPO and RTO.</div>';
        const drilling = bk.drills.some((x) => x.state === 'queued' || x.state === 'running');
        const backingUp = bk.backups.some((b) => b.state === 'queued' || b.state === 'running');
        body = (alert && !alert.acknowledgedAt ? UI.notice('<b>Backup target missed.</b> ' + (alert.lastBackupAt ? 'The last database backup is from ' + esc(when(alert.lastBackupAt)) : 'There is no database backup yet') + ', against an RPO of ' + esc(mins(bk.rpoMinutes)) + '. A platform alert was raised at ' + esc(when(alert.raisedAt)) + ' and the store is listed first.', 'danger', UI.btn('Acknowledge', { size: 'sm', attrs: 'data-ack' })) : alert ? UI.notice('Backup target missed; acknowledged ' + esc(ago(alert.acknowledgedAt)) + '. The alert clears when the next backup lands.', 'warn') : '')
          + UI.table(['Store', 'Last backup', 'Last restore drill', 'Target', 'State'], stores, { clickable: false, minWidth: '640px' })
          + '<div class="hstack"><div class="eyebrow grow">Backups</div><span class="muted" style="font-size:12px">' + (bk.everyMinutes ? 'every ' + esc(mins(bk.everyMinutes)) : 'no schedule') + ', newest ' + bk.retain + ' kept</span>' + UI.btn(backingUp ? 'Backup running' : 'Back up now', { size: 'sm', icon: 'download', attrs: 'data-backup', disabled: backingUp }) + '</div>'
          + UI.table(['Started', 'Kind', { label: 'Tables', right: true }, { label: 'Rows', right: true }, 'Size', 'State', ''], bk.backups.map((b) => [esc(when(b.createdAt)), esc(b.kind), b.tables == null ? '' : b.tables, b.rows == null ? '' : b.rows, esc(b.bytes == null ? '' : size(b.bytes)), pillFor(b.state) + (b.signed ? ' ' + UI.pill('signed', 'ok') : '') + (b.error ? '<div class="muted" style="font-size:11px" title="' + esc(b.error) + '">' + esc(b.error.slice(0, 80)) + '</div>' : ''), b.state === 'succeeded' ? UI.btn('Restore drill', { size: 'xs', kind: 'ghost', attrs: 'data-drill="' + esc(b.id) + '"', disabled: drilling }) : '']), { clickable: false, minWidth: '640px', emptyTitle: 'No backups yet', emptyText: 'Back up now, or wait for the schedule.' })
          + '<div class="muted" style="font-size:12px">To restore production, stop every instance and run <span class="mono">exprsn-ai backup:restore --backup &lt;id&gt;</span> against an empty database; it refuses a database that holds data unless forced with a confirmation phrase.' + (lastBackup ? ' Newest backup id: <span class="mono">' + esc(lastBackup.id) + '</span>.' : '') + '</div>'
          + UI.panel('Restore drill', drillSteps + '<div>' + UI.btn(drilling ? 'Drill running' : 'Run restore drill', { size: 'sm', kind: 'primary', icon: 'play', attrs: 'data-drill', disabled: drilling || !lastBackup }) + '</div>');
      }

      // ----- inspector: selected bundle -----
      let insp = '<div class="eyebrow">Import bundle</div>';
      if (!bundle) insp += UI.empty('No bundle selected', 'Import a bundle to see its verification here.');
      else {
        const sigFailed = bundle.steps[1].state === 'failed';
        const active = d.signers.filter((k) => k.state === 'active').map((k) => k.name);
        const steps = bundle.steps.map((x) => ({ title: esc(x.title), tone: STEP_TONE[x.state], meta: x.state === 'skipped' ? 'not configured' : x.state, text: x.detail ? esc(x.detail) : '' }));
        const r = bundle.report || {};
        const hasModels = r.byMirror && r.byMirror.models;
        const findings = r.findings ? r.findings.length + ' findings' + (r.blocking ? ', ' + r.blocking + ' blocking' : '') : r.scanner === null && bundle.steps[3].state === 'skipped' ? 'no scanner configured' : 'not run';
        const pushes = st.pushes[bundle.id];
        if (bundle.state === 'in production' && !pushes) { st.pushes[bundle.id] = []; App.get('/api/admin/platform/bundles/' + encodeURIComponent(bundle.id) + '/pushes').then((list) => { st.pushes[bundle.id] = list; refresh(); }).catch(() => undefined); }
        const pushInfo = pushes && pushes.length ? '<div class="eyebrow">Registry pushes</div>' + UI.table(['File', 'Artefact', 'State'], pushes.slice(-12).map((x) => ['<span class="mono" style="font-size:11px">' + esc(x.path.split('/').pop()) + '</span>', '<span class="mono" style="font-size:11px">' + esc(x.artefact || '') + '</span>', pillFor(x.state === 'pushed' ? 'succeeded' : x.state === 'exists' ? 'ok' : 'failed') + (x.detail && x.state === 'failed' ? '<div class="muted" style="font-size:11px">' + esc(x.detail) + '</div>' : '')]), { clickable: false, minWidth: '0', cls: 'bare' }) : '';
        insp += '<div style="font-size:15px;font-weight:600" class="mono">' + esc(bundle.name) + '</div><div class="hstack gap6">' + pillFor(bundle.state) + (bundle.expedited ? UI.pill('expedited', 'info') : '') + '</div>'
          + (sigFailed ? UI.notice('<b>Signature failed.</b> The bundle is quarantined and cannot be promoted or staged. Expected signer <span class="mono">' + esc(active.join(', ') || 'none registered') + '</span>; actual signer <span class="mono">' + esc(bundle.signer ? (bundle.signer.name ? bundle.signer.name + ' (' + bundle.signer.state + ') ' : 'unknown key ') + bundle.signer.short : 'unreadable') + '</span>.', 'danger') : bundle.state === 'rejected' && bundle.error ? UI.notice('<b>Rejected.</b> ' + esc(bundle.error), 'danger') : '')
          + UI.kv([['Contents', esc(bundle.contents || 'awaiting manifest')], ['Size', esc(size(bundle.size))], ['Received', bundle.receivedAt ? esc(when(bundle.receivedAt)) + ', ' + esc(bundle.transfer) : 'awaiting transfer, ' + esc(bundle.transfer)], ['Digest', '<span class="mono">' + esc(bundle.digest ? bundle.digest.slice(0, 19) + '…' + bundle.digest.slice(-4) : 'pending') + '</span>'], ['Signer', bundle.signer ? esc((bundle.signer.name || 'unknown key') + ' (' + (bundle.signer.algorithm || 'unregistered') + ', ' + bundle.signer.short + ')') : esc(active.length ? 'expected ' + active.join(', ') : 'no signer keys registered')], ['Scan and licence', pillFor(scanOf(bundle)) + ' <span class="muted" style="font-size:12px">' + esc(findings) + '</span>']].concat(bundle.ticket ? [['Security ticket', '<span class="mono">' + esc(bundle.ticket) + '</span>']] : []), 1)
          + '<div class="eyebrow">Verification</div>' + UI.timeline(steps)
          + pushInfo
          + '<div class="vstack gap6">'
          + (bundle.state === 'awaiting transfer' || bundle.state === 'rejected' ? UI.btn(bundle.state === 'rejected' ? 'Upload a new transfer' : 'Upload transfer', { size: 'sm', icon: 'upload', attrs: 'data-upload' }) + '<input type="file" data-file hidden>' : '')
          + (bundle.digest && bundle.state !== 'in production' && bundle.state !== 'promoting' && bundle.state !== 'awaiting transfer' ? UI.btn(bundle.state === 'verifying' ? 'Verifying' : 'Verify bundle', { size: 'sm', icon: 'refresh', attrs: 'data-verify', disabled: bundle.state === 'verifying' }) : '')
          + (bundle.state === 'ready to promote' ? UI.btn('Promote', { size: 'sm', kind: 'primary', attrs: 'data-promote="' + esc(bundle.id) + '"' }) : '')
          + (bundle.state === 'in production' && (d.pushTargets || []).some((t) => t.state === 'active') ? UI.btn('Push to registries again', { size: 'sm', icon: 'upload', attrs: 'data-push-bundle="' + esc(bundle.id) + '"' }) : '')
          + (hasModels ? UI.btn('Open models', { size: 'sm', kind: 'ghost', attrs: 'data-go="models"' }) : '')
          + (bundle.state === 'rejected' ? UI.btn('Delete quarantined bundle', { size: 'sm', kind: 'danger', attrs: 'data-delete' }) : bundle.state === 'awaiting transfer' ? UI.btn('Cancel import', { size: 'sm', kind: 'ghost', attrs: 'data-delete' }) : '')
          + '</div>';
      }

      root.innerHTML = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}</style><div class="page">' + UI.pagehead('Imports and platform', 'Everything that runs here arrived through one signed import path', UI.btn('Run restore drill', { attrs: 'data-drill', disabled: !lastBackup }) + UI.btn('Start expedited import', { kind: 'primary', attrs: 'data-expedited' }))
        + strip + tabs + body
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(self.states) + '</div></div>'
        + '<aside class="inspector">' + insp + '</aside>';
      if (st.focusStale && st.tab !== 'mirrors') st.focusStale = false;

      // ----- actions -----
      const sendFile = (id, file) => {
        ctx.toast('Uploading ' + esc(file.name) + ' (' + esc(size(file.size)) + ').');
        return fetch('/api/admin/platform/bundles/' + encodeURIComponent(id) + '/transfer', { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': 'application/octet-stream', Accept: 'application/json' } })
          .then((res) => res.json().then((data) => { if (!res.ok) throw new App.ApiError(data); return data; }))
          .then(() => { ctx.toast('Transfer received. Verification is running.', 'ok'); reload(); })
          .catch((err) => { App.fail(err, 'Transfer failed'); reload(); });
      };
      function promote(id) {
        const b = bundles.find((x) => x.id === id); if (!b) return;
        const kinds = Object.keys((b.report && b.report.byMirror) || {});
        const targets = mirrors.filter((m) => kinds.indexOf(m.kind) >= 0).map((m) => m.name);
        ctx.confirm({ title: 'Promote ' + b.name, tag: 'changes mirrors', tone: 'info', body: '<p class="fg2" style="margin:0">Checks the digest and signature again, then copies the verified artifacts into the mirror store for each kind. Consumers pick them up on their next build or pull.</p>', kv: [['Contents', esc(b.contents || '')], ['Signer', esc(b.signer && b.signer.name ? b.signer.name : '')], ['Mirrors', esc(targets.join(', ') || 'none registered for these kinds')]], ok: 'Promote' }).then((ok) => { onClose(); if (!ok) return; act(App.post('/api/admin/platform/bundles/' + encodeURIComponent(id) + '/promote'), esc(b.name) + ' is being promoted. An audit event is written when the mirrors are refreshed.'); });
      }
      function openImport(expedited) {
        ctx.modal({ title: expedited ? 'Start expedited import ' + UI.pill('security patch', 'warn') : 'Import bundle',
          body: '<div class="formgrid">' + UI.field('Bundle ID', UI.input(expedited ? '' : '', { attrs: 'data-xid placeholder="' + (expedited ? '2026-38-sec-02' : '2026-39-weekly') + '"' })) + UI.field('Transfer', UI.select(['diode', 'removable media'].concat(expedited ? [] : ['upload']), 'diode', 'data-xt')) + UI.field('Contents', UI.input('', { attrs: 'data-xc placeholder="e.g. glibc patch, 2 images"' })) + (expedited ? UI.field('Security ticket', UI.input('SEC-', { attrs: 'data-xticket placeholder="SEC-1234"' })) : UI.field('Bundle file', '<input type="file" class="input" data-xfile accept=".tar,application/x-tar">', 'A tar with manifest.json and manifest.sig first. Or leave it empty and upload the transfer later.')) + '</div>'
            + (expedited ? UI.notice('Expedited bundles skip the weekly cadence, not the checks. Signature, digest, scan and staging still run; the target from vendor fix to deployment is agreed with the security team.', 'info') : ''),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(expedited ? 'Start import' : 'Import', { kind: 'primary', attrs: 'data-xgo' }),
          onClose,
          onMount(m) {
            const fileIn = m.querySelector('[data-xfile]');
            if (fileIn) fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; const idIn = m.querySelector('[data-xid]'); if (f && !idIn.value) idIn.value = f.name.replace(/\.(tar|tgz|tar\.gz|bundle)$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-'); });
            m.querySelector('[data-xgo]').addEventListener('click', () => {
              const name = m.querySelector('[data-xid]').value.trim();
              if (!name) { ctx.toast('Give the bundle an ID.', 'warn'); return; }
              const file = fileIn && fileIn.files && fileIn.files[0];
              const bodyJson = { name: name, transfer: m.querySelector('[data-xt]').value, contents: m.querySelector('[data-xc]').value.trim() || null, expedited: !!expedited };
              if (expedited) bodyJson.ticket = m.querySelector('[data-xticket]').value.trim();
              App.post('/api/admin/platform/bundles', bodyJson).then((b) => {
                App.closeOverlay(); st.sel = b.id; st.tab = 'imports';
                if (file) return sendFile(b.id, file);
                ctx.toast((expedited ? 'Expedited import ' : 'Import ') + esc(b.name) + ' started. Waiting for the transfer.', 'ok'); reload();
              }).catch((err) => App.fail(err, 'The import could not be started'));
            });
          }
        });
      }
      function drill(backupId) {
        const b = backupId ? bk.backups.find((x) => x.id === backupId) : lastBackup;
        if (!b) { ctx.toast('There is no successful backup to restore yet. Back up first.', 'warn'); return; }
        ctx.confirm({ title: 'Run restore drill', tag: 'isolated', tone: 'info', body: '<p class="fg2" style="margin:0">Restores the backup into a scratch SQLite database and measures each step against its target. The live database is untouched.</p>', kv: [['Backup', esc(when(b.createdAt)) + ', ' + esc(size(b.bytes))], ['Checks', 'signature, digest, row counts, audit chains'], ['Last drill', lastDrill ? esc(when(lastDrill.createdAt)) + ', ' + esc(lastDrill.state) + (lastDrill.rtoMs != null ? ', ' + esc(dur(lastDrill.rtoMs)) : '') : 'none']], ok: 'Start drill' }).then((ok) => { onClose();
          if (!ok) return;
          st.tab = 'backups';
          act(App.post('/api/admin/platform/backups/drills', { backupId: b.id }), 'Restore drill started. Results are recorded when it finishes.');
        });
      }
      function mirrorModal(m) {
        ctx.modal({ title: m ? 'Edit ' + esc(m.name) : 'Add mirror',
          body: '<div class="formgrid">' + UI.field('Name', UI.input(m ? m.name : '', { attrs: 'data-mname placeholder="npm"' })) + UI.field('Kind', UI.select(MIRROR_KINDS, m ? m.kind : 'npm', 'data-mkind')) + UI.field('Store', UI.input(m ? m.store : '', { attrs: 'data-mstore placeholder="Verdaccio"' })) + UI.field('URL', UI.input(m ? m.url : '', { attrs: 'data-murl placeholder="https://npm.data.internal/"' }), 'Must resolve to an internal address.') + UI.field('Consumer', UI.input(m ? m.consumer || '' : '', { attrs: 'data-mconsumer placeholder="CI and TypeScript builds"' })) + UI.field('Maximum age in days', UI.input(m ? (m.maxAgeDays == null ? '' : String(m.maxAgeDays)) : '7', { type: 'number', attrs: 'data-mage min="1"' }), 'Leave empty for content-addressed stores that never go stale.') + '</div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(m ? 'Save' : 'Add mirror', { kind: 'primary', attrs: 'data-msave' }),
          onClose,
          onMount(el) {
            el.querySelector('[data-msave]').addEventListener('click', () => {
              const age = el.querySelector('[data-mage]').value.trim();
              const payload = { name: el.querySelector('[data-mname]').value.trim(), kind: el.querySelector('[data-mkind]').value, store: el.querySelector('[data-mstore]').value.trim(), url: el.querySelector('[data-murl]').value.trim(), consumer: el.querySelector('[data-mconsumer]').value.trim() || null, maxAgeDays: age ? Number(age) : null };
              (m ? App.patch('/api/admin/platform/mirrors/' + encodeURIComponent(m.id), payload) : App.post('/api/admin/platform/mirrors', payload))
                .then(() => { App.closeOverlay(); ctx.toast(m ? 'Mirror saved. Audit event written.' : 'Mirror added. Audit event written.', 'ok'); reload(); })
                .catch((err) => App.fail(err, 'The mirror could not be saved'));
            });
          }
        });
      }
      function requestCert() {
        ctx.modal({ title: 'Request certificate',
          body: '<div class="formgrid">' + UI.field('DNS names', UI.input('', { attrs: 'data-cdomains placeholder="inference-gw.app.internal, gw.app.internal"' }), 'Comma-separated. The first is the certificate name.') + UI.field('Issued to', UI.input('', { attrs: 'data-cto placeholder="inference gateway"' })) + UI.field('Use', UI.select(CERT_USES.filter((u) => u !== 'CA'), 'TLS', 'data-cuse')) + '</div>' + UI.check('Renew automatically ' + sum.acme.renewDays + ' days before expiry', true, 'data-cauto') + UI.notice('Orders from ' + esc(sum.acme.directoryUrl || '') + ' with an http-01 challenge that this server answers. Each name must reach this server on port 80 from the CA.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Request', { kind: 'primary', attrs: 'data-cgo' }),
          onClose,
          onMount(el) {
            el.querySelector('[data-cgo]').addEventListener('click', () => {
              const domains = el.querySelector('[data-cdomains]').value.split(',').map((x) => x.trim()).filter(Boolean);
              App.post('/api/admin/platform/certificates', { domains: domains, issuedTo: el.querySelector('[data-cto]').value.trim() || null, use: el.querySelector('[data-cuse]').value, autoRenew: el.querySelector('[data-cauto]').checked })
                .then((c) => { App.closeOverlay(); ctx.toast('Certificate for ' + esc(c.name) + ' requested over ACME.', 'ok'); reload(); })
                .catch((err) => App.fail(err, 'The certificate could not be requested'));
            });
          }
        });
      }
      function trackCert() {
        ctx.modal({ title: 'Track certificate',
          body: UI.field('Certificate (PEM)', UI.textarea('', { rows: 8, attrs: 'data-tpem placeholder="-----BEGIN CERTIFICATE-----"' }), 'The certificate only, never its private key. Tracked certificates are watched for expiry.') + '<div class="formgrid">' + UI.field('Issued to', UI.input('', { attrs: 'data-tto placeholder="issuing CA"' })) + UI.field('Use', UI.select(CERT_USES, 'CA', 'data-tuse')) + '</div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Track', { kind: 'primary', attrs: 'data-tgo' }),
          onClose,
          onMount(el) {
            el.querySelector('[data-tgo]').addEventListener('click', () => {
              App.post('/api/admin/platform/certificates/track', { pem: el.querySelector('[data-tpem]').value.trim(), issuedTo: el.querySelector('[data-tto]').value.trim() || null, use: el.querySelector('[data-tuse]').value })
                .then((c) => { App.closeOverlay(); ctx.toast(esc(c.name) + ' is tracked until ' + esc(day(c.notAfter)) + '.', 'ok'); reload(); })
                .catch((err) => App.fail(err, 'The certificate could not be tracked'));
            });
          }
        });
      }
      function addSigner() {
        ctx.modal({ title: 'Add signer key',
          body: UI.field('Name', UI.input('', { attrs: 'data-sname placeholder="platform-import-2027"' })) + UI.field('Public key (PEM)', UI.textarea('', { rows: 6, attrs: 'data-spem placeholder="-----BEGIN PUBLIC KEY-----"' }), 'Ed25519 or ECDSA P-256. Bundles signed by this key pass step 2 from now on.'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add key', { kind: 'primary', attrs: 'data-sgo' }),
          onClose,
          onMount(el) {
            el.querySelector('[data-sgo]').addEventListener('click', () => {
              App.post('/api/admin/platform/signers', { name: el.querySelector('[data-sname]').value.trim(), publicKeyPem: el.querySelector('[data-spem]').value.trim() })
                .then((k) => { App.closeOverlay(); ctx.toast(k.proposal ? 'Signer key ' + esc(k.proposal.name) + ' proposed. It is added when another platform admin approves it.' : 'Signer key ' + esc(k.name) + ' (' + esc(k.short) + ') added. Audit event written.', 'ok', 6000); reload(); })
                .catch((err) => App.fail(err, 'The key could not be added'));
            });
          }
        });
      }
      function exportKey(c) {
        ctx.confirm({ title: 'Export private key for ' + c.name, tag: 'audited', tone: 'danger', body: '<p class="fg2" style="margin:0">Downloads the private key so the deploy tooling can install it. Every export is written to the audit chain. Keep the file out of source control and delete it once installed.</p>', ok: 'Export key' }).then((ok) => { onClose();
          if (!ok) return;
          fetch('/api/admin/platform/certificates/' + encodeURIComponent(c.id) + '/key', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '' } })
            .then((res) => { if (!res.ok) return res.json().then((p) => { throw new App.ApiError(p); }); return res.blob(); })
            .then((blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = c.name + '.key.pem'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); ctx.toast('Key exported. Audit event written.', 'ok'); })
            .catch((err) => App.fail(err, 'The key could not be exported'));
        });
      }
      function pushLine(m) {
        const t = (d.pushTargets || []).find((x) => x.mirrorId === m.id);
        if (!t) return '';
        return '<div class="muted" style="font-size:11px">pushes to ' + esc(t.url.replace(/^https?:\/\//, '')) + (t.state === 'disabled' ? ', paused' : '') + (t.lastPushAt ? ', ' + (t.lastPushOk ? 'last push ok' : 'last push failed') : '') + '</div>';
      }
      function pushTargetModal(m) {
        const t = (d.pushTargets || []).find((x) => x.mirrorId === m.id) || null;
        ctx.modal({ title: 'Push target for ' + esc(m.name),
          body: '<div class="fg2" style="font-size:12px;margin-bottom:8px">Promoted ' + esc(m.kind) + ' files are pushed to ' + esc(PUSHABLE[m.kind]) + ' through its API after each promotion. The address must be internal; the secret is stored sealed and never shown again.</div>'
            + '<div class="formgrid">' + UI.field('API URL', UI.input(t ? t.url : m.url, { attrs: 'data-purl placeholder="https://harbor.data.internal"' }))
            + (m.kind === 'npm' ? '' : UI.field(m.kind === 'images' ? 'Harbor project' : 'Index (user/index)', UI.input(t ? t.repository || '' : '', { attrs: 'data-prepo placeholder="' + (m.kind === 'images' ? 'platform' : 'root/prod') + '"' })))
            + UI.field('Username', UI.input(t ? t.username || '' : '', { attrs: 'data-puser placeholder="' + (m.kind === 'npm' ? 'leave empty for a token' : 'robot$push') + '"' }))
            + UI.field(m.kind === 'npm' ? 'Token or password' : 'Password or robot secret', UI.input('', { type: 'password', attrs: 'data-psecret autocomplete="new-password" placeholder="' + (t && t.hasSecret ? 'keep the stored secret' : '') + '"' }))
            + UI.field('State', UI.select([{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Paused' }], t ? t.state : 'active', 'data-pstate')) + '</div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + (t ? UI.btn('Remove target', { kind: 'danger', attrs: 'data-pdel' }) : '') + UI.btn('Save', { kind: 'primary', attrs: 'data-psave' }),
          onClose,
          onMount(el) {
            el.querySelector('[data-psave]').addEventListener('click', () => {
              const val = (sel) => { const i = el.querySelector(sel); return i ? i.value.trim() : ''; };
              const payload = { url: val('[data-purl]'), username: val('[data-puser]') || null, state: val('[data-pstate]') };
              if (m.kind !== 'npm') payload.repository = val('[data-prepo]') || null;
              if (val('[data-psecret]')) payload.secret = val('[data-psecret]');
              App.api('PUT', '/api/admin/platform/mirrors/' + encodeURIComponent(m.id) + '/push-target', payload)
                .then(() => { App.closeOverlay(); ctx.toast('Push target saved. Audit event written.', 'ok'); reload(); })
                .catch((err) => App.fail(err, 'The push target could not be saved'));
            });
            const del = el.querySelector('[data-pdel]');
            if (del) del.addEventListener('click', () => App.del('/api/admin/platform/mirrors/' + encodeURIComponent(m.id) + '/push-target').then(() => { App.closeOverlay(); ctx.toast('Push target removed. Audit event written.', 'ok'); reload(); }).catch((err) => App.fail(err)));
          }
        });
      }
      function hooksModal(c) {
        App.get('/api/admin/platform/certificates/' + encodeURIComponent(c.id) + '/hooks').then((h) => {
          const rows = h.hooks.map((x) => [esc(x.kind === 'command' ? 'Reload command' : 'Signed webhook'), '<span class="mono" style="font-size:12px">' + esc(x.command || x.url) + '</span>', x.lastState ? pillFor(x.lastState === 'ok' ? 'succeeded' : 'failed') + (x.lastDetail ? '<div class="muted" style="font-size:11px">' + esc(x.lastDetail) + '</div>' : '') : '<span class="muted">not run yet</span>', '<span class="hstack gap6">' + UI.btn('Run now', { size: 'xs', kind: 'ghost', attrs: 'data-htest="' + esc(x.id) + '"', disabled: !c.serial }) + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-hdel="' + esc(x.id) + '"' }) + '</span>']);
          ctx.modal({ title: 'Hooks for ' + esc(c.name), cls: 'wide',
            body: '<div class="fg2" style="font-size:12px">After every issue and renewal, each hook runs: a reload command named by the operator in ACME_RELOAD_COMMANDS (on every instance, once its certificate files are written), or a webhook to an internal address, signed with a secret shown once. The webhook carries the chain, never the private key.</div>'
              + (rows.length ? UI.table(['Kind', 'Target', 'Last run', ''], rows, { clickable: false, minWidth: '0', cls: 'bare' }) : '<div class="muted" style="font-size:12px">No hooks yet.</div>')
              + '<div id="pl-hsecret"></div>'
              + '<div class="formgrid">' + UI.field('Reload command', h.commands.length ? UI.select(h.commands.map((n) => ({ value: n, label: n })), h.commands[0], 'data-hcmd') : '<span class="muted" style="font-size:12px">None configured (ACME_RELOAD_COMMANDS)</span>') + UI.field('Webhook URL', UI.input('', { attrs: 'data-hurl placeholder="https://deploy.app.internal/cert-reload"' })) + '</div>',
            actions: UI.btn('Close', { attrs: 'data-close' }) + (h.commands.length ? UI.btn('Add command', { attrs: 'data-hadd-cmd' }) : '') + UI.btn('Add webhook', { kind: 'primary', attrs: 'data-hadd-url' }),
            onClose,
            onMount(el) {
              const again = () => { App.closeOverlay(); hooksModal(c); };
              const add = (body) => App.post('/api/admin/platform/certificates/' + encodeURIComponent(c.id) + '/hooks', body).then((x) => {
                if (x.secret) {
                  el.querySelector('#pl-hsecret').innerHTML = UI.notice('<b>Webhook secret, shown once.</b> Verify the X-Exprsn-Signature header with it: <span class="mono">' + esc(x.secret) + '</span>', 'warn');
                  ctx.toast('Webhook added. Copy its secret now; it is not shown again.', 'ok', 6000);
                } else { ctx.toast('Reload command added. Audit event written.', 'ok'); again(); }
              }).catch((err) => App.fail(err, 'The hook could not be added'));
              const cmd = el.querySelector('[data-hadd-cmd]'); if (cmd) cmd.addEventListener('click', () => add({ kind: 'command', command: el.querySelector('[data-hcmd]').value }));
              el.querySelector('[data-hadd-url]').addEventListener('click', () => add({ kind: 'webhook', url: el.querySelector('[data-hurl]').value.trim() }));
              el.querySelectorAll('[data-htest]').forEach((b) => b.addEventListener('click', () => App.post('/api/admin/platform/certificates/' + encodeURIComponent(c.id) + '/hooks/' + encodeURIComponent(b.dataset.htest) + '/test').then((x) => { ctx.toast(x.lastState === 'ok' ? 'Hook ran: ' + esc(x.lastDetail || 'ok') : 'Hook failed: ' + esc(x.lastDetail || ''), x.lastState === 'ok' ? 'ok' : 'warn', 6000); again(); }).catch((err) => App.fail(err))));
              el.querySelectorAll('[data-hdel]').forEach((b) => b.addEventListener('click', () => App.del('/api/admin/platform/certificates/' + encodeURIComponent(c.id) + '/hooks/' + encodeURIComponent(b.dataset.hdel)).then(() => { ctx.toast('Hook removed. Audit event written.', 'ok'); again(); }).catch((err) => App.fail(err))));
            }
          });
        }).catch((err) => App.fail(err, 'The hooks could not be loaded'));
      }
      if (st.openExpedited) { st.openExpedited = false; setTimeout(() => openImport(true), 50); }
      if (st.openDrill) { st.openDrill = false; setTimeout(() => drill(null), 50); }

      // ----- handlers -----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', 'tr[data-bundle]', (e, t) => { if (e.target.closest('[data-promote]')) return; st.sel = t.dataset.bundle; ctx.rerender(); });
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; const val = t.value; ctx.rerender(); const i = ctx.$('[data-q]'); if (i) { i.focus(); i.setSelectionRange(val.length, val.length); } });
      ctx.on('click', '[data-verify]', () => { if (bundle) act(App.post('/api/admin/platform/bundles/' + encodeURIComponent(bundle.id) + '/verify'), 'Verification of ' + esc(bundle.name) + ' started.'); });
      ctx.on('click', '[data-promote]', (e, t) => { e.stopPropagation(); promote(t.dataset.promote); });
      ctx.on('click', '[data-expedited]', () => openImport(true));
      ctx.on('click', '[data-open-import]', () => openImport(false));
      ctx.on('click', '[data-upload]', () => { const i = ctx.$('[data-file]'); if (i) i.click(); });
      ctx.on('change', '[data-file]', (e, t) => { const f = t.files && t.files[0]; t.value = ''; if (f && bundle) sendFile(bundle.id, f); });
      ctx.on('click', '[data-drill]', (e, t) => drill(t.dataset.drill || null));
      ctx.on('click', '[data-backup]', () => ctx.confirm({ title: 'Back up now', tone: 'info', body: '<p class="fg2" style="margin:0">Dumps every table of the application database into an encrypted archive in the blob store, with a manifest signed by the KMS.</p>', kv: [['Database', esc(bk.dbClient)], ['Kept', 'newest ' + bk.retain]], ok: 'Back up' }).then((ok) => { onClose(); if (ok) act(App.post('/api/admin/platform/backups'), 'Backup started.'); }));
      ctx.on('click', '[data-delete]', () => { if (!bundle) return; const q = bundle.state === 'rejected'; ctx.confirm({ title: q ? 'Delete quarantined bundle' : 'Cancel import', tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">' + (q ? 'Removes the transferred files. The rejection and both signer fingerprints stay in the audit chain.' : 'Removes the import that is waiting for its transfer.') + '</p>', kv: [['Bundle', esc(bundle.name)]], ok: 'Delete' }).then((ok) => { onClose(); if (!ok) return; act(App.del('/api/admin/platform/bundles/' + encodeURIComponent(bundle.id)).then(() => { st.sel = null; }), q ? 'Quarantined bundle deleted. Audit event written.' : 'Import cancelled. Audit event written.'); }); });
      ctx.on('click', '[data-renew]', (e, t) => { const c = certs.find((x) => x.id === t.dataset.renew); if (!c) return; ctx.confirm({ title: 'Renew ' + c.name, tone: 'info', body: '<p class="fg2" style="margin:0">Requests a new certificate with a new key from the internal CA over ACME. The current certificate stays valid until it expires; install the new one with the deploy tooling.</p>', ok: 'Renew' }).then((ok) => { onClose(); if (ok) act(App.post('/api/admin/platform/certificates/' + encodeURIComponent(c.id) + '/renew'), 'Renewal of ' + esc(c.name) + ' started.'); }); });
      ctx.on('click', '[data-revoke]', (e, t) => { const c = certs.find((x) => x.id === t.dataset.revoke); if (!c) return; ctx.modal({ title: 'Revoke ' + esc(c.name) + ' ' + UI.pill('destructive', 'danger'), body: '<p class="fg2" style="margin:0">Asks the CA to revoke this certificate. Services still using it fail validation once revocation reaches them. Automatic renewal stops.</p>' + UI.field('Reason', UI.select([{ value: 'superseded', label: 'Superseded' }, { value: 'keyCompromise', label: 'Key compromise' }, { value: 'cessationOfOperation', label: 'No longer used' }, { value: 'unspecified', label: 'Unspecified' }], 'superseded', 'data-rreason')), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Revoke', { kind: 'danger', attrs: 'data-rgo' }), onClose, onMount(el) { el.querySelector('[data-rgo]').addEventListener('click', () => { const reason = el.querySelector('[data-rreason]').value; App.closeOverlay(); act(App.post('/api/admin/platform/certificates/' + encodeURIComponent(c.id) + '/revoke', { reason: reason }), esc(c.name) + ' revoked. Audit event written.'); }); } }); });
      ctx.on('click', '[data-remove-cert]', (e, t) => { const c = certs.find((x) => x.id === t.dataset.removeCert); if (!c) return; ctx.confirm({ title: 'Remove ' + c.name, tone: 'danger', tag: 'removes tracking', body: '<p class="fg2" style="margin:0">Stops tracking this certificate here. Nothing is revoked.</p>', ok: 'Remove' }).then((ok) => { onClose(); if (ok) act(App.del('/api/admin/platform/certificates/' + encodeURIComponent(c.id)), esc(c.name) + ' removed. Audit event written.'); }); });
      ctx.on('click', '[data-export-key]', (e, t) => { const c = certs.find((x) => x.id === t.dataset.exportKey); if (c) exportKey(c); });
      ctx.on('click', '[data-request-cert]', requestCert);
      ctx.on('click', '[data-cert-hooks]', (e, t) => { const c = certs.find((x) => x.id === t.dataset.certHooks); if (c) hooksModal(c); });
      ctx.on('click', '[data-push-target]', (e, t) => { const m = mirrors.find((x) => x.id === t.dataset.pushTarget); if (m) pushTargetModal(m); });
      ctx.on('click', '[data-push-bundle]', (e, t) => { const b = bundles.find((x) => x.id === t.dataset.pushBundle); if (!b) return; ctx.confirm({ title: 'Push ' + b.name + ' again', tone: 'info', body: '<p class="fg2" style="margin:0">Pushes every promoted file to the registries with an active push target. Files already there are recorded as present.</p>', ok: 'Push' }).then((ok) => { onClose(); if (ok) act(App.post('/api/admin/platform/bundles/' + encodeURIComponent(b.id) + '/push').then((r) => { delete st.pushes[b.id]; return r; }), 'Push of ' + esc(b.name) + ' started.'); }); });
      ctx.on('click', '[data-track-cert]', trackCert);
      ctx.on('click', '[data-add-mirror]', () => mirrorModal(null));
      ctx.on('click', '[data-edit-mirror]', (e, t) => mirrorModal(mirrors.find((m) => m.id === t.dataset.editMirror)));
      ctx.on('click', '[data-remove-mirror]', (e, t) => { const m = mirrors.find((x) => x.id === t.dataset.removeMirror); if (!m) return; ctx.confirm({ title: 'Remove ' + m.name, tone: 'danger', tag: 'removes registration', body: '<p class="fg2" style="margin:0">Removes the mirror from this registry. Files already in its store stay; later promotions of this kind are not recorded against it.</p>', ok: 'Remove' }).then((ok) => { onClose(); if (ok) act(App.del('/api/admin/platform/mirrors/' + encodeURIComponent(m.id)), esc(m.name) + ' removed. Audit event written.'); }); });
      const checkMirrors = (ids) => App.post('/api/admin/platform/mirrors/check', ids ? { mirrorIds: ids } : {}).then(() => { ctx.toast('Probing ' + (ids ? 'the mirror' : 'every mirror') + '. Results appear as they come in.', 'ok'); setTimeout(reload, 1500); setTimeout(reload, 5000); }).catch((err) => App.fail(err));
      ctx.on('click', '[data-check-mirrors]', () => checkMirrors(null));
      ctx.on('click', '[data-check-mirror]', (e, t) => checkMirrors([t.dataset.checkMirror]));
      ctx.on('click', '[data-rotate]', (e, t) => { const name = t.dataset.rotateName; ctx.confirm({ title: 'Rotate ' + name, tag: 're-wraps data keys', tone: 'info', body: '<p class="fg2" style="margin:0">Creates a new data key version. Old versions stay for decryption; nothing is rewritten in place.</p>', ok: 'Rotate' }).then((ok) => { onClose(); if (ok) act(App.post('/api/admin/platform/keys/' + encodeURIComponent(t.dataset.rotate) + '/rotate'), esc(name) + ' rotated. Audit event written.'); }); });
      ctx.on('click', '[data-add-signer]', addSigner);
      ctx.on('click', '[data-revoke-signer]', (e, t) => { const k = d.signers.find((x) => x.id === t.dataset.revokeSigner); if (!k) return; ctx.modal({ title: 'Revoke ' + esc(k.name) + ' ' + UI.pill('destructive', 'danger'), body: '<p class="fg2" style="margin:0">Once a second platform admin approves, bundles signed by this key fail step 2, including verified bundles that have not been promoted yet.</p>' + UI.field('Reason', UI.input('', { attrs: 'data-kreason placeholder="rotated to the 2027 key"' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Revoke', { kind: 'danger', attrs: 'data-kgo' }), onClose, onMount(el) { el.querySelector('[data-kgo]').addEventListener('click', () => { const reason = el.querySelector('[data-kreason]').value.trim(); App.post('/api/admin/platform/signers/' + encodeURIComponent(k.id) + '/revoke', { reason: reason }).then(() => { App.closeOverlay(); ctx.toast('Revoking ' + esc(k.name) + ' is proposed. It takes effect when another platform admin approves it.', 'ok', 6000); reload(); }).catch((err) => App.fail(err, 'The key could not be revoked')); }); } }); });
      const decide = (id, verb, done) => { const p = (d.proposals || []).find((x) => x.id === id); if (!p) return; ctx.confirm({ title: (verb === 'approve' ? 'Approve' : verb === 'reject' ? 'Reject' : 'Withdraw') + ' the proposal to ' + p.action + ' ' + p.name, tone: verb === 'approve' ? 'info' : 'danger', tag: 'dual control', body: '<p class="fg2" style="margin:0">' + (verb === 'approve' ? (p.action === 'add' ? 'Check the fingerprint against the offline key before approving: bundles signed with it will verify.' : 'Bundles signed with this key will fail their signature check.') : verb === 'reject' ? 'The change is not made; the proposer is told in the audit chain.' : 'Your proposal is withdrawn and nothing changes.') + '</p>', kv: [['Key', esc(p.name)], ['Fingerprint', '<span class="mono">' + esc(p.fingerprint || '') + '</span>'], ['Proposed by', esc(p.proposedByName || '')]], ok: verb === 'approve' ? 'Approve' : verb === 'reject' ? 'Reject' : 'Withdraw' }).then((ok) => { onClose(); if (ok) act(App.post('/api/admin/platform/signers/proposals/' + encodeURIComponent(id) + '/' + verb, {}), done); }); };
      ctx.on('click', '[data-approve-signer]', (e, t) => decide(t.dataset.approveSigner, 'approve', 'Approved. The signer key change applies now. Audit event written.'));
      ctx.on('click', '[data-reject-signer]', (e, t) => decide(t.dataset.rejectSigner, 'reject', 'Rejected. Audit event written.'));
      ctx.on('click', '[data-withdraw-signer]', (e, t) => decide(t.dataset.withdrawSigner, 'withdraw', 'Withdrawn. Audit event written.'));
      ctx.on('click', '[data-ack]', () => act(App.post('/api/admin/platform/backups/alert/acknowledge'), 'Alert acknowledged. It clears when the next backup lands.'));
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
