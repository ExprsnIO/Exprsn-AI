(function () {
  const { UI, esc } = App;

  // 1.9.0, Sprint 50 (B-158 to B-161): the "Spam and flood" tab of the Moderation screen and the Overview's
  // "Moderation trends" card. The policy per surface (off, shadow or enforce, and the window thresholds) is
  // GET/PUT /api/moderation/spam/policy; flagged accounts with their reasons /accounts; responses /responses and their
  // lift; tenant-wide windows /signals; the 30-day metrics /api/moderation/metrics and its CSV export. Reading needs
  // moderation:review, the policy moderation:manage, lifting moderation:sanction. Nothing here shows content: only
  // signals, counts and thresholds.
  const enc = encodeURIComponent;
  const small = (t) => '<span class="muted" style="font-size:12px">' + t + '</span>';
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const num = (n) => String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const pct = (x) => (x == null ? 'none' : (Math.round(x * 1000) / 10) + '%');
  const mins = (ms) => (ms == null ? 'none' : ms >= 3600000 ? (Math.round(ms / 360000) / 10) + ' h' : Math.max(1, Math.round(ms / 60000)) + ' min');
  const SURFACE_WORDS = { post: 'Posts', comment: 'Comments', message: 'Messages', follow: 'Follows', invite: 'Group invitations', report: 'Reports', signup: 'Sign-ups', signin_failed: 'Failed sign-ins', firehose: 'Firehose records' };
  const KIND_WORDS = { slow: 'Slow mode', hold: 'Hold for review', limit: 'Posting limit', case: 'Limit and case' };
  const MODE_WORDS = { off: 'Off', shadow: 'Shadow (score only)', enforce: 'Enforce' };
  const modePill = (m) => UI.pill(MODE_WORDS[m] || m, m === 'enforce' ? 'danger' : m === 'shadow' ? 'warn' : '');
  const levelPill = (l) => (l === 'none' ? UI.pill('below the steps', '') : UI.pill(KIND_WORDS[l] || l, l === 'case' || l === 'limit' ? 'danger' : 'warn'));
  const reasonText = (r) => esc(r.signal) + ' ' + esc(String(r.value)) + ' / ' + esc(String(r.threshold));

  /** Loads what the tab shows; calls `done` when it has (also on failure). */
  function load(st, done) {
    const s = st.spam || (st.spam = {});
    if (s.loading) return;
    s.loading = true;
    Promise.all([
      App.get('/api/moderation/spam/policy'),
      App.get('/api/moderation/spam/accounts'),
      App.get('/api/moderation/spam/responses?state=active'),
      App.get('/api/moderation/spam/signals'),
      App.get('/api/moderation/metrics?days=30').catch(() => null)
    ]).then(([policy, accounts, responses, signals, metrics]) => {
      Object.assign(s, { policy, accounts: accounts.items, responses: responses.items, signals, metrics, loaded: true, error: null });
    }).catch((err) => { s.error = err; s.loaded = true; })
      .finally(() => { s.loading = false; done(); });
  }

  function section(ctx, st) {
    const s = st.spam || (st.spam = {});
    if (!s.loaded) { load(st, () => { if (App.state.route === 'moderation') ctx.rerender(); }); return UI.notice('Loading spam and flood checks…', 'info'); }
    if (s.error) return UI.problem('Spam and flood checks could not be loaded', s.error.message, s.error.problem && s.error.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-spreload' }) + '</div>';
    const p = s.policy;
    const canManage = App.can('moderation:manage'), canLift = App.can('moderation:sanction');
    const sig = {}; (s.signals.surfaces || []).forEach((x) => { sig[x.surface] = x; });
    const names = {}; (s.accounts || []).forEach((a) => { if (a.userId) names[a.userId] = a.displayName || a.username; });
    const intro = UI.notice('<b>' + (p.enabled ? 'The checks are on.' : 'The checks are off.') + '</b> ' + (p.enabled ? 'Every surface starts in shadow: accounts get a score from 0 to 100 with its reasons, and nothing is done to them. Switch a surface to enforce to apply the steps: slow mode, hold for review, a temporary posting limit, and a case in the moderation queue. Nobody is banned automatically; each person is told and can appeal. Admins and the allow-list are exempt.' : 'Nothing is counted until an admin turns them on. Turning them on starts every surface in shadow, scores only.') + (p.saved ? ' ' + small('Last saved ' + esc(when(p.updatedAt)) + '.') : ''), p.enabled ? 'info' : 'warn', canManage ? UI.btn(p.enabled ? 'Turn off' : 'Turn on', { size: 'sm', kind: p.enabled ? '' : 'primary', attrs: 'data-spenable="' + (p.enabled ? '0' : '1') + '"' }) : '');

    const rows = (p.surfaceNames || Object.keys(p.surfaces)).map((k) => {
      const v = p.surfaces[k]; const now = sig[k] && sig[k].tenant;
      return { cells: ['<b>' + esc(SURFACE_WORDS[k] || k) + '</b>', modePill(v.mode), '<span class="num">' + Math.round(v.windowSeconds / 60) + ' min</span>', '<span class="num">' + num(v.account) + '</span>', '<span class="num">' + num(v.ip) + '</span>', '<span class="num">' + num(v.tenant) + '</span>', '<span class="num">' + (now == null ? small('unknown') : num(Math.round(now))) + '</span>', canManage ? UI.btn('Edit', { size: 'xs', attrs: 'data-spsurface="' + esc(k) + '" aria-label="Edit ' + esc(SURFACE_WORDS[k] || k) + '"' }) : ''], attrs: '' };
    });
    const surfaces = UI.panel('Policy per surface', UI.table(['Surface', 'Mode', { label: 'Window', right: true }, { label: 'Per account', right: true }, { label: 'Per IP range', right: true }, { label: 'Per tenant', right: true }, { label: 'Tenant now', right: true }, ''], rows, { clickable: false, minWidth: '820px' })
      + small('IP ranges are /24 for IPv4 and /56 for IPv6. Counters live in the rate limiter\'s store (' + esc(s.signals.store) + (s.signals.degraded ? ', degraded: counting per instance' : '') + ').'));

    const r = p.responses;
    const steps = UI.panel('Steps', UI.kv([['Slow mode from', '<span class="num">' + r.slowAt + '</span> ' + small('one write every ' + r.slowSeconds + ' s')], ['Hold for review from', '<span class="num">' + r.holdAt + '</span>'], ['Posting limit from', '<span class="num">' + r.limitAt + '</span> ' + small(r.limitPerHour + ' an hour')], ['Case from', '<span class="num">' + r.caseAt + '</span>'], ['Each lasts', r.durationMinutes + ' min'], ['Score half-life', r.halfLifeMinutes + ' min']], 3), { actions: canManage ? UI.btn('Edit steps', { size: 'xs', attrs: 'data-spsteps' }) : '' });

    const acc = UI.panel('Flagged accounts', UI.table(['Account', { label: 'Score', right: true }, 'Step', 'Reasons', 'Responses', ''], (s.accounts || []).map((a) => {
      const who = a.userId ? '<b>' + esc(a.displayName || a.username || a.userId) + '</b>' + (a.username ? '<br>' + small(esc(a.username)) : '') : '<span class="mono">' + esc(a.account) + '</span><br>' + small(a.kind === 'did' ? 'AT-Protocol account' : 'IP range');
      const resp = (a.responses || []).map((x) => UI.pill(KIND_WORDS[x.kind] || x.kind, 'warn') + ' ' + small(esc(SURFACE_WORDS[x.surface] || x.surface) + ', until ' + esc(when(x.endsAt))) + (canLift ? ' ' + UI.btn('Lift', { size: 'xs', attrs: 'data-splift="' + esc(x.id) + '" aria-label="Lift ' + esc(KIND_WORDS[x.kind] || x.kind) + ' for ' + esc(a.displayName || a.username || 'this account') + '"' }) : '')).join('<br>');
      const allowBtn = canManage && a.userId && !a.exempt ? UI.btn('Allow', { size: 'xs', attrs: 'data-spallow="' + esc(a.userId) + '" aria-label="Add ' + esc(a.displayName || a.username || 'this account') + ' to the allow-list"' }) : '';
      return { cells: [who + (a.exempt ? ' ' + UI.pill('exempt', 'ok') : ''), '<span class="num">' + a.score + '</span>', levelPill(a.level), a.reasons.length ? a.reasons.map(reasonText).join('<br>') : small('decayed'), resp || small('none'), allowBtn] };
    }), { clickable: false, minWidth: '900px', emptyTitle: 'No account has a score', emptyText: p.enabled ? 'Nothing unusual was counted in the last two weeks.' : 'The checks are off.' }));

    const allow = UI.panel('Allow-list', (p.allowList.length ? '<ul class="vstack gap4" style="list-style:none;margin:0;padding:0">' + p.allowList.map((id) => '<li class="hstack gap6"><span class="grow">' + esc(names[id] || ((st.names || {})[id]) || id) + '</span>' + (canManage ? UI.btn('Remove', { size: 'xs', attrs: 'data-spunallow="' + esc(id) + '" aria-label="Remove ' + esc(names[id] || id) + ' from the allow-list"' }) : '') + '</li>').join('') + '</ul>' : small('Nobody besides admins is exempt. Add a flagged account with its Allow button.')));

    const m = s.metrics;
    const metrics = m ? UI.panel('Last 30 days', '<div class="stats">' + UI.stat(num(m.totals.decisions), 'Guardrail decisions', 'block ' + pct(m.totals.rates.block) + ', redact ' + pct(m.totals.rates.redact) + ', annotate ' + pct(m.totals.rates.annotate))
      + UI.stat(pct(m.totals.falsePositiveRate), 'False positives', num(m.totals.appealsUpheld) + ' of ' + num(m.totals.appealsDecided) + ' appeals upheld')
      + UI.stat(mins((m.totals.timeToDecision.flags || {}).meanMs), 'Time to decision', 'flags; held ' + mins((m.totals.timeToDecision.held || {}).meanMs) + ', appeals ' + mins((m.totals.timeToDecision.appeals || {}).meanMs))
      + UI.stat(num(Object.keys(m.totals.spamResponses).reduce((a, k) => a + m.totals.spamResponses[k], 0)), 'Spam responses', Object.keys(m.totals.spamResponses).map((k) => esc(KIND_WORDS[k] || k) + ' ' + m.totals.spamResponses[k]).join(', ') || 'none') + '</div>'
      + (m.topRules.length ? '<div class="eyebrow" style="margin-top:8px">Rules with the most hits</div>' + UI.table(['Rule', { label: 'Hits', right: true }], m.topRules.map((x) => [esc(x.name || x.ruleId), '<span class="num">' + num(x.hits) + '</span>']), { clickable: false }) : ''),
    { actions: '<a class="btn sm" href="/api/moderation/metrics/export?days=30" download data-spexport>Export CSV</a>' }) : '';

    return intro + surfaces + steps + acc + allow + metrics;
  }

  async function savePolicy(ctx, st, body, words) {
    try {
      st.spam.policy = await App.put('/api/moderation/spam/policy', body);
      st.spam.loaded = false;
      ctx.rerender();
      ctx.toast(words + ' Audited as spam.policy.updated.', 'ok');
    } catch (err) { App.fail(err, 'The policy was not saved'); }
  }

  function surfaceModal(ctx, st, key) {
    const v = st.spam.policy.surfaces[key];
    ctx.modal({ title: 'Edit ' + esc(SURFACE_WORDS[key] || key),
      body: '<div class="formgrid">' + UI.field('Mode', UI.select([{ value: 'off', label: MODE_WORDS.off }, { value: 'shadow', label: MODE_WORDS.shadow }, { value: 'enforce', label: MODE_WORDS.enforce }], v.mode, 'data-spmode'), 'Enforce applies the steps to people; shadow only scores')
        + UI.field('Window (minutes)', UI.input(String(Math.round(v.windowSeconds / 60)), { type: 'number', attrs: 'data-spwin min="1" max="1440"' }))
        + UI.field('Per account', UI.input(String(v.account), { type: 'number', attrs: 'data-spacc min="1"' }), 'Events in the window before it counts against the account')
        + UI.field('Per IP range', UI.input(String(v.ip), { type: 'number', attrs: 'data-spip min="1"' }))
        + UI.field('Per tenant', UI.input(String(v.tenant), { type: 'number', attrs: 'data-sptenant min="1"' })) + '</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-spsave' }),
      onMount(m) {
        m.querySelector('[data-spsave]').addEventListener('click', async () => {
          const n = (sel) => Math.max(1, Math.round(+m.querySelector(sel).value || 0));
          const mode = m.querySelector('[data-spmode]').value;
          const body = { surfaces: {} };
          body.surfaces[key] = { mode, windowSeconds: Math.min(86400, Math.max(10, n('[data-spwin]') * 60)), account: n('[data-spacc]'), ip: n('[data-spip]'), tenant: n('[data-sptenant]') };
          if (mode === 'enforce' && v.mode !== 'enforce') {
            App.closeOverlay();
            const ok = await ctx.confirm({ title: 'Enforce on ' + esc(SURFACE_WORDS[key] || key), tone: 'danger', body: '<p class="fg2" style="margin:0">People whose score reaches a step will be slowed, held for review or limited on this surface, and told so. Nobody is banned; each can appeal.</p>', ok: 'Enforce' });
            if (!ok) return;
          } else App.closeOverlay();
          await savePolicy(ctx, st, body, esc(SURFACE_WORDS[key] || key) + ': ' + esc(MODE_WORDS[mode]) + '.');
        });
      } });
  }

  function stepsModal(ctx, st) {
    const r = st.spam.policy.responses;
    const f = (label, key, hint) => UI.field(label, UI.input(String(r[key]), { type: 'number', attrs: 'data-spstep="' + key + '" min="0"' }), hint);
    ctx.modal({ title: 'Edit steps',
      body: '<div class="formgrid">' + f('Slow mode from score', 'slowAt') + f('Hold for review from score', 'holdAt') + f('Posting limit from score', 'limitAt') + f('Case from score', 'caseAt') + f('Slow mode interval (seconds)', 'slowSeconds') + f('Posting limit per hour', 'limitPerHour') + f('Each response lasts (minutes)', 'durationMinutes') + f('Score half-life (minutes)', 'halfLifeMinutes') + '</div>' + small('The steps must rise: slow ≤ hold ≤ limit ≤ case.'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save steps', { kind: 'primary', attrs: 'data-spstepsave' }),
      onMount(m) {
        m.querySelector('[data-spstepsave]').addEventListener('click', async () => {
          const body = { responses: {} };
          m.querySelectorAll('[data-spstep]').forEach((i) => { body.responses[i.dataset.spstep] = Math.round(+i.value || 0); });
          App.closeOverlay();
          await savePolicy(ctx, st, body, 'Steps saved.');
        });
      } });
  }

  /** Registers the tab's handlers; call it inside render, after the markup is in place. */
  function bind(ctx, st) {
    const s = st.spam || {};
    ctx.on('click', '[data-spreload]', () => { s.loaded = false; s.error = null; ctx.rerender(); });
    ctx.on('click', '[data-spsurface]', (e, t) => surfaceModal(ctx, st, t.dataset.spsurface));
    ctx.on('click', '[data-spsteps]', () => stepsModal(ctx, st));
    ctx.on('click', '[data-spenable]', async (e, t) => {
      const on = t.dataset.spenable === '1';
      const ok = await ctx.confirm({ title: on ? 'Turn the spam and flood checks on' : 'Turn the spam and flood checks off', tone: on ? 'info' : 'danger', body: '<p class="fg2" style="margin:0">' + (on ? 'Writes are counted per account, IP range and tenant, and scored. Every surface starts in shadow: nothing is done to anyone until you switch a surface to enforce.' : 'Nothing is counted or scored; active responses stay until they end or are lifted.') + '</p>', ok: on ? 'Turn on' : 'Turn off' });
      if (ok) await savePolicy(ctx, st, { enabled: on }, on ? 'The checks are on, in shadow.' : 'The checks are off.');
    });
    ctx.on('click', '[data-spallow]', async (e, t) => {
      const id = t.dataset.spallow;
      const a = (s.accounts || []).find((x) => x.userId === id);
      const ok = await ctx.confirm({ title: 'Allow ' + esc(a ? a.displayName || a.username : 'this account'), tone: 'info', body: '<p class="fg2" style="margin:0">The account is still scored but never slowed, held or limited. Active responses stay until lifted.</p>', ok: 'Allow' });
      if (ok) await savePolicy(ctx, st, { allowList: s.policy.allowList.concat([id]) }, 'Added to the allow-list.');
    });
    ctx.on('click', '[data-spunallow]', async (e, t) => {
      const id = t.dataset.spunallow;
      const ok = await ctx.confirm({ title: 'Remove from the allow-list', tone: 'danger', body: '<p class="fg2" style="margin:0">The account can be slowed, held or limited again on enforcing surfaces.</p>', ok: 'Remove' });
      if (ok) await savePolicy(ctx, st, { allowList: s.policy.allowList.filter((x) => x !== id) }, 'Removed from the allow-list.');
    });
    ctx.on('click', '[data-splift]', (e, t) => {
      const id = t.dataset.splift;
      ctx.modal({ title: 'Lift this response',
        body: UI.field('Reason', UI.input('', { attrs: 'data-spliftreason', placeholder: 'Known organiser' }), 'The person is told; the warning behind it ends'),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Lift', { kind: 'primary', attrs: 'data-spliftok' }),
        onMount(m) {
          m.querySelector('[data-spliftok]').addEventListener('click', async () => {
            const reason = m.querySelector('[data-spliftreason]').value.trim();
            App.closeOverlay();
            try {
              await App.post('/api/moderation/spam/responses/' + enc(id) + '/lift', reason ? { reason } : {});
              s.loaded = false; ctx.rerender(); ctx.toast('Response lifted. Audited as spam.response.lifted.', 'ok');
            } catch (err) { App.fail(err, 'The response was not lifted'); }
          });
        } });
    });
  }

  /** The Overview's optional card, from GET /api/admin/overview-cards/data. */
  function trendCard(d) {
    const t = d.totals;
    const max = Math.max(1, ...d.series.map((x) => x.decisions));
    const bars = '<div class="hstack" role="img" aria-label="Guardrail decisions per day over 14 days" style="align-items:flex-end;gap:2px;height:40px">' + d.series.map((x) => '<span title="' + esc(x.day + ': ' + x.decisions + ' decisions, ' + x.block + ' blocked') + '" style="flex:1;min-width:3px;background:var(--accent);opacity:.7;height:' + Math.max(2, Math.round((x.decisions / max) * 40)) + 'px"></span>').join('') + '</div>';
    return UI.panel('Moderation trends', '<div class="stats">' + UI.stat(num(t.decisions), 'Decisions', 'block ' + pct(t.rates.block) + ', redact ' + pct(t.rates.redact)) + UI.stat(pct(t.falsePositiveRate), 'False positives', 'upheld appeals') + UI.stat(num(Object.keys(t.spamResponses).reduce((a, k) => a + t.spamResponses[k], 0)), 'Spam responses', '14 days') + '</div>' + bars, { actions: UI.btn('Moderation', { size: 'xs', kind: 'ghost', attrs: 'data-go="moderation"' }) });
  }

  App.modSpam = { section, bind, load, trendCard };
})();
