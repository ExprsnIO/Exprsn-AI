/*
 * 1.9.0, Sprint 55 (B-189): Settings › Certificates. The person's member certificates (a tenant option, off by
 * default): serial, validity and state, and the key picked up once as a PKCS#12 file under a password they choose
 * (with the CA token, when one came with it). A panel of the Settings screen (`App.settingsPanels`); it shows only
 * when the tenant has member certificates on or the person has one.
 */
(function () {
  const { UI, esc } = App;
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const b64Blob = (b64, type) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };

  const load = (ctx) => {
    const st = ctx.state.pcert || (ctx.state.pcert = {});
    if (st.loaded || st.loading) return st;
    st.loading = true;
    App.get('/api/me/certificates').then((r) => { st.data = r; st.error = null; }).catch((err) => { st.error = err; })
      .finally(() => { st.loading = false; st.loaded = true; if (App.state.route === 'settings' && !document.getElementById('overlay')) ctx.rerender(); });
    return st;
  };

  const html = (ctx) => {
    const st = load(ctx);
    if (st.error || !st.data || !st.data.configured) return '';
    const D = st.data;
    if (!D.enabled && !D.certificates.length) return '';
    const rows = D.certificates.map((c) => [
      '<span class="mono">' + esc(c.certificate ? c.certificate.serial.slice(0, 16) : c.certificateId.slice(-6)) + '</span>',
      esc(c.certificate ? day(c.certificate.notBefore) + ' to ' + day(c.certificate.notAfter) : ''),
      UI.pill(c.state, c.state === 'active' ? 'ok' : c.state === 'revoked' ? 'danger' : 'outline'),
      c.state === 'active' && c.keyWaiting ? UI.btn('Pick up', { kind: 'primary', size: 'sm', attrs: 'data-scpick="' + esc(c.id) + '"' }) : c.pickedUpAt ? '<span class="muted">picked up ' + esc(day(c.pickedUpAt)) + '</span>' : ''
    ]);
    return UI.panel('Certificates', UI.table(['Serial', 'Valid', 'State', { label: '', srLabel: 'Actions', right: true }], rows, { minWidth: '0', cls: 'bare', clickable: false, emptyTitle: 'No certificate yet', emptyText: 'Your client certificate appears here shortly after it is issued.' })
      + '<div class="muted" style="font-size:12px">A client certificate for this tenant' + (D.signIn ? ', which can sign you in' : '') + (D.mtls ? ' and authenticate API calls' : '') + '. Its key is kept sealed for you until you pick it up once, as a PKCS#12 file under a password you choose; then only the certificate stays here. It is renewed with the same key before it expires.</div>', { attrs: 'data-settings-certificates' });
  };

  const bind = (ctx) => {
    const st = ctx.state.pcert || {};
    ctx.on('click', '[data-scpick]', (e, t) => {
      const id = t.dataset.scpick;
      ctx.modal({ title: 'Pick up your certificate',
        body: '<p class="fg2" style="margin:0">The key is handed over once. Choose a password for the PKCS#12 file; you need it to install the certificate.</p>' + UI.field('File password', UI.input('', { type: 'password', attrs: 'data-scpw minlength="8" autocomplete="new-password"' }), 'At least 8 characters.') + '<div data-scout></div><div data-scerr role="alert"></div>',
        actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Pick up', { kind: 'primary', attrs: 'data-scgo' }),
        onMount(m) {
          m.querySelector('[data-scpw]').focus();
          m.querySelector('[data-scgo]').addEventListener('click', () => {
            App.post('/api/me/certificates/' + encodeURIComponent(id) + '/pickup', { password: m.querySelector('[data-scpw]').value }).then((r) => {
              const a = document.createElement('a'); a.href = URL.createObjectURL(b64Blob(r.pkcs12, 'application/x-pkcs12')); a.download = 'member-' + r.serial.slice(0, 12) + '.p12'; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove();
              m.querySelector('[data-scerr]').innerHTML = '';
              m.querySelector('[data-scout]').innerHTML = UI.notice('<b>Downloaded.</b> The key is no longer kept here.' + (r.token ? ' Your CA token, shown once:<div class="mono" style="font-size:11px;overflow-wrap:anywhere;word-break:break-all;margin-top:4px">' + esc(r.token) + '</div>' : ''), 'ok');
              m.querySelector('[data-scgo]').disabled = true;
              st.loaded = false;
            }).catch((err) => { const p = err.problem || {}; m.querySelector('[data-scerr]').innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(p.step_up ? 'Sign in again (or confirm your password under Security) and try once more.' : err.message), 'danger'); });
          });
        },
        onClose() { if (!st.loaded) ctx.rerender(); } });
    });
  };

  App.settingsPanels = App.settingsPanels || [];
  App.settingsPanels.push({ id: 'certificates', tab: 'security', html, bind });
})();
