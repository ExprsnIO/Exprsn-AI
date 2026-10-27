(function () {
  const { UI, esc } = App;

  // Sprint 46 (B-134): SLA timers and assignment routing, shared by the Moderation (flags, held writes, appeals),
  // Flags and Channels (escalated sessions) screens over /api/sla. Policies and routing rules need each queue type's
  // manage permission (channels:manage for sessions, moderation:manage for the moderation queues); reading items,
  // state and statistics needs its review permission.
  const enc = encodeURIComponent;
  const TYPE_WORDS = { 'channel-session': 'Channel sessions', flag: 'Flags', 'held-write': 'Held writes', appeal: 'Appeals' };
  const MANAGE = { 'channel-session': 'channels:manage', flag: 'moderation:manage', 'held-write': 'moderation:manage', appeal: 'moderation:manage' };
  const REVIEW = { 'channel-session': 'channels:review', flag: 'flags:review', 'held-write': 'moderation:review', appeal: 'moderation:review' };
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_WORDS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const MODES = [{ value: 'manual', label: 'Manual (as today)' }, { value: 'round-robin', label: 'Round-robin' }, { value: 'least-loaded', label: 'Least-loaded (fewest open items)' }, { value: 'skills', label: 'Skills (tags matched to the item)' }];
  const small = (t) => '<span class="muted" style="font-size:12px">' + t + '</span>';
  const canManage = (type) => App.can(MANAGE[type]);
  const canRead = (type) => App.can(REVIEW[type]) || App.can(MANAGE[type]);

  /** Business time as words: "35 min", "3 h", "2 d". */
  const span = (ms) => { const m = Math.round(Math.abs(ms) / 60000); return m >= 2880 ? Math.round(m / 1440) + ' d' : m >= 120 ? Math.round(m / 60) + ' h' : m + ' min'; };
  const mins = (n) => (n == null ? small('none') : n >= 1440 && n % 1440 === 0 ? n / 1440 + ' d' : n >= 60 && n % 60 === 0 ? n / 60 + ' h' : n + ' min');

  /** One item's SLA state as pills: the state in words (never colour alone), time left, and a raised priority. */
  function badge(sla, priority) {
    const prio = priority === 'urgent' ? ' ' + UI.pill('urgent', 'danger') : priority === 'high' ? ' ' + UI.pill('high priority', 'warn') : '';
    if (!sla) return prio ? prio.slice(1) : '';
    let pill;
    if (sla.state === 'breached') pill = UI.pill('SLA breached' + (sla.leftMs != null ? ', ' + span(sla.leftMs) + ' over' : ''), 'danger');
    else if (sla.state === 'warning') pill = UI.pill('SLA due soon, ' + span(sla.leftMs || 0) + ' left', 'warn');
    else if (sla.state === 'paused') pill = UI.pill('SLA paused, waiting on the customer', 'info');
    else if (sla.state === 'met') pill = UI.pill('SLA met', 'ok');
    else pill = UI.pill('SLA ' + (sla.leftMs != null ? span(sla.leftMs) + ' left' : 'on time'), 'outline');
    return '<span class="sla-badge" title="' + esc(sla.policy + ': business time, from the item\'s own timestamps') + '">' + pill + '</span>' + prio;
  }

  /** The open items of a queue type with their SLA state, by id (an empty map without the permission). */
  function load(type, filter) {
    if (!canRead(type)) return Promise.resolve({});
    return App.get('/api/sla/items?type=' + enc(type) + (filter ? '&filter=' + enc(filter) : '')).then((r) => { const m = {}; (r.items || []).forEach((i) => { m[i.id] = i; }); return m; }).catch(() => ({}));
  }

  const windowsText = (w) => (w || []).map((p) => p[0] + '-' + p[1]).join(', ');
  const hoursText = (h) => {
    if (!h) return '24/7';
    const open = DAYS.filter((d) => (h.week[d] || []).length);
    return esc(h.timeZone) + ', ' + (open.length ? open.map((d) => d.slice(0, 1).toUpperCase() + d.slice(1, 3) + ' ' + windowsText(h.week[d])).join('; ') : 'no open days') + ((h.holidays || []).length ? ', ' + h.holidays.length + ' holiday' + (h.holidays.length === 1 ? '' : 's') : '');
  };
  const actionText = (list) => (list || []).map((a) => (a.kind === 'notify' ? 'notify' + (a.role ? ' and ' + a.role : '') : a.kind === 'priority' ? 'priority ' + a.to : 'escalate to ' + (a.role || 'a person'))).join(', ') || 'nothing';

  function fetchAll(ctx, st, types) {
    const s = st.sla;
    s.loading = true;
    const per = types.filter(canRead);
    Promise.all([
      App.get('/api/sla/policies').catch(() => ({ items: [] })),
      App.get('/api/sla/routing').catch(() => ({ items: [] })),
      Promise.all(per.map((t) => App.get('/api/sla/stats?type=' + enc(t)).catch(() => null))),
      App.can('users:manage') || types.some(canManage) ? App.get('/api/sla/skills').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      App.can('users:manage') ? App.get('/api/admin/users?limit=500').catch(() => []) : Promise.resolve([])
    ]).then(([p, r, stats, sk, users]) => {
      s.policies = (p.items || []).filter((x) => types.indexOf(x.queueType) >= 0);
      s.rules = (r.items || []).filter((x) => types.indexOf(x.queueType) >= 0);
      s.stats = {}; per.forEach((t, i) => { s.stats[t] = stats[i]; });
      s.skills = sk.items || [];
      s.users = (Array.isArray(users) ? users : users.items || []).map((u) => ({ id: u.id, name: u.displayName || u.username }));
      s.loaded = true; s.error = null;
    }).catch((err) => { s.error = err; }).finally(() => { s.loading = false; if (!document.getElementById('overlay')) ctx.rerender(); });
  }

  /**
   * The "SLA and routing" section for some queue types: policies, routing rules, statistics and skills. `opts.scope`
   * (a channel id) narrows it to one scope and makes it the default of new policies and rules.
   */
  function settings(ctx, st, types, opts) {
    opts = opts || {};
    const s = (st.sla = st.sla || {});
    if (s.forTypes !== types.join(',')) { s.forTypes = types.join(','); s.loaded = false; }
    if (!s.loaded && !s.loading && !s.error) fetchAll(ctx, st, types);
    if (s.error) return UI.problem('SLA settings could not be loaded', s.error.message, s.error.problem && s.error.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-slareload' }) + '</div>';
    if (!s.loaded) return UI.notice('Loading SLA settings…', 'info');
    const scope = opts.scope || null;
    const inScope = (x) => !scope || x.scope === '*' || x.scope === scope;
    const anyManage = types.some(canManage);
    const pols = s.policies.filter(inScope);
    const scopeWord = (x) => (x === '*' ? 'whole queue' : opts.scopeName && x === scope ? opts.scopeName : x);
    const policyRows = pols.map((p) => ({ cells: ['<b>' + esc(p.name) + '</b>', esc(TYPE_WORDS[p.queueType]), '<span class="mono">' + esc(scopeWord(p.scope)) + '</span>', mins(p.firstResponseMinutes), mins(p.resolutionMinutes), '<span class="num">' + p.warnPercent + '%</span>', hoursText(p.hours), p.pauseOnCustomer ? 'yes' : 'no', small(esc('warn: ' + actionText(p.onWarn) + '; breach: ' + actionText(p.onBreach))), p.enabled ? UI.pill('enabled', 'ok') : UI.pill('disabled', ''), canManage(p.queueType) ? '<span class="hstack gap6">' + UI.btn('Edit', { size: 'xs', attrs: 'data-slaedit="' + esc(p.id) + '"' }) + UI.btn('Delete', { size: 'xs', kind: 'ghost', attrs: 'data-sladel="' + esc(p.id) + '"' }) + '</span>' : small('read only')] }));
    const policies = UI.panel('SLA policies', UI.table(['Policy', 'Queue', 'Scope', 'First response', 'Resolution', { label: 'Warn at', right: true }, 'Business hours', 'Pause on customer', 'Actions', 'State', ''], policyRows, { clickable: false, minWidth: '1100px', emptyTitle: 'No SLA policy', emptyText: 'Without a policy the queue keeps its own timers only. A policy sets first-response and resolution targets in business hours, with warn and breach actions.' })
      + small('The most specific policy wins: one for a ' + (types.indexOf('channel-session') >= 0 ? 'channel' : 'queue or kind') + ' before the one for the whole queue. Timers count business hours only; waiting on the customer pauses resolution where the queue has that state (channel sessions).'),
    { actions: anyManage ? UI.btn('New policy', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-slanew' }) + UI.btn('Check timers now', { size: 'sm', icon: 'refresh', attrs: 'data-slaeval' }) : small('Changing SLAs needs ' + esc(types.map((t) => MANAGE[t]).filter((v, i, a) => a.indexOf(v) === i).join(' or '))) });

    const rules = UI.panel('Assignment routing', types.map((t) => {
      const want = scope || '*';
      const r = s.rules.find((x) => x.queueType === t && x.scope === want) || s.rules.find((x) => x.queueType === t && x.scope === '*' && !scope) || null;
      const v = r || { mode: 'manual', pool: {}, skipUnavailable: true, fallback: { kind: 'queue' }, enabled: true };
      const dis = canManage(t) ? '' : ' disabled';
      const key = 'data-slart="' + esc(t) + '"';
      return '<div class="sla-rule" ' + key + '><div class="eyebrow">' + esc(TYPE_WORDS[t]) + (scope ? ', ' + esc(scopeWord(want)) : '') + (r && r.scope !== want ? ' ' + small('(the whole queue\'s rule)') : '') + '</div>'
        + '<div class="formgrid" style="--cols:4">' + UI.field('Mode', UI.select(MODES, v.mode, 'data-rmode' + dis)) + UI.field('Pool role', UI.input(v.pool.role || '', { placeholder: 'any reviewer', attrs: 'data-rrole' + dis }), 'Empty: everyone who reviews this queue')
        + UI.field('Fallback', UI.select([{ value: 'queue', label: 'Leave it in the queue' }, { value: 'any', label: 'Least-loaded of the pool' }, { value: 'user', label: 'A person' }], v.fallback.kind, 'data-rfb' + dis))
        + UI.field('Fallback person', UI.select([{ value: '', label: 'Nobody chosen' }].concat(s.users.map((u) => ({ value: u.id, label: u.name }))), v.fallback.userId || '', 'data-rfbuser' + dis), s.users.length ? '' : 'People are listed for holders of users:manage') + '</div>'
        + '<div class="hstack wrap gap6">' + UI.check('Skip people who are away or offline', v.skipUnavailable, 'data-rskip' + dis) + UI.check('Enabled', v.enabled, 'data-renabled' + dis) + '<span class="grow"></span>' + (canManage(t) ? UI.btn('Save routing', { size: 'sm', kind: 'primary', attrs: 'data-rsave="' + esc(t) + '"' }) + (r && r.scope === want ? UI.btn('Remove', { size: 'sm', kind: 'ghost', attrs: 'data-rdel="' + esc(r.id) + '"' }) : '') : small('Needs ' + esc(MANAGE[t]))) + '</div></div>';
    }).join('<div class="divider"></div>') + small('Routing assigns unassigned items when the timers are checked (every minute), through each queue\'s own assignment, so the person is told and the change is audited. Skills are tags on people matched against an item\'s severity, checkpoint, rule, kind or channel.'));

    const statPanels = types.filter(canRead).map((t) => {
      const x = s.stats[t];
      if (!x) return '';
      const rows = (x.scopes || []).filter((y) => !scope || y.scope === scope).map((y) => [esc(scopeWord(y.scope)), '<span class="num">' + y.resolved + '</span>', y.resolutionMetPercent == null ? small('no target') : '<span class="num">' + y.resolutionMetPercent + '%</span>', y.firstResponseMetPercent == null ? small('no target') : '<span class="num">' + y.firstResponseMetPercent + '%</span>', y.averageFirstResponseMs == null ? small('none yet') : span(y.averageFirstResponseMs), '<span class="num">' + y.open + '</span>', '<span class="num">' + y.warning + '</span>', '<span class="num">' + y.breachedNow + '</span>']);
      return '<div class="eyebrow">' + esc(TYPE_WORDS[t]) + ', last ' + x.days + ' days</div>' + UI.table(['Scope', { label: 'Resolved', right: true }, { label: 'Resolution met', right: true }, { label: 'First response met', right: true }, 'Average first response', { label: 'Open', right: true }, { label: 'Due soon', right: true }, { label: 'Breached now', right: true }], rows, { clickable: false, minWidth: '760px', emptyTitle: 'No items under a policy yet', emptyText: 'Statistics count items a policy covered.' });
    }).join('');
    const stats = statPanels ? UI.panel('SLA statistics', statPanels) : '';

    const skills = App.can('users:manage') || s.skills.length ? UI.panel('Skills', UI.table(['Person', 'Skills', ''], s.skills.map((k) => ['<b>' + esc(k.name) + '</b>', k.skills.map((x) => UI.pill(x, 'outline')).join(' '), App.can('users:manage') ? UI.btn('Edit', { size: 'xs', attrs: 'data-skilledit="' + esc(k.userId) + '"' }) : '']), { clickable: false, minWidth: '0', emptyTitle: 'No skills yet', emptyText: 'Give people skill tags (high, user-report, channel:help desk) for skills routing.' }),
      { actions: App.can('users:manage') ? UI.btn('Add skills', { size: 'sm', icon: 'plus', attrs: 'data-skilladd' }) : small('Setting skills needs users:manage') }) : '';

    return '<style>#main .sla-rule{display:flex;flex-direction:column;gap:6px}#main .sla-badge{white-space:nowrap}</style>'
      + (s.note ? UI.notice(s.note, 'ok', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-slanote' })) : '')
      + policies + rules + stats + skills;
  }

  function parseWindows(text) {
    const out = [];
    for (const part of String(text || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(part);
      if (!m) throw new Error('"' + part + '" is not a window such as 09:00-17:00.');
      const pad = (t) => (t.length === 4 ? '0' + t : t);
      out.push([pad(m[1]), pad(m[2])]);
    }
    return out;
  }

  function actionFields(prefix, list, label) {
    const has = (k) => (list || []).find((a) => a.kind === k);
    const pr = has('priority'); const es = has('escalate');
    return '<div class="eyebrow">' + esc(label) + '</div><div class="formgrid" style="--cols:4">'
      + '<div class="field">' + UI.check('Notify the assignee, or the reviewers', !!has('notify'), 'data-' + prefix + 'notify') + '</div>'
      + UI.field('Raise priority', UI.select([{ value: '', label: 'No change' }, { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }], pr ? pr.to : '', 'data-' + prefix + 'prio'))
      + UI.field('Escalate to role', UI.input(es && es.role ? es.role : '', { placeholder: 'guardrail-admin', attrs: 'data-' + prefix + 'role' }))
      + UI.field('or to a person (user id)', UI.input(es && es.user ? es.user : '', { placeholder: 'leave empty', attrs: 'data-' + prefix + 'user' })) + '</div>';
  }

  function readActions(m, prefix) {
    const out = [];
    if (m.querySelector('[data-' + prefix + 'notify]').checked) out.push({ kind: 'notify' });
    const pr = m.querySelector('[data-' + prefix + 'prio]').value; if (pr) out.push({ kind: 'priority', to: pr });
    const role = m.querySelector('[data-' + prefix + 'role]').value.trim(); const user = m.querySelector('[data-' + prefix + 'user]').value.trim();
    if (role || user) out.push(Object.assign({ kind: 'escalate' }, role ? { role } : { user }));
    return out;
  }

  function policyModal(ctx, st, types, p, opts) {
    const isNew = !p;
    const writable = types.filter(canManage);
    const v = p || { name: '', queueType: writable[0], scope: (opts && opts.scope) || '*', firstResponseMinutes: 60, resolutionMinutes: 480, warnPercent: 80, hours: null, pauseOnCustomer: true, onWarn: [{ kind: 'notify' }], onBreach: [{ kind: 'notify' }], enabled: true };
    const h = v.hours || { timeZone: '', week: {}, holidays: [] };
    ctx.modal({ title: isNew ? 'New SLA policy' : 'Edit ' + esc(v.name), cls: 'wide',
      body: '<div class="formgrid" style="--cols:3">' + UI.field('Name', UI.input(v.name, { attrs: 'data-pname', placeholder: 'Customer support' }))
        + UI.field('Queue', UI.select(writable.map((t) => ({ value: t, label: TYPE_WORDS[t] })), v.queueType, 'data-ptype' + (isNew ? '' : ' disabled')))
        + UI.field('Scope', UI.input(v.scope, { attrs: 'data-pscope' }), '* for the whole queue, or a channel id, a review queue id or a kind')
        + UI.field('First response (minutes)', UI.input(v.firstResponseMinutes == null ? '' : String(v.firstResponseMinutes), { type: 'number', attrs: 'data-pfr min="1"' }), 'Empty for no target')
        + UI.field('Resolution (minutes)', UI.input(v.resolutionMinutes == null ? '' : String(v.resolutionMinutes), { type: 'number', attrs: 'data-pres min="1"' }), 'Empty for no target')
        + UI.field('Warn at (% of a target)', UI.input(String(v.warnPercent), { type: 'number', attrs: 'data-pwarn min="1" max="99"' })) + '</div>'
        + '<div class="eyebrow">Business hours</div><div class="formgrid" style="--cols:3">' + UI.field('Time zone', UI.input(h.timeZone, { placeholder: 'Empty: 24/7, every hour counts', attrs: 'data-ptz' }), 'An IANA zone such as Europe/London')
        + DAYS.map((d) => UI.field(DAY_WORDS[d], UI.input(windowsText(h.week[d]), { placeholder: d === 'sat' || d === 'sun' ? 'closed' : '09:00-17:00', attrs: 'data-pday="' + d + '"' }))).join('')
        + UI.field('Holidays', UI.input((h.holidays || []).join(', '), { placeholder: '2026-12-25, 2026-12-26', attrs: 'data-phol' }), 'Dates, comma separated; nothing is open on them') + '</div>'
        + actionFields('w', v.onWarn, 'When an item nears a target') + actionFields('b', v.onBreach, 'When an item passes a target')
        + '<div class="hstack wrap gap6">' + UI.check('Pause while waiting on the customer', v.pauseOnCustomer, 'data-ppause') + UI.check('Enabled', v.enabled, 'data-penabled') + '</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(isNew ? 'Create policy' : 'Save policy', { kind: 'primary', attrs: 'data-psave' }),
      onMount(m) {
        m.querySelector('[data-psave]').addEventListener('click', async () => {
          const q = (sel) => m.querySelector(sel);
          const name = q('[data-pname]').value.trim(); if (!name) { ctx.toast('A policy needs a name.', 'warn'); return; }
          const num = (sel) => { const x = q(sel).value.trim(); return x === '' ? null : Math.max(1, Math.round(+x || 0)); };
          let hours = null;
          try {
            const tz = q('[data-ptz]').value.trim();
            if (tz) {
              const week = {}; DAYS.forEach((d) => { const w = parseWindows(q('[data-pday="' + d + '"]').value); if (w.length) week[d] = w; });
              hours = { timeZone: tz, week, holidays: q('[data-phol]').value.split(',').map((x) => x.trim()).filter(Boolean) };
            }
          } catch (err) { ctx.toast(esc(err.message), 'warn'); return; }
          const body = { name, queueType: isNew ? q('[data-ptype]').value : v.queueType, scope: q('[data-pscope]').value.trim() || '*', firstResponseMinutes: num('[data-pfr]'), resolutionMinutes: num('[data-pres]'), warnPercent: Math.min(99, Math.max(1, +q('[data-pwarn]').value || 80)), hours, pauseOnCustomer: q('[data-ppause]').checked, onWarn: readActions(m, 'w'), onBreach: readActions(m, 'b'), enabled: q('[data-penabled]').checked };
          try {
            const saved = isNew ? await App.post('/api/sla/policies', body) : await App.put('/api/sla/policies/' + enc(p.id), body);
            App.closeOverlay(); st.sla.loaded = false; st.sla.note = 'Policy ' + esc(saved.name) + (isNew ? ' created' : ' saved') + '. Audited as sla.policy.' + (isNew ? 'created' : 'updated') + '.';
            ctx.rerender(); ctx.toast(st.sla.note, 'ok');
          } catch (err) { App.fail(err, isNew ? 'Policy not created' : 'Policy not saved'); }
        });
      } });
  }

  function skillsModal(ctx, st, userId) {
    const s = st.sla;
    const cur = s.skills.find((k) => k.userId === userId) || null;
    const people = s.users.length ? s.users : s.skills.map((k) => ({ id: k.userId, name: k.name }));
    ctx.modal({ title: cur ? 'Skills of ' + esc(cur.name) : 'Add skills',
      body: (cur ? '' : UI.field('Person', UI.select(people.map((u) => ({ value: u.id, label: u.name })), people.length ? people[0].id : '', 'data-kuser'))) + UI.field('Skills', UI.input(cur ? cur.skills.join(', ') : '', { placeholder: 'high, user-report, channel:help desk', attrs: 'data-kskills' }), 'Comma separated. Matched, without case, against an item\'s tags. Empty removes them all.'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save skills', { kind: 'primary', attrs: 'data-ksave' }),
      onMount(m) {
        m.querySelector('[data-ksave]').addEventListener('click', async () => {
          const uid = cur ? cur.userId : (m.querySelector('[data-kuser]') || {}).value;
          if (!uid) { ctx.toast('Choose a person.', 'warn'); return; }
          const skills = m.querySelector('[data-kskills]').value.split(',').map((x) => x.trim()).filter(Boolean);
          try {
            const r = await App.put('/api/sla/skills/' + enc(uid), { skills });
            App.closeOverlay(); s.loaded = false; s.note = 'Skills of ' + esc(r.name) + ' saved: ' + (r.skills.length ? esc(r.skills.join(', ')) : 'none') + '. Audited as sla.skills.updated.';
            ctx.rerender(); ctx.toast(s.note, 'ok');
          } catch (err) { App.fail(err, 'Skills not saved'); }
        });
      } });
  }

  /** Registers the section's handlers; call it inside render, after the markup is in place. */
  function bind(ctx, st, types, opts) {
    opts = opts || {};
    const s = st.sla || {};
    const refresh = () => { s.loaded = false; ctx.rerender(); };
    ctx.on('click', '[data-slareload]', () => { s.error = null; refresh(); });
    ctx.on('click', '[data-slanote]', () => { s.note = null; ctx.rerender(); });
    ctx.on('click', '[data-slanew]', () => policyModal(ctx, st, types, null, opts));
    ctx.on('click', '[data-slaedit]', (e, t) => { const p = (s.policies || []).find((x) => x.id === t.dataset.slaedit); if (p) policyModal(ctx, st, types, p, opts); });
    ctx.on('click', '[data-sladel]', async (e, t) => {
      const p = (s.policies || []).find((x) => x.id === t.dataset.sladel); if (!p) return;
      const ok = await ctx.confirm({ title: 'Delete policy ' + esc(p.name), tone: 'danger', body: '<p class="fg2" style="margin:0">Its items keep their queue\'s own timers; timers already finished stay in the statistics.</p>', ok: 'Delete' });
      if (!ok) return;
      try { await App.del('/api/sla/policies/' + enc(p.id)); s.note = 'Policy ' + esc(p.name) + ' deleted. Audited as sla.policy.deleted.'; refresh(); ctx.toast(s.note, 'ok'); } catch (err) { App.fail(err, 'Policy not deleted'); }
    });
    ctx.on('click', '[data-slaeval]', async () => {
      const ok = await ctx.confirm({ title: 'Check timers now', tone: 'info', body: '<p class="fg2" style="margin:0">Evaluates every open item under a policy now, as the minute schedule does: warn and breach actions fire once per item, and unassigned items are routed.</p>', ok: 'Check now' });
      if (!ok) return;
      try { const r = await App.post('/api/sla/evaluate'); s.note = r.tracked + ' items checked, ' + r.warned + ' warned, ' + r.breached + ' breached, ' + r.routed + ' routed, ' + r.closed + ' closed. Audited as sla.evaluated.'; refresh(); ctx.toast(s.note, 'ok'); if (opts.after) opts.after(); } catch (err) { App.fail(err, 'Timers not checked'); }
    });
    ctx.on('click', '[data-rsave]', async (e, t) => {
      const type = t.dataset.rsave; const box = ctx.$('[data-slart="' + type + '"]'); if (!box) return;
      const q = (sel) => box.querySelector(sel);
      const fb = q('[data-rfb]').value; const fbUser = q('[data-rfbuser]').value;
      if (fb === 'user' && !fbUser) { ctx.toast('Choose the fallback person.', 'warn'); return; }
      const role = q('[data-rrole]').value.trim();
      const body = { queueType: type, scope: opts.scope || '*', mode: q('[data-rmode]').value, pool: role ? { role } : {}, fallback: fb === 'user' ? { kind: 'user', userId: fbUser } : { kind: fb }, skipUnavailable: q('[data-rskip]').checked, enabled: q('[data-renabled]').checked };
      const ok = await ctx.confirm({ title: 'Save routing for ' + esc(TYPE_WORDS[type]), tone: 'info', body: '<p class="fg2" style="margin:0">' + (body.mode === 'manual' ? 'Items stay unassigned until a reviewer takes or hands them on.' : 'Unassigned items are assigned ' + esc(body.mode) + ' at the next check, through the queue\'s own assignment.') + '</p>', ok: 'Save' });
      if (!ok) return;
      try { await App.put('/api/sla/routing', body); s.note = 'Routing for ' + esc(TYPE_WORDS[type]) + ' saved: ' + esc(body.mode) + '. Audited as sla.routing.updated.'; refresh(); ctx.toast(s.note, 'ok'); } catch (err) { App.fail(err, 'Routing not saved'); }
    });
    ctx.on('click', '[data-rdel]', async (e, t) => {
      const ok = await ctx.confirm({ title: 'Remove this routing rule', tone: 'danger', body: '<p class="fg2" style="margin:0">Items go back to manual assignment (or to the whole queue\'s rule).</p>', ok: 'Remove' });
      if (!ok) return;
      try { await App.del('/api/sla/routing/' + enc(t.dataset.rdel)); s.note = 'Routing rule removed. Audited as sla.routing.deleted.'; refresh(); ctx.toast(s.note, 'ok'); } catch (err) { App.fail(err, 'Rule not removed'); }
    });
    ctx.on('click', '[data-skilledit]', (e, t) => skillsModal(ctx, st, t.dataset.skilledit));
    ctx.on('click', '[data-skilladd]', () => skillsModal(ctx, st, null));
  }

  App.sla = { badge, load, settings, bind, span, TYPE_WORDS };
})();
