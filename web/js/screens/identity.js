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
  const copy = (text, what, ctx) => { if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => ctx.toast(esc(what) + ' copied.', 'ok'), () => ctx.toast('Copy failed; select the text instead.', 'warn')); else ctx.toast('Copy is not available here; select the text instead.', 'warn'); };

  App.register({
    id: 'identity', title: 'Identity', section: 'admin', live: true, summary: 'OIDC clients, SAML providers, scopes and consent, signing keys, upstream federation',
    crumb: ['Admin', 'Identity'],
    commands: [
      { label: 'Create an OIDC client', sub: 'Identity', run(app) { app.stateFor('identity').openCreate = true; app.render(); } },
      { label: 'Rotate the signing key', sub: 'Identity', run(app) { app.stateFor('identity').tab = 'keys'; app.stateFor('identity').openRotate = true; app.render(); } }
    ],
    states: [
      { title: 'After the reveal', tone: 'neutral', text: 'The secret field shows only its creation date and a rotate action.', apply(ctx) { const st = ctx.state; st.tab = 'clients'; const c = (st.clients || []).find((x) => x.confidential); if (c) { st.client = c.id; delete st.fresh[c.id]; } ctx.rerender(); } },
      { title: 'Key nearing expiry', tone: 'warn', text: '14 days before rotation a banner appears. The new key is published to JWKS before it signs.', apply(ctx) { ctx.state.tab = 'keys'; ctx.state.keyExpiring = true; ctx.rerender(); } },
      { title: 'Upstream federation', tone: 'info', text: 'Only on-prem identity providers can be added. Cloud providers are unreachable from this network.', apply(ctx) { ctx.state.tab = 'upstream'; ctx.state.openUpstream = true; ctx.rerender(); } },
      { title: 'SAML metadata import', tone: 'neutral', text: 'Parsed entity ID, ACS URLs and certificate are shown for review before saving.', apply(ctx) { ctx.state.tab = 'saml'; ctx.state.openSaml = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'clients'; st.fresh = st.fresh || {}; st.q = st.q || '';
      if (ctx.params.tab) st.tab = ctx.params.tab;

      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/admin/federation'), App.get('/api/admin/federation/oidc/clients'), App.get('/api/admin/federation/saml/sps'), App.get('/api/admin/federation/upstream'), App.get('/api/admin/federation/sessions'), App.get('/api/admin/federation/scopes'), App.get('/api/admin/federation/keys'), App.get('/api/admin/federation/proposals?state=pending'), App.get('/api/admin/federation/metadata')])
          .then(([overview, clients, sps, upstream, sessions, scopes, keys, proposals, sources]) => { Object.assign(st, { overview, clients, sps, upstream, sessions, scopes, jwks: keys.jwks, proposals, sources, loaded: true, loadError: null }); })
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

      const tabs = UI.tabs([{ id: 'clients', label: 'OIDC clients', count: clients.length }, { id: 'saml', label: 'SAML service providers', count: st.sps.length }, { id: 'scopes', label: 'Scopes and consent' }, { id: 'keys', label: 'Keys' }, { id: 'upstream', label: 'Upstream federation' }, { id: 'sessions', label: 'Sessions' }], st.tab);
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
        body = '<div class="hstack"><span class="fg2">Optional federation: this issuer acts as OIDC relying party or SAML service provider to an on-prem identity provider.</span><span class="right">' + UI.btn('Add upstream provider', { size: 'sm', icon: 'plus', attrs: 'data-upstream' }) + '</span></div>'
          + UI.table(['Provider', 'Protocol', 'Reachability', 'Status', 'Used by', 'Metadata'], st.upstream.map((u) => ['<b>' + esc(u.name) + '</b>', esc(u.protocolLabel), esc(u.reach), UI.pill(u.status, u.status === 'connected' ? 'ok' : u.status === 'disabled' ? '' : 'danger'), esc(u.usedBy), u.protocol === 'saml' ? sourceCell(u.id) : '<span class="muted">discovery</span>']), { clickable: false, minWidth: '640px', emptyTitle: 'No upstream providers', emptyText: 'Users sign in with the user stores. Add an on-prem OIDC or SAML provider to federate.' })
          + '<div class="grid2">' + UI.panel('Primary authentication', UI.kv([['Kerberos SPNEGO', k.available && k.enabled ? esc(k.detail) + (k.realms.length ? ', realms ' + esc(k.realms.join(', ')) : ', any realm') : k.enabled ? 'not available: ' + esc(k.detail) : 'turned off for this tenant'], ['LDAP bind', 'LDAPS or StartTLS to the directory; never a clear bind'], ['Second factor', 'WebAuthn passkeys and TOTP, required for admin roles, also after Kerberos and upstream sign-in'], ['Device flow', 'RFC 8628 at <span class="mono">' + esc(ov.device.verificationUri) + '</span>, codes live ' + ov.device.minutes + ' min'], ['Fallback order', 'Kerberos, then upstream or password, then MFA']], 1) + '<div>' + UI.btn('Test a login', { size: 'sm', attrs: 'data-testlogin' }) + '</div>')
          + UI.panel('Air gap', UI.notice('Cloud identity providers are unreachable from this network. Only on-prem providers on internal addresses' + (ov.upstream.allowList ? ', or hosts on the allow-list (' + esc(ov.upstream.allowList) + '),' : '') + ' can be upstream.', 'info') + UI.kv([['OIDC redirect URI', '<span class="mono">' + esc(ov.upstream.redirectUri) + '</span>'], ['SAML ACS URL', '<span class="mono">' + esc(ov.upstream.acsUrl) + '</span>'], ['SAML single logout', '<span class="mono">' + esc(ov.upstream.sloUrl) + '</span>']], 1) + '<div>' + UI.btn('Open zones', { size: 'sm', kind: 'ghost', attrs: 'data-gozones' }) + '</div>') + '</div>';
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
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
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
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
