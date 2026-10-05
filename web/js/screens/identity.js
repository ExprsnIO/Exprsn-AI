(function () {
  const { UI, esc } = App;

  const TYPES = ['confidential, BFF', 'public', 'service account', 'third party'];
  const GRANT_TEXT = { authorization_code: 'authorization code and PKCE', refresh_token: 'refresh', client_credentials: 'client credentials', 'urn:ietf:params:oauth:grant-type:device_code': 'device authorization', 'urn:ietf:params:oauth:grant-type:token-exchange': 'token exchange' };
  const GRANT_SHORT = { authorization_code: 'authorization_code', refresh_token: 'refresh_token', client_credentials: 'client_credentials', device_code: 'urn:ietf:params:oauth:grant-type:device_code', token_exchange: 'urn:ietf:params:oauth:grant-type:token-exchange' };
  const NAMEID = { emailAddress: 'emailAddress', persistent: 'persistent', unspecified: 'unspecified', transient: 'transient' };
  const DAY = 86400000;
  const date = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const when = (ms) => {
    if (!ms) return 'never';
    const d = Date.now() - ms;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.round(d / 60000) + ' min ago';
    if (d < DAY && new Date(ms).getDate() === new Date().getDate()) return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + ' today';
    if (d < 2 * DAY) return 'yesterday ' + new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return date(ms);
  };
  const inDays = (ms) => { const n = Math.round((ms - Date.now()) / DAY); return n > 1 ? 'in ' + n + ' days' : n === 1 ? 'tomorrow' : n === 0 ? 'today' : Math.abs(n) + ' days ago'; };
  const grantsText = (c) => c.grants.filter((g) => g !== 'refresh_token').map((g) => GRANT_TEXT[g] || g).join(', ') + (c.grants.indexOf('refresh_token') >= 0 ? ', refresh' : '');
  const certText = (cert) => (!cert ? 'none' : (cert.expired ? 'expired ' : 'expires ') + date(cert.validTo));
  const stepsHtml = (steps) => UI.timeline(steps.map((s) => ({ title: esc(s.title), text: s.detail ? esc(s.detail) : '', meta: s.ms != null ? s.ms + ' ms' : '', tone: s.ok ? 'ok' : 'danger' })));
  // 1.4.0 identity additions (B-3413): the tenant's sign-up and MFA policy, sign-ups, invitations, CSV imports, DIDs.
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const SIGNUP_ROLES = ['member', 'flag-reviewer', 'knowledge-curator'];
  const MFA_ROLES = ['member', 'knowledge-curator', 'flag-reviewer', 'connection-admin'];
  const CSV_HEADER = 'kind,username,display_name,email,roles,clearance,workspace,provider,group';
  const SAMPLE_CSV = CSV_HEADER + '\nuser,dokonkwo,Dami Okonkwo,d.okonkwo@example.internal,member;flag-reviewer,confidential,,,\nmembership,dokonkwo,,,,,finance-ops,,\nmapping,,,,knowledge-curator,internal,,OpenLDAP,cn=kb-curators\nuser,tweber,Tomasz Weber,t.weber@example.internal,member,internal,,,';
  const stamp = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const problemText = (err) => { const p = (err && err.problem) || {}; return '<b>' + esc(p.title || 'Not done') + '.</b> ' + esc(p.detail || (err && err.message) || '') + (p.errors ? ' ' + esc(p.errors.map((x) => x.path + ': ' + x.message).join('; ')) : ''); };
  /** CSV imports go up as text/csv (App.api always sends JSON), with the session's CSRF token. */
  const postCsv = async (csv, dryRun, sendInvites) => {
    let res;
    try { res = await fetch('/api/admin/user-imports?dryRun=' + (dryRun ? 'true' : 'false') + '&sendInvites=' + (sendInvites ? 'true' : 'false'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'text/csv', Accept: 'application/json', 'X-CSRF-Token': App.state.csrf || '' }, body: csv }); }
    catch (e) { throw new App.ApiError({ status: 0, title: 'Network error', detail: 'The server could not be reached.' }); }
    const data = /json/.test(res.headers.get('content-type') || '') ? await res.json() : null;
    if (!res.ok) throw new App.ApiError(data || { status: res.status, title: res.statusText });
    return data;
  };
  const copy = (text, what, ctx) => { if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => ctx.toast(esc(what) + ' copied.', 'ok'), () => ctx.toast('Copy failed; select the text instead.', 'warn')); else ctx.toast('Copy is not available here; select the text instead.', 'warn'); };

  App.register({
    id: 'identity', title: 'Identity', section: 'admin', live: true, summary: 'OIDC clients, SAML providers, scopes and consent, signing keys, user stores (GitHub, AT-Protocol), sign-up and MFA policy, invitations, CSV imports, DID bindings',
    crumb: ['Admin', 'Identity'],
    commands: [
      { label: 'Invite someone', sub: 'Identity', run(app) { const s = app.stateFor('identity'); s.tab = 'policy'; s.policyView = 'invitations'; s.openInvite = true; app.render(); } },
      { label: 'Create an OIDC client', sub: 'Identity', run(app) { app.stateFor('identity').openCreate = true; app.render(); } },
      { label: 'Rotate the signing key', sub: 'Identity', run(app) { app.stateFor('identity').tab = 'keys'; app.stateFor('identity').openRotate = true; app.render(); } }
    ],
    states: [
      { title: 'After the reveal', tone: 'neutral', text: 'The secret field shows only its creation date and a rotate action.', apply(ctx) { const st = ctx.state; st.tab = 'clients'; const c = (st.clients || []).find((x) => x.confidential); if (c) { st.client = c.id; delete st.fresh[c.id]; } ctx.rerender(); } },
      { title: 'Key nearing expiry', tone: 'warn', text: '14 days before rotation a banner appears. The new key is published to JWKS before it signs.', apply(ctx) { ctx.state.tab = 'keys'; ctx.state.keyExpiring = true; ctx.rerender(); } },
      { title: 'Upstream federation', tone: 'info', text: 'Only on-prem identity providers can be added. Cloud providers are unreachable from this network.', apply(ctx) { ctx.state.tab = 'upstream'; ctx.state.openUpstream = true; ctx.rerender(); } },
      { title: 'Sign-up pending approval', tone: 'warn', text: 'With the approval mode, a new account is created disabled and identity admins get a notice. Approve activates it; reject keeps it disabled and tells the user by email.', apply(ctx) { ctx.state.tab = 'policy'; ctx.state.policyView = 'signups'; ctx.state.signupFilter = 'pending'; ctx.rerender(); } },
      { title: 'MFA grace restarted', tone: 'info', text: 'Widening the MFA requirement restarts the grace period: covered accounts sign in without a factor for graceDays, then enrol first. Audited with graceRestarted.', apply(ctx) { ctx.state.tab = 'policy'; ctx.state.policyView = 'policy'; ctx.state.graceRestarted = true; ctx.rerender(); } },
      { title: 'Import dry run with conflicts', tone: 'warn', text: 'A dry run plans and reports every row; conflicts (an account linked to another store, a reused address) and errors (a role the importer may not grant) change nothing.', apply(ctx) { const st = ctx.state; st.tab = 'imports'; const x = (st.imports || []).find((i) => i.dryRun && i.summary && (i.summary.conflict || i.summary.error)) || (st.imports || []).find((i) => i.dryRun); if (x) st.importSel = x.id; ctx.rerender(); } },
      { title: 'SAML metadata import', tone: 'neutral', text: 'Parsed entity ID, ACS URLs and certificate are shown for review before saving.', apply(ctx) { ctx.state.tab = 'saml'; ctx.state.openSaml = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'clients'; st.fresh = st.fresh || {}; st.q = st.q || '';
      st.policyView = st.policyView || 'policy'; st.signupFilter = st.signupFilter || 'pending'; st.csvs = st.csvs || {}; st.importDetail = st.importDetail || {};
      if (ctx.params.tab) st.tab = ctx.params.tab;

      const load = () => {
        if (st.loading) return;
        st.loading = true;
        // B-3413: the identity additions load with the rest; each needs its own permission, and one that fails or is
        // not held leaves its tab saying so instead of failing the screen.
        const extraErr = {};
        const opt = (perm, key, url) => (App.can(perm) ? App.get(url).catch((err) => { extraErr[key] = err; return null; }) : Promise.resolve(null));
        Promise.all([App.get('/api/admin/federation'), App.get('/api/admin/federation/oidc/clients'), App.get('/api/admin/federation/saml/sps'), App.get('/api/admin/federation/upstream'), App.get('/api/admin/federation/sessions'), App.get('/api/admin/federation/scopes'), App.get('/api/admin/federation/keys'), App.get('/api/admin/federation/proposals?state=pending'), App.get('/api/admin/federation/metadata'),
          opt('identity:manage', 'policy', '/api/admin/identity-policy'), opt('users:manage', 'signups', '/api/admin/signups'), opt('members:invite', 'invites', '/api/invitations'), opt('users:manage', 'imports', '/api/admin/user-imports'), opt('identity:manage', 'dids', '/api/admin/atproto/accounts'), opt('identity:manage', 'stores', '/api/admin/identity-providers'), opt('users:manage', 'roles', '/api/admin/roles'), opt('users:manage', 'people', '/api/admin/users?limit=500')])
          .then(([overview, clients, sps, upstream, sessions, scopes, keys, proposals, sources, policy, signups, invites, imports, dids, stores, roles, people]) => {
            Object.assign(st, { overview, clients, sps, upstream, sessions, scopes, jwks: keys.jwks, proposals, sources, policy, signups, invites, imports, dids, stores, roles, people, extraErr, loaded: true, loadError: null });
            st.draft = policy ? clone(policy) : null;
          })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; if (App.state.route === 'identity' && !document.querySelector('.modal')) ctx.rerender(); });
      };
      if (!st.loaded && !st.loadError) load();
      const reload = () => { st.loaded = false; st.loadError = null; load(); };

      if (st.loadError) { root.innerHTML = '<div class="page">' + UI.pagehead('Identity and SSO', 'The identity service is the only token issuer', '') + UI.problem('Identity settings could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-retry' }) + '</div></div>'; ctx.on('click', '[data-retry]', () => { st.loadError = null; ctx.rerender(); }); return; }
      if (!st.loaded) { root.innerHTML = '<div class="page">' + UI.pagehead('Identity and SSO', 'The identity service is the only token issuer', '') + UI.notice('Loading…', 'info') + '</div>'; return; }

      const ov = st.overview;
      const clients = st.clients;
      if (ctx.params.client) { const c = clients.find((x) => x.name === ctx.params.client || x.clientId === ctx.params.client || x.id === ctx.params.client); if (c) { st.client = c.id; st.tab = 'clients'; } }
      const client = clients.find((c) => c.id === st.client) || clients[0] || null;
      const keys = ov.keys;
      const signing = keys.find((k) => k.state === 'signing') || keys[0];
      const nextKey = keys.find((k) => k.state === 'next, published');
      const rotatesAt = ov.rotation.rotatesAt;
      const nearing = st.keyExpiring || (!nextKey && rotatesAt && rotatesAt - Date.now() < 14 * DAY);

      const tabs = UI.tabs([{ id: 'clients', label: 'OIDC clients', count: clients.length }, { id: 'saml', label: 'SAML service providers', count: st.sps.length }, { id: 'scopes', label: 'Scopes and consent' }, { id: 'keys', label: 'Keys' }, { id: 'upstream', label: 'User stores and federation' }, { id: 'policy', label: 'Sign-up and MFA policy', count: st.signups ? st.signups.filter((x) => x.state === 'pending').length : undefined }, { id: 'imports', label: 'CSV imports' }, { id: 'dids', label: 'AT-Protocol accounts' }, { id: 'sessions', label: 'Sessions' }], st.tab);
      const banner = nearing && signing ? UI.notice('<b>Signing key ' + esc(signing.kid) + ' rotates ' + esc(rotatesAt ? inDays(rotatesAt) : 'soon') + '.</b> Rotate now to generate the next key and publish it to JWKS, so relying parties cache it before it signs anything.', 'warn', UI.btn('Rotate now', { size: 'sm', attrs: 'data-rotatekey' })) : '';

      function keysTable(compact) {
        return UI.table(['Key ID', 'Algorithm', 'State', 'Created', 'Rotates'], keys.map((k) => ['<span class="mono">' + esc(k.kid) + '</span>', esc(k.alg), UI.pill(k.state, k.state === 'signing' ? 'ok' : k.state === 'next, published' ? 'info' : 'outline'),
          esc(date(k.createdAt)),
          (k.state === 'signing' ? (k.retiresAt ? esc(date(k.retiresAt) + ', ' + inDays(k.retiresAt)) : '') : k.state === 'next, published' ? 'signs from ' + esc(date(k.activatesAt)) : 'removed ' + esc(date(k.removesAt))) + (nearing && k.state === 'signing' && k.retiresAt ? ' ' + UI.pill(inDays(k.retiresAt), 'warn') : '')]), { clickable: false, minWidth: compact ? '520px' : '600px', emptyTitle: 'No keys yet', emptyText: 'The first key is created when a token is signed.' });
      }

      // Sprint 17: changes waiting for approval (introspection rights under dual control, fetched metadata changes).
      const proposals = st.proposals || [];
      const pendingPanel = proposals.length ? UI.panel('Waiting for approval', UI.table(['Change', 'What changes', 'Proposed', { label: '', right: true }], proposals.map((x) => ({ cells: ['<b>' + esc(x.name) + '</b><div class="muted" style="font-size:11px">' + esc(x.kind === 'client.introspect' ? 'introspection rights' : 'fetched metadata') + '</div>', '<span style="overflow-wrap:anywhere">' + esc(x.summary || '') + '</span>', esc(x.mine ? 'by you, ' : x.proposedBy ? 'by another admin, ' : 'by the metadata refresh, ') + esc(when(x.proposedAt)),
        '<span class="hstack gap4" style="justify-content:flex-end">' + (x.mine ? UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-propwithdraw="' + esc(x.id) + '" aria-label="Withdraw ' + esc(x.name) + '"' }) : UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-propapprove="' + esc(x.id) + '" aria-label="Approve ' + esc(x.name) + '"' }) + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-propreject="' + esc(x.id) + '" aria-label="Reject ' + esc(x.name) + '"' })) + '</span>'] })), { clickable: false, cls: 'bare', minWidth: '0' })
        + '<div class="muted" style="font-size:12px">A change an identity admin proposed needs a second identity admin. A certificate or endpoint change found in fetched metadata waits for any identity admin; until then the current values stay in force.</div>') : '';
      const sources = st.sources || [];
      const sourceOf = (id) => sources.find((x) => x.id === id) || null;
      const sourceCell = (id) => { const m = sourceOf(id); return m ? '<span class="mono" style="overflow-wrap:anywhere;font-size:11px">' + esc(m.url) + '</span><div class="muted" style="font-size:11px">' + (m.error ? 'last fetch failed: ' + esc(m.error) : 'fetched ' + esc(when(m.fetchedAt))) + '</div>' + UI.btn('Fetch now', { size: 'xs', kind: 'ghost', attrs: 'data-metarefresh="' + esc(id) + '"' }) : '<span class="muted">pasted</span>'; };

      const myWorkspaces = (App.me && App.me.workspaces) || [];
      const myClearance = (App.me && App.me.user.clearance) || 'internal';
      const wsName = (id) => (!id ? 'none' : (myWorkspaces.find((w) => w.id === id) || { name: id }).name);
      const who = (id) => { if (!id) return 'system'; if (App.me && id === App.me.user.id) return 'you'; const u = (st.people || []).find((x) => x.id === id); return u ? u.displayName : id; };

      let body = '';
      if (st.tab === 'clients') {
        const rows = clients.filter((c) => !st.q || (c.name + ' ' + c.typeLabel + ' ' + c.scopes.join(' ')).toLowerCase().includes(st.q.toLowerCase()));
        body = '<div class="hstack wrap">' + UI.search('Search clients', 'data-q', st.q) + '<span class="muted" style="font-size:12px">Every token comes from this issuer: <span class="mono">' + esc(ov.issuer) + '</span>. Browsers hold only a session cookie.</span></div>'
          + UI.table(['Client', 'Type', 'Grants', 'Scopes', 'Status'], rows.map((c) => ({ cells: ['<b>' + esc(c.name) + '</b>', esc(c.typeLabel), esc(grantsText(c)), '<span class="mono">' + esc(c.scopes.join(' ')) + '</span>', UI.pill(c.status, c.status === 'active' ? 'ok' : 'warn')], attrs: 'data-client="' + esc(c.id) + '"', selected: client && c.id === client.id })), { minWidth: '700px', emptyTitle: clients.length ? 'No clients match' : 'No clients yet', emptyText: clients.length ? 'Clear the search or create a client.' : 'Create a client for each application that signs users in or calls the API.' })
          + '<div class="eyebrow">Signing keys, ' + ov.rotation.days + ' day rotation</div>' + keysTable(true)
          + UI.panel('Delivered', UI.kv([['Grants', 'Code and PKCE, client credentials, refresh rotation, device authorization, token exchange'], ['Protocols', 'OIDC provider, SAML IdP, Kerberos SPNEGO, upstream OIDC and SAML'], ['Also', 'DPoP-bound tokens, pushed and signed requests, introspection, RP-initiated, front- and back-channel logout']], 3));
      } else if (st.tab === 'saml') {
        body = '<div class="hstack"><span class="fg2">Applications that only speak SAML get assertions from the same tenant, with the same groups and clearance claims.</span><span class="right">' + UI.btn('Import metadata', { size: 'sm', icon: 'upload', attrs: 'data-saml' }) + '</span></div>'
          + UI.table(['Service provider', 'Entity ID', 'ACS URL', 'NameID', 'Certificate', 'Single logout', 'Encryption', 'Signature', 'Metadata', 'Status', ''], st.sps.map((s) => ['<b>' + esc(s.name) + '</b>', '<span class="mono">' + esc(s.entityId) + '</span>', '<span class="mono">' + esc((s.acsUrls[0] || {}).url || '') + '</span>', esc(NAMEID[s.nameIdFormat] || s.nameIdFormat), esc(certText(s.cert)) + (s.status === 'active' && !s.signedRequests && s.cert && s.cert.expired ? ', unsigned requests' : ''),
            s.sloUrl ? esc(s.sloBinding === 'redirect' ? 'redirect binding' : 'POST binding') : '<span class="muted">none</span>',
            s.encryptionCert ? (s.encryptAssertions ? UI.pill('encrypted', 'ok') : UI.pill('signed only', 'outline')) + ' ' + UI.btn(s.encryptAssertions ? 'Stop encrypting' : 'Encrypt', { size: 'xs', kind: 'ghost', attrs: 'data-samlenc="' + esc(s.id) + '" aria-label="' + (s.encryptAssertions ? 'Stop encrypting assertions for ' : 'Encrypt assertions for ') + esc(s.name) + '"' }) : '<span class="muted">no encryption certificate</span>',
            (s.signResponse ? UI.pill('whole response', 'ok') : UI.pill('assertion', 'outline')) + ' ' + UI.btn(s.signResponse ? 'Assertion only' : 'Sign response', { size: 'xs', kind: 'ghost', attrs: 'data-samlsignresp="' + esc(s.id) + '" aria-label="' + (s.signResponse ? 'Sign only the assertion for ' : 'Sign the whole response for ') + esc(s.name) + '"' }),
            sourceCell(s.id),
            UI.pill(s.status, s.status === 'active' ? 'ok' : 'warn'), s.status === 'disabled' ? UI.btn('Enable', { size: 'xs', attrs: 'data-samlenable="' + esc(s.id) + '"' }) : UI.btn('Download IdP metadata', { size: 'xs', kind: 'ghost', attrs: 'data-idpmeta' })]), { clickable: false, minWidth: '1280px', emptyTitle: 'No service providers', emptyText: 'Import an application\'s SAML metadata to add it.' })
          + UI.notice('The IdP entity ID is <span class="mono">' + esc(ov.idp.entityId) + '</span>. Assertions are signed with the IdP certificate (RSA-SHA256' + (ov.idp.certificate && ov.idp.certificate.validTo ? ', expires ' + esc(date(ov.idp.certificate.validTo)) : '') + ') and expire after ' + ov.idp.assertionMinutes + ' minutes. For a service provider with an encryption certificate they are also encrypted (AES-256-GCM, RSA-OAEP). Single logout: <span class="mono">' + esc(ov.idp.sloUrl) + '</span>; logout requests must be signed.', 'info');
      } else if (st.tab === 'scopes') {
        const c = ov.settings.consent;
        body = UI.table(['Scope', 'Grants', 'Consent'], st.scopes.map((s) => ['<span class="mono">' + esc(s.scopes.join(', ')) + '</span>', esc(s.grants), esc(s.consent)]), { clickable: false, minWidth: '640px' })
          + '<div class="grid2">' + UI.panel('Consent policy', UI.toggle('First-party clients are pre-consented', c.firstPartyPreconsented, 'data-manual data-consent="firstPartyPreconsented"') + UI.toggle('Third-party clients ask on first use', c.thirdPartyAsk, 'data-manual data-consent="thirdPartyAsk"') + UI.toggle('Remember consent for 90 days', c.remember, 'data-manual data-consent="remember"') + '<div class="muted" style="font-size:12px">Effective permission is client scopes intersected with role permissions, then clearance and zone. Scopes never widen a role.</div>')
          + UI.panel('Token shape', UI.kv([['Access token', 'JWT, ES256, 5 to 30 min per client, audience-bound'], ['Refresh token', 'opaque, rotated on every use; reuse revokes the grant (RFC 9700)'], ['Agent delegation', 'token exchange with an act claim (RFC 8693)'], ['High assurance', 'PKCE required for public clients; DPoP-bound tokens (RFC 9449), pushed requests (RFC 9126) and signed request objects (RFC 9101) per client'], ['Revocation', 'RFC 7009 at /oauth/revoke, access tokens included (a deny-list checked on every call); RFC 7662 introspection; client disable, session revoke and a user removing access end grants'], ['Logout', 'RP-initiated at /oauth/logout, front-channel frames and back-channel logout tokens']], 1)) + '</div>';
      } else if (st.tab === 'keys') {
        body = '<div class="hstack"><span class="eyebrow">Signing keys, ' + ov.rotation.days + ' day rotation</span><span class="right hstack gap6">' + UI.btn('Copy JWKS URL', { size: 'sm', kind: 'ghost', attrs: 'data-idcopy="' + esc(ov.jwksUrl) + '" data-what="JWKS URL"' }) + UI.btn('Rotate signing key', { size: 'sm', kind: 'primary', icon: 'key', attrs: 'data-rotatekey' }) + '</span></div>' + keysTable(false)
          + '<div class="grid2">' + UI.panel('JWKS preview', '<div class="fg2" style="font-size:12px">Served at <span class="mono">' + esc(ov.jwksUrl) + '</span>. The overlap key stays listed until every token it signed has expired.</div>' + UI.code(JSON.stringify(st.jwks, null, 2), 'json'))
          + UI.panel('Where keys live', UI.kv([['Store', ov.signingInKms ? 'Held in ' + esc(ov.keyStore) + '; tokens and assertions are signed there, so private keys never enter this server' : 'Sealed with the platform data key (' + esc(ov.keyStore) + '); never leave the server'], ['Algorithm', 'ES256 (P-256) for OIDC; RSA-2048 for the SAML certificate'], ['Rotation', 'every ' + ov.rotation.days + ' days with a ' + ov.rotation.overlapDays + ' day overlap window'], ['Discovery', '<span class="mono">' + esc(ov.discoveryUrl) + '</span>'], ['Data keys', 'per-tenant envelope keys in the same KMS']], 1) + '<div>' + UI.btn('Open secrets health', { size: 'sm', attrs: 'data-goplatform' }) + '</div>') + '</div>';
      } else if (st.tab === 'upstream') {
        const k = ov.kerberos;
        // 1.4.0: GitHub (B-1804) and AT-Protocol (B-1808) user stores sit in the same chain; their settings live in User stores.
        const atStores = (st.stores || []).filter((p) => p.kind === 'atproto').map((p) => ({ id: p.id, name: p.name, protocol: 'atproto', protocolLabel: 'atproto', reach: 'any PDS the service URL checks allow', status: p.enabled ? 'connected' : 'disabled', usedBy: (st.dids || []).filter((d) => d.verified).length + ' bound users', store: true }));
        const upRows = st.upstream.concat(atStores);
        body = '<div class="hstack wrap"><span class="fg2">Optional federation: this issuer acts as OIDC relying party or SAML service provider to an on-prem identity provider.</span><span class="right hstack gap6">' + UI.btn('Add GitHub or AT-Protocol store', { size: 'sm', kind: 'ghost', attrs: 'data-addstore' }) + UI.btn('Add upstream provider', { size: 'sm', icon: 'plus', attrs: 'data-upstream' }) + '</span></div>'
          + UI.table(['Provider', 'Protocol', 'Reachability', 'Status', 'Used by', 'Metadata', ''], upRows.map((u) => ['<b>' + esc(u.name) + '</b>', /^(github|atproto)$/.test(u.protocol) ? UI.pill(u.protocol, 'outline') : esc(u.protocolLabel), esc(u.reach), UI.pill(u.status, u.status === 'connected' ? 'ok' : u.status === 'disabled' ? '' : 'danger'), esc(u.usedBy), u.protocol === 'saml' ? sourceCell(u.id) : u.protocol === 'oidc' ? '<span class="muted">discovery</span>' : '<span class="muted">none</span>', /^(github|atproto)$/.test(u.protocol) && (st.stores || []).some((p) => p.id === u.id) ? UI.btn('Settings', { size: 'xs', kind: 'ghost', attrs: 'data-storedetail="' + esc(u.id) + '" aria-label="Settings of ' + esc(u.name) + '"' }) : '']), { clickable: false, minWidth: '720px', emptyTitle: 'No upstream providers', emptyText: 'Users sign in with the user stores. Add an on-prem OIDC or SAML provider, a GitHub or an AT-Protocol store to federate.' })
          + UI.notice('Since 1.4.0 the chain also takes a <b>GitHub</b> store (OAuth app, allowed organisations, verified primary address only) and an <b>AT-Protocol</b> store (a bound DID signs in as its user; others are provisioned just in time with the handle as username and the DID as their only group). Both pass the service URL checks when saved and at every connection.', 'info')
          + '<div class="grid2">' + UI.panel('Primary authentication', UI.kv([['Kerberos SPNEGO', k.available && k.enabled ? esc(k.detail) + (k.realms.length ? ', realms ' + esc(k.realms.join(', ')) : ', any realm') : k.enabled ? 'not available: ' + esc(k.detail) : 'turned off for this tenant'], ['LDAP bind', 'LDAPS or StartTLS to the directory; never a clear bind'], ['Second factor', 'WebAuthn passkeys and TOTP, required for admin roles, also after Kerberos and upstream sign-in'], ['Device flow', 'RFC 8628 at <span class="mono">' + esc(ov.device.verificationUri) + '</span>, codes live ' + ov.device.minutes + ' min'], ['Fallback order', 'Kerberos, then upstream or password, then MFA']], 1) + '<div>' + UI.btn('Test a login', { size: 'sm', attrs: 'data-testlogin' }) + '</div>')
          + UI.panel('Air gap', UI.notice('Cloud identity providers are unreachable from this network. Only on-prem providers on internal addresses' + (ov.upstream.allowList ? ', or hosts on the allow-list (' + esc(ov.upstream.allowList) + '),' : '') + ' can be upstream.', 'info') + UI.kv([['OIDC redirect URI', '<span class="mono">' + esc(ov.upstream.redirectUri) + '</span>'], ['SAML ACS URL', '<span class="mono">' + esc(ov.upstream.acsUrl) + '</span>'], ['SAML single logout', '<span class="mono">' + esc(ov.upstream.sloUrl) + '</span>']], 1) + '<div>' + UI.btn('Open zones', { size: 'sm', kind: 'ghost', attrs: 'data-gozones' }) + '</div>') + '</div>';
      } else if (st.tab === 'policy') {
        const pendingN = st.signups ? st.signups.filter((x) => x.state === 'pending').length : 0;
        body = UI.seg([{ id: 'policy', label: 'Policy' }, { id: 'signups', label: 'Sign-ups (' + pendingN + ' pending)' }, { id: 'invitations', label: 'Invitations' }], st.policyView, 'data-policyseg aria-label="Sign-up and MFA policy"');
        if (st.policyView === 'policy') {
          const pol = st.draft;
          if (!pol) body += st.extraErr.policy ? UI.problem('The identity policy could not be loaded', st.extraErr.policy.message, st.extraErr.policy.problem && st.extraErr.policy.problem.trace_id) : UI.notice('Changing the sign-up and MFA policy needs the identity:manage permission.', 'info');
          else {
            const wsOpts = [{ value: '', label: 'none' }].concat(myWorkspaces.map((w) => ({ value: w.id, label: w.name })));
            if (pol.signup.workspaceId && !myWorkspaces.some((w) => w.id === pol.signup.workspaceId)) wsOpts.push({ value: pol.signup.workspaceId, label: pol.signup.workspaceId });
            const mfaRoles = MFA_ROLES.concat(pol.mfa.roles.filter((r) => MFA_ROLES.indexOf(r) < 0));
            const roleLabel = (id) => ((st.roles || []).find((r) => r.id === id) || { name: id }).name;
            const effective = st.policy.mfa.effectiveAt;
            body += (st.graceRestarted ? UI.notice('<b>MFA requirement widened; the grace period restarted.</b> Accounts it now covers may sign in without a factor' + (st.policy.mfa.graceDays && effective ? ' until ' + esc(date(effective + st.policy.mfa.graceDays * DAY)) : ' for the grace period') + ', then enrol first. Audited identity.mfa_policy.updated with graceRestarted.', 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-gracedone' })) : '')
              + (st.policyDirty ? UI.notice('Unsaved changes. Save the policy to apply them.', 'warn') : '')
              + '<div class="grid2">' + UI.panel('Self-registration (B-1801, B-1802)', '<div class="formgrid">' + UI.field('Mode', UI.select([{ value: 'closed', label: 'closed (default)' }, { value: 'open', label: 'open' }, { value: 'approval', label: 'open with approval' }], pol.signup.mode, 'data-pol="signup.mode"'))
                + UI.field('Default workspace', UI.select(wsOpts, pol.signup.workspaceId || '', 'data-pol="signup.workspaceId"'))
                + UI.field('Allowed email domains', UI.textarea(pol.signup.domains.join('\n'), { rows: 2, attrs: 'data-pol="signup.domains"', placeholder: 'example.com' }), 'One per line; *.example.com covers subdomains; empty allows any. Up to 200.')
                + UI.field('Default roles', '<div class="hstack wrap gap12" style="row-gap:12px">' + SIGNUP_ROLES.map((r) => UI.check(roleLabel(r), pol.signup.roles.indexOf(r) >= 0, 'data-polrole="' + r + '"')).join('') + '</div>', 'Only these three roles may be granted at sign-up.')
                + UI.field('Default clearance', UI.select(LABELS.filter((l) => LABELS.indexOf(l) <= LABELS.indexOf(myClearance)), pol.signup.clearance, 'data-pol="signup.clearance"'), 'At most yours (' + esc(myClearance) + ').') + '</div>'
                + UI.toggle('Require a verified email address for local accounts', pol.signup.requireEmailVerification, 'data-manual data-polverify')
                + '<div class="muted" style="font-size:12px">Also covers other local accounts with an unproven address; accounts created by an admin, imported or from an invitation count as proven. Public: <span class="mono">POST /api/auth/register</span>, throttled per address and per email.</div>')
              + UI.panel('Second factor policy and trusted devices (B-1803)', '<div class="formgrid">' + UI.field('Require a second factor', UI.select([{ value: 'off', label: 'off (only roles that always need one)' }, { value: 'all', label: 'everyone' }, { value: 'roles', label: 'listed roles' }], pol.mfa.require, 'data-pol="mfa.require"'))
                + UI.field('Grace period, days', UI.input(pol.mfa.graceDays, { type: 'number', attrs: 'data-pol="mfa.graceDays" min="0" max="90"' }), 'After the requirement last widened, or the account\'s creation if later.')
                + UI.field('Roles', '<div class="hstack wrap gap12" style="row-gap:12px">' + mfaRoles.map((r) => UI.check(roleLabel(r), pol.mfa.roles.indexOf(r) >= 0, 'data-polmfarole="' + esc(r) + '"' + (pol.mfa.require !== 'roles' ? ' disabled' : ''))).join('') + '</div>', 'Admin roles always need one; these are added to them.')
                + UI.field('Trusted device period, days', UI.input(pol.mfa.trustedDeviceDays, { type: 'number', attrs: 'data-pol="mfa.trustedDeviceDays" min="0" max="90"' }), '0 to 90. 0 allows no trusted devices; shortening it ends older trust at once.') + '</div>'
                + UI.kv([['Effective', effective ? esc(stamp(effective)) : 'no requirement beyond admin roles'], ['Last change', st.policy.updatedAt ? esc(who(st.policy.updatedBy)) + ', ' + esc(stamp(st.policy.updatedAt)) : 'never changed, defaults'], ['Email codes', 'allowed as the second factor for admin roles (Sprint 28 decision; docs/security.md known gap)']], 1)) + '</div>'
              + '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">Saving audits identity.signup_policy.updated and identity.mfa_policy.updated. Upstream (OIDC, SAML, GitHub, AT-Protocol) and Kerberos sign-ins follow the same MFA policy.</span>' + (st.policyDirty ? UI.btn('Discard changes', { kind: 'ghost', size: 'sm', attrs: 'data-discardpolicy' }) : '') + UI.btn('Save policy', { kind: 'primary', size: 'sm', attrs: 'data-savepolicy' }) + '</div>';
          }
        } else if (st.policyView === 'signups') {
          if (!st.signups) body += st.extraErr.signups ? UI.problem('Sign-ups could not be loaded', st.extraErr.signups.message, st.extraErr.signups.problem && st.extraErr.signups.problem.trace_id) : UI.notice('Deciding sign-ups needs the users:manage permission.', 'info');
          else {
            const list = st.signups.filter((x) => st.signupFilter === 'all' || x.state === st.signupFilter);
            body += '<div class="toolbar">' + UI.seg([{ id: 'pending', label: 'Pending' }, { id: 'approved', label: 'Approved' }, { id: 'rejected', label: 'Rejected' }, { id: 'all', label: 'All' }], st.signupFilter, 'data-signupseg aria-label="Sign-up state"') + '<span class="muted right" style="font-size:12px">' + list.length + ' sign-up' + (list.length === 1 ? '' : 's') + '</span></div>'
              + UI.table(['Username', 'Name', 'Email', 'Domain', 'State', 'Signed up', 'Decided', { label: '', right: true }], list.map((x) => ['<span class="mono">' + esc(x.username) + '</span>', esc(x.displayName), '<span class="mono">' + esc(x.email || '') + '</span> ' + (x.emailVerified ? UI.pill('verified', 'ok') : UI.pill('unverified', 'warn')), esc(x.domain), UI.pill(x.state, x.state === 'pending' ? 'warn' : x.state === 'rejected' ? 'danger' : 'ok'), esc(stamp(x.createdAt)), x.decidedBy ? esc(who(x.decidedBy)) + ', ' + esc(stamp(x.decidedAt)) + (x.reason ? '<div class="muted" style="font-size:12px">' + esc(x.reason) + '</div>' : '') : '', x.state === 'pending' ? '<span class="hstack gap6" style="justify-content:flex-end">' + UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-approve="' + esc(x.userId) + '" aria-label="Approve ' + esc(x.username) + '"' }) + UI.btn('Reject', { size: 'xs', attrs: 'data-reject="' + esc(x.userId) + '" aria-label="Reject ' + esc(x.username) + '"' }) + '</span>' : '']), { clickable: false, minWidth: '900px', emptyTitle: 'No sign-ups here', emptyText: 'Sign-ups appear when the mode is open or open with approval.' })
              + '<div class="muted" style="font-size:12px">Approval activates the account; rejection keeps it disabled (409 once decided). The user is told by email. Audited user.signup.approved or user.signup.rejected.</div>';
          }
        } else {
          const invites = st.invites || [];
          body += '<div class="hstack wrap"><span class="fg2">Workspace admins with <span class="mono">members:invite</span> invite people with roles they may grant and a clearance at most theirs. Tenant admins see every invitation; other inviters their own.</span><span class="right">' + UI.btn('Invite someone', { size: 'sm', icon: 'plus', kind: 'primary', attrs: 'data-invite' + (App.can('members:invite') ? '' : ' disabled') }) + '</span></div>'
            + (!st.invites && st.extraErr.invites ? UI.problem('Invitations could not be loaded', st.extraErr.invites.message, st.extraErr.invites.problem && st.extraErr.invites.problem.trace_id) : !st.invites ? UI.notice('Inviting people needs the members:invite permission.', 'info')
              : UI.table(['Email', 'Workspace', 'Roles', 'Clearance', 'Invited by', 'State', 'Expires', { label: '', right: true }], invites.map((x) => ['<span class="mono">' + esc(x.email) + '</span>', esc(wsName(x.workspaceId)), '<span class="mono">' + esc(x.roles.join(' ')) + '</span>', UI.label(x.clearance, { sm: true }), esc(who(x.invitedBy)), UI.pill(x.state, x.state === 'pending' ? 'info' : x.state === 'accepted' ? 'ok' : x.state === 'revoked' ? 'danger' : 'warn') + (x.acceptedBy ? '<div class="muted" style="font-size:12px">as ' + esc(who(x.acceptedBy)) + ', ' + esc(stamp(x.acceptedAt)) + '</div>' : ''), esc(date(x.expiresAt)), x.state === 'pending' ? UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-withdraw="' + esc(x.id) + '" aria-label="Withdraw the invitation for ' + esc(x.email) + '"' }) : '']), { clickable: false, minWidth: '900px', emptyTitle: 'No invitations', emptyText: 'Invite someone to create their account with roles and a workspace.' }))
            + '<div class="muted" style="font-size:12px">Links are <span class="mono">#/signin?invitation=&lt;token&gt;</span>, valid for 7 days, stored as SHA-256. A new invitation replaces a pending one for the same address and workspace. Needs SMTP (409 without).</div>';
        }
      } else if (st.tab === 'imports') {
        const imports = st.imports || [];
        const sel = imports.find((x) => x.id === st.importSel) || null;
        const detail = sel ? st.importDetail[sel.id] : null;
        // The report of a finished import is fetched once it is selected (a row click, a design state, a new import).
        if (sel && sel.state === 'done' && !detail && !st.detailBusy) {
          st.detailBusy = true;
          App.get('/api/admin/user-imports/' + encodeURIComponent(sel.id)).then((d) => { st.importDetail[sel.id] = d; }, (err) => { st.importDetail[sel.id] = { error: err }; }).finally(() => { st.detailBusy = false; if (App.state.route === 'identity' && !document.querySelector('.modal')) ctx.rerender(); });
        }
        const sum = (x) => x.summary || { create: 0, update: 0, unchanged: 0, conflict: 0, error: 0, applied: 0 };
        let selPanel = '';
        if (sel && (sel.state === 'queued' || sel.state === 'running')) selPanel = UI.notice('Import <span class="mono">' + esc(sel.id) + '</span> is ' + esc(sel.state) + '. The report appears here when the job has run.', 'info');
        else if (sel && sel.state === 'failed') selPanel = UI.notice('<b>Import ' + esc(sel.id) + ' failed.</b> ' + esc(sel.error || ''), 'danger');
        else if (sel && !detail) selPanel = UI.notice('Loading…', 'info');
        else if (sel && detail && detail.error) selPanel = UI.problem('The report could not be loaded', detail.error.message, detail.error.problem && detail.error.problem.trace_id);
        else if (sel && detail) {
          const s0 = sum(detail);
          const issues = detail.report.filter((r) => r.action !== 'unchanged');
          selPanel = (!detail.dryRun && !s0.conflict && !s0.error) ? UI.notice('Import ' + esc(sel.id) + ' applied ' + s0.applied + ' row' + (s0.applied === 1 ? '' : 's') + ' with no conflicts. Each change was audited with via: import.', 'ok')
            : UI.panel('Report for ' + esc(sel.id) + (detail.dryRun ? ' (dry run, nothing changed)' : ''), UI.table(['Row', 'Kind', 'Key', 'Action', 'Detail'], issues.map((r) => [String(r.row), esc(r.kind), '<span class="mono">' + esc(r.key) + '</span>', UI.pill(r.action, r.action === 'conflict' ? 'warn' : r.action === 'error' ? 'danger' : r.action === 'create' ? 'ok' : 'info'), esc(r.detail || '')]), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'Every row unchanged', emptyText: 'The file matches what is here.' })
              + (detail.dryRun ? '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">Fix the conflicting rows and run again, or apply: accepted rows are written (accounts, then mappings, then memberships) and the conflicts skipped.' + (st.csvs[sel.id] ? '' : ' The file is not kept after a dry run, so applying asks for it again.') + '</span>' + UI.btn('Apply accepted rows', { size: 'sm', kind: 'primary', attrs: 'data-applyimport' }) + '</div>' : ''));
        }
        body = '<div class="hstack wrap"><span class="fg2">CSV imports of users, memberships and group mappings (B-1805). The file is sealed with the tenant key and run as a job under your roles and clearance; a dry run plans and reports, changing nothing.</span><span class="right">' + UI.btn('Import CSV', { size: 'sm', icon: 'upload', kind: 'primary', attrs: 'data-import' + (App.can('users:manage') ? '' : ' disabled') }) + '</span></div>'
          + (!st.imports ? (st.extraErr.imports ? UI.problem('Imports could not be loaded', st.extraErr.imports.message, st.extraErr.imports.problem && st.extraErr.imports.problem.trace_id) : UI.notice('Importing users needs the users:manage permission.', 'info'))
            : UI.table(['Import', 'State', 'Mode', 'Rows', 'Create', 'Update', 'Unchanged', 'Conflicts', 'Errors', 'Applied', 'By'], imports.map((x) => { const m = sum(x); return { cells: ['<span class="mono">' + esc(x.id.slice(-8)) + '</span>', UI.pill(x.state, x.state === 'done' ? 'ok' : x.state === 'failed' ? 'danger' : 'info'), x.dryRun ? UI.pill('dry run', 'outline') : 'applied', String(x.rows), String(m.create), String(m.update), String(m.unchanged), m.conflict ? '<span style="color:var(--warn-fg)">' + m.conflict + '</span>' : '0', m.error ? '<span style="color:var(--danger-fg)">' + m.error + '</span>' : '0', String(m.applied), esc(who(x.createdBy)) + '<div class="muted" style="font-size:12px">' + esc(stamp(x.createdAt)) + '</div>'], attrs: 'data-import-row="' + esc(x.id) + '"', selected: sel && sel.id === x.id }; }), { minWidth: '900px', emptyTitle: 'No imports yet', emptyText: 'Import a CSV of users, memberships and group mappings; start with a dry run.' }))
          + selPanel
          + UI.panel('File format', UI.code(SAMPLE_CSV, 'csv') + '<div class="muted" style="font-size:12px">Header row; columns in any order; unknown columns refused. <span class="mono">kind=user</span> creates a local account (roles separated by ;) or updates one; <span class="mono">membership</span> adds a direct membership (workspace by slug or id); <span class="mono">mapping</span> adds or changes a group mapping (one role; provider empty for any). At most 5 MB and 10,000 rows.</div>');
      } else if (st.tab === 'dids') {
        body = '<div class="hstack wrap"><span class="fg2">Users bind their own AT-Protocol DID in Settings (a profile challenge or the OAuth flow). Bound DIDs sign in as their user through the <span class="mono">atproto</span> store.</span><span class="right hstack gap6">' + UI.btn('Check an account', { size: 'sm', attrs: 'data-checkaccount' }) + '</span></div>'
          + (!st.dids ? (st.extraErr.dids ? UI.problem('Bindings could not be loaded', st.extraErr.dids.message, st.extraErr.dids.problem && st.extraErr.dids.problem.trace_id) : UI.notice('Seeing bindings needs the identity:manage permission.', 'info'))
            : UI.table(['User', 'DID', 'Handle', 'State', 'Proof', { label: '', right: true }], st.dids.map((d) => ['<span class="mono">' + esc(d.username) + '</span>', '<span class="mono" style="overflow-wrap:anywhere">' + esc(d.did) + '</span>', d.handle ? '<span class="mono">' + esc(d.handle) + '</span>' : '<span class="muted">none</span>', d.verified ? UI.pill('verified', 'ok') : d.challengePending ? UI.pill('challenge pending', 'warn') + '<div class="muted" style="font-size:12px">expires ' + esc(stamp(d.challengeExpiresAt)) + '</div>' : UI.pill('unverified', 'warn'), d.proof ? UI.pill(d.proof, 'outline') : '', UI.btn('Remove binding', { size: 'xs', kind: 'ghost', attrs: 'data-rmdid="' + esc(d.id) + '" aria-label="Remove the binding for ' + esc(d.username) + '"' })]), { clickable: false, minWidth: '760px', emptyTitle: 'No bindings', emptyText: 'Users bind a DID from Settings.' }))
          + '<div class="muted" style="font-size:12px">Removing a binding is audited atproto.did.removed (204). Handles are checked both ways: the DNS or well-known record must give the DID, and the DID document must name the handle back.</div>';
      } else {
        body = '<div class="eyebrow">Active sessions and grants in this tenant</div>' + UI.table(['User', 'Signed in', 'Method', 'Client', ''], st.sessions.map((s, i) => ['<b>' + esc(s.user) + '</b>', esc(s.kind === 'service' ? 'token, ' + when(s.signedInAt) : when(s.signedInAt)), esc(s.method), esc(s.client), UI.btn('Revoke', { size: 'xs', attrs: 'data-revoke="' + i + '"' })]), { clickable: false, minWidth: '560px', emptyTitle: 'No active sessions', emptyText: 'Sessions appear when someone signs in or a service account requests a token.' })
          + '<div class="muted" style="font-size:12px">Revocation also invalidates refresh tokens. Users disabled by directory sync lose their sessions within one sync interval.</div><div>' + UI.btn('Open tenant sessions', { size: 'sm', kind: 'ghost', attrs: 'data-gotenants' }) + '</div>';
      }

      // ----- inspector -----
      let insp = '<div class="muted">Create a client to see its settings here.</div>';
      if (client) {
        const secret = st.fresh[client.id];
        const secretBlock = !client.confidential ? UI.kv([['Client secret', 'none, public client with PKCE']], 1)
          : secret
            ? '<div class="id-secret"><div class="hstack"><b>Secret shown once</b>' + UI.pill('copy now', 'warn') + '</div><div class="mono" style="overflow-wrap:anywhere">' + esc(secret) + '</div><div class="muted" style="font-size:12px">Copy it now. It cannot be shown again, only rotated.</div><div class="hstack gap6">' + UI.btn('Copy secret', { size: 'sm', kind: 'primary', attrs: 'data-copysecret' }) + UI.btn('Rotate secret', { size: 'sm', attrs: 'data-rotatesecret' }) + '</div></div>'
            : UI.kv([['Client secret', 'created ' + esc(date(client.secretCreatedAt)) + '<div style="margin-top:6px">' + UI.btn('Rotate secret', { size: 'sm', attrs: 'data-rotatesecret' }) + '</div>']], 1);
        const cc = client.grants.indexOf('client_credentials') >= 0;
        insp = '<div class="eyebrow">' + esc(client.typeLabel) + '</div><div style="font-size:15px;font-weight:600">' + esc(client.name) + ' ' + UI.pill(client.status, client.status === 'active' ? 'ok' : 'warn') + '</div>'
          + UI.kv([['Client ID', '<span class="mono">' + esc(client.clientId) + '</span>'], ['Access token lifetime', Math.round(client.accessTtl / 60) + ' min'], ['Refresh', client.refreshTtl ? Math.round(client.refreshTtl / 3600) + ' h, rotated on use' : 'none'], ['Allowed models', esc(client.models || 'per profile')], ['Last used', esc(when(client.lastUsedAt))], ['Consent', esc(client.consent)]], 2)
          + '<div class="field"><span class="fl">Redirect URIs</span>' + (client.redirectUris.length ? client.redirectUris.map((r) => '<div class="mono" style="overflow-wrap:anywhere">' + esc(r) + '</div>').join('') : '<div class="muted">none</div>') + '</div>'
          + '<div class="field"><span class="fl">Grant types</span><div class="hstack wrap gap4">' + client.grants.map((g) => UI.pill(g, 'outline')).join('') + '</div></div>'
          + '<div class="field"><span class="fl">Scopes</span><div class="mono">' + esc(client.scopes.join(' ')) + '</div></div>'
          + UI.toggle(cc ? 'PKCE not applicable to client credentials' : 'PKCE required', client.pkceRequired, 'data-manual data-pkce' + (cc || client.type === 'public' ? ' data-na style="opacity:.6"' : ''))
          + UI.toggle('DPoP proof required (sender-constrained tokens)', client.dpopRequired, 'data-manual data-dpop')
          + (client.confidential ? '<div class="field"><span class="fl">Token introspection</span><div class="fg2" style="font-size:12px">' + (client.introspect === 'any' ? 'Resource server: introspects access tokens of every client in this tenant.' : client.introspectPending ? 'Its own tokens. Introspecting every client\'s tokens waits for a second identity admin.' : 'Its own tokens only.') + '</div><div>' + (client.introspect === 'any' ? UI.btn('Limit to its own tokens', { size: 'sm', kind: 'ghost', attrs: 'data-introspect="own"' }) : client.introspectPending ? '' : UI.btn('Make it a resource server', { size: 'sm', kind: 'ghost', attrs: 'data-introspect="any"' })) + '</div></div>' : '')
          + (client.grants.indexOf('authorization_code') >= 0 ? UI.toggle('Pushed authorization requests required', client.parRequired, 'data-manual data-par') : '')
          + UI.kv([['Request object keys', client.jwks.length ? client.jwks.map((k) => esc(k.kty + (k.kid ? ' ' + k.kid : ''))).join(', ') : 'none'], ['Post-logout redirect', client.postLogoutRedirectUris.length ? client.postLogoutRedirectUris.map((r) => '<div class="mono" style="overflow-wrap:anywhere">' + esc(r) + '</div>').join('') : 'none'], ['Front-channel logout', client.frontchannelLogoutUri ? '<span class="mono" style="overflow-wrap:anywhere">' + esc(client.frontchannelLogoutUri) + '</span>' : 'none'], ['Back-channel logout', client.backchannelLogoutUri ? '<span class="mono" style="overflow-wrap:anywhere">' + esc(client.backchannelLogoutUri) + '</span>' : 'none']], 1)
          + secretBlock
          + '<div class="divider"></div><div class="vstack gap6">' + UI.btn('Edit client', { size: 'sm', icon: 'edit', attrs: 'data-edit' }) + (client.type === 'service' ? UI.btn('Open service account', { size: 'sm', kind: 'ghost', attrs: 'data-gousers' }) : '') + (client.status === 'active' ? UI.btn('Disable client', { size: 'sm', kind: 'danger', attrs: 'data-disable' }) : UI.btn('Enable client', { size: 'sm', attrs: 'data-enable' })) + '</div>';
      }

      root.innerHTML = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}.id-secret{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--warn-fg);border-radius:6px;background:var(--warn-bg)}.id-secret .muted{color:var(--warn-fg)}</style>'
        + '<div class="page">' + UI.pagehead('Identity and SSO', 'The identity service is the only token issuer', UI.btn('Test a login', { attrs: 'data-testlogin' }) + UI.btn('Create client', { kind: 'primary', icon: 'plus', attrs: 'data-create' }))
        + banner + pendingPanel + tabs + body
        + '</div>'
        + '<aside class="inspector">' + insp + '</aside>';

      const act = async (fn, okMsg, kind) => { try { const r = await fn(); if (okMsg) ctx.toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, kind || 'ok', 5000); reload(); return r; } catch (err) { App.fail(err); return null; } };

      // ----- modals -----
      function rotateKey() {
        ctx.confirm({ title: 'Rotate signing key', tag: 'affects every client', tone: 'info', body: '<p style="margin:0" class="fg2">Generates a new ES256 key, ' + (ov.signingInKms ? 'held in ' + esc(ov.keyStore) : 'sealed with the platform data key') + ', and publishes it to JWKS. It starts signing after the ' + ov.rotation.overlapDays + ' day overlap; the current key stays listed for verification until then.</p>', kv: [['Current', esc(signing ? signing.kid : 'none')], ['New', 'generated on rotate'], ['Overlap', ov.rotation.overlapDays + ' days']], ok: 'Rotate' }).then((ok) => {
          if (!ok) return;
          st.keyExpiring = false; st.tab = 'keys';
          act(() => App.post('/api/admin/federation/keys/rotate', {}), (r) => esc(r.next.kid) + ' published to JWKS. It signs from ' + esc(date(r.next.activatesAt)) + (r.previous ? '; ' + esc(r.previous) + ' verifies until then.' : '.'));
        });
      }
      function createClient() {
        ctx.modal({ title: 'Create client', cls: 'wide',
          body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-cname placeholder="Treasury dashboard"' })) + UI.field('Type', UI.select(TYPES, 'third party', 'data-ctype')) + UI.field('Redirect URIs', UI.textarea('', { rows: 2, placeholder: 'https://treasury.example.internal/oauth/cb', attrs: 'data-credir' }), 'One per line. Exact match; wildcards are refused.') + UI.field('Scopes', UI.input('openid chat:read chat:write', { attrs: 'data-cscopes' }), 'Space separated. openid, profile, email, groups, a permission such as chat:read, or chat:* for all of a resource.')
            + '<div class="span2 hstack wrap gap12">' + UI.check('authorization code', true, 'data-g="authorization_code"') + UI.check('refresh token', true, 'data-g="refresh_token"') + UI.check('client credentials', false, 'data-g="client_credentials"') + UI.check('device authorization', false, 'data-g="device_code"') + UI.check('token exchange', false, 'data-g="token_exchange"') + '</div>' + '<div class="span2">' + UI.toggle('PKCE required', true, 'data-cpkce') + '</div>' + UI.field('Post-logout redirect URIs', UI.textarea('', { rows: 2, placeholder: 'https://treasury.example.internal/signed-out', attrs: 'data-cpost' }), 'Where RP-initiated logout may return. One per line, exact match.') + UI.field('Back-channel logout URI', UI.input('', { attrs: 'data-cback', placeholder: 'https://treasury.example.internal/oidc/logout' }), 'Receives a signed logout token when the user signs out. Must be an internal host.') + '</div>' + UI.notice('The client secret is shown once after creation. Third-party clients ask users for consent on first use. Service accounts get a user with the member role; their tokens\' scopes narrow it.', 'info') + '<div data-cerr></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create client', { kind: 'primary', attrs: 'data-cgo' }),
          onMount(m) {
            m.querySelector('[data-cgo]').addEventListener('click', async () => {
              const name = m.querySelector('[data-cname]').value.trim();
              const type = m.querySelector('[data-ctype]').value;
              const grants = Array.prototype.slice.call(m.querySelectorAll('[data-g]')).filter((i) => (i.querySelector('input') ? i.querySelector('input').checked : (i.checked || i.classList.contains('on')))).map((i) => i.dataset.g);
              const body = { name, type, grants, redirectUris: m.querySelector('[data-credir]').value.split('\n').map((s) => s.trim()).filter(Boolean), scopes: m.querySelector('[data-cscopes]').value.split(/\s+/).filter(Boolean), pkceRequired: m.querySelector('[data-cpkce]').classList.contains('on'), postLogoutRedirectUris: m.querySelector('[data-cpost]').value.split('\n').map((s) => s.trim()).filter(Boolean), backchannelLogoutUri: m.querySelector('[data-cback]').value.trim() || null };
              if (!name) { m.querySelector('[data-cerr]').innerHTML = UI.notice('Give the client a name.', 'warn'); return; }
              try {
                const r = await App.post('/api/admin/federation/oidc/clients', body);
                App.closeOverlay();
                if (r.secret) st.fresh[r.client.id] = r.secret;
                st.client = r.client.id; st.tab = 'clients';
                ctx.toast('Client ' + esc(r.client.name) + ' created.' + (r.secret ? ' Copy the secret now.' : ''), 'ok', 5000);
                reload();
              } catch (err) { m.querySelector('[data-cerr]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Not created') + '.</b> ' + esc(err.message) + (err.problem && err.problem.errors ? ' ' + esc(err.problem.errors.map((e) => e.path + ': ' + e.message).join('; ')) : ''), 'danger'); }
            });
          }
        });
      }
      function samlImport() {
        ctx.modal({ title: 'SAML metadata import', cls: 'wide',
          body: UI.field('Name', UI.input('', { attrs: 'data-sname placeholder="Treasury"' })) + UI.field('Metadata URL', UI.input('', { attrs: 'data-surl placeholder="https://treasury.example.internal/saml/metadata"' }), 'Fetched from an internal host and again every day; a changed certificate waits for approval. Leave empty to paste the XML instead.') + UI.field('Service provider metadata XML', UI.textarea('', { rows: 6, placeholder: '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://treasury.example.internal/saml">…', attrs: 'data-xml' }), 'Or paste the file contents.') + UI.check('Sign the whole response, not only the assertion', false, 'data-ssignresp') + '<div id="saml-parsed"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Parse', { attrs: 'data-parse' }) + UI.btn('Save provider', { kind: 'primary', attrs: 'data-samlsave disabled' }),
          onMount(m) {
            const out = m.querySelector('#saml-parsed');
            m.querySelector('[data-xml]').addEventListener('input', () => m.querySelector('[data-samlsave]').setAttribute('disabled', ''));
            m.querySelector('[data-surl]').addEventListener('input', (ev) => { if (ev.target.value.trim()) m.querySelector('[data-samlsave]').removeAttribute('disabled'); else m.querySelector('[data-samlsave]').setAttribute('disabled', ''); });
            m.querySelector('[data-parse]').addEventListener('click', async () => {
              try {
                const p = await App.post('/api/admin/federation/saml/parse', { xml: m.querySelector('[data-xml]').value });
                out.innerHTML = '<div class="eyebrow">Parsed, review before saving</div>' + UI.kv([['Entity ID', '<span class="mono">' + esc(p.entityId) + '</span>'], ['ACS URLs', p.acsUrls.map((a) => '<span class="mono">' + esc(a.url) + '</span> (index ' + a.index + ', POST)').join('<br>')], ['Certificate', p.cert ? esc(p.cert.subject) + ', ' + (p.cert.expired ? 'expired ' : 'expires ') + esc(date(p.cert.validTo)) + ', SHA-256 ' + esc(p.cert.fingerprint.slice(0, 8) + '…' + p.cert.fingerprint.slice(-5)) : 'none'], ['NameID format', esc(p.nameIdFormat)], ['Signed requests', p.signedRequests ? 'yes' : 'no'], ['Issuer', p.cert ? esc(p.cert.issuer) : 'none'], ['Single logout', p.sloUrl ? '<span class="mono">' + esc(p.sloUrl) + '</span> (' + esc(p.sloBinding) + ')' : 'none'], ['Encryption', p.encryptionCert ? 'assertions encrypted for ' + esc(p.encryptionCert.subject) + (p.encryptionCert.expired ? ' (expired: not used)' : '') : 'none, assertions signed only']], 2);
                m.querySelector('[data-samlsave]').removeAttribute('disabled');
              } catch (err) { out.innerHTML = UI.notice('<b>Could not parse.</b> ' + esc(err.message), 'danger'); }
            });
            m.querySelector('[data-samlsave]').addEventListener('click', async () => {
              const name = m.querySelector('[data-sname]').value.trim();
              if (!name) { out.insertAdjacentHTML('afterbegin', UI.notice('Give the service provider a name.', 'warn')); return; }
              try {
                const url = m.querySelector('[data-surl]').value.trim();
                const signResponse = m.querySelector('[data-ssignresp]').checked;
                const sp = await App.post('/api/admin/federation/saml/sps', url ? { name, metadataUrl: url, signResponse } : { name, xml: m.querySelector('[data-xml]').value, signResponse });
                App.closeOverlay(); st.tab = 'saml';
                ctx.toast('Service provider ' + esc(sp.name) + ' saved. Assertions include groups and clearance.', 'ok');
                reload();
              } catch (err) { out.insertAdjacentHTML('afterbegin', UI.notice('<b>Not saved.</b> ' + esc(err.message), 'danger')); }
            });
          }
        });
      }
      function upstreamModal() {
        ctx.modal({ title: 'Add upstream provider',
          body: UI.notice('<b>Only on-prem identity providers can be added.</b> Cloud providers are unreachable from this network, so their discovery documents cannot be fetched.', 'info') + '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'AD FS, plant.example.internal', attrs: 'data-uname' })) + UI.field('Protocol', UI.select(['OIDC (we are RP)', 'SAML 2.0 (we are SP)'], 'OIDC (we are RP)', 'data-uproto')) + UI.field('Issuer or metadata', UI.input('https://', { attrs: 'data-uiss' }), 'OIDC: the issuer URL. SAML: the metadata URL, or paste the metadata XML. Must resolve to an internal address.') + UI.field('Maps to tenant', UI.select([App.me && App.me.tenant ? App.me.tenant.name : 'This tenant'], App.me && App.me.tenant ? App.me.tenant.name : 'This tenant', 'disabled')) + '<div data-oidconly class="span2 formgrid">' + UI.field('Client ID', UI.input('', { attrs: 'data-ucid', placeholder: 'registered at the provider' })) + UI.field('Client secret reference', UI.input('', { attrs: 'data-usecret', placeholder: 'env:UPSTREAM_CLIENT_SECRET' }), 'A reference resolved on the server, never the secret itself. Leave empty for a public client.') + '</div></div><div id="up-check"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Check reachability', { attrs: 'data-ucheck' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-usave disabled' }),
          onMount(m) {
            const proto = () => (m.querySelector('[data-uproto]').value.indexOf('SAML') === 0 ? 'saml' : 'oidc');
            const sync = () => { m.querySelector('[data-oidconly]').style.display = proto() === 'oidc' ? '' : 'none'; m.querySelector('[data-usave]').setAttribute('disabled', ''); };
            m.querySelector('[data-uproto]').addEventListener('change', sync);
            m.querySelector('[data-uiss]').addEventListener('input', () => m.querySelector('[data-usave]').setAttribute('disabled', ''));
            sync();
            m.querySelector('[data-ucheck]').addEventListener('click', async () => {
              const v = m.querySelector('[data-uiss]').value.trim();
              const out = m.querySelector('#up-check');
              out.innerHTML = UI.notice('Checking…', 'info');
              try {
                const r = await App.post('/api/admin/federation/upstream/check', { protocol: proto(), source: v });
                out.innerHTML = (r.ok ? UI.notice('Reachable: ' + esc(r.reach) + '.' + (r.parsed && r.parsed.entityId ? ' Entity ' + esc(r.parsed.entityId) + '.' : r.parsed && r.parsed.issuer ? ' Discovery document fetched.' : ''), 'ok') : UI.notice('<b>Unreachable.</b> ' + esc(v || 'that address') + ' could not be used. Add an on-prem provider instead.', 'danger')) + stepsHtml(r.steps);
                if (r.ok) m.querySelector('[data-usave]').removeAttribute('disabled');
              } catch (err) { out.innerHTML = UI.notice('<b>Check failed.</b> ' + esc(err.message), 'danger'); }
            });
            m.querySelector('[data-usave]').addEventListener('click', async () => {
              const body = { name: m.querySelector('[data-uname]').value.trim() || m.querySelector('[data-uiss]').value.replace(/^https?:\/\//, '').slice(0, 100), protocol: proto(), source: m.querySelector('[data-uiss]').value.trim() };
              if (body.protocol === 'oidc') { body.clientId = m.querySelector('[data-ucid]').value.trim(); const sec = m.querySelector('[data-usecret]').value.trim(); if (sec) body.clientSecret = sec; }
              try {
                const u = await App.post('/api/admin/federation/upstream', body);
                App.closeOverlay(); st.tab = 'upstream';
                ctx.toast('Upstream provider saved. Register ' + esc(u.protocol === 'oidc' ? ov.upstream.redirectUri : ov.upstream.acsUrl + ' and entity ' + u.spEntityId) + ' at the provider, and map its groups in User stores.', 'ok', 8000);
                reload();
              } catch (err) { m.querySelector('#up-check').innerHTML = UI.notice('<b>Not saved.</b> ' + esc(err.message), 'danger'); }
            });
          }
        });
      }
      function testLogin() {
        ctx.modal({ title: 'Test a login',
          body: '<div class="formgrid">' + UI.field('Method', UI.select(['Kerberos SPNEGO', 'LDAP password and TOTP', 'Device code'], 'Kerberos SPNEGO', 'data-tm')) + UI.field('As', UI.input(App.me ? App.me.user.username : '', { attrs: 'data-tas' })) + '</div><div id="tl-out">' + UI.timeline([{ title: 'Ready', text: 'Runs the real pieces of the flow against the identity service with a test audience. No session is created.' }]) + '</div>',
          actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Run', { kind: 'primary', attrs: 'data-tlrun' }),
          onMount(m) {
            m.querySelector('[data-tlrun]').addEventListener('click', async () => {
              const method = { 'Kerberos SPNEGO': 'kerberos', 'LDAP password and TOTP': 'password', 'Device code': 'device' }[m.querySelector('[data-tm]').value];
              const out = m.querySelector('#tl-out');
              out.innerHTML = UI.timeline([{ title: 'Running', tone: 'accent', meta: 'running' }]);
              try {
                const r = await App.post('/api/admin/federation/test-login', { method, username: m.querySelector('[data-tas]').value.trim() });
                out.innerHTML = UI.timeline(r.steps.map((s, i) => ({ title: esc(s.title), text: s.detail ? esc(s.detail) : '', meta: s.ms != null ? s.ms + ' ms' : '', tone: !s.ok ? 'danger' : r.pending && i === r.steps.length - 1 ? 'warn' : 'ok' })));
              } catch (err) { out.innerHTML = UI.notice('<b>Could not run.</b> ' + esc(err.message), 'danger'); }
            });
          }
        });
      }
      if (st.openCreate) { st.openCreate = false; setTimeout(createClient, 50); }
      if (st.openRotate) { st.openRotate = false; setTimeout(rotateKey, 50); }
      if (st.openSaml) { st.openSaml = false; setTimeout(samlImport, 50); }
      if (st.openUpstream) { st.openUpstream = false; setTimeout(upstreamModal, 50); }

      // ----- B-3413: sign-up and MFA policy, sign-ups, invitations, CSV imports, DID bindings, GitHub and AT-Protocol stores -----
      function inviteModal() {
        const roleOpts = (st.roles || []).length ? st.roles.filter((r) => !r.requiresMfa || App.can('users:manage')) : SIGNUP_ROLES.map((id) => ({ id, name: id }));
        const wsOpts = myWorkspaces.map((w) => ({ value: w.id, label: w.name })).concat(App.can('tenant:manage') ? [{ value: '', label: 'No workspace' }] : []);
        ctx.modal({ title: 'Invite someone',
          body: '<div class="formgrid">' + UI.field('Email', UI.input('', { type: 'email', placeholder: 'name@example.internal', attrs: 'data-iemail autocomplete="off"' })) + UI.field('Workspace', UI.select(wsOpts, wsOpts.length ? wsOpts[0].value : '', 'data-iws'), 'Without tenant:manage, one you belong to.') + UI.field('Clearance', UI.select(LABELS.filter((l) => LABELS.indexOf(l) <= LABELS.indexOf(myClearance)), 'internal', 'data-iclr'), 'At most yours (' + esc(myClearance) + ').')
            + UI.field('Roles you may grant', '<div class="hstack wrap gap12" style="row-gap:12px">' + roleOpts.map((r) => UI.check(r.name, r.id === 'member', 'data-irole="' + esc(r.id) + '"')).join('') + '</div>', 'A role you may not grant is refused (403 step role).') + '</div>'
            + UI.notice('The link goes by email, is valid for 7 days and creates a local account with these roles in the workspace; the address counts as verified. Audited user.invitation.created.', 'info') + '<div data-ierr role="alert"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send invitation', { kind: 'primary', attrs: 'data-isend' }),
          onMount(m) {
            m.querySelector('[data-isend]').addEventListener('click', async () => {
              const email = m.querySelector('[data-iemail]').value.trim(); const err = m.querySelector('[data-ierr]');
              if (!/^[^@\s]+@[^@\s]+$/.test(email)) { err.innerHTML = UI.notice('Enter an email address.', 'warn'); return; }
              const roles = Array.prototype.slice.call(m.querySelectorAll('[data-irole]:checked')).map((c) => c.dataset.irole);
              if (!roles.length) { err.innerHTML = UI.notice('Pick at least one role.', 'warn'); return; }
              try {
                const r = await App.post('/api/invitations', { email, workspaceId: m.querySelector('[data-iws]').value || null, roles, clearance: m.querySelector('[data-iclr]').value });
                App.closeOverlay(); st.tab = 'policy'; st.policyView = 'invitations';
                ctx.toast(r.sent ? 'Invitation sent to ' + esc(email) + '. A pending one for the same address and workspace was replaced.' : 'Invitation for ' + esc(email) + ' created, but the email could not be sent.', r.sent ? 'ok' : 'warn', 5000);
                reload();
              } catch (e) { err.innerHTML = UI.notice(problemText(e), 'danger'); }
            });
          } });
      }
      function importModal(prefill) {
        ctx.modal({ title: 'Import users, memberships and mappings', cls: 'wide',
          body: (prefill ? UI.notice(prefill.note, 'info') : '') + UI.field('CSV file', '<input type="file" class="input" accept=".csv,text/csv,text/plain" data-csvfile>', 'Or paste the contents below.') + UI.field('CSV', UI.textarea(prefill ? prefill.csv : '', { rows: 7, placeholder: CSV_HEADER, attrs: 'data-csv spellcheck="false" style="font-family:var(--mono);font-size:12px"' }), 'text/csv, at most 5 MB and 10,000 rows. Stored sealed; dropped once the job has run.')
            + '<div class="hstack wrap gap12">' + UI.check('Dry run: plan and report, change nothing', prefill ? !!prefill.dry : true, 'data-dry') + UI.check('Send invitation links to new accounts instead of passwords nobody knows', prefill ? !!prefill.sendInvites : false, 'data-sendinv') + '</div>'
            + UI.notice('Every row is checked like the API: roles you may grant, clearance at or below yours, accounts whose roles you may manage. The job runs under your current roles.', 'info') + '<div data-imperr role="alert"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Queue import', { kind: 'primary', attrs: 'data-igo' }),
          onMount(m) {
            const ta = m.querySelector('[data-csv]');
            m.querySelector('[data-csvfile]').addEventListener('change', (ev) => { const f = ev.target.files && ev.target.files[0]; if (!f) return; f.text().then((t) => { ta.value = t; }, () => { m.querySelector('[data-imperr]').innerHTML = UI.notice('The file could not be read.', 'danger'); }); });
            m.querySelector('[data-igo]').addEventListener('click', async () => {
              const csv = ta.value; const dry = m.querySelector('[data-dry]').checked; const inv = m.querySelector('[data-sendinv]').checked;
              if (!csv.trim()) { m.querySelector('[data-imperr]').innerHTML = UI.notice('Choose a file or paste the CSV.', 'warn'); return; }
              try {
                const r = await postCsv(csv, dry, inv);
                st.csvs[r.id] = { csv, sendInvites: inv };
                App.closeOverlay(); st.tab = 'imports'; st.importSel = r.id;
                ctx.toast('Import queued. Audited ' + (dry ? 'user.import.dry_run' : 'user.import.requested') + '.', 'ok');
                reload(); watchImport(r.id);
              } catch (e) { m.querySelector('[data-imperr]').innerHTML = UI.notice(problemText(e), 'danger'); }
            });
          } });
      }
      /** Follows a queued import until its job has run, then shows the report. */
      function watchImport(id) {
        let n = 0;
        const tick = () => {
          if (App.state.route !== 'identity' || n++ > 60) return;
          App.get('/api/admin/user-imports/' + encodeURIComponent(id)).then((d) => {
            if (d.state === 'queued' || d.state === 'running') { setTimeout(tick, 1000); return; }
            st.importDetail[id] = d;
            if (!document.querySelector('.modal')) reload(); else st.loaded = false;
          }, () => undefined);
        };
        setTimeout(tick, 600);
      }
      function checkAccountModal() {
        ctx.modal({ title: 'Check an AT-Protocol account',
          body: UI.field('Handle or DID', UI.input('', { attrs: 'data-chk autocomplete="off" spellcheck="false"', placeholder: 'alice.bsky.social' })) + '<div id="chk-out">' + UI.timeline([{ title: 'Ready', text: 'Resolves the account step by step: handle, DID, document, PDS, its authorization server and that server\'s metadata. Nothing is signed in. Audited atproto.account.checked.' }]) + '</div>',
          actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Check', { kind: 'primary', attrs: 'data-chkrun' }),
          onMount(m) {
            m.querySelector('[data-chkrun]').addEventListener('click', async () => {
              const v = m.querySelector('[data-chk]').value.trim(); const out = m.querySelector('#chk-out');
              if (v.length < 3) { out.innerHTML = UI.notice('Enter a handle or a DID.', 'warn'); return; }
              out.innerHTML = UI.timeline([{ title: 'Checking', tone: 'accent', meta: 'running' }]);
              try { const r = await App.post('/api/admin/atproto/accounts/check', { account: v }); out.innerHTML = (r.ok ? UI.notice('Resolved' + (r.did ? ' to <span class="mono">' + esc(r.did) + '</span>' : '') + '.', 'ok') : UI.notice('<b>Not usable.</b> A step below failed.', 'danger')) + stepsHtml(r.steps || []); }
              catch (e) { out.innerHTML = UI.notice(problemText(e), 'danger'); }
            });
          } });
      }
      if (st.openInvite) { st.openInvite = false; setTimeout(inviteModal, 50); }

      const draft = st.draft;
      const dirty = () => { if (!st.policyDirty) { st.policyDirty = true; ctx.rerender(); } };
      ctx.on('click', '[data-policyseg] [data-seg]', (e, t) => { st.policyView = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-signupseg] [data-seg]', (e, t) => { st.signupFilter = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-gracedone]', () => { st.graceRestarted = false; ctx.rerender(); });
      ctx.on('click', '[data-discardpolicy]', () => { st.draft = clone(st.policy); st.policyDirty = false; ctx.rerender(); });
      ctx.on('change', '[data-pol]', (e, t) => {
        if (!draft) return;
        const path = t.dataset.pol.split('.');
        const v = t.tagName === 'TEXTAREA' ? t.value.split('\n').map((x) => x.trim()).filter(Boolean) : t.type === 'number' ? Math.max(0, Math.min(90, parseInt(t.value, 10) || 0)) : path[1] === 'workspaceId' ? (t.value || null) : t.value;
        draft[path[0]][path[1]] = v;
        if (path[1] === 'require') { st.policyDirty = true; ctx.rerender(); } else dirty();
      });
      ctx.on('change', '[data-polrole]', (e, t) => { if (!draft) return; const r = t.dataset.polrole; draft.signup.roles = draft.signup.roles.filter((x) => x !== r).concat(t.checked ? [r] : []); dirty(); });
      ctx.on('change', '[data-polmfarole]', (e, t) => { if (!draft) return; const r = t.dataset.polmfarole; draft.mfa.roles = draft.mfa.roles.filter((x) => x !== r).concat(t.checked ? [r] : []); dirty(); });
      ctx.on('click', '[data-polverify]', () => { if (!draft) return; draft.signup.requireEmailVerification = !draft.signup.requireEmailVerification; st.policyDirty = true; ctx.rerender(); });
      ctx.on('click', '[data-savepolicy]', async () => {
        if (!draft) return;
        const pol = draft; const was = st.policy.mfa;
        if (pol.mfa.require === 'roles' && !pol.mfa.roles.length) { ctx.toast('Name at least one role, or require a second factor for everyone.', 'warn'); return; }
        if (!pol.signup.roles.length) { ctx.toast('Give new accounts at least one role.', 'warn'); return; }
        const widened = pol.mfa.require !== 'off' && (was.require === 'off' || (was.require === 'roles' && (pol.mfa.require === 'all' || pol.mfa.roles.some((r) => was.roles.indexOf(r) < 0))));
        const ok = await ctx.confirm({ title: 'Save the identity policy', tag: widened ? 'restarts the grace period' : 'tenant-wide', tone: 'info', body: '<p class="fg2" style="margin:0">Applies to every sign-in from now on' + (widened ? '. The MFA requirement widened, so covered accounts get ' + pol.mfa.graceDays + ' days to enrol a factor.' : '.') + '</p>', kv: [['Sign-up', esc(pol.signup.mode) + ', ' + (pol.signup.domains.length ? esc(pol.signup.domains.join(', ')) : 'any domain')], ['Verified email', pol.signup.requireEmailVerification ? 'required' : 'not required'], ['Second factor', esc(pol.mfa.require) + (pol.mfa.require === 'roles' ? ': ' + esc(pol.mfa.roles.join(', ')) : '')], ['Trusted devices', pol.mfa.trustedDeviceDays + ' days']], ok: 'Save' });
        if (!ok) return;
        try {
          await App.api('PUT', '/api/admin/identity-policy/signup', pol.signup);
          const m = await App.api('PUT', '/api/admin/identity-policy/mfa', { require: pol.mfa.require, roles: pol.mfa.roles, graceDays: pol.mfa.graceDays, trustedDeviceDays: pol.mfa.trustedDeviceDays });
          st.graceRestarted = m.require !== 'off' && m.effectiveAt !== st.policy.mfa.effectiveAt;
          st.policyDirty = false;
          ctx.toast('Policy saved. Audited identity.signup_policy.updated and identity.mfa_policy.updated' + (st.graceRestarted ? ' (graceRestarted).' : '.'), 'ok', 5000);
          reload();
        } catch (e) {
          // Keep the edits on screen; what did save shows after the next load.
          App.fail(e, 'Policy not saved');
        }
      });
      ctx.on('click', '[data-approve]', async (e, t) => {
        const x = (st.signups || []).find((s) => s.userId === t.dataset.approve); if (!x) return;
        const sp = st.policy ? st.policy.signup : null;
        const ok = await ctx.confirm({ title: 'Approve ' + x.displayName, tone: 'info', body: '<p class="fg2" style="margin:0">Activates the account with the roles, clearance and workspace it was created with. The user is told by email.</p>', kv: [['Username', esc(x.username)], ['Email', esc(x.email || '') + (x.emailVerified ? ', verified' : ', not verified yet')]].concat(sp ? [['Policy roles', esc(sp.roles.join(', '))], ['Workspace', esc(wsName(sp.workspaceId))]] : []), ok: 'Approve' });
        if (ok) act(() => App.post('/api/admin/signups/' + encodeURIComponent(x.userId) + '/approve', {}), esc(x.username) + ' approved and active. Audited user.signup.approved.');
      });
      ctx.on('click', '[data-reject]', (e, t) => {
        const x = (st.signups || []).find((s) => s.userId === t.dataset.reject); if (!x) return;
        ctx.modal({ title: 'Reject ' + esc(x.displayName), body: UI.field('Reason', UI.select(['Not a known colleague', 'Duplicate of an existing account', 'Wrong tenant', 'Other'], 'Not a known colleague', 'data-rreason'), 'Sent to the user by email and kept with the sign-up.') + UI.notice('The account stays disabled. A later approval is refused (409 once decided).', 'warn'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-rgo' }),
          onMount(m) { m.querySelector('[data-rgo]').addEventListener('click', () => { const reason = m.querySelector('[data-rreason]').value; App.closeOverlay(); act(() => App.post('/api/admin/signups/' + encodeURIComponent(x.userId) + '/reject', { reason }), esc(x.username) + ' rejected. Audited user.signup.rejected.', 'warn'); }); } });
      });
      ctx.on('click', '[data-invite]', inviteModal);
      ctx.on('click', '[data-withdraw]', async (e, t) => {
        const x = (st.invites || []).find((i) => i.id === t.dataset.withdraw); if (!x) return;
        const ok = await ctx.confirm({ title: 'Withdraw the invitation?', tone: 'danger', body: '<p class="fg2" style="margin:0">The link stops working at once. Audited user.invitation.revoked.</p>', kv: [['Email', esc(x.email)], ['Workspace', esc(wsName(x.workspaceId))]], ok: 'Withdraw' });
        if (ok) act(() => App.del('/api/invitations/' + encodeURIComponent(x.id)), 'Invitation withdrawn.');
      });
      ctx.on('click', '[data-import]', () => importModal(null));
      ctx.on('click', 'tr[data-import-row]', (e, t) => {
        if (e.target.closest('button')) return;
        const id = t.dataset.importRow; st.importSel = id; ctx.rerender();
        const x = (st.imports || []).find((i) => i.id === id);
        if (x && (x.state === 'queued' || x.state === 'running')) watchImport(id);
      });
      ctx.on('click', '[data-applyimport]', async () => {
        const id = st.importSel; const d = st.importDetail[id]; const kept = st.csvs[id];
        if (!d) return;
        if (!kept) { importModal({ csv: '', dry: false, note: 'The file of a dry run is not kept. Choose it again to apply the accepted rows.' }); return; }
        const s0 = d.summary || {};
        const ok = await ctx.confirm({ title: 'Apply the accepted rows', tone: 'info', body: '<p class="fg2" style="margin:0">The same file runs again for real: accounts first, then mappings, then memberships; each change audited with via: import. Conflicts and errors are skipped.</p>', kv: [['Create', String(s0.create || 0)], ['Update', String(s0.update || 0)], ['Skipped', String((s0.conflict || 0) + (s0.error || 0))]], ok: 'Apply' });
        if (!ok) return;
        try { const r = await postCsv(kept.csv, false, kept.sendInvites); st.csvs[r.id] = kept; st.importSel = r.id; ctx.toast('Import queued. Audited user.import.requested.', 'ok'); reload(); watchImport(r.id); }
        catch (e) { App.fail(e, 'Import not queued'); }
      });
      ctx.on('click', '[data-checkaccount]', checkAccountModal);
      ctx.on('click', '[data-rmdid]', async (e, t) => {
        const d = (st.dids || []).find((x) => x.id === t.dataset.rmdid); if (!d) return;
        const ok = await ctx.confirm({ title: 'Remove the binding for ' + d.username + '?', tone: 'danger', body: '<p class="fg2" style="margin:0">The DID no longer signs in as this user. With boundOnly on the store, it is refused entirely.</p>', kv: [['DID', '<span class="mono" style="overflow-wrap:anywhere">' + esc(d.did) + '</span>'], ['Handle', esc(d.handle || 'none')]], ok: 'Remove binding' });
        if (ok) act(() => App.del('/api/admin/atproto/accounts/' + encodeURIComponent(d.id)), 'Binding removed. Audited atproto.did.removed.');
      });
      ctx.on('click', '[data-addstore]', () => ctx.navigate('directories', { tab: 'stores', add: 'github' }));
      ctx.on('click', '[data-storedetail]', (e, t) => {
        const p = (st.stores || []).find((x) => x.id === t.dataset.storedetail); if (!p) return;
        const up = st.upstream.find((u) => u.id === p.id);
        ctx.drawer({ title: esc(p.name) + ' ' + UI.pill(p.kind, 'outline'),
          body: UI.kv([['Protocol', esc(p.kind)], ['State', UI.pill(p.enabled ? 'enabled' : 'disabled', p.enabled ? 'ok' : '')], ['Reachability', esc(up ? up.reach : 'checked per account')], ['Used by', esc(up ? up.usedBy : (st.dids || []).filter((d) => d.verified).length + ' bound users')]], 1)
            + '<div class="eyebrow">Configuration</div>' + UI.code(JSON.stringify(p.config, null, 2), 'json')
            + (p.kind === 'github' ? UI.notice('Register the OAuth app\'s callback as <span class="mono">' + esc(ov.issuer.replace(/\/$/, '')) + '/federation/github/callback</span>. The client secret is a secret reference; the access token is never stored. Organisations become groups org and teams org/team-slug.', 'info') : UI.notice('Sign-in is an OAuth flow with PAR, PKCE and DPoP against the account\'s authorization server; the PDS confirms the session for the same DID. Tokens are revoked afterwards, never stored.', 'info'))
            + '<div data-storeout></div><div class="hstack wrap gap6">' + UI.btn('Test connection', { size: 'sm', icon: 'play', attrs: 'data-storetest' }) + UI.btn(p.enabled ? 'Disable store' : 'Enable store', { size: 'sm', kind: p.enabled ? 'danger' : '', attrs: 'data-storetoggle' }) + UI.btn('Edit in User stores', { size: 'sm', kind: 'ghost', attrs: 'data-storeedit' }) + '</div>',
          actions: UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(d) {
            d.querySelector('[data-storetest]').addEventListener('click', async () => { const out = d.querySelector('[data-storeout]'); out.innerHTML = UI.notice('Testing…', 'info'); try { const r = await App.post('/api/admin/identity-providers/' + encodeURIComponent(p.id) + '/test'); out.innerHTML = UI.notice(r.ok ? 'Connection test passed.' : 'Connection test failed.', r.ok ? 'ok' : 'danger') + stepsHtml(r.steps || []); } catch (err) { out.innerHTML = UI.notice(problemText(err), 'danger'); } });
            d.querySelector('[data-storetoggle]').addEventListener('click', () => { App.closeOverlay(); act(() => App.patch('/api/admin/identity-providers/' + encodeURIComponent(p.id), { enabled: !p.enabled }), esc(p.name) + (p.enabled ? ' disabled. It leaves the sign-in options at once.' : ' enabled.'), p.enabled ? 'warn' : 'ok'); });
            d.querySelector('[data-storeedit]').addEventListener('click', () => { App.closeOverlay(); ctx.navigate('directories', { tab: 'stores', store: p.id }); });
          } });
      });

      // ----- handlers -----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; delete ctx.params.tab; ctx.rerender(); });
      ctx.on('click', 'tr[data-client]', (e, t) => { st.client = t.dataset.client; delete ctx.params.client; ctx.rerender(); });
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-q]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', '[data-create]', createClient);
      ctx.on('click', '[data-rotatekey]', rotateKey);
      ctx.on('click', '[data-saml]', samlImport);
      ctx.on('click', '[data-upstream]', upstreamModal);
      ctx.on('click', '[data-testlogin]', testLogin);
      ctx.on('click', '[data-idcopy]', (e, t) => copy(t.dataset.idcopy, t.dataset.what || 'Value', ctx));
      ctx.on('click', '[data-idpmeta]', () => window.open(ov.idp.metadataUrl, '_blank', 'noopener'));
      ctx.on('click', '[data-samlenable]', (e, t) => {
        const s = st.sps.find((x) => x.id === t.dataset.samlenable);
        if (!s) return;
        const expired = !s.cert || s.cert.expired;
        ctx.confirm({ title: 'Enable ' + esc(s.name), tone: 'info', body: '<p class="fg2" style="margin:0">' + (expired && s.signedRequests ? 'Its signing certificate ' + (s.cert ? 'expired on ' + esc(date(s.cert.validTo)) : 'is missing') + '. Upload fresh metadata first, or enable with signed requests off.' : 'Assertions are issued to it again from the next sign-in.') + '</p>', ok: expired && s.signedRequests ? 'Enable anyway' : 'Enable' })
          .then((ok) => { if (!ok) return; act(() => App.patch('/api/admin/federation/saml/sps/' + encodeURIComponent(s.id), expired && s.signedRequests ? { status: 'active', signedRequests: false } : { status: 'active' }), esc(s.name) + ' enabled. Audit event written.', expired ? 'warn' : 'ok'); });
      });
      ctx.on('click', '[data-samlenc]', (e, t) => {
        const s = st.sps.find((x) => x.id === t.dataset.samlenc);
        if (!s) return;
        ctx.confirm({ title: (s.encryptAssertions ? 'Stop encrypting for ' : 'Encrypt assertions for ') + esc(s.name), tone: s.encryptAssertions ? 'danger' : 'info', body: '<p class="fg2" style="margin:0">' + (s.encryptAssertions ? 'Assertions stay signed but travel readable through the browser.' : 'Assertions are encrypted for its certificate (AES-256-GCM, RSA-OAEP). The application must be able to decrypt them.') + '</p>', kv: [['Encryption certificate', esc(certText(s.encryptionCert))]], ok: s.encryptAssertions ? 'Stop encrypting' : 'Encrypt' })
          .then((ok) => { if (!ok) return; act(() => App.patch('/api/admin/federation/saml/sps/' + encodeURIComponent(s.id), { encryptAssertions: !s.encryptAssertions }), esc(s.name) + (s.encryptAssertions ? ' gets signed assertions only.' : ' gets encrypted assertions.') + ' Audit event written.', s.encryptAssertions ? 'warn' : 'ok'); });
      });
      ctx.on('click', '[data-propapprove]', (e, t) => { const x = proposals.find((p) => p.id === t.dataset.propapprove); if (!x) return; ctx.confirm({ title: 'Approve: ' + esc(x.name), tone: 'info', body: '<p class="fg2" style="margin:0;overflow-wrap:anywhere">' + esc(x.summary || '') + '</p>', ok: 'Approve and apply' }).then((ok) => { if (ok) act(() => App.post('/api/admin/federation/proposals/' + encodeURIComponent(x.id) + '/approve', {}), 'Approved and applied. Audit entry written.'); }); });
      ctx.on('click', '[data-propreject]', (e, t) => { const x = proposals.find((p) => p.id === t.dataset.propreject); if (!x) return; ctx.confirm({ title: 'Reject: ' + esc(x.name), tone: 'danger', body: '<p class="fg2" style="margin:0">Nothing changes. ' + (x.proposedBy ? 'The admin who proposed it can propose it again.' : 'The next metadata refresh proposes it again if the source still differs.') + '</p>', ok: 'Reject' }).then((ok) => { if (ok) act(() => App.post('/api/admin/federation/proposals/' + encodeURIComponent(x.id) + '/reject', {}), 'Rejected.'); }); });
      ctx.on('click', '[data-propwithdraw]', (e, t) => act(() => App.post('/api/admin/federation/proposals/' + encodeURIComponent(t.dataset.propwithdraw) + '/withdraw', {}), 'Withdrawn.'));
      ctx.on('click', '[data-metarefresh]', (e, t) => act(() => App.post('/api/admin/federation/metadata/' + encodeURIComponent(t.dataset.metarefresh) + '/refresh', {}), (r) => (r.state === 'unchanged' ? 'Metadata fetched; nothing changed.' : r.state === 'error' ? 'The fetch failed: ' + esc(r.error || '') : 'The metadata changed. The change waits for approval above.'), undefined));
      ctx.on('click', '[data-samlsignresp]', (e, t) => { const x = st.sps.find((y) => y.id === t.dataset.samlsignresp); if (!x) return; act(() => App.patch('/api/admin/federation/saml/sps/' + encodeURIComponent(x.id), { signResponse: !x.signResponse }), esc(x.name) + (x.signResponse ? ' gets a signed assertion in an unsigned response.' : ' gets the whole response signed, as well as the assertion.')); });
      ctx.on('click', '[data-consent]', (e, t) => { const k = t.dataset.consent; const patch = {}; patch[k] = !ov.settings.consent[k]; act(() => App.patch('/api/admin/federation/settings', { consent: patch }), 'Consent policy saved. Audit event written.'); });
      if (client) {
        const base = '/api/admin/federation/oidc/clients/' + encodeURIComponent(client.id);
        ctx.on('click', '[data-copysecret]', () => { const sec = st.fresh[client.id]; if (!sec) return; const done = () => { delete st.fresh[client.id]; ctx.rerender(); ctx.toast('Secret copied. It is no longer shown here.', 'ok'); }; if (navigator.clipboard) navigator.clipboard.writeText(sec).then(done, () => ctx.toast('Copy failed; select the secret instead.', 'warn')); else ctx.toast('Copy is not available here; select the secret instead.', 'warn'); });
        ctx.on('click', '[data-rotatesecret]', () => ctx.confirm({ title: 'Rotate secret', tag: 'breaks running jobs', tone: 'danger', body: '<p class="fg2" style="margin:0">The current secret stops working immediately. Update ' + esc(client.name) + ' with the new one, which is shown once.</p>', kv: [['Client', esc(client.name)], ['Last used', esc(when(client.lastUsedAt))]], ok: 'Rotate' }).then((ok) => { if (!ok) return; act(async () => { const r = await App.post(base + '/secret'); st.fresh[client.id] = r.secret; return r; }, 'Secret rotated. Copy it now.'); }));
        ctx.on('click', '[data-pkce]', (e, t) => { if (t.hasAttribute('data-na')) { ctx.toast(client.type === 'public' ? 'Public clients always require PKCE.' : 'PKCE does not apply to client credentials.'); return; } act(() => App.patch(base, { pkceRequired: !client.pkceRequired }), 'PKCE ' + (client.pkceRequired ? 'optional' : 'required') + ' for ' + esc(client.name) + '.'); });
        ctx.on('click', '[data-dpop]', () => act(() => App.patch(base, { dpopRequired: !client.dpopRequired }), client.dpopRequired ? 'DPoP optional for ' + esc(client.name) + '.' : 'DPoP required for ' + esc(client.name) + '. Token requests without a proof are refused.'));
        ctx.on('click', '[data-introspect]', (e, t) => {
          if (t.dataset.introspect === 'own') { act(() => App.post(base + '/introspect', { mode: 'own' }), esc(client.name) + ' introspects its own tokens only.'); return; }
          ctx.confirm({ title: 'Make ' + esc(client.name) + ' a resource server', tag: 'needs a second admin', tone: 'info', body: '<p class="fg2" style="margin:0">It will be able to introspect access tokens issued to every client in this tenant, to validate them. A second identity admin must approve before it applies.</p>', ok: 'Propose' })
            .then((ok) => { if (ok) act(() => App.post(base + '/introspect', { mode: 'any' }), 'Proposed. It applies when a second identity admin approves.'); });
        });
        ctx.on('click', '[data-par]', () => act(() => App.patch(base, { parRequired: !client.parRequired }), client.parRequired ? 'Pushed requests optional for ' + esc(client.name) + '.' : 'Pushed requests required for ' + esc(client.name) + '.'));
        ctx.on('click', '[data-disable]', () => ctx.confirm({ title: 'Disable ' + esc(client.name), tag: 'revokes tokens', tone: 'danger', body: '<p class="fg2" style="margin:0">Every access and refresh token for this client is revoked. Users see a sign-in prompt on their next request.</p>', ok: 'Disable' }).then((ok) => { if (!ok) return; act(() => App.post(base + '/disable'), (r) => esc(client.name) + ' disabled. ' + r.revoked + ' refresh token' + (r.revoked === 1 ? '' : 's') + ' revoked; audit event written.', 'warn'); }));
        ctx.on('click', '[data-enable]', () => ctx.confirm({ title: 'Enable ' + esc(client.name), tone: 'info', body: '<p class="fg2" style="margin:0">The client can request tokens again. Tokens revoked when it was disabled stay revoked.</p>', ok: 'Enable' }).then((ok) => { if (!ok) return; act(() => App.post(base + '/enable'), esc(client.name) + ' enabled. Audit event written.'); }));
        ctx.on('click', '[data-edit]', () => ctx.modal({ title: 'Edit ' + esc(client.name),
          body: '<div class="formgrid">' + UI.field('Access token lifetime', UI.select(['5 min', '10 min', '30 min'], Math.round(client.accessTtl / 60) + ' min', 'data-elife')) + UI.field('Allowed models', UI.input(client.models || '', { attrs: 'data-emodels', placeholder: 'per profile' })) + UI.field('Scopes', UI.input(client.scopes.join(' '), { attrs: 'data-escopes' })) + UI.field('Redirect URIs', UI.textarea(client.redirectUris.join('\n'), { rows: 2, attrs: 'data-eredir' }))
            + UI.field('Post-logout redirect URIs', UI.textarea(client.postLogoutRedirectUris.join('\n'), { rows: 2, attrs: 'data-epost' })) + UI.field('Front-channel logout URI', UI.input(client.frontchannelLogoutUri || '', { attrs: 'data-efront' }), 'Loaded in a hidden frame on the signed-out page, with iss and sid.') + UI.field('Back-channel logout URI', UI.input(client.backchannelLogoutUri || '', { attrs: 'data-eback' }), 'Receives a signed logout token. Must be an internal host.')
            + '<div class="span2">' + UI.field('Request object keys (JWKS)', UI.textarea('', { rows: 3, placeholder: client.jwks.length ? 'Leave empty to keep the ' + client.jwks.length + ' registered key' + (client.jwks.length === 1 ? '' : 's') + '; paste a new JWKS to replace them' : '{"keys":[{"kty":"EC","crv":"P-256","x":"…","y":"…","kid":"…"}]}', attrs: 'data-ejwks' }), 'Public keys only. Signed request objects (RFC 9101) must verify with one of them.') + (client.jwks.length ? UI.check('Remove the registered keys', false, 'data-ejwksclear') : '') + '</div></div><div data-eerr></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-esave' }),
          onMount(m) {
            m.querySelector('[data-esave]').addEventListener('click', async () => {
              const body = { accessTtl: parseInt(m.querySelector('[data-elife]').value, 10) * 60, models: m.querySelector('[data-emodels]').value.trim() || null, scopes: m.querySelector('[data-escopes]').value.split(/\s+/).filter(Boolean), redirectUris: m.querySelector('[data-eredir]').value.split('\n').map((s) => s.trim()).filter(Boolean), postLogoutRedirectUris: m.querySelector('[data-epost]').value.split('\n').map((s) => s.trim()).filter(Boolean), frontchannelLogoutUri: m.querySelector('[data-efront]').value.trim() || null, backchannelLogoutUri: m.querySelector('[data-eback]').value.trim() || null };
              const jwksText = m.querySelector('[data-ejwks]').value.trim();
              const clear = m.querySelector('[data-ejwksclear]');
              if (jwksText) { try { body.jwks = JSON.parse(jwksText); } catch (e) { m.querySelector('[data-eerr]').innerHTML = UI.notice('The key set is not valid JSON.', 'danger'); return; } } else if (clear && (clear.querySelector('input') ? clear.querySelector('input').checked : clear.checked)) body.jwks = null;
              try { await App.patch(base, body); App.closeOverlay(); ctx.toast('Client saved. Existing tokens keep their scopes until they expire.', 'ok'); reload(); } catch (err) { m.querySelector('[data-eerr]').innerHTML = UI.notice('<b>Not saved.</b> ' + esc(err.message) + (err.problem && err.problem.errors ? ' ' + esc(err.problem.errors.map((x) => x.path + ': ' + x.message).join('; ')) : ''), 'danger'); }
            });
          } }));
      }
      ctx.on('click', '[data-revoke]', (e, t) => {
        const s = st.sessions[+t.dataset.revoke];
        if (!s) return;
        ctx.confirm({ title: s.kind === 'service' ? 'Disable service client' : 'Revoke session', tag: 'signs out', tone: 'danger', body: '<p class="fg2" style="margin:0">' + (s.kind === 'service' ? 'Service tokens are access tokens only; disabling the client ends them now. Enable it again from the client list.' : 'Ends the session and its refresh tokens now.') + '</p>', kv: [['User', esc(s.user)], ['Client', esc(s.client)]], ok: 'Revoke' })
          .then((ok) => { if (!ok) return; act(() => App.post('/api/admin/federation/sessions/revoke', { kind: s.kind, id: s.id }), 'Session for ' + esc(s.user) + ' revoked.'); });
      });
      ctx.on('click', '[data-gotenants]', () => ctx.navigate('tenants', { tab: 'sessions' }));
      ctx.on('click', '[data-gousers]', () => ctx.navigate('directories', { tab: 'users' }));
      ctx.on('click', '[data-gozones]', () => ctx.navigate('zones', { zone: 'directory' }));
      ctx.on('click', '[data-goplatform]', () => ctx.navigate('platform', { tab: 'secrets' }));
    }
  });
})();
