(function () {
  const { UI, esc } = App;

  // 1.6.0, Sprint 38a (B-7401, B-7402): usage and cost analytics over the metering records, the tenant's prices and
  // the chargeback export. Everything on this screen comes from /api/admin/analytics/*.
  const DIMS = [['workspace', 'Per workspace'], ['group', 'Per group'], ['model', 'Per model'], ['profile', 'Per profile'], ['user', 'Per user']];
  const PERIODS = [{ value: 'today', label: 'Today' }, { value: '7', label: 'Last 7 days' }, { value: '14', label: 'Last 14 days' }, { value: '30', label: 'Last 30 days' }, { value: 'month', label: 'This month' }, { value: 'lastmonth', label: 'Last month' }];
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const ymd = (d) => d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
  const money = (v, cur) => v == null ? '<span class="muted" title="A model or pool in this row has no price">no price</span>' : esc(cur || '') + ' ' + Number(v).toFixed(v < 1 ? 4 : 2);
  const dayLabel = (s) => { const d = new Date(s + 'T00:00:00Z'); return d.getUTCDate() + ' ' + d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }); };
  const isSysAdmin = () => (App.me.roles || []).some((r) => r.id === 'system-admin');

  function chart(st, daily) {
    const W = 600, H = 160, L = 40, R = 590, top = 20, base = 130;
    const key = st.metric === 'messages' ? 'messages' : st.metric === 'runs' ? 'runs' : 'tokens';
    const vals = daily.map((d) => d[key]);
    const max = Math.max(1, Math.max.apply(null, vals)) * 1.1;
    const y = (v) => base - (v / max) * (base - top);
    const n = Math.max(1, vals.length), gap = (R - 44) / n, bw = Math.max(6, Math.min(22, gap - 6));
    let bars = '';
    vals.forEach((v, i) => {
      const x = 44 + i * gap; const yy = y(v); const hov = st.hover === i;
      bars += '<g class="an-bar' + (hov ? ' hov' : '') + '" data-bar="' + i + '" tabindex="0" role="listitem" aria-label="' + esc(dayLabel(daily[i].day)) + ', ' + fmt(v) + ' ' + esc(st.metric) + '">'
        + '<rect x="' + (x - 3) + '" y="' + top + '" width="' + gap + '" height="' + (base - top) + '" fill="transparent"></rect>'
        + '<path d="M' + x + ' ' + base + ' V' + (yy + 3) + ' a3 3 0 0 1 3 -3 h' + (bw - 6) + ' a3 3 0 0 1 3 3 V' + base + ' z" fill="' + (hov || i === vals.length - 1 ? 'var(--accent)' : 'var(--meter)') + '"></path>'
        + '<title>' + esc(dayLabel(daily[i].day)) + ': ' + fmt(v) + ' ' + esc(st.metric) + '</title></g>';
    });
    const short = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(Math.round(v));
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="160" role="img" aria-label="' + esc(st.metric) + ' per day" style="display:block;font-family:var(--sans)">'
      + '<g stroke="var(--line2)"><line x1="' + L + '" y1="' + top + '" x2="' + R + '" y2="' + top + '"></line><line x1="' + L + '" y1="' + (top + (base - top) / 2) + '" x2="' + R + '" y2="' + (top + (base - top) / 2) + '"></line></g>'
      + '<line x1="' + L + '" y1="' + base + '" x2="' + R + '" y2="' + base + '" stroke="var(--faint)"></line>'
      + '<g role="list">' + bars + '</g>'
      + '<g font-size="11" fill="var(--muted)"><text x="34" y="24" text-anchor="end">' + short(max) + '</text><text x="34" y="79" text-anchor="end">' + short(max / 2) + '</text><text x="34" y="134" text-anchor="end">0</text>'
      + (daily.length ? '<text x="44" y="148">' + esc(dayLabel(daily[0].day)) + '</text><text x="570" y="148" text-anchor="end">' + esc(dayLabel(daily[daily.length - 1].day)) + '</text>' : '') + '</g></svg>';
  }

  App.register({
    id: 'analytics', title: 'Analytics', section: 'admin', crumb: ['Admin', 'Analytics'], live: true,
    summary: 'Messages, tokens, users, runs and cost by workspace, group, model, profile and user; prices and chargeback',
    commands: [
      { label: 'Chargeback export for a workspace', sub: 'Analytics', run(app) { app.stateFor('analytics').openChargeback = true; app.render(); } },
      { label: 'Set a model price', sub: 'Analytics', run(app) { app.stateFor('analytics').openPrice = true; app.render(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.by = st.by || 'workspace'; st.period = st.period || '14'; st.metric = st.metric || 'tokens';
      if (st.by === 'tenant' && !isSysAdmin()) st.by = 'workspace';
      const canPrice = App.can('tenant:manage');
      const refresh = () => { if (App.state.route !== 'analytics') return; if (document.getElementById('overlay')) { st.dirty = true; return; } ctx.rerender(); };
      const onClose = () => { if (st.dirty) { st.dirty = false; refresh(); } };
      const range = () => {
        const now = new Date();
        if (st.period === 'month') return 'from=' + ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))) + '&to=' + ymd(now);
        if (st.period === 'lastmonth') { const f = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); return 'from=' + ymd(f) + '&to=' + ymd(t); }
        return 'days=' + (st.period === 'today' ? 1 : st.period);
      };
      const q = () => 'by=' + st.by + '&' + range() + (st.workspace ? '&workspace=' + encodeURIComponent(st.workspace) : '');
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        const key = q();
        Promise.all([App.get('/api/admin/analytics/summary?' + key), App.get('/api/admin/analytics/daily?' + range() + (st.workspace ? '&workspace=' + encodeURIComponent(st.workspace) : '')), App.get('/api/admin/analytics/prices'), App.can('tenant:manage') ? App.get('/api/admin/quotas').catch(() => null) : null])
          .then(([summary, daily, prices, quotas]) => { Object.assign(st, { summary, daily, prices: prices.prices, quotas, loaded: key, loadError: null }); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; refresh(); });
      };
      if (st.loaded !== q() && !st.loadError && !st.loading) load();
      const reload = () => { st.loaded = null; st.loadError = null; ctx.rerender(); };

      const summary = st.summary || { rows: [], total: {}, currency: null };
      const rows = summary.rows || [];
      const total = summary.total || {};
      const daily = st.daily || [];
      const prices = st.prices || [];
      const cur = summary.currency;
      const noPrices = !prices.length;
      const dims = DIMS.concat(isSysAdmin() ? [['tenant', 'Per tenant']] : []);
      const dimLabel = (dims.find((d) => d[0] === st.by) || DIMS[0])[1].replace('Per ', '');
      const sel = st.sel != null ? rows.find((r) => r.key === st.sel) : null;
      const periodText = summary.from ? (summary.from === summary.to ? dayLabel(summary.from) : dayLabel(summary.from) + ' to ' + dayLabel(summary.to)) : '';
      const wsOpts = [{ value: '', label: 'All workspaces' }].concat(((st.quotas && st.quotas.workspaces) || []).map((w) => ({ value: w.id, label: w.name })));

      let body;
      if (st.loadError) body = UI.problem('Analytics could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-reload' }) + '</div>';
      else if (!st.summary) body = UI.notice('Loading…', 'info');
      else {
        const chartPanel = UI.panel(st.metric.charAt(0).toUpperCase() + st.metric.slice(1) + ' per day, ' + esc(periodText), '<div class="an-chart">' + chart(st, daily) + '</div>'
          + '<div class="muted" style="font-size:12px">A day\'s totals are the metering records of that day: the same rows the quotas count.</div>',
          { actions: UI.seg([{ id: 'messages', label: 'Messages' }, { id: 'runs', label: 'Runs' }, { id: 'tokens', label: 'Tokens' }], st.metric, 'data-metric aria-label="Chart metric"') });
        const totals = UI.panel('Totals, ' + esc(periodText), '<div class="grid2">' + UI.stat('Messages', fmt(total.messages)) + UI.stat('Agent and workflow runs', fmt(total.runs)) + UI.stat('Tokens', fmt(total.tokens)) + UI.stat('Cost', total.cost == null ? (noPrices ? 'no prices' : 'partly priced') : esc(cur || '') + ' ' + Number(total.cost).toFixed(2)) + '</div>'
          + (noPrices ? UI.notice('<b>No prices set.</b> ' + (canPrice ? 'Add a price per model, and a pool price for whatever else runs there, to see costs.' : 'A tenant admin can add prices per model and pool.') + ' Usage is counted either way.', 'info', canPrice ? UI.btn('Set a price', { size: 'sm', attrs: 'data-price' }) : '') : ''));
        const table = '<div class="hstack wrap"><div class="eyebrow">Usage by</div>' + UI.seg(dims.map((d) => ({ id: d[0], label: d[1] })), st.by, 'data-byseg aria-label="Dimension"')
          + '<span class="right hstack gap6">' + (wsOpts.length > 1 && st.by !== 'tenant' ? UI.select(wsOpts, st.workspace || '', 'data-ws aria-label="Workspace" style="width:160px"') : '') + UI.select(PERIODS, st.period, 'data-period aria-label="Period" style="width:150px"') + UI.iconbtn('refresh', 'Refresh', { attrs: 'data-reload', cls: 'sm ghost' }) + '</span></div>'
          + UI.table([dimLabel, { label: 'Messages', right: true }, { label: 'Runs', right: true }, { label: 'Users', right: true }, { label: 'Tokens', right: true }, { label: 'GPU-s', right: true }, { label: 'Cost', right: true }],
            rows.map((r) => ({ cells: ['<b>' + esc(r.name) + '</b>', fmt(r.messages), fmt(r.runs), fmt(r.users), fmt(r.tokens), fmt(Math.round(r.gpuMs / 1000)), money(r.cost, r.currency)], attrs: 'data-key="' + esc(r.key || '') + '"', selected: !!sel && sel.key === r.key }))
              .concat(rows.length ? [{ cells: ['<b>Total</b>', '<b>' + fmt(total.messages) + '</b>', '<b>' + fmt(total.runs) + '</b>', '', '<b>' + fmt(total.tokens) + '</b>', '<b>' + fmt(Math.round((total.gpuMs || 0) / 1000)) + '</b>', '<b>' + money(total.cost, cur) + '</b>'], attrs: 'data-total' }] : []),
            { minWidth: '720px', emptyTitle: 'No usage in this period', emptyText: 'Nothing was metered for this period and selection.' })
          + '<div class="muted" style="font-size:12px">Messages are answered turns (chat, compare, API and channels); runs are agent and workflow runs. Tokens include prompt, output and thinking tokens. A row\'s cost is withheld when a model or pool in it has no price, so a partial figure never reads as a total.</div>';
        const pricesPanel = UI.panel('Prices' + (cur ? ', ' + esc(cur) : ''), (noPrices ? UI.empty('No prices', 'One currency per tenant; a model price wins over its pool\'s.', '') : UI.table(['Scope', 'Model or pool', { label: 'Per M input', right: true }, { label: 'Per M output', right: true }, { label: 'Per GPU-hour', right: true }, 'Note', ''],
          prices.map((p) => [esc(p.scope), '<span class="mono">' + esc(p.ref) + '</span>', Number(p.inputPerMillion).toFixed(4), Number(p.outputPerMillion).toFixed(4), Number(p.gpuHour).toFixed(4), esc(p.note || ''), canPrice ? UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-rmprice="' + esc(p.id) + '" aria-label="Remove the price of ' + esc(p.ref) + '"' }) : '']), { cls: 'bare', minWidth: '0', clickable: false }))
          + '<div class="muted" style="font-size:12px">Energy or a set rate for local models: a GPU-hour price covers what runs on this hardware; token prices suit metered providers. Changes are audited.</div>',
          { actions: canPrice ? UI.btn('Add price', { size: 'sm', icon: 'plus', attrs: 'data-price' }) : '' });
        body = '<div class="an-top">' + chartPanel + totals + '</div>' + table + pricesPanel;
      }

      let insp = '';
      if (sel) {
        insp = '<div class="eyebrow">' + esc(dimLabel) + '</div><div style="font-size:15px;font-weight:600;overflow-wrap:anywhere">' + esc(sel.name) + '</div>'
          + UI.kv([['Messages', fmt(sel.messages)], ['Runs', fmt(sel.runs)], ['Users', fmt(sel.users)], ['Prompt tokens', fmt(sel.prompt)], ['Output tokens', fmt(sel.output)], ['Thinking tokens', fmt(sel.thinking)], ['GPU-seconds', fmt(Math.round(sel.gpuMs / 1000))], ['Cost', money(sel.cost, sel.currency)], ['Period', esc(periodText)]], 1)
          + (sel.cost == null && !noPrices ? UI.notice('<b>No price for part of this row.</b> A model or pool in it has no price, so its cost is withheld rather than shown short.', 'warn') : '')
          + '<div class="vstack gap6">' + (st.by === 'workspace' && sel.key ? UI.btn('Chargeback export', { size: 'sm', icon: 'download', attrs: 'data-chargeback="' + esc(sel.key) + '"' }) : '') + UI.btn('Open Usage and audit', { size: 'sm', attrs: 'data-go="usage-audit"' }) + '</div>';
      } else insp = '<div class="eyebrow">Analytics</div><div class="fg2" style="font-size:12px">Pick a row for its detail. Model spans carry <span class="mono">gen_ai.usage.input_tokens</span> and <span class="mono">gen_ai.usage.output_tokens</span>, so the same counts reach Grafana or any OTLP backend.</div>';

      root.innerHTML = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}'
        + '.an-chart svg .an-bar{cursor:pointer}.an-chart svg .an-bar:hover path,.an-chart svg .an-bar:focus path{fill:var(--accent)}.an-chart svg .an-bar:focus{outline:none}'
        + '.an-top{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px}@media (max-width:1100px){.an-top{grid-template-columns:1fr}}</style>'
        + '<div class="page">' + UI.pagehead('Analytics', 'Messages, tokens, users and runs by workspace, group, model, profile and user, with the cost at your prices', UI.btn('Chargeback export', { icon: 'download', attrs: 'data-chargeback' }))
        + body + '</div>'
        + '<aside class="inspector w300">' + insp + '</aside>';

      if (st.openChargeback && st.summary) { st.openChargeback = false; setTimeout(() => chargebackModal(), 30); }
      if (st.openPrice && st.summary) { st.openPrice = false; setTimeout(priceModal, 30); }

      function chargebackModal(workspaceId) {
        const now = new Date();
        const months = [0, 1, 2].map((i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); return { value: d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0'), label: d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) + (i === 0 ? ' (so far)' : '') }; });
        ctx.modal({
          title: 'Chargeback export', onClose,
          body: '<div class="formgrid">' + UI.field('Workspace', UI.select(wsOpts.length > 1 ? wsOpts : [{ value: '', label: 'All workspaces' }], workspaceId || st.workspace || '', 'data-cbws')) + UI.field('Month', UI.select(months, months[0].value, 'data-cbmonth')) + UI.field('Format', UI.select([{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }], 'csv', 'data-cbformat')) + '</div>'
            + UI.notice('One line per model and pool with tokens, GPU-seconds and cost, and a total line. The total equals what this screen shows for the same workspace and month. The export is audited.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Export', { kind: 'primary', attrs: 'data-cbgo' }),
          onMount(m) {
            m.querySelector('[data-cbgo]').addEventListener('click', () => {
              const ws = m.querySelector('[data-cbws]').value, month = m.querySelector('[data-cbmonth]').value, format = m.querySelector('[data-cbformat]').value;
              App.closeOverlay();
              const a = document.createElement('a'); a.href = '/api/admin/analytics/chargeback?month=' + encodeURIComponent(month) + '&format=' + format + (ws ? '&workspace=' + encodeURIComponent(ws) : ''); a.download = ''; document.body.appendChild(a); a.click(); a.remove();
              ctx.toast('Chargeback export started. The export is written to the audit chain.', 'ok');
            });
          }
        });
      }
      function priceModal(price) {
        const p = price || {};
        ctx.modal({
          title: price ? 'Change the price of ' + esc(price.ref) : 'Set a price', onClose,
          body: '<div class="formgrid" style="--cols:2">' + UI.field('Scope', UI.select([{ value: 'model', label: 'Model' }, { value: 'pool', label: 'Pool' }], p.scope || 'model', 'data-pscope')) + UI.field('Model name or pool id', UI.input(p.ref || '', { attrs: 'data-pref' }), 'The model name as the catalogue lists it, or a pool id') + UI.field('Currency', UI.input(p.currency || cur || 'EUR', { attrs: 'data-pcur' }), 'One currency per tenant') + UI.field('Per million input tokens', UI.input(p.inputPerMillion != null ? String(p.inputPerMillion) : '0', { attrs: 'data-pin' })) + UI.field('Per million output tokens', UI.input(p.outputPerMillion != null ? String(p.outputPerMillion) : '0', { attrs: 'data-pout' })) + UI.field('Per GPU-hour', UI.input(p.gpuHour != null ? String(p.gpuHour) : '0', { attrs: 'data-pgpu' }), 'Energy or a set rate for local models') + UI.field('Note', UI.input(p.note || '', { attrs: 'data-pnote', placeholder: 'How the rate was set' })) + '</div><div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save price', { kind: 'primary', attrs: 'data-pgo' }),
          onMount(m) {
            m.querySelector('[data-pgo]').addEventListener('click', () => {
              const v = (s) => m.querySelector(s).value;
              App.api('PUT', '/api/admin/analytics/prices', { scope: v('[data-pscope]'), ref: v('[data-pref]').trim(), currency: v('[data-pcur]').trim(), inputPerMillion: +v('[data-pin]') || 0, outputPerMillion: +v('[data-pout]') || 0, gpuHour: +v('[data-pgpu]') || 0, note: v('[data-pnote]').trim() || null })
                .then((saved) => { App.closeOverlay(); st.dirty = false; ctx.toast('Price saved for ' + esc(saved.ref) + '. Audited analytics.price.set.', 'ok'); reload(); })
                .catch((err) => { const p2 = err.problem || {}; m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(p2.title || 'Not saved') + '.</b> ' + esc(p2.detail || err.message), 'danger'); });
            });
          }
        });
      }

      ctx.on('click', '[data-byseg] [data-seg]', (e, t) => { st.by = t.dataset.seg; st.sel = null; ctx.rerender(); });
      ctx.on('click', '[data-metric] [data-seg]', (e, t) => { st.metric = t.dataset.seg; ctx.rerender(); });
      ctx.on('change', '[data-period]', (e, t) => { st.period = t.value; st.sel = null; ctx.rerender(); });
      ctx.on('change', '[data-ws]', (e, t) => { st.workspace = t.value || null; st.sel = null; ctx.rerender(); });
      ctx.on('click', 'tr[data-key]', (e, t) => { st.sel = t.dataset.key || null; ctx.rerender(); });
      ctx.on('mouseover', '.an-bar', (e, t) => { const i = +t.dataset.bar; if (st.hover !== i) { st.hover = i; ctx.rerender(); } });
      ctx.on('mouseout', '.an-chart', (e, t) => { if (st.hover != null && !(e.relatedTarget && t.contains(e.relatedTarget))) { st.hover = null; ctx.rerender(); } });
      ctx.on('focusin', '.an-bar', (e, t) => { const i = +t.dataset.bar; if (st.hover !== i) { st.hover = i; ctx.rerender(); const b = ctx.$('.an-bar[data-bar="' + i + '"]'); if (b) b.focus(); } });
      ctx.on('click', '[data-chargeback]', (e, t) => chargebackModal(t.dataset.chargeback || null));
      ctx.on('click', '[data-price]', () => priceModal());
      ctx.on('click', '[data-rmprice]', (e, t) => {
        const p = prices.find((x) => x.id === t.dataset.rmprice); if (!p) return;
        ctx.confirm({ title: 'Remove the price of ' + esc(p.ref), tone: 'danger', body: '<p class="fg2" style="margin:0">Rows that only this price covered show "no price" from now on. Audited analytics.price.removed.</p>', ok: 'Remove' }).then((ok) => {
          if (!ok) return;
          App.del('/api/admin/analytics/prices/' + encodeURIComponent(p.id)).then(() => { ctx.toast('Price removed.', 'ok'); reload(); }).catch((err) => App.fail(err, 'Not removed'));
        });
      });
      ctx.on('click', '[data-reload]', () => reload());
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
    }
  });
})();
