(function () {
  const { UI, esc } = App;

  // ---------- formatting ----------
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l) + 1;
  const CAPS = ['list', 'read', 'write', 'delete', 'destroy', 'encrypt', 'decrypt', 'rewrap', 'sign', 'verify', 'manage', '*'];
  const KINDS = ['user', 'group', 'workspace', 'api_key'];
  const r1 = (n) => Math.round(n * 10) / 10;
  const ttl = (s) => (s == null ? '' : s >= 86400 ? r1(s / 86400) + ' d' : s >= 3600 ? r1(s / 3600) + ' h' : s >= 60 ? r1(s / 60) + ' min' : s + ' s');
  const day = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : 'never');
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const mask = (v) => '•'.repeat(Math.min(14, Math.max(6, String(v).length)));
  const apiPath = (p) => p.split('/').map(enc).join('/');
  const kvp = (p) => 'kv/' + p;
  const overlayOpen = () => !!document.getElementById('overlay');
  const overdue = (x) => !!(x && x.rotationDueAt && x.rotationDueAt < Date.now());
  const myId = () => (App.me && App.me.user ? App.me.user.id : null);
  const myLabels = () => { const c = App.me && App.me.user ? App.me.user.clearance : 'internal'; return LABELS.filter((l) => rank(l) <= Math.max(1, rank(c))); };
  const trace = (err) => (err && err.problem && err.problem.trace_id) || false;
  const small = (html) => '<span class="muted" style="font-size:12px">' + html + '</span>';

  // ---------- names ----------
  const userOf = (st, id) => (st.users || []).find((u) => u.id === id);
  const plain = (st, kind, id) => { if (kind === 'user') { const u = userOf(st, id) || (id === myId() ? App.me.user : null); return u ? (u.displayName || u.username) : id; } if (kind === 'workspace') { const w = workspaces(st).find((x) => x.id === id); return w ? w.name : id; } return id; };
  const who = (st, id) => { if (!id) return 'nobody'; const u = userOf(st, id); if (u) return esc(u.displayName || u.username); if (id === myId()) return esc((App.me.user.displayName || App.me.user.username)); return '<span class="mono">' + esc(id) + '</span>'; };
  const workspaces = (st) => st.workspaces || ((App.me && App.me.workspaces) || []);
  const wsName = (st, id) => { const w = workspaces(st).find((x) => x.id === id); return w ? esc(w.name) : '<span class="mono">' + esc(id) + '</span>'; };
  const subjectText = (st, kind, subject) => (kind === 'user' ? who(st, subject) : kind === 'workspace' ? wsName(st, subject) : '<span class="mono">' + esc(subject) + '</span>');
  const userOptions = (st) => { const list = (st.users || []).filter((u) => u.state === 'active' || u.id === myId()); if (!list.some((u) => u.id === myId()) && App.me) list.unshift({ id: myId(), username: App.me.user.username, displayName: App.me.user.displayName }); return list.map((u) => ({ value: u.id, label: (u.displayName || u.username) + ' (' + u.username + ')' })); };

  function menu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  // ---------- loading ----------
  /** Everything the four tabs show, from the vault and lease APIs; names for ids come from the admin lists the caller may read. */
  async function loadAll() {
    const canConn = App.can('connections:manage');
    const tid = App.me && App.me.tenant ? App.me.tenant.id : null;
    const [list, keyList, pol, engines, leases, roles, users, ws, zones] = await Promise.all([
      App.get('/api/vault/kv'),
      App.get('/api/vault/transit/keys'),
      App.get('/api/vault/policies'),
      canConn ? App.get('/api/vault/database/engines') : Promise.resolve(null),
      App.get('/api/vault/database/leases?all=1&limit=500'),
      App.can('secrets:read') ? App.get('/api/vault/database/roles') : Promise.resolve({ roles: [] }),
      App.can('users:manage') ? App.get('/api/admin/users?limit=500').catch(() => null) : Promise.resolve(null),
      App.can('tenant:manage') && tid ? App.get('/api/admin/tenants/' + enc(tid) + '/workspaces').catch(() => null) : Promise.resolve(null),
      canConn && App.can('zones:manage') ? App.get('/api/admin/zones').catch(() => null) : Promise.resolve(null)
    ]);
    const secrets = await Promise.all(list.secrets.slice(0, 200).map((x) => App.get('/api/vault/kv/metadata/' + apiPath(x.path)).catch(() => Object.assign({ versions: [], customMetadata: {} }, x))));
    const keys = await Promise.all(keyList.keys.map((k) => App.get('/api/vault/transit/keys/' + enc(k.name)).catch(() => Object.assign({ versions: [], supports: [] }, k))));
    return { secrets, keys, grants: pol.policies, engines: engines ? engines.engines : null, leases: leases.leases, roles: roles.roles, users, workspaces: ws, zones: zones && zones.zones ? zones.zones.map((z) => z.id) : null };
  }

  /** A design state applied before the data arrived is shown once it has. States never call an unsafe API. */
  function applyPending(st) {
    const k = st.pending; if (!k) return; st.pending = null;
    const sel = st.secrets.find((x) => x.path === st.sel) || st.secrets[0];
    if (k === 'deny') {
      st.tab = 'policies';
      const g = st.grants.find((x) => x.effect === 'deny');
      st.denyDemo = g ? { grant: g, capability: g.capabilities.find((c) => c !== '*') || 'read', path: g.path === '*' ? 'kv' : g.path } : { grant: null };
      if (g) { st.explainIn.path = st.denyDemo.path; st.explainIn.capability = st.denyDemo.capability; if (g.subjectKind === 'user') st.explainIn.user = g.subject; }
    } else if (k === 'cas') {
      st.tab = 'kv';
      if (sel) { st.sel = sel.path; st.cas = { given: Math.max(0, sel.currentVersion - 1), current: sel.currentVersion }; }
      else st.flash = { kind: 'warn', html: '<b>No secret to check.</b> A write naming cas 3 while the current version is 4 is refused with 409 and currentVersion. A path that requires cas refuses every write that does not name the version it saw.' };
    } else if (k === 'gone') {
      st.tab = 'kv';
      const pick = (state) => { const s = (sel && sel.versions.some((v) => v.state === state)) ? sel : st.secrets.find((x) => x.versions.some((v) => v.state === state)); return s ? { s, v: s.versions.filter((v) => v.state === state).pop() } : null; };
      const hit = pick('destroyed') || pick('deleted');
      if (hit) { st.sel = hit.s.path; st.gone = { version: hit.v.version, state: hit.v.state }; }
      else st.flash = { kind: 'info', html: '<b>No version is destroyed.</b> Reading a destroyed version answers 410 with state destroyed: the sealed values are gone for good, the version number stays in the metadata.' };
    } else if (k === 'revoking') {
      st.tab = 'leases';
      const l = st.leases.find((x) => x.state === 'revoking');
      if (l) { st.leaseFilter = 'revoking'; st.leaseEngine = 'all'; st.selLease = l.id; }
      else st.flash = { kind: 'warn', html: '<b>No lease is waiting in revoking.</b> When the database refuses DROP USER, the lease waits in revoking with lastError and attempts; the sweeper retries with back-off (30 s doubling to an hour) and the connection admins are notified once.' };
    } else if (k === 'overdue') {
      st.tab = 'kv';
      const s = st.secrets.find(overdue);
      if (s) st.sel = s.path;
      else st.flash = { kind: 'danger', html: '<b>No secret is past its rotation schedule.</b> When one is, the rotation check sends its owner a due notice and then an overdue notice (audited vault.rotation.due and vault.rotation.overdue), once per version. Writing a new version starts the schedule again.' };
    }
  }

  const fresh = (st) => {
    if (st.init) return;
    Object.assign(st, { init: true, tab: 'kv', sel: null, query: '', selKey: null, subjectFilter: 'all', effectFilter: 'all', selEngine: null, leaseFilter: 'all', leaseEngine: 'all', selLease: null,
      revealed: {}, shown: {}, explainIn: { user: myId(), key: '', path: 'kv', capability: 'read' }, explainOut: null, cas: null, gone: null, password: null, tests: {}, flash: null, denyDemo: null });
  };
  const pend = (k, tab) => (ctx) => { fresh(ctx.state); ctx.state.pending = k; ctx.state.tab = tab; ctx.state.flash = null; ctx.state.cas = null; ctx.state.gone = null; ctx.state.denyDemo = null; ctx.rerender(); };

  App.register({
    id: 'vault', title: 'Vault', live: true, section: 'admin', crumb: ['Admin', 'Vault'],
    summary: 'KV secrets with versions, transit keys with rotation, path policies with explain, database leases and their engines',
    label: (st) => { const s = (st.secrets || []).find((x) => x.path === st.sel); return st.tab === 'kv' && s ? s.label : null; },
    commands: [
      { label: 'Explain vault access', sub: 'Vault', run(app) { const s = app.stateFor('vault'); fresh(s); s.tab = 'policies'; app.render(); } },
      { label: 'Take a database lease', sub: 'Vault', run(app) { const s = app.stateFor('vault'); fresh(s); s.tab = 'leases'; s.openLease = true; app.render(); } }
    ],
    states: [
      { title: 'Policy denies', tone: 'danger', text: 'A deny grant on the exact path refuses, however specific the allows: 403 with step vault-policy, the capability and the deciding grant; audited as vault.denied.', apply: pend('deny', 'policies') },
      { title: 'CAS conflict', tone: 'warn', text: 'A write naming an older cas than the current version is refused with 409 and currentVersion. A path that requires cas refuses every write that does not name the version it saw.', apply: pend('cas', 'kv') },
      { title: 'Version destroyed', tone: 'neutral', text: 'Reading a destroyed version answers 410 with state destroyed: the sealed values are gone for good, the version number stays in the metadata.', apply: pend('gone', 'kv') },
      { title: 'Lease revoke failed', tone: 'warn', text: 'The database refused DROP USER. The lease waits in revoking with lastError and attempts; the sweeper retries with back-off (30 s doubling to an hour) and the connection admins were notified once.', apply: pend('revoking', 'leases') },
      { title: 'Rotation overdue', tone: 'danger', text: 'A secret past its rotation period: the rotation check sent the due and overdue notices to its owner. Writing a new version starts the schedule again.', apply: pend('overdue', 'kv') }
    ],
    render(root, ctx) {
      const st = ctx.state; fresh(st);
      const style = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .vault-group{display:flex;flex-direction:column;gap:2px}'
        + '#main .vault-pol .timeline .tbody{font-size:13px}'
        + '#main .vault-val{overflow-wrap:anywhere}'
        + '</style>';
      const head = (actions) => UI.pagehead('Vault', 'Secrets, transit keys, path policies and short-lived database accounts for the ' + esc((App.me && App.me.tenant && App.me.tenant.name) || '') + ' tenant. Every answer is Cache-Control: no-store; values never reach the audit chain, logs or model context.', actions || '');

      // ---------- loading ----------
      const refresh = () => {
        if (App.state.route !== 'vault' || overlayOpen()) return;
        const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0;
        ctx.rerender();
        const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top;
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        loadAll().then((d) => { Object.assign(st, d, { loaded: true, loadError: null }); }).catch((err) => { st.loadError = err; }).finally(() => { st.loading = false; refresh(); });
      };
      const reload = () => loadAll().then((d) => { Object.assign(st, d); refresh(); }).catch((err) => App.fail(err, 'Could not refresh the vault'));
      if (!st.loaded && !st.loadError) load();
      if (st.loadError) { root.innerHTML = style + '<div class="page">' + head() + UI.problem('The vault could not be loaded', st.loadError.message, trace(st.loadError)) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div></div>'; ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); }); return; }
      if (!st.loaded) { root.innerHTML = style + '<div class="page">' + head() + UI.notice('Loading…', 'info') + '</div>'; return; }
      applyPending(st);

      if (ctx.params.path) { st.tab = 'kv'; const p = ctx.params.path.replace(/^kv\//, ''); if (st.secrets.some((s) => s.path === p)) st.sel = p; delete ctx.params.path; }
      if (ctx.params.key) { st.tab = 'transit'; if (st.keys.some((k) => k.name === ctx.params.key)) st.selKey = ctx.params.key; delete ctx.params.key; }
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }

      const nOverdue = st.secrets.filter(overdue).length;
      const tabs = UI.tabs([{ id: 'kv', label: 'KV secrets', count: st.secrets.length }, { id: 'transit', label: 'Transit keys', count: st.keys.length }, { id: 'policies', label: 'Policies', count: st.grants.length }, { id: 'leases', label: 'Database leases', count: st.leases.filter((l) => l.state === 'active').length }], st.tab);
      const flash = st.flash ? UI.notice(st.flash.html, st.flash.kind, UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearflash' })) : '';
      let left = '', body = '', insp = '';

      // ---------------- KV ----------------
      if (st.tab === 'kv') {
        const q = st.query.toLowerCase();
        const list = st.secrets.filter((s) => !q || kvp(s.path).includes(q));
        if (!list.some((s) => s.path === st.sel)) st.sel = list.length ? list[0].path : null;
        const s = st.secrets.find((x) => x.path === st.sel);
        const groups = {}; list.forEach((x) => { const g = kvp(x.path).split('/').slice(0, 2).join('/'); (groups[g] = groups[g] || []).push(x); });
        left = '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Paths</div>' + UI.btn('New secret', { size: 'xs', icon: 'plus', attrs: 'data-newsecret' }) + '</div>' + UI.search('Filter paths', 'data-search', st.query)
          + Object.keys(groups).map((g) => '<div class="vault-group"><div class="muted mono" style="font-size:11px;padding:4px 8px 0">' + esc(g) + '/</div>' + groups[g].map((x) => UI.listItem('<span class="mono">' + esc(kvp(x.path).slice(g.length + 1) || x.path) + '</span>', 'v' + x.currentVersion + ', ' + esc(day(x.updatedAt)) + (x.rotationPeriodDays ? ', rotates every ' + r1(x.rotationPeriodDays) + ' d' : ''), { active: x.path === st.sel, attrs: 'data-path="' + esc(x.path) + '"', right: overdue(x) ? UI.pill('overdue', 'danger') : UI.label(x.label, { sm: true }) })).join('') + '</div>').join('')
          + (list.length ? '' : st.secrets.length ? UI.empty('No paths match', 'Paths are 1 to 16 segments of lower-case letters, digits, dots, hyphens and underscores.') : UI.empty('No secrets you may list', 'Create a secret, or add a grant with list on kv under Policies: the vault is default deny.'))
          + small('Paths above your clearance, and paths your policy does not let you list, are not shown (404).') + '</div>';
        body += flash;
        if (s) {
          const rev = st.revealed[s.path];
          const rot = s.rotationPeriodDays ? (overdue(s) ? '<span style="color:var(--danger-fg)">every ' + r1(s.rotationPeriodDays) + ' d, overdue since ' + esc(day(s.rotationDueAt)) + '</span>' : 'every ' + r1(s.rotationPeriodDays) + ' d, due ' + esc(day(s.rotationDueAt))) : 'none';
          const cur = s.versions.find((v) => v.version === s.currentVersion);
          body += UI.pagehead(kvp(s.path), 'Current version ' + s.currentVersion + ', written ' + esc(day(s.updatedAt)) + (cur ? ' by ' + who(st, cur.createdBy) : '') + '. Values are sealed with the tenant data key; reads are audited as vault.secret.read (path, version and key count, never values).', UI.label(s.label) + UI.btn('Write new version', { kind: 'primary', size: 'sm', icon: 'edit', attrs: 'data-write' }) + UI.btn('Edit metadata', { size: 'sm', attrs: 'data-meta' }) + UI.btn('Rotation schedule', { size: 'sm', icon: 'clock', attrs: 'data-rotation' }) + UI.btn('Remove path', { kind: 'danger', size: 'sm', attrs: 'data-removepath' }))
            + (overdue(s) ? UI.notice('<b>Rotation overdue.</b> Version ' + s.currentVersion + ' was written ' + esc(day(s.rotatedAt)) + ' on a ' + r1(s.rotationPeriodDays) + ' day schedule, due ' + esc(day(s.rotationDueAt)) + '. ' + who(st, s.owner) + ' gets the due notice and then the overdue notice (audited vault.rotation.due and vault.rotation.overdue). Writing a new version starts the schedule again.', 'danger', UI.btn('Write new version', { size: 'sm', attrs: 'data-write' })) : '')
            + (st.cas ? UI.problem('Write refused: version check failed', 'The write named cas ' + st.cas.given + ' but the current version is ' + st.cas.current + '. 409 with currentVersion. ' + (s.casRequired ? 'This path requires cas, so read the metadata and write again naming version ' + st.cas.current + '.' : 'Write again naming version ' + st.cas.current + '.'), st.cas.trace || false) + '<div class="hstack">' + UI.btn('Retry with cas ' + st.cas.current, { size: 'sm', attrs: 'data-retrycas' }) + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearcas' }) + '</div>' : '')
            + (st.gone ? UI.notice('<b>Version ' + st.gone.version + ' is ' + esc(st.gone.state) + '.</b> 410 with state ' + esc(st.gone.state) + (st.gone.state === 'destroyed' ? ': the sealed values were removed for good' + ((s.versions.find((v) => v.version === st.gone.version) || {}).destroyedAt ? ' on ' + esc(day(s.versions.find((v) => v.version === st.gone.version).destroyedAt)) : '') + '. The version number stays in the metadata.' : ': undelete it to read it again.'), 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-cleargone' })) : '')
            + '<div class="grid2">' + UI.panel('Metadata', UI.kv([['Label', UI.label(s.label, { sm: true })], ['Current version', '<span class="num">' + s.currentVersion + '</span>'], ['Oldest kept', '<span class="num">' + (s.oldestVersion == null ? '' : s.oldestVersion) + '</span>'], ['Max versions', '<span class="num">' + s.maxVersions + '</span>'], ['CAS required', s.casRequired ? 'yes' : 'no'], ['Rotation', rot], ['Owner', who(st, s.owner)], ['Created', esc(day(s.createdAt)) + ' by ' + who(st, s.createdBy)]], 2) + (Object.keys(s.customMetadata || {}).length ? '<div class="eyebrow">Custom metadata</div><div class="vstack gap4" style="font-size:12px">' + Object.keys(s.customMetadata).map((k) => '<div><span class="mono">' + esc(k) + '</span> <span class="muted">=</span> ' + esc(s.customMetadata[k]) + '</div>').join('') + '</div>' : ''))
            + UI.panel('Referenced by', small('The server does not report which objects reference a path.') + '<span class="muted" style="font-size:12px">A <span class="mono">vault:' + esc(s.path) + '#key</span> reference (user stores, data connections, MCP servers, workflow HTTP steps, database engines) is read as the person who saved it, under their policy and clearance now, and audited with actor.via naming the object.</span>') + '</div>'
            + UI.panel('Versions', UI.table(['Version', 'State', 'Written by', 'Written', { label: '', right: true }], s.versions.slice().reverse().map((v) => ({ cells: ['<span class="num">' + v.version + '</span>' + (v.version === s.currentVersion ? ' ' + UI.pill('current', 'accent') : ''), UI.pill(v.state, v.state === 'active' ? 'ok' : v.state === 'deleted' ? 'warn' : 'danger') + (v.deletedAt && v.state === 'deleted' ? ' ' + small('deleted ' + esc(day(v.deletedAt))) : '') + (v.destroyedAt ? ' ' + small('destroyed ' + esc(day(v.destroyedAt))) : ''), who(st, v.createdBy), esc(when(v.createdAt)), '<span class="hstack gap6" style="justify-content:flex-end">' + (v.state === 'active' ? UI.btn(rev && rev.version === v.version ? 'Hide' : 'Reveal', { size: 'xs', attrs: 'data-reveal="' + v.version + '"' }) + UI.btn('Delete', { kind: 'ghost', size: 'xs', attrs: 'data-softdel="' + v.version + '"' }) : v.state === 'deleted' ? UI.btn('Undelete', { size: 'xs', attrs: 'data-undel="' + v.version + '"' }) : UI.btn('Reveal', { size: 'xs', attrs: 'data-reveal="' + v.version + '"' })) + (v.state !== 'destroyed' ? UI.btn('Destroy', { kind: 'ghost', size: 'xs', attrs: 'data-destroy="' + v.version + '"' }) : '') + '</span>'], attrs: 'data-version="' + v.version + '"' })), { clickable: false, minWidth: '0', emptyTitle: 'No versions kept' })
              + (rev ? '<div class="eyebrow">Version ' + rev.version + ' values</div>' + UI.notice('Revealed to you at ' + esc(when(rev.at)) + '; audited as <span class="mono">vault.secret.read</span> with the path, version and ' + Object.keys(rev.data).length + ' keys. Values stay masked until you show them.', 'info') + UI.table(['Key', 'Value', { label: '', right: true }], Object.keys(rev.data).map((k) => ['<span class="mono">' + esc(k) + '</span>', '<span class="mono vault-val">' + (st.shown[s.path + '#' + k] ? esc(rev.data[k]) : mask(rev.data[k])) + '</span>', '<span class="hstack gap6" style="justify-content:flex-end">' + UI.btn(st.shown[s.path + '#' + k] ? 'Hide' : 'Show', { kind: 'ghost', size: 'xs', attrs: 'data-show="' + esc(k) + '" aria-label="' + (st.shown[s.path + '#' + k] ? 'Hide ' : 'Show ') + esc(k) + '"' }) + UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-vcopy="' + esc(k) + '" aria-label="Copy ' + esc(k) + '"' }) + '</span>']), { clickable: false, minWidth: '0', cls: 'bare' }) : '')
              + small('Soft delete and undelete need secrets:write and the delete capability; destroy and removing the path need secrets:admin and destroy. Versions beyond max versions are removed oldest first.'));
        } else body += head() + UI.empty('Nothing selected', 'Pick a path on the left or create a secret.');
      }

      // ---------------- Transit ----------------
      if (st.tab === 'transit') {
        if (!st.keys.some((k) => k.name === st.selKey)) st.selKey = st.keys.length ? st.keys[0].name : null;
        const k = st.keys.find((x) => x.name === st.selKey);
        body += flash + '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">Named, versioned keys per tenant. Material is generated in the server, sealed with the tenant data key and never exported. Ciphertext and signatures are <span class="mono">exai:v&lt;version&gt;:&lt;base64&gt;</span>.</span>' + UI.btn('Create key', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newkey' }) + '</div>'
          + UI.table(['Name', 'Type', 'Label', 'Latest', 'Min decrypt', 'Rotation', 'Owner', 'Deletion'], st.keys.map((x) => ({ cells: ['<span class="mono">' + esc(x.name) + '</span>', '<span class="mono">' + esc(x.type) + '</span>', UI.label(x.label, { sm: true }), '<span class="num">v' + x.latestVersion + '</span>', '<span class="num">v' + x.minDecryptVersion + '</span>', x.rotationPeriodDays ? 'every ' + r1(x.rotationPeriodDays) + ' d' + (x.autoRotate ? ', automatic' : '') + ', due ' + esc(day(x.rotationDueAt)) + (overdue(x) ? ' ' + UI.pill('overdue', 'danger') : '') : '<span class="muted">none</span>', who(st, x.owner), x.deletionAllowed ? UI.pill('allowed', 'warn') : '<span class="muted">locked</span>'], attrs: 'data-key="' + esc(x.name) + '"', selected: x.name === st.selKey })), { minWidth: '820px', emptyTitle: 'No transit keys you may list', emptyText: 'Create a key, or add a grant with list on transit under Policies.' });
        if (k) {
          const latest = k.versions.find((v) => v.version === k.latestVersion);
          insp = '<div class="hstack"><div class="eyebrow grow">Selected key</div>' + UI.label(k.label, { sm: true }) + '</div><div style="font-size:15px;font-weight:600" class="mono">' + esc(k.name) + '</div>'
            + UI.kv([['Type', '<span class="mono">' + esc(k.type) + '</span>'], ['Supports', esc((k.supports || []).join(', '))], ['Latest version', '<span class="num">' + k.latestVersion + '</span>'], ['Min decrypt version', '<span class="num">' + k.minDecryptVersion + '</span>'], ['Min available', '<span class="num">' + k.minAvailableVersion + '</span>'], ['Deletion allowed', k.deletionAllowed ? 'yes' : 'no'], ['Rotation', k.rotationPeriodDays ? 'every ' + r1(k.rotationPeriodDays) + ' d' + (k.autoRotate ? ' (automatic)' : '') : 'none'], ['Owner', who(st, k.owner)]], 2)
            + '<div class="eyebrow">Versions</div>' + UI.table(['Version', 'Created', 'State'], k.versions.slice().reverse().map((v) => ['<span class="num">v' + v.version + '</span>' + (v.version === k.latestVersion ? ' ' + UI.pill('latest', 'accent') : ''), esc(day(v.createdAt)), v.version < k.minDecryptVersion ? UI.pill('below minimum', 'warn') : UI.pill(v.version === k.latestVersion ? (k.type === 'aes256-gcm96' ? 'encrypts and decrypts' : 'signs and verifies') : (k.type === 'aes256-gcm96' ? 'decrypts' : 'verifies'), v.version === k.latestVersion ? 'ok' : '')]), { clickable: false, minWidth: '0', cls: 'bare' })
            + (latest && latest.publicKey ? '<div class="eyebrow">Public key v' + k.latestVersion + ' (SPKI PEM)</div>' + UI.code(latest.publicKey.trim(), 'pem') : '')
            + '<div class="hstack wrap gap6">' + UI.btn('Rotate', { kind: 'primary', size: 'sm', icon: 'refresh', attrs: 'data-rotatekey' }) + UI.btn('Configure', { size: 'sm', attrs: 'data-configkey' }) + UI.btn('Trim', { size: 'sm', attrs: 'data-trimkey', disabled: k.minDecryptVersion <= k.minAvailableVersion }) + UI.btn('Try it', { size: 'sm', icon: 'play', attrs: 'data-trykey' }) + UI.btn('Delete', { kind: 'danger', size: 'sm', attrs: 'data-delkey' }) + '</div>'
            + small('Audit: key.created, .rotated, .configured, .trimmed, .deleted; decrypted, rewrapped and signed (counts only). Encrypt and verify reveal nothing and are not audited.');
        }
      }

      // ---------------- Policies ----------------
      if (st.tab === 'policies') {
        const rows = st.grants.filter((g) => (st.subjectFilter === 'all' || g.subjectKind === st.subjectFilter) && (st.effectFilter === 'all' || g.effect === st.effectFilter));
        const ex = st.explainOut;
        const users = userOptions(st);
        const grantLine = (g) => '<span class="mono">' + esc(g.id) + '</span>: ' + esc(g.effect) + ' ' + esc(g.capabilities.join(', ')) + ' on <span class="mono">' + esc(g.path) + '</span> to ' + esc(g.subjectKind.replace('_', ' ')) + ' ' + subjectText(st, g.subjectKind, g.subject);
        const dd = st.denyDemo;
        const denyPanel = dd ? (dd.grant ? UI.problem('Request refused: vault policy', 'A request for ' + dd.capability + ' on ' + dd.path + ' by ' + dd.grant.subjectKind.replace('_', ' ') + ' ' + plain(st, dd.grant.subjectKind, dd.grant.subject) + ' answers 403 with step vault-policy, the path, the capability and deciding grant ' + dd.grant.id.slice(-8) + ' (deny ' + dd.grant.capabilities.join(', ') + ' on ' + dd.grant.path + '). Any matching deny refuses, however specific the allows. Audited as vault.denied.', false) : UI.problem('Request refused: vault policy', 'No deny grant exists in this tenant, so only paths nothing allows are refused: 403 with step vault-policy and grant null (default deny), audited as vault.denied.', false)) + '<div>' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-cleardeny' }) + '</div>' : '';
        body += flash + '<div class="grid2 vault-pol">' + UI.panel('Explain access', denyPanel + '<div class="formgrid">' + UI.field('User', UI.select(users, st.explainIn.user, 'data-exuser'), 'Another user or key needs secrets:admin') + UI.field('API key id (optional)', UI.input(st.explainIn.key, { attrs: 'data-exkey', placeholder: '26-character key id' }), 'A key acts as its owner plus itself') + UI.field('Path', UI.input(st.explainIn.path, { attrs: 'data-expath', placeholder: 'kv/apps/erp/db, transit/ledger-fields' })) + UI.field('Capability', UI.select(CAPS.filter((c) => c !== '*'), st.explainIn.capability, 'data-excap')) + '</div><div>' + UI.btn('Explain', { kind: 'primary', size: 'sm', attrs: 'data-explain' }) + '</div>'
          + (ex ? '<div class="divider"></div><div data-explain-out>' + (ex.decision.allow ? UI.notice('<b>Allowed.</b> ' + esc(ex.decision.reason) + '.' + (ex.decision.grant ? ' Deciding grant ' + grantLine(ex.decision.grant) + '.' : ''), 'ok') : UI.notice('<b>Denied.</b> ' + esc(ex.decision.reason) + '.' + (ex.decision.grant ? ' Deciding grant ' + grantLine(ex.decision.grant) + '.' : '') + ' The request answers <span class="mono">403</span> with step vault-policy, the path, the capability and this grant; audited as vault.denied.', 'danger'))
            + UI.kv([['Subject', who(st, ex.subjects.userId)], ['Groups', esc(ex.subjects.groups.join(', ') || 'none')], ['Workspaces', ex.subjects.workspaces.length ? ex.subjects.workspaces.map((w) => wsName(st, w)).join(', ') : 'none'], ['API key', ex.subjects.apiKeyId ? '<span class="mono">' + esc(ex.subjects.apiKeyId) + '</span>' : 'none']], 2)
            + '<div class="eyebrow">Grants covering ' + esc(ex.decision.path) + ', most specific first</div>' + (ex.grants.length ? UI.timeline(ex.grants.map((g) => ({ title: '<span class="mono">' + esc(g.grant.id) + '</span> ' + esc(g.grant.effect) + ' ' + esc(g.grant.capabilities.join(', ')) + ' on <span class="mono">' + esc(g.grant.path) + '</span>' + (g.deciding ? ' ' + UI.pill('deciding', g.grant.effect === 'allow' ? 'ok' : 'danger') : ''), text: esc(g.grant.subjectKind.replace('_', ' ')) + ' ' + subjectText(st, g.grant.subjectKind, g.grant.subject) + (g.appliesToCapability ? '' : ', does not cover ' + esc(ex.decision.capability)), tone: g.deciding ? (g.grant.effect === 'allow' ? 'ok' : 'danger') : g.appliesToCapability ? 'warn' : '' }))) : small('No grant names this subject on a covering path.')) + '</div>'
            : small('Any matching deny refuses, however specific the allows; otherwise the longest matching allow decides; nothing matching is a default deny. Prefixes match whole segments (kv/apps covers kv/apps/db, not kv/apps2).')))
          + UI.panel('Who can', UI.field('Capability on path', '<div class="hstack wrap gap6">' + UI.input(st.whoPath || 'kv', { attrs: 'data-whopath aria-label="Path"' }) + UI.select(CAPS.filter((c) => c !== '*'), st.whoCap || 'read', 'data-whocap aria-label="Capability"') + UI.btn('Check', { size: 'sm', attrs: 'data-who' }) + '</div>')
            + (st.whoOut ? UI.table(['User', 'Decision', 'Deciding grant'], st.whoOut.map((w) => [who(st, w.user), UI.pill(w.allow ? 'allowed' : 'denied', w.allow ? 'ok' : 'danger'), w.grant ? '<span class="mono">' + esc(w.grant.id) + '</span> ' + esc(w.grant.subjectKind.replace('_', ' ')) + ' ' + subjectText(st, w.grant.subjectKind, w.grant.subject) : '<span class="muted">default deny</span>']), { clickable: false, minWidth: '0', cls: 'bare' }) : small('Runs explain for every active user of the tenant' + (st.users ? '' : ' you can see (users:manage shows the others)') + '. Each row is the same answer the vault gives that person.'))) + '</div>'
          + '<div class="hstack wrap"><div class="toolbar grow"><span class="relative">' + UI.btn(st.subjectFilter === 'all' ? 'Subject kind' : 'Subject: ' + st.subjectFilter, { size: 'sm', icon: 'filter', attrs: 'data-menu="subject"', cls: st.subjectFilter !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn(st.effectFilter === 'all' ? 'Effect' : 'Effect: ' + st.effectFilter, { size: 'sm', icon: 'filter', attrs: 'data-menu="effect"', cls: st.effectFilter !== 'all' ? 'active' : '' }) + '</span>' + small(rows.length + ' of ' + st.grants.length + ' grants') + '</div>' + UI.btn('Add grant', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newgrant' }) + '</div>'
          + UI.table(['Grant', 'Subject', 'Path prefix', 'Capabilities', 'Effect', 'Description', 'Created', { label: '', right: true }], rows.map((g) => ({ cells: ['<span class="mono">' + esc(g.id.slice(-8)) + '</span>', small(esc(g.subjectKind.replace('_', ' '))) + ' ' + (g.subjectKind === 'workspace' ? '<a href="#" data-go="tenants">' + subjectText(st, g.subjectKind, g.subject) + '</a>' : g.subjectKind === 'group' ? '<a href="#" data-go="directories">' + esc(g.subject) + '</a>' : subjectText(st, g.subjectKind, g.subject)), '<span class="mono">' + esc(g.path) + '</span>', g.capabilities.map((c) => UI.pill(c, c === '*' ? 'accent' : 'outline')).join(' '), UI.pill(g.effect, g.effect === 'allow' ? 'ok' : 'danger'), esc(g.description || ''), esc(day(g.createdAt)) + ' by ' + who(st, g.createdBy), '<span class="hstack gap6" style="justify-content:flex-end">' + UI.btn('Edit', { kind: 'ghost', size: 'xs', attrs: 'data-editgrant="' + esc(g.id) + '" aria-label="Edit grant ' + esc(g.id) + '"' }) + UI.btn('Delete', { kind: 'ghost', size: 'xs', attrs: 'data-delgrant="' + esc(g.id) + '" aria-label="Delete grant ' + esc(g.id) + '"' }) + '</span>'], attrs: 'data-grant="' + esc(g.id) + '"' })), { clickable: false, minWidth: '980px', emptyTitle: st.grants.length ? 'No grants match' : 'No grants yet', emptyText: st.grants.length ? 'Change the filters.' : 'The vault is default deny: nobody reaches a path until a grant allows it.' });
      }

      // ---------------- Leases ----------------
      if (st.tab === 'leases') {
        const engines = st.engines || [];
        if (!engines.some((e) => e.name === st.selEngine)) st.selEngine = engines.length ? engines[0].name : null;
        const eng = engines.find((e) => e.name === st.selEngine);
        const rows = st.leases.filter((l) => (st.leaseFilter === 'all' || l.state === st.leaseFilter) && (st.leaseEngine === 'all' || l.engine === st.leaseEngine));
        const failing = st.leases.find((l) => l.id === st.selLease && l.state === 'revoking');
        const pw = st.password;
        body += flash
          + (pw ? UI.notice('<b>Lease ' + esc(pw.id) + ' issued.</b> The password is in this answer only; it is not stored. <div class="mono vault-val" style="margin-top:4px;font-size:12px">' + esc(pw.connection.dialect === 'postgres' ? 'postgresql' : 'mysql') + '://' + esc(pw.username) + ':' + esc(pw.password) + '@' + esc(pw.connection.endpoint) + '/' + esc(pw.connection.database || '') + (pw.connection.tls ? '?sslmode=require' : '') + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-pwcopy' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-pwdone' })) : '')
          + (failing ? UI.notice('<b>Revoke failed for ' + esc(failing.username) + '.</b> <span class="mono">' + esc(failing.lastError || 'The database refused the drop.') + '</span>. Attempt ' + failing.attempts + ' of the sweeper\'s back-off (30 s doubling to an hour). The connection and tenant admins and the engine\'s owner were notified on the first failure. The account\'s grants were revoked already.', 'warn', st.engines ? UI.btn('Run sweep now', { size: 'sm', attrs: 'data-sweep' }) : '') : '')
          + (st.engines ? '<div class="hstack wrap"><div class="eyebrow grow">Engines</div>' + UI.btn('Register engine', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newengine' }) + UI.btn('Run sweep', { size: 'sm', icon: 'refresh', attrs: 'data-sweep' }) + '</div>'
            + UI.table(['Engine', 'Dialect', 'Endpoint', 'Database', 'Zone', 'Label', 'Admin login', 'TTL default / max', 'Roles', 'Live leases', 'State'], engines.map((e) => ({ cells: ['<span class="mono">' + esc(e.name) + '</span>', esc(e.dialect), '<span class="mono" style="font-size:12px">' + esc(e.endpoint) + '</span>' + (e.tls ? ' ' + UI.pill('tls', 'outline') : ''), '<span class="mono">' + esc(e.database || '') + '</span>', '<a href="#" data-go="zones">' + esc(e.zone) + '</a>', UI.label(e.label, { sm: true }), '<span class="mono">' + esc(e.adminUsername) + '</span> ' + small(e.adminPasswordFrom === 'vault' && e.adminPasswordRef ? '<a href="#" data-gopath="' + esc(e.adminPasswordRef.replace(/^vault:/, '').replace(/#.*$/, '')) + '">' + esc(e.adminPasswordRef) + '</a>' : 'sealed password'), ttl(e.defaultTtlSeconds) + ' / ' + ttl(e.maxTtlSeconds), '<span class="num">' + e.roles.length + '</span>', '<span class="num">' + e.activeLeases + '</span>', UI.pill(e.state, e.state === 'active' ? 'ok' : '')], attrs: 'data-engine="' + esc(e.name) + '"', selected: e.name === st.selEngine })), { minWidth: '1100px', emptyTitle: 'No engines registered', emptyText: 'Register a PostgreSQL or MySQL server whose admin can create accounts; leases are taken on its roles.' })
            : UI.notice('Engines and their roles need connections:manage, which none of your roles grant. The leases below are those in the tenant.', 'info'))
          + '<div class="hstack wrap"><div class="eyebrow grow">Leases</div><div class="toolbar"><span class="relative">' + UI.btn(st.leaseFilter === 'all' ? 'State' : 'State: ' + st.leaseFilter, { size: 'sm', icon: 'filter', attrs: 'data-menu="lease"', cls: st.leaseFilter !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn(st.leaseEngine === 'all' ? 'Engine' : 'Engine: ' + st.leaseEngine, { size: 'sm', icon: 'filter', attrs: 'data-menu="leaseengine"', cls: st.leaseEngine !== 'all' ? 'active' : '' }) + '</span>' + UI.btn('Take lease', { kind: 'primary', size: 'sm', icon: 'key', attrs: 'data-takelease' }) + '</div></div>'
          + UI.table(['Account', 'Engine / role', 'Issued to', 'Issued', 'Expires', 'Max expiry', 'Renewals', 'State', { label: '', right: true }], rows.map((l) => ({ cells: ['<span class="mono" style="font-size:12px">' + esc(l.username) + '</span>', '<span class="mono">' + esc(l.engine) + '/' + esc(l.role) + '</span>', who(st, l.issuedTo) + (l.issuedTo === myId() ? ' ' + UI.pill('you', 'accent') : ''), esc(when(l.issuedAt)), esc(when(l.expiresAt)), esc(when(l.maxExpiresAt)), '<span class="num">' + l.renewals + '</span>', UI.pill(l.state, l.state === 'active' ? 'ok' : l.state === 'revoking' ? 'warn' : l.state === 'revoked' ? 'danger' : ''), '<span class="hstack gap6" style="justify-content:flex-end">' + (l.state === 'active' ? UI.btn('Renew', { size: 'xs', attrs: 'data-renew="' + esc(l.id) + '"' }) + UI.btn('Revoke', { kind: 'ghost', size: 'xs', attrs: 'data-revoke="' + esc(l.id) + '"' }) : l.state === 'revoking' ? UI.btn('Retry drop', { size: 'xs', attrs: 'data-retrydrop="' + esc(l.id) + '"' }) : '') + '</span>'], attrs: 'data-lease="' + esc(l.id) + '"', selected: l.id === st.selLease })), { minWidth: '1100px', emptyTitle: st.leases.length ? 'No leases match' : 'No leases', emptyText: st.leases.length ? 'Change the filters.' : 'Nobody in the tenant holds a database lease.' })
          + small('Every lease in the tenant is shown (connections:manage or secrets:admin); members see their own. Generated names are exai_&lt;role&gt;_&lt;12 hex&gt;; PostgreSQL accounts carry VALID UNTIL the expiry, MySQL relies on the sweeper.');
        if (eng) {
          const t = st.tests[eng.name];
          insp = '<div class="hstack"><div class="eyebrow grow">Selected engine</div>' + UI.pill(eng.state, eng.state === 'active' ? 'ok' : '') + '</div><div style="font-size:15px;font-weight:600" class="mono">' + esc(eng.name) + '</div>'
            + UI.kv([['Dialect', esc(eng.dialect)], ['Endpoint', '<span class="mono" style="font-size:12px">' + esc(eng.endpoint) + '</span>'], ['Database', '<span class="mono">' + esc(eng.database || 'n/a') + '</span>'], ['Zone', esc(eng.zone)], ['Admin login', '<span class="mono">' + esc(eng.adminUsername) + '</span>'], ['Password from', eng.adminPasswordFrom === 'vault' ? '<span class="mono" style="font-size:11px">' + esc(eng.adminPasswordRef || '') + '</span>' : 'sealed, never shown again'], ['User host', esc(eng.dialect === 'mysql' ? eng.userHost || '%' : 'n/a')], ['Registered', esc(day(eng.createdAt)) + ' by ' + who(st, eng.createdBy)]], 2)
            + (t ? (t.ok ? UI.notice('<b>Last check:</b> ' + esc(t.version || '') + '. ' + esc(t.detail) + (t.ms != null ? ' (' + t.ms + ' ms)' : '') + '.', 'ok') : UI.notice('<b>Last check failed:</b> ' + (t.version ? esc(t.version) + '. ' : '') + esc(t.detail) + '. Leases fail until the admin can log in and create accounts.', 'danger')) : small('Not tested in this session. Test connection logs in as the admin and checks it can create accounts.'))
            + '<div class="hstack"><div class="eyebrow grow">Roles</div>' + UI.btn('Add role', { size: 'xs', icon: 'plus', attrs: 'data-newrole' }) + '</div>'
            + (eng.roles.length ? UI.table(['Role', 'Privileges', 'TTL', { label: '', right: true }], eng.roles.map((r) => ['<span class="mono">' + esc(r.name) + '</span><div class="mono muted" style="font-size:11px;overflow-wrap:anywhere">' + esc(r.schemas.join(', ')) + '</div>', '<span title="' + esc(r.privileges === 'read' ? 'SELECT' : 'SELECT, INSERT, UPDATE, DELETE') + '">' + esc(r.privileges) + '</span>', '<span style="white-space:nowrap">' + ttl(r.defaultTtlSeconds) + ' / ' + ttl(r.maxTtlSeconds) + '</span>', UI.btn('Remove', { kind: 'ghost', size: 'xs', attrs: 'data-delrole="' + esc(r.name) + '" aria-label="Remove role ' + esc(r.name) + '"', disabled: st.leases.some((l) => l.engine === eng.name && l.role === r.name && (l.state === 'active' || l.state === 'revoking')), title: 'Refused (409) while the role has live leases' })]), { clickable: false, minWidth: '0', cls: 'bare' }) : UI.empty('No roles', 'A role names the privileges and schemas a lease gets.'))
            + '<div class="hstack wrap gap6">' + UI.btn('Test connection', { size: 'sm', icon: 'play', attrs: 'data-testengine' }) + UI.btn(eng.state === 'active' ? 'Disable' : 'Enable', { size: 'sm', attrs: 'data-toggleengine' }) + UI.btn('Delete', { kind: 'danger', size: 'sm', attrs: 'data-delengine' }) + '</div>'
            + small('Policy paths: <span class="mono">database/' + esc(eng.name) + '/&lt;role&gt;</span>; read takes a lease, list shows the role.');
        }
      }

      root.innerHTML = style + left
        + '<div class="page">' + (st.tab === 'kv' ? '' : head(nOverdue ? UI.pill(nOverdue + ' rotation overdue', 'danger') : ''))
        + tabs + body
        + '</div>'
        + (insp ? '<aside class="inspector w360" aria-label="Inspector">' + insp + '</aside>' : '');

      // ---- events ----
      const ok = (msg, kind) => { ctx.toast(msg, kind || 'ok', 5000); };
      const act = async (fn, msg, kind) => { try { const out = await fn(); if (msg) ok(typeof msg === 'function' ? msg(out) : msg, kind); await reload(); return out; } catch (err) { App.fail(err); await reload(); return null; } };
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; st.flash = null; ctx.rerender(); });
      ctx.on('click', '[data-clearflash]', () => { st.flash = null; ctx.rerender(); });
      ctx.on('click', '[data-path]', (e, t) => { st.sel = t.dataset.path; st.cas = null; st.gone = null; ctx.rerender(); });
      ctx.on('click', '[data-gopath]', (e, t) => { e.preventDefault(); st.tab = 'kv'; st.sel = t.dataset.gopath; ctx.rerender(); });
      ctx.on('click', 'tr[data-key]', (e, t) => { st.selKey = t.dataset.key; ctx.rerender(); });
      ctx.on('click', 'tr[data-engine]', (e, t) => { if (e.target.closest('a')) return; st.selEngine = t.dataset.engine; ctx.rerender(); });
      ctx.on('click', 'tr[data-lease]', (e, t) => { if (e.target.closest('button')) return; st.selLease = t.dataset.lease; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-menu]', (e, t) => {
        const k = t.dataset.menu;
        if (k === 'subject') menu(ctx, t, [['all', 'Every subject kind'], ['user', 'Users'], ['group', 'Directory groups'], ['workspace', 'Workspaces'], ['api_key', 'API keys']], st.subjectFilter, (v) => { st.subjectFilter = v; ctx.rerender(); });
        if (k === 'effect') menu(ctx, t, [['all', 'Allow and deny'], ['allow', 'Allow'], ['deny', 'Deny']], st.effectFilter, (v) => { st.effectFilter = v; ctx.rerender(); });
        if (k === 'lease') menu(ctx, t, [['all', 'Every state'], ['active', 'Active'], ['revoking', 'Revoking'], ['revoked', 'Revoked'], ['expired', 'Expired']], st.leaseFilter, (v) => { st.leaseFilter = v; ctx.rerender(); });
        if (k === 'leaseengine') menu(ctx, t, [['all', 'Every engine']].concat([...new Set((st.engines || []).map((x) => x.name).concat(st.leases.map((l) => l.engine)))].map((n) => [n, n])), st.leaseEngine, (v) => { st.leaseEngine = v; ctx.rerender(); });
      });

      // KV
      const sec = st.secrets.find((x) => x.path === st.sel);
      const kvUrl = (kind) => '/api/vault/kv/' + kind + '/' + apiPath(sec.path);
      ctx.on('click', '[data-reveal]', async (e, t) => {
        const v = +t.dataset.reveal; const ver = sec.versions.find((x) => x.version === v);
        const rev = st.revealed[sec.path];
        if (rev && rev.version === v) { delete st.revealed[sec.path]; ctx.rerender(); return; }
        if (ver && ver.state !== 'active') {
          try { await App.get(kvUrl('data') + '?version=' + v); } catch (err) { if (err.status === 410) { st.gone = { version: v, state: err.problem.state || ver.state }; ctx.rerender(); } else App.fail(err); }
          return;
        }
        const yes = await ctx.confirm({ title: 'Reveal version ' + v + ' of ' + esc(kvp(sec.path)), tag: 'audited', tone: 'info', body: '<p class="fg2" style="margin:0">The read is written to the audit chain as <span class="mono">vault.secret.read</span> with the path, the version and the number of keys, never the values. Your policy must allow read here.</p>', ok: 'Reveal' });
        if (!yes) return;
        try { const out = await App.get(kvUrl('data') + '?version=' + v); st.revealed[sec.path] = { version: out.version, data: out.data, at: Date.now() }; st.gone = null; ctx.rerender(); ok('Version ' + v + ' revealed. Audit entry written.'); }
        catch (err) { if (err.status === 410) { st.gone = { version: v, state: err.problem.state || 'deleted' }; ctx.rerender(); } else App.fail(err); }
      });
      ctx.on('click', '[data-show]', (e, t) => { const k = sec.path + '#' + t.dataset.show; st.shown[k] = !st.shown[k]; ctx.rerender(); });
      ctx.on('click', '[data-vcopy]', (e, t) => { const rev = st.revealed[sec.path]; const v = rev ? rev.data[t.dataset.vcopy] : null; try { if (navigator.clipboard && v != null) navigator.clipboard.writeText(v).catch(() => undefined); } catch (err) { /* clipboard unavailable */ } ctx.toast('Copied the value of ' + esc(t.dataset.vcopy) + '.'); });
      ctx.on('click', '[data-write]', () => writeModal(ctx, sec, null, reload));
      ctx.on('click', '[data-retrycas]', () => { const c = st.cas.current; st.cas = null; ctx.rerender(); writeModal(ctx, st.secrets.find((x) => x.path === st.sel), c, reload); });
      ctx.on('click', '[data-clearcas]', () => { st.cas = null; ctx.rerender(); });
      ctx.on('click', '[data-cleargone]', () => { st.gone = null; ctx.rerender(); });
      ctx.on('click', '[data-softdel]', (e, t) => { const v = +t.dataset.softdel; ctx.confirm({ title: 'Delete version ' + v, tag: 'soft', tone: 'warn', body: '<p class="fg2" style="margin:0">A soft delete: the version answers 410 with state deleted until it is undeleted. Needs secrets:write and the delete capability.</p>', kv: [['Path', esc(kvp(sec.path))]], ok: 'Delete' }).then((yes) => { if (!yes) return; if (st.revealed[sec.path] && st.revealed[sec.path].version === v) delete st.revealed[sec.path]; act(() => App.post(kvUrl('delete'), { versions: [v] }), 'Version ' + v + ' deleted. Audited vault.secret.deleted.'); }); });
      ctx.on('click', '[data-undel]', (e, t) => { const v = +t.dataset.undel; st.gone = null; act(() => App.post(kvUrl('undelete'), { versions: [v] }), 'Version ' + v + ' undeleted; readable again. Audited vault.secret.undeleted.'); });
      ctx.on('click', '[data-destroy]', (e, t) => { const v = +t.dataset.destroy; ctx.confirm({ title: 'Destroy version ' + v, tag: 'secrets:admin', tone: 'danger', body: '<p class="fg2" style="margin:0">Removes the sealed values for good. The version number stays in the metadata; anything referencing this version fails from now on.</p>', kv: [['Path', esc(kvp(sec.path))]], ok: 'Destroy' }).then((yes) => { if (!yes) return; if (st.revealed[sec.path] && st.revealed[sec.path].version === v) delete st.revealed[sec.path]; act(() => App.post(kvUrl('destroy'), { versions: [v] }), 'Version ' + v + ' destroyed. Audited vault.secret.destroyed.', 'danger'); }); });
      ctx.on('click', '[data-removepath]', () => ctx.confirm({ title: 'Remove ' + esc(kvp(sec.path)), tag: 'secrets:admin', tone: 'danger', body: '<p class="fg2" style="margin:0">Removes the path, its metadata and every version (204). Objects that reference it with <span class="mono">vault:' + esc(sec.path) + '#key</span> fail at their next use: a store reports an error, a connection query is 403, a workflow step fails without calling out.</p>', ok: 'Remove path' }).then((yes) => { if (!yes) return; const p = sec.path; delete st.revealed[p]; st.sel = null; act(() => App.del(kvUrl('metadata')), esc(kvp(p)) + ' removed. Audited vault.secret.removed.', 'danger'); }));
      ctx.on('click', '[data-meta]', () => ctx.modal({ title: 'Edit metadata', body: '<div class="formgrid">' + UI.field('Max versions', UI.input(String(sec.maxVersions), { type: 'number', attrs: 'data-mmax min="1" max="100"' }), 'Lowering it removes older versions at once') + UI.field('Label', UI.select(myLabels(), sec.label, 'data-mlabel'), 'At most your clearance') + '<div class="span2">' + UI.field('Custom metadata', UI.textarea(Object.keys(sec.customMetadata || {}).map((k) => k + '=' + sec.customMetadata[k]).join('\n'), { rows: 3, placeholder: 'key=value, one per line', attrs: 'data-mcustom' })) + '</div></div>' + UI.toggle('Require cas on every write', sec.casRequired, 'data-mcas'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-msave' }), onMount(m) {
        m.querySelector('[data-msave]').addEventListener('click', async () => {
          const custom = {}; m.querySelector('[data-mcustom]').value.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => { const i = l.indexOf('='); if (i > 0) custom[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
          const body = { maxVersions: Math.max(1, Math.min(100, +m.querySelector('[data-mmax]').value || sec.maxVersions)), label: m.querySelector('[data-mlabel]').value, casRequired: m.querySelector('[data-mcas]').getAttribute('aria-checked') === 'true' || m.querySelector('[data-mcas]').classList.contains('on'), customMetadata: custom };
          try { await App.patch(kvUrl('metadata'), body); } catch (err) { App.fail(err); return; }
          App.closeOverlay(); ok('Metadata saved. Audited vault.secret.metadata.updated.'); reload();
        });
      } }));
      ctx.on('click', '[data-rotation]', () => ctx.modal({ title: 'Rotation schedule for ' + esc(kvp(sec.path)), body: '<p class="fg2" style="margin:0">A secret whose current version falls due within VAULT_ROTATION_NOTICE_DAYS gets a due notice and one past its period an overdue notice, once per version, to the owner (or the tenant admins when the owner is no longer active). Writing a new version starts the schedule again.</p><div class="formgrid">' + UI.field('Rotate every (days)', UI.input(sec.rotationPeriodDays ? String(sec.rotationPeriodDays) : '', { type: 'number', placeholder: 'empty clears the schedule', attrs: 'data-rdays min="0.01" step="any"' })) + UI.field('Owner', ownerControl(st, sec.owner, 'data-rowner')) + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-rsave' }), onMount(m) {
        m.querySelector('[data-rsave]').addEventListener('click', async () => {
          const raw = m.querySelector('[data-rdays]').value.trim(); const d = raw === '' ? null : +raw; const owner = m.querySelector('[data-rowner]').value.trim() || null;
          try { await App.patch(kvUrl('metadata'), { rotationPeriodDays: d, owner }); } catch (err) { App.fail(err); return; }
          App.closeOverlay(); ok(d ? 'Rotation every ' + r1(d) + ' days; ' + who(st, owner || sec.createdBy) + ' gets the notices.' : 'Rotation schedule cleared.'); reload();
        });
      } }));
      ctx.on('click', '[data-newsecret]', () => writeModal(ctx, null, null, reload));

      // transit
      const key = st.keys.find((x) => x.name === st.selKey);
      const keyUrl = (suffix) => '/api/vault/transit/keys/' + enc(key.name) + (suffix || '');
      ctx.on('click', '[data-newkey]', () => ctx.modal({ title: 'Create transit key', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'lower-case letters, digits, . - _', attrs: 'data-kname' })) + UI.field('Type', UI.select(['aes256-gcm96', 'ed25519', 'ecdsa-p256'], 'aes256-gcm96', 'data-ktype'), 'aes: encrypt, decrypt, rewrap; ed25519 and p256: sign, verify') + UI.field('Label', UI.select(myLabels(), 'internal', 'data-klabel')) + '</div>' + UI.notice('Material is generated in the server and sealed with the tenant data key; it is never exported. Needs secrets:admin and the manage capability on transit/&lt;name&gt;.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-kcreate' }), onMount(m) {
        m.querySelector('[data-kcreate]').addEventListener('click', async () => {
          const name = m.querySelector('[data-kname]').value.trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) { ctx.toast('Names are 1 to 64 lower-case letters, digits, dots, hyphens and underscores.', 'warn'); return; }
          try { await App.post('/api/vault/transit/keys', { name, type: m.querySelector('[data-ktype]').value, label: m.querySelector('[data-klabel]').value }); } catch (err) { App.fail(err); return; }
          st.selKey = name; App.closeOverlay(); ok('Key ' + esc(name) + ' created. Audited vault.transit.key.created.'); reload();
        });
      } }));
      ctx.on('click', '[data-rotatekey]', () => ctx.confirm({ title: 'Rotate ' + esc(key.name), tag: 'new version', tone: 'info', body: '<p class="fg2" style="margin:0">Version ' + (key.latestVersion + 1) + ' becomes the latest; it ' + (key.type === 'aes256-gcm96' ? 'encrypts' : 'signs') + ' from now on. Older versions still ' + (key.type === 'aes256-gcm96' ? 'decrypt' : 'verify') + ' down to the minimum decrypt version (v' + key.minDecryptVersion + ').' + (key.type === 'aes256-gcm96' ? ' Rewrap moves ciphertext to the new version without returning the plaintext.' : '') + '</p>', ok: 'Rotate' }).then((yes) => { if (!yes) return; act(() => App.post(keyUrl('/rotate')), (out) => esc(key.name) + ' rotated to v' + out.latestVersion + '. Audited vault.transit.key.rotated.'); }));
      ctx.on('click', '[data-configkey]', () => ctx.modal({ title: 'Configure ' + esc(key.name), body: '<div class="formgrid">' + UI.field('Minimum decrypt version', UI.select(key.versions.map((v) => v.version).filter((v) => v >= key.minAvailableVersion).map((v) => ({ value: String(v), label: 'v' + v })), String(key.minDecryptVersion), 'data-cmin'), 'Ciphertext and signatures from older versions are refused (400, Version below minimum)') + UI.field('Rotate every (days)', UI.input(key.rotationPeriodDays ? String(key.rotationPeriodDays) : '', { type: 'number', placeholder: 'empty: no schedule', attrs: 'data-cdays min="0.01" step="any"' })) + UI.field('Owner', ownerControl(st, key.owner, 'data-cowner')) + '</div><div class="vstack gap6">' + UI.toggle('Rotate automatically when due (vault.rotation job)', key.autoRotate, 'data-cauto') + UI.toggle('Allow deletion', key.deletionAllowed, 'data-cdel') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-csave' }), onMount(m) {
        m.querySelector('[data-csave]').addEventListener('click', async () => {
          const raw = m.querySelector('[data-cdays]').value.trim(); const on = (sel) => m.querySelector(sel).classList.contains('on');
          const body = { minDecryptVersion: +m.querySelector('[data-cmin]').value, rotationPeriodDays: raw === '' ? null : +raw, owner: m.querySelector('[data-cowner]').value.trim() || null, autoRotate: on('[data-cauto]'), deletionAllowed: on('[data-cdel]') };
          try { await App.patch(keyUrl(), body); } catch (err) { App.fail(err); return; }
          App.closeOverlay(); ok('Key configured. Audited vault.transit.key.configured.'); reload();
        });
      } }));
      ctx.on('click', '[data-trimkey]', () => ctx.confirm({ title: 'Trim ' + esc(key.name), tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">Deletes the material of versions below v' + key.minDecryptVersion + ' (the minimum decrypt version). Anything still encrypted with them becomes unreadable; rewrap first.</p>', kv: [['Versions removed', key.versions.filter((v) => v.version < key.minDecryptVersion).map((v) => 'v' + v.version).join(', ')]], ok: 'Trim' }).then((yes) => { if (!yes) return; act(() => App.post(keyUrl('/trim'), { minAvailableVersion: key.minDecryptVersion }), (out) => 'Trimmed to v' + out.minAvailableVersion + '. Audited vault.transit.key.trimmed.', 'danger'); }));
      ctx.on('click', '[data-delkey]', () => ctx.confirm({ title: 'Delete ' + esc(key.name), tag: 'irreversible', tone: 'danger', body: '<p class="fg2" style="margin:0">Everything encrypted with the key becomes unreadable and signatures can no longer be verified.' + (key.deletionAllowed ? '' : ' Deletion is not allowed on this key yet, so the server refuses (409): configure the key first.') + '</p>', ok: 'Delete key' }).then((yes) => { if (!yes) return; st.selKey = null; act(() => App.del(keyUrl()), 'Key deleted. Audited vault.transit.key.deleted.', 'danger'); }));
      ctx.on('click', '[data-trykey]', () => tryDrawer(ctx, key));

      // policies
      const readExplain = () => ({ user: ctx.$('[data-exuser]').value, key: ctx.$('[data-exkey]').value.trim(), path: ctx.$('[data-expath]').value.trim() || 'kv', capability: ctx.$('[data-excap]').value });
      const explain = (inp) => App.post('/api/vault/policies/explain', Object.assign({ path: inp.path, capability: inp.capability }, inp.user && inp.user !== myId() ? { userId: inp.user } : {}, inp.key ? { apiKeyId: inp.key } : {}));
      ctx.on('click', '[data-explain]', async () => {
        st.explainIn = readExplain(); st.denyDemo = null;
        try { st.explainOut = await explain(st.explainIn); } catch (err) { App.fail(err, 'Could not explain'); return; }
        ctx.rerender();
      });
      ctx.on('click', '[data-cleardeny]', () => { st.denyDemo = null; ctx.rerender(); });
      ctx.on('click', '[data-who]', async () => {
        st.whoPath = ctx.$('[data-whopath]').value.trim() || 'kv'; st.whoCap = ctx.$('[data-whocap]').value;
        const ids = userOptions(st).map((u) => u.value).slice(0, 100);
        try { st.whoOut = await Promise.all(ids.map((id) => explain({ user: id, path: st.whoPath, capability: st.whoCap }).then((r) => ({ user: id, allow: r.decision.allow, grant: r.decision.grant })))); } catch (err) { App.fail(err, 'Could not check'); return; }
        ctx.rerender();
      });
      ctx.on('click', '[data-newgrant]', () => grantModal(ctx, null, reload));
      ctx.on('click', '[data-editgrant]', (e, t) => grantModal(ctx, st.grants.find((g) => g.id === t.dataset.editgrant), reload));
      ctx.on('click', '[data-delgrant]', (e, t) => { const g = st.grants.find((x) => x.id === t.dataset.delgrant); ctx.confirm({ title: 'Delete grant ' + esc(g.id.slice(-8)), tone: 'danger', body: '<p class="fg2" style="margin:0">' + esc(g.subjectKind.replace('_', ' ')) + ' ' + subjectText(st, g.subjectKind, g.subject) + ' loses this ' + esc(g.effect) + ' on <span class="mono">' + esc(g.path) + '</span> at once. Nothing else changes; a request that relied on it is a default deny from now.</p>', ok: 'Delete' }).then((yes) => { if (!yes) return; st.explainOut = null; st.whoOut = null; act(() => App.del('/api/vault/policies/' + enc(g.id)), 'Grant deleted. Audited vault.policy.deleted.'); }); });

      // leases
      const eng = (st.engines || []).find((x) => x.name === st.selEngine);
      const engUrl = (suffix) => '/api/vault/database/engines/' + enc(eng.name) + (suffix || '');
      ctx.on('click', '[data-takelease]', () => leaseModal(ctx, reload));
      if (st.openLease) { st.openLease = false; setTimeout(() => leaseModal(ctx, reload), 0); }
      ctx.on('click', '[data-pwdone]', () => { st.password = null; ctx.rerender(); });
      ctx.on('click', '[data-pwcopy]', () => { try { if (navigator.clipboard && st.password) navigator.clipboard.writeText(st.password.password).catch(() => undefined); } catch (err) { /* clipboard unavailable */ } ctx.toast('Copied the password.'); });
      ctx.on('click', '[data-renew]', (e, t) => act(() => App.post('/api/vault/database/leases/' + enc(t.dataset.renew) + '/renew', {}), (out) => 'Lease renewed' + (out.capped ? ' and capped at its maximum expiry ' + esc(when(out.maxExpiresAt)) + ' (capped: true)' : ' until ' + esc(when(out.expiresAt))) + '. Your policy still allows read.'));
      ctx.on('click', '[data-revoke]', (e, t) => { const l = st.leases.find((x) => x.id === t.dataset.revoke); ctx.confirm({ title: 'Revoke lease ' + esc(l.username), tone: 'danger', body: '<p class="fg2" style="margin:0">Drops the account <span class="mono">' + esc(l.username) + '</span> at once; open sessions end where the admin may end them. If the database refuses, the lease waits in revoking for the sweeper (502).</p>', kv: [['Holder', who(st, l.issuedTo)], ['Engine', esc(l.engine) + '/' + esc(l.role)]], ok: 'Revoke' }).then((yes) => { if (!yes) return; st.selLease = l.id; act(() => App.post('/api/vault/database/leases/' + enc(l.id) + '/revoke', {}), 'Lease revoked; account ' + esc(l.username) + ' dropped. Audited vault.database.lease.revoked.'); }); });
      ctx.on('click', '[data-retrydrop]', (e, t) => act(() => App.post('/api/vault/database/leases/' + enc(t.dataset.retrydrop) + '/revoke', {}), (out) => 'DROP USER succeeded on attempt ' + (out.attempts || 1) + '. ' + esc(out.username) + ' is ' + esc(out.state) + '.'));
      ctx.on('click', '[data-sweep]', () => act(() => App.post('/api/vault/database/sweep', {}), 'vault.leases.sweep queued (202). Leases past their expiry are dropped; refused drops are retried.'));
      ctx.on('click', '[data-newengine]', () => engineModal(ctx, reload));
      ctx.on('click', '[data-testengine]', async () => {
        ctx.toast('Testing ' + esc(eng.name) + '…');
        try { const r = await App.post(engUrl('/test'), {}); st.tests[eng.name] = r; ctx.rerender(); ctx.toast(r.ok ? esc(r.version || '') + ', can create accounts, ' + r.ms + ' ms. Audited vault.database.engine.tested.' : 'Check failed: ' + esc(r.detail), r.ok ? 'ok' : 'danger', 6000); } catch (err) { App.fail(err); }
      });
      ctx.on('click', '[data-toggleengine]', () => { const next = eng.state === 'active' ? 'disabled' : 'active'; act(() => App.patch(engUrl(), { state: next }), 'Engine ' + esc(eng.name) + ' ' + next + '.' + (next === 'disabled' ? ' It issues no leases; live ones keep running.' : ''), next === 'active' ? 'ok' : 'warn'); });
      ctx.on('click', '[data-delengine]', () => ctx.confirm({ title: 'Delete engine ' + esc(eng.name), tone: 'danger', body: '<p class="fg2" style="margin:0">Every live lease\'s account is dropped first (' + eng.activeLeases + '). 409 while any could not be dropped; they are retried.</p>', ok: 'Delete engine' }).then((yes) => { if (!yes) return; st.selEngine = null; act(() => App.del(engUrl()), 'Engine removed. Audited vault.database.engine.removed.', 'danger'); }));
      ctx.on('click', '[data-newrole]', () => ctx.modal({ title: 'Add role to ' + esc(eng.name), body: '<div class="formgrid">' + UI.field('Role', UI.input('', { placeholder: '[a-z][a-z0-9_]{0,31}', attrs: 'data-rname' })) + UI.field('Privileges', UI.select([{ value: 'read', label: 'read: SELECT on all tables' }, { value: 'readwrite', label: 'readwrite: SELECT, INSERT, UPDATE, DELETE' }], 'read', 'data-rpriv')) + UI.field(eng.dialect === 'postgres' ? 'Schemas' : 'Databases', UI.input(eng.dialect === 'postgres' ? 'public' : eng.database || '', { attrs: 'data-rschemas' }), 'Comma separated') + UI.field('TTL default / max (seconds)', '<div class="hstack gap6">' + UI.input(String(eng.defaultTtlSeconds), { type: 'number', attrs: 'data-rttl aria-label="Default TTL in seconds"' }) + UI.input(String(eng.maxTtlSeconds), { type: 'number', attrs: 'data-rmax aria-label="Maximum TTL in seconds"' }) + '</div>', 'A role\'s maximum cannot pass the engine\'s') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save role', { kind: 'primary', attrs: 'data-rsave' }), onMount(m) {
        m.querySelector('[data-rsave]').addEventListener('click', async () => {
          const name = m.querySelector('[data-rname]').value.trim();
          if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) { ctx.toast('Role names match [a-z][a-z0-9_]{0,31}.', 'warn'); return; }
          const schemas = m.querySelector('[data-rschemas]').value.split(',').map((s) => s.trim()).filter(Boolean);
          const body = Object.assign({ privileges: m.querySelector('[data-rpriv]').value, defaultTtlSeconds: +m.querySelector('[data-rttl]').value || null, maxTtlSeconds: +m.querySelector('[data-rmax]').value || null }, schemas.length ? { schemas } : {});
          try { await App.api('PUT', engUrl('/roles/' + enc(name)), body); } catch (err) { App.fail(err); return; }
          App.closeOverlay(); ok('Role ' + esc(name) + ' saved. Policy path database/' + esc(eng.name) + '/' + esc(name) + '. Audited vault.database.role.saved.'); reload();
        });
      } }));
      ctx.on('click', '[data-delrole]', (e, t) => ctx.confirm({ title: 'Remove role ' + esc(t.dataset.delrole), tone: 'danger', body: '<p class="fg2" style="margin:0">Nobody can take a lease on <span class="mono">database/' + esc(eng.name) + '/' + esc(t.dataset.delrole) + '</span> afterwards. Refused (409) while the role has live leases.</p>', ok: 'Remove' }).then((yes) => { if (!yes) return; act(() => App.del(engUrl('/roles/' + enc(t.dataset.delrole))), 'Role removed. Audited vault.database.role.removed.'); }));
    }
  });

  /** A user picker when the caller may list users, else the user id as text. */
  function ownerControl(st, value, attr) {
    if (st.users) return UI.select([{ value: '', label: 'the creator (default)' }].concat(userOptions(st)), value || '', attr);
    return UI.input(value || '', { attrs: attr, placeholder: 'user id; empty: the creator' });
  }

  function writeModal(ctx, sec, retryCas, reload) {
    const st = ctx.state; const isNew = !sec;
    const rev = sec && st.revealed[sec.path] && st.revealed[sec.path].version === sec.currentVersion ? st.revealed[sec.path] : null;
    const keys = rev ? Object.keys(rev.data) : [''];
    const row = (k) => '<div class="hstack gap6">' + UI.input(k, { placeholder: 'key', attrs: 'data-wk aria-label="Key"' }) + UI.input('', { type: 'password', placeholder: rev && k ? 'new value (empty keeps the current one)' : 'value', attrs: 'data-wv aria-label="Value"' }) + '</div>';
    const casDefault = isNew ? '0' : retryCas != null ? String(retryCas) : sec.casRequired ? String(sec.currentVersion) : '';
    ctx.modal({ title: isNew ? 'New secret' : 'Write version ' + (sec.currentVersion + 1) + ' of ' + esc(kvp(sec.path)), cls: 'wide',
      body: (isNew ? UI.field('Path', UI.input('kv/', { attrs: 'data-wpath' }), '1 to 16 segments of lower-case letters, digits, . - _') : '') + '<div class="eyebrow">Values</div>' + (isNew || rev ? '' : small('A version holds exactly the keys given here. Reveal the current version first to keep its keys and values.')) + '<div class="vstack gap6" data-wrows>' + keys.map(row).join('') + '</div><div>' + UI.btn('Add key', { kind: 'ghost', size: 'xs', icon: 'plus', attrs: 'data-waddrow' }) + '</div><div class="formgrid" style="--cols:3">' + UI.field('Check-and-set (cas)', UI.input(casDefault, { type: 'number', attrs: 'data-wcas min="0"', placeholder: 'optional' }), isNew ? '0: only when the path is new' : sec.casRequired ? 'Required on this path' : 'Optional') + UI.field('Label', UI.select(myLabels(), sec ? sec.label : 'internal', 'data-wlabel' + (isNew ? '' : ' disabled')), isNew ? 'Applies when the path is created' : 'Set when the path was created') + '</div>' + UI.notice('1 to 200 string values, 64 KiB in all, sealed with the tenant data key. Audited as vault.secret.written without values.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(isNew ? 'Create' : 'Write', { kind: 'primary', attrs: 'data-wsave' }),
      onMount(m) {
        m.querySelector('[data-waddrow]').addEventListener('click', () => { m.querySelector('[data-wrows]').insertAdjacentHTML('beforeend', row('')); });
        m.querySelector('[data-wsave]').addEventListener('click', async () => {
          const data = {};
          Array.prototype.slice.call(m.querySelectorAll('[data-wrows] .hstack')).forEach((r) => { const k = r.querySelector('[data-wk]').value.trim(); const v = r.querySelector('[data-wv]').value; if (!k) return; data[k] = v === '' && rev && rev.data[k] !== undefined ? rev.data[k] : v; });
          if (!Object.keys(data).length) { ctx.toast('A version needs at least one key.', 'warn'); return; }
          const casRaw = m.querySelector('[data-wcas]').value.trim();
          const path = isNew ? m.querySelector('[data-wpath]').value.trim().replace(/^kv\//, '') : sec.path;
          if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+){0,15}$/.test(path)) { ctx.toast('Paths are kv/ plus 1 to 16 segments of lower-case letters, digits, dots, hyphens and underscores.', 'warn'); return; }
          if (!isNew && sec.casRequired && casRaw === '') { ctx.toast('This path requires cas: name the version you saw (' + sec.currentVersion + ').', 'warn'); return; }
          const body = Object.assign({ data }, casRaw !== '' ? { cas: +casRaw } : {}, isNew ? { label: m.querySelector('[data-wlabel]').value } : {});
          let out;
          try { out = await App.api('PUT', '/api/vault/kv/data/' + apiPath(path), body); }
          catch (err) {
            if (err.status === 409 && err.problem && err.problem.currentVersion != null && !isNew) { App.closeOverlay(); st.cas = { given: +casRaw, current: err.problem.currentVersion, trace: err.problem.trace_id }; ctx.rerender(); return; }
            App.fail(err); return;
          }
          delete st.revealed[path]; st.cas = null; st.sel = path; st.query = '';
          App.closeOverlay(); ctx.toast(esc(kvp(path)) + (out.version === 1 ? ' created, version 1.' : ' version ' + out.version + ' written.') + ' Audited vault.secret.written.', 'ok', 5000); reload();
        });
      } });
  }

  function tryDrawer(ctx, key) {
    const ops = key.supports && key.supports.length ? key.supports : key.type === 'aes256-gcm96' ? ['encrypt', 'decrypt', 'rewrap'] : ['sign', 'verify'];
    let op = ops[0]; const last = { ciphertext: '', signature: '', input: 'aGVsbG8gdmF1bHQ=' };
    const body = () => '<div class="vstack gap12" data-trybody>' + UI.seg(ops, op, 'data-tryops') + UI.field(op === 'decrypt' || op === 'rewrap' ? 'Ciphertext' : op === 'encrypt' ? 'Plaintext (base64)' : 'Input (base64)', UI.textarea(op === 'decrypt' || op === 'rewrap' ? last.ciphertext : last.input, { rows: 3, attrs: 'data-tryin', placeholder: op === 'decrypt' || op === 'rewrap' ? 'exai:v1:…' : 'base64' })) + (op === 'verify' ? UI.field('Signature', UI.input(last.signature, { attrs: 'data-trysig', placeholder: 'exai:v1:…' })) : '') + (key.type === 'aes256-gcm96' ? UI.field('Context (base64, optional)', UI.input('', { attrs: 'data-tryctx', placeholder: 'must be given again to decrypt' })) : '') + '<div>' + UI.btn('Run ' + op, { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-tryrun' }) + '</div><div data-tryout></div>' + small('Each call is checked against your policy for transit/' + esc(key.name) + '. Decrypt, rewrap and sign are audited as counts; encrypt and verify are not.') + '</div>';
    ctx.drawer({ title: 'Try ' + esc(key.name), body: body(), onMount(el) { wire(el); } });
    function wire(el) {
      el.querySelectorAll('[data-tryops] [data-seg]').forEach((b) => b.addEventListener('click', () => { op = b.dataset.seg; el.querySelector('[data-trybody]').outerHTML = body(); wire(el); }));
      el.querySelector('[data-tryrun]').addEventListener('click', async () => {
        const input = el.querySelector('[data-tryin]').value.trim(); const out = el.querySelector('[data-tryout]');
        const c = el.querySelector('[data-tryctx]'); const context = c && c.value.trim() ? { context: c.value.trim() } : {};
        const req = op === 'encrypt' ? Object.assign({ plaintext: input }, context) : op === 'decrypt' || op === 'rewrap' ? Object.assign({ ciphertext: input }, context) : op === 'sign' ? { input } : { input, signature: el.querySelector('[data-trysig]').value.trim() };
        let res;
        try { res = await App.post('/api/vault/transit/' + op + '/' + enc(key.name), req); }
        catch (err) { out.innerHTML = UI.problem((err.problem && err.problem.title) || 'Refused', err.message, trace(err)); return; }
        if (op === 'encrypt' || op === 'rewrap') last.ciphertext = res.ciphertext;
        if (op === 'sign') { last.signature = res.signature; last.input = input; }
        if (op === 'encrypt') last.input = input;
        out.innerHTML = UI.code(JSON.stringify(res, null, 2), 'json');
      });
    }
  }

  function grantModal(ctx, g, reload) {
    const st = ctx.state; const isNew = !g;
    const v = g || { subjectKind: 'user', subject: myId(), path: 'kv', capabilities: ['list', 'read'], effect: 'allow', description: '' };
    const subjectControl = (kind, value, disabled) => {
      const dis = disabled ? ' disabled' : '';
      if (kind === 'user' && st.users) return UI.select(userOptions(st), value, 'data-gsubject' + dis);
      if (kind === 'workspace' && workspaces(st).length) return UI.select(workspaces(st).map((w) => ({ value: w.id, label: w.name })), value, 'data-gsubject' + dis);
      return UI.input(value || '', { attrs: 'data-gsubject' + dis, placeholder: kind === 'group' ? 'directory group name' : kind === 'api_key' ? 'API key id' : kind + ' id' });
    };
    ctx.modal({ title: isNew ? 'Add grant' : 'Edit grant ' + esc(g.id.slice(-8)), cls: 'wide',
      body: '<div class="formgrid">' + UI.field('Subject kind', UI.select(KINDS, v.subjectKind, 'data-gkind' + (isNew ? '' : ' disabled')), isNew ? '' : 'The subject cannot change') + '<div data-gsubjectwrap>' + UI.field('Subject', subjectControl(v.subjectKind, v.subject, !isNew), 'Must exist in the tenant (400 otherwise)') + '</div>' + UI.field('Path prefix', UI.input(v.path, { attrs: 'data-gpath', placeholder: '*, kv, transit, database, or a path under them' }), 'Whole segments: kv/apps covers kv/apps/db, not kv/apps2') + UI.field('Effect', UI.select(['allow', 'deny'], v.effect, 'data-geffect'), 'Any matching deny refuses') + '<div class="span2">' + UI.field('Description', UI.input(v.description || '', { attrs: 'data-gdesc' })) + '</div></div><div class="eyebrow" id="vault-caps">Capabilities</div><div class="hstack wrap gap6" role="group" aria-labelledby="vault-caps">' + CAPS.map((c) => UI.chip(esc(c), v.capabilities.includes(c), 'data-gcap="' + c + '"')).join('') + '</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(isNew ? 'Add' : 'Save', { kind: 'primary', attrs: 'data-gsave' }),
      onMount(m) {
        const kindSel = m.querySelector('[data-gkind]');
        if (isNew) kindSel.addEventListener('change', () => { m.querySelector('[data-gsubjectwrap]').innerHTML = UI.field('Subject', subjectControl(kindSel.value, kindSel.value === 'user' ? myId() : '', false), 'Must exist in the tenant (400 otherwise)'); });
        m.querySelectorAll('[data-gcap]').forEach((c) => c.addEventListener('click', () => { c.classList.toggle('on'); c.setAttribute('aria-pressed', c.classList.contains('on') ? 'true' : 'false'); }));
        m.querySelector('[data-gsave]').addEventListener('click', async () => {
          const caps = Array.prototype.slice.call(m.querySelectorAll('[data-gcap].on')).map((c) => c.dataset.gcap);
          if (!caps.length) { ctx.toast('Pick at least one capability.', 'warn'); return; }
          const next = { path: m.querySelector('[data-gpath]').value.trim() || '*', capabilities: caps.includes('*') ? ['*'] : caps, effect: m.querySelector('[data-geffect]').value, description: m.querySelector('[data-gdesc]').value.trim() || null };
          try {
            if (isNew) {
              const subject = m.querySelector('[data-gsubject]').value.trim();
              if (!subject) { ctx.toast('Name the subject.', 'warn'); return; }
              await App.post('/api/vault/policies', Object.assign({ subjectKind: kindSel.value, subject }, next));
            } else await App.patch('/api/vault/policies/' + enc(g.id), next);
          } catch (err) { App.fail(err); return; }
          st.explainOut = null; st.whoOut = null; App.closeOverlay();
          ctx.toast(isNew ? 'Grant added. Audited vault.policy.created.' : 'Grant saved. Audited vault.policy.updated.', 'ok', 5000); reload();
        });
      } });
  }

  function leaseModal(ctx, reload) {
    const st = ctx.state;
    const roles = (st.roles || []).filter((r) => r.canIssue).map((r) => ({ value: r.engine + '/' + r.name, label: r.engine + '/' + r.name + ' (' + r.privileges + ', ' + ttl(r.defaultTtlSeconds) + ' default, ' + ttl(r.maxTtlSeconds) + ' max)' }));
    ctx.modal({ title: 'Take a database lease', body: '<p class="fg2" style="margin:0">Creates a short-lived account on the engine. Your policy must allow read on <span class="mono">database/&lt;engine&gt;/&lt;role&gt;</span>; the roles below are those it lets you take.</p>'
      + (roles.length ? '<div class="formgrid">' + UI.field('Engine and role', UI.select(roles, roles[0].value, 'data-lrole')) + UI.field('TTL (seconds)', UI.input('', { type: 'number', attrs: 'data-lttl min="1"', placeholder: 'the role\'s default' }), 'Cut to the role\'s maximum; never past maxExpiresAt') + '</div>' + UI.notice('The password is in the answer only; it is not stored and cannot be shown again. The lease can be renewed within the role\'s maximum TTL.', 'warn')
        : UI.empty('No role you may take', 'Add a grant with read on database/<engine>/<role> under Policies, on an active engine with a role.')),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Take lease', { kind: 'primary', attrs: 'data-ltake', disabled: !roles.length }),
      onMount(m) {
        const b = m.querySelector('[data-ltake]'); if (!b || !roles.length) return;
        b.addEventListener('click', async () => {
          const parts = m.querySelector('[data-lrole]').value.split('/'); const t = +m.querySelector('[data-lttl]').value;
          let out; try { out = await App.post('/api/vault/database/creds/' + enc(parts[0]) + '/' + enc(parts[1]), t ? { ttlSeconds: t } : {}); } catch (err) { App.fail(err); return; }
          st.password = out; st.leaseFilter = 'all'; st.leaseEngine = 'all'; st.selLease = out.id;
          App.closeOverlay(); ctx.toast('Lease issued for ' + ttl(out.leaseDurationSeconds) + '. Audited vault.database.lease.issued.', 'ok', 5000); reload();
        });
      } });
  }

  function engineModal(ctx, reload) {
    const st = ctx.state;
    const zone = st.zones && st.zones.length ? UI.select(st.zones, st.zones.includes('data') ? 'data' : st.zones[0], 'data-ezone') : UI.input('data', { attrs: 'data-ezone' });
    ctx.modal({ title: 'Register database engine', cls: 'wide', body: '<div class="formgrid" style="--cols:3">' + UI.field('Name', UI.input('', { attrs: 'data-ename', placeholder: 'reporting-pg' })) + UI.field('Dialect', UI.select(['postgres', 'mysql'], 'postgres', 'data-edialect')) + UI.field('Zone', zone, 'Its ceiling must cover the label') + UI.field('Endpoint', UI.input('', { attrs: 'data-eendpoint', placeholder: 'host:port' })) + UI.field('Database', UI.input('', { attrs: 'data-edb' }), 'Required for MySQL') + UI.field('Label', UI.select(myLabels(), 'internal', 'data-elabel')) + UI.field('Admin username', UI.input('exprsn_admin', { attrs: 'data-euser' })) + UI.field('Admin password or vault reference', UI.input('', { type: 'password', attrs: 'data-epw', placeholder: 'vault:apps/erp/db#password or a password' }), 'A password is sealed and never shown again; a reference is read as you at every login') + UI.field('TTL default / max (s)', '<div class="hstack gap6">' + UI.input('3600', { type: 'number', attrs: 'data-ettl aria-label="Default TTL in seconds"' }) + UI.input('86400', { type: 'number', attrs: 'data-emax aria-label="Maximum TTL in seconds"' }) + '</div>') + '</div><div class="vstack gap6">' + UI.toggle('Use TLS', true, 'data-etls') + UI.toggle('Check now: log in and verify the admin can create accounts (422 if not)', true, 'data-echeck') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Register', { kind: 'primary', attrs: 'data-esave' }), onMount(m) {
      m.querySelector('[data-esave]').addEventListener('click', async () => {
        const val = (s) => m.querySelector(s).value.trim(); const on = (s) => m.querySelector(s).classList.contains('on');
        const name = val('[data-ename]'); const ep = val('[data-eendpoint]'); const dialect = m.querySelector('[data-edialect]').value; const db = val('[data-edb]'); const pw = m.querySelector('[data-epw]').value;
        if (!name || !ep) { ctx.toast('Name and endpoint are needed.', 'warn'); return; }
        if (dialect === 'mysql' && !db) { ctx.toast('MySQL engines need a database.', 'warn'); return; }
        if (!pw) { ctx.toast('Give the admin password or a vault reference to it.', 'warn'); return; }
        const fromVault = /^vault:/.test(pw);
        const body = Object.assign({ name, dialect, endpoint: ep, database: db || null, tls: on('[data-etls]'), zone: val('[data-ezone]') || 'data', label: m.querySelector('[data-elabel]').value, adminUsername: val('[data-euser]') || 'exprsn_admin', defaultTtlSeconds: +val('[data-ettl]') || 3600, maxTtlSeconds: +val('[data-emax]') || 86400, check: on('[data-echeck]') }, fromVault ? { adminPasswordRef: pw } : { adminPassword: pw });
        let out; try { out = await App.post('/api/vault/database/engines', body); } catch (err) { App.fail(err, 'Engine refused'); return; }
        if (out.check) st.tests[name] = { ok: out.check.canCreate, version: out.check.version, canCreate: out.check.canCreate, detail: out.check.detail };
        st.selEngine = name; App.closeOverlay(); ctx.toast('Engine ' + esc(name) + ' registered. Audited vault.database.engine.registered. Add a role next.', 'ok', 5000); reload();
      });
    } });
  }
})();
