(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const RANK = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  // Offered in the effective-permission picker alongside the caller's own permissions and the role catalogue.
  const EXTRA_ACTIONS = ['tools:invoke', 'inference:invoke', 'chat:write', 'knowledge:read', 'guardrails:manage', 'models:manage'];
  // Limits the server enforces with 429 are marked `enforced`; training hours are reported but not yet admitted against.
  const LIMITS = [
    { key: 'tokensPerDay', used: 'tokensToday', label: 'Tokens today', field: 'Tokens per day', reset: 'daily', enforced: true, unit: 'tokens today' },
    { key: 'gpuSecondsPerMonth', used: 'gpuSecondsMonth', label: 'GPU-seconds, month', field: 'GPU-seconds per month', reset: 'monthly', enforced: true, unit: 'GPU-seconds this month' },
    { key: 'trainingGpuHoursPerMonth', used: 'trainingGpuHoursMonth', label: 'Training GPU-hours', field: 'Training GPU-hours per month', reset: 'monthly', enforced: false, unit: 'training GPU-hours this month' }
  ];
  const STEP_NAME = { role: 'role', scope: 'credential scopes', tenant: 'tenant', clearance: 'clearance', zone: 'zone ceiling' };

  const enc = encodeURIComponent;
  const num = (v) => Number(v || 0).toLocaleString();
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const tUrl = (tid) => '/api/admin/tenants/' + enc(tid);
  const wUrl = (tid, wid) => tUrl(tid) + '/workspaces/' + enc(wid);
  const isSys = () => !!(App.me && App.me.roles.some((r) => r.id === 'system-admin'));
  const ownTid = () => (App.me && App.me.tenant ? App.me.tenant.id : null);
  const myClearance = () => (App.me ? App.me.user.clearance : 'public');
  const grantable = () => LABELS.filter((l) => RANK[l] <= RANK[myClearance()]);

  const meterFor = (q, L) => {
    const used = q.used[L.used], max = q[L.key];
    if (max == null) return UI.meter(L.label, num(used) + ' used, no limit', 0);
    const pct = max > 0 ? (used / max) * 100 : 100;
    return UI.meter(L.label, num(used) + ' of ' + num(max), pct, pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : '');
  };
  const reachedLimits = (q) => (q ? LIMITS.filter((L) => L.enforced && q[L.key] != null && q.used[L.used] >= q[L.key]) : []);
  const limitText = (v) => (v == null ? 'no limit' : num(v));

  /** One line about the last directory sync, from the tenant's lastSync. */
  const syncSummary = (s) => {
    if (!s) return 'Directory sync has not run yet';
    if (s.state !== 'succeeded') return 'Directory sync ' + s.state + ', ' + when(s.at);
    const reports = Array.isArray(s.result) ? s.result : [];
    const sum = (k) => reports.reduce((a, r) => a + (Array.isArray(r[k]) ? r[k].length : Number(r[k] || 0)), 0);
    const parts = [num(sum('checked')) + ' checked', num(sum('updated')) + ' updated', num(sum('disabled')) + ' disabled'];
    if (sum('errors')) parts.push(num(sum('errors')) + ' errors');
    return 'Directory sync ran ' + when(s.at) + ': ' + parts.join(', ');
  };
  const syncDisabled = (s) => (s && Array.isArray(s.result) ? s.result.reduce((a, r) => a.concat(r.disabled || []), []) : []);

  // The deletion job leaves an offboarded tenant 'disabled'; its destroyed key tells it apart from an admin-disabled one.
  const tState = (t) => (t.state === 'disabled' && t.key.state === 'destroyed' ? 'offboarded' : t.state);

  const findNode = (st) => {
    const tenants = st.tenants || [];
    for (const t of tenants) {
      if (st.node === 't:' + t.id) return { type: 'tenant', tenant: t };
      const w = t.workspaces.find((x) => st.node === 'w:' + x.id);
      if (w) return { type: 'workspace', tenant: t, ws: w };
    }
    const t = tenants.find((x) => x.id === ownTid()) || tenants[0];
    if (!t) return null;
    const w = t.workspaces.find((x) => x.state === 'active');
    return w ? { type: 'workspace', tenant: t, ws: w } : { type: 'tenant', tenant: t };
  };

  /** The workspace a state should show: the selected one, else the first active one in this tenant, then in the caller's own. */
  const pickWorkspace = (st) => {
    const n = findNode(st); if (!n) return null;
    if (n.type === 'workspace') return n.ws;
    const own = (st.tenants || []).find((t) => t.id === ownTid());
    return n.tenant.workspaces.find((w) => w.state === 'active') || (own && own.workspaces.find((w) => w.state === 'active')) || null;
  };

  // ---------- Sprint 13: webhooks and the outbound host allow-list (own tenant only) ----------
  // Webhooks: /api/admin/webhooks (webhooks:manage). Allowed hosts: /api/admin/integrations/hosts (tenant:manage).
  const WH_TONE = { succeeded: 'ok', failed: 'danger', pending: 'info' };
  function integLoad(st, ctx) {
    const ig = st.integ = st.integ || {};
    if (ig.loading || ig.loaded) return;
    ig.loading = true;
    Promise.all([App.can('webhooks:manage') ? App.get('/api/admin/webhooks') : null, App.can('tenant:manage') ? App.get('/api/admin/integrations/hosts') : null])
      .then(([hooks, hosts]) => { Object.assign(ig, { hooks, hosts, loaded: true, error: null }); if (hooks && !hooks.webhooks.some((w) => w.id === ig.sel)) ig.sel = hooks.webhooks.length ? hooks.webhooks[0].id : null; })
      .catch((err) => { ig.error = err; ig.loaded = true; })
      .finally(() => { ig.loading = false; if (App.state.route === 'tenants') ctx.rerender(); });
  }
  function integDeliveries(st, ctx, id) {
    const ig = st.integ; if (!id || ig.delLoading === id) return;
    ig.delLoading = id;
    App.get('/api/admin/webhooks/' + encodeURIComponent(id) + '/deliveries?limit=50')
      .then((r) => { ig.deliveries = ig.deliveries || {}; ig.deliveries[id] = r; })
      .catch((err) => { ig.deliveries = ig.deliveries || {}; ig.deliveries[id] = { error: err }; })
      .finally(() => { ig.delLoading = null; if (App.state.route === 'tenants') ctx.rerender(); });
  }
  const whWhen = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  function webhooksHtml(st, ctx) {
    const ig = st.integ || {};
    if (!ig.loaded) return UI.notice('Loading…', 'info');
    if (ig.error) return UI.problem('Webhooks could not be loaded', ig.error.message, ig.error.problem && ig.error.problem.trace_id);
    const list = ig.hooks.webhooks;
    const sel = list.find((w) => w.id === ig.sel) || null;
    if (sel && !(ig.deliveries && ig.deliveries[sel.id]) && ig.delLoading !== sel.id) integDeliveries(st, ctx, sel.id);
    const dl = sel && ig.deliveries ? ig.deliveries[sel.id] : null;
    const s = ig.hooks.settings;
    let h = '<div class="hstack wrap"><span class="fg2 grow" style="font-size:12px">Events from this tenant are posted to your endpoints as signed JSON. <span class="mono">X-Exprsn-Signature</span> is <span class="mono">sha256=</span> HMAC-SHA256 of <span class="mono">&lt;X-Exprsn-Timestamp&gt;.&lt;body&gt;</span> with the webhook\'s secret. Failed deliveries are retried ' + esc(s.maxAttempts - 1) + ' times with growing gaps; ' + esc(s.breakerThreshold) + ' failures in a row pause the endpoint for ' + esc(Math.round(s.breakerCooldownMs / 60000)) + ' min.</span>'
      + UI.btn('New webhook', { kind: 'primary', icon: 'plus', attrs: 'data-whnew' }) + '</div>';
    h += UI.table(['Name', 'Endpoint', 'Events', 'Up to', 'State', 'Breaker', 'Last delivery'], list.map((w) => ({ cells: ['<b>' + esc(w.name) + '</b>', '<span class="mono" style="overflow-wrap:anywhere">' + esc(w.url) + '</span>', esc(w.events.join(', ')), UI.label(w.maxLabel, { sm: true }), UI.pill(w.state, w.state === 'active' ? 'ok' : 'outline'), w.breaker === 'open' ? UI.pill('open', 'danger') : UI.pill('closed', 'ok'), esc(w.lastDeliveryAt ? whWhen(w.lastDeliveryAt) + ', ' + (w.lastStatus || '') : 'never')], attrs: 'data-whsel="' + esc(w.id) + '"', selected: sel && sel.id === w.id })), { minWidth: '760px', emptyTitle: 'No webhooks', emptyText: 'Add one to post audit actions, job states, flags and approvals to an internal endpoint.' });
    if (sel) {
      h += (sel.breaker === 'open' ? UI.notice('<b>Paused after ' + esc(sel.failures) + ' failed attempts.</b> Deliveries wait until ' + esc(whWhen(sel.retryAt)) + '; the first one after that is a trial that closes the breaker when it succeeds.', 'warn') : '')
        + UI.panel(esc(sel.name), UI.kv([['Endpoint', '<span class="mono">' + esc(sel.url) + '</span>'], ['Events', esc(sel.events.join(', '))], ['Carries events up to', UI.label(sel.maxLabel, { sm: true })], ['Consecutive failures', esc(sel.failures)], ['Created', esc(whWhen(sel.createdAt))]], 2), {
          actions: UI.btn('Send test', { size: 'sm', attrs: 'data-whtest' }) + UI.btn('Edit', { size: 'sm', kind: 'ghost', attrs: 'data-whedit' }) + UI.btn('Rotate secret', { size: 'sm', kind: 'ghost', attrs: 'data-whrotate' })
            + UI.btn(sel.state === 'active' ? 'Disable' : 'Enable', { size: 'sm', kind: 'ghost', attrs: 'data-whtoggle' }) + UI.btn('Delete', { size: 'sm', kind: 'danger', attrs: 'data-whdel' }) })
        + '<div class="hstack"><span class="eyebrow grow">Delivery log</span>' + UI.btn('Refresh', { size: 'xs', kind: 'ghost', icon: 'refresh', attrs: 'data-whrefresh' }) + '</div>'
        + (!dl ? UI.notice('Loading…', 'info') : dl.error ? UI.problem('Deliveries could not be loaded', dl.error.message, dl.error.problem && dl.error.problem.trace_id)
          : UI.table(['Event', 'State', 'Attempts', 'Answer', 'Next attempt', 'Created', ''], dl.deliveries.map((d) => [esc(d.event) + (d.replayOf ? ' <span class="muted">replay</span>' : ''), UI.pill(d.state, WH_TONE[d.state] || ''), esc(d.attempts), esc(d.statusCode != null ? d.statusCode : '') + (d.error ? ' <span class="muted">' + esc(d.error) + '</span>' : ''), esc(d.state === 'pending' ? whWhen(d.nextAttemptAt) : ''), esc(whWhen(d.createdAt)), UI.btn('Replay', { size: 'xs', kind: 'ghost', attrs: 'data-whreplay="' + esc(d.id) + '"' })]), { minWidth: '720px', emptyTitle: 'No deliveries yet', emptyText: 'Send a test, or wait for a subscribed event.' })
            + (dl.withheld ? '<div class="muted" style="font-size:12px">' + esc(dl.withheld) + ' deliveries above your clearance are not listed.</div>' : ''));
    }
    return h;
  }
  function hostsHtml(st) {
    const ig = st.integ || {};
    if (!ig.loaded) return UI.notice('Loading…', 'info');
    if (ig.error) return UI.problem('The allow-list could not be loaded', ig.error.message, ig.error.problem && ig.error.problem.trace_id);
    const x = ig.hosts;
    const op = (l) => (l.length ? '<span class="mono">' + esc(l.join(', ')) + '</span>' : 'none: internal addresses only');
    return UI.notice('Workflow HTTP steps and webhooks only reach internal addresses, and link-local addresses never. When this list has entries, a host must also be on it: a hostname, <span class="mono">*.domain</span>, an address or a CIDR network (every address the name resolves to must be inside). An empty list adds no restriction.', 'info')
      + UI.field('Allowed hosts, one per line', UI.textarea((x.hosts || []).join('\n'), { rows: 8, attrs: 'data-hostlist spellcheck="false"', placeholder: 'hooks.corp.internal\n*.svc.cluster.local\n10.20.0.0/16' }), x.updatedAt ? 'Changed ' + esc(whWhen(x.updatedAt)) + '.' : 'Not set.')
      + '<div class="hstack">' + UI.btn('Save allow-list', { kind: 'primary', attrs: 'data-hostsave' }) + '</div>'
      + UI.panel('Operator settings', UI.kv([['Webhooks may also reach', op(x.operator.webhooks)], ['Workflow HTTP steps are limited to', x.operator.workflows.length ? '<span class="mono">' + esc(x.operator.workflows.join(', ')) + '</span>' : 'any internal host']], 1));
  }
  function webhookModal(st, ctx, existing, reload) {
    const ig = st.integ;
    const groups = ig.hooks.events;
    const chosen = existing ? existing.events.slice() : ['job.*'];
    const custom = chosen.filter((e) => !groups.some((g) => g.pattern === e));
    const labels = ['public', 'internal', 'confidential', 'restricted'].filter((l) => ['public', 'internal', 'confidential', 'restricted'].indexOf(l) <= ['public', 'internal', 'confidential', 'restricted'].indexOf(App.me.user.clearance));
    ctx.modal({
      title: existing ? 'Edit webhook' : 'New webhook', cls: 'wide',
      body: '<div class="formgrid">' + UI.field('Name', UI.input(existing ? existing.name : '', { attrs: 'data-whname maxlength="100"' })) + UI.field('Endpoint URL', UI.input(existing ? existing.url : '', { attrs: 'data-whurl maxlength="2000"', placeholder: 'https://hooks.corp.internal/exprsn' }), 'Checked now and at every delivery against the internal-address rules and this tenant\'s allowed hosts.')
        + UI.field('Carry events up to', UI.select(labels, existing ? existing.maxLabel : 'internal', 'data-whlabel'), 'Events labelled above this are not sent.') + '</div>'
        + '<div class="field" role="group" aria-label="Events"><span class="fl">Events</span><div class="tn-pick">' + groups.map((g) => '<label class="tn-pickrow"><input type="checkbox" data-whev value="' + esc(g.pattern) + '"' + (chosen.indexOf(g.pattern) >= 0 ? ' checked' : '') + '><span class="mono">' + esc(g.pattern) + '</span><span class="muted" style="font-size:12px">' + esc(g.description) + '</span></label>').join('') + '</div></div>'
        + UI.field('Other events, comma separated', UI.input(custom.join(', '), { attrs: 'data-whcustom', placeholder: 'prompt.published, tenant.hosts.updated' }), 'Any audit action name, or a prefix ending in .*')
        + '<div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(existing ? 'Save webhook' : 'Create webhook', { kind: 'primary', attrs: 'data-whsave' }),
      onMount(m) {
        m.querySelector('[data-whsave]').addEventListener('click', async (e) => {
          const events = Array.prototype.slice.call(m.querySelectorAll('[data-whev]:checked')).map((i) => i.value).concat(m.querySelector('[data-whcustom]').value.split(',').map((x) => x.trim()).filter(Boolean));
          const body = { name: m.querySelector('[data-whname]').value.trim(), url: m.querySelector('[data-whurl]').value.trim(), events, maxLabel: m.querySelector('[data-whlabel]').value };
          m.querySelector('[data-err]').innerHTML = '';
          if (!body.name || !body.url || !events.length) { m.querySelector('[data-err]').innerHTML = UI.notice('A name, an endpoint and at least one event are needed.', 'warn'); return; }
          e.target.disabled = true;
          try {
            const r = existing ? await App.patch('/api/admin/webhooks/' + encodeURIComponent(existing.id), body) : await App.post('/api/admin/webhooks', body);
            App.closeOverlay(); ig.sel = r.id; reload();
            if (r.secret) secretModal(ctx, r.name, r.secret); else ctx.toast('Webhook saved. Audit entry written.', 'ok');
          } catch (err) { e.target.disabled = false; const p = err.problem || {}; m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(p.detail || err.message) + '</b>', 'danger'); }
        });
      }
    });
  }
  function secretModal(ctx, name, secret) {
    ctx.modal({
      title: 'Signing secret for ' + esc(name),
      body: UI.notice('<b>Copy the secret now; it is not shown again.</b> Your endpoint uses it to verify <span class="mono">X-Exprsn-Signature</span>. Rotate it to get a new one.', 'warn') + UI.code(secret),
      actions: UI.btn('Copy', { attrs: 'data-cpsecret' }) + UI.btn('Done', { kind: 'primary', attrs: 'data-close' }),
      onMount(m) { m.querySelector('[data-cpsecret]').addEventListener('click', () => { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(secret).then(() => ctx.toast('Secret copied.'), () => ctx.toast('The browser refused clipboard access.', 'warn')); }); }
    });
  }
  function integWire(st, ctx) {
    const ig = st.integ || {};
    const reload = () => { ig.loaded = false; ig.deliveries = {}; ctx.rerender(); };
    const sel = () => ig.hooks && ig.hooks.webhooks.find((w) => w.id === ig.sel);
    const wUrl = () => '/api/admin/webhooks/' + encodeURIComponent(ig.sel);
    ctx.on('click', '[data-ttab]', (e, t) => { st.ttab = t.dataset.ttab; ctx.rerender(); });
    ctx.on('click', '[data-whsel]', (e, t) => { ig.sel = t.dataset.whsel; ctx.rerender(); });
    ctx.on('click', '[data-whnew]', () => webhookModal(st, ctx, null, reload));
    ctx.on('click', '[data-whedit]', () => { const w = sel(); if (w) webhookModal(st, ctx, w, reload); });
    ctx.on('click', '[data-whrefresh]', reload);
    ctx.on('click', '[data-whtest]', async () => {
      try { await App.post(wUrl() + '/test', {}); ctx.toast('Test delivery queued. It shows in the delivery log when it has run.', 'ok'); setTimeout(() => { if (App.state.route === 'tenants' && !document.getElementById('overlay')) reload(); }, 1500); } catch (err) { App.fail(err, 'Could not send a test'); }
    });
    ctx.on('click', '[data-whreplay]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'Replay this delivery?', body: 'The same body is sent again as a new delivery, with a fresh timestamp and signature. Receivers should treat the event id as the idempotency key.', ok: 'Replay' });
      if (!ok) return;
      try { await App.post(wUrl() + '/deliveries/' + encodeURIComponent(t.dataset.whreplay) + '/replay', {}); ctx.toast('Replay queued. Audit entry written.', 'ok'); if (ig.deliveries) delete ig.deliveries[ig.sel]; ctx.rerender(); } catch (err) { App.fail(err, 'Could not replay'); }
    });
    ctx.on('click', '[data-whrotate]', async () => {
      const w = sel(); if (!w) return;
      const ok = await ctx.confirm({ title: 'Rotate the signing secret?', tone: 'danger', body: 'Deliveries from now on are signed with the new secret. Update the receiver before the next event, or it will refuse them.', ok: 'Rotate secret' });
      if (!ok) return;
      try { const r = await App.post(wUrl() + '/secret', {}); secretModal(ctx, w.name, r.secret); } catch (err) { App.fail(err, 'Could not rotate the secret'); }
    });
    ctx.on('click', '[data-whtoggle]', async () => {
      const w = sel(); if (!w) return;
      const to = w.state === 'active' ? 'disabled' : 'active';
      const ok = await ctx.confirm({ title: (to === 'active' ? 'Enable ' : 'Disable ') + w.name + '?', body: to === 'active' ? 'Deliveries resume and the breaker starts closed.' : 'New events are not queued for it, and pending deliveries are closed as failed when they come up.', ok: to === 'active' ? 'Enable' : 'Disable' });
      if (!ok) return;
      try { await App.patch(wUrl(), { state: to }); ctx.toast(to === 'active' ? 'Enabled.' : 'Disabled.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not change the webhook'); }
    });
    ctx.on('click', '[data-whdel]', async () => {
      const w = sel(); if (!w) return;
      const ok = await ctx.confirm({ title: 'Delete ' + w.name + '?', tone: 'danger', body: 'The webhook and its delivery log are deleted. This cannot be undone.', kv: [['Endpoint', '<span class="mono">' + esc(w.url) + '</span>']], ok: 'Delete' });
      if (!ok) return;
      try { await App.del(wUrl()); ig.sel = null; ctx.toast('Webhook deleted. Audit entry written.', 'ok'); reload(); } catch (err) { App.fail(err, 'Could not delete'); }
    });
    ctx.on('click', '[data-hostsave]', async () => {
      const ta = ctx.$('[data-hostlist]'); if (!ta) return;
      const hosts = ta.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      const ok = await ctx.confirm({ title: 'Save the allowed hosts?', body: hosts.length ? 'Workflow HTTP steps and webhooks may then only reach these hosts, within the internal-address rules.' : 'An empty list removes this tenant\'s restriction; the internal-address rules still apply.', kv: [['Entries', esc(String(hosts.length))]], ok: 'Save' });
      if (!ok) return;
      try { const r = await App.api('PUT', '/api/admin/integrations/hosts', { hosts }); ig.hosts = Object.assign({}, ig.hosts, r); ctx.toast('Allowed hosts saved. Audit entry written.', 'ok'); ctx.rerender(); } catch (err) { App.fail(err, 'Could not save the allow-list'); }
    });
  }

  App.register({
    id: 'tenants', title: 'Tenants', section: 'admin', live: true,
    summary: 'Tenants, workspaces, directory group mappings, members, sessions, quotas',
    crumb(st) {
      const n = st.tenants ? findNode(st) : null;
      if (!n) return ['Admin', 'Tenants'];
      return n.type === 'tenant' ? ['Admin', 'Tenants', n.tenant.name] : ['Admin', 'Tenants', n.tenant.name, n.ws.name];
    },
    commands: [
      { label: 'Add a group mapping', sub: 'Tenants', run(app) { const st = app.stateFor('tenants'); const w = st.tenants ? pickWorkspace(st) : null; if (w) st.node = 'w:' + w.id; st.tab = 'mappings'; st.openMapping = true; app.render(); } },
      { label: 'Create a workspace', sub: 'Tenants', run(app) { app.stateFor('tenants').openNewWs = true; app.render(); } }
    ],
    states: [
      { title: 'Offboarding', tone: 'danger', text: 'Three explicit steps: destroy the tenant key, revoke every session and API key, run the deletion job for derived data. Requires typing the tenant name.',
        apply(ctx) {
          const st = ctx.state; const t = (st.tenants || []).find((x) => x.id !== ownTid() && x.state === 'active');
          if (!isSys() || !t) { ctx.toast('Offboarding needs a system admin and an active tenant other than your own.', 'warn', 6000); return; }
          st.node = 't:' + t.id; st.openOffboard = true; ctx.rerender();
        } },
      { title: 'Disabled by sync', tone: 'warn', text: 'The user was removed from the directory. Sessions and refresh tokens were revoked within one sync interval.',
        apply(ctx) {
          const st = ctx.state; const w = pickWorkspace(st); if (w) st.node = 'w:' + w.id;
          st.tab = 'members'; st.showDisabled = true; ctx.rerender();
        } },
      { title: 'Thirteen roles', tone: 'neutral', text: 'Role picker lists all built-in roles with a one-line description of what each can change.',
        apply(ctx) { const st = ctx.state; const w = pickWorkspace(st); if (w) st.node = 'w:' + w.id; st.tab = 'mappings'; st.openMapping = true; ctx.rerender(); } },
      { title: 'Quota reached', tone: 'warn', text: 'Requests return 429 with a reset time. The console shows who can raise the limit.',
        apply(ctx) {
          const st = ctx.state; const w = pickWorkspace(st); if (w) st.node = 'w:' + w.id;
          st.tab = 'quotas'; st.checkQuota = true; ctx.rerender();
        } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'mappings';
      if (ctx.params.workspace && !st.paramsUsed) { st.node = 'w:' + ctx.params.workspace; st.paramsUsed = true; }
      if (ctx.params.tab) st.tab = ctx.params.tab;
      if (ctx.params.ttab && st.ttabParam !== ctx.params.ttab) { st.ttabParam = ctx.params.ttab; st.ttab = ctx.params.ttab; if (ownTid()) st.node = 't:' + ownTid(); }

      // ---------- loading ----------
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        const own = App.can('identity:manage'), users = App.can('users:manage');
        Promise.all([
          App.get('/api/admin/tenants'),
          own ? App.get('/api/admin/group-mappings') : null,
          own ? App.get('/api/admin/identity-providers') : null,
          users ? App.get('/api/admin/roles') : null,
          users ? App.get('/api/admin/sessions') : null
        ])
          .then(([tenants, mappings, providers, roles, sessions]) => { Object.assign(st, { tenants, mappings, providers, roles, sessions, loaded: true, loadError: null, nodeData: null, nodeKey: null }); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; if (App.state.route === 'tenants') ctx.rerender(); });
      };
      if (!st.loaded && !st.loadError) load();
      const reload = () => { st.loaded = false; st.loadError = null; st.evalKey = null; ctx.rerender(); };
      const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) ctx.toast(okMsg, 'ok'); reload(); return r; } catch (err) { App.fail(err); return null; } };

      const node = st.loaded ? findNode(st) : null;
      if (node) st.node = node.type === 'tenant' ? 't:' + node.tenant.id : 'w:' + node.ws.id;
      const tenant = node && node.tenant;
      const own = !!(tenant && tenant.id === ownTid());
      const canMap = own && App.can('identity:manage');
      const canUsers = own && App.can('users:manage');

      // Per-node data: members and quota for a workspace; quotas of every workspace for a tenant.
      const loadNode = () => {
        const key = st.node;
        st.nodeLoading = key;
        const done = (data) => { if (st.node === key) { st.nodeData = data; st.nodeKey = key; } };
        const p = node.type === 'workspace'
          ? Promise.all([App.get(wUrl(tenant.id, node.ws.id) + '/members'), App.get(wUrl(tenant.id, node.ws.id) + '/quota')]).then(([members, quota]) => done({ members, quota }))
          : Promise.all([Promise.all(tenant.workspaces.map((w) => App.get(wUrl(tenant.id, w.id) + '/quota').then((q) => [w.id, q]))), App.get(tUrl(tenant.id) + '/retention').catch(() => null)]).then(([list, retention]) => { const quotas = {}; list.forEach((x) => { quotas[x[0]] = x[1]; }); done({ quotas, retention }); });
        p.catch((err) => { if (st.node === key) { st.nodeData = { error: err }; st.nodeKey = key; } })
          .finally(() => { if (st.nodeLoading === key) st.nodeLoading = null; if (App.state.route === 'tenants') ctx.rerender(); });
      };
      if (node && st.nodeKey !== st.node && st.nodeLoading !== st.node) loadNode();
      const nd = node && st.nodeKey === st.node ? st.nodeData : null;

      const roleName = (id) => ((st.roles || []).find((r) => r.id === id) || { name: id }).name;
      const storeName = (id) => (id ? ((st.providers || []).find((p) => p.id === id) || { name: 'removed store' }).name : 'Any store');
      const wsMappings = (wid) => (st.mappings || []).filter((m) => m.workspace_id === wid);

      // ---------- left pane ----------
      const tenants = st.tenants || [];
      const left = '<div class="leftpane"><div class="eyebrow" style="padding:4px 8px">Tenants and workspaces</div>'
        + tenants.map((t) => UI.listItem(esc(t.name) + (t.state !== 'active' ? ' ' + UI.pill(tState(t), t.state === 'disabled' && tState(t) === 'disabled' ? 'warn' : 'danger') : ''), 'tenant' + (t.directoryDn ? ', ' + esc(t.directoryDn) : ''), { active: st.node === 't:' + t.id, attrs: 'data-node="t:' + esc(t.id) + '"' })
          + t.workspaces.map((w) => UI.listItem(esc(w.name) + (w.state !== 'active' ? ' ' + UI.pill(w.state, 'outline') : ''), 'workspace, ' + num(w.members) + (w.members === 1 ? ' member' : ' members'), { active: st.node === 'w:' + w.id, attrs: 'data-node="w:' + esc(w.id) + '" style="padding-left:22px"' })).join('')).join('')
        + '<div class="divider"></div>'
        + (tenants.some((t) => t.state === 'active') ? UI.btn('New workspace', { size: 'sm', icon: 'plus', cls: 'block', attrs: 'data-newws' }) : '')
        + (isSys() ? UI.btn('New tenant', { size: 'sm', kind: 'ghost', icon: 'plus', cls: 'block', attrs: 'data-newtenant' }) : '')
        + '</div>';

      // ---------- effective permission ----------
      const effPanel = (members) => {
        if (!own) return UI.panel(null, '<span class="eyebrow">Effective permission</span>' + UI.notice('The effective-permission check evaluates users of your own tenant.', 'info'));
        const subjects = (members || []).filter((m) => m.state === 'active' || m.state === 'disabled');
        if (!subjects.length) return UI.panel(null, '<span class="eyebrow">Effective permission</span><div class="muted" style="font-size:12px">Add a member to check what they may do.</div>');
        if (!subjects.some((m) => m.id === st.subject)) st.subject = subjects[0].id;
        const catalogue = {};
        (App.me.permissions || []).concat(EXTRA_ACTIONS).concat((st.roles || []).reduce((a, r) => a.concat(r.permissions || []), [])).forEach((p) => { if (/^[a-z]+:[a-z]+$/.test(p)) catalogue[p] = true; });
        const actions = Object.keys(catalogue).sort();
        if (!catalogue[st.action]) st.action = catalogue['tools:invoke'] ? 'tools:invoke' : actions[0];
        const label = st.evalLabel == null ? (node.ws ? node.ws.label : '') : st.evalLabel;
        const zone = st.evalZone || '';
        const key = [st.subject, st.action, label, zone].join('|');
        if (st.evalKey !== key && !st.evalBusy) {
          st.evalBusy = true;
          App.post('/api/admin/authz/evaluate', Object.assign({ userId: st.subject, action: st.action }, label ? { label } : {}, zone ? { zoneCeiling: zone } : {}))
            .then((r) => { st.evalResult = r; st.evalError = null; })
            .catch((err) => { st.evalResult = null; st.evalError = err; })
            .finally(() => { st.evalKey = key; st.evalBusy = false; if (App.state.route === 'tenants') ctx.rerender(); });
        }
        const r = st.evalKey === key ? st.evalResult : null;
        let out;
        if (st.evalKey === key && st.evalError) out = UI.notice('<b>Could not evaluate.</b> ' + esc(st.evalError.message), 'danger');
        else if (!r) out = '<div class="muted" style="font-size:12px">Evaluating…</div>';
        else {
          const allowed = r.decision.allow;
          const pills = r.steps.map((s) => UI.pill(STEP_NAME[s.step] || s.step, s.ok ? 'ok' : 'danger') + ' <span class="fg2">' + esc(s.detail) + '</span>');
          out = '<div class="hstack wrap gap6" style="font-size:12px">' + (pills.length ? pills.join('<span class="muted">then</span>') + '<span class="muted">=</span>' : '') + '<b style="color:var(--' + (allowed ? 'ok' : 'danger') + '-fg)">' + (allowed ? 'allowed' : 'denied') + '</b></div>'
            + '<div class="fg2" style="font-size:12px">' + (allowed ? esc(r.decision.reason || 'Allowed') + '. Effective permission is role permissions narrowed by credential scopes, then a check on tenant, clearance and zone. Policy ' + esc(r.decision.policy) + '.'
              : 'Denied at the ' + esc(STEP_NAME[r.decision.step] || r.decision.step || 'first failing') + ' step: ' + esc(r.decision.reason) + '. The request gets 403 with a problem detail naming the step, and the decision lands in the audit chain.') + '</div>';
        }
        return UI.panel(null, '<div class="hstack wrap"><span class="eyebrow">Effective permission</span>'
          + UI.select(subjects.map((m) => ({ value: m.id, label: m.displayName + ' (' + m.username + ')' })), st.subject, 'data-subject aria-label="User" style="width:200px"')
          + UI.select(actions, st.action, 'data-action aria-label="Action" style="width:190px"')
          + UI.select([{ value: '', label: 'No data label' }].concat(LABELS.map((l) => ({ value: l, label: 'data ' + l }))), label, 'data-evlabel aria-label="Data label" style="width:150px"')
          + UI.select([{ value: '', label: 'No zone ceiling' }].concat(LABELS.map((l) => ({ value: l, label: 'zone ' + l }))), zone, 'data-evzone aria-label="Zone ceiling" style="width:150px"') + '</div>' + out);
      };

      const sessionsTable = (list) => UI.table(['User', 'Signed in', 'Method', 'Address', 'Last activity', ''], list.map((s) => ['<b>' + esc(s.user.displayName) + '</b> <span class="mono muted">' + esc(s.user.username) + '</span>', esc(when(s.createdAt)), esc(s.method), '<span class="mono">' + esc(s.ip || '') + '</span>', esc(when(s.lastSeenAt)), UI.btn('Revoke', { size: 'xs', attrs: 'data-revoke="' + esc(s.id) + '"' })]), { clickable: false, minWidth: '560px', emptyTitle: 'No active sessions', emptyText: 'Sessions appear when a member signs in with this workspace selected.' });

      // ---------- main ----------
      let head = '', body = '';
      if (st.loadError) body = UI.problem('Tenants could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id);
      else if (!st.loaded) body = UI.notice('Loading…', 'info');
      else if (!node) body = UI.empty('No tenants', 'There is no tenant you can manage.');
      else if (node.type === 'tenant') {
        const t = tenant, wss = t.workspaces;
        const sysOther = isSys() && !own;
        head = UI.pagehead(t.name, '<span class="mono">' + esc(t.slug) + '</span>. Every table is scoped to this tenant; conversation content is envelope-encrypted with its own key.',
          UI.btn('Refresh', { kind: 'ghost', size: 'sm', icon: 'refresh', attrs: 'data-reload' }) + UI.btn('Edit tenant', { kind: 'ghost', attrs: 'data-edittenant' })
          + (sysOther && t.state === 'active' ? UI.btn('Offboard tenant', { kind: 'danger', attrs: 'data-offboard' }) : '')
          + (t.state === 'active' ? UI.btn('New workspace', { kind: 'primary', icon: 'plus', attrs: 'data-newws' }) : ''));
        const qTokens = (w) => { const q = nd && nd.quotas && nd.quotas[w.id]; return q ? num(q.used.tokensToday) + (q.tokensPerDay != null ? ' of ' + num(q.tokensPerDay) : '') : (nd && nd.error ? 'unavailable' : '…'); };
        const hit = reachedLimits(t.quota);
        body = (t.state === 'offboarding' ? UI.notice('<b>Offboarding in progress.</b> The tenant key is destroyed, sessions and API keys are revoked, and the deletion job for derived data is queued. Sign-ins for this tenant are refused.', 'danger') : '')
          + (tState(t) === 'offboarded' ? UI.notice('<b>Offboarded.</b> The tenant key is destroyed and the deletion job for derived data has run. Sign-ins for this tenant are refused.', 'danger') : '')
          + (tState(t) === 'disabled' ? UI.notice('<b>This tenant is disabled.</b> Its sessions were revoked and its users cannot sign in.', 'warn', sysOther ? UI.btn('Enable tenant', { size: 'sm', attrs: 'data-tstate="active"' }) : '') : '')
          + (hit.length ? UI.notice('<b>Tenant quota reached.</b> ' + esc(hit.map((L) => num(t.quota.used[L.used]) + ' of ' + num(t.quota[L.key]) + ' ' + L.unit).join('; ')) + '. Requests in every workspace return 429 until the reset; a system admin can raise the limit.', 'warn', isSys() ? UI.btn('Raise limits', { size: 'sm', attrs: 'data-traise' }) : '') : '')
          + '<div class="grid2">' + UI.panel('Tenant', UI.kv([
            ['Directory base', t.directoryDn ? '<span class="mono">' + esc(t.directoryDn) + '</span>' : '<span class="muted">none</span>'],
            ['Data key', '<span class="mono">' + esc(t.key.name) + '</span>, ' + esc(t.key.kms) + (t.key.version != null ? ', version ' + esc(t.key.version) : '') + ' ' + UI.pill(t.key.state, t.key.state === 'active' ? 'ok' : t.key.state === 'destroyed' ? 'danger' : '')],
            ['State', UI.pill(tState(t), t.state === 'active' ? 'ok' : tState(t) === 'disabled' ? 'warn' : 'danger')],
            ['Sync', esc(syncSummary(t.lastSync))],
            ['Users', num(t.users)],
            ['Workspaces', num(wss.filter((w) => w.state === 'active').length) + (wss.some((w) => w.state !== 'active') ? ', ' + num(wss.filter((w) => w.state !== 'active').length) + ' archived' : '')]
          ], 2), { actions: (canMap && t.state === 'active' && (st.providers || []).some((p) => p.kind !== 'local' && p.enabled) ? UI.btn('Sync now', { size: 'sm', kind: 'ghost', icon: 'refresh', attrs: 'data-sync' }) : '') + (own && App.can('identity:manage') ? UI.btn('Open user stores', { size: 'sm', kind: 'ghost', attrs: 'data-go="directories"' }) : '') })
          + UI.panel('Quota, tenant total', LIMITS.map((L) => meterFor(t.quota, L)).join('') + '<div class="muted" style="font-size:12px">Workspace limits nest under the tenant limit. Raised by a system admin.</div>', { actions: isSys() ? UI.btn('Raise limits', { size: 'sm', kind: 'ghost', attrs: 'data-traise' }) : '' }) + '</div>'
          + retentionPanel(nd && nd.retention)
          + '<div class="eyebrow">Workspaces</div>' + UI.table(['Workspace', { label: 'Members', right: true }, 'Label ceiling', 'Visibility', { label: 'Mappings', right: true }, 'Tokens today'], wss.map((w) => ({ cells: ['<b>' + esc(w.name) + '</b>' + (w.state !== 'active' ? ' ' + UI.pill(w.state, 'outline') : ''), '<span class="num">' + num(w.members) + '</span>', UI.label(w.label, { sm: true }), w.visibility === 'tenant' ? 'whole tenant' : 'members only', own && st.mappings ? '<span class="num">' + num(wsMappings(w.id).length) + '</span>' : '<span class="muted">n/a</span>', esc(qTokens(w))], attrs: 'data-node="w:' + esc(w.id) + '"' })), { minWidth: '560px', emptyTitle: 'No workspaces', emptyText: 'Create one to give a directory group a place to work.' });
        // Sprint 13: the tenant's own integrations, as tabs beside the overview.
        const canHooks = own && App.can('webhooks:manage'), canHosts = own && App.can('tenant:manage');
        if (canHooks || canHosts) {
          if (!st.ttab || (st.ttab === 'webhooks' && !canHooks) || (st.ttab === 'hosts' && !canHosts)) st.ttab = 'overview';
          const ttabs = '<nav class="tabs" aria-label="Tenant sections">' + [['overview', 'Overview'], canHooks ? ['webhooks', 'Webhooks'] : null, canHosts ? ['hosts', 'Allowed hosts'] : null].filter(Boolean).map((x) => '<button type="button" data-ttab="' + x[0] + '" class="' + (st.ttab === x[0] ? 'active' : '') + '"' + (st.ttab === x[0] ? ' aria-current="true"' : '') + '>' + x[1] + '</button>').join('') + '</nav>';
          if (st.ttab !== 'overview') integLoad(st, ctx);
          body = ttabs + (st.ttab === 'webhooks' ? webhooksHtml(st, ctx) : st.ttab === 'hosts' ? hostsHtml(st) : body);
        }
      } else {
        const w = node.ws;
        const members = nd && nd.members ? nd.members : null;
        const q = nd && nd.quota;
        const maps = wsMappings(w.id);
        const sessions = canUsers ? (st.sessions || []).filter((s) => s.workspaceId === w.id) : [];
        const filtered = (members || []).filter((m) => !st.q || (m.displayName + ' ' + m.username + ' ' + m.roles.map(roleName).join(' ')).toLowerCase().indexOf(st.q.toLowerCase()) >= 0);
        head = UI.pagehead(w.name, esc(syncSummary(tenant.lastSync)) + '. ' + (w.visibility === 'tenant' ? 'Visible to the whole tenant' : 'Visible to members only') + ', label ceiling ' + esc(w.label) + '.',
          UI.btn('Refresh', { kind: 'ghost', size: 'sm', icon: 'refresh', attrs: 'data-reload' }) + UI.btn('Edit workspace', { attrs: 'data-editws' }) + (canMap && w.state === 'active' ? UI.btn('Add mapping', { kind: 'primary', attrs: 'data-newmapping' }) : ''));
        const tabs = UI.tabs([{ id: 'members', label: 'Members', count: w.members }, { id: 'mappings', label: 'Group mappings', count: own && st.mappings ? maps.length : undefined }, { id: 'sessions', label: 'Sessions', count: canUsers ? sessions.length : undefined }, { id: 'quotas', label: 'Quotas' }], st.tab);
        const archived = w.state === 'archived' ? UI.notice('<b>This workspace is archived.</b> Nobody can select it and its data is read-only.', 'warn', UI.btn('Restore', { size: 'sm', attrs: 'data-wsstate="active"' })) : '';
        const nodeProblem = nd && nd.error ? UI.problem('Workspace details could not be loaded', nd.error.message, nd.error.problem && nd.error.problem.trace_id) : '';
        const waiting = !nd ? UI.notice('Loading…', 'info') : '';

        if (st.tab === 'members') {
          const disabled = (members || []).filter((m) => m.state !== 'active');
          const bySync = syncDisabled(tenant.lastSync);
          body = tabs + archived + (nodeProblem || waiting)
            + (members ? '<div class="hstack wrap">' + UI.search('Search members', 'data-q', st.q || '') + '<span class="muted grow" style="font-size:12px">Provisioned just in time on first sign-in from a mapped group, or added directly.</span>' + (canUsers && w.state === 'active' ? UI.btn('Add member', { size: 'sm', icon: 'plus', attrs: 'data-addmember' }) : '') + '</div>'
              + (st.showDisabled ? (disabled.length ? UI.notice('<b>Disabled by sync.</b> ' + esc(disabled.map((m) => m.username).join(', ')) + (disabled.length === 1 ? ' is' : ' are') + ' disabled. ' + (bySync.length ? 'The last sync disabled ' + esc(bySync.map((d) => d.username + ' (' + d.reason + ', ' + d.sessionsRevoked + ' sessions revoked)').join(', ')) + '. ' : '') + 'Sessions and refresh tokens end with the account.', 'warn', App.can('audit:read') ? UI.btn('Open audit', { size: 'sm', attrs: 'data-go="usage-audit"' }) : '')
                : UI.notice('No member of ' + esc(w.name) + ' is disabled. ' + esc(syncSummary(tenant.lastSync)) + '.', 'info')) : '')
              + UI.table(['Name', 'Username', 'Roles', 'Clearance', 'Membership', 'State', 'Last seen', ''], filtered.map((m) => ({ cells: ['<b>' + esc(m.displayName) + '</b>', '<span class="mono">' + esc(m.username) + '</span>', esc(m.roles.map(roleName).join(', ') || 'none'), UI.label(m.clearance, { sm: true }), esc(m.sources.map((s) => (s === 'direct' ? 'added directly' : 'group mapping')).join(', ')), UI.pill(m.state, m.state === 'active' ? 'ok' : 'warn'), esc(when(m.lastLoginAt)), canUsers && m.sources.indexOf('direct') >= 0 ? UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-rmmember="' + esc(m.id) + '"' }) : ''], attrs: 'data-member="' + esc(m.id) + '"', selected: st.subject === m.id })), { minWidth: '800px', emptyTitle: members.length ? 'No members match' : 'No members yet', emptyText: 'Members appear here after their first sign-in from a mapped group.' })
              + effPanel(members) : '');
        } else if (st.tab === 'mappings') {
          const statRow = q ? '<div class="grid3">' + LIMITS.map((L) => UI.stat(num(q.used[L.used]), L.label, q[L.key] == null ? 'no limit' : 'of ' + num(q[L.key]))).join('') + '</div>' : '';
          body = tabs + archived
            + (!own ? UI.notice('Group mappings are managed from inside the tenant. Sign in to ' + esc(tenant.name) + ' as its tenant admin to change them.', 'info')
              : !App.can('identity:manage') ? UI.notice('Viewing group mappings needs the identity:manage permission.', 'info')
              : UI.table(['Directory group DN', 'Store', 'Role', 'Clearance', ''], maps.map((m) => ({ cells: ['<span class="mono">' + esc(m.group_name) + '</span>', esc(storeName(m.provider_id)), esc(roleName(m.role)), UI.label(m.clearance, { sm: true }), UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-editmap="' + esc(m.id) + '"' })], attrs: 'data-map="' + esc(m.id) + '"', selected: st.map === m.id })), { minWidth: '640px', emptyTitle: 'No group mappings', emptyText: 'Map a directory group to a role and clearance to give its members this workspace.' })
                + '<div class="muted" style="font-size:12px">A member of several groups gets the union of roles and the highest clearance. Changes apply at each member\'s next sign-in or sync; removing a user from every mapped group disables them at the next sync.</div>')
            + (nodeProblem || waiting) + (members ? effPanel(members) : '')
            + (canUsers ? '<div class="eyebrow">Active sessions</div>' + sessionsTable(sessions) : '')
            + statRow;
        } else if (st.tab === 'sessions') {
          body = tabs + (canUsers ? '<div class="eyebrow">Active sessions</div>' + sessionsTable(sessions) + '<div class="muted" style="font-size:12px">Revoking a session also revokes its refresh tokens and closes its live connection. The user is signed out on their next request.</div>'
            : UI.notice(own ? 'Viewing sessions needs the users:manage permission.' : 'Sessions are managed from inside the tenant.', 'info'));
        } else {
          const hit = reachedLimits(q);
          const tq = tenant.quota;
          const resets = q ? [['Reset', 'daily ' + esc(when(q.resets.daily)) + ', monthly ' + esc(when(q.resets.monthly))]] : [];
          body = tabs + archived + (nodeProblem || waiting)
            + (q ? (hit.length ? UI.notice('<b>Quota reached.</b> ' + esc(w.name) + ' used ' + esc(hit.map((L) => num(q.used[L.used]) + ' of ' + num(q[L.key]) + ' ' + L.unit).join('; ')) + '. Requests return 429 with Retry-After until ' + esc(when(hit[0].reset === 'daily' ? q.resets.daily : q.resets.monthly)) + '. A tenant admin can raise the limit.', 'warn', UI.btn('Raise limit', { size: 'sm', attrs: 'data-raise' }))
                : st.checkQuota ? UI.notice('No limit is reached in ' + esc(w.name) + '. When one is, requests return 429 until the reset and this notice names who can raise it.', 'info') : '')
              + '<div class="grid2">' + UI.panel('Workspace limits', LIMITS.map((L) => meterFor(q, L)).join('') + '<div class="muted" style="font-size:12px">Raised by: tenant admin. Nested under the ' + esc(tenant.name) + ' tenant limit (' + esc(LIMITS.map((L) => L.field.toLowerCase() + ' ' + limitText(tq[L.key])).join(', ')) + ').' + (q.updatedAt ? ' Changed ' + esc(when(q.updatedAt)) + '.' : '') + '</div>', { actions: UI.btn('Edit limits', { size: 'sm', kind: 'ghost', attrs: 'data-raise' }) })
              + UI.panel('Over quota', '<div class="fg2">Interactive requests return <span class="mono">429</span> with <span class="mono">Retry-After</span> and a problem detail that names the limit.</div>' + UI.kv(resets.concat([['Who can raise', 'tenant admin for the workspace, system admin for the tenant'], ['Metering', 'per tenant, workspace, user and model']]), 1) + (App.can('audit:read') ? '<div>' + UI.btn('Open usage', { size: 'sm', attrs: 'data-go="usage-audit"' }) + '</div>' : '')) + '</div>' : '');
        }
      }

      root.innerHTML = left + '<div class="page">' + head + body
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      // ---------- modals ----------
      const errorBox = (m, err) => { const p = err.problem || {}; m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(p.detail || err.message) + '</b>' + (p.trace_id ? '<div class="mono muted" style="font-size:11px">trace ' + esc(p.trace_id) + '</div>' : ''), 'danger'); };
      const submit = (m, sel, fn, okMsg) => {
        const b = m.querySelector(sel);
        b.addEventListener('click', async () => {
          m.querySelector('[data-err]').innerHTML = '';
          let r; try { r = await fn(); } catch (err) { errorBox(m, err); return; }
          if (r === false) return;
          App.closeOverlay(); ctx.toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok', 5000); reload();
        });
      };
      const readLimit = (v, name) => {
        const s = String(v || '').replace(/[\s,]/g, '');
        if (!s) return null;
        if (!/^\d+$/.test(s)) throw new App.ApiError({ detail: name + ' must be a whole number, or empty for no limit.' });
        return Number(s);
      };
      const roleOptions = (current) => (st.roles || []).map((r) => '<label class="tn-role"><input type="radio" name="tn-role" value="' + esc(r.id) + '"' + (current === r.id ? ' checked' : '') + '><span><b>' + esc(r.name) + '</b><span class="muted"> ' + esc(r.description) + '</span></span></label>').join('');

      function mappingModal(existing) {
        if (!node || node.type !== 'workspace') { ctx.toast('Select a workspace first.', 'warn'); return; }
        if (!canMap) { ctx.toast(own ? 'Group mappings need the identity:manage permission.' : 'Group mappings are managed from inside the tenant.', 'warn', 6000); return; }
        const w = node.ws;
        const stores = [{ value: '', label: 'Any store' }].concat((st.providers || []).filter((p) => p.kind !== 'local').map((p) => ({ value: p.id, label: p.name })));
        ctx.modal({
          title: existing ? 'Edit mapping' : 'Add mapping, ' + esc(w.name), cls: 'wide',
          body: '<div class="formgrid">' + UI.field('Directory group DN', UI.input(existing ? existing.group_name : '', { attrs: 'data-mdn maxlength="512"', placeholder: 'cn=finance-ops,ou=groups,' + (tenant.directoryDn || 'dc=example,dc=internal') }), tenant.directoryDn ? 'Resolved under ' + esc(tenant.directoryDn) + ' at sign-in and at the next sync.' : 'Matched against the groups the store returns at sign-in and sync.')
            + UI.field('Clearance ceiling', UI.select(grantable(), existing ? existing.clearance : (RANK[w.label] <= RANK[myClearance()] ? w.label : myClearance()), 'data-mclr'), 'Members can read data up to this label.')
            + UI.field('Store', UI.select(stores, existing ? existing.provider_id || '' : '', 'data-mstore' + (existing ? ' disabled' : ''))) + '</div>'
            + (st.roles ? '<div class="field"><span class="fl">Role, ' + (st.roles.length === 13 ? 'thirteen' : num(st.roles.length)) + ' built in</span><div class="tn-roles">' + roleOptions(existing ? existing.role : 'member') + '</div></div>' : UI.notice('The role list needs the users:manage permission; the mapping grants member.', 'info'))
            + '<div data-err></div>',
          actions: (existing ? UI.btn('Remove mapping', { kind: 'danger', attrs: 'data-mdel' }) : '') + UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(existing ? 'Save mapping' : 'Add mapping', { kind: 'primary', attrs: 'data-msave' }),
          onMount(m) {
            submit(m, '[data-msave]', () => {
              const group = m.querySelector('[data-mdn]').value.trim();
              if (!group) throw new App.ApiError({ detail: 'Enter a group DN.' });
              const picked = m.querySelector('input[name=tn-role]:checked');
              const body = { group, role: picked ? picked.value : 'member', clearance: m.querySelector('[data-mclr]').value };
              if (existing) return App.patch('/api/admin/group-mappings/' + enc(existing.id), body);
              st.tab = 'mappings';
              return App.post('/api/admin/group-mappings', Object.assign(body, { workspaceId: w.id, providerId: m.querySelector('[data-mstore]').value || null }));
            }, (r) => (existing ? 'Mapping updated. It applies at each member\'s next sign-in or sync.' : 'Mapping added: ' + esc(roleName(r.role)) + '. Members are provisioned at their next sign-in.'));
            const del = m.querySelector('[data-mdel]');
            if (del) del.addEventListener('click', async () => {
              const ok = await ctx.confirm({ title: 'Remove this mapping?', tone: 'danger', kv: [['Group', '<span class="mono">' + esc(existing.group_name) + '</span>'], ['Role', esc(roleName(existing.role))]], body: '<div class="fg2">Members lose the role and this workspace at their next sign-in or sync. Users left with no mapped group are refused.</div>', ok: 'Remove mapping' });
              if (ok) act(() => App.del('/api/admin/group-mappings/' + enc(existing.id)), 'Mapping removed. Audit entry written.');
            });
          }
        });
      }

      function offboardModal() {
        const t = tenant;
        if (!t || !isSys() || own) return;
        ctx.modal({
          title: 'Offboard ' + esc(t.name) + ' ' + UI.pill('destructive', 'danger'),
          body: UI.timeline([
            { title: '1. Destroy the tenant key', text: 'Destroying ' + esc(t.key.name) + ' in ' + esc(t.key.kms) + ' crypto-shreds every sealed conversation body and secret.', tone: 'danger' },
            { title: '2. Revoke sessions and API keys', text: 'Every session and API key in the tenant ends at once; live connections close.', tone: 'danger' },
            { title: '3. Run the deletion job for derived data', text: 'Embeddings, caches, memories and search indexes are removed by a worker job; progress is visible in Runs.', tone: '' }
          ])
            + UI.notice('Export the tenant\'s data before you start. The key cannot be recovered.', 'warn')
            + UI.field('Type the tenant name to continue', UI.input('', { attrs: 'data-obname autocomplete="off" placeholder="' + esc(t.name) + '"' })) + '<div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Destroy key and start deletion', { kind: 'danger', attrs: 'data-obgo disabled' }),
          onMount(m) {
            const i = m.querySelector('[data-obname]'), b = m.querySelector('[data-obgo]');
            i.addEventListener('input', () => { if (i.value === t.name) b.removeAttribute('disabled'); else b.setAttribute('disabled', ''); });
            submit(m, '[data-obgo]', () => App.post(tUrl(t.id) + '/offboard', { confirm: i.value }), (r) => '<b>' + esc(t.name) + '</b> key destroyed (' + num(r.keyVersionsDestroyed) + ' versions), ' + num(r.sessionsRevoked) + ' sessions and ' + num(r.apiKeysRevoked) + ' API keys revoked. Deletion job queued; audit event written.');
            i.focus();
          }
        });
      }

      function newWorkspaceModal() {
        const active = tenants.filter((t) => t.state === 'active');
        if (!active.length) { ctx.toast('There is no active tenant to add a workspace to.', 'warn'); return; }
        const start = tenant && tenant.state === 'active' ? tenant.id : active[0].id;
        const mapHint = () => 'Optional. Members of this group get the role below, with clearance up to the label ceiling. Only in your own tenant.';
        ctx.modal({
          title: 'New workspace', cls: 'wide',
          body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-wsname maxlength="200"', placeholder: 'Treasury' }))
            + UI.field('Tenant', UI.select(active.map((t) => ({ value: t.id, label: t.name })), start, 'data-wstenant' + (active.length === 1 ? ' disabled' : '')))
            + UI.field('Label ceiling', UI.select(grantable(), RANK.internal <= RANK[myClearance()] ? 'internal' : myClearance(), 'data-wslabel'), 'Up to your own clearance.')
            + UI.field('Visibility', UI.select([{ value: 'members', label: 'Members only' }, { value: 'tenant', label: 'Whole tenant' }], 'members', 'data-wsvis'))
            + UI.field('Description', UI.input('', { attrs: 'data-wsdesc maxlength="500"' }))
            + '<div data-wsmapwrap>' + UI.field('First group mapping', UI.input('', { attrs: 'data-wsgroup maxlength="512"', placeholder: 'cn=treasury,ou=groups,' + ((tenant && tenant.directoryDn) || 'dc=example,dc=internal') }), mapHint()) + '</div>'
            + (st.roles ? '<div data-wsrolewrap>' + UI.field('Role for the group', UI.select(st.roles.map((r) => ({ value: r.id, label: r.name })), 'member', 'data-wsrole')) + '</div>' : '') + '</div><div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create workspace', { kind: 'primary', attrs: 'data-wsgo' }),
          onMount(m) {
            const tSel = m.querySelector('[data-wstenant]');
            const sync = () => { const mine = tSel.value === ownTid() && App.can('identity:manage'); ['[data-wsmapwrap]', '[data-wsrolewrap]'].forEach((s) => { const el = m.querySelector(s); if (el) el.style.display = mine ? '' : 'none'; }); };
            tSel.addEventListener('change', sync); sync();
            submit(m, '[data-wsgo]', async () => {
              const tid = tSel.value;
              const body = { name: m.querySelector('[data-wsname]').value.trim(), labelCeiling: m.querySelector('[data-wslabel]').value, visibility: m.querySelector('[data-wsvis]').value, description: m.querySelector('[data-wsdesc]').value.trim() || null };
              if (!body.name) throw new App.ApiError({ detail: 'Enter a name.' });
              const group = m.querySelector('[data-wsgroup]').value.trim();
              if (group && tid === ownTid() && App.can('identity:manage')) { const r = m.querySelector('[data-wsrole]'); body.mapping = { group, role: r ? r.value : 'member', clearance: body.labelCeiling }; }
              const w = await App.post(tUrl(tid) + '/workspaces', body);
              st.node = 'w:' + w.id; st.tab = body.mapping ? 'mappings' : 'members';
              return w;
            }, (w) => 'Workspace ' + esc(w.name) + ' created. Members are provisioned at their first sign-in.');
            m.querySelector('[data-wsname]').focus();
          }
        });
      }

      function editWorkspaceModal() {
        const w = node.ws;
        ctx.modal({
          title: 'Edit ' + esc(w.name),
          body: '<div class="formgrid">' + UI.field('Name', UI.input(w.name, { attrs: 'data-ewname maxlength="200"' })) + UI.field('Label ceiling', UI.select(LABELS.map((l) => ({ value: l, label: l + (RANK[l] > RANK[myClearance()] ? ' (above your clearance)' : '') })), w.label, 'data-ewlabel'))
            + UI.field('Visibility', UI.select([{ value: 'members', label: 'Members only' }, { value: 'tenant', label: 'Whole tenant' }], w.visibility, 'data-ewvis')) + UI.field('Description', UI.input(w.description || '', { attrs: 'data-ewdesc maxlength="500"' })) + '</div><div data-err></div>',
          actions: (w.state === 'active' ? UI.btn('Archive workspace', { kind: 'danger', attrs: 'data-ewarch' }) : '') + UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-ewsave' }),
          onMount(m) {
            submit(m, '[data-ewsave]', () => {
              const body = {}; const name = m.querySelector('[data-ewname]').value.trim(), label = m.querySelector('[data-ewlabel]').value, vis = m.querySelector('[data-ewvis]').value, desc = m.querySelector('[data-ewdesc]').value.trim() || null;
              if (name !== w.name) body.name = name; if (label !== w.label) body.labelCeiling = label; if (vis !== w.visibility) body.visibility = vis; if (desc !== (w.description || null)) body.description = desc;
              if (!Object.keys(body).length) { App.closeOverlay(); return false; }
              return App.patch(wUrl(tenant.id, w.id), body);
            }, 'Workspace saved. Audit entry written.');
            const arch = m.querySelector('[data-ewarch]');
            if (arch) arch.addEventListener('click', async () => {
              const ok = await ctx.confirm({ title: 'Archive ' + w.name + '?', tone: 'danger', body: '<div class="fg2">Nobody can select an archived workspace. Its data stays and it can be restored.</div>', ok: 'Archive' });
              if (ok) act(() => App.patch(wUrl(tenant.id, w.id), { state: 'archived' }), w.name + ' archived.');
            });
          }
        });
      }

      function tenantModal(existing) {
        const sysOther = existing && isSys() && existing.id !== ownTid();
        ctx.modal({
          title: existing ? 'Edit ' + esc(existing.name) : 'New tenant',
          body: '<div class="formgrid">' + (existing ? '' : UI.field('Slug', UI.input('', { attrs: 'data-tslug maxlength="63" autocomplete="off"', placeholder: 'contoso' }), 'Lowercase letters, digits and hyphens.'))
            + UI.field('Name', UI.input(existing ? existing.name : '', { attrs: 'data-tname maxlength="200"', placeholder: 'Contoso Freight' }))
            + UI.field('Directory base', UI.input(existing ? existing.directoryDn || '' : '', { attrs: 'data-tdn maxlength="512"', placeholder: 'ou=contoso,dc=corp' }), 'Optional. The subtree this tenant\'s users and groups live under.') + '</div>'
            + (existing ? '' : UI.notice('The tenant gets a local user store and its own data key. Add its directory from User stores after signing in to it.', 'info')) + '<div data-err></div>',
          actions: (sysOther && existing.state === 'active' ? UI.btn('Disable tenant', { kind: 'danger', attrs: 'data-tdis' }) : '') + UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(existing ? 'Save' : 'Create tenant', { kind: 'primary', attrs: 'data-tsave' }),
          onMount(m) {
            submit(m, '[data-tsave]', async () => {
              const body = { name: m.querySelector('[data-tname]').value.trim(), directoryDn: m.querySelector('[data-tdn]').value.trim() || null };
              if (existing) return App.patch(tUrl(existing.id), body);
              body.slug = m.querySelector('[data-tslug]').value.trim();
              const t = await App.post('/api/admin/tenants', body); st.node = 't:' + t.id; return t;
            }, existing ? 'Tenant saved. Audit entry written.' : (t) => 'Tenant ' + esc(t.name) + ' created with its data key.');
            const dis = m.querySelector('[data-tdis]');
            if (dis) dis.addEventListener('click', async () => {
              const ok = await ctx.confirm({ title: 'Disable ' + existing.name + '?', tag: 'ends every session', tone: 'danger', body: '<div class="fg2">Its users cannot sign in and every session in the tenant is revoked now. Nothing is deleted; a system admin can enable it again.</div>', ok: 'Disable tenant' });
              if (ok) act(() => App.patch(tUrl(existing.id), { state: 'disabled' }), existing.name + ' disabled. Its sessions were revoked.');
            });
          }
        });
      }

      /** Conversation retention (Sprint 12): conversations idle for longer than N days are deleted by a scheduled job. */
      function retentionPanel(r) {
        if (!r) return '';
        const keep = r.conversationDays == null ? 'until their owners delete them' : 'deleted after ' + num(r.conversationDays) + ' days without activity';
        const last = r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() + ', ' + num(r.lastPurged || 0) + ' deleted' : 'not run yet';
        return UI.panel('Conversation retention', UI.kv([['Conversations', esc(keep)], ['Checked', 'every ' + num(r.sweepMinutes) + ' min'], ['Last run', esc(last)]], 3) + '<div class="muted" style="font-size:12px">Each purge is written to the audit chain with its counts. Messages, their catch-up buffers and attachments no remaining message uses are deleted with the conversation.</div>',
          { actions: UI.btn('Change', { size: 'sm', kind: 'ghost', attrs: 'data-retention' }) + (r.conversationDays != null ? UI.btn('Run now', { size: 'sm', kind: 'ghost', attrs: 'data-retrun' }) : '') });
      }

      function retentionModal() {
        const r = nd && nd.retention; if (!r) return;
        ctx.modal({
          title: 'Conversation retention, ' + esc(tenant.name),
          body: '<div class="formgrid">' + UI.field('Delete conversations idle for more than (days)', UI.input(r.conversationDays == null ? '' : String(r.conversationDays), { attrs: 'data-rdays inputmode="numeric"', placeholder: 'keep until the owner deletes them' }), 'Between 1 and 3650. Leave empty to keep conversations until their owners delete them.') + '</div>'
            + UI.notice('Deletion cannot be undone. It applies to every user\'s conversations in this tenant, from the next scheduled run.', 'warn') + '<div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-rsave' }),
          onMount(m) {
            submit(m, '[data-rsave]', () => {
              const v = String(m.querySelector('[data-rdays]').value || '').trim();
              const days = v === '' ? null : Number(v);
              if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) { errorBox(m, new Error('Enter whole days between 1 and 3650, or leave it empty.')); return false; }
              st.nodeKey = null;
              return App.api('PUT', tUrl(tenant.id) + '/retention', { conversationDays: days });
            }, (x) => (x.conversationDays == null ? 'Conversations are kept until their owners delete them.' : 'Conversations idle for more than ' + num(x.conversationDays) + ' days will be deleted.'));
          }
        });
      }

      function limitsModal(scope) {
        const isTenant = scope === 'tenant';
        const q = isTenant ? tenant.quota : nd && nd.quota;
        if (!q) return;
        const tq = tenant.quota;
        ctx.modal({
          title: (isTenant ? 'Raise tenant limits, ' : 'Edit limits, ') + esc(isTenant ? tenant.name : node.ws.name),
          body: '<div class="formgrid">' + LIMITS.map((L) => UI.field(L.field, UI.input(q[L.key] == null ? '' : num(q[L.key]), { attrs: 'data-lim="' + L.key + '" inputmode="numeric"', placeholder: 'no limit' }), 'Used ' + num(q.used[L.used]) + (isTenant ? '' : '. Tenant limit ' + limitText(tq[L.key])) + '.')).join('') + '</div>'
            + UI.notice(isTenant ? 'Tenant totals are set by a system admin. Workspace limits cannot exceed them. The change is written to the audit chain.' : 'Leave a field empty for no limit. A workspace limit cannot exceed the tenant limit. The change is written to the audit chain.', 'info') + '<div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-lsave' }),
          onMount(m) {
            submit(m, '[data-lsave]', () => {
              const body = {}; LIMITS.forEach((L) => { body[L.key] = readLimit(m.querySelector('[data-lim="' + L.key + '"]').value, L.field); });
              return App.api('PUT', (isTenant ? tUrl(tenant.id) : wUrl(tenant.id, node.ws.id)) + '/quota', body);
            }, (r) => 'Limits saved for ' + esc(isTenant ? tenant.name : node.ws.name) + '.' + (reachedLimits(r).length ? '' : ' Requests are admitted.'));
          }
        });
      }

      function addMemberModal() {
        const w = node.ws;
        const inWs = {}; ((nd && nd.members) || []).forEach((m) => { if (m.sources.indexOf('direct') >= 0) inWs[m.id] = true; });
        ctx.modal({
          title: 'Add member to ' + esc(w.name),
          body: UI.search('Search users by name or username', 'data-amq') + '<div data-amlist class="tn-pick"></div>' + '<div class="muted" style="font-size:12px">A direct member keeps access until removed here, whatever their directory groups say.</div><div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }),
          onMount(m) {
            const list = m.querySelector('[data-amlist]'), qEl = m.querySelector('[data-amq]');
            let timer = null, seq = 0;
            const search = async () => {
              const my = ++seq;
              let users; try { users = await App.get('/api/admin/users?limit=50' + (qEl.value.trim() ? '&q=' + enc(qEl.value.trim()) : '')); } catch (err) { errorBox(m, err); return; }
              if (my !== seq) return;
              list.innerHTML = users.length ? users.map((u) => '<div class="tn-pickrow"><span class="grow"><b>' + esc(u.displayName) + '</b> <span class="mono muted">' + esc(u.username) + '</span></span>' + UI.label(u.clearance, { sm: true }) + (u.state !== 'active' ? UI.pill(u.state, 'warn') : '') + (inWs[u.id] ? UI.pill('member', 'outline') : UI.btn('Add', { size: 'xs', attrs: 'data-amadd="' + esc(u.id) + '" data-amname="' + esc(u.username) + '"' })) + '</div>').join('') : '<div class="muted" style="padding:8px">No users match.</div>';
            };
            qEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
            list.addEventListener('click', async (e) => {
              const b = e.target.closest('[data-amadd]'); if (!b) return;
              try { await App.post(wUrl(tenant.id, w.id) + '/members', { userId: b.dataset.amadd }); } catch (err) { errorBox(m, err); return; }
              App.closeOverlay(); ctx.toast(esc(b.dataset.amname) + ' added to ' + esc(w.name) + '. Audit entry written.', 'ok'); reload();
            });
            search(); qEl.focus();
          }
        });
      }

      if (st.loaded && node) {
        if (st.openMapping) { st.openMapping = false; setTimeout(() => mappingModal(), 50); }
        if (st.openOffboard) { st.openOffboard = false; setTimeout(() => offboardModal(), 50); }
        if (st.openNewWs) { st.openNewWs = false; setTimeout(() => newWorkspaceModal(), 50); }
      }

      // ---------- handlers ----------
      const selNode = (id) => { if (st.node === id) return; st.node = id; st.map = null; st.showDisabled = false; st.checkQuota = false; st.q = ''; ctx.rerender(); };
      ctx.on('click', '[data-node]', (e, t) => selNode(t.dataset.node));
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; delete ctx.params.tab; ctx.rerender(); });
      ctx.on('click', '[data-reload]', reload);
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-q]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', 'tr[data-member]', (e, t) => { if (e.target.closest('[data-rmmember]') || !own) return; st.subject = t.dataset.member; ctx.rerender(); });
      ctx.on('click', 'tr[data-map]', (e, t) => { if (e.target.closest('[data-editmap]')) return; st.map = t.dataset.map; ctx.rerender(); });
      ctx.on('click', '[data-editmap]', (e, t) => { e.stopPropagation(); const m = (st.mappings || []).find((x) => x.id === t.dataset.editmap); if (m) mappingModal(m); });
      ctx.on('change', '[data-subject]', (e, t) => { st.subject = t.value; ctx.rerender(); });
      ctx.on('change', '[data-action]', (e, t) => { st.action = t.value; ctx.rerender(); });
      ctx.on('change', '[data-evlabel]', (e, t) => { st.evalLabel = t.value; ctx.rerender(); });
      ctx.on('change', '[data-evzone]', (e, t) => { st.evalZone = t.value; ctx.rerender(); });
      ctx.on('click', '[data-newmapping]', () => mappingModal());
      ctx.on('click', '[data-offboard]', () => offboardModal());
      ctx.on('click', '[data-newws]', () => newWorkspaceModal());
      ctx.on('click', '[data-editws]', () => editWorkspaceModal());
      ctx.on('click', '[data-edittenant]', () => tenantModal(tenant));
      ctx.on('click', '[data-newtenant]', () => tenantModal(null));
      ctx.on('click', '[data-raise]', () => limitsModal('workspace'));
      ctx.on('click', '[data-traise]', () => limitsModal('tenant'));
      ctx.on('click', '[data-retention]', () => retentionModal());
      ctx.on('click', '[data-retrun]', async () => {
        const r = nd && nd.retention; if (!r) return;
        const ok = await ctx.confirm({ title: 'Apply the retention policy now?', tone: 'danger', body: 'Conversations idle for more than ' + num(r.conversationDays) + ' days are deleted now, as the schedule would. This cannot be undone.', ok: 'Run now' });
        if (!ok) return;
        st.nodeKey = null;
        await act(() => App.post(tUrl(tenant.id) + '/retention/run', {}), 'Retention run queued. The result shows here when it finishes.');
      });
      ctx.on('click', '[data-addmember]', () => addMemberModal());
      ctx.on('click', '[data-wsstate]', async (e, t) => {
        const w = node.ws; const ok = await ctx.confirm({ title: 'Restore ' + w.name + '?', body: '<div class="fg2">Members can select it again.</div>', ok: 'Restore' });
        if (ok) act(() => App.patch(wUrl(tenant.id, w.id), { state: t.dataset.wsstate }), w.name + ' restored.');
      });
      ctx.on('click', '[data-tstate]', async (e, t) => {
        const ok = await ctx.confirm({ title: 'Enable ' + tenant.name + '?', body: '<div class="fg2">Its users can sign in again.</div>', ok: 'Enable' });
        if (ok) act(() => App.patch(tUrl(tenant.id), { state: t.dataset.tstate }), tenant.name + ' enabled.');
      });
      ctx.on('click', '[data-rmmember]', async (e, t) => {
        e.stopPropagation();
        const m = ((nd && nd.members) || []).find((x) => x.id === t.dataset.rmmember); if (!m) return;
        const viaMap = m.sources.indexOf('mapping') >= 0;
        const ok = await ctx.confirm({ title: 'Remove ' + m.username + ' from ' + node.ws.name + '?', tone: 'danger', kv: [['User', esc(m.displayName)], ['Membership', esc(m.sources.join(', '))]], body: '<div class="fg2">' + (viaMap ? 'Only the direct membership is removed. Access through a group mapping stays until the mapping or the directory changes.' : 'They lose this workspace on their next request.') + '</div>', ok: 'Remove' });
        if (ok) act(() => App.del(wUrl(tenant.id, node.ws.id) + '/members/' + enc(m.id)), 'Direct membership removed. Audit entry written.');
      });
      ctx.on('click', '[data-revoke]', async (e, t) => {
        const s = (st.sessions || []).find((x) => x.id === t.dataset.revoke); if (!s) return;
        const ok = await ctx.confirm({ title: 'Revoke session', tag: 'signs out', tone: 'danger', body: '<p style="margin:0" class="fg2">Ends the session and its refresh tokens now. ' + esc(s.user.username) + ' is signed out on the next request and must sign in again.</p>', kv: [['User', esc(s.user.displayName)], ['Workspace', esc(node.ws ? node.ws.name : '')], ['Last activity', esc(when(s.lastSeenAt))]], ok: 'Revoke' });
        if (ok) act(() => App.del('/api/admin/sessions/' + enc(s.id)), 'Session for ' + esc(s.user.username) + ' revoked. Audit event written.');
      });
      ctx.on('click', '[data-sync]', async () => {
        const stores = (st.providers || []).filter((p) => p.kind !== 'local' && p.enabled);
        const ok = await ctx.confirm({ title: 'Run directory sync now?', kv: stores.map((p) => ['Store', esc(p.name)]), body: '<div class="fg2">Users removed from the directory are disabled and their sessions revoked. It also runs on a schedule.</div>', ok: 'Run sync' });
        if (ok) act(() => Promise.all(stores.map((p) => App.post('/api/admin/identity-providers/' + enc(p.id) + '/sync'))), 'Directory sync queued. The result shows here when it finishes.');
      });
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      integWire(st, ctx);

      const style = document.createElement('style');
      style.textContent = '.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}.tn-roles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;max-height:260px;overflow:auto;padding:4px 0}.tn-role{display:flex;gap:8px;align-items:flex-start;padding:4px 6px;border-radius:4px;cursor:pointer;font-size:12px}.tn-role:hover{background:var(--sel)}.tn-role input{margin:3px 0 0;accent-color:var(--accent)}.tn-pick{max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:6px;margin:8px 0}.tn-pickrow{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--line)}.tn-pickrow:last-child{border-bottom:0}';
      root.prepend(style);
    }
  });
})();
