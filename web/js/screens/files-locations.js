(function () {
  const { UI, esc } = App;

  /*
   * 2.0.0: linked storage locations in Files (S3, Azure Blob, local stores, SFTP, FTP, IPFS) and imports from
   * elsewhere (a URL, a database, Knowledge, agent and workflow runs, workflows, skills, tools). files.js draws the
   * "Linked" section of its left pane with leftPane, the view 'location' with render, and calls wire on every render.
   * Nothing is mounted: a location is browsed here, and a file is copied into Files (scanned like an upload) or sent
   * out from Files. State lives under st.loc.
   */

  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l) + 1;
  const clearance = () => (App.me && App.me.user && App.me.user.clearance) || 'internal';
  const labelChoices = () => LABELS.filter((l) => rank(l) <= rank(clearance()));
  const GB = 1024 * 1024 * 1024, MB = 1024 * 1024, KB = 1024;
  const fmtBytes = (n) => (n == null ? '' : n >= GB ? (n / GB).toFixed(1) + ' GB' : n >= MB ? (n / MB).toFixed(1) + ' MB' : n >= KB ? Math.round(n / KB) + ' KB' : n + ' B');
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const KIND_NAMES = { s3: 'S3', azure: 'Azure Blob', local: 'Local store', sftp: 'SFTP', ftp: 'FTP', ipfs: 'IPFS' };
  const KIND_ICON = { s3: 'storage', azure: 'storage', local: 'files', sftp: 'key', ftp: 'link', ipfs: 'atproto' };
  const FLAVOURS = [['aws', 'Amazon S3'], ['minio', 'MinIO'], ['s3', 'Other S3-compatible'], ['azure', 'Azure Blob'], ['local', 'Local store'], ['sftp', 'SFTP'], ['ftp', 'FTP / FTPS'], ['ipfs', 'IPFS']];
  const kindName = (l) => (l.kind === 's3' && l.config && l.config.flavour === 'aws' ? 'Amazon S3' : l.kind === 's3' && l.config && l.config.flavour === 'minio' ? 'MinIO' : KIND_NAMES[l.kind] || l.kind);
  const IMPORT_KINDS = [['url', 'From a URL'], ['database', 'Database table or query'], ['knowledge', 'Knowledge document'], ['agent-run', 'Agent run'], ['workflow-run', 'Workflow run'], ['workflow', 'Workflow (signed bundle)'], ['skill', 'Skill'], ['tool', 'Tool definition']];
  const canLink = () => App.can('files:link');
  const canWrite = () => App.can('files:write');

  const S = (st) => st.loc || (st.loc = { list: null, loading: false, error: null, browse: null, jobs: {} });
  const overlayOpen = () => !!document.getElementById('overlay');
  function rerender(ctx) {
    const st = ctx.state;
    if (App.state.route !== 'files') return;
    if (overlayOpen()) { st.dirty = true; return; }
    ctx.rerender();
  }

  // ---------- loading ----------
  function loadList(ctx) {
    const L = S(ctx.state);
    if (L.loading) return Promise.resolve();
    L.loading = true;
    return App.get('/api/files/locations').then((list) => { L.list = Array.isArray(list) ? list : []; L.error = null; })
      .catch((err) => { L.list = L.list || []; L.error = err; })
      .finally(() => { L.loading = false; rerender(ctx); });
  }
  const current = (st) => { const L = S(st); return (L.list || []).find((x) => x.id === st.locationId) || null; };
  function loadBrowse(ctx, more) {
    const st = ctx.state; const L = S(st);
    const path = st.locPath || '';
    const b = L.browse && L.browse.id === st.locationId && L.browse.path === path ? L.browse : (L.browse = { id: st.locationId, path, entries: [], next: null, picked: {}, loaded: false });
    if (b.loading) return;
    b.loading = true; b.error = null;
    App.get('/api/files/locations/' + enc(st.locationId) + '/browse?path=' + enc(path) + (more && b.next ? '&cursor=' + enc(b.next) : ''))
      .then((r) => { if (L.browse !== b) return; b.entries = more ? b.entries.concat(r.entries || []) : (r.entries || []); b.next = r.next || null; b.loaded = true; })
      .catch((err) => { if (L.browse === b) { b.error = err; b.loaded = true; } })
      .finally(() => { b.loading = false; rerender(ctx); });
  }

  // ---------- helpers ----------
  function folderOptions(st) {
    const out = [{ value: '', label: (st.names && st.names['']) || 'Workspace root' }];
    const walk = (pid, depth) => ((st.kids && st.kids[pid]) || []).forEach((f) => { out.push({ value: f.id, label: '  '.repeat(depth) + f.name }); walk(f.id, depth + 1); });
    walk('', 1);
    return out;
  }
  const curFolder = (st) => (st.view === 'folder' || st.view == null ? st.folder || '' : st.folder || '');
  function selectNew(ctx, out) {
    const st = ctx.state;
    if (!out || !out.id) return;
    st.view = 'folder'; st.folder = out.folderId || null; st.sel = out.id; st.query = ''; st.tagFilter = null; st.results = null; st.loaded = false;
    rerender(ctx);
  }
  const problemHtml = (err) => UI.notice('<b>' + esc(String(err.status || '')) + ' ' + esc((err.problem && err.problem.title) || '') + '</b> ' + esc((err.problem && err.problem.detail) || err.message || ''), err.status === 403 || err.status === 502 ? 'warn' : 'danger');

  /** Polls the caller's own jobs until `id` ends, then says how it went. */
  function watchJob(ctx, id, what) {
    const L = S(ctx.state);
    if (L.jobs[id]) return;
    let polls = 0;
    const tick = () => {
      if (polls++ > 400) { delete L.jobs[id]; return; }
      App.get('/api/me/jobs').then((list) => {
        const j = (Array.isArray(list) ? list : []).find((x) => x.id === id);
        if (j && (j.state === 'succeeded' || j.state === 'failed' || j.state === 'cancelled' || j.state === 'dead')) {
          delete L.jobs[id];
          const r = j.result || {};
          const n = Array.isArray(r.files) ? r.files.length : typeof r.imported === 'number' ? r.imported : typeof r.files === 'number' ? r.files : null;
          const failed = Array.isArray(r.failed) ? r.failed.length : typeof r.failed === 'number' ? r.failed : 0;
          if (j.state === 'succeeded') App.toast(esc(what) + ' finished' + (n != null ? ': ' + n + ' file' + (n === 1 ? '' : 's') + ' copied into Files' : '') + (failed ? ', ' + failed + ' could not be copied' : '') + '. Each is scanned like an upload.', failed ? 'warn' : 'ok', 7000);
          else App.toast(esc(what) + ' ' + esc(j.state) + (j.error ? ': ' + esc(String(j.error).slice(0, 200)) : '') + '.', 'danger', 7000);
          if (App.state.route === 'files') { ctx.state.loaded = false; rerender(ctx); }
          return;
        }
        L.jobs[id] = setTimeout(tick, 1500);
      }).catch(() => { L.jobs[id] = setTimeout(tick, 3000); });
    };
    L.jobs[id] = setTimeout(tick, 1500);
  }

  // ---------- left pane ----------
  function leftPane(ctx, st) {
    const L = S(st);
    if (L.list == null && !L.loading) loadList(ctx);
    const items = (L.list || []).map((l) => UI.listItem(UI.icon(KIND_ICON[l.kind] || 'storage', 13) + ' ' + esc(l.name), esc(kindName(l)) + (l.state && l.state !== 'ok' ? ', ' + esc(l.state) : '') + (l.readOnly || l.writable === false ? ', read only' : ''), { active: st.view === 'location' && st.locationId === l.id, attrs: 'data-loc="' + esc(l.id) + '"' })).join('');
    return '<div class="hstack"><div class="eyebrow grow">Linked</div>' + (canLink() ? UI.iconbtn('plus', 'Link a storage location', { attrs: 'data-loc-add', cls: 'sm ghost' }) : '') + '</div>'
      + (L.list == null ? '<span class="muted" style="font-size:12px">Loading…</span>' : items || '<span class="muted" style="font-size:12px">' + (canLink() ? 'No linked storage yet. Link an S3 bucket, Azure container, local store, SFTP or FTP server, or IPFS.' : 'No linked storage in this workspace.') + '</span>')
      + (L.error ? '<span class="muted" style="font-size:11px">' + esc(L.error.message || 'Could not list linked storage') + '</span>' : '');
  }

  // ---------- the location view ----------
  const STYLE = '<style>'
    + '#main .floc-crumbs a{color:inherit}'
    + '#main .floc-name{display:inline-flex;align-items:center;gap:6px;font-weight:600;overflow-wrap:anywhere;text-align:left;background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer}'
    + '#main .floc-name.file{cursor:default;font-weight:500}'
    + '#main .floc-cidrow{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end}'
    + '#main .floc-cidrow .field{flex:1 1 220px;min-width:0}'
    + '</style>';

  function render(ctx, st) {
    const L = S(st);
    if (L.list == null) { if (!L.loading) loadList(ctx); return STYLE + UI.pagehead('Linked storage', '') + UI.notice('Loading…', 'info'); }
    const l = current(st);
    if (!l) return STYLE + UI.pagehead('Linked storage', '') + UI.empty('Location not found', 'It was removed, or it belongs to another workspace. Choose one from Linked in the left pane.');
    const path = st.locPath || '';
    const b = L.browse && L.browse.id === l.id && L.browse.path === path ? L.browse : null;
    if (!b || (!b.loaded && !b.loading)) loadBrowse(ctx, false);
    const writable = l.writable !== false && !l.readOnly;
    const parts = path ? path.split('/') : [];
    const crumbs = '<span class="floc-crumbs">' + [{ p: '', n: l.name }].concat(parts.map((seg, i) => ({ p: parts.slice(0, i + 1).join('/'), n: seg }))).map((c, i, all) => i < all.length - 1 ? '<a href="#" data-loc-crumb="' + esc(c.p) + '">' + esc(c.n) + '</a> <span class="muted">/</span> ' : '<b>' + esc(c.n) + '</b>').join('') + '</span>';
    const actions = UI.btn('Refresh', { icon: 'refresh', attrs: 'data-loc-refresh' }) + UI.btn('Test connection', { attrs: 'data-loc-test' })
      + (canLink() ? UI.btn('Edit', { kind: 'ghost', icon: 'edit', attrs: 'data-loc-edit' }) + UI.btn('Remove', { kind: 'ghost', icon: 'trash', attrs: 'data-loc-remove' }) : '');
    const head = UI.pagehead(l.name, UI.pill(kindName(l), 'outline') + ' ' + UI.label(l.label, { sm: true }) + (writable ? '' : ' ' + UI.pill('read only', 'warn')) + (l.state && l.state !== 'ok' ? ' ' + UI.pill(l.state, 'danger') : ''), actions);
    let out = STYLE + head
      + (l.lastError ? UI.notice('<b>Last check failed</b>' + (l.lastCheckedAt ? ' ' + esc(when(l.lastCheckedAt)) : '') + ': ' + esc(l.lastError), 'warn') : '')
      + (L.testNote ? UI.notice(L.testNote.html, L.testNote.tone, UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-loc-cleartest' })) : '')
      + '<div>' + crumbs + '</div>'
      + UI.notice('Browsing reads ' + esc(kindName(l)) + ' directly. Importing copies a file into Files, where it is scanned, labelled and counted against the quota like an upload. Nothing here is served from Files until it is imported.', 'info');
    if (l.kind === 'ipfs' && l.config && !l.config.root && !path) {
      out += '<div class="floc-cidrow">' + UI.field('Fetch by CID', UI.input('', { attrs: 'data-loc-cid placeholder="bafy… or /ipfs/bafy…/file.pdf" autocomplete="off" spellcheck="false"' }), 'A CID or an /ipfs/ path. The content is copied into the current Files folder.') + UI.btn('Import', { kind: 'primary', attrs: 'data-loc-cidgo', disabled: !canWrite() }) + '</div>';
    }
    if (!b || (!b.loaded && b.loading)) return out + UI.notice('Listing…', 'info');
    if (b.error) return out + UI.problem('The location could not be listed', (b.error.problem && b.error.problem.detail) || b.error.message, b.error.problem && b.error.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-loc-refresh' }) + '</div>';
    const picked = Object.keys(b.picked).filter((k) => b.picked[k]);
    if (picked.length && canWrite()) out += '<div class="hstack wrap gap6" role="group" aria-label="Selected remote files" style="padding:8px 10px;border:1px solid var(--accent);border-radius:8px;background:var(--accent-tint)"><b style="font-size:13px">' + picked.length + ' selected</b>' + UI.btn('Import to Files', { kind: 'primary', size: 'sm', icon: 'download', attrs: 'data-loc-import' }) + UI.btn('Clear selection', { size: 'sm', kind: 'ghost', attrs: 'data-loc-clearpick' }) + '</div>';
    const rows = (path ? [{ up: true }] : []).concat(b.entries).map((e) => {
      if (e.up) return { cells: [canWrite() ? '' : null, '<button type="button" class="floc-name" data-loc-dir="' + esc(parts.slice(0, -1).join('/')) + '">' + UI.icon('undo', 13) + ' Up one level</button>', '', '', ''].filter((c) => c !== null) };
      const cb = e.dir ? '' : '<input type="checkbox" data-loc-pick="' + esc(e.path) + '"' + (b.picked[e.path] ? ' checked' : '') + ' aria-label="Select ' + esc(e.name) + '">';
      const name = e.dir ? '<button type="button" class="floc-name" data-loc-dir="' + esc(e.path) + '">' + UI.icon('files', 13) + ' ' + esc(e.name) + '</button>' : '<span class="floc-name file">' + UI.icon('runs', 13) + ' ' + esc(e.name) + '</span>';
      const tag = e.etag ? '<span class="mono" style="font-size:11px" title="' + esc(e.etag) + '">' + esc(String(e.etag).replace(/"/g, '').slice(0, 14)) + (String(e.etag).length > 14 ? '…' : '') + '</span>' : '';
      return { cells: (canWrite() ? [cb] : []).concat([name, e.dir ? '<span class="muted">folder</span>' : '<span class="num">' + esc(fmtBytes(e.size)) + '</span>', esc(when(e.modified)), tag]) };
    });
    out += UI.table((canWrite() ? [{ label: '', srLabel: 'Select' }] : []).concat(['Name', 'Size', 'Modified', 'ETag or CID']), rows, { clickable: false, minWidth: '640px', emptyTitle: 'Nothing here', emptyText: 'This folder of the location is empty.' })
      + '<div class="hstack gap6"><span class="muted" style="font-size:12px">' + b.entries.length + ' entr' + (b.entries.length === 1 ? 'y' : 'ies') + (b.next ? ' so far' : '') + '</span>' + (b.next ? UI.btn(b.loading ? 'Loading…' : 'Load more', { size: 'sm', attrs: 'data-loc-more', disabled: !!b.loading }) : '') + '</div>';
    return out;
  }

  // ---------- events ----------
  function wire(ctx, st) {
    const L = S(st);
    ctx.on('click', '[data-loc]', (e, t) => { st.view = 'location'; st.locationId = t.dataset.loc; st.locPath = ''; L.testNote = null; ctx.rerender(); });
    ctx.on('click', '[data-loc-add]', () => addLocation(ctx, st));
    if (st.view !== 'location') return;
    const l = current(st);
    const b = () => L.browse;
    ctx.on('click', '[data-loc-dir]', (e, t) => { st.locPath = t.dataset.locDir; ctx.rerender(); });
    ctx.on('click', '[data-loc-crumb]', (e, t) => { e.preventDefault(); st.locPath = t.dataset.locCrumb; ctx.rerender(); });
    ctx.on('change', '[data-loc-pick]', (e, t) => { const x = b(); if (!x) return; if (t.checked) x.picked[t.dataset.locPick] = true; else delete x.picked[t.dataset.locPick]; rerender(ctx); });
    ctx.on('click', '[data-loc-clearpick]', () => { const x = b(); if (x) x.picked = {}; ctx.rerender(); });
    ctx.on('click', '[data-loc-more]', () => loadBrowse(ctx, true));
    ctx.on('click', '[data-loc-refresh]', () => { L.browse = null; loadList(ctx); ctx.rerender(); });
    ctx.on('click', '[data-loc-cleartest]', () => { L.testNote = null; ctx.rerender(); });
    if (!l) return;
    ctx.on('click', '[data-loc-test]', async (e, t) => {
      t.disabled = true;
      try {
        const r = await App.post('/api/files/locations/' + enc(l.id) + '/test');
        L.testNote = { tone: r.ok ? 'ok' : 'warn', html: '<b>' + (r.ok ? 'Connected.' : 'Not connected.') + '</b> ' + esc(r.detail || '') + (r.hostKey ? ' Host key <span class="mono">' + esc(r.hostKey) + '</span>.' : '') };
      } catch (err) { L.testNote = { tone: 'danger', html: '<b>' + esc(String(err.status || '')) + '</b> ' + esc((err.problem && err.problem.detail) || err.message) }; }
      loadList(ctx); ctx.rerender();
    });
    ctx.on('click', '[data-loc-edit]', () => addLocation(ctx, st, l));
    ctx.on('click', '[data-loc-remove]', async () => {
      const ok = await ctx.confirm({ title: 'Remove ' + esc(l.name), tone: 'danger', body: '<p class="fg2" style="margin:0">Unlinks the location and deletes its stored credentials. Nothing is deleted on ' + esc(kindName(l)) + ', and files already imported stay in Files.</p>', kv: [['Kind', esc(kindName(l))], ['Label', esc(l.label)]], ok: 'Remove' });
      if (!ok) return;
      try { await App.del('/api/files/locations/' + enc(l.id)); ctx.toast(esc(l.name) + ' unlinked. Audited.', 'ok'); st.view = 'folder'; st.locationId = null; L.browse = null; L.list = null; loadList(ctx); ctx.rerender(); }
      catch (err) { App.fail(err, 'Could not remove the location'); }
    });
    ctx.on('click', '[data-loc-import]', () => { const x = b(); if (!x) return; const paths = Object.keys(x.picked).filter((k) => x.picked[k]); if (paths.length) importDialog(ctx, st, l, paths); });
    ctx.on('click', '[data-loc-cidgo]', () => {
      const el = ctx.$('[data-loc-cid]'); const v = el ? el.value.trim() : '';
      const m = /^(?:\/?ipfs\/)?([A-Za-z0-9]{20,120}(?:\/[^\s]*)?)$/.exec(v);
      if (!m) { ctx.toast('Give a CID (bafy… or Qm…) or an /ipfs/ path.', 'warn'); return; }
      importDialog(ctx, st, l, [m[1]]);
    });
  }

  function importDialog(ctx, st, l, paths) {
    const labels = labelChoices();
    const def = labels.indexOf(l.label) >= 0 ? l.label : labels.indexOf('internal') >= 0 ? 'internal' : labels[labels.length - 1];
    ctx.modal({ title: 'Import ' + paths.length + ' file' + (paths.length === 1 ? '' : 's') + ' from ' + esc(l.name),
      body: '<div class="formgrid">' + UI.field('Into Files folder', UI.select(folderOptions(st), st.folder || '', 'data-li-folder'), 'Folders you have opened in Files are listed.')
        + UI.field('Label', UI.select(labels, def, 'data-li-label'), 'At most your clearance and the workspace ceiling. The scan may raise it.') + '</div>'
        + '<div class="muted" style="font-size:12px;overflow-wrap:anywhere">' + paths.slice(0, 8).map(esc).join('<br>') + (paths.length > 8 ? '<br>and ' + (paths.length - 8) + ' more' : '') + '</div>'
        + UI.notice('Each file is copied into Files and scanned like an upload. A clashing name gets " (2)". Larger batches run as a job.', 'info') + '<div data-li-err aria-live="polite"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Import', { kind: 'primary', attrs: 'data-li-ok' }),
      onMount(m) {
        const ok = m.querySelector('[data-li-ok]');
        ok.addEventListener('click', async () => {
          const folder = m.querySelector('[data-li-folder]').value; const body = { paths, label: m.querySelector('[data-li-label]').value };
          if (folder) body.folderId = folder;
          ok.disabled = true; ok.textContent = 'Importing…';
          try {
            const r = await App.post('/api/files/locations/' + enc(l.id) + '/import', body);
            App.closeOverlay();
            const L = S(st); if (L.browse) L.browse.picked = {};
            if (r && r.jobId) { ctx.toast('202: import queued as job ' + esc(r.jobId) + '. You are told when it finishes.', 'ok', 6000); watchJob(ctx, r.jobId, 'The import from ' + l.name); rerender(ctx); }
            else if (r && Array.isArray(r.files) && r.files.length) {
              const f = r.files[0];
              ctx.modal({ title: 'Imported', body: UI.notice('<b>' + r.files.length + ' file' + (r.files.length === 1 ? '' : 's') + ' copied into Files.</b> ' + r.files.map((x) => esc(x.name)).join(', ') + '. Each is scanned like an upload.', 'ok'), actions: UI.btn('Stay here', { attrs: 'data-close' }) + UI.btn('Open in Files', { kind: 'primary', attrs: 'data-li-open' }), onMount(mm) { mm.querySelector('[data-li-open]').addEventListener('click', () => { App.closeOverlay(); selectNew(ctx, f); }); } });
            } else { ctx.toast('Import accepted.', 'ok'); rerender(ctx); }
          } catch (err) { ok.disabled = false; ok.textContent = 'Import'; m.querySelector('[data-li-err]').innerHTML = problemHtml(err); }
        });
      } });
  }

  // ---------- link or edit a location ----------
  function kindFieldsHtml(flavour, cfg, editing, roots) {
    const c = cfg || {};
    const keep = editing ? 'Leave empty to keep the stored credentials.' : '';
    const val = (k, d) => (c[k] != null ? c[k] : d);
    if (flavour === 'aws' || flavour === 'minio' || flavour === 's3') {
      const region = val('region', flavour === 'aws' ? 'us-east-1' : 'us-east-1');
      const endpoint = val('endpoint', flavour === 'aws' ? 'https://s3.' + region + '.amazonaws.com' : flavour === 'minio' ? 'http://minio.internal:9000' : '');
      return '<div class="formgrid">' + UI.field('Endpoint', UI.input(endpoint, { attrs: 'data-lf-endpoint placeholder="https://…"' }), flavour === 'aws' ? 'Follows the region unless you change it.' : flavour === 'minio' ? 'The MinIO API address, usually port 9000.' : 'The service\'s S3 API address.')
        + UI.field('Region', UI.input(region, { attrs: 'data-lf-region' }))
        + UI.field('Bucket', UI.input(val('bucket', ''), { attrs: 'data-lf-bucket' }))
        + UI.field('Prefix', UI.input(val('prefix', ''), { attrs: 'data-lf-prefix placeholder="reports/ (optional)"' }), 'Browsing starts here.')
        + UI.field('Addressing', UI.select([{ value: 'path', label: 'Path style (endpoint/bucket)' }, { value: 'virtual', label: 'Virtual host (bucket.endpoint)' }], (c.pathStyle != null ? c.pathStyle : flavour !== 'aws') ? 'path' : 'virtual', 'data-lf-pathstyle'))
        + UI.field('Access key id', UI.input('', { attrs: 'data-lf-akid autocomplete="off" spellcheck="false"' }), keep)
        + UI.field('Secret access key', UI.input('', { type: 'password', attrs: 'data-lf-secretkey autocomplete="new-password"' }), editing ? keep : 'Sealed with the tenant key; never shown again.')
        + UI.field('Session token', UI.input('', { type: 'password', attrs: 'data-lf-token autocomplete="off"' }), 'Optional, for temporary credentials.') + '</div>';
    }
    if (flavour === 'azure') {
      const account = val('account', '');
      return '<div class="formgrid">' + UI.field('Storage account', UI.input(account, { attrs: 'data-lf-account' }))
        + UI.field('Container', UI.input(val('container', ''), { attrs: 'data-lf-container' }))
        + UI.field('Prefix', UI.input(val('prefix', ''), { attrs: 'data-lf-prefix placeholder="optional"' }))
        + UI.field('Endpoint', UI.input(val('endpoint', ''), { attrs: 'data-lf-endpoint placeholder="https://<account>.blob.core.windows.net"' }), 'Empty for https://<account>.blob.core.windows.net. Azurite: http://127.0.0.1:10000/<account>.')
        + UI.field('Authentication', UI.select([{ value: 'key', label: 'Account key' }, { value: 'sas', label: 'SAS token' }], 'key', 'data-lf-azauth'))
        + UI.field('Key or SAS token', UI.input('', { type: 'password', attrs: 'data-lf-azsecret autocomplete="new-password"' }), editing ? keep : 'An account key (base64), or a SAS token without the leading ?.') + '</div>';
    }
    if (flavour === 'local') {
      const opts = (roots || []).map((r) => ({ value: r.id, label: r.name + (r.readOnly ? ' (read only)' : '') }));
      return '<div class="formgrid">' + (opts.length ? UI.field('Local store', UI.select(opts, val('rootId', opts[0].value), 'data-lf-root'), 'Directories an operator offers to this tenant (Admin, Storage, Local stores).') : UI.notice('No local store is offered to this tenant. An operator adds them under Admin, Storage, Local stores.', 'warn'))
        + UI.field('Subfolder', UI.input(val('path', ''), { attrs: 'data-lf-subpath placeholder="optional, e.g. scans/2026"' }), 'Relative to the store.') + '</div>';
    }
    if (flavour === 'sftp') {
      return '<div class="formgrid">' + UI.field('Host', UI.input(val('host', ''), { attrs: 'data-lf-host spellcheck="false"' }))
        + UI.field('Port', UI.input(val('port', 22), { type: 'number', attrs: 'data-lf-port min="1" max="65535"' }))
        + UI.field('Username', UI.input(val('username', ''), { attrs: 'data-lf-user autocomplete="off"' }))
        + UI.field('Root folder', UI.input(val('root', ''), { attrs: 'data-lf-rootpath placeholder="/upload (optional)"' }))
        + UI.field('Sign in with', UI.select([{ value: 'password', label: 'Password' }, { value: 'key', label: 'Private key' }], 'password', 'data-lf-sftpauth'))
        + '<div data-lf-sftp-pw>' + UI.field('Password', UI.input('', { type: 'password', attrs: 'data-lf-password autocomplete="new-password"' }), keep) + '</div>'
        + '<div data-lf-sftp-key hidden>' + UI.field('Private key', UI.textarea('', { rows: 4, attrs: 'data-lf-privkey spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"' }), keep || 'OpenSSH or PEM. Sealed with the tenant key.') + UI.field('Passphrase', UI.input('', { type: 'password', attrs: 'data-lf-passphrase autocomplete="off"' }), 'Optional.') + '</div>'
        + '<div data-lf-hostkey>' + (c.hostKey ? UI.notice('Host key pinned: <span class="mono" style="overflow-wrap:anywhere">' + esc(c.hostKey) + '</span>. A server that presents another key is refused.', 'info') : '<span class="muted" style="font-size:12px">Test the connection to see the server\'s host key; it is pinned when you save.</span>') + '</div></div>';
    }
    if (flavour === 'ftp') {
      return '<div class="formgrid">' + UI.field('Host', UI.input(val('host', ''), { attrs: 'data-lf-host spellcheck="false"' }))
        + UI.field('Port', UI.input(val('port', 21), { type: 'number', attrs: 'data-lf-port min="1" max="65535"' }))
        + UI.field('Username', UI.input(val('username', ''), { attrs: 'data-lf-user autocomplete="off"' }))
        + UI.field('Password', UI.input('', { type: 'password', attrs: 'data-lf-password autocomplete="new-password"' }), keep)
        + UI.field('Root folder', UI.input(val('root', ''), { attrs: 'data-lf-rootpath placeholder="optional"' }))
        + UI.field('Encryption', UI.select([{ value: 'explicit', label: 'Explicit TLS (AUTH TLS)' }, { value: 'implicit', label: 'Implicit TLS (port 990)' }, { value: 'none', label: 'None (plain FTP)' }], val('tls', 'explicit'), 'data-lf-tls'))
        + '<div data-lf-tlswarn' + (val('tls', 'explicit') === 'none' ? '' : ' hidden') + '>' + UI.notice('Plain FTP sends the password and the files unencrypted. The server allows it only for internal hosts.', 'warn') + '</div></div>';
    }
    // ipfs
    const mode = val('mode', 'rpc');
    return '<div class="formgrid">' + UI.field('Connect through', UI.select([{ value: 'rpc', label: 'A Kubo node\'s RPC API (read and write)' }, { value: 'gateway', label: 'A gateway (read only)' }], mode, 'data-lf-ipfsmode'))
      + UI.field('Endpoint', UI.input(val('endpoint', mode === 'gateway' ? 'https://ipfs.io' : 'http://127.0.0.1:5001'), { attrs: 'data-lf-endpoint spellcheck="false"' }))
      + UI.field('Browse from', UI.input(val('root', ''), { attrs: 'data-lf-ipfsroot placeholder="a CID or /ipns/name; empty to fetch by CID only" spellcheck="false"' }))
      + '<div data-lf-pinwrap' + (mode === 'rpc' ? '' : ' hidden') + '>' + UI.check('Pin what is added', c.pin != null ? !!c.pin : true, 'data-lf-pin') + '</div>'
      + UI.field('Authorization header', UI.input('', { type: 'password', attrs: 'data-lf-ipfsauth autocomplete="off" placeholder="optional, e.g. Bearer …"' }), editing ? keep : 'Optional; for a node behind an authenticating proxy.') + '</div>';
  }

  function flavourOf(l) {
    if (!l) return 'aws';
    if (l.kind === 's3') return (l.config && l.config.flavour) === 'minio' ? 'minio' : (l.config && l.config.flavour) === 'aws' ? 'aws' : 's3';
    return l.kind;
  }

  async function addLocation(ctx, st, existing) {
    if (!canLink()) { ctx.toast('Linking storage needs the files:link permission.', 'warn'); return; }
    let roots = [];
    try { roots = await App.get('/api/files/local-roots'); if (!Array.isArray(roots)) roots = []; } catch (e) { roots = []; }
    const editing = !!existing;
    const labels = labelChoices();
    let flavour = flavourOf(existing);
    let hostKey = existing && existing.config && existing.config.hostKey ? existing.config.hostKey : null;
    ctx.modal({ cls: 'wide', title: editing ? 'Edit ' + esc(existing.name) : 'Link storage',
      body: '<div class="formgrid">' + UI.field('Kind', UI.select(FLAVOURS.map((f) => ({ value: f[0], label: f[1] })), flavour, 'data-lf-kind' + (editing ? ' disabled' : '')), editing ? 'The kind of a linked location does not change; link a new one instead.' : '')
        + UI.field('Name', UI.input(editing ? existing.name : '', { attrs: 'data-lf-name placeholder="e.g. Finance reports"' }))
        + UI.field('Label', UI.select(labels, editing ? existing.label : labels.indexOf('internal') >= 0 ? 'internal' : labels[labels.length - 1], 'data-lf-label'), 'What it holds: imports are labelled at least this, and files above it are not sent to it.')
        + '<div>' + UI.check('Read only (browse and import only)', editing ? !!existing.readOnly : false, 'data-lf-ro') + '</div></div>'
        + '<div data-lf-kindfields>' + kindFieldsHtml(flavour, editing ? existing.config : null, editing, roots) + '</div>'
        + '<p class="muted" style="font-size:12px;margin:0">A host on the internet must be on this tenant\'s allowed hosts (Registry, Allowed hosts); an internal host must be named by the operator (SERVICE_ALLOWED_HOSTS). Cloud metadata addresses are always refused. Credentials are sealed with the tenant key and never shown again.</p>'
        + '<div data-lf-out aria-live="polite"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Test', { attrs: 'data-lf-test' }) + UI.btn(editing ? 'Save' : 'Link', { kind: 'primary', attrs: 'data-lf-save' }),
      onMount(m) {
        const q = (s) => m.querySelector(s);
        const v = (s) => { const el = q(s); return el ? el.value.trim() : ''; };
        const out = q('[data-lf-out]');
        const wireKind = () => {
          const sa = q('[data-lf-sftpauth]');
          if (sa) sa.addEventListener('change', () => { q('[data-lf-sftp-pw]').hidden = sa.value !== 'password'; q('[data-lf-sftp-key]').hidden = sa.value !== 'key'; });
          const tls = q('[data-lf-tls]');
          if (tls) tls.addEventListener('change', () => { q('[data-lf-tlswarn]').hidden = tls.value !== 'none'; });
          const im = q('[data-lf-ipfsmode]');
          if (im) im.addEventListener('change', () => { q('[data-lf-pinwrap]').hidden = im.value !== 'rpc'; const ep = q('[data-lf-endpoint]'); if (ep && (!ep.value || ep.value === 'http://127.0.0.1:5001' || ep.value === 'https://ipfs.io')) ep.value = im.value === 'rpc' ? 'http://127.0.0.1:5001' : 'https://ipfs.io'; });
          const rg = q('[data-lf-region]'); const ep = q('[data-lf-endpoint]');
          if (rg && ep && flavour === 'aws') rg.addEventListener('input', () => { if (/^https:\/\/s3\.[a-z0-9-]*\.amazonaws\.com$/.test(ep.value) || !ep.value) ep.value = 'https://s3.' + (rg.value.trim() || 'us-east-1') + '.amazonaws.com'; });
        };
        wireKind();
        const kindSel = q('[data-lf-kind]');
        kindSel.addEventListener('change', () => { flavour = kindSel.value; hostKey = null; q('[data-lf-kindfields]').innerHTML = kindFieldsHtml(flavour, null, editing, roots); out.innerHTML = ''; wireKind(); });
        const collect = () => {
          const checked = (s) => { const el = q(s + ' input') || q(s); return !!(el && (el.checked || el.getAttribute('aria-checked') === 'true')); };
          let kind; let config; let secret = null;
          if (flavour === 'aws' || flavour === 'minio' || flavour === 's3') {
            kind = 's3';
            config = { endpoint: v('[data-lf-endpoint]').replace(/\/+$/, ''), region: v('[data-lf-region]') || 'us-east-1', bucket: v('[data-lf-bucket]'), prefix: v('[data-lf-prefix]'), pathStyle: v('[data-lf-pathstyle]') === 'path', flavour: flavour === 's3' ? 'self-hosted' : flavour };
            const akid = v('[data-lf-akid]'); const sk = q('[data-lf-secretkey]').value; const tok = q('[data-lf-token]').value;
            if (akid || sk) { secret = { accessKeyId: akid, secretAccessKey: sk }; if (tok) secret.sessionToken = tok; }
            if (!config.endpoint || !config.bucket) return { problem: 'Give the endpoint and the bucket.' };
          } else if (flavour === 'azure') {
            kind = 'azure';
            const account = v('[data-lf-account]');
            config = { account, container: v('[data-lf-container]'), prefix: v('[data-lf-prefix]'), endpoint: (v('[data-lf-endpoint]') || (account ? 'https://' + account + '.blob.core.windows.net' : '')).replace(/\/+$/, '') };
            const sv = q('[data-lf-azsecret]').value.trim();
            if (sv) secret = v('[data-lf-azauth]') === 'sas' ? { sas: sv.replace(/^\?/, '') } : { accountKey: sv };
            if (!config.account || !config.container) return { problem: 'Give the storage account and the container.' };
          } else if (flavour === 'local') {
            kind = 'local';
            config = { rootId: v('[data-lf-root]'), path: v('[data-lf-subpath]').replace(/^\/+/, '') };
            if (!config.rootId) return { problem: 'No local store is offered to this tenant.' };
          } else if (flavour === 'sftp') {
            kind = 'sftp';
            config = { host: v('[data-lf-host]'), port: parseInt(v('[data-lf-port]'), 10) || 22, username: v('[data-lf-user]'), root: v('[data-lf-rootpath]'), hostKey: hostKey };
            if (v('[data-lf-sftpauth]') === 'key') { const pk = q('[data-lf-privkey]').value.trim(); if (pk) { secret = { privateKey: pk }; const pp = q('[data-lf-passphrase]').value; if (pp) secret.passphrase = pp; } }
            else { const pw = q('[data-lf-password]').value; if (pw) secret = { password: pw }; }
            if (!config.host || !config.username) return { problem: 'Give the host and the username.' };
          } else if (flavour === 'ftp') {
            kind = 'ftp';
            config = { host: v('[data-lf-host]'), port: parseInt(v('[data-lf-port]'), 10) || 21, username: v('[data-lf-user]'), root: v('[data-lf-rootpath]'), tls: v('[data-lf-tls]') || 'explicit' };
            const pw = q('[data-lf-password]').value; if (pw) secret = { password: pw };
            if (!config.host || !config.username) return { problem: 'Give the host and the username.' };
          } else {
            kind = 'ipfs';
            config = { mode: v('[data-lf-ipfsmode]') || 'rpc', endpoint: v('[data-lf-endpoint]').replace(/\/+$/, ''), root: v('[data-lf-ipfsroot]'), pin: checked('[data-lf-pin]') };
            const au = q('[data-lf-ipfsauth]').value.trim(); if (au) secret = { authorization: au };
            if (!config.endpoint) return { problem: 'Give the endpoint.' };
          }
          return { kind, config, secret };
        };
        const showHostKey = (k) => { const el = q('[data-lf-hostkey]'); if (el && k) el.innerHTML = UI.notice('Host key <span class="mono" style="overflow-wrap:anywhere">' + esc(k) + '</span>. It is pinned when you save: a server that presents another key is refused.', 'info'); };
        q('[data-lf-test]').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget; const c = collect();
          if (c.problem) { out.innerHTML = UI.notice(esc(c.problem), 'warn'); return; }
          btn.disabled = true; out.innerHTML = UI.notice('Testing…', 'info');
          try {
            let r;
            if (editing && !c.secret) r = await App.post('/api/files/locations/' + enc(existing.id) + '/test');
            else { const body = { kind: c.kind, config: c.config }; if (c.secret) body.secret = c.secret; r = await App.post('/api/files/locations/test', body); }
            if (r.hostKey) { hostKey = r.hostKey; showHostKey(r.hostKey); }
            out.innerHTML = UI.notice('<b>' + (r.ok ? 'Connected.' : 'Not connected.') + '</b> ' + esc(r.detail || ''), r.ok ? 'ok' : 'warn');
          } catch (err) { out.innerHTML = problemHtml(err); }
          finally { btn.disabled = false; }
        });
        q('[data-lf-save]').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget; const c = collect();
          const name = v('[data-lf-name]');
          if (!name) { out.innerHTML = UI.notice('Give the location a name.', 'warn'); return; }
          if (c.problem) { out.innerHTML = UI.notice(esc(c.problem), 'warn'); return; }
          if (!editing && !c.secret && c.kind !== 'local' && c.kind !== 'ipfs') { out.innerHTML = UI.notice('Give the credentials.', 'warn'); return; }
          const checked = (s) => { const el = q(s + ' input') || q(s); return !!(el && (el.checked || el.getAttribute('aria-checked') === 'true')); };
          const body = { name, config: c.config, label: v('[data-lf-label]'), readOnly: checked('[data-lf-ro]') };
          if (c.secret) body.secret = c.secret;
          btn.disabled = true;
          try {
            let saved;
            if (editing) saved = await App.patch('/api/files/locations/' + enc(existing.id), body);
            else { body.kind = c.kind; if (App.me && App.me.workspace) body.workspaceId = App.me.workspace; saved = await App.post('/api/files/locations', body); }
            App.closeOverlay();
            const L = S(st); L.list = null; L.browse = null; L.testNote = null;
            ctx.toast(esc(saved.name || name) + (editing ? ' saved.' : ' linked.') + ' Audited.', 'ok');
            st.view = 'location'; st.locationId = saved.id || (editing ? existing.id : null); st.locPath = '';
            loadList(ctx); ctx.rerender();
          } catch (err) { btn.disabled = false; out.innerHTML = problemHtml(err); }
        });
      } });
  }

  // ---------- send a Files file out ----------
  async function sendTo(ctx, st, file) {
    const L = S(st);
    if (L.list == null) await loadList(ctx);
    const targets = (L.list || []).filter((l) => l.writable !== false && !l.readOnly);
    if (!targets.length) { ctx.toast('No writable linked storage in this workspace.' + (canLink() ? ' Link one under Linked in the left pane.' : ''), 'warn'); return; }
    let dir = '';
    ctx.modal({ title: 'Send ' + esc(file.name) + ' to linked storage',
      body: '<div class="formgrid">' + UI.field('Location', UI.select(targets.map((l) => ({ value: l.id, label: l.name + ' (' + kindName(l) + ', ' + l.label + ')' })), targets[0].id, 'data-ls-loc'))
        + UI.field('Name', UI.input(file.name, { attrs: 'data-ls-name' }), 'An existing file of the same path is replaced.') + '</div>'
        + '<div class="hstack wrap gap6"><span class="muted" style="font-size:12px">Folder: <b data-ls-dir>/</b></span>' + UI.btn('Browse folders', { size: 'sm', attrs: 'data-ls-browse' }) + '</div><div data-ls-list></div>'
        + '<p class="muted" style="font-size:12px;margin:0">The current version is copied out as it is served from Files (images without their metadata). A location labelled below the file refuses it.</p><div data-ls-out aria-live="polite"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send', { kind: 'primary', attrs: 'data-ls-ok' }),
      onMount(m) {
        const q = (s) => m.querySelector(s);
        const showDir = () => { q('[data-ls-dir]').textContent = '/' + dir; };
        const browse = async () => {
          const box = q('[data-ls-list]'); box.innerHTML = UI.notice('Listing…', 'info');
          try {
            const r = await App.get('/api/files/locations/' + enc(q('[data-ls-loc]').value) + '/browse?path=' + enc(dir));
            const dirs = (r.entries || []).filter((e) => e.dir);
            box.innerHTML = '<div class="vstack gap4" role="list" aria-label="Folders">' + (dir ? UI.listItem(UI.icon('undo', 13) + ' Up one level', '', { attrs: 'data-ls-go="' + esc(dir.split('/').slice(0, -1).join('/')) + '" role="listitem"' }) : '') + dirs.map((e) => UI.listItem(UI.icon('files', 13) + ' ' + esc(e.name), '', { attrs: 'data-ls-go="' + esc(e.path) + '" role="listitem"' })).join('') + (dirs.length || dir ? '' : '<span class="muted" style="font-size:12px">No folders here.</span>') + '</div>';
          } catch (err) { box.innerHTML = problemHtml(err); }
        };
        q('[data-ls-browse]').addEventListener('click', browse);
        q('[data-ls-loc]').addEventListener('change', () => { dir = ''; showDir(); q('[data-ls-list]').innerHTML = ''; });
        q('[data-ls-list]').addEventListener('click', (e) => { const b = e.target.closest('[data-ls-go]'); if (!b) return; dir = b.dataset.lsGo; showDir(); browse(); });
        q('[data-ls-ok]').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget; const name = q('[data-ls-name]').value.trim();
          if (!name || /[\\/\u0000-\u001f]/.test(name)) { q('[data-ls-out]').innerHTML = UI.notice('Give a name without / or \\.', 'warn'); return; }
          const locId = q('[data-ls-loc]').value; const l = targets.find((x) => x.id === locId);
          btn.disabled = true;
          try {
            const r = await App.post('/api/files/' + enc(file.id) + '/send', { locationId: locId, path: dir ? dir + '/' + name : name });
            App.closeOverlay();
            ctx.toast('Sent to ' + esc(l ? l.name : 'the location') + ' as ' + esc(r.path || name) + (r.cid ? ', CID ' + esc(r.cid) : r.etag ? ', ETag ' + esc(String(r.etag).replace(/"/g, '')) : '') + '. Audited.', 'ok', 7000);
            if (L.browse && L.browse.id === locId) L.browse = null;
          } catch (err) { btn.disabled = false; q('[data-ls-out]').innerHTML = problemHtml(err); }
        });
      } });
  }

  // ---------- fetch a URL ----------
  function fetchUrl(ctx, st) {
    const labels = labelChoices();
    ctx.modal({ title: 'Fetch a file by URL',
      body: '<div class="formgrid">' + UI.field('URL', UI.input('', { type: 'url', attrs: 'data-fu-url placeholder="https://example.org/report.pdf" spellcheck="false"' }), 'http or https. Redirects are followed host by host.')
        + UI.field('Name', UI.input('', { attrs: 'data-fu-name placeholder="optional: from the URL or the server"' }))
        + UI.field('Into folder', UI.select(folderOptions(st), curFolder(st), 'data-fu-folder'))
        + UI.field('Label', UI.select(labels, labels.indexOf('internal') >= 0 ? 'internal' : labels[labels.length - 1], 'data-fu-label')) + '</div>'
        + '<p class="muted" style="font-size:12px;margin:0">The host must be on this tenant\'s allowed hosts (Registry, Allowed hosts), or named by the operator when it is internal. The download is scanned like an upload.</p><div data-fu-out aria-live="polite"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Fetch', { kind: 'primary', attrs: 'data-fu-ok' }),
      onMount(m) {
        const q = (s) => m.querySelector(s);
        q('[data-fu-ok]').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget; const url = q('[data-fu-url]').value.trim();
          if (!/^https?:\/\/\S+$/i.test(url)) { q('[data-fu-out]').innerHTML = UI.notice('Give an http:// or https:// URL.', 'warn'); return; }
          const body = { url, label: q('[data-fu-label]').value };
          const name = q('[data-fu-name]').value.trim(); if (name) body.name = name;
          const folder = q('[data-fu-folder]').value; if (folder) body.folderId = folder;
          btn.disabled = true; btn.textContent = 'Fetching…';
          try { const out = await App.post('/api/files/import/url', body); App.closeOverlay(); ctx.toast('202: ' + esc(out.name) + ' fetched; it is scanned like an upload. Audited.', 'ok', 6000); selectNew(ctx, out); }
          catch (err) { btn.disabled = false; btn.textContent = 'Fetch'; q('[data-fu-out]').innerHTML = problemHtml(err); }
        });
      } });
  }

  // ---------- import from Exprsn AI ----------
  function sourceSub(kind) {
    if (kind === 'database') {
      return '<div class="formgrid">' + UI.field('Connection', UI.select([{ value: '', label: 'Loading connections…' }], '', 'data-if-conn')) + UI.field('Read', UI.select([{ value: 'object', label: 'A table or view' }, { value: 'saved', label: 'A saved query' }, { value: 'sql', label: 'A read-only SQL query' }], 'object', 'data-if-mode')) + '</div>'
        + '<div data-if-obj>' + UI.field('Table or view', UI.select([{ value: '', label: 'Choose a connection first' }], '', 'data-if-object'), 'Allow-listed objects of the connection; masked columns stay masked.') + '</div>'
        + '<div data-if-saved hidden>' + UI.field('Saved query', UI.select([{ value: '', label: 'Choose a connection first' }], '', 'data-if-savedq')) + '</div>'
        + '<div data-if-sql hidden>' + UI.field('SQL', UI.textarea('', { rows: 4, attrs: 'data-if-sqltext spellcheck="false" placeholder="select … from …"' }), 'Classified like any query: only reads run, within the connection\'s row limit.') + '</div>'
        + '<div class="formgrid">' + UI.field('Format', UI.select([{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'json', label: 'JSON' }], 'csv', 'data-if-format')) + UI.field('Name', UI.input('', { attrs: 'data-if-name placeholder="optional"' })) + '</div>';
    }
    const extra = kind === 'knowledge' ? UI.field('Save as', UI.select([{ value: 'original', label: 'The original file' }, { value: 'markdown', label: 'Markdown of its text' }, { value: 'text', label: 'Plain text' }], 'original', 'data-if-as'))
      : kind === 'agent-run' || kind === 'workflow-run' ? UI.field('Format', UI.select([{ value: 'markdown', label: 'Markdown (readable)' }, { value: 'json', label: 'JSON (complete)' }], 'markdown', 'data-if-format'))
        : '';
    const hint = { knowledge: 'Documents of knowledge bases you can read.', 'agent-run': 'Runs you started or may review: the answer, steps and tool calls.', 'workflow-run': 'Runs of workflows you can read: inputs, steps and outputs.', workflow: 'The signed exprsn-workflow/1 bundle, which imports into another tenant.', skill: 'The skill as Markdown with its front matter.', tool: 'The tool\'s definition and input schema as JSON.' }[kind] || '';
    return UI.field('Search', UI.input('', { type: 'search', attrs: 'data-if-q placeholder="Type to search" autocomplete="off"' }), hint)
      + '<div data-if-list class="vstack gap4" role="listbox" aria-label="Items to import" style="max-height:260px;overflow:auto"></div>'
      + (extra ? '<div class="formgrid">' + extra + '</div>' : '');
  }

  function importFrom(ctx, st, kind) {
    if (kind === 'url') { fetchUrl(ctx, st); return; }
    let k = kind && kind !== 'url' ? kind : 'database';
    ctx.modal({ cls: 'wide', title: 'Import into Files',
      body: '<div class="formgrid">' + UI.field('From', UI.select(IMPORT_KINDS.map((x) => ({ value: x[0], label: x[1] })), k, 'data-if-kind')) + UI.field('Into folder', UI.select(folderOptions(st), curFolder(st), 'data-if-folder')) + '</div>'
        + '<div data-if-sub>' + sourceSub(k) + '</div><div data-if-out aria-live="polite"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Import', { kind: 'primary', attrs: 'data-if-ok' }),
      onMount(m) {
        const q = (s) => m.querySelector(s);
        let picked = null; let timer = null; let seq = 0;
        const loadItems = (kindQ, extra, qtext) => App.get('/api/files/import/sources?kind=' + enc(kindQ) + (qtext ? '&q=' + enc(qtext) : '') + (extra || '')).then((r) => (Array.isArray(r) ? r : (r && r.items) || []));
        const drawList = () => {
          const box = q('[data-if-list]'); if (!box) return;
          const mySeq = ++seq; const text = (q('[data-if-q]') || {}).value || '';
          box.innerHTML = '<span class="muted" style="font-size:12px">Loading…</span>';
          loadItems(k, '', text.trim()).then((items) => {
            if (mySeq !== seq) return;
            if (!items.length) { box.innerHTML = '<span class="muted" style="font-size:12px">Nothing you can read matches.</span>'; return; }
            box.innerHTML = items.slice(0, 100).map((it) => '<button type="button" class="listlink' + (picked === it.id ? ' active' : '') + '" role="option" aria-selected="' + (picked === it.id ? 'true' : 'false') + '" data-if-pick="' + esc(it.id) + '"><span><span class="t">' + esc(it.name || it.id) + (it.label ? ' ' + UI.label(it.label, { sm: true }) : '') + '</span><span class="s">' + esc([it.sub, it.at ? when(it.at) : ''].filter(Boolean).join(' · ')) + '</span></span></button>').join('');
          }).catch((err) => { if (mySeq === seq) box.innerHTML = problemHtml(err); });
        };
        const wireDb = () => {
          const conn = q('[data-if-conn]'); const mode = q('[data-if-mode]');
          loadItems('database').then((items) => {
            conn.innerHTML = items.length ? items.map((it) => '<option value="' + esc(it.id) + '">' + esc(it.name + (it.sub ? ' (' + it.sub + ')' : '')) + '</option>').join('') : '<option value="">No connection you may query</option>';
            fillObjects();
          }).catch((err) => { q('[data-if-out]').innerHTML = problemHtml(err); });
          const fillObjects = () => {
            const id = conn.value; if (!id) return;
            const obj = q('[data-if-object]'); const sq = q('[data-if-savedq]');
            loadItems('database-object', '&connection=' + enc(id)).then((items) => { obj.innerHTML = items.length ? items.map((it) => '<option value="' + esc(it.id) + '">' + esc(it.name) + '</option>').join('') : '<option value="">No allow-listed table or view</option>'; }).catch(() => { obj.innerHTML = '<option value="">Could not list objects</option>'; });
            loadItems('saved-query', '&connection=' + enc(id)).then((items) => { sq.innerHTML = items.length ? items.map((it) => '<option value="' + esc(it.id) + '">' + esc(it.name) + '</option>').join('') : '<option value="">No saved query on this connection</option>'; }).catch(() => { sq.innerHTML = '<option value="">Could not list saved queries</option>'; });
          };
          conn.addEventListener('change', fillObjects);
          mode.addEventListener('change', () => { q('[data-if-obj]').hidden = mode.value !== 'object'; q('[data-if-saved]').hidden = mode.value !== 'saved'; q('[data-if-sql]').hidden = mode.value !== 'sql'; });
        };
        const wireSub = () => {
          picked = null;
          if (k === 'database') { wireDb(); return; }
          const input = q('[data-if-q]');
          input.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(drawList, 300); });
          drawList();
        };
        q('[data-if-sub]').addEventListener('click', (e) => {
          const b = e.target.closest('[data-if-pick]'); if (!b) return;
          picked = b.dataset.ifPick;
          m.querySelectorAll('[data-if-pick]').forEach((x) => { const on = x.dataset.ifPick === picked; x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
        });
        wireSub();
        const kindSel = q('[data-if-kind]');
        kindSel.addEventListener('change', () => {
          if (kindSel.value === 'url') { App.closeOverlay(); setTimeout(() => fetchUrl(ctx, st), 0); return; }
          k = kindSel.value; q('[data-if-sub]').innerHTML = sourceSub(k); q('[data-if-out]').innerHTML = ''; wireSub();
        });
        q('[data-if-ok]').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget; const outEl = q('[data-if-out]');
          const folder = q('[data-if-folder]').value;
          let route; let body = {};
          if (k === 'database') {
            const conn = q('[data-if-conn]').value; const mode = q('[data-if-mode]').value;
            if (!conn) { outEl.innerHTML = UI.notice('Choose a connection.', 'warn'); return; }
            body = { connectionId: conn, format: q('[data-if-format]').value };
            if (mode === 'object') { const o = q('[data-if-object]').value; if (!o) { outEl.innerHTML = UI.notice('Choose a table or view.', 'warn'); return; } body.object = o; }
            else if (mode === 'saved') { const s = q('[data-if-savedq]').value; if (!s) { outEl.innerHTML = UI.notice('Choose a saved query.', 'warn'); return; } body.savedQueryId = s; }
            else { const sql = q('[data-if-sqltext]').value.trim(); if (!sql) { outEl.innerHTML = UI.notice('Write the query.', 'warn'); return; } body.sql = sql; }
            const name = q('[data-if-name]').value.trim(); if (name) body.name = name;
            route = 'database';
          } else {
            if (!picked) { outEl.innerHTML = UI.notice('Choose what to import.', 'warn'); return; }
            if (k === 'knowledge') body = { documentId: picked, as: q('[data-if-as]').value };
            else if (k === 'agent-run' || k === 'workflow-run') body = { runId: picked, format: q('[data-if-format]').value };
            else if (k === 'workflow') body = { workflowId: picked };
            else if (k === 'skill') body = { skillId: picked };
            else body = { toolId: picked };
            route = k;
          }
          if (folder) body.folderId = folder;
          btn.disabled = true; btn.textContent = 'Importing…';
          try {
            const out = await App.post('/api/files/import/' + route, body);
            App.closeOverlay();
            ctx.toast('202: ' + esc(out.name) + ' saved in Files; it is scanned like an upload. Audited.', 'ok', 6000);
            selectNew(ctx, out);
          } catch (err) { btn.disabled = false; btn.textContent = 'Import'; outEl.innerHTML = problemHtml(err); }
        });
      } });
  }

  App.filesLocations = { leftPane, render, wire, importFrom, fetchUrl, sendTo, addLocation, reload: (ctx) => { S(ctx.state).list = null; return loadList(ctx); } };
})();
