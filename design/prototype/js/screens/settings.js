(function () {
  const { UI, esc, DATA } = App;

  const ACCOUNTS0 = [
    { id: 'gitlab', system: 'GitLab on-prem', scopes: 'read_api, write_repository', last: 'today 11:40', state: 'connected', tools: 'gitlab.create_mr, gitlab.read_file', vault: 'vault/users/mokafor/gitlab' },
    { id: 'jira', system: 'Jira internal', scopes: 'read, write:issue', last: 'today 14:02', state: 'connected', tools: 'jira-internal.create_issue, jira-internal.search', vault: 'vault/users/mokafor/jira' },
    { id: 'erp', system: 'ERP', scopes: 'ledger:read, cards:read', last: '', state: 'not connected', tools: 'ledger.query, cards.query', vault: 'vault/users/mokafor/erp' }
  ];
  const KEYS0 = [
    { id: 'k1', name: 'notebook-laptop', scopes: 'inference:invoke', models: 'analyst, fast', expires: '18 Dec 2026', last: '1 h ago', state: 'active', prefix: 'exai_k1_7f3a' },
    { id: 'k2', name: 'close-scripts', scopes: 'chat:write context:read', models: 'any allowed', expires: 'expired 1 Sep', last: '20 d ago', state: 'expired', prefix: 'exai_k2_0c91', gone: '1 Oct' }
  ];
  const SESSIONS0 = [
    { id: 's1', client: 'This browser', how: 'Kerberos SSO', zone: 'office', started: 'today 08:52', last: 'now', current: true },
    { id: 's2', client: 'exprsn-cli on build-03', how: 'device code', zone: 'build', started: '2 d ago', last: '35 min ago' },
    { id: 's3', client: 'Firefox on laptop-mo', how: 'LDAP password and passkey', zone: 'vpn', started: 'Mon 19:10', last: 'Mon 21:44' }
  ];
  const OWN_SCOPES = ['chat:read', 'chat:write', 'inference:invoke', 'context:read', 'context:write', 'images:generate', 'tools:invoke', 'agents:run', 'models:read'];
  const NOTIFS = [['jobs', 'Finished jobs and workflow runs', true], ['approvals', 'Approvals waiting for me', true], ['flags', 'New flags in my queues', true], ['quota', 'Quota warnings', false]];

  const applyContrast = (mode) => {
    const r = document.documentElement.style;
    if (mode === 'AAA') { r.setProperty('--muted', 'var(--fg2)'); r.setProperty('--line', 'var(--muted)'); r.setProperty('--faint', 'var(--muted)'); r.setProperty('--shadow', 'none'); }
    else { r.removeProperty('--muted'); r.removeProperty('--line'); r.removeProperty('--faint'); r.removeProperty('--shadow'); }
  };

  App.register({
    id: 'settings', title: 'Settings', summary: 'Profile, appearance, notifications, connected accounts, API keys, sessions', crumb: ['Settings'],
    commands: [{ label: 'Create an API key', sub: 'Settings', run(app) { app.stateFor('settings').openCreate = true; app.render(); } }],
    states: [
      { title: 'Key revealed once', tone: 'warn', text: 'The new key is shown once with a copy action. Afterwards only its name, scopes and dates remain.', apply(ctx) { const st = ctx.state; st.keys = st.keys || KEYS0.map((k) => Object.assign({}, k)); if (!st.keys.some((k) => k.id === 'k3')) st.keys.unshift({ id: 'k3', name: 'notebook-desk', scopes: 'inference:invoke chat:read', models: 'analyst', expires: '19 Mar 2027', last: 'never', state: 'active', prefix: 'exai_k3_4d2e' }); st.revealed = { name: 'notebook-desk', key: 'exai_k3_4d2e9b1f7c0a5e83d6f2b4a19c7e0d5f' }; ctx.rerender(); } },
      { title: 'Re-consent needed', tone: 'warn', text: 'GitLab revoked the grant. The row shows reconnect and tools that depend on it are paused.', apply(ctx) { const st = ctx.state; st.accounts = st.accounts || ACCOUNTS0.map((a) => Object.assign({}, a)); st.accounts.find((a) => a.id === 'gitlab').state = 're-consent needed'; ctx.rerender(); } },
      { title: 'Key expired', tone: 'neutral', text: 'Expired keys stay listed for 30 days for audit, then disappear.', apply(ctx) { ctx.state.expiredNote = true; ctx.rerender(); } },
      { title: 'AAA mode', tone: 'info', text: 'Switching to AAA previews the change immediately and persists per user.', apply(ctx) { ctx.state.contrast = 'AAA'; applyContrast('AAA'); ctx.rerender(); ctx.toast('AAA contrast on. Saved to your profile.', 'ok'); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.accounts = st.accounts || ACCOUNTS0.map((a) => Object.assign({}, a));
      st.keys = st.keys || KEYS0.map((k) => Object.assign({}, k));
      st.sessions = st.sessions || SESSIONS0.map((s) => Object.assign({}, s));
      st.notifs = st.notifs || NOTIFS.reduce((o, n) => { o[n[0]] = n[2]; return o; }, {});
      st.contrast = st.contrast || 'AA'; st.language = st.language || 'English (UK)';
      if (ctx.params.tab === 'keys') { st.openCreate = true; delete ctx.params.tab; }
      const theme = App.state.theme === 'dark' ? 'Dark' : App.state.theme === 'light' ? 'Light' : 'Follow system';
      const u = DATA.user;

      const profile = UI.panel('Profile', UI.kv([['Name', esc(u.name)], ['Directory account', '<span class="mono">' + esc(u.username) + '</span>'], ['Clearance', UI.label(u.clearance, { sm: true })], ['Roles', esc(u.roles.map((r) => r.toLowerCase()).join(', '))]], 2)
        + '<div class="muted" style="font-size:12px">Name, account, clearance and roles come from OpenLDAP group mappings and cannot be edited here. Ask an identity admin to change them.</div>', { actions: UI.btn('Identity', { kind: 'ghost', size: 'sm', attrs: 'data-goidentity' }) });

      const appearance = UI.panel('Appearance', '<div class="formgrid" style="--cols:3">' + UI.field('Theme', UI.select(['Follow system', 'Light', 'Dark'], theme, 'data-theme')) + UI.field('Contrast', UI.select(['AA (default)', 'AAA'], st.contrast === 'AAA' ? 'AAA' : 'AA (default)', 'data-contrast')) + UI.field('Language', UI.select(['English (UK)', 'English (US)', 'Deutsch', 'Français'], st.language, 'data-language')) + '</div>'
        + '<span class="muted" style="font-size:12px">AAA mode raises contrast and removes glass surfaces.</span>'
        + (st.contrast === 'AAA' ? UI.notice('<b>AAA contrast is on.</b> Muted text, borders and shadows now use the stronger tokens. Saved to your profile and applied on every device you sign in from.', 'info') : ''));

      const notifs = UI.panel('Notifications', '<div class="vstack gap6">' + NOTIFS.map((n) => UI.check(n[1], st.notifs[n[0]], 'data-notif="' + n[0] + '"')).join('') + '</div>'
        + '<span class="muted" style="font-size:12px">Delivered in the console over /ws' + (st.notifs.jobs || st.notifs.approvals ? ', and by email for approvals where the tenant allows it' : '') + '.</span>');

      const acctRows = st.accounts.map((a) => {
        const connected = a.state === 'connected';
        const reconsent = a.state === 're-consent needed';
        const scopes = connected || reconsent ? '<span class="mono">' + esc(a.scopes) + '</span>' : '<span class="muted" style="font-size:12px">not connected</span>';
        const action = connected ? UI.btn('Disconnect', { kind: 'ghost', size: 'sm', attrs: 'data-disconnect="' + a.id + '"' }) : reconsent ? UI.pill('re-consent needed', 'warn') + ' ' + UI.btn('Reconnect', { kind: 'primary', size: 'sm', attrs: 'data-connect="' + a.id + '"' }) : UI.btn('Connect', { size: 'sm', attrs: 'data-connect="' + a.id + '"' });
        return { cells: [esc(a.system), scopes, connected ? esc(a.last) : reconsent ? '<span style="color:var(--warn-fg)">grant revoked ' + esc(a.last.replace('today', 'today')) + '</span>' : '', '<span class="hstack gap6" style="justify-content:flex-end">' + action + '</span>'], attrs: 'data-account="' + a.id + '"' };
      });
      const reconsent = st.accounts.find((a) => a.state === 're-consent needed');
      const accounts = UI.panel('Connected accounts', (reconsent ? UI.notice('<b>' + esc(reconsent.system) + ' revoked the grant.</b> Tools that depend on it are paused until you reconnect: <span class="mono">' + esc(reconsent.tools) + '</span>. Agents that call them get a clear refusal, not a stale token.', 'warn') : '')
        + UI.table(['System', 'Scopes', 'Last used', { label: '', right: true }], acctRows, { minWidth: '0', cls: 'bare' })
        + '<span class="muted" style="font-size:12px">Tokens are held in the vault and are never placed in model context.</span>');

      const keyRows = st.keys.map((k) => {
        const expired = k.state === 'expired'; const revoked = k.state === 'revoked';
        const action = expired ? UI.pill('expired', 'warn') : revoked ? UI.pill('revoked', 'danger') : UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-revoke="' + k.id + '"' });
        return { cells: [esc(k.name), '<span class="mono">' + esc(k.scopes) + '</span>', esc(k.models), expired ? '<span style="color:var(--warn-fg)">' + esc(k.expires) + '</span>' : esc(k.expires), esc(k.last), '<span class="hstack" style="justify-content:flex-end">' + action + '</span>'], attrs: 'data-key="' + k.id + '"', selected: !!(st.expiredNote && expired) };
      });
      const keys = UI.panel('API keys', '<div>' + UI.btn('Create key', { kind: 'primary', size: 'sm', icon: 'key', attrs: 'data-create' }) + '</div>'
        + (st.revealed ? UI.notice('<b>Key <span class="mono">' + esc(st.revealed.name) + '</span> created. Copy it now; it is shown once.</b><div class="mono" style="margin-top:4px;overflow-wrap:anywhere">' + esc(st.revealed.key) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copy="' + esc(st.revealed.key) + '"' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-revealdone' })) : '')
        + (st.expiredNote ? UI.notice('<b>close-scripts expired on 1 Sep.</b> Expired keys stay listed for 30 days for audit, then disappear. This one leaves the list on 1 Oct. Calls made with it get <span class="mono">401 invalid_token</span>.', 'info') : '')
        + UI.table(['Name', 'Scopes', 'Models', 'Expires', 'Last used', { label: '', right: true }], keyRows, { minWidth: '0', cls: 'bare' })
        + '<span class="muted" style="font-size:12px">Keys work as the bearer token for OpenAI-compatible SDKs and the CLI. Each key carries a subset of your own scopes.</span>');

      const sessions = UI.panel('Sessions', UI.table(['Client', 'Signed in with', 'Zone', 'Started', 'Last activity', { label: '', right: true }], st.sessions.map((s) => ({ cells: [esc(s.client) + (s.current ? ' ' + UI.pill('this session', 'accent') : ''), esc(s.how), '<span class="mono">' + esc(s.zone) + '</span>', esc(s.started), esc(s.last), '<span class="hstack" style="justify-content:flex-end">' + (s.current ? '' : UI.btn('Sign out', { kind: 'ghost', size: 'sm', attrs: 'data-endsession="' + s.id + '"' })) + '</span>'], attrs: 'data-session="' + s.id + '"' })), { minWidth: '0', cls: 'bare', emptyTitle: 'No other sessions', emptyText: '' })
        + '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">Signing out revokes this session\'s refresh token at the identity service. The LDAP sync does the same for disabled accounts.</span>' + UI.btn('Sign out everywhere', { kind: 'ghost', size: 'sm', attrs: 'data-signoutall' }) + UI.btn('Sign out', { size: 'sm', icon: 'lock', attrs: 'data-signout' }) + '</div>');

      root.innerHTML = '<div class="page">' + UI.pagehead('Settings', 'Personal settings for ' + esc(u.name) + ' in ' + esc(DATA.tenant.workspace))
        + '<div class="grid2"><div class="vstack gap12" style="gap:14px">' + profile + appearance + notifs + '</div><div class="vstack" style="gap:14px">' + accounts + keys + '</div></div>'
        + sessions
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      // ---- events ----
      ctx.on('click', '[data-goidentity]', () => ctx.navigate('identity'));
      ctx.on('change', '[data-theme]', (e, t) => { ctx.app.setTheme(t.value === 'Dark' ? 'dark' : t.value === 'Light' ? 'light' : null); ctx.toast('Theme: ' + esc(t.value) + '. Saved to your profile.'); });
      ctx.on('change', '[data-contrast]', (e, t) => { st.contrast = t.value === 'AAA' ? 'AAA' : 'AA'; applyContrast(st.contrast); ctx.rerender(); ctx.toast(st.contrast === 'AAA' ? 'AAA contrast on. Saved to your profile.' : 'Back to AA contrast.', 'ok'); });
      ctx.on('change', '[data-language]', (e, t) => { st.language = t.value; ctx.toast('Language set to ' + esc(t.value) + '. Model answers follow the prompt language, not this setting.'); });
      ctx.on('change', '[data-notif]', (e, t) => { st.notifs[t.dataset.notif] = t.checked; ctx.toast('Notification preference saved.'); ctx.rerender(); });
      ctx.on('click', '[data-disconnect]', async (e, t) => {
        const a = st.accounts.find((x) => x.id === t.dataset.disconnect);
        const ok = await ctx.confirm({ title: 'Disconnect ' + a.system + '?', tag: 'revokes token', tone: 'danger', body: '<div class="fg2">The token is deleted from the vault and the grant is revoked at ' + esc(a.system) + '. Tools that use it will refuse until you reconnect.</div>', kv: [['Scopes', '<span class="mono">' + esc(a.scopes) + '</span>'], ['Tools affected', '<span class="mono">' + esc(a.tools) + '</span>'], ['Vault path', '<span class="mono">' + esc(a.vault) + '</span>'], ['Acting as', esc(u.name)]], ok: 'Disconnect' });
        if (!ok) return; a.state = 'not connected'; a.last = ''; ctx.rerender(); ctx.toast(esc(a.system) + ' disconnected. Token removed from the vault and audit entry written.', 'ok');
      });
      ctx.on('click', '[data-connect]', (e, t) => {
        const a = st.accounts.find((x) => x.id === t.dataset.connect);
        ctx.modal({ title: (a.state === 're-consent needed' ? 'Reconnect ' : 'Connect ') + esc(a.system), body: '<div class="fg2">' + esc(a.system) + ' will ask you to sign in and approve these scopes. The token comes back to the vault at <span class="mono">' + esc(a.vault) + '</span> and is used only by tools acting as you.</div>' + '<div class="vstack gap6">' + a.scopes.split(', ').map((s) => UI.check(s, true, 'disabled')).join('') + '</div>' + UI.kv([['Tools that will work', '<span class="mono">' + esc(a.tools) + '</span>'], ['Label ceiling', UI.label(u.clearance, { sm: true })]], 2), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Continue to ' + a.system, { kind: 'primary', attrs: 'data-close data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { a.state = 'connected'; a.last = 'just now'; ctx.rerender(); ctx.toast(esc(a.system) + ' connected. Token stored in the vault.', 'ok'); }); } });
      });
      ctx.on('click', '[data-revoke]', async (e, t) => {
        const k = st.keys.find((x) => x.id === t.dataset.revoke);
        const ok = await ctx.confirm({ title: 'Revoke key ' + k.name + '?', tag: 'cannot be undone', tone: 'danger', body: '<div class="fg2">Clients using this key get <span class="mono">401 invalid_token</span> on their next call. The key stays listed for 30 days for audit.</div>', kv: [['Scopes', '<span class="mono">' + esc(k.scopes) + '</span>'], ['Models', esc(k.models)], ['Last used', esc(k.last)], ['Prefix', '<span class="mono">' + esc(k.prefix) + '</span>']], ok: 'Revoke key' });
        if (!ok) return; k.state = 'revoked'; k.expires = 'revoked today'; ctx.rerender(); ctx.toast('Key ' + esc(k.name) + ' revoked. Introspection now returns inactive.', 'ok');
      });
      const openCreate = () => {
        ctx.modal({ title: 'Create API key', body: UI.field('Name', UI.input('', { placeholder: 'for example notebook-desk', attrs: 'data-name' }), 'Shown in the audit log next to every call made with the key.')
          + '<div class="field"><span class="fl">Scopes, a subset of your own</span><div class="hstack wrap gap6" style="row-gap:6px">' + OWN_SCOPES.map((s) => UI.check(s, s === 'inference:invoke' || s === 'chat:read', 'data-scope="' + s + '"')).join('') + '</div></div>'
          + '<div class="formgrid">' + UI.field('Models', UI.select(['any allowed', 'analyst', 'chat-default', 'fast', 'coder', 'analyst, fast'], 'analyst', 'data-models')) + UI.field('Expires', UI.select(['30 days', '90 days', '180 days', '1 year'], '180 days', 'data-exp')) + '</div>'
          + UI.notice('The key is shown once after creation. It inherits your clearance ceiling of ' + UI.label(u.clearance, { sm: true }) + ' and is rejected in zones that do not allow it.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create key', { kind: 'primary', attrs: 'data-go' }),
          onMount(m) {
            const nameEl = m.querySelector('[data-name]'); nameEl.focus();
            m.querySelector('[data-go]').addEventListener('click', () => {
              const name = nameEl.value.trim() || 'notebook-desk'; const scopes = Array.prototype.slice.call(m.querySelectorAll('[data-scope]:checked')).map((c) => c.dataset.scope);
              if (!scopes.length) { ctx.toast('Pick at least one scope.', 'warn'); return; }
              const exp = m.querySelector('[data-exp]').value; const expires = { '30 days': '20 Oct 2026', '90 days': '19 Dec 2026', '180 days': '19 Mar 2027', '1 year': '20 Sep 2027' }[exp];
              const id = 'k' + (st.keys.length + 1); const hex = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
              st.keys.unshift({ id, name, scopes: scopes.join(' '), models: m.querySelector('[data-models]').value, expires, last: 'never', state: 'active', prefix: 'exai_' + id + '_' + hex.slice(0, 4) });
              st.revealed = { name, key: 'exai_' + id + '_' + hex }; App.closeOverlay(); ctx.rerender(); ctx.toast('Key created. Copy it now; it will not be shown again.', 'warn', 5000);
            });
          } });
      };
      ctx.on('click', '[data-create]', openCreate);
      ctx.on('click', '[data-revealdone]', () => { st.revealed = null; ctx.rerender(); });
      ctx.on('click', '[data-key]', (e, t) => { if (e.target.closest('button')) return; const k = st.keys.find((x) => x.id === t.dataset.key); ctx.drawer({ title: 'Key ' + esc(k.name) + ' ' + UI.pill(k.state), body: UI.kv([['Prefix', '<span class="mono">' + esc(k.prefix) + '…</span>'], ['Scopes', '<span class="mono">' + esc(k.scopes) + '</span>'], ['Models', esc(k.models)], ['Expires', esc(k.expires)], ['Last used', esc(k.last)], ['Clearance ceiling', UI.label(u.clearance, { sm: true })]], 2) + '<div class="eyebrow">Recent calls</div>' + UI.table(['When', 'Endpoint', 'Result'], k.state === 'expired' ? [['20 d ago', '<span class="mono">/v1/chat/completions</span>', UI.pill('401 invalid_token', 'danger')]] : [['1 h ago', '<span class="mono">/v1/chat/completions</span>', UI.pill('200', 'ok')], ['1 h ago', '<span class="mono">/v1/embeddings</span>', UI.pill('200', 'ok')], ['yesterday', '<span class="mono">/v1/chat/completions</span>', UI.pill('429 over quota', 'warn')]], { clickable: false, minWidth: '0', cls: 'bare' }), actions: UI.btn('Open in Usage and audit', { attrs: 'data-close data-goaudit' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { d.querySelector('[data-goaudit]').addEventListener('click', () => ctx.navigate('usage-audit', { key: k.name })); } }); });
      ctx.on('click', '[data-account]', (e, t) => { if (e.target.closest('button')) return; const a = st.accounts.find((x) => x.id === t.dataset.account); ctx.drawer({ title: esc(a.system) + ' ' + UI.pill(a.state), body: UI.kv([['Scopes', '<span class="mono">' + esc(a.scopes) + '</span>'], ['Vault path', '<span class="mono">' + esc(a.vault) + '</span>'], ['Tools', '<span class="mono">' + esc(a.tools) + '</span>'], ['Last used', esc(a.last || 'never')]], 1) + UI.notice('Tools receive a short-lived token minted from this grant per call. The model never sees it.', 'info'), actions: UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }) }); });
      ctx.on('click', '[data-endsession]', async (e, t) => { const s = st.sessions.find((x) => x.id === t.dataset.endsession); const ok = await ctx.confirm({ title: 'Sign out ' + s.client + '?', tag: 'revokes refresh token', tone: 'danger', kv: [['Signed in with', esc(s.how)], ['Zone', esc(s.zone)], ['Last activity', esc(s.last)]], ok: 'Sign out that session' }); if (!ok) return; st.sessions = st.sessions.filter((x) => x.id !== s.id); ctx.rerender(); ctx.toast('Session ended. Its refresh token was revoked at the identity service.', 'ok'); });
      ctx.on('click', '[data-signoutall]', async () => { const ok = await ctx.confirm({ title: 'Sign out everywhere?', tag: 'all sessions', tone: 'danger', body: '<div class="fg2">Every session and refresh token for <span class="mono">' + esc(u.username) + '</span> is revoked, including this one. API keys are not affected.</div>', ok: 'Sign out everywhere' }); if (ok) { ctx.toast('All sessions revoked.', 'ok'); ctx.app.signOut(); } });
      ctx.on('click', '[data-signout]', () => { ctx.toast('Signed out. Session cookie cleared and refresh token revoked.'); ctx.app.signOut(); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (st.openCreate) { st.openCreate = false; setTimeout(openCreate, 50); }
    }
  });
})();
