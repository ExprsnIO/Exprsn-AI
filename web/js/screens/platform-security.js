// Platform › Security scans and Vault seal (1.8.0, Sprint 48: B-144 and B-145). Two tabs the Platform screen
// (platform.js) shows through App.platformSecurity.render(tab, ctx, st), and the gate outcome the Apps promotion
// dialog shows through App.securityGate.preview(...).
//
// - Security scans: the tenant's gate policy, the results attached to app packages, plugin bundles and script runner
//   images by digest (upload a Trivy JSON, SARIF or CycloneDX report), a result's findings, the exceptions with their
//   dual control, and a check of what the gate would decide for a digest. GET/PUT /api/admin/security/...
// - Vault seal: whether a seal can be undone (an escrow of the running key), "Seal the vault" as a proposal a second
//   platform admin approves, and a link to the unseal page. /api/admin/platform/vault/seal...
//
// Nothing here decides anything: every refusal, threshold and dual-control check is the server's.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const CSS = '<style>#main .psec-actions{display:flex;flex-wrap:wrap;gap:6px}#main .psec-sev{display:inline-flex;gap:4px;flex-wrap:wrap}#main .psec-wrap{overflow-wrap:anywhere}#main .psec-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}</style>';
  const KINDS = [{ value: 'app-package', label: 'App package' }, { value: 'plugin-bundle', label: 'Plugin bundle' }, { value: 'script-image', label: 'Script runner image' }];
  const KIND_WORD = { 'app-package': 'App package', 'plugin-bundle': 'Plugin bundle', 'script-image': 'Script image' };
  const SEV_TONE = { critical: 'danger', high: 'warn', medium: 'info', low: 'outline', unknown: 'outline' };
  const OUT_TONE = { pass: 'ok', warn: 'warn', block: 'danger' };
  const OUT_WORD = { pass: 'passes', warn: 'passes with a warning', block: 'refused' };
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Something went wrong.';
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || null;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const short = (d) => (d ? d.slice(0, 15) + '…' + d.slice(-6) : '');

  // ---------- step-up (B-106): the policy, approving an exception, and proposing or approving a seal need a recent sign-in ----------
  const CANCELLED = Symbol('cancelled');
  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">This change needs a fresh check of who you are. ' + (pw && totp ? 'Enter your password or a code from your authenticator.' : pw ? 'Enter your password.' : totp ? 'Enter a code from your authenticator.' : 'Sign out and sign in again.') + '</div>'
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
  /** Runs `fn`; when the server asks for step-up, confirms the user and runs it once more. CANCELLED when they cancel. */
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) return CANCELLED;
      return fn();
    }
  };
  const sevPills = (b) => '<span class="psec-sev">' + ['critical', 'high', 'medium', 'low'].map((k) => UI.pill((b && b[k]) || 0, (b && b[k]) ? SEV_TONE[k] : 'outline') + '<span class="muted" style="font-size:11px">' + k + '</span>').join(' ') + '</span>';
  const limitText = (v) => (v == null ? 'no limit' : String(v));

  // ---------------- the gate outcome (also on the promotion dialog) ----------------

  function gateHtml(g) {
    if (!g) return '';
    const head = '<b>Security gate: ' + esc(OUT_WORD[g.outcome] || g.outcome) + '.</b> ';
    const lines = (g.reasons || []).concat(g.warnings || []).map(esc).join(' ');
    const results = (g.results || []).length ? '<div class="muted" style="font-size:12px">Results counted: ' + g.results.map((r) => esc(r.format) + (r.stale ? ' (stale)' : '') + ' from ' + esc(day(r.scannedAt))).join(', ') + '</div>' : '';
    const blocking = (g.blocking || []).length ? UI.table(['Finding', 'Package', 'Why'], g.blocking.slice(0, 20).map((f) => ['<span class="mono psec-wrap">' + esc(f.id) + '</span>', esc((f.package || '') + (f.version ? ' ' + f.version : '')), esc(f.reason)]), { clickable: false, minWidth: '0', attrs: 'aria-label="Blocking findings"' }) + (g.blocking.length > 20 ? '<div class="muted" style="font-size:12px">and ' + (g.blocking.length - 20) + ' more</div>' : '') : '';
    const excepted = (g.excepted || []).length ? '<div class="muted" style="font-size:12px">' + g.excepted.length + ' finding' + (g.excepted.length === 1 ? '' : 's') + ' accepted by an exception.</div>' : '';
    return '<div class="vstack gap6" data-gate-outcome="' + esc(g.outcome) + '">' + UI.notice(head + lines, OUT_TONE[g.outcome] === 'ok' ? 'ok' : OUT_TONE[g.outcome] === 'danger' ? 'danger' : 'warn') + results + blocking + excepted + '</div>';
  }

  App.securityGate = {
    html: gateHtml,
    /** The gate for a pipeline's next promotion (`to`), or for a chosen package of the development app. */
    preview(pipelineId, to, packageId) {
      return App.get('/api/admin/security/gate/pipelines/' + enc(pipelineId) + '?to=' + enc(to) + (packageId ? '&package=' + enc(packageId) : '')).then(gateHtml, (err) => UI.notice('The security gate could not be checked: ' + esc(detailOf(err)), 'warn'));
    }
  };

  // ---------------- Security scans ----------------

  function loadScans(ctx, st) {
    if (st.scans && st.scans.loading) return;
    st.scans = Object.assign(st.scans || {}, { loading: true });
    Promise.all([App.get('/api/admin/security/policy'), App.get('/api/admin/security/scans'), App.get('/api/admin/security/exceptions')])
      .then((r) => { st.scans = { loaded: true, policy: r[0], results: r[1].results, kinds: r[1].kinds, exceptions: r[2].exceptions }; })
      .catch((err) => { st.scans = { loaded: true, error: err }; })
      .then(() => { if (App.state.route === 'platform' && !document.getElementById('overlay')) ctx.rerender(); });
  }

  function renderScans(ctx, st) {
    const d = st.scans;
    if (!d || (!d.loaded && !d.error)) { loadScans(ctx, st); return '<p class="muted">Loading the security scans…</p>'; }
    if (d.error) {
      ctx.on('click', '[data-scan-retry]', () => { st.scans = null; ctx.rerender(); });
      return UI.problem('The security scans could not be loaded', detailOf(d.error), traceOf(d.error)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-scan-retry' }) + '</div>';
    }
    const p = d.policy;
    const manage = App.can('platform:manage');
    const me = App.me && App.me.user && App.me.user.id;
    const reload = () => { st.scans = null; ctx.rerender(); };
    const trivy = (p.trivyMirrors || []).map((m) => esc(m.name) + ': ' + (m.lastPromotedAt ? 'promoted ' + esc(day(m.lastPromotedAt)) : 'never promoted')).join('; ');
    const policy = UI.panel('Gate policy', UI.kv([
      ['Critical findings allowed', esc(limitText(p.maxCritical))],
      ['High findings allowed', esc(limitText(p.maxHigh))],
      ['Newest result at most', p.maxAgeDays == null ? 'any age' : esc(p.maxAgeDays) + ' days old'],
      ['Without a result', p.missing === 'refuse' ? UI.pill('refused', 'danger') : UI.pill('allowed with a warning', 'warn')],
      ['Denied licences', p.licenceDeny.length ? p.licenceDeny.map((l) => '<span class="mono">' + esc(l) + '</span>').join(', ') : '<span class="muted">none</span>'],
      ['Vulnerability database', trivy || '<span class="muted">no Trivy mirror registered</span>']
    ], 1) + '<div class="muted" style="font-size:12px">The gate runs when a pipeline promotes a package to test or production (and again when the deployment runs), when a plugin bundle is enabled or upgraded, and when a SCRIPT_IMAGE_* setting is proposed and approved. Without a result the default is to allow with a warning, so flows that worked before scans existed keep working; turn it to "refused" once a CI hook uploads results. Audited security.gate.passed, security.gate.warned and security.gate.blocked.</div>'
      + (manage ? '<div class="psec-actions">' + UI.btn('Edit policy', { size: 'sm', attrs: 'data-scan-policy' }) + '</div>' : ''));

    const rows = d.results.map((r) => ({ cells: [UI.pill(KIND_WORD[r.kind] || r.kind, 'outline') + '<div class="psec-wrap">' + esc(r.name || r.ref || '') + '</div>', '<span class="mono" title="' + esc(r.digest) + '">' + esc(short(r.digest)) + '</span>', esc(r.format) + (r.tool ? '<div class="muted" style="font-size:11px">' + esc(r.tool + (r.toolVersion ? ' ' + r.toolVersion : '')) + '</div>' : ''), sevPills(r.summary.bySeverity) + (r.summary.licences.length ? '<div class="muted psec-wrap" style="font-size:11px">' + esc(r.summary.licences.slice(0, 4).join(', ')) + (r.summary.licences.length > 4 ? '…' : '') + '</div>' : ''), esc(day(r.scannedAt)), '<div class="psec-actions">' + UI.btn('Findings', { size: 'xs', kind: 'ghost', attrs: 'data-scan-view="' + esc(r.id) + '"' }) + (manage ? UI.btn('Delete', { size: 'xs', kind: 'ghost', attrs: 'data-scan-del="' + esc(r.id) + '"' }) : '') + '</div>'], attrs: 'data-scan-row="' + esc(r.id) + '"' }));
    const results = UI.panel('Scan results', UI.table(['Artefact', 'Digest', 'Format', 'Findings', 'Scanned', ''], rows, { clickable: false, minWidth: '820px', emptyTitle: 'No scan results yet', emptyText: 'Upload a Trivy JSON, SARIF or CycloneDX report for an app package, a plugin bundle or a script image digest. A CI hook uploads with an API key: PUT /api/admin/security/scans/upload?kind=…&digest=sha256:….' })
      + '<div class="psec-actions">' + UI.btn('Upload a report', { kind: 'primary', size: 'sm', icon: 'upload', attrs: 'data-scan-upload' }) + UI.btn('Check the gate', { size: 'sm', attrs: 'data-scan-gate' }) + '</div>');

    const exRows = d.exceptions.map((x) => ({ cells: ['<span class="mono psec-wrap">' + esc(x.findingId) + '</span>' + (x.package ? '<div class="muted" style="font-size:11px">' + esc(x.package) + '</div>' : ''), esc(x.kind ? KIND_WORD[x.kind] : 'every kind') + (x.digest ? '<div class="mono muted" style="font-size:11px">' + esc(short(x.digest)) + '</div>' : ''), '<span class="psec-wrap">' + esc(x.reason) + '</span>', esc(day(x.expiresAt)) + (x.expired ? ' ' + UI.pill('expired', 'warn') : ''), UI.pill(x.state, x.state === 'active' ? 'ok' : x.state === 'pending' ? 'info' : 'outline'), esc(x.requestedByName || '') + (x.state === 'active' ? '<div class="muted" style="font-size:11px">accepted by ' + esc(x.decidedByName || '') + '</div>' : ''), '<div class="psec-actions">' + (x.state === 'pending' && x.requestedBy === me ? UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-ex-withdraw="' + esc(x.id) + '"' }) : '') + (x.state === 'pending' && x.requestedBy !== me && manage ? UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-ex-approve="' + esc(x.id) + '"' }) + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-ex-reject="' + esc(x.id) + '"' }) : '') + (x.state === 'active' && manage ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-ex-revoke="' + esc(x.id) + '"' }) : '') + '</div>'] }));
    const pending = d.exceptions.filter((x) => x.state === 'pending').length;
    const exceptions = UI.panel('Exceptions', (pending ? UI.notice(pending + (pending === 1 ? ' exception waits' : ' exceptions wait') + ' for a second platform admin. An exception counts only once someone other than its requester approves it, and only until it expires.', 'warn') : '')
      + UI.table(['Finding', 'Applies to', 'Reason', 'Expires', 'State', 'Who', ''], exRows, { clickable: false, minWidth: '900px', emptyTitle: 'No exceptions', emptyText: 'Request one from a result\'s findings: a finding accepted for a reason, until a date, approved by a second platform admin.' }));

    // ----- handlers -----
    ctx.on('click', '[data-scan-policy]', () => ctx.modal({
      title: 'Edit the gate policy',
      body: '<div class="formgrid">' + UI.field('Critical findings allowed', UI.input(p.maxCritical == null ? '' : String(p.maxCritical), { type: 'number', placeholder: 'no limit', attrs: 'data-pp-crit min="0"' }), 'More than this many refuses a promotion. Empty: no limit.')
        + UI.field('High findings allowed', UI.input(p.maxHigh == null ? '' : String(p.maxHigh), { type: 'number', placeholder: 'no limit', attrs: 'data-pp-high min="0"' }))
        + UI.field('Newest result at most (days)', UI.input(p.maxAgeDays == null ? '' : String(p.maxAgeDays), { type: 'number', placeholder: 'any age', attrs: 'data-pp-age min="1"' }), 'Older results do not count; with none left the gate refuses.')
        + UI.field('Without a result', UI.select([{ value: 'warn', label: 'Allow with a warning' }, { value: 'refuse', label: 'Refuse' }], p.missing, 'data-pp-missing'))
        + '<div class="span2">' + UI.field('Denied licences (SPDX ids, comma-separated)', UI.input(p.licenceDeny.join(', '), { placeholder: 'AGPL-3.0-only, SSPL-1.0', attrs: 'data-pp-deny' })) + '</div></div><div data-pp-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save policy', { kind: 'primary', attrs: 'data-pp-ok' }),
      onMount(m) {
        const num = (sel) => { const v = m.querySelector(sel).value.trim(); return v === '' ? null : Number(v); };
        m.querySelector('[data-pp-ok]').addEventListener('click', async () => {
          const body = { maxCritical: num('[data-pp-crit]'), maxHigh: num('[data-pp-high]'), maxAgeDays: num('[data-pp-age]'), missing: m.querySelector('[data-pp-missing]').value, licenceDeny: m.querySelector('[data-pp-deny]').value.split(',').map((x) => x.trim()).filter(Boolean) };
          try { if ((await withStepUp(ctx, () => App.put('/api/admin/security/policy', body))) === CANCELLED) return; App.closeOverlay(); ctx.toast('Policy saved. Audit event security.scan.policy.updated written.', 'ok'); reload(); } catch (err) { m.querySelector('[data-pp-err]').innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
        });
      }
    }));

    ctx.on('click', '[data-scan-upload]', () => ctx.modal({
      title: 'Upload a scan report',
      cls: 'wide',
      body: UI.notice('The report is read here and normalised to findings (severity, id, package, version, fixed version, licence, path). It applies only to the artefact with exactly this digest. Trivy reports for images carry their digest; for an app package the digest is sha256: and the package hash shown on Apps › Deployments.', 'info')
        + '<div class="formgrid">' + UI.field('Artefact', UI.select(KINDS.filter((k) => d.kinds.includes(k.value)), d.kinds[0] || 'app-package', 'data-up-kind'))
        + UI.field('Format', UI.select([{ value: '', label: 'Detect from the report' }, { value: 'trivy', label: 'Trivy JSON' }, { value: 'sarif', label: 'SARIF 2.1.0' }, { value: 'cyclonedx', label: 'CycloneDX JSON' }], '', 'data-up-format'))
        + '<div class="span2">' + UI.field('Digest', UI.input('', { placeholder: 'sha256:…', attrs: 'data-up-digest spellcheck="false"' }), 'Optional when the report names it (Trivy image scans).') + '</div>'
        + '<div class="span2">' + UI.field('Reference (optional)', UI.input('', { placeholder: 'an image reference or plugin key', attrs: 'data-up-ref' })) + '</div>'
        + '<div class="span2">' + UI.field('Report file', '<input type="file" class="input" accept=".json,.sarif,application/json" data-up-file>') + '</div></div><div data-up-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Upload', { kind: 'primary', attrs: 'data-up-ok' }),
      onMount(m) {
        m.querySelector('[data-up-ok]').addEventListener('click', async () => {
          const errEl = m.querySelector('[data-up-err]'); errEl.innerHTML = '';
          const file = m.querySelector('[data-up-file]').files[0];
          if (!file) { errEl.innerHTML = UI.notice('Choose the report file.', 'warn'); return; }
          const q = ['kind=' + enc(m.querySelector('[data-up-kind]').value)];
          const dg = m.querySelector('[data-up-digest]').value.trim(); if (dg) q.push('digest=' + enc(dg));
          const ref = m.querySelector('[data-up-ref]').value.trim(); if (ref) q.push('ref=' + enc(ref));
          const fm = m.querySelector('[data-up-format]').value; if (fm) q.push('format=' + enc(fm));
          try {
            const res = await fetch('/api/admin/security/scans/upload?' + q.join('&'), { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': 'application/json', Accept: 'application/json' } });
            const out = await res.json().catch(() => ({}));
            if (!res.ok) { errEl.innerHTML = UI.notice('<b>' + esc(String(res.status)) + '</b> ' + esc(out.detail || out.title || 'Upload refused'), 'danger'); return; }
            App.closeOverlay(); ctx.toast('Report read: ' + esc(out.findingCount) + ' findings for ' + esc(out.name || short(out.digest)) + '. Audit event security.scan.uploaded written.', 'ok', 5000); reload();
          } catch (err) { errEl.innerHTML = UI.notice(esc(detailOf(err)), 'danger'); }
        });
      }
    }));

    ctx.on('click', '[data-scan-view]', async (e, t) => {
      let r;
      try { r = await App.get('/api/admin/security/scans/' + enc(t.dataset.scanView)); } catch (err) { App.fail(err, 'Could not read the result'); return; }
      const list = r.findings.slice(0, 300);
      ctx.modal({
        title: 'Findings: ' + esc(r.name || short(r.digest)),
        cls: 'wide',
        body: UI.kv([['Digest', '<span class="mono psec-wrap">' + esc(r.digest) + '</span>'], ['Report', esc(r.format) + (r.tool ? ', ' + esc(r.tool) : '') + ', scanned ' + esc(when(r.scannedAt))], ['Counts', sevPills(r.summary.bySeverity)]], 1)
          + UI.table(['Severity', 'Finding', 'Package', 'Version', 'Fixed in', 'Licence', 'Path', ''], list.map((f, i) => [UI.pill(f.severity, SEV_TONE[f.severity] || 'outline'), '<span class="mono psec-wrap">' + esc(f.id) + '</span>' + (f.title ? '<div class="muted psec-wrap" style="font-size:11px">' + esc(f.title) + '</div>' : ''), esc(f.package || ''), esc(f.version || ''), esc(f.fixedVersion || ''), esc(f.licence || ''), '<span class="psec-wrap" style="font-size:12px">' + esc(f.path || '') + '</span>', UI.btn('Request exception', { size: 'xs', kind: 'ghost', attrs: 'data-ex-new="' + i + '"' })]), { clickable: false, minWidth: '980px', emptyTitle: 'No findings', emptyText: 'The report found nothing.', attrs: 'aria-label="Findings"' })
          + (r.findings.length > list.length ? '<div class="muted" style="font-size:12px">The first ' + list.length + ' of ' + r.findings.length + ' findings.</div>' : '') + '<div data-ex-form></div>',
        actions: UI.btn('Close', { attrs: 'data-close' }),
        onMount(m) {
          m.addEventListener('click', (ev) => {
            const b = ev.target.closest('[data-ex-new]'); if (!b) return;
            const f = list[Number(b.dataset.exNew)];
            const until = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
            const box = m.querySelector('[data-ex-form]');
            box.innerHTML = UI.panel('Request an exception for ' + esc(f.id), '<div class="formgrid">' + UI.field('Applies to', UI.select([{ value: 'digest', label: 'This artefact only' }, { value: 'kind', label: 'Every ' + (KIND_WORD[r.kind] || r.kind).toLowerCase() }], 'digest', 'data-ex-scope')) + UI.field('Expires', UI.input(until, { type: 'date', attrs: 'data-ex-until' })) + '<div class="span2">' + UI.field('Reason', UI.textarea('', { rows: 2, placeholder: 'why this finding is accepted, and what mitigates it', attrs: 'data-ex-reason' })) + '</div></div><div data-ex-err></div><div class="psec-actions">' + UI.btn('Request exception', { kind: 'primary', size: 'sm', attrs: 'data-ex-send' }) + '</div>');
            box.querySelector('[data-ex-send]').addEventListener('click', async () => {
              const scope = box.querySelector('[data-ex-scope]').value;
              const body = { findingId: f.id, package: f.package || null, kind: r.kind, digest: scope === 'digest' ? r.digest : null, reason: box.querySelector('[data-ex-reason]').value.trim(), expiresAt: new Date(box.querySelector('[data-ex-until]').value + 'T23:59:59').getTime() };
              try { await App.post('/api/admin/security/exceptions', body); App.closeOverlay(); ctx.toast('Exception requested. It counts once another platform admin approves it. Audit event security.scan.exception.requested written.', 'ok', 6000); reload(); } catch (err) { box.querySelector('[data-ex-err]').innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
            });
          });
        }
      });
    });

    ctx.on('click', '[data-scan-del]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'Delete this scan result', tone: 'danger', body: '<p>The gate no longer counts it. Audited security.scan.deleted.</p>', ok: 'Delete' });
      if (!ok) return;
      try { await App.del('/api/admin/security/scans/' + enc(t.dataset.scanDel)); ctx.toast('Result deleted.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not delete the result'); }
    });

    ctx.on('click', '[data-scan-gate]', () => ctx.modal({
      title: 'Check the gate for a digest',
      body: '<div class="formgrid">' + UI.field('Artefact', UI.select(KINDS.filter((k) => d.kinds.includes(k.value)), d.kinds[0] || 'app-package', 'data-g-kind')) + UI.field('Digest', UI.input('', { placeholder: 'sha256:…', attrs: 'data-g-digest spellcheck="false"' })) + '</div><div data-g-out></div>',
      actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Check', { kind: 'primary', attrs: 'data-g-ok' }),
      onMount(m) {
        m.querySelector('[data-g-ok]').addEventListener('click', async () => {
          const out = m.querySelector('[data-g-out]');
          try { const g = await App.post('/api/admin/security/gate', { kind: m.querySelector('[data-g-kind]').value, digest: m.querySelector('[data-g-digest]').value.trim() || null }); out.innerHTML = gateHtml(g); } catch (err) { out.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
        });
      }
    }));

    const decide = (verb, id, ask) => async () => {
      const note = null;
      if (ask) { const ok = await ctx.confirm(ask); if (!ok) return; }
      const done = { approve: 'approved', reject: 'rejected', withdraw: 'withdrawn', revoke: 'revoked' }[verb];
      try { if ((await withStepUp(ctx, () => App.post('/api/admin/security/exceptions/' + enc(id) + '/' + verb, verb === 'withdraw' ? {} : { note }))) === CANCELLED) return; ctx.toast('Exception ' + done + (verb === 'approve' ? ': it counts at the gate until it expires' : '') + '. Audit event security.scan.exception.' + done + ' written.', 'ok', 5000); reload(); } catch (err) { App.fail(err, 'Could not ' + verb + ' the exception'); }
    };
    ctx.on('click', '[data-ex-approve]', (e, t) => decide('approve', t.dataset.exApprove, { title: 'Approve the exception', body: '<p>You accept this finding for its reason until it expires. You are recorded as who accepted it.</p>', ok: 'Approve' })());
    ctx.on('click', '[data-ex-reject]', (e, t) => decide('reject', t.dataset.exReject)());
    ctx.on('click', '[data-ex-withdraw]', (e, t) => decide('withdraw', t.dataset.exWithdraw)());
    ctx.on('click', '[data-ex-revoke]', (e, t) => decide('revoke', t.dataset.exRevoke, { title: 'Revoke the exception', tone: 'danger', body: '<p>The finding counts at the gate again from now on.</p>', ok: 'Revoke' })());

    return CSS + policy + results + exceptions;
  }

  // ---------------- Vault seal ----------------

  function loadSeal(ctx, st) {
    if (st.seal && st.seal.loading) return;
    st.seal = Object.assign(st.seal || {}, { loading: true });
    App.get('/api/admin/platform/vault/seal')
      .then((r) => { st.seal = { loaded: true, data: r }; })
      .catch((err) => { st.seal = { loaded: true, error: err }; })
      .then(() => { if (App.state.route === 'platform' && !document.getElementById('overlay')) ctx.rerender(); });
  }

  function renderSeal(ctx, st) {
    const v = st.seal;
    if (!v || (!v.loaded && !v.error)) { loadSeal(ctx, st); return '<p class="muted">Loading the vault seal…</p>'; }
    if (v.error) {
      ctx.on('click', '[data-seal-retry]', () => { st.seal = null; ctx.rerender(); });
      return UI.problem('The vault seal could not be loaded', detailOf(v.error), traceOf(v.error)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-seal-retry' }) + '</div>';
    }
    const d = v.data;
    const reload = () => { st.seal = null; ctx.rerender(); };
    const pending = d.proposals.find((p) => p.state === 'pending') || null;
    const e = d.escrow;
    const status = UI.panel('Emergency seal', UI.kv([
      ['State', d.sealed ? UI.pill('sealed', 'danger') : UI.pill('open', 'ok')],
      ['Keys held by', esc(d.kms === 'signer' ? 'the signer process (it drops its key when sealed)' : d.kms === 'openbao' ? 'OpenBao' : 'this server (DATA_KEY)')],
      ['Escrow', e ? '<span class="mono">' + esc(e.id) + '</span>, any ' + esc(e.threshold) + ' of ' + esc(e.shares) + ' shares ' + (e.matchesRunningKey ? UI.pill('matches the running key', 'ok') : UI.pill('not of the running key', 'danger')) : '<span class="muted">none</span>'],
      ['Can be sealed', d.sealable ? UI.pill('yes', 'ok') : UI.pill('no', 'warn') + ' <span class="muted">' + esc(d.problem || '') + '</span>'],
      ['Last seal', d.last && d.last.sealedAt ? esc(when(d.last.sealedAt)) + ' by ' + esc(d.last.sealedBy || '') + ' (' + esc(d.last.mode || '') + ')' + (d.last.unsealedAt ? ', unsealed ' + esc(when(d.last.unsealedAt)) : '') : '<span class="muted">never</span>']
    ], 1)
      + UI.notice('Sealing drops every key from every instance\'s memory and tells the signer to drop its key. Until enough escrow share holders unseal it, only health checks, the console\'s pages and the unseal page answer: nobody can sign in, and every API call that needs a key answers 503 "Vault sealed". The audit log keeps recording. Sealing needs a second platform admin to approve it.', 'warn')
      + '<div class="psec-actions">' + UI.btn('Seal the vault', { kind: 'danger', size: 'sm', attrs: 'data-seal-propose' + (d.sealable && !pending ? '' : ' disabled') }) + '<a class="btn sm" href="/unseal.html">Open the unseal page</a></div>');

    const props = UI.panel('Seal proposals', (pending ? UI.notice('<b>A seal waits for a second platform admin.</b> ' + esc(pending.proposedByName || 'Someone') + ' proposed it ' + esc(when(pending.proposedAt)) + ': ' + esc(pending.reason) + '. It expires ' + esc(when(pending.expiresAt)) + '.', 'danger', '<span class="psec-actions">' + (pending.mine ? UI.btn('Withdraw', { size: 'sm', attrs: 'data-seal-withdraw="' + esc(pending.id) + '"' }) : UI.btn('Approve and seal', { size: 'sm', kind: 'danger', attrs: 'data-seal-approve="' + esc(pending.id) + '"' }) + UI.btn('Reject', { size: 'sm', kind: 'ghost', attrs: 'data-seal-reject="' + esc(pending.id) + '"' })) + '</span>') : '')
      + UI.table(['Proposed', 'By', 'Reason', 'State', 'Decided by'], d.proposals.map((p) => [esc(when(p.proposedAt)), esc(p.proposedByName || ''), '<span class="psec-wrap">' + esc(p.reason) + '</span>', UI.pill(p.state, p.state === 'approved' ? 'danger' : p.state === 'pending' ? 'info' : 'outline'), esc(p.decidedByName || '')]), { clickable: false, minWidth: '720px', emptyTitle: 'No proposals', emptyText: 'Seal the vault proposes it; a second platform admin approves it.' }));

    ctx.on('click', '[data-seal-propose]', () => ctx.modal({
      title: 'Seal the vault',
      body: UI.notice('This proposes the seal. It fires when another platform admin approves it, within the hour. Escrow share holders will be needed to unseal: check that ' + (e ? esc(e.threshold) + ' of the ' + esc(e.shares) : 'enough') + ' holders can be reached.', 'warn') + UI.field('Reason', UI.textarea('', { rows: 3, placeholder: 'what happened and why the keys must be dropped now', attrs: 'data-sp-reason' })) + '<div data-sp-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Propose the seal', { kind: 'danger', attrs: 'data-sp-ok' }),
      onMount(m) {
        m.querySelector('[data-sp-ok]').addEventListener('click', async () => {
          try { const reason = m.querySelector('[data-sp-reason]').value.trim(); if ((await withStepUp(ctx, () => App.post('/api/admin/platform/vault/seal/proposals', { reason }))) === CANCELLED) return; App.closeOverlay(); ctx.toast('Seal proposed. It fires when another platform admin approves it. Audit event vault.seal.proposed written.', 'ok', 6000); reload(); } catch (err) { m.querySelector('[data-sp-err]').innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
        });
      }
    }));
    ctx.on('click', '[data-seal-approve]', async (ev, t) => {
      const ok = await ctx.confirm({ title: 'Approve and seal the vault', tone: 'danger', body: '<p>Every instance drops its keys now. This console stops working until escrow share holders unseal the vault on the unseal page.</p>', ok: 'Seal the vault' });
      if (!ok) return;
      try { if ((await withStepUp(ctx, () => App.post('/api/admin/platform/vault/seal/proposals/' + enc(t.dataset.sealApprove) + '/approve', {}))) === CANCELLED) return; location.assign('/unseal.html'); } catch (err) { App.fail(err, 'The seal was refused'); reload(); }
    });
    ctx.on('click', '[data-seal-reject]', async (ev, t) => { try { await App.post('/api/admin/platform/vault/seal/proposals/' + enc(t.dataset.sealReject) + '/reject', {}); ctx.toast('Seal rejected. Audit event vault.seal.rejected written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not reject'); } });
    ctx.on('click', '[data-seal-withdraw]', async (ev, t) => { try { await App.post('/api/admin/platform/vault/seal/proposals/' + enc(t.dataset.sealWithdraw) + '/withdraw', {}); ctx.toast('Seal withdrawn. Audit event vault.seal.withdrawn written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not withdraw'); } });

    return CSS + status + props;
  }

  App.platformSecurity = {
    tabs: [{ id: 'scans', label: 'Security scans' }, { id: 'seal', label: 'Vault seal' }],
    render(tab, ctx, st) { return tab === 'seal' ? renderSeal(ctx, st) : renderScans(ctx, st); }
  };
}());
