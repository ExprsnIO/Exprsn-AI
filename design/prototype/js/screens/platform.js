(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  const BUNDLES0 = [
    { id: '2026-38-weekly', contents: '412 npm, 96 wheels, 38 images, Trivy DB', signature: 'verified', scan: 'clean', staging: 'passed', state: 'ready to promote', signer: 'platform-import-2026 (cosign, OpenBao)', digest: 'sha256:8c1e…4f0a', size: '6.4 GB', received: '18 Sep 22:10, diode', steps: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', ''] },
    { id: '2026-38-sec-01', contents: 'openssl patch, 3 images', signature: 'verified', scan: 'clean', staging: 'running', state: 'expedited', signer: 'platform-import-2026 (cosign, OpenBao)', digest: 'sha256:1b77…c9d2', size: '412 MB', received: '19 Sep 11:30, media', steps: ['ok', 'ok', 'ok', 'ok', 'ok', 'accent', ''] },
    { id: 'model-qwen2.5-coder', contents: '1 model, 19.9 GB, manifest', signature: 'verified', scan: 'Apache 2.0', staging: 'passed', state: 'in production', signer: 'platform-import-2026 (cosign, OpenBao)', digest: 'sha256:e2a0…77b1', size: '19.9 GB', received: '10 Sep 09:02, diode', steps: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'] },
    { id: '2026-37-weekly-b', contents: 'native modules: kerberos, sharp, re2', signature: 'failed', scan: 'not run', staging: 'not run', state: 'rejected', signer: 'expected platform-import-2026; got unknown key 3f:9a:c1', digest: 'sha256:0d4c…a1e9', size: '188 MB', received: '12 Sep 08:40, media', steps: ['ok', 'danger', '', '', '', '', ''] }
  ];
  const STEPS = ['Transfer received', 'Signature verified against the offline key', 'Digest matched the manifest', 'SBOM and vulnerability scan', 'Licence check', 'Staging deploy (Compose and Helm on kind)', 'Promoted to internal mirrors'];

  const MIRRORS = [
    { name: 'Container images and charts', store: 'Harbor', fresh: '2 days', policy: 'ok', consumer: 'Compose, Kubernetes, sandbox launcher' },
    { name: 'npm', store: 'Verdaccio', fresh: '2 days', policy: 'ok', consumer: 'CI and TypeScript builds' },
    { name: 'Python wheels', store: 'devpi', fresh: '2 days', policy: 'ok', consumer: 'Trainer and image workers' },
    { name: 'Vulnerability databases', store: 'Trivy offline bundle', fresh: '9 days', policy: 'older than 7 days', consumer: 'CI scanners' },
    { name: 'Model weights', store: 'MinIO, content-addressed', fresh: 'on request', policy: 'ok', consumer: 'Inference gateway, workers' },
    { name: 'OS packages', store: 'apt mirror', fresh: '2 days', policy: 'ok', consumer: 'Host builds' },
    { name: 'OpenTofu providers', store: 'internal provider mirror', fresh: '9 days', policy: 'ok', consumer: 'deploy/vpc' }
  ];

  const CERTS = [
    { name: 'ai.northwind.local', issuedTo: 'edge ingress', issuer: 'Exprsn-CA intermediate 2', expires: '8 Oct 2026', days: 19, use: 'TLS' },
    { name: 'inference-gw.app.internal', issuedTo: 'inference gateway', issuer: 'Exprsn-CA intermediate 2', expires: '2 Dec 2026', days: 74, use: 'mTLS' },
    { name: 'ollama-proxy.gpu-large-1', issuedTo: 'node mTLS proxy', issuer: 'Exprsn-CA intermediate 2', expires: '2 Dec 2026', days: 74, use: 'mTLS' },
    { name: 'identity.app.internal', issuedTo: 'identity service', issuer: 'Exprsn-CA intermediate 2', expires: '14 Jan 2027', days: 117, use: 'mTLS' },
    { name: 'ldap-1.directory.internal', issuedTo: 'OpenLDAP', issuer: 'Exprsn-CA intermediate 1', expires: '30 Mar 2027', days: 192, use: 'LDAPS' },
    { name: 'Exprsn-CA intermediate 2', issuedTo: 'issuing CA', issuer: 'Exprsn-CA root (offline)', expires: '1 Jun 2028', days: 620, use: 'CA' }
  ];

  const TRANSIT = [
    { name: 'idp-signing', kind: 'ES256 signing', rotated: '14 Jul 2026', next: '12 Oct 2026', leases: 1 },
    { name: 'tenant-northwind-dek', kind: 'AES-256-GCM envelope', rotated: '1 Sep 2026', next: '1 Dec 2026', leases: 4 },
    { name: 'tenant-contoso-dek', kind: 'AES-256-GCM envelope', rotated: '1 Sep 2026', next: '1 Dec 2026', leases: 1 },
    { name: 'cosign-import', kind: 'ECDSA P-256 verify', rotated: '3 Jan 2026', next: '3 Jan 2027', leases: 0 }
  ];

  const BACKUPS0 = [
    { store: 'Postgres, incl. Temporal', last: 'WAL, 2 min ago', drill: '1 Sep, 3 h 10 min', target: 'RPO 5 min, RTO 4 h', state: 'within target' },
    { store: 'MinIO', last: 'replicated, 14 min lag', drill: '1 Sep', target: 'RPO 1 h', state: 'within target' },
    { store: 'OpenBao', last: 'snapshot 02:00', drill: '1 Sep', target: 'restored first', state: 'within target' },
    { store: 'OpenLDAP and KDC', last: 'LDIF 01:00', drill: '12 Aug', target: 'RPO 24 h', state: 'within target' }
  ];

  App.register({
    id: 'platform', title: 'Platform', section: 'admin', summary: 'Import bundles and signatures, mirrors, certificates, secrets health, backups and restore drills',
    commands: [
      { label: 'Start an expedited import', sub: 'Platform', run(app) { app.stateFor('platform').openExpedited = true; app.render(); } },
      { label: 'Run a restore drill', sub: 'Platform', run(app) { app.stateFor('platform').openDrill = true; app.render(); } }
    ],
    states: [
      { title: 'Signature failed', tone: 'danger', text: 'The bundle is quarantined and cannot be promoted. Shows the expected and actual signer.', apply(ctx) { ctx.state.tab = 'imports'; ctx.state.sel = '2026-37-weekly-b'; ctx.rerender(); } },
      { title: 'Stale vulnerability data', tone: 'warn', text: 'CI scans are marked as unreliable until a fresh database bundle is imported.', apply(ctx) { ctx.state.tab = 'mirrors'; ctx.state.stale = true; ctx.rerender(); } },
      { title: 'Backup target missed', tone: 'danger', text: 'A store past its RPO raises a platform alert and appears first in this table.', apply(ctx) { ctx.state.tab = 'backups'; ctx.state.missed = true; ctx.rerender(); } },
      { title: 'No outbound links', tone: 'neutral', text: 'Every reference resolves to an internal mirror or document. Nothing opens the internet.', apply(ctx) { ctx.state.tab = 'mirrors'; ctx.state.showLinks = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'imports'; st.sel = st.sel || '2026-38-weekly'; st.bundles = st.bundles || BUNDLES0.map((b) => Object.assign({}, b, { steps: b.steps.slice() })); st.backups = st.backups || BACKUPS0.map((b) => Object.assign({}, b)); st.q = st.q || '';
      if (ctx.params.tab) st.tab = ctx.params.tab;
      if (ctx.params.bundle) { st.sel = ctx.params.bundle; st.tab = 'imports'; }
      const bundle = st.bundles.find((b) => b.id === st.sel) || st.bundles[0];
      const pillFor = (t) => UI.pill(t, /verified|clean|passed|in production|ok|within target|restored/.test(t) ? 'ok' : /failed|rejected|missed|quarantined/.test(t) ? 'danger' : /running|expedited|verifying|awaiting|promoting/.test(t) ? 'info' : /ready/.test(t) ? 'accent' : /older|stale|unreliable/.test(t) ? 'warn' : '');

      // ----- header strip -----
      const strip = '<div class="stats">' + UI.stat('Exprsn-CA', 'Internal CA', '214 certificates, next expiry in 19 days' + (st.certRenewed ? ', renewed today' : '')) + UI.stat('OpenBao ' + UI.pill('unsealed', 'ok'), 'Secrets', '3 of 5 custodians on record') + UI.stat('0.2 s', 'NTP', 'skew across zones') + UI.stat(st.bundles.filter((b) => b.state === 'ready to promote').length + ' ready', 'Import bundles', st.bundles.filter((b) => b.state === 'rejected').length + ' rejected, ' + st.bundles.filter((b) => b.state === 'expedited').length + ' expedited') + '</div>';

      const tabs = UI.tabs([{ id: 'imports', label: 'Import bundles', count: st.bundles.length }, { id: 'mirrors', label: 'Mirrors', count: MIRRORS.length }, { id: 'certs', label: 'Certificates' }, { id: 'secrets', label: 'Secrets health' }, { id: 'backups', label: 'Backups' }], st.tab);

      let body = '';
      if (st.tab === 'imports') {
        const rows = st.bundles.filter((b) => !st.q || (b.id + ' ' + b.contents + ' ' + b.state).toLowerCase().includes(st.q.toLowerCase()));
        body = '<div class="hstack wrap">' + UI.search('Search bundles', 'data-q', st.q) + '<span class="muted" style="font-size:12px">Weekly bundles for dependencies and databases; models on request; an expedited path for security patches.</span></div>'
          + UI.table(['Bundle', 'Contents', 'Signature', 'Scan and licence', 'Staging', 'State', ''], rows.map((b) => ({ cells: ['<b class="mono">' + esc(b.id) + '</b>', esc(b.contents), pillFor(b.signature), pillFor(b.scan), pillFor(b.staging), pillFor(b.state), b.state === 'ready to promote' ? UI.btn('Promote', { size: 'xs', kind: 'primary', attrs: 'data-promote="' + esc(b.id) + '"' }) : b.state === 'rejected' ? UI.pill('quarantined', 'danger') : ''], attrs: 'data-bundle="' + esc(b.id) + '"', selected: b.id === bundle.id })), { minWidth: '760px', emptyTitle: 'No bundles match', emptyText: 'Clear the search.' })
          + UI.notice('Nothing inside the deployment reaches the internet. Every artifact enters through this path and is verified against a signature and digest before any service can use it.', 'info');
      } else if (st.tab === 'mirrors') {
        body = (st.stale ? UI.notice('<b>Stale vulnerability data.</b> The Trivy bundle is 9 days old. CI scans since 17 Sep are marked unreliable until a fresh database bundle is imported; 2026-38-weekly carries one.', 'warn', UI.btn('Promote 2026-38-weekly', { size: 'sm', attrs: 'data-promote="2026-38-weekly"' })) : '')
          + (st.showLinks ? UI.notice('<b>No outbound links.</b> Every reference on this page resolves to an internal mirror or document; nothing opens the internet.', 'info') : '')
          + UI.table(['Mirror', 'Store', 'Freshness', 'Policy', 'Consumer'].concat(st.showLinks ? ['Resolves to'] : []), MIRRORS.map((m) => ['<b>' + esc(m.name) + '</b>', esc(m.store), esc(st.mirrorRefreshed && m.store.indexOf('Trivy') === 0 ? 'today' : m.fresh), st.mirrorRefreshed && m.store.indexOf('Trivy') === 0 ? pillFor('ok') : pillFor(m.policy), esc(m.consumer)].concat(st.showLinks ? ['<span class="mono">' + esc(m.store.split(',')[0].toLowerCase().replace(/ /g, '-') + '.data.internal') + '</span>'] : [])), { clickable: false, minWidth: '700px' })
          + '<div class="muted" style="font-size:12px">Policy: dependency and database mirrors older than 7 days are flagged. Model weights are content-addressed by sha256 and never expire.</div>';
      } else if (st.tab === 'certs') {
        const soon = CERTS.filter((c) => c.days <= 30 && !st.certRenewed);
        body = (soon.length ? UI.notice('<b>' + soon.length + ' certificate expires in ' + soon[0].days + ' days.</b> ' + esc(soon[0].name) + ' is renewed through the internal ACME endpoint; public ACME is unreachable.', 'warn', UI.btn('Renew via ACME', { size: 'sm', attrs: 'data-renew="' + esc(soon[0].name) + '"' })) : UI.notice('No certificate expires within 30 days.', 'ok'))
          + UI.table(['Certificate', 'Issued to', 'Issuer', 'Expires', 'Use', 'State', ''], CERTS.map((c) => { const renewed = st.certRenewed && c.days <= 30; const days = renewed ? 365 : c.days; return ['<span class="mono">' + esc(c.name) + '</span>', esc(c.issuedTo), esc(c.issuer), renewed ? '19 Sep 2027' : esc(c.expires), esc(c.use), days <= 30 ? UI.pill('expires in ' + days + ' days', 'warn') : UI.pill('valid, ' + days + ' days', 'ok'), c.use === 'CA' ? '' : UI.btn('Renew', { size: 'xs', kind: 'ghost', attrs: 'data-renew="' + esc(c.name) + '"' })]; }), { clickable: false, minWidth: '760px' })
          + '<div class="grid2">' + UI.panel('Internal CA', UI.kv([['Issuer', 'Exprsn-CA, ACME at ca.directory.internal'], ['Root', 'offline, HSM-held'], ['mTLS', 'every service pair, 90 day leaf certificates'], ['Kubernetes', 'cert-manager with the Exprsn-CA issuer'], ['Compose', 'renewed by the deploy tooling before expiry']], 1)) + UI.panel('Why it matters', '<div class="fg2">Kerberos, TOTP and certificate validation all depend on clocks. NTP skew is 0.2 s across zones; the check fails at 5 s.</div><div>' + UI.btn('Open zones', { size: 'sm', kind: 'ghost', attrs: 'data-go="zones"' }) + '</div>') + '</div>';
      } else if (st.tab === 'secrets') {
        body = '<div class="grid3">' + UI.stat(UI.pill('unsealed', 'ok'), 'OpenBao seal', 'auto-unseal by 3 of 5 custodians at 02:04') + UI.stat('3 of 5', 'Custodians on record', 'quorum for unseal and root rotation') + UI.stat('0', 'Secrets on disk in app zone', 'checked by CI on every merge') + '</div>'
          + '<div class="eyebrow">Transit keys</div>' + UI.table(['Key', 'Kind', 'Last rotated', 'Next rotation', { label: 'Active leases', right: true }, ''], TRANSIT.map((k) => ['<span class="mono">' + esc(k.name) + '</span>', esc(k.kind), esc(st.rotated && st.rotated[k.name] ? 'today' : k.rotated), esc(st.rotated && st.rotated[k.name] ? 'in 90 days' : k.next), k.leases, UI.btn('Rotate', { size: 'xs', kind: 'ghost', attrs: 'data-rotate="' + esc(k.name) + '"' })]), { clickable: false, minWidth: '640px' })
          + '<div class="grid2">' + UI.panel('Health checks', UI.kv([['Seal status', UI.pill('unsealed', 'ok')], ['Audit device', UI.pill('enabled', 'ok') + ' file and exprsn.events'], ['Snapshot', 'daily 02:00, restored first in every drill'], ['Root token', 'revoked; regenerated only with quorum'], ['Secrets in env vars', UI.pill('none', 'ok') + ' mounted as files']], 1)) + UI.panel('Where keys are used', '<div class="fg2">IdP signing keys and per-tenant data-encryption keys never leave transit. Deleting a tenant key crypto-shreds that tenant.</div><div class="hstack gap6">' + UI.btn('Open identity keys', { size: 'sm', attrs: 'data-go="identity"' }) + UI.btn('Open tenants', { size: 'sm', kind: 'ghost', attrs: 'data-go="tenants"' }) + '</div>') + '</div>';
      } else {
        let rows = st.backups.slice();
        if (st.missed) { rows = rows.map((b) => b.store === 'MinIO' ? Object.assign({}, b, { last: 'replicated, 2 h 14 min lag', state: 'RPO missed' }) : b); rows.sort((a, b) => (b.state === 'RPO missed') - (a.state === 'RPO missed')); }
        body = (st.missed ? UI.notice('<b>Backup target missed.</b> MinIO replication lag is 2 h 14 min against an RPO of 1 h. A platform alert was raised at 13:58 and the store is listed first.', 'danger', UI.btn('Acknowledge', { size: 'sm', attrs: 'data-ack' })) : '')
          + UI.table(['Store', 'Last backup', 'Last restore drill', 'Target', 'State'], rows.map((b) => ['<b>' + esc(b.store) + '</b>', esc(b.last), esc(b.drill), esc(b.target), pillFor(b.state)]), { clickable: false, minWidth: '640px' })
          + UI.panel('Restore drill', (st.drill ? UI.timeline(st.drill.map((d) => ({ title: d.title, text: d.text, meta: d.meta, tone: d.tone }))) : '<div class="fg2">A drill restores every store into an isolated namespace, in order: OpenBao first, then Postgres to a point in time, MinIO, then LDAP and the KDC. Measured times are compared with the RTO.</div>') + '<div>' + UI.btn(st.drilling ? 'Drill running' : 'Run restore drill', { size: 'sm', kind: 'primary', icon: 'play', attrs: 'data-drill', disabled: !!st.drilling }) + '</div>');
      }

      // ----- inspector: selected bundle -----
      const v = st.verifying && st.verifying.id === bundle.id ? st.verifying : null;
      const steps = STEPS.map((s, i) => { const tone = v ? (i < v.step ? 'ok' : i === v.step ? 'accent' : '') : bundle.steps[i]; return { title: s, tone: tone, meta: tone === 'ok' ? 'passed' : tone === 'danger' ? 'failed' : tone === 'accent' ? 'running' : 'waiting', text: i === 1 && bundle.signature === 'failed' && !v ? 'Expected ' + esc(bundle.signer.split(';')[0].replace('expected ', '')) + '. Got ' + esc(bundle.signer.split('; got ')[1] || 'unknown key') + '.' : i === 6 && bundle.state === 'ready to promote' ? 'Waiting for a platform admin.' : '' }; });
      const insp = '<div class="eyebrow">Import bundle</div><div style="font-size:15px;font-weight:600" class="mono">' + esc(bundle.id) + '</div><div>' + pillFor(bundle.state) + '</div>'
        + (bundle.signature === 'failed' ? UI.notice('<b>Signature failed.</b> The bundle is quarantined and cannot be promoted or staged. Expected signer <span class="mono">platform-import-2026</span>; actual signer <span class="mono">unknown key 3f:9a:c1</span>.', 'danger') : '')
        + UI.kv([['Contents', esc(bundle.contents)], ['Size', esc(bundle.size)], ['Received', esc(bundle.received)], ['Digest', '<span class="mono">' + esc(bundle.digest) + '</span>'], ['Signer', esc(bundle.signer)], ['Scan and licence', pillFor(bundle.scan)]], 1)
        + '<div class="eyebrow">Verification</div>' + UI.timeline(steps)
        + '<div class="vstack gap6">' + UI.btn(v ? 'Verifying' : 'Verify bundle', { size: 'sm', icon: 'refresh', attrs: 'data-verify', disabled: !!v }) + (bundle.state === 'ready to promote' ? UI.btn('Promote', { size: 'sm', kind: 'primary', attrs: 'data-promote="' + esc(bundle.id) + '"' }) : '') + (bundle.id.indexOf('model-') === 0 ? UI.btn('Open model', { size: 'sm', kind: 'ghost', attrs: 'data-go="models"' }) : '') + (bundle.signature === 'failed' ? UI.btn('Delete quarantined bundle', { size: 'sm', kind: 'danger', attrs: 'data-delete' }) : '') + '</div>';

      root.innerHTML = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}</style><div class="page">' + UI.pagehead('Imports and platform', 'Everything that runs here arrived through one signed import path', UI.btn('Run restore drill', { attrs: 'data-drill' }) + UI.btn('Start expedited import', { kind: 'primary', attrs: 'data-expedited' }))
        + strip + tabs + body
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
        + '<aside class="inspector">' + insp + '</aside>';

      // ----- actions -----
      function verify() {
        if (st.verifying) return;
        st.verifying = { id: bundle.id, step: 0 }; ctx.rerender();
        const failAt = bundle.signature === 'failed' ? 1 : -1;
        const tick = () => {
          const cur = st.verifying; if (!cur) return;
          if (cur.step === failAt) { const b = st.bundles.find((x) => x.id === cur.id); b.steps = ['ok', 'danger', '', '', '', '', '']; st.verifying = null; ctx.rerender(); ctx.toast('<b>Signature failed</b> for ' + esc(cur.id) + '. Quarantined; expected platform-import-2026.', 'danger', 6000); return; }
          if (cur.step >= 5) { const b = st.bundles.find((x) => x.id === cur.id); b.steps = ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', b.state === 'in production' ? 'ok' : '']; if (b.state === 'expedited') { b.staging = 'passed'; b.state = 'ready to promote'; } st.verifying = null; ctx.rerender(); ctx.toast(esc(cur.id) + ' verified: signature, digest, scan, licence and staging all passed.', 'ok', 5000); return; }
          cur.step += 1; ctx.rerender(); setTimeout(tick, 550);
        };
        setTimeout(tick, 550);
      }
      function promote(id) {
        const b = st.bundles.find((x) => x.id === id); if (!b) return;
        ctx.confirm({ title: 'Promote ' + esc(id), tag: 'changes mirrors', tone: 'info', body: '<p class="fg2" style="margin:0">Copies the verified artifacts into Harbor, Verdaccio, devpi and the Trivy mirror. Consumers pick them up on their next build or pull.</p>', kv: [['Contents', esc(b.contents)], ['Signer', 'platform-import-2026']], ok: 'Promote' }).then((ok) => { if (!ok) return; b.state = 'promoting'; ctx.rerender(); setTimeout(() => { b.state = 'in production'; b.steps[6] = 'ok'; if (id === '2026-38-weekly') { st.mirrorRefreshed = true; st.stale = false; } ctx.rerender(); ctx.toast(esc(id) + ' promoted. Mirrors refreshed; audit event written.', 'ok', 5000); }, 1200); });
      }
      function expedited() {
        ctx.modal({ title: 'Start expedited import ' + UI.pill('security patch', 'warn'),
          body: '<div class="formgrid">' + UI.field('Bundle ID', UI.input('2026-38-sec-02', { attrs: 'data-xid' })) + UI.field('Transfer', UI.select(['diode', 'removable media'], 'diode')) + UI.field('Contents', UI.input('', { attrs: 'data-xc placeholder="e.g. glibc patch, 2 images"' })) + UI.field('Security ticket', UI.input('SEC-', { placeholder: 'SEC-1234' })) + '</div>' + UI.notice('Expedited bundles skip the weekly cadence, not the checks. Signature, digest, scan and staging still run; the target from vendor fix to deployment is agreed with the security team.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Start import', { kind: 'primary', attrs: 'data-xgo' }),
          onMount(m) { m.querySelector('[data-xgo]').addEventListener('click', () => { const id = m.querySelector('[data-xid]').value.trim() || '2026-38-sec-02'; App.closeOverlay(); st.bundles.splice(1, 0, { id: id, contents: m.querySelector('[data-xc]').value.trim() || 'awaiting manifest', signature: 'awaiting transfer', scan: 'not run', staging: 'not run', state: 'expedited', signer: 'platform-import-2026 (cosign, OpenBao)', digest: 'pending', size: 'pending', received: 'awaiting transfer', steps: ['accent', '', '', '', '', '', ''] }); st.sel = id; st.tab = 'imports'; ctx.rerender(); ctx.toast('Expedited import ' + esc(id) + ' started. Waiting for the transfer.', 'ok'); }); }
        });
      }
      function drill() {
        ctx.confirm({ title: 'Run restore drill', tag: 'isolated', tone: 'info', body: '<p class="fg2" style="margin:0">Restores every store into the drill namespace and measures each step against its target. Production is untouched.</p>', kv: [['Order', 'OpenBao, Postgres, MinIO, LDAP and KDC'], ['Last drill', '1 Sep, 3 h 10 min']], ok: 'Start drill' }).then((ok) => {
          if (!ok) return;
          const plan = [['OpenBao snapshot restored and unsealed', '2 min 40 s'], ['Postgres PITR to 14:00, incl. Temporal', '2 h 48 min'], ['MinIO bucket replication verified by digest', '12 min'], ['OpenLDAP LDIF and KDC database restored', '4 min'], ['Smoke test: sign-in, chat, retrieval', '1 min 30 s']];
          st.tab = 'backups'; st.drilling = true; st.drill = plan.map((p, i) => ({ title: p[0], tone: i === 0 ? 'accent' : '', meta: i === 0 ? 'running' : 'waiting' })); ctx.rerender();
          let i = 0; const tick = () => { st.drill[i].tone = 'ok'; st.drill[i].meta = plan[i][1]; i += 1; if (i < plan.length) { st.drill[i].tone = 'accent'; st.drill[i].meta = 'running'; ctx.rerender(); setTimeout(tick, 600); } else { st.drilling = false; st.backups.forEach((b) => { b.drill = 'today, ' + (b.store.indexOf('Postgres') === 0 ? '3 h 8 min' : b.store === 'MinIO' ? '12 min' : b.store === 'OpenBao' ? '2 min 40 s' : '4 min'); }); ctx.rerender(); ctx.toast('Restore drill finished in 3 h 8 min against an RTO of 4 h. Results recorded.', 'ok', 6000); } };
          setTimeout(tick, 600);
        });
      }
      if (st.openExpedited) { st.openExpedited = false; setTimeout(expedited, 50); }
      if (st.openDrill) { st.openDrill = false; setTimeout(drill, 50); }

      // ----- handlers -----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', 'tr[data-bundle]', (e, t) => { if (e.target.closest('[data-promote]')) return; st.sel = t.dataset.bundle; ctx.rerender(); });
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; const val = t.value; ctx.rerender(); const i = ctx.$('[data-q]'); if (i) { i.focus(); i.setSelectionRange(val.length, val.length); } });
      ctx.on('click', '[data-verify]', verify);
      ctx.on('click', '[data-promote]', (e, t) => { e.stopPropagation(); promote(t.dataset.promote); });
      ctx.on('click', '[data-expedited]', expedited);
      ctx.on('click', '[data-drill]', drill);
      ctx.on('click', '[data-delete]', () => ctx.confirm({ title: 'Delete quarantined bundle', tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">Removes the transferred files. The rejection and both signer fingerprints stay in the audit chain.</p>', kv: [['Bundle', esc(bundle.id)]], ok: 'Delete' }).then((ok) => { if (!ok) return; st.bundles = st.bundles.filter((b) => b.id !== bundle.id); st.sel = st.bundles[0].id; ctx.rerender(); ctx.toast('Quarantined bundle deleted. Audit event written.', 'ok'); }));
      ctx.on('click', '[data-renew]', (e, t) => ctx.confirm({ title: 'Renew ' + esc(t.dataset.renew), tone: 'info', body: '<p class="fg2" style="margin:0">Requests a new leaf certificate from Exprsn-CA over internal ACME and reloads the listener. No downtime; the old certificate stays valid until it expires.</p>', ok: 'Renew' }).then((ok) => { if (!ok) return; st.certRenewed = true; ctx.rerender(); ctx.toast(esc(t.dataset.renew) + ' renewed until 19 Sep 2027.', 'ok'); }));
      ctx.on('click', '[data-rotate]', (e, t) => ctx.confirm({ title: 'Rotate ' + esc(t.dataset.rotate), tag: t.dataset.rotate.indexOf('dek') > 0 ? 're-wraps data keys' : 'publishes new key', tone: 'info', body: '<p class="fg2" style="margin:0">Creates a new key version in transit. Old versions stay for decryption and verification; nothing is rewritten in place.</p>', ok: 'Rotate' }).then((ok) => { if (!ok) return; st.rotated = st.rotated || {}; st.rotated[t.dataset.rotate] = true; ctx.rerender(); ctx.toast(esc(t.dataset.rotate) + ' rotated. Audit event written.', 'ok'); }));
      ctx.on('click', '[data-ack]', () => { st.missed = false; ctx.rerender(); ctx.toast('Alert acknowledged. MinIO replication is catching up.', 'ok'); });
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
