(function () {
  const { UI, esc } = App;

  // Profile (B-5801, B-5802): someone's profile and status, opened from posts, messages, groups and the People
  // directory (#/person?user=<id>, or user=me). The directory is /api/social/people, a profile /api/people/:id and the
  // status arrives over the socket (presence.watch, presence.changed). The server decides what the caller may see:
  // a profile above their clearance or narrowed to other workspaces, and anyone in a block with them, shows the name
  // only; someone in a block has no status at all.
  const ID = 'person';
  const enc = encodeURIComponent;
  const STATUS = { available: 'ok', away: 'warn', busy: 'danger', offline: 'outline' };
  const S = () => App.stateFor(ID);
  const meId = () => (App.me && App.me.user ? App.me.user.id : null);
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || false;
  const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const overlayOpen = () => !!document.getElementById('overlay');
  const when = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

  // ---------------- realtime: the statuses of the people on this page ----------------
  const live = { sock: null, handler: null, watched: '', ctx: null, pending: false };
  function paint() {
    if (App.state.route !== ID || !live.ctx) return;
    if (overlayOpen()) { if (!live.pending) { live.pending = true; setTimeout(() => { live.pending = false; paint(); }, 300); } return; }
    live.ctx.rerender();
  }
  function detach() {
    if (live.sock) { if (live.handler) live.sock.off('presence.changed', live.handler); live.sock.off('connect', reconnect); live.sock.emit('presence.unwatch'); }
    live.sock = null; live.handler = null; live.watched = '';
  }
  function reconnect() { live.watched = ''; watch(S()); }
  function attach() {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.handler = (d) => {
      if (App.state.route !== ID) { detach(); return; }
      const st = S(); if (!d || !d.userId) return;
      st.status = st.status || {};
      st.status[d.userId] = d.status;
      if (st.profile && st.profile.userId === d.userId && st.profile.presence && !st.profile.self) st.profile.presence.status = d.status;
      paint();
    };
    live.sock.on('presence.changed', live.handler);
    live.sock.on('connect', reconnect);
  }
  window.addEventListener('hashchange', () => { if (App.parse().route !== ID) detach(); });
  function watch(st) {
    const ids = [meId()].concat((st.people || []).map((p) => p.userId)).concat(st.sel && st.sel !== 'me' ? [st.sel] : []).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 200);
    const key = ids.join(',');
    if (!ids.length || key === live.watched) return;
    live.watched = key;
    if (live.sock && live.sock.connected) {
      live.sock.emit('presence.watch', { userIds: ids }, (r) => { if (r && r.ok) { st.status = r.statuses || {}; paint(); } });
    } else if (App.can('social:read')) {
      App.get('/api/presence?ids=' + enc(key)).then((r) => { st.status = r.statuses || {}; paint(); }).catch(() => undefined);
    }
  }

  // ---------------- data ----------------
  function loadPeople(st) {
    return App.get('/api/social/people?limit=200').then((p) => { st.people = p; }).catch((err) => { st.peopleError = err; st.people = []; });
  }
  function loadProfile(st) {
    const id = st.sel === 'me' ? meId() : st.sel;
    st.profileFor = st.sel;
    return App.get('/api/people/' + enc(id)).then((p) => { if (st.profileFor === st.sel) { st.profile = p; st.profileError = null; } })
      .catch((err) => { if (st.profileFor === st.sel) { st.profile = null; st.profileError = err; } });
  }

  App.register({
    id: ID, title: 'Profile', live: true,
    summary: 'Someone\'s profile and status, opened from posts, messages, groups and the People directory',
    crumb: (st) => ['People', (st.profile && st.profile.displayName) || 'Profile'],
    states: [
      { title: 'Status changes live', tone: 'ok', text: 'A status someone sets is published at once over the socket: everyone watching them sees it within five seconds; people in a block with them see nothing.', apply(ctx) { ctx.state.liveNote = true; ctx.rerender(); } },
      { title: 'Name only below clearance', tone: 'info', text: 'A profile above your clearance shows the name, account and shared workspaces; the pronouns, bio and picture are left out.', apply(ctx) { ctx.state.explain = 'clearance'; ctx.rerender(); } },
      { title: 'Blocked person sees the name only', tone: 'neutral', text: 'Two people in a block see each other\'s name only, the same view a narrowed profile gives, and no status at all.', apply(ctx) { ctx.state.explain = 'hidden'; ctx.rerender(); } },
      { title: 'Picture refused by the scan', tone: 'danger', text: 'A picture that fails the file store\'s scan is never shown: initials stand in until one passes.', apply(ctx) { ctx.state.explain = 'scan'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      live.ctx = ctx;
      if (ctx.params.user && ctx.params.user !== st.appliedUser) { st.appliedUser = ctx.params.user; st.sel = ctx.params.user === meId() ? 'me' : ctx.params.user; }
      st.sel = st.sel || 'me'; st.q = st.q || '';
      if (!App.can('social:read')) {
        root.innerHTML = '<div class="page">' + UI.problem('Profiles are not available to you', 'Seeing profiles and statuses needs the social:read permission, which none of your roles grant.', false) + '</div>';
        return;
      }
      attach();
      if (!st.people && !st.peopleLoading) { st.peopleLoading = true; loadPeople(st).finally(() => { st.peopleLoading = false; paint(); }); }
      if (st.profileFor !== st.sel && !st.profileLoading) { st.profile = null; st.profileError = null; st.profileLoading = true; loadProfile(st).finally(() => { st.profileLoading = false; paint(); }); }
      watch(st);

      const status = st.status || {};
      const pill = (id) => (status[id] ? UI.pill(status[id], STATUS[status[id]]) : '');
      const needle = st.q.toLowerCase();
      const list = (st.people || []).filter((p) => !needle || ((p.displayName || '') + ' ' + p.username).toLowerCase().indexOf(needle) >= 0);
      const myName = App.me && App.me.user ? App.me.user.displayName || App.me.user.username : 'You';
      const dir = '<div class="leftpane"><h2 class="eyebrow" style="margin:0">Directory</h2>' + UI.search('Search people', 'data-pq aria-label="Search people"', st.q)
        + '<div class="vstack" style="gap:2px">' + UI.listItem('<b>' + esc(myName) + '</b> <span class="muted">(you)</span>', esc(((App.me && App.me.workspaces) || []).map((w) => w.name).join(', ')), { active: st.sel === 'me', attrs: 'data-pick="me"', right: pill(meId()) })
        + list.map((p) => UI.listItem(esc(p.displayName || p.username), esc(p.workspaces.map((w) => w.name).join(', ')), { active: st.sel === p.userId, attrs: 'data-pick="' + esc(p.userId) + '"', right: pill(p.userId) })).join('')
        + (st.people && !list.length ? UI.empty(st.people.length ? 'Nobody matches' : 'Nobody else yet', st.people.length ? 'Search by name or account.' : 'People who share a workspace with you appear here.') : '') + '</div>'
        + '<div class="muted" style="font-size:12px;margin-top:6px">People who share a workspace with you. Status shows for everyone here except people in a block with you.</div></div>';

      let page;
      const p = st.profile;
      if (st.profileError) page = UI.problem(st.profileError.status === 404 ? 'Nobody you know by that name' : 'Profile not loaded', st.profileError.status === 404 ? 'Profiles are known to people who share a workspace. This person is not in any of yours, or is no longer active.' : st.profileError.message, traceOf(st.profileError));
      else if (!p) page = UI.notice('Loading…', 'info');
      else {
        const limited = p.limited;
        const avatar = p.avatar && p.avatar.url && (!p.self || (p.avatar.state === 'ready'))
          ? '<img class="person-avatar" src="' + esc(p.avatar.url) + '" alt="Profile picture of ' + esc(p.displayName) + '" width="64" height="64">'
          : '<span class="person-avatar" aria-hidden="true">' + esc(initials(p.displayName || p.username)) + '</span>';
        const pres = p.self ? (p.presence ? p.presence.effective : null) : p.presence ? p.presence.status : null;
        const shown = status[p.userId] || pres;
        const rel = p.relation || {};
        const w = App.can('social:write');
        const actions = p.self ? UI.btn('Edit in Settings', { kind: 'primary', size: 'sm', attrs: 'data-gosettings' })
          : rel.blocking ? (w ? UI.btn('Unblock', { size: 'sm', attrs: 'data-unblock' }) : '')
          : (App.can('messages:write') && rel.canMessage ? UI.btn('Message', { kind: 'primary', size: 'sm', icon: 'send', attrs: 'data-message' }) : '')
            + (w ? UI.btn(rel.following ? 'Unfollow' : 'Follow', { size: 'sm', attrs: 'data-follow' }) + UI.btn(rel.muting ? 'Unmute' : 'Mute', { size: 'sm', kind: 'ghost', attrs: 'data-mute' }) + UI.btn('Block', { size: 'sm', kind: 'ghost', attrs: 'data-block' }) : '');
        const head = '<div class="person-head">' + avatar + '<div class="vstack" style="gap:4px;min-width:0"><h1 class="person-name">' + esc(p.displayName || p.username) + (!limited && p.pronouns ? ' <span class="muted person-pron">' + esc(p.pronouns) + '</span>' : '') + '</h1>'
          + '<div class="hstack wrap gap6"><span class="mono muted">' + esc(p.username) + '</span>' + (shown ? UI.pill(shown, STATUS[shown]) : '') + (!limited && p.label ? UI.label(p.label, { sm: true }) : '') + (rel.followedBy ? UI.pill('follows you', 'outline') : '') + (p.self ? UI.pill('you', 'accent') : '') + '</div></div></div>';
        const explain = st.explain === 'clearance' ? UI.notice('<b>Name only below clearance.</b> A profile whose label is above your clearance shows the name, account and shared workspaces; the pronouns, bio and picture are left out.', 'info', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-explainok' }))
          : st.explain === 'hidden' ? UI.notice('<b>Name only.</b> Two people in a block see each other\'s name only and no status, the same view a profile narrowed to other workspaces gives, so neither view tells a blocked person they are blocked.', 'info', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-explainok' }))
          : st.explain === 'scan' ? UI.notice('<b>Pictures pass the scan first.</b> A picture is stored in the file store and scanned like any upload. One that fails (malware, or bytes that are not an image) is never shown; initials stand in.', 'danger', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-explainok' })) : '';
        const liveNote = st.liveNote ? UI.notice('<b>Statuses are live.</b> They arrive over the socket as people change them or go idle; people in a block with you never appear with one.', 'ok', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-liveok' })) : '';
        const note = limited === 'clearance' ? UI.notice('<b>Name only.</b> This profile is above your clearance (' + esc(App.me.user.clearance) + '), so the pronouns, bio and picture are left out.', 'info')
          : limited === 'hidden' ? UI.notice(rel.blocking ? '<b>You blocked ' + esc(p.displayName) + '.</b> Each of you sees the other\'s name only and no status. Messages, posts, typing and presence are left out both ways.' : '<b>Name only.</b> This profile is shown in other workspaces than the ones you share, or not to you.', 'info') : '';
        const avatarState = p.self && p.avatar && p.avatar.state !== 'ready' ? UI.notice(p.avatar.state === 'rejected' || p.avatar.state === 'not an image' ? '<b>Your picture is not shown.</b> It failed the file store\'s scan; upload another one in Settings.' : p.avatar.state === 'gone' ? '<b>Your picture is not shown.</b> Its file is in the trash.' : '<b>Your new picture is being scanned.</b> Others see your initials until it passes.', p.avatar.state === 'rejected' || p.avatar.state === 'not an image' ? 'danger' : 'info') : '';
        const about = limited ? '' : UI.panel('About', '<div class="serif" style="font-size:15px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere">' + esc(p.bio || 'Nothing written yet.') + '</div>');
        const facts = UI.panel('In common', UI.kv([['Shared workspaces', esc((p.sharedWorkspaces || []).map((x) => x.name).join(', ') || 'none')]].concat(p.self ? [['Shown in', esc(p.workspaces && p.workspaces.length ? p.workspaces.length + (p.workspaces.length === 1 ? ' workspace' : ' workspaces') : 'every workspace you share with them')], ['Status', esc(p.presence ? (p.presence.status === 'auto' ? 'automatic, now ' + p.presence.effective : p.presence.status) : '')], ['Updated', esc(when(p.updatedAt))]] : [['You follow', rel.following ? 'yes' : 'no'], ['Status', shown ? esc(shown) + ' <span class="muted">' + (shown === 'away' ? '(idle for five minutes or more, or chosen)' : shown === 'offline' ? '(not connected, or appearing offline)' : '(chosen or derived from activity)') + '</span>' : 'not shown']]), 1));
        page = '<div class="hstack wrap" style="align-items:flex-start;gap:12px"><div class="grow" style="min-width:0">' + head + '</div><div class="hstack wrap gap6">' + actions + '</div></div>' + liveNote + explain + note + avatarState + about + facts;
      }
      root.innerHTML = '<style>#main .person-head{display:flex;gap:14px;align-items:center;min-width:0}#main .person-avatar{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:var(--fg);color:var(--bg);font-size:22px;font-weight:700;flex-shrink:0;object-fit:cover}#main .person-name{margin:0;font-size:22px;overflow-wrap:anywhere}#main .person-pron{font-size:14px;font-weight:400}</style>'
        + dir + '<div class="page">' + page + '</div>';
      wire(ctx, st);
    }
  });

  function wire(ctx, st) {
    ctx.on('input', '[data-pq]', (e, t) => { st.q = t.value; ctx.rerender(); const s = ctx.$('[data-pq]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
    ctx.on('click', '[data-pick]', (e, t) => { st.sel = t.dataset.pick; st.explain = null; ctx.rerender(); });
    ctx.on('click', '[data-gosettings]', () => ctx.navigate('settings'));
    ctx.on('click', '[data-explainok]', () => { st.explain = null; ctx.rerender(); });
    ctx.on('click', '[data-liveok]', () => { st.liveNote = false; ctx.rerender(); });
    const p = st.profile; if (!p || p.self) return;
    const name = p.displayName || p.username;
    const reload = () => { st.profileFor = null; paint(); };
    ctx.on('click', '[data-message]', () => {
      App.post('/api/messaging/conversations', { kind: 'direct', userId: p.userId }).then((c) => ctx.navigate('messages', { convo: c.id })).catch((err) => App.fail(err, 'Conversation not started'));
    });
    ctx.on('click', '[data-follow]', () => {
      const on = !(p.relation && p.relation.following);
      (on ? App.post('/api/social/following', { userId: p.userId }) : App.del('/api/social/following/' + enc(p.userId))).then(() => { ctx.toast(on ? 'Following ' + esc(name) + '. Their posts join your home feed.' : 'Unfollowed.', 'ok'); reload(); }).catch((err) => App.fail(err, on ? 'Not followed' : 'Not unfollowed'));
    });
    ctx.on('click', '[data-mute]', () => {
      const on = !(p.relation && p.relation.muting);
      (on ? App.post('/api/social/mutes', { userId: p.userId, minutes: 10080 }) : App.del('/api/social/mutes/' + enc(p.userId))).then(() => { ctx.toast(on ? esc(name) + ' muted for a week. Private; they are not told.' : 'Unmuted.', 'ok'); reload(); }).catch((err) => App.fail(err, on ? 'Not muted' : 'Not unmuted'));
    });
    ctx.on('click', '[data-block]', async () => {
      const ok = await ctx.confirm({ title: 'Block ' + name, tone: 'danger', body: '<p class="fg2" style="margin:0">Neither of you can message the other; their messages, posts, typing and status are left out for you on every instance, and each of you sees the other\'s name only.</p>', ok: 'Block' });
      if (!ok) return;
      App.post('/api/social/blocks', { userId: p.userId }).then(() => { ctx.toast(esc(name) + ' blocked.', 'warn'); if (st.status) delete st.status[p.userId]; live.watched = ''; reload(); }).catch((err) => App.fail(err, 'Not blocked'));
    });
    ctx.on('click', '[data-unblock]', () => {
      App.del('/api/social/blocks/' + enc(p.userId)).then(() => { ctx.toast('Unblocked. Follows do not come back on their own.', 'ok'); live.watched = ''; reload(); }).catch((err) => App.fail(err, 'Not unblocked'));
    });
  }
})();
