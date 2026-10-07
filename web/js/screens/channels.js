(function () {
  const { UI, esc } = App;

  // Customer-service channels (B-3410): sessions and transcripts, held replies with approve, edit and reject, settings
  // and secrets, email bounces, retention and CSV exports. Everything comes from /api/channels (Sprint 28a); the
  // held-reply timers come from the workspace flag queue when the reviewer may read it.
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const small = (t) => '<span class="muted" style="font-size:12px">' + t + '</span>';
  const statePill = (s) => UI.pill(s, s === 'open' || s === 'active' ? 'ok' : s === 'escalated' || s === 'paused' ? 'warn' : s === 'hidden' || s === 'deleted' ? 'danger' : '');
  const minsLeft = (f) => Math.round((f.dueAt - Date.now()) / 60000);
  const timeText = (left) => (left < 0 ? 'overdue ' + -left + ' min' : left >= 120 ? Math.round(left / 60) + ' h left' : left + ' min left');
  const overlayOpen = () => !!document.getElementById('overlay');
  const canManage = () => App.can('channels:manage');
  const meId = () => (App.me && App.me.user ? App.me.user.id : null);
  const wsName = (id) => { const w = ((App.me && App.me.workspaces) || []).find((x) => x.id === id); return w ? w.name : 'another workspace'; };
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const num = (v) => (v === '' || v == null ? null : Number(v));
  // Export jobs started from this screen in this browser tab, so the table can name their channel.
  const exportChannel = {};

  // channels.changed arrives on the channels:review room (ids only); the screen fetches again.
  const live = { sock: null, onChange: null, timer: null, refresh: null };
  const detach = () => { if (live.sock && live.onChange) live.sock.off('channels.changed', live.onChange); live.sock = null; live.onChange = null; if (live.timer) { clearTimeout(live.timer); live.timer = null; } };
  const attach = () => {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.onChange = () => {
      if (App.state.route !== 'channels') { detach(); return; }
      if (live.timer) return;
      live.timer = setTimeout(() => { live.timer = null; if (live.refresh) live.refresh(); }, 800);
    };
    live.sock.on('channels.changed', live.onChange);
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'channels') detach(); });

  async function download(url, name) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) { let p = null; try { p = await res.json(); } catch (e) { /* not JSON */ } throw new App.ApiError(p || { status: res.status, title: res.statusText }); }
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = href; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }

  function menu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  App.register({
    id: 'channels', title: 'Channels', live: true, section: 'admin', crumb: ['Admin', 'Channels'],
    summary: 'Customer-service channels: sessions and transcripts, held replies with approve, edit and reject, email threads, retention, exports',
    label: (st) => { const c = (st.channels || []).find((x) => x.id === st.sel); return c ? c.label : null; },
    commands: [
      { label: 'Decide the next held reply', sub: 'Channels', run(app) { const s = app.stateFor('channels'); s.tab = 'held'; const h = (s.held || [])[0]; if (h) s.sel = h.channelId; app.render(); } },
      { label: 'Create a channel', sub: 'Channels', run(app) { app.stateFor('channels').openNew = true; app.render(); } }
    ],
    states: [
      { title: 'Edited held reply reaches the customer as edited', tone: 'ok', text: 'Edit delivers the reviewer\'s text; the model\'s text is kept as original on the message and the flag records the decision.', apply(ctx) {
        const st = ctx.state; const h = (st.held || [])[0];
        if (h) { st.sel = h.channelId; st.tab = 'held'; ctx.rerender(); decideHeld(ctx, h, 'edit'); return; }
        st.demoNote = 'Nothing is held right now. When a reply is held, Edit and send delivers your text instead; the model\'s text is kept as original on the message and shows under it in the transcript.'; ctx.rerender();
      } },
      { title: 'Session escalated', tone: 'warn', text: 'The customer asked for a person: the session escalates, reviewers holding channels:review in the workspace are notified, and every further answer waits.', apply(ctx) {
        const st = ctx.state; let found = null;
        Object.keys(st.sessions || {}).forEach((ch) => { const s = (st.sessions[ch] || []).find((x) => x.state === 'escalated'); if (s && !found) found = s; });
        if (found) { st.sel = found.channelId; st.tab = 'sessions'; st.sstate = 'all'; st.sessionSel = found.id; ctx.rerender(); return; }
        st.demoNote = 'No loaded session is escalated. A session escalates when the customer asks for a person, a guardrail asks for review of their message or the model cannot answer; reviewers holding channels:review in the workspace are notified.'; ctx.rerender();
      } },
      { title: 'Channel paused refuses new sessions', tone: 'info', text: 'A paused channel answers 404 to new public sessions and ends customer tokens until it is active again; open sessions wait.', apply(ctx) {
        const st = ctx.state; const c = (st.channels || []).find((x) => x.state === 'paused');
        if (c) { st.sel = c.id; st.tab = 'settings'; st.fstate = 'live'; ctx.rerender(); return; }
        st.demoNote = 'No channel is paused. Pausing one (Settings, Pause) answers 404 to new public sessions and ends customer tokens until it is active again; open sessions and held replies are kept.'; ctx.rerender();
      } },
      { title: 'Mail failed after five attempts', tone: 'danger', text: 'The channels.send job tries five times; then the outbox row is failed and channel.mail.failed is audited. A person can answer again.', apply(ctx) {
        const st = ctx.state; const c = (st.channels || []).find((x) => x.kind === 'email');
        if (c) { st.sel = c.id; st.tab = 'email'; st.mailFailedNote = true; ctx.rerender(); return; }
        st.demoNote = 'There is no email channel. On one, the channels.send job tries a reply five times; then the outbox row is failed, channel.mail.failed is audited, and a person can answer again from the session.'; ctx.rerender();
      } },
      { title: 'Vault reference not readable', tone: 'danger', text: 'IMAP and SMTP passwords are vault: references, read as the saver at every connection. When the saver loses the policy the poll fails with 403 and the mailbox stops being read.', apply(ctx) {
        const st = ctx.state; const c = (st.channels || []).find((x) => x.kind === 'email');
        if (c) { st.sel = c.id; st.tab = 'settings'; st.vaultProblem = true; ctx.rerender(); return; }
        st.demoNote = 'There is no email channel. Mail credentials are vault: references, read as the person who saved them at every connection; when that person loses the vault policy the poll fails with 403 until someone saves the references again.'; ctx.rerender();
      } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'sessions'; st.query = st.query || ''; st.fkind = st.fkind || 'all'; st.fstate = st.fstate || 'live'; st.sstate = st.sstate || 'all'; st.ssort = st.ssort || 'activity';
      st.sessions = st.sessions || {}; st.tr = st.tr || {}; st.bounces = st.bounces || {}; st.drafts = st.drafts || {};
      const later = () => { if (App.state.route !== 'channels') return; if (overlayOpen()) { setTimeout(later, 250); return; } ctx.rerender(); };
      const load = (quiet) => {
        if (st.loading) { st.again = true; return; }
        st.loading = true;
        Promise.all([
          App.get('/api/channels'),
          App.get('/api/channels/held'),
          App.can('flags:review') ? App.get('/api/flags').catch(() => null) : null,
          App.get('/api/me/jobs').catch(() => [])
        ]).then(([chs, held, flags, jobs]) => {
          st.channels = chs; st.held = held; st.loaded = true; st.loadError = null;
          st.flags = {}; ((flags && flags.items) || []).forEach((f) => { st.flags[f.ref] = f; });
          st.jobs = (jobs || []).filter((j) => j.type === 'channels.export');
          // Sessions and transcripts in view are fetched again so a change made elsewhere shows.
          if (quiet) { st.sessions = {}; st.tr = {}; st.bounces = {}; }
        }).catch((err) => { if (!quiet) st.loadError = err; })
          .finally(() => { st.loading = false; if (st.again) { st.again = false; load(true); return; } later(); });
      };
      live.refresh = () => load(true);
      attach();
      if (!st.loaded) st.paramsFor = null;
      if (!st.loaded && !st.loadError) load();
      else if (st.quiet) { st.quiet = false; load(true); }
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Channels', 'Customer-service channels', '') + (st.loadError ? UI.problem('The channels could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      // Address parameters (a deep link) apply once per visit; later clicks on the screen win.
      if (st.paramsFor !== location.hash) {
        st.paramsFor = location.hash;
        if (ctx.params.channel) { st.sel = ctx.params.channel; st.sessionSel = null; }
        if (ctx.params.tab) st.tab = ctx.params.tab;
      }

      const list = st.channels.filter((c) => (!st.query || c.name.toLowerCase().includes(st.query.toLowerCase())) && (st.fkind === 'all' || c.kind === st.fkind) && (st.fstate === 'live' || c.state === st.fstate));
      if (!st.sel || !st.channels.some((c) => c.id === st.sel)) st.sel = list.length ? list[0].id : st.channels.length ? st.channels[0].id : null;
      const c = st.channels.find((x) => x.id === st.sel) || null;
      if (c && st.tab === 'email' && c.kind !== 'email') st.tab = 'sessions';
      const heldFor = (id) => st.held.filter((h) => h.channelId === id);

      const left = '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Channels</div>' + (st.held.length ? UI.pill(st.held.length + ' held', 'warn') : '') + '</div>'
        + UI.search('Search channels', 'data-search', st.query)
        + '<div class="hstack gap6 wrap"><span class="relative">' + UI.btn(st.fkind === 'all' ? 'Kind' : st.fkind, { size: 'xs', icon: 'filter', attrs: 'data-fkind', cls: st.fkind === 'all' ? '' : 'active' }) + '</span><span class="relative">' + UI.btn({ live: 'Active and paused', active: 'Active', paused: 'Paused' }[st.fstate], { size: 'xs', icon: 'filter', attrs: 'data-fstate', cls: st.fstate === 'live' ? '' : 'active' }) + '</span></div>'
        + '<div class="vstack" style="gap:2px">' + list.map((x) => UI.listItem(esc(x.name) + ' ' + UI.pill(x.kind, 'outline'), esc(wsName(x.workspaceId)) + ', review ' + esc(x.reviewMode) + (x.state === 'active' ? '' : ', ' + x.state), { active: x.id === st.sel, attrs: 'data-channel="' + esc(x.id) + '"', right: heldFor(x.id).length ? UI.pill(heldFor(x.id).length + ' held', 'warn') : UI.label(x.label, { sm: true }) })).join('')
        + (list.length ? '' : st.channels.length ? UI.empty('No channels match', 'Clear the filters.') : UI.empty('No channels yet', canManage() ? 'Create one to answer customers on a web chat or by email.' : 'A tenant admin creates channels; you review their sessions here.')) + '</div>'
        + (canManage() ? '<div style="margin-top:auto">' + UI.btn('New channel', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newchannel' }) + '</div>' : '') + '</div>';

      let page;
      if (!c) {
        page = UI.pagehead('Channels', 'Customer-service channels answer customers with a published profile or agent, at the channel\'s label.')
          + UI.empty('No channel to show', canManage() ? 'Create a chat or email channel. Its sessions, held replies and exports show here.' : 'No channel in your workspaces is within your clearance.', canManage() ? UI.btn('New channel', { kind: 'primary', icon: 'plus', attrs: 'data-newchannel' }) : '');
      } else {
        const chSessions = st.sessions[c.id];
        if (!chSessions && st.sessionsFor !== c.id) loadSessions(ctx, c.id).then(later);
        const ss = chSessions || [];
        const tabs = UI.tabs([{ id: 'sessions', label: 'Sessions', count: ss.filter((s) => s.state === 'open' || s.state === 'escalated').length }, { id: 'held', label: 'Held replies', count: heldFor(c.id).length }, { id: 'settings', label: 'Settings' }].concat(c.kind === 'email' ? [{ id: 'email', label: 'Email' }] : []).concat([{ id: 'exports', label: 'Exports' }]), st.tab);
        const head = UI.pagehead(esc(c.name), UI.pill(c.kind, 'outline') + ' · ' + esc(wsName(c.workspaceId)) + ' · answers with ' + esc(c.target.kind) + ' <a href="#" data-gotarget>' + esc(c.target.name) + '</a> · review mode ' + esc(c.reviewMode) + ' · retention ' + (c.retentionDays ? c.retentionDays + ' days' : 'keep') + ' · created ' + esc(when(c.createdAt)), statePill(c.state) + UI.label(c.label));
        let body = '';
        if (st.tab === 'sessions') body = sessionsTab(st, c, ss, !!chSessions);
        else if (st.tab === 'held') body = heldTab(st, c, heldFor(c.id));
        else if (st.tab === 'settings') body = settingsTab(st, c);
        else if (st.tab === 'email') {
          if (!st.bounces[c.id] && st.bouncesFor !== c.id) { st.bouncesFor = c.id; App.get('/api/channels/' + enc(c.id) + '/bounces').then((b) => { st.bounces[c.id] = b; }).catch((err) => { st.bounces[c.id] = { error: err }; }).finally(() => { st.bouncesFor = null; later(); }); }
          body = emailTab(st, c, ss);
        } else if (st.tab === 'exports') body = exportsTab(st, c);
        page = head + tabs + body;
      }

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .channels-held .hstack{gap:8px}#main .channels-reply{font-size:15px;line-height:1.5;padding:8px 10px;background:var(--panel2);border-radius:6px;margin:6px 0 4px;white-space:pre-wrap;overflow-wrap:anywhere}'
        + '#main .channels-msg{display:flex;flex-wrap:wrap;gap:4px 10px;padding:8px 10px;border-radius:6px}#main .channels-msg.customer{background:var(--panel2)}#main .channels-msg.assistant,#main .channels-msg.agent{background:var(--accent-tint)}#main .channels-msg.notice{color:var(--muted);font-size:12px}'
        + '#main .channels-msg .who{min-width:84px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}#main .channels-msg .body{flex:1 1 220px;min-width:0;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}'
        + '#main .channels-msg.held{outline:1px dashed var(--warn-fg)}#main .channels-msg.rejected .body > .t,#main .channels-msg.hidden .body > .t{text-decoration:line-through}'
        + '#main .channels-orig{font-size:12px;color:var(--muted);margin-top:4px;padding-left:8px;border-left:2px solid var(--line);white-space:normal}'
        + '#main .dt td > .mono:first-child{white-space:nowrap}#main .channels-mono{overflow-wrap:anywhere}'
        + '</style>'
        + left + '<div class="page">' + (st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-demook' })) : '') + page + '</div>';

      // ---- events ----
      const cur = () => st.channels.find((x) => x.id === st.sel);
      const sessionOf = (id) => (st.sessions[st.sel] || []).find((x) => x.id === id) || null;
      ctx.on('click', '[data-demook]', () => { st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-reload]', () => { st.loaded = false; ctx.rerender(); });
      ctx.on('click', '[data-tab]', (e, t) => { e.preventDefault(); st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.value = v; } });
      ctx.on('click', '[data-fkind]', (e, t) => menu(ctx, t, [['all', 'Any kind'], ['chat', 'Chat'], ['email', 'Email']], st.fkind, (v) => { st.fkind = v; ctx.rerender(); }));
      ctx.on('click', '[data-fstate]', (e, t) => menu(ctx, t, [['live', 'Active and paused'], ['active', 'Active'], ['paused', 'Paused']], st.fstate, (v) => { st.fstate = v; ctx.rerender(); }));
      ctx.on('click', '[data-channel]', (e, t) => { st.sel = t.dataset.channel; st.sessionSel = null; st.vaultProblem = false; st.mailFailedNote = false; st.rotated = null; ctx.rerender(); });
      ctx.on('click', '[data-gotarget]', (e) => { e.preventDefault(); const x = cur(); ctx.navigate(x.target.kind === 'profile' ? 'profiles' : 'registry', x.target.kind === 'profile' ? { profile: x.target.name } : {}); });
      ctx.on('click', '[data-goflags]', () => ctx.navigate('flags'));
      ctx.on('click', '[data-openflag]', (e, t) => { e.preventDefault(); ctx.navigate('flags', { id: t.dataset.openflag }); });
      ctx.on('click', '[data-newchannel]', () => newChannelModal(ctx));
      if (st.openNew) { st.openNew = false; if (canManage()) setTimeout(() => newChannelModal(ctx), 50); }
      // sessions
      ctx.on('click', '[data-sstate] [data-seg]', (e, t) => { st.sstate = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-ssort]', (e, t) => menu(ctx, t, [['activity', 'Newest activity'], ['started', 'Newest first'], ['escalated', 'Escalated first']], st.ssort, (v) => { st.ssort = v; ctx.rerender(); }));
      ctx.on('click', 'tr[data-session]', (e, t) => { st.sessionSel = t.dataset.session; ctx.rerender(); });
      ctx.on('click', '[data-opensession]', (e, t) => { e.preventDefault(); const sid = t.dataset.opensession; const h = st.held.find((x) => x.sessionId === sid); if (h) st.sel = h.channelId; st.tab = 'sessions'; st.sstate = 'all'; st.sessionSel = sid; delete st.tr[sid]; ctx.rerender(); });
      ctx.on('input', '[data-replydraft]', (e, t) => { st.drafts[st.sessionSel] = t.value; });
      ctx.on('click', '[data-reply]', () => {
        const s = sessionOf(st.sessionSel); const text = (st.drafts[st.sessionSel] || '').trim();
        if (!s) return;
        if (!text) { ctx.toast('Write the answer first.', 'warn'); return; }
        App.post('/api/channels/' + enc(st.sel) + '/sessions/' + enc(s.id) + '/messages', { text }).then(() => {
          st.drafts[s.id] = ''; delete st.tr[s.id]; delete st.sessions[st.sel]; ctx.rerender();
          ctx.toast('Answered as a person (role agent)' + (cur().kind === 'email' ? '; queued in the outbox.' : '; delivered at once.'), 'ok');
        }).catch((err) => App.fail(err, 'Not sent'));
      });
      ctx.on('click', '[data-closesession]', async () => {
        const s = sessionOf(st.sessionSel); if (!s) return;
        const ok = await ctx.confirm({ title: 'Close session', tone: 'info', body: '<p style="margin:0" class="fg2">The customer\'s token stops working. ' + (cur().kind === 'email' ? 'A reply from the customer reopens the session.' : 'An identified customer who comes back starts a new session.') + ' Event channel.session.closed.</p>', kv: [['Customer', esc(s.customer.name || s.customer.kind)], ['Messages', String(s.messages)]], ok: 'Close session' });
        if (!ok) return;
        App.post('/api/channels/' + enc(st.sel) + '/sessions/' + enc(s.id) + '/close').then(() => { delete st.tr[s.id]; delete st.sessions[st.sel]; st.quiet = true; ctx.rerender(); ctx.toast('Session closed. The customer\'s token stopped working.', ''); }).catch((err) => App.fail(err, 'Not closed'));
      });
      ctx.on('click', '[data-exportcsv]', () => { const s = sessionOf(st.sessionSel); if (!s) return; download('/api/channels/' + enc(st.sel) + '/sessions/' + enc(s.id) + '/transcript.csv', 'session-' + s.id + '.csv').then(() => ctx.toast('Downloading the transcript (' + s.messages + ' rows). Audited as channel.transcript.exported.', 'ok')).catch((err) => App.fail(err, 'Not downloaded')); });
      ctx.on('click', '[data-reportmsg]', (e, t) => reportModal(ctx, t.dataset.reportmsg, t.dataset.seq));
      ctx.on('click', '[data-held]', (e, t) => { const h = st.held.find((x) => x.id === t.dataset.id); if (h) decideHeld(ctx, h, t.dataset.held); });
      ctx.on('click', '[data-clearhelddone]', () => { st.heldDone = null; ctx.rerender(); });
      // settings
      ctx.on('click', '[data-savechannel]', () => saveChannel(ctx, cur()));
      ctx.on('click', '[data-savemail]', () => saveMail(ctx, cur()));
      ctx.on('click', '[data-pause]', async () => {
        const x = cur();
        const ok = await ctx.confirm({ title: 'Pause ' + x.name, tag: 'refuses new sessions', tone: 'danger', body: '<p style="margin:0" class="fg2">New public sessions answer 404 and customer tokens stop working until the channel is active again. Open sessions and held replies are kept.</p>', ok: 'Pause' });
        if (!ok) return;
        App.patch('/api/channels/' + enc(x.id), { state: 'paused' }).then((v) => { replaceChannel(st, v); ctx.rerender(); ctx.toast(esc(x.name) + ' paused.', 'warn'); }).catch((err) => App.fail(err, 'Not paused'));
      });
      ctx.on('click', '[data-resume]', () => { const x = cur(); App.patch('/api/channels/' + enc(x.id), { state: 'active' }).then((v) => { replaceChannel(st, v); ctx.rerender(); ctx.toast(esc(x.name) + ' is active again; new sessions are accepted.', 'ok'); }).catch((err) => App.fail(err, 'Not resumed')); });
      ctx.on('click', '[data-purge]', async () => {
        const x = cur();
        const ok = await ctx.confirm({ title: 'Run the retention purge now', tone: 'info', body: '<p style="margin:0" class="fg2">' + (x.retentionDays ? 'Sessions idle for more than ' + x.retentionDays + ' days are deleted with their messages, threads and outbox rows; open hold flags of their replies are closed as rejected.' : 'This channel keeps its sessions; the purge covers the tenant\'s other channels.') + ' Audited per channel as channel.session.purged.</p>', ok: 'Run purge' });
        if (!ok) return;
        App.post('/api/channels/' + enc(x.id) + '/purge').then((r) => ctx.toast('Retention purge queued (job <span class="mono">' + esc(r.jobId) + '</span>).', 'ok', 5000)).catch((err) => App.fail(err, 'Not queued'));
      });
      ctx.on('click', '[data-poll]', () => { const x = cur(); App.post('/api/channels/' + enc(x.id) + '/poll').then((r) => { st.polled = x.id; ctx.rerender(); ctx.toast('channels.imap-poll job queued (<span class="mono">' + esc(r.jobId) + '</span>).', 'ok'); }).catch((err) => App.fail(err, 'Not polled')); });
      ctx.on('click', '[data-delete]', async () => {
        const x = cur(); const open = (st.sessions[x.id] || []).filter((s) => s.state === 'open' || s.state === 'escalated').length;
        const ok = await ctx.confirm({ title: 'Delete ' + x.name, tag: 'closes open sessions', tone: 'danger', body: '<p style="margin:0" class="fg2">The channel is deleted and its open sessions are closed; customer tokens stop working. Transcripts stay until the retention purge.</p>', kv: [['Open sessions', String(open)]], ok: 'Delete channel' });
        if (!ok) return;
        App.del('/api/channels/' + enc(x.id)).then((r) => { st.channels = st.channels.filter((y) => y.id !== x.id); st.sel = null; st.tab = 'sessions'; ctx.rerender(); ctx.toast(esc(x.name) + ' deleted; ' + r.sessionsClosed + ' open session' + (r.sessionsClosed === 1 ? '' : 's') + ' closed.', 'warn'); }).catch((err) => App.fail(err, 'Not deleted'));
      });
      ctx.on('click', '[data-rotate]', async (e, t) => {
        const x = cur(); const which = t.dataset.rotate;
        const ok = await ctx.confirm({ title: 'Rotate ' + which + ' secret', tag: 'old secret stops at once', tone: 'danger', body: '<p style="margin:0" class="fg2">' + (which === 'identity' ? 'Identity assertions signed with the old secret are refused from now on; update the site first.' : 'Inbound mail webhooks signed with the old secret are refused (401); update the provider.') + ' The new value is shown once.</p>', ok: 'Rotate' });
        if (!ok) return;
        App.post('/api/channels/' + enc(x.id) + '/secrets', { which }).then((r) => { st.rotated = { channel: x.id, which, value: r.identitySecret || r.webhookSecret }; ctx.rerender(); ctx.toast('Secret rotated. Copy it now.', 'warn'); }).catch((err) => App.fail(err, 'Not rotated'));
      });
      ctx.on('click', '[data-rotatedone]', () => { st.rotated = null; ctx.rerender(); });
      ctx.on('click', '[data-copyval]', (e, t) => { const v = t.dataset.copyval; if (navigator.clipboard) navigator.clipboard.writeText(v).then(() => ctx.toast('Copied to the clipboard.'), () => ctx.toast('Select the text and copy it.', 'warn')); else ctx.toast('Select the text and copy it.', 'warn'); });
      // email
      ctx.on('click', '[data-clearmail]', () => { st.mailFailedNote = false; ctx.rerender(); });
      // exports
      ctx.on('click', '[data-export]', () => {
        const x = cur(); const from = (ctx.$('[data-xfrom]') || {}).value, to = (ctx.$('[data-xto]') || {}).value;
        const body = {}; if (from) body.from = new Date(from + 'T00:00:00').toISOString(); if (to) body.to = new Date(to + 'T23:59:59').toISOString();
        App.post('/api/channels/' + enc(x.id) + '/exports', body).then((r) => { exportChannel[r.jobId] = x.id; st.quiet = true; ctx.rerender(); ctx.toast('Export queued (job <span class="mono">' + esc(r.jobId) + '</span>). You are notified when the CSV is ready.', 'ok'); }).catch((err) => App.fail(err, 'Export not started'));
      });
      ctx.on('click', '[data-download]', (e, t) => { const id = t.dataset.download; download('/api/channels/exports/' + enc(id), 'channel-export-' + id + '.csv').then(() => ctx.toast('Downloading the export. Audited as channel.transcript.exported.', 'ok')).catch((err) => App.fail(err, 'Not downloaded')); });
      ctx.on('click', '[data-refreshjobs]', () => { st.quiet = true; ctx.rerender(); });
    }
  });

  function replaceChannel(st, v) { st.channels = st.channels.map((x) => (x.id === v.id ? v : x)); }

  function loadSessions(ctx, chId) {
    const st = ctx.state; st.sessionsFor = chId;
    return App.get('/api/channels/' + enc(chId) + '/sessions?limit=200').then((rows) => { st.sessions[chId] = rows; }).catch((err) => { st.sessions[chId] = []; App.fail(err, 'Sessions not loaded'); }).finally(() => { st.sessionsFor = null; });
  }

  function sessionsTab(st, c, chSessions, loaded) {
    let rows = chSessions.filter((s) => st.sstate === 'all' || s.state === st.sstate);
    rows = rows.slice().sort((a, b) => (st.ssort === 'started' ? b.createdAt - a.createdAt : st.ssort === 'escalated' ? ((b.state === 'escalated') - (a.state === 'escalated')) || b.lastActivityAt - a.lastActivityAt : b.lastActivityAt - a.lastActivityAt));
    if (st.sessionSel && loaded && !chSessions.some((s) => s.id === st.sessionSel)) st.sessionSel = null;
    const s = chSessions.find((x) => x.id === st.sessionSel) || null;
    const heldSessions = new Set(st.held.map((h) => h.sessionId));
    return (c.state === 'paused' ? UI.notice('<b>Paused.</b> New sessions are refused (404) and customer tokens have stopped working until the channel is active again. Open sessions are kept.', 'warn', canManage() ? UI.btn('Resume', { size: 'sm', attrs: 'data-resume' }) : '') : '')
      + UI.panel('Sessions', '<div class="toolbar wrap">' + UI.seg([{ id: 'all', label: 'All' }, { id: 'open', label: 'Open' }, { id: 'escalated', label: 'Escalated' }, { id: 'closed', label: 'Closed' }, { id: 'hidden', label: 'Hidden' }], st.sstate, 'data-sstate aria-label="Session state"') + '<span class="relative">' + UI.btn({ activity: 'Newest activity', started: 'Newest first', escalated: 'Escalated first' }[st.ssort], { size: 'sm', icon: 'sort', attrs: 'data-ssort' }) + '</span>' + small(loaded ? rows.length + ' of ' + chSessions.length + ' sessions; within your workspaces and clearance only' : 'Loading sessions') + '</div>'
        + UI.table(['Session', 'State', 'Customer', 'Subject', { label: 'Messages', right: true }, 'Started', 'Last activity'], rows.map((x) => ({ cells: ['<span class="mono">' + esc(x.id.slice(-8)) + '</span>', statePill(x.state) + (x.state === 'escalated' && x.escalation ? '<br>' + small(esc(x.escalation)) : ''), x.customer.kind === 'anonymous' ? esc(x.customer.name || 'Visitor') + ' ' + UI.pill('anonymous', 'outline') : esc(x.customer.name || '') + (x.customer.email ? '<br>' + small(esc(x.customer.email)) : ''), esc(x.subject || ''), '<span class="num">' + x.messages + '</span>' + (heldSessions.has(x.id) ? ' ' + UI.pill('held', 'warn') : ''), esc(when(x.createdAt)), esc(when(x.lastActivityAt))], attrs: 'data-session="' + esc(x.id) + '"', selected: x.id === st.sessionSel })), { minWidth: '820px', emptyTitle: loaded ? 'No sessions' : 'Loading sessions', emptyText: loaded ? (chSessions.length ? 'Nothing in this state.' : 'Customers start sessions through the public channel API with the key on the Settings tab.') : '' }))
      + (s ? transcriptPanel(st, c, s) : small('Pick a session to read its transcript, answer as a person, close it or export it.'));
  }

  function transcriptPanel(st, c, s) {
    const t = st.tr[s.id];
    if (!t && st.trFor !== s.id) {
      st.trFor = s.id;
      App.get('/api/channels/' + enc(c.id) + '/sessions/' + enc(s.id)).then((r) => { st.tr[s.id] = r; }).catch((err) => { st.tr[s.id] = { error: err }; }).finally(() => { st.trFor = null; if (App.state.route === 'channels' && !overlayOpen()) App.render(); });
    }
    if (!t || t.error) return UI.panel('Transcript', t && t.error ? UI.problem('The transcript could not be loaded', t.error.message, t.error.problem && t.error.problem.trace_id) : UI.notice('Loading…', 'info'));
    const me = meId();
    const msgs = t.transcript.map((m) => '<div class="channels-msg ' + esc(m.role) + ' ' + esc(m.state) + '" data-seq="' + m.seq + '"><span class="who">' + esc(m.role === 'agent' ? (m.authorId && m.authorId === me ? 'you' : 'person') : m.role) + '</span><div class="body">'
      + (m.state === 'hidden' ? '<span class="muted">Hidden by moderation.</span>' : '<span class="t">' + esc(m.text || '') + '</span>')
      + (m.original ? '<div class="channels-orig">Model wrote: ' + esc(m.original) + '</div>' : '')
      + (m.state === 'held' ? '<div class="channels-orig">Held for review' + (m.flag ? ', flag <a href="#" data-openflag="' + esc(m.flag.ref) + '">' + esc(m.flag.ref) + '</a>' : '') + '; the customer sees state: pending. <a href="#" data-tab="held">Decide on the Held replies tab</a>.</div>' : '')
      + (m.state === 'rejected' ? '<div class="channels-orig">Rejected by a reviewer. The customer was told a person will follow up.</div>' : '')
      + '</div><span class="muted" style="font-size:12px;white-space:nowrap">' + esc(when(m.createdAt)) + ' · ' + esc(m.via) + (m.state === 'delivered' || m.role === 'customer' ? '' : ' · ' + esc(m.state)) + '</span>'
      + (m.role !== 'notice' && m.state !== 'hidden' && App.can('moderation:report') ? UI.iconbtn('flag', 'Report message ' + m.seq, { attrs: 'data-reportmsg="' + esc(m.id) + '" data-seq="' + m.seq + '"', cls: 'sm ghost' }) : '') + '</div>').join('');
    const canAnswer = s.state === 'open' || s.state === 'escalated';
    const outbox = (t.outbox || []).length ? '<div class="divider"></div><div class="eyebrow">Email outbox</div>' + UI.table(['Row', 'State', { label: 'Attempts', right: true }, 'Sent', 'Error'], t.outbox.map((o) => ['<span class="mono">' + esc(o.id.slice(-8)) + '</span>', UI.pill(o.state, o.state === 'sent' ? 'ok' : o.state === 'failed' || o.state === 'bounced' ? 'danger' : 'info'), '<span class="num">' + o.attempts + '</span>', esc(when(o.sentAt)), esc(o.error || '')]), { clickable: false, minWidth: '0' }) : '';
    return (s.state === 'escalated' ? UI.notice('<b>Escalated ' + esc(when(s.escalatedAt)) + (s.escalation ? ': ' + esc(s.escalation) : '') + '.</b> Reviewers holding channels:review in ' + esc(wsName(c.workspaceId)) + ' were notified.' + (c.reviewMode === 'escalated' ? ' Every answer on this session now waits for a reviewer.' : ''), 'warn') : '')
      + (s.state === 'hidden' ? UI.notice('<b>Hidden by moderation.</b> The customer\'s token stopped working and the transcript is shown to reviewers only.', 'danger') : '')
      + UI.panel('Transcript of session ' + esc(s.id.slice(-8)), '<div class="hstack wrap" style="margin-bottom:8px">' + statePill(s.state) + '<span class="fg2">' + esc(s.customer.name || s.customer.kind) + (s.customer.email ? ', ' + esc(s.customer.email) : '') + (s.customer.externalId ? ', <span class="mono">' + esc(s.customer.externalId) + '</span>' : '') + '</span><span class="grow"></span>' + UI.label(s.label, { sm: true }) + small('started ' + esc(when(s.createdAt)) + ', ' + esc(c.kind)) + '</div>'
        + '<div class="vstack gap6" data-transcript>' + (msgs || small('No messages in this session yet.')) + '</div>'
        + (canAnswer ? '<div style="margin-top:10px">' + UI.field('Answer as a person', UI.textarea(st.drafts[s.id] || '', { rows: 2, placeholder: 'Delivered at once' + (c.kind === 'email' && c.email ? ' by email from ' + c.email.address : '') + ' (role agent).', attrs: 'data-replydraft' })) + '</div>' : '') + outbox,
      { actions: (canAnswer ? UI.btn('Send answer', { kind: 'primary', size: 'sm', icon: 'send', attrs: 'data-reply' }) + UI.btn('Close session', { size: 'sm', attrs: 'data-closesession' }) : '') + UI.btn('Transcript CSV', { kind: 'ghost', size: 'sm', icon: 'download', attrs: 'data-exportcsv' }) });
  }

  function whyHeld(st, h, c) {
    const f = h.flag && st.flags ? st.flags[h.flag.ref] : null;
    if (f && f.checkpoint === 'model-output') return 'A guardrail held the answer at the model-output checkpoint' + (f.rule ? ' (' + f.rule + ')' : '') + '.';
    if (c && c.reviewMode === 'always') return 'Review mode always: every answer on this channel waits for a reviewer.';
    if (c && c.reviewMode === 'escalated') return 'Review mode escalated: the session was escalated, so every answer waits for a reviewer.';
    return 'Held for review.';
  }

  function heldTab(st, c, hs) {
    return UI.notice('<b>Held replies wait in the workspace flag queue too.</b> Flags can approve or reject them (flags:review); editing the text before it goes out needs this screen. The customer sees <span class="mono">state: pending</span> until you decide. Approve delivers the reply as written; edit delivers your text and keeps the model\'s as original; reject withdraws it and tells the customer a person will follow up.', 'info', App.can('flags:review') ? UI.btn('Open Flags', { kind: 'ghost', size: 'sm', attrs: 'data-goflags' }) : '')
      + (st.heldDone ? UI.notice(st.heldDone, 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearhelddone' })) : '')
      + (hs.length ? hs.map((h) => {
        const f = h.flag && st.flags ? st.flags[h.flag.ref] : null;
        const l = f && f.dueAt ? minsLeft(f) : null;
        return '<div class="panel channels-held" data-heldreply="' + esc(h.id) + '"><div class="hstack wrap">' + (h.flag ? '<span class="mono">' + esc(h.flag.ref) + '</span>' : '') + (f ? UI.pill(f.checkpoint, f.checkpoint === 'model-output' ? 'danger' : 'info') : '') + '<span class="fg2">session <a href="#" data-opensession="' + esc(h.sessionId) + '">' + esc(h.sessionId.slice(-8)) + '</a>, held ' + esc(when(h.createdAt)) + '</span><span class="grow"></span>' + (l == null ? '' : l < 0 ? '<span style="color:var(--danger-fg)">' + esc(timeText(l)) + '</span>' : small(esc(timeText(l)) + (f.slaMinutes ? ' of ' + f.slaMinutes + ' min' : ''))) + '</div>'
          + '<div class="channels-reply serif">' + esc(h.text || '') + '</div>' + small(esc(whyHeld(st, h, c)))
          + '<div class="hstack wrap gap6" style="margin-top:8px">' + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-held="approve" data-id="' + esc(h.id) + '"' }) + UI.btn('Edit and send', { size: 'sm', icon: 'edit', attrs: 'data-held="edit" data-id="' + esc(h.id) + '"' }) + UI.btn('Reject', { kind: 'danger', size: 'sm', attrs: 'data-held="reject" data-id="' + esc(h.id) + '"' }) + (h.flag && App.can('flags:review') ? UI.btn('Open flag', { kind: 'ghost', size: 'sm', attrs: 'data-openflag="' + esc(h.flag.ref) + '"' }) : '') + '</div></div>';
      }).join('') : UI.empty('Nothing held', 'Replies waiting for review on ' + c.name + ' appear here, oldest first.'));
  }

  function settingsTab(st, c) {
    const ro = !canManage();
    const dis = ro ? ' disabled' : '';
    const targets = (st.targets && st.targets.list) || [];
    if (!st.targets && !ro) { st.targets = { list: null }; loadTargets(st).then(() => { if (App.state.route === 'channels' && !overlayOpen()) App.render(); }); }
    const tcur = c.target.kind + ' ' + c.target.name;
    const topts = (targets.some((x) => x.value === tcur) ? [] : [{ value: tcur, label: tcur }]).concat(targets);
    return (ro ? UI.notice('You can read these settings; changing a channel needs <span class="mono">channels:manage</span> (tenant admins).', 'info') : '')
      + (c.state === 'paused' ? UI.notice('<b>Paused since ' + esc(when(c.updatedAt)) + '.</b> New sessions are refused with 404 and customer tokens have stopped working; open sessions and held replies are kept until it is active again.', 'warn', ro ? '' : UI.btn('Resume', { size: 'sm', kind: 'primary', attrs: 'data-resume' })) : '')
      + (st.vaultProblem && c.kind === 'email' ? UI.problem('Vault reference not readable', 'Mail credentials are read as the person who saved them, at every connection. If that person loses read on the path, the IMAP poll and the SMTP send fail with 403 (step vault-policy, audited as vault.denied) and the mailbox is not read. Save the references again as yourself below, or restore their grant in Vault.', false) : '')
      + UI.panel('Channel', '<div class="formgrid" style="--cols:3">' + UI.field('Name', UI.input(c.name, { attrs: 'data-cname' + dis })) + UI.field('Label', UI.select(LABELS, c.label, 'data-clabel' + dis), 'Under the workspace ceiling, your clearance and the target\'s label; a pool below it is never leased') + UI.field('Review mode', UI.select([{ value: 'never', label: 'never: answers go straight out unless a guardrail holds them' }, { value: 'escalated', label: 'escalated: once escalated, every answer waits' }, { value: 'always', label: 'always: every answer waits' }], c.reviewMode, 'data-creview' + dis))
        + UI.field('Target', UI.select(topts, tcur, 'data-ctarget' + dis), 'Customer channels never run an agent\'s tools; 422 step target when it cannot answer at the label') + UI.field('Messages per minute', UI.input(String(c.messagesPerMinute), { type: 'number', attrs: 'min="1" data-cmpm' + dis })) + UI.field('Sessions per hour', UI.input(String(c.sessionsPerHour), { type: 'number', attrs: 'min="1" data-csph' + dis })) + UI.field('Retention (days)', UI.input(c.retentionDays == null ? '' : String(c.retentionDays), { type: 'number', attrs: 'min="1" data-cret' + dis, placeholder: 'empty keeps sessions' }), 'Sessions idle longer are purged with their messages, threads and outbox rows') + '</div>'
        + UI.field('Instructions', UI.textarea(c.instructions || '', { rows: 3, attrs: 'data-cinstr' + dis })) + (c.kind === 'chat' ? UI.field('Greeting', UI.input(c.greeting || '', { attrs: 'data-cgreet' + dis })) : '') + UI.toggle('Allow anonymous customers', c.allowAnonymous, 'data-canon' + (ro ? ' data-manual disabled' : ''))
        + (ro ? '' : '<div class="hstack wrap gap6" style="margin-top:8px">' + UI.btn('Save', { kind: 'primary', size: 'sm', attrs: 'data-savechannel' }) + (c.state === 'active' ? UI.btn('Pause', { size: 'sm', icon: 'pause', attrs: 'data-pause' }) : UI.btn('Resume', { size: 'sm', icon: 'play', attrs: 'data-resume' })) + UI.btn('Run retention purge now', { size: 'sm', attrs: 'data-purge' }) + (c.kind === 'email' && c.email && c.email.imap ? UI.btn('Poll mailbox now', { size: 'sm', icon: 'refresh', attrs: 'data-poll' }) : '') + UI.btn('Delete channel', { kind: 'danger', size: 'sm', attrs: 'data-delete' }) + '</div>'))
      + UI.panel('Keys and secrets', UI.kv([['Public key', '<span class="mono channels-mono" data-publickey>' + esc(c.publicKey) + '</span> ' + small('the site passes it to start a session')], ['Identity secret', small('stored sealed; signs the site\'s customer identity assertions') + (ro ? '' : '<br>' + UI.btn('Rotate', { size: 'xs', attrs: 'data-rotate="identity"' }))], ['Webhook secret', c.kind === 'email' ? small('stored sealed; signs generic inbound mail webhooks') + (ro ? '' : '<br>' + UI.btn('Rotate', { size: 'xs', attrs: 'data-rotate="webhook"' })) : small('chat channels have none')], ['Public endpoints', '<span class="mono channels-mono" style="font-size:12px">POST /api/public/channels/sessions</span>' + (c.webhooks ? '<br><span class="mono channels-mono" style="font-size:12px">POST ' + esc(c.webhooks.generic) + '</span><br><span class="mono channels-mono" style="font-size:12px">POST ' + esc(c.webhooks.mailgun) + '</span>' : '')]], 2)
        + (st.rotated && st.rotated.channel === c.id ? UI.notice('<b>New ' + esc(st.rotated.which) + ' secret. Copy it now; it is shown once.</b> ' + (st.rotated.created ? '' : 'The old one stopped working at once.') + '<div class="mono channels-mono" style="margin-top:4px" data-secret>' + esc(st.rotated.value) + '</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-copyval="' + esc(st.rotated.value) + '"' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-rotatedone' })) : ''))
      + (c.kind === 'email' ? mailPanel(c, ro) : '');
  }

  function mailPanel(c, ro) {
    const e = c.email || { address: '', fromName: '', imap: null, smtp: null, mailgunKeyRef: '' };
    const dis = ro ? ' disabled' : '';
    const hp = (x, d) => (x ? x.host + ':' + (x.port || d) : '');
    return UI.panel('Mail settings', '<div class="formgrid" style="--cols:3">' + UI.field('Address', UI.input(e.address || '', { attrs: 'data-eaddr' + dis })) + UI.field('From name', UI.input(e.fromName || '', { attrs: 'data-efrom' + dis })) + UI.field('Mailgun signing key', UI.input(e.mailgunKeyRef || '', { attrs: 'data-emg' + dis, placeholder: 'vault:kv/channels/orders#mailgun' }), 'Without it the Mailgun endpoint is 404')
      + UI.field('IMAP host:port', UI.input(hp(e.imap, 993), { attrs: 'data-eimap' + dis, placeholder: 'imap.example.com:993' })) + UI.field('IMAP user', UI.input(e.imap ? e.imap.user : '', { attrs: 'data-eimapuser' + dis })) + UI.field('IMAP password', UI.input(e.imap ? e.imap.passwordRef : '', { attrs: 'data-eimappw' + dis, placeholder: 'vault:kv/channels/orders#imap' }), 'A vault: reference only; a literal password is 400')
      + UI.field('SMTP host:port', UI.input(hp(e.smtp, 465), { attrs: 'data-esmtp' + dis, placeholder: 'smtp.example.com:465' })) + UI.field('SMTP user', UI.input(e.smtp ? e.smtp.user : '', { attrs: 'data-esmtpuser' + dis })) + UI.field('SMTP password', UI.input(e.smtp ? e.smtp.passwordRef : '', { attrs: 'data-esmtppw' + dis, placeholder: 'vault:kv/channels/orders#smtp' }), 'Read as the saver at every connection') + '</div>'
      + UI.toggle('Implicit TLS (otherwise STARTTLS is required)', e.imap ? e.imap.secure !== false : true, 'data-etls' + (ro ? ' data-manual disabled' : ''))
      + (ro ? '' : '<div class="hstack gap6 wrap" style="margin-top:8px">' + UI.btn('Save mail settings', { kind: 'primary', size: 'sm', attrs: 'data-savemail' }) + small('Hosts pass the service address rules and the tenant\'s allowed hosts at every connection.') + '</div>'));
  }

  function emailTab(st, c, ss) {
    const b = st.bounces[c.id];
    const bl = b && !b.error ? b : [];
    const e = c.email || {};
    return (st.mailFailedNote ? UI.notice('<b>A reply fails after five attempts.</b> The channels.send job then marks its outbox row failed and audits channel.mail.failed; the customer has not received the answer. Open the session (its outbox is under the transcript) and answer again, or fix the SMTP route.', 'danger', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearmail' })) : '')
      + '<div class="grid3">' + UI.stat(String(ss.filter((s) => s.state === 'open' || s.state === 'escalated').length), 'open email sessions', small('each session lists its outbox under the transcript')) + UI.stat(String(bl.filter((x) => x.kind === 'hard' || x.kind === 'complaint').length), 'hard bounces and complaints', small('the outbox row is marked bounced')) + UI.stat(String(bl.length), 'bounces recorded', small('DSN by IMAP, generic and Mailgun events')) + '</div>'
      + '<div class="cols">' + UI.panel('Bounces', b && b.error ? UI.problem('Bounces could not be loaded', b.error.message, b.error.problem && b.error.problem.trace_id) : UI.table(['Kind', 'Outbox row', 'Status', 'Reason', 'Source', 'When'], bl.map((x) => [UI.pill(x.kind, x.kind === 'hard' || x.kind === 'complaint' ? 'danger' : 'warn'), '<span class="mono">' + esc(String(x.outboxId || '').slice(-8)) + '</span>', '<span class="mono">' + esc(x.status || '') + '</span>', esc(x.reason || ''), UI.pill(x.source, 'outline'), esc(when(x.createdAt))]), { clickable: false, minWidth: '0', emptyTitle: b ? 'No bounces' : 'Loading bounces', emptyText: b ? 'Delivery reports and provider bounce events show here.' : '' }), { cls: 'grow' })
        + UI.panel('Mailbox', UI.kv([['Address', esc(e.address || 'not set')], ['IMAP', e.imap ? '<span class="mono">' + esc(e.imap.mailbox || 'INBOX') + '</span> on ' + esc(e.imap.host) + ':' + esc(e.imap.port) : 'not configured (webhooks only)'], ['SMTP', e.smtp ? esc(e.smtp.host) + ':' + esc(e.smtp.port) : 'the server\'s SMTP_URL'], ['Webhooks', c.webhooks ? 'generic and ' + (e.mailgunKeyRef ? 'Mailgun' : 'Mailgun (off without a signing key)') : 'none'], ['Ignored', 'auto-submitted, bulk and list mail, mailer daemons, mail from the channel\'s own address; messages over 10 MB']], 1) + (e.imap && canManage() ? '<div style="margin-top:8px">' + UI.btn('Poll now', { size: 'sm', icon: 'refresh', attrs: 'data-poll' }) + (st.polled === c.id ? ' ' + UI.pill('job queued', 'info') : '') + '</div>' : ''), { cls: 'w360' }) + '</div>'
      + small('Replies go from ' + esc(e.address || 'the channel\'s address') + ' with In-Reply-To and References threading and Auto-Submitted: auto-replied on model-written answers. A reply joins a session only when its In-Reply-To or References name one of that session\'s Message-IDs and it comes from the session\'s customer address.');
  }

  function exportsTab(st, c) {
    const today = new Date(); const ago = new Date(Date.now() - 30 * 86400000);
    const d = (x) => x.toISOString().slice(0, 10);
    const jobs = st.jobs || [];
    return UI.panel('Export sessions as CSV', '<div class="formgrid" style="--cols:3">' + UI.field('From', UI.input(d(ago), { type: 'date', attrs: 'data-xfrom' })) + UI.field('To', UI.input(d(today), { type: 'date', attrs: 'data-xto' })) + '<div class="field"><span class="fl" aria-hidden="true">&nbsp;</span>' + UI.btn('Start export', { kind: 'primary', attrs: 'data-export' }) + '</div></div>' + small('Every session of ' + esc(c.name) + ' created in the window (at most 10,000, those within your clearance) as one CSV, built by a channels.export job and sealed in the blob store. Columns: channel, session, seq, time, role, state, via, label, text, original; a leading = + - @ is made inert. Downloading is audited as channel.transcript.exported.'))
      + UI.panel('Your exports', UI.table(['Job', 'Channel', 'State', 'Progress', 'Started', { label: '', srLabel: 'Download' }], jobs.map((j) => { const ch = exportChannel[j.id] ? st.channels.find((x) => x.id === exportChannel[j.id]) : null; return ['<span class="mono">' + esc(j.id.slice(-8)) + '</span>', ch ? esc(ch.name) : small('any channel'), UI.pill(j.state, j.state === 'succeeded' ? 'ok' : j.state === 'failed' ? 'danger' : 'info'), esc(j.message || (j.progress != null ? j.progress + '%' : '')), esc(when(j.createdAt)), j.state === 'succeeded' ? UI.btn('Download', { size: 'xs', icon: 'download', attrs: 'data-download="' + esc(j.id) + '"' }) : j.error ? small(esc(j.error)) : '']; }), { clickable: false, minWidth: '0', emptyTitle: 'No exports', emptyText: 'Start one above. Only the person who started an export can download it.' }), { actions: UI.btn('Refresh', { kind: 'ghost', size: 'xs', icon: 'refresh', attrs: 'data-refreshjobs' }) });
  }

  function loadTargets(st) {
    return Promise.all([App.can('chat:read') ? App.get('/api/chat/profiles').catch(() => []) : [], App.can('agents:run') ? App.get('/api/agents').catch(() => []) : []]).then(([ps, ags]) => {
      st.targets = { list: ps.map((p) => ({ value: 'profile ' + p.name, label: 'profile ' + p.name })).concat(ags.map((a) => ({ value: 'agent ' + a.name, label: 'agent ' + a.name }))) };
    });
  }

  function saveChannel(ctx, c) {
    const st = ctx.state; const $ = (s) => ctx.$(s);
    const target = $('[data-ctarget]').value; const sp = target.indexOf(' ');
    const patch = {};
    const name = $('[data-cname]').value.trim(); if (name && name !== c.name) patch.name = name;
    const label = $('[data-clabel]').value; if (label !== c.label) patch.label = label;
    const rm = $('[data-creview]').value; if (rm !== c.reviewMode) patch.reviewMode = rm;
    if (target !== c.target.kind + ' ' + c.target.name) patch.target = { kind: target.slice(0, sp), name: target.slice(sp + 1) };
    const mpm = num($('[data-cmpm]').value); if (mpm && mpm !== c.messagesPerMinute) patch.messagesPerMinute = mpm;
    const sph = num($('[data-csph]').value); if (sph && sph !== c.sessionsPerHour) patch.sessionsPerHour = sph;
    const ret = num($('[data-cret]').value); if (ret !== c.retentionDays) patch.retentionDays = ret;
    const instr = $('[data-cinstr]').value.trim(); if (instr !== (c.instructions || '')) patch.instructions = instr || null;
    if ($('[data-cgreet]')) { const g = $('[data-cgreet]').value.trim(); if (g !== (c.greeting || '')) patch.greeting = g || null; }
    const anon = $('[data-canon]').classList.contains('on'); if (anon !== c.allowAnonymous) patch.allowAnonymous = anon;
    if (!Object.keys(patch).length) { ctx.toast('Nothing changed.'); return; }
    App.patch('/api/channels/' + enc(c.id), patch).then((v) => { replaceChannel(st, v); ctx.rerender(); ctx.toast('Channel saved' + (patch.label || patch.target ? '; the binding was checked again' : '') + '. Audited as channel.updated.', 'ok'); }).catch((err) => App.fail(err, 'Not saved'));
  }

  function hostPort(v, def) { const s = String(v || '').trim(); if (!s) return null; const i = s.lastIndexOf(':'); return i > 0 ? { host: s.slice(0, i), port: Number(s.slice(i + 1)) || def } : { host: s, port: def }; }

  function mailFrom(get, tls) {
    const imapHp = hostPort(get('imap'), 993), smtpHp = hostPort(get('smtp'), 465);
    const ref = (v) => String(v || '').trim();
    const e = { address: ref(get('addr')), fromName: ref(get('from')) || null, imap: null, smtp: null, mailgunKeyRef: ref(get('mg')) || null };
    if (imapHp) e.imap = { host: imapHp.host, port: imapHp.port, secure: tls, user: ref(get('imapuser')) || e.address, passwordRef: ref(get('imappw')), mailbox: 'INBOX' };
    if (smtpHp) e.smtp = { host: smtpHp.host, port: smtpHp.port, secure: tls, user: ref(get('smtpuser')) || e.address, passwordRef: ref(get('smtppw')) };
    return e;
  }
  const refOk = (v) => !v || /^vault:[^#\s]+#[A-Za-z0-9_.-]{1,128}$/.test(v);
  const mailRefsOk = (e) => !((e.imap && (!e.imap.passwordRef || !refOk(e.imap.passwordRef))) || (e.smtp && (!e.smtp.passwordRef || !refOk(e.smtp.passwordRef))) || !refOk(e.mailgunKeyRef));

  function saveMail(ctx, c) {
    const st = ctx.state;
    const get = (k) => { const el = ctx.$('[data-e' + k + ']'); return el ? el.value : ''; };
    const e = mailFrom(get, ctx.$('[data-etls]').classList.contains('on'));
    if (!e.address) { ctx.toast('The channel needs its own address.', 'warn'); return; }
    if (!mailRefsOk(e)) { ctx.toast('Credentials must be vault: references (vault:&lt;path&gt;#&lt;key&gt;); a literal password is 400.', 'danger'); return; }
    App.patch('/api/channels/' + enc(c.id), { email: e }).then((v) => { replaceChannel(st, v); st.vaultProblem = false; ctx.rerender(); ctx.toast('Mail settings saved; you are now the owner of the references and they were checked readable for you.', 'ok'); }).catch((err) => App.fail(err, 'Not saved'));
  }

  function decideHeld(ctx, h, decision) {
    const st = ctx.state;
    const c = st.channels.find((x) => x.id === h.channelId);
    const ref = h.flag ? h.flag.ref : 'Reply';
    const send = (body, okMsg, kind) => App.post('/api/channels/held/' + enc(h.id) + '/decide', body).then(() => {
      App.closeOverlay();
      st.held = st.held.filter((x) => x.id !== h.id); delete st.tr[h.sessionId]; delete st.sessions[h.channelId];
      st.heldDone = '<b>' + esc(ref) + ' ' + (decision === 'approve' ? 'approved: the reply went to the customer as written.' : decision === 'edit' ? 'edited: your text went to the customer; the model\'s text is kept as original on the message.' : 'rejected: the reply was withdrawn and the customer was told a person will follow up.') + '</b> Audited as channel.reply.' + (decision === 'reject' ? 'rejected' : 'sent') + (decision === 'edit' ? ' (edited: true) and channel.reply.edited' : '') + '; the flag records the decision. <a href="#" data-opensession="' + esc(h.sessionId) + '">Open the session</a>.';
      st.quiet = true; ctx.rerender(); ctx.toast(okMsg, kind);
    }).catch((err) => { App.fail(err, 'Not decided'); if (err.status === 409 || err.status === 404) { App.closeOverlay(); st.quiet = true; ctx.rerender(); } });
    const kv = [['Flag', esc(ref)], ['Session', esc(h.sessionId.slice(-8))], ['Channel', esc(h.channelName || (c ? c.name : ''))]];
    if (decision === 'approve') {
      ctx.confirm({ title: 'Approve reply', tag: 'delivers now', tone: 'info', body: '<p style="margin:0" class="fg2">The reply goes to the customer as written' + (c && c.kind === 'email' ? ', by email from the channel\'s address' : '') + '. The hold flag is recorded as approved.</p><div class="serif" style="padding:8px 10px;background:var(--panel2);border-radius:6px;overflow-wrap:anywhere">' + esc(h.text || '') + '</div>', kv, ok: 'Approve and send' }).then((ok) => { if (ok) send({ decision: 'approve' }, esc(ref) + ' approved and delivered.', 'ok'); });
      return;
    }
    if (decision === 'edit') {
      ctx.modal({ title: 'Edit and send', cls: 'wide', body: UI.notice('Your text is delivered instead; the model\'s text is kept as <span class="mono">original</span> on the message and in the CSV. Audited as channel.reply.sent with edited: true and channel.reply.edited.', 'info') + UI.field('Reply to the customer', UI.textarea(h.text || '', { rows: 4, attrs: 'data-etext' })) + small('Why it was held: ' + esc(whyHeld(st, h, c))),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send edited reply', { kind: 'primary', attrs: 'data-esend' }),
        onMount(m) { m.querySelector('[data-esend]').addEventListener('click', () => { const text = m.querySelector('[data-etext]').value.trim(); if (!text) { ctx.toast('The reply cannot be empty; reject it instead.', 'warn'); return; } if (text === (h.text || '').trim()) { ctx.toast('Unchanged text: use Approve.', 'warn'); return; } send({ decision: 'edit', text }, esc(ref) + ' edited and delivered.', 'ok'); }); } });
      return;
    }
    ctx.modal({ title: 'Reject reply ' + UI.pill('withdraws it', 'danger'), body: '<p style="margin:0" class="fg2">The reply is withdrawn; the customer is told a person will follow up and the session stays open for you to answer. The hold flag is recorded as rejected.</p>' + UI.field('Reason', UI.select(['Wrong or unsupported figure', 'Repeats customer PII', 'Promises something we cannot keep', 'Other'], 'Promises something we cannot keep', 'data-rreason')) + UI.kv(kv, 2),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-rsend' }),
      onMount(m) { m.querySelector('[data-rsend]').addEventListener('click', () => send({ decision: 'reject', reason: m.querySelector('[data-rreason]').value }, esc(ref) + ' rejected and withdrawn.', 'warn')); } });
  }

  function reportModal(ctx, messageId, seq) {
    ctx.modal({ title: 'Report message ' + esc(seq), body: UI.field('Reason', UI.select(['Abuse', 'Sensitive data', 'Spam', 'Other'], 'Abuse', 'data-rreason')) + UI.field('Note', UI.textarea('', { rows: 2, attrs: 'data-rnote' })) + UI.notice('Files a report flag (type channel-message) in the channel\'s workspace queue. Hiding a channel message removes it from what the customer and the model see; hiding a session ends the customer\'s token.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Report', { kind: 'primary', attrs: 'data-doreport' }),
      onMount(m) { m.querySelector('[data-doreport]').addEventListener('click', () => {
        const note = m.querySelector('[data-rnote]').value.trim();
        App.post('/api/moderation/reports', Object.assign({ type: 'channel-message', id: messageId, reason: m.querySelector('[data-rreason]').value }, note ? { note } : {})).then((r) => { App.closeOverlay(); ctx.toast(r.duplicate ? 'You already reported this message; your report is still open.' : 'Reported as ' + esc(r.flag.ref) + ' in the workspace queue. <a href="#/moderation" style="color:inherit">Open Moderation</a>', 'ok', 5000); }).catch((err) => App.fail(err, 'Not reported'));
      }); } });
  }

  function newChannelModal(ctx) {
    const st = ctx.state;
    const wss = ((App.me && App.me.workspaces) || []).map((w) => ({ value: w.id, label: w.name + ' (' + w.label + ')' }));
    const open = () => {
      const targets = (st.targets && st.targets.list) || [];
      const topts = targets.length ? targets : [{ value: '', label: 'No published profile or agent' }];
      ctx.modal({ title: 'New channel', cls: 'wide',
        body: '<div class="formgrid" style="--cols:3">' + UI.field('Workspace', UI.select(wss, App.me && App.me.workspace, 'data-nws')) + UI.field('Kind', UI.select(['chat', 'email'], 'chat', 'data-nkind')) + UI.field('Name', UI.input('', { attrs: 'data-nname', placeholder: 'Order status' })) + UI.field('Label', UI.select(LABELS, 'internal', 'data-nlabel'), 'Under the workspace ceiling, your clearance and the target\'s label') + UI.field('Target', UI.select(topts, topts[0].value, 'data-ntarget'), 'A published profile or agent; agents answer with their profile and system prompt, never their tools') + UI.field('Review mode', UI.select(['never', 'escalated', 'always'], 'escalated', 'data-nreview')) + UI.field('Messages per minute', UI.input('10', { type: 'number', attrs: 'min="1" data-nmpm' })) + UI.field('Sessions per hour', UI.input('10', { type: 'number', attrs: 'min="1" data-nsph' })) + UI.field('Retention (days)', UI.input('30', { type: 'number', attrs: 'min="1" data-nret' })) + '</div>'
          + UI.field('Instructions', UI.textarea('', { rows: 2, attrs: 'data-ninstr', placeholder: 'What the channel may and may not answer' })) + UI.field('Greeting (chat)', UI.input('', { attrs: 'data-ngreet' })) + UI.toggle('Allow anonymous customers', true, 'data-nanon')
          + '<div class="divider"></div><div class="eyebrow">Email (email channels only)</div><div class="formgrid" style="--cols:3">' + UI.field('Address', UI.input('', { attrs: 'data-naddr', placeholder: 'orders@example.com' })) + UI.field('IMAP host:port', UI.input('', { attrs: 'data-nimap', placeholder: 'imap.example.com:993' })) + UI.field('IMAP password', UI.input('', { attrs: 'data-nimappw', placeholder: 'vault:kv/channels/orders#imap' })) + UI.field('SMTP host:port', UI.input('', { attrs: 'data-nsmtp', placeholder: 'smtp.example.com:465' })) + UI.field('SMTP password', UI.input('', { attrs: 'data-nsmtppw', placeholder: 'vault:kv/channels/orders#smtp' })) + UI.field('Mailgun signing key', UI.input('', { attrs: 'data-nmg', placeholder: 'vault:kv/channels/orders#mailgun' })) + '</div>' + small('Credentials must be vault: references (400 otherwise), readable by you at save and read as you at use. Hosts pass the service address rules and the tenant\'s allowed hosts.'),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create channel', { kind: 'primary', attrs: 'data-ncreate' }),
        onMount(m) { m.querySelector('[data-ncreate]').addEventListener('click', () => {
          const q = (s) => m.querySelector(s);
          const kind = q('[data-nkind]').value, name = q('[data-nname]').value.trim(), target = q('[data-ntarget]').value;
          if (!name) { ctx.toast('A channel needs a name.', 'warn'); return; }
          if (!target) { ctx.toast('Publish a profile or an agent first; a channel answers with one.', 'warn'); return; }
          const sp = target.indexOf(' ');
          const body = { workspaceId: q('[data-nws]').value, kind, name, label: q('[data-nlabel]').value, target: { kind: target.slice(0, sp), name: target.slice(sp + 1) }, reviewMode: q('[data-nreview]').value, allowAnonymous: q('[data-nanon]').classList.contains('on'), messagesPerMinute: num(q('[data-nmpm]').value) || 10, sessionsPerHour: num(q('[data-nsph]').value) || 10, retentionDays: num(q('[data-nret]').value) };
          const instr = q('[data-ninstr]').value.trim(); if (instr) body.instructions = instr;
          const greet = q('[data-ngreet]').value.trim(); if (greet && kind === 'chat') body.greeting = greet;
          if (kind === 'email') {
            const get = (k) => { const el = q('[data-n' + k + ']'); return el ? el.value : ''; };
            const e = mailFrom(get, true);
            if (!e.address) { ctx.toast('An email channel needs its own address.', 'warn'); return; }
            if (!mailRefsOk(e)) { ctx.toast('Mail credentials must be vault: references: 400.', 'danger'); return; }
            body.email = e;
          }
          App.post('/api/channels', body).then((v) => {
            App.closeOverlay();
            const secrets = v.secrets || {}; delete v.secrets;
            st.channels = st.channels.concat([v]).sort((a, b) => a.name.localeCompare(b.name)); st.sel = v.id; st.tab = 'settings'; st.fstate = 'live'; st.fkind = 'all'; st.sessions[v.id] = [];
            st.rotated = { channel: v.id, which: secrets.webhookSecret ? 'identity and webhook' : 'identity', value: secrets.identitySecret + (secrets.webhookSecret ? ' / webhook: ' + secrets.webhookSecret : ''), created: true };
            ctx.rerender(); ctx.toast(esc(name) + ' created. The secrets are shown once on the Settings tab.', 'ok', 5000);
          }).catch((err) => App.fail(err, 'Not created'));
        }); } });
    };
    if (st.targets && st.targets.list) open(); else loadTargets(st).then(open);
  }
})();
