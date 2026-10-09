(function () {
  const { UI, esc } = App;

  // ---------- data (example figures for Northwind, last 14 days) ----------
  const DAYS = ['26 Sep', '27 Sep', '28 Sep', '29 Sep', '30 Sep', '1 Oct', '2 Oct', '3 Oct', '4 Oct', '5 Oct', '6 Oct', '7 Oct', '8 Oct', '9 Oct'];
  const DAILY = [
    { msgs: 1180, runs: 42, tokens: 1986400 }, { msgs: 1322, runs: 51, tokens: 2269100 }, { msgs: 410, runs: 9, tokens: 850200 }, { msgs: 380, runs: 7, tokens: 790300 },
    { msgs: 1490, runs: 63, tokens: 2967000 }, { msgs: 1410, runs: 58, tokens: 2751100 }, { msgs: 1260, runs: 47, tokens: 2068800 }, { msgs: 1302, runs: 49, tokens: 2129400 },
    { msgs: 455, runs: 11, tokens: 915600 }, { msgs: 402, runs: 8, tokens: 829000 }, { msgs: 1540, runs: 66, tokens: 3167400 }, { msgs: 1488, runs: 61, tokens: 3038900 },
    { msgs: 1397, runs: 55, tokens: 2846000 }, { msgs: 980, runs: 37, tokens: 2101200 }
  ];
  const ROWS = {
    workspace: [
      { name: 'Finance Ops', msgs: 8120, runs: 311, users: 46, tokens: 15842300, gpu: 18240, cost: 184.31 },
      { name: 'People Ops', msgs: 2810, runs: 64, users: 19, tokens: 4120900, gpu: 3910, cost: 41.02 },
      { name: 'Field Sales', msgs: 4086, runs: 189, users: 71, tokens: 8747200, gpu: 9080, cost: 96.55 },
      { name: 'No workspace', msgs: 0, runs: 0, users: 2, tokens: 0, gpu: 0, cost: 0 }
    ],
    group: [
      { name: 'Analysts', msgs: 5210, runs: 240, users: 18, tokens: 10210400, gpu: 11870, cost: 118.40 },
      { name: 'Controllers', msgs: 1930, runs: 51, users: 9, tokens: 3480100, gpu: 4020, cost: 40.73 },
      { name: 'Account executives', msgs: 3612, runs: 162, users: 54, tokens: 7651800, gpu: 7940, cost: 84.20 },
      { name: 'No group', msgs: 4264, runs: 111, users: 55, tokens: 7368100, gpu: 7400, cost: null }
    ],
    model: [
      { name: 'qwen2.5:32b-q4_K_M', msgs: 9240, runs: 402, users: 88, tokens: 18906500, gpu: 24300, cost: 236.21 },
      { name: 'llama3.1:8b-q5_K_M', msgs: 5776, runs: 162, users: 64, tokens: 8120300, gpu: 6440, cost: 54.11 },
      { name: 'bge-m3 (embed)', msgs: 0, runs: 0, users: 41, tokens: 1683600, gpu: 490, cost: 3.21 },
      { name: 'system (Apple, on-device)', msgs: 0, runs: 0, users: 3, tokens: 0, gpu: 0, cost: null }
    ],
    profile: [
      { name: 'analyst', msgs: 7410, runs: 395, users: 52, tokens: 15210000, gpu: 20100, cost: 198.04 },
      { name: 'general', msgs: 6128, runs: 112, users: 101, tokens: 10802800, gpu: 9880, cost: 90.30 },
      { name: 'fast', msgs: 1478, runs: 57, users: 33, tokens: 2697600, gpu: 1250, cost: 5.54 }
    ],
    user: [
      { name: 'Data analyst agent', kind: 'agent', msgs: 0, runs: 311, users: 1, tokens: 6184100, gpu: 9460, cost: 92.40 },
      { name: 'Mara Okafor', msgs: 1842, runs: 92, users: 1, tokens: 3071500, gpu: 4120, cost: 40.11 },
      { name: 'Tomasz Wieczorek', msgs: 1306, runs: 41, users: 1, tokens: 2228000, gpu: 2910, cost: 28.70 },
      { name: 'svc-close-bot', kind: 'service account', msgs: 2880, runs: 0, users: 1, tokens: 3301200, gpu: 402, cost: 6.02 }
    ],
    tenant: [
      { name: 'Northwind', msgs: 15016, runs: 564, users: 136, tokens: 28710400, gpu: 31230, cost: 321.88 },
      { name: 'Contoso Freight', msgs: 1203, runs: 22, users: 14, tokens: 2104100, gpu: 1180, cost: 12.95 }
    ]
  };
  const PRICES = [
    { scope: 'model', ref: 'qwen2.5:32b-q4_K_M', input: 0.40, output: 1.20, gpu: 2.80, note: 'energy at 0.31 €/kWh, H100 node' },
    { scope: 'model', ref: 'llama3.1:8b-q5_K_M', input: 0.08, output: 0.24, gpu: 1.10, note: '' },
    { scope: 'pool', ref: 'gpu-large', input: 0, output: 0, gpu: 2.80, note: 'what no model price covers' }
  ];
  const DIMS = [['workspace', 'Per workspace'], ['group', 'Per group'], ['model', 'Per model'], ['profile', 'Per profile'], ['user', 'Per user'], ['tenant', 'Per tenant']];
  const fmt = (n) => n.toLocaleString('en-US');
  const money = (n) => n == null ? '<span class="muted" title="A model or pool in this row has no price">no price</span>' : '€' + n.toFixed(2);

  function chart(st) {
    const W = 600, H = 160, L = 40, R = 590, top = 20, base = 130;
    const key = st.metric === 'messages' ? 'msgs' : st.metric === 'runs' ? 'runs' : 'tokens';
    const vals = DAILY.map((d) => d[key]);
    const max = Math.max.apply(null, vals) * 1.1;
    const y = (v) => base - (v / max) * (base - top);
    const bw = 22, gap = 38;
    let bars = '';
    vals.forEach((v, i) => {
      const x = 44 + i * gap; const yy = y(v); const hov = st.hover === i;
      bars += '<g class="an-bar' + (hov ? ' hov' : '') + '" data-bar="' + i + '" tabindex="0" role="listitem" aria-label="' + DAYS[i] + ', ' + fmt(v) + ' ' + st.metric + '">'
        + '<rect x="' + (x - 8) + '" y="' + top + '" width="' + gap + '" height="' + (base - top) + '" fill="transparent"></rect>'
        + '<path d="M' + x + ' ' + base + ' V' + (yy + 4) + ' a4 4 0 0 1 4 -4 h' + (bw - 8) + ' a4 4 0 0 1 4 4 V' + base + ' z" fill="' + (hov || i === vals.length - 1 ? 'var(--accent)' : 'var(--meter)') + '"></path>'
        + '<title>' + DAYS[i] + ': ' + fmt(v) + ' ' + st.metric + '</title></g>';
    });
    const short = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(v);
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="160" role="img" aria-label="' + esc(st.metric) + ' per day, last 14 days" style="display:block;font-family:var(--sans)">'
      + '<g stroke="var(--line2)"><line x1="' + L + '" y1="' + top + '" x2="' + R + '" y2="' + top + '"></line><line x1="' + L + '" y1="' + (top + (base - top) / 2) + '" x2="' + R + '" y2="' + (top + (base - top) / 2) + '"></line></g>'
      + '<line x1="' + L + '" y1="' + base + '" x2="' + R + '" y2="' + base + '" stroke="var(--faint)"></line>'
      + '<g role="list">' + bars + '</g>'
      + '<g font-size="11" fill="var(--muted)"><text x="34" y="24" text-anchor="end">' + short(max) + '</text><text x="34" y="79" text-anchor="end">' + short(max / 2) + '</text><text x="34" y="134" text-anchor="end">0</text><text x="44" y="148">' + DAYS[0] + '</text><text x="570" y="148" text-anchor="end">' + DAYS[13] + '</text></g></svg>';
  }

  App.register({
    id: 'analytics', title: 'Analytics', section: 'admin', crumb: ['Admin', 'Analytics'],
    summary: 'Messages, tokens, users, runs and cost by workspace, group, model, profile and user; prices and chargeback',
    commands: [
      { label: 'Chargeback export for a workspace', sub: 'Analytics', run(app) { app.stateFor('analytics').openChargeback = true; app.render(); } },
      { label: 'Set a model price', sub: 'Analytics', run(app) { app.stateFor('analytics').openPrice = true; app.render(); } }
    ],
    states: [
      { title: 'No prices yet', tone: 'neutral', text: 'Without a price per model or pool every cost reads "no price"; the usage figures are unaffected.', apply(ctx) { ctx.state.noPrices = true; ctx.rerender(); } },
      { title: 'Partly priced row', tone: 'warn', text: 'A row with records that no price covers shows "no price" instead of a partial total.', apply(ctx) { ctx.state.by = 'group'; ctx.state.sel = 3; ctx.rerender(); } },
      { title: 'Across tenants', tone: 'neutral', text: 'The tenant dimension is for system admins; others see their tenant only.', apply(ctx) { ctx.state.by = 'tenant'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.by = st.by || 'workspace'; st.period = st.period || '14 days'; st.metric = st.metric || 'tokens'; st.prices = st.prices || PRICES.slice();
      if (st.sel == null) st.sel = 0;
      const rows = ROWS[st.by];
      const total = rows.reduce((a, r) => ({ msgs: a.msgs + r.msgs, runs: a.runs + r.runs, users: a.users + r.users, tokens: a.tokens + r.tokens, gpu: a.gpu + r.gpu, cost: a.cost == null || r.cost == null ? null : a.cost + r.cost }), { msgs: 0, runs: 0, users: 0, tokens: 0, gpu: 0, cost: 0 });
      const noPrices = !!st.noPrices || !st.prices.length;
      const cost = (r) => noPrices ? money(null) : money(r.cost);
      const sel = rows[st.sel] || rows[0];

      const chartPanel = UI.panel(st.metric.charAt(0).toUpperCase() + st.metric.slice(1) + ' per day, Northwind, last 14 days', '<div class="an-chart">' + chart(st) + '</div>'
        + '<div class="muted" style="font-size:12px">A day\'s totals are the metering records of that day: the same rows the quotas count.</div>',
        { actions: UI.seg([{ id: 'messages', label: 'Messages' }, { id: 'runs', label: 'Runs' }, { id: 'tokens', label: 'Tokens' }], st.metric, 'data-metric aria-label="Chart metric"') });
      const totals = UI.panel('Totals, ' + esc(st.period), '<div class="grid2">' + UI.stat('Messages', fmt(total.msgs)) + UI.stat('Agent and workflow runs', fmt(total.runs)) + UI.stat('Tokens', fmt(total.tokens)) + UI.stat('Cost', noPrices ? 'no price' : '€' + (total.cost == null ? '—' : total.cost.toFixed(2))) + '</div>'
        + (noPrices ? UI.notice('<b>No prices set.</b> Add a price per model (and a pool price for whatever else runs there) to see costs. Usage is counted either way.', 'info', UI.btn('Set a price', { size: 'sm', attrs: 'data-price' })) : ''));

      const table = '<div class="hstack wrap"><div class="eyebrow">Usage by</div>' + UI.seg(DIMS.map((d) => ({ id: d[0], label: d[1] })), st.by, 'data-byseg aria-label="Dimension"') + '<span class="right">' + UI.select(['Today', '7 days', '14 days', 'This month', 'Last month'], st.period, 'data-period aria-label="Period" style="width:150px"') + '</span></div>'
        + UI.table([DIMS.find((d) => d[0] === st.by)[1].replace('Per ', ''), { label: 'Messages', right: true }, { label: 'Runs', right: true }, { label: 'Users', right: true }, { label: 'Tokens', right: true }, { label: 'GPU-s', right: true }, { label: 'Cost', right: true }],
          rows.map((r, i) => ({ cells: ['<b>' + esc(r.name) + '</b>' + (r.kind ? ' <span class="muted">' + esc(r.kind) + '</span>' : ''), fmt(r.msgs), fmt(r.runs), fmt(r.users), fmt(r.tokens), fmt(r.gpu), cost(r)], attrs: 'data-row="' + i + '"', selected: st.sel === i }))
            .concat([{ cells: ['<b>Total</b>', '<b>' + fmt(total.msgs) + '</b>', '<b>' + fmt(total.runs) + '</b>', '<b>' + fmt(total.users) + '</b>', '<b>' + fmt(total.tokens) + '</b>', '<b>' + fmt(total.gpu) + '</b>', '<b>' + (noPrices || total.cost == null ? money(null) : money(total.cost)) + '</b>'], attrs: 'data-total' }]),
          { minWidth: '720px', emptyTitle: 'No usage in this period', emptyText: 'Nothing was metered for this period.' })
        + '<div class="muted" style="font-size:12px">Messages are answered turns (chat, compare, API and channels); runs are agent and workflow runs. Tokens include prompt, output and thinking tokens. A row\'s cost is null when a model or pool in it has no price, so a partial figure never reads as a total.</div>';

      const prices = UI.panel('Prices, EUR', (noPrices ? UI.empty('No prices', 'One currency per tenant; a model price wins over its pool\'s.', '') : UI.table(['Scope', 'Model or pool', { label: '€ / M input', right: true }, { label: '€ / M output', right: true }, { label: '€ / GPU-hour', right: true }, 'Note', ''],
        st.prices.map((p, i) => [esc(p.scope), '<span class="mono">' + esc(p.ref) + '</span>', p.input.toFixed(2), p.output.toFixed(2), p.gpu.toFixed(2), esc(p.note || ''), UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-rmprice="' + i + '"' })]), { cls: 'bare', minWidth: '0', clickable: false }))
        + '<div class="muted" style="font-size:12px">Energy or a set rate for local models: a GPU-hour price covers what runs on this hardware; token prices suit metered providers. Changes are audited (analytics.price.set).</div>',
        { actions: UI.btn('Add price', { size: 'sm', icon: 'plus', attrs: 'data-price' }) });

      const insp = '<div class="eyebrow">' + esc(DIMS.find((d) => d[0] === st.by)[1].replace('Per ', '')) + '</div><div style="font-size:15px;font-weight:600;overflow-wrap:anywhere">' + esc(sel.name) + '</div>'
        + UI.kv([['Messages', fmt(sel.msgs)], ['Runs', fmt(sel.runs)], ['Users', fmt(sel.users)], ['Tokens', fmt(sel.tokens)], ['GPU-seconds', fmt(sel.gpu)], ['Cost', cost(sel)], ['Period', esc(st.period)]], 1)
        + (sel.cost == null && !noPrices ? UI.notice('<b>No price for part of this row.</b> "system (Apple, on-device)" has no price, so this row\'s cost is withheld rather than shown short.', 'warn') : '')
        + '<div class="vstack gap6">' + (st.by === 'workspace' && sel.name !== 'No workspace' ? UI.btn('Chargeback export, this month', { size: 'sm', icon: 'download', attrs: 'data-chargeback' }) : '') + UI.btn('Open Usage and audit', { size: 'sm', attrs: 'data-go="usage-audit"' }) + '</div>'
        + '<div class="divider"></div><div class="eyebrow">Tracing</div><div class="fg2" style="font-size:12px">Model spans carry <span class="mono">gen_ai.usage.input_tokens</span> and <span class="mono">gen_ai.usage.output_tokens</span>, so the same counts reach Grafana or any OTLP backend.</div>';

      root.innerHTML = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}'
        + '.an-chart svg .an-bar{cursor:pointer}.an-chart svg .an-bar:hover path,.an-chart svg .an-bar:focus path{fill:var(--accent)}.an-chart svg .an-bar:focus{outline:none}'
        + '.an-top{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px}@media (max-width:1100px){.an-top{grid-template-columns:1fr}}</style>'
        + '<div class="page">' + UI.pagehead('Analytics', 'Messages, tokens, users and runs by workspace, group, model, profile and user, with the cost at your prices', UI.btn('Chargeback export', { icon: 'download', attrs: 'data-chargeback' }))
        + '<div class="an-top">' + chartPanel + totals + '</div>' + table + prices + '</div>'
        + '<aside class="inspector w300">' + insp + '</aside>';

      if (st.openChargeback) { st.openChargeback = false; setTimeout(chargebackModal, 50); }
      if (st.openPrice) { st.openPrice = false; setTimeout(priceModal, 50); }

      function chargebackModal() {
        ctx.modal({
          title: 'Chargeback export',
          body: '<div class="formgrid">' + UI.field('Workspace', UI.select(['Finance Ops', 'People Ops', 'Field Sales', 'Every workspace'], st.by === 'workspace' && sel.name !== 'No workspace' ? sel.name : 'Every workspace', 'data-cbws')) + UI.field('Month', UI.select(['October 2026 (so far)', 'September 2026', 'August 2026'], 'September 2026', 'data-cbmonth')) + UI.field('Format', UI.select(['CSV', 'JSON'], 'CSV', 'data-cbformat')) + '</div>'
            + UI.notice('One line per model and pool with tokens, GPU-seconds and cost, and a total line. The total equals what this screen shows for the same workspace and month. The export is audited.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Export', { kind: 'primary', attrs: 'data-cbgo' }),
          onMount(m) { m.querySelector('[data-cbgo]').addEventListener('click', () => { const ws = m.querySelector('[data-cbws]').value; App.closeOverlay(); ctx.toast('Downloading chargeback-northwind-' + esc(ws.toLowerCase().replace(/ /g, '-')) + '-2026-09.csv. Audited analytics.chargeback.exported.', 'ok'); }); }
        });
      }
      function priceModal() {
        ctx.modal({
          title: 'Set a price',
          body: '<div class="formgrid" style="--cols:2">' + UI.field('Scope', UI.select(['Model', 'Pool'], 'Model', 'data-pscope')) + UI.field('Model or pool', UI.input('qwen2.5-coder:32b-q4_K_M', { attrs: 'data-pref' })) + UI.field('€ per million input tokens', UI.input('0.40', { attrs: 'data-pin' })) + UI.field('€ per million output tokens', UI.input('1.20', { attrs: 'data-pout' })) + UI.field('€ per GPU-hour', UI.input('2.80', { attrs: 'data-pgpu' }), 'Energy or a set rate for local models') + UI.field('Note', UI.input('', { attrs: 'data-pnote', placeholder: 'How the rate was set' })) + '</div>'
            + UI.notice('One currency per tenant (EUR here). A model price wins over the pool price for the same records.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save price', { kind: 'primary', attrs: 'data-pgo' }),
          onMount(m) { m.querySelector('[data-pgo]').addEventListener('click', () => { st.prices.push({ scope: m.querySelector('[data-pscope]').value.toLowerCase(), ref: m.querySelector('[data-pref]').value, input: +m.querySelector('[data-pin]').value || 0, output: +m.querySelector('[data-pout]').value || 0, gpu: +m.querySelector('[data-pgpu]').value || 0, note: m.querySelector('[data-pnote]').value }); st.noPrices = false; App.closeOverlay(); ctx.rerender(); ctx.toast('Price saved. Audited analytics.price.set.', 'ok'); }); }
        });
      }

      ctx.on('click', '[data-byseg] [data-seg]', (e, t) => { st.by = t.dataset.seg; st.sel = 0; ctx.rerender(); });
      ctx.on('click', '[data-metric] [data-seg]', (e, t) => { st.metric = t.dataset.seg; ctx.rerender(); });
      ctx.on('change', '[data-period]', (e, t) => { st.period = t.value; ctx.rerender(); ctx.toast('Recomputed for ' + esc(t.value) + '.'); });
      ctx.on('click', 'tr[data-row]', (e, t) => { st.sel = +t.dataset.row; ctx.rerender(); });
      ctx.on('mouseover', '.an-bar', (e, t) => { const i = +t.dataset.bar; if (st.hover !== i) { st.hover = i; ctx.rerender(); } });
      ctx.on('mouseout', '.an-chart', (e, t) => { if (st.hover != null && !(e.relatedTarget && t.contains(e.relatedTarget))) { st.hover = null; ctx.rerender(); } });
      ctx.on('focusin', '.an-bar', (e, t) => { const i = +t.dataset.bar; if (st.hover !== i) { st.hover = i; ctx.rerender(); const b = ctx.$('.an-bar[data-bar="' + i + '"]'); if (b) b.focus(); } });
      ctx.on('click', '[data-chargeback]', () => chargebackModal());
      ctx.on('click', '[data-price]', () => priceModal());
      ctx.on('click', '[data-rmprice]', (e, t) => { st.prices.splice(+t.dataset.rmprice, 1); ctx.rerender(); ctx.toast('Price removed. Audited analytics.price.removed.'); });
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
    }
  });
})();
