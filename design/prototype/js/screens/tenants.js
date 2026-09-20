(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  const TREE = [
    { id: 'northwind', type: 'tenant', name: 'Northwind', sub: 'tenant, ou=northwind,dc=corp', dn: 'ou=northwind,dc=corp', key: 'tenant-northwind-dek, OpenBao transit', policy: 'Cedar baseline v7 + northwind v31' },
    { id: 'finance-ops', type: 'workspace', tenant: 'northwind', name: 'Finance Ops', sub: 'workspace, 38 members', members: 38, label: 'confidential' },
    { id: 'people-ops', type: 'workspace', tenant: 'northwind', name: 'People Ops', sub: 'workspace, 12 members', members: 12, label: 'internal' },
    { id: 'field-sales', type: 'workspace', tenant: 'northwind', name: 'Field Sales', sub: 'workspace, 141 members', members: 141, label: 'internal' },
    { id: 'contoso', type: 'tenant', name: 'Contoso Freight', sub: 'tenant, ou=contoso,dc=corp', dn: 'ou=contoso,dc=corp', key: 'tenant-contoso-dek, OpenBao transit', policy: 'Cedar baseline v7 + contoso v3' },
    { id: 'platform-lab', type: 'workspace', tenant: 'contoso', name: 'Platform lab', sub: 'workspace, 9 members', members: 9, label: 'public' }
  ];

  const ROLES = [
    ['system admin', 'Everything, including platform imports, zones and other tenants'], ['tenant admin', 'Workspaces, mappings, quotas and offboarding for this tenant'], ['identity admin', 'OIDC clients, SAML providers, keys and sessions'],
    ['model admin', 'Model catalog, imports, approvals and placement'], ['guardrail admin', 'Guardrail profiles and rules'], ['tool admin', 'MCP servers, tools and egress allow-lists'],
    ['knowledge curator', 'Knowledge bases, documents and labels'], ['ML admin', 'Datasets, fine-tune jobs and evals'], ['workflow admin', 'Workflow definitions and approvals'],
    ['connection admin', 'Database and search connections'], ['flag reviewer', 'Flag queue, decisions and escalations'], ['member', 'Chat, compare, own conversations and memory'], ['auditor', 'Read the audit chain and usage; nothing else']
  ];

  const MAPPINGS = {
    'finance-ops': [
      { dn: 'cn=finops-analysts,ou=groups,ou=northwind', role: 'member', members: 31, clearance: 'confidential' },
      { dn: 'cn=finops-leads,ou=groups,ou=northwind', role: 'knowledge curator', members: 4, clearance: 'confidential' },
      { dn: 'cn=ai-flag-review,ou=groups,ou=northwind', role: 'flag reviewer', members: 3, clearance: 'confidential' },
      { dn: 'cn=ai-admins,ou=groups,ou=northwind', role: 'tenant admin', members: 2, clearance: 'restricted' }
    ],
    'people-ops': [{ dn: 'cn=hr-partners,ou=groups,ou=northwind', role: 'member', members: 12, clearance: 'internal' }],
    'field-sales': [{ dn: 'cn=sales-eu,ou=groups,ou=northwind', role: 'member', members: 139, clearance: 'internal' }, { dn: 'cn=sales-ops,ou=groups,ou=northwind', role: 'knowledge curator', members: 2, clearance: 'internal' }],
    'platform-lab': [{ dn: 'cn=lab,ou=groups,ou=contoso', role: 'member', members: 9, clearance: 'public' }]
  };

  const MEMBERS = {
    'finance-ops': [
      { name: 'Mara Okafor', user: 'mokafor', roles: 'member, model admin, tool admin, flag reviewer, system admin', clearance: 'confidential', group: 'finops-analysts, ai-admins', state: 'active', seen: '09:02 today' },
      { name: 'Tomasz Wieczorek', user: 'twieczorek', roles: 'member, knowledge curator, guardrail admin', clearance: 'confidential', group: 'finops-leads', state: 'active', seen: '08:41 today' },
      { name: 'Priya Natarajan', user: 'pnatarajan', roles: 'member, flag reviewer', clearance: 'confidential', group: 'finops-analysts, ai-flag-review', state: 'active', seen: 'yesterday' },
      { name: 'Jonas Lindqvist', user: 'j.lindqvist', roles: 'member', clearance: 'confidential', group: 'finops-analysts (removed)', state: 'disabled by sync', seen: '18 Sep' },
      { name: 'Anneke de Vries', user: 'adevries', roles: 'member', clearance: 'confidential', group: 'finops-analysts', state: 'provisioned today', seen: '07:12 today' },
      { name: 'Samir Haddad', user: 'shaddad', roles: 'member', clearance: 'confidential', group: 'finops-analysts', state: 'provisioned today', seen: '07:40 today' }
    ]
  };

  const SERVICE = {
    'finance-ops': [
      { name: 'svc-close-bot', client: 'c_7f21ab90', scopes: 'inference:invoke:analyst', models: 'analyst', lifetime: '10 min', used: '11 min ago', state: 'active' },
      { name: 'svc-ledger-sync', client: 'c_0b8e14d2', scopes: 'context:write', models: 'none', lifetime: '10 min', used: '3 h ago', state: 'active' }
    ]
  };

  const SESSIONS = [
    { user: 'Mara Okafor', signed: '09:02 today', method: 'Kerberos, passkey', client: 'Console', ws: 'finance-ops' },
    { user: 'Tomasz Wieczorek', signed: '08:41 today', method: 'LDAP password, TOTP', client: 'Console', ws: 'finance-ops' },
    { user: 'svc-close-bot', signed: 'token, 11 min ago', method: 'client credentials', client: 'Service account', ws: 'finance-ops' },
    { user: 'Priya Natarajan', signed: 'yesterday 17:20', method: 'Kerberos', client: 'Console', ws: 'finance-ops' }
  ];

  const QUOTA = {
    'finance-ops': { tokens: ['3.1M of 5M', 62], gpu: ['16,380 of 18,000', 91], train: ['136 of 200', 68] },
    'people-ops': { tokens: ['410k of 2M', 21], gpu: ['2,140 of 6,000', 36], train: ['0 of 20', 0] },
    'field-sales': { tokens: ['1.9M of 2M', 95], gpu: ['4,980 of 6,000', 83], train: ['0 of 0', 0] },
    'platform-lab': { tokens: ['118k of 1M', 12], gpu: ['118 of 2,000', 6], train: ['12 of 40', 30] }
  };

  // effective permission evaluator (client scopes ∩ role, then ABAC)
  const SUBJECTS = {
    'Mara Okafor': { scopes: 'tools:invoke chat:* context:*', role: 'member', clearance: 'confidential' },
    'Tomasz Wieczorek': { scopes: 'tools:invoke chat:* guardrails:manage', role: 'guardrail admin', clearance: 'confidential' },
    'svc-close-bot': { scopes: 'inference:invoke:analyst', role: 'service account', clearance: 'internal' },
    'Jonas Lindqvist': { scopes: 'none, disabled', role: 'none', clearance: 'confidential' }
  };
  const ACTIONS = {
    'ledger.query': { scope: 'tools:invoke', label: 'confidential', zone: 'data' },
    'jira-internal.create_issue': { scope: 'tools:invoke', label: 'confidential', zone: 'sandbox' },
    'inference.invoke analyst': { scope: 'inference:invoke', label: 'internal', zone: 'inference' },
    'guardrails.manage': { scope: 'guardrails:manage', label: 'internal', zone: 'app' }
  };
  const ORDER = { public: 1, internal: 2, confidential: 3, restricted: 4 };

  App.register({
    id: 'tenants', title: 'Tenants', section: 'admin', summary: 'Tenants, workspaces, LDAP group mappings, service accounts, sessions, quotas',
    crumb(st) { const n = TREE.find((t) => t.id === (st.node || 'finance-ops')) || TREE[1]; return n.type === 'tenant' ? ['Admin', 'Tenants', n.name] : ['Admin', 'Tenants', (TREE.find((t) => t.id === n.tenant) || {}).name, n.name]; },
    commands: [
      { label: 'Add a group mapping', sub: 'Tenants', run(app) { app.stateFor('tenants').openMapping = true; app.render(); } },
      { label: 'Create a service account', sub: 'Tenants', run(app) { app.stateFor('tenants').openService = true; app.render(); } }
    ],
    states: [
      { title: 'Offboarding', tone: 'danger', text: 'Three explicit steps: export on request, destroy the tenant key, run the deletion job for derived data. Requires typing the tenant name.', apply(ctx) { ctx.state.node = 'contoso'; ctx.state.openOffboard = true; ctx.rerender(); } },
      { title: 'Disabled by sync', tone: 'warn', text: 'The user was removed from the directory. Sessions and refresh tokens were revoked within one sync interval.', apply(ctx) { ctx.state.node = 'finance-ops'; ctx.state.tab = 'members'; ctx.state.member = 'j.lindqvist'; ctx.rerender(); } },
      { title: 'Thirteen roles', tone: 'neutral', text: 'Role picker lists all built-in roles with a one-line description of what each can change.', apply(ctx) { ctx.state.node = 'finance-ops'; ctx.state.tab = 'mappings'; ctx.state.openMapping = true; ctx.rerender(); } },
      { title: 'Quota reached', tone: 'warn', text: 'Requests return 429 with a reset time. The console shows who can raise the limit.', apply(ctx) { ctx.state.node = 'field-sales'; ctx.state.tab = 'quotas'; ctx.state.quotaHit = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.node = st.node || 'finance-ops'; st.tab = st.tab || 'mappings'; st.subject = st.subject || 'Mara Okafor'; st.action = st.action || 'ledger.query';
      st.added = st.added || {}; st.services = st.services || {}; st.revoked = st.revoked || {}; st.offboarded = st.offboarded || {}; st.q = st.q || '';
      if (ctx.params.workspace) st.node = ctx.params.workspace;
      if (ctx.params.tab) st.tab = ctx.params.tab;
      const node = TREE.find((t) => t.id === st.node) || TREE[1];
      const tenant = node.type === 'tenant' ? node : TREE.find((t) => t.id === node.tenant);

      // ----- left pane -----
      const left = '<div class="leftpane"><div class="eyebrow" style="padding:4px 8px">Tenants and workspaces</div>'
        + TREE.map((t) => UI.listItem(esc(t.name) + (st.offboarded[t.id] ? ' ' + UI.pill('offboarding', 'danger') : ''), esc(t.sub), { active: t.id === node.id, attrs: 'data-node="' + t.id + '"' + (t.type === 'workspace' ? ' style="padding-left:22px"' : '')})).join('')
        + '<div class="divider"></div>' + UI.btn('New workspace', { size: 'sm', icon: 'plus', cls: 'block', attrs: 'data-newws' }) + '</div>';

      let head, body;
      if (node.type === 'tenant') {
        const wss = TREE.filter((t) => t.tenant === node.id);
        head = UI.pagehead(node.name, esc(node.sub) + '. Postgres RLS scopes every table to this tenant; conversation content is envelope-encrypted with its own key.', UI.btn('Offboard tenant', { kind: 'danger', attrs: 'data-offboard' }) + UI.btn('New workspace', { kind: 'primary', icon: 'plus', attrs: 'data-newws' }));
        body = (st.offboarded[node.id] ? UI.notice('<b>Offboarding in progress.</b> Export delivered, tenant key destroyed at ' + esc(st.offboarded[node.id]) + '; the deletion job for derived data is queued. Sign-ins for this tenant are refused.', 'danger') : '')
          + '<div class="grid2">' + UI.panel('Tenant', UI.kv([['Directory base', '<span class="mono">' + esc(node.dn) + '</span>'], ['Data key', esc(node.key)], ['Policy', esc(node.policy)], ['Sync', 'hourly, last 06:00'], ['Members', wss.reduce((a, w) => a + w.members, 0)], ['Workspaces', wss.length]], 2), { actions: UI.btn('Open identity', { size: 'sm', kind: 'ghost', attrs: 'data-go="identity"' }) })
          + UI.panel('Quota, tenant total', UI.meter('Tokens today', node.id === 'northwind' ? '5.4M of 9M' : '118k of 1M', node.id === 'northwind' ? 60 : 12) + UI.meter('GPU-seconds, month', node.id === 'northwind' ? '23,500 of 30,000' : '118 of 2,000', node.id === 'northwind' ? 78 : 6, node.id === 'northwind' ? 'warn' : '') + '<div class="muted" style="font-size:12px">Workspace limits nest under the tenant limit. Raised by a system admin.</div>') + '</div>'
          + '<div class="eyebrow">Workspaces</div>' + UI.table(['Workspace', 'Members', 'Label ceiling', 'Mappings', 'Tokens today'], wss.map((w) => ({ cells: ['<b>' + esc(w.name) + '</b>', w.members, UI.label(w.label, { sm: true }), (MAPPINGS[w.id] || []).length + (st.added[w.id] || []).length, QUOTA[w.id].tokens[0]], attrs: 'data-node="' + w.id + '"' })), { minWidth: '520px' });
      } else {
        const maps = (MAPPINGS[node.id] || []).concat(st.added[node.id] || []);
        const members = (MEMBERS[node.id] || []).filter((m) => !st.q || (m.name + ' ' + m.user + ' ' + m.roles).toLowerCase().includes(st.q.toLowerCase()));
        const services = (SERVICE[node.id] || []).concat(st.services[node.id] || []);
        const sessions = SESSIONS.filter((s) => s.ws === node.id && !st.revoked[s.user]);
        const q = QUOTA[node.id];
        head = UI.pagehead(node.name, 'Directory sync ran at 06:00: 1 user disabled, 2 provisioned just in time', UI.btn('Create service account', { attrs: 'data-newservice' }) + UI.btn('Add mapping', { kind: 'primary', attrs: 'data-newmapping' }));
        const tabs = UI.tabs([{ id: 'members', label: 'Members', count: (MEMBERS[node.id] || []).length || node.members }, { id: 'mappings', label: 'Group mappings', count: maps.length }, { id: 'services', label: 'Service accounts', count: services.length }, { id: 'sessions', label: 'Sessions', count: sessions.length }, { id: 'quotas', label: 'Quotas' }], st.tab);

        const effective = (() => {
          const s = SUBJECTS[st.subject], a = ACTIONS[st.action];
          const scopeOk = s.scopes.split(' ').some((x) => x === a.scope || x === a.scope.split(':')[0] + ':*' || x.indexOf(a.scope) === 0);
          const roleOk = s.role !== 'none';
          const clrOk = ORDER[s.clearance] >= ORDER[a.label];
          const zoneOk = true;
          const allowed = scopeOk && roleOk && clrOk && zoneOk;
          const p = (t, ok) => UI.pill(t, ok ? 'ok' : 'danger');
          return '<div class="hstack wrap gap6" style="font-size:12px">' + p('client scopes: ' + a.scope, scopeOk) + '<span class="muted">and</span>' + p('role: ' + s.role, roleOk) + '<span class="muted">then</span>' + p('clearance ' + s.clearance + ', data ' + a.label, clrOk) + '<span class="muted">and</span>' + p('zone ' + a.zone + ' allowed', zoneOk) + '<span class="muted">=</span><b style="color:var(--' + (allowed ? 'ok' : 'danger') + '-fg)">' + (allowed ? 'allowed' : 'denied') + '</b></div>'
            + (!allowed ? '<div class="fg2" style="font-size:12px">Denied at the first failing step. The request gets 403 with a problem detail naming the step, and the decision lands in the audit chain.</div>' : '<div class="fg2" style="font-size:12px">Effective permission is client scopes intersected with role permissions, then an ABAC check on clearance and zone. Cedar policy northwind v31.</div>');
        })();
        const effPanel = UI.panel(null, '<div class="hstack wrap"><span class="eyebrow">Effective permission</span>' + UI.select(Object.keys(SUBJECTS), st.subject, 'data-subject style="width:180px"') + UI.select(Object.keys(ACTIONS), st.action, 'data-action style="width:220px"') + '</div>' + effective);

        if (st.tab === 'members') {
          body = tabs + '<div class="hstack wrap">' + UI.search('Search members', 'data-q', st.q) + '<span class="muted" style="font-size:12px">Provisioned just in time on first sign-in from a mapped group.</span></div>'
            + (st.member === 'j.lindqvist' ? UI.notice('<b>Disabled by sync.</b> j.lindqvist was removed from cn=finops-analysts. The 06:00 sync disabled the account and revoked 2 sessions and 1 refresh token; access ended within one sync interval.', 'warn', UI.btn('Open audit event', { size: 'sm', attrs: 'data-audit="7a201f3d"' })) : '')
            + UI.table(['Name', 'Username', 'Roles', 'Clearance', 'Mapped from', 'State', 'Last seen'], members.map((m) => ({ cells: ['<b>' + esc(m.name) + '</b>', '<span class="mono">' + esc(m.user) + '</span>', esc(m.roles), UI.label(m.clearance, { sm: true }), esc(m.group), UI.pill(m.state, m.state === 'active' ? 'ok' : m.state === 'disabled by sync' ? 'warn' : 'info'), esc(m.seen)], attrs: 'data-member="' + m.user + '"', selected: st.member === m.user })), { minWidth: '760px', emptyTitle: 'No members match', emptyText: 'Members appear here after their first sign-in from a mapped group.' })
            + effPanel;
        } else if (st.tab === 'mappings') {
          body = tabs + UI.table(['LDAP group DN', 'Role', { label: 'Members', right: true }, 'Clearance', ''], maps.map((m, i) => ({ cells: ['<span class="mono">' + esc(m.dn) + '</span>', esc(m.role), m.members, UI.label(m.clearance, { sm: true }), UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-editmap="' + i + '"' })], attrs: 'data-map="' + i + '"', selected: st.map === i })), { minWidth: '640px' })
            + '<div class="muted" style="font-size:12px">A member of several groups gets the union of roles and the highest clearance. Removing a user from every mapped group disables them at the next sync.</div>'
            + effPanel
            + '<div class="eyebrow">Active sessions</div>' + sessionsTable(sessions)
            + '<div class="grid3">' + UI.stat(q.tokens[0].split(' of ')[0], 'Tokens today', 'of ' + q.tokens[0].split(' of ')[1]) + UI.stat(q.gpu[0].split(' of ')[0], 'GPU-seconds, month', 'of ' + q.gpu[0].split(' of ')[1]) + UI.stat(q.train[0].split(' of ')[0], 'Training GPU-hours', 'of ' + q.train[0].split(' of ')[1]) + '</div>';
        } else if (st.tab === 'services') {
          body = tabs + UI.table(['Service account', 'Client ID', 'Scopes', 'Allowed models', 'Token lifetime', 'Last used', 'State', ''], services.map((s) => [ '<b>' + esc(s.name) + '</b>', '<span class="mono">' + esc(s.client) + '</span>', '<span class="mono">' + esc(s.scopes) + '</span>', esc(s.models), esc(s.lifetime), esc(s.used), UI.pill(s.state), UI.btn('Open in Identity', { size: 'xs', kind: 'ghost', attrs: 'data-goclient="' + esc(s.name) + '"' }) ]), { clickable: false, minWidth: '760px', emptyTitle: 'No service accounts', emptyText: 'Create one for CI, integrations or scheduled jobs. It gets a client credentials grant.' })
            + UI.notice('Service accounts authenticate with client credentials. The secret is shown once at creation and can only be rotated afterwards.', 'info');
        } else if (st.tab === 'sessions') {
          body = tabs + '<div class="eyebrow">Active sessions</div>' + sessionsTable(sessions) + '<div class="muted" style="font-size:12px">Revoking a session also revokes its refresh tokens. The user is signed out on their next request.</div>';
        } else {
          body = tabs + (st.quotaHit && node.id === 'field-sales' ? UI.notice('<b>Quota reached at 15:12.</b> Field Sales used 2M of 2M tokens today. Requests return 429 with Retry-After until 08:00 tomorrow. A tenant admin (cn=ai-admins) can raise the limit.', 'warn', UI.btn('Raise limit', { size: 'sm', attrs: 'data-raise' })) : '')
            + '<div class="grid2">' + UI.panel('Workspace limits', UI.meter('Tokens today', q.tokens[0], q.tokens[1], q.tokens[1] >= 90 ? 'danger' : q.tokens[1] >= 60 ? 'warn' : '') + UI.meter('GPU-seconds, month', q.gpu[0], q.gpu[1], q.gpu[1] >= 90 ? 'warn' : '') + UI.meter('Training GPU-hours', q.train[0], q.train[1]) + '<div class="muted" style="font-size:12px">Raised by: tenant admin. Nested under the ' + esc(tenant.name) + ' tenant limit.</div>', { actions: UI.btn('Edit limits', { size: 'sm', kind: 'ghost', attrs: 'data-raise' }) })
            + UI.panel('Over quota', '<div class="fg2">Interactive requests return <span class="mono">429</span> with <span class="mono">Retry-After</span> and a problem detail that names the limit. Batch jobs wait in RabbitMQ until the window resets.</div>' + UI.kv([['Reset', 'daily 08:00, monthly on the 1st'], ['Who can raise', 'tenant admin, system admin'], ['Metering', 'per tenant, user, model and agent']], 1) + '<div>' + UI.btn('Open usage', { size: 'sm', attrs: 'data-go="usage-audit"' }) + '</div>') + '</div>';
        }
      }

      function sessionsTable(sessions) {
        return UI.table(['User', 'Signed in', 'Method', 'Client', ''], sessions.map((s) => [ '<b>' + esc(s.user) + '</b>', esc(s.signed), esc(s.method), esc(s.client), UI.btn('Revoke', { size: 'xs', attrs: 'data-revoke="' + esc(s.user) + '"' }) ]), { clickable: false, minWidth: '560px', emptyTitle: 'No active sessions', emptyText: 'Sessions appear when a member signs in or a service account requests a token.' });
      }

      root.innerHTML = left + '<div class="page">' + head + body
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      // ----- modals -----
      function mappingModal(existing) {
        ctx.modal({
          title: existing ? 'Edit mapping' : 'Add mapping', cls: 'wide',
          body: '<div class="formgrid">' + UI.field('LDAP group DN', UI.input(existing ? existing.dn : 'cn=finops-reviewers,ou=groups,ou=northwind', { attrs: 'data-mdn' }), 'Resolved against ou=northwind,dc=corp at the next sync.') + UI.field('Clearance ceiling', UI.select(['public', 'internal', 'confidential', 'restricted'], existing ? existing.clearance : 'confidential', 'data-mclr'), 'Members can read data up to this label.') + '</div>'
            + '<div class="field"><span class="fl">Role, thirteen built in</span><div class="tn-roles">' + ROLES.map((r) => '<label class="tn-role"><input type="radio" name="role" value="' + r[0] + '"' + ((existing ? existing.role : 'member') === r[0] ? ' checked' : '') + '><span><b>' + esc(r[0]) + '</b><span class="muted"> ' + esc(r[1]) + '</span></span></label>').join('') + '</div></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(existing ? 'Save mapping' : 'Add mapping', { kind: 'primary', attrs: 'data-msave' }),
          onMount(m) {
            m.querySelector('[data-msave]').addEventListener('click', () => {
              const dn = m.querySelector('[data-mdn]').value.trim(), role = m.querySelector('input[name=role]:checked').value, clr = m.querySelector('[data-mclr]').value;
              App.closeOverlay();
              if (existing) { existing.role = role; existing.clearance = clr; existing.dn = dn; ctx.toast('Mapping updated. Applies at the next sync.', 'ok'); }
              else { (st.added[node.id] = st.added[node.id] || []).push({ dn: dn, role: role, members: 0, clearance: clr }); st.tab = 'mappings'; ctx.toast('Mapping added: ' + esc(role) + '. Members are provisioned at their next sign-in.', 'ok'); }
              ctx.rerender();
            });
          }
        });
      }
      function serviceModal() {
        ctx.modal({
          title: 'Create service account',
          body: '<div class="formgrid">' + UI.field('Name', UI.input('svc-', { attrs: 'data-sname placeholder="svc-name"' })) + UI.field('Token lifetime', UI.select(['10 min', '1 h'], '10 min')) + UI.field('Scopes', UI.input('inference:invoke:analyst', { attrs: 'data-sscopes' }), 'resource:action, with an optional model qualifier.') + UI.field('Allowed models', UI.select(['analyst', 'chat-default', 'fast', 'coder'], 'analyst', 'data-smodel')) + '</div>' + UI.notice('The client secret is shown once after creation, in Identity. It can only be rotated afterwards.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-screate' }),
          onMount(m) { m.querySelector('[data-screate]').addEventListener('click', () => { const name = m.querySelector('[data-sname]').value.trim() || 'svc-new'; App.closeOverlay(); (st.services[node.id] = st.services[node.id] || []).push({ name: name, client: 'c_' + Math.random().toString(16).slice(2, 10), scopes: m.querySelector('[data-sscopes]').value, models: m.querySelector('[data-smodel]').value, lifetime: '10 min', used: 'never', state: 'active' }); st.tab = 'services'; ctx.rerender(); ctx.toast('Service account ' + esc(name) + ' created. Copy its secret in Identity.', 'ok', 5000); }); }
        });
      }
      function offboardModal() {
        const t = tenant;
        ctx.modal({
          title: 'Offboard ' + esc(t.name) + ' ' + UI.pill('destructive', 'danger'),
          body: UI.timeline([{ title: '1. Export on request', text: 'Conversations, knowledge and audit rows delivered to the tenant contact as a signed archive.', tone: 'ok', meta: 'requested 12 Sep, delivered 15 Sep' }, { title: '2. Destroy the tenant key', text: 'Deleting ' + esc(t.key.split(',')[0]) + ' in OpenBao crypto-shreds every conversation body.', tone: 'danger' }, { title: '3. Run the deletion job for derived data', text: 'Embeddings, caches, memories and search indexes are removed by a worker job; progress is visible in Runs.', tone: '' }])
            + UI.field('Type the tenant name to continue', UI.input('', { attrs: 'data-obname placeholder="' + esc(t.name) + '"' })),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Destroy key and start deletion', { kind: 'danger', attrs: 'data-obgo disabled' }),
          onMount(m) { const i = m.querySelector('[data-obname]'), b = m.querySelector('[data-obgo]'); i.addEventListener('input', () => { if (i.value.trim() === t.name) b.removeAttribute('disabled'); else b.setAttribute('disabled', ''); }); b.addEventListener('click', () => { App.closeOverlay(); st.offboarded[t.id] = '14:2' + Math.floor(Math.random() * 9); st.node = t.id; ctx.rerender(); ctx.toast('<b>' + esc(t.name) + '</b> key destroyed. Deletion job queued; audit event written.', 'danger', 6000); }); i.focus(); }
        });
      }
      if (st.openMapping) { st.openMapping = false; setTimeout(() => mappingModal(), 50); }
      if (st.openService) { st.openService = false; setTimeout(() => serviceModal(), 50); }
      if (st.openOffboard) { st.openOffboard = false; setTimeout(() => offboardModal(), 50); }

      // ----- handlers -----
      ctx.on('click', '[data-node]', (e, t) => { st.node = t.dataset.node; st.member = null; st.map = null; ctx.rerender(); });
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-q]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', 'tr[data-member]', (e, t) => { st.member = st.member === t.dataset.member ? null : t.dataset.member; ctx.rerender(); });
      ctx.on('click', 'tr[data-map]', (e, t) => { if (e.target.closest('[data-editmap]')) return; st.map = +t.dataset.map; ctx.rerender(); });
      ctx.on('click', '[data-editmap]', (e, t) => { e.stopPropagation(); const maps = (MAPPINGS[node.id] || []).concat(st.added[node.id] || []); mappingModal(maps[+t.dataset.editmap]); });
      ctx.on('change', '[data-subject]', (e, t) => { st.subject = t.value; ctx.rerender(); });
      ctx.on('change', '[data-action]', (e, t) => { st.action = t.value; ctx.rerender(); });
      ctx.on('click', '[data-newmapping]', () => mappingModal());
      ctx.on('click', '[data-newservice]', () => serviceModal());
      ctx.on('click', '[data-offboard]', () => offboardModal());
      ctx.on('click', '[data-newws]', () => ctx.modal({ title: 'New workspace', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'Treasury' })) + UI.field('Tenant', UI.select(['Northwind', 'Contoso Freight'], tenant.name)) + UI.field('Label ceiling', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal')) + UI.field('First group mapping', UI.input('cn=treasury,ou=groups,ou=northwind')) + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create workspace', { kind: 'primary', attrs: 'data-wsgo' }), onMount(m) { m.querySelector('[data-wsgo]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Workspace created. Members are provisioned at their first sign-in.', 'ok'); }); } }));
      ctx.on('click', '[data-revoke]', (e, t) => {
        const u = t.dataset.revoke;
        ctx.confirm({ title: 'Revoke session', tag: 'signs out', tone: 'danger', body: '<p style="margin:0" class="fg2">Ends the session and its refresh tokens now. ' + esc(u) + ' is signed out on the next request and must sign in again.</p>', kv: [['User', esc(u)], ['Workspace', esc(node.name)]], ok: 'Revoke' }).then((ok) => { if (!ok) return; st.revoked[u] = true; ctx.rerender(); ctx.toast('Session for ' + esc(u) + ' revoked. Audit event written.', 'ok'); });
      });
      ctx.on('click', '[data-raise]', () => ctx.modal({ title: 'Raise limits, ' + esc(node.name), body: '<div class="formgrid">' + UI.field('Tokens per day', UI.input(node.id === 'field-sales' ? '2,000,000' : '5,000,000', { attrs: 'data-rt' })) + UI.field('GPU-seconds per month', UI.input(node.id === 'field-sales' ? '6,000' : '18,000')) + '</div>' + UI.notice('You hold tenant admin through cn=ai-admins. The change is written to the audit chain.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-rgo' }), onMount(m) { m.querySelector('[data-rgo]').addEventListener('click', () => { App.closeOverlay(); st.quotaHit = false; ctx.rerender(); ctx.toast('Limits raised for ' + esc(node.name) + '. Requests are admitted again.', 'ok'); }); } }));
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('click', '[data-goclient]', (e, t) => ctx.navigate('identity', { client: t.dataset.goclient }));
      ctx.on('click', '[data-audit]', (e, t) => ctx.navigate('usage-audit', { event: t.dataset.audit }));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));

      const style = document.createElement('style');
      style.textContent = '.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}.tn-roles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;max-height:260px;overflow:auto;padding:4px 0}.tn-role{display:flex;gap:8px;align-items:flex-start;padding:4px 6px;border-radius:4px;cursor:pointer;font-size:12px}.tn-role:hover{background:var(--sel)}.tn-role input{margin:3px 0 0;accent-color:var(--accent)}';
      root.prepend(style);
    }
  });
})();
