(function () {
  const { UI, esc } = App;

  // ---------- formatting ----------
  const enc = encodeURIComponent;
  const when = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const overlayOpen = () => !!document.getElementById('overlay');
  const list = (v) => String(v || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const mono = (s, size) => '<span class="mono atproto-wrap"' + (size ? ' style="font-size:' + size + 'px"' : '') + '>' + esc(s) + '</span>';
  const valPill = (v) => UI.pill(v, v === '!hide' || v === '!takedown' ? 'danger' : v === '!warn' ? 'warn' : 'outline');
  const ws = () => (App.DATA.workspaces || []).filter((w) => w.id);
  const wsName = (id) => { const w = ws().find((x) => x.id === id); return w ? w.name : id ? 'workspace ' + id.slice(-6) : 'none'; };
  const wsOptions = (none) => (none ? [{ value: '', label: 'None' }] : []).concat(ws().map((w) => ({ value: w.id, label: w.name })));
  const errOf = (e) => (e && e.problem && (e.problem.detail || e.problem.title)) || (e && e.message) || 'Request failed';
  const problemOf = (e) => UI.problem(((e && e.problem && e.problem.title) || 'Request failed') + (e && e.status ? ' (' + e.status + (e.problem && e.problem.step ? ', step ' + e.problem.step : '') + ')' : ''), errOf(e), (e && e.problem && e.problem.trace_id) || false);
  const DEFAULT_VALS = ['!hide', '!warn', 'porn', 'sexual', 'nudity', 'graphic-media', 'spam'];
  const TAB_PERM = { identity: ['pki:manage'], labels: ['labels:manage'], labelers: ['labels:manage'], firehose: ['firehose:manage'], accounts: ['identity:manage'], pds: ['pds:manage', 'firehose:manage'] };
  const allowed = (tab) => App.can(TAB_PERM[tab]);
  const retentionText = (h) => (h % 24 === 0 ? (h / 24) + (h === 24 ? ' day' : ' days') : h + ' hours');
  const rankingText = (r) => (!r ? 'none (newest first)' : r.kind === 'embedding' ? 'profile ' + r.profile + ' (embeddings)' : 'classifier ' + r.classifier + ' (' + r.label + ')');
  const rulesText = (r) => {
    r = r || {};
    const parts = [r.authors && r.authors.length ? 'authors: ' + r.authors.length + ' watched' : 'authors: anyone', 'collections: ' + (r.collections || ['app.bsky.feed.post']).join(', '), r.keywords && r.keywords.length ? 'keywords: ' + r.keywords.join(', ') : 'keywords: any text'];
    if (r.labels && r.labels.length) parts.push('labels: ' + r.labels.join(', '));
    parts.push('labels exclude: ' + ((r.excludeLabels && r.excludeLabels.length) ? r.excludeLabels.join(', ') : 'none'));
    return parts.join('; ');
  };
  /** The board's rule lines ("keywords: audit, evidence") as the API's rules object. */
  const parseRules = (text) => {
    const out = {};
    String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
      const m = /^([a-z ]+):\s*(.*)$/i.exec(line);
      if (!m) throw new Error('Write each rule as "name: values", for example "keywords: audit, evidence" ("' + line + '").');
      const key = m[1].trim().toLowerCase(); const vals = list(m[2]);
      if (key === 'authors') out.authors = vals.length ? vals : null;
      else if (key === 'collections') { if (vals.length) out.collections = vals; }
      else if (key === 'keywords') out.keywords = vals.length ? vals : null;
      else if (key === 'labels') out.labels = vals.length ? vals : null;
      else if (key === 'labels exclude' || key === 'exclude labels' || key === 'exclude') out.excludeLabels = vals;
      else throw new Error('Unknown rule "' + key + '": use authors, collections, keywords, labels or labels exclude.');
    });
    return out;
  };

  function menu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative') || anchor.parentElement; const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    host.classList.add('relative');
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  // ---------- step-up (B-106): switching PDS hosting needs platform:manage and a recent sign-in ----------
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
          catch (e) { err.innerHTML = UI.notice(esc(errOf(e)), 'danger'); }
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

  // ---------- loading ----------
  /** Everything the screen shows, read with the permissions the user has (each tab needs its own). */
  function fetchAll() {
    const can = (p) => App.can(p);
    const none = (v) => Promise.resolve(v);
    const keysOrLabels = can('pki:manage') || can('labels:manage');
    return (keysOrLabels ? App.get('/api/atproto') : none(null)).then((info) => Promise.all([
      info,
      can('pki:manage') && info && info.identity ? App.get('/api/atproto/identity') : none(null),
      can('labels:manage') ? App.get('/api/atproto/labels?limit=200').then((r) => r.labels) : none([]),
      can('labels:manage') ? App.get('/api/atproto/labelers').then((r) => r.labelers) : none([]),
      can('firehose:manage') ? App.get('/api/atproto/firehose').then((r) => r.subscriptions) : none([]),
      can('identity:manage') ? App.get('/api/admin/atproto/accounts?limit=500') : none([]),
      can('identity:manage') ? App.get('/api/admin/identity-providers').catch(() => []) : none([]),
      can('pds:manage') ? App.get('/api/admin/pds') : none(null),
      can('pds:manage') ? App.get('/api/admin/pds/accounts?limit=200').then((r) => r.accounts) : none([]),
      can('pds:manage') ? App.get('/api/admin/pds/feed-generators').then((r) => r.records) : none([]),
      can('firehose:manage') ? App.get('/api/atproto/feeds') : none({ generator: null, feeds: [] })
    ])).then((r) => ({ info: r[0], identity: r[1], labels: r[2], labelers: r[3], subs: r[4], bindings: r[5], providers: r[6], pds: r[7], pdsAccounts: r[8], records: r[9], generator: r[10].generator, feeds: r[10].feeds }));
  }

  let poll = null;

  App.register({
    id: 'atproto', title: 'AT-Protocol', live: true, section: 'admin', crumb: ['Admin', 'AT-Protocol'],
    summary: 'Service DID and keys, labels and trusted labelers, firehose subscriptions, DID bindings, PDS accounts and feed generators',
    label: (st) => (st.tab === 'firehose' ? 'internal' : null),
    commands: [
      { label: 'Rotate the label key', sub: 'AT-Protocol', run(app) { const s = app.stateFor('atproto'); s.tab = 'identity'; s.openRotate = true; app.render(); } },
      { label: 'Check an AT-Protocol account', sub: 'AT-Protocol', run(app) { const s = app.stateFor('atproto'); s.tab = 'accounts'; s.openCheck = true; app.render(); } }
    ],
    states: [
      { title: 'Custody unavailable', tone: 'danger', text: 'Without the signer process or OpenBao transit, every key-making route answers 409 with step custody. Reading still works.',
        apply(ctx) { const st = ctx.state; st.tab = 'identity'; st.custodyForced = true; ctx.rerender(); } },
      { title: 'Key rotated, document updated', tone: 'ok', text: 'A new label key in custody; the old one is retired. The did:web document changes at once; labels signed with the retired key are re-signed when next served.',
        apply(ctx) { const st = ctx.state; st.tab = 'identity'; st.custodyForced = false; const idn = st.data && st.data.identity; if (idn) st.docUpdated = when(idn.updatedAt); else ctx.toast('This tenant has no AT-Protocol identity yet. Create one, then rotate its label key.', 'warn', 5000); ctx.rerender(); } },
      { title: 'Labeler label rejected', tone: 'warn', text: 'A pulled label whose signature does not verify against the labeler key is dropped and audited atproto.label.rejected (reason signature).',
        apply(ctx) { const st = ctx.state; st.tab = 'labelers'; const l = ((st.data && st.data.labelers) || []).find((x) => x.rejected > 0 || x.lastError); if (l) st.labeler = l.id; else ctx.toast('No trusted labeler has rejected a label.', 'ok'); ctx.rerender(); } },
      { title: 'Firehose in backoff', tone: 'warn', text: 'An error frame or a disconnect reconnects from the stored cursor with backoff; lastError shows the frame.',
        apply(ctx) { const st = ctx.state; st.tab = 'firehose'; const s = ((st.data && st.data.subs) || []).find((x) => x.status === 'backoff' || x.status === 'error' || x.lastError); if (s) st.sub = s.id; else ctx.toast('No subscription is in backoff.', 'ok'); ctx.rerender(); } },
      { title: 'Handle resolves to a refused address', tone: 'danger', text: 'A handle, PDS or authorization server that resolves to a link-local or metadata address is refused (422, step handle, reason refused) and never fetched.',
        apply(ctx) { const st = ctx.state; st.tab = 'accounts'; st.openCheck = true; st.checkAccount = 'evil.metadata.example'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const DEFAULTS = { valFilter: 'all', accFilter: 'all', lq: '', lsort: 'newest' };
      Object.keys(DEFAULTS).forEach((k) => { if (st[k] === undefined) st[k] = DEFAULTS[k]; });
      const tabIds = ['identity', 'labels', 'labelers', 'firehose', 'accounts', 'pds'].filter(allowed);
      if (ctx.params.sub) { st.tab = 'firehose'; st.sub = ctx.params.sub; delete ctx.params.sub; }
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }
      if (tabIds.indexOf(st.tab) < 0) st.tab = tabIds[0];

      const refresh = () => {
        if (App.state.route !== 'atproto') return;
        if (overlayOpen()) { st.dirty = true; return; }
        const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0;
        ctx.rerender();
        const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top;
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        fetchAll().then((data) => { Object.assign(st, { data, loaded: true, loadError: null }); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; refresh(); });
      };
      /** Reads everything again after a change and redraws (unless a dialog is open). */
      const reload = () => fetchAll().then((data) => { st.data = data; refresh(); }).catch((err) => App.fail(err, 'Could not refresh AT-Protocol'));
      if (!st.loaded && !st.loadError) load();

      const style = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .atproto-did,#main .atproto-wrap{overflow-wrap:anywhere;min-width:0}'
        + '#main .atproto-did{font-family:var(--mono);font-size:13px}'
        + '#main .atproto-keyrow td{vertical-align:top}'
        + '#main .atproto-doc pre{max-height:320px;overflow:auto}'
        + '#main .atproto-stat{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}'
        + '#main .atproto-status{display:inline-flex;align-items:center;gap:6px}#main .atproto-status i{width:8px;height:8px;border-radius:50%;background:var(--muted);display:inline-block}#main .atproto-status.streaming i{background:var(--ok-fg)}#main .atproto-status.backoff i,#main .atproto-status.connecting i,#main .atproto-status.waiting i{background:var(--warn-fg)}#main .atproto-status.error i{background:var(--danger-fg)}'
        + '#main .atproto-section{border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--panel)}'
        + '#main .atproto-insp .kv .v{font-size:12px;overflow-wrap:anywhere;min-width:0}'
        + '</style>';
      const sub = 'The tenant\'s service DID and signing keys, the labels it publishes and the labelers it trusts, firehose ingest through the moderation check, members\' DID bindings, and hosted repositories and feed generators.';
      if (st.loadError) { root.innerHTML = style + '<div class="page">' + UI.pagehead('AT-Protocol', sub, '') + UI.problem('AT-Protocol could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div></div>'; ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); }); return; }
      if (!st.loaded) { root.innerHTML = style + '<div class="page">' + UI.pagehead('AT-Protocol', sub, '') + UI.notice('Loading…', 'info') + '</div>'; return; }

      const D = st.data;
      const custody = st.custodyForced ? null : (D.info ? D.info.custody : D.pds ? D.pds.service.custody : null);
      const custodyKnown = !!(D.info || D.pds);
      const running = D.subs.filter((s) => s.state === 'running').length;
      const tabs = UI.tabs([{ id: 'identity', label: 'Identity and keys' }, { id: 'labels', label: 'Labels', count: D.labels.length }, { id: 'labelers', label: 'Trusted labelers', count: D.labelers.length }, { id: 'firehose', label: 'Firehose', count: running }, { id: 'accounts', label: 'Accounts', count: D.bindings.length }, { id: 'pds', label: 'PDS and feeds' }].filter((t) => allowed(t.id)), st.tab);
      const body = { identity: renderIdentity, labels: renderLabels, labelers: renderLabelers, firehose: renderFirehose, accounts: renderAccounts, pds: renderPds }[st.tab](st, D, custody);
      root.innerHTML = style + '<div class="page">' + UI.pagehead('AT-Protocol', sub, (custodyKnown ? UI.pill('custody: ' + (custody || 'unavailable'), custody ? 'ok' : 'danger') : '') + UI.btn('Public endpoints', { size: 'sm', icon: 'link', attrs: 'data-endpoints' }))
        + (custodyKnown && !custody ? UI.notice('<b>Key custody unavailable (409, step custody).</b> Neither the signer process (SIGNER_SOCKET) nor OpenBao transit (KMS_PROVIDER=openbao) is reachable, so creating identities, rotating keys and signing new labels are disabled. Existing labels are still served. <a href="#" data-goplatform>Check the signer in Platform</a>', 'danger', UI.btn(st.custodyForced ? 'Signer back' : 'Check again', { size: 'sm', attrs: 'data-custodyback' })) : '')
        + tabs + body + '</div>';

      ctx.on('click', '.tabs [data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-goplatform]', (e) => { e.preventDefault(); ctx.navigate('platform'); });
      ctx.on('click', '[data-custodyback]', () => { st.custodyForced = false; reload().then(() => ctx.toast(custodyOf(st) ? 'Signer reachable. Key routes are back.' : 'Custody is still unavailable.', custodyOf(st) ? 'ok' : 'warn')); });
      ctx.on('click', '[data-endpoints]', () => endpointsDrawer(ctx, D));
      const w = { ctx, st, D, reload, custody };
      if (st.tab === 'identity') wireIdentity(w);
      if (st.tab === 'labels') wireLabels(w);
      if (st.tab === 'labelers') wireLabelers(w);
      if (st.tab === 'firehose') wireFirehose(w);
      if (st.tab === 'accounts') wireAccounts(w);
      if (st.tab === 'pds') wirePds(w);

      // Firehose status changes on the worker that holds each lease: read it again while one is running.
      if (st.tab === 'firehose' && running && !poll) {
        poll = setTimeout(function tick() {
          poll = null;
          if (App.state.route !== 'atproto' || st.tab !== 'firehose') return;
          if (overlayOpen()) { poll = setTimeout(tick, 4000); return; }
          App.get('/api/atproto/firehose').then((r) => { st.data.subs = r.subscriptions; refresh(); }).catch(() => undefined);
        }, 4000);
      }
    }
  });

  const custodyOf = (st) => (st.data && st.data.info ? st.data.info.custody : st.data && st.data.pds ? st.data.pds.service.custody : null);

  function endpointsDrawer(ctx, D) {
    const base = (D.info && D.info.base) || location.origin;
    const idn = D.identity || (D.info && D.info.identity);
    const ep = idn ? idn.endpoint : null;
    const lines = ['GET  ' + base + '/.well-known/did.json            (did:web document for the request Host)', 'GET  ' + base + '/.well-known/atproto-did        (the DID whose handle is the host)'];
    if (ep && ep !== base && ep.indexOf(base) === 0) lines.push('GET  ' + ep + '/did.json     (path-form did:web document)');
    if (ep) {
      lines.push('GET  ' + ep + '/xrpc/com.atproto.label.queryLabels?uriPatterns=…&sources=…&limit=50&cursor');
      lines.push('WS   ' + ep.replace(/^http/, 'ws') + '/xrpc/com.atproto.label.subscribeLabels?cursor=   (DAG-CBOR frames, #labels, op -1 errors)');
      lines.push('GET  ' + ep + '/xrpc/app.bsky.feed.describeFeedGenerator');
      lines.push('GET  ' + ep + '/xrpc/app.bsky.feed.getFeedSkeleton?feed=<at-uri>&limit=50&cursor');
    }
    if (D.pds && D.pds.service) { lines.push('GET  ' + D.pds.service.endpoint + '/xrpc/com.atproto.server.describeServer   (the PDS)'); lines.push('WS   ' + D.pds.service.subscribeRepos); }
    ctx.drawer({ title: 'Public endpoints', body: UI.notice('No session; ATPROTO_PUBLIC_RATE_PER_MINUTE per address, then 429. CORS allows every origin.', 'info') + (idn ? '' : UI.notice('This tenant has no identity of its own, so only the platform\'s routes answer for it.', 'warn')) + UI.code(lines.join('\n'), 'http') + '<div class="muted" style="font-size:12px;margin-top:6px">At most ATPROTO_SUBSCRIBERS_MAX streams per instance (503). New labels reach every subscriber over the bus.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) });
  }

  // ---------------- Identity and keys ----------------
  function renderIdentity(st, D, custody) {
    const idn = D.identity;
    const tenant = (App.me && App.me.tenant && App.me.tenant.name) || 'This tenant';
    const fb = D.info && D.info.fallback;
    const maxSeq = D.labels.reduce((m, l) => Math.max(m, l.seq), 0);
    const buttons = '<div class="hstack wrap gap6" style="margin-top:8px">'
      + UI.btn('Rotate label key', { kind: 'primary', size: 'sm', icon: 'refresh', attrs: 'data-rotate="label"', disabled: !custody || !idn, title: !idn ? 'Create an identity first' : !custody ? 'Needs key custody' : '' })
      + UI.btn('Rotate rotation key', { size: 'sm', attrs: 'data-rotate="rotation"', disabled: !custody || !idn || idn.method === 'web', title: idn && idn.method === 'web' ? 'did:web has no rotation key (400)' : '' })
      + UI.btn('Create identity', { size: 'sm', attrs: 'data-createid', disabled: !custody || !!idn, title: idn ? tenant + ' already has an identity (409); rotate its keys instead' : !custody ? 'Needs key custody' : '' })
      + UI.btn('Platform fallback', { size: 'sm', kind: 'ghost', attrs: 'data-platformid' }) + '</div>';
    if (!idn) {
      return '<div class="cols"><div style="flex:1.2;min-width:0">' + UI.panel('Tenant identity', UI.notice('<b>No identity of its own.</b> ' + esc(tenant) + (fb ? ' labels under the platform\'s DID, the fallback (<span class="mono atproto-wrap">' + esc(fb.did) + '</span>).' : ' has no identity, and the platform has none either, so nothing is labelled yet.') + ' Create one to publish labels and serve feeds as this tenant.', 'info') + buttons)
        + UI.panel('Keys', UI.table(['Purpose', 'Curve', 'Custody', 'Public key', 'State', 'Created', 'Retired'], [], { clickable: false, minWidth: '0', emptyTitle: 'No keys', emptyText: 'Keys are made when the identity is created.' })) + '</div>'
        + '<div style="flex:1;min-width:0">' + UI.panel('DID document', UI.empty('No document', 'A did:web document is served once the identity exists.')) + '</div></div>';
    }
    const keys = UI.table(['Purpose', 'Curve', 'Custody', 'Public key', 'State', 'Created', 'Retired'], idn.keys.map((k) => ({ cells: [esc(k.purpose), '<span class="mono">' + esc(k.curve) + '</span>', esc(k.custody), mono(k.didKey, 12), UI.pill(k.state, k.state === 'active' ? 'ok' : ''), esc(when(k.createdAt)), esc(when(k.retiredAt))], attrs: 'class="atproto-keyrow" data-key="' + esc(k.id) + '"' })), { clickable: false, minWidth: '0' });
    return '<div class="cols"><div style="flex:1.2;min-width:0">' + UI.panel('Tenant identity', UI.kv([['Method', '<span class="mono">did:' + esc(idn.method) + '</span>'], ['DID', '<span class="atproto-did" data-did>' + esc(idn.did) + '</span>'], ['Handle', idn.handle ? mono(idn.handle) : '<span class="muted">none</span>'], ['Own host', idn.host ? mono(idn.host) : '<span class="muted">none (path form under the base host)</span>'], ['Labeler endpoint', mono(idn.endpoint, 12)], ['PLC CID', idn.plcCid ? mono(idn.plcCid, 12) : '<span class="muted">not a did:plc</span>'], ['State', UI.pill(idn.state)]].concat(allowed('labels') ? [['Next label seq', '<span class="num">' + (maxSeq + 1) + '</span>']] : []).concat([['Created', esc(when(idn.createdAt))], ['Updated', esc(when(idn.updatedAt))]]), 2) + buttons)
      + UI.panel('Keys', keys + '<div class="muted" style="font-size:12px">Keys are made and used in the signer (secp256k1 and P-256) or OpenBao transit (P-256 only). Rows hold the public key and the signer\'s wrapped blob, never a private key. Signatures are ECDSA over SHA-256, compact r||s, low-S.</div>') + '</div>'
      + '<div style="flex:1;min-width:0">' + UI.panel('DID document', '<div class="atproto-doc" data-doc>' + (st.docUpdated ? UI.notice('<b>Document updated ' + esc(st.docUpdated) + '.</b> The new #atproto_label key is served at once' + (idn.method === 'web' ? ' in the did:web document' : ' once the PLC directory accepted the operation') + '. Labels signed with the retired key are signed again with this one the next time they are served.', 'ok') : '') + (idn.document ? UI.code(JSON.stringify(idn.document, null, 2), 'json') : UI.notice('The document could not be built just now.', 'warn')) + '</div>', { actions: UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copydoc' }) }) + '</div></div>';
  }
  function wireIdentity(w) {
    const { ctx, st, D, reload, custody } = w;
    const idn = D.identity;
    const rotate = async (purpose) => {
      const cur = idn && idn.keys.find((k) => k.purpose === purpose && k.state === 'active');
      const ok = await ctx.confirm({ title: 'Rotate ' + purpose + ' key', tag: purpose === 'label' ? 'changes the document' : 'PLC operation', body: '<p class="fg2" style="margin:0">A new ' + esc(cur ? cur.curve : '') + ' key is made in ' + esc(custody || '') + ' custody; the current one is retired and kept for verification. ' + (idn.method === 'web' ? 'The did:web document changes at once.' : 'The directory must accept the operation signed by the rotation key in force.') + '</p>', kv: [['DID', idn.did], ['Current key', cur ? cur.didKey : 'none'], ['Custody', custody || 'unavailable']], ok: 'Rotate' });
      if (!ok) return;
      try {
        const out = await App.post('/api/atproto/identity/rotate', { purpose });
        st.data.identity = out.identity; st.docUpdated = when(Date.now());
        ctx.rerender();
        ctx.toast('Key rotated. The DID document now names ' + esc(out.key.didKey) + (purpose === 'label' ? ' as #atproto_label' : ' as the rotation key') + '; ' + esc(out.retired.didKey) + ' is retired. atproto.key.rotated written' + (out.identity.method === 'plc' ? '; the PLC directory accepted the operation.' : '.'), 'ok', 7000);
      } catch (err) { App.fail(err, 'Could not rotate the key'); }
    };
    ctx.on('click', '[data-rotate]', (e, t) => rotate(t.dataset.rotate));
    if (st.openRotate) { st.openRotate = false; if (idn && custody) setTimeout(() => rotate('label'), 0); }
    ctx.on('click', '[data-copydoc]', () => { const text = idn && idn.document ? JSON.stringify(idn.document, null, 2) : ''; if (navigator.clipboard && text) navigator.clipboard.writeText(text).catch(() => undefined); ctx.toast('DID document copied.'); });
    ctx.on('click', '[data-platformid]', () => {
      const fb = D.info && D.info.fallback;
      ctx.drawer({ title: 'Platform identity (fallback)', body: (fb ? UI.kv([['DID', '<span class="atproto-did">' + esc(fb.did) + '</span>'], ['Method', '<span class="mono">did:' + esc(fb.method) + '</span>'], ['Handle', fb.handle ? '<span class="mono">' + esc(fb.handle) + '</span>' : 'none'], ['Endpoint', mono(fb.endpoint, 12)], ['Custody', esc(custody || 'unavailable')], ['Needs', 'platform:manage and a recent sign-in']], 1) : UI.notice(D.identity ? 'This tenant has its own identity, so it does not use the platform\'s.' : 'There is no platform identity either. A platform administrator creates it (platform:manage and a recent sign-in).', 'info'))
        + UI.notice('A tenant without an identity labels under the platform\'s. The platform\'s identity serves no feeds.', 'info'), actions: UI.btn('Close', { attrs: 'data-close' }) });
    });
    ctx.on('click', '[data-createid]', () => {
      const info = D.info || { curves: ['secp256k1', 'p256'], defaultCurve: 'secp256k1' };
      ctx.modal({ title: 'Create identity', body: '<div class="formgrid">'
        + UI.field('Method', UI.select([{ value: 'web', label: 'did:web (served from this host)' }].concat(info.plcUrl ? [{ value: 'plc', label: 'did:plc (genesis operation to ATPROTO_PLC_URL)' }] : []), 'web', 'data-cm'))
        + UI.field('Handle (optional)', UI.input('', { attrs: 'data-ch', placeholder: 'labels.northwind.example' }), 'Defaults to the host when it is a valid domain.')
        + UI.field('Own host (optional)', UI.input('', { placeholder: 'labels.contoso.example', attrs: 'data-chost' }), 'did:web:&lt;host&gt;, served for requests with that Host. Empty: the path form under the base host.')
        + UI.field('Curve', UI.select(info.curves || ['secp256k1', 'p256'], info.defaultCurve || 'secp256k1', 'data-cc'), 'secp256k1 under OpenBao is 409: transit has no such key type.') + '</div><div data-cerr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-cgo' }),
        onMount(m) {
          m.querySelector('[data-cgo]').addEventListener('click', async () => {
            const b = { method: m.querySelector('[data-cm]').value, curve: m.querySelector('[data-cc]').value };
            const h = m.querySelector('[data-ch]').value.trim(); const host = m.querySelector('[data-chost]').value.trim();
            if (h) b.handle = h; if (host) b.host = host;
            try { const row = await App.post('/api/atproto/identity', b); App.closeOverlay(); ctx.toast('Identity created (201): ' + esc(row.did) + '. atproto.identity.created written.', 'ok', 6000); reload(); }
            catch (err) { m.querySelector('[data-cerr]').innerHTML = problemOf(err); }
          });
        } });
    });
  }

  // ---------------- Labels ----------------
  /** A label is in force when it is the newest for its subject and value and not a negation. */
  const inForce = (labels) => { const last = {}; labels.slice().sort((a, b) => a.seq - b.seq).forEach((l) => { last[l.label.uri + '|' + l.label.val] = l; }); return (l) => !l.label.neg && last[l.label.uri + '|' + l.label.val] === l; };
  function renderLabels(st, D, custody) {
    const force = inForce(D.labels);
    let rows = D.labels.filter((l) => (st.valFilter === 'all' || l.label.val === st.valFilter) && (!st.negOnly || l.label.neg) && (!st.lq || l.label.uri.toLowerCase().indexOf(st.lq.toLowerCase()) >= 0));
    rows = rows.slice().sort((a, b) => (st.lsort === 'oldest' ? a.seq - b.seq : b.seq - a.seq));
    const noSigner = !D.identity && !(D.info && D.info.fallback);
    return (noSigner ? UI.notice('<b>No identity to sign with (409, step identity).</b> Neither this tenant nor the platform has an AT-Protocol identity, so no label can be published yet.', 'warn') : '')
      + '<div class="toolbar">' + UI.search('Filter by subject', 'data-lq', st.lq) + '<span class="relative">' + UI.btn('Value: ' + st.valFilter, { size: 'sm', icon: 'filter', attrs: 'data-valmenu', cls: st.valFilter !== 'all' ? 'active' : '' }) + '</span>' + UI.toggle('Negations only', !!st.negOnly, 'data-negonly data-manual') + '<span class="relative">' + UI.btn(st.lsort === 'oldest' ? 'Oldest first' : 'Newest first', { size: 'sm', icon: 'sort', attrs: 'data-lsort' }) + '</span><span class="grow"></span>' + UI.btn('Create label', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newlabel', disabled: !custody || noSigner }) + '</div>'
      + UI.table([{ label: 'Seq', right: true }, 'Subject', 'Value', 'Negated', 'Created', 'Expires', 'From flag', { label: '', srLabel: 'Actions', right: true }], rows.map((l) => ({ cells: ['<span class="num">' + l.seq + '</span>', mono(l.label.uri, 12), valPill(l.label.val), l.label.neg ? UI.pill('neg', 'info') : '', esc(when(Date.parse(l.label.cts))), esc(l.label.exp ? when(Date.parse(l.label.exp)) : ''), l.flagId ? '<a href="#" data-goflag="' + esc(l.flagId) + '">' + esc(l.flagId) + '</a>' : '<span class="muted">explicit</span>', force(l) ? UI.btn('Negate', { size: 'sm', attrs: 'data-negate="' + esc(l.id) + '"', disabled: !custody }) : ''], attrs: 'data-label="' + esc(l.id) + '"' })), { clickable: false, minWidth: '0', emptyTitle: D.labels.length ? 'No labels match' : 'No labels yet', emptyText: D.labels.length ? 'Clear the filters.' : 'Labels come from guardrail decisions on flags, the firehose check, or Create label.' })
      + '<div class="muted" style="font-size:12px">A label is {ver 1, src, uri, cid, val, neg, cts, exp, sig} signed over its DAG-CBOR by the #atproto_label key and numbered by the identity\'s seq. Guardrail decisions map block and require-approval to !hide; warn, flag and redact to !warn; enforced findings to categories (porn, sexual, nudity, graphic-media, spam, self-harm, hate, harassment, pii, secrets). Dismissing or approving a flag negates the labels made from it.</div>';
  }
  function wireLabels(w) {
    const { ctx, st, D, reload } = w;
    ctx.on('input', '[data-lq]', (e, t) => { st.lq = t.value; ctx.rerender(); const i = ctx.$('[data-lq]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
    ctx.on('click', '[data-valmenu]', (e, t) => menu(ctx, t, [['all', 'All values']].concat(Array.from(new Set(D.labels.map((l) => l.label.val))).map((v) => [v, v])), st.valFilter, (v) => { st.valFilter = v; ctx.rerender(); }));
    ctx.on('click', '[data-negonly]', () => { st.negOnly = !st.negOnly; ctx.rerender(); });
    ctx.on('click', '[data-lsort]', (e, t) => menu(ctx, t, [['newest', 'Newest first'], ['oldest', 'Oldest first']], st.lsort, (v) => { st.lsort = v; ctx.rerender(); }));
    ctx.on('click', '[data-goflag]', (e, t) => { e.preventDefault(); ctx.navigate('flags', { id: t.dataset.goflag }); });
    ctx.on('click', '[data-negate]', (e, t) => {
      const l = D.labels.find((x) => x.id === t.dataset.negate); if (!l) return;
      ctx.modal({ title: 'Negate label', body: UI.kv([['Subject', mono(l.label.uri, 12)], ['Value', valPill(l.label.val)], ['Seq', String(l.seq)]], 1) + UI.field('Reason', UI.select(['Appeal upheld', 'Flag dismissed as false positive', 'Content removed by its author', 'Other'], 'Appeal upheld', 'data-nr')) + UI.notice('A negation is its own label (neg: true) with the next seq. 409 when no label of this value is in force on the subject.', 'info') + '<div data-nerr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Negate', { kind: 'primary', attrs: 'data-ngo' }),
        onMount(m) { m.querySelector('[data-ngo]').addEventListener('click', async () => {
          try { const row = await App.post('/api/atproto/labels/negate', { uri: l.label.uri, val: l.label.val, reason: m.querySelector('[data-nr]').value }); App.closeOverlay(); ctx.toast('Negation published as seq ' + row.seq + '. atproto.label.negated written; subscribers get it over the bus.', 'ok', 5000); reload(); }
          catch (err) { m.querySelector('[data-nerr]').innerHTML = problemOf(err); }
        }); } });
    });
    ctx.on('click', '[data-newlabel]', () => ctx.modal({ title: 'Create label',
      body: UI.field('Subject', UI.input('', { attrs: 'data-su', placeholder: 'at://did:plc:…/app.bsky.feed.post/…' }), 'An at:// URI, a DID or an https URL.') + UI.seg([{ id: 'vals', label: 'Explicit values' }, { id: 'flag', label: 'From a flag' }], 'vals', 'data-lmode aria-label="Label source"')
        + '<div data-lvals>' + UI.field('Values', UI.input('', { attrs: 'data-sv', placeholder: '!warn, pii' }), 'Lower-case letters, digits and hyphens, optionally behind "!". Values already in force are not repeated.') + '</div>'
        + '<div data-lflag hidden>' + UI.field('Flag', UI.input('', { attrs: 'data-sf', placeholder: 'F-2291' }), 'The flag\'s rule action and name decide the values. A dismissed or approved flag is 409; one above your clearance 404.') + '</div>'
        + UI.field('Expires (optional)', UI.input('', { placeholder: '2026-10-19T00:00:00Z', attrs: 'data-se' })) + '<div data-lerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Publish', { kind: 'primary', attrs: 'data-lgo' }),
      onMount(m) {
        let mode = 'vals';
        m.querySelector('[data-lmode]').addEventListener('click', (e) => { const b = e.target.closest('[data-seg]'); if (!b) return; mode = b.dataset.seg; m.querySelectorAll('[data-lmode] button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); m.querySelector('[data-lvals]').hidden = mode !== 'vals'; m.querySelector('[data-lflag]').hidden = mode !== 'flag'; });
        m.querySelector('[data-lgo]').addEventListener('click', async () => {
          const b = { uri: m.querySelector('[data-su]').value.trim() };
          const exp = m.querySelector('[data-se]').value.trim(); if (exp) b.exp = exp;
          if (mode === 'flag') b.flag = m.querySelector('[data-sf]').value.trim(); else b.vals = list(m.querySelector('[data-sv]').value);
          try { const r = await App.post('/api/atproto/labels', b); App.closeOverlay(); ctx.toast(r.labels.length ? r.labels.length + (r.labels.length === 1 ? ' label' : ' labels') + ' published (201). atproto.label.created written with the subject hash.' : 'Nothing new: those values are already in force on the subject (200).', r.labels.length ? 'ok' : 'warn', 5000); reload(); }
          catch (err) { m.querySelector('[data-lerr]').innerHTML = problemOf(err); }
        });
      } }));
  }

  // ---------------- Trusted labelers ----------------
  function renderLabelers(st, D) {
    if (!st.labeler || !D.labelers.some((l) => l.id === st.labeler)) st.labeler = D.labelers[0] ? D.labelers[0].id : null;
    const sel = D.labelers.find((l) => l.id === st.labeler);
    const table = UI.table(['Labeler', 'DID', 'Workspace', 'State', 'Cursor', 'Last pull', { label: 'Received', right: true }, { label: 'Rejected', right: true }], D.labelers.map((l) => ({ cells: ['<b>' + esc(l.name) + '</b><br><span class="muted mono atproto-wrap" style="font-size:11px">' + esc(l.endpoint || '') + '</span>', mono(l.did, 12), esc(wsName(l.workspaceId)), UI.pill(l.state, l.state === 'active' ? 'ok' : 'warn'), '<span class="num">' + l.cursor + '</span>', esc(l.lastPullAt ? when(l.lastPullAt) : 'never'), '<span class="num">' + Number(l.received).toLocaleString() + '</span>', l.rejected ? '<span class="num" style="color:var(--danger-fg)">' + l.rejected + '</span>' : '<span class="num">0</span>'], attrs: 'data-labeler="' + esc(l.id) + '"', selected: !!sel && sel.id === l.id })), { minWidth: '0', emptyTitle: 'No trusted labelers', emptyText: 'Add one by its DID; its labels become flags in the workspace you choose.' });
    let insp = '';
    if (sel) insp = UI.panel(sel.name, (sel.lastError ? UI.notice('<b>Last pull had problems.</b> ' + esc(sel.lastError) + '. Labels that fail are dropped and audited atproto.label.rejected (reason signature, source, unsigned or malformed), at most 20 a pull then one summary.', 'warn') : '')
      + UI.kv([['DID', '<span class="atproto-did">' + esc(sel.did) + '</span>'], ['Label key', sel.didKey ? mono(sel.didKey, 12) : 'none'], ['Endpoint', mono(sel.endpoint || '', 12)], ['Flags raised in', esc(wsName(sel.workspaceId))], ['Values that become flags', (sel.vals || []).map(valPill).join(' ') || 'none'], ['Pull cursor', '<span class="num">' + sel.cursor + '</span>'], ['Rejected', '<span class="num">' + sel.rejected + '</span>'], ['Pull schedule', 'every ATPROTO_LABEL_PULL_MINUTES while active']], 1)
      + '<div class="hstack wrap gap6" style="margin-top:8px">' + UI.btn('Pull now', { kind: 'primary', size: 'sm', icon: 'refresh', attrs: 'data-pull', disabled: sel.state !== 'active', title: sel.state !== 'active' ? 'Resume it first (a paused labeler is 409)' : '' }) + UI.btn(sel.state === 'active' ? 'Pause' : 'Resume', { size: 'sm', attrs: 'data-togglelabeler' }) + UI.btn('Received labels', { size: 'sm', attrs: 'data-received' }) + UI.btn('Edit', { size: 'sm', attrs: 'data-editlabeler' }) + UI.btn('Remove', { size: 'sm', kind: 'danger', attrs: 'data-removelabeler' }) + '</div>'
      + '<div class="muted" style="font-size:12px;margin-top:8px">The pull reads subscribeLabels from the cursor until quiet, verifies each label (src must be the labeler; signature against its key, re-fetching the document once for a rotated key), stores verified labels once, and raises a report flag (checkpoint atproto-label; high for !hide, medium for !warn, else low) in ' + esc(wsName(sel.workspaceId)) + ' for each new one whose value is listed.</div>');
    return '<div class="toolbar">' + UI.btn('Add labeler', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-addlabeler' }) + '<span class="muted right" style="font-size:12px">labels:manage</span></div><div class="cols"><div style="flex:1.3;min-width:0">' + table + '</div>' + (sel ? '<aside class="atproto-insp" aria-label="Selected labeler" style="flex:1;min-width:0">' + insp + '</aside>' : '') + '</div>';
  }
  function labelerForm(l) {
    return '<div class="formgrid">' + UI.field('Name', UI.input(l ? l.name : '', { attrs: 'data-an' })) + UI.field('Flags raised in', UI.select(wsOptions(true), l ? l.workspaceId || '' : (App.DATA.tenant && App.DATA.tenant.workspaceId) || '', 'data-aw')) + '</div>'
      + UI.field('Values that become flags', UI.input((l ? l.vals : DEFAULT_VALS).join(', '), { attrs: 'data-av' }), 'Default: ' + DEFAULT_VALS.join(', ') + '.');
  }
  function wireLabelers(w) {
    const { ctx, st, D, reload } = w;
    const sel = () => D.labelers.find((l) => l.id === st.labeler);
    ctx.on('click', 'tr[data-labeler]', (e, t) => { st.labeler = t.dataset.labeler; ctx.rerender(); });
    ctx.on('click', '[data-pull]', async () => { const l = sel(); try { const r = await App.post('/api/atproto/labelers/' + enc(l.id) + '/pull'); ctx.toast('Pull queued (202, job ' + esc(r.job.id.slice(-6)) + '). Verified labels raise flags in ' + esc(wsName(l.workspaceId)) + '. atproto.labeler.pulled written.', 'ok', 5000); setTimeout(reload, 1500); } catch (err) { App.fail(err, 'Could not queue the pull'); } });
    ctx.on('click', '[data-togglelabeler]', async () => { const l = sel(); const next = l.state === 'active' ? 'paused' : 'active'; try { await App.patch('/api/atproto/labelers/' + enc(l.id), { state: next }); ctx.toast(next === 'active' ? 'Resumed. Pulls run every ATPROTO_LABEL_PULL_MINUTES from cursor ' + l.cursor + '.' : 'Paused. The cursor is kept.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not change the labeler'); } });
    ctx.on('click', '[data-received]', async () => {
      const l = sel();
      let rows = [];
      try { rows = (await App.get('/api/atproto/labelers/' + enc(l.id) + '/labels?limit=100')).labels; } catch (err) { App.fail(err, 'Could not read the labels'); return; }
      ctx.drawer({ title: 'Received labels, ' + esc(l.name), body: UI.table(['Seq', 'Subject', 'Value', 'Neg', 'cts', 'Flag'], rows.map((x) => [String(x.seq), mono(x.uri, 12), valPill(x.val), x.neg ? UI.pill('neg', 'info') : '', esc(when(Date.parse(x.cts))), x.flagId ? '<a href="#/flags?id=' + enc(x.flagId) + '">' + esc(x.flagId) + '</a>' : '<span class="muted">' + (x.neg ? 'negation, no flag' : 'no flag') + '</span>']), { clickable: false, minWidth: '0', emptyTitle: 'Nothing received yet', emptyText: 'Pull now reads the labeler from its cursor.' }) + '<div class="muted" style="font-size:12px;margin-top:6px">Verified labels are stored once; a value outside the list is kept but raises no flag.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) });
    });
    ctx.on('click', '[data-editlabeler]', () => { const l = sel(); ctx.modal({ title: 'Edit labeler', body: labelerForm(l) + '<div data-eerr role="alert"></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-ego' }), onMount(m) { m.querySelector('[data-ego]').addEventListener('click', async () => {
      try { await App.patch('/api/atproto/labelers/' + enc(l.id), { name: m.querySelector('[data-an]').value.trim() || l.name, workspaceId: m.querySelector('[data-aw]').value || null, vals: list(m.querySelector('[data-av]').value) }); App.closeOverlay(); ctx.toast('Labeler saved. atproto.labeler.updated written.', 'ok'); reload(); }
      catch (err) { m.querySelector('[data-eerr]').innerHTML = problemOf(err); }
    }); } }); });
    ctx.on('click', '[data-removelabeler]', async () => { const l = sel(); const ok = await ctx.confirm({ title: 'Remove ' + esc(l.name), tone: 'danger', body: '<p class="fg2" style="margin:0">Pulls stop and the cursor is dropped. Labels already received and the flags they raised stay.</p>', kv: [['DID', l.did], ['Received', String(l.received)]], ok: 'Remove' }); if (!ok) return; try { await App.del('/api/atproto/labelers/' + enc(l.id)); st.labeler = null; ctx.toast('Labeler removed (204). atproto.labeler.deleted written.', 'warn'); reload(); } catch (err) { App.fail(err, 'Could not remove the labeler'); } });
    ctx.on('click', '[data-addlabeler]', () => ctx.modal({ title: 'Add trusted labeler', body: UI.field('DID', UI.input('', { attrs: 'data-ad', placeholder: 'did:plc:… or did:web:…' }), 'Resolved through ATPROTO_PLC_URL (did:plc) or https (did:web), through the service URL checks: metadata addresses are always refused, link-local unless allowed.') + labelerForm(null) + '<div data-aerr role="alert"></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Resolve and add', { kind: 'primary', attrs: 'data-ago' }), onMount(m) { m.querySelector('[data-ago]').addEventListener('click', async () => {
      const did = m.querySelector('[data-ad]').value.trim();
      try { const l = await App.post('/api/atproto/labelers', { did, name: m.querySelector('[data-an]').value.trim() || did, workspaceId: m.querySelector('[data-aw]').value || null, vals: list(m.querySelector('[data-av]').value) }); App.closeOverlay(); st.labeler = l.id; ctx.toast('Labeler added (201): key and endpoint recorded from its document. The first pull starts from cursor 0.', 'ok', 5000); reload(); }
      catch (err) { m.querySelector('[data-aerr]').innerHTML = problemOf(err); }
    }); } }));
  }

  // ---------------- Firehose ----------------
  const statusHtml = (s) => '<span class="atproto-status ' + esc(s.status) + '"><i></i>' + esc(s.status) + (s.state === 'running' && !s.held ? ' (no holder yet)' : '') + '</span>';
  function renderFirehose(st, D) {
    if (!st.sub || !D.subs.some((s) => s.id === st.sub)) st.sub = D.subs[0] ? D.subs[0].id : null;
    const sel = D.subs.find((s) => s.id === st.sub);
    const cursorText = (s) => (s.cursor === null || s.cursor === undefined ? 'null (live)' : String(s.cursor));
    const table = UI.table(['Subscription', 'Protocol', 'Workspace', 'State', 'Status', 'Cursor', { label: 'Flagged', right: true }, { label: 'Received', right: true }], D.subs.map((s) => ({ cells: ['<b>' + esc(s.name) + '</b><br><span class="muted mono atproto-wrap" style="font-size:11px">' + esc(s.endpoint) + '</span>', '<span class="mono">' + esc(s.protocol) + '</span>', esc(wsName(s.workspaceId)) + ' ' + UI.label(s.label, { sm: true }), UI.pill(s.state, s.state === 'running' ? 'ok' : ''), statusHtml(s), mono(cursorText(s), 11) + '<br><span class="muted" style="font-size:11px">' + esc(when(s.cursorAt)) + '</span>', '<span class="num">' + s.counts.flagged + '</span>', '<span class="num">' + Number(s.counts.received).toLocaleString() + '</span>'], attrs: 'data-sub="' + esc(s.id) + '"', selected: !!sel && sel.id === s.id })), { minWidth: '0', emptyTitle: 'No subscriptions', emptyText: 'Subscribe to a Jetstream or a relay; posts go through the moderation check.' });
    let insp = '';
    if (sel) {
      const c = sel.counts;
      insp = UI.panel(sel.name, (sel.lastError ? UI.notice('<b>' + esc(sel.status === 'backoff' ? 'Reconnecting with backoff.' : 'Last error.') + '</b> ' + esc(sel.lastError) + '. Messages at or before the stored cursor are skipped on reconnect.', sel.status === 'error' ? 'danger' : 'warn') : '')
        + '<div class="atproto-stat">' + UI.stat('<span class="num">' + Number(c.received).toLocaleString() + '</span>', 'received') + UI.stat('<span class="num">' + Number(c.checked).toLocaleString() + '</span>', 'checked') + UI.stat('<span class="num">' + c.flagged + '</span>', 'flagged', '<a href="#" data-gomod>queue</a>') + UI.stat('<span class="num">' + c.labelled + '</span>', 'labelled') + UI.stat('<span class="num" style="' + (c.failed ? 'color:var(--danger-fg)' : '') + '">' + c.failed + '</span>', 'failed') + UI.stat('<span class="num" style="' + (c.rejected ? 'color:var(--danger-fg)' : '') + '">' + (c.rejected || 0) + '</span>', 'rejected commits') + '</div>'
        + UI.kv([['Status', statusHtml(sel) + (sel.live ? ' <span class="muted" style="font-size:12px">connected ' + sel.live.connected + ', paused ' + sel.live.paused + ', queue ' + sel.live.queue + ' of FIREHOSE_QUEUE_MAX, pauses ' + sel.live.pauses + '</span>' : ' <span class="muted" style="font-size:12px">live: null (this instance is not the holder)</span>')], ['Lease', sel.held ? 'held by a worker instance, renewed every FIREHOSE_TICK_MS' : 'not held'], ['Collections', (sel.collections || []).map((x) => '<span class="mono">' + esc(x) + '</span>').join(', ')], ['Authors', sel.dids && sel.dids.length ? sel.dids.length + ' DIDs on the allow-list' : 'everyone'], ['Sample rate', String(sel.sampleRate)], ['Cursor', mono(cursorText(sel)) + ' at ' + esc(when(sel.cursorAt) || 'never') + ' (' + (sel.protocol === 'jetstream' ? 'time_us' : 'seq') + ')'], ['Last event', esc(when(sel.lastEventAt) || 'never')], ['Reconnects', String(sel.reconnects)], ['Checked as', 'atproto-post at user-input, workspace ' + esc(wsName(sel.workspaceId)) + ', label ' + esc(sel.label)]], 1)
        + '<div class="hstack wrap gap6" style="margin-top:8px">' + (sel.state === 'running' ? UI.btn('Stop', { kind: 'primary', size: 'sm', icon: 'stop', attrs: 'data-stopsub' }) : UI.btn('Start', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-startsub' })) + UI.btn('Edit', { size: 'sm', attrs: 'data-editsub' }) + UI.btn('Reset cursor', { size: 'sm', attrs: 'data-resetcursor', disabled: sel.state === 'running' || sel.held, title: sel.state === 'running' || sel.held ? 'Stop it first: the cursor resets only once no instance holds it (409)' : '' }) + UI.btn('Delete', { size: 'sm', kind: 'danger', attrs: 'data-delsub' }) + '</div>');
    }
    return '<div class="toolbar">' + UI.btn('New subscription', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newsub' }) + '<span class="muted right" style="font-size:12px">firehose:manage; at most FIREHOSE_MAX_PER_TENANT subscriptions</span></div><div class="cols"><div style="flex:1.3;min-width:0">' + table + '<div class="muted" style="font-size:12px">Each record that passes the filters (collection allow-list, author allow-list, deterministic sample by at:// URI) and has text goes through the moderation check: flag or worse raises the post\'s one flag in the workspace queue; warn or worse becomes signed labels from the tenant\'s labeler. A subscribeRepos commit counts only when it verifies against the repo\'s DID key. One worker instance holds each lease; the cursor is stored every FIREHOSE_CHECKPOINT_MS and on stop.</div></div>' + (sel ? '<aside class="atproto-insp" aria-label="Selected subscription" style="flex:1;min-width:0">' + insp + '</aside>' : '') + '</div>';
  }
  function subForm(s) {
    s = s || { name: '', protocol: 'jetstream', endpoint: '', collections: ['app.bsky.feed.post'], dids: null, sampleRate: 1, workspaceId: (App.DATA.tenant && App.DATA.tenant.workspaceId) || '', label: 'public' };
    return '<div class="formgrid">' + UI.field('Name', UI.input(s.name, { attrs: 'data-fn', placeholder: 'Jetstream, posts' })) + UI.field('Protocol', UI.select([{ value: 'jetstream', label: 'Jetstream (JSON, cursor time_us)' }, { value: 'subscribe-repos', label: 'subscribeRepos (DAG-CBOR, cursor seq)' }], s.protocol, 'data-fp')) + UI.field('Workspace', UI.select(wsOptions(true), s.workspaceId || '', 'data-fw')) + UI.field('Label', UI.select(['public', 'internal', 'confidential', 'restricted'], s.label, 'data-fl'), 'Default public; above your clearance is 403.') + '</div>'
      + UI.field('Endpoint', UI.input(s.endpoint, { attrs: 'data-fe', placeholder: 'wss://jetstream2.us-east.bsky.network' }), 'wss://, ws://, https:// or http://, dialled as WebSocket. Jetstream: a bare host gets /subscribe; subscribeRepos: /xrpc/com.atproto.sync.subscribeRepos. Checked as a service URL when saved and at every connection (400, step endpoint).')
      + '<div class="formgrid">' + UI.field('Collections', UI.input((s.collections || []).join(', '), { attrs: 'data-fc' }), 'NSIDs or prefix.*, at most 100.') + UI.field('Author DIDs', UI.textarea((s.dids || []).join('\n'), { attrs: 'data-fd', rows: 2, placeholder: 'did:plc:… one per line (up to 10,000); empty means everyone' })) + UI.field('Sample rate', UI.input(String(s.sampleRate), { attrs: 'data-fs' }), 'In (0, 1]; deterministic by the record\'s at:// URI.') + '</div>';
  }
  function wireFirehose(w) {
    const { ctx, st, D, reload } = w;
    const sel = () => D.subs.find((s) => s.id === st.sub);
    ctx.on('click', 'tr[data-sub]', (e, t) => { st.sub = t.dataset.sub; ctx.rerender(); });
    ctx.on('click', '[data-gomod]', (e) => { e.preventDefault(); ctx.navigate('moderation'); });
    ctx.on('click', '[data-stopsub]', async () => { const s = sel(); const ok = await ctx.confirm({ title: 'Stop ' + esc(s.name), body: '<p class="fg2" style="margin:0">The holder stores the cursor and gives the lease back at once over the bus. Start again later from the same cursor.</p>', kv: [['Cursor', s.cursor === null ? 'null (live)' : String(s.cursor)]], ok: 'Stop' }); if (!ok) return; try { await App.post('/api/atproto/firehose/' + enc(s.id) + '/stop'); ctx.toast('Stopped. atproto.firehose.stopped written; cursor stored.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not stop the subscription'); } });
    ctx.on('click', '[data-startsub]', async () => { const s = sel(); try { await App.post('/api/atproto/firehose/' + enc(s.id) + '/start'); ctx.toast('Started. An instance claims the lease at its next tick and connects from the stored cursor.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not start the subscription'); } });
    ctx.on('click', '[data-resetcursor]', async () => { const s = sel(); const ok = await ctx.confirm({ title: 'Reset cursor', tag: 'starts from live', tone: 'danger', body: '<p class="fg2" style="margin:0">cursor: null. The next connection starts from live; messages between the old cursor and now are never checked.</p>', kv: [['Old cursor', s.cursor === null ? 'null (live)' : String(s.cursor)]], ok: 'Reset' }); if (!ok) return; try { await App.patch('/api/atproto/firehose/' + enc(s.id), { cursor: null }); ctx.toast('Cursor reset. atproto.firehose.updated written.', 'warn'); reload(); } catch (err) { App.fail(err, 'Could not reset the cursor'); } });
    ctx.on('click', '[data-delsub]', async () => { const s = sel(); const ok = await ctx.confirm({ title: 'Delete ' + esc(s.name), tone: 'danger', body: '<p class="fg2" style="margin:0">The holder stops at its next tick. Flags and labels already raised stay.</p>', ok: 'Delete' }); if (!ok) return; try { await App.del('/api/atproto/firehose/' + enc(s.id)); st.sub = null; ctx.toast('Subscription deleted (204). atproto.firehose.deleted written.', 'warn'); reload(); } catch (err) { App.fail(err, 'Could not delete the subscription'); } });
    const openForm = (s) => ctx.modal({ title: s ? 'Edit ' + esc(s.name) : 'New subscription', cls: 'wide', body: subForm(s) + (s && s.state === 'running' ? UI.notice('Changes move rev; the running consumer restarts with them from its cursor. Changing the protocol needs the subscription stopped (a cursor of one means nothing to the other).', 'info') : '') + '<div data-ferr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(s ? 'Save' : 'Create stopped', { kind: 'primary', attrs: 'data-fgo' }) + (s ? '' : UI.btn('Create and start', { attrs: 'data-fgostart' })),
      onMount(m) {
        const save = async (start) => {
          const rate = parseFloat(m.querySelector('[data-fs]').value);
          const dids = list(m.querySelector('[data-fd]').value);
          const b = { name: m.querySelector('[data-fn]').value.trim(), protocol: m.querySelector('[data-fp]').value, endpoint: m.querySelector('[data-fe]').value.trim(), collections: list(m.querySelector('[data-fc]').value), dids: dids.length ? dids : null, sampleRate: rate, workspaceId: m.querySelector('[data-fw]').value || null, label: m.querySelector('[data-fl]').value };
          if (!b.collections.length) delete b.collections;
          if (!(rate > 0 && rate <= 1)) { m.querySelector('[data-ferr]').innerHTML = UI.problem('Sample rate out of range', 'sampleRate must be in (0, 1].', false); return; }
          if (!s) b.start = !!start;
          try {
            const row = s ? await App.patch('/api/atproto/firehose/' + enc(s.id), b) : await App.post('/api/atproto/firehose', b);
            App.closeOverlay(); st.sub = row.id;
            ctx.toast(s ? 'Saved; rev moved. atproto.firehose.updated written.' : 'Subscription created (201)' + (start ? ' and started.' : ', stopped.') + ' atproto.firehose.created written.', 'ok'); reload();
          } catch (err) { m.querySelector('[data-ferr]').innerHTML = problemOf(err); }
        };
        m.querySelector('[data-fgo]').addEventListener('click', () => save(false)); const b2 = m.querySelector('[data-fgostart]'); if (b2) b2.addEventListener('click', () => save(true));
      } });
    ctx.on('click', '[data-newsub]', () => openForm(null));
    ctx.on('click', '[data-editsub]', () => openForm(sel()));
  }

  // ---------------- Accounts (DID bindings) ----------------
  function renderAccounts(st, D) {
    const rows = D.bindings.filter((a) => st.accFilter === 'all' || (st.accFilter === 'verified' ? a.verified : !a.verified));
    const store = D.providers.find((p) => p.kind === 'atproto');
    const cfg = (store && store.config) || {};
    return '<div class="toolbar"><span class="relative">' + UI.btn('Show: ' + ({ all: 'all', verified: 'verified', unverified: 'claims pending' }[st.accFilter]), { size: 'sm', icon: 'filter', attrs: 'data-accfilter', cls: st.accFilter !== 'all' ? 'active' : '' }) + '</span>' + UI.btn('Check an account', { kind: 'primary', size: 'sm', icon: 'search', attrs: 'data-check' }) + '<span class="muted right" style="font-size:12px">identity:manage; members bind their own DID under Settings (atproto:link)</span></div>'
      + UI.table(['Member', 'DID', 'Handle', 'Verified', 'Proof', 'PDS', 'Since', { label: '', srLabel: 'Actions', right: true }], rows.map((a) => ({ cells: ['<b>' + esc(a.username || '') + '</b>', mono(a.did, 12), a.handle ? mono(a.handle) : '<span class="muted">none</span>', a.verified ? UI.pill('verified', 'ok') : a.challengePending ? UI.pill('challenge pending', 'warn') + '<br><span class="muted" style="font-size:11px">expires ' + esc(when(a.challengeExpiresAt)) + '</span>' : UI.pill('unverified', ''), a.proof ? '<span class="mono">' + esc(a.proof) + '</span>' : '<span class="muted">none</span>', a.pds ? mono(a.pds, 12) : '', esc(when(a.verifiedAt || a.createdAt)), UI.btn('Remove', { size: 'sm', kind: 'ghost', attrs: 'data-removebinding="' + esc(a.id) + '"' })], attrs: 'data-acc="' + esc(a.id) + '"' })), { clickable: false, minWidth: '0', emptyTitle: D.bindings.length ? 'No bindings match' : 'No DID bindings yet', emptyText: D.bindings.length ? 'Show all to see every claim and binding.' : 'Members claim their AT-Protocol DID under Settings.' })
      + '<div class="cols">' + UI.panel('The atproto user store', (store ? UI.kv([['Store', '<a href="#" data-goidentity>' + esc(store.name) + ' (kind atproto)</a>, position ' + store.position + ' in the chain' + (store.enabled ? '' : ', disabled')], ['boundOnly', cfg.boundOnly ? 'true: only bound DIDs sign in' : 'false: unbound DIDs are provisioned just in time with the verified handle as username and the DID as their only group'], ['authServers', (cfg.authServers || []).length ? cfg.authServers.map((u) => '<span class="mono">' + esc(u) + '</span>').join(', ') : 'any'], ['Client metadata', mono(location.origin + '/federation/atproto/client-metadata.json', 12)], ['Admin roles', 'still need their second factor']], 1) : UI.notice('No user store of kind atproto: members cannot sign in with their AT-Protocol accounts. <a href="#" data-goidentity>Add one under User stores</a>.', 'info')) + '<div class="muted" style="font-size:12px">Handles resolve by DNS TXT _atproto.&lt;handle&gt; then /.well-known/atproto-did; a handle counts only when the DID document names it back (alsoKnownAs).</div>')
      + UI.panel('Proof methods', UI.timeline([{ title: 'profile', text: 'The member puts the challenge exprsn-ai-verify-&lt;32 hex&gt; (24 h, shown once) in their app.bsky.actor.profile description; the server reads the record from their PDS.', tone: 'ok' }, { title: 'oauth', text: 'The AT-Protocol OAuth flow in link mode: PAR, PKCE S256, DPoP, private_key_jwt; the callback binds the DID to the signed-in session and redirects to Settings.', tone: 'ok' }, { title: 'none', text: 'A claim with its challenge pending, or an expired one. 409 when the DID is bound to another user of the tenant.', tone: '' }])) + '</div>';
  }
  function wireAccounts(w) {
    const { ctx, st, D, reload } = w;
    ctx.on('click', '[data-accfilter]', (e, t) => menu(ctx, t, [['all', 'All'], ['verified', 'Verified'], ['unverified', 'Claims pending']], st.accFilter, (v) => { st.accFilter = v; ctx.rerender(); }));
    ctx.on('click', '[data-goidentity]', (e) => { e.preventDefault(); ctx.navigate('directories'); });
    ctx.on('click', '[data-removebinding]', async (e, t) => { const a = D.bindings.find((x) => x.id === t.dataset.removebinding); const ok = await ctx.confirm({ title: 'Remove binding', tone: 'danger', body: '<p class="fg2" style="margin:0">' + esc(a.username || 'The member') + ' can no longer sign in with this DID; their other sign-in methods stay. They may claim it again.</p>', kv: [['DID', a.did], ['Handle', a.handle || 'none']], ok: 'Remove' }); if (!ok) return; try { await App.del('/api/admin/atproto/accounts/' + enc(a.id)); ctx.toast('Binding removed (204). atproto.did.removed written.', 'warn'); reload(); } catch (err) { App.fail(err, 'Could not remove the binding'); } });
    const openCheck = () => {
      const initial = st.checkAccount || ''; st.checkAccount = null;
      ctx.modal({ title: 'Check an AT-Protocol account', body: UI.field('Handle or DID', UI.input(initial, { attrs: 'data-ca', placeholder: 'alice.bsky.social or did:plc:…' }), 'Resolves step by step: the account, then its PDS\'s authorization server and that server\'s metadata. Audited atproto.account.checked.') + '<div data-checkout aria-live="polite">' + UI.timeline([{ title: 'Ready', text: 'Nothing is fetched until you run the check. Every address is checked before it is dialled; a link-local or metadata address is refused (422, step handle, reason refused).' }]) + '</div>',
        actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Run check', { kind: 'primary', attrs: 'data-crun' }),
        onMount(m) {
          const out = m.querySelector('[data-checkout]');
          m.querySelector('[data-crun]').addEventListener('click', async () => {
            const v = m.querySelector('[data-ca]').value.trim(); if (!v) { out.innerHTML = UI.notice('Enter a handle or a DID.', 'warn'); return; }
            out.innerHTML = UI.timeline([{ title: 'Resolving ' + esc(v), tone: 'accent', meta: 'running' }]);
            try {
              const r = await App.post('/api/admin/atproto/accounts/check', { account: v });
              out.innerHTML = UI.timeline(r.steps.map((s) => ({ title: esc(s.title), text: s.detail ? esc(s.detail) : '', tone: s.ok ? 'ok' : 'danger', meta: s.ms !== undefined ? s.ms + ' ms' : '' })))
                + (r.ok ? UI.notice('<b>ok.</b> ' + esc([r.did, r.handle ? 'handle ' + r.handle : '', r.pds ? 'PDS ' + r.pds : '', r.issuer ? 'issuer ' + r.issuer : ''].filter(Boolean).join(', ')) + '.', 'ok') : UI.notice('<b>The account did not resolve all the way.</b> The failing step is marked above.', 'danger'));
            } catch (err) { out.innerHTML = problemOf(err); }
          });
        } });
    };
    ctx.on('click', '[data-check]', openCheck);
    if (st.openCheck) { st.openCheck = false; setTimeout(openCheck, 0); }
  }

  // ---------------- PDS and feeds ----------------
  function renderPds(st, D, custody) {
    let out = '';
    const tenant = (App.me && App.me.tenant && App.me.tenant.name) || 'This tenant';
    if (App.can('pds:manage') && D.pds) {
      const h = D.pds;
      const counts = h.accounts || {};
      const platform = App.can('platform:manage');
      out += '<div class="atproto-section" data-hosting><div class="hstack wrap" style="margin-bottom:8px"><div class="eyebrow grow">PDS hosting</div>' + UI.pill(h.enabled ? 'hosting on' : 'hosting off', h.enabled ? 'ok' : '')
        + (platform ? UI.btn(h.enabled ? 'Disable hosting' : 'Enable hosting', { size: 'sm', kind: h.enabled ? '' : 'primary', attrs: 'data-hostingswitch', disabled: !h.enabled && !custody, title: !h.enabled && !custody ? 'Account keys need key custody' : '' }) : '') + '</div>'
        + (h.enabled ? '' : UI.notice(platform ? '<b>' + esc(tenant) + ' does not host AT-Protocol accounts.</b> Enabling fixes the handle domain; it is refused in an air-gapped deployment, a zone without egress, or without the signer or OpenBao.' : '<b>' + esc(tenant) + ' does not host AT-Protocol accounts.</b> A platform admin turns hosting on (platform:manage and a recent sign-in).', 'info'))
        + UI.kv([['Handle domain', h.handleDomain ? mono(h.handleDomain) : '<span class="muted">fixed when hosting is first enabled</span>'], ['Zone', h.zone ? mono(h.zone) : '<span class="muted">none</span>'], ['Service DID', mono(h.service.did, 12)], ['Endpoint', mono(h.service.endpoint, 12)], ['Accounts', ['active', 'deactivated', 'takendown'].map((k) => (counts[k] || 0) + ' ' + k).join(', ')], ['Repo event seq', '<span class="num">' + esc(String(h.service.seq || 0)) + '</span>'], ['Blob limit', esc(String(Math.round((h.blobMaxBytes || 0) / 1048576))) + ' MB'], ['Invite codes', UI.toggle(h.inviteRequired ? 'Required' : 'Not required', !!h.inviteRequired, 'data-invitereq data-manual')]], 2) + '</div>';
      out += '<div class="atproto-section" style="margin-top:12px"><div class="hstack wrap" style="margin-bottom:8px"><div class="eyebrow grow">PDS accounts' + (h.handleDomain ? ', handle domain ' + esc(h.handleDomain) : '') + '</div>' + UI.btn('Invite codes', { size: 'sm', attrs: 'data-invites' }) + '</div>'
        + UI.table(['Handle', 'DID', 'Member', 'State', 'Repo rev', { label: 'Records', right: true }, { label: '', srLabel: 'Actions', right: true }], D.pdsAccounts.map((a) => ({ cells: [mono(a.handle), mono(a.did, 12), esc(a.username || ''), UI.pill(a.state === 'takendown' ? 'taken down' : a.state, a.state === 'active' ? 'ok' : a.state === 'takendown' ? 'danger' : '') + (a.stateReason ? '<br><span class="muted" style="font-size:11px">' + esc(a.stateReason) + '</span>' : ''), a.rev ? mono(a.rev) : '<span class="muted">none</span>', '<span class="num">' + (a.records || 0) + '</span>', '<span class="hstack wrap gap6" style="justify-content:flex-end">' + (a.state === 'active' ? '<a class="btn sm ghost" href="/xrpc/com.atproto.sync.getRepo?did=' + enc(a.did) + '" download="' + esc(a.handle) + '.car">Export CAR</a>' : '') + (a.state === 'active' ? UI.btn('Deactivate', { size: 'sm', kind: 'ghost', attrs: 'data-deact="' + esc(a.id) + '"' }) : a.state === 'deactivated' ? UI.btn('Activate', { size: 'sm', kind: 'ghost', attrs: 'data-act="' + esc(a.id) + '"' }) : UI.pill('RepoTakendown', 'danger')) + '</span>'], attrs: 'data-pds="' + esc(a.id) + '"' })), { clickable: false, minWidth: '0', emptyTitle: 'No hosted accounts', emptyText: h.enabled ? 'Members create their account under Settings, or a Bluesky client signs up with an invite code.' : 'Accounts are created once hosting is on.' })
        + '<div class="muted" style="font-size:12px">Accounts tie to Exprsn-AI identities (com.atproto.server create, session, refresh, app passwords); repos are Merkle search trees with signed commits whose key is held by the signer; blobs pass the attachment quarantine; subscribeRepos with a sequencer, cursor and backfill window; takedowns through moderation.</div></div>';
    }
    if (App.can('firehose:manage')) {
      const g = D.generator || {};
      const recs = D.records;
      out += '<div class="atproto-section" style="margin-top:12px" data-feeds><div class="hstack wrap" style="margin-bottom:8px"><div class="eyebrow grow">Feed generators</div>' + UI.btn('Create feed', { size: 'sm', kind: 'primary', attrs: 'data-feednew', disabled: !g.ready, title: g.ready ? '' : 'Needs the tenant\'s own identity (409, step identity)' }) + '</div>'
        + (g.ready ? '<div class="muted" style="font-size:12px;margin-bottom:6px">Served as ' + mono(g.did, 12) + ' at ' + mono(g.endpoint || '', 12) + ', service ' + esc(g.serviceId) + ' (' + esc(g.serviceType) + ')' + (g.advertised ? ', in the DID document' : ', added to the DID document with the first feed') + '.</div>' : UI.notice(esc(g.reason || 'Feeds are served under the tenant\'s own AT-Protocol identity.'), 'info'))
        + UI.table(['Feed', 'Service DID', 'Rules', 'Ranking', 'Retention', 'Rate limit', 'Published record', { label: '', srLabel: 'Actions', right: true }], D.feeds.map((f) => ({ cells: ['<b>' + esc(f.displayName) + '</b><br><span class="muted mono" style="font-size:11px">' + esc(f.rkey) + '</span> ' + (f.state === 'active' ? '' : UI.pill(f.state, 'warn')), mono(g.did || '', 12), '<span style="font-size:12px">' + esc(rulesText(f.rules)) + '</span>', esc(rankingText(f.ranking)), esc(retentionText(f.retentionHours)), esc(f.ratePerMinute + ' requests/min'), f.published ? mono(f.published.uri, 12) : '<span class="muted">not published</span>', App.can('pds:manage') ? UI.btn(f.published ? 'Re-publish' : 'Publish record', { size: 'sm', kind: f.published ? 'ghost' : '', attrs: 'data-publish="' + esc(f.id) + '"' }) : ''], attrs: 'data-feed="' + esc(f.id) + '"' })), { clickable: false, minWidth: '0', emptyTitle: 'No feeds yet', emptyText: 'A feed is a set of rules over the posts the firehose subscriptions take.' })
        + (recs.length ? '<div class="muted" style="font-size:12px;margin-top:6px">' + recs.length + ' generator ' + (recs.length === 1 ? 'record' : 'records') + ' published: ' + recs.map((r) => esc(r.uri)).join(', ') + '.</div>' : '')
        + '<div class="muted" style="font-size:12px">describeFeedGenerator and getFeedSkeleton verify the inter-service JWT against the caller\'s DID key; rules run over the firehose index (authors, collections, keywords, labels) with optional ranking by a profile through the gateway; a feed index with retention, cursor pagination and per-feed rate limits; the app.bsky.feed.generator record is published to a hosted repo or an external account.</div></div>';
    }
    return out;
  }
  function wirePds(w) {
    const { ctx, D, reload } = w;
    const tenantId = App.me && App.me.tenant ? App.me.tenant.id : null;
    ctx.on('click', '[data-hostingswitch]', async () => {
      const on = !(D.pds && D.pds.enabled);
      const ok = await ctx.confirm({ title: on ? 'Enable PDS hosting' : 'Disable PDS hosting', tone: on ? 'info' : 'danger', tag: 'platform:manage', body: '<p class="fg2" style="margin:0">' + (on ? 'Members of this tenant may create AT-Protocol accounts on this server. Their repositories are public and crawled by relays. The handle domain is fixed now.' : 'No new accounts. Refused while active accounts remain; deactivate or migrate them first.') + ' Needs a recent sign-in.</p>', kv: [['Tenant', (App.me && App.me.tenant && App.me.tenant.name) || ''], ['Zone', (D.pds && D.pds.zone) || 'PDS_ZONE']], ok: on ? 'Enable' : 'Disable' });
      if (!ok) return;
      try {
        const r = await withStepUp(ctx, () => App.api('PUT', '/api/admin/pds/tenants/' + enc(tenantId), { enabled: on }));
        if (r === undefined) return;
        ctx.toast(on ? 'Hosting enabled: handles under ' + esc(r.handleDomain || '') + '. pds.hosting.enabled written.' : 'Hosting disabled. pds.hosting.disabled written.', on ? 'ok' : 'warn', 5000);
        reload();
      } catch (err) { App.fail(err, on ? 'Could not enable hosting' : 'Could not disable hosting'); }
    });
    ctx.on('click', '[data-invitereq]', async () => { try { await App.patch('/api/admin/pds/settings', { inviteRequired: !D.pds.inviteRequired }); ctx.toast(D.pds.inviteRequired ? 'Invite codes no longer required (the sign-up policy decides). pds.settings.updated written.' : 'Invite codes required for every sign-up. pds.settings.updated written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not change the setting'); } });
    ctx.on('click', '[data-invites]', () => {
      let shown = null;
      ctx.drawer({ title: 'Invite codes', body: '<div data-invbody>' + UI.notice('Reading the invite codes', 'info') + '</div>', actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('New invite code', { kind: 'primary', attrs: 'data-invnew' }),
        onMount(m) {
          const host = m.querySelector('[data-invbody]');
          const draw = async () => {
            try {
              const r = await App.get('/api/admin/pds/invites');
              host.innerHTML = (shown ? UI.notice('<b>New code, shown once:</b> <span class="mono" data-invcode>' + esc(shown) + '</span>', 'ok') : '')
                + '<div class="formgrid">' + UI.field('Uses', UI.input('1', { type: 'number', attrs: 'data-invuses min="1" max="1000"' })) + UI.field('Expires in days (optional)', UI.input('', { type: 'number', attrs: 'data-invdays min="1" max="365"' })) + '</div>' + UI.field('Note (optional)', UI.input('', { attrs: 'data-invnote' }))
                + UI.table(['Code', 'Uses', 'State', 'Note', { label: '', srLabel: 'Actions', right: true }], r.invites.map((i) => [mono(i.hint + '…'), i.uses + ' of ' + i.usesMax, UI.pill(i.state, i.state === 'active' ? 'ok' : ''), esc(i.note || ''), i.state === 'active' ? UI.btn('Disable', { size: 'sm', kind: 'ghost', attrs: 'data-invoff="' + esc(i.id) + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'No invite codes', emptyText: 'A code stands in for the invitation and the approval of the sign-up policy.' })
                + UI.notice('Issued under the sign-up policy (closed, open or approval). Codes are stored as an HMAC: only the first characters are shown again.', 'info');
              host.querySelectorAll('[data-invoff]').forEach((b) => b.addEventListener('click', async () => { try { await App.del('/api/admin/pds/invites/' + enc(b.dataset.invoff)); shown = null; App.toast('Invite code disabled (204).', 'warn'); draw(); } catch (err) { App.fail(err, 'Could not disable the code'); } }));
            } catch (err) { host.innerHTML = problemOf(err); }
          };
          m.querySelector('[data-invnew]').addEventListener('click', async () => {
            const uses = parseInt((host.querySelector('[data-invuses]') || {}).value, 10) || 1;
            const days = parseInt((host.querySelector('[data-invdays]') || {}).value, 10);
            const note = ((host.querySelector('[data-invnote]') || {}).value || '').trim();
            try { const r = await App.post('/api/admin/pds/invites', Object.assign({ usesMax: uses }, days ? { expiresInDays: days } : {}, note ? { note } : {})); shown = r.code; App.toast('Invite code created (201). pds.invite.created written.', 'ok'); draw(); }
            catch (err) { App.fail(err, 'Could not create the code'); }
          });
          draw();
        } });
    });
    const account = (id) => D.pdsAccounts.find((a) => a.id === id);
    ctx.on('click', '[data-deact]', (e, t) => {
      const a = account(t.dataset.deact);
      ctx.modal({ title: 'Deactivate ' + esc(a.handle), body: '<p class="fg2" style="margin:0">The repo stops serving (RepoDeactivated) and the account\'s sessions end; relays see the account as deactivated. Reversible.</p>' + UI.field('Reason', UI.textarea('', { attrs: 'data-dreason', rows: 2, placeholder: 'Why the account is deactivated' })) + '<div data-derr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Deactivate', { kind: 'danger', attrs: 'data-dgo' }),
        onMount(m) { m.querySelector('[data-dgo]').addEventListener('click', async () => {
          const reason = m.querySelector('[data-dreason]').value.trim(); if (!reason) { m.querySelector('[data-derr]').innerHTML = UI.notice('Give a reason; it is audited and shown to the owner.', 'warn'); return; }
          try { await App.post('/api/admin/pds/accounts/' + enc(a.id) + '/deactivate', { reason }); App.closeOverlay(); ctx.toast(esc(a.handle) + ' deactivated. pds.account.deactivated written.', 'warn'); reload(); }
          catch (err) { m.querySelector('[data-derr]').innerHTML = problemOf(err); }
        }); } });
    });
    ctx.on('click', '[data-act]', async (e, t) => { const a = account(t.dataset.act); try { await App.post('/api/admin/pds/accounts/' + enc(a.id) + '/activate'); ctx.toast(esc(a.handle) + ' activated; relays are asked to crawl. pds.account.activated written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not activate the account'); } });
    ctx.on('click', '[data-feednew]', () => {
      const subs = D.subs || [];
      ctx.modal({ title: 'Create feed', cls: 'wide', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-fname maxlength="24"', placeholder: 'Audit mentions' }), 'At most 24 characters.') + UI.field('Record key', UI.input('', { attrs: 'data-frkey maxlength="15"', placeholder: 'audit-mentions' }), '1 to 15 letters, digits or hyphens; the feed\'s at:// URI ends with it.')
        + UI.field('Subscription', UI.select([{ value: '', label: 'Every subscription' }].concat(subs.map((s) => ({ value: s.id, label: s.name }))), '', 'data-fsub'))
        + UI.field('Ranking', UI.select([{ value: '', label: 'none (newest first)' }, { value: 'embedding', label: 'a profile\'s embeddings' }, { value: 'classifier', label: 'a classifier\'s score' }], '', 'data-frank'))
        + UI.field('Profile or classifier', UI.input('', { attrs: 'data-frank1', placeholder: 'analyst' }), 'For ranking only.') + UI.field('Query or classifier label', UI.input('', { attrs: 'data-frank2', placeholder: 'quarterly audit evidence' }), 'For ranking only.')
        + UI.field('Retention', UI.select([{ value: '72', label: '3 days' }, { value: '168', label: '7 days' }, { value: '720', label: '30 days' }, { value: '2160', label: '90 days' }], '72', 'data-fret')) + UI.field('Rate limit (requests/min)', UI.input('300', { type: 'number', attrs: 'data-frate min="1" max="100000"' })) + '</div>'
        + UI.field('Rules over the firehose index', UI.textarea('collections: app.bsky.feed.post\nkeywords: audit, evidence\nlabels exclude: !hide, spam', { rows: 4, attrs: 'data-frules' }), 'One per line: authors (DIDs), collections, keywords, labels and labels exclude.') + '<div data-fcerr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-fcgo' }),
        onMount(m) { m.querySelector('[data-fcgo]').addEventListener('click', async () => {
          const err = m.querySelector('[data-fcerr]');
          let rules;
          try { rules = parseRules(m.querySelector('[data-frules]').value); } catch (e) { err.innerHTML = UI.problem('Rules not understood', e.message, false); return; }
          const kind = m.querySelector('[data-frank]').value; const r1 = m.querySelector('[data-frank1]').value.trim(); const r2 = m.querySelector('[data-frank2]').value.trim();
          const b = { rkey: m.querySelector('[data-frkey]').value.trim(), displayName: m.querySelector('[data-fname]').value.trim(), rules, retentionHours: parseInt(m.querySelector('[data-fret]').value, 10), ratePerMinute: parseInt(m.querySelector('[data-frate]').value, 10) || 300 };
          const sub = m.querySelector('[data-fsub]').value; if (sub) b.subscriptionId = sub;
          if (kind === 'embedding') b.ranking = { kind, profile: r1, query: r2 }; else if (kind === 'classifier') b.ranking = { kind, classifier: r1, label: r2 };
          try { const f = await App.post('/api/atproto/feeds', b); App.closeOverlay(); ctx.toast('Feed ' + esc(f.displayName) + ' created (201). atproto.feed.created written. Publish its record to make it discoverable.', 'ok', 5000); reload(); }
          catch (e2) { err.innerHTML = problemOf(e2); }
        }); } });
    });
    ctx.on('click', '[data-publish]', (e, t) => {
      const f = D.feeds.find((x) => x.id === t.dataset.publish); if (!f) return;
      const hosted = D.pdsAccounts.filter((a) => a.state === 'active');
      const opts = hosted.map((a) => ({ value: 'hosted:' + a.id, label: 'Hosted repo ' + a.handle })).concat([{ value: 'external', label: 'External account (app password)' }]);
      ctx.modal({ title: 'Publish feed record', body: UI.field('Publish to', UI.select(opts, opts[0].value, 'data-pt'), 'The record goes into that repo; the app password of an external account is used once and never stored.')
        + '<div data-pext' + (opts[0].value === 'external' ? '' : ' hidden') + '><div class="formgrid">' + UI.field('Handle or DID', UI.input('', { attrs: 'data-pid', placeholder: 'northwind.bsky.social' })) + UI.field('App password', UI.input('', { type: 'password', attrs: 'data-ppw autocomplete="off"' })) + '</div>' + UI.field('PDS URL (optional)', UI.input('', { attrs: 'data-purl', placeholder: 'https://bsky.social' })) + '</div>'
        + UI.code(JSON.stringify(f.record || {}, null, 2), 'json') + UI.notice('The published record names the generator\'s service DID. Publishing again replaces it.', 'info') + '<div data-perr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Publish', { kind: 'primary', attrs: 'data-pubgo' }),
        onMount(m) {
          const sel = m.querySelector('[data-pt]');
          sel.addEventListener('change', () => { m.querySelector('[data-pext]').hidden = sel.value !== 'external'; });
          m.querySelector('[data-pubgo]').addEventListener('click', async () => {
            const target = sel.value === 'external' ? Object.assign({ kind: 'external', identifier: m.querySelector('[data-pid]').value.trim(), appPassword: m.querySelector('[data-ppw]').value }, m.querySelector('[data-purl]').value.trim() ? { pdsUrl: m.querySelector('[data-purl]').value.trim() } : {}) : { kind: 'hosted', accountId: sel.value.slice(7) };
            try {
              const rec = await App.post('/api/admin/pds/feed-generators', Object.assign({ target, serviceDid: D.generator.did, rkey: f.rkey, displayName: f.displayName }, f.description ? { description: f.description } : {}));
              const did = (/^at:\/\/([^/]+)\//.exec(rec.uri) || [])[1];
              await App.api('PUT', '/api/atproto/feeds/' + enc(f.id) + '/publication', Object.assign({ did, uri: rec.uri }, rec.cid ? { cid: rec.cid } : {}));
              App.closeOverlay(); ctx.toast('Record published (201): ' + esc(rec.uri) + '. pds.feed.published and atproto.feed.published written.', 'ok', 6000); reload();
            } catch (err) { m.querySelector('[data-perr]').innerHTML = problemOf(err); }
          });
        } });
    });
  }
})();
