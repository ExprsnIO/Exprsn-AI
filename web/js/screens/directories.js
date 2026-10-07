(function () {
  const { UI, esc } = App;

  const KIND_LABEL = { ldap: 'OpenLDAP / LDAP', sql: 'SQL user table', local: 'Local accounts', oidc: 'Upstream OIDC', saml: 'Upstream SAML', github: 'GitHub', atproto: 'AT-Protocol accounts', scim: 'SCIM 2.0 provisioning' };
  const TEMPLATES = {
    ldap: { url: 'ldaps://ldap.example.internal:636', bindDN: 'cn=exprsn-svc,ou=services,dc=example,dc=internal', bindPassword: 'env:LDAP_BIND_PASSWORD', userBase: 'ou=people,dc=example,dc=internal', groupBase: 'ou=groups,dc=example,dc=internal', caFile: '/etc/exprsn-ai/ldap-ca.pem' },
    'sql:pg': { dialect: 'pg', connection: 'env:HR_PG_URL', table: 'users', columns: { id: 'id', username: 'username', passwordHash: 'password_hash', displayName: 'full_name', email: 'email', disabled: 'disabled', groups: 'groups' }, defaultRoles: [], defaultClearance: 'internal' },
    'sql:mysql': { dialect: 'mysql', connection: 'env:HR_MYSQL_URL', table: 'users', columns: { id: 'id', username: 'username', passwordHash: 'password_hash', displayName: 'full_name', email: 'email', disabled: 'disabled' }, groupTable: { table: 'user_groups', userColumn: 'user_id', groupColumn: 'group_name' }, defaultRoles: [], defaultClearance: 'internal' },
    'sql:sqlite': { dialect: 'sqlite', connection: 'file:/etc/exprsn-ai/secrets/hr-sqlite-path', table: 'users', columns: { username: 'username', passwordHash: 'password_hash', displayName: 'display_name' }, defaultRoles: ['member'], defaultClearance: 'internal' },
    // 1.4.0: GitHub sign-in (B-1804) and AT-Protocol accounts (B-1808).
    github: { clientId: 'Iv1.0123456789abcdef', clientSecret: 'file:/run/secrets/github-client-secret', webUrl: 'https://github.com', apiUrl: 'https://api.github.com', allowedOrgs: [], scopes: 'read:user user:email read:org', defaultRoles: [], defaultClearance: 'internal' },
    atproto: { boundOnly: true, authServers: [], defaultRoles: ['member'], defaultClearance: 'internal' },
    // 1.6.0 (B-7201): users and groups pushed by Entra ID or Okta at /scim/v2; tokens under Identity.
    scim: { signInStores: [], defaultRoles: [], defaultClearance: 'internal' }
  };
  const KIND_HINT = {
    scim: 'Users and groups are pushed by your identity provider (Entra ID, Okta) to <span class="mono">&lt;issuer&gt;/scim/v2</span> with a SCIM token made under Identity, User stores and federation. No passwords: <span class="mono">signInStores</span> names the OIDC, SAML or GitHub stores (by id) its users sign in through. Group mappings with this store name the SCIM groups\' display names; deactivation ends sessions, OAuth grants, API keys and app passwords at once.',
    github: 'GitHub or GitHub Enterprise Server as an OAuth app. Register its callback as <span class="mono">&lt;issuer&gt;/federation/github/callback</span>. Only a verified primary address is kept; organisations become groups <span class="mono">org</span> and teams <span class="mono">org/team-slug</span>; <span class="mono">allowedOrgs</span> refuses everyone else. Both addresses pass the service URL checks when saved and at every connection.',
    atproto: 'No passwords and no directory. A DID bound to a user (in their Settings) signs in as that user; others are provisioned just in time with the handle as username and the DID as their only group. <span class="mono">boundOnly</span> refuses unbound DIDs; <span class="mono">authServers</span> (origins) limits the authorization servers accepted.'
  };
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const kindOf = (p) => (p.kind === 'sql' ? 'SQL (' + ({ pg: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' }[p.config.dialect] || p.config.dialect) + ')' : KIND_LABEL[p.kind]);
  const stepsHtml = (steps) => UI.timeline(steps.map((s) => ({ title: esc(s.title.trim()), text: s.detail ? esc(s.detail) : '', meta: s.ms != null ? s.ms + ' ms' : '', tone: s.ok ? 'ok' : 'danger' })));
  const configView = (cfg) => UI.code(JSON.stringify(cfg, null, 2), 'json');

  App.register({
    id: 'directories', title: 'User stores', section: 'admin', live: true,
    summary: 'OpenLDAP, SQL, GitHub and AT-Protocol user stores, sign-in order, group mappings, users and sessions',
    crumb: ['Admin', 'User stores'],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = ctx.params.tab || st.tab || 'stores';
      if (ctx.params.store) { st.sel = ctx.params.store; delete ctx.params.store; }
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/admin/identity-providers'), App.get('/api/admin/group-mappings'), App.get('/api/admin/roles'), App.get('/api/admin/users' + (st.q ? '?q=' + encodeURIComponent(st.q) : '')), App.get('/api/admin/sessions')])
          .then(([providers, mappings, roles, users, sessions]) => { Object.assign(st, { providers, mappings, roles, users, sessions, loaded: true, loadError: null }); if (!st.sel && providers[0]) st.sel = providers[0].id; })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; if (App.state.route === 'directories') ctx.rerender(); });
      };
      if (!st.loaded && !st.loadError) load();
      const reload = () => { st.loaded = false; st.loadError = null; ctx.rerender(); };
      const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) ctx.toast(okMsg, 'ok'); reload(); return r; } catch (err) { App.fail(err); return null; } };

      const providers = st.providers || [];
      const roleName = (id) => ((st.roles || []).find((r) => r.id === id) || { name: id }).name;
      const storeName = (id) => (id ? (providers.find((p) => p.id === id) || { name: 'removed store' }).name : 'Any store');

      let body = '';
      if (st.loadError) body = UI.problem('User stores could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id);
      else if (!st.loaded) body = UI.notice('Loading…', 'info');
      else if (st.tab === 'stores') {
        const sel = providers.find((p) => p.id === st.sel) || providers[0];
        const rows = providers.map((p, i) => ({ cells: ['<span class="num">' + (i + 1) + '</span>', esc(p.name), esc(kindOf(p)), UI.pill(p.enabled ? 'enabled' : 'disabled', p.enabled ? 'ok' : ''), p.managedBy === 'config' ? UI.pill('config file', 'outline') : 'console'], attrs: 'data-store="' + esc(p.id) + '"', selected: sel && p.id === sel.id }));
        const inspector = sel ? '<aside class="inspector w360"><div class="hstack"><h3 class="grow" style="margin:0">' + esc(sel.name) + '</h3>' + UI.pill(sel.enabled ? 'enabled' : 'disabled', sel.enabled ? 'ok' : '') + '</div>'
          + UI.kv([['Kind', esc(kindOf(sel))], ['Order', String(providers.indexOf(sel) + 1) + ' of ' + providers.length], ['Managed by', sel.managedBy === 'config' ? 'configuration file' : 'console'], ['Changed', esc(when(sel.updatedAt))]], 2)
          + '<div class="eyebrow">Configuration</div>' + configView(sel.config)
          + '<div class="muted" style="font-size:12px">Secrets are references (<span class="mono">env:</span> or <span class="mono">file:</span>) resolved on the server; values never pass through the console.</div>'
          + (st.test && st.test.id === sel.id ? '<div class="eyebrow">Connection test ' + UI.pill(st.test.ok ? 'passed' : 'failed') + '</div>' + stepsHtml(st.test.steps) : '')
          + '<div class="hstack wrap gap6">' + UI.btn('Test connection', { size: 'sm', icon: 'play', attrs: 'data-test' }) + UI.btn(sel.enabled ? 'Disable' : 'Enable', { size: 'sm', attrs: 'data-toggle' }) + UI.iconbtn('chevd', 'Move later in the order', { attrs: 'data-move="1"', cls: 'sm ghost' }) + UI.iconbtn('chevd', 'Move earlier in the order', { attrs: 'data-move="-1" style="transform:rotate(180deg)"', cls: 'sm ghost' })
          + (sel.managedBy === 'config' ? '' : UI.btn('Edit', { size: 'sm', kind: 'ghost', icon: 'edit', attrs: 'data-edit' }) + UI.btn('Remove', { size: 'sm', kind: 'ghost', icon: 'trash', attrs: 'data-remove' })) + '</div></aside>' : '';
        body = '<div class="cols" style="align-items:flex-start;gap:14px"><div class="grow vstack gap12">'
          + UI.notice('Stores are asked in this order. A store that does not know the username passes to the next; a wrong password in the store that owns the username stops there, so one password is never tried against several stores.', 'info')
          + UI.table(['#', 'Name', 'Kind', 'State', 'Managed in'], rows, { minWidth: '0', emptyTitle: 'No user stores', emptyText: 'Add OpenLDAP or a SQL user table.' })
          + '<div>' + UI.btn('Add user store', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-add' }) + '</div></div>' + inspector + '</div>';
      } else if (st.tab === 'mappings') {
        body = UI.notice('A member of several mapped groups gets every mapped role and the highest clearance. Changes apply at each user\'s next sign-in. Users with no mapped group are refused unless their store sets default roles.', 'info')
          + UI.table(['Group', 'Store', 'Role', 'Clearance', { label: '', right: true }], (st.mappings || []).map((m) => ({ cells: ['<span class="mono">' + esc(m.group_name) + '</span>', esc(storeName(m.provider_id)), esc(roleName(m.role)), UI.label(m.clearance, { sm: true }), '<span class="hstack" style="justify-content:flex-end">' + UI.btn('Remove', { kind: 'ghost', size: 'sm', attrs: 'data-rmmap="' + esc(m.id) + '"' }) + '</span>'] })), { minWidth: '0', clickable: false, emptyTitle: 'No group mappings', emptyText: 'Map a directory group to a role and clearance.' })
          + UI.panel('Add a mapping', '<div class="formgrid" style="--cols:4">' + UI.field('Group (DN or name)', UI.input('', { placeholder: 'cn=finance-ops,ou=groups,dc=example,dc=internal', attrs: 'data-mgroup' }))
            + UI.field('Store', UI.select([{ value: '', label: 'Any store' }].concat(providers.filter((p) => p.kind !== 'local').map((p) => ({ value: p.id, label: p.name }))), '', 'data-mstore'))
            + UI.field('Role', UI.select((st.roles || []).map((r) => ({ value: r.id, label: r.name })), 'member', 'data-mrole'))
            + UI.field('Clearance', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal', 'data-mclear')) + '</div><div>' + UI.btn('Add mapping', { kind: 'primary', size: 'sm', attrs: 'data-addmap' }) + '</div>');
      } else if (st.tab === 'users') {
        body = '<div class="toolbar hstack gap6">' + UI.search('Search users', 'data-q', st.q || '') + '<span class="grow"></span>' + UI.btn('Create local account', { size: 'sm', icon: 'plus', attrs: 'data-newuser' }) + '</div>'
          + UI.table(['Username', 'Name', 'Roles', 'Clearance', 'State', 'Last sign-in'], (st.users || []).map((u) => ({ cells: ['<span class="mono">' + esc(u.username) + '</span>', esc(u.displayName), esc(u.roles.map(roleName).join(', ')), UI.label(u.clearance, { sm: true }), UI.pill(u.state === 'active' ? 'active' : 'disabled', u.state === 'active' ? 'ok' : 'danger'), esc(when(u.lastLoginAt))], attrs: 'data-user="' + esc(u.id) + '"' })), { minWidth: '0', emptyTitle: 'No users', emptyText: 'Users appear here after their first sign-in.' });
      } else if (st.tab === 'sessions') {
        body = UI.table(['User', 'Signed in with', 'Stage', 'Address', 'Started', 'Last activity', { label: '', right: true }], (st.sessions || []).map((s) => ({ cells: [esc(s.user.displayName) + ' <span class="mono muted">' + esc(s.user.username) + '</span>', esc(s.method), UI.pill(s.stage === 'active' ? 'active' : 'second factor pending', s.stage === 'active' ? 'ok' : 'warn'), '<span class="mono">' + esc(s.ip || '') + '</span>', esc(when(s.createdAt)), esc(when(s.lastSeenAt)), '<span class="hstack" style="justify-content:flex-end">' + UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-revoke="' + esc(s.id) + '"' }) + '</span>'] })), { minWidth: '0', clickable: false, emptyTitle: 'No sessions', emptyText: '' });
      } else if (st.tab === 'test') {
        const r = st.testLogin;
        body = '<div class="cols" style="align-items:flex-start;gap:14px"><div class="panel" style="width:340px;max-width:100%">' + '<div class="eyebrow">Test a login</div><div class="fg2" style="font-size:12px">Runs the real sign-in chain without creating a session or provisioning anyone. Failed attempts count toward lockout and every test is audited.</div>'
          + UI.field('Username', UI.input(st.tlUser || '', { attrs: 'data-tluser autocomplete="off"' })) + UI.field('Password', UI.input('', { type: 'password', attrs: 'data-tlpass autocomplete="new-password"' }))
          + '<div>' + UI.btn(st.tlBusy ? 'Testing…' : 'Run test', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-runtest' + (st.tlBusy ? ' disabled' : '') }) + '</div></div>'
          + (r ? '<div class="grow vstack gap12">' + UI.notice(r.result === 'ok' ? '<b>' + esc(r.provider.name) + '</b> accepted the password.' : r.result === 'not_found' ? 'No store knows this username.' : '<b>' + esc(r.provider ? r.provider.name : '') + '</b> owns the username and answered <b>' + esc(r.result.replace('_', ' ')) + '</b>.', r.result === 'ok' ? 'ok' : 'danger')
            + (r.user ? UI.panel('Directory answer', UI.kv([['External id', '<span class="mono">' + esc(r.user.externalId) + '</span>'], ['Name', esc(r.user.displayName)], ['Email', esc(r.user.email || '')], ['Groups', r.user.groups.length ? r.user.groups.map((g) => '<div class="mono">' + esc(g) + '</div>').join('') : '<span class="muted">none</span>']], 2)) : '')
            + (r.mapping ? UI.panel('Would sign in as', r.mapping.roles.length ? UI.kv([['Roles', esc(r.mapping.roles.map(roleName).join(', '))], ['Clearance', r.mapping.clearance ? UI.label(r.mapping.clearance, { sm: true }) : '']], 2) : UI.notice('No mapped group and no default roles: sign-in would be refused.', 'warn')) : '')
            + UI.panel('Steps', stepsHtml(r.steps)) + '</div>' : '') + '</div>';
      }

      root.innerHTML = '<div class="page">' + UI.pagehead('User stores', 'Where ' + esc(App.me.tenant ? App.me.tenant.name : 'this tenant') + ' users sign in from, and what their groups grant', UI.btn('Refresh', { kind: 'ghost', size: 'sm', icon: 'refresh', attrs: 'data-reload' }))
        + UI.tabs([{ id: 'stores', label: 'Stores', count: providers.length }, { id: 'mappings', label: 'Group mappings', count: (st.mappings || []).length }, { id: 'users', label: 'Users' }, { id: 'sessions', label: 'Sessions', count: (st.sessions || []).length }, { id: 'test', label: 'Test a login' }], st.tab)
        + body + '</div>';

      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; delete ctx.params.tab; ctx.rerender(); });
      ctx.on('click', '[data-reload]', reload);

      // ---- stores ----
      const sel = providers.find((p) => p.id === st.sel) || providers[0];
      ctx.on('click', '[data-store]', (e, t) => { st.sel = t.dataset.store; ctx.rerender(); });
      ctx.on('click', '[data-test]', async () => { try { const r = await App.post('/api/admin/identity-providers/' + encodeURIComponent(sel.id) + '/test'); st.test = { id: sel.id, ok: r.ok, steps: r.steps }; ctx.rerender(); } catch (err) { App.fail(err); } });
      ctx.on('click', '[data-toggle]', async () => {
        if (sel.enabled) { const ok = await ctx.confirm({ title: 'Disable ' + sel.name + '?', tag: 'sign-in', tone: 'danger', body: '<div class="fg2">Users from this store cannot sign in while it is disabled. Existing sessions continue until they expire or are revoked.</div>', ok: 'Disable' }); if (!ok) return; }
        act(() => App.patch('/api/admin/identity-providers/' + encodeURIComponent(sel.id), { enabled: !sel.enabled }), sel.name + (sel.enabled ? ' disabled.' : ' enabled.'));
      });
      ctx.on('click', '[data-move]', (e, t) => {
        const i = providers.indexOf(sel); const j = i + Number(t.dataset.move); if (j < 0 || j >= providers.length) return;
        const other = providers[j];
        // Swap positions; equal positions are spread first so the order is well defined.
        const a = sel.position === other.position ? (j > i ? other.position + 1 : other.position - 1) : other.position;
        act(async () => { await App.patch('/api/admin/identity-providers/' + encodeURIComponent(sel.id), { position: Math.max(0, a) }); await App.patch('/api/admin/identity-providers/' + encodeURIComponent(other.id), { position: sel.position }); }, 'Order changed.');
      });
      ctx.on('click', '[data-remove]', async () => { const ok = await ctx.confirm({ title: 'Remove ' + sel.name + '?', tag: 'cannot be undone', tone: 'danger', body: '<div class="fg2">Its group mappings and identity links go with it. Users keep their accounts but cannot sign in through this store.</div>', ok: 'Remove store' }); if (ok) act(() => App.del('/api/admin/identity-providers/' + encodeURIComponent(sel.id)), 'Store removed. Audit entry written.').then(() => { st.sel = null; }); });
      const storeModal = (existing) => {
        const kinds = [{ value: 'ldap', label: 'OpenLDAP / LDAP directory' }, { value: 'sql:pg', label: 'PostgreSQL user table' }, { value: 'sql:mysql', label: 'MySQL user table' }, { value: 'sql:sqlite', label: 'SQLite user table' }, { value: 'local', label: 'Local accounts' }, { value: 'github', label: 'GitHub sign-in' }, { value: 'atproto', label: 'AT-Protocol accounts' }, { value: 'scim', label: 'SCIM 2.0 provisioning (Entra ID, Okta)' }];
        // `existing` is a store to edit, or the kind (a TEMPLATES key) a new store starts as.
        const preset = typeof existing === 'string' ? existing : null;
        if (preset) existing = null;
        const startKind = existing ? (existing.kind === 'sql' ? 'sql:' + existing.config.dialect : existing.kind) : (preset || 'ldap');
        ctx.modal({ cls: 'wide', title: existing ? 'Edit ' + esc(existing.name) : 'Add user store',
          body: '<div class="formgrid" style="--cols:3">' + UI.field('Name', UI.input(existing ? existing.name : '', { attrs: 'data-sname maxlength="100"', placeholder: 'for example Corporate OpenLDAP' })) + UI.field('Kind', UI.select(kinds, startKind, 'data-skind' + (existing ? ' disabled' : ''))) + UI.field('Order', UI.input(String(existing ? existing.position : 10 * (providers.length + 1)), { type: 'number', attrs: 'data-spos min="0" max="10000"' }), 'Lower is asked first') + '</div>'
            + UI.field('Configuration (JSON)', UI.textarea(JSON.stringify(existing ? existing.config : TEMPLATES[startKind] || {}, null, 2), { attrs: 'data-scfg spellcheck="false" style="font-family:var(--mono);font-size:12px"', rows: 14 }), 'Secrets as <span class="mono">env:NAME</span> (a variable your operator has allowed) or <span class="mono">file:/path</span> (inside the secrets directories); the server\'s own settings are never readable. Directory and database hosts must be internal. LDAP needs ldaps:// or StartTLS. SQL stores accept argon2 and bcrypt hashes only; grant the account SELECT on the user table.')
            + '<div data-skindhint>' + (KIND_HINT[startKind] ? UI.notice(KIND_HINT[startKind], 'info') : '') + '</div><div data-serr></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(existing ? 'Save' : 'Add store', { kind: 'primary', attrs: 'data-ssave' }),
          onMount(m) {
            const kindEl = m.querySelector('[data-skind]'); const cfgEl = m.querySelector('[data-scfg]');
            kindEl.addEventListener('change', () => { cfgEl.value = JSON.stringify(TEMPLATES[kindEl.value] || {}, null, 2); m.querySelector('[data-skindhint]').innerHTML = KIND_HINT[kindEl.value] ? UI.notice(KIND_HINT[kindEl.value], 'info') : ''; });
            m.querySelector('[data-ssave]').addEventListener('click', async () => {
              const errBox = m.querySelector('[data-serr]'); errBox.innerHTML = '';
              let config; try { config = JSON.parse(cfgEl.value || '{}'); } catch (e) { errBox.innerHTML = UI.notice('The configuration is not valid JSON: ' + esc(e.message), 'danger'); return; }
              const body = { name: m.querySelector('[data-sname]').value.trim(), position: Number(m.querySelector('[data-spos]').value), config };
              try {
                if (existing) await App.patch('/api/admin/identity-providers/' + encodeURIComponent(existing.id), body);
                else { const created = await App.post('/api/admin/identity-providers', Object.assign(body, { kind: kindEl.value.split(':')[0], enabled: true })); st.sel = created.id; }
                App.closeOverlay(); ctx.toast(existing ? 'Store saved.' : 'Store added. Run a connection test next.', 'ok'); reload();
              } catch (err) {
                const p = err.problem || {};
                errBox.innerHTML = UI.notice('<b>' + esc(p.detail || err.message) + '</b>' + (p.errors ? '<ul style="margin:4px 0 0;padding-left:18px">' + p.errors.map((x) => '<li><span class="mono">' + esc(x.path) + '</span>: ' + esc(x.message) + '</li>').join('') + '</ul>' : ''), 'danger');
              }
            });
          } });
      };
      ctx.on('click', '[data-add]', () => storeModal(null));
      // From Identity's "Add GitHub or AT-Protocol store": opens the dialog with that kind once the stores are loaded.
      if (st.loaded && ctx.params.add && TEMPLATES[ctx.params.add]) {
        const k = ctx.params.add; delete ctx.params.add;
        // Take it out of the address too, so a later render (after saving) does not open the dialog again.
        try { history.replaceState(null, '', location.pathname + location.search + '#/directories?tab=' + encodeURIComponent(st.tab)); } catch (e) { /* history unavailable */ }
        setTimeout(() => { if (App.state.route === 'directories') storeModal(k); }, 50);
      }
      ctx.on('click', '[data-edit]', () => storeModal(sel));

      // ---- mappings ----
      ctx.on('click', '[data-addmap]', () => {
        const group = ctx.$('[data-mgroup]').value.trim(); if (!group) { ctx.toast('Enter a group.', 'warn'); return; }
        const providerId = ctx.$('[data-mstore]').value || null;
        act(() => App.post('/api/admin/group-mappings', { group, providerId, role: ctx.$('[data-mrole]').value, clearance: ctx.$('[data-mclear]').value }), 'Mapping added. It applies at each member\'s next sign-in.');
      });
      ctx.on('click', '[data-rmmap]', async (e, t) => { const m = st.mappings.find((x) => x.id === t.dataset.rmmap); const ok = await ctx.confirm({ title: 'Remove this mapping?', tone: 'danger', kv: [['Group', '<span class="mono">' + esc(m.group_name) + '</span>'], ['Role', esc(roleName(m.role))]], body: '<div class="fg2">Members lose the role at their next sign-in. Users left with no mapped group are refused.</div>', ok: 'Remove mapping' }); if (ok) act(() => App.del('/api/admin/group-mappings/' + encodeURIComponent(m.id)), 'Mapping removed.'); });

      // ---- users ----
      let qTimer = null;
      ctx.on('input', '[data-q]', (e, t) => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = t.value.trim(); reload(); }, 300); });
      ctx.on('click', '[data-user]', async (e, t) => {
        let u; try { u = await App.get('/api/admin/users/' + encodeURIComponent(t.dataset.user)); } catch (err) { App.fail(err); return; }
        const self = u.id === App.me.user.id;
        const direct = u.roles.filter((r) => r.source === 'direct').map((r) => r.role);
        const mapped = u.roles.filter((r) => r.source === 'mapping').map((r) => r.role);
        ctx.drawer({ title: esc(u.displayName) + ' ' + UI.pill(u.state === 'active' ? 'active' : 'disabled', u.state === 'active' ? 'ok' : 'danger'),
          body: UI.kv([['Username', '<span class="mono">' + esc(u.username) + '</span>'], ['Email', esc(u.email || '')], ['Clearance', UI.label(u.clearance, { sm: true })], ['Last sign-in', esc(when(u.lastLoginAt))], ['From groups', esc(mapped.map(roleName).join(', ') || 'none')], ['Second factors', u.factors.length ? esc(u.factors.map((f) => f.label).join(', ')) : (u.mfaRequired ? UI.pill('required, not set up', 'warn') : 'none')], ['Password', u.password && u.password.local ? (u.password.mustChange ? UI.pill('must change at next sign-in', 'warn') : 'kept here') : 'kept by the directory']], 2)
            + (u.disabledReason ? UI.notice('Disabled: ' + esc(u.disabledReason), 'danger') : '')
            + '<div class="eyebrow">Identity links</div>' + UI.table(['Store', 'External id', 'Last seen'], u.identities.map((i) => [esc(i.provider), '<span class="mono" style="overflow-wrap:anywhere">' + esc(i.externalId) + '</span>', esc(when(i.lastSeenAt))]), { minWidth: '0', cls: 'bare', clickable: false })
            + (self ? UI.notice('You cannot change your own roles, clearance or state.', 'info') : '<div class="eyebrow">Directly granted roles</div><div class="hstack wrap gap6" style="row-gap:6px">' + (st.roles || []).map((r) => UI.check(r.name, direct.indexOf(r.id) >= 0, 'data-drole="' + esc(r.id) + '"')).join('') + '</div>'
              + UI.field('Direct clearance', UI.select([{ value: '', label: 'From groups only' }, 'public', 'internal', 'confidential', 'restricted'], u.clearanceDirect || '', 'data-dclear'), 'Raises the clearance from group mappings; never lowers it at sign-in.')),
          actions: self ? UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }) : UI.btn('Save access', { kind: 'primary', attrs: 'data-saveuser' }) + UI.btn(u.state === 'active' ? 'Disable user' : 'Enable user', { kind: u.state === 'active' ? 'danger' : '', attrs: 'data-userstate' }) + (u.factors.length ? UI.btn('Reset second factors', { kind: 'ghost', attrs: 'data-resetmfa' }) : '') + (u.password && u.password.local ? UI.btn('Reset password', { kind: 'ghost', attrs: 'data-resetpw' }) : '') + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(d) {
            const $d = (sel2) => d.querySelector(sel2);
            if (self) return;
            $d('[data-saveuser]').addEventListener('click', async () => {
              const roles = Array.prototype.slice.call(d.querySelectorAll('[data-drole]:checked')).map((c) => c.dataset.drole);
              const ok = await ctx.confirm({ title: 'Change access for ' + u.username + '?', tag: 'ends their sessions', tone: 'danger', body: '<div class="fg2">Their sessions end so the change applies on the next request.</div>', ok: 'Save' });
              if (ok) act(() => App.patch('/api/admin/users/' + encodeURIComponent(u.id), { roles, clearanceDirect: $d('[data-dclear]').value || null }), 'Access updated. Audit entry written.');
            });
            $d('[data-userstate]').addEventListener('click', async () => {
              if (u.state === 'active') {
                // The confirm dialog is gone when it resolves, so keep the reason as it is typed.
                let reason = '';
                const keep = (ev) => { if (ev.target && ev.target.hasAttribute && ev.target.hasAttribute('data-disreason')) reason = ev.target.value.trim(); };
                document.addEventListener('input', keep);
                const ok = await ctx.confirm({ title: 'Disable ' + u.username + '?', tag: 'ends sessions and keys', tone: 'danger', body: UI.field('Reason', UI.input('', { attrs: 'data-disreason maxlength="200"', placeholder: 'for example Left the company' })), ok: 'Disable user' });
                document.removeEventListener('input', keep);
                if (ok) act(() => App.patch('/api/admin/users/' + encodeURIComponent(u.id), { state: 'disabled', disabledReason: reason || undefined }), u.username + ' disabled. Sessions and API keys revoked.');
              } else act(() => App.patch('/api/admin/users/' + encodeURIComponent(u.id), { state: 'active' }), u.username + ' enabled.');
            });
            const rp = $d('[data-resetpw]');
            if (rp) rp.addEventListener('click', () => {
              ctx.modal({ title: 'Reset the password for ' + esc(u.username), body: UI.notice('The current password stops working at once and every session and application of this account is signed out.', 'warn')
                + UI.field('How', UI.select([{ value: 'temporary', label: 'Set a temporary password they change at next sign-in' }, { value: 'link', label: 'Email them a single-use link' + (u.email ? '' : ' (no email address)') }], 'temporary', 'data-rpmode'))
                + '<div data-rptemp>' + UI.field('Temporary password', UI.input('', { type: 'password', attrs: 'data-rppw autocomplete="new-password"' }), 'At least 12 characters. Share it out of band.') + App.passwordMeter.html() + '</div>'
                + UI.check('Also revoke their API keys', true, 'data-rpkeys'),
                actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reset password', { kind: 'danger', attrs: 'data-rpgo' }),
                onMount(m) {
                  const mode = m.querySelector('[data-rpmode]'); const temp = m.querySelector('[data-rptemp]');
                  mode.addEventListener('change', () => { temp.hidden = mode.value !== 'temporary'; });
                  App.passwordMeter.attach(m.querySelector('[data-rppw]'), temp.querySelector('[data-pwmeter]'), () => ({ username: u.username }));
                  m.querySelector('[data-rpgo]').addEventListener('click', async () => {
                    const body = mode.value === 'temporary' ? { mode: 'temporary', password: m.querySelector('[data-rppw]').value } : { mode: 'link' };
                    body.revokeApiKeys = m.querySelector('[data-rpkeys]').checked;
                    if (body.mode === 'temporary' && !body.password) { ctx.toast('Enter a temporary password.', 'warn'); return; }
                    try { const r = await App.post('/api/admin/users/' + encodeURIComponent(u.id) + '/password', body); App.closeOverlay(); ctx.toast((r.mode === 'link' ? (r.linkSent ? 'Password reset. A link was emailed to ' + esc(u.username) + '.' : 'Password reset, but the email could not be sent. Set a temporary password instead.') : 'Temporary password set. ' + esc(u.username) + ' changes it at next sign-in.') + (r.apiKeysRevoked ? ' ' + r.apiKeysRevoked + ' API key' + (r.apiKeysRevoked === 1 ? '' : 's') + ' revoked.' : ''), r.mode === 'link' && !r.linkSent ? 'warn' : 'ok'); reload(); } catch (err) { App.fail(err, 'Password not reset'); }
                  });
                } });
            });
            const rm = $d('[data-resetmfa]'); if (rm) rm.addEventListener('click', async () => { const ok = await ctx.confirm({ title: 'Reset second factors for ' + u.username + '?', tone: 'danger', body: '<div class="fg2">Their factors and recovery codes are removed and their sessions end. If their roles need a second factor they enrol a new one at next sign-in.</div>', ok: 'Reset' }); if (ok) act(() => App.post('/api/admin/users/' + encodeURIComponent(u.id) + '/reset-mfa'), 'Second factors reset.'); });
          } });
      });
      ctx.on('click', '[data-newuser]', () => {
        ctx.modal({ title: 'Create local account', body: UI.notice('Local accounts are for bootstrap and break-glass use. Everyone else should come from a directory.', 'info')
          + '<div class="formgrid">' + UI.field('Username', UI.input('', { attrs: 'data-nu maxlength="190" autocomplete="off"' })) + UI.field('Display name', UI.input('', { attrs: 'data-nd maxlength="200"' })) + UI.field('Email', UI.input('', { type: 'email', attrs: 'data-ne' })) + UI.field('Clearance', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal', 'data-nc')) + '</div>'
          + UI.check('Email an invitation to set a password instead (needs an email address)', false, 'data-ninv')
          + '<div data-npwrap>' + UI.field('Initial password', UI.input('', { type: 'password', attrs: 'data-np autocomplete="new-password"' }), 'At least 12 characters. Share it out of band.') + App.passwordMeter.html()
          + UI.check('Must change it at first sign-in', true, 'data-nmc') + '</div>'
          + '<div class="hstack wrap gap6" style="row-gap:6px">' + (st.roles || []).map((r) => UI.check(r.name, r.id === 'member', 'data-nr="' + esc(r.id) + '"')).join('') + '</div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create account', { kind: 'primary', attrs: 'data-nsave' }),
          onMount(m) {
            const inv = m.querySelector('[data-ninv]'); inv.addEventListener('change', () => { m.querySelector('[data-npwrap]').hidden = inv.checked; });
            App.passwordMeter.attach(m.querySelector('[data-np]'), m.querySelector('[data-npwrap] [data-pwmeter]'), () => ({ username: m.querySelector('[data-nu]').value.trim() }));
            m.querySelector('[data-nsave]').addEventListener('click', async () => {
              const body = { username: m.querySelector('[data-nu]').value.trim(), displayName: m.querySelector('[data-nd]').value.trim(), email: m.querySelector('[data-ne]').value.trim() || null, clearance: m.querySelector('[data-nc]').value, roles: Array.prototype.slice.call(m.querySelectorAll('[data-nr]:checked')).map((c) => c.dataset.nr) };
              if (inv.checked) body.invite = true; else { body.password = m.querySelector('[data-np]').value; body.mustChange = m.querySelector('[data-nmc]').checked; }
              try { const r = await App.post('/api/admin/users', body); App.closeOverlay(); ctx.toast('Account ' + esc(body.username) + ' created.' + (body.invite ? (r.invited ? ' Invitation sent.' : ' The invitation email could not be sent.') : ''), body.invite && !r.invited ? 'warn' : 'ok'); reload(); } catch (err) { App.fail(err, 'Account not created'); }
            });
          } });
      });

      // ---- sessions ----
      ctx.on('click', '[data-revoke]', async (e, t) => { const s = st.sessions.find((x) => x.id === t.dataset.revoke); const ok = await ctx.confirm({ title: 'Revoke this session?', tag: 'signs the user out', tone: 'danger', kv: [['User', esc(s.user.username)], ['Signed in with', esc(s.method)], ['Last activity', esc(when(s.lastSeenAt))]], ok: 'Revoke session' }); if (ok) act(() => App.del('/api/admin/sessions/' + encodeURIComponent(s.id)), 'Session revoked. Its live connection was closed.'); });

      // ---- test login ----
      ctx.on('click', '[data-runtest]', async () => {
        st.tlUser = ctx.$('[data-tluser]').value.trim(); const password = ctx.$('[data-tlpass]').value;
        if (!st.tlUser || !password) { ctx.toast('Enter a username and password.', 'warn'); return; }
        st.tlBusy = true; ctx.rerender();
        try { st.testLogin = await App.post('/api/admin/test-login', { username: st.tlUser, password }); } catch (err) { App.fail(err, 'Test failed to run'); } finally { st.tlBusy = false; ctx.rerender(); }
      });
    }
  });
})();
