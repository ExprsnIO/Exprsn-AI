(function () {
  const { UI, esc } = App;

  // Moderation (B-3405): routed review queues with SLA timers, reports, appeals, actions, sanctions, external providers
  // and the dead-letter queue, all over /api/moderation (docs/api.md, Sprint 26c). Flags themselves are decided on the
  // Flags screen; this one routes them, hides objects behind them, decides appeals and keeps sanctions.
  const SEV_RANK = { high: 0, medium: 1, low: 2 };
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const leftOf = (f) => Math.round((f.dueAt - Date.now()) / 60000);
  const timeText = (left) => (left < 0 ? 'overdue ' + -left + ' min' : left >= 1440 ? Math.round(left / 1440) + ' d left' : left >= 120 ? Math.round(left / 60) + ' h left' : left + ' min left');
  const sevPill = (s) => UI.pill(s, s === 'high' ? 'danger' : s === 'medium' ? 'warn' : '');
  const small = (t) => '<span class="muted" style="font-size:12px">' + t + '</span>';
  const overlayOpen = () => !!document.getElementById('overlay');
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const UNROUTED = 'unrouted';
  const meId = () => (App.me && App.me.user ? App.me.user.id : null);
  const reasonOf = (f) => { const m = /^Reporter chose "([^"]*)"\.\s*([\s\S]*)$/.exec(f.note || ''); return m ? { reason: m[1], note: m[2] } : { reason: f.rule || 'Report', note: f.note || '' }; };

  // Appeal and flag changes arrive over the socket (permission rooms); the screen fetches again, quietly.
  const live = { sock: null, fn: null, timer: null, refresh: null };
  const detach = () => { if (live.sock && live.fn) { live.sock.off('moderation.appeals.changed', live.fn); live.sock.off('flags.changed', live.fn); } live.sock = null; live.fn = null; if (live.timer) { clearTimeout(live.timer); live.timer = null; } };
  const attach = () => {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.fn = () => {
      if (App.state.route !== 'moderation') { detach(); return; }
      if (live.timer) return;
      live.timer = setTimeout(() => { live.timer = null; if (live.refresh) live.refresh(); }, 1000);
    };
    live.sock.on('moderation.appeals.changed', live.fn);
    live.sock.on('flags.changed', live.fn);
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'moderation') detach(); });

  function menu(ctx, anchor, items, active, pick) {
    const host = anchor.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it[0]) + '" class="' + (it[0] === active ? 'on' : '') + '">' + esc(it[1]) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; d.remove(); pick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!d.contains(ev.target)) { d.remove(); document.removeEventListener('click', off); } }), 0);
  }

  // 1.6.0 (B-4701): a public form submission the user-input guardrail held waits as a hold flag; its values come from
  // GET /api/apps/held/:id and Accept or Reject goes through POST /api/apps/held/:id/decide.
  const HELD = 'app-form-submission';
  const isHeld = (f) => !!(f && f.kind === 'hold' && f.object && f.object.type === HELD);
  function heldBlock(sel, st) {
    const id = sel.object.id; const h = st.held && st.held[id];
    if (!h) return '<div class="eyebrow" style="margin-top:10px">Held submission</div>' + small(st.heldError && st.heldError[id] ? esc(st.heldError[id]) : 'Loading the submitted values');
    const heldFields = h.held.map((x) => x.field);
    const vals = h.values ? Object.keys(h.values).map((k) => [esc(k) + (heldFields.indexOf(k) >= 0 ? ' ' + UI.pill('held', 'warn') : ''), '<span class="serif" style="overflow-wrap:anywhere">' + esc(typeof h.values[k] === 'string' ? h.values[k] : JSON.stringify(h.values[k])) + '</span>']) : [];
    const refused = st.heldRefused && st.heldRefused.id === id ? st.heldRefused.message : null;
    return '<div class="eyebrow" style="margin-top:10px">Held submission</div>'
      + small('A public submission to <b>' + esc(h.form.title || h.form.name || 'a form') + '</b> in ' + esc(h.app.title || h.app.name || 'an app') + ' was held by the user-input guardrail instead of refused. Nothing is recorded until a reviewer accepts it.')
      + (h.state === 'held' ? UI.kv(vals, 1) : UI.kv([['State', UI.pill(h.state, h.state === 'accepted' ? 'ok' : 'danger')]].concat(h.recordId ? [['Record', '<span class="mono">' + esc(h.recordId) + '</span>']] : []), 1))
      + small(h.held.map((x) => esc(x.field) + ': ' + esc(x.rule) + (x.reason ? ', ' + esc(x.reason) : '')).join('; ') + (h.dropped ? '. ' + h.dropped + (h.dropped === 1 ? ' field' : ' fields') + ' not on the form dropped.' : '.'))
      + (refused ? UI.notice('<b>The entity refused the record.</b> ' + esc(refused) + ' The submission is still held; reject it, or accept it once the cause is resolved.', 'danger') : '')
      + (h.state === 'held' ? '<div class="vstack gap6" style="margin-top:8px">' + UI.btn('Accept into a record', { kind: 'primary', attrs: 'data-heldaccept' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-heldreject' }) + (App.can('flags:review') ? UI.btn('Open in Flags', { attrs: 'data-openflag="' + esc(sel.ref) + '"' }) : '') + '</div>' : '');
  }

  /** A confirm dialog whose form fields ([data-v="name"]) are read when the primary button is pressed. */
  function ask(ctx, o) {
    return new Promise((resolve) => {
      let out = null;
      ctx.modal({
        title: esc(o.title) + (o.tag ? ' ' + UI.pill(o.tag, o.tone || 'info') : ''),
        body: (o.body || '') + (o.kv ? UI.kv(o.kv, 2) : ''),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(o.ok || 'Confirm', { kind: o.tone === 'danger' ? 'danger' : 'primary', attrs: 'data-ok' }),
        onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', () => {
            out = {}; m.querySelectorAll('[data-v]').forEach((el) => { out[el.dataset.v] = el.value; });
            App.closeOverlay();
          });
        },
        onClose() { resolve(out); }
      });
    });
  }

  /** Step-up (sanctions need a recent sign-in): a password or an authenticator code, then the call runs once more. */
  function stepUp(ctx) {
    return new Promise((resolve) => {
      const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
      const pw = methods.indexOf('password') >= 0 || methods.indexOf('totp') < 0, totp = methods.indexOf('totp') >= 0;
      let ok = false;
      ctx.modal({ title: 'Confirm it is you',
        body: '<div class="fg2">Sanctions change who may sign in, so they need a fresh check of who you are. ' + (pw && totp ? 'Enter your password or a code from your authenticator.' : totp ? 'Enter a code from your authenticator.' : 'Enter your password.') + '</div>'
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

  const tabsDef = (st) => {
    const t = [
      { id: 'queues', label: 'Queues', count: st.allFlags.length }, { id: 'reports', label: 'Reports', count: st.allFlags.filter((f) => f.checkpoint === 'user-report').length },
      { id: 'appeals', label: 'Appeals', count: st.appeals.filter((a) => a.state === 'pending' || a.state === 'reviewing').length }, { id: 'actions', label: 'Actions' }
    ];
    if (st.sanctions) t.push({ id: 'sanctions', label: 'Sanctions', count: st.sanctions.filter((s) => s.state === 'active').length });
    if (st.providers) t.push({ id: 'providers', label: 'Providers' });
    if (st.dead) t.push({ id: 'dead', label: 'Dead letters', count: st.dead.filter((d) => d.state === 'open').length });
    return t;
  };

  App.register({
    id: 'moderation', title: 'Moderation', live: true, section: 'admin', crumb: ['Admin', 'Moderation'],
    summary: 'Routed queues with SLA timers, reports, appeals, sanctions, external providers, dead-letter queue',
    label: (st) => {
      if (st.tab === 'appeals' && st.appealSel && st.appeals) { const a = st.appeals.find((x) => x.ref === st.appealSel); return a ? a.label : null; }
      if (st.tab === 'queues' && st.flagSel && st.allFlags) { const f = st.allFlags.find((x) => x.ref === st.flagSel); return f ? f.label : null; }
      return null;
    },
    commands: [
      { label: 'Review the next appeal', sub: 'Moderation', run(app) { const s = app.stateFor('moderation'); s.tab = 'appeals'; const a = (s.appeals || []).find((x) => x.state === 'pending'); if (a) s.appealSel = a.ref; app.render(); } },
      { label: 'Issue a sanction', sub: 'Moderation', run(app) { const s = app.stateFor('moderation'); s.tab = 'sanctions'; s.openSanction = true; app.render(); } }
    ],
    states: [
      { title: 'Appeal upheld restores the object', tone: 'ok', text: 'Upholding an appeal on an action restores the object, reopens its flag with a fresh timer and negates the AT-Protocol labels made from it.', apply(ctx) {
        const st = ctx.state; st.tab = 'appeals';
        const a = (st.appeals || []).find((x) => x.state === 'upheld' && x.kind === 'action');
        if (a) { st.appealSel = a.ref; st.appealResult = st.appealResult && st.appealResult.ref === a.ref ? st.appealResult : { ref: a.ref, effects: null }; }
        else st.demoNote = 'No appeal against an action has been upheld yet. When one is, the hidden object is restored to the state it had, its flag reopens with a fresh timer and the AT-Protocol labels made from the flag are negated.';
        ctx.rerender(); } },
      { title: 'Independence refused', tone: 'danger', text: 'Whoever took the decision under appeal, and the appellant, cannot review it: 403 with step independence.', apply(ctx) {
        const st = ctx.state; st.tab = 'appeals';
        const me = meId();
        const a = (st.appeals || []).find((x) => (x.state === 'pending' || x.state === 'reviewing') && (x.userId === me || decidedById(st, x) === me));
        if (a) { st.appealSel = a.ref; st.independence = { ref: a.ref, detail: a.userId === me ? 'You cannot review your own appeal.' : 'You took the decision under appeal; another reviewer decides it.', trace: null }; }
        else st.demoNote = 'No open appeal is against a decision of yours. Reviewing one that is (or your own appeal) is refused with 403, step independence: another reviewer in its workspace must take it.';
        ctx.rerender(); } },
      { title: 'Timer escalated to tenant', tone: 'warn', text: 'A routed flag past its queue SLA moves to the escalation level with a fresh timer and that level is notified.', apply(ctx) {
        const st = ctx.state; st.tab = 'queues'; st.flagSort = 'time';
        const f = (st.allFlags || []).find((x) => x.escalatedTo);
        if (f) { st.queueSel = f.queueId || UNROUTED; st.flagSel = f.ref; st.escalatedNote = f.ref; }
        else st.demoNote = 'No routed flag has passed its queue SLA. When one does, the sweep moves it to the queue\'s escalation level with a fresh timer and notifies that level (event flag.escalated).';
        ctx.rerender(); } },
      { title: 'Held submission waiting', tone: 'warn', text: 'A public form value the user-input guardrail holds is queued for review instead of refused. The reviewer reads the values and accepts it into a record or rejects it.', apply(ctx) {
        const st = ctx.state; st.tab = 'queues'; st.flagKind = 'all'; st.flagType = 'all';
        const f = (st.allFlags || []).find(isHeld);
        if (f) { st.queueSel = f.queueId || UNROUTED; st.flagSel = f.ref; }
        else st.demoNote = 'No public form submission is waiting. When the user-input guardrail holds a value on a public form, the submission waits here as a hold flag with its values, to be accepted into a record or rejected.';
        ctx.rerender(); } },
      { title: 'Accept refused by the entity', tone: 'danger', text: 'Accepting writes the record through the entity\'s own checks. A refusal (a unique value taken meanwhile, a field removed) leaves the submission held and names the reason.', apply(ctx) {
        const st = ctx.state; st.tab = 'queues';
        if (st.heldRefused) { const f = (st.allFlags || []).find((x) => isHeld(x) && x.object.id === st.heldRefused.id); if (f) { st.queueSel = f.queueId || UNROUTED; st.flagSel = f.ref; } }
        else st.demoNote = 'No acceptance has been refused. If the entity refuses the record (a unique value taken meanwhile, a field removed), the submission stays held and the reason shows beside it.';
        ctx.rerender(); } },
      { title: 'Providers disabled', tone: 'info', text: 'Without MODERATION_EXTERNAL_PROVIDERS every provider route answers 403 with step disabled. The list is read-only and nothing is queued.', apply(ctx) {
        const st = ctx.state;
        if (!st.providers) { st.demoNote = 'External providers need the moderation:manage permission, which your roles do not grant.'; ctx.rerender(); return; }
        st.tab = 'providers';
        if (st.providersEnabled) st.demoNote = 'External providers are on for this deployment (MODERATION_EXTERNAL_PROVIDERS is set). Without it, every provider route answers 403 with step disabled and the list is read-only.';
        ctx.rerender(); } },
      { title: 'Dead letter redriven', tone: 'neutral', text: 'A redrive queues the job again with its sealed payload; a second redrive is 409.', apply(ctx) {
        const st = ctx.state;
        if (!st.dead) { st.demoNote = 'The dead-letter queue needs the moderation:manage permission, which your roles do not grant.'; ctx.rerender(); return; }
        st.tab = 'dead';
        const d = st.dead.find((x) => x.state === 'redriven');
        if (d) st.redriveNote = d.id;
        else st.demoNote = 'Nothing has been redriven. A redrive queues the failed moderation job again with its sealed payload; a second redrive of the same entry is refused with 409.';
        ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const canManage = App.can('moderation:manage'), canSanction = App.can('moderation:sanction');
      const later = () => { if (App.state.route !== 'moderation') return; if (overlayOpen()) { setTimeout(later, 250); return; } ctx.rerender(); };
      const load = (quiet) => {
        if (st.loading) { st.again = true; return; }
        st.loading = true;
        Promise.all([
          App.get('/api/moderation/queues'),
          App.get('/api/moderation/appeals'),
          App.get('/api/moderation/actions'),
          App.can('flags:review') ? App.get('/api/flags').catch(() => ({ items: [] })) : { items: [] },
          canSanction ? App.get('/api/moderation/sanctions') : null,
          canManage ? App.get('/api/moderation/providers') : null,
          canManage ? App.get('/api/moderation/dead-letters') : null,
          App.can('moderation:check') || App.can('moderation:report') ? App.get('/api/moderation/types').catch(() => ({ items: [] })) : { items: [] },
          App.can('users:manage') ? App.get('/api/admin/users?limit=500').catch(() => []) : []
        ]).then(async ([q, ap, ac, fl, sa, pv, dl, ty, us]) => {
          const per = await Promise.all(q.items.map((x) => App.get('/api/moderation/queues/' + enc(x.id) + '/flags').catch(() => ({ items: [] }))));
          const routed = [];
          per.forEach((r) => (r.items || []).forEach((f) => routed.push(f)));
          const seen = {}; routed.forEach((f) => { seen[f.id] = true; });
          const unrouted = (fl.items || []).filter((f) => !seen[f.id]).map((f) => Object.assign({}, f, { queueId: UNROUTED, object: null }));
          const names = {}; (us || []).forEach((u) => { names[u.id] = u.displayName || u.username; });
          if (App.me && App.me.user) names[App.me.user.id] = App.me.user.displayName || App.me.user.username;
          Object.assign(st, {
            queues: q.items, allFlags: routed.concat(unrouted), appeals: ap.items, actions: ac.items,
            sanctions: sa ? sa.items : null, providers: pv ? pv.items : null, providersEnabled: pv ? !!pv.enabled : false,
            dead: dl ? dl.items : null, types: ty.items || [], names, users: us || [], loaded: true, loadError: null, appealDetail: null
          });
        })
          .catch((err) => { if (!quiet) st.loadError = err; })
          .finally(() => { st.loading = false; if (st.again) { st.again = false; load(true); return; } later(); });
      };
      live.refresh = () => load(true);
      attach();
      if (!st.loaded && !st.loadError) load();
      else if (st.quiet) { st.quiet = false; load(true); }
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Moderation', 'Routed queues, reports, appeals and sanctions') + (st.loadError ? UI.problem('Moderation could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }

      st.tab = st.tab || 'queues'; st.flagSort = st.flagSort || 'time'; st.flagKind = st.flagKind || 'all'; st.flagType = st.flagType || 'all';
      st.actType = st.actType || 'all'; st.actState = st.actState || 'all'; st.actSource = st.actSource || 'all'; st.sancState = st.sancState || 'all';
      if (ctx.params.appeal) { st.tab = 'appeals'; st.appealSel = ctx.params.appeal; delete ctx.params.appeal; }
      if (ctx.params.queue) { st.tab = 'queues'; st.queueSel = ctx.params.queue; delete ctx.params.queue; }
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }
      if (!tabsDef(st).some((t) => t.id === st.tab)) st.tab = 'queues';

      const nameOf = (id) => (!id ? 'nobody' : st.names[id] || 'user …' + String(id).slice(-6));
      const wsName = (id) => { if (!id) return 'Any workspace'; const w = ((App.me && App.me.workspaces) || []).find((x) => x.id === id); return w ? w.name : 'another workspace'; };
      const flagById = {}; st.allFlags.forEach((f) => { flagById[f.id] = f; });
      const flagLink = (id) => { if (!id) return small('none'); const f = flagById[id]; return f ? '<a href="#" data-openflag="' + esc(f.ref) + '">' + esc(f.ref) + '</a>' : '<span class="mono" title="Decided or closed">…' + esc(String(id).slice(-6)) + '</span>'; };
      const appealById = {}; st.appeals.forEach((a) => { appealById[a.id] = a; });
      const actionById = {}; st.actions.forEach((a) => { actionById[a.id] = a; });
      const sanctionById = {}; (st.sanctions || []).forEach((s) => { sanctionById[s.id] = s; });
      const overdueAll = st.allFlags.filter((f) => leftOf(f) < 0).length;
      const head = UI.pagehead('Moderation', 'Checks, reports and provider verdicts end in flags; this screen routes them, decides appeals and keeps sanctions. Every decision is written to the audit chain.', (overdueAll ? UI.pill(overdueAll + ' overdue', 'danger') : '') + (App.can('flags:review') ? UI.btn('Open Flags queue', { kind: 'ghost', size: 'sm', attrs: 'data-goflags' }) : ''));
      const tabs = UI.tabs(tabsDef(st), st.tab);
      let body = '', aside = '';

      // ---------------- Queues ----------------
      if (st.tab === 'queues') {
        const queues = st.queues.slice().sort((a, b) => a.priority - b.priority);
        const unrouted = st.allFlags.filter((f) => f.queueId === UNROUTED);
        if (!st.queueSel || (st.queueSel !== UNROUTED && !queues.some((x) => x.id === st.queueSel))) st.queueSel = queues.length ? queues[0].id : UNROUTED;
        const q = queues.find((x) => x.id === st.queueSel) || null;
        const qrows = queues.map((x) => {
          const fl = st.allFlags.filter((f) => f.queueId === x.id); const od = fl.filter((f) => leftOf(f) < 0).length;
          return { cells: ['<b>' + esc(x.name) + '</b>', esc(wsName(x.workspaceId)), '<span class="num">' + x.priority + '</span>', x.rules && x.rules.length ? '<span class="mono">' + esc(x.rules.join(', ')) + '</span>' : small('any'), x.labels && x.labels.length ? x.labels.map((l) => UI.label(l, { sm: true })).join(' ') : small('any'), x.kinds && x.kinds.length ? x.kinds.map((k) => UI.pill(k, 'outline')).join(' ') : small('any'), '<span class="num">' + x.slaMinutes + ' min</span>', esc(x.escalateTo) + small(', ' + x.escalationSlaMinutes + ' min'), x.enabled ? UI.pill('enabled', 'ok') : UI.pill('disabled', ''), '<span class="num">' + fl.length + (od ? ' ' + UI.pill(od + ' overdue', 'danger') : '') + '</span>'], attrs: 'data-queue="' + esc(x.id) + '"', selected: x.id === st.queueSel };
        }).concat([{ cells: ['<b>Not routed</b>', esc(wsName(App.me && App.me.workspace)), small('none'), small('no queue matched'), small('any'), small('any'), small('rule timer'), small('none'), UI.pill('flag queue', 'outline'), '<span class="num">' + unrouted.length + '</span>'], attrs: 'data-queue="' + UNROUTED + '"', selected: st.queueSel === UNROUTED }]);
        const inQueue = st.allFlags.filter((f) => f.queueId === st.queueSel);
        let fl = inQueue.filter((f) => st.flagKind === 'all' || f.kind === st.flagKind).filter((f) => st.flagType === 'all' || (f.object && f.object.type === st.flagType));
        fl = fl.slice().sort((a, b) => (st.flagSort === 'severity' ? (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (a.dueAt - b.dueAt) : st.flagSort === 'newest' ? b.createdAt - a.createdAt : a.dueAt - b.dueAt));
        if (!st.flagSel || !fl.some((f) => f.ref === st.flagSel)) st.flagSel = fl.length ? fl[0].ref : null;
        const sel = st.allFlags.find((f) => f.ref === st.flagSel) || null;
        const qname = q ? q.name : 'Not routed';
        const selQueue = sel && sel.queueId !== UNROUTED ? st.queues.find((x) => x.id === sel.queueId) : null;
        body = UI.notice('<b>Routing.</b> A new flag goes to the first enabled queue (lowest priority number) whose workspace, rules, labels and kinds all match; its timer becomes the queue\'s SLA. Past the SLA, the sweep escalates it to the queue\'s escalation level with a fresh timer and notifies that level. A deleted queue leaves its flags unrouted.', 'info')
          + UI.panel('Review queues', UI.table(['Queue', 'Workspace', { label: 'Priority', right: true }, 'Rules', 'Labels', 'Kinds', { label: 'SLA', right: true }, 'Escalates to', 'State', { label: 'Open', right: true }], qrows, { minWidth: '1080px' }),
            { actions: canManage ? UI.btn('New queue', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newqueue' }) + UI.btn('Edit', { size: 'sm', attrs: 'data-editqueue', disabled: !q }) + UI.btn(q && !q.enabled ? 'Enable' : 'Disable', { size: 'sm', attrs: 'data-togglequeue', disabled: !q }) + UI.btn('Delete', { kind: 'ghost', size: 'sm', attrs: 'data-delqueue', disabled: !q }) : small('Changing queues needs moderation:manage') })
          + (st.escalatedNote && sel && sel.ref === st.escalatedNote ? UI.notice('<b>' + esc(sel.ref) + ' escalated.</b> It passed the SLA of ' + esc(qname) + ' and now sits at the ' + esc(sel.escalatedTo) + ' level with a fresh timer (' + esc(timeText(leftOf(sel))) + '). That level was notified (event flag.escalated, audit moderation.queue.escalated).', 'warn', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearesc' })) : '')
          + UI.panel('Flags in ' + qname, '<div class="toolbar"><span class="relative">' + UI.btn(st.flagKind === 'all' ? 'Kind' : 'Kind: ' + st.flagKind, { size: 'sm', icon: 'filter', attrs: 'data-kindmenu', cls: st.flagKind === 'all' ? '' : 'active' }) + '</span><span class="relative">' + UI.btn(st.flagType === 'all' ? 'Object type' : 'Type: ' + st.flagType, { size: 'sm', icon: 'filter', attrs: 'data-typemenu', cls: st.flagType === 'all' ? '' : 'active' }) + '</span><span class="relative">' + UI.btn({ time: 'Least time left', severity: 'By severity', newest: 'Newest first' }[st.flagSort], { size: 'sm', icon: 'sort', attrs: 'data-sortmenu' }) + '</span>' + small(fl.length + ' of ' + inQueue.length + ' flags, ' + inQueue.filter((f) => leftOf(f) < 0).length + ' overdue, ' + inQueue.filter((f) => f.escalatedTo).length + ' escalated') + '</div>'
            + UI.table(['Flag', 'Kind', 'Object', 'Rule or reason', 'Severity', 'Timer', 'Label', 'Raised by'], fl.map((f) => { const l = leftOf(f); return { cells: ['<span class="mono">' + esc(f.ref) + '</span>', UI.pill(f.kind, 'outline'), f.object ? '<span class="mono">' + esc(f.object.type) + '</span> ' + small(esc(f.object.id)) : small(f.restricted ? '(redacted)' : 'not named'), esc(f.restricted ? 'Restricted item' : f.rule || ''), sevPill(f.severity), (l < 0 ? '<span style="color:var(--danger-fg)">' + esc(timeText(l)) + '</span>' : esc(timeText(l))) + (f.escalatedTo ? ' ' + UI.pill('escalated: ' + f.escalatedTo, 'warn') : ''), UI.label(f.label, { sm: true }), esc(f.actor ? f.actor.name || '' : f.restricted ? '(redacted)' : '')], attrs: 'data-flag="' + esc(f.ref) + '"', selected: f.ref === st.flagSel }; }), { minWidth: '900px', emptyTitle: 'No flags match', emptyText: inQueue.length ? 'Clear the kind and type filters, or pick another queue.' : 'Nothing is waiting in this queue.' }));
        const hideable = !!(sel && sel.object && sel.object.hideable && App.can('moderation:review'));
        aside = '<aside class="inspector w360" aria-label="Selected flag">' + (sel ? '<div class="hstack"><div class="eyebrow grow">Selected flag</div>' + UI.label(sel.label, { sm: true }) + '</div><div class="mod-title mono">' + esc(sel.ref) + '</div><div class="fg2">' + esc(sel.restricted ? 'Restricted item' : sel.rule || '') + '</div>'
          + UI.kv([['Kind', esc(sel.kind) + ' at ' + esc(String(sel.checkpoint || '').replace(/-/g, ' '))], ['Object', sel.object ? '<span class="mono">' + esc(sel.object.type) + '</span><br>' + small(esc(sel.object.id)) : small(sel.restricted ? '(redacted)' : 'not named in the flag queue')], ['Raised by', esc(sel.actor ? sel.actor.name || '' : '(redacted)')], ['Severity', sevPill(sel.severity)], ['Timer', leftOf(sel) < 0 ? '<span style="color:var(--danger-fg)">overdue by ' + -leftOf(sel) + ' min</span>' : leftOf(sel) + ' of ' + sel.slaMinutes + ' min'], ['Escalation', sel.escalatedTo ? esc(sel.escalatedTo) + ' level, ' + esc(timeText(leftOf(sel))) : selQueue ? 'none, escalates to ' + esc(selQueue.escalateTo) + ' after ' + selQueue.slaMinutes + ' min' : 'none (not routed)'], ['Created', esc(when(sel.createdAt))]], 1)
          + (isHeld(sel) ? heldBlock(sel, st) : '<div class="vstack gap6" style="margin-top:8px">' + UI.btn('Hide object', { kind: 'primary', attrs: 'data-hide', disabled: !hideable, title: hideable ? '' : 'Only a flag that points at a registered object can hide it' }) + (App.can('flags:review') ? UI.btn('Open in Flags', { attrs: 'data-openflag="' + esc(sel.ref) + '"' }) : '') + (sel.ruleId && App.can('guardrails:manage') ? UI.btn('Rule in Guardrails', { kind: 'ghost', attrs: 'data-gorule="' + esc(sel.ruleId) + '"' }) : '') + '</div>'
          + (hideable ? '' : small(sel.kind === 'hold' ? 'This flag holds an answer or a question. Approve or reject it in Flags.' : sel.queueId === UNROUTED ? 'Flags outside a queue are decided in Flags. Route them with a queue to act on their object here.' : 'This flag points at no object that can be hidden. Decide it in Flags.'))) : UI.empty('No flag selected', 'Pick a row to see its timer and actions.')) + '</aside>';
        if (isHeld(sel)) {
          const hid = sel.object.id; st.held = st.held || {}; st.heldError = st.heldError || {};
          if (!st.held[hid] && !st.heldError[hid] && st.heldLoading !== hid) {
            st.heldLoading = hid;
            App.get('/api/apps/held/' + enc(hid)).then((h) => { st.held[hid] = h; }).catch((err) => { st.heldError[hid] = 'The submission could not be loaded: ' + (err.message || 'error') + '.'; })
              .finally(() => { st.heldLoading = null; if (App.state.route === 'moderation' && !overlayOpen()) ctx.rerender(); });
          }
        }
      }

      // ---------------- Reports ----------------
      if (st.tab === 'reports') {
        const rows = st.allFlags.filter((f) => f.checkpoint === 'user-report').sort((a, b) => b.createdAt - a.createdAt);
        body = UI.panel('Reports', '<div class="toolbar">' + small('A member reports an object they can see; it files a report flag at the user-report checkpoint in the object\'s workspace. The same reporter reporting again while the flag is open gets it back as a duplicate. Open reports are listed; decided ones are in Flags and the audit chain.') + '</div>'
          + UI.table(['Flag', 'Reporter', 'Object', 'Reason', 'Note', 'Severity', 'Due', 'Workspace', ''], rows.map((f) => { const r = reasonOf(f); return { cells: ['<span class="mono">' + esc(f.ref) + '</span>' + (f.kind === 'reviewer' ? ' ' + UI.pill('reviewer', 'outline') : ''), esc(f.actor ? String(f.actor.name || '').replace(/^Reported by /, '') : '(redacted)'), f.object ? '<span class="mono">' + esc(f.object.type) + '</span> ' + small(esc(f.object.id)) : small('in the flag'), esc(r.reason), r.note ? '<span class="serif">' + esc(r.note) + '</span>' : small('none'), sevPill(f.severity), esc(when(f.dueAt)), esc(wsName(f.workspaceId)), App.can('flags:review') ? UI.btn('Open flag', { size: 'xs', attrs: 'data-openflag="' + esc(f.ref) + '"' }) : ''] }; }), { clickable: false, minWidth: '960px', emptyTitle: 'No open reports', emptyText: 'Nothing reported is waiting in your workspaces.' }),
          { actions: App.can('moderation:report') ? UI.btn('File a report', { size: 'sm', attrs: 'data-newreport' }) : '' });
      }

      // ---------------- Appeals ----------------
      if (st.tab === 'appeals') {
        const order = { pending: 0, reviewing: 1, upheld: 2, denied: 2 };
        const list = st.appeals.slice().sort((a, b) => (order[a.state] - order[b.state]) || (b.createdAt - a.createdAt));
        if (!st.appealSel || !st.appeals.some((a) => a.ref === st.appealSel)) st.appealSel = list.length ? list[0].ref : null;
        const a = st.appeals.find((x) => x.ref === st.appealSel) || null;
        const subjectOf = (x) => { if (x.actionId) { const ac = actionById[x.actionId]; return ac ? ac.objectType + ' ' + ac.objectId : 'action …' + x.actionId.slice(-6); } const s = sanctionById[x.sanctionId]; return s ? s.kind + ' of ' + nameOf(s.userId) : 'sanction …' + String(x.sanctionId).slice(-6); };
        const statePill = (s) => UI.pill(s, s === 'pending' ? 'warn' : s === 'reviewing' ? 'info' : s === 'upheld' ? 'ok' : 'danger');
        if (a && a.state !== 'pending' && a.state !== 'reviewing' && st.independence && st.independence.ref === a.ref) st.independence = null;
        if (a && (!st.appealDetail || st.appealDetail.ref !== a.ref) && st.appealDetailFor !== a.ref) {
          st.appealDetailFor = a.ref;
          App.get('/api/moderation/appeals/' + enc(a.ref)).then((d) => { st.appealDetail = d; st.appealDetailFor = null; later(); }).catch((err) => { st.appealDetailFor = null; if (err.status !== 404) App.fail(err); });
        }
        const d = a && st.appealDetail && st.appealDetail.ref === a.ref ? st.appealDetail : null;
        const res = a && st.appealResult && st.appealResult.ref === a.ref ? st.appealResult : null;
        const act = a && a.actionId ? actionById[a.actionId] : null;
        const sanc = a && a.sanctionId ? sanctionById[a.sanctionId] : null;
        const decidedBy = act ? (act.createdBy ? nameOf(act.createdBy) : act.source) : sanc ? nameOf(sanc.createdBy) : 'unknown';
        const decisionReason = act ? act.reason : sanc ? sanc.reason : '';
        const decisionWhen = act ? when(act.createdAt) : sanc ? when(sanc.createdAt) : '';
        let resNotice = '';
        if (res && a.kind === 'action') {
          const e = res.effects;
          const negated = e && e.labelsNegated ? e.labelsNegated.length : 0;
          resNotice = UI.notice('<b>' + esc(a.ref) + ' upheld.</b> ' + (e ? 'Effects: ' + (e.restored ? 'object restored (moderation.action.reversed)' : 'the action is reversed; the object could not be restored (it was deleted or changed meanwhile)') + (e.flagReopened ? ', flag <a href="#" data-openflag="' + esc(e.flagReopened) + '">' + esc(e.flagReopened) + '</a> reopened with a fresh timer (flag.reopened)' : '') + ', ' + negated + ' AT-Protocol label' + (negated === 1 ? '' : 's') + ' negated (atproto.label.negated). The appellant has been notified.' : 'The action ' + (act && act.state === 'reversed' ? 'was reversed ' + esc(when(act.reversedAt)) + ' by ' + esc(nameOf(act.reversedBy)) + ' and the object restored' : 'was reversed') + '; its flag reopened with a fresh timer and the AT-Protocol labels made from it were negated.'), 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearresult' }));
        } else if (res && a.kind === 'sanction') {
          resNotice = UI.notice('<b>' + esc(a.ref) + ' upheld.</b> The sanction ended as reversed; the user\'s sign-in works again. The user has been notified.', 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearresult' }));
        }
        body = UI.panel('Appeals', UI.table(['Appeal', 'Kind', 'Subject', 'Appellant', 'Filed by', 'Label', 'State', 'Filed'], list.map((x) => ({ cells: ['<span class="mono">' + esc(x.ref) + '</span>', esc(x.kind), esc(x.restricted ? '(redacted)' : subjectOf(x)), esc(x.restricted ? '(redacted)' : nameOf(x.userId)), esc(x.restricted ? '(redacted)' : x.filedBy === x.userId ? nameOf(x.filedBy) : nameOf(x.filedBy) + ' (for the user)'), UI.label(x.label, { sm: true }), statePill(x.state) + (x.state === 'reviewing' ? ' ' + small(esc(nameOf(x.reviewerId))) : ''), esc(when(x.createdAt))], attrs: 'data-appeal="' + esc(x.ref) + '"', selected: !!a && x.ref === a.ref })), { minWidth: '860px', emptyTitle: 'No appeals', emptyText: 'Owners of hidden objects and sanctioned users appeal from their own account; their appeals land here.' }), { actions: UI.btn('Record an appeal for someone', { size: 'sm', attrs: 'data-recordappeal' }) })
          + (a && st.independence && st.independence.ref === a.ref ? UI.problem('Independence refused', st.independence.detail + ' ' + a.ref + ' needs another reviewer in ' + wsName(a.workspaceId) + ' cleared for ' + a.label + '. The refusal is 403 with step independence.', st.independence.trace || false) : '')
          + resNotice;
        if (a) {
          const restricted = a.restricted;
          const mine = a.reviewerId === meId();
          aside = '<aside class="inspector w360" aria-label="Selected appeal"><div class="hstack"><div class="eyebrow grow">Appeal ' + esc(a.ref) + '</div>' + statePill(a.state) + '</div>'
            + '<div class="mod-title">' + esc(restricted ? 'Restricted appeal' : subjectOf(a)) + '</div>'
            + UI.kv([['Kind', esc(a.kind) + (a.kind === 'action' ? ' (hide)' : '')], ['Appellant', esc(restricted ? '(redacted)' : nameOf(a.userId))], ['Filed by', esc(restricted ? '(redacted)' : nameOf(a.filedBy))], ['Decision under appeal', restricted ? '(redacted)' : esc(decisionReason) + '<br>' + small('by ' + esc(decidedBy) + (decisionWhen ? ', ' + esc(decisionWhen) : ''))], ['Label', UI.label(a.label, { sm: true })], ['Filed', esc(when(a.createdAt))]]
              .concat(a.state === 'upheld' || a.state === 'denied' ? [['Decided', esc(when(a.decidedAt)) + ' by ' + esc(nameOf(a.reviewerId))], ['Note', esc((d && d.decisionNote) || a.decisionNote || '') || small('none')]] : []), 1)
            + '<div class="eyebrow" style="margin-top:8px">Statement</div>' + (restricted ? '<div class="mod-redacted">Withheld: the appeal is labelled ' + esc(a.label) + ', above your clearance. Only a reviewer cleared for ' + esc(a.label) + ' may read and decide it.</div>' : d ? '<div class="serif mod-statement">' + esc(d.statement || '') + '</div>' : small('Loading the statement'))
            + '<div class="vstack gap6" style="margin-top:10px">' + (a.state === 'pending' ? UI.btn('Review (claim)', { kind: 'primary', attrs: 'data-review', disabled: restricted }) : '') + (a.state === 'reviewing' ? UI.btn('Uphold', { kind: 'primary', attrs: 'data-decide="upheld"', disabled: restricted || !mine }) + UI.btn('Deny', { kind: 'danger', attrs: 'data-decide="denied"', disabled: restricted || !mine }) : '') + (a.actionId ? UI.btn('Show the action', { kind: 'ghost', attrs: 'data-goaction="' + esc(a.actionId) + '"' }) : '') + (a.sanctionId && st.sanctions ? UI.btn('Show the sanction', { kind: 'ghost', attrs: 'data-gosanction="' + esc(a.sanctionId) + '"' }) : '') + '</div>'
            + (a.state === 'reviewing' && !mine ? small('Claimed by ' + esc(nameOf(a.reviewerId)) + '. Deciding while someone else reviews is 409.') : '')
            + '</aside>';
        } else aside = '<aside class="inspector w360" aria-label="Selected appeal">' + UI.empty('No appeal selected', 'Appeals appear here when an owner or a sanctioned user files one.') + '</aside>';
      }

      // ---------------- Actions ----------------
      if (st.tab === 'actions') {
        const rows = st.actions.filter((x) => (st.actType === 'all' || x.objectType === st.actType) && (st.actState === 'all' || x.state === st.actState) && (st.actSource === 'all' || x.source === st.actSource));
        body = UI.panel('Actions', '<div class="toolbar"><span class="relative">' + UI.btn(st.actType === 'all' ? 'Object type' : 'Type: ' + st.actType, { size: 'sm', icon: 'filter', attrs: 'data-acttype', cls: st.actType === 'all' ? '' : 'active' }) + '</span>' + UI.seg([{ id: 'all', label: 'All' }, { id: 'applied', label: 'Applied' }, { id: 'reversed', label: 'Reversed' }], st.actState, 'data-actstate aria-label="State"') + UI.seg([{ id: 'all', label: 'Any source' }, { id: 'reviewer', label: 'Reviewer' }, { id: 'guardrail', label: 'Guardrail' }, { id: 'provider', label: 'Provider' }], st.actSource, 'data-actsource aria-label="Source"') + small(rows.length + ' of ' + st.actions.length) + '</div>'
          + UI.table(['Action', 'Object', 'Workspace', 'Owner', 'Flag', 'Source', 'Reason', 'State', 'When', 'Appeal'], rows.map((x) => { const ap = x.appealId ? appealById[x.appealId] : st.appeals.find((y) => y.actionId === x.id); return { cells: ['<span class="mono">…' + esc(x.id.slice(-6)) + '</span>', '<span class="mono">' + esc(x.objectType) + '</span> ' + small(esc(x.objectId)), esc(wsName(x.workspaceId)), esc(nameOf(x.ownerId)), flagLink(x.flagId), UI.pill(x.source, 'outline') + ' ' + small(esc(x.createdBy ? nameOf(x.createdBy) : x.source)), esc(x.reason), x.state === 'reversed' ? UI.pill('reversed', 'ok') + ' ' + small(esc(nameOf(x.reversedBy)) + (ap ? ' (appeal ' + esc(ap.ref) + ')' : '')) : UI.pill('applied', 'warn'), esc(when(x.createdAt)), ap ? '<a href="#" data-goappeal="' + esc(ap.ref) + '">' + esc(ap.ref) + '</a>' : small('none')], attrs: 'data-action="' + esc(x.id) + '"', selected: st.actionSel === x.id }; }), { minWidth: '1100px', emptyTitle: st.actions.length ? 'No actions match' : 'No actions yet', emptyText: st.actions.length ? 'Widen the filters.' : 'Hiding an object behind a flag records an action here.' })
          + small('An action hides the object behind an open or confirmed flag; the owner is notified and may appeal once per action. Reversal comes only from an upheld appeal.'));
      }

      // ---------------- Sanctions ----------------
      if (st.tab === 'sanctions' && st.sanctions) {
        const rows = st.sanctions.filter((s) => st.sancState === 'all' || s.state === st.sancState);
        const kindPill = (k) => UI.pill(k, k === 'ban' ? 'danger' : k === 'suspend' ? 'warn' : '');
        body = UI.notice('<b>Step-up.</b> Issuing or lifting a sanction needs a browser session with a recent sign-in. A suspension or ban revokes the user\'s sessions at once and refuses every credential with 403 step sanction; a warning only notifies.', 'info')
          + UI.panel('Sanctions', '<div class="toolbar">' + UI.seg([{ id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'expired', label: 'Expired' }, { id: 'lifted', label: 'Lifted' }, { id: 'reversed', label: 'Reversed' }], st.sancState, 'data-sancstate aria-label="State"') + '</div>'
            + UI.table(['Sanction', 'User', 'Kind', 'Reason', 'Flag', 'Starts', 'Ends', 'By', 'State', ''], rows.map((s) => { const ap = st.appeals.find((y) => y.sanctionId === s.id); return { cells: ['<span class="mono">…' + esc(s.id.slice(-6)) + '</span>', esc(nameOf(s.userId)), kindPill(s.kind), esc(s.reason), flagLink(s.flagId), esc(when(s.startsAt)), s.endsAt ? esc(when(s.endsAt)) : small(s.kind === 'ban' ? 'until lifted' : 'none'), esc(nameOf(s.createdBy)), UI.pill(s.state, s.state === 'active' ? 'warn' : s.state === 'reversed' || s.state === 'lifted' ? 'ok' : '') + (s.endReason ? '<br>' + small(esc(s.endReason)) : ''), s.state === 'active' ? UI.btn('Lift', { size: 'xs', attrs: 'data-lift="' + esc(s.id) + '"' }) : ap ? '<a href="#" data-goappeal="' + esc(ap.ref) + '">' + esc(ap.ref) + '</a>' : ''] }; }), { clickable: false, minWidth: '1000px', emptyTitle: 'No sanctions', emptyText: 'Nothing in this state.' }), { actions: UI.btn('Issue sanction', { kind: 'primary', size: 'sm', attrs: 'data-newsanction' }) });
      }

      // ---------------- Providers ----------------
      if (st.tab === 'providers' && st.providers) {
        const off = !st.providersEnabled;
        body = (off ? UI.problem('External providers are off', 'MODERATION_EXTERNAL_PROVIDERS is not set on this deployment, so every provider route answers 403 with step disabled. Providers can be listed but not created, changed or enabled, and no verdict job is queued. Set the variable and restart to turn them on.', false) : UI.notice('<b>Zones.</b> A provider only runs in a zone whose egress reaches outside the site (an allow-list with a public range, or the external zone), never with ZONES_AIR_GAPPED. Created disabled and in shadow; enforce files the object\'s flag and hides a registered object on a flagged verdict.', 'info', App.can('zones:manage') ? UI.btn('Zones', { kind: 'ghost', size: 'sm', attrs: 'data-gozones' }) : ''))
          + UI.panel('External providers', UI.table(['Provider', 'Kind', 'URL', 'Secret', 'Zone', 'Mode', 'Object types', { label: 'Threshold', right: true }, 'State', ''], st.providers.map((p) => { let host = p.url, path = ''; try { const u = new URL(p.url); host = u.host; path = u.pathname; } catch (e) { /* shown as given */ } return { cells: ['<b>' + esc(p.name) + '</b>', '<span class="mono">' + esc(p.kind) + '</span>', '<span class="mono">' + esc(host) + '</span>' + small(esc(path)), p.hasSecret ? UI.pill('stored, sealed', 'ok') : UI.pill('none', ''), '<span class="mono">' + esc(p.zone) + '</span>', UI.pill(p.mode, p.mode === 'enforce' ? 'danger' : 'warn'), (p.objectTypes || []).length ? p.objectTypes.map((t) => UI.pill(t, 'outline')).join(' ') : small('any'), '<span class="num">' + (p.threshold == null ? '' : Number(p.threshold).toFixed(2)) + '</span>', p.enabled ? UI.pill('enabled', 'ok') : UI.pill('disabled', ''), '<span class="hstack gap6" style="justify-content:flex-end">' + UI.btn('Verdicts', { size: 'xs', attrs: 'data-verdicts="' + esc(p.id) + '"' }) + UI.btn('Edit', { size: 'xs', attrs: 'data-editprov="' + esc(p.id) + '"', disabled: off }) + UI.btn(p.enabled ? 'Disable' : 'Enable', { size: 'xs', attrs: 'data-toggleprov="' + esc(p.id) + '"', disabled: off }) + UI.btn(p.mode === 'shadow' ? 'Enforce' : 'Shadow', { size: 'xs', kind: 'ghost', attrs: 'data-modeprov="' + esc(p.id) + '"', disabled: off }) + '</span>'] }; }), { clickable: false, minWidth: '1180px', emptyTitle: 'No providers', emptyText: off ? 'Providers are off on this deployment.' : 'Add one to score posts and messages outside the site.' }), { actions: UI.btn('Add provider', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newprov', disabled: off }) })
          + small('Wire formats: json (POST {input, type} answers {flagged, score?, categories?}) and openai (the OpenAI moderation shape). The key goes as Authorization: Bearer and is stored sealed, never shown. A failed call retries, then lands in the dead-letter queue.');
      }

      // ---------------- Dead letters ----------------
      if (st.tab === 'dead' && st.dead) {
        body = UI.panel('Dead-letter queue', UI.table(['Entry', 'Job', 'Type', 'Error', { label: 'Attempts', right: true }, 'Failed', 'State', ''], st.dead.map((d) => ({ cells: ['<span class="mono">…' + esc(d.id.slice(-6)) + '</span>', '<span class="mono">…' + esc(String(d.jobId).slice(-6)) + '</span>', '<span class="mono">' + esc(d.type) + '</span>', '<span class="mono" style="font-size:12px">' + esc(d.error || '') + '</span>', '<span class="num">' + d.attempts + '</span>', esc(when(d.failedAt)), d.state === 'open' ? UI.pill('open', 'danger') : UI.pill('redriven', 'ok') + '<br>' + small('by ' + esc(nameOf(d.redrivenBy)) + ', ' + esc(when(d.redrivenAt)) + ', <span class="mono">…' + esc(String(d.redriveJobId || '').slice(-6)) + '</span>'), UI.btn('Redrive', { size: 'xs', kind: d.state === 'open' ? 'primary' : '', attrs: 'data-redrive="' + esc(d.id) + '"', title: d.state === 'open' ? '' : 'Already redriven: 409' })] })), { clickable: false, minWidth: '1000px', emptyTitle: 'Nothing dead-lettered', emptyText: 'Every moderation job finished within its attempts.' }))
          + (st.redriveNote ? UI.notice('<b>Entry …' + esc(String(st.redriveNote).slice(-6)) + ' redriven.</b> The job was queued again with its payload; the texts in it stay sealed. Audit moderation.job.redriven written. A second redrive answers 409.', 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearredrive' })) : '')
          + (st.redriveConflict ? UI.problem('Already redriven', st.redriveConflict.detail, st.redriveConflict.trace || false) : '')
          + small('Moderation jobs (moderation.provider) that failed their last attempt land here, audited as moderation.job.dead_lettered.' + (App.can('audit:read') ? ' <a href="#" data-goaudit>Open the audit chain</a>.' : ''));
      }

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .mod-title{font-size:16px;font-weight:600;margin:4px 0 2px;overflow-wrap:anywhere}#main .dt td > .mono:first-child{white-space:nowrap}'
        + '#main .mod-statement{font-size:14px;line-height:1.5;padding:8px 10px;background:var(--panel2);border-radius:6px;white-space:pre-wrap}'
        + '#main .mod-redacted{display:inline-block;padding:6px 10px;background:var(--sel);color:var(--muted);font-size:13px;border-radius:4px}'
        + '#main .inspector .kv .v{overflow-wrap:anywhere}'
        + '</style>'
        + '<div class="page">' + head + (st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('OK', { kind: 'ghost', size: 'sm', attrs: 'data-demook' })) : '') + tabs + '<div class="vstack gap12">' + body + '</div>'
        + '</div>' + aside;

      // ---- events ----
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-demook]', () => { st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '[data-goflags]', () => ctx.navigate('flags'));
      ctx.on('click', '[data-openflag]', (e, t) => { e.preventDefault(); ctx.navigate('flags', { id: t.dataset.openflag }); });
      ctx.on('click', '[data-gorule]', (e, t) => ctx.navigate('guardrails', { rule: t.dataset.gorule }));
      ctx.on('click', '[data-gozones]', () => ctx.navigate('zones'));
      ctx.on('click', '[data-goaudit]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
      ctx.on('click', '[data-goappeal]', (e, t) => { e.preventDefault(); st.tab = 'appeals'; st.appealSel = t.dataset.goappeal; ctx.rerender(); });
      ctx.on('click', '[data-goaction]', (e, t) => { st.tab = 'actions'; st.actionSel = t.dataset.goaction; st.actType = 'all'; st.actState = 'all'; st.actSource = 'all'; ctx.rerender(); });
      ctx.on('click', '[data-gosanction]', () => { st.tab = 'sanctions'; st.sancState = 'all'; ctx.rerender(); });
      // queues
      ctx.on('click', 'tr[data-queue]', (e, t) => { st.queueSel = t.dataset.queue; st.flagSel = null; st.flagType = 'all'; ctx.rerender(); });
      ctx.on('click', 'tr[data-flag]', (e, t) => { st.flagSel = t.dataset.flag; ctx.rerender(); });
      ctx.on('click', '[data-kindmenu]', (e, t) => menu(ctx, t, [['all', 'All kinds'], ['rule', 'Guard (rule)'], ['report', 'Report'], ['reviewer', 'Reviewer'], ['hold', 'Hold']], st.flagKind, (v) => { st.flagKind = v; ctx.rerender(); }));
      ctx.on('click', '[data-typemenu]', (e, t) => { const types = []; st.allFlags.forEach((f) => { if (f.queueId === st.queueSel && f.object && types.indexOf(f.object.type) < 0) types.push(f.object.type); }); menu(ctx, t, [['all', 'All object types']].concat(types.map((x) => [x, x])), st.flagType, (v) => { st.flagType = v; ctx.rerender(); }); });
      ctx.on('click', '[data-sortmenu]', (e, t) => menu(ctx, t, [['time', 'Least time left'], ['severity', 'By severity'], ['newest', 'Newest first']], st.flagSort, (v) => { st.flagSort = v; ctx.rerender(); }));
      ctx.on('click', '[data-clearesc]', () => { st.escalatedNote = null; ctx.rerender(); });
      ctx.on('click', '[data-newqueue]', () => queueModal(ctx, null));
      ctx.on('click', '[data-editqueue]', () => queueModal(ctx, st.queues.find((x) => x.id === st.queueSel)));
      ctx.on('click', '[data-togglequeue]', async () => {
        const q = st.queues.find((x) => x.id === st.queueSel); if (!q) return;
        try { await App.patch('/api/moderation/queues/' + enc(q.id), { enabled: !q.enabled }); ctx.toast(esc(q.name) + (q.enabled ? ' disabled. New flags skip it; its open flags stay.' : ' enabled. New matching flags route here.'), q.enabled ? 'warn' : 'ok'); st.quiet = true; ctx.rerender(); }
        catch (err) { App.fail(err, 'Queue not changed'); }
      });
      ctx.on('click', '[data-delqueue]', async () => {
        const q = st.queues.find((x) => x.id === st.queueSel); if (!q) return;
        const n = st.allFlags.filter((f) => f.queueId === q.id).length;
        const ok = await ctx.confirm({ title: 'Delete queue', tag: 'flags become unrouted', tone: 'danger', body: '<p style="margin:0" class="fg2">The queue is removed and its ' + n + ' open flag' + (n === 1 ? '' : 's') + ' become unrouted: they keep their timers but no SLA escalation applies until another queue matches them. Audited as moderation.queue.deleted.</p>', kv: [['Queue', esc(q.name)], ['Workspace', esc(wsName(q.workspaceId))], ['Open flags', String(n)]], ok: 'Delete' });
        if (!ok) return;
        try { await App.del('/api/moderation/queues/' + enc(q.id)); st.queueSel = null; ctx.toast(esc(q.name) + ' deleted. ' + n + ' flag' + (n === 1 ? ' is' : 's are') + ' unrouted.', 'warn'); st.quiet = true; ctx.rerender(); }
        catch (err) { App.fail(err, 'Queue not deleted'); }
      });
      ctx.on('click', '[data-heldaccept], [data-heldreject]', async (e, t) => {
        const f = st.allFlags.find((x) => x.ref === st.flagSel); if (!isHeld(f)) return; const id = f.object.id; const h = st.held && st.held[id]; if (!h) return;
        const accept = t.hasAttribute('data-heldaccept');
        const v = await ask(ctx, { title: accept ? 'Accept the submission' : 'Reject the submission', tag: accept ? 'writes a record' : 'nothing is recorded', tone: accept ? 'info' : 'danger', body: '<p style="margin:0" class="fg2">' + (accept ? 'Writes a record in ' + esc(h.app.title || h.app.name || 'the app') + ' with these values, as the public form would have, through the entity\'s own checks. The flag is approved.' : 'Drops the submitted values; no record is written. The flag is rejected.') + ' Audited as app.form.held.' + (accept ? 'accepted' : 'rejected') + '.</p>' + UI.field('Reason (optional)', UI.textarea('', { rows: 2, attrs: 'data-v="reason"' })), kv: [['Flag', esc(f.ref)], ['Form', esc(h.form.title || h.form.name || '')]], ok: accept ? 'Accept' : 'Reject' });
        if (!v) return;
        try {
          const r = await App.post('/api/apps/held/' + enc(id) + '/decide', { decision: accept ? 'accept' : 'reject', reason: (v.reason || '').trim() || null });
          st.heldRefused = null; delete st.held[id]; st.flagSel = null;
          ctx.toast(accept ? 'Accepted: record …' + esc(String(r.recordId || '').slice(-6)) + ' written. ' + esc(f.ref) + ' approved.' : 'Rejected: nothing was recorded. ' + esc(f.ref) + ' rejected.', 'ok', 5000);
          st.quiet = true; ctx.rerender();
        } catch (err) {
          if (accept && err && (err.status === 400 || err.status === 409)) { st.heldRefused = { id, message: err.message || 'The record was refused.' }; ctx.rerender(); }
          App.fail(err, accept ? 'Not accepted' : 'Not rejected');
        }
      });
      ctx.on('click', '[data-hide]', async () => {
        const f = st.allFlags.find((x) => x.ref === st.flagSel); if (!f || !f.object) return;
        const v = await ask(ctx, { title: 'Hide object', tag: 'notifies the owner', tone: 'danger', body: '<p style="margin:0" class="fg2">Hides <span class="mono">' + esc(f.object.type) + ' ' + esc(f.object.id) + '</span> behind this flag (an open flag is confirmed first). The owner is notified and may appeal once. Audited as moderation.action.applied.</p>' + UI.field('Reason', UI.textarea((f.rule || 'Flagged') + ' at the ' + String(f.checkpoint || '').replace(/-/g, ' ') + ' checkpoint', { rows: 2, attrs: 'data-v="reason"' })), kv: [['Flag', esc(f.ref)], ['Object', esc(f.object.type + ' ' + f.object.id)], ['Raised by', esc(f.actor ? f.actor.name || '' : '')]], ok: 'Hide' });
        if (!v) return;
        try {
          const r = await App.post('/api/moderation/flags/' + enc(f.ref) + '/action', { action: 'hide', reason: (v.reason || '').trim() || 'Hidden on review' });
          st.flagSel = null; ctx.toast(esc(f.ref) + ' confirmed and the object hidden (action …' + esc(r.action.id.slice(-6)) + '). The owner has been notified.', 'ok'); st.quiet = true; ctx.rerender();
        } catch (err) { App.fail(err, 'Not hidden'); }
      });
      // reports
      ctx.on('click', '[data-newreport]', () => reportModal(ctx));
      // appeals
      ctx.on('click', 'tr[data-appeal]', (e, t) => { st.appealSel = t.dataset.appeal; ctx.rerender(); });
      ctx.on('click', '[data-clearresult]', () => { st.appealResult = null; ctx.rerender(); });
      ctx.on('click', '[data-review]', async () => {
        const a = st.appeals.find((x) => x.ref === st.appealSel); if (!a) return;
        try { await App.post('/api/moderation/appeals/' + enc(a.ref) + '/review'); st.independence = null; ctx.toast(esc(a.ref) + ' claimed. Audited as moderation.appeal.reviewing.', 'ok'); st.quiet = true; ctx.rerender(); }
        catch (err) {
          const p = err.problem || {};
          if (p.step === 'independence') { st.independence = { ref: a.ref, detail: p.detail || err.message, trace: p.trace_id || null }; ctx.rerender(); return; }
          App.fail(err, 'Not claimed');
        }
      });
      ctx.on('click', '[data-decide]', async (e, t) => {
        const a = st.appeals.find((x) => x.ref === st.appealSel); if (!a) return;
        const dcs = t.dataset.decide;
        const v = await ask(ctx, { title: (dcs === 'upheld' ? 'Uphold ' : 'Deny ') + a.ref, tag: dcs === 'upheld' ? (a.kind === 'action' ? 'restores the object' : 'ends the sanction') : 'keeps the decision', tone: dcs === 'upheld' ? 'info' : 'danger', body: '<p style="margin:0" class="fg2">' + (dcs === 'upheld' ? (a.kind === 'action' ? 'The object is restored to its previous state, its flag reopened with a fresh timer and the AT-Protocol labels made from the flag negated.' : 'The sanction ends as reversed and the user can sign in again.') : 'The decision under appeal stands. The appellant is told, without the reviewer\'s name.') + '</p>' + UI.field('Note to the appellant', UI.textarea('', { rows: 2, attrs: 'data-v="note"' })), kv: [['Appeal', esc(a.ref)], ['Kind', esc(a.kind)], ['Appellant', esc(nameOf(a.userId))]], ok: dcs === 'upheld' ? 'Uphold' : 'Deny' });
        if (!v) return;
        try {
          const r = await App.post('/api/moderation/appeals/' + enc(a.ref) + '/decide', { decision: dcs, note: (v.note || '').trim() || null });
          if (dcs === 'upheld') st.appealResult = { ref: a.ref, effects: a.kind === 'action' ? r.effects : null };
          ctx.toast(esc(a.ref) + ' ' + dcs + '. Audited as moderation.appeal.' + dcs + '; the appellant is notified.', dcs === 'upheld' ? 'ok' : '');
          st.quiet = true; ctx.rerender();
        } catch (err) {
          const p = err.problem || {};
          if (p.step === 'independence') { st.independence = { ref: a.ref, detail: p.detail || err.message, trace: p.trace_id || null }; ctx.rerender(); return; }
          App.fail(err, 'Not decided');
        }
      });
      ctx.on('click', '[data-recordappeal]', () => recordAppealModal(ctx, nameOf));
      // actions
      ctx.on('click', '[data-acttype]', (e, t) => { const types = []; st.actions.forEach((a) => { if (types.indexOf(a.objectType) < 0) types.push(a.objectType); }); menu(ctx, t, [['all', 'All object types']].concat(types.map((x) => [x, x])), st.actType, (v) => { st.actType = v; ctx.rerender(); }); });
      ctx.on('click', '[data-actstate] [data-seg]', (e, t) => { st.actState = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-actsource] [data-seg]', (e, t) => { st.actSource = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', 'tr[data-action]', (e, t) => { st.actionSel = t.dataset.action; ctx.rerender(); });
      // sanctions
      ctx.on('click', '[data-sancstate] [data-seg]', (e, t) => { st.sancState = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-lift]', async (e, t) => {
        const s = (st.sanctions || []).find((x) => x.id === t.dataset.lift); if (!s) return;
        const v = await ask(ctx, { title: 'Lift sanction', tag: 'step-up', tone: 'info', body: '<p style="margin:0" class="fg2">Ends the ' + esc(s.kind) + ' now. ' + (s.kind === 'warn' ? 'The user is told the warning no longer stands.' : 'The user can sign in again at once.') + ' Audited as moderation.sanction.lifted.</p>' + UI.field('Reason', UI.input('', { placeholder: 'Why it ends early', attrs: 'data-v="reason"' })), kv: [['User', esc(nameOf(s.userId))], ['Kind', esc(s.kind)], ['Issued by', esc(nameOf(s.createdBy))]], ok: 'Lift' });
        if (!v) return;
        try { await withStepUp(ctx, () => App.post('/api/moderation/sanctions/' + enc(s.id) + '/lift', { reason: (v.reason || '').trim() || null })); ctx.toast('Sanction lifted. ' + esc(nameOf(s.userId)) + ' has been notified.', 'ok'); st.quiet = true; ctx.rerender(); }
        catch (err) { if (!err.cancelled) App.fail(err, 'Not lifted'); }
      });
      ctx.on('click', '[data-newsanction]', () => sanctionModal(ctx, nameOf));
      if (st.openSanction) { st.openSanction = false; if (st.sanctions) setTimeout(() => sanctionModal(ctx, nameOf), 50); }
      // providers
      ctx.on('click', '[data-newprov]', () => providerModal(ctx, null));
      ctx.on('click', '[data-editprov]', (e, t) => providerModal(ctx, st.providers.find((p) => p.id === t.dataset.editprov)));
      ctx.on('click', '[data-toggleprov]', async (e, t) => {
        const p = st.providers.find((x) => x.id === t.dataset.toggleprov); if (!p) return;
        if (!p.enabled) { const ok = await ctx.confirm({ title: 'Enable ' + p.name, tag: p.mode, tone: p.mode === 'enforce' ? 'danger' : 'info', body: '<p style="margin:0" class="fg2">Each check of ' + esc((p.objectTypes || []).join(', ') || 'any type') + ' queues a moderation.provider job with the text sealed in the payload. ' + (p.mode === 'enforce' ? 'In enforce mode a flagged verdict files the object\'s flag and hides a registered object.' : 'In shadow mode the verdict is recorded and nothing else happens.') + ' The zone is checked again now.</p>', kv: [['Zone', esc(p.zone)], ['Threshold', p.threshold == null ? '' : Number(p.threshold).toFixed(2)]], ok: 'Enable' }); if (!ok) return; }
        try { await App.patch('/api/moderation/providers/' + enc(p.id), { enabled: !p.enabled }); ctx.toast(esc(p.name) + (p.enabled ? ' disabled. Queued jobs still finish.' : ' enabled.'), p.enabled ? '' : 'ok'); st.quiet = true; ctx.rerender(); }
        catch (err) { App.fail(err, 'Provider not changed'); }
      });
      ctx.on('click', '[data-modeprov]', async (e, t) => {
        const p = st.providers.find((x) => x.id === t.dataset.modeprov); if (!p) return;
        const to = p.mode === 'shadow' ? 'enforce' : 'shadow';
        const ok = await ctx.confirm({ title: 'Switch ' + p.name + ' to ' + to, tag: to, tone: to === 'enforce' ? 'danger' : 'info', body: '<p style="margin:0" class="fg2">' + (to === 'enforce' ? 'From now on a flagged verdict files or reuses the object\'s flag, hides a registered object and is audited as moderation.provider.enforced. Check the shadow verdicts first.' : 'Verdicts are recorded only; nothing is flagged or hidden.') + '</p>', ok: 'Switch' });
        if (!ok) return;
        try { await App.patch('/api/moderation/providers/' + enc(p.id), { mode: to }); ctx.toast(esc(p.name) + ' now in ' + to + ' mode.', to === 'enforce' ? 'warn' : 'ok'); st.quiet = true; ctx.rerender(); }
        catch (err) { App.fail(err, 'Mode not changed'); }
      });
      ctx.on('click', '[data-verdicts]', async (e, t) => {
        const p = st.providers.find((x) => x.id === t.dataset.verdicts); if (!p) return;
        let v = [];
        try { v = (await App.get('/api/moderation/providers/' + enc(p.id) + '/verdicts')).items; } catch (err) { App.fail(err, 'Verdicts not loaded'); return; }
        const flagged = v.filter((x) => x.flagged).length;
        const lat = v.map((x) => x.latencyMs).filter((x) => x != null).sort((a, b) => a - b);
        const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null;
        const cats = (c) => (Array.isArray(c) ? c.join(', ') : c || '');
        ctx.drawer({ title: 'Verdicts: ' + esc(p.name), body: UI.kv([['Mode now', UI.pill(p.mode, p.mode === 'enforce' ? 'danger' : 'warn')], ['Threshold', p.threshold == null ? '' : Number(p.threshold).toFixed(2)], ['Verdicts', v.length + ', ' + flagged + ' flagged'], ['Latency p95', p95 == null ? 'none yet' : p95 + ' ms']], 2)
          + UI.table(['Object', 'Mode', 'Flagged', 'Categories', { label: 'Score', right: true }, 'Acted', { label: 'ms', right: true }, 'When'], v.map((x) => ['<span class="mono">' + esc(x.objectType) + '</span> ' + small(esc(x.objectId)), UI.pill(x.mode, x.mode === 'enforce' ? 'danger' : 'warn'), x.flagged ? UI.pill('flagged', 'danger') : UI.pill('clear', 'ok'), esc(cats(x.categories)) || small('none'), '<span class="num">' + (x.score == null ? '' : Number(x.score).toFixed(2)) + '</span>', x.acted ? (x.flagId ? flagLink(x.flagId) : 'yes') : small(x.flagged ? 'shadow, not acted' : 'no'), '<span class="num">' + (x.latencyMs == null ? '' : x.latencyMs) + '</span>', esc(when(x.createdAt))]), { clickable: false, minWidth: '0', emptyTitle: 'No verdicts yet', emptyText: 'Verdicts appear once the provider is enabled and checks run.' }), actions: UI.btn('Close', { attrs: 'data-close' }) });
      });
      // dead letters
      ctx.on('click', '[data-redrive]', async (e, t) => {
        const d = st.dead.find((x) => x.id === t.dataset.redrive); if (!d) return;
        if (d.state === 'open') { const ok = await ctx.confirm({ title: 'Redrive the job', tag: 'queues the job again', tone: 'info', body: '<p style="margin:0" class="fg2">The job runs again with its stored payload; the texts in it stay sealed. If the provider is still down it will land here again after its attempts.</p>', kv: [['Job', '<span class="mono">' + esc(d.jobId) + '</span>'], ['Type', esc(d.type)], ['Last error', esc(d.error || '')]], ok: 'Redrive' }); if (!ok) return; }
        try { const r = await App.post('/api/moderation/dead-letters/' + enc(d.id) + '/redrive'); st.redriveNote = d.id; st.redriveConflict = null; ctx.toast('Redriven as job …' + esc(String(r.jobId).slice(-6)) + '.', 'ok'); st.quiet = true; ctx.rerender(); }
        catch (err) { if (err.status === 409) { st.redriveConflict = { detail: ((err.problem && err.problem.detail) || err.message) + ' A second redrive is refused; follow the new job instead.', trace: err.problem && err.problem.trace_id }; st.redriveNote = null; ctx.rerender(); } else App.fail(err, 'Not redriven'); }
      });
      ctx.on('click', '[data-clearredrive]', () => { st.redriveNote = null; ctx.rerender(); });
    }
  });

  function decidedById(st, a) {
    if (a.actionId) { const ac = (st.actions || []).find((x) => x.id === a.actionId); return ac ? ac.createdBy : null; }
    const s = (st.sanctions || []).find((x) => x.id === a.sanctionId); return s ? s.createdBy : null;
  }

  function wsOptions() {
    return [{ value: '', label: 'Any workspace' }].concat(((App.me && App.me.workspaces) || []).map((w) => ({ value: w.id, label: w.name })));
  }

  function queueModal(ctx, q) {
    const st = ctx.state; const isNew = !q;
    const v = q || { name: '', workspaceId: (App.me && App.me.workspace) || '', rules: [], labels: [], kinds: [], priority: 50, slaMinutes: 60, escalateTo: 'tenant', escalationSlaMinutes: 120, enabled: true };
    ctx.modal({ title: isNew ? 'New review queue' : 'Edit ' + esc(v.name), cls: 'wide',
      body: '<div class="formgrid">' + UI.field('Name', UI.input(v.name, { attrs: 'data-qname', placeholder: 'Finance Ops review' })) + UI.field('Workspace', UI.select(wsOptions(), v.workspaceId || '', 'data-qws')) + UI.field('Priority', UI.input(String(v.priority), { type: 'number', attrs: 'data-qprio min="0"' }), 'Lower numbers are tried first') + UI.field('SLA (minutes)', UI.input(String(v.slaMinutes), { type: 'number', attrs: 'data-qsla min="1"' })) + UI.field('Escalates to', UI.select(['workspace', 'tenant', 'platform'], v.escalateTo, 'data-qesc')) + UI.field('Escalation SLA (minutes)', UI.input(String(v.escalationSlaMinutes), { type: 'number', attrs: 'data-qescsla min="1"' })) + '</div>'
        + UI.field('Rules (ids or names, comma separated; empty matches any)', UI.input((v.rules || []).join(', '), { attrs: 'data-qrules', placeholder: 'numeric-grounding, export-iban' }))
        + UI.field('Labels', '<div class="hstack wrap gap6">' + LABELS.map((l) => UI.chip(UI.label(l, { sm: true }), (v.labels || []).indexOf(l) >= 0, 'data-qlabel="' + l + '"')).join('') + '</div>', 'Empty matches any label')
        + UI.field('Kinds (flag kind, object type or checkpoint)', UI.input((v.kinds || []).join(', '), { attrs: 'data-qkinds', placeholder: 'report, rule, hold, message' }))
        + UI.toggle('Enabled', v.enabled, 'data-qenabled'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(isNew ? 'Create queue' : 'Save', { kind: 'primary', attrs: 'data-qsave' }),
      onMount(m) {
        m.querySelectorAll('[data-qlabel]').forEach((c) => c.addEventListener('click', () => { c.classList.toggle('on'); c.setAttribute('aria-pressed', c.classList.contains('on') ? 'true' : 'false'); }));
        m.querySelector('[data-qsave]').addEventListener('click', async () => {
          const name = m.querySelector('[data-qname]').value.trim(); if (!name) { ctx.toast('A queue needs a name.', 'warn'); return; }
          const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
          const body = { name, workspaceId: m.querySelector('[data-qws]').value || null, priority: Math.max(0, +m.querySelector('[data-qprio]').value || 0), slaMinutes: Math.max(1, +m.querySelector('[data-qsla]').value || 60), escalateTo: m.querySelector('[data-qesc]').value, escalationSlaMinutes: Math.max(1, +m.querySelector('[data-qescsla]').value || 120), rules: split(m.querySelector('[data-qrules]').value), labels: Array.prototype.map.call(m.querySelectorAll('[data-qlabel].on'), (c) => c.dataset.qlabel), kinds: split(m.querySelector('[data-qkinds]').value), enabled: m.querySelector('[data-qenabled]').classList.contains('on') };
          try {
            const saved = isNew ? await App.post('/api/moderation/queues', body) : await App.patch('/api/moderation/queues/' + encodeURIComponent(q.id), body);
            App.closeOverlay(); st.queueSel = saved.id; st.quiet = true; ctx.rerender();
            ctx.toast((isNew ? 'Queue ' + esc(saved.name) + ' created. ' : 'Queue saved. ') + 'Audited as moderation.queue.' + (isNew ? 'created' : 'updated') + '.', 'ok');
          } catch (err) { App.fail(err, isNew ? 'Queue not created' : 'Queue not saved'); }
        });
      } });
  }

  function reportModal(ctx) {
    const st = ctx.state;
    const types = (st.types || []).map((t) => ({ value: t.type, label: t.type }));
    if (!types.length) { ctx.toast('No object type is registered for reports.', 'warn'); return; }
    ctx.modal({ title: 'File a report', body: '<div class="formgrid">' + UI.field('Object type', UI.select(types, types[0].value, 'data-rtype')) + UI.field('Object id', UI.input('', { placeholder: 'The id of the object', attrs: 'data-rid' })) + UI.field('Reason', UI.select(['Harassment', 'Spam', 'Wrong or unsupported figure', 'Sensitive data', 'Other'], 'Harassment', 'data-rreason')) + UI.field('Severity', UI.select(['high', 'medium', 'low'], 'medium', 'data-rsev')) + '</div>' + UI.field('Note', UI.textarea('', { rows: 2, placeholder: 'What should the reviewer look at?', attrs: 'data-rnote' })) + UI.notice('Only an object you can see, within your clearance; anything else is the same 404. The report files a flag in the object\'s workspace queue.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Report', { kind: 'primary', attrs: 'data-doreport' }),
      onMount(m) {
        m.querySelector('[data-doreport]').addEventListener('click', async () => {
          const id = m.querySelector('[data-rid]').value.trim(); if (!id) { ctx.toast('Give the id of the object to report.', 'warn'); return; }
          const note = m.querySelector('[data-rnote]').value.trim();
          try {
            const r = await App.post('/api/moderation/reports', Object.assign({ type: m.querySelector('[data-rtype]').value, id, reason: m.querySelector('[data-rreason]').value, severity: m.querySelector('[data-rsev]').value }, note ? { note } : {}));
            App.closeOverlay();
            if (r.duplicate) ctx.toast('You already reported it: flag ' + esc(r.flag.ref) + ' is still open.', 'warn');
            else ctx.toast('Reported as ' + esc(r.flag.ref) + '. Audit moderation.reported written.', 'ok');
            st.quiet = true; ctx.rerender();
          } catch (err) { App.fail(err, err.status === 404 ? 'No such object you can see' : 'Not reported'); }
        });
      } });
  }

  function recordAppealModal(ctx, nameOf) {
    const st = ctx.state;
    const open = (pred) => st.appeals.some((a) => pred(a) && (a.state === 'pending' || a.state === 'reviewing'));
    const opts = st.actions.filter((a) => a.state === 'applied' && a.ownerId && !open((x) => x.actionId === a.id)).map((a) => ({ value: 'a:' + a.id, label: 'Action: ' + a.objectType + ' ' + a.objectId + ' hidden, owner ' + nameOf(a.ownerId), user: a.ownerId }))
      .concat((st.sanctions || []).filter((s) => s.state === 'active' && !open((x) => x.sanctionId === s.id)).map((s) => ({ value: 's:' + s.id, label: 'Sanction: ' + s.kind + ' of ' + nameOf(s.userId), user: s.userId })));
    if (!opts.length) { ctx.modal({ title: 'Record an appeal for someone', body: UI.empty('Nothing to appeal', 'There is no applied action or active sanction without an open appeal.'), actions: UI.btn('Close', { attrs: 'data-close' }) }); return; }
    ctx.modal({ title: 'Record an appeal for someone', body: UI.field('Against', UI.select(opts.map((o) => ({ value: o.value, label: o.label })), opts[0].value, 'data-against')) + UI.field('Statement (as given by the user)', UI.textarea('', { rows: 3, attrs: 'data-stmt' })) + UI.notice('For someone who cannot sign in (a suspended or banned user). One open appeal per action or sanction; a second is 409. The statement is sealed with the tenant key.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Record', { kind: 'primary', attrs: 'data-dorecord' }),
      onMount(m) {
        m.querySelector('[data-dorecord]').addEventListener('click', async () => {
          const pick = opts.find((o) => o.value === m.querySelector('[data-against]').value);
          const statement = m.querySelector('[data-stmt]').value.trim(); if (!statement) { ctx.toast('Write the user\'s statement first.', 'warn'); return; }
          const body = { statement, forUserId: pick.user };
          if (pick.value.indexOf('a:') === 0) body.actionId = pick.value.slice(2); else body.sanctionId = pick.value.slice(2);
          try { const r = await App.post('/api/moderation/appeals', body); App.closeOverlay(); st.appealSel = r.ref; st.quiet = true; ctx.rerender(); ctx.toast(esc(r.ref) + ' recorded for ' + esc(nameOf(pick.user)) + '. Audited as moderation.appeal.submitted.', 'ok'); }
          catch (err) { App.fail(err, 'Appeal not recorded'); }
        });
      } });
  }

  function sanctionModal(ctx, nameOf) {
    const st = ctx.state;
    const me = meId();
    const users = (st.users || []).filter((u) => u.id !== me && u.state !== 'disabled');
    const userField = users.length ? UI.field('User', UI.select(users.map((u) => ({ value: u.id, label: (u.displayName || u.username) + ' (' + u.username + ')' })), users[0].id, 'data-suser')) : UI.field('User id', UI.input('', { attrs: 'data-suser', placeholder: 'The user\'s id' }), 'Listing users needs users:manage');
    const flags = st.allFlags.filter((f) => !f.restricted).map((f) => ({ value: f.ref, label: f.ref + ', ' + (f.rule || '') }));
    ctx.modal({ title: 'Issue sanction', body: UI.notice('Needs a recent sign-in (step-up). Not yourself; an administrator (a role that requires MFA) only by a tenant admin, a system admin only by a system admin.', 'info')
      + '<div class="formgrid">' + userField + UI.field('Kind', UI.select(['warn', 'suspend', 'ban'], 'warn', 'data-skind')) + UI.field('Duration (minutes)', UI.input('', { type: 'number', attrs: 'data-sdur min="1"', placeholder: 'required for suspend' })) + UI.field('Flag', UI.select([{ value: '', label: 'none' }].concat(flags), '', 'data-sflag')) + '</div>' + UI.field('Reason', UI.textarea('', { rows: 2, attrs: 'data-sreason' })),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Issue', { kind: 'primary', attrs: 'data-sissue' }),
      onMount(m) {
        m.querySelector('[data-sissue]').addEventListener('click', async () => {
          const userId = m.querySelector('[data-suser]').value.trim(), kind = m.querySelector('[data-skind]').value, dur = +m.querySelector('[data-sdur]').value, reason = m.querySelector('[data-sreason]').value.trim(), flag = m.querySelector('[data-sflag]').value;
          if (!userId) { ctx.toast('Pick the user.', 'warn'); return; }
          if (kind === 'suspend' && !dur) { ctx.toast('A suspension needs a duration.', 'warn'); return; }
          if (!reason) { ctx.toast('A reason is required; the user reads it.', 'warn'); return; }
          const body = { userId, kind, reason };
          if (dur && kind !== 'warn') body.durationMinutes = dur;
          if (flag) body.flag = flag;
          App.closeOverlay();
          try {
            const r = await withStepUp(ctx, () => App.post('/api/moderation/sanctions', body));
            st.sancState = 'all'; st.quiet = true; ctx.rerender();
            ctx.toast('Sanction issued: ' + esc(kind) + ' for ' + esc(nameOf(userId)) + (kind === 'warn' ? '. Notified.' : '. ' + (r.sessionsRevoked || 0) + ' session' + (r.sessionsRevoked === 1 ? '' : 's') + ' revoked; sign-in refused until it ends.'), kind === 'warn' ? 'ok' : 'warn');
          } catch (err) { if (!err.cancelled) App.fail(err, 'Sanction not issued'); }
        });
      } });
  }

  function providerModal(ctx, p) {
    const st = ctx.state; const isNew = !p;
    const v = p || { name: '', kind: 'json', url: '', zone: 'external', mode: 'shadow', objectTypes: ['message'], threshold: 0.8 };
    const typeNames = (st.types || []).map((t) => t.type);
    (v.objectTypes || []).forEach((t) => { if (typeNames.indexOf(t) < 0) typeNames.push(t); });
    let mode = v.mode;
    ctx.modal({ title: isNew ? 'Add provider' : 'Edit ' + esc(v.name), cls: 'wide',
      body: '<div class="formgrid">' + UI.field('Name', UI.input(v.name, { attrs: 'data-pname' })) + UI.field('Kind', UI.select(['json', 'openai'], v.kind, 'data-pkind')) + UI.field('URL', UI.input(v.url, { attrs: 'data-purl', placeholder: 'https://moderation.example/v1/score' }), 'Passes the service URL checks; a metadata or link-local address is 422 step url') + UI.field('Secret (Authorization: Bearer)', UI.input('', { type: 'password', placeholder: isNew ? 'stored sealed, never shown' : 'leave blank to keep', attrs: 'data-psecret autocomplete="off"' })) + UI.field('Zone', UI.input(v.zone, { attrs: 'data-pzone', placeholder: 'external' }), 'Egress must reach outside the site') + UI.field('Threshold', UI.input(String(v.threshold == null ? 0.8 : v.threshold), { type: 'number', attrs: 'data-pthr min="0" max="1" step="0.01"' })) + '</div>'
        + UI.field('Object types', '<div class="hstack wrap gap6">' + typeNames.map((t) => UI.chip(esc(t), (v.objectTypes || []).indexOf(t) >= 0, 'data-ptype="' + esc(t) + '"')).join('') + '</div>', 'None picked means every type')
        + (isNew ? UI.notice('Created disabled and in shadow mode; enable it from the list once its verdicts look right.', 'info') : UI.field('Mode', UI.seg([{ id: 'shadow', label: 'Shadow' }, { id: 'enforce', label: 'Enforce' }], v.mode, 'data-pmode aria-label="Mode"'))),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(isNew ? 'Add' : 'Save', { kind: 'primary', attrs: 'data-psave' }),
      onMount(m) {
        m.querySelectorAll('[data-ptype]').forEach((c) => c.addEventListener('click', () => { c.classList.toggle('on'); c.setAttribute('aria-pressed', c.classList.contains('on') ? 'true' : 'false'); }));
        const seg = m.querySelector('[data-pmode]');
        if (seg) seg.addEventListener('click', (e) => { const b = e.target.closest('[data-seg]'); if (!b) return; mode = b.dataset.seg; seg.querySelectorAll('[data-seg]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); });
        m.querySelector('[data-psave]').addEventListener('click', async () => {
          const name = m.querySelector('[data-pname]').value.trim(), url = m.querySelector('[data-purl]').value.trim(), zone = m.querySelector('[data-pzone]').value.trim();
          if (!name || !url || !zone) { ctx.toast('Name, URL and zone are required.', 'warn'); return; }
          const secret = m.querySelector('[data-psecret]').value;
          const body = { name, kind: m.querySelector('[data-pkind]').value, url, zone, threshold: Math.min(1, Math.max(0, +m.querySelector('[data-pthr]').value || 0)), objectTypes: Array.prototype.map.call(m.querySelectorAll('[data-ptype].on'), (c) => c.dataset.ptype) };
          if (!body.objectTypes.length) body.objectTypes = null;
          if (secret) body.secret = secret;
          if (!isNew) body.mode = mode;
          try {
            if (isNew) await App.post('/api/moderation/providers', body); else await App.patch('/api/moderation/providers/' + encodeURIComponent(p.id), body);
            App.closeOverlay(); st.quiet = true; ctx.rerender();
            ctx.toast((isNew ? 'Provider added, disabled, in shadow mode. ' : 'Provider saved. ') + 'Audited with the host only.', 'ok');
          } catch (err) { App.fail(err, isNew ? 'Provider not added' : 'Provider not saved'); }
        });
      } });
  }
})();
