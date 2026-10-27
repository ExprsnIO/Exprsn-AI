(function () {
  const { UI, esc } = App;

  /*
   * Cloud › Cloud data (1.9.99-final, Sprint 62: B-10706), from the `cloud-data` board of the
   * design prototype (removed 2026-10-21). The managed databases, caches and object stores of every deployment
   * (their graphs and `GET .../databases`), each database's extensions, snapshots and snapshot schedule, a snapshot now
   * and a restore to a new instance; the move of this install's own database onto a managed PostgreSQL (dual control,
   * `cloud/db-move.ts`); and the services of an account that Exprsn-AI did not build, discovered and connected as data
   * connections (`cloud/discovery.ts`). Provisioning a database is a plan on its deployment, reviewed and applied on
   * Deployments.
   */
  const enc = encodeURIComponent;
  const B = '/api/admin/cloud/deployments';
  const FAMILIES = [{ id: 'pg', label: 'PostgreSQL' }, { id: 'mysql', label: 'MySQL' }, { id: 'doc', label: 'Document and key-value' }, { id: 'cache', label: 'Caches' }, { id: 'object', label: 'Object stores' }];
  const PROV = { aws: 'AWS', azure: 'Azure', digitalocean: 'DigitalOcean', cloudflare: 'Cloudflare' };
  const SIZES = { aws: ['db.t4g.medium', 'db.m6g.large', 'db.m6g.xlarge'], azure: ['Standard_B2s', 'Standard_D2ds_v5', 'Standard_D4ds_v5'], digitalocean: ['db-s-1vcpu-2gb', 'db-s-2vcpu-4gb', 'db-s-4vcpu-8gb'] };
  const CF_REASON = 'Cloudflare does not host databases; D1 is offered only as a read-only connection.';
  const EXTENSIONS = ['vector', 'postgis', 'pg_trgm'];
  const EXT_NAME = { vector: 'pgvector', postgis: 'PostGIS', pg_trgm: 'pg_trgm' };
  const DOC_ENGINES = /mongo|cosmos|dynamo|document|d1/i;
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const detailOf = (e) => (e && e.problem && e.problem.detail) || (e && e.message) || 'Request failed';
  const overlayOpen = () => !!document.getElementById('overlay');
  const stateKind = (s) => (/available|online|active|connected|ready/.test(s) ? 'ok' : /blocked|error|failed|missing/.test(s) ? 'danger' : /needs|discovered|provisioning|planned|creating/.test(s) ? 'warn' : '');

  // ---------- step-up ----------
  const CANCELLED = {};
  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">Snapshots, restores and the database move need a fresh check of who you are.</div>'
        + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
        + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
        + '<div data-suerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }),
      onMount(m) {
        m.querySelector('[data-sugo]').addEventListener('click', async () => {
          const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
          const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
          if (!pwv && !code) { m.querySelector('[data-suerr]').innerHTML = UI.notice('Enter your password or a code.', 'warn'); return; }
          try { await App.post('/api/me/step-up', pwv ? { password: pwv } : { code }); ok = true; App.closeOverlay(); } catch (e) { m.querySelector('[data-suerr]').innerHTML = UI.notice(esc(detailOf(e)), 'danger'); }
        });
      },
      onClose() { resolve(ok); } });
  });
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) return CANCELLED;
      return fn();
    }
  };

  /** The rows: every database, cache and bucket in the deployments' graphs, and the connections made from the accounts. */
  function rowsFrom(st) {
    const out = [];
    const acct = (id) => (st.accounts || []).find((a) => a.id === id) || {};
    (st.deps || []).forEach((x) => {
      const d = x.d; const a = acct(d.accountId);
      const reg = (a.regions || []).find((r) => r.region === d.region);
      (x.resources || []).forEach((r) => {
        if (['database', 'cache', 'bucket'].indexOf(r.type) < 0 || r.state === 'deleted') return;
        const info = r.type === 'database' ? (x.databases || []).find((y) => y.key === r.key) || null : null;
        const spec = r.desired && r.desired.spec ? r.desired.spec : {};
        const engine = r.type === 'database' ? (info ? info.engine : spec.engine) : null;
        const family = r.type === 'cache' ? 'cache' : r.type === 'bucket' ? 'object' : engine === 'mysql' ? 'mysql' : 'pg';
        const own = d.spec && d.spec.data && d.spec.data.mode === 'provision';
        out.push({ id: d.id + ':' + r.key, key: r.key, deployment: d, family, type: r.type, provider: d.provider, account: a, region: r.region || d.region, ceiling: reg ? reg.ceiling : d.label,
          engine: r.type === 'database' ? (engine === 'mysql' ? 'MySQL ' : 'PostgreSQL ') + ((info && info.version) || spec.version || '') : r.type === 'cache' ? ((spec.engine || 'valkey') === 'redis' ? 'Redis' : 'Valkey') + (spec.version ? ' ' + spec.version : '') : 'Bucket',
          size: (info && info.size) || spec.size || (spec.sizeGb ? spec.sizeGb + ' GB planned' : '—'),
          roleKind: r.state === 'planned' ? 'planned' : own ? (r.type === 'database' ? 'own' : r.type === 'cache' ? 'redis' : 'blob') : 'deployment',
          state: r.state === 'ready' ? (info ? info.state : 'available') : r.state, providerId: r.providerId, info, protect: r.protect || r.type === 'database', spec });
      });
    });
    (st.links || []).forEach((l) => {
      if (l.deployment) return; // a deployment's own database connected as a data connection is listed with it
      const a = acct(l.accountId);
      const c = (st.connections || []).find((y) => y.id === l.connectionId) || {};
      const fam = /mysql/.test(c.engine || '') ? 'mysql' : DOC_ENGINES.test(c.engine || l.kind || '') ? 'doc' : 'pg';
      out.push({ id: 'link:' + l.connectionId, key: c.name || l.connectionId, deployment: null, family: fam, type: 'connection', provider: a.provider, account: a, region: l.region || '', ceiling: c.label || 'internal', engine: c.engine || l.kind, size: '—', roleKind: 'conn', state: 'connected', providerId: l.providerId, link: l, connection: c, protect: false, spec: {} });
    });
    return out;
  }

  const roleCell = (r) => r.roleKind === 'own' ? UI.pill('Exprsn-AI database', 'accent') + ' <span class="muted">' + esc(r.deployment.name) + '</span>'
    : r.roleKind === 'redis' ? UI.pill('Exprsn-AI Redis', 'accent') + ' <span class="muted">' + esc(r.deployment.name) + '</span>'
      : r.roleKind === 'blob' ? UI.pill('Object store', 'accent') + ' <span class="muted">' + esc(r.deployment.name) + '</span>'
        : r.roleKind === 'conn' ? '<a href="#" data-conn="' + esc(r.key) + '">' + esc(r.key) + '</a> <span class="muted">data connection</span>'
          : r.roleKind === 'planned' ? UI.pill('planned', 'outline') + ' <span class="muted">' + esc(r.deployment.name) + '</span>' : '<span class="muted">' + esc(r.deployment ? r.deployment.name : '') + '</span>';

  App.register({
    id: 'cloud-data', title: 'Cloud data', section: 'admin', crumb: ['Admin', 'Cloud data'], live: true,
    summary: 'Managed databases, caches and object stores on AWS, Azure, DigitalOcean and Cloudflare',
    commands: [
      { label: 'Provision a managed database', sub: 'Cloud data', run(app) { const s = app.stateFor('cloud-data'); s.openProvision = true; app.render(); } },
      { label: 'Connect an existing cloud database', sub: 'Cloud data', run(app) { const s = app.stateFor('cloud-data'); s.openConnect = true; app.render(); } }
    ],
    states: [
      { title: 'No managed data yet', tone: 'neutral', text: 'No cloud account has a managed database, cache or object store. The page offers Provision and Connect existing.', apply(ctx) { Object.assign(ctx.state, { empty: true, mode: null, denied: false }); ctx.rerender(); } },
      { title: 'Loading inventory', tone: 'info', text: 'The inventory is read from each account through the provider adapters; rows show as skeletons until every account answers.', apply(ctx) { Object.assign(ctx.state, { empty: false, mode: 'loading', denied: false }); ctx.rerender(); } },
      { title: 'Extension missing', tone: 'warn', text: 'pgvector is not available on a database. Knowledge on this connection cannot use vectors until it is.', apply(ctx) { Object.assign(ctx.state, { empty: false, mode: 'extension', denied: false, tab: 'pg' }); ctx.rerender(); } },
      { title: 'Budget hard stop', tone: 'danger', text: 'The account is past its budget. Provisioning a database adds cost and is refused with budget_exceeded until the budget is raised or an override is approved.', apply(ctx) { Object.assign(ctx.state, { empty: false, mode: 'budget', denied: false, tab: 'pg' }); ctx.rerender(); } },
      { title: 'Driver not available', tone: 'warn', text: 'A document database is listed and monitored but cannot be queried from Connections without its driver.', apply(ctx) { Object.assign(ctx.state, { empty: false, mode: 'driver', denied: false, tab: 'doc' }); ctx.rerender(); } },
      { title: 'Provider error', tone: 'danger', text: 'A provider answered 503 for one account. Its rows show the last known state with the time it was read; the others are current.', apply(ctx) { Object.assign(ctx.state, { empty: false, mode: 'error', denied: false }); ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'A member opens Cloud data without cloud:read. The page explains which permission is missing and who grants it.', apply(ctx) { Object.assign(ctx.state, { denied: true }); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (st.tab === undefined) { st.tab = 'pg'; st.query = ''; }
      const refresh = () => { if (App.state.route !== 'cloud-data') return; if (overlayOpen()) { st.dirty = true; return; } ctx.rerender(); };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        const started = Date.now();
        Promise.all([App.get(B), App.get('/api/admin/cloud/accounts'), App.get('/api/admin/connections').catch(() => []), App.get('/api/admin/cloud/db-moves').catch(() => null)])
          .then(([list, acc, conns, moves]) => {
            const deps = (list.deployments || []).filter((d) => d.state !== 'destroyed' && d.kind !== 'onprem'); // on-prem installs keep their data where it is
            const usable = (acc.accounts || []).filter((a) => a.state === 'active' && a.provider !== 'cloudflare');
            return Promise.all([
              Promise.all(deps.map((d) => Promise.all([App.get(B + '/' + enc(d.id) + '/graph').then((g) => g.resources || []).catch(() => []), App.get(B + '/' + enc(d.id) + '/databases').then((x) => x.databases || []).catch(() => [])]).then(([resources, databases]) => ({ d, resources, databases })))),
              Promise.all(usable.map((a) => App.get('/api/admin/cloud/accounts/' + enc(a.id) + '/connections').then((x) => x.links || []).catch(() => []))).then((ls) => [].concat.apply([], ls))
            ]).then(([depData, links]) => {
              Object.assign(st, { deps: depData, links, accounts: acc.accounts || [], connections: Array.isArray(conns) ? conns : (conns && conns.connections) || [], moves: moves ? moves.moves : null, moveWindow: moves ? moves.window : null, loaded: true, loadError: null, readAt: started });
            });
          })
          .catch((err) => { st.loadError = err; st.loaded = true; })
          .finally(() => { st.loading = false; refresh(); });
      };
      st.reload = () => { st.loaded = false; load(); };
      if (!st.loaded && !st.loading) load();
      const fresh = st.seenHash !== location.hash; st.seenHash = location.hash;
      if (ctx.params.connect && fresh) { st.connectAccount = ctx.params.connect; st.openConnect = true; delete ctx.params.connect; }
      if (ctx.params.db && fresh) { st.want = ctx.params.db; delete ctx.params.db; }
      const style = '<style>.cloud-data-ext{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;font-size:12px}.cloud-data-ext span:nth-child(even){text-align:right}.cloud-data-skel td{padding:10px}.cloud-data-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}</style>';

      const denied = st.denied || (st.loadError && st.loadError.status === 403);
      if (denied) {
        const p = (st.loadError && st.loadError.problem) || { detail: 'No role held grants cloud:read', step: 'role' };
        root.innerHTML = style + '<div class="page">' + UI.pagehead('Cloud data', 'Managed databases, caches and object stores') + UI.problem('You need cloud:read to see cloud data', 'Cloud data needs cloud:read, which the Cloud admin, Cloud operator and FinOps analyst roles carry. A tenant admin grants it on Roles and access.', p.trace_id || false)
          + UI.panel('Why', UI.timeline([{ title: 'Role', text: esc(p.detail || 'cloud:read not granted'), tone: 'danger' }, { title: 'Scopes', text: 'not reached' }, { title: 'Tenant, clearance, zone ceiling', text: 'not reached' }]))
          + '<div class="hstack gap6">' + UI.btn('Open Roles and access', { attrs: 'data-go="roles"' }) + (st.denied ? UI.btn('Back to the inventory', { kind: 'ghost', attrs: 'data-undeny' }) : '') + '</div></div>';
        ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
        ctx.on('click', '[data-undeny]', () => { st.denied = false; ctx.rerender(); });
        return;
      }
      const canDeploy = App.can('cloud:deploy');
      const head = UI.pagehead('Cloud data', 'Managed databases, caches and object stores across your cloud accounts', UI.btn('Connect existing', { icon: 'link', attrs: 'data-connect', disabled: !App.can('connections:manage'), title: App.can('connections:manage') ? '' : 'Needs connections:manage' }) + UI.btn('Provision database', { kind: 'primary', icon: 'plus', attrs: 'data-provision', disabled: !canDeploy, title: canDeploy ? '' : 'Needs cloud:deploy' }));
      if (st.loadError) {
        root.innerHTML = style + '<div class="page">' + head + UI.problem('Cloud data could not be loaded', detailOf(st.loadError), (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div></div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; st.reload(); });
        return;
      }
      const all = st.loaded ? rowsFrom(st) : [];
      if (st.want && st.loaded) { const w = all.find((r) => r.key === st.want || r.id === st.want); if (w) { st.sel = w.id; st.tab = w.family; } st.want = null; }
      if (st.loaded && !st.empty && !all.length && st.mode == null) st.empty = true;
      if (st.empty) {
        root.innerHTML = style + '<div class="page">' + head + UI.empty('No managed data yet', 'Provision a PostgreSQL, MySQL or cache service in a deployment, or connect one that already exists in a cloud account. Exprsn-AI can use it as its own database, as its Redis, or as a data connection.', (canDeploy ? UI.btn('Provision database', { kind: 'primary', attrs: 'data-provision' }) + ' ' : '') + UI.btn('Connect existing', { attrs: 'data-connect' }))
          + (all.length ? '<div>' + UI.btn('Show the inventory', { size: 'sm', attrs: 'data-unempty' }) + '</div>' : '') + '</div>';
        wire(ctx, st, null, all);
        ctx.on('click', '[data-unempty]', () => { st.empty = false; ctx.rerender(); });
        return;
      }
      const loading = st.mode === 'loading' || !st.loaded;
      const tabs = UI.tabs(FAMILIES.map((f) => ({ id: f.id, label: f.label, count: all.filter((d) => d.family === f.id).length })), st.tab);
      const q = (st.query || '').toLowerCase();
      const rows = all.filter((d) => d.family === st.tab && (!q || (d.key + ' ' + d.engine + ' ' + (d.provider || '') + ' ' + d.region + ' ' + (d.deployment ? d.deployment.name : '')).toLowerCase().indexOf(q) >= 0));
      if (!rows.some((d) => d.id === st.sel)) st.sel = rows.length ? rows[0].id : null;
      const sel = all.find((d) => d.id === st.sel) || null;
      const errAcct = (st.accounts || []).find((a) => a.provider !== 'cloudflare' && a.state === 'active');
      let notices = '';
      if (st.mode === 'error') notices += UI.notice('<b>' + esc(errAcct ? PROV[errAcct.provider] : 'A provider') + ' answered 503</b>' + (errAcct ? ' for ' + esc(errAcct.name) : '') + '. Its rows show the state read at ' + esc(when(st.readAt)) + '; the other accounts are current. Retrying with backoff.', 'danger', UI.btn('Retry now', { size: 'xs', attrs: 'data-retry' }));
      if (st.mode === 'budget') notices += UI.notice('<b>Budget hard stop.</b> A plan that adds a database adds cost and is refused with <span class="mono">budget_exceeded</span> while the account is past its budget. Scale-down and destroy stay allowed.', 'danger', UI.btn('Open Cloud accounts', { size: 'xs', attrs: 'data-go="cloud"' }));
      if (st.tab === 'cache') notices += UI.notice('Exprsn-AI uses Redis for BullMQ, the Socket.io adapter and the bus. BullMQ needs cluster mode off and <span class="mono">maxmemory-policy noeviction</span>. Workers KV is not a substitute for Redis: a Cloudflare deployment takes its cache from another provider.', 'info');
      if (st.tab === 'object') notices += UI.notice('S3 and DigitalOcean Spaces use <span class="mono">BLOB_STORE=s3</span>; R2 does too, through its S3-compatible endpoint. Azure Blob storage needs <span class="mono">BLOB_STORE=azure</span>.', 'info');
      if (st.tab === 'doc' && st.mode === 'driver') notices += UI.notice('<b>Driver not available.</b> A document database without its driver is listed and monitored here; its connection stays disabled until the platform has the engine (Connections, Engines).', 'warn', UI.btn('Open Connections', { size: 'xs', attrs: 'data-go="connections"' }));
      const table = loading
        ? '<div class="tablewrap"><table class="dt cloud-data-skel"><caption class="sr">Loading the inventory</caption><thead><tr><th scope="col">Name</th><th scope="col">Provider, region</th><th scope="col">Engine</th><th scope="col">Size</th><th scope="col">Role</th><th scope="col">State</th></tr></thead><tbody>' + [1, 2, 3, 4].map(() => '<tr>' + [1, 2, 3, 4, 5, 6].map(() => '<td><div class="skeleton"></div></td>').join('') + '</tr>').join('') + '</tbody></table></div><span class="muted" style="font-size:12px" role="status">Reading the inventory from ' + esc((st.accounts || []).filter((a) => a.state === 'active').map((a) => a.name).join(', ') || 'the accounts') + '…</span>'
        : UI.table(['Name', 'Provider, region', 'Engine', 'Size', 'Role', 'State'], rows.map((d) => ({ cells: ['<span class="mono">' + esc(d.key) + '</span>', esc(PROV[d.provider] || d.provider || '') + ' <span class="muted">' + esc((d.account.name || '') + ', ' + d.region) + '</span>', esc(d.engine), esc(d.size), roleCell(d), UI.pill(st.mode === 'error' && errAcct && d.account.id === errAcct.id ? d.state + ' (' + when(st.readAt) + ')' : d.state, stateKind(d.state))], attrs: 'data-id="' + esc(d.id) + '" tabindex="0"', selected: sel && d.id === sel.id })), { minWidth: '940px', emptyTitle: 'Nothing in this family', emptyText: 'Provision one or connect an existing service.' });
      const insp = sel && !loading ? inspector(st, sel) : '';
      root.innerHTML = style + '<div class="page">' + head + notices + tabs
        + '<div class="toolbar">' + UI.search('Filter by name, engine, region or deployment', 'data-search', st.query) + '<span class="muted right" style="font-size:12px">' + rows.length + ' in ' + esc(FAMILIES.find((f) => f.id === st.tab).label) + ', ' + all.length + ' in all accounts</span></div>'
        + table + movesPanel(st) + '</div>'
        + (insp ? '<aside class="inspector w360" aria-label="Service details">' + insp + '</aside>' : '');
      wire(ctx, st, sel, all);
    }
  });

  function inspector(st, sel) {
    const i = sel.info;
    const ext = st.ext && st.ext[sel.id];
    let extHtml = '';
    if (sel.type === 'database' && sel.deployment) {
      const missing = st.mode === 'extension' ? ['vector'] : ext ? ext.extensions.filter((x) => x.state !== 'available' && x.state !== 'installed').map((x) => x.name) : [];
      const items = EXTENSIONS.map((n) => { const e = ext ? ext.extensions.find((x) => x.name === n) : null; const s = missing.indexOf(n) >= 0 ? 'not available' : e ? e.state : i && i.extensions && i.extensions.indexOf(n) >= 0 ? 'on' : 'not checked'; return '<span>' + esc(EXT_NAME[n]) + '</span><span>' + (/not available|unsupported/.test(s) ? UI.pill(s, 'warn') : '<span class="fg2">' + esc(s) + '</span>') + '</span>'; }).join('');
      extHtml = '<div class="eyebrow">Extensions</div><div class="cloud-data-ext">' + items + '</div>'
        + (missing.length ? UI.notice(esc(missing.map((n) => EXT_NAME[n]).join(', ')) + ' is not available on ' + esc(sel.key) + '. Knowledge bases on this database fall back to keyword search until it is; turn it on at the provider, then check again.', 'warn', UI.btn('Check again', { size: 'xs', attrs: 'data-ext' })) : '<div class="hstack gap6">' + UI.btn('Check extensions', { size: 'xs', attrs: 'data-ext' }) + (ext ? '<span class="muted" style="font-size:11px">Checked ' + esc(when(ext.at)) + '.</span>' : '') + '</div>');
    }
    const snaps = st.snaps && st.snaps[sel.id];
    let snapHtml = '';
    if (sel.type === 'database' && sel.deployment && sel.state !== 'planned') {
      snapHtml = '<div class="eyebrow">Snapshots</div>' + (!snaps ? '<div class="muted" style="font-size:12px" role="status">Reading snapshots…</div>'
        : snaps.error ? UI.notice(esc(snaps.error), 'warn')
          : (snaps.list.length ? UI.table(['Snapshot', 'Taken', { label: 'Cost a month', right: true }, { label: '', srLabel: 'Actions' }], snaps.list.slice(0, 6).map((s) => ['<span style="font-size:12px">' + esc(s.name) + '</span> <span class="muted">' + esc(s.kind) + '</span>', esc(when(s.createdAt)), '<span class="num">' + (s.cost ? esc('$' + s.cost.monthly) : '—') + '</span>', UI.btn('Restore', { size: 'xs', attrs: 'data-restore="' + esc(s.id) + '"', disabled: !App.can('cloud:deploy') || s.state !== 'available' })]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }) : '<div class="muted" style="font-size:12px">No snapshots yet.</div>')
            + '<span class="muted" style="font-size:11px">' + esc((snaps.list[0] && snaps.list[0].retention) || '') + '</span>')
        + '<div class="muted" style="font-size:12px">Schedule: ' + (i && i.schedule ? (i.schedule.enabled ? 'every ' + i.schedule.everyHours + ' h, keep ' + i.schedule.keep : 'off') : 'the provider\'s automated backups only') + '</div>';
    }
    const extra = (st.mode === 'budget' ? UI.notice('<b>Budget hard stop.</b> ' + esc(sel.account.name || 'This account') + ' is past its budget: a plan that adds cost here is refused with <span class="mono">budget_exceeded</span>.', 'danger') : '')
      + (st.mode === 'driver' && sel.family === 'doc' ? UI.notice('<b>Driver not available.</b> This engine is queried with a driver this platform does not have yet; the connection stays disabled.', 'warn') : '');
    let actions = '';
    const deploy = App.can('cloud:deploy');
    if (sel.roleKind === 'conn') actions = UI.btn('Open connection', { size: 'sm', attrs: 'data-conn="' + esc(sel.key) + '"' });
    else if (sel.deployment) {
      if (sel.type === 'database' && sel.state !== 'planned') actions += UI.btn('Take snapshot', { size: 'sm', kind: 'primary', attrs: 'data-snap', disabled: !deploy }) + UI.btn('Snapshot schedule', { size: 'sm', attrs: 'data-sched', disabled: !deploy });
      if (sel.type === 'database' && sel.family === 'pg' && sel.state !== 'planned') actions += UI.btn('Use as Exprsn-AI database', { size: 'sm', attrs: 'data-own', disabled: !(App.can('cloud:admin') && App.can('platform:manage')), title: 'Moves this install\'s own database here, under dual control' });
      if (sel.type === 'database' && sel.state !== 'planned') actions += UI.btn('Connect as data connection', { size: 'sm', attrs: 'data-connect-dep', disabled: !App.can('connections:manage') });
      actions += UI.btn('Open deployment', { size: 'sm', kind: 'ghost', attrs: 'data-dep="' + esc(sel.deployment.id) + '"' });
    }
    const kv = [['Role', roleCell(sel)], ['Region ceiling', UI.label(sel.ceiling, { sm: true })], ['Size', esc(sel.size)]];
    if (i) kv.push(['High availability', i.ha ? 'standby in a second zone' : 'single node'], ['Storage', i.storageGb ? esc(i.storageGb + ' GB') : '—'], ['Backups', i.backups ? esc(i.backups.days + ' days' + (i.backups.window ? ', window ' + i.backups.window : '')) : '—'], ['Maintenance', i.maintenanceWindow ? esc(i.maintenanceWindow.day + ' ' + String(i.maintenanceWindow.hour).padStart(2, '0') + ':00') : '—'], ['Deletion protection', i.deletionProtection ? UI.pill('on', 'ok') : UI.pill('off', 'outline')], ['Endpoint', '<span class="mono" style="overflow-wrap:anywhere;font-size:12px">' + esc(i.endpoint || '—') + '</span>' + (i.publicAccess ? ' ' + UI.pill('public', 'warn') : ' <span class="muted">private</span>')]);
    else if (sel.link) kv.push(['Endpoint', '<span class="mono" style="overflow-wrap:anywhere;font-size:12px">' + esc(sel.link.host) + '</span> <span class="muted">' + esc(sel.link.endpoint) + '</span>'], ['Sign-in', esc(sel.link.auth) + (sel.link.leaseEngine ? ' <span class="muted">(dynamic users from ' + esc(sel.link.leaseEngine) + ')</span>' : '')], ['Connected', esc(when(sel.link.createdAt))]);
    else if (sel.type === 'database' || sel.protect) kv.push(['Deletion protection', sel.protect ? UI.pill('on', 'ok') : UI.pill('off', 'outline')]);
    if (sel.type === 'database') kv.push(['Credentials', 'Admin password sealed in the vault; never shown. Connections use dynamic users from the lease engine.']);
    return '<div class="hstack"><div class="eyebrow grow">Selected service</div>' + UI.pill(sel.state, stateKind(sel.state)) + '</div><div class="cloud-data-name">' + esc(sel.key) + '</div><div class="muted" style="font-size:12px">' + esc(sel.engine) + ', ' + esc((PROV[sel.provider] || '') + ' ' + sel.region) + '</div>'
      + UI.kv(kv, 1) + (i && i.deletionProtection ? '<span class="muted" style="font-size:11px">A plan never turns deletion protection off; destroy takes a final snapshot and a second admin\'s approval first.</span>' : '')
      + extHtml + snapHtml + extra + '<div class="hstack wrap gap6">' + actions + '</div>';
  }

  function movesPanel(st) {
    if (!st.moves || !st.moves.length) return '';
    const me = App.me && App.me.user && App.me.user.id;
    const target = (m) => (m.target && m.target.kind === 'deployment' ? 'deployment ' + (((st.deps || []).find((x) => x.d.id === m.target.deploymentId) || { d: { name: m.target.deploymentId } }).d.name) + (m.target.key ? ' / ' + m.target.key : '') : (m.target && m.target.ref) || '');
    const steps = (m) => Object.keys(m.steps || {}).filter((k) => m.steps[k].state !== 'pending').map((k) => k + ' ' + m.steps[k].state).join(', ') || 'not started';
    return UI.panel('Moves of this install\'s database', (st.moveWindow ? UI.notice('<b>Read-only window.</b> The database is being moved; users see a read-only banner until it ends.', 'warn') : '')
      + UI.table(['Asked', 'Target', 'State', 'Steps', { label: '', srLabel: 'Actions' }], st.moves.slice(0, 6).map((m) => [esc(when(m.createdAt)), '<span class="mono" style="font-size:12px">' + esc(target(m)) + '</span>', UI.pill(m.state.replace('_', ' ')) + (m.checks.some((c) => !c.ok) ? '<div class="muted" style="font-size:11px">' + esc(m.checks.filter((c) => !c.ok).map((c) => c.detail).join(' ')) + '</div>' : ''), '<span style="font-size:12px">' + esc(steps(m)) + '</span>',
        '<div class="hstack gap6">' + (m.state === 'awaiting_approval' ? (m.requestedBy === me ? '' : UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-mv="approve" data-mid="' + esc(m.id) + '"' })) + UI.btn('Reject', { size: 'xs', attrs: 'data-mv="reject" data-mid="' + esc(m.id) + '"' }) : '') + (m.state === 'switched' ? UI.btn('Roll back', { size: 'xs', attrs: 'data-mv="rollback" data-mid="' + esc(m.id) + '"' }) + UI.btn('Finish', { size: 'xs', attrs: 'data-mv="finish" data-mid="' + esc(m.id) + '"' }) : '') + '</div>']), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }));
  }

  function wire(ctx, st, sel, all) {
    ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
    const pick = (t) => { if (t.dataset.id) { st.sel = t.dataset.id; ctx.rerender(); } };
    ctx.on('click', 'tr.row[data-id]', (e, t) => pick(t));
    ctx.on('keydown', 'tr.row[data-id]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(t); } });
    ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
    ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
    ctx.on('click', '[data-conn]', (e, t) => { e.preventDefault(); ctx.navigate('connections', { connection: t.dataset.conn }); });
    ctx.on('click', '[data-dep]', (e, t) => ctx.navigate('deployments', { id: t.dataset.dep, tab: 'resources' }));
    ctx.on('click', '[data-retry]', () => { st.mode = null; st.reload(); ctx.toast('Inventory read again from every account.', 'ok'); });
    ctx.on('click', '[data-provision]', () => provision(ctx, st));
    ctx.on('click', '[data-connect]', () => connect(ctx, st, null));
    ctx.on('click', '[data-mv]', (e, t) => decideMove(ctx, st, t.dataset.mid, t.dataset.mv));
    if (st.openProvision && st.loaded) { st.openProvision = false; setTimeout(() => provision(ctx, st), 30); }
    if (st.openConnect && st.loaded) { st.openConnect = false; setTimeout(() => connect(ctx, st, null), 30); }
    if (!sel || !sel.deployment) return;
    const dbase = B + '/' + enc(sel.deployment.id) + '/databases/' + enc(sel.key);
    if (sel.type === 'database' && sel.state !== 'planned' && st.snaps === undefined) st.snaps = {};
    if (sel.type === 'database' && sel.state !== 'planned' && !st.snaps[sel.id] && !(st.snapLoading && st.snapLoading[sel.id])) {
      st.snapLoading = st.snapLoading || {}; st.snapLoading[sel.id] = true;
      App.get(dbase + '/snapshots').then((r) => { st.snaps[sel.id] = { list: r.snapshots || [] }; }).catch((err) => { st.snaps[sel.id] = { list: [], error: detailOf(err) }; })
        .finally(() => { st.snapLoading[sel.id] = false; if (App.state.route === 'cloud-data' && !overlayOpen()) ctx.rerender(); });
    }
    ctx.on('click', '[data-ext]', async () => {
      try { const r = await App.get(dbase + '/extensions?names=' + EXTENSIONS.join(',')); st.ext = st.ext || {}; st.ext[sel.id] = { extensions: r.extensions, at: Date.now() }; if (st.mode === 'extension') st.mode = null; ctx.rerender(); ctx.toast(r.allAvailable ? 'pgvector, PostGIS and pg_trgm are available on ' + esc(sel.key) + '.' : 'Some extensions are not available on ' + esc(sel.key) + '.', r.allAvailable ? 'ok' : 'warn'); } catch (err) { App.fail(err, 'Not checked'); }
    });
    ctx.on('click', '[data-snap]', async () => {
      const ok = await ctx.confirm({ title: 'Snapshot ' + sel.key, tag: 'snapshot', tone: 'ok', body: '<p class="fg2" style="margin:0">A manual provider snapshot. It is kept until deleted and costs storage at the provider\'s snapshot rate.</p>', ok: 'Take snapshot' });
      if (!ok) return;
      try { const r = await withStepUp(ctx, () => App.post(dbase + '/snapshots', {})); if (r === CANCELLED) return; delete st.snaps[sel.id]; ctx.rerender(); ctx.toast('Snapshot started for ' + esc(sel.key) + ' (job ' + esc(r.job ? r.job.type || r.job.id : 'queued') + '). It appears under Snapshots when complete.', 'ok', 5000); } catch (err) { App.fail(err, 'Not started'); }
    });
    ctx.on('click', '[data-restore]', (e, t) => ctx.modal({ title: 'Restore ' + esc(sel.key) + ' to a new instance', body: '<p class="fg2" style="margin:0">The snapshot is restored as a new database beside this one; nothing is overwritten. Point connections at it once it is ready.</p>'
      + UI.field('New resource key', UI.input(sel.key + '-restore', { attrs: 'data-rkey' })) + UI.field('Size', UI.select(SIZES[sel.provider] || [sel.size], sel.size, 'data-rsize')),
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Restore', { kind: 'primary', attrs: 'data-rgo' }),
    onMount(m) {
      m.querySelector('[data-rgo]').addEventListener('click', async () => {
        const body = { key: m.querySelector('[data-rkey]').value.trim(), size: m.querySelector('[data-rsize]').value };
        App.closeOverlay();
        try { const r = await withStepUp(ctx, () => App.post(dbase + '/snapshots/' + enc(t.dataset.restore) + '/restore', body)); if (r === CANCELLED) return; ctx.toast('Restore to ' + esc(r.key || body.key) + ' started.', 'ok'); st.reload(); } catch (err) { App.fail(err, 'Not restored'); }
      });
    } }));
    ctx.on('click', '[data-sched]', () => {
      const cur = (sel.info && sel.info.schedule) || { everyHours: 24, keep: 7, enabled: true };
      ctx.modal({ title: 'Snapshot schedule for ' + esc(sel.key), body: '<p class="fg2" style="margin:0">Exprsn-AI takes manual snapshots on this schedule beside the provider\'s automated backups and keeps the newest ones.</p>'
        + '<div class="formgrid" style="--cols:2">' + UI.field('Every (hours)', UI.input(String(cur.everyHours), { type: 'number', attrs: 'data-every min="1" max="720"' })) + UI.field('Keep', UI.input(String(cur.keep), { type: 'number', attrs: 'data-keep min="1" max="100"' })) + '</div>' + UI.check('Schedule on', cur.enabled, 'data-on'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save schedule', { kind: 'primary', attrs: 'data-sgo' }),
      onMount(m) {
        m.querySelector('[data-sgo]').addEventListener('click', async () => {
          const body = { everyHours: Math.max(1, Number(m.querySelector('[data-every]').value) || 24), keep: Math.max(1, Number(m.querySelector('[data-keep]').value) || 7), enabled: m.querySelector('[data-on]').checked };
          try { await App.put(dbase + '/schedule', body); App.closeOverlay(); ctx.toast('Schedule saved for ' + esc(sel.key) + '. Audit entry written.', 'ok'); st.reload(); } catch (err) { App.fail(err, 'Not saved'); }
        });
      } });
    });
    ctx.on('click', '[data-own]', () => ownDb(ctx, st, sel));
    ctx.on('click', '[data-connect-dep]', () => connect(ctx, st, sel));
  }

  function ownDb(ctx, st, sel) {
    const target = { kind: 'deployment', deploymentId: sel.deployment.id, key: sel.key };
    ctx.modal({ title: 'Use ' + esc(sel.key) + ' as the Exprsn-AI database', cls: 'wide', body: '<p class="fg2" style="margin:0">Moves this install\'s database onto this managed service. The steps run as the job cloud.db.move and each is recorded; a second admin approves first.</p>'
      + UI.timeline([{ title: 'Back up', text: '<span class="mono">exprsn-ai backup:create</span> on the current database, consistent with the blob store', tone: 'ok' }, { title: 'Restore', text: '<span class="mono">exprsn-ai backup:restore</span> into ' + esc(sel.key) + ' over TLS with the provider CA bundle' }, { title: 'Check', text: '<span class="mono">exprsn-ai migrate --check</span>, the extension check (pgvector), row counts per table' }, { title: 'Cut over', text: 'A read-only window, the final delta, then DATABASE_URL points at the new service' }, { title: 'Verify', text: '/readyz on every instance; the old database stays read-only for the keep window, for rollback' }])
      + '<div class="formgrid" style="--cols:2">' + UI.field('Read-only window (minutes)', UI.input('20', { type: 'number', attrs: 'data-win min="1" max="1440"' }), 'Users see a read-only banner during the window') + UI.field('Keep the old database (days)', UI.input('7', { type: 'number', attrs: 'data-keep min="1" max="90"' })) + '</div>'
      + UI.field('Note', UI.input('', { attrs: 'data-note maxlength="300"', placeholder: 'Recorded with the request' })) + '<div data-dry></div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Dry run', { attrs: 'data-dry-go' }) + UI.btn('Ask for the move', { kind: 'primary', attrs: 'data-ask' }),
    onMount(m) {
      const body = () => { const b = { target, windowMinutes: Math.max(1, Number(m.querySelector('[data-win]').value) || 20), keepOldDays: Math.max(1, Number(m.querySelector('[data-keep]').value) || 7) }; const n = m.querySelector('[data-note]').value.trim(); if (n) b.note = n; return b; };
      const show = (mv) => { const checks = (mv && mv.checks) || []; const bad = checks.filter((c) => !c.ok); m.querySelector('[data-dry]').innerHTML = UI.notice('<b>Dry run: ' + (bad.length ? bad.length + ' check' + (bad.length === 1 ? '' : 's') + ' failed.' : 'every check passed.') + '</b> ' + esc(checks.map((c) => c.id + ': ' + (c.ok ? 'ok' : c.detail)).join('; ')) + (mv && mv.estimate ? ' Window about ' + Math.ceil(mv.estimate.windowMs / 60000) + ' min for ' + mv.estimate.rows + ' rows.' : ''), bad.length ? 'warn' : 'ok'); };
      m.querySelector('[data-dry-go]').addEventListener('click', async () => {
        try { const r = await withStepUp(ctx, () => App.post('/api/admin/cloud/db-moves/dry-run', body())); if (r === CANCELLED) return; show(r.move); } catch (err) { m.querySelector('[data-dry]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); }
      });
      m.querySelector('[data-ask]').addEventListener('click', async () => {
        try { const r = await withStepUp(ctx, () => App.post('/api/admin/cloud/db-moves', body())); if (r === CANCELLED) return; App.closeOverlay(); ctx.toast('Move asked. A second admin approves it; tenant admins are told before the read-only window.', 'ok', 6000); st.reload(); } catch (err) { m.querySelector('[data-dry]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); }
      });
    } });
  }

  async function decideMove(ctx, st, id, what) {
    const text = { approve: 'The move starts as the job cloud.db.move: backup, restore, checks, the read-only window and the cut-over.', reject: 'The move is refused; nothing changes.', rollback: 'DATABASE_URL points back at the old database. Writes made since the cut-over are kept unless you discard them.', finish: 'The keep window ends: the old database is no longer kept for rollback.' }[what];
    const ok = await ctx.confirm({ title: { approve: 'Approve the move', reject: 'Refuse the move', rollback: 'Roll back the move', finish: 'Finish the move' }[what], tag: what === 'approve' ? 'dual control' : what, tone: what === 'approve' || what === 'rollback' ? 'warn' : 'info', body: '<p class="fg2" style="margin:0">' + esc(text) + '</p>', ok: { approve: 'Approve', reject: 'Refuse', rollback: 'Roll back', finish: 'Finish' }[what] });
    if (!ok) return;
    try { const r = await withStepUp(ctx, () => App.post('/api/admin/cloud/db-moves/' + enc(id) + '/' + what, {})); if (r === CANCELLED) return; ctx.toast('Done: ' + what + '. Audit entry written.', 'ok'); st.reload(); } catch (err) { App.fail(err, 'Not done'); }
  }

  function connect(ctx, st, dep) {
    // Only accounts with a credential can be read (an account without one answers 409 no_credential).
    const accounts = (st.accounts || []).filter((a) => a.state === 'active' && a.provider !== 'cloudflare' && a.credential);
    const f = { account: dep ? dep.account.id : st.connectAccount && accounts.some((a) => a.id === st.connectAccount) ? st.connectAccount : (accounts.find((a) => (st.deps || []).some((x) => x.d.accountId === a.id)) || accounts[0] || {}).id, list: null, error: null, pick: null };
    st.connectAccount = null;
    const draw = (m) => {
      const host = m.querySelector('[data-cbody]');
      if (dep) {
        host.innerHTML = UI.kv([['Database', '<span class="mono">' + esc(dep.key) + '</span> of ' + esc(dep.deployment.name)], ['Engine', esc(dep.engine)]], 2) + form([{ id: 'lease', label: 'Dynamic read-only users from the lease engine (recommended)' }, { id: 'password', label: 'The admin account, its password sealed in the vault' }]);
        return;
      }
      const items = (f.list || []).filter((d) => !d.managed && d.engine);
      const auth = (items.find((x) => x.providerId === f.pick) || items[0] || { auth: [] }).auth;
      host.innerHTML = UI.field('Cloud account', UI.select(accounts.map((a) => ({ value: a.id, label: a.name + ' (' + (PROV[a.provider] || a.provider) + ')' })), f.account || '', 'data-cacct'))
        + (f.error ? UI.notice(esc(f.error), 'danger') : !f.list ? '<div class="muted" style="font-size:12px" role="status">Reading the account\'s databases…</div>'
          : items.length ? UI.table([{ label: '', srLabel: 'Pick' }, 'Name', 'Region', 'Engine', 'Endpoints'], items.map((d) => ['<input type="radio" name="cd-pick" value="' + esc(d.providerId) + '"' + ((f.pick || items[0].providerId) === d.providerId ? ' checked' : '') + ' aria-label="Pick ' + esc(d.name) + '">', '<span class="mono">' + esc(d.name) + '</span>', esc(d.region || ''), esc(d.providerEngine) + ' <span class="muted">' + esc(d.engine) + '</span>', esc([d.endpoints.private ? 'private' : '', d.endpoints.public ? 'public' : ''].filter(Boolean).join(', '))]), { clickable: false, minWidth: '0' })
            + form(auth.map((a) => ({ id: a, label: { lease: 'Dynamic read-only users from the lease engine', password: 'The admin account, its password sealed in the vault', 'rds-iam': 'RDS IAM authentication', entra: 'Microsoft Entra sign-in', account: 'The account\'s own cloud identity', key: 'A read-only key, sealed in the vault' }[a] || a })))
            : UI.empty('Nothing to connect', 'Every database in this account is already managed by a deployment or connected.'));
    };
    const form = (auth) => '<div class="formgrid" style="--cols:2">' + UI.field('Connection name', UI.input(dep ? dep.key + '-read' : 'finance-archive', { attrs: 'data-cname' }), 'Lower case letters, digits and dashes') + UI.field('Database', UI.input('', { attrs: 'data-cdb', placeholder: 'the instance\'s default' })) + UI.field('Sign-in', UI.select(auth.map((a) => ({ value: a.id, label: a.label })), auth[0] ? auth[0].id : '', 'data-cauth')) + UI.field('Label', UI.select(['public', 'internal', 'confidential'], 'internal', 'data-clabel'), 'The connection\'s label cannot exceed the region\'s ceiling') + '</div>'
      + UI.notice('The endpoint is added to the tenant\'s allowed hosts for this connection only. Nothing changes at the provider.', 'info');
    const fetchList = (m) => {
      f.list = null; f.error = null; draw(m);
      if (!f.account) { f.list = []; draw(m); return; }
      App.get('/api/admin/cloud/accounts/' + enc(f.account) + '/discover?refresh=1').then((r) => { f.list = r.instances || []; }).catch((err) => { f.error = detailOf(err); f.list = []; }).finally(() => { if (document.body.contains(m)) draw(m); });
    };
    ctx.modal({ title: dep ? 'Connect ' + esc(dep.key) + ' as a data connection' : 'Connect an existing cloud database', cls: 'wide', body: '<p class="fg2" style="margin:0">' + (dep ? 'The database becomes a data connection on the Connections screen, read with its own users.' : 'Services found in your accounts that Exprsn-AI does not use yet. Connecting one makes it a data connection on the Connections screen.') + '</p><div data-cbody></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Connect', { kind: 'primary', attrs: 'data-cgo' }),
      onMount(m) {
        if (dep) draw(m); else fetchList(m);
        m.addEventListener('change', (e) => {
          if (e.target.matches('[data-cacct]')) { f.account = e.target.value; fetchList(m); }
          if (e.target.name === 'cd-pick') { f.pick = e.target.value; const name = m.querySelector('[data-cname]').value; draw(m); m.querySelector('[data-cname]').value = name; }
        });
        m.querySelector('[data-cgo]').addEventListener('click', async () => {
          const name = m.querySelector('[data-cname]'); if (!name) return;
          const body = { name: name.value.trim(), auth: m.querySelector('[data-cauth]').value, label: m.querySelector('[data-clabel]').value };
          const db = m.querySelector('[data-cdb]').value.trim(); if (db) body.database = db;
          let account = f.account;
          if (dep) { body.deploymentId = dep.deployment.id; body.resourceKey = dep.key; account = dep.account.id; }
          else { const pick = m.querySelector('input[name="cd-pick"]:checked'); if (!pick) { ctx.toast('Pick a database to connect.', 'warn'); return; } body.providerId = pick.value; }
          try {
            const r = await App.post('/api/admin/cloud/accounts/' + enc(account) + '/connect', body);
            App.closeOverlay();
            ctx.toast('Connected as data connection <b>' + esc(r.connection.name) + '</b>.' + (r.notes && r.notes.length ? ' ' + esc(r.notes.join(' ')) : ''), 'ok', 6000);
            st.empty = false; st.want = 'link:' + r.connection.id; st.reload();
          } catch (err) { App.fail(err, 'Not connected'); }
        });
      } });
  }

  function provision(ctx, st) {
    const deps = (st.deps || []).filter((x) => x.d.provider !== 'cloudflare' && x.d.kind !== 'onprem' && ['ready', 'applied', 'degraded', 'planned', 'failed'].indexOf(x.d.state) >= 0);
    const f = { dep: deps[0] ? deps[0].d.id : null, engine: 'postgres', size: 1, ha: false, storage: 50, key: 'analytics-db' };
    const cur = () => deps.find((x) => x.d.id === f.dep);
    const body = () => {
      const x = cur();
      if (!x) return UI.notice('Provisioning adds a database to a deployment\'s graph. Make a deployment first on Deployments, or use Connect existing.', 'info');
      const sizes = SIZES[x.d.provider] || [];
      return '<div class="formgrid" style="--cols:2">'
        + UI.field('Deployment', UI.select(deps.map((y) => ({ value: y.d.id, label: y.d.name + ' (' + (PROV[y.d.provider] || y.d.provider) + ', ' + y.d.region + ')' })), f.dep, 'data-f="dep"'), 'The database joins its data network and firewall')
        + UI.field('Engine', UI.select([{ value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }], f.engine, 'data-f="engine"'), 'Version follows the engine; PostgreSQL 17 matches CI')
        + UI.field('Resource key', UI.input(f.key, { attrs: 'data-f="key"' }))
        + UI.field('Size', UI.select(sizes.map((s, i) => ({ value: String(i), label: s })), String(f.size), 'data-f="size"'))
        + UI.field('Storage (GB)', UI.input(String(f.storage), { type: 'number', attrs: 'data-f="storage" min="10" max="16000"' }))
        + UI.field('High availability', '<div style="min-height:30px;display:flex;align-items:center">' + UI.toggle('Standby in a second zone', f.ha, 'data-manual="1" data-ha') + '</div>') + '</div>'
        + (st.mode === 'budget' ? UI.notice('<b>Budget hard stop.</b> This plan adds cost and will be refused with budget_exceeded.', 'danger') : '')
        + UI.kv([['Network', 'Private endpoint in the deployment\'s data network; no public address'], ['Extensions', 'pgvector and pg_trgm, checked after create'], ['Deletion protection', 'on'], ['Credentials', 'Admin password generated and sealed in the vault; never shown']], 2)
        + '<span class="muted" style="font-size:12px">Create plan makes a plan on the deployment with the cost delta; you review and apply it on Deployments.</span>';
    };
    ctx.modal({ title: 'Provision a managed database', cls: 'wide', body: '<div data-pv>' + body() + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create plan', { kind: 'primary', attrs: 'data-plan', disabled: !deps.length }),
      onMount(m) {
        const host = m.querySelector('[data-pv]'); const redraw = () => { host.innerHTML = body(); };
        host.addEventListener('change', (e) => { const k = e.target.dataset.f; if (!k) return; if (k === 'dep' || k === 'engine' || k === 'key') f[k] = e.target.value; else f[k] = Number(e.target.value); redraw(); });
        host.addEventListener('click', (e) => { if (e.target.closest('[data-ha]')) { f.ha = !f.ha; redraw(); } });
        m.querySelector('[data-plan]').addEventListener('click', async () => {
          const x = cur(); if (!x) return;
          const plans = await App.get(B + '/' + enc(x.d.id) + '/plans?limit=5').catch(() => ({ plans: [] }));
          const base = (plans.plans.find((p) => p.state === 'applied') || plans.plans[0] || { desired: (x.resources || []).map((r) => r.desired) }).desired;
          const db = base.find((r) => r.type === 'database');
          const res = { key: f.key, type: 'database', spec: { engine: f.engine, size: (SIZES[x.d.provider] || [])[f.size], ha: f.ha, storageGb: f.storage, publicAccess: false }, dependsOn: db ? db.dependsOn : [], protect: true, region: null };
          if (db && db.network) res.network = db.network;
          if (db && db.spec && db.spec.firewall) res.spec.firewall = db.spec.firewall;
          if (base.some((r) => r.key === f.key)) { ctx.toast('A resource called ' + esc(f.key) + ' exists in ' + esc(x.d.name) + '; pick another key.', 'warn'); return; }
          try {
            const p = await App.post(B + '/' + enc(x.d.id) + '/plans', { desired: base.concat([res]) });
            App.closeOverlay();
            ctx.toast('Plan made on ' + esc(x.d.name) + ': ' + p.summary.create + ' create' + (p.estimate ? ', +$' + p.estimate.delta + ' a month' : '') + '. Review and apply it on Deployments.', 'ok', 6000);
            ctx.navigate('deployments', { id: x.d.id, tab: 'plan' });
          } catch (err) {
            if (err && err.problem && err.problem.reason === 'budget_exceeded') { App.closeOverlay(); st.mode = 'budget'; ctx.rerender(); ctx.toast('Refused: budget_exceeded. ' + esc(err.problem.detail || ''), 'danger', 6000); return; }
            App.fail(err, 'Not planned');
          }
        });
      } });
  }
})();
