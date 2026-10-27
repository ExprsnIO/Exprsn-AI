(function () {
  // 1.9.99-final, Sprint 61 (B-10604): the Analytics screen's "Cloud showback" view. analytics.js adds the tab for
  // holders of finops:read, draws App.analyticsShowback.body(st) inside its view and calls
  // App.analyticsShowback.bind(ctx, st, rerender) on every render. Everything here comes from
  // /api/admin/cloud/showback*: the month's ingested cloud costs shown back per tenant and workspace, per currency
  // (never converted), the unallocated line (platform admins), the CSV export, the platform's allocation rules and the
  // tenant's "show on statements" setting.
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const TYPES = { gpu: 'GPU time', model: 'Model APIs', compute: 'Compute and clusters', database: 'Databases and caches', storage: 'Object storage', network: 'Network and front door', other: 'Other' };
  const BASES = { gpu_time: 'GPU time', tokens: 'Tokens', model_cost: 'Model cost', requests: 'Requests', storage: 'Storage used', even: 'Evenly', unallocated: 'Leave unallocated' };
  const money = (n, cur) => esc(cur || '') + ' ' + Number(n || 0).toFixed(2);
  const monthOpts = () => {
    const now = new Date();
    return [0, 1, 2, 3].map((i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); const v = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); return { value: v, label: d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) + (i === 0 ? ' (so far)' : '') }; });
  };
  const topType = (byType) => { const e = Object.entries(byType || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]; return e ? esc(TYPES[e[0]] || e[0]) : ''; };

  function state(st) {
    st.sb = st.sb || {};
    if (!st.sb.month) st.sb.month = monthOpts()[0].value;
    return st.sb;
  }

  function load(st, refresh) {
    const sb = state(st);
    const gen = (sb.gen = (sb.gen || 0) + 1);
    sb.loading = true;
    const key = sb.month;
    Promise.all([App.get('/api/admin/cloud/showback?month=' + enc(key)), App.get('/api/admin/cloud/showback/settings').catch(() => null)])
      .then(([data, settings]) => { if (gen === sb.gen) Object.assign(sb, { data, settings, loaded: key, error: null }); })
      .catch((err) => { if (gen === sb.gen) { sb.error = err; sb.loaded = key; } })
      .finally(() => { if (gen === sb.gen) { sb.loading = false; refresh(); } });
  }

  function body(st) {
    const sb = state(st);
    const head = '<div class="hstack wrap"><div class="eyebrow">Cloud costs shown back</div><span class="right hstack gap6">'
      + UI.select(monthOpts(), sb.month, 'data-sbmonth aria-label="Month" style="width:190px"')
      + UI.iconbtn('refresh', 'Refresh', { attrs: 'data-sbreload', cls: 'sm ghost' })
      + UI.btn('Export CSV', { size: 'sm', icon: 'download', attrs: 'data-sbexport' }) + '</span></div>';
    if (sb.error) {
      const p = sb.error.problem || {};
      if (p.reason === 'migration_pending' || sb.error.status === 503) return head + UI.notice('<b>Billing ingestion is not installed.</b> Showback reads the ingested cloud costs; it appears once the cloud cost migration has been applied and a billing fetch has run.', 'info');
      return head + UI.problem('Showback could not be loaded', sb.error.message, p.trace_id) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-sbreload' }) + '</div>';
    }
    if (!sb.data) return head + UI.notice('Loading…', 'info');
    const d = sb.data;
    const platform = App.can('platform:manage');
    const totals = UI.panel('Totals per currency', d.currencies.length
      ? '<div class="grid2">' + d.currencies.map((c) => UI.stat(money(c.allocated, c.currency), 'Shown back, ' + c.currency, platform ? 'Ingested ' + money(c.ingested, c.currency) + ', unallocated ' + money(c.unallocated, c.currency) : '')).join('') + '</div>'
      : UI.empty('No cloud costs this month', 'Nothing was ingested from the cloud accounts for this month yet.', ''));
    const rows = [];
    d.tenants.forEach((t) => {
      t.workspaces.forEach((w) => rows.push({ cells: [esc(t.name), w.workspaceId ? '<b>' + esc(w.name) + '</b>' : '<span class="muted">' + esc(w.name) + '</span>', esc(t.currency), money(w.amount, t.currency), topType(w.byType)], attrs: 'data-sbws="' + esc(w.workspaceId || '') + '"' }));
      rows.push({ cells: ['<b>' + esc(t.name) + '</b>', '<b>Tenant total</b>', esc(t.currency), '<b>' + money(t.amount, t.currency) + '</b>', ''], attrs: 'data-sbtenant="' + esc(t.tenantId) + '"' });
    });
    (d.unallocated || []).forEach((u) => rows.push({ cells: ['<b>Unallocated</b>', '<span class="muted">No tag or rule assigns it</span>', esc(u.currency), money(u.amount, u.currency), topType(u.byType)], attrs: 'data-sbunalloc' }));
    const table = UI.table(['Tenant', 'Workspace', 'Currency', { label: 'Amount', right: true }, 'Largest part'], rows, { clickable: false, minWidth: '560px', emptyTitle: 'Nothing to show back', emptyText: 'No ingested cloud costs for this month.' });
    const canRules = platform && App.can('finops:manage');
    const rules = UI.panel('Allocation rules', UI.table(['Cost type', 'Split by'], (d.rules || []).map((r) => [esc(r.name), esc(BASES[r.basis] || r.basis) + (r.default ? ' <span class="muted">(default)</span>' : '')]), { cls: 'bare', minWidth: '0', clickable: false })
      + '<div class="muted" style="font-size:12px">Tagged costs go to their workspace, pool or tenant. Shared costs (clusters, databases, the front door, model APIs) are split by the rule of their type across the month\'s metered usage; whatever no rule can place is unallocated.</div>',
      { actions: canRules ? UI.btn('Change rules', { size: 'sm', attrs: 'data-sbrules' }) : '' });
    const s = sb.settings;
    const canSet = App.can(['finops:manage', 'tenant:manage']);
    const setting = s ? UI.panel('Statements', (canSet ? UI.toggle('Show showback lines on this tenant\'s statements', !!s.statementLines, 'data-sbstmt' + (s.installed === false ? ' disabled' : '')) : '<div>' + (s.statementLines ? 'Showback lines are on this tenant\'s statements.' : 'Showback lines are not on this tenant\'s statements.') + '</div>')
      + '<div class="muted" style="font-size:12px">Informational lines only: they are never charged and never part of a statement\'s total. Off by default.</div>') : '';
    return head + totals + table + '<div class="muted" style="font-size:12px">Amounts stay in the currency each cloud bills in; currencies are never converted or added together. ' + (d.stored ? 'Computed ' + esc(new Date(d.computedAt).toLocaleString()) + '.' : 'Computed now from the ingested costs.') + '</div>' + rules + setting
      + '<div class="hstack wrap gap6"><span class="muted" style="font-size:12px">Budgets, anomalies and the billing sources are on Cloud spend.</span>' + UI.btn('Open Cloud spend', { size: 'sm', attrs: 'data-sbspend' }) + '</div>';
  }

  function rulesModal(ctx, st, reload) {
    const d = state(st).data || { rules: [] };
    ctx.modal({
      title: 'Allocation rules',
      body: '<div class="formgrid" style="--cols:2">' + d.rules.map((r) => UI.field(r.name, UI.select(Object.keys(BASES).map((b) => ({ value: b, label: BASES[b] })), r.basis, 'data-sbrule="' + esc(r.costType) + '"'))).join('') + '</div>'
        + UI.notice('The platform\'s rules: how shared costs of each type are split across workspaces. The change is audited and applies the next time a month is computed.', 'info') + '<div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save rules', { kind: 'primary', attrs: 'data-sbrulesgo' }),
      onMount(m) {
        m.querySelector('[data-sbrulesgo]').addEventListener('click', () => {
          const rules = {};
          m.querySelectorAll('[data-sbrule]').forEach((el) => { rules[el.dataset.sbrule] = el.value; });
          App.api('PUT', '/api/admin/cloud/showback/rules', { rules })
            .then(() => App.api('POST', '/api/admin/cloud/showback/' + enc(state(st).month) + '/compute', {}))
            .then(() => { App.closeOverlay(); ctx.toast('Rules saved and the month recomputed. Audited cloud.showback.rules.updated.', 'ok'); reload(); })
            .catch((err) => { const p = err.problem || {}; m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(p.title || 'Not saved') + '.</b> ' + esc(p.detail || err.message), 'danger'); });
        });
      }
    });
  }

  function bind(ctx, st, rerender) {
    const sb = state(st);
    const reload = () => { sb.loaded = null; sb.error = null; sb.data = null; sb.loading = false; rerender(); };
    if (sb.loaded !== sb.month && !sb.loading) load(st, rerender);
    ctx.on('change', '[data-sbmonth]', (e, t) => { sb.month = t.value; sb.data = null; sb.loaded = null; rerender(); });
    ctx.on('click', '[data-sbreload]', () => reload());
    ctx.on('click', '[data-sbexport]', () => {
      const a = document.createElement('a'); a.href = '/api/admin/cloud/showback/export?month=' + enc(sb.month) + '&format=csv'; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
      ctx.toast('Showback export started. The export is written to the audit chain.', 'ok');
    });
    ctx.on('click', '[data-sbrules]', () => rulesModal(ctx, st, reload));
    // 1.9.99-final, Sprint 62 (B-10607): the Cloud spend screen has the same showback beside budgets and anomalies.
    ctx.on('click', '[data-sbspend]', () => ctx.navigate('cloud-spend', { tab: 'showback' }));
    ctx.on('click', '[data-sbstmt]', (e, t) => {
      if (t.disabled || !sb.settings) return;
      const on = !sb.settings.statementLines;
      ctx.confirm({ title: on ? 'Show showback on statements' : 'Stop showing showback on statements', body: '<p class="fg2" style="margin:0">' + (on ? 'This tenant\'s statements will list its cloud showback as informational lines, outside the total.' : 'This tenant\'s statements will no longer list its cloud showback.') + ' Audited cloud.showback.settings.updated.</p>', ok: on ? 'Show' : 'Stop showing' }).then((ok) => {
        if (!ok) return;
        App.api('PUT', '/api/admin/cloud/showback/settings', { statementLines: on })
          .then((r) => { sb.settings = Object.assign({}, sb.settings, { statementLines: r.statementLines }); ctx.toast(r.statementLines ? 'Showback lines are on the statements.' : 'Showback lines are off the statements.', 'ok'); rerender(); })
          .catch((err) => App.fail(err, 'Not changed'));
      });
    });
  }

  App.analyticsShowback = { body: body, bind: bind };
})();
