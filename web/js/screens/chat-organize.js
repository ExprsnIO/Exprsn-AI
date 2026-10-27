// Chat: conversation folders and message groups (2026-10-15). `chat.js` calls into App.chatOrganize for the
// conversation list (folders as collapsible groups, a folder filter, New folder, Move to folder on each conversation,
// drag and drop as a shortcut), for the selection of messages in the thread and for the "Message groups" section of
// the side panel. Folders are /api/chat/folders and PUT /api/conversations/:id/folder; groups are
// /api/conversations/:id/groups, exported through chat.js's export dialog with a group id. Which folders are collapsed
// is remembered per user in localStorage (a convenience: the list works without it).
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const cUrl = (id) => '/api/conversations/' + enc(id);
  let h = null; // { S, rerender, schedule, loadList, ago, pathOf, exportModal }

  // ---------- remembered state ----------
  const storeKey = () => 'exprsn.chat.folders.collapsed.' + ((App.me && App.me.user && App.me.user.id) || 'me');
  function readCollapsed() {
    try { const v = JSON.parse(window.localStorage.getItem(storeKey()) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function writeCollapsed(list) {
    try { window.localStorage.setItem(storeKey(), JSON.stringify(list)); } catch (e) { /* storage may be unavailable */ }
  }

  // ---------- folders ----------
  const foldersOf = (st) => st.folders || [];
  const kidsOf = (st, parentId) => foldersOf(st).filter((f) => (f.parentId || null) === parentId).sort((a, b) => a.position - b.position);
  const folderById = (st, id) => foldersOf(st).find((f) => f.id === id) || null;
  function pathName(st, f) {
    const parts = []; let cur = f; let n = 0;
    while (cur && n++ < 5) { parts.unshift(cur.name); cur = cur.parentId ? folderById(st, cur.parentId) : null; }
    return parts.join(' / ');
  }
  /** Folders in tree order with their depth, for pickers. */
  function ordered(st) {
    const out = [];
    (function walk(parent, depth) { kidsOf(st, parent).forEach((f) => { out.push({ f, depth }); walk(f.id, depth + 1); }); })(null, 1);
    return out;
  }
  function loadFolders(st) {
    if (!App.can('chat:read')) return Promise.resolve();
    return App.get('/api/chat/folders').then((list) => {
      st.folders = list; st.foldersLoaded = true;
      if (st.folderFilter && st.folderFilter !== 'all' && st.folderFilter !== 'none' && !folderById(st, st.folderFilter)) st.folderFilter = 'all';
    }).catch(() => { if (!st.folders) st.folders = []; });
  }
  const listQuery = (st) => (st.folderFilter && st.folderFilter !== 'all' ? '&folder=' + enc(st.folderFilter) : '') + '&limit=300';

  function convItem(st, c) {
    const title = c.title || 'Untitled conversation';
    const move = App.can('chat:write') ? UI.iconbtn('files', 'Move ' + title + ' to a folder', { cls: 'sm ghost', attrs: 'data-chmove="' + esc(c.id) + '"' }) : '';
    return '<div class="ch-crow"' + (App.can('chat:write') ? ' draggable="true" data-chdrag="' + esc(c.id) + '"' : '') + '>'
      + UI.listItem(esc(title), esc(h.ago(c.updatedAt)), { active: c.id === st.convId, attrs: 'data-convo="' + esc(c.id) + '"', right: UI.label(c.label, { sm: true }) }) + move + '</div>';
  }

  function folderHtml(st, f, level, convos, collapsed) {
    const open = collapsed.indexOf(f.id) < 0;
    const mine = convos.filter((c) => c.folderId === f.id);
    const kids = kidsOf(st, f.id);
    const head = '<div class="ch-fhead ch-fl' + level + '" data-chdrop="' + esc(f.id) + '">'
      + '<button type="button" class="ch-ftoggle" aria-expanded="' + (open ? 'true' : 'false') + '" data-chftoggle="' + esc(f.id) + '">' + '<span class="ch-fchev' + (open ? ' open' : '') + '" aria-hidden="true">' + UI.icon('chev', 12) + '</span>'
      + '<span class="fn">' + esc(f.name) + '</span><span class="fc">' + esc(String(f.conversations)) + '<span class="sr"> conversations</span></span></button>'
      + (App.can('chat:write') ? UI.iconbtn('dots', 'Folder ' + f.name + ': rename, move or delete', { cls: 'sm ghost', attrs: 'data-chfedit="' + esc(f.id) + '" aria-haspopup="dialog"' }) : '') + '</div>';
    if (!open) return '<div class="ch-fgroup" role="group" aria-label="' + esc(f.name) + '">' + head + '</div>';
    const body = kids.map((k) => folderHtml(st, k, level + 1, convos, collapsed)).join('') + mine.map((c) => convItem(st, c)).join('')
      + (!kids.length && !mine.length ? '<div class="ch-fempty ch-fl' + (level + 1) + '">No conversations in this folder.</div>' : '');
    return '<div class="ch-fgroup" role="group" aria-label="' + esc(f.name) + '">' + head + '<div class="ch-fbody ch-fi' + level + '">' + body + '</div></div>';
  }

  function toolsHtml(st) {
    const filter = st.folderFilter || 'all';
    const opts = [{ value: 'all', label: 'All conversations' }, { value: 'none', label: 'Not in a folder' }].concat(ordered(st).map((x) => ({ value: x.f.id, label: pathName(st, x.f) })));
    return '<div class="ch-ftools">' + UI.select(opts, filter, 'data-chffilter aria-label="Show conversations from"')
      + (App.can('chat:write') ? UI.btn('New folder', { size: 'sm', kind: 'ghost', icon: 'plus', attrs: 'data-chfnew' }) : '') + '</div>';
  }

  function listHtml(st) {
    if (!st.loaded) return st.loadError ? '' : '<div class="muted" style="font-size:12px;padding:6px">Loading…</div>';
    const q = (st.query || '').toLowerCase();
    const filter = st.folderFilter || 'all';
    const all = st.convos || [];
    const hits = all.filter((c) => !q || (c.title || '').toLowerCase().indexOf(q) >= 0);
    let body;
    if (q || filter !== 'all' || st.archived) {
      // A search, one folder or the archive: a flat list.
      const list = filter === 'all' ? hits : hits.filter((c) => (filter === 'none' ? !c.folderId : c.folderId === filter));
      const where = filter === 'none' ? 'outside folders' : filter !== 'all' && folderById(st, filter) ? 'in ' + pathName(st, folderById(st, filter)) : '';
      body = list.map((c) => convItem(st, c)).join('')
        + (list.length ? '' : UI.empty(q ? 'No conversations match' : st.archived ? 'No archived conversations' : 'No conversations ' + (where || 'yet'), q ? 'Try another word or start a new conversation.' : st.archived ? 'Archived conversations show here.' : filter !== 'all' ? 'Move a conversation here with its folder button.' : 'Ask something to start one in this workspace.'));
    } else {
      const collapsed = readCollapsed();
      const loose = hits.filter((c) => !c.folderId || !folderById(st, c.folderId));
      body = kidsOf(st, null).map((f) => folderHtml(st, f, 1, hits, collapsed)).join('')
        + (foldersOf(st).length ? '<div class="ch-fhead ch-floose" data-chdrop="none"><span class="eyebrow">Not in a folder</span></div>' : '')
        + loose.map((c) => convItem(st, c)).join('')
        + (all.length ? '' : UI.empty('No conversations yet', 'Ask something to start one in this workspace.'));
    }
    return toolsHtml(st) + body;
  }

  async function refresh(st) {
    await Promise.all([loadFolders(st), h.loadList()]);
    h.rerender();
  }

  function newFolder(ctx, parentId) {
    const st = h.S();
    const parent = parentId ? folderById(st, parentId) : null;
    ctx.modal({
      title: parent ? 'New folder in ' + esc(parent.name) : 'New folder',
      body: UI.field('Name', UI.input('', { attrs: 'data-chfname maxlength="100"' })) + '<div class="muted" style="font-size:12px">Folders are yours alone and only sort your conversations in this workspace. They nest up to three deep.</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create folder', { kind: 'primary', attrs: 'data-chfok' }),
      onMount(el) {
        const inp = el.querySelector('[data-chfname]'); inp.focus();
        const go = async () => {
          const name = inp.value.trim(); if (!name) { App.toast('A folder needs a name.'); return; }
          try { await App.post('/api/chat/folders', { name, parentId: parentId || null }); App.closeOverlay(); App.toast('Folder ' + esc(name) + ' created.', 'ok'); if (parentId) { writeCollapsed(readCollapsed().filter((x) => x !== parentId)); } await refresh(st); } catch (err) { App.fail(err, 'Could not create the folder'); }
        };
        el.querySelector('[data-chfok]').addEventListener('click', go);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      }
    });
  }

  /** One folder's settings: name, place (parent and order), a subfolder, show only it, delete. */
  function editFolder(ctx, id) {
    const st = h.S(); const f = folderById(st, id); if (!f) return;
    // Places the folder may move to: the top level or a folder not inside it, leaving room for what it holds.
    const inside = {}; (function mark(x) { inside[x] = true; foldersOf(st).filter((k) => k.parentId === x).forEach((k) => mark(k.id)); })(f.id);
    const height = (function hgt(x) { const k = foldersOf(st).filter((y) => y.parentId === x); return 1 + (k.length ? Math.max.apply(null, k.map((y) => hgt(y.id))) : 0); })(f.id);
    const places = [{ value: '', label: 'Top level' }].concat(ordered(st).filter((x) => !inside[x.f.id] && x.depth + height <= 3).map((x) => ({ value: x.f.id, label: pathName(st, x.f) })));
    const sibs = kidsOf(st, f.parentId || null); const at = sibs.findIndex((x) => x.id === f.id);
    ctx.modal({
      title: 'Folder ' + esc(f.name),
      body: UI.field('Name', UI.input(f.name, { attrs: 'data-chfname maxlength="100"' }))
        + UI.field('Inside', UI.select(places, f.parentId || '', 'data-chfparent'))
        + '<div class="hstack gap6 wrap">' + UI.btn('Move up', { size: 'sm', attrs: 'data-chfup' + (at <= 0 ? ' disabled' : '') }) + UI.btn('Move down', { size: 'sm', attrs: 'data-chfdown' + (at < 0 || at >= sibs.length - 1 ? ' disabled' : '') })
        + (f.depth < 3 ? UI.btn('New folder inside', { size: 'sm', icon: 'plus', attrs: 'data-chfsub' }) : '') + UI.btn('Show only this folder', { size: 'sm', kind: 'ghost', attrs: 'data-chfonly' }) + '</div>'
        + '<div class="muted" style="font-size:12px">' + esc(String(f.conversations)) + ' conversation' + (f.conversations === 1 ? '' : 's') + ' here. Deleting the folder (and any folders inside it) moves its conversations back to no folder; no conversation is deleted.</div>',
      actions: UI.btn('Delete folder', { kind: 'danger', attrs: 'data-chfdel' }) + '<span class="grow"></span>' + UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-chfok' }),
      onMount(el) {
        const inp = el.querySelector('[data-chfname]');
        const save = async () => {
          const name = inp.value.trim(); if (!name) { App.toast('A folder needs a name.'); return; }
          const parent = el.querySelector('[data-chfparent]').value || null;
          try {
            if (name !== f.name) await App.patch('/api/chat/folders/' + enc(f.id), { name });
            if (parent !== (f.parentId || null)) await App.post('/api/chat/folders/' + enc(f.id) + '/move', { parentId: parent });
            App.closeOverlay(); App.toast('Folder saved.', 'ok'); await refresh(st);
          } catch (err) { App.fail(err, 'Could not change the folder'); }
        };
        const moveBy = async (d) => {
          try { await App.post('/api/chat/folders/' + enc(f.id) + '/move', { position: Math.max(0, at + d) }); App.closeOverlay(); App.toast(d < 0 ? 'Moved up.' : 'Moved down.', 'ok'); await refresh(st); } catch (err) { App.fail(err, 'Could not move the folder'); }
        };
        el.querySelector('[data-chfok]').addEventListener('click', save);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        const up = el.querySelector('[data-chfup]'); if (up) up.addEventListener('click', () => moveBy(-1));
        const down = el.querySelector('[data-chfdown]'); if (down) down.addEventListener('click', () => moveBy(1));
        const sub = el.querySelector('[data-chfsub]'); if (sub) sub.addEventListener('click', () => { App.closeOverlay(); newFolder(ctx, f.id); });
        el.querySelector('[data-chfonly]').addEventListener('click', async () => { App.closeOverlay(); st.folderFilter = f.id; await h.loadList(); h.rerender(); });
        el.querySelector('[data-chfdel]').addEventListener('click', async () => {
          App.closeOverlay();
          const ok = await ctx.confirm({ title: 'Delete the folder ' + f.name + '?', tone: 'danger', body: 'Folders inside it are deleted too. Their conversations move back to no folder; no conversation is deleted.', kv: [['Conversations here', esc(String(f.conversations))]], ok: 'Delete folder' });
          if (!ok) return;
          try { const r = await App.del('/api/chat/folders/' + enc(f.id)); App.toast('Folder deleted. ' + esc(String((r && r.conversations) || 0)) + ' conversation' + (r && r.conversations === 1 ? '' : 's') + ' moved back to no folder.', 'ok'); if (st.folderFilter === f.id) st.folderFilter = 'all'; await refresh(st); } catch (err) { App.fail(err, 'Could not delete the folder'); }
        });
      }
    });
  }

  async function fileConv(st, convId, folderId) {
    try {
      await App.api('PUT', cUrl(convId) + '/folder', { folderId: folderId || null });
      const f = folderId ? folderById(st, folderId) : null;
      App.toast(f ? 'Moved to ' + esc(pathName(st, f)) + '.' : 'Moved out of its folder.', 'ok');
      await refresh(st);
    } catch (err) { App.fail(err, 'Could not move the conversation'); }
  }

  function moveConv(ctx, convId) {
    const st = h.S(); const c = (st.convos || []).find((x) => x.id === convId); if (!c) return;
    const cur = c.folderId || '';
    const rows = [{ id: '', label: 'No folder', depth: 1 }].concat(ordered(st).map((x) => ({ id: x.f.id, label: x.f.name, depth: x.depth })));
    ctx.modal({
      title: 'Move to folder',
      body: '<div class="fg2">' + esc(c.title || 'Untitled conversation') + '</div>'
        + '<fieldset class="ch-pick ch-fpick"><legend class="sr">Folder</legend>' + rows.map((r) => '<label class="ch-pickrow ch-fl' + r.depth + '"><input type="radio" name="ch-fmove" value="' + esc(r.id) + '"' + (r.id === cur ? ' checked' : '') + '><span class="grow">' + esc(r.label) + '</span></label>').join('') + '</fieldset>'
        + (foldersOf(st).length ? '' : '<div class="muted" style="font-size:12px">You have no folders yet. Create one with New folder above the list.</div>'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Move', { kind: 'primary', attrs: 'data-chmok' }),
      onMount(el) {
        const first = el.querySelector('input[name=ch-fmove]:checked') || el.querySelector('input[name=ch-fmove]'); if (first) first.focus();
        el.querySelector('[data-chmok]').addEventListener('click', async () => {
          const picked = el.querySelector('input[name=ch-fmove]:checked'); const to = picked ? picked.value : '';
          App.closeOverlay();
          if (to === cur) return;
          await fileConv(st, convId, to);
        });
      }
    });
  }

  // ---------- message groups ----------
  const groupsOf = (st) => (st.conv && st.groupsFor === st.conv.id ? st.groups || [] : []);
  function loadGroups(st) {
    const id = st.conv && st.conv.id; if (!id || st.groupsLoading === id) return;
    st.groupsLoading = id;
    App.get(cUrl(id) + '/groups').then((list) => { if (st.conv && st.conv.id === id) { st.groups = list; st.groupsFor = id; } })
      .catch(() => { st.groups = []; st.groupsFor = id; })
      .finally(() => { st.groupsLoading = null; h.schedule(); });
  }
  /** Selection and the open group belong to one conversation. */
  function sync(st) {
    const id = st.conv ? st.conv.id : null;
    if (st.orgFor !== id) { st.orgFor = id; st.selecting = false; st.selected = {}; st.openGroup = null; }
    if (id && st.groupsFor !== id) loadGroups(st);
  }
  const selectedIds = (st) => Object.keys(st.selected || {}).filter((k) => st.selected[k]);

  function headHtml(st) {
    if (!st.conv || !App.can('chat:write') || !st.conv.messages.length) return '';
    return UI.btn(st.selecting ? 'Done selecting' : 'Select messages', { kind: 'ghost', size: 'sm', icon: 'check', attrs: 'data-chselect aria-pressed="' + (st.selecting ? 'true' : 'false') + '"' });
  }
  function selbarHtml(st) {
    if (!st.selecting || !st.conv) return '';
    const n = selectedIds(st).length;
    return '<div class="ch-selbar" role="region" aria-label="Selected messages"><span class="grow" aria-live="polite">' + (n ? n + ' message' + (n === 1 ? '' : 's') + ' selected' : 'Tick the messages to group, then save them under a name.') + '</span>'
      + UI.btn('Select all shown', { size: 'sm', kind: 'ghost', attrs: 'data-chselall' }) + UI.btn('Save as group', { size: 'sm', kind: 'primary', attrs: 'data-chgsave', disabled: !n }) + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-chselect' }) + '</div>';
  }
  function wrapMsg(st, m, html) {
    const g = st.openGroup ? groupsOf(st).find((x) => x.id === st.openGroup) : null;
    const inGroup = !!(g && g.messageIds.indexOf(m.id) >= 0);
    if (!st.selecting && !inGroup) return html;
    const on = !!(st.selected && st.selected[m.id]);
    const box = st.selecting ? '<label class="ch-selrow"><input type="checkbox" data-chsel="' + esc(m.id) + '"' + (on ? ' checked' : '') + '> ' + (m.role === 'user' ? 'Select this question' : 'Select this answer') + '</label>' : '';
    return '<div class="ch-selwrap' + (on ? ' on' : '') + (inGroup ? ' ch-ingroup' : '') + '"' + (inGroup ? ' data-ingroup' : '') + '>' + box + html + '</div>';
  }
  function sideHtml(st) {
    if (!st.conv) return '';
    const list = groupsOf(st);
    const can = App.can('chat:write');
    let h2 = '<div class="eyebrow">Message groups</div>';
    if (st.groupsFor !== st.conv.id) return h2 + '<div class="muted" style="font-size:12px">Loading…</div>';
    if (!list.length) return h2 + '<div class="muted" style="font-size:12px">None yet.' + (can ? ' Select messages to save them under a name, such as final answer or ideas.' : '') + '</div>' + (can && !st.selecting && st.conv.messages.length ? UI.btn('Select messages', { size: 'sm', icon: 'check', attrs: 'data-chselect' }) : '');
    const open = st.openGroup ? list.find((x) => x.id === st.openGroup) : null;
    if (open) {
      const shown = {}; h.pathOf(st.conv).forEach((m) => { shown[m.id] = true; });
      const off = open.messageIds.filter((id) => !shown[id]).length;
      h2 += UI.notice('Showing ' + esc(open.name) + ': ' + esc(String(open.messageIds.length - off)) + ' highlighted' + (off ? ', ' + esc(String(off)) + ' on another branch (they are still exported)' : '') + '.', 'info', UI.btn('Clear', { size: 'xs', kind: 'ghost', attrs: 'data-chgclose' }));
    }
    h2 += '<div class="ch-glist">' + list.map((g) => '<div class="ch-grow' + (open && open.id === g.id ? ' on' : '') + '">'
      + '<button type="button" class="ch-gname" data-chgopen="' + esc(g.id) + '" aria-pressed="' + (open && open.id === g.id ? 'true' : 'false') + '"><span class="t">' + esc(g.name) + '</span><span class="muted s">' + esc(String(g.messageIds.length)) + ' message' + (g.messageIds.length === 1 ? '' : 's') + '</span></button>'
      + UI.iconbtn('download', 'Export ' + g.name, { cls: 'sm ghost', attrs: 'data-chgexport="' + esc(g.id) + '"' })
      + (can ? UI.iconbtn('edit', 'Rename ' + g.name, { cls: 'sm ghost', attrs: 'data-chgrename="' + esc(g.id) + '"' }) + UI.iconbtn('trash', 'Delete ' + g.name, { cls: 'sm ghost', attrs: 'data-chgdelete="' + esc(g.id) + '"' }) : '') + '</div>').join('') + '</div>';
    if (can && !st.selecting) h2 += UI.btn('Select messages', { size: 'sm', icon: 'check', attrs: 'data-chselect' });
    return h2;
  }

  function saveGroup(ctx) {
    const st = h.S(); const conv = st.conv; const ids = selectedIds(st); if (!conv || !ids.length) return;
    const list = groupsOf(st);
    const targets = [{ value: '', label: 'A new group' }].concat(list.map((g) => ({ value: g.id, label: 'Add to ' + g.name })));
    ctx.modal({
      title: 'Save ' + ids.length + ' message' + (ids.length === 1 ? '' : 's') + ' as a group',
      body: (list.length ? UI.field('Save to', UI.select(targets, '', 'data-chgto')) : '') + '<div data-chgnamehost>' + UI.field('Group name', UI.input('', { attrs: 'data-chgname maxlength="100"', placeholder: 'final answer' })) + '</div>'
        + '<div class="muted" style="font-size:12px">A group points at messages of this conversation; it holds no copy. Whoever can read the conversation can see its groups.</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save group', { kind: 'primary', attrs: 'data-chgok' }),
      onMount(el) {
        const to = el.querySelector('[data-chgto]'); const host = el.querySelector('[data-chgnamehost]');
        const inp = el.querySelector('[data-chgname]'); inp.focus();
        if (to) to.addEventListener('change', () => { host.hidden = !!to.value; });
        const go = async () => {
          const target = to ? to.value : '';
          try {
            let g;
            if (target) { const old = list.find((x) => x.id === target); g = await App.patch(cUrl(conv.id) + '/groups/' + enc(target), { messageIds: old.messageIds.concat(ids.filter((x) => old.messageIds.indexOf(x) < 0)) }); }
            else { const name = inp.value.trim(); if (!name) { App.toast('A group needs a name.'); return; } g = await App.post(cUrl(conv.id) + '/groups', { name, messageIds: ids }); }
            App.closeOverlay(); App.toast('Saved to the group ' + esc(g.name) + '.', 'ok');
            st.selecting = false; st.selected = {}; st.groupsFor = null; st.openGroup = g.id;
            loadGroups(st); h.rerender();
          } catch (err) { App.fail(err, 'Could not save the group'); }
        };
        el.querySelector('[data-chgok]').addEventListener('click', go);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      }
    });
  }
  function renameGroup(ctx, id) {
    const st = h.S(); const g = groupsOf(st).find((x) => x.id === id); if (!g || !st.conv) return;
    const convId = st.conv.id;
    ctx.modal({
      title: 'Rename group',
      body: UI.field('Group name', UI.input(g.name, { attrs: 'data-chgname maxlength="100"' })),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Rename', { kind: 'primary', attrs: 'data-chgok' }),
      onMount(el) {
        const inp = el.querySelector('[data-chgname]'); inp.focus(); inp.select();
        const go = async () => {
          const name = inp.value.trim(); if (!name) { App.toast('A group needs a name.'); return; }
          try { await App.patch(cUrl(convId) + '/groups/' + enc(g.id), { name }); App.closeOverlay(); App.toast('Renamed to ' + esc(name) + '.', 'ok'); st.groupsFor = null; loadGroups(st); } catch (err) { App.fail(err, 'Could not rename the group'); }
        };
        el.querySelector('[data-chgok]').addEventListener('click', go);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      }
    });
  }
  function openGroup(st, id) {
    st.openGroup = st.openGroup === id ? null : id; st.selecting = false;
    h.rerender();
    if (st.openGroup) setTimeout(() => { const el = document.querySelector('#main [data-ingroup]'); if (el) el.scrollIntoView({ block: 'center' }); }, 30);
  }

  // ---------- events ----------
  function bind(ctx) {
    const st = ctx.state;
    ctx.on('change', '[data-chffilter]', async (e, t) => { st.folderFilter = t.value; await h.loadList(); h.rerender(); const s = ctx.$('[data-chffilter]'); if (s) s.focus(); });
    ctx.on('click', '[data-chfnew]', () => newFolder(ctx, null));
    ctx.on('click', '[data-chfedit]', (e, t) => editFolder(ctx, t.dataset.chfedit));
    ctx.on('click', '[data-chftoggle]', (e, t) => {
      const id = t.dataset.chftoggle; const c = readCollapsed(); const i = c.indexOf(id);
      if (i >= 0) c.splice(i, 1); else c.push(id);
      writeCollapsed(c);
      const el = ctx.$('[data-region="list"]'); if (el) { el.innerHTML = listHtml(st); const b = el.querySelector('[data-chftoggle="' + id + '"]'); if (b) b.focus(); }
    });
    ctx.on('click', '[data-chmove]', (e, t) => moveConv(ctx, t.dataset.chmove));
    // Drag and drop is a shortcut for Move to folder.
    ctx.on('dragstart', '[data-chdrag]', (e, t) => { try { e.dataTransfer.setData('text/plain', t.dataset.chdrag); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* ignore */ } st.dragging = t.dataset.chdrag; });
    ctx.on('dragend', '[data-chdrag]', () => { st.dragging = null; ctx.$$('.ch-drop').forEach((x) => x.classList.remove('ch-drop')); });
    ctx.on('dragover', '[data-chdrop]', (e, t) => { if (!st.dragging) return; e.preventDefault(); t.classList.add('ch-drop'); });
    ctx.on('dragleave', '[data-chdrop]', (e, t) => { t.classList.remove('ch-drop'); });
    ctx.on('drop', '[data-chdrop]', (e, t) => {
      e.preventDefault(); t.classList.remove('ch-drop');
      const id = st.dragging; st.dragging = null; if (!id) return;
      const to = t.dataset.chdrop === 'none' ? null : t.dataset.chdrop;
      const c = (st.convos || []).find((x) => x.id === id);
      if (c && (c.folderId || null) !== to) fileConv(st, id, to);
    });
    ctx.on('click', '[data-chselect]', () => { st.selecting = !st.selecting; st.selected = {}; st.openGroup = null; h.rerender(); });
    ctx.on('change', '[data-chsel]', (e, t) => { st.selected = st.selected || {}; st.selected[t.dataset.chsel] = t.checked; const w = t.closest('.ch-selwrap'); if (w) w.classList.toggle('on', t.checked); const bar = ctx.$('[data-region="selbar"]'); if (bar) bar.innerHTML = selbarHtml(st); });
    ctx.on('click', '[data-chselall]', () => { st.selected = {}; h.pathOf(st.conv).forEach((m) => { st.selected[m.id] = true; }); h.rerender(); });
    ctx.on('click', '[data-chgsave]', () => saveGroup(ctx));
    ctx.on('click', '[data-chgopen]', (e, t) => openGroup(st, t.dataset.chgopen));
    ctx.on('click', '[data-chgclose]', () => { st.openGroup = null; h.rerender(); });
    ctx.on('click', '[data-chgrename]', (e, t) => renameGroup(ctx, t.dataset.chgrename));
    ctx.on('click', '[data-chgexport]', (e, t) => { const g = groupsOf(st).find((x) => x.id === t.dataset.chgexport); if (g && st.conv) h.exportModal(ctx, st.conv.id, g); });
    ctx.on('click', '[data-chgdelete]', async (e, t) => {
      const g = groupsOf(st).find((x) => x.id === t.dataset.chgdelete); if (!g || !st.conv) return;
      const ok = await ctx.confirm({ title: 'Delete the group ' + g.name + '?', tone: 'danger', body: 'Only the group goes; its messages stay in the conversation.', ok: 'Delete group' });
      if (!ok) return;
      try { await App.del(cUrl(st.conv.id) + '/groups/' + enc(g.id)); App.toast('Group deleted.', 'ok'); if (st.openGroup === g.id) st.openGroup = null; st.groupsFor = null; loadGroups(st); h.rerender(); } catch (err) { App.fail(err, 'Could not delete the group'); }
    });
  }

  const css = '.ch-ftools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.ch-ftools .select{flex:1 1 160px;min-width:0}'
    + '.ch-crow{display:flex;align-items:center;gap:2px}.ch-crow>.listlink{flex:1 1 auto;min-width:0}.ch-crow>.iconbtn{opacity:.6;flex-shrink:0}.ch-crow:hover>.iconbtn,.ch-crow>.iconbtn:focus{opacity:1}'
    + '.ch-fhead{display:flex;align-items:center;gap:2px;border-radius:6px;margin-top:4px}.ch-fhead.ch-drop{background:var(--accent-tint);outline:2px dashed var(--accent)}'
    + '.ch-ftoggle{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--fg);font:inherit;font-size:13px;font-weight:600;text-align:left;padding:5px 6px;border-radius:6px;cursor:pointer}.ch-ftoggle:hover{background:var(--sel)}'
    + '.ch-ftoggle .fn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ch-ftoggle .fc{font-size:12px;color:var(--muted);font-weight:400}'
    + '.ch-fchev{display:inline-flex;transition:transform .12s}.ch-fchev.open{transform:rotate(90deg)}'
    + '.ch-fl2{padding-left:12px}.ch-fl3{padding-left:24px}.ch-fl4{padding-left:36px}.ch-fi1{padding-left:8px}.ch-fi2{padding-left:8px}.ch-fi3{padding-left:8px}'
    + '.ch-fempty{font-size:12px;color:var(--muted);padding:4px 8px}.ch-floose{padding:8px 6px 2px}'
    + '.ch-fpick{margin:8px 0;padding:0}.ch-fpick .ch-fl2{padding-left:24px}.ch-fpick .ch-fl3{padding-left:40px}'
    + '.ch-selbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--panel);font-size:13px}'
    + '.ch-selwrap{display:flex;flex-direction:column;gap:4px;border-radius:8px;padding:4px 6px;border:1px dashed transparent}.ch-selwrap.on{border-color:var(--accent);background:var(--accent-tint)}'
    + '.ch-selrow{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--fg2);cursor:pointer}.ch-selrow input{accent-color:var(--accent)}'
    + '.ch-ingroup{border:1px solid var(--accent);background:var(--accent-tint)}'
    + '.ch-glist{display:flex;flex-direction:column;gap:2px}.ch-grow{display:flex;align-items:center;gap:2px;border-radius:6px}.ch-grow.on{background:var(--accent-tint)}'
    + '.ch-gname{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;align-items:flex-start;border:0;background:transparent;color:var(--fg);font:inherit;text-align:left;padding:5px 6px;border-radius:6px;cursor:pointer}.ch-gname:hover{background:var(--sel)}'
    + '.ch-gname .t{font-size:13px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ch-gname .s{font-size:11px}';

  App.chatOrganize = {
    init(helpers) { h = helpers; },
    css, loadFolders, listQuery, listHtml, sync, headHtml, selbarHtml, wrapMsg, sideHtml, bind
  };
})();
