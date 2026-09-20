(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  const CLIENTS = [
    { id: 'console', name: 'Exprsn-AI console', type: 'confidential, BFF', grants: 'authorization code and PKCE, refresh', scopes: 'openid chat:* context:*', status: 'active', clientId: 'c_a1c0ffee', lifetime: '10 min', refresh: '8 h, rotated on use', models: 'per profile', used: '2 min ago', pkce: true, redirects: ['https://ai.northwind.local/auth/callback', 'https://ai.northwind.local/auth/silent'], grantList: ['authorization_code', 'refresh_token'], secret: 'held in OpenBao, never shown', created: '3 Feb 2026', consent: 'first party, pre-consented' },
    { id: 'cli', name: 'exprsn CLI', type: 'public', grants: 'device authorization', phase: 'Phase 5', scopes: 'chat:write inference:invoke', status: 'planned', clientId: 'c_cli_public', lifetime: '10 min', refresh: '24 h, rotated on use', models: 'chat-default, fast', used: 'never', pkce: true, redirects: ['urn:ietf:wg:oauth:2.0:oob'], grantList: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'], secret: 'none, public client', created: 'planned', consent: 'user approves the device code' },
    { id: 'svc-close-bot', name: 'svc-close-bot', type: 'service account', grants: 'client credentials', scopes: 'inference:invoke:analyst', status: 'active', clientId: 'c_7f21ab90', lifetime: '10 min', refresh: 'none', models: 'analyst', used: '11 min ago', pkce: false, redirects: [], grantList: ['client_credentials'], secret: 'xs_live_9QmT4v...redacted-in-mockup', created: '19 Sep 2026', consent: 'not applicable', fresh: true },
    { id: 'ledger-notebook', name: 'Ledger Notebook', type: 'third party', grants: 'authorization code and PKCE', scopes: 'chat:read chat:write', status: 'active', clientId: 'c_3d9e77b1', lifetime: '10 min', refresh: '8 h, rotated on use', models: 'chat-default', used: 'yesterday', pkce: true, redirects: ['https://notebook.northwind.local/oauth/cb'], grantList: ['authorization_code', 'refresh_token'], secret: 'created 2 Jun 2026', created: '2 Jun 2026', consent: 'user consent on first use, 27 granted' }
  ];

  const SAML = [
    { name: 'Confluence (on-prem)', entity: 'https://wiki.northwind.local/saml', acs: 'https://wiki.northwind.local/plugins/servlet/samlconsumer', nameid: 'emailAddress', cert: 'expires 4 Mar 2027', status: 'active' },
    { name: 'Grafana', entity: 'https://grafana.northwind.local/saml/metadata', acs: 'https://grafana.northwind.local/saml/acs', nameid: 'persistent', cert: 'expires 12 Nov 2026', status: 'active' },
    { name: 'Legacy expense portal', entity: 'urn:northwind:expenses', acs: 'https://expenses.northwind.local/sso/acs', nameid: 'unspecified', cert: 'expired 1 Aug 2026', status: 'disabled' }
  ];

  const SCOPES = [
    ['openid profile email groups', 'Identity claims', 'pre-consented'], ['chat:read, chat:write', 'Own conversations', 'user consent'], ['inference:invoke[:model]', 'Direct model calls via native or OpenAI-compatible API', 'user consent'],
    ['context:read, context:write', 'Knowledge bases and documents', 'user consent'], ['images:generate', 'Image jobs', 'user consent'], ['tools:invoke, agents:run', 'Tool calls and agent runs', 'user consent, with per-call confirmation for writes'],
    ['models:read, models:manage', 'Model registry, pulls, approvals', 'admin only'], ['tools:manage, agents:manage', 'Tool, agent and skill registry', 'admin only'], ['guardrails:manage', 'Guardrail profiles', 'admin only'],
    ['training:submit, training:manage', 'Datasets and fine-tune jobs', 'admin only'], ['admin:tenant, admin:system, audit:read', 'Administration and audit', 'admin only']
  ];

  const KEYS0 = [
    { kid: 'k-2026-07', alg: 'ES256', state: 'signing', created: '14 Jul 2026', rotates: '12 Oct 2026, in 23 days' },
    { kid: 'k-2026-04', alg: 'ES256', state: 'verify only, overlap', created: '15 Apr 2026', rotates: 'removed 28 Jul 2026' }
  ];

  const UPSTREAM = [
    { name: 'AD FS, corp.northwind.local', protocol: 'SAML 2.0 (we are SP)', reach: 'on-prem, directory zone', status: 'connected', used: 'Field Sales sign-ins' },
    { name: 'Contoso Keycloak', protocol: 'OIDC (we are RP)', reach: 'on-prem, partner link', status: 'connected', used: 'Platform lab' }
  ];

  const SESSIONS = [
    { user: 'Mara Okafor', signed: '09:02 today', method: 'Kerberos, passkey', client: 'Exprsn-AI console' },
    { user: 'Tomasz Wieczorek', signed: '08:41 today', method: 'LDAP password, TOTP', client: 'Exprsn-AI console' },
    { user: 'svc-close-bot', signed: 'token, 11 min ago', method: 'client credentials', client: 'svc-close-bot' },
    { user: 'Priya Natarajan', signed: 'yesterday 17:20', method: 'Kerberos', client: 'Ledger Notebook' }
  ];

  const jwks = (keys) => JSON.stringify({ keys: keys.filter((k) => !/removed/.test(k.rotates)).map((k) => ({ kty: 'EC', crv: 'P-256', use: 'sig', alg: k.alg, kid: k.kid, x: k.kid === 'k-2026-07' ? 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU' : k.kid === 'k-2026-04' ? 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' : 'WbL0aQ8XdYvPq8j2hCnJf1lyuY3fNc6h8gJ1F2pKq7c', y: k.kid === 'k-2026-07' ? 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' : k.kid === 'k-2026-04' ? '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM' : 'p9c2Hn0yQ4mR7dJxK1sVb3wFzLqT8uE6aC5oN2iG4kY' })) }, null, 2);

  App.register({
    id: 'identity', title: 'Identity', section: 'admin', summary: 'OIDC clients, SAML providers, scopes and consent, signing keys, upstream federation',
    commands: [
      { label: 'Create an OIDC client', sub: 'Identity', run(app) { app.stateFor('identity').openCreate = true; app.render(); } },
      { label: 'Rotate the signing key', sub: 'Identity', run(app) { app.stateFor('identity').tab = 'keys'; app.stateFor('identity').openRotate = true; app.render(); } }
    ],
    states: [
      { title: 'After the reveal', tone: 'neutral', text: 'The secret field shows only its creation date and a rotate action.', apply(ctx) { ctx.state.tab = 'clients'; ctx.state.client = 'svc-close-bot'; ctx.state.revealed = ctx.state.revealed || {}; ctx.state.revealed['svc-close-bot'] = '19 Sep 2026, 13:51'; ctx.rerender(); } },
      { title: 'Key nearing expiry', tone: 'warn', text: '14 days before rotation a banner appears. The new key is published to JWKS before it signs.', apply(ctx) { ctx.state.tab = 'keys'; ctx.state.keyExpiring = true; ctx.rerender(); } },
      { title: 'Upstream federation', tone: 'info', text: 'Only on-prem identity providers can be added. Cloud providers are unreachable from this network.', apply(ctx) { ctx.state.tab = 'upstream'; ctx.state.openUpstream = true; ctx.rerender(); } },
      { title: 'SAML metadata import', tone: 'neutral', text: 'Parsed entity ID, ACS URLs and certificate are shown for review before saving.', apply(ctx) { ctx.state.tab = 'saml'; ctx.state.openSaml = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'clients'; st.client = st.client || 'svc-close-bot'; st.revealed = st.revealed || {}; st.keys = st.keys || KEYS0.map((k) => Object.assign({}, k)); st.clients = st.clients || CLIENTS.map((c) => Object.assign({}, c)); st.saml = st.saml || SAML.slice(); st.upstream = st.upstream || UPSTREAM.slice(); st.revoked = st.revoked || {}; st.q = st.q || '';
      if (ctx.params.client) { const c = st.clients.find((x) => x.name === ctx.params.client || x.id === ctx.params.client); if (c) { st.client = c.id; st.tab = 'clients'; } }
      if (ctx.params.tab) st.tab = ctx.params.tab;
      const client = st.clients.find((c) => c.id === st.client) || st.clients[2];
      const signing = st.keys.find((k) => k.state === 'signing');

      const tabs = UI.tabs([{ id: 'clients', label: 'OIDC clients', count: st.clients.length }, { id: 'saml', label: 'SAML service providers', count: st.saml.length }, { id: 'scopes', label: 'Scopes and consent' }, { id: 'keys', label: 'Keys' }, { id: 'upstream', label: 'Upstream federation' }, { id: 'sessions', label: 'Sessions' }], st.tab);
      const banner = st.keyExpiring ? UI.notice('<b>Signing key ' + esc(signing.kid) + ' rotates in 13 days.</b> The next key is generated now and published to JWKS so relying parties cache it before it signs anything.', 'warn', UI.btn('Rotate now', { size: 'sm', attrs: 'data-rotatekey' })) : '';

      let body = '';
      if (st.tab === 'clients') {
        const rows = st.clients.filter((c) => !st.q || (c.name + ' ' + c.type + ' ' + c.scopes).toLowerCase().includes(st.q.toLowerCase()));
        body = '<div class="hstack wrap">' + UI.search('Search clients', 'data-q', st.q) + '<span class="muted" style="font-size:12px">Every API call carries a scoped token from this issuer. Tokens stay in the BFF; browsers hold only a session cookie.</span></div>'
          + UI.table(['Client', 'Type', 'Grants', 'Scopes', 'Status'], rows.map((c) => ({ cells: ['<b>' + esc(c.name) + '</b>', esc(c.type), esc(c.grants) + (c.phase ? ' ' + UI.pill(c.phase, 'outline') : ''), '<span class="mono">' + esc(c.scopes) + '</span>', UI.pill(c.status, c.status === 'active' ? 'ok' : c.status === 'planned' ? 'outline' : 'warn')], attrs: 'data-client="' + c.id + '"', selected: c.id === client.id })), { minWidth: '700px', emptyTitle: 'No clients match', emptyText: 'Clear the search or create a client.' })
          + '<div class="eyebrow">Signing keys, 90 day rotation</div>' + keysTable(true)
          + UI.panel('Delivered in stages', UI.kv([['Phase 1', 'Code and PKCE, client credentials, refresh rotation, LDAP'], ['Phase 4', 'Token exchange for agents, audience-bound tokens for MCP'], ['Phase 5', 'SAML IdP, Kerberos SPNEGO, device flow, DPoP, on-prem federation']], 3));
      } else if (st.tab === 'saml') {
        body = '<div class="hstack"><span class="fg2">Applications that only speak SAML get assertions from the same issuer, with the same groups and clearance claims.</span><span class="right">' + UI.btn('Import metadata', { size: 'sm', icon: 'upload', attrs: 'data-saml' }) + '</span></div>'
          + UI.table(['Service provider', 'Entity ID', 'ACS URL', 'NameID', 'Certificate', 'Status', ''], st.saml.map((s, i) => [ '<b>' + esc(s.name) + '</b>', '<span class="mono">' + esc(s.entity) + '</span>', '<span class="mono">' + esc(s.acs) + '</span>', esc(s.nameid), esc(s.cert), UI.pill(s.status, s.status === 'active' ? 'ok' : s.status === 'disabled' ? 'warn' : 'info'), s.status === 'disabled' ? UI.btn('Enable', { size: 'xs', attrs: 'data-samlenable="' + i + '"' }) : UI.btn('Download IdP metadata', { size: 'xs', kind: 'ghost', attrs: 'data-copy="idp-metadata.xml"' }) ]), { clickable: false, minWidth: '860px' })
          + UI.notice('The IdP entity ID is <span class="mono">https://ai.northwind.local/saml/idp</span>. Assertions are signed with the current signing key and expire after 5 minutes.', 'info');
      } else if (st.tab === 'scopes') {
        body = UI.table(['Scope', 'Grants', 'Consent'], SCOPES.map((s) => ['<span class="mono">' + esc(s[0]) + '</span>', esc(s[1]), esc(s[2])]), { clickable: false, minWidth: '640px' })
          + '<div class="grid2">' + UI.panel('Consent policy', UI.toggle('First-party clients are pre-consented', true, 'data-manual') + UI.toggle('Third-party clients ask on first use', true, 'data-manual') + UI.toggle('Remember consent for 90 days', true, 'data-manual') + '<div class="muted" style="font-size:12px">Effective permission is client scopes intersected with role permissions, then clearance and zone. Scopes never widen a role.</div>')
          + UI.panel('Token shape', UI.kv([['Access token', 'JWT, ES256, 10 min, audience-bound'], ['Refresh token', 'opaque, rotated on every use (RFC 9700)'], ['Agent delegation', 'token exchange with an act claim (RFC 8693)'], ['High assurance', 'PAR and DPoP, optional per client'], ['Introspection', 'RFC 7662 for opaque tokens; revocation on logout and disable']], 1)) + '</div>';
      } else if (st.tab === 'keys') {
        body = '<div class="hstack"><span class="eyebrow">Signing keys, 90 day rotation</span><span class="right hstack gap6">' + UI.btn('Copy JWKS URL', { size: 'sm', kind: 'ghost', attrs: 'data-copy="https://ai.northwind.local/.well-known/jwks.json"' }) + UI.btn('Rotate signing key', { size: 'sm', kind: 'primary', icon: 'key', attrs: 'data-rotatekey' }) + '</span></div>' + keysTable(false)
          + '<div class="grid2">' + UI.panel('JWKS preview', '<div class="fg2" style="font-size:12px">Served at <span class="mono">/.well-known/jwks.json</span>. The overlap key stays listed until every token it signed has expired.</div>' + UI.code(jwks(st.keys), 'json'))
          + UI.panel('Where keys live', UI.kv([['Store', 'OpenBao transit, never on disk in the app zone'], ['Algorithm', 'ES256 (P-256)'], ['Rotation', 'every 90 days with a 14 day overlap window'], ['Discovery', '/.well-known/openid-configuration'], ['Data keys', 'per-tenant envelope keys in the same transit mount']], 1) + '<div>' + UI.btn('Open secrets health', { size: 'sm', attrs: 'data-goplatform' }) + '</div>') + '</div>';
      } else if (st.tab === 'upstream') {
        body = '<div class="hstack"><span class="fg2">Optional federation: this issuer acts as OIDC relying party or SAML service provider to an on-prem identity provider.</span><span class="right">' + UI.btn('Add upstream provider', { size: 'sm', icon: 'plus', attrs: 'data-upstream' }) + '</span></div>'
          + UI.table(['Provider', 'Protocol', 'Reachability', 'Status', 'Used by'], st.upstream.map((u) => ['<b>' + esc(u.name) + '</b>', esc(u.protocol), esc(u.reach), UI.pill(u.status), esc(u.used)]), { clickable: false, minWidth: '640px' })
          + '<div class="grid2">' + UI.panel('Primary authentication', UI.kv([['Kerberos SPNEGO', 'HTTP/ai.northwind.local keytab, validated against the KDC'], ['LDAP bind', 'LDAPS to OpenLDAP; never a clear bind'], ['Second factor', 'WebAuthn passkeys and TOTP, required for admin roles'], ['Device flow', 'RFC 8628 for the CLI, Phase 5'], ['Fallback order', 'Kerberos, then password, then MFA']], 1) + '<div>' + UI.btn('Test a login', { size: 'sm', attrs: 'data-testlogin' }) + '</div>')
          + UI.panel('Air gap', UI.notice('Cloud identity providers are unreachable from this network. Only on-prem providers in the directory zone or over a partner link can be upstream.', 'info') + '<div>' + UI.btn('Open zones', { size: 'sm', kind: 'ghost', attrs: 'data-gozones' }) + '</div>') + '</div>';
      } else {
        const rows = SESSIONS.filter((s) => !st.revoked[s.user]);
        body = '<div class="eyebrow">Active sessions, all tenants</div>' + UI.table(['User', 'Signed in', 'Method', 'Client', ''], rows.map((s) => ['<b>' + esc(s.user) + '</b>', esc(s.signed), esc(s.method), esc(s.client), UI.btn('Revoke', { size: 'xs', attrs: 'data-revoke="' + esc(s.user) + '"' })]), { clickable: false, minWidth: '560px', emptyTitle: 'No active sessions', emptyText: 'Sessions appear when someone signs in or a service account requests a token.' })
          + '<div class="muted" style="font-size:12px">Revocation also invalidates refresh tokens. Users disabled by directory sync lose their sessions within one sync interval.</div><div>' + UI.btn('Open tenant sessions', { size: 'sm', kind: 'ghost', attrs: 'data-gotenants' }) + '</div>';
      }

      function keysTable(compact) {
        return UI.table(['Key ID', 'Algorithm', 'State', 'Created', 'Rotates'], st.keys.map((k) => ['<span class="mono">' + esc(k.kid) + '</span>', esc(k.alg), UI.pill(k.state, k.state === 'signing' ? 'ok' : k.state === 'next, published' ? 'info' : 'outline'), esc(k.created), esc(k.rotates) + (st.keyExpiring && k.state === 'signing' ? ' ' + UI.pill('13 days', 'warn') : '')]), { clickable: false, minWidth: compact ? '520px' : '600px' });
      }

      // ----- inspector -----
      const revealedAt = st.revealed[client.id];
      const secretBlock = client.grantList.indexOf('client_credentials') >= 0 || client.type.indexOf('third') >= 0 || client.id === 'console'
        ? (client.id === 'console' ? UI.kv([['Client secret', esc(client.secret)]], 1)
          : (client.fresh && !revealedAt)
            ? '<div class="id-secret"><div class="hstack"><b>Secret shown once</b>' + UI.pill('copy now', 'warn') + '</div><div class="mono" style="overflow-wrap:anywhere">' + esc(client.secret) + '</div><div class="muted" style="font-size:12px">Copy it now. It cannot be shown again, only rotated.</div><div class="hstack gap6">' + UI.btn('Copy secret', { size: 'sm', kind: 'primary', attrs: 'data-copysecret' }) + UI.btn('Rotate secret', { size: 'sm', attrs: 'data-rotatesecret' }) + '</div></div>'
            : UI.kv([['Client secret', 'created ' + esc(revealedAt || client.secret.replace('created ', '')) + '<div style="margin-top:6px">' + UI.btn('Rotate secret', { size: 'sm', attrs: 'data-rotatesecret' }) + '</div>']], 1))
        : UI.kv([['Client secret', 'none, public client with PKCE']], 1);
      const insp = '<div class="eyebrow">' + esc(client.type) + '</div><div style="font-size:15px;font-weight:600">' + esc(client.name) + ' ' + UI.pill(client.status, client.status === 'active' ? 'ok' : 'outline') + '</div>'
        + UI.kv([['Client ID', '<span class="mono">' + esc(client.clientId) + '</span>'], ['Access token lifetime', esc(client.lifetime)], ['Refresh', esc(client.refresh)], ['Allowed models', esc(client.models)], ['Last used', esc(client.used)], ['Consent', esc(client.consent)]], 2)
        + '<div class="field"><span class="fl">Redirect URIs</span>' + (client.redirects.length ? client.redirects.map((r) => '<div class="mono" style="overflow-wrap:anywhere">' + esc(r) + '</div>').join('') : '<div class="muted">none</div>') + '</div>'
        + '<div class="field"><span class="fl">Grant types</span><div class="hstack wrap gap4">' + client.grantList.map((g) => UI.pill(g, 'outline')).join('') + '</div></div>'
        + '<div class="field"><span class="fl">Scopes</span><div class="mono">' + esc(client.scopes) + '</div></div>'
        + UI.toggle(client.grantList.indexOf('client_credentials') >= 0 ? 'PKCE not applicable to client credentials' : 'PKCE required', client.pkce, 'data-pkce' + (client.grantList.indexOf('client_credentials') >= 0 ? ' data-manual data-na style="opacity:.6"' : ''))
        + secretBlock
        + '<div class="divider"></div><div class="vstack gap6">' + UI.btn('Edit client', { size: 'sm', icon: 'edit', attrs: 'data-edit' }) + (client.type === 'service account' ? UI.btn('Open service account', { size: 'sm', kind: 'ghost', attrs: 'data-gotenants' }) : '') + (client.status === 'active' ? UI.btn('Disable client', { size: 'sm', kind: 'danger', attrs: 'data-disable' }) : '') + '</div>';

      root.innerHTML = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}.id-secret{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--warn-fg);border-radius:6px;background:var(--warn-bg)}.id-secret .muted{color:var(--warn-fg)}</style>'
        + '<div class="page">' + UI.pagehead('Identity and SSO', 'The identity service is the only token issuer', UI.btn('Test a login', { attrs: 'data-testlogin' }) + UI.btn('Create client', { kind: 'primary', icon: 'plus', attrs: 'data-create' }))
        + banner + tabs + body
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
        + '<aside class="inspector">' + insp + '</aside>';

      // ----- modals -----
      function rotateKey() {
        ctx.confirm({ title: 'Rotate signing key', tag: 'affects every client', tone: 'info', body: '<p style="margin:0" class="fg2">Generates a new ES256 key in OpenBao transit and publishes it to JWKS. It starts signing after the 14 day overlap; the current key stays listed for verification until then.</p>', kv: [['Current', esc(signing.kid)], ['New', 'k-2026-09'], ['Overlap', '14 days']], ok: 'Rotate' }).then((ok) => {
          if (!ok) return;
          st.keys = [{ kid: 'k-2026-09', alg: 'ES256', state: 'next, published', created: '19 Sep 2026', rotates: 'signs from 3 Oct 2026' }].concat(st.keys.map((k) => k.state === 'signing' ? Object.assign({}, k, { rotates: '3 Oct 2026, in 14 days' }) : k));
          st.keyExpiring = false; st.tab = 'keys'; ctx.rerender(); ctx.toast('k-2026-09 published to JWKS. It signs from 3 Oct; k-2026-07 verifies until then.', 'ok', 5000);
        });
      }
      function createClient() {
        ctx.modal({ title: 'Create client', cls: 'wide',
          body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-cname placeholder="Treasury dashboard"' })) + UI.field('Type', UI.select(['confidential, BFF', 'public', 'service account', 'third party'], 'third party', 'data-ctype')) + UI.field('Redirect URIs', UI.textarea('https://treasury.northwind.local/oauth/cb', { rows: 2, attrs: 'data-credir' }), 'One per line. Exact match; wildcards are refused.') + UI.field('Scopes', UI.input('chat:read chat:write', { attrs: 'data-cscopes' })) + '<div class="span2 hstack wrap gap12">' + UI.check('authorization code', true, 'data-g="authorization_code"') + UI.check('refresh token', true, 'data-g="refresh_token"') + UI.check('client credentials', false, 'data-g="client_credentials"') + UI.check('device authorization', false, 'data-g="device_code"') + UI.check('token exchange', false, 'data-g="token_exchange"') + '</div>' + '<div class="span2">' + UI.toggle('PKCE required', true, 'data-cpkce') + '</div></div>' + UI.notice('The client secret is shown once after creation. Third-party clients ask users for consent on first use.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create client', { kind: 'primary', attrs: 'data-cgo' }),
          onMount(m) { m.querySelector('[data-cgo]').addEventListener('click', () => { const name = m.querySelector('[data-cname]').value.trim() || 'New client'; const type = m.querySelector('[data-ctype]').value; const grants = Array.prototype.slice.call(m.querySelectorAll('[data-g]:checked')).map((i) => i.dataset.g); const id = 'c-' + Date.now(); App.closeOverlay(); st.clients.push({ id: id, name: name, type: type, grants: grants.join(', ').replace(/_/g, ' '), scopes: m.querySelector('[data-cscopes]').value, status: 'active', clientId: 'c_' + Math.random().toString(16).slice(2, 10), lifetime: '10 min', refresh: grants.indexOf('refresh_token') >= 0 ? '8 h, rotated on use' : 'none', models: 'per profile', used: 'never', pkce: m.querySelector('[data-cpkce]').classList.contains('on'), redirects: m.querySelector('[data-credir]').value.split('\n').map((s) => s.trim()).filter(Boolean), grantList: grants, secret: 'xs_live_' + Math.random().toString(36).slice(2, 12) + '...shown-once', created: '19 Sep 2026', consent: type === 'third party' ? 'user consent on first use' : 'pre-consented', fresh: type !== 'public' }); st.client = id; st.tab = 'clients'; ctx.rerender(); ctx.toast('Client ' + esc(name) + ' created. Copy the secret now.', 'ok', 5000); }); }
        });
      }
      function samlImport() {
        ctx.modal({ title: 'SAML metadata import', cls: 'wide',
          body: UI.field('Service provider metadata XML', UI.textarea('<EntityDescriptor entityID="https://treasury.northwind.local/saml">\n  <SPSSODescriptor>\n    <AssertionConsumerService Location="https://treasury.northwind.local/saml/acs" index="0"/>\n    <KeyDescriptor use="signing"><X509Certificate>MIIC...</X509Certificate></KeyDescriptor>\n  </SPSSODescriptor>\n</EntityDescriptor>', { rows: 6, attrs: 'data-xml' }), 'Paste the file contents or upload it. Nothing is fetched over the network.') + '<div id="saml-parsed"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Parse', { attrs: 'data-parse' }) + UI.btn('Save provider', { kind: 'primary', attrs: 'data-samlsave disabled' }),
          onMount(m) {
            const parse = () => { m.querySelector('#saml-parsed').innerHTML = '<div class="eyebrow">Parsed, review before saving</div>' + UI.kv([['Entity ID', '<span class="mono">https://treasury.northwind.local/saml</span>'], ['ACS URLs', '<span class="mono">https://treasury.northwind.local/saml/acs</span> (index 0, POST)'], ['Certificate', 'CN=treasury.northwind.local, expires 2 Feb 2028, SHA-256 3f:9a:…:c1'], ['NameID format', 'emailAddress'], ['Signed requests', 'yes'], ['Issuer', 'Exprsn-CA']], 2); m.querySelector('[data-samlsave]').removeAttribute('disabled'); };
            m.querySelector('[data-parse]').addEventListener('click', parse); parse();
            m.querySelector('[data-samlsave]').addEventListener('click', () => { App.closeOverlay(); st.saml.push({ name: 'Treasury', entity: 'https://treasury.northwind.local/saml', acs: 'https://treasury.northwind.local/saml/acs', nameid: 'emailAddress', cert: 'expires 2 Feb 2028', status: 'active' }); st.tab = 'saml'; ctx.rerender(); ctx.toast('Service provider Treasury saved. Assertions include groups and clearance.', 'ok'); });
          }
        });
      }
      function upstreamModal() {
        ctx.modal({ title: 'Add upstream provider',
          body: UI.notice('<b>Only on-prem identity providers can be added.</b> Cloud providers are unreachable from this network, so their discovery documents cannot be fetched.', 'info') + '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'AD FS, plant.northwind.local' })) + UI.field('Protocol', UI.select(['OIDC (we are RP)', 'SAML 2.0 (we are SP)'], 'OIDC (we are RP)')) + UI.field('Issuer or metadata', UI.input('https://', { attrs: 'data-uiss' }), 'Must resolve inside the directory zone or over a partner link.') + UI.field('Maps to tenant', UI.select(['Northwind', 'Contoso Freight'], 'Northwind')) + '</div><div id="up-check"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Check reachability', { attrs: 'data-ucheck' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-usave disabled' }),
          onMount(m) {
            m.querySelector('[data-ucheck]').addEventListener('click', () => { const v = m.querySelector('[data-uiss]').value; const cloud = /login\.microsoftonline|okta\.com|accounts\.google|auth0\.com|^https:\/\/$/.test(v); m.querySelector('#up-check').innerHTML = cloud ? UI.notice('<b>Unreachable.</b> ' + esc(v || 'that address') + ' is outside every zone. Add an on-prem provider instead.', 'danger') : UI.notice('Reachable from the directory zone. Discovery document fetched through the egress proxy.', 'ok'); if (!cloud) m.querySelector('[data-usave]').removeAttribute('disabled'); });
            m.querySelector('[data-usave]').addEventListener('click', () => { App.closeOverlay(); st.upstream.push({ name: m.querySelector('[data-uiss]').value.replace(/^https?:\/\//, ''), protocol: 'OIDC (we are RP)', reach: 'on-prem, directory zone', status: 'connected', used: 'not yet' }); ctx.rerender(); ctx.toast('Upstream provider saved.', 'ok'); });
          }
        });
      }
      function testLogin() {
        ctx.modal({ title: 'Test a login',
          body: '<div class="formgrid">' + UI.field('Method', UI.select(['Kerberos SPNEGO', 'LDAP password and TOTP', 'Device code'], 'Kerberos SPNEGO', 'data-tm')) + UI.field('As', UI.input('mokafor')) + '</div><div id="tl-out">' + UI.timeline([{ title: 'Ready', text: 'Runs the real flow against the identity service with a test audience. No session is created.' }]) + '</div>',
          actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Run', { kind: 'primary', attrs: 'data-tlrun' }),
          onMount(m) { m.querySelector('[data-tlrun]').addEventListener('click', () => { const method = m.querySelector('[data-tm]').value; const steps = method === 'Kerberos SPNEGO' ? [['401 Negotiate returned', 'ok'], ['SPNEGO token for HTTP/ai.northwind.local validated against the KDC', 'ok'], ['LDAP lookup: 6 groups, clearance confidential', 'ok'], ['Authorization code issued, PKCE verified', 'ok'], ['ID, access and refresh tokens minted with k-2026-07', 'ok']] : method === 'Device code' ? [['Device code WDJB-MJHT issued, expires in 15 min', 'ok'], ['Waiting for the user to approve at /device', 'warn']] : [['LDAPS bind as uid=mokafor,ou=people,ou=northwind', 'ok'], ['TOTP verified, skew 0 steps', 'ok'], ['LDAP lookup: 6 groups, clearance confidential', 'ok'], ['Tokens minted with k-2026-07', 'ok']]; let i = 0; const out = m.querySelector('#tl-out'); const draw = () => { out.innerHTML = UI.timeline(steps.slice(0, i + 1).map((s, j) => ({ title: s[0], tone: j < i ? s[1] : (j === steps.length - 1 ? s[1] : 'accent'), meta: j < i || j === steps.length - 1 ? (j * 38 + 42) + ' ms' : 'running' }))); if (++i < steps.length) setTimeout(draw, 350); }; draw(); }); }
        });
      }
      if (st.openCreate) { st.openCreate = false; setTimeout(createClient, 50); }
      if (st.openRotate) { st.openRotate = false; setTimeout(rotateKey, 50); }
      if (st.openSaml) { st.openSaml = false; setTimeout(samlImport, 50); }
      if (st.openUpstream) { st.openUpstream = false; setTimeout(upstreamModal, 50); }

      // ----- handlers -----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', 'tr[data-client]', (e, t) => { st.client = t.dataset.client; ctx.rerender(); });
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-q]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', '[data-create]', createClient);
      ctx.on('click', '[data-rotatekey]', rotateKey);
      ctx.on('click', '[data-saml]', samlImport);
      ctx.on('click', '[data-upstream]', upstreamModal);
      ctx.on('click', '[data-testlogin]', testLogin);
      ctx.on('click', '[data-samlenable]', (e, t) => { const s = st.saml[+t.dataset.samlenable]; ctx.confirm({ title: 'Enable ' + esc(s.name), tone: 'info', body: '<p class="fg2" style="margin:0">Its signing certificate expired on 1 Aug 2026. Upload fresh metadata first, or enable with signed requests off.</p>', ok: 'Enable anyway' }).then((ok) => { if (!ok) return; s.status = 'active'; s.cert = 'expired 1 Aug 2026, unsigned requests'; ctx.rerender(); ctx.toast(esc(s.name) + ' enabled. Audit event written.', 'warn'); }); });
      ctx.on('click', '[data-copysecret]', () => { st.revealed[client.id] = '19 Sep 2026, 13:51'; ctx.rerender(); ctx.toast('Secret copied. It is no longer shown here.', 'ok'); });
      ctx.on('click', '[data-rotatesecret]', () => ctx.confirm({ title: 'Rotate secret', tag: 'breaks running jobs', tone: 'danger', body: '<p class="fg2" style="margin:0">The current secret stops working immediately. Update ' + esc(client.name) + ' with the new one, which is shown once.</p>', kv: [['Client', esc(client.name)], ['Last used', esc(client.used)]], ok: 'Rotate' }).then((ok) => { if (!ok) return; client.secret = 'xs_live_' + Math.random().toString(36).slice(2, 12) + '...shown-once'; client.fresh = true; delete st.revealed[client.id]; ctx.rerender(); ctx.toast('Secret rotated. Copy it now.', 'ok'); }));
      ctx.on('click', '[data-pkce]', (e, t) => { if (t.hasAttribute('data-na')) return; client.pkce = !client.pkce; ctx.toast('PKCE ' + (client.pkce ? 'required' : 'optional') + ' for ' + esc(client.name) + '.'); });
      ctx.on('click', '[data-disable]', () => ctx.confirm({ title: 'Disable ' + esc(client.name), tag: 'revokes tokens', tone: 'danger', body: '<p class="fg2" style="margin:0">Every access and refresh token for this client is revoked. Users see a sign-in prompt on their next request.</p>', ok: 'Disable' }).then((ok) => { if (!ok) return; client.status = 'disabled'; ctx.rerender(); ctx.toast(esc(client.name) + ' disabled. Tokens revoked; audit event written.', 'warn'); }));
      ctx.on('click', '[data-edit]', () => ctx.modal({ title: 'Edit ' + esc(client.name), body: '<div class="formgrid">' + UI.field('Access token lifetime', UI.select(['5 min', '10 min', '30 min'], client.lifetime)) + UI.field('Allowed models', UI.input(client.models)) + UI.field('Scopes', UI.input(client.scopes, { attrs: 'data-escopes' })) + UI.field('Redirect URIs', UI.textarea(client.redirects.join('\n'), { rows: 2 })) + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-esave' }), onMount(m) { m.querySelector('[data-esave]').addEventListener('click', () => { client.scopes = m.querySelector('[data-escopes]').value; App.closeOverlay(); ctx.rerender(); ctx.toast('Client saved. Existing tokens keep their scopes until they expire.', 'ok'); }); } }));
      ctx.on('click', '[data-revoke]', (e, t) => { const u = t.dataset.revoke; ctx.confirm({ title: 'Revoke session', tag: 'signs out', tone: 'danger', body: '<p class="fg2" style="margin:0">Ends the session and its refresh tokens now.</p>', kv: [['User', esc(u)]], ok: 'Revoke' }).then((ok) => { if (!ok) return; st.revoked[u] = true; ctx.rerender(); ctx.toast('Session for ' + esc(u) + ' revoked.', 'ok'); }); });
      ctx.on('click', '[data-gotenants]', () => ctx.navigate('tenants', { workspace: 'finance-ops', tab: client.type === 'service account' ? 'services' : 'sessions' }));
      ctx.on('click', '[data-gozones]', () => ctx.navigate('zones', { zone: 'directory' }));
      ctx.on('click', '[data-goplatform]', () => ctx.navigate('platform', { tab: 'secrets' }));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
