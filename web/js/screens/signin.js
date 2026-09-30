(function () {
  const { UI, esc } = App;

  // ---- WebAuthn JSON <-> browser credential conversion (shared with Settings) ----
  const b64u = {
    toBuf(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; },
    fromBuf(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  };
  App.webauthn = {
    supported() { return !!(window.PublicKeyCredential && navigator.credentials); },
    async register(options) {
      const pk = Object.assign({}, options, { challenge: b64u.toBuf(options.challenge), user: Object.assign({}, options.user, { id: b64u.toBuf(options.user.id) }), excludeCredentials: (options.excludeCredentials || []).map((c) => Object.assign({}, c, { id: b64u.toBuf(c.id) })) });
      const cred = await navigator.credentials.create({ publicKey: pk });
      const r = cred.response;
      return { id: cred.id, rawId: b64u.fromBuf(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
        response: { clientDataJSON: b64u.fromBuf(r.clientDataJSON), attestationObject: b64u.fromBuf(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } };
    },
    async authenticate(options) {
      const pk = Object.assign({}, options, { challenge: b64u.toBuf(options.challenge), allowCredentials: (options.allowCredentials || []).map((c) => Object.assign({}, c, { id: b64u.toBuf(c.id) })) });
      const cred = await navigator.credentials.get({ publicKey: pk });
      const r = cred.response;
      return { id: cred.id, rawId: b64u.fromBuf(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
        response: { clientDataJSON: b64u.fromBuf(r.clientDataJSON), authenticatorData: b64u.fromBuf(r.authenticatorData), signature: b64u.fromBuf(r.signature), userHandle: r.userHandle ? b64u.fromBuf(r.userHandle) : undefined } };
    }
  };

  const problemNotice = (err) => {
    const p = (err && err.problem) || {};
    return UI.notice('<b>' + esc(p.title || 'Sign-in failed') + '.</b> ' + esc(p.detail || err.message || '') + (p.trace_id ? ' <span class="mono muted" style="font-size:11px">trace ' + esc(p.trace_id) + '</span>' : ''), p.status === 429 ? 'warn' : 'danger');
  };

  // A protocol page (OIDC authorize, SAML SSO, device approval) that needed a sign-in keeps its address here.
  const CONTINUE = 'exprsn.continue';
  const safeContinue = (v) => (typeof v === 'string' && /^\/(t\/[a-z0-9][a-z0-9-]{0,62}\/)?(oauth\/authorize\?|saml\/continue\?|device(\?|$))/.test(v) && v.indexOf('\\') < 0 ? v : null);
  const pendingContinue = () => { try { return safeContinue(sessionStorage.getItem(CONTINUE)); } catch (e) { return null; } };
  const takeContinue = () => { const v = pendingContinue(); try { sessionStorage.removeItem(CONTINUE); } catch (e) { /* storage blocked */ } return v; };

  // A password reset or invite link opens #/signin?reset=<token>[&tenant=<slug>]. Read it once, before the router
  // rewrites the address, and take the token out of the address bar and history at once.
  let resetLink = null;
  (function () {
    const m = /^#\/signin\?(.*)$/.exec(location.hash || '');
    if (!m) return;
    const q = {}; m[1].split('&').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) { try { q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* malformed */ } } });
    if (!q.reset || !/^[A-Za-z0-9_-]{43}$/.test(q.reset)) return;
    resetLink = { token: q.reset, tenant: /^[a-z0-9][a-z0-9-]{0,62}$/.test(q.tenant || '') ? q.tenant : '' };
    try { history.replaceState(null, '', location.pathname + location.search + '#/signin'); } catch (e) { /* history unavailable */ }
  })();
  const pwFields = (current) => (current ? '<div class="field"><label for="pc">' + esc(current) + '</label><input class="input" id="pc" type="password" autocomplete="current-password"></div>' : '')
    + '<div class="field"><label for="pn">New password</label><input class="input" id="pn" type="password" autocomplete="new-password" aria-describedby="pn-hint"><div class="hint" id="pn-hint">At least 12 characters. Not your username, not a common or breached password.</div></div>'
    + '<div class="field"><label for="pa">New password again</label><input class="input" id="pa" type="password" autocomplete="new-password"></div>';

  App.register({
    id: 'signin', title: 'Sign in', summary: 'Directory password, second factor, first-time enrolment', crumb: ['Sign in'], live: true,
    render(root, ctx) {
      const st = ctx.state;
      const pending = App.state.pendingSession;
      if (pending && !st.mode) { st.mode = pending.stage === 'enroll' ? 'enroll' : pending.stage === 'password' ? 'password' : 'mfa'; st.methods = (pending.mfa && pending.mfa.methods) || []; App.state.pendingSession = null; }
      if (resetLink && !st.mode) { st.mode = 'reset'; st.resetToken = resetLink.token; if (resetLink.tenant) { st.tenant = resetLink.tenant; st.showTenant = true; } resetLink = null; }
      st.mode = st.mode || 'form';
      const busy = st.busy ? ' disabled' : '';
      let form;
      if (st.mode === 'mfa') {
        const passkey = (st.methods || []).indexOf('webauthn') >= 0 && App.webauthn.supported();
        form = (st.error ? problemNotice(st.error) : '')
          + (st.useRecovery
            ? '<div class="field"><label for="rc">Recovery code</label><input class="input mono" id="rc" autocomplete="one-time-code" placeholder="xxxxx-xxxxx" style="font-size:16px;height:38px"></div><div class="vstack gap6">' + UI.btn('Verify recovery code', { kind: 'primary', attrs: 'data-recovery' + busy }) + UI.btn('Use the authenticator code instead', { kind: 'ghost', attrs: 'data-userecovery="0"' }) + '</div>'
            : ((st.methods || []).indexOf('totp') >= 0 ? '<div class="field"><label for="otp">Six-digit code from your authenticator</label><input class="input mono" id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" style="letter-spacing:.3em;font-size:18px;height:40px"></div>' : '')
              + '<div class="vstack gap6">' + ((st.methods || []).indexOf('totp') >= 0 ? UI.btn('Verify', { kind: 'primary', attrs: 'data-totp' + busy }) : '') + (passkey ? UI.btn('Use a passkey', { icon: 'key', attrs: 'data-passkey' + busy }) : '') + ((st.methods || []).indexOf('recovery') >= 0 ? UI.btn('Use a recovery code', { kind: 'ghost', attrs: 'data-userecovery="1"' }) : '') + UI.btn('Start over', { kind: 'ghost', attrs: 'data-restart' }) + '</div>');
      } else if (st.mode === 'enroll') {
        form = UI.notice('Your roles require a second factor. Set one up now; it is asked for at every sign-in.', 'info')
          + (st.error ? problemNotice(st.error) : '')
          + (st.totp
            ? '<ol class="fg2" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px"><li>Add an account in your authenticator app with this key:<div class="mono" style="font-size:15px;letter-spacing:.08em;margin:4px 0;overflow-wrap:anywhere">' + esc(st.totp.secret.replace(/(.{4})/g, '$1 ').trim()) + '</div><span class="muted" style="font-size:12px">or open the setup link on this device: <a class="mono" href="' + esc(st.totp.uri) + '">otpauth://…</a></span></li><li>Enter the six-digit code it shows.</li></ol>'
              + '<div class="field"><label for="otp">Code</label><input class="input mono" id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" style="letter-spacing:.3em;font-size:18px;height:40px"></div>'
              + '<div class="vstack gap6">' + UI.btn('Confirm and continue', { kind: 'primary', attrs: 'data-confirmtotp' + busy }) + '</div>'
            : '<div class="vstack gap6">' + UI.btn('Set up an authenticator app', { kind: 'primary', attrs: 'data-begintotp' + busy }) + (App.webauthn.supported() ? UI.btn('Register a passkey', { icon: 'key', attrs: 'data-regpasskey' + busy }) : '') + UI.btn('Start over', { kind: 'ghost', attrs: 'data-restart' }) + '</div>');
      } else if (st.mode === 'password') {
        form = UI.notice('Your password was set by an administrator. Choose your own to continue.', 'info')
          + (st.error ? problemNotice(st.error) : '') + pwFields('Current password')
          + '<div class="vstack gap6">' + UI.btn('Change password and continue', { kind: 'primary', attrs: 'data-pwset' + busy }) + UI.btn('Start over', { kind: 'ghost', attrs: 'data-restart' }) + '</div>';
      } else if (st.mode === 'reset') {
        form = UI.notice('Choose a new password. Every session of the account is signed out when it is set.', 'info')
          + (st.error ? problemNotice(st.error) : '') + pwFields(null)
          + '<div class="vstack gap6">' + UI.btn('Set password', { kind: 'primary', attrs: 'data-resetgo' + busy }) + UI.btn('Back to sign in', { kind: 'ghost', attrs: 'data-backtoform' }) + '</div>';
      } else if (st.mode === 'forgot') {
        form = (st.forgotDone ? UI.notice(esc(st.forgotDone), 'info') : '') + (st.error ? problemNotice(st.error) : '')
          + (st.showTenant ? '<div class="field"><label for="t">Tenant</label><input class="input" id="t" value="' + esc(st.tenant || '') + '" autocomplete="organization"></div>' : '')
          + '<div class="field"><label for="fi">Username or email</label><input class="input" id="fi" value="' + esc(st.username || '') + '" autocomplete="username" autocapitalize="none" spellcheck="false"></div>'
          + '<div class="vstack gap6">' + UI.btn('Send reset link', { kind: 'primary', attrs: 'data-forgotgo' + busy }) + UI.btn('Back to sign in', { kind: 'ghost', attrs: 'data-backtoform' }) + '</div>'
          + '<div class="muted" style="font-size:12px">This works for accounts whose password is kept here. Directory accounts reset their password in the directory.</div>';
      } else if (st.mode === 'codes') {
        form = UI.notice('<b>Store these recovery codes now.</b> Each works once if you lose your authenticator. They are not shown again.', 'warn')
          + '<div class="codebox" style="columns:2;white-space:normal">' + st.codes.map((c) => '<div class="mono">' + esc(c) + '</div>').join('') + '</div>'
          + '<div class="vstack gap6">' + UI.btn('Copy codes', { attrs: 'data-copycodes' }) + UI.btn('I have stored them', { kind: 'primary', attrs: 'data-done' }) + '</div>';
      } else {
        form = (st.info ? UI.notice(esc(st.info), 'ok') : '') + (st.error ? problemNotice(st.error) : '')
          + (st.showTenant ? '<div class="field"><label for="t">Tenant</label><input class="input" id="t" value="' + esc(st.tenant || '') + '" autocomplete="organization" placeholder="for example northwind"></div>' : '')
          + '<div class="field"><label for="u">Username</label><input class="input" id="u" value="' + esc(st.username || '') + '" autocomplete="username" autocapitalize="none" spellcheck="false"></div>'
          + '<div class="field"><label for="p">Password</label><input class="input" id="p" type="password" autocomplete="current-password"></div>'
          + '<div class="vstack gap6">' + UI.btn(st.busy ? 'Signing in…' : 'Sign in', { kind: 'primary', attrs: 'data-signin' + busy })
          + (st.options && st.options.kerberos ? UI.btn('Sign in with Kerberos', { icon: 'key', attrs: 'data-fedstart="' + esc(st.options.kerberos.start) + '"' }) : '')
          + (st.options ? st.options.upstream.map((u) => UI.btn('Sign in with ' + u.name, { attrs: 'data-fedstart="' + esc(u.start) + '"' })).join('') : '') + '</div>'
          + '<div class="hstack" style="justify-content:space-between;font-size:12px"><a href="#" data-tenant>' + (st.showTenant ? 'Use the default tenant' : 'Sign in to another tenant') + '</a><a href="#" data-forgot>Forgot your password?</a></div>';
      }
      root.innerHTML = '<div class="page" style="align-items:center;justify-content:center">'
        + '<form class="panel" style="width:400px;max-width:100%;gap:18px;padding:28px" novalidate data-form><div><div class="eyebrow" style="letter-spacing:.08em">Exprsn-AI</div><div style="font-size:22px;font-weight:600">' + (st.mode === 'enroll' ? 'Set up a second factor' : st.mode === 'codes' ? 'Recovery codes' : st.mode === 'mfa' ? 'Second factor' : st.mode === 'password' ? 'Change your password' : st.mode === 'reset' ? 'Set a new password' : st.mode === 'forgot' ? 'Reset your password' : 'Sign in') + '</div></div>' + form + '</form>'
        + '<div class="muted" style="font-size:12px;max-width:400px;text-align:center">Your directory account and password. Roles and clearance come from your directory groups.</div></div>';

      const focus = ctx.$('#otp') || ctx.$('#rc') || ctx.$('#pc') || ctx.$('#pn') || ctx.$('#fi') || (st.username ? ctx.$('#p') : ctx.$('#u'));
      if (focus) focus.focus();

      const run = async (fn) => { if (st.busy) return; st.busy = true; st.error = null; ctx.rerender(); try { await fn(); } catch (err) { st.error = err; } finally { st.busy = false; if (App.state.route === 'signin') ctx.rerender(); } };
      const finish = async (session) => {
        const next = takeContinue();
        Object.keys(st).forEach((k) => { delete st[k]; });
        if (next) { location.assign(next); return; }
        await App.signIn(session);
      };
      // Upstream identity providers and Kerberos, offered next to the password form (loaded once per tenant).
      const tenantKey = st.tenant || '';
      if (st.mode === 'form' && st.optionsFor !== tenantKey && !st.optionsLoading) {
        st.optionsLoading = true;
        App.get('/api/auth/sign-in-options' + (tenantKey ? '?tenant=' + encodeURIComponent(tenantKey) : ''))
          .then((o) => { st.options = o; }, () => { st.options = null; })
          .finally(() => { st.optionsFor = tenantKey; st.optionsLoading = false; if (App.state.route === 'signin' && st.mode === 'form') ctx.rerender(); });
      }
      const startFederated = (url) => { const c = pendingContinue(); location.assign(url + (url.indexOf('?') < 0 ? '?' : '&') + 'return=' + encodeURIComponent(c || '')); };

      const signin = () => {
        // Read the form before run() re-renders it.
        st.username = ctx.$('#u').value.trim(); if (ctx.$('#t')) st.tenant = ctx.$('#t').value.trim();
        const body = { username: st.username, password: ctx.$('#p').value };
        if (st.tenant) body.tenant = st.tenant;
        if (!body.username || !body.password) { st.error = { message: 'Enter your username and password.', problem: { title: 'Missing details' } }; ctx.rerender(); return; }
        return run(() => login(body));
      };
      const login = async (body) => {
        const s = await App.post('/api/auth/login', body);
        App.state.csrf = s.csrf;
        if (s.stage === 'active') return finish(s);
        st.info = null;
        st.mode = s.stage === 'enroll' ? 'enroll' : s.stage === 'password' ? 'password' : 'mfa'; st.methods = s.mfa.methods;
      };
      // After the factor, an admin-set password still has to be changed before the session becomes active.
      const complete = (s) => { App.state.csrf = s.csrf; if (s.stage === 'password') { st.mode = 'password'; return; } return finish(s); };
      const newPassword = () => {
        const next = ctx.$('#pn').value, again = ctx.$('#pa').value;
        if (!next) { st.error = { message: 'Enter a new password.', problem: { title: 'Missing details' } }; return null; }
        if (next !== again) { st.error = { message: 'The two new passwords do not match.', problem: { title: 'Check the new password' } }; return null; }
        return next;
      };

      ctx.on('submit', '[data-form]', (e) => { e.preventDefault(); if (st.mode === 'form') signin(); else if (ctx.$('[data-pwset]')) ctx.$('[data-pwset]').click(); else if (ctx.$('[data-resetgo]')) ctx.$('[data-resetgo]').click(); else if (ctx.$('[data-forgotgo]')) ctx.$('[data-forgotgo]').click(); else if (ctx.$('[data-totp]')) ctx.$('[data-totp]').click(); else if (ctx.$('[data-confirmtotp]')) ctx.$('[data-confirmtotp]').click(); else if (ctx.$('[data-recovery]')) ctx.$('[data-recovery]').click(); });
      ctx.on('click', '[data-signin]', (e) => { e.preventDefault(); signin(); });
      ctx.on('click', '[data-fedstart]', (e, t) => { e.preventDefault(); startFederated(t.dataset.fedstart); });
      ctx.on('click', '[data-tenant]', (e) => { e.preventDefault(); st.showTenant = !st.showTenant; if (!st.showTenant) st.tenant = ''; ctx.rerender(); });
      ctx.on('click', '[data-restart]', (e) => { e.preventDefault(); App.post('/api/auth/logout').catch(() => null); const u = st.username; Object.keys(st).forEach((k) => { delete st[k]; }); st.username = u; ctx.rerender(); });
      ctx.on('click', '[data-userecovery]', (e, t) => { e.preventDefault(); st.useRecovery = t.dataset.userecovery === '1'; st.error = null; ctx.rerender(); });
      ctx.on('click', '[data-totp]', (e) => { e.preventDefault(); const code = ctx.$('#otp').value.trim(); run(async () => complete(await App.post('/api/auth/mfa/totp', { code }))); });
      ctx.on('click', '[data-recovery]', (e) => { e.preventDefault(); const code = ctx.$('#rc').value.trim(); run(async () => complete(await App.post('/api/auth/mfa/recovery', { code }))); });
      ctx.on('click', '[data-passkey]', (e) => { e.preventDefault(); run(async () => { const opts = await App.post('/api/auth/mfa/webauthn/options'); const response = await App.webauthn.authenticate(opts); await complete(await App.post('/api/auth/mfa/webauthn', { response })); }); });
      ctx.on('click', '[data-begintotp]', (e) => { e.preventDefault(); run(async () => { st.totp = await App.post('/api/me/mfa/totp', { label: 'Authenticator app' }); }); });
      const enrolled = (r) => { App.state.csrf = r.csrf || App.state.csrf; if (r.recoveryCodes) { st.mode = 'codes'; st.codes = r.recoveryCodes; st.session = r; } else if (r.stage === 'password') { st.mode = 'password'; } else return finish(r); };
      ctx.on('click', '[data-confirmtotp]', (e) => { e.preventDefault(); const code = ctx.$('#otp').value.trim(); run(async () => enrolled(await App.post('/api/me/mfa/totp/' + encodeURIComponent(st.totp.id) + '/confirm', { code }))); });
      ctx.on('click', '[data-regpasskey]', (e) => { e.preventDefault(); run(async () => { const opts = await App.post('/api/me/mfa/webauthn/options'); const response = await App.webauthn.register(opts); await enrolled(await App.post('/api/me/mfa/webauthn', { label: 'Passkey', response })); }); });
      ctx.on('click', '[data-copycodes]', (e) => { e.preventDefault(); if (navigator.clipboard) navigator.clipboard.writeText(st.codes.join('\n')).then(() => ctx.toast('Recovery codes copied.', 'ok'), () => ctx.toast('Copy failed; select the codes instead.', 'warn')); });
      ctx.on('click', '[data-done]', (e) => { e.preventDefault(); if (st.session && st.session.stage === 'password') { st.mode = 'password'; ctx.rerender(); return; } finish(st.session); });
      ctx.on('click', '[data-pwset]', (e) => {
        e.preventDefault(); const current = ctx.$('#pc').value; const next = newPassword();
        if (!next) { ctx.rerender(); return; }
        run(async () => { const r = await App.post('/api/me/password', { currentPassword: current, newPassword: next }); App.state.csrf = r.csrf || App.state.csrf; await finish(r); });
      });
      ctx.on('click', '[data-forgot]', (e) => { e.preventDefault(); st.username = ctx.$('#u') ? ctx.$('#u').value.trim() : st.username; if (ctx.$('#t')) st.tenant = ctx.$('#t').value.trim(); st.mode = 'forgot'; st.error = null; st.forgotDone = null; ctx.rerender(); });
      ctx.on('click', '[data-backtoform]', (e) => { e.preventDefault(); st.mode = 'form'; st.error = null; st.resetToken = null; ctx.rerender(); });
      ctx.on('click', '[data-forgotgo]', (e) => {
        e.preventDefault(); const identifier = ctx.$('#fi').value.trim(); if (ctx.$('#t')) st.tenant = ctx.$('#t').value.trim();
        if (!identifier) { st.error = { message: 'Enter your username or email address.', problem: { title: 'Missing details' } }; ctx.rerender(); return; }
        st.username = identifier;
        run(async () => { const r = await App.post('/api/auth/password/forgot', st.tenant ? { identifier, tenant: st.tenant } : { identifier }); st.forgotDone = r.detail; });
      });
      ctx.on('click', '[data-resetgo]', (e) => {
        e.preventDefault(); const next = newPassword();
        if (!next) { ctx.rerender(); return; }
        run(async () => { const r = await App.post('/api/auth/password/reset', { token: st.resetToken, password: next }); st.resetToken = null; st.mode = 'form'; st.username = r.username; st.info = 'Password set. Sign in with it now.'; });
      });
    }
  });
})();
