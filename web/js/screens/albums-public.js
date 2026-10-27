(function () {
  /*
   * 1.9.0, Sprint 53 (B-178): the signed-out pages of album links, drawn by the `shared` screen (#/shared?t=<token>)
   * when the token is an album share link (exa_) or an upload link (exu_). The token is read once and taken out of the
   * address bar by shared.js; it travels in POST bodies and a request header, never in a URL. Nothing is stored in the
   * browser: no session, no cookie.
   */
  const { UI } = App;
  const esc = UI.esc;
  const fmtBytes = (n) => (n == null ? '' : n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const when = (t) => (t ? new Date(t).toLocaleString() : '');

  function openShare(st, rerender) {
    if (st.loading) return;
    st.loading = true;
    App.post('/api/public/album-links/open', Object.assign({ token: st.token }, st.password ? { password: st.password } : {}))
      .then((v) => { st.view = v; st.error = null; })
      .catch((err) => { st.view = null; st.error = err; })
      .finally(() => { st.loading = false; rerender(); });
  }

  function openUpload(st, rerender) {
    if (st.loading) return;
    st.loading = true;
    App.post('/api/public/album-uploads/open', { token: st.token })
      .then((v) => { st.upload = v; st.error = null; })
      .catch((err) => { st.upload = null; st.error = err; })
      .finally(() => { st.loading = false; rerender(); });
  }

  async function downloadZip(st, ctx) {
    let res;
    try { res = await fetch('/api/public/album-links/download', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: '*/*' }, body: JSON.stringify(Object.assign({ token: st.token }, st.password ? { password: st.password } : {})) }); }
    catch (e) { ctx.toast('The server could not be reached.', 'danger'); return; }
    if (!res.ok) { const p = await res.json().catch(() => ({})); ctx.toast(esc(p.detail || 'The album could not be downloaded.'), 'danger'); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = (st.view.title || 'album') + '.zip'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function shareHtml(st) {
    if (st.loading && !st.view) return UI.notice('Opening the shared album…', 'info');
    const e = st.error;
    if (e && e.status === 401) {
      return UI.pagehead('A shared album', 'This album is protected by a password.', '')
        + (st.password ? UI.notice('That password does not open this album.', 'warn') : '')
        + '<form class="vstack gap12" data-pwform style="max-width:360px">' + UI.field('Password', UI.input('', { type: 'password', attrs: 'data-pw autocomplete="current-password" required' })) + '<div>' + UI.btn('Open', { kind: 'primary', attrs: 'data-pwgo' }) + '</div></form>';
    }
    if (e) {
      const tooMany = e.status === 429;
      return UI.problem(tooMany ? 'Too many tries from here' : 'This link does not work', tooMany ? 'Wait a while, then reload the page.' : 'It may have expired or been revoked, or the album is no longer shared. Ask the person who shared it for a new link.', e.problem && e.problem.trace_id);
    }
    const v = st.view; if (!v) return '';
    const grid = v.items.length ? '<div class="alb-grid" role="list" aria-label="Photos in ' + esc(v.title) + '">' + v.items.map((it, i) => '<figure class="alb-item" role="listitem"><button type="button" class="alb-tile" data-aopen="' + i + '" aria-label="Open ' + esc(it.altText || it.name) + ' in the slideshow">'
      + (it.kind === 'video' ? '<span>Video: ' + esc(it.name) + '</span>' : '<img src="' + esc(it.preview) + '" data-fallback="' + esc(it.full) + '" alt="' + esc(it.altText || '') + '" loading="lazy" decoding="async">') + '</button>'
      + '<figcaption class="alb-cap">' + esc(it.altText || it.name) + (it.download ? ' <a href="' + esc(it.download) + '" download aria-label="Download ' + esc(it.name) + '">Download</a>' : '') + '</figcaption></figure>').join('') + '</div>'
      : UI.empty('Nothing to show', 'The album has no photos that can be shared through a link.');
    const actions = (v.items.length ? UI.btn('Slideshow', { kind: 'primary', attrs: 'data-aopen="0"' }) : '') + (v.mode === 'download' && v.items.length ? UI.btn('Download all', { icon: 'download', attrs: 'data-azip' }) : '');
    return UI.pagehead(v.title, (v.description ? esc(v.description) + ' · ' : '') + v.items.length + ' item' + (v.items.length === 1 ? '' : 's') + ' · link works until ' + esc(when(v.expiresAt)), actions)
      + UI.notice('Shared through a link that works without signing in. ' + (v.mode === 'download' ? 'You can view and download these photos.' : 'You can view these photos.') + ' Each opening is recorded.', 'info') + grid;
  }

  function uploadHtml(st) {
    if (st.loading && !st.upload) return UI.notice('Opening the upload link…', 'info');
    if (st.error) {
      const tooMany = st.error.status === 429;
      return UI.problem(tooMany ? 'Too many tries from here' : 'This upload link does not work', tooMany ? 'Wait a minute, then reload the page.' : 'It may have expired, been revoked or taken all its files. Ask the person who sent it.', st.error.problem && st.error.problem.trace_id);
    }
    const u = st.upload; if (!u) return '';
    const sent = (st.sent || []).map((x) => '<li>' + esc(x.name) + ': ' + esc(x.text) + '</li>').join('');
    return UI.pagehead('Send photos to ' + u.albumTitle, 'Up to ' + u.remaining + ' more file' + (u.remaining === 1 ? '' : 's') + ', each up to ' + esc(fmtBytes(u.maxBytes)) + '. The link works until ' + esc(when(u.expiresAt)) + '.', '')
      + UI.notice('Each photo is checked before it joins the album, and the album\'s owner sees your name with it. PNG, JPEG, WebP and GIF images are accepted.', 'info')
      + '<div class="vstack gap12" style="max-width:480px">'
      + UI.field('Your name', UI.input(st.uploader || '', { attrs: 'data-uname maxlength="80" autocomplete="name" required' }), 'Shown to the album\'s owner as you write it.')
      + '<div class="hstack wrap gap6">' + UI.btn('Choose photos', { icon: 'upload', attrs: 'data-upick' + (u.remaining ? '' : ' disabled') }) + '<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple data-ufiles hidden aria-label="Photos to send"></div>'
      + (sent ? '<div><div class="eyebrow">Sent</div><ul class="vstack gap4" style="margin:0;padding-left:18px" aria-live="polite">' + sent + '</ul></div>' : '')
      + '</div>';
  }

  async function sendFiles(st, ctx, files) {
    const name = (st.uploader || '').trim();
    if (!name) { ctx.toast('Write your name first.', 'warn'); return; }
    st.sent = st.sent || [];
    for (const file of files) {
      let res;
      try { res = await fetch('/api/public/album-uploads?' + new URLSearchParams({ name: file.name, uploader: name }).toString(), { method: 'PUT', body: file, credentials: 'omit', headers: { 'X-Upload-Token': st.token, 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' } }); }
      catch (e) { st.sent.push({ name: file.name, text: 'not sent: the server could not be reached' }); continue; }
      const body = await res.json().catch(() => ({}));
      st.sent.push({ name: file.name, text: res.ok ? (body.state === 'added' ? 'added to the album' : 'received; it joins the album once it has been checked') : 'refused: ' + (body.detail || body.title || res.status) });
    }
    st.upload = null; st.loading = false; openUpload(st, ctx.rerender);
  }

  App.albumPublic = {
    /** Whether a link token belongs to these pages. */
    owns: (token) => /^ex[au]_/.test(token || ''),
    render(root, ctx) {
      const st = ctx.state;
      const upload = /^exu_/.test(st.token);
      if (!upload && !st.view && !st.error) openShare(st, ctx.rerender);
      if (upload && !st.upload && !st.error) openUpload(st, ctx.rerender);
      root.innerHTML = (App.albumStyle || '') + '<div class="page"><div class="vstack gap12" style="max-width:1100px;margin:0 auto">' + (upload ? uploadHtml(st) : shareHtml(st))
        + (App.me ? '' : '<div class="muted" style="font-size:12px">Exprsn-AI. <a href="#/signin">Sign in</a></div>') + '</div></div>';
      if (App.albumWireImages) App.albumWireImages(root);
      ctx.on('click', '[data-pwgo]', (e) => { e.preventDefault(); const i = root.querySelector('[data-pw]'); st.password = i ? i.value : ''; st.error = null; st.view = null; openShare(st, ctx.rerender); ctx.rerender(); });
      ctx.on('submit', '[data-pwform]', (e) => { e.preventDefault(); const i = root.querySelector('[data-pw]'); st.password = i ? i.value : ''; st.error = null; st.view = null; openShare(st, ctx.rerender); });
      ctx.on('click', '[data-aopen]', (e, t) => { if (st.view && App.albumSlideshow) App.albumSlideshow(st.view.title, st.view.items, Number(t.dataset.aopen), { full: (it) => it.full }); });
      ctx.on('click', '[data-azip]', () => downloadZip(st, ctx));
      ctx.on('input', '[data-uname]', (e, t) => { st.uploader = t.value; });
      ctx.on('click', '[data-upick]', () => { const i = root.querySelector('[data-ufiles]'); if (i) i.click(); });
      ctx.on('change', '[data-ufiles]', (e, t) => { const files = Array.prototype.slice.call(t.files || []); if (files.length) sendFiles(st, ctx, files); });
    }
  };
})();
