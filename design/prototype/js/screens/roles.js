(function () {
  const { UI, esc } = App;

  // ---- the permission catalogue (server/src/authz/permissions.ts) grouped by area; roles:manage is new in 1.5.0 (B-33) ----
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
  const PERMS = AREAS.reduce((a, g) => a.concat(g[1]), []);
  const areaOf = (p) => (AREAS.find((g) => g[1].includes(p)) || [''])[0];
  const ADMIN_PERMS = PERMS.filter((p) => /:(manage|admin|review|sanction|design|submit)$/.test(p) || p === 'audit:read' || p === 'usage:read');
  const MEMBER = ['chat:read', 'chat:write', 'inference:invoke', 'context:read', 'context:write', 'images:generate', 'tools:invoke', 'agents:run', 'memory:write', 'knowledge:read', 'models:read', 'secrets:read', 'atproto:link', 'files:read', 'files:write', 'moderation:report', 'moderation:appeal', 'records:read', 'records:write', 'groups:read', 'groups:write', 'social:read', 'social:write', 'messages:read', 'messages:write', 'feed:read', 'feed:write'];
  const ADMINS = ['system-admin', 'tenant-admin'];
  const ROLES = [
    { id: 'system-admin', name: 'System admin', desc: 'Everything, across tenants: zones, platform, baseline guardrails.', perms: '*', mfa: true, grantableBy: ['system-admin'], holders: 2 },
    { id: 'tenant-admin', name: 'Tenant admin', desc: 'Workspaces, members, quotas and roles inside one tenant.', perms: ['tenant:manage', 'users:manage', 'identity:manage', 'usage:read', 'audit:read', 'models:read', 'webhooks:manage', 'prompts:manage', 'billing:read', 'secrets:read', 'secrets:write', 'secrets:admin', 'pki:manage', 'plugins:manage', 'labels:manage', 'files:read', 'files:write', 'moderation:sanction', 'moderation:manage', 'members:invite', 'apps:design', 'records:read', 'records:write', 'firehose:manage', 'groups:read', 'groups:write', 'groups:manage', 'channels:manage', 'channels:review', 'social:read', 'social:write', 'social:manage', 'messages:read', 'messages:write', 'feed:read', 'feed:write', 'feed:manage', 'roles:manage'], mfa: true, grantableBy: ['system-admin'], holders: 3 },
    { id: 'identity-admin', name: 'Identity admin', desc: 'User stores, group mappings, clients, sessions and signing keys.', perms: ['identity:manage', 'users:manage', 'pki:manage', 'members:invite'], mfa: true, grantableBy: ADMINS, holders: 2 },
    { id: 'model-admin', name: 'Model admin', desc: 'Model catalogue, approvals, profiles and pool placement.', perms: ['models:read', 'models:manage', 'pools:manage', 'profiles:manage'], mfa: true, grantableBy: ADMINS, holders: 4 },
    { id: 'guardrail-admin', name: 'Guardrail admin', desc: 'Guardrail rule sets, classifiers and promotion to enforce.', perms: ['guardrails:manage', 'classifiers:manage', 'flags:review', 'labels:manage', 'moderation:check', 'moderation:review', 'moderation:sanction', 'moderation:manage', 'firehose:manage', 'channels:review'], mfa: true, grantableBy: ADMINS, holders: 2 },
    { id: 'tool-admin', name: 'Tool admin', desc: 'Registry review, MCP servers and tool approvals.', perms: ['tools:manage', 'agents:manage', 'mcp:manage'], mfa: true, grantableBy: ADMINS, holders: 3 },
    { id: 'knowledge-curator', name: 'Knowledge curator', desc: 'Knowledge bases, sources, relabelling and workspace memory.', perms: ['knowledge:read', 'knowledge:manage', 'prompts:manage'], mfa: false, grantableBy: ADMINS, holders: 5 },
    { id: 'ml-admin', name: 'ML admin', desc: 'Training jobs, datasets and approvals for confidential data.', perms: ['training:submit', 'training:manage', 'models:read'], mfa: true, grantableBy: ADMINS, holders: 1 },
    { id: 'workflow-admin', name: 'Workflow admin', desc: 'Publishes workflows and scripts as tools, and designs low-code apps.', perms: ['workflows:manage', 'scripts:run', 'apps:design', 'records:read', 'records:write'], mfa: true, grantableBy: ADMINS, holders: 3 },
    { id: 'connection-admin', name: 'Connection admin', desc: 'Data connections, credentials and schema allow-lists.', perms: ['connections:manage', 'secrets:read', 'secrets:write'], mfa: true, grantableBy: ADMINS, holders: 2 },
    { id: 'flag-reviewer', name: 'Flag reviewer', desc: 'Works the review queue within their clearance.', perms: ['flags:review', 'moderation:review', 'channels:review'], mfa: false, grantableBy: ADMINS, holders: 6 },
    { id: 'member', name: 'Member', desc: 'Chat, knowledge and tools within their clearance.', perms: MEMBER, mfa: false, grantableBy: ADMINS.concat(['identity-admin']), holders: 184 },
    { id: 'auditor', name: 'Auditor', desc: 'Reads the audit chain and usage. Nothing else.', perms: ['audit:read', 'usage:read'], mfa: true, grantableBy: ADMINS, holders: 2 }
  ];
  const has = (r, p) => r.perms === '*' || r.perms.includes(p);
  const ROUTES = {
    'pki:manage': ['GET /api/pki', 'GET /api/pki/issuers', 'POST /api/pki/issuers', 'POST /api/pki/issuers/:id/rotate', 'POST /api/pki/issuers/:id/issue', 'POST /api/pki/certificates/:id/revoke', 'GET /api/pki/profiles', 'PUT /api/pki/acme', 'GET /api/pki/acme/accounts', 'GET /api/atproto/identity', 'POST /api/atproto/identity/rotate'],
    'secrets:admin': ['POST /api/vault/kv/destroy/*path', 'DELETE /api/vault/kv/metadata/*path', 'POST /api/vault/transit/keys', 'POST /api/vault/transit/keys/:name/rotate', 'GET /api/vault/policies', 'POST /api/vault/policies', 'DELETE /api/vault/policies/:id'],
    'secrets:read': ['GET /api/vault/kv?prefix=', 'GET /api/vault/kv/data/*path', 'POST /api/vault/transit/encrypt/:name', 'POST /api/vault/policies/explain', 'POST /api/vault/database/creds/:engine/:role'],
    'plugins:manage': ['GET /api/admin/plugins', 'POST /api/admin/plugins', 'POST /api/admin/plugins/:id/enable', 'PUT /api/admin/plugins/:id/grants', 'GET /api/events/catalogue'],
    'roles:manage': ['GET /api/authz/matrix', 'GET /api/authz/roles', 'POST /api/authz/roles', 'POST /api/authz/roles/:id/versions', 'GET /api/authz/effective', 'POST /api/authz/explain', 'GET /api/authz/reviews', 'POST /api/authz/reviews/:id/decide'],
    'moderation:review': ['POST /api/moderation/flags/:ref/action', 'GET /api/moderation/actions', 'GET /api/moderation/appeals', 'POST /api/moderation/appeals/:ref/decide', 'GET /api/moderation/queues/:id/flags'],
    'files:write': ['POST /api/files/folders', 'PUT /api/files/uploads', 'PUT /api/files/:id/content', 'POST /api/files/:id/shares', 'DELETE /api/files/:id'],
    'apps:design': ['POST /api/apps', 'POST /api/apps/:app/entities', 'POST /api/apps/:app/forms', 'POST /api/apps/:app/triggers', 'GET /api/apps/:app/export'],
    'flags:review': ['GET /api/flags', 'POST /api/flags/:ref/decide', 'POST /api/flags/:ref/reassign'],
    'channels:review': ['GET /api/channels/:id/sessions', 'GET /api/channels/held', 'POST /api/channels/held/:messageId/decide', 'POST /api/channels/:id/exports']
  };
  const routesFor = (p) => ROUTES[p] || [p.split(':')[1] === 'read' ? 'GET /api/' + p.split(':')[0] : 'GET /api/' + p.split(':')[0], (p.endsWith(':manage') || p.endsWith(':write') ? 'POST /api/' + p.split(':')[0] : 'POST /api/' + p.split(':')[0] + '/…')];

  // ---- people in the tenant for the effective-access matrix ----
  const USERS = [
    { id: 'me', name: 'Mara Okafor', user: 'mokafor', roles: ['member', 'model-admin', 'tool-admin', 'flag-reviewer', 'system-admin'], clearance: 'confidential', ws: ['Finance Ops', 'People Ops', 'Field Sales'] },
    { id: 'u-priya', name: 'Priya Nair', user: 'pnair', roles: ['member', 'flag-reviewer'], clearance: 'restricted', ws: ['Finance Ops'] },
    { id: 'u-tomasz', name: 'Tomasz Weber', user: 'tweber', roles: ['member'], clearance: 'internal', ws: ['Finance Ops'] },
    { id: 'u-jonas', name: 'Jonas Lindqvist', user: 'jlindqvist', roles: ['member', 'tenant-admin'], clearance: 'confidential', ws: ['Finance Ops', 'People Ops'] },
    { id: 'u-aisha', name: 'Aisha Bello', user: 'abello', roles: ['member', 'identity-admin'], clearance: 'confidential', ws: ['People Ops'] },
    { id: 'u-felix', name: 'Felix Brandt', user: 'fbrandt', roles: ['member', 'workflow-admin'], clearance: 'confidential', ws: ['Finance Ops'] },
    { id: 'u-lena', name: 'Lena Hoffmann', user: 'lhoffmann', roles: ['member', 'knowledge-curator'], clearance: 'confidential', ws: ['Finance Ops', 'Field Sales'] },
    { id: 'u-samir', name: 'Samir Haddad', user: 'shaddad', roles: ['member'], clearance: 'internal', ws: ['Field Sales'] },
    { id: 'u-noor', name: 'Noor Rahimi', user: 'nrahimi', roles: ['member', 'auditor'], clearance: 'internal', ws: ['People Ops', 'Finance Ops'] },
    { id: 'svc-close', name: 'svc-close-bot (API key)', user: 'svc-close-bot', roles: ['member'], scopes: ['chat:write', 'context:read', 'records:read'], clearance: 'internal', ws: ['Finance Ops'] }
  ];
  const LEVEL = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  const WS = { 'Finance Ops': { zone: 'office', ceiling: 'confidential', label: 'confidential', admin: 'Jonas Lindqvist' }, 'People Ops': { zone: 'office', ceiling: 'internal', label: 'internal', admin: 'Aisha Bello' }, 'Field Sales': { zone: 'vpn', ceiling: 'internal', label: 'internal', admin: 'Lena Hoffmann' } };

  const baseCustom = () => [
    { id: 'close-reviewer', name: 'Close reviewer', desc: 'Reviews flags, moderation cases and held channel replies during the close, and reads app records.', perms: ['flags:review', 'moderation:review', 'channels:review', 'records:read'], mfa: true, grantableBy: 'tenant-admin', holders: ['Priya Nair', 'Felix Brandt'], version: 2, state: 'active', versions: [{ v: 1, at: '2 Sep 10:12', by: 'Jonas Lindqvist', perms: ['flags:review', 'moderation:review'] }, { v: 2, at: '15 Sep 09:40', by: 'Jonas Lindqvist', perms: ['flags:review', 'moderation:review', 'channels:review', 'records:read'] }] },
    { id: 'vault-operator', name: 'Vault operator', desc: 'Writes and destroys secrets under the finance paths; manages transit keys.', perms: ['secrets:read', 'secrets:write', 'secrets:admin'], mfa: true, grantableBy: 'tenant-admin', holders: [], version: 1, state: 'pending', proposedBy: 'Jonas Lindqvist', proposedAt: '18 Sep 16:20', versions: [{ v: 1, at: '18 Sep 16:20', by: 'Jonas Lindqvist', perms: ['secrets:read', 'secrets:write', 'secrets:admin'] }] },
    { id: 'feed-moderator', name: 'Feed moderator', desc: 'Removes posts and comments in the workspaces they may act in.', perms: ['feed:read', 'feed:manage', 'moderation:review'], mfa: true, grantableBy: 'tenant-admin', holders: [], version: 1, state: 'draft', versions: [{ v: 1, at: 'today 09:05', by: 'Mara Okafor', perms: ['feed:read', 'feed:manage', 'moderation:review'] }] },
    { id: 'legacy-exporter', name: 'Legacy exporter', desc: 'Retired 1 Sep: usage exports moved to the auditor role.', perms: ['usage:read'], mfa: false, grantableBy: 'tenant-admin', holders: [], version: 3, state: 'retired', versions: [{ v: 3, at: '1 Sep 08:00', by: 'Jonas Lindqvist', perms: ['usage:read'] }] }
  ];
  const baseReviews = () => [
    { id: 'rv-q3-fin', name: 'Q3 certification, Finance Ops', scope: 'workspace', ws: 'Finance Ops', reviewer: 'Jonas Lindqvist (workspace admin)', due: '30 Sep 2026', state: 'open', cadence: 'quarterly', grants: [
      { id: 'g1', member: 'Priya Nair', what: 'role flag-reviewer', ws: 'Finance Ops', lastUsed: 'today 14:02', decision: 'pending' },
      { id: 'g2', member: 'Priya Nair', what: 'custom role Close reviewer v2', ws: 'Finance Ops', lastUsed: 'today 11:02', decision: 'pending' },
      { id: 'g3', member: 'Tomasz Weber', what: 'role member', ws: 'Finance Ops', lastUsed: 'today 11:40', decision: 'confirm', by: 'Jonas Lindqvist', at: '17 Sep 10:02' },
      { id: 'g4', member: 'Felix Brandt', what: 'role workflow-admin', ws: 'Finance Ops', lastUsed: '18 Sep 15:11', decision: 'confirm', by: 'Jonas Lindqvist', at: '17 Sep 10:03' },
      { id: 'g5', member: 'Noor Rahimi', what: 'role auditor', ws: 'Finance Ops', lastUsed: '40 d ago', decision: 'pending' },
      { id: 'g6', member: 'svc-close-bot (API key)', what: 'scopes chat:write context:read records:read', ws: 'Finance Ops', lastUsed: 'today 06:00', decision: 'pending' },
      { id: 'g7', member: 'Lena Hoffmann', what: 'role knowledge-curator', ws: 'Finance Ops', lastUsed: '12 Sep 16:40', decision: 'confirm', by: 'Jonas Lindqvist', at: '17 Sep 10:05' },
      { id: 'g8', member: 'Samir Haddad', what: 'workspace membership', ws: 'Finance Ops', lastUsed: 'never', decision: 'pending' }
    ] },
    { id: 'rv-po', name: 'Annual certification, People Ops', scope: 'workspace', ws: 'People Ops', reviewer: 'Aisha Bello (workspace admin)', due: '15 Sep 2026', state: 'overdue', escalatedTo: 'tenant admins (Jonas Lindqvist), 16 Sep 00:05', cadence: 'yearly', grants: [
      { id: 'h1', member: 'Noor Rahimi', what: 'role member', ws: 'People Ops', lastUsed: 'today 08:10', decision: 'pending' }, { id: 'h2', member: 'Aisha Bello', what: 'role identity-admin', ws: 'People Ops', lastUsed: 'today 09:00', decision: 'pending' }, { id: 'h3', member: 'Jonas Lindqvist', what: 'role member', ws: 'People Ops', lastUsed: '11 Sep', decision: 'confirm', by: 'Aisha Bello', at: '12 Sep 11:00' }] },
    { id: 'rv-fs', name: 'Q4 certification, Field Sales', scope: 'workspace', ws: 'Field Sales', reviewer: 'Lena Hoffmann (workspace admin)', due: '1 Nov 2026', state: 'scheduled', cadence: 'quarterly', grants: [] },
    { id: 'rv-admins', name: 'Tenant admin roles', scope: 'tenant', ws: null, reviewer: 'System admins', due: '30 Jun 2026', state: 'closed', cadence: 'half-yearly', grants: [{ id: 'k1', member: 'Jonas Lindqvist', what: 'role tenant-admin', ws: 'Northwind', lastUsed: '29 Jun', decision: 'confirm', by: 'Mara Okafor', at: '29 Jun 15:00' }, { id: 'k2', member: 'Former contractor', what: 'role tenant-admin', ws: 'Northwind', lastUsed: '90 d', decision: 'revoke', by: 'Mara Okafor', at: '29 Jun 15:02' }] }
  ];

  // policy.explain in order: role → scopes → tenant → clearance → zone ceiling
  function explain(u, perm, ws, label) {
    const w = WS[ws]; const roles = u.roles.map((id) => ROLES.find((r) => r.id === id));
    const granting = roles.filter((r) => has(r, perm)).map((r) => r.id);
    const steps = [];
    steps.push({ step: 'role', ok: granting.length > 0, detail: granting.length ? 'granted by ' + granting.join(', ') : 'none of ' + u.roles.join(', ') + ' grants ' + perm });
    const scopeOk = !u.scopes || u.scopes.includes(perm);
    steps.push({ step: 'scopes', ok: scopeOk, detail: u.scopes ? (scopeOk ? 'API key scope ' + perm + ' present; scopes never widen a role' : 'API key scopes ' + u.scopes.join(' ') + ' do not include ' + perm) : 'browser session, no scope narrowing' });
    const tenantOk = u.ws.includes(ws) || u.roles.includes('system-admin');
    steps.push({ step: 'tenant', ok: tenantOk, detail: tenantOk ? 'member of Northwind, workspace ' + ws : 'not a member of workspace ' + ws });
    const clearOk = LEVEL[u.clearance] >= LEVEL[label];
    steps.push({ step: 'clearance', ok: clearOk, detail: 'clearance ' + u.clearance + (clearOk ? ' ≥ ' : ' < ') + 'label ' + label });
    const zoneOk = LEVEL[w.ceiling] >= LEVEL[label];
    steps.push({ step: 'zone ceiling', ok: zoneOk, detail: 'zone ' + w.zone + ' ceiling ' + w.ceiling + (zoneOk ? ' ≥ ' : ' < ') + 'label ' + label });
    let decision = 'allow'; let deciding = null;
    for (const s of steps) { if (!s.ok) { decision = 'deny'; deciding = s.step; break; } }
    return { steps, decision, deciding };
  }

  App.register({
    id: 'roles', title: 'Roles and access', summary: 'Role × permission matrix, custom roles with diff and dual control, effective access with explain, access reviews', section: 'admin', crumb: ['Admin', 'Roles and access'],
    commands: [
      { label: 'Who can … (effective access)', sub: 'Roles and access', run(app) { const s = app.stateFor('roles'); s.tab = 'effective'; s.whoCan = true; app.render(); } },
      { label: 'Create a custom role', sub: 'Roles and access', run(app) { const s = app.stateFor('roles'); s.tab = 'custom'; s.openCreate = true; app.render(); } }
    ],
    states: [
      { title: 'Creator ceiling refused', tone: 'danger', text: 'A tenant admin cannot create a role holding platform:manage: 403, the permission is outside what they hold.', apply(ctx) { const st = ctx.state; st.tab = 'custom'; st.openCreate = true; st.createProblem = 'platform:manage'; ctx.rerender(); } },
      { title: 'Dual control pending', tone: 'warn', text: 'A custom role holding admin permissions waits for a second admin before it can be granted.', apply(ctx) { const st = ctx.state; st.tab = 'custom'; st.role = 'vault-operator'; ctx.rerender(); } },
      { title: 'Denied by zone ceiling', tone: 'info', text: 'The explain drawer shows every step; here the zone ceiling (office, confidential) stops a restricted resource although the role and clearance allow.', apply(ctx) { const st = ctx.state; st.tab = 'effective'; st.ws = 'Finance Ops'; st.label = 'restricted'; st.whoCan = false; st.openCell = { u: 'u-priya', p: 'knowledge:read' }; ctx.rerender(); } },
      { title: 'Review overdue, escalated', tone: 'danger', text: 'A campaign past its due date escalates to the tenant admins and notifies them; the reviewer still decides.', apply(ctx) { const st = ctx.state; st.tab = 'reviews'; st.review = 'rv-po'; ctx.rerender(); } },
      { title: 'Revoked grant gone', tone: 'ok', text: 'A revoked grant is written to the audit chain and is gone on the member\'s next request.', apply(ctx) { const st = ctx.state; st.tab = 'reviews'; st.review = 'rv-q3-fin'; const g = st.reviews.find((r) => r.id === 'rv-q3-fin').grants.find((x) => x.id === 'g8'); g.decision = 'revoke'; g.by = 'Mara Okafor'; g.at = 'just now'; st.lastRevoke = g; ctx.rerender(); ctx.toast('Samir Haddad\'s Finance Ops membership revoked. access.review.revoked written; gone on his next request.', 'ok', 5000); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.custom) { st.custom = baseCustom(); st.reviews = baseReviews(); }
      st.tab = st.tab || 'matrix'; st.area = st.area || 'all'; st.roleFilter = st.roleFilter || 'all'; st.q = st.q || ''; st.ws = st.ws || 'Finance Ops'; st.label = st.label || WS[st.ws].label; st.effPerm = st.effPerm || 'knowledge:read'; st.effArea = st.effArea || 'Workspace';
      if (ctx.params.role) { st.tab = 'custom'; st.role = ctx.params.role; delete ctx.params.role; }
      if (ctx.params.perm) { st.tab = 'effective'; st.whoCan = true; st.effPerm = ctx.params.perm; delete ctx.params.perm; }
      if (ctx.params.user) { st.tab = 'effective'; st.userQ = ctx.params.user; delete ctx.params.user; }
      if (ctx.params.review) { st.tab = 'reviews'; st.review = ctx.params.review; delete ctx.params.review; }
      const tabs = UI.tabs([{ id: 'matrix', label: 'Role matrix' }, { id: 'custom', label: 'Custom roles', count: st.custom.filter((r) => r.state !== 'retired').length }, { id: 'effective', label: 'Effective access' }, { id: 'reviews', label: 'Access reviews', count: st.reviews.filter((r) => r.state === 'open' || r.state === 'overdue').length }], st.tab);
      const rv = st.tab === 'reviews' ? renderReviews(st) : null;
      const body = st.tab === 'matrix' ? renderMatrix(st) : st.tab === 'custom' ? renderCustom(st) : st.tab === 'effective' ? renderEffective(st) : rv.main;
      root.innerHTML = '<style>'
        + '#main .roles-matrix{overflow:auto;max-height:560px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}#main .roles-matrix table{border-collapse:separate;border-spacing:0;font-size:12px;min-width:100%}'
        + '#main .roles-matrix th{position:sticky;top:0;background:var(--panel2);z-index:2;padding:6px 8px;text-align:center;font-weight:600;white-space:nowrap;border-bottom:1px solid var(--line)}#main .roles-matrix th:first-child,#main .roles-matrix td:first-child{position:sticky;left:0;background:var(--panel);text-align:left;z-index:3;border-right:1px solid var(--line)}#main .roles-matrix th:first-child{z-index:4;background:var(--panel2)}'
        + '#main .roles-matrix td{padding:4px 8px;text-align:center;border-bottom:1px solid var(--line)}#main .roles-matrix tr:hover td{background:var(--sel)}#main .roles-matrix td.on{color:var(--ok-fg);font-weight:700}#main .roles-matrix td.off{color:var(--faint)}#main .roles-matrix .area td{background:var(--panel2);text-align:left;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}'
        + '#main .roles-matrix button.permlink{background:none;border:0;padding:0;font:inherit;color:var(--fg);cursor:pointer;font-family:var(--mono);font-size:12px;text-align:left}#main .roles-matrix button.permlink:hover{text-decoration:underline}'
        + '#main .roles-cell{border:0;font:inherit;cursor:pointer;width:100%;height:26px;border-radius:4px;background:transparent}#main .roles-cell.allow{background:var(--ok-bg);color:var(--ok-fg)}#main .roles-cell.deny{background:var(--danger-bg);color:var(--danger-fg)}#main .roles-cell.na{color:var(--faint)}#main .roles-cell:hover{outline:2px solid var(--accent)}'
        + '#main .roles-step{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line)}#main .roles-step .n{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;background:var(--sel)}#main .roles-step.ok .n{background:var(--ok-bg);color:var(--ok-fg)}#main .roles-step.deny .n{background:var(--danger-bg);color:var(--danger-fg)}'
        + '#main .roles-permpick{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px 12px;max-height:280px;overflow:auto;padding:8px;border:1px solid var(--line);border-radius:6px}#main .roles-permpick .check{font-size:12px}#main .roles-permpick .check.off{opacity:.45}'
        + '</style>'
        + (rv ? rv.left : '') + '<div class="page">' + UI.pagehead('Roles and access', 'Every answer here comes from the one policy pipeline (role, scopes, tenant, clearance, zone ceiling). Custom roles are defined by the tenant only; access reviews go to the workspace admin by default.', UI.btn('Export matrix', { size: 'sm', icon: 'download', attrs: 'data-export' }) + UI.btn('Who can…', { size: 'sm', icon: 'search', attrs: 'data-whocan' }))
        + tabs + body
        + '</div>';

      ctx.on('click', '.tabs [data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-export]', (e, t) => openMenu(ctx, t, [['csv', 'CSV (GET /api/authz/matrix?format=csv)'], ['json', 'JSON (GET /api/authz/matrix)'], ['md', 'docs/permissions.md (generated)']], null, (v) => ctx.toast(v === 'md' ? 'docs/permissions.md is generated from the catalogue; the test fails when it drifts.' : 'Matrix exported as ' + v.toUpperCase() + ': ' + PERMS.length + ' permissions × ' + (ROLES.length + st.custom.filter((r) => r.state === 'active').length) + ' roles.', 'ok')));
      ctx.on('click', '[data-whocan]', () => { st.tab = 'effective'; st.whoCan = true; ctx.rerender(); });
      wireMatrix(ctx, st); wireCustom(ctx, st); wireEffective(ctx, st); wireReviews(ctx, st);
    }
  });

  // ---------------- Role matrix ----------------
  function renderMatrix(st) {
    const roles = ROLES.concat(st.custom.filter((r) => r.state === 'active').map((r) => Object.assign({}, r, { custom: true }))).filter((r) => st.roleFilter === 'all' || (st.roleFilter === 'mfa' ? r.mfa : st.roleFilter === 'custom' ? r.custom : r.id === st.roleFilter));
    const groups = AREAS.filter((g) => st.area === 'all' || g[0] === st.area).map((g) => [g[0], g[1].filter((p) => !st.q || p.includes(st.q.toLowerCase()))]).filter((g) => g[1].length);
    const head = '<tr><th>Permission' + (st.showRoutes ? ' and routes' : '') + '</th>' + roles.map((r) => '<th title="' + esc(r.desc) + '">' + esc(r.name) + (r.mfa ? '<br><span class="muted" style="font-weight:400">MFA</span>' : '') + (r.custom ? '<br>' + UI.pill('custom', 'accent') : '') + '</th>').join('') + '</tr>';
    const rows = groups.map((g) => '<tr class="area"><td colspan="' + (roles.length + 1) + '">' + esc(g[0]) + '</td></tr>' + g[1].map((p) => '<tr><td><button type="button" class="permlink" data-perm="' + esc(p) + '">' + esc(p) + '</button>' + (p === 'roles:manage' ? ' ' + UI.pill('new in 1.5.0', 'info') : '') + (st.showRoutes ? '<div class="muted" style="font-size:11px;font-family:var(--mono)">' + routesFor(p).slice(0, 3).map(esc).join('<br>') + (routesFor(p).length > 3 ? '<br>+ ' + (routesFor(p).length - 3) + ' more' : '') + '</div>' : '') + '</td>' + roles.map((r) => '<td class="' + (has(r, p) ? 'on' : 'off') + '">' + (has(r, p) ? UI.icon('check', 14) : '·') + '</td>').join('') + '</tr>').join('')).join('');
    const total = groups.reduce((n, g) => n + g[1].length, 0);
    return '<div class="toolbar">' + UI.search('Filter permissions', 'data-mq', st.q) + '<span class="relative">' + UI.btn('Area: ' + (st.area === 'all' ? 'all' : st.area), { size: 'sm', icon: 'filter', attrs: 'data-areamenu', cls: st.area !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn('Roles: ' + ({ all: 'all', mfa: 'requiring MFA', custom: 'custom only' }[st.roleFilter] || st.roleFilter), { size: 'sm', icon: 'filter', attrs: 'data-rolemenu', cls: st.roleFilter !== 'all' ? 'active' : '' }) + '</span>' + UI.toggle('Show routes', !!st.showRoutes, 'data-routes') + '<span class="muted right" style="font-size:12px">' + total + ' of ' + PERMS.length + ' permissions, ' + roles.length + ' roles</span></div>'
      + '<div class="roles-matrix"><table><thead>' + head + '</thead><tbody>' + (rows || '<tr><td colspan="' + (roles.length + 1) + '">' + UI.empty('No permissions match', 'Clear the search or area filter.') + '</td></tr>') + '</tbody></table></div>'
      + '<div class="muted" style="font-size:12px">Generated from the catalogue in <span class="mono">server/src/authz/permissions.ts</span> (B-3301). Every route declares its permission in one table (B-3304): click a permission to see its routes. system-admin holds everything; API-key scopes only narrow a role. <span class="mono">docs/permissions.md</span> is generated from the same source and the test fails when it differs.</div>';
  }
  function wireMatrix(ctx, st) {
    ctx.on('input', '[data-mq]', (e, t) => { st.q = t.value; ctx.rerender(); const i = ctx.$('[data-mq]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
    ctx.on('click', '[data-areamenu]', (e, t) => openMenu(ctx, t, [['all', 'All areas']].concat(AREAS.map((g) => [g[0], g[0]])), st.area, (v) => { st.area = v; ctx.rerender(); }));
    ctx.on('click', '[data-rolemenu]', (e, t) => openMenu(ctx, t, [['all', 'All roles'], ['mfa', 'Roles requiring MFA'], ['custom', 'Custom roles only']].concat(ROLES.map((r) => [r.id, r.name])), st.roleFilter, (v) => { st.roleFilter = v; ctx.rerender(); }));
    ctx.on('click', '[data-routes]', () => { st.showRoutes = !st.showRoutes; ctx.rerender(); });
    ctx.on('click', '[data-perm]', (e, t) => { const p = t.dataset.perm; const holders = ROLES.filter((r) => has(r, p)); ctx.drawer({ title: '<span class="mono">' + esc(p) + '</span>', body: UI.kv([['Area', esc(areaOf(p))], ['Built-in roles', holders.map((r) => esc(r.name)).join(', ') || 'none'], ['Custom roles', st.custom.filter((r) => r.perms.includes(p) && r.state === 'active').map((r) => esc(r.name)).join(', ') || 'none']], 1) + '<div class="eyebrow" style="margin:12px 0 6px">Routes declaring this permission (B-3304)</div>' + UI.code(routesFor(p).join('\n'), 'routes') + '<div class="muted" style="font-size:12px;margin-top:6px">A route registered without a declared permission fails the test suite.</div>', actions: UI.btn('Who can ' + esc(p), { kind: 'primary', attrs: 'data-dwho="' + esc(p) + '"' }) + UI.btn('Close', { attrs: 'data-close' }), onMount(d) { d.querySelector('[data-dwho]').addEventListener('click', () => { App.closeOverlay(); st.tab = 'effective'; st.whoCan = true; st.effPerm = p; ctx.rerender(); }); } }); });
  }

  // ---------------- Custom roles ----------------
  function renderCustom(st) {
    const list = st.custom.filter((r) => st.showRetired || r.state !== 'retired');
    if (st.role && !st.custom.some((r) => r.id === st.role)) st.role = null;
    const sel = st.custom.find((r) => r.id === st.role);
    const table = UI.table(['Role', 'Permissions', 'MFA', 'Grantable by', 'Holders', 'Version', 'State'], list.map((r) => ({ cells: ['<b>' + esc(r.name) + '</b><br><span class="muted" style="font-size:12px">' + esc(r.desc) + '</span>', '<span class="num">' + r.perms.length + '</span>' + (r.perms.some((p) => ADMIN_PERMS.includes(p)) ? ' ' + UI.pill('admin', 'warn') : ''), r.mfa ? UI.pill('required', 'info') : '<span class="muted">no</span>', '<span class="mono">' + esc(r.grantableBy) + '</span>', '<span class="num">' + r.holders.length + '</span>', 'v' + r.version, r.state === 'pending' ? UI.pill('dual control pending', 'warn') : UI.pill(r.state, r.state === 'active' ? 'ok' : r.state === 'retired' ? '' : 'outline')], attrs: 'data-role="' + r.id + '"', selected: sel && sel.id === r.id })), { minWidth: '0', emptyTitle: 'No custom roles yet' });
    let insp = '';
    if (sel) {
      const cur = sel.versions[sel.versions.length - 1]; const prev = sel.versions.length > 1 ? sel.versions[sel.versions.length - 2] : null;
      const added = prev ? cur.perms.filter((p) => !prev.perms.includes(p)) : cur.perms; const removed = prev ? prev.perms.filter((p) => !cur.perms.includes(p)) : [];
      insp = UI.panel(sel.name, (sel.state === 'pending' ? UI.notice('<b>Dual control pending.</b> Proposed by ' + esc(sel.proposedBy) + ', ' + esc(sel.proposedAt) + '. It holds admin permissions (' + sel.perms.filter((p) => ADMIN_PERMS.includes(p)).map(esc).join(', ') + '), so a second tenant admin must approve before it can be granted to anyone.', 'warn', UI.btn('Approve as second admin', { kind: 'primary', size: 'sm', attrs: 'data-approve' })) : '')
        + UI.kv([['State', UI.pill(sel.state === 'pending' ? 'dual control pending' : sel.state, sel.state === 'active' ? 'ok' : sel.state === 'pending' ? 'warn' : '')], ['Version', 'v' + sel.version + ' of ' + sel.versions.length], ['Requires MFA', sel.mfa ? 'yes (holds admin permissions)' : 'no'], ['Grantable by', '<span class="mono">' + esc(sel.grantableBy) + '</span>'], ['Holders', sel.holders.length ? esc(sel.holders.join(', ')) : 'nobody yet'], ['Scope', 'tenant Northwind (custom roles are tenant-only)']], 2)
        + '<div class="eyebrow" style="margin:12px 0 6px">Permissions, v' + sel.version + (prev ? ' against v' + prev.v : '') + '</div><div class="hstack wrap gap4">' + cur.perms.map((p) => UI.pill(p, added.includes(p) && prev ? 'ok' : 'outline')).join('') + removed.map((p) => '<span class="pill danger" style="text-decoration:line-through">' + esc(p) + '</span>').join('') + '</div>' + (prev ? '<div class="muted" style="font-size:12px;margin-top:4px">' + added.length + ' added, ' + removed.length + ' removed since v' + prev.v + '. Holders got the new set at once; audited roles.role.versioned.</div>' : '')
        + '<div class="eyebrow" style="margin:12px 0 6px">Versions</div>' + UI.timeline(sel.versions.slice().reverse().map((v) => ({ title: 'v' + v.v + ', ' + v.perms.length + ' permissions', meta: v.at + ', ' + v.by, tone: v.v === sel.version ? 'accent' : '' })))
        + '<div class="hstack wrap gap6" style="margin-top:10px">' + UI.btn('New version', { kind: 'primary', size: 'sm', attrs: 'data-editrole', disabled: sel.state === 'retired' }) + UI.btn('Grant to a member', { size: 'sm', attrs: 'data-grant', disabled: sel.state !== 'active' }) + UI.btn('Retire', { kind: 'danger', size: 'sm', attrs: 'data-retire', disabled: sel.state === 'retired' }) + '</div>');
    }
    return '<div class="toolbar">' + UI.btn('Create role', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-create' }) + UI.toggle('Show retired', !!st.showRetired, 'data-showretired') + '<span class="muted right" style="font-size:12px">Built only from catalogue permissions; a creator cannot grant more than they hold.</span></div><div class="cols"><div style="flex:1.4;min-width:0">' + table + '</div>' + (sel ? '<div style="flex:1;min-width:0">' + insp + '</div>' : '') + '</div>';
  }
  function roleForm(st, role) {
    const mine = ROLES.filter((r) => USERS[0].roles.includes(r.id)); const iHave = (p) => mine.some((r) => has(r, p));
    const perms = role ? role.perms : [];
    const ceilingAs = st.actAs || 'tenant-admin';
    const have = (p) => ceilingAs === 'system-admin' ? true : ceilingAs === 'tenant-admin' ? has(ROLES[1], p) : iHave(p);
    return '<div class="formgrid">' + UI.field('Name', UI.input(role ? role.name : '', { attrs: 'data-rn', placeholder: 'Close reviewer' })) + UI.field('Grantable by', UI.select(['tenant-admin', 'tenant-admin, identity-admin', 'system-admin'], role ? role.grantableBy : 'tenant-admin', 'data-rg')) + UI.field('Act as (ceiling preview)', UI.select([{ value: 'tenant-admin', label: 'Tenant admin (Jonas Lindqvist)' }, { value: 'me', label: 'Your own roles' }, { value: 'system-admin', label: 'System admin' }], ceilingAs, 'data-ractas'), 'The creator cannot grant more than they hold.') + '</div>'
      + UI.field('Description', UI.input(role ? role.desc : '', { attrs: 'data-rd' }))
      + '<div class="eyebrow" style="margin:6px 0">Permissions from the catalogue</div><div class="roles-permpick">' + AREAS.map((g) => '<div style="grid-column:1/-1;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-top:6px">' + esc(g[0]) + '</div>' + g[1].map((p) => '<label class="check' + (have(p) ? '' : ' off') + '" title="' + (have(p) ? '' : 'You do not hold ' + esc(p) + ': outside your ceiling') + '"><input type="checkbox" data-rp value="' + esc(p) + '"' + (perms.includes(p) ? ' checked' : '') + (have(p) ? '' : ' data-outside="1"') + '><span class="mono" style="font-size:12px">' + esc(p) + (ADMIN_PERMS.includes(p) ? ' <span class="muted">admin</span>' : '') + '</span></label>').join('')).join('') + '</div>'
      + '<div id="roles-form-note">' + (st.createProblem ? UI.problem('Refused (403): outside the creator\'s ceiling', 'A tenant admin cannot create a role holding ' + st.createProblem + '. A creator cannot grant more than they hold; remove it or ask a system admin to create the role.', '8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d') : UI.notice('Admin permissions switch <b>requires MFA</b> on and put the role under <b>dual control</b>: a second tenant admin approves before anyone can hold it. Versions keep a diff; holders get the new set at once.', 'info')) + '</div>';
  }
  function wireCustom(ctx, st) {
    const sel = () => st.custom.find((r) => r.id === st.role);
    ctx.on('click', 'tr[data-role]', (e, t) => { st.role = t.dataset.role; ctx.rerender(); });
    ctx.on('click', '[data-showretired]', () => { st.showRetired = !st.showRetired; ctx.rerender(); });
    const openForm = (role) => ctx.modal({ title: role ? 'New version of ' + esc(role.name) : 'Create custom role', cls: 'wide', body: roleForm(st, role), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(role ? 'Save v' + (role.version + 1) : 'Create', { kind: 'primary', attrs: 'data-rsave' }), onMount(m) {
      const onActAs = (e) => { st.actAs = e.target.value; st.createProblem = null; const keep = Array.prototype.slice.call(m.querySelectorAll('[data-rp]:checked')).map((x) => x.value); m.querySelector('.vstack').innerHTML = roleForm(st, Object.assign({}, role || { name: m.querySelector('[data-rn]').value, desc: m.querySelector('[data-rd]').value, grantableBy: 'tenant-admin' }, { perms: keep })); m.querySelector('[data-ractas]').addEventListener('change', onActAs); };
      m.querySelector('[data-ractas]').addEventListener('change', onActAs);
      m.querySelector('[data-rsave]').addEventListener('click', () => {
        const picked = Array.prototype.slice.call(m.querySelectorAll('[data-rp]:checked')); const outside = picked.filter((x) => x.dataset.outside);
        if (outside.length) { st.createProblem = outside[0].value; m.querySelector('#roles-form-note').innerHTML = UI.problem('Refused (403): outside the creator\'s ceiling', 'A ' + (st.actAs === 'me' ? 'holder of your roles' : 'tenant admin') + ' cannot create a role holding ' + outside.map((x) => x.value).join(', ') + '. A creator cannot grant more than they hold.', '8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d'); return; }
        const perms = picked.map((x) => x.value); if (!perms.length) { ctx.toast('Pick at least one permission.'); return; }
        const name = m.querySelector('[data-rn]').value.trim() || 'Untitled role'; const admin = perms.some((p) => ADMIN_PERMS.includes(p)); App.closeOverlay(); st.createProblem = null;
        if (role) { role.version += 1; role.perms = perms; role.mfa = admin; role.desc = m.querySelector('[data-rd]').value; role.versions.push({ v: role.version, at: 'just now', by: 'Mara Okafor', perms }); if (admin && role.state === 'active') { role.state = 'pending'; role.proposedBy = 'Mara Okafor'; role.proposedAt = 'just now'; } ctx.rerender(); ctx.toast('v' + role.version + ' saved' + (role.state === 'pending' ? '; waits for a second admin (dual control).' : '. Holders have the new set now.'), role.state === 'pending' ? 'warn' : 'ok'); return; }
        const r = { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, desc: m.querySelector('[data-rd]').value, perms, mfa: admin, grantableBy: m.querySelector('[data-rg]').value, holders: [], version: 1, state: admin ? 'pending' : 'active', proposedBy: 'Mara Okafor', proposedAt: 'just now', versions: [{ v: 1, at: 'just now', by: 'Mara Okafor', perms }] }; st.custom.unshift(r); st.role = r.id; ctx.rerender(); ctx.toast(admin ? esc(name) + ' created and waits for a second tenant admin (dual control). roles.role.proposed written.' : esc(name) + ' created (201) and active. roles.role.created written.', admin ? 'warn' : 'ok', 5000);
      });
    } });
    ctx.on('click', '[data-create]', () => openForm(null));
    if (st.openCreate) { st.openCreate = false; setTimeout(() => openForm(null), 0); }
    ctx.on('click', '[data-editrole]', () => openForm(sel()));
    ctx.on('click', '[data-approve]', async () => { const r = sel(); const ok = await ctx.confirm({ title: 'Approve ' + esc(r.name), tag: 'dual control', tone: 'info', body: '<p class="fg2" style="margin:0">You are the second tenant admin. The role becomes active and grantable; the approval is written to the audit chain with both admins.</p>', kv: [['Proposed by', r.proposedBy], ['Permissions', String(r.perms.length)], ['Requires MFA', 'yes']], ok: 'Approve' }); if (!ok) return; r.state = 'active'; ctx.rerender(); ctx.toast(esc(r.name) + ' approved and active. roles.role.approved written.', 'ok'); });
    ctx.on('click', '[data-grant]', () => { const r = sel(); const cands = USERS.filter((u) => u.id !== 'me' && !u.scopes); ctx.modal({ title: 'Grant ' + esc(r.name), body: UI.field('Member', UI.select(cands.map((u) => ({ value: u.id, label: u.name + ' (' + u.clearance + ')' })), cands[0].id, 'data-gu')) + UI.notice(r.mfa ? 'The role requires MFA: the member\'s sessions must complete a second factor before any request is served.' : 'Takes effect on the member\'s next request.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Grant', { kind: 'primary', attrs: 'data-ggo' }), onMount(m) { m.querySelector('[data-ggo]').addEventListener('click', () => { const u = USERS.find((x) => x.id === m.querySelector('[data-gu]').value); App.closeOverlay(); if (!r.holders.includes(u.name)) r.holders.push(u.name); ctx.rerender(); ctx.toast(esc(u.name) + ' now holds ' + esc(r.name) + '. user.roles.updated written.', 'ok'); }); } }); });
    ctx.on('click', '[data-retire]', async () => { const r = sel(); const ok = await ctx.confirm({ title: 'Retire ' + esc(r.name), tag: 'removes grants', tone: 'danger', body: '<p class="fg2" style="margin:0">' + (r.holders.length ? 'Its ' + r.holders.length + ' holders (' + esc(r.holders.join(', ')) + ') lose these permissions on their next request.' : 'Nobody holds it.') + ' Retired roles stay listed for the audit trail and cannot be granted.</p>', ok: 'Retire' }); if (!ok) return; r.state = 'retired'; r.holders = []; ctx.rerender(); ctx.toast(esc(r.name) + ' retired. roles.role.retired written.', 'warn'); });
  }

  // ---------------- Effective access ----------------
  function renderEffective(st) {
    const users = USERS.filter((u) => (u.ws.includes(st.ws) || u.roles.includes('system-admin')) && (!st.userQ || u.name.toLowerCase().includes(st.userQ.toLowerCase()) || u.user.includes(st.userQ.toLowerCase())));
    const perms = (AREAS.find((g) => g[0] === st.effArea) || AREAS[0])[1];
    const controls = '<div class="toolbar">' + UI.seg([{ id: 'matrix', label: 'Users × permissions' }, { id: 'who', label: 'Who can…' }], st.whoCan ? 'who' : 'matrix', 'data-effmode') + UI.select(Object.keys(WS), st.ws, 'data-effws aria-label="Workspace"') + UI.select(['public', 'internal', 'confidential', 'restricted'], st.label, 'data-efflabel aria-label="Resource label"') + (st.whoCan ? UI.select(PERMS, st.effPerm, 'data-effperm aria-label="Permission"') : UI.select(AREAS.map((g) => g[0]), st.effArea, 'data-effarea aria-label="Area"')) + UI.search('Find a member', 'data-uq', st.userQ || '') + '</div>';
    if (st.whoCan) {
      const rows = USERS.filter((u) => u.ws.includes(st.ws) || u.roles.includes('system-admin')).map((u) => ({ u, x: explain(u, st.effPerm, st.ws, st.label) }));
      const can = rows.filter((r) => r.x.decision === 'allow'); const cannot = rows.filter((r) => r.x.decision === 'deny');
      return controls + UI.pagehead('Who can ' + st.effPerm, 'In ' + esc(st.ws) + ' on a resource labelled ' + esc(st.label) + ': ' + can.length + ' of ' + rows.length + ' principals. Each row names the deciding step.')
        + UI.table(['Principal', 'Roles', 'Clearance', 'Decision', 'Deciding step'], rows.map((r) => ({ cells: [esc(r.u.name) + ' <span class="muted mono" style="font-size:11px">' + esc(r.u.user) + '</span>', '<span class="mono" style="font-size:11px">' + esc(r.u.roles.join(' ')) + (r.u.scopes ? '<br>scopes ' + esc(r.u.scopes.join(' ')) : '') + '</span>', UI.label(r.u.clearance, { sm: true }), UI.pill(r.x.decision, r.x.decision === 'allow' ? 'ok' : 'danger'), r.x.deciding ? '<b>' + esc(r.x.deciding) + '</b>: ' + esc(r.x.steps.find((s) => s.step === r.x.deciding).detail) : 'every step allows'], attrs: 'data-cell="' + r.u.id + '|' + esc(st.effPerm) + '"' })), { minWidth: '0' })
        + '<div class="muted" style="font-size:12px">A cell matches <span class="mono">policy.explain</span> for the same principal and resource (B-3303). Click a row for every step. <a href="#" data-gotenants>Members in Tenants</a>, <a href="#" data-goidentity">group mappings in Identity</a>.</div>';
    }
    const head = '<tr><th>Member</th>' + perms.map((p) => '<th><span class="mono">' + esc(p) + '</span></th>').join('') + '</tr>';
    const rows = users.map((u) => '<tr><td><b>' + esc(u.name) + '</b><br><span class="muted" style="font-size:11px">' + esc(u.roles.join(', ')) + ', ' + esc(u.clearance) + '</span></td>' + perms.map((p) => { const x = explain(u, p, st.ws, st.label); const na = !x.steps[0].ok; return '<td><button type="button" class="roles-cell ' + (x.decision === 'allow' ? 'allow' : na ? 'na' : 'deny') + '" data-cell="' + u.id + '|' + esc(p) + '" title="' + esc(x.decision + (x.deciding ? ' at ' + x.deciding : '')) + '">' + (x.decision === 'allow' ? UI.icon('check', 13) : na ? '·' : UI.icon('x', 13)) + '</button></td>'; }).join('') + '</tr>').join('');
    return controls + '<div class="roles-matrix" style="max-height:480px"><table><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="hstack wrap gap12 muted" style="font-size:12px"><span><span class="pill ok">allow</span> every step allows</span><span><span class="pill danger">deny</span> role grants it, a later step refuses</span><span>· no role grants it</span><span class="grow"></span><span>Click a cell for the explain steps (B-3303). Resource label ' + esc(st.label) + ' in ' + esc(st.ws) + ' (zone ' + esc(WS[st.ws].zone) + ', ceiling ' + esc(WS[st.ws].ceiling) + ').</span></div>';
  }
  function wireEffective(ctx, st) {
    ctx.on('click', '[data-effmode] [data-seg]', (e, t) => { st.whoCan = t.dataset.seg === 'who'; ctx.rerender(); });
    ctx.on('change', '[data-effws]', (e, t) => { st.ws = t.value; st.label = WS[t.value].label; ctx.rerender(); });
    ctx.on('change', '[data-efflabel]', (e, t) => { st.label = t.value; ctx.rerender(); });
    ctx.on('change', '[data-effperm]', (e, t) => { st.effPerm = t.value; ctx.rerender(); });
    ctx.on('change', '[data-effarea]', (e, t) => { st.effArea = t.value; ctx.rerender(); });
    ctx.on('input', '[data-uq]', (e, t) => { st.userQ = t.value; ctx.rerender(); const i = ctx.$('[data-uq]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
    ctx.on('click', '[data-gotenants]', (e) => { e.preventDefault(); ctx.navigate('tenants'); });
    ctx.on('click', '[data-goidentity]', (e) => { e.preventDefault(); ctx.navigate('identity', { tab: 'mappings' }); });
    const openCell = (uid, p) => { const u = USERS.find((x) => x.id === uid); const x = explain(u, p, st.ws, st.label); ctx.drawer({ title: 'Explain: ' + esc(u.name) + ', <span class="mono">' + esc(p) + '</span>', body: UI.kv([['Workspace', esc(st.ws)], ['Resource label', UI.label(st.label, { sm: true })], ['Decision', UI.pill(x.decision, x.decision === 'allow' ? 'ok' : 'danger') + (x.deciding ? ' at <b>' + esc(x.deciding) + '</b>' : '')]], 3) + '<div class="eyebrow" style="margin:12px 0 4px">policy.explain, in order</div>' + x.steps.map((s, i) => '<div class="roles-step ' + (s.ok ? 'ok' : (x.deciding === s.step ? 'deny' : '')) + '"><span class="n">' + (i + 1) + '</span><span><b>' + esc(s.step) + '</b> ' + UI.pill(s.ok ? 'allow' : x.deciding === s.step ? 'deny' : 'not reached', s.ok ? 'ok' : x.deciding === s.step ? 'danger' : '') + '<br><span class="fg2" style="font-size:12px">' + esc(s.detail) + '</span></span></div>').join('') + '<div class="muted" style="font-size:12px;margin-top:8px">The same pipeline serves every request: role → scopes → tenant → clearance → zone ceiling. Nothing here is a second policy engine.</div>', actions: UI.btn('Open in Usage and audit', { kind: 'ghost', attrs: 'data-goaudit' }) + UI.btn('Close', { attrs: 'data-close' }), onMount(d) { d.querySelector('[data-goaudit]').addEventListener('click', () => { App.closeOverlay(); ctx.navigate('usage-audit', { q: 'policy.explain ' + u.user }); }); } }); };
    ctx.on('click', '[data-cell]', (e, t) => { const [uid, p] = t.dataset.cell.split('|'); openCell(uid, p); });
    if (st.openCell) { const c = st.openCell; st.openCell = null; setTimeout(() => openCell(c.u, c.p), 0); }
  }

  // ---------------- Access reviews ----------------
  function renderReviews(st) {
    if (!st.review || !st.reviews.some((r) => r.id === st.review)) st.review = (st.reviews.find((r) => r.state === 'open') || st.reviews[0]).id;
    const sel = st.reviews.find((r) => r.id === st.review);
    const progress = (r) => { const d = r.grants.filter((g) => g.decision !== 'pending').length; return { d, n: r.grants.length }; };
    const list = '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Campaigns</div>' + UI.btn('New', { size: 'sm', icon: 'plus', attrs: 'data-newcampaign' }) + '</div><div class="vstack gap4">' + st.reviews.map((r) => { const p = progress(r); return UI.listItem(esc(r.name), esc('due ' + r.due + (p.n ? ', ' + p.d + ' of ' + p.n + ' decided' : '')), { active: r.id === sel.id, attrs: 'data-review="' + r.id + '"', right: UI.pill(r.state, r.state === 'open' ? 'info' : r.state === 'overdue' ? 'danger' : r.state === 'closed' ? 'ok' : '') }); }).join('') + '</div><div class="muted" style="font-size:12px;padding:6px 8px">Default reviewer: the workspace admin. Results land in the audit chain; a revoked grant is gone on the member\'s next request.</div></div>';
    const p = progress(sel); const pending = sel.grants.filter((g) => g.decision === 'pending');
    let filtered = sel.grants.filter((g) => (st.gfilter || 'all') === 'all' || g.decision === st.gfilter);
    filtered = filtered.slice().sort((a, b) => st.gsort === 'member' ? a.member.localeCompare(b.member) : st.gsort === 'lastused' ? (a.lastUsed === 'never' ? -1 : b.lastUsed === 'never' ? 1 : 0) : 0);
    const head = UI.pagehead(sel.name, esc(sel.scope === 'tenant' ? 'Tenant-wide' : 'Workspace ' + sel.ws) + ', ' + esc(sel.cadence) + ', due ' + esc(sel.due) + '. Reviewer: ' + esc(sel.reviewer) + '.', UI.pill(sel.state, sel.state === 'open' ? 'info' : sel.state === 'overdue' ? 'danger' : sel.state === 'closed' ? 'ok' : '') + UI.btn('Confirm all pending', { size: 'sm', attrs: 'data-bulkconfirm', disabled: !pending.length || sel.state === 'closed' || sel.state === 'scheduled' }) + UI.btn('Close campaign', { size: 'sm', kind: 'ghost', attrs: 'data-closecampaign', disabled: sel.state === 'closed' || sel.state === 'scheduled' || pending.length > 0 }));
    const notices = (sel.state === 'overdue' ? UI.notice('<b>Overdue since ' + esc(sel.due) + '.</b> Escalated to ' + esc(sel.escalatedTo) + '; the tenant admins were notified and can decide in the reviewer\'s place. Audited access.review.escalated.', 'danger') : '') + (sel.state === 'scheduled' ? UI.notice('Scheduled. The grants are snapshotted from the matrix when the campaign opens, on ' + esc(sel.due.replace('1 Nov', '1 Oct')) + '.', 'info') : '') + (st.lastRevoke && st.lastRevoke.id && sel.grants.some((g) => g.id === st.lastRevoke.id) ? UI.notice('<b>' + esc(st.lastRevoke.member) + '\'s ' + esc(st.lastRevoke.what) + ' revoked.</b> Written to the audit chain (access.review.revoked, by ' + esc(st.lastRevoke.by) + '); the grant is gone on their next request, and their sockets left the workspace rooms.', 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearrevoke' })) : '');
    const meter = p.n ? UI.meter('Decided', p.d + ' of ' + p.n, (p.d / p.n) * 100, sel.state === 'overdue' ? 'danger' : 'accent') : '';
    const table = UI.table(['Member', 'Grant', 'Workspace', 'Last used', 'Decision', { label: '', right: true }], filtered.map((g) => ({ cells: [esc(g.member), '<span class="mono" style="font-size:12px">' + esc(g.what) + '</span>', esc(g.ws), g.lastUsed === 'never' || /\d+ d/.test(g.lastUsed) ? '<span style="color:var(--warn-fg)">' + esc(g.lastUsed) + '</span>' : esc(g.lastUsed), g.decision === 'pending' ? UI.pill('pending', 'warn') : UI.pill(g.decision === 'confirm' ? 'confirmed' : 'revoked', g.decision === 'confirm' ? 'ok' : 'danger') + '<br><span class="muted" style="font-size:11px">' + esc(g.by) + ', ' + esc(g.at) + '</span>', g.decision === 'pending' && sel.state !== 'closed' ? '<span class="hstack gap6" style="justify-content:flex-end">' + UI.btn('Confirm', { size: 'sm', attrs: 'data-decide="' + g.id + '" data-d="confirm"' }) + UI.btn('Revoke', { size: 'sm', kind: 'danger', attrs: 'data-decide="' + g.id + '" data-d="revoke"' }) + '</span>' : ''], attrs: 'data-grant="' + g.id + '"' })), { clickable: false, minWidth: '0', emptyTitle: sel.state === 'scheduled' ? 'Opens on its start date' : 'No grants match' });
    const toolbar = '<div class="toolbar"><span class="relative">' + UI.btn('Decision: ' + (st.gfilter || 'all'), { size: 'sm', icon: 'filter', attrs: 'data-gfilter', cls: st.gfilter && st.gfilter !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn({ member: 'By member', lastused: 'Unused first' }[st.gsort] || 'Sort', { size: 'sm', icon: 'sort', attrs: 'data-gsort' }) + '</span><span class="muted right" style="font-size:12px">' + pending.length + ' pending</span></div>';
    return { left: list, main: head + notices + meter + toolbar + table + '<div class="muted" style="font-size:12px">Reviewers confirm or revoke each grant over the effective-access matrix (B-3305). Overdue reviews escalate; every decision is in the audit chain. <a href="#" data-goaudit>Open in Usage and audit</a></div>' };
  }
  function wireReviews(ctx, st) {
    const sel = () => st.reviews.find((r) => r.id === st.review);
    ctx.on('click', '[data-review]', (e, t) => { st.review = t.dataset.review; st.lastRevoke = null; ctx.rerender(); });
    ctx.on('click', '[data-clearrevoke]', () => { st.lastRevoke = null; ctx.rerender(); });
    ctx.on('click', '[data-goaudit]', (e) => { e.preventDefault(); ctx.navigate('usage-audit', { q: 'access.review' }); });
    ctx.on('click', '[data-gfilter]', (e, t) => openMenu(ctx, t, [['all', 'All'], ['pending', 'Pending'], ['confirm', 'Confirmed'], ['revoke', 'Revoked']], st.gfilter || 'all', (v) => { st.gfilter = v; ctx.rerender(); }));
    ctx.on('click', '[data-gsort]', (e, t) => openMenu(ctx, t, [['none', 'As listed'], ['member', 'By member'], ['lastused', 'Unused first']], st.gsort || 'none', (v) => { st.gsort = v; ctx.rerender(); }));
    ctx.on('click', '[data-decide]', async (e, t) => { const r = sel(); const g = r.grants.find((x) => x.id === t.dataset.decide); const d = t.dataset.d; if (d === 'revoke') { const ok = await ctx.confirm({ title: 'Revoke grant', tag: 'next request', tone: 'danger', body: '<p class="fg2" style="margin:0">The grant is removed now and written to the audit chain. ' + esc(g.member) + ' loses it on their next request; open sockets leave the rooms it admitted them to.</p>', kv: [['Member', g.member], ['Grant', g.what], ['Last used', g.lastUsed]], ok: 'Revoke' }); if (!ok) return; } g.decision = d; g.by = 'Mara Okafor'; g.at = 'just now'; if (d === 'revoke') st.lastRevoke = g; if (r.state === 'overdue' && !r.grants.some((x) => x.decision === 'pending')) r.state = 'open'; ctx.rerender(); ctx.toast(d === 'confirm' ? esc(g.member) + '\'s ' + esc(g.what) + ' confirmed. access.review.confirmed written.' : esc(g.member) + '\'s ' + esc(g.what) + ' revoked. Gone on the next request.', d === 'confirm' ? 'ok' : 'warn'); });
    ctx.on('click', '[data-bulkconfirm]', async () => { const r = sel(); const pend = r.grants.filter((g) => g.decision === 'pending'); const unused = pend.filter((g) => g.lastUsed === 'never' || /\d+ d/.test(g.lastUsed)); const ok = await ctx.confirm({ title: 'Confirm ' + pend.length + ' pending grants', tag: 'bulk', tone: 'info', body: '<p class="fg2" style="margin:0">Each grant is confirmed in its own audit entry.' + (unused.length ? ' <b>' + unused.length + ' of them were not used in 30 days</b> (' + esc(unused.map((g) => g.member).join(', ')) + '); consider revoking those one by one.' : '') + '</p>', ok: 'Confirm all' }); if (!ok) return; pend.forEach((g) => { g.decision = 'confirm'; g.by = 'Mara Okafor'; g.at = 'just now'; }); if (r.state === 'overdue') r.state = 'open'; ctx.rerender(); ctx.toast(pend.length + ' grants confirmed.', 'ok'); });
    ctx.on('click', '[data-closecampaign]', async () => { const r = sel(); const ok = await ctx.confirm({ title: 'Close campaign', tone: 'info', body: '<p class="fg2" style="margin:0">Every grant is decided. Closing writes the certification summary to the audit chain and schedules the next one by its cadence (' + esc(r.cadence) + ').</p>', ok: 'Close' }); if (!ok) return; r.state = 'closed'; ctx.rerender(); ctx.toast('Campaign closed. access.review.closed written; next run scheduled.', 'ok'); });
    ctx.on('click', '[data-newcampaign]', () => ctx.modal({ title: 'New access review', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-cn', placeholder: 'Q4 certification, Finance Ops' })) + UI.field('Scope', UI.select([{ value: 'workspace', label: 'One workspace' }, { value: 'tenant', label: 'Tenant-wide (admin roles)' }], 'workspace', 'data-cs')) + UI.field('Workspace', UI.select(Object.keys(WS), 'Finance Ops', 'data-cw')) + UI.field('Reviewer', UI.select(['Workspace admin (default)', 'Tenant admins', 'Workspace admin and tenant admins'], 'Workspace admin (default)', 'data-cr')) + UI.field('Due', UI.input('31 Dec 2026', { attrs: 'data-cd' })) + UI.field('Cadence', UI.select(['once', 'quarterly', 'half-yearly', 'yearly'], 'quarterly', 'data-cc')) + '</div>' + UI.notice('Grants are snapshotted from the effective-access matrix when the campaign opens. Overdue campaigns escalate to the tenant admins after the due date.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Schedule', { kind: 'primary', attrs: 'data-cgo' }), onMount(m) { m.querySelector('[data-cgo]').addEventListener('click', () => { const ws = m.querySelector('[data-cw]').value; const scope = m.querySelector('[data-cs]').value; const r = { id: 'rv' + Date.now(), name: m.querySelector('[data-cn]').value || 'Untitled review', scope, ws: scope === 'tenant' ? null : ws, reviewer: scope === 'tenant' ? 'System admins' : WS[ws].admin + ' (workspace admin)', due: m.querySelector('[data-cd]').value, state: 'scheduled', cadence: m.querySelector('[data-cc]').value, grants: [] }; App.closeOverlay(); st.reviews.push(r); st.review = r.id; ctx.rerender(); ctx.toast('Campaign scheduled (201). access.review.created written.', 'ok'); }); } }));
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
