(function () {
  const { UI, esc } = App;

  /*
   * Cloud › Accounts (1.9.99-final, Sprint 56: B-10002, B-10007 to B-10009), from the `cloud` board of the
   * design prototype (removed 2026-10-21). Accounts, credentials as vault references, regions with their zones and label
   * ceilings, the permission check per feature, the token checklist, residency and the dual-controlled proposals.
   * The board's budget column and the rotation flow belong to later items (B-10602, B-10006) and are not shown here.
   * Sprint 59 (B-10603): the ingested costs this month per account (column and inspector), estimate against actual, fetch now.
   * Sprint 62 (B-10706): brought to the board: the credential's state with rotation (an automatic rotation of AWS keys
   * and Azure secrets, or a guided replace of a vaulted secret, both with a recent sign-in), the federation issuer's
   * status (check, publish, rotate the signing key), the setup helper's commands in View trust, and Discover data
   * services, which opens Cloud data's connect dialog for the account.
   */
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l);
  const PROVIDERS = [{ id: 'aws', label: 'AWS' }, { id: 'azure', label: 'Azure' }, { id: 'digitalocean', label: 'DigitalOcean' }, { id: 'cloudflare', label: 'Cloudflare' }];
  const provName = (p) => (PROVIDERS.find((x) => x.id === p) || { label: p }).label;
  const STATE_TEXT = { pending: 'pending approval', active: 'connected', attention: 'needs attention', disabled: 'disabled' };
  const statePill = (s) => UI.pill(STATE_TEXT[s] || s, s === 'active' ? 'ok' : s === 'attention' || s === 'pending' ? 'warn' : '');
  const provPill = (p) => '<span class="pill outline">' + esc(provName(p)) + '</span>';
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const detailOf = (e) => (e && e.problem && e.problem.detail) || (e && e.message) || 'Request failed';
  const overlayOpen = () => !!document.getElementById('overlay');
  const KIND_TEXT = { 'account.add': 'Add account', 'account.remove': 'Disconnect', 'account.credential': 'Credential mode', 'region.ceiling': 'Raise ceiling', residency: 'Residency' };
  const ID_FIELDS = { aws: [['awsAccountId', 'AWS account id', '12 digits']], azure: [['azureTenantId', 'Entra tenant id', 'GUID'], ['azureSubscriptionId', 'Subscription id', 'GUID']], digitalocean: [['doTeamId', 'Team id', 'UUID']], cloudflare: [['cloudflareAccountId', 'Account id', '32 hexadecimal characters']] };
  const PARAM_TEXT = { roleArn: 'Role ARN', clientId: 'Client id' };
  const REF_TEXT = { accessKeyId: 'Access key id', secretAccessKey: 'Secret access key', clientSecret: 'Client secret', certificate: 'Certificate', token: 'API token' };
  const extText = (a) => {
    const i = a.providerIds || {};
    if (a.provider === 'aws') return 'account ' + (i.awsAccountId || '');
    if (a.provider === 'azure') return 'tenant ' + (i.azureTenantId || '') + ', subscription ' + (i.azureSubscriptionId || '');
    if (a.provider === 'digitalocean') return 'team ' + (i.doTeamId || '');
    return 'account ' + (i.cloudflareAccountId || '') + ((i.cloudflareZoneIds || []).length ? ', ' + i.cloudflareZoneIds.length + ' zones' : '');
  };

  // ---------- step-up for approvals ----------
  const CANCELLED = {};
  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">Approving a cloud account change needs a fresh check of who you are.</div>'
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

  const newWizard = () => ({ step: 1, provider: 'aws', mode: 'federated', scope: 'tenant', name: 'aws-analytics', ids: {}, params: {}, refs: {}, regions: ['eu-central-1'], defaultRegion: 'eu-central-1', description: '' });

  App.register({
    id: 'cloud', title: 'Cloud accounts', section: 'admin', crumb: ['Admin', 'Cloud accounts'], live: true,
    summary: 'AWS, Azure, DigitalOcean and Cloudflare accounts, credentials, regions and label ceilings',
    commands: [
      { label: 'Connect a cloud account', sub: 'Cloud accounts', run(app) { const s = app.stateFor('cloud'); s.wiz = newWizard(); app.navigate('cloud'); } }
    ],
    states: [
      { title: 'No accounts yet', tone: 'neutral', text: 'Nothing is connected. The page explains federated and vaulted credentials and offers Connect account.', apply(ctx) { ctx.state.view = 'empty'; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Loading', tone: 'neutral', text: 'Accounts and their last validation load; rows show skeletons.', apply(ctx) { ctx.state.view = 'loading'; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Provider API error', tone: 'danger', text: 'The provider answered an error while validating. The problem carries the trace id and the provider request id.', apply(ctx) { ctx.state.view = null; ctx.state.banner = { kind: 'error', title: 'Validation failed: the provider answered 503', text: 'The account keeps its last good validation; deployments on it are not affected.', trace: '' }; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Rate limited', tone: 'warn', text: 'The provider answered 429; validation waits and retries. Nothing is lost.', apply(ctx) { ctx.state.view = null; ctx.state.banner = { kind: 'throttled', text: 'The provider is rate limiting this account; validation waits for the reset and retries with jitter. No request is dropped.' }; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Permission denied', tone: 'danger', text: 'Someone without cloud:read opens Cloud accounts. The page explains the decision step by step.', apply(ctx) { ctx.state.view = 'denied'; ctx.state.wiz = null; ctx.rerender(); } },
      { title: 'Token missing a permission', tone: 'warn', text: 'A validated account lacks a permission one feature needs; the checklist marks it and the feature is disabled with the reason.', apply(ctx) { const st = ctx.state; st.view = null; st.wiz = null; const a = st.data && st.data.accounts.find((x) => x.state === 'attention'); if (a) st.sel = a.id; ctx.rerender(); } },
      { title: 'Dual control pending', tone: 'info', text: 'A new account waits for a second cloud admin. It is listed as pending and cannot be used until approved.', apply(ctx) { const st = ctx.state; st.view = null; st.wiz = null; const a = st.data && st.data.accounts.find((x) => x.state === 'pending'); if (a) st.sel = a.id; ctx.rerender(); } },
      { title: 'Credential expiring', tone: 'warn', text: 'A vaulted secret expires soon. The inspector says so and offers Rotate credentials.', apply(ctx) { const st = ctx.state; st.view = null; st.wiz = null; st.forceExpiring = true; const a = st.data && st.data.accounts.find((x) => x.credentialMode === 'vaulted' && x.mayChange && x.state === 'active'); if (a) st.sel = a.id; ctx.rerender(); } },
      { title: 'Connect wizard', tone: 'neutral', text: 'The connect wizard on its first step.', apply(ctx) { ctx.state.view = null; ctx.state.wiz = newWizard(); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (st.prov === undefined) { st.prov = 'all'; st.q = ''; }
      const refresh = () => {
        if (App.state.route !== 'cloud') return;
        if (overlayOpen()) { st.dirty = true; return; }
        ctx.rerender();
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        // Sprint 58 (B-10602): budgets load beside the accounts; without migration 152 or finops:read the column stays empty.
        Promise.all([App.get('/api/admin/cloud/catalogue'), App.get('/api/admin/cloud/accounts'), App.get('/api/admin/cloud/proposals?state=pending'), App.get('/api/admin/cloud/budgets').catch(() => null), App.get('/api/admin/cloud/costs').catch(() => null)])
          .then(([cat, data, props, budgets, costs]) => { Object.assign(st, { cat, data, props, budgets: budgets ? budgets.budgets : null, costs: costs ? costs.accounts : null, loaded: true, loadError: null }); })
          .catch((err) => { st.loadError = err; st.loaded = true; })
          .finally(() => { st.loading = false; refresh(); });
      };
      const reload = () => { st.loaded = false; st.cred = {}; st.issuer = undefined; load(); };
      if (!st.loaded && !st.loading) load();
      if (ctx.params.id && st.seenHash !== location.hash) { st.seenHash = location.hash; st.sel = ctx.params.id; st.view = null; st.wiz = null; delete ctx.params.id; }
      // Sprint 62 (B-10706): the federation issuer and the selected account's credential state (cloud:admin only).
      if (App.can('cloud:admin') && st.loaded && st.issuer === undefined) {
        st.issuer = null;
        App.get('/api/admin/cloud/issuer').then((r) => { st.issuer = r; }).catch(() => { st.issuer = false; }).finally(refresh);
      }

      const style = '<style>'
        + '.cloud-steps{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:12px}.cloud-steps span{display:inline-flex;align-items:center;gap:6px;padding:0 6px;height:26px;color:var(--muted);font-weight:500}.cloud-steps .cur{color:var(--fg);font-weight:700}.cloud-steps .done{color:var(--fg2)}.cloud-steps i{font-style:normal;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--line);font-size:11px}.cloud-steps .cur i{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.cloud-steps .done i{background:var(--fg2);color:var(--bg);border-color:var(--fg2)}.cloud-steps .sep{color:var(--muted)}'
        + '.cloud-tiles{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}.cloud-tile{display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);text-align:left;cursor:pointer;font-size:12px;color:var(--fg2)}.cloud-tile b{font-size:13px;color:var(--fg)}.cloud-tile.on{border-color:var(--accent);background:var(--accent-tint)}.cloud-tile[disabled]{cursor:not-allowed}'
        + '.cloud-t{flex-shrink:0}.cloud-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}.cloud-fb{display:flex;align-items:center;gap:8px;padding-top:10px;border-top:1px solid var(--line);flex-wrap:wrap}.cloud-ext{font-size:11px;display:inline-block;max-width:190px;overflow-wrap:anywhere}'
        + '</style>';
      const head = (actions) => UI.pagehead('Cloud accounts', 'Credentials, regions and label ceilings for AWS, Azure, DigitalOcean and Cloudflare', actions);
      const isAdmin = App.can('cloud:admin');

      // ---------- permission denied ----------
      const denied = st.view === 'denied' || (st.loadError && st.loadError.status === 403);
      if (denied) {
        const p = (st.loadError && st.loadError.problem) || { detail: 'No role held grants cloud:read', step: 'role' };
        root.innerHTML = style + '<div class="page">' + head('')
          + UI.problem('You need cloud:read', 'Cloud accounts are visible to cloud admins, cloud operators and FinOps analysts. Ask an admin for one of those roles.', p.trace_id || false)
          + UI.panel('Why this was refused', UI.timeline([
            { title: 'Role', text: esc(p.step === 'role' ? p.detail : 'A role held grants cloud:read'), tone: p.step === 'role' ? 'danger' : 'ok' },
            { title: 'Second factor', text: esc(p.step === 'mfa' ? p.detail : 'Not reached'), tone: p.step === 'mfa' ? 'danger' : '' },
            { title: 'Decision', text: 'Refused at the ' + esc(p.step || 'role') + ' step (policy.explain).', tone: 'danger' }]))
          + '<div class="hstack gap6">' + (st.view === 'denied' ? UI.btn('Back to the accounts', { size: 'sm', attrs: 'data-reset' }) : '') + UI.btn('Open Roles and access', { size: 'sm', attrs: 'data-go="roles"' }) + '</div></div>';
        ctx.on('click', '[data-reset]', () => { st.view = null; ctx.rerender(); });
        ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
        return;
      }
      if (st.loadError) {
        const missing = st.loadError.problem && st.loadError.problem.reason === 'migration_pending';
        root.innerHTML = style + '<div class="page">' + head('') + (missing
          ? UI.empty('Cloud accounts are not installed', 'This server has not applied the database migration 146_cloud_accounts yet. Until it does, nothing can be connected and nothing is placed in a cloud.', UI.btn('Check again', { attrs: 'data-reload' }))
          : UI.problem('Cloud accounts could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>') + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; reload(); });
        return;
      }
      const loading = st.view === 'loading' || !st.loaded;
      if (st.wiz && st.loaded) { renderWizard(root, ctx, st, style, reload); return; }

      const headActions = isAdmin ? UI.btn('Validate all', { icon: 'refresh', attrs: 'data-validate-all' }) + UI.btn('Connect account', { kind: 'primary', icon: 'plus', attrs: 'data-connect' }) : '';
      const accounts = (st.data && st.data.accounts) || [];
      const startWizard = () => { st.wiz = newWizard(); if (st.data && st.data.platformAdmin) st.wiz.scope = 'platform'; ctx.rerender(); };

      if (!loading && (st.view === 'empty' || !accounts.length)) {
        root.innerHTML = style + '<div class="page">' + head(headActions)
          + UI.empty('No cloud accounts connected', 'Connect an AWS, Azure, DigitalOcean or Cloudflare account to use its managed databases and model backends, and later to deploy Exprsn-AI and add GPU pools. Federated credentials (AWS, Azure) leave no key to steal; vaulted keys and tokens stay in the vault and are named here only by their reference.', isAdmin ? UI.btn('Connect account', { kind: 'primary', attrs: 'data-connect' }) : '')
          + '<div class="grid2">' + UI.panel('Federated (AWS, Azure)', '<div class="fg2" style="font-size:12px">The account trusts Exprsn-AI\'s OIDC issuer. Each call uses a one-hour session; nothing long-lived is stored. The token subject is <span class="mono">cloud-account:&lt;id&gt;</span>.</div>')
          + UI.panel('Vaulted (all four)', '<div class="fg2" style="font-size:12px">A key or scoped token kept in the vault and named here by its <span class="mono">vault:</span> reference. DigitalOcean and Cloudflare offer no federation, so they use this.</div>') + '</div>' + residencyPanel(st) + '</div>';
        ctx.on('click', '[data-connect]', startWizard);
        ctx.on('click', '[data-validate-all]', () => ctx.toast('Nothing to validate yet.'));
        bindResidency(ctx, st, reload);
        return;
      }

      const q = (st.q || '').toLowerCase();
      const rows = accounts.filter((a) => (st.prov === 'all' || a.provider === st.prov) && (!q || (a.name + ' ' + extText(a) + ' ' + a.scope).toLowerCase().indexOf(q) >= 0));
      if (!rows.some((a) => a.id === st.sel) && rows.length) st.sel = rows[0].id;
      const sel = accounts.find((a) => a.id === st.sel);

      let banner = '';
      if (st.banner && st.banner.kind === 'error') banner = '<div class="vstack gap6">' + UI.problem(st.banner.title, st.banner.text, st.banner.trace || false) + '<div class="hstack gap6">' + UI.btn('Dismiss', { size: 'sm', kind: 'ghost', attrs: 'data-dismiss' }) + '</div></div>';
      else if (st.banner && st.banner.kind === 'throttled') banner = UI.notice('<b>Rate limited.</b> ' + esc(st.banner.text), 'warn', UI.btn('Dismiss', { size: 'xs', attrs: 'data-dismiss' }));
      const pendingMine = (st.props || []).filter((p) => !p.accountId || !accounts.some((a) => a.id === p.accountId));
      const otherProps = pendingMine.length ? UI.panel('Waiting for approval', UI.table(['Change', 'Summary', 'Proposed', { label: '', srLabel: 'Actions' }], pendingMine.map((p) => [esc(KIND_TEXT[p.kind] || p.kind), esc(p.summary), esc(when(p.proposedAt)), proposalActions(p)]), { clickable: false, minWidth: '0', cls: 'bare cloud-t' })) : '';

      const table = loading
        ? '<div class="tablewrap"><table class="dt"><caption class="sr">Loading accounts</caption><tbody>' + [1, 2, 3, 4].map(() => '<tr><td><div class="skeleton" style="width:120px"></div></td><td><div class="skeleton" style="width:80px"></div></td><td><div class="skeleton" style="width:220px"></div></td><td><div class="skeleton" style="width:140px"></div></td></tr>').join('') + '</tbody></table></div>'
        : UI.table(['Account', 'Provider', 'Scope', 'External id', 'Credentials', 'Regions', 'Budget', 'Cost this month', 'State'], rows.map((a) => ({
          cells: ['<span class="mono" style="font-weight:600">' + esc(a.name) + '</span>', provPill(a.provider), esc(a.scope === 'platform' ? 'platform' : 'tenant'), '<span class="mono cloud-ext">' + esc(extText(a)) + '</span>', a.credentialMode === 'federated' ? UI.pill('federated', 'info') : UI.pill('vaulted', 'outline'), esc(a.regions.map((r) => r.region).join(', ')), budgetCell(budgetOf(st, a.id)), costCell(costOf(st, a.id), st), statePill(a.state)],
          attrs: 'data-id="' + esc(a.id) + '" tabindex="0"', selected: a.id === st.sel
        })), { minWidth: '1080px', emptyTitle: 'No accounts match', emptyText: 'Clear the filter or connect an account.' });

      const insp = loading ? '<div class="skeleton" style="width:60%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div>' : sel ? inspector(sel, st) : '';
      root.innerHTML = style + '<div class="page">' + head(headActions) + banner
        + '<div class="toolbar">' + UI.search('Filter accounts', 'data-search', st.q) + UI.seg([{ id: 'all', label: 'All' }].concat(PROVIDERS), st.prov, 'data-prov aria-label="Provider"') + '<span class="muted right" style="font-size:12px">' + rows.length + ' of ' + accounts.length + ' accounts</span></div>'
        + table + otherProps + residencyPanel(st) + issuerPanel(st)
        + '<span class="muted" style="font-size:12px">Federated tokens carry the subject <span class="mono">cloud-account:&lt;id&gt;</span>; every resource Exprsn-AI creates is tagged <span class="mono">exprsn:managed=true</span> and <span class="mono">exprsn:account=&lt;name&gt;</span>.</span>'
        + '</div>' + '<aside class="inspector w360" aria-label="Account details">' + insp + '</aside>';

      const pick = (t) => { if (t.dataset.id) { st.sel = t.dataset.id; ctx.rerender(); } };
      ctx.on('click', 'tr.row', (e, t) => pick(t));
      ctx.on('keydown', 'tr.row', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(t); } });
      ctx.on('click', '[data-prov] [data-seg]', (e, t) => { st.prov = t.dataset.seg; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-dismiss]', () => { st.banner = null; ctx.rerender(); });
      ctx.on('click', '[data-connect]', startWizard);
      bindResidency(ctx, st, reload);
      bindProposals(ctx, st, reload);
      bindBudget(ctx, st, sel, reload);
      bindCosts(ctx, sel, reload);
      bindIssuer(ctx, st, reload);
      ctx.on('click', '[data-validate-all]', async () => {
        const list = accounts.filter((a) => a.mayChange && a.state !== 'disabled');
        let ok = 0; const issues = [];
        for (const a of list) {
          try { const out = await App.post('/api/admin/cloud/accounts/' + enc(a.id) + '/validate'); if (out.report.ok) ok++; else issues.push(a.name); } catch (err) { issues.push(a.name + ' (' + detailOf(err) + ')'); }
        }
        ctx.toast('Validated ' + ok + ' of ' + list.length + ' accounts.' + (issues.length ? ' Needs attention: ' + esc(issues.join(', ')) + '.' : ''), issues.length ? 'warn' : 'ok', 6000);
        reload();
      });
      if (!sel || loading) return;
      st.cred = st.cred || {};
      if (App.can('cloud:admin') && sel.mayChange && sel.state !== 'pending' && st.cred[sel.id] === undefined) {
        st.cred[sel.id] = null;
        App.get('/api/admin/cloud/accounts/' + enc(sel.id) + '/credential').then((r) => { st.cred[sel.id] = r; }).catch(() => { st.cred[sel.id] = false; }).finally(refresh);
      }
      bindRotation(ctx, st, sel, reload);
      ctx.on('click', '[data-discover]', () => ctx.navigate('cloud-data', { connect: sel.id }));
      ctx.on('click', '[data-validate]', async () => {
        try {
          const out = await App.post('/api/admin/cloud/accounts/' + enc(sel.id) + '/validate');
          const missing = out.report.features.filter((f) => f.missing.length).map((f) => f.name + ': ' + f.missing.join(', '));
          st.banner = null;
          ctx.toast('<b>' + esc(sel.name) + '</b> validated. ' + (!out.report.identity.ok ? esc(out.report.identity.error || 'The identity check failed.') : missing.length ? 'Missing ' + esc(missing.join('; ')) + '.' : 'Every check passed.'), out.report.ok ? 'ok' : 'warn', 6000);
          reload();
        } catch (err) {
          const p = err.problem || {};
          if (err.status === 429) st.banner = { kind: 'throttled', text: detailOf(err) + (p.retry_after ? ' Retry in ' + p.retry_after + ' s.' : '') };
          else st.banner = { kind: 'error', title: 'Validation failed', text: detailOf(err) + (p.provider_request_id ? ' (provider request ' + p.provider_request_id + ')' : ''), trace: p.trace_id };
          ctx.rerender();
        }
      });
      ctx.on('click', '[data-regions]', () => regionsModal(ctx, st, sel, reload));
      ctx.on('click', '[data-credential]', () => credentialModal(ctx, st, sel, reload));
      ctx.on('click', '[data-trust]', async () => {
        // Sprint 62 (B-10706): the setup helper's own output (GET .../setup); the static snippet when it cannot be read.
        const setup = await App.get('/api/admin/cloud/accounts/' + enc(sel.id) + '/setup').catch(() => null);
        ctx.drawer({ title: 'Trust for ' + esc(sel.name), body: (setup && setup.available ? setupHelper(setup) : setupSnippet(sel.provider, sel.name, sel, st)) + UI.notice('The trust accepts only tokens whose subject is <span class="mono">cloud-account:' + esc(sel.id) + '</span>. Deleting the trust or the role ends access at once.', 'info'), actions: UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }) });
      });
      ctx.on('click', '[data-toggle-state]', async () => {
        const to = sel.state === 'disabled' ? 'active' : 'disabled';
        const ok = await ctx.confirm({ title: (to === 'disabled' ? 'Disable ' : 'Enable ') + sel.name, tone: to === 'disabled' ? 'warn' : 'info', body: '<p class="fg2" style="margin:0">' + (to === 'disabled' ? 'Nothing new is placed on a disabled account and it is not validated. Nothing in the cloud changes.' : 'The account becomes usable again within its regions and ceilings.') + '</p>', ok: to === 'disabled' ? 'Disable' : 'Enable' });
        if (!ok) return;
        try { await App.patch('/api/admin/cloud/accounts/' + enc(sel.id), { state: to }); ctx.toast(esc(sel.name) + (to === 'disabled' ? ' disabled.' : ' enabled.') + ' Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not changed'); }
      });
      ctx.on('click', '[data-disconnect]', () => {
        ctx.modal({ title: 'Disconnect ' + esc(sel.name) + ' ' + UI.pill('dual control', 'danger'), body: '<p class="fg2" style="margin:0">Exprsn-AI stops managing what it built on this account; nothing in the cloud is deleted. A second cloud admin must approve before it takes effect.</p>' + UI.field('Reason', UI.input('', { placeholder: 'Recorded in the audit chain', attrs: 'data-reason maxlength="500"' })) + UI.kv([['Scope', esc(sel.scope)], ['Second approver', 'another cloud admin' + (sel.scope === 'platform' ? ' with platform:manage' : '')]], 2),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Propose disconnect', { kind: 'danger', attrs: 'data-ok' }),
          onMount(m) {
            m.querySelector('[data-ok]').addEventListener('click', async () => {
              const reason = m.querySelector('[data-reason]').value.trim();
              try { await App.del('/api/admin/cloud/accounts/' + enc(sel.id) + (reason ? '?reason=' + enc(reason) : '')); App.closeOverlay(); ctx.toast('Disconnect of <b>' + esc(sel.name) + '</b> proposed. Waiting for a second cloud admin.', 'warn', 5000); reload(); } catch (err) { App.fail(err, 'Not proposed'); }
            });
          } });
      });
    }
  });

  function proposalActions(p) {
    if (!App.can('cloud:admin')) return '';
    return '<div class="hstack gap6">' + (p.mine ? UI.btn('Withdraw', { size: 'xs', attrs: 'data-pwithdraw="' + esc(p.id) + '"' }) : UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-papprove="' + esc(p.id) + '"' }) + UI.btn('Reject', { size: 'xs', attrs: 'data-preject="' + esc(p.id) + '"' })) + '</div>';
  }

  function bindProposals(ctx, st, reload) {
    ctx.on('click', '[data-papprove]', async (e, t) => {
      const id = t.dataset.papprove; const p = (st.props || []).find((x) => x.id === id);
      const ok = await ctx.confirm({ title: 'Approve: ' + (KIND_TEXT[p ? p.kind : ''] || 'change'), tag: 'dual control', tone: 'info', body: '<p class="fg2" style="margin:0">' + esc(p ? p.summary : '') + '</p>', ok: 'Approve' });
      if (!ok) return;
      try { const r = await withStepUp(ctx, () => App.post('/api/admin/cloud/proposals/' + enc(id) + '/approve', {})); if (r === CANCELLED) return; ctx.toast('Approved and applied. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not approved'); }
    });
    ctx.on('click', '[data-preject]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'Reject this change', tone: 'warn', body: '<p class="fg2" style="margin:0">The change is not applied. A rejected new account is removed.</p>', ok: 'Reject' });
      if (!ok) return;
      try { await App.post('/api/admin/cloud/proposals/' + enc(t.dataset.preject) + '/reject', {}); ctx.toast('Rejected. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not rejected'); }
    });
    ctx.on('click', '[data-pwithdraw]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'Withdraw your proposal', tone: 'warn', body: '<p class="fg2" style="margin:0">The change is dropped. A withdrawn new account is removed.</p>', ok: 'Withdraw' });
      if (!ok) return;
      try { await App.post('/api/admin/cloud/proposals/' + enc(t.dataset.pwithdraw) + '/withdraw', {}); ctx.toast('Withdrawn.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not withdrawn'); }
    });
  }

  function residencyPanel(st) {
    const geos = (st.data && st.data.residency) || [];
    return UI.panel('Residency for confidential data', '<div class="fg2" style="font-size:12px">Public and internal data may be placed in any region on an account\'s list. Confidential data only in regions of this tenant\'s residency; restricted data never in a cloud unless a platform admin approves a restricted ceiling.</div>'
      + '<div class="hstack wrap gap6">' + (geos.length ? geos.map((g) => UI.pill(g.toUpperCase(), 'info')).join('') : '<span class="muted" style="font-size:12px">No residency set: confidential data goes to no cloud region.</span>') + '</div>', { actions: App.can('cloud:admin') ? UI.btn('Set residency', { size: 'sm', attrs: 'data-residency' }) : '' });
  }

  function bindResidency(ctx, st, reload) {
    ctx.on('click', '[data-residency]', () => {
      const geos = (st.data && st.data.residency) || [];
      const opts = (st.cat && st.cat.residencyGeos) || ['eu', 'us', 'ca'];
      ctx.modal({ title: 'Residency for confidential data', body: '<p class="fg2" style="margin:0">Pick where this tenant\'s confidential data may be placed. Removing a geography applies at once; adding one waits for a second cloud admin.</p>'
        + '<div class="vstack gap6">' + opts.map((g) => UI.check({ eu: 'European Union regions', us: 'United States regions', ca: 'Canadian regions' }[g] || g, geos.indexOf(g) >= 0, 'data-geo="' + esc(g) + '"')).join('') + '</div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-save' }),
        onMount(m) {
          m.querySelector('[data-save]').addEventListener('click', async () => {
            const picked = Array.prototype.slice.call(m.querySelectorAll('[data-geo]')).filter((c) => c.checked).map((c) => c.dataset.geo);
            try { const out = await App.put('/api/admin/cloud/residency', { geos: picked }); App.closeOverlay(); ctx.toast(out.proposal ? 'Residency change proposed. Waiting for a second cloud admin.' : 'Residency saved. Audit entry written.', out.proposal ? 'warn' : 'ok', 5000); reload(); } catch (err) { App.fail(err, 'Not saved'); }
          });
        } });
    });
  }

  function inspector(a, st) {
    const cat = st.cat && st.cat.providers.find((p) => p.id === a.provider);
    const cred = a.credential || { mode: a.credentialMode, params: {}, refs: [] };
    const refs = Array.isArray(cred.refs) ? cred.refs.map((k) => [REF_TEXT[k] || k, '<span class="muted">held in the vault</span>']) : Object.keys(cred.refs).map((k) => [REF_TEXT[k] || k, '<span class="mono" style="overflow-wrap:anywhere">' + esc(cred.refs[k]) + '</span>']);
    const params = Object.keys(cred.params || {}).map((k) => [PARAM_TEXT[k] || k, '<span class="mono" style="overflow-wrap:anywhere">' + esc(cred.params[k]) + '</span>']);
    const modeLine = cred.mode === 'federated'
      ? UI.pill('federated', 'info') + (a.provider === 'aws' ? ' AssumeRoleWithWebIdentity' : ' federated identity credential')
      : UI.pill('vaulted', 'outline') + (a.federation ? ' <span class="muted">(no federation: ' + esc(a.federation) + ')</span>' : '');
    const credKv = UI.kv([['Mode', modeLine]].concat(params, refs, cred.mode === 'federated' ? [['Subject', '<span class="mono">cloud-account:' + esc(a.id) + '</span>']] : []), 1);
    const regionRows = a.regions.map((r) => [esc(r.region) + (r.isDefault ? ' <span class="muted">default</span>' : ''), UI.label(r.ceiling, { sm: true }), '<span class="mono">' + esc(r.zone) + '</span>', esc(r.geo)]);
    const v = a.validation;
    let checks;
    if (a.provider === 'cloudflare' || a.provider === 'digitalocean') {
      const items = [];
      (cat ? cat.features : []).forEach((f) => (f.checklist || []).forEach((c) => {
        const fr = v && v.features.find((x) => x.feature === f.id);
        const res = !v ? UI.pill('not checked', '') : fr && fr.missing.indexOf(c.permission) >= 0 ? UI.pill('missing', 'danger') : fr && fr.status === 'error' ? UI.pill('not checked', 'warn') : UI.pill('granted', 'ok');
        items.push([esc((c.level ? (c.level === 'zone' ? 'Zone: ' : 'Account: ') : '') + c.permission), esc(c.usedFor), res]);
      }));
      checks = UI.table(['Permission', 'Used for', 'Result'], items, { clickable: false, minWidth: '0', cls: 'bare cloud-t' });
    } else {
      checks = v ? UI.table(['Feature', 'Result'], v.features.map((f) => [esc(f.name), UI.pill(f.status === 'ok' ? 'ok' : f.status === 'missing' ? 'missing: ' + f.missing.join(', ') : f.status, f.status === 'ok' ? 'ok' : f.status === 'missing' ? 'danger' : 'warn')]), { clickable: false, minWidth: '0', cls: 'bare cloud-t' }) : '<div class="muted" style="font-size:12px">Not validated yet.</div>';
    }
    const disabledFeatures = v ? v.features.filter((f) => f.status === 'missing') : [];
    let notice = '';
    if (a.state === 'pending') notice = UI.notice('Waiting for a second cloud admin' + (a.scope === 'platform' ? ' with platform:manage' : '') + '. The account cannot be used until approved.', 'info');
    else if (v && !v.identity.ok) notice = UI.notice('The identity check failed: ' + esc(v.identity.error || 'no detail') + '.', 'danger');
    else if (disabledFeatures.length) notice = UI.notice(disabledFeatures.map((f) => esc(f.reason || f.name)).join(' '), 'warn');
    const pend = (a.pending || []).length ? '<div class="eyebrow">Waiting for approval</div>' + a.pending.map((p) => '<div class="vstack gap6"><div style="font-size:12px"><b>' + esc(KIND_TEXT[p.kind] || p.kind) + '</b>: ' + esc(p.summary) + '</div>' + proposalActions(Object.assign({}, p, { mine: p.proposedBy === (App.me && App.me.user && App.me.user.id) || p.mine })) + '</div>').join('') : '';
    const canChange = a.mayChange && App.can('cloud:admin');
    return '<div class="hstack"><div class="eyebrow grow">Cloud account</div>' + statePill(a.state) + '</div><div class="cloud-name">' + esc(a.name) + '</div><div class="hstack wrap gap6">' + provPill(a.provider) + '<span class="muted" style="font-size:12px">' + esc(a.scope) + ' scope, ' + (v ? 'validated ' + esc(when(v.at)) : 'not validated') + '</span></div>'
      + '<div class="mono muted" style="font-size:11px;overflow-wrap:anywhere">' + esc(extText(a)) + '</div>' + (a.description ? '<div class="fg2" style="font-size:12px">' + esc(a.description) + '</div>' : '') + notice + pend
      + '<div class="eyebrow">Credentials</div>' + credKv
      + '<div class="eyebrow">Regions and label ceilings</div>' + UI.table(['Region', 'Ceiling', 'Zone', 'Residency'], regionRows, { clickable: false, minWidth: '0', cls: 'bare cloud-t' }) + '<span class="muted" style="font-size:12px">Restricted data never leaves on-prem unless a platform admin approves a restricted ceiling.</span>'
      + credSection(a, st) + budgetSection(a, st) + costSection(a, st)
      + '<div class="eyebrow">' + (a.provider === 'cloudflare' || a.provider === 'digitalocean' ? 'Token permission checklist' : 'Permission check') + '</div>' + checks
      + (canChange ? '<div class="hstack wrap gap6">' + UI.btn('Validate now', { size: 'sm', kind: 'primary', icon: 'check', attrs: 'data-validate', disabled: a.state === 'disabled' }) + (cred.mode === 'federated' ? UI.btn('View trust', { size: 'sm', icon: 'lock', attrs: 'data-trust' }) : '') + UI.btn('Change credentials', { size: 'sm', icon: 'key', attrs: 'data-credential', disabled: a.state === 'pending' }) + UI.btn('Edit regions', { size: 'sm', attrs: 'data-regions', disabled: a.state === 'pending' }) + UI.btn(a.state === 'disabled' ? 'Enable' : 'Disable', { size: 'sm', attrs: 'data-toggle-state', disabled: a.state === 'pending' }) + UI.btn('Discover data services', { size: 'sm', attrs: 'data-discover', disabled: a.state !== 'active' || a.provider === 'cloudflare', title: a.provider === 'cloudflare' ? 'Cloudflare offers D1 only, as a read-only connection on Connections' : '' }) + UI.btn('Disconnect', { size: 'sm', kind: 'danger', attrs: 'data-disconnect', disabled: a.state === 'pending' }) + '</div>' : '');
  }

  // ---------- credential state and rotation, the issuer, the setup helper (Sprint 62, B-10706) ----------

  function credSection(a, st) {
    const c = st.cred && st.cred[a.id];
    if (c === undefined || c === false) return '';
    if (c === null) return '<div class="eyebrow">Credential state</div><div class="muted" style="font-size:12px" role="status">Reading the credential state…</div>';
    const r = c.rotation || {};
    const soon = c.expiresAt && c.expiresAt - Date.now() < 30 * 86400000;
    const expiring = st.forceExpiring || soon;
    const rows = [['Kind', esc(c.kind)], ['Secrets', c.secrets.length ? c.secrets.map((x) => '<span class="mono">' + esc(x) + '</span>').join(', ') + ' <span class="muted">(in the vault)</span>' : '<span class="muted">none: federated</span>'], ['Last used', c.lastUsedAt ? esc(when(c.lastUsedAt)) + (c.lastUsedPurpose ? ' <span class="muted">(' + esc(c.lastUsedPurpose) + ')</span>' : '') : 'never'], ['Rotation', esc(r.automatic ? 'automatic, by ' + r.by : r.by || 'by hand') + (r.rotatedAt ? ', last ' + esc(when(r.rotatedAt)) : '') + (r.state && r.state !== 'idle' ? ' ' + UI.pill(r.state, r.state === 'failed' ? 'danger' : 'info') : '')], ['Expires', c.expiresAt ? esc(when(c.expiresAt)) : 'not set']];
    const canRotate = a.mayChange && App.can('cloud:admin') && c.mode === 'vaulted';
    return '<div class="eyebrow">Credential state</div>' + (expiring ? UI.notice('<b>The credential ' + (c.expiresAt ? 'expires on ' + esc(when(c.expiresAt)) : 'is due for rotation') + '.</b> Rotate it now, or the account stops validating and its connections fail.', 'warn') : '') + (c.notice ? UI.notice(esc(c.notice), 'warn') : '') + (r.lastError ? UI.notice('The last rotation failed: ' + esc(r.lastError), 'danger') : '')
      + UI.kv(rows, 1) + (canRotate ? '<div class="hstack gap6">' + UI.btn('Rotate credentials', { size: 'sm', icon: 'refresh', attrs: 'data-rotate' }) + '</div>' : '');
  }

  function bindRotation(ctx, st, a, reload) {
    ctx.on('click', '[data-rotate]', async () => {
      const c = st.cred && st.cred[a.id];
      if (!c) return;
      if (c.rotation && c.rotation.automatic) {
        const ok = await ctx.confirm({ title: 'Rotate credentials for ' + a.name, tag: 'rotation', tone: 'warn', body: '<p class="fg2" style="margin:0">Exprsn-AI makes a new key at the provider (' + esc(c.rotation.by) + '), checks it, switches to it and deletes the old one after the overlap. No secret is shown.</p>', ok: 'Rotate now' });
        if (!ok) return;
        try { const r = await withStepUp(ctx, () => App.post('/api/admin/cloud/accounts/' + enc(a.id) + '/rotate', {})); if (r === CANCELLED) return; st.forceExpiring = false; ctx.toast('Rotation done for <b>' + esc(a.name) + '</b>. Audit entry written.', 'ok', 5000); reload(); } catch (err) { App.fail(err, 'Not rotated'); }
        return;
      }
      ctx.modal({ title: 'Replace the secret of ' + esc(a.name), body: '<p class="fg2" style="margin:0">Make the new ' + esc(c.kind) + ' at the provider first, paste it here once, then revoke the old one there. The value goes straight into the vault and is never shown again.</p>'
        + c.secrets.map((k) => UI.field(REF_TEXT[k] || k, UI.input('', { type: 'password', attrs: 'data-sv="' + esc(k) + '" autocomplete="off"' }))).join('')
        + UI.field('Expires', UI.input('', { type: 'date', attrs: 'data-sexp' }), 'Optional; a notice goes out 14 days before'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Replace secret', { kind: 'primary', attrs: 'data-sgo' }),
      onMount(m) {
        m.querySelector('[data-sgo]').addEventListener('click', async () => {
          const values = {}; Array.prototype.slice.call(m.querySelectorAll('[data-sv]')).forEach((i) => { if (i.value) values[i.dataset.sv] = i.value; });
          if (!Object.keys(values).length) { ctx.toast('Paste the new secret first.', 'warn'); return; }
          const exp = m.querySelector('[data-sexp]').value;
          const body = { values }; if (exp) body.expiresAt = new Date(exp + 'T00:00:00Z').getTime();
          App.closeOverlay();
          try { const r = await withStepUp(ctx, () => App.put('/api/admin/cloud/accounts/' + enc(a.id) + '/secret', body)); if (r === CANCELLED) return; st.forceExpiring = false; ctx.toast('Secret replaced for <b>' + esc(a.name) + '</b>. Validate the account again.', 'ok', 5000); reload(); } catch (err) { App.fail(err, 'Not replaced'); }
        });
      } });
    });
  }

  function issuerPanel(st) {
    const i = st.issuer;
    if (!App.can('cloud:admin') || i === undefined || i === false) return '';
    if (i === null) return UI.panel('Federation issuer', '<div class="muted" style="font-size:12px" role="status">Reading the issuer…</div>');
    if (!i.installed) return UI.panel('Federation issuer', '<div class="muted" style="font-size:12px">Not installed: the federation migration has not been applied.</div>');
    const pub = i.publication || {}; const chk = i.check || {};
    const keys = (i.keys || []).length ? UI.table(['Key', 'Algorithm', 'State'], i.keys.map((k) => ['<span class="mono" style="font-size:12px">' + esc(k.kid) + '</span>', esc(k.alg), UI.pill(k.state)]), { clickable: false, minWidth: '0', cls: 'bare cloud-t' }) : '<div class="muted" style="font-size:12px">No signing key yet: the first federated call makes one.</div>';
    const platform = App.can('platform:manage');
    return UI.panel('Federation issuer', UI.kv([['Issuer', '<span class="mono" style="overflow-wrap:anywhere">' + esc(i.issuer) + '</span>'], ['Keys held by', esc(i.custody)], ['Published to', esc(i.target && i.target.kind !== 'none' ? i.target.kind : 'not published')], ['Last publication', pub.at ? esc(when(pub.at)) : 'never'], ['Last check', chk.at ? esc(when(chk.at)) + ' ' + UI.pill(chk.state || 'unknown', chk.state === 'ok' ? 'ok' : 'warn') : 'never']], 2)
      + (pub.error ? UI.notice('The last publication failed: ' + esc(pub.error), 'danger') : '') + (chk.detail && chk.state !== 'ok' ? UI.notice(esc(chk.detail), 'warn') : '') + keys
      + '<span class="muted" style="font-size:12px">AWS and Azure read the discovery document and the JWKS from the internet: <span class="mono" style="overflow-wrap:anywhere">' + esc((i.documents || {}).jwks || '') + '</span></span>',
    { actions: UI.btn('Check now', { size: 'sm', attrs: 'data-iss="check"' }) + UI.btn('Publish now', { size: 'sm', attrs: 'data-iss="publish"', disabled: !platform || !i.target || i.target.kind === 'none', title: !i.target || i.target.kind === 'none' ? 'Choose where the documents are published first (exprsn-ai setup or the API)' : '' }) + UI.btn('Rotate signing key', { size: 'sm', attrs: 'data-iss="rotate"', disabled: !platform }) });
  }

  function bindIssuer(ctx, st, reload) {
    ctx.on('click', '[data-iss]', async (e, t) => {
      const what = t.dataset.iss;
      if (what === 'rotate') {
        const ok = await ctx.confirm({ title: 'Rotate the issuer\'s signing key', tag: 'rotation', tone: 'warn', body: '<p class="fg2" style="margin:0">A new key is made and published beside the old one; tokens signed with the old key stay valid until they expire, then it is retired.</p>', ok: 'Rotate' });
        if (!ok) return;
      }
      try {
        const r = await withStepUp(ctx, () => App.post('/api/admin/cloud/issuer/' + what, {}));
        if (r === CANCELLED) return;
        ctx.toast({ check: 'Issuer checked: the published JWKS was compared with the keys.', publish: 'Discovery document and JWKS published.', rotate: 'New signing key made. Audit entry written.' }[what], 'ok', 5000);
        st.issuer = undefined; ctx.rerender();
      } catch (err) { App.fail(err, 'Not done'); }
    });
  }

  function setupHelper(setup) {
    return '<div class="fg2" style="font-size:12px">Run these once at ' + esc(setup.provider === 'aws' ? 'AWS' : 'Azure') + ' (the setup helper for this account; the subject is <span class="mono">' + esc(setup.subject) + '</span>' + (setup.audience ? ', the audience <span class="mono">' + esc(setup.audience) + '</span>' : '') + '):</div>'
      + (setup.steps || []).map((s, i) => '<div class="vstack gap6"><div style="font-weight:600;font-size:13px">' + (i + 1) + '. ' + esc(s.title) + '</div>'
        + (s.commands ? UI.code(s.commands.join('\n'), 'sh') : '') + (s.file ? '<div class="muted" style="font-size:12px">' + esc(s.file.name) + '</div>' + UI.code(s.file.json ? JSON.stringify(s.file.json, null, 2) : String(s.file.text || ''), s.file.json ? 'json' : '') : '')
        + (s.note ? '<div class="muted" style="font-size:12px">' + esc(s.note) + '</div>' : '') + '</div>').join('');
  }

  // ---------- budgets (Sprint 58, B-10602) ----------

  const money = (n, cur) => (Math.round(Number(n) * 100) / 100).toFixed(2) + ' ' + cur;
  function budgetOf(st, id) { return (st.budgets || []).find((b) => b.account.id === id) || null; }
  function budgetCell(b) {
    if (!b) return '<span class="muted">none</span>';
    const s = b.status;
    const tone = s.stopped ? (s.override ? 'warn' : 'danger') : s.pctForecast >= 80 || s.pctActual >= 80 ? 'warn' : 'ok';
    return UI.pill(s.pctActual + ' % of ' + money(s.budget.amount, s.budget.currency), tone);
  }
  function budgetSection(a, st) {
    if (st.budgets === null || st.budgets === undefined) return '';
    const b = budgetOf(st, a.id);
    const manage = a.mayChange && App.can('finops:manage');
    const decide = a.mayChange && (App.can('finops:manage') || App.can('cloud:admin'));
    const me = App.me && App.me.user && App.me.user.id;
    if (!b) return '<div class="eyebrow">Monthly budget</div><div class="muted" style="font-size:12px">No budget: no alerts, and no plan is refused for cost.</div>' + (manage ? '<div class="hstack gap6">' + UI.btn('Set budget', { size: 'sm', attrs: 'data-budget-set' }) + '</div>' : '');
    const s = b.status;
    const o = s.override;
    const rows = [['Budget', esc(money(s.budget.amount, s.budget.currency))], ['Spent this month', esc(money(s.actual.amount, s.budget.currency)) + ' <span class="muted">(' + s.pctActual + ' %)</span>'], ['Forecast', esc(money(s.forecast.amount, s.budget.currency)) + ' <span class="muted">(' + s.pctForecast + ' %)</span>'], ['Hard stop', esc(s.budget.hardStop === 'off' ? 'off: alerts only' : 'at 100 % of ' + (s.budget.hardStop === 'forecast' ? 'the forecast' : 'actual spend'))]];
    if (o) rows.push(['Override', 'until ' + esc(when(o.expiresAt))]);
    let notice = '';
    if (s.stopped && !o) notice = UI.notice('Past the hard stop: plans that add monthly cost are refused (budget_exceeded). Scale-down and destroy still apply.', 'danger');
    else if (s.stopped && o) notice = UI.notice('Past the hard stop; an approved override lets plans that add cost through until ' + esc(when(o.expiresAt)) + '.', 'warn');
    const pend = (b.pending || []).map((p) => '<div class="vstack gap6"><div style="font-size:12px"><b>Override</b> for ' + esc(String(p.hours)) + ' hours: ' + esc(p.reason) + '</div>' + (decide ? '<div class="hstack gap6">' + (p.proposedBy === me ? UI.btn('Withdraw', { size: 'xs', attrs: 'data-ovr-withdraw="' + esc(p.id) + '"' }) : UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-ovr-approve="' + esc(p.id) + '"' }) + UI.btn('Reject', { size: 'xs', attrs: 'data-ovr-reject="' + esc(p.id) + '"' })) + '</div>' : '') + '</div>').join('');
    const actions = [manage ? UI.btn('Change budget', { size: 'sm', attrs: 'data-budget-set' }) : '', decide && s.stopped && !o && !(b.pending || []).length ? UI.btn('Request override', { size: 'sm', attrs: 'data-budget-override' }) : '', decide && o ? UI.btn('End override', { size: 'sm', attrs: 'data-ovr-revoke="' + esc(o.id) + '"' }) : '', manage ? UI.btn('Remove budget', { size: 'sm', kind: 'ghost', attrs: 'data-budget-remove' }) : ''].join('');
    return '<div class="eyebrow">Monthly budget</div>' + notice + UI.kv(rows, 1) + pend + '<span class="muted" style="font-size:12px">' + esc(s.source || '') + ' Alerts at 50, 80 and 100 % of actual and forecast spend.</span>' + (actions ? '<div class="hstack wrap gap6">' + actions + '</div>' : '');
  }
  // ---------- ingested costs (Sprint 59, B-10603) ----------

  function costOf(st, id) { return (st.costs || []).find((c) => c.account.id === id) || null; }
  function costCell(c, st) {
    if (st.costs === null || st.costs === undefined) return '<span class="muted">not available</span>';
    if (!c) return '<span class="muted">none</span>';
    const cur = Object.keys(c.monthToDate);
    if (!cur.length) return '<span class="muted">' + (c.eligible ? 'not fetched' : 'nothing billed yet') + '</span>';
    return esc(cur.map((k) => money(c.monthToDate[k], k)).join(', ')) + (c.budgetSource === 'billing' ? '' : ' <span class="muted">(stale)</span>');
  }
  function costSection(a, st) {
    const c = costOf(st, a.id);
    if (!c) return '';
    const manage = a.mayChange && App.can('finops:manage');
    const billed = Object.keys(c.monthToDate).map((k) => money(c.monthToDate[k], k)).join(', ') || 'nothing yet';
    const rows = [['Billed this month', esc(billed)], ['Estimate so far', esc(money(c.estimate, c.currency))], ['Actual so far', esc(money(c.actual, c.currency)) + (c.estimate > 0 ? ' <span class="muted">(' + Math.round((c.actual / c.estimate) * 100) + ' % of the estimate)</span>' : '')], ['Budget spend from', c.budgetSource === 'billing' ? 'billing data' : 'estimates'], ['Last fetch', c.lastFetch ? esc(when(c.lastFetch.at)) + ' ' + (c.lastFetch.state === 'ok' ? UI.pill('ok', 'ok') : UI.pill(c.lastFetch.state, c.lastFetch.state === 'failed' ? 'danger' : 'info')) : 'never']];
    const note = c.eligible ? c.eligible : c.lastFetch && c.lastFetch.state === 'failed' && c.lastFetch.error ? c.lastFetch.error : c.reason;
    return '<div class="eyebrow">Cloud costs</div>' + UI.kv(rows, 1) + '<span class="muted" style="font-size:12px">' + esc(note) + ' Fetched once a day; each fetch is a paid request on AWS.</span>' + (manage && !c.eligible ? '<div class="hstack gap6">' + UI.btn('Fetch costs now', { size: 'sm', attrs: 'data-costs-fetch' }) + '</div>' : '');
  }
  function bindCosts(ctx, a, reload) {
    if (!a) return;
    ctx.on('click', '[data-costs-fetch]', async () => {
      try { await App.post('/api/admin/cloud/accounts/' + enc(a.id) + '/costs/fetch'); ctx.toast('Cost fetch queued. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not queued'); }
    });
  }
  function bindBudget(ctx, st, a, reload) {
    if (!a) return;
    const base = '/api/admin/cloud/accounts/' + enc(a.id) + '/budget';
    ctx.on('click', '[data-budget-set]', () => {
      const b = budgetOf(st, a.id);
      const cur = b ? b.status.budget : { amount: '', currency: 'USD', hardStop: 'actual' };
      ctx.modal({ title: 'Monthly budget for ' + esc(a.name), body: '<p class="fg2" style="margin:0">Alerts go to FinOps readers and cloud admins at 50, 80 and 100 % of actual and forecast spend. Past the hard stop, plans that add monthly cost are refused.</p>'
        + UI.field('Amount per month', UI.input(String(cur.amount), { type: 'number', attrs: 'data-amount min="1" step="1" inputmode="decimal"' }))
        + UI.field('Currency', UI.input(cur.currency, { attrs: 'data-currency maxlength="3" autocapitalize="characters"' }))
        + UI.field('Hard stop', UI.select([{ value: 'actual', label: 'At 100 % of actual spend' }, { value: 'forecast', label: 'At 100 % of the forecast' }, { value: 'off', label: 'Off: alerts only' }], cur.hardStop, 'data-hardstop')),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save budget', { kind: 'primary', attrs: 'data-ok' }),
        onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', async () => {
            const amount = Number(m.querySelector('[data-amount]').value);
            const currency = m.querySelector('[data-currency]').value.trim().toUpperCase();
            if (!(amount > 0)) { ctx.toast('Enter an amount above 0.', 'warn'); return; }
            try { await App.put(base, { amount, currency: currency || undefined, hardStop: m.querySelector('[data-hardstop]').value }); App.closeOverlay(); ctx.toast('Budget saved. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not saved'); }
          });
        } });
    });
    ctx.on('click', '[data-budget-remove]', async () => {
      const ok = await ctx.confirm({ title: 'Remove the budget of ' + a.name, tone: 'warn', body: '<p class="fg2" style="margin:0">No more alerts, and no plan is refused for cost on this account.</p>', ok: 'Remove' });
      if (!ok) return;
      try { await App.del(base); ctx.toast('Budget removed. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not removed'); }
    });
    ctx.on('click', '[data-budget-override]', () => {
      ctx.modal({ title: 'Request a budget override ' + UI.pill('dual control', 'danger'), body: '<p class="fg2" style="margin:0">Lifts the hard stop for at most 7 days once another admin approves. Scale-down and destroy never need one.</p>'
        + UI.field('Reason', UI.input('', { placeholder: 'At least 10 characters, recorded in the audit chain', attrs: 'data-reason maxlength="500"' }))
        + UI.field('Hours', UI.input('168', { type: 'number', attrs: 'data-hours min="1" max="168" step="1"' })),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Propose override', { kind: 'primary', attrs: 'data-ok' }),
        onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', async () => {
            const reason = m.querySelector('[data-reason]').value.trim();
            const hours = Math.max(1, Math.min(168, Math.round(Number(m.querySelector('[data-hours]').value) || 168)));
            try { await App.post(base + '/overrides', { reason, hours }); App.closeOverlay(); ctx.toast('Override proposed. Waiting for a second admin.', 'warn', 5000); reload(); } catch (err) { App.fail(err, 'Not proposed'); }
          });
        } });
    });
    ctx.on('click', '[data-ovr-approve]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'Approve the budget override', tag: 'dual control', tone: 'warn', body: '<p class="fg2" style="margin:0">Plans that add cost on ' + esc(a.name) + ' are accepted until the override ends.</p>', ok: 'Approve' });
      if (!ok) return;
      try { const r = await withStepUp(ctx, () => App.post(base + '/overrides/' + enc(t.dataset.ovrApprove) + '/approve', {})); if (r === CANCELLED) return; ctx.toast('Override approved. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not approved'); }
    });
    ctx.on('click', '[data-ovr-reject]', async (e, t) => {
      try { await App.post(base + '/overrides/' + enc(t.dataset.ovrReject) + '/reject', {}); ctx.toast('Override rejected.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not rejected'); }
    });
    ctx.on('click', '[data-ovr-withdraw]', async (e, t) => {
      try { await App.post(base + '/overrides/' + enc(t.dataset.ovrWithdraw) + '/withdraw', {}); ctx.toast('Override withdrawn.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not withdrawn'); }
    });
    ctx.on('click', '[data-ovr-revoke]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'End the override now', tone: 'warn', body: '<p class="fg2" style="margin:0">The hard stop applies again at once.</p>', ok: 'End override' });
      if (!ok) return;
      try { await App.post(base + '/overrides/' + enc(t.dataset.ovrRevoke) + '/revoke', {}); ctx.toast('Override ended. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Not ended'); }
    });
  }

  function regionsModal(ctx, st, a, reload) {
    const cat = st.cat.providers.find((p) => p.id === a.provider);
    const cur = {}; a.regions.forEach((r) => { cur[r.region] = r; });
    ctx.modal({ title: 'Regions for ' + esc(a.name), cls: 'wide', body: '<p class="fg2" style="margin:0">Exprsn-AI places nothing outside these regions. Each region maps to a zone and a label ceiling; data, pools and models above the ceiling are refused there.</p>'
      + UI.table(['Allowed', 'Region', 'Label ceiling', 'Zone'], cat.regions.map((r) => [UI.check('', !!cur[r.region], 'data-r="' + esc(r.region) + '" aria-label="Allow ' + esc(r.region) + '"'), esc(r.name) + ' <span class="mono muted">' + esc(r.region) + '</span>', UI.select(LABELS, cur[r.region] ? cur[r.region].ceiling : r.ceiling, 'aria-label="Ceiling for ' + esc(r.region) + '" data-ceil="' + esc(r.region) + '"'), '<span class="mono">' + esc(r.zone) + '</span>']), { clickable: false, minWidth: '0' })
      + UI.field('Default region', UI.select(a.regions.map((r) => r.region), a.defaultRegion, 'data-default')) + UI.notice('Raising a ceiling needs a second cloud admin; restricted needs a platform admin.', 'info'),
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save regions', { kind: 'primary', attrs: 'data-save' }),
    onMount(m) {
      m.querySelector('[data-save]').addEventListener('click', async () => {
        const regions = Array.prototype.slice.call(m.querySelectorAll('[data-r]')).filter((c) => c.checked).map((c) => ({ region: c.dataset.r, ceiling: m.querySelector('[data-ceil="' + c.dataset.r + '"]').value }));
        if (!regions.length) { ctx.toast('Keep at least one region.', 'warn'); return; }
        const def = m.querySelector('[data-default]').value;
        const body = { regions };
        if (regions.some((r) => r.region === def)) body.defaultRegion = def;
        try {
          const out = await App.patch('/api/admin/cloud/accounts/' + enc(a.id), body);
          App.closeOverlay();
          const raised = (out.proposals || []).length;
          ctx.toast(raised ? 'Regions saved. The raised ceiling waits for a second cloud admin.' : 'Regions saved for <b>' + esc(a.name) + '</b>. Audit entry written.', raised ? 'warn' : 'ok', 5000);
          reload();
        } catch (err) { App.fail(err, 'Not saved'); }
      });
    } });
  }

  function credFields(provider, mode, st) {
    const cat = st.cat.providers.find((p) => p.id === provider);
    const spec = cat.credentialFields[mode] || { params: [], refs: [] };
    return { params: spec.params.concat(spec.optionalParams || []), refs: spec.refs.concat(spec.optionalRefs || []), optionalRefs: spec.optionalRefs || [] };
  }

  function credInputs(provider, mode, st, values, name) {
    const f = credFields(provider, mode, st);
    return '<div class="formgrid" style="--cols:1">'
      + f.params.map((k) => UI.field(PARAM_TEXT[k] || k, UI.input(values.params[k] || '', { attrs: 'data-param="' + esc(k) + '"', placeholder: k === 'roleArn' ? 'arn:aws:iam::<account>:role/<name>' : '00000000-0000-0000-0000-000000000000' }))).join('')
      + f.refs.map((k) => UI.field((REF_TEXT[k] || k) + (f.optionalRefs.indexOf(k) >= 0 ? ' (one of these)' : ''), UI.input(values.refs[k] || '', { attrs: 'data-ref="' + esc(k) + '"', placeholder: 'vault:cloud/' + (name || 'account') + '#' + k }), 'A vault reference, never the secret itself')).join('')
      + '</div>';
  }

  function readCred(m) {
    const params = {}; const refs = {};
    Array.prototype.slice.call(m.querySelectorAll('[data-param]')).forEach((i) => { if (i.value.trim()) params[i.dataset.param] = i.value.trim(); });
    Array.prototype.slice.call(m.querySelectorAll('[data-ref]')).forEach((i) => { if (i.value.trim()) refs[i.dataset.ref] = i.value.trim(); });
    return { params, refs };
  }

  function credentialModal(ctx, st, a, reload) {
    const cat = st.cat.providers.find((p) => p.id === a.provider);
    let mode = a.credentialMode;
    const draw = (m) => { m.querySelector('[data-credfields]').innerHTML = credInputs(a.provider, mode, st, { params: {}, refs: {} }, a.name); };
    ctx.modal({ title: 'Change credentials for ' + esc(a.name), body: '<p class="fg2" style="margin:0">A new reference in the same mode applies at once and clears the last validation. Changing the mode waits for a second cloud admin.</p>'
      + UI.field('Mode', UI.select(cat.modes.map((x) => ({ value: x, label: x })), mode, 'data-mode'), cat.federation.available ? '' : cat.federation.reason) + '<div data-credfields></div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-save' }),
    onMount(m) {
      draw(m);
      m.querySelector('[data-mode]').addEventListener('change', (e) => { mode = e.target.value; draw(m); });
      m.querySelector('[data-save]').addEventListener('click', async () => {
        const c = readCred(m);
        try { const out = await App.patch('/api/admin/cloud/accounts/' + enc(a.id), { credential: { mode, params: c.params, refs: c.refs } }); App.closeOverlay(); ctx.toast((out.proposals || []).length ? 'Credential mode change proposed. Waiting for a second cloud admin.' : 'Credentials changed. Validate the account again.', (out.proposals || []).length ? 'warn' : 'ok', 5000); reload(); } catch (err) { App.fail(err, 'Not saved'); }
      });
    } });
  }

  function setupSnippet(provider, name, a, st) {
    const cat = st.cat.providers.find((p) => p.id === provider);
    const subject = 'cloud-account:' + (a && a.id ? a.id : '<id>');
    if (provider === 'aws') {
      const acct = (a && a.providerIds && a.providerIds.awsAccountId) || '<account>';
      return '<div class="fg2" style="font-size:12px">The IAM role\'s trust policy names Exprsn-AI\'s issuer as the federated principal and conditions on the audience and this subject:</div>' + UI.code(JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Federated: 'arn:aws:iam::' + acct + ':oidc-provider/<issuer host>' }, Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: { '<issuer host>:aud': 'sts.amazonaws.com', '<issuer host>:sub': subject } } }] }, null, 2), 'json');
    }
    if (provider === 'azure') {
      const sub = (a && a.providerIds && a.providerIds.azureSubscriptionId) || '<subscription>';
      return '<div class="fg2" style="font-size:12px">A federated identity credential on the app registration or managed identity:</div>' + UI.code(['az ad app federated-credential create \\', '  --id <client id> \\', '  --parameters \'{"name":"exprsn-ai-' + name + '",', '    "issuer":"<issuer>",', '    "subject":"' + subject + '",', '    "audiences":["api://AzureADTokenExchange"]}\'', 'az role assignment create --assignee <client id> \\', '  --role Reader --scope /subscriptions/' + sub].join('\n'), 'sh');
    }
    const items = [];
    cat.features.forEach((f) => (f.checklist || []).forEach((c) => items.push([esc((c.level ? (c.level === 'zone' ? 'Zone: ' : 'Account: ') : '') + c.permission), esc(f.name + ', ' + c.usedFor)])));
    return '<div class="fg2" style="font-size:12px">' + (provider === 'digitalocean' ? 'Create a custom-scoped personal access token (API, Tokens) with these scopes, then store it in the vault:' : 'Create an account API token (My Profile, API Tokens, Custom token) with these permissions, then store it in the vault:') + '</div>'
      + UI.table([provider === 'digitalocean' ? 'Scope' : 'Permission', 'Used for'], items, { clickable: false, minWidth: '0', cls: 'bare cloud-t' }) + UI.notice(esc(cat.federation.reason || ''), 'info');
  }

  function renderWizard(root, ctx, st, style, reload) {
    const w = st.wiz;
    const cat = st.cat.providers.find((p) => p.id === w.provider);
    const STEPS = ['Provider', 'Credentials', 'Setup', 'Regions'];
    if (cat.modes.indexOf(w.mode) < 0) w.mode = cat.modes[0];
    const steps = '<div class="cloud-steps">' + STEPS.map((s, i) => '<span class="' + (i + 1 === w.step ? 'cur' : i + 1 < w.step ? 'done' : '') + '"' + (i + 1 === w.step ? ' aria-current="step"' : '') + '><i>' + (i + 1) + '</i>' + s + '</span>' + (i < STEPS.length - 1 ? '<span class="sep" aria-hidden="true">›</span>' : '')).join('') + '</div>';
    const blurb = { aws: 'SDK v3. Managed data, Bedrock, later deployments and GPU node groups.', azure: 'ARM SDKs. Managed data, Azure AI Foundry, later deployments and GPU node pools.', digitalocean: 'REST API v2. Managed data, GenAI, later Kubernetes, Droplets and App Platform.', cloudflare: 'Edge and app tier only: front door, Tunnel, Containers, R2, D1, Workers AI, AI Gateway.' };
    const platformAdmin = !!(st.data && st.data.platformAdmin);
    let body = '';
    if (w.step === 1) {
      body = '<div class="cloud-tiles" role="group" aria-label="Provider">' + st.cat.providers.map((p) => '<button type="button" class="cloud-tile' + (w.provider === p.id ? ' on' : '') + '" aria-pressed="' + (w.provider === p.id ? 'true' : 'false') + '" data-pick="' + esc(p.id) + '"><b>' + esc(p.name) + '</b><span>' + esc(blurb[p.id]) + '</span><span class="muted">' + (p.federation.available ? 'federated or vaulted' : 'vaulted token only') + '</span></button>').join('') + '</div>'
        + UI.field('Account name in Exprsn-AI', UI.input(w.name, { attrs: 'data-f="name"' }), 'Lower case, used in tags (exprsn:account) and audit entries; it cannot be changed later')
        + UI.field('Scope', UI.select([{ value: 'tenant', label: 'This tenant (data connections and model backends)' }].concat(platformAdmin ? [{ value: 'platform', label: 'Platform (deployments, pools, the own database)' }] : []), w.scope, 'data-f="scope"'), 'A tenant account is used only for this tenant\'s connections and model backends')
        + UI.field('Description', UI.input(w.description, { attrs: 'data-f="description"' }));
    } else if (w.step === 2) {
      body = '<div class="cloud-tiles" role="group" aria-label="Credential mode">'
        + '<button type="button" class="cloud-tile' + (w.mode === 'federated' ? ' on' : '') + '" aria-pressed="' + (w.mode === 'federated' ? 'true' : 'false') + '" data-mode="federated"' + (cat.federation.available ? '' : ' disabled') + '><b>Federated</b><span>' + (cat.federation.available ? 'The account trusts Exprsn-AI\'s issuer; each call uses a one-hour session. Nothing long-lived is stored.' : 'Unavailable: ' + esc(cat.federation.reason)) + '</span></button>'
        + '<button type="button" class="cloud-tile' + (w.mode === 'vaulted' ? ' on' : '') + '" aria-pressed="' + (w.mode === 'vaulted' ? 'true' : 'false') + '" data-mode="vaulted"><b>Vaulted</b><span>' + ({ aws: 'An IAM access key held in the vault.', azure: 'A client secret or a certificate held in the vault.', digitalocean: 'A custom-scoped personal access token held in the vault.', cloudflare: 'A scoped API token held in the vault, with the account id.' })[w.provider] + '</span></button></div>'
        + credInputs(w.provider, w.mode, st, { params: w.params, refs: w.refs }, w.name);
    } else if (w.step === 3) {
      body = '<div class="formgrid" style="--cols:1">' + ID_FIELDS[w.provider].map((f) => UI.field(f[1], UI.input(w.ids[f[0]] || '', { attrs: 'data-id-field="' + esc(f[0]) + '"', placeholder: f[2] }))).join('') + '</div>' + setupSnippet(w.provider, w.name, { providerIds: w.ids }, st)
        + UI.notice('After the account is added, validate it from its inspector: Exprsn-AI asks the provider who the credential is and checks every action each feature needs.', 'info');
    } else {
      body = UI.table(['Allowed', 'Region', 'Starts at', 'Zone'], cat.regions.map((r) => [UI.check('', w.regions.indexOf(r.region) >= 0, 'data-wr="' + esc(r.region) + '" aria-label="Allow ' + esc(r.region) + '"'), esc(r.name) + ' <span class="mono muted">' + esc(r.region) + '</span>', UI.label(r.ceiling, { sm: true }), '<span class="mono">' + esc(r.zone) + '</span>']), { clickable: false, minWidth: '0' })
        + UI.field('Default region', UI.select(w.regions.length ? w.regions : [cat.regions[0].region], w.defaultRegion, 'data-f="defaultRegion"'))
        + UI.notice('Adding an account needs a second cloud admin' + (w.scope === 'platform' ? ' with platform:manage' : '') + '. Submitting sends a proposal; the account stays unusable until it is approved. Ceilings start at internal; raise them later, under dual control.', 'info');
    }
    const back = UI.btn('Back', { size: 'sm', attrs: 'data-back', disabled: w.step === 1 });
    const next = w.step < 4 ? UI.btn('Next', { kind: 'primary', size: 'sm', attrs: 'data-next' }) : UI.btn('Submit for approval', { kind: 'primary', size: 'sm', attrs: 'data-submit' });
    root.innerHTML = style + '<div class="page">' + UI.pagehead('Connect a cloud account', 'Step ' + w.step + ' of 4, ' + esc(STEPS[w.step - 1]) + ' · ' + esc(cat.name), UI.btn('Cancel', { kind: 'ghost', attrs: 'data-cancel' }))
      + steps + UI.panel('Step ' + w.step + ' of 4', body + '<div class="cloud-fb">' + back + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-cancel' }) + '<span class="grow"></span>' + next + '</div>') + '</div>';
    const keep = () => {
      const page = ctx.$('.page'); if (!page) return;
      if (w.step === 2) { const c = readCred(page); w.params = c.params; w.refs = c.refs; }
      if (w.step === 3) Array.prototype.slice.call(page.querySelectorAll('[data-id-field]')).forEach((i) => { w.ids[i.dataset.idField] = i.value.trim(); });
    };
    ctx.on('click', '[data-pick]', (e, t) => { w.provider = t.dataset.pick; const c = st.cat.providers.find((p) => p.id === w.provider); w.mode = c.modes[0]; w.regions = [c.regions[0].region]; w.defaultRegion = c.regions[0].region; w.name = { aws: 'aws-analytics', azure: 'azure-analytics', digitalocean: 'do-analytics', cloudflare: 'cf-edge' }[w.provider]; w.ids = {}; w.params = {}; w.refs = {}; ctx.rerender(); });
    ctx.on('input', '[data-f="name"]', (e, t) => { w.name = t.value.trim(); });
    ctx.on('input', '[data-f="description"]', (e, t) => { w.description = t.value; });
    ctx.on('change', '[data-f="scope"]', (e, t) => { w.scope = t.value; });
    ctx.on('change', '[data-f="defaultRegion"]', (e, t) => { w.defaultRegion = t.value; });
    ctx.on('click', '[data-mode]', (e, t) => { if (t.disabled) return; keep(); w.mode = t.dataset.mode; w.params = {}; w.refs = {}; ctx.rerender(); });
    ctx.on('change', '[data-wr]', (e, t) => { const r = t.dataset.wr; w.regions = t.checked ? w.regions.concat([r]) : w.regions.filter((x) => x !== r); if (w.regions.indexOf(w.defaultRegion) < 0) w.defaultRegion = w.regions[0]; ctx.rerender(); });
    ctx.on('click', '[data-back]', () => { keep(); w.step--; ctx.rerender(); });
    ctx.on('click', '[data-next]', () => { keep(); w.step++; ctx.rerender(); });
    ctx.on('click', '[data-cancel]', () => { st.wiz = null; ctx.rerender(); });
    ctx.on('click', '[data-submit]', async () => {
      if (!w.regions.length) { ctx.toast('Allow at least one region.', 'warn'); return; }
      const ok = await ctx.confirm({ title: 'Propose account ' + w.name, tag: 'dual control', tone: 'info', body: '<p class="fg2" style="margin:0">A second cloud admin approves before Exprsn-AI uses this account.</p>', kv: [['Provider', esc(cat.name)], ['Scope', esc(w.scope)], ['Credentials', esc(w.mode)], ['Regions', esc(w.regions.join(', '))]], ok: 'Send proposal' });
      if (!ok) return;
      const ids = {}; Object.keys(w.ids).forEach((k) => { if (w.ids[k]) ids[k] = w.ids[k]; });
      const body = { name: w.name, provider: w.provider, scope: w.scope, providerIds: ids, credential: { mode: w.mode, params: w.params, refs: w.refs }, regions: w.regions.map((r) => ({ region: r })), defaultRegion: w.defaultRegion };
      if (w.description.trim()) body.description = w.description.trim();
      try {
        const out = await App.post('/api/admin/cloud/accounts', body);
        st.wiz = null; st.sel = out.account.id; st.prov = 'all'; st.view = null;
        ctx.toast('Proposal sent. <b>' + esc(w.name) + '</b> is listed as pending approval.', 'ok', 5000);
        reload();
      } catch (err) { App.fail(err, 'Not added'); }
    });
  }
})();
