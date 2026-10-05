(function () {
  const { UI, esc } = App;

  // ---------- formatting ----------
  const enc = encodeURIComponent;
  const DAY = 86400000;
  const day = (ts) => (ts ? new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
  const when = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const daysLeft = (c) => Math.ceil((c.notAfter - Date.now()) / DAY);
  const overlayOpen = () => !!document.getElementById('overlay');
  const REASONS = ['unspecified', 'keyCompromise', 'affiliationChanged', 'superseded', 'cessationOfOperation', 'privilegeWithdrawn'];
  const ISSUER_REASONS = ['cACompromise', 'keyCompromise', 'affiliationChanged', 'superseded', 'cessationOfOperation'];
  const KEY_TYPES = ['ec-p256', 'ec-p384', 'rsa-2048', 'rsa-3072', 'rsa-4096', 'ed25519'];
  const SORT_LABEL = { expiry: 'Soonest expiry', cn: 'Common name', issued: 'Most recently issued' };
  const KIND_NOTE = { server: 'dNSName and iPAddress, serverAuth, at most 398 days', client: 'dNSName, iPAddress, rfc822Name and URI, clientAuth, 825 days', 'code-signing': 'rfc822Name and URI, needs a CN, codeSigning, 1185 days' };
  const KIND_CAP = { server: 398, client: 825, 'code-signing': 1185 };
  const custodyText = (c) => (c === 'signer' ? 'signer process' : c === 'openbao' ? 'OpenBao transit' : c || '');
  const sanText = (s) => s.type + ':' + s.value;
  const isExpiring = (c) => c.state === 'valid' && daysLeft(c) <= 30;
  const expiryCell = (c) => { const d = daysLeft(c); return c.state === 'revoked' ? '<span class="muted">' + esc(day(c.notAfter)) + '</span>' : d < 0 ? '<span class="muted">' + esc(day(c.notAfter)) + ', expired</span>' : d <= 7 ? '<span style="color:var(--danger-fg)">' + esc(day(c.notAfter)) + ', ' + d + ' d</span>' : d <= 30 ? '<span style="color:var(--warn-fg)">' + esc(day(c.notAfter)) + ', ' + d + ' d</span>' : esc(day(c.notAfter)); };
  const statePill = (c) => { const d = daysLeft(c); return c.state === 'revoked' ? UI.pill('revoked', 'danger') : d < 0 ? UI.pill('expired', 'danger') : d <= 7 ? UI.pill('expiring, ' + d + ' d', 'danger') : d <= 30 ? UI.pill('expiring', 'warn') : UI.pill('valid', 'ok'); };
  const issuerPill = (i) => UI.pill(i.state, i.state === 'active' ? 'ok' : i.state === 'retired' ? '' : 'danger');
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const parseSans = (v) => list(v).map((s) => { const m = /^(dns|ip|email|uri):(.+)$/i.exec(s); if (!m) throw new Error('Write each name as type:value, for example dns:host.example.com or ip:10.0.0.5 ("' + s + '").'); return { type: m[1].toLowerCase(), value: m[2].trim() }; });
  const download = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name || ''; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); };
  const b64Blob = (b64, type) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };
  const fileOf = (c) => String(c.commonName || c.serial).replace(/^\*\./, 'wildcard.').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);

  function menu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  // ---------- step-up (B-106): rotate, reissue, revoke an issuer and create the root need a recent sign-in ----------
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
  /** Runs `fn`; when the server asks for step-up, confirms the user and runs it once more. Resolves undefined when cancelled. */
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) return undefined;
      return fn();
    }
  };

  App.register({
    id: 'certificates', title: 'Certificates', live: true, section: 'admin', crumb: ['Admin', 'Certificates'],
    summary: 'Issuers, profiles, issuance from a CSR, revocation, CRLs, ACME directory, expiring certificates',
    commands: [
      { label: 'Issue a certificate', sub: 'Certificates', run(app) { const s = app.stateFor('certificates'); s.tab = 'certs'; s.openIssue = true; app.render(); } },
      { label: 'Sign the next CRL now', sub: 'Certificates', run(app) { const s = app.stateFor('certificates'); s.openCrl = true; app.render(); } }
    ],
    label: () => 'confidential',
    states: [
      { title: 'Custody unavailable', tone: 'warn', text: 'No signer process or OpenBao transit is reachable. Routes that make keys answer 409 (step custody); rotation, new issuers and key generation are disabled until it is back.',
        apply(ctx) { ctx.state.custodyForced = true; ctx.state.tab = 'issuers'; ctx.rerender(); } },
      { title: 'Name refused by profile', tone: 'danger', text: 'A CSR asked for a name outside the profile. The refusal is 422 with step names and the offending name; it is audited as pki.issue.refused and nothing is issued.',
        apply(ctx) { const st = ctx.state; st.tab = 'certs'; st.problem = st.lastRefusal || { title: 'Name refused by profile', text: 'When a CSR asks for a name the profile does not allow, the answer is 422 with step names and the offending name. Nothing is issued; the refusal is audited as pki.issue.refused. Fix the CSR or ask a pki admin to widen the profile.', trace: false }; ctx.rerender(); } },
      { title: 'Issuer retired after rotation', tone: 'neutral', text: 'Rotation makes a new key and certificate (generation plus one). The old issuer stops issuing but keeps serving its CRL and OCSP, with replacedBy pointing at the new one.',
        apply(ctx) { const st = ctx.state; st.tab = 'issuers'; const r = ((st.data && st.data.issuers) || []).find((i) => i.state === 'retired'); if (r) st.selIssuer = r.id; else ctx.toast('No issuer has been rotated yet. Rotate the active one to retire it.', 'warn', 5000); ctx.rerender(); } },
      { title: 'Certificate expiring in 7 days', tone: 'warn', text: 'The pki.expiry sweep notified the requester at 30 days and again at 7 (kind pki.certificate.expiring, also by email). A certificate with a valid renewal is skipped.',
        apply(ctx) { const st = ctx.state; st.tab = 'certs'; st.stateFilter = 'expiring'; const c = ((st.data && st.data.certs) || []).filter((x) => x.state === 'valid' && daysLeft(x) <= 7).sort((a, b) => a.notAfter - b.notAfter)[0]; if (c) { st.selCert = c.id; st.expiryNote = true; } else ctx.toast('No valid certificate expires within 7 days.', 'ok'); ctx.rerender(); } },
      { title: 'ACME order invalid', tone: 'danger', text: 'The dns-01 challenge found no TXT record. The challenge, its authorization and the order are invalid; the client must place a new order.',
        apply(ctx) { const st = ctx.state; st.tab = 'acme'; st.acmeTab = 'orders'; st.orderFilter = 'invalid'; st.orderAcct = null; const o = ((st.data && st.data.orders) || []).find((x) => x.status === 'invalid'); if (o) st.selOrder = o.id; else ctx.toast('No ACME order is invalid.', 'ok'); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      // Design states may run before the first render, so each default is filled in on its own.
      const DEFAULTS = { tab: 'certs', acmeTab: 'eab', query: '', stateFilter: 'all', issuerFilter: 'all', profileFilter: 'all', sort: 'expiry', orderFilter: 'all' };
      Object.keys(DEFAULTS).forEach((k) => { if (st[k] === undefined) st[k] = DEFAULTS[k]; });
      if (!st.detail) st.detail = {};

      // ---------- loading ----------
      const refresh = () => {
        if (App.state.route !== 'certificates') return;
        if (overlayOpen()) { st.dirty = true; return; }
        const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0;
        ctx.rerender();
        const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top;
      };
      const fetchAll = () => Promise.all([
        App.get('/api/pki'), App.get('/api/pki/issuers'), App.get('/api/pki/certificates?limit=500'), App.get('/api/pki/profiles'),
        App.get('/api/pki/acme'), App.get('/api/pki/acme/eab-keys'), App.get('/api/pki/acme/accounts'), App.get('/api/pki/acme/orders?limit=500'),
        App.can('users:manage') ? App.get('/api/admin/users?limit=500').catch(() => []) : Promise.resolve([])
      ]).then((r) => {
        const users = {}; (r[8] || []).forEach((u) => { users[u.id] = u.displayName || u.username; });
        if (App.me && App.me.user) users[App.me.user.id] = App.me.user.displayName || App.me.user.username;
        return { info: r[0], issuers: r[1].issuers, certs: r[2].certificates, profiles: r[3].profiles, acme: r[4], eab: r[5].keys, accounts: r[6].accounts, orders: r[7].orders, users };
      });
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        fetchAll().then((data) => { Object.assign(st, { data, loaded: true, loadError: null, detail: {} }); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; refresh(); });
      };
      const quiet = () => fetchAll().then((data) => { st.data = data; st.detail = {}; st.acmeDraft = null; refresh(); }).catch((err) => App.fail(err, 'Could not refresh certificates'));
      if (!st.loaded && !st.loadError) load();

      const style = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .certificates-insp .kv .v{font-size:12px;overflow-wrap:anywhere;min-width:0}'
        + '#main .certificates-wrap{overflow-wrap:anywhere;min-width:0}'
        + '</style>';
      const sub = (custody) => 'The ' + esc((App.me && App.me.tenant && App.me.tenant.name) || 'tenant') + ' certificate authority: issuers in ' + esc(custody === 'unavailable' ? 'unavailable custody' : custody || 'the signer process') + ', profiles, issuance, revocation, CRLs and OCSP, and the ACME directory.';
      if (st.loadError) { root.innerHTML = style + '<div class="page">' + UI.pagehead('Certificates', sub(''), '') + UI.problem('Certificates could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div></div>'; ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); }); return; }
      if (!st.loaded) { root.innerHTML = style + '<div class="page">' + UI.pagehead('Certificates', sub(''), '') + UI.notice('Loading…', 'info') + '</div>'; return; }

      const D = st.data;
      const tenantId = App.me && App.me.tenant ? App.me.tenant.id : null;
      const custodyDown = !!st.custodyForced || D.info.custody === 'unavailable';
      const canPlatform = App.can('platform:manage');
      const root0 = D.issuers.find((i) => i.kind === 'root' && i.state === 'active');
      const active = D.issuers.find((i) => i.kind === 'intermediate' && i.state === 'active' && (!tenantId || i.tenantId === tenantId));
      const issuerById = (id) => D.issuers.find((i) => i.id === id);
      const profileById = (id) => D.profiles.find((p) => p.id === id);
      const issuedUnder = (p) => D.certs.filter((c) => c.profileId === p.id).length;
      const who = (c) => (c.acmeAccountId ? 'ACME account ' + c.acmeAccountId.slice(-6) : c.requestedBy ? D.users[c.requestedBy] || 'user ' + c.requestedBy.slice(-6) : 'the pki CLI');
      const expiring = D.certs.filter(isExpiring);
      const openOrders = D.orders.filter((o) => o.status === 'pending' || o.status === 'processing' || o.status === 'ready');
      const canIssue = !!active && D.profiles.some((p) => p.state === 'active');
      const tabs = UI.tabs([{ id: 'issuers', label: 'Issuers', count: D.issuers.length }, { id: 'certs', label: 'Certificates', count: D.certs.length }, { id: 'profiles', label: 'Profiles', count: D.profiles.length }, { id: 'acme', label: 'ACME', count: openOrders.length }], st.tab);
      const loadDetail = (id) => {
        if (!id || st.detail[id] || st.detailLoading === id) return;
        st.detailLoading = id;
        App.get('/api/pki/issuers/' + enc(id)).then((d) => { st.detail[id] = d; }).catch((err) => App.fail(err, 'Could not load the issuer')).finally(() => { st.detailLoading = null; refresh(); });
      };
      if (ctx.params.id) { const id = ctx.params.id; delete ctx.params.id; if (D.certs.some((c) => c.id === id)) { st.tab = 'certs'; st.selCert = id; } else if (issuerById(id)) { st.tab = 'issuers'; st.selIssuer = id; } }
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }

      const setupNotice = !root0
        ? (canPlatform ? UI.notice('<b>There is no root CA yet.</b> The platform root signs each tenant\'s issuing CA. Creating it needs platform:manage and a recent sign-in.', 'info', UI.btn('Create root CA', { kind: 'primary', size: 'sm', attrs: 'data-newroot', disabled: custodyDown, title: custodyDown ? 'Needs key custody' : '' }))
          : UI.notice('<b>There is no root CA yet.</b> A platform administrator creates it first; then this tenant can create its issuing CA.', 'info'))
        : !active ? UI.notice('<b>This tenant has no active issuing CA.</b> Nothing can be issued until one is created under the root.', 'warn', UI.btn('Create issuing CA', { kind: 'primary', size: 'sm', attrs: 'data-newint', disabled: custodyDown, title: custodyDown ? 'Needs key custody' : '' })) : '';
      const custodyNotice = custodyDown ? UI.notice('<b>Custody unavailable.</b> Neither the signer process (SIGNER_SOCKET) nor OpenBao transit answers. Issuers and the OCSP responder keep working from stored certificates; anything that makes or uses a private key answers <span class="mono">409</span> with <span class="mono">step: custody</span>.', 'warn', UI.btn('Platform status', { size: 'sm', attrs: 'data-goplatform' }) + UI.btn('Retry', { kind: 'ghost', size: 'sm', attrs: 'data-retrycustody' })) : '';

      let body = '', insp = '';
      // ---------------- Issuers ----------------
      if (st.tab === 'issuers') {
        const sel = issuerById(st.selIssuer) || active || D.issuers[0];
        if (sel) { st.selIssuer = sel.id; loadDetail(sel.id); }
        body += custodyNotice + setupNotice;
        body += UI.table(['Issuer', 'Kind', 'Key', 'Custody', 'Gen', 'Valid from', 'Valid to', 'CRL', 'State'], D.issuers.map((i) => ({ cells: [esc(i.name) + (i.kind === 'root' ? ' ' + UI.pill('platform', 'outline') : ''), esc(i.kind), '<span class="mono">' + esc(i.keyType) + '</span>', esc(custodyText(i.custody)), '<span class="num">' + i.generation + '</span>', esc(day(i.notBefore)), esc(day(i.notAfter)), '<span class="num">' + i.crlNumber + '</span>', issuerPill(i) + (i.replacedBy ? ' <span class="muted" style="font-size:12px">replaced by gen ' + ((issuerById(i.replacedBy) || {}).generation || '') + '</span>' : '')], attrs: 'data-issuer="' + esc(i.id) + '"', selected: !!sel && i.id === sel.id })), { minWidth: '820px', emptyTitle: 'No issuers', emptyText: 'Create the root CA, then this tenant\'s issuing CA.' })
          + '<div class="muted" style="font-size:12px">A root is retired by rotation, never revoked. One active intermediate per tenant: it carries the CRL distribution point and the OCSP and caIssuers URLs of the root\'s public routes. <a href="#" data-goplatform>The root belongs to Platform</a> and needs platform:manage.</div>';
        if (sel) {
          const det = st.detail[sel.id];
          const parent = sel.parentId ? issuerById(sel.parentId) : null;
          const chain = [sel].concat(parent ? [parent] : []);
          const rootLocked = sel.kind === 'root' && !canPlatform;
          insp = '<div class="eyebrow">Selected issuer</div><div style="font-size:15px;font-weight:600;overflow-wrap:anywhere">' + esc(sel.name) + ' <span class="muted">G' + sel.generation + '</span></div>'
            + UI.kv([['State', issuerPill(sel)], ['Serial', '<span class="mono">' + esc(sel.serial) + '</span>'], ['Key type', '<span class="mono">' + esc(sel.keyType) + '</span>'], ['Custody', esc(custodyDown ? 'unavailable' : custodyText(sel.custody))], ['Path length', esc(sel.pathLen === null || sel.pathLen === undefined ? 'none' : String(sel.pathLen))], ['Validity', esc(day(sel.notBefore)) + ' to ' + esc(day(sel.notAfter))], ['Issued certificates', '<span class="num">' + D.certs.filter((c) => c.issuerId === sel.id).length + '</span>'], ['Replaced by', sel.replacedBy && issuerById(sel.replacedBy) ? '<a href="#" data-issuerlink="' + esc(sel.replacedBy) + '">generation ' + issuerById(sel.replacedBy).generation + '</a>' : 'no']], 2)
            + (sel.state === 'revoked' ? UI.notice('<b>Revoked ' + esc(when(sel.revokedAt)) + '</b>, reason <span class="mono">' + esc(sel.revocationReason || 'unspecified') + '</span>.', 'danger') : '')
            + '<div class="eyebrow">Chain</div>' + UI.timeline(chain.map((c, i) => ({ title: esc(c.name) + ' G' + c.generation, text: c.kind === 'root' ? 'self-signed, keyCertSign and cRLSign' : 'signed by the active root, pathLen 0', tone: i === 0 ? 'accent' : 'ok' })))
            + '<div class="eyebrow">Public URLs</div><div class="vstack gap4 mono" style="font-size:11px;overflow-wrap:anywhere">' + ['crl', 'certificate', 'ocsp'].map((k) => '<span>' + esc(sel.urls[k]) + '</span>').join('') + '</div>'
            + '<div class="eyebrow">Last CRLs</div>' + (det ? (det.crls.length ? UI.table(['No.', 'This update', 'Next update', 'Entries'], det.crls.map((c) => ['<span class="num">' + c.number + '</span>', esc(when(c.thisUpdate)), esc(when(c.nextUpdate)), '<span class="num">' + c.entries + '</span>']), { clickable: false, minWidth: '0', cls: 'bare' }) : '<span class="muted" style="font-size:12px">No CRL signed yet. One is signed on the first request to its URL, or now with Sign CRL now.</span>') : '<span class="muted" style="font-size:12px">Reading the CRLs</span>')
            + '<div class="hstack wrap gap6">' + UI.btn('Rotate', { kind: 'primary', size: 'sm', attrs: 'data-rotate', disabled: custodyDown || sel.state !== 'active' || rootLocked, title: custodyDown ? 'Needs key custody' : rootLocked ? 'Needs platform:manage' : '' }) + UI.btn('Reissue', { size: 'sm', attrs: 'data-reissue', disabled: custodyDown || sel.state === 'revoked' || rootLocked, title: rootLocked ? 'Needs platform:manage' : '' }) + UI.btn('Sign CRL now', { size: 'sm', attrs: 'data-crl', disabled: sel.state === 'revoked' || rootLocked }) + (sel.kind === 'intermediate' && sel.state === 'active' ? UI.btn('Revoke', { kind: 'danger', size: 'sm', attrs: 'data-revokeissuer' }) : '') + '</div>'
            + '<span class="muted" style="font-size:12px">Rotate, reissue and revoke need a recent sign-in.</span>';
        }
      }
      // ---------------- Certificates ----------------
      if (st.tab === 'certs') {
        const q = st.query.toLowerCase();
        const profName = (c) => (profileById(c.profileId) || {}).name || '';
        let rows = D.certs.filter((c) => (!q || ((c.commonName || '') + ' ' + c.sans.map(sanText).join(' ') + ' ' + c.serial + ' ' + who(c)).toLowerCase().includes(q))
          && (st.stateFilter === 'all' || (st.stateFilter === 'expiring' ? isExpiring(c) : c.state === st.stateFilter))
          && (st.issuerFilter === 'all' || c.issuerId === st.issuerFilter) && (st.profileFilter === 'all' || c.profileId === st.profileFilter));
        rows = rows.slice().sort((a, b) => st.sort === 'cn' ? (a.commonName || '').localeCompare(b.commonName || '') : st.sort === 'issued' ? b.createdAt - a.createdAt : (a.state === 'revoked') - (b.state === 'revoked') || a.notAfter - b.notAfter);
        if (!rows.some((c) => c.id === st.selCert)) st.selCert = rows.length ? rows[0].id : null;
        const sel = D.certs.find((c) => c.id === st.selCert);
        const pr = st.problem;
        body += custodyNotice + setupNotice
          + (pr ? UI.problem(pr.title, pr.text, pr.trace) + '<div class="hstack wrap gap6">' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearproblem' }) + (pr.profileId ? UI.btn('Open profile', { kind: 'ghost', size: 'sm', attrs: 'data-openprofile="' + esc(pr.profileId) + '"' }) : '') + '</div>' : '')
          + (st.expiryNote && sel && sel.state === 'valid' && daysLeft(sel) <= 7 ? UI.notice('<b>' + esc(sel.commonName || sel.serial) + ' expires in ' + daysLeft(sel) + ' days.</b> ' + esc(who(sel)) + ' was notified at 30 days and again at 7, in the console and by email when SMTP is set. Renew it here or let the ACME client order again.', 'warn', UI.btn('Renew now', { size: 'sm', attrs: 'data-renew' })) : '')
          + (expiring.length && !st.expiryNote ? UI.notice('<b>' + expiring.length + (expiring.length === 1 ? ' certificate expires' : ' certificates expire') + ' within 30 days.</b> ' + esc(expiring.slice(0, 6).map((c) => (c.commonName || c.serial) + ' (' + daysLeft(c) + ' d)').join(', ')) + '. Owners are notified; renewals in flight are skipped.', 'warn', UI.btn('Show', { size: 'sm', attrs: 'data-showexpiring' })) : '')
          + (st.revealed ? UI.notice('<b>' + esc(st.revealed.title) + '</b> ' + esc(st.revealed.text), 'warn', UI.btn('Download again', { size: 'sm', attrs: 'data-p12again' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-revealdone' })) : '')
          + '<div class="toolbar">' + UI.search('Filter by name, SAN, serial or requester', 'data-search', st.query)
          + '<span class="relative">' + UI.btn(st.stateFilter === 'all' ? 'State' : 'State: ' + st.stateFilter, { size: 'sm', icon: 'filter', attrs: 'data-menu="state"', cls: st.stateFilter !== 'all' ? 'active' : '' }) + '</span>'
          + '<span class="relative">' + UI.btn(st.issuerFilter === 'all' ? 'Issuer' : 'Issuer: G' + ((issuerById(st.issuerFilter) || {}).generation || ''), { size: 'sm', icon: 'filter', attrs: 'data-menu="issuer"', cls: st.issuerFilter !== 'all' ? 'active' : '' }) + '</span>'
          + '<span class="relative">' + UI.btn(st.profileFilter === 'all' ? 'Profile' : 'Profile: ' + ((profileById(st.profileFilter) || {}).name || ''), { size: 'sm', icon: 'filter', attrs: 'data-menu="profile"', cls: st.profileFilter !== 'all' ? 'active' : '' }) + '</span>'
          + '<span class="relative">' + UI.btn(SORT_LABEL[st.sort], { size: 'sm', icon: 'sort', attrs: 'data-menu="sort"' }) + '</span>'
          + '<span class="muted right" style="font-size:12px">' + rows.length + ' of ' + D.certs.length + '</span></div>'
          + UI.table(['Common name', 'SANs', 'Profile', 'Serial', 'Key', 'Issued', 'Expires', 'State', 'Requested by'], rows.map((c) => ({ cells: [esc(c.commonName || ''), '<span class="muted" style="font-size:12px">' + esc(c.sans.map(sanText).join(', ')) + '</span>', c.profileId && profileById(c.profileId) ? '<a href="#" data-openprofile="' + esc(c.profileId) + '">' + esc(profName(c)) + '</a>' : '', '<span class="mono" style="font-size:11px">' + esc(c.serial) + '</span>', '<span class="mono">' + esc(c.keyType) + '</span>', esc(day(c.notBefore)), expiryCell(c), statePill(c), esc(who(c))], attrs: 'data-cert="' + esc(c.id) + '"', selected: c.id === st.selCert })), { minWidth: '980px', emptyTitle: D.certs.length ? 'No certificates match' : 'No certificates yet', emptyText: D.certs.length ? 'Clear the filters to see the tenant\'s certificates, newest first.' : 'Issue one from a CSR, or let an ACME client order one.' });
        if (sel) {
          const issuer = issuerById(sel.issuerId) || { name: 'unknown issuer', generation: '' };
          const parent = issuer.parentId ? issuerById(issuer.parentId) : null;
          const renewal = D.certs.find((c) => c.renewedFrom === sel.id);
          insp = '<div class="hstack"><div class="eyebrow grow">Selected certificate</div>' + statePill(sel) + '</div><div style="font-size:15px;font-weight:600;overflow-wrap:anywhere" data-selcert>' + esc(sel.commonName || sel.serial) + '</div>'
            + UI.kv([['Serial', '<span class="mono" style="font-size:11px">' + esc(sel.serial) + '</span>'], ['Key type', '<span class="mono">' + esc(sel.keyType) + '</span>'], ['Issuer', issuerById(sel.issuerId) ? '<a href="#" data-issuerlink="' + esc(sel.issuerId) + '">' + esc(issuer.name) + ' G' + issuer.generation + '</a>' : esc(issuer.name)], ['Profile', esc(profName(sel) || 'none')], ['Not before', esc(day(sel.notBefore))], ['Not after', esc(day(sel.notAfter))], ['Requested by', esc(who(sel))], ['ACME account', sel.acmeAccountId ? '<a href="#" data-acmeacct="' + esc(sel.acmeAccountId) + '">' + esc(sel.acmeAccountId.slice(-6)) + '</a>' : 'none'], ['Renewed from', sel.renewedFrom ? '<a href="#" data-certlink="' + esc(sel.renewedFrom) + '">' + esc(sel.renewedFrom.slice(-6)) + '</a>' : 'no'], ['Renewal', renewal ? '<a href="#" data-certlink="' + esc(renewal.id) + '">' + esc(renewal.id.slice(-6)) + '</a>' : 'none']], 2)
            + (sel.state === 'revoked' ? UI.notice('<b>Revoked ' + esc(when(sel.revokedAt)) + '</b>, reason <span class="mono">' + esc(sel.revocationReason || 'unspecified') + '</span>' + (sel.invalidityDate ? ', invalid since ' + esc(day(sel.invalidityDate)) : '') + '. Listed on the issuer\'s next CRL; OCSP answers revoked.', 'danger') : '')
            + '<div class="eyebrow">Subject alternative names</div><div class="vstack gap4">' + (sel.sans.length ? sel.sans.map((s) => '<span class="mono" style="font-size:12px;overflow-wrap:anywhere">' + esc(sanText(s)) + '</span>').join('') : '<span class="muted" style="font-size:12px">none</span>') + '</div>'
            + '<div class="eyebrow">Fingerprint</div><div class="mono" style="font-size:11px;overflow-wrap:anywhere">SHA-256 ' + esc(sel.fingerprint) + '</div>'
            + '<div class="eyebrow">Chain</div>' + UI.timeline([{ title: esc(sel.commonName || sel.serial), text: 'end-entity, ' + esc(sel.keyType), tone: sel.state === 'revoked' ? 'danger' : 'accent' }, { title: esc(issuer.name) + ' G' + issuer.generation, text: 'intermediate, pathLen 0', tone: 'ok' }].concat(parent ? [{ title: esc(parent.name) + ' G' + parent.generation, text: 'root, from the trust store', tone: 'ok' }] : []))
            + '<div class="hstack wrap gap6">' + UI.btn('Renew', { kind: 'primary', size: 'sm', attrs: 'data-renew', disabled: sel.state === 'revoked' || custodyDown || !active }) + '<span class="relative">' + UI.btn('Export', { size: 'sm', icon: 'download', attrs: 'data-export' }) + '</span>' + UI.btn('PKCS#12', { size: 'sm', attrs: 'data-p12' }) + (sel.state !== 'revoked' ? UI.btn('Revoke', { kind: 'danger', size: 'sm', attrs: 'data-revokecert' }) : '') + '</div>';
        }
      }
      // ---------------- Profiles ----------------
      if (st.tab === 'profiles') {
        body += '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">A profile is the upper bound of what may be issued under it: names, key types and lifetime. Each CSR\'s names are checked against it; a refusal is 422 with the step and the name.</span>' + UI.btn('New profile', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newprofile' }) + '</div>'
          + (D.profiles.length ? '<div class="grid3">' + D.profiles.map((p) => { const n = issuedUnder(p); return UI.panel(null, '<div class="hstack"><div style="font-size:15px;font-weight:600;overflow-wrap:anywhere;min-width:0" class="grow mono">' + esc(p.name) + '</div>' + UI.pill(p.state, p.state === 'active' ? 'ok' : '') + '</div><div class="muted" style="font-size:12px">' + esc(p.kind) + ': ' + esc(KIND_NOTE[p.kind] || '') + '</div>'
            + UI.kv([['Max days', '<span class="num">' + p.maxDays + '</span>'], ['Default days', '<span class="num">' + p.defaultDays + '</span>'], ['Issued', '<span class="num">' + n + '</span>'], ['Wildcards', p.policy.allowWildcard ? 'allowed' : 'refused']], 2)
            + '<div class="eyebrow">Policy</div><div class="vstack gap4 certificates-wrap" style="font-size:12px">' + (p.policy.domains.length ? '<div><span class="muted">Domains</span> <span class="mono">' + esc(p.policy.domains.join(', ')) + '</span></div>' : '') + (p.policy.ipRanges.length ? '<div><span class="muted">IP ranges</span> <span class="mono">' + esc(p.policy.ipRanges.join(', ')) + '</span></div>' : '') + (p.policy.emailDomains.length ? '<div><span class="muted">Email domains</span> <span class="mono">' + esc(p.policy.emailDomains.join(', ')) + '</span></div>' : '') + (p.policy.uriPrefixes.length ? '<div><span class="muted">URI prefixes</span> <span class="mono">' + esc(p.policy.uriPrefixes.join(', ')) + '</span></div>' : '') + '<div><span class="muted">Key types</span> <span class="mono">' + esc(p.policy.keyTypes.join(', ')) + '</span></div></div>'
            + '<div class="hstack wrap gap6">' + UI.btn('Edit', { size: 'sm', attrs: 'data-editprofile="' + esc(p.id) + '"' }) + UI.btn(p.state === 'active' ? 'Disable' : 'Enable', { size: 'sm', attrs: 'data-toggleprofile="' + esc(p.id) + '"' }) + UI.btn('Delete', { kind: 'ghost', size: 'sm', attrs: 'data-delprofile="' + esc(p.id) + '"', disabled: n > 0, title: n > 0 ? 'Certificates were issued under it' : '' }) + '</div>', { attrs: 'data-profilecard="' + esc(p.id) + '"' }); }).join('') + '</div>'
            : UI.empty('No profiles yet', 'Every certificate is issued under a profile. Create one for servers, clients or code signing.'));
      }
      // ---------------- ACME ----------------
      if (st.tab === 'acme') {
        if (!st.acmeDraft) st.acmeDraft = { enabled: D.acme.enabled, profileId: D.acme.profileId, eabRequired: D.acme.eabRequired, challenges: D.acme.challenges.slice() };
        const a = st.acmeDraft; const prof = profileById(a.profileId);
        const servers = D.profiles.filter((p) => p.kind === 'server');
        const acctName = (id) => (id ? id.slice(-6) : '');
        body += UI.panel('Directory', '<div class="formgrid" style="--cols:3">' + UI.field('Directory', UI.toggle(a.enabled ? 'Open' : 'Closed', a.enabled, 'data-acmetoggle data-manual')) + UI.field('Server profile', UI.select([{ value: '', label: servers.length ? 'Choose a server profile' : 'No server profile yet' }].concat(servers.map((p) => ({ value: p.id, label: p.name }))), a.profileId || '', 'data-acmeprofile'), 'Orders are issued under it; its names are the upper bound') + UI.field('External account binding', UI.toggle(a.eabRequired ? 'Required' : 'Not required', a.eabRequired, 'data-eabtoggle data-manual')) + '</div>'
          + '<div class="hstack wrap gap6"><span class="muted" style="font-size:12px">Challenges</span>' + UI.chip('http-01', a.challenges.indexOf('http-01') >= 0, 'data-chall="http-01"') + UI.chip('dns-01', a.challenges.indexOf('dns-01') >= 0, 'data-chall="dns-01"') + '<span class="muted" style="font-size:12px">Wildcards need dns-01' + (prof && !prof.policy.allowWildcard ? '; profile ' + esc(prof.name) + ' refuses wildcards anyway' : '') + '</span></div>'
          + UI.kv([['Directory URL', D.acme.directoryUrl ? '<span class="mono" style="font-size:11px;overflow-wrap:anywhere">' + esc(D.acme.directoryUrl) + '</span> ' + UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copy="' + esc(D.acme.directoryUrl) + '"' }) : 'none'], ['Updated', D.acme.updatedAt ? esc(when(D.acme.updatedAt)) : 'never']], 2)
          + (D.acme.enabled ? '' : UI.notice('<b>The directory is closed.</b> Clients get 404 with an ACME problem until it is opened again; existing certificates stay valid.', 'info')), { actions: UI.btn('Save', { kind: 'primary', size: 'sm', attrs: 'data-acmesave' }) });
        body += UI.tabs([{ id: 'eab', label: 'EAB keys', count: D.eab.length }, { id: 'accounts', label: 'Accounts', count: D.accounts.length }, { id: 'orders', label: 'Orders', count: D.orders.length }], st.acmeTab, 'data-subtabs');
        if (st.acmeTab === 'eab') {
          body += '<div class="vstack">' + (st.revealedEab ? UI.notice('<b>EAB key ' + esc(st.revealedEab.name) + ' created.</b> The HMAC key is shown once; give the client this kid and key. It binds one account.<div class="mono" style="margin-top:4px;overflow-wrap:anywhere;font-size:11px">kid ' + esc(st.revealedEab.kid) + '<br>hmacKey ' + esc(st.revealedEab.hmacKey) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copy="' + esc(st.revealedEab.hmacKey) + '"' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-eabdone' })) : '')
            + '<div>' + UI.btn('Create EAB key', { kind: 'primary', size: 'sm', icon: 'key', attrs: 'data-neweab' }) + '</div>'
            + UI.table(['Name', 'Key id', 'State', 'Bound account', 'Created', 'Bound', { label: '', right: true }], D.eab.map((k) => [esc(k.name), '<span class="mono">' + esc(k.id) + '</span>', UI.pill(k.state, k.state === 'bound' ? 'ok' : k.state === 'active' ? 'info' : 'danger'), k.accountId ? '<a href="#" data-acmeacct="' + esc(k.accountId) + '">' + esc(acctName(k.accountId)) + '</a>' : '<span class="muted">none yet</span>', esc(day(k.createdAt)), esc(day(k.boundAt)), k.state === 'revoked' ? '' : UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-revokeeab="' + esc(k.id) + '"' })]), { clickable: false, minWidth: '720px', emptyTitle: 'No EAB keys', emptyText: 'Create one for each ACME client when the directory requires external account binding.' })
            + '<span class="muted" style="font-size:12px">The MAC key is sealed with the tenant key and never shown again. Revoking a key stops it binding an account; an account it already bound stays.</span></div>';
        } else if (st.acmeTab === 'accounts') {
          body += '<div class="vstack">' + UI.table(['Account', 'Key thumbprint', 'Key', 'Contact', 'Status', 'EAB key', 'Orders', 'Created', { label: '', right: true }], D.accounts.map((ac) => ({ cells: ['<span class="mono">' + esc(acctName(ac.id)) + '</span>', '<span class="mono" style="font-size:11px;overflow-wrap:anywhere">' + esc(ac.thumbprint) + '</span>', esc(ac.keyType), '<span class="mono" style="font-size:12px">' + esc([].concat(ac.contact || []).join(', ')) + '</span>', UI.pill(ac.status, ac.status === 'valid' ? 'ok' : ac.status === 'deactivated' ? '' : 'danger'), esc(ac.eabKeyId || ''), '<a href="#" data-acctorders="' + esc(ac.id) + '"><span class="num">' + D.orders.filter((o) => o.accountId === ac.id).length + '</span></a>', esc(day(ac.createdAt)), ac.status === 'valid' ? UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-revokeacct="' + esc(ac.id) + '"' }) : ''], attrs: 'data-acct="' + esc(ac.id) + '"', selected: ac.id === st.selAcct })), { minWidth: '900px', emptyTitle: 'No ACME accounts', emptyText: 'Accounts appear when a client registers with the directory.' })
            + '<span class="muted" style="font-size:12px">Revoking an account (RFC 8555, by the server) makes its pending and ready orders invalid. Deactivation is the client\'s own doing.</span></div>';
        } else {
          const rows = D.orders.filter((o) => (st.orderFilter === 'all' || o.status === st.orderFilter) && (!st.orderAcct || o.accountId === st.orderAcct));
          if (!rows.some((o) => o.id === st.selOrder)) st.selOrder = rows.length ? rows[0].id : null;
          const o = D.orders.find((x) => x.id === st.selOrder);
          const errText = (e) => (!e ? '' : typeof e === 'string' ? e : e.detail || e.type || '');
          body += '<div class="vstack"><div class="toolbar"><span class="relative">' + UI.btn(st.orderFilter === 'all' ? 'Status' : 'Status: ' + st.orderFilter, { size: 'sm', icon: 'filter', attrs: 'data-menu="order"', cls: st.orderFilter !== 'all' ? 'active' : '' }) + '</span>' + (st.orderAcct ? UI.chip('account ' + esc(acctName(st.orderAcct)) + ' <span class="x" aria-hidden="true">×</span>', true, 'data-clearacct aria-label="Clear the account filter"') : '') + '<span class="muted right" style="font-size:12px">' + rows.length + ' of ' + D.orders.length + ' orders, ' + openOrders.length + ' open (at most 300 per account)</span></div>'
            + UI.table(['Order', 'Account', 'Identifiers', 'Status', 'Expires', 'Certificate', 'Created'], rows.map((x) => ({ cells: ['<span class="mono">' + esc(x.id.slice(-6)) + '</span>', '<span class="mono">' + esc(acctName(x.accountId)) + '</span>', '<span class="mono" style="font-size:12px">' + esc(x.identifiers.join(', ')) + '</span>', UI.pill(x.status, x.status === 'valid' ? 'ok' : x.status === 'invalid' ? 'danger' : x.status === 'ready' || x.status === 'processing' ? 'info' : 'warn'), esc(when(x.expiresAt)), x.certificateId ? '<a href="#" data-certlink="' + esc(x.certificateId) + '">' + esc(x.certificateId.slice(-6)) + '</a>' : '', esc(when(x.createdAt))], attrs: 'data-order="' + esc(x.id) + '"', selected: x.id === st.selOrder })), { minWidth: '820px', emptyTitle: D.orders.length ? 'No orders match' : 'No ACME orders yet', emptyText: D.orders.length ? 'Clear the filters to see every order.' : 'Orders appear when an ACME client asks for a certificate.' })
            + (o && o.status === 'invalid' ? UI.problem('Order ' + o.id.slice(-6) + ' is invalid', (errText(o.error) ? errText(o.error) + '. ' : '') + 'The challenge, its authorization and the order are invalid; the client places a new order after fixing the record. Orders last PKI_ACME_ORDER_HOURS.', false)
              : o ? UI.panel('Order ' + o.id.slice(-6), UI.kv([['Status', UI.pill(o.status)], ['Identifiers', '<span class="mono">' + esc(o.identifiers.join(', ')) + '</span>'], ['Challenges', o.identifiers[0] && o.identifiers[0].indexOf('*') === 0 ? 'dns-01 (wildcard)' : esc(D.acme.challenges.join(', '))], ['Expires', esc(when(o.expiresAt))]], 4) + '<span class="muted" style="font-size:12px">' + (o.status === 'pending' ? 'Waiting for the client to answer a challenge.' : o.status === 'processing' ? 'A pki.acme.validate job is checking the challenge through the service address checks.' : o.status === 'ready' ? 'Every name is proven; the client finalizes with a CSR naming exactly these names.' : 'Finalized and issued by the active intermediate.') + '</span>') : '') + '</div>';
        }
      }

      root.innerHTML = style
        + '<div class="page">' + UI.pagehead('Certificates', sub(custodyDown ? 'unavailable' : custodyText(D.info.custody)), (active ? UI.pill('issuing CA G' + active.generation + ' active', 'ok') : UI.pill('no active intermediate', 'danger')) + UI.btn('Issue certificate', { kind: 'primary', icon: 'plus', attrs: 'data-issue', disabled: !canIssue, title: !active ? 'Needs an active issuing CA' : !canIssue ? 'Needs an active profile' : '' }) + UI.btn('Sign CRL now', { attrs: 'data-crl', disabled: !active && !(st.tab === 'issuers' && issuerById(st.selIssuer)) }))
        + tabs + '<div class="vstack">' + body + '</div>'
        + '</div>'
        + (insp ? '<aside class="inspector w360 certificates-insp" aria-label="Inspector">' + insp + '</aside>' : '');

      // ---- events ----
      ctx.on('click', '[data-tab]', (e, t) => { if (t.closest('[data-subtabs]')) st.acmeTab = t.dataset.tab; else st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', 'tr[data-issuer]', (e, t) => { st.selIssuer = t.dataset.issuer; ctx.rerender(); });
      ctx.on('click', 'tr[data-cert]', (e, t) => { if (e.target.closest('a')) return; st.selCert = t.dataset.cert; st.expiryNote = false; ctx.rerender(); });
      ctx.on('click', 'tr[data-order]', (e, t) => { if (e.target.closest('a')) return; st.selOrder = t.dataset.order; ctx.rerender(); });
      ctx.on('click', 'tr[data-acct]', (e, t) => { if (e.target.closest('a,button')) return; st.selAcct = t.dataset.acct; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
      ctx.on('click', '[data-menu]', (e, t) => {
        const k = t.dataset.menu;
        if (k === 'state') menu(ctx, t, [['all', 'All states'], ['valid', 'Valid'], ['expiring', 'Expiring within 30 days'], ['revoked', 'Revoked']], st.stateFilter, (v) => { st.stateFilter = v; ctx.rerender(); });
        if (k === 'issuer') menu(ctx, t, [['all', 'Every issuer']].concat(D.issuers.filter((i) => i.kind === 'intermediate').map((i) => [i.id, i.name + ' G' + i.generation])), st.issuerFilter, (v) => { st.issuerFilter = v; ctx.rerender(); });
        if (k === 'profile') menu(ctx, t, [['all', 'Every profile']].concat(D.profiles.map((p) => [p.id, p.name])), st.profileFilter, (v) => { st.profileFilter = v; ctx.rerender(); });
        if (k === 'sort') menu(ctx, t, Object.keys(SORT_LABEL).map((s) => [s, SORT_LABEL[s]]), st.sort, (v) => { st.sort = v; ctx.rerender(); });
        if (k === 'order') menu(ctx, t, [['all', 'All statuses'], ['pending', 'Pending'], ['processing', 'Processing'], ['ready', 'Ready'], ['valid', 'Valid'], ['invalid', 'Invalid']], st.orderFilter, (v) => { st.orderFilter = v; ctx.rerender(); });
      });
      ctx.on('click', '[data-showexpiring]', () => { st.stateFilter = 'expiring'; st.sort = 'expiry'; ctx.rerender(); });
      ctx.on('click', '[data-clearproblem]', () => { st.problem = null; ctx.rerender(); });
      ctx.on('click', '[data-revealdone]', () => { if (st.revealed && st.revealed.url) URL.revokeObjectURL(st.revealed.url); st.revealed = null; ctx.rerender(); });
      ctx.on('click', '[data-p12again]', () => { if (st.revealed) download(st.revealed.url, st.revealed.file); });
      ctx.on('click', '[data-eabdone]', () => { st.revealedEab = null; ctx.rerender(); });
      ctx.on('click', '[data-copy]', (e, t) => { try { if (navigator.clipboard) navigator.clipboard.writeText(t.dataset.copy).catch(() => undefined); } catch (err) { /* clipboard unavailable */ } ctx.toast('Copied.'); });
      ctx.on('click', '[data-goplatform]', (e) => { e.preventDefault(); ctx.navigate('platform'); });
      ctx.on('click', '[data-retrycustody]', () => { st.custodyForced = false; App.get('/api/pki').then((info) => { D.info = info; ctx.rerender(); ctx.toast(info.custody === 'unavailable' ? 'Key custody is still unavailable.' : 'Custody answers again (' + esc(info.custody) + '). Key routes are back.', info.custody === 'unavailable' ? 'warn' : 'ok'); }).catch((err) => App.fail(err)); });
      ctx.on('click', '[data-issuerlink]', (e, t) => { e.preventDefault(); st.tab = 'issuers'; st.selIssuer = t.dataset.issuerlink; ctx.rerender(); });
      ctx.on('click', '[data-certlink]', (e, t) => { e.preventDefault(); st.tab = 'certs'; st.stateFilter = 'all'; st.issuerFilter = 'all'; st.profileFilter = 'all'; st.query = ''; st.selCert = t.dataset.certlink; st.expiryNote = false; ctx.rerender(); });
      ctx.on('click', '[data-acmeacct]', (e, t) => { e.preventDefault(); st.tab = 'acme'; st.acmeTab = 'accounts'; st.selAcct = t.dataset.acmeacct; ctx.rerender(); });
      ctx.on('click', '[data-acctorders]', (e, t) => { e.preventDefault(); st.acmeTab = 'orders'; st.orderAcct = t.dataset.acctorders; st.orderFilter = 'all'; ctx.rerender(); });
      ctx.on('click', '[data-clearacct]', () => { st.orderAcct = null; ctx.rerender(); });
      ctx.on('click', '[data-openprofile]', (e, t) => { e.preventDefault(); st.tab = 'profiles'; ctx.rerender(); const card = ctx.$('[data-profilecard="' + t.dataset.openprofile + '"]'); if (card) { card.style.outline = '2px solid var(--accent)'; card.scrollIntoView({ block: 'nearest' }); setTimeout(() => { card.style.outline = ''; }, 1500); } });

      // issuers
      ctx.on('click', '[data-newroot]', () => newIssuerModal(ctx, 'root', quiet));
      ctx.on('click', '[data-newint]', () => newIssuerModal(ctx, 'intermediate', quiet));
      ctx.on('click', '[data-rotate]', () => { const i = issuerById(st.selIssuer); if (i) rotateModal(ctx, i, D, quiet); });
      ctx.on('click', '[data-reissue]', () => {
        const i = issuerById(st.selIssuer); if (!i) return;
        ctx.modal({ title: 'Reissue ' + esc(i.name) + ' G' + i.generation + ' ' + UI.pill('same key', 'info'), body: '<p class="fg2" style="margin:0">The same key gets a new serial and validity' + (i.kind === 'intermediate' ? ', signed by the current root' : '') + '. Certificates issued before still verify. Needs a recent sign-in.</p>' + UI.field('Validity (days)', UI.input(i.kind === 'root' ? '3650' : '1825', { type: 'number', attrs: 'data-rdays min="7" max="9125"' })) + UI.kv([['Issuer', esc(i.name)], ['Current serial', '<span class="mono" style="overflow-wrap:anywhere">' + esc(i.serial) + '</span>']], 2),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reissue', { kind: 'primary', attrs: 'data-doreissue' }),
          onMount(m) { m.querySelector('[data-doreissue]').addEventListener('click', async () => {
            const days = parseInt(m.querySelector('[data-rdays]').value, 10); App.closeOverlay();
            try { const out = await withStepUp(ctx, () => App.post('/api/pki/issuers/' + enc(i.id) + '/reissue', days ? { days } : {})); if (!out) return; ctx.toast(esc(i.name) + ' reissued with serial ' + esc(out.serial) + '. Audited pki.issuer.reissued.', 'ok', 5000); quiet(); }
            catch (err) { App.fail(err, 'Not reissued'); }
          }); } });
      });
      ctx.on('click', '[data-crl]', async () => {
        const i = (st.tab === 'issuers' && issuerById(st.selIssuer)) || active; if (!i) return;
        try { const out = await App.post('/api/pki/issuers/' + enc(i.id) + '/crl'); ctx.toast('pki.crl job queued for ' + esc(i.name) + ' (202, job ' + esc(String(out.jobId).slice(-6)) + '). The next CRL follows in a moment.', 'ok', 5000); setTimeout(quiet, 1500); }
        catch (err) { App.fail(err, 'CRL not queued'); }
      });
      ctx.on('click', '[data-revokeissuer]', () => {
        const i = issuerById(st.selIssuer); if (!i) return;
        ctx.modal({ title: 'Revoke ' + esc(i.name) + ' G' + i.generation + ' ' + UI.pill('stops issuance', 'danger'), body: '<p class="fg2" style="margin:0">Every certificate under it stops verifying once relying parties see the root\'s next CRL (a pki.crl job is queued now). The tenant has no issuing CA until a new intermediate is created. Needs a recent sign-in.</p>' + UI.field('Reason', UI.select(ISSUER_REASONS, 'cACompromise', 'data-ireason')) + UI.kv([['Issuer', esc(i.name)], ['Issued certificates', String(D.certs.filter((c) => c.issuerId === i.id).length)]], 2),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Revoke issuer', { kind: 'danger', attrs: 'data-dorevokeissuer' }),
          onMount(m) { m.querySelector('[data-dorevokeissuer]').addEventListener('click', async () => {
            const reason = m.querySelector('[data-ireason]').value; App.closeOverlay();
            try { const out = await withStepUp(ctx, () => App.post('/api/pki/issuers/' + enc(i.id) + '/revoke', { reason })); if (!out) return; ctx.toast(esc(i.name) + ' revoked (' + esc(reason) + '). Listed on the root\'s next CRL; audited pki.issuer.revoked.', 'danger', 5000); quiet(); }
            catch (err) { App.fail(err, 'Issuer not revoked'); }
          }); } });
      });

      // certificates
      ctx.on('click', '[data-issue]', () => issueModal(ctx, D, active, quiet));
      ctx.on('click', '[data-renew]', () => {
        const c = D.certs.find((x) => x.id === st.selCert); if (!c) return; let revokeOld = true;
        ctx.modal({ title: 'Renew ' + esc(c.commonName || c.serial), body: '<p class="fg2" style="margin:0">A new certificate for the same names under <b>' + esc((profileById(c.profileId) || {}).name || 'its profile') + '</b>, from the active intermediate. Without a CSR it keeps the old certificate\'s key.</p><div class="formgrid">' + UI.field('CSR (optional)', UI.textarea('', { placeholder: '-----BEGIN CERTIFICATE REQUEST-----', rows: 3, attrs: 'data-rncsr' })) + UI.field('Days', UI.input(String((profileById(c.profileId) || {}).defaultDays || ''), { type: 'number', attrs: 'data-rndays min="1"' })) + '</div>' + UI.toggle('Revoke the old certificate as superseded', true, 'data-revokeold'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Renew', { kind: 'primary', attrs: 'data-dorenew' }),
          onMount(m) {
            m.querySelector('[data-revokeold]').addEventListener('click', () => { revokeOld = !revokeOld; });
            m.querySelector('[data-dorenew]').addEventListener('click', async () => {
              const csr = m.querySelector('[data-rncsr]').value.trim(); const days = parseInt(m.querySelector('[data-rndays]').value, 10);
              const b = { revokeOld }; if (csr) b.csr = csr; if (days) b.days = days;
              try {
                const out = await App.post('/api/pki/certificates/' + enc(c.id) + '/renew', b); App.closeOverlay();
                st.selCert = out.id; st.expiryNote = false; st.stateFilter = 'all'; st.query = '';
                ctx.toast(esc(c.commonName || c.serial) + ' renewed' + (out.revokedOld ? '; the old one is revoked as superseded' : '') + (out.clamped ? '; validity clamped to the issuer\'s' : '') + '. Audited pki.certificate.renewed.', 'ok', 5000); quiet();
              } catch (err) { App.fail(err, 'Not renewed'); }
            });
          } });
      });
      ctx.on('click', '[data-revokecert]', () => {
        const c = D.certs.find((x) => x.id === st.selCert); if (!c) return;
        ctx.modal({ title: 'Revoke ' + esc(c.commonName || c.serial) + ' ' + UI.pill('RFC 5280', 'danger'), body: '<p class="fg2" style="margin:0">Cached OCSP answers are dropped on every instance and the issuer\'s next CRL is queued. Holds and removeFromCRL are not supported; cACompromise is for issuers.</p><div class="formgrid">' + UI.field('Reason', UI.select(REASONS, 'keyCompromise', 'data-reason')) + UI.field('Invalidity date (optional)', UI.input('', { type: 'date', attrs: 'data-invalidity' })) + '</div>' + UI.kv([['Serial', '<span class="mono" style="overflow-wrap:anywhere">' + esc(c.serial) + '</span>'], ['Profile', esc((profileById(c.profileId) || {}).name || '')], ['Expires', esc(day(c.notAfter))]], 2),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Revoke', { kind: 'danger', attrs: 'data-dorevokecert' }),
          onMount(m) { m.querySelector('[data-dorevokecert]').addEventListener('click', async () => {
            const reason = m.querySelector('[data-reason]').value; const inv = m.querySelector('[data-invalidity]').value;
            const b = { reason }; if (inv) { const t = new Date(inv + 'T00:00:00').getTime(); if (t > Date.now()) { ctx.toast('The invalidity date cannot be in the future.', 'warn'); return; } b.invalidityDate = t; }
            try { await App.post('/api/pki/certificates/' + enc(c.id) + '/revoke', b); App.closeOverlay(); ctx.toast(esc(c.commonName || c.serial) + ' revoked (' + esc(reason) + '). OCSP answers revoked now; the issuer\'s next CRL is queued.', 'danger', 5000); quiet(); }
            catch (err) { App.fail(err, 'Not revoked'); }
          }); } });
      });
      ctx.on('click', '[data-export]', (e, t) => menu(ctx, t, [['pem', 'PEM (application/x-pem-file)'], ['der', 'DER (application/pkix-cert)'], ['chain', 'Chain up to the root (PEM)']], null, (v) => { download('/api/pki/certificates/' + enc(st.selCert) + '/export?format=' + v); ctx.toast('Download started (' + esc(v) + '). Audited as an export.', 'ok'); }));
      ctx.on('click', '[data-p12]', () => {
        const c = D.certs.find((x) => x.id === st.selCert); if (!c) return;
        ctx.modal({ title: 'PKCS#12 for ' + esc(c.commonName || c.serial), body: '<p class="fg2" style="margin:0">The certificate and its chain as a PKCS#12 file: PBES2 with PBKDF2-HMAC-SHA256 (100,000 iterations) and AES-256-CBC, HMAC-SHA256 integrity. It holds no private key; the CA never had it.</p>' + UI.field('Password', UI.input('', { type: 'password', placeholder: '8 to 200 characters', attrs: 'data-p12pw autocomplete="new-password"' })),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Download', { kind: 'primary', attrs: 'data-dop12' }),
          onMount(m) { m.querySelector('[data-dop12]').addEventListener('click', async () => {
            const pw = m.querySelector('[data-p12pw]').value; if (pw.length < 8) { ctx.toast('The password needs at least 8 characters.', 'warn'); return; }
            try {
              const res = await fetch('/api/pki/certificates/' + enc(c.id) + '/pkcs12', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': App.state.csrf || '' }, body: JSON.stringify({ password: pw }) });
              if (!res.ok) { let p = {}; try { p = await res.json(); } catch (x) { /* not json */ } throw new App.ApiError(Object.assign({ status: res.status }, p)); }
              const url = URL.createObjectURL(await res.blob()); download(url, fileOf(c) + '.p12'); setTimeout(() => URL.revokeObjectURL(url), 60000);
              App.closeOverlay(); ctx.toast('Download started: ' + esc(fileOf(c)) + '.p12 (application/x-pkcs12).', 'ok');
            } catch (err) { App.fail(err, 'No PKCS#12 file'); }
          }); } });
      });

      // profiles
      ctx.on('click', '[data-newprofile]', () => profileModal(ctx, null, quiet));
      ctx.on('click', '[data-editprofile]', (e, t) => profileModal(ctx, profileById(t.dataset.editprofile), quiet));
      ctx.on('click', '[data-toggleprofile]', async (e, t) => {
        const p = profileById(t.dataset.toggleprofile); if (!p) return; const next = p.state === 'active' ? 'disabled' : 'active';
        try { await App.patch('/api/pki/profiles/' + enc(p.id), { state: next }); ctx.toast('Profile ' + esc(p.name) + ' ' + next + '. Audited pki.profile.updated.', next === 'active' ? 'ok' : 'warn'); quiet(); }
        catch (err) { App.fail(err, 'Profile not changed'); }
      });
      ctx.on('click', '[data-delprofile]', (e, t) => {
        const p = profileById(t.dataset.delprofile); if (!p) return;
        ctx.confirm({ title: 'Delete profile ' + p.name, tone: 'danger', body: '<p class="fg2" style="margin:0">No certificate was issued under it. The ACME directory cannot name it afterwards.</p>', ok: 'Delete' }).then(async (ok) => {
          if (!ok) return;
          try { await App.del('/api/pki/profiles/' + enc(p.id)); ctx.toast('Profile ' + esc(p.name) + ' deleted (204). Audited pki.profile.deleted.', 'ok'); quiet(); }
          catch (err) { App.fail(err, 'Profile not deleted'); }
        });
      });

      // acme
      const draft = () => st.acmeDraft;
      ctx.on('click', '[data-acmetoggle]', () => { draft().enabled = !draft().enabled; ctx.rerender(); });
      ctx.on('click', '[data-eabtoggle]', () => { draft().eabRequired = !draft().eabRequired; ctx.rerender(); });
      ctx.on('change', '[data-acmeprofile]', (e, t) => { draft().profileId = t.value || null; ctx.rerender(); });
      ctx.on('click', '[data-chall]', (e, t) => { const c = t.dataset.chall; const a = draft(); const i = a.challenges.indexOf(c); if (i >= 0) { if (a.challenges.length === 1) { ctx.toast('Keep at least one challenge type.', 'warn'); return; } a.challenges.splice(i, 1); } else a.challenges.push(c); ctx.rerender(); });
      ctx.on('click', '[data-acmesave]', async () => {
        const a = draft();
        try { const out = await App.api('PUT', '/api/pki/acme', { enabled: a.enabled, profileId: a.profileId || null, eabRequired: a.eabRequired, challenges: a.challenges }); D.acme = out; st.acmeDraft = null; ctx.rerender(); ctx.toast('ACME settings saved. Audited pki.acme.settings.updated. The directory ' + (out.enabled ? 'answers at ' + esc(out.directoryUrl || '') : 'is closed (404)') + '.', 'ok', 5000); }
        catch (err) { App.fail(err, 'ACME settings not saved'); }
      });
      ctx.on('click', '[data-neweab]', () => ctx.modal({ title: 'Create EAB key', body: '<p class="fg2" style="margin:0">An external account binding key (RFC 8555 7.3.4). The HMAC key is shown once and binds one account.</p>' + UI.field('Name', UI.input('', { placeholder: 'e.g. traefik edge', attrs: 'data-eabname maxlength="100"' })),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-doeab' }),
        onMount(m) { m.querySelector('[data-doeab]').addEventListener('click', async () => {
          const name = m.querySelector('[data-eabname]').value.trim(); if (!name) { ctx.toast('Name the client this key is for.', 'warn'); return; }
          try { const out = await App.post('/api/pki/acme/eab-keys', { name }); App.closeOverlay(); st.revealedEab = { name, kid: out.kid, hmacKey: out.hmacKey }; ctx.toast('EAB key created. Audited pki.acme.eab.created.', 'ok'); quiet(); }
          catch (err) { App.fail(err, 'EAB key not created'); }
        }); } }));
      ctx.on('click', '[data-revokeeab]', (e, t) => {
        const k = D.eab.find((x) => x.id === t.dataset.revokeeab); if (!k) return;
        ctx.confirm({ title: 'Revoke EAB key ' + k.name, tone: 'danger', body: '<p class="fg2" style="margin:0">The key can no longer bind an account.' + (k.accountId ? ' The account it bound stays valid.' : '') + '</p>', ok: 'Revoke' }).then(async (ok) => {
          if (!ok) return;
          try { await App.post('/api/pki/acme/eab-keys/' + enc(k.id) + '/revoke'); ctx.toast('EAB key revoked. Audited pki.acme.eab.revoked.', 'ok'); quiet(); }
          catch (err) { App.fail(err, 'EAB key not revoked'); }
        });
      });
      ctx.on('click', '[data-revokeacct]', (e, t) => {
        const ac = D.accounts.find((x) => x.id === t.dataset.revokeacct); if (!ac) return;
        const open = D.orders.filter((o) => o.accountId === ac.id && (o.status === 'pending' || o.status === 'ready' || o.status === 'processing'));
        ctx.confirm({ title: 'Revoke account ' + ac.id.slice(-6), tag: 'RFC 8555', tone: 'danger', body: '<p class="fg2" style="margin:0">The account is revoked by the server. Its ' + open.length + ' pending and ready orders become invalid; certificates it already holds stay valid.</p>', kv: [['Contact', esc([].concat(ac.contact || []).join(', ') || 'none')], ['Orders', String(D.orders.filter((o) => o.accountId === ac.id).length)]], ok: 'Revoke account' }).then(async (ok) => {
          if (!ok) return;
          try { await App.post('/api/pki/acme/accounts/' + enc(ac.id) + '/revoke'); ctx.toast('Account ' + esc(ac.id.slice(-6)) + ' revoked; its open orders are invalid. Audited pki.acme.account.revoked.', 'danger'); quiet(); }
          catch (err) { App.fail(err, 'Account not revoked'); }
        });
      });

      // palette commands
      if (st.openIssue) { st.openIssue = false; if (canIssue) issueModal(ctx, D, active, quiet); else ctx.toast(active ? 'There is no active profile to issue under.' : 'There is no active issuing CA to issue from.', 'warn'); }
      if (st.openCrl) { st.openCrl = false; const b = ctx.$('[data-crl]'); if (b && !b.disabled) b.click(); else ctx.toast('There is no issuer to sign a CRL for.', 'warn'); }
    }
  });

  function newIssuerModal(ctx, kind, done) {
    const isRoot = kind === 'root';
    ctx.modal({ title: isRoot ? 'Create root CA' : 'Create issuing CA', body: '<p class="fg2" style="margin:0">' + (isRoot ? 'The platform root: self-signed, a CA with no path length, keyCertSign and cRLSign. Its key is made in the signer process or OpenBao transit and never leaves it. Needs platform:manage and a recent sign-in.' : 'This tenant\'s issuing CA, signed by the active root: pathLen 0, with the CRL distribution point and the OCSP and caIssuers URLs. Its validity never passes the root\'s.') + '</p>'
      + '<div class="formgrid">' + UI.field('Common name', UI.input(isRoot ? 'Platform Root CA' : '', { placeholder: isRoot ? '' : ((App.me && App.me.tenant && App.me.tenant.name) || 'Tenant') + ' Issuing CA', attrs: 'data-incn maxlength="64"' })) + UI.field('Organization (optional)', UI.input('', { attrs: 'data-inorg maxlength="64"' }))
      + UI.field('Key type', UI.select(['ecdsa-p256', 'rsa-3072'], 'ecdsa-p256', 'data-inkey')) + UI.field('Validity (days)', UI.input(isRoot ? '3650' : '1825', { type: 'number', attrs: 'data-indays' }), isRoot ? '30 to 9125' : '7 to 3650') + '</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(isRoot ? 'Create root' : 'Create issuing CA', { kind: 'primary', attrs: 'data-doissuer' }),
      onMount(m) { m.querySelector('[data-doissuer]').addEventListener('click', async () => {
        const cn = m.querySelector('[data-incn]').value.trim(); const org = m.querySelector('[data-inorg]').value.trim();
        if (isRoot && !cn) { ctx.toast('The root needs a common name.', 'warn'); return; }
        const b = { kind, keyType: m.querySelector('[data-inkey]').value }; const days = parseInt(m.querySelector('[data-indays]').value, 10);
        if (cn) b.commonName = cn; if (org) b.organization = org; if (days) b.days = days;
        App.closeOverlay();
        try {
          const out = await withStepUp(ctx, () => App.post('/api/pki/issuers', b)); if (!out) return;
          ctx.state.selIssuer = out.id; ctx.toast(esc(out.name) + ' created (201). Audited ' + (isRoot ? 'pki.root.created' : 'pki.intermediate.created') + '.', 'ok', 5000); done();
        } catch (err) { App.fail(err, isRoot ? 'Root not created' : 'Issuing CA not created'); }
      }); } });
  }

  function rotateModal(ctx, i, D, done) {
    ctx.modal({ title: 'Rotate ' + esc(i.name) + ' G' + i.generation + ' ' + UI.pill('new key', 'info'), body: '<p class="fg2" style="margin:0">A new key and certificate in ' + esc(custodyText(i.custody)) + ' (generation ' + (i.generation + 1) + '). The current issuer becomes retired with replacedBy, stops issuing and keeps serving its CRL and OCSP, so certificates it issued stay verifiable. Needs a recent sign-in.</p>' + UI.field('Validity (days)', UI.input(i.kind === 'root' ? '3650' : '1825', { type: 'number', attrs: 'data-rodays' })) + UI.kv([['Issuer', esc(i.name)], ['Key type', esc(i.keyType)], ['Issued under it', String(D.certs.filter((c) => c.issuerId === i.id).length)]], 2),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Rotate', { kind: 'primary', attrs: 'data-dorotate' }),
      onMount(m) { m.querySelector('[data-dorotate]').addEventListener('click', async () => {
        const days = parseInt(m.querySelector('[data-rodays]').value, 10); App.closeOverlay();
        try {
          const out = await withStepUp(ctx, () => App.post('/api/pki/issuers/' + encodeURIComponent(i.id) + '/rotate', days ? { days } : {})); if (!out) return;
          ctx.state.selIssuer = out.id; ctx.toast(esc(i.name) + ' rotated to generation ' + out.generation + '. G' + i.generation + ' is retired: it stops issuing and keeps serving its CRL and OCSP. Audited pki.issuer.rotated.', 'ok', 5000); done();
        } catch (err) { App.fail(err, 'Not rotated'); }
      }); } });
  }

  function issueModal(ctx, D, active, done) {
    const st = ctx.state; if (!active) return;
    const profiles = D.profiles.filter((p) => p.state === 'active');
    let mode = 'csr';
    const form = { csr: '', keyType: 'ec-p256', password: '', profileId: (profiles[0] || {}).id, days: '', cn: '', sans: '' };
    const FIELDS = [['csr', 'data-csr'], ['keyType', 'data-ikey'], ['password', 'data-genpw'], ['profileId', 'data-iprofile'], ['days', 'data-idays'], ['cn', 'data-icn'], ['sans', 'data-isans']];
    const keep = (el) => FIELDS.forEach((f) => { const x = el.querySelector('[' + f[1] + ']'); if (x) form[f[0]] = x.value; });
    const body = () => { const prof = profiles.find((p) => p.id === form.profileId) || profiles[0] || {}; return UI.seg([{ id: 'csr', label: 'From a CSR' }, { id: 'generate', label: 'Generate the key here' }], mode, 'data-issuemode aria-label="How the key is made"')
      + '<div class="formgrid">' + (mode === 'csr' ? '<div class="span2">' + UI.field('CSR (PEM PKCS#10)', UI.textarea(form.csr, { placeholder: '-----BEGIN CERTIFICATE REQUEST-----\nMIIC…', rows: 4, attrs: 'data-csr' }), 'Its self-signature must verify (400, step csr). Keys: P-256, P-384, RSA 2048 to 4096, Ed25519, as the profile allows.') + '</div>' : UI.field('Key type', UI.select(KEY_TYPES.filter((k) => k !== 'ed25519'), form.keyType, 'data-ikey')) + UI.field('PKCS#12 password', UI.input(form.password, { type: 'password', placeholder: '8 to 200 characters', attrs: 'data-genpw autocomplete="new-password"' }), 'The key is made here, bundled with the certificate and chain, returned once and never stored'))
      + UI.field('Profile', UI.select(profiles.map((p) => ({ value: p.id, label: p.name + ' (' + p.kind + ')' })), form.profileId, 'data-iprofile')) + UI.field('Days', UI.input(form.days, { type: 'number', placeholder: String(prof.defaultDays || ''), attrs: 'data-idays min="1"' }), 'Over the profile\'s maximum (' + (prof.maxDays || '') + ') is 422; never past the issuer\'s expiry (clamped)')
      + (mode === 'generate' ? UI.field('Common name', UI.input(form.cn, { placeholder: 'host.example.internal', attrs: 'data-icn maxlength="64"' })) : '') + '<div class="span2">' + UI.field('Subject alternative names', UI.input(form.sans, { placeholder: 'dns:host.example.internal, ip:10.20.4.30', attrs: 'data-isans' }), 'Else the CSR\'s subjectAltName, else (server profiles) its CN. Each name is checked against the profile.') + '</div></div>'
      + UI.notice('Issued at once by <b>' + esc(active.name) + ' G' + active.generation + '</b>. A name outside the profile is refused with 422 (step names) and audited as pki.issue.refused.', 'info'); };
    ctx.modal({ title: 'Issue certificate', cls: 'wide', body: '<div data-issuebody class="vstack gap12">' + body() + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Issue', { kind: 'primary', attrs: 'data-doissue' }), onMount(el) {
      const host = el.querySelector('[data-issuebody]');
      const redraw = (focusSel) => { keep(host); host.innerHTML = body(); App.a11yPass(host); wire(); const f = host.querySelector(focusSel); if (f) f.focus(); };
      function wire() {
        host.querySelectorAll('[data-issuemode] [data-seg]').forEach((b) => b.addEventListener('click', () => { keep(host); mode = b.dataset.seg; redraw('[data-seg="' + mode + '"]'); }));
        const ps = host.querySelector('[data-iprofile]'); if (ps) ps.addEventListener('change', () => redraw('[data-iprofile]'));
      }
      wire();
      el.querySelector('[data-doissue]').addEventListener('click', async () => {
        keep(host);
        const b = { profileId: form.profileId }; const days = parseInt(form.days, 10); if (days) b.days = days;
        try { const sans = parseSans(form.sans); if (sans.length) b.sans = sans; } catch (e) { ctx.toast(esc(e.message), 'warn', 6000); return; }
        if (mode === 'csr') { if (!/BEGIN CERTIFICATE REQUEST/.test(form.csr)) { ctx.toast('Paste a PEM certificate request (-----BEGIN CERTIFICATE REQUEST-----).', 'warn'); return; } b.csr = form.csr.trim(); }
        else { if (form.password.length < 8) { ctx.toast('The PKCS#12 password needs at least 8 characters.', 'warn'); return; } if (!b.sans && !form.cn.trim()) { ctx.toast('Name the certificate with a common name or subject alternative names.', 'warn'); return; } b.generateKey = { keyType: form.keyType, password: form.password }; if (form.cn.trim()) b.commonName = form.cn.trim(); }
        const btn = el.querySelector('[data-doissue]'); btn.disabled = true;
        try {
          const out = await App.post('/api/pki/issuers/' + encodeURIComponent(active.id) + '/issue', b);
          App.closeOverlay();
          Object.assign(st, { selCert: out.id, stateFilter: 'all', issuerFilter: 'all', profileFilter: 'all', query: '', problem: null, tab: 'certs' });
          if (out.pkcs12) { const url = URL.createObjectURL(b64Blob(out.pkcs12, 'application/x-pkcs12')); const file = fileOf(out) + '.p12'; download(url, file); st.revealed = { url, file, title: (out.commonName || out.serial) + ' issued with a generated key.', text: 'The PKCS#12 bundle was downloaded once and is not stored; audited pki.certificate.issued with keyGenerated true.' }; }
          ctx.toast(esc(out.commonName || out.serial) + ' issued by ' + esc(active.name) + ' G' + active.generation + ' until ' + esc(day(out.notAfter)) + (out.clamped ? ' (clamped to the issuer\'s validity)' : '') + ' (201). Audited pki.certificate.issued.', 'ok', 6000);
          done();
        } catch (err) {
          btn.disabled = false;
          const p = err.problem || {};
          if (err.status === 422 && p.step === 'names') {
            App.closeOverlay();
            const prof = D.profiles.find((x) => x.id === b.profileId) || {};
            st.lastRefusal = { title: 'Name refused by profile ' + (prof.name || ''), text: (p.detail || 'A name is outside the profile.') + (p.name ? ' (' + p.name.type + ' name ' + p.name.value + ')' : '') + '. 422, step: names. Nothing was issued; the refusal is audited as pki.issue.refused. Fix the CSR or ask a pki admin to widen the profile.', trace: p.trace_id || false, profileId: prof.id };
            st.problem = st.lastRefusal; st.tab = 'certs'; ctx.rerender();
            return;
          }
          App.fail(err, 'Not issued');
        }
      });
    } });
  }

  function profileModal(ctx, p, done) {
    const isNew = !p;
    const v = p || { name: '', kind: 'server', maxDays: 398, defaultDays: 90, policy: { domains: [], allowWildcard: false, ipRanges: [], emailDomains: [], uriPrefixes: [], keyTypes: ['ec-p256', 'ec-p384', 'rsa-2048', 'rsa-3072', 'rsa-4096'] } };
    ctx.modal({ title: isNew ? 'New profile' : 'Edit profile ' + esc(v.name), cls: 'wide', body: '<div class="formgrid">' + UI.field('Name', UI.input(v.name, { attrs: 'data-pname maxlength="100"', readonly: !isNew })) + UI.field('Kind', UI.select(['server', 'client', 'code-signing'], v.kind, 'data-pkind' + (isNew ? '' : ' disabled')), 'server: 398 days at most; client: 825; code-signing: 1185') + UI.field('Max days', UI.input(String(v.maxDays), { type: 'number', attrs: 'data-pmax min="1"' })) + UI.field('Default days', UI.input(String(v.defaultDays), { type: 'number', attrs: 'data-pdef min="1"' }))
      + UI.field('Domains', UI.input(v.policy.domains.join(', '), { placeholder: '*.example.internal, ai.example.internal', attrs: 'data-pdom' }), '*.domain allows every name below it') + UI.field('IP ranges (CIDR)', UI.input(v.policy.ipRanges.join(', '), { attrs: 'data-pip' })) + UI.field('Email domains', UI.input(v.policy.emailDomains.join(', '), { attrs: 'data-pmail' })) + UI.field('URI prefixes', UI.input(v.policy.uriPrefixes.join(', '), { attrs: 'data-puri' })) + '<div class="span2">' + UI.field('Key types', UI.input(v.policy.keyTypes.join(', '), { attrs: 'data-pkeys' }), 'Of ' + KEY_TYPES.join(', ')) + '</div></div>' + UI.toggle('Allow wildcard names (also needs dns-01 for ACME)', v.policy.allowWildcard, 'data-pwild'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(isNew ? 'Create' : 'Save', { kind: 'primary', attrs: 'data-psave' }),
      onMount(m) { m.querySelector('[data-psave]').addEventListener('click', async () => {
        const name = m.querySelector('[data-pname]').value.trim(); if (!name) { ctx.toast('A profile needs a name.', 'warn'); return; }
        const kind = m.querySelector('[data-pkind]').value; const cap = KIND_CAP[kind];
        const maxDays = parseInt(m.querySelector('[data-pmax]').value, 10) || cap; const defaultDays = parseInt(m.querySelector('[data-pdef]').value, 10) || maxDays;
        const policy = { domains: list(m.querySelector('[data-pdom]').value), ipRanges: list(m.querySelector('[data-pip]').value), emailDomains: list(m.querySelector('[data-pmail]').value), uriPrefixes: list(m.querySelector('[data-puri]').value), keyTypes: list(m.querySelector('[data-pkeys]').value), allowWildcard: m.querySelector('[data-pwild]').classList.contains('on') };
        try {
          if (isNew) await App.post('/api/pki/profiles', { name, kind, maxDays, defaultDays, policy });
          else await App.patch('/api/pki/profiles/' + encodeURIComponent(p.id), { maxDays, defaultDays, policy });
          App.closeOverlay(); ctx.toast('Profile ' + esc(name) + (isNew ? ' created (201). Audited pki.profile.created.' : ' saved. Audited pki.profile.updated.'), 'ok'); done();
        } catch (err) { App.fail(err, isNew ? 'Profile not created' : 'Profile not saved'); }
      }); } });
  }
})();
