(function () {
  const { UI, esc } = App;

  // Groups and events (Sprint 30, B-3409) over the Sprint 27c API: /api/groups, /api/group-requests, /api/group-posts,
  // /api/calendar. What the caller may do inside a group is their acting group role (a groups:manage holder acts as
  // owner); the screen hides what the server would refuse and shows the server's refusals as they come.
  // 1.6.0 (Sprint 36a, B-4401 to B-4405): channels inside a group (/api/groups/:id/channels), Discover ranked by the
  // server (/api/groups/discover), Trending (/api/groups/trending), the tenant's categories (/api/group-categories)
  // and distance filters (near, km) on the lists and the calendar.
  const enc = encodeURIComponent;
  const RANK = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const ROOM_EVENTS = ['group.channel.created', 'group.updated', 'group.member.added', 'group.member.removed', 'group.member.role', 'group.post.created', 'group.post.deleted', 'group.event.created', 'group.event.updated', 'group.event.cancelled', 'group.event.rsvp', 'group.event.check-in'];
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fmtDate = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return d + ' ' + MONTHS[m - 1].slice(0, 3) + ' ' + y; };
  const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const remText = (m) => (m >= 10080 && m % 10080 === 0 ? (m / 10080) + ' week' + (m === 10080 ? '' : 's') : m >= 1440 && m % 1440 === 0 ? (m / 1440) + ' day' + (m === 1440 ? '' : 's') : m >= 60 && m % 60 === 0 ? (m / 60) + ' h' : m + ' min');
  const small = (t) => '<span class="muted" style="font-size:12px">' + t + '</span>';
  const visPill = (v) => UI.pill(v, v === 'hidden' ? 'warn' : v === 'private' ? '' : 'outline');
  // Sprint 34 (B-5801): a member's or author's name opens their profile.
  const who = (id, name) => (id && App.can('social:read') ? '<a class="groups-who" href="#/person?user=' + enc(id) + '">' + esc(name) + '</a>' : esc(name));
  const rolePill = (r) => (!r ? '' : UI.pill(r, r === 'owner' ? 'accent' : r === 'moderator' ? 'info' : 'outline'));
  const overlayOpen = () => !!document.getElementById('overlay');
  const TZS = (() => { const base = ['UTC', 'Europe/Berlin', 'Europe/Lisbon', 'Europe/London', 'America/New_York']; let own = 'UTC'; try { own = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { /* no Intl */ } if (base.indexOf(own) < 0) base.push(own); return { list: base, own }; })();

  const me = () => (App.me && App.me.user) || {};
  const clears = (label) => (RANK[me().clearance] || 1) >= (RANK[label] || 2);
  const wsName = (id) => { const w = ((App.me && App.me.workspaces) || []).find((x) => x.id === id); return w ? w.name : 'another workspace'; };
  const wsLabel = (id) => { const w = ((App.me && App.me.workspaces) || []).find((x) => x.id === id); return w ? w.label : null; };
  const isOwner = (g) => g.actingRole === 'owner';
  const isMod = (g) => g.actingRole === 'owner' || g.actingRole === 'moderator';
  const readable = (g) => g.state !== 'hidden' && clears(g.label) && (!!g.actingRole || g.visibility === 'public');
  const canWrite = () => App.can('groups:write');
  const POINT = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
  /** "lat, lon" → { lat, lon }, '' → null, anything else → false. */
  const parsePoint = (v) => { const t = String(v || '').trim(); if (!t) return null; const m = POINT.exec(t); if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) return false; return { lat: +m[1], lon: +m[2] }; };
  const fmtPoint = (lat, lon) => (lat == null || lon == null ? '' : (+lat).toFixed(4) + ', ' + (+lon).toFixed(4));
  const KMS = [5, 10, 25, 50, 100, 300, 1000];

  /** An event from the API with its wall-clock date and times in its own zone. */
  function norm(e) {
    const ls = e.localStart || '', le = e.localEnd || '';
    let endDate = le.slice(0, 10);
    // All-day events end at the start of the day after their last day.
    if (e.allDay && endDate) { const d = new Date(endDate + 'T00:00:00'); d.setDate(d.getDate() - 1); endDate = isoDay(d); if (endDate < ls.slice(0, 10)) endDate = ls.slice(0, 10); }
    return Object.assign({}, e, { date: ls.slice(0, 10), endDate, start: e.allDay ? '' : ls.slice(11, 16), end: e.allDay ? '' : le.slice(11, 16) });
  }
  const whenText = (e) => (e.allDay ? fmtDate(e.date) + (e.endDate && e.endDate !== e.date ? ' to ' + fmtDate(e.endDate) : '') + ', all day (' + e.timeZone + ')'
    : fmtDate(e.date) + ', ' + e.start + ' to ' + (e.endDate && e.endDate !== e.date ? fmtDate(e.endDate) + ' ' : '') + e.end + ' ' + e.timeZone);
  const att = (e) => e.attendance || { going: 0, maybe: 0, guests: 0, checkedIn: 0 };
  const upcoming = (e) => e.state === 'scheduled' && Date.parse(e.endsAt) >= Date.now();

  // ---- realtime: the selected group's room; its events carry ids only, so the group is fetched again ----
  const live = { sock: null, room: null, handlers: null, timer: null, refresh: null };
  const leaveRoom = () => { if (live.sock && live.room) live.sock.emit('room.leave', { kind: 'group', id: live.room }); live.room = null; };
  const detach = () => {
    leaveRoom();
    if (live.sock && live.handlers) Object.keys(live.handlers).forEach((ev) => live.sock.off(ev, live.handlers[ev]));
    live.sock = null; live.handlers = null; if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  };
  const attach = (groupId) => {
    if (!App.socket) return;
    if (live.sock !== App.socket) {
      detach();
      live.sock = App.socket; live.handlers = {};
      ROOM_EVENTS.forEach((ev) => {
        live.handlers[ev] = (msg) => {
          if (App.state.route !== 'groups') { detach(); return; }
          if (!msg || msg.kind !== 'group' || msg.id !== live.room || live.timer) return;
          live.timer = setTimeout(() => { live.timer = null; if (live.refresh) live.refresh(msg.id); }, 800);
        };
        live.sock.on(ev, live.handlers[ev]);
      });
    }
    if (live.room === groupId) return;
    leaveRoom();
    if (groupId) { live.room = groupId; live.sock.emit('room.join', { kind: 'group', id: groupId }); }
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'groups') detach(); });

  function menu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  /** A confirm dialog whose fields (by attribute) are read as it closes; resolves to their values, or null. */
  function confirmWith(ctx, opts, attrs) {
    const v = {};
    setTimeout(() => {
      const o = document.getElementById('overlay'); if (!o) return;
      const grab = () => attrs.forEach((a) => { const el = o.querySelector('[' + a + ']'); if (el) v[a] = el.value; });
      o.addEventListener('input', grab); o.addEventListener('change', grab); grab();
    }, 0);
    return ctx.confirm(opts).then((ok) => (ok ? v : null));
  }

  function calendar(st, events) {
    const year = st.calY, month = st.calM;
    const first = new Date(year, month, 1); const startDow = (first.getDay() + 6) % 7; const days = new Date(year, month + 1, 0).getDate();
    const today = isoDay(new Date());
    let cells = ''; for (let i = 0; i < startDow; i++) cells += '<div class="groups-day pad" aria-hidden="true"></div>';
    for (let d = 1; d <= days; d++) {
      const iso = year + '-' + pad(month + 1) + '-' + pad(d);
      const todays = events.filter((e) => e.date <= iso && (e.endDate || e.date) >= iso);
      cells += '<div class="groups-day' + (iso === today ? ' today' : '') + '" role="listitem" aria-label="' + esc(fmtDate(iso)) + (iso === today ? ', today' : '') + (todays.length ? ', ' + todays.length + ' event' + (todays.length === 1 ? '' : 's') : '') + '"><div class="n" aria-hidden="true">' + d + '</div>'
        + todays.map((e) => '<button type="button" class="groups-ev ' + (e.state === 'cancelled' ? 'cancelled' : '') + (e.id === st.eventSel ? ' on' : '') + '" data-event="' + esc(e.id) + '" aria-label="' + esc(e.title + ', ' + fmtDate(iso) + (e.allDay ? ', all day' : ', ' + e.start) + (e.state === 'cancelled' ? ', cancelled' : '')) + '"' + (e.id === st.eventSel ? ' aria-current="true"' : '') + '>' + (e.allDay ? '' : '<span class="mono">' + esc(e.start) + '</span> ') + esc(e.title) + '</button>').join('') + '</div>';
    }
    return '<div class="groups-cal"><div class="hstack" style="margin-bottom:6px">' + UI.iconbtn('chev', 'Previous month', { attrs: 'data-cal="-1"', cls: 'sm ghost groups-prev', size: 14 }) + '<b class="grow" style="text-align:center" aria-live="polite">' + MONTHS[month] + ' ' + year + '</b>' + UI.iconbtn('chev', 'Next month', { attrs: 'data-cal="1"', cls: 'sm ghost', size: 14 }) + '</div>'
      + '<div class="groups-grid groups-head" aria-hidden="true">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => '<div class="groups-dow">' + d + '</div>').join('') + '</div>'
      + '<div class="groups-grid" role="list" aria-label="' + MONTHS[month] + ' ' + year + '">' + cells + '</div></div>';
  }

  App.register({
    id: 'groups', title: 'Groups and events', live: true, crumb: ['Groups and events'],
    summary: 'Groups with join modes, requests and invitations, posts, a calendar with RSVP and check-in, reminders, feed URLs',
    label: (st) => { const g = (st.groups || []).find((x) => x.id === st.sel); return g ? g.label : null; },
    commands: [
      { label: 'Create a group', sub: 'Groups and events', run(app) { app.stateFor('groups').openNew = true; app.render(); } },
      { label: 'Create an event', sub: 'Groups and events', run(app) { const s = app.stateFor('groups'); s.tab = 'events'; s.openNewEvent = true; app.render(); } }
    ],
    // Each state looks through every group the caller can read (loading those not opened yet) and shows the case it
    // describes on real data, or says that none of the groups is in that case.
    states: [
      { title: 'Join needs a request', tone: 'info', text: 'A request-mode group answers 202 with the pending request; moderators are notified. Asking again returns the same request.', apply(ctx) { ctx.state.pending = 'request'; ctx.rerender(); } },
      { title: 'Capacity reached', tone: 'danger', text: 'Capacity counts people with their guests. An RSVP past it is 409 with the places left.', apply(ctx) { ctx.state.pending = 'capacity'; ctx.rerender(); } },
      { title: 'Event cancelled, attendees notified', tone: 'warn', text: 'Cancelling stops the reminders and notifies every attendee (going or maybe) in the console and by email, without the title or reason.', apply(ctx) { ctx.state.pending = 'cancelled'; ctx.rerender(); } },
      { title: 'Hidden group (moderation)', tone: 'warn', text: 'A group hidden through moderation is closed to everyone but managers and its owners; its events leave calendars and reminders stop.', apply(ctx) { ctx.state.pending = 'hidden'; ctx.rerender(); } },
      { title: 'Last owner cannot leave', tone: 'danger', text: 'A group keeps at least one owner: leaving or demoting the last one is 409. Hand over ownership first.', apply(ctx) { ctx.state.pending = 'owner'; ctx.rerender(); } },
      { title: 'Channel below the group\'s label', tone: 'danger', text: 'A channel is labelled at least as high as its group (the floor). Creating one lower is 422 with step label-floor.', apply(ctx) { ctx.state.pending = 'floor'; ctx.rerender(); } },
      { title: 'Discover never shows a group above your clearance', tone: 'info', text: 'Discovery lists groups you may join, ranked by shared members and activity, and never one labelled above your clearance, whatever else you may see.', apply(ctx) { ctx.state.pending = 'above'; ctx.rerender(); } },
      { title: 'Distance filter', tone: 'info', text: 'Groups and events with a place can be filtered by distance. Only places you may read count (a private group\'s place is its members\').', apply(ctx) { ctx.state.pending = 'near'; ctx.rerender(); } },
      { title: 'Trending after a burst of joins', tone: 'ok', text: 'The groups.trending job counts joins (3 each) and posts in the last hours of its window; a burst of joins leads after one run.', apply(ctx) { ctx.state.pending = 'trending'; ctx.rerender(); } },
      { title: 'Uncategorised after a category is removed', tone: 'warn', text: 'Removing a category on Social and messaging leaves its groups listed and uncategorised, never hidden. Filter Category: uncategorised shows them.', apply(ctx) { ctx.state.pending = 'uncategorised'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.mode = st.mode || 'mine'; st.tab = st.tab || 'overview'; st.query = st.query || ''; st.fws = st.fws || 'all'; st.fvis = st.fvis || 'all'; st.fjoin = st.fjoin || 'all'; st.fcat = st.fcat || 'all';
      st.categories = st.categories || []; st.disc = st.disc || { groups: [] }; st.trend = st.trend || { groups: [] };
      st.det = st.det || {}; st.mineReq = st.mineReq || {}; st.invites = st.invites || {}; st.notified = st.notified || {}; st.chans = st.chans || {};
      if (st.calY == null) { const n = new Date(); st.calY = n.getFullYear(); st.calM = n.getMonth(); }
      const later = () => { if (App.state.route !== 'groups') return; if (overlayOpen()) { setTimeout(later, 250); return; } ctx.rerender(); };

      const load = (quiet) => {
        if (st.loading) { st.again = true; return; }
        st.loading = true;
        // The category and distance filters are the server's (B-4403, B-4405); the others filter what it returned.
        const f = [];
        if (st.fcat !== 'all') f.push('category=' + enc(st.fcat));
        if (st.near) f.push('near=' + enc(st.near.lat + ',' + st.near.lon), 'km=' + enc(st.near.km));
        const qs = f.length ? '?' + f.join('&') : '';
        Promise.all([App.get('/api/groups' + qs), App.get('/api/group-requests').catch(() => []), App.get('/api/calendar/feeds').catch(() => []),
          App.get('/api/groups/discover' + qs).catch(() => ({ groups: [] })), App.get('/api/groups/trending' + (st.fcat !== 'all' ? '?category=' + enc(st.fcat) : '')).catch(() => ({ groups: [] })), App.get('/api/group-categories').catch(() => []),
          st.sel && st.chans[st.sel] ? App.get('/api/groups/' + enc(st.sel)).catch(() => false) : Promise.resolve(null)])
          .then(([gs, mine, feeds, disc, trend, cats, chan]) => {
            // The open channel's own view (its role and counts), or gone (the group was left or the channel deleted).
            if (chan) st.chans[chan.id] = chan; else if (chan === false) delete st.chans[st.sel];
            st.groups = gs; st.feeds = feeds; st.mineReq = {}; st.invites = {}; st.disc = disc; st.trend = trend; st.categories = cats;
            if (st.fcat !== 'all' && st.fcat !== 'none' && !cats.some((c) => c.id === st.fcat)) { st.fcat = 'all'; st.again = true; }
            mine.forEach((r) => { if (r.state !== 'pending') return; if (r.kind === 'invite') st.invites[r.groupId] = r; else st.mineReq[r.groupId] = r; });
            st.loaded = true; st.loadError = null;
          })
          .catch((err) => { if (!quiet) st.loadError = err; })
          .finally(() => { st.loading = false; if (st.again) { st.again = false; load(true); return; } later(); });
      };
      const loadGroup = (g) => {
        const id = g.id; const d = st.det[id] || (st.det[id] = {});
        if (d.loading) { d.again = true; return; }
        d.loading = true;
        const rd = readable(g), mod = isMod(g) && g.state !== 'hidden';
        const from = new Date(); from.setMonth(from.getMonth() - 3); from.setDate(1); from.setHours(0, 0, 0, 0);
        const to = new Date(from.getTime() + 465 * 86400000);
        const none = Promise.resolve(null);
        Promise.all([
          rd ? App.get('/api/groups/' + enc(id) + '/members') : none,
          rd ? App.get('/api/groups/' + enc(id) + '/posts?limit=100') : none,
          rd ? App.get('/api/groups/' + enc(id) + '/events?includeCancelled=true&from=' + enc(from.toISOString()) + '&to=' + enc(to.toISOString())) : none,
          mod ? Promise.all(['pending', 'accepted', 'declined', 'expired'].map((s) => App.get('/api/groups/' + enc(id) + '/requests?state=' + s))).then((a) => a.reduce((x, y) => x.concat(y), [])) : none,
          mod ? App.get('/api/groups/' + enc(id) + '/cases') : none,
          rd && !g.parentId ? App.get('/api/groups/' + enc(id) + '/channels') : none
        ]).then(([members, posts, events, requests, cases, channels]) => {
          (channels || []).forEach((c) => { st.chans[c.id] = c; });
          // Attendance and the caller's RSVP come with each event's own record.
          return Promise.all((events || []).slice(0, 80).map((e) => App.get('/api/calendar/events/' + enc(e.id)).catch(() => e)))
            .then((full) => { Object.assign(d, { members, posts, events: full.map(norm), requests: requests ? requests.sort((a, b) => b.createdAt - a.createdAt) : null, cases, channels, error: null, loaded: true }); });
        }).catch((err) => { d.error = err; d.loaded = true; })
          .finally(() => { d.loading = false; if (d.again) { d.again = false; loadGroup(g); return; } later(); });
      };
      live.refresh = (gid) => { if (gid && st.det[gid]) st.det[gid].stale = true; load(true); };

      if (!st.loaded && !st.loadError) load();
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Groups and events', 'Groups, their posts and the calendar', '') + (st.loadError ? UI.problem('The groups could not be loaded', st.loadError.message, (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }

      // A design state waits until every group it looks through is loaded, then picks its case.
      if (st.pending) {
        const need = ['capacity', 'cancelled', 'owner'].indexOf(st.pending) < 0 ? [] : st.groups.filter(readable);
        const waiting = need.filter((x) => { const d = st.det[x.id]; if (!d || !d.loaded || d.stale) { if (!d || !d.loading) { if (d) d.stale = false; loadGroup(x); } return true; } return !!d.loading; });
        if (waiting.length) {
          root.innerHTML = '<div class="page">' + UI.pagehead('Groups and events', 'Looking through ' + need.length + ' group' + (need.length === 1 ? '' : 's'), '') + UI.notice('Loading…', 'info') + '</div>';
          return;
        }
        resolveState(st, st.pending); st.pending = null;
        if (st.reloadNow) { st.reloadNow = false; load(true); }
      }

      // Deep links: ?id=<group>&event=<event> (notifications), ?invite=<request>, ?group=, ?tab=
      const p = ctx.params;
      const byId = (id) => st.groups.find((x) => x.id === id) || (st.disc.groups || []).find((x) => x.id === id) || (st.trend.groups || []).find((x) => x.id === id) || st.chans[id] || null;
      if (p.id || p.group) {
        const want = p.id || p.group; delete p.id; delete p.group; const g0 = byId(want);
        if (g0) { st.sel = g0.id; if (!g0.role && !g0.parentId) st.mode = 'discover'; }
        // A channel (or a group outside the loaded lists) is fetched by itself.
        else App.get('/api/groups/' + enc(want)).then((v) => { st.chans[v.id] = v; st.sel = v.id; st.tab = 'overview'; ctx.rerender(); }).catch(() => { st.demoNote = 'That group is not available to you.'; ctx.rerender(); });
      }
      if (p.invite) { const want = p.invite; delete p.invite; const gid = Object.keys(st.invites).find((k) => st.invites[k].id === want); if (gid) { st.sel = gid; st.mode = 'discover'; st.tab = 'overview'; } else st.demoNote = 'That invitation is no longer pending: it was accepted, declined, withdrawn or has expired.'; }
      if (p.event) { st.wantEvent = p.event; st.tab = 'events'; delete p.event; }
      if (p.tab) { st.tab = p.tab; delete p.tab; }

      // My groups from the list; Discover and Trending as the server ranked them (B-4402, B-4404).
      const pool = st.mode === 'discover' ? st.disc.groups || [] : st.mode === 'trending' ? st.trend.groups || [] : st.groups.filter((x) => !!x.role);
      const list = pool.filter((g) => (!st.query || (g.name + ' ' + (g.description || '')).toLowerCase().indexOf(st.query.toLowerCase()) >= 0) && (st.fws === 'all' || g.workspaceId === st.fws) && (st.fvis === 'all' || g.visibility === st.fvis) && (st.fjoin === 'all' || g.joinMode === st.fjoin));
      if (!st.sel || !byId(st.sel)) st.sel = list.length ? list[0].id : null;
      const g = st.sel ? byId(st.sel) : null;
      const wsList = (App.me && App.me.workspaces) || [];
      const catName = (id) => (st.categories.find((c) => c.id === id) || {}).name || '';
      const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
      const subOf = (x) => (st.mode === 'discover' ? plural(x.sharedMembers || 0, 'shared member') + ', ' + plural((x.activity || {}).posts || 0, 'post') + ' and ' + plural((x.activity || {}).joins || 0, 'join') + ' in ' + (st.disc.windowDays || 30) + ' days'
        : st.mode === 'trending' && x.trend ? plural(x.trend.joins, 'join') + ', ' + plural(x.trend.posts, 'post') + ' in ' + (st.trend.hours || 72) + ' h'
          : esc(wsName(x.workspaceId)) + ', ' + plural(x.members || 0, 'member') + ', ' + esc(x.visibility) + ', ' + esc(x.joinMode))
        + (x.distanceKm != null ? ', ' + (x.distanceKm < 10 ? x.distanceKm.toFixed(1) : Math.round(x.distanceKm)) + ' km' : '') + (x.categoryId && catName(x.categoryId) ? ' · ' + esc(catName(x.categoryId)) : '');

      const left = '<div class="leftpane w320">' + UI.seg([{ id: 'mine', label: 'My groups' }, { id: 'discover', label: 'Discover' }, { id: 'trending', label: 'Trending' }], st.mode, 'data-modeseg aria-label="Which groups"')
        + UI.search('Search groups', 'data-search', st.query)
        + '<div class="hstack gap6 wrap"><span class="relative">' + UI.btn(st.fws === 'all' ? 'Workspace' : wsName(st.fws), { size: 'xs', icon: 'filter', attrs: 'data-fws', cls: st.fws === 'all' ? '' : 'active' }) + '</span><span class="relative">' + UI.btn(st.fvis === 'all' ? 'Visibility' : st.fvis, { size: 'xs', icon: 'filter', attrs: 'data-fvis', cls: st.fvis === 'all' ? '' : 'active' }) + '</span><span class="relative">' + UI.btn(st.fjoin === 'all' ? 'Join mode' : st.fjoin, { size: 'xs', icon: 'filter', attrs: 'data-fjoin', cls: st.fjoin === 'all' ? '' : 'active' }) + '</span>'
        + '<span class="relative">' + UI.btn(st.fcat === 'all' ? 'Category' : st.fcat === 'none' ? 'Uncategorised' : catName(st.fcat) || 'Category', { size: 'xs', icon: 'filter', attrs: 'data-fcat', cls: st.fcat === 'all' ? '' : 'active' }) + '</span>'
        + UI.btn(st.near ? 'Within ' + st.near.km + ' km' : 'Distance', { size: 'xs', icon: 'map', attrs: 'data-fnear' + (st.near ? ' aria-label="Distance filter: within ' + st.near.km + ' km of ' + esc(st.near.label || fmtPoint(st.near.lat, st.near.lon)) + '"' : ''), cls: st.near ? 'active' : '' }) + '</div>'
        + (st.mode === 'discover' ? small('Groups you may join, ranked by shared members and activity. Groups above your clearance are never listed.') : st.mode === 'trending' ? small('Counted by the groups.trending job over the last ' + (st.trend.hours || 72) + ' hours' + (st.trend.computedAt ? ', last run ' + esc(fmtWhen(st.trend.computedAt)) : '') + '. Hidden groups and channels never trend.') : '')
        + '<div class="vstack" style="gap:2px">' + list.map((x) => UI.listItem(esc(x.name) + (x.state === 'hidden' ? ' ' + UI.pill('hidden by moderation', 'warn') : ''), subOf(x), { active: x.id === st.sel, attrs: 'data-group="' + esc(x.id) + '"', right: rolePill(x.role) || (st.invites[x.id] ? UI.pill('invited', 'info') : st.mineReq[x.id] ? UI.pill('requested', 'info') : UI.label(x.label, { sm: true })) })).join('')
        + (list.length ? '' : UI.empty('No groups match', st.near ? 'No group whose place you may read is within ' + st.near.km + ' km.' : st.mode === 'mine' ? (st.groups.length ? 'You are in no group that matches. Try Discover.' : 'You are in no group yet. Create one, or look in Discover.') : st.mode === 'trending' ? 'Nothing trends in your workspaces yet. The groups.trending job counts joins and posts.' : 'Nothing to join that matches. Hidden groups are known only to their members and invitees.')) + '</div>'
        + (canWrite() ? '<div style="margin-top:auto">' + UI.btn('New group', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newgroup' }) + '</div>' : '') + '</div>';

      let page = '', aside = '';
      const demo = st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-demook' })) : '';
      if (!g) {
        page = demo + UI.pagehead('Groups and events', 'Groups in your workspaces, their posts and the calendar', '')
          + UI.empty(st.groups.length ? 'No group selected' : 'No groups yet', st.groups.length ? 'Pick a group on the left, or clear the filters.' : 'Groups live inside one workspace. Create one for a team, a project or a working group; you become its owner.', canWrite() ? UI.btn('New group', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newgroup' }) : '');
        attach(null);
      } else {
        const d = st.det[g.id] || {};
        if ((!d.loaded || d.stale) && !d.loading) { d.stale = false; st.det[g.id] = d; loadGroup(g); }
        attach(readable(g) ? g.id : null);
        const hidden = g.state === 'hidden'; const isMember = !!g.role; const own = isOwner(g); const mod = isMod(g);
        const rd = readable(g);
        const evs = (d.events || []).slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        const posts = d.posts || [];
        const reqs = d.requests || [];
        const invite = st.invites[g.id]; const myReq = st.mineReq[g.id];
        if (st.tab === 'cases' && !mod) st.tab = 'overview';
        const isChan = !!g.parentId;
        if (isChan && (st.tab === 'channels' || st.tab === 'feeds')) st.tab = 'overview';
        const chans = d.channels || [];
        const tabs = UI.tabs([{ id: 'overview', label: 'Overview' }, { id: 'members', label: 'Members', count: g.members || 0 }, { id: 'posts', label: 'Posts', count: posts.filter((x) => x.state !== 'hidden').length }, { id: 'events', label: 'Events', count: evs.filter((e) => e.state !== 'cancelled').length }].concat(isChan ? [] : [{ id: 'channels', label: 'Channels', count: rd ? (d.channels ? chans.length : g.channels || 0) : 0 }, { id: 'feeds', label: 'Feeds' }]).concat(mod ? [{ id: 'cases', label: 'Cases', count: (d.cases || []).filter((c) => c.state === 'open').length }] : []), st.tab);
        let join = '';
        if (!hidden && !isMember && canWrite()) {
          if (myReq) join = UI.pill('request pending', 'info') + UI.btn('Withdraw', { kind: 'ghost', size: 'sm', attrs: 'data-withdrawmine' });
          else if (invite) join = UI.btn('Accept invitation', { kind: 'primary', size: 'sm', attrs: 'data-acceptinvite' }) + UI.btn('Decline', { kind: 'ghost', size: 'sm', attrs: 'data-declineinvite' });
          else if (clears(g.label)) join = UI.btn(g.joinMode === 'open' ? 'Join' : g.joinMode === 'request' ? 'Ask to join' : 'Invite only', { kind: 'primary', size: 'sm', attrs: 'data-join', disabled: g.joinMode === 'invite' });
        }
        const headActions = (!hidden && isMember && st.tab === 'overview' && canWrite() ? UI.btn('Leave', { kind: 'ghost', size: 'sm', attrs: 'data-leave' }) : '') + join + UI.label(g.label);
        const head = UI.pagehead(g.name, (isChan ? 'Channel of <a href="#" data-backparent>' + esc(g.parentName || 'its group') + '</a> · ' : esc(wsName(g.workspaceId)) + ' · ') + (g.categoryId && catName(g.categoryId) ? UI.pill(catName(g.categoryId), 'outline') + ' · ' : '') + visPill(g.visibility) + ' · join: ' + esc(g.joinMode) + ' · ' + (g.members || 0) + ' member' + (g.members === 1 ? '' : 's') + (g.role ? ' · your role: ' + esc(g.role) : g.actingRole ? ' · you manage groups here (acting owner)' : '') + ' · created ' + esc(fmtDay(g.createdAt)), headActions);
        const leaveProblem = st.leaveProblem && st.leaveProblem.groupId === g.id ? UI.problem('Last owner cannot leave', st.leaveProblem.detail, st.leaveProblem.trace) : '';
        const loadingNote = !d.loaded ? UI.notice('Loading…', 'info') : d.error ? UI.problem('Part of this group could not be loaded', d.error.message, (d.error.problem && d.error.problem.trace_id) || false) : '';
        let body = '';

        if (hidden) {
          body = UI.notice('<b>Hidden by moderation.</b> The group is closed to everyone but managers and its owners; its events are left out of calendars and their reminders are not sent. An upheld appeal restores it.', 'warn', App.canOpen('moderation') ? UI.btn('Open in Moderation', { size: 'sm', attrs: 'data-gomoderation' }) : '');
        } else if (st.tab === 'overview') {
          const next = evs.filter(upcoming)[0];
          body = (myReq ? UI.notice('<b>Request sent.</b> Your request to join ' + esc(g.name) + ' is pending; the group\'s moderators were notified. Asking again returns the same request. It expires ' + esc(fmtDay(myReq.expiresAt)) + '.', 'info') : '')
            + (invite ? UI.notice('<b>You are invited</b> to ' + esc(g.name) + ' as ' + esc(invite.role) + '. The invitation expires ' + esc(fmtDay(invite.expiresAt)) + '.', 'info') : '')
            + (st.joinRefused && st.joinRefused.groupId === g.id ? UI.problem(st.joinRefused.title, st.joinRefused.detail, st.joinRefused.trace) : '')
            + leaveProblem + loadingNote
            + (st.uncatNote && st.uncatNote.groupId === g.id ? UI.notice(esc(st.uncatNote.text), 'warn', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-uncatok' })) : '')
            + UI.panel('About', rd ? '<div class="serif" style="font-size:15px;line-height:1.5">' + esc(g.description || 'No description yet.') + '</div>'
              + (isChan ? '' : UI.kv([['Category', g.categoryId ? esc(catName(g.categoryId) || 'a removed category') : 'uncategorised'], ['Place', g.location ? esc(g.location.name || 'a point') + (g.location.lat != null ? ' ' + small(esc(fmtPoint(g.location.lat, g.location.lon))) : '') : 'none']], 2))
              : UI.notice(clears(g.label) ? 'The description, place and content are shown to members only (private group). Join to read them.' : 'The group is labelled ' + esc(g.label) + ', above your clearance of ' + esc(me().clearance) + '. Its content is not shown to you.', 'info'))
            + '<div class="grid3">' + UI.stat(String(g.members || 0), 'members', mod && d.requests ? small(reqs.filter((r) => r.state === 'pending').length + ' pending requests and invitations') : '')
            + UI.stat(rd ? String(evs.filter(upcoming).length) : '–', 'upcoming events', rd ? small('next: ' + esc(next ? next.title : 'none')) : '')
            + UI.stat(rd ? String(posts.filter((x) => x.state !== 'hidden').length) : '–', 'posts', rd && posts[0] ? small('newest ' + esc(fmtWhen(posts[0].createdAt))) : '') + '</div>'
            + (mod ? UI.panel('Settings', '<div class="formgrid" style="--cols:3">' + UI.field('Name', UI.input(g.name, { attrs: 'data-sname', readonly: !own })) + UI.field('Visibility', UI.select(['public', 'private', 'hidden'], g.visibility, 'data-svis' + (own ? '' : ' disabled'))) + UI.field('Join mode', UI.select(['open', 'request', 'invite'], g.joinMode, 'data-sjoin' + (own ? '' : ' disabled')))
              + UI.field('Label', UI.select(isChan ? LABELS.filter((l) => RANK[l] >= RANK[g.parentLabel || 'public']) : LABELS, g.label, 'data-slabel' + (own ? '' : ' disabled')), isChan ? 'At least the group\'s label (' + esc(g.parentLabel || '') + '), at most the workspace ceiling' : 'At most the workspace ceiling' + (wsLabel(g.workspaceId) ? ' (' + esc(wsLabel(g.workspaceId)) + ')' : '') + '; raising it raises every post, event and channel below it and re-checks the sockets in the rooms')
              + (isChan ? '' : UI.field('Category', UI.select([{ value: '', label: 'Uncategorised' }].concat(st.categories.map((c) => ({ value: c.id, label: c.name }))), g.categoryId || '', 'data-scat' + (own ? '' : ' disabled')), 'The tenant\'s list, kept on Social and messaging')
                + UI.field('Place', UI.input(g.location ? g.location.name || '' : '', { attrs: 'data-splace maxlength="200"', placeholder: 'Hamburg office', readonly: !own }))
                + UI.field('Latitude, longitude', UI.input(g.location ? fmtPoint(g.location.lat, g.location.lon) : '', { attrs: 'data-spoint', placeholder: '53.5511, 9.9937', readonly: !own }), 'WGS 84 degrees; both or neither. Shown to readers of the content only')) + '</div>'
              + UI.field('Description', UI.textarea(g.description || '', { rows: 2, attrs: 'data-sdesc' + (own ? '' : ' readonly') }))
              + '<div class="hstack gap6">' + UI.btn('Save', { kind: 'primary', size: 'sm', attrs: 'data-savesettings', disabled: !own || !canWrite() }) + (own && canWrite() ? UI.btn('Delete group', { kind: 'danger', size: 'sm', attrs: 'data-delete' }) : small('Settings are the owner\'s; moderators handle requests, members, posts and events.')) + '</div>') : '')
            + small('Workspace membership is the outer boundary: a member who leaves ' + esc(wsName(g.workspaceId)) + ' loses this group at once, whatever their group role.');
        } else if (st.tab === 'members') {
          const mem = d.members || [];
          const owners = mem.filter((m) => m.role === 'owner').length;
          body = leaveProblem + loadingNote
            + (rd ? UI.panel('Members', UI.table(['Member', 'Account', 'Role', 'Joined', { label: '', srLabel: 'Actions' }], mem.map((m) => {
              const self = m.userId === me().id;
              const acts = canWrite() && (mod || self) ? '<span class="hstack gap6" style="justify-content:flex-end">' + (own && !self ? '<span class="relative">' + UI.btn('Role', { size: 'xs', attrs: 'data-rolemenu="' + esc(m.userId) + '" aria-label="Change the role of ' + esc(m.displayName) + '"' }) + '</span>' : '') + (self ? (isMember ? UI.btn('Leave', { size: 'xs', kind: 'ghost', attrs: 'data-leave' }) : '') : UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-remove="' + esc(m.userId) + '" aria-label="Remove ' + esc(m.displayName) + '"', disabled: !own && m.role !== 'member' })) + '</span>' : '';
              return [who(m.userId, m.displayName) + (self ? ' ' + UI.pill('you', 'accent') : ''), '<span class="mono">' + esc(m.username) + '</span>', rolePill(m.role) + (m.role === 'owner' && owners === 1 ? ' ' + small('only owner') : ''), esc(fmtDay(m.joinedAt)), acts];
            }), { clickable: false, minWidth: '0', emptyTitle: 'No members', emptyText: 'Members appear here once they join.' }), { actions: mod && canWrite() ? UI.btn('Invite', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-invite' }) : '' }) : UI.notice('The member list is shown to readers of the content. Join first.', 'info'))
            + (mod ? UI.panel('Requests and invitations', UI.table(['Kind', 'Person', 'Role', 'State', 'Expires', 'When', { label: '', srLabel: 'Actions' }], reqs.map((r) => [UI.pill(r.kind, r.kind === 'invite' ? 'info' : 'outline'), esc(r.userName || r.userId), esc(r.role), UI.pill(r.state, r.state === 'pending' ? 'warn' : r.state === 'accepted' ? 'ok' : r.state === 'expired' || r.state === 'declined' ? '' : 'outline'), esc(r.state === 'pending' ? fmtDay(r.expiresAt) : ''), esc(fmtWhen(r.createdAt)),
              r.state === 'pending' && canWrite() ? '<span class="hstack gap6" style="justify-content:flex-end">' + (r.kind === 'request' ? UI.btn('Accept', { size: 'xs', kind: 'primary', attrs: 'data-accept="' + esc(r.id) + '"' }) + UI.btn('Decline', { size: 'xs', attrs: 'data-decline="' + esc(r.id) + '"' }) : UI.btn('Withdraw', { size: 'xs', attrs: 'data-withdraw="' + esc(r.id) + '"' })) + '</span>' : r.state === 'expired' && r.kind === 'invite' && canWrite() ? UI.btn('Invite again', { size: 'xs', attrs: 'data-invite="' + esc(r.userId) + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'Nothing pending', emptyText: 'Requests and invitations appear here.' })
              + small('One pending request or invitation per person (409 otherwise). The workspace boundary and label are checked again when a request is accepted (422).')) : '');
        } else if (st.tab === 'posts') {
          body = loadingNote + (rd ? ((isMember && canWrite() ? UI.panel('New notice', UI.textarea(st.draft || '', { rows: 2, placeholder: 'A notice for the group (up to 10,000 characters). Screened at the user-input checkpoint.', attrs: 'data-draft aria-label="New notice"' }) + '<div class="hstack gap6">' + UI.btn('Post', { kind: 'primary', size: 'sm', icon: 'send', attrs: 'data-post' }) + small('A guardrail block refuses the post (422 step guardrails); a redaction is stored redacted.') + '</div>') : UI.notice('Posting needs membership; public groups can be read by everyone in the workspace.', 'info'))
            + (st.postRefused && st.postRefused.groupId === g.id ? UI.problem(st.postRefused.title, st.postRefused.detail, st.postRefused.trace) : '')
            + '<div class="vstack gap12">' + posts.map((x) => '<article class="panel groups-post" aria-label="Post by ' + esc(x.authorName || 'a member') + '"><div class="hstack"><b>' + (x.authorName ? who(x.authorId, x.authorName) : 'Former member') + '</b>' + small(esc(fmtWhen(x.createdAt))) + '<span class="grow"></span>' + UI.label(x.label, { sm: true }) + (x.state === 'hidden' ? UI.pill('hidden', 'warn') : '') + '</div>'
              + (x.state === 'hidden' ? '<div class="groups-tomb">Hidden by a moderator. Shown to moderators only as a tombstone.' + (mod ? ' See the Cases tab.' : '') + '</div>' : '<div class="serif" style="font-size:15px;line-height:1.5;white-space:pre-wrap">' + esc(x.body) + '</div>')
              + '<div class="hstack gap6" style="margin-top:6px">' + ((x.authorId === me().id || mod) && x.state !== 'hidden' && canWrite() ? UI.btn('Delete', { size: 'xs', kind: 'ghost', icon: 'trash', attrs: 'data-delpost="' + esc(x.id) + '"' }) : '') + (x.state !== 'hidden' && App.can('moderation:report') ? UI.btn('Report', { size: 'xs', kind: 'ghost', icon: 'flag', attrs: 'data-report="' + esc(x.id) + '"' }) : '') + '</div></article>').join('')
            + (posts.length || !d.loaded ? '' : UI.empty('No posts yet', 'Notices from members appear here, newest first.')) + '</div>') : UI.notice('Posts are shown to members of a private group. Join to read them.', 'info'));
        } else if (st.tab === 'events') {
          if (st.wantEvent && d.loaded) { const w = evs.find((e) => e.id === st.wantEvent); if (w) { st.eventSel = w.id; st.calY = +w.date.slice(0, 4); st.calM = +w.date.slice(5, 7) - 1; } st.wantEvent = null; }
          if (!st.eventSel || !evs.some((e) => e.id === st.eventSel)) st.eventSel = (evs.find(upcoming) || evs[0] || {}).id || null;
          const ev = evs.find((e) => e.id === st.eventSel) || null;
          const a = ev ? att(ev) : null;
          const mine = ev && ev.myRsvp;
          body = loadingNote + (!rd ? UI.notice('Events are shown to members of a private group. Join to see them.', 'info') : (st.cancelledNote && ev && ev.id === st.cancelledNote.eventId ? UI.notice('<b>' + esc(ev.title) + ' cancelled.</b> ' + (st.cancelledNote.notified != null ? st.cancelledNote.notified + ' attendee' + (st.cancelledNote.notified === 1 ? ' was' : 's were') : 'Every attendee was') + ' (going or maybe) notified in the console (event.cancelled) and by email with the time and a link, never the title or the reason. Its reminders are cancelled. Audited as group.event.cancelled.', 'warn', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearcancel' })) : '')
            + (st.capacityProblem && ev && ev.id === st.capacityProblem.eventId ? UI.problem('Capacity reached', st.capacityProblem.detail, st.capacityProblem.trace) : '')
            + '<div class="cols groups-cols"><div class="grow">' + calendar(st, evs) + '</div></div>'
            + UI.panel('Events', UI.table(['Event', 'When', 'Location', 'Attendance', 'Capacity', 'State', 'Your RSVP'], evs.map((e) => { const x = att(e); return { cells: ['<b>' + esc(e.title) + '</b>' + (e.sequence > 1 ? ' ' + small('rev ' + e.sequence) : ''), esc(whenText(e)), esc(e.location || '') + (e.lat != null ? '<br>' + small(esc(fmtPoint(e.lat, e.lon))) : ''), '<span class="num">' + x.going + '</span> going, <span class="num">' + x.maybe + '</span> maybe' + (x.guests ? ', <span class="num">' + x.guests + '</span> guests' : '') + (x.checkedIn ? ', <span class="num">' + x.checkedIn + '</span> checked in' : ''), e.capacity ? '<span class="num">' + (x.going + x.guests) + ' of ' + e.capacity + '</span>' + (x.going + x.guests >= e.capacity ? ' ' + UI.pill('full', 'danger') : '') : small('unlimited'), e.state === 'cancelled' ? UI.pill('cancelled', 'danger') : e.state === 'hidden' ? UI.pill('hidden', 'warn') : UI.pill('scheduled', 'ok'), e.myRsvp ? UI.pill(e.myRsvp.response, e.myRsvp.response === 'going' ? 'ok' : e.myRsvp.response === 'maybe' ? 'warn' : '') : small('none')], attrs: 'data-event="' + esc(e.id) + '"', selected: e.id === st.eventSel }; }), { minWidth: '820px', emptyTitle: 'No events', emptyText: 'Moderators create events for the group.' }), { actions: mod && canWrite() ? UI.btn('New event', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newevent' }) : '' }));
          if (rd) {
            aside = '<aside class="inspector w360" aria-label="Selected event">' + (ev ? '<div class="hstack"><div class="eyebrow grow">Selected event</div>' + (ev.state === 'cancelled' ? UI.pill('cancelled', 'danger') : UI.label(ev.label, { sm: true })) + '</div><h2 class="groups-title">' + esc(ev.title) + '</h2><div class="fg2">' + esc(whenText(ev)) + '</div>'
              + (ev.description ? '<div class="serif" style="font-size:14px;line-height:1.5;margin:6px 0;white-space:pre-wrap">' + esc(ev.description) + '</div>' : '')
              + UI.kv([['Location', esc(ev.location || 'none given') + (ev.lat != null ? '<br>' + small(esc(fmtPoint(ev.lat, ev.lon)) + ' (for distance filters)') : '')], ['Time zone', '<span class="mono">' + esc(ev.timeZone) + '</span>' + (ev.timeZone !== 'UTC' ? '<br>' + small('stored in UTC; a wall-clock time that occurs twice takes the earlier instant') : '')], ['Capacity', ev.capacity ? (a.going + a.guests) + ' of ' + ev.capacity + ' (people with guests)' : 'unlimited'], ['Guests', ev.maxGuests ? 'up to ' + ev.maxGuests + ' each' : 'none'], ['Reminders', (ev.reminders || []).length ? ev.reminders.map(remText).join(', ') + ' before' : 'none'], ['Attendance', a.going + ' going, ' + a.maybe + ' maybe, ' + a.guests + ' guests, ' + a.checkedIn + ' checked in'], ['Revision', 'sequence ' + ev.sequence]], 1)
              + (ev.state === 'cancelled' ? UI.notice('Cancelled: ' + esc(ev.cancelReason || 'no reason given') + '.' + (st.notified[ev.id] != null ? ' ' + st.notified[ev.id] + ' attendee' + (st.notified[ev.id] === 1 ? '' : 's') + ' notified.' : ''), 'warn')
                : canWrite() && (isMember || g.visibility === 'public') && Date.parse(ev.endsAt) >= Date.now() ? '<div class="eyebrow" style="margin-top:8px" id="groups-rsvp-l">Your RSVP</div>' + UI.seg([{ id: 'going', label: 'Going' }, { id: 'maybe', label: 'Maybe' }, { id: 'declined', label: 'Declined' }], mine ? mine.response : '', 'data-rsvp aria-labelledby="groups-rsvp-l"') + (ev.maxGuests ? UI.field('Guests', UI.select(Array.from({ length: ev.maxGuests + 1 }, (_, i) => String(i)), String(st.myGuests != null ? st.myGuests : mine ? mine.guests : 0), 'data-guests')) : '') : '')
              + '<div class="vstack gap6" style="margin-top:10px">' + UI.btn('Attendees', { attrs: 'data-attendees' }) + (mod ? UI.btn('Reminders', { attrs: 'data-reminders' }) : '') + (mod && canWrite() && ev.state === 'scheduled' ? UI.btn('Edit', { attrs: 'data-editevent' }) + UI.btn('Cancel event', { kind: 'danger', attrs: 'data-cancelevent' }) : '') + (canWrite() ? UI.btn('Calendar feed for this event', { kind: 'ghost', attrs: 'data-eventfeed' }) : '') + '</div>' : UI.empty('No event selected', 'Pick one in the calendar or the list.')) + '</aside>';
          }
        } else if (st.tab === 'channels') {
          body = loadingNote + (st.floorProblem && st.floorProblem.groupId === g.id ? UI.problem(st.floorProblem.title, st.floorProblem.detail, st.floorProblem.trace) : '')
            + (rd ? UI.panel('Channels', UI.table(['Channel', 'Visibility', 'Join mode', 'Label', { label: 'Members', right: true }, 'Your role'], chans.map((c) => ({ cells: ['<b>' + esc(c.name) + '</b>' + (c.description ? '<div class="muted" style="font-size:12px">' + esc(c.description) + '</div>' : ''), visPill(c.visibility), esc(c.joinMode), UI.label(c.label, { sm: true }), '<span class="num">' + (c.members || 0) + '</span>', c.role ? rolePill(c.role) : small(c.actingRole === 'owner' ? 'acting owner' : 'not a member')], attrs: 'data-channel="' + esc(c.id) + '" tabindex="0" aria-label="Open the channel ' + esc(c.name) + '"' })), { minWidth: '640px', emptyTitle: 'No channels yet', emptyText: 'Owners and moderators split a group into channels, each with its own members and posts.' })
              + small('A channel has its own members, roles, posts and events. Only members of ' + esc(g.name) + ' join it; leaving the group leaves its channels. A public channel is read by everyone who reads the group, a private one by its members, a hidden one is known only to them. Its label is never below the group\'s.'), { actions: mod && canWrite() && g.state === 'active' ? UI.btn('New channel', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newchannel' }) : '' }) : UI.notice('Channels are shown to readers of the group. Join first.', 'info'));
        } else if (st.tab === 'feeds') {
          const feeds = st.feeds || [];
          body = UI.notice('<b>Feed URLs are public links.</b> No session or cookie: the signature in the URL is an HMAC over the feed\'s id, tenant, owner, kind and target. The feed is rendered as you at every fetch (workspace, group and clearance). Events above the feed\'s label limit (internal by default) appear as <span class="mono">Busy (confidential)</span> without details. Revoking makes the link a 404.', 'info')
            + UI.panel('Your calendar feeds', UI.table(['Kind', 'Target', 'URL', 'Created', 'Last used', 'State', { label: '', srLabel: 'Actions' }], feeds.map((f) => [UI.pill(f.kind, 'outline'), esc(f.name), f.url ? '<span class="mono" style="font-size:12px;overflow-wrap:anywhere">' + esc(f.url) + '</span>' : small('withdrawn'), esc(fmtDay(f.createdAt)), esc(f.lastUsedAt ? fmtWhen(f.lastUsedAt) : 'never'), f.revokedAt ? UI.pill('revoked ' + fmtDay(f.revokedAt), 'danger') : UI.pill('active', 'ok'), f.revokedAt || !canWrite() ? '' : '<span class="hstack gap6" style="justify-content:flex-end">' + UI.btn('Copy', { size: 'xs', attrs: 'data-copyurl="' + esc(f.id) + '" aria-label="Copy the URL of ' + esc(f.name) + '"' }) + UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-revokefeed="' + esc(f.id) + '" aria-label="Revoke ' + esc(f.name) + '"' }) + '</span>']), { clickable: false, minWidth: '0', emptyTitle: 'No feeds yet', emptyText: 'Create a feed to follow your events in a calendar app.' }), { actions: canWrite() ? UI.btn('New feed', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newfeed' }) : '' })
            + small('A user feed covers the last 30 days and the next year, cancelled events as STATUS:CANCELLED. Rate-limited per address.');
        } else if (st.tab === 'cases') {
          const cs = d.cases || [];
          body = loadingNote + UI.panel('Cases on this group\'s content', UI.table(['Flag', 'Kind', 'Object', 'Rule', 'Severity', 'State', 'Due', { label: '', srLabel: 'Actions' }], cs.map((c) => ['<span class="mono">' + esc(c.ref) + '</span>', UI.pill(c.kind, 'outline'), '<span class="mono">' + esc(c.objectType + ' ' + c.objectId) + '</span>', esc(c.ruleName || ''), UI.pill(c.severity, c.severity === 'high' ? 'danger' : c.severity === 'medium' ? 'warn' : ''), UI.pill(c.state, c.state === 'open' ? 'warn' : ''), esc(fmtWhen(c.dueAt)), '<span class="hstack gap6" style="justify-content:flex-end">' + (App.canOpen('flags') ? UI.btn('Open in Flags', { size: 'xs', attrs: 'data-openflag="' + esc(c.ref) + '"' }) : '') + (App.canOpen('moderation') ? UI.btn('Moderation', { size: 'xs', kind: 'ghost', attrs: 'data-gomoderation' }) : '') + '</span>']), { clickable: false, minWidth: '0', emptyTitle: 'No cases', emptyText: 'Reports and moderation checks on posts, events and the group itself appear here.' }))
            + small('Group content is moderated with three object types: group-post (hidden posts shown to nobody but moderators), group (a hidden group is closed to everyone but managers and owners) and group-event (left out of calendars, reminders not sent).');
        }
        page = demo + head + tabs + body;
      }

      root.innerHTML = '<style>' + '#main .groups-who{color:inherit;text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:2px}'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .groups-title{font-size:16px;font-weight:600;margin:4px 0 2px}'
        + '#main .groups-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px}'
        + '#main .groups-head{margin-bottom:2px}'
        + '#main .groups-prev svg{transform:rotate(180deg)}'
        + '#main .groups-dow{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:2px 4px;overflow:hidden}'
        + '#main .groups-day{min-height:64px;min-width:0;border:1px solid var(--line);border-radius:4px;padding:2px 4px;background:var(--panel)}'
        + '#main .groups-day.pad{border-color:transparent;background:transparent}'
        + '#main .groups-day.today{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}'
        + '#main .groups-day .n{font-size:11px;color:var(--muted);text-align:right}'
        + '#main .groups-ev{display:block;width:100%;min-height:24px;text-align:left;border:0;border-radius:3px;padding:4px;margin-top:2px;font:inherit;font-size:11px;line-height:16px;background:var(--accent-tint);color:var(--fg);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        + '#main .groups-ev.on{outline:2px solid var(--accent)}#main .groups-ev.cancelled{background:var(--danger-bg);color:var(--danger-fg);text-decoration:line-through}'
        + '#main .groups-post .hstack{gap:8px}#main .groups-tomb{display:inline-block;padding:6px 10px;background:var(--sel);color:var(--fg2);font-size:13px;border-radius:4px}'
        + '#main .inspector .kv .v{overflow-wrap:anywhere}'
        + '</style>'
        + left + '<div class="page">' + page + '</div>' + aside;

      const g2 = g;
      const det = g ? st.det[g.id] || {} : {};
      const evById = (id) => (det.events || []).find((e) => e.id === id);
      const fail = (what) => (err) => App.fail(err, what);
      const after = (gid) => { if (gid) { const d = st.det[gid]; if (d) d.stale = true; } load(true); };

      // ---- list, filters, tabs ----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; st.capacityProblem = null; ctx.rerender(); });
      ctx.on('click', '[data-modeseg] [data-seg]', (e, t) => { st.mode = t.dataset.seg; st.sel = null; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; ctx.rerender(); });
      ctx.on('click', '[data-fws]', (e, t) => menu(ctx, t, [['all', 'Any workspace']].concat(wsList.map((w) => [w.id, w.name])), st.fws, (v) => { st.fws = v; ctx.rerender(); }));
      ctx.on('click', '[data-fvis]', (e, t) => menu(ctx, t, [['all', 'Any visibility'], ['public', 'Public'], ['private', 'Private'], ['hidden', 'Hidden']], st.fvis, (v) => { st.fvis = v; ctx.rerender(); }));
      ctx.on('click', '[data-fjoin]', (e, t) => menu(ctx, t, [['all', 'Any join mode'], ['open', 'Open'], ['request', 'Request'], ['invite', 'Invite']], st.fjoin, (v) => { st.fjoin = v; ctx.rerender(); }));
      ctx.on('click', '[data-group]', (e, t) => { st.sel = t.dataset.group; if (st.tab === 'cases') st.tab = 'overview'; st.joinRefused = null; st.leaveProblem = null; st.capacityProblem = null; st.cancelledNote = null; st.postRefused = null; st.floorProblem = null; st.eventSel = null; st.myGuests = null; ctx.rerender(); });
      // 1.6.0: the category and distance filters ask the server again (B-4403, B-4405).
      ctx.on('click', '[data-fcat]', (e, t) => menu(ctx, t, [['all', 'Any category']].concat(st.categories.map((c) => [c.id, c.name])).concat([['none', 'Uncategorised']]), st.fcat, (v) => { st.fcat = v; st.sel = null; load(true); }));
      ctx.on('click', '[data-fnear]', () => nearModal(ctx, load));
      ctx.on('click', '[data-uncatok]', () => { st.uncatNote = null; ctx.rerender(); });
      ctx.on('click', '[data-demook]', () => { st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-gomoderation]', () => ctx.navigate('moderation'));
      ctx.on('click', '[data-openflag]', (e, t) => { e.preventDefault(); ctx.navigate('flags', { id: t.dataset.openflag }); });
      ctx.on('click', '[data-newgroup]', () => newGroupModal(ctx, load));
      if (st.openNew) { st.openNew = false; if (canWrite()) setTimeout(() => newGroupModal(ctx, load), 50); }
      if (!g2) return;

      // ---- channels (B-4401) ----
      const openChannel = (id) => { const c = (det.channels || []).find((x) => x.id === id); if (!c) return; st.chans[c.id] = c; st.sel = c.id; st.tab = 'overview'; st.floorProblem = null; st.eventSel = null; ctx.rerender(); };
      ctx.on('click', '[data-channel]', (e, t) => openChannel(t.dataset.channel));
      ctx.on('keydown', '[data-channel]', (e, t) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChannel(t.dataset.channel); } });
      ctx.on('click', '[data-backparent]', (e) => { e.preventDefault(); if (!g2.parentId) return; st.sel = g2.parentId; st.tab = 'channels'; if (!byId(g2.parentId)) App.get('/api/groups/' + enc(g2.parentId)).then((v) => { st.chans[v.id] = v; ctx.rerender(); }).catch(fail('Group not loaded')); ctx.rerender(); });
      ctx.on('click', '[data-newchannel]', () => channelModal(ctx, g2, (c) => { st.floorProblem = null; st.chans[c.id] = c; ctx.toast(esc(c.name) + ' created; you are its owner. Audited as group.channel.created.', 'ok'); after(g2.id); }, (err) => { if (err.status === 422 && err.problem && err.problem.step === 'label-floor') { st.floorProblem = { groupId: g2.id, title: err.problem.title || 'Label below the group\'s', detail: err.problem.detail || err.message, trace: err.problem.trace_id || false }; ctx.rerender(); } else App.fail(err, 'Channel not created'); }));

      // ---- join, leave, invitations, settings ----
      ctx.on('click', '[data-join]', async () => {
        if (g2.joinMode === 'open') {
          const ok = await ctx.confirm({ title: 'Join ' + g2.name, tag: 'open group', tone: 'info', body: '<p style="margin:0" class="fg2">You become a member at once and can post, RSVP and read the content. The group\'s label is ' + esc(g2.label) + '.</p>', ok: 'Join' });
          if (!ok) return;
        }
        try {
          const r = await App.post('/api/groups/' + enc(g2.id) + '/join');
          st.joinRefused = null;
          if (r && r.joined) { st.mode = 'mine'; ctx.toast('Joined ' + esc(g2.name) + ' as ' + esc(r.role) + '.', 'ok'); }
          else ctx.toast('Request sent. The moderators of ' + esc(g2.name) + ' were notified.', 'ok');
          after(g2.id);
        } catch (err) {
          if (err.status === 403 || err.status === 409 || err.status === 422) { st.joinRefused = { groupId: g2.id, title: err.problem.title || 'Not joined', detail: err.problem.detail || err.message, trace: err.problem.trace_id || false }; ctx.rerender(); }
          else App.fail(err, 'Not joined');
        }
      });
      ctx.on('click', '[data-withdrawmine]', () => { const r = st.mineReq[g2.id]; if (!r) return; App.del('/api/group-requests/' + enc(r.id)).then(() => { ctx.toast('Request withdrawn.'); after(g2.id); }).catch(fail('Not withdrawn')); });
      ctx.on('click', '[data-acceptinvite]', () => { const r = st.invites[g2.id]; if (!r) return; App.post('/api/group-requests/' + enc(r.id) + '/accept').then(() => { st.mode = 'mine'; ctx.toast('Invitation accepted. You are now a ' + esc(r.role) + ' of ' + esc(g2.name) + '.', 'ok'); after(g2.id); }).catch(fail('Not accepted')); });
      ctx.on('click', '[data-declineinvite]', () => { const r = st.invites[g2.id]; if (!r) return; App.post('/api/group-requests/' + enc(r.id) + '/decline').then(() => { ctx.toast('Invitation declined.'); after(g2.id); }).catch(fail('Not declined')); });
      ctx.on('click', '[data-leave]', async () => {
        const ok = await ctx.confirm({ title: 'Leave ' + g2.name, tag: 'closes the room', tone: 'danger', body: '<p style="margin:0" class="fg2">You stop seeing its content and events; your sockets leave the group\'s room at once. ' + (g2.joinMode !== 'open' ? 'Rejoining needs ' + (g2.joinMode === 'request' ? 'a new request' : 'an invitation') + '.' : '') + '</p>', ok: 'Leave' });
        if (!ok) return;
        try { await App.del('/api/groups/' + enc(g2.id) + '/members/' + enc(me().id)); st.leaveProblem = null; ctx.toast('You left ' + esc(g2.name) + '.'); after(g2.id); }
        catch (err) { if (err.status === 409) { st.leaveProblem = { groupId: g2.id, detail: err.problem.detail || err.message, trace: err.problem.trace_id || false }; ctx.rerender(); } else App.fail(err, 'Not left'); }
      });
      ctx.on('click', '[data-delete]', async () => {
        const ok = await ctx.confirm({ title: 'Delete ' + g2.name, tag: 'cannot be undone', tone: 'danger', body: '<p style="margin:0" class="fg2">The group is deleted, pending requests are cancelled and event reminders stop. Posts and events go with it. Audited as group.deleted.</p>', kv: [['Members', String(g2.members || 0)], ['Events', String((det.events || []).length)]], ok: 'Delete group' });
        if (!ok) return;
        App.del('/api/groups/' + enc(g2.id)).then(() => { st.sel = null; ctx.toast(esc(g2.name) + ' deleted.', 'warn'); load(true); }).catch(fail('Not deleted'));
      });
      ctx.on('click', '[data-savesettings]', () => {
        const body = { name: ctx.$('[data-sname]').value.trim() || g2.name, visibility: ctx.$('[data-svis]').value, joinMode: ctx.$('[data-sjoin]').value, label: ctx.$('[data-slabel]').value, description: ctx.$('[data-sdesc]').value.trim() || null };
        if (!g2.parentId) {
          // B-4403, B-4405: the category and the place (a name, a point, or both).
          body.categoryId = ctx.$('[data-scat]').value || null;
          const pt = parsePoint(ctx.$('[data-spoint]').value); const pn = ctx.$('[data-splace]').value.trim();
          if (pt === false) { ctx.toast('A place is a latitude (−90 to 90) and a longitude (−180 to 180), separated by a comma.', 'warn'); return; }
          body.location = pt || pn ? Object.assign({ name: pn || null }, pt || { lat: null, lon: null }) : null;
        }
        const raised = RANK[body.label] > RANK[g2.label];
        App.patch('/api/groups/' + enc(g2.id), body).then((v) => { if (g2.parentId) st.chans[v.id] = Object.assign({}, st.chans[v.id], v); ctx.toast('Settings saved.' + (raised ? ' Posts and events raised to ' + esc(body.label) + (g2.parentId ? '' : ', with the channels below it') + '; everyone in the room is checked again.' : '') + ' Audited as group.updated.', 'ok'); after(g2.id); }).catch(fail('Not saved'));
      });

      // ---- members, requests ----
      ctx.on('click', '[data-rolemenu]', (e, t) => {
        const uid = t.dataset.rolemenu; const m = (det.members || []).find((x) => x.userId === uid); if (!m) return;
        menu(ctx, t, [['owner', 'Owner'], ['moderator', 'Moderator'], ['member', 'Member']], m.role, (v) => {
          if (v === m.role) return;
          App.patch('/api/groups/' + enc(g2.id) + '/members/' + enc(uid), { role: v }).then(() => { ctx.toast(esc(m.displayName) + ' is now ' + esc(v) + '. Audited as group.member.role.', 'ok'); after(g2.id); })
            .catch((err) => { if (err.status === 409) { st.leaveProblem = { groupId: g2.id, detail: err.problem.detail || err.message, trace: err.problem.trace_id || false }; ctx.rerender(); } else App.fail(err, 'Role not changed'); });
        });
      });
      ctx.on('click', '[data-remove]', async (e, t) => {
        const m = (det.members || []).find((x) => x.userId === t.dataset.remove); if (!m) return;
        const ok = await ctx.confirm({ title: 'Remove ' + m.displayName, tone: 'danger', body: '<p style="margin:0" class="fg2">Removed from the group at once; their sockets leave the room. They can ask to join again.</p>', ok: 'Remove' });
        if (!ok) return;
        App.del('/api/groups/' + enc(g2.id) + '/members/' + enc(m.userId)).then(() => { ctx.toast(esc(m.displayName) + ' removed. Event group.member.removed.'); after(g2.id); }).catch(fail('Not removed'));
      });
      ctx.on('click', '[data-invite]', (e, t) => inviteModal(ctx, g2, t.dataset.invite || null, () => after(g2.id)));
      ctx.on('click', '[data-accept]', (e, t) => App.post('/api/group-requests/' + enc(t.dataset.accept) + '/accept').then((r) => { ctx.toast(esc(r.userName || 'The requester') + ' is now a member. Event group.member.added.', 'ok'); after(g2.id); }).catch(fail('Not accepted')));
      ctx.on('click', '[data-decline]', (e, t) => App.post('/api/group-requests/' + enc(t.dataset.decline) + '/decline').then(() => { ctx.toast('Request declined.'); after(g2.id); }).catch(fail('Not declined')));
      ctx.on('click', '[data-withdraw]', (e, t) => App.del('/api/group-requests/' + enc(t.dataset.withdraw)).then(() => { ctx.toast('Invitation withdrawn.'); after(g2.id); }).catch(fail('Not withdrawn')));

      // ---- posts ----
      ctx.on('input', '[data-draft]', (e, t) => { st.draft = t.value; });
      ctx.on('click', '[data-post]', () => {
        const text = (st.draft || '').trim(); if (!text) { ctx.toast('Write something first.', 'warn'); return; }
        App.post('/api/groups/' + enc(g2.id) + '/posts', { body: text }).then(() => { st.draft = ''; st.postRefused = null; ctx.toast('Posted. Members in the room get group.post.created.', 'ok'); after(g2.id); })
          .catch((err) => { if (err.status === 422) { st.postRefused = { groupId: g2.id, title: err.problem.title || 'Post refused', detail: err.problem.detail || err.message, trace: err.problem.trace_id || false }; ctx.rerender(); } else App.fail(err, 'Not posted'); });
      });
      ctx.on('click', '[data-delpost]', async (e, t) => {
        const ok = await ctx.confirm({ title: 'Delete post', tone: 'danger', body: '<p style="margin:0" class="fg2">Removes the notice for everyone. Audited as group.post.deleted.</p>', ok: 'Delete' });
        if (!ok) return;
        App.del('/api/group-posts/' + enc(t.dataset.delpost)).then(() => { ctx.toast('Post deleted.'); after(g2.id); }).catch(fail('Not deleted'));
      });
      ctx.on('click', '[data-report]', (e, t) => {
        const postId = t.dataset.report;
        ctx.modal({ title: 'Report this post', body: UI.field('Reason', UI.select(['Harassment', 'Spam', 'Sensitive data', 'Wrong or unsupported figure', 'Other'], 'Sensitive data', 'data-rreason')) + UI.field('Note', UI.textarea('', { rows: 2, attrs: 'data-rnote' })) + UI.notice('Files a report flag (type group-post) in ' + esc(wsName(g2.workspaceId)) + '\'s queue. Reporting the same post again while it is open returns the same flag.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Report', { kind: 'primary', attrs: 'data-doreport' }),
          onMount(m) { m.querySelector('[data-doreport]').addEventListener('click', () => {
            const note = m.querySelector('[data-rnote]').value.trim();
            App.post('/api/moderation/reports', Object.assign({ type: 'group-post', id: postId, reason: m.querySelector('[data-rreason]').value }, note ? { note } : {})).then((r) => { App.closeOverlay(); ctx.toast(r.duplicate ? 'You reported this post already; ' + esc(r.flag.ref) + ' is still open.' : 'Reported as ' + esc(r.flag.ref) + '. Audited as moderation.reported.', 'ok'); after(g2.id); }).catch(fail('Not reported'));
          }); } });
      });

      // ---- events ----
      ctx.on('click', '[data-event]', (e, t) => { st.eventSel = t.dataset.event; st.capacityProblem = null; st.myGuests = null; ctx.rerender(); });
      ctx.on('click', '[data-cal]', (e, t) => { st.calM += +t.dataset.cal; if (st.calM < 0) { st.calM = 11; st.calY -= 1; } if (st.calM > 11) { st.calM = 0; st.calY += 1; } ctx.rerender(); });
      ctx.on('click', '[data-clearcancel]', () => { st.cancelledNote = null; ctx.rerender(); });
      ctx.on('change', '[data-guests]', (e, t) => { st.myGuests = +t.value; });
      ctx.on('click', '[data-rsvp] [data-seg]', (e, t) => {
        const ev = evById(st.eventSel); if (!ev) return;
        const response = t.dataset.seg; const gs = ctx.$('[data-guests]'); const guests = response === 'going' && gs ? +gs.value : 0;
        App.post('/api/calendar/events/' + enc(ev.id) + '/rsvp', ev.maxGuests ? { response, guests } : { response }).then(() => { st.capacityProblem = null; ctx.toast('RSVP: ' + esc(response) + (guests ? ' with ' + guests + ' guest' + (guests === 1 ? '' : 's') : '') + '. Event group.event.rsvp.', 'ok'); after(g2.id); })
          .catch((err) => { if (err.status === 409 && err.problem && err.problem.left != null) { st.capacityProblem = { eventId: ev.id, detail: (err.problem.detail || 'The event is full.') + ' Places left: ' + err.problem.left + '. You can answer maybe or declined, or ask a moderator to raise the capacity.', trace: err.problem.trace_id || false }; ctx.rerender(); } else App.fail(err, 'RSVP not recorded'); });
      });
      ctx.on('click', '[data-attendees]', () => {
        const ev = evById(st.eventSel); if (!ev) return;
        App.get('/api/calendar/events/' + enc(ev.id) + '/attendees').then((list) => {
          const canCheck = isMod(g2) && canWrite() && ev.state === 'scheduled';
          const a = att(ev);
          ctx.drawer({ title: 'Attendees: ' + esc(ev.title),
            body: small(isMod(g2) ? 'Moderators see declined answers and check people in. Someone checked in without an RSVP is added as going.' : 'Readers see who is going or maybe.')
              + UI.table(['Person', 'RSVP', 'Guests'].concat(isMod(g2) ? ['Checked in'] : []), list.map((x) => [esc(x.displayName), UI.pill(x.response, x.response === 'going' ? 'ok' : x.response === 'maybe' ? 'warn' : ''), '<span class="num">' + (x.guests || 0) + '</span>'].concat(isMod(g2) ? [canCheck ? UI.toggle(x.checkedIn ? 'yes' : 'no', !!x.checkedIn, 'data-manual="1" data-checkin="' + esc(x.userId) + '" aria-label="' + esc(x.displayName) + ' checked in"') : esc(x.checkedIn ? 'yes' : 'no')] : [])), { clickable: false, minWidth: '0', emptyTitle: 'No answers yet', emptyText: 'People who answer going, maybe or declined appear here.' })
              + '<div style="margin-top:8px">' + small((a.going + a.guests) + ' going including guests, ' + a.maybe + ' maybe, ' + a.checkedIn + ' checked in.') + '</div>',
            actions: UI.btn('Close', { attrs: 'data-close' }),
            onMount(dr) { dr.querySelectorAll('[data-checkin]').forEach((b) => b.addEventListener('click', () => {
              const want = !b.classList.contains('on'); const who = list.find((x) => x.userId === b.dataset.checkin);
              App.post('/api/calendar/events/' + enc(ev.id) + '/check-in', { userId: b.dataset.checkin, checkedIn: want }).then(() => {
                b.classList.toggle('on', want); b.setAttribute('aria-checked', want ? 'true' : 'false'); b.querySelector('span:last-child').textContent = want ? 'yes' : 'no';
                ctx.toast(esc(who ? who.displayName : 'Attendee') + (want ? ' checked in.' : ' check-in removed.'), 'ok'); if (st.det[g2.id]) st.det[g2.id].stale = true;
              }).catch(fail('Check-in not recorded'));
            })); },
            onClose() { if (st.det[g2.id] && st.det[g2.id].stale) load(true); } });
        }).catch(fail('Attendees not loaded'));
      });
      ctx.on('click', '[data-reminders]', () => {
        const ev = evById(st.eventSel); if (!ev) return;
        App.get('/api/calendar/events/' + enc(ev.id) + '/reminders').then((rs) => ctx.drawer({ title: 'Reminders: ' + esc(ev.title),
          body: small('Each offset is a row and a calendar.reminder job at its time; the row moves scheduled, sending, sent with a compare-and-set, so a retried job never sends twice. Attendees who can still read the event are notified in the console and by email.')
            + UI.table(['Before', 'Fires at', 'State', { label: 'Recipients', right: true }, 'Sent'], rs.map((r) => [esc(remText(r.minutesBefore)), esc(fmtWhen(Date.parse(r.fireAt))), UI.pill(r.state, r.state === 'sent' ? 'ok' : r.state === 'scheduled' ? 'info' : r.state === 'cancelled' || r.state === 'skipped' ? '' : 'warn'), '<span class="num">' + (r.recipients == null ? '' : r.recipients) + '</span>', esc(r.sentAt ? fmtWhen(r.sentAt) : '')]), { clickable: false, minWidth: '0', emptyTitle: 'No reminders', emptyText: 'Add offsets when editing the event.' }),
          actions: UI.btn('Close', { attrs: 'data-close' }) })).catch(fail('Reminders not loaded'));
      });
      ctx.on('click', '[data-cancelevent]', async () => {
        const ev = evById(st.eventSel); if (!ev) return;
        const a = att(ev);
        const v = await confirmWith(ctx, { title: 'Cancel ' + ev.title, tag: 'notifies ' + (a.going + a.maybe) + ' attendee' + (a.going + a.maybe === 1 ? '' : 's'), tone: 'danger', body: '<p style="margin:0" class="fg2">Stops the reminders and notifies every attendee (going or maybe) in the console and by email with the time and a link, never the title or the reason. The event stays listed as cancelled and appears as STATUS:CANCELLED in feeds.</p>' + UI.field('Reason (kept with the event, not sent)', UI.input('', { attrs: 'data-creason' })), kv: [['Event', esc(ev.title)], ['When', esc(whenText(ev))]], ok: 'Cancel event', cancel: 'Keep it' }, ['data-creason']);
        if (!v) return;
        const reason = (v['data-creason'] || '').trim();
        App.post('/api/calendar/events/' + enc(ev.id) + '/cancel', reason ? { reason } : {}).then((r) => {
          st.notified[ev.id] = r.notified; st.cancelledNote = { eventId: ev.id, notified: r.notified };
          ctx.toast(esc(ev.title) + ' cancelled; ' + r.notified + ' attendee' + (r.notified === 1 ? '' : 's') + ' notified.', 'warn'); after(g2.id);
        }).catch(fail('Not cancelled'));
      });
      ctx.on('click', '[data-editevent]', () => eventModal(ctx, g2, evById(st.eventSel), () => after(g2.id)));
      ctx.on('click', '[data-newevent]', () => eventModal(ctx, g2, null, (ev) => { st.eventSel = ev.id; const n = norm(ev); if (n.date) { st.calY = +n.date.slice(0, 4); st.calM = +n.date.slice(5, 7) - 1; } after(g2.id); }));
      if (st.openNewEvent) { st.openNewEvent = false; if (isMod(g2) && canWrite() && readable(g2)) setTimeout(() => eventModal(ctx, g2, null, (ev) => { st.eventSel = ev.id; after(g2.id); }), 50); }
      ctx.on('click', '[data-eventfeed]', () => {
        const ev = evById(st.eventSel); if (!ev) return;
        App.post('/api/calendar/feeds', { kind: 'event', targetId: ev.id }).then(() => { st.tab = 'feeds'; ctx.toast('Feed created. Copy the URL into your calendar app. Audited as calendar.feed.created.', 'ok', 5000); load(true); }).catch(fail('Feed not created'));
      });

      // ---- feeds ----
      ctx.on('click', '[data-copyurl]', (e, t) => {
        const f = (st.feeds || []).find((x) => x.id === t.dataset.copyurl); if (!f || !f.url) return;
        const nope = () => ctx.toast('Copy the URL from the table; the clipboard is not available here.', 'warn');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(f.url).then(() => ctx.toast('Copied the feed URL for ' + esc(f.name) + '.', 'ok'), nope);
        else nope();
      });
      ctx.on('click', '[data-newfeed]', () => {
        const evs = (det.events || []).filter((x) => x.state !== 'hidden');
        const kinds = [{ value: 'user', label: 'My calendar (my groups and RSVPs)' }].concat(readable(g2) ? [{ value: 'group', label: 'Group: ' + g2.name }] : []).concat(readable(g2) && evs.length ? [{ value: 'event', label: 'One event of ' + g2.name }] : []);
        ctx.modal({ title: 'New calendar feed', body: UI.field('Kind', UI.select(kinds, readable(g2) ? 'group' : 'user', 'data-fkind')) + (evs.length ? '<div data-fevwrap hidden>' + UI.field('Event', UI.select(evs.map((x) => ({ value: x.id, label: x.title + ', ' + fmtDate(x.date) })), st.eventSel || evs[0].id, 'data-fevent')) + '</div>' : '') + UI.notice('The URL carries the signature. Anyone with it reads the feed as you, within your clearance and the feed label limit. Revoke it if it leaks.', 'warn'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-dofeed' }),
          onMount(m) {
            const kind = m.querySelector('[data-fkind]'); const wrap = m.querySelector('[data-fevwrap]');
            kind.addEventListener('change', () => { if (wrap) wrap.hidden = kind.value !== 'event'; });
            m.querySelector('[data-dofeed]').addEventListener('click', () => {
              const k = kind.value; const body = { kind: k }; if (k === 'group') body.targetId = g2.id; if (k === 'event') body.targetId = m.querySelector('[data-fevent]').value;
              App.post('/api/calendar/feeds', body).then(() => { App.closeOverlay(); ctx.toast('Feed created. Audited as calendar.feed.created.', 'ok'); load(true); }).catch(fail('Feed not created'));
            });
          } });
      });
      ctx.on('click', '[data-revokefeed]', async (e, t) => {
        const f = (st.feeds || []).find((x) => x.id === t.dataset.revokefeed); if (!f) return;
        const ok = await ctx.confirm({ title: 'Revoke feed', tone: 'danger', body: '<p style="margin:0" class="fg2">The link answers 404 from now on, the same as an unknown feed. Calendar apps using it stop updating.</p>', kv: [['Kind', esc(f.kind)], ['Target', esc(f.name)], ['Last used', esc(f.lastUsedAt ? fmtWhen(f.lastUsedAt) : 'never')]], ok: 'Revoke' });
        if (!ok) return;
        App.del('/api/calendar/feeds/' + enc(f.id)).then(() => { ctx.toast('Feed revoked. Audited as calendar.feed.revoked.'); load(true); }).catch(fail('Not revoked'));
      });
    }
  });

  /** Shows a design state's case on the caller's real groups, or a note that none of them is in it. */
  function resolveState(st, kind) {
    const gs = st.groups || [];
    const findEvent = (pred) => { let hit = null; gs.forEach((g) => { const d = st.det[g.id]; ((d && d.events) || []).forEach((e) => { if (!hit && pred(e)) hit = { g, e }; }); }); return hit; };
    const showEvent = (hit) => { st.sel = hit.g.id; st.mode = hit.g.role ? 'mine' : 'discover'; st.tab = 'events'; st.eventSel = hit.e.id; st.calY = +hit.e.date.slice(0, 4); st.calM = +hit.e.date.slice(5, 7) - 1; };
    if (kind === 'request') {
      const g = gs.find((x) => st.mineReq[x.id]) || gs.find((x) => x.joinMode === 'request' && !x.role && x.state !== 'hidden');
      if (g) { st.mode = 'discover'; st.sel = g.id; st.tab = 'overview'; if (!st.mineReq[g.id]) st.demoNote = g.name + ' admits people by request. Ask to join sends a request (202) and notifies its moderators; asking again returns the same request.'; }
      else st.demoNote = 'No group you can see asks for a request to join. In a request-mode group, Ask to join answers 202 with the pending request and notifies its moderators; asking again returns the same request.';
    } else if (kind === 'capacity') {
      const hit = findEvent((e) => e.capacity && e.state === 'scheduled' && att(e).going + att(e).guests >= e.capacity);
      if (hit) { showEvent(hit); st.capacityProblem = { eventId: hit.e.id, detail: hit.e.title + ' takes ' + hit.e.capacity + ' people including guests and ' + (att(hit.e).going + att(hit.e).guests) + ' are going. An RSVP of going is refused with 409 and left: 0; you can answer maybe or declined, or ask a moderator to raise the capacity.', trace: false }; }
      else st.demoNote = 'No event you can see is full. Capacity counts people with their guests; an RSVP of going past it is refused with 409 and the places left.';
    } else if (kind === 'cancelled') {
      const hit = findEvent((e) => e.state === 'cancelled');
      if (hit) { showEvent(hit); st.cancelledNote = { eventId: hit.e.id, notified: st.notified[hit.e.id] }; }
      else st.demoNote = 'No event you can see has been cancelled. Cancelling stops its reminders and notifies every attendee (going or maybe) in the console and by email, without the title or the reason.';
    } else if (kind === 'hidden') {
      const g = gs.find((x) => x.state === 'hidden');
      if (g) { st.mode = g.role ? 'mine' : 'discover'; st.sel = g.id; st.tab = 'overview'; }
      else st.demoNote = 'No group is hidden by moderation. A hidden group is closed to everyone but managers and its owners; its events leave calendars and their reminders stop. An upheld appeal restores it.';
    } else if (kind === 'floor') {
      const g = gs.find((x) => isMod(x) && readable(x) && x.label !== 'public');
      if (g) { st.mode = g.role ? 'mine' : 'discover'; st.sel = g.id; st.tab = 'channels'; st.floorProblem = { groupId: g.id, title: 'Label below the group\'s', detail: 'A channel of ' + g.name + ' is labelled at least ' + g.label + ' (the group\'s label is the floor). New channel refuses a lower label with 422 and step label-floor.', trace: false }; }
      else st.demoNote = 'You moderate no group labelled above public. A channel is labelled at least as high as its group; creating one lower is refused with 422 and step label-floor.';
    } else if (kind === 'above') {
      const n = gs.filter((x) => !clears(x.label)).length;
      st.mode = 'discover'; st.sel = null;
      st.demoNote = n ? n + ' group' + (n === 1 ? '' : 's') + ' you can see ' + (n === 1 ? 'is' : 'are') + ' labelled above your clearance of ' + me().clearance + ': Discover never lists ' + (n === 1 ? 'it' : 'them') + ', whatever else you may see.' : 'Discover lists groups you may join, ranked by shared members and activity. A group labelled above your clearance (' + me().clearance + ') is never listed, even for those who manage groups.';
    } else if (kind === 'near') {
      const g = gs.find((x) => x.location && x.location.lat != null);
      st.mode = 'discover'; st.sel = null;
      if (g) { st.near = { lat: g.location.lat, lon: g.location.lon, km: 50, label: g.location.name || g.name }; st.reloadNow = true; }
      else st.demoNote = 'No group you can read has a place yet. Owners give a group a place (a name and a point) in its settings; Distance then keeps those within the radius, nearest first.';
    } else if (kind === 'trending') {
      st.mode = 'trending';
      const t = (st.trend.groups || [])[0];
      if (t) st.sel = t.id; else { st.sel = null; st.demoNote = 'Nothing trends in your workspaces yet. The groups.trending job counts joins (3 each) and posts in its window; a group with a burst of joins leads after one run.'; }
    } else if (kind === 'uncategorised') {
      st.mode = 'mine'; st.fcat = 'none'; st.sel = null; st.reloadNow = true;
      st.uncatNote = null;
      st.demoNote = 'Category: uncategorised. Removing a category on Social and messaging leaves its groups here, listed and uncategorised, never hidden.';
    } else if (kind === 'owner') {
      const uid = me().id;
      const g = gs.find((x) => { const ms = st.det[x.id] && st.det[x.id].members; return ms && ms.filter((m) => m.role === 'owner').length === 1 && ms.some((m) => m.userId === uid && m.role === 'owner'); });
      if (g) { st.mode = 'mine'; st.sel = g.id; st.tab = 'members'; st.leaveProblem = { groupId: g.id, detail: 'You are the only owner of ' + g.name + '. Make someone else an owner first; the group keeps at least one owner (409). Demoting yourself is refused for the same reason.', trace: false }; }
      else st.demoNote = 'You are not the only owner of any group. A group keeps at least one owner: leaving or demoting the last one is refused with 409.';
    }
  }

  /** The distance filter (B-4403): a centre (a place of a group you read, or a point) and a radius. */
  function nearModal(ctx, reload) {
    const st = ctx.state;
    const places = []; const seen = {};
    (st.groups || []).concat(st.disc.groups || []).forEach((g) => { if (g.location && g.location.lat != null && !seen[g.id]) { seen[g.id] = 1; places.push({ value: g.location.lat + ',' + g.location.lon, label: (g.location.name || 'Place') + ' (' + g.name + ')', name: g.location.name || g.name }); } });
    const cur = st.near ? st.near.lat + ',' + st.near.lon : '';
    ctx.modal({ title: 'Distance filter',
      body: (places.length ? UI.field('Near a place', UI.select([{ value: '', label: 'A point I enter' }].concat(places), places.some((x) => x.value === cur) ? cur : '', 'data-nplace')) : '')
        + UI.field('Point (latitude, longitude)', UI.input(st.near ? st.near.lat + ', ' + st.near.lon : '', { attrs: 'data-npoint', placeholder: '52.52, 13.405' }), 'WGS 84 degrees')
        + UI.field('Within', UI.select(KMS.map((k) => ({ value: String(k), label: k + ' km' })), st.near ? String(st.near.km) : '25', 'data-nkm'))
        + UI.notice('Only groups and events with a place you may read count: a private group\'s place is shown to its members. Nearest first.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + (st.near ? UI.btn('Clear', { attrs: 'data-nclear' }) : '') + UI.btn('Apply', { kind: 'primary', attrs: 'data-napply' }),
      onMount(m) {
        const sel = m.querySelector('[data-nplace]'); const pt = m.querySelector('[data-npoint]');
        if (sel) sel.addEventListener('change', () => { if (sel.value) pt.value = sel.value.replace(',', ', '); });
        const clear = m.querySelector('[data-nclear]'); if (clear) clear.addEventListener('click', () => { st.near = null; st.sel = null; App.closeOverlay(); reload(true); });
        m.querySelector('[data-napply]').addEventListener('click', () => {
          const p = parsePoint(pt.value); if (!p) { ctx.toast('Enter a latitude (−90 to 90) and a longitude (−180 to 180), separated by a comma.', 'warn'); return; }
          const named = places.find((x) => x.value === p.lat + ',' + p.lon);
          st.near = { lat: p.lat, lon: p.lon, km: Number(m.querySelector('[data-nkm]').value), label: named ? named.name : fmtPoint(p.lat, p.lon) }; st.sel = null;
          App.closeOverlay(); reload(true);
        });
      } });
  }

  /** A new channel in a group (B-4401): its label starts at the group's, the floor. */
  function channelModal(ctx, g, done, failed) {
    ctx.modal({ title: 'New channel in ' + esc(g.name),
      body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-cname maxlength="200"', placeholder: 'Intercompany' }))
        + UI.field('Visibility', UI.select([{ value: 'public', label: 'public (everyone who reads the group)' }, { value: 'private', label: 'private (listed; content for its members)' }, { value: 'hidden', label: 'hidden (known only to its members)' }], 'public', 'data-cvis'))
        + UI.field('Join mode', UI.select(['open', 'request', 'invite'], 'open', 'data-cjoin'))
        + UI.field('Label', UI.select(LABELS.filter((l) => clears(l)), g.label, 'data-clabel'), 'At least ' + esc(g.label) + ' (the group\'s), at most the workspace ceiling') + '</div>'
        + UI.field('Description', UI.textarea('', { rows: 2, attrs: 'data-cdesc' }))
        + UI.notice('You become the channel\'s owner; the group\'s owners act as owners too. Only members of ' + esc(g.name) + ' can join it. Channels do not nest.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create channel', { kind: 'primary', attrs: 'data-ccreate' }),
      onMount(m) { m.querySelector('[data-ccreate]').addEventListener('click', () => {
        const name = m.querySelector('[data-cname]').value.trim(); if (!name) { ctx.toast('A channel needs a name.', 'warn'); return; }
        const desc = m.querySelector('[data-cdesc]').value.trim();
        const body = { name, visibility: m.querySelector('[data-cvis]').value, joinMode: m.querySelector('[data-cjoin]').value, label: m.querySelector('[data-clabel]').value };
        if (desc) body.description = desc;
        App.post('/api/groups/' + enc(g.id) + '/channels', body).then((c) => { App.closeOverlay(); done(c); }).catch((err) => { App.closeOverlay(); failed(err); });
      }); } });
  }

  function newGroupModal(ctx, reload) {
    const st = ctx.state;
    const ws = (App.me && App.me.workspaces) || [];
    const cur = (App.me && App.me.workspace) || (ws[0] && ws[0].id) || '';
    ctx.modal({ title: 'New group',
      body: '<div class="formgrid">' + UI.field('Workspace', UI.select(ws.map((w) => ({ value: w.id, label: w.name })), cur, 'data-gws')) + UI.field('Name', UI.input('', { attrs: 'data-gname', placeholder: 'Quarter-end reviewers' })) + UI.field('Visibility', UI.select(['public', 'private', 'hidden'], 'private', 'data-gvis')) + UI.field('Join mode', UI.select(['open', 'request', 'invite'], 'request', 'data-gjoin')) + UI.field('Label', UI.select(LABELS, 'internal', 'data-glabel'), 'At most the workspace ceiling (422) and your clearance (403)')
        + UI.field('Category', UI.select([{ value: '', label: 'Uncategorised' }].concat((st.categories || []).map((c) => ({ value: c.id, label: c.name }))), '', 'data-gcat'))
        + UI.field('Place', UI.input('', { attrs: 'data-gplace maxlength="200"', placeholder: 'Optional: Hamburg office' })) + UI.field('Latitude, longitude', UI.input('', { attrs: 'data-gpoint', placeholder: 'Optional: 53.5511, 9.9937' }), 'Both or neither, for distance filters') + '</div>'
        + UI.field('Description', UI.textarea('', { rows: 2, attrs: 'data-gdesc' })) + UI.notice('You become the owner. Hidden groups are known only to members, invitees and managers.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-gcreate' }),
      onMount(m) { m.querySelector('[data-gcreate]').addEventListener('click', () => {
        const name = m.querySelector('[data-gname]').value.trim(); if (!name) { ctx.toast('A group needs a name.', 'warn'); return; }
        const desc = m.querySelector('[data-gdesc]').value.trim();
        const body = { name, visibility: m.querySelector('[data-gvis]').value, joinMode: m.querySelector('[data-gjoin]').value, label: m.querySelector('[data-glabel]').value };
        const cat = m.querySelector('[data-gcat]').value; if (cat) body.categoryId = cat;
        const pt = parsePoint(m.querySelector('[data-gpoint]').value); const pn = m.querySelector('[data-gplace]').value.trim();
        if (pt === false) { ctx.toast('A place is a latitude (−90 to 90) and a longitude (−180 to 180), separated by a comma.', 'warn'); return; }
        if (pt || pn) body.location = Object.assign({ name: pn || null }, pt || {});
        const w = m.querySelector('[data-gws]').value; if (w) body.workspaceId = w; if (desc) body.description = desc;
        App.post('/api/groups', body).then((g) => { App.closeOverlay(); st.mode = 'mine'; st.sel = g.id; st.tab = 'overview'; ctx.toast(esc(g.name) + ' created; you are its owner. Event group.created.', 'ok'); reload(true); }).catch((err) => App.fail(err, 'Group not created'));
      }); } });
  }

  function inviteModal(ctx, g, preset, done) {
    App.get('/api/groups/' + enc(g.id) + '/candidates').then((people) => {
      const own = isOwner(g);
      if (!people.length) { ctx.toast('Nobody else in ' + esc(wsName(g.workspaceId)) + ' can be invited: everyone cleared for ' + esc(g.label) + ' is a member or has a pending request or invitation.', 'warn', 6000); return; }
      ctx.modal({ title: 'Invite to ' + esc(g.name),
        body: UI.field('Person', UI.select(people.map((u) => ({ value: u.userId, label: u.displayName + ' (' + u.username + ')' })), preset && people.some((u) => u.userId === preset) ? preset : people[0].userId, 'data-iuser'), 'People in ' + esc(wsName(g.workspaceId)) + ' cleared for ' + esc(g.label) + ', not yet members')
          + UI.field('Role', UI.select(own ? ['member', 'moderator', 'owner'] : ['member'], 'member', 'data-irole'), own ? '' : 'Moderators invite members; owners may invite moderators and owners')
          + UI.notice('The invitee must be active, in ' + esc(wsName(g.workspaceId)) + ' and cleared for ' + esc(g.label) + ' (422 step workspace otherwise). One pending invitation or request per person. The invitation expires after 14 days.', 'info'),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send invitation', { kind: 'primary', attrs: 'data-doinvite' }),
        onMount(m) { m.querySelector('[data-doinvite]').addEventListener('click', () => {
          App.post('/api/groups/' + enc(g.id) + '/invites', { userId: m.querySelector('[data-iuser]').value, role: m.querySelector('[data-irole]').value }).then(() => { App.closeOverlay(); ctx.toast('Invitation sent; the invitee is notified.', 'ok'); done(); }).catch((err) => App.fail(err, 'Not invited'));
        }); } });
    }).catch((err) => App.fail(err, 'Could not list people to invite'));
  }

  function eventModal(ctx, g, ev, done) {
    const isNew = !ev;
    const tomorrow = new Date(Date.now() + 86400000);
    const v = ev ? { lat: ev.lat, lon: ev.lon, title: ev.title, location: ev.location || '', timeZone: ev.timeZone, date: ev.date, start: ev.start || '10:00', end: ev.end || '11:00', allDay: ev.allDay, capacity: ev.capacity, maxGuests: ev.maxGuests || 0, reminders: ev.reminders || [] }
      : { lat: null, lon: null, title: '', location: '', timeZone: TZS.list.indexOf(TZS.own) >= 0 ? TZS.own : 'UTC', date: isoDay(tomorrow), start: '10:00', end: '11:00', allDay: false, capacity: null, maxGuests: 0, reminders: [1440, 60] };
    const tzs = TZS.list.indexOf(v.timeZone) >= 0 ? TZS.list : TZS.list.concat([v.timeZone]);
    ctx.modal({ title: isNew ? 'New event in ' + esc(g.name) : 'Edit ' + esc(v.title), cls: 'wide',
      body: '<div class="formgrid" style="--cols:3">' + UI.field('Title', UI.input(v.title, { attrs: 'data-etitle' })) + UI.field('Location', UI.input(v.location, { attrs: 'data-eloc' })) + UI.field('Time zone', UI.select(tzs, v.timeZone, 'data-etz'), 'IANA name; offsets are refused')
        + UI.field('Date', UI.input(v.date, { type: 'date', attrs: 'data-edate' })) + UI.field('Start', UI.input(v.start, { type: 'time', attrs: 'data-estart' })) + UI.field('End', UI.input(v.end, { type: 'time', attrs: 'data-eend' }))
        + UI.field('Capacity', UI.input(v.capacity == null ? '' : String(v.capacity), { type: 'number', attrs: 'data-ecap min="1"', placeholder: 'unlimited' }), 'People with their guests') + UI.field('Guests per person', UI.input(String(v.maxGuests), { type: 'number', attrs: 'data-eguests min="0" max="20"' })) + UI.field('Reminders (minutes before)', UI.input(v.reminders.join(', '), { attrs: 'data-erem' }), 'Up to five, at most 28 days')
        + UI.field('Latitude, longitude', UI.input(fmtPoint(v.lat, v.lon), { attrs: 'data-epoint', placeholder: '53.5511, 9.9937' }), 'Optional, for distance filters; both or neither') + '</div>'
        + UI.toggle('All day', v.allDay, 'data-eallday')
        + UI.notice('Wall-clock times are stored in UTC with the zone. A time that occurs twice (the autumn clock change) takes the earlier instant; one in a spring gap moves forward by the gap. Events last at most 31 days.' + (isNew ? '' : ' A change attendees see moves the sequence; a new time or reminder list reschedules the reminders.'), 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(isNew ? 'Create event' : 'Save', { kind: 'primary', attrs: 'data-esave' }),
      onMount(m) { m.querySelector('[data-esave]').addEventListener('click', () => {
        const title = m.querySelector('[data-etitle]').value.trim(); if (!title) { ctx.toast('An event needs a title.', 'warn'); return; }
        const rem = m.querySelector('[data-erem]').value.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
        if (rem.some((x) => !(x > 0) || Math.floor(x) !== x) || rem.length > 5 || rem.some((x) => x > 40320)) { ctx.toast('Up to five reminders, whole minutes, at most 28 days before.', 'warn'); return; }
        const allDay = m.querySelector('[data-eallday]').classList.contains('on');
        const date = m.querySelector('[data-edate]').value || v.date;
        const start = m.querySelector('[data-estart]').value || v.start, end = m.querySelector('[data-eend]').value || v.end;
        if (!allDay && end <= start) { ctx.toast('The end comes after the start.', 'warn'); return; }
        const cap = m.querySelector('[data-ecap]').value.trim();
        const pt = parsePoint(m.querySelector('[data-epoint]').value);
        if (pt === false) { ctx.toast('A place is a latitude (−90 to 90) and a longitude (−180 to 180), separated by a comma.', 'warn'); return; }
        const body = { lat: pt ? pt.lat : null, lon: pt ? pt.lon : null, title, location: m.querySelector('[data-eloc]').value.trim() || null, timeZone: m.querySelector('[data-etz]').value, allDay, capacity: cap ? Number(cap) : null, maxGuests: Number(m.querySelector('[data-eguests]').value) || 0, reminders: rem, start: allDay ? date : date + 'T' + start, end: allDay ? date : date + 'T' + end };
        const req = isNew ? App.post('/api/groups/' + enc(g.id) + '/events', body) : App.patch('/api/calendar/events/' + enc(ev.id), body);
        req.then((r) => { App.closeOverlay(); ctx.toast(isNew ? 'Event created. Members in the room get group.event.created.' : 'Event saved; sequence is now ' + r.sequence + '. Attendees get group.event.updated.', 'ok'); done(r); }).catch((err) => App.fail(err, isNew ? 'Event not created' : 'Event not saved'));
      }); } });
  }
})();
