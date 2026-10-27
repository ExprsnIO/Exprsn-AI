(function () {
  // 1.9.99-final, Sprint 60 (B-10406): the Pools screen's cloud node group card. pools.js loads the cards with the
  // pools (GET /api/admin/pools/cloud), draws App.poolsCloud.card(st, pool) inside each cloud pool's panel and calls
  // App.poolsCloud.bind(ctx, st, quiet, onClose) on every render. The card shows the node group's size (desired,
  // healthy, minimum and maximum), its cost per hour at the on-demand price, the idle timer, the spot state and the
  // cold-start estimate; its size controls change the policy (PUT /api/admin/pools/:id/autoscale) and the desired size
  // (POST /api/admin/pools/:id/scale), each confirmed, toasted and audited by the server.
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const money = (n, cur) => (n == null ? 'not priced' : n.toFixed(n < 10 ? 3 : 2).replace(/0$/, '') + ' ' + (cur || 'USD'));
  const mins = (ms) => (ms <= 0 ? 'now' : ms < 60000 ? Math.ceil(ms / 1000) + ' s' : Math.ceil(ms / 60000) + ' min');
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const REASON = { idle: 'Idle', queue: 'Queue depth', cold: 'Cold start', manual: 'Manual', interruption: 'Interruption', fallback: 'On-demand fallback' };
  const PROVIDER = { aws: 'AWS', azure: 'Azure', digitalocean: 'DigitalOcean' };

  const CSS = '#main .plc{border:1px solid var(--line);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--panel)}'
    + '#main .plc-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}#main .plc-head .hstack{flex-wrap:wrap}'
    + '#main .plc .kv{--cols:3}@media (max-width:640px){#main .plc .kv{--cols:1}}#main .plc-ev{font-size:12px}';

  function idleText(c) {
    const p = c.policy;
    if (!p) return 'No autoscale policy yet';
    if (c.idle.busy) return 'Busy: ' + (c.inflight || 0) + ' running, ' + (c.queued || 0) + ' waiting';
    if (c.desired <= p.min) return 'At the minimum of ' + p.min + (p.min === 0 ? ' (scaled to zero)' : '');
    if (c.idle.endsAt) return 'Scales to ' + p.min + ' in ' + mins(c.idle.endsAt - Date.now()) + ' without a lease (idle ' + p.idleMinutes + ' min)';
    return 'Idle timer ' + p.idleMinutes + ' min';
  }

  function spotText(c) {
    const s = c.spot;
    if (!s.offered) return UI.pill('On demand only', 'outline');
    if (s.capacity !== 'spot') return UI.pill('On demand', '');
    if (s.now === 'on_demand') return UI.pill('Spot, on-demand fallback active', 'warn');
    return UI.pill('Spot', 'info') + (s.fallback ? ' <span class="fg2">falls back to on demand</span>' : '');
  }

  /** The card for one pool, or '' when the pool is not a cloud pool. */
  function card(st, p) {
    const c = st.cloud && st.cloud.cards && st.cloud.cards[p.id];
    if (!c) return '';
    const pol = c.policy;
    const id = esc(p.id);
    const head = '<div class="plc-head"><div class="eyebrow">Cloud node group</div><span class="hstack gap6">'
      + UI.btn('Size and policy', { size: 'sm', attrs: 'data-plc-edit="' + id + '"' })
      + UI.btn('Scale to zero', { size: 'sm', attrs: 'data-plc-zero="' + id + '"', disabled: !pol || c.desired === 0 || pol.min > 0 }) + '</span></div>';
    const rows = [
      ['Node group', esc((PROVIDER[c.provider] || c.provider || '') + (c.region ? ', ' + c.region : '')) + (c.size ? ' <span class="mono">' + esc(c.size) + '</span>' : '')],
      ['Nodes', '<span class="num" data-plc-desired="' + id + '">' + esc(String(c.desired)) + '</span> asked, ' + esc(String(c.healthy)) + ' healthy' + (pol ? ', ' + pol.min + ' to ' + pol.max : '')],
      ['Cost per hour', esc(money(c.costPerHour, c.currency)) + (c.priceHourly != null ? ' <span class="fg2">(' + esc(money(c.priceHourly, c.currency)) + ' a node, on demand)</span>' : '')],
      ['Idle timer', esc(idleText(c))],
      ['Spot', spotText(c)],
      ['Cold start', 'about ' + esc(mins(c.coldStart.ms)) + ' <span class="fg2">(' + (c.coldStart.samples ? 'median of ' + c.coldStart.samples + ' boots' : 'no boot recorded yet') + ')</span>'],
      ['Saved this month', c.savings ? esc((Math.round(c.savings.hours * 10) / 10) + ' idle hours avoided, ' + money(c.savings.saving, c.savings.currency)) : 'nothing yet']
    ];
    const events = (c.events || []).slice(0, 5);
    const evTable = events.length ? UI.table(['When', 'Change', 'Why', 'Outcome'], events.map((e) => [esc(when(e.at)), esc(e.from + ' → ' + e.to), esc(REASON[e.reason] || e.reason), UI.pill(e.outcome)]), { clickable: false, minWidth: '0', cls: 'plc-ev' }) : '';
    const notes = (c.interruptions || []).filter((x) => x.state !== 'reclaimed').map((x) => UI.notice('<b>Interruption notice.</b> ' + esc(x.kind === 'ec2_rebalance' ? 'The provider recommends rebalancing a node' : 'The provider reclaims a node') + (x.reclaimAt ? ' at ' + esc(when(x.reclaimAt)) : '') + '; it is ' + esc(x.state) + ', ' + x.finished + ' requests finished there and ' + x.moved + ' moved.', 'warn')).join('');
    return '<div class="plc" data-plc="' + id + '">' + head + UI.kv(rows, 3) + notes + evTable + '</div>';
  }

  function policyForm(c) {
    const p = c.policy || { min: 0, max: 1, idleMinutes: 15, queueDepth: 2, maxColdWaitMs: 600000, capacity: 'on_demand', onDemandFallback: true };
    const caps = c.spot.offered ? [{ value: 'on_demand', label: 'On demand' }, { value: 'spot', label: 'Spot, with on-demand fallback' }] : [{ value: 'on_demand', label: 'On demand (the only kind offered)' }];
    return '<div class="formgrid" style="--cols:2">'
      + UI.field('Minimum nodes', UI.input(String(p.min), { type: 'number', attrs: 'data-plc-min min="0" max="64"' }), '0 lets the pool scale to zero')
      + UI.field('Maximum nodes', UI.input(String(p.max), { type: 'number', attrs: 'data-plc-max min="1" max="64"' }))
      + UI.field('Desired nodes', UI.input(String(c.desired), { type: 'number', attrs: 'data-plc-want min="0" max="64"' }), 'Scaling above the current size adds cost and is refused past the budget\'s hard stop')
      + UI.field('Idle minutes', UI.input(String(p.idleMinutes), { type: 'number', attrs: 'data-plc-idle min="1" max="1440"' }), 'With no slot lease this long, the pool scales to its minimum')
      + UI.field('Queue depth per node', UI.input(String(p.queueDepth), { type: 'number', attrs: 'data-plc-queue min="1" max="100"' }), 'Waiting requests per node that add a node')
      + UI.field('Capacity', UI.select(caps, p.capacity, 'data-plc-cap'))
      + '</div>';
  }

  function bind(ctx, st, quiet, onClose) {
    const cards = () => (st.cloud && st.cloud.cards) || {};
    const scale = async (poolId, desired, note) => {
      const out = await App.post('/api/admin/pools/' + enc(poolId) + '/scale', Object.assign({ desired: desired }, note ? { reason: note } : {}));
      if (out.card) st.cloud.cards[poolId] = out.card;
      return out;
    };
    ctx.on('click', '[data-plc-zero]', async (e, t) => {
      const c = cards()[t.dataset.plcZero]; if (!c) return;
      const ok = await ctx.confirm({ title: 'Scale to zero', tag: 'stops every node', tone: 'warn', body: '<p style="margin:0" class="fg2">The node group goes to zero nodes and stops costing ' + esc(money(c.costPerHour, c.currency)) + ' an hour. The next request waits for a cold start of about ' + esc(mins(c.coldStart.ms)) + ', or takes its profile\'s fallback.</p>', ok: 'Scale to zero' });
      if (!ok) return;
      try { await scale(c.poolId, 0, 'Scaled to zero from Pools'); ctx.toast('Scaling to zero nodes.', 'ok'); quiet(); } catch (err) { App.fail(err); }
    });
    ctx.on('click', '[data-plc-edit]', (e, t) => {
      const c = cards()[t.dataset.plcEdit]; if (!c) return;
      ctx.modal({ title: 'Cloud node group size and policy', body: policyForm(c), onClose,
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-plc-save' }),
        onMount(m) {
          const btn = m.querySelector('[data-plc-save]');
          btn.addEventListener('click', async () => {
            const n = (s) => Number(m.querySelector(s).value);
            const body = { min: n('[data-plc-min]'), max: n('[data-plc-max]'), idleMinutes: n('[data-plc-idle]'), queueDepth: n('[data-plc-queue]'), maxColdWaitMinutes: c.policy ? Math.max(1, Math.round(c.policy.maxColdWaitMs / 60000)) : 10, capacity: m.querySelector('[data-plc-cap]').value, onDemandFallback: true };
            if (!c.policy && c.deploymentId && c.resourceKey) Object.assign(body, { deploymentId: c.deploymentId, resourceKey: c.resourceKey });
            const want = n('[data-plc-want]');
            btn.disabled = true;
            try {
              st.cloud.cards[c.poolId] = await App.put('/api/admin/pools/' + enc(c.poolId) + '/autoscale', body);
              if (want !== st.cloud.cards[c.poolId].desired) await scale(c.poolId, want);
              App.closeOverlay(); ctx.toast('Node group policy saved' + (want !== c.desired ? '; scaling to ' + want + (want === 1 ? ' node.' : ' nodes.') : '.'), 'ok'); quiet();
            } catch (err) { btn.disabled = false; App.fail(err); }
          });
        } });
    });
  }

  function load() {
    return App.get('/api/admin/pools/cloud').catch(() => ({ installed: false, cards: {} }));
  }

  App.poolsCloud = { CSS: CSS, card: card, bind: bind, load: load };
})();
