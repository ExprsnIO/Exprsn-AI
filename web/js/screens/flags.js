(function () {
  const { UI, esc } = App;

  const SEV_RANK = { high: 0, medium: 1, low: 2 };
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const left = (f) => Math.round((f.dueAt - Date.now()) / 60000);
  const timeText = (f) => { if (f.restricted) return 'above your clearance'; const l = left(f); return l < 0 ? 'overdue ' + -l + ' min' : l >= 1440 ? Math.round(l / 1440) + ' d left' : l >= 120 ? Math.round(l / 60) + ' h left' : l + ' min left'; };
  const cpText = (c) => String(c || '').replace(/-/g, ' ');
  const titleOf = (f) => (f.restricted ? 'Restricted item' : f.rule || 'Flag');
  const overlayOpen = () => !!document.getElementById('overlay');
  const ESCALATE = [{ value: 'workspace', label: 'Workspace guardrail admin' }, { value: 'tenant', label: 'Tenant guardrail admins' }, { value: 'platform', label: 'Platform guardrail admins' }];

  // New and changed flags arrive as flags.changed (ids only); the queue is fetched again, redacted for this reviewer.
  const live = { sock: null, onChange: null, timer: null, refresh: null };
  const detach = () => { if (live.sock && live.onChange) live.sock.off('flags.changed', live.onChange); live.sock = null; live.onChange = null; if (live.timer) { clearTimeout(live.timer); live.timer = null; } };
  const attach = () => {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.onChange = () => {
      if (App.state.route !== 'flags') { detach(); return; }
      if (live.timer) return;
      live.timer = setTimeout(() => { live.timer = null; if (live.refresh) live.refresh(); }, 1000);
    };
    live.sock.on('flags.changed', live.onChange);
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'flags') detach(); });

  App.register({
    id: 'flags', title: 'Flags', live: true, section: 'admin',
    summary: 'Review queue, severity timers, span highlighting, confirm, dismiss, escalate, eval set',
    crumb: () => ['Admin', 'Flags'],
    label: (st) => { const f = st.detail && st.detail.ref === st.sel ? st.detail : null; return f ? f.label : null; },
    commands: [
      { label: 'Review the next flag', sub: 'Flags', run(app) { const s = app.stateFor('flags'); const q = (s.items || []).filter((f) => !f.restricted); if (q.length) s.sel = q[0].ref; app.render(); } }
    ],
    states: [
      { title: 'Above clearance', tone: 'warn', text: 'The item is restricted and the reviewer is cleared to confidential. Content is redacted and the only action is reassign.', apply(ctx) { const st = ctx.state; const f = (st.items || []).find((x) => x.restricted); if (f) { st.sel = f.ref; st.forceEmpty = false; } else st.demoNote = 'Nothing in your queue is above your clearance (' + ((App.me && App.me.user && App.me.user.clearance) || 'unknown') + '). A flag labelled above it shows redacted, and the only action is to reassign it.'; ctx.rerender(); } },
      { title: 'Timer breached', tone: 'danger', text: 'Overdue items move to the top and notify the workspace\'s guardrail admin.', apply(ctx) { const st = ctx.state; const f = (st.items || []).find((x) => left(x) < 0); st.sort = 'time'; st.forceEmpty = false; if (f) { st.sel = f.ref; st.breached = true; } else st.demoNote = 'No flag is past its timer. Overdue flags move to the top of every reviewer\'s queue and the guardrail admins are notified once.'; ctx.rerender(); } },
      { title: 'Queue empty', tone: 'ok', text: 'States that nothing is waiting and shows the last 24 hours of decisions.', apply(ctx) { ctx.state.forceEmpty = true; ctx.rerender(); } },
      { title: 'Confirmed', tone: 'neutral', text: 'A confirmed flag becomes an eval case. A dismissal counts as a false positive against the rule.', apply(ctx) { const st = ctx.state; const f = (st.items || []).find((x) => x.ref === st.sel && !x.restricted) || (st.items || []).find((x) => !x.restricted); if (!f) { ctx.toast('Nothing left to confirm.'); return; } st.sel = f.ref; decide(ctx, f, 'confirmed'); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.sevFilter = st.sevFilter || 'all'; st.sort = st.sort || 'oldest'; st.evalSet = st.evalSet || {};
      const later = () => { if (App.state.route !== 'flags') return; if (overlayOpen()) { setTimeout(later, 250); return; } ctx.rerender(); };
      const loadDetail = (ref) => { st.detailFor = ref; return App.get('/api/flags/' + enc(ref)).then((dt) => { st.detail = dt; }).catch((err) => { if (err.status === 404) st.detail = null; else App.fail(err); }); };
      const load = (quiet) => {
        if (st.loading) { st.again = true; return; }
        st.loading = true;
        Promise.all([App.get('/api/flags'), App.get('/api/flags/decisions').catch(() => [])])
          .then(([q, decided]) => {
            Object.assign(st, { items: q.items, open: q.open, overdue: q.overdue, other: q.otherWorkspaces, decided: decided, loaded: true, loadError: null });
            if (!st.items.some((x) => x.ref === st.sel)) st.sel = null;
            return st.sel ? loadDetail(st.sel) : null;
          })
          .catch((err) => { if (!quiet) st.loadError = err; })
          .finally(() => { st.loading = false; if (st.again) { st.again = false; load(true); return; } later(); });
      };
      live.refresh = () => load(true);
      attach();
      if (!st.loaded && !st.loadError) load();
      else if (st.quiet) { st.quiet = false; load(true); }
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Flags', 'The review queue', '') + (st.loadError ? UI.problem('The queue could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }

      if (ctx.params.id) { const want = ctx.params.id; delete ctx.params.id; if (st.items.some((x) => x.ref === want || x.id === want)) { st.sel = st.items.find((x) => x.ref === want || x.id === want).ref; st.forceEmpty = false; } }
      const overdue = st.items.filter((f) => left(f) < 0).length;
      let list = st.items.filter((f) => st.sevFilter === 'all' || f.severity === st.sevFilter);
      list = list.slice().sort((a, b) => {
        if (st.breached || st.sort === 'time') { const ao = left(a) < 0 ? 0 : 1, bo = left(b) < 0 ? 0 : 1; if (ao !== bo) return ao - bo; }
        if (st.sort === 'severity') return (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (a.dueAt - b.dueAt);
        if (st.sort === 'time') return a.dueAt - b.dueAt;
        return a.createdAt - b.createdAt;
      });
      if (!st.sel && list.length) st.sel = list[0].ref;
      const item = st.items.find((x) => x.ref === st.sel) || null;
      if (item && !(st.detail && st.detail.ref === item.ref) && st.detailFor !== item.ref) loadDetail(item.ref).then(later);
      const f = item && st.detail && st.detail.ref === item.ref ? st.detail : null;
      const clearance = (App.me && App.me.user && App.me.user.clearance) || 'public';

      let main;
      if (!item || st.forceEmpty) {
        main = UI.pagehead(st.forceEmpty && st.items.length ? 'Queue empty (preview)' : 'Queue empty', st.forceEmpty && st.items.length ? 'This is what reviewers see when nothing is waiting. ' + st.items.length + ' flag' + (st.items.length === 1 ? ' is' : 's are') + ' still in your queue.' : 'Nothing is waiting for review in ' + esc((App.me && App.me.workspaces || []).filter((w) => w.id === App.me.workspace).map((w) => w.name)[0] || 'this workspace') + '.')
          + UI.notice('<b>Nothing is waiting.</b> New flags arrive over /ws and by email for high severity. Timers start when a flag is created.', 'ok', UI.btn(st.forceEmpty ? 'Back to the queue' : 'Reload queue', { size: 'sm', attrs: 'data-reload' }))
          + UI.panel('Last 24 hours of decisions', UI.table(['Flag', 'Rule', 'Decision', 'By', 'When'], (st.decided || []).map((d) => ['<span class="mono">' + esc(d.ref) + '</span>', esc(d.rule), UI.pill(d.action, d.action === 'confirmed' || d.action === 'approved' ? 'ok' : d.action === 'dismissed' ? '' : d.action === 'rejected' ? 'danger' : 'info'), esc(d.by || ''), esc(when(d.at))]), { clickable: false, minWidth: '0', emptyTitle: 'No decisions yet' }) + '<div class="muted" style="font-size:12px">Confirmed flags are eval cases and classifier training data. Dismissals count as false positives against their rule. <a href="#" data-goaudit>Full history in Usage and audit</a></div>');
      } else if (!f) {
        main = UI.pagehead(titleOf(item), 'Loading the flag…') + UI.notice('Loading…', 'info');
      } else if (f.restricted) {
        main = UI.pagehead('Restricted item', 'Flagged at the ' + esc(cpText(f.checkpoint)) + ' checkpoint, ' + esc(when(f.createdAt)) + '. Conversation and actor are redacted.', UI.label(f.label))
          + UI.notice('<b>Above your clearance.</b> This flag is labelled ' + esc(f.label) + ' and your clearance is ' + esc(clearance) + '. Content, actor and conversation are redacted. The only action is to reassign it to a reviewer cleared for ' + esc(f.label) + '.', 'warn')
          + UI.panel('Flagged span in context', '<div class="flags-answer serif"><span class="flags-redacted">Redacted: ' + esc(f.label) + ' content is shown only to reviewers cleared for ' + esc(f.label) + '.</span></div>')
          + UI.panel('Details', UI.kv([['Rule', esc(f.setName || 'Rule set') + ', rule redacted'], ['Actor', '(redacted)'], ['Severity', esc(f.severity)], ['Time remaining', esc(timeText({ dueAt: f.dueAt }))], ['Prior decisions on this rule', '(redacted)']], 5))
          + '<div class="panel flags-bar"><div class="hstack wrap">' + UI.btn('Reassign', { kind: 'primary', attrs: 'data-reassign' }) + '<span class="mono muted">R</span>' + UI.btn('Confirm', { disabled: true }) + UI.btn('Dismiss as false positive', { disabled: true }) + UI.btn('Escalate', { disabled: true }) + '<span class="muted" style="font-size:12px">J and K move through the queue</span></div></div>';
      } else {
        const inEval = st.evalSet[f.id] || !!f.evalSet;
        const l = left(f);
        const ex = f.excerpt;
        const convo = f.conversationId && f.ownConversation ? '<a href="#" data-goconvo="' + esc(f.conversationId) + '">open it</a>' : f.conversationId ? 'another user\'s' : 'none';
        main = UI.pagehead(titleOf(f), 'Flagged at the ' + esc(cpText(f.checkpoint)) + ' checkpoint, ' + esc(when(f.createdAt)) + ', conversation ' + convo, UI.label(f.label) + (l < 0 ? UI.pill('overdue', 'danger') : '') + (f.stage === 'shadow' ? UI.pill('shadow', 'info') : '') + (inEval ? UI.pill('in eval set', 'info') : ''))
          + (l < 0 ? UI.notice('<b>Timer breached.</b> ' + esc(f.ref) + ' is ' + -l + ' min past its ' + f.slaMinutes + ' min timer. Overdue items sit at the top of every reviewer\'s queue and the guardrail admins were notified.', 'danger') : '')
          + (st.lastDecision ? UI.notice(st.lastDecision, 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearlast' })) : '')
          + UI.panel('Flagged span in context', '<div class="flags-answer serif">' + (ex ? (ex.clippedBefore ? '… ' : '') + esc(ex.before) + '<mark>' + esc(ex.span) + '</mark>' + esc(ex.after) + (ex.clippedAfter ? ' …' : '') : '<span class="muted">No text was kept with this flag.</span>') + '</div>' + (f.note ? '<span class="muted" style="font-size:12px">' + esc(f.note) + '</span>' : ''), { actions: f.conversationId && f.ownConversation ? UI.btn('Open the turn', { kind: 'ghost', size: 'xs', attrs: 'data-goconvo="' + esc(f.conversationId) + '"' }) : '' })
          + UI.panel('Details', UI.kv([
            ['Rule', f.ruleId && f.setId ? '<a href="#" data-gorule="' + esc(f.ruleId) + '">' + esc(f.rule) + '</a>, ' + esc(f.setName || '') + (f.setVersion ? ' v' + f.setVersion : '') : esc(f.rule) + (f.setName ? ', ' + esc(f.setName) : '')],
            ['Actor', esc(f.actor ? (f.actor.name || 'unknown') + (f.actor.via ? ', ' + f.actor.via : '') : 'unknown')],
            ['Severity', esc(f.severity)],
            ['Time remaining', l < 0 ? '<span style="color:var(--danger-fg)">overdue by ' + -l + ' min</span>' : l + ' min of ' + f.slaMinutes],
            ['Prior decisions on this rule', f.prior ? f.prior.confirmed + ' confirmed, ' + f.prior.dismissed + ' dismissed' : 'none']
          ], 5))
          + (f.kind === 'hold' ? UI.panel('Held answer', f.held ? '<div class="flags-answer serif">' + esc(f.held.content) + '</div><span class="muted" style="font-size:12px">The owner sees "Held for review" until you decide. Approving shows them this answer as it is; rejecting withdraws it.</span>' : UI.notice('The answer is no longer stored (its conversation was deleted). Rejecting closes the flag.', 'warn')) : '')
          + '<div class="panel flags-bar"><div class="hstack wrap">'
          + (f.kind === 'hold'
            ? UI.btn('Approve answer', { kind: 'primary', attrs: 'data-act="approved"', disabled: !f.held || f.held.state !== 'held' }) + '<span class="mono muted">A</span>' + UI.btn('Reject answer', { attrs: 'data-act="rejected"' }) + '<span class="mono muted">X</span>'
            : UI.btn('Confirm', { kind: 'primary', attrs: 'data-act="confirmed"' }) + '<span class="mono muted">C</span>')
          + (f.kind === 'hold' ? '' : UI.btn('Dismiss as false positive', { attrs: 'data-act="dismissed"' }) + '<span class="mono muted">D</span>')
          + UI.btn('Escalate', { attrs: 'data-act="escalated"' }) + '<span class="mono muted">E</span>'
          + (f.kind === 'hold' ? '' : UI.btn('Send to eval set', { attrs: 'data-eval', disabled: inEval }) + '<span class="mono muted">S</span>')
          + '<span class="muted" style="font-size:12px">J and K move through the queue</span></div></div>';
      }

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .flags-list{display:flex;flex-direction:column;gap:2px}'
        + '#main .flags-answer{font-size:16px;line-height:1.55;max-width:680px;white-space:pre-wrap}'
        + '#main .flags-answer mark{background:var(--warn-bg);color:inherit;border-radius:2px;padding:0 2px}'
        + '#main .flags-redacted{display:inline-block;padding:6px 10px;background:var(--sel);color:var(--muted);font-family:var(--sans);font-size:13px;border-radius:4px}'
        + '#main .flags-bar{padding:10px 14px}#main .flags-bar .mono{margin:0 6px 0 -2px;font-size:11px}'
        + '#main:focus{outline:none}'
        + '</style>'
        + '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Queue, ' + st.open + ' open</div>' + (overdue ? UI.pill(overdue + ' overdue', 'danger') : '') + '</div>'
        + '<div class="hstack gap6"><span class="relative">' + UI.btn(st.sevFilter === 'all' ? 'Severity' : 'Severity: ' + st.sevFilter, { size: 'sm', icon: 'filter', attrs: 'data-sevmenu', cls: st.sevFilter === 'all' ? '' : 'active' }) + '</span><span class="relative">' + UI.btn({ oldest: 'Oldest first', severity: 'By severity', time: 'Least time left' }[st.sort], { size: 'sm', icon: 'sort', attrs: 'data-sortmenu' }) + '</span></div>'
        + '<div class="flags-list">' + list.map((x) => UI.listItem(esc(titleOf(x)), esc(x.kind === 'report' && x.note ? x.note.replace(/^Reporter chose /, '').split('.')[0] + ', ' + timeText(x) : cpText(x.checkpoint) + ', ' + timeText(x)), { active: x.ref === st.sel && !st.forceEmpty, attrs: 'data-flag="' + esc(x.ref) + '"', right: x.restricted ? UI.pill('reassign', 'info') : UI.pill(x.severity, x.severity === 'high' ? 'danger' : x.severity === 'medium' ? 'warn' : '') })).join('') + (list.length ? '' : st.items.length ? UI.empty('No flags match', 'Clear the severity filter to see the rest of the queue.') : '') + '</div>'
        + (st.other ? '<div class="muted" style="font-size:12px;padding:4px 8px">' + st.other + ' more in workspaces you also review. <a href="#" data-other>Show</a></div>' : '') + '</div>'
        + '<div class="page">' + (st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-demook' })) : '') + main
        + '<div style="margin-top:auto"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      // ---- keyboard shortcuts while this screen is shown ----
      root.setAttribute('tabindex', '-1');
      if (st.keyHandler) root.removeEventListener('keydown', st.keyHandler);
      st.keyHandler = (e) => {
        if (ctx.app.state.route !== 'flags') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (/input|textarea|select/i.test(e.target.tagName) || document.getElementById('overlay')) return;
        const k = e.key.toLowerCase();
        if (k === 'j' || k === 'k') { const ids = list.map((x) => x.ref); const i = ids.indexOf(st.sel); const n = k === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1); if (ids[n] && ids[n] !== st.sel) select(ids[n]); e.preventDefault(); return; }
        if (!f || st.forceEmpty) return;
        if (f.restricted) { if (k === 'r') { const b = ctx.$('[data-reassign]'); if (b) b.click(); e.preventDefault(); } return; }
        if (f.kind === 'hold') { if (k === 'a') decide(ctx, f, 'approved'); else if (k === 'x') decide(ctx, f, 'rejected'); else if (k === 'e') decide(ctx, f, 'escalated'); else return; e.preventDefault(); return; }
        if (k === 'c') decide(ctx, f, 'confirmed'); else if (k === 'd') decide(ctx, f, 'dismissed'); else if (k === 'e') decide(ctx, f, 'escalated'); else if (k === 's') sendToEval(ctx, f); else return;
        e.preventDefault();
      };
      root.addEventListener('keydown', st.keyHandler);
      if (!root.contains(document.activeElement) || document.activeElement === document.body) root.focus({ preventScroll: true });

      function select(ref) { st.sel = ref; st.lastDecision = null; st.forceEmpty = false; st.detail = null; st.detailFor = null; ctx.rerender(); }

      // ---- events ----
      ctx.on('click', '[data-flag]', (e, t) => select(t.dataset.flag));
      ctx.on('click', '[data-act]', (e, t) => decide(ctx, f, t.dataset.act));
      ctx.on('click', '[data-eval]', () => sendToEval(ctx, f));
      ctx.on('click', '[data-clearlast]', () => { st.lastDecision = null; ctx.rerender(); });
      ctx.on('click', '[data-demook]', () => { st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-reassign]', () => {
        App.get('/api/flags/' + enc(f.ref) + '/reviewers').then((people) => {
          if (!people.length) { ctx.toast('No other reviewer is cleared for ' + esc(f.label) + '. Ask a tenant admin to grant one.', 'warn', 6000); return; }
          ctx.modal({ title: 'Reassign ' + esc(f.label) + ' flag', body: UI.field('Reviewer cleared for ' + esc(f.label), UI.select(people.map((u) => ({ value: u.id, label: u.name + ' (' + (u.roles.indexOf('guardrail-admin') >= 0 ? 'Guardrail admin' : u.roles.indexOf('system-admin') >= 0 ? 'System admin' : 'Flag reviewer') + ', ' + u.clearance + ')' })), people[0].id, 'data-who')) + UI.notice('You never see the content. The timer keeps running; the new reviewer is notified now.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reassign', { kind: 'primary', attrs: 'data-doreassign' }),
            onMount(m) { m.querySelector('[data-doreassign]').addEventListener('click', () => { App.post('/api/flags/' + enc(f.ref) + '/reassign', { userId: m.querySelector('[data-who]').value }).then((r) => { App.closeOverlay(); advance(ctx, f, null); ctx.toast(esc(f.ref) + ' reassigned to ' + esc(r.assigneeName) + '. Removed from your queue.', 'ok'); }).catch((err) => App.fail(err, 'Not reassigned')); }); } });
        }).catch((err) => App.fail(err));
      });
      ctx.on('click', '[data-sevmenu]', (e, t) => openMenu(ctx, t, [['all', 'All severities'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], st.sevFilter, (v) => { st.sevFilter = v; ctx.rerender(); }));
      ctx.on('click', '[data-sortmenu]', (e, t) => openMenu(ctx, t, [['oldest', 'Oldest first'], ['severity', 'By severity'], ['time', 'Least time left']], st.sort, (v) => { st.sort = v; st.breached = false; ctx.rerender(); }));
      ctx.on('click', '[data-goconvo]', (e, t) => { e.preventDefault(); ctx.navigate('chat', { convo: t.dataset.goconvo }); });
      ctx.on('click', '[data-gorule]', (e, t) => { e.preventDefault(); ctx.navigate('guardrails', { rule: t.dataset.gorule }); });
      ctx.on('click', '[data-goaudit]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
      ctx.on('click', '[data-other]', (e) => { e.preventDefault(); ctx.toast('Queues of other workspaces open in their own workspace context. Switch workspace from the sidebar.'); });
      ctx.on('click', '[data-reload]', () => { st.forceEmpty = false; st.breached = false; st.lastDecision = null; st.loaded = false; ctx.rerender(); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });

  function openMenu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + it[0] + '" class="' + (it[0] === active ? 'on' : '') + '">' + it[1] + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  /** After a decision the flag leaves the queue; the next one is selected and the queue is fetched again. */
  function advance(ctx, f, message) {
    const st = ctx.state;
    const idx = st.items.findIndex((x) => x.ref === f.ref);
    st.items = st.items.filter((x) => x.ref !== f.ref); st.open = Math.max(0, st.open - 1);
    const next = st.items[Math.min(idx, st.items.length - 1)];
    st.sel = next ? next.ref : null; st.detail = null; st.detailFor = null; st.breached = st.breached && st.items.some((x) => left(x) < 0);
    st.lastDecision = message;
    st.quiet = true; ctx.rerender();
  }

  async function decide(ctx, f, action) {
    const st = ctx.state;
    if (!f || f.restricted) return;
    const copy = {
      approved: { title: 'Approve the held answer', tag: 'approve', tone: 'info', body: '<p style="margin:0" class="fg2">The answer is shown to its owner as it was generated, and they are notified. Counts as a false positive against <b>' + esc(f.rule) + '</b>.</p>', ok: 'Approve' },
      rejected: { title: 'Reject the held answer', tag: 'reject', tone: 'danger', body: '<p style="margin:0" class="fg2">The answer is withdrawn: its text is replaced with a notice and never reaches the owner, who is notified. Counts as a true positive for <b>' + esc(f.rule) + '</b>.</p>', ok: 'Reject' },
      confirmed: { title: 'Confirm flag', tag: 'confirm', tone: 'info', body: '<p style="margin:0" class="fg2">The flag is recorded as a true positive. The span becomes an eval case for <b>' + esc(f.rule) + '</b> and training data for its classifier.</p>', ok: 'Confirm' },
      dismissed: { title: 'Dismiss as false positive', tag: 'false positive', tone: 'warn', body: '<p style="margin:0" class="fg2">Counts as a false positive against <b>' + esc(f.rule) + '</b>. Enough dismissals lower its promotion score and show on the Guardrails page.</p>' + UI.field('Reason', UI.select(['Figure is grounded in the cited source', 'Rule matched benign text', 'Content is within policy', 'Other'], 'Rule matched benign text', 'data-reason')), ok: 'Dismiss' },
      escalated: { title: 'Escalate', tag: 'escalate', tone: 'danger', body: '<p style="margin:0" class="fg2">Moves the flag to the guardrail admins with a fresh 60 min timer. Use it when the decision needs someone with more context or clearance.</p>' + UI.field('Escalate to', UI.select(ESCALATE, 'workspace', 'data-to')) + UI.field('Note', UI.textarea('', { placeholder: 'What should they look at?', rows: 2, attrs: 'data-note' })), ok: 'Escalate' }
    }[action];
    // Values chosen in the dialog are read as it closes.
    let picked = {};
    const watch = () => { const o = document.getElementById('overlay'); if (!o) return; const r = o.querySelector('[data-reason]'), t = o.querySelector('[data-to]'), n = o.querySelector('[data-note]'); o.addEventListener('change', () => { picked = { reason: r && r.value, to: t && t.value, note: n && n.value }; }); o.addEventListener('input', () => { picked = { reason: r && r.value, to: t && t.value, note: n && n.value }; }); picked = { reason: r && r.value, to: t && t.value, note: n && n.value }; };
    setTimeout(watch, 0);
    const ok = await ctx.confirm({ title: copy.title, tag: copy.tag, tone: copy.tone, body: copy.body, kv: [['Flag', esc(f.ref)], ['Rule', esc(f.rule)], ['Severity', esc(f.severity)], ['Label', esc(f.label)]], ok: copy.ok });
    if (!ok) return;
    try {
      if (action === 'escalated') {
        await App.post('/api/flags/' + encodeURIComponent(f.ref) + '/escalate', { to: picked.to || 'workspace', note: picked.note || null });
        const to = (ESCALATE.find((x) => x.value === (picked.to || 'workspace')) || ESCALATE[0]).label;
        advance(ctx, f, '<b>' + esc(f.ref) + ' escalated</b> to the ' + esc(to) + ' with a fresh 60 min timer.');
        ctx.toast(esc(f.ref) + ' escalated. The guardrail admins are notified.', 'warn');
        return;
      }
      if (action === 'approved' || action === 'rejected') {
        await App.post('/api/flags/' + encodeURIComponent(f.ref) + '/decide', { decision: action });
        advance(ctx, f, '<b>' + esc(f.ref) + (action === 'approved' ? ' approved.</b> The answer is now shown to its owner.' : ' rejected.</b> The answer was withdrawn.'));
        ctx.toast(action === 'approved' ? esc(f.ref) + ' approved. The owner is notified.' : esc(f.ref) + ' rejected. The answer is withdrawn and the owner is notified.', action === 'approved' ? 'ok' : 'warn');
        return;
      }
      const r = await App.post('/api/flags/' + encodeURIComponent(f.ref) + '/decide', { decision: action, reason: action === 'dismissed' ? picked.reason || null : null });
      advance(ctx, f, action === 'confirmed' ? '<b>' + esc(f.ref) + ' confirmed.</b> ' + (r.evalCase ? 'It is now eval case <span class="mono">' + esc(r.evalCase) + '</span> and training data for ' + esc(f.rule) + '.' : 'Recorded as a true positive.')
        : '<b>' + esc(f.ref) + ' dismissed.</b> Counted as a false positive against ' + esc(f.rule) + '.' + (f.ruleId ? ' <a href="#" data-gorule="' + esc(f.ruleId) + '">See the rule\'s false-positive rate</a>.' : ''));
      ctx.toast(action === 'confirmed' ? esc(f.ref) + ' confirmed. Eval case created; audit entry written.' : esc(f.ref) + ' dismissed as a false positive.', action === 'confirmed' ? 'ok' : '');
    } catch (err) {
      App.fail(err, 'Not recorded');
      st.quiet = true; ctx.rerender();
    }
  }

  function sendToEval(ctx, f) {
    const st = ctx.state; if (!f || f.restricted || st.evalSet[f.id] || f.evalSet) return;
    App.get('/api/eval-sets').then((sets) => {
      const def = f.ruleId || 'user-report';
      const opts = sets.map((x) => ({ value: x.name, label: x.name + ' (' + x.cases + ' case' + (x.cases === 1 ? '' : 's') + ')' })).concat([{ value: '', label: 'New eval set' }]);
      ctx.modal({ title: 'Send to eval set', body: UI.field('Eval set', UI.select(opts, sets.some((x) => x.name === def) ? def : sets.length ? sets[0].name : '', 'data-set')) + '<div data-newwrap' + (sets.length ? ' hidden' : '') + '>' + UI.field('New eval set name', UI.input(def, { attrs: 'data-newname' })) + '</div>' + UI.field('Expected outcome', UI.select([{ value: 'positive', label: 'Rule should fire (positive case)' }, { value: 'negative', label: 'Rule should not fire (negative case)' }], 'positive', 'data-exp')) + UI.notice('The flagged text and its label go into the set, sealed. The flag stays in the queue until you decide it.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add case', { kind: 'primary', attrs: 'data-addcase' }),
        onMount(m) {
          const sel = m.querySelector('[data-set]'); const wrap = m.querySelector('[data-newwrap]');
          sel.addEventListener('change', () => { wrap.hidden = sel.value !== ''; });
          m.querySelector('[data-addcase]').addEventListener('click', () => {
            const name = sel.value || m.querySelector('[data-newname]').value.trim();
            if (!/^[\w.-]{1,100}$/.test(name)) { ctx.toast('Name the eval set with letters, digits, dots, dashes or underscores.', 'warn'); return; }
            App.post('/api/flags/' + encodeURIComponent(f.ref) + '/eval', { evalSet: name, expected: m.querySelector('[data-exp]').value })
              .then((r) => { App.closeOverlay(); st.evalSet[f.id] = true; ctx.rerender(); ctx.toast('Added to ' + esc(r.evalSet) + ' as case ' + r.case + '.', 'ok', 5000); })
              .catch((err) => App.fail(err, 'Not added'));
          });
        } });
    }).catch((err) => App.fail(err));
  }
})();
