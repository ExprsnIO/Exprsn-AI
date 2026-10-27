(function () {
  const { UI, esc } = App;

  /*
   * Cloud › Cloud compute (1.9.99-final, Sprint 62: B-10706), from the `cloud-compute` board of the
   * design prototype (removed 2026-10-21). The GPU node groups that join the gateway as pools: each pool's
   * cloud card (`GET /api/admin/pools/cloud`: size, cost per hour, the idle timer, spot state, cold start, scale
   * events, interruptions), the GPU pool links with their enrolled nodes (`GET /api/admin/cloud/gpu-pools`), the idle
   * savings this month, the scale policy and manual scaling (`PUT .../autoscale`, `POST .../scale`, refused with
   * budget_exceeded past the hard stop), and a new node group as a plan on a deployment (quota checked by the planner).
   * The same card is on Pools (pools-cloud.js); Open in Pools goes there.
   */
  const enc = encodeURIComponent;
  const PROV = { aws: 'AWS', azure: 'Azure', digitalocean: 'DigitalOcean', cloudflare: 'Cloudflare' };
  const CF_REASON = 'Runs the app tier only; pick a provider for data and GPUs';
  const GPU_TYPES = {
    aws: [['g6.xlarge', 'l4', '1x L4 24 GB'], ['g5.xlarge', 'a10', '1x A10G 24 GB'], ['g6e.2xlarge', 'l40s', '1x L40S 48 GB'], ['p5.48xlarge', 'h100', '8x H100 80 GB']],
    azure: [['Standard_NV36ads_A10_v5', 'a10', '1x A10 24 GB'], ['Standard_NC24ads_A100_v4', 'a100', '1x A100 80 GB'], ['Standard_NC40ads_H100_v5', 'h100', '1x H100 94 GB']],
    digitalocean: [['gpu-h100x1-80gb', 'h100', '1x H100 80 GB'], ['gpu-l40sx1-48gb', 'l40s', '1x L40S 48 GB']]
  };
  const money = (n, cur) => (n == null ? 'not priced' : '$' + Number(n).toFixed(2) + (cur && cur !== 'USD' ? ' ' + cur : ''));
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const mins = (ms) => (ms <= 0 ? 'now' : ms < 60000 ? Math.ceil(ms / 1000) + ' s' : Math.ceil(ms / 60000) + ' min');
  const detailOf = (e) => (e && e.problem && e.problem.detail) || (e && e.message) || 'Request failed';
  const overlayOpen = () => !!document.getElementById('overlay');
  const stKind = (s) => (/serving|healthy/.test(s) ? 'ok' : /scaled to zero|warming|draining/.test(s) ? 'info' : /blocked|exceeded|unavailable|failed/.test(s) ? 'danger' : 'warn');
  const REASON = { idle: 'Idle', queue: 'Queue depth', cold: 'Cold start', manual: 'Manual', interruption: 'Interruption', fallback: 'On-demand fallback' };

  const poolState = (c) => {
    if (c.link && c.link.state && c.link.state !== 'active') return c.link.state;
    if (c.desired === 0) return 'scaled to zero';
    if (c.healthy >= c.desired) return 'serving';
    return 'warming';
  };

  App.register({
    id: 'cloud-compute', title: 'Cloud compute', section: 'admin', crumb: ['Admin', 'Cloud compute'], live: true,
    summary: 'GPU node groups as gateway pools: scale to zero, spot, quotas and cost',
    commands: [{ label: 'Add a GPU node group', sub: 'Cloud compute', run(app) { const s = app.stateFor('cloud-compute'); s.openAdd = true; app.render(); } }],
    states: [
      { title: 'Cold start with a queued request', tone: 'info', text: 'A pool is scaled to zero and a request arrives. The pool scales to one node; the request waits with an estimate, or takes the profile fallback after OLLAMA_QUEUE_TIMEOUT_MS.', apply(ctx) { Object.assign(ctx.state, { denied: false, mode: 'cold' }); ctx.rerender(); } },
      { title: 'Spot interruption', tone: 'warn', text: 'A spot node got a two-minute notice. It was drained and an on-demand replacement joined.', apply(ctx) { Object.assign(ctx.state, { denied: false, mode: 'spot' }); ctx.rerender(); } },
      { title: 'Capacity unavailable', tone: 'warn', text: 'The provider answered InsufficientInstanceCapacity for the GPU type in one zone. The node group falls back to the next zone, then to the next allowed type.', apply(ctx) { Object.assign(ctx.state, { denied: false, mode: 'capacity' }); ctx.rerender(); } },
      { title: 'Quota exceeded', tone: 'danger', text: 'The account has no GPU vCPUs free in the region. Raising max is refused before planning; request a quota increase at the provider.', apply(ctx) { Object.assign(ctx.state, { denied: false, mode: 'quota' }); ctx.rerender(); } },
      { title: 'Budget blocks scale-up', tone: 'danger', text: 'A pool wants another node for its queue. The account is past its budget, so the scale-up is refused with budget_exceeded; requests wait or take the fallback.', apply(ctx) { Object.assign(ctx.state, { denied: false, mode: 'budget' }); ctx.rerender(); } },
      { title: 'Loading', tone: 'neutral', text: 'Node groups are read from each account; the table shows skeleton rows until the providers answer.', apply(ctx) { Object.assign(ctx.state, { denied: false, mode: 'loading' }); ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'A member opens Cloud compute without cloud:read and is told which permission and role grant it.', apply(ctx) { Object.assign(ctx.state, { denied: true }); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const refresh = () => { if (App.state.route !== 'cloud-compute') return; if (overlayOpen()) { st.dirty = true; return; } ctx.rerender(); };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/admin/pools/cloud'), App.get('/api/admin/pools').catch(() => []), App.get('/api/admin/cloud/gpu-pools').catch(() => ({ pools: [] })), App.get('/api/admin/cloud/gpu-savings').catch(() => ({ pools: [] })), App.get('/api/admin/cloud/deployments').catch(() => ({ deployments: [] })), App.get('/api/admin/cloud/accounts').catch(() => ({ accounts: [] }))])
          .then(([cards, pools, links, savings, deps, accts]) => {
            Object.assign(st, { installed: cards.installed !== false, cards: cards.cards || {}, pools: Array.isArray(pools) ? pools : pools.pools || [], links: links.pools || [], savings: savings.pools || [], deployments: deps.deployments || [], accounts: accts.accounts || [], loaded: true, loadError: null });
          })
          .catch((err) => { st.loadError = err; st.loaded = true; })
          .finally(() => { st.loading = false; refresh(); });
      };
      st.reload = () => { st.loaded = false; load(); };
      if (!st.loaded && !st.loading) load();
      if (ctx.params.pool && st.seenHash !== location.hash) { st.seenHash = location.hash; st.sel = ctx.params.pool; delete ctx.params.pool; }
      const style = '<style>.cloud-compute-t tr[data-cf] td{color:var(--muted)}.cloud-compute-mm{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.cloud-compute-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}</style>';
      const denied = st.denied || (st.loadError && st.loadError.status === 403);
      if (denied) {
        const p = (st.loadError && st.loadError.problem) || {};
        root.innerHTML = style + '<div class="page">' + UI.pagehead('Cloud compute', 'GPU node groups as gateway pools') + UI.problem('You need cloud:read to see cloud compute', 'Cloud compute needs cloud:read and pools:manage (Cloud admin, Cloud operator, Model admin); changing node groups needs cloud:deploy. A tenant admin grants roles on Roles and access.', p.trace_id || false)
          + '<div class="hstack gap6">' + UI.btn('Open Roles and access', { attrs: 'data-go="roles"' }) + (st.denied ? UI.btn('Back to the node groups', { kind: 'ghost', attrs: 'data-undeny' }) : '') + '</div></div>';
        ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
        ctx.on('click', '[data-undeny]', () => { st.denied = false; ctx.rerender(); });
        return;
      }
      const canScale = App.can('cloud:deploy') || App.can('cloud:admin');
      const head = UI.pagehead('Cloud compute', 'GPU node groups that join the gateway as pools; Ollama runs on each node', UI.btn('Add GPU node group', { kind: 'primary', icon: 'plus', attrs: 'data-add', disabled: !App.can('cloud:deploy'), title: App.can('cloud:deploy') ? '' : 'Needs cloud:deploy' }));
      if (st.loadError) {
        root.innerHTML = style + '<div class="page">' + head + UI.problem('Cloud compute could not be loaded', detailOf(st.loadError), (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div></div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; st.reload(); });
        return;
      }
      const loading = st.mode === 'loading' || !st.loaded;
      ['pools', 'links', 'savings', 'deployments', 'accounts'].forEach((k) => { if (!st[k]) st[k] = []; });
      if (!st.cards) st.cards = {};
      const nameOf = (id) => (st.pools.find((p) => p.id === id) || {}).name || id;
      const cards = Object.keys(st.cards || {}).map((k) => st.cards[k]);
      if (!cards.some((c) => c.poolId === st.sel)) st.sel = cards[0] ? cards[0].poolId : null;
      const sel = cards.find((c) => c.poolId === st.sel) || null;
      const depOf = (c) => st.deployments.find((d) => d.id === c.deploymentId) || null;
      const acctOf = (c) => { const d = depOf(c); return d ? st.accounts.find((a) => a.id === d.accountId) : null; };
      const hourly = cards.reduce((a, c) => a + (c.costPerHour || 0), 0);
      const nodes = cards.reduce((a, c) => a + (c.desired || 0), 0);
      const savedHours = st.savings.reduce((a, x) => a + (x.hours || 0), 0);
      const saved = st.savings.reduce((a, x) => a + (x.saving || 0), 0);
      const month = new Date().toLocaleString(undefined, { month: 'long' });

      let notices = '';
      const nm = sel ? nameOf(sel.poolId) : 'the pool';
      if (st.mode === 'cold') notices += UI.notice('<b>Cold start.</b> A request is queued on <span class="mono">' + esc(nm) + '</span>. One node is starting (about ' + esc(sel ? mins(sel.coldStart.ms) : 'a few minutes') + ', model warm-up included). After OLLAMA_QUEUE_TIMEOUT_MS the request takes the profile fallback.', 'info');
      if (st.mode === 'spot') notices += UI.notice('<b>Spot interruption.</b> A node in ' + esc(nm) + ' got a two-minute notice. It was drained: streams in progress finished, queued requests moved, and an on-demand replacement joined with its placements warm.', 'warn');
      if (st.mode === 'capacity') notices += UI.notice('<b>Capacity unavailable.</b> The provider answered <span class="mono">InsufficientInstanceCapacity</span> for ' + esc(sel && sel.size ? sel.size : 'the GPU type') + ' in one zone. The create was tried again in the next zone, then with the next allowed type (gpuPools fallbackTypes); the type that had capacity is what the graph records.', 'warn');
      if (st.mode === 'quota') notices += UI.notice('<b>Quota exceeded.</b> The account has no GPU vCPUs free for this family in ' + esc(sel && sel.region ? sel.region : 'the region') + '. A plan that grows the node group is refused before anything is created. Request an increase at the provider, then validate the account again.', 'danger', UI.btn('Open account', { size: 'xs', attrs: 'data-acct' }));
      if (st.mode === 'budget') notices += UI.notice('<b>Budget blocks scale-up.</b> ' + esc(nm) + ' asked for another node. Its account is past its budget, so the change is refused with <span class="mono">budget_exceeded</span>. Requests wait or take the profile fallback; scale-down stays allowed.', 'danger', UI.btn('Open Cloud accounts', { size: 'xs', attrs: 'data-acct' }));
      if (!st.installed && st.loaded) notices += UI.notice('Cloud node groups are not installed on this server yet (the autoscale migration is pending).', 'warn');

      const stats = '<div class="stats">' + UI.stat(String(nodes), 'GPU nodes running', 'across ' + cards.length + ' cloud pool' + (cards.length === 1 ? '' : 's')) + UI.stat(money(hourly), 'Cost per hour now', 'at on-demand prices') + UI.stat(String(Math.round(savedHours * 10) / 10), 'GPU-hours scaled down', 'this month') + UI.stat(money(saved), 'Saved by scale to zero', 'estimate, ' + month) + '</div>';
      let table;
      if (loading) {
        table = '<div class="tablewrap"><table class="dt"><caption class="sr">Loading node groups</caption><thead><tr><th scope="col">Pool</th><th scope="col">Provider, node group</th><th scope="col">GPU</th><th scope="col">Pricing</th><th scope="col">Min / max / now</th><th scope="col">Scale to zero</th><th scope="col">State</th></tr></thead><tbody>' + [1, 2, 3].map(() => '<tr>' + [1, 2, 3, 4, 5, 6, 7].map(() => '<td><div class="skeleton"></div></td>').join('') + '</tr>').join('') + '</tbody></table></div>';
      } else {
        const rows = cards.map((c) => {
          const p = c.policy || { min: c.link ? c.link.min : 0, max: c.link ? c.link.max : 0 };
          const a = acctOf(c); const state = st.mode === 'cold' && sel && c.poolId === sel.poolId ? 'warming' : poolState(c);
          return { cells: ['<span class="mono">' + esc(nameOf(c.poolId)) + '</span>', esc(PROV[c.provider] || c.provider || '') + ' <span class="muted">' + esc((a ? a.name + ', ' : '') + (c.region || '')) + '</span><div class="muted" style="font-size:11px">' + esc((depOf(c) || { name: '' }).name + (c.resourceKey ? ' / ' + c.resourceKey : '')) + '</div>', '<span class="mono" style="font-size:12px">' + esc(c.size || '—') + '</span>',
            c.spot.capacity === 'spot' ? UI.pill('spot', 'info') + '<div class="muted" style="font-size:11px">on-demand fallback ' + money(c.priceHourly, c.currency) + '/h</div>' : 'on-demand <span class="num">' + money(c.priceHourly, c.currency) + '/h</span>',
            '<span class="num">' + p.min + ' / ' + p.max + ' / ' + c.desired + '</span>', p.min === 0 && c.policy ? 'after ' + c.policy.idleMinutes + ' min idle' : '<span class="muted">off (min ' + p.min + ')</span>', UI.pill(state, stKind(state))], attrs: 'data-id="' + esc(c.poolId) + '" tabindex="0"', selected: sel && c.poolId === sel.poolId };
        });
        rows.push({ cells: ['<span class="muted">none</span>', 'Cloudflare', '<span class="muted">no GPU pools</span>', '—', '—', '—', UI.pill('not available', 'outline')], attrs: 'data-cf title="' + esc(CF_REASON) + '"' });
        table = UI.table(['Pool', 'Provider, node group', 'GPU', 'Pricing', 'Min / max / now', 'Scale to zero', 'State'], rows, { minWidth: '1000px', cls: 'cloud-compute-t' })
          + '<span class="muted" style="font-size:12px">Cloudflare: ' + esc(CF_REASON) + '. For models at the edge, Workers AI is a model backend: <a href="#" data-go="models">open Models</a>.</span>';
      }
      const insp = sel && !loading ? inspector(st, sel, nameOf, depOf, canScale) : '';
      root.innerHTML = style + '<div class="page">' + head + notices + stats + table + (cards.length || loading ? '' : UI.empty('No cloud GPU pools', 'A GPU node group of a Kubernetes deployment joins the gateway as a pool. Add one as a plan on its deployment.', App.can('cloud:deploy') ? UI.btn('Add GPU node group', { kind: 'primary', attrs: 'data-add' }) : '')) + '</div>'
        + (insp ? '<aside class="inspector w360" aria-label="Pool details">' + insp + '</aside>' : '');

      const pick = (t) => { if (t.dataset.id) { st.sel = t.dataset.id; ctx.rerender(); } };
      ctx.on('click', 'tr.row[data-id]', (e, t) => pick(t));
      ctx.on('keydown', 'tr.row[data-id]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(t); } });
      ctx.on('click', 'tr[data-cf]', () => ctx.toast('Cloudflare: ' + esc(CF_REASON) + '. Use Workers AI on Models for edge inference.'));
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-acct]', () => { const a = sel ? acctOf(sel) : null; ctx.navigate('cloud', a ? { id: a.id } : undefined); });
      ctx.on('click', '[data-add]', () => addGroup(ctx, st));
      if (st.openAdd && st.loaded) { st.openAdd = false; setTimeout(() => addGroup(ctx, st), 30); }
      if (!sel) return;
      bindPool(ctx, st, sel, nameOf);
    }
  });

  function inspector(st, c, nameOf, depOf, canScale) {
    const p = c.policy;
    const link = c.link ? (st.links || []).find((l) => l.id === c.link.id) : null;
    const detail = st.detail && st.detail[c.poolId];
    const state = st.mode === 'cold' ? 'warming' : poolState(c);
    const spotLine = !c.spot.offered ? 'Not offered by ' + (PROV[c.provider] || 'this provider') + ': on-demand only' : c.spot.capacity === 'spot' ? 'Spot first' + (c.spot.fallback ? ', on-demand fallback' : '') + '; interruptions drain the node' + (c.spot.now === 'on_demand' ? ' (on-demand fallback active now)' : '') : 'On-demand';
    const idle = !p ? 'No autoscale policy yet' : c.idle.busy ? 'Busy: ' + c.inflight + ' running, ' + c.queued + ' waiting' : c.desired <= p.min ? 'At the minimum of ' + p.min + (p.min === 0 ? ' (scaled to zero)' : '') : c.idle.endsAt ? 'Scales to ' + p.min + ' in ' + mins(c.idle.endsAt - Date.now()) + ' without a lease (idle ' + p.idleMinutes + ' min)' : 'Idle timer ' + p.idleMinutes + ' min';
    const instances = detail && detail.instances ? detail.instances : [];
    const nodes = instances.length ? UI.table(['Node', 'Health', 'State'], instances.map((n) => ['<span class="mono" style="font-size:12px">' + esc(n.node || n.name) + '</span>', UI.pill(n.health, stKind(n.health)), esc(n.state)]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' })
      : '<div class="muted" style="font-size:12px">' + (state === 'warming' ? 'A node is starting: it joins the pool with an mTLS certificate from the Exprsn-AI CA, then pulls approved placements from the registry mirror.' : c.desired === 0 ? 'No nodes. The pool is scaled to zero; the next request starts one (about ' + esc(mins(c.coldStart.ms)) + ').' : c.healthy + ' healthy of ' + c.desired + ' asked' + (link ? '' : '; nodes enrol through the node group\'s DaemonSet.')) + '</div>';
    const blocked = (st.mode === 'quota' || st.mode === 'budget');
    const ints = (c.interruptions || []).length ? '<div class="eyebrow">Interruptions</div>' + UI.timeline(c.interruptions.map((x) => ({ title: esc(when(x.reclaimAt || x.at)) + ' ' + esc(x.kind === 'ec2_rebalance' ? 'Rebalance recommendation' : 'Spot notice'), text: esc(x.state) + ', ' + x.finished + ' finished, ' + x.moved + ' moved', tone: x.state === 'reclaimed' ? 'ok' : 'warn' }))) : '';
    const events = (c.events || []).length ? '<div class="eyebrow">Scale events</div>' + UI.table(['When', 'Change', 'Why', 'Outcome'], c.events.slice(0, 5).map((e) => [esc(when(e.at)), esc(e.from + ' → ' + e.to), esc(REASON[e.reason] || e.reason), UI.pill(e.outcome)]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }) : '';
    return '<div class="hstack"><div class="eyebrow grow">Selected pool</div>' + UI.pill(state, stKind(state)) + '</div><div class="cloud-compute-name">' + esc(nameOf(c.poolId)) + '</div><div class="muted" style="font-size:12px">' + esc((PROV[c.provider] || '') + ', ' + (c.region || '') + ' · ' + ((depOf(c) || { name: '' }).name) + (c.resourceKey ? ' / ' + c.resourceKey : '')) + '</div>'
      + UI.kv([['GPU', '<span class="mono">' + esc(c.size || '—') + '</span>'], ['Cost per hour now', '<span class="num">' + money(c.costPerHour, c.currency) + '</span> <span class="muted">(' + c.desired + ' × ' + money(c.priceHourly, c.currency) + ')</span>'], ['Spot policy', esc(spotLine)], ['Cold start', 'about ' + esc(mins(c.coldStart.ms)) + ' <span class="muted">(' + (c.coldStart.samples ? 'median of ' + c.coldStart.samples + ' boots' : 'no boot recorded yet') + ')</span>'], ['Idle timer', esc(idle)], ['Saved this month', c.savings ? esc((Math.round(c.savings.hours * 10) / 10) + ' idle hours avoided, ' + money(c.savings.saving, c.savings.currency)) : 'nothing yet']], 1)
      + '<div class="eyebrow">Nodes</div>' + nodes
      + '<div class="eyebrow">Scale</div><div class="cloud-compute-mm">' + UI.field('Min', UI.input(String(p ? p.min : 0), { type: 'number', attrs: 'data-min min="0" max="64"' })) + UI.field('Max', UI.input(String(p ? p.max : 1), { type: 'number', attrs: 'data-max min="1" max="64"' })) + '</div>'
      + (blocked ? UI.notice(st.mode === 'quota' ? 'Raising max is refused while the GPU quota has nothing free.' : 'Scale-up refused: the account\'s budget is exceeded.', 'danger') : '')
      + '<div class="hstack wrap gap6">' + UI.btn('Save scaling', { kind: 'primary', size: 'sm', attrs: 'data-save', disabled: !canScale }) + UI.btn('Scale to zero now', { size: 'sm', attrs: 'data-zero', disabled: !canScale || !p || c.desired === 0 || p.min > 0, title: p && p.min > 0 ? 'Min is ' + p.min : '' }) + UI.btn('Warm up', { size: 'sm', attrs: 'data-warm', disabled: !canScale || c.desired > 0 }) + UI.btn('Open in Pools', { size: 'sm', kind: 'ghost', attrs: 'data-pools' }) + '</div>'
      + events + ints;
  }

  function bindPool(ctx, st, c, nameOf) {
    const name = nameOf(c.poolId);
    const after = (r, what) => { st.cards[c.poolId] = r.card || r; ctx.rerender(); ctx.toast(what, 'ok'); };
    const refused = (err, what) => {
      const p = err && err.problem;
      if (p && p.reason === 'budget_exceeded') { st.mode = 'budget'; ctx.rerender(); ctx.toast('Refused: budget_exceeded. ' + esc(p.detail || ''), 'danger', 6000); return; }
      App.fail(err, what);
    };
    if (c.link && (!st.detail || !st.detail[c.poolId]) && !(st.detailLoading && st.detailLoading[c.poolId])) {
      st.detail = st.detail || {}; st.detailLoading = st.detailLoading || {}; st.detailLoading[c.poolId] = true;
      App.get('/api/admin/cloud/gpu-pools/' + enc(c.link.id)).then((r) => { st.detail[c.poolId] = r; }).catch(() => { st.detail[c.poolId] = { instances: [] }; })
        .finally(() => { st.detailLoading[c.poolId] = false; if (App.state.route === 'cloud-compute' && !overlayOpen()) ctx.rerender(); });
    }
    ctx.on('click', '[data-pools]', () => ctx.navigate('pools', { pool: c.poolId }));
    ctx.on('click', '[data-save]', async () => {
      const p = c.policy || { idleMinutes: 15, queueDepth: 2, maxColdWaitMs: 600000, capacity: 'on_demand', onDemandFallback: true };
      const min = Math.max(0, parseInt(ctx.$('[data-min]').value, 10) || 0); const max = Math.max(1, min, parseInt(ctx.$('[data-max]').value, 10) || 1);
      const extra = c.priceHourly != null ? Math.max(0, max - (c.policy ? c.policy.max : 0)) * c.priceHourly * 730 : 0;
      const ok = await ctx.confirm({ title: 'Change scaling for ' + name, tag: 'policy', tone: 'ok', body: '<p class="fg2" style="margin:0">Exprsn-AI keeps the desired count between min and max from queue depth and slot leases, and scales to the minimum after ' + p.idleMinutes + ' idle minutes.</p>', kv: [['Min', (c.policy ? c.policy.min : '—') + ' → ' + min], ['Max', (c.policy ? c.policy.max : '—') + ' → ' + max], ['Worst-case cost change', extra ? '+' + money(extra) + ' a month' : 'none']], ok: 'Apply' });
      if (!ok) return;
      const body = { min, max, idleMinutes: p.idleMinutes, queueDepth: p.queueDepth, maxColdWaitMinutes: Math.max(1, Math.round(p.maxColdWaitMs / 60000)), capacity: p.capacity, onDemandFallback: p.onDemandFallback };
      if (!c.link && c.deploymentId && c.resourceKey) { body.deploymentId = c.deploymentId; body.resourceKey = c.resourceKey; }
      try { const r = await App.put('/api/admin/pools/' + enc(c.poolId) + '/autoscale', body); if (st.mode === 'quota' || st.mode === 'budget') st.mode = null; after(r, 'Scaling for ' + esc(name) + ' saved: min ' + min + ', max ' + max + '. Audit entry written.'); } catch (err) { refused(err, 'Not saved'); }
    });
    ctx.on('click', '[data-zero]', async () => {
      const ok = await ctx.confirm({ title: 'Scale ' + name + ' to zero now', tag: 'drain', tone: 'danger', body: '<p class="fg2" style="margin:0">Each node is drained first: streams in progress finish, queued requests move to the profile fallback. The next request starts a node again (about ' + esc(mins(c.coldStart.ms)) + ').</p>', kv: [['Nodes', String(c.desired)], ['Saves', money(c.costPerHour, c.currency) + ' an hour']], ok: 'Scale to zero' });
      if (!ok) return;
      try { const r = await App.post('/api/admin/pools/' + enc(c.poolId) + '/scale', { desired: 0, reason: 'Scaled to zero from Cloud compute' }); after(r, esc(name) + ' drained and scaled to zero. Audit entry written.'); } catch (err) { refused(err, 'Not scaled'); }
    });
    ctx.on('click', '[data-warm]', async () => {
      const to = Math.max(1, c.policy ? c.policy.min : 1);
      const ok = await ctx.confirm({ title: 'Warm up ' + name, tag: 'scale up', tone: 'ok', body: '<p class="fg2" style="margin:0">Starts a node and pulls the approved placements from the registry mirror, so the first request does not wait for a cold start.</p>', kv: [['Cost', money(c.priceHourly, c.currency) + ' an hour while running'], ['Ready in', 'about ' + mins(c.coldStart.ms)]], ok: 'Warm up' });
      if (!ok) return;
      try { const r = await App.post('/api/admin/pools/' + enc(c.poolId) + '/scale', { desired: to, reason: 'Warmed up from Cloud compute' }); if (st.mode === 'cold') st.mode = null; after(r, 'A node is starting in ' + esc(name) + '. It joins the pool when /api/version answers over mTLS.'); } catch (err) { refused(err, 'Not started'); }
    });
  }

  function addGroup(ctx, st) {
    const targets = (st.deployments || []).filter((d) => ['aws', 'azure', 'digitalocean'].indexOf(d.provider) >= 0 && d.kind !== 'onprem' && d.state !== 'destroyed' && (!d.spec || !d.spec.compute || d.spec.compute.shape === 'kubernetes'));
    const f = { dep: targets[0] ? targets[0].id : null, type: 0, spot: true, min: 0, max: 2, key: 'gpu-pool' };
    const dep = () => targets.find((d) => d.id === f.dep) || null;
    const body = () => {
      const d = dep();
      if (!d) return UI.notice('GPU node groups join a Kubernetes deployment. Make one on Deployments first; Cloudflare: ' + esc(CF_REASON) + '.', 'info');
      const types = GPU_TYPES[d.provider] || [];
      const doSpot = d.provider === 'digitalocean';
      return '<div class="formgrid" style="--cols:2">'
        + UI.field('Deployment', UI.select(targets.map((x) => ({ value: x.id, label: x.name + ' (' + (PROV[x.provider] || x.provider) + ', ' + x.region + ')' })), f.dep, 'data-f="dep"'))
        + UI.field('Node group key', UI.input(f.key, { attrs: 'data-f="key"' }), 'Lower case; the pool takes this name')
        + UI.field('Min nodes', UI.input(String(f.min), { type: 'number', attrs: 'data-f="min" min="0" max="16"' }), '0 allows scale to zero')
        + UI.field('Max nodes', UI.input(String(f.max), { type: 'number', attrs: 'data-f="max" min="1" max="16"' })) + '</div>'
        + '<div class="eyebrow">Instance type</div>'
        + UI.table([{ label: '', srLabel: 'Pick' }, 'Type', 'GPU'], types.map((t, i) => ['<input type="radio" name="cc-type" value="' + i + '"' + (i === f.type ? ' checked' : '') + ' aria-label="' + esc(t[0]) + '">', '<span class="mono">' + esc(t[0]) + '</span>', esc(t[2])]), { clickable: false, minWidth: '0' })
        + '<div class="hstack wrap gap12" style="min-height:30px">' + (doSpot ? '<button type="button" class="toggle" role="switch" aria-checked="false" disabled><span class="sw"></span><span>Spot capacity</span></button><span class="muted" style="font-size:12px">Not offered by DigitalOcean: GPU Droplets are on-demand only.</span>' : UI.toggle('Spot capacity with on-demand fallback', f.spot, 'data-manual="1" data-spot')) + '</div>'
        + UI.kv([['Quota check', 'When the plan is made: the account\'s GPU quota in ' + esc(d.region) + ' against what is in use; a plan that does not fit is refused with the numbers'], ['Joins as', 'pool ' + esc(f.key) + ', Ollama per node, mTLS'], ['Scale to zero', +f.min === 0 ? 'after 15 min idle' : 'off']], 2)
        + (st.mode === 'budget' ? UI.notice('<b>Budget hard stop.</b> The account is past its budget; this plan adds cost and will be refused with budget_exceeded.', 'danger') : '')
        + '<span class="muted" style="font-size:12px">Create plan makes a plan on the deployment with its cost delta; you review and apply it on Deployments.</span>';
    };
    ctx.modal({ title: 'Add a GPU node group', cls: 'wide', body: '<div data-ag>' + body() + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create plan', { kind: 'primary', attrs: 'data-plan', disabled: !targets.length }),
      onMount(m) {
        const host = m.querySelector('[data-ag]'); const redraw = () => { host.innerHTML = body(); };
        host.addEventListener('change', (e) => { if (e.target.name === 'cc-type') { f.type = +e.target.value; return; } const k = e.target.dataset.f; if (!k) return; if (k === 'dep' || k === 'key') f[k] = e.target.value; else f[k] = Math.max(0, +e.target.value || 0); if (k === 'dep') f.type = 0; redraw(); });
        host.addEventListener('click', (e) => { if (e.target.closest('[data-spot]')) { f.spot = !f.spot; redraw(); } });
        m.querySelector('[data-plan]').addEventListener('click', async () => {
          const d = dep(); if (!d) return;
          const t = (GPU_TYPES[d.provider] || [])[f.type];
          const base = '/api/admin/cloud/deployments/' + enc(d.id);
          const [plans, graph] = await Promise.all([App.get(base + '/plans?limit=5').catch(() => ({ plans: [] })), App.get(base + '/graph').catch(() => ({ resources: [] }))]);
          const prior = plans.plans.find((p) => p.state === 'applied') || plans.plans[0];
          const desired = prior ? prior.desired : (graph.resources || []).filter((r) => r.state !== 'deleted').map((r) => r.desired);
          if (desired.some((r) => r.key === f.key)) { ctx.toast('A resource called ' + esc(f.key) + ' exists in ' + esc(d.name) + '; pick another key.', 'warn'); return; }
          const cluster = desired.find((r) => r.type === 'cluster');
          const spec = { role: 'gpu', size: t[0], gpu: t[1], min: Math.min(f.min, f.max), max: Math.max(1, f.max), count: Math.min(f.min, f.max), scaleToZero: f.min === 0 };
          if (d.provider !== 'digitalocean' && f.spot) spec.purchase = 'spot';
          const res = { key: f.key, type: 'node_group', spec, dependsOn: cluster ? [cluster.key] : [], protect: false, region: null, tags: { pool: f.key } };
          try {
            const p = await App.post(base + '/plans', { desired: desired.concat([res]) });
            App.closeOverlay();
            ctx.toast('Plan made on ' + esc(d.name) + ': ' + p.summary.create + ' create' + (p.blockers.length ? '; it has blockers: ' + esc(p.blockers[0]) : '') + '. Review and apply it on Deployments.', p.blockers.length ? 'warn' : 'ok', 7000);
            ctx.navigate('deployments', { id: d.id, tab: 'plan' });
          } catch (err) {
            if (err && err.problem && err.problem.reason === 'budget_exceeded') { App.closeOverlay(); st.mode = 'budget'; ctx.rerender(); ctx.toast('Refused: budget_exceeded.', 'danger', 6000); return; }
            App.fail(err, 'Not planned');
          }
        });
      } });
  }
})();
