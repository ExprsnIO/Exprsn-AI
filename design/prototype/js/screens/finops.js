(function () {
  const { UI, esc } = App;

  // ---- nav entry (app.js untouched): after the last cloud screen present, otherwise before Zones ----
  (function nav() {
    const admin = (App.NAV || []).find((g) => g.group === 'Admin'); if (!admin || admin.items.some((i) => i.id === 'finops')) return;
    const item = { id: 'finops', label: 'Cloud spend', icon: 'calc' };
    for (const prev of ['cloud-compute', 'cloud-data', 'deployments', 'cloud']) { const k = admin.items.findIndex((i) => i.id === prev); if (k >= 0) { admin.items.splice(k + 1, 0, item); return; } }
    const z = admin.items.findIndex((i) => i.id === 'zones'); if (z >= 0) admin.items.splice(z, 0, item); else admin.items.push(item);
  })();

  // ---- example data (Northwind, Monday 28 Sep 2026 09:40 UTC; month to date = September) ----
  const PROVIDERS = [
    { id: 'aws', name: 'AWS', fill: 'var(--accent)', total: 11250 },
    { id: 'azure', name: 'Azure', fill: 'var(--info-fg)', total: 7670 },
    { id: 'do', name: 'DigitalOcean', fill: 'var(--ok-fg)', total: 4120 },
    { id: 'cf', name: 'Cloudflare', fill: 'var(--warn-fg)', total: 310 }
  ];
  const ACCOUNTS0 = () => [
    { id: 'aws-prod', provider: 'AWS', scope: 'platform', budget: 18000, mtd: 9840, forecast: 10600, sent: { a50: '16 Sep' }, hardStop: false, recipients: 'Cloud admins, finops@northwind-example.com', top: [['Amazon EKS and EC2 (nw-prod-eu)', 4310], ['Amazon Aurora (nw-prod-aurora)', 2180], ['EC2 GPU, gpu-cloud-eu', 1640], ['NAT gateway data processing', 980], ['Amazon Bedrock tokens', 730]] },
    { id: 'aws-sandbox', provider: 'AWS', scope: 'platform', budget: 1500, mtd: 1410, forecast: 1690, sent: { a50: '9 Sep', a80: '19 Sep', f100: '24 Sep' }, hardStop: true, recipients: 'Cloud admins', top: [['Amazon ECS Fargate (sandbox-ecs)', 520], ['Amazon RDS', 410], ['EC2 test instances', 330], ['Other', 150]] },
    { id: 'azure-eu', provider: 'Azure', scope: 'platform', budget: 12000, mtd: 7050, forecast: 7600, sent: { a50: '18 Sep' }, hardStop: false, recipients: 'Cloud admins, finops@northwind-example.com', top: [['Virtual machines (nw-dr-azure)', 1640], ['Azure OpenAI tokens', 1980], ['AKS GPU, gpu-azure-se', 1510], ['PostgreSQL Flexible Server', 1210], ['Other', 710]] },
    { id: 'do-team', provider: 'DigitalOcean', scope: 'platform', budget: 4000, mtd: 4120, forecast: 4420, sent: { a50: '11 Sep', a80: '20 Sep', a100: '26 Sep' }, hardStop: true, stopSince: '26 Sep', recipients: 'Cloud admins, finops@northwind-example.com', top: [['GPU Droplets, gpu-do-h100', 2440], ['Managed MySQL (partner-mysql)', 610], ['GenAI serverless inference', 420], ['Spaces and bandwidth', 380], ['Other', 270]] },
    { id: 'cf-edge', provider: 'Cloudflare', scope: 'platform', budget: 1200, mtd: 310, forecast: 340, sent: {}, hardStop: true, recipients: 'Cloud admins', top: [['Workers AI neurons', 140], ['R2 storage and operations', 96], ['Workers paid plan', 50], ['Other', 24]] },
    { id: 'azure-contoso', provider: 'Azure', scope: 'tenant Contoso', budget: 1000, mtd: 620, forecast: 680, sent: { a50: '17 Sep' }, hardStop: true, recipients: 'Contoso tenant admins', top: [['Virtual machines', 410], ['Storage', 130], ['Other', 80]] }
  ];
  const SHOWBACK = [
    { id: 'finance', name: 'Finance Ops', tenant: 'Northwind', amount: 6920, gpu: 2180, tokens: 2650, storage: 610, other: 1480 },
    { id: 'sales', name: 'Field Sales', tenant: 'Northwind', amount: 3880, gpu: 1240, tokens: 880, storage: 720, other: 1040 },
    { id: 'people', name: 'People Ops', tenant: 'Northwind', amount: 2410, gpu: 610, tokens: 540, storage: 480, other: 780 },
    { id: 'legal', name: 'Legal', tenant: 'Northwind', amount: 1960, gpu: 420, tokens: 610, storage: 390, other: 540 },
    { id: 'lab', name: 'Platform lab', tenant: 'Contoso', amount: 1240, gpu: 0, tokens: 90, storage: 130, other: 1020 },
    { id: 'shared', name: 'Shared platform (unallocated)', tenant: 'Platform', amount: 6940, gpu: 1100, tokens: 0, storage: 1720, other: 4120 }
  ];
  const RULES = [
    ['Tag exprsn:workspace', 'Direct to the workspace named in the tag', 'Resources a workspace owns: knowledge stores, data connections'],
    ['Tag exprsn:tenant', 'Direct to the tenant, then by workspace share of tokens', 'azure-contoso, tenant-scoped resources'],
    ['Tag exprsn:pool', 'Split by GPU-ms per workspace from usage_records', 'gpu-cloud-eu, gpu-azure-se, gpu-do-h100, cpu-cloud-eu'],
    ['Cloud model tokens', 'Direct from usage_records.cost_micros per workspace', 'Bedrock, Azure AI Foundry, DigitalOcean GenAI, Workers AI'],
    ['Shared data tier', 'Split by stored bytes per workspace', 'nw-prod-aurora, nw-prod-valkey, S3 and R2 blobs'],
    ['Untagged or platform', 'Left in Shared platform', 'EKS control plane, NAT gateways, load balancers, Tunnel']
  ];
  const ANOMALIES0 = () => [
    { id: 'an-1', account: 'aws-prod', what: 'NAT gateway data processing +210 %', day: '26 Sep', where: 'eu-central-1, nw-prod-eu', actual: 186, baseline: 60, state: 'open', contrib: [['nw-prod-eu, private subnet b', '$118'], ['Ollama image pulls to gpu-cloud-eu after spot replacement', '$41'], ['Other', '$27']] },
    { id: 'an-2', account: 'azure-eu', what: 'Azure OpenAI tokens +80 %', day: '27 Sep', where: 'swedencentral, nw-gpt-4-1-mini', actual: 142, baseline: 79, state: 'open', contrib: [['Finance Ops, profile analyst-cloud', '$51'], ['People Ops, profile chat-default', '$8'], ['Other', '$4']] },
    { id: 'an-3', account: 'cf-edge', what: 'Workers AI neurons within baseline', day: '28 Sep', where: 'Cloudflare edge', actual: 6, baseline: 5, state: 'no action', contrib: [['Field Sales, profile edge-chat', '$4'], ['Other', '$2']] }
  ];
  const TOKENS = [
    { model: 'nw-gpt-4-1-mini', provider: 'Azure AI Foundry', profile: 'analyst-cloud', unit: 'tokens', inTok: 1840, outTok: 310, cost: 1232.00 },
    { model: 'amazon.nova-pro-v1:0', provider: 'Bedrock', profile: 'analyst-cloud', unit: 'tokens', inTok: 412, outTok: 58, cost: 515.20 },
    { model: '@cf/meta/llama-3.1-8b-instruct', provider: 'Workers AI', profile: 'edge-chat', unit: 'neurons', neurons: '41.2 M neurons', cost: 453.20 },
    { model: 'nw-embed-3-large', provider: 'Azure AI Foundry', profile: 'knowledge-embed', unit: 'tokens', inTok: 900, outTok: 0, cost: 117.00 },
    { model: 'amazon.titan-embed-text-v2:0', provider: 'Bedrock', profile: 'knowledge-embed', unit: 'tokens', inTok: 2100, outTok: 0, cost: 42.00 },
    { model: 'llama3.3-70b-instruct', provider: 'DigitalOcean GenAI', profile: 'evaluation runs (draft)', unit: 'tokens', inTok: 12, outTok: 3, cost: 9.75 },
    { model: 'eu.amazon.nova-lite-v1:0', provider: 'Bedrock', profile: 'evaluation runs', unit: 'tokens', inTok: 3, outTok: 1, cost: 0.42 }
  ];
  const SOURCES0 = () => [
    { id: 'aws', provider: 'AWS', api: 'Cost Explorer GetCostAndUsage, daily, grouped by tag', accounts: 'aws-prod, aws-sandbox', last: '28 Sep 06:00', next: '29 Sep 06:00', rows: '1,284 daily rows', state: 'ok' },
    { id: 'azure', provider: 'Azure', api: 'Cost Management Query, daily, grouped by tag', accounts: 'azure-eu, azure-contoso', last: '28 Sep 06:00', next: '29 Sep 06:00', rows: '962 daily rows', state: 'ok' },
    { id: 'do', provider: 'DigitalOcean', api: 'Balance, billing history and invoice CSV', accounts: 'do-team', last: '28 Sep 06:00', next: '29 Sep 06:00', rows: 'month-to-date balance, 41 invoice lines (August)', state: 'ok' },
    { id: 'cf', provider: 'Cloudflare', api: 'Billing API and GraphQL Analytics (Workers AI neurons, R2 operations)', accounts: 'cf-edge', last: '28 Sep 06:00', next: '29 Sep 06:00', rows: '312 daily rows', state: 'ok' }
  ];

  // 28 days of spend per provider: a weekday rhythm scaled to the month-to-date totals, with the two anomalies.
  const DAYS = Array.from({ length: 28 }, (_, i) => (i + 1) + ' Sep');
  const SERIES = (() => {
    const out = {};
    PROVIDERS.forEach((p, k) => {
      const raw = DAYS.map((d, i) => { let v = 1 + 0.1 * Math.sin(i * 1.7 + k) - ((i + 1) % 7 === 5 || (i + 1) % 7 === 6 ? 0.12 : 0); if (p.id === 'aws' && i === 25) v += 0.35; if (p.id === 'azure' && i === 26) v += 0.25; return v; });
      const sum = raw.reduce((a, b) => a + b, 0); out[p.id] = raw.map((v) => Math.round((v / sum) * p.total));
    });
    return out;
  })();

  const money = (n, d) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  const pct = (a, b) => Math.round((a / b) * 100);
  const tone = (p) => p >= 100 ? 'danger' : p >= 80 ? 'warn' : '';

  function chart() {
    const W = 600, H = 170, pad = 28, bw = (W - pad) / DAYS.length;
    const totals = DAYS.map((d, i) => PROVIDERS.reduce((a, p) => a + SERIES[p.id][i], 0));
    const max = Math.ceil(Math.max.apply(null, totals) / 200) * 200;
    let bars = '';
    DAYS.forEach((d, i) => {
      let y = H - 18;
      PROVIDERS.forEach((p) => { const h = (SERIES[p.id][i] / max) * (H - 30); y -= h; bars += '<rect x="' + (pad + i * bw + 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw - 4).toFixed(1) + '" height="' + h.toFixed(1) + '" style="fill:' + p.fill + '"><title>' + esc(d + ', ' + p.name + ': ' + money(SERIES[p.id][i])) + '</title></rect>'; });
      if (i % 7 === 0) bars += '<text x="' + (pad + i * bw + 2).toFixed(1) + '" y="' + (H - 4) + '" style="fill:var(--muted);font-size:10px">' + esc(d) + '</text>';
    });
    const grid = [0.5, 1].map((f) => { const y = H - 18 - f * (H - 30); return '<line x1="' + pad + '" x2="' + W + '" y1="' + y + '" y2="' + y + '" style="stroke:var(--line2)"></line><text x="0" y="' + (y + 3) + '" style="fill:var(--muted);font-size:10px">' + esc(money(max * f)) + '</text>'; }).join('');
    return '<svg class="finops-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily cloud spend in September by provider, stacked bars">' + grid + bars + '</svg>'
      + '<div class="hstack wrap gap12" style="font-size:12px">' + PROVIDERS.map((p) => '<span class="hstack gap4"><i class="finops-key" style="background:' + p.fill + '"></i>' + esc(p.name) + ' <span class="muted num">' + esc(money(p.total)) + '</span></span>').join('') + '</div>';
  }
  function thresholds(a) {
    const s = a.sent || {};
    const chip = (k, l) => s[k] ? UI.pill(l + ' sent ' + s[k], k === 'a100' || k === 'f100' ? 'danger' : k === 'a80' ? 'warn' : 'info') : '<span class="pill outline">' + esc(l) + '</span>';
    return '<span class="hstack wrap gap4">' + chip('a50', '50 %') + chip('a80', '80 %') + chip('a100', '100 %') + (s.f100 ? chip('f100', 'forecast 100 %') : '') + '</span>';
  }
  const init = (st) => {
    if (st.accounts) return;
    st.accounts = ACCOUNTS0(); st.anomalies = ANOMALIES0(); st.sources = SOURCES0();
    st.tab = 'overview'; st.sel = 'aws-prod'; st.sbBy = 'workspace'; st.selAn = 'an-1';
  };

  App.register({
    id: 'finops', title: 'Cloud spend', section: 'admin', crumb: ['Admin', 'Cloud spend'],
    summary: 'Spend by cloud account, budgets with hard stop, showback, anomalies, model token cost, billing sources',
    commands: [
      { label: 'Set a cloud budget', sub: 'Cloud spend', run(app) { const s = app.stateFor('finops'); init(s); s.tab = 'budgets'; s.openBudget = true; app.render(); } },
      { label: 'Export showback CSV', sub: 'Cloud spend', run(app) { const s = app.stateFor('finops'); init(s); s.tab = 'showback'; app.render(); app.toast('Showback for September queued as export job finops.showback.export. It appears under Usage and audit, Exports.'); } }
    ],
    states: [
      { title: 'No accounts connected', tone: 'neutral', text: 'No cloud account is connected yet, so there is nothing to ingest or budget. The page points to Cloud accounts.', apply(ctx) { init(ctx.state); ctx.state.view = 'empty'; ctx.rerender(); } },
      { title: 'Loading', tone: 'neutral', text: 'Spend, budgets and forecasts load from cloud_costs; skeleton rows hold the layout.', apply(ctx) { init(ctx.state); ctx.state.view = 'loading'; ctx.rerender(); } },
      { title: 'Ingestion failed', tone: 'danger', text: 'AWS Cost Explorer refused the daily ingestion (AccessDeniedException on ce:GetCostAndUsage). Yesterday stays an estimate until the role allows it.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.tab = 'sources'; st.sources.find((s) => s.id === 'aws').state = 'failed'; ctx.rerender(); } },
      { title: 'Budget hard stop', tone: 'danger', text: 'do-team is at 103 % of its $4,000 budget. Plans that add monthly cost are refused with budget_exceeded; scale-down and destroy still run.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.tab = 'budgets'; st.sel = 'do-team'; st.accounts.find((a) => a.id === 'do-team').overridePending = null; ctx.rerender(); } },
      { title: 'Anomaly detected', tone: 'warn', text: 'NAT gateway data processing in aws-prod is up 210 % against its 14-day baseline. The top contributors are listed with an acknowledge action.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.tab = 'anomalies'; st.selAn = 'an-1'; st.anomalies.find((a) => a.id === 'an-1').state = 'open'; ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'A member without finops:read opens Cloud spend. Nothing loads; the page names the permission and the roles that hold it.', apply(ctx) { init(ctx.state); ctx.state.view = 'denied'; ctx.rerender(); } },
      { title: 'Estimates only', tone: 'info', text: 'cf-edge was connected today. Until the first billing ingestion, its figures are estimates from plans and metered usage, marked as such.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.estimates = true; st.tab = 'overview'; st.sel = 'cf-edge'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; init(st);
      if ((ctx.params.tab || ctx.params.account) && st.paramHash !== location.hash) { st.paramHash = location.hash; if (ctx.params.tab) st.tab = ctx.params.tab; if (ctx.params.account) st.sel = ctx.params.account; }
      const style = '<style>.finops-chart{width:100%;height:auto;display:block}.finops-key{display:inline-block;width:10px;height:10px;border-radius:2px}.finops-bar{height:8px;border-radius:3px;background:var(--line2);overflow:hidden;display:flex}.finops-bar i{display:block;height:100%}</style>';
      const head = UI.pagehead('Cloud spend', 'September 2026 to date, 28 Sep 09:40 UTC. Budgets, showback and anomalies across AWS, Azure, DigitalOcean and Cloudflare', UI.btn('Export showback', { icon: 'download', attrs: 'data-export' }) + UI.btn('Set budget', { kind: 'primary', attrs: 'data-budget' }));
      const example = '<span class="muted" style="font-size:12px">Example data. Prices and amounts are illustrative, not provider quotes.</span>';

      if (st.view === 'empty') { root.innerHTML = style + '<div class="page">' + head + UI.empty('No cloud accounts connected', 'Connect an AWS, Azure, DigitalOcean or Cloudflare account first. Spend is ingested daily from its billing API, and budgets apply per account.', UI.btn('Open Cloud accounts', { kind: 'primary', attrs: 'data-go="cloud"' })) + '</div>'; ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go)); return; }
      if (st.view === 'denied') { root.innerHTML = style + '<div class="page">' + UI.pagehead('Cloud spend', 'Spend, budgets and showback') + UI.problem('You need finops:read', 'Felix Brandt (Member, Finance Ops) has no role that grants finops:read. The FinOps analyst and Cloud admin roles hold it. Ask a tenant admin, or see Roles and access for the explain steps: role Member grants chat and knowledge only; no workspace scope adds finops:read.', '5d0c2a9e7b1f4c3a8e6d2b0f9a7c5e1d') + '<div>' + UI.btn('Open Roles and access', { attrs: 'data-go="roles"' }) + '</div></div>'; ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go)); return; }
      if (st.view === 'loading') { const sk = '<div class="skeleton" style="height:14px"></div>'; root.innerHTML = style + '<div class="page">' + head + '<div class="stats">' + [1, 2, 3, 4].map(() => '<div class="stat">' + sk + '<div class="skeleton" style="width:60%"></div></div>').join('') + '</div>' + UI.panel('Daily spend', '<div class="skeleton" style="height:150px"></div>') + UI.panel('Accounts', [1, 2, 3, 4, 5].map(() => sk).join('')) + '<span class="muted" style="font-size:12px">Loading spend from cloud_costs</span></div>'; setTimeout(() => { if (st.view === 'loading') { st.view = null; if (App.state.route === 'finops') ctx.rerender(); } }, 1500); return; }

      const accts = st.accounts;
      const totalMtd = accts.reduce((a, x) => a + x.mtd, 0), totalBudget = accts.reduce((a, x) => a + x.budget, 0), totalFc = 26900;
      const tabs = UI.tabs([{ id: 'overview', label: 'Overview' }, { id: 'budgets', label: 'Budgets', count: accts.length }, { id: 'showback', label: 'Showback' }, { id: 'anomalies', label: 'Anomalies', count: st.anomalies.filter((a) => a.state === 'open').length }, { id: 'tokens', label: 'Model tokens' }, { id: 'sources', label: 'Sources' }], st.tab);
      const stopped = accts.filter((a) => a.hardStop && a.mtd >= a.budget);
      let body = '', insp = '';
      const sel = accts.find((a) => a.id === st.sel) || accts[0];
      const isEst = (a) => st.estimates && a.id === 'cf-edge';

      const acctInsp = (a) => {
        const p = pct(a.mtd, a.budget), fp = pct(a.forecast, a.budget);
        const sumTop = a.top.reduce((s, t) => s + t[1], 0);
        return '<div class="hstack"><div class="eyebrow grow">Cloud account</div>' + UI.pill(a.provider, 'outline') + '</div><div class="mono" style="font-size:14px;font-weight:600">' + esc(a.id) + '</div><div class="muted" style="font-size:12px">' + esc(a.provider) + ', ' + esc(a.scope) + ' scope</div>'
          + (isEst(a) ? UI.notice('Estimates only. No billing data has been ingested for this account yet; figures come from plans and metered usage.', 'info') : '')
          + UI.meter('Spent', money(a.mtd) + ' of ' + money(a.budget) + (isEst(a) ? ' (estimate)' : ''), p, tone(p)) + UI.meter('Forecast for September', money(a.forecast) + ', ' + fp + ' %', fp, tone(fp))
          + (a.hardStop && a.mtd >= a.budget ? (a.overridePending ? UI.notice('Override requested for ' + esc(a.overridePending) + ', waiting for Jonas Lindqvist. The hard stop holds until it is approved.', 'warn') : UI.notice('<b>Hard stop since ' + esc(a.stopSince || 'today') + '.</b> Plans that add monthly cost are refused with <span class="mono">budget_exceeded</span>. Scale-down and destroy still run.', 'danger', UI.btn('Request override', { size: 'xs', attrs: 'data-override="' + esc(a.id) + '"' }))) : '')
          + '<div class="eyebrow">Alerts</div>' + thresholds(a)
          + '<div class="eyebrow">Top services</div>' + UI.table(['Service', { label: 'MTD', right: true }], a.top.map((t) => [esc(t[0]), '<span class="num">' + esc(money(t[1])) + '</span>']), { clickable: false, minWidth: '0', cls: 'bare' })
          + '<span class="muted" style="font-size:12px">Top services sum to ' + esc(money(sumTop)) + '. Billing ingested 28 Sep 06:00.</span>'
          + '<div class="hstack wrap gap6">' + UI.btn('Edit budget', { size: 'sm', kind: 'primary', attrs: 'data-budget="' + esc(a.id) + '"' }) + UI.btn('Open account', { size: 'sm', attrs: 'data-goacct="' + esc(a.id) + '"' }) + '</div>';
      };

      if (st.tab === 'overview') {
        body += (stopped.length ? UI.notice('<b>Hard stop:</b> ' + stopped.map((a) => '<span class="mono">' + esc(a.id) + '</span> at ' + pct(a.mtd, a.budget) + ' %').join(', ') + '. New resources in these accounts are refused until the budget resets on 1 Oct or an override is approved.', 'danger', UI.btn('Budgets', { size: 'xs', attrs: 'data-tabgo="budgets"' })) : '')
          + (st.estimates ? UI.notice('Some figures are estimates: cf-edge has no billing data yet. Its first ingestion runs 29 Sep 06:00.', 'info') : '')
          + '<div class="stats">' + UI.stat(esc(money(totalMtd)), 'Spent in September', pct(totalMtd, totalBudget) + ' % of ' + esc(money(totalBudget)) + ' in budgets') + UI.stat(esc(money(totalFc)), 'Forecast at month end', '2 accounts forecast over budget') + UI.stat(esc(String(stopped.length)), 'Accounts under hard stop', stopped.length ? esc(stopped.map((a) => a.id).join(', ')) : 'none') + UI.stat('$474', 'Saved by idle GPU scale-down', '212 GPU-hours scaled to zero') + '</div>'
          + UI.panel('Daily spend by provider', chart(), { actions: '<span class="muted" style="font-size:12px">1 to 28 Sep</span>' })
          + UI.table(['Account', 'Provider', { label: 'Spent', right: true }, { label: 'Budget', right: true }, { label: '', width: '160px' }, { label: 'Forecast', right: true }, 'Alerts'], accts.map((a) => { const p = pct(a.mtd, a.budget), fp = pct(a.forecast, a.budget); return { cells: ['<span class="mono" style="font-weight:600">' + esc(a.id) + '</span>' + (a.scope !== 'platform' ? '<div class="muted" style="font-size:11px">' + esc(a.scope) + '</div>' : ''), esc(a.provider), '<span class="num">' + esc(money(a.mtd)) + (isEst(a) ? ' <span class="muted">est.</span>' : '') + '</span>', '<span class="num">' + esc(money(a.budget)) + '</span>', UI.meter('', p + ' %', p, tone(p)), '<span class="num" style="' + (fp >= 100 ? 'color:var(--danger-fg)' : '') + '">' + esc(money(a.forecast)) + '</span>', thresholds(a)], attrs: 'data-acct="' + esc(a.id) + '"', selected: a.id === sel.id }; }), { minWidth: '900px' })
          + example;
        insp = acctInsp(sel);
      }

      if (st.tab === 'budgets') {
        body += '<div class="grid2">' + UI.panel('How budgets work', '<div class="fg2" style="font-size:12px">Each cloud account has a monthly budget in its billing currency. Alerts go out at 50, 80 and 100 % of actual spend and of the month-end forecast, as notifications and to the account\'s webhook. With hard stop on, a plan that adds monthly cost is refused once actual spend passes 100 %; scale-down, destroy and repairs always run. An override needs a second cloud admin, a reason, and lasts at most 7 days.</div>')
          + UI.panel('This month', UI.kv([['Accounts at or over 100 %', '<span class="num">' + accts.filter((a) => a.mtd >= a.budget).length + '</span>'], ['Forecast over 100 %', '<span class="num">' + accts.filter((a) => a.forecast >= a.budget).length + '</span>'], ['Alerts sent', '<span class="num">' + accts.reduce((n, a) => n + Object.keys(a.sent).length, 0) + '</span>'], ['Budgets reset', '1 Oct 00:00 UTC']], 2)) + '</div>'
          + UI.table(['Account', { label: 'Budget', right: true }, { label: 'Spent', right: true }, { label: 'Forecast', right: true }, 'Alerts at 50, 80, 100 %', 'Hard stop', 'Recipients'], accts.map((a) => ({ cells: ['<span class="mono" style="font-weight:600">' + esc(a.id) + '</span><div class="muted" style="font-size:11px">' + esc(a.provider) + '</div>', '<span class="num">' + esc(money(a.budget)) + '</span>', '<span class="num">' + esc(money(a.mtd)) + ' (' + pct(a.mtd, a.budget) + ' %)</span>', '<span class="num">' + esc(money(a.forecast)) + '</span>', thresholds(a), UI.toggle(a.hardStop ? (a.mtd >= a.budget ? 'On, stopping' : 'On') : 'Off, alerts only', a.hardStop, 'data-manual="1" data-stop="' + esc(a.id) + '"'), '<span style="font-size:12px">' + esc(a.recipients) + '</span>'], attrs: 'data-acct="' + esc(a.id) + '"', selected: a.id === sel.id })), { minWidth: '1000px' })
          + example;
        insp = acctInsp(sel);
      }

      if (st.tab === 'showback') {
        const tenants = {}; SHOWBACK.forEach((s) => { tenants[s.tenant] = tenants[s.tenant] || { name: s.tenant, amount: 0, gpu: 0, tokens: 0, storage: 0, other: 0 }; ['amount', 'gpu', 'tokens', 'storage', 'other'].forEach((k) => { tenants[s.tenant][k] += s[k]; }); });
        const rows = st.sbBy === 'tenant' ? Object.keys(tenants).map((k) => tenants[k]) : SHOWBACK;
        const total = SHOWBACK.reduce((a, s) => a + s.amount, 0);
        const bar = (s) => '<div class="finops-bar" title="GPU, tokens, storage, other">' + [['gpu', 'var(--accent)'], ['tokens', 'var(--info-fg)'], ['storage', 'var(--ok-fg)'], ['other', 'var(--meter)']].map(([k, c]) => '<i style="width:' + (s.amount ? (s[k] / s.amount) * 100 : 0) + '%;background:' + c + '"></i>').join('') + '</div>';
        body += '<div class="toolbar">' + UI.seg([{ id: 'workspace', label: 'By workspace' }, { id: 'tenant', label: 'By tenant' }], st.sbBy, 'data-sb') + '<span class="muted right" style="font-size:12px">September 2026 to date, ' + esc(money(total)) + ' allocated across ' + SHOWBACK.length + ' rows</span></div>'
          + UI.table((st.sbBy === 'tenant' ? ['Tenant'] : ['Workspace', 'Tenant']).concat([{ label: 'GPU', right: true }, { label: 'Model tokens', right: true }, { label: 'Storage', right: true }, { label: 'Other', right: true }, { label: 'Total', right: true }, { label: 'Mix', width: '140px' }]), rows.map((s) => (st.sbBy === 'tenant' ? ['<span style="font-weight:600">' + esc(s.name) + '</span>'] : ['<span style="font-weight:600">' + esc(s.name) + '</span>', esc(s.tenant)]).concat([ '<span class="num">' + esc(money(s.gpu)) + '</span>', '<span class="num">' + esc(money(s.tokens)) + '</span>', '<span class="num">' + esc(money(s.storage)) + '</span>', '<span class="num">' + esc(money(s.other)) + '</span>', '<span class="num" style="font-weight:600">' + esc(money(s.amount)) + '</span>', bar(s)])), { clickable: false, minWidth: '860px' })
          + '<div class="hstack wrap gap12" style="font-size:12px">' + [['GPU', 'var(--accent)'], ['Model tokens', 'var(--info-fg)'], ['Storage', 'var(--ok-fg)'], ['Other', 'var(--meter)']].map(([l, c]) => '<span class="hstack gap4"><i class="finops-key" style="background:' + c + '"></i>' + esc(l) + '</span>').join('') + '</div>'
          + UI.panel('Allocation rules', UI.table(['Rule', 'How cost is allocated', 'Applies to'], RULES.map((r) => [esc(r[0]), esc(r[1]), '<span class="fg2" style="font-size:12px">' + esc(r[2]) + '</span>']), { clickable: false, minWidth: '700px', cls: 'bare' }) + '<span class="muted" style="font-size:12px">Every resource Exprsn-AI creates carries the tags exprsn:tenant, exprsn:workspace and exprsn:pool where they apply. Shared costs are split by GPU-ms, tokens and stored bytes from usage_records. Showback is informational; pushing it into billing statements is optional per tenant.</span>', { actions: UI.btn('Export CSV', { size: 'sm', icon: 'download', attrs: 'data-export' }) + UI.btn('Add to statements', { size: 'sm', attrs: 'data-statements' }) })
          + example;
      }

      if (st.tab === 'anomalies') {
        const an = st.anomalies.find((a) => a.id === st.selAn) || st.anomalies[0];
        body += UI.notice('Anomalies compare each account\'s daily spend per service with its 14-day baseline. A day more than 50 % and $50 above the baseline opens an anomaly and notifies the account\'s recipients.', 'info')
          + UI.table(['Anomaly', 'Account', 'Day', 'Where', { label: 'Actual', right: true }, { label: 'Baseline', right: true }, 'State'], st.anomalies.map((a) => ({ cells: ['<span style="font-weight:600">' + esc(a.what) + '</span>', '<span class="mono">' + esc(a.account) + '</span>', esc(a.day), esc(a.where), '<span class="num">' + esc(money(a.actual)) + '/day</span>', '<span class="num">' + esc(money(a.baseline)) + '/day</span>', UI.pill(a.state, a.state === 'open' ? 'warn' : a.state === 'acknowledged' ? 'ok' : '')], attrs: 'data-an="' + esc(a.id) + '"', selected: a.id === an.id })), { minWidth: '860px', emptyTitle: 'No anomalies', emptyText: 'Spend in every account is within its baseline.' })
          + example;
        insp = '<div class="hstack"><div class="eyebrow grow">Anomaly</div>' + UI.pill(an.state, an.state === 'open' ? 'warn' : an.state === 'acknowledged' ? 'ok' : '') + '</div><div style="font-size:15px;font-weight:600">' + esc(an.what) + '</div><div class="muted" style="font-size:12px">' + esc(an.account) + ', ' + esc(an.where) + ', ' + esc(an.day) + '</div>'
          + UI.kv([['Actual', esc(money(an.actual)) + ' a day'], ['Baseline (14 days)', esc(money(an.baseline)) + ' a day']], 2)
          + '<div class="eyebrow">Top contributors</div>' + UI.table(['Contributor', { label: 'Extra', right: true }], an.contrib.map((c) => [esc(c[0]), '<span class="num">' + esc(c[1]) + '</span>']), { clickable: false, minWidth: '0', cls: 'bare' })
          + (an.id === 'an-1' ? '<span class="fg2" style="font-size:12px">Image pulls after the spot replacement on gpu-cloud-eu went out through the NAT gateway. A gateway endpoint for the registry mirror would keep them inside the VPC.</span>' : an.id === 'an-2' ? '<span class="fg2" style="font-size:12px">The analyst-cloud profile in Finance Ops ran a month-end batch through nw-gpt-4-1-mini. Token cost is already in usage_records.</span>' : '')
          + '<div class="hstack wrap gap6">' + (an.state === 'open' ? UI.btn('Acknowledge', { kind: 'primary', size: 'sm', attrs: 'data-ack' }) : '') + UI.btn('Open deployment', { size: 'sm', attrs: 'data-go="deployments"' }) + '</div>';
      }

      if (st.tab === 'tokens') {
        const total = TOKENS.reduce((a, t) => a + t.cost, 0);
        body += UI.notice('Cloud model calls are priced when they are metered: each usage_records row gets cost_micros, currency and price_id from the model\'s price at that moment. Workers AI is priced in neurons.', 'info')
          + UI.table(['Model', 'Provider', 'Profile', { label: 'Input', right: true }, { label: 'Output', right: true }, { label: 'Cost', right: true }], TOKENS.map((t) => ['<span class="mono">' + esc(t.model) + '</span>', esc(t.provider), esc(t.profile), '<span class="num">' + (t.unit === 'neurons' ? esc(t.neurons) : esc(t.inTok.toLocaleString('en-US')) + ' M') + '</span>', '<span class="num">' + (t.unit === 'neurons' ? '<span class="muted">in neurons</span>' : t.outTok ? esc(t.outTok) + ' M' : '<span class="muted">embed</span>') + '</span>', '<span class="num" style="font-weight:600">' + esc(money(t.cost, 2)) + '</span>']), { clickable: false, minWidth: '820px' })
          + '<div class="hstack"><span class="muted grow" style="font-size:12px">September to date. Per-model prices are on the model card in Models.</span><span class="num" style="font-weight:600">' + esc(money(total, 2)) + '</span></div>'
          + '<div>' + UI.btn('Open Models, cloud providers', { size: 'sm', attrs: 'data-models' }) + '</div>' + example;
      }

      if (st.tab === 'sources') {
        const failed = st.sources.find((s) => s.state === 'failed');
        body += (failed ? '<div class="vstack gap6">' + UI.problem('Ingestion failed: AWS Cost Explorer', 'GetCostAndUsage answered AccessDeniedException for role arn:aws:iam::111122223333:role/exprsn-ai-deploy: the role is not allowed ce:GetCostAndUsage. Yesterday\'s AWS spend stays an estimate from plans until the permission is added; the next try is 29 Sep 06:00.', '9c2e4a7b1d3f5e8a0b6c4d2e1f7a9b3c') + '<div class="hstack gap6">' + UI.btn('Check permissions', { size: 'sm', attrs: 'data-go="cloud"' }) + UI.btn('Retry now', { size: 'sm', attrs: 'data-ingest="aws"' }) + '</div></div>' : '')
          + UI.table(['Provider', 'API', 'Accounts', 'Last run', 'Next run', 'Result', 'State', ''], st.sources.map((s) => [esc(s.provider), '<span style="font-size:12px">' + esc(s.api) + '</span>', '<span class="mono" style="font-size:12px">' + esc(s.accounts) + '</span>', esc(s.last), esc(s.next), '<span style="font-size:12px">' + esc(s.state === 'failed' ? 'no rows, estimate kept' : s.rows) + '</span>', UI.pill(s.state === 'ok' ? 'ok' : s.state, s.state === 'ok' ? 'ok' : s.state === 'running' ? 'info' : 'danger'), UI.btn('Ingest now', { size: 'xs', attrs: 'data-ingest="' + esc(s.id) + '"', disabled: s.state === 'running' })]), { clickable: false, minWidth: '1000px' })
          + '<span class="muted" style="font-size:12px">Ingestion runs daily as job cloud.billing.ingest per account. Cost Explorer charges per request, so it is grouped by tag in one call a day. DigitalOcean has no daily cost API: month-to-date balance is ingested daily and replaced by invoice lines when the month closes.</span>'
          + example;
      }

      root.innerHTML = style + '<div class="page">' + head + tabs + body + '</div>' + (insp ? '<aside class="inspector w360">' + insp + '</aside>' : '');

      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-tabgo]', (e, t) => { st.tab = t.dataset.tabgo; ctx.rerender(); });
      ctx.on('click', 'tr.row[data-acct]', (e, t) => { if (e.target.closest('.toggle')) return; st.sel = t.dataset.acct; ctx.rerender(); });
      ctx.on('click', 'tr.row[data-an]', (e, t) => { st.selAn = t.dataset.an; ctx.rerender(); });
      ctx.on('click', '[data-seg]', (e, t) => { st.sbBy = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('click', '[data-goacct]', (e, t) => ctx.navigate('cloud', { account: t.dataset.goacct }));
      ctx.on('click', '[data-models]', () => ctx.navigate('models', { provider: 'cloud' }));
      ctx.on('click', '[data-export]', () => ctx.toast('Showback for September queued as export job finops.showback.export (CSV, one row per workspace and cost class). It appears under Usage and audit, Exports.', 'ok', 5000));
      ctx.on('click', '[data-statements]', async () => {
        const ok = await ctx.confirm({ title: 'Add showback to September statements', tone: 'info', tag: 'chargeback', body: '<p class="fg2" style="margin:0">Adds each workspace\'s allocated cloud cost as a line on its tenant\'s September statement, next to the price-book charges. Shared platform cost stays off the statements.</p>', kv: [['Northwind', '$15,170'], ['Contoso', '$1,240']], ok: 'Add to statements' });
        if (ok) ctx.toast('Cloud cost lines added to the September statements of Northwind and Contoso. Audit entry finops.showback.billed written.', 'ok', 5000);
      });
      ctx.on('click', '[data-ack]', async () => {
        const an = st.anomalies.find((a) => a.id === st.selAn); if (!an) return;
        const ok = await ctx.confirm({ title: 'Acknowledge anomaly', tone: 'info', body: '<p class="fg2" style="margin:0">Stops repeat notices for this anomaly. It reopens if spend stays above the baseline for three more days.</p>' + UI.field('Note', UI.input('', { placeholder: 'What explains it, or what you changed' })), ok: 'Acknowledge' });
        if (!ok) return; an.state = 'acknowledged'; ctx.rerender(); ctx.toast(esc(an.what) + ' acknowledged by Mara Okafor.', 'ok');
      });
      ctx.on('click', '[data-ingest]', (e, t) => {
        const s = st.sources.find((x) => x.id === t.dataset.ingest); if (!s) return;
        s.state = 'running'; ctx.rerender(); ctx.toast('Ingestion started for ' + esc(s.provider) + ' as job cloud.billing.ingest.');
        setTimeout(() => { s.state = 'ok'; s.last = '28 Sep 09:41'; if (App.state.route === 'finops' && st.tab === 'sources') ctx.rerender(); }, 1400);
      });
      ctx.on('click', '[data-stop]', async (e, t) => {
        e.stopPropagation(); const a = accts.find((x) => x.id === t.dataset.stop); if (!a) return;
        const on = !a.hardStop;
        const ok = await ctx.confirm({ title: (on ? 'Turn on hard stop for ' : 'Turn off hard stop for ') + a.id, tone: on ? 'info' : 'danger', tag: on ? 'hard stop' : 'alerts only', body: '<p class="fg2" style="margin:0">' + (on ? 'Once spend passes 100 % of the budget, plans that add monthly cost are refused. Scale-down, destroy and repairs still run.' : 'Alerts continue at 50, 80 and 100 %, but nothing is refused when the budget is passed. Turning it off needs finops:manage and is audited.') + '</p>', ok: on ? 'Turn on' : 'Turn off' });
        if (!ok) return; a.hardStop = on; ctx.rerender(); ctx.toast('Hard stop ' + (on ? 'on' : 'off') + ' for ' + esc(a.id) + '. Audit entry finops.budget.updated written.', 'ok');
      });
      const budgetModal = (id) => {
        const a = accts.find((x) => x.id === id) || sel;
        ctx.modal({ title: 'Budget for ' + esc(a.id), body: '<div class="formgrid" style="--cols:2">' + UI.field('Monthly budget (USD)', UI.input(String(a.budget), { type: 'number', attrs: 'data-f="budget"' })) + UI.field('Period', UI.select(['Calendar month, UTC'], 'Calendar month, UTC')) + UI.field('Alert on actual spend', '<div class="hstack wrap gap12" style="height:30px">' + UI.check('50 %', true) + UI.check('80 %', true) + UI.check('100 %', true) + '</div>') + UI.field('Alert on forecast', '<div class="hstack wrap gap12" style="height:30px">' + UI.check('80 %', false) + UI.check('100 %', true) + '</div>') + '<div class="span2">' + UI.field('Recipients', UI.input(a.recipients)) + '</div></div>' + UI.toggle('Hard stop on new resources past 100 %', a.hardStop, 'data-f="stop"') + UI.notice('Changing a budget needs finops:manage. Alerts already sent this month are not sent again for the same threshold.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save budget', { kind: 'primary', attrs: 'data-save' }), onMount(m) { m.querySelector('[data-save]').addEventListener('click', () => { const v = parseInt(m.querySelector('[data-f="budget"]').value, 10); if (v > 0) a.budget = v; a.hardStop = m.querySelector('[data-f="stop"]').classList.contains('on'); App.closeOverlay(); st.sel = a.id; ctx.rerender(); ctx.toast('Budget for ' + esc(a.id) + ' set to ' + esc(money(a.budget)) + '.', 'ok'); }); } });
      };
      ctx.on('click', '[data-budget]', (e, t) => budgetModal(t.dataset.budget || sel.id));
      if (st.openBudget) { st.openBudget = false; setTimeout(() => budgetModal(sel.id), 50); }
      ctx.on('click', '[data-override]', (e, t) => {
        const a = accts.find((x) => x.id === t.dataset.override); if (!a) return;
        ctx.modal({ title: 'Request budget override for ' + esc(a.id) + ' ' + UI.pill('dual control', 'warn'), body: '<p class="fg2" style="margin:0">Lets new resources through the hard stop for a limited time. A second cloud admin must approve it; alerts continue while it runs.</p>' + UI.kv([['Spent', esc(money(a.mtd)) + ' of ' + esc(money(a.budget))], ['Forecast', esc(money(a.forecast))], ['Waiting plan', 'lab-do adds $214 a month']], 3) + '<div class="formgrid" style="--cols:2">' + UI.field('Duration', UI.select(['1 day', '3 days', '7 days (maximum)'], '3 days')) + UI.field('Second approver', UI.select(['Jonas Lindqvist', 'Any cloud admin'], 'Jonas Lindqvist')) + '<div class="span2">' + UI.field('Reason', UI.textarea('', { placeholder: 'Why new resources must start before the budget resets on 1 Oct', rows: 3, attrs: 'data-f="reason"' })) + '</div></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send for approval', { kind: 'primary', attrs: 'data-send' }), onMount(m) { m.querySelector('[data-send]').addEventListener('click', () => { const r = m.querySelector('[data-f="reason"]'); if (!r.value.trim()) { r.focus(); ctx.toast('A reason is required for an override.', 'warn'); return; } const d = m.querySelector('select').value.replace(' (maximum)', ''); App.closeOverlay(); a.overridePending = d; ctx.rerender(); ctx.toast('Override for ' + esc(a.id) + ' (' + esc(d) + ') sent to Jonas Lindqvist. It takes effect when approved.', 'ok', 5000); }); } });
      });
    }
  });
})();
