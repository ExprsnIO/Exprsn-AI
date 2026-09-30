(function () {
  const { UI, esc } = App;

  const when = (ms) => {
    if (!ms) return 'never';
    const d = Date.now() - ms; const abs = Math.abs(d);
    if (abs < 60000) return d >= 0 ? 'just now' : 'in under a minute';
    if (d >= 0 && d < 3600000) return Math.round(d / 60000) + ' min ago';
    if (d >= 0 && d < 86400000) return Math.round(d / 3600000) + ' h ago';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const client = (ua) => {
    if (!ua) return 'Unknown client';
    const b = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|python|Go-http/i.test(ua) ? ua.split(/[\s/]/)[0] : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
    return b + (os ? ' on ' + os : '');
  };
  // Accessibility modes (App.setA11y in app.js; the tokens are in css/app.css under [data-a11y="aaa"]).
  const A11Y = [{ value: 'system', label: 'Follow system' }, { value: 'aa', label: 'Standard (AA)' }, { value: 'aaa', label: 'Enhanced (AAA)' }];

  App.register({
    id: 'settings', title: 'Settings', summary: 'Profile, appearance, second factors, API keys, sessions', crumb: ['Settings'], live: true,
    commands: [{ label: 'Create an API key', sub: 'Settings', run(app) { app.stateFor('settings').openCreate = true; app.render(); } }],
    render(root, ctx) {
      const st = ctx.state;
      const me = App.me;
      if (!st.loaded && !st.loading) {
        st.loading = true;
        Promise.all([App.get('/api/me/api-keys'), App.get('/api/me/sessions'), App.get('/api/me/mfa'), App.get('/api/me')])
          .then(([keys, sessions, mfa, fresh]) => { st.keys = keys; st.sessions = sessions; st.mfa = mfa; App.setMe(fresh); st.loaded = true; })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; if (App.state.route === 'settings') ctx.rerender(); });
      }
      const theme = App.state.theme === 'dark' ? 'Dark' : App.state.theme === 'light' ? 'Light' : 'Follow system';
      const perms = me.permissions;

      const profile = UI.panel('Profile', UI.kv([['Name', esc(me.user.displayName)], ['Account', '<span class="mono">' + esc(me.user.username) + '</span>'], ['Tenant', esc(me.tenant ? me.tenant.name : '')], ['Clearance', UI.label(me.user.clearance, { sm: true })], ['Roles', esc(me.roles.map((r) => r.name).join(', ') || 'none')], ['Signed in with', me.credential === 'api_key' ? 'API key' : 'browser session']], 2)
        + '<div class="muted" style="font-size:12px">Name, account, clearance and roles come from your user store and its group mappings. Ask an identity admin to change them.</div>');

      const a11y = App.state.a11y || 'system';
      const eff = App.a11yMode();
      const appearance = UI.panel('Appearance', '<div class="formgrid" style="--cols:2">' + UI.field('Theme', UI.select(['Follow system', 'Light', 'Dark'], theme, 'data-theme'))
        + UI.field('Accessibility', UI.select(A11Y, a11y, 'data-a11y-mode'), a11y === 'system' ? 'In use: ' + (eff === 'aaa' ? 'Enhanced, because your system asks for more contrast.' : 'Standard.') : '') + '</div>'
        + UI.toggle('Single-key shortcuts (? opens the screen map)', App.state.singleKeys, 'data-singlekeys data-manual="1"')
        + '<span class="muted" style="font-size:12px">Saved in this browser. Standard meets WCAG 2.2 AA. Enhanced raises text contrast to 7:1, enlarges click targets, shows a focus ring on every focused control, underlines links, stops animation and keeps messages on screen longer. Reduced motion from your system is always honoured.</span>');

      const factors = st.mfa ? st.mfa.factors : [];
      const mfaPanel = UI.panel('Second factors', (st.codes ? UI.notice('<b>New recovery codes. Store them now; they are shown once.</b><div class="mono" style="margin-top:4px;columns:2">' + st.codes.map((c) => '<div>' + esc(c) + '</div>').join('') + '</div>', 'warn', UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-codesdone' })) : '')
        + (st.totp ? UI.notice('Add this key to your authenticator app: <span class="mono" style="overflow-wrap:anywhere">' + esc(st.totp.secret.replace(/(.{4})/g, '$1 ').trim()) + '</span>, then enter the code it shows.' + '<div class="hstack gap6" style="margin-top:6px"><input class="input mono" data-totpcode inputmode="numeric" maxlength="6" placeholder="000000" style="width:110px">' + UI.btn('Confirm', { kind: 'primary', size: 'sm', attrs: 'data-totpconfirm' }) + UI.btn('Cancel', { kind: 'ghost', size: 'sm', attrs: 'data-totpcancel' }) + '</div>', 'info') : '')
        + UI.table(['Factor', 'Added', 'Last used', { label: '', right: true }], factors.map((f) => ({ cells: [esc(f.label) + ' ' + UI.pill(f.kind === 'webauthn' ? 'passkey' : 'authenticator', 'outline'), esc(when(f.createdAt)), esc(when(f.lastUsedAt)), '<span class="hstack" style="justify-content:flex-end">' + UI.btn('Remove', { kind: 'ghost', size: 'sm', attrs: 'data-rmfactor="' + esc(f.id) + '"' }) + '</span>'] })), { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No second factor', emptyText: 'Add one to protect your account. Admin roles require it.' })
        + '<div class="hstack wrap gap6">' + UI.btn('Add authenticator app', { size: 'sm', attrs: 'data-addtotp' }) + (App.webauthn && App.webauthn.supported() ? UI.btn('Add passkey', { size: 'sm', icon: 'key', attrs: 'data-addpasskey' }) : '') + (factors.length ? UI.btn('New recovery codes', { kind: 'ghost', size: 'sm', attrs: 'data-newcodes' }) : '') + '<span class="muted grow" style="font-size:12px;text-align:right">' + (st.mfa ? st.mfa.recoveryCodesRemaining + ' recovery codes left' : '') + '</span></div>');

      const keys = st.keys || [];
      const keyRows = keys.map((k) => {
        const action = k.state === 'active' ? UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-revoke="' + esc(k.id) + '"' }) : UI.pill(k.state, k.state === 'expired' ? 'warn' : 'danger');
        return { cells: [esc(k.name) + '<div class="mono muted" style="font-size:11px">' + esc(k.prefix) + '…</div>', '<span class="mono">' + esc(k.scopes.join(' ')) + '</span>', k.state === 'expired' ? '<span style="color:var(--warn-fg)">' + esc(when(k.expiresAt)) + '</span>' : esc(new Date(k.expiresAt).toLocaleDateString()), esc(when(k.lastUsedAt)), '<span class="hstack" style="justify-content:flex-end">' + action + '</span>'] };
      });
      const keysPanel = UI.panel('API keys', '<div>' + UI.btn('Create key', { kind: 'primary', size: 'sm', icon: 'key', attrs: 'data-create' }) + '</div>'
        + (st.revealed ? UI.notice('<b>Key <span class="mono">' + esc(st.revealed.name) + '</span> created. Copy it now; it is shown once.</b><div class="mono" style="margin-top:4px;overflow-wrap:anywhere">' + esc(st.revealed.key) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copykey' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-revealdone' })) : '')
        + UI.table(['Name', 'Scopes', 'Expires', 'Last used', { label: '', right: true }], keyRows, { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No API keys', emptyText: 'Keys are bearer tokens for scripts and the CLI.' })
        + '<span class="muted" style="font-size:12px">Each key carries a subset of your own permissions and your clearance. Expired and revoked keys stay listed for 30 days; calls with them get <span class="mono">401 invalid_token</span>.</span>');

      const sessions = st.sessions || [];
      const sessionsPanel = UI.panel('Sessions', UI.table(['Client', 'Signed in with', 'Address', 'Started', 'Last activity', { label: '', right: true }], sessions.map((s) => ({ cells: [esc(client(s.userAgent)) + (s.current ? ' ' + UI.pill('this session', 'accent') : ''), esc(s.method), '<span class="mono">' + esc(s.ip || '') + '</span>', esc(when(s.createdAt)), esc(when(s.lastSeenAt)), '<span class="hstack" style="justify-content:flex-end">' + (s.current ? '' : UI.btn('Sign out', { kind: 'ghost', size: 'sm', attrs: 'data-endsession="' + esc(s.id) + '"' })) + '</span>'] })), { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No sessions', emptyText: '' })
        + '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">Signing a session out ends it at once, including its live connection. API keys are not affected.</span>' + UI.btn('Sign out other sessions', { kind: 'ghost', size: 'sm', attrs: 'data-signoutothers' }) + UI.btn('Sign out', { size: 'sm', icon: 'lock', attrs: 'data-signout' }) + '</div>');

      root.innerHTML = '<div class="page">' + UI.pagehead('Settings', 'Personal settings for ' + esc(me.user.displayName))
        + (st.loadError ? UI.problem('Settings could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) : '')
        + (!st.loaded && !st.loadError ? UI.notice('Loading…', 'info') : '')
        + '<div class="grid2"><div class="vstack" style="gap:14px">' + profile + appearance + mfaPanel + '</div><div class="vstack" style="gap:14px">' + keysPanel + '</div></div>'
        + sessionsPanel + '</div>';

      const reload = () => { st.loaded = false; ctx.rerender(); };
      const act = async (fn, okMsg) => { try { await fn(); if (okMsg) ctx.toast(okMsg, 'ok'); reload(); } catch (err) { App.fail(err); } };

      ctx.on('change', '[data-theme]', (e, t) => { App.setTheme(t.value === 'Dark' ? 'dark' : t.value === 'Light' ? 'light' : null); ctx.toast('Theme: ' + esc(t.value) + '.'); });
      ctx.on('change', '[data-a11y-mode]', (e, t) => { App.setA11y(t.value === 'system' ? null : t.value); ctx.rerender(); ctx.toast('Accessibility: ' + esc(A11Y.find((o) => o.value === t.value).label) + '.'); });
      ctx.on('click', '[data-singlekeys]', (e, t) => { App.setSingleKeys(!App.state.singleKeys); t.classList.toggle('on', App.state.singleKeys); t.setAttribute('aria-checked', App.state.singleKeys ? 'true' : 'false'); ctx.toast(App.state.singleKeys ? 'Single-key shortcuts on.' : 'Single-key shortcuts off. Ctrl K still opens the command palette.'); });

      ctx.on('click', '[data-addtotp]', () => act(async () => { st.totp = await App.post('/api/me/mfa/totp', { label: 'Authenticator app' }); }));
      ctx.on('click', '[data-totpcancel]', () => { st.totp = null; ctx.rerender(); });
      ctx.on('click', '[data-totpconfirm]', () => { const code = ctx.$('[data-totpcode]').value.trim(); act(async () => { const r = await App.post('/api/me/mfa/totp/' + encodeURIComponent(st.totp.id) + '/confirm', { code }); st.totp = null; if (r.recoveryCodes) st.codes = r.recoveryCodes; }, 'Authenticator added.'); });
      ctx.on('click', '[data-addpasskey]', () => act(async () => { const opts = await App.post('/api/me/mfa/webauthn/options'); const response = await App.webauthn.register(opts); const r = await App.post('/api/me/mfa/webauthn', { label: 'Passkey', response }); if (r.recoveryCodes) st.codes = r.recoveryCodes; }, 'Passkey added.'));
      ctx.on('click', '[data-newcodes]', async () => { const ok = await ctx.confirm({ title: 'Replace recovery codes?', tag: 'old codes stop working', tone: 'danger', body: '<div class="fg2">Ten new codes are generated and every earlier code stops working.</div>', ok: 'Generate new codes' }); if (ok) act(async () => { st.codes = (await App.post('/api/me/mfa/recovery-codes')).recoveryCodes; }); });
      ctx.on('click', '[data-codesdone]', () => { st.codes = null; ctx.rerender(); });
      ctx.on('click', '[data-rmfactor]', async (e, t) => { const f = factors.find((x) => x.id === t.dataset.rmfactor); const ok = await ctx.confirm({ title: 'Remove ' + f.label + '?', tag: 'second factor', tone: 'danger', body: '<div class="fg2">You will no longer be able to sign in with it.</div>', ok: 'Remove' }); if (ok) act(() => App.del('/api/me/mfa/' + encodeURIComponent(f.id)), 'Factor removed. Audit entry written.'); });

      ctx.on('click', '[data-revoke]', async (e, t) => {
        const k = keys.find((x) => x.id === t.dataset.revoke);
        const ok = await ctx.confirm({ title: 'Revoke key ' + k.name + '?', tag: 'cannot be undone', tone: 'danger', body: '<div class="fg2">Clients using this key get <span class="mono">401 invalid_token</span> on their next call. The key stays listed for 30 days for audit.</div>', kv: [['Scopes', '<span class="mono">' + esc(k.scopes.join(' ')) + '</span>'], ['Last used', esc(when(k.lastUsedAt))], ['Prefix', '<span class="mono">' + esc(k.prefix) + '</span>']], ok: 'Revoke key' });
        if (ok) act(() => App.del('/api/me/api-keys/' + encodeURIComponent(k.id)), 'Key ' + esc(k.name) + ' revoked.');
      });
      const openCreate = () => {
        const scopes = perms.slice();
        ctx.modal({ title: 'Create API key', body: UI.field('Name', UI.input('', { placeholder: 'for example notebook-desk', attrs: 'data-name maxlength="100"' }), 'Shown in the audit log next to every call made with the key.')
          + '<div class="field"><span class="fl">Scopes, a subset of your own</span><div class="hstack wrap gap6" style="row-gap:6px">' + scopes.map((s) => UI.check(s, s === 'inference:invoke' || s === 'chat:read', 'data-scope="' + esc(s) + '"')).join('') + '</div></div>'
          + UI.field('Expires', UI.select([{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '180', label: '180 days' }, { value: '365', label: '1 year' }], '90', 'data-exp'))
          + UI.notice('The key is shown once after creation. It inherits your clearance ceiling of ' + UI.label(me.user.clearance, { sm: true }) + '.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create key', { kind: 'primary', attrs: 'data-go' }),
          onMount(m) {
            const nameEl = m.querySelector('[data-name]'); nameEl.focus();
            m.querySelector('[data-go]').addEventListener('click', async () => {
              const name = nameEl.value.trim(); const chosen = Array.prototype.slice.call(m.querySelectorAll('[data-scope]:checked')).map((c) => c.dataset.scope);
              if (!name) { ctx.toast('Give the key a name.', 'warn'); return; }
              if (!chosen.length) { ctx.toast('Pick at least one scope.', 'warn'); return; }
              try {
                const r = await App.post('/api/me/api-keys', { name, scopes: chosen, ttlDays: Number(m.querySelector('[data-exp]').value) });
                st.revealed = { name, key: r.key }; App.closeOverlay(); reload(); ctx.toast('Key created. Copy it now; it will not be shown again.', 'warn', 5000);
              } catch (err) { App.fail(err, 'Key not created'); }
            });
          } });
      };
      ctx.on('click', '[data-create]', openCreate);
      ctx.on('click', '[data-copykey]', () => { if (navigator.clipboard && st.revealed) navigator.clipboard.writeText(st.revealed.key).then(() => ctx.toast('Copied.', 'ok')); });
      ctx.on('click', '[data-revealdone]', () => { st.revealed = null; ctx.rerender(); });

      ctx.on('click', '[data-endsession]', async (e, t) => { const s = sessions.find((x) => x.id === t.dataset.endsession); const ok = await ctx.confirm({ title: 'Sign out ' + client(s.userAgent) + '?', tag: 'ends the session', tone: 'danger', kv: [['Signed in with', esc(s.method)], ['Address', esc(s.ip || '')], ['Last activity', esc(when(s.lastSeenAt))]], ok: 'Sign out that session' }); if (ok) act(() => App.del('/api/me/sessions/' + encodeURIComponent(s.id)), 'Session ended.'); });
      ctx.on('click', '[data-signoutothers]', async () => { const ok = await ctx.confirm({ title: 'Sign out other sessions?', tag: 'all but this one', tone: 'danger', body: '<div class="fg2">Every other session for <span class="mono">' + esc(me.user.username) + '</span> ends now. API keys are not affected.</div>', ok: 'Sign out other sessions' }); if (ok) act(async () => { const r = await App.post('/api/me/sessions/revoke-others'); ctx.toast(r.revoked + ' session' + (r.revoked === 1 ? '' : 's') + ' ended.', 'ok'); }); });
      ctx.on('click', '[data-signout]', () => App.signOut());
      if (st.openCreate) { st.openCreate = false; setTimeout(openCreate, 50); }
    }
  });
})();
