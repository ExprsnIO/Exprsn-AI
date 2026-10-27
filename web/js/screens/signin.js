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

  // ---- Password strength meter (B-802), shared with Settings and User stores ----
  // The server rates the password (entropy estimate), checks it against the policy's rules and, when the breached
  // check is on, against the breach corpus; the meter shows all three as text, not by colour alone.
  App.passwordMeter = {
    html() { return '<div data-pwmeter style="display:flex;flex-direction:column;gap:4px;font-size:12px" hidden></div>'; },
    render(box, r) {
      const tone = r.score <= 1 ? 'var(--danger-fg)' : r.score === 2 ? 'var(--warn-fg)' : 'var(--ok-fg)';
      const bars = [0, 1, 2, 3].map((i) => '<i style="flex:1;height:4px;border-radius:2px;background:' + (i < Math.max(1, r.score) ? tone : 'var(--bar-off)') + '"></i>').join('');
      const b = r.breached || {};
      const breach = b.mode === 'off' ? 'Not checked against breached-password lists on this server.' : !b.checked ? '' : b.found ? '<b>Found in a list of breached passwords. Choose another.</b>' : b.unavailable ? 'The breached-password list could not be reached; the server may accept it unchecked.' : 'Not found in breached-password lists.';
      const unmet = (r.rules || []).filter((x) => !x.ok);
      box.innerHTML = '<div style="display:flex;gap:3px" aria-hidden="true">' + bars + '</div>'
        + '<div role="status">Strength: <b>' + App.esc(r.label) + '</b>, about ' + Number(r.bits) + ' bits. ' + (unmet.length ? 'Not yet: ' + unmet.map((x) => App.esc(x.label.toLowerCase())).join('; ') + '.' : 'Meets the policy.') + '</div>'
        + (breach ? '<div class="muted">' + breach + '</div>' : '');
      box.hidden = false;
    },
    /** Rates `input` as the user types (debounced). `extra()` adds the reset link token or the target username. */
    attach(input, box, extra) {
      if (!input || !box) return;
      let timer = null; let turn = 0;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        const v = input.value;
        if (!v) { box.hidden = true; box.innerHTML = ''; return; }
        timer = setTimeout(() => {
          const mine = ++turn;
          App.post('/api/auth/password/check', Object.assign({ password: v }, extra ? extra() : {}))
            .then((r) => { if (mine === turn && input.value === v) App.passwordMeter.render(box, r); }, () => { if (mine === turn) { box.hidden = true; box.innerHTML = ''; } });
        }, 350);
      });
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

  // A password reset or invite link opens #/signin?reset=<token>[&tenant=<slug>]; since 1.4.0 (B-1801, B-1802) also
  // ?verify=<token> (an email verification link) and ?invitation=<token> (a workspace invitation). Read it once, before
  // the router rewrites the address, and take the token out of the address bar and history at once.
  let resetLink = null;
  (function () {
    const m = /^#\/signin\?(.*)$/.exec(location.hash || '');
    if (!m) return;
    const q = {}; m[1].split('&').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) { try { q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* malformed */ } } });
    const kind = q.reset ? 'reset' : q.verify ? 'verify' : q.invitation ? 'invitation' : null;
    if (!kind || !/^[A-Za-z0-9_-]{43}$/.test(q[kind])) return;
    resetLink = { kind, token: q[kind], tenant: /^[a-z0-9][a-z0-9-]{0,62}$/.test(q.tenant || '') ? q.tenant : '' };
    try { history.replaceState(null, '', location.pathname + location.search + '#/signin'); } catch (e) { /* history unavailable */ }
  })();
  // The strength meter needs a session or a reset link (POST /api/auth/password/check); the sign-up and invitation
  // forms (`fresh`) leave it out, and the server checks the password when the account is created.
  const pwFields = (current, fresh) => (current ? '<div class="field"><label for="pc">' + esc(current) + '</label><input class="input" id="pc" type="password" autocomplete="current-password"></div>' : '')
    + '<div class="field"><label for="pn">' + (fresh ? 'Password' : 'New password') + '</label><input class="input" id="pn" type="password" autocomplete="new-password" aria-describedby="pn-hint"><div class="hint" id="pn-hint">At least 12 characters. Not your username, not a common or breached password.</div>' + (fresh ? '' : App.passwordMeter.html()) + '</div>'
    + '<div class="field"><label for="pa">' + (fresh ? 'Password again' : 'New password again') + '</label><input class="input" id="pa" type="password" autocomplete="new-password"></div>';

  App.register({
    id: 'signin', title: 'Sign in', summary: 'Directory password, second factor, first-time enrolment; self-registration, invitation and verification links, trusted devices, email codes, GitHub and AT-Protocol sign-in', crumb: ['Sign in'], live: true,
    render(root, ctx) {
      const st = ctx.state;
      const pending = App.state.pendingSession;
      if (pending && !st.mode) { st.mode = pending.stage === 'enroll' ? 'enroll' : pending.stage === 'password' ? 'password' : 'mfa'; st.methods = (pending.mfa && pending.mfa.methods) || []; st.trustDays = (pending.mfa && pending.mfa.trustedDeviceDays) || 0; App.state.pendingSession = null; }
      if (resetLink && !st.mode) {
        if (resetLink.tenant) { st.tenant = resetLink.tenant; st.showTenant = true; }
        if (resetLink.kind === 'reset') { st.mode = 'reset'; st.resetToken = resetLink.token; }
        else if (resetLink.kind === 'invitation') { st.mode = 'invitation'; st.linkToken = resetLink.token; }
        else { st.mode = 'verify'; st.linkToken = resetLink.token; }
        resetLink = null;
      }
      st.mode = st.mode || 'form';
      const busy = st.busy ? ' disabled' : '';
      let form;
      if (st.mode === 'mfa') {
        const passkey = (st.methods || []).indexOf('webauthn') >= 0 && App.webauthn.supported();
        const hasTotp = (st.methods || []).indexOf('totp') >= 0; const hasEmail = (st.methods || []).indexOf('email') >= 0;
        // B-1803: "trust this browser" only when the tenant allows trusted devices and the account may have one.
        const trust = st.trustDays > 0 && !st.useRecovery ? UI.check('Trust this browser for ' + st.trustDays + ' day' + (st.trustDays === 1 ? '' : 's'), !!st.trust, 'data-trust') + '<div class="muted" style="font-size:12px">A trusted browser skips the second factor until the period ends, until you sign out everywhere, or until the tenant shortens the period. Not available with a recovery code.</div>' : '';
        form = (st.error ? problemNotice(st.error) : '')
          + (st.useEmail
            ? (st.emailSent ? UI.notice('A six-digit code was sent to <b>' + esc(st.emailSent.sentTo) + '</b>. It is in the body of the email and works once.', 'info') : '')
              + '<div class="field"><label for="otp">Six-digit code from the email</label><input class="input mono" id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" style="letter-spacing:.3em;font-size:18px;height:40px"></div>' + trust
              + '<div class="vstack gap6">' + UI.btn('Verify', { kind: 'primary', attrs: 'data-emailverify' + busy }) + UI.btn('Send a new code', { kind: 'ghost', attrs: 'data-emailsend' + busy }) + (hasTotp ? UI.btn('Use my authenticator instead', { kind: 'ghost', attrs: 'data-useemail="0"' }) : '') + UI.btn('Start over', { kind: 'ghost', attrs: 'data-restart' }) + '</div>'
            : st.useRecovery
            ? '<div class="field"><label for="rc">Recovery code</label><input class="input mono" id="rc" autocomplete="one-time-code" placeholder="xxxxx-xxxxx" style="font-size:16px;height:38px"></div><div class="vstack gap6">' + UI.btn('Verify recovery code', { kind: 'primary', attrs: 'data-recovery' + busy }) + UI.btn('Use the authenticator code instead', { kind: 'ghost', attrs: 'data-userecovery="0"' }) + '</div>'
            : (hasTotp ? '<div class="field"><label for="otp">Six-digit code from your authenticator</label><input class="input mono" id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" style="letter-spacing:.3em;font-size:18px;height:40px"></div>' : '')
              + (hasTotp || passkey ? trust : '')
              + '<div class="vstack gap6">' + (hasTotp ? UI.btn('Verify', { kind: 'primary', attrs: 'data-totp' + busy }) : '') + (passkey ? UI.btn('Use a passkey', { icon: 'key', attrs: 'data-passkey' + busy }) : '') + (hasEmail ? UI.btn('Email me a code' + (hasTotp || passkey ? ' instead' : ''), { kind: hasTotp || passkey ? 'ghost' : 'primary', attrs: 'data-emailsend' + busy }) : '') + ((st.methods || []).indexOf('recovery') >= 0 ? UI.btn('Use a recovery code', { kind: 'ghost', attrs: 'data-userecovery="1"' }) : '') + UI.btn('Start over', { kind: 'ghost', attrs: 'data-restart' }) + '</div>');
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
      } else if (st.mode === 'register') {
        const su = st.options && st.options.signup;
        form = st.registered
          ? UI.notice('<b>' + (st.registered.state === 'pending' ? 'Account created and waiting for approval.' : 'Account created.') + '</b> ' + esc(st.registered.detail || ''), 'ok') + '<div class="vstack gap6">' + UI.btn('Back to sign in', { kind: 'primary', attrs: 'data-backtoform' }) + '</div>'
          : (su ? UI.notice('Sign-up is <b>' + (su.approval ? 'open with approval' : 'open') + '</b> here' + (su.approval ? ': an admin approves new accounts before they can sign in' : '') + '.' + (su.verifyEmail ? ' You confirm your email address with a link before you sign in.' : ''), 'info') : UI.notice('Sign-up is closed here. Ask an admin for an invitation.', 'warn'))
            + (st.error ? problemNotice(st.error) : '')
            + (st.showTenant ? '<div class="field"><label for="t">Tenant</label><input class="input" id="t" value="' + esc(st.tenant || '') + '" autocomplete="organization"></div>' : '')
            + '<div class="field"><label for="ru">Username</label><input class="input" id="ru" value="' + esc(st.ru || '') + '" autocomplete="username" autocapitalize="none" spellcheck="false"></div>'
            + '<div class="field"><label for="rn">Display name</label><input class="input" id="rn" value="' + esc(st.rn || '') + '" autocomplete="name"></div>'
            + '<div class="field"><label for="re">Email</label><input class="input" id="re" type="email" value="' + esc(st.re || '') + '" autocomplete="email"></div>'
            + pwFields(null, true)
            + '<div class="vstack gap6">' + UI.btn('Create account', { kind: 'primary', attrs: 'data-register' + busy }) + UI.btn('Back to sign in', { kind: 'ghost', attrs: 'data-backtoform' }) + '</div>'
            + '<div class="muted" style="font-size:12px">The password is checked against the password policy when the account is created.</div>';
      } else if (st.mode === 'invitation') {
        const inv = st.invite;
        form = st.accepted
          ? UI.notice('<b>Welcome' + (inv && inv.workspace ? ' to ' + esc(inv.workspace.name) : '') + '.</b> ' + esc(st.accepted.detail || 'Your account is ready. Sign in.'), 'ok') + '<div class="vstack gap6">' + UI.btn('Sign in', { kind: 'primary', attrs: 'data-backtoform' }) + '</div>'
          : !inv ? (st.error ? problemNotice(st.error) + '<div class="vstack gap6">' + UI.btn('Back to sign in', { kind: 'ghost', attrs: 'data-backtoform' }) + '</div>' : UI.notice('Loading…', 'info'))
            : '<div class="eyebrow">You were invited</div>' + UI.kv([['Tenant', esc(inv.tenant.name)], ['Workspace', esc(inv.workspace ? inv.workspace.name : 'none')], ['Invited by', esc(inv.invitedBy || 'an admin')], ['Email', '<span class="mono" style="overflow-wrap:anywhere">' + esc(inv.email) + '</span>'], ['Roles', '<span class="mono">' + esc(inv.roles.join(' ')) + '</span>'], ['Clearance', UI.label(inv.clearance, { sm: true })], ['Link expires', esc(new Date(inv.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))]], 2)
              + (st.error ? problemNotice(st.error) : '')
              + '<div class="field"><label for="ru">Username</label><input class="input" id="ru" value="' + esc(st.ru || '') + '" autocomplete="username" autocapitalize="none" spellcheck="false"></div>'
              + '<div class="field"><label for="rn">Display name</label><input class="input" id="rn" value="' + esc(st.rn || '') + '" autocomplete="name"></div>'
              + pwFields(null, true)
              + '<div class="vstack gap6">' + UI.btn('Accept invitation', { kind: 'primary', attrs: 'data-accept' + busy }) + UI.btn('I already have an account', { kind: 'ghost', attrs: 'data-backtoform' }) + '</div>'
              + '<div class="muted" style="font-size:12px">Already have an account here? Accepting as that account (after signing in) adds the roles, raises the clearance if lower and joins the workspace; its address must be the invited one.</div>';
      } else if (st.mode === 'verify') {
        form = (st.verified ? UI.notice('<b>Email address verified</b> for <span class="mono">' + esc(st.verified.username) + '</span>. You can sign in now.', 'ok') : st.error ? problemNotice(st.error) : UI.notice('Checking the link…', 'info'))
          + '<div class="vstack gap6">' + UI.btn('Sign in', { kind: st.verified ? 'primary' : 'ghost', attrs: 'data-backtoform' }) + '</div>';
      } else if (st.mode === 'codes') {
        form = UI.notice('<b>Store these recovery codes now.</b> Each works once if you lose your authenticator. They are not shown again.', 'warn')
          + '<div class="codebox" style="columns:2;white-space:normal">' + st.codes.map((c) => '<div class="mono">' + esc(c) + '</div>').join('') + '</div>'
          + '<div class="vstack gap6">' + UI.btn('Copy codes', { attrs: 'data-copycodes' }) + UI.btn('I have stored them', { kind: 'primary', attrs: 'data-done' }) + '</div>';
      } else {
        const reason = st.error && st.error.problem && st.error.problem.reason;
        form = (st.info ? UI.notice(esc(st.info), 'ok') : '') + (st.error ? problemNotice(st.error) : '')
          + (reason === 'email_unverified' ? '<div style="font-size:12px"><a href="#" data-resend>Send the verification link again</a></div>' : '')
          + (st.showTenant ? '<div class="field"><label for="t">Tenant</label><input class="input" id="t" value="' + esc(st.tenant || '') + '" autocomplete="organization" placeholder="for example northwind"></div>' : '')
          + '<div class="field"><label for="u">Username</label><input class="input" id="u" value="' + esc(st.username || '') + '" autocomplete="username" autocapitalize="none" spellcheck="false"></div>'
          + '<div class="field"><label for="p">Password</label><input class="input" id="p" type="password" autocomplete="current-password"></div>'
          + '<div class="vstack gap6">' + UI.btn(st.busy ? 'Signing in…' : 'Sign in', { kind: 'primary', attrs: 'data-signin' + busy })
          + (st.options && st.options.kerberos ? UI.btn('Sign in with Kerberos', { icon: 'key', attrs: 'data-fedstart="' + esc(st.options.kerberos.start) + '"' }) : '')
          + (st.options ? st.options.upstream.map((u) => UI.btn(u.protocol === 'github' ? 'Continue with GitHub' + (u.name && !/^github$/i.test(u.name) ? ' (' + u.name + ')' : '') : u.protocol === 'atproto' ? 'Sign in with an AT-Protocol account' + (u.name ? ' (' + u.name + ')' : '') : 'Sign in with ' + u.name, { attrs: 'data-fedstart="' + esc(u.start) + '"' })).join('') : '') + '</div>'
          + '<div class="hstack wrap" style="justify-content:space-between;font-size:12px;row-gap:12px;column-gap:16px"><a href="#" data-tenant>' + (st.showTenant ? 'Use the default tenant' : 'Sign in to another tenant') + '</a>' + (st.options && st.options.signup ? '<a href="#" data-toregister>Create an account</a>' : '') + '<a href="#" data-forgot>Forgot your password?</a></div>';
      }
      root.innerHTML = '<div class="page" style="align-items:center;justify-content:center">'
        + '<form class="panel" style="width:400px;max-width:100%;gap:18px;padding:28px" novalidate data-form><div><div class="eyebrow" style="letter-spacing:.08em">Exprsn-AI</div><div style="font-size:22px;font-weight:600">' + (st.mode === 'enroll' ? 'Set up a second factor' : st.mode === 'codes' ? 'Recovery codes' : st.mode === 'mfa' ? 'Second factor' : st.mode === 'password' ? 'Change your password' : st.mode === 'reset' ? 'Set a new password' : st.mode === 'forgot' ? 'Reset your password' : st.mode === 'register' ? 'Create an account' : st.mode === 'invitation' ? 'Join ' + (st.invite ? st.invite.tenant.name : 'by invitation') : st.mode === 'verify' ? 'Confirm your email address' : 'Sign in') + '</div></div>' + form + '</form>'
        + '<div class="muted" style="font-size:12px;max-width:400px;text-align:center">Your directory account and password. Roles and clearance come from your directory groups.</div></div>';

      if (ctx.$('#pn')) App.passwordMeter.attach(ctx.$('#pn'), ctx.$('[data-pwmeter]'), () => (st.mode === 'reset' && st.resetToken ? { token: st.resetToken } : {}));
      const focus = ctx.$('#otp') || ctx.$('#rc') || ctx.$('#pc') || ctx.$('#ru') || ctx.$('#pn') || ctx.$('#fi') || (st.username ? ctx.$('#p') : ctx.$('#u'));
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
        // B-1803: a grace period before the tenant's MFA requirement applies, and a trusted browser that skipped the factor.
        if (s.mfa && s.mfa.enrolBy) ctx.toast('Your account will need a second factor from ' + esc(new Date(s.mfa.enrolBy).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })) + '. Add one in Settings before then.', 'warn', 8000);
        if (s.mfa && s.mfa.trustedDevice) ctx.toast('Second factor skipped: this browser is trusted.', 'ok');
        if (s.stage === 'active') return finish(s);
        st.info = null;
        st.mode = s.stage === 'enroll' ? 'enroll' : s.stage === 'password' ? 'password' : 'mfa'; st.methods = s.mfa.methods; st.trustDays = s.mfa.trustedDeviceDays || 0; st.trust = false; st.useEmail = false; st.emailSent = null;
      };
      // After the factor, an admin-set password still has to be changed before the session becomes active.
      const complete = (s) => {
        App.state.csrf = s.csrf;
        if (s.trustedDevice) ctx.toast('This browser is trusted until ' + esc(new Date(s.trustedDevice.until).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })) + '.', 'ok');
        if (s.stage === 'password') { st.mode = 'password'; return; }
        return finish(s);
      };
      const remember = () => (st.trust && st.trustDays > 0 ? { rememberDevice: true } : {});
      // A verification or invitation link: checked once when the page opens on it.
      if (st.mode === 'verify' && st.linkToken && !st.linkBusy) {
        const t = st.linkToken; st.linkBusy = true; st.linkToken = null;
        App.post('/api/auth/email/verify', { token: t }).then((r) => { st.verified = r; }, (err) => { st.error = err; }).finally(() => { st.linkBusy = false; if (App.state.route === 'signin') ctx.rerender(); });
      }
      if (st.mode === 'invitation' && st.linkToken && !st.invite && !st.linkBusy && !st.error) {
        st.linkBusy = true;
        App.post('/api/auth/invitations/preview', { token: st.linkToken }).then((r) => { st.invite = r; if (!st.ru) st.ru = r.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._@-]/g, ''); }, (err) => { st.error = err; st.linkToken = null; }).finally(() => { st.linkBusy = false; if (App.state.route === 'signin') ctx.rerender(); });
      }
      const newPassword = () => {
        const next = ctx.$('#pn').value, again = ctx.$('#pa').value;
        if (!next) { st.error = { message: 'Enter a new password.', problem: { title: 'Missing details' } }; return null; }
        if (next !== again) { st.error = { message: 'The two new passwords do not match.', problem: { title: 'Check the new password' } }; return null; }
        return next;
      };

      ctx.on('submit', '[data-form]', (e) => { e.preventDefault(); if (st.mode === 'form') signin(); else if (ctx.$('[data-register]')) ctx.$('[data-register]').click(); else if (ctx.$('[data-accept]')) ctx.$('[data-accept]').click(); else if (ctx.$('[data-emailverify]')) ctx.$('[data-emailverify]').click(); else if (ctx.$('[data-pwset]')) ctx.$('[data-pwset]').click(); else if (ctx.$('[data-resetgo]')) ctx.$('[data-resetgo]').click(); else if (ctx.$('[data-forgotgo]')) ctx.$('[data-forgotgo]').click(); else if (ctx.$('[data-totp]')) ctx.$('[data-totp]').click(); else if (ctx.$('[data-confirmtotp]')) ctx.$('[data-confirmtotp]').click(); else if (ctx.$('[data-recovery]')) ctx.$('[data-recovery]').click(); });
      ctx.on('click', '[data-signin]', (e) => { e.preventDefault(); signin(); });
      ctx.on('click', '[data-fedstart]', (e, t) => { e.preventDefault(); startFederated(t.dataset.fedstart); });
      ctx.on('click', '[data-tenant]', (e) => { e.preventDefault(); st.showTenant = !st.showTenant; if (!st.showTenant) st.tenant = ''; ctx.rerender(); });
      ctx.on('click', '[data-restart]', (e) => { e.preventDefault(); App.post('/api/auth/logout').catch(() => null); const u = st.username; Object.keys(st).forEach((k) => { delete st[k]; }); st.username = u; ctx.rerender(); });
      ctx.on('click', '[data-userecovery]', (e, t) => { e.preventDefault(); st.useRecovery = t.dataset.userecovery === '1'; st.error = null; ctx.rerender(); });
      ctx.on('change', '[data-trust]', (e, t) => { st.trust = t.checked; });
      ctx.on('click', '[data-totp]', (e) => { e.preventDefault(); const code = ctx.$('#otp').value.trim(); run(async () => complete(await App.post('/api/auth/mfa/totp', Object.assign({ code }, remember())))); });
      // B-1806: a one-time code sent to the account's confirmed email factor.
      ctx.on('click', '[data-emailsend]', (e) => { e.preventDefault(); run(async () => { st.emailSent = await App.post('/api/auth/mfa/email/send'); st.useEmail = true; st.useRecovery = false; }); });
      ctx.on('click', '[data-useemail]', (e, t) => { e.preventDefault(); st.useEmail = t.dataset.useemail === '1'; st.error = null; ctx.rerender(); });
      ctx.on('click', '[data-emailverify]', (e) => { e.preventDefault(); const code = ctx.$('#otp').value.trim(); run(async () => complete(await App.post('/api/auth/mfa/email', Object.assign({ code }, remember())))); });
      ctx.on('click', '[data-recovery]', (e) => { e.preventDefault(); const code = ctx.$('#rc').value.trim(); run(async () => complete(await App.post('/api/auth/mfa/recovery', { code }))); });
      ctx.on('click', '[data-passkey]', (e) => { e.preventDefault(); run(async () => { const opts = await App.post('/api/auth/mfa/webauthn/options'); const response = await App.webauthn.authenticate(opts); await complete(await App.post('/api/auth/mfa/webauthn', Object.assign({ response }, remember()))); }); });
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
      ctx.on('click', '[data-backtoform]', (e) => { e.preventDefault(); st.mode = 'form'; st.error = null; st.resetToken = null; st.linkToken = null; st.invite = null; st.registered = null; st.accepted = null; st.verified = null; ctx.rerender(); });
      // B-1801: self-registration under the tenant's policy, and accepting an invitation with a new account.
      ctx.on('click', '[data-toregister]', (e) => { e.preventDefault(); if (ctx.$('#t')) st.tenant = ctx.$('#t').value.trim(); st.mode = 'register'; st.error = null; st.registered = null; ctx.rerender(); });
      const readAccount = () => { st.ru = ctx.$('#ru').value.trim(); st.rn = ctx.$('#rn').value.trim(); if (ctx.$('#re')) st.re = ctx.$('#re').value.trim(); if (ctx.$('#t')) st.tenant = ctx.$('#t').value.trim(); };
      ctx.on('click', '[data-register]', (e) => {
        e.preventDefault(); readAccount();
        if (!st.ru || !st.rn || !st.re) { st.error = { message: 'Enter a username, your name and your email address.', problem: { title: 'Missing details' } }; ctx.rerender(); return; }
        const password = newPassword(); if (!password) { ctx.rerender(); return; }
        run(async () => { const r = await App.post('/api/auth/register', Object.assign({ username: st.ru, displayName: st.rn, email: st.re, password }, st.tenant ? { tenant: st.tenant } : {})); st.registered = r; st.username = r.username; });
      });
      ctx.on('click', '[data-accept]', (e) => {
        e.preventDefault(); readAccount();
        if (!st.ru || !st.rn) { st.error = { message: 'Enter a username and your name.', problem: { title: 'Missing details' } }; ctx.rerender(); return; }
        const password = newPassword(); if (!password) { ctx.rerender(); return; }
        run(async () => { const r = await App.post('/api/auth/invitations/accept', { token: st.linkToken, username: st.ru, displayName: st.rn, password }); st.accepted = r; st.linkToken = null; st.username = r.username; });
      });
      // B-1802: a new verification link after a refusal with reason email_unverified (the same answer either way).
      ctx.on('click', '[data-resend]', (e) => { e.preventDefault(); const identifier = st.username; if (!identifier) return; App.post('/api/auth/email/resend', Object.assign({ identifier }, st.tenant ? { tenant: st.tenant } : {})).then((r) => { st.error = null; st.info = r.detail; ctx.rerender(); }, (err) => { st.error = err; ctx.rerender(); }); });
      ctx.on('click', '[data-forgotgo]', (e) => {
        e.preventDefault(); const identifier = ctx.$('#fi').value.trim(); if (ctx.$('#t')) st.tenant = ctx.$('#t').value.trim();
        if (!identifier) { st.error = { message: 'Enter your username or email address.', problem: { title: 'Missing details' } }; ctx.rerender(); return; }
        st.username = identifier;
        run(async () => { const r = await App.post('/api/auth/password/forgot', st.tenant ? { identifier, tenant: st.tenant } : { identifier }); st.forgotDone = r.detail; });
      });
      ctx.on('click', '[data-resetgo]', (e) => {
        e.preventDefault(); const next = newPassword();
        if (!next) { ctx.rerender(); return; }
        run(async () => {
          const r = await App.post('/api/auth/password/reset', { token: st.resetToken, password: next }); st.resetToken = null; st.username = r.username;
          // An enrolment link (B-810) signs straight in to set up the second factor.
          if (r.session && r.session.stage === 'enroll') { App.state.csrf = r.session.csrf; st.mode = 'enroll'; st.methods = []; st.info = null; return; }
          st.mode = 'form'; st.info = 'Password set. Sign in with it now.';
        });
      });
    }
  });
})();
