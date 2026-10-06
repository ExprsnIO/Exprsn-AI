(function () {
  const { UI, esc } = App;

  // Social and messaging (1.6.0, B-4206): the administrator's policies and health views for the feed, groups, messaging
  // and relations of every workspace they may act in, legal-hold exports under dual control (decision Q5) and the
  // realtime counts of this instance. Everything comes from /api/admin/social/…; Realtime needs platform:manage.
  const S = '/api/admin/social';
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const APPROVERS = [{ value: 'reviewers', label: 'any flag reviewer' }, { value: 'feed', label: 'feed admins (feed:manage)' }, { value: 'guardrails', label: 'guardrail admins' }, { value: 'moderators', label: 'moderators' }];
  const MEDIA = [{ value: '', label: 'no limit' }, { value: String(20 * 1048576), label: '20 MiB' }, { value: String(50 * 1048576), label: '50 MiB' }, { value: String(200 * 1048576), label: '200 MiB' }];
  const CREATE = [{ value: 'members', label: 'any member' }, { value: 'admins', label: 'workspace admins' }];
  const CONTACT = [{ value: 'workspace', label: 'anyone in the workspace' }, { value: 'contacts', label: 'contacts only' }, { value: 'admins', label: 'admins only' }];
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const day = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const mib = (n) => (n == null ? 'no limit' : Math.round(n / 1048576) + ' MiB');
  const overlayOpen = () => !!document.getElementById('overlay');
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || false;
  const visKind = (v) => (v === 'public' ? 'ok' : v === 'hidden' ? 'warn' : '');
  const groupKind = (s) => (s === 'active' ? 'ok' : s === 'hidden' ? 'danger' : 'warn');
  const exportKind = (s) => (s === 'ready' ? 'ok' : s === 'rejected' || s === 'failed' ? 'danger' : s === 'withdrawn' ? '' : s === 'approved' ? 'info' : 'warn');
  const labelsUpTo = () => { const c = (App.me && App.me.user && App.me.user.clearance) || 'internal'; return LABELS.slice(0, Math.max(1, LABELS.indexOf(c) + 1)); };
  const TABS = { feed: '/feed', groups: '/groups', messaging: '/messaging', realtime: '/realtime', relations: '/relations' };

  function menu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  /** Step-up (exports need a recent sign-in): a password or an authenticator code, then the call runs once more. */
  function stepUp(ctx) {
    return new Promise((resolve) => {
      const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
      const pw = methods.indexOf('password') >= 0 || methods.indexOf('totp') < 0, totp = methods.indexOf('totp') >= 0;
      let ok = false;
      ctx.modal({ title: 'Confirm it is you',
        body: '<div class="fg2">Exporting a conversation reads other people\'s messages, so it needs a fresh check of who you are. ' + (pw && totp ? 'Enter your password or a code from your authenticator.' : totp ? 'Enter a code from your authenticator.' : 'Enter your password.') + '</div>'
          + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
          + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
          + '<div data-suerr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }),
        onMount(m) {
          const err = m.querySelector('[data-suerr]');
          const go = async () => {
            const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
            const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
            if (!pwv && !code) { err.innerHTML = UI.notice('Enter your password or a code.', 'warn'); return; }
            try { await App.post('/api/me/step-up', pwv ? { password: pwv } : { code }); ok = true; App.closeOverlay(); }
            catch (e) { err.innerHTML = UI.notice(esc((e.problem && e.problem.detail) || e.message), 'danger'); }
          };
          m.querySelector('[data-sugo]').addEventListener('click', go);
          m.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }));
        },
        onClose() { resolve(ok); } });
    });
  }
  async function withStepUp(ctx, fn) {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) { const e = new Error('Not confirmed.'); e.cancelled = true; throw e; }
      return fn();
    }
  }

  App.register({
    id: 'social', title: 'Social and messaging', section: 'admin', crumb: ['Admin', 'Social and messaging'], live: true,
    summary: 'Policies and health for the feed, groups, messaging and realtime, across workspaces',
    commands: [
      { label: 'Send a test digest', sub: 'Social and messaging', run(app) { const s = app.stateFor('social'); s.tab = 'feed'; s.openDigest = true; app.render(); } },
      { label: 'Export a conversation', sub: 'Social and messaging', run(app) { const s = app.stateFor('social'); s.tab = 'messaging'; s.openExport = true; app.render(); } }
    ],
    states: [
      { title: 'Post held by guardrail', tone: 'info', text: 'Posts wait for review in the workspaces; the held counter opens Flags. A held post is invisible until approved (B-2704).', apply(ctx) { const st = ctx.state; st.tab = 'feed'; st.example = 'held'; ctx.rerender(); } },
      { title: 'Digest fell back', tone: 'warn', text: 'The weekly digest went out as the ranked list because the profile\'s model failed; the panel says so and names the run.', apply(ctx) { const st = ctx.state; st.tab = 'feed'; st.example = 'fell'; ctx.rerender(); } },
      { title: 'Semantic search off', tone: 'neutral', text: 'MESSAGING_EMBED_MODEL is unset: search is keyword only. The pill and a notice say so, with the setting to copy.', apply(ctx) { const st = ctx.state; st.tab = 'messaging'; st.example = 'keyword'; ctx.rerender(); } },
      { title: 'Calendar feed revoked', tone: 'ok', text: 'A revoked signed feed URL answers 404 on its next fetch; the row shows revoked and the audit entry calendar.feed.revoked is written.', apply(ctx) { const st = ctx.state; st.tab = 'groups'; st.example = 'revoked'; ctx.rerender(); } },
      { title: 'Realtime signals refused', tone: 'warn', text: 'Clients sent more signals than ROOM_SIGNALS_PER_MINUTE allows; the refused count shows by room kind. Overview explains the instances.', apply(ctx) { const st = ctx.state; st.tab = App.can('platform:manage') ? 'realtime' : 'relations'; st.example = 'refused'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.tab) st.tab = 'feed';
      if (!st.data) st.data = {};
      if (!st.errors) st.errors = {};
      if (st.query == null) st.query = '';
      if (!st.wsFilter) st.wsFilter = 'all';
      // Entering the screen refetches (the shell marks it not loaded); a link's tab or group applies once per visit.
      if (st.loaded === false) { st.data = {}; st.errors = {}; }
      st.loaded = true;
      if (st.hashSeen !== location.hash) {
        st.hashSeen = location.hash;
        if (ctx.params.tab) st.tab = ctx.params.tab;
        if (ctx.params.group) { st.tab = 'groups'; st.sel = ctx.params.group; }
      }
      const platform = App.can('platform:manage');
      if (st.tab === 'realtime' && !platform) st.tab = 'feed';
      if (!TABS[st.tab]) st.tab = 'feed';

      // ---------- loading ----------
      const refresh = () => {
        if (App.state.route !== 'social' || overlayOpen()) return;
        const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0;
        ctx.rerender();
        const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top;
      };
      const load = (tab, force) => {
        if (st['loading_' + tab] || (!force && (st.data[tab] || st.errors[tab]))) return;
        st['loading_' + tab] = true;
        App.get(S + TABS[tab])
          .then((d) => { st.data[tab] = d; st.errors[tab] = null; })
          .catch((err) => { st.errors[tab] = err; })
          .finally(() => { st['loading_' + tab] = false; refresh(); });
      };
      const reload = (tab) => { st.data[tab] = st.data[tab] || null; load(tab, true); };
      /** Runs a change, then reloads the tab; failures go to a toast with the server's words. */
      const act = async (fn, okText, tab, failText) => {
        try { const out = await fn(); if (okText) ctx.toast(typeof okText === 'function' ? okText(out) : okText, 'ok'); reload(tab || st.tab); return out; }
        catch (err) { if (!(err && err.cancelled)) App.fail(err, failText || 'Not saved'); reload(tab || st.tab); return null; }
      };
      load(st.tab);

      const head = UI.pagehead('Social and messaging', 'Policies and health for the feed, groups, messaging and realtime, across every workspace you administer', UI.btn('Send a test digest', { attrs: 'data-testdigest' }) + UI.btn('Export a conversation', { kind: 'primary', attrs: 'data-export' }));
      const style = '<style>#main > .page > *{flex-shrink:0}#main .social-insp{overflow-wrap:anywhere}#main .social-fields{display:grid;gap:10px 14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))}#main .social-tags td:first-child{overflow-wrap:anywhere}</style>';
      const tabsDef = [{ id: 'feed', label: 'Feed', count: st.data.feed ? st.data.feed.counters.held || undefined : undefined }, { id: 'groups', label: 'Groups and events', count: st.data.groups ? st.data.groups.groups.filter((g) => g.state !== 'archived').length : undefined }, { id: 'messaging', label: 'Messaging' }].concat(platform ? [{ id: 'realtime', label: 'Realtime' }] : []).concat([{ id: 'relations', label: 'Relations' }]);
      const tabs = UI.tabs(tabsDef, st.tab);
      const d = st.data[st.tab];
      const err = st.errors[st.tab];
      let body = '', insp = '';

      if (err) body = UI.problem('This tab could not be loaded', err.message, traceOf(err)) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>';
      else if (!d) body = UI.notice('Loading…', 'info');

      // ---------------- Feed ----------------
      else if (st.tab === 'feed') {
        const c = d.counters, dg = d.digest, eff = dg.effective, mod = d.canModerate;
        const heldN = st.example === 'held' && !c.held ? 3 : c.held;
        body += (st.example === 'held' ? UI.notice('<b>' + heldN + ' posts wait for review</b> across the workspaces. A held post is invisible until approved; reviewers decide on Flags. (Example.)', 'info', UI.btn('Open Flags', { size: 'xs', attrs: 'data-goheld' })) : '')
          + '<div class="stats">' + UI.stat(c.postsToday, 'posts today', 'across ' + d.workspaces.length + ' workspaces') + UI.stat('<a href="#" data-goheld>' + heldN + '</a>', 'held for review', 'invisible until approved') + UI.stat(c.commentsToday, 'comments today', 'refused when a rule would hold') + UI.stat(c.reactionsToday, 'reactions today') + UI.stat(c.trendingTags, 'trending tags', 'last run ' + esc(when(d.trending.lastRun))) + '</div>'
          + UI.panel('Approval policy by workspace', UI.table(['Workspace', 'Label', 'Posts pass user-input', 'Held posts approved by', 'Edits and comments a rule would hold', 'Media', 'Max media size', { label: 'Held', right: true }], d.workspaces.map((w) => [esc(w.name), UI.label(w.label, { sm: true }), UI.toggle(w.feedGuard ? 'on' : 'off', w.feedGuard, 'data-manual data-guard="' + esc(w.id) + '"' + (mod ? '' : ' disabled')), UI.select(APPROVERS, w.feedApprover, 'data-approver="' + esc(w.id) + '" aria-label="Approver for ' + esc(w.name) + '"' + (mod ? '' : ' disabled')), '<span class="muted">refused, not held</span>', UI.toggle(w.feedMedia ? 'allowed' : 'off', w.feedMedia, 'data-manual data-media="' + esc(w.id) + '"'), UI.select(MEDIA, w.feedMediaMaxBytes == null ? '' : String(w.feedMediaMaxBytes), 'data-maxmedia="' + esc(w.id) + '" aria-label="Max media for ' + esc(w.name) + '"' + (w.feedMedia ? '' : ' disabled')), w.held ? '<a href="#" data-goheld>' + w.held + '</a>' : '0']), { clickable: false, minWidth: '900px', emptyTitle: 'No workspaces', emptyText: 'You administer no workspace in this tenant.' })
            + UI.notice('Posts pass the <span class="mono">user-input</span> guardrail; a held post is invisible until approved. With the check off, posts labelled internal or below keep only the platform baseline; anything above internal is always checked in full. Edits and comments a rule would hold are refused rather than held (B-2704).' + (mod ? '' : ' Changing the check or the approvers needs <span class="mono">moderation:manage</span>.'), 'info'))
          + '<div class="grid2">' + UI.panel('Trending', UI.kv([['Job', '<span class="mono">feed.trending</span>, every <span class="mono">FEED_TRENDING_MINUTES</span> = ' + esc(d.trending.minutes)], ['Window', '<span class="mono">FEED_TRENDING_HOURS</span> = ' + esc(d.trending.hours)], ['Last run', esc(when(d.trending.lastRun))]], 2)
            + UI.table(['Tag', { label: 'Posts', right: true }, { label: 'People', right: true }, 'State', ''], d.trending.tags.map((t) => ['<span class="mono">#' + esc(t.tag) + '</span>', t.posts, t.people, t.excluded ? UI.pill('excluded', 'warn') : UI.pill('trending', 'ok'), t.excluded ? UI.btn('Include', { size: 'xs', kind: 'ghost', attrs: 'data-include="' + esc(t.tag) + '" aria-label="Include #' + esc(t.tag) + ' in trending"' }) : UI.btn('Exclude from trending', { size: 'xs', kind: 'ghost', attrs: 'data-exclude="' + esc(t.tag) + '" aria-label="Exclude #' + esc(t.tag) + ' from trending"' })]), { clickable: false, minWidth: '0', cls: 'bare social-tags', emptyTitle: 'Nothing trending yet', emptyText: 'Tags appear after the next run.' })
            + '<span class="muted" style="font-size:12px">An excluded tag still works on posts and in its hashtag feed; it never shows as trending. The exclusion list is per tenant.</span>', { actions: UI.btn('Run trending now', { size: 'sm', attrs: 'data-runtrending' }) })
          + UI.panel('Weekly digest', ((st.example === 'fell' || (dg.last && dg.last.state === 'failed')) ? UI.notice('<b>Last digest fell back.</b> ' + (dg.last && dg.last.state === 'failed' ? 'The run on ' + esc(day(dg.last.createdAt)) + ' kept the ranked list: profile <span class="mono">' + esc(dg.last.profile || '') + '</span> failed (' + esc(dg.last.error || 'no reason given') + ').' : 'A run kept the ranked list because the profile\'s model failed twice. (Example.)') + ' Members received the list without the written summary.', 'warn')
              : dg.last ? UI.notice('Last digest on ' + esc(day(dg.last.createdAt)) + ': ' + (dg.last.state === 'empty' ? 'no posts that week.' : esc(dg.last.posts) + ' posts, written by <span class="mono">' + esc(dg.last.profile || '') + '</span>.'), 'ok') : UI.notice('No digest has been written yet.' + (eff.digestProfile ? '' : ' Choose a profile to turn digests on.'), 'info'))
            + '<div class="social-fields">' + UI.field('Profile', UI.select([{ value: '', label: 'environment default' + (st.data.feed.digest.settings.digestProfile ? '' : (eff.digestProfile ? ' (' + eff.digestProfile + ')' : ' (none)')) }].concat(dg.profiles.map((p) => ({ value: p, label: p }))), dg.settings.digestProfile || '', 'data-dprofile'), 'FEED_DIGEST_PROFILE unless set here; a published profile. The ranked list is kept if it fails.')
            + UI.field('Day', UI.select(DAYS.map((x, i) => ({ value: String(i), label: x })), String(eff.digestDay), 'data-dday'), 'The week ends then, UTC')
            + UI.field('Time', UI.select(Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: (i < 10 ? '0' : '') + i + ':00 UTC' })), String(eff.digestHour), 'data-dtime'), 'Checked hourly, one digest per workspace')
            + UI.field('Posts in the digest', UI.select(['1', '3', '5', '10', '20'].concat([String(eff.digestTop)]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b), String(eff.digestTop), 'data-dtop'), 'FEED_DIGEST_TOP unless set here, ranked by reactions and comments')
            + UI.field('Max label', UI.select(labelsUpTo().concat([eff.digestMaxLabel]).filter((v, i, a) => a.indexOf(v) === i), eff.digestMaxLabel, 'data-dlabel'), 'Posts above it are left out, not summarised') + '</div>'
            + '<div class="hstack gap6 wrap">' + UI.btn('Send a test digest to me', { size: 'sm', kind: 'primary', attrs: 'data-testdigest' }) + '<span class="muted" style="font-size:12px">Max label ' + UI.label(eff.digestMaxLabel, { sm: true }) + '</span></div>') + '</div>';
      }

      // ---------------- Groups and events ----------------
      else if (st.tab === 'groups') {
        const q = st.query.toLowerCase();
        const wsNames = d.defaults.map((x) => x.name);
        const rows = d.groups.filter((g) => (st.wsFilter === 'all' || g.workspace === st.wsFilter) && (!q || (g.name + ' ' + (g.workspace || '')).toLowerCase().includes(q)));
        if (!rows.some((g) => g.id === st.sel)) st.sel = rows.length ? rows[0].id : null;
        const sel = d.groups.find((g) => g.id === st.sel);
        const pending = d.groups.reduce((n, g) => n + g.pending, 0);
        body += (st.example === 'revoked' ? UI.notice('Feed revoked. Its signed URL answers 404 on the next fetch and <span class="mono">calendar.feed.revoked</span> is in the audit chain. (Example.)', 'ok') : '')
          + UI.panel('Defaults by workspace', UI.table(['Workspace', 'Who may create groups', 'Default visibility', 'Default join mode', 'Requests expire', 'Invitations expire', 'Event capacity'], d.defaults.map((x) => [esc(x.name), UI.select(CREATE, x.groupCreate, 'data-dcreate="' + esc(x.workspaceId) + '" aria-label="Who may create groups in ' + esc(x.name) + '"'), UI.select(['public', 'private', 'hidden'], x.groupVisibility, 'data-dvis="' + esc(x.workspaceId) + '" aria-label="Default visibility for ' + esc(x.name) + '"'), UI.select(['open', 'request', 'invite'], x.groupJoin, 'data-djoin="' + esc(x.workspaceId) + '" aria-label="Default join mode for ' + esc(x.name) + '"'), '<span class="mono">GROUP_REQUEST_DAYS</span> ' + esc(d.settings.requestDays), '<span class="mono">GROUP_INVITE_DAYS</span> ' + esc(d.settings.inviteDays), UI.select([{ value: '', label: 'no limit' }, '12', '25', '40', '60', '100', '250'].concat(x.eventCapacity != null && [12, 25, 40, 60, 100, 250].indexOf(x.eventCapacity) < 0 ? [String(x.eventCapacity)] : []), x.eventCapacity == null ? '' : String(x.eventCapacity), 'data-dcap="' + esc(x.workspaceId) + '" aria-label="Default event capacity for ' + esc(x.name) + '"')]), { clickable: false, minWidth: '960px' })
            + UI.notice('A new group starts with its workspace\'s visibility and join mode unless its creator picks others; a new event without a capacity starts with the workspace\'s. Governance voting (the platform\'s proposals and votes) stays deferred. Groups have owners, moderators and members.', 'info'))
          + '<div class="toolbar">' + UI.search('Filter groups by name or workspace', 'data-search', st.query) + '<span class="relative">' + UI.btn(st.wsFilter === 'all' ? 'Workspace' : st.wsFilter, { size: 'sm', icon: 'filter', attrs: 'data-menu="ws"', cls: st.wsFilter !== 'all' ? 'active' : '' }) + '</span><span class="muted right" style="font-size:12px">' + rows.length + ' groups, ' + pending + ' pending requests' + (d.above ? ', ' + d.above + ' above your clearance left out' : '') + '</span></div>'
          + UI.table(['Group', 'Workspace', 'Label', 'Visibility', 'Join mode', { label: 'Members', right: true }, { label: 'Pending requests', right: true }, { label: 'Upcoming events', right: true }, { label: 'Open reports', right: true }, 'State'], rows.map((g) => ({ cells: ['<div style="font-weight:600">' + esc(g.name) + '</div>', esc(g.workspace || ''), UI.label(g.label, { sm: true }), UI.pill(g.visibility, visKind(g.visibility)), esc(g.joinMode), g.members, g.pending ? '<span style="color:var(--warn-fg)">' + g.pending + '</span>' : '0', g.upcomingEvents, g.openReports ? '<span style="color:var(--danger-fg)">' + g.openReports + '</span>' : '0', UI.pill(g.state, groupKind(g.state))], attrs: 'data-group="' + esc(g.id) + '"', selected: g.id === st.sel })), { minWidth: '1000px', emptyTitle: d.groups.length ? 'No groups match' : 'No groups yet', emptyText: d.groups.length ? 'Clear the filter.' : 'Groups members create in your workspaces appear here.' })
          + UI.panel('Calendar feeds', UI.table(['Feed', 'Scope', 'Calendar', 'Issued to', 'Label', 'Issued', 'Last fetched', 'State', ''], d.feeds.map((f) => ['<span class="mono">' + esc(f.id.slice(-6).toLowerCase()) + '</span>', esc(f.kind), esc(f.name || ''), esc(f.issuedTo.displayName || f.issuedTo.username || ''), f.label ? UI.label(f.label, { sm: true }) : '<span class="muted">their own</span>', esc(day(f.createdAt)), esc(when(f.lastUsedAt)), UI.pill(f.state, f.state === 'active' ? 'ok' : 'danger'), f.state === 'active' ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-revoke="' + esc(f.id) + '" aria-label="Revoke the feed ' + esc(f.name || f.id) + ' of ' + esc(f.issuedTo.displayName || '') + '"' }) : '']), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No calendar feeds', emptyText: 'Feeds members subscribe to appear here.' })
            + '<span class="muted" style="font-size:12px">Signed URLs <span class="mono">/calendar/feeds/&lt;id&gt;/&lt;sig&gt;.ics</span> (RFC 5545, UTC, B-2504). HMAC from a derived key; a revoked feed or a bad signature answers 404. Rate <span class="mono">CALENDAR_FEED_PER_MINUTE</span> = ' + esc(d.settings.feedPerMinute) + ', details at most <span class="mono">CALENDAR_FEED_MAX_LABEL</span> = ' + esc(d.settings.feedMaxLabel) + '.</span>');
        if (sel) {
          insp = '<div class="hstack"><div class="eyebrow grow">Selected group</div>' + UI.pill(sel.state, groupKind(sel.state)) + '</div><div style="font-size:15px;font-weight:600">' + esc(sel.name) + '</div><div class="muted" style="font-size:12px">' + esc(sel.workspace || '') + ' · ' + UI.label(sel.label, { sm: true }) + '</div>'
            + UI.kv([['Owners', sel.owners.map((o) => esc(o.displayName || '')).join(', ') || 'none'], ['Created', esc(day(sel.createdAt))], ['Visibility', esc(sel.visibility) + ', join ' + esc(sel.joinMode)], ['Members', sel.members + (sel.pending ? ', ' + sel.pending + ' waiting' : '')], ['Upcoming events', String(sel.upcomingEvents)], ['Feed URLs issued', String(sel.feeds)], ['Open reports', sel.openReports ? '<a href="#" data-goreports>' + sel.openReports + '</a>' : 'none']], 1)
            + (sel.state === 'hidden' ? UI.notice('Hidden by moderation. Members see a notice, not the posts. Lifting it is a moderation action.', 'danger', UI.btn('Open Moderation', { size: 'xs', attrs: 'data-goreports' })) : '')
            + (sel.state === 'archived' ? UI.notice('Archived: read only. Members keep reading its posts and events; nothing new can be posted, joined or scheduled.', 'warn') : '')
            + '<div class="hstack wrap gap6">' + UI.btn('Transfer ownership', { size: 'sm', attrs: 'data-transfer', disabled: sel.state !== 'active' }) + UI.btn('Open on Groups', { size: 'sm', kind: 'ghost', attrs: 'data-opengroup' }) + (sel.state === 'active' ? UI.btn('Archive group', { size: 'sm', kind: 'danger', attrs: 'data-archive' }) : '') + '</div>'
            + '<span class="muted" style="font-size:12px">Audit entries: group.ownership.transferred, group.archived, calendar.feed.revoked.</span>';
        }
      }

      // ---------------- Messaging ----------------
      else if (st.tab === 'messaging') {
        const semantic = d.search.semantic && st.example !== 'keyword';
        body += (semantic ? '' : UI.notice('<b>Semantic search is off.</b> <span class="mono">MESSAGING_EMBED_MODEL</span> is unset, so search is keyword only. Set it to an approved embedding model to index new messages.' + (st.example === 'keyword' && d.search.semantic ? ' (Example.)' : ''), 'warn', UI.btn('Copy setting name', { size: 'xs', attrs: 'data-copysetting' })))
          + '<div class="grid2">' + UI.panel('Retention by workspace', UI.table(['Workspace', 'Messages kept', 'Set by'], d.retention.map((r) => [esc(r.name), r.days == null ? 'keep' : esc(r.days) + ' days', r.source === 'workspace' ? 'workspace override' : r.source === 'tenant' ? 'tenant default' : 'not set']), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No workspaces', emptyText: 'You administer no workspace.' }) + '<span class="muted" style="font-size:12px">Retention is set per workspace and per user on Tenants; the <span class="mono">chat.retention</span> sweep removes what is past it. Edits and deletes are audited without the text.</span>', { actions: UI.btn('Open Tenants', { size: 'xs', kind: 'ghost', attrs: 'data-goretention' }) })
          + UI.panel('Limits', UI.kv([['Members per conversation', '<span class="mono">MESSAGING_MAX_MEMBERS</span> = ' + esc(d.limits.maxMembers)], ['Attachment size', '<span class="mono">ATTACHMENT_MAX_BYTES</span> = ' + esc(mib(d.limits.attachmentMaxBytes))], ['Attachment types', 'any, through the file store\'s quarantine, type check and scan'], ['Direct conversations', 'one per pair, also under a race (B-2601)']], 1) + '<span class="muted" style="font-size:12px">Attachments come from the file store after quarantine (B-2604); a file still scanning shows as pending in the conversation.</span>') + '</div>'
          + '<div class="grid2">' + UI.panel('Search, summaries and presence', UI.kv([['Keyword search', UI.pill('on', 'ok')], ['Semantic search', semantic ? UI.pill('semantic on', 'ok') + ' <span class="mono">' + esc(d.search.embedModel || '') + '</span>' : UI.pill('keyword only', 'warn')], ['Summaries and digests', UI.select([{ value: '', label: 'environment default (' + (d.summary.profile ? 'MESSAGING_SUMMARY_PROFILE' : d.summary.effective) + ')' }].concat(d.summary.profiles.map((p) => ({ value: p, label: p }))), d.summary.profile || '', 'data-sprofile aria-label="Summary profile"') + '<div class="muted" style="font-size:11px"><span class="mono">MESSAGING_SUMMARY_PROFILE</span> unless set here, at most <span class="mono">MESSAGING_SUMMARY_MAX_MESSAGES</span> = ' + esc(d.summary.maxMessages) + '; cites only what the reader can see</div>'], ['Presence', 'the last join or leave, not a live status (B-2603)']], 1))
          + UI.panel('Relations in messaging', '<div class="stats">' + UI.stat(d.relations.blocks, 'blocks', 'a block hides messages, receipts, typing and posts') + UI.stat(d.relations.mutedConversations, 'muted conversations', 'per member, with notification rules') + UI.stat(d.relations.exported, 'conversations exported', 'for a legal hold') + '</div>') + '</div>'
          + UI.panel('Export a conversation for a legal hold', (d.exports.length ? UI.table(['Request', 'Conversation', 'Reason', 'Requested by', 'Approver', 'State', ''], d.exports.map((x) => ['<span class="mono">' + esc(x.id.slice(-6).toLowerCase()) + '</span>', '<span class="mono">' + esc(x.conversationId.slice(-6).toLowerCase()) + '</span>', esc(x.reason || 'not shown'), esc(x.mine ? 'you' : x.requestedBy.displayName || ''), esc(x.decidedBy ? x.decidedBy.displayName || '' : x.approver ? x.approver.displayName || '' : ''), UI.pill(x.state === 'pending' ? 'waiting for approval' : x.state, exportKind(x.state)) + (x.messages != null ? ' <span class="muted" style="font-size:11px">' + esc(x.messages) + ' messages</span>' : ''),
            '<div class="hstack gap6 wrap">' + (x.canDecide ? UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-xapprove="' + esc(x.id) + '"' }) + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-xreject="' + esc(x.id) + '"' }) : '') + (x.mine && x.state === 'pending' ? UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-xwithdraw="' + esc(x.id) + '"' }) : '') + (x.mine && x.state === 'ready' ? '<a class="btn xs" href="' + esc(S + '/exports/' + enc(x.id) + '/download') + '" download data-xdownload>Download CSV</a>' : '') + '</div>']), { clickable: false, minWidth: '0', cls: 'bare' }) : '<div class="fg2" style="font-size:13px">No export requests. An export is a job (<span class="mono">messaging.conversation.export</span>) that writes the conversation as a sealed CSV for the requester once a second platform admin approves; the members are not told. Audited <span class="mono">messaging.conversation.exported</span> with the reason and both names.</div>')
            + '<div>' + UI.btn('Export a conversation', { size: 'sm', kind: 'primary', attrs: 'data-export' }) + '</div>', { actions: UI.pill('dual control', 'outline') });
      }

      // ---------------- Realtime ----------------
      else if (st.tab === 'realtime') {
        const refused = d.kinds.reduce((n, k) => n + k.refusedLastHour, 0);
        body += ((st.example === 'refused' || refused) ? UI.notice('<b>Signals refused.</b> ' + (refused ? refused + ' signals (typing, receipts) in the last hour went past <span class="mono">ROOM_SIGNALS_PER_MINUTE</span> and were refused; the clients slow down and nothing else is lost.' : 'Clients that send more signals than <span class="mono">ROOM_SIGNALS_PER_MINUTE</span> allows have them refused, counted here by room kind. (Example.)') + ' Overview explains the instances.', 'warn', UI.btn('Open Overview', { size: 'xs', attrs: 'data-gooverview' })) : '')
          + '<div class="stats">' + UI.stat(d.sockets, 'sockets connected', 'on <span class="mono">' + esc(d.instance) + '</span>') + UI.stat(d.kinds.reduce((n, k) => n + k.rooms, 0), 'rooms open', 'on this instance') + UI.stat(d.authFailuresLastHour, 'socket auth failures, last hour', 'expired or missing sessions') + UI.stat(d.signalsPerMinuteLimit, 'signals per minute per socket', '<span class="mono">ROOM_SIGNALS_PER_MINUTE</span>') + '</div>'
          + UI.table(['Room kind', { label: 'Rooms open', right: true }, { label: 'Sockets', right: true }, 'Signals per minute, 12 min', { label: 'Refused, last hour', right: true }], d.kinds.map((k) => ['<span class="mono">' + esc(k.kind) + '</span>', k.rooms, k.sockets, UI.spark(k.signalsPerMinute, k.signalsPerMinute.length - 1) + ' <span class="muted" style="font-size:11px">' + esc(k.signalsPerMinute[k.signalsPerMinute.length - 1]) + ' now</span>', k.refusedLastHour ? '<span style="color:var(--warn-fg)">' + k.refusedLastHour + '</span>' : '0']), { clickable: false, minWidth: '600px' })
          + UI.notice('Counts are this instance\'s' + (d.redis ? '; with Redis the rooms span instances, and each instance counts the sockets it holds.' : '.') + ' Rooms are decided by the server from the principal (B-2101): a member joins the rooms of their conversations, groups, feeds and channels; removing a member closes their room at once, and revoking a session closes its sockets.', 'info', UI.btn('Sessions', { size: 'xs', attrs: 'data-gosessions' }))
          + '<div class="hstack gap6 wrap">' + UI.btn('Close a user\'s rooms', { size: 'sm', attrs: 'data-closerooms' }) + '<span class="muted" style="font-size:12px">What a sanction does: every socket of the user is closed on every instance and they rejoin only what their next request allows.</span></div>';
      }

      // ---------------- Relations ----------------
      else if (st.tab === 'relations') {
        body += '<div class="stats">' + UI.stat(d.counts.follows, 'follows', 'shared social module') + UI.stat(d.counts.blocks, 'blocks', 'ids only, never text') + UI.stat(d.counts.mutes, 'mutes', 'a muted author leaves the home feed') + UI.stat(d.counts.lists, 'lists', 'list feeds') + '</div>'
          + UI.panel('Contact rules by workspace', UI.table(['Workspace', 'Who may start a conversation', ''], d.rules.map((r) => [esc(r.name), UI.select(CONTACT, (st.pendingRules && st.pendingRules[r.workspaceId]) || r.contactRule, 'data-rule="' + esc(r.workspaceId) + '" aria-label="Contact rule for ' + esc(r.name) + '"'), UI.btn('Apply', { size: 'xs', attrs: 'data-applyrule="' + esc(r.workspaceId) + '" aria-label="Apply the contact rule for ' + esc(r.name) + '"' })]), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No workspaces', emptyText: 'You administer no workspace.' }) + '<span class="muted" style="font-size:12px">Contacts are mutual follows. A rule applies to new conversations and added members; existing ones continue. Each person\'s own contact rule and blocks still apply (B-2606).</span>')
          + UI.panel('Most blocked accounts', UI.table(['Account', { label: 'Blocked by', right: true }, 'Workspace', 'Sanction'], d.mostBlocked.map((b) => [esc(b.displayName || b.username || b.userId), b.blockedBy, esc(b.workspace || ''), b.sanction ? UI.pill(b.sanction.kind + (b.sanction.endsAt ? ' to ' + day(b.sanction.endsAt) : ''), b.sanction.kind === 'warn' ? 'warn' : 'danger') : 'none']), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No blocks', emptyText: 'Nobody in this tenant blocked anyone.' }) + '<span class="muted" style="font-size:12px">Counts only; who blocked whom is never shown. Sanctions are decided on Moderation.</span>', { actions: UI.btn('Sanctions', { size: 'xs', kind: 'ghost', attrs: 'data-gosanctions' }) });
      }

      root.innerHTML = style + '<div class="page">' + head + tabs + body + '</div>' + (insp ? '<aside class="inspector w360 social-insp" aria-label="Selected group">' + insp + '</aside>' : '');

      // ---------------- handlers ----------------
      const wsName = (id, list) => { const w = (list || []).find((x) => (x.id || x.workspaceId) === id); return w ? w.name : 'the workspace'; };
      const putPolicy = (id, patch, okText, tab) => act(() => App.api('PUT', S + '/policies/' + enc(id), patch), okText, tab);
      ctx.on('click', '.tabs [data-tab]', (e, t) => { st.tab = t.dataset.tab; st.example = null; ctx.rerender(); });
      ctx.on('click', '[data-reload]', () => { st.errors[st.tab] = null; ctx.rerender(); });
      ctx.on('click', '[data-goheld]', (e) => { e.preventDefault(); ctx.navigate('flags'); });
      ctx.on('click', '[data-goreports]', (e) => { e.preventDefault(); ctx.navigate('moderation', { tab: 'reports' }); });
      ctx.on('click', '[data-opengroup]', () => ctx.navigate('groups', { id: st.sel }));
      ctx.on('click', '[data-goretention]', () => ctx.navigate('tenants', { tab: 'retention' }));
      ctx.on('click', '[data-gosessions]', () => ctx.navigate('identity', { tab: 'sessions' }));
      ctx.on('click', '[data-gosanctions]', () => ctx.navigate('moderation', { tab: 'sanctions' }));
      ctx.on('click', '[data-gooverview]', () => ctx.navigate(App.screens.overview ? 'overview' : 'platform'));
      ctx.on('click', '[data-copysetting]', () => { try { navigator.clipboard && navigator.clipboard.writeText('MESSAGING_EMBED_MODEL'); } catch (e2) { /* clipboard unavailable */ } ctx.toast('MESSAGING_EMBED_MODEL copied'); });

      // feed policies
      const fw = st.data.feed ? st.data.feed.workspaces : [];
      ctx.on('click', '[data-guard]', (e, t) => {
        const w = fw.find((x) => x.id === t.dataset.guard); if (!w || t.disabled) return;
        if (w.feedGuard) {
          ctx.confirm({ title: 'Stop checking posts in ' + esc(w.name) + ' in full', tag: 'weakens moderation', tone: 'danger', body: '<p class="fg2" style="margin:0">Posts labelled internal or below would publish with only the platform baseline checked: tenant and workspace rules would not hold them. Anything above internal is still checked in full.</p>', ok: 'Stop checking' })
            .then((ok) => { if (ok) putPolicy(w.id, { feedGuard: false }, 'Posts in ' + w.name + ' no longer pass user-input in full. Audit event written.', 'feed'); });
        } else putPolicy(w.id, { feedGuard: true }, 'Posts in ' + w.name + ' pass user-input in full again.', 'feed');
      });
      ctx.on('change', '[data-approver]', (e, t) => putPolicy(t.dataset.approver, { feedApprover: t.value }, 'Held posts in ' + wsName(t.dataset.approver, fw) + ' are now approved by ' + (APPROVERS.find((a) => a.value === t.value) || {}).label + '.', 'feed'));
      ctx.on('click', '[data-media]', (e, t) => { const w = fw.find((x) => x.id === t.dataset.media); if (w) putPolicy(w.id, { feedMedia: !w.feedMedia }, 'Media ' + (w.feedMedia ? 'off' : 'allowed') + ' for ' + w.name + '.', 'feed'); });
      ctx.on('change', '[data-maxmedia]', (e, t) => putPolicy(t.dataset.maxmedia, { feedMediaMaxBytes: t.value ? Number(t.value) : null }, 'Max media size saved.', 'feed'));
      ctx.on('click', '[data-exclude]', (e, t) => {
        const tag = t.dataset.exclude;
        const row = st.data.feed.trending.tags.find((x) => x.tag === tag) || { posts: 0 };
        ctx.confirm({ title: 'Exclude #' + esc(tag) + ' from trending', tone: 'info', body: '<p class="fg2" style="margin:0">The tag keeps working on posts and in its hashtag feed. It leaves the trending panel for every reader now.</p>', kv: [['Posts in the window', String(row.posts)]], ok: 'Exclude' })
          .then((ok) => { if (ok) act(() => App.post(S + '/trending/exclusions', { tag }), '#' + tag + ' excluded from trending. Audit event written.', 'feed'); });
      });
      ctx.on('click', '[data-include]', (e, t) => act(() => App.del(S + '/trending/exclusions/' + enc(t.dataset.include)), '#' + t.dataset.include + ' can trend again.', 'feed'));
      ctx.on('click', '[data-runtrending]', () => act(() => App.post(S + '/trending/run', {}), 'Trending job queued; the panel updates when it has run.', 'feed').then(() => setTimeout(() => { if (App.state.route === 'social' && st.tab === 'feed') reload('feed'); }, 2500)));
      const putSettings = (patch, okText, tab) => act(() => App.api('PUT', S + '/settings', patch), okText, tab || st.tab);
      ctx.on('change', '[data-dprofile]', (e, t) => putSettings({ digestProfile: t.value || null }, t.value ? 'Digest profile set to ' + t.value + '.' : 'Digests use the environment default profile.'));
      ctx.on('change', '[data-dday]', (e, t) => putSettings({ digestDay: Number(t.value) }, 'Digest day saved: ' + DAYS[Number(t.value)] + '.'));
      ctx.on('change', '[data-dtime]', (e, t) => putSettings({ digestHour: Number(t.value) }, 'Digest time saved.'));
      ctx.on('change', '[data-dtop]', (e, t) => putSettings({ digestTop: Number(t.value) }, 'Digests list ' + t.value + ' posts.'));
      ctx.on('change', '[data-dlabel]', (e, t) => putSettings({ digestMaxLabel: t.value }, 'Digest max label set to ' + t.value + '.'));
      const testDigest = () => ctx.confirm({ title: 'Send a test digest to me', tone: 'info', body: '<p class="fg2" style="margin:0">Runs the digest of the last seven days for the workspaces you administer and sends it only to you, as a notification. Nothing is posted or kept.</p>', ok: 'Send test' })
        .then((ok) => { if (ok) act(() => App.post(S + '/digest/test', {}), (r) => 'Test digest queued for ' + r.workspaces + ' workspace' + (r.workspaces === 1 ? '' : 's') + '. It arrives in your notifications.', 'feed', 'No test digest'); });
      ctx.on('click', '[data-testdigest]', () => { if (st.tab !== 'feed') { st.tab = 'feed'; ctx.rerender(); } testDigest(); });
      if (st.openDigest) { st.openDigest = false; setTimeout(testDigest, 50); }

      // groups
      const gd = st.data.groups;
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const q = st.query.toLowerCase(); ctx.$$('tr[data-group]').forEach((tr) => { const g = gd.groups.find((x) => x.id === tr.dataset.group); tr.style.display = !q || (g.name + ' ' + (g.workspace || '')).toLowerCase().includes(q) ? '' : 'none'; }); });
      ctx.on('click', '[data-menu="ws"]', (e, t) => menu(ctx, t, [['all', 'Every workspace']].concat(gd.defaults.map((x) => [x.name, x.name])), st.wsFilter, (v) => { st.wsFilter = v; ctx.rerender(); }));
      ctx.on('click', 'tr[data-group]', (e, t) => { st.sel = t.dataset.group; ctx.rerender(); });
      ctx.on('change', '[data-dcreate]', (e, t) => putPolicy(t.dataset.dcreate, { groupCreate: t.value }, 'Group creation in ' + wsName(t.dataset.dcreate, gd && gd.defaults) + ': ' + (CREATE.find((c) => c.value === t.value) || {}).label + '.', 'groups'));
      ctx.on('change', '[data-dvis]', (e, t) => putPolicy(t.dataset.dvis, { groupVisibility: t.value }, 'Default visibility saved.', 'groups'));
      ctx.on('change', '[data-djoin]', (e, t) => putPolicy(t.dataset.djoin, { groupJoin: t.value }, 'Default join mode saved.', 'groups'));
      ctx.on('change', '[data-dcap]', (e, t) => putPolicy(t.dataset.dcap, { eventCapacity: t.value ? Number(t.value) : null }, 'Default event capacity saved.', 'groups'));
      ctx.on('click', '[data-revoke]', (e, t) => {
        const f = gd.feeds.find((x) => x.id === t.dataset.revoke); if (!f) return;
        ctx.confirm({ title: 'Revoke this calendar feed', tag: 'breaks a subscription', tone: 'danger', body: '<p class="fg2" style="margin:0">The signed URL answers 404 on its next fetch. The calendar client of ' + esc(f.issuedTo.displayName || '') + ' stops updating until they subscribe again.</p>', kv: [['Calendar', esc(f.name || f.kind)], ['Last fetched', esc(when(f.lastUsedAt))]], ok: 'Revoke' })
          .then((ok) => { if (ok) act(() => App.post(S + '/calendar-feeds/' + enc(f.id) + '/revoke', {}), 'Feed revoked. The next fetch answers 404; audit event written.', 'groups', 'Not revoked'); });
      });
      ctx.on('click', '[data-transfer]', async () => {
        const g = gd.groups.find((x) => x.id === st.sel); if (!g) return;
        let members;
        try { members = (await App.get(S + '/groups/' + enc(g.id) + '/members')).members.filter((m) => m.role !== 'owner'); } catch (e2) { App.fail(e2, 'Members not loaded'); return; }
        ctx.modal({ title: 'Transfer ownership of ' + esc(g.name),
          body: members.length ? UI.field('New owner', UI.select(members.map((m) => ({ value: m.userId, label: m.displayName + ' (' + m.role + ')' })), members[0].userId, 'data-newowner'), 'A current member. The previous owners become moderators.') + UI.notice('The group\'s members are told. Audited group.ownership.transferred.', 'info') : UI.notice('Nobody but the owners is a member yet. Someone must join before they can own the group.', 'warn'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + (members.length ? UI.btn('Transfer', { kind: 'primary', attrs: 'data-dotransfer' }) : ''),
          onMount(m) { const b = m.querySelector('[data-dotransfer]'); if (b) b.addEventListener('click', () => { const who = m.querySelector('[data-newowner]').value; const name = (members.find((x) => x.userId === who) || {}).displayName; App.closeOverlay(); act(() => App.post(S + '/groups/' + enc(g.id) + '/transfer', { userId: who }), 'Ownership of ' + g.name + ' transferred to ' + name + '.', 'groups', 'Not transferred'); }); } });
      });
      ctx.on('click', '[data-archive]', () => {
        const g = gd.groups.find((x) => x.id === st.sel); if (!g) return;
        ctx.confirm({ title: 'Archive ' + esc(g.name), tag: 'read only', tone: 'danger', body: '<p class="fg2" style="margin:0">Members keep reading the posts and events; nothing new can be posted, joined or scheduled. Pending requests and reminders are cancelled; calendar feeds keep answering with the events. Members are told.</p>', kv: [['Members', String(g.members)], ['Feed URLs', String(g.feeds)]], ok: 'Archive' })
          .then((ok) => { if (ok) act(() => App.post(S + '/groups/' + enc(g.id) + '/archive', {}), (r) => g.name + ' archived. ' + r.members + ' members notified; audit event written.', 'groups', 'Not archived'); });
      });

      // messaging
      ctx.on('change', '[data-sprofile]', (e, t) => putSettings({ summaryProfile: t.value || null }, t.value ? 'Summary profile set to ' + t.value + '.' : 'Summaries use the environment default profile.', 'messaging'));
      const openExport = async () => {
        let convs, approvers;
        try { [convs, approvers] = await Promise.all([App.get(S + '/conversations'), st.data.messaging ? Promise.resolve(st.data.messaging.approvers) : App.get(S + '/messaging').then((m) => m.approvers)]); } catch (e2) { App.fail(e2, 'Conversations not loaded'); return; }
        ctx.drawer({ title: 'Export a conversation ' + UI.pill('dual control', 'outline'),
          body: UI.notice('For a legal hold or an investigation. The export is a sealed CSV for you alone, written once a second platform admin approves. The members are not told. Audited <span class="mono">messaging.conversation.exported</span> with the reason and both names.', 'info')
            + (convs.length ? UI.field('Conversation', UI.select(convs.map((c) => ({ value: c.id, label: c.title + ' (' + (c.kind === 'direct' ? 'direct' : (c.workspace || 'group') + ', ' + c.members + ' members') + ', ' + c.label + ')' })), convs[0].id, 'data-xconv'), 'Only conversations in workspaces you administer, at labels you are cleared for. Attachments are listed by file, not copied.') : UI.notice('No conversation in your workspaces to export.', 'warn'))
            + UI.field('Reason', UI.textarea('', { rows: 3, placeholder: 'Case or ticket reference and why the text is needed', attrs: 'data-xreason maxlength="2000"' }), 'At least 10 characters. Shown to the approver and kept in the audit chain')
            + (approvers.length ? UI.field('Approver', UI.select(approvers.map((a) => ({ value: a.userId, label: a.displayName || a.username })), approvers[0].userId, 'data-xapprover'), 'Another platform admin; you cannot approve your own request') : UI.notice('No other platform admin in this tenant can approve an export.', 'warn'))
            + '<div data-xerr role="alert"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Submit for approval', { kind: 'primary', attrs: 'data-xsubmit', disabled: !convs.length || !approvers.length }),
          onMount(dr) {
            const b = dr.querySelector('[data-xsubmit]'); if (!b) return;
            b.addEventListener('click', async () => {
              const reasonEl = dr.querySelector('[data-xreason]'); const reason = reasonEl.value.trim(); const errEl = dr.querySelector('[data-xerr]');
              if (reason.length < 10) { reasonEl.focus(); errEl.innerHTML = UI.notice('Give a reason of at least 10 characters.', 'warn'); return; }
              const body = { conversationId: dr.querySelector('[data-xconv]').value, reason, approverId: dr.querySelector('[data-xapprover]').value };
              const who = (approvers.find((a) => a.userId === body.approverId) || {}).displayName;
              try {
                await withStepUp(ctx, () => App.post(S + '/exports', body));
                App.closeOverlay(); st.tab = 'messaging'; ctx.toast('Export request sent to ' + who + '. The job runs once approved.', 'ok', 5000); reload('messaging');
              } catch (e3) { if (!(e3 && e3.cancelled)) errEl.innerHTML = UI.notice(esc((e3.problem && e3.problem.detail) || e3.message), 'danger'); }
            });
          } });
      };
      ctx.on('click', '[data-export]', () => openExport());
      if (st.openExport) { st.openExport = false; setTimeout(openExport, 50); }
      ctx.on('click', '[data-xapprove]', (e, t) => {
        const x = st.data.messaging.exports.find((y) => y.id === t.dataset.xapprove); if (!x) return;
        ctx.confirm({ title: 'Approve the conversation export', tag: 'dual control', tone: 'danger', body: '<p class="fg2" style="margin:0">' + esc(x.requestedBy.displayName || '') + ' will receive every message of the conversation as a CSV. The members are not told.</p>', kv: [['Reason', esc(x.reason || '')], ['Label', esc(x.label)]], ok: 'Approve' })
          .then((ok) => { if (ok) act(() => withStepUp(ctx, () => App.post(S + '/exports/' + enc(x.id) + '/approve', {})), 'Export approved; the job writes it now.', 'messaging', 'Not approved'); });
      });
      ctx.on('click', '[data-xreject]', (e, t) => ctx.confirm({ title: 'Reject the conversation export', tone: 'info', body: '<p class="fg2" style="margin:0">Nothing is read. The requester is told.</p>', ok: 'Reject' }).then((ok) => { if (ok) act(() => App.post(S + '/exports/' + enc(t.dataset.xreject) + '/reject', {}), 'Export rejected.', 'messaging'); }));
      ctx.on('click', '[data-xwithdraw]', (e, t) => act(() => App.post(S + '/exports/' + enc(t.dataset.xwithdraw) + '/withdraw', {}), 'Export request withdrawn.', 'messaging'));
      ctx.on('click', '[data-xdownload]', () => { setTimeout(() => reload('messaging'), 1500); });

      // realtime
      ctx.on('click', '[data-closerooms]', async () => {
        let people;
        try { people = await App.get(S + '/people'); } catch (e2) { App.fail(e2, 'People not loaded'); return; }
        ctx.modal({ title: 'Close a user\'s rooms', body: UI.field('User', UI.select(people.map((u) => ({ value: u.userId, label: u.displayName + ' (' + u.username + ')' })), people.length ? people[0].userId : '', 'data-cuser'), 'Every socket of the user is closed on every instance; they rejoin only what their next request allows.') + UI.notice('This is what a sanction does. It does not end the user\'s session; revoke it on Identity if that is what you mean.', 'warn'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Close rooms', { kind: 'danger', attrs: 'data-doclose' }),
          onMount(m) { m.querySelector('[data-doclose]').addEventListener('click', () => { const id = m.querySelector('[data-cuser]').value; const who = (people.find((u) => u.userId === id) || {}).displayName; App.closeOverlay(); act(() => App.post(S + '/realtime/close', { userId: id }), 'Rooms of ' + who + ' closed on every instance. Audit event written.', 'realtime', 'Not closed'); }); } });
      });

      // relations
      ctx.on('change', '[data-rule]', (e, t) => { st.pendingRules = st.pendingRules || {}; st.pendingRules[t.dataset.rule] = t.value; });
      ctx.on('click', '[data-applyrule]', (e, t) => {
        const r = st.data.relations.rules.find((x) => x.workspaceId === t.dataset.applyrule); if (!r) return;
        const next = (st.pendingRules && st.pendingRules[r.workspaceId]) || r.contactRule;
        const label = (CONTACT.find((c) => c.value === next) || {}).label;
        ctx.confirm({ title: 'Apply the contact rule for ' + esc(r.name), tone: 'info', body: '<p class="fg2" style="margin:0">New conversations in ' + esc(r.name) + ' may be started by <b>' + esc(label) + '</b>. Existing conversations continue; blocks always win.</p>', ok: 'Apply' })
          .then((ok) => { if (!ok) return; if (st.pendingRules) delete st.pendingRules[r.workspaceId]; putPolicy(r.workspaceId, { contactRule: next }, 'Contact rule for ' + r.name + ' applied. Audit event written.', 'relations'); });
      });
    }
  });
})();
