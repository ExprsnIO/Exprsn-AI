(function () {
  const { UI, esc } = App;

  // ---- nav entry (app.js untouched): Admin group, before Zones ----
  (function nav() {
    const admin = (App.NAV || []).find((g) => g.group === 'Admin'); if (!admin || admin.items.some((i) => i.id === 'cloud')) return;
    const item = { id: 'cloud', label: 'Cloud accounts', icon: 'map' };
    const z = admin.items.findIndex((i) => i.id === 'zones');
    if (z >= 0) admin.items.splice(z, 0, item); else admin.items.push(item);
  })();

  // ---- example data (Northwind, Monday 28 Sep 2026 09:40 UTC). Every ID here is fake. ----
  const PROVIDERS = ['AWS', 'Azure', 'DigitalOcean', 'Cloudflare'];
  const REGION_POLICY = {
    'eu-central-1': ['confidential', 'cloud-eu'], 'us-east-1': ['internal', 'cloud-us'], swedencentral: ['confidential', 'cloud-eu'], westeurope: ['confidential', 'cloud-eu'],
    ams3: ['internal', 'cloud-eu'], fra1: ['internal', 'cloud-eu'], nyc3: ['internal', 'cloud-us'], 'global edge': ['internal', 'edge'], 'R2 jurisdiction EU': ['internal', 'edge']
  };
  const REGIONS_BY_PROVIDER = {
    AWS: ['eu-central-1', 'us-east-1', 'eu-west-1', 'us-west-2'], Azure: ['swedencentral', 'westeurope', 'eastus2'],
    DigitalOcean: ['ams3', 'fra1', 'nyc3', 'sfo3', 'tor1'], Cloudflare: ['global edge', 'R2 jurisdiction EU']
  };
  const ACCOUNTS0 = () => [
    { id: 'aws-prod', provider: 'AWS', scope: 'platform', ext: 'account 111122223333', mode: 'federated', cred: { role: 'arn:aws:iam::111122223333:role/exprsn-ai-deploy', aud: 'sts.amazonaws.com', session: '1 h sessions, refreshed at 40 min', last: 'session issued 09:12' }, regions: ['eu-central-1', 'us-east-1'], budget: 18000, mtd: 9840, forecast: 10600, alert: '50 % alert sent 16 Sep', state: 'connected', validated: 'validated today 09:12' },
    { id: 'aws-sandbox', provider: 'AWS', scope: 'platform', ext: 'account 444455556666', mode: 'vaulted', cred: { key: 'AKIAEXAMPLESANDBOX01', ref: 'vault:cloud/aws-sandbox#access_key', rotation: 'automatic every 90 days', lastRotated: '12 Aug', next: '10 Nov' }, regions: ['us-east-1'], budget: 1500, mtd: 1410, forecast: 1690, alert: '80 % alert sent 24 Sep; forecast above budget', state: 'connected', validated: 'validated today 06:00' },
    { id: 'azure-eu', provider: 'Azure', scope: 'platform', ext: 'tenant aaaaaaaa-0000-4000-8000-00000000a001, subscription bbbbbbbb-0000-4000-8000-00000000b001', mode: 'federated', cred: { app: 'exprsn-ai-deploy', client: 'cccccccc-0000-4000-8000-00000000c001', aud: 'api://AzureADTokenExchange', session: 'Entra tokens for ARM, Cost Management and Cognitive Services, 1 h', last: 'token issued 09:20' }, regions: ['swedencentral', 'westeurope'], budget: 12000, mtd: 7050, forecast: 7600, alert: '50 % alert sent 18 Sep', state: 'connected', validated: 'validated today 09:20' },
    { id: 'do-team', provider: 'DigitalOcean', scope: 'platform', ext: 'team Northwind Example, dddddddd-0000-4000-8000-00000000d001', mode: 'vaulted', cred: { key: 'dop_v1_...EXAMPLE', ref: 'vault:cloud/do-team#token', rotation: 'manual, notice 14 days before due', lastRotated: '14 Jul', next: '12 Oct', scopes: 'droplet, kubernetes, database, app, vpc, firewall, domain, spaces, billing:read' }, regions: ['ams3', 'fra1', 'nyc3'], budget: 4000, mtd: 4120, forecast: 4420, alert: 'Hard stop since 26 Sep: plans that add cost are refused', state: 'budget exceeded', validated: 'validated today 06:00' },
    { id: 'cf-edge', provider: 'Cloudflare', scope: 'platform', ext: 'account 0123456789abcdef0123456789abcdef, zone northwind-example.com', mode: 'vaulted', cred: { key: 'scoped API token ...EXAMPLE', ref: 'vault:cloud/cf-edge#api_token', rotation: 'manual, notice 14 days before due', lastRotated: '2 Sep', next: '1 Dec' }, regions: ['global edge', 'R2 jurisdiction EU'], budget: 1200, mtd: 310, forecast: 340, alert: 'none', state: 'needs attention', validated: 'validated today 09:31', missing: ['Containers Edit'] },
    { id: 'azure-contoso', provider: 'Azure', scope: 'tenant Contoso', ext: 'tenant aaaaaaaa-0000-4000-8000-00000000a002, subscription bbbbbbbb-0000-4000-8000-00000000b002', mode: 'vaulted', cred: { key: 'client secret ...EXAMPLE', ref: 'vault:cloud/azure-contoso#client_secret', rotation: 'Graph addPassword when the app may own its secrets, otherwise a notice', lastRotated: '4 Apr', next: '4 Oct', expires: '4 Oct' }, regions: ['westeurope'], budget: 1000, mtd: 620, forecast: 680, alert: '50 % alert sent 21 Sep', state: 'secret expires 4 Oct', validated: 'validated today 06:00' }
  ];
  const CF_PERMS = [
    ['Account', 'Cloudflare Tunnel Edit', 'Front door: Tunnel'], ['Account', 'Workers Scripts Edit', 'App tier Worker'], ['Account', 'Containers Edit', 'App tier on Cloudflare Containers'],
    ['Account', 'Hyperdrive Edit', 'Postgres through Hyperdrive'], ['Account', 'Workers R2 Storage Edit', 'R2 object store'], ['Account', 'D1 Read', 'D1 read-only connection'],
    ['Account', 'Workers AI Read', 'Workers AI model backend'], ['Account', 'AI Gateway Edit', 'AI Gateway proxy'], ['Account', 'Access: Apps and Policies Edit', 'Access before the admin console'],
    ['Account', 'Account Analytics Read', 'GraphQL Analytics, neurons'], ['Account', 'Billing Read', 'Billing ingestion'],
    ['Zone', 'DNS Edit', 'DNS records, northwind-example.com'], ['Zone', 'Zone WAF Edit', 'WAF and rate-limit rules'], ['Zone', 'SSL and Certificates Edit', 'Edge TLS']
  ];
  const DO_SCOPES = ['droplet:create, read, update, delete', 'kubernetes:create, read, update, delete', 'database:create, read, update, delete', 'app:create, read, update, delete', 'vpc and firewall:create, read, update', 'domain:create, read, update', 'spaces:read, write', 'billing:read'];
  const featureChecks = (a) => {
    if (a.provider === 'Cloudflare') return [['Front door (DNS, TLS, Tunnel, WAF, Access)', 'ok'], ['App tier on Cloudflare Containers', 'missing: Containers Edit'], ['R2 and D1', 'ok'], ['Workers AI and AI Gateway', 'ok'], ['Billing and GraphQL Analytics', 'ok']];
    if (a.provider === 'DigitalOcean') return [['Inventory read', 'ok'], ['Deploy (Kubernetes, Droplets, App Platform)', 'ok'], ['Managed databases', 'ok'], ['GenAI serverless inference', 'ok'], ['Billing read', 'ok']];
    const base = [['Inventory read', 'ok'], ['Deploy tagged resources (exprsn:managed)', 'ok'], ['Managed data', 'ok'], ['GPU node groups', a.id === 'aws-sandbox' ? 'not granted (sandbox policy)' : 'ok'], ['Model backends', a.id === 'azure-contoso' ? 'not granted' : 'ok'], ['Billing read', 'ok']];
    return base;
  };
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const tone = (p) => p >= 100 ? 'danger' : p >= 80 ? 'warn' : '';
  const statePill = (s) => UI.pill(s, /connected/.test(s) ? 'ok' : /exceeded|denied|failed/.test(s) ? 'danger' : /attention|expires|pending|throttled/.test(s) ? 'warn' : '');
  const provPill = (p) => '<span class="pill outline">' + esc(p) + '</span>';

  const init = (st) => {
    if (st.accounts) return;
    st.accounts = ACCOUNTS0(); st.sel = 'aws-prod'; st.prov = 'all'; st.q = ''; st.wiz = null; st.view = null; st.pending = [];
  };

  App.register({
    id: 'cloud', title: 'Cloud accounts', section: 'admin', crumb: ['Admin', 'Cloud accounts'],
    summary: 'AWS, Azure, DigitalOcean and Cloudflare accounts, credentials, regions and label ceilings',
    commands: [
      { label: 'Connect a cloud account', sub: 'Cloud accounts', run(app) { const s = app.stateFor('cloud'); init(s); s.wiz = { step: 1, provider: 'AWS', mode: 'federated', regions: ['eu-central-1'], budget: '5000', name: 'aws-analytics' }; app.render(); } },
      { label: 'Validate every cloud account', sub: 'Cloud accounts', run(app) { app.toast('Validation queued for 6 accounts. Results replace the permission checks as they arrive.'); } }
    ],
    states: [
      { title: 'No accounts yet', tone: 'neutral', text: 'Nothing is connected. The page explains federated and vaulted credentials and offers Connect account.', apply(ctx) { init(ctx.state); ctx.state.view = 'empty'; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Loading', tone: 'neutral', text: 'Accounts and their last validation load; rows show skeletons.', apply(ctx) { init(ctx.state); ctx.state.view = 'loading'; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Provider API error', tone: 'danger', text: 'Azure Resource Manager answered 503 while validating azure-eu. The problem carries the trace id and the provider request id.', apply(ctx) { init(ctx.state); ctx.state.view = 'error'; ctx.state.sel = 'azure-eu'; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Rate limited', tone: 'warn', text: 'DigitalOcean answered 429; validation waits for ratelimit-reset and retries. Nothing is lost.', apply(ctx) { init(ctx.state); ctx.state.view = 'throttled'; ctx.state.sel = 'do-team'; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'Felix Brandt (member, Finance Ops) opens Cloud accounts without cloud:read. The page explains the decision step by step.', apply(ctx) { init(ctx.state); ctx.state.view = 'denied'; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Credential expiring', tone: 'warn', text: 'The azure-contoso client secret expires on 4 Oct. The row and the inspector say so and offer Rotate.', apply(ctx) { init(ctx.state); ctx.state.view = null; ctx.state.wiz = null; ctx.state.sel = 'azure-contoso'; ctx.rerender(); } },
      { title: 'Cloudflare token missing a permission', tone: 'warn', text: 'The cf-edge token lacks Containers Edit, so the nw-edge-cf plan waits. The checklist marks the missing permission.', apply(ctx) { init(ctx.state); ctx.state.view = null; ctx.state.wiz = null; ctx.state.sel = 'cf-edge'; ctx.rerender(); } },
      { title: 'Dual control pending', tone: 'info', text: 'A new account waits for a second cloud admin. It is listed as pending and cannot be used until Jonas Lindqvist approves.', apply(ctx) { init(ctx.state); const st = ctx.state; st.view = null; st.wiz = null; if (!st.accounts.some((a) => a.id === 'aws-analytics')) st.accounts.push({ id: 'aws-analytics', provider: 'AWS', scope: 'platform', ext: 'account 777788889999', mode: 'federated', cred: { role: 'arn:aws:iam::777788889999:role/exprsn-ai-deploy', aud: 'sts.amazonaws.com', session: '1 h sessions', last: 'not issued yet' }, regions: ['eu-central-1'], budget: 5000, mtd: 0, forecast: 0, alert: 'none', state: 'pending approval', validated: 'validated 09:38 by Mara Okafor' }); st.sel = 'aws-analytics'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; init(st);
      if (ctx.params.id) { if (st.accounts.some((a) => a.id === ctx.params.id)) { st.sel = ctx.params.id; st.wiz = null; st.view = null; } delete ctx.params.id; }
      const style = '<style>'
        + '.cloud-steps{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:12px}.cloud-steps span{display:inline-flex;align-items:center;gap:6px;padding:0 6px;height:26px;color:var(--muted);font-weight:500}.cloud-steps .cur{color:var(--fg);font-weight:700}.cloud-steps .done{color:var(--fg2)}.cloud-steps i{font-style:normal;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--line);font-size:11px}.cloud-steps .cur i{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.cloud-steps .done i{background:var(--fg2);color:var(--bg);border-color:var(--fg2)}.cloud-steps .sep{color:var(--faint)}'
        + '.cloud-tiles{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}.cloud-tile{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);text-align:left;cursor:pointer;font-size:12px;color:var(--fg2)}.cloud-tile b{font-size:13px;color:var(--fg)}.cloud-tile.on{border-color:var(--accent);background:var(--accent-tint)}.cloud-tile[disabled]{opacity:.6;cursor:not-allowed}'
        + '.cloud-t{flex-shrink:0}.cloud-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}.cloud-fb{display:flex;align-items:center;gap:8px;padding-top:10px;border-top:1px solid var(--line);flex-wrap:wrap}'
        + '</style>';
      const example = '<span class="muted" style="font-size:12px">Example data. IDs and prices are illustrative; no real accounts or keys.</span>';

      // ---------- permission denied ----------
      if (st.view === 'denied') {
        root.innerHTML = style + '<div class="page">' + UI.pagehead('Cloud accounts', 'Signed in as Felix Brandt, member, Finance Ops')
          + UI.problem('You need cloud:read', 'Cloud accounts are visible to cloud admins, cloud operators and FinOps analysts. Ask a cloud admin for one of those roles.', '0d7a51c2e98b4f63a1c05e7d3b9f2a48')
          + UI.panel('Why this was refused', UI.timeline([
            { title: 'Role', text: 'Member grants chat, knowledge and tools; it does not grant cloud:read.', tone: 'danger' },
            { title: 'Scopes', text: 'Console session, no narrower scope.', tone: 'ok' },
            { title: 'Tenant', text: 'Northwind; cloud accounts with platform scope belong to the platform.', tone: 'ok' },
            { title: 'Clearance', text: 'confidential, not reached.', tone: '' },
            { title: 'Decision', text: 'Refused at the role step (policy.explain).', tone: 'danger' }]))
          + '<div class="hstack gap6">' + UI.btn('Back to the board view', { size: 'sm', attrs: 'data-reset' }) + UI.btn('Open Roles and access', { size: 'sm', attrs: 'data-go="roles"' }) + '</div></div>';
        ctx.on('click', '[data-reset]', () => { st.view = null; ctx.rerender(); });
        ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
        return;
      }

      // ---------- connect wizard ----------
      if (st.wiz) { renderWizard(root, ctx, st, style, example); return; }

      const head = UI.pagehead('Cloud accounts', 'Credentials, regions and label ceilings for AWS, Azure, DigitalOcean and Cloudflare', UI.btn('Validate all', { icon: 'refresh', attrs: 'data-validate-all' }) + UI.btn('Connect account', { kind: 'primary', icon: 'plus', attrs: 'data-connect' }));

      if (st.view === 'empty') {
        root.innerHTML = style + '<div class="page">' + head
          + UI.empty('No cloud accounts connected', 'Connect an AWS, Azure, DigitalOcean or Cloudflare account to deploy Exprsn-AI there, add GPU pools, managed databases and cloud model backends. Federated credentials (AWS, Azure) leave no key to steal; vaulted tokens are sealed in the tenant vault and rotated.', UI.btn('Connect account', { kind: 'primary', attrs: 'data-connect' }))
          + '<div class="grid2">' + UI.panel('Federated (AWS, Azure)', '<div class="fg2" style="font-size:12px">The account trusts Exprsn-AI\'s OIDC issuer <span class="mono">https://id.northwind-example.com</span>. Each call uses a one-hour session; nothing long-lived is stored.</div>')
          + UI.panel('Vaulted (all four)', '<div class="fg2" style="font-size:12px">A key or scoped token sealed in the vault, never shown again, rotated on a schedule. DigitalOcean and Cloudflare offer no federation, so they use this.</div>') + '</div>' + example + '</div>';
        ctx.on('click', '[data-connect]', () => { st.wiz = { step: 1, provider: 'AWS', mode: 'federated', regions: ['eu-central-1'], budget: '5000', name: 'aws-analytics' }; ctx.rerender(); });
        ctx.on('click', '[data-validate-all]', () => ctx.toast('Nothing to validate yet.'));
        return;
      }

      const q = st.q.toLowerCase();
      const rows = st.accounts.filter((a) => (st.prov === 'all' || a.provider === st.prov) && (!q || (a.id + ' ' + a.ext + ' ' + a.scope).toLowerCase().includes(q)));
      if (!rows.some((a) => a.id === st.sel) && rows.length) st.sel = rows[0].id;
      const sel = st.accounts.find((a) => a.id === st.sel);
      const loading = st.view === 'loading';

      let banner = '';
      if (st.view === 'error') banner = '<div class="vstack gap6">' + UI.problem('Validation failed: Azure Resource Manager unavailable', 'GET /subscriptions/bbbbbbbb-0000-4000-8000-00000000b001 answered 503 (x-ms-request-id 5f0e9c2a-example). The account keeps its last good validation from 09:20; deployments on it are not affected.', '9b3e7d1f0a2c4e6b8d5f1a3c7e9b2d40') + '<div class="hstack gap6">' + UI.btn('Retry now', { size: 'sm', attrs: 'data-retry' }) + UI.btn('Dismiss', { size: 'sm', kind: 'ghost', attrs: 'data-dismiss' }) + '</div></div>';
      else if (st.view === 'throttled') banner = UI.notice('<b>DigitalOcean is rate limiting this account.</b> 429 with ratelimit-reset in 38 s; validation and inventory reads wait and retry with jitter (B-10108). No request is dropped.', 'warn', UI.btn('Dismiss', { size: 'xs', attrs: 'data-dismiss' }));
      const over = st.accounts.filter((a) => a.mtd >= a.budget);
      const budgetNote = over.length ? UI.notice('<b>Budget exceeded:</b> ' + over.map((a) => esc(a.id) + ' at ' + pct(a.mtd, a.budget) + ' %').join(', ') + '. Plans that add monthly cost on it are refused; scale-down and destroy still work.', 'danger', UI.btn('Open Cloud spend', { size: 'xs', attrs: 'data-go="finops"' })) : '';

      const table = loading
        ? '<div class="tablewrap"><table class="dt"><tbody>' + [1, 2, 3, 4, 5].map(() => '<tr><td><div class="skeleton" style="width:120px"></div></td><td><div class="skeleton" style="width:80px"></div></td><td><div class="skeleton" style="width:220px"></div></td><td><div class="skeleton" style="width:90px"></div></td><td><div class="skeleton" style="width:140px"></div></td></tr>').join('') + '</tbody></table></div>'
        : UI.table(['Account', 'Provider', 'Scope', 'External id', 'Credentials', 'Regions', { label: 'Budget this month', width: '170px' }, 'State'], rows.map((a) => {
          const p = pct(a.mtd, a.budget);
          return { cells: ['<span class="mono" style="font-weight:600">' + esc(a.id) + '</span>', provPill(a.provider), esc(a.scope), '<span class="mono" style="font-size:11px;display:inline-block;max-width:190px;overflow-wrap:anywhere">' + esc(a.ext) + '</span>', a.mode === 'federated' ? UI.pill('federated', 'info') : UI.pill('vaulted', 'outline'), esc(a.regions.join(', ')), UI.meter('', money(a.mtd) + ' of ' + money(a.budget), p, tone(p)), statePill(a.state)], attrs: 'data-id="' + esc(a.id) + '"', selected: a.id === st.sel };
        }), { minWidth: '1000px', emptyTitle: 'No accounts match', emptyText: 'Clear the filter or connect an account.' });

      let insp = '';
      if (loading) insp = '<div class="skeleton" style="width:60%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:70%"></div>';
      else if (sel) insp = inspector(sel, st);

      root.innerHTML = style + '<div class="page">' + head + banner + budgetNote
        + '<div class="toolbar">' + UI.search('Filter accounts', 'data-search', st.q) + UI.seg([{ id: 'all', label: 'All' }].concat(PROVIDERS.map((p) => ({ id: p, label: p }))), st.prov, 'data-prov') + '<span class="muted right" style="font-size:12px">' + rows.length + ' of ' + st.accounts.length + ' accounts</span></div>'
        + table
        + '<span class="muted" style="font-size:12px">Federation issuer <span class="mono">https://id.northwind-example.com</span> (discovery and JWKS published to a public bucket; signing keys stay in OpenBao transit, B-10005). Token subject <span class="mono">cloud-account:&lt;id&gt;</span>.</span>'
        + example + '</div>'
        + '<aside class="inspector w360">' + insp + '</aside>';

      ctx.on('click', 'tr.row', (e, t) => { if (t.dataset.id) { st.sel = t.dataset.id; ctx.rerender(); } });
      ctx.on('click', '[data-prov] [data-seg]', (e, t) => { st.prov = t.dataset.seg; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go, t.dataset.id ? { id: t.dataset.id } : undefined); });
      ctx.on('click', '[data-dismiss]', () => { st.view = null; ctx.rerender(); });
      ctx.on('click', '[data-retry]', () => { st.view = null; const a = st.accounts.find((x) => x.id === 'azure-eu'); a.validated = 'validated today 09:41'; ctx.rerender(); ctx.toast('azure-eu validated again: every check passed.', 'ok'); });
      ctx.on('click', '[data-connect]', () => { st.wiz = { step: 1, provider: 'AWS', mode: 'federated', regions: ['eu-central-1'], budget: '5000', name: 'aws-analytics' }; ctx.rerender(); });
      ctx.on('click', '[data-validate-all]', () => { st.accounts.forEach((a) => { if (a.state !== 'pending approval') a.validated = 'validated today 09:41'; }); ctx.rerender(); ctx.toast('Validated 6 accounts. cf-edge still lacks Containers Edit; azure-contoso secret expires 4 Oct.', 'warn', 5000); });
      if (!sel || loading) return;
      ctx.on('click', '[data-validate]', () => { sel.validated = 'validated today 09:41'; ctx.rerender(); ctx.toast('<b>' + esc(sel.id) + '</b> validated. ' + (sel.missing ? 'Still missing: ' + esc(sel.missing.join(', ')) + '.' : 'Every check passed.'), sel.missing ? 'warn' : 'ok'); });
      ctx.on('click', '[data-recheck-cf]', () => { sel.missing = null; sel.state = 'connected'; ctx.rerender(); ctx.toast('Token permissions re-read: Containers Edit is granted. The nw-edge-cf plan can apply.', 'ok', 5000); });
      ctx.on('click', '[data-rotate]', async () => {
        const auto = sel.provider === 'AWS' || sel.id === 'azure-contoso';
        const ok = await ctx.confirm({ title: 'Rotate credentials for ' + sel.id, tag: 'rotation', tone: 'warn', body: '<p class="fg2" style="margin:0">' + (auto ? 'Exprsn-AI creates the new credential through the provider API, validates it, stores it as a new vault version and then revokes the old one. Running operations finish on the old credential.' : 'This provider has no API to issue its own tokens. Paste the new token; Exprsn-AI validates it before it replaces the old vault version, then you revoke the old token at the provider.') + '</p>' + (auto ? '' : UI.field('New token', UI.input('', { type: 'password', placeholder: 'shown once, sealed in the vault' }))), kv: [['Vault path', '<span class="mono">' + esc(sel.cred.ref) + '</span>'], ['Last rotated', esc(sel.cred.lastRotated)]], ok: 'Rotate' });
        if (!ok) return;
        sel.cred.lastRotated = 'today 09:41'; sel.cred.next = sel.provider === 'AWS' ? '27 Dec' : '27 Dec'; if (sel.cred.expires) { sel.cred.expires = null; sel.state = 'connected'; }
        ctx.rerender(); ctx.toast('Credentials for <b>' + esc(sel.id) + '</b> rotated. New vault version written; the old one is revoked. Audit entry cloud.credential.rotated.', 'ok', 5000);
      });
      ctx.on('click', '[data-regions]', () => regionsModal(ctx, st, sel));
      ctx.on('click', '[data-trust]', () => ctx.drawer({ title: 'Trust for ' + esc(sel.id), body: setupSnippet(sel.provider, sel.id) + UI.notice('The trust only accepts tokens whose subject is <span class="mono">cloud-account:' + esc(sel.id) + '</span>. Deleting the trust or the role ends access at once.', 'info'), actions: UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }) }));
      ctx.on('click', '[data-disconnect]', async () => {
        const ok = await ctx.confirm({ title: 'Disconnect ' + sel.id, tag: 'dual control', tone: 'danger', body: '<p class="fg2" style="margin:0">Deployments, pools and connections on this account stop being managed; nothing in the cloud is deleted. A second cloud admin must approve before it takes effect.</p>' + UI.field('Reason', UI.input('', { placeholder: 'Recorded in the audit chain' })), kv: [['Deployments on it', sel.id === 'aws-prod' ? 'nw-prod-eu, nw-edge-cf' : sel.id === 'azure-eu' ? 'nw-dr-azure' : sel.id === 'do-team' ? 'lab-do' : sel.id === 'aws-sandbox' ? 'sandbox-ecs' : sel.id === 'cf-edge' ? 'nw-edge-cf' : 'none'], ['Second approver', 'Jonas Lindqvist or another cloud admin']], ok: 'Propose disconnect' });
        if (!ok) return;
        sel.state = 'disconnect pending approval'; ctx.rerender(); ctx.toast('Disconnect of <b>' + esc(sel.id) + '</b> proposed. Waiting for a second cloud admin.', 'warn', 5000);
      });
      ctx.on('click', '[data-approve-pending]', () => { sel.state = 'connected'; ctx.rerender(); ctx.toast('Jonas Lindqvist approved <b>' + esc(sel.id) + '</b>. The account is usable.', 'ok'); });
    }
  });

  function inspector(a, st) {
    const p = pct(a.mtd, a.budget);
    let cred = '';
    if (a.mode === 'federated' && a.provider === 'AWS') cred = UI.kv([['Mode', UI.pill('federated', 'info') + ' AssumeRoleWithWebIdentity'], ['Role', '<span class="mono">' + esc(a.cred.role) + '</span>'], ['Audience', '<span class="mono">' + esc(a.cred.aud) + '</span>'], ['Subject', '<span class="mono">cloud-account:' + esc(a.id) + '</span>'], ['Sessions', esc(a.cred.session) + ', ' + esc(a.cred.last)]], 1);
    else if (a.mode === 'federated') cred = UI.kv([['Mode', UI.pill('federated', 'info') + ' federated identity credential'], ['App registration', esc(a.cred.app) + ', client <span class="mono">' + esc(a.cred.client) + '</span>'], ['Audience', '<span class="mono">' + esc(a.cred.aud) + '</span>'], ['Subject', '<span class="mono">cloud-account:' + esc(a.id) + '</span>'], ['Tokens', esc(a.cred.session) + ', ' + esc(a.cred.last)]], 1);
    else cred = UI.kv([['Mode', UI.pill('vaulted', 'outline') + (a.provider === 'DigitalOcean' || a.provider === 'Cloudflare' ? ' <span class="muted">(no federation offered by ' + esc(a.provider) + ')</span>' : '')], ['Credential', '<span class="mono">' + esc(a.cred.key) + '</span>'], ['Vault reference', '<span class="mono">' + esc(a.cred.ref) + '</span>'], ['Rotation', esc(a.cred.rotation)], ['Last rotated, next due', esc(a.cred.lastRotated) + ', ' + (a.cred.expires ? '<span style="color:var(--warn-fg)">expires ' + esc(a.cred.expires) + '</span>' : esc(a.cred.next))]].concat(a.cred.scopes ? [['Token scopes', esc(a.cred.scopes)]] : []), 1);
    const regionRows = a.regions.map((r) => { const pol = REGION_POLICY[r] || ['internal', 'cloud']; return [esc(r) + (r === a.regions[0] ? ' <span class="muted">default</span>' : ''), UI.label(pol[0], { sm: true }), '<span class="mono">' + esc(pol[1]) + '</span>']; });
    const checks = a.provider === 'Cloudflare'
      ? UI.table(['Permission', 'Used for', 'Result'], CF_PERMS.map((c) => [esc(c[0] + ': ' + c[1]), esc(c[2]), (a.missing || []).includes(c[1]) ? UI.pill('missing', 'danger') : UI.pill('granted', 'ok')]), { clickable: false, minWidth: '0', cls: 'bare cloud-t' })
      : UI.table(['Feature', 'Result'], featureChecks(a).map((c) => [esc(c[0]), UI.pill(c[1], c[1] === 'ok' ? 'ok' : /missing/.test(c[1]) ? 'danger' : 'warn')]), { clickable: false, minWidth: '0', cls: 'bare cloud-t' });
    let notice = '';
    if (a.state === 'pending approval') notice = UI.notice('Waiting for a second cloud admin (Jonas Lindqvist was asked). The account cannot be used until approved.', 'info', UI.btn('Simulate approval', { size: 'xs', attrs: 'data-approve-pending' }));
    else if (a.cred.expires) notice = UI.notice('The client secret expires on <b>' + esc(a.cred.expires) + '</b>. Rotate now, or the account stops validating and its connections fail.', 'warn');
    else if (a.missing && a.missing.length) notice = UI.notice('The token lacks <b>' + esc(a.missing.join(', ')) + '</b>. The nw-edge-cf plan waits; add the permission at Cloudflare, then re-check.', 'warn', UI.btn('Re-check token', { size: 'xs', attrs: 'data-recheck-cf' }));
    else if (/disconnect/.test(a.state)) notice = UI.notice('Disconnect proposed. Waiting for a second cloud admin.', 'warn');
    return '<div class="hstack"><div class="eyebrow grow">Cloud account</div>' + statePill(a.state) + '</div><div class="cloud-name">' + esc(a.id) + '</div><div class="hstack wrap gap6">' + provPill(a.provider) + '<span class="muted" style="font-size:12px">' + esc(a.scope) + ' scope, ' + esc(a.validated) + '</span></div>'
      + '<div class="mono muted" style="font-size:11px;overflow-wrap:anywhere">' + esc(a.ext) + '</div>' + notice
      + '<div class="eyebrow">Credentials</div>' + cred
      + '<div class="eyebrow">Regions and label ceilings</div>' + UI.table(['Region', 'Ceiling', 'Zone'], regionRows, { clickable: false, minWidth: '0', cls: 'bare cloud-t' }) + '<span class="muted" style="font-size:12px">Restricted data never leaves on-prem unless a dual-controlled override says so (B-10008).</span>'
      + '<div class="eyebrow">' + (a.provider === 'Cloudflare' ? 'Token permission checklist' : 'Permission check') + '</div>' + checks
      + '<div class="eyebrow">Budget</div>' + UI.meter('September to date', money(a.mtd) + ' of ' + money(a.budget), p, tone(p)) + '<div class="muted" style="font-size:12px">Forecast ' + money(a.forecast) + '. ' + esc(a.alert) + '. <a href="#" data-go="finops">Cloud spend</a></div>'
      + '<div class="hstack wrap gap6">' + UI.btn('Validate now', { size: 'sm', kind: 'primary', icon: 'check', attrs: 'data-validate' }) + (a.mode === 'vaulted' ? UI.btn('Rotate credentials', { size: 'sm', icon: 'key', attrs: 'data-rotate' }) : UI.btn('View trust', { size: 'sm', icon: 'lock', attrs: 'data-trust' })) + UI.btn('Edit regions', { size: 'sm', attrs: 'data-regions' }) + UI.btn('Deployments', { size: 'sm', attrs: 'data-go="deployments"' }) + UI.btn('Disconnect', { size: 'sm', kind: 'danger', attrs: 'data-disconnect' }) + '</div>';
  }

  function regionsModal(ctx, st, a) {
    const all = REGIONS_BY_PROVIDER[a.provider];
    ctx.modal({ title: 'Regions for ' + esc(a.id), cls: 'wide', body: '<p class="fg2" style="margin:0">Exprsn-AI places nothing outside these regions. Each region maps to a zone and a label ceiling; data, pools and models above the ceiling are refused there.</p>'
      + UI.table(['Allowed', 'Region', 'Label ceiling', 'Zone'], all.map((r) => { const pol = REGION_POLICY[r] || ['internal', a.provider === 'AWS' || a.provider === 'Azure' ? 'cloud-us' : 'cloud']; return [UI.check('', a.regions.includes(r), 'data-r="' + esc(r) + '" aria-label="Allow ' + esc(r) + '"'), esc(r), UI.select(['public', 'internal', 'confidential', 'restricted'], pol[0], 'aria-label="Ceiling for ' + esc(r) + '" data-ceil="' + esc(r) + '"'), '<span class="mono">' + esc(pol[1]) + '</span>']; }), { clickable: false, minWidth: '0' })
      + UI.notice('Raising a ceiling, or any ceiling of restricted, needs a second cloud admin.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save regions', { kind: 'primary', attrs: 'data-save' }),
      onMount(m) {
        m.querySelector('[data-save]').addEventListener('click', () => {
          const picked = Array.prototype.slice.call(m.querySelectorAll('[data-r]')).filter((c) => c.checked).map((c) => c.dataset.r);
          const raised = Array.prototype.slice.call(m.querySelectorAll('[data-ceil]')).some((s) => { const pol = REGION_POLICY[s.dataset.ceil]; const order = ['public', 'internal', 'confidential', 'restricted']; return pol && order.indexOf(s.value) > order.indexOf(pol[0]); });
          App.closeOverlay(); if (picked.length) a.regions = picked; ctx.rerender();
          ctx.toast(raised ? 'Regions saved. The raised ceiling waits for a second cloud admin.' : 'Regions saved for <b>' + esc(a.id) + '</b>: ' + esc(a.regions.join(', ')) + '.', raised ? 'warn' : 'ok', 5000);
        });
      } });
  }

  function setupSnippet(provider, id) {
    if (provider === 'AWS') return UI.code(JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Federated: 'arn:aws:iam::111122223333:oidc-provider/id.northwind-example.com' }, Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: { 'id.northwind-example.com:aud': 'sts.amazonaws.com', 'id.northwind-example.com:sub': 'cloud-account:' + id } } }] }, null, 2), 'json');
    if (provider === 'Azure') return UI.code(['az ad app federated-credential create \\', '  --id cccccccc-0000-4000-8000-00000000c001 \\', '  --parameters \'{"name":"exprsn-ai-' + id + '",', '    "issuer":"https://id.northwind-example.com",', '    "subject":"cloud-account:' + id + '",', '    "audiences":["api://AzureADTokenExchange"]}\'', 'az role assignment create --assignee cccccccc-0000-4000-8000-00000000c001 \\', '  --role Contributor --scope /subscriptions/bbbbbbbb-0000-4000-8000-00000000b001/resourceGroups/exprsn-ai', 'az role assignment create --assignee cccccccc-0000-4000-8000-00000000c001 \\', '  --role "Cost Management Reader" --scope /subscriptions/bbbbbbbb-0000-4000-8000-00000000b001'].join('\n'), 'sh');
    if (provider === 'DigitalOcean') return '<div class="fg2" style="font-size:12px">Create a custom-scoped personal access token in the DigitalOcean control panel (API, Tokens) with these scopes, expiry 90 days:</div>' + UI.table(['Scope'], DO_SCOPES.map((s) => ['<span class="mono">' + esc(s) + '</span>']), { clickable: false, minWidth: '0', cls: 'bare cloud-t' });
    return '<div class="fg2" style="font-size:12px">Create an account API token at Cloudflare (My Profile, API Tokens, Custom token) with exactly these permissions:</div>' + UI.table(['Permission', 'Used for'], CF_PERMS.map((c) => [esc(c[0] + ': ' + c[1]), esc(c[2])]), { clickable: false, minWidth: '0', cls: 'bare cloud-t' });
  }

  function renderWizard(root, ctx, st, style, example) {
    const w = st.wiz;
    const STEPS = ['Provider', 'Credentials', 'Setup', 'Validate', 'Scope'];
    const noFed = w.provider === 'DigitalOcean' || w.provider === 'Cloudflare';
    if (noFed) w.mode = 'vaulted';
    const steps = '<div class="cloud-steps">' + STEPS.map((s, i) => '<span class="' + (i + 1 === w.step ? 'cur' : i + 1 < w.step ? 'done' : '') + '"><i>' + (i + 1) + '</i>' + s + '</span>' + (i < STEPS.length - 1 ? '<span class="sep">›</span>' : '')).join('') + '</div>';
    let body = '';
    if (w.step === 1) {
      const blurb = { AWS: 'SDK v3. Deployments, managed data, GPU node groups, Bedrock.', Azure: 'ARM SDKs. Deployments, managed data, GPU node pools, Azure AI Foundry.', DigitalOcean: 'REST API v2. Kubernetes, Droplets, App Platform, managed data, GPU Droplets, GenAI.', Cloudflare: 'Edge and app tier only: front door, Tunnel, Containers, R2, D1, Workers AI, AI Gateway.' };
      body = '<div class="cloud-tiles">' + PROVIDERS.map((p) => '<button type="button" class="cloud-tile' + (w.provider === p ? ' on' : '') + '" data-pick="' + p + '"><b>' + esc(p) + '</b><span>' + esc(blurb[p]) + '</span><span class="muted">' + (p === 'DigitalOcean' || p === 'Cloudflare' ? 'vaulted token only' : 'federated or vaulted') + '</span></button>').join('') + '</div>'
        + UI.field('Account name in Exprsn-AI', UI.input(w.name, { attrs: 'data-f="name"' }), 'Lower case, used in tags (exprsn:account) and audit entries')
        + UI.field('Scope', UI.select(['platform', 'tenant Northwind', 'tenant Contoso'], 'platform', 'data-f="scope"'), 'A tenant-scoped account is used only for that tenant\'s connections and model backends');
    } else if (w.step === 2) {
      body = '<div class="cloud-tiles">'
        + '<button type="button" class="cloud-tile' + (w.mode === 'federated' ? ' on' : '') + '" data-mode="federated"' + (noFed ? ' disabled title="Federation not offered by ' + esc(w.provider) + '"' : '') + '><b>Federated</b><span>' + (noFed ? 'Federation not offered by ' + esc(w.provider) + '.' : 'The account trusts https://id.northwind-example.com; each call uses a one-hour session. Nothing long-lived is stored.') + '</span></button>'
        + '<button type="button" class="cloud-tile' + (w.mode === 'vaulted' ? ' on' : '') + '" data-mode="vaulted"><b>Vaulted</b><span>' + (w.provider === 'AWS' ? 'An IAM access key, rotated automatically every 90 days.' : w.provider === 'Azure' ? 'A client secret or a certificate issued by the Exprsn-AI CA.' : w.provider === 'DigitalOcean' ? 'A custom-scoped personal access token, rotated by hand with notices.' : 'A scoped API token plus the account ID, rotated by hand with notices.') + '</span></button></div>'
        + (w.mode === 'vaulted' ? '<div class="formgrid" style="--cols:2">' + (w.provider === 'Cloudflare' ? UI.field('Account ID', UI.input('0123456789abcdef0123456789abcdef')) : '') + UI.field(w.provider === 'AWS' ? 'Access key ID and secret' : w.provider === 'Azure' ? 'Client secret' : 'API token', UI.input('', { type: 'password', placeholder: 'shown once, sealed in the vault' })) + UI.field('Vault path', UI.input('vault:cloud/' + w.name + '#' + (w.provider === 'AWS' ? 'access_key' : w.provider === 'Azure' ? 'client_secret' : 'api_token'), { readonly: true })) + '</div>' : UI.notice('You will paste the role ARN or the app registration on the next step, after creating the trust.', 'info'));
    } else if (w.step === 3) {
      body = (w.mode === 'federated' ? '<div class="fg2" style="font-size:12px">Create the trust in the ' + esc(w.provider) + ' account, then paste ' + (w.provider === 'AWS' ? 'the role ARN' : 'the app registration\'s client ID') + '.</div>' : '') + setupSnippet(w.provider, w.name)
        + (w.mode === 'federated' ? UI.field(w.provider === 'AWS' ? 'Role ARN' : 'Client ID', UI.input(w.provider === 'AWS' ? 'arn:aws:iam::777788889999:role/exprsn-ai-deploy' : 'cccccccc-0000-4000-8000-00000000c003')) : '')
        + UI.btn('Copy', { size: 'sm', icon: 'copy', attrs: 'data-copy-setup' });
    } else if (w.step === 4) {
      const rows = w.provider === 'Cloudflare' ? CF_PERMS.map((c) => [esc(c[0] + ': ' + c[1]), esc(c[2]), UI.pill('granted', 'ok')]) : featureChecks({ provider: w.provider, id: w.name }).map((c) => [esc(c[0]), '', UI.pill(c[1], c[1] === 'ok' ? 'ok' : 'warn')]);
      body = (w.validated ? UI.notice('Identity confirmed: ' + (w.provider === 'AWS' ? 'sts:GetCallerIdentity answered account 777788889999.' : w.provider === 'Azure' ? 'ARM returned the subscription.' : w.provider === 'DigitalOcean' ? '/v2/account answered team Northwind Example.' : '/user/tokens/verify answered active.') + ' Required actions simulated per feature.', 'ok') + UI.table([w.provider === 'Cloudflare' ? 'Permission' : 'Feature', w.provider === 'Cloudflare' ? 'Used for' : '', 'Result'], rows, { clickable: false, minWidth: '0' })
        : UI.empty('Not validated yet', 'Validation calls the provider with the new credential and simulates every action Exprsn-AI needs, per feature.', UI.btn('Validate', { kind: 'primary', attrs: 'data-run-validate' })));
    } else {
      const regs = REGIONS_BY_PROVIDER[w.provider];
      body = UI.table(['Allowed', 'Region', 'Label ceiling', 'Zone'], regs.map((r) => { const pol = REGION_POLICY[r] || ['internal', 'cloud']; return [UI.check('', w.regions.includes(r), 'data-wr="' + esc(r) + '" aria-label="Allow ' + esc(r) + '"'), esc(r), UI.label(pol[0], { sm: true }), '<span class="mono">' + esc(pol[1]) + '</span>']; }), { clickable: false, minWidth: '0' })
        + '<div class="formgrid" style="--cols:2">' + UI.field('Monthly budget (USD)', UI.input(w.budget, { attrs: 'data-f="budget"' }), 'Alerts at 50, 80 and 100 %; new resources stop at 100 %') + UI.field('Default region', UI.select(regs, w.regions[0] || regs[0])) + '</div>'
        + UI.notice('Adding an account needs a second cloud admin. Submitting sends a proposal to Jonas Lindqvist; the account stays unusable until approved.', 'info');
    }
    const back = w.step > 1 ? UI.btn('Back', { size: 'sm', attrs: 'data-back' }) : UI.btn('Back', { size: 'sm', disabled: true });
    const next = w.step < 5 ? UI.btn('Next', { kind: 'primary', size: 'sm', attrs: 'data-next', disabled: w.step === 4 && !w.validated }) : UI.btn('Submit for approval', { kind: 'primary', size: 'sm', attrs: 'data-submit' });
    root.innerHTML = style + '<div class="page">' + UI.pagehead('Connect a cloud account', 'Step ' + w.step + ' of 5, ' + esc(STEPS[w.step - 1]) + ' · ' + esc(w.provider), UI.btn('Cancel', { kind: 'ghost', attrs: 'data-cancel' }))
      + steps + UI.panel('Step ' + w.step + ' of 5', body + '<div class="cloud-fb">' + back + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-cancel' }) + '<span class="grow"></span>' + next + '</div>') + example + '</div>';
    ctx.on('click', '[data-pick]', (e, t) => { w.provider = t.dataset.pick; w.mode = w.provider === 'DigitalOcean' || w.provider === 'Cloudflare' ? 'vaulted' : 'federated'; w.regions = [REGIONS_BY_PROVIDER[w.provider][0]]; w.name = { AWS: 'aws-analytics', Azure: 'azure-analytics', DigitalOcean: 'do-analytics', Cloudflare: 'cf-analytics' }[w.provider]; w.validated = false; ctx.rerender(); });
    ctx.on('input', '[data-f="name"]', (e, t) => { w.name = t.value.trim() || w.name; });
    ctx.on('input', '[data-f="budget"]', (e, t) => { w.budget = t.value; });
    ctx.on('click', '[data-mode]', (e, t) => { if (t.disabled) return; w.mode = t.dataset.mode; ctx.rerender(); });
    ctx.on('change', '[data-wr]', (e, t) => { const r = t.dataset.wr; w.regions = t.checked ? w.regions.concat([r]) : w.regions.filter((x) => x !== r); });
    ctx.on('click', '[data-copy-setup]', () => ctx.toast('Setup copied to the clipboard.'));
    ctx.on('click', '[data-run-validate]', () => { w.validated = true; ctx.rerender(); ctx.toast('Validated: every required action is allowed.', 'ok'); });
    ctx.on('click', '[data-back]', () => { w.step--; ctx.rerender(); });
    ctx.on('click', '[data-next]', () => { w.step++; ctx.rerender(); });
    ctx.on('click', '[data-cancel]', () => { st.wiz = null; ctx.rerender(); });
    ctx.on('click', '[data-submit]', async () => {
      const ok = await ctx.confirm({ title: 'Propose account ' + w.name, tag: 'dual control', tone: 'info', body: '<p class="fg2" style="margin:0">A second cloud admin approves before Exprsn-AI uses this account.</p>', kv: [['Provider', esc(w.provider)], ['Credentials', esc(w.mode)], ['Regions', esc(w.regions.join(', ') || 'none')], ['Budget', '$' + esc(w.budget)]], ok: 'Send proposal' });
      if (!ok) return;
      const ext = { AWS: 'account 777788889999', Azure: 'tenant aaaaaaaa-0000-4000-8000-00000000a003, subscription bbbbbbbb-0000-4000-8000-00000000b003', DigitalOcean: 'team Northwind Analytics, dddddddd-0000-4000-8000-00000000d002', Cloudflare: 'account fedcba9876543210fedcba9876543210' }[w.provider];
      const cred = w.mode === 'federated' ? (w.provider === 'AWS' ? { role: 'arn:aws:iam::777788889999:role/exprsn-ai-deploy', aud: 'sts.amazonaws.com', session: '1 h sessions', last: 'not issued yet' } : { app: 'exprsn-ai-deploy', client: 'cccccccc-0000-4000-8000-00000000c003', aud: 'api://AzureADTokenExchange', session: '1 h tokens', last: 'not issued yet' }) : { key: 'sealed, shown once', ref: 'vault:cloud/' + w.name + '#token', rotation: w.provider === 'AWS' ? 'automatic every 90 days' : 'manual, notice 14 days before due', lastRotated: 'today', next: '27 Dec' };
      st.accounts.push({ id: w.name, provider: w.provider, scope: 'platform', ext, mode: w.mode, cred, regions: w.regions.length ? w.regions : [REGIONS_BY_PROVIDER[w.provider][0]], budget: +w.budget || 0, mtd: 0, forecast: 0, alert: 'none', state: 'pending approval', validated: 'validated today 09:40 by Mara Okafor' });
      st.sel = w.name; st.wiz = null; st.prov = 'all'; ctx.rerender();
      ctx.toast('Proposal sent to Jonas Lindqvist. <b>' + esc(w.name) + '</b> is listed as pending approval.', 'ok', 5000);
    });
  }
})();
