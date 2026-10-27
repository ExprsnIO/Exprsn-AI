(function () {
  const { UI, esc } = App;

  /*
   * Cloud spend (1.9.99-final, Sprint 62: B-10607, with the anomalies of B-10606), from the `finops` board of the
   * design prototype (`#/finops`, removed 2026-10-21). Everything comes from the server: the accounts and their
   * month-to-date billed totals and last fetch (/api/admin/cloud/costs), budgets with alerts, the hard stop and
   * overrides (/api/admin/cloud/budgets, B-10602), the month per day and provider, cloud model calls priced at
   * metering and idle GPU savings (/api/admin/cloud/spend), showback (/api/admin/cloud/showback, B-10604) and spend
   * anomalies with their top contributors (/api/admin/cloud/anomalies, B-10606). Amounts stay in the currency each
   * account bills in (open decision 17): they are never converted or added across currencies. The Analytics screen's
   * "Cloud showback" tab stays and links here.
   */
  const enc = encodeURIComponent;
  const PROV = { aws: 'AWS', azure: 'Azure', digitalocean: 'DigitalOcean', cloudflare: 'Cloudflare' };
  const ORDER = ['aws', 'azure', 'digitalocean', 'cloudflare'];
  const FILL = { aws: 'var(--accent)', azure: 'var(--info-fg)', digitalocean: 'var(--ok-fg)', cloudflare: 'var(--warn-fg)' };
  const API_TEXT = { aws: 'Cost Explorer GetCostAndUsage, daily, grouped by tag and service', azure: 'Cost Management Query, daily, grouped by tag and service', digitalocean: 'Balance and invoice items, attributed by resource id', cloudflare: 'Billing history and GraphQL Analytics (Workers, R2, Workers AI neurons)' };
  const STOP_TEXT = { actual: 'On, at actual spend', forecast: 'On, at the forecast', off: 'Off, alerts only' };
  const DIM_TEXT = { service: 'Service', deployment: 'Deployment', region: 'Region', tag: 'Tag' };
  const TYPES = { gpu: 'GPU time', model: 'Model APIs', compute: 'Compute and clusters', database: 'Databases and caches', storage: 'Object storage', network: 'Network and front door', other: 'Other' };
  const BASES = { gpu_time: 'GPU time', tokens: 'Tokens', model_cost: 'Model cost', requests: 'Requests', storage: 'Storage used', even: 'Evenly', unallocated: 'Leave unallocated' };
  const provName = (p) => PROV[p] || p;
  const num = (n, d) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
  const money = (n, cur, d) => esc(cur || 'USD') + ' ' + num(n, d);
  const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const toneOf = (p) => (p >= 100 ? 'danger' : p >= 80 ? 'warn' : '');
  const when = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : 'never');
  const dayText = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  const monthName = (m) => new Date(m + '-01T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const overlayOpen = () => !!document.getElementById('overlay');
  const detailOf = (e) => (e && e.problem && e.problem.detail) || (e && e.message) || 'Request failed';

  // ---------- the accounts, from the costs summary and the budgets ----------
  function accountsOf(st) {
    const d = st.data || {};
    const budgets = {};
    ((d.budgets && d.budgets.budgets) || []).forEach((b) => { budgets[b.account.id] = b; });
    return ((d.costs && d.costs.accounts) || []).map((c) => {
      const b = budgets[c.account.id];
      const s = b && b.status;
      const cur = s ? s.budget.currency : c.currency;
      const mtd = s ? s.actual.amount : Number((c.monthToDate || {})[cur] || 0);
      const others = Object.keys(c.monthToDate || {}).filter((k) => k !== cur).map((k) => money(c.monthToDate[k], k)).join(', ');
      return {
        id: c.account.id, name: c.account.name, provider: c.account.provider, scope: c.account.scope, currency: cur, mtd, others,
        budget: s ? s.budget.amount : null, hardStop: s ? s.budget.hardStop : null, forecast: s ? s.forecast.amount : null,
        pct: s ? s.pctActual : null, fpct: s ? s.pctForecast : null, stopped: !!(s && s.stopped), override: s ? s.override : null,
        pending: (b && b.pending) || [], alerts: (s && s.alerts) || [], source: c.budgetSource, reason: c.reason,
        lastFetch: c.lastFetch, eligible: c.eligible
      };
    });
  }
  const mainCurrency = (accts) => { const n = {}; accts.forEach((a) => { n[a.currency] = (n[a.currency] || 0) + 1; }); return Object.keys(n).sort((x, y) => n[y] - n[x])[0] || 'USD'; };

  function thresholds(a) {
    const sent = {};
    a.alerts.forEach((x) => { sent[x.basis + x.threshold] = x.firedAt; });
    const chip = (k, l) => (sent[k] ? UI.pill(l + ' sent ' + dayText(new Date(sent[k]).toISOString().slice(0, 10)), k === 'actual100' || k === 'forecast100' ? 'danger' : k === 'actual80' ? 'warn' : 'info') : '<span class="pill outline">' + esc(l) + '</span>');
    if (a.budget == null) return '<span class="muted" style="font-size:12px">No budget</span>';
    return '<span class="hstack wrap gap4">' + chip('actual50', '50 %') + chip('actual80', '80 %') + chip('actual100', '100 %') + (sent.forecast100 ? chip('forecast100', 'forecast 100 %') : '') + '</span>';
  }

  function chart(daily, cur, month) {
    const rows = daily.filter((d) => d.currency === cur);
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const today = month === thisMonth() ? new Date().getUTCDate() : last;
    const days = Array.from({ length: Math.max(1, today) }, (_, i) => month + '-' + String(i + 1).padStart(2, '0'));
    const provs = ORDER.filter((p) => rows.some((r) => r.provider === p));
    const val = (d, p) => rows.filter((r) => r.day === d && r.provider === p).reduce((n, r) => n + r.amount, 0);
    const totals = days.map((d) => provs.reduce((n, p) => n + val(d, p), 0));
    const W = 600, H = 170, pad = 44, bw = (W - pad) / days.length;
    const max = Math.max(1, Math.max.apply(null, totals)) * 1.1;
    let bars = '';
    days.forEach((d, i) => {
      let yy = H - 18;
      provs.forEach((p) => { const v = val(d, p); if (!v) return; const h = (v / max) * (H - 30); yy -= h; bars += '<rect x="' + (pad + i * bw + 1).toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + h.toFixed(1) + '" style="fill:' + FILL[p] + '"><title>' + esc(dayText(d) + ', ' + provName(p) + ': ' + cur + ' ' + num(v)) + '</title></rect>'; });
      if (i % 7 === 0) bars += '<text x="' + (pad + i * bw + 1).toFixed(1) + '" y="' + (H - 4) + '" style="fill:var(--muted);font-size:10px">' + esc(dayText(d)) + '</text>';
    });
    const grid = [0.5, 1].map((f) => { const yy = H - 18 - f * (H - 30); return '<line x1="' + pad + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '" style="stroke:var(--line2)"></line><text x="0" y="' + (yy + 3) + '" style="fill:var(--muted);font-size:10px">' + esc(num(max * f, 0)) + '</text>'; }).join('');
    const sum = (p) => rows.filter((r) => r.provider === p).reduce((n, r) => n + r.amount, 0);
    if (!rows.length) return UI.empty('No spend ingested this month', 'Daily rows appear after the first billing fetch of an account (job cloud.costs.ingest, daily).', '');
    return '<svg class="cloud-spend-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Daily cloud spend in ' + monthName(month) + ' by provider, stacked bars, in ' + cur) + '">' + grid + bars + '</svg>'
      + '<div class="hstack wrap gap12" style="font-size:12px">' + provs.map((p) => '<span class="hstack gap4"><i class="cloud-spend-key" style="background:' + FILL[p] + '"></i>' + esc(provName(p)) + ' <span class="muted num">' + money(sum(p), cur) + '</span></span>').join('') + '</div>';
  }

  App.register({
    id: 'cloud-spend', title: 'Cloud spend', section: 'admin', crumb: ['Admin', 'Cloud spend'], live: true,
    summary: 'Spend by cloud account, budgets with hard stop, showback, anomalies, model token cost, billing sources',
    commands: [
      { label: 'Set a cloud budget', sub: 'Cloud spend', run(app) { const s = app.stateFor('cloud-spend'); s.tab = 'budgets'; s.openBudget = true; app.render(); } },
      { label: 'Export showback CSV', sub: 'Cloud spend', run(app) { const s = app.stateFor('cloud-spend'); s.tab = 'showback'; app.render(); } }
    ],
    states: [
      { title: 'No accounts connected', tone: 'neutral', text: 'No cloud account is connected yet, so there is nothing to ingest or budget. The page points to Cloud accounts.', apply(ctx) { ctx.state.view = 'empty'; ctx.rerender(); } },
      { title: 'Loading', tone: 'neutral', text: 'Spend, budgets and forecasts load from cloud_costs; skeleton rows hold the layout.', apply(ctx) { ctx.state.view = 'loading'; ctx.rerender(); } },
      { title: 'Ingestion failed', tone: 'danger', text: 'A provider refused the daily ingestion. Yesterday stays an estimate until the credential allows it.', apply(ctx) { const st = ctx.state; st.view = null; st.tab = 'sources'; st.banner = 'ingest'; ctx.rerender(); } },
      { title: 'Budget hard stop', tone: 'danger', text: 'An account is past 100 % of its budget. Plans that add monthly cost are refused with budget_exceeded; scale-down and destroy still run.', apply(ctx) { const st = ctx.state; st.view = null; st.tab = 'budgets'; const a = accountsOf(st).find((x) => x.stopped); if (a) st.sel = a.id; st.banner = a ? null : 'hardstop'; ctx.rerender(); } },
      { title: 'Anomaly detected', tone: 'warn', text: 'A service\'s daily spend in an account is well above its 14-day baseline. The top contributors are listed with an acknowledge action.', apply(ctx) { const st = ctx.state; st.view = null; st.banner = null; st.tab = 'anomalies'; const an = ((st.data && st.data.anomalies && st.data.anomalies.anomalies) || []).find((x) => x.state === 'open'); if (an) st.selAn = an.id; ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'A member without finops:read opens Cloud spend. Nothing loads; the page names the permission and the roles that hold it.', apply(ctx) { ctx.state.view = 'denied'; ctx.rerender(); } },
      { title: 'Estimates only', tone: 'info', text: 'An account has no billing data yet. Until its first billing ingestion, its figures are estimates from plans and metered usage, marked as such.', apply(ctx) { const st = ctx.state; st.view = null; st.banner = null; st.tab = 'overview'; st.estimates = true; const a = accountsOf(st).find((x) => x.source === 'estimate'); if (a) st.sel = a.id; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.tab) { st.tab = 'overview'; st.sbBy = 'workspace'; st.top = {}; }
      if ((ctx.params.tab || ctx.params.anomaly || ctx.params.account) && st.paramHash !== location.hash) {
        st.paramHash = location.hash;
        if (ctx.params.tab) st.tab = ctx.params.tab;
        if (ctx.params.anomaly) { st.tab = 'anomalies'; st.selAn = ctx.params.anomaly; }
        if (ctx.params.account) st.sel = ctx.params.account;
      }
      const month = thisMonth();
      const refresh = () => {
        if (App.state.route !== 'cloud-spend') return;
        if (overlayOpen()) return;
        ctx.rerender();
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        const soft = (p) => p.catch((err) => ({ error: err }));
        Promise.all([
          App.get('/api/admin/cloud/costs'),
          soft(App.get('/api/admin/cloud/budgets')),
          soft(App.get('/api/admin/cloud/spend?month=' + enc(month))),
          soft(App.get('/api/admin/cloud/anomalies')),
          soft(App.get('/api/admin/cloud/showback?month=' + enc(month))),
          soft(App.get('/api/admin/cloud/showback/settings'))
        ])
          .then(([costs, budgets, spend, anomalies, showback, settings]) => { st.data = { costs, budgets: budgets.error ? null : budgets, spend, anomalies, showback, settings: settings.error ? null : settings }; st.loadError = null; })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; st.loaded = true; refresh(); });
      };
      const reload = () => { st.loaded = false; load(); };
      if (!st.loaded && !st.loading) load();

      const style = '<style>.cloud-spend-chart{width:100%;height:auto;display:block}.cloud-spend-key{display:inline-block;width:10px;height:10px;border-radius:2px}.cloud-spend-bar{height:8px;border-radius:3px;background:var(--line2);overflow:hidden;display:flex;min-width:60px}.cloud-spend-bar i{display:block;height:100%}.cloud-spend-name{overflow-wrap:anywhere}</style>';
      const canManage = App.can('finops:manage');
      const head = (actions) => UI.pagehead('Cloud spend', esc(monthName(month)) + ' to date. Budgets, showback and anomalies across AWS, Azure, DigitalOcean and Cloudflare', actions);
      const actions = UI.btn('Export showback', { icon: 'download', attrs: 'data-export' }) + (canManage ? UI.btn('Set budget', { kind: 'primary', attrs: 'data-budget' }) : '');
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('click', '[data-reset]', () => { st.view = null; st.banner = null; ctx.rerender(); });

      // ---------- permission denied ----------
      const denied = st.view === 'denied' || (st.loadError && st.loadError.status === 403);
      if (denied) {
        const p = (st.loadError && st.loadError.problem) || {};
        root.innerHTML = style + '<div class="page">' + UI.pagehead('Cloud spend', 'Spend, budgets and showback')
          + UI.problem('You need finops:read', 'Cloud spend is for the FinOps analyst and Cloud admin roles (finops:read), and cloud operators see the accounts they may read (cloud:read). Ask a tenant admin for one of those roles, or see Roles and access for the explain steps.', p.trace_id || false)
          + '<div class="hstack gap6">' + (st.view === 'denied' ? UI.btn('Back to Cloud spend', { size: 'sm', attrs: 'data-reset' }) : '') + UI.btn('Open Roles and access', { size: 'sm', attrs: 'data-go="roles"' }) + '</div></div>';
        return;
      }
      if (st.loadError) {
        const missing = st.loadError.problem && st.loadError.problem.reason === 'migration_pending';
        root.innerHTML = style + '<div class="page">' + head('') + (missing
          ? UI.empty('Billing ingestion is not installed', 'Cloud spend reads the ingested daily cost rows. It fills in once the cloud cost migration has been applied and a billing fetch has run.', UI.btn('Check again', { attrs: 'data-reload' }))
          : UI.problem('Cloud spend could not be loaded', detailOf(st.loadError), (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>') + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; reload(); });
        return;
      }
      // ---------- loading ----------
      if (st.view === 'loading' || !st.loaded) {
        const sk = '<div class="skeleton" style="height:14px"></div>';
        root.innerHTML = style + '<div class="page" aria-busy="true">' + head('') + '<div class="stats">' + [1, 2, 3, 4].map(() => '<div class="stat">' + sk + '<div class="skeleton" style="width:60%"></div></div>').join('') + '</div>'
          + UI.panel('Daily spend', '<div class="skeleton" style="height:150px"></div>') + UI.panel('Accounts', [1, 2, 3, 4, 5].map(() => sk).join(''))
          + (st.view === 'loading' ? '<span class="muted" style="font-size:12px">Loading spend from cloud_costs</span><div>' + UI.btn('Show the figures', { size: 'sm', attrs: 'data-reset' }) + '</div>' : '<span class="muted" style="font-size:12px">Loading…</span>') + '</div>';
        return;
      }
      const accts = accountsOf(st);
      // ---------- no accounts ----------
      if (st.view === 'empty' || !accts.length) {
        root.innerHTML = style + '<div class="page">' + head('') + UI.empty('No cloud accounts connected', 'Connect an AWS, Azure, DigitalOcean or Cloudflare account first. Spend is ingested daily from its billing API, and budgets apply per account.', UI.btn('Open Cloud accounts', { kind: 'primary', attrs: 'data-go="cloud"' }) + (st.view === 'empty' && accts.length ? ' ' + UI.btn('Back to Cloud spend', { attrs: 'data-reset' }) : '')) + '</div>';
        return;
      }

      const d = st.data;
      const spend = d.spend && !d.spend.error ? d.spend : null;
      const anomalies = d.anomalies && !d.anomalies.error ? d.anomalies.anomalies : null;
      const openAn = anomalies ? anomalies.filter((a) => a.state === 'open').length : 0;
      const cur = mainCurrency(accts);
      const stopped = accts.filter((a) => a.stopped && !(a.override && a.override.active));
      if (!accts.some((a) => a.id === st.sel)) st.sel = accts[0].id;
      const sel = accts.find((a) => a.id === st.sel);
      const isEst = (a) => a.source === 'estimate';
      const tabs = UI.tabs([{ id: 'overview', label: 'Overview' }, { id: 'budgets', label: 'Budgets', count: accts.filter((a) => a.budget != null).length }, { id: 'showback', label: 'Showback' }, { id: 'anomalies', label: 'Anomalies', count: openAn }, { id: 'tokens', label: 'Model tokens' }, { id: 'sources', label: 'Sources' }], st.tab);
      let body = '';
      let insp = '';

      // Top services of the selected account, loaded once per account.
      if (sel && st.top[sel.id] === undefined) {
        st.top[sel.id] = null;
        App.get('/api/admin/cloud/accounts/' + enc(sel.id) + '/costs?by=service').then((r) => { st.top[sel.id] = (r.rows || r.groups || r.items || []).filter((x) => x.currency === sel.currency).sort((a, b) => b.amount - a.amount).slice(0, 5); }).catch(() => { st.top[sel.id] = []; }).finally(refresh);
      }

      const acctInsp = (a) => {
        const top = st.top[a.id];
        const fp = a.fpct || 0;
        return '<div class="hstack"><div class="eyebrow grow">Cloud account</div><span class="pill outline">' + esc(provName(a.provider)) + '</span></div><div class="mono cloud-spend-name" style="font-size:14px;font-weight:600">' + esc(a.name) + '</div><div class="muted" style="font-size:12px">' + esc(provName(a.provider)) + ', ' + esc(a.scope) + ' scope</div>'
          + (isEst(a) ? UI.notice('<b>Estimates only.</b> ' + esc(a.reason) + ' Until the first billing ingestion its figures come from applied plans and metered usage.', 'info') : '')
          + (a.budget != null
            ? UI.meter('Spent', money(a.mtd, a.currency) + ' of ' + money(a.budget, a.currency, 0) + (isEst(a) ? ' (estimate)' : ''), a.pct, toneOf(a.pct)) + UI.meter('Forecast for ' + monthName(month), money(a.forecast, a.currency) + ', ' + fp + ' %', fp, toneOf(fp))
            : UI.kv([['Spent this month', money(a.mtd, a.currency)], ['Budget', 'none']], 2))
          + (a.others ? '<div class="muted" style="font-size:12px">Also billed in other currencies, never converted: ' + a.others + '</div>' : '')
          + (a.pending.length ? UI.notice('Override requested for ' + esc(Math.round(a.pending[0].hours / 24 * 10) / 10) + ' days, waiting for a second cloud admin. The hard stop holds until it is approved on Cloud accounts.', 'warn')
            : a.override && a.override.active ? UI.notice('An override lifts the hard stop until ' + esc(when(a.override.expiresAt)) + '.', 'warn')
              : a.stopped ? UI.notice('<b>Hard stop.</b> Plans that add monthly cost are refused with <span class="mono">budget_exceeded</span>. Scale-down and destroy still run.', 'danger', canManage || App.can('cloud:admin') ? UI.btn('Request override', { size: 'xs', attrs: 'data-override="' + esc(a.id) + '"' }) : '') : '')
          + '<div class="eyebrow">Alerts</div>' + thresholds(a)
          + '<div class="eyebrow">Top services</div>' + (top == null ? '<div class="skeleton"></div>' : UI.table(['Service', { label: 'This month', right: true }], top.map((t) => [esc(t.key || t.service), '<span class="num">' + money(t.amount, t.currency) + '</span>']), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No billed services yet', emptyText: 'Nothing was ingested for this account this month.' }))
          + '<span class="muted" style="font-size:12px">' + (a.lastFetch ? 'Billing fetched ' + esc(when(a.lastFetch.at)) + ' (' + esc(a.lastFetch.state) + ').' : 'No billing fetch yet.') + '</span>'
          + '<div class="hstack wrap gap6">' + (canManage ? UI.btn(a.budget != null ? 'Edit budget' : 'Set budget', { size: 'sm', kind: 'primary', attrs: 'data-budget="' + esc(a.id) + '"' }) : '') + UI.btn('Open account', { size: 'sm', attrs: 'data-goacct="' + esc(a.id) + '"' }) + '</div>';
      };
      const acctRow = (a, cells) => ({ cells, attrs: 'data-acct="' + esc(a.id) + '" tabindex="0"', selected: a.id === sel.id });

      if (st.tab === 'overview') {
        const inCur = accts.filter((a) => a.currency === cur);
        const total = inCur.reduce((n, a) => n + a.mtd, 0);
        const budgeted = inCur.filter((a) => a.budget != null);
        const budgetSum = budgeted.reduce((n, a) => n + a.budget, 0);
        const fc = budgeted.reduce((n, a) => n + a.forecast, 0);
        const over = accts.filter((a) => a.budget != null && a.forecast >= a.budget).length;
        const saved = spend ? spend.savings.filter((x) => x.currency === cur) : [];
        const estAccts = accts.filter(isEst);
        body += (stopped.length ? UI.notice('<b>Hard stop:</b> ' + stopped.map((a) => '<span class="mono">' + esc(a.name) + '</span> at ' + esc(a.pct) + ' %').join(', ') + '. New resources in these accounts are refused until the budget resets next month or an override is approved.', 'danger', UI.btn('Budgets', { size: 'xs', attrs: 'data-tabgo="budgets"' })) : '')
          + (st.estimates || estAccts.length ? UI.notice('Some figures are estimates: ' + (estAccts.length ? estAccts.map((a) => '<span class="mono">' + esc(a.name) + '</span>').join(', ') + ' ' + (estAccts.length === 1 ? 'has' : 'have') + ' no fresh billing data yet. The daily ingestion replaces the estimates.' : 'every account has fresh billing data now.'), 'info') : '')
          + '<div class="stats">' + UI.stat(money(total, cur, 0), 'Spent in ' + monthName(month), budgetSum ? esc(pctOf(total, budgetSum)) + ' % of ' + money(budgetSum, cur, 0) + ' in budgets' : 'no budgets set')
          + UI.stat(budgeted.length ? money(fc, cur, 0) : '–', 'Forecast at month end', esc(over) + ' accounts forecast over budget')
          + UI.stat(esc(String(stopped.length)), 'Accounts under hard stop', stopped.length ? esc(stopped.map((a) => a.name).join(', ')) : 'none')
          + UI.stat(saved.length && saved.some((x) => x.saving != null) ? money(saved.reduce((n, x) => n + (x.saving || 0), 0), cur, 0) : money(0, cur, 0), 'Saved by idle GPU scale-down', esc(num(saved.reduce((n, x) => n + x.hours, 0), 0)) + ' GPU-hours scaled to zero') + '</div>'
          + UI.panel('Daily spend by provider', spend ? chart(spend.daily, cur, month) : UI.notice('The daily figures could not be loaded: ' + esc(detailOf(d.spend.error)), 'warn'), { actions: '<span class="muted" style="font-size:12px">' + esc(cur) + ', ' + esc(monthName(month)) + '</span>' })
          + UI.table(['Account', 'Provider', { label: 'Spent', right: true }, { label: 'Budget', right: true }, { label: 'Used', width: '160px' }, { label: 'Forecast', right: true }, 'Alerts'], accts.map((a) => acctRow(a, [
            '<span class="mono" style="font-weight:600">' + esc(a.name) + '</span>' + (a.scope !== 'platform' ? '<div class="muted" style="font-size:11px">' + esc(a.scope) + ' scope</div>' : ''),
            esc(provName(a.provider)),
            '<span class="num">' + money(a.mtd, a.currency) + (isEst(a) ? ' <span class="muted">est.</span>' : '') + '</span>',
            '<span class="num">' + (a.budget != null ? money(a.budget, a.currency, 0) : '<span class="muted">none</span>') + '</span>',
            a.budget != null ? UI.meter('', a.pct + ' %', a.pct, toneOf(a.pct)) : '',
            '<span class="num"' + (a.fpct >= 100 ? ' style="color:var(--danger-fg)"' : '') + '>' + (a.forecast != null ? money(a.forecast, a.currency) : '<span class="muted">–</span>') + '</span>',
            thresholds(a)])), { minWidth: '900px' })
          + '<span class="muted" style="font-size:12px">Amounts stay in the currency each account bills in; they are never converted or added across currencies.</span>';
        insp = acctInsp(sel);
      }

      if (st.tab === 'budgets') {
        body += (st.banner === 'hardstop' ? UI.notice('<b>Hard stop.</b> No account is past 100 % of its budget now. When one is, plans that add monthly cost are refused with <span class="mono">budget_exceeded</span>; scale-down and destroy still run.', 'danger', UI.btn('Dismiss', { size: 'xs', attrs: 'data-reset' })) : '')
          + '<div class="grid2">' + UI.panel('How budgets work', '<div class="fg2" style="font-size:12px">Each cloud account has a monthly budget in its billing currency. Alerts go out at 50, 80 and 100 % of actual spend and of the month-end forecast, as notices to FinOps readers and cloud admins and as the event cloud.budget.alert to webhooks. With hard stop on, a plan that adds monthly cost is refused once spend passes 100 %; scale-down, destroy and repairs always run. An override needs a second cloud admin, a reason, and lasts at most 7 days.</div>')
          + UI.panel('This month', UI.kv([['Accounts at or over 100 %', '<span class="num">' + accts.filter((a) => a.budget != null && a.mtd >= a.budget).length + '</span>'], ['Forecast over 100 %', '<span class="num">' + accts.filter((a) => a.budget != null && a.forecast >= a.budget).length + '</span>'], ['Alerts sent', '<span class="num">' + accts.reduce((n, a) => n + a.alerts.length, 0) + '</span>'], ['Budgets reset', 'the 1st, 00:00 UTC']], 2)) + '</div>'
          + UI.table(['Account', { label: 'Budget', right: true }, { label: 'Spent', right: true }, { label: 'Forecast', right: true }, 'Alerts at 50, 80, 100 %', 'Hard stop', 'Recipients'], accts.map((a) => acctRow(a, [
            '<span class="mono" style="font-weight:600">' + esc(a.name) + '</span><div class="muted" style="font-size:11px">' + esc(provName(a.provider)) + '</div>',
            '<span class="num">' + (a.budget != null ? money(a.budget, a.currency, 0) : '<span class="muted">none</span>') + '</span>',
            '<span class="num">' + money(a.mtd, a.currency) + (a.budget != null ? ' (' + esc(a.pct) + ' %)' : '') + '</span>',
            '<span class="num">' + (a.forecast != null ? money(a.forecast, a.currency) : '–') + '</span>',
            thresholds(a),
            a.budget == null ? (canManage ? UI.btn('Set budget', { size: 'xs', attrs: 'data-budget="' + esc(a.id) + '" aria-label="Set budget for ' + esc(a.name) + '"' }) : '<span class="muted">–</span>')
              : canManage ? UI.toggle(a.hardStop === 'off' ? STOP_TEXT.off : (a.stopped ? 'On, stopping' : STOP_TEXT[a.hardStop]), a.hardStop !== 'off', 'data-manual="1" data-stop="' + esc(a.id) + '"') : esc(STOP_TEXT[a.hardStop]),
            '<span style="font-size:12px">FinOps readers and cloud admins</span>'])), { minWidth: '1000px' });
        insp = acctInsp(sel);
      }

      if (st.tab === 'showback') {
        const sb = d.showback;
        if (!sb || sb.error) {
          const e = sb && sb.error;
          body += e && e.status === 403 ? UI.notice('Showback needs finops:read. Cloud operators see the accounts and their spend, not how it is shown back to workspaces.', 'info')
            : UI.problem('Showback could not be loaded', detailOf(e), (e && e.problem && e.problem.trace_id) || false);
        } else {
          const byType = (bt, keys) => keys.reduce((n, k) => n + Number((bt || {})[k] || 0), 0);
          const cols4 = (bt) => [byType(bt, ['gpu']), byType(bt, ['model']), byType(bt, ['storage', 'database']), byType(bt, ['compute', 'network', 'other'])];
          const bar = (bt, amount) => '<div class="cloud-spend-bar" role="img" aria-label="Mix: GPU, model tokens, storage, other">' + cols4(bt).map((v, i) => '<i style="width:' + (amount ? Math.max(0, (v / amount) * 100) : 0) + '%;background:' + ['var(--accent)', 'var(--info-fg)', 'var(--ok-fg)', 'var(--meter)'][i] + '"></i>').join('') + '</div>';
          const rows = [];
          sb.tenants.forEach((t) => {
            if (st.sbBy === 'tenant') {
              const bt = {}; t.workspaces.forEach((w) => Object.keys(w.byType || {}).forEach((k) => { bt[k] = (bt[k] || 0) + Number(w.byType[k]); }));
              rows.push(['<span style="font-weight:600">' + esc(t.name) + '</span>', esc(t.currency)].concat(cols4(bt).map((v) => '<span class="num">' + num(v) + '</span>'), ['<span class="num" style="font-weight:600">' + num(t.amount) + '</span>', bar(bt, t.amount)]));
            } else t.workspaces.forEach((w) => rows.push(['<span style="font-weight:600">' + esc(w.name) + '</span>', esc(t.name), esc(t.currency)].concat(cols4(w.byType).map((v) => '<span class="num">' + num(v) + '</span>'), ['<span class="num" style="font-weight:600">' + num(w.amount) + '</span>', bar(w.byType, w.amount)])));
          });
          (sb.unallocated || []).forEach((u) => rows.push((st.sbBy === 'tenant' ? ['<span style="font-weight:600">Shared platform (unallocated)</span>'] : ['<span style="font-weight:600">Shared platform (unallocated)</span>', 'Platform']).concat([esc(u.currency)], cols4(u.byType).map((v) => '<span class="num">' + num(v) + '</span>'), ['<span class="num" style="font-weight:600">' + num(u.amount) + '</span>', bar(u.byType, u.amount)])));
          const s = d.settings;
          body += '<div class="toolbar">' + UI.seg([{ id: 'workspace', label: 'By workspace' }, { id: 'tenant', label: 'By tenant' }], st.sbBy, 'data-sb aria-label="Group showback"') + '<span class="muted right" style="font-size:12px">' + esc(monthName(month)) + ' to date, ' + sb.currencies.map((c) => money(c.allocated, c.currency) + ' shown back').join(', ') + '</span></div>'
            + UI.table((st.sbBy === 'tenant' ? ['Tenant'] : ['Workspace', 'Tenant']).concat(['Currency', { label: 'GPU', right: true }, { label: 'Model tokens', right: true }, { label: 'Storage', right: true }, { label: 'Other', right: true }, { label: 'Total', right: true }, { label: 'Mix', width: '140px' }]), rows, { clickable: false, minWidth: '860px', emptyTitle: 'Nothing to show back', emptyText: 'No ingested cloud costs for this month.' })
            + '<div class="hstack wrap gap12" style="font-size:12px">' + [['GPU', 'var(--accent)'], ['Model tokens', 'var(--info-fg)'], ['Storage', 'var(--ok-fg)'], ['Other', 'var(--meter)']].map(([l, c]) => '<span class="hstack gap4"><i class="cloud-spend-key" style="background:' + c + '"></i>' + esc(l) + '</span>').join('') + '</div>'
            + UI.panel('Allocation rules', UI.table(['Cost type', 'How shared cost is split'], (sb.rules || []).map((r) => [esc(r.name || TYPES[r.costType] || r.costType), esc(BASES[r.basis] || r.basis) + (r.default ? ' <span class="muted">(default)</span>' : '')]), { clickable: false, minWidth: '0', cls: 'bare' })
              + '<span class="muted" style="font-size:12px">Every resource Exprsn-AI creates carries the tags exprsn:tenant, exprsn:workspace and exprsn:pool where they apply. Shared costs are split by GPU time, tokens and stored bytes from usage records. Showback is informational; lines on billing statements are optional per tenant' + (s ? ', and ' + (s.statementLines ? 'on' : 'off') + ' for this one' : '') + '.</span>',
              { actions: UI.btn('Export CSV', { size: 'sm', icon: 'download', attrs: 'data-export' }) + (s && App.can(['finops:manage', 'tenant:manage']) && !s.statementLines && s.installed !== false ? UI.btn('Add to statements', { size: 'sm', attrs: 'data-statements' }) : '') + UI.btn('Open in Analytics', { size: 'sm', attrs: 'data-go="analytics"' }) });
        }
      }

      if (st.tab === 'anomalies') {
        const e = d.anomalies && d.anomalies.error;
        body += UI.notice('Anomalies compare each account\'s daily spend per service with its 14-day baseline (the median, with the median absolute deviation as its spread). A day at least 50 % and 50 above the baseline, and well outside its usual spread, opens an anomaly and notifies FinOps readers and cloud admins.', 'info');
        if (e) body += e.problem && e.problem.reason === 'migration_pending' ? UI.notice('Spend anomalies are not installed yet (migration 166_cloud_anomalies). Budgets and showback work without them.', 'warn') : UI.problem('Anomalies could not be loaded', detailOf(e), (e.problem && e.problem.trace_id) || false);
        else {
          if (!anomalies.some((a) => a.id === st.selAn) && anomalies.length) st.selAn = anomalies[0].id;
          const an = anomalies.find((a) => a.id === st.selAn);
          const where = (a) => [a.top.region && a.top.region.name, a.top.deployment && a.top.deployment.name].filter(Boolean).join(', ');
          const what = (a) => a.service + (a.increasePct != null ? ' +' + a.increasePct + ' %' : ', new spend');
          body += UI.table(['Anomaly', 'Account', 'Day', 'Where', { label: 'Actual', right: true }, { label: 'Baseline', right: true }, 'State'], anomalies.map((a) => ({
            cells: ['<span style="font-weight:600" class="cloud-spend-name">' + esc(what(a)) + '</span>', '<span class="mono">' + esc(a.account ? a.account.name : a.accountId) + '</span>', esc(dayText(a.day)), esc(where(a)), '<span class="num">' + money(a.actual, a.currency) + '/day</span>', '<span class="num">' + money(a.baseline, a.currency) + '/day</span>', UI.pill(a.state, a.state === 'open' ? 'warn' : 'ok')],
            attrs: 'data-an="' + esc(a.id) + '" tabindex="0"', selected: an && a.id === an.id
          })), { minWidth: '860px', emptyTitle: 'No anomalies', emptyText: 'Spend in every account is within its baseline.' });
          if (an) {
            insp = '<div class="hstack"><div class="eyebrow grow">Anomaly</div>' + UI.pill(an.state, an.state === 'open' ? 'warn' : 'ok') + '</div><div class="cloud-spend-name" style="font-size:15px;font-weight:600">' + esc(what(an)) + '</div><div class="muted" style="font-size:12px">' + esc((an.account ? an.account.name : an.accountId) + ', ' + (where(an) || provName(an.provider)) + ', ' + dayText(an.day)) + '</div>'
              + UI.kv([['Actual', money(an.actual, an.currency) + ' a day'], ['Baseline (' + an.historyDays + ' days)', money(an.baseline, an.currency) + ' a day'], ['Spread (MAD)', money(an.mad, an.currency)], ['Robust score', esc(num(an.score, 1))]], 2)
              + '<div class="eyebrow">Top contributors</div>' + UI.table(['Contributor', { label: 'Extra', right: true }], an.contributors.filter((c) => c.extra > 0).map((c) => ['<span class="muted" style="font-size:11px">' + esc(DIM_TEXT[c.dimension] || c.dimension) + '</span><div class="cloud-spend-name">' + esc(c.name) + '</div>', '<span class="num">' + money(c.extra, an.currency) + '</span>']), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No contributor stands out', emptyText: '' })
              + (an.state === 'acknowledged' ? UI.notice(an.suppressedBy ? 'Stored as acknowledged: an earlier anomaly of this account and service was acknowledged in the last three days, so no notice was sent.' : 'Acknowledged ' + esc(when(an.acknowledgedAt)) + (an.note ? ': ' + esc(an.note) : '.'), 'ok') : '')
              + '<div class="hstack wrap gap6">' + (an.state === 'open' && canManage ? UI.btn('Acknowledge', { kind: 'primary', size: 'sm', attrs: 'data-ack' }) : '') + (an.top.deployment && an.top.deployment.key ? UI.btn('Open deployment', { size: 'sm', attrs: 'data-godep="' + esc(an.top.deployment.key) + '"' }) : '') + UI.btn('Open account', { size: 'sm', attrs: 'data-goacct="' + esc(an.accountId) + '"' }) + '</div>';
          }
        }
      }

      if (st.tab === 'tokens') {
        const tokens = spend ? spend.tokens : [];
        const curs = {}; tokens.forEach((t) => { curs[t.currency] = (curs[t.currency] || 0) + t.cost; });
        const m = (n) => num(n / 1e6, n >= 1e7 || n === 0 ? 0 : 2) + ' M';
        body += UI.notice('Cloud model calls are priced when they are metered: each usage record gets its cost, currency and price from the model\'s price at that moment. Workers AI is priced in neurons.', 'info')
          + (spend ? '' : UI.notice('The model calls could not be loaded: ' + esc(detailOf(d.spend.error)), 'warn'))
          + UI.table(['Model', 'Provider', 'Profile', { label: 'Input', right: true }, { label: 'Output', right: true }, { label: 'Cost', right: true }], tokens.map((t) => [
            '<span class="mono cloud-spend-name">' + esc(t.model) + '</span>', esc(t.provider ? provName(t.provider) : 'unknown'), esc(t.profile || 'no profile'),
            '<span class="num">' + (t.neurons ? esc(num(t.neurons / 1e6, 1)) + ' M neurons' : esc(m(t.inputTokens))) + '</span>',
            '<span class="num">' + (t.neurons ? '<span class="muted">in neurons</span>' : t.outputTokens ? esc(m(t.outputTokens)) : '<span class="muted">embed</span>') + '</span>',
            '<span class="num" style="font-weight:600">' + money(t.cost, t.currency) + '</span>']), { clickable: false, minWidth: '820px', emptyTitle: 'No cloud model calls this month', emptyText: 'Calls through Bedrock, Azure AI Foundry, DigitalOcean GenAI or Workers AI appear here once they are metered.' })
          + '<div class="hstack"><span class="muted grow" style="font-size:12px">' + esc(monthName(month)) + ' to date. Per-model prices are on the model card in Models.</span><span class="num" style="font-weight:600">' + (Object.keys(curs).map((c) => money(curs[c], c)).join(', ') || money(0, cur)) + '</span></div>'
          + '<div>' + UI.btn('Open Models, cloud providers', { size: 'sm', attrs: 'data-models' }) + '</div>';
      }

      if (st.tab === 'sources') {
        const failed = accts.find((a) => a.lastFetch && a.lastFetch.state === 'failed');
        const problem = failed ? UI.problem('Ingestion failed: ' + provName(failed.provider) + ' (' + failed.name + ')', (failed.lastFetch.error || 'The provider refused the fetch.') + ' Its spend stays an estimate from plans until a fetch succeeds; the next try is the daily run.', false)
          : st.banner === 'ingest' ? UI.problem('Ingestion failed', 'When a provider refuses the daily ingestion (for example AccessDeniedException on ce:GetCostAndUsage), the account\'s spend stays an estimate from plans until the credential allows it. No fetch has failed right now.', false) : '';
        body += (problem ? '<div class="vstack gap6">' + problem + '<div class="hstack gap6">' + UI.btn('Check permissions', { size: 'sm', attrs: 'data-goacct="' + esc((failed || sel).id) + '"' }) + (failed && canManage ? UI.btn('Retry now', { size: 'sm', attrs: 'data-ingest="' + esc(failed.id) + '"' }) : '') + (st.banner === 'ingest' ? UI.btn('Dismiss', { size: 'sm', kind: 'ghost', attrs: 'data-reset' }) : '') + '</div></div>' : '')
          + UI.table(['Provider', 'API', 'Account', 'Last run', 'Next run', 'Result', 'State', { label: '', srLabel: 'Actions' }], accts.map((a) => {
            const f = a.lastFetch;
            const state = a.eligible ? 'not fetched' : f ? (f.state === 'ok' ? 'ok' : f.state) : 'waiting';
            return [esc(provName(a.provider)), '<span style="font-size:12px">' + esc(API_TEXT[a.provider] || '') + '</span>', '<span class="mono" style="font-size:12px">' + esc(a.name) + '</span>', esc(f ? when(f.at) : 'never'), esc(a.eligible ? '–' : 'daily'),
              '<span style="font-size:12px">' + esc(a.eligible ? a.eligible : f && f.state === 'failed' ? 'no rows, estimate kept' : f ? 'billing data, ' + (a.source === 'billing' ? 'used by the budget' : 'not fresh') : 'first fetch pending') + '</span>',
              UI.pill(state, state === 'ok' ? 'ok' : state === 'running' ? 'info' : state === 'failed' ? 'danger' : ''),
              canManage ? UI.btn('Ingest now', { size: 'xs', attrs: 'data-ingest="' + esc(a.id) + '" aria-label="Ingest now for ' + esc(a.name) + '"', disabled: !!a.eligible || (f && f.state === 'running') }) : ''];
          }), { clickable: false, minWidth: '1000px' })
          + '<span class="muted" style="font-size:12px">Ingestion runs daily as job cloud.costs.ingest per account. Cost Explorer charges per request, so it is grouped by tag in one call a day, and "Ingest now" is allowed once an hour per account. DigitalOcean has no daily cost API: the current invoice preview is ingested daily and replaced by invoice lines when the month closes.</span>';
      }

      root.innerHTML = style + '<div class="page">' + head(actions) + tabs + body + '</div>' + (insp ? '<aside class="inspector w360" aria-label="' + (st.tab === 'anomalies' ? 'Anomaly details' : 'Account details') + '">' + insp + '</aside>' : '');

      // ---------- handlers ----------
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; st.banner = null; ctx.rerender(); });
      ctx.on('click', '[data-tabgo]', (e, t) => { st.tab = t.dataset.tabgo; ctx.rerender(); });
      const pickAcct = (e, t) => { if (e.target.closest('.toggle, button')) return; st.sel = t.dataset.acct; ctx.rerender(); };
      const pickAn = (e, t) => { st.selAn = t.dataset.an; ctx.rerender(); };
      ctx.on('click', 'tr.row[data-acct]', pickAcct);
      ctx.on('click', 'tr.row[data-an]', pickAn);
      ctx.on('keydown', 'tr.row[data-acct], tr.row[data-an]', (e, t) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === t) { e.preventDefault(); if (t.dataset.acct) pickAcct(e, t); else pickAn(e, t); } });
      ctx.on('click', '[data-sb] [data-seg]', (e, t) => { st.sbBy = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-goacct]', (e, t) => ctx.navigate('cloud', { account: t.dataset.goacct }));
      ctx.on('click', '[data-godep]', (e, t) => ctx.navigate('deployments', { deployment: t.dataset.godep }));
      ctx.on('click', '[data-models]', () => ctx.navigate('models', { provider: 'cloud' }));
      ctx.on('click', '[data-export]', () => {
        const a = document.createElement('a'); a.href = '/api/admin/cloud/showback/export?month=' + enc(month) + '&format=csv'; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
        ctx.toast('Showback for ' + esc(monthName(month)) + ' is downloading as CSV (one row per workspace and cost type). The export is written to the audit chain.', 'ok', 5000);
      });
      ctx.on('click', '[data-statements]', async () => {
        const ok = await ctx.confirm({ title: 'Add showback to this tenant\'s statements', tag: 'informational', body: '<p class="fg2" style="margin:0">Each workspace\'s allocated cloud cost is listed as an informational line on this tenant\'s statements, next to the price-book charges. It is never part of a statement\'s total and never charged.</p>', ok: 'Add to statements' });
        if (!ok) return;
        try { await App.api('PUT', '/api/admin/cloud/showback/settings', { statementLines: true }); ctx.toast('Showback lines are on the statements. Audit entry cloud.showback.settings.updated written.', 'ok', 5000); reload(); } catch (err) { App.fail(err, 'Not changed'); }
      });
      ctx.on('click', '[data-ack]', () => {
        const an = anomalies && anomalies.find((a) => a.id === st.selAn); if (!an) return;
        const where = an.account ? an.account.name : '';
        ctx.modal({
          title: 'Acknowledge anomaly',
          body: '<p class="fg2" style="margin:0">Stops repeat notices for ' + esc(an.service) + ' in ' + esc(where) + ' for three days. If spend stays above the baseline after that, it opens again.</p>' + UI.field('Note', UI.input('', { placeholder: 'What explains it, or what you changed', attrs: 'data-acknote maxlength="500"' })) + '<div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Acknowledge', { kind: 'primary', attrs: 'data-ackgo' }),
          onMount(m) {
            m.querySelector('[data-ackgo]').addEventListener('click', async () => {
              const note = m.querySelector('[data-acknote]').value.trim();
              try {
                await App.post('/api/admin/cloud/anomalies/' + enc(an.id) + '/acknowledge', note ? { note } : {});
                App.closeOverlay();
                ctx.toast(esc(an.service) + ' in ' + esc(where) + ' acknowledged. Audit entry cloud.anomaly.acknowledged written.', 'ok');
                reload();
              } catch (err) { m.querySelector('[data-err]').innerHTML = UI.notice('<b>Not acknowledged.</b> ' + esc(detailOf(err)), 'danger'); }
            });
          }
        });
      });
      ctx.on('click', '[data-ingest]', async (e, t) => {
        const a = accts.find((x) => x.id === t.dataset.ingest); if (!a || t.disabled) return;
        const ok = await ctx.confirm({ title: 'Ingest billing now for ' + a.name, body: '<p class="fg2" style="margin:0">Fetches the last 14 days and this month from ' + esc(API_TEXT[a.provider] || provName(a.provider)) + ' as job cloud.costs.ingest. Each fetch is a provider request (Cost Explorer charges per request), so it is allowed once an hour per account.</p>', ok: 'Ingest now' });
        if (!ok) return;
        try { await App.post('/api/admin/cloud/accounts/' + enc(a.id) + '/costs/fetch'); ctx.toast('Ingestion started for ' + esc(a.name) + ' as job cloud.costs.ingest. Anomalies are checked when it finishes.', 'ok', 5000); setTimeout(reload, 1500); } catch (err) { App.fail(err, 'Not started'); }
      });
      ctx.on('click', '[data-stop]', async (e, t) => {
        e.stopPropagation(); const a = accts.find((x) => x.id === t.dataset.stop); if (!a || a.budget == null) return;
        const on = a.hardStop === 'off';
        const ok = await ctx.confirm({ title: (on ? 'Turn on hard stop for ' : 'Turn off hard stop for ') + a.name, tone: on ? undefined : 'danger', tag: on ? 'hard stop' : 'alerts only', body: '<p class="fg2" style="margin:0">' + (on ? 'Once actual spend passes 100 % of the budget, plans that add monthly cost are refused. Scale-down, destroy and repairs still run.' : 'Alerts continue at 50, 80 and 100 %, but nothing is refused when the budget is passed.') + ' The change needs finops:manage and is audited as cloud.budget.updated.</p>', ok: on ? 'Turn on' : 'Turn off' });
        if (!ok) return;
        try { await App.api('PUT', '/api/admin/cloud/accounts/' + enc(a.id) + '/budget', { amount: a.budget, currency: a.currency, hardStop: on ? 'actual' : 'off' }); ctx.toast('Hard stop ' + (on ? 'on' : 'off') + ' for ' + esc(a.name) + '. Audit entry cloud.budget.updated written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not changed'); }
      });
      const budgetModal = (id) => {
        const a = accts.find((x) => x.id === id) || sel;
        ctx.modal({
          title: 'Budget for ' + esc(a.name),
          body: '<div class="formgrid" style="--cols:2">' + UI.field('Monthly budget (' + esc(a.currency) + ')', UI.input(a.budget != null ? String(a.budget) : '', { type: 'number', attrs: 'data-f="amount" min="1" step="1" inputmode="decimal"' })) + UI.field('Period', UI.input('Calendar month, UTC', { readonly: true, attrs: 'data-f="period"' }))
            + '<div class="span2">' + UI.field('Hard stop', UI.select([{ value: 'actual', label: STOP_TEXT.actual }, { value: 'forecast', label: STOP_TEXT.forecast }, { value: 'off', label: STOP_TEXT.off }], a.hardStop || 'actual', 'data-f="stop"'), 'Plans that add monthly cost are refused past 100 %. Scale-down and destroy always run.') + '</div></div>'
            + UI.notice('Alerts go out at 50, 80 and 100 % of actual spend and of the forecast, to FinOps readers and cloud admins. Alerts already sent this month are not sent again for the same threshold unless the amount changes.', 'info') + '<div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save budget', { kind: 'primary', attrs: 'data-save' }),
          onMount(m) {
            m.querySelector('[data-save]').addEventListener('click', async () => {
              const v = Number(m.querySelector('[data-f="amount"]').value);
              if (!(v > 0)) { m.querySelector('[data-err]').innerHTML = UI.notice('Enter a monthly amount above 0.', 'warn'); m.querySelector('[data-f="amount"]').focus(); return; }
              try {
                await App.api('PUT', '/api/admin/cloud/accounts/' + enc(a.id) + '/budget', { amount: v, currency: a.currency, hardStop: m.querySelector('[data-f="stop"]').value });
                App.closeOverlay(); st.sel = a.id; ctx.toast('Budget for ' + esc(a.name) + ' set to ' + money(v, a.currency, 0) + '. Audit entry cloud.budget.set written.', 'ok'); reload();
              } catch (err) { m.querySelector('[data-err]').innerHTML = UI.notice('<b>Not saved.</b> ' + esc(detailOf(err)), 'danger'); }
            });
          }
        });
      };
      ctx.on('click', '[data-budget]', (e, t) => { if (canManage) budgetModal(t.dataset.budget || sel.id); });
      if (st.openBudget) { st.openBudget = false; if (canManage) setTimeout(() => budgetModal(sel.id), 50); }
      ctx.on('click', '[data-override]', (e, t) => {
        const a = accts.find((x) => x.id === t.dataset.override); if (!a) return;
        ctx.modal({
          title: 'Request budget override for ' + esc(a.name) + ' ' + UI.pill('dual control', 'warn'),
          body: '<p class="fg2" style="margin:0">Lets new resources through the hard stop for a limited time. A second cloud admin must approve it on Cloud accounts; alerts continue while it runs.</p>'
            + UI.kv([['Spent', money(a.mtd, a.currency) + ' of ' + money(a.budget, a.currency, 0)], ['Forecast', money(a.forecast, a.currency)]], 2)
            + '<div class="formgrid" style="--cols:2">' + UI.field('Duration', UI.select([{ value: '24', label: '1 day' }, { value: '72', label: '3 days' }, { value: '168', label: '7 days (maximum)' }], '72', 'data-f="hours"')) + '<div class="span2">' + UI.field('Reason', UI.textarea('', { placeholder: 'Why new resources must start before the budget resets', rows: 3, attrs: 'data-f="reason" maxlength="500"' }), 'At least 10 characters.') + '</div></div><div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send for approval', { kind: 'primary', attrs: 'data-send' }),
          onMount(m) {
            m.querySelector('[data-send]').addEventListener('click', async () => {
              const r = m.querySelector('[data-f="reason"]');
              if (r.value.trim().length < 10) { r.focus(); m.querySelector('[data-err]').innerHTML = UI.notice('A reason of at least 10 characters is required for an override.', 'warn'); return; }
              try {
                await App.post('/api/admin/cloud/accounts/' + enc(a.id) + '/budget/overrides', { reason: r.value.trim(), hours: Number(m.querySelector('[data-f="hours"]').value) });
                App.closeOverlay(); ctx.toast('Override for ' + esc(a.name) + ' sent for approval. It takes effect when a second cloud admin approves it.', 'ok', 5000); reload();
              } catch (err) { m.querySelector('[data-err]').innerHTML = UI.notice('<b>Not sent.</b> ' + esc(detailOf(err)), 'danger'); }
            });
          }
        });
      });
    }
  });
})();
