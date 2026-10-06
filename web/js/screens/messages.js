(function () {
  const { UI, esc } = App;

  // Messages and feed (B-3411): conversations, threads, reactions and pins (/api/messaging), the workspace feed with
  // digests and trending (/api/feed), and blocks, mutes, follows, lists and the contact rule (/api/social). The server
  // leaves out everything from people in a block with the reader; this screen also drops any such item it is handed.
  const ID = 'messages';
  const enc = encodeURIComponent;
  const REACTIONS = ['like', 'celebrate', 'support', 'insightful', 'funny'];
  const LEVEL = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
  const timeOnly = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
  const meId = () => (App.me && App.me.user ? App.me.user.id : null);
  const myName = () => (App.me && App.me.user ? App.me.user.displayName || App.me.user.username : '');
  const workspaces = () => (App.me && App.me.workspaces) || [];
  const curWs = () => workspaces().find((w) => w.id === App.me.workspace) || workspaces()[0] || null;
  const wsName = (id) => { const w = workspaces().find((x) => x.id === id); return w ? w.name : 'another workspace'; };
  const overlayOpen = () => !!document.getElementById('overlay');
  const S = () => App.stateFor(ID);
  const put = (url, body) => App.api('PUT', url, body === undefined ? {} : body);
  const reactName = (e) => String(e || '').replace(/^:|:$/g, '');
  const sizeText = (n) => (n == null ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
  const minutesUntilTomorrow = () => { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0); return Math.max(1, Math.ceil((t.getTime() - Date.now()) / 60000)); };
  const blockedIds = (st) => new Set(((st.social && st.social.blocks) || []).map((b) => b.userId));
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || false;
  const feedKeyOf = (st) => st.feedSeg + '|' + (st.groupSel || '') + '|' + (st.tag || '') + '|' + (st.listFeed ? st.listFeed.id : '');
  // Sprint 34 (B-5801): a person's name opens their profile; (B-5802) their status, watched over the socket.
  const STATUS_KIND = { available: 'ok', away: 'warn', busy: 'danger', offline: 'outline' };
  const who = (id, name) => (id && App.can('social:read') ? '<a class="messages-who" href="#/person?user=' + enc(id) + '">' + esc(name) + '</a>' : esc(name));
  const statusPill = (st, id) => { const v = id && st.presence && st.presence[id]; return v && !blockedIds(st).has(id) ? UI.pill(v, STATUS_KIND[v]) : ''; };

  // ---------------- realtime ----------------
  // The screen joins the rooms of the conversations it lists (ids-only events: it fetches through the API, which
  // leaves out people in a block with the reader) and the feed rooms of the current workspace and of the user's home.
  const live = { sock: null, handlers: [], rooms: new Map(), timers: {}, ctx: null, pending: false, typingAt: 0, watched: '' };
  function throttle(name, ms, fn) { if (live.timers[name]) return; live.timers[name] = setTimeout(() => { live.timers[name] = null; fn(); }, ms); }
  function paint() {
    if (App.state.route !== ID || !live.ctx) return;
    if (overlayOpen()) { if (!live.pending) { live.pending = true; setTimeout(() => { live.pending = false; paint(); }, 300); } return; }
    live.ctx.rerender();
  }
  function join(kind, id) {
    const key = kind + ':' + id;
    if (!live.sock || live.rooms.has(key)) return;
    live.rooms.set(key, { kind, id });
    live.sock.emit('room.join', { kind, id }, () => undefined);
  }
  function detach() {
    if (live.sock) { live.rooms.forEach((r) => live.sock.emit('room.leave', r)); live.handlers.forEach((h) => live.sock.off(h[0], h[1])); if (live.watched) live.sock.emit('presence.unwatch'); }
    live.rooms.clear(); live.sock = null; live.handlers = []; live.watched = '';
    Object.keys(live.timers).forEach((k) => { clearTimeout(live.timers[k]); live.timers[k] = null; });
  }
  function attach() {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    const on = (ev, fn) => { const g = (d) => { if (App.state.route !== ID) { detach(); return; } fn(d || {}); }; live.sock.on(ev, g); live.handlers.push([ev, g]); };
    const convEvent = (d) => {
      const st = S();
      if (d.authorId && blockedIds(st).has(d.authorId)) return;
      if (d.id && d.id === st.convo) throttle('msgs', 300, () => loadConvo(st, true).then(paint));
      throttle('list', 800, () => loadList(st).then(paint));
    };
    ['conversation.message.created', 'conversation.message.edited', 'conversation.message.deleted', 'conversation.reaction', 'conversation.pin', 'conversation.member.added', 'conversation.member.removed', 'conversation.member.role', 'conversation.updated'].forEach((ev) => on(ev, convEvent));
    on('conversation.read', (d) => { const st = S(); if (d.id === st.convo) throttle('receipts', 500, () => loadReceipts(st).then(updatePresence)); });
    on('conversation.typing', (d) => { const st = S(); if (d.id !== st.convo || d.userId === meId() || blockedIds(st).has(d.userId)) return; st.typing = st.typing || {}; st.typing[d.userId] = d.typing ? Date.now() + 6000 : 0; updatePresence(); setTimeout(updatePresence, 6500); });
    on('conversation.presence', (d) => { const st = S(); if (d.id !== st.convo || blockedIds(st).has(d.userId)) return; st.online = st.online || {}; st.online[d.userId] = d.state === 'online'; updatePresence(); });
    const feedEvent = (d) => { const st = S(); if (d.authorId && blockedIds(st).has(d.authorId)) return; if (st.view === 'feed') throttle('feed', 600, () => loadFeed(st).then(paint)); };
    ['feed.post.created', 'feed.post.updated', 'feed.post.deleted', 'feed.comment.created'].forEach((ev) => on(ev, feedEvent));
    // A conversation someone else started arrives as a notification to this user's room.
    on('notification', () => throttle('list', 800, () => loadList(S()).then(paint)));
    on('room.closed', () => throttle('list', 300, () => loadList(S()).then(paint)));
    on('connect', () => { const rooms = Array.from(live.rooms.values()); live.rooms.clear(); rooms.forEach((r) => join(r.kind, r.id)); live.watched = ''; watchPresence(S()); });
    on('presence.changed', (d) => { const st = S(); if (!d.userId || blockedIds(st).has(d.userId)) return; st.presence = st.presence || {}; if (st.presence[d.userId] === d.status) return; st.presence[d.userId] = d.status; throttle('presence', 400, paint); });
  }
  /** Watches the statuses of the people on screen: the open conversation's and, on People, the directory. */
  function watchPresence(st) {
    if (!live.sock || !live.sock.connected || !App.can('social:read')) return;
    const ids = [];
    ((st.detail && st.detail.people) || []).forEach((p) => ids.push(p.userId));
    if (st.view === 'people' && st.people) st.people.forEach((p) => ids.push(p.userId));
    const uniq = ids.filter((v, i, a) => v && v !== meId() && a.indexOf(v) === i).slice(0, 200);
    const key = uniq.join(',');
    if (!uniq.length || key === live.watched) return;
    live.watched = key;
    live.sock.emit('presence.watch', { userIds: uniq }, (r) => { if (r && r.ok) { st.presence = Object.assign({}, st.presence || {}, r.statuses || {}); paint(); } });
  }
  window.addEventListener('hashchange', () => { if (App.parse().route !== ID) detach(); });

  // ---------------- data ----------------
  function loadList(st) {
    return App.get('/api/messaging/conversations').then((list) => {
      st.convos = list;
      list.slice(0, 40).forEach((c) => join('conversation', c.id));
    }).catch((err) => { if (!st.convos) st.loadError = err; });
  }
  function loadConvo(st, quiet) {
    const id = st.convo; if (!id) return Promise.resolve();
    st.msgFor = id;
    return Promise.all([App.get('/api/messaging/conversations/' + enc(id)), App.get('/api/messaging/conversations/' + enc(id) + '/messages?limit=50'), App.get('/api/messaging/conversations/' + enc(id) + '/receipts').catch(() => [])])
      .then(([detail, msgs, receipts]) => {
        if (st.convo !== id) return null;
        st.detail = detail; st.msgs = msgs.slice().reverse(); st.hasMore = msgs.length >= 50; st.receipts = receipts;
        return st.inspTab === 'pins' ? loadPins(st) : null;
      })
      .catch((err) => { if (err.status === 404) { st.convo = null; st.detail = null; st.msgs = []; if (!quiet) App.toast('That conversation is no longer available to you.', 'warn'); } else if (!quiet) App.fail(err, 'Conversation not loaded'); });
  }
  function loadPins(st) { if (!st.convo) return Promise.resolve(); return App.get('/api/messaging/conversations/' + enc(st.convo) + '/pins').then((p) => { st.pins = p; }).catch(() => { st.pins = []; }); }
  function loadReceipts(st) { if (!st.convo) return Promise.resolve(); return App.get('/api/messaging/conversations/' + enc(st.convo) + '/receipts').then((r) => { st.receipts = r; }).catch(() => undefined); }
  function loadSocial(st) {
    if (!App.can('social:read')) { st.social = { contactRule: 'workspace', blocks: [], mutes: [], following: [], followers: [], lists: [] }; return Promise.resolve(); }
    return Promise.all([App.get('/api/social/settings'), App.get('/api/social/blocks'), App.get('/api/social/mutes'), App.get('/api/social/following'), App.get('/api/social/followers'), App.get('/api/social/lists')])
      .then(([set, blocks, mutes, following, followers, lists]) => { st.social = { contactRule: set.contactRule, blocks, mutes, following, followers, lists }; })
      .catch((err) => { if (!st.social) st.loadError = err; });
  }
  function people(st) {
    if (st.people) return Promise.resolve(st.people);
    return App.get('/api/social/people').then((p) => { st.people = p; return p; });
  }
  function feedUrl(st) {
    const ws = curWs();
    const page = 'limit=20' + (st.feedCursor ? '&cursor=' + enc(st.feedCursor) : '');
    switch (st.feedSeg) {
      case 'home': return '/api/feed/home?' + page;
      case 'ws': return ws ? '/api/feed/workspaces/' + enc(ws.id) + '?' + page : null;
      case 'groups': return st.groupSel ? '/api/feed/groups/' + enc(st.groupSel) + '?' + page : null;
      case 'bookmarks': return '/api/feed/bookmarks?' + page;
      case 'tag': return st.tag ? '/api/feed/tags/' + enc(st.tag) + '?' + page : null;
      case 'list': return st.listFeed ? '/api/feed/lists/' + enc(st.listFeed.id) + '?' + page : null;
      default: return null;
    }
  }
  function loadFeed(st, more) {
    const ws = curWs();
    const jobs = [];
    if (!st.groups && App.can('groups:read') && ws) jobs.push(App.get('/api/groups?workspace=' + enc(ws.id)).then((g) => { st.groups = g.filter((x) => x.role || x.visibility === 'public'); }).catch(() => { st.groups = []; }));
    else if (!st.groups) st.groups = [];
    if (!st.digests && ws) jobs.push(App.get('/api/feed/workspaces/' + enc(ws.id) + '/digests').then((d) => { st.digests = d; }).catch(() => { st.digests = []; }));
    if (st.feedSettings === undefined && App.can('feed:manage') && ws) jobs.push(App.get('/api/feed/workspaces/' + enc(ws.id) + '/settings').then((x) => { st.feedSettings = x; }).catch(() => { st.feedSettings = null; }));
    if (!st.profiles && App.can('chat:read')) jobs.push(App.get('/api/chat/profiles').then((p) => { st.profiles = p; }).catch(() => { st.profiles = []; }));
    return Promise.all(jobs).then(() => {
      if (st.feedSeg === 'groups' && !st.groupSel && st.groups.length) st.groupSel = st.groups[0].id;
      const key = feedKeyOf(st);
      st.feedError = null;
      if (st.feedSeg === 'trending') {
        return (ws ? App.get('/api/feed/trending?workspace=' + enc(ws.id)).then((t) => { st.trending = t; }).catch((err) => { st.feedError = err; }) : Promise.resolve()).then(() => { st.feedKey = key; st.posts = []; });
      }
      if (!more) st.feedCursor = null;
      const url = feedUrl(st);
      if (!url) { st.feedKey = key; st.posts = []; st.next = null; return null; }
      return App.get(url).then((r) => {
        const bl = blockedIds(st);
        const items = r.items.filter((p) => !(p.author && bl.has(p.author.id)));
        st.posts = more ? (st.posts || []).concat(items) : items; st.next = r.nextCursor; st.feedKey = key;
      }).catch((err) => { st.feedKey = key; st.posts = []; st.next = null; st.feedError = err; });
    });
  }
  function loadListDetail(st) {
    const lists = (st.social && st.social.lists) || [];
    const sel = lists.find((l) => l.id === st.list) || lists[0];
    if (!sel) { st.listDetail = null; return Promise.resolve(); }
    st.list = sel.id;
    return App.get('/api/social/lists/' + enc(sel.id)).then((d) => { st.listDetail = d; }).catch(() => { st.listDetail = null; });
  }

  // The read and typing line under the timeline, updated in place (no re-render) as socket events arrive.
  function presenceText(st) {
    const d = st.detail; if (!d) return '';
    const names = {}; (d.people || []).forEach((p) => { names[p.userId] = p.displayName || p.username; });
    const typing = Object.keys(st.typing || {}).filter((u) => st.typing[u] > Date.now() && names[u]).map((u) => names[u]);
    const online = Object.keys(st.online || {}).filter((u) => st.online[u] && names[u] && u !== meId()).map((u) => names[u]);
    const last = (st.msgs || []).filter((m) => m.state === 'sent').slice(-1)[0];
    const read = last ? (st.receipts || []).filter((r) => r.userId !== meId() && r.lastReadId && r.lastReadId >= last.id && names[r.userId]).map((r) => names[r.userId]) : [];
    const out = [];
    if (typing.length) out.push(typing.join(' and ') + (typing.length > 1 ? ' are' : ' is') + ' typing.');
    if (online.length) out.push(online.join(' and ') + (online.length > 1 ? ' are' : ' is') + ' online.');
    if (read.length && last) out.push('Read by ' + read.join(' and ') + ' up to ' + timeOnly(last.createdAt) + '.');
    return out.join(' ');
  }
  function updatePresence() { const el = document.getElementById('messages-presence'); if (el) el.textContent = presenceText(S()); }

  App.register({
    id: ID, title: 'Messages and feed', live: true,
    summary: 'Direct and group conversations, threads, reactions and pins; the workspace feed, digests and trending; blocks, mutes, follows and lists',
    crumb: ['Messages and feed'],
    label: (st) => { if (st.view === 'messages') { const c = (st.convos || []).find((x) => x.id === st.convo); return c ? c.label : null; } return st.view === 'feed' ? 'internal' : null; },
    commands: [
      { label: 'New conversation', sub: 'Messages and feed', run(app) { const s = app.stateFor(ID); s.view = 'messages'; s.openNew = true; app.render(); } },
      { label: 'Write a post', sub: 'Messages and feed', run(app) { const s = app.stateFor(ID); s.view = 'feed'; s.feedSeg = 'ws'; app.render(); } }
    ],
    states: [
      { title: 'Blocked user never appears', tone: 'info', text: 'A blocked person\'s messages, posts, typing and presence are left out for you on every instance; they only read "does not accept messages from you".', apply(ctx) { const st = ctx.state; st.view = 'messages'; st.showBlockNote = true; ctx.rerender(); } },
      { title: 'Post held for review', tone: 'warn', text: 'A require-approval guardrail held the post: 202, visible only to its author, with a hold flag in the Flags queue.', apply(ctx) { const st = ctx.state; st.view = App.can('feed:read') ? 'feed' : 'messages'; st.feedSeg = 'ws'; st.showHeldNote = true; ctx.rerender(); } },
      { title: 'Contact rule refuses', tone: 'danger', text: 'Starting a conversation with someone whose rule or block excludes you is 403 with step contact, the same words either way.', apply(ctx) { const st = ctx.state; st.view = 'messages'; st.newKind = 'direct'; st.newProblem = null; st.newExplain = true; const b = ((st.social && st.social.blocks) || [])[0]; st.newTarget = b ? b.userId : null; st.openNew = true; ctx.rerender(); } },
      { title: 'Semantic search unavailable', tone: 'warn', text: 'Without MESSAGING_EMBED_MODEL, semantic and hybrid modes answer 409 and the default is keyword.', apply(ctx) { const st = ctx.state; st.view = 'messages'; st.searchMode = 'semantic'; st.searchQ = st.searchQ || 'the'; if (st.convo) st.openSearch = true; else st.demoNote = 'Search runs inside a conversation, and you have none yet. In a conversation, Search in semantic or hybrid mode answers 409 when MESSAGING_EMBED_MODEL names no approved embedding model; keyword search always works.'; ctx.rerender(); } },
      { title: 'Attachment in quarantine', tone: 'warn', text: 'A file whose current version has not passed its scan cannot be attached: 409 until the file.scan job finishes.', apply(ctx) { const st = ctx.state; st.view = 'messages'; st.attachExplain = true; if (st.convo && App.can('files:read')) st.openAttach = true; else st.demoNote = 'Attachments come from the file store. A file whose current version is still being scanned (type check, text classifier, ClamAV) is refused with 409 until the file.scan job marks it ready; open a conversation and use Attach from Files.'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      live.ctx = ctx;
      st.view = st.view || 'messages'; st.filter = st.filter || 'all'; st.q = st.q || ''; st.feedSeg = st.feedSeg || 'home'; st.peopleTab = st.peopleTab || 'blocks'; st.inspTab = st.inspTab || 'people';
      if (st.view === 'feed' && !App.can('feed:read')) st.view = 'messages';
      if (st.view === 'people' && !App.can('social:read')) st.view = 'messages';
      // Deep links (#/messages?convo=…, ?post=…, ?tag=…) apply once; the address keeps them across re-renders.
      const link = (ctx.params.convo || '') + '|' + (ctx.params.post || '') + '|' + (ctx.params.tag || '');
      if (link !== '||' && link !== st.appliedLink) {
        st.appliedLink = link;
        if (ctx.params.convo) { st.view = 'messages'; st.convo = ctx.params.convo; st.msgFor = null; }
        if (ctx.params.post) { st.view = 'feed'; st.feedSeg = 'ws'; st.focusPost = ctx.params.post; }
        if (ctx.params.tag) { st.view = 'feed'; st.feedSeg = 'tag'; st.tag = ctx.params.tag; }
      }
      attach();
      const ws = curWs();
      if (ws && App.can('feed:read')) { join('feed', ws.id); if (meId()) join('feed', meId()); }

      // ---- first load ----
      if (!st.loaded && !st.loadError && !st.loading) {
        st.loading = true;
        Promise.all([loadList(st), loadSocial(st)]).finally(() => { st.loading = false; st.loaded = true; paint(); });
      }
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Messages and feed', 'Conversations, the workspace feed and the people you follow') + (st.loadError ? UI.problem('Messages could not be loaded', st.loadError.message, traceOf(st.loadError)) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; st.loaded = false; ctx.rerender(); });
        return;
      }
      // ---- what the current view still needs ----
      if (st.view === 'messages') {
        if (!st.convos.some((c) => c.id === st.convo)) { st.convo = st.convos.length ? st.convos[0].id : null; st.msgFor = null; }
        if (st.convo && st.msgFor !== st.convo) { st.detail = null; st.msgs = null; st.typing = {}; st.online = {}; loadConvo(st).then(paint); }
      } else if (st.view === 'feed') {
        if (st.feedKey !== feedKeyOf(st) && !st.feedLoading) { st.feedLoading = true; loadFeed(st).finally(() => { st.feedLoading = false; paint(); }); }
      } else if (st.view === 'people' && st.peopleTab === 'lists' && st.social.lists.length && !(st.listDetail && st.listDetail.id === (st.list || st.social.lists[0].id)) && !st.listLoading) {
        st.listLoading = true; loadListDetail(st).finally(() => { st.listLoading = false; paint(); });
      }

      if (st.view === 'people' && st.peopleTab === 'directory' && !st.people && !st.peopleLoading) { st.peopleLoading = true; people(st).catch((err) => App.fail(err, 'People not loaded')).finally(() => { st.peopleLoading = false; paint(); }); }
      watchPresence(st);

      const segs = [{ id: 'messages', label: 'Messages' }].concat(App.can('feed:read') ? [{ id: 'feed', label: 'Feed' }] : []).concat(App.can('social:read') ? [{ id: 'people', label: 'People' }] : []);
      const nav = '<div class="hstack" style="margin-bottom:4px">' + UI.seg(segs, st.view, 'data-view aria-label="View"') + '</div>';
      const demo = st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-demook' })) : '';
      const body = st.view === 'messages' ? renderMessages(st) : st.view === 'feed' ? renderFeed(st) : renderPeople(st);

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .messages-list{display:flex;flex-direction:column;gap:2px}'
        + '#main .messages-thread{display:flex;flex-direction:column;gap:10px;max-width:760px}'
        + '#main .messages-msg{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px}#main .messages-msg:hover{background:var(--sel)}#main .messages-msg.mine{background:var(--accent-tint)}'
        // The board shows message actions on hover only; they stay visible so keyboard, touch and zoom users find them.
        + '#main .messages-msg .mactions{display:flex;gap:4px;flex-wrap:wrap}'
        + '#main .messages-meta{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted);flex-wrap:wrap}#main .messages-body{font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}'
        + '#main .messages-quote{border-left:2px solid var(--line2);padding:2px 8px;font-size:12px;color:var(--fg2);margin-bottom:2px;overflow-wrap:anywhere}'
        + '#main .messages-tomb{font-size:12px;color:var(--muted);font-style:italic;padding:6px 10px;border:1px dashed var(--line);border-radius:6px}'
        + '#main .messages-att{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;background:var(--panel);color:var(--fg);max-width:100%;overflow-wrap:anywhere}'
        + '#main .messages-composer{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px;display:flex;flex-direction:column;gap:8px}#main .messages-composer textarea{min-height:56px}'
        + '#main .messages-post{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}#main .messages-post.held{border-color:var(--warn-fg)}#main .messages-post .pactions{display:flex;gap:4px;flex-wrap:wrap;align-items:center}'
        + '#main .messages-comment{padding:6px 10px;border-left:2px solid var(--line);font-size:13px;overflow-wrap:anywhere}#main .messages-comment.reply{margin-left:18px}'
        + '#main .messages-tag{color:var(--accent);text-decoration:underline;font-weight:600}'
        + '#main .messages-who{color:inherit;text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:2px}#main .messages-who:hover{text-decoration-color:currentColor}'
        + '#main .messages-presence{font-size:12px;color:var(--muted);min-height:16px}'
        + '</style>' + body.replace('%NAV%', nav + demo);

      wire(ctx, st);
      if (st.openNew) { st.openNew = false; setTimeout(() => openNew(ctx, st), 0); }
      if (st.openSearch) { st.openSearch = false; setTimeout(() => openSearch(ctx, st), 0); }
      if (st.openAttach) { st.openAttach = false; setTimeout(() => openFilePicker(ctx, st, 'message'), 0); }
    }
  });

  // ---------------- Messages ----------------
  function convoTitle(c) { return c.kind === 'direct' ? (c.with ? c.with.displayName || c.with.username || 'Direct conversation' : 'Direct conversation') : c.title || 'Untitled conversation'; }
  function renderMessages(st) {
    const convos = st.convos.filter((c) => (st.filter === 'all' || (st.filter === 'unread' ? c.unread > 0 : c.kind === st.filter)) && (!st.q || convoTitle(c).toLowerCase().indexOf(st.q.toLowerCase()) >= 0));
    const c = st.convos.find((x) => x.id === st.convo) || null;
    const canWrite = App.can('messages:write');
    const list = '<div class="leftpane w320"><div class="hstack"><h2 class="eyebrow grow" style="margin:0">Conversations</h2>' + (canWrite ? UI.btn('New', { size: 'sm', icon: 'plus', attrs: 'data-newconvo' }) : '') + '</div>'
      + UI.search('Search conversations', 'data-cq', st.q)
      + '<div class="hstack gap6">' + UI.seg([{ id: 'all', label: 'All' }, { id: 'direct', label: 'Direct' }, { id: 'group', label: 'Group' }, { id: 'unread', label: 'Unread' }], st.filter, 'data-cfilter aria-label="Show"') + '</div>'
      + '<div class="messages-list">' + convos.map((x) => UI.listItem(esc(convoTitle(x)) + (x.muted ? ' <span class="muted" style="font-size:11px">muted</span>' : ''), esc((x.kind === 'group' ? (x.workspaceId ? wsName(x.workspaceId) + ', ' : '') + x.members + ' people' : 'direct') + (x.lastMessageAt ? ', ' + when(x.lastMessageAt) : '')), { active: x.id === st.convo, attrs: 'data-convo="' + esc(x.id) + '"', right: (x.unread ? UI.pill(String(x.unread), 'accent') : '') + UI.label(x.label, { sm: true }) })).join('') + (convos.length ? '' : st.convos.length ? UI.empty('No conversations match', 'Clear the filter or search.') : '<p class="muted" style="font-size:12px;padding:4px 8px">No conversations yet.</p>') + '</div></div>';
    const notices = blockNotice(st);
    if (!c) return list + '<div class="page">%NAV%' + notices + UI.pagehead('Messages', 'No conversation selected.') + UI.empty('Nothing here yet', 'Start a conversation with someone who shares a workspace with you.', canWrite ? UI.btn('New conversation', { kind: 'primary', attrs: 'data-newconvo' }) : '') + '</div>';
    const d = st.detail && st.detail.id === c.id ? st.detail : null;
    const msgs = (st.msgs || []).filter((m) => !blockedIds(st).has(m.authorId));
    const sub = c.kind === 'direct' ? 'Direct conversation with ' + esc(convoTitle(c)) + '. The label is the highest ceiling of the workspaces you share.' : esc(c.workspaceId ? wsName(c.workspaceId) : '') + ', ' + c.members + ' people, you are ' + esc(c.role) + '. Members read from the moment they were added.';
    const infer = App.can('inference:invoke');
    const head = UI.pagehead(convoTitle(c), sub, UI.label(c.label) + UI.btn('Search', { icon: 'search', size: 'sm', attrs: 'data-msearch' }) + (infer ? UI.btn('Summary', { icon: 'brain', size: 'sm', attrs: 'data-summary' }) + UI.btn('Digest', { size: 'sm', attrs: 'data-digest' }) : '') + UI.btn('Mark read', { kind: 'ghost', size: 'sm', attrs: 'data-markread', disabled: !c.unread }));
    const extra = (st.attachProblem ? UI.problem('Attachment refused (409)', st.attachProblem, false) + '<div>' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearattach' }) + '</div>' : '')
      + (st.sendProblem ? UI.problem(st.sendProblem.title, st.sendProblem.detail, st.sendProblem.trace) + '<div>' + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearsend' }) + '</div>' : '')
      + (st.lastSummary && st.lastSummary.conversationId === c.id ? UI.panel(st.lastSummary.kind === 'digest' ? 'Catch-up digest' : 'Summary', '<div class="serif" style="font-size:15px;line-height:1.5">' + summaryHtml(st.lastSummary) + '</div><div class="muted" style="font-size:12px">Profile ' + esc(st.lastSummary.profile) + ', ' + st.lastSummary.messages + ' messages you can see were numbered and sent. Citations name only those; the answer passed the model-output checkpoint.</div>', { actions: UI.btn('Close', { kind: 'ghost', size: 'xs', attrs: 'data-closesummary' }) }) : '');
    const thread = !d ? UI.notice('Loading…', 'info') : '<div class="messages-thread" role="log" aria-label="Messages" aria-live="polite">' + (st.hasMore ? '<div>' + UI.btn('Load earlier messages', { kind: 'ghost', size: 'sm', attrs: 'data-earlier' }) + '</div>' : '') + (msgs.length ? msgs.map((m) => renderMsg(c, m, msgs)).join('') : '<p class="muted" style="font-size:13px">No messages yet.</p>') + '</div>';
    const replyTo = st.replyTo ? msgs.find((m) => m.id === st.replyTo) : null;
    const composer = !canWrite ? '' : '<div class="messages-composer">' + (replyTo ? '<div class="messages-quote hstack"><span class="grow">Replying to ' + esc(replyTo.authorName || 'a message') + '</span>' + UI.iconbtn('x', 'Cancel reply', { attrs: 'data-cancelreply', cls: 'sm ghost' }) + '</div>' : '')
      + UI.field('Message ' + convoTitle(c), UI.textarea(st.draft || '', { placeholder: 'Up to 10,000 characters; screened at the user-input checkpoint.', attrs: 'data-draft', rows: 2 }))
      + '<div class="hstack wrap"><span class="hstack gap6 wrap">' + (App.can('files:read') ? UI.btn('Attach from Files', { size: 'sm', icon: 'attach', attrs: 'data-attach' }) : '') + (st.pendingAttach || []).map((a) => '<span class="messages-att">' + UI.icon('attach', 12) + esc(a.name) + UI.iconbtn('x', 'Remove ' + a.name, { attrs: 'data-unattach="' + esc(a.id) + '"', cls: 'sm ghost' }) + '</span>').join('') + '</span><span class="grow"></span><span class="muted" style="font-size:12px">@username mentions notify people whose rule is mentions</span>' + UI.btn('Send', { kind: 'primary', size: 'sm', icon: 'send', attrs: 'data-send' }) + '</div></div>';
    return list + '<div class="page">%NAV%' + head + notices + extra + thread + '<div class="messages-presence" id="messages-presence" aria-live="polite">' + esc(presenceText(st)) + '</div>' + composer + '</div><aside class="inspector w360" aria-label="Conversation details">' + (d ? renderInspector(c, d, st) : '') + '</aside>';
  }
  function blockNotice(st) {
    if (!st.showBlockNote) return '';
    const blocks = (st.social && st.social.blocks) || [];
    const names = blocks.slice(0, 3).map((b) => esc(b.displayName || b.username) + ' (' + esc(day(b.createdAt)) + ')').join(', ') + (blocks.length > 3 ? ' and ' + (blocks.length - 3) + ' more' : '');
    const text = blocks.length ? '<b>Messages from people you blocked are left out.</b> You blocked ' + names + '. Their messages, reactions, receipts, typing and presence never reach your sockets on any instance; they see conversations without yours and read only "does not accept messages from you".'
      : '<b>You have blocked nobody.</b> When you block someone, their messages, reactions, receipts, typing and presence are left out for you on every instance, in every conversation and feed; they read only "does not accept messages from you".';
    return UI.notice(text + (App.can('social:read') ? ' <a href="#" data-gopeople>Manage blocks</a>' : ''), 'info', UI.btn('Hide', { kind: 'ghost', size: 'sm', attrs: 'data-hideblock' }));
  }
  function summaryHtml(s) {
    if (!s.summary) return s.kind === 'digest' ? 'Nothing from others after your read mark.' : 'Nothing to summarise yet.';
    const cites = {}; (s.citations || []).forEach((x) => { cites[x.n] = x.messageId; });
    return esc(s.summary).replace(/\[(\d+)\]/g, (all, n) => (cites[n] ? '<a href="#" data-cite="' + esc(cites[n]) + '">[' + n + ']</a>' : all));
  }
  function renderMsg(c, m, msgs) {
    if (m.state === 'deleted') return '<div class="messages-tomb">Message deleted by ' + esc(m.authorName || 'its author') + ', ' + esc(when(m.createdAt)) + '. The body, attachments, terms and reactions are gone; the row stays as a tombstone.</div>';
    if (m.state === 'hidden') return '<div class="messages-tomb">Message hidden by moderation, ' + esc(when(m.createdAt)) + '.</div>';
    const mine = m.authorId === meId();
    const canWrite = App.can('messages:write');
    const canDelete = canWrite && (mine || c.role === 'owner' || c.role === 'admin');
    const canPin = canWrite && (c.kind === 'direct' || c.role === 'owner' || c.role === 'admin');
    const quoted = m.replyTo ? msgs.find((x) => x.id === m.replyTo) : null;
    const author = mine ? myName() : m.authorName || 'Someone';
    return '<div class="messages-msg' + (mine ? ' mine' : '') + '" data-msg="' + esc(m.id) + '">'
      + (quoted ? '<div class="messages-quote">' + esc(quoted.authorName || '') + ': ' + esc((quoted.body || '').slice(0, 90)) + (quoted.body && quoted.body.length > 90 ? '…' : '') + '</div>' : m.replyTo ? '<div class="messages-quote">Replying to an earlier message</div>' : '')
      + (m.forwardedFrom ? '<div class="muted" style="font-size:11px">Forwarded</div>' : '')
      + '<div class="messages-meta"><b style="color:var(--fg)">' + who(m.authorId, author) + '</b><span>' + esc(when(m.createdAt)) + '</span>' + (m.edited ? '<span>edited ' + esc(when(m.editedAt)) + '</span>' : '') + (m.pinned ? UI.pill('pinned', 'accent') : '') + (LEVEL[m.label] > LEVEL[c.label] ? UI.label(m.label, { sm: true }) : '') + '</div>'
      + '<div class="messages-body">' + esc(m.body) + '</div>'
      + ((m.attachments || []).length ? '<div class="hstack wrap gap6">' + m.attachments.map((a) => (a.state === 'gone' || a.state === 'trashed' ? '<span class="messages-att">' + UI.icon('attach', 12) + esc(a.name || 'File') + ' ' + UI.pill(a.state === 'trashed' ? 'in trash' : 'unavailable', 'warn') + '</span>' : '<a class="messages-att" href="/api/files/' + esc(a.fileId) + '/content" download>' + UI.icon('attach', 12) + esc(a.name) + ' <span class="muted">' + esc(a.type || '') + (a.size != null ? ', ' + esc(sizeText(a.size)) : '') + '</span>' + (a.state !== 'ready' ? UI.pill('scanning', 'warn') : '') + '</a>')).join('') + '</div>' : '')
      + '<div class="hstack wrap gap6">' + (m.reactions || []).filter((r) => r.count).map((r) => UI.chip(esc(reactName(r.emoji)) + ' ' + r.count, r.mine, 'data-react="' + esc(m.id) + '" data-kind="' + esc(r.emoji) + '"' + (canWrite ? '' : ' disabled'))).join('') + (m.replyCount ? UI.btn(m.replyCount + (m.replyCount === 1 ? ' reply' : ' replies'), { kind: 'ghost', size: 'xs', attrs: 'data-thread="' + esc(m.id) + '"' }) : '') + '</div>'
      + '<div class="mactions">' + (canWrite ? REACTIONS.map((k) => UI.btn(k, { kind: 'ghost', size: 'xs', attrs: 'data-react="' + esc(m.id) + '" data-kind=":' + k + ':"' })).join('') + UI.btn('Reply', { kind: 'ghost', size: 'xs', attrs: 'data-reply="' + esc(m.id) + '"' }) : '') + UI.btn('Thread', { kind: 'ghost', size: 'xs', attrs: 'data-thread="' + esc(m.id) + '"' })
      + (canPin ? UI.btn(m.pinned ? 'Unpin' : 'Pin', { kind: 'ghost', size: 'xs', attrs: 'data-pin="' + esc(m.id) + '"' }) : '') + (canWrite ? UI.btn('Forward', { kind: 'ghost', size: 'xs', attrs: 'data-forward="' + esc(m.id) + '"' }) : '')
      + (mine && canWrite ? UI.btn('Edit', { kind: 'ghost', size: 'xs', attrs: 'data-edit="' + esc(m.id) + '"' }) : !mine && App.can('moderation:report') ? UI.btn('Report', { kind: 'ghost', size: 'xs', attrs: 'data-report="' + esc(m.id) + '"' }) : '')
      + (canDelete ? UI.btn('Delete', { kind: 'ghost', size: 'xs', attrs: 'data-del="' + esc(m.id) + '"' }) : '') + '</div></div>';
  }
  function renderInspector(c, d, st) {
    const pins = (st.pins || []).filter((m) => !blockedIds(st).has(m.authorId));
    const tabs = UI.tabs([{ id: 'people', label: 'People', count: (d.people || []).length }, { id: 'pins', label: 'Pins' }, { id: 'settings', label: 'Settings' }], st.inspTab, 'data-insptabs aria-label="Conversation"');
    const manager = c.kind === 'group' && (c.role === 'owner' || c.role === 'admin') && App.can('messages:write');
    let body = '';
    if (st.inspTab === 'people') {
      const following = new Set(((st.social && st.social.following) || []).map((f) => f.userId));
      body = '<div class="vstack gap6">' + (d.people || []).map((p) => { const me = p.userId === meId(); return '<div class="hstack" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="grow"><b>' + who(p.userId, p.displayName || p.username) + '</b>' + (me ? ' <span class="muted">(you)</span>' : ' ' + statusPill(st, p.userId)) + '<br><span class="muted" style="font-size:12px">' + esc(p.username || '') + (p.lastSeenAt ? ', last seen ' + esc(when(p.lastSeenAt)) : '') + '</span></span>' + UI.pill(p.role, p.role === 'owner' ? 'accent' : p.role === 'admin' ? 'info' : 'outline') + (!me && manager ? '<span class="relative">' + UI.iconbtn('dots', 'Member actions for ' + (p.displayName || p.username), { attrs: 'data-member="' + esc(p.userId) + '"', cls: 'sm ghost' }) + '</span>' : '') + '</div>'; }).join('') + '</div>'
        + (manager ? '<div style="margin-top:8px">' + UI.btn('Add member', { size: 'sm', icon: 'plus', attrs: 'data-addmember' }) + '</div><div class="muted" style="font-size:12px;margin-top:6px">Everyone must be a member of ' + esc(wsName(c.workspaceId)) + ' now and cleared for ' + esc(c.label) + '. A conversation keeps at least one owner.</div>'
          : c.kind === 'direct' && c.with ? '<div class="muted" style="font-size:12px;margin-top:8px">One direct conversation per pair. Either of you may pin. Relation: ' + (App.can('social:read') ? '<a href="#" data-gopeople>' + (following.has(c.with.userId) ? 'following' : 'not following') + '</a>' : 'not shown') + '.</div>' : '');
    } else if (st.inspTab === 'pins') {
      const unpin = App.can('messages:write') && (c.kind === 'direct' || c.role !== 'member');
      body = pins.length ? '<div class="vstack gap6">' + pins.map((m) => '<div class="panel" style="padding:8px 10px"><div class="muted" style="font-size:12px">' + esc(m.authorName || '') + ', ' + esc(when(m.createdAt)) + ', pinned ' + esc(when(m.pinnedAt)) + '</div><div style="font-size:13px;overflow-wrap:anywhere">' + esc(m.body) + '</div>' + (unpin ? '<div style="margin-top:4px">' + UI.btn('Unpin', { kind: 'ghost', size: 'xs', attrs: 'data-pin="' + esc(m.id) + '" data-pinned="1"' }) + '</div>' : '') + '</div>').join('') + '</div>' : UI.empty('No pins', c.kind === 'direct' ? 'Either of you can pin a message.' : 'Owners and admins pin messages for everyone.');
    } else {
      const w = App.can('messages:write');
      body = '<div class="vstack gap12">' + UI.field('Notify me', UI.select([{ value: 'all', label: 'Every message' }, { value: 'mentions', label: 'Mentions of @' + ((App.me && App.me.user && App.me.user.username) || 'you') + ' only' }, { value: 'none', label: 'Nothing' }], c.notify, 'data-notify' + (w ? '' : ' disabled')), 'Notifications name the sender, never the text or the title.')
        + (w ? UI.toggle('Muted' + (c.muted && c.mutedUntil ? ' until ' + when(c.mutedUntil) : ''), c.muted, 'data-mute data-manual') + (c.muted ? '' : '<div class="hstack gap6">' + UI.btn('Mute 1 h', { size: 'xs', attrs: 'data-mutefor="60"' }) + UI.btn('Mute until tomorrow', { size: 'xs', attrs: 'data-mutefor="tomorrow"' }) + '</div>') : '')
        + UI.kv([['Kind', esc(c.kind)], ['Label', UI.label(c.label, { sm: true })], ['Workspace', esc(c.workspaceId ? wsName(c.workspaceId) : 'shared workspaces')], ['Your role', esc(c.role)], ['Sealed at rest', 'tenant key, no end-to-end encryption, so search, summaries and moderation work']], 1)
        + (manager ? UI.btn('Rename', { size: 'sm', attrs: 'data-rename' }) : '')
        + (w ? (c.role === 'owner' ? UI.btn('Delete conversation', { kind: 'danger', size: 'sm', attrs: 'data-delconvo' }) : '') + (c.kind === 'group' ? UI.btn('Leave conversation', { size: 'sm', attrs: 'data-leave' }) : '') : '') + '</div>';
    }
    return '<h2 class="eyebrow" style="margin:0">Conversation</h2>' + tabs + '<div style="margin-top:8px">' + body + '</div>';
  }

  // ---------------- Feed ----------------
  const score = (p) => Object.keys(p.counts.reactions || {}).reduce((n, k) => n + p.counts.reactions[k], 0) + 2 * p.counts.comments + 3 * p.counts.reposts;
  const groupName = (st, id) => { const g = (st.groups || []).find((x) => x.id === id); return g ? g.name : 'a group'; };
  const authorName = (a) => (a ? a.displayName || a.username : 'Someone');
  function renderFeed(st) {
    const ws = curWs();
    const segItems = [{ id: 'home', label: 'Home' }, { id: 'ws', label: ws ? ws.name : 'Workspace' }, { id: 'groups', label: 'Groups' }, { id: 'bookmarks', label: 'Bookmarks' }, { id: 'tag', label: st.tag ? '#' + st.tag : 'Tag' }, { id: 'trending', label: 'Trending' }].concat(st.listFeed ? [{ id: 'list', label: 'List: ' + st.listFeed.name }] : []);
    const seg = UI.seg(segItems, st.feedSeg, 'data-fseg aria-label="Feed"');
    const loading = st.feedKey !== feedKeyOf(st);
    const social = st.social;
    const posts = (st.posts || []).slice();
    if (st.feedSort === 'top') posts.sort((a, b) => score(b) - score(a));
    let title, sub;
    if (st.feedSeg === 'home') { title = 'Home'; sub = 'Your posts and those of the ' + social.following.length + ' people you follow, in every workspace and group you may read, minus muted people.'; }
    else if (st.feedSeg === 'ws') { title = ws ? ws.name : 'Workspace'; sub = 'The workspace feed: posts not targeted at a group. Internal by default, at most the workspace ceiling.'; }
    else if (st.feedSeg === 'groups') { title = 'Group feeds'; sub = 'Posts targeted at groups you read. A private group\'s posts never reach the workspace feed.' + (App.can('groups:read') ? ' <a href="#" data-gogroups>Groups and events</a>' : ''); }
    else if (st.feedSeg === 'bookmarks') { title = 'Bookmarks'; sub = 'Most recently saved first. Posts you can no longer see are left out.'; }
    else if (st.feedSeg === 'tag') { title = st.tag ? '#' + st.tag : 'Pick a tag'; sub = 'Posts with the hashtag, any case, in all your workspaces.'; }
    else if (st.feedSeg === 'list') { title = st.listFeed ? st.listFeed.name : 'List'; sub = 'The posts of the people on your list.'; }
    else { title = 'Trending'; sub = 'From the last feed.trending run, counting only posts at labels you are cleared for.'; }
    const held = posts.filter((p) => p.state === 'held');
    const writable = App.can('feed:write') && (st.feedSeg === 'ws' || st.feedSeg === 'home' || st.feedSeg === 'groups');
    const postGroups = (st.groups || []).filter((g) => g.role);
    const targets = (ws ? [{ value: 'ws', label: ws.name + ' (workspace)' }] : []).concat(postGroups.map((g) => ({ value: 'g:' + g.id, label: g.name + ' (group)' })));
    const target = st.postTarget && targets.some((t) => t.value === st.postTarget) ? st.postTarget : st.feedSeg === 'groups' && st.groupSel && postGroups.some((g) => g.id === st.groupSel) ? 'g:' + st.groupSel : targets.length ? targets[0].value : 'ws';
    const ceiling = ws ? ws.label : 'internal';
    const labelOpts = LABELS.filter((l) => LEVEL[l] <= LEVEL[ceiling]);
    const composer = writable && targets.length ? '<div class="messages-composer">' + UI.field('New post', UI.textarea(st.postDraft || '', { placeholder: 'Hashtags are extracted when published. Up to FEED_POST_MAX_CHARS.', attrs: 'data-pdraft', rows: 2 }))
      + '<div class="hstack wrap">' + UI.select(targets, target, 'data-ptarget aria-label="Post to"') + (target === 'ws' ? UI.select(labelOpts, st.postLabel && labelOpts.indexOf(st.postLabel) >= 0 ? st.postLabel : labelOpts.indexOf('internal') >= 0 ? 'internal' : labelOpts[labelOpts.length - 1], 'data-plabel aria-label="Label"') : '') + (App.can('files:read') ? UI.btn('Media from Files', { size: 'sm', icon: 'attach', attrs: 'data-pmedia' }) : '') + (st.pendingMedia || []).map((m) => '<span class="messages-att">' + esc(m.name) + UI.iconbtn('x', 'Remove ' + m.name, { attrs: 'data-unmedia="' + esc(m.id) + '"', cls: 'sm ghost' }) + '</span>').join('') + '<span class="grow"></span>' + UI.btn('Post', { kind: 'primary', size: 'sm', icon: 'send', attrs: 'data-post' }) + '</div></div>' : '';
    const groupPick = st.feedSeg === 'groups' && (st.groups || []).length ? UI.field('Group', UI.select(st.groups.map((g) => ({ value: g.id, label: g.name + (g.role ? '' : ' (reader)') })), st.groupSel, 'data-groupsel')) : '';
    const toolbar = '<div class="toolbar">' + (st.feedSeg !== 'trending' ? '<span class="relative">' + UI.btn(st.feedSort === 'top' ? 'Sort: most engaged' : 'Sort: newest', { size: 'sm', icon: 'sort', attrs: 'data-fsort' }) + '</span>' : '') + '<span class="muted right" style="font-size:12px">' + (st.feedSeg === 'trending' ? '' : posts.length + ' posts' + (held.length ? ', ' + held.length + ' held' : '')) + '</span></div>';
    const heldNote = st.showHeldNote ? (held.length ? UI.notice('<b>' + held.length + ' of your posts ' + (held.length === 1 ? 'is' : 'are') + ' held for review (202).</b> A require-approval guardrail held ' + (held.length === 1 ? 'it' : 'them') + ' at user-input; only you see ' + (held.length === 1 ? 'it' : 'them') + ' until a reviewer decides the hold flag in the Flags queue.', 'warn', UI.btn('Hide', { kind: 'ghost', size: 'sm', attrs: 'data-hideheld' })) : UI.notice('<b>None of your posts here is held.</b> When a require-approval guardrail holds a post at user-input, it is saved with 202, seen only by you, and a hold flag waits in the Flags queue; approving publishes it, rejecting withdraws it. It takes no comments or reactions while it waits (409).', 'info', UI.btn('Hide', { kind: 'ghost', size: 'sm', attrs: 'data-hideheld' }))) : '';
    let main;
    if (loading) main = UI.notice('Loading…', 'info');
    else if (st.feedError) main = UI.problem('The feed could not be loaded', st.feedError.message, traceOf(st.feedError));
    else if (st.feedSeg === 'trending') {
      const tags = (st.trending && st.trending.tags) || [];
      main = UI.panel('Trending in ' + (ws ? ws.name : 'your workspaces'), UI.table(['Tag', { label: 'Posts', right: true }, { label: 'People', right: true }], tags.map((t) => ({ cells: ['<a href="#" class="messages-tag" data-gotag="' + esc(t.tag) + '">#' + esc(t.tag) + '</a>', '<span class="num">' + t.posts + '</span>', '<span class="num">' + t.people + '</span>'] })), { minWidth: '0', clickable: false, emptyTitle: 'Nothing trending', emptyText: 'Hashtags of workspace posts from the last FEED_TRENDING_HOURS appear here after the next feed.trending run.' }) + (st.trending && st.trending.computedAt ? '<div class="muted" style="font-size:12px">Computed ' + esc(when(st.trending.computedAt)) + ' over the posts since ' + esc(when(st.trending.windowStart)) + '. Group posts are left out.</div>' : ''));
    } else if (st.feedSeg === 'groups' && !(st.groups || []).length) main = UI.empty('No group feeds', 'Join a group in Groups and events to read its feed here.');
    else main = posts.length ? posts.map((p) => renderPost(p, st)).join('') + (st.next ? '<div style="text-align:center">' + UI.btn('Load more', { kind: 'ghost', size: 'sm', attrs: 'data-loadmore' }) + '</div>' : '<p class="muted" style="font-size:12px;text-align:center">You have reached the end of this feed.</p>')
      : UI.empty(st.feedSeg === 'tag' && !st.tag ? 'Pick a tag' : 'Nothing here', st.feedSeg === 'tag' ? 'Open a hashtag from a post or Trending.' : st.feedSeg === 'bookmarks' ? 'Bookmark a post to find it here.' : st.feedSeg === 'home' ? 'Follow people to fill your home feed.' : 'No posts yet.');
    const digests = st.digests || [];
    const fs = st.feedSettings;
    const profiles = (st.profiles || []).map((p) => ({ value: p.name, label: p.displayName || p.name }));
    const profileOpts = [{ value: '', label: 'none (falls back to FEED_DIGEST_PROFILE)' }].concat(fs && fs.digestProfile && !profiles.some((p) => p.value === fs.digestProfile) ? profiles.concat([{ value: fs.digestProfile, label: fs.digestProfile }]) : profiles);
    const dpanel = UI.panel('Weekly digests' + (ws ? ', ' + ws.name : ''), '<div class="vstack gap6">' + (digests.length ? digests.map((dg) => '<div class="hstack" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="grow"><b>' + esc(day(dg.weekStart)) + ' to ' + esc(day(dg.weekEnd)) + '</b> <span class="muted" style="font-size:12px">' + (Array.isArray(dg.posts) ? dg.posts.length : dg.posts || 0) + ' posts</span></span>' + UI.pill(dg.state, dg.state === 'ready' ? 'ok' : dg.state === 'failed' ? 'danger' : '') + UI.btn('Open', { kind: 'ghost', size: 'xs', attrs: 'data-digestopen="' + esc(dg.id) + '"' }) + '</div>').join('') : '<p class="muted" style="font-size:12px;margin:0">No digests yet. A workspace with a digest profile gets one each week.</p>') + '</div>'
      + (fs ? '<div class="divider"></div>' + UI.toggle('Digest enabled', fs.digestEnabled, 'data-dtoggle data-manual') + UI.field('Digest profile', UI.select(profileOpts, fs.digestProfile || '', 'data-dprofile'), 'feed:manage. Ranked by reactions + 2 × comments + 3 × reposts; the summary passes model-output.' + (fs.effectiveProfile ? ' In effect: ' + esc(fs.effectiveProfile) + '.' : '')) + UI.btn('Run digest now', { size: 'sm', attrs: 'data-drun' }) : ''));
    const relations = UI.panel('Who you see', UI.kv([['Following', String(social.following.length)], ['Followers', String(social.followers.length)], ['Blocked', String(social.blocks.length)], ['Muted', String(social.mutes.length)]], 2) + '<div class="muted" style="font-size:12px">A block hides the other person\'s posts, comments and reposts in every feed; a mute removes them from Home only.' + (App.can('social:read') ? ' <a href="#" data-gopeople>Manage</a>' : '') + '</div>');
    return '<div class="page">%NAV%' + UI.pagehead(title, sub, UI.label('internal') + (App.can('moderation:report') ? UI.btn('Report a post', { kind: 'ghost', size: 'sm', attrs: 'data-reporthint' }) : '')) + seg + heldNote + groupPick + composer + toolbar + '<div class="vstack gap12">' + main + '</div></div><aside class="inspector w360" aria-label="Feed details">' + dpanel + relations + '</aside>';
  }
  function renderPost(p, st) {
    const orig = p.original;
    const reactions = p.counts.reactions || {};
    const total = Object.keys(reactions).reduce((n, k) => n + reactions[k], 0);
    const body = (t) => esc(t).replace(/#([\w-]+)/g, '<a href="#" class="messages-tag" data-gotag="$1">#$1</a>');
    const focus = st.focusPost === p.id ? ' style="outline:2px solid var(--accent)"' : '';
    const mine = p.author && p.author.id === meId();
    const w = App.can('feed:write');
    const comments = st.comments && st.comments[p.id];
    const bl = blockedIds(st);
    return '<article class="messages-post' + (p.state === 'held' ? ' held' : '') + '" data-post="' + esc(p.id) + '"' + focus + ' aria-label="Post by ' + esc(authorName(p.author)) + '">'
      + '<div class="messages-meta"><b style="color:var(--fg)">' + who(p.author && p.author.id, authorName(p.author)) + '</b><span>' + esc(when(p.publishedAt || p.createdAt)) + '</span>' + (p.groupId ? UI.pill(groupName(st, p.groupId), 'outline') : '') + UI.label(p.label, { sm: true }) + (p.state === 'held' ? UI.pill('held for review', 'warn') : p.state === 'rejected' ? UI.pill('rejected', 'danger') : '') + (p.editedAt ? '<span>edited</span>' : '') + '</div>'
      + (p.state === 'held' ? UI.notice('<b>Held for review (202).</b> A require-approval rule held this post at user-input. Only you can see it until a reviewer decides its hold flag in the Flags queue; approved publishes it, rejected withdraws it. It takes no comments or reactions while it waits (409).', 'warn') : '')
      + (p.body ? '<div class="messages-body">' + body(p.body) + '</div>' : '')
      + (orig ? '<div class="messages-quote"><b>' + who(orig.author && orig.author.id, authorName(orig.author)) + '</b>, ' + esc(when(orig.publishedAt || orig.createdAt)) + ' ' + UI.label(orig.label, { sm: true }) + '<br>' + body(orig.body || '') + '</div>' : p.repostOf ? '<div class="messages-tomb">The original is blocked, gone or out of reach.</div>' : '')
      + ((p.media || []).length ? '<div class="hstack wrap gap6">' + p.media.map((m) => (m.available ? '<a class="messages-att" href="/api/files/' + esc(m.fileId) + '/content" download>' + UI.icon('images', 12) + esc(m.name) + '</a>' : '<span class="messages-att">' + UI.icon('images', 12) + esc(m.name || 'File') + UI.pill('unavailable', 'warn') + '</span>')).join('') + '</div>' : '')
      + (p.state === 'published' ? '<div class="pactions">' + REACTIONS.map((k) => UI.chip(esc(k) + (reactions[k] ? ' ' + reactions[k] : ''), (p.mine.reactions || []).indexOf(k) >= 0, 'data-preact="' + esc(p.id) + '" data-kind="' + k + '"' + (w ? '' : ' disabled'))).join('') + '<span class="muted" style="font-size:12px">' + total + ' reactions, ' + p.counts.comments + ' comments, ' + p.counts.reposts + ' reposts</span></div>'
        + '<div class="pactions">' + (w ? UI.btn('Comment', { kind: 'ghost', size: 'xs', attrs: 'data-pcomment="' + esc(p.id) + '"' }) + '<span class="relative">' + UI.btn(p.mine.reposted ? 'Reposted' : 'Repost', { kind: 'ghost', size: 'xs', attrs: 'data-prepost="' + esc(p.id) + '"', cls: p.mine.reposted ? 'active' : '' }) + '</span>' + UI.btn(p.mine.bookmarked ? 'Bookmarked' : 'Bookmark', { kind: 'ghost', size: 'xs', attrs: 'data-pbookmark="' + esc(p.id) + '" aria-pressed="' + (p.mine.bookmarked ? 'true' : 'false') + '"', cls: p.mine.bookmarked ? 'active' : '' }) : '')
        + (p.counts.comments ? UI.btn(comments ? 'Hide comments' : 'Show ' + p.counts.comments + (p.counts.comments === 1 ? ' comment' : ' comments'), { kind: 'ghost', size: 'xs', attrs: 'data-pcomments="' + esc(p.id) + '"' }) : '')
        + (mine && w ? UI.btn('Edit', { kind: 'ghost', size: 'xs', attrs: 'data-pedit="' + esc(p.id) + '"' }) : !mine && App.can('moderation:report') ? UI.btn('Report', { kind: 'ghost', size: 'xs', attrs: 'data-preport="' + esc(p.id) + '"' }) : '')
        + ((mine && w) || App.can('feed:manage') ? UI.btn('Delete', { kind: 'ghost', size: 'xs', attrs: 'data-pdel="' + esc(p.id) + '"', title: mine ? 'Your post' : 'feed:manage' }) : '') + '</div>'
        : mine ? '<div class="pactions">' + UI.btn('Delete', { kind: 'ghost', size: 'xs', attrs: 'data-pdel="' + esc(p.id) + '"' }) + '</div>' : '')
      + (comments ? '<div class="vstack gap4">' + comments.filter((cm) => !(cm.author && bl.has(cm.author.id))).map((cm) => '<div class="messages-comment' + (cm.parentId ? ' reply' : '') + '"><b>' + who(cm.author && cm.author.id, authorName(cm.author)) + '</b> <span class="muted" style="font-size:12px">' + esc(when(cm.createdAt)) + '</span> ' + (w && p.state === 'published' ? UI.btn('Reply', { kind: 'ghost', size: 'xs', attrs: 'data-pcomment="' + esc(p.id) + '" data-parent="' + esc(cm.id) + '"' }) : '') + '<br>' + (cm.body == null ? '<span class="muted">Comment removed.</span>' : esc(cm.body)) + '</div>').join('') + '</div>' : '')
      + '</article>';
  }

  // ---------------- People (social relations) ----------------
  function renderPeople(st) {
    const s = st.social;
    const w = App.can('social:write');
    const tabs = UI.tabs([{ id: 'blocks', label: 'Blocks', count: s.blocks.length }, { id: 'mutes', label: 'Mutes', count: s.mutes.length }, { id: 'following', label: 'Following', count: s.following.length }, { id: 'followers', label: 'Followers', count: s.followers.length }, { id: 'lists', label: 'Lists', count: s.lists.length }, { id: 'directory', label: 'Directory', count: st.people ? st.people.length : undefined }], st.peopleTab, 'data-ptabs aria-label="Relations"');
    const name = (x) => esc(x.displayName || x.username || 'Someone');
    const following = new Set(s.following.map((f) => f.userId));
    let body;
    if (st.peopleTab === 'blocks') body = UI.notice('A block works both ways: neither of you can start a conversation with or message the other; each other\'s messages, posts, typing, presence and receipts are left out; follows end both ways. The blocked person is never told and reads "does not accept messages from you".', 'info') + UI.table(['Person', 'Blocked', { label: '', right: true }], s.blocks.map((b) => [name(b) + ' <span class="muted mono">' + esc(b.username || '') + '</span>', esc(when(b.createdAt)), w ? UI.btn('Unblock', { size: 'sm', attrs: 'data-unblock="' + esc(b.userId) + '" aria-label="Unblock ' + name(b) + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'Nobody blocked' }) + (w ? '<div>' + UI.btn('Block someone', { size: 'sm', attrs: 'data-block' }) + '</div>' : '');
    else if (st.peopleTab === 'mutes') body = UI.notice('A mute is one-way and private: the muted person\'s posts leave your home feed and their messages notify you of nothing.', 'info') + UI.table(['Person', 'Until', 'Muted', { label: '', right: true }], s.mutes.map((m) => [name(m), esc(m.expiresAt ? when(m.expiresAt) : 'you unmute'), esc(when(m.createdAt)), w ? UI.btn('Unmute', { size: 'sm', attrs: 'data-unmute="' + esc(m.userId) + '" aria-label="Unmute ' + name(m) + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'Nobody muted' }) + (w ? '<div>' + UI.btn('Mute someone', { size: 'sm', attrs: 'data-mutesomeone' }) + '</div>' : '');
    else if (st.peopleTab === 'following') body = UI.table(['Person', 'Username', 'Since', { label: '', right: true }], s.following.map((f) => [name(f), '<span class="mono">' + esc(f.username || '') + '</span>', esc(when(f.since)), w ? UI.btn('Unfollow', { size: 'sm', attrs: 'data-unfollow="' + esc(f.userId) + '" aria-label="Unfollow ' + name(f) + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'You follow nobody yet' }) + (w ? '<div>' + UI.btn('Follow someone', { size: 'sm', attrs: 'data-follow' }) + '</div>' : '') + '<div class="muted" style="font-size:12px">Follows must share a workspace with you (else 404, as if unknown). Someone in a block with you cannot be followed.</div>';
    else if (st.peopleTab === 'followers') body = UI.table(['Person', 'Username', 'Follows you since', { label: '', right: true }], s.followers.map((f) => [name(f), '<span class="mono">' + esc(f.username || '') + '</span>', esc(when(f.since)), following.has(f.userId) ? UI.pill('mutual', 'ok') : w ? UI.btn('Follow back', { size: 'sm', attrs: 'data-followid="' + esc(f.userId) + '" aria-label="Follow ' + name(f) + ' back"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'No followers yet' });
    else if (st.peopleTab === 'directory') body = UI.notice('Everyone who shares a workspace with you. A name opens the profile; the status is live over the socket and left out for people in a block with you.', 'info')
      + (!st.people ? UI.notice('Loading…', 'info') : UI.table(['Person', 'Workspaces', 'Status'], st.people.filter((p) => !blockedIds(st).has(p.userId)).map((p) => [who(p.userId, p.displayName || p.username) + ' <span class="muted mono">' + esc(p.username) + '</span>', esc(p.workspaces.map((w) => w.name).join(', ')), statusPill(st, p.userId) || '<span class="muted">not shown</span>']), { clickable: false, minWidth: '0', emptyTitle: 'Nobody else yet', emptyText: 'People who share a workspace with you appear here.' }));
    else {
      const d = st.listDetail;
      body = '<div class="cols"><div style="flex:1;min-width:0">' + UI.table(['List', 'People', 'Description'], s.lists.map((l) => ({ cells: [esc(l.name), String(l.members), esc(l.description || '')], attrs: 'data-list="' + esc(l.id) + '"', selected: d && d.id === l.id })), { minWidth: '0', emptyTitle: 'No lists', emptyText: 'Lists group people; open one as a feed.' }) + (w ? '<div>' + UI.btn('New list', { size: 'sm', icon: 'plus', attrs: 'data-newlist' }) + '</div>' : '') + '</div>'
        + (d ? '<div style="flex:1;min-width:0">' + UI.panel(d.name, '<div class="vstack gap4">' + (d.people || []).map((p) => '<div class="hstack"><span class="grow">' + name(p) + '</span>' + (w ? UI.iconbtn('x', 'Remove ' + (p.displayName || p.username) + ' from the list', { attrs: 'data-listrm="' + esc(p.userId) + '"', cls: 'sm ghost' }) : '') + '</div>').join('') + ((d.people || []).length ? '' : '<p class="muted" style="font-size:12px;margin:0">Nobody on this list yet.</p>') + '</div><div class="hstack gap6 wrap" style="margin-top:8px">' + (w ? UI.btn('Add person', { size: 'sm', attrs: 'data-listadd' }) + UI.btn('Rename', { size: 'sm', kind: 'ghost', attrs: 'data-listrename' }) + UI.btn('Delete list', { size: 'sm', kind: 'danger', attrs: 'data-listdel' }) : '') + (App.can('feed:read') ? UI.btn('Open as feed', { size: 'sm', kind: 'ghost', attrs: 'data-listfeed' }) : '') + '</div><div class="muted" style="font-size:12px;margin-top:6px">Up to 1,000 people, 100 lists. Someone outside your workspaces is 404; a blocked person 409.</div>') + '</div>' : '') + '</div>';
    }
    const rule = UI.panel('Contact rule', '<div class="vstack gap6">' + UI.seg([{ id: 'workspace', label: 'Anyone sharing a workspace' }, { id: 'following', label: 'Only people I follow' }, { id: 'nobody', label: 'Nobody' }], s.contactRule, 'data-rule aria-label="Who may start a conversation with you"') + '<span class="muted" style="font-size:12px">Who may start a conversation with you or add you to one. Refusals read "does not accept messages from you", the same words as a block. Also under <a href="#" data-gosettings>Settings</a>.</span></div>');
    return '<div class="page">%NAV%' + UI.pagehead('People', 'Your blocks, mutes, follows, followers and lists. Messaging and the feed both enforce them; limits per user: 5,000 blocks, mutes and follows, 100 lists.') + rule + tabs + '<div class="vstack gap12">' + body + '</div></div>';
  }

  // ---------------- events ----------------
  function wire(ctx, st) {
    ctx.on('click', '[data-view] [data-seg]', (e, t) => { st.view = t.dataset.seg; ctx.rerender(); });
    ctx.on('click', '[data-demook]', () => { st.demoNote = null; ctx.rerender(); });
    ctx.on('click', '[data-gopeople]', (e) => { e.preventDefault(); st.view = 'people'; st.peopleTab = 'blocks'; ctx.rerender(); });
    ctx.on('click', '[data-gosettings]', (e) => { e.preventDefault(); ctx.navigate('settings'); });
    ctx.on('click', '[data-gogroups]', (e) => { e.preventDefault(); ctx.navigate('groups'); });
    if (st.view === 'messages') wireMessages(ctx, st);
    else if (st.view === 'feed') wireFeed(ctx, st);
    else wirePeople(ctx, st);
  }

  function wireMessages(ctx, st) {
    const c = (st.convos || []).find((x) => x.id === st.convo);
    const msgs = st.msgs || [];
    const findMsg = (id) => msgs.find((m) => m.id === id) || (st.pins || []).find((m) => m.id === id) || null;
    const base = c ? '/api/messaging/conversations/' + enc(c.id) : '';
    const reload = () => Promise.all([loadList(st), loadConvo(st, true)]).then(paint);
    ctx.on('click', '[data-cfilter] [data-seg]', (e, t) => { st.filter = t.dataset.seg; ctx.rerender(); });
    ctx.on('input', '[data-cq]', (e, t) => { st.q = t.value; ctx.rerender(); });
    ctx.on('click', '[data-convo]', (e, t) => { if (st.convo === t.dataset.convo) return; st.convo = t.dataset.convo; st.msgFor = null; st.replyTo = null; st.lastSummary = null; st.pins = null; st.sendProblem = null; st.attachProblem = null; st.pendingAttach = []; ctx.rerender(); });
    ctx.on('click', '[data-insptabs] [data-tab]', (e, t) => { st.inspTab = t.dataset.tab; if (st.inspTab === 'pins') loadPins(st).then(paint); else ctx.rerender(); });
    ctx.on('click', '[data-hideblock]', () => { st.showBlockNote = false; ctx.rerender(); });
    ctx.on('click', '[data-clearattach]', () => { st.attachProblem = null; ctx.rerender(); });
    ctx.on('click', '[data-clearsend]', () => { st.sendProblem = null; ctx.rerender(); });
    ctx.on('click', '[data-closesummary]', () => { st.lastSummary = null; ctx.rerender(); });
    ctx.on('click', '[data-newconvo]', () => openNew(ctx, st));
    if (!c) return;
    ctx.on('click', '[data-earlier]', () => {
      const first = msgs[0]; if (!first) return;
      App.get(base + '/messages?limit=50&before=' + first.createdAt).then((older) => { st.msgs = older.slice().reverse().concat(st.msgs || []); st.hasMore = older.length >= 50; paint(); }).catch((err) => App.fail(err));
    });
    ctx.on('click', '[data-markread]', () => {
      const last = msgs.filter((m) => m.state === 'sent').slice(-1)[0]; if (!last) return;
      App.post(base + '/read', { messageId: last.id }).then(() => { ctx.toast('Read mark moved to the latest message. Reading also counts as delivered.', 'ok'); return loadList(st); }).then(paint).catch((err) => App.fail(err, 'Read mark not moved'));
    });
    ctx.on('input', '[data-draft]', (e, t) => {
      st.draft = t.value;
      if (live.sock && Date.now() - live.typingAt > 3000) { live.typingAt = Date.now(); live.sock.emit('room.signal', { kind: 'conversation', id: c.id, signal: 'typing', data: { typing: true } }, () => undefined); }
    });
    ctx.on('keydown', '[data-draft]', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const b = ctx.$('[data-send]'); if (b) b.click(); } });
    ctx.on('click', '[data-cancelreply]', () => { st.replyTo = null; ctx.rerender(); });
    ctx.on('click', '[data-reply]', (e, t) => { st.replyTo = t.dataset.reply; ctx.rerender(); const ta = ctx.$('[data-draft]'); if (ta) ta.focus(); });
    ctx.on('click', '[data-unattach]', (e, t) => { st.pendingAttach = (st.pendingAttach || []).filter((a) => a.id !== t.dataset.unattach); ctx.rerender(); });
    ctx.on('click', '[data-attach]', () => openFilePicker(ctx, st, 'message'));
    ctx.on('click', '[data-send]', (e, t) => {
      const text = (st.draft || '').trim();
      if (!text) { ctx.toast('Write a message first.' + ((st.pendingAttach || []).length ? ' Attachments go with a message.' : '')); return; }
      t.disabled = true;
      const body = { body: text };
      if (st.replyTo) body.replyTo = st.replyTo;
      if ((st.pendingAttach || []).length) body.attachments = st.pendingAttach.map((a) => a.id);
      App.post(base + '/messages', body).then(() => {
        st.draft = ''; st.replyTo = null; st.pendingAttach = []; st.sendProblem = null;
        if (live.sock) live.sock.emit('room.signal', { kind: 'conversation', id: c.id, signal: 'typing', data: { typing: false } }, () => undefined);
        ctx.toast('Sent. Screened at user-input and sealed with the tenant key.', 'ok');
        return reload();
      }).catch((err) => {
        const p = err.problem || {};
        if (err.status === 409 && (st.pendingAttach || []).length) st.attachProblem = p.detail || err.message;
        else if (err.status === 422 || err.status === 403) st.sendProblem = { title: (p.title || 'Message refused') + ' (' + err.status + (p.step ? ', step ' + p.step : '') + ')', detail: p.detail || err.message, trace: traceOf(err) };
        else App.fail(err, 'Not sent');
        paint();
      });
    });
    ctx.on('click', '[data-react]', (e, t) => {
      const m = findMsg(t.dataset.react); if (!m) return; const k = t.dataset.kind;
      const has = (m.reactions || []).some((r) => r.emoji === k && r.mine);
      (has ? App.del('/api/messaging/messages/' + enc(m.id) + '/reactions/' + enc(k)) : App.post('/api/messaging/messages/' + enc(m.id) + '/reactions', { emoji: k })).then(reload).catch((err) => App.fail(err, 'Reaction not saved'));
    });
    ctx.on('click', '[data-pin]', (e, t) => {
      const m = findMsg(t.dataset.pin); if (!m) return; const off = m.pinned || !!t.dataset.pinned;
      (off ? App.del('/api/messaging/messages/' + enc(m.id) + '/pin') : App.post('/api/messaging/messages/' + enc(m.id) + '/pin', {})).then(() => { ctx.toast(off ? 'Unpinned.' : 'Pinned for everyone in the conversation.', 'ok'); return loadPins(st); }).then(reload).catch((err) => App.fail(err, 'Pin not changed'));
    });
    ctx.on('click', '[data-edit]', (e, t) => {
      const m = findMsg(t.dataset.edit); if (!m) return;
      ctx.modal({ title: 'Edit message', body: UI.field('Message', UI.textarea(m.body || '', { attrs: 'data-ebody', rows: 3 }), 'Screened again at user-input. Audited with the edit number and length, never the text.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-esave' }),
        onMount(mm) { mm.querySelector('[data-esave]').addEventListener('click', () => { const v = mm.querySelector('[data-ebody]').value.trim(); if (!v) { ctx.toast('A message needs text.', 'warn'); return; } App.patch('/api/messaging/messages/' + enc(m.id), { body: v }).then(() => { App.closeOverlay(); ctx.toast('Message edited.', 'ok'); return reload(); }).catch((err) => App.fail(err, 'Not edited')); }); } });
    });
    ctx.on('click', '[data-del]', async (e, t) => {
      const m = findMsg(t.dataset.del); if (!m) return;
      const ok = await ctx.confirm({ title: 'Delete message', tag: 'tombstone', tone: 'danger', body: '<p class="fg2" style="margin:0">The body, attachments, keyword terms, vector and reactions are deleted. The row stays as a tombstone and the audit entry records the author and edit count, never the text.</p>', kv: [['Author', esc(m.authorName || '')], ['Sent', esc(when(m.createdAt))]], ok: 'Delete' });
      if (!ok) return;
      App.del('/api/messaging/messages/' + enc(m.id)).then(() => { ctx.toast('Message deleted. messaging.message.deleted written.', 'warn'); return reload(); }).catch((err) => App.fail(err, 'Not deleted'));
    });
    ctx.on('click', '[data-forward]', (e, t) => {
      const m = findMsg(t.dataset.forward); if (!m) return;
      const targets = st.convos.filter((x) => x.id !== c.id);
      if (!targets.length) { ctx.toast('You have no other conversation to forward to.'); return; }
      ctx.modal({ title: 'Forward message', body: '<div class="messages-quote">' + esc(m.authorName || '') + ': ' + esc(m.body) + '</div>' + UI.field('To conversation', UI.select(targets.map((x) => ({ value: x.id, label: convoTitle(x) + ' (' + x.label + ')' })), targets[0].id, 'data-fto'), 'A message above the target\'s label is refused (422). Attachments are checked again against the target workspace.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Forward', { kind: 'primary', attrs: 'data-fgo' }),
        onMount(mm) { mm.querySelector('[data-fgo]').addEventListener('click', () => { const to = targets.find((x) => x.id === mm.querySelector('[data-fto]').value); App.post('/api/messaging/messages/' + enc(m.id) + '/forward', { conversationId: to.id }).then(() => { App.closeOverlay(); ctx.toast('Forwarded to ' + esc(convoTitle(to)) + '.', 'ok'); return loadList(st); }).then(paint).catch((err) => App.fail(err, 'Not forwarded')); }); } });
    });
    ctx.on('click', '[data-report]', (e, t) => {
      const m = findMsg(t.dataset.report); if (!m) return;
      ctx.modal({ title: 'Report message', body: UI.field('Reason', UI.select(['Harassment', 'Spam', 'Confidential data shared', 'Other'], 'Harassment', 'data-rr')) + UI.field('Note', UI.textarea('', { rows: 2, placeholder: 'What should the reviewer look at?', attrs: 'data-rn' })) + UI.notice('Files a report flag (type dm-message) in the workspace queue, checkpoint user-report. A hidden message shows to the conversation as a tombstone and leaves search.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Report', { kind: 'primary', attrs: 'data-rgo' }),
        onMount(mm) { mm.querySelector('[data-rgo]').addEventListener('click', () => { const note = mm.querySelector('[data-rn]').value.trim(); App.post('/api/moderation/reports', Object.assign({ type: 'dm-message', id: m.id, reason: mm.querySelector('[data-rr]').value }, note ? { note } : {})).then((r) => { App.closeOverlay(); ctx.toast(r.duplicate ? 'You already reported this message; your report is still open.' : 'Reported as ' + esc(r.flag.ref) + ' (dm-message).' + (App.can('moderation:review') ? ' <a href="#/moderation?flag=' + esc(r.flag.ref) + '" style="color:inherit">Open in Moderation</a>' : ''), 'ok', 5000); }).catch((err) => App.fail(err, 'Not reported')); }); } });
    });
    ctx.on('click', '[data-thread]', (e, t) => openThread(ctx, st, c, findMsg(t.dataset.thread)));
    ctx.on('click', '[data-member]', (e, t) => {
      const id = t.dataset.member; const person = ((st.detail && st.detail.people) || []).find((p) => p.userId === id) || {}; const nm = person.displayName || person.username || 'this person';
      openMenu(t, [['admin', 'Make admin'], ['member', 'Make member'], ['owner', 'Make owner'], ['remove', 'Remove from conversation']], person.role, async (v) => {
        if (v === 'remove') {
          const ok = await ctx.confirm({ title: 'Remove ' + nm, tone: 'danger', body: '<p class="fg2" style="margin:0">Their sockets leave the room at once and the conversation disappears for them.</p>', ok: 'Remove' });
          if (!ok) return;
          App.del(base + '/members/' + enc(id)).then(() => { ctx.toast(esc(nm) + ' removed.', 'ok'); return reload(); }).catch((err) => App.fail(err, 'Not removed'));
          return;
        }
        App.patch(base + '/members/' + enc(id), { role: v }).then(() => { ctx.toast(esc(nm) + ' is now ' + esc(v) + '.', 'ok'); return reload(); }).catch((err) => App.fail(err, 'Role not changed'));
      });
    });
    ctx.on('click', '[data-addmember]', () => {
      people(st).then((all) => {
        const inIt = new Set(((st.detail && st.detail.people) || []).map((p) => p.userId));
        const cands = all.filter((p) => !inIt.has(p.userId) && (!c.workspaceId || p.workspaces.some((w) => w.id === c.workspaceId)));
        if (!cands.length) { ctx.toast('Everyone in ' + esc(wsName(c.workspaceId)) + ' is already in this conversation.'); return; }
        ctx.modal({ title: 'Add member', body: UI.field('Person', UI.select(cands.map((p) => ({ value: p.userId, label: (p.displayName || p.username) + ' (' + p.workspaces.map((w) => w.name).join(', ') + ')' })), cands[0].userId, 'data-am')) + (c.role === 'owner' ? UI.field('Role', UI.select(['member', 'admin'], 'member', 'data-amrole')) : '') + UI.notice('Must be a member of ' + esc(wsName(c.workspaceId)) + ' now (422, step workspace), cleared for ' + esc(c.label) + ' (422, step clearance) and accept you under their contact rule (403, step contact). They read messages from now on.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add', { kind: 'primary', attrs: 'data-amgo' }),
          onMount(mm) { mm.querySelector('[data-amgo]').addEventListener('click', () => { const r = mm.querySelector('[data-amrole]'); App.post(base + '/members', { userId: mm.querySelector('[data-am]').value, role: r ? r.value : 'member' }).then(() => { App.closeOverlay(); ctx.toast('Added. They read from now on.', 'ok'); return reload(); }).catch((err) => App.fail(err, 'Not added')); }); } });
      }).catch((err) => App.fail(err));
    });
    ctx.on('change', '[data-notify]', (e, t) => { put(base + '/settings', { notify: t.value }).then(() => { ctx.toast('Notification rule saved: ' + esc(t.value) + '.', 'ok'); return loadList(st); }).then(paint).catch((err) => App.fail(err, 'Not saved')); });
    ctx.on('click', '[data-mute]', () => { put(base + '/settings', { muted: !c.muted }).then(() => { ctx.toast(c.muted ? 'Unmuted.' : 'Muted until you unmute.', 'ok'); return loadList(st); }).then(paint).catch((err) => App.fail(err, 'Not saved')); });
    ctx.on('click', '[data-mutefor]', (e, t) => { const mins = t.dataset.mutefor === 'tomorrow' ? minutesUntilTomorrow() : Number(t.dataset.mutefor); put(base + '/settings', { mutedMinutes: mins }).then((r) => { ctx.toast('Muted until ' + esc(when(r.mutedUntil)) + '.', 'ok'); return loadList(st); }).then(paint).catch((err) => App.fail(err, 'Not saved')); });
    ctx.on('click', '[data-rename]', () => ctx.modal({ title: 'Rename conversation', body: UI.field('Title', UI.input(c.title || '', { attrs: 'data-rt' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-rgo' }),
      onMount(mm) { mm.querySelector('[data-rgo]').addEventListener('click', () => { const v = mm.querySelector('[data-rt]').value.trim(); App.patch(base, { title: v || null }).then(() => { App.closeOverlay(); ctx.toast('Renamed.', 'ok'); return reload(); }).catch((err) => App.fail(err, 'Not renamed')); }); } }));
    ctx.on('click', '[data-delconvo]', async () => {
      const ok = await ctx.confirm({ title: 'Delete conversation', tag: 'irreversible', tone: 'danger', body: '<p class="fg2" style="margin:0">The conversation is deleted and every message body, term and vector removed for all ' + c.members + ' people.</p>', kv: [['Conversation', esc(convoTitle(c))], ['Messages loaded', String(msgs.length)]], ok: 'Delete' });
      if (!ok) return;
      App.del(base).then(() => { st.convo = null; st.msgFor = null; ctx.toast('Conversation deleted.', 'warn'); return loadList(st); }).then(paint).catch((err) => App.fail(err, 'Not deleted'));
    });
    ctx.on('click', '[data-leave]', async () => {
      const ok = await ctx.confirm({ title: 'Leave conversation', tone: 'danger', body: '<p class="fg2" style="margin:0">You stop receiving messages at once. The last owner cannot leave (409).</p>', ok: 'Leave' });
      if (!ok) return;
      App.del(base + '/members/' + enc(meId())).then(() => { st.convo = null; st.msgFor = null; ctx.toast('You left ' + esc(convoTitle(c)) + '.', 'ok'); return loadList(st); }).then(paint).catch((err) => App.fail(err, 'Not left'));
    });
    ctx.on('click', '[data-summary]', () => {
      const threads = msgs.filter((m) => m.replyCount && m.state === 'sent');
      const open = (pr) => ctx.modal({ title: 'Summarise conversation', body: (pr.length ? UI.field('Profile', UI.select(pr.map((p) => ({ value: p.name, label: p.displayName || p.name })), pr[0].name, 'data-sp')) : '') + UI.field('Scope', UI.select([{ value: '', label: 'Latest messages (up to 200)' }].concat(threads.map((m) => ({ value: m.id, label: 'Thread: ' + (m.body || '').slice(0, 50) }))), '', 'data-ss')) + UI.notice('Needs inference:invoke. Only messages you can see are numbered and sent; citations that name anything else are removed. The answer passes model-output.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Summarise', { kind: 'primary', attrs: 'data-sgo' }),
        onMount(mm) { mm.querySelector('[data-sgo]').addEventListener('click', (ev) => { const b = ev.currentTarget; b.disabled = true; const sp = mm.querySelector('[data-sp]'); const th = mm.querySelector('[data-ss]').value; const body = {}; if (sp) body.profile = sp.value; if (th) body.threadId = th; App.post(base + '/summary', body).then((r) => { App.closeOverlay(); st.lastSummary = Object.assign({ conversationId: c.id }, r); paint(); }).catch((err) => { b.disabled = false; App.fail(err, 'No summary'); }); }); } });
      if (st.profiles || !App.can('chat:read')) open(st.profiles || []);
      else App.get('/api/chat/profiles').then((p) => { st.profiles = p; open(p); }).catch(() => open([]));
    });
    ctx.on('click', '[data-digest]', (e, t) => { t.disabled = true; App.post(base + '/digest', {}).then((r) => { st.lastSummary = Object.assign({ conversationId: c.id }, r, { kind: 'digest' }); paint(); }).catch((err) => { t.disabled = false; App.fail(err, 'No digest'); }); });
    ctx.on('click', '[data-cite]', (e, t) => { e.preventDefault(); const el = ctx.$('[data-msg="' + t.dataset.cite + '"]'); if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '2px solid var(--accent)'; setTimeout(() => { el.style.outline = ''; }, 1200); } else ctx.toast('That message is earlier than the loaded ones. Load earlier messages to see it.'); });
    ctx.on('click', '[data-msearch]', () => openSearch(ctx, st));
  }

  function openThread(ctx, st, c, m) {
    if (!m) return;
    const draw = (d, replies) => { d.querySelector('#messages-thread-list').innerHTML = replies.length ? replies.map((r) => '<div class="messages-comment"><b>' + esc(r.authorId === meId() ? myName() : r.authorName || '') + '</b> <span class="muted" style="font-size:12px">' + esc(when(r.createdAt)) + '</span><br>' + (r.state === 'sent' ? esc(r.body) : '<span class="muted">' + (r.state === 'deleted' ? 'Deleted.' : 'Hidden by moderation.') + '</span>') + '</div>').join('') : '<div class="muted" style="font-size:12px">No replies yet. Threads are one level deep.</div>'; };
    const load = (d) => App.get('/api/messaging/conversations/' + enc(c.id) + '/messages?thread=' + enc(m.id) + '&limit=200').then((rows) => { const bl = blockedIds(st); draw(d, rows.filter((r) => r.id !== m.id && !bl.has(r.authorId)).reverse()); }).catch((err) => App.fail(err, 'Thread not loaded'));
    const w = App.can('messages:write');
    ctx.drawer({ title: 'Thread', body: '<div class="messages-quote" style="margin-bottom:8px">' + esc(m.authorName || '') + ', ' + esc(when(m.createdAt)) + '<br>' + esc(m.body) + '</div><div class="vstack gap6" id="messages-thread-list" aria-live="polite"><div class="muted" style="font-size:12px">Loading replies…</div></div>' + (w ? UI.field('Reply in thread', UI.textarea('', { attrs: 'data-tbody', rows: 2 })) : ''), actions: UI.btn('Close', { attrs: 'data-close' }) + (w ? UI.btn('Reply', { kind: 'primary', attrs: 'data-tsend' }) : ''),
      onMount(d) {
        load(d);
        const b = d.querySelector('[data-tsend]');
        if (b) b.addEventListener('click', () => { const ta = d.querySelector('[data-tbody]'); const v = ta.value.trim(); if (!v) return; App.post('/api/messaging/conversations/' + enc(c.id) + '/messages', { body: v, threadId: m.id }).then(() => { ta.value = ''; ctx.toast('Reply posted in the thread.', 'ok'); loadConvo(st, true); return load(d); }).catch((err) => App.fail(err, 'Reply not posted')); });
      } });
  }

  function openSearch(ctx, st) {
    const c = (st.convos || []).find((x) => x.id === st.convo); if (!c) return;
    const mode = st.searchMode || 'keyword';
    ctx.drawer({ title: 'Search in ' + esc(convoTitle(c)), body: UI.search('Search messages you can see', 'data-sq', st.searchQ || '') + '<div style="margin:8px 0">' + UI.seg([{ id: 'keyword', label: 'Keyword' }, { id: 'semantic', label: 'Semantic' }, { id: 'hybrid', label: 'Hybrid' }], mode, 'data-smode aria-label="Search mode"') + '</div><div id="messages-sres" aria-live="polite"><div class="muted" style="font-size:12px">Over messages since you joined, not deleted or hidden, none from people in a block with you. Keyword ranks by keyed-hash terms; semantic by embeddings; hybrid fuses both by reciprocal rank.</div></div>', actions: UI.btn('Close', { attrs: 'data-close' }),
      onMount(d) {
        let timer = null, seq = 0;
        const draw = () => {
          const q = d.querySelector('[data-sq]').value.trim(); st.searchQ = q; const out = d.querySelector('#messages-sres'); const md = st.searchMode || 'keyword';
          if (!q) return;
          const mine = ++seq;
          App.get('/api/messaging/conversations/' + enc(c.id) + '/search?q=' + enc(q) + '&mode=' + md + '&limit=20').then((rs) => {
            if (mine !== seq) return;
            const bl = blockedIds(st);
            rs = rs.filter((r) => !bl.has(r.authorId));
            out.innerHTML = rs.length ? UI.table(['Message', 'Score'], rs.map((r) => ({ cells: ['<b>' + esc(r.authorName || '') + '</b> <span class="muted">' + esc(when(r.createdAt)) + '</span><br>' + esc(r.body), '<span class="mono">fused ' + r.score.fused + (r.score.keyword != null ? ', keyword ' + r.score.keyword : '') + (r.score.semantic != null ? ', semantic ' + r.score.semantic : '') + '</span>'], attrs: 'data-sgo="' + esc(r.id) + '"' })), { minWidth: '0' }) : UI.empty('No matches', 'Try another word or mode.');
            out.querySelectorAll('[data-sgo]').forEach((row) => row.addEventListener('click', () => { App.closeOverlay(); const el = ctx.$('[data-msg="' + row.dataset.sgo + '"]'); if (el) el.scrollIntoView({ block: 'center' }); else ctx.toast('That message is earlier than the loaded ones.'); }));
            App.a11yPass(out);
          }).catch((err) => {
            if (mine !== seq) return;
            out.innerHTML = err.status === 409 ? UI.problem('Semantic search unavailable (409)', (err.problem && err.problem.detail) || err.message, traceOf(err)) + '<div class="muted" style="font-size:12px;margin-top:6px">MESSAGING_EMBED_MODEL names no approved embedding model, so semantic and hybrid modes are refused; keyword search works.</div>' : UI.problem('Search failed', err.message, traceOf(err));
          });
        };
        d.querySelector('[data-sq]').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(draw, 300); });
        d.querySelector('[data-smode]').addEventListener('click', (e) => { const b = e.target.closest('[data-seg]'); if (!b) return; st.searchMode = b.dataset.seg; d.querySelectorAll('[data-smode] button').forEach((x) => { const on = x.dataset.seg === b.dataset.seg; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }); draw(); });
        if (st.searchQ) draw();
      } });
  }

  /** Files from the file store for a message (the conversation's workspace) or a post (the current workspace). */
  function openFilePicker(ctx, st, forWhat) {
    const c = (st.convos || []).find((x) => x.id === st.convo);
    const ws = curWs();
    const wsId = forWhat === 'message' ? (c && c.workspaceId) || (ws && ws.id) : ws && ws.id;
    if (!wsId) return;
    const label = forWhat === 'message' && c ? c.label : null;
    const rows = (files) => (files.length ? UI.table(['File', 'Label', 'Scan'], files.map((f) => ({ cells: [esc(f.name), UI.label(f.label, { sm: true }), f.state === 'ready' ? UI.pill('ready') : f.state === 'pending' ? UI.pill('quarantined', 'warn') : UI.pill(f.state, 'danger')], attrs: 'data-pick="' + esc(f.id) + '"' })), { minWidth: '0' }) : UI.empty('No files', 'Upload files to the file store first, then attach them here.'));
    ctx.modal({ title: forWhat === 'message' ? 'Attach from Files' : 'Media from Files', body: (st.attachExplain ? UI.notice('<b>Only files that passed their scan.</b> A file whose current version is still in quarantine is refused with 409 until the file.scan job marks it ready (type check, text classifier, ClamAV).', 'warn') : '') + UI.notice(forWhat === 'message' ? 'Only files you can read in ' + esc(wsName(wsId)) + ' whose current version passed its scan' + (label ? ', labelled at most ' + esc(label) : '') + '. Everyone reads it through the file store. At most 10.' : 'Up to 10 files from the post\'s workspace that passed quarantine. A file raises the post\'s label to its own.', 'info') + UI.search('Search files by name', 'data-fq') + '<div id="messages-files" aria-live="polite">' + UI.notice('Loading…', 'info') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }),
      onClose() { st.attachExplain = false; },
      onMount(m) {
        const out = m.querySelector('#messages-files'); const cache = {};
        const show = (files) => {
          files.forEach((f) => { cache[f.id] = f; });
          out.innerHTML = rows(files); App.a11yPass(out);
          out.querySelectorAll('[data-pick]').forEach((r) => r.addEventListener('click', () => {
            const f = cache[r.dataset.pick]; if (!f) return;
            App.closeOverlay();
            if (f.state !== 'ready') { const why = f.name + (f.state === 'pending' ? ' is still in quarantine: its current version is being scanned by the file.scan job (type check, text classifier, ClamAV). Attach it when its state is ready, or pick another file.' : ' was rejected by its scan and cannot be attached.'); if (forWhat === 'message') { st.attachProblem = why; paint(); } else ctx.toast('409: ' + esc(why), 'danger', 6000); return; }
            if (label && LEVEL[f.label] > LEVEL[label]) { ctx.toast(esc(f.name) + ' is ' + esc(f.label) + ', above this conversation\'s label (' + esc(label) + '); the server refuses it with 422. Pick another file.', 'danger', 6000); return; }
            const key = forWhat === 'message' ? 'pendingAttach' : 'pendingMedia';
            st[key] = (st[key] || []).filter((x) => x.id !== f.id).concat([{ id: f.id, name: f.name }]).slice(0, 10);
            paint();
          }));
        };
        const browse = () => App.get('/api/files/browse?workspace=' + enc(wsId)).then((r) => r.files || []);
        browse().then(show).catch((err) => { out.innerHTML = UI.problem('Files not loaded', err.message, traceOf(err)); });
        let timer = null;
        m.querySelector('[data-fq]').addEventListener('input', (e) => { clearTimeout(timer); const q = e.target.value.trim(); timer = setTimeout(() => { (q ? App.get('/api/files/search?q=' + enc(q) + '&workspace=' + enc(wsId)) : browse()).then(show).catch((err) => { out.innerHTML = UI.problem('Search failed', err.message, traceOf(err)); }); }, 300); });
      } });
  }

  function openNew(ctx, st) {
    if (!App.can('messages:write')) return;
    people(st).then((all) => {
      const kind = st.newKind || 'direct';
      const body = UI.seg([{ id: 'direct', label: 'Direct' }, { id: 'group', label: 'Group' }], kind, 'data-nk aria-label="Kind"') + '<div id="messages-newform">' + newForm(st, kind, all) + '</div>';
      ctx.modal({ title: 'New conversation', cls: 'wide', body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(kind === 'direct' ? 'Start' : 'Create', { kind: 'primary', attrs: 'data-ngo' }),
        onClose() { st.newProblem = null; st.newExplain = false; },
        onMount(m) {
          const wireForm = () => { const w = m.querySelector('[data-nws]'); if (w) w.addEventListener('change', () => { st.newWs = w.value; redraw(); }); };
          const redraw = () => { m.querySelector('#messages-newform').innerHTML = newForm(st, st.newKind || 'direct', all); m.querySelector('[data-ngo]').textContent = (st.newKind || 'direct') === 'direct' ? 'Start' : 'Create'; wireForm(); };
          wireForm();
          m.querySelector('[data-nk]').addEventListener('click', (e) => { const b = e.target.closest('[data-seg]'); if (!b) return; st.newKind = b.dataset.seg; st.newProblem = null; m.querySelectorAll('[data-nk] button').forEach((x) => { const on = x.dataset.seg === b.dataset.seg; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }); redraw(); });
          m.querySelector('[data-ngo]').addEventListener('click', () => {
            const k = st.newKind || 'direct';
            let req;
            if (k === 'direct') {
              const sel = m.querySelector('[data-nt]'); if (!sel || !sel.value) { ctx.toast('Pick a person.'); return; }
              st.newTarget = sel.value;
              req = App.post('/api/messaging/conversations', { kind: 'direct', userId: sel.value });
            } else {
              const ws = m.querySelector('[data-nws]').value; const title = m.querySelector('[data-ntitle]').value.trim(); const label = m.querySelector('[data-nlabel]').value;
              const members = Array.prototype.slice.call(m.querySelectorAll('[data-nm]:checked')).map((x) => x.value);
              if (!members.length) { ctx.toast('Pick at least one member.', 'warn'); return; }
              st.newWs = ws; st.newLabel = label; st.newTitle = title;
              req = App.post('/api/messaging/conversations', Object.assign({ kind: 'group', workspaceId: ws, memberIds: members, label }, title ? { title } : {}));
            }
            req.then((conv) => {
              const existed = st.convos.some((x) => x.id === conv.id);
              App.closeOverlay(); st.newProblem = null; st.newTitle = '';
              st.convo = conv.id; st.msgFor = null;
              ctx.toast(existed ? 'You already have a direct conversation with this person; it is open.' : k === 'direct' ? 'Direct conversation started.' : 'Group conversation created. You are the owner.', 'ok');
              return loadList(st).then(paint);
            }).catch((err) => {
              const p = err.problem || {};
              if (err.status === 403 || err.status === 422 || err.status === 404) { st.newProblem = { title: (err.status === 403 && p.step === 'contact' ? 'Cannot start this conversation' : p.title || 'Refused') + ' (' + err.status + (p.step ? ', step ' + p.step : '') + ')', detail: p.detail || err.message, trace: traceOf(err) }; redraw(); }
              else App.fail(err, 'Not started');
            });
          });
        } });
    }).catch((err) => App.fail(err, 'People not loaded'));
  }
  function newForm(st, k, all) {
    const problem = st.newProblem ? UI.problem(st.newProblem.title, st.newProblem.detail, st.newProblem.trace) : '';
    if (k === 'direct') {
      const blocked = blockedIds(st);
      const opts = all.map((p) => ({ value: p.userId, label: (p.displayName || p.username) + ' (' + p.workspaces.map((w) => w.name).join(', ') + ')' + (blocked.has(p.userId) ? ', blocked by you' : '') }));
      return '<div class="vstack gap12" style="margin-top:8px">' + (opts.length ? UI.field('Person', UI.select(opts, st.newTarget && opts.some((o) => o.value === st.newTarget) ? st.newTarget : opts[0].value, 'data-nt'), 'Someone who shares a workspace with you now. One direct conversation per pair.') : UI.empty('Nobody to message', 'Nobody else shares a workspace with you yet.'))
        + (problem || UI.notice((st.newExplain ? '<b>Refusals read the same either way.</b> Starting a conversation with someone whose contact rule or a block excludes you is refused with 403, step contact, and the words "does not accept messages from you", so a blocked person is never told. ' : '') + 'Contact rules: workspace (anyone sharing a workspace, the default), following (only people they follow) or nobody. Yours is <b>' + esc((st.social && st.social.contactRule) || 'workspace') + '</b>' + (App.can('social:read') ? '; change it under People.' : '.'), st.newExplain ? 'warn' : 'info')) + '</div>';
    }
    const wss = workspaces();
    const wsId = st.newWs && wss.some((w) => w.id === st.newWs) ? st.newWs : (curWs() || wss[0] || {}).id;
    const ws = wss.find((w) => w.id === wsId) || { label: 'internal', name: '' };
    const labels = LABELS.filter((l) => LEVEL[l] <= LEVEL[ws.label]);
    const ppl = all.filter((p) => p.workspaces.some((w) => w.id === wsId));
    return '<div class="formgrid" style="margin-top:8px">' + UI.field('Workspace', UI.select(wss.map((w) => ({ value: w.id, label: w.name })), wsId, 'data-nws'), 'Everyone must be a member of it now.') + UI.field('Title', UI.input(st.newTitle || '', { placeholder: 'Q3 board pack', attrs: 'data-ntitle' })) + UI.field('Label', UI.select(labels, st.newLabel && labels.indexOf(st.newLabel) >= 0 ? st.newLabel : labels.indexOf('internal') >= 0 ? 'internal' : labels[labels.length - 1], 'data-nlabel'), 'At most the workspace ceiling, ' + esc(ws.label) + '. Everyone must be cleared for it.') + '</div>'
      + UI.field('Members (up to MESSAGING_MAX_MEMBERS)', '<div class="vstack gap4">' + (ppl.length ? ppl.map((p) => UI.check(p.displayName || p.username, false, 'data-nm value="' + esc(p.userId) + '"')).join('') : '<span class="muted" style="font-size:12px">Nobody else is a member of ' + esc(ws.name) + '.</span>') + '</div>')
      + problem;
  }

  function wireFeed(ctx, st) {
    const post = (id) => (st.posts || []).find((p) => p.id === id);
    const refresh = () => loadFeed(st).then(paint);
    ctx.on('click', '[data-fseg] [data-seg]', (e, t) => { st.feedSeg = t.dataset.seg; st.focusPost = null; ctx.rerender(); });
    ctx.on('change', '[data-groupsel]', (e, t) => { st.groupSel = t.value; ctx.rerender(); });
    ctx.on('click', '[data-gotag]', (e, t) => { e.preventDefault(); st.tag = t.dataset.gotag; st.feedSeg = 'tag'; ctx.rerender(); });
    ctx.on('click', '[data-hideheld]', () => { st.showHeldNote = false; ctx.rerender(); });
    ctx.on('click', '[data-fsort]', (e, t) => openMenu(t, [['new', 'Newest first'], ['top', 'Most engaged']], st.feedSort || 'new', (v) => { st.feedSort = v; ctx.rerender(); }));
    ctx.on('click', '[data-loadmore]', (e, t) => { t.disabled = true; st.feedCursor = st.next; loadFeed(st, true).then(paint); });
    ctx.on('click', '[data-reporthint]', () => ctx.toast('Use Report on a post. It files a feed-post flag in its workspace\'s queue.'));
    ctx.on('input', '[data-pdraft]', (e, t) => { st.postDraft = t.value; });
    ctx.on('change', '[data-plabel]', (e, t) => { st.postLabel = t.value; });
    ctx.on('change', '[data-ptarget]', (e, t) => { st.postTarget = t.value; ctx.rerender(); });
    ctx.on('click', '[data-unmedia]', (e, t) => { st.pendingMedia = (st.pendingMedia || []).filter((m) => m.id !== t.dataset.unmedia); ctx.rerender(); });
    ctx.on('click', '[data-pmedia]', () => openFilePicker(ctx, st, 'post'));
    ctx.on('click', 'button[data-post]', (e, t) => {
      const text = (st.postDraft || '').trim(); const media = (st.pendingMedia || []).map((m) => m.id);
      if (!text && !media.length) { ctx.toast('Text or media are needed.', 'warn'); return; }
      const target = (ctx.$('[data-ptarget]') || {}).value || 'ws';
      const body = {};
      if (text) body.body = text;
      if (media.length) body.media = media;
      if (target.indexOf('g:') === 0) body.groupId = target.slice(2);
      else { body.workspaceId = curWs().id; const l = ctx.$('[data-plabel]'); if (l) body.label = l.value; }
      t.disabled = true;
      App.post('/api/feed/posts', body).then((p) => {
        st.postDraft = ''; st.pendingMedia = [];
        if (p.state === 'held') { st.showHeldNote = true; ctx.toast('Held for review (202). A hold flag is in the Flags queue; only you see the post.', 'warn', 6000); }
        else ctx.toast('Published. ' + (p.tags || []).length + ' hashtags extracted.', 'ok');
        return refresh();
      }).catch((err) => { t.disabled = false; App.fail(err, 'Not posted'); });
    });
    ctx.on('click', '[data-preact]', (e, t) => {
      const p = post(t.dataset.preact); if (!p) return; const k = t.dataset.kind; const has = (p.mine.reactions || []).indexOf(k) >= 0;
      const url = '/api/feed/posts/' + enc(p.id) + '/reactions/' + k;
      (has ? App.del(url) : put(url)).then(refresh).catch((err) => App.fail(err, 'Reaction not saved'));
    });
    ctx.on('click', '[data-pbookmark]', (e, t) => {
      const p = post(t.dataset.pbookmark); if (!p) return; const url = '/api/feed/posts/' + enc(p.id) + '/bookmark';
      (p.mine.bookmarked ? App.del(url) : put(url)).then(() => { ctx.toast(p.mine.bookmarked ? 'Bookmark removed.' : 'Bookmarked.', 'ok'); return refresh(); }).catch((err) => App.fail(err, 'Bookmark not saved'));
    });
    ctx.on('click', '[data-prepost]', (e, t) => {
      const p = post(t.dataset.prepost); if (!p) return;
      openMenu(t, [['plain', p.mine.reposted ? 'Take back plain repost' : 'Repost'], ['quote', 'Repost with text']], null, (v) => {
        if (v === 'plain') { (p.mine.reposted ? App.del('/api/feed/posts/' + enc(p.id) + '/repost') : App.post('/api/feed/posts/' + enc(p.id) + '/repost', {})).then(() => { ctx.toast(p.mine.reposted ? 'Repost taken back.' : 'Reposted. It carries the original\'s label; the audience never widens.', 'ok'); return refresh(); }).catch((err) => App.fail(err, 'Not reposted')); return; }
        ctx.modal({ title: 'Repost with text', body: UI.field('Your text', UI.textarea('', { attrs: 'data-qt', rows: 2 }), 'A post of its own: guardrails and holds apply.') + '<div class="messages-quote">' + esc(authorName(p.author)) + ': ' + esc(p.body || '') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Post', { kind: 'primary', attrs: 'data-qgo' }),
          onMount(m) { m.querySelector('[data-qgo]').addEventListener('click', () => { const val = m.querySelector('[data-qt]').value.trim(); if (!val) { ctx.toast('Write something, or use a plain repost.', 'warn'); return; } App.post('/api/feed/posts/' + enc(p.id) + '/repost', { body: val }).then((r) => { App.closeOverlay(); ctx.toast(r && r.state === 'held' ? 'Held for review (202).' : 'Published.', r && r.state === 'held' ? 'warn' : 'ok'); return refresh(); }).catch((err) => App.fail(err, 'Not posted')); }); } });
      });
    });
    const loadComments = (id) => App.get('/api/feed/posts/' + enc(id) + '/comments?limit=100').then((r) => { st.comments = st.comments || {}; st.comments[id] = r.items; });
    ctx.on('click', '[data-pcomments]', (e, t) => {
      const id = t.dataset.pcomments; st.comments = st.comments || {};
      if (st.comments[id]) { delete st.comments[id]; ctx.rerender(); return; }
      loadComments(id).then(paint).catch((err) => App.fail(err, 'Comments not loaded'));
    });
    ctx.on('click', '[data-pcomment]', (e, t) => {
      const p = post(t.dataset.pcomment); if (!p) return; const parent = t.dataset.parent;
      const pc = parent && st.comments && st.comments[p.id] ? st.comments[p.id].find((x) => x.id === parent) : null;
      ctx.modal({ title: parent ? 'Reply to comment' : 'Comment', body: (pc ? '<div class="messages-quote">' + esc(pc.body || '') + '</div>' : '') + UI.field('Comment', UI.textarea('', { attrs: 'data-cb', rows: 2 }), 'Comments do not wait for review: a hold refuses them (422). Oldest first; threads from the parent.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Post comment', { kind: 'primary', attrs: 'data-cgo' }),
        onMount(m) { m.querySelector('[data-cgo]').addEventListener('click', () => { const val = m.querySelector('[data-cb]').value.trim(); if (!val) return; App.post('/api/feed/posts/' + enc(p.id) + '/comments', Object.assign({ body: val }, parent ? { parentId: parent } : {})).then(() => { App.closeOverlay(); ctx.toast('Comment posted.', 'ok'); return loadComments(p.id); }).then(refresh).catch((err) => App.fail(err, 'Not posted')); }); } });
    });
    ctx.on('click', '[data-pedit]', (e, t) => {
      const p = post(t.dataset.pedit); if (!p) return;
      ctx.modal({ title: 'Edit post', body: UI.field('Text', UI.textarea(p.body || '', { attrs: 'data-eb', rows: 3 }), 'Checked again; a hold refuses the edit. The post is re-tagged and marked edited.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-ego' }),
        onMount(m) { m.querySelector('[data-ego]').addEventListener('click', () => { App.patch('/api/feed/posts/' + enc(p.id), { body: m.querySelector('[data-eb]').value }).then(() => { App.closeOverlay(); ctx.toast('Post edited.', 'ok'); return refresh(); }).catch((err) => App.fail(err, 'Not edited')); }); } });
    });
    ctx.on('click', '[data-pdel]', async (e, t) => {
      const p = post(t.dataset.pdel); if (!p) return; const mine = p.author && p.author.id === meId();
      const ok = await ctx.confirm({ title: 'Delete post', tag: mine ? 'your post' : 'feed:manage', tone: 'danger', body: '<p class="fg2" style="margin:0">' + (mine ? 'Deletes your post. Comments, reactions and reposts on it are refused from then on (409).' : 'As a holder of feed:manage you remove anyone\'s post in your workspaces. The author is notified; audited feed.post.deleted.') + '</p>', kv: [['Author', esc(authorName(p.author))], ['Posted', esc(when(p.publishedAt || p.createdAt))]], ok: 'Delete' });
      if (!ok) return;
      App.del('/api/feed/posts/' + enc(p.id)).then(() => { ctx.toast('Post deleted.', 'warn'); return refresh(); }).catch((err) => App.fail(err, 'Not deleted'));
    });
    ctx.on('click', '[data-preport]', (e, t) => {
      const p = post(t.dataset.preport); if (!p) return;
      ctx.modal({ title: 'Report post', body: UI.field('Reason', UI.select(['Harassment', 'Spam', 'Confidential data shared', 'Other'], 'Spam', 'data-rr')) + UI.notice('Files a feed-post flag in its workspace\'s queue. A reviewer\'s hide removes it from every feed; an upheld appeal restores it.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Report', { kind: 'primary', attrs: 'data-rgo' }),
        onMount(m) { m.querySelector('[data-rgo]').addEventListener('click', () => { App.post('/api/moderation/reports', { type: 'feed-post', id: p.id, reason: m.querySelector('[data-rr]').value }).then((r) => { App.closeOverlay(); ctx.toast(r.duplicate ? 'You already reported this post; your report is still open.' : 'Reported as ' + esc(r.flag.ref) + ' (feed-post).' + (App.can('moderation:review') ? ' <a href="#/moderation?flag=' + esc(r.flag.ref) + '" style="color:inherit">Open in Moderation</a>' : ''), 'ok', 5000); }).catch((err) => App.fail(err, 'Not reported')); }); } });
    });
    ctx.on('click', '[data-digestopen]', (e, t) => {
      App.get('/api/feed/digests/' + enc(t.dataset.digestopen)).then((d) => {
        ctx.drawer({ title: 'Digest, week of ' + esc(day(d.weekStart)), body: UI.kv([['State', UI.pill(d.state, d.state === 'ready' ? 'ok' : d.state === 'failed' ? 'danger' : '')], ['Label', UI.label(d.label, { sm: true })], ['Profile', esc(d.profile || 'FEED_DIGEST_PROFILE')]], 3)
          + (d.state === 'failed' ? UI.notice('<b>Summary failed.</b> ' + esc(d.error || '') + '. The ranked list is kept.', 'danger') : '')
          + (d.summary ? '<div class="serif" style="font-size:15px;line-height:1.5;margin:8px 0">' + esc(d.summary) + '</div>' : d.state === 'empty' ? UI.empty('No posts that week', 'A week without posts is empty.') : '')
          + ((d.posts || []).length ? UI.table(['#', 'Post', { label: 'Score', right: true }], d.posts.map((x, i) => [String(i + 1), x.post ? '<b>' + esc(authorName(x.post.author)) + '</b>: ' + esc((x.post.body || '').slice(0, 80)) : '<span class="muted">post no longer visible to you</span>', '<span class="num">' + x.score + '</span>']), { minWidth: '0', clickable: false }) : ''),
        actions: UI.btn('Close', { attrs: 'data-close' }) });
      }).catch((err) => App.fail(err, 'Digest not loaded'));
    });
    const ws = curWs();
    ctx.on('click', '[data-dtoggle]', () => { const fs = st.feedSettings; if (!fs || !ws) return; put('/api/feed/workspaces/' + enc(ws.id) + '/settings', { digestEnabled: !fs.digestEnabled }).then((r) => { st.feedSettings = r; ctx.toast('Digest ' + (r.digestEnabled ? 'enabled' : 'disabled') + '. feed.settings.updated written.', 'ok'); paint(); }).catch((err) => App.fail(err, 'Not saved')); });
    ctx.on('change', '[data-dprofile]', (e, t) => { if (!ws) return; put('/api/feed/workspaces/' + enc(ws.id) + '/settings', { digestProfile: t.value || null }).then((r) => { st.feedSettings = r; ctx.toast(t.value ? 'Digest profile set to ' + esc(t.value) + '.' : 'Digest profile cleared; falls back to FEED_DIGEST_PROFILE.', 'ok'); paint(); }).catch((err) => { App.fail(err, 'Not saved'); paint(); }); });
    ctx.on('click', '[data-drun]', (e, t) => { if (!ws) return; t.disabled = true; App.post('/api/feed/workspaces/' + enc(ws.id) + '/digest', {}).then(() => { ctx.toast('Digest queued (job feed.digest). Members cleared for its label are notified when it is ready.', 'ok'); setTimeout(() => { st.digests = null; loadFeed(st).then(paint); }, 2500); }).catch((err) => { t.disabled = false; App.fail(err, 'Digest not queued'); }); });
  }

  function wirePeople(ctx, st) {
    const s = st.social;
    const reloadSocial = () => loadSocial(st).then(() => { st.feedKey = null; st.listDetail = null; st.msgFor = null; paint(); });
    const pickPerson = (title, exclude, hint, onPick, extra) => people(st).then((all) => {
      const cands = all.filter((p) => exclude.indexOf(p.userId) < 0);
      if (!cands.length) { ctx.toast('Nobody else to pick: everyone who shares a workspace with you is already here.'); return; }
      ctx.modal({ title, body: UI.field('Person', UI.select(cands.map((p) => ({ value: p.userId, label: (p.displayName || p.username) + ' (' + p.workspaces.map((w) => w.name).join(', ') + ')' })), cands[0].userId, 'data-pp'), hint) + (extra || ''), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(title, { kind: 'primary', attrs: 'data-ppgo' }),
        onMount(m) { m.querySelector('[data-ppgo]').addEventListener('click', () => { const v = m.querySelector('[data-pp]').value; const mm = m.querySelector('[data-mm]'); const nm = cands.find((p) => p.userId === v) || {}; App.closeOverlay(); onPick(v, nm.displayName || nm.username || 'them', mm ? mm.value : null); }); } });
    }).catch((err) => App.fail(err, 'People not loaded'));
    ctx.on('click', '[data-ptabs] [data-tab]', (e, t) => { st.peopleTab = t.dataset.tab; ctx.rerender(); });
    ctx.on('click', '[data-rule] [data-seg]', (e, t) => {
      if (!App.can('social:write')) { ctx.toast('Changing your contact rule needs social:write.', 'warn'); return; }
      if (t.dataset.seg === s.contactRule) return;
      put('/api/social/settings', { contactRule: t.dataset.seg }).then((r) => { s.contactRule = r.contactRule; ctx.toast('Contact rule saved: ' + esc(r.contactRule) + '. Audited social.contact-rule.updated.', 'ok'); paint(); }).catch((err) => App.fail(err, 'Not saved'));
    });
    ctx.on('click', '[data-unblock]', (e, t) => { App.del('/api/social/blocks/' + enc(t.dataset.unblock)).then(() => { ctx.toast('Unblocked. Follows do not come back on their own.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not unblocked')); });
    ctx.on('click', '[data-block]', () => pickPerson('Block', s.blocks.map((b) => b.userId), 'Anyone who shares a workspace with you. Ends follows both ways; they are not told.', async (id, nm) => {
      const ok = await ctx.confirm({ title: 'Block ' + nm, tone: 'danger', body: '<p class="fg2" style="margin:0">Neither of you can message the other; their messages, posts, typing and presence are left out for you on every instance. They read only "does not accept messages from you".</p>', ok: 'Block' });
      if (!ok) return;
      App.post('/api/social/blocks', { userId: id }).then(() => { ctx.toast(esc(nm) + ' blocked.', 'warn'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not blocked'));
    }));
    ctx.on('click', '[data-unmute]', (e, t) => { App.del('/api/social/mutes/' + enc(t.dataset.unmute)).then(() => { ctx.toast('Unmuted.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not unmuted')); });
    ctx.on('click', '[data-mutesomeone]', () => pickPerson('Mute', s.mutes.map((m) => m.userId), null, (id, nm, mins) => {
      App.post('/api/social/mutes', Object.assign({ userId: id }, mins ? { minutes: Number(mins) } : {})).then(() => { ctx.toast(esc(nm) + ' muted. Private; they are not told.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not muted'));
    }, UI.field('For', UI.select([{ value: '60', label: '1 hour' }, { value: '1440', label: '1 day' }, { value: '10080', label: '1 week' }, { value: '', label: 'Until I unmute' }], '10080', 'data-mm'), 'At most a year. Muting again sets the new end.')));
    ctx.on('click', '[data-unfollow]', (e, t) => { App.del('/api/social/following/' + enc(t.dataset.unfollow)).then(() => { ctx.toast('Unfollowed.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not unfollowed')); });
    ctx.on('click', '[data-followid]', (e, t) => { App.post('/api/social/following', { userId: t.dataset.followid }).then(() => { ctx.toast('Following. Their posts join your home feed.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not followed')); });
    ctx.on('click', '[data-follow]', () => pickPerson('Follow', s.following.map((f) => f.userId), 'Must share a workspace with you.', (id, nm) => { App.post('/api/social/following', { userId: id }).then(() => { ctx.toast('Following ' + esc(nm) + '. Their posts join your home feed.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not followed')); }));
    ctx.on('click', '[data-list]', (e, t) => { st.list = t.dataset.list; st.listDetail = null; ctx.rerender(); });
    ctx.on('click', '[data-newlist]', () => ctx.modal({ title: 'New list', body: UI.field('Name', UI.input('', { attrs: 'data-ln', placeholder: 'Lisbon team' }), 'A name you already use, any case, is refused (409).') + UI.field('Description', UI.input('', { attrs: 'data-ld' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-lgo' }),
      onMount(m) { m.querySelector('[data-lgo]').addEventListener('click', () => { const n = m.querySelector('[data-ln]').value.trim(); if (!n) { ctx.toast('Name the list.', 'warn'); return; } const dsc = m.querySelector('[data-ld]').value.trim(); App.post('/api/social/lists', Object.assign({ name: n }, dsc ? { description: dsc } : {})).then((l) => { App.closeOverlay(); st.list = l.id; ctx.toast('List created.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not created')); }); } }));
    const d = st.listDetail;
    if (!d) return;
    ctx.on('click', '[data-listrm]', (e, t) => { App.del('/api/social/lists/' + enc(d.id) + '/members/' + enc(t.dataset.listrm)).then(() => { ctx.toast('Taken off ' + esc(d.name) + '.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not removed')); });
    ctx.on('click', '[data-listadd]', () => pickPerson('Add to list', (d.people || []).map((p) => p.userId), 'Someone outside your workspaces is 404; a blocked person 409.', (id, nm) => { App.post('/api/social/lists/' + enc(d.id) + '/members', { userId: id }).then(() => { ctx.toast(esc(nm) + ' added to ' + esc(d.name) + '.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not added')); }));
    ctx.on('click', '[data-listrename]', () => ctx.modal({ title: 'Rename list', body: UI.field('Name', UI.input(d.name, { attrs: 'data-ln' })) + UI.field('Description', UI.input(d.description || '', { attrs: 'data-ld' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-lgo' }),
      onMount(m) { m.querySelector('[data-lgo]').addEventListener('click', () => { const dsc = m.querySelector('[data-ld]').value.trim(); App.patch('/api/social/lists/' + enc(d.id), { name: m.querySelector('[data-ln]').value.trim() || d.name, description: dsc || null }).then(() => { App.closeOverlay(); ctx.toast('List saved.', 'ok'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not saved')); }); } }));
    ctx.on('click', '[data-listdel]', async () => {
      const ok = await ctx.confirm({ title: 'Delete list', tone: 'danger', body: '<p class="fg2" style="margin:0">Deletes ' + esc(d.name) + '. Nobody is told; the people stay followed.</p>', ok: 'Delete' });
      if (!ok) return;
      App.del('/api/social/lists/' + enc(d.id)).then(() => { st.list = null; if (st.listFeed && st.listFeed.id === d.id) { st.listFeed = null; if (st.feedSeg === 'list') st.feedSeg = 'home'; } ctx.toast('List deleted.', 'warn'); return reloadSocial(); }).catch((err) => App.fail(err, 'Not deleted'));
    });
    ctx.on('click', '[data-listfeed]', () => { st.listFeed = { id: d.id, name: d.name }; st.view = 'feed'; st.feedSeg = 'list'; ctx.rerender(); });
  }

  function openMenu(anchor, items, active, pick) {
    const host = anchor.closest('.relative') || anchor.parentElement; const ex = host.querySelector('.dropdown');
    document.querySelectorAll('#main .dropdown').forEach((x) => x.remove()); if (ex) return;
    host.classList.add('relative');
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    const first = d.querySelector('button'); if (first) first.focus();
    d.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { d.remove(); anchor.focus(); } });
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }
})();
