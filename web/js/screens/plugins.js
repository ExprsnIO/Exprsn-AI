(function () {
  const { UI, esc } = App;

  // Plugins and events (Sprints 24c, 25d): the event catalogue, plugin manifests, grants, lifecycle and runs.
  // Everything here comes from /api/admin/plugins… and /api/events/catalogue.
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const overlayOpen = () => !!document.getElementById('overlay');
  const stateKind = (s) => s === 'enabled' ? 'ok' : s === 'disabled' ? 'warn' : s === 'removed' ? 'danger' : s === 'installed' ? 'info' : '';
  const invKind = (s) => s === 'succeeded' ? 'ok' : s === 'failed' ? 'danger' : s === 'cancelled' ? 'warn' : 'info';
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || false;
  const DEFAULT_MANIFEST = '{\n  "key": "ledger-close-checker",\n  "name": "Ledger close checker",\n  "version": "1.0.0",\n  "kind": "declarative",\n  "events": ["record.transitioned"],\n  "capabilities": ["read:records", "emit:flag", "emit:notification"],\n  "actions": [{ "type": "flag", "on": "record.transitioned", "with": { "severity": "medium", "reason": "ledger closed with open items" } }]\n}';

  // Polling while runs are queued or running (the server has no socket event for plugin invocations).
  const live = { timer: null };
  const stopPoll = () => { if (live.timer) { clearTimeout(live.timer); live.timer = null; } };

  function menu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  /** A confirm dialog whose fields ([data-f="name"]) are read when OK is pressed; resolves to their values or null. */
  function ask(ctx, o) {
    return new Promise((resolve) => {
      let out = null;
      ctx.modal({
        title: esc(o.title) + (o.tag ? ' ' + UI.pill(o.tag, o.tone || 'danger') : ''),
        body: (o.body || '') + (o.kv ? UI.kv(o.kv, 2) : ''),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(o.ok || 'Confirm', { kind: o.tone === 'danger' ? 'danger' : 'primary', attrs: 'data-ok' }),
        onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', () => {
            out = {}; m.querySelectorAll('[data-f]').forEach((el) => { out[el.dataset.f] = el.value; });
            App.closeOverlay();
          });
        },
        onClose() { resolve(out); }
      });
    });
  }
  const reasonField = (label) => UI.field(label || 'Reason (optional)', UI.input('', { attrs: 'data-f="reason" maxlength="500"' }));
  const labelsUpTo = () => { const c = (App.me && App.me.user && App.me.user.clearance) || 'internal'; return LABELS.slice(0, Math.max(1, LABELS.indexOf(c) + 1)); };
  const maxLabelField = (value) => UI.field('Max label', UI.select(labelsUpTo(), labelsUpTo().indexOf(value) >= 0 ? value : 'internal', 'data-f="maxLabel"'), 'Events above it never reach the plugin; at most your clearance');

  App.register({
    id: 'plugins', title: 'Plugins and events', section: 'admin', crumb: ['Admin', 'Plugins and events'], live: true,
    summary: 'The event catalogue, plugin manifests, grants, lifecycle and runs',
    commands: [
      { label: 'Install a plugin', sub: 'Plugins and events', run(app) { const s = app.stateFor('plugins'); s.tab = 'install'; app.render(); } },
      { label: 'Plugin runs', sub: 'Plugins and events', run(app) { const s = app.stateFor('plugins'); s.tab = 'runs'; s.runs = null; app.render(); } }
    ],
    states: [
      { title: 'Required capability missing', tone: 'danger', text: 'Enable answers 409 with missing when a required capability is not granted. File upload flagger asks for emit:flag, which nobody granted yet.', apply(ctx) { const st = ctx.state; st.tab = 'plugins'; st.problem = { kind: 'missing', key: 'file-upload-flagger', missing: ['emit:flag'], example: true }; ctx.rerender(); } },
      { title: 'Grant revoked disables plugin', tone: 'warn', text: 'Replacing the grants of an enabled plugin without a required capability disables it at once (grants transition from enabled to disabled, audited plugin.grants.updated with before, after, added, removed, highRisk).', apply(ctx) { const st = ctx.state; st.tab = 'plugins'; ctx.rerender(); setTimeout(() => grantsDialog(ctx, { key: 'flag-escalation-notifier', name: 'Flag escalation notifier', state: 'enabled', required: ['read:events', 'emit:notification', 'emit:audit'] }, [], ['emit:notification'], true), 0); } },
      { title: 'Script plugin needs a signed bundle', tone: 'warn', text: 'With PLUGINS_REQUIRE_SIGNED=scripts (the default) a script plugin pasted inline can be installed but not enabled (409). The same manifest in a promoted import bundle passes.', apply(ctx) { const st = ctx.state; st.tab = 'plugins'; st.problem = { kind: 'unsigned', key: 'weekly-digest-poster', detail: 'weekly-digest-poster is a script plugin installed from an inline manifest; script plugins must come from a signed import bundle (PLUGINS_REQUIRE_SIGNED is scripts).', example: true }; ctx.rerender(); } },
      { title: 'Invocation failed and loop dropped', tone: 'danger', text: 'A record.updated caused by the plugin\'s own write carries the plugin in its chain and is never delivered to it (exprsn_plugin_dropped_total reason loop). The write refused for a restricted record failed its invocation.', apply(ctx) { const st = ctx.state; st.tab = 'runs'; st.invState = 'failed'; st.example = 'loop'; ctx.rerender(); } },
      { title: 'Webhook host refused', tone: 'danger', text: 'A webhook action to a host outside the tenant\'s allowed hosts is 422 at install, at enable and at every attempt. Three attempts failed, the delivery is counted and the breaker is open.', apply(ctx) { const st = ctx.state; st.tab = 'runs'; st.invState = 'failed'; st.example = 'host'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.tab) Object.assign(st, { tab: 'plugins' });
      ['query', 'catQuery'].forEach((k) => { if (st[k] == null) st[k] = ''; });
      ['stateFilter', 'kindFilter', 'catGroup', 'invState', 'invPlugin'].forEach((k) => { if (!st[k]) st[k] = 'all'; });
      if (!st.details) st.details = {};
      if (!st.logs) st.logs = {};
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }

      // ---------- loading ----------
      const refresh = () => {
        if (App.state.route !== 'plugins') return;
        if (overlayOpen()) return;
        const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0;
        ctx.rerender();
        const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top;
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([
          App.get('/api/admin/plugins?removed=true'),
          App.get('/api/admin/plugins/capabilities'),
          App.get('/api/events/catalogue'),
          App.can('users:manage') ? App.get('/api/admin/users?limit=500').catch(() => null) : Promise.resolve(null)
        ])
          .then(([list, caps, catalogue, users]) => { Object.assign(st, { plugins: list.plugins, caps, catalogue, users, loaded: true, loadError: null }); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; refresh(); });
      };
      /** Reloads the list (and drops cached details and runs) after a change. */
      const reload = async (selId) => {
        try {
          const list = await App.get('/api/admin/plugins?removed=true');
          st.plugins = list.plugins; st.details = {}; st.runs = null;
          if (selId) st.sel = selId;
        } catch (err) { App.fail(err, 'Could not refresh plugins'); }
        refresh();
      };
      const loadDetail = (id) => {
        if (st.details[id]) return;
        st.details[id] = { loading: true };
        App.get('/api/admin/plugins/' + enc(id))
          .then((d) => { st.details[id] = d; })
          .catch((err) => { st.details[id] = { error: err }; })
          .finally(refresh);
      };
      const loadAvailable = () => {
        if (st.available || st.availableLoading) return;
        st.availableLoading = true;
        App.get('/api/admin/plugins/available')
          .then((r) => { st.available = r.plugins; st.availableError = null; })
          .catch((err) => { st.availableError = err; st.available = []; })
          .finally(() => { st.availableLoading = false; refresh(); });
      };
      const loadRuns = () => {
        if (st.runsLoading) return;
        st.runsLoading = true;
        const ps = (st.plugins || []).filter((p) => st.invPlugin === 'all' || p.key === st.invPlugin).sort((a, b) => (a.state === 'installed') - (b.state === 'installed') || b.updatedAt - a.updatedAt).slice(0, 40);
        Promise.all(ps.map((p) => App.get('/api/admin/plugins/' + enc(p.id) + '/invocations?limit=50').then((r) => r.invocations.map((i) => Object.assign(i, { plugin: p.key, pluginId: p.id })))))
          .then((lists) => { st.runs = [].concat.apply([], lists).sort((a, b) => b.createdAt - a.createdAt); st.runsError = null; })
          .catch((err) => { st.runsError = err; st.runs = st.runs || []; })
          .finally(() => {
            st.runsLoading = false; refresh();
            stopPoll();
            if (st.runs && st.runs.some((i) => i.state === 'queued' || i.state === 'running')) live.timer = setTimeout(() => { live.timer = null; if (App.state.route === 'plugins' && st.tab === 'runs' && !overlayOpen()) loadRuns(); }, 1500);
          });
      };
      const loadLogs = (inv) => {
        if (st.logs[inv.id]) return;
        st.logs[inv.id] = { loading: true };
        App.get('/api/admin/plugins/' + enc(inv.pluginId) + '/logs?limit=100&invocation=' + enc(inv.id))
          .then((r) => { st.logs[inv.id] = { logs: r.logs }; })
          .catch((err) => { st.logs[inv.id] = { error: err }; })
          .finally(refresh);
      };
      if (!st.loaded && !st.loadError) load();

      const style = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .plugins-cat{display:grid;gap:14px;grid-template-columns:minmax(0,3fr) minmax(0,2fr)}'
        + '@media (max-width:1100px){#main .plugins-cat{grid-template-columns:minmax(0,1fr)}}'
        + '#main .plugins-grants .check{min-height:24px}'
        + '#main .plugins-insp{overflow-wrap:anywhere}'
        + '#main .plugins-insp .kv .v{font-size:12px}'
        + '</style>';
      const head = (actions) => UI.pagehead('Plugins and events', 'The event catalogue every webhook and plugin delivery follows, the tenant\'s plugins with their grants and lifecycle, and their runs.', actions);
      if (st.loadError) {
        root.innerHTML = style + '<div class="page">' + head('') + UI.problem('Plugins could not be loaded', st.loadError.message, traceOf(st.loadError)) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div></div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      if (!st.loaded) { root.innerHTML = style + '<div class="page">' + head('') + UI.notice('Loading…', 'info') + '</div>'; return; }

      const CAPS = st.caps.capabilities;
      const RISK = {}; CAPS.forEach((c) => { RISK[c.name] = c.risk; });
      const ACTION_CAP = st.caps.actions || {};
      const CATALOGUE = st.catalogue;
      const userName = (id) => { if (!id) return 'unknown'; if (App.me && App.me.user && id === App.me.user.id) return 'you'; if (/^service:/.test(id)) return id.slice(8); const u = (st.users || []).find((x) => x.id === id); return u ? u.displayName : id.slice(-6); };

      if (ctx.params.id) { const p = st.plugins.find((x) => x.id === ctx.params.id || x.key === ctx.params.id); if (p) { st.tab = 'plugins'; st.sel = p.id; if (p.state === 'removed') st.showRemoved = true; } delete ctx.params.id; }
      const enabled = st.plugins.filter((p) => p.state === 'enabled').length;
      if (st.tab === 'runs' && !st.runs && !st.runsLoading) loadRuns();
      if (st.tab === 'install') loadAvailable();
      const runs = st.runs || [];
      const tabs = UI.tabs([{ id: 'plugins', label: 'Plugins', count: st.plugins.filter((p) => p.state !== 'removed').length }, { id: 'install', label: 'Install' }, { id: 'catalogue', label: 'Event catalogue', count: CATALOGUE.types.length }, { id: 'runs', label: 'Runs', count: runs.filter((i) => i.state === 'running' || i.state === 'queued').length }], st.tab);
      let body = '', insp = '';

      // ---------------- Plugins ----------------
      if (st.tab === 'plugins') {
        const q = st.query.toLowerCase();
        const rows = st.plugins.filter((p) => (st.showRemoved || p.state !== 'removed') && (st.stateFilter === 'all' || p.state === st.stateFilter) && (st.kindFilter === 'all' || p.kind === st.kindFilter) && (!q || (p.key + ' ' + p.name + ' ' + (p.publisher || '') + ' ' + (p.description || '')).toLowerCase().includes(q)));
        if (!rows.some((p) => p.id === st.sel)) st.sel = rows.length ? rows[0].id : null;
        const sel = st.plugins.find((p) => p.id === st.sel);
        const pr = st.problem;
        body += (pr && pr.kind === 'missing' ? UI.problem('Cannot enable: required capability not granted', 'POST /admin/plugins/' + pr.key + '/enable answered 409 with missing: ' + pr.missing.join(', ') + '. Grant it in the inspector and enable again.' + (pr.example ? ' (Example.)' : ''), pr.trace || false) + '<div>' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearproblem' }) + '</div>' : '')
          + (pr && pr.kind === 'unsigned' ? UI.problem('Cannot enable: script plugins must come from a signed bundle', pr.detail + ' Install it from a promoted import bundle (Install tab) instead.' + (pr.example ? ' (Example.)' : ''), pr.trace || false) + '<div class="hstack gap6">' + UI.btn('Open the bundles', { size: 'sm', attrs: 'data-gobundle' }) + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearproblem' }) + '</div>' : '')
          + (pr && pr.kind === 'refused' ? UI.problem(pr.title, pr.detail, pr.trace || false) + '<div>' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearproblem' }) + '</div>' : '')
          + '<div class="toolbar">' + UI.search('Filter by key, name, publisher', 'data-search', st.query)
          + '<span class="relative">' + UI.btn(st.stateFilter === 'all' ? 'State' : 'State: ' + st.stateFilter, { size: 'sm', icon: 'filter', attrs: 'data-menu="state"', cls: st.stateFilter !== 'all' ? 'active' : '' }) + '</span>'
          + '<span class="relative">' + UI.btn(st.kindFilter === 'all' ? 'Kind' : 'Kind: ' + st.kindFilter, { size: 'sm', icon: 'filter', attrs: 'data-menu="kind"', cls: st.kindFilter !== 'all' ? 'active' : '' }) + '</span>'
          + UI.check('Show removed', st.showRemoved, 'data-showremoved') + '<span class="muted right" style="font-size:12px">' + rows.length + ' shown, ' + enabled + ' enabled</span></div>'
          + UI.table(['Plugin', 'Version', 'Kind', 'Publisher', 'State', 'Capabilities', 'Max label', 'Source', 'Changed'], rows.map((p) => ({ cells: ['<div style="font-weight:600">' + esc(p.name) + '</div><div class="mono muted" style="font-size:11px">' + esc(p.key) + '</div>', '<span class="mono">' + esc(p.version) + '</span>', esc(p.kind), esc(p.publisher || ''), UI.pill(p.state, stateKind(p.state)), p.granted.map((c) => UI.pill(c, RISK[c] === 'high' ? 'accent' : 'outline')).join(' ') + (p.missing.length && p.state !== 'removed' ? ' ' + p.missing.map((c) => UI.pill('missing ' + c, 'warn')).join(' ') : ''), UI.label(p.maxLabel, { sm: true }), p.source === 'bundle' ? '<span title="' + esc((p.bundle && p.bundle.path) || '') + '">bundle</span>' : 'inline', esc(when(p.stateChangedAt))], attrs: 'data-plugin="' + esc(p.id) + '" data-key="' + esc(p.key) + '"', selected: p.id === st.sel })), { minWidth: '1000px', emptyTitle: st.plugins.length ? 'No plugins match' : 'No plugins installed', emptyText: st.plugins.length ? 'Clear the filters, or install one from the Install tab.' : 'Install one from a manifest or a promoted import bundle on the Install tab.' })
          + '<span class="muted" style="font-size:12px">A plugin is data: a manifest and the capabilities granted to it. Nothing in a manifest is loaded into the server; declarative actions and script handlers run from events as jobs, scripts in the sandbox. Plugins above your clearance are left out.</span>';
        if (sel) {
          loadDetail(sel.id);
          const d = st.details[sel.id] || { loading: true };
          const m = d.manifest || null;
          const schemaFields = m && m.config && m.config.schema && m.config.schema.properties ? Object.keys(m.config.schema.properties) : [];
          const miss = sel.state === 'removed' ? [] : sel.missing;
          const all = sel.capabilities;
          insp = '<div class="hstack"><div class="eyebrow grow">Selected plugin</div>' + UI.pill(sel.state, stateKind(sel.state)) + '</div><div style="font-size:15px;font-weight:600">' + esc(sel.name) + '</div><div class="mono muted" style="font-size:11px">' + esc(sel.key) + ' ' + esc(sel.version) + ', ' + esc((sel.manifestHash || '').slice(0, 23)) + '</div>' + (sel.description ? '<div class="fg2" style="font-size:12px">' + esc(sel.description) + '</div>' : '')
            + UI.kv([['Kind', esc(sel.kind) + (m && m.script ? ', entry ' + esc(m.script.entry) + ' (' + esc(m.script.bytes) + ' bytes)' : m && m.webhook ? ', ' + esc(String(m.webhook.url).replace(/^https?:\/\//, '').split('/')[0]) : '')], ['Publisher', esc(sel.publisher || 'not given')], ['Events', sel.events.map((e) => '<span class="mono">' + esc(e) + '</span>').join(', ') || 'none'], ['Max label', UI.label(sel.maxLabel, { sm: true })], ['Source', sel.source === 'bundle' && sel.bundle ? 'bundle <span class="mono">' + esc(sel.bundle.path || '') + '</span>, signer ' + esc(sel.bundle.signer || 'unknown') : 'inline manifest'], ['Installed', esc(when(sel.createdAt)) + ' by ' + esc(userName(sel.installedBy))], ['Config', sel.configured ? 'sealed' + (schemaFields.length ? ', ' + schemaFields.length + ' fields' : '') : schemaFields.length ? '<span style="color:var(--warn-fg)">not configured</span>' : 'none']], 1)
            + (miss.length ? UI.notice('<b>Required and not granted:</b> ' + miss.map((c) => '<span class="mono">' + esc(c) + '</span>').join(', ') + '. Enable is refused (409) until granted.', 'warn') : '')
            + (sel.kind === 'script' && sel.source !== 'bundle' && sel.state !== 'removed' ? UI.notice('Script plugins need a signed import bundle while PLUGINS_REQUIRE_SIGNED requires it (the default, scripts); this one was pasted inline.', 'warn') : '')
            + '<div class="hstack"><div class="eyebrow grow">Grants</div><span class="muted" style="font-size:11px">high risk marked</span></div><div class="vstack plugins-grants" data-grants>' + all.map((c) => '<div class="hstack">' + UI.check(c + (sel.optionalCapabilities.indexOf(c) >= 0 ? ' (optional)' : ''), sel.granted.indexOf(c) >= 0, 'data-grant="' + esc(c) + '"' + (sel.state === 'removed' ? ' disabled' : '')) + (RISK[c] === 'high' ? UI.pill('high risk', 'danger') : '') + '</div>').join('') + (all.length ? '' : '<span class="muted" style="font-size:12px">The manifest asks for no capabilities.</span>') + '</div>'
            + '<div class="hstack wrap gap6">' + UI.btn('Save grants', { size: 'sm', attrs: 'data-savegrants', disabled: sel.state === 'removed' || !all.length }) + '<span class="muted" style="font-size:11px">An enabled plugin that loses a required grant is disabled.</span></div>'
            + (d.error ? UI.problem('Details could not be loaded', d.error.message, traceOf(d.error)) : d.loading ? '<span class="muted" style="font-size:12px">Loading…</span>' : '')
            + (m && m.actions && m.actions.length ? '<div class="eyebrow">Actions</div>' + UI.table(['On', 'Action', 'Capability'], m.actions.map((a) => { const cap = ACTION_CAP[a.type] || ''; return ['<span class="mono">' + esc(a.on || 'any') + '</span>', esc(a.type) + ' <span class="muted" style="font-size:11px">' + esc(JSON.stringify(a.with || {}).slice(0, 48)) + '</span>', '<span class="mono">' + esc(cap) + '</span>' + (sel.granted.indexOf(cap) >= 0 ? '' : ' ' + UI.pill('refused when run', 'warn'))]; }), { clickable: false, minWidth: '0', cls: 'bare', attrs: 'data-actions' }) : '')
            + '<div class="hstack wrap gap6">' + (sel.state === 'installed' || sel.state === 'disabled' ? UI.btn('Enable', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-enable' }) : '') + (sel.state === 'enabled' ? UI.btn('Disable', { size: 'sm', icon: 'pause', attrs: 'data-disable' }) : '') + (sel.state !== 'removed' ? UI.btn('Runs', { size: 'sm', attrs: 'data-runsfor="' + esc(sel.key) + '"' }) + UI.btn('Remove', { kind: 'danger', size: 'sm', attrs: 'data-remove' }) : UI.btn('Reinstall', { kind: 'primary', size: 'sm', attrs: 'data-reinstall', disabled: !m || sel.kind === 'script', title: sel.kind === 'script' ? 'A script plugin is reinstalled from its import bundle' : '' })) + '</div>'
            + (d.transitions ? '<div class="eyebrow">Transitions</div>' + UI.timeline(d.transitions.slice().reverse().map((t) => ({ title: esc(t.event) + (t.from ? ' <span class="muted">' + esc(t.from) + ' → ' + esc(t.to) + '</span>' : ' <span class="muted">→ ' + esc(t.to) + '</span>'), text: esc(userName(t.actor)) + (t.reason ? ', ' + esc(t.reason) : '') + ', v' + esc(t.version), meta: esc(when(t.at)), tone: t.to === 'enabled' ? 'ok' : t.to === 'removed' ? 'danger' : t.to === 'disabled' ? 'warn' : '' }))) : '')
            + '<span class="muted" style="font-size:12px"><a href="#" data-goaudit>Audit entries</a>: plugin.installed, .enabled, .disabled, .removed, .grants.updated.</span>';
        }
      }
      // ---------------- Install ----------------
      if (st.tab === 'install') {
        const v = st.validation;
        const avail = st.available || [];
        body += '<div class="grid2">' + UI.panel('Install from a manifest', '<p class="fg2" style="margin:0;font-size:13px">Paste a manifest. Validate reports every problem (422) or the summary; install grants the low-risk capabilities it asks for, high-risk ones only when you name them.</p>' + UI.textarea(st.manifestText == null ? DEFAULT_MANIFEST : st.manifestText, { rows: 9, attrs: 'data-manifest aria-label="Manifest (JSON)" spellcheck="false"' }) + '<div class="hstack wrap gap6">' + UI.btn('Validate', { size: 'sm', attrs: 'data-validate' }) + UI.btn('Install', { kind: 'primary', size: 'sm', attrs: 'data-install' }) + '</div>' + (v ? (v.valid ? UI.notice('<b>Valid.</b> ' + esc(v.summary), 'ok') : UI.problem(v.title || 'Manifest refused (422)', v.errors.join(' '), v.trace || false)) : '') + '<span class="muted" style="font-size:12px">With PLUGINS_REQUIRE_SIGNED at its default (scripts), script plugins are enabled only when installed from a signed import bundle.</span>')
          + UI.panel('Capability vocabulary', UI.table(['Capability', 'Risk', 'What it allows'], CAPS.map((c) => ['<span class="mono">' + esc(c.name) + '</span>', UI.pill(c.risk, c.risk === 'high' ? 'danger' : 'ok'), esc(c.description)]), { clickable: false, minWidth: '0', cls: 'bare' }) + '<span class="muted" style="font-size:12px">A closed vocabulary; a manifest naming anything else is refused. Brokered calls (' + esc(Object.keys(st.caps.calls || {}).slice(0, 6).join(', ')) + '…) map to the same capabilities.</span>') + '</div>'
          + UI.panel('Available in promoted import bundles', (st.availableLoading && !st.available ? UI.notice('Loading…', 'info') : st.availableError ? UI.problem('Bundles could not be read', st.availableError.message, traceOf(st.availableError)) : UI.table(['Bundle', 'Signer', 'Promoted', 'File', 'Plugin', 'Capabilities', { label: 'Action', right: true }], avail.map((a, i) => { const inst = a.manifest && st.plugins.find((p) => p.key === a.manifest.key && p.state !== 'removed'); return [esc(a.bundle.name) + ' <span class="mono muted" style="font-size:11px">' + esc((a.bundle.digest || '').slice(0, 19)) + '</span>', esc(a.bundle.signer || 'unsigned'), esc(when(a.bundle.promotedAt)), '<span class="mono" style="font-size:12px">' + esc(a.path) + '</span>', a.manifest ? esc(a.manifest.name) + ' <span class="mono muted" style="font-size:11px">' + esc(a.manifest.version) + ', ' + esc(a.manifest.kind) + '</span>' : UI.pill('refused', 'danger') + ' <span class="muted" style="font-size:12px">' + esc(a.problem || '') + '</span>', a.manifest ? a.manifest.capabilities.map((c) => UI.pill(c, RISK[c] === 'high' ? 'accent' : 'outline')).join(' ') : '', a.manifest ? (inst ? UI.pill('installed ' + inst.version, 'ok') : UI.btn('Install', { kind: 'primary', size: 'xs', attrs: 'data-import="' + i + '"' })) : '']; }), { clickable: false, minWidth: '900px', emptyTitle: 'No plugin files in promoted bundles', emptyText: 'Signed import bundles with mirror "plugins" appear here once promoted in Platform.' })) + '<span class="muted" style="font-size:12px">Each import reads the file again from the stored transfer and checks the transfer\'s digest, the signature against the signer keys registered now (a key revoked since fails it) and the file\'s sha256 against the signed manifest. A bundle not promoted or failing these checks is 409 Bundle refused. <a href="#" data-goplatform>Bundles are managed in Platform</a>.</span>', { attrs: 'data-bundles' })
          + (st.bundleRefused ? UI.problem('Bundle refused (409)', st.bundleRefused.detail, st.bundleRefused.trace || false) + '<div>' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearrefused' }) + '</div>' : '');
      }
      // ---------------- Catalogue ----------------
      if (st.tab === 'catalogue') {
        const q = st.catQuery.toLowerCase();
        const types = CATALOGUE.types.filter((t) => (st.catGroup === 'all' || t.group === st.catGroup) && (!q || (t.type + ' ' + t.description).toLowerCase().includes(q)));
        if (!st.selType || !CATALOGUE.types.some((t) => t.type === st.selType)) st.selType = CATALOGUE.types.length ? CATALOGUE.types[0].type : null;
        const selT = CATALOGUE.types.find((t) => t.type === st.selType);
        const subscribers = selT ? st.plugins.filter((p) => p.state === 'enabled' && p.events.some((e) => e === selT.type || e === '*' || (e.endsWith('.*') && selT.type.startsWith(e.slice(0, -1))))).map((p) => p.key) : [];
        body += UI.panel('Catalogue version ' + CATALOGUE.version, '<div class="hstack wrap"><span class="fg2 grow" style="font-size:13px">Envelope of every delivery: <span class="mono">{id, type, tenant, label, createdAt, data}</span>; <span class="mono">schema</span> is the JSON Schema of <span class="mono">data</span>. The version moves when a type is added or changes; a type\'s own version only when its data changes incompatibly. ETag and 304 on If-None-Match.</span>' + (App.can('webhooks:manage') ? UI.btn('Webhooks', { kind: 'ghost', size: 'sm', attrs: 'data-gowebhooks' }) : '') + '</div>'
          + '<div class="hstack wrap gap6">' + UI.chip('All groups', st.catGroup === 'all', 'data-group="all"') + CATALOGUE.groups.filter((g) => g.pattern !== '*').map((g) => UI.chip('<span class="mono">' + esc(g.pattern) + '</span>', st.catGroup === g.pattern, 'data-group="' + esc(g.pattern) + '" title="' + esc(g.description) + '"')).join('') + '</div>')
          + '<div class="plugins-cat"><div class="vstack gap12">' + '<div class="toolbar">' + UI.search('Filter types', 'data-catsearch', st.catQuery) + '<span class="muted right" style="font-size:12px">' + types.length + ' of ' + CATALOGUE.types.length + ' named types; every other audit action is delivered with the audit entry as data</span></div>'
          + UI.table(['Type', 'Group', 'Version', 'Since', 'Status', 'Description'], types.map((t) => ({ cells: ['<span class="mono">' + esc(t.type) + '</span>', '<span class="mono muted" style="font-size:12px">' + esc(t.group) + '</span>', '<span class="num">' + esc(t.version) + '</span>', esc(t.since), UI.pill(t.status, t.status === 'emitted' ? 'ok' : ''), esc(t.description)], attrs: 'data-type="' + esc(t.type) + '"', selected: t.type === st.selType })), { minWidth: '720px', emptyTitle: 'No types match' }) + '</div>'
          + (selT ? UI.panel('Schema of ' + selT.type, UI.kv([['Group', '<span class="mono">' + esc(selT.group) + '</span>'], ['Status', UI.pill(selT.status, selT.status === 'emitted' ? 'ok' : '')], ['Version', esc(selT.version)], ['Since', esc(selT.since)]], 2) + UI.code(JSON.stringify(selT.schema, null, 2), 'json') + '<span class="muted" style="font-size:12px">A mismatch between an emitted event and this schema is still delivered, counted in exprsn_event_schema_violations_total{type} and logged. Subscribed by: ' + esc(subscribers.join(', ') || 'no enabled plugin') + '.</span>') : '') + '</div>';
      }
      // ---------------- Runs ----------------
      if (st.tab === 'runs') {
        const rows = runs.filter((i) => st.invState === 'all' || i.state === st.invState);
        if (!rows.some((i) => i.id === st.selInv)) st.selInv = rows.length ? rows[0].id : null;
        const sel = runs.find((i) => i.id === st.selInv);
        const failed = runs.filter((i) => i.state === 'failed');
        body += (st.example === 'loop' ? UI.problem('Invocation failed and loop dropped', 'A record.updated caused by the plugin\'s own write carries the plugin in its chain and is never delivered to it (exprsn_plugin_dropped_total reason loop). The write refused for a restricted record failed its invocation. (Example.)', false) + '<div>' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearexample' }) + '</div>' : '')
          + (st.example === 'host' ? UI.problem('Endpoint refused (422)', 'A webhook action to a host outside the tenant\'s allowed hosts is 422 at install, at enable and at every attempt. Three attempts failed, the delivery is counted and the breaker is open. Add the host to the tenant\'s allowed hosts in Tenants, then enable again. (Example.)', false) + '<div>' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearexample' }) + '</div>' : '')
          + (st.runsError ? UI.problem('Runs could not be loaded', st.runsError.message, traceOf(st.runsError)) : '')
          + '<div class="stats">' + UI.stat(String(runs.filter((i) => i.state === 'succeeded').length), 'succeeded', 'of the newest 50 per plugin') + UI.stat('<span style="color:var(--danger-fg)">' + failed.length + '</span>', 'failed', failed.length ? 'last: ' + esc(failed[0].plugin) : 'none') + UI.stat(String(runs.filter((i) => i.state === 'cancelled').length), 'cancelled', 'plugin no longer enabled when the job ran') + UI.stat(String(runs.filter((i) => i.state === 'queued' || i.state === 'running').length), 'queued or running', 'refreshes while any are open') + '</div>'
          + '<div class="toolbar"><span class="relative">' + UI.btn(st.invState === 'all' ? 'State' : 'State: ' + st.invState, { size: 'sm', icon: 'filter', attrs: 'data-menu="inv"', cls: st.invState !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn(st.invPlugin === 'all' ? 'Plugin' : 'Plugin: ' + st.invPlugin, { size: 'sm', icon: 'filter', attrs: 'data-menu="invplugin"', cls: st.invPlugin !== 'all' ? 'active' : '' }) + '</span>' + UI.btn('Refresh', { size: 'sm', icon: 'refresh', attrs: 'data-runsrefresh' }) + '<span class="muted right" style="font-size:12px">' + (st.runsLoading && !st.runs ? 'Loading runs' : rows.length + ' of ' + runs.length + ' invocations, newest first') + '</span></div>'
          + UI.table(['Invocation', 'Plugin', 'Event', 'Label', 'State', 'Attempts', 'Chain', 'Outcome', 'Started', 'Finished'], rows.map((i) => ({ cells: ['<span class="mono">' + esc(i.id.slice(-8)) + '</span>', '<a href="#" data-openplugin="' + esc(i.plugin) + '">' + esc(i.plugin) + '</a>', '<span class="mono">' + esc(i.event) + '</span>', UI.label(i.label, { sm: true }), UI.pill(i.state, invKind(i.state)), '<span class="num">' + esc(i.attempts) + '</span>', '<span class="num">' + i.chain.length + '</span>', outcomeCell(i), esc(clock(i.startedAt)), esc(clock(i.finishedAt))], attrs: 'data-inv="' + esc(i.id) + '" data-plugin-key="' + esc(i.plugin) + '"', selected: i.id === st.selInv })), { minWidth: '1000px', emptyTitle: st.plugins.length ? 'No invocations match' : 'No plugins installed', emptyText: 'Events reach enabled plugins as jobs; each delivery is listed here.' })
          + '<span class="muted" style="font-size:12px">An event reaches a plugin once. A declarative plugin runs its actions in order (an ungranted one is refused and audited plugin.action.refused; the others still run); a script handler runs in the sandbox and reaches the platform only through the broker with a scoped token (PLUGIN_MAX_CALLS calls, revoked when the handler ends). <a href="#" data-goaudit>Audit</a>.</span>';
        if (sel) { loadLogs(sel); insp = invocationPanel(sel, st.logs[sel.id]); }
      }

      root.innerHTML = style
        + '<div class="page">' + head(UI.pill(enabled + ' enabled', 'ok') + UI.btn('Install plugin', { kind: 'primary', icon: 'plus', attrs: 'data-goinstall' }))
        + tabs + body
        + '</div>'
        + (insp ? '<aside class="inspector w360 plugins-insp" aria-label="Inspector">' + insp + '</aside>' : '');

      // ---- events ----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; if (st.tab === 'runs') st.runs = null; ctx.rerender(); });
      ctx.on('click', '[data-goinstall]', () => { st.tab = 'install'; ctx.rerender(); });
      ctx.on('click', '[data-gobundle]', () => { st.tab = 'install'; st.problem = null; ctx.rerender(); const el = ctx.$('[data-bundles]'); if (el) el.scrollIntoView({ block: 'start' }); });
      ctx.on('click', '[data-goplatform]', (e) => { e.preventDefault(); ctx.navigate('platform'); });
      ctx.on('click', '[data-goaudit]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
      ctx.on('click', '[data-gowebhooks]', () => ctx.navigate('tenants'));
      ctx.on('click', 'tr[data-plugin]', (e, t) => { st.sel = t.dataset.plugin; st.problem = null; ctx.rerender(); });
      ctx.on('click', 'tr[data-type]', (e, t) => { st.selType = t.dataset.type; ctx.rerender(); });
      ctx.on('click', 'tr[data-inv]', (e, t) => { if (e.target.closest('a')) return; st.selInv = t.dataset.inv; ctx.rerender(); });
      ctx.on('click', '[data-openplugin]', (e, t) => { e.preventDefault(); const p = st.plugins.find((x) => x.key === t.dataset.openplugin); if (p) { st.tab = 'plugins'; st.sel = p.id; st.stateFilter = 'all'; st.kindFilter = 'all'; st.query = ''; if (p.state === 'removed') st.showRemoved = true; ctx.rerender(); } });
      ctx.on('click', '[data-runsfor]', (e, t) => { st.tab = 'runs'; st.invPlugin = t.dataset.runsfor; st.invState = 'all'; st.runs = null; ctx.rerender(); });
      ctx.on('click', '[data-runsrefresh]', () => { st.logs = {}; loadRuns(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
      ctx.on('input', '[data-catsearch]', (e, t) => { st.catQuery = t.value; ctx.rerender(); const i = ctx.$('[data-catsearch]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
      ctx.on('input', '[data-manifest]', (e, t) => { st.manifestText = t.value; });
      ctx.on('change', '[data-showremoved]', (e, t) => { st.showRemoved = t.checked; ctx.rerender(); });
      ctx.on('click', '[data-group]', (e, t) => { st.catGroup = t.dataset.group; ctx.rerender(); });
      ctx.on('click', '[data-clearproblem]', () => { st.problem = null; ctx.rerender(); });
      ctx.on('click', '[data-clearrefused]', () => { st.bundleRefused = null; ctx.rerender(); });
      ctx.on('click', '[data-clearexample]', () => { st.example = null; ctx.rerender(); });
      ctx.on('click', '[data-menu]', (e, t) => {
        const k = t.dataset.menu;
        if (k === 'state') menu(ctx, t, [['all', 'Every state'], ['installed', 'Installed'], ['enabled', 'Enabled'], ['disabled', 'Disabled'], ['removed', 'Removed']], st.stateFilter, (v) => { st.stateFilter = v; if (v === 'removed') st.showRemoved = true; ctx.rerender(); });
        if (k === 'kind') menu(ctx, t, [['all', 'Every kind'], ['declarative', 'Declarative'], ['webhook', 'Webhook'], ['script', 'Script']], st.kindFilter, (v) => { st.kindFilter = v; ctx.rerender(); });
        if (k === 'inv') menu(ctx, t, [['all', 'Every state'], ['queued', 'Queued'], ['running', 'Running'], ['succeeded', 'Succeeded'], ['failed', 'Failed'], ['cancelled', 'Cancelled']], st.invState, (v) => { st.invState = v; ctx.rerender(); });
        if (k === 'invplugin') menu(ctx, t, [['all', 'Every plugin']].concat(st.plugins.map((p) => [p.key, p.key])), st.invPlugin, (v) => { st.invPlugin = v; st.runs = null; ctx.rerender(); });
      });

      // plugin lifecycle
      const sel = st.plugins.find((p) => p.id === st.sel);
      const path = () => '/api/admin/plugins/' + enc(sel.id);
      ctx.on('click', '[data-enable]', async () => {
        const v = await ask(ctx, { title: 'Enable ' + sel.name, tone: 'info', body: '<p class="fg2" style="margin:0">Events it subscribes to (' + esc(sel.events.join(', ') || 'none') + ') at or below ' + esc(sel.maxLabel) + ' reach it as jobs from now on, with the grants it holds.</p>' + reasonField(), ok: 'Enable' });
        if (!v) return;
        try {
          await App.post(path() + '/enable', v.reason ? { reason: v.reason } : {});
          st.problem = null; ctx.toast(esc(sel.key) + ' enabled. Audited plugin.enabled; plugin.changed published on the bus.', 'ok');
        } catch (err) {
          const p = err.problem || {};
          if (err.status === 409 && p.missing) st.problem = { kind: 'missing', key: sel.key, missing: p.missing, trace: p.trace_id };
          else if (err.status === 409 && /signed/.test(err.message)) st.problem = { kind: 'unsigned', key: sel.key, detail: err.message, trace: p.trace_id };
          else if (err.status === 409 || err.status === 422) st.problem = { kind: 'refused', title: 'Cannot enable ' + sel.key + ' (' + err.status + ')', detail: err.message, trace: p.trace_id };
          else App.fail(err, 'Could not enable');
        }
        reload(sel.id);
      });
      ctx.on('click', '[data-disable]', async () => {
        const v = await ask(ctx, { title: 'Disable ' + sel.name, tone: 'warn', tag: 'stops deliveries', body: '<p class="fg2" style="margin:0">Running invocations finish; nothing new is delivered and queued ones are cancelled. Grants and config are kept.</p>' + reasonField(), ok: 'Disable' });
        if (!v) return;
        try { await App.post(path() + '/disable', v.reason ? { reason: v.reason } : {}); ctx.toast(esc(sel.key) + ' disabled. Audited plugin.disabled.', 'warn'); } catch (err) { App.fail(err, 'Could not disable'); }
        reload(sel.id);
      });
      ctx.on('click', '[data-remove]', async () => {
        const v = await ask(ctx, { title: 'Remove ' + sel.name, tone: 'danger', tag: 'removed', body: '<p class="fg2" style="margin:0">The plugin becomes removed: its webhooks named plugin:' + esc(sel.key) + ':… are removed, its config stays sealed until reinstall. Reinstalling keeps the id with a new manifest.</p>' + reasonField('Reason'), ok: 'Remove' });
        if (!v) return;
        try { await App.del(path() + (v.reason ? '?reason=' + enc(v.reason) : '')); st.showRemoved = true; ctx.toast(esc(sel.key) + ' removed. Audited plugin.removed.', 'danger'); } catch (err) { App.fail(err, 'Could not remove'); }
        reload(sel.id);
      });
      ctx.on('click', '[data-reinstall]', async () => {
        const d = st.details[sel.id];
        if (!d || !d.manifest) return;
        const v = await ask(ctx, { title: 'Reinstall ' + sel.name, tone: 'info', body: '<p class="fg2" style="margin:0">Installs the same manifest again under the same id. Grants default to the low-risk capabilities it asks for.</p><div class="formgrid">' + maxLabelField(sel.maxLabel) + reasonField() + '</div>', ok: 'Reinstall' });
        if (!v) return;
        const body = { manifest: d.manifest, maxLabel: v.maxLabel };
        if (v.reason) body.reason = v.reason;
        try { await App.post('/api/admin/plugins', body); ctx.toast(esc(sel.key) + ' reinstalled with the same id; low-risk grants restored. Audited plugin.reinstalled.', 'ok'); } catch (err) { App.fail(err, 'Could not reinstall'); }
        reload(sel.id);
      });
      ctx.on('click', '[data-savegrants]', async () => {
        const next = ctx.$$('[data-grant]').filter((c) => c.checked).map((c) => c.dataset.grant);
        const added = next.filter((c) => sel.granted.indexOf(c) < 0), removed = sel.granted.filter((c) => next.indexOf(c) < 0);
        if (!added.length && !removed.length) { ctx.toast('Grants unchanged.'); return; }
        const high = added.filter((c) => RISK[c] === 'high');
        let reason = '';
        if (high.length || (removed.length && sel.state === 'enabled')) {
          const v = await grantsDialog(ctx, { key: sel.key, name: sel.name, state: sel.state, required: sel.capabilities.filter((c) => sel.optionalCapabilities.indexOf(c) < 0), risk: RISK }, added, removed, false);
          if (!v) return;
          reason = v.reason || '';
        }
        try {
          const out = await App.api('PUT', path() + '/grants', reason ? { grants: next, reason } : { grants: next });
          const off = sel.state === 'enabled' && out.state === 'disabled';
          ctx.toast('Grants saved for ' + esc(sel.key) + '. Audited plugin.grants.updated (added ' + added.length + ', removed ' + removed.length + ', highRisk ' + high.length + ').' + (off ? ' It lost required ' + esc(out.missing.join(', ')) + ' and is disabled.' : ''), off ? 'warn' : 'ok', 5000);
        } catch (err) { App.fail(err, 'Grants not saved'); }
        reload(sel.id);
      });

      // install
      const readManifest = () => {
        st.manifestText = ctx.$('[data-manifest]').value;
        try { return JSON.parse(st.manifestText); } catch (e) { st.validation = { valid: false, title: 'Not valid JSON', errors: ['The manifest is not valid JSON: ' + e.message + '.'] }; ctx.rerender(); return null; }
      };
      const refusedManifest = (err) => { const p = err.problem || {}; st.validation = { valid: false, title: (p.title || 'Refused') + ' (' + err.status + ')', errors: Array.isArray(p.errors) && p.errors.length ? p.errors.map((x) => typeof x === 'string' ? x : (x.path ? x.path + ': ' : '') + x.message) : [err.message], trace: p.trace_id }; };
      const summary = (m) => m.kind + ' plugin ' + m.key + ' ' + m.version + ', ' + (m.events || []).length + ' event subscriptions, ' + (m.capabilities || []).length + ' capabilities (' + (m.capabilities || []).filter((c) => RISK[c] === 'high').length + ' high risk)' + (m.actions ? ', ' + m.actions.length + ' actions' : '') + '.';
      ctx.on('click', '[data-validate]', async () => {
        const m = readManifest(); if (!m) return;
        try { const r = await App.post('/api/admin/plugins/validate', { manifest: m }); st.validation = { valid: true, summary: summary(r.manifest) }; } catch (err) { if (err.status === 422 || err.status === 400) refusedManifest(err); else App.fail(err, 'Could not validate'); }
        ctx.rerender();
      });
      ctx.on('click', '[data-install]', async () => {
        const m = readManifest(); if (!m) return;
        const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
        const low = caps.filter((c) => RISK[c] === 'low'), high = caps.filter((c) => RISK[c] === 'high');
        const v = await ask(ctx, { title: 'Install ' + (m.name || m.key || 'plugin'), tone: 'info', body: '<p class="fg2" style="margin:0">Grants default to the low-risk capabilities it asks for (' + esc(low.join(', ') || 'none') + ').' + (high.length ? ' High-risk ones (' + esc(high.join(', ')) + ') stay ungranted until you name them in the inspector.' : '') + '</p><div class="formgrid">' + maxLabelField('internal') + reasonField() + '</div>', kv: [['Key', esc(m.key || '')], ['Kind', esc(m.kind || '')], ['Events', esc((m.events || []).join(', ') || 'none')]], ok: 'Install' });
        if (!v) return;
        const body = { manifest: m, maxLabel: v.maxLabel };
        if (v.reason) body.reason = v.reason;
        try {
          const p = await App.post('/api/admin/plugins', body);
          Object.assign(st, { validation: null, stateFilter: 'all', kindFilter: 'all', query: '', tab: 'plugins' });
          ctx.toast(esc(p.key) + ' installed with ' + p.granted.length + ' grants. Audited plugin.installed. Enable it when ready.', 'ok', 5000);
          reload(p.id);
        } catch (err) {
          if (err.status === 422 || err.status === 400 || err.status === 409 || err.status === 403) { refusedManifest(err); ctx.rerender(); } else App.fail(err, 'Could not install');
        }
      });
      ctx.on('click', '[data-import]', async (e, t) => {
        const a = (st.available || [])[+t.dataset.import];
        if (!a || !a.manifest) return;
        const v = await ask(ctx, { title: 'Install ' + a.manifest.name + ' from ' + a.bundle.name, tone: 'info', body: '<p class="fg2" style="margin:0">The file is read again from the stored transfer; its digest, the bundle signature and the file\'s sha256 against the signed manifest are checked first. A script plugin from a promoted bundle may be enabled.</p><div class="formgrid">' + maxLabelField('internal') + reasonField() + '</div>', kv: [['Path', esc(a.path)], ['sha256', '<span class="mono">' + esc(a.sha256.slice(0, 16)) + '…</span>'], ['Capabilities', esc(a.manifest.capabilities.join(', '))]], ok: 'Install' });
        if (!v) return;
        const body = { bundle: a.bundle.id, path: a.path, maxLabel: v.maxLabel };
        if (v.reason) body.reason = v.reason;
        try {
          const p = await App.post('/api/admin/plugins/import', body);
          st.tab = 'plugins'; st.problem = null; st.bundleRefused = null; st.available = null;
          ctx.toast(esc(p.key) + ' ' + esc(p.version) + ' installed from ' + esc(a.bundle.name) + '. Audited plugin.installed with source bundle.', 'ok', 5000);
          reload(p.id);
        } catch (err) {
          if (err.status === 409) { st.bundleRefused = { detail: err.message, trace: err.problem && err.problem.trace_id }; ctx.rerender(); } else App.fail(err, 'Could not install from the bundle');
        }
      });

      // runs
      ctx.on('click', '[data-fulllog]', () => {
        const i = runs.find((x) => x.id === st.selInv); if (!i) return;
        const lines = (st.logs[i.id] || {}).logs || [];
        ctx.drawer({ title: 'Log of ' + esc(i.id), body: '<div class="muted" style="font-size:12px">GET /admin/plugins/' + esc(i.plugin) + '/logs?invocation=' + esc(i.id) + ', opened from the sealed log, oldest first.</div>' + (lines.length ? UI.code(lines.slice().reverse().map((x) => clock(x.at) + ' ' + x.level.toUpperCase() + ' ' + x.message).join('\n'), 'log') : UI.empty('No log lines', 'The plugin has not written anything for this invocation.')), actions: UI.btn('Close', { attrs: 'data-close' }) });
      });
    }
  });

  /** The confirmation for a grants change; with example set it only shows what such a change does. */
  function grantsDialog(ctx, p, added, removed, example) {
    const risk = p.risk || {};
    const high = added.filter((c) => risk[c] === 'high');
    const lost = removed.filter((c) => p.required.indexOf(c) >= 0);
    const body = (removed.length ? '<p class="fg2" style="margin:0">' + esc(p.name) + ' loses ' + removed.map((c) => '<span class="mono">' + esc(c) + '</span>').join(', ') + '. Its next action that needs ' + (removed.length === 1 ? 'it' : 'one of them') + ' is refused (403, audited plugin.action.refused or plugin.call.refused).</p>' : '')
      + (lost.length && p.state === 'enabled' ? UI.notice('<b>Required:</b> ' + lost.map((c) => '<span class="mono">' + esc(c) + '</span>').join(', ') + (lost.length === 1 ? ' is' : ' are') + ' required by the manifest, so the plugin is disabled at once (grants, enabled → disabled).', 'warn') : '')
      + (high.length ? '<p class="fg2" style="margin:0">' + esc(p.name) + ' would hold ' + high.map((c) => '<span class="mono">' + esc(c) + '</span>').join(', ') + '. Webhook calls stay inside the tenant\'s allowed hosts; workflows run as the installer; record and post writes are audited to the plugin.</p>' : '')
      + (example ? UI.notice('Example: nothing is changed from this dialog.', 'info') : reasonField());
    return ask(ctx, { title: high.length ? 'Grant high-risk capabilities' : 'Revoke grants', tag: high.length ? 'high risk' : lost.length && p.state === 'enabled' ? 'disables plugin' : 'revoke', tone: high.length || lost.length ? 'danger' : 'warn', body, kv: [['Plugin', '<span class="mono">' + esc(p.key) + '</span>'], ['State', esc(p.state)]], ok: example ? 'Close' : 'Save grants' });
  }

  function outcomeCell(i) {
    let out = '';
    if (i.outcome && i.outcome.actions) out = i.outcome.actions.map((a) => UI.pill(a.type + (a.ok ? '' : a.status === 403 ? ' refused (403)' : ' ' + (a.status || 'failed')), a.ok ? 'ok' : 'danger')).join(' ');
    else if (i.outcome && i.outcome.calls) out = i.outcome.calls.map((c) => UI.pill(c.api + ' ' + (c.status === 403 ? 'refused (403)' : c.status), c.status < 300 ? 'ok' : 'danger')).join(' ') + ' <span class="muted" style="font-size:11px">exit ' + esc(i.outcome.exitCode) + ', ' + esc(i.outcome.durationMs) + ' ms</span>';
    if (i.error) out += out ? '<div style="color:var(--warn-fg);font-size:12px">' + esc(i.error) + '</div>' : '<span style="color:var(--warn-fg);font-size:12px">' + esc(i.error) + '</span>';
    return out || '<span class="muted">none yet</span>';
  }
  function invocationPanel(i, l) {
    l = l || { loading: true };
    return '<div class="hstack"><div class="eyebrow grow">Invocation</div>' + UI.pill(i.state, invKind(i.state)) + '</div><div style="font-size:13px;font-weight:600" class="mono">' + esc(i.id) + '</div>'
      + UI.kv([['Plugin', '<a href="#" data-openplugin="' + esc(i.plugin) + '">' + esc(i.plugin) + '</a>'], ['Event', '<span class="mono">' + esc(i.event) + '</span>'], ['Label', UI.label(i.label, { sm: true })], ['Attempts', esc(i.attempts)], ['Chain', i.chain.length ? i.chain.map((c) => '<span class="mono">' + esc(String(c).slice(-6)) + '</span>').join(' → ') : 'none'], ['Created', esc(when(i.createdAt))], ['Started', esc(i.startedAt ? when(i.startedAt) : 'not yet')], ['Finished', esc(i.finishedAt ? when(i.finishedAt) : 'not yet')]], 2)
      + (i.state === 'cancelled' && i.error ? UI.notice('<b>Not run.</b> ' + esc(i.error), 'warn') : i.error ? UI.notice('<b>Failed.</b> ' + esc(i.error), 'danger') : '')
      + (i.outcome ? '<div class="eyebrow">Outcome</div>' + UI.code(JSON.stringify(i.outcome, null, 2), 'json') : '')
      + '<div class="hstack"><div class="eyebrow grow">Log</div>' + UI.btn('Open full log', { kind: 'ghost', size: 'xs', attrs: 'data-fulllog', disabled: !l.logs }) + '</div>'
      + (l.error ? UI.problem('The log could not be read', l.error.message, traceOf(l.error)) : l.loading ? '<span class="muted" style="font-size:12px">Loading…</span>' : l.logs.length ? '<div class="vstack gap4" style="font-size:12px">' + l.logs.slice(0, 20).map((x) => '<div class="hstack gap6" style="align-items:flex-start">' + UI.pill(x.level, x.level === 'error' ? 'danger' : x.level === 'warn' ? 'warn' : '') + '<span class="mono muted">' + esc(clock(x.at)) + '</span><span>' + esc(x.message) + '</span></div>').join('') + '</div>' : '<span class="muted" style="font-size:12px">No log lines for this invocation.</span>')
      + '<span class="muted" style="font-size:12px">Logs are opened from the sealed log; a handler\'s output and return value land here too.</span>';
  }
})();
