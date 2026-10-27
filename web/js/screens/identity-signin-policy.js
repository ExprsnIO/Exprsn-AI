// Identity › Sign-in policy (1.9.0, B-190, B-191, B-195): the tenant's sign-in policy (passwords, lockout, session
// lifetimes and step-up, the second factors allowed) within the platform's bounds, and the tenant's OAuth defaults;
// an OIDC client's own token settings in the client inspector; and "what applies to this person" on the user page.
// `identity.js` calls App.identitySigninPolicy(ctx, deps) for the tab and App.oidcClientSettingsPanel(ctx, client, deps)
// for the inspector; `directories.js` calls App.signinWhatApplies(el, userId) in the user drawer. Each registers its
// own handlers. State lives in ctx.state.sip (the tab) and ctx.state.ocs (client settings by client id).
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const BASE = '/api/admin/signin-policy';
  const MFA = [{ id: 'totp', label: 'Authenticator apps (TOTP)' }, { id: 'passkey', label: 'Passkeys' }, { id: 'email', label: 'Email codes' }];
  const SOURCE = { 'platform floor': 'platform floor', platform: 'platform', tenant: 'this tenant', default: 'default', client: 'this client' };
  const CSS = '#main .sip-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}@media (min-width:1100px){#main .sip-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}#main .sip-num{max-width:12rem}#main .sip-src{font-size:12px}';
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const problemText = (err) => { const p = (err && err.problem) || {}; return '<b>' + esc(p.title || 'Not saved') + '.</b> ' + esc(p.detail || (err && err.message) || '') + (p.errors ? ' ' + esc(p.errors.map((x) => (x.path || '') + ': ' + x.message).join('; ')) : ''); };
  const srcPill = (s) => UI.pill(SOURCE[s] || s || 'default', s === 'tenant' || s === 'client' ? 'info' : 'outline');
  const dur = (sec) => (sec % 86400 === 0 ? sec / 86400 + ' d' : sec % 3600 === 0 ? sec / 3600 + ' h' : sec % 60 === 0 ? sec / 60 + ' min' : sec + ' s');

  /** A number field: empty means the platform's (or the tenant's) value, shown as the placeholder. */
  const num = (label, key, value, inherited, range, hint) => UI.field(label, UI.input(value == null ? '' : String(value), { type: 'number', attrs: 'data-sip="' + esc(key) + '" class="sip-num" inputmode="numeric" min="' + range.min + '" max="' + range.max + '"', placeholder: String(inherited) }), (hint ? hint + ' ' : '') + 'Between ' + range.min + ' and ' + range.max + '. Empty: ' + esc(String(inherited)) + '.');
  const readNum = (el) => { const v = el.value.trim(); return v === '' ? undefined : Number(v); };

  // ---------- the tab ----------

  App.identitySigninPolicy = function (ctx, deps) {
    const st = ctx.state;
    const s = st.sip || (st.sip = {});
    const later = deps.later;
    const load = () => {
      s.loading = true;
      App.get(BASE).then((x) => { s.view = x; s.error = null; }).catch((err) => { s.error = err; }).finally(() => { s.loading = false; later(); });
    };
    if (!s.view && !s.loading && !s.error) load();
    if (s.error) return UI.problem('The sign-in policy could not be loaded', s.error.message, s.error.problem && s.error.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-sipretry' }) + '</div>' + bind(ctx, s, load);
    if (!s.view) return UI.notice('Loading…', 'info');
    const v = s.view;
    const p = v.policy || {};
    const pw = p.password || {};
    const lk = p.lockout || {};
    const se = p.sessions || {};
    const b = v.bounds;
    const e = v.effective;
    const allowed = p.mfaMethods || MFA.map((m) => m.id);
    const notReady = !v.available ? UI.notice('<b>Not installed yet.</b> The sign-in policy tables (migration 129_signin_policy) are not in this database, so every value below is the platform\'s and saving is refused until the migrations run.', 'warn') : '';
    const warn = (v.warnings || []).length ? UI.notice(v.warnings.map(esc).join(' '), 'warn') : '';

    const passwords = UI.panel('Passwords', '<div class="formgrid">'
      + num('Minimum length', 'password.minLength', pw.minLength, 12, b.password.minLength, 'The platform floor of 12 cannot be lowered.')
      + num('Maximum length', 'password.maxLength', pw.maxLength, 256, b.password.maxLength)
      + num('Earlier passwords refused', 'password.history', pw.history, 0, b.password.history, 'Only argon2 hashes of earlier passwords are kept, and compared by verifying.')
      + num('Expire after (days)', 'password.expiryDays', pw.expiryDays, 0, b.password.expiryDays, '0 or empty: never, as NIST SP 800-63B recommends.')
      + '</div>'
      + '<div class="eyebrow">Character rules (off by default)</div><div class="hstack wrap gap12" role="group" aria-label="Character rules">' + UI.check('A lower-case letter', !!pw.requireLower, 'data-sipb="password.requireLower"') + UI.check('An upper-case letter', !!pw.requireUpper, 'data-sipb="password.requireUpper"') + UI.check('A digit', !!pw.requireDigit, 'data-sipb="password.requireDigit"') + UI.check('A symbol', !!pw.requireSymbol, 'data-sipb="password.requireSymbol"') + '</div>'
      + '<div class="muted" style="font-size:12px">NIST SP 800-63B prefers length to composition rules: leave these off unless a regulation asks for them.</div>'
      + UI.check('Refuse a new password too close to the old one', !!pw.notSimilarToPrevious, 'data-sipb="password.notSimilarToPrevious"')
      + '<div data-sipexpiry>' + ((pw.expiryDays || 0) > 0 ? UI.notice('Forced expiry makes people choose weaker, predictable passwords. Prefer the leaked-password check, which asks for a change only when there is a reason.', 'warn') : '') + '</div>');

    const lockout = UI.panel('Lockout', '<div class="formgrid">'
      + num('Failed attempts before lockout', 'lockout.maxAttempts', lk.maxAttempts, b.lockout.maxAttempts.max, b.lockout.maxAttempts, 'Never more than the platform allows.')
      + num('Counting window (minutes)', 'lockout.windowMinutes', lk.windowMinutes, lk.windowMinutes == null ? e.lockout.windowMinutes : 'the platform\'s', b.lockout.windowMinutes)
      + num('Lockout duration (minutes)', 'lockout.durationMinutes', lk.durationMinutes, lk.durationMinutes == null ? e.lockout.durationMinutes : 'the platform\'s', b.lockout.durationMinutes)
      + '</div><div class="muted" style="font-size:12px">A correct password that no longer meets the policy is accepted at sign-in, and the person is asked to change it. Nobody is locked out by a policy change.</div>');

    const sessions = UI.panel('Sessions', '<div class="formgrid">'
      + num('Idle timeout (minutes)', 'sessions.idleMinutes', se.idleMinutes, b.sessions.idleMinutes.max, b.sessions.idleMinutes, 'Only shorter than the platform\'s.')
      + num('Absolute lifetime (hours)', 'sessions.absoluteHours', se.absoluteHours, b.sessions.absoluteHours.max, b.sessions.absoluteHours)
      + num('Step-up window (seconds)', 'sessions.stepUpSeconds', se.stepUpSeconds, b.sessions.stepUpSeconds.max, b.sessions.stepUpSeconds, 'How recent a password or factor check must be for sensitive changes.')
      + '</div>');

    const factors = UI.panel('Second factors allowed', '<div class="hstack wrap gap12" role="group" aria-label="Second factors allowed">' + MFA.map((m) => UI.check(m.label, allowed.indexOf(m.id) >= 0, 'data-sipm="' + m.id + '"')).join('') + '</div>'
      + '<div class="muted" style="font-size:12px">People enrol only these kinds. Someone whose factors are all of another kind keeps signing in with them and is asked to add an allowed one.</div>');

    const rows = Object.keys(e.sources).sort().map((k) => {
      const val = k.split('.').reduce((o, x) => (o == null ? o : o[x]), e);
      return ['<span class="mono">' + esc(k) + '</span>', esc(Array.isArray(val) ? val.join(', ') : String(val)), srcPill(e.sources[k])];
    });
    const effective = UI.panel('In force now', UI.table(['Setting', 'Value', 'Source'], rows, { clickable: false, cls: 'bare', minWidth: '0' })
      + (v.updatedAt ? '<div class="muted" style="font-size:12px">Last changed ' + esc(when(v.updatedAt)) + '.</div>' : '<div class="muted" style="font-size:12px">No tenant policy: every value is the platform\'s or the default, exactly as before.</div>'));

    const o = v.oauth;
    const os = o.stored || {};
    const oe = o.effective;
    const ob = o.bounds;
    const oauth = UI.panel('OAuth and OIDC defaults', (!o.available ? UI.notice('The OAuth settings tables (migration 130_oidc_client_settings) are not installed yet: today\'s values apply and saving is refused.', 'warn') : '')
      + '<div class="formgrid">'
      + num('Authorization code lifetime (seconds)', 'oauth.codeTtl', os.codeTtl, 60, ob.codeTtl)
      + num('Access token lifetime for new clients (seconds)', 'oauth.accessTtl', os.accessTtl, 600, ob.accessTtl)
      + num('Refresh token lifetime for new clients (seconds)', 'oauth.refreshTtl', os.refreshTtl, 28800, ob.refreshTtl)
      + num('Requests a minute per client', 'oauth.ratePerMinute', os.ratePerMinute, 'no limit', ob.ratePerMinute, 'At the token, PAR and device endpoints.')
      + UI.field('PKCE', UI.select([{ value: 'public', label: 'Public clients, and clients that ask for it' }, { value: 'all', label: 'Every client' }], os.pkce || 'public', 'data-sipo="pkce"'))
      + UI.field('Refresh tokens', UI.select([{ value: 'rotate', label: 'Rotate on every use; a reused token revokes its family' }, { value: 'reuse', label: 'Keep until expiry (confidential clients only)' }], os.rotation || 'rotate', 'data-sipo="rotation"'))
      + '</div><div class="muted" style="font-size:12px">In force: codes ' + esc(dur(oe.codeTtl)) + ', PKCE for ' + esc(oe.pkce === 'all' ? 'every client' : 'public clients and those that ask') + ', ' + esc(oe.ratePerMinute ? oe.ratePerMinute + ' requests a minute per client' : 'no per-client limit') + ', refresh tokens ' + esc(oe.rotation === 'rotate' ? 'rotated' : 'kept') + '. Each client can override these in its inspector under OIDC clients.</div>', { actions: UI.btn('Save OAuth defaults', { size: 'sm', kind: 'primary', attrs: 'data-sipoauth' + (o.available ? '' : ' disabled') }) });

    return '<style>' + CSS + '</style>' + notReady + warn
      + '<div class="hstack wrap"><span class="fg2">What this tenant asks of passwords, sign-ins and sessions. Empty fields take the platform\'s value. The platform\'s settings are the most a tenant may allow.</span><span class="right hstack gap6">' + UI.btn('Reset to platform values', { size: 'sm', kind: 'ghost', attrs: 'data-sipreset' + (v.policy ? '' : ' disabled') }) + UI.btn('Save policy', { size: 'sm', kind: 'primary', attrs: 'data-sipsave' + (v.available ? '' : ' disabled') }) + '</span></div>'
      + '<div data-siperr></div>'
      + '<div class="sip-grid"><div class="vstack" style="gap:12px">' + passwords + factors + '</div><div class="vstack" style="gap:12px">' + lockout + sessions + effective + '</div></div>'
      + oauth + bind(ctx, s, load);
  };

  /** Reads the form into a policy: only the values given. */
  function readPolicy(root) {
    const out = { password: {}, lockout: {}, sessions: {} };
    root.querySelectorAll('[data-sip]').forEach((el) => {
      const [group, key] = el.dataset.sip.split('.');
      if (group === 'oauth') return;
      const n = readNum(el);
      if (n !== undefined) out[group][key] = n;
    });
    root.querySelectorAll('[data-sipb]').forEach((el) => { const [group, key] = el.dataset.sipb.split('.'); if (el.checked) out[group][key] = true; });
    const m = Array.prototype.slice.call(root.querySelectorAll('[data-sipm]')).filter((el) => el.checked).map((el) => el.dataset.sipm);
    if (m.length !== MFA.length) out.mfaMethods = m;
    return out;
  }

  function readOauth(root) {
    const out = {};
    root.querySelectorAll('[data-sip^="oauth."]').forEach((el) => { const n = readNum(el); if (n !== undefined) out[el.dataset.sip.slice(6)] = n; });
    root.querySelectorAll('[data-sipo]').forEach((el) => { out[el.dataset.sipo] = el.value; });
    if (out.pkce === 'public') delete out.pkce;
    if (out.rotation === 'rotate') delete out.rotation;
    return out;
  }

  function bind(ctx, s, load) {
    const errBox = () => document.querySelector('[data-siperr]');
    ctx.on('click', '[data-sipretry]', () => { s.error = null; load(); });
    ctx.on('input', '[data-sip="password.expiryDays"]', (e, t) => { const box = document.querySelector('[data-sipexpiry]'); if (box) box.innerHTML = Number(t.value) > 0 ? UI.notice('Forced expiry makes people choose weaker, predictable passwords. Prefer the leaked-password check, which asks for a change only when there is a reason.', 'warn') : ''; });
    ctx.on('click', '[data-sipsave]', async () => {
      const root = document.querySelector('#main') || document;
      const body = readPolicy(root);
      if (body.mfaMethods && !body.mfaMethods.length) { if (errBox()) errBox().innerHTML = UI.notice('Allow at least one kind of second factor.', 'warn'); return; }
      const expiry = (body.password.expiryDays || 0) > 0;
      const ok = await ctx.confirm({ title: 'Save the sign-in policy?', tone: expiry ? 'danger' : undefined, body: '<div class="fg2">New passwords must meet it at once. A password that no longer does is accepted at the next sign-in and its owner is asked to change it.' + (expiry ? ' Passwords older than ' + esc(String(body.password.expiryDays)) + ' days must be changed at the next sign-in.' : '') + '</div>', ok: 'Save policy' });
      if (!ok) return;
      try {
        const r = await App.put(BASE, body);
        s.view = r;
        ctx.toast('Sign-in policy saved. Audit entry written.' + ((r.warnings || []).length ? ' Read the warning at the top.' : ''), (r.warnings || []).length ? 'warn' : 'ok', 6000);
        ctx.rerender();
      } catch (err) { if (errBox()) errBox().innerHTML = UI.notice(problemText(err), 'danger'); else App.fail(err); }
    });
    ctx.on('click', '[data-sipreset]', async () => {
      const ok = await ctx.confirm({ title: 'Reset to the platform values?', tone: 'danger', body: '<div class="fg2">The tenant\'s policy is removed, with any password history it kept. Every value becomes the platform\'s again.</div>', ok: 'Reset' });
      if (!ok) return;
      try { s.view = await App.del(BASE); ctx.toast('Sign-in policy removed. The platform values apply.', 'ok'); ctx.rerender(); } catch (err) { App.fail(err); }
    });
    ctx.on('click', '[data-sipoauth]', async () => {
      const root = document.querySelector('#main') || document;
      const body = readOauth(root);
      const ok = await ctx.confirm({ title: 'Save the OAuth defaults?', body: '<div class="fg2">Codes, PKCE, the rate limit and rotation apply to every client that does not set its own. Lifetimes apply to clients created from now on.</div>', ok: 'Save' });
      if (!ok) return;
      try { s.view = await App.put(BASE + '/oauth', body); ctx.toast('OAuth defaults saved. Audit entry written.', 'ok'); ctx.rerender(); } catch (err) { if (errBox()) errBox().innerHTML = UI.notice(problemText(err), 'danger'); else App.fail(err); }
    });
    return '';
  }

  // ---------- a client's token settings (the OIDC clients inspector) ----------

  App.oidcClientSettingsPanel = function (ctx, client, deps) {
    const st = ctx.state;
    const all = st.ocs || (st.ocs = {});
    const x = all[client.id];
    const load = () => {
      all[client.id] = { loading: true };
      App.get('/api/admin/federation/oidc/clients/' + enc(client.id) + '/settings').then((v) => { all[client.id] = { view: v }; }).catch((err) => { all[client.id] = { error: err }; }).finally(deps.later);
    };
    if (!x) load();
    ctx.on('click', '[data-ocsedit]', () => edit(ctx, client, all, deps));
    if (!x || x.loading) return '<div class="field"><span class="fl">Token settings</span><div class="muted">Loading…</div></div>';
    if (x.error) return '<div class="field"><span class="fl">Token settings</span><div class="muted">' + esc(x.error.message) + '</div></div>';
    const v = x.view;
    const ef = v.effective;
    const line = (k, label, value) => [label, esc(value) + ' ' + srcPill(ef.sources[k])];
    return '<div class="field"><span class="fl">Token settings</span>' + UI.kv([
      line('codeTtl', 'Authorization code', dur(ef.codeTtl)),
      line('accessTtl', 'Access token', dur(ef.accessTtl)),
      ...(v.refreshGrant ? [line('refreshTtl', 'Refresh token', dur(ef.refreshTtl)), line('rotation', 'Refresh rotation', ef.rotation === 'rotate' ? 'rotated, reuse revokes the family' : 'kept until expiry')] : []),
      line('pkceRequired', 'PKCE', ef.pkceRequired ? 'required' : 'optional'),
      line('consent', 'Consent screen', ef.consent === 'tenant' ? 'as the tenant decides' : ef.consent),
      line('ratePerMinute', 'Rate limit', ef.ratePerMinute ? ef.ratePerMinute + ' a minute' : 'none')
    ], 1)
      + (v.reusedFamilies && v.reusedFamilies.length ? '<div class="muted" style="font-size:12px">' + v.reusedFamilies.length + ' grant' + (v.reusedFamilies.length === 1 ? '' : 's') + ' revoked for a reused refresh token, last ' + esc(when(v.reusedFamilies[0].revokedAt)) + '.</div>' : '')
      + '<div style="margin-top:6px">' + UI.btn('Edit token settings', { size: 'sm', kind: 'ghost', attrs: 'data-ocsedit aria-label="Edit token settings of ' + esc(client.name) + '"' }) + '</div></div>';
  };

  function edit(ctx, client, all, deps) {
    const x = all[client.id];
    if (!x || !x.view) return;
    const v = x.view;
    const own = v.stored || {};
    const b = v.bounds;
    ctx.modal({ title: 'Token settings, ' + esc(client.name),
      body: '<div class="formgrid">'
        + num('Authorization code lifetime (seconds)', 'codeTtl', own.codeTtl, 'tenant: ' + v.effective.codeTtl, b.codeTtl)
        + num('Access token lifetime (seconds)', 'accessTtl', v.effective.accessTtl, v.effective.accessTtl, b.accessTtl)
        + (v.refreshGrant ? num('Refresh token lifetime (seconds)', 'refreshTtl', v.effective.refreshTtl, v.effective.refreshTtl, b.refreshTtl) : '')
        + num('Requests a minute', 'ratePerMinute', own.ratePerMinute, 'tenant: ' + (v.effective.sources.ratePerMinute === 'client' ? 'none' : v.effective.ratePerMinute || 'none'), b.ratePerMinute)
        + UI.field('Consent screen', UI.select([{ value: 'inherit', label: 'As the tenant decides' }, { value: 'on', label: 'Always ask' }, { value: 'off', label: 'Never ask' }], own.consent || 'inherit', 'data-ocs="consent"' + (v.dynamic ? ' disabled' : '')), v.dynamic ? 'A client that registered itself always asks each person.' : 'Off is for applications you run yourself.')
        + (v.refreshGrant ? UI.field('Refresh tokens', UI.select([{ value: 'inherit', label: 'As the tenant decides' }, { value: 'rotate', label: 'Rotate on every use' }, { value: 'reuse', label: 'Keep until expiry' }], own.rotation || 'inherit', 'data-ocs="rotation"' + (v.confidential ? '' : ' disabled')), v.confidential ? 'Keeping a token turns off reuse detection for this client.' : 'A public client\'s tokens are always rotated.') : '')
        + '</div><div data-ocserr></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-ocssave' }),
      onMount(m) {
        m.querySelector('[data-ocssave]').addEventListener('click', async () => {
          const body = {};
          m.querySelectorAll('[data-sip]').forEach((el) => { const n = readNum(el); const k = el.dataset.sip; if (n !== undefined) body[k] = n; else if (k === 'codeTtl' || k === 'ratePerMinute') body[k] = null; });
          m.querySelectorAll('[data-ocs]').forEach((el) => { if (!el.disabled) body[el.dataset.ocs] = el.value; });
          try {
            const r = await App.put('/api/admin/federation/oidc/clients/' + enc(client.id) + '/settings', body);
            all[client.id] = { view: r };
            App.closeOverlay();
            ctx.toast('Token settings of ' + esc(client.name) + ' saved. Audit entry written.', 'ok');
            deps.later();
          } catch (err) { m.querySelector('[data-ocserr]').innerHTML = UI.notice(problemText(err), 'danger'); }
        });
      } });
  }

  // ---------- "what applies to this person" (the user drawer) ----------

  App.signinWhatApplies = function (el, userId) {
    if (!el) return;
    el.innerHTML = '<div class="eyebrow">What applies to this person</div><div class="muted">Loading…</div>';
    App.get('/api/admin/users/' + enc(userId) + '/signin-policy').then((v) => {
      const r = v.password.rules;
      const rules = 'at least ' + r.minLength + ', at most ' + r.maxLength + ' characters' + ['requireLower', 'requireUpper', 'requireDigit', 'requireSymbol'].filter((k) => r[k]).map((k) => ', ' + { requireLower: 'a lower-case letter', requireUpper: 'an upper-case letter', requireDigit: 'a digit', requireSymbol: 'a symbol' }[k]).join('') + (r.history ? ', not one of the last ' + r.history : '') + (r.notSimilarToPrevious ? ', not close to the old one' : '');
      const pwText = !v.password.managedHere ? 'kept by ' + (v.password.stores.join(', ') || 'the directory') + '; its rules apply there' : rules + (v.password.expiresAt ? '. Expires ' + day(v.password.expiresAt) : '') + (v.password.mustChange ? '. Must change at next sign-in' : '');
      const src = (k) => ' ' + srcPill(v.sources[k]);
      el.innerHTML = '<div class="eyebrow">What applies to this person</div>' + UI.kv([
        ['Password', esc(pwText) + (v.password.managedHere ? src('password.minLength') : '')],
        ['Lockout', esc(v.lockout.maxAttempts + ' attempts in ' + v.lockout.windowMinutes + ' min, then ' + v.lockout.durationMinutes + ' min') + src('lockout.maxAttempts')],
        ['Sessions', esc('idle ' + v.sessions.idleMinutes + ' min, at most ' + v.sessions.absoluteHours + ' h, step-up ' + v.sessions.stepUpSeconds + ' s') + src('sessions.idleMinutes')],
        ['Second factor', esc((v.mfa.required ? 'required (' + v.mfa.why + ')' : v.mfa.enrolBy ? 'required from ' + day(v.mfa.enrolBy) : 'optional') + '; allowed: ' + v.mfa.allowed.join(', ')) + src('mfaMethods') + (v.mfa.notAllowed.length ? ' ' + UI.pill('has ' + v.mfa.notAllowed.join(', ') + ', no longer allowed', 'warn') : '')]
      ], 1) + (v.configured ? '' : '<div class="muted" style="font-size:12px">This tenant has no sign-in policy: the platform\'s values apply.</div>');
    }).catch((err) => { el.innerHTML = '<div class="eyebrow">What applies to this person</div><div class="muted">' + esc(err.message) + '</div>'; });
  };
})();
