(function () {
  const { UI } = App;
  App.register({
    id: 'signin', title: 'Sign in', summary: 'Kerberos SSO fallback, passkey, device code, SSO diagnostics', crumb: ['Sign in'],
    states: [
      { title: 'SSO succeeded', tone: 'ok', text: 'A domain-joined browser sent a Negotiate ticket. The user lands in chat with no form.', apply(ctx) { ctx.state.mode = 'sso'; ctx.rerender(); } },
      { title: 'LDAP bind refused', tone: 'danger', text: 'Wrong password or disabled account. The form keeps the username and shows the directory message.', apply(ctx) { ctx.state.error = true; ctx.rerender(); } },
      { title: 'MFA step', tone: 'info', text: 'Role requires a second factor. A six-digit prompt replaces the password field.', apply(ctx) { ctx.state.mode = 'mfa'; ctx.rerender(); } },
      { title: 'Device code', tone: 'neutral', text: 'A CLI or headless client shows a code; the user enters it here after signing in.', apply(ctx) { ctx.state.mode = 'device'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; st.mode = st.mode || 'form';
      const checks = [['Browser sent Negotiate', UI.pill('yes', 'ok')], ['Ticket for HTTP/ai.northwind.local', UI.pill('missing', 'danger')], ['Clock skew', '0.4 s'], ['KDC reachable from zone', UI.pill('yes', 'ok')], ['Fallback', 'LDAP password']];
      const form = st.mode === 'mfa'
        ? '<div class="field"><label for="otp">Six-digit code from your authenticator</label><input class="input mono" id="otp" inputmode="numeric" maxlength="6" placeholder="000000" style="letter-spacing:.3em;font-size:18px;height:40px"></div><div class="vstack gap6">' + UI.btn('Verify', { kind: 'primary', attrs: 'data-go' }) + UI.btn('Use a recovery code', { kind: 'ghost', attrs: 'data-mode="form"' }) + '</div>'
        : st.mode === 'device'
          ? '<div class="field"><label for="dc">Device code shown by the client</label><input class="input mono" id="dc" value="WDJB-MJHT" style="font-size:16px;height:36px"></div>' + UI.notice('Authorising <b>exprsn-cli</b> on <b>build-03</b> for scopes <span class="mono">chat:write models:read</span>', 'info') + '<div class="vstack gap6">' + UI.btn('Authorise device', { kind: 'primary', attrs: 'data-go' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-mode="form"' }) + '</div>'
          : st.mode === 'sso'
            ? UI.notice('Signed in through Kerberos as <b>mokafor@NORTHWIND.LOCAL</b>. Redirecting to chat.', 'ok') + UI.btn('Continue', { kind: 'primary', attrs: 'data-go' })
            : UI.notice('Single sign-on did not complete. Use your directory password.', 'warn', '<a href="#" data-why>Why?</a>')
              + (st.error ? UI.notice('The directory refused the bind: <b>invalid credentials</b> (LDAP 49). Two attempts left before lockout.', 'danger') : '')
              + '<div class="field"><label for="u">Directory username</label><input class="input" id="u" value="mokafor" autocomplete="username"></div>'
              + '<div class="field"><label for="p">Password</label><input class="input" id="p" type="password" value="" autocomplete="current-password"></div>'
              + '<div class="vstack gap6">' + UI.btn('Sign in', { kind: 'primary', attrs: 'data-signin' }) + UI.btn('Use a passkey', { icon: 'key', attrs: 'data-passkey' }) + '</div>'
              + '<div class="hstack" style="justify-content:space-between;font-size:12px"><a href="#" data-mode="device">Enter a device code</a><a href="#" data-diag>SSO diagnostics</a></div>';
      root.innerHTML = '<div class="page" style="align-items:center;justify-content:center">'
        + '<div class="cols" style="align-items:stretch;justify-content:center;width:100%;max-width:900px">'
        + '<div class="panel" style="width:400px;max-width:100%;gap:18px;padding:28px"><div><div class="eyebrow" style="letter-spacing:.08em">Exprsn-AI</div><div style="font-size:22px;font-weight:600">Sign in to Northwind</div></div>' + form + '</div>'
        + '<div class="vstack gap12" style="width:420px;max-width:100%">' + UI.panel('SSO diagnostics', UI.table(['Check', 'Result'], checks, { clickable: false, cls: 'bare', minWidth: '0' }) + '<div class="muted" style="font-size:12px">The browser did not present a service ticket. Ask the desktop team to add ai.northwind.local to the intranet zone, or sign in with your password.</div>')
        + UI.panel('Prototype', '<div class="fg2">Any password signs you in as <b>Mara Okafor</b>, a Finance Ops member who also holds admin roles, so every console area is visible. Press <span class="mono">?</span> anywhere for the prototype map.</div>') + '</div></div>'
        + '<div style="width:100%;max-width:900px"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';
      ctx.on('click', '[data-signin]', () => { ctx.state.error = false; ctx.toast('Bound to OpenLDAP as mokafor. Session cookie issued.', 'ok'); ctx.app.signIn(); });
      ctx.on('click', '[data-go]', () => ctx.app.signIn());
      ctx.on('click', '[data-passkey]', () => { ctx.toast('Passkey verified on this device.', 'ok'); ctx.app.signIn(); });
      ctx.on('click', '[data-mode]', (e, t) => { e.preventDefault(); ctx.state.mode = t.dataset.mode; ctx.state.error = false; ctx.rerender(); });
      ctx.on('click', '[data-why]', (e) => { e.preventDefault(); ctx.modal({ title: 'Why single sign-on did not complete', body: '<p style="margin:0" class="fg2">Kerberos SSO needs the browser to send a Negotiate ticket for <span class="mono">HTTP/ai.northwind.local</span>. This browser sent nothing, which usually means the site is not in its trusted intranet zone, or the machine is not domain-joined.</p><p style="margin:0" class="fg2">Password sign-in binds the same directory account, so roles and clearance are identical.</p>', actions: UI.btn('Close', { attrs: 'data-close' }) }); });
      ctx.on('click', '[data-diag]', (e) => { e.preventDefault(); ctx.toast('Diagnostics are shown on the right.'); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
