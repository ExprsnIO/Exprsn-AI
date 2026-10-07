(function () {
  const { UI, esc } = App;

  // ---- nav entry (app.js untouched): after Cloud accounts when present, otherwise before Zones ----
  (function nav() {
    const admin = (App.NAV || []).find((g) => g.group === 'Admin'); if (!admin || admin.items.some((i) => i.id === 'deployments')) return;
    const item = { id: 'deployments', label: 'Deployments', icon: 'branch' };
    const c = admin.items.findIndex((i) => i.id === 'cloud'), z = admin.items.findIndex((i) => i.id === 'zones');
    if (c >= 0) admin.items.splice(c + 1, 0, item); else if (z >= 0) admin.items.splice(z, 0, item); else admin.items.push(item);
  })();

  // ---- example data (Northwind, Monday 28 Sep 2026 09:40 UTC). Every ID here is fake. ----
  const ACCOUNTS = { AWS: ['aws-prod', 'aws-sandbox'], Azure: ['azure-eu', 'azure-contoso'], DigitalOcean: ['do-team'], Cloudflare: ['cf-edge'], 'On-prem': ['northwind-dc1'] };
  const REGIONS = { 'aws-prod': ['eu-central-1', 'us-east-1'], 'aws-sandbox': ['us-east-1'], 'azure-eu': ['swedencentral', 'westeurope'], 'azure-contoso': ['westeurope'], 'do-team': ['ams3', 'fra1', 'nyc3'], 'cf-edge': ['global edge'], 'northwind-dc1': ['Frankfurt data centre'] };
  const CEIL = { 'eu-central-1': 'confidential', 'us-east-1': 'internal', swedencentral: 'confidential', westeurope: 'confidential', ams3: 'internal', fra1: 'internal', nyc3: 'internal', 'global edge': 'internal', 'Frankfurt data centre': 'restricted' };
  const COMPUTE = {
    AWS: { k8s: 'Amazon EKS', vm: 'EC2 with the bare-metal installer', containers: 'ECS Fargate' },
    Azure: { k8s: 'Azure Kubernetes Service', vm: 'Azure VMs with the bare-metal installer', containers: 'Azure Container Apps' },
    DigitalOcean: { k8s: 'DigitalOcean Kubernetes', vm: 'Droplets with the bare-metal installer', containers: 'App Platform' }
  };
  const CF_REASON = 'Runs the app tier only; pick a provider for data and GPUs';
  const BASE = { k8s: [1150, 2600, 5900], vm: [380, 900, 2310], containers: [290, 760, 1900], cfc: [240, 520, 1100] };
  const DB = [190, 620, 1720], CACHE = [60, 180, 420], STORE = [25, 60, 140], NET = [70, 110, 220];
  const SIZES = ['Small', 'Medium', 'Large-HA'];

  const DEPLOYS0 = () => [
    { id: 'nw-prod-eu', provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', target: 'Kubernetes, EKS 1.33, 3x m7i.xlarge', data: 'Aurora PostgreSQL 17, ElastiCache Valkey 8, S3', front: 'Cloudflare DNS, Tunnel, WAF, Access', release: '2.0.0', upgrade: '2.0.1', state: 'healthy', drift: 1, est: 8420, mtd: 5980, url: 'https://ai.northwind-example.com' },
    { id: 'nw-dr-azure', provider: 'Azure', account: 'azure-eu', region: 'swedencentral', target: 'VMs, 2x Standard_D4s_v5', data: 'PostgreSQL Flexible 17, Azure Cache for Redis, Blob', front: 'ACME (Let\'s Encrypt), Azure DNS', release: '2.0.0', state: 'healthy', note: 'warm standby', drift: 0, est: 2310, mtd: 1640, url: 'https://dr.ai.northwind-example.com' },
    { id: 'nw-edge-cf', provider: 'Cloudflare', account: 'cf-edge + aws-prod', region: 'edge, eu-central-1', target: 'Cloudflare Containers (3), assets on Workers', data: 'Hyperdrive to nw-edge-aurora, Valkey nw-edge-valkey, R2 (EU)', front: 'Cloudflare (built in)', release: '2.0.0', state: 'plan ready', wait: 'cf-edge token lacks Containers Edit', drift: 0, est: 1480, mtd: null, url: 'https://edge.ai.northwind-example.com' },
    { id: 'lab-do', provider: 'DigitalOcean', account: 'do-team', region: 'ams3', target: 'App Platform, 2 containers', data: 'Managed PostgreSQL 17, Managed Valkey, Spaces', front: 'Cloudflare DNS, WAF', release: '2.0.0', state: 'blocked', wait: 'budget exceeded (plan adds $214/mo)', drift: 0, est: 214, mtd: null, url: 'https://lab.ai.northwind-example.com' },
    { id: 'sandbox-ecs', provider: 'AWS', account: 'aws-sandbox', region: 'us-east-1', target: 'ECS Fargate, 2 tasks', data: 'RDS PostgreSQL 17, ElastiCache Valkey, S3', front: 'ACME, Route 53', release: '2.0.0', state: 'applying', step: 7, drift: 0, est: 386, mtd: 41, url: 'https://sandbox.ai.northwind-example.com' }
  ];
  const SANDBOX_STEPS = ['VPC and subnets', 'Security groups', 'NAT gateway', 'S3 bucket exprsn-sandbox-blobs-example', 'ElastiCache subnet group', 'ElastiCache Valkey t4g.small', 'RDS PostgreSQL 17 db.t4g.medium', 'Secrets sealed into the vault', 'ECS cluster and task definition', 'Migration task (migrate --check, migrate)', 'ECS service and load balancer', 'Route 53 record, ACME certificate, verify'];
  const RESOURCES = {
    'nw-prod-eu': [
      ['VPC', 'vpc-0example01', 'network', 'in sync'], ['Subnets (6, private and public)', 'subnet-0example1a … 1f', 'network', 'in sync'], ['Security group', 'sg-0example1', 'firewall', 'drifted'], ['NAT gateway', 'nat-0example01', 'network', 'in sync'],
      ['EKS cluster 1.33', 'nw-prod-eu', 'cluster', 'in sync'], ['Node group ng-app, 3x m7i.xlarge', 'ng-app', 'node group', 'in sync'], ['Node group ng-gpu-l40s (pool gpu-cloud-eu)', 'ng-gpu-l40s', 'node group', 'in sync', 'cloud-compute'],
      ['Aurora PostgreSQL 17.4, protected', 'nw-prod-aurora', 'database', 'in sync', 'cloud-data'], ['ElastiCache Valkey 8.0', 'nw-prod-valkey', 'cache', 'in sync', 'cloud-data'], ['S3 bucket', 'nw-prod-blobs-example', 'bucket', 'in sync'],
      ['Helm release exprsn-ai 2.0.0', 'exprsn-ai/exprsn-ai', 'release', 'in sync'], ['Cloudflare Tunnel, 2 connectors', 'tunnel 6f1e…example', 'front door', 'in sync'], ['Cloudflare DNS ai.northwind-example.com', 'CNAME to the tunnel', 'dns', 'in sync'], ['Cloudflare Access app, admin console', 'access app example-01', 'front door', 'in sync']
    ],
    'nw-dr-azure': [['Resource group', 'rg-exprsn-dr', 'group', 'in sync'], ['Virtual network', 'vnet-exprsn-dr', 'network', 'in sync'], ['VM exprsn-dr-1, Standard_D4s_v5', 'vm-exprsn-dr-1', 'vm', 'in sync'], ['VM exprsn-dr-2, Standard_D4s_v5', 'vm-exprsn-dr-2', 'vm', 'in sync'], ['PostgreSQL Flexible 17, protected', 'nw-dr-flex', 'database', 'in sync', 'cloud-data'], ['Azure Cache for Redis', 'nw-dr-redis', 'cache', 'in sync', 'cloud-data'], ['Storage account, Blob', 'nwdrblobsexample', 'bucket', 'in sync'], ['Azure DNS dr.ai.northwind-example.com', 'A record', 'dns', 'in sync']],
    'nw-edge-cf': [['Cloudflare Container app exprsn-ai, 3 instances', 'not created', 'containers', 'planned'], ['Worker with static assets (console)', 'not created', 'worker', 'planned'], ['Hyperdrive config to nw-edge-aurora', 'not created', 'hyperdrive', 'planned'], ['Aurora PostgreSQL 17 (aws-prod)', 'nw-edge-aurora', 'database', 'planned', 'cloud-data'], ['ElastiCache Valkey, TLS endpoint with AUTH and IP allow list (aws-prod)', 'nw-edge-valkey', 'cache', 'planned', 'cloud-data'], ['R2 bucket, EU jurisdiction', 'nw-edge-blobs', 'bucket', 'in sync', 'cloud-data']],
    'lab-do': [['VPC', 'lab-vpc', 'network', 'planned'], ['App Platform app, 2 containers', 'lab-app', 'containers', 'planned'], ['Managed PostgreSQL 17', 'lab-pg', 'database', 'planned', 'cloud-data'], ['Managed Valkey', 'lab-valkey', 'cache', 'planned', 'cloud-data'], ['Spaces bucket', 'lab-blobs-example', 'bucket', 'planned'], ['Cloudflare DNS and WAF', 'lab.ai.northwind-example.com', 'front door', 'planned']]
  };
  const UPGRADE_ROWS = [
    ['create', 'Node group ng-app-v2 (2.0.1 AMI, m7i.2xlarge)', 'surge replacement for ng-app', '+$380'], ['create', 'Aurora snapshot pre-upgrade-2-0-1', 'taken before the migration', '+$27'], ['create', 'Kubernetes job exprsn-ai-migrate-2.0.1', 'migrate --check, then migrate', '$0'], ['create', 'Cloudflare WAF rule exprsn-v1-rate', 'rate limit for /v1', '+$5'],
    ['update', 'Helm release exprsn-ai', 'image 2.0.0 → 2.0.1 (sha256:7c1e…example)', '$0'], ['update', 'EKS add-on vpc-cni', 'v1.19.2 → v1.19.5', '$0'], ['update', 'Cloudflare Tunnel config', 'ingress rule for /readyz', '$0'],
    ['replace', 'Launch template lt-gpu-l40s', 'new AMI forces a new version; nodes roll one at a time', '$0']
  ];
  const money = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
  const statePill = (d) => UI.pill(d.state, /healthy/.test(d.state) ? 'ok' : /blocked|failed|destroy/.test(d.state) ? 'danger' : /applying|upgrading|ready/.test(d.state) ? 'info' : 'warn');
  const kindPill = (k) => UI.pill(k, k === 'create' ? 'ok' : k === 'delete' ? 'danger' : k === 'replace' ? 'warn' : 'info');

  const init = (st) => {
    if (st.deploys) return;
    st.deploys = DEPLOYS0(); st.sel = 'nw-prod-eu'; st.detail = null; st.tab = 'overview'; st.q = ''; st.wiz = null; st.view = null; st.driftResolved = null; st.throttled = false;
  };
  const newWiz = () => ({ step: 1, provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', compute: 'k8s', size: 1, db: 'new', cache: 'new', store: 'new', dataProvider: 'aws-prod', front: 'cloudflare', access: true, name: 'nw-analytics-eu', host: 'analytics.ai.northwind-example.com' });

  App.register({
    id: 'deployments', title: 'Deployments', section: 'admin', crumb: (st) => st && st.detail ? ['Admin', 'Deployments', st.detail] : ['Admin', 'Deployments'],
    summary: 'Exprsn-AI deployed to AWS, Azure, DigitalOcean or Cloudflare: plan, apply, verify, drift, upgrade, destroy',
    commands: [
      { label: 'New deployment', sub: 'Deployments', run(app) { const s = app.stateFor('deployments'); init(s); s.detail = null; s.wiz = newWiz(); app.render(); } },
      { label: 'Check drift on every deployment', sub: 'Deployments', run(app) { app.toast('Drift check queued for 5 deployments (cloud.drift).'); } }
    ],
    states: [
      { title: 'No deployments', tone: 'neutral', text: 'Nothing is deployed yet. The page explains plan, apply and verify and offers New deployment.', apply(ctx) { init(ctx.state); ctx.state.view = 'empty'; ctx.state.wiz = null; ctx.state.detail = null; ctx.rerender(); } },
      { title: 'Loading', tone: 'neutral', text: 'Deployments and their last verification load; rows show skeletons.', apply(ctx) { init(ctx.state); ctx.state.view = 'loading'; ctx.state.wiz = null; ctx.state.detail = null; ctx.rerender(); } },
      { title: 'Plan expired', tone: 'warn', text: 'The reviewed plan is older than 60 minutes or the observed state changed. Apply is disabled until the plan is made again.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.detail = null; st.wiz = newWiz(); st.wiz.step = 5; st.wiz.expired = true; ctx.rerender(); } },
      { title: 'Apply failed, rolled back', tone: 'danger', text: 'sandbox-ecs failed at step 7 (RDS StorageQuotaExceeded). Steps 8 to 12 never ran; the app tier was rolled back and the network kept for a retry.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.wiz = null; const d = st.deploys.find((x) => x.id === 'sandbox-ecs'); d.state = 'failed, rolled back'; st.detail = 'sandbox-ecs'; st.tab = 'operations'; ctx.rerender(); } },
      { title: 'Budget hard stop', tone: 'danger', text: 'do-team is at 103 % of its budget. The lab-do plan adds $214 a month and is refused with budget_exceeded; an override needs a second cloud admin.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.wiz = null; st.detail = 'lab-do'; st.tab = 'overview'; ctx.rerender(); } },
      { title: 'Drift detected', tone: 'warn', text: 'sg-0example1 on nw-prod-eu gained inbound 0.0.0.0/0 on port 22 out of band. Revert, adopt or ignore the field.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.wiz = null; st.driftResolved = null; st.deploys.find((x) => x.id === 'nw-prod-eu').drift = 1; st.detail = 'nw-prod-eu'; st.tab = 'drift'; ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'A cloud reader without cloud:deploy sees deployments read-only; New deployment, Upgrade and Destroy are disabled with the reason.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = 'readonly'; st.wiz = null; st.detail = null; ctx.rerender(); } },
      { title: 'Throttled, retrying', tone: 'warn', text: 'AWS answers ThrottlingException during the sandbox-ecs apply. The step waits with backoff (attempt 3 of 8) and carries on; nothing is created twice.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.wiz = null; st.throttled = true; const d = st.deploys.find((x) => x.id === 'sandbox-ecs'); d.state = 'applying'; st.detail = 'sandbox-ecs'; st.tab = 'operations'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; init(st);
      if (ctx.params.id) { if (st.deploys.some((d) => d.id === ctx.params.id)) { st.sel = ctx.params.id; st.detail = ctx.params.id; st.wiz = null; } delete ctx.params.id; }
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }
      const style = '<style>'
        + '.dep-steps{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:12px}.dep-steps span{display:inline-flex;align-items:center;gap:6px;padding:0 6px;height:26px;color:var(--muted);font-weight:500}.dep-steps .cur{color:var(--fg);font-weight:700}.dep-steps .done{color:var(--fg2)}.dep-steps .na{text-decoration:line-through}.dep-steps i{font-style:normal;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--line);font-size:11px}.dep-steps .cur i{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.dep-steps .done i{background:var(--fg2);color:var(--bg);border-color:var(--fg2)}.dep-steps .sep{color:var(--faint)}'
        + '.dep-tiles{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}.dep-tile{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);text-align:left;cursor:pointer;font-size:12px;color:var(--fg2)}.dep-tile b{font-size:13px;color:var(--fg)}.dep-tile.on{border-color:var(--accent);background:var(--accent-tint)}.dep-tile[disabled]{opacity:.6;cursor:not-allowed}'
        + '.dep-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}.dep-fb{display:flex;align-items:center;gap:8px;padding-top:10px;border-top:1px solid var(--line);flex-wrap:wrap}'
        + '</style>';
      const example = '<span class="muted" style="font-size:12px">Example data. IDs and prices are illustrative.</span>';
      const ro = st.view === 'readonly';

      if (st.wiz) { renderWizard(root, ctx, st, style, example); return; }
      if (st.detail) { renderDetail(root, ctx, st, style, example, ro); return; }

      const head = UI.pagehead('Deployments', 'Exprsn-AI itself on AWS, Azure, DigitalOcean or Cloudflare: plan, apply, verify, drift, upgrade, destroy', UI.btn('Check drift', { icon: 'refresh', attrs: 'data-drift-all', disabled: ro }) + UI.btn('New deployment', { kind: 'primary', icon: 'plus', attrs: 'data-new', disabled: ro, title: ro ? 'Needs cloud:deploy' : '' }));
      if (st.view === 'empty') {
        root.innerHTML = style + '<div class="page">' + head + UI.empty('No deployments yet', 'A deployment is Exprsn-AI with its database, cache, object store and front door in one cloud account. Exprsn-AI plans the resources, shows the cost and the diff, applies them through the provider APIs and verifies the result.', UI.btn('New deployment', { kind: 'primary', attrs: 'data-new' }))
          + '<div class="grid3">' + UI.panel('Plan', '<div class="fg2" style="font-size:12px">The desired resources against what the account has: create, update, replace, delete, with the monthly cost delta.</div>') + UI.panel('Apply', '<div class="fg2" style="font-size:12px">A journal of idempotent steps that survives a restart, within the provider\'s rate limits.</div>') + UI.panel('Verify and watch', '<div class="fg2" style="font-size:12px">/readyz, TLS and database checks after apply; drift checks every hour after that.</div>') + '</div>' + example + '</div>';
        ctx.on('click', '[data-new]', () => { st.wiz = newWiz(); ctx.rerender(); });
        return;
      }
      const loading = st.view === 'loading';
      const q = st.q.toLowerCase();
      const rows = st.deploys.filter((d) => !q || (d.id + ' ' + d.provider + ' ' + d.account + ' ' + d.region + ' ' + d.target).toLowerCase().includes(q));
      if (!rows.some((d) => d.id === st.sel) && rows.length) st.sel = rows[0].id;
      const sel = st.deploys.find((d) => d.id === st.sel);
      const drifted = st.deploys.filter((d) => d.drift > 0);
      const table = loading
        ? '<div class="tablewrap"><table class="dt"><tbody>' + [1, 2, 3, 4, 5].map(() => '<tr><td><div class="skeleton" style="width:110px"></div></td><td><div class="skeleton" style="width:160px"></div></td><td><div class="skeleton" style="width:200px"></div></td><td><div class="skeleton" style="width:80px"></div></td></tr>').join('') + '</tbody></table></div>'
        : UI.table(['Deployment', 'Account and region', 'Target', 'Data tier', 'Front door', 'Release', 'State', { label: 'Est. a month', right: true }, { label: 'September', right: true }], rows.map((d) => ({ cells: ['<span class="mono" style="font-weight:600">' + esc(d.id) + '</span>', '<span class="pill outline">' + esc(d.provider) + '</span> ' + esc(d.account) + '<div class="muted" style="font-size:11px">' + esc(d.region) + '</div>', esc(d.target), '<span style="font-size:12px">' + esc(d.data) + '</span>', '<span style="font-size:12px">' + esc(d.front) + '</span>', esc(d.release) + (d.upgrade ? ' ' + UI.pill(d.upgrade + ' available', 'info') : ''), statePill(d) + (d.drift ? ' ' + UI.pill('drift ' + d.drift, 'warn') : '') + (d.state === 'applying' ? '<div class="muted" style="font-size:11px">step ' + d.step + ' of 12</div>' : d.wait ? '<div class="muted" style="font-size:11px">' + esc(d.wait) + '</div>' : ''), '<span class="num">' + money(d.est) + '</span>', '<span class="num">' + money(d.mtd) + '</span>'], attrs: 'data-id="' + esc(d.id) + '"', selected: d.id === st.sel })), { minWidth: '1180px', emptyTitle: 'No deployments match', emptyText: 'Clear the filter.' });
      let insp = '';
      if (loading) insp = '<div class="skeleton" style="width:60%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div>';
      else if (sel) {
        insp = '<div class="hstack"><div class="eyebrow grow">Deployment</div>' + statePill(sel) + '</div><div class="dep-name">' + esc(sel.id) + '</div><a href="#" data-url style="font-size:12px">' + esc(sel.url) + '</a>'
          + UI.kv([['Account', '<a href="#" data-acct="' + esc(sel.account.split(' ')[0]) + '">' + esc(sel.account) + '</a>'], ['Region', esc(sel.region) + ' ' + UI.label(CEIL[sel.region] || 'internal', { sm: true })], ['Target', esc(sel.target)], ['Data tier', esc(sel.data)], ['Front door', esc(sel.front)], ['Release', esc(sel.release)], ['Estimate', money(sel.est) + ' a month'], ['September to date', money(sel.mtd)]], 1)
          + (sel.wait ? UI.notice(esc(sel.wait), sel.state === 'blocked' ? 'danger' : 'warn') : '') + (sel.drift ? UI.notice(sel.drift + ' resource drifted from the desired state.', 'warn') : '')
          + '<div class="hstack wrap gap6">' + UI.btn('Open deployment', { kind: 'primary', size: 'sm', attrs: 'data-open' }) + UI.btn('Cloud spend', { size: 'sm', attrs: 'data-go="finops"' }) + '</div>';
      }
      root.innerHTML = style + '<div class="page">' + head
        + (ro ? UI.notice('<b>Read-only: you need cloud:deploy.</b> Your role (FinOps analyst) grants cloud:read. New deployment, Upgrade and Destroy stay disabled; ask a cloud admin for the Cloud operator role.', 'danger', UI.btn('Back to the board view', { size: 'xs', attrs: 'data-reset' })) : '')
        + (drifted.length && !loading ? UI.notice('<b>Drift:</b> ' + drifted.map((d) => esc(d.id) + ' (' + d.drift + ')').join(', ') + '. Last drift check 09:00; next 10:00.', 'warn', UI.btn('Review', { size: 'xs', attrs: 'data-review-drift="' + esc(drifted[0].id) + '"' })) : '')
        + '<div class="toolbar">' + UI.search('Filter deployments', 'data-search', st.q) + '<span class="muted right" style="font-size:12px">' + rows.length + ' of ' + st.deploys.length + ' deployments · estimated ' + money(st.deploys.reduce((a, d) => a + d.est, 0)) + ' a month</span></div>'
        + table + example + '</div><aside class="inspector w360">' + insp + '</aside>';
      ctx.on('click', 'tr.row', (e, t) => { if (!t.dataset.id) return; if (st.sel === t.dataset.id) { st.detail = t.dataset.id; st.tab = 'overview'; } st.sel = t.dataset.id; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-open]', () => { st.detail = st.sel; st.tab = 'overview'; ctx.rerender(); });
      ctx.on('click', '[data-review-drift]', (e, t) => { st.detail = t.dataset.reviewDrift; st.tab = 'drift'; ctx.rerender(); });
      ctx.on('click', '[data-new]', () => { st.wiz = newWiz(); ctx.rerender(); });
      ctx.on('click', '[data-reset]', () => { st.view = null; ctx.rerender(); });
      ctx.on('click', '[data-drift-all]', () => ctx.toast('Drift check queued for 5 deployments. Results arrive as each account answers.'));
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-acct]', (e, t) => { e.preventDefault(); ctx.navigate('cloud', { id: t.dataset.acct }); });
      ctx.on('click', '[data-url]', (e) => { e.preventDefault(); ctx.toast('Opens ' + esc(sel.url) + ' in a new tab in the console.'); });
    }
  });

  // ---------------- detail ----------------
  function renderDetail(root, ctx, st, style, example, ro) {
    const d = st.deploys.find((x) => x.id === st.detail);
    if (!d) { st.detail = null; ctx.rerender(); return; }
    const res = RESOURCES[d.id] || SANDBOX_STEPS.map((s, i) => [s, i < d.step - 1 ? 'created' : 'not created', 'step ' + (i + 1), i < d.step - 1 ? 'in sync' : i === d.step - 1 ? (/failed/.test(d.state) ? 'failed' : 'creating') : 'planned']);
    const tabs = UI.tabs([{ id: 'overview', label: 'Overview' }, { id: 'resources', label: 'Resources', count: res.length }, { id: 'drift', label: 'Drift', count: d.drift }, { id: 'operations', label: 'Operations' }], st.tab);
    let body = '';
    if (st.tab === 'overview') {
      let notice = '';
      if (d.state === 'blocked') notice = '<div class="vstack gap6">' + UI.problem('Plan refused: budget_exceeded', 'do-team is at $4,120 of its $4,000 budget for September (103 %); the forecast is $4,420. This plan adds $214 a month, and plans that add cost are refused past 100 %. Scale-down and destroy still work.', 'a41c7e09b2d84f15c6e3a07b9d2f1e58') + '<div class="hstack gap6">' + UI.btn('Request override', { size: 'sm', attrs: 'data-override', disabled: ro }) + UI.btn('Open Cloud spend', { size: 'sm', kind: 'ghost', attrs: 'data-go="finops"' }) + '</div></div>';
      else if (d.state === 'plan ready') notice = UI.notice('<b>Plan ready, waiting.</b> The cf-edge token lacks Containers Edit, so the Cloudflare Containers step would fail. Add the permission, then apply. Cloudflare runs the app tier only: Postgres reaches it through Hyperdrive, Redis is a managed Valkey on aws-prod (Workers KV is not a substitute).', 'warn', UI.btn('Open cf-edge', { size: 'xs', attrs: 'data-acct="cf-edge"' }));
      else if (d.state === 'applying') notice = UI.notice('<b>Applying, step ' + d.step + ' of 12:</b> ' + esc(SANDBOX_STEPS[d.step - 1]) + ', about 9 minutes left.', 'info', UI.btn('Operations', { size: 'xs', attrs: 'data-tabgo="operations"' }));
      else if (/failed/.test(d.state)) notice = UI.notice('<b>Apply failed at step 7 and was rolled back.</b> RDS answered StorageQuotaExceeded. Steps 8 to 12 never ran; the network from steps 1 to 6 is kept so a retry starts at step 7.', 'danger', UI.btn('Retry from step 7', { size: 'xs', attrs: 'data-retry', disabled: ro }));
      else if (d.upgrade) notice = UI.notice('Release <b>' + esc(d.upgrade) + '</b> is available. The upgrade plan takes a database snapshot first, then rolls the app tier.', 'info', UI.btn('Plan upgrade', { size: 'xs', attrs: 'data-upgrade', disabled: ro }));
      const checks = /healthy/.test(d.state) ? [['/readyz over ' + d.url, 'ok'], ['Database reachable from the app', 'ok'], ['TLS chain valid, 71 days left', 'ok'], ['Redis reachable, BullMQ ready', 'ok'], ['Ollama instances healthy', d.id === 'nw-prod-eu' ? '2 of 2' : 'not in this deployment']] : [['/readyz', 'not yet'], ['Database', 'not yet'], ['TLS', 'not yet']];
      body = notice + '<div class="grid2">' + UI.panel('Deployment', UI.kv([['Account', '<a href="#" data-acct="' + esc(d.account.split(' ')[0]) + '">' + esc(d.account) + '</a>'], ['Region', esc(d.region) + ' ' + UI.label(CEIL[d.region] || 'internal', { sm: true })], ['Target', esc(d.target)], ['Data tier', esc(d.data) + ' <a href="#" data-go="cloud-data" style="font-size:12px">Cloud data</a>'], ['Front door', esc(d.front)], ['Release', esc(d.release)], ['Public URL', '<span class="mono">' + esc(d.url) + '</span>'], ['Cost', money(d.est) + ' a month estimated, ' + money(d.mtd) + ' in September']], 2))
        + UI.panel('Verification', UI.table(['Check', 'Result'], checks.map((c) => [esc(c[0]), UI.pill(c[1], c[1] === 'ok' || /of/.test(c[1]) ? 'ok' : '')]), { clickable: false, minWidth: '0', cls: 'bare' }) + '<span class="muted" style="font-size:12px">Last verified 09:02 (B-10105).</span>') + '</div>';
    } else if (st.tab === 'resources') {
      body = UI.table(['Resource', 'Provider id', 'Kind', 'State'], res.map((r) => [esc(r[0]) + (r[4] ? ' <a href="#" data-go="' + r[4] + '" style="font-size:12px">open</a>' : ''), '<span class="mono" style="font-size:12px">' + esc(r[1]) + '</span>', esc(r[2]), UI.pill(r[3] === 'drifted' && st.driftResolved ? 'in sync' : r[3], r[3] === 'in sync' ? 'ok' : r[3] === 'drifted' && !st.driftResolved ? 'warn' : r[3] === 'failed' ? 'danger' : r[3] === 'creating' ? 'info' : '')]), { clickable: false, minWidth: '760px' })
        + '<span class="muted" style="font-size:12px">' + (d.id === 'nw-prod-eu' ? '14 of 31 resources shown, grouped. ' : '') + 'Every resource carries the tags exprsn:managed, exprsn:deployment=' + esc(d.id) + ' and exprsn:account.</span>';
    } else if (st.tab === 'drift') {
      if (d.drift && !st.driftResolved) {
        body = UI.notice('<b>sg-0example1</b> gained an inbound rule out of band: TCP 22 from 0.0.0.0/0. It exposes SSH on the app nodes to the internet.', 'warn')
          + UI.table(['Resource', 'Field', 'Desired', 'Observed', 'Changed by'], [['<span class="mono">sg-0example1</span>', 'ingress', 'TCP 443 from the load balancer only', '<span style="color:var(--warn-fg)">+ TCP 22 from 0.0.0.0/0</span>', 'IAM user ops-break-glass, 27 Sep 22:14 (CloudTrail AuthorizeSecurityGroupIngress, event 1b2c…example)']], { clickable: false, minWidth: '820px' })
          + '<div class="hstack wrap gap6">' + UI.btn('Revert to desired', { kind: 'primary', size: 'sm', attrs: 'data-drift="revert"', disabled: ro }) + UI.btn('Adopt as desired', { size: 'sm', attrs: 'data-drift="adopt"', disabled: ro }) + UI.btn('Ignore this field', { size: 'sm', kind: 'ghost', attrs: 'data-drift="ignore"', disabled: ro }) + '</div>'
          + '<span class="muted" style="font-size:12px">Revert makes a plan that removes the rule. Adopt writes the observed rule into the desired state. Ignore stops reporting this field (B-10106).</span>';
      } else body = UI.empty('No drift', st.driftResolved ? 'Drift ' + st.driftResolved + '. The next check runs at 10:00.' : 'Every managed resource matches its desired state. Last check 09:00.');
    } else {
      const journal = d.id === 'sandbox-ecs'
        ? SANDBOX_STEPS.map((s, i) => { const failed = /failed/.test(d.state); const done = i < d.step - 1; const cur = i === d.step - 1; return { title: (i + 1) + '. ' + esc(s), text: done ? 'done' : cur ? (failed ? 'failed: StorageQuotaExceeded (request 6d2e…example); app tier rolled back' : st.throttled ? 'throttled: ThrottlingException, retry in 4 s, attempt 3 of 8' : 'running, about 9 minutes left') : failed ? 'not run' : 'waiting', meta: done ? 'idempotency key sandbox-ecs/' + (i + 1) + '/a1' : cur ? 'client token sandbox-ecs/7/a1 · attempt ' + (st.throttled ? 3 : 1) : '', tone: done ? 'ok' : cur ? (failed ? 'danger' : 'info') : '' }; })
        : [{ title: 'cloud.drift check', text: d.drift && !st.driftResolved ? '1 field drifted on sg-0example1' : 'no drift', meta: '28 Sep 09:00 · 31 reads, 0 throttled', tone: d.drift && !st.driftResolved ? 'warn' : 'ok' }, { title: 'cloud.verify', text: 'all checks passed', meta: '28 Sep 09:02', tone: 'ok' }, { title: 'cloud.apply upgrade 1.6.0 → 2.0.0', text: '27 steps, 0 retries', meta: '21 Sep 07:10 to 07:52 · Mara Okafor, approved by Jonas Lindqvist', tone: 'ok' }, { title: 'cloud.plan', text: '4 create, 6 update, 0 replace, 0 delete', meta: '21 Sep 07:02', tone: 'ok' }];
      body = (st.throttled && d.id === 'sandbox-ecs' ? UI.notice('<b>AWS is throttling this account.</b> The step waits with backoff and jitter and carries on; the client token makes the retry safe (B-10108).', 'warn') : '') + UI.panel('Operation journal', UI.timeline(journal)) + (d.state === 'applying' ? '<div>' + UI.btn('Cancel after the current step', { size: 'sm', attrs: 'data-cancel-apply', disabled: ro }) + '</div>' : '');
    }
    root.innerHTML = style + '<div class="page">' + UI.pagehead(d.id, statePill(d) + ' <span class="pill outline">' + esc(d.provider) + '</span> ' + esc(d.account) + ', ' + esc(d.region), UI.btn('All deployments', { attrs: 'data-back' }) + (d.upgrade ? UI.btn('Upgrade to ' + d.upgrade, { attrs: 'data-upgrade', disabled: ro, title: ro ? 'Needs cloud:deploy' : '' }) : '') + (d.state === 'plan ready' ? UI.btn('Apply plan', { kind: 'primary', attrs: 'data-apply-ready', disabled: ro }) : '') + UI.btn('Destroy', { kind: 'danger', attrs: 'data-destroy', disabled: ro, title: ro ? 'Needs cloud:deploy' : '' }))
      + (ro ? UI.notice('Read-only: you need cloud:deploy to change this deployment.', 'danger') : '') + tabs + body + example + '</div>';
    ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
    ctx.on('click', '[data-tabgo]', (e, t) => { st.tab = t.dataset.tabgo; ctx.rerender(); });
    ctx.on('click', '[data-back]', () => { st.detail = null; ctx.rerender(); });
    ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
    ctx.on('click', '[data-acct]', (e, t) => { e.preventDefault(); ctx.navigate('cloud', { id: t.dataset.acct }); });
    ctx.on('click', '[data-retry]', () => { d.state = 'applying'; d.step = 7; ctx.rerender(); ctx.toast('Retry from step 7 queued. Steps 1 to 6 are kept.', 'ok'); });
    ctx.on('click', '[data-cancel-apply]', async () => { const ok = await ctx.confirm({ title: 'Cancel the apply', tag: 'cancel', tone: 'warn', body: '<p class="fg2" style="margin:0">The running step finishes; later steps do not start. Resources already created stay and the deployment shows as partial.</p>', ok: 'Cancel after step ' + d.step }); if (!ok) return; d.state = 'cancelled, partial'; ctx.rerender(); ctx.toast('Apply stops after step ' + d.step + '.', 'warn'); });
    ctx.on('click', '[data-apply-ready]', () => ctx.toast('Apply refused: the cf-edge token lacks Containers Edit. Fix the token on Cloud accounts first.', 'danger', 5000));
    ctx.on('click', '[data-drift]', async (e, t) => {
      const kind = t.dataset.drift;
      const text = { revert: 'A plan removes the inbound rule from sg-0example1 and applies at once. SSH access from the internet ends.', adopt: 'The rule becomes part of the desired state. SSH stays open to the internet on the app nodes; this is recorded with your reason.', ignore: 'Drift checks stop reporting the ingress field of sg-0example1. Other fields are still checked.' }[kind];
      const ok = await ctx.confirm({ title: { revert: 'Revert drift', adopt: 'Adopt drift', ignore: 'Ignore this field' }[kind], tag: kind, tone: kind === 'revert' ? 'info' : 'warn', body: '<p class="fg2" style="margin:0">' + text + '</p>' + (kind !== 'revert' ? UI.field('Reason', UI.input('', { placeholder: 'Recorded in the audit chain' })) : ''), ok: { revert: 'Revert', adopt: 'Adopt', ignore: 'Ignore field' }[kind] });
      if (!ok) return;
      d.drift = 0; st.driftResolved = { revert: 'reverted at 09:41 by Mara Okafor', adopt: 'adopted at 09:41 by Mara Okafor', ignore: 'ignored for the ingress field at 09:41' }[kind]; ctx.rerender();
      ctx.toast({ revert: 'Inbound TCP 22 removed from sg-0example1. Audit entry cloud.drift.reverted.', adopt: 'Observed rule adopted into the desired state. Audit entry cloud.drift.adopted.', ignore: 'The ingress field of sg-0example1 is ignored by drift checks.' }[kind], kind === 'revert' ? 'ok' : 'warn', 5000);
    });
    ctx.on('click', '[data-override]', () => ctx.modal({ title: 'Request a budget override for do-team', body: '<p class="fg2" style="margin:0">An override lets plans that add cost apply for a limited time. A second cloud admin approves it.</p>' + UI.field('Reason', UI.textarea('', { placeholder: 'Why this cannot wait for October', rows: 3 })) + UI.field('Valid for', UI.select(['1 day', '3 days', '7 days (maximum)'], '3 days')) + UI.field('Extra monthly spend allowed', UI.input('$214')), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send to a second admin', { kind: 'primary', attrs: 'data-send' }), onMount(m) { m.querySelector('[data-send]').addEventListener('click', () => { App.closeOverlay(); d.wait = 'override requested, waiting for Jonas Lindqvist'; ctx.rerender(); ctx.toast('Override request sent to Jonas Lindqvist.', 'ok'); }); } }));
    ctx.on('click', '[data-upgrade]', () => ctx.modal({ title: 'Upgrade ' + esc(d.id) + ' to ' + esc(d.upgrade), cls: 'wide', body: '<div class="stats">' + UI.stat('31', 'resources') + UI.stat('4', 'create') + UI.stat('3', 'update') + UI.stat('1', 'replace') + UI.stat('0', 'delete') + UI.stat('+$412', 'a month') + '</div>'
      + UI.table(['Change', 'Resource', 'Detail', { label: 'Cost', right: true }], UPGRADE_ROWS.map((r) => [kindPill(r[0]), esc(r[1]), esc(r[2]), '<span class="num">' + esc(r[3]) + '</span>']), { clickable: false, minWidth: '0' })
      + '<span class="muted" style="font-size:12px">23 resources unchanged. The plan expires at 10:41 or when the observed state changes.</span>'
      + UI.check('Take an Aurora snapshot before the migration (recommended)', true) + UI.notice('The app tier rolls back automatically when verification fails. The database rolls back only by restoring the snapshot, which needs a second cloud admin.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Apply upgrade', { kind: 'primary', attrs: 'data-go-up' }),
      onMount(m) { m.querySelector('[data-go-up]').addEventListener('click', () => { App.closeOverlay(); d.state = 'upgrading'; d.release = '2.0.0 → ' + d.upgrade; d.upgrade = null; st.tab = 'operations'; ctx.rerender(); ctx.toast('Upgrade to 2.0.1 started. Snapshot first, then the migration job and a rolling update.', 'ok', 5000); }); } }));
    ctx.on('click', '[data-destroy]', () => {
      const prot = (RESOURCES[d.id] || []).filter((r) => /protected/.test(r[0]) || r[2] === 'database');
      ctx.modal({ title: 'Destroy ' + esc(d.id) + ' ' + UI.pill('destructive', 'danger'), body: '<p class="fg2" style="margin:0">Every resource tagged exprsn:deployment=' + esc(d.id) + ' is deleted in reverse dependency order. Users lose access at once.</p>'
        + (prot.length ? UI.notice('Protected data: ' + prot.map((r) => '<b>' + esc(r[1]) + '</b>').join(', ') + '. A final snapshot is taken and kept 30 days; a second cloud admin must approve.', 'warn') : '')
        + UI.field('Type the deployment name to confirm', UI.input('', { placeholder: d.id, attrs: 'data-typed' })),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(prot.length ? 'Propose destroy' : 'Destroy', { kind: 'danger', attrs: 'data-do', disabled: true }),
        onMount(m) {
          const inp = m.querySelector('[data-typed]'), btn = m.querySelector('[data-do]');
          inp.addEventListener('input', () => { btn.disabled = inp.value.trim() !== d.id; });
          btn.addEventListener('click', () => { App.closeOverlay(); d.state = prot.length ? 'destroy pending approval' : 'destroying'; ctx.rerender(); ctx.toast(prot.length ? 'Destroy proposed. Jonas Lindqvist or another cloud admin must approve; final snapshots are taken first.' : 'Destroy started. Resources are deleted in reverse order.', 'warn', 5000); });
        } });
    });
  }

  // ---------------- new deployment wizard ----------------
  function renderWizard(root, ctx, st, style, example) {
    const w = st.wiz;
    const STEPS = ['Target', 'Compute', 'Data', 'Front door', 'Review', 'Apply'];
    const onprem = w.provider === 'On-prem', cf = w.provider === 'Cloudflare';
    const na = (i) => onprem && (i === 2 || i === 3);
    const steps = '<div class="dep-steps">' + STEPS.map((s, i) => '<span class="' + (i + 1 === w.step ? 'cur' : i + 1 < w.step ? 'done' : '') + (na(i + 1) ? ' na' : '') + '"><i>' + (i + 1) + '</i>' + s + '</span>' + (i < STEPS.length - 1 ? '<span class="sep">›</span>' : '')).join('') + '</div>';
    const sz = w.size;
    const lines = [];
    if (!onprem) {
      lines.push([cf ? 'Cloudflare Containers, 3 instances, Workers static assets' : COMPUTE[w.provider][w.compute] + ', ' + SIZES[sz], BASE[cf ? 'cfc' : w.compute][sz]]);
      if (!cf) lines.push(['Network: VPC, subnets, NAT, firewall', NET[sz]]);
      lines.push([(cf ? 'Aurora PostgreSQL 17 on aws-prod, reached through Hyperdrive' : 'Managed PostgreSQL 17') + (w.db === 'new' ? '' : ' (existing, no new cost)'), w.db === 'new' ? DB[sz] : 0]);
      lines.push([(cf ? 'ElastiCache Valkey on aws-prod (required; Workers KV is not a substitute)' : 'Managed Redis or Valkey') + (w.cache === 'new' ? '' : ' (existing)'), w.cache === 'new' ? CACHE[sz] : 0]);
      lines.push([cf ? 'R2 bucket, EU jurisdiction' : 'Object store', STORE[sz]]);
    }
    if (w.front === 'cloudflare') lines.push(['Cloudflare front door: DNS, Tunnel, WAF' + (w.access ? ', Access' : ''), w.access ? 32 : 25]);
    const total = lines.reduce((a, l) => a + l[1], 0);
    const budgetStop = w.account === 'do-team';
    let body = '';
    if (w.step === 1) {
      const provs = ['AWS', 'Azure', 'DigitalOcean', 'Cloudflare', 'On-prem'];
      const blurb = { AWS: 'EKS, EC2 or ECS Fargate with RDS, Aurora, ElastiCache, S3', Azure: 'AKS, VMs or Container Apps with Flexible Server, Azure Cache, Blob', DigitalOcean: 'DOKS, Droplets or App Platform with managed databases and Spaces', Cloudflare: 'App tier on Cloudflare Containers; data and GPUs on another provider (hybrid)', 'On-prem': 'Exprsn-AI already runs in your data centre: add a front door only' };
      body = '<div class="dep-tiles">' + provs.map((p) => '<button type="button" class="dep-tile' + (w.provider === p ? ' on' : '') + '" data-prov="' + p + '"><b>' + esc(p) + '</b><span>' + esc(blurb[p]) + '</span></button>').join('') + '</div>'
        + '<div class="formgrid" style="--cols:3">' + UI.field('Deployment name', UI.input(w.name, { attrs: 'data-f="name"' })) + UI.field(onprem ? 'Site' : 'Cloud account', UI.select(ACCOUNTS[w.provider], w.account, 'data-f="account"')) + UI.field('Region', UI.select(REGIONS[w.account] || [], w.region, 'data-f="region"'), 'Label ceiling here: ' + UI.label(CEIL[w.region] || 'internal', { sm: true })) + '</div>'
        + (budgetStop ? UI.notice('do-team is over its September budget. You can plan, but a plan that adds cost will be refused at Review.', 'warn') : '')
        + (cf ? UI.notice('A Cloudflare deployment is always hybrid. The app tier runs on Cloudflare Containers with the console\'s static assets on Workers; Postgres, Redis and GPUs run on AWS, Azure, DigitalOcean or on-prem.', 'info') : '');
    } else if (w.step === 2) {
      if (onprem) body = UI.notice('Not applicable: the app tier already runs on-prem.', 'info');
      else if (cf) body = '<div class="dep-tiles"><button type="button" class="dep-tile on"><b>Cloudflare Containers</b><span>The Exprsn-AI image, 3 instances behind a Worker; static assets on Workers static assets.</span></button>'
        + ['Kubernetes', 'Virtual machines', 'GPU pool for Ollama'].map((t) => '<button type="button" class="dep-tile" disabled title="' + esc(CF_REASON) + '"><b>' + esc(t) + '</b><span>' + esc(CF_REASON) + '</span></button>').join('') + '</div>'
        + UI.field('Size', UI.seg(SIZES.map((s, i) => ({ id: String(i), label: s })), String(w.size), 'data-size'));
      else body = '<div class="dep-tiles">' + [['k8s', 'Kubernetes', 'Helm chart on a new cluster; best for several replicas and GPU node groups'], ['vm', 'Virtual machines', 'The bare-metal installer from a signed release, under systemd'], ['containers', 'Container platform', 'Managed containers; migrations run as a one-off task']].map((c) => '<button type="button" class="dep-tile' + (w.compute === c[0] ? ' on' : '') + '" data-compute="' + c[0] + '"><b>' + esc(c[1]) + '</b><span class="mono" style="font-size:11px">' + esc(COMPUTE[w.provider][c[0]]) + '</span><span>' + esc(c[2]) + '</span></button>').join('') + '</div>'
        + UI.field('Size', UI.seg(SIZES.map((s, i) => ({ id: String(i), label: s })), String(w.size), 'data-size'), 'Small: 1 replica. Medium: 2 replicas. Large-HA: 3 replicas across zones, HA database')
        + '<span class="muted" style="font-size:12px">GPU pools are added on <a href="#" data-go="cloud-compute">Cloud compute</a> once the deployment is healthy.</span>';
    } else if (w.step === 3) {
      if (onprem) body = UI.notice('Not applicable: the database, cache and object store stay where they are.', 'info');
      else {
        const modes = (key) => UI.seg([{ id: 'new', label: 'Provision new' }, { id: 'existing', label: 'Use existing' }, { id: 'onprem', label: 'On-prem' }], w[key], 'data-mode="' + key + '"');
        body = (cf ? '<div class="dep-tiles">' + ['PostgreSQL on Cloudflare', 'Redis on Cloudflare', 'GPUs on Cloudflare'].map((t) => '<button type="button" class="dep-tile" disabled title="' + esc(CF_REASON) + '"><b>' + esc(t) + '</b><span>' + esc(CF_REASON) + '</span></button>').join('') + '</div>' + UI.field('Provider for data', UI.select(['aws-prod (eu-central-1)', 'azure-eu (swedencentral)', 'do-team (fra1)', 'on-prem (northwind-dc1, through Tunnel)'], 'aws-prod (eu-central-1)')) : '')
          + UI.table(['Tier', 'Choice', 'What'], [
            ['Database', modes('db'), cf ? 'Aurora PostgreSQL 17 with pgvector, reached through Hyperdrive' : w.provider === 'AWS' ? 'Aurora PostgreSQL 17 with pgvector' : w.provider === 'Azure' ? 'PostgreSQL Flexible Server 17, pgvector allow-listed' : 'Managed PostgreSQL 17 with pgvector'],
            ['Cache (REDIS_URL)', modes('cache'), cf ? 'ElastiCache Valkey 8, TLS with AUTH and an IP allow list; required' : w.provider === 'AWS' ? 'ElastiCache Valkey 8, cluster mode off' : w.provider === 'Azure' ? 'Azure Cache for Redis' : 'Managed Valkey'],
            ['Object store', modes('store'), cf ? 'R2, EU jurisdiction (BLOB_STORE=s3)' : w.provider === 'AWS' ? 'S3' : w.provider === 'Azure' ? 'Blob storage (BLOB_STORE=azure)' : 'Spaces (S3 compatible)']
          ], { clickable: false, minWidth: '0' }) + '<span class="muted" style="font-size:12px">Provisioned databases get deletion protection and 14 days of backups. Manage them on <a href="#" data-go="cloud-data">Cloud data</a>.</span>';
      }
    } else if (w.step === 4) {
      if (cf) body = UI.notice('Cloudflare deployments use the Cloudflare front door: DNS, edge TLS, WAF and rate-limit rules are part of the deployment.', 'info') + UI.field('Hostname', UI.input(w.host, { attrs: 'data-f="host"' })) + UI.toggle('Cloudflare Access before the admin console', w.access, 'data-access data-manual');
      else body = '<div class="dep-tiles">' + [['cloudflare', 'Cloudflare', 'DNS and edge TLS, Tunnel (cloudflared, no inbound ports), WAF and rate-limit rules, optional Access'], ['acme', 'ACME and provider DNS', w.provider === 'AWS' ? 'Route 53 and dns-01 with the existing ACME client' : w.provider === 'Azure' ? 'Azure DNS and dns-01' : w.provider === 'DigitalOcean' ? 'DigitalOcean DNS and dns-01' : 'Your DNS, http-01 or dns-01'], ['byo', 'Bring your own', 'Your load balancer and certificates; Exprsn-AI only checks the URL']].map((f) => '<button type="button" class="dep-tile' + (w.front === f[0] ? ' on' : '') + '" data-front="' + f[0] + '"><b>' + esc(f[1]) + '</b><span>' + esc(f[2]) + '</span></button>').join('') + '</div>'
        + UI.field('Hostname', UI.input(w.host, { attrs: 'data-f="host"' }))
        + (w.front === 'cloudflare' ? UI.toggle('Cloudflare Access before the admin console', w.access, 'data-access data-manual') + UI.notice('Access is an extra layer. Exprsn-AI sign-in stays authoritative, and /v1, the OIDC and SAML endpoints, /.well-known and public share links bypass Access so clients and federation keep working.', 'info') : '');
    } else if (w.step === 5) {
      const n = lines.length;
      const creates = onprem ? 4 : cf ? 9 : w.compute === 'k8s' ? 22 : w.compute === 'vm' ? 14 : 12;
      body = (w.expired ? UI.notice('<b>This plan expired.</b> It is older than 60 minutes or the observed state changed. Make it again before applying.', 'warn', UI.btn('Plan again', { size: 'xs', attrs: 'data-replan' })) : '')
        + (budgetStop ? UI.problem('Plan refused: budget_exceeded', 'do-team is at 103 % of its September budget. This plan adds ' + money(total) + ' a month. Remove resources, wait for October or request an override.', 'c2e8a41f07b93d56e1a4c08f7b2d9e31') : '')
        + '<div class="grid2">' + UI.panel('Cost estimate', UI.table(['Item', { label: 'A month', right: true }], lines.map((l) => [esc(l[0]), '<span class="num">' + money(l[1]) + '</span>']).concat([['<b>Total</b>', '<b class="num">' + money(total) + '</b>']]), { clickable: false, minWidth: '0', cls: 'bare' }) + '<span class="muted" style="font-size:12px">From the provider price lists, cached 28 Sep 06:00; 730 hours, 100 GB egress assumed (B-10601).</span>')
        + UI.panel('Plan', '<div class="stats">' + UI.stat(String(creates), 'create') + UI.stat('0', 'update') + UI.stat('0', 'replace') + UI.stat('0', 'delete') + '</div>' + UI.table(['Change', 'Resource'], (onprem ? ['Cloudflare Tunnel and connector config', 'DNS record ' + w.host, 'WAF and rate-limit rules', 'Access app for the admin console'] : cf ? ['Container app exprsn-ai (3 instances)', 'Worker with static assets', 'Hyperdrive config', 'Aurora cluster ' + w.name + '-aurora', 'ElastiCache Valkey ' + w.name + '-valkey', 'R2 bucket ' + w.name + '-blobs', 'DNS record ' + w.host, 'WAF rules', 'Access app'] : ['Network: VPC, subnets, NAT, firewall', COMPUTE[w.provider][w.compute], 'Database ' + w.name + '-pg', 'Cache ' + w.name + '-cache', 'Object store ' + w.name + '-blobs', w.front === 'cloudflare' ? 'Cloudflare Tunnel, DNS, WAF' : 'DNS record and certificate']).map((r) => [kindPill('create'), esc(r)]), { clickable: false, minWidth: '0', cls: 'bare' }) + '<span class="muted" style="font-size:12px">' + n + ' cost lines, ' + creates + ' resources. Plan hash 3f9c…example, valid until 10:40.</span>') + '</div>';
    } else {
      const done = w.applyAt || 0;
      const list = onprem ? ['Tunnel created', 'Connector config sealed into the vault', 'DNS record', 'WAF rules', 'Access app', 'Verify'] : cf ? ['Aurora cluster (aws-prod)', 'ElastiCache Valkey (aws-prod)', 'R2 bucket', 'Hyperdrive config', 'Container app', 'Worker and static assets', 'DNS, WAF, Access', 'Verify'] : ['Network', 'Object store', 'Cache', 'Database', COMPUTE[w.provider][w.compute], 'Migrations', 'Front door', 'Verify'];
      body = UI.panel('Applying ' + esc(w.name), UI.timeline(list.map((s, i) => ({ title: (i + 1) + '. ' + esc(s), text: i < done ? 'done' : i === done ? 'running' : 'waiting', meta: i < done ? 'journal entry ' + esc(w.name) + '/' + (i + 1) : '', tone: i < done ? 'ok' : i === done ? 'info' : '' }))))
        + '<span class="muted" style="font-size:12px">The apply runs as the cloud.apply job; you can leave this page. Each step is idempotent and survives a restart (B-10104).</span>';
    }
    let foot = '';
    if (w.step < 5) foot = (w.step > 1 ? UI.btn('Back', { size: 'sm', attrs: 'data-back' }) : UI.btn('Back', { size: 'sm', disabled: true })) + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-cancel' }) + '<span class="grow"></span><span class="muted" style="font-size:12px">Estimate ' + money(total) + ' a month</span>' + UI.btn('Next', { kind: 'primary', size: 'sm', attrs: 'data-next' });
    else if (w.step === 5) foot = UI.btn('Back', { size: 'sm', attrs: 'data-back' }) + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-cancel' }) + '<span class="grow"></span>' + (budgetStop ? UI.btn('Request override', { size: 'sm', attrs: 'data-override-w' }) : '') + UI.btn('Apply', { kind: 'primary', size: 'sm', attrs: 'data-apply', disabled: budgetStop || w.expired, title: budgetStop ? 'budget_exceeded' : w.expired ? 'Plan expired' : '' });
    else foot = '<span class="grow"></span>' + UI.btn('Advance one step', { size: 'sm', attrs: 'data-advance' }) + UI.btn('Back to deployments', { kind: 'primary', size: 'sm', attrs: 'data-finish' });
    root.innerHTML = style + '<div class="page">' + UI.pagehead('New deployment', 'Step ' + w.step + ' of 6, ' + esc(STEPS[w.step - 1]) + ' · ' + esc(w.provider), w.step < 6 ? UI.btn('Cancel', { kind: 'ghost', attrs: 'data-cancel' }) : '')
      + steps + UI.panel('Step ' + w.step + ' of 6', body + '<div class="dep-fb">' + foot + '</div>') + example + '</div>';

    const skip = (dir) => { w.step += dir; if (onprem && (w.step === 2 || w.step === 3)) w.step = dir > 0 ? 4 : 1; };
    ctx.on('click', '[data-prov]', (e, t) => { w.provider = t.dataset.prov; w.account = ACCOUNTS[w.provider][0]; w.region = REGIONS[w.account][0]; w.front = w.provider === 'Cloudflare' || w.provider === 'On-prem' ? 'cloudflare' : w.front; w.compute = 'k8s'; ctx.rerender(); });
    ctx.on('change', '[data-f="account"]', (e, t) => { w.account = t.value; w.region = REGIONS[w.account][0]; ctx.rerender(); });
    ctx.on('change', '[data-f="region"]', (e, t) => { w.region = t.value; ctx.rerender(); });
    ctx.on('input', '[data-f="name"]', (e, t) => { w.name = t.value.trim() || w.name; });
    ctx.on('input', '[data-f="host"]', (e, t) => { w.host = t.value.trim() || w.host; });
    ctx.on('click', '[data-compute]', (e, t) => { w.compute = t.dataset.compute; ctx.rerender(); });
    ctx.on('click', '[data-size] [data-seg]', (e, t) => { w.size = +t.dataset.seg; ctx.rerender(); });
    ctx.on('click', '[data-mode] [data-seg]', (e, t) => { w[t.closest('[data-mode]').dataset.mode] = t.dataset.seg; ctx.rerender(); });
    ctx.on('click', '[data-front]', (e, t) => { w.front = t.dataset.front; ctx.rerender(); });
    ctx.on('click', '[data-access]', () => { w.access = !w.access; ctx.rerender(); });
    ctx.on('click', '.dep-tile[disabled]', () => ctx.toast(esc(CF_REASON) + '.', 'warn'));
    ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
    ctx.on('click', '[data-next]', () => { skip(1); ctx.rerender(); });
    ctx.on('click', '[data-back]', () => { skip(-1); ctx.rerender(); });
    ctx.on('click', '[data-cancel]', () => { st.wiz = null; ctx.rerender(); });
    ctx.on('click', '[data-replan]', () => { w.expired = false; ctx.rerender(); ctx.toast('Plan made again against the observed state. Nothing changed; valid until 10:40.', 'ok'); });
    ctx.on('click', '[data-override-w]', () => ctx.toast('Override request sent to Jonas Lindqvist. The plan applies once it is approved.', 'ok'));
    ctx.on('click', '[data-apply]', async () => {
      const ok = await ctx.confirm({ title: 'Apply ' + w.name, tag: 'apply', tone: 'info', body: '<p class="fg2" style="margin:0">Exprsn-AI creates the resources in the plan through the provider APIs and verifies the result. Cancelling later stops after the running step.</p>', kv: [['Account', esc(w.account)], ['Region', esc(w.region)], ['Estimate', money(total) + ' a month'], ['Plan', '3f9c…example']], ok: 'Apply' });
      if (!ok) return;
      w.step = 6; w.applyAt = 1;
      if (!st.deploys.some((d) => d.id === w.name)) st.deploys.push({ id: w.name, provider: w.provider, account: w.account, region: w.region, target: onprem ? 'front door only' : cf ? 'Cloudflare Containers (3)' : COMPUTE[w.provider][w.compute] + ', ' + SIZES[w.size], data: onprem ? 'on-prem, unchanged' : cf ? 'Hyperdrive to Aurora (aws-prod), Valkey, R2' : 'new managed database, cache and object store', front: w.front === 'cloudflare' ? 'Cloudflare DNS, Tunnel, WAF' + (w.access ? ', Access' : '') : w.front === 'acme' ? 'ACME, provider DNS' : 'your own', release: '2.0.0', state: 'applying', step: 1, drift: 0, est: total, mtd: 0, url: 'https://' + w.host });
      ctx.rerender(); ctx.toast('Apply started for <b>' + esc(w.name) + '</b>.', 'ok');
    });
    ctx.on('click', '[data-advance]', () => { w.applyAt = Math.min((w.applyAt || 0) + 1, 8); ctx.rerender(); });
    ctx.on('click', '[data-finish]', () => { st.sel = w.name; st.wiz = null; ctx.rerender(); });
  }
})();
