(function () {
  const { UI, esc } = App;
  // 1.4.0 identity gaps (B-1801 to B-1808) shown on the sign-in page: self-registration under the tenant's policy,
  // verification and invitation links, the MFA policy's trusted devices and email codes, GitHub and AT-Protocol sign-in.
  const POLICY = { mode: 'approval', domains: ['northwind.local', '*.northwind.local'], verifyEmail: true, roles: ['member'], clearance: 'internal', workspace: 'People Ops' };
  const INVITE = { tenant: 'Northwind', workspace: 'Finance Ops', invitedBy: 'Jonas Lindqvist', email: 'd.okonkwo@northwind.local', roles: ['member', 'flag-reviewer'], clearance: 'confidential', expiresAt: '26 Sep 2026' };
  const OPTIONS = [['OpenLDAP', 'password', 'uid=…,ou=people,ou=northwind'], ['GitHub', 'github', 'organisations northwind-io and northwind-finance'], ['AT-Protocol', 'atproto', 'a handle or DID; bound accounts sign in as themselves']];
  const strength = (p) => { const n = (p.length >= 12) + /[A-Z]/.test(p) + /[0-9]/.test(p) + /[^A-Za-z0-9]/.test(p); return p.length < 8 ? [10, 'too short', 'danger'] : n <= 1 ? [35, 'weak', 'danger'] : n === 2 ? [60, 'fair', 'warn'] : n === 3 ? [80, 'good', 'accent'] : [100, 'strong', '']; };

  App.register({
    id: 'signin', title: 'Sign in', summary: 'Kerberos SSO fallback, passkey, device code, SSO diagnostics; self-registration, invitation and verification links, trusted devices, email codes, GitHub and AT-Protocol sign-in', crumb: ['Sign in'],
    states: [
      { title: 'SSO succeeded', tone: 'ok', text: 'A domain-joined browser sent a Negotiate ticket. The user lands in chat with no form.', apply(ctx) { ctx.state.mode = 'sso'; ctx.rerender(); } },
      { title: 'LDAP bind refused', tone: 'danger', text: 'Wrong password or disabled account. The form keeps the username and shows the directory message.', apply(ctx) { ctx.state.mode = 'form'; ctx.state.error = 'ldap'; ctx.rerender(); } },
      { title: 'MFA step', tone: 'info', text: 'Role requires a second factor. A six-digit prompt replaces the password field, with "trust this browser" when the tenant allows it.', apply(ctx) { ctx.state.mode = 'mfa'; ctx.state.factor = 'totp'; ctx.rerender(); } },
      { title: 'Device code', tone: 'neutral', text: 'A CLI or headless client shows a code; the user enters it here after signing in.', apply(ctx) { ctx.state.mode = 'device'; ctx.rerender(); } },
      { title: 'Self-registration open', tone: 'info', text: 'The tenant policy allows sign-up with approval for northwind.local addresses. The account waits as pending until an admin approves it.', apply(ctx) { ctx.state.mode = 'register'; ctx.state.registered = null; ctx.rerender(); } },
      { title: 'Invitation link', tone: 'neutral', text: 'A workspace admin invited this address. The preview shows tenant, workspace, roles and clearance before the account is created.', apply(ctx) { ctx.state.mode = 'invitation'; ctx.rerender(); } },
      { title: 'Email not verified (403)', tone: 'warn', text: 'The tenant requires verified addresses. The right password still refuses with reason email_unverified and a fresh link is sent, throttled.', apply(ctx) { ctx.state.mode = 'form'; ctx.state.error = 'email_unverified'; ctx.rerender(); } },
      { title: 'Sign-up pending approval (403)', tone: 'warn', text: 'A registered account that no admin has approved yet. The password is checked first, then the refusal names the reason.', apply(ctx) { ctx.state.mode = 'form'; ctx.state.error = 'signup_pending'; ctx.rerender(); } },
      { title: 'Suspended (403 step sanction)', tone: 'danger', text: 'A suspended or banned user gets 403 with the sanction and its end, whatever credential they use. Sessions were revoked when the sanction was issued.', apply(ctx) { ctx.state.mode = 'form'; ctx.state.error = 'sanction'; ctx.rerender(); } },
      { title: 'AT-Protocol sign-in', tone: 'info', text: 'The handle is resolved to its DID, document and PDS; the PDS names one authorization server; a pushed authorization request with PKCE and DPoP follows.', apply(ctx) { ctx.state.mode = 'atproto'; ctx.state.atSteps = 0; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state; st.mode = st.mode || 'form'; st.factor = st.factor || 'totp'; st.pw = st.pw == null ? '' : st.pw;
      if (ctx.params.verify) { st.mode = 'verified'; delete ctx.params.verify; }
      if (ctx.params.invitation) { st.mode = 'invitation'; delete ctx.params.invitation; }
      const checks = [['Browser sent Negotiate', UI.pill('yes', 'ok')], ['Ticket for HTTP/ai.northwind.local', UI.pill('missing', 'danger')], ['Clock skew', '0.4 s'], ['KDC reachable from zone', UI.pill('yes', 'ok')], ['Fallback', 'LDAP password']];
      const errors = {
        ldap: UI.notice('The directory refused the bind: <b>invalid credentials</b> (LDAP 49). Two attempts left before lockout.', 'danger'),
        email_unverified: UI.notice('<b>Verify your email address first.</b> Northwind requires a verified address for local accounts. A new link was sent to m…r@northwind.local; it works once and expires in 24 hours. <a href="#" data-resend>Send it again</a>', 'warn'),
        signup_pending: UI.notice('<b>Your sign-up is waiting for approval.</b> An identity admin reviews new accounts for northwind.local. You will get an email when it is decided.', 'warn'),
        signup_rejected: UI.notice('<b>Your sign-up was not approved.</b> Contact the People Ops workspace admin if you think this is wrong.', 'danger'),
        sanction: UI.notice('<b>This account is suspended until 26 Sep 2026, 09:00.</b> Every sign-in, API key and token is refused until then (<span class="mono">403 step: sanction</span>). You can <a href="#" data-appeal>appeal the suspension</a>.', 'danger')
      };
      const options = '<div class="divider"></div><div class="eyebrow">Other ways to sign in</div><div class="vstack gap6">'
        + UI.btn('Continue with GitHub', { attrs: 'data-mode="github"' }) + UI.btn('Sign in with an AT-Protocol account', { attrs: 'data-mode="atproto"' }) + '</div>'
        + '<div class="hstack" style="justify-content:space-between;font-size:12px"><a href="#" data-mode="device">Enter a device code</a>' + (POLICY.mode !== 'closed' ? '<a href="#" data-mode="register">Create an account</a>' : '') + '<a href="#" data-diag>SSO diagnostics</a></div>';
      let form;
      if (st.mode === 'mfa') {
        const email = st.factor === 'email';
        form = (st.graceNote ? UI.notice('<b>A second factor is now required for your role.</b> You can sign in without one until 3 Oct 2026 (the grace period); after that you enrol first.', 'info') : '')
          + (email ? UI.notice('A six-digit code was sent to <b>m…r@northwind.local</b>. It is in the body of the email, works once and expires in 10 minutes.', 'info') : '')
          + '<div class="field"><label for="otp">' + (email ? 'Six-digit code from the email' : 'Six-digit code from your authenticator') + '</label><input class="input mono" id="otp" inputmode="numeric" maxlength="6" placeholder="000000" style="letter-spacing:.3em;font-size:18px;height:40px"></div>'
          + UI.check('Trust this browser for 30 days', !!st.trust, 'data-trust') + '<div class="muted" style="font-size:12px">Trusted devices skip the second factor until the period ends, until you sign out everywhere, or until the tenant shortens the period. Not available with a recovery code.</div>'
          + '<div class="vstack gap6">' + UI.btn('Verify', { kind: 'primary', attrs: 'data-verify' }) + (email ? UI.btn('Use my authenticator instead', { kind: 'ghost', attrs: 'data-factor="totp"' }) : UI.btn('Email me a code instead', { kind: 'ghost', attrs: 'data-factor="email"' })) + UI.btn('Use a recovery code', { kind: 'ghost', attrs: 'data-mode="form"' }) + '</div>';
      } else if (st.mode === 'device') {
        form = '<div class="field"><label for="dc">Device code shown by the client</label><input class="input mono" id="dc" value="WDJB-MJHT" style="font-size:16px;height:36px"></div>' + UI.notice('Authorising <b>exprsn-cli</b> on <b>build-03</b> for scopes <span class="mono">chat:write models:read</span>', 'info') + '<div class="vstack gap6">' + UI.btn('Authorise device', { kind: 'primary', attrs: 'data-go' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-mode="form"' }) + '</div>';
      } else if (st.mode === 'sso') {
        form = UI.notice('Signed in through Kerberos as <b>mokafor@NORTHWIND.LOCAL</b>. Redirecting to chat.', 'ok') + UI.btn('Continue', { kind: 'primary', attrs: 'data-go' });
      } else if (st.mode === 'register') {
        const s = strength(st.pw);
        form = st.registered
          ? UI.notice(st.registered === 'pending' ? '<b>Account created and waiting for approval.</b> An identity admin reviews sign-ups for northwind.local; you will get an email when it is decided. A verification link was sent to your address.' : '<b>Account created.</b> Check your email for the verification link, then sign in.', 'ok') + UI.btn('Back to sign in', { kind: 'primary', attrs: 'data-mode="form"' })
          : UI.notice('Sign-up is <b>' + esc(POLICY.mode === 'approval' ? 'open with approval' : POLICY.mode) + '</b> for ' + esc(POLICY.domains.join(', ')) + ' addresses. New accounts get the <span class="mono">' + esc(POLICY.roles.join(', ')) + '</span> role, clearance ' + UI.label(POLICY.clearance, { sm: true }) + ' and join ' + esc(POLICY.workspace) + '.', 'info')
            + (st.regError ? UI.notice(st.regError, 'danger') : '')
            + '<div class="field"><label for="ru">Username</label><input class="input" id="ru" value="' + esc(st.ru || '') + '" data-ru autocomplete="username"></div>'
            + '<div class="field"><label for="rn">Display name</label><input class="input" id="rn" value="' + esc(st.rn || '') + '" data-rn></div>'
            + '<div class="field"><label for="re">Email</label><input class="input" id="re" type="email" value="' + esc(st.re || '') + '" data-re placeholder="you@northwind.local"></div>'
            + '<div class="field"><label for="rp">Password</label><input class="input" id="rp" type="password" value="' + esc(st.pw) + '" data-rp autocomplete="new-password"></div>'
            + UI.meter('Password strength', s[1], s[0], s[2]) + '<div class="muted" style="font-size:12px">At least 12 characters. Checked against the breached-password list before the account is created.</div>'
            + '<div class="vstack gap6">' + UI.btn('Create account', { kind: 'primary', attrs: 'data-register' }) + UI.btn('Back to sign in', { kind: 'ghost', attrs: 'data-mode="form"' }) + '</div>';
      } else if (st.mode === 'invitation') {
        form = st.accepted
          ? UI.notice('<b>Welcome to ' + esc(INVITE.workspace) + '.</b> Your account was created with the invitation\'s roles and clearance; the address counts as verified.', 'ok') + UI.btn('Continue to chat', { kind: 'primary', attrs: 'data-go' })
          : '<div class="eyebrow">You were invited</div>' + UI.kv([['Tenant', esc(INVITE.tenant)], ['Workspace', esc(INVITE.workspace)], ['Invited by', esc(INVITE.invitedBy)], ['Email', '<span class="mono">' + esc(INVITE.email) + '</span>'], ['Roles', '<span class="mono">' + esc(INVITE.roles.join(' ')) + '</span>'], ['Clearance', UI.label(INVITE.clearance, { sm: true })], ['Link expires', esc(INVITE.expiresAt)]], 2)
            + '<div class="field"><label for="iu">Username</label><input class="input" id="iu" value="dokonkwo" autocomplete="username"></div>'
            + '<div class="field"><label for="in">Display name</label><input class="input" id="in" value="Dami Okonkwo"></div>'
            + '<div class="field"><label for="ip">Password</label><input class="input" id="ip" type="password" value="" autocomplete="new-password"></div>'
            + '<div class="vstack gap6">' + UI.btn('Accept invitation', { kind: 'primary', attrs: 'data-accept' }) + UI.btn('I already have an account', { kind: 'ghost', attrs: 'data-mode="form"' }) + '</div>'
            + '<div class="muted" style="font-size:12px">Signed in already? Accepting as that account adds the roles, raises the clearance if lower and joins the workspace; its address must be the invited one.</div>';
      } else if (st.mode === 'verified') {
        form = UI.notice('<b>Email address verified</b> for <span class="mono">mokafor</span> in Northwind. You can sign in now.', 'ok') + UI.btn('Sign in', { kind: 'primary', attrs: 'data-mode="form"' });
      } else if (st.mode === 'github') {
        form = UI.notice('Redirecting to <b>github.com</b> with a single-use state bound to this browser and PKCE (S256). Only a verified primary address is kept; organisations become groups <span class="mono">org</span> and teams <span class="mono">org/team-slug</span>. The access token is never stored.', 'info')
          + UI.kv([['Allowed organisations', '<span class="mono">northwind-io, northwind-finance</span>'], ['Callback', '<span class="mono">https://ai.northwind.local/federation/github/callback</span>'], ['Then', 'JIT provisioning, roles from group mappings, the MFA policy']], 1)
          + '<div class="vstack gap6">' + UI.btn('Continue to GitHub', { kind: 'primary', attrs: 'data-githubgo' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-mode="form"' }) + '</div>';
      } else if (st.mode === 'atproto') {
        const steps = [['Handle mara.northwind.social resolved by DNS TXT _atproto', 'did:plc:7iza6de2dwap2sbkpav7c6c6', 'ok'], ['DID document fetched from plc.directory', 'alsoKnownAs names the handle back', 'ok'], ['PDS https://pds.northwind.social', 'exactly one authorization server', 'ok'], ['Authorization server metadata', 'PAR, S256, ES256 DPoP, private_key_jwt, scope atproto', 'ok'], ['Pushed authorization request', 'login_hint set; DPoP nonce retried once', 'ok'], ['Redirect to the authorization endpoint', 'client_id and request_uri only', 'accent']];
        const shown = steps.slice(0, st.atSteps || 0);
        form = '<div class="field"><label for="ah">Handle or DID</label><input class="input mono" id="ah" value="mara.northwind.social" data-ah></div>'
          + (st.atError ? UI.notice('<b>Refused.</b> The handle resolves to a link-local address (<span class="mono">422 step: handle, reason: refused</span>). It was never fetched.', 'danger') : '')
          + (shown.length ? UI.timeline(shown.map((s, i) => ({ title: s[0], text: s[1], tone: i === shown.length - 1 && shown.length < steps.length ? 'accent' : s[2], meta: (40 + i * 37) + ' ms' }))) : '<div class="muted" style="font-size:12px">The account is resolved step by step; every address dialled is the address checked, so a handle or PDS that points at a link-local or metadata address is refused and never fetched.</div>')
          + '<div class="vstack gap6">' + UI.btn(shown.length >= steps.length ? 'Continue to the authorization server' : 'Continue', { kind: 'primary', attrs: 'data-atgo' }) + UI.btn('Cancel', { kind: 'ghost', attrs: 'data-mode="form"' }) + '</div>';
      } else {
        form = UI.notice('Single sign-on did not complete. Use your directory password.', 'warn', '<a href="#" data-why>Why?</a>')
          + (st.error ? errors[st.error] : '')
          + '<div class="field"><label for="u">Directory username</label><input class="input" id="u" value="mokafor" autocomplete="username"></div>'
          + '<div class="field"><label for="p">Password</label><input class="input" id="p" type="password" value="" autocomplete="current-password"></div>'
          + '<div class="vstack gap6">' + UI.btn('Sign in', { kind: 'primary', attrs: 'data-signin' }) + UI.btn('Use a passkey', { icon: 'key', attrs: 'data-passkey' }) + '</div>' + options;
      }
      root.innerHTML = '<div class="page" style="align-items:center;justify-content:center">'
        + '<div class="cols" style="align-items:stretch;justify-content:center;width:100%;max-width:900px">'
        + '<div class="panel" style="width:400px;max-width:100%;gap:18px;padding:28px"><div><div class="eyebrow" style="letter-spacing:.08em">Exprsn-AI</div><div style="font-size:22px;font-weight:600">' + (st.mode === 'register' ? 'Create an account' : st.mode === 'invitation' ? 'Join Northwind' : 'Sign in to Northwind') + '</div></div>' + form + '</div>'
        + '<div class="vstack gap12" style="width:420px;max-width:100%">' + UI.panel('SSO diagnostics', UI.table(['Check', 'Result'], checks, { clickable: false, cls: 'bare', minWidth: '0' }) + '<div class="muted" style="font-size:12px">The browser did not present a service ticket. Ask the desktop team to add ai.northwind.local to the intranet zone, or sign in with your password.</div>')
        + UI.panel('Sign-in options for this tenant', UI.table(['Store', 'Protocol', 'Notes'], OPTIONS.map((o) => [esc(o[0]), '<span class="mono">' + esc(o[1]) + '</span>', esc(o[2])]), { clickable: false, cls: 'bare', minWidth: '0' }) + '<div class="muted" style="font-size:12px">From <span class="mono">GET /api/auth/sign-in-options</span>: the chain of user stores, plus <span class="mono">signup: {approval, verifyEmail}</span>. Admin roles need their second factor whichever store signs them in.</div>')
        + UI.panel('Prototype', '<div class="fg2">Any password signs you in as <b>Mara Okafor</b>, a Finance Ops member who also holds admin roles, so every console area is visible. Press <span class="mono">?</span> anywhere for the prototype map.</div>') + '</div></div>'
        + '<div style="width:100%;max-width:900px"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';
      ctx.on('click', '[data-signin]', () => { if (st.error && st.error !== 'ldap') { ctx.toast('Refused: ' + esc(st.error) + '. The notice explains what to do.', 'warn'); return; } st.error = null; ctx.toast('Bound to OpenLDAP as mokafor. Session cookie issued.', 'ok'); ctx.app.signIn(); });
      ctx.on('click', '[data-go]', () => ctx.app.signIn());
      ctx.on('click', '[data-verify]', () => { ctx.toast(st.factor === 'email' ? 'Email code accepted.' + (st.trust ? ' This browser is trusted until 19 Oct 2026.' : '') : 'Second factor verified.' + (st.trust ? ' This browser is trusted until 19 Oct 2026.' : ''), 'ok'); ctx.app.signIn(); });
      ctx.on('change', '[data-trust] input', (e, t) => { st.trust = t.checked; });
      ctx.on('click', '[data-factor]', (e, t) => { st.factor = t.dataset.factor; ctx.rerender(); if (st.factor === 'email') ctx.toast('Code sent to m…r@northwind.local. At most 5 codes an hour.', 'ok'); });
      ctx.on('click', '[data-passkey]', () => { ctx.toast('Passkey verified on this device.', 'ok'); ctx.app.signIn(); });
      ctx.on('click', '[data-mode]', (e, t) => { e.preventDefault(); st.mode = t.dataset.mode; st.error = null; st.regError = null; st.atError = null; st.atSteps = 0; ctx.rerender(); });
      ctx.on('input', '[data-rp]', (e, t) => { st.pw = t.value; const m = ctx.$('.meter'); if (m) { const s = strength(st.pw); m.className = 'meter ' + s[2]; m.querySelector('.fill').style.width = s[0] + '%'; m.querySelector('.num').textContent = s[1]; } });
      ctx.on('input', '[data-ru]', (e, t) => { st.ru = t.value; }); ctx.on('input', '[data-rn]', (e, t) => { st.rn = t.value; }); ctx.on('input', '[data-re]', (e, t) => { st.re = t.value; });
      ctx.on('click', '[data-register]', () => {
        const email = (st.re || '').trim().toLowerCase(); const dom = email.split('@')[1] || '';
        if (!email || !(dom === 'northwind.local' || dom.endsWith('.northwind.local'))) { st.regError = '<b>That address cannot sign up here</b> (<span class="mono">403 reason: domain</span>). Northwind accepts northwind.local and its subdomains. The refusal is audited as user.signup.refused.'; ctx.rerender(); return; }
        if (strength(st.pw)[0] < 60) { st.regError = '<b>Choose a stronger password.</b> At least 12 characters, and not one found in the breached-password list.'; ctx.rerender(); return; }
        st.regError = null; st.registered = POLICY.mode === 'approval' ? 'pending' : 'active'; ctx.rerender(); ctx.toast('Account created as pending. Identity admins were notified; verification link sent.', 'ok', 4500);
      });
      ctx.on('click', '[data-accept]', () => { st.accepted = true; ctx.rerender(); ctx.toast('Account dokonkwo created in Finance Ops with member and flag-reviewer. Audited user.invitation.accepted.', 'ok', 4500); });
      ctx.on('click', '[data-resend]', (e) => { e.preventDefault(); ctx.toast('A new verification link was sent (202). The same answer whether or not the account exists.', 'ok'); });
      ctx.on('click', '[data-appeal]', (e) => { e.preventDefault(); ctx.modal({ title: 'Appeal the suspension', body: UI.kv([['Sanction', 'suspend, until 26 Sep 2026 09:00'], ['Reason given', 'Repeated prompt-injection attempts in Vendor contract summary'], ['Issued by', 'Priya Nair, 19 Sep 2026 13:58']], 1) + UI.field('Your statement', UI.textarea('', { rows: 4, placeholder: 'What should the reviewer know?' }), 'Sealed; read only by a reviewer who did not issue the sanction.') + UI.notice('One open appeal per sanction. A reviewer may also record it for you if you cannot sign in.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Submit appeal', { kind: 'primary', attrs: 'data-close data-appealgo' }), onMount(m) { m.querySelector('[data-appealgo]').addEventListener('click', () => ctx.toast('Appeal A-4 submitted. You will be notified by email when it is decided.', 'ok', 4500)); } }); });
      ctx.on('click', '[data-githubgo]', () => { ctx.toast('GitHub returned a verified primary address and 2 organisations. Signed in as mokafor with roles from group mappings.', 'ok', 4500); ctx.app.signIn(); });
      ctx.on('click', '[data-atgo]', () => {
        const v = (ctx.$('[data-ah]') || {}).value || '';
        if (/169\.254|metadata|localhost/.test(v)) { st.atError = true; st.atSteps = 0; ctx.rerender(); return; }
        st.atError = false;
        if ((st.atSteps || 0) >= 6) { ctx.toast('Authorization server answered with a DPoP-bound token for did:plc:7iza6de2dwap2sbkpav7c6c6. Bound to mokafor (proof: oauth).', 'ok', 4500); ctx.app.signIn(); return; }
        st.atSteps = (st.atSteps || 0) + 1; ctx.rerender(); const b = ctx.$('[data-atgo]'); if (b) b.focus();
      });
      ctx.on('click', '[data-why]', (e) => { e.preventDefault(); ctx.modal({ title: 'Why single sign-on did not complete', body: '<p style="margin:0" class="fg2">Kerberos SSO needs the browser to send a Negotiate ticket for <span class="mono">HTTP/ai.northwind.local</span>. This browser sent nothing, which usually means the site is not in its trusted intranet zone, or the machine is not domain-joined.</p><p style="margin:0" class="fg2">Password sign-in binds the same directory account, so roles and clearance are identical.</p>', actions: UI.btn('Close', { attrs: 'data-close' }) }); });
      ctx.on('click', '[data-diag]', (e) => { e.preventDefault(); ctx.toast('Diagnostics are shown on the right.'); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
