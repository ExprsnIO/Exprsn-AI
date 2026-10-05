(function () {
  const { UI, esc } = App;

  // ---------- demo data (Finance Ops workspace of the Northwind tenant) ----------
  const TYPES = ['text', 'Markdown', 'CSV', 'JSON', 'HTML', 'PDF', 'Word', 'Excel', 'PowerPoint', 'PNG', 'JPEG', 'WebP', 'GIF'];
  const GB = 1024 * 1024 * 1024, MB = 1024 * 1024, KB = 1024;
  const fmtBytes = (n) => n >= GB ? (n / GB).toFixed(1) + ' GB' : n >= MB ? (n / MB).toFixed(1) + ' MB' : n >= KB ? Math.round(n / KB) + ' KB' : n + ' B';
  const sha = (seed) => { let h = ''; for (let i = 0; i < 16; i++) h += ((seed * 2654435761 + i * 40503) >>> 0).toString(16).padStart(8, '0'); return h.slice(0, 64); };

  const baseFolders = () => [
    { id: 'root', name: 'Finance Ops', parentId: null },
    { id: 'f-close', name: 'Close 2026-Q3', parentId: 'root' },
    { id: 'f-receipts', name: 'Receipts', parentId: 'f-close' },
    { id: 'f-contracts', name: 'Contracts', parentId: 'root' },
    { id: 'f-board', name: 'Board packs', parentId: 'root' }
  ];
  const v = (n, state, size, type, label, by, at, extra) => Object.assign({ number: n, state, size, sha256: sha(n * 7 + size), type, label, reason: null, findings: null, restoredFrom: null, createdBy: by, createdAt: at, scannedAt: state === 'quarantined' ? null : at }, extra || {});
  const baseFiles = () => [
    { id: 'fi-1', name: 'Q3 travel reconciliation.xlsx', folderId: 'f-close', owner: 'Mara Okafor', label: 'confidential', state: 'ready', size: 2.4 * MB, type: 'Excel', currentVersion: 3, tags: ['q3', 'travel', 'close'], access: 'workspace', preview: 'unavailable', updatedAt: '19 Sep 13:26',
      versions: [v(3, 'ready', 2.4 * MB, 'Excel', 'confidential', 'Mara Okafor', '19 Sep 13:26'), v(2, 'ready', 2.3 * MB, 'Excel', 'confidential', 'Mara Okafor', '18 Sep 17:40'), v(1, 'ready', 2.1 * MB, 'Excel', 'confidential', 'Tomasz Weber', '15 Sep 09:02')],
      shares: [{ id: 's-1', kind: 'user', who: 'Priya Nair', anonymous: false, expiresAt: null, maxUses: null, uses: 4, state: 'active', createdAt: '16 Sep 10:00' }] },
    { id: 'fi-2', name: 'Fabrikam MSA 2025.pdf', folderId: 'f-contracts', owner: 'Lena Hoffmann', label: 'internal', state: 'ready', size: 8.7 * MB, type: 'PDF', currentVersion: 2, tags: ['contract', 'fabrikam'], access: 'workspace', preview: 'ready', updatedAt: '12 Sep 11:00',
      versions: [v(2, 'ready', 8.7 * MB, 'PDF', 'internal', 'Lena Hoffmann', '12 Sep 11:00'), v(1, 'ready', 8.6 * MB, 'PDF', 'internal', 'Lena Hoffmann', '3 Feb 2026')],
      shares: [{ id: 's-2', kind: 'workspace', who: 'Field Sales', anonymous: false, expiresAt: null, maxUses: null, uses: 11, state: 'active', createdAt: '12 Sep 11:05' }, { id: 's-3', kind: 'link', who: 'Link exf_…c41a', anonymous: false, expiresAt: '26 Sep 11:05', maxUses: 5, uses: 2, state: 'active', createdAt: '19 Sep 11:05' }] },
    { id: 'fi-3', name: 'card-feed-2026-09.csv', folderId: 'f-close', owner: 'Tomasz Weber', label: 'confidential', state: 'ready', size: 640 * KB, type: 'CSV', currentVersion: 4, tags: ['cards', 'feed'], access: 'workspace', preview: null, updatedAt: '19 Sep 08:15',
      versions: [v(4, 'ready', 640 * KB, 'CSV', 'confidential', 'Tomasz Weber', '19 Sep 08:15'), v(3, 'rejected', 655 * KB, 'CSV', 'confidential', 'Tomasz Weber', '19 Sep 08:02', { reason: 'ClamAV: Eicar-Test-Signature', findings: ['Eicar-Test-Signature at offset 0'] }), v(2, 'ready', 612 * KB, 'CSV', 'confidential', 'Tomasz Weber', '12 Sep 08:10'), v(1, 'ready', 590 * KB, 'CSV', 'confidential', 'Tomasz Weber', '5 Sep 08:10')],
      shares: [] },
    { id: 'fi-4', name: 'Board pack September.pptx', folderId: 'f-board', owner: 'Jonas Lindqvist', label: 'confidential', state: 'ready', size: 48 * MB, type: 'PowerPoint', currentVersion: 1, tags: ['board'], access: 'workspace', preview: 'unavailable', updatedAt: '17 Sep 16:20',
      versions: [v(1, 'ready', 48 * MB, 'PowerPoint', 'confidential', 'Jonas Lindqvist', '17 Sep 16:20')], shares: [] },
    { id: 'fi-5', name: 'Lisbon exception memo.docx', folderId: 'f-close', owner: 'Mara Okafor', label: 'confidential', state: 'ready', size: 180 * KB, type: 'Word', currentVersion: 2, tags: ['lisbon', 'exception'], access: 'workspace', preview: 'queued', updatedAt: '19 Sep 14:01',
      versions: [v(2, 'ready', 180 * KB, 'Word', 'confidential', 'Mara Okafor', '19 Sep 14:01', { restoredFrom: 1 }), v(1, 'ready', 180 * KB, 'Word', 'confidential', 'Mara Okafor', '18 Sep 09:30')], shares: [] },
    { id: 'fi-6', name: 'receipt-0917-lis.jpg', folderId: 'f-receipts', owner: 'Mara Okafor', label: 'internal', state: 'ready', size: 1.1 * MB, type: 'JPEG', currentVersion: 1, tags: ['receipt', 'lisbon'], access: 'workspace', preview: 'ready', updatedAt: '17 Sep 19:12',
      versions: [v(1, 'ready', 1.1 * MB, 'JPEG', 'internal', 'Mara Okafor', '17 Sep 19:12')], shares: [] },
    { id: 'fi-7', name: 'receipt-0918-taxi.png', folderId: 'f-receipts', owner: 'Mara Okafor', label: 'internal', state: 'pending', size: 2.0 * MB, type: 'PNG', currentVersion: 0, tags: ['receipt'], access: 'workspace', preview: null, updatedAt: '19 Sep 14:05',
      versions: [v(1, 'quarantined', 2.0 * MB, null, 'internal', 'Mara Okafor', '19 Sep 14:05')], shares: [] },
    { id: 'fi-8', name: 'vendor-notes.md', folderId: 'root', owner: 'Lena Hoffmann', label: 'internal', state: 'ready', size: 12 * KB, type: 'Markdown', currentVersion: 6, tags: ['vendors'], access: 'workspace', preview: null, updatedAt: '11 Sep 10:40',
      versions: [v(6, 'ready', 12 * KB, 'Markdown', 'internal', 'Lena Hoffmann', '11 Sep 10:40'), v(5, 'ready', 11 * KB, 'Markdown', 'internal', 'Lena Hoffmann', '4 Sep 10:40')], shares: [] },
    { id: 'fi-9', name: 'close-checklist.json', folderId: 'f-close', owner: 'Felix Brandt', label: 'internal', state: 'rejected', size: 3 * KB, type: 'JSON', currentVersion: 0, tags: [], access: 'workspace', preview: null, updatedAt: '18 Sep 12:00',
      versions: [v(1, 'rejected', 3 * KB, 'JSON', 'confidential', 'Felix Brandt', '18 Sep 12:00', { reason: 'Label confidential is above the uploader\'s clearance (internal)', findings: ['label above clearance'] })], shares: [] },
    { id: 'fi-10', name: 'All-hands recording notes.txt', folderId: 'root', owner: 'Noor Rahimi', label: 'public', state: 'ready', size: 44 * KB, type: 'text', currentVersion: 1, tags: ['all-hands'], access: 'workspace', preview: null, updatedAt: '9 Sep 15:00',
      versions: [v(1, 'ready', 44 * KB, 'text', 'public', 'Noor Rahimi', '9 Sep 15:00')],
      shares: [{ id: 's-4', kind: 'link', who: 'Anonymous link exf_…9b02', anonymous: true, expiresAt: '16 Sep 15:00', maxUses: 50, uses: 50, state: 'used up', createdAt: '9 Sep 15:02' }, { id: 's-5', kind: 'group', who: 'cn=finance-leads', anonymous: false, expiresAt: null, maxUses: null, uses: 3, state: 'active', createdAt: '9 Sep 15:03' }] }
  ];
  const baseTrash = () => [
    { kind: 'file', id: 'fi-90', name: 'Q2 travel reconciliation (old).xlsx', folderName: 'Close 2026-Q2', folderGone: true, size: 2.2 * MB, type: 'Excel', label: 'confidential', trashedAt: '2 Sep 09:00', purgeAfter: '2 Oct 09:00', by: 'Mara Okafor' },
    { kind: 'folder', id: 'f-q2', name: 'Close 2026-Q2', folderName: 'Finance Ops', folderGone: false, size: 14.8 * MB, files: 9, folders: 1, label: 'confidential', trashedAt: '2 Sep 09:01', purgeAfter: '2 Oct 09:01', by: 'Mara Okafor' },
    { kind: 'file', id: 'fi-91', name: 'vendor-notes.md', folderName: 'Finance Ops', folderGone: false, size: 9 * KB, type: 'Markdown', label: 'internal', trashedAt: '15 Sep 17:30', purgeAfter: '15 Oct 17:30', by: 'Lena Hoffmann' }
  ];
  const baseShared = () => [
    { id: 'sh-1', name: 'Hiring plan FY27.xlsx', from: 'Noor Rahimi', via: 'shared with you', workspace: 'People Ops', label: 'internal', size: 1.3 * MB, type: 'Excel', expiresAt: null, updatedAt: '18 Sep 10:12' },
    { id: 'sh-2', name: 'Territory map 2026.pdf', from: 'Samir Haddad', via: 'via workspace Finance Ops', workspace: 'Field Sales', label: 'internal', size: 5.9 * MB, type: 'PDF', expiresAt: '30 Sep', updatedAt: '14 Sep 08:45' },
    { id: 'sh-3', name: 'finance-leads minutes.md', from: 'Jonas Lindqvist', via: 'via group cn=finance-leads', workspace: 'Finance Ops', label: 'confidential', size: 20 * KB, type: 'Markdown', expiresAt: null, updatedAt: '19 Sep 09:00' }
  ];
  const USAGE = { ws: { used: 18.4 * GB, max: 50 * GB, files: 10 }, tenant: { used: 112 * GB, max: 500 * GB, files: 1842 }, maxUpload: 2 * GB, trashDays: 30 };

  const typePill = (t) => t ? UI.pill(t, 'outline') : '<span class="muted">sniffing</span>';
  const statePill = (s) => UI.pill(s, s === 'ready' ? 'ok' : s === 'rejected' ? 'danger' : 'warn');
  const shareState = (s) => UI.pill(s, s === 'active' ? 'ok' : s === 'revoked' ? 'danger' : 'warn');
  const previewText = (p) => p === 'ready' ? 'ready' : p === 'queued' ? 'drawing (409 until ready)' : p === 'failed' ? 'failed' : p === 'unavailable' ? 'unavailable' : 'none for this type';
  function openMenu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }
  const clearanceOrder = { public: 1, internal: 2, confidential: 3, restricted: 4 };

  App.register({
    id: 'files', title: 'Files', summary: 'Folders, quarantined uploads, versions with restore, trash, shares and links, quotas, previews', crumb: (st) => ['Files'].concat(st.view === 'trash' ? ['Trash'] : st.view === 'shared' ? ['Shared with me'] : []),
    label: (st) => { const f = (st.files || []).find((x) => x.id === st.sel); return f ? f.label : null; },
    commands: [{ label: 'Upload a file', sub: 'Files', run(app) { app.stateFor('files').openUpload = true; app.render(); } }],
    states: [
      { title: 'Version rejected by scan', tone: 'danger', text: 'ClamAV found a signature in version 3 of card-feed-2026-09.csv. The version is never served; the earlier ready version stays current and the uploader is told why.', apply(ctx) { const st = ctx.state; st.view = 'folder'; st.folder = 'f-close'; st.sel = 'fi-3'; st.problem = null; st.rejectedNote = true; ctx.rerender(); } },
      { title: 'Upload over quota', tone: 'danger', text: '413 while the bytes arrive, naming the limit, the scope, what is used and what came in. Nothing is stored.', apply(ctx) { const st = ctx.state; st.view = 'folder'; st.problem = { title: 'Upload refused: storage quota', text: '413 {limit: storage_bytes, scope: workspace, used: 18.4 GB, max: 50 GB, incoming: 34.0 GB}. Finance Ops would pass its 50 GB limit. Empty the trash or ask a tenant admin to raise the workspace quota.' }; ctx.rerender(); } },
      { title: 'Link used up', tone: 'warn', text: 'A link past its use limit, expired or revoked is refused with the same 404 as an unknown token. The owner sees it as used up here.', apply(ctx) { const st = ctx.state; st.view = 'folder'; st.folder = 'root'; st.sel = 'fi-10'; st.problem = null; st.linkNote = true; ctx.rerender(); } },
      { title: 'Preview unavailable', tone: 'neutral', text: 'A preview exists for images and the first page of a PDF, within FILES_PREVIEW_MAX_BYTES and with the tool installed. Otherwise the inspector says so and offers the download.', apply(ctx) { const st = ctx.state; st.view = 'folder'; st.folder = 'f-board'; st.sel = 'fi-4'; st.problem = null; st.previewNote = true; ctx.rerender(); } },
      { title: 'Restored to the root', tone: 'info', text: 'A file whose folder is gone comes back at the workspace root; a clashing name gets " (2)".', apply(ctx) { const st = ctx.state; const t = st.trash.find((x) => x.id === 'fi-90'); if (t) restoreFromTrash(ctx, t, true); else { st.view = 'folder'; st.folder = 'root'; ctx.rerender(); } } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.files) { st.files = baseFiles(); st.folders = baseFolders(); st.trash = baseTrash(); st.shared = baseShared(); st.usage = JSON.parse(JSON.stringify(USAGE)); st.view = 'folder'; st.folder = 'root'; st.query = ''; st.mode = 'list'; st.typeFilter = 'all'; st.stateFilter = 'all'; st.labelFilter = 'all'; st.sort = 'updated'; st.sortDir = 'desc'; st.tagFilter = null; }
      if (ctx.params.folder) { st.folder = ctx.params.folder; st.view = 'folder'; delete ctx.params.folder; }
      if (ctx.params.file) { const f = st.files.find((x) => x.id === ctx.params.file); if (f) { st.sel = f.id; st.folder = f.folderId; st.view = 'folder'; } delete ctx.params.file; }
      if (ctx.params.view) { st.view = ctx.params.view; delete ctx.params.view; }
      if (!st.folders.some((f) => f.id === st.folder)) st.folder = 'root';
      const folder = st.folders.find((f) => f.id === st.folder);
      const path = []; for (let f = folder; f; f = st.folders.find((x) => x.id === f.parentId)) path.unshift(f);
      const children = st.folders.filter((f) => f.parentId === st.folder);
      const sel = st.files.find((f) => f.id === st.sel) || null;

      // ----- left pane: folder tree -----
      const tree = (pid, depth) => st.folders.filter((f) => f.parentId === pid).map((f) => { const n = st.files.filter((x) => x.folderId === f.id).length; return UI.listItem('<span style="padding-left:' + (depth * 12) + 'px">' + UI.icon('files', 13) + ' ' + esc(f.name) + '</span>', '', { active: st.view === 'folder' && f.id === st.folder, attrs: 'data-folder="' + esc(f.id) + '"', right: n ? '<span class="muted" style="font-size:11px">' + n + '</span>' : '' }) + tree(f.id, depth + 1); }).join('');
      const used = st.usage.ws.used / st.usage.ws.max;
      const left = '<div class="leftpane"><div class="hstack"><div class="eyebrow grow">Folders</div>' + UI.iconbtn('plus', 'New folder', { attrs: 'data-newfolder', cls: 'sm ghost' }) + '</div>'
        + '<div class="vstack gap4">' + tree(null, 0) + '</div><div class="divider"></div>'
        + UI.listItem(UI.icon('trash', 13) + ' Trash', st.trash.length + ' items, purged after ' + st.usage.trashDays + ' days', { active: st.view === 'trash', attrs: 'data-view="trash"' })
        + UI.listItem(UI.icon('link', 13) + ' Shared with me', st.shared.length + ' files', { active: st.view === 'shared', attrs: 'data-view="shared"' })
        + '<div style="margin-top:auto" class="vstack gap6"><div class="eyebrow">Storage</div>' + UI.meter('Finance Ops', fmtBytes(st.usage.ws.used) + ' of ' + fmtBytes(st.usage.ws.max), used * 100, used > 0.8 ? 'warn' : 'accent') + UI.meter('Northwind tenant', fmtBytes(st.usage.tenant.used) + ' of ' + fmtBytes(st.usage.tenant.max), (st.usage.tenant.used / st.usage.tenant.max) * 100) + '<span class="muted" style="font-size:11px">Uploads up to ' + fmtBytes(st.usage.maxUpload) + '. Stored and quarantined versions count, trash too until purged; previews do not. <a href="#" data-gousage>Storage report</a></span></div></div>';

      // ----- main -----
      let main = '';
      if (st.view === 'trash') main = renderTrash(ctx);
      else if (st.view === 'shared') main = renderShared(ctx);
      else {
        let files = st.files.filter((f) => f.folderId === st.folder);
        if (st.query) { const q = st.query.toLowerCase(); files = st.files.filter((f) => f.name.toLowerCase().includes(q) || f.tags.some((t) => t.includes(q))); }
        if (st.tagFilter) files = files.filter((f) => f.tags.includes(st.tagFilter));
        if (st.typeFilter !== 'all') files = files.filter((f) => f.type === st.typeFilter);
        if (st.stateFilter !== 'all') files = files.filter((f) => f.state === st.stateFilter);
        if (st.labelFilter !== 'all') files = files.filter((f) => f.label === st.labelFilter);
        const dir = st.sortDir === 'asc' ? 1 : -1;
        files = files.slice().sort((a, b) => { if (st.sort === 'name') return a.name.localeCompare(b.name) * dir; if (st.sort === 'size') return (a.size - b.size) * dir; if (st.sort === 'type') return String(a.type).localeCompare(String(b.type)) * dir; return st.files.indexOf(b) - st.files.indexOf(a) > 0 ? (a.updatedAt < b.updatedAt ? dir : -dir) : (a.updatedAt < b.updatedAt ? dir : -dir); });
        const crumbs = path.map((p, i) => i < path.length - 1 ? '<a href="#" data-folder="' + esc(p.id) + '">' + esc(p.name) + '</a> <span class="muted">/</span> ' : '<b>' + esc(p.name) + '</b>').join('');
        const sortLabel = { name: 'Name', size: 'Size', updated: 'Updated', type: 'Type' }[st.sort] + ' ' + (st.sortDir === 'asc' ? '↑' : '↓');
        const toolbar = '<div class="toolbar">' + UI.search('Search names and tags', 'data-search', st.query)
          + UI.seg([{ id: 'list', label: 'List' }, { id: 'grid', label: 'Grid' }], st.mode, 'data-mode')
          + '<span class="relative">' + UI.btn(st.typeFilter === 'all' ? 'Type' : 'Type: ' + st.typeFilter, { size: 'sm', icon: 'filter', attrs: 'data-typemenu', cls: st.typeFilter === 'all' ? '' : 'active' }) + '</span>'
          + '<span class="relative">' + UI.btn(st.stateFilter === 'all' ? 'State' : 'State: ' + st.stateFilter, { size: 'sm', attrs: 'data-statemenu', cls: st.stateFilter === 'all' ? '' : 'active' }) + '</span>'
          + '<span class="relative">' + UI.btn(st.labelFilter === 'all' ? 'Label' : 'Label: ' + st.labelFilter, { size: 'sm', attrs: 'data-labelmenu', cls: st.labelFilter === 'all' ? '' : 'active' }) + '</span>'
          + '<span class="relative">' + UI.btn(sortLabel, { size: 'sm', icon: 'sort', attrs: 'data-sortmenu' }) + '</span>'
          + (st.tagFilter ? UI.chip('tag: ' + esc(st.tagFilter) + ' <span class="x" data-cleartag>×</span>', true) : '')
          + '<span class="muted right" style="font-size:12px">' + files.length + ' file' + (files.length === 1 ? '' : 's') + (st.query ? ' across the workspace' : '') + '</span></div>';
        const folderCards = !st.query && children.length ? '<div class="hstack wrap gap6">' + children.map((c) => UI.btn(c.name, { size: 'sm', icon: 'files', attrs: 'data-folder="' + esc(c.id) + '"' })).join('') + '</div>' : '';
        let listHtml;
        if (st.mode === 'grid') {
          listHtml = '<div class="grid4">' + files.map((f) => '<button type="button" class="files-card ' + (f.id === st.sel ? 'selected' : '') + '" data-file="' + esc(f.id) + '"><div class="files-thumb">' + (f.preview === 'ready' ? '<span class="files-img" aria-hidden="true"></span>' : UI.icon(f.type === 'PDF' || f.type === 'Word' ? 'knowledge' : /PNG|JPEG|WebP|GIF/.test(f.type) ? 'images' : 'runs', 26)) + '</div><div class="t">' + esc(f.name) + '</div><div class="s">' + esc(fmtBytes(f.size)) + ' · ' + esc(f.type || 'pending') + '</div><div class="hstack gap4">' + statePill(f.state) + UI.label(f.label, { sm: true }) + '</div></button>').join('') + '</div>' + (files.length ? '' : UI.empty('No files here', 'Upload one or clear the filters.'));
        } else {
          listHtml = UI.table(['Name', 'Type', 'Size', 'Label', 'State', 'Version', 'Owner', 'Updated', 'Tags'], files.map((f) => ({ cells: ['<span style="font-weight:600">' + esc(f.name) + '</span>' + (st.query ? '<div class="muted" style="font-size:11px">' + esc((st.folders.find((x) => x.id === f.folderId) || {}).name || '') + '</div>' : ''), typePill(f.type), '<span class="num">' + esc(fmtBytes(f.size)) + '</span>', UI.label(f.label, { sm: true }), statePill(f.state), f.currentVersion ? '<span class="num">' + f.currentVersion + '</span>' : '<span class="muted">none ready</span>', esc(f.owner), esc(f.updatedAt), f.tags.map((t) => '<a href="#" data-tag="' + esc(t) + '" class="mono" style="font-size:11px">' + esc(t) + '</a>').join(' ')], attrs: 'data-file="' + esc(f.id) + '"', selected: f.id === st.sel })), { minWidth: '820px', emptyTitle: 'No files here', emptyText: 'Upload one or clear the filters.' });
        }
        main = UI.pagehead('Files', '<span class="files-crumbs">' + crumbs + '</span> <span class="muted">' + (function (n, m) { return n + ' file' + (n === 1 ? '' : 's') + ', ' + m + ' folder' + (m === 1 ? '' : 's'); })(st.files.filter((f) => f.folderId === st.folder).length, children.length) + '</span>', UI.btn('Upload', { kind: 'primary', icon: 'upload', attrs: 'data-upload' }) + UI.btn('New folder', { icon: 'plus', attrs: 'data-newfolder' }) + (st.folder !== 'root' ? UI.btn('Knowledge source', { icon: 'knowledge', attrs: 'data-ksource', title: 'Add this folder as a knowledge source' }) + UI.btn('Rename', { kind: 'ghost', attrs: 'data-renamefolder' }) + UI.btn('Trash folder', { kind: 'ghost', attrs: 'data-trashfolder' }) : ''))
          + (st.problem ? UI.problem(st.problem.title, st.problem.text, '7e3b1a9c4d2f4e8a9b0c1d2e3f4a5b6c') : '')
          + (st.uploaded ? UI.notice('<b>' + esc(st.uploaded.name) + ' accepted (202).</b> Version 1 is quarantined: the bytes are sealed, then the file.scan job sniffs the type, classifies text, runs ClamAV and checks the label against your clearance and the workspace ceiling. Only a ready version is served. You get <span class="mono">file.state</span> when it is decided.', 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearupload' })) : '')
          + toolbar + folderCards + listHtml;
      }

      // ----- inspector -----
      let inspector = '';
      if (st.view === 'folder') {
        if (sel) inspector = renderInspector(ctx, sel);
        else inspector = '<aside class="inspector w300" aria-label="File">' + UI.empty('Nothing selected', 'Select a file to see its versions, shares, tags and preview.') + '</aside>';
      }

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .files-crumbs a{color:inherit}'
        + '#main .files-card{display:flex;flex-direction:column;gap:6px;text-align:left;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);cursor:pointer;font-family:inherit;min-width:0}'
        + '#main .files-card:hover{border-color:var(--muted)}#main .files-card.selected{background:var(--accent-tint);border-color:var(--accent)}'
        + '#main .files-card .t{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#main .files-card .s{font-size:12px;color:var(--muted)}'
        + '#main .files-thumb{height:72px;border-radius:6px;background:var(--sel);display:flex;align-items:center;justify-content:center;color:var(--muted)}'
        + '#main .files-img{display:block;width:100%;height:100%;border-radius:6px;background:linear-gradient(135deg,var(--accent-tint),var(--sel) 60%,var(--line2))}'
        + '#main .files-preview{height:140px;border-radius:6px;background:var(--sel);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;text-align:center;padding:8px}'
        + '#main .files-preview.ready{background:linear-gradient(135deg,var(--accent-tint),var(--sel) 60%,var(--line2))}'
        + '#main .files-tags{display:flex;flex-wrap:wrap;gap:4px}'
        + '</style>'
        + left + '<div class="page">' + main
        + '</div>' + inspector;

      // ----- events -----
      ctx.on('click', '[data-folder]', (e, t) => { e.preventDefault(); st.folder = t.dataset.folder; st.view = 'folder'; st.query = ''; st.tagFilter = null; st.problem = null; ctx.rerender(); });
      ctx.on('click', '[data-view]', (e, t) => { st.view = t.dataset.view; st.problem = null; ctx.rerender(); });
      ctx.on('click', '[data-file]', (e, t) => { if (e.target.closest('a')) return; st.sel = t.dataset.file; st.rejectedNote = false; st.linkNote = false; st.previewNote = false; ctx.rerender(); });
      ctx.on('click', '[data-tag]', (e, t) => { e.preventDefault(); st.tagFilter = t.dataset.tag; st.query = ''; ctx.rerender(); });
      ctx.on('click', '[data-cleartag]', () => { st.tagFilter = null; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const vv = t.value; ctx.rerender(); const el = ctx.$('[data-search]'); if (el) { el.focus(); el.value = vv; el.setSelectionRange(vv.length, vv.length); } });
      ctx.on('click', '[data-mode] [data-seg]', (e, t) => { st.mode = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-typemenu]', (e, t) => openMenu(ctx, t, [['all', 'All types']].concat(TYPES.map((x) => [x, x])), st.typeFilter, (vv) => { st.typeFilter = vv; ctx.rerender(); }));
      ctx.on('click', '[data-statemenu]', (e, t) => openMenu(ctx, t, [['all', 'All states'], ['ready', 'ready'], ['pending', 'pending (quarantined)'], ['rejected', 'rejected']], st.stateFilter, (vv) => { st.stateFilter = vv; ctx.rerender(); }));
      ctx.on('click', '[data-labelmenu]', (e, t) => openMenu(ctx, t, [['all', 'All labels'], ['public', 'public'], ['internal', 'internal'], ['confidential', 'confidential']], st.labelFilter, (vv) => { st.labelFilter = vv; ctx.rerender(); }));
      ctx.on('click', '[data-sortmenu]', (e, t) => openMenu(ctx, t, [['name:asc', 'Name A to Z'], ['name:desc', 'Name Z to A'], ['size:desc', 'Largest first'], ['size:asc', 'Smallest first'], ['updated:desc', 'Recently updated'], ['updated:asc', 'Oldest update'], ['type:asc', 'By type']], st.sort + ':' + st.sortDir, (vv) => { const [s, d] = vv.split(':'); st.sort = s; st.sortDir = d; ctx.rerender(); }));
      ctx.on('click', '[data-gousage]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
      ctx.on('click', '[data-clearupload]', () => { st.uploaded = null; ctx.rerender(); });
      ctx.on('click', '[data-ksource]', async () => { const ok = await ctx.confirm({ title: 'Add ' + esc(folder.name) + ' as a knowledge source', tone: 'info', body: '<p class="fg2" style="margin:0">The folder and its subfolders become a source of a knowledge base you curate. Each sync indexes its ready files of a knowledge type up to the base\'s label, named by their path below the folder; chat cites them like any document.</p>' + UI.field('Knowledge base', UI.select(['Finance policies (confidential)', 'Contracts KB (internal)'], 'Finance policies (confidential)')), kv: [['Folder', folder.name], ['Ready files', st.files.filter((f) => f.folderId === folder.id && f.state === 'ready').length]], ok: 'Add source' }); if (!ok) return; ctx.toast('Source folder: ' + esc(folder.name) + ' added to Finance policies. First sync queued.', 'ok'); ctx.navigate('knowledge', { kb: 'finance-policies' }); });
      ctx.on('click', '[data-newfolder]', () => ctx.modal({ title: 'New folder in ' + esc(folder.name), body: UI.field('Name', UI.input('', { placeholder: '1 to 255 characters, no / or \\', attrs: 'data-nf-name' }), 'Unique in its folder, case-insensitive.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-nf-ok' }), onMount(m) { m.querySelector('[data-nf-ok]').addEventListener('click', () => { const name = m.querySelector('[data-nf-name]').value.trim(); if (!name || /[\\/\u0000-\u001f]/.test(name) || name.length > 255) { ctx.toast('400: names are 1 to 255 characters without / or \\.', 'danger'); return; } if (st.folders.some((f) => f.parentId === st.folder && f.name.toLowerCase() === name.toLowerCase()) || st.files.some((f) => f.folderId === st.folder && f.name.toLowerCase() === name.toLowerCase())) { ctx.toast('409: the name is taken in this folder.', 'danger'); return; } const id = 'f-' + Math.random().toString(36).slice(2, 7); st.folders.push({ id, name, parentId: st.folder }); App.closeOverlay(); ctx.rerender(); ctx.toast('Folder ' + esc(name) + ' created (201). Audited file.folder.created.', 'ok'); }); } }));
      ctx.on('click', '[data-renamefolder]', () => ctx.modal({ title: 'Rename or move ' + esc(folder.name), body: '<div class="formgrid">' + UI.field('Name', UI.input(folder.name, { attrs: 'data-rf-name' })) + UI.field('Parent', UI.select(st.folders.filter((f) => f.id !== folder.id && !path.some((p) => p.id === f.id && f.id !== folder.parentId)).map((f) => ({ value: f.id, label: f.name })), folder.parentId, 'data-rf-parent'), 'Within the workspace, not into itself.') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-rf-ok' }), onMount(m) { m.querySelector('[data-rf-ok]').addEventListener('click', () => { const name = m.querySelector('[data-rf-name]').value.trim(); const parent = m.querySelector('[data-rf-parent]').value; if (st.folders.some((f) => f.id !== folder.id && f.parentId === parent && f.name.toLowerCase() === name.toLowerCase())) { ctx.toast('409: the name is taken there.', 'danger'); return; } folder.name = name || folder.name; folder.parentId = parent; App.closeOverlay(); ctx.rerender(); ctx.toast('Folder saved. Audited file.folder.updated.', 'ok'); }); } }));
      ctx.on('click', '[data-trashfolder]', async () => { const inside = st.files.filter((f) => path.length && isUnder(st, f.folderId, folder.id)).length; const subs = st.folders.filter((f) => f.id !== folder.id && isUnder(st, f.id, folder.id)).length; const ok = await ctx.confirm({ title: 'Move ' + esc(folder.name) + ' to the trash', tag: 'with contents', tone: 'danger', body: '<p class="fg2" style="margin:0">The folder goes to the trash with everything in it and is purged after ' + st.usage.trashDays + ' days. Shares on its files stop working until it is restored.</p>', kv: [['Files', inside], ['Subfolders', subs]], ok: 'Trash folder' }); if (!ok) return; const parentName = (st.folders.find((f) => f.id === folder.parentId) || {}).name; st.trash.unshift({ kind: 'folder', id: folder.id, name: folder.name, folderName: parentName, folderGone: false, size: st.files.filter((f) => isUnder(st, f.folderId, folder.id)).reduce((s, f) => s + f.size, 0), files: inside, folders: subs, label: 'confidential', trashedAt: 'just now', purgeAfter: '19 Oct 14:20', by: 'Mara Okafor', payload: { folders: st.folders.filter((f) => f.id === folder.id || isUnder(st, f.id, folder.id)), files: st.files.filter((f) => isUnder(st, f.folderId, folder.id)) } }); st.files = st.files.filter((f) => !isUnder(st, f.folderId, folder.id)); st.folders = st.folders.filter((f) => f.id !== folder.id && !isUnder(st, f.id, folder.id)); st.folder = folder.parentId || 'root'; st.sel = null; ctx.rerender(); ctx.toast('Folder ' + esc(folder.name) + ' trashed with ' + inside + ' files. Audited file.folder.trashed.', 'warn'); });
      ctx.on('click', '[data-upload]', () => openUpload(ctx, folder));
      if (st.openUpload) { st.openUpload = false; openUpload(ctx, folder); }
      if (sel && st.view === 'folder') wireInspector(ctx, sel);
      if (st.view === 'trash') wireTrash(ctx);
      if (st.view === 'shared') wireShared(ctx);
    }
  });

  function isUnder(st, folderId, ancestorId) { for (let f = st.folders.find((x) => x.id === folderId); f; f = st.folders.find((x) => x.id === f.parentId)) if (f.id === ancestorId) return true; return false; }

  // ---------- upload ----------
  function openUpload(ctx, folder, file) {
    const st = ctx.state;
    const title = file ? 'New version of ' + esc(file.name) : 'Upload to ' + esc(folder.name);
    ctx.modal({ title, body: '<div class="formgrid">' + (file ? '' : UI.field('File name', UI.input('', { placeholder: 'e.g. Q3 accruals.xlsx', attrs: 'data-up-name' }))) + UI.field('Size', UI.select(['180 KB', '2.4 MB', '48 MB', '1.9 GB', '2.5 GB (over the upload limit)', '34 GB (over the workspace quota)'], '2.4 MB', 'data-up-size'), 'Checked while the bytes arrive; refused with 413 above ' + fmtBytes(st.usage.maxUpload) + ' or over a storage quota.') + UI.field('Label', UI.select(['public', 'internal', 'confidential'], file ? file.label : 'internal', 'data-up-label'), 'At most your clearance (confidential) and the workspace ceiling. Checked again by the scan job.') + (file ? '' : UI.field('Folder', UI.select(st.folders.map((f) => ({ value: f.id, label: f.name })), folder.id, 'data-up-folder'))) + '</div>' + UI.notice('The raw body is the file, streamed and sealed in 64 KiB AES-GCM segments under a key of its own, never buffered. The version is quarantined until the file.scan job detects the type from the bytes, classifies text, scans with ClamAV and checks the label.', 'info') + UI.check('Simulate a file ClamAV rejects', false, 'data-up-bad'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Upload', { kind: 'primary', icon: 'upload', attrs: 'data-up-ok' }), onMount(m) {
      m.querySelector('[data-up-ok]').addEventListener('click', () => {
        const sizeText = m.querySelector('[data-up-size]').value; const size = { '180 KB': 180 * KB, '2.4 MB': 2.4 * MB, '48 MB': 48 * MB, '1.9 GB': 1.9 * GB }[sizeText] || (sizeText.startsWith('2.5') ? 2.5 * GB : 34 * GB);
        if (size > st.usage.maxUpload) { App.closeOverlay(); st.problem = { title: 'Upload refused: too large', text: '413 {limit: upload_bytes, max: ' + fmtBytes(st.usage.maxUpload) + ', incoming: ' + fmtBytes(size) + '}. FILES_MAX_BYTES caps a single upload. Nothing was stored.' }; ctx.rerender(); return; }
        if (st.usage.ws.used + size > st.usage.ws.max) { App.closeOverlay(); st.problem = { title: 'Upload refused: storage quota', text: '413 {limit: storage_bytes, scope: workspace, used: ' + fmtBytes(st.usage.ws.used) + ', max: ' + fmtBytes(st.usage.ws.max) + ', incoming: ' + fmtBytes(size) + '}. Finance Ops would pass its limit. Empty the trash or ask a tenant admin to raise the quota.' }; ctx.rerender(); return; }
        const label = m.querySelector('[data-up-label]').value; const bad = m.querySelector('[data-up-bad]').checked;
        let target = file;
        if (!file) {
          const name = m.querySelector('[data-up-name]').value.trim(); const fid = m.querySelector('[data-up-folder]').value;
          if (!name || /[\\/\u0000-\u001f]/.test(name) || name.length > 255) { ctx.toast('400: names are 1 to 255 characters without / or \\.', 'danger'); return; }
          if (st.files.some((f) => f.folderId === fid && f.name.toLowerCase() === name.toLowerCase())) { ctx.toast('409: a file with that name is in the folder.', 'danger'); return; }
          const ext = (name.split('.').pop() || '').toLowerCase(); const type = { xlsx: 'Excel', docx: 'Word', pptx: 'PowerPoint', pdf: 'PDF', csv: 'CSV', json: 'JSON', md: 'Markdown', txt: 'text', html: 'HTML', png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF' }[ext] || 'text';
          target = { id: 'fi-' + Math.random().toString(36).slice(2, 7), name, folderId: fid, owner: 'Mara Okafor', label, state: 'pending', size, type: null, sniffed: type, currentVersion: 0, tags: [], access: 'workspace', preview: null, updatedAt: 'just now', versions: [], shares: [] };
          st.files.unshift(target); st.folder = fid; st.sel = target.id;
        } else { target.state = target.currentVersion ? target.state : 'pending'; }
        const n = target.versions.length ? Math.max.apply(null, target.versions.map((x) => x.number)) + 1 : 1;
        const ver = v(n, 'quarantined', size, null, label, 'Mara Okafor', 'just now'); target.versions.unshift(ver); st.usage.ws.used += size; st.usage.tenant.used += size;
        st.uploaded = { name: target.name }; st.problem = null; App.closeOverlay(); ctx.rerender();
        ctx.toast('202: ' + esc(target.name) + ' version ' + n + ' quarantined. Audited file.upload.received.');
        setTimeout(() => {
          if (bad) { ver.state = 'rejected'; ver.reason = 'ClamAV: Eicar-Test-Signature'; ver.findings = ['Eicar-Test-Signature at offset 0']; ver.scannedAt = 'just now'; if (!target.currentVersion) target.state = 'rejected'; st.usage.ws.used -= size; st.usage.tenant.used -= size; }
          else { ver.state = 'ready'; ver.type = target.sniffed || target.type; ver.scannedAt = 'just now'; target.type = ver.type; target.state = 'ready'; target.currentVersion = n; target.size = size; target.label = label; target.updatedAt = 'just now'; target.preview = /PNG|JPEG|WebP|GIF|PDF/.test(target.type) ? 'queued' : null; }
          st.uploaded = null;
          if (ctx.app.state.route === 'files' && !document.getElementById('overlay')) ctx.rerender();
          ctx.toast(bad ? 'file.state: version ' + n + ' of ' + esc(target.name) + ' rejected by the scan. Audited file.version.rejected.' : 'file.state: version ' + n + ' of ' + esc(target.name) + ' is ready and current. Audited file.version.ready; event file.' + (n === 1 ? 'uploaded' : 'updated') + '.', bad ? 'danger' : 'ok', 5000);
        }, 1800);
      });
    } });
  }

  // ---------- inspector ----------
  function renderInspector(ctx, f) {
    const st = ctx.state;
    const cur = f.versions.find((x) => x.number === f.currentVersion);
    const rejected = f.versions.find((x) => x.state === 'rejected');
    const liveShares = f.shares.filter((s) => s.state === 'active').length;
    const vrows = f.versions.map((x) => ({ cells: ['<span class="num">' + x.number + '</span>' + (x.number === f.currentVersion ? ' ' + UI.pill('current', 'accent') : ''), statePill(x.state), '<span class="num">' + esc(fmtBytes(x.size)) + '</span>', UI.label(x.label, { sm: true }), esc(x.createdBy) + '<div class="muted" style="font-size:11px">' + esc(x.createdAt) + (x.restoredFrom ? ', restored from v' + x.restoredFrom : '') + '</div>', x.state === 'rejected' ? '<span style="color:var(--danger-fg);font-size:12px">' + esc(x.reason) + '</span>' : x.state === 'quarantined' ? '<span class="muted" style="font-size:12px">scan pending</span>' : '<span class="mono" style="font-size:11px" title="' + esc(x.sha256) + '">' + esc(x.sha256.slice(0, 12)) + '…</span>', '<span class="hstack gap4" style="justify-content:flex-end">' + (x.state === 'ready' ? UI.iconbtn('download', 'Download version ' + x.number, { attrs: 'data-dlver="' + x.number + '"', cls: 'sm ghost' }) : '') + (x.state === 'ready' && x.number !== f.currentVersion ? UI.iconbtn('undo', 'Restore version ' + x.number, { attrs: 'data-restorever="' + x.number + '"', cls: 'sm ghost' }) : '') + '</span>'] }));
    const srows = f.shares.map((s) => ({ cells: [UI.pill(s.kind, 'outline') + (s.anonymous ? ' ' + UI.pill('anonymous', 'warn') : ''), esc(s.who), s.expiresAt ? esc(s.expiresAt) : '<span class="muted">never</span>', s.maxUses ? '<span class="num">' + s.uses + ' of ' + s.maxUses + '</span>' : '<span class="num">' + s.uses + '</span>', shareState(s.state), '<span class="hstack" style="justify-content:flex-end">' + (s.state === 'active' ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-revokeshare="' + esc(s.id) + '"' }) : '') + '</span>'] }));
    const preview = '<div class="files-preview ' + (f.preview === 'ready' ? 'ready' : '') + '">' + (f.preview === 'ready' ? '' : f.preview === 'queued' ? 'Preview is being drawn by the file.preview job (ffmpeg or pdftoppm). 409 until ready.' : f.preview === 'unavailable' ? 'No preview: ' + (f.size > 16 * MB ? 'above FILES_PREVIEW_MAX_BYTES' : 'the tool for ' + f.type + ' is not available') + '. Download instead.' : f.preview === 'failed' ? 'Preview failed.' : 'No preview for ' + (f.type || 'this type') + '. Previews exist for images and the first page of a PDF.') + '</div>';
    return '<aside class="inspector w360" aria-label="File"><div class="hstack"><div class="eyebrow grow">File</div>' + UI.label(f.label, { sm: true }) + '</div><div style="font-size:15px;font-weight:600;overflow-wrap:anywhere">' + esc(f.name) + '</div>'
      + (st.rejectedNote && rejected ? UI.notice('<b>Version ' + rejected.number + ' rejected by the scan.</b> ' + esc(rejected.reason) + '. It is never served; version ' + f.currentVersion + ' stays current. The uploader was told why (audited file.version.rejected).', 'danger') : '')
      + (st.linkNote && f.shares.some((s) => s.state === 'used up') ? UI.notice('<b>The anonymous link is used up.</b> 50 of 50 uses taken. A reader now gets the same 404 as for an unknown token. Create a new link if the file should stay reachable.', 'warn') : '')
      + (st.previewNote && f.preview === 'unavailable' ? UI.notice('<b>Preview unavailable.</b> ' + esc(f.type) + ' of ' + esc(fmtBytes(f.size)) + ' is above FILES_PREVIEW_MAX_BYTES, so no PNG was drawn. The download is the only view.', 'info') : '')
      + preview
      + UI.kv([['Owner', esc(f.owner)], ['State', statePill(f.state)], ['Type', typePill(f.type)], ['Size', esc(fmtBytes(f.size))], ['Current version', f.currentVersion ? '<span class="num">' + f.currentVersion + '</span>' : '<span class="muted">none ready</span>'], ['Access', f.access + (liveShares ? ', ' + liveShares + ' live share' + (liveShares > 1 ? 's' : '') : '')], ['Preview', esc(previewText(f.preview))], ['sha256', cur ? '<span class="mono" style="font-size:11px" title="' + esc(cur.sha256) + '">' + esc(cur.sha256.slice(0, 16)) + '…</span>' : '<span class="muted">none</span>']], 2)
      + '<div class="hstack"><div class="eyebrow grow">Tags</div>' + UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-edittags' }) + '</div><div class="files-tags">' + (f.tags.length ? f.tags.map((t) => UI.chip(esc(t), false, 'data-tag="' + esc(t) + '"')).join('') : '<span class="muted" style="font-size:12px">No tags. Up to 20 lower-case tags.</span>') + '</div>'
      + '<div class="hstack wrap gap6">' + UI.btn('Download', { kind: 'primary', size: 'sm', icon: 'download', attrs: 'data-download', disabled: f.state !== 'ready' }) + UI.btn('New version', { size: 'sm', icon: 'upload', attrs: 'data-newversion' }) + UI.btn('Share', { size: 'sm', icon: 'link', attrs: 'data-share' }) + UI.btn('Rename or move', { size: 'sm', attrs: 'data-rename' }) + UI.btn('Attach in Messages', { size: 'sm', kind: 'ghost', attrs: 'data-attach', disabled: f.state !== 'ready' }) + UI.btn('Trash', { size: 'sm', kind: 'ghost', attrs: 'data-trashfile' }) + '</div>'
      + '<div class="eyebrow">Versions, ' + f.versions.length + '</div>' + UI.table(['v', 'State', 'Size', 'Label', 'By', 'Scan', { label: '', right: true }], vrows, { clickable: false, minWidth: '0' })
      + '<span class="muted" style="font-size:11px">Restoring writes the version again as a new one, which goes through quarantine and is scanned again. Only a ready version can be downloaded.</span>'
      + '<div class="eyebrow">Shares, ' + f.shares.length + '</div>' + UI.table(['Kind', 'With', 'Expires', 'Uses', 'State', { label: '', right: true }], srows, { clickable: false, minWidth: '0', emptyTitle: 'Not shared', emptyText: 'Shared readers download the current version and its preview, nothing else.' })
      + '</aside>';
  }

  function wireInspector(ctx, f) {
    const st = ctx.state;
    ctx.on('click', '[data-download]', () => ctx.toast('Downloading ' + esc(f.name) + ' (version ' + f.currentVersion + ') as an attachment with Content-Security-Policy: sandbox. Audited file.downloaded.', 'ok'));
    ctx.on('click', '[data-dlver]', (e, t) => ctx.toast('Downloading version ' + esc(t.dataset.dlver) + ' of ' + esc(f.name) + '. Audited file.downloaded.', 'ok'));
    ctx.on('click', '[data-attach]', () => ctx.navigate('messages', { attach: f.id }));
    ctx.on('click', '[data-newversion]', () => openUpload(ctx, st.folders.find((x) => x.id === f.folderId), f));
    ctx.on('click', '[data-restorever]', async (e, t) => { const n = +t.dataset.restorever; const ok = await ctx.confirm({ title: 'Restore version ' + n + ' of ' + esc(f.name), tone: 'info', body: '<p class="fg2" style="margin:0">Writes version ' + n + '\'s content again as a new version. It goes through quarantine and is <b>scanned again</b> before it becomes current (202).</p>', kv: [['Current', 'v' + f.currentVersion], ['Restore', 'v' + n], ['Becomes', 'v' + (Math.max.apply(null, f.versions.map((x) => x.number)) + 1)]], ok: 'Restore' }); if (!ok) return; const src = f.versions.find((x) => x.number === n); const nn = Math.max.apply(null, f.versions.map((x) => x.number)) + 1; const ver = v(nn, 'quarantined', src.size, null, src.label, 'Mara Okafor', 'just now', { restoredFrom: n }); f.versions.unshift(ver); ctx.rerender(); ctx.toast('202: version ' + nn + ' queued from v' + n + '. Audited file.version.restore.requested.'); setTimeout(() => { ver.state = 'ready'; ver.type = src.type; ver.scannedAt = 'just now'; f.currentVersion = nn; f.size = src.size; f.updatedAt = 'just now'; if (ctx.app.state.route === 'files' && !document.getElementById('overlay')) ctx.rerender(); ctx.toast('file.state: version ' + nn + ' is ready and current. Event file.restored (from ' + n + ').', 'ok'); }, 1500); });
    ctx.on('click', '[data-edittags]', () => ctx.modal({ title: 'Tags for ' + esc(f.name), body: UI.field('Tags', UI.input(f.tags.join(', '), { attrs: 'data-tg', placeholder: 'comma separated' }), 'Up to 20 lower-case tags. Tags make a file findable in search and from knowledge bases.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save tags', { kind: 'primary', attrs: 'data-tg-ok' }), onMount(m) { m.querySelector('[data-tg-ok]').addEventListener('click', () => { const tags = m.querySelector('[data-tg]').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i); if (tags.length > 20) { ctx.toast('400: at most 20 tags.', 'danger'); return; } f.tags = tags; App.closeOverlay(); ctx.rerender(); ctx.toast('Tags saved. Audited file.tags.updated.', 'ok'); }); } }));
    ctx.on('click', '[data-rename]', () => ctx.modal({ title: 'Rename or move ' + esc(f.name), body: '<div class="formgrid">' + UI.field('Name', UI.input(f.name, { attrs: 'data-rn-name' })) + UI.field('Folder', UI.select(st.folders.map((x) => ({ value: x.id, label: x.name })), f.folderId, 'data-rn-folder'), 'Within the workspace. Shares and versions move with the file.') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-rn-ok' }), onMount(m) { m.querySelector('[data-rn-ok]').addEventListener('click', () => { const name = m.querySelector('[data-rn-name]').value.trim(); const fid = m.querySelector('[data-rn-folder]').value; if (!name || /[\\/\u0000-\u001f]/.test(name) || name.length > 255) { ctx.toast('400: names are 1 to 255 characters without / or \\.', 'danger'); return; } if (st.files.some((x) => x.id !== f.id && x.folderId === fid && x.name.toLowerCase() === name.toLowerCase())) { ctx.toast('409: a file named ' + esc(name) + ' is already in that folder.', 'danger'); return; } f.name = name; f.folderId = fid; st.folder = fid; App.closeOverlay(); ctx.rerender(); ctx.toast('File saved. Audited file.changed.', 'ok'); }); } }));
    ctx.on('click', '[data-trashfile]', async () => { const ok = await ctx.confirm({ title: 'Move ' + esc(f.name) + ' to the trash', tone: 'danger', body: '<p class="fg2" style="margin:0">Its shares stop working while it is in the trash. It is purged ' + st.usage.trashDays + ' days later unless restored.</p>', kv: [['Versions', f.versions.length], ['Live shares', f.shares.filter((s) => s.state === 'active').length]], ok: 'Trash' }); if (!ok) return; st.trash.unshift({ kind: 'file', id: f.id, name: f.name, folderName: (st.folders.find((x) => x.id === f.folderId) || {}).name, folderGone: false, size: f.size, type: f.type, label: f.label, trashedAt: 'just now', purgeAfter: '19 Oct 14:20', by: 'Mara Okafor', payload: f }); st.files = st.files.filter((x) => x !== f); st.sel = null; ctx.rerender(); ctx.toast(esc(f.name) + ' moved to the trash. Audited file.trashed; event file.deleted.', 'warn'); });
    ctx.on('click', '[data-revokeshare]', async (e, t) => { const s = f.shares.find((x) => x.id === t.dataset.revokeshare); const ok = await ctx.confirm({ title: 'Revoke this share', tone: 'danger', body: '<p class="fg2" style="margin:0">Revokes at once (204). ' + (s.kind === 'link' ? 'Anyone holding the link gets the same 404 as for an unknown token.' : esc(s.who) + ' loses access on their next request.') + '</p>', kv: [['Kind', s.kind], ['With', s.who], ['Uses', s.uses]], ok: 'Revoke' }); if (!ok) return; s.state = 'revoked'; ctx.rerender(); ctx.toast('Share revoked. Audited file.share.revoked.', 'ok'); });
    ctx.on('click', '[data-share]', () => {
      const kinds = [{ value: 'user', label: 'A person' }, { value: 'group', label: 'A directory group' }, { value: 'workspace', label: 'A workspace' }, { value: 'link', label: 'A link' }];
      const sub = (k) => k === 'user' ? UI.field('Person', UI.select(['Priya Nair (restricted)', 'Tomasz Weber (internal)', 'Jonas Lindqvist (confidential)', 'Samir Haddad (internal)', 'Noor Rahimi (internal)'], 'Priya Nair (restricted)', 'data-sh-user'), 'Must be cleared for the file\'s label (' + esc(f.label) + ').')
        : k === 'group' ? UI.field('Group', UI.input('cn=finance-leads', { attrs: 'data-sh-group' }), 'A directory group, as the reader\'s identities carried it at sign-in or sync.')
        : k === 'workspace' ? UI.field('Workspace', UI.select(['People Ops (ceiling internal)', 'Field Sales (ceiling internal)', 'Platform lab (ceiling public)'], 'People Ops (ceiling internal)', 'data-sh-ws'), 'The workspace\'s ceiling must cover the file\'s label.')
        : '<div class="formgrid" style="--cols:3">' + UI.field('Expires in (hours)', UI.input(168, { type: 'number', attrs: 'data-sh-hours' })) + UI.field('Max uses', UI.input(5, { type: 'number', attrs: 'data-sh-uses' }), 'Empty for unlimited.') + UI.field('Anonymous', UI.select(['no', 'yes'], 'no', 'data-sh-anon'), 'Only a public file, while the tenant allows anonymous links, within its maximum lifetime.') + '</div>' + UI.notice('The token exf_… is shown once and stored as an HMAC. A link past its use limit, expired or revoked is refused with the same 404 as an unknown token.', 'info');
      ctx.modal({ title: 'Share ' + esc(f.name), body: UI.field('Share with', UI.select(kinds, 'user', 'data-sh-kind')) + '<div data-sh-sub>' + sub('user') + '</div><div class="muted" style="font-size:12px">Read-only: the reader downloads the current version and its preview, nothing else.</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create share', { kind: 'primary', attrs: 'data-sh-ok' }), onMount(m) {
        m.querySelector('[data-sh-kind]').addEventListener('change', (e) => { m.querySelector('[data-sh-sub]').innerHTML = sub(e.target.value); });
        m.querySelector('[data-sh-ok]').addEventListener('click', () => {
          const k = m.querySelector('[data-sh-kind]').value; let share;
          if (k === 'user') { const u = m.querySelector('[data-sh-user]').value; const cl = u.match(/\((\w+)\)/)[1]; if (clearanceOrder[cl] < clearanceOrder[f.label]) { ctx.toast('422: ' + esc(u.split(' (')[0]) + ' is cleared to ' + cl + ', below the file\'s label ' + esc(f.label) + '.', 'danger'); return; } share = { kind: 'user', who: u.split(' (')[0] }; }
          else if (k === 'group') { share = { kind: 'group', who: m.querySelector('[data-sh-group]').value.trim() || 'cn=finance-leads' }; }
          else if (k === 'workspace') { const w = m.querySelector('[data-sh-ws]').value; const ceil = w.match(/ceiling (\w+)/)[1]; if (clearanceOrder[ceil] < clearanceOrder[f.label]) { ctx.toast('422: the ceiling of ' + esc(w.split(' (')[0]) + ' is ' + ceil + ', below the file\'s label ' + esc(f.label) + '.', 'danger'); return; } share = { kind: 'workspace', who: w.split(' (')[0] }; }
          else { const anon = m.querySelector('[data-sh-anon]').value === 'yes'; const hours = +m.querySelector('[data-sh-hours]').value || 168; const uses = +m.querySelector('[data-sh-uses]').value || null; if (anon && f.label !== 'public') { ctx.toast('422: anonymous links need a public file. ' + esc(f.name) + ' is ' + esc(f.label) + '.', 'danger'); return; } if (anon && hours > 24 * 30) { ctx.toast('422: the tenant allows anonymous links for at most 30 days.', 'danger'); return; } const token = 'exf_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8); share = { kind: 'link', who: (anon ? 'Anonymous link ' : 'Link ') + 'exf_…' + token.slice(-4), anonymous: anon, expiresAt: hours >= 24 ? Math.round(hours / 24) + ' days from now' : hours + ' h from now', maxUses: uses, token }; }
          const s = Object.assign({ id: 's-' + Math.random().toString(36).slice(2, 6), anonymous: false, expiresAt: null, maxUses: null, uses: 0, state: 'active', createdAt: 'just now' }, share); f.shares.unshift(s); f.access = 'shared'; App.closeOverlay();
          if (s.kind === 'link') ctx.modal({ title: 'Link created', body: UI.notice('<b>Copy the link now; the token is shown once.</b><div class="mono" style="margin-top:4px;overflow-wrap:anywhere">https://ai.northwind.local/#/file-link?token=' + esc(s.token) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copy' })) + UI.kv([['Expires', s.expiresAt], ['Max uses', s.maxUses || 'unlimited'], ['Anonymous', s.anonymous ? 'yes (public file)' : 'no: signed in, same tenant, cleared']], 3), actions: UI.btn('Done', { kind: 'primary', attrs: 'data-close' }), onMount(mm) { mm.querySelector('[data-copy]').addEventListener('click', () => ctx.toast('Copied.')); }, onClose() { ctx.rerender(); } });
          else ctx.rerender();
          ctx.toast('Share created (201). Audited file.share.created; event file.shared.', 'ok');
        });
      } });
    });
  }

  // ---------- trash ----------
  function renderTrash(ctx) {
    const st = ctx.state;
    const rows = st.trash.map((t) => ({ cells: [UI.icon(t.kind === 'folder' ? 'files' : 'runs', 14) + ' <span style="font-weight:600">' + esc(t.name) + '</span>' + (t.kind === 'folder' ? '<div class="muted" style="font-size:11px">' + t.files + ' files, ' + t.folders + ' folder' + (t.folders === 1 ? '' : 's') + '</div>' : ''), UI.pill(t.kind, 'outline'), esc(t.folderName) + (t.folderGone ? ' <span style="color:var(--warn-fg);font-size:11px">gone</span>' : ''), '<span class="num">' + esc(fmtBytes(t.size)) + '</span>', UI.label(t.label, { sm: true }), esc(t.by) + '<div class="muted" style="font-size:11px">' + esc(t.trashedAt) + '</div>', esc(t.purgeAfter), '<span class="hstack" style="justify-content:flex-end">' + UI.btn('Restore', { size: 'xs', attrs: 'data-restore="' + esc(t.id) + '"' }) + '</span>'] }));
    return UI.pagehead('Trash', 'What was put in the trash on its own, within your clearance. Items are purged ' + st.usage.trashDays + ' days after they were trashed; the files.purge job also runs every FILES_PURGE_MINUTES.', UI.btn('Empty trash', { kind: 'danger', icon: 'trash', attrs: 'data-emptytrash', disabled: !st.trash.length }))
      + (st.restoredNote ? UI.notice(st.restoredNote, 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearrestored' })) : '')
      + UI.table(['Name', 'Kind', 'Was in', 'Size', 'Label', 'Trashed by', 'Purged after', { label: '', right: true }], rows, { clickable: false, minWidth: '760px', emptyTitle: 'The trash is empty', emptyText: 'Trashed files and folders wait here until they are purged or restored.' })
      + '<span class="muted" style="font-size:12px">A file that went to the trash with its folder is restored with the folder, not on its own (409). Trash counts against storage until purged.</span>';
  }
  function wireTrash(ctx) {
    const st = ctx.state;
    ctx.on('click', '[data-restore]', (e, t) => { const item = st.trash.find((x) => x.id === t.dataset.restore); if (item) restoreFromTrash(ctx, item, false); });
    ctx.on('click', '[data-clearrestored]', () => { st.restoredNote = null; ctx.rerender(); });
    ctx.on('click', '[data-emptytrash]', async () => { const bytes = st.trash.reduce((s, x) => s + x.size, 0); const ok = await ctx.confirm({ title: 'Empty the trash of Finance Ops', tag: 'permanent', tone: 'danger', body: '<p class="fg2" style="margin:0">Purges every trashed file and folder now as a job (202). Their sealed versions are deleted and the storage is freed.</p>', kv: [['Items', st.trash.length], ['Frees', fmtBytes(bytes)]], ok: 'Empty trash' }); if (!ok) return; st.trash = []; st.usage.ws.used = Math.max(0, st.usage.ws.used - bytes); st.usage.tenant.used = Math.max(0, st.usage.tenant.used - bytes); ctx.rerender(); ctx.toast('202: purge job queued; ' + fmtBytes(bytes) + ' freed. Audited file.trash.emptied, then file.purged per item.', 'warn'); });
  }
  function restoreFromTrash(ctx, item, fromState) {
    const st = ctx.state;
    const go = () => {
      st.trash = st.trash.filter((x) => x !== item);
      let where = 'its folder ' + item.folderName; let name = item.name;
      if (item.kind === 'folder') { const p = item.payload || { folders: [{ id: item.id, name: item.name, parentId: 'root' }], files: [] }; p.folders.forEach((f) => { if (f.id === item.id) f.parentId = st.folders.some((x) => x.name === item.folderName) ? (st.folders.find((x) => x.name === item.folderName) || {}).id || 'root' : 'root'; st.folders.push(f); }); p.files.forEach((f) => st.files.push(f)); where = st.folders.some((x) => x.name === item.folderName) ? where : 'the workspace root (its parent is gone)'; }
      else {
        const target = item.folderGone ? 'root' : ((st.folders.find((x) => x.name === item.folderName) || {}).id || 'root');
        if (item.folderGone) where = 'the workspace root, because ' + item.folderName + ' is gone';
        if (st.files.some((f) => f.folderId === target && f.name.toLowerCase() === item.name.toLowerCase())) { const dot = item.name.lastIndexOf('.'); name = dot > 0 ? item.name.slice(0, dot) + ' (2)' + item.name.slice(dot) : item.name + ' (2)'; where += '; renamed to ' + name + ' because the name clashed'; }
        const f = item.payload || { id: item.id, name: item.name, owner: item.by, label: item.label, state: 'ready', size: item.size, type: item.type, currentVersion: 1, tags: [], access: 'workspace', preview: null, updatedAt: 'just now', versions: [v(1, 'ready', item.size, item.type, item.label, item.by, item.trashedAt)], shares: [] };
        f.name = name; f.folderId = target; f.updatedAt = 'just now'; st.files.unshift(f);
        st.sel = f.id; st.folder = target;
      }
      st.view = fromState ? 'folder' : 'trash';
      st.restoredNote = '<b>' + esc(item.name) + ' restored</b> to ' + esc(where) + '. Audited file.' + (item.kind === 'folder' ? 'folder.untrashed' : 'untrashed') + '.';
      ctx.rerender(); ctx.toast(esc(item.name) + ' restored to ' + esc(where) + '.', 'ok', 5000);
    };
    if (fromState) { go(); return; }
    ctx.confirm({ title: 'Restore ' + esc(item.name), tone: 'info', body: '<p class="fg2" style="margin:0">Restores it with what went with it' + (item.folderGone ? '. Its folder is gone, so it comes back at the workspace root' : ' to ' + esc(item.folderName)) + '. A clashing name gets " (2)".</p>', kv: [['Kind', item.kind], ['Size', fmtBytes(item.size)]], ok: 'Restore' }).then((ok) => { if (ok) go(); });
  }

  // ---------- shared with me ----------
  function renderShared(ctx) {
    const st = ctx.state;
    const rows = st.shared.map((s) => ({ cells: ['<span style="font-weight:600">' + esc(s.name) + '</span>', typePill(s.type), '<span class="num">' + esc(fmtBytes(s.size)) + '</span>', UI.label(s.label, { sm: true }), esc(s.from) + '<div class="muted" style="font-size:11px">' + esc(s.via) + '</div>', esc(s.workspace), s.expiresAt ? esc(s.expiresAt) : '<span class="muted">never</span>', esc(s.updatedAt), '<span class="hstack gap4" style="justify-content:flex-end">' + UI.btn('Preview', { size: 'xs', kind: 'ghost', attrs: 'data-shpreview="' + esc(s.id) + '"' }) + UI.btn('Download', { size: 'xs', attrs: 'data-shdl="' + esc(s.id) + '"' }) + '</span>'] }));
    return UI.pagehead('Shared with me', 'Files shared with you directly, through a workspace or a directory group. Live shares only, within your clearance. You can download the current version and its preview, nothing else.', UI.btn('Open a link', { icon: 'link', attrs: 'data-openlink' }))
      + UI.table(['Name', 'Type', 'Size', 'Label', 'From', 'Workspace', 'Expires', 'Updated', { label: '', right: true }], rows, { clickable: false, minWidth: '820px', emptyTitle: 'Nothing shared with you', emptyText: 'Shares appear here as soon as someone grants them.' });
  }
  function wireShared(ctx) {
    const st = ctx.state;
    ctx.on('click', '[data-shdl]', (e, t) => { const s = st.shared.find((x) => x.id === t.dataset.shdl); ctx.toast('Downloading ' + esc(s.name) + ' (sandboxed attachment). Audited file.downloaded.', 'ok'); });
    ctx.on('click', '[data-shpreview]', (e, t) => { const s = st.shared.find((x) => x.id === t.dataset.shpreview); ctx.modal({ title: esc(s.name), body: '<div class="files-preview ' + (s.type === 'PDF' ? 'ready' : '') + '" style="height:260px">' + (s.type === 'PDF' ? '' : 'No preview for ' + esc(s.type) + '. Download to open it.') + '</div>' + UI.kv([['From', esc(s.from)], ['Label', UI.label(s.label, { sm: true })], ['Size', esc(fmtBytes(s.size))]], 3), actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Download', { kind: 'primary', attrs: 'data-shdl="' + esc(s.id) + '"' }), onMount(m) { m.querySelector('[data-shdl]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Downloading ' + esc(s.name) + '. Audited file.downloaded.', 'ok'); }); } }); });
    ctx.on('click', '[data-openlink]', () => ctx.modal({ title: 'Open a file link', body: UI.field('Link or token', UI.input('', { placeholder: 'exf_…', attrs: 'data-ol-token' }), 'Signed in, same tenant and cleared for the file: you see its name, size, type and uses left without using the link. Every other case, including a used-up, expired or revoked link, is the same 404.') + '<div data-ol-out></div>', actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Check', { kind: 'primary', attrs: 'data-ol-check' }), onMount(m) { m.querySelector('[data-ol-check]').addEventListener('click', () => { const tkn = m.querySelector('[data-ol-token]').value.trim(); const out = m.querySelector('[data-ol-out]'); if (/c41a$/.test(tkn) || tkn === 'demo') out.innerHTML = UI.notice('<b>Fabrikam MSA 2025.pdf</b>, 8.7 MB, PDF, internal. Expires 26 Sep 11:05, 3 uses left.', 'ok', UI.btn('Download (uses one)', { size: 'sm', attrs: 'data-ol-dl' })); else out.innerHTML = UI.problem('Not found', '404. The token is unknown, used up, expired or revoked, or the file is above your clearance. All of these answer the same way.', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'); const dl = out.querySelector('[data-ol-dl]'); if (dl) dl.addEventListener('click', () => { App.closeOverlay(); const f = st.files.find((x) => x.id === 'fi-2'); const sh = f && f.shares.find((x) => x.id === 's-3'); if (sh) { sh.uses += 1; if (sh.maxUses && sh.uses >= sh.maxUses) sh.state = 'used up'; } ctx.toast('One use taken atomically; downloading Fabrikam MSA 2025.pdf. Audited file.downloaded with your address.', 'ok'); }); }); } }));
  }
})();
