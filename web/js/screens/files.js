(function () {
  const { UI, esc } = App;

  // ---------- formatting ----------
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l) + 1;
  const GB = 1024 * 1024 * 1024, MB = 1024 * 1024, KB = 1024;
  const fmtBytes = (n) => n == null ? '' : n >= GB ? (n / GB).toFixed(1) + ' GB' : n >= MB ? (n / MB).toFixed(1) + ' MB' : n >= KB ? Math.round(n / KB) + ' KB' : n + ' B';
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const TYPE_NAMES = { 'text/plain': 'text', 'text/markdown': 'Markdown', 'text/csv': 'CSV', 'application/json': 'JSON', 'text/html': 'HTML', 'application/pdf': 'PDF', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint', 'application/vnd.oasis.opendocument.text': 'OpenDocument text', 'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument spreadsheet', 'application/vnd.ms-excel': 'Excel 97-2003', 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' };
  const TYPES = ['text', 'Markdown', 'CSV', 'JSON', 'HTML', 'PDF', 'Word', 'Excel', 'PowerPoint', 'OpenDocument text', 'OpenDocument spreadsheet', 'Excel 97-2003', 'PNG', 'JPEG', 'WebP', 'GIF'];
  // 2.0.0: the kinds the editor opens (server: files/documents/model.ts kindOf), and the documents Files can create.
  const editKind = (f) => {
    const t = f.type || ''; const ext = String(f.name || '').toLowerCase().split('.').pop();
    if (t === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
    if (t === 'application/vnd.oasis.opendocument.spreadsheet') return 'ods';
    if (t === 'application/vnd.oasis.opendocument.text') return 'odt';
    if (t === 'application/vnd.ms-excel') return 'xls';
    if (t === 'text/csv' || (t === 'text/plain' && (ext === 'csv' || ext === 'tsv'))) return 'csv';
    if (t === 'text/markdown' || (t === 'text/plain' && (ext === 'md' || ext === 'markdown'))) return 'markdown';
    if (t === 'text/plain') return 'text';
    return null;
  };
  const NEW_KINDS = [['markdown', 'Markdown document', '.md'], ['text', 'Text file', '.txt'], ['csv', 'CSV table', '.csv'], ['xlsx', 'Excel spreadsheet', '.xlsx'], ['odt', 'OpenDocument text', '.odt'], ['ods', 'OpenDocument spreadsheet', '.ods']];
  const KNOWLEDGE_OK = (f) => /^(text\/(plain|markdown|csv|html)|application\/json|application\/pdf|image\/(png|jpeg|webp|gif))$/.test(f.type || '') || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ['odt', 'ods', 'xlsx', 'xls'].indexOf(editKind(f)) >= 0;
  // The table builder (file-query.js) starts from spreadsheets, CSV and JSON files.
  const TABLE_OK = (f) => ['csv', 'xlsx', 'ods', 'xls'].indexOf(editKind(f)) >= 0 || f.type === 'application/json';
  const typeName = (t) => (t ? TYPE_NAMES[t] || t : null);
  const typePill = (t) => t ? UI.pill(typeName(t), 'outline') : '<span class="muted">sniffing</span>';
  const statePill = (s) => UI.pill(s, s === 'ready' ? 'ok' : s === 'rejected' ? 'danger' : 'warn');
  const shareState = (s) => UI.pill(s, s === 'active' ? 'ok' : s === 'revoked' ? 'danger' : 'warn');
  const previewText = (p) => p === 'ready' ? 'ready' : p === 'queued' ? 'drawing (409 until ready)' : p === 'failed' ? 'failed' : p === 'unavailable' ? 'unavailable' : 'none for this type';
  const overlayOpen = () => !!document.getElementById('overlay');
  const download = (href, name) => { const a = document.createElement('a'); a.href = href; a.download = name || ''; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); };
  const NAME_RE = /[\\/\u0000-\u001f\u007f]/;
  const badName = (n) => !n || n === '.' || n === '..' || NAME_RE.test(n) || n.length > 255;
  const clearance = () => (App.me && App.me.user && App.me.user.clearance) || 'internal';
  const canWrite = () => App.can('files:write');
  // 1.7.0 (B-9802): social groups (GET /api/groups) as readers of a file or a folder; read once per visit.
  const groupsOf = (st) => (st.groupList ? Promise.resolve(st.groupList) : App.get('/api/groups').then((l) => { st.groupList = Array.isArray(l) ? l : (l && l.items) || []; return st.groupList; }).catch(() => []));
  const groupName = (st, id) => { const g = (st.groupList || []).find((x) => x.id === id); return g ? g.name : null; };

  // A raw-body upload (App.api always sends JSON): the CSRF header as app.js sends it, problem details as ApiError.
  async function putRaw(url, file) {
    let res;
    try { res = await fetch(url, { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' } }); }
    catch (e) { throw new App.ApiError({ status: 0, title: 'Network error', detail: 'The server could not be reached.' }); }
    const data = /json/.test(res.headers.get('content-type') || '') ? await res.json() : null;
    if (!res.ok) { if (res.status === 401) App.sessionEnded('Your session ended. Sign in again.'); throw new App.ApiError(data || { status: res.status, title: res.statusText }); }
    return data;
  }
  // A JSON POST whose answer is a file (the link download): saved through a blob URL.
  async function postForFile(url, body) {
    let res;
    try { res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: '*/*', 'X-CSRF-Token': App.state.csrf || '' }, body: JSON.stringify(body) }); }
    catch (e) { throw new App.ApiError({ status: 0, title: 'Network error', detail: 'The server could not be reached.' }); }
    if (!res.ok) { let p = null; try { p = await res.json(); } catch (e2) { /* not JSON */ } throw new App.ApiError(p || { status: res.status, title: res.statusText }); }
    const cd = res.headers.get('content-disposition') || '';
    const star = /filename\*=UTF-8''([^;]+)/.exec(cd); const plain = /filename="([^"]+)"/.exec(cd);
    let name = 'file'; try { name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : name; } catch (e) { /* keep */ }
    const blob = await res.blob();
    const u = URL.createObjectURL(blob); download(u, name); setTimeout(() => URL.revokeObjectURL(u), 10000);
    return { name, size: blob.size };
  }

  function openMenu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  // ---------- live updates ----------
  // file.state reaches the uploader when a version is ready or rejected; pending files are also polled as a fallback.
  const live = { sock: null, on: null, timer: null, poll: null, polls: 0, refresh: null };
  const detach = () => {
    if (live.sock && live.on) live.sock.off('file.state', live.on);
    live.sock = null; live.on = null;
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
    if (live.poll) { clearTimeout(live.poll); live.poll = null; }
  };
  const attach = () => {
    if (!App.socket || live.sock === App.socket) return;
    if (live.sock && live.on) live.sock.off('file.state', live.on);
    live.sock = App.socket;
    live.on = (e) => {
      if (App.state.route !== 'files') { detach(); return; }
      if (e && e.state) App.toast('file.state: version ' + esc(e.version) + ' is ' + esc(e.state) + (e.reason ? ': ' + esc(e.reason) : '') + '.', e.state === 'ready' ? 'ok' : 'danger', 5000);
      if (live.timer) return;
      live.timer = setTimeout(() => { live.timer = null; if (live.refresh) live.refresh(); }, 400);
    };
    live.sock.on('file.state', live.on);
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'files') detach(); });

  // ---------- loading ----------
  function reset(st) {
    Object.keys(st).forEach((k) => delete st[k]);
    Object.assign(st, { wsId: App.me ? App.me.workspace : null, view: 'folder', folder: null, query: '', mode: 'list', typeFilter: 'all', stateFilter: 'all', labelFilter: 'all', sort: 'updated', sortDir: 'desc', tagFilter: null, kids: {}, names: {}, info: {}, detail: null });
  }
  function rerender(ctx) {
    const st = ctx.state;
    if (App.state.route !== 'files') return;
    if (overlayOpen()) { st.dirty = true; return; }
    const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0;
    ctx.rerender();
    const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top;
  }
  // Details (owner, preview, access) for the listed files, which browse and search do not carry.
  function loadInfo(ctx, files) {
    const st = ctx.state;
    const want = files.filter((f) => !st.info[f.id] || st.info[f.id].updatedAt !== f.updatedAt || st.info[f.id].preview === 'queued').slice(0, 60);
    if (!want.length) return Promise.resolve();
    return Promise.all(want.map((f) => App.get('/api/files/' + enc(f.id)).then((d) => { st.info[f.id] = d; }).catch(() => { /* gone or above clearance: the row stays as listed */ }))).then(() => rerender(ctx));
  }
  function load(ctx, quiet) {
    const st = ctx.state;
    if (!quiet) st.loading = true;
    const q = st.folder ? '?folder=' + enc(st.folder) : '';
    const jobs = [App.get('/api/files/browse' + q), App.get('/api/files/usage')];
    if (st.view === 'trash') jobs.push(App.get('/api/files/trash')); else jobs.push(Promise.resolve(null));
    if (st.view === 'shared') jobs.push(App.get('/api/files/shared')); else jobs.push(Promise.resolve(null));
    if (st.query || st.tagFilter) jobs.push(App.get('/api/files/search?' + (st.query ? 'q=' + enc(st.query) : '') + (st.tagFilter ? (st.query ? '&' : '') + 'tag=' + enc(st.tagFilter) : ''))); else jobs.push(Promise.resolve(null));
    st.loadedKey = viewKey(st);
    return Promise.all(jobs).then(([data, usage, trash, shared, results]) => {
      st.data = data; st.usage = usage; st.loaded = true; st.loadError = null;
      if (trash) st.trash = trash; if (shared) st.shared = shared; st.results = results;
      st.names[''] = data.workspace.name;
      st.kids[data.folder ? data.folder.id : ''] = data.folders;
      data.folders.forEach((f) => { st.names[f.id] = f.name; });
      data.path.forEach((p) => { st.names[p.id] = p.name; });
      loadInfo(ctx, results || data.files);
      if (st.sel) loadDetail(ctx, st.sel, true);
      schedulePoll(ctx);
    }).catch((err) => {
      if (st.folder && err.status === 404) { st.folder = null; return load(ctx, quiet); }
      if (!quiet) st.loadError = err; else App.fail(err, 'Could not refresh files');
    }).finally(() => { st.loading = false; rerender(ctx); });
  }
  const viewKey = (st) => st.view + '|' + (st.folder || '') + '|' + (st.tagFilter || '') + '|' + (st.query || '');
  function schedulePoll(ctx) {
    const st = ctx.state;
    const files = (st.results || (st.data && st.data.files) || []).concat(st.detail && st.detail.file ? [st.detail.file] : []);
    const pending = files.some((f) => f.state === 'pending') || (st.detail && st.detail.versions && st.detail.versions.some((v) => v.state === 'quarantined' || v.state === 'scanning'));
    if (live.poll) { clearTimeout(live.poll); live.poll = null; }
    if (!pending) { live.polls = 0; return; }
    if (live.polls++ > 40) return;
    live.poll = setTimeout(() => { live.poll = null; if (App.state.route === 'files') load(ctx, true); }, 1500);
  }
  function loadDetail(ctx, id, quiet) {
    const st = ctx.state;
    if (!quiet || !st.detail || st.detail.id !== id) st.detail = { id, loading: true };
    return Promise.all([
      App.get('/api/files/' + enc(id)),
      App.get('/api/files/' + enc(id) + '/versions').catch((err) => ({ error: err })),
      App.get('/api/files/' + enc(id) + '/shares').catch((err) => ({ error: err })),
      App.get('/api/files/' + enc(id) + '/group-grants').catch(() => null),
      App.get('/api/files/' + enc(id) + '/knowledge').catch(() => null)
    ]).then(([file, versions, shares, grants, kn]) => {
      if (!st.detail || st.detail.id !== id) return;
      st.info[id] = file;
      st.detail = { id, file, versions: Array.isArray(versions) ? versions : null, versionsError: versions.error || null, shares: Array.isArray(shares) ? shares : null, sharesError: shares.error || null, groupGrants: Array.isArray(grants) ? grants : null, knowledge: Array.isArray(kn) ? kn : null };
    }).catch((err) => {
      if (!st.detail || st.detail.id !== id) return;
      if (err.status === 404) { st.sel = null; st.detail = null; } else st.detail = { id, error: err };
    }).finally(() => rerender(ctx));
  }

  App.register({
    id: 'files', title: 'Files', live: true, summary: 'Folders, quarantined uploads, versions with restore, trash, shares and links, quotas, previews',
    crumb: (st) => ['Files'].concat(st.view === 'trash' ? ['Trash'] : st.view === 'shared' ? ['Shared with me'] : st.view === 'dashboard' ? ['Dashboard'] : st.view === 'reports' ? ['Reports'] : st.view === 'location' ? ['Linked'] : []),
    label: (st) => { const d = st.detail && st.detail.id === st.sel && st.detail.file; return d && st.view === 'folder' ? d.label : null; },
    commands: [{ label: 'Upload a file', sub: 'Files', run(app) { app.stateFor('files').openUpload = true; app.render(); } }, { label: 'New document', sub: 'Files', run(app) { app.stateFor('files').openNew = true; app.render(); } }, { label: 'Files dashboard', sub: 'Files', run(app) { const st = app.stateFor('files'); st.view = 'dashboard'; app.render(); } }],
    states: [
      { title: 'Version rejected by scan', tone: 'danger', text: 'ClamAV found a signature in a version. The version is never served; the earlier ready version stays current and the uploader is told why.',
        apply(ctx) { const st = ctx.state; st.view = 'folder'; st.problem = null; const files = (st.data && st.data.files) || []; const f = files.find((x) => x.state === 'rejected') || files.find((x) => st.detail && st.detail.id === x.id && st.detail.versions && st.detail.versions.some((v) => v.state === 'rejected')); if (f) { st.sel = f.id; st.rejectedNote = true; loadDetail(ctx, f.id); } else st.demoNote = 'No file in this folder has a rejected version. When the file.scan job finds a ClamAV signature, a label above the uploader\'s clearance or above the workspace ceiling, the version is marked rejected with its reason, it is never served, and the uploader gets file.state with the reason.'; ctx.rerender(); } },
      { title: 'Upload over quota', tone: 'danger', text: '413 while the bytes arrive, naming the limit, the scope, what is used and what came in. Nothing is stored.',
        apply(ctx) { const st = ctx.state; st.view = 'folder'; const u = st.usage; const w = u && u.workspace; st.problem = { title: 'Upload refused: storage quota', text: w ? (w.maxBytes != null ? '413 {limit: storage_bytes, scope: workspace, used: ' + fmtBytes(w.usedBytes) + ', max: ' + fmtBytes(w.maxBytes) + '}. An upload that would pass ' + w.name + '\'s limit of ' + fmtBytes(w.maxBytes) + ' is refused while its bytes arrive and nothing is stored. Empty the trash or ask a tenant admin to raise the workspace quota.' : w.name + ' has no storage limit, so no upload is refused for storage now. With a limit set, an upload that would pass it gets 413 {limit: storage_bytes, scope, used, max, incoming} while its bytes arrive, and nothing is stored.') : 'Storage usage is still loading.' }; ctx.rerender(); } },
      { title: 'Link used up', tone: 'warn', text: 'A link past its use limit, expired or revoked is refused with the same 404 as an unknown token. The owner sees it as used up here.',
        apply(ctx) { const st = ctx.state; st.view = 'folder'; st.problem = null; const d = st.detail && st.detail.shares; if (d && d.some((s) => s.state === 'used up')) st.linkNote = true; else st.demoNote = 'The selected file has no used-up link. A link past its use limit, expired or revoked is refused with the same 404 as an unknown token, and shows here as used up, expired or revoked.'; ctx.rerender(); } },
      { title: 'Preview unavailable', tone: 'neutral', text: 'A preview exists for images and the first page of a PDF, within FILES_PREVIEW_MAX_BYTES and with the tool installed. Otherwise the inspector says so and offers the download.',
        apply(ctx) { const st = ctx.state; st.view = 'folder'; st.problem = null; const files = (st.data && st.data.files) || []; const f = files.find((x) => st.info[x.id] && st.info[x.id].preview !== 'ready'); if (f) { st.sel = f.id; st.previewNote = true; loadDetail(ctx, f.id); } else st.demoNote = 'No file here lacks a preview. Previews are drawn for images and the first page of a PDF, within FILES_PREVIEW_MAX_BYTES and with the tool installed; otherwise the inspector says so and offers the download.'; ctx.rerender(); } },
      { title: 'Restored to the root', tone: 'info', text: 'A file whose folder is gone comes back at the workspace root; a clashing name gets " (2)".',
        apply(ctx) { const st = ctx.state; st.view = 'trash'; st.restoredNote = 'A file whose folder is gone (purged, or still in the trash) comes back at the workspace root when restored; a name that clashes there gets " (2)". Something that went to the trash with its folder is restored with the folder (409 on its own).'; load(ctx, true); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.kids || st.wsId !== (App.me ? App.me.workspace : null)) reset(st);
      live.refresh = () => load(ctx, true);
      attach();
      // The router parses the hash again on every render: a link's parameters are read once per hash.
      const freshLink = st.paramHash !== location.hash; st.paramHash = location.hash;
      if (!freshLink) { delete ctx.params.view; delete ctx.params.folder; delete ctx.params.file; }
      if (ctx.params.view) { st.view = ctx.params.view; delete ctx.params.view; st.loaded = false; }
      if (ctx.params.folder) { st.folder = ctx.params.folder; st.view = 'folder'; delete ctx.params.folder; st.loaded = false; }
      if (ctx.params.file) { const id = ctx.params.file; delete ctx.params.file; st.sel = id; App.get('/api/files/' + enc(id)).then((f) => { st.folder = f.folderId; st.view = 'folder'; st.loaded = false; rerender(ctx); }).catch((err) => App.fail(err, 'Could not open the file')); }
      if (!st.loaded && !st.loading && !st.loadError) load(ctx);
      else if (st.loaded && !st.loading && st.loadedKey !== viewKey(st)) load(ctx, true);
      if (st.dirty) st.dirty = false;

      const style = '<style>'
        + '#main > .page > *,#main > .inspector > *{flex-shrink:0}'
        + '#main .files-crumbs a{color:inherit}'
        + '#main .files-card{display:flex;flex-direction:column;gap:6px;text-align:left;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);cursor:pointer;font-family:inherit;min-width:0}'
        + '#main .files-card:hover{border-color:var(--muted)}#main .files-card.selected{background:var(--accent-tint);border-color:var(--accent)}'
        + '#main .files-card .t{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#main .files-card .s{font-size:12px;color:var(--muted)}'
        + '#main .files-thumb{height:72px;border-radius:6px;background:var(--sel);display:flex;align-items:center;justify-content:center;color:var(--muted);overflow:hidden}'
        + '#main .files-thumb img{width:100%;height:100%;object-fit:cover}'
        + '#main .files-preview{min-height:140px;border-radius:6px;background:var(--sel);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;text-align:center;padding:8px;overflow:hidden}'
        + '#main .files-preview img{max-width:100%;max-height:260px;display:block}'
        + '#main .files-tags{display:flex;flex-wrap:wrap;gap:4px}'
        + '#main .files-taglink{display:inline-flex;align-items:center;min-height:24px;margin-right:8px;font-size:11px}'
        + '#main .files-name{font-weight:600;overflow-wrap:anywhere}'
        + '</style>';
      const head = (sub, actions) => UI.pagehead('Files', sub || '', actions || '');
      if (st.loadError) {
        const conflict = st.loadError.status === 409;
        root.innerHTML = style + '<div class="page">' + head() + (conflict ? UI.empty('Choose a workspace first', esc(st.loadError.message) + ' Files live in a workspace; pick one from the workspace switcher.') : UI.problem('Files could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>') + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      if (!st.loaded) { root.innerHTML = style + '<div class="page">' + head() + UI.notice('Loading…', 'info') + '</div>'; return; }

      const data = st.data; const usage = st.usage;
      const wsName = data.workspace.name;
      const curId = data.folder ? data.folder.id : '';
      const folderName = data.folder ? data.folder.name : wsName;
      const sel = st.detail && st.detail.id === st.sel ? st.detail : null;

      // ----- left pane: folder tree (the branches browsed so far) -----
      const tree = (pid, depth) => (st.kids[pid] || []).map((f) => UI.listItem('<span style="padding-left:' + (depth * 12) + 'px">' + UI.icon('files', 13) + ' ' + esc(f.name) + '</span>', '', { active: st.view === 'folder' && f.id === curId, attrs: 'data-folder="' + esc(f.id) + '"' }) + tree(f.id, depth + 1)).join('');
      const meter = (name, scope) => scope.maxBytes != null ? UI.meter(name, fmtBytes(scope.usedBytes) + ' of ' + fmtBytes(scope.maxBytes), Math.min(100, (scope.usedBytes / Math.max(1, scope.maxBytes)) * 100), scope.usedBytes / Math.max(1, scope.maxBytes) > 0.8 ? 'warn' : 'accent') : UI.meter(name, fmtBytes(scope.usedBytes) + ', no limit', 0);
      const trashCount = st.trash ? st.trash.files.length + st.trash.folders.length : null;
      const left = '<div class="leftpane"><div class="hstack"><div class="eyebrow grow">Folders</div>' + (canWrite() ? UI.iconbtn('plus', 'New folder', { attrs: 'data-newfolder', cls: 'sm ghost' }) : '') + '</div>'
        + '<div class="vstack gap4">' + UI.listItem(UI.icon('files', 13) + ' ' + esc(wsName), '', { active: st.view === 'folder' && !curId, attrs: 'data-folder=""' }) + tree('', 1) + '</div><div class="divider"></div>'
        + UI.listItem(UI.icon('trash', 13) + ' Trash', (trashCount == null ? 'Purged' : trashCount + ' item' + (trashCount === 1 ? '' : 's') + ', purged') + ' after ' + usage.trashDays + ' days', { active: st.view === 'trash', attrs: 'data-view="trash"' })
        + UI.listItem(UI.icon('overview', 13) + ' Dashboard', 'Storage, types, owners and activity of ' + esc(curId ? folderName : wsName), { active: st.view === 'dashboard', attrs: 'data-view="dashboard"' })
        + UI.listItem(UI.icon('images', 13) + ' Albums', 'Photos and videos gathered for a workspace, a group or people you name', { attrs: 'data-goalbums' })
        + UI.listItem(UI.icon('runs', 13) + ' Reports', 'Inventory, largest, stale, duplicates, shares', { active: st.view === 'reports', attrs: 'data-view="reports"' })
        + UI.listItem(UI.icon('grid', 13) + ' Table builder', 'Queries over spreadsheets, CSV and JSON', { attrs: 'data-tablebuilder' })
        + UI.listItem(UI.icon('link', 13) + ' Shared with me', st.shared ? st.shared.length + ' file' + (st.shared.length === 1 ? '' : 's') : 'From people, workspaces and groups', { active: st.view === 'shared', attrs: 'data-view="shared"' })
        + (App.filesLocations ? '<div class="divider"></div>' + App.filesLocations.leftPane(ctx, st) : '')
        + '<div style="margin-top:auto" class="vstack gap6"><div class="eyebrow">Storage</div>' + meter(usage.workspace.name, usage.workspace) + meter('Tenant', usage.tenant) + '<span class="muted" style="font-size:11px">Uploads up to ' + fmtBytes(usage.maxUploadBytes) + '. Stored and quarantined versions count, trash too until purged; previews do not.' + (usage.retention && (usage.retention.retentionDays != null || usage.retention.versionCap != null) ? ' ' + (usage.retention.retentionDays != null ? 'A file unchanged for ' + usage.retention.retentionDays + ' days goes to the trash. ' : '') + (usage.retention.versionCap != null ? 'The newest ' + usage.retention.versionCap + ' versions of a file are kept.' : '') : '') + (App.canOpen('usage-audit') ? ' <a href="#" data-gousage>Storage report</a>' : '') + '</span></div></div>';

      // ----- main -----
      let main = '';
      const demo = st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-cleardemo' })) : '';
      if (st.view === 'trash') main = demo + renderTrash(ctx);
      else if (st.view === 'shared') main = demo + renderShared(ctx);
      else if (st.view === 'location' && App.filesLocations) main = demo + App.filesLocations.render(ctx, st);
      else if ((st.view === 'dashboard' || st.view === 'reports') && App.filesReports) main = demo + App.filesReports.render(ctx, st, { folderId: curId || null, folderName: curId ? folderName : null, workspaceName: wsName });
      else {
        const searching = !!(st.query || st.tagFilter);
        let files = searching ? (st.results || []) : data.files;
        if (st.typeFilter !== 'all') files = files.filter((f) => typeName(f.type) === st.typeFilter);
        if (st.stateFilter !== 'all') files = files.filter((f) => f.state === st.stateFilter);
        if (st.labelFilter !== 'all') files = files.filter((f) => f.label === st.labelFilter);
        const dir = st.sortDir === 'asc' ? 1 : -1;
        files = files.slice().sort((a, b) => { if (st.sort === 'name') return a.name.localeCompare(b.name) * dir; if (st.sort === 'size') return (a.size - b.size) * dir; if (st.sort === 'type') return String(typeName(a.type) || '').localeCompare(String(typeName(b.type) || '')) * dir; return (a.updatedAt - b.updatedAt) * dir; });
        const crumbs = [{ id: '', name: wsName }].concat(data.path).map((p, i, all) => i < all.length - 1 ? '<a href="#" data-folder="' + esc(p.id) + '">' + esc(p.name) + '</a> <span class="muted">/</span> ' : '<b>' + esc(p.name) + '</b>').join('');
        const sortLabel = { name: 'Name', size: 'Size', updated: 'Updated', type: 'Type' }[st.sort] + ' ' + (st.sortDir === 'asc' ? '↑' : '↓');
        const toolbar = '<div class="toolbar">' + UI.search('Search names, tags and alt text', 'data-search', st.query)
          + UI.seg([{ id: 'list', label: 'List' }, { id: 'grid', label: 'Grid' }], st.mode, 'data-mode')
          + '<span class="relative">' + UI.btn(st.typeFilter === 'all' ? 'Type' : 'Type: ' + st.typeFilter, { size: 'sm', icon: 'filter', attrs: 'data-typemenu', cls: st.typeFilter === 'all' ? '' : 'active' }) + '</span>'
          + '<span class="relative">' + UI.btn(st.stateFilter === 'all' ? 'State' : 'State: ' + st.stateFilter, { size: 'sm', attrs: 'data-statemenu', cls: st.stateFilter === 'all' ? '' : 'active' }) + '</span>'
          + '<span class="relative">' + UI.btn(st.labelFilter === 'all' ? 'Label' : 'Label: ' + st.labelFilter, { size: 'sm', attrs: 'data-labelmenu', cls: st.labelFilter === 'all' ? '' : 'active' }) + '</span>'
          + '<span class="relative">' + UI.btn(sortLabel, { size: 'sm', icon: 'sort', attrs: 'data-sortmenu' }) + '</span>'
          + (st.tagFilter ? UI.chip('tag: ' + esc(st.tagFilter) + ' <span class="x" aria-hidden="true">×</span>', true, 'data-cleartag aria-label="Clear the tag filter ' + esc(st.tagFilter) + '"') : '')
          + '<span class="muted right" style="font-size:12px">' + files.length + ' file' + (files.length === 1 ? '' : 's') + (searching ? ' ready across your workspaces' : '') + '</span></div>';
        const folderCards = !searching && data.folders.length ? '<div class="hstack wrap gap6">' + data.folders.map((c) => UI.btn(c.name, { size: 'sm', icon: 'files', attrs: 'data-folder="' + esc(c.id) + '"' })).join('') + '</div>' : '';
        const info = (f) => st.info[f.id] || {};
        const where = (f) => f.workspaceName && f.workspaceId !== data.workspace.id ? f.workspaceName : f.folderId ? (st.names[f.folderId] || 'a folder') : wsName;
        let listHtml;
        const emptyText = searching ? 'No ready file matches. Search finds ready files by name, tag, and an image\'s alt text or description.' : canWrite() ? 'Upload one or clear the filters.' : 'Nothing here yet.';
        if (st.mode === 'grid') {
          listHtml = files.length ? '<div class="grid4">' + files.map((f) => '<button type="button" class="files-card ' + (f.id === st.sel ? 'selected' : '') + '" data-file="' + esc(f.id) + '" aria-pressed="' + (f.id === st.sel ? 'true' : 'false') + '"><span class="files-thumb">' + (info(f).preview === 'ready' ? '<img src="/api/files/' + esc(f.id) + '/preview?v=' + esc(f.currentVersion) + '" alt="' + esc(info(f).altText || '') + '">' : UI.icon(/PDF|Word/.test(typeName(f.type) || '') ? 'knowledge' : /PNG|JPEG|WebP|GIF/.test(typeName(f.type) || '') ? 'images' : 'runs', 26)) + '</span><span class="t">' + esc(f.name) + '</span><span class="s">' + esc(fmtBytes(f.size)) + ' · ' + esc(typeName(f.type) || 'pending') + '</span><span class="hstack gap4">' + statePill(f.state) + UI.label(f.label, { sm: true }) + '</span></button>').join('') + '</div>' : UI.empty(searching ? 'No matches' : 'No files here', emptyText);
        } else {
          listHtml = UI.table((canWrite() ? [{ label: '', srLabel: 'Select' }] : []).concat(['Name', 'Type', 'Size', 'Label', 'State', 'Version', 'Owner', 'Updated', 'Tags']), files.map((f) => ({ cells: (canWrite() ? ['<input type="checkbox" data-pick="' + esc(f.id) + '"' + (st.picked && st.picked[f.id] ? ' checked' : '') + ' aria-label="Select ' + esc(f.name) + '">'] : []).concat(['<button type="button" class="linkbtn files-name" data-file="' + esc(f.id) + '" style="background:none;border:0;padding:0;color:inherit;font:inherit;font-weight:600;text-align:left;cursor:pointer">' + esc(f.name) + '</button>' + (searching ? '<div class="muted" style="font-size:11px">' + esc(where(f)) + '</div>' : ''), typePill(f.type), '<span class="num">' + esc(fmtBytes(f.size)) + '</span>', UI.label(f.label, { sm: true }), statePill(f.state), f.currentVersion ? '<span class="num">' + f.currentVersion + '</span>' : '<span class="muted">none ready</span>', info(f).ownerName ? esc(info(f).ownerName) : '<span class="muted">' + (App.me && f.ownerId === App.me.user.id ? 'you' : '') + '</span>', esc(when(f.updatedAt)), (f.tags || []).map((t) => '<a href="#" data-tag="' + esc(t) + '" class="mono files-taglink">' + esc(t) + '</a>').join('')]), attrs: 'data-file="' + esc(f.id) + '"', selected: f.id === st.sel })), { minWidth: '860px', emptyTitle: searching ? 'No matches' : 'No files here', emptyText });
        }
        const actions = (canWrite() ? UI.btn('Upload', { kind: 'primary', icon: 'upload', attrs: 'data-upload' }) + '<span class="relative">' + UI.btn('New document', { icon: 'plus', attrs: 'data-newdoc aria-haspopup="menu"' }) + '</span>' + (App.filesLocations ? '<span class="relative">' + UI.btn('Import', { icon: 'download', attrs: 'data-importmenu aria-haspopup="menu"' }) + '</span>' : '') + UI.btn('New folder', { icon: 'plus', attrs: 'data-newfolder' }) : '')
          + (curId && canWrite() ? (App.can('knowledge:manage') ? UI.btn('Knowledge source', { icon: 'knowledge', attrs: 'data-ksource', title: 'Add this folder as a knowledge source' }) : '') + UI.btn('Share with a group', { kind: 'ghost', icon: 'link', attrs: 'data-foldergroups' }) + UI.btn('Rename or move', { kind: 'ghost', attrs: 'data-renamefolder' }) + UI.btn('Copy folder', { kind: 'ghost', attrs: 'data-copyfolder' }) + UI.btn('Trash folder', { kind: 'ghost', attrs: 'data-trashfolder' }) : '');
        main = head('<span class="files-crumbs">' + crumbs + '</span> <span class="muted">' + data.files.length + ' file' + (data.files.length === 1 ? '' : 's') + ', ' + data.folders.length + ' folder' + (data.folders.length === 1 ? '' : 's') + '</span>', actions)
          + demo
          + (st.problem ? UI.problem(st.problem.title, esc(st.problem.text), st.problem.trace || null) : '')
          + (st.uploaded ? UI.notice('<b>' + esc(st.uploaded.name) + ' accepted (202).</b> Version ' + esc(st.uploaded.version) + ' is quarantined: the bytes are sealed, then the file.scan job sniffs the type, classifies text, runs ClamAV and checks the label against your clearance and the workspace ceiling. Only a ready version is served. You get <span class="mono">file.state</span> when it is decided.', 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearupload' })) : '')
          + toolbar + bulkBar(ctx, files) + folderCards + listHtml;
      }

      // ----- inspector -----
      let inspector = '';
      if (st.view === 'folder') {
        if (st.sel && sel) inspector = renderInspector(ctx, sel);
        else if (st.sel) inspector = '<aside class="inspector w360" aria-label="File">' + UI.notice('Loading…', 'info') + '</aside>';
        else inspector = '<aside class="inspector w300" aria-label="File">' + UI.empty('Nothing selected', 'Select a file to see its versions, shares, tags and preview.') + '</aside>';
      }

      root.innerHTML = style + left + '<div class="page">' + main + '</div>' + inspector;

      // ----- events -----
      ctx.on('click', '[data-folder]', (e, t) => { e.preventDefault(); st.folder = t.dataset.folder || null; st.view = 'folder'; st.query = ''; st.tagFilter = null; st.results = null; st.problem = null; st.demoNote = null; load(ctx, true); });
      ctx.on('click', '[data-view]', (e, t) => { st.view = t.dataset.view; st.problem = null; st.demoNote = null; load(ctx, true); });
      ctx.on('click', '[data-file]', (e, t) => { if (e.target.closest('a') || e.target.closest('[data-pick]')) return; const id = t.dataset.file;
        if (st.view !== 'folder') { App.get('/api/files/' + enc(id)).then((f) => { st.sel = id; st.folder = f.folderId || null; st.view = 'folder'; st.query = ''; st.tagFilter = null; st.results = null; loadDetail(ctx, id); load(ctx, true); }).catch((err) => App.fail(err, 'Could not open the file')); return; } if (id === st.sel && sel) return; st.sel = id; st.rejectedNote = false; st.linkNote = false; st.previewNote = false; loadDetail(ctx, id); ctx.rerender(); });
      ctx.on('click', '[data-tag]', (e, t) => { e.preventDefault(); st.view = 'folder'; st.tagFilter = t.dataset.tag; st.query = ''; load(ctx, true); });
      ctx.on('click', '[data-cleartag]', () => { st.tagFilter = null; st.results = null; load(ctx, true); });
      ctx.on('click', '[data-cleardemo]', () => { st.demoNote = null; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => {
        st.query = t.value;
        if (live.search) clearTimeout(live.search);
        live.search = setTimeout(() => {
          live.search = null;
          const keep = () => { const el = ctx.$('[data-search]'); if (el) { const vv = st.query; el.focus(); el.value = vv; el.setSelectionRange(vv.length, vv.length); } };
          if (!st.query.trim() && !st.tagFilter) { st.results = null; ctx.rerender(); keep(); return; }
          load(ctx, true).then(keep);
        }, 300);
      });
      ctx.on('click', '[data-mode] [data-seg]', (e, t) => { st.mode = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-typemenu]', (e, t) => openMenu(ctx, t, [['all', 'All types']].concat(TYPES.map((x) => [x, x])), st.typeFilter, (vv) => { st.typeFilter = vv; ctx.rerender(); }));
      ctx.on('click', '[data-statemenu]', (e, t) => openMenu(ctx, t, [['all', 'All states'], ['ready', 'ready'], ['pending', 'pending (quarantined)'], ['rejected', 'rejected']], st.stateFilter, (vv) => { st.stateFilter = vv; ctx.rerender(); }));
      ctx.on('click', '[data-labelmenu]', (e, t) => openMenu(ctx, t, [['all', 'All labels']].concat(LABELS.filter((l) => rank(l) <= rank(clearance())).map((l) => [l, l])), st.labelFilter, (vv) => { st.labelFilter = vv; ctx.rerender(); }));
      ctx.on('click', '[data-sortmenu]', (e, t) => openMenu(ctx, t, [['name:asc', 'Name A to Z'], ['name:desc', 'Name Z to A'], ['size:desc', 'Largest first'], ['size:asc', 'Smallest first'], ['updated:desc', 'Recently updated'], ['updated:asc', 'Oldest update'], ['type:asc', 'By type']], st.sort + ':' + st.sortDir, (vv) => { const [s, d] = vv.split(':'); st.sort = s; st.sortDir = d; ctx.rerender(); }));
      ctx.on('click', '[data-gousage]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
      ctx.on('click', '[data-goalbums]', () => ctx.navigate('albums'));
      ctx.on('click', '[data-clearupload]', () => { st.uploaded = null; ctx.rerender(); });
      ctx.on('click', '[data-ksource]', () => addKnowledgeSource(ctx, data.folder));
      ctx.on('click', '[data-newfolder]', () => newFolder(ctx, curId, folderName));
      ctx.on('click', '[data-renamefolder]', () => renameFolder(ctx, data.folder));
      ctx.on('click', '[data-foldergroups]', () => folderGroups(ctx, data.folder));
      ctx.on('click', '[data-trashfolder]', async () => {
        const f = data.folder;
        const ok = await ctx.confirm({ title: 'Move ' + esc(f.name) + ' to the trash', tag: 'with contents', tone: 'danger', body: '<p class="fg2" style="margin:0">The folder goes to the trash with everything in it and is purged after ' + usage.trashDays + ' days. Shares on its files stop working until it is restored.</p>', kv: [['Folder', esc(f.name)], ['Files here', data.files.length], ['Subfolders here', data.folders.length]], ok: 'Trash folder' });
        if (!ok) return;
        try {
          const out = await App.del('/api/files/folders/' + enc(f.id));
          const parent = f.parentId || null;
          delete st.kids[f.id]; Object.keys(st.kids).forEach((k) => { st.kids[k] = st.kids[k].filter((x) => x.id !== f.id); });
          st.folder = parent; st.sel = null; st.detail = null; st.trash = null;
          ctx.toast('Folder ' + esc(f.name) + ' trashed with ' + out.files + ' file' + (out.files === 1 ? '' : 's') + ' and ' + out.folders + ' subfolder' + (out.folders === 1 ? '' : 's') + '. Audited file.folder.trashed.', 'warn');
          load(ctx, true);
        } catch (err) { App.fail(err, 'Could not trash the folder'); }
      });
      ctx.on('click', '[data-upload]', () => openUpload(ctx, null));
      ctx.on('click', '[data-newdoc]', (e, t) => openMenu(ctx, t, NEW_KINDS.map((k) => [k[0], k[1] + ' (' + k[2] + ')']), null, (kind) => newDocument(ctx, kind)));
      ctx.on('click', '[data-copyfolder]', () => copyFolder(ctx, data.folder));
      ctx.on('click', '[data-tablebuilder]', () => ctx.navigate('file-query'));
      if (st.openNew) { st.openNew = false; if (st.view === 'folder' && canWrite()) newDocument(ctx, 'markdown'); }
      wireBulk(ctx);
      if (App.filesLocations) {
        App.filesLocations.wire(ctx, st);
        ctx.on('click', '[data-importmenu]', (e, t) => openMenu(ctx, t, [['url', 'From a URL'], ['database', 'Database table or query'], ['knowledge', 'Knowledge document'], ['agent-run', 'Agent run'], ['workflow-run', 'Workflow run'], ['workflow', 'Workflow (bundle)'], ['skill', 'Skill'], ['tool', 'Tool']], null, (kind) => (kind === 'url' ? App.filesLocations.fetchUrl(ctx, st) : App.filesLocations.importFrom(ctx, st, kind))));
      }
      if ((st.view === 'dashboard' || st.view === 'reports') && App.filesReports) App.filesReports.wire(ctx, st, { folderId: curId || null, folderName: curId ? folderName : null, workspaceName: wsName });
      if (st.openUpload) { st.openUpload = false; if (st.view === 'folder' && canWrite()) openUpload(ctx, null); }
      if (sel && sel.file && st.view === 'folder') wireInspector(ctx, sel);
      if (st.view === 'trash') wireTrash(ctx);
      if (st.view === 'shared') wireShared(ctx);
    }
  });

  // ---------- folders ----------
  function folderOptions(st, exclude) {
    const out = [{ value: '', label: st.names[''] || 'Workspace root' }];
    const walk = (pid, depth) => (st.kids[pid] || []).forEach((f) => { if (exclude && f.id === exclude) return; out.push({ value: f.id, label: '  '.repeat(depth) + f.name }); walk(f.id, depth + 1); });
    walk('', 1);
    return out;
  }
  function newFolder(ctx, parentId, parentName) {
    ctx.modal({ title: 'New folder in ' + esc(parentName), body: UI.field('Name', UI.input('', { placeholder: '1 to 255 characters, no / or \\', attrs: 'data-nf-name' }), 'Unique in its folder, case-insensitive.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-nf-ok' }), onMount(m) {
      const go = async () => {
        const name = m.querySelector('[data-nf-name]').value.trim();
        if (badName(name)) { ctx.toast('Names are 1 to 255 characters without / or \\ or control characters.', 'danger'); return; }
        try {
          const f = await App.post('/api/files/folders', parentId ? { name, parentId } : { name });
          App.closeOverlay(); ctx.toast('Folder ' + esc(f.name) + ' created. Audited file.folder.created.', 'ok'); load(ctx, true);
        } catch (err) { App.fail(err, 'Could not create the folder'); }
      };
      m.querySelector('[data-nf-ok]').addEventListener('click', go);
      m.querySelector('[data-nf-name]').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    } });
  }
  function renameFolder(ctx, folder) {
    const st = ctx.state;
    ctx.modal({ title: 'Rename or move ' + esc(folder.name), body: '<div class="formgrid">' + UI.field('Name', UI.input(folder.name, { attrs: 'data-rf-name' })) + UI.field('Parent', UI.select(folderOptions(st, folder.id), folder.parentId || '', 'data-rf-parent'), 'Within the workspace, not into itself. Folders you have not opened yet are not listed.') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-rf-ok' }), onMount(m) {
      m.querySelector('[data-rf-ok]').addEventListener('click', async () => {
        const name = m.querySelector('[data-rf-name]').value.trim(); const parent = m.querySelector('[data-rf-parent]').value || null;
        if (badName(name)) { ctx.toast('Names are 1 to 255 characters without / or \\ or control characters.', 'danger'); return; }
        const patch = {}; if (name !== folder.name) patch.name = name; if (parent !== (folder.parentId || null)) patch.parentId = parent;
        if (!Object.keys(patch).length) { App.closeOverlay(); return; }
        try {
          await App.patch('/api/files/folders/' + enc(folder.id), patch);
          Object.keys(st.kids).forEach((k) => { st.kids[k] = st.kids[k].filter((x) => x.id !== folder.id); });
          App.closeOverlay(); ctx.toast('Folder saved. Audited file.folder.updated.', 'ok'); load(ctx, true);
          if (patch.parentId !== undefined) App.get('/api/files/browse' + (parent ? '?folder=' + enc(parent) : '')).then((d) => { st.kids[parent || ''] = d.folders; rerender(ctx); }).catch(() => {});
        } catch (err) { App.fail(err, 'Could not save the folder'); }
      });
    } });
  }
  async function addKnowledgeSource(ctx, folder) {
    let bases;
    try { bases = (await App.get('/api/knowledge/bases')).filter((b) => b.access === 'manage'); } catch (err) { App.fail(err, 'Could not list knowledge bases'); return; }
    if (!bases.length) { ctx.toast('You curate no knowledge base. A knowledge curator adds folders as sources.', 'warn'); return; }
    const ready = ((ctx.state.data && ctx.state.data.files) || []).filter((f) => f.state === 'ready').length;
    ctx.modal({ title: 'Add ' + esc(folder.name) + ' as a knowledge source', body: '<p class="fg2" style="margin:0">The folder and its subfolders become a source of a knowledge base you curate. Each sync indexes its ready files of a knowledge type up to the base\'s label, named by their path below the folder; chat cites them like any document.</p>' + UI.field('Knowledge base', UI.select(bases.map((b) => ({ value: b.id, label: b.name + ' (' + b.label + ')' })), bases[0].id, 'data-ks-kb')) + UI.kv([['Folder', esc(folder.name)], ['Ready files here', ready]], 2), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add source', { kind: 'primary', attrs: 'data-ks-ok' }), onMount(m) {
      m.querySelector('[data-ks-ok]').addEventListener('click', async () => {
        const kb = m.querySelector('[data-ks-kb]').value; const b = bases.find((x) => x.id === kb);
        try {
          await App.post('/api/knowledge/bases/' + enc(kb) + '/sources', { kind: 'folder', location: folder.id });
          App.closeOverlay();
          ctx.toast('Source folder: ' + esc(folder.name) + ' added to ' + esc(b ? b.name : 'the knowledge base') + '. First sync queued.', 'ok');
          ctx.navigate('knowledge', { kb });
        } catch (err) { App.fail(err, 'Could not add the source'); }
      });
    } });
  }

  // ---------- upload ----------
  function labelChoices(st) {
    const ceil = st.data && st.data.workspace.labelCeiling;
    return LABELS.filter((l) => rank(l) <= rank(clearance()) && (!ceil || rank(l) <= rank(ceil)));
  }
  function openUpload(ctx, file) {
    const st = ctx.state;
    const curId = st.data && st.data.folder ? st.data.folder.id : '';
    const labels = labelChoices(st);
    const defLabel = file ? file.label : labels.indexOf('internal') >= 0 ? 'internal' : labels[labels.length - 1];
    const title = file ? 'New version of ' + esc(file.name) : 'Upload to ' + esc(curId ? st.data.folder.name : st.data.workspace.name);
    ctx.modal({ title, body: '<div class="formgrid">' + UI.field('File', '<input type="file" class="input" data-up-file>', 'Up to ' + fmtBytes(st.usage.maxUploadBytes) + '. Refused with 413 above that or over a storage quota, checked while the bytes arrive.')
      + (file ? '' : UI.field('File name', UI.input('', { placeholder: 'e.g. Q3 accruals.xlsx', attrs: 'data-up-name' }), 'Unique in its folder.'))
      + UI.field('Label', UI.select(labels, defLabel, 'data-up-label'), 'At most your clearance (' + esc(clearance()) + ') and the workspace ceiling. Checked again by the scan job.')
      + (file ? '' : UI.field('Folder', UI.select(folderOptions(st), curId, 'data-up-folder')))
      + '</div>' + UI.notice('The raw body is the file, streamed and sealed in 64 KiB AES-GCM segments under a key of its own, never buffered. The version is quarantined until the file.scan job detects the type from the bytes, classifies text, scans with ClamAV and checks the label.', 'info'),
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Upload', { kind: 'primary', icon: 'upload', attrs: 'data-up-ok' }), onMount(m) {
      const input = m.querySelector('[data-up-file]');
      const nameEl = m.querySelector('[data-up-name]');
      input.setAttribute('aria-label', 'File');
      input.addEventListener('change', () => { const f = input.files && input.files[0]; if (f && nameEl && !nameEl.value.trim()) nameEl.value = f.name; });
      const ok = m.querySelector('[data-up-ok]');
      ok.addEventListener('click', async () => {
        const blob = input.files && input.files[0];
        if (!blob) { ctx.toast('Choose a file to upload.', 'warn'); return; }
        const label = m.querySelector('[data-up-label]').value;
        let url;
        if (file) url = '/api/files/' + enc(file.id) + '/content?label=' + enc(label);
        else {
          const name = nameEl.value.trim() || blob.name; const folder = m.querySelector('[data-up-folder]').value;
          if (badName(name)) { ctx.toast('Names are 1 to 255 characters without / or \\ or control characters.', 'danger'); return; }
          url = '/api/files/uploads?name=' + enc(name) + '&label=' + enc(label) + (folder ? '&folder=' + enc(folder) : '');
        }
        if (blob.size > st.usage.maxUploadBytes) { App.closeOverlay(); st.problem = { title: 'Upload refused: too large', text: blob.name + ' is ' + fmtBytes(blob.size) + '; FILES_MAX_BYTES caps a single upload at ' + fmtBytes(st.usage.maxUploadBytes) + '. Nothing was sent.' }; ctx.rerender(); return; }
        ok.disabled = true; ok.textContent = 'Uploading…';
        try {
          const out = await putRaw(url, blob);
          App.closeOverlay();
          st.uploaded = { name: out.name, version: out.version.number }; st.problem = null; st.view = 'folder';
          st.folder = out.folderId || null; st.sel = out.id; st.query = ''; st.tagFilter = null; st.results = null;
          ctx.toast('202: ' + esc(out.name) + ' version ' + out.version.number + ' quarantined. Audited file.upload.received.');
          live.polls = 0; loadDetail(ctx, out.id); load(ctx, true);
        } catch (err) {
          ok.disabled = false; ok.textContent = 'Upload';
          const p = err.problem || {};
          if (err.status === 413) { App.closeOverlay(); st.problem = { title: p.limit === 'storage_bytes' ? 'Upload refused: storage quota' : 'Upload refused: too large', text: '413' + (p.limit === 'storage_bytes' ? ' {limit: storage_bytes, scope: ' + p.scope + ', used: ' + fmtBytes(p.used) + ', max: ' + fmtBytes(p.max) + ', incoming: ' + fmtBytes(p.incoming) + '}. ' : '. ') + (p.detail || '') + ' Nothing was stored.', trace: p.trace_id }; ctx.rerender(); return; }
          App.fail(err, 'Upload refused');
        }
      });
    } });
  }

  // ---------- alt text and version compare (1.8.0, B-142) ----------
  const isImage = (f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type || '');
  function altSection(f, w) {
    return '<div class="hstack"><div class="eyebrow grow">Alt text and description</div>' + (w ? UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-editalt aria-label="Edit alt text and description"' }) : '') + '</div>'
      + (f.altText ? '<div class="fg2" style="font-size:13px;overflow-wrap:anywhere" data-alt-text>' + esc(f.altText) + '</div>' : '<span class="muted" style="font-size:12px" data-alt-text>No alt text yet: screen readers hear the file name.</span>')
      + (f.description ? '<div class="muted" style="font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap">' + esc(f.description) + '</div>' : '')
      + (f.altText && f.altVersion && f.altVersion !== f.currentVersion ? '<span class="muted" style="font-size:11px">Written for version ' + esc(f.altVersion) + '; the picture may have changed since.</span>' : '')
      + '<span class="muted" style="font-size:11px">Downloads, previews and links serve this image without its EXIF, GPS and other metadata' + (f.owner ? '; as its owner you can download the original.' : '.') + '</span>';
  }

  function openAlt(ctx, f, refresh) {
    const canSuggest = App.can('inference:invoke') && App.can('chat:read');
    ctx.modal({ title: 'Alt text for ' + esc(f.name), cls: 'wide',
      body: UI.field('Alt text', UI.textarea(f.altText || '', { rows: 3, attrs: 'data-alt-in maxlength="1000"' }), 'What the picture shows, for people who cannot see it. The console uses it as the image\'s alt text. About 150 characters reads best; at most 1000.')
        + UI.field('Description', UI.textarea(f.description || '', { rows: 4, attrs: 'data-desc-in maxlength="4000"' }), 'Longer notes: credits, context, what to look for. Search finds the alt text and the description.')
        + (canSuggest ? '<div class="vstack gap6"><div class="hstack wrap gap6" style="align-items:flex-end">' + UI.field('Vision profile', UI.select([{ value: '', label: 'Loading profiles…' }], '', 'data-alt-profile')) + UI.btn('Suggest alt text', { attrs: 'data-alt-suggest', disabled: true }) + '</div><div data-alt-sugg aria-live="polite"></div></div>' : '')
        + '<div data-alt-err aria-live="polite"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-alt-ok' }),
      onMount(m) {
        const altIn = m.querySelector('[data-alt-in]'); const descIn = m.querySelector('[data-desc-in]'); const errEl = m.querySelector('[data-alt-err]');
        const sel = m.querySelector('[data-alt-profile]'); const sugBtn = m.querySelector('[data-alt-suggest]'); const sugOut = m.querySelector('[data-alt-sugg]');
        if (sel) {
          App.get('/api/chat/profiles').then((list) => {
            const vis = (list || []).filter((x) => x.vision);
            sel.innerHTML = vis.length ? vis.map((x) => '<option value="' + esc(x.name) + '">' + esc((x.displayName || x.name) + ' (' + x.model + ')') + '</option>').join('') : '<option value="">No profile with a vision model</option>';
            sugBtn.disabled = !vis.length;
          }).catch(() => { sel.innerHTML = '<option value="">Profiles could not be loaded</option>'; });
          sugBtn.addEventListener('click', async () => {
            if (!sel.value) return;
            sugBtn.disabled = true; sugOut.innerHTML = UI.notice('Asking ' + esc(sel.value) + '…', 'info');
            try {
              const r = await App.post('/api/files/' + enc(f.id) + '/alt-suggestion', { profile: sel.value });
              sugOut.innerHTML = UI.notice('<b>Suggestion</b> from ' + esc(r.model || r.profile) + ', not saved: read it, change it if it is wrong, then save. <span data-alt-sugtext style="display:block;margin-top:4px;overflow-wrap:anywhere">' + esc(r.suggestion) + '</span>', 'warn') + '<div>' + UI.btn('Use this suggestion', { size: 'sm', attrs: 'data-alt-use' }) + '</div>';
              sugOut.querySelector('[data-alt-use]').addEventListener('click', () => { altIn.value = r.suggestion; altIn.focus(); });
            } catch (err) { sugOut.innerHTML = UI.notice(esc(err.message || 'No suggestion'), 'danger'); }
            finally { sugBtn.disabled = false; }
          });
        }
        m.querySelector('[data-alt-ok]').addEventListener('click', async () => {
          errEl.innerHTML = '';
          const body = {}; const a = altIn.value.trim(); const dsc = descIn.value.trim();
          if (a !== (f.altText || '')) body.altText = a || null;
          if (dsc !== (f.description || '')) body.description = dsc || null;
          if (!Object.keys(body).length) { App.closeOverlay(); return; }
          try { await App.api('PUT', '/api/files/' + enc(f.id) + '/meta', body); App.closeOverlay(); ctx.toast('Alt text saved. Audited file.alt.updated' + ('description' in body ? ' and file.description.updated' : '') + '.', 'ok'); refresh(); }
          catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(err.message), 'danger'); }
        });
      } });
  }

  const DIFF_CSS = '.modal .files-diff{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:6px;max-height:420px;overflow:auto;font-family:var(--mono);font-size:12px;background:var(--panel)}'
    + '.modal .files-dl{display:grid;grid-template-columns:3.5em minmax(0,1fr);gap:6px;padding:0 6px;white-space:pre-wrap;overflow-wrap:anywhere}'
    + '.modal .files-dl.add{background:var(--ok-bg);color:var(--ok-fg)}.modal .files-dl.del{background:var(--danger-bg);color:var(--danger-fg)}.modal .files-dl.hunk{color:var(--muted);background:var(--panel2)}'
    + '.modal .files-dl .ln{color:inherit;opacity:.75;text-align:right}'
    + '.modal .files-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);border:1px solid var(--line);border-radius:6px;max-height:420px;overflow:auto;font-family:var(--mono);font-size:12px;background:var(--panel)}'
    + '.modal .files-split > div{padding:0 6px;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;border-left:1px solid var(--line)}.modal .files-split > div:nth-child(odd){border-left:0}'
    + '.modal .files-split .add{background:var(--ok-bg);color:var(--ok-fg)}.modal .files-split .del{background:var(--danger-bg);color:var(--danger-fg)}.modal .files-split .hd{font-family:var(--sans);font-weight:600;background:var(--panel2);color:var(--fg)}.modal .files-split .gap{color:var(--muted);background:var(--panel2)}'
    + '.modal .files-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:12px}.modal .files-pair figure{margin:0;display:flex;flex-direction:column;gap:4px;min-width:0}.modal .files-pair img{max-width:100%;height:auto;border-radius:6px;background:var(--sel)}';

  function unifiedHtml(d) {
    return '<div class="files-diff" role="region" aria-label="Changes from version ' + d.from.number + ' to ' + d.to.number + '" tabindex="0">' + d.hunks.map((h) => {
      let a = h.fromStart; let b = h.toStart;
      return '<div class="files-dl hunk"><span class="ln"></span><span>@@ version ' + d.from.number + ' line ' + h.fromStart + ', version ' + d.to.number + ' line ' + h.toStart + '</span></div>' + h.lines.map((l) => {
        const n = l.op === '+' ? b++ : l.op === '-' ? a++ : (b++, a++);
        return '<div class="files-dl' + (l.op === '+' ? ' add' : l.op === '-' ? ' del' : '') + '"><span class="ln">' + n + '</span><span>' + (l.op === '+' ? '+ ' : l.op === '-' ? '- ' : '  ') + esc(l.text) + '</span></div>';
      }).join('');
    }).join('') + '</div>';
  }

  function splitHtml(d) {
    const cells = ['<div class="hd">Version ' + d.from.number + '</div>', '<div class="hd">Version ' + d.to.number + '</div>'];
    d.hunks.forEach((h) => {
      cells.push('<div class="gap">line ' + h.fromStart + '</div>', '<div class="gap">line ' + h.toStart + '</div>');
      for (let i = 0; i < h.lines.length;) {
        if (h.lines[i].op === ' ') { const t = esc(h.lines[i].text); cells.push('<div>' + t + '</div>', '<div>' + t + '</div>'); i++; continue; }
        const del = []; const add = [];
        while (i < h.lines.length && h.lines[i].op === '-') del.push(h.lines[i++].text);
        while (i < h.lines.length && h.lines[i].op === '+') add.push(h.lines[i++].text);
        for (let k = 0; k < Math.max(del.length, add.length); k++) cells.push(k < del.length ? '<div class="del">- ' + esc(del[k]) + '</div>' : '<div></div>', k < add.length ? '<div class="add">+ ' + esc(add[k]) + '</div>' : '<div></div>');
      }
    });
    return '<div class="files-split" role="region" aria-label="Version ' + d.from.number + ' and version ' + d.to.number + ' side by side" tabindex="0">' + cells.join('') + '</div>';
  }

  function compareHtml(f, d, mode) {
    if (d.kind === 'image') {
      const fig = (v) => '<figure>' + (v.preview === 'ready' ? '<img src="/api/files/' + esc(f.id) + '/versions/' + esc(v.number) + '/preview" alt="' + esc((f.altText ? f.altText + ', ' : 'Preview of ' + f.name + ', ') + 'version ' + v.number) + '">' : '<div class="files-preview">No preview of version ' + esc(v.number) + ' (' + esc(previewText(v.preview)) + ').</div>') + '<figcaption class="muted" style="font-size:12px">Version ' + esc(v.number) + ', ' + esc(fmtBytes(v.size)) + ', ' + esc(typeName(v.type) || '') + '</figcaption></figure>';
      return (d.same ? UI.notice('The two versions are the same picture (the same bytes).', 'info') : '') + '<div class="files-pair">' + fig(d.from) + fig(d.to) + '</div>';
    }
    const sum = d.same ? UI.notice('No change in the text between version ' + d.from.number + ' and version ' + d.to.number + '.', 'info') : '<div class="muted" style="font-size:12px">' + d.added + ' line' + (d.added === 1 ? '' : 's') + ' added, ' + d.removed + ' removed' + (d.extracted ? ', compared by the text extracted from the documents' : '') + '.</div>';
    return sum + (d.truncated ? UI.notice('The changes are longer than shown here; download both versions for the rest.', 'warn') : '') + (d.same ? '' : mode === 'split' ? splitHtml(d) : unifiedHtml(d));
  }

  function openCompare(ctx, f, versions) {
    const ready = versions.filter((x) => x.state === 'ready').sort((a, b) => a.number - b.number);
    if (ready.length < 2) return;
    const opts = ready.map((x) => ({ value: String(x.number), label: 'Version ' + x.number + (x.number === f.currentVersion ? ' (current)' : '') + ', ' + when(x.createdAt) }));
    ctx.modal({ title: 'Compare versions of ' + esc(f.name), cls: 'wide',
      body: '<style>' + DIFF_CSS + '</style><div class="formgrid">' + UI.field('From', UI.select(opts, String(ready[ready.length - 2].number), 'data-cmp-from')) + UI.field('To', UI.select(opts, String(ready[ready.length - 1].number), 'data-cmp-to')) + UI.field('Show', UI.select([{ value: 'unified', label: 'One column' }, { value: 'split', label: 'Side by side' }], 'unified', 'data-cmp-mode')) + '</div>'
        + '<div class="muted" style="font-size:12px">Text, Markdown, CSV, JSON, HTML, PDF and Word files are compared line by line; images side by side. Audited file.versions.compared.</div><div data-cmp-out aria-live="polite" class="vstack gap6"></div>',
      actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Compare', { kind: 'primary', attrs: 'data-cmp-go' }),
      onMount(m) {
        const out = m.querySelector('[data-cmp-out]'); let last = null;
        const draw = () => { if (last) out.innerHTML = compareHtml(f, last, m.querySelector('[data-cmp-mode]').value); };
        const go = async () => {
          const a = m.querySelector('[data-cmp-from]').value; const b = m.querySelector('[data-cmp-to]').value;
          if (a === b) { last = null; out.innerHTML = UI.notice('Choose two different versions.', 'warn'); return; }
          out.innerHTML = UI.notice('Comparing…', 'info');
          try { last = await App.get('/api/files/' + enc(f.id) + '/compare?from=' + enc(a) + '&to=' + enc(b)); draw(); }
          catch (err) { last = null; out.innerHTML = err.status === 413 ? UI.notice('<b>Too large to compare.</b> ' + esc(err.message), 'warn') : UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(err.message), err.status === 415 ? 'warn' : 'danger'); }
        };
        m.querySelector('[data-cmp-go]').addEventListener('click', go);
        m.querySelector('[data-cmp-mode]').addEventListener('change', draw);
        go();
      } });
  }

  // ---------- inspector ----------
  function renderInspector(ctx, d) {
    const st = ctx.state;
    if (d.loading) return '<aside class="inspector w360" aria-label="File">' + UI.notice('Loading…', 'info') + '</aside>';
    if (d.error) return '<aside class="inspector w360" aria-label="File">' + UI.problem('The file could not be loaded', esc(d.error.message), d.error.problem && d.error.problem.trace_id) + '</aside>';
    const f = d.file; const versions = d.versions || []; const shares = d.shares || [];
    const cur = versions.find((x) => x.number === f.currentVersion);
    const rejected = versions.find((x) => x.state === 'rejected');
    const liveShares = shares.filter((s) => s.state === 'active').length;
    const w = canWrite();
    const vrows = versions.map((x) => ({ cells: ['<span class="num">' + x.number + '</span>' + (x.number === f.currentVersion ? ' ' + UI.pill('current', 'accent') : ''), statePill(x.state), '<span class="num">' + esc(fmtBytes(x.size)) + '</span>', UI.label(x.label, { sm: true }), '<span class="muted" style="font-size:11px">' + esc(when(x.createdAt)) + (x.restoredFrom ? ', restored from v' + x.restoredFrom : '') + '</span>', x.state === 'rejected' ? '<span style="color:var(--danger-fg);font-size:12px">' + esc(x.reason || 'rejected') + '</span>' : x.state === 'quarantined' || x.state === 'scanning' ? '<span class="muted" style="font-size:12px">scan pending</span>' : x.sha256 ? '<span class="mono" style="font-size:11px" title="' + esc(x.sha256) + '">' + esc(x.sha256.slice(0, 12)) + '…</span>' : '', '<span class="hstack gap4" style="justify-content:flex-end">' + (x.state === 'ready' ? UI.iconbtn('download', 'Download version ' + x.number, { attrs: 'data-dlver="' + x.number + '"', cls: 'sm ghost' }) : '') + (w && x.state === 'ready' && x.number !== f.currentVersion ? UI.iconbtn('undo', 'Restore version ' + x.number, { attrs: 'data-restorever="' + x.number + '"', cls: 'sm ghost' }) : '') + '</span>'] }));
    const who = (s) => s.kind === 'user' ? esc(s.userName || s.userId) : s.kind === 'group' ? esc(s.group) : s.kind === 'workspace' ? esc(s.workspaceName || s.workspaceId) : (s.anonymous ? 'Anonymous link' : 'Link');
    const srows = shares.map((s) => ({ cells: [UI.pill(s.kind, 'outline') + (s.anonymous ? ' ' + UI.pill('anonymous', 'warn') : ''), who(s), s.expiresAt ? esc(when(s.expiresAt)) : '<span class="muted">never</span>', s.maxUses ? '<span class="num">' + s.uses + ' of ' + s.maxUses + '</span>' : '<span class="num">' + s.uses + '</span>', shareState(s.state), '<span class="hstack" style="justify-content:flex-end">' + (w && s.state === 'active' ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-revokeshare="' + esc(s.id) + '"' }) : '') + '</span>'], attrs: 'data-share-row="' + esc(s.id) + '"' }));
    const preview = '<div class="files-preview">' + (f.preview === 'ready' ? '<img src="/api/files/' + esc(f.id) + '/preview?v=' + esc(f.currentVersion) + '" alt="' + esc(f.altText || 'Preview of ' + f.name) + '">' : f.preview === 'queued' ? 'Preview is being drawn by the file.preview job (ffmpeg or pdftoppm). 409 until ready.' : f.preview === 'unavailable' ? 'No preview: above FILES_PREVIEW_MAX_BYTES or the tool for ' + esc(typeName(f.type) || 'this type') + ' is not available. Download instead.' : f.preview === 'failed' ? 'Preview failed. Download instead.' : 'No preview for ' + esc(typeName(f.type) || 'this type') + '. Previews exist for images and the first page of a PDF.') + '</div>';
    const messagesOk = App.screens && App.screens.messages && App.canOpen('messages');
    return '<aside class="inspector w360" aria-label="File"><div class="hstack"><div class="eyebrow grow">File</div>' + UI.label(f.label, { sm: true }) + '</div><div class="files-name" style="font-size:15px">' + esc(f.name) + '</div>'
      + (st.rejectedNote && rejected ? UI.notice('<b>Version ' + rejected.number + ' rejected by the scan.</b> ' + esc(rejected.reason || '') + '. It is never served' + (f.currentVersion ? '; version ' + f.currentVersion + ' stays current' : '') + '. The uploader was told why (audited file.version.rejected).', 'danger') : '')
      + (st.linkNote && shares.some((s) => s.state === 'used up') ? UI.notice('<b>A link is used up.</b> Every use is taken. A reader now gets the same 404 as for an unknown token. Create a new link if the file should stay reachable.', 'warn') : '')
      + (st.previewNote && f.preview !== 'ready' ? UI.notice('<b>Preview unavailable.</b> ' + esc(typeName(f.type) || 'This file') + ' of ' + esc(fmtBytes(f.size)) + ' has no preview (' + esc(previewText(f.preview)) + '). The download is the only view.', 'info') : '')
      + preview
      + UI.kv([['Owner', esc(f.ownerName || '')], ['State', statePill(f.state)], ['Type', typePill(f.type)], ['Size', esc(fmtBytes(f.size))], ['Current version', f.currentVersion ? '<span class="num">' + f.currentVersion + '</span>' : '<span class="muted">none ready</span>'], ['Access', esc(f.access) + (liveShares ? ', ' + liveShares + ' live share' + (liveShares > 1 ? 's' : '') : '')], ['Preview', esc(previewText(f.preview))], ['sha256', cur && cur.sha256 ? '<span class="mono" style="font-size:11px" title="' + esc(cur.sha256) + '">' + esc(cur.sha256.slice(0, 16)) + '…</span>' : '<span class="muted">none</span>'], ['CID', f.cid ? '<span class="mono" style="font-size:11px;overflow-wrap:anywhere" title="CIDv1, raw codec, sha2-256: the CID an AT Protocol PDS gives these bytes as a blob">' + esc(f.cid) + '</span> ' + UI.iconbtn('copy', 'Copy the CID', { attrs: 'data-copycid', cls: 'sm ghost' }) : '<span class="muted">none yet</span>']], 2)
      + '<div class="hstack"><div class="eyebrow grow">Tags</div>' + (w ? UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-edittags aria-label="Edit tags"' }) : '') + '</div><div class="files-tags">' + ((f.tags || []).length ? f.tags.map((t) => UI.chip(esc(t), false, 'data-tag="' + esc(t) + '"')).join('') : '<span class="muted" style="font-size:12px">No tags. Up to 20 lower-case tags.</span>') + '</div>'
      + (isImage(f) ? altSection(f, w) : '')
      + '<div class="hstack wrap gap6">' + (editKind(f) ? UI.btn(w && f.access === 'workspace' ? 'Open and edit' : 'Open', { kind: 'primary', size: 'sm', icon: 'edit', attrs: 'data-openedit', disabled: !f.currentVersion }) : '') + UI.btn('Download', { kind: editKind(f) ? '' : 'primary', size: 'sm', icon: 'download', attrs: 'data-download', disabled: !f.currentVersion })
      + (TABLE_OK(f) ? UI.btn('New table query', { size: 'sm', icon: 'grid', attrs: 'data-newquery', disabled: !f.currentVersion }) : '')
      + (isImage(f) && f.owner ? UI.btn('Download original', { size: 'sm', kind: 'ghost', attrs: 'data-dlorig', disabled: !f.currentVersion }) : '')
      + (w ? UI.btn('New version', { size: 'sm', icon: 'upload', attrs: 'data-newversion' }) + UI.btn('Share', { size: 'sm', icon: 'link', attrs: 'data-share', disabled: f.state !== 'ready' }) + UI.btn('Rename or move', { size: 'sm', attrs: 'data-rename' }) + UI.btn('Duplicate', { size: 'sm', icon: 'copy', attrs: 'data-dupfile', disabled: f.state !== 'ready' }) + (App.filesLocations ? UI.btn('Send to…', { size: 'sm', kind: 'ghost', attrs: 'data-sendto', disabled: f.state !== 'ready' }) : '') : '')
      + (App.can('knowledge:read') && KNOWLEDGE_OK(f) ? UI.btn('Add to knowledge base', { size: 'sm', kind: 'ghost', icon: 'knowledge', attrs: 'data-addkb', disabled: f.state !== 'ready' }) : '')
      + (messagesOk ? UI.btn('Attach in Messages', { size: 'sm', kind: 'ghost', attrs: 'data-attach', disabled: f.state !== 'ready' }) : '')
      + (w ? UI.btn('Trash', { size: 'sm', kind: 'ghost', attrs: 'data-trashfile' }) : '') + '</div>'
      + '<div class="hstack"><div class="eyebrow grow">Versions, ' + versions.length + '</div>' + (versions.filter((x) => x.state === 'ready').length >= 2 ? UI.btn('Compare', { size: 'xs', kind: 'ghost', attrs: 'data-compare aria-label="Compare versions"' }) : '') + '</div>' + (d.versionsError ? UI.notice(esc(d.versionsError.message), 'warn') : UI.table(['v', 'State', 'Size', 'Label', 'Added', 'Scan', { label: '', right: true }], vrows, { clickable: false, minWidth: '0' }))
      + '<span class="muted" style="font-size:11px">Restoring writes the version again as a new one, which goes through quarantine and is scanned again. Only a ready version can be downloaded.</span>'
      + '<div class="eyebrow">Shares, ' + shares.length + '</div>' + (d.sharesError ? UI.notice(esc(d.sharesError.message), 'warn') : UI.table(['Kind', 'With', 'Expires', 'Uses', 'State', { label: '', right: true }], srows, { clickable: false, minWidth: '0', emptyTitle: 'Not shared', emptyText: 'Shared readers download the current version and its preview, nothing else.' }))
      + (d.groupGrants ? '<div class="eyebrow">Groups, ' + d.groupGrants.length + '</div>' + UI.table(['Group', 'Granted', { label: '', srLabel: 'Actions' }], d.groupGrants.map((g) => [esc(g.groupName || 'a group'), esc(when(g.createdAt)), w ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-revokegg="' + esc(g.id) + '" aria-label="Revoke the grant to ' + esc(g.groupName || 'the group') + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'No group reads it', emptyText: 'Share with a group (social): its members read the file while they are members.' }) : '')
      + (d.knowledge && d.knowledge.length ? '<div class="eyebrow">In knowledge bases, ' + d.knowledge.length + '</div>' + UI.table(['Base', 'Version', 'State', 'Added'], d.knowledge.map((k) => ['<a href="#" data-gokb="' + esc(k.kbId) + '">' + esc(k.kbName || 'a knowledge base') + '</a>' + (k.convertedTo ? '<div class="muted" style="font-size:11px">as ' + esc(k.convertedTo === 'text/csv' ? 'CSV' : 'Markdown') + '</div>' : ''), 'v' + esc(k.version) + (k.current ? '' : ' <span class="muted">(older)</span>'), UI.pill(k.documentState, k.documentState === 'indexed' ? 'ok' : k.documentState === 'removed' || k.documentState === 'rejected' ? 'danger' : 'warn'), esc(when(k.createdAt))]), { clickable: false, minWidth: '0' }) : '')
      // B-11203: plugin surfaces of the file slot, drawn after the screen renders.
      + '<div data-surfaces class="vstack gap12" style="display:none;flex-shrink:0"></div>'
      + '</aside>';
  }

  function wireInspector(ctx, d) {
    const st = ctx.state; const f = d.file;
    App.surfaces.attach(ctx.$('aside[aria-label="File"] [data-surfaces]'), { slot: 'file', context: { file: f.id } });
    const refresh = () => { loadDetail(ctx, f.id, true); load(ctx, true); };
    ctx.on('click', '[data-download]', () => { download('/api/files/' + enc(f.id) + '/content', f.name); ctx.toast('Downloading ' + esc(f.name) + ' (version ' + f.currentVersion + ') as an attachment with Content-Security-Policy: sandbox. Audited file.downloaded.', 'ok'); });
    ctx.on('click', '[data-dlver]', (e, t) => { download('/api/files/' + enc(f.id) + '/versions/' + enc(t.dataset.dlver) + '/content', f.name); ctx.toast('Downloading version ' + esc(t.dataset.dlver) + ' of ' + esc(f.name) + '. Audited file.downloaded.', 'ok'); });
    ctx.on('click', '[data-attach]', () => ctx.navigate('messages', { attach: f.id }));
    // 2.0.0: the editor, copies, knowledge bases and the content identifier.
    ctx.on('click', '[data-openedit]', () => ctx.navigate('file-edit', { file: f.id }));
    ctx.on('click', '[data-newquery]', () => ctx.navigate('file-query', { file: f.id }));
    ctx.on('click', '[data-dupfile]', () => duplicateFile(ctx, f));
    ctx.on('click', '[data-sendto]', () => App.filesLocations.sendTo(ctx, st, f));
    ctx.on('click', '[data-addkb]', () => addFileToKnowledge(ctx, f, refresh));
    ctx.on('click', '[data-gokb]', (e, t) => { e.preventDefault(); ctx.navigate('knowledge', { kb: t.dataset.gokb }); });
    ctx.on('click', '[data-copycid]', () => { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(f.cid).then(() => ctx.toast('CID copied.'), () => ctx.toast('The browser refused clipboard access.', 'warn')); else ctx.toast('The browser refused clipboard access.', 'warn'); });
    // 1.8.0 (B-142): the original with its metadata (owners only), version compare, alt text.
    ctx.on('click', '[data-dlorig]', () => { download('/api/files/' + enc(f.id) + '/content?original=1', f.name); ctx.toast('Downloading the original of ' + esc(f.name) + ', with its EXIF and location data. Audited file.downloaded.', 'ok'); });
    ctx.on('click', '[data-compare]', () => openCompare(ctx, f, d.versions || []));
    ctx.on('click', '[data-editalt]', () => openAlt(ctx, f, refresh));
    ctx.on('click', '[data-newversion]', () => openUpload(ctx, f));
    ctx.on('click', '[data-restorever]', async (e, t) => {
      const n = +t.dataset.restorever; const max = Math.max.apply(null, d.versions.map((x) => x.number));
      const ok = await ctx.confirm({ title: 'Restore version ' + n + ' of ' + esc(f.name), tone: 'info', body: '<p class="fg2" style="margin:0">Writes version ' + n + '\'s content again as a new version. It goes through quarantine and is <b>scanned again</b> before it becomes current (202).</p>', kv: [['Current', f.currentVersion ? 'v' + f.currentVersion : 'none'], ['Restore', 'v' + n], ['Becomes', 'v' + (max + 1)]], ok: 'Restore' });
      if (!ok) return;
      try { const out = await App.post('/api/files/' + enc(f.id) + '/versions/' + n + '/restore'); ctx.toast('202: version ' + out.version.number + ' queued from v' + n + '. Audited file.version.restore.requested.'); live.polls = 0; refresh(); }
      catch (err) { App.fail(err, 'Could not restore the version'); }
    });
    ctx.on('click', '[data-edittags]', () => ctx.modal({ title: 'Tags for ' + esc(f.name), body: UI.field('Tags', UI.input((f.tags || []).join(', '), { attrs: 'data-tg', placeholder: 'comma separated' }), 'Up to 20 lower-case tags of letters, digits, spaces, dots, dashes and underscores. Tags make a file findable in search.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save tags', { kind: 'primary', attrs: 'data-tg-ok' }), onMount(m) {
      m.querySelector('[data-tg-ok]').addEventListener('click', async () => {
        const tags = m.querySelector('[data-tg]').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
        if (tags.length > 20) { ctx.toast('At most 20 tags.', 'danger'); return; }
        try { await App.api('PUT', '/api/files/' + enc(f.id) + '/tags', { tags }); App.closeOverlay(); ctx.toast('Tags saved. Audited file.tags.updated.', 'ok'); refresh(); }
        catch (err) { App.fail(err, 'Could not save the tags'); }
      });
    } }));
    ctx.on('click', '[data-rename]', () => ctx.modal({ title: 'Rename or move ' + esc(f.name), body: '<div class="formgrid">' + UI.field('Name', UI.input(f.name, { attrs: 'data-rn-name' })) + UI.field('Folder', UI.select(folderOptions(st), f.folderId || '', 'data-rn-folder'), 'Within the workspace. Shares and versions move with the file.') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-rn-ok' }), onMount(m) {
      m.querySelector('[data-rn-ok]').addEventListener('click', async () => {
        const name = m.querySelector('[data-rn-name]').value.trim(); const fid = m.querySelector('[data-rn-folder]').value || null;
        if (badName(name)) { ctx.toast('Names are 1 to 255 characters without / or \\ or control characters.', 'danger'); return; }
        const patch = {}; if (name !== f.name) patch.name = name; if (fid !== (f.folderId || null)) patch.folderId = fid;
        if (!Object.keys(patch).length) { App.closeOverlay(); return; }
        try { const out = await App.patch('/api/files/' + enc(f.id), patch); App.closeOverlay(); st.folder = out.folderId || null; ctx.toast('File saved. Audited file.changed.', 'ok'); refresh(); }
        catch (err) { App.fail(err, 'Could not save the file'); }
      });
    } }));
    ctx.on('click', '[data-trashfile]', async () => {
      const ok = await ctx.confirm({ title: 'Move ' + esc(f.name) + ' to the trash', tone: 'danger', body: '<p class="fg2" style="margin:0">Its shares stop working while it is in the trash. It is purged ' + st.usage.trashDays + ' days later unless restored.</p>', kv: [['Versions', (d.versions || []).length], ['Live shares', (d.shares || []).filter((s) => s.state === 'active').length]], ok: 'Trash' });
      if (!ok) return;
      try { await App.del('/api/files/' + enc(f.id)); st.sel = null; st.detail = null; st.trash = null; ctx.toast(esc(f.name) + ' moved to the trash. Audited file.trashed; event file.deleted.', 'warn'); load(ctx, true); }
      catch (err) { App.fail(err, 'Could not trash the file'); }
    });
    ctx.on('click', '[data-revokeshare]', async (e, t) => {
      const s = d.shares.find((x) => x.id === t.dataset.revokeshare); if (!s) return;
      const ok = await ctx.confirm({ title: 'Revoke this share', tone: 'danger', body: '<p class="fg2" style="margin:0">Revokes at once (204). ' + (s.kind === 'link' ? 'Anyone holding the link gets the same 404 as for an unknown token.' : 'They lose access on their next request.') + '</p>', kv: [['Kind', esc(s.kind)], ['Uses', s.uses]], ok: 'Revoke' });
      if (!ok) return;
      try { await App.del('/api/files/' + enc(f.id) + '/shares/' + enc(s.id)); ctx.toast('Share revoked. Audited file.share.revoked.', 'ok'); refresh(); }
      catch (err) { App.fail(err, 'Could not revoke the share'); }
    });
    ctx.on('click', '[data-share]', () => openShare(ctx, f));
    ctx.on('click', '[data-revokegg]', async (e, t) => {
      const g = (d.groupGrants || []).find((x) => x.id === t.dataset.revokegg); if (!g) return;
      const ok = await ctx.confirm({ title: 'Revoke the grant to ' + esc(g.groupName || 'the group'), tone: 'danger', body: '<p class="fg2" style="margin:0">The group\'s members lose access to ' + esc(f.name) + ' at once, unless another share or grant covers them. Audited file.group-grant.revoked.</p>', ok: 'Revoke' });
      if (!ok) return;
      try { await App.del('/api/files/group-grants/' + enc(g.id)); ctx.toast('Grant revoked. Audited file.group-grant.revoked.', 'ok'); refresh(); } catch (err) { App.fail(err, 'Could not revoke the grant'); }
    });
  }

  async function openShare(ctx, f) {
    let users = null;
    const groups = await groupsOf(ctx.state);
    if (App.can('users:manage')) { try { users = (await App.get('/api/admin/users?limit=500')).filter((u) => u.state === 'active' && (!App.me || u.id !== App.me.user.id)); } catch (err) { users = null; } }
    const wsList = ((App.me && App.me.workspaces) || []).filter((x) => x.id !== f.workspaceId);
    const kinds = [{ value: 'user', label: 'A person' }, { value: 'group', label: 'A directory group' }, { value: 'social_group', label: 'Group (social)' }, { value: 'workspace', label: 'A workspace' }, { value: 'link', label: 'A link' }];
    const sub = (k) => k === 'user' ? (users ? UI.field('Person', UI.select(users.map((u) => ({ value: u.id, label: (u.displayName || u.username) + ' (' + u.clearance + ')' })), users.length ? users[0].id : '', 'data-sh-user'), 'Must be cleared for the file\'s label (' + esc(f.label) + ').') : UI.field('User id', UI.input('', { attrs: 'data-sh-userid', placeholder: '26-character user id' }), 'The person\'s user id. They must be cleared for the file\'s label (' + esc(f.label) + ').'))
      : k === 'group' ? UI.field('Group', UI.input('', { attrs: 'data-sh-group', placeholder: 'cn=finance-leads' }), 'A directory group, as the reader\'s identities carried it at sign-in or sync.')
      : k === 'social_group' ? (groups.length ? UI.field('Group', UI.select(groups.map((g) => ({ value: g.id, label: g.name })), groups[0].id, 'data-sh-sgroup'), 'Its members read the file while they are members and cleared for its label (' + esc(f.label) + '). The group\'s workspace ceiling must cover the label.') : UI.notice('You can see no group to share with.', 'info'))
      : k === 'workspace' ? (wsList.length ? UI.field('Workspace', UI.select(wsList.map((x) => ({ value: x.id, label: x.name + ' (ceiling ' + x.label + ')' })), wsList[0].id, 'data-sh-ws'), 'The workspace\'s ceiling must cover the file\'s label.') : UI.notice('You belong to no other workspace to share with.', 'info'))
      : '<div class="formgrid" style="--cols:3">' + UI.field('Expires in (hours)', UI.input(168, { type: 'number', attrs: 'data-sh-hours min="1" max="720"' })) + UI.field('Max uses', UI.input('', { type: 'number', attrs: 'data-sh-uses min="1"' }), 'Empty for unlimited.') + UI.field('Anonymous', UI.select(['no', 'yes'], 'no', 'data-sh-anon'), 'Only a public file, while the tenant allows anonymous links, within its maximum lifetime.') + '</div>' + UI.notice('The token exf_… is shown once and stored as an HMAC. A link past its use limit, expired or revoked is refused with the same 404 as an unknown token.', 'info');
    ctx.modal({ title: 'Share ' + esc(f.name), body: UI.field('Share with', UI.select(kinds, 'user', 'data-sh-kind')) + '<div data-sh-sub>' + sub('user') + '</div><div class="muted" style="font-size:12px">Read-only: the reader downloads the current version and its preview, nothing else.</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create share', { kind: 'primary', attrs: 'data-sh-ok' }), onMount(m) {
      m.querySelector('[data-sh-kind]').addEventListener('change', (e) => { m.querySelector('[data-sh-sub]').innerHTML = sub(e.target.value); });
      m.querySelector('[data-sh-ok]').addEventListener('click', async () => {
        const k = m.querySelector('[data-sh-kind]').value; let body;
        if (k === 'user') { const el = m.querySelector('[data-sh-user]') || m.querySelector('[data-sh-userid]'); const v = el ? el.value.trim() : ''; if (!v) { ctx.toast('Choose a person.', 'warn'); return; } body = { kind: 'user', userId: v }; }
        else if (k === 'group') { const g = m.querySelector('[data-sh-group]').value.trim(); if (!g) { ctx.toast('Name a directory group.', 'warn'); return; } body = { kind: 'group', group: g }; }
        else if (k === 'workspace') { const el = m.querySelector('[data-sh-ws]'); if (!el) return; body = { kind: 'workspace', workspaceId: el.value }; }
        else if (k === 'social_group') {
          const el = m.querySelector('[data-sh-sgroup]'); if (!el) return;
          try { const out = await App.post('/api/files/' + enc(f.id) + '/group-grants', { groupId: el.value }); App.closeOverlay(); ctx.toast('Shared with ' + esc(out.groupName || 'the group') + '. Audited file.group-grant.created.', 'ok'); loadDetail(ctx, f.id, true); }
          catch (err) { App.fail(err, 'Could not share the file'); }
          return;
        }
        else { const hours = parseInt(m.querySelector('[data-sh-hours]').value, 10) || 168; const uses = parseInt(m.querySelector('[data-sh-uses]').value, 10); body = { kind: 'link', expiresInHours: hours, maxUses: uses > 0 ? uses : null, anonymous: m.querySelector('[data-sh-anon]').value === 'yes' }; }
        try {
          const s = await App.post('/api/files/' + enc(f.id) + '/shares', body);
          App.closeOverlay();
          ctx.toast('Share created (201). Audited file.share.created; event file.shared.', 'ok');
          if (s.token) {
            ctx.modal({ title: 'Link created', body: UI.notice('<b>Copy the token now; it is shown once.</b><div class="mono" data-link-token style="margin-top:4px;overflow-wrap:anywhere">' + esc(s.token) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copy' })) + '<p class="fg2" style="margin:0;font-size:13px">' + (s.anonymous ? 'Anyone holding it can download the file without signing in, through the public link route.' : 'A signed-in reader of this tenant, cleared for the file, opens it from Files, Shared with me, Open a link.') + '</p>' + UI.kv([['Expires', esc(when(s.expiresAt))], ['Max uses', s.maxUses || 'unlimited'], ['Anonymous', s.anonymous ? 'yes (public file)' : 'no: signed in, same tenant, cleared']], 3), actions: UI.btn('Done', { kind: 'primary', attrs: 'data-close' }), onMount(mm) { mm.querySelector('[data-copy]').addEventListener('click', () => { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s.token).then(() => ctx.toast('Copied.'), () => ctx.toast('The browser refused clipboard access.', 'warn')); else ctx.toast('The browser refused clipboard access.', 'warn'); }); }, onClose() { setTimeout(() => { loadDetail(ctx, f.id, true); }, 0); } });
          } else loadDetail(ctx, f.id, true);
        } catch (err) { App.fail(err, 'Could not share the file'); }
      });
    } });
  }

  // 1.7.0 (B-9802): a folder read by social groups; a grant reaches its files and subfolders.
  async function folderGroups(ctx, folder) {
    const st = ctx.state;
    let groups; let grants;
    try { [groups, grants] = await Promise.all([groupsOf(st), App.get('/api/files/folders/' + enc(folder.id) + '/group-grants')]); } catch (err) { App.fail(err, 'Could not read the folder\'s groups'); return; }
    const free = () => groups.filter((g) => !grants.some((x) => x.groupId === g.id));
    const listHtml = () => UI.table(['Group', 'Granted', { label: '', srLabel: 'Actions' }], grants.map((g) => [esc(g.groupName || groupName(st, g.groupId) || 'a group'), esc(when(g.createdAt)), UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-fg-revoke="' + esc(g.id) + '" aria-label="Revoke the grant to ' + esc(g.groupName || 'the group') + '"' })]), { clickable: false, minWidth: '0', emptyTitle: 'No group reads this folder', emptyText: 'Grant a group below.' })
      + (free().length ? '<div class="hstack wrap gap6 files-fg-add">' + UI.select(free().map((g) => ({ value: g.id, label: g.name })), free()[0].id, 'data-fg-group aria-label="Group to grant"') + UI.btn('Grant', { kind: 'primary', size: 'sm', attrs: 'data-fg-add' }) + '</div>' : UI.notice(groups.length ? 'Every group you can see already reads this folder.' : 'You can see no group to share with.', 'info'));
    ctx.modal({ title: 'Share ' + esc(folder.name) + ' with a group', body: '<p class="fg2" style="margin:0">Members of a granted group read every file in the folder and its subfolders, read-only, within their clearance. Nothing else changes for them.</p><div data-fg-list>' + listHtml() + '</div>', actions: UI.btn('Done', { attrs: 'data-close' }), onMount(m) {
      const redraw = () => { m.querySelector('[data-fg-list]').innerHTML = listHtml(); };
      m.addEventListener('click', async (e) => {
        const add = e.target.closest('[data-fg-add]'); const rev = e.target.closest('[data-fg-revoke]');
        if (add) {
          const gid = m.querySelector('[data-fg-group]').value;
          try { const out = await App.post('/api/files/folders/' + enc(folder.id) + '/group-grants', { groupId: gid }); grants = grants.concat([out]); ctx.toast('Folder ' + esc(folder.name) + ' shared with ' + esc(out.groupName || 'the group') + '. Audited file.group-grant.created.', 'ok'); redraw(); }
          catch (err) { App.fail(err, 'Could not share the folder'); }
        } else if (rev) {
          const id = rev.dataset.fgRevoke;
          try { await App.del('/api/files/group-grants/' + enc(id)); grants = grants.filter((x) => x.id !== id); ctx.toast('Grant revoked. Audited file.group-grant.revoked.', 'ok'); redraw(); }
          catch (err) { App.fail(err, 'Could not revoke the grant'); }
        }
      });
    } });
  }

  // ---------- documents, copies, knowledge and bulk actions (2.0.0) ----------
  function newDocument(ctx, kind) {
    const st = ctx.state;
    const k = NEW_KINDS.find((x) => x[0] === kind) || NEW_KINDS[0];
    const curId = st.data && st.data.folder ? st.data.folder.id : '';
    const labels = labelChoices(st);
    const defLabel = labels.indexOf('internal') >= 0 ? 'internal' : labels[labels.length - 1];
    const sheet = kind === 'csv' || kind === 'xlsx' || kind === 'ods';
    ctx.modal({ title: 'New ' + esc(k[1]), body: '<div class="formgrid">'
      + UI.field('Kind', UI.select(NEW_KINDS.map((x) => ({ value: x[0], label: x[1] + ' (' + x[2] + ')' })), k[0], 'data-nd-kind'))
      + UI.field('Name', UI.input('', { placeholder: 'e.g. Meeting notes', attrs: 'data-nd-name' }), 'The extension is added when missing. Unique in its folder.')
      + UI.field('Label', UI.select(labels, defLabel, 'data-nd-label'), 'At most your clearance (' + esc(clearance()) + ') and the workspace ceiling.')
      + UI.field('Folder', UI.select(folderOptions(st), curId, 'data-nd-folder'))
      + '<div data-nd-cols' + (sheet ? '' : ' hidden') + '>' + UI.field('Columns', UI.input('Name, Amount:number, Due:date', { attrs: 'data-nd-columns' }), 'Comma separated; add :type for number, integer, date, datetime, boolean, email or url. You can change them in the editor.') + '</div>'
      + '</div>' + UI.notice('The new file is scanned like an upload, then it opens in the editor. Every save is a new version.', 'info'),
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create and open', { kind: 'primary', attrs: 'data-nd-ok' }), onMount(m) {
      const kindEl = m.querySelector('[data-nd-kind]');
      kindEl.addEventListener('change', () => { m.querySelector('[data-nd-cols]').hidden = ['csv', 'xlsx', 'ods'].indexOf(kindEl.value) < 0; });
      const ok = m.querySelector('[data-nd-ok]');
      const go = async () => {
        const kd = kindEl.value; const name = m.querySelector('[data-nd-name]').value.trim();
        if (badName(name)) { ctx.toast('Names are 1 to 255 characters without / or \\ or control characters.', 'danger'); return; }
        const body = { name, kind: kd, label: m.querySelector('[data-nd-label]').value };
        const folder = m.querySelector('[data-nd-folder]').value; if (folder) body.folderId = folder;
        if (['csv', 'xlsx', 'ods'].indexOf(kd) >= 0) {
          const cols = m.querySelector('[data-nd-columns]').value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200).map((x) => { const i = x.lastIndexOf(':'); const t = i > 0 ? x.slice(i + 1).trim().toLowerCase() : 'text'; return { name: (i > 0 ? x.slice(0, i) : x).trim(), type: ['text', 'number', 'integer', 'date', 'datetime', 'boolean', 'email', 'url'].indexOf(t) >= 0 ? t : 'text' }; });
          if (cols.length) body.workbook = { sheets: [{ name: 'Sheet1', header: true, columns: cols, rows: [cols.map((c) => ({ v: c.name, b: kd !== 'csv' }))] }] };
        }
        ok.disabled = true; ok.textContent = 'Creating…';
        try {
          const out = await App.post('/api/files/documents', body);
          App.closeOverlay();
          ctx.toast(esc(out.name) + ' created. Audited file.document.created.', 'ok');
          ctx.navigate('file-edit', { file: out.id });
        } catch (err) { ok.disabled = false; ok.textContent = 'Create and open'; App.fail(err, 'Could not create the document'); }
      };
      ok.addEventListener('click', go);
      m.querySelector('[data-nd-name]').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    } });
  }

  function duplicateFile(ctx, f) {
    const st = ctx.state;
    const dot = f.name.lastIndexOf('.');
    const suggested = dot > 0 ? f.name.slice(0, dot) + ' copy' + f.name.slice(dot) : f.name + ' copy';
    ctx.modal({ title: 'Duplicate ' + esc(f.name), body: '<div class="formgrid">' + UI.field('Name', UI.input(suggested, { attrs: 'data-dp-name' })) + UI.field('Folder', UI.select(folderOptions(st), f.folderId || '', 'data-dp-folder'), 'Within the workspace.') + '</div><p class="fg2" style="margin:0;font-size:13px">The current version is copied as version 1 of a new file you own, with its tags. It is scanned like an upload. Shares and older versions are not copied.</p>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Duplicate', { kind: 'primary', attrs: 'data-dp-ok' }), onMount(m) {
      m.querySelector('[data-dp-ok]').addEventListener('click', async () => {
        const name = m.querySelector('[data-dp-name]').value.trim(); const folder = m.querySelector('[data-dp-folder]').value || null;
        if (badName(name)) { ctx.toast('Names are 1 to 255 characters without / or \\ or control characters.', 'danger'); return; }
        try { const out = await App.post('/api/files/' + enc(f.id) + '/duplicate', { name, folderId: folder }); App.closeOverlay(); st.folder = out.folderId || null; st.sel = out.id; ctx.toast(esc(out.name) + ' created (202). Audited file.duplicated.', 'ok'); live.polls = 0; loadDetail(ctx, out.id); load(ctx, true); }
        catch (err) { App.fail(err, 'Could not duplicate the file'); }
      });
    } });
  }

  function copyFolder(ctx, folder) {
    const st = ctx.state;
    ctx.modal({ title: 'Copy ' + esc(folder.name), body: '<div class="formgrid">' + UI.field('Name', UI.input(folder.name + ' copy', { attrs: 'data-cf-name' })) + UI.field('Into', UI.select(folderOptions(st, folder.id), folder.parentId || '', 'data-cf-parent'), 'Within the workspace, not into itself.') + '</div><p class="fg2" style="margin:0;font-size:13px">Copies the folder, its subfolders and the ready files in them you are cleared for (up to 500 files). Each copied file is scanned like an upload.</p>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Copy folder', { kind: 'primary', attrs: 'data-cf-ok' }), onMount(m) {
      const ok = m.querySelector('[data-cf-ok]');
      ok.addEventListener('click', async () => {
        const name = m.querySelector('[data-cf-name]').value.trim(); const parent = m.querySelector('[data-cf-parent]').value || null;
        if (badName(name)) { ctx.toast('Names are 1 to 255 characters without / or \\ or control characters.', 'danger'); return; }
        ok.disabled = true; ok.textContent = 'Copying…';
        try {
          const out = await App.post('/api/files/folders/' + enc(folder.id) + '/duplicate', { name, parentId: parent });
          App.closeOverlay(); st.kids = {};
          ctx.toast('Copied as ' + esc(out.name) + ': ' + out.files + ' file' + (out.files === 1 ? '' : 's') + ', ' + out.folders + ' folder' + (out.folders === 1 ? '' : 's') + (out.skipped ? ', ' + out.skipped + ' left out (not ready or above your clearance)' : '') + '. Audited file.folder.duplicated.', 'ok', 6000);
          st.folder = out.id; load(ctx, true);
        } catch (err) { ok.disabled = false; ok.textContent = 'Copy folder'; App.fail(err, 'Could not copy the folder'); }
      });
    } });
  }

  async function addFileToKnowledge(ctx, f, refresh) {
    let bases;
    try { bases = (await App.get('/api/knowledge/bases')).filter((b) => b.access === 'manage' && rank(b.label) >= rank(f.label)); } catch (err) { App.fail(err, 'Could not list knowledge bases'); return; }
    if (!bases.length) { ctx.toast('No knowledge base you curate takes ' + esc(f.label) + ' documents. A knowledge curator adds files to bases.', 'warn'); return; }
    const k = editKind(f); const conv = k === 'odt' ? 'Markdown' : k === 'xlsx' || k === 'ods' ? 'CSV (or Markdown tables for several sheets)' : null;
    ctx.modal({ title: 'Add ' + esc(f.name) + ' to a knowledge base', body: UI.field('Knowledge base', UI.select(bases.map((b) => ({ value: b.id, label: b.name + ' (' + b.label + ')' })), bases[0].id, 'data-ak-kb'), 'Bases you curate that hold ' + esc(f.label) + ' documents.') + UI.field('Categories', UI.input('', { attrs: 'data-ak-cats', placeholder: 'finance/reports, policies' }), 'Optional, comma separated paths.') + (conv ? UI.notice('The knowledge pipeline does not read ' + esc(typeName(f.type)) + ' files: version ' + esc(f.currentVersion) + ' is sent as ' + conv + '.', 'info') : '') + '<p class="fg2" style="margin:0;font-size:13px">The current version is scanned and classified again, then indexed. Later versions are not sent by themselves: add the file again to send a newer one.</p>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add', { kind: 'primary', attrs: 'data-ak-ok' }), onMount(m) {
      m.querySelector('[data-ak-ok]').addEventListener('click', async () => {
        const kb = m.querySelector('[data-ak-kb]').value; const cats = m.querySelector('[data-ak-cats]').value.split(',').map((x) => x.trim()).filter(Boolean);
        try { const out = await App.post('/api/files/' + enc(f.id) + '/knowledge', cats.length ? { kbId: kb, categories: cats } : { kbId: kb }); App.closeOverlay(); ctx.toast(esc(out.document.name) + ' added to ' + esc(out.kb.name) + ' (' + esc(out.document.state) + '). Audited knowledge.uploaded.', 'ok', 6000); refresh(); }
        catch (err) { App.fail(err, 'Could not add the file'); }
      });
    } });
  }

  function bulkBar(ctx, files) {
    const st = ctx.state; st.picked = st.picked || {};
    if (!canWrite()) return '';
    const ids = files.map((f) => f.id).filter((id) => st.picked[id]);
    if (!ids.length) return '';
    return '<div class="hstack wrap gap6" role="group" aria-label="Selected files" style="padding:8px 10px;border:1px solid var(--accent);border-radius:8px;background:var(--accent-tint)"><b style="font-size:13px">' + ids.length + ' selected</b>'
      + UI.btn('Move', { size: 'sm', attrs: 'data-bulk="move"' }) + UI.btn('Copy', { size: 'sm', attrs: 'data-bulk="copy"' }) + UI.btn('Add tags', { size: 'sm', attrs: 'data-bulk="tag"' }) + UI.btn('Trash', { size: 'sm', kind: 'ghost', attrs: 'data-bulk="trash"' }) + UI.btn('Clear selection', { size: 'sm', kind: 'ghost', attrs: 'data-bulk="clear"' }) + '</div>';
  }

  function wireBulk(ctx) {
    const st = ctx.state; st.picked = st.picked || {};
    ctx.on('change', '[data-pick]', (e, t) => { if (t.checked) st.picked[t.dataset.pick] = true; else delete st.picked[t.dataset.pick]; rerender(ctx); });
    ctx.on('click', '[data-bulk]', async (e, t) => {
      const visible = ((st.query || st.tagFilter ? st.results : st.data && st.data.files) || []);
      const sel = visible.filter((f) => st.picked[f.id]);
      const op = t.dataset.bulk;
      if (op === 'clear') { st.picked = {}; rerender(ctx); return; }
      if (!sel.length) return;
      const run = async (label, each) => {
        let ok = 0; const failed = [];
        for (const f of sel) { try { await each(f); ok++; } catch (err) { failed.push(f.name + ': ' + err.message); } }
        st.picked = {}; ctx.toast(label + ': ' + ok + ' of ' + sel.length + ' done.' + (failed.length ? ' ' + esc(failed.slice(0, 3).join('; ')) : ''), failed.length ? 'warn' : 'ok', 7000);
        live.polls = 0; load(ctx, true);
      };
      if (op === 'trash') {
        const yes = await ctx.confirm({ title: 'Move ' + sel.length + ' file' + (sel.length === 1 ? '' : 's') + ' to the trash', tone: 'danger', body: '<p class="fg2" style="margin:0">Their shares stop working while they are in the trash. They are purged ' + st.usage.trashDays + ' days later unless restored.</p>', ok: 'Trash' });
        if (yes) { if (sel.some((f) => f.id === st.sel)) { st.sel = null; st.detail = null; } st.trash = null; run('Trashed', (f) => App.del('/api/files/' + enc(f.id))); }
        return;
      }
      if (op === 'tag') {
        ctx.modal({ title: 'Add tags to ' + sel.length + ' file' + (sel.length === 1 ? '' : 's'), body: UI.field('Tags', UI.input('', { attrs: 'data-bt', placeholder: 'comma separated' }), 'Added to each file\'s tags (up to 20 per file).'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add tags', { kind: 'primary', attrs: 'data-bt-ok' }), onMount(m) {
          m.querySelector('[data-bt-ok]').addEventListener('click', () => {
            const add = m.querySelector('[data-bt]').value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
            if (!add.length) return;
            App.closeOverlay();
            run('Tagged', (f) => { const tags = (f.tags || []).concat(add).filter((x, i, a) => a.indexOf(x) === i).slice(0, 20); return App.api('PUT', '/api/files/' + enc(f.id) + '/tags', { tags }); });
          });
        } });
        return;
      }
      const move = op === 'move';
      ctx.modal({ title: (move ? 'Move ' : 'Copy ') + sel.length + ' file' + (sel.length === 1 ? '' : 's'), body: UI.field('To folder', UI.select(folderOptions(st), st.folder || '', 'data-bm-folder'), 'Within the workspace. ' + (move ? 'Shares and versions move with each file.' : 'Each copy is scanned like an upload; a clashing name gets " (2)".')), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(move ? 'Move' : 'Copy', { kind: 'primary', attrs: 'data-bm-ok' }), onMount(m) {
        m.querySelector('[data-bm-ok]').addEventListener('click', () => {
          const folder = m.querySelector('[data-bm-folder]').value || null;
          App.closeOverlay();
          run(move ? 'Moved' : 'Copied', (f) => move ? App.patch('/api/files/' + enc(f.id), { folderId: folder }) : App.post('/api/files/' + enc(f.id) + '/duplicate', { folderId: folder }));
        });
      } });
    });
  }

  // ---------- trash ----------
  function renderTrash(ctx) {
    const st = ctx.state; const t = st.trash;
    const head = UI.pagehead('Trash', 'What was put in the trash on its own, within your clearance. Items are purged ' + st.usage.trashDays + ' days after they were trashed; the files.purge job also runs every FILES_PURGE_MINUTES. A file taken down by a moderation decision is not listed here: only that decision, or an appeal of it, brings it back.', canWrite() ? UI.btn('Empty trash', { kind: 'danger', icon: 'trash', attrs: 'data-emptytrash', disabled: !t || !(t.files.length + t.folders.length) }) : '');
    if (!t) return head + UI.notice('Loading…', 'info');
    const wasIn = (pid) => (pid ? (st.names[pid] ? esc(st.names[pid]) : '<span class="muted">a folder</span>') : esc(st.names[''] || 'Workspace root'));
    const items = t.folders.map((x) => ({ kind: 'folder', x })).concat(t.files.map((x) => ({ kind: 'file', x }))).sort((a, b) => (b.x.trashedAt || 0) - (a.x.trashedAt || 0));
    const rows = items.map((it) => ({ cells: [UI.icon(it.kind === 'folder' ? 'files' : 'runs', 14) + ' <span style="font-weight:600">' + esc(it.x.name) + '</span>', UI.pill(it.kind, 'outline'), wasIn(it.kind === 'folder' ? it.x.parentId : it.x.folderId), it.kind === 'file' ? '<span class="num">' + esc(fmtBytes(it.x.size)) + '</span>' : '<span class="muted">with contents</span>', it.kind === 'file' ? UI.label(it.x.label, { sm: true }) : '', esc(when(it.x.trashedAt)), esc(when(it.x.purgeAfter)), '<span class="hstack" style="justify-content:flex-end">' + (canWrite() ? UI.btn('Restore', { size: 'xs', attrs: 'data-restore="' + esc(it.x.id) + '" data-kind="' + it.kind + '" aria-label="Restore ' + esc(it.x.name) + '"' }) : '') + '</span>'], attrs: 'data-trash-row="' + esc(it.x.id) + '"' }));
    return head
      + (st.restoredNote ? UI.notice(st.restoredNote, 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearrestored' })) : '')
      + UI.table(['Name', 'Kind', 'Was in', 'Size', 'Label', 'Trashed', 'Purged after', { label: '', right: true }], rows, { clickable: false, minWidth: '760px', emptyTitle: 'The trash is empty', emptyText: 'Trashed files and folders wait here until they are purged or restored.' })
      + '<span class="muted" style="font-size:12px">A file that went to the trash with its folder is restored with the folder, not on its own (409). Trash counts against storage until purged.</span>';
  }
  function wireTrash(ctx) {
    const st = ctx.state;
    ctx.on('click', '[data-restore]', async (e, t) => {
      const kind = t.dataset.kind; const list = kind === 'folder' ? st.trash.folders : st.trash.files; const item = list.find((x) => x.id === t.dataset.restore); if (!item) return;
      const ok = await ctx.confirm({ title: 'Restore ' + esc(item.name), tone: 'info', body: '<p class="fg2" style="margin:0">Restores it with what went with it, to where it was; to the workspace root when its folder is gone. A clashing name gets " (2)".</p>', kv: [['Kind', kind]].concat(kind === 'file' ? [['Size', fmtBytes(item.size)]] : []), ok: 'Restore' });
      if (!ok) return;
      try {
        const out = await App.post('/api/files/trash/restore', { kind, id: item.id });
        st.restoredNote = '<b>' + esc(item.name) + ' restored</b>' + (out.name !== item.name ? ' as ' + esc(out.name) + ' because the name clashed' : '') + (kind === 'folder' ? ' with ' + out.files + ' file' + (out.files === 1 ? '' : 's') : '') + '. Audited file.' + (kind === 'folder' ? 'folder.untrashed' : 'untrashed') + '.';
        st.kids = {}; ctx.toast(esc(out.name) + ' restored.', 'ok', 5000); load(ctx, true);
      } catch (err) { App.fail(err, 'Could not restore'); }
    });
    ctx.on('click', '[data-clearrestored]', () => { st.restoredNote = null; ctx.rerender(); });
    ctx.on('click', '[data-emptytrash]', async () => {
      const t = st.trash; const bytes = t.files.reduce((s, x) => s + (x.size || 0), 0);
      const ok = await ctx.confirm({ title: 'Empty the trash of ' + esc(st.names[''] || 'this workspace'), tag: 'permanent', tone: 'danger', body: '<p class="fg2" style="margin:0">Purges every trashed file and folder now as a job (202). Their sealed versions are deleted and the storage is freed.</p>', kv: [['Items', t.files.length + t.folders.length], ['Files listed', fmtBytes(bytes)]], ok: 'Empty trash' });
      if (!ok) return;
      try { const out = await App.post('/api/files/trash/empty', {}); ctx.toast('202: purge job ' + esc(out.jobId) + ' queued. Audited file.trash.emptied, then file.purged per item.', 'warn'); setTimeout(() => load(ctx, true), 1500); }
      catch (err) { App.fail(err, 'Could not empty the trash'); }
    });
  }

  // ---------- shared with me ----------
  function renderShared(ctx) {
    const st = ctx.state; const list = st.shared;
    const head = UI.pagehead('Shared with me', 'Files shared with you directly, through a workspace or a directory group. Live shares only, within your clearance. You can download the current version and its preview, nothing else.', UI.btn('Open a link', { icon: 'link', attrs: 'data-openlink' }));
    if (!list) return head + UI.notice('Loading…', 'info');
    if (!st.groupList && list.some((s) => s.sharedVia === 'social_group') && !st.groupAsked) { st.groupAsked = true; groupsOf(st).then(() => rerender(ctx)); }
    const via = (s) => s.sharedVia === 'user' ? 'shared with you' : s.sharedVia === 'workspace' ? 'via your workspace' : s.sharedVia === 'group' ? 'via a directory group' : s.sharedVia === 'social_group' ? (groupName(st, s.groupId) ? 'via group ' + esc(groupName(st, s.groupId)) : 'via a group') + (s.viaFolder ? ', with the folder' : '') : esc(s.sharedVia);
    const rows = list.map((s) => ({ cells: ['<span style="font-weight:600">' + esc(s.name) + '</span>', typePill(s.type), '<span class="num">' + esc(fmtBytes(s.size)) + '</span>', UI.label(s.label, { sm: true }), via(s), esc(when(s.sharedAt)), esc(when(s.updatedAt)), '<span class="hstack gap4" style="justify-content:flex-end">' + UI.btn('Preview', { size: 'xs', kind: 'ghost', attrs: 'data-shpreview="' + esc(s.id) + '" aria-label="Preview ' + esc(s.name) + '"' }) + UI.btn('Download', { size: 'xs', attrs: 'data-shdl="' + esc(s.id) + '" aria-label="Download ' + esc(s.name) + '"', disabled: !s.currentVersion }) + '</span>'] }));
    return head + UI.table(['Name', 'Type', 'Size', 'Label', 'From', 'Shared', 'Updated', { label: '', right: true }], rows, { clickable: false, minWidth: '820px', emptyTitle: 'Nothing shared with you', emptyText: 'Shares appear here as soon as someone grants them.' });
  }
  function wireShared(ctx) {
    const st = ctx.state;
    const dl = (s) => { download('/api/files/' + enc(s.id) + '/content', s.name); ctx.toast('Downloading ' + esc(s.name) + ' (sandboxed attachment). Audited file.downloaded.', 'ok'); };
    ctx.on('click', '[data-shdl]', (e, t) => { const s = (st.shared || []).find((x) => x.id === t.dataset.shdl); if (s) dl(s); });
    ctx.on('click', '[data-shpreview]', async (e, t) => {
      const s = (st.shared || []).find((x) => x.id === t.dataset.shpreview); if (!s) return;
      let d; try { d = await App.get('/api/files/' + enc(s.id)); } catch (err) { App.fail(err, 'Could not open the file'); return; }
      ctx.modal({ title: esc(s.name), body: '<div class="files-preview" style="min-height:200px">' + (d.preview === 'ready' ? '<img src="/api/files/' + esc(s.id) + '/preview?v=' + esc(d.currentVersion) + '" alt="' + esc(d.altText || 'Preview of ' + s.name) + '">' : 'No preview (' + esc(previewText(d.preview)) + '). Download to open it.') + '</div>' + UI.kv([['From', esc(d.ownerName || '')], ['Label', UI.label(d.label, { sm: true })], ['Size', esc(fmtBytes(d.size))]], 3), actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Download', { kind: 'primary', attrs: 'data-shdl-modal', disabled: !d.currentVersion }), onMount(m) { m.querySelector('[data-shdl-modal]').addEventListener('click', () => { App.closeOverlay(); dl(s); }); } });
    });
    ctx.on('click', '[data-openlink]', () => openLink(ctx));
  }
  function openLink(ctx) {
    ctx.modal({ title: 'Open a file link', body: UI.field('Link token', UI.input('', { placeholder: 'exf_…', attrs: 'data-ol-token autocomplete="off" spellcheck="false"' }), 'Signed in, same tenant and cleared for the file: you see its name, size, type and uses left without using the link. Every other case, including a used-up, expired or revoked link, is the same 404.') + '<div data-ol-out aria-live="polite"></div>', actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Check', { kind: 'primary', attrs: 'data-ol-check' }), onMount(m) {
      const out = m.querySelector('[data-ol-out]');
      const tokenOf = () => { const v = m.querySelector('[data-ol-token]').value.trim(); const k = /exf_[A-Za-z0-9_-]+/.exec(v); return k ? k[0] : v; };
      const refused = (err) => { out.innerHTML = UI.problem(err.status === 404 ? 'Not found' : 'Refused', esc((err.status ? err.status + '. ' : '') + (err.status === 404 ? 'The token is unknown, used up, expired or revoked, or the file is above your clearance. All of these answer the same way.' : err.message)), err.problem && err.problem.trace_id); };
      let info = null;
      const paint = () => {
        out.innerHTML = UI.notice('<b>' + esc(info.name) + '</b>, ' + esc(fmtBytes(info.size)) + ', ' + esc(typeName(info.type) || 'file') + ', ' + esc(info.label) + '. ' + (info.expiresAt ? 'Expires ' + esc(when(info.expiresAt)) + ', ' : '') + (info.usesLeft == null ? 'unlimited uses.' : '<span data-ol-left>' + info.usesLeft + ' use' + (info.usesLeft === 1 ? '' : 's') + ' left</span>.'), 'ok', UI.btn('Download (uses one)', { size: 'sm', attrs: 'data-ol-dl' }));
        out.querySelector('[data-ol-dl]').addEventListener('click', async (ev) => {
          const b = ev.currentTarget; b.disabled = true;
          try {
            const got = await postForFile('/api/file-links/download', { token: tokenOf() });
            if (info.usesLeft != null) info.usesLeft = Math.max(0, info.usesLeft - 1);
            paint();
            ctx.toast('One use taken; downloading ' + esc(got.name) + '. Audited file.downloaded with your address.', 'ok');
          } catch (err) { refused(err); }
        });
      };
      m.querySelector('[data-ol-check]').addEventListener('click', async () => {
        const token = tokenOf();
        if (!/^exf_[A-Za-z0-9_-]{20,100}$/.test(token)) { out.innerHTML = UI.notice('A link token starts with exf_ and is at least 24 characters.', 'warn'); return; }
        try { info = await App.post('/api/file-links/open', { token }); paint(); }
        catch (err) { refused(err); }
      });
    } });
  }
})();
