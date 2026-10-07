(function () {
  const { UI, esc } = App;

  // ---- nav entry (app.js untouched): after Deployments, else after Cloud accounts, else before Zones ----
  (function nav() {
    const admin = (App.NAV || []).find((g) => g.group === 'Admin'); if (!admin || admin.items.some((i) => i.id === 'cloud-data')) return;
    const item = { id: 'cloud-data', label: 'Cloud data', icon: 'connections' };
    const after = ['deployments', 'cloud'].map((id) => admin.items.findIndex((i) => i.id === id)).find((k) => k >= 0);
    const zones = admin.items.findIndex((i) => i.id === 'zones');
    if (after !== undefined) admin.items.splice(after + 1, 0, item); else if (zones >= 0) admin.items.splice(zones, 0, item); else admin.items.push(item);
  })();

  // ---- example data (Northwind, Monday 28 Sep 2026 09:40 UTC). All IDs are fake. ----
  const FAMILIES = [
    { id: 'pg', label: 'PostgreSQL' }, { id: 'mysql', label: 'MySQL' }, { id: 'doc', label: 'Document and key-value' },
    { id: 'cache', label: 'Caches' }, { id: 'object', label: 'Object stores' }
  ];
  const PG_EXT = (pgvector, postgis, trgm) => [['pgvector', pgvector], ['PostGIS', postgis], ['pg_trgm', trgm]];
  const DBS0 = () => [
    { id: 'nw-prod-aurora', family: 'pg', provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', engine: 'Aurora PostgreSQL 17.4', size: '2x db.r7g.xlarge (writer + reader)', role: 'Exprsn-AI database', roleKind: 'own', roleOf: 'nw-prod-eu', label: 'confidential', state: 'available', ext: PG_EXT('0.8.0, on', '3.5, available', 'on'), backups: '14 days, automated; last snapshot 28 Sep 03:10', protection: true, endpoint: 'Private, VPC vpc-0example1 (no public address)', creds: 'Master password in vault:cloud/nw-prod-aurora#master; the app uses dynamic users from the PostgreSQL lease engine', iam: 'RDS IAM authentication available', cost: '$1,140' },
    { id: 'nw-dr-flex', family: 'pg', provider: 'Azure', account: 'azure-eu', region: 'swedencentral', engine: 'Azure PostgreSQL Flexible 17', size: 'GP_Standard_D4ds_v5, zone-redundant HA', role: 'Exprsn-AI database', roleKind: 'own', roleOf: 'nw-dr-azure', label: 'confidential', state: 'available', ext: PG_EXT('on (azure.extensions allow-listed)', 'available', 'on'), backups: '7 days, geo-redundant; last 28 Sep 02:40', protection: true, endpoint: 'Private endpoint in vnet-nw-dr', creds: 'Admin in vault:cloud/nw-dr-flex#admin; dynamic users from the PostgreSQL lease engine', iam: 'Entra ID authentication available', cost: '$690' },
    { id: 'hr-analytics-flex', family: 'pg', provider: 'Azure', account: 'azure-eu', region: 'westeurope', engine: 'Azure PostgreSQL Flexible 16', size: 'GP_Standard_D2ds_v5', role: 'hr-analytics', roleKind: 'conn', roleOf: 'People Ops', label: 'confidential', state: 'needs action', ext: PG_EXT('not allow-listed', 'available', 'on'), backups: '7 days, locally redundant', protection: false, endpoint: 'Private endpoint in vnet-nw-data', creds: 'Admin in vault:cloud/hr-analytics-flex#admin; connection uses dynamic read-only users', iam: 'Entra ID authentication available', cost: '$240', extMissing: true },
    { id: 'lab-pg', family: 'pg', provider: 'DigitalOcean', account: 'do-team', region: 'ams3', engine: 'DO Managed PostgreSQL 17', size: 'db-s-1vcpu-2gb', role: 'planned for lab-do', roleKind: 'planned', roleOf: 'lab-do', label: 'internal', state: 'blocked by budget', ext: PG_EXT('available', 'available', 'available'), backups: 'daily, 7 days (after creation)', protection: false, endpoint: 'Private network, VPC ams3-lab', creds: 'Will be stored in vault:cloud/lab-pg#doadmin', iam: 'Not offered by DigitalOcean', cost: '$15' },
    { id: 'partner-mysql', family: 'mysql', provider: 'DigitalOcean', account: 'do-team', region: 'fra1', engine: 'DO Managed MySQL 8', size: 'db-s-2vcpu-4gb', role: 'partner-orders', roleKind: 'conn', roleOf: 'Field Sales', label: 'internal', state: 'online', ext: null, backups: 'daily, 7 days', protection: false, endpoint: 'Private network, trusted sources: exprsn-ai app nodes', creds: 'doadmin in vault:cloud/partner-mysql#doadmin; dynamic read-only users from the MySQL lease engine', iam: 'Not offered by DigitalOcean', cost: '$60' },
    { id: 'catalog-docdb', family: 'doc', provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', engine: 'Amazon DocumentDB 5.0', size: 'db.r6g.large', role: 'product-catalog', roleKind: 'conn', roleOf: 'Field Sales', label: 'internal', state: 'available', ext: null, backups: '7 days', protection: true, endpoint: 'Private, VPC vpc-0example1', creds: 'Master in vault:cloud/catalog-docdb#master', iam: 'Not used', cost: '$330', driver: 'MongoDB driver (needs the 1.6 MongoDB connections)' },
    { id: 'events-dynamo', family: 'doc', provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', engine: 'DynamoDB table nw-events', size: 'on-demand', role: 'events', roleKind: 'conn', roleOf: 'Finance Ops, read-only', label: 'internal', state: 'active', ext: null, backups: 'Point-in-time recovery, 35 days', protection: true, endpoint: 'VPC gateway endpoint', creds: 'No password: requests signed with the account\'s federated role', iam: 'IAM only', cost: '$42', driver: 'DynamoDB driver, Query and PartiQL read-only' },
    { id: 'support-cosmos', family: 'doc', provider: 'Azure', account: 'azure-eu', region: 'westeurope', engine: 'Cosmos DB for NoSQL', size: 'serverless', role: 'discovered', roleKind: 'discovered', roleOf: '', label: 'internal', state: 'discovered', ext: null, backups: 'Continuous, 7 days', protection: false, endpoint: 'Public endpoint with IP firewall', creds: 'Not stored yet', iam: 'Entra ID data-plane roles available', cost: '$18', driver: 'Cosmos NoSQL driver, read-only SQL queries' },
    { id: 'field-d1', family: 'doc', provider: 'Cloudflare', account: 'cf-edge', region: 'Cloudflare edge', engine: 'D1 database field-notes (SQLite dialect)', size: '1.2 GB', role: 'field-notes', roleKind: 'conn', roleOf: 'Field Sales, read-only', label: 'internal', state: 'connected', ext: null, backups: 'Time Travel, 30 days', protection: false, endpoint: 'Cloudflare API (D1 query endpoint)', creds: 'Scoped API token in vault:cloud/cf-edge#token (D1 Read)', iam: 'Not applicable', cost: '$5', driver: 'D1 read-only connection; never the Exprsn-AI database' },
    { id: 'nw-prod-valkey', family: 'cache', provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', engine: 'ElastiCache Valkey 8.0', size: 'cache.r7g.large, 1 replica, cluster mode off', role: 'Exprsn-AI Redis', roleKind: 'redis', roleOf: 'nw-prod-eu', label: 'confidential', state: 'available', ext: null, backups: 'Daily snapshot, 3 days', protection: false, endpoint: 'Private, rediss:// with AUTH token', creds: 'AUTH token in vault:cloud/nw-prod-valkey#auth', iam: 'IAM auth available', cost: '$310' },
    { id: 'lab-valkey', family: 'cache', provider: 'DigitalOcean', account: 'do-team', region: 'ams3', engine: 'DO Managed Valkey', size: 'db-s-1vcpu-1gb', role: 'planned for lab-do', roleKind: 'planned', roleOf: 'lab-do', label: 'internal', state: 'blocked by budget', ext: null, backups: 'none (cache)', protection: false, endpoint: 'Private network, VPC ams3-lab', creds: 'Will be stored in vault:cloud/lab-valkey#default', iam: 'Not offered by DigitalOcean', cost: '$15' },
    { id: 'nw-edge-blobs', family: 'object', provider: 'Cloudflare', account: 'cf-edge', region: 'EU jurisdiction', engine: 'R2 bucket', size: '412 GiB', role: 'Object store for nw-edge-cf', roleKind: 'blob', roleOf: 'nw-edge-cf', label: 'internal', state: 'active', ext: null, backups: 'Exprsn-AI backups copy to a second bucket', protection: false, endpoint: 'S3-compatible endpoint, region auto', creds: 'R2 access key in vault:cloud/nw-edge-blobs#key', iam: 'Not applicable', cost: '$6', driver: 'BLOB_STORE=s3 with the R2 endpoint: files, backups, training artefacts, export bundles' }
  ];
  const DISCOVERED = [
    { id: 'support-cosmos', provider: 'Azure', account: 'azure-eu', region: 'westeurope', engine: 'Cosmos DB for NoSQL' },
    { id: 'finance-archive-rds', provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', engine: 'RDS PostgreSQL 16' },
    { id: 'field-d1', provider: 'Cloudflare', account: 'cf-edge', region: 'Cloudflare edge', engine: 'D1 (read-only)', connected: true }
  ];
  const ENGINES = {
    AWS: ['Aurora PostgreSQL 17', 'RDS PostgreSQL 17', 'RDS MySQL 8.4', 'Aurora MySQL 3', 'DocumentDB 5.0', 'DynamoDB table', 'ElastiCache Valkey 8', 'MemoryDB'],
    Azure: ['Azure PostgreSQL Flexible 17', 'Azure MySQL Flexible 8.4', 'Cosmos DB for NoSQL', 'Cosmos DB for MongoDB vCore', 'Azure Cache for Redis'],
    DigitalOcean: ['DO Managed PostgreSQL 17', 'DO Managed MySQL 8', 'DO Managed MongoDB 7', 'DO Managed Valkey 8'],
    Cloudflare: []
  };
  const REGIONS = { AWS: [['aws-prod', 'eu-central-1', 'confidential'], ['aws-prod', 'us-east-1', 'internal'], ['aws-sandbox', 'us-east-1', 'internal']], Azure: [['azure-eu', 'swedencentral', 'confidential'], ['azure-eu', 'westeurope', 'confidential']], DigitalOcean: [['do-team', 'ams3', 'internal'], ['do-team', 'fra1', 'internal'], ['do-team', 'nyc3', 'internal']], Cloudflare: [] };
  const SIZES = { AWS: ['db.t4g.medium, $68/mo', 'db.r7g.large, $280/mo', 'db.r7g.xlarge, $560/mo'], Azure: ['GP_Standard_D2ds_v5, $240/mo', 'GP_Standard_D4ds_v5, $480/mo'], DigitalOcean: ['db-s-1vcpu-2gb, $15/mo', 'db-s-2vcpu-4gb, $60/mo', 'db-s-4vcpu-8gb, $120/mo'], Cloudflare: [] };
  const CF_REASON = 'Cloudflare does not host databases; D1 is offered only as a read-only connection.';

  const stateKind = (s) => /available|online|active|connected/.test(s) ? 'ok' : /blocked|error|failed/.test(s) ? 'danger' : /needs|discovered|provisioning/.test(s) ? 'warn' : '';
  const roleCell = (d) => d.roleKind === 'own' ? UI.pill('Exprsn-AI database', 'accent') + ' <span class="muted">' + esc(d.roleOf) + '</span>'
    : d.roleKind === 'redis' ? UI.pill('Exprsn-AI Redis', 'accent') + ' <span class="muted">' + esc(d.roleOf) + '</span>'
      : d.roleKind === 'blob' ? UI.pill('Object store', 'accent') + ' <span class="muted">' + esc(d.roleOf) + '</span>'
        : d.roleKind === 'conn' ? '<a href="#" data-conn="' + esc(d.role) + '">' + esc(d.role) + '</a> <span class="muted">' + esc(d.roleOf) + '</span>'
          : d.roleKind === 'planned' ? UI.pill('planned', 'outline') + ' <span class="muted">' + esc(d.roleOf) + '</span>' : UI.pill('discovered', 'warn');
  const init = (st) => {
    if (st.dbs) return;
    st.dbs = DBS0(); st.tab = 'pg'; st.sel = 'nw-prod-aurora'; st.query = '';
    st.mode = null; st.problem = null; st.denied = false; st.empty = false;
  };

  App.register({
    id: 'cloud-data', title: 'Cloud data', section: 'admin', crumb: ['Admin', 'Cloud data'],
    summary: 'Managed databases, caches and object stores on AWS, Azure, DigitalOcean and Cloudflare',
    commands: [
      { label: 'Provision a managed database', sub: 'Cloud data', run(app) { const s = app.stateFor('cloud-data'); init(s); s.openProvision = true; app.render(); } },
      { label: 'Connect an existing cloud database', sub: 'Cloud data', run(app) { const s = app.stateFor('cloud-data'); init(s); s.openConnect = true; app.render(); } }
    ],
    states: [
      { title: 'No managed data yet', tone: 'neutral', text: 'No cloud account has a managed database, cache or object store. The page offers Provision and Connect existing.', apply(ctx) { init(ctx.state); ctx.state.empty = true; ctx.state.mode = null; ctx.rerender(); } },
      { title: 'Loading inventory', tone: 'info', text: 'The inventory is read from each account through the provider adapters; rows show as skeletons until every account answers.', apply(ctx) { init(ctx.state); ctx.state.empty = false; ctx.state.mode = 'loading'; ctx.rerender(); } },
      { title: 'Extension missing', tone: 'warn', text: 'pgvector is not allow-listed on hr-analytics-flex (azure.extensions). Knowledge on this connection cannot use vectors until it is.', apply(ctx) { init(ctx.state); const st = ctx.state; st.empty = false; st.mode = null; st.tab = 'pg'; st.sel = 'hr-analytics-flex'; st.dbs.find((d) => d.id === 'hr-analytics-flex').extMissing = true; ctx.rerender(); } },
      { title: 'Budget hard stop', tone: 'danger', text: 'do-team is at 103 % of its $4,000 budget. Provisioning lab-pg adds $15 a month and is refused with budget_exceeded until the budget is raised or an override is approved.', apply(ctx) { init(ctx.state); const st = ctx.state; st.empty = false; st.mode = 'budget'; st.tab = 'pg'; st.sel = 'lab-pg'; ctx.rerender(); } },
      { title: 'Driver not available', tone: 'warn', text: 'catalog-docdb needs the MongoDB driver from the 1.6 MongoDB connections work. It is listed and monitored but cannot be queried from Connections yet.', apply(ctx) { init(ctx.state); const st = ctx.state; st.empty = false; st.mode = 'driver'; st.tab = 'doc'; st.sel = 'catalog-docdb'; ctx.rerender(); } },
      { title: 'Provider error', tone: 'danger', text: 'Azure Resource Manager answered 503 for azure-eu. Its rows show the last known state with the time it was read; the others are current.', apply(ctx) { init(ctx.state); const st = ctx.state; st.empty = false; st.mode = 'error'; ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'Felix Brandt (member, Finance Ops) opens Cloud data without cloud:read. The page explains which permission is missing and who grants it.', apply(ctx) { init(ctx.state); ctx.state.denied = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; init(st);
      if (ctx.params.db) { const d = st.dbs.find((x) => x.id === ctx.params.db); if (d) { st.sel = d.id; st.tab = d.family; } delete ctx.params.db; }
      const style = '<style>.cloud-data-ext{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;font-size:12px}.cloud-data-ext span:nth-child(even){text-align:right}.cloud-data-skel td{padding:10px}</style>';

      if (st.denied) {
        root.innerHTML = style + '<div class="page">' + UI.pagehead('Cloud data', 'Managed databases, caches and object stores') + UI.problem('You need cloud:read to see cloud data', 'Felix Brandt holds Member in Finance Ops. Cloud data needs cloud:read, which the Cloud admin, Cloud operator and FinOps analyst roles carry. A tenant admin grants it on Roles and access.', '5d2e8a1c9b3f4e7a0c6d1b8e2f4a9c3d')
          + UI.panel('Why', UI.timeline([{ title: 'Role', text: 'Member: cloud:read not granted', tone: 'danger' }, { title: 'Scopes', text: 'not reached' }, { title: 'Tenant, clearance, zone ceiling', text: 'not reached' }]))
          + '<div class="hstack gap6">' + UI.btn('Open Roles and access', { attrs: 'data-go="roles"' }) + UI.btn('Back to the board view', { kind: 'ghost', attrs: 'data-undeny' }) + '</div></div>';
        ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
        ctx.on('click', '[data-undeny]', () => { st.denied = false; ctx.rerender(); });
        return;
      }

      const head = UI.pagehead('Cloud data', 'Managed databases, caches and object stores across your cloud accounts', UI.btn('Connect existing', { icon: 'link', attrs: 'data-connect' }) + UI.btn('Provision database', { kind: 'primary', icon: 'plus', attrs: 'data-provision' }));
      const example = '<span class="muted" style="font-size:12px">Example data. Prices are illustrative, not provider quotes.</span>';

      if (st.empty) {
        root.innerHTML = style + '<div class="page">' + head + UI.empty('No managed data yet', 'Provision a PostgreSQL, MySQL, document or cache service in a connected cloud account, or connect one that already exists. Exprsn-AI can use it as its own database, as its Redis, or as a data connection.', UI.btn('Provision database', { kind: 'primary', attrs: 'data-provision' }) + ' ' + UI.btn('Connect existing', { attrs: 'data-connect' })) + example + '</div>';
        wire(ctx, st, null);
        return;
      }

      const tabs = UI.tabs(FAMILIES.map((f) => ({ id: f.id, label: f.label, count: st.dbs.filter((d) => d.family === f.id).length })), st.tab);
      const q = st.query.toLowerCase();
      const rows = st.dbs.filter((d) => d.family === st.tab && (!q || (d.id + ' ' + d.engine + ' ' + d.provider + ' ' + d.region + ' ' + d.role).toLowerCase().includes(q)));
      if (!rows.some((d) => d.id === st.sel)) st.sel = rows.length ? rows[0].id : null;
      const sel = st.dbs.find((d) => d.id === st.sel);

      let notices = '';
      if (st.mode === 'error') notices += UI.notice('<b>Azure Resource Manager answered 503</b> for azure-eu at 09:38. Azure rows show the state read at 09:12; AWS, DigitalOcean and Cloudflare rows are current. Retrying with backoff (attempt 3 of 6).', 'danger', UI.btn('Retry now', { size: 'xs', attrs: 'data-retry' }));
      if (st.tab === 'cache') notices += UI.notice('Exprsn-AI uses Redis for BullMQ, the Socket.io adapter and the bus. BullMQ needs cluster mode off and <span class="mono">maxmemory-policy noeviction</span>. Workers KV is not a substitute for Redis: a Cloudflare deployment takes its cache from another provider.', 'info');
      if (st.tab === 'object') notices += UI.notice('S3 and DigitalOcean Spaces use <span class="mono">BLOB_STORE=s3</span>; R2 does too, through its S3-compatible endpoint. Azure Blob storage needs <span class="mono">BLOB_STORE=azure</span> (B-10208).', 'info');

      let table;
      if (st.mode === 'loading') {
        table = '<div class="tablewrap"><table class="dt cloud-data-skel"><thead><tr><th>Name</th><th>Provider, region</th><th>Engine</th><th>Size</th><th>Role</th><th>State</th></tr></thead><tbody>' + [1, 2, 3, 4].map(() => '<tr>' + [1, 2, 3, 4, 5, 6].map(() => '<td><div class="skeleton"></div></td>').join('') + '</tr>').join('') + '</tbody></table></div><span class="muted" style="font-size:12px">Reading inventory from aws-prod, azure-eu, do-team and cf-edge…</span>';
      } else {
        table = UI.table(['Name', 'Provider, region', 'Engine', 'Size', 'Role', 'State'], rows.map((d) => ({ cells: ['<span class="mono">' + esc(d.id) + '</span>', esc(d.provider) + ' <span class="muted">' + esc(d.account + ', ' + d.region) + '</span>', esc(d.engine), esc(d.size), roleCell(d), UI.pill(st.mode === 'error' && d.provider === 'Azure' ? d.state + ' (09:12)' : d.state, stateKind(d.state))], attrs: 'data-id="' + esc(d.id) + '"', selected: sel && d.id === sel.id })), { minWidth: '940px', emptyTitle: 'Nothing in this family', emptyText: 'Provision one or connect an existing service.' });
      }

      let insp = '';
      if (sel && st.mode !== 'loading') {
        const ext = sel.ext ? '<div class="eyebrow">Extensions</div><div class="cloud-data-ext">' + sel.ext.map(([n, v]) => '<span>' + esc(n) + '</span><span>' + (/not/.test(v) ? UI.pill(v, 'warn') : '<span class="fg2">' + esc(v) + '</span>') + '</span>').join('') + '</div>'
          + (sel.extMissing ? UI.notice('pgvector is not in <span class="mono">azure.extensions</span>. Knowledge bases on this connection fall back to keyword search until it is allow-listed.', 'warn', UI.btn('Allow-list pgvector', { size: 'xs', attrs: 'data-allow' })) : '<span class="muted" style="font-size:11px">Checked with pg_available_extensions at 09:12.</span>') : '';
        let extra = '';
        if (st.mode === 'budget' && sel.account === 'do-team') extra += UI.notice('<b>Budget hard stop.</b> do-team is at 103 % of $4,000. Creating ' + esc(sel.id) + ' adds ' + esc(sel.cost) + ' a month and is refused with <span class="mono">budget_exceeded</span>. Scale-down and destroy stay allowed.', 'danger', UI.btn('Open Cloud spend', { size: 'xs', attrs: 'data-go="finops"' }));
        if (st.mode === 'driver' && sel.id === 'catalog-docdb') extra += UI.notice('<b>Driver not available.</b> DocumentDB is queried with the MongoDB driver, which arrives with the 1.6 MongoDB connections. The cluster is monitored here; the connection product-catalog stays disabled.', 'warn');
        if (sel.driver) extra += '<div class="muted" style="font-size:12px">' + esc(sel.driver) + '</div>';
        let actions = '';
        if (sel.roleKind === 'discovered') actions = UI.btn('Connect as data connection', { kind: 'primary', size: 'sm', attrs: 'data-connect-one' });
        else if (sel.roleKind === 'planned') actions = UI.btn('Provision now', { kind: 'primary', size: 'sm', attrs: 'data-provision-one' });
        else if (sel.roleKind === 'conn') actions = UI.btn('Open connection', { size: 'sm', attrs: 'data-conn="' + esc(sel.role) + '"' }) + (sel.family === 'pg' || sel.family === 'mysql' ? UI.btn('Use as Exprsn-AI database', { size: 'sm', attrs: 'data-own' }) : '');
        else if (sel.roleKind === 'own') actions = UI.btn('Take snapshot', { size: 'sm', attrs: 'data-snap' }) + UI.btn('Open deployment', { size: 'sm', attrs: 'data-go="deployments"' });
        else actions = UI.btn('Open deployment', { size: 'sm', attrs: 'data-go="deployments"' });
        if (sel.provider !== 'Cloudflare' && sel.family !== 'object') actions += UI.btn(sel.protection ? 'Turn off deletion protection' : 'Turn on deletion protection', { size: 'sm', kind: 'ghost', attrs: 'data-protect' });
        insp = '<div class="hstack"><div class="eyebrow grow">Selected service</div>' + UI.pill(sel.state, stateKind(sel.state)) + '</div><div class="mono" style="font-size:14px;font-weight:500;overflow-wrap:anywhere">' + esc(sel.id) + '</div><div class="muted" style="font-size:12px">' + esc(sel.engine) + ', ' + esc(sel.provider + ' ' + sel.region) + '</div>'
          + UI.kv([['Role', roleCell(sel)], ['Region ceiling', UI.label(sel.label, { sm: true })], ['Size', esc(sel.size)], ['Estimate per month', esc(sel.cost)], ['Backups and snapshots', esc(sel.backups)], ['Deletion protection', sel.protection ? UI.pill('on', 'ok') : UI.pill('off', 'outline')], ['Endpoint', esc(sel.endpoint)], ['Credentials', esc(sel.creds)], ['IAM or Entra sign-in', esc(sel.iam)]], 1)
          + ext + extra + '<div class="hstack wrap gap6">' + actions + '</div>';
      }

      root.innerHTML = style + '<div class="page">' + head + notices + tabs
        + '<div class="toolbar">' + UI.search('Filter by name, engine, region or role', 'data-search', st.query) + '<span class="muted right" style="font-size:12px">' + rows.length + ' in ' + esc(FAMILIES.find((f) => f.id === st.tab).label) + ', ' + st.dbs.length + ' in all accounts</span></div>'
        + table + example + '</div>'
        + (insp ? '<aside class="inspector w360">' + insp + '</aside>' : '');
      wire(ctx, st, sel);
    }
  });

  function wire(ctx, st, sel) {
    ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
    ctx.on('click', 'tr.row[data-id]', (e, t) => { st.sel = t.dataset.id; ctx.rerender(); });
    ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
    ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
    ctx.on('click', '[data-conn]', (e, t) => { e.preventDefault(); ctx.navigate('connections', { connection: t.dataset.conn }); });
    ctx.on('click', '[data-retry]', () => { st.mode = null; ctx.rerender(); ctx.toast('azure-eu answered. Azure rows are current again.', 'ok'); });
    ctx.on('click', '[data-provision]', () => provision(ctx, st));
    ctx.on('click', '[data-connect]', () => connect(ctx, st));
    if (st.openProvision) { st.openProvision = false; setTimeout(() => provision(ctx, st), 30); }
    if (st.openConnect) { st.openConnect = false; setTimeout(() => connect(ctx, st), 30); }
    if (!sel) return;
    ctx.on('click', '[data-allow]', async () => {
      const ok = await ctx.confirm({ title: 'Allow-list pgvector on ' + sel.id, tag: 'server parameter', tone: 'ok', body: '<p class="fg2" style="margin:0">Adds <span class="mono">VECTOR</span> to the server parameter <span class="mono">azure.extensions</span> through Azure Resource Manager, then runs <span class="mono">CREATE EXTENSION vector</span> in hr_analytics. No restart is needed for this parameter.</p>', kv: [['Plan', '1 update, 0 create, 0 delete'], ['Cost change', '$0 a month']], ok: 'Apply' });
      if (!ok) return;
      sel.extMissing = false; sel.ext[0][1] = '0.8.0, on'; sel.state = 'available'; if (st.mode === 'extension') st.mode = null; ctx.rerender();
      ctx.toast('pgvector allow-listed and created on hr-analytics-flex. Audit entry cloud.resource.updated written.', 'ok', 5000);
    });
    ctx.on('click', '[data-protect]', async () => {
      const turningOff = sel.protection;
      const ok = await ctx.confirm({ title: (turningOff ? 'Turn off' : 'Turn on') + ' deletion protection', tag: turningOff ? 'dual control' : 'protection', tone: turningOff ? 'danger' : 'ok', body: '<p class="fg2" style="margin:0">' + (turningOff ? 'Without protection, destroying the deployment or the database deletes it after a final snapshot. A second cloud admin must approve this change.' : 'The provider refuses deletes while protection is on, and Exprsn-AI refuses to plan a delete.') + '</p>', ok: turningOff ? 'Request approval' : 'Turn on' });
      if (!ok) return;
      if (turningOff) { ctx.toast('Proposal sent to Jonas Lindqvist for approval. Protection stays on until approved.', '', 5000); return; }
      sel.protection = true; ctx.rerender(); ctx.toast('Deletion protection is on for ' + esc(sel.id) + '.', 'ok');
    });
    ctx.on('click', '[data-snap]', async () => {
      const ok = await ctx.confirm({ title: 'Snapshot ' + sel.id, tag: 'snapshot', tone: 'ok', body: '<p class="fg2" style="margin:0">A manual provider snapshot. It is kept until deleted and costs storage at the provider\'s snapshot rate.</p>', ok: 'Take snapshot' });
      if (!ok) return;
      sel.backups = sel.backups.replace(/last snapshot [^;]*|last [^;]*$/, 'last snapshot 28 Sep 09:41 (manual)'); ctx.rerender(); ctx.toast('Snapshot started for ' + esc(sel.id) + '. It appears under Backups when complete.', 'ok');
    });
    ctx.on('click', '[data-own]', () => ownDb(ctx, sel));
    ctx.on('click', '[data-connect-one]', () => connect(ctx, st, sel.id));
    ctx.on('click', '[data-provision-one]', async () => {
      if (sel.account === 'do-team') { ctx.toast('Refused: budget_exceeded. do-team is at 103 % of its $4,000 budget; creating ' + esc(sel.id) + ' adds ' + esc(sel.cost) + ' a month.', 'danger', 6000); st.mode = 'budget'; ctx.rerender(); return; }
      ctx.toast('Plan created for ' + esc(sel.id) + '.');
    });
  }

  function ownDb(ctx, sel) {
    ctx.modal({ title: 'Use ' + esc(sel.id) + ' as the Exprsn-AI database', cls: 'wide', body: '<p class="fg2" style="margin:0">Moves an existing install\'s database onto this managed service. The steps run as jobs in the deploy worker and each is recorded in the operation journal.</p>'
      + UI.timeline([{ title: 'Back up', text: '<span class="mono">exprsn-ai backup:create</span> on the current database, consistent with the blob store', tone: 'ok' }, { title: 'Restore', text: '<span class="mono">exprsn-ai backup:restore</span> into ' + esc(sel.id) + ' over TLS with the provider CA bundle' }, { title: 'Check', text: '<span class="mono">exprsn-ai migrate --check</span>, extension check (pgvector), row counts per table' }, { title: 'Cut over', text: 'Read-only window (about 20 minutes for 48 GiB), final delta, then DATABASE_URL points at the new service' }, { title: 'Verify', text: '/readyz on every instance; the old database stays read-only for 7 days for rollback' }])
      + UI.field('Cutover window', UI.input('2026-10-03 22:00 UTC', { attrs: 'data-window' }), 'Users see a read-only banner during the window')
      + UI.notice('Connection limits: ' + esc(sel.size) + ' allows about 400 connections; your instances use up to 2 × DB_POOL_MAX (20).', 'info'),
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Schedule migration', { kind: 'primary', attrs: 'data-sched' }),
    onMount(m) { m.querySelector('[data-sched]').addEventListener('click', () => { const w = m.querySelector('[data-window]').value; App.closeOverlay(); ctx.toast('Migration to ' + esc(sel.id) + ' scheduled for ' + esc(w) + '. Tenant admins are notified 48 hours before.', 'ok', 5000); }); } });
  }

  function connect(ctx, st, preselect) {
    const items = DISCOVERED.filter((d) => !d.connected);
    ctx.modal({ title: 'Connect an existing cloud database', cls: 'wide', body: '<p class="fg2" style="margin:0">Services found in your accounts that Exprsn-AI does not use yet. Connecting one makes it a data connection on the Connections screen; nothing is changed at the provider except a private endpoint where needed.</p>'
      + UI.table(['', 'Name', 'Provider, region', 'Engine'], items.map((d) => ['<input type="radio" name="cd-pick" value="' + esc(d.id) + '"' + ((preselect || items[0].id) === d.id ? ' checked' : '') + ' aria-label="Pick ' + esc(d.id) + '">', '<span class="mono">' + esc(d.id) + '</span>', esc(d.provider + ', ' + d.account + ', ' + d.region), esc(d.engine)]), { clickable: false, minWidth: '0' })
      + '<div class="formgrid" style="--cols:2">' + UI.field('Connection name', UI.input('support-tickets', { attrs: 'data-name' })) + UI.field('Workspace', UI.select(['People Ops', 'Finance Ops', 'Field Sales', 'Legal'], 'People Ops')) + UI.field('Access', UI.select(['Read-only (recommended)', 'Read and write'], 'Read-only (recommended)')) + UI.field('Credentials', UI.select(['Dynamic users from the lease engine', 'Provider IAM or Entra sign-in', 'Stored password in the vault'], 'Provider IAM or Entra sign-in')) + '</div>'
      + UI.notice('The endpoint is added to CONNECTIONS_ALLOWED_HOSTS for this connection only. The connection\'s label cannot exceed the region\'s ceiling.', 'info'),
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Connect', { kind: 'primary', attrs: 'data-do' }),
    onMount(m) { m.querySelector('[data-do]').addEventListener('click', () => { const pick = (m.querySelector('input[name="cd-pick"]:checked') || {}).value; const name = m.querySelector('[data-name]').value || 'support-tickets'; App.closeOverlay(); const d = st.dbs.find((x) => x.id === pick); if (d) { d.roleKind = 'conn'; d.role = name; d.roleOf = 'People Ops'; d.state = 'connected'; d.creds = 'Entra ID data-plane role for the Exprsn-AI identity'; st.sel = d.id; st.tab = d.family; } else { st.dbs.push({ id: pick, family: 'pg', provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', engine: 'RDS PostgreSQL 16', size: 'db.r7g.large', role: name, roleKind: 'conn', roleOf: 'People Ops', label: 'confidential', state: 'connected', ext: PG_EXT('0.8.0, available', 'available', 'on'), backups: '7 days', protection: true, endpoint: 'Private, VPC vpc-0example1', creds: 'Dynamic users from the PostgreSQL lease engine', iam: 'RDS IAM authentication available', cost: '$280' }); st.sel = pick; st.tab = 'pg'; } st.empty = false; ctx.rerender(); ctx.toast('Connected ' + esc(pick) + ' as data connection <b>' + esc(name) + '</b>. <a href="#/connections" style="color:inherit">Open Connections</a>', 'ok', 5000); }); } });
  }

  function provision(ctx, st) {
    const f = { provider: 'AWS', engine: ENGINES.AWS[0], region: 0, size: 1, ha: true, role: 'conn' };
    const body = () => {
      const cf = f.provider === 'Cloudflare';
      const regs = REGIONS[f.provider];
      const price = cf ? 0 : parseInt((SIZES[f.provider][f.size] || '$0').split('$')[1].replace(/,/g, ''), 10) * (f.ha ? 2 : 1);
      const budget = !cf && regs[f.region] && regs[f.region][0] === 'do-team';
      return '<div class="formgrid" style="--cols:2">'
        + UI.field('Provider', UI.select(['AWS', 'Azure', 'DigitalOcean', 'Cloudflare'], f.provider, 'data-f="provider"'))
        + UI.field('Engine', cf ? '<select class="select" disabled><option>No database engines</option></select>' : UI.select(ENGINES[f.provider], f.engine, 'data-f="engine"'), cf ? esc(CF_REASON) : 'Version follows the engine; PostgreSQL 17 matches CI')
        + UI.field('Account and region', cf ? '<select class="select" disabled><option>Not applicable</option></select>' : UI.select(regs.map((r, i) => ({ value: String(i), label: r[0] + ', ' + r[1] + ' (ceiling ' + r[2] + ')' })), String(f.region), 'data-f="region"'), 'The data label cannot exceed the region\'s ceiling')
        + UI.field('Size', cf ? '<select class="select" disabled><option>Not applicable</option></select>' : UI.select(SIZES[f.provider].map((s, i) => ({ value: String(i), label: s })), String(f.size), 'data-f="size"'))
        + UI.field('High availability', cf ? '<span class="muted">Not applicable</span>' : '<div style="height:30px;display:flex;align-items:center">' + UI.toggle('Standby in a second zone', f.ha, 'data-manual="1" data-f="ha"') + '</div>')
        + UI.field('Use as', cf ? '<span class="muted">Not applicable</span>' : UI.seg([{ id: 'own', label: 'Exprsn-AI database' }, { id: 'conn', label: 'Data connection' }], f.role, 'data-f="role"'))
        + '</div>'
        + (cf ? UI.notice(esc(CF_REASON) + ' Use Connect existing for D1, or pick another provider for the data tier of a Cloudflare deployment.', 'info')
          : (budget ? UI.notice('<b>Budget hard stop.</b> do-team is at 103 % of its $4,000 budget. This plan adds $' + price + ' a month and will be refused with budget_exceeded.', 'danger') : '')
          + UI.kv([['Estimate per month', '<b>$' + price.toLocaleString('en-US') + '</b>' + (f.ha ? ' <span class="muted">(primary + standby)</span>' : '')], ['Extensions checked after create', 'pgvector, PostGIS, pg_trgm'], ['Network', 'Private endpoint; no public address'], ['Credentials', 'Master password generated and sealed in the vault; never shown']], 2)
          + '<span class="muted" style="font-size:12px">Example data. Prices are illustrative, not provider quotes.</span>');
    };
    ctx.modal({ title: 'Provision a managed database', cls: 'wide', body: '<div data-pv>' + body() + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create plan', { kind: 'primary', attrs: 'data-plan' }),
      onMount(m) {
        const host = m.querySelector('[data-pv]'); const redraw = () => { host.innerHTML = body(); m.querySelector('[data-plan]').disabled = f.provider === 'Cloudflare'; };
        host.addEventListener('change', (e) => { const k = e.target.dataset.f; if (!k) return; if (k === 'provider') { f.provider = e.target.value; f.engine = ENGINES[f.provider][0]; f.region = 0; f.size = 0; } else if (k === 'engine') f.engine = e.target.value; else f[k] = +e.target.value; redraw(); });
        host.addEventListener('click', (e) => { const t = e.target.closest('[data-f="ha"]'); if (t) { f.ha = !f.ha; redraw(); } const s = e.target.closest('[data-seg]'); if (s) { f.role = s.dataset.seg; redraw(); } });
        m.querySelector('[data-plan]').addEventListener('click', () => {
          const r = REGIONS[f.provider][f.region];
          App.closeOverlay();
          if (r[0] === 'do-team') { st.mode = 'budget'; ctx.rerender(); ctx.toast('Refused: budget_exceeded. do-team is over its budget; scale-down and destroy stay allowed.', 'danger', 6000); return; }
          const id = 'nw-new-' + (f.engine.match(/MySQL/) ? 'mysql' : f.engine.match(/Valkey|Redis|MemoryDB/) ? 'cache' : 'pg');
          const fam = /MySQL/.test(f.engine) ? 'mysql' : /Valkey|Redis|MemoryDB/.test(f.engine) ? 'cache' : /Cosmos|Mongo|DynamoDB|DocumentDB/.test(f.engine) ? 'doc' : 'pg';
          st.dbs.push({ id, family: fam, provider: f.provider, account: r[0], region: r[1], engine: f.engine, size: SIZES[f.provider][f.size].split(',')[0], role: f.role === 'own' ? 'Exprsn-AI database' : 'not yet named', roleKind: f.role === 'own' ? 'own' : 'planned', roleOf: f.role === 'own' ? 'new deployment' : 'connection after create', label: r[2], state: 'provisioning', ext: fam === 'pg' ? PG_EXT('checked after create', 'checked after create', 'checked after create') : null, backups: '7 days, automated', protection: true, endpoint: 'Private endpoint (being created)', creds: 'Master password sealed in the vault', iam: 'Configured after create', cost: SIZES[f.provider][f.size].split(', ')[1] });
          st.sel = id; st.tab = fam; st.empty = false; ctx.rerender();
          ctx.toast('Plan applied: ' + esc(f.engine) + ' in ' + esc(r[1]) + ' is provisioning. Follow it in the operation journal.', 'ok', 5000);
        });
      } });
  }
})();
