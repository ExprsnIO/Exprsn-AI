// Platform › Feature flags (1.9.0, Sprint 52: B-167 to B-169). A tab the Platform screen (platform.js) shows through
// App.platformFlags.render(ctx, st), and the same view on its own route, #/feature-flags, for tenant admins (who cannot
// open Platform) to set their tenant's and workspaces' values. Not in the sidebar; the command palette lists it.
//
// - Platform admins (platform:manage): define flags (key, type, default, description, owner), move them along the life
//   cycle, set plan values, and change the platform default and rollout. On a live flag that change waits for a
//   second platform admin (dual control); it needs a recent sign-in.
// - Tenant admins (tenant:manage): this tenant's value and each workspace's, with a percentage rollout, on flags that
//   allow overrides.
// - Everyone with either: stale warnings, and "why does this tenant see this" for the tenant, a workspace and a person.
//
// Every rule is the server's; until migration 137_feature_flags is applied the view says flags are unavailable.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const BASE = '/api/admin/feature-flags';
  const CSS = '<style>.pflags-actions{display:flex;flex-wrap:wrap;gap:6px}.pflags-wrap{overflow-wrap:anywhere;word-break:break-word}.pflags-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.pflags-steps{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}.pflags-steps li{border:1px solid var(--line);border-radius:6px;padding:6px 8px}</style>';
  const STATE_TONE = { planned: 'info', active: 'ok', deprecated: 'warn', removed: 'outline' };
  const NEXT = { planned: ['active', 'removed'], active: ['deprecated', 'removed'], deprecated: ['active', 'removed'], removed: ['deprecated'] };
  const TYPE_WORD = { boolean: 'on/off', variant: 'variant', number: 'number' };
  const LEVEL_WORD = { workspace: 'Workspace', tenant: 'Tenant', plan: 'Plan', platform: 'Platform', default: 'Default', builtin: 'Built-in' };
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Something went wrong.';
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || null;
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const show = (v) => (v === true ? 'on' : v === false ? 'off' : v === null || v === undefined ? 'none' : String(v));
  const withRollout = (v) => (v ? esc(show(v.value)) + (v.rollout !== null && v.rollout !== undefined && v.rollout < 100 ? ' <span class="muted">(' + esc(String(v.rollout)) + '%)</span>' : '') : '<span class="muted">not set</span>');

  // ---------- step-up: platform changes need a recent sign-in ----------
  const CANCELLED = Symbol('cancelled');
  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">Changing a platform flag needs a fresh check of who you are.</div>'
        + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
        + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
        + '<div data-suerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + (pw || totp ? UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }) : ''),
      onMount(m) {
        const err = m.querySelector('[data-suerr]');
        const go = async () => {
          const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
          const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
          if (!pwv && !code) { err.innerHTML = UI.notice('Enter your password or a code.', 'warn'); return; }
          try { await App.post('/api/me/step-up', pwv ? { password: pwv } : { code }); ok = true; App.closeOverlay(); }
          catch (e) { err.innerHTML = UI.notice(esc(detailOf(e)), 'danger'); }
        };
        const b = m.querySelector('[data-sugo]'); if (b) b.addEventListener('click', go);
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

  // ---------- loading ----------
  function load(ctx, st) {
    const p = st.flags;
    if (p.loading) return;
    p.loading = true;
    const plans = App.can('platform:manage') ? App.get('/api/admin/billing/plans').then((r) => r.plans || []).catch(() => []) : Promise.resolve([]);
    Promise.all([App.get(BASE), plans])
      .then((r) => { p.data = r[0]; p.plans = r[1]; p.error = null; p.loaded = true; })
      .catch((err) => { p.error = err; p.loaded = true; })
      .then(() => { p.loading = false; if (!document.getElementById('overlay')) ctx.rerender(); });
  }
  const reload = (ctx, st) => { st.flags.loaded = false; ctx.rerender(); };

  // ---------- value controls ----------
  function valueControl(f, v, attr) {
    if (f.type === 'boolean') return UI.select([{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }], String(v === undefined ? f.defaultValue : v), attr);
    if (f.type === 'variant') return UI.select((f.options.variants || []).map((x) => ({ value: x, label: x })), String(v === undefined ? f.defaultValue : v), attr);
    return UI.input(String(v === undefined ? f.defaultValue : v), { type: 'number', attrs: attr + ' step="any"' });
  }
  function readValue(f, el) {
    if (f.type === 'boolean') return el.value === 'true';
    if (f.type === 'number') return Number(el.value);
    return el.value;
  }
  const rolloutField = (v, attr) => UI.field('Rollout (% of people reached)', UI.input(v === null || v === undefined ? '' : String(v), { type: 'number', attrs: attr + ' min="0" max="100" step="1" inputmode="numeric"', placeholder: 'everyone' }), 'Leave empty for everyone. Sticky: a person keeps their answer while the share grows.');
  const readRollout = (el) => (el.value.trim() === '' ? null : Math.max(0, Math.min(100, Math.round(Number(el.value)))));

  // ---------- dialogs ----------
  function createModal(ctx, st) {
    ctx.modal({ title: 'Define a feature flag',
      body: '<div class="pflags-grid">'
        + UI.field('Key', UI.input('', { attrs: 'data-nf="key" autocomplete="off" spellcheck="false"', placeholder: 'new-composer' }), 'Lower case letters, digits and . _ -. A plan entitlement flag.&lt;key&gt; also sets it.')
        + UI.field('Type', UI.select([{ value: 'boolean', label: 'On/off' }, { value: 'variant', label: 'Variant' }, { value: 'number', label: 'Number' }], 'boolean', 'data-nf="type"'))
        + UI.field('Default', UI.input('false', { attrs: 'data-nf="default" autocomplete="off"' }), 'true or false, a variant, or a number.')
        + UI.field('Variants', UI.input('', { attrs: 'data-nf="variants" autocomplete="off"', placeholder: 'short, long' }), 'For a variant flag: two or more, separated by commas.')
        + UI.field('Owner', UI.input('', { attrs: 'data-nf="owner" autocomplete="off"', placeholder: 'chat team' }))
        + UI.field('Review by', UI.input('', { type: 'date', attrs: 'data-nf="review"' }), 'A stale warning shows after this date.')
        + '</div>'
        + UI.field('Description', UI.textarea('', { attrs: 'data-nf="description"', rows: 2 }))
        + '<div class="pflags-actions">' + UI.check('Send to the console (data-feature-flag)', true, 'data-nf="client"') + UI.check('Tenants may override it', true, 'data-nf="overridable"') + '</div>'
        + '<div data-nferr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Define as planned', { kind: 'primary', attrs: 'data-nfgo' }),
      onMount(m) {
        const q = (k) => m.querySelector('[data-nf="' + k + '"]');
        m.querySelector('[data-nfgo]').addEventListener('click', async () => {
          const type = q('type').value; const raw = q('default').value.trim();
          const body = { key: q('key').value.trim(), type, defaultValue: type === 'boolean' ? raw === 'true' : type === 'number' ? Number(raw) : raw, description: q('description').value, owner: q('owner').value, client: q('client').checked, overridable: q('overridable').checked };
          if (type === 'variant') body.options = { variants: q('variants').value.split(',').map((x) => x.trim()).filter(Boolean) };
          if (q('review').value) body.reviewAt = q('review').value;
          try {
            if ((await withStepUp(ctx, () => App.post(BASE, body))) === CANCELLED) return;
            App.closeOverlay(); ctx.toast('Flag ' + esc(body.key) + ' defined as planned. Audit event flag.feature.created written.', 'ok'); reload(ctx, st);
          } catch (err) { m.querySelector('[data-nferr]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); }
        });
      } });
  }

  function valueModal(ctx, st, f, scope, current, target) {
    const where = scope === 'tenant' ? 'this tenant' : scope === 'plan' ? 'the plan ' + target.name : 'the workspace ' + target.name;
    const url = BASE + '/' + enc(f.key) + (scope === 'tenant' ? '/tenant' : scope === 'plan' ? '/plans/' + enc(target.id) : '/workspaces/' + enc(target.id));
    ctx.modal({ title: f.key + ' for ' + where,
      body: UI.field('Value', valueControl(f, current ? current.value : undefined, 'data-vv')) + rolloutField(current ? current.rollout : null, 'data-vr')
        + UI.field('Note', UI.input(current && current.note ? current.note : '', { attrs: 'data-vn autocomplete="off"' })) + '<div data-verr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + (current ? UI.btn('Clear', { attrs: 'data-vclear' }) : '') + UI.btn('Save', { kind: 'primary', attrs: 'data-vgo' }),
      onMount(m) {
        const fail = (err) => { m.querySelector('[data-verr]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); };
        m.querySelector('[data-vgo]').addEventListener('click', async () => {
          try { await App.put(url, { value: readValue(f, m.querySelector('[data-vv]')), rollout: readRollout(m.querySelector('[data-vr]')), note: m.querySelector('[data-vn]').value || null }); App.closeOverlay(); ctx.toast('Saved for ' + esc(where) + '. Audit event flag.value.set written.', 'ok'); reload(ctx, st); }
          catch (err) { fail(err); }
        });
        const c = m.querySelector('[data-vclear]');
        if (c) c.addEventListener('click', async () => {
          try { await App.del(url); App.closeOverlay(); ctx.toast('Cleared for ' + esc(where) + '. Audit event flag.value.cleared written.', 'ok'); reload(ctx, st); }
          catch (err) { fail(err); }
        });
      } });
  }

  function platformModal(ctx, st, f) {
    const live = f.state === 'active' || f.state === 'deprecated';
    ctx.modal({ title: f.key + ': platform default and rollout',
      body: (live ? UI.notice('<b>This flag is live.</b> The change waits for a second platform admin to approve it.', 'warn') : '')
        + UI.field('Default', valueControl(f, f.defaultValue, 'data-pd'))
        + UI.check('Set a platform value', !!f.platform, 'data-pon')
        + UI.field('Platform value', valueControl(f, f.platform ? f.platform.value : undefined, 'data-pv')) + rolloutField(f.platform ? f.platform.rollout : null, 'data-pr')
        + UI.field('Reason', UI.input('', { attrs: 'data-preason autocomplete="off"' })) + '<div data-perr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(live ? 'Propose' : 'Save', { kind: 'primary', attrs: 'data-pgo' }),
      onMount(m) {
        m.querySelector('[data-pgo]').addEventListener('click', async () => {
          const body = { defaultValue: readValue(f, m.querySelector('[data-pd]')), platform: m.querySelector('[data-pon]').checked ? { value: readValue(f, m.querySelector('[data-pv]')), rollout: readRollout(m.querySelector('[data-pr]')) } : null, reason: m.querySelector('[data-preason]').value || null };
          try {
            const r = await withStepUp(ctx, () => App.put(BASE + '/' + enc(f.key) + '/platform', body));
            if (r === CANCELLED) return;
            App.closeOverlay();
            ctx.toast(r.applied ? 'Saved. Audit event flag.platform.changed written.' : 'Proposed: it applies when another platform admin approves it. Audit event flag.change.proposed written.', 'ok', 7000);
            reload(ctx, st);
          } catch (err) { m.querySelector('[data-perr]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); }
        });
      } });
  }

  function editModal(ctx, st, f) {
    ctx.modal({ title: 'Edit ' + f.key,
      body: UI.field('Description', UI.textarea(f.description || '', { attrs: 'data-ef="description"', rows: 2 }))
        + '<div class="pflags-grid">' + UI.field('Owner', UI.input(f.owner || '', { attrs: 'data-ef="owner" autocomplete="off"' }))
        + UI.field('Review by', UI.input(f.reviewAt ? new Date(f.reviewAt).toISOString().slice(0, 10) : '', { type: 'date', attrs: 'data-ef="review"' }))
        + UI.field('Rollout is sticky by', UI.select([{ value: 'user', label: 'Person' }, { value: 'workspace', label: 'Workspace' }, { value: 'tenant', label: 'Tenant' }], f.rolloutBy, 'data-ef="by"')) + '</div>'
        + '<div class="pflags-actions">' + UI.check('Send to the console (data-feature-flag)', f.client, 'data-ef="client"') + UI.check('Tenants may override it', f.overridable, 'data-ef="overridable"') + '</div>'
        + '<div data-eferr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-efgo' }),
      onMount(m) {
        const q = (k) => m.querySelector('[data-ef="' + k + '"]');
        m.querySelector('[data-efgo]').addEventListener('click', async () => {
          try {
            await App.patch(BASE + '/' + enc(f.key), { description: q('description').value, owner: q('owner').value, reviewAt: q('review').value || null, rolloutBy: q('by').value, client: q('client').checked, overridable: q('overridable').checked });
            App.closeOverlay(); ctx.toast('Saved. Audit event flag.feature.updated written.', 'ok'); reload(ctx, st);
          } catch (err) { m.querySelector('[data-eferr]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); }
        });
      } });
  }

  function explainModal(ctx, st, f) {
    const ws = (st.flags.data.workspaces || []);
    const run = (m) => {
      const w = m.querySelector('[data-xw]').value; const me = m.querySelector('[data-xme]').checked;
      const qs = [].concat(w ? ['workspace=' + enc(w)] : [], me && App.me ? ['user=' + enc(App.me.user.id)] : []).join('&');
      const out = m.querySelector('[data-xout]');
      out.innerHTML = '<p class="muted">Working it out…</p>';
      App.get(BASE + '/' + enc(f.key) + '/explain' + (qs ? '?' + qs : '')).then((e) => {
        out.innerHTML = '<p style="margin:0 0 8px"><b>' + esc(show(e.value)) + '</b> from ' + esc((LEVEL_WORD[e.level] || e.level).toLowerCase()) + '. ' + esc(e.reason) + '</p>'
          + (e.steps.length ? '<ul class="pflags-steps" aria-label="Each level">' + e.steps.map((s) => '<li><b>' + esc(LEVEL_WORD[s.level]) + '</b>: ' + (s.set ? esc(show(s.value)) + (s.rollout !== null && s.rollout !== undefined ? ' (' + esc(String(s.rollout)) + '%)' : '') + (s.fromEntitlement ? ' from the plan entitlement' : '') : '<span class="muted">not set</span>') + (s.skipped ? '<div class="muted pflags-wrap" style="font-size:12px">' + esc(s.skipped) + '</div>' : '') + '</li>').join('') + '</ul>' : '');
      }).catch((err) => { out.innerHTML = UI.notice(esc(detailOf(err)), 'danger'); });
    };
    ctx.modal({ title: 'Why this tenant sees ' + f.key,
      body: '<div class="pflags-grid">' + UI.field('Workspace', UI.select([{ value: '', label: 'No workspace' }].concat(ws.map((w) => ({ value: w.id, label: w.name }))), '', 'data-xw')) + '</div>'
        + UI.check('For me (rollouts by person)', true, 'data-xme') + '<div data-xout aria-live="polite"></div>',
      actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Explain', { kind: 'primary', attrs: 'data-xgo' }),
      onMount(m) { m.querySelector('[data-xgo]').addEventListener('click', () => run(m)); run(m); } });
  }

  function detailModal(ctx, st, f) {
    const canPlatform = st.flags.data.canManage; const canTenant = App.can('tenant:manage');
    const ws = st.flags.data.workspaces || [];
    const mine = f.mine || { tenant: null, workspaces: [] };
    const planRows = (st.flags.plans || []).map((p) => {
      const v = (st.flags.values || []).find((x) => x.scope === 'plan' && x.scopeId === p.key);
      return [esc(p.name), '<span class="mono">' + esc(p.key) + '</span>', withRollout(v), UI.btn(v ? 'Change' : 'Set', { size: 'xs', kind: 'ghost', attrs: 'data-dplan="' + esc(p.key) + '"' })];
    });
    const wsRows = ws.map((w) => { const v = mine.workspaces.find((x) => x.scopeId === w.id); return [esc(w.name), withRollout(v), canTenant && f.overridable && f.state !== 'removed' ? UI.btn(v ? 'Change' : 'Set', { size: 'xs', kind: 'ghost', attrs: 'data-dws="' + esc(w.id) + '"' }) : '']; });
    const actions = [];
    if (canPlatform && f.state !== 'removed') actions.push(UI.btn('Default and rollout', { size: 'sm', attrs: 'data-dplat' }), UI.btn('Edit', { size: 'sm', attrs: 'data-dedit' }));
    if (canPlatform) NEXT[f.state].forEach((s) => actions.push(UI.btn('Mark ' + s, { size: 'sm', attrs: 'data-dstate="' + s + '"' })));
    actions.push(UI.btn('Why this tenant sees it', { size: 'sm', attrs: 'data-dwhy' }));
    ctx.modal({ cls: 'wide', title: f.key,
      body: '<p class="fg2 pflags-wrap" style="margin-top:0">' + esc(f.description || 'No description.') + '</p>'
        + (f.stale && f.stale.length ? UI.notice('<b>Stale.</b> ' + f.stale.map((w) => esc(w.message)).join(' '), 'warn') : '')
        + UI.kv([['Type', esc(TYPE_WORD[f.type]) + (f.type === 'variant' ? ': ' + esc((f.options.variants || []).join(', ')) : '')], ['State', UI.pill(f.state, STATE_TONE[f.state])], ['Default', esc(show(f.defaultValue))], ['Platform', canPlatform ? withRollout(f.platform) : '<span class="muted">set by platform admins</span>'], ['Owner', esc(f.owner || 'nobody named')], ['Sticky by', esc(f.rolloutBy)], ['Console', f.client ? 'sent' : 'server only'], ['Overrides', f.overridable ? 'tenants may override' : 'locked to platform and plans']], 2)
        + '<div class="pflags-actions" style="margin:10px 0">' + actions.join('') + '</div>'
        + '<div class="eyebrow">This tenant</div><div class="pflags-actions" style="margin:6px 0 10px">' + withRollout(mine.tenant) + (canTenant && f.overridable && f.state !== 'removed' ? ' ' + UI.btn(mine.tenant ? 'Change' : 'Set', { size: 'xs', kind: 'ghost', attrs: 'data-dten' }) : '') + '</div>'
        + (ws.length ? '<div class="eyebrow">Workspaces</div>' + UI.table(['Workspace', 'Value', ''], wsRows, { clickable: false, minWidth: '0', cls: 'bare' }) : '')
        + (canPlatform ? '<div class="eyebrow" style="margin-top:10px">Plans</div>' + UI.table(['Plan', 'Key', 'Value', ''], planRows, { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No plans', emptyText: 'Plans come from Billing.' }) : ''),
      actions: UI.btn('Close', { attrs: 'data-close' }),
      onMount(m) {
        const on = (sel, fn) => m.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => fn(b)));
        const then = (fn) => () => { App.closeOverlay(); setTimeout(fn, 0); };
        on('[data-dplat]', then(() => platformModal(ctx, st, f)));
        on('[data-dedit]', then(() => editModal(ctx, st, f)));
        on('[data-dwhy]', then(() => explainModal(ctx, st, f)));
        on('[data-dten]', then(() => valueModal(ctx, st, f, 'tenant', mine.tenant, null)));
        on('[data-dws]', (b) => { const w = ws.find((x) => x.id === b.dataset.dws); then(() => valueModal(ctx, st, f, 'workspace', mine.workspaces.find((x) => x.scopeId === w.id) || null, { id: w.id, name: w.name }))(); });
        on('[data-dplan]', (b) => { const p = (st.flags.plans || []).find((x) => x.key === b.dataset.dplan); then(() => valueModal(ctx, st, f, 'plan', (st.flags.values || []).find((x) => x.scope === 'plan' && x.scopeId === p.key) || null, { id: p.key, name: p.name }))(); });
        on('[data-dstate]', async (b) => {
          const to = b.dataset.dstate;
          try {
            if ((await withStepUp(ctx, () => App.post(BASE + '/' + enc(f.key) + '/state', { state: to }))) === CANCELLED) return;
            App.closeOverlay(); ctx.toast(esc(f.key) + ' is ' + esc(to) + ' now. Audit event flag.feature.state_changed written.', 'ok'); reload(ctx, st);
          } catch (err) { App.fail(err, 'Not changed'); }
        });
      } });
  }

  // ---------- render ----------
  function render(ctx, st) {
    st.flags = st.flags || {};
    const p = st.flags;
    if (!p.loaded) { load(ctx, st); return '<p class="muted">Loading the feature flags…</p>'; }
    if (p.error) {
      ctx.on('click', '[data-fretry]', () => { p.error = null; reload(ctx, st); });
      return UI.problem('The feature flags could not be loaded', detailOf(p.error), traceOf(p.error)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-fretry' }) + '</div>';
    }
    const d = p.data;
    if (!d.available) return CSS + UI.notice('<b>Feature flags are unavailable.</b> The database migration <span class="mono">137_feature_flags</span> has not been applied; until it is, every flag answers its built-in default.', 'warn');
    const canPlatform = d.canManage;
    const flags = d.flags;
    const q = (p.q || '').toLowerCase();
    const shown = flags.filter((f) => !q || f.key.indexOf(q) >= 0 || (f.description || '').toLowerCase().indexOf(q) >= 0);
    const stale = flags.filter((f) => f.stale && f.stale.length).length;
    const strip = '<div class="stats">' + UI.stat(String(flags.length), 'Flags', flags.filter((f) => f.state === 'active' || f.state === 'deprecated').length + ' live') + UI.stat(String(stale), 'Stale', 'deprecated, unchanged or past review') + (canPlatform ? UI.stat(String(d.pending.length), 'Waiting', 'platform changes for a second admin') : '') + '</div>';
    const pending = canPlatform && d.pending.length ? UI.panel('Changes waiting for a second platform admin', UI.table(['Flag', 'Change', 'Reason', 'Proposed', ''], d.pending.map((x) => ['<span class="mono">' + esc(x.flag) + '</span>', esc([x.change.defaultValue !== undefined ? 'default ' + show(x.change.defaultValue) : null, x.change.platform === null ? 'clear the platform value' : x.change.platform ? 'platform ' + show(x.change.platform.value) + (x.change.platform.rollout !== null ? ' at ' + x.change.platform.rollout + '%' : '') : null].filter(Boolean).join(', ')), esc(x.reason || ''), esc(day(x.proposedAt)) + (x.mine ? ' ' + UI.pill('yours', 'outline') : ''), '<span class="pflags-actions">' + (x.mine ? UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-preject="' + esc(x.id) + '"' }) : UI.btn('Approve', { size: 'xs', kind: 'ghost', attrs: 'data-papprove="' + esc(x.id) + '"' }) + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-preject="' + esc(x.id) + '"' })) + '</span>']), { clickable: false, minWidth: '0' })) : '';
    const rows = shown.map((f) => [
      '<b class="mono pflags-wrap">' + esc(f.key) + '</b>' + (f.description ? '<div class="muted pflags-wrap" style="font-size:12px">' + esc(f.description) + '</div>' : ''),
      esc(TYPE_WORD[f.type]),
      UI.pill(f.state, STATE_TONE[f.state]) + (f.stale && f.stale.length ? ' ' + UI.pill('stale', 'warn') : '') + (f.pending ? ' ' + UI.pill('change waiting', 'info') : ''),
      esc(show(f.defaultValue)),
      canPlatform ? withRollout(f.platform) : (f.overridable ? 'may override' : 'locked'),
      withRollout(f.mine && f.mine.tenant),
      UI.btn('Open', { size: 'xs', kind: 'ghost', attrs: 'data-fopen="' + esc(f.key) + '" aria-label="Open ' + esc(f.key) + '"' })
    ]);
    const table = UI.panel('Flags', '<div class="pflags-actions" style="margin-bottom:8px">' + UI.search('Filter flags', 'data-fq', p.q || '') + (canPlatform ? UI.btn('Define a flag', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-fnew' }) : '') + '</div>'
      + UI.table(['Flag', 'Type', 'State', 'Default', canPlatform ? 'Platform' : 'Overrides', 'This tenant', ''], rows, { clickable: false, minWidth: '720px', emptyTitle: flags.length ? 'No flag matches' : 'No feature flags yet', emptyText: flags.length ? 'Try another filter.' : canPlatform ? 'Define one; it starts planned and answers its default until it is active.' : 'Platform admins define flags.' })
      + '<p class="muted" style="font-size:12px;margin-bottom:0">The most specific level wins: workspace over tenant over plan over platform, then the default. A plan entitlement flag.&lt;key&gt; counts as the plan\'s value.</p>');

    ctx.on('input', '[data-fq]', (e, t) => { p.q = t.value; clearTimeout(p.qt); p.qt = setTimeout(() => { ctx.rerender(); const i = document.querySelector('#main [data-fq]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 200); });
    ctx.on('click', '[data-fnew]', () => createModal(ctx, st));
    ctx.on('click', '[data-fopen]', (e, t) => {
      const f = flags.find((x) => x.key === t.dataset.fopen); if (!f) return;
      if (!canPlatform) { p.values = []; detailModal(ctx, st, f); return; }
      App.get(BASE + '/' + enc(f.key)).then((r) => { p.values = r.values; detailModal(ctx, st, Object.assign({}, f, { stale: r.stale })); }).catch((err) => App.fail(err, 'The flag could not be opened'));
    });
    ctx.on('click', '[data-papprove]', async (e, t) => {
      try { if ((await withStepUp(ctx, () => App.post(BASE + '/proposals/' + enc(t.dataset.papprove) + '/approve', {}))) === CANCELLED) return; ctx.toast('Approved and applied. Audit event flag.change.approved written.', 'ok'); reload(ctx, st); }
      catch (err) { App.fail(err, 'Not approved'); }
    });
    ctx.on('click', '[data-preject]', async (e, t) => {
      try { const r = await App.post(BASE + '/proposals/' + enc(t.dataset.preject) + '/reject', {}); ctx.toast((r.state === 'withdrawn' ? 'Withdrawn' : 'Rejected') + '. Audit event flag.change.' + esc(r.state) + ' written.', 'ok'); reload(ctx, st); }
      catch (err) { App.fail(err, 'Not changed'); }
    });
    return CSS + strip + pending + table;
  }

  App.platformFlags = {
    tabs: [{ id: 'flags', label: 'Feature flags' }],
    render
  };

  // The same view on its own route, for tenant admins.
  App.register({
    id: 'feature-flags',
    title: 'Feature flags',
    live: true,
    crumb: ['Admin', 'Feature flags'],
    summary: 'Flags, their targeting and rollout, and this tenant\'s overrides',
    commands: [{ label: 'Feature flags', sub: 'Flags, targeting and rollout' }],
    render(root, ctx) {
      const st = ctx.state;
      if (!(App.can('platform:manage') || App.can('tenant:manage'))) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Feature flags', 'Flags and their targeting') + UI.problem('You do not have access to feature flags', 'They need the platform:manage or tenant:manage permission.', false) + '</div>';
        return;
      }
      root.innerHTML = '<div class="page">' + UI.pagehead('Feature flags', 'Which features each tenant, plan and workspace sees, and how far a rollout has gone') + render(ctx, st) + '</div>';
    }
  });
}());
