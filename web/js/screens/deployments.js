(function () {
  const { UI, esc } = App;

  /*
   * Cloud › Deployments (1.9.99-final, Sprint 62: B-10706), from the `deployments` board of the
   * design prototype (removed 2026-10-21). Exprsn-AI deployed to a cloud account: the list with each deployment's
   * estimate and month to date, the wizard (spec → validate-spec → plan with estimate), the plan review with its field
   * changes and blockers, apply by hash with a recent sign-in, the operation journal, verify, drift findings with
   * revert, adopt or ignore and who changed it (B-10703, when the change trail has it), destroy with the second admin's
   * approval of protected resources, releases and upgrades with the pre-upgrade snapshots, and the Cloudflare front door.
   * Every control calls the server: routes/admin/cloud-deployments.ts, cloud-deployment-specs.ts, cloud-lifecycle.ts,
   * cloud-releases.ts, cloud-edge.ts and cloud-budgets.ts.
   */
  const enc = encodeURIComponent;
  const B = '/api/admin/cloud/deployments';
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const PROV = { aws: 'AWS', azure: 'Azure', digitalocean: 'DigitalOcean', cloudflare: 'Cloudflare' };
  const COMPUTE = {
    aws: { kubernetes: 'Amazon EKS', vm: 'EC2 with the bare-metal installer', container: 'ECS Fargate' },
    azure: { kubernetes: 'Azure Kubernetes Service', vm: 'Azure VMs with the bare-metal installer', container: 'Azure Container Apps' },
    digitalocean: { kubernetes: 'DigitalOcean Kubernetes', vm: 'Droplets with the bare-metal installer', container: 'App Platform' }
  };
  const SIZES = [{ id: 'small', label: 'Small' }, { id: 'medium', label: 'Medium' }, { id: 'large', label: 'Large-HA' }];
  const CF_REASON = 'Runs the app tier only; pick a provider for data and GPUs';
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const money = (n, cur) => (n == null ? '—' : (cur && cur !== 'USD' ? '' : '$') + (Math.round(Number(n) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + (cur && cur !== 'USD' ? ' ' + cur : ''));
  const detailOf = (e) => (e && e.problem && e.problem.detail) || (e && e.message) || 'Request failed';
  const overlayOpen = () => !!document.getElementById('overlay');
  const STATE_TEXT = { draft: 'draft', planned: 'plan ready', applying: 'applying', applied: 'applied', ready: 'healthy', degraded: 'degraded', failed: 'failed', destroying: 'destroying', destroyed: 'destroyed' };
  const statePill = (s) => UI.pill(STATE_TEXT[s] || s, s === 'ready' ? 'ok' : /failed|destroy/.test(s) ? 'danger' : /applying|planned|applied/.test(s) ? 'info' : s === 'degraded' ? 'warn' : '');
  const kindPill = (k) => UI.pill(k, k === 'create' ? 'ok' : k === 'delete' ? 'danger' : k === 'replace' ? 'warn' : k === 'noop' ? 'outline' : 'info');
  const val = (v) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // ---------- step-up (applies, destroys, reverts and approvals need a recent sign-in) ----------
  const CANCELLED = {};
  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">Changing a deployment needs a fresh check of who you are.</div>'
        + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
        + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
        + '<div data-suerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }),
      onMount(m) {
        m.querySelector('[data-sugo]').addEventListener('click', async () => {
          const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
          const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
          if (!pwv && !code) { m.querySelector('[data-suerr]').innerHTML = UI.notice('Enter your password or a code.', 'warn'); return; }
          try { await App.post('/api/me/step-up', pwv ? { password: pwv } : { code }); ok = true; App.closeOverlay(); } catch (e) { m.querySelector('[data-suerr]').innerHTML = UI.notice(esc(detailOf(e)), 'danger'); }
        });
      },
      onClose() { resolve(ok); } });
  });
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) return CANCELLED;
      return fn();
    }
  };

  // ---------- describing a deployment from its spec ----------
  const specOf = (d) => d.spec || {};
  const onprem = (d) => d.kind === 'onprem' || specOf(d).kind === 'onprem';
  const INSTALL = { compose: 'Docker Compose', baremetal: 'the bare-metal installer', helm: 'Helm' };
  const targetText = (d) => {
    const s = specOf(d); const c = s.compute;
    if (onprem(d)) return 'on-prem, ' + ((INSTALL[(s.install || {}).kind]) || 'your own install');
    if (!c) return 'not from a spec';
    if (c.shape === 'cloudflare') return 'Cloudflare Containers, assets on Workers';
    return ((COMPUTE[d.provider] || {})[c.shape] || c.shape) + ', ' + ((SIZES.find((x) => x.id === c.size) || {}).label || c.size);
  };
  const dataText = (d) => {
    const x = specOf(d).data;
    if (onprem(d)) return 'stays on-prem, unchanged';
    if (!x) return '—';
    if (x.mode === 'existing') return 'existing database' + (x.redisUrlRef ? ' and Redis' : '') + ' (vault references)';
    if (x.mode === 'onprem') return 'on-prem: ' + (x.cidrs || []).join(', ');
    return 'managed PostgreSQL' + (x.cache === false ? '' : ', managed Redis') + ', object store';
  };
  const frontText = (d) => {
    const f = specOf(d).frontDoor;
    if (!f) return '—';
    return ({ cloudflare: 'Cloudflare DNS, Tunnel, WAF', acme: 'ACME and provider DNS', byo: 'your own' })[f.kind] + ', ' + f.hostname;
  };
  const releaseText = (d) => { const r = specOf(d).release; return r ? (r.version || (r.image ? short(r.image.split('@')[0], 40) : 'pinned release')) : '—'; };
  const urlOf = (d) => { const f = specOf(d).frontDoor; return f && f.hostname ? 'https://' + f.hostname : (d.endpoints && d.endpoints.publicUrl) || null; };

  const init = (st) => { if (st.q === undefined) { st.q = ''; st.tab = 'overview'; } };
  const newWiz = () => ({ step: 1, onprem: false, install: 'compose', service: '', provider: 'aws', accountId: null, region: null, label: 'internal', shape: 'kubernetes', size: 'medium', data: 'provision', cache: true, dbRef: '', redisRef: '', cidrs: '', front: 'acme', cfAccount: null, cfPlan: 'free', host: '', zone: '', name: 'nw-analytics', image: '', tarUrl: '', tarSha: '', keysAddr: '', dry: null, plan: null, deployment: null, problem: null });

  App.register({
    id: 'deployments', title: 'Deployments', section: 'admin', live: true,
    crumb: (st) => (st && st.detail && st.det && st.det.d ? ['Admin', 'Deployments', st.det.d.name] : ['Admin', 'Deployments']),
    summary: 'Exprsn-AI deployed to AWS, Azure, DigitalOcean or Cloudflare: plan, apply, verify, drift, upgrade, destroy',
    commands: [
      { label: 'New deployment', sub: 'Deployments', run(app) { const s = app.stateFor('deployments'); s.detail = null; s.wiz = newWiz(); app.render(); } },
      { label: 'Check drift on every deployment', sub: 'Deployments', run(app) { const s = app.stateFor('deployments'); s.driftAll = true; app.render(); } }
    ],
    states: [
      { title: 'No deployments', tone: 'neutral', text: 'Nothing is deployed yet. The page explains plan, apply and verify and offers New deployment.', apply(ctx) { Object.assign(ctx.state, { view: 'empty', wiz: null, detail: null, want: null }); ctx.rerender(); } },
      { title: 'Loading', tone: 'neutral', text: 'Deployments and their last verification load; rows show skeletons.', apply(ctx) { Object.assign(ctx.state, { view: 'loading', wiz: null, detail: null, want: null }); ctx.rerender(); } },
      { title: 'Plan expired', tone: 'warn', text: 'The reviewed plan is older than 60 minutes or the observed state changed. Apply is disabled until the plan is made again.', apply(ctx) { Object.assign(ctx.state, { view: null, wiz: null, want: 'expired' }); ctx.rerender(); } },
      { title: 'Apply failed, rolled back', tone: 'danger', text: 'An apply failed at a step; later steps never ran, the app tier was rolled back and the network kept for a retry.', apply(ctx) { Object.assign(ctx.state, { view: null, wiz: null, want: 'failed' }); ctx.rerender(); } },
      { title: 'Budget hard stop', tone: 'danger', text: 'The account is past its budget. A plan that adds cost is refused with budget_exceeded; an override needs a second cloud admin.', apply(ctx) { Object.assign(ctx.state, { view: null, wiz: null, want: 'budget' }); ctx.rerender(); } },
      { title: 'Drift detected', tone: 'warn', text: 'A firewall gained inbound SSH from anywhere out of band. Revert, adopt or ignore the field.', apply(ctx) { Object.assign(ctx.state, { view: null, wiz: null, want: 'drift' }); ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'A cloud reader without cloud:deploy sees deployments read-only; New deployment, Upgrade and Destroy are disabled with the reason.', apply(ctx) { Object.assign(ctx.state, { view: 'readonly', wiz: null, detail: null, want: null }); ctx.rerender(); } },
      { title: 'Throttled, retrying', tone: 'warn', text: 'The provider answers a throttling error during an apply. The step waits with backoff and carries on; nothing is created twice.', apply(ctx) { Object.assign(ctx.state, { view: null, wiz: null, want: 'throttled' }); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; init(st);
      const refresh = () => { if (App.state.route !== 'deployments') return; if (overlayOpen()) { st.dirty = true; return; } ctx.rerender(); };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get(B), App.get('/api/admin/cloud/accounts'), App.get('/api/admin/cloud/budgets').catch(() => null)])
          .then(([list, acc, budgets]) => {
            const deps = list.deployments || [];
            return Promise.all(deps.map((d) => Promise.all([
              App.get(B + '/' + enc(d.id) + '/plans?limit=1').then((x) => x.plans[0] || null).catch(() => null),
              App.get(B + '/' + enc(d.id) + '/drift?state=open').then((x) => x.findings.length).catch(() => 0),
              App.get(B + '/' + enc(d.id) + '/costs').then((x) => x.total).catch(() => null)
            ]).then(([plan, drift, cost]) => ({ plan, drift, cost })))).then((extra) => {
              Object.assign(st, { list: deps.map((d, i) => Object.assign({}, d, extra[i])), accounts: acc.accounts || [], budgets: budgets ? budgets.budgets : null, loaded: true, loadError: null });
            });
          })
          .catch((err) => { st.loadError = err; st.loaded = true; })
          .finally(() => { st.loading = false; refresh(); });
      };
      st.reload = () => { st.loaded = false; st.det = null; load(); };
      if (!st.loaded && !st.loading) load();
      // Hash parameters are read once per visit of that hash (App.parse gives them again on every render).
      if (ctx.params.id && st.seenHash !== location.hash) { st.seenHash = location.hash; st.detail = ctx.params.id; st.wiz = null; if (ctx.params.tab) st.tab = ctx.params.tab; else st.tab = 'overview'; delete ctx.params.id; delete ctx.params.tab; }

      const style = '<style>'
        + '.deployments-steps{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:12px}.deployments-steps span{display:inline-flex;align-items:center;gap:6px;padding:0 6px;height:26px;color:var(--muted);font-weight:500}.deployments-steps .cur{color:var(--fg);font-weight:700}.deployments-steps .done{color:var(--fg2)}.deployments-steps .na{text-decoration:line-through}.deployments-steps i{font-style:normal;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--line);font-size:11px}.deployments-steps .cur i{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.deployments-steps .done i{background:var(--fg2);color:var(--bg);border-color:var(--fg2)}.deployments-steps .sep{color:var(--muted)}'
        + '.deployments-tiles{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}.deployments-tile{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);text-align:left;cursor:pointer;font-size:12px;color:var(--fg2)}.deployments-tile b{font-size:13px;color:var(--fg)}.deployments-tile.on{border-color:var(--accent);background:var(--accent-tint)}.deployments-tile[disabled]{cursor:not-allowed}'
        + '.deployments-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}.deployments-fb{display:flex;align-items:center;gap:8px;padding-top:10px;border-top:1px solid var(--line);flex-wrap:wrap}.deployments-ch{font-size:12px;overflow-wrap:anywhere}.deployments-ch div{margin:1px 0}.deployments-wrap{overflow-wrap:anywhere}'
        + '</style>';
      const canDeploy = App.can('cloud:deploy') && st.view !== 'readonly';
      const ro = !canDeploy;
      const roTitle = ro ? 'Needs cloud:deploy' : '';
      const head = (actions) => UI.pagehead('Deployments', 'Exprsn-AI itself on AWS, Azure, DigitalOcean or Cloudflare: plan, apply, verify, drift, upgrade, destroy', actions);

      if (st.loadError) {
        const missing = st.loadError.problem && st.loadError.problem.reason === 'migration_pending';
        root.innerHTML = style + '<div class="page">' + head('') + (missing
          ? UI.empty('Deployments are not installed', 'This server has not applied the deployment migrations yet. Until it does, nothing can be planned or applied.', UI.btn('Check again', { attrs: 'data-reload' }))
          : UI.problem('Deployments could not be loaded', detailOf(st.loadError), (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>') + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; st.reload(); });
        return;
      }
      const loading = st.view === 'loading' || !st.loaded;
      const list = st.list || [];
      if (st.loaded && st.want) resolveWant(st, list);
      if (st.driftAll && st.loaded) { st.driftAll = false; checkAll(ctx, st); }

      if (st.wiz && st.loaded) { renderWizard(root, ctx, st, style); return; }
      if (st.detail && st.loaded) { renderDetail(root, ctx, st, style, ro, roTitle); return; }

      const actions = UI.btn('Check drift', { icon: 'refresh', attrs: 'data-drift-all', disabled: ro || loading, title: roTitle }) + UI.btn('New deployment', { kind: 'primary', icon: 'plus', attrs: 'data-new', disabled: ro, title: roTitle });
      const roNotice = st.view === 'readonly' || !App.can('cloud:deploy') ? UI.notice('<b>Read-only: you need cloud:deploy.</b> Your roles grant cloud:read. New deployment, Upgrade and Destroy stay disabled; ask a cloud admin for the Cloud operator role.', 'danger', st.view === 'readonly' ? UI.btn('Back to the full view', { size: 'xs', attrs: 'data-reset' }) : '') : '';
      if (!loading && (st.view === 'empty' || !list.length)) {
        root.innerHTML = style + '<div class="page">' + head(actions) + roNotice + UI.empty('No deployments yet', 'A deployment is Exprsn-AI with its database, cache, object store and front door in one cloud account. Exprsn-AI plans the resources, shows the cost and the diff, applies them through the provider APIs and verifies the result.', canDeploy ? UI.btn('New deployment', { kind: 'primary', attrs: 'data-new' }) : '')
          + '<div class="grid3">' + UI.panel('Plan', '<div class="fg2" style="font-size:12px">The desired resources against what the account has: create, update, replace, delete, with the monthly cost delta.</div>') + UI.panel('Apply', '<div class="fg2" style="font-size:12px">A journal of idempotent steps that survives a restart, within the provider\'s rate limits.</div>') + UI.panel('Verify and watch', '<div class="fg2" style="font-size:12px">/readyz, TLS and database checks after apply; drift checks every hour after that.</div>') + '</div>'
          + (st.view === 'empty' && list.length ? '<div>' + UI.btn('Show the deployments', { size: 'sm', attrs: 'data-reset' }) + '</div>' : '') + '</div>';
        ctx.on('click', '[data-new]', () => { st.wiz = newWiz(); ctx.rerender(); });
        ctx.on('click', '[data-reset]', () => { st.view = null; ctx.rerender(); });
        return;
      }

      const q = (st.q || '').toLowerCase();
      const acct = (id) => (st.accounts || []).find((a) => a.id === id);
      const rows = list.filter((d) => !q || (d.name + ' ' + d.provider + ' ' + ((acct(d.accountId) || {}).name || '') + ' ' + d.region + ' ' + targetText(d)).toLowerCase().indexOf(q) >= 0);
      if (!rows.some((d) => d.id === st.sel) && rows.length) st.sel = rows[0].id;
      const sel = list.find((d) => d.id === st.sel);
      const drifted = list.filter((d) => d.drift > 0);
      const month = new Date().toLocaleString(undefined, { month: 'long' });
      const est = (d) => (d.plan && d.plan.estimate ? d.plan.estimate.monthly : null);
      const total = list.reduce((a, d) => a + (est(d) || 0), 0);
      const table = loading
        ? '<div class="tablewrap"><table class="dt"><caption class="sr">Loading deployments</caption><tbody>' + [1, 2, 3, 4].map(() => '<tr><td><div class="skeleton" style="width:110px"></div></td><td><div class="skeleton" style="width:160px"></div></td><td><div class="skeleton" style="width:200px"></div></td><td><div class="skeleton" style="width:80px"></div></td></tr>').join('') + '</tbody></table></div>'
        : UI.table(['Deployment', 'Account and region', 'Target', 'Data tier', 'Front door', 'Release', 'State', { label: 'Est. a month', right: true }, { label: month, right: true }], rows.map((d) => ({
          cells: ['<span class="mono" style="font-weight:600">' + esc(d.name) + '</span>', '<span class="pill outline">' + esc(PROV[d.provider] || d.provider) + '</span> ' + esc((acct(d.accountId) || {}).name || '') + '<div class="muted" style="font-size:11px">' + esc(d.region) + '</div>', esc(targetText(d)), '<span style="font-size:12px">' + esc(dataText(d)) + '</span>', '<span style="font-size:12px">' + esc(frontText(d)) + '</span>', esc(releaseText(d)),
            statePill(d.state) + (d.drift ? ' ' + UI.pill('drift ' + d.drift, 'warn') : '') + (d.plan && d.plan.state === 'open' && d.plan.blockers && d.plan.blockers.length ? '<div class="muted" style="font-size:11px">' + esc(short(d.plan.blockers[0], 70)) + '</div>' : ''),
            '<span class="num">' + money(est(d), d.plan && d.plan.estimate && d.plan.estimate.currency) + '</span>', '<span class="num">' + (d.cost ? money(d.cost.actual) : '—') + '</span>'],
          attrs: 'data-id="' + esc(d.id) + '" tabindex="0"', selected: d.id === st.sel
        })), { minWidth: '1180px', emptyTitle: 'No deployments match', emptyText: 'Clear the filter.' });
      let insp = '';
      if (loading) insp = '<div class="skeleton" style="width:60%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div>';
      else if (sel) {
        const a = acct(sel.accountId) || {}; const reg = (a.regions || []).find((r) => r.region === sel.region);
        const url = urlOf(sel);
        insp = '<div class="hstack"><div class="eyebrow grow">Deployment</div>' + statePill(sel.state) + '</div><div class="deployments-name">' + esc(sel.name) + '</div>' + (url ? '<div class="mono deployments-wrap" style="font-size:12px">' + esc(url) + '</div>' : '')
          + UI.kv([['Account', '<a href="#" data-acct="' + esc(sel.accountId) + '">' + esc(a.name || sel.accountId) + '</a>'], ['Region', esc(sel.region) + ' ' + UI.label(reg ? reg.ceiling : sel.label, { sm: true })], ['Target', esc(targetText(sel))], ['Data tier', esc(dataText(sel))], ['Front door', esc(frontText(sel))], ['Release', esc(releaseText(sel))], ['Estimate', money(est(sel)) + ' a month'], [month + ' to date', sel.cost ? money(sel.cost.actual) + ' <span class="muted">(estimate ' + money(sel.cost.estimate) + ')</span>' : '—']], 1)
          + (sel.plan && sel.plan.state === 'open' && !sel.plan.applicable ? UI.notice(esc(sel.plan.blockers.join(' ')), 'warn') : '') + (sel.drift ? UI.notice(sel.drift + ' field' + (sel.drift === 1 ? '' : 's') + ' drifted from the desired state.', 'warn') : '')
          + '<div class="hstack wrap gap6">' + UI.btn('Open deployment', { kind: 'primary', size: 'sm', attrs: 'data-open' }) + (App.screens && App.screens['cloud-spend'] ? UI.btn('Cloud spend', { size: 'sm', attrs: 'data-go="cloud-spend"' }) : '') + '</div>';
      }
      root.innerHTML = style + '<div class="page">' + head(actions) + roNotice
        + (drifted.length && !loading ? UI.notice('<b>Drift:</b> ' + drifted.map((d) => esc(d.name) + ' (' + d.drift + ')').join(', ') + '. Drift is checked every hour and when you ask.', 'warn', UI.btn('Review', { size: 'xs', attrs: 'data-review-drift="' + esc(drifted[0].id) + '"' })) : '')
        + '<div class="toolbar">' + UI.search('Filter deployments', 'data-search', st.q) + '<span class="muted right" style="font-size:12px">' + rows.length + ' of ' + list.length + ' deployments · estimated ' + money(total) + ' a month</span></div>'
        + table + '</div><aside class="inspector w360" aria-label="Deployment details">' + insp + '</aside>';
      const pick = (t) => { if (!t.dataset.id) return; if (st.sel === t.dataset.id) { st.detail = t.dataset.id; st.tab = 'overview'; st.det = null; } st.sel = t.dataset.id; ctx.rerender(); };
      ctx.on('click', 'tr.row', (e, t) => pick(t));
      ctx.on('keydown', 'tr.row', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(t); } });
      ctx.on('input', '[data-search]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', '[data-open]', () => { st.detail = st.sel; st.tab = 'overview'; st.det = null; ctx.rerender(); });
      ctx.on('click', '[data-review-drift]', (e, t) => { st.detail = t.dataset.reviewDrift; st.tab = 'drift'; st.det = null; ctx.rerender(); });
      ctx.on('click', '[data-new]', () => { st.wiz = newWiz(); ctx.rerender(); });
      ctx.on('click', '[data-reset]', () => { st.view = null; ctx.rerender(); });
      ctx.on('click', '[data-drift-all]', () => checkAll(ctx, st));
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-acct]', (e, t) => { e.preventDefault(); ctx.navigate('cloud', { id: t.dataset.acct }); });
    }
  });

  /** A design state that needs data: pick the deployment it is about once the list is loaded. */
  function resolveWant(st, list) {
    const w = st.want; st.want = null;
    const by = (f) => list.find(f) || list[0];
    if (!list.length) return;
    st.mode = null; st.throttled = false; st.forceExpired = false;
    if (w === 'expired') { const d = by((x) => x.currentPlanId); st.detail = d.id; st.tab = 'plan'; st.forceExpired = true; }
    else if (w === 'failed') { const d = by((x) => /failed|degraded/.test(x.state)); st.detail = d.id; st.tab = 'overview'; st.mode = 'failed'; }
    else if (w === 'budget') { const d = by((x) => x.state === 'planned'); st.detail = d.id; st.tab = 'overview'; st.mode = 'budget'; }
    else if (w === 'drift') { const d = by((x) => x.drift > 0); st.detail = d.id; st.tab = 'drift'; }
    else if (w === 'throttled') { const d = by((x) => x.plan && x.plan.purpose === 'apply' && x.state !== 'planned'); st.detail = d.id; st.tab = 'operations'; st.throttled = true; }
    st.det = null;
  }

  async function checkAll(ctx, st) {
    const list = (st.list || []).filter((d) => d.state !== 'destroyed' && d.state !== 'draft');
    let n = 0; const issues = [];
    for (const d of list) {
      try { await App.post(B + '/' + enc(d.id) + '/drift/check'); n++; } catch (err) { issues.push(d.name + ' (' + detailOf(err) + ')'); }
    }
    ctx.toast('Drift checked on ' + n + ' of ' + list.length + ' deployments.' + (issues.length ? ' Not checked: ' + esc(issues.join(', ')) + '.' : ''), issues.length ? 'warn' : 'ok', 6000);
    st.reload();
  }

  // ---------------- detail ----------------
  function loadDetail(ctx, st) {
    if (st.detLoading) return;
    const id = st.detail;
    st.detLoading = true;
    const get = (sfx, fallback) => App.get(B + '/' + enc(id) + sfx).catch((err) => (fallback === undefined ? Promise.reject(err) : fallback));
    Promise.all([get(''), get('/graph'), get('/plans?limit=20'), get('/operations?limit=400'), get('/drift', { findings: [] }), get('/destroy', { destroys: [] }), get('/releases', { releases: [] }), get('/upgrades', { upgrades: [] }), get('/snapshots', { snapshots: [] }), App.get('/api/admin/cloud/edge').catch(() => ({ edges: [] }))])
      .then(([d, graph, plans, ops, drift, destroys, releases, upgrades, snaps, edge]) => {
        const plan = d.currentPlanId ? (plans.plans || []).find((p) => p.id === d.currentPlanId) || null : null;
        st.det = { id, d, graph, plans: plans.plans || [], plan, ops: ops.operations || [], drift: drift.findings || [], destroys: destroys.destroys || [], releases: releases.releases || [], upgrades: upgrades.upgrades || [], snapshots: snaps.snapshots || [], edges: (edge.edges || []).filter((x) => x.deploymentId === id), error: null };
      })
      .catch((err) => { st.det = { id, error: err }; })
      .finally(() => {
        st.detLoading = false;
        if (App.state.route !== 'deployments') return;
        if (overlayOpen()) { st.dirty = true; return; }
        ctx.rerender();
        // Follow an apply or a destroy while it runs (the journal grows step by step).
        const live = st.det && st.det.d && (st.det.d.state === 'applying' || st.det.d.state === 'destroying' || (st.det.destroys || []).some((x) => x.state === 'running'));
        clearTimeout(st.poll);
        if (live) st.poll = setTimeout(() => { if (App.state.route === 'deployments' && st.detail === id && !overlayOpen()) { st.det = null; ctx.rerender(); } }, 3000);
      });
  }

  function renderDetail(root, ctx, st, style, ro, roTitle) {
    if (!st.det || st.det.id !== st.detail) {
      root.innerHTML = style + '<div class="page">' + UI.pagehead('Deployment', 'Loading the deployment, its graph and its journal', UI.btn('All deployments', { attrs: 'data-back' })) + '<div class="skeleton" style="width:60%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div></div>';
      ctx.on('click', '[data-back]', () => { st.detail = null; ctx.rerender(); });
      loadDetail(ctx, st);
      return;
    }
    const x = st.det;
    if (x.error) {
      root.innerHTML = style + '<div class="page">' + UI.pagehead('Deployment', '', UI.btn('All deployments', { attrs: 'data-back' })) + UI.problem('The deployment could not be loaded', detailOf(x.error), (x.error.problem && x.error.problem.trace_id) || false) + '</div>';
      ctx.on('click', '[data-back]', () => { st.detail = null; st.det = null; ctx.rerender(); });
      return;
    }
    const d = x.d;
    const acct = (st.accounts || []).find((a) => a.id === d.accountId) || {};
    const reg = (acct.regions || []).find((r) => r.region === d.region);
    const res = (x.graph.resources || []).filter((r) => r.state !== 'deleted');
    const open = x.drift.filter((f) => f.state === 'open');
    const liveDestroy = x.destroys.find((y) => y.state === 'running' || y.state === 'waiting');
    const plan = x.plan || x.plans.find((p) => p.state === 'open') || null;
    // An on-prem install has no compute, data or GPUs here: its front door (tunnel and DNS) is what is managed.
    const tabList = onprem(d) ? [{ id: 'overview', label: 'Overview' }, { id: 'front', label: 'Front door', count: x.edges.length }, { id: 'plan', label: 'Plan' }, { id: 'operations', label: 'Operations' }]
      : [{ id: 'overview', label: 'Overview' }, { id: 'resources', label: 'Resources', count: res.length }, { id: 'plan', label: 'Plan' }, { id: 'drift', label: 'Drift', count: open.length }, { id: 'operations', label: 'Operations' }, { id: 'releases', label: 'Releases' }, { id: 'front', label: 'Front door', count: x.edges.length }];
    if (!tabList.some((t) => t.id === st.tab)) st.tab = 'overview';
    const tabs = UI.tabs(tabList, st.tab);
    let body = '';
    if (st.tab === 'overview') body = onprem(d) ? onpremOverview(st, x, d, plan, ro) : overview(st, x, d, acct, reg, plan, liveDestroy, ro);
    else if (st.tab === 'resources') body = resourcesTab(x, res, open);
    else if (st.tab === 'plan') body = planTab(st, x, d, plan, ro);
    else if (st.tab === 'drift') body = driftTab(x, open, ro);
    else if (st.tab === 'operations') body = opsTab(st, x, d, ro);
    else if (st.tab === 'releases') body = releasesTab(x, d, ro);
    else body = frontTab(st, x, d, ro);
    const actions = UI.btn('All deployments', { attrs: 'data-back' }) + UI.btn('Verify', { attrs: 'data-verify', disabled: ro || !res.length, title: roTitle }) + (plan && plan.state === 'open' ? UI.btn('Review plan', { kind: 'primary', attrs: 'data-tabgo="plan"' }) : '') + UI.btn('Destroy', { kind: 'danger', attrs: 'data-destroy', disabled: ro || !!liveDestroy || d.state === 'destroyed' || !res.length, title: ro ? roTitle : liveDestroy ? 'A destroy is already in progress' : '' });
    root.innerHTML = style + '<div class="page">' + UI.pagehead(d.name, statePill(d.state) + ' <span class="pill outline">' + esc(PROV[d.provider] || d.provider) + '</span> ' + esc(acct.name || '') + ', ' + esc(d.region), actions)
      + (ro ? UI.notice('Read-only: you need cloud:deploy to change this deployment.', 'danger') : '') + tabs + '<div class="vstack gap12">' + body + '</div></div>';
    bindDetail(ctx, st, x, d, plan, liveDestroy);
  }

  function overview(st, x, d, acct, reg, plan, liveDestroy, ro) {
    let notice = '';
    const lastApply = x.plans.find((p) => p.state === 'failed');
    if (st.mode === 'budget' || (x.problem && x.problem.reason === 'budget_exceeded')) {
      notice = '<div class="vstack gap6">' + UI.problem('Plan refused: budget_exceeded', (x.problem && x.problem.detail) || (acct.name || 'The account') + ' is past its monthly budget. Plans that add cost are refused past 100 %; scale-down and destroy still work.', (x.problem && x.problem.trace_id) || false)
        + '<div class="hstack gap6">' + UI.btn('Request override', { size: 'sm', attrs: 'data-override', disabled: ro }) + UI.btn('Open Cloud accounts', { size: 'sm', kind: 'ghost', attrs: 'data-acct="' + esc(d.accountId) + '"' }) + '</div></div>';
    } else if (st.mode === 'failed' || (lastApply && /failed|degraded/.test(d.state))) {
      const failedOp = x.ops.slice().reverse().find((o) => o.state === 'failed');
      notice = UI.notice('<b>' + (d.state === 'degraded' ? 'Verify failed after the last apply.' : 'The last apply failed' + (failedOp ? ' at ' + esc(failedOp.resourceKey) : '') + '.') + '</b> ' + esc((failedOp && failedOp.error) || (lastApply && lastApply.note) || 'Later steps never ran; what was created is kept so a new plan starts where this one stopped.')
        + (d.verify && d.verify.rollback && d.verify.rollback.offered ? ' A rollback to the last verified state is offered.' : ''), 'danger', UI.btn('Plan again', { size: 'xs', attrs: 'data-replan', disabled: ro }) + ' ' + UI.btn('Roll back', { size: 'xs', attrs: 'data-rollback', disabled: ro }));
    } else if (d.state === 'applying') {
      const done = x.ops.filter((o) => o.planId === d.currentPlanId && (o.state === 'succeeded' || o.state === 'adopted')).length;
      notice = UI.notice('<b>Applying.</b> ' + done + ' of ' + (plan ? plan.steps.filter((s) => s.action !== 'noop').length : '?') + ' steps done.', 'info', UI.btn('Operations', { size: 'xs', attrs: 'data-tabgo="operations"' }));
    } else if (plan && plan.state === 'open') {
      notice = UI.notice('<b>Plan ready.</b> ' + summaryText(plan) + (plan.applicable ? '' : ' It cannot be applied yet: ' + esc(plan.blockers.join(' '))), plan.applicable ? 'info' : 'warn', UI.btn('Review plan', { size: 'xs', attrs: 'data-tabgo="plan"' }));
    }
    const destroyPanel = liveDestroy ? destroyView(liveDestroy, ro) : '';
    const v = d.verify;
    const checks = v ? v.checks.concat(v.resources.filter((r) => r.status !== 'pass')) : [];
    const verify = UI.panel('Verification', (v ? UI.table(['Check', 'Result'], (checks.length ? checks : v.resources).map((c) => [esc((c.key ? c.key + ': ' : '') + (c.detail || c.id)), UI.pill(c.status, c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'danger' : '')]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }) + '<span class="muted" style="font-size:12px">Last verified ' + esc(when(v.at)) + (v.ok ? ', every check passed.' : '.') + '</span>' : '<div class="muted" style="font-size:12px">Not verified yet. Verify reads /readyz, the database, Redis and the TLS chain once the app answers.</div>'));
    const url = urlOf(d);
    const cost = x.plans.find((p) => p.estimate);
    return notice + destroyPanel + '<div class="grid2">' + UI.panel('Deployment', UI.kv([['Account', '<a href="#" data-acct="' + esc(d.accountId) + '">' + esc(acct.name || d.accountId) + '</a>'], ['Region', esc(d.region) + ' ' + UI.label(reg ? reg.ceiling : d.label, { sm: true })], ['Data label', UI.label(d.label, { sm: true })], ['Target', esc(targetText(d))], ['Data tier', esc(dataText(d)) + ' <a href="#" data-go="cloud-data" style="font-size:12px">Cloud data</a>'], ['Front door', esc(frontText(d))], ['Release', esc(releaseText(d))], ['Public URL', url ? '<span class="mono deployments-wrap">' + esc(url) + '</span>' : '—'], ['Cost', cost ? money(cost.estimate.monthly, cost.estimate.currency) + ' a month estimated' : 'no estimate yet']], 2)) + verify + '</div>';
  }

  function onpremOverview(st, x, d, plan, ro) {
    const s = specOf(d); const i = s.install || {};
    return (plan && plan.state === 'open' ? UI.notice('<b>Plan ready.</b> ' + summaryText(plan), 'info', UI.btn('Review plan', { size: 'xs', attrs: 'data-tabgo="plan"' })) : '')
      + UI.panel('On-prem install', UI.kv([['Install', esc(INSTALL[i.kind] || i.kind || '—')], ['Version', esc(i.version || '—')], ['Tunnel reaches', '<span class="mono deployments-wrap">' + esc(i.service || 'the install\'s default address') + '</span>'], ['Data label', UI.label(d.label, { sm: true })], ['Compute, data, GPUs', 'stay where they are; nothing is planned for them']], 2))
      + frontTab(st, x, d, ro);
  }

  function summaryText(p) { const s = p.summary; return s.create + ' create, ' + s.update + ' update, ' + s.replace + ' replace, ' + s.delete + ' delete' + (p.estimate ? ', ' + (p.estimate.delta >= 0 ? '+' : '') + money(p.estimate.delta, p.estimate.currency) + ' a month' : '') + '.'; }

  function destroyView(y, ro) {
    const me = App.me && App.me.user && App.me.user.id;
    const mine = y.requestedBy === me;
    const rows = y.protected.map((p) => [
      '<span class="mono">' + esc(p.key) + '</span> <span class="muted">' + esc(p.type) + '</span>',
      UI.pill(p.snapshot.state === 'taken' ? 'snapshot taken' : 'snapshot ' + p.snapshot.state, p.snapshot.state === 'taken' ? 'ok' : p.snapshot.state === 'failed' || p.snapshot.state === 'unsupported' ? 'danger' : 'info') + (p.snapshot.reason ? '<div class="muted" style="font-size:11px">' + esc(p.snapshot.reason) + '</div>' : ''),
      p.deleted ? UI.pill('deleted', 'outline') : UI.pill(p.approval.state, p.approval.state === 'approved' ? 'ok' : p.approval.state === 'rejected' ? 'danger' : 'warn'),
      p.approval.state === 'pending' && !p.deleted ? '<div class="hstack gap6">' + UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-papprove="' + esc(p.key) + '"', disabled: ro || mine, title: mine ? 'Another cloud admin approves what you asked' : '' }) + UI.btn('Reject', { size: 'xs', attrs: 'data-preject="' + esc(p.key) + '"', disabled: ro }) + '</div>' : ''
    ]);
    return UI.panel('Destroy ' + (y.state === 'waiting' ? 'waiting for approval' : y.state), (y.reason ? '<div class="fg2" style="font-size:12px">Reason: ' + esc(y.reason) + '</div>' : '')
      + (y.protected.length ? UI.table(['Protected resource', 'Final snapshot', 'Approval', { label: '', srLabel: 'Actions' }], rows, { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }) + '<span class="muted" style="font-size:12px">A protected resource is deleted only after its final snapshot is taken and a second cloud admin approves; snapshots are kept 30 days.</span>' : '<div class="muted" style="font-size:12px">Nothing protected: resources are deleted in reverse dependency order.</div>')
      + '<div class="hstack gap6">' + UI.btn('Cancel destroy', { size: 'sm', attrs: 'data-dcancel="' + esc(y.id) + '"', disabled: ro || y.state !== 'waiting' }) + '</div>', { cls: '', attrs: 'data-destroy-panel' });
  }

  function resourcesTab(x, res, open) {
    const drifted = {}; open.forEach((f) => { if (f.key) drifted[f.key] = true; });
    const link = (r) => (r.type === 'database' || r.type === 'cache' || r.type === 'bucket' ? ' <a href="#" data-go="cloud-data" style="font-size:12px">open</a>' : r.type === 'node_group' ? ' <a href="#" data-go="cloud-compute" style="font-size:12px">open</a>' : '');
    return UI.table(['Resource', 'Provider id', 'Kind', 'Region', 'State'], res.map((r) => [
      '<span class="mono">' + esc(r.key) + '</span>' + (r.protect || r.type === 'database' ? ' ' + UI.pill('protected', 'outline') : '') + link(r),
      '<span class="mono" style="font-size:12px">' + esc(r.providerId || 'not created') + '</span>', esc(r.type), esc(r.region),
      drifted[r.key] ? UI.pill('drifted', 'warn') : UI.pill(r.state === 'ready' ? 'in sync' : r.state, r.state === 'ready' ? 'ok' : r.state === 'failed' || r.state === 'missing' ? 'danger' : /creating|updating|deleting/.test(r.state) ? 'info' : '')
    ]), { clickable: false, minWidth: '760px', emptyTitle: 'Nothing created yet', emptyText: 'Apply the plan to create the resources.' })
      + '<span class="muted" style="font-size:12px">Every resource carries the tags exprsn:managed, exprsn:deployment=' + esc(x.d.name) + ' and exprsn:account.</span>';
  }

  function changeText(c) {
    return '<div><span class="mono">' + esc(c.path) + '</span>: ' + esc(short(val(c.before), 80)) + ' → ' + esc(short(val(c.after), 120)) + (c.forcesReplace ? ' ' + UI.pill('forces replace', 'warn') : '') + '</div>';
  }

  function planTab(st, x, d, plan, ro) {
    if (!plan) {
      const last = x.plans[0];
      return UI.empty('No open plan', last ? 'The last plan is ' + last.state + (last.note ? ': ' + last.note : '') + '. Make a new one from the desired graph to see what would change.' : 'Make a plan to see what would change.', last ? UI.btn('Plan again', { kind: 'primary', attrs: 'data-replan', disabled: ro }) : '')
        + (x.plans.length ? UI.panel('Earlier plans', UI.table(['Made', 'Purpose', 'Changes', 'State'], x.plans.slice(0, 8).map((p) => [esc(when(p.createdAt)), esc(p.purpose), esc(summaryText(p)), UI.pill(p.state)]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' })) : '');
    }
    const expired = st.forceExpired || plan.expiresAt < Date.now() || plan.state === 'stale' || plan.state === 'expired';
    const s = plan.summary;
    const steps = plan.steps.filter((p) => p.action !== 'noop');
    const est = plan.estimate;
    const lines = est && est.lines ? est.lines : [];
    return (expired ? UI.notice('<b>This plan expired.</b> It is older than 60 minutes or the observed state changed. Make it again before applying.', 'warn', UI.btn('Plan again', { size: 'xs', attrs: 'data-replan', disabled: ro })) : '')
      + (plan.blockers.length ? UI.notice('<b>It cannot be applied as it is.</b> ' + esc(plan.blockers.join(' ')), 'danger') : '')
      + '<div class="stats">' + UI.stat(String(s.create), 'create') + UI.stat(String(s.update), 'update') + UI.stat(String(s.replace), 'replace') + UI.stat(String(s.delete), 'delete') + UI.stat(est ? (est.delta >= 0 ? '+' : '') + money(est.delta, est.currency) : '—', 'a month') + '</div>'
      + UI.table(['Change', 'Resource', 'Field changes', 'Notes'], steps.map((p) => [kindPill(p.action), '<span class="mono">' + esc(p.key) + '</span> <span class="muted">' + esc(p.type) + '</span>', '<div class="deployments-ch">' + (p.changes.length ? p.changes.slice(0, 6).map(changeText).join('') + (p.changes.length > 6 ? '<div class="muted">and ' + (p.changes.length - 6) + ' more fields</div>' : '') : '<span class="muted">none</span>') + '</div>',
        (p.blocked ? UI.pill('blocked', 'danger') + ' <span style="font-size:12px">' + esc(p.blocked) + '</span>' : p.unavailable ? UI.pill(p.unavailable.support === 'not_yet' ? 'not built yet' : 'unsupported', 'warn') + ' <span style="font-size:12px">' + esc(p.unavailable.reason) + '</span>' : p.adopts ? UI.pill('adopts', 'info') : '') + (p.reason ? '<div class="muted" style="font-size:11px">' + esc(p.reason) + '</div>' : '')]), { clickable: false, minWidth: '900px', emptyTitle: 'Nothing to change', emptyText: 'The account already matches the desired graph.' })
      + (lines.length ? UI.panel('Cost estimate', UI.table(['Item', 'SKU', { label: 'A month', right: true }], lines.map((l) => ['<span class="mono">' + esc(l.key) + '</span> <span class="muted">' + esc(l.type) + '</span>', '<span class="mono" style="font-size:12px">' + esc(l.sku) + '</span>', '<span class="num">' + money(l.monthly, est.currency) + '</span>']).concat([['<b>Total</b>', '', '<b class="num">' + money(est.monthly, est.currency) + '</b>']]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }) + '<span class="muted" style="font-size:12px">' + esc(((est.assumptions || {}).notes || []).join(' ')) + '</span>') : '')
      + UI.reviewbar('Plan <span class="mono">' + esc(plan.hash.slice(0, 12)) + '…</span>, made ' + esc(when(plan.createdAt)) + ', valid until ' + esc(when(plan.expiresAt)) + '. Apply accepts only this hash.',
        UI.btn('Plan again', { size: 'sm', attrs: 'data-replan', disabled: ro }) + UI.btn('Apply', { kind: 'primary', size: 'sm', attrs: 'data-apply', disabled: ro || expired || !plan.applicable || plan.state !== 'open', title: expired ? 'Plan expired' : !plan.applicable ? 'The plan has blockers' : '' }));
  }

  function driftTab(x, open, ro) {
    const decided = x.drift.filter((f) => f.state !== 'open').slice(0, 10);
    const TRAIL = { unavailable: 'The provider\'s activity log could not be read', not_found: 'No change found in the provider\'s activity log for this resource', unsupported: 'This provider keeps no activity log Exprsn-AI can read (DigitalOcean)', pending: 'Looking in the provider\'s activity log' };
    const changedBy = (f) => {
      const c = f.changedBy;
      if (c) return (c.byExprsn ? UI.pill('Exprsn-AI', 'info') + ' ' : '') + 'changed by ' + esc(String(c.principal || 'an unknown principal')) + (c.principalType ? ' <span class="muted">(' + esc(c.principalType) + ')</span>' : '') + (c.at ? ' at ' + esc(when(c.at)) : '')
        + '<div class="muted" style="font-size:11px">' + esc([c.source, c.action, c.eventId ? 'event ' + short(String(c.eventId), 16) : '', c.sourceIp ? 'from ' + c.sourceIp : ''].filter(Boolean).join(', ')) + (c.byExprsn ? '; the change was Exprsn-AI\'s own' : '') + '</div>';
      const t = f.trail;
      if (t && t.state) return '<span class="muted">' + esc(TRAIL[t.state] || ('Change trail: ' + t.state)) + (t.error ? ': ' + esc(short(String(t.error), 120)) : '') + (t.checkedAt ? ', checked ' + esc(when(t.checkedAt)) : '') + '.</span>';
      return '<span class="muted">Not looked up yet.</span>';
    };
    const body = open.length
      ? open.map((f) => UI.notice('<b class="mono">' + esc(f.key || f.providerId || '') + '</b> ' + esc(f.detail || (f.kind === 'missing' ? 'is missing at the provider.' : f.kind === 'unmanaged' ? 'exists at the provider but not in the graph.' : 'differs from the desired state.')), 'warn')).join('')
        + UI.table(['Resource', 'Field', 'Desired', 'Observed', 'Changed by', { label: '', srLabel: 'Decide' }], open.map((f) => ['<span class="mono">' + esc(f.key || f.providerId || '') + '</span> <span class="muted">' + esc(f.type) + '</span>', esc(f.path || f.kind), '<div class="deployments-ch">' + esc(short(val(f.desired), 240)) + '</div>', '<div class="deployments-ch" style="color:var(--warn-fg)">' + esc(short(val(f.observed), 240)) + '</div>', '<span style="font-size:12px">' + changedBy(f) + '</span>',
          '<div class="hstack wrap gap6">' + UI.btn('Revert to desired', { kind: 'primary', size: 'xs', attrs: 'data-drift="revert" data-fid="' + esc(f.id) + '"', disabled: ro }) + UI.btn('Adopt as desired', { size: 'xs', attrs: 'data-drift="adopt" data-fid="' + esc(f.id) + '"', disabled: ro }) + UI.btn('Ignore this field', { size: 'xs', kind: 'ghost', attrs: 'data-drift="ignore" data-fid="' + esc(f.id) + '"', disabled: ro }) + '</div>']), { clickable: false, minWidth: '1100px' })
        + '<span class="muted" style="font-size:12px">Revert makes a plan back to the desired state and applies it. Adopt writes the observed value into the desired state. Ignore stops reporting this field.</span>'
      : UI.empty('No drift', 'Every managed resource matches its desired state. Drift is checked every hour.');
    return body + '<div class="hstack gap6">' + UI.btn('Check drift now', { size: 'sm', icon: 'refresh', attrs: 'data-drift-check', disabled: ro }) + '</div>'
      + (decided.length ? UI.panel('Decided and resolved', UI.table(['Resource', 'Field', 'Outcome', 'When', 'Note'], decided.map((f) => ['<span class="mono">' + esc(f.key || f.providerId || '') + '</span>', esc(f.path || f.kind), UI.pill(f.state), esc(when(f.decidedAt || f.lastSeen)), esc(f.note || '')]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' })) : '');
  }

  function opsTab(st, x, d, ro) {
    const byPlan = {};
    x.ops.forEach((o) => { const k = o.planId || 'none'; (byPlan[k] = byPlan[k] || []).push(o); });
    const plans = x.plans.filter((p) => byPlan[p.id]).slice(0, 4);
    const tone = (s) => (s === 'succeeded' || s === 'adopted' ? 'ok' : s === 'failed' ? 'danger' : s === 'pending' || s === 'started' ? 'info' : '');
    const latest = (list) => { const m = {}; list.forEach((o) => { m[o.resourceKey + ':' + o.step] = o; }); return Object.keys(m).map((k) => m[k]); };
    const throttled = st.throttled || x.ops.some((o) => o.state !== 'succeeded' && o.error && /thrott|rate|429|TooManyRequests/i.test(o.error));
    const panels = plans.map((p) => UI.panel(p.purpose + ' plan of ' + when(p.createdAt) + ' · ' + p.state, UI.timeline(latest(byPlan[p.id]).map((o) => ({ title: esc(o.resourceKey) + ' <span class="muted">' + esc(o.step) + '</span>', text: esc(o.state) + (o.error ? ': ' + esc(short(o.error, 200)) : ''), meta: 'idempotency key ' + esc(short(o.idempotencyKey, 24)) + ' · attempt ' + o.attempt + (o.providerRequestId ? ' · request ' + esc(short(o.providerRequestId, 24)) : '') + ' · ' + esc(when(o.at)), tone: tone(o.state) })))));
    const other = byPlan.none ? UI.panel('Outside a plan (scaling, verify)', UI.timeline(byPlan.none.slice(-10).map((o) => ({ title: esc(o.resourceKey) + ' <span class="muted">' + esc(o.step) + '</span>', text: esc(o.state) + (o.error ? ': ' + esc(short(o.error, 200)) : ''), meta: esc(when(o.at)), tone: tone(o.state) })))) : '';
    return (throttled ? UI.notice('<b>The provider is throttling this account.</b> The step waits with backoff and jitter and carries on; the client token makes the retry safe, so nothing is created twice.', 'warn') : '')
      + (panels.join('') + other || UI.empty('No operations yet', 'The journal starts with the first apply.'));
  }

  function releasesTab(x, d, ro) {
    const k8s = specOf(d).compute && specOf(d).compute.shape === 'kubernetes';
    const me = App.me && App.me.user && App.me.user.id;
    const rel = x.releases.length ? UI.table(['Revision', 'Chart and image', 'State', 'When'], x.releases.map((r) => [esc(String(r.revision)), '<span class="mono" style="font-size:12px">chart ' + esc(r.chartVersion) + ', ' + esc(short(r.repository + '@' + r.digest, 70)) + '</span>', UI.pill(String(r.state)) + (r.error ? '<div class="muted" style="font-size:11px">' + esc(short(r.error, 120)) + '</div>' : ''), esc(when(r.createdAt))]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }) : '<div class="muted" style="font-size:12px">' + (k8s ? 'No release installed yet.' : 'Releases are Helm releases on a Kubernetes deployment; this deployment installs the signed release on its VMs or runs the image on its container platform.') + '</div>';
    const planOf = (u) => x.plans.find((p) => p.id === u.planId);
    const ups = x.upgrades.length ? UI.table(['Asked', 'Image', 'Steps', 'State', { label: '', srLabel: 'Actions' }], x.upgrades.map((u) => [esc(when(u.createdAt)), '<span class="mono" style="font-size:12px">' + esc(short(u.repository + '@' + u.toDigest, 70)) + '</span>', '<span style="font-size:12px">' + u.steps.map((y) => esc(y.id.replace('_', ' ')) + ' ' + esc(y.state)).join(', ') + '</span>', UI.pill(String(u.state)), u.state === 'planned' && planOf(u) ? UI.btn('Apply upgrade', { size: 'xs', kind: 'primary', attrs: 'data-up-apply="' + esc(u.id) + '" data-up-hash="' + esc(planOf(u).hash) + '"', disabled: ro }) : '']), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }) : '<div class="muted" style="font-size:12px">No upgrades yet.</div>';
    const snaps = x.snapshots.length ? UI.table(['Snapshot', 'Taken', 'Restore', { label: '', srLabel: 'Actions' }], x.snapshots.map((s) => {
      const r = s.restore || null;
      const asked = r && r.state === 'requested';
      return ['<span class="mono" style="font-size:12px">' + esc(s.name) + '</span> <span class="muted">' + esc(s.resourceKey || s.kind) + '</span>', esc(when(s.createdAt)) + ' ' + UI.pill(s.state), r ? UI.pill(String(r.state)) + (r.error ? '<div class="muted" style="font-size:11px">' + esc(short(r.error, 120)) + '</div>' : '') : '<span class="muted">none</span>',
        asked ? '<div class="hstack gap6">' + UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-sr-approve="' + esc(s.id) + '"', disabled: ro || r.requestedBy === me, title: r.requestedBy === me ? 'Another cloud admin approves what you asked' : '' }) + UI.btn('Reject', { size: 'xs', attrs: 'data-sr-reject="' + esc(s.id) + '"', disabled: ro }) + '</div>' : UI.btn('Ask to restore', { size: 'xs', attrs: 'data-sr-ask="' + esc(s.id) + '"', disabled: ro || !s.restorable, title: s.restorable ? '' : 'Not restorable now' })];
    }), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }) : '<div class="muted" style="font-size:12px">No pre-upgrade snapshots. An upgrade takes one before it migrates the database.</div>';
    return UI.panel('Release', rel + (k8s && x.releases.some((r) => /fail/.test(String(r.state || r.status))) ? '<div>' + UI.btn('Install again', { size: 'sm', attrs: 'data-install', disabled: ro }) + '</div>' : ''))
      + UI.panel('Upgrades', ups + '<div class="hstack gap6">' + UI.btn('Plan upgrade', { size: 'sm', attrs: 'data-upgrade', disabled: ro || !k8s, title: k8s ? '' : 'Upgrades by image digest are for Kubernetes deployments' }) + '</div>')
      + UI.panel('Pre-upgrade snapshots', snaps + '<span class="muted" style="font-size:12px">The app tier rolls back by itself when verification fails. The database rolls back only by restoring a snapshot, which a second cloud admin approves.</span>');
  }

  function frontTab(st, x, d, ro) {
    const cf = (st.accounts || []).filter((a) => a.provider === 'cloudflare' && a.state === 'active');
    const list = x.edges.length ? x.edges.map((e) => UI.panel(e.name + ' · ' + e.hostname, UI.kv([['Zone', esc(e.zone)], ['State', UI.pill(String(e.state || ''))], ['Origin', esc(e.origin ? (e.origin.kind === 'tunnel' ? 'Tunnel to ' + e.origin.service : e.origin.address + ':' + e.origin.port) : '—')], ['WAF', e.waf && e.waf.enabled ? 'on' : 'off'], ['Tunnel token', e.tokenRef ? '<span class="mono">' + esc(e.tokenRef) + '</span>' : '<span class="muted">not created</span>'], ['Applied', esc(when(e.appliedAt))]], 2), { actions: UI.btn('Apply', { size: 'sm', kind: 'primary', attrs: 'data-edge-apply="' + esc(e.id) + '"', disabled: ro }) + UI.btn('cloudflared for Helm', { size: 'sm', attrs: 'data-edge-install="' + esc(e.id) + '"' }) })).join('')
      : UI.empty('No Cloudflare front door', cf.length ? 'Put Cloudflare in front of this deployment: DNS and edge TLS, a Tunnel with no inbound ports, WAF and rate-limit rules.' : 'Connect a Cloudflare account on Cloud accounts first; its token needs Tunnel, DNS and WAF permissions.', cf.length ? UI.btn('Add front door', { kind: 'primary', attrs: 'data-edge-new', disabled: ro }) : UI.btn('Open Cloud accounts', { attrs: 'data-go="cloud"' }));
    return list + UI.notice('Cloudflare Access is an extra layer. Exprsn-AI sign-in stays authoritative, and /v1, the OIDC and SAML endpoints, /.well-known and public share links bypass Access so clients and federation keep working.', 'info');
  }

  function bindDetail(ctx, st, x, d, plan, liveDestroy) {
    const base = B + '/' + enc(d.id);
    const again = () => { st.det = null; ctx.rerender(); };
    const fail = (err, what) => {
      const p = err && err.problem;
      if (p && p.reason === 'budget_exceeded') { x.problem = p; st.tab = 'overview'; ctx.rerender(); ctx.toast('Refused: budget_exceeded. ' + esc(p.detail || ''), 'danger', 6000); return; }
      App.fail(err, what);
    };
    ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
    ctx.on('click', '[data-tabgo]', (e, t) => { st.tab = t.dataset.tabgo; ctx.rerender(); });
    ctx.on('click', '[data-back]', () => { st.detail = null; st.det = null; st.mode = null; st.throttled = false; st.forceExpired = false; st.reload(); });
    ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
    ctx.on('click', '[data-acct]', (e, t) => { e.preventDefault(); ctx.navigate('cloud', { id: t.dataset.acct }); });
    ctx.on('click', '[data-verify]', async () => {
      try { await App.post(base + '/verify'); ctx.toast('Verify queued (cloud.verify). The checks replace the last result when they answer.', 'ok'); setTimeout(again, 1500); } catch (err) { fail(err, 'Not queued'); }
    });
    const replan = async () => {
      const src = plan || x.plans.find((p) => p.purpose === 'apply') || x.plans[0];
      if (!src) return;
      try { const p = await App.post(base + '/plans', { desired: src.desired }); st.forceExpired = false; st.tab = 'plan'; again(); ctx.toast('Plan made again against the observed state: ' + esc(summaryText(p)), 'ok', 5000); } catch (err) { fail(err, 'Not planned'); }
    };
    ctx.on('click', '[data-replan]', replan);
    ctx.on('click', '[data-apply]', async () => {
      if (!plan) return;
      const ok = await ctx.confirm({ title: 'Apply ' + d.name, tag: 'apply', tone: 'info', body: '<p class="fg2" style="margin:0">Exprsn-AI makes the changes in the plan through the provider APIs, step by step, and verifies the result. Each step is idempotent and survives a restart.</p>', kv: [['Changes', esc(summaryText(plan))], ['Plan', '<span class="mono">' + esc(plan.hash.slice(0, 12)) + '…</span>']], ok: 'Apply' });
      if (!ok) return;
      try {
        const r = await withStepUp(ctx, () => App.post(base + '/plans/' + enc(plan.id) + '/apply', { hash: plan.hash }));
        if (r === CANCELLED) return;
        st.tab = 'operations'; again(); ctx.toast('Apply started for <b>' + esc(d.name) + '</b> (cloud.apply). Follow it in the operation journal.', 'ok', 5000);
      } catch (err) {
        if (err && err.problem && err.problem.reason === 'plan_stale') { st.forceExpired = true; ctx.rerender(); ctx.toast('The plan is stale: the observed state changed. Plan again, review, then apply.', 'warn', 6000); return; }
        fail(err, 'Not applied');
      }
    });
    ctx.on('click', '[data-rollback]', async () => {
      const ok = await ctx.confirm({ title: 'Roll back ' + d.name, tag: 'rollback', tone: 'warn', body: '<p class="fg2" style="margin:0">Every resource that is not protected returns to its state at the last passing verify; resources added since are deleted. Protected ones stay as they are.</p>', ok: 'Roll back' });
      if (!ok) return;
      try { const r = await withStepUp(ctx, () => App.post(base + '/rollback', {})); if (r === CANCELLED) return; st.tab = 'operations'; again(); ctx.toast('Rollback planned and applying (cloud.rollback).', 'ok'); } catch (err) { fail(err, 'Not rolled back'); }
    });
    ctx.on('click', '[data-drift-check]', async () => {
      try { await App.post(base + '/drift/check'); again(); ctx.toast('Drift checked: the provider was read now.', 'ok'); } catch (err) { fail(err, 'Not checked'); }
    });
    ctx.on('click', '[data-drift]', async (e, t) => {
      const kind = t.dataset.drift; const f = x.drift.find((y) => y.id === t.dataset.fid); if (!f) return;
      const text = { revert: 'A plan returns ' + (f.key || 'the resource') + ' to its desired state and applies at once.', adopt: 'The observed value becomes the desired state. It is recorded with your reason.', ignore: 'Drift checks stop reporting the ' + (f.path || f.kind) + ' field of ' + (f.key || 'this resource') + '. Other fields are still checked.' }[kind];
      const box = { v: '' };
      const grab = (ev) => { if (ev.target && ev.target.matches && ev.target.matches('[data-dnote]')) box.v = ev.target.value.trim(); };
      document.addEventListener('input', grab, true);
      const ok = await ctx.confirm({ title: { revert: 'Revert drift', adopt: 'Adopt drift', ignore: 'Ignore this field' }[kind], tag: kind, tone: kind === 'revert' ? 'info' : 'warn', body: '<p class="fg2" style="margin:0">' + esc(text) + '</p>' + UI.field('Reason', UI.input('', { placeholder: 'Recorded in the audit chain', attrs: 'data-dnote maxlength="500"' })), ok: { revert: 'Revert', adopt: 'Adopt', ignore: 'Ignore field' }[kind] });
      document.removeEventListener('input', grab, true);
      const note = box.v;
      if (!ok) return;
      try {
        const body = { decision: kind }; if (note) body.note = note; if (kind === 'revert') body.apply = true;
        const r = await withStepUp(ctx, () => App.post(base + '/drift/' + enc(f.id) + '/decide', body));
        if (r === CANCELLED) return;
        again(); ctx.toast({ revert: 'Revert planned and applying. Audit entry cloud.drift.decided written.', adopt: 'Observed value adopted into the desired state. Audit entry cloud.drift.decided written.', ignore: 'The field is ignored by drift checks. Audit entry cloud.drift.decided written.' }[kind], kind === 'revert' ? 'ok' : 'warn', 5000);
      } catch (err) { fail(err, 'Not decided'); }
    });
    ctx.on('click', '[data-destroy]', () => {
      const prot = (x.graph.resources || []).filter((r) => r.state !== 'deleted' && (r.protect || r.type === 'database'));
      ctx.modal({ title: 'Destroy ' + esc(d.name) + ' ' + UI.pill('destructive', 'danger'), body: '<p class="fg2" style="margin:0">Every resource tagged exprsn:deployment=' + esc(d.name) + ' is deleted in reverse dependency order. Users lose access at once.</p>'
        + (prot.length ? UI.notice('Protected data: ' + prot.map((r) => '<b class="mono">' + esc(r.key) + '</b>').join(', ') + '. A final snapshot is taken and kept 30 days; a second cloud admin must approve each before it is deleted.', 'warn') : '')
        + UI.field('Reason', UI.input('', { placeholder: 'Recorded in the audit chain', attrs: 'data-dreason maxlength="500"' }))
        + UI.field('Type the deployment name to confirm', UI.input('', { placeholder: d.name, attrs: 'data-typed autocomplete="off"' })),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(prot.length ? 'Propose destroy' : 'Destroy', { kind: 'danger', attrs: 'data-do', disabled: true }),
      onMount(m) {
        const inp = m.querySelector('[data-typed]'), btn = m.querySelector('[data-do]');
        inp.addEventListener('input', () => { btn.disabled = inp.value.trim() !== d.name; });
        btn.addEventListener('click', async () => {
          const reason = m.querySelector('[data-dreason]').value.trim();
          App.closeOverlay();
          try {
            const r = await withStepUp(ctx, () => App.post(base + '/destroy', reason ? { reason } : {}));
            if (r === CANCELLED) return;
            st.tab = 'overview'; again();
            ctx.toast(prot.length ? 'Destroy proposed. Final snapshots are taken first; another cloud admin approves each protected resource.' : 'Destroy started. Resources are deleted in reverse order.', 'warn', 6000);
          } catch (err) { fail(err, 'Not destroyed'); }
        });
      } });
    });
    if (liveDestroy) {
      const dbase = base + '/destroy/' + enc(liveDestroy.id);
      ctx.on('click', '[data-papprove]', async (e, t) => {
        const ok = await ctx.confirm({ title: 'Approve deleting ' + t.dataset.papprove, tag: 'dual control', tone: 'danger', body: '<p class="fg2" style="margin:0">Once its final snapshot is taken, ' + esc(t.dataset.papprove) + ' is deleted by the next destroy round. The snapshot is kept 30 days.</p>', ok: 'Approve' });
        if (!ok) return;
        try { const r = await withStepUp(ctx, () => App.post(dbase + '/protected/' + enc(t.dataset.papprove) + '/approve', {})); if (r === CANCELLED) return; again(); ctx.toast('Approved. Audit entry written; the destroy continues.', 'ok'); } catch (err) { fail(err, 'Not approved'); }
      });
      ctx.on('click', '[data-preject]', async (e, t) => {
        const ok = await ctx.confirm({ title: 'Refuse deleting ' + t.dataset.preject, tone: 'warn', body: '<p class="fg2" style="margin:0">The destroy ends; what was deleted stays deleted, and ' + esc(t.dataset.preject) + ' is kept.</p>', ok: 'Refuse' });
        if (!ok) return;
        try { await App.post(dbase + '/protected/' + enc(t.dataset.preject) + '/reject', {}); again(); ctx.toast('Refused. The destroy ended.', 'ok'); } catch (err) { fail(err, 'Not refused'); }
      });
      ctx.on('click', '[data-dcancel]', async () => {
        const ok = await ctx.confirm({ title: 'Cancel the destroy', tone: 'warn', body: '<p class="fg2" style="margin:0">Nothing more is deleted. What was already deleted stays deleted.</p>', ok: 'Cancel destroy' });
        if (!ok) return;
        try { await App.post(dbase + '/cancel', {}); again(); ctx.toast('Destroy cancelled.', 'ok'); } catch (err) { fail(err, 'Not cancelled'); }
      });
    }
    ctx.on('click', '[data-override]', () => overrideModal(ctx, d, (st.accounts || []).find((a) => a.id === d.accountId)));
    ctx.on('click', '[data-install]', async () => {
      try { await App.post(base + '/releases/install', {}); again(); ctx.toast('Release install queued.', 'ok'); } catch (err) { fail(err, 'Not queued'); }
    });
    ctx.on('click', '[data-upgrade]', () => ctx.modal({ title: 'Plan an upgrade of ' + esc(d.name), body: '<p class="fg2" style="margin:0">The upgrade plan takes a database snapshot first, runs migrate --check and migrate as a job, then rolls the app tier. Give the new image by digest.</p>'
      + UI.field('Image pinned by digest', UI.input('', { placeholder: 'ghcr.io/exprsnio/exprsn-ai@sha256:…', attrs: 'data-uimage' }), 'A tag alone can move under a deployment; the digest cannot'),
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Make the upgrade plan', { kind: 'primary', attrs: 'data-ugo' }),
    onMount(m) {
      m.querySelector('[data-ugo]').addEventListener('click', async () => {
        const image = m.querySelector('[data-uimage]').value.trim();
        try { const out = await App.post(base + '/upgrades', /^sha256:/.test(image) ? { imageDigest: image } : { image }); App.closeOverlay(); again(); ctx.toast('Upgrade planned: ' + esc(summaryText(out.plan)) + ' Apply it from Upgrades.', 'ok', 6000); } catch (err) { App.fail(err, 'Not planned'); }
      });
    } }));
    ctx.on('click', '[data-up-apply]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'Apply the upgrade', tag: 'upgrade', tone: 'info', body: '<p class="fg2" style="margin:0">A snapshot first, then the migration job and a rolling update. The app tier rolls back by itself if verification fails.</p>', ok: 'Apply upgrade' });
      if (!ok) return;
      try { const r = await withStepUp(ctx, () => App.post(base + '/upgrades/' + enc(t.dataset.upApply) + '/apply', { hash: t.dataset.upHash })); if (r === CANCELLED) return; again(); ctx.toast('Upgrade started.', 'ok'); } catch (err) { fail(err, 'Not applied'); }
    });
    ctx.on('click', '[data-sr-ask]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'Ask to restore this snapshot', tag: 'dual control', tone: 'danger', body: '<p class="fg2" style="margin:0">The database returns to the snapshot. Writes since then are lost. A second cloud admin approves before anything happens.</p>', ok: 'Ask' });
      if (!ok) return;
      try { const r = await withStepUp(ctx, () => App.post(base + '/snapshots/' + enc(t.dataset.srAsk) + '/restore', {})); if (r === CANCELLED) return; again(); ctx.toast('Restore asked. Waiting for a second cloud admin.', 'warn'); } catch (err) { fail(err, 'Not asked'); }
    });
    ctx.on('click', '[data-sr-approve]', async (e, t) => {
      try { const r = await withStepUp(ctx, () => App.post(base + '/snapshots/' + enc(t.dataset.srApprove) + '/restore/approve', {})); if (r === CANCELLED) return; again(); ctx.toast('Restore approved and started.', 'ok'); } catch (err) { fail(err, 'Not approved'); }
    });
    ctx.on('click', '[data-sr-reject]', async (e, t) => {
      try { await App.post(base + '/snapshots/' + enc(t.dataset.srReject) + '/restore/reject', {}); again(); ctx.toast('Restore refused.', 'ok'); } catch (err) { fail(err, 'Not refused'); }
    });
    ctx.on('click', '[data-edge-apply]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'Apply the front door', tone: 'info', body: '<p class="fg2" style="margin:0">DNS, edge TLS (Full strict), the tunnel and the WAF rules are set at Cloudflare.</p>', ok: 'Apply' });
      if (!ok) return;
      try { const r = await withStepUp(ctx, () => App.post('/api/admin/cloud/edge/' + enc(t.dataset.edgeApply) + '/apply', {})); if (r === CANCELLED) return; again(); ctx.toast('Front door applied.', 'ok'); } catch (err) { fail(err, 'Not applied'); }
    });
    ctx.on('click', '[data-edge-install]', async (e, t) => {
      try { const out = await App.get('/api/admin/cloud/edge/' + enc(t.dataset.edgeInstall) + '/install/helm'); ctx.drawer({ title: 'cloudflared beside the app', body: UI.code(typeof out === 'string' ? out : out.text || out.values || JSON.stringify(out, null, 2), 'yaml'), actions: UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }) }); } catch (err) { fail(err, 'Not loaded'); }
    });
    ctx.on('click', '[data-edge-new]', () => edgeModal(ctx, st, d, again));
  }

  function overrideModal(ctx, d, a) {
    if (!a) return;
    ctx.modal({ title: 'Request a budget override for ' + esc(a.name) + ' ' + UI.pill('dual control', 'danger'), body: '<p class="fg2" style="margin:0">An override lets plans that add cost apply for a limited time, at most 7 days. A second admin approves it on Cloud accounts.</p>'
      + UI.field('Reason', UI.textarea('', { placeholder: 'At least 10 characters, recorded in the audit chain', rows: 3, attrs: 'data-oreason maxlength="500"' }))
      + UI.field('Hours', UI.input('72', { type: 'number', attrs: 'data-ohours min="1" max="168" step="1"' })),
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send to a second admin', { kind: 'primary', attrs: 'data-osend' }),
    onMount(m) {
      m.querySelector('[data-osend]').addEventListener('click', async () => {
        const reason = m.querySelector('[data-oreason]').value.trim();
        const hours = Math.max(1, Math.min(168, Math.round(Number(m.querySelector('[data-ohours]').value) || 72)));
        try { await App.post('/api/admin/cloud/accounts/' + enc(a.id) + '/budget/overrides', { reason, hours }); App.closeOverlay(); ctx.toast('Override requested. Waiting for a second admin.', 'ok'); } catch (err) { App.fail(err, 'Not requested'); }
      });
    } });
  }

  function edgeModal(ctx, st, d, done) {
    const cf = (st.accounts || []).filter((a) => a.provider === 'cloudflare' && a.state === 'active');
    const host = (specOf(d).frontDoor || {}).hostname || '';
    ctx.modal({ title: 'Add a Cloudflare front door', body: '<div class="formgrid" style="--cols:1">'
      + UI.field('Name', UI.input(d.name + '-edge', { attrs: 'data-ename' }))
      + UI.field('Cloudflare account', UI.select(cf.map((a) => ({ value: a.id, label: a.name })), cf[0] ? cf[0].id : '', 'data-eacct'))
      + UI.field('Hostname', UI.input(host, { attrs: 'data-ehost' })) + UI.field('Zone', UI.input(host.split('.').slice(-2).join('.'), { attrs: 'data-ezone' }))
      + UI.field('Where the tunnel reaches the app', UI.input('http://127.0.0.1:8080', { attrs: 'data-eorigin' }), 'cloudflared runs beside the app; no inbound port is opened') + '</div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add front door', { kind: 'primary', attrs: 'data-ego' }),
    onMount(m) {
      m.querySelector('[data-ego]').addEventListener('click', async () => {
        const body = { name: m.querySelector('[data-ename]').value.trim(), accountId: m.querySelector('[data-eacct]').value, deploymentId: d.id, hostname: m.querySelector('[data-ehost]').value.trim(), zone: m.querySelector('[data-ezone]').value.trim(), origin: { kind: 'tunnel', service: m.querySelector('[data-eorigin]').value.trim() } };
        try { const r = await withStepUp(ctx, () => App.post('/api/admin/cloud/edge', body)); if (r === CANCELLED) return; App.closeOverlay(); done(); ctx.toast('Front door added. Apply it to set DNS, TLS, the tunnel and the WAF.', 'ok', 5000); } catch (err) { App.fail(err, 'Not added'); }
      });
    } });
  }

  // ---------------- new deployment wizard ----------------
  function specFrom(w) {
    if (w.onprem) {
      const spec = { kind: 'onprem', name: w.name, label: w.label, install: { kind: w.install }, compute: { shape: 'none' }, frontDoor: { kind: 'cloudflare', accountId: w.cfAccount, hostname: w.host.trim(), zone: w.zone.trim(), plan: w.cfPlan } };
      if (w.service.trim()) spec.install.service = w.service.trim();
      return spec;
    }
    const spec = { name: w.name, target: { provider: w.provider, accountId: w.accountId, region: w.region }, label: w.label, compute: { shape: w.shape, size: w.size } };
    if (w.data === 'existing') { spec.data = { mode: 'existing', databaseUrlRef: w.dbRef.trim() }; if (w.redisRef.trim()) spec.data.redisUrlRef = w.redisRef.trim(); }
    else if (w.data === 'onprem') spec.data = { mode: 'onprem', cidrs: w.cidrs.split(/[\s,]+/).filter(Boolean) };
    else spec.data = { mode: 'provision', engine: 'postgres', cache: w.cache };
    if (w.front === 'cloudflare') spec.frontDoor = { kind: 'cloudflare', accountId: w.cfAccount, hostname: w.host.trim(), zone: w.zone.trim(), plan: w.cfPlan };
    else if (w.front === 'acme') spec.frontDoor = { kind: 'acme', hostname: w.host.trim(), zone: w.zone.trim() };
    else spec.frontDoor = { kind: 'byo', hostname: w.host.trim() };
    const rel = {};
    if (w.shape === 'vm' && (w.tarUrl.trim() || w.tarSha.trim())) rel.tarball = { url: w.tarUrl.trim(), sha256: w.tarSha.trim().toLowerCase() };
    if (w.shape !== 'vm' && w.image.trim()) rel.image = w.image.trim();
    if (rel.tarball || rel.image) spec.release = rel;
    // VMs and container platforms keep the key-encryption key in OpenBao transit: DATA_KEY never leaves this install.
    if (w.shape !== 'kubernetes' && w.shape !== 'cloudflare' && w.keysAddr.trim()) spec.keys = { provider: 'openbao', addr: w.keysAddr.trim() };
    return spec;
  }

  function renderWizard(root, ctx, st, style) {
    const w = st.wiz;
    const STEPS = ['Target', 'Compute', 'Data', 'Front door', 'Review', 'Apply'];
    const accounts = (st.accounts || []).filter((a) => a.scope === 'platform' && a.state === 'active');
    const cfAccounts = accounts.filter((a) => a.provider === 'cloudflare');
    const cfTier = w.shape === 'cloudflare';
    const forProv = accounts.filter((a) => a.provider === w.provider);
    if (!forProv.some((a) => a.id === w.accountId)) { w.accountId = forProv[0] ? forProv[0].id : null; w.region = null; }
    const account = forProv.find((a) => a.id === w.accountId) || null;
    if (account && !(account.regions || []).some((r) => r.region === w.region)) w.region = account.defaultRegion || (account.regions[0] && account.regions[0].region);
    const region = account ? (account.regions || []).find((r) => r.region === w.region) : null;
    if (region && LABELS.indexOf(w.label) > LABELS.indexOf(region.ceiling)) w.label = region.ceiling;
    if (!w.cfAccount && cfAccounts[0]) w.cfAccount = cfAccounts[0].id;
    if (cfTier || w.onprem) w.front = 'cloudflare';
    if (w.onprem && (w.step === 2 || w.step === 3)) w.step = 4;
    const steps = '<div class="deployments-steps">' + STEPS.map((s, i) => '<span class="' + (i + 1 === w.step ? 'cur' : i + 1 < w.step ? 'done' : '') + (w.onprem && (i === 1 || i === 2) ? ' na' : '') + '"' + (i + 1 === w.step ? ' aria-current="step"' : '') + '><i>' + (i + 1) + '</i>' + s + '</span>' + (i < STEPS.length - 1 ? '<span class="sep" aria-hidden="true">›</span>' : '')).join('') + '</div>';
    let body = '';
    if (w.step === 1) {
      const tiles = [['aws', 'AWS', 'EKS, EC2 or ECS Fargate with RDS, ElastiCache and S3'], ['azure', 'Azure', 'AKS, VMs or Container Apps with Flexible Server, Azure Cache and Blob'], ['digitalocean', 'DigitalOcean', 'DOKS, Droplets or App Platform with managed databases']];
      body = '<div class="deployments-tiles" role="group" aria-label="Provider">' + tiles.map((p) => { const has = accounts.some((a) => a.provider === p[0]); const on = w.provider === p[0] && !cfTier && !w.onprem; return '<button type="button" class="deployments-tile' + (on ? ' on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" data-prov="' + p[0] + '"' + (has ? '' : ' disabled title="No active platform account for ' + p[1] + '"') + '><b>' + p[1] + '</b><span>' + esc(p[2]) + '</span>' + (has ? '' : '<span class="muted">No platform account connected</span>') + '</button>'; }).join('')
        + '<button type="button" class="deployments-tile' + (cfTier && !w.onprem ? ' on' : '') + '" aria-pressed="' + (cfTier && !w.onprem ? 'true' : 'false') + '" data-cftier' + (cfAccounts.length ? '' : ' disabled title="No Cloudflare account connected"') + '><b>Cloudflare</b><span>App tier on Cloudflare Containers; data and GPUs on another provider (hybrid)</span>' + (cfAccounts.length ? '' : '<span class="muted">No Cloudflare account connected</span>') + '</button>'
        + '<button type="button" class="deployments-tile' + (w.onprem ? ' on' : '') + '" aria-pressed="' + (w.onprem ? 'true' : 'false') + '" data-onprem' + (cfAccounts.length && App.can('cloud:admin') ? '' : ' disabled title="' + (cfAccounts.length ? 'Needs cloud:admin' : 'No Cloudflare account connected') + '"') + '><b>On-prem</b><span>Exprsn-AI already runs in your data centre: add a Cloudflare front door only</span>' + (cfAccounts.length ? '' : '<span class="muted">No Cloudflare account connected</span>') + '</button></div>'
        + (w.onprem ? '<div class="formgrid" style="--cols:3">' + UI.field('Deployment name', UI.input(w.name, { attrs: 'data-f="name" maxlength="31"' }), 'Lower case; also the front door\'s name') + UI.field('How it is installed', UI.select([{ value: 'compose', label: 'Docker Compose' }, { value: 'baremetal', label: 'Bare-metal installer (systemd)' }, { value: 'helm', label: 'Helm chart' }], w.install, 'data-f="install"')) + UI.field('Where the tunnel reaches the app', UI.input(w.service, { attrs: 'data-f="service"', placeholder: 'the install\'s default address' }), 'Optional; cloudflared runs beside the app') + '</div>' + UI.field('Highest label of the data it holds', UI.select(['public', 'internal', 'confidential'], w.label, 'data-f="label"'), 'A Cloudflare front door holds at most confidential data') : '<div class="formgrid" style="--cols:3">' + UI.field('Deployment name', UI.input(w.name, { attrs: 'data-f="name" maxlength="31"' }), 'Lower case; the exprsn:deployment tag')
        + UI.field(cfTier ? 'Account for data and GPUs' : 'Cloud account', UI.select(forProv.map((a) => ({ value: a.id, label: a.name })), w.accountId || '', 'data-f="account"'))
        + UI.field('Region', UI.select(account ? account.regions.map((r) => ({ value: r.region, label: r.region + ' (zone ' + r.zone + ')' })) : [], w.region || '', 'data-f="region"'), 'Label ceiling here: ' + UI.label(region ? region.ceiling : 'internal', { sm: true })) + '</div>'
        + UI.field('Highest label of the data it holds', UI.select(LABELS.filter((l) => !region || LABELS.indexOf(l) <= LABELS.indexOf(region.ceiling)), w.label, 'data-f="label"'), 'Checked against the region\'s and the zones\' ceilings'))
        + (cfTier ? UI.notice('A Cloudflare deployment is always hybrid. The app tier runs on Cloudflare Containers with the console\'s static assets on Workers; Postgres, Redis and GPUs run on ' + esc(PROV[w.provider]) + '.', 'info') : '');
    } else if (w.step === 2) {
      if (cfTier) body = '<div class="deployments-tiles"><button type="button" class="deployments-tile on" aria-pressed="true"><b>Cloudflare Containers</b><span>The Exprsn-AI image behind a Worker; static assets on Workers static assets.</span></button>'
        + ['Kubernetes', 'Virtual machines', 'GPU pool for Ollama'].map((t) => '<button type="button" class="deployments-tile" disabled title="' + esc(CF_REASON) + '"><b>' + esc(t) + '</b><span>' + esc(CF_REASON) + '</span></button>').join('') + '</div>';
      else body = '<div class="deployments-tiles" role="group" aria-label="Compute">' + [['kubernetes', 'Kubernetes', 'Helm chart on a new cluster; best for several replicas and GPU node groups'], ['vm', 'Virtual machines', 'The bare-metal installer from a signed release, under systemd'], ['container', 'Container platform', 'Managed containers; migrations run as a one-off task']].map((c) => '<button type="button" class="deployments-tile' + (w.shape === c[0] ? ' on' : '') + '" aria-pressed="' + (w.shape === c[0] ? 'true' : 'false') + '" data-shape="' + c[0] + '"><b>' + esc(c[1]) + '</b><span class="mono" style="font-size:11px">' + esc(COMPUTE[w.provider][c[0]]) + '</span><span>' + esc(c[2]) + '</span></button>').join('') + '</div>';
      body += UI.field('Size', UI.seg(SIZES, w.size, 'data-size aria-label="Size"'), 'Small: 1 replica. Medium: 2 replicas. Large-HA: 3 replicas across zones, HA database')
        + (w.shape === 'vm' ? '<div class="formgrid" style="--cols:2">' + UI.field('Release tarball (https)', UI.input(w.tarUrl, { attrs: 'data-f="tarUrl"', placeholder: 'https://releases.example.com/exprsn-ai-1.0.0.tar.gz' })) + UI.field('Its sha256', UI.input(w.tarSha, { attrs: 'data-f="tarSha" maxlength="64"', placeholder: '64 hexadecimal characters' }), 'The installer checks it before running anything') + '</div>'
          : '') + (w.shape === 'vm' || w.shape === 'container' ? UI.field('OpenBao address for the key-encryption key (https)', UI.input(w.keysAddr, { attrs: 'data-f="keysAddr"', placeholder: 'https://openbao.example.com:8200' }), 'Transit holds the key; DATA_KEY never reaches a cloud machine') : '')
        + (w.shape === 'vm' ? '' : UI.field('Image pinned by digest', UI.input(w.image, { attrs: 'data-f="image"', placeholder: 'registry/repository@sha256:…' }), w.shape === 'kubernetes' ? 'Optional: the chart\'s image when empty' : 'Required: a tag alone can move under a deployment'))
        + '<span class="muted" style="font-size:12px">GPU pools are added on <a href="#" data-go="cloud-compute">Cloud compute</a> once the deployment is healthy.</span>';
    } else if (w.step === 3) {
      body = (cfTier ? '<div class="deployments-tiles">' + ['PostgreSQL on Cloudflare', 'Redis on Cloudflare', 'GPUs on Cloudflare'].map((t) => '<button type="button" class="deployments-tile" disabled title="' + esc(CF_REASON) + '"><b>' + esc(t) + '</b><span>' + esc(CF_REASON) + '</span></button>').join('') + '</div>' : '')
        + UI.field('Database, cache and object store', UI.seg([{ id: 'provision', label: 'Provision new' }, { id: 'existing', label: 'Use existing' }, { id: 'onprem', label: 'On-prem' }], w.data, 'data-mode aria-label="Data tier"'))
        + (w.data === 'provision' ? UI.toggle('Managed Redis or Valkey (REDIS_URL)', w.cache, 'data-cache data-manual') + '<div class="fg2" style="font-size:12px">Managed PostgreSQL 17 with pgvector, deletion protection and backups, and an object store. Manage them on <a href="#" data-go="cloud-data">Cloud data</a>.</div>'
          : w.data === 'existing' ? '<div class="formgrid" style="--cols:2">' + UI.field('DATABASE_URL as a vault reference', UI.input(w.dbRef, { attrs: 'data-f="dbRef"', placeholder: 'vault:cloud/analytics#database_url' })) + UI.field('REDIS_URL as a vault reference (optional)', UI.input(w.redisRef, { attrs: 'data-f="redisRef"', placeholder: 'vault:cloud/analytics#redis_url' })) + '</div>'
            : UI.field('On-prem networks the app reaches', UI.input(w.cidrs, { attrs: 'data-f="cidrs"', placeholder: '10.31.0.0/24' }), 'IPv4 CIDRs, comma separated; the app zone\'s egress must allow them'));
    } else if (w.step === 4) {
      const fd = [['cloudflare', 'Cloudflare', 'DNS and edge TLS, Tunnel (cloudflared, no inbound ports), WAF and rate-limit rules'], ['acme', 'ACME and provider DNS', 'dns-01 with the existing ACME client'], ['byo', 'Bring your own', 'Your load balancer and certificates; Exprsn-AI only checks the URL']];
      body = (cfTier || w.onprem ? UI.notice((w.onprem ? 'An on-prem install is reached through a Cloudflare Tunnel: no inbound port is opened, and DNS, edge TLS and the WAF are set at Cloudflare. ' : '') + 'Cloudflare deployments use the Cloudflare front door: DNS, edge TLS, WAF and rate-limit rules are part of the deployment.', 'info') : '<div class="deployments-tiles" role="group" aria-label="Front door">' + fd.map((f) => { const dis = f[0] === 'cloudflare' && !cfAccounts.length; return '<button type="button" class="deployments-tile' + (w.front === f[0] ? ' on' : '') + '" aria-pressed="' + (w.front === f[0] ? 'true' : 'false') + '" data-front="' + f[0] + '"' + (dis ? ' disabled title="No Cloudflare account connected"' : '') + '><b>' + esc(f[1]) + '</b><span>' + esc(f[2]) + '</span></button>'; }).join('') + '</div>')
        + '<div class="formgrid" style="--cols:2">' + UI.field('Hostname', UI.input(w.host, { attrs: 'data-f="host"', placeholder: 'analytics.ai.example.com' })) + (w.front !== 'byo' ? UI.field('DNS zone', UI.input(w.zone, { attrs: 'data-f="zone"', placeholder: 'example.com' })) : '') + (w.front === 'cloudflare' ? UI.field('Cloudflare account', UI.select(cfAccounts.map((a) => ({ value: a.id, label: a.name })), w.cfAccount || '', 'data-f="cfAccount"')) + UI.field('Cloudflare plan', UI.select(['free', 'pro', 'business'], w.cfPlan, 'data-f="cfPlan"')) : '') + '</div>'
        + (w.front === 'cloudflare' ? UI.notice('Cloudflare sees decrypted traffic: a deployment behind its front door holds at most confidential data.', 'info') : '');
    } else if (w.step === 5) body = reviewBody(w, st);
    else body = applyBody(w);
    let foot = '';
    if (w.step < 5) foot = UI.btn('Back', { size: 'sm', attrs: 'data-back', disabled: w.step === 1 }) + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-cancel' }) + '<span class="grow"></span>' + UI.btn(w.step === 4 ? 'Review' : 'Next', { kind: 'primary', size: 'sm', attrs: 'data-next', disabled: w.step === 1 && !w.accountId && !w.onprem });
    else if (w.step === 5) {
      const p = w.plan;
      foot = UI.btn('Back', { size: 'sm', attrs: 'data-back', disabled: !!w.deployment }) + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-cancel' }) + '<span class="grow"></span>'
        + (w.problem && w.problem.reason === 'budget_exceeded' ? UI.btn('Request override', { size: 'sm', attrs: 'data-override-w' }) : '')
        + (!p ? UI.btn('Create plan', { kind: 'primary', size: 'sm', attrs: 'data-create', disabled: !w.dry || !w.dry.valid, title: w.dry && !w.dry.valid ? 'Fix the problems first' : '' })
          : UI.btn('Plan again', { size: 'sm', attrs: 'data-wreplan' }) + UI.btn('Apply', { kind: 'primary', size: 'sm', attrs: 'data-wapply', disabled: !p.applicable || p.state !== 'open' || p.expiresAt < Date.now(), title: !p.applicable ? 'The plan has blockers' : p.expiresAt < Date.now() ? 'Plan expired' : '' }));
    } else foot = '<span class="grow"></span>' + UI.btn('Refresh', { size: 'sm', attrs: 'data-wrefresh' }) + UI.btn('Open deployment', { kind: 'primary', size: 'sm', attrs: 'data-finish' });
    root.innerHTML = style + '<div class="page">' + UI.pagehead('New deployment', 'Step ' + w.step + ' of 6, ' + esc(STEPS[w.step - 1]) + ' · ' + esc(w.onprem ? 'On-prem with a Cloudflare front door' : cfTier ? 'Cloudflare and ' + PROV[w.provider] : PROV[w.provider]), w.step < 6 ? UI.btn('Cancel', { kind: 'ghost', attrs: 'data-cancel' }) : '')
      + steps + UI.panel('Step ' + w.step + ' of 6', body + '<div class="deployments-fb">' + foot + '</div>') + '</div>';
    if (w.step === 5 && !w.dry && !w.dryLoading) validate(ctx, st);
    if (w.step === 6 && !w.ops && !w.opsLoading) followApply(ctx, st);

    ctx.on('click', '[data-onprem]', (e, t) => { if (t.disabled) return; w.onprem = true; w.shape = 'kubernetes'; w.front = 'cloudflare'; if (LABELS.indexOf(w.label) > 2) w.label = 'confidential'; w.dry = null; ctx.rerender(); });
    ctx.on('change', '[data-f="install"]', (e, t) => { w.install = t.value; w.dry = null; });
    ctx.on('input', '[data-f="service"]', (e, t) => { w.service = t.value; w.dry = null; });
    ctx.on('click', '[data-prov]', (e, t) => { if (t.disabled) return; w.onprem = false; w.provider = t.dataset.prov; if (w.shape === 'cloudflare') w.shape = 'kubernetes'; w.accountId = null; w.dry = null; ctx.rerender(); });
    ctx.on('click', '[data-cftier]', (e, t) => { if (t.disabled) return; w.onprem = false; w.shape = 'cloudflare'; w.front = 'cloudflare'; if (!accounts.some((a) => a.provider === w.provider)) w.provider = (accounts.find((a) => a.provider !== 'cloudflare') || { provider: 'aws' }).provider; w.dry = null; ctx.rerender(); });
    ctx.on('change', '[data-f="account"]', (e, t) => { w.accountId = t.value; w.region = null; w.dry = null; ctx.rerender(); });
    ctx.on('change', '[data-f="region"]', (e, t) => { w.region = t.value; w.dry = null; ctx.rerender(); });
    ctx.on('change', '[data-f="label"]', (e, t) => { w.label = t.value; w.dry = null; });
    ['name', 'host', 'zone', 'image', 'tarUrl', 'tarSha', 'keysAddr', 'dbRef', 'redisRef', 'cidrs'].forEach((k) => ctx.on('input', '[data-f="' + k + '"]', (e, t) => { w[k] = k === 'name' ? t.value.trim().toLowerCase() : t.value; w.dry = null; }));
    ctx.on('change', '[data-f="cfAccount"]', (e, t) => { w.cfAccount = t.value; w.dry = null; });
    ctx.on('change', '[data-f="cfPlan"]', (e, t) => { w.cfPlan = t.value; w.dry = null; });
    ctx.on('click', '[data-shape]', (e, t) => { w.shape = t.dataset.shape; w.dry = null; ctx.rerender(); });
    ctx.on('click', '[data-size] [data-seg]', (e, t) => { w.size = t.dataset.seg; w.dry = null; ctx.rerender(); });
    ctx.on('click', '[data-mode] [data-seg]', (e, t) => { w.data = t.dataset.seg; w.dry = null; ctx.rerender(); });
    ctx.on('click', '[data-cache]', () => { w.cache = !w.cache; w.dry = null; ctx.rerender(); });
    ctx.on('click', '[data-front]', (e, t) => { if (t.disabled) return; w.front = t.dataset.front; w.dry = null; ctx.rerender(); });
    ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
    ctx.on('click', '[data-next]', () => { if (w.step === 4 && !w.host.trim()) { ctx.toast('Give the hostname the deployment answers on.', 'warn'); return; } w.step++; ctx.rerender(); });
    ctx.on('click', '[data-back]', () => { w.step--; if (w.onprem && (w.step === 2 || w.step === 3)) w.step = 1; w.dry = null; ctx.rerender(); });
    ctx.on('click', '[data-cancel]', () => { st.wiz = null; ctx.rerender(); });
    ctx.on('click', '[data-create]', async () => {
      try {
        const out = await withStepUp(ctx, () => App.post(B, specFrom(w)));
        if (out === CANCELLED) return;
        w.deployment = out.deployment; w.plan = out.plan; w.problem = null; ctx.rerender();
        ctx.toast('Deployment <b>' + esc(w.name) + '</b> created and planned: ' + esc(summaryText(out.plan)), 'ok', 5000);
      } catch (err) { w.problem = (err && err.problem) || { detail: detailOf(err) }; ctx.rerender(); if (!(err && err.problem && err.problem.reason === 'budget_exceeded')) App.fail(err, 'Not created'); }
    });
    ctx.on('click', '[data-wreplan]', async () => {
      try { w.plan = await App.post(B + '/' + enc(w.deployment.id) + '/plans', { desired: w.plan.desired }); w.problem = null; ctx.rerender(); ctx.toast('Plan made again: ' + esc(summaryText(w.plan)), 'ok'); } catch (err) { w.problem = err && err.problem; ctx.rerender(); App.fail(err, 'Not planned'); }
    });
    ctx.on('click', '[data-wapply]', async () => {
      const p = w.plan;
      const ok = await ctx.confirm({ title: 'Apply ' + w.name, tag: 'apply', tone: 'info', body: '<p class="fg2" style="margin:0">Exprsn-AI creates the resources in the plan through the provider APIs and verifies the result.</p>', kv: [['Account', esc((account || {}).name || '')], ['Region', esc(w.region || '')], ['Estimate', p.estimate ? money(p.estimate.monthly, p.estimate.currency) + ' a month' : 'none'], ['Plan', '<span class="mono">' + esc(p.hash.slice(0, 12)) + '…</span>']], ok: 'Apply' });
      if (!ok) return;
      try {
        const r = await withStepUp(ctx, () => App.post(B + '/' + enc(w.deployment.id) + '/plans/' + enc(p.id) + '/apply', { hash: p.hash }));
        if (r === CANCELLED) return;
        w.step = 6; w.ops = null; ctx.rerender(); ctx.toast('Apply started for <b>' + esc(w.name) + '</b>.', 'ok');
      } catch (err) {
        if (err && err.problem && err.problem.reason === 'plan_stale') { w.plan.expiresAt = 0; ctx.rerender(); ctx.toast('The plan is stale. Plan again, review, then apply.', 'warn', 6000); return; }
        w.problem = err && err.problem; ctx.rerender(); App.fail(err, 'Not applied');
      }
    });
    ctx.on('click', '[data-override-w]', () => overrideModal(ctx, w.deployment || {}, account));
    ctx.on('click', '[data-wrefresh]', () => { w.ops = null; ctx.rerender(); });
    ctx.on('click', '[data-finish]', () => { const id = w.deployment && w.deployment.id; st.wiz = null; st.sel = id; st.detail = id; st.tab = 'operations'; st.reload(); });
  }

  function validate(ctx, st) {
    const w = st.wiz;
    w.dryLoading = true;
    App.post(B + '/validate-spec', specFrom(w)).then((r) => { w.dry = r; }).catch((err) => { w.dry = { valid: false, problems: [{ path: '', check: 'request', message: detailOf(err) }], unavailable: [], resources: [], firewalls: [], notes: [], estimate: null }; })
      .finally(() => { w.dryLoading = false; if (App.state.route === 'deployments' && st.wiz === w && !overlayOpen()) ctx.rerender(); });
  }

  function reviewBody(w, st) {
    if (!w.dry) return '<div class="muted" style="font-size:12px" role="status">Checking the spec against the account, the regions, the zones and the prices. No provider is called.</div><div class="skeleton"></div>';
    const v = w.dry; const p = w.plan;
    const prob = w.problem ? (w.problem.reason === 'budget_exceeded' ? UI.problem('Plan refused: budget_exceeded', w.problem.detail || 'The account is past its budget.', w.problem.trace_id || false) : UI.notice(esc(w.problem.detail || 'Refused.'), 'danger')) : '';
    const problems = v.problems.length ? UI.notice('<b>' + v.problems.length + ' problem' + (v.problems.length === 1 ? '' : 's') + ' to fix before a plan:</b><ul style="margin:4px 0 0;padding-left:18px">' + v.problems.map((x) => '<li>' + (x.path ? '<span class="mono">' + esc(x.path) + '</span>: ' : '') + esc(x.message) + '</li>').join('') + '</ul>', 'danger') : '';
    const unav = (v.unavailable || []).length ? UI.notice('Not built for this provider yet: ' + v.unavailable.map((u) => '<span class="mono">' + esc(u.key) + '</span> (' + esc(u.reason) + ')').join('; ') + '.', 'warn') : '';
    const est = p ? p.estimate : v.estimate;
    const lines = est && est.lines ? est.lines : [];
    const costPanel = UI.panel('Cost estimate', est ? UI.table(['Item', { label: 'A month', right: true }], lines.map((l) => ['<span class="mono">' + esc(l.key) + '</span> <span class="muted">' + esc(l.sku) + '</span>', '<span class="num">' + money(l.monthly, est.currency) + '</span>']).concat([['<b>Total</b>', '<b class="num">' + money(est.monthly, est.currency) + '</b>']]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' }) + '<span class="muted" style="font-size:12px">' + esc(((est.assumptions || {}).notes || []).slice(0, 2).join(' ')) + '</span>' : '<div class="muted" style="font-size:12px">No estimate: the spec has problems or the prices are not cached.</div>');
    let planPanel;
    if (p) {
      const s = p.summary;
      planPanel = UI.panel('Plan', '<div class="stats">' + UI.stat(String(s.create), 'create') + UI.stat(String(s.update), 'update') + UI.stat(String(s.replace), 'replace') + UI.stat(String(s.delete), 'delete') + '</div>'
        + (p.blockers.length ? UI.notice('<b>It cannot be applied as it is.</b> ' + esc(p.blockers.join(' ')), 'danger') : '')
        + (p.expiresAt < Date.now() ? UI.notice('<b>This plan expired.</b> Make it again before applying.', 'warn') : '')
        + UI.table(['Change', 'Resource'], p.steps.filter((x) => x.action !== 'noop').map((x) => [kindPill(x.action), '<span class="mono">' + esc(x.key) + '</span> <span class="muted">' + esc(x.type) + '</span>' + (x.unavailable ? ' ' + UI.pill('not built yet', 'warn') : '') + (x.blocked ? ' ' + UI.pill('blocked', 'danger') : '')]), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'tabindex="0" role="region" aria-label="Table, may scroll sideways"' })
        + '<span class="muted" style="font-size:12px">Plan hash <span class="mono">' + esc(p.hash.slice(0, 12)) + '…</span>, valid until ' + esc(when(p.expiresAt)) + '.</span>');
    } else {
      const byType = {}; (v.resources || []).forEach((r) => { byType[r.type] = (byType[r.type] || 0) + 1; });
      planPanel = UI.panel('Resources the plan will hold', UI.table(['Kind', { label: 'Count', right: true }], Object.keys(byType).map((k) => [esc(k), '<span class="num">' + byType[k] + '</span>']), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'Nothing rendered', emptyText: 'Fix the problems above.' })
        + ((v.firewalls || []).length ? '<span class="muted" style="font-size:12px">Firewalls from the zones: ' + v.firewalls.map((f) => esc(f.zone)).join(', ') + '.</span>' : '')
        + ((v.notes || []).length ? '<div class="fg2" style="font-size:12px">' + v.notes.map(esc).join(' ') + '</div>' : ''));
    }
    return prob + problems + unav + '<div class="grid2">' + costPanel + planPanel + '</div>' + (v.valid && !p ? UI.notice('The spec is valid. Create plan makes the deployment and its first plan; nothing is created at the provider until you apply it.', 'ok') : '');
  }

  function followApply(ctx, st) {
    const w = st.wiz; w.opsLoading = true;
    Promise.all([App.get(B + '/' + enc(w.deployment.id)), App.get(B + '/' + enc(w.deployment.id) + '/operations?limit=400')]).then(([d, o]) => { w.deployment = d; w.ops = o.operations || []; }).catch(() => { w.ops = []; })
      .finally(() => {
        w.opsLoading = false;
        if (App.state.route !== 'deployments' || st.wiz !== w || overlayOpen()) return;
        ctx.rerender();
        if (w.deployment.state === 'applying') setTimeout(() => { if (st.wiz === w && w.step === 6 && App.state.route === 'deployments' && !overlayOpen()) { w.ops = null; ctx.rerender(); } }, 3000);
      });
  }

  function applyBody(w) {
    const p = w.plan; const ops = w.ops || [];
    const last = {}; ops.filter((o) => o.planId === p.id).forEach((o) => { last[o.resourceKey] = o; });
    const list = p.steps.filter((x) => x.action !== 'noop');
    return UI.panel('Applying ' + esc(w.name), '<div class="hstack gap6">' + statePill(w.deployment.state) + '</div>' + UI.timeline(list.map((s, i) => { const o = last[s.key]; const st = o ? o.state : 'waiting'; return { title: (i + 1) + '. ' + esc(s.action) + ' <span class="mono">' + esc(s.key) + '</span>', text: esc(st) + (o && o.error ? ': ' + esc(short(o.error, 200)) : ''), meta: o ? 'journal entry ' + esc(short(o.idempotencyKey, 24)) : '', tone: st === 'succeeded' || st === 'adopted' ? 'ok' : st === 'failed' ? 'danger' : o ? 'info' : '' }; })))
      + '<span class="muted" style="font-size:12px">The apply runs as the cloud.apply job; you can leave this page. Each step is idempotent and survives a restart.</span>';
  }
})();
