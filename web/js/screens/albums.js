(function () {
  /*
   * 1.9.0, Sprint 53 (B-177 to B-179): albums on Files. #/albums lists the albums the signed-in person may open;
   * #/albums?album=<id> is one album: its grid, a keyboard slideshow (alt text shown, reduced motion respected), the
   * people in it, share and upload links, and what came in through them. Not in the sidebar: opened from Files, a
   * group's Albums tab, a feed card or a notification. The feed card and the group tab are filled here too
   * (App.albumCards), from placeholders messages.js and groups.js put in their markup.
   */
  const { UI } = App;
  const esc = UI.esc;
  const enc = encodeURIComponent;
  const ID = 'albums';
  const when = (t) => (t ? new Date(t).toLocaleString() : '');
  const fmtBytes = (n) => (n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
  const KIND_WORDS = { workspace: 'Workspace album', group: 'Group album', personal: 'Personal album' };
  const ROLE_WORDS = { owner: 'Owner', editor: 'Editor', contributor: 'Contributor', viewer: 'Viewer' };

  const STYLE = '<style>'
    + '#main .albums-grid,.alb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}'
    + '#main .albums-card{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--fg);text-decoration:none;min-width:0}'
    + '#main .albums-card:focus-visible,#main .albums-tile:focus-visible,.alb-tile:focus-visible{outline:3px solid var(--accent);outline-offset:2px}'
    + '#main .albums-cover,.alb-cover{aspect-ratio:4/3;border-radius:6px;background:var(--sel);display:flex;align-items:center;justify-content:center;color:var(--muted);overflow:hidden;font-size:12px}'
    + '#main .albums-cover img,.alb-cover img{width:100%;height:100%;object-fit:cover;display:block}'
    + '#main .albums-title{font-weight:600;overflow-wrap:anywhere}'
    + '#main .albums-item,.alb-item{display:flex;flex-direction:column;gap:4px;min-width:0;margin:0}'
    + '#main .albums-tile,.alb-tile{display:block;width:100%;padding:0;border:1px solid var(--line);border-radius:8px;background:var(--sel);cursor:pointer;overflow:hidden;aspect-ratio:1/1;color:var(--muted)}'
    + '#main .albums-tile img,.alb-tile img{width:100%;height:100%;object-fit:cover;display:block}'
    + '#main .albums-cap,.alb-cap{font-size:12px;color:var(--fg2);overflow-wrap:anywhere}'
    + '#main .albums-tools{display:flex;flex-wrap:wrap;gap:2px}'
    + '#main .albums-cardslot{margin-top:6px}'
    + '.albums-show{width:min(960px,96vw)}'
    + '.albums-stage{display:flex;align-items:center;justify-content:center;background:var(--sel);border-radius:8px;min-height:200px;max-height:65vh;overflow:hidden}'
    + '.albums-stage img,.albums-stage video{max-width:100%;max-height:65vh;display:block;object-fit:contain}'
    + '.albums-alt{font-size:14px;color:var(--fg);overflow-wrap:anywhere}'
    + '.albums-desc{font-size:13px;color:var(--fg2);overflow-wrap:anywhere}'
    + '@media (prefers-reduced-motion: no-preference){:root:not([data-a11y="aaa"]) .albums-stage img{transition:opacity .2s ease}}'
    + '</style>';

  // ---------- media addresses ----------

  const itemUrl = (albumId, itemId, what) => '/api/albums/' + enc(albumId) + '/items/' + enc(itemId) + '/' + what;
  /** An <img> that tries the preview first and falls back to the cleaned image (wired by wireFallbacks). */
  function imgTag(src, fallback, alt) {
    return '<img src="' + esc(src) + '"' + (fallback ? ' data-fallback="' + esc(fallback) + '"' : '') + ' alt="' + esc(alt || '') + '" loading="lazy" decoding="async">';
  }
  function wireFallbacks(root) {
    Array.prototype.forEach.call(root.querySelectorAll('img[data-fallback]'), (img) => {
      if (img.dataset.wired) return; img.dataset.wired = '1';
      img.addEventListener('error', () => { const f = img.dataset.fallback; if (f && img.getAttribute('src') !== f) { img.removeAttribute('data-fallback'); img.src = f; } });
    });
  }

  // ---------- the slideshow (shared with the public album page) ----------

  /**
   * A dialog showing one item at a time: arrow keys, Home and End move; Escape closes (the dialog's own keys); the alt
   * text is shown under the picture and announced. Autoplay is offered only when the person has not asked for less
   * motion, and nothing slides or fades when they have.
   */
  function slideshow(title, items, start, urls) {
    if (!items.length) return;
    let at = Math.max(0, Math.min(items.length - 1, start || 0));
    let timer = null;
    const reduced = App.prefersReducedMotion();
    const stage = (it) => it.kind === 'video'
      ? '<video controls preload="metadata" src="' + esc(urls.full(it)) + '" aria-label="' + esc(it.altText || it.name) + '"></video>'
      : '<img src="' + esc(urls.full(it)) + '" alt="' + esc(it.altText || '') + '">';
    const body = '<div class="albums-stage" data-stage>' + stage(items[at]) + '</div>'
      + '<div class="vstack gap4"><div class="albums-alt" data-alt></div><div class="albums-desc" data-desc></div><div class="muted" style="font-size:12px" data-pos aria-live="polite"></div></div>';
    const actions = UI.btn('Previous', { attrs: 'data-prev aria-keyshortcuts="ArrowLeft"' }) + UI.btn('Next', { attrs: 'data-next aria-keyshortcuts="ArrowRight"' })
      + (reduced ? '' : UI.btn('Play', { attrs: 'data-play aria-pressed="false"' })) + UI.btn('Close', { kind: 'primary', attrs: 'data-close' });
    App.modal({
      title: esc(title), cls: 'albums-show', body, actions,
      onMount(m) {
        const show = () => {
          const it = items[at];
          m.querySelector('[data-stage]').innerHTML = stage(it);
          m.querySelector('[data-alt]').textContent = it.altText ? it.altText : it.name + ' (no alt text was written for this item)';
          m.querySelector('[data-desc]').textContent = it.description || '';
          m.querySelector('[data-pos]').textContent = (it.kind === 'video' ? 'Video ' : 'Photo ') + (at + 1) + ' of ' + items.length + ': ' + (it.altText || it.name);
          m.querySelector('[data-prev]').disabled = items.length < 2;
          m.querySelector('[data-next]').disabled = items.length < 2;
        };
        const go = (d) => { at = (at + d + items.length) % items.length; show(); };
        const stop = () => { if (timer) { clearInterval(timer); timer = null; } const p = m.querySelector('[data-play]'); if (p) { p.textContent = 'Play'; p.setAttribute('aria-pressed', 'false'); } };
        m.querySelector('[data-prev]').addEventListener('click', () => { stop(); go(-1); });
        m.querySelector('[data-next]').addEventListener('click', () => { stop(); go(1); });
        const play = m.querySelector('[data-play]');
        if (play) play.addEventListener('click', () => { if (timer) { stop(); return; } timer = setInterval(() => go(1), 5000); play.textContent = 'Pause'; play.setAttribute('aria-pressed', 'true'); });
        m.addEventListener('keydown', (e) => {
          if (e.target && /^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(e.target.tagName)) return;
          if (e.key === 'ArrowRight') { e.preventDefault(); stop(); go(1); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); go(-1); }
          else if (e.key === 'Home') { e.preventDefault(); stop(); at = 0; show(); }
          else if (e.key === 'End') { e.preventDefault(); stop(); at = items.length - 1; show(); }
        });
        show();
        m.querySelector('[data-next]').focus();
      },
      onClose() { if (timer) clearInterval(timer); }
    });
  }

  // ---------- data ----------

  async function loadList(st) {
    try { st.list = await App.get('/api/albums' + (st.kind && st.kind !== 'all' ? '?kind=' + enc(st.kind) : '')); st.error = null; } catch (err) { st.error = err; st.list = null; }
  }
  async function loadAlbum(st, id) {
    try {
      st.album = await App.get('/api/albums/' + enc(id)); st.error = null;
      st.links = null; st.uploadLinks = null; st.uploads = null;
      if (st.album.can.links) {
        const [a, b, c] = await Promise.all([App.get('/api/albums/' + enc(id) + '/share-links').catch(() => null), App.get('/api/albums/' + enc(id) + '/upload-links').catch(() => null), App.get('/api/albums/' + enc(id) + '/uploads').catch(() => null)]);
        st.links = a; st.uploadLinks = b; st.uploads = c;
      }
    } catch (err) { st.error = err; st.album = null; }
  }

  // ---------- views ----------

  function albumCard(a) {
    const cover = a.cover ? imgTag(itemUrl(a.id, a.cover.itemId, 'preview'), itemUrl(a.id, a.cover.itemId, 'content'), '') : '<span>No photos yet</span>';
    return '<a class="albums-card" href="#/albums?album=' + esc(a.id) + '" aria-label="' + esc(a.title + ', ' + a.itemCount + ' item' + (a.itemCount === 1 ? '' : 's') + ', ' + KIND_WORDS[a.kind]) + '">'
      + '<div class="albums-cover" aria-hidden="true">' + cover + '</div>'
      + '<span class="albums-title">' + esc(a.title) + '</span>'
      + '<span class="hstack wrap gap6"><span class="muted" style="font-size:12px">' + a.itemCount + ' item' + (a.itemCount === 1 ? '' : 's') + '</span>' + UI.label(a.label, { sm: true }) + '</span></a>';
  }

  function listView(st) {
    const canWrite = App.can('files:write');
    const head = UI.pagehead('Albums', 'Photos and videos kept in Files and gathered into albums for a workspace, a group or the people you name. Each person sees what their clearance and the files\' own access allow.', canWrite ? UI.btn('New album', { kind: 'primary', icon: 'plus', attrs: 'data-newalbum' }) : '');
    if (st.error) return head + UI.problem('Albums could not be loaded', st.error.message, st.error.problem && st.error.problem.trace_id);
    if (!st.list) return head + UI.notice('Loading…', 'info');
    if (!st.list.available) return head + UI.empty('Albums are not available yet', 'This server needs migration 135_albums. Ask an operator to run the migrations.');
    const filters = UI.seg([{ id: 'all', label: 'All' }, { id: 'workspace', label: 'Workspace' }, { id: 'group', label: 'Group' }, { id: 'personal', label: 'Personal' }], st.kind || 'all', 'aria-label="Kind of album"');
    const list = st.list.albums;
    return head + '<div class="hstack wrap">' + filters + '</div>'
      + (list.length ? '<div class="albums-grid">' + list.map(albumCard).join('') + '</div>' : UI.empty('No albums', canWrite ? 'Make one for your workspace, or for the people you choose. Group albums are made on the group\'s Albums tab.' : 'Albums shared with you show here.'));
  }

  function itemsTab(st, a) {
    const items = a.items;
    const tools = (it, i) => {
      const parts = [];
      if (a.can.edit) {
        parts.push(UI.btn('Earlier', { size: 'xs', kind: 'ghost', attrs: 'data-move="' + esc(it.id) + '" data-dir="-1" aria-label="Move ' + esc(it.name) + ' earlier"', disabled: i === 0 }));
        parts.push(UI.btn('Later', { size: 'xs', kind: 'ghost', attrs: 'data-move="' + esc(it.id) + '" data-dir="1" aria-label="Move ' + esc(it.name) + ' later"', disabled: i === items.length - 1 }));
        parts.push(UI.btn(a.cover && a.cover.itemId === it.id && a.cover.chosen ? 'Cover' : 'Make cover', { size: 'xs', kind: 'ghost', attrs: 'data-cover="' + esc(it.id) + '" aria-label="Make ' + esc(it.name) + ' the cover"' + (a.cover && a.cover.itemId === it.id && a.cover.chosen ? ' disabled' : '') }));
      }
      if (a.can.edit || (a.can.add && it.mine)) parts.push(UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-remove="' + esc(it.id) + '" aria-label="Remove ' + esc(it.name) + ' from the album"' }));
      return parts.length ? '<div class="albums-tools">' + parts.join('') + '</div>' : '';
    };
    const grid = items.length ? '<div class="albums-grid" role="list" aria-label="Items in ' + esc(a.title) + '">' + items.map((it, i) => '<figure class="albums-item" role="listitem">'
      + '<button type="button" class="albums-tile" data-open="' + i + '" aria-label="Open ' + esc(it.altText || it.name) + ' in the slideshow">' + (it.kind === 'video' ? '<span>Video: ' + esc(it.name) + '</span>' : imgTag(itemUrl(a.id, it.id, 'preview'), itemUrl(a.id, it.id, 'content'), it.altText || '')) + '</button>'
      + '<figcaption class="albums-cap">' + esc(it.name) + (it.altText ? '' : ' <span class="muted">(no alt text)</span>') + (it.addedByName ? '<br><span class="muted">Added by ' + esc(it.addedByName) + '</span>' : '') + '</figcaption>' + tools(it, i) + '</figure>').join('') + '</div>'
      : UI.empty('No photos or videos yet', a.can.add ? 'Upload pictures or add images you keep in Files.' : 'Nothing here that you may see yet.');
    const add = a.can.add ? '<div class="hstack wrap gap6">' + UI.btn('Upload photos', { icon: 'upload', attrs: 'data-pickupload' }) + '<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple data-upload hidden aria-label="Photos to upload">' + UI.btn('Add from Files', { icon: 'files', attrs: 'data-addfiles' }) + '</div>' : '';
    return add + grid + UI.notice('Each item stays a file: scanned, labelled and versioned in Files, served without its metadata, with its alt text. You see an item only when you are cleared for it and you may read the file, or the person who added it could share it with you.', 'info');
  }

  function peopleTab(st, a) {
    const rows = (a.contributors || []).map((c) => [esc(c.name || c.userId), a.can.manage && (c.role !== 'editor' || a.can.editors) ? UI.select([{ value: 'viewer', label: 'Viewer' }, { value: 'contributor', label: 'Contributor' }].concat(a.can.editors ? [{ value: 'editor', label: 'Editor' }] : []), c.role, 'data-role="' + esc(c.userId) + '" aria-label="Role of ' + esc(c.name || c.userId) + '"') : esc(ROLE_WORDS[c.role]), esc(when(c.addedAt)), a.can.manage && (c.role !== 'editor' || a.can.editors) ? UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-unperson="' + esc(c.userId) + '" aria-label="Remove ' + esc(c.name || c.userId) + '"' }) : '']);
    return UI.notice(a.kind === 'personal' ? 'A personal album is seen by you and the people named here.' : a.kind === 'group' ? 'Everyone in the group sees this album; a role here lets a member add (contributor) or arrange and edit (editor). The group\'s moderators act as editors.' : 'Everyone in the workspace sees this album; a role here lets a member add (contributor) or arrange and edit (editor).', 'info')
      + (a.can.manage ? '<div>' + UI.btn('Add a person', { icon: 'plus', attrs: 'data-addperson' }) + '</div>' : '')
      + UI.table(['Person', 'Role', 'Added', { label: '', srLabel: 'Actions' }], rows, { clickable: false, minWidth: '0', emptyTitle: 'Nobody named yet', emptyText: 'Name viewers, contributors and editors.' });
  }

  function linksTab(st, a) {
    if (!st.links) return UI.empty('Links are not available', 'Album links need migration 136_album_links.');
    const share = UI.table(['Link', 'Expires', 'Used', 'State', { label: '', srLabel: 'Actions' }], st.links.map((l) => [esc(l.mode === 'download' ? 'View and download' : 'View only') + (l.password ? ' ' + UI.pill('password', 'outline') : ''), esc(when(l.expiresAt)), l.views + ' views, ' + l.downloads + ' downloads', UI.pill(l.state), l.state === 'active' ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-revokeshare="' + esc(l.id) + '" aria-label="Revoke the share link made ' + esc(when(l.createdAt)) + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'No share links', emptyText: 'A share link opens the album without signing in.' });
    const up = UI.table(['Upload link', 'Expires', 'Files', 'State', { label: '', srLabel: 'Actions' }], (st.uploadLinks || []).map((l) => ['Up to ' + l.maxFiles + ' files of ' + esc(fmtBytes(l.maxBytes)), esc(when(l.expiresAt)), l.received + ' received, ' + l.remaining + ' left', UI.pill(l.state), l.state === 'active' ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-revokeupload="' + esc(l.id) + '" aria-label="Revoke the upload link made ' + esc(when(l.createdAt)) + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'No upload links', emptyText: 'An upload link lets people without an account send photos to this album.' });
    return UI.panel('Share links', UI.notice('Only public items are shown through a share link, and only while the album is labelled public and the tenant allows links that work without signing in. Each opening and download is recorded.', 'info') + share, { actions: UI.btn('New share link', { size: 'sm', icon: 'link', attrs: 'data-newshare' }) })
      + UI.panel('Upload links', UI.notice('Uploads are scanned like any file and held until they pass; then they join the album with its label (' + esc(a.label) + '). The uploader is asked for their name.', 'info') + up, { actions: UI.btn('New upload link', { size: 'sm', icon: 'upload', attrs: 'data-newupload' }) });
  }

  function uploadsTab(st) {
    if (!st.uploads) return UI.empty('Uploads are not available', 'Album links need migration 136_album_links.');
    return UI.table(['File', 'From', 'Size', 'State', 'Received'], st.uploads.map((u) => [esc(u.name), esc(u.uploaderName || ''), esc(fmtBytes(u.size)), UI.pill(u.state === 'scanning' ? 'pending scan' : u.state) + (u.reason ? '<div class="muted" style="font-size:12px">' + esc(u.reason) + '</div>' : ''), esc(when(u.createdAt))]), { clickable: false, minWidth: '0', emptyTitle: 'Nothing came in', emptyText: 'Uploads through this album\'s links show here: waiting for their scan, added, or rejected.' });
  }

  function albumView(st) {
    const back = '<div><a href="#/albums">All albums</a></div>';
    if (st.error) return back + UI.problem(st.error.status === 404 ? 'This album is not available' : 'The album could not be loaded', st.error.status === 404 ? 'It was deleted, or you are not among the people who see it.' : st.error.message, st.error.problem && st.error.problem.trace_id);
    const a = st.album;
    if (!a) return back + UI.notice('Loading…', 'info');
    const actions = (a.items.length ? UI.btn('Slideshow', { kind: 'primary', icon: 'play', attrs: 'data-open="0"' }) + '<a class="btn" href="/api/albums/' + esc(a.id) + '/download" download>' + UI.icon('download', 14) + 'Download zip</a>' : '')
      + (a.can.add && a.kind !== 'personal' && App.can('feed:write') ? UI.btn('Post to feed', { icon: 'send', attrs: 'data-postfeed' }) : '')
      + (a.can.edit ? UI.btn('Edit', { attrs: 'data-edit' }) : '') + (a.can.delete ? UI.btn('Delete', { kind: 'danger', attrs: 'data-delete' }) : '');
    const sub = esc(KIND_WORDS[a.kind]) + ' · ' + a.itemCount + ' item' + (a.itemCount === 1 ? '' : 's') + ' · ' + esc(ROLE_WORDS[a.role]) + (a.ownerName ? ' · by ' + esc(a.ownerName) : '') + ' ' + UI.label(a.label, { sm: true }) + (a.description ? '<div style="margin-top:6px;white-space:pre-wrap">' + esc(a.description) + '</div>' : '');
    const tabsList = [{ id: 'items', label: 'Photos', count: a.items.length }].concat(a.can.manage ? [{ id: 'people', label: 'People', count: (a.contributors || []).length }] : []).concat(a.can.links ? [{ id: 'links', label: 'Links' }, { id: 'uploads', label: 'Uploads', count: (st.uploads || []).filter((u) => u.state !== 'added').length }] : []);
    if (!tabsList.some((t) => t.id === st.tab)) st.tab = 'items';
    const body = st.tab === 'people' ? peopleTab(st, a) : st.tab === 'links' ? linksTab(st, a) : st.tab === 'uploads' ? uploadsTab(st) : itemsTab(st, a);
    return back + UI.pagehead(a.title, sub, actions) + UI.tabs(tabsList, st.tab) + '<div class="vstack gap12">' + body + '</div>';
  }

  // ---------- actions ----------

  async function pickPeople() {
    if (App.can('users:manage')) { try { return (await App.get('/api/admin/users?limit=500')).filter((u) => u.state === 'active' && (!App.me || u.id !== App.me.user.id)); } catch (err) { return null; } }
    return null;
  }

  async function uploadInto(ctx, st, files) {
    const a = st.album; const ids = [];
    for (const file of files) {
      const url = '/api/files/uploads?' + new URLSearchParams({ name: file.name, workspace: a.workspaceId, label: a.floorLabel }).toString();
      let res;
      try { res = await fetch(url, { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' } }); }
      catch (e) { ctx.toast(esc(file.name) + ' was not sent: the server could not be reached.', 'danger'); continue; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { ctx.toast('<b>' + esc(file.name) + '</b> ' + esc(body.detail || body.title || 'was refused'), 'danger', 7000); continue; }
      ids.push(body.id);
    }
    if (!ids.length) return;
    ctx.toast('Uploaded ' + ids.length + ' file' + (ids.length === 1 ? '' : 's') + '; adding them once their scan has passed.');
    const ready = [];
    for (let round = 0; round < 30 && ready.length + 0 < ids.length; round++) {
      for (const id of ids) {
        if (ready.indexOf(id) >= 0) continue;
        const f = await App.get('/api/files/' + enc(id)).catch(() => null);
        if (f && f.state === 'ready') ready.push(id);
        else if (f && f.state === 'rejected') { ids.splice(ids.indexOf(id), 1); ctx.toast(esc(f.name) + ' was rejected by the scan.', 'danger'); }
      }
      if (ready.length < ids.length) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready.length) { ctx.toast('The scan has not finished yet; add the files from Files once it has.', 'warn'); return; }
    try { await App.post('/api/albums/' + enc(a.id) + '/items', { fileIds: ready }); ctx.toast('Added ' + ready.length + ' to ' + esc(a.title) + '.', 'ok'); } catch (err) { App.fail(err, 'Not added'); }
    await loadAlbum(st, a.id); ctx.rerender();
  }

  async function addFromFiles(ctx, st) {
    const a = st.album;
    let files = [];
    try { files = ((await App.get('/api/files/browse?workspace=' + enc(a.workspaceId))).files || []).filter((f) => f.state === 'ready' && IMAGE.test(f.type || '')); } catch (err) { App.fail(err, 'Files could not be listed'); return; }
    const inAlbum = {}; a.items.forEach((i) => { inAlbum[i.fileId] = true; });
    const list = files.filter((f) => !inAlbum[f.id]);
    ctx.modal({
      title: 'Add from Files',
      body: list.length ? '<fieldset class="vstack gap4" style="border:0;padding:0;margin:0"><legend class="fg2" style="font-size:13px">Images at the top of the album\'s workspace that you may share. Adding shares them with everyone who sees the album.</legend>' + list.map((f) => UI.check(f.name + ' (' + f.label + ')', false, 'data-pick="' + esc(f.id) + '"')).join('') + '</fieldset>' : UI.empty('No images to add', 'Upload photos instead, or add images from Files once they have passed their scan.'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + (list.length ? UI.btn('Add', { kind: 'primary', attrs: 'data-addpicked' }) : ''),
      onMount(m) {
        const go = m.querySelector('[data-addpicked]'); if (!go) return;
        go.addEventListener('click', async () => {
          const ids = Array.prototype.filter.call(m.querySelectorAll('[data-pick]'), (x) => x.checked).map((x) => x.dataset.pick);
          if (!ids.length) { ctx.toast('Choose at least one image.', 'warn'); return; }
          try { const r = await App.post('/api/albums/' + enc(a.id) + '/items', { fileIds: ids }); App.closeOverlay(); ctx.toast('Added ' + r.added + '.', 'ok'); await loadAlbum(st, a.id); ctx.rerender(); } catch (err) { App.fail(err, 'Not added'); }
        });
      }
    });
  }

  function albumForm(ctx, st, a) {
    const kinds = [{ value: 'workspace', label: 'Workspace album: the workspace sees it' }, { value: 'personal', label: 'Personal album: you and the people you name' }];
    const labels = ['public', 'internal', 'confidential', 'restricted'].filter((l) => !App.me || ['public', 'internal', 'confidential', 'restricted'].indexOf(l) <= ['public', 'internal', 'confidential', 'restricted'].indexOf(App.me.user.clearance || 'internal'));
    ctx.modal({
      title: a ? 'Edit the album' : 'New album',
      body: (a ? '' : UI.field('Kind', UI.select(kinds, 'workspace', 'data-f-kind'), 'Group albums are made on a group\'s Albums tab.'))
        + UI.field('Title', UI.input(a ? a.title : '', { attrs: 'data-f-title maxlength="200" required' }))
        + UI.field('Description', UI.textarea(a ? a.description || '' : '', { attrs: 'data-f-desc maxlength="4000"', rows: 3 }))
        + UI.field('Label', UI.select(labels, a ? a.floorLabel : 'internal', 'data-f-label'), 'The label of the title and description. The album is labelled at least as high as its highest item; a share link needs it public.'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(a ? 'Save' : 'Create', { kind: 'primary', attrs: 'data-f-go' }),
      onMount(m) {
        m.querySelector('[data-f-go]').addEventListener('click', async () => {
          const title = m.querySelector('[data-f-title]').value.trim(); if (!title) { ctx.toast('Give the album a title.', 'warn'); return; }
          const body = { title, description: m.querySelector('[data-f-desc]').value.trim() || null, label: m.querySelector('[data-f-label]').value };
          try {
            if (a) { st.album = Object.assign(await App.patch('/api/albums/' + enc(a.id), body), { contributors: st.album.contributors }); App.closeOverlay(); ctx.toast('Saved.', 'ok'); await loadAlbum(st, a.id); }
            else { const kind = m.querySelector('[data-f-kind]').value; const made = await App.post('/api/albums', Object.assign(body, { kind }, App.me && App.me.workspace ? { workspaceId: App.me.workspace.id } : {})); App.closeOverlay(); ctx.toast('Album created.', 'ok'); ctx.navigate(ID, { album: made.id }); return; }
          } catch (err) { App.fail(err, a ? 'Not saved' : 'Not created'); return; }
          ctx.rerender();
        });
      }
    });
  }

  async function addPerson(ctx, st) {
    const a = st.album; const users = await pickPeople();
    const roles = [{ value: 'viewer', label: 'Viewer: sees the album' }, { value: 'contributor', label: 'Contributor: adds and removes their own' }].concat(a.can.editors ? [{ value: 'editor', label: 'Editor: arranges, removes any, edits' }] : []);
    ctx.modal({
      title: 'Add a person',
      body: (users ? UI.field('Person', UI.select(users.map((u) => ({ value: u.id, label: (u.displayName || u.username) + ' (' + u.clearance + ')' })), users.length ? users[0].id : '', 'data-p-user')) : UI.field('User id', UI.input('', { attrs: 'data-p-user', placeholder: '26-character user id' }), 'The person\'s user id.'))
        + UI.field('Role', UI.select(roles, 'contributor', 'data-p-role')),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add', { kind: 'primary', attrs: 'data-p-go' }),
      onMount(m) {
        m.querySelector('[data-p-go]').addEventListener('click', async () => {
          const u = m.querySelector('[data-p-user]').value.trim(); if (!u) { ctx.toast('Choose a person.', 'warn'); return; }
          try { await App.put('/api/albums/' + enc(a.id) + '/contributors/' + enc(u), { role: m.querySelector('[data-p-role]').value }); App.closeOverlay(); ctx.toast('Added.', 'ok'); await loadAlbum(st, a.id); ctx.rerender(); } catch (err) { App.fail(err, 'Not added'); }
        });
      }
    });
  }

  function showToken(ctx, title, url, note) {
    ctx.modal({ title: esc(title), body: UI.notice('Copy the link now: it is shown once.', 'warn') + UI.field('Link', UI.input(url, { readonly: true, attrs: 'data-tok' })) + '<p class="fg2" style="margin:0">' + note + '</p>', actions: UI.btn('Done', { kind: 'primary', attrs: 'data-close' }), onMount(m) { const i = m.querySelector('[data-tok]'); i.focus(); i.select(); } });
  }

  function newShare(ctx, st) {
    const a = st.album;
    ctx.modal({
      title: 'New share link',
      body: UI.field('People with the link may', UI.select([{ value: 'view', label: 'View the photos' }, { value: 'download', label: 'View and download' }], 'view', 'data-s-mode'))
        + UI.field('Expires after (hours)', UI.input('72', { type: 'number', attrs: 'data-s-hours min="1" max="720"' }), 'Within the tenant\'s limit for links that work without signing in.')
        + UI.field('Password (optional)', UI.input('', { type: 'password', attrs: 'data-s-pw autocomplete="new-password" minlength="8"' }), 'At least 8 characters. Wrong attempts are limited.'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Make the link', { kind: 'primary', attrs: 'data-s-go' }),
      onMount(m) {
        m.querySelector('[data-s-go]').addEventListener('click', async () => {
          const pw = m.querySelector('[data-s-pw]').value;
          try {
            const r = await App.post('/api/albums/' + enc(a.id) + '/share-links', Object.assign({ mode: m.querySelector('[data-s-mode]').value, expiresInHours: Number(m.querySelector('[data-s-hours]').value) || 72 }, pw ? { password: pw } : {}));
            showToken(ctx, 'Share link made', location.origin + location.pathname + '#/shared?t=' + r.token, 'It opens ' + esc(a.title) + ' without signing in and shows public items only.' + (r.password ? ' Send the password another way.' : ''));
            await loadAlbum(st, a.id);
          } catch (err) { App.fail(err, 'No link made'); }
        });
      },
      onClose() { ctx.rerender(); }
    });
  }

  function newUploadLink(ctx, st) {
    const a = st.album;
    ctx.modal({
      title: 'New upload link',
      body: UI.field('Most files', UI.input('50', { type: 'number', attrs: 'data-u-max min="1" max="500"' }))
        + UI.field('Largest file (MB)', UI.input('25', { type: 'number', attrs: 'data-u-mb min="1"' }), 'Never above the file store\'s upload cap.')
        + UI.field('Expires after (hours)', UI.input('168', { type: 'number', attrs: 'data-u-hours min="1" max="720"' })),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Make the link', { kind: 'primary', attrs: 'data-u-go' }),
      onMount(m) {
        m.querySelector('[data-u-go]').addEventListener('click', async () => {
          try {
            const r = await App.post('/api/albums/' + enc(a.id) + '/upload-links', { maxFiles: Number(m.querySelector('[data-u-max]').value) || 50, maxBytes: Math.round((Number(m.querySelector('[data-u-mb]').value) || 25) * 1048576), expiresInHours: Number(m.querySelector('[data-u-hours]').value) || 168 });
            showToken(ctx, 'Upload link made', location.origin + location.pathname + '#/shared?t=' + r.token, 'People with it can send up to ' + r.maxFiles + ' photos to ' + esc(a.title) + '. They are asked their name; each file is scanned before it joins the album.');
            await loadAlbum(st, a.id);
          } catch (err) { App.fail(err, 'No link made'); }
        });
      },
      onClose() { ctx.rerender(); }
    });
  }

  function postToFeed(ctx, st) {
    const a = st.album;
    ctx.modal({
      title: 'Post the album to the feed',
      body: UI.field('Message', UI.textarea('', { attrs: 'data-q-body maxlength="5000"', rows: 2, placeholder: a.title }), 'Guardrails and holds apply, as for any post.')
        + UI.field('Visibility', UI.select([{ value: 'workspace', label: a.kind === 'group' ? 'The group' : 'The workspace' }, { value: 'unlisted', label: 'Unlisted (link only)' }], 'workspace', 'data-q-vis'))
        + UI.notice('The post is labelled ' + esc(a.label) + ', like the album. The card opens the album, and each reader sees only what they may.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Post', { kind: 'primary', attrs: 'data-q-go' }),
      onMount(m) {
        m.querySelector('[data-q-go]').addEventListener('click', async () => {
          const text = m.querySelector('[data-q-body]').value.trim();
          try { const r = await App.post('/api/albums/' + enc(a.id) + '/post', Object.assign({ visibility: m.querySelector('[data-q-vis]').value }, text ? { body: text } : {})); App.closeOverlay(); ctx.toast(r && r.state === 'held' ? 'Held for review.' : 'Posted.', r && r.state === 'held' ? 'warn' : 'ok'); } catch (err) { App.fail(err, 'Not posted'); }
        });
      }
    });
  }

  // ---------- the screen ----------

  App.register({
    id: ID, title: 'Albums', live: true, summary: 'Photo and video albums on Files: grid, slideshow, people, share and upload links',
    crumb: (st) => ['Files', 'Albums'].concat(st.album ? [st.album.title] : []),
    label: (st) => (st.album ? st.album.label : null),
    states: [
      { title: 'Albums not available', tone: 'warn', text: 'The server has not had migration 135_albums yet: lists say so and nothing changes.', apply(ctx) { ctx.state.albumId = null; ctx.state.list = { available: false, albums: [] }; ctx.state.loaded = true; ctx.rerender(); } },
      { title: 'Album out of reach', tone: 'warn', text: 'A deleted album, or one whose audience does not include you, reads as not found.', apply(ctx) { ctx.state.albumId = 'x'; ctx.state.album = null; ctx.state.error = { status: 404, message: 'Not found' }; ctx.state.loaded = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const want = ctx.params.album || null;
      if (want !== st.albumId) { st.albumId = want; st.album = null; st.error = null; st.loaded = false; st.tab = 'items'; }
      if (!st.loaded) {
        st.loaded = true;
        (want ? loadAlbum(st, want) : loadList(st)).then(() => ctx.rerender());
      }
      root.innerHTML = STYLE + '<div class="page"><div class="vstack gap12">' + (want ? albumView(st) : listView(st)) + '</div></div>';
      wireFallbacks(root);
      ctx.on('click', '[data-seg]', (e, t) => { st.kind = t.dataset.seg; st.list = null; loadList(st).then(() => ctx.rerender()); ctx.rerender(); });
      ctx.on('click', '[data-newalbum]', () => albumForm(ctx, st, null));
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      const a = st.album;
      if (!a) return;
      const urls = { full: (it) => itemUrl(a.id, it.id, 'content') };
      ctx.on('click', '[data-open]', (e, t) => slideshow(a.title, a.items, Number(t.dataset.open), urls));
      ctx.on('click', '[data-edit]', () => albumForm(ctx, st, a));
      ctx.on('click', '[data-delete]', async () => {
        if (!(await ctx.confirm({ title: 'Delete ' + a.title, tone: 'danger', body: '<p class="fg2" style="margin:0">The album goes for everyone, with its links. Its files stay in Files.</p>', ok: 'Delete' }))) return;
        try { await App.del('/api/albums/' + enc(a.id)); ctx.toast('Album deleted.', 'ok'); ctx.navigate(ID); } catch (err) { App.fail(err, 'Not deleted'); }
      });
      ctx.on('click', '[data-postfeed]', () => postToFeed(ctx, st));
      ctx.on('change', '[data-upload]', (e, t) => { const files = Array.prototype.slice.call(t.files || []); if (files.length) uploadInto(ctx, st, files); });
      ctx.on('click', '[data-addfiles]', () => addFromFiles(ctx, st));
      ctx.on('click', '[data-pickupload]', () => { const i = root.querySelector('[data-upload]'); if (i) i.click(); });
      ctx.on('click', '[data-cover]', async (e, t) => { try { await App.patch('/api/albums/' + enc(a.id), { coverItemId: t.dataset.cover }); await loadAlbum(st, a.id); ctx.toast('Cover chosen.', 'ok'); ctx.rerender(); } catch (err) { App.fail(err, 'Not changed'); } });
      ctx.on('click', '[data-remove]', async (e, t) => {
        const it = a.items.find((x) => x.id === t.dataset.remove); if (!it) return;
        if (!(await ctx.confirm({ title: 'Remove ' + it.name, body: '<p class="fg2" style="margin:0">It leaves the album; the file stays in Files.</p>', ok: 'Remove' }))) return;
        try { await App.del('/api/albums/' + enc(a.id) + '/items/' + enc(it.id)); await loadAlbum(st, a.id); ctx.toast('Removed.', 'ok'); ctx.rerender(); } catch (err) { App.fail(err, 'Not removed'); }
      });
      ctx.on('click', '[data-move]', async (e, t) => {
        const ids = a.items.map((x) => x.id); const i = ids.indexOf(t.dataset.move); const j = i + Number(t.dataset.dir);
        if (i < 0 || j < 0 || j >= ids.length) return;
        ids.splice(j, 0, ids.splice(i, 1)[0]);
        try { st.album = Object.assign(await App.put('/api/albums/' + enc(a.id) + '/order', { itemIds: ids }), { contributors: a.contributors }); ctx.rerender(); } catch (err) { App.fail(err, 'Not moved'); }
      });
      ctx.on('click', '[data-addperson]', () => addPerson(ctx, st));
      ctx.on('change', '[data-role]', async (e, t) => { try { await App.put('/api/albums/' + enc(a.id) + '/contributors/' + enc(t.dataset.role), { role: t.value }); ctx.toast('Role changed.', 'ok'); await loadAlbum(st, a.id); ctx.rerender(); } catch (err) { App.fail(err, 'Not changed'); } });
      ctx.on('click', '[data-unperson]', async (e, t) => { try { await App.del('/api/albums/' + enc(a.id) + '/contributors/' + enc(t.dataset.unperson)); await loadAlbum(st, a.id); ctx.toast('Removed.', 'ok'); ctx.rerender(); } catch (err) { App.fail(err, 'Not removed'); } });
      ctx.on('click', '[data-newshare]', () => newShare(ctx, st));
      ctx.on('click', '[data-newupload]', () => newUploadLink(ctx, st));
      ctx.on('click', '[data-revokeshare]', async (e, t) => { if (!(await ctx.confirm({ title: 'Revoke the share link', tone: 'danger', body: '<p class="fg2" style="margin:0">It stops working at once for everyone who has it.</p>', ok: 'Revoke' }))) return; try { await App.del('/api/albums/' + enc(a.id) + '/share-links/' + enc(t.dataset.revokeshare)); await loadAlbum(st, a.id); ctx.toast('Revoked.', 'ok'); ctx.rerender(); } catch (err) { App.fail(err, 'Not revoked'); } });
      ctx.on('click', '[data-revokeupload]', async (e, t) => { if (!(await ctx.confirm({ title: 'Revoke the upload link', tone: 'danger', body: '<p class="fg2" style="margin:0">Nobody can send more through it. What came in stays.</p>', ok: 'Revoke' }))) return; try { await App.del('/api/albums/' + enc(a.id) + '/upload-links/' + enc(t.dataset.revokeupload)); await loadAlbum(st, a.id); ctx.toast('Revoked.', 'ok'); ctx.rerender(); } catch (err) { App.fail(err, 'Not revoked'); } });
    }
  });

  // ---------- B-179: feed cards and a group's Albums tab, filled where other screens leave a placeholder ----------

  const cardCache = {};
  function fillCard(el) {
    const id = el.dataset.albumcard; el.dataset.albumdone = '1';
    const draw = (c) => {
      if (!c) { el.innerHTML = '<span class="muted">The album is gone or out of your reach.</span>'; return; }
      el.innerHTML = STYLE + '<a class="albums-card" href="#/albums?album=' + esc(c.id) + '" aria-label="' + esc('Album: ' + c.title + ', ' + c.itemCount + ' item' + (c.itemCount === 1 ? '' : 's')) + '" style="max-width:260px">'
        + '<div class="albums-cover" aria-hidden="true">' + (c.cover ? imgTag(itemUrl(c.id, c.cover.itemId, 'preview'), itemUrl(c.id, c.cover.itemId, 'content'), '') : '<span>No photos you can see</span>') + '</div>'
        + '<span class="albums-title">' + esc(c.title) + '</span><span class="hstack wrap gap6"><span class="muted" style="font-size:12px">' + c.itemCount + ' item' + (c.itemCount === 1 ? '' : 's') + '</span>' + UI.label(c.label, { sm: true }) + '</span></a>';
      wireFallbacks(el);
    };
    if (cardCache[id] && Date.now() - cardCache[id].at < 60000) { draw(cardCache[id].card); return; }
    App.get('/api/albums/' + enc(id) + '/card').then((c) => { cardCache[id] = { card: c, at: Date.now() }; draw(c); }).catch(() => { cardCache[id] = { card: null, at: Date.now() }; draw(null); });
  }

  function fillGroup(el) {
    const gid = el.dataset.albumgroup; el.dataset.albumdone = '1';
    el.innerHTML = UI.notice('Loading the group\'s albums…', 'info');
    App.get('/api/groups/' + enc(gid) + '/albums').then((r) => {
      if (!r.available) { el.innerHTML = UI.empty('Albums are not available yet', 'This server needs migration 135_albums.'); return; }
      el.innerHTML = STYLE + '<div class="vstack gap12">' + (r.canCreate && App.can('files:write') ? '<div>' + UI.btn('New group album', { icon: 'plus', attrs: 'data-newgroupalbum' }) + '</div>' : '')
        + (r.albums.length ? '<div class="albums-grid">' + r.albums.map(albumCard).join('') + '</div>' : UI.empty('No albums yet', 'Albums made for this group are seen by its members.')) + '</div>';
      wireFallbacks(el);
      const b = el.querySelector('[data-newgroupalbum]');
      if (b) b.addEventListener('click', () => {
        App.modal({
          title: 'New group album',
          body: UI.field('Title', UI.input('', { attrs: 'data-g-title maxlength="200"' })) + UI.field('Description', UI.textarea('', { attrs: 'data-g-desc maxlength="4000"', rows: 3 })) + UI.notice('The group\'s members see it. Its label starts at the group\'s.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-g-go' }),
          onMount(m) {
            m.querySelector('[data-g-go]').addEventListener('click', async () => {
              const title = m.querySelector('[data-g-title]').value.trim(); if (!title) { App.toast('Give the album a title.', 'warn'); return; }
              try { const made = await App.post('/api/albums', { kind: 'group', groupId: gid, title, description: m.querySelector('[data-g-desc]').value.trim() || null }); App.closeOverlay(); App.navigate(ID, { album: made.id }); } catch (err) { App.fail(err, 'Not created'); }
            });
          }
        });
      });
    }).catch((err) => { el.innerHTML = UI.problem('The group\'s albums could not be loaded', err.message, err.problem && err.problem.trace_id); });
  }

  /** Fills every album placeholder under `root` that is not filled yet. */
  App.albumCards = function (root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('[data-albumcard]:not([data-albumdone])'), fillCard);
    Array.prototype.forEach.call((root || document).querySelectorAll('[data-albumgroup]:not([data-albumdone])'), fillGroup);
  };
  /** The markup other screens put where an album card or a group's albums go. */
  App.albumCardSlot = (albumId) => '<div class="albums-cardslot" data-albumcard="' + esc(albumId) + '"><a href="#/albums?album=' + esc(albumId) + '">Open the album</a></div>';
  App.albumGroupSlot = (groupId) => '<div data-albumgroup="' + esc(groupId) + '"></div>';
  App.albumSlideshow = slideshow;
  App.albumWireImages = wireFallbacks;
  App.albumStyle = STYLE;

  if (typeof MutationObserver !== 'undefined') {
    const watch = () => { const main = document.body; if (!main) return; new MutationObserver(() => App.albumCards(document)).observe(main, { childList: true, subtree: true }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
  }
})();
