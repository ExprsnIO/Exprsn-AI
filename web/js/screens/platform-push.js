// Platform › Push providers (1.9.0, Sprint 49: B-151, B-152, B-154). A tab the Platform screen (platform.js) shows
// through App.platformPush.render(ctx, st).
//
// - Providers: the platform's defaults (platform:manage) or this tenant's overrides (tenant:manage): add one (APNs,
//   FCM, Web Push, an HTTP vendor, the console's socket or an outside WebSocket), check its credentials without
//   sending, send a test to one of your own devices, turn it off, delete it. Credentials are stored in the vault
//   (PUT …/push/secrets) and only their vault: references are saved with the provider.
// - Delivery log: sent, failed, dropped, suppressed, retrying and waiting attempts with filters; never a token or the
//   notification's text.
//
// Every check is the server's: hosts through the egress guard, literals refused, references readable by you.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const CSS = '<style>#main .ppush-actions{display:flex;flex-wrap:wrap;gap:6px}#main .ppush-wrap{overflow-wrap:anywhere}#main .ppush-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:8px}#main .ppush-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}</style>';
  const KINDS = [{ value: 'apns', label: 'Apple (APNs)' }, { value: 'fcm', label: 'Google (FCM)' }, { value: 'webpush', label: 'Web Push (browsers)' }, { value: 'http', label: 'HTTP vendor' }, { value: 'websocket', label: 'WebSocket' }];
  const KIND_WORD = { apns: 'APNs', fcm: 'FCM', webpush: 'Web Push', http: 'HTTP vendor', websocket: 'WebSocket' };
  const OUT_TONE = { sent: 'ok', failed: 'danger', dropped: 'warn', suppressed: 'outline', retrying: 'info', waiting: 'info' };
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Something went wrong.';
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || null;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const slug = (s) => String(s || 'provider').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'provider';
  const base = (scope) => (scope === 'platform' ? '/api/admin/platform/push' : '/api/admin/push');

  // ---------- step-up: saving credentials needs a recent sign-in ----------
  const CANCELLED = Symbol('cancelled');
  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">Saving push credentials needs a fresh check of who you are.</div>'
        + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
        + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
        + '<div data-suerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + (pw || totp ? UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }) : ''),
      onMount(m) {
        const err = m.querySelector('[data-suerr]');
        const go = async () => {
          const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
          const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
          if (!pwv && !code) { err.innerHTML = UI.notice('Enter your password or a code.', 'warn'); return; }
          try { await App.post('/api/me/step-up', pwv ? { password: pwv } : { code }); ok = true; App.closeOverlay(); }
          catch (e) { err.innerHTML = UI.notice(esc(detailOf(e)), 'danger'); }
        };
        const b = m.querySelector('[data-sugo]'); if (b) b.addEventListener('click', go);
      },
      onClose() { resolve(ok); } });
  });
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) return CANCELLED;
      return fn();
    }
  };

  // ---------- loading ----------
  function load(ctx, st) {
    const p = st.push;
    if (p.loading) return;
    p.loading = true;
    const f = p.filters || {};
    const q = ['limit=100'].concat(f.provider ? ['provider=' + enc(f.provider)] : [], f.outcome ? ['outcome=' + enc(f.outcome)] : [], f.channel ? ['channel=' + enc(f.channel)] : []).join('&');
    Promise.all([App.get(base(p.scope) + '/providers'), App.get(base(p.scope) + '/deliveries?' + q), App.get('/api/me/devices').catch(() => ({ devices: [] }))])
      .then((r) => { p.providers = r[0].providers; p.log = r[1].deliveries; p.keepDays = r[1].keepDays; p.devices = (r[2].devices || []).filter((d) => d.state === 'active'); p.error = null; p.loaded = true; })
      .catch((err) => { p.error = err; p.loaded = true; })
      .then(() => { p.loading = false; if (App.state.route === 'platform' && !document.getElementById('overlay')) ctx.rerender(); });
  }

  // ---------- the add / edit form ----------
  function credField(label, key, ref, hint) {
    return UI.field(label + ': vault reference', UI.input(ref || '', { attrs: 'data-ref="' + key + '" autocomplete="off"', placeholder: 'vault:push/…#key' }), hint)
      + UI.field(label + ': or paste it to store in the vault', UI.textarea('', { attrs: 'data-paste="' + key + '" autocomplete="off" spellcheck="false"', rows: 3 }), 'Stored once in the vault; only the reference is saved with the provider.');
  }

  function kindFields(kind, c) {
    c = c || {};
    if (kind === 'apns') {
      return '<div class="ppush-grid">' + UI.field('Topic (bundle id)', UI.input(c.topic || '', { attrs: 'data-f="topic"', placeholder: 'org.example.app' }))
        + UI.field('Environment', UI.select([{ value: 'production', label: 'Production' }, { value: 'sandbox', label: 'Sandbox' }], c.environment || 'production', 'data-f="environment"'))
        + UI.field('Key id', UI.input(c.keyId || '', { attrs: 'data-f="keyId" maxlength="10"' }))
        + UI.field('Team id', UI.input(c.teamId || '', { attrs: 'data-f="teamId" maxlength="10"' })) + '</div>'
        + credField('Signing key (.p8)', 'keyRef', c.keyRef, 'Token auth: the ES256 provider token is minted from this key and renewed every 50 minutes.');
    }
    if (kind === 'fcm') {
      return UI.field('Project id', UI.input(c.projectId || '', { attrs: 'data-f="projectId"', placeholder: 'From the service account when empty' }))
        + credField('Service account JSON', 'serviceAccountRef', c.serviceAccountRef, 'An OAuth token is fetched with a signed assertion and cached until it expires.');
    }
    if (kind === 'webpush') {
      return UI.field('VAPID public key', UI.input(c.publicKey || '', { attrs: 'data-f="publicKey" autocomplete="off"' }))
        + UI.field('Private key: vault reference', UI.input(c.privateKeyRef || '', { attrs: 'data-ref="privateKeyRef" autocomplete="off"', placeholder: 'vault:push/vapid#private_key' }))
        + '<div class="ppush-actions">' + UI.btn('Generate a key pair', { size: 'sm', attrs: 'data-vapid' }) + '</div>'
        + UI.field('Contact', UI.input(c.subject || 'mailto:', { attrs: 'data-f="subject"' }), 'A mailto: address or https:// URL push services can reach you at.');
    }
    if (kind === 'websocket') {
      return UI.field('Delivery', UI.select([{ value: 'socketio', label: 'The console\'s socket (signed-in people)' }], 'socketio', 'data-f="mode"'))
        + UI.field('Wait for an acknowledgement (ms)', UI.input(String(c.ackTimeoutMs || 5000), { type: 'number', attrs: 'data-f="ackTimeoutMs" min="500" max="60000"' }), 'Push goes to devices only when no open console acknowledges in this time.');
    }
    const r = (c.response || {});
    const codes = (rule, def) => ((rule && rule.status) || def).join(', ');
    return UI.field('URL', UI.input(c.url || 'https://', { attrs: 'data-f="url"' }), 'The host must be on this tenant\'s allowed hosts (a platform provider: SERVICE_ALLOWED_HOSTS).')
      + UI.field('Body template', UI.textarea(c.body || '{"to": {token}, "title": {title}, "body": {body}, "data": {data}, "ttl": {ttl}}', { attrs: 'data-f="body" spellcheck="false"', rows: 4 }), 'Placeholders: {title} {body} {data} {token} {collapseId} {ttl} {priority} {route} {kind} {link}, each as a JSON value.')
      + credField('Bearer token', 'tokenRef', c.auth && c.auth.tokenRef, 'Sent as Authorization: Bearer. Leave both empty for no auth.')
      + '<div class="ppush-grid">' + UI.field('Token gone on status', UI.input(codes(r.gone, [404, 410]), { attrs: 'data-f="gone"' }))
      + UI.field('Retry on status', UI.input(codes(r.retry, [429, '500-599']), { attrs: 'data-f="retry"' })) + '</div>';
  }

  const codeList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x));

  async function collect(m, kind, scope, name) {
    const val = (k) => { const el = m.querySelector('[data-f="' + k + '"]'); return el ? el.value.trim() : ''; };
    const refs = {};
    for (const el of m.querySelectorAll('[data-ref]')) refs[el.dataset.ref] = el.value.trim();
    for (const el of m.querySelectorAll('[data-paste]')) {
      const v = el.value.trim();
      if (!v) continue;
      const key = el.dataset.paste.replace(/Ref$/, '').replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
      const out = await App.put(base(scope) + '/secrets', { path: 'push/' + kind + '-' + slug(name), data: { [key]: v } });
      refs[el.dataset.paste] = out.refs[key];
    }
    if (kind === 'apns') return { auth: 'token', topic: val('topic'), environment: val('environment'), keyId: val('keyId'), teamId: val('teamId'), keyRef: refs.keyRef };
    if (kind === 'fcm') return Object.assign({ serviceAccountRef: refs.serviceAccountRef }, val('projectId') ? { projectId: val('projectId') } : {});
    if (kind === 'webpush') return { publicKey: val('publicKey'), privateKeyRef: refs.privateKeyRef, subject: val('subject') };
    if (kind === 'websocket') return { mode: 'socketio', ackTimeoutMs: Number(val('ackTimeoutMs') || 5000) };
    return { url: val('url'), method: 'POST', body: val('body'), auth: refs.tokenRef ? { type: 'bearer', tokenRef: refs.tokenRef } : { type: 'none' }, response: { success: { status: ['200-299'] }, retry: { status: codeList(val('retry')) }, gone: { status: codeList(val('gone')) } } };
  }

  function providerModal(ctx, st, existing) {
    const p = st.push;
    let kind = existing ? existing.kind : 'webpush';
    const draw = (m) => {
      m.querySelector('[data-kind-fields]').innerHTML = kindFields(kind, existing && existing.kind === kind ? existing.config : null);
      const g = m.querySelector('[data-vapid]');
      if (g) g.addEventListener('click', async () => {
        const name = m.querySelector('[data-name]').value.trim();
        try {
          const out = await withStepUp(ctx, () => App.post(base(p.scope) + '/vapid-keys', { path: 'push/vapid-' + slug(name) }));
          if (out === CANCELLED) return;
          m.querySelector('[data-f="publicKey"]').value = out.publicKey;
          m.querySelector('[data-ref="privateKeyRef"]').value = out.privateKeyRef;
          m.querySelector('[data-perr]').innerHTML = UI.notice('A key pair was made. The private key is in the vault; it is never shown.', 'ok');
        } catch (err) { m.querySelector('[data-perr]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); }
      });
    };
    ctx.modal({
      title: existing ? 'Edit ' + esc(existing.name) : 'Add a push provider',
      body: (existing ? '' : UI.field('Kind', UI.select(KINDS, kind, 'data-kind'))) + UI.field('Name', UI.input(existing ? existing.name : '', { attrs: 'data-name maxlength="100"' }))
        + '<div data-kind-fields></div><div data-perr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(existing ? 'Save' : 'Add provider', { kind: 'primary', attrs: 'data-psave' }),
      onMount(m) {
        draw(m);
        const k = m.querySelector('[data-kind]');
        if (k) k.addEventListener('change', () => { kind = k.value; draw(m); });
        m.querySelector('[data-psave]').addEventListener('click', async () => {
          const errEl = m.querySelector('[data-perr]');
          const name = m.querySelector('[data-name]').value.trim();
          if (!name) { errEl.innerHTML = UI.notice('Give the provider a name.', 'warn'); return; }
          try {
            const done = await withStepUp(ctx, async () => {
              const config = await collect(m, kind, p.scope, name);
              return existing ? App.patch(base(p.scope) + '/providers/' + enc(existing.id), { name, config }) : App.post(base(p.scope) + '/providers', { kind, name, config });
            });
            if (done === CANCELLED) return;
            App.closeOverlay();
            ctx.toast((existing ? 'Saved. Audit event push.provider.updated written.' : 'Provider added. Audit event push.provider.created written. Check its credentials next.'), 'ok');
            p.loaded = false; ctx.rerender();
          } catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
        });
      }
    });
  }

  function testModal(ctx, st, prov) {
    const p = st.push;
    const mine = (p.devices || []).filter((d) => d.provider === prov.kind);
    const socket = prov.kind === 'websocket';
    ctx.modal({
      title: 'Send a test through ' + esc(prov.name),
      body: (socket ? '<p class="fg2" style="margin:0">Sends a test to your open consoles and waits for one to acknowledge it.</p>'
        : mine.length ? UI.field('Device', UI.select([{ value: '', label: 'All my ' + KIND_WORD[prov.kind] + ' devices' }].concat(mine.map((d) => ({ value: d.id, label: d.name }))), '', 'data-tdev'))
          : UI.notice('You have no ' + esc(KIND_WORD[prov.kind]) + ' device. Register one in Settings, Devices, then send a test.', 'warn'))
        + '<div data-tres role="status"></div>',
      actions: UI.btn('Close', { attrs: 'data-close' }) + (socket || mine.length ? UI.btn('Send test', { kind: 'primary', attrs: 'data-tgo' }) : ''),
      onMount(m) {
        const go = m.querySelector('[data-tgo]');
        if (!go) return;
        go.addEventListener('click', async () => {
          const sel = m.querySelector('[data-tdev]');
          go.disabled = true;
          try {
            const r = await App.post(base(p.scope) + '/providers/' + enc(prov.id) + '/test', sel && sel.value ? { deviceId: sel.value } : {});
            const rows = r.results.map((x) => [esc(x.name || 'Device'), UI.pill(x.outcome, OUT_TONE[x.outcome === 'gone' ? 'dropped' : x.outcome] || ''), esc(x.status == null ? '' : String(x.status)), '<span class="ppush-wrap">' + esc(x.reason || '') + '</span>', esc(String(x.latencyMs)) + ' ms']);
            m.querySelector('[data-tres]').innerHTML = UI.table(['Device', 'Outcome', 'Status', 'Reason', 'Time'], rows, { clickable: false, emptyTitle: 'Nothing was sent', emptyText: 'No device of yours matched this provider.' });
            ctx.toast('Test sent. Audit event push.test.sent written.', 'ok');
            p.loaded = false;
          } catch (err) { App.fail(err, 'The test was not sent'); }
          go.disabled = false;
        });
      },
      onClose() { if (!p.loaded) ctx.rerender(); }
    });
  }

  // ---------- render ----------
  function render(ctx, st) {
    const canPlatform = App.can('platform:manage');
    const canTenant = App.can('tenant:manage');
    st.push = st.push || { scope: canPlatform ? 'platform' : 'tenant', filters: {} };
    const p = st.push;
    if (!p.loaded) { load(ctx, st); return '<p class="muted">Loading the push providers…</p>'; }
    if (p.error) {
      ctx.on('click', '[data-push-retry]', () => { p.loaded = false; p.error = null; ctx.rerender(); });
      return UI.problem('The push providers could not be loaded', detailOf(p.error), traceOf(p.error)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-push-retry' }) + '</div>';
    }
    const scopes = [].concat(canPlatform ? [{ id: 'platform', label: 'Platform defaults' }] : [], canTenant ? [{ id: 'tenant', label: 'This tenant\'s overrides' }] : []);
    const provRows = p.providers.map((x) => [
      '<b>' + esc(x.name) + '</b>' + (x.appId ? '<div class="muted mono ppush-wrap" style="font-size:12px">' + esc(x.appId) + '</div>' : ''),
      esc(KIND_WORD[x.kind] || x.kind),
      x.enabled ? UI.pill('enabled', 'ok') : UI.pill('off', 'outline'),
      x.lastCheck ? UI.pill(x.lastCheck.ok ? 'credentials ok' : 'check failed', x.lastCheck.ok ? 'ok' : 'danger') + '<div class="muted ppush-wrap" style="font-size:12px">' + esc(x.lastCheck.detail || '') + '</div>' : '<span class="muted">not checked</span>',
      '<div class="ppush-actions">' + UI.btn('Check', { size: 'sm', attrs: 'data-pcheck="' + esc(x.id) + '"' }) + UI.btn('Send test', { size: 'sm', attrs: 'data-ptest="' + esc(x.id) + '"' }) + UI.btn('Edit', { size: 'sm', attrs: 'data-pedit="' + esc(x.id) + '"' }) + UI.btn(x.enabled ? 'Turn off' : 'Turn on', { size: 'sm', attrs: 'data-ptoggle="' + esc(x.id) + '"' }) + UI.btn('Delete', { size: 'sm', kind: 'danger', attrs: 'data-pdel="' + esc(x.id) + '"' }) + '</div>'
    ]);
    const providers = UI.panel('Providers', (p.scope === 'platform' ? '<p class="fg2" style="margin-top:0">Defaults for every tenant. A tenant\'s own provider of the same kind is used instead. Credentials go into the vault\'s platform scope under push/.</p>' : '<p class="fg2" style="margin-top:0">This tenant\'s providers win over the platform\'s defaults of the same kind.</p>')
      + UI.table(['Provider', 'Kind', 'State', 'Credentials', ''], provRows, { clickable: false, emptyTitle: 'No push providers', emptyText: 'Without a provider nothing is pushed: notifications stay in the console and email.' })
      + '<div class="ppush-actions" style="margin-top:8px">' + UI.btn('Add a provider', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-padd' }) + '</div>');

    const f = p.filters;
    const filters = '<div class="ppush-filters">'
      + UI.field('Provider', UI.select([{ value: '', label: 'Any provider' }].concat(p.providers.map((x) => ({ value: x.id, label: x.name }))), f.provider || '', 'data-lf="provider"'))
      + UI.field('Outcome', UI.select([{ value: '', label: 'Any outcome' }].concat(['sent', 'failed', 'dropped', 'suppressed', 'retrying', 'waiting'].map((o) => ({ value: o, label: o }))), f.outcome || '', 'data-lf="outcome"'))
      + UI.field('Channel', UI.select([{ value: '', label: 'Any channel' }, { value: 'push', label: 'Push' }, { value: 'websocket', label: 'Socket' }], f.channel || '', 'data-lf="channel"'))
      + '</div>';
    const byId = new Map(p.providers.map((x) => [x.id, x]));
    const logRows = p.log.map((d) => [esc(when(d.createdAt)), esc(d.user ? d.user.name || d.user.username : d.userId), esc(d.channel === 'websocket' ? 'socket' : 'push') + (d.test ? ' ' + UI.pill('test', 'outline') : ''), esc(byId.get(d.providerId) ? byId.get(d.providerId).name : KIND_WORD[d.providerKind] || ''), UI.pill(d.outcome, OUT_TONE[d.outcome] || ''), esc(d.status == null ? '' : String(d.status)), '<span class="ppush-wrap">' + esc(d.reason || '') + '</span>', d.latencyMs == null ? '' : esc(String(d.latencyMs)) + ' ms']);
    const log = UI.panel('Delivery log', filters + UI.table(['When', 'Person', 'Channel', 'Provider', 'Outcome', 'Status', 'Reason', 'Time'], logRows, { clickable: false, minWidth: '760px', emptyTitle: 'No deliveries yet', emptyText: 'Attempts appear here as notifications go out. Tokens and notification text are never kept.' })
      + '<div class="muted" style="font-size:12px;margin-top:6px">Kept ' + esc(String(p.keepDays || 30)) + ' days.</div>', { actions: UI.btn('Refresh', { size: 'sm', attrs: 'data-prefresh' }) });

    // ----- handlers -----
    const reload = () => { p.loaded = false; ctx.rerender(); };
    const find = (id) => p.providers.find((x) => x.id === id);
    ctx.on('click', '[data-pscope]', (e, t) => { p.scope = t.dataset.pscope; p.filters = {}; reload(); });
    ctx.on('click', '[data-padd]', () => providerModal(ctx, st, null));
    ctx.on('click', '[data-pedit]', (e, t) => { const x = find(t.dataset.pedit); if (x) providerModal(ctx, st, x); });
    ctx.on('click', '[data-ptest]', (e, t) => { const x = find(t.dataset.ptest); if (x) testModal(ctx, st, x); });
    ctx.on('click', '[data-prefresh]', reload);
    ctx.on('change', '[data-lf]', (e, t) => { p.filters[t.dataset.lf] = t.value || undefined; reload(); });
    ctx.on('click', '[data-pcheck]', async (e, t) => {
      try {
        const r = await App.post(base(p.scope) + '/providers/' + enc(t.dataset.pcheck) + '/check', {});
        ctx.toast((r.ok ? 'Credentials work: ' : 'Check failed: ') + esc(r.detail) + ' Audit event push.provider.checked written.', r.ok ? 'ok' : 'warn', 8000);
        reload();
      } catch (err) { App.fail(err, 'The check could not run'); }
    });
    ctx.on('click', '[data-ptoggle]', async (e, t) => {
      const x = find(t.dataset.ptoggle); if (!x) return;
      try { if ((await withStepUp(ctx, () => App.patch(base(p.scope) + '/providers/' + enc(x.id), { enabled: !x.enabled }))) === CANCELLED) return; ctx.toast((x.enabled ? 'Turned off. ' : 'Turned on. ') + 'Audit event push.provider.updated written.', 'ok'); reload(); }
      catch (err) { App.fail(err, 'Not changed'); }
    });
    ctx.on('click', '[data-pdel]', async (e, t) => {
      const x = find(t.dataset.pdel); if (!x) return;
      const ok = await ctx.confirm({ title: 'Delete ' + x.name, tone: 'danger', tag: 'destructive', body: '<p class="fg2" style="margin:0">Devices of this kind fall back to the platform\'s provider, or receive nothing. Its credentials stay in the vault.</p>', ok: 'Delete provider' });
      if (!ok) return;
      try { if ((await withStepUp(ctx, () => App.del(base(p.scope) + '/providers/' + enc(x.id)))) === CANCELLED) return; ctx.toast('Deleted. Audit event push.provider.deleted written.', 'ok'); reload(); }
      catch (err) { App.fail(err, 'Not deleted'); }
    });

    return CSS + (scopes.length > 1 ? '<div class="ppush-actions" role="group" aria-label="Which providers">' + scopes.map((sc) => UI.chip(esc(sc.label), sc.id === p.scope, 'data-pscope="' + sc.id + '"')).join('') + '</div>' : '') + providers + log;
  }

  App.platformPush = {
    tabs: [{ id: 'push', label: 'Push providers' }],
    render
  };
}());
