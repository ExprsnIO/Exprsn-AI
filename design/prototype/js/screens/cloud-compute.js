(function () {
  const { UI, esc } = App;

  // ---- nav entry (app.js untouched): after Cloud data, else Deployments, else Cloud accounts, else before Zones ----
  (function nav() {
    const admin = (App.NAV || []).find((g) => g.group === 'Admin'); if (!admin || admin.items.some((i) => i.id === 'cloud-compute')) return;
    const item = { id: 'cloud-compute', label: 'Cloud compute', icon: 'pools' };
    const after = ['cloud-data', 'deployments', 'cloud'].map((id) => admin.items.findIndex((i) => i.id === id)).find((k) => k >= 0);
    const zones = admin.items.findIndex((i) => i.id === 'zones');
    if (after !== undefined) admin.items.splice(after + 1, 0, item); else if (zones >= 0) admin.items.splice(zones, 0, item); else admin.items.push(item);
  })();

  // ---- example data (Northwind, Monday 28 Sep 2026 09:40 UTC). All IDs are fake; prices illustrative. ----
  const POOLS0 = () => [
    { id: 'gpu-cloud-eu', provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', where: 'EKS node group ng-gpu-l40s', gpu: 'g6e.2xlarge, 1x L40S 48 GB', pricing: 'spot', spotRate: 1.05, odRate: 2.24, min: 0, max: 4, now: 2, idle: 20, state: 'serving', zone: 'cloud-eu', label: 'confidential', spotOk: true, coldStart: '4 min',
      nodes: [['ip-10-40-1-22', 'spot', 'healthy', 'qwen2.5:32b-q4_K_M loaded', '3 h 12 min'], ['ip-10-40-3-41', 'on-demand (fallback)', 'healthy', 'llama3.1:8b-q5_K_M loaded', '43 min']] },
    { id: 'gpu-azure-se', provider: 'Azure', account: 'azure-eu', region: 'swedencentral', where: 'AKS node pool gpua100', gpu: 'Standard_NC24ads_A100_v4, 1x A100 80 GB', pricing: 'on-demand', spotRate: null, odRate: 3.67, min: 0, max: 2, now: 0, idle: 30, state: 'scaled to zero', zone: 'cloud-eu', label: 'confidential', spotOk: true, spotOff: true, coldStart: '6 min', nodes: [] },
    { id: 'gpu-do-h100', provider: 'DigitalOcean', account: 'do-team', region: 'nyc3', where: 'GPU Droplets', gpu: 'gpu-h100x1-80gb, 1x H100 80 GB', pricing: 'on-demand', spotRate: null, odRate: 3.39, min: 1, max: 2, now: 1, idle: null, state: 'serving', zone: 'cloud-us', label: 'internal', spotOk: false, coldStart: '7 min', budget: true,
      nodes: [['gpu-h100-nyc3-01', 'on-demand', 'healthy', 'qwen2.5-coder:32b-q4_K_M loaded', '9 d 4 h']] },
    { id: 'cpu-cloud-eu', provider: 'AWS', account: 'aws-prod', region: 'eu-central-1', where: 'EKS node group ng-cpu', gpu: 'c7i.4xlarge (CPU only)', pricing: 'on-demand', spotRate: null, odRate: 0.81, min: 1, max: 3, now: 1, idle: null, state: 'serving', zone: 'cloud-eu', label: 'confidential', spotOk: true, coldStart: '2 min',
      nodes: [['ip-10-40-2-9', 'on-demand', 'healthy', 'nomic-embed-text:v1.5, llama-guard3:8b loaded', '12 d 2 h']] }
  ];
  const CF_REASON = 'Runs the app tier only; pick a provider for data and GPUs';
  const INSTANCE_TYPES = {
    AWS: [['g6e.2xlarge', '1x L40S 48 GB', 2.24], ['g6.xlarge', '1x L4 24 GB', 0.80], ['p5.48xlarge', '8x H100 80 GB', 98.32]],
    Azure: [['Standard_NC24ads_A100_v4', '1x A100 80 GB', 3.67], ['Standard_NC4as_T4_v3', '1x T4 16 GB', 0.53], ['Standard_ND96isr_H100_v5', '8x H100 80 GB', 98.32]],
    DigitalOcean: [['gpu-h100x1-80gb', '1x H100 80 GB', 3.39], ['gpu-l40sx1-48gb', '1x L40S 48 GB', 1.57], ['gpu-4000adax1-20gb', '1x RTX 4000 Ada 20 GB', 0.76]]
  };
  const ACCOUNTS = { AWS: [['aws-prod', 'eu-central-1'], ['aws-prod', 'us-east-1'], ['aws-sandbox', 'us-east-1']], Azure: [['azure-eu', 'swedencentral'], ['azure-eu', 'westeurope']], DigitalOcean: [['do-team', 'nyc3'], ['do-team', 'ams3'], ['do-team', 'fra1']] };
  const QUOTA = { AWS: ['G and VT spot vCPUs, eu-central-1', 32, 16], Azure: ['NCADS_A100_v4 family vCPUs, swedencentral', 48, 0], DigitalOcean: ['GPU Droplets per team', 4, 1] };

  const rate = (p) => p.pricing === 'spot' ? p.spotRate : p.odRate;
  const money = (n) => '$' + n.toFixed(2);
  const stKind = (s) => /serving|healthy/.test(s) ? 'ok' : /scaled to zero|warming|draining/.test(s) ? 'info' : /blocked|exceeded|unavailable/.test(s) ? 'danger' : 'warn';
  const init = (st) => {
    if (st.pools) return;
    st.pools = POOLS0(); st.sel = 'gpu-cloud-eu'; st.mode = null; st.denied = false; st.savedHours = 212; st.saved = 474;
  };

  App.register({
    id: 'cloud-compute', title: 'Cloud compute', section: 'admin', crumb: ['Admin', 'Cloud compute'],
    summary: 'GPU node groups as gateway pools: scale to zero, spot, quotas and cost',
    commands: [{ label: 'Add a GPU node group', sub: 'Cloud compute', run(app) { const s = app.stateFor('cloud-compute'); init(s); s.openAdd = true; app.render(); } }],
    states: [
      { title: 'Cold start with a queued request', tone: 'info', text: 'gpu-azure-se is scaled to zero and a request for analyst-a100 arrives. The pool scales to one node; the request waits with an ETA of 6 minutes, or takes the profile fallback after OLLAMA_QUEUE_TIMEOUT_MS.', apply(ctx) { init(ctx.state); const st = ctx.state; st.denied = false; st.mode = 'cold'; st.sel = 'gpu-azure-se'; const p = st.pools.find((x) => x.id === 'gpu-azure-se'); p.state = 'warming'; p.now = 1; ctx.rerender(); } },
      { title: 'Spot interruption', tone: 'warn', text: 'ip-10-40-3-17 in gpu-cloud-eu got a 2-minute notice at 08:51. It was drained and an on-demand replacement was healthy at 08:57.', apply(ctx) { init(ctx.state); const st = ctx.state; st.denied = false; st.mode = 'spot'; st.sel = 'gpu-cloud-eu'; ctx.rerender(); } },
      { title: 'Capacity unavailable', tone: 'warn', text: 'EC2 answered InsufficientInstanceCapacity for g6e.2xlarge in eu-central-1b. The node group falls back to eu-central-1a, then to g6.xlarge as allowed by the pool.', apply(ctx) { init(ctx.state); const st = ctx.state; st.denied = false; st.mode = 'capacity'; st.sel = 'gpu-cloud-eu'; ctx.rerender(); } },
      { title: 'Quota exceeded', tone: 'danger', text: 'azure-eu has 0 of 48 NCADS_A100_v4 vCPUs free in swedencentral. Raising max to 3 is refused before planning; request a quota increase at Azure.', apply(ctx) { init(ctx.state); const st = ctx.state; st.denied = false; st.mode = 'quota'; st.sel = 'gpu-azure-se'; ctx.rerender(); } },
      { title: 'Budget blocks scale-up', tone: 'danger', text: 'gpu-do-h100 wants a second node for queue depth 9. do-team is at 103 % of its budget, so the scale-up is refused with budget_exceeded; requests wait or take the fallback.', apply(ctx) { init(ctx.state); const st = ctx.state; st.denied = false; st.mode = 'budget'; st.sel = 'gpu-do-h100'; ctx.rerender(); } },
      { title: 'Loading', tone: 'neutral', text: 'Node groups are read from each account; the table shows skeleton rows until the providers answer.', apply(ctx) { init(ctx.state); ctx.state.denied = false; ctx.state.mode = 'loading'; ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'Felix Brandt (member) opens Cloud compute without cloud:read and is told which permission and role grant it.', apply(ctx) { init(ctx.state); ctx.state.denied = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; init(st);
      if (ctx.params.pool) { if (st.pools.some((p) => p.id === ctx.params.pool)) st.sel = ctx.params.pool; delete ctx.params.pool; }
      const style = '<style>tr[data-cf] td{color:var(--muted)}.cloud-compute-mm{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}</style>';
      if (st.denied) {
        root.innerHTML = style + '<div class="page">' + UI.pagehead('Cloud compute', 'GPU node groups as gateway pools') + UI.problem('You need cloud:read to see cloud compute', 'Felix Brandt holds Member in Finance Ops. Cloud compute needs cloud:read (Cloud admin, Cloud operator, FinOps analyst); changing node groups needs cloud:deploy. A tenant admin grants roles on Roles and access.', '8a3c1e9d2b7f4a6c0e5d9b1f3a7c2e4d') + '<div class="hstack gap6">' + UI.btn('Open Roles and access', { attrs: 'data-go="roles"' }) + UI.btn('Back to the board view', { kind: 'ghost', attrs: 'data-undeny' }) + '</div></div>';
        ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
        ctx.on('click', '[data-undeny]', () => { st.denied = false; ctx.rerender(); });
        return;
      }
      const sel = st.pools.find((p) => p.id === st.sel) || st.pools[0];
      const hourly = st.pools.reduce((a, p) => a + p.now * rate(p), 0);
      const gpuNodes = st.pools.filter((p) => !/CPU only/.test(p.gpu)).reduce((a, p) => a + p.now, 0);

      let notices = '';
      if (st.mode === 'cold') notices += UI.notice('<b>Cold start.</b> A request for profile <span class="mono">analyst-a100</span> is queued on gpu-azure-se. One node is starting (about 6 minutes, model warm-up included). After OLLAMA_QUEUE_TIMEOUT_MS the request takes the profile fallback on gpu-cloud-eu.', 'info');
      if (st.mode === 'capacity') notices += UI.notice('<b>Capacity unavailable.</b> EC2 answered <span class="mono">InsufficientInstanceCapacity</span> for g6e.2xlarge in eu-central-1b at 09:31. Retried in eu-central-1a: launched. The fallback type g6.xlarge was not needed.', 'warn');
      if (st.mode === 'quota') notices += UI.notice('<b>Quota exceeded.</b> azure-eu has 0 of 48 NCADS_A100_v4 family vCPUs free in swedencentral. Raising gpu-azure-se above 2 nodes is refused before a plan is made. Request an increase at Azure, then validate the account again.', 'danger', UI.btn('Open account', { size: 'xs', attrs: 'data-go="cloud"' }));
      if (st.mode === 'budget') notices += UI.notice('<b>Budget blocks scale-up.</b> gpu-do-h100 asked for a second node (queue depth 9). do-team is at 103 % of its $4,000 budget, so the change is refused with <span class="mono">budget_exceeded</span>. Requests wait or take the profile fallback; scale-down stays allowed.', 'danger', UI.btn('Open Cloud spend', { size: 'xs', attrs: 'data-go="finops"' }));

      const stats = '<div class="stats">' + UI.stat(String(gpuNodes), 'GPU nodes running', 'across ' + st.pools.length + ' cloud pools') + UI.stat(money(hourly), 'Cost per hour now', 'spot where allowed') + UI.stat(String(st.savedHours), 'GPU-hours scaled down', 'this month') + UI.stat('$' + st.saved, 'Saved by scale to zero', 'estimate, September') + '</div>';

      let table;
      if (st.mode === 'loading') {
        table = '<div class="tablewrap"><table class="dt"><thead><tr><th>Pool</th><th>Provider, node group</th><th>GPU</th><th>Pricing</th><th>Min / max / now</th><th>Scale to zero</th><th>State</th></tr></thead><tbody>' + [1, 2, 3].map(() => '<tr>' + [1, 2, 3, 4, 5, 6, 7].map(() => '<td><div class="skeleton"></div></td>').join('') + '</tr>').join('') + '</tbody></table></div>';
      } else {
        const rows = st.pools.map((p) => ({ cells: ['<span class="mono">' + esc(p.id) + '</span>', esc(p.provider) + ' <span class="muted">' + esc(p.account + ', ' + p.region) + '</span><div class="muted" style="font-size:11px">' + esc(p.where) + '</div>', esc(p.gpu), p.pricing === 'spot' ? UI.pill('spot', 'info') + ' <span class="num">' + money(p.spotRate) + '/h</span><div class="muted" style="font-size:11px">on-demand fallback ' + money(p.odRate) + '/h</div>' : 'on-demand <span class="num">' + money(p.odRate) + '/h</span>', '<span class="num">' + p.min + ' / ' + p.max + ' / ' + p.now + '</span>', p.idle ? 'after ' + p.idle + ' min idle' : '<span class="muted">off (min ' + p.min + ')</span>', UI.pill(p.state, stKind(p.state))], attrs: 'data-id="' + esc(p.id) + '"', selected: p.id === sel.id }));
        rows.push({ cells: ['<span class="muted">none</span>', 'Cloudflare <span class="muted">cf-edge</span>', '<span class="muted">no GPU pools</span>', '—', '—', '—', UI.pill('not available', 'outline')], attrs: 'data-cf title="' + esc(CF_REASON) + '"' });
        table = UI.table(['Pool', 'Provider, node group', 'GPU', 'Pricing', 'Min / max / now', 'Scale to zero', 'State'], rows, { minWidth: '1000px' })
          + '<span class="muted" style="font-size:12px">Cloudflare: ' + esc(CF_REASON) + '. For models at the edge, Workers AI is a model backend: <a href="#" data-go="models">open Models</a>.</span>';
      }

      // inspector
      const blocked = (st.mode === 'quota' && sel.id === 'gpu-azure-se') || (st.mode === 'budget' && sel.id === 'gpu-do-h100');
      const nodes = sel.nodes.length ? UI.table(['Node', 'Capacity', 'Health', 'Models', 'Up'], sel.nodes.map((n) => [esc(n[0]), esc(n[1]), UI.pill(n[2], stKind(n[2])), '<span style="font-size:12px">' + esc(n[3]) + '</span>', esc(n[4])]), { clickable: false, minWidth: '0', cls: 'bare' })
        : '<div class="muted" style="font-size:12px">' + (sel.state === 'warming' ? 'One node starting: launched 09:38, joining the pool with an mTLS certificate from the Exprsn-AI CA, then pulling approved placements from the registry mirror.' : 'No nodes. The pool is scaled to zero; the next request starts one (about ' + esc(sel.coldStart) + ').') + '</div>';
      const spotLine = !sel.spotOk ? 'Not offered by DigitalOcean: on-demand only' : sel.pricing === 'spot' ? 'Spot first, on-demand fallback; interruptions drain the node' : sel.spotOff ? 'Spot off for this pool' : 'On-demand';
      const timeline = sel.id === 'gpu-cloud-eu' ? '<div class="eyebrow">Interruptions</div>' + UI.timeline([{ title: '08:51 Spot notice', text: 'ip-10-40-3-17: 2-minute interruption notice from EC2', tone: 'warn' }, { title: '08:51 Drained', text: 'No new requests; 2 streams finished on the node, 1 resumed on ip-10-40-1-22' }, { title: '08:52 Replacement requested', text: 'Spot capacity short in eu-central-1b; on-demand fallback g6e.2xlarge' }, { title: '08:57 Healthy', text: 'ip-10-40-3-41 joined with placements warm', tone: 'ok' }]) : '';
      const insp = '<div class="hstack"><div class="eyebrow grow">Selected pool</div>' + UI.pill(sel.state, stKind(sel.state)) + '</div><div class="mono" style="font-size:14px;font-weight:500">' + esc(sel.id) + '</div><div class="muted" style="font-size:12px">' + esc(sel.provider + ', ' + sel.account + ', ' + sel.region + ' · ' + sel.where) + '</div>'
        + UI.kv([['GPU', esc(sel.gpu)], ['Cost per hour now', '<span class="num">' + money(sel.now * rate(sel)) + '</span> <span class="muted">(' + sel.now + ' × ' + money(rate(sel)) + ')</span>'], ['Spot policy', esc(spotLine)], ['Cold start', 'about ' + esc(sel.coldStart) + ' including model warm-up'], ['Idle timer', sel.idle ? 'scale to zero after ' + sel.idle + ' min with no slot leases' + (sel.now ? '; last request 09:36' : '') : 'off'], ['Zone and ceiling', esc(sel.zone) + ' ' + UI.label(sel.label, { sm: true })]], 1)
        + '<div class="eyebrow">Nodes</div>' + nodes
        + '<div class="eyebrow">Scale</div><div class="cloud-compute-mm">' + UI.field('Min', UI.input(String(sel.min), { type: 'number', attrs: 'data-min min="0"' })) + UI.field('Max', UI.input(String(sel.max), { type: 'number', attrs: 'data-max min="0"' })) + '</div>'
        + (blocked ? UI.notice(st.mode === 'quota' ? 'Max above 2 is refused: no NCADS_A100_v4 quota left.' : 'Scale-up refused: do-team budget exceeded.', 'danger') : '')
        + '<div class="hstack wrap gap6">' + UI.btn('Save scaling', { kind: 'primary', size: 'sm', attrs: 'data-save' }) + UI.btn('Scale to zero now', { size: 'sm', attrs: 'data-zero', disabled: sel.now === 0 || sel.min > 0, title: sel.min > 0 ? 'Min is ' + sel.min : '' }) + UI.btn('Warm up', { size: 'sm', attrs: 'data-warm', disabled: sel.now > 0 }) + UI.btn('Open in Pools', { size: 'sm', kind: 'ghost', attrs: 'data-pools' }) + '</div>'
        + timeline;

      root.innerHTML = style + '<div class="page">'
        + UI.pagehead('Cloud compute', 'GPU node groups that join the gateway as pools; Ollama runs on each node', UI.btn('Add GPU node group', { kind: 'primary', icon: 'plus', attrs: 'data-add' }))
        + notices + stats + table
        + '<span class="muted" style="font-size:12px">Example data. Prices are illustrative, not provider quotes.</span></div>'
        + (st.mode === 'loading' ? '' : '<aside class="inspector w360">' + insp + '</aside>');

      ctx.on('click', 'tr.row[data-id]', (e, t) => { st.sel = t.dataset.id; ctx.rerender(); });
      ctx.on('click', 'tr[data-cf]', () => ctx.toast('Cloudflare: ' + esc(CF_REASON) + '. Use Workers AI on Models for edge inference.'));
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-pools]', () => ctx.navigate('pools', { pool: sel.id }));
      ctx.on('click', '[data-add]', () => addGroup(ctx, st));
      if (st.openAdd) { st.openAdd = false; setTimeout(() => addGroup(ctx, st), 30); }
      ctx.on('click', '[data-save]', async () => {
        const min = Math.max(0, parseInt(ctx.$('[data-min]').value, 10) || 0), max = Math.max(min, parseInt(ctx.$('[data-max]').value, 10) || 0);
        if (sel.id === 'gpu-azure-se' && max > 2) { st.mode = 'quota'; ctx.rerender(); ctx.toast('Refused: quota. azure-eu has no NCADS_A100_v4 vCPUs left in swedencentral.', 'danger', 5000); return; }
        if (sel.account === 'do-team' && (max > sel.max || min > sel.min)) { st.mode = 'budget'; ctx.rerender(); ctx.toast('Refused: budget_exceeded. Raising capacity on do-team adds cost while the budget is exceeded.', 'danger', 5000); return; }
        const extra = Math.max(0, max - sel.max) * rate(sel) * 730;
        const ok = await ctx.confirm({ title: 'Change scaling for ' + sel.id, tag: 'plan', tone: 'ok', body: '<p class="fg2" style="margin:0">One update to ' + esc(sel.where) + '. Exprsn-AI keeps the desired count between min and max from queue depth and slot leases.</p>', kv: [['Min', sel.min + ' → ' + min], ['Max', sel.max + ' → ' + max], ['Worst-case cost change', extra ? '+' + money(extra) + ' a month' : 'none']], ok: 'Apply' });
        if (!ok) return;
        sel.min = min; sel.max = max; if (sel.now < min) sel.now = min; if (sel.now > max) sel.now = max; if (min > 0) sel.idle = null; else if (!sel.idle) sel.idle = 20;
        ctx.rerender(); ctx.toast('Scaling for ' + esc(sel.id) + ' saved: min ' + min + ', max ' + max + '.', 'ok');
      });
      ctx.on('click', '[data-zero]', async () => {
        const ok = await ctx.confirm({ title: 'Scale ' + sel.id + ' to zero now', tag: 'drain', tone: 'danger', body: '<p class="fg2" style="margin:0">Each node is drained first: streams in progress finish, queued requests move to the profile fallback. The next request starts a node again (about ' + esc(sel.coldStart) + ').</p>', kv: [['Nodes', String(sel.now)], ['Saves', money(sel.now * rate(sel)) + ' an hour']], ok: 'Scale to zero' });
        if (!ok) return;
        sel.now = 0; sel.state = 'scaled to zero'; sel.nodes = []; st.savedHours += 1; ctx.rerender(); ctx.toast(esc(sel.id) + ' drained and scaled to zero.', 'ok');
      });
      ctx.on('click', '[data-warm]', async () => {
        if (sel.account === 'do-team') { st.mode = 'budget'; ctx.rerender(); return; }
        const ok = await ctx.confirm({ title: 'Warm up ' + sel.id, tag: 'scale up', tone: 'ok', body: '<p class="fg2" style="margin:0">Starts one node and pulls the approved placements from the registry mirror, so the first request does not wait for a cold start.</p>', kv: [['Cost', money(rate(sel)) + ' an hour while running'], ['Ready in', 'about ' + sel.coldStart]], ok: 'Warm up' });
        if (!ok) return;
        sel.now = 1; sel.state = 'warming'; if (st.mode === 'cold') st.mode = null; ctx.rerender(); ctx.toast('One node starting in ' + esc(sel.id) + '. It joins the pool when /api/version answers over mTLS.', 'ok');
      });
    }
  });

  function addGroup(ctx, st) {
    const f = { provider: 'AWS', acct: 0, type: 0, spot: true, min: 0, max: 2 };
    const body = () => {
      if (f.provider === 'Cloudflare') return '<div class="formgrid" style="--cols:2">' + UI.field('Provider', UI.select(['AWS', 'Azure', 'DigitalOcean', 'Cloudflare'], f.provider, 'data-f="provider"')) + '</div>' + UI.notice('Cloudflare: ' + esc(CF_REASON) + '. Edge inference is available through Workers AI on the Models screen.', 'info');
      const t = INSTANCE_TYPES[f.provider][f.type]; const q = QUOTA[f.provider]; const free = q[1] - q[2];
      const doSpot = f.provider === 'DigitalOcean';
      const budget = ACCOUNTS[f.provider][f.acct][0] === 'do-team';
      return '<div class="formgrid" style="--cols:2">'
        + UI.field('Provider', UI.select(['AWS', 'Azure', 'DigitalOcean', 'Cloudflare'], f.provider, 'data-f="provider"'))
        + UI.field('Account and region', UI.select(ACCOUNTS[f.provider].map((a, i) => ({ value: String(i), label: a[0] + ', ' + a[1] })), String(f.acct), 'data-f="acct"'))
        + UI.field('Min nodes', UI.input(String(f.min), { type: 'number', attrs: 'data-f="min" min="0"' }), '0 allows scale to zero')
        + UI.field('Max nodes', UI.input(String(f.max), { type: 'number', attrs: 'data-f="max" min="1"' }))
        + '</div>'
        + '<div class="eyebrow">Instance type</div>'
        + UI.table(['', 'Type', 'GPU', { label: 'On-demand per hour', right: true }], INSTANCE_TYPES[f.provider].map((it, i) => ['<input type="radio" name="cc-type" value="' + i + '"' + (i === f.type ? ' checked' : '') + ' aria-label="' + esc(it[0]) + '">', '<span class="mono">' + esc(it[0]) + '</span>', esc(it[1]), '<span class="num">' + money(it[2]) + '</span>']), { clickable: false, minWidth: '0' })
        + '<div class="hstack wrap gap12" style="min-height:30px">' + (doSpot ? '<button type="button" class="toggle" role="switch" aria-checked="false" disabled><span class="sw"></span><span>Spot capacity</span></button><span class="muted" style="font-size:12px">Not offered by DigitalOcean: GPU Droplets are on-demand only.</span>' : UI.toggle('Spot capacity with on-demand fallback', f.spot, 'data-manual="1" data-f="spot"')) + '</div>'
        + UI.kv([['Quota check', (free >= 2 ? UI.pill('ok', 'ok') : UI.pill(free > 0 ? 'tight' : 'exceeded', free > 0 ? 'warn' : 'danger')) + ' ' + esc(q[0]) + ': ' + q[2] + ' of ' + q[1] + ' used'], ['Estimate at max', '<b>' + money(t[2] * f.max * 730) + '</b> a month on-demand' + (f.spot && !doSpot ? ', less on spot' : '')], ['Joins as', 'pool ' + esc((ACCOUNTS[f.provider][f.acct][1].startsWith('us') || ACCOUNTS[f.provider][f.acct][1] === 'nyc3' ? 'gpu-cloud-us' : 'gpu-cloud-eu2')) + ', Ollama per node, mTLS'], ['Scale to zero', +f.min === 0 ? 'after 20 min idle' : 'off']], 2)
        + (budget ? UI.notice('<b>Budget hard stop.</b> do-team is at 103 % of its budget; this plan adds cost and will be refused with budget_exceeded.', 'danger') : '')
        + (free <= 0 ? UI.notice('No quota left for this family. Request an increase at the provider before planning.', 'danger') : '')
        + '<span class="muted" style="font-size:12px">Example data. Prices are illustrative, not provider quotes.</span>';
    };
    ctx.modal({ title: 'Add a GPU node group', cls: 'wide', body: '<div data-ag>' + body() + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create plan', { kind: 'primary', attrs: 'data-plan' }),
      onMount(m) {
        const host = m.querySelector('[data-ag]'); const btn = m.querySelector('[data-plan]');
        const redraw = () => { host.innerHTML = body(); btn.disabled = f.provider === 'Cloudflare' || QUOTA[f.provider] && QUOTA[f.provider][1] - QUOTA[f.provider][2] <= 0; };
        host.addEventListener('change', (e) => { const k = e.target.dataset.f; if (e.target.name === 'cc-type') { f.type = +e.target.value; redraw(); return; } if (!k) return; if (k === 'provider') { f.provider = e.target.value; f.acct = 0; f.type = 0; f.spot = f.provider !== 'DigitalOcean'; } else f[k] = +e.target.value; redraw(); });
        host.addEventListener('click', (e) => { if (e.target.closest('[data-f="spot"]')) { f.spot = !f.spot; redraw(); } });
        btn.addEventListener('click', () => {
          const a = ACCOUNTS[f.provider][f.acct]; const t = INSTANCE_TYPES[f.provider][f.type];
          App.closeOverlay();
          if (a[0] === 'do-team') { st.mode = 'budget'; st.sel = 'gpu-do-h100'; ctx.rerender(); ctx.toast('Refused: budget_exceeded on do-team.', 'danger', 5000); return; }
          const id = 'gpu-' + f.provider.toLowerCase().slice(0, 3) + '-' + a[1].replace(/[^a-z0-9]/g, '').slice(0, 8);
          st.pools.push({ id, provider: f.provider, account: a[0], region: a[1], where: f.provider === 'AWS' ? 'EKS node group ng-' + t[0].split('.')[0] : 'AKS node pool ' + t[0].split('_')[1].toLowerCase(), gpu: t[0] + ', ' + t[1], pricing: f.spot ? 'spot' : 'on-demand', spotRate: f.spot ? +(t[2] * 0.45).toFixed(2) : null, odRate: t[2], min: f.min, max: f.max, now: f.min, idle: f.min === 0 ? 20 : null, state: f.min === 0 ? 'scaled to zero' : 'warming', zone: a[1].startsWith('us') ? 'cloud-us' : 'cloud-eu', label: a[1].startsWith('us') ? 'internal' : 'confidential', spotOk: true, coldStart: '5 min', nodes: [] });
          st.sel = id; ctx.rerender(); ctx.toast('Node group planned and applying: ' + esc(t[0]) + ' in ' + esc(a[1]) + '. It appears on Pools as ' + esc(id) + '.', 'ok', 5000);
        });
      } });
  }
})();
