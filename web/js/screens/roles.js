(function () {
  const { UI, esc } = App;

  // Roles and access (B-3412) over the Sprint 29 authz API (docs/api.md, "permission matrices, custom roles and
  // access reviews"): the role × permission matrix, custom roles with versions, diff and dual control, the
  // effective-access matrix whose every cell opens policy.explain, "who can", and access reviews.

  // The catalogue's areas, for grouping and filtering only; the permissions themselves come from
  // GET /api/authz/matrix, and any the table below does not name fall under "Other".
  const AREAS = [
    ['Workspace', ['chat:read', 'chat:write', 'inference:invoke', 'context:read', 'context:write', 'images:generate', 'tools:invoke', 'agents:run', 'scripts:run', 'memory:write', 'knowledge:read']],
    ['Admin areas', ['models:read', 'models:manage', 'pools:manage', 'profiles:manage', 'tools:manage', 'agents:manage', 'mcp:manage', 'workflows:manage', 'guardrails:manage', 'flags:review', 'classifiers:manage', 'knowledge:manage', 'connections:manage', 'training:submit', 'training:manage', 'identity:manage', 'users:manage', 'tenant:manage', 'zones:manage', 'platform:manage', 'audit:read', 'usage:read', 'roles:manage']],
    ['Integrations', ['webhooks:manage', 'prompts:manage', 'billing:read', 'billing:manage']],
    ['Vault', ['secrets:read', 'secrets:write', 'secrets:admin']],
    ['Certificates', ['pki:manage']],
    ['Plugins', ['plugins:manage']],
    ['AT-Protocol', ['labels:manage', 'atproto:link', 'firehose:manage']],
    ['Files', ['files:read', 'files:write']],
    ['Moderation', ['moderation:check', 'moderation:report', 'moderation:appeal', 'moderation:review', 'moderation:sanction', 'moderation:manage']],
    ['Members', ['members:invite']],
    ['Apps', ['apps:design', 'records:read', 'records:write']],
    ['Groups', ['groups:read', 'groups:write', 'groups:manage']],
    ['Channels', ['channels:manage', 'channels:review']],
    ['Social', ['social:read', 'social:write', 'social:manage']],
    ['Messages', ['messages:read', 'messages:write']],
    ['Feed', ['feed:read', 'feed:write', 'feed:manage']]
  ];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const RANK = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  const STEP_NAME = { role: 'role', scope: 'scopes', tenant: 'tenant', clearance: 'clearance', zone: 'zone ceiling' };
  const WS_URL = '/api/authz/access?permissions=chat:read&limit=1';
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const overlayOpen = () => !!document.getElementById('overlay');
  const meId = () => (App.me && App.me.user ? App.me.user.id : null);

  /** Groups permission ids by area, in catalogue order. */
  function grouped(perms) {
    const known = {}; AREAS.forEach((g) => g[1].forEach((p) => { known[p] = g[0]; }));
    const out = AREAS.map((g) => [g[0], g[1].filter((p) => perms.indexOf(p) >= 0)]);
    const other = perms.filter((p) => !known[p]);
    if (other.length) out.push(['Other', other]);
    return out.filter((g) => g[1].length);
  }
  const areaOf = (p) => (AREAS.find((g) => g[1].indexOf(p) >= 0) || ['Other'])[0];

  App.register({
    id: 'roles', title: 'Roles and access', live: true, section: 'admin',
    summary: 'Role × permission matrix, custom roles with diff and dual control, effective access with explain, access reviews',
    crumb: ['Admin', 'Roles and access'],
    commands: [
      { label: 'Who can … (effective access)', sub: 'Roles and access', run(app) { const s = app.stateFor('roles'); s.tab = 'effective'; s.whoCan = true; app.render(); } },
      { label: 'Create a custom role', sub: 'Roles and access', run(app) { const s = app.stateFor('roles'); s.tab = 'custom'; s.openCreate = true; app.render(); } }
    ],
    states: [
      { title: 'Creator ceiling refused', tone: 'danger', text: 'A tenant admin cannot create a role holding platform:manage: 403, the permission is outside what they hold.', apply(ctx) { const st = ctx.state; st.tab = 'custom'; st.openCreate = { actAs: 'tenant-admin', perms: ['platform:manage'], problem: 'platform:manage' }; ctx.rerender(); } },
      { title: 'Dual control pending', tone: 'warn', text: 'A custom role holding admin permissions waits for a second admin before it can be granted.', apply(ctx) { const st = ctx.state; st.tab = 'custom'; st.wantPending = true; ctx.rerender(); } },
      { title: 'Denied by zone ceiling', tone: 'info', text: 'The explain drawer shows every step; here the zone ceiling stops a restricted resource although the role and clearance allow.', apply(ctx) { const st = ctx.state; st.tab = 'effective'; st.whoCan = false; st.label = 'restricted'; st.effArea = 'Workspace'; st.wantZoneDeny = true; ctx.rerender(); } },
      { title: 'Review overdue, escalated', tone: 'danger', text: 'A campaign past its due date escalates to the tenant admins and notifies them; the reviewer still decides.', apply(ctx) { const st = ctx.state; st.tab = 'reviews'; st.wantOverdue = true; ctx.rerender(); } },
      { title: 'Revoked grant gone', tone: 'ok', text: 'A revoked grant is written to the audit chain and is gone on the member\'s next request.', apply(ctx) { const st = ctx.state; st.tab = 'reviews'; st.wantRevoked = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.data = st.data || {}; st.errs = st.errs || {}; st.flight = st.flight || {};
      st.tab = st.tab || 'matrix'; st.area = st.area || 'all'; st.roleFilter = st.roleFilter || 'all'; st.q = st.q || '';
      st.label = st.label || ''; st.zone = st.zone || ''; st.effArea = st.effArea || 'Workspace'; st.effPerm = st.effPerm || 'knowledge:read'; st.userQ = st.userQ || '';
      if (ctx.params.role) { st.tab = 'custom'; st.role = ctx.params.role; delete ctx.params.role; }
      if (ctx.params.perm) { st.tab = 'effective'; st.whoCan = true; st.effPerm = ctx.params.perm; delete ctx.params.perm; }
      if (ctx.params.user) { st.tab = 'effective'; st.whoCan = false; st.userQ = ctx.params.user; delete ctx.params.user; }
      if (ctx.params.review) { st.tab = 'reviews'; st.review = ctx.params.review; delete ctx.params.review; }

      const later = () => { if (App.state.route !== 'roles') return; if (overlayOpen()) { setTimeout(later, 250); return; } ctx.rerender(); };
      // Every read is cached by its URL in ctx.state; `need` starts it once and re-renders when it lands.
      const need = (url) => {
        if (Object.prototype.hasOwnProperty.call(st.data, url)) return st.data[url];
        if (st.errs[url] || st.flight[url]) return undefined;
        st.flight[url] = true;
        App.get(url).then((d) => { st.data[url] = d; }).catch((err) => { st.errs[url] = err; }).finally(() => { delete st.flight[url]; later(); });
        return undefined;
      };
      const forget = (prefix) => { [st.data, st.errs].forEach((o) => Object.keys(o).forEach((k) => { if (k.indexOf(prefix) === 0) delete o[k]; })); };
      const h = { need, forget, errs: st.errs };

      const base = ['/api/authz/matrix', '/api/authz/roles?retired=true', '/api/authz/reviews?limit=200'].concat(App.can('users:manage') ? ['/api/admin/users?limit=500'] : []);
      const got = base.map(need);
      const firstErr = base.map((u) => st.errs[u]).filter(Boolean)[0];
      const head = UI.pagehead('Roles and access', 'Every answer here comes from the one policy pipeline (role, scopes, tenant, clearance, zone ceiling). Custom roles are defined by the tenant only; access reviews are assigned to the admins of each grant and the member\'s directory manager (the admins alone when the manager attribute is empty); the first decision stands.', '<span class="relative">' + UI.btn('Export matrix', { size: 'sm', icon: 'download', attrs: 'data-export' }) + '</span>' + UI.btn('Who can…', { size: 'sm', icon: 'search', attrs: 'data-whocan' }));
      if (firstErr || got.some((x) => x === undefined)) {
        root.innerHTML = '<div class="page">' + head + (firstErr ? UI.problem('Roles and access could not be loaded', firstErr.message, firstErr.problem && firstErr.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.errs = {}; ctx.rerender(); });
        return;
      }
      const matrix = got[0], roles = got[1], reviews = got[2];
      const model = { matrix, roles, users: got[3] || [], reviews, adminPerm: {} };
      matrix.permissions.forEach((p) => { model.adminPerm[p.id] = p.admin; });
      model.userName = (id) => { const u = model.users.find((x) => x.id === id); return u ? (u.displayName || u.username) : id === meId() ? 'you' : id ? 'user ' + String(id).slice(-6) : ''; };
      model.holders = (roleId) => model.users.filter((u) => u.roles.indexOf(roleId) >= 0);

      const liveCustom = roles.custom.filter((r) => r.state !== 'retired');
      const openReviews = reviews.filter((r) => r.state === 'open').length;
      const tabs = UI.tabs([{ id: 'matrix', label: 'Role matrix' }, { id: 'custom', label: 'Custom roles', count: liveCustom.length }, { id: 'effective', label: 'Effective access' }, { id: 'reviews', label: 'Access reviews', count: openReviews }], st.tab);
      const rv = st.tab === 'reviews' ? renderReviews(st, model, h) : null;
      const body = st.tab === 'matrix' ? renderMatrix(st, model) : st.tab === 'custom' ? renderCustom(st, model, h) : st.tab === 'effective' ? renderEffective(st, model, h) : rv.main;
      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .roles-matrix{overflow-x:auto;overflow-y:hidden;border:1px solid var(--line);border-radius:8px;background:var(--panel)}#main .roles-matrix table{border-collapse:separate;border-spacing:0;font-size:12px;min-width:100%}'
        + '#main .roles-matrix thead th{position:sticky;top:0;background:var(--panel2);z-index:2;padding:6px 8px;text-align:center;font-weight:600;white-space:nowrap;border-bottom:1px solid var(--line)}#main .roles-matrix tbody th,#main .roles-matrix thead th:first-child{position:sticky;left:0;background:var(--panel);text-align:left;z-index:3;border-right:1px solid var(--line);font-weight:400;padding:4px 8px;border-bottom:1px solid var(--line)}#main .roles-matrix thead th:first-child{z-index:4;background:var(--panel2);font-weight:600}'
        + '#main .roles-matrix td{padding:4px 8px;text-align:center;border-bottom:1px solid var(--line)}#main .roles-matrix td.on{color:var(--ok-fg);font-weight:700}#main .roles-matrix td.off{color:var(--muted)}#main .roles-matrix .area td{background:var(--panel2);text-align:left;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}'
        + '#main .roles-matrix button.permlink{background:none;border:0;padding:0;font:inherit;color:var(--fg);cursor:pointer;font-family:var(--mono);font-size:12px;text-align:left;text-decoration:underline;text-decoration-color:var(--line2)}#main .roles-matrix button.permlink:hover{text-decoration-color:currentColor}'
        + '#main .roles-cell{border:1px solid transparent;font:inherit;cursor:pointer;min-width:34px;width:100%;height:26px;border-radius:4px;background:transparent;color:var(--muted)}#main .roles-cell.allow{background:var(--ok-bg);color:var(--ok-fg)}#main .roles-cell.deny{background:var(--danger-bg);color:var(--danger-fg)}#main .roles-cell:hover{outline:2px solid var(--accent)}#main .roles-cell:focus-visible{outline:2px solid var(--accent);outline-offset:1px}'
        + '#main .roles-perms{display:flex;flex-wrap:wrap;gap:4px}'
        // The custom-role form opens in a dialog outside #main; its check boxes keep a 24 px target spacing (WCAG 2.5.8).
        + '.roles-pick label.check{min-height:26px;align-items:center}.roles-pick input[type=checkbox]{width:18px;height:18px;margin:0 2px 0 0}'
        + '</style>'
        + (rv ? rv.left : '') + '<div class="page">' + head
        + (st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-demook' })) : '')
        + tabs + body + '</div>';

      ctx.on('click', '.tabs [data-tab]', (e, t) => { st.tab = t.dataset.tab; st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-demook]', () => { st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-export]', (e, t) => openMenu(ctx, t, [['csv', 'CSV (role-matrix.csv)'], ['json', 'JSON'], ['md', 'docs/permissions.md (generated)']], null, (v) => {
        if (v === 'md') { ctx.toast('docs/permissions.md is generated from the same catalogue (npm run docs:permissions); the test suite fails when it drifts.'); return; }
        const a = document.createElement('a'); a.href = '/api/authz/matrix' + (v === 'csv' ? '?format=csv' : ''); a.download = v === 'csv' ? 'role-matrix.csv' : 'role-matrix.json';
        document.body.appendChild(a); a.click(); a.remove();
        ctx.toast('Matrix exported as ' + v.toUpperCase() + ': ' + matrix.permissions.length + ' permissions × ' + matrix.roles.length + ' roles.', 'ok');
      }));
      ctx.on('click', '[data-whocan]', () => { st.tab = 'effective'; st.whoCan = true; ctx.rerender(); });
      wireMatrix(ctx, st, model); wireCustom(ctx, st, model, h); wireEffective(ctx, st, model, h); wireReviews(ctx, st, model, h);
    }
  });

  // ---------------- Role matrix ----------------
  function renderMatrix(st, model) {
    const m = model.matrix;
    const all = m.permissions.map((p) => p.id);
    const roles = m.roles.filter((r) => st.roleFilter === 'all' || (st.roleFilter === 'mfa' ? r.requiresMfa : st.roleFilter === 'custom' ? !r.builtIn : r.id === st.roleFilter));
    const q = st.q.toLowerCase();
    const groups = grouped(all).filter((g) => st.area === 'all' || g[0] === st.area).map((g) => [g[0], g[1].filter((p) => !q || p.indexOf(q) >= 0)]).filter((g) => g[1].length);
    const byId = {}; m.permissions.forEach((p) => { byId[p.id] = p; });
    const has = (r, p) => r.permissions.indexOf(p) >= 0;
    const headRow = '<tr><th scope="col">Permission' + (st.showRoutes ? ' and routes' : '') + '</th>' + roles.map((r) => '<th scope="col" title="' + esc(r.description || '') + '">' + esc(r.name) + (r.requiresMfa ? '<br><span class="muted" style="font-weight:400">MFA</span>' : '') + (!r.builtIn ? '<br>' + UI.pill('custom v' + (r.version || 1), 'accent') : '') + '</th>').join('') + '</tr>';
    const rows = groups.map((g) => '<tr class="area"><td colspan="' + (roles.length + 1) + '">' + esc(g[0]) + '</td></tr>' + g[1].map((p) => {
      const routes = (byId[p].routes || []).concat((byId[p].anyOfRoutes || []).map((x) => x + ' (any of)'));
      return '<tr><th scope="row"><button type="button" class="permlink" data-perm="' + esc(p) + '">' + esc(p) + '</button>' + (byId[p].admin ? ' <span class="muted" style="font-size:11px">admin</span>' : '')
        + (st.showRoutes ? '<div class="muted" style="font-size:11px;font-family:var(--mono)">' + (routes.length ? routes.slice(0, 3).map(esc).join('<br>') + (routes.length > 3 ? '<br>+ ' + (routes.length - 3) + ' more' : '') : 'no route requires it alone') + '</div>' : '') + '</th>'
        + roles.map((r) => '<td class="' + (has(r, p) ? 'on' : 'off') + '">' + (has(r, p) ? UI.icon('check', 14) + '<span class="sr">granted</span>' : '<span aria-hidden="true">·</span><span class="sr">not granted</span>') + '</td>').join('') + '</tr>';
    }).join('')).join('');
    const total = groups.reduce((n, g) => n + g[1].length, 0);
    const roleLabel = ({ all: 'all', mfa: 'requiring MFA', custom: 'custom only' })[st.roleFilter] || (m.roles.find((r) => r.id === st.roleFilter) || {}).name || st.roleFilter;
    return '<div class="toolbar">' + UI.search('Filter permissions', 'data-mq', st.q) + '<span class="relative">' + UI.btn('Area: ' + esc(st.area === 'all' ? 'all' : st.area), { size: 'sm', icon: 'filter', attrs: 'data-areamenu', cls: st.area !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn('Roles: ' + esc(roleLabel), { size: 'sm', icon: 'filter', attrs: 'data-rolemenu', cls: st.roleFilter !== 'all' ? 'active' : '' }) + '</span>' + UI.toggle('Show routes', !!st.showRoutes, 'data-routes data-manual') + '<span class="muted right" style="font-size:12px">' + total + ' of ' + all.length + ' permissions, ' + roles.length + ' roles</span></div>'
      + '<div class="tablewrap roles-matrix" data-scroll-x><table><caption class="sr">Role by permission matrix</caption><thead>' + headRow + '</thead><tbody>' + (rows || '<tr><td colspan="' + (roles.length + 1) + '">' + UI.empty('No permissions match', 'Clear the search or area filter.') + '</td></tr>') + '</tbody></table></div>'
      + '<div class="muted" style="font-size:12px">Generated from the catalogue in <span class="mono">server/src/authz/permissions.ts</span> with the tenant\'s custom roles in force (B-3301). Every route declares its permission in one table (B-3304): open a permission to see its routes. System admin holds everything; API-key scopes only narrow a role. ' + m.authenticatedRoutes.length + ' routes need only a session and ' + m.publicRoutes.length + ' are public.</div>';
  }
  function wireMatrix(ctx, st, model) {
    const m = model.matrix;
    ctx.on('change', '[data-mq]', (e, t) => { st.q = t.value.trim(); ctx.rerender(); });
    ctx.on('keydown', '[data-mq]', (e, t) => { if (e.key === 'Enter') { st.q = t.value.trim(); ctx.rerender(); } });
    ctx.on('click', '[data-areamenu]', (e, t) => openMenu(ctx, t, [['all', 'All areas']].concat(grouped(m.permissions.map((p) => p.id)).map((g) => [g[0], g[0]])), st.area, (v) => { st.area = v; ctx.rerender(); }));
    ctx.on('click', '[data-rolemenu]', (e, t) => openMenu(ctx, t, [['all', 'All roles'], ['mfa', 'Roles requiring MFA'], ['custom', 'Custom roles only']].concat(m.roles.map((r) => [r.id, r.name])), st.roleFilter, (v) => { st.roleFilter = v; ctx.rerender(); }));
    ctx.on('click', '[data-routes]', () => { st.showRoutes = !st.showRoutes; ctx.rerender(); });
    ctx.on('click', '[data-perm]', (e, t) => {
      const p = t.dataset.perm; const perm = m.permissions.find((x) => x.id === p) || { routes: [], anyOfRoutes: [] };
      const holders = m.roles.filter((r) => r.permissions.indexOf(p) >= 0);
      const routes = perm.routes.concat(perm.anyOfRoutes.map((x) => x + '   (one of several)'));
      ctx.drawer({ title: '<span class="mono">' + esc(p) + '</span>', body: UI.kv([['Area', esc(areaOf(p))], ['Admin permission', perm.admin ? 'yes, outside the member baseline' : 'no'], ['Built-in roles', holders.filter((r) => r.builtIn).map((r) => esc(r.name)).join(', ') || 'none'], ['Custom roles', holders.filter((r) => !r.builtIn).map((r) => esc(r.name)).join(', ') || 'none']], 1) + '<div class="eyebrow" style="margin:12px 0 6px">Routes declaring this permission (B-3304)</div>' + UI.code(routes.join('\n') || 'No route requires it on its own.', 'routes') + '<div class="muted" style="font-size:12px;margin-top:6px">A route registered without a declared permission fails the test suite.</div>', actions: UI.btn('Who can ' + esc(p), { kind: 'primary', attrs: 'data-dwho' }) + UI.btn('Close', { attrs: 'data-close' }), onMount(d) { d.querySelector('[data-dwho]').addEventListener('click', () => { App.closeOverlay(); st.tab = 'effective'; st.whoCan = true; st.effPerm = p; ctx.rerender(); }); } });
    });
  }

  // ---------------- Custom roles ----------------
  const stateLabel = (r) => (r.state === 'pending' ? 'dual control pending' : r.pendingVersion ? 'v' + r.pendingVersion + ' pending' : r.state);
  const statePill = (r) => UI.pill(stateLabel(r), r.state === 'pending' || r.pendingVersion ? 'warn' : r.state === 'active' ? 'ok' : '');
  const roleUrl = (id) => '/api/authz/roles/' + enc(id);
  function renderCustom(st, model, h) {
    const custom = model.roles.custom;
    if (st.wantPending) {
      st.wantPending = false;
      const p = custom.find((r) => r.state === 'pending' || r.pendingVersion);
      if (p) st.role = p.id; else st.demoNote = 'No custom role is waiting for a second admin. A role holding an admin permission (any outside the member baseline) waits in "dual control pending" until another holder of roles:manage approves it; until then nobody can be granted it.';
    }
    const list = custom.filter((r) => st.showRetired || r.state !== 'retired');
    if (st.role && !custom.some((r) => r.id === st.role)) st.role = null;
    const sel = custom.find((r) => r.id === st.role);
    const table = UI.table(['Role', 'Permissions', 'MFA', 'Grantable by', 'Holders', 'Version', 'State'], list.map((r) => ({ cells: ['<b>' + esc(r.name) + '</b><br><span class="muted" style="font-size:12px">' + esc(r.description) + '</span>', '<span class="num">' + r.permissions.length + '</span>' + (r.permissions.some((p) => model.adminPerm[p]) ? ' ' + UI.pill('admin', 'warn') : ''), r.requiresMfa ? UI.pill('required', 'info') : '<span class="muted">no</span>', '<span class="mono" style="font-size:12px">' + esc(r.grantableBy.join(', ')) + '</span>', '<span class="num">' + model.holders(r.id).length + '</span>', r.version ? 'v' + r.version : '<span class="muted">none in force</span>', statePill(r)], attrs: 'data-role="' + esc(r.id) + '"', selected: !!sel && sel.id === r.id })), { minWidth: '0', emptyTitle: 'No custom roles yet', emptyText: 'Create one from catalogue permissions. A creator cannot grant more than they hold.' });
    let insp = '';
    if (sel) {
      const det = h.need(roleUrl(sel.id));
      const err = h.errs[roleUrl(sel.id)];
      if (err) insp = UI.panel(esc(sel.name), UI.problem('The role could not be loaded', err.message, err.problem && err.problem.trace_id));
      else if (!det) insp = UI.panel(esc(sel.name), '<p class="muted" style="margin:0">Loading the role…</p>');
      else {
        const versions = det.versions; // newest first
        const diffUrl = versions.length > 1 ? roleUrl(sel.id) + '/diff' : null;
        const diff = diffUrl ? h.need(diffUrl) : null;
        const pend = versions.find((v) => v.state === 'pending');
        const mine = pend && pend.proposedBy === meId();
        const shown = pend || versions.find((v) => v.version === det.version) || versions[0];
        const inDiff = diff && diff.to === shown.version;
        const added = inDiff ? diff.permissions.added : [];
        const removed = inDiff ? diff.permissions.removed : [];
        const holders = model.holders(det.id);
        insp = UI.panel(esc(sel.name), (pend ? UI.notice('<b>' + (det.state === 'pending' ? 'Dual control pending.' : 'Version ' + pend.version + ' pending.') + '</b> Proposed by ' + esc(model.userName(pend.proposedBy)) + ', ' + esc(when(pend.proposedAt)) + '. It holds admin permissions (' + pend.permissions.filter((p) => model.adminPerm[p]).map(esc).join(', ') + '), so a second holder of roles:manage must approve before ' + (det.state === 'pending' ? 'it can be granted to anyone' : 'the new set is in force') + '.' + (mine ? ' You proposed it, so you can withdraw it but not approve it.' : ''), 'warn', mine ? UI.btn('Withdraw', { size: 'sm', attrs: 'data-reject="' + pend.version + '"' }) : UI.btn('Approve as second admin', { kind: 'primary', size: 'sm', attrs: 'data-approve="' + pend.version + '"' }) + UI.btn('Reject', { size: 'sm', attrs: 'data-reject="' + pend.version + '"' })) : '')
          + UI.kv([['State', statePill(det)], ['Version', det.version ? 'v' + det.version + ' in force, ' + versions.length + ' in all' : 'none in force yet, ' + versions.length + ' proposed'], ['Requires MFA', det.requiresMfa ? 'yes' : 'no'], ['Grantable by', '<span class="mono">' + esc(det.grantableBy.join(', ')) + '</span>'], ['Holders', holders.length ? esc(holders.map((u) => u.displayName || u.username).join(', ')) : 'nobody yet'], ['Scope', 'this tenant (custom roles are tenant-only)']], 2)
          + '<div class="eyebrow" style="margin:12px 0 6px">Permissions, v' + shown.version + (inDiff ? ' against v' + diff.from : '') + '</div><div class="roles-perms">' + shown.permissions.map((p) => UI.pill(p, added.indexOf(p) >= 0 ? 'ok' : 'outline')).join('') + removed.map((p) => '<span class="pill danger"><s>' + esc(p) + '</s><span class="sr"> removed</span></span>').join('') + '</div>'
          + (inDiff ? '<div class="muted" style="font-size:12px;margin-top:4px">' + added.length + ' added, ' + removed.length + ' removed since v' + diff.from + (diff.grantableBy.added.length || diff.grantableBy.removed.length ? '; grantable by ' + esc(diff.grantableBy.added.map((x) => '+' + x).concat(diff.grantableBy.removed.map((x) => '−' + x)).join(', ')) : '') + (diff.fields && diff.fields.requiresMfa ? '; MFA ' + (diff.fields.requiresMfa.to ? 'now required' : 'no longer required') : '') + '. Holders get the new set once it is in force; audited authz.role.updated with the diff.</div>' : diffUrl && !diff ? '<div class="muted" style="font-size:12px">Loading the diff…</div>' : '')
          + '<div class="eyebrow" style="margin:12px 0 6px">Versions</div>' + UI.timeline(versions.map((v) => ({ title: 'v' + v.version + ', ' + v.permissions.length + ' permissions', text: esc(v.state + (v.decidedBy ? ' by ' + model.userName(v.decidedBy) : '') + (v.note ? ': ' + v.note : '')), meta: esc(when(v.proposedAt) + ', ' + model.userName(v.proposedBy)), tone: v.version === det.version ? 'accent' : '' })))
          + '<div class="hstack wrap gap6" style="margin-top:10px">' + UI.btn('New version', { kind: 'primary', size: 'sm', attrs: 'data-editrole', disabled: det.state === 'retired' || !!pend }) + UI.btn('Grant to a member', { size: 'sm', attrs: 'data-grant', disabled: det.state !== 'active' || !App.can('users:manage') }) + UI.btn('Retire', { kind: 'danger', size: 'sm', attrs: 'data-retire', disabled: det.state === 'retired' }) + '</div>');
      }
    }
    return '<div class="toolbar">' + UI.btn('Create role', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-create' }) + UI.toggle('Show retired', !!st.showRetired, 'data-showretired data-manual') + '<span class="muted right" style="font-size:12px">Built only from catalogue permissions; a creator cannot grant more than they hold.</span></div><div class="cols wrap"><div style="flex:1.4 1 360px;min-width:0">' + table + '</div>' + (sel ? '<div style="flex:1 1 300px;min-width:0">' + insp + '</div>' : '') + '</div>';
  }

  function roleForm(model, opts) {
    const m = model.matrix;
    const role = opts.role;
    const perms = opts.perms || (role ? role.permissions : []);
    const actAs = opts.actAs || 'me';
    const ceilingRole = m.roles.find((r) => r.id === actAs);
    const have = (p) => (actAs === 'me' ? App.can(p) : ceilingRole ? ceilingRole.permissions.indexOf(p) >= 0 : true);
    const grantOpts = [{ value: 'system-admin,tenant-admin', label: 'system-admin, tenant-admin (default)' }, { value: 'system-admin,tenant-admin,identity-admin', label: 'system-admin, tenant-admin, identity-admin' }, { value: 'system-admin', label: 'system-admin only' }];
    const g = role ? role.grantableBy.join(',') : 'system-admin,tenant-admin';
    if (!grantOpts.some((o) => o.value === g)) grantOpts.unshift({ value: g, label: role.grantableBy.join(', ') });
    const actOpts = [{ value: 'me', label: 'Your own roles' }].concat(m.roles.filter((r) => r.builtIn && r.permissions.indexOf('roles:manage') >= 0 && r.id !== 'system-admin').map((r) => ({ value: r.id, label: r.name })));
    return '<div class="formgrid">' + UI.field('Name', UI.input(role ? role.name : (opts.name || ''), { attrs: 'data-rn maxlength="120"', placeholder: 'Close reviewer' })) + UI.field('Grantable by', UI.select(grantOpts, g, 'data-rg'))
      + UI.field('Ceiling preview', UI.select(actOpts, actAs, 'data-ractas'), 'The creator cannot grant more than they hold. The role is always created as you.') + UI.field('Requires MFA', UI.select([{ value: 'true', label: 'Yes (default)' }, { value: 'false', label: 'No' }], role && !role.requiresMfa ? 'false' : 'true', 'data-rmfa'), 'Off only when built-in roles without MFA grant every permission.') + '</div>'
      + UI.field('Description', UI.input(role ? role.description : (opts.desc || ''), { attrs: 'data-rd maxlength="500"' }))
      + '<fieldset class="roles-pick" style="border:1px solid var(--line);border-radius:6px;padding:8px;margin:0;max-height:280px;overflow-y:auto;min-width:0"><legend class="eyebrow" style="padding:0 4px">Permissions from the catalogue</legend>' + grouped(m.permissions.map((p) => p.id)).map((gr) => '<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-top:6px">' + esc(gr[0]) + '</div><div class="hstack wrap" style="gap:2px 14px">' + gr[1].map((p) => '<label class="check" style="font-size:12px"><input type="checkbox" data-rp value="' + esc(p) + '"' + (perms.indexOf(p) >= 0 ? ' checked' : '') + (have(p) ? '' : ' data-outside="1"') + '><span class="mono">' + esc(p) + (model.adminPerm[p] ? ' <span class="muted">admin</span>' : '') + (have(p) ? '' : ' <span style="color:var(--danger-fg)">outside the ceiling</span>') + '</span></label>').join('') + '</div>').join('') + '</fieldset>'
      + '<div data-formnote>' + (opts.problem ? ceilingProblem(actAs, [opts.problem], model) : UI.notice('A role holding an admin permission is under <b>dual control</b>: a second holder of roles:manage approves each version before it is in force. Versions keep a diff; holders get the new set once it is in force.', 'info')) + '</div>';
  }
  function ceilingProblem(actAs, outside, model, traceId) {
    const name = actAs === 'me' ? null : ((model.matrix.roles.find((r) => r.id === actAs) || {}).name || actAs).toLowerCase();
    const them = outside.length > 1 ? 'them' : 'it';
    return UI.problem('Refused (403): outside the creator\'s ceiling', (name ? 'A ' + name + ' holds' : 'You hold') + ' none of ' + outside.join(', ') + ', so ' + (name ? 'they cannot' : 'you cannot') + ' create a role holding ' + them + '. A creator cannot grant more than they hold; remove ' + them + ' or ask an admin who holds ' + them + '.', traceId || false);
  }

  function wireCustom(ctx, st, model, h) {
    const sel = () => model.roles.custom.find((r) => r.id === st.role);
    const refresh = (id) => { h.forget('/api/authz/roles'); h.forget('/api/authz/matrix'); if (id) h.forget(roleUrl(id)); h.forget('/api/admin/users'); };
    ctx.on('click', 'tr[data-role]', (e, t) => { st.role = t.dataset.role; ctx.rerender(); });
    ctx.on('click', '[data-showretired]', () => { st.showRetired = !st.showRetired; ctx.rerender(); });
    const openForm = (role, preset) => {
      preset = preset || {};
      let actAs = preset.actAs || 'me';
      const next = role ? (role.versions ? role.versions[0].version : role.version || 0) + 1 : 1;
      ctx.modal({ title: role ? 'New version of ' + esc(role.name) : 'Create custom role', cls: 'wide', body: '<div data-formhost class="vstack gap12">' + roleForm(model, { role, actAs, perms: preset.perms, problem: preset.problem }) + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(role ? 'Save v' + next : 'Create', { kind: 'primary', attrs: 'data-rsave' }),
        onMount(mm) {
          const host = mm.querySelector('[data-formhost]');
          const picked = () => Array.prototype.slice.call(mm.querySelectorAll('[data-rp]:checked'));
          const bindActAs = () => mm.querySelector('[data-ractas]').addEventListener('change', (e) => {
            actAs = e.target.value;
            host.innerHTML = roleForm(model, { role, actAs, perms: picked().map((x) => x.value), name: mm.querySelector('[data-rn]').value, desc: mm.querySelector('[data-rd]').value });
            App.a11yPass(host); bindActAs(); mm.querySelector('[data-ractas]').focus();
          });
          bindActAs();
          mm.querySelector('[data-rsave]').addEventListener('click', () => {
            const note = mm.querySelector('[data-formnote]');
            const chosen = picked();
            const outside = chosen.filter((x) => x.dataset.outside).map((x) => x.value);
            if (actAs !== 'me' && outside.length) { note.innerHTML = ceilingProblem(actAs, outside, model); return; }
            const perms = chosen.map((x) => x.value);
            const name = mm.querySelector('[data-rn]').value.trim();
            if (!name) { note.innerHTML = UI.notice('Give the role a name.', 'warn'); mm.querySelector('[data-rn]').focus(); return; }
            if (!perms.length) { note.innerHTML = UI.notice('Pick at least one permission.', 'warn'); return; }
            const body = { name, description: mm.querySelector('[data-rd]').value.trim(), permissions: perms, requiresMfa: mm.querySelector('[data-rmfa]').value === 'true', grantableBy: mm.querySelector('[data-rg]').value.split(',') };
            if (role) {
              // A new version sends only what changed.
              if (body.name === role.name) delete body.name;
              if (body.description === role.description) delete body.description;
              if (body.requiresMfa === role.requiresMfa) delete body.requiresMfa;
              if (body.grantableBy.join(',') === role.grantableBy.join(',')) delete body.grantableBy;
              if (perms.slice().sort().join(',') === role.permissions.slice().sort().join(',')) delete body.permissions;
              if (!Object.keys(body).length) { note.innerHTML = UI.notice('Nothing changed: a new version needs at least one change.', 'warn'); return; }
            }
            const btn = mm.querySelector('[data-rsave]'); btn.disabled = true;
            (role ? App.patch(roleUrl(role.id), body) : App.post('/api/authz/roles', body)).then((r) => {
              App.closeOverlay(); refresh(r.role.id); st.role = r.role.id;
              ctx.toast(r.pending ? esc(r.role.name) + ' v' + r.version.version + ' waits for a second admin (dual control). authz.role.proposed written; the other admins are notified.' : esc(r.role.name) + (role ? ' v' + r.version.version + ' is in force. authz.role.updated written.' : ' created and active. authz.role.created written.'), r.pending ? 'warn' : 'ok', 6000);
              ctx.rerender();
            }).catch((err) => {
              btn.disabled = false;
              const p = err.problem || {};
              note.innerHTML = err.status === 403 && p.step === 'role' && p.permissions ? ceilingProblem('me', p.permissions, model, p.trace_id) : UI.problem(role ? 'Version not saved' : 'Role not created', err.message, p.trace_id || false);
            });
          });
        } });
    };
    ctx.on('click', '[data-create]', () => openForm(null));
    if (st.openCreate) { const preset = typeof st.openCreate === 'object' ? st.openCreate : {}; st.openCreate = false; setTimeout(() => openForm(null, preset), 0); }
    ctx.on('click', '[data-editrole]', () => { const r = sel(); openForm(st.data[roleUrl(r.id)] || r); });
    ctx.on('click', '[data-approve]', async (e, t) => {
      const r = sel(); const v = Number(t.dataset.approve);
      const det = st.data[roleUrl(r.id)]; const ver = det && det.versions.find((x) => x.version === v);
      const ok = await ctx.confirm({ title: 'Approve ' + r.name + ' v' + v, tag: 'dual control', tone: 'info', body: '<p class="fg2" style="margin:0">You are the second admin. The version goes into force and the role becomes grantable; the approval is written to the audit chain with both admins. You must hold every permission it carries.</p>', kv: [['Proposed by', esc(model.userName(ver && ver.proposedBy))], ['Permissions', String(ver ? ver.permissions.length : r.permissions.length)], ['Requires MFA', (ver ? ver.requiresMfa : r.requiresMfa) ? 'yes' : 'no']], ok: 'Approve' });
      if (!ok) return;
      try { await App.post(roleUrl(r.id) + '/versions/' + v + '/approve', {}); refresh(r.id); ctx.toast(esc(r.name) + ' v' + v + ' approved and in force. authz.role.approved written.', 'ok'); ctx.rerender(); }
      catch (err) { App.fail(err, 'Not approved'); }
    });
    ctx.on('click', '[data-reject]', async (e, t) => {
      const r = sel(); const v = Number(t.dataset.reject);
      const det = st.data[roleUrl(r.id)]; const ver = det && det.versions.find((x) => x.version === v);
      const mine = !!ver && ver.proposedBy === meId();
      const ok = await ctx.confirm({ title: (mine ? 'Withdraw ' : 'Reject ') + r.name + ' v' + v, tag: 'dual control', tone: 'danger', body: '<p class="fg2" style="margin:0">' + (det && det.state === 'pending' ? 'The role has no version in force, so it is retired.' : 'The version in force stays as it is.') + ' Written to the audit chain.</p>', ok: mine ? 'Withdraw' : 'Reject' });
      if (!ok) return;
      try { await App.post(roleUrl(r.id) + '/versions/' + v + '/reject', {}); refresh(r.id); ctx.toast(esc(r.name) + ' v' + v + (mine ? ' withdrawn. authz.role.withdrawn written.' : ' rejected. authz.role.rejected written.'), 'warn'); ctx.rerender(); }
      catch (err) { App.fail(err, mine ? 'Not withdrawn' : 'Not rejected'); }
    });
    ctx.on('click', '[data-grant]', () => {
      const r = sel(); const cands = model.users.filter((u) => u.id !== meId() && u.state === 'active' && u.roles.indexOf(r.id) < 0);
      if (!cands.length) { ctx.toast('Everyone else in the tenant already holds ' + esc(r.name) + ', or nobody else is active.'); return; }
      ctx.modal({ title: 'Grant ' + esc(r.name), body: UI.field('Member', UI.select(cands.map((u) => ({ value: u.id, label: (u.displayName || u.username) + ' (' + u.username + ', ' + u.clearance + ')' })), cands[0].id, 'data-gu')) + UI.notice((r.requiresMfa ? 'The role requires MFA: the member must complete a second factor before any request is served. ' : '') + 'Their sessions end now, so the next request reads the new roles. Written to the audit chain as user.updated.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Grant', { kind: 'primary', attrs: 'data-ggo' }),
        onMount(mm) {
          mm.querySelector('[data-ggo]').addEventListener('click', async () => {
            const uid = mm.querySelector('[data-gu]').value; const u = cands.find((x) => x.id === uid);
            try {
              const full = await App.get('/api/admin/users/' + enc(uid));
              const direct = full.roles.filter((x) => x.source === 'direct').map((x) => x.role);
              await App.patch('/api/admin/users/' + enc(uid), { roles: direct.concat([r.id]) });
              App.closeOverlay(); refresh(r.id); ctx.toast(esc(u.displayName || u.username) + ' now holds ' + esc(r.name) + '. user.updated written; their sessions ended.', 'ok'); ctx.rerender();
            } catch (err) { App.fail(err, 'Not granted'); }
          });
        } });
    });
    ctx.on('click', '[data-retire]', async () => {
      const r = sel(); const hs = model.holders(r.id);
      const ok = await ctx.confirm({ title: 'Retire ' + r.name, tag: 'retire', tone: 'danger', body: '<p class="fg2" style="margin:0">' + (hs.length ? esc(hs.length + ' member' + (hs.length === 1 ? '' : 's') + ' hold it (' + hs.map((u) => u.displayName || u.username).join(', ') + '): the server refuses to retire it until nobody, no group mapping and no pending invitation grants it.') : 'Nobody holds it.') + ' Retired roles stay listed for the audit trail and cannot be granted.</p>', ok: 'Retire' });
      if (!ok) return;
      try { await App.del(roleUrl(r.id)); refresh(r.id); st.showRetired = true; ctx.toast(esc(r.name) + ' retired. authz.role.retired written.', 'warn'); ctx.rerender(); }
      catch (err) { App.fail(err, 'Not retired'); }
    });
  }

  // ---------------- Effective access ----------------
  function effQuery(st, extra) {
    const q = [];
    if (st.label) q.push('label=' + enc(st.label));
    if (st.zone) q.push('zone=' + enc(st.zone));
    Object.keys(extra || {}).forEach((k) => { if (extra[k] != null && extra[k] !== '') q.push(k + '=' + enc(extra[k])); });
    return q.join('&');
  }
  function renderEffective(st, model, h) {
    const base = h.need(WS_URL);
    const zonesAll = App.can('zones:manage') ? h.need('/api/admin/zones') : { zones: [] };
    const baseErr = h.errs[WS_URL];
    if (baseErr) return UI.problem('Workspaces could not be loaded', baseErr.message, baseErr.problem && baseErr.problem.trace_id);
    if (!base || !zonesAll) return UI.notice('Loading…', 'info');
    const wss = base.workspaces;
    if (!wss.length) return UI.empty('No workspace within your clearance', 'Effective access is shown per workspace; workspaces above your clearance are left out.');
    if (!st.ws || !wss.some((w) => w.id === st.ws)) st.ws = wss[0].id;
    const ws = wss.find((w) => w.id === st.ws);
    const zones = (zonesAll.zones || []).map((z) => ({ id: z.id, ceiling: z.spec && z.spec.maxLabel })).filter((z) => z.ceiling);
    if (st.zone && !zones.some((z) => z.id === st.zone)) st.zone = '';
    if (st.wantZoneDeny) {
      st.wantZoneDeny = false;
      const z = zones.filter((x) => RANK[x.ceiling] < RANK.restricted).sort((a, b) => RANK[a.ceiling] - RANK[b.ceiling])[0];
      st.label = 'restricted';
      // The drawer opens either way, so its every step shows; without such a zone the zone step allows.
      st.openCell = { userId: meId(), permission: 'knowledge:read' };
      if (z) st.zone = z.id;
      else st.demoNote = (App.can('zones:manage') && !zones.length ? 'No zones are defined yet (seed them on the Zones screen).' : 'No zone has a ceiling below restricted, so nothing here is stopped at the zone step.') + ' With a zone whose ceiling is below the resource label, the explain drawer shows role, scopes, tenant and clearance allowing and the zone ceiling denying.';
    }
    const perms = model.matrix.permissions.map((p) => p.id);
    const areas = grouped(perms);
    if (!areas.some((g) => g[0] === st.effArea)) st.effArea = areas[0][0];
    if (perms.indexOf(st.effPerm) < 0) st.effPerm = perms[0];
    const zoneOpts = [{ value: '', label: 'No zone ceiling' }].concat(zones.map((z) => ({ value: z.id, label: 'Zone ' + z.id + ' (ceiling ' + z.ceiling + ')' })));
    const controls = '<div class="toolbar">' + UI.seg([{ id: 'matrix', label: 'Users × permissions' }, { id: 'who', label: 'Who can…' }], st.whoCan ? 'who' : 'matrix', 'data-effmode aria-label="View"')
      + UI.select(wss.map((w) => ({ value: w.id, label: w.name })), st.ws, 'data-effws aria-label="Workspace"')
      + UI.select([{ value: '', label: 'Label: workspace ceiling (' + ws.labelCeiling + ')' }].concat(LABELS.map((l) => ({ value: l, label: 'Label: ' + l }))), st.label, 'data-efflabel aria-label="Resource label"')
      + UI.select(zoneOpts, st.zone, 'data-effzone aria-label="Zone ceiling"')
      + (st.whoCan ? UI.select(perms, st.effPerm, 'data-effperm aria-label="Permission"') : UI.select(areas.map((g) => g[0]), st.effArea, 'data-effarea aria-label="Area"'))
      + (st.whoCan ? '' : UI.search('Find a member', 'data-uq', st.userQ) + UI.toggle('API keys', !!st.keys, 'data-keys data-manual')) + '</div>';
    const label = st.label || ws.labelCeiling;
    const zone = zones.find((z) => z.id === st.zone);
    const where = 'In ' + esc(ws.name) + ' on a resource labelled ' + esc(label) + (zone ? ', zone ' + esc(zone.id) + ' (ceiling ' + esc(zone.ceiling) + ')' : '');
    if (st.whoCan) {
      const url = '/api/authz/who-can?' + effQuery(st, { permission: st.effPerm, workspaceId: st.ws, limit: 200 });
      const d = h.need(url); const err = h.errs[url];
      if (err) return controls + UI.problem('Who can could not be answered', err.message, err.problem && err.problem.trace_id);
      if (!d) return controls + UI.notice('Loading…', 'info');
      const allowed = d.users.filter((u) => u.decision.allow && u.member !== false);
      return controls + '<h2 style="margin:4px 0 0;font-size:16px">Who can <span class="mono">' + esc(st.effPerm) + '</span></h2><p class="fg2" style="margin:0">' + where + ': ' + allowed.length + ' of ' + d.total + ' holders of a granting role (' + esc(d.roles.join(', ') || 'none') + ') may act. Each row names the deciding step; open one for every step.</p>'
        + UI.table(['Principal', 'Roles', 'Clearance', 'Member of the workspace', 'Decision', 'Deciding step'], d.users.map((u) => ({ cells: [esc(u.displayName || u.username) + ' <span class="muted mono" style="font-size:11px">' + esc(u.username) + '</span>' + (u.active ? '' : ' ' + UI.pill('inactive', 'danger')), '<span class="mono" style="font-size:11px">' + esc(u.roles.join(' ')) + '</span>', UI.label(u.clearance, { sm: true }), u.member === false ? UI.pill('no', 'warn') : 'yes', UI.pill(u.decision.allow ? 'allow' : 'deny', u.decision.allow ? 'ok' : 'danger'), u.decision.step ? '<b>' + esc(STEP_NAME[u.decision.step] || u.decision.step) + '</b>: ' + esc(u.decision.reason) : 'every step allows'], attrs: 'data-cell="' + esc(u.userId) + '|' + esc(st.effPerm) + '"' })), { minWidth: '0', emptyTitle: 'Nobody holds a role granting ' + st.effPerm })
        + '<div class="muted" style="font-size:12px">A row matches <span class="mono">policy.explain</span> for the same principal and resource (B-3303). <a href="#" data-gotenants>Members in Tenants</a>, <a href="#" data-goidentity>group mappings in Identity</a>.</div>';
    }
    const ap = (areas.find((g) => g[0] === st.effArea) || areas[0])[1];
    const url = '/api/authz/access?' + effQuery(st, { workspaceId: st.ws, permissions: ap.join(','), q: st.userQ, keys: st.keys ? 'true' : '', limit: 100 });
    const d = h.need(url); const err = h.errs[url];
    if (err) return controls + UI.problem('Effective access could not be loaded', err.message, err.problem && err.problem.trace_id);
    if (!d) return controls + UI.notice('Loading…', 'info');
    const nameOf = (s) => (s.kind === 'api_key' ? (s.apiKeyName || 'API key') + ' (API key of ' + (s.displayName || s.username) + ')' : s.displayName || s.username);
    const headRow = '<tr><th scope="col">Member</th>' + ap.map((p) => '<th scope="col"><span class="mono">' + esc(p) + '</span></th>').join('') + '</tr>';
    const rows = d.rows.map((r) => {
      const s = r.subject; const c = r.cells[st.ws] || { member: false, allow: [], deny: {} };
      const who = nameOf(s);
      return '<tr><th scope="row"><b>' + esc(who) + '</b>' + (s.active ? '' : ' ' + UI.pill('inactive', 'danger')) + (c.member ? '' : ' ' + UI.pill('not a member', 'warn')) + '<br><span class="muted" style="font-size:11px">' + esc(s.roles.join(', ')) + ', ' + esc(s.clearance) + (s.scopes ? ', scopes ' + esc(s.scopes.join(' ')) : '') + '</span></th>' + ap.map((p) => {
        const allow = c.allow.indexOf(p) >= 0; const step = c.deny[p]; const na = !allow && step === 'role';
        const text = allow ? 'allow' : na ? 'no role grants it' : 'deny at ' + (STEP_NAME[step] || step);
        return '<td><button type="button" class="roles-cell ' + (allow ? 'allow' : na ? 'na' : 'deny') + '" data-cell="' + esc(s.userId) + '|' + esc(p) + '"' + (s.apiKeyId ? ' data-key="' + esc(s.apiKeyId) + '"' : '') + ' aria-label="Explain ' + esc(who + ', ' + p + ': ' + text) + '" title="' + esc(text) + '">' + (allow ? UI.icon('check', 13) : na ? '<span aria-hidden="true">·</span>' : UI.icon('x', 13)) + '</button></td>';
      }).join('') + '</tr>';
    }).join('');
    return controls + '<div class="tablewrap roles-matrix" data-scroll-x><table data-effmatrix><caption class="sr">Effective access, members by permission. Each cell opens its explain steps.</caption><thead>' + headRow + '</thead><tbody>' + (rows || '<tr><td colspan="' + (ap.length + 1) + '">' + UI.empty('Nobody matches', 'Clear the member search.') + '</td></tr>') + '</tbody></table></div>'
      + (d.total > d.rows.length ? '<div class="muted" style="font-size:12px">Showing ' + d.rows.length + ' of ' + d.total + ' members; search to narrow it.</div>' : '')
      + '<div class="hstack wrap gap12 muted" style="font-size:12px"><span><span class="pill ok">allow</span> every step allows</span><span><span class="pill danger">deny</span> a role grants it, a later step refuses</span><span>· no role grants it</span><span class="grow"></span><span>Open a cell for its explain steps (B-3303). ' + where + '.</span></div>';
  }
  function wireEffective(ctx, st, model, h) {
    ctx.on('click', '[data-effmode] [data-seg]', (e, t) => { st.whoCan = t.dataset.seg === 'who'; ctx.rerender(); });
    ctx.on('change', '[data-effws]', (e, t) => { st.ws = t.value; ctx.rerender(); });
    ctx.on('change', '[data-efflabel]', (e, t) => { st.label = t.value; ctx.rerender(); });
    ctx.on('change', '[data-effzone]', (e, t) => { st.zone = t.value; ctx.rerender(); });
    ctx.on('change', '[data-effperm]', (e, t) => { st.effPerm = t.value; ctx.rerender(); });
    ctx.on('change', '[data-effarea]', (e, t) => { st.effArea = t.value; ctx.rerender(); });
    ctx.on('click', '[data-keys]', () => { st.keys = !st.keys; ctx.rerender(); });
    ctx.on('change', '[data-uq]', (e, t) => { st.userQ = t.value.trim(); ctx.rerender(); });
    ctx.on('keydown', '[data-uq]', (e, t) => { if (e.key === 'Enter') { st.userQ = t.value.trim(); ctx.rerender(); } });
    ctx.on('click', '[data-gotenants]', (e) => { e.preventDefault(); ctx.navigate('tenants'); });
    ctx.on('click', '[data-goidentity]', (e) => { e.preventDefault(); ctx.navigate('identity'); });
    const openCell = (userId, p, keyId) => {
      const url = '/api/authz/access/explain?' + effQuery(st, { userId, apiKeyId: keyId, workspaceId: st.ws, permission: p });
      App.get(url).then((x) => {
        const s = x.subject; const dec = x.decision;
        const idx = x.steps.findIndex((s2) => s2.step === dec.step);
        const steps = x.steps.map((s2, i) => {
          const notReached = idx >= 0 && i > idx;
          const pill = notReached ? UI.pill('not reached', '') : s2.ok ? UI.pill('allow', 'ok') : UI.pill('deny', 'danger');
          return '<li class="hstack" style="align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)"><span class="num muted" style="min-width:16px">' + (i + 1) + '.</span><span><b>' + esc(STEP_NAME[s2.step] || s2.step) + '</b> ' + pill + '<br><span class="fg2" style="font-size:12px">' + esc(s2.detail) + '</span></span></li>';
        }).join('');
        ctx.drawer({ title: 'Explain: ' + esc(s.displayName || s.username) + ', <span class="mono">' + esc(p) + '</span>', body: '<div data-explain>' + UI.kv([['Workspace', esc(x.workspace.name) + (x.workspace.member ? '' : ' (not a member)')], ['Resource label', x.resource.label ? UI.label(x.resource.label, { sm: true }) : 'none'], ['Zone ceiling', x.resource.zoneCeiling ? esc(x.resource.zoneCeiling) : 'none'], ['Decision', UI.pill(dec.allow ? 'allow' : 'deny', dec.allow ? 'ok' : 'danger') + (dec.step ? ' at <b>' + esc(STEP_NAME[dec.step] || dec.step) + '</b>' : '')]], 2)
          + '<h3 class="eyebrow" style="margin:12px 0 4px">policy.explain, in order</h3><ol style="list-style:none;margin:0;padding:0" data-steps>' + steps + '</ol>'
          + '<div class="muted" style="font-size:12px;margin-top:8px">' + esc(dec.reason) + '. The same pipeline serves every request (policy ' + esc(dec.policy) + '): role, scopes, tenant, clearance, zone ceiling. Nothing here is a second policy engine.' + (x.workspace.member ? '' : ' Membership is not a policy step: a non-member is refused by the workspace check before the policy runs.') + '</div></div>', actions: UI.btn('Open in Usage and audit', { kind: 'ghost', attrs: 'data-goaudit' }) + UI.btn('Close', { attrs: 'data-close' }), onMount(dd) { dd.querySelector('[data-goaudit]').addEventListener('click', () => { App.closeOverlay(); ctx.navigate('usage-audit'); }); } });
      }).catch((err) => App.fail(err, 'Explain failed'));
    };
    ctx.on('click', '[data-cell]', (e, t) => { const parts = t.dataset.cell.split('|'); openCell(parts[0], parts[1], t.dataset.key || null); });
    // A state's cell opens once the matrix has rendered (a re-render waits while a drawer is open).
    if (st.openCell && st.ws && ctx.$('[data-effmatrix]')) { const c = st.openCell; st.openCell = null; setTimeout(() => openCell(c.userId, c.permission), 0); }
  }

  // ---------------- Access reviews ----------------
  const reviewPill = (r) => UI.pill(r.overdue ? 'overdue' : r.state, r.overdue ? 'danger' : r.state === 'open' ? 'info' : r.state === 'closed' ? 'ok' : '');
  const reviewUrl = (id) => '/api/authz/reviews/' + enc(id) + '?limit=1000';
  function renderReviews(st, model, h) {
    const list = model.reviews;
    const wsBase = h.need(WS_URL);
    const wsName = (id) => { const w = wsBase && wsBase.workspaces.find((x) => x.id === id); return w ? w.name : 'one workspace'; };
    const scopeText = (r) => r.scope.kinds.map((k) => (k === 'role' ? 'roles' : 'workspace memberships')).join(' and ') + (r.scope.roles && r.scope.roles.length ? ' (' + r.scope.roles.join(', ') + ')' : '') + (r.scope.workspaceId ? ', members of ' + wsName(r.scope.workspaceId) : ', tenant-wide');
    if (st.wantOverdue) {
      st.wantOverdue = false;
      const o = list.find((r) => r.overdue);
      if (o) st.review = o.id; else st.demoNote = 'No campaign is past its due date. When one is, the authz.reviews job escalates it once to the tenant admins (notification authz.review.overdue); the assigned reviewers can still decide, and so can the admins.';
    }
    const left = '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Campaigns</div>' + UI.btn('New', { size: 'sm', icon: 'plus', attrs: 'data-newcampaign aria-label="New campaign"', disabled: !App.can('roles:manage') }) + '</div><div class="vstack gap4">' + list.map((r) => UI.listItem(esc(r.name), esc((r.dueAt ? 'due ' + day(r.dueAt) : r.opensAt ? 'opens ' + day(r.opensAt) : 'not opened') + (r.counts.total ? ', ' + r.counts.decided + ' of ' + r.counts.total + ' decided' : '')), { active: r.id === st.review, attrs: 'data-review="' + esc(r.id) + '"', right: reviewPill(r) })).join('') + (list.length ? '' : '<p class="muted" style="font-size:12px;margin:0;padding:4px 8px">No campaigns yet.</p>') + '</div><div class="muted" style="font-size:12px;padding:6px 8px">Each grant is assigned to its admins and the member\'s directory manager. Results land in the audit chain; a revoked grant is gone on the member\'s next request.</div></div>';
    if (!st.review || !list.some((r) => r.id === st.review)) st.review = list.length ? (list.find((r) => r.state === 'open') || list[0]).id : null;
    if (!st.review) return { left, main: UI.empty('No access reviews', 'A campaign snapshots the direct role grants and workspace memberships in its scope; reviewers confirm or revoke each one.', UI.btn('New campaign', { kind: 'primary', attrs: 'data-newcampaign', disabled: !App.can('roles:manage') })) };
    const sel = h.need(reviewUrl(st.review)); const err = h.errs[reviewUrl(st.review)];
    if (err) return { left, main: UI.problem('The campaign could not be loaded', err.message, err.problem && err.problem.trace_id) };
    if (!sel) return { left, main: UI.notice('Loading…', 'info') };
    if (st.wantRevoked) {
      st.wantRevoked = false;
      const g = sel.items.find((i) => i.decision === 'revoked');
      const other = g ? null : list.find((r) => r.id !== sel.id && r.counts.decided > 0);
      if (g) st.lastRevoke = g.id;
      else st.demoNote = 'Nothing in this campaign has been revoked yet' + (other ? '; open ' + other.name + ' to look for one' : '') + '. A revoke removes the grant at once, writes authz.review.revoked to the audit chain, and the member loses it on their next request; their sockets leave the rooms it admitted them to.';
    }
    const mine = (i) => i.reviewers.indexOf(meId()) >= 0 && i.user.id !== meId();
    const pending = sel.items.filter((i) => i.decision === 'pending');
    const mineP = pending.filter(mine);
    let filtered = sel.items.filter((g) => (st.gfilter || 'all') === 'all' || g.decision === st.gfilter);
    if (st.gsort === 'member') filtered = filtered.slice().sort((a, b) => String(a.user.displayName || a.user.username).localeCompare(String(b.user.displayName || b.user.username)));
    else if (st.gsort === 'kind') filtered = filtered.slice().sort((a, b) => a.kind.localeCompare(b.kind));
    const extra = sel.reviewers && sel.reviewers.length ? '; extra reviewers ' + sel.reviewers.map((id) => model.userName(id)).join(', ') : '';
    const head = '<div class="hstack wrap" style="gap:8px;align-items:flex-start"><div class="grow" style="min-width:200px"><h2 style="margin:0;font-size:18px">' + esc(sel.name) + '</h2><p class="fg2" style="margin:2px 0 0;font-size:13px">' + esc(scopeText(sel) + (sel.everyDays ? ', every ' + sel.everyDays + ' days' : ', once') + (sel.dueAt ? ', due ' + day(sel.dueAt) : ', due ' + sel.dueDays + ' days after it opens') + '. Created by ' + model.userName(sel.createdBy) + extra + '.') + '</p></div>'
      + '<div class="hstack wrap gap6">' + reviewPill(sel) + (sel.state === 'scheduled' ? UI.btn('Open now', { size: 'sm', attrs: 'data-openreview', disabled: !App.can('roles:manage') }) : '') + UI.btn('Confirm all pending', { size: 'sm', attrs: 'data-bulkconfirm', disabled: !mineP.length || sel.state !== 'open' }) + UI.btn(sel.state === 'scheduled' ? 'Cancel campaign' : 'Close campaign', { size: 'sm', kind: 'ghost', attrs: 'data-closecampaign', disabled: !App.can('roles:manage') || sel.state === 'closed' || sel.state === 'cancelled' }) + '</div></div>';
    const last = st.lastRevoke && sel.items.find((i) => i.id === st.lastRevoke);
    const notices = (sel.overdue ? UI.notice('<b>Overdue since ' + esc(day(sel.dueAt)) + '.</b> ' + (sel.escalatedAt ? 'Escalated to the tenant admins on ' + esc(when(sel.escalatedAt)) + '; they were notified (authz.review.overdue) and can decide in the reviewer\'s place.' : 'The authz.reviews job escalates it to the tenant admins on its next run.') + ' Audited authz.review.escalated.', 'danger') : '')
      + (sel.state === 'scheduled' ? UI.notice('Scheduled. The grants are snapshotted from the matrix when the campaign opens' + (sel.opensAt ? ', on ' + esc(when(sel.opensAt)) : '') + '.', 'info') : '')
      + (sel.state === 'closed' ? UI.notice('Closed ' + esc(when(sel.closedAt)) + '. Undecided grants expired and stay in force.' + (sel.nextId ? ' The next campaign is scheduled.' : ''), 'ok') : '')
      + (last ? UI.notice('<b>' + esc(last.user.displayName || last.user.username) + '\'s ' + esc(last.kind === 'role' ? 'role ' + last.grant.name : 'membership of ' + last.grant.name) + ' revoked.</b> Written to the audit chain (authz.review.revoked, by ' + esc(last.decidedByName || model.userName(last.decidedBy)) + '); ' + (last.removed ? 'the grant is gone on their next request, and their sockets left the rooms it gave.' : 'the grant was already gone.'), 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearrevoke' })) : '');
    const total = sel.counts.total, decided = sel.counts.decided;
    const meter = total ? UI.meter('Decided', decided + ' of ' + total, (decided / total) * 100, sel.overdue ? 'danger' : 'accent') : '';
    const table = UI.table(['Member', 'Grant', 'Reviewers', 'Decision', { label: '', srLabel: 'Decide', right: true }], filtered.map((g) => ({ cells: [esc(g.user.displayName || g.user.username || g.user.id), '<span class="mono" style="font-size:12px">' + esc(g.kind === 'role' ? 'role ' + g.grant.name : 'workspace membership, ' + g.grant.name) + '</span>', '<span style="font-size:12px">' + esc(g.reviewers.map((id) => model.userName(id) + (id === g.manager ? ' (manager)' : '')).join(', ')) + '</span>', g.decision === 'pending' ? UI.pill('pending', 'warn') : UI.pill(g.decision, g.decision === 'confirmed' ? 'ok' : g.decision === 'revoked' ? 'danger' : '') + (g.decidedAt ? '<br><span class="muted" style="font-size:11px">' + esc((g.decidedByName || model.userName(g.decidedBy)) + ', ' + when(g.decidedAt)) + '</span>' : ''), g.decision === 'pending' && sel.state === 'open' && mine(g) ? '<span class="hstack gap6" style="justify-content:flex-end">' + UI.btn('Confirm', { size: 'sm', attrs: 'data-decide="' + esc(g.id) + '" data-d="confirm"' }) + UI.btn('Revoke', { size: 'sm', kind: 'danger', attrs: 'data-decide="' + esc(g.id) + '" data-d="revoke"' }) + '</span>' : g.decision === 'pending' && sel.state === 'open' ? '<span class="muted" style="font-size:12px">' + (g.user.id === meId() ? 'your own grant' : 'not assigned to you') + '</span>' : ''], attrs: 'data-item="' + esc(g.id) + '"' })), { clickable: false, minWidth: '0', emptyTitle: sel.state === 'scheduled' ? 'Opens on its start date' : 'No grants match' });
    const toolbar = '<div class="toolbar"><span class="relative">' + UI.btn('Decision: ' + (st.gfilter || 'all'), { size: 'sm', icon: 'filter', attrs: 'data-gfilter', cls: st.gfilter && st.gfilter !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn(({ member: 'By member', kind: 'By kind' })[st.gsort] || 'Sort', { size: 'sm', icon: 'sort', attrs: 'data-gsort' }) + '</span><span class="muted right" style="font-size:12px">' + pending.length + ' pending, ' + mineP.length + ' assigned to you</span></div>';
    return { left, main: head + notices + meter + toolbar + table + '<div class="muted" style="font-size:12px">Reviewers confirm or revoke each grant (B-3305); the first decision stands. Overdue campaigns escalate; every decision is in the audit chain. <a href="#" data-goaudit>Open Usage and audit</a></div>' };
  }
  function wireReviews(ctx, st, model, h) {
    const cur = () => st.data[reviewUrl(st.review)];
    const refresh = () => { h.forget('/api/authz/reviews'); };
    ctx.on('click', '[data-review]', (e, t) => { st.review = t.dataset.review; st.lastRevoke = null; ctx.rerender(); });
    ctx.on('click', '[data-clearrevoke]', () => { st.lastRevoke = null; ctx.rerender(); });
    ctx.on('click', '[data-goaudit]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
    ctx.on('click', '[data-gfilter]', (e, t) => openMenu(ctx, t, [['all', 'All'], ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['revoked', 'Revoked'], ['expired', 'Expired']], st.gfilter || 'all', (v) => { st.gfilter = v; ctx.rerender(); }));
    ctx.on('click', '[data-gsort]', (e, t) => openMenu(ctx, t, [['none', 'As listed'], ['member', 'By member'], ['kind', 'By kind']], st.gsort || 'none', (v) => { st.gsort = v; ctx.rerender(); }));
    ctx.on('click', '[data-decide]', async (e, t) => {
      const r = cur(); const g = r.items.find((x) => x.id === t.dataset.decide); const d = t.dataset.d;
      const what = g.kind === 'role' ? 'role ' + g.grant.name : 'membership of ' + g.grant.name; const who = g.user.displayName || g.user.username;
      if (d === 'revoke') { const ok = await ctx.confirm({ title: 'Revoke grant', tag: 'next request', tone: 'danger', body: '<p class="fg2" style="margin:0">The grant is removed now and written to the audit chain. ' + esc(who) + ' loses it on their next request; open sockets leave the rooms it admitted them to.</p>', kv: [['Member', esc(who)], ['Grant', esc(what)]], ok: 'Revoke' }); if (!ok) return; }
      try {
        await App.post('/api/authz/reviews/' + enc(r.id) + '/items/' + enc(g.id) + '/decision', { decision: d });
        if (d === 'revoke') st.lastRevoke = g.id;
        refresh(); ctx.toast(d === 'confirm' ? esc(who) + '\'s ' + esc(what) + ' confirmed. authz.review.confirmed written.' : esc(who) + '\'s ' + esc(what) + ' revoked. Gone on the next request.', d === 'confirm' ? 'ok' : 'warn'); ctx.rerender();
      } catch (err) { App.fail(err, 'Not recorded'); refresh(); ctx.rerender(); }
    });
    ctx.on('click', '[data-bulkconfirm]', async () => {
      const r = cur(); const pend = r.items.filter((i) => i.decision === 'pending' && i.reviewers.indexOf(meId()) >= 0 && i.user.id !== meId());
      const ok = await ctx.confirm({ title: 'Confirm ' + pend.length + ' pending grant' + (pend.length === 1 ? '' : 's'), tag: 'bulk', tone: 'info', body: '<p class="fg2" style="margin:0">Each grant assigned to you is confirmed in its own audit entry. Revoke the ones that should go one by one first.</p>', ok: 'Confirm all' });
      if (!ok) return;
      let done = 0, failed = 0;
      for (const i of pend) { try { await App.post('/api/authz/reviews/' + enc(r.id) + '/items/' + enc(i.id) + '/decision', { decision: 'confirm' }); done++; } catch (err) { failed++; } }
      refresh(); ctx.toast(done + ' grant' + (done === 1 ? '' : 's') + ' confirmed' + (failed ? '; ' + failed + ' were already decided or not yours' : '') + '.', failed ? 'warn' : 'ok'); ctx.rerender();
    });
    ctx.on('click', '[data-openreview]', async () => {
      const r = cur();
      const ok = await ctx.confirm({ title: 'Open ' + r.name + ' now', tone: 'info', tag: 'snapshot', body: '<p class="fg2" style="margin:0">The grants in scope are snapshotted now and each assigned reviewer is notified. The due date counts from today.</p>', ok: 'Open' });
      if (!ok) return;
      try { await App.post('/api/authz/reviews/' + enc(r.id) + '/open', {}); refresh(); ctx.toast(esc(r.name) + ' opened. authz.review.opened written; reviewers notified.', 'ok'); ctx.rerender(); }
      catch (err) { App.fail(err, 'Not opened'); }
    });
    ctx.on('click', '[data-closecampaign]', async () => {
      const r = cur(); const scheduled = r.state === 'scheduled'; const left = r.items.filter((i) => i.decision === 'pending').length;
      const ok = await ctx.confirm({ title: scheduled ? 'Cancel campaign' : 'Close campaign', tone: scheduled || left ? 'danger' : 'info', tag: scheduled ? 'cancel' : 'close', body: '<p class="fg2" style="margin:0">' + (scheduled ? 'The campaign never opens.' : (left ? left + ' undecided grant' + (left === 1 ? '' : 's') + ' expire and stay in force. ' : 'Every grant is decided. ') + 'Closing writes the result to the audit chain' + (r.everyDays ? ' and schedules the next one in ' + r.everyDays + ' days' : '') + '.') + '</p>', ok: scheduled ? 'Cancel campaign' : 'Close' });
      if (!ok) return;
      try { await App.post('/api/authz/reviews/' + enc(r.id) + '/close', {}); refresh(); ctx.toast(scheduled ? 'Campaign cancelled. authz.review.cancelled written.' : 'Campaign closed. authz.review.closed written' + (r.everyDays ? '; next run scheduled.' : '.'), 'ok'); ctx.rerender(); }
      catch (err) { App.fail(err, 'Not closed'); }
    });
    ctx.on('click', '[data-newcampaign]', () => {
      const wsBase = st.data[WS_URL];
      const wss = wsBase ? wsBase.workspaces : [];
      const others = model.users.filter((u) => u.id !== meId() && u.state === 'active');
      ctx.modal({ title: 'New access review', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-cn maxlength="200"', placeholder: 'Q4 certification, Finance Ops' })) + UI.field('Grants', UI.select([{ value: 'role,workspace', label: 'Roles and workspace memberships' }, { value: 'role', label: 'Roles only' }, { value: 'workspace', label: 'Workspace memberships only' }], 'role,workspace', 'data-ck'))
        + UI.field('Members of', UI.select([{ value: '', label: 'The whole tenant' }].concat(wss.map((w) => ({ value: w.id, label: w.name }))), '', 'data-cw')) + UI.field('Roles in scope', UI.select([{ value: '', label: 'Every role you may grant' }].concat(model.matrix.roles.map((r) => ({ value: r.id, label: r.name }))), '', 'data-cr'))
        + UI.field('Extra reviewer', UI.select([{ value: '', label: 'None (admins and directory managers)' }].concat(others.map((u) => ({ value: u.id, label: u.displayName || u.username }))), '', 'data-cx'))
        + UI.field('Opens', UI.input('', { type: 'datetime-local', attrs: 'data-co' }), 'Empty opens it now.') + UI.field('Due after (days)', UI.input('14', { type: 'number', attrs: 'data-cd min="1" max="90"' })) + UI.field('Repeat every (days)', UI.input('', { type: 'number', attrs: 'data-ce min="7" max="366"', placeholder: 'once' })) + '</div>'
        + '<div data-cnote>' + UI.notice('Grants are snapshotted from the matrix when the campaign opens. Overdue campaigns escalate to the tenant admins after the due date.', 'info') + '</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-cgo' }),
      onMount(mm) {
        mm.querySelector('[data-cgo]').addEventListener('click', () => {
          const v = (s) => mm.querySelector(s).value.trim();
          const name = v('[data-cn]'); const note = mm.querySelector('[data-cnote]');
          if (!name) { note.innerHTML = UI.notice('Give the campaign a name.', 'warn'); mm.querySelector('[data-cn]').focus(); return; }
          const body = { name, kinds: v('[data-ck]').split(','), dueDays: Number(v('[data-cd]')) || 14 };
          if (v('[data-cw]')) body.workspaceId = v('[data-cw]');
          if (v('[data-cr]')) body.roles = [v('[data-cr]')];
          if (v('[data-cx]')) body.reviewerIds = [v('[data-cx]')];
          if (v('[data-ce]')) body.everyDays = Number(v('[data-ce]'));
          if (v('[data-co]')) { const d = new Date(v('[data-co]')); if (!isNaN(d.getTime())) body.opensAt = d.toISOString(); }
          App.post('/api/authz/reviews', body).then((r) => { App.closeOverlay(); refresh(); st.review = r.id; ctx.toast(esc(r.name) + (r.state === 'open' ? ' opened with ' + r.counts.total + ' grant' + (r.counts.total === 1 ? '' : 's') + '; reviewers notified.' : ' scheduled.') + ' authz.review.created written.', 'ok', 5000); ctx.rerender(); })
            .catch((err) => { note.innerHTML = UI.problem('Campaign not created', err.message, (err.problem && err.problem.trace_id) || false); });
        });
      } });
    });
  }

  function openMenu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative') || anchor.parentElement; const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    host.classList.add('relative');
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }
})();
