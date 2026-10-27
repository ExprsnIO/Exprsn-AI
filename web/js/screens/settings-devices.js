/*
 * 1.9.0, Sprint 49 (B-150, B-154): Settings › Devices. The person's push devices (phones, browsers, desktop apps)
 * registered by the apps themselves: name, platform, provider, fingerprint, registered, last seen and status; rename
 * and revoke. A panel of the Settings screen (`App.settingsPanels`, on its Security tab, after Sessions); the token
 * is never sent to the console, only its fingerprint.
 */
(function () {
  const { UI, esc } = App;

  const when = (ms) => {
    if (!ms) return 'never';
    const d = Date.now() - ms;
    if (d >= 0 && d < 60000) return 'just now';
    if (d >= 0 && d < 3600000) return Math.round(d / 60000) + ' min ago';
    if (d >= 0 && d < 86400000) return Math.round(d / 3600000) + ' h ago';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const PLATFORM = { ios: 'iOS', android: 'Android', web: 'Web browser', desktop: 'Desktop' };
  const PROVIDER = { apns: 'Apple (APNs)', fcm: 'Google (FCM)', webpush: 'Web Push', http: 'HTTP vendor', websocket: 'WebSocket' };
  // Small stroke icons, decorative: the platform is also written next to them.
  const PATHS = { ios: 'M8 3h8v18H8zM11 18h2', android: 'M6 9h12v9H6zM9 6l-1-2M15 6l1-2M6 9a6 4 0 0 1 12 0', web: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18', desktop: 'M3 5h18v11H3zM9 20h6M12 16v4' };
  const icon = (p) => '<svg class="sd-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="' + (PATHS[p] || PATHS.desktop) + '"/></svg>';

  const load = (ctx) => {
    const st = ctx.state.pdev || (ctx.state.pdev = {});
    if (st.loaded || st.loading) return st;
    st.loading = true;
    App.get('/api/me/devices').then((r) => { st.devices = r.devices; st.error = null; }).catch((err) => { st.error = err; })
      .finally(() => { st.loading = false; st.loaded = true; if (App.state.route === 'settings') ctx.rerender(); });
    return st;
  };

  const html = (ctx) => {
    const st = load(ctx);
    const list = st.devices || [];
    const active = list.filter((d) => d.state === 'active');
    const body = st.error ? UI.problem('Devices could not be loaded', st.error.message, st.error.problem && st.error.problem.trace_id)
      : !st.devices ? UI.notice('Loading…', 'info')
      : UI.table(['Device', 'Platform', 'Registered', 'Last seen', 'Status', { label: '', srLabel: 'Actions', right: true }], list.map((d) => ({ cells: [
        '<span class="hstack gap6">' + icon(d.platform) + '<b>' + esc(d.name) + '</b>' + (d.current ? ' ' + UI.pill('this session', 'accent') : '') + '</span><div class="mono muted sd-fp">' + esc(d.fingerprint) + '</div>',
        esc(PLATFORM[d.platform] || d.platform) + '<div class="muted sd-fp">' + esc(PROVIDER[d.provider] || d.provider) + (d.appId ? ', <span class="mono">' + esc(d.appId) + '</span>' : '') + '</div>',
        esc(when(d.createdAt)),
        esc(when(d.lastSeenAt)),
        d.state === 'active' ? UI.pill('active', 'ok') : UI.pill(d.state === 'gone' ? 'gone' : 'revoked', 'outline') + (d.reason ? '<div class="muted sd-fp">' + esc(d.reason) + '</div>' : ''),
        '<span class="hstack gap6" style="justify-content:flex-end">' + (d.state === 'active' ? UI.btn('Rename', { kind: 'ghost', size: 'sm', attrs: 'data-sdrename="' + esc(d.id) + '" aria-label="Rename ' + esc(d.name) + '"' }) + UI.btn('Revoke', { kind: 'ghost', size: 'sm', attrs: 'data-sdrevoke="' + esc(d.id) + '" aria-label="Revoke ' + esc(d.name) + '"' }) : '') + '</span>'
      ], attrs: 'data-sdrow="' + esc(d.id) + '"' })), { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No devices', emptyText: 'A phone, browser or desktop app that you allow to send you notifications appears here once it registers.' });
    // 1.9.0 (B-154): this browser's notifications, through App.webPush (web/js/webpush.js).
    if (App.webPush && App.webPush.supported() && !st.wp && !st.wpLoading) { st.wpLoading = true; App.webPush.status().then((w) => { st.wp = w; }).catch(() => { st.wp = { supported: false }; }).finally(() => { st.wpLoading = false; if (App.state.route === 'settings' && !document.getElementById('overlay')) ctx.rerender(); }); }
    const wp = st.wp && st.wp.supported ? '<div class="hstack gap6" style="flex-wrap:wrap;margin-bottom:8px" data-sdwp><span class="grow fg2">Browser notifications on this computer: ' + (st.wp.subscribed ? UI.pill('on', 'ok') : st.wp.permission === 'denied' ? UI.pill('blocked in the browser', 'warn') : UI.pill('off', 'outline')) + '</span>' + (st.wp.subscribed ? UI.btn('Turn off browser notifications', { size: 'sm', attrs: 'data-sdwpoff' }) : UI.btn('Turn on browser notifications', { size: 'sm', kind: 'primary', attrs: 'data-sdwpon' + (st.wp.permission === 'denied' ? ' disabled' : '') })) + '</div>' : '';
    return '<style>#main .sd-icon{flex-shrink:0;color:var(--fg2)}#main .sd-fp{font-size:11px;overflow-wrap:anywhere}</style>'
      + UI.panel('Devices', wp + body + '<div class="muted" style="font-size:12px">Push notifications go to these devices. Only a fingerprint of each device token is shown; the token itself is stored sealed and never leaves the server. Signing out of a session, or signing out everywhere else, revokes the devices registered from those sessions. Devices not seen for 90 days are removed.</div>', { attrs: 'data-settings-devices', actions: active.length ? '<span class="muted" style="font-size:12px">' + active.length + ' active</span>' : '' });
  };

  const bind = (ctx) => {
    const st = ctx.state.pdev || {};
    const reload = () => { st.loaded = false; st.devices = null; ctx.rerender(); };
    const find = (id) => (st.devices || []).find((d) => d.id === id);
    ctx.on('click', '[data-sdrename]', (e, t) => {
      const d = find(t.dataset.sdrename); if (!d) return;
      ctx.modal({ title: 'Rename device', body: UI.field('Name', UI.input(d.name, { attrs: 'data-sdname maxlength="100" autocomplete="off"' }), 'Shown here and in the audit log.') + '<div data-sderr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Rename', { kind: 'primary', attrs: 'data-sdgo' }),
        onMount(m) {
          const input = m.querySelector('[data-sdname]'); input.focus(); input.select();
          const go = async () => {
            const name = input.value.trim();
            if (!name) { m.querySelector('[data-sderr]').innerHTML = UI.notice('Give the device a name.', 'warn'); return; }
            try { await App.patch('/api/me/devices/' + encodeURIComponent(d.id), { name }); App.closeOverlay(); ctx.toast('Device renamed. Audited push.device.renamed.', 'ok'); reload(); }
            catch (err) { const p = err.problem || {}; m.querySelector('[data-sderr]').innerHTML = UI.notice(esc(p.detail || err.message), 'danger'); }
          };
          m.querySelector('[data-sdgo]').addEventListener('click', go);
          input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
        } });
    });
    ctx.on('click', '[data-sdwpon]', () => App.webPush.subscribe().then(() => { ctx.toast('Browser notifications are on for this computer. Audited push.device.registered.', 'ok'); st.wp = null; reload(); }).catch((err) => App.fail(err, 'Browser notifications not turned on')));
    ctx.on('click', '[data-sdwpoff]', () => App.webPush.unsubscribe().then(() => { ctx.toast('Browser notifications are off for this computer.', 'ok'); st.wp = null; reload(); }).catch((err) => App.fail(err, 'Not turned off')));
    ctx.on('click', '[data-sdrevoke]', async (e, t) => {
      const d = find(t.dataset.sdrevoke); if (!d) return;
      const ok = await ctx.confirm({ title: 'Revoke ' + d.name + '?', tag: 'stops notifications', tone: 'danger', body: '<div class="fg2">This device gets no more push notifications. The app registers it again the next time you sign in there and allow notifications.</div>', kv: [['Platform', esc(PLATFORM[d.platform] || d.platform)], ['Fingerprint', '<span class="mono">' + esc(d.fingerprint) + '</span>'], ['Last seen', esc(when(d.lastSeenAt))]], ok: 'Revoke' });
      if (!ok) return;
      App.del('/api/me/devices/' + encodeURIComponent(d.id)).then(() => { ctx.toast(esc(d.name) + ' revoked. Audited push.device.revoked.', 'ok'); reload(); }).catch((err) => App.fail(err, 'Not revoked'));
    });
  };

  App.settingsPanels = App.settingsPanels || [];
  App.settingsPanels.push({ id: 'devices', tab: 'security', html, bind });
})();
