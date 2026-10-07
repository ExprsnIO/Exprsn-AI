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

  /**
   * Step-up (B-106): sensitive changes answer 401 "Step-up required" when the last password or factor check is older
   * than the server's window. This asks for the password, an authenticator code or a passkey, and resolves true when
   * the server accepted it.
   */
  const stepUp = (ctx, opts) => new Promise((resolve) => {
    // B-3415: `factor` asks for a second factor only (an app password needs one; a password or an upstream sign-in does not count).
    const factorOnly = !!(opts && opts.factor);
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = !factorOnly && methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    const passkey = methods.indexOf('webauthn') >= 0 && App.webauthn && App.webauthn.supported();
    // B-803: a session from an upstream identity provider confirms by signing in there again.
    const upstream = !factorOnly && methods.indexOf('upstream') >= 0 && App.me.stepUp.upstream;
    let ok = false;
    ctx.modal({ title: factorOnly ? 'Confirm with your second factor' : 'Confirm it is you',
      body: '<div class="fg2">' + (factorOnly ? (opts.why || 'This change needs a fresh second factor; your password alone does not count.') + ' ' : 'This change needs a fresh check of who you are. ') + (pw && totp ? 'Enter your password or a code from your authenticator.' : pw ? 'Enter your password.' : totp ? 'Enter a code from your authenticator' + (passkey ? ', or use your passkey.' : '.') : passkey ? 'Use your passkey.' : upstream ? 'Sign in again at ' + esc(upstream.name) + '; you come back here and can then make the change.' : factorOnly ? 'Add an authenticator app or a passkey under Security first.' : 'Sign out and sign in again.') + '</div>'
        + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
        + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
        + '<div data-suerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + (upstream ? UI.btn('Sign in again at ' + esc(upstream.name), { kind: pw || totp ? '' : 'primary', attrs: 'data-suup' }) : '') + (passkey ? UI.btn('Use a passkey', { icon: 'key', attrs: 'data-supk' }) : '') + (pw || totp ? UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }) : ''),
      onMount(m) {
        const err = m.querySelector('[data-suerr]'); const first = m.querySelector('input'); if (first) first.focus();
        const send = async (body) => {
          try { await App.post('/api/me/step-up', body); ok = true; App.closeOverlay(); }
          catch (e) { const p = e.problem || {}; err.innerHTML = UI.notice(esc(p.detail || e.message), 'danger'); }
        };
        const go = () => {
          const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
          const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
          if (pwv) send({ password: pwv }); else if (code) send({ code }); else err.innerHTML = UI.notice(pw ? 'Enter your password or a code.' : 'Enter the code from your authenticator.', 'warn');
        };
        const b = m.querySelector('[data-sugo]'); if (b) b.addEventListener('click', go);
        m.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }));
        const up = m.querySelector('[data-suup]');
        if (up) up.addEventListener('click', async () => { try { const r = await App.post('/api/me/step-up/upstream'); location.assign(r.url); } catch (e) { err.innerHTML = UI.notice(esc((e.problem && e.problem.detail) || e.message), 'danger'); } });
        const pk = m.querySelector('[data-supk]');
        if (pk) pk.addEventListener('click', async () => { try { const opts = await App.post('/api/me/step-up/webauthn/options'); const response = await App.webauthn.authenticate(opts); await send({ response }); } catch (e) { err.innerHTML = UI.notice(esc((e.problem && e.problem.detail) || e.message), 'danger'); } });
      },
      onClose() { resolve(ok); } });
  });
  /** Runs `fn`; when the server asks for step-up, confirms the user and runs it once more. */
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx, err.problem.factor ? { factor: true } : null))) { const e = new Error('Not confirmed.'); e.cancelled = true; throw e; }
      return fn();
    }
  };

  App.register({
    id: 'settings', title: 'Settings', summary: 'Profile, public profile and status, appearance, security (email, factors, trusted devices), app passwords for DAV clients, API keys, connected applications, sessions, AT-Protocol account', crumb: ['Settings'], live: true,
    commands: [{ label: 'Create an API key', sub: 'Settings', run(app) { app.stateFor('settings').openCreate = true; app.render(); } }],
    // B-3413: the account's own verification, trusted devices, email codes and DID. States open what the user would see
    // (a dialog or a notice); none of them changes anything.
    states: [
      { title: 'Trusted devices forgotten', tone: 'neutral', text: 'Forgetting every trusted device makes the next sign-in from each browser ask for the second factor again. Audited as auth.trusted_device.removed.', apply(ctx) { ctx.state.openForget = true; ctx.rerender(); } },
      { title: 'DID challenge pending', tone: 'info', text: 'A claim issued a challenge token, shown once. Until the profile description contains it, Verify answers 409 and the binding is unverified.', apply(ctx) { ctx.state.openAtLink = true; ctx.rerender(); } },
      { title: 'Email factor added', tone: 'ok', text: 'An email one-time code is a second factor that admin roles may use (the Sprint 28 decision). Codes work once, for the session they were sent for.', apply(ctx) { ctx.state.openEmail = true; ctx.rerender(); } },
      { title: 'Address not verified', tone: 'warn', text: 'The tenant requires verified addresses. Until the link is redeemed, password sign-in refuses with email_unverified.', apply(ctx) { ctx.state.verifyNote = true; ctx.rerender(); } },
      // B-3415: app passwords for DAV clients.
      { title: 'App password shown once', tone: 'warn', text: 'A new app password is shown once with the username and the server address to type into the client. Afterwards only its name, prefix, scopes and dates remain.', apply(ctx) { ctx.state.openDavForm = true; ctx.rerender(); } },
      { title: 'Step-up for an app password', tone: 'info', text: 'Creating an app password asks for an authenticator code or a passkey when the second factor was confirmed longer ago than the step-up window; the password alone does not count.', apply(ctx) { ctx.state.openDavStepUp = true; ctx.rerender(); } },
      { title: 'Revoked app password refused', tone: 'danger', text: 'Revoking stops the password at once: the next DAV request from that device gets 401 with a Basic challenge, and the device asks for a new password.', apply(ctx) { ctx.state.davRefusedNote = true; ctx.rerender(); } },
      // B-5801, B-5802: the public profile and the status. States explain; none of them changes anything.
      { title: 'Picture in quarantine', tone: 'info', text: 'A new picture is stored in the file store of your current workspace and scanned like any upload. Until the scan passes, others see your initials.', apply(ctx) { ctx.state.avatarNote = 'quarantine'; ctx.rerender(); } },
      { title: 'Picture refused by the scan', tone: 'danger', text: 'A picture that fails the scan (malware, or bytes that are not an image) is never shown; upload another one.', apply(ctx) { ctx.state.avatarNote = 'rejected'; ctx.rerender(); } },
      { title: 'Bio blocked by a guardrail', tone: 'danger', text: 'Pronouns and the bio are screened at user-input like a post. A blocking rule refuses the change with 422 and the old text stays.', apply(ctx) { ctx.state.bioNote = true; ctx.rerender(); } },
      { title: 'Status set to busy', tone: 'ok', text: 'A chosen status is published at once over the socket: people who share a workspace with you see it within five seconds, people in a block with you never do.', apply(ctx) { ctx.state.statusNote = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const me = App.me;
      // Back from the AT-Protocol OAuth flow in "link" mode (B-1807): the callback bound the DID.
      if (ctx.params.atproto === 'linked') { st.linkedNote = true; delete ctx.params.atproto; st.loaded = false; try { history.replaceState(null, '', location.pathname + location.search + '#/settings'); } catch (e) { /* history unavailable */ } }
      if (!st.loaded && !st.loading) {
        st.loading = true;
        // Trusted devices and the DID are extras: a failure there leaves their panel saying so.
        const soft = (p) => p.catch((err) => ({ error: err }));
        // B-3415: app passwords for DAV clients and the discovery URLs (a browser session's; soft like the extras).
        const davLoad = me.credential === 'api_key' ? Promise.resolve(null) : soft(Promise.all([App.get('/api/me/dav'), App.get('/api/me/app-passwords')]).then(([info, list]) => ({ info, list })));
        Promise.all([App.get('/api/me/api-keys'), App.get('/api/me/sessions'), App.get('/api/me/mfa'), App.get('/api/me'), App.get('/api/me/grants'), soft(App.get('/api/me/trusted-devices')), App.can('atproto:link') && me.credential !== 'api_key' ? soft(App.get('/api/me/atproto')) : Promise.resolve(null), davLoad])
          .then(([keys, sessions, mfa, fresh, grants, trusted, atproto, dav]) => { st.keys = keys; st.sessions = sessions; st.mfa = mfa; st.grants = grants; st.trusted = trusted; st.atproto = atproto; st.dav = dav; App.setMe(fresh); st.loaded = true; })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; if (App.state.route === 'settings') ctx.rerender(); });
      }
      const theme = App.state.theme === 'dark' ? 'Dark' : App.state.theme === 'light' ? 'Light' : 'Follow system';
      const perms = me.permissions;

      const profile = UI.panel('Profile', UI.kv([['Name', esc(me.user.displayName)], ['Account', '<span class="mono">' + esc(me.user.username) + '</span>'], ['Tenant', esc(me.tenant ? me.tenant.name : '')], ['Clearance', UI.label(me.user.clearance, { sm: true })], ['Roles', esc(me.roles.map((r) => r.name).join(', ') || 'none')], ['Signed in with', me.credential === 'api_key' ? 'API key' : 'browser session']], 2)
        + '<div class="muted" style="font-size:12px">Name, account, clearance and roles come from your user store and its group mappings. Ask an identity admin to change them.</div>');

      // B-5801, B-5802: the public profile and the status (/api/people/me), loaded on their own.
      const social = App.can('social:read'); const socialW = App.can('social:write');
      if (social && !st.person && !st.personLoading && !st.personError) {
        st.personLoading = true;
        App.get('/api/people/me').then((p) => { st.person = p; }).catch((err) => { st.personError = err; }).finally(() => { st.personLoading = false; if (App.state.route === 'settings') ctx.rerender(); });
      }
      const pr = st.person;
      const PSTATUS = { available: 'ok', away: 'warn', busy: 'danger', offline: 'outline' };
      let publicPanel = ''; let statusPanel = '';
      if (social) {
        const myWs = me.workspaces || [];
        const av = pr && pr.avatar;
        const pic = av && av.state === 'ready' && av.url ? '<img class="settings-avatar" src="' + esc(av.url) + '" alt="Your profile picture" width="56" height="56">' : '<span class="settings-avatar" aria-hidden="true">' + esc(String(me.user.displayName || me.user.username || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()) + '</span>';
        const avNote = st.avatarNote === 'quarantine' ? UI.notice('<b>New pictures are scanned first.</b> A picture goes into the file store of your current workspace and through its quarantine (type from the bytes, the text classifier, ClamAV when configured). Until it passes, others see your initials.', 'info', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-avnoteok' }))
          : st.avatarNote === 'rejected' ? UI.notice('<b>A picture that fails the scan is never shown.</b> Malware, or bytes that are not an image, leave the picture rejected in the file store; upload another one.', 'danger', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-avnoteok' }))
          : av && (av.state === 'quarantined' || av.state === 'scanning') ? UI.notice('<b>Scanning your new picture.</b> Others see your initials until it passes.', 'info', UI.btn('Check again', { kind: 'ghost', size: 'sm', attrs: 'data-avrefresh' }))
          : av && (av.state === 'rejected' || av.state === 'not an image') ? UI.notice('<b>Picture refused by the scan.</b> It is never shown; upload another picture.', 'danger')
          : av && av.state === 'gone' ? UI.notice('<b>Your picture is not shown.</b> Its file is in the trash.', 'warn') : '';
        const shownIn = pr && pr.workspaces && pr.workspaces.length ? pr.workspaces[0] : 'all';
        publicPanel = UI.panel('Public profile', st.personError ? UI.problem('Profile not loaded', st.personError.message, st.personError.problem && st.personError.problem.trace_id) : !pr ? UI.notice('Loading…', 'info')
          : '<div class="hstack" style="gap:12px;align-items:center">' + pic + '<div class="vstack" style="gap:6px;min-width:0">' + (socialW && App.can('files:write') ? '<div class="hstack wrap gap6">' + UI.btn(av ? 'Change picture' : 'Upload a picture', { size: 'sm', icon: 'upload', attrs: 'data-avpick' }) + (av ? UI.btn('Remove', { size: 'sm', kind: 'ghost', attrs: 'data-avremove' }) : '') + '<input type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" data-avfile aria-label="Profile picture"></div>' : '') + '<span class="muted" style="font-size:12px">PNG, JPEG, WebP or GIF, at most 2 MiB. Kept in the file store and scanned before anyone sees it.</span></div></div>'
            + avNote
            + '<div class="formgrid" style="--cols:2">' + UI.field('Pronouns', UI.input(pr.pronouns || '', { attrs: 'data-pron maxlength="40"' + (socialW ? '' : ' disabled'), placeholder: 'she/her' })) + UI.field('Label', UI.select(['public', 'internal', 'confidential', 'restricted'].filter((l) => ({ public: 1, internal: 2, confidential: 3, restricted: 4 })[l] <= ({ public: 1, internal: 2, confidential: 3, restricted: 4 })[me.user.clearance]), pr.label, 'data-plabel' + (socialW ? '' : ' disabled')), 'People below it see your name only.') + '</div>'
            + UI.field('Bio', UI.textarea(pr.bio || '', { attrs: 'data-bio maxlength="500"' + (socialW ? '' : ' disabled'), rows: 3 }), 'Up to 500 characters. Pronouns and the bio are screened at user-input like a post.')
            + (st.bioNote ? UI.notice('<b>A guardrail can refuse a bio.</b> A blocking or holding rule at user-input refuses the change with 422 (step guardrails) and your previous text stays; a redacting rule saves the redacted text.', 'danger', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-bionoteok' })) : '')
            + (st.bioProblem ? UI.problem('Profile not saved', st.bioProblem.message, st.bioProblem.problem && st.bioProblem.problem.trace_id) : '')
            + UI.field('Shown in', UI.select([{ value: 'all', label: 'Every workspace I share with them' }].concat(myWs.map((w) => ({ value: w.id, label: w.name + ' only' }))), shownIn, 'data-pws' + (socialW ? '' : ' disabled')), 'Outside it, people who share a workspace with you see your name only.')
            + '<div class="hstack">' + (socialW ? UI.btn('Save profile', { kind: 'primary', size: 'sm', attrs: 'data-saveprofile' }) : '') + '<span class="grow"></span>' + '<a href="#/person?user=me" class="btn ghost sm">See how others see you</a></div>');
        const chosen = pr && pr.presence ? pr.presence.status : 'auto'; const eff = pr && pr.presence ? pr.presence.effective : 'offline';
        statusPanel = UI.panel('Status', !pr ? UI.notice('Loading…', 'info') : UI.seg([{ id: 'auto', label: 'Automatic' }, { id: 'available', label: 'Available' }, { id: 'away', label: 'Away' }, { id: 'busy', label: 'Busy' }, { id: 'offline', label: 'Appear offline' }], chosen, 'data-pstatus aria-label="Status"')
          + '<div class="hstack gap6" style="margin-top:4px">Others see ' + UI.pill(eff, PSTATUS[eff]) + '</div>'
          + (st.statusNote ? UI.notice('<b>Statuses are published at once.</b> People who share a workspace with you see a change within five seconds over the socket; people in a block with you never see your status.', 'ok', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-statusnoteok' })) : '')
          + '<span class="muted" style="font-size:12px">Automatic is available while you are connected, away after five minutes without input or while the console is hidden, offline when you close it. People in a block with you never see your status.</span>');
      }

      const a11y = App.state.a11y || 'system';
      const eff = App.a11yMode();
      const pwHome = me.password || { managedHere: false, stores: [] };
      const passwordPanel = UI.panel('Password', pwHome.managedHere
        ? '<div class="formgrid" style="--cols:1">' + UI.field('Current password', UI.input('', { type: 'password', attrs: 'data-pwcur autocomplete="current-password"' }))
          + UI.field('New password', UI.input('', { type: 'password', attrs: 'data-pwnew autocomplete="new-password"' }), 'At least 12 characters. Not your username, not a common or breached password.') + App.passwordMeter.html()
          + UI.field('New password again', UI.input('', { type: 'password', attrs: 'data-pwagain autocomplete="new-password"' })) + '</div>'
          + '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">Changing it signs out your other sessions and applications.</span>' + UI.btn('Change password', { kind: 'primary', size: 'sm', attrs: 'data-pwchange' }) + '</div>'
        : '<div class="fg2" style="font-size:13px">Your password is kept by ' + esc((pwHome.stores || []).join(', ') || 'your directory') + '. Change it there; this server never stores it.</div>');

      const appearance = UI.panel('Appearance', '<div class="formgrid" style="--cols:2">' + UI.field('Theme', UI.select(['Follow system', 'Light', 'Dark'], theme, 'data-theme'))
        + UI.field('Accessibility', UI.select(A11Y, a11y, 'data-a11y-mode'), a11y === 'system' ? 'In use: ' + (eff === 'aaa' ? 'Enhanced, because your system asks for more contrast.' : 'Standard.') : '') + '</div>'
        + UI.toggle('Single-key shortcuts (? opens the screen map)', App.state.singleKeys, 'data-singlekeys data-manual="1"')
        + '<span class="muted" style="font-size:12px">The accessibility mode is saved with your account and follows you to other browsers; the theme and shortcuts are saved in this browser. Standard meets WCAG 2.2 AA. Enhanced raises text contrast to 7:1, enlarges click targets, shows a focus ring on every focused control, underlines links, stops animation and keeps messages on screen longer. Reduced motion from your system is always honoured.</span>');

      const factors = st.mfa ? st.mfa.factors : [];
      const hasEmailFactor = factors.some((f) => f.kind === 'email');
      const addr = me.user.email;
      const emailBlock = '<div class="eyebrow">Email address</div>'
        + (!addr ? '<div class="fg2" style="font-size:13px">No email address on your account. ' + (pwHome.managedHere ? 'Ask an identity admin to add one.' : 'Your directory keeps it.') + '</div>'
          : me.user.emailVerified ? '<div class="hstack wrap"><span class="mono" style="overflow-wrap:anywhere">' + esc(addr) + '</span>' + UI.pill('verified', 'ok') + '</div>'
            : '<div class="hstack wrap"><span class="mono" style="overflow-wrap:anywhere">' + esc(addr) + '</span>' + UI.pill('not verified', 'warn') + (pwHome.managedHere ? UI.btn('Send verification link', { size: 'sm', attrs: 'data-sendverify' }) : '') + '</div>')
        + (st.verifyNote ? UI.notice('When ' + esc(me.tenant ? me.tenant.name : 'the tenant') + ' requires verified addresses, password sign-in to a local account with an unproven address answers <span class="mono">403 email_unverified</span> and sends a new link, throttled, until the link is redeemed.' + (addr && me.user.emailVerified ? ' Your address is verified.' : ''), 'warn', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-verifydone' })) : '');
      const tr = st.trusted && !st.trusted.error ? st.trusted : null;
      const trustedBlock = '<div class="divider"></div><div class="hstack"><div class="eyebrow grow">Trusted devices' + (tr ? ', ' + tr.periodDays + ' days' : '') + '</div>' + UI.btn('Forget all', { kind: 'ghost', size: 'sm', attrs: 'data-forgetdevices', disabled: !(tr && tr.devices.length) }) + '</div>'
        + (st.trusted && st.trusted.error ? UI.notice('Trusted devices could not be loaded: ' + esc(st.trusted.error.message), 'danger')
          : !tr ? ''
            : UI.table(['Browser', 'Trusted since', 'Until'], tr.devices.map((d) => [esc(d.browser || 'Unknown browser'), esc(when(d.createdAt)), esc(new Date(d.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))]), { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No trusted devices', emptyText: tr.periodDays ? 'Tick "trust this browser" at the second-factor step to add one.' : 'Trusted devices are off in this tenant.' })
              + (tr.thisDevice ? '<div class="hstack">' + UI.pill('this device', 'accent') + '<span class="muted" style="font-size:12px">This browser skips the second factor.</span></div>' : ''))
        + '<span class="muted" style="font-size:12px">A trusted browser skips the second factor until its period ends, until you sign out everywhere or change your password, or until the tenant shortens the period. Accounts with admin roles are asked on every sign-in.</span>';
      const mfaPanel = UI.panel('Security', emailBlock + '<div class="divider"></div><div class="hstack"><div class="eyebrow grow">Second factors</div>' + (addr ? UI.btn('Add email code', { size: 'sm', icon: 'plus', attrs: 'data-addemail', disabled: hasEmailFactor }) : '') + '</div>' + (st.codes ? UI.notice('<b>New recovery codes. Store them now; they are shown once.</b><div class="mono" style="margin-top:4px;columns:2">' + st.codes.map((c) => '<div>' + esc(c) + '</div>').join('') + '</div>', 'warn', UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-codesdone' })) : '')
        + (st.totp ? UI.notice('Add this key to your authenticator app: <span class="mono" style="overflow-wrap:anywhere">' + esc(st.totp.secret.replace(/(.{4})/g, '$1 ').trim()) + '</span>, then enter the code it shows.' + '<div class="hstack gap6" style="margin-top:6px"><input class="input mono" data-totpcode inputmode="numeric" maxlength="6" placeholder="000000" style="width:110px">' + UI.btn('Confirm', { kind: 'primary', size: 'sm', attrs: 'data-totpconfirm' }) + UI.btn('Cancel', { kind: 'ghost', size: 'sm', attrs: 'data-totpcancel' }) + '</div>', 'info') : '')
        + UI.table(['Factor', 'Added', 'Last used', { label: '', right: true }], factors.map((f) => ({ cells: [esc(f.label) + ' ' + UI.pill(f.kind === 'webauthn' ? 'passkey' : f.kind === 'email' ? 'email code' : 'authenticator', 'outline'), esc(when(f.createdAt)), esc(when(f.lastUsedAt)), '<span class="hstack" style="justify-content:flex-end">' + UI.btn('Remove', { kind: 'ghost', size: 'sm', attrs: 'data-rmfactor="' + esc(f.id) + '"' }) + '</span>'] })), { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No second factor', emptyText: 'Add one to protect your account. Admin roles require it.' })
        + '<div class="hstack wrap gap6">' + UI.btn('Add authenticator app', { size: 'sm', attrs: 'data-addtotp' }) + (App.webauthn && App.webauthn.supported() ? UI.btn('Add passkey', { size: 'sm', icon: 'key', attrs: 'data-addpasskey' }) : '') + (factors.length ? UI.btn('New recovery codes', { kind: 'ghost', size: 'sm', attrs: 'data-newcodes' }) : '') + '<span class="muted grow" style="font-size:12px;text-align:right">' + (st.mfa ? st.mfa.recoveryCodesRemaining + ' recovery codes left' : '') + '</span></div>' + trustedBlock);

      // ---- app passwords for DAV clients (B-3415) ----
      const SCOPE_NAMES = { caldav: 'CalDAV', carddav: 'CardDAV', webdav: 'WebDAV' };
      const SCOPE_HINTS = { caldav: 'calendars and group events', carddav: 'contacts', webdav: 'files' };
      const scopeNames = (list) => list.map((x) => SCOPE_NAMES[x] || x).join(', ');
      const dav = st.dav && !st.dav.error ? st.dav : null;
      const davInfo = dav ? dav.info : null;
      const appPws = dav ? dav.list : [];
      const short = (ua) => (!ua ? '' : ua.length > 36 ? ua.slice(0, 35) + '…' : ua);
      const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      const urlRow = (label, url, hint, key) => [esc(label), '<span class="hstack gap6"><span class="mono" style="overflow-wrap:anywhere">' + esc(url) + '</span>' + UI.iconbtn('copy', 'Copy the ' + label + ' address', { attrs: 'data-davcopy="' + key + '"', cls: 'sm ghost' }) + '</span>' + (hint ? '<div class="muted" style="font-size:11px">' + esc(hint) + '</div>' : '')];
      const fresh = davInfo && davInfo.stepUp.freshUntil && davInfo.stepUp.freshUntil > Date.now();
      const davPanel = me.credential === 'api_key' ? '' : UI.panel('App passwords for DAV clients',
        (st.dav && st.dav.error ? UI.notice('App passwords could not be loaded: ' + esc(st.dav.error.message), 'danger') : '')
        + '<div class="fg2" style="font-size:13px">Calendar, contacts and file apps sign in with your username and an app password made for that device. App passwords work for CalDAV, CardDAV and WebDAV only; the console and the API refuse them.</div>'
        + (davInfo ? UI.kv([
          urlRow('Server', davInfo.server.url, 'Apple Calendar and Contacts, DAVx5 and Thunderbird can also start from the host name alone.', 'url'),
          urlRow('CalDAV discovery', davInfo.server.caldav, 'Calendars and the events of your groups.', 'caldav'),
          urlRow('CardDAV discovery', davInfo.server.carddav, 'The directory and your own address books.', 'carddav'),
          urlRow('WebDAV', davInfo.server.webdav, 'The file store: your workspaces and the files shared with you. Mount it in Finder (Connect to Server), Windows or any WebDAV client with a password that has the WebDAV scope.', 'webdav'),
          ['Username', '<span class="mono">' + esc(davInfo.username) + '</span> <span class="muted" style="font-size:11px">or ' + esc(davInfo.usernameWithTenant) + '</span>']], 2) : '')
        + (st.davRevealed ? UI.notice('<b>App password for <span class="mono">' + esc(st.davRevealed.name) + '</span> created. Type it into the device now; it is shown once.</b><div class="mono" data-davsecret style="margin-top:4px;overflow-wrap:anywhere">' + esc(st.davRevealed.password) + '</div><div class="muted" style="font-size:12px;margin-top:4px">Username <span class="mono">' + esc(st.davRevealed.username) + '</span>, server <span class="mono" style="overflow-wrap:anywhere">' + esc(st.davRevealed.server) + '</span></div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-davcopy="password"' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-davdone' })) : '')
        + (st.davRefusedNote ? UI.notice('<b>A revoked app password stops at once.</b> The next request from that device gets <span class="mono">401</span> with a Basic challenge, and the device asks for a new password; make one here if it is still yours.', 'danger', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-davrefuseddone' })) : '')
        + (davInfo ? '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">' + (!davInfo.stepUp.hasFactor ? 'Add an authenticator app or a passkey under Security first: creating an app password needs a fresh second factor.' : fresh ? 'Your second factor was confirmed recently; creating one needs no further check until ' + esc(new Date(davInfo.stepUp.freshUntil).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) + '.' : 'Creating one asks for your authenticator code or a passkey first.') + '</span>' + UI.btn('Create app password', { kind: 'primary', size: 'sm', icon: 'key', attrs: 'data-davcreate', disabled: !davInfo.stepUp.hasFactor }) + '</div>' : '')
        + (dav ? UI.table(['Device', 'Scopes', 'Created', 'Last used', 'Expires', { label: '', right: true }], appPws.map((a) => ({ cells: [esc(a.name) + '<div class="mono muted" style="font-size:11px">' + esc(a.prefix) + '…</div>', esc(scopeNames(a.scopes)), esc(day(a.createdAt)), a.state === 'revoked' ? '<span class="muted">revoked ' + esc(when(a.revokedAt)) + '</span>' : esc(when(a.lastUsedAt)) + (a.lastUsedAt && (a.lastUsedIp || a.lastUsedAgent) ? '<div class="muted" style="font-size:11px;overflow-wrap:anywhere"' + (a.lastUsedAgent ? ' title="' + esc(a.lastUsedAgent) + '"' : '') + '>' + esc([a.lastUsedIp, short(a.lastUsedAgent)].filter(Boolean).join(', ')) + '</div>' : ''), a.expiresAt ? (a.state === 'expired' ? '<span style="color:var(--warn-fg)">' + esc(day(a.expiresAt)) + '</span>' : esc(day(a.expiresAt))) : 'never', '<span class="hstack" style="justify-content:flex-end">' + (a.state === 'active' ? UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-davrevoke="' + esc(a.id) + '" aria-label="Revoke the app password for ' + esc(a.name) + '"' }) : UI.pill(a.state, a.state === 'expired' ? 'warn' : 'danger')) + '</span>'], attrs: 'data-apppw="' + esc(a.id) + '"' })), { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No app passwords', emptyText: 'Make one for each phone, tablet or computer that syncs your calendars, contacts or files.' }) : '')
        + '<span class="muted" style="font-size:12px">Each device gets its own password, so revoking one leaves the others working. A device can do only what your roles allow at the time. Revoked and expired passwords stay listed for 30 days. Creating and revoking one sends you a security notice.</span>');

      const keys = st.keys || [];
      const keyRows = keys.map((k) => {
        const action = k.state === 'active' ? UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-revoke="' + esc(k.id) + '"' }) : UI.pill(k.state, k.state === 'expired' ? 'warn' : 'danger');
        return { cells: [esc(k.name) + (k.signatureKey ? ' ' + UI.pill('signed requests', 'outline') : '') + '<div class="mono muted" style="font-size:11px">' + esc(k.prefix) + '…</div>', '<span class="mono">' + esc(k.scopes.join(' ')) + '</span>', k.state === 'expired' ? '<span style="color:var(--warn-fg)">' + esc(when(k.expiresAt)) + '</span>' : esc(new Date(k.expiresAt).toLocaleDateString()), esc(when(k.lastUsedAt)), '<span class="hstack" style="justify-content:flex-end">' + action + '</span>'] };
      });
      const keysPanel = UI.panel('API keys', '<div>' + UI.btn('Create key', { kind: 'primary', size: 'sm', icon: 'key', attrs: 'data-create' }) + '</div>'
        + (st.revealed ? UI.notice('<b>Key <span class="mono">' + esc(st.revealed.name) + '</span> created. Copy it now; it is shown once.</b><div class="mono" style="margin-top:4px;overflow-wrap:anywhere">' + esc(st.revealed.key) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copykey' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-revealdone' })) : '')
        + UI.table(['Name', 'Scopes', 'Expires', 'Last used', { label: '', right: true }], keyRows, { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No API keys', emptyText: 'Keys are bearer tokens for scripts and the CLI.' })
        + '<span class="muted" style="font-size:12px">Each key carries a subset of your own permissions and your clearance. Expired and revoked keys stay listed for 30 days; calls with them get <span class="mono">401 invalid_token</span>.</span>');

      const grants = st.grants || [];
      const grantsPanel = UI.panel('Connected applications', UI.table(['Application', 'Can do', 'Allowed', 'Last used', { label: '', right: true }], grants.map((g) => ({ cells: [esc(g.name) + '<div class="mono muted" style="font-size:11px">' + esc(g.clientId) + '</div>', '<span class="mono" style="overflow-wrap:anywhere">' + esc(g.scopes.join(' ')) + '</span>', esc(when(g.consentedAt || g.createdAt)) + (g.consentExpiresAt ? '<div class="muted" style="font-size:11px">asks again ' + esc(new Date(g.consentExpiresAt).toLocaleDateString()) + '</div>' : ''), esc(when(g.lastUsedAt)), '<span class="hstack" style="justify-content:flex-end">' + UI.btn('Remove access', { kind: 'ghost', size: 'sm', attrs: 'data-rmgrant="' + esc(g.clientId) + '" aria-label="Remove access for ' + esc(g.name) + '"' }) + '</span>'] })), { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No connected applications', emptyText: 'Applications you allow to act as you through single sign-on are listed here.' })
        + '<span class="muted" style="font-size:12px">Removing access ends the application\'s tokens at once and forgets your consent; it asks again next time.</span>');

      const sessions = st.sessions || [];
      const sessionsPanel = UI.panel('Sessions', UI.table(['Client', 'Signed in with', 'Address', 'Started', 'Last activity', { label: '', right: true }], sessions.map((s) => ({ cells: [esc(client(s.userAgent)) + (s.current ? ' ' + UI.pill('this session', 'accent') : ''), esc(s.method), '<span class="mono">' + esc(s.ip || '') + '</span>', esc(when(s.createdAt)), esc(when(s.lastSeenAt)), '<span class="hstack" style="justify-content:flex-end">' + (s.current ? '' : UI.btn('Sign out', { kind: 'ghost', size: 'sm', attrs: 'data-endsession="' + esc(s.id) + '"' })) + '</span>'] })), { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No sessions', emptyText: '' })
        + '<div class="hstack wrap"><span class="muted grow" style="font-size:12px">Signing a session out ends it at once, including its live connection. API keys are not affected.</span>' + UI.btn('Sign out other sessions', { kind: 'ghost', size: 'sm', attrs: 'data-signoutothers' }) + UI.btn('Sign out', { size: 'sm', icon: 'lock', attrs: 'data-signout' }) + '</div>');

      const atb = st.atproto && !st.atproto.error ? st.atproto.binding : null;
      const atPanel = !App.can('atproto:link') || me.credential === 'api_key' ? '' : UI.panel('AT-Protocol account', (st.atproto && st.atproto.error ? UI.notice('Your AT-Protocol account could not be loaded: ' + esc(st.atproto.error.message), 'danger') : '')
        + (st.linkedNote && atb ? UI.notice('<b>Account linked.</b> The authorization server confirmed <span class="mono" style="overflow-wrap:anywhere">' + esc(atb.did) + '</span>; the binding is verified with proof <span class="mono">oauth</span>.', 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-linkeddone' })) : '')
        + (!atb ? UI.empty('No account linked', 'Bind your own AT-Protocol DID to sign in with it and to label as yourself.', UI.btn('Link an account', { kind: 'primary', size: 'sm', attrs: 'data-atlink' }))
          : UI.kv([['DID', '<span class="mono" style="overflow-wrap:anywhere">' + esc(atb.did) + '</span>'], ['Handle', atb.handle ? '<span class="mono">' + esc(atb.handle) + '</span>' + (atb.handleCheckedAt ? ' <span class="muted" style="font-size:12px">checked ' + esc(when(atb.handleCheckedAt)) + '</span>' : '') : '<span class="muted">none</span>'], ['State', atb.verified ? UI.pill('verified', 'ok') + ' <span class="muted" style="font-size:12px">proof ' + esc(atb.proof || '') + ', ' + esc(when(atb.verifiedAt)) + '</span>' : atb.challengePending ? UI.pill('challenge pending', 'warn') : UI.pill('unverified', 'warn')], ['PDS', atb.pds ? '<span class="mono" style="overflow-wrap:anywhere">' + esc(atb.pds) + '</span>' : '<span class="muted">unknown</span>']], 2)
            + (atb.challengePending ? (st.atToken ? UI.notice('<b>Put this token in your profile description, then verify.</b> It is shown once and expires ' + esc(new Date(atb.challengeExpiresAt).toLocaleString()) + '.<div class="mono" style="margin-top:4px;overflow-wrap:anywhere">' + esc(st.atToken) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copytoken' })) : UI.notice('A challenge is open until ' + esc(new Date(atb.challengeExpiresAt).toLocaleString()) + '. Its token was shown once when it was issued; issue a new one from "Link an account" if you lost it.', 'info')) : '')
            + '<div class="hstack wrap gap6">' + (atb.challengePending ? UI.btn('Verify now', { kind: 'primary', size: 'sm', attrs: 'data-atverify' }) : '') + (!atb.verified ? UI.btn('Link an account', { size: 'sm', attrs: 'data-atlink' }) : UI.btn('Change handle', { size: 'sm', attrs: 'data-athandle' })) + UI.btn('Remove', { kind: 'ghost', size: 'sm', attrs: 'data-atremove' }) + '</div>')
        + '<span class="muted" style="font-size:12px">A bound DID signs in as you through the tenant\'s <span class="mono">atproto</span> store. The handle counts only while its DID document names it back.</span>');

      root.innerHTML = '<div class="page">' + UI.pagehead('Settings', 'Personal settings for ' + esc(me.user.displayName))
        + (st.loadError ? UI.problem('Settings could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) : '')
        + (!st.loaded && !st.loadError ? UI.notice('Loading…', 'info') : '')
        + '<style>#main .settings-avatar{display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:var(--fg);color:var(--bg);font-size:18px;font-weight:700;flex-shrink:0;object-fit:cover}</style>'
        + '<div class="grid2"><div class="vstack" style="gap:14px">' + profile + publicPanel + statusPanel + appearance + mfaPanel + davPanel + '</div><div class="vstack" style="gap:14px">' + passwordPanel + keysPanel + grantsPanel + atPanel + '</div></div>'
        + sessionsPanel + '</div>';

      if (ctx.$('[data-pwnew]')) App.passwordMeter.attach(ctx.$('[data-pwnew]'), ctx.$('[data-pwmeter]'));
      // Back from a step-up at the upstream identity provider (B-803): redeem it for this session, once.
      const handle = ctx.params && ctx.params.stepup;
      if (handle && st.stepupHandle !== handle) {
        st.stepupHandle = handle;
        try { history.replaceState(null, '', location.pathname + location.search + '#/settings'); } catch (e) { /* history unavailable */ }
        App.post('/api/me/step-up/upstream/complete', { handle }).then(() => ctx.toast('Confirmed. You can make the change now.', 'ok'), (err) => App.fail(err, 'Not confirmed'));
      }
      const reload = () => { st.loaded = false; ctx.rerender(); };
      const act = async (fn, okMsg) => { try { await fn(); if (okMsg) ctx.toast(okMsg, 'ok'); reload(); } catch (err) { if (!err.cancelled) App.fail(err); } };
      const guarded = (fn) => withStepUp(ctx, fn);

      // B-5801, B-5802: the public profile and the status.
      const personReload = () => { st.person = null; st.personError = null; ctx.rerender(); };
      ctx.on('click', '[data-avnoteok]', () => { st.avatarNote = null; ctx.rerender(); });
      ctx.on('click', '[data-bionoteok]', () => { st.bioNote = false; ctx.rerender(); });
      ctx.on('click', '[data-statusnoteok]', () => { st.statusNote = false; ctx.rerender(); });
      ctx.on('click', '[data-avrefresh]', personReload);
      ctx.on('click', '[data-avpick]', () => { const f = ctx.$('[data-avfile]'); if (f) f.click(); });
      ctx.on('change', '[data-avfile]', async (e, t) => {
        const file = t.files && t.files[0]; if (!file) return;
        let res;
        try { res = await fetch('/api/people/me/avatar', { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' } }); }
        catch (err) { App.fail(new App.ApiError({ status: 0, title: 'Network error', detail: 'The server could not be reached.' }), 'Picture not uploaded'); return; }
        const data = /json/.test(res.headers.get('content-type') || '') ? await res.json() : null;
        if (!res.ok) { App.fail(new App.ApiError(data || { status: res.status, title: res.statusText }), 'Picture not uploaded'); return; }
        st.person = data; ctx.toast('Picture uploaded to Files (202). It is shown once the scan passes.', 'ok'); ctx.rerender();
        // The scan is a job: look again shortly.
        setTimeout(() => { if (App.state.route === 'settings' && st.person && st.person.avatar && st.person.avatar.state !== 'ready' && !document.getElementById('overlay')) personReload(); }, 2500);
      });
      ctx.on('click', '[data-avremove]', async () => {
        const ok = await ctx.confirm({ title: 'Remove your picture', body: '<p class="fg2" style="margin:0">People see your initials again. The image stays in Files, where you can trash it.</p>', ok: 'Remove' });
        if (!ok) return;
        App.del('/api/people/me/avatar').then((p) => { st.person = p; ctx.toast('Picture removed. Audited profile.avatar.removed.', 'ok'); ctx.rerender(); }).catch((err) => App.fail(err, 'Not removed'));
      });
      ctx.on('click', '[data-saveprofile]', () => {
        const ws = ctx.$('[data-pws]').value;
        const body = { pronouns: ctx.$('[data-pron]').value.trim() || null, bio: ctx.$('[data-bio]').value.trim() || null, label: ctx.$('[data-plabel]').value, workspaces: ws === 'all' ? null : [ws] };
        App.patch('/api/people/me', body).then((p) => { st.person = p; st.bioProblem = null; ctx.toast('Profile saved. Audited profile.updated (the fields, not the text).', 'ok'); ctx.rerender(); })
          .catch((err) => { if (err.status === 422 || err.status === 403) { st.bioProblem = err; ctx.rerender(); } else App.fail(err, 'Profile not saved'); });
      });
      ctx.on('click', '[data-pstatus] [data-seg]', (e, t) => {
        if (!socialW) { ctx.toast('Changing your status needs social:write.', 'warn'); return; }
        const v = t.dataset.seg; if (st.person && st.person.presence && st.person.presence.status === v) return;
        App.api('PUT', '/api/presence/me', { status: v }).then((r) => { if (st.person) st.person.presence = r; ctx.toast('Status: ' + esc(t.textContent) + '. Others see ' + esc(r.effective) + '.', 'ok'); ctx.rerender(); }).catch((err) => App.fail(err, 'Status not changed'));
      });
      ctx.on('change', '[data-theme]', (e, t) => { App.setTheme(t.value === 'Dark' ? 'dark' : t.value === 'Light' ? 'light' : null); ctx.toast('Theme: ' + esc(t.value) + '.'); });
      ctx.on('change', '[data-a11y-mode]', (e, t) => {
        const v = t.value; App.setA11y(v === 'system' ? null : v); ctx.rerender();
        App.patch('/api/me/preferences', { a11y: v }).then((prefs) => { if (App.me) App.me.preferences = prefs; ctx.toast('Accessibility: ' + esc(A11Y.find((o) => o.value === v).label) + '. Saved with your account.'); }, (err) => App.fail(err, 'Not saved to your account'));
      });
      ctx.on('click', '[data-pwchange]', () => {
        const cur = ctx.$('[data-pwcur]').value, next = ctx.$('[data-pwnew]').value, again = ctx.$('[data-pwagain]').value;
        if (!cur || !next) { ctx.toast('Enter your current and new password.', 'warn'); return; }
        if (next !== again) { ctx.toast('The new passwords do not match.', 'warn'); return; }
        act(async () => { const r = await App.post('/api/me/password', { currentPassword: cur, newPassword: next }); ctx.toast('Password changed.' + (r.sessionsRevoked ? ' ' + r.sessionsRevoked + ' other session' + (r.sessionsRevoked === 1 ? '' : 's') + ' signed out.' : ''), 'ok'); });
      });
      ctx.on('click', '[data-singlekeys]', (e, t) => { App.setSingleKeys(!App.state.singleKeys); t.classList.toggle('on', App.state.singleKeys); t.setAttribute('aria-checked', App.state.singleKeys ? 'true' : 'false'); ctx.toast(App.state.singleKeys ? 'Single-key shortcuts on.' : 'Single-key shortcuts off. Ctrl K still opens the command palette.'); });

      ctx.on('click', '[data-addtotp]', () => act(async () => { st.totp = await App.post('/api/me/mfa/totp', { label: 'Authenticator app' }); }));
      ctx.on('click', '[data-totpcancel]', () => { st.totp = null; ctx.rerender(); });
      ctx.on('click', '[data-totpconfirm]', () => { const code = ctx.$('[data-totpcode]').value.trim(); act(async () => { const r = await App.post('/api/me/mfa/totp/' + encodeURIComponent(st.totp.id) + '/confirm', { code }); st.totp = null; if (r.recoveryCodes) st.codes = r.recoveryCodes; }, 'Authenticator added.'); });
      ctx.on('click', '[data-addpasskey]', () => act(async () => { const opts = await App.post('/api/me/mfa/webauthn/options'); const response = await App.webauthn.register(opts); const r = await App.post('/api/me/mfa/webauthn', { label: 'Passkey', response }); if (r.recoveryCodes) st.codes = r.recoveryCodes; }, 'Passkey added.'));
      ctx.on('click', '[data-newcodes]', async () => { const ok = await ctx.confirm({ title: 'Replace recovery codes?', tag: 'old codes stop working', tone: 'danger', body: '<div class="fg2">Ten new codes are generated and every earlier code stops working.</div>', ok: 'Generate new codes' }); if (ok) act(async () => { st.codes = (await guarded(() => App.post('/api/me/mfa/recovery-codes'))).recoveryCodes; }); });
      ctx.on('click', '[data-codesdone]', () => { st.codes = null; ctx.rerender(); });
      ctx.on('click', '[data-rmfactor]', async (e, t) => { const f = factors.find((x) => x.id === t.dataset.rmfactor); const ok = await ctx.confirm({ title: 'Remove ' + f.label + '?', tag: 'second factor', tone: 'danger', body: '<div class="fg2">You will no longer be able to sign in with it.</div>', ok: 'Remove' }); if (ok) act(() => guarded(() => App.del('/api/me/mfa/' + encodeURIComponent(f.id))), 'Factor removed. Audit entry written.'); });

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
          + UI.field('Public key for signed requests (optional)', UI.input('', { placeholder: 'Ed25519 public key, JWK x value or PEM', attrs: 'data-sigkey maxlength="400" autocomplete="off" spellcheck="false"' }), 'With a key here, every /v1 call made with this API key must carry an HTTP message signature (RFC 9421) by it.')
          + UI.notice('The key is shown once after creation. It inherits your clearance ceiling of ' + UI.label(me.user.clearance, { sm: true }) + '.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create key', { kind: 'primary', attrs: 'data-go' }),
          onMount(m) {
            const nameEl = m.querySelector('[data-name]'); nameEl.focus();
            m.querySelector('[data-go]').addEventListener('click', async () => {
              const name = nameEl.value.trim(); const chosen = Array.prototype.slice.call(m.querySelectorAll('[data-scope]:checked')).map((c) => c.dataset.scope);
              if (!name) { ctx.toast('Give the key a name.', 'warn'); return; }
              if (!chosen.length) { ctx.toast('Pick at least one scope.', 'warn'); return; }
              const body = { name, scopes: chosen, ttlDays: Number(m.querySelector('[data-exp]').value) };
              const sigKey = m.querySelector('[data-sigkey]').value.trim();
              if (sigKey) body.signatureKey = sigKey;
              const created = (r) => { st.revealed = { name, key: r.key }; App.closeOverlay(); reload(); ctx.toast('Key created. Copy it now; it will not be shown again.', 'warn', 5000); };
              try { created(await App.post('/api/me/api-keys', body)); } catch (err) {
                if (!(err.problem && err.problem.step_up)) { App.fail(err, 'Key not created'); return; }
                // The step-up dialog replaces this one; the key is created once the check succeeds.
                App.closeOverlay();
                if (await stepUp(ctx)) { try { created(await App.post('/api/me/api-keys', body)); } catch (err2) { App.fail(err2, 'Key not created'); } }
              }
            });
          } });
      };
      ctx.on('click', '[data-create]', openCreate);
      ctx.on('click', '[data-copykey]', () => { if (navigator.clipboard && st.revealed) navigator.clipboard.writeText(st.revealed.key).then(() => ctx.toast('Copied.', 'ok')); });
      ctx.on('click', '[data-revealdone]', () => { st.revealed = null; ctx.rerender(); });

      ctx.on('click', '[data-rmgrant]', async (e, t) => {
        const g = grants.find((x) => x.clientId === t.dataset.rmgrant);
        const ok = await ctx.confirm({ title: 'Remove access for ' + g.name + '?', tag: 'ends its tokens now', tone: 'danger', body: '<div class="fg2">' + esc(g.name) + ' can no longer act as you. Its access and refresh tokens stop working at once, and it asks for your consent again next time.</div>', kv: [['Can do', '<span class="mono">' + esc(g.scopes.join(' ')) + '</span>'], ['Last used', esc(when(g.lastUsedAt))]], ok: 'Remove access' });
        if (ok) act(() => App.del('/api/me/grants/' + encodeURIComponent(g.clientId)), 'Access removed for ' + esc(g.name) + '.');
      });
      ctx.on('click', '[data-endsession]', async (e, t) => { const s = sessions.find((x) => x.id === t.dataset.endsession); const ok = await ctx.confirm({ title: 'Sign out ' + client(s.userAgent) + '?', tag: 'ends the session', tone: 'danger', kv: [['Signed in with', esc(s.method)], ['Address', esc(s.ip || '')], ['Last activity', esc(when(s.lastSeenAt))]], ok: 'Sign out that session' }); if (ok) act(() => App.del('/api/me/sessions/' + encodeURIComponent(s.id)), 'Session ended.'); });
      ctx.on('click', '[data-signoutothers]', async () => { const ok = await ctx.confirm({ title: 'Sign out other sessions?', tag: 'all but this one', tone: 'danger', body: '<div class="fg2">Every other session for <span class="mono">' + esc(me.user.username) + '</span> ends now. API keys are not affected.</div>', ok: 'Sign out other sessions' }); if (ok) act(async () => { const r = await App.post('/api/me/sessions/revoke-others'); ctx.toast(r.revoked + ' session' + (r.revoked === 1 ? '' : 's') + ' ended.', 'ok'); }); });
      ctx.on('click', '[data-signout]', () => App.signOut());
      // ---- security: verification link, email codes, trusted devices (B-1802, B-1803, B-1806) ----
      ctx.on('click', '[data-verifydone]', () => { st.verifyNote = false; ctx.rerender(); });
      ctx.on('click', '[data-sendverify]', () => act(async () => { const r = await App.post('/api/me/email/verify'); ctx.toast(r.verified ? 'Your address is already verified.' : r.sent ? 'Verification link sent to ' + esc(me.user.email || 'your address') + '. It works once.' : 'The link could not be sent: email is not configured on this server.', r.verified || r.sent ? 'ok' : 'warn', 5000); }));
      const emailModal = () => ctx.modal({ title: 'Add an email one-time code',
        body: UI.notice('A six-digit code goes to <b>' + esc(me.user.email || 'your address') + '</b>. Codes are in the body of the email, work once and expire after a few minutes, and only a few are sent an hour. Wrong codes count in your lockout like wrong passwords.', 'info')
          + '<div data-emailstep>' + UI.btn('Send the code', { kind: 'primary', size: 'sm', attrs: 'data-emailsend' }) + '</div><div data-emailerr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }),
        onMount(m) {
          const err = m.querySelector('[data-emailerr]');
          m.querySelector('[data-emailsend]').addEventListener('click', async () => {
            let r; try { r = await App.post('/api/me/mfa/email', {}); } catch (e) { err.innerHTML = UI.notice(esc((e.problem && e.problem.detail) || e.message), 'danger'); return; }
            m.querySelector('[data-emailstep]').innerHTML = UI.field('Code from the email', UI.input('', { attrs: 'data-emailcode inputmode="numeric" maxlength="6" autocomplete="one-time-code"', placeholder: '000000' }), 'Sent to ' + esc(r.sentTo) + '.') + UI.btn('Confirm factor', { kind: 'primary', size: 'sm', attrs: 'data-emailconfirm' });
            const input = m.querySelector('[data-emailcode]'); input.focus();
            m.querySelector('[data-emailconfirm]').addEventListener('click', async () => {
              try { const c = await App.post('/api/me/mfa/email/' + encodeURIComponent(r.id) + '/confirm', { code: input.value.trim() }); if (c.csrf) App.state.csrf = c.csrf; if (c.recoveryCodes) st.codes = c.recoveryCodes; App.closeOverlay(); ctx.toast('Email factor confirmed. Sign-in now offers "Email me a code".', 'ok'); reload(); }
              catch (e) { const p = e.problem || {}; err.innerHTML = UI.notice(esc(p.detail || e.message) + (p.attempts_remaining != null ? ' Attempts remaining: ' + p.attempts_remaining + '.' : ''), 'danger'); }
            });
          });
        } });
      ctx.on('click', '[data-addemail]', emailModal);
      const forget = async () => {
        const tr = st.trusted && !st.trusted.error ? st.trusted : { devices: [], periodDays: 0 };
        const ok = await ctx.confirm({ title: 'Forget all trusted devices?', tone: 'info', body: '<div class="fg2">Every browser asks for the second factor on its next sign-in, this one included.</div>', kv: [['Devices', String(tr.devices.length)], ['Period', tr.periodDays + ' days']], ok: 'Forget all' });
        if (ok) act(async () => { const r = await App.del('/api/me/trusted-devices'); ctx.toast((r && r.removed != null ? r.removed : 0) + ' trusted device' + (r && r.removed === 1 ? '' : 's') + ' forgotten. Audited auth.trusted_device.removed.', 'ok'); });
      };
      ctx.on('click', '[data-forgetdevices]', forget);

      // ---- AT-Protocol account (B-1807) ----
      const atLink = () => ctx.modal({ title: 'Link an AT-Protocol account',
        body: UI.field('Handle or DID', UI.input(atb && atb.handle ? atb.handle : '', { attrs: 'data-ataccount autocomplete="off" spellcheck="false"', placeholder: 'alice.bsky.social' }), 'Resolved handle, DID, document, PDS through the service URL checks; a refused address is never fetched.')
          + '<div class="grid2">' + UI.panel('Prove it from your profile', '<div class="fg2" style="font-size:12px">We issue a challenge token; you put it in the profile description on your PDS, then verify here. Proof <span class="mono">profile</span>.</div><div>' + UI.btn('Issue challenge', { size: 'sm', kind: 'primary', attrs: 'data-atclaim' }) + '</div>')
          + UI.panel('Sign in with the account', '<div class="fg2" style="font-size:12px">The AT-Protocol OAuth flow with PKCE and DPoP; the callback binds the DID to you. Proof <span class="mono">oauth</span>.</div><div>' + UI.btn('Start sign-in', { size: 'sm', attrs: 'data-atoauth' }) + '</div>') + '</div>'
          + UI.notice('Needs a recent sign-in. A DID already bound to another user of the tenant is refused (409).', 'info') + '<div data-aterr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }),
        onMount(m) {
          const err = m.querySelector('[data-aterr]');
          const account = () => { const v = m.querySelector('[data-ataccount]').value.trim(); if (v.length < 3) { err.innerHTML = UI.notice('Enter your handle or DID.', 'warn'); return null; } return v; };
          const show = (e) => { const p = e.problem || {}; err.innerHTML = UI.notice('<b>' + esc(p.title || 'Not linked') + '.</b> ' + esc(p.detail || e.message) + (p.step ? ' <span class="mono">step: ' + esc(p.step) + (p.reason ? ', reason: ' + esc(p.reason) : '') + '</span>' : ''), 'danger'); };
          m.querySelector('[data-atclaim]').addEventListener('click', async () => {
            const v = account(); if (!v) return;
            try { const r = await guarded(() => App.post('/api/me/atproto/claim', { account: v })); st.atToken = r.challenge.token; App.closeOverlay(); ctx.toast('Challenge issued. Copy the token now; it is shown once and stored as a hash.', 'warn', 5000); reload(); }
            catch (e) { if (!e.cancelled) show(e); }
          });
          m.querySelector('[data-atoauth]').addEventListener('click', async () => {
            const v = account(); if (!v) return;
            try { const r = await guarded(() => App.post('/api/me/atproto/link', { account: v })); location.assign(r.url); }
            catch (e) { if (!e.cancelled) show(e); }
          });
        } });
      ctx.on('click', '[data-atlink]', atLink);
      ctx.on('click', '[data-linkeddone]', () => { st.linkedNote = false; ctx.rerender(); });
      ctx.on('click', '[data-copytoken]', () => { if (navigator.clipboard && st.atToken) navigator.clipboard.writeText(st.atToken).then(() => ctx.toast('Copied.', 'ok'), () => ctx.toast('Copy failed; select the token instead.', 'warn')); });
      ctx.on('click', '[data-atverify]', () => act(async () => { await App.post('/api/me/atproto/verify', {}); st.atToken = null; ctx.toast('DID verified from the profile record. Handle checked both ways. Audited atproto.did.verified.', 'ok', 5000); }));
      ctx.on('click', '[data-athandle]', () => ctx.modal({ title: 'Change the handle shown',
        body: UI.field('Handle', UI.input(atb && atb.handle ? atb.handle : '', { attrs: 'data-newhandle autocomplete="off" spellcheck="false"' }), 'Must resolve to ' + esc(atb ? atb.did : 'your DID') + ' and be named by its DID document; otherwise 422 reason mismatch.') + '<div data-hderr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-savehandle' }),
        onMount(m) { m.querySelector('[data-savehandle]').addEventListener('click', async () => { const h = m.querySelector('[data-newhandle]').value.trim(); try { await App.api('PUT', '/api/me/atproto/handle', { handle: h }); App.closeOverlay(); ctx.toast('Handle set. Audited atproto.handle.set.', 'ok'); reload(); } catch (e) { const p = e.problem || {}; m.querySelector('[data-hderr]').innerHTML = UI.notice(esc(p.detail || e.message) + (p.reason ? ' (reason ' + esc(p.reason) + ')' : ''), 'danger'); } }); } }));
      ctx.on('click', '[data-atremove]', async () => {
        if (!atb) return;
        const ok = await ctx.confirm({ title: 'Remove the AT-Protocol binding?', tone: 'danger', body: '<div class="fg2">The DID no longer signs you in. Labels already signed by the tenant\'s labeler are unaffected.</div>', kv: [['DID', '<span class="mono" style="overflow-wrap:anywhere">' + esc(atb.did) + '</span>'], ['Handle', esc(atb.handle || 'none')]], ok: 'Remove' });
        if (ok) act(() => App.del('/api/me/atproto'), 'Binding removed. Audited atproto.did.removed.');
      });
      // ---- app passwords for DAV clients (B-3415) ----
      const davForm = () => {
        const avail = davInfo ? davInfo.scopes : [];
        ctx.modal({ title: 'Create an app password',
          body: UI.field('Device name', UI.input('', { placeholder: 'for example iPad', attrs: 'data-davname maxlength="100" autocomplete="off"' }), 'Shown in this list, in the security notice and in the audit log.')
            + '<fieldset class="field" style="border:0;padding:0;margin:0"><legend class="fl">What it can reach</legend><div class="hstack wrap gap6" style="row-gap:12px">' + avail.map((x) => UI.check(SCOPE_NAMES[x.scope] + ' (' + SCOPE_HINTS[x.scope] + ')' + (x.available ? '' : ', not allowed by your roles'), x.available && x.scope !== 'webdav', 'data-davscope="' + esc(x.scope) + '"' + (x.available ? '' : ' disabled'))).join('') + '</div></fieldset>'
            + UI.field('Expires', UI.select([{ value: '', label: 'Never' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '180', label: '180 days' }, { value: '365', label: '1 year' }], '', 'data-davexp'))
            + UI.notice('Within your roles: if they change, the device can do only what you can. It never signs in to the console or the API.', 'info') + '<div data-daverr role="alert"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-davgo' }),
          onMount(m) {
            const nameEl = m.querySelector('[data-davname]'); nameEl.focus();
            const err = m.querySelector('[data-daverr]');
            m.querySelector('[data-davgo]').addEventListener('click', async () => {
              const name = nameEl.value.trim(); const scopes = Array.prototype.slice.call(m.querySelectorAll('[data-davscope]:checked')).map((c) => c.dataset.davscope);
              if (!name) { err.innerHTML = UI.notice('Give the device a name.', 'warn'); return; }
              if (!scopes.length) { err.innerHTML = UI.notice('Pick at least one of CalDAV, CardDAV or WebDAV.', 'warn'); return; }
              const exp = m.querySelector('[data-davexp]').value;
              const body = { name, scopes, ttlDays: exp ? Number(exp) : null };
              const created = (r) => { st.davRevealed = { name: r.name, password: r.password, username: r.username, server: r.server.url }; App.closeOverlay(); reload(); ctx.toast('App password created. Type it into the device now; it will not be shown again.', 'warn', 5000); };
              try { created(await App.post('/api/me/app-passwords', body)); } catch (e) {
                if (!(e.problem && e.problem.step_up)) { const p = e.problem || {}; err.innerHTML = UI.notice(esc(p.detail || e.message), 'danger'); return; }
                // The factor went stale while the form was open: confirm it, then create.
                App.closeOverlay();
                if (await stepUp(ctx, { factor: true, why: 'An app password lets a device in without a second factor, so making one needs a fresh one now.' })) { try { created(await App.post('/api/me/app-passwords', body)); } catch (e2) { App.fail(e2, 'App password not created'); } }
              }
            });
          } });
      };
      const davStepUp = async () => {
        if (await stepUp(ctx, { factor: true, why: 'An app password lets a device in without a second factor, so making one needs a fresh one now.' })) {
          try { st.dav = Object.assign({}, st.dav, { info: await App.get('/api/me/dav') }); } catch (e) { /* the form still works; the server checks again */ }
          ctx.rerender(); setTimeout(davForm, 50);
        }
      };
      ctx.on('click', '[data-davcreate]', () => { if (!davInfo) return; const now = davInfo.stepUp.freshUntil && davInfo.stepUp.freshUntil > Date.now(); if (now) davForm(); else davStepUp(); });
      ctx.on('click', '[data-davdone]', () => { st.davRevealed = null; ctx.rerender(); });
      ctx.on('click', '[data-davrefuseddone]', () => { st.davRefusedNote = false; ctx.rerender(); });
      ctx.on('click', '[data-davcopy]', (e, t) => {
        const k = t.dataset.davcopy; const v = k === 'password' ? (st.davRevealed && st.davRevealed.password) : davInfo && davInfo.server[k];
        if (v && navigator.clipboard) navigator.clipboard.writeText(v).then(() => ctx.toast('Copied.', 'ok'), () => ctx.toast('Copy failed; select the text instead.', 'warn'));
      });
      ctx.on('click', '[data-davrevoke]', async (e, t) => {
        const a = appPws.find((x) => x.id === t.dataset.davrevoke);
        const ok = await ctx.confirm({ title: 'Revoke the app password for ' + a.name + '?', tag: 'stops at once', tone: 'danger', body: '<div class="fg2">The next request from ' + esc(a.name) + ' is refused, and it asks for a new password. Your other devices keep working.</div>', kv: [['Scopes', esc(scopeNames(a.scopes))], ['Last used', esc(when(a.lastUsedAt)) + (a.lastUsedAgent ? ', ' + esc(a.lastUsedAgent) : '')], ['Prefix', '<span class="mono">' + esc(a.prefix) + '</span>']], ok: 'Revoke' });
        if (ok) act(() => App.del('/api/me/app-passwords/' + encodeURIComponent(a.id)), 'App password for ' + esc(a.name) + ' revoked.');
      });
      if (st.openDavForm && (davInfo || st.dav)) { st.openDavForm = false; if (davInfo) setTimeout(davForm, 50); }
      if (st.openDavStepUp && (davInfo || st.dav)) { st.openDavStepUp = false; if (davInfo) setTimeout(() => stepUp(ctx, { factor: true, why: 'An app password lets a device in without a second factor, so making one needs a fresh one now.' }), 50); }
      if (st.openForget) { st.openForget = false; setTimeout(forget, 50); }
      if (st.openAtLink) { st.openAtLink = false; if (App.can('atproto:link') && me.credential !== 'api_key') setTimeout(atLink, 50); }
      if (st.openEmail) { st.openEmail = false; setTimeout(emailModal, 50); }
      if (st.openCreate) { st.openCreate = false; setTimeout(openCreate, 50); }
    }
  });
})();
