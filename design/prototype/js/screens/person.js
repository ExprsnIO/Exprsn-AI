(function () {
  const { UI, esc } = App;

  // Profile page (B-5801, B-5802, Sprint 34): opened from a post's author, a message's author, a conversation's or a
  // group's member list and the People directory (#/person?user=<id>). Not in the sidebar.
  // ---- example data: Northwind, 19 Sep 2026 14:10, signed in as Mara Okafor (confidential) ----
  const ME = { id: 'me', name: 'Mara Okafor', user: 'mokafor', ws: ['Finance Ops', 'People Ops'], clearance: 'confidential' };
  const PEOPLE0 = () => [
    { id: 'u-priya', name: 'Priya Nair', user: 'pnair', ws: ['Finance Ops'], pronouns: 'she/her', bio: 'Controller for EMEA. I own the close checklist and the board pack. Ask me before you move a ledger freeze.', label: 'internal', avatar: 'ready', presence: 'busy', following: true, followedBy: true },
    { id: 'u-tomasz', name: 'Tomasz Weber', user: 'tweber', ws: ['Finance Ops'], pronouns: 'he/him', bio: 'Travel and expenses. The Lisbon programme numbers come from me.', label: 'internal', avatar: 'none', presence: 'available', following: false, followedBy: true },
    { id: 'u-jonas', name: 'Jonas Lindqvist', user: 'jlindqvist', ws: ['Finance Ops', 'People Ops'], pronouns: '', bio: 'Vendor management and the Contracts knowledge base.', label: 'confidential', avatar: 'ready', presence: 'away', following: true, followedBy: false },
    { id: 'u-felix', name: 'Felix Brandt', user: 'fbrandt', ws: ['Finance Ops'], pronouns: 'he/him', bio: 'Automation. Workflow v3 writes meeting notes into the Meetings app.', label: 'internal', avatar: 'rejected', presence: 'available', following: true, followedBy: true },
    { id: 'u-lena', name: 'Lena Hoffmann', user: 'lhoffmann', ws: ['Finance Ops', 'Field Sales'], pronouns: 'she/her', bio: 'Knowledge sources for Finance Ops.', label: 'restricted', avatar: 'ready', presence: 'offline', following: true, followedBy: false },
    { id: 'u-aisha', name: 'Aisha Bello', user: 'abello', ws: ['People Ops'], pronouns: 'she/they', bio: 'People Ops partner for Finance.', label: 'internal', avatar: 'none', presence: 'available', following: false, followedBy: false, onlyIn: ['People Ops'] },
    { id: 'u-noor', name: 'Noor Rahimi', user: 'nrahimi', ws: ['People Ops', 'Finance Ops'], pronouns: 'she/her', bio: 'Not shown to you.', label: 'internal', avatar: 'ready', presence: 'available', following: false, followedBy: false, blocked: true }
  ];
  const LEVEL = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  const STATUS = { available: 'ok', away: 'warn', busy: 'danger', offline: 'outline' };
  const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  /** What Mara may see of a person: null (everything), 'clearance' or 'hidden' (name only). */
  const limitOf = (p) => (p.blocked ? 'hidden' : p.onlyIn && !p.onlyIn.some((w) => ME.ws.indexOf(w) >= 0) ? 'hidden' : LEVEL[p.label] > LEVEL[ME.clearance] ? 'clearance' : null);
  const shared = (p) => p.ws.filter((w) => ME.ws.indexOf(w) >= 0);

  App.register({
    id: 'person', title: 'Profile', summary: 'Someone\'s profile and status, opened from posts, messages, groups and the People directory', crumb: (st) => ['People', (PEOPLE0().find((p) => p.id === st.sel) || { name: 'Profile' }).name],
    states: [
      { title: 'Status changes live', tone: 'ok', text: 'Priya sets herself to available. Everyone watching her over the socket sees it within five seconds; people in a block with her see nothing.', apply(ctx) { const st = ctx.state; st.sel = 'u-priya'; const p = st.people.find((x) => x.id === 'u-priya'); p.presence = 'available'; ctx.rerender(); ctx.toast('Priya Nair is now available. presence.changed arrived over the socket.', 'ok'); } },
      { title: 'Name only below clearance', tone: 'info', text: 'Lena\'s profile is restricted and your clearance is confidential: her pronouns, bio and picture are left out; name, account and shared workspaces stay.', apply(ctx) { ctx.state.sel = 'u-lena'; ctx.rerender(); } },
      { title: 'Blocked person sees the name only', tone: 'neutral', text: 'You blocked Noor Rahimi. Each of you sees the other\'s name only, the same view a narrowed profile gives, and no status at all.', apply(ctx) { ctx.state.sel = 'u-noor'; ctx.rerender(); } },
      { title: 'Picture refused by the scan', tone: 'danger', text: 'Felix\'s new picture failed the file store\'s scan. It is never shown: everyone sees his initials until a picture passes.', apply(ctx) { ctx.state.sel = 'u-felix'; ctx.state.showScan = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.people = st.people || PEOPLE0();
      // Opened by id, account or name (the Groups board names its members).
      if (ctx.params.user) { const k = ctx.params.user; const hit = st.people.find((p) => p.id === k || p.user === k || p.name === k); st.sel = k === 'me' || k === ME.user || k === ME.name ? 'me' : hit ? hit.id : st.sel; delete ctx.params.user; }
      st.sel = st.sel || 'u-priya'; st.q = st.q || '';
      const list = st.people.filter((p) => !st.q || (p.name + ' ' + p.user).toLowerCase().indexOf(st.q.toLowerCase()) >= 0);
      const presencePill = (p) => (p.blocked ? '' : UI.pill(p.presence, STATUS[p.presence]));
      const dir = '<div class="leftpane"><h2 class="eyebrow" style="margin:0">Directory</h2>' + UI.search('Search people', 'data-pq', st.q)
        + '<div class="vstack" style="gap:2px">' + UI.listItem('<b>' + esc(ME.name) + '</b> <span class="muted">(you)</span>', esc(ME.ws.join(', ')), { active: st.sel === 'me', attrs: 'data-pick="me"' })
        + list.map((p) => UI.listItem(esc(p.name), esc(shared(p).join(', ')), { active: st.sel === p.id, attrs: 'data-pick="' + p.id + '"', right: presencePill(p) })).join('') + (list.length ? '' : UI.empty('Nobody matches', 'Search by name or account.')) + '</div>'
        + '<div class="muted" style="font-size:12px;margin-top:6px">People who share a workspace with you. Status shows for everyone here except people in a block with you.</div></div>';

      let page;
      if (st.sel === 'me') {
        page = UI.pagehead(ME.name, '<span class="mono">' + esc(ME.user) + '</span> · this is how others see you', UI.btn('Edit in Settings', { kind: 'primary', size: 'sm', attrs: 'data-gosettings' }))
          + UI.panel('Your profile', UI.kv([['Pronouns', 'she/her'], ['Bio', 'Finance Ops lead. Board pack, close calendar, and the Q3 flash.'], ['Label', UI.label('internal', { sm: true })], ['Shown in', 'every workspace you share with them'], ['Status', UI.pill('available', 'ok') + ' <span class="muted">automatic</span>']], 1));
      } else {
        const p = st.people.find((x) => x.id === st.sel) || st.people[0];
        const lim = limitOf(p);
        const avatarHtml = !lim && p.avatar === 'ready'
          ? '<span class="person-avatar pic" role="img" aria-label="Profile picture of ' + esc(p.name) + '">' + UI.icon('images', 28) + '</span>'
          : '<span class="person-avatar" aria-hidden="true">' + esc(initials(p.name)) + '</span>';
        const actions = p.blocked ? UI.btn('Unblock', { size: 'sm', attrs: 'data-unblock' })
          : UI.btn('Message', { kind: 'primary', size: 'sm', icon: 'send', attrs: 'data-message' }) + UI.btn(p.following ? 'Unfollow' : 'Follow', { size: 'sm', attrs: 'data-follow' }) + UI.btn('Mute', { size: 'sm', kind: 'ghost', attrs: 'data-mute' }) + UI.btn('Block', { size: 'sm', kind: 'ghost', attrs: 'data-block' });
        const head = '<div class="person-head">' + avatarHtml + '<div class="vstack" style="gap:4px;min-width:0"><h1 class="person-name">' + esc(p.name) + (!lim && p.pronouns ? ' <span class="muted person-pron">' + esc(p.pronouns) + '</span>' : '') + '</h1>'
          + '<div class="hstack wrap gap6"><span class="mono muted">' + esc(p.user) + '</span>' + presencePill(p) + (!lim ? UI.label(p.label, { sm: true }) : '') + (p.followedBy && !p.blocked ? UI.pill('follows you', 'outline') : '') + '</div></div></div>';
        const note = lim === 'clearance' ? UI.notice('<b>Name only.</b> This profile is ' + esc(p.label) + ' and your clearance is ' + esc(ME.clearance) + ', so the pronouns, bio and picture are left out.', 'info')
          : lim === 'hidden' ? UI.notice(p.blocked ? '<b>You blocked ' + esc(p.name) + '.</b> Each of you sees the other\'s name only and no status. Messages, posts, typing and presence are left out both ways; they read "does not accept messages from you".' : '<b>Name only.</b> ' + esc(p.name) + ' shows their profile in other workspaces than the ones you share.', 'info') : '';
        const scan = st.showScan && p.avatar === 'rejected' ? UI.notice('<b>Picture not shown.</b> The new picture failed the file store\'s scan (Malware detected: Eicar-Test-Signature). A picture that fails the scan is never shown; initials stand in until one passes.', 'danger') : '';
        const about = lim ? '' : UI.panel('About', '<div class="serif" style="font-size:15px;line-height:1.5">' + esc(p.bio || 'Nothing written yet.') + '</div>');
        const facts = UI.panel('In common', UI.kv([['Shared workspaces', esc(shared(p).join(', ') || 'none')], ['You follow', p.blocked ? 'no' : p.following ? 'yes' : 'no'], ['Status', p.blocked ? 'not shown' : esc(p.presence) + ' <span class="muted">' + (p.presence === 'away' ? '(idle for five minutes or more)' : p.presence === 'offline' ? '(not connected, or appearing offline)' : '(chosen or derived from activity)') + '</span>']], 1));
        page = '<div class="hstack wrap" style="align-items:flex-start;gap:12px">' + '<div class="grow" style="min-width:0">' + head + '</div><div class="hstack wrap gap6">' + actions + '</div></div>' + note + scan + about + facts;
      }
      root.innerHTML = '<style>#main .person-head{display:flex;gap:14px;align-items:center;min-width:0}#main .person-avatar{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:var(--fg);color:var(--bg);font-size:22px;font-weight:700;flex-shrink:0}#main .person-avatar.pic{background:var(--accent-tint);color:var(--accent)}#main .person-name{margin:0;font-size:22px;overflow-wrap:anywhere}#main .person-pron{font-size:14px;font-weight:400}</style>'
        + dir + '<div class="page">' + page + '</div>';

      ctx.on('input', '[data-pq]', (e, t) => { st.q = t.value; ctx.rerender(); const s = ctx.$('[data-pq]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
      ctx.on('click', '[data-pick]', (e, t) => { st.sel = t.dataset.pick; st.showScan = false; ctx.rerender(); });
      ctx.on('click', '[data-gosettings]', () => ctx.navigate('settings'));
      const cur = () => st.people.find((x) => x.id === st.sel);
      ctx.on('click', '[data-message]', () => { const p = cur(); ctx.navigate('messages'); ctx.toast('Direct conversation with ' + esc(p.name) + ' opened (one per pair).', 'ok'); });
      ctx.on('click', '[data-follow]', () => { const p = cur(); p.following = !p.following; ctx.rerender(); ctx.toast(p.following ? 'Following ' + esc(p.name) + '. Their posts join your home feed.' : 'Unfollowed.', 'ok'); });
      ctx.on('click', '[data-mute]', () => { const p = cur(); ctx.toast(esc(p.name) + ' muted for a week. Private; they are not told.', 'ok'); });
      ctx.on('click', '[data-block]', async () => {
        const p = cur();
        const ok = await ctx.confirm({ title: 'Block ' + esc(p.name), tone: 'danger', body: '<p class="fg2" style="margin:0">Neither of you can message the other; their messages, posts, typing and status are left out for you on every instance, and each of you sees the other\'s name only.</p>', ok: 'Block' });
        if (!ok) return; p.blocked = true; p.following = false; ctx.rerender(); ctx.toast(esc(p.name) + ' blocked.', 'warn');
      });
      ctx.on('click', '[data-unblock]', () => { const p = cur(); p.blocked = false; ctx.rerender(); ctx.toast('Unblocked. Follows do not come back on their own.', 'ok'); });
    }
  });
})();
