// Apps, Sprint 44 (Insight in Apps, B-124): scheduled delivery of a view, report, dashboard or an entity's records by
// email, to the file store or to a signed webhook (/api/apps/subscriptions). Two parts:
//
// - the Subscribe dialog, App.appsSubscribe({ app, appTitle, kind, id, title }), with format, schedule (a preset
//   picker or a cron, the time zone, the next runs from the server), destinations and options. Screens put a button
//   from App.appsSubscribeButton({...}) next to a view, report or dashboard; one document listener opens the dialog;
// - the Subscriptions screen (#/app-subscriptions): My subscriptions, Sent to me, and (tenant:manage) All in the
//   tenant, each with its schedule, state, delivery history, Run now, Pause or Resume, Delete and Unsubscribe.
//
// Every delivery is rendered on the server as its recipient and re-checked at every run; nothing here decides access.
(function () {
  const { UI, esc } = App;
  const ID = 'app-subscriptions';
  const enc = encodeURIComponent;
  const CSS = '.appsub-runs{margin:0;padding:0 0 0 18px;font-size:12px;font-variant-numeric:tabular-nums}.appsub-params{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}'
    + '.appsub-sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.appsub-dest{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--line);border-radius:8px;min-width:0}'
    + '#main .appsub-name{overflow-wrap:anywhere}#main .appsub-actions{display:flex;flex-wrap:wrap;gap:6px}';
  const KIND_WORDS = { view: 'View', report: 'Report', dashboard: 'Dashboard', records: 'Records' };
  const FORMAT_WORDS = { xlsx: 'Excel workbook (XLSX)', pdf: 'PDF', csv: 'CSV', html: 'HTML page' };
  const OUTCOME_TONE = { sent: 'ok', linked: 'ok', failed: 'danger', denied: 'danger', 'skipped-empty': 'outline', 'skipped-unchanged': 'outline', skipped: 'outline', nothing: 'outline' };
  const OUTCOME_WORDS = { sent: 'sent', linked: 'sent as a link', failed: 'failed', denied: 'not allowed', 'skipped-empty': 'skipped: no rows', 'skipped-unchanged': 'skipped: unchanged', skipped: 'skipped', nothing: 'nothing to send' };
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Something went wrong.';
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const size = (n) => (n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1000 ? Math.round(n / 1000) + ' kB' : n + ' B');
  let options = null;
  let zones = null;

  function zoneList() {
    if (zones) return zones;
    let list = [];
    try { list = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []; } catch (e) { list = []; }
    zones = ['UTC'].concat(list.filter((z) => z !== 'UTC'));
    return zones;
  }
  function localZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }
  function loadOptions() { return options ? Promise.resolve(options) : App.get('/api/apps/subscriptions/options').then((o) => (options = o)); }

  // ---------------- the Subscribe button and dialog ----------------

  /** A Subscribe button for a view, report, dashboard or an entity's records: o = { app, appTitle, kind, id, title }. */
  App.appsSubscribeButton = function (o, opts) {
    opts = opts || {};
    const attrs = 'data-app-subscribe data-sub-app="' + esc(o.app) + '" data-sub-app-title="' + esc(o.appTitle || '') + '" data-sub-kind="' + esc(o.kind) + '" data-sub-id="' + esc(o.id) + '" data-sub-title="' + esc(o.title || '') + '"';
    return UI.btn('Subscribe', { size: opts.size || 'xs', icon: 'clock', attrs: attrs + ' aria-label="Subscribe to ' + esc(o.title || KIND_WORDS[o.kind] || 'this') + '"', title: 'Deliver it on a schedule by email, to the file store or to a webhook' });
  };
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-app-subscribe]') : null;
    if (!b || b.disabled) return;
    App.appsSubscribe({ app: b.dataset.subApp, appTitle: b.dataset.subAppTitle, kind: b.dataset.subKind, id: b.dataset.subId, title: b.dataset.subTitle });
  });

  function presetSelect(list, chosen) {
    const groups = [];
    list.forEach((p) => { let g = groups.find((x) => x.name === p.group); if (!g) groups.push((g = { name: p.group, items: [] })); g.items.push(p); });
    return '<select class="select" data-sb-preset>' + groups.map((g) => '<optgroup label="' + esc(g.name) + '">' + g.items.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === chosen ? ' selected' : '') + '>' + esc(p.title) + '</option>').join('') + '</optgroup>').join('')
      + '<optgroup label="Other"><option value="custom"' + (chosen === 'custom' ? ' selected' : '') + '>Custom (a cron expression)</option></optgroup></select>';
  }
  function paramsHtml(list, presetId) {
    if (presetId === 'custom') return UI.field('Cron expression', UI.input('0 9 * * 1-5', { attrs: 'data-sb-cron maxlength="120" autocomplete="off" spellcheck="false"' }), 'Five parts: minute, hour, day of the month, month, day of the week.');
    const p = list.find((x) => x.id === presetId);
    if (!p || !p.params.length) return '<p class="appsub-sub" style="margin:0">This preset has nothing to set.</p>';
    return '<div class="appsub-params">' + p.params.map((x) => UI.field(x.label, UI.input(String(x.default), { type: 'number', attrs: 'data-sb-param="' + esc(x.name) + '" min="' + x.min + '" max="' + x.max + '" step="1" inputmode="numeric"' }))).join('') + '</div>';
  }

  App.appsSubscribe = function (o) {
    loadOptions().then((opt) => openDialog(o, opt)).catch((err) => App.fail(err, 'Subscriptions are not available'));
  };

  function openDialog(o, opt) {
    const isDash = o.kind === 'dashboard';
    const formats = (opt.formats || ['xlsx', 'pdf', 'csv', 'html']).filter((f) => !isDash || f === 'pdf' || f === 'html');
    const canOthers = App.can('apps:design');
    const canFiles = App.can('files:write');
    const canHook = App.can('webhooks:manage');
    const firstPreset = (opt.presets || []).find((p) => p.id === 'weekdays') ? 'weekdays' : ((opt.presets || [])[0] || { id: 'custom' }).id;
    const tzOptions = zoneList();
    const tz = localZone();
    const title = esc(o.title || KIND_WORDS[o.kind] || 'this');
    const body = '<style>' + CSS + '</style>'
      + '<p class="fg2" style="margin:0;font-size:12px">Each delivery is made on the server as its recipient, with what they may read at that moment; someone who cannot read ' + title + ' gets nothing.' + (opt.renderAvailable ? '' : ' Rendering is not available on this server yet, so deliveries will fail until it is.') + '</p>'
      + UI.field('Name', UI.input(o.title || '', { attrs: 'data-sb-name maxlength="100" autocomplete="off"' }))
      + UI.field('Format', UI.select(formats.map((f) => ({ value: f, label: FORMAT_WORDS[f] || f })), isDash ? 'pdf' : 'xlsx', 'data-sb-format'))
      + '<fieldset class="appsub-dest"><legend style="font-weight:600;font-size:13px">Schedule</legend>'
      + UI.field('Repeats', presetSelect(opt.presets || [], firstPreset))
      + '<div data-sb-params>' + paramsHtml(opt.presets || [], firstPreset) + '</div>'
      + UI.field('Time zone', '<input class="input" data-sb-tz list="appsub-zones" value="' + esc(tz) + '" autocomplete="off" spellcheck="false" maxlength="64"><datalist id="appsub-zones">' + tzOptions.map((z) => '<option value="' + esc(z) + '"></option>').join('') + '</datalist>', 'An IANA zone such as Europe/Berlin; the times above are read in it.')
      + '<div><div style="font-size:12px;font-weight:600">Next deliveries</div><div data-sb-runs role="status" aria-live="polite" class="appsub-sub">Working out the next runs…</div></div>'
      + '</fieldset>'
      + '<fieldset class="appsub-dest"><legend style="font-weight:600;font-size:13px">Destinations</legend>'
      + UI.check('Email it to me', true, 'data-sb-self')
      + (canOthers ? UI.field('Also email (usernames, separated by commas)', UI.input('', { attrs: 'data-sb-others maxlength="2000" autocomplete="off"', placeholder: 'mia, noa' }), 'Each person gets their own render, made as them: never your data.') : '<span class="appsub-sub">Adding other people needs the app design right.</span>')
      + (canFiles ? UI.check('Save a copy to a folder in the file store', false, 'data-sb-file') + '<div data-sb-filebox hidden></div>' : '')
      + (canHook ? UI.check('Post it to a signed webhook', false, 'data-sb-hook')
        + '<div data-sb-hookbox hidden>' + UI.field('Webhook address', UI.input('', { type: 'url', attrs: 'data-sb-url maxlength="2000" autocomplete="off" spellcheck="false"', placeholder: 'https://hooks.example.com/reports' }), 'Only hosts on the tenant\'s list of allowed hosts.')
        + UI.field('Signature', UI.select([{ value: 'hmac', label: 'HMAC-SHA256 with a secret shown once' }, { value: 'ed25519', label: 'Ed25519 with the tenant\'s webhook key' }], 'hmac', 'data-sb-signing'))
        + UI.field('Highest label it may carry', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal', 'data-sb-maxlabel')) + '</div>' : '')
      + '</fieldset>'
      + '<fieldset class="appsub-dest"><legend style="font-weight:600;font-size:13px">Options</legend>'
      + UI.check('Only when there are rows', false, 'data-sb-rows')
      + UI.check('Only when it changed since the last delivery', false, 'data-sb-changed')
      + UI.field('Message (added to each email)', UI.textarea('', { attrs: 'data-sb-message maxlength="1000"', rows: 2 }))
      + '</fieldset><div data-sb-err></div>';
    App.modal({
      title: 'Subscribe to ' + title, cls: 'wide', body,
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Subscribe', { kind: 'primary', attrs: 'data-sb-ok' }),
      onMount(m) {
        const $ = (s) => m.querySelector(s);
        const nameInput = $('[data-sb-name]'); if (nameInput) nameInput.focus();
        let timer = null; let seq = 0;
        const schedule = () => {
          const preset = $('[data-sb-preset]').value; const timezone = ($('[data-sb-tz]').value || '').trim() || 'UTC';
          if (preset === 'custom') return { cron: (($('[data-sb-cron]') || {}).value || '').trim(), timezone };
          const values = {}; m.querySelectorAll('[data-sb-param]').forEach((i) => { if (i.value !== '') values[i.dataset.sbParam] = Number(i.value); });
          return { preset, values, timezone };
        };
        const preview = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const mine = ++seq; const box = $('[data-sb-runs]');
            App.post('/api/apps/subscriptions/preview', { schedule: schedule(), count: 5 })
              .then((d) => { if (mine !== seq || !box) return; box.innerHTML = '<div>' + esc(d.description) + '</div><ol class="appsub-runs">' + d.runs.map((r) => '<li>' + esc(r.local) + '</li>').join('') + '</ol>'; })
              .catch((err) => { if (mine !== seq || !box) return; box.innerHTML = UI.notice(esc(detailOf(err)), 'warn'); });
          }, 250);
        };
        $('[data-sb-preset]').addEventListener('change', (e) => { $('[data-sb-params]').innerHTML = paramsHtml(opt.presets || [], e.target.value); preview(); });
        m.addEventListener('input', (e) => { if (e.target.matches('[data-sb-param],[data-sb-cron],[data-sb-tz]')) preview(); });
        preview();
        const fileBox = $('[data-sb-filebox]');
        const fileCheck = $('[data-sb-file]');
        if (fileCheck) fileCheck.addEventListener('change', () => {
          fileBox.hidden = !fileCheck.checked;
          if (!fileCheck.checked || fileBox.dataset.loaded) return;
          fileBox.dataset.loaded = '1'; fileBox.innerHTML = '<span class="appsub-sub">Loading folders…</span>';
          App.get('/api/files/browse').then((d) => {
            const folders = d.folders || [];
            fileBox.innerHTML = folders.length ? UI.field('Folder in ' + (d.workspace ? d.workspace.name : 'this workspace'), UI.select(folders.map((f) => ({ value: f.id, label: f.name })), folders[0].id, 'data-sb-folder')) : UI.notice('This workspace\'s file store has no folders yet; create one in Files first.', 'info');
          }).catch((err) => { fileBox.innerHTML = UI.notice(esc(detailOf(err)), 'warn'); });
        });
        const hookCheck = $('[data-sb-hook]');
        if (hookCheck) hookCheck.addEventListener('change', () => { $('[data-sb-hookbox]').hidden = !hookCheck.checked; });
        $('[data-sb-ok]').addEventListener('click', async () => {
          const err = $('[data-sb-err]'); err.innerHTML = '';
          const name = nameInput.value.trim();
          if (!name) { err.innerHTML = UI.notice('A subscription needs a name.', 'warn'); nameInput.focus(); return; }
          const others = ($('[data-sb-others]') || { value: '' }).value.split(',').map((x) => x.trim()).filter(Boolean);
          const folder = fileCheck && fileCheck.checked ? $('[data-sb-folder]') : null;
          if (fileCheck && fileCheck.checked && !folder) { err.innerHTML = UI.notice('Choose a folder, or leave the file store out.', 'warn'); return; }
          const hook = hookCheck && hookCheck.checked ? { url: $('[data-sb-url]').value.trim(), signing: $('[data-sb-signing]').value, maxLabel: $('[data-sb-maxlabel]').value } : null;
          const payload = {
            name, app: o.app, kind: o.kind, id: o.id, format: $('[data-sb-format]').value, schedule: schedule(),
            destinations: { email: { self: $('[data-sb-self]').checked, others }, file: folder ? { folderId: folder.value } : null, webhook: hook },
            options: { onlyIfRows: $('[data-sb-rows]').checked, onlyIfChanged: $('[data-sb-changed]').checked, message: $('[data-sb-message]').value.trim() }
          };
          const ok = $('[data-sb-ok]'); ok.disabled = true;
          try {
            const sub = await App.post('/api/apps/subscriptions', payload);
            App.closeOverlay();
            App.toast('Subscribed to ' + esc(sub.name) + '. Next delivery ' + esc(when(sub.nextRunAt)) + '. <a href="#/' + ID + '?id=' + enc(sub.id) + '">My subscriptions</a>. Audited app.subscription.created.', 'ok', 6000);
            if (sub.webhookSecret) showSecret(sub);
            const st = App.stateFor(ID); st.loaded = false;
          } catch (e2) { ok.disabled = false; err.innerHTML = UI.notice(esc(detailOf(e2)), 'danger'); }
        });
      }
    });
  }

  function showSecret(sub) {
    App.modal({
      title: 'Webhook secret for ' + esc(sub.name),
      body: '<p class="fg2" style="margin:0">The receiver checks <span class="mono">x-exprsn-signature</span>, an HMAC-SHA256 over the timestamp, a dot and the body, with this secret. It is shown once and stored sealed.</p>' + UI.code(sub.webhookSecret),
      actions: UI.btn('Done', { kind: 'primary', attrs: 'data-close' })
    });
  }

  // ---------------- the Subscriptions screen ----------------

  function load(ctx) {
    const st = ctx.state;
    if (st.busy) return;
    st.busy = true;
    const all = App.can('tenant:manage');
    Promise.all([App.get('/api/apps/subscriptions'), all ? App.get('/api/apps/subscriptions/all').catch(() => ({ subscriptions: [] })) : Promise.resolve(null)])
      .then(([mine, every]) => { st.mine = mine.subscriptions; st.received = mine.received; st.all = every ? every.subscriptions : null; st.error = null; })
      .catch((err) => { st.error = err; })
      .finally(() => { st.busy = false; st.loaded = true; if (App.state.route === ID && !document.getElementById('overlay')) ctx.rerender(); });
  }
  function loadHistory(ctx, id) {
    const st = ctx.state; st.hist = st.hist || {};
    if (st.hist[id]) return;
    st.hist[id] = { loading: true };
    App.get('/api/apps/subscriptions/' + enc(id) + '/deliveries?limit=50')
      .then((d) => { st.hist[id] = { items: d.deliveries }; })
      .catch((err) => { st.hist[id] = { error: detailOf(err) }; })
      .finally(() => { if (App.state.route === ID && !document.getElementById('overlay')) ctx.rerender(); });
  }

  const listOf = (st) => ((st.tab === 'received' ? st.received : st.tab === 'all' ? st.all : st.mine) || []).filter((x) => !(st.gone && st.gone[x.id]));
  const statePill = (x) => (x.state === 'paused' ? UI.pill('paused', 'warn') : UI.pill('active', 'ok'));
  const lastPill = (x) => (x.lastOutcome ? UI.pill(OUTCOME_WORDS[x.lastOutcome] || x.lastOutcome, OUTCOME_TONE[x.lastOutcome] || 'outline') : '<span class="muted">not yet</span>');

  function destinationsText(x) {
    if (!x.destinations) return x.receiving ? 'Email to you' : (x.unsubscribed ? 'You unsubscribed' : '');
    const d = x.destinations; const out = [];
    if (d.email.self) out.push(d.email.selfUnsubscribed ? 'email to the owner (unsubscribed)' : 'email to the owner');
    if (d.email.others.length) out.push('email to ' + d.email.others.map((p) => (p.name || p.username || 'someone') + (p.unsubscribed ? ' (unsubscribed)' : '')).join(', '));
    if (d.file) out.push('a folder in the file store');
    if (d.webhook) out.push('a webhook on ' + d.webhook.host + ' (' + (d.webhook.signing === 'ed25519' ? 'Ed25519' : 'HMAC') + ', up to ' + d.webhook.maxLabel + ')');
    return out.join('; ') || 'none';
  }

  function inspector(ctx, x) {
    const st = ctx.state;
    const h = (st.hist || {})[x.id];
    if (!h) loadHistory(ctx, x.id);
    const owner = x.mine; const admin = st.tab === 'all' && App.can('tenant:manage');
    const actions = (owner && x.state === 'active' ? UI.btn('Run now', { size: 'sm', icon: 'play', attrs: 'data-sx-run' }) : '')
      + (owner ? UI.btn(x.state === 'active' ? 'Pause' : 'Resume', { size: 'sm', icon: x.state === 'active' ? 'pause' : 'play', attrs: 'data-sx-toggle' }) : admin && x.state === 'active' ? UI.btn('Pause', { size: 'sm', icon: 'pause', attrs: 'data-sx-toggle' }) : '')
      + (x.receiving && !owner ? UI.btn('Unsubscribe', { size: 'sm', attrs: 'data-sx-unsub' }) : '')
      + (owner && x.destinations && x.destinations.email.self && !x.destinations.email.selfUnsubscribed ? UI.btn('Stop my emails', { size: 'sm', attrs: 'data-sx-unsub' }) : '')
      + (owner || admin ? UI.btn('Delete', { size: 'sm', kind: 'danger', icon: 'trash', attrs: 'data-sx-delete' }) : '');
    const kv = [
      ['App', esc((x.app && (x.app.title || x.app.name)) || '')],
      ['What', esc(KIND_WORDS[x.kind] || x.kind) + ', ' + esc(FORMAT_WORDS[x.format] || x.format)],
      ['Schedule', esc(x.schedule.description)],
      ['Next delivery', x.state === 'active' && x.nextRunAt ? esc(when(x.nextRunAt)) : '<span class="muted">none while paused</span>'],
      ['Owner', esc((x.owner && (x.owner.name || x.owner.username)) || '')],
      ['Label', UI.label(x.label, { sm: true })],
      ['State', statePill(x)],
      ['Last delivery', lastPill(x) + (x.lastRunAt ? ' <span class="muted">' + esc(when(x.lastRunAt)) + '</span>' : '')]
    ];
    if (x.destinations) kv.push(['Destinations', esc(destinationsText(x))]);
    if (x.options) kv.push(['Options', esc([x.options.onlyIfRows ? 'only when there are rows' : null, x.options.onlyIfChanged ? 'only when changed' : null].filter(Boolean).join(', ') || 'every time')]);
    const notes = (x.pausedReason ? UI.notice(esc(x.pausedReason), 'warn') : '') + (x.lastProblem ? UI.notice(esc(x.lastProblem), x.lastOutcome === 'failed' ? 'danger' : 'info') : '');
    const hist = !h || h.loading ? '<p class="muted" style="font-size:12px">Loading the history…</p>' : h.error ? UI.notice(esc(h.error), 'warn')
      : UI.table(['When', 'To', 'Outcome', { label: 'Rows', right: true }, { label: 'Size', right: true }], h.items.map((d) => ({ cells: [esc(when(d.at)), esc(d.destination === 'email' ? 'email ' + ((d.recipient && d.recipient.name) || '') : d.destination === 'file' ? 'file store' : 'webhook'), UI.pill(OUTCOME_WORDS[d.outcome] || d.outcome, OUTCOME_TONE[d.outcome] || 'outline') + (d.reason ? '<div class="appsub-sub">' + esc(d.reason) + '</div>' : ''), d.rows == null ? '' : String(d.rows), esc(size(d.bytes))], attrs: '' })), { clickable: false, emptyTitle: 'No deliveries yet', emptyText: 'Each delivery shows here with its recipients, rows, size and outcome; the content is never kept.', attrs: 'aria-label="Delivery history"' });
    return '<aside class="inspector w360" aria-label="Subscription details"><div class="vstack gap12">'
      + '<h2 class="appsub-name" style="margin:0;font-size:16px">' + esc(x.name) + '</h2>'
      + (actions ? '<div class="appsub-actions">' + actions + '</div>' : '') + notes + UI.kv(kv, 1)
      + '<h3 style="margin:0;font-size:13px">Delivery history</h3>' + hist + '</div></aside>';
  }

  App.register({
    id: ID,
    title: 'Subscriptions',
    summary: 'Views, reports and dashboards delivered on a schedule',
    crumb: ['Apps', 'Subscriptions'],
    live: true,
    commands: [{ label: 'My subscriptions', sub: 'Apps', run() {} }],
    states: [],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'mine';
      if (ctx.params.id) { st.sel = ctx.params.id; st.wanted = ctx.params.id; delete ctx.params.id; }
      if (!st.loaded) load(ctx);
      if (st.tab === 'all' && !App.can('tenant:manage')) st.tab = 'mine';
      if (st.wanted && st.loaded) {
        const w = st.wanted; st.wanted = null;
        if ((st.received || []).some((x) => x.id === w)) st.tab = 'received';
        else if (!(st.mine || []).some((x) => x.id === w) && (st.all || []).some((x) => x.id === w)) st.tab = 'all';
      }
      const tabs = [{ id: 'mine', label: 'My subscriptions', count: (st.mine || []).length }, { id: 'received', label: 'Sent to me', count: (st.received || []).length }].concat(App.can('tenant:manage') ? [{ id: 'all', label: 'All in the tenant', count: (st.all || []).length }] : []);
      const list = listOf(st);
      const sel = list.find((x) => x.id === st.sel) || null;
      let content;
      if (st.error) content = UI.problem('Subscriptions could not be loaded', detailOf(st.error), st.error.problem && st.error.problem.trace_id);
      else if (!st.loaded) content = '<p class="muted">Loading subscriptions…</p>';
      else {
        const empty = st.tab === 'mine' ? ['No subscriptions yet', 'Open a saved view, report or dashboard in Apps and choose Subscribe to have it delivered on a schedule.'] : st.tab === 'received' ? ['Nothing is sent to you', 'When a designer adds you to a delivery, it shows here and you can unsubscribe.'] : ['No subscriptions in this tenant', ''];
        content = UI.table(['Name', 'App', 'What', 'Schedule', 'Next delivery', 'State', 'Last'].concat(st.tab === 'mine' ? [] : ['Owner']), list.map((x) => ({
          cells: ['<span class="appsub-name">' + esc(x.name) + '</span>', esc((x.app && (x.app.title || x.app.name)) || ''), esc(KIND_WORDS[x.kind] || x.kind) + ' <span class="muted">' + esc(x.format) + '</span>', esc(x.schedule.description), x.state === 'active' && x.nextRunAt ? esc(when(x.nextRunAt)) : '<span class="muted">none</span>', statePill(x), lastPill(x)].concat(st.tab === 'mine' ? [] : [esc((x.owner && (x.owner.name || x.owner.username)) || '')]),
          attrs: 'data-sx="' + esc(x.id) + '"', selected: sel && sel.id === x.id
        })), { emptyTitle: empty[0], emptyText: empty[1], attrs: 'aria-label="Subscriptions"' });
      }
      root.innerHTML = '<style>' + CSS + '</style><div class="page">'
        + UI.pagehead('Subscriptions', 'Views, reports, dashboards and records delivered on a schedule by email, to the file store or to a signed webhook. Each delivery is made as its recipient, checked again every time.', UI.btn('Refresh', { size: 'sm', icon: 'refresh', attrs: 'data-sx-refresh' }))
        + UI.tabs(tabs, st.tab, 'aria-label="Subscriptions"') + '<div>' + content + '</div></div>' + (sel ? inspector(ctx, sel) : '');

      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; st.sel = null; ctx.rerender(); });
      ctx.on('click', 'tr[data-sx]', (e, t) => { st.sel = t.dataset.sx; ctx.rerender(); });
      ctx.on('click', '[data-sx-refresh]', () => { st.loaded = false; st.hist = {}; ctx.rerender(); });
      if (!sel) return;
      const base = '/api/apps/subscriptions/' + enc(sel.id);
      const reload = (msg, tone) => { ctx.toast(msg, tone || 'ok'); st.loaded = false; st.hist = {}; ctx.rerender(); };
      ctx.on('click', '[data-sx-run]', async () => {
        try { await App.post(base + '/run', {}); reload('Delivering ' + esc(sel.name) + ' now. It shows in the history when it is done. Audited app.subscription.run.'); }
        catch (err) { App.fail(err, 'The delivery did not start'); }
      });
      ctx.on('click', '[data-sx-toggle]', async () => {
        const pause = sel.state === 'active';
        const ok = await ctx.confirm({ title: (pause ? 'Pause ' : 'Resume ') + sel.name, tone: pause ? 'warn' : 'info', body: '<p class="fg2" style="margin:0">' + (pause ? 'No deliveries are made until it is resumed.' : 'Resuming checks again that you may read it, and deliveries start at the next scheduled time.') + '</p>', ok: pause ? 'Pause' : 'Resume' });
        if (!ok) return;
        try { await App.patch(base, { state: pause ? 'paused' : 'active' }); reload(esc(sel.name) + (pause ? ' is paused. Audited app.subscription.paused.' : ' is active again. Audited app.subscription.resumed.'), pause ? 'warn' : 'ok'); }
        catch (err) { App.fail(err, 'The subscription was not changed'); }
      });
      ctx.on('click', '[data-sx-unsub]', async () => {
        const ok = await ctx.confirm({ title: 'Stop your emails of ' + sel.name, tone: 'warn', body: '<p class="fg2" style="margin:0">Only your copies stop; everyone else\'s, and the other destinations, go on.</p>', ok: 'Unsubscribe' });
        if (!ok) return;
        try { await App.post(base + '/unsubscribe', {}); reload('You no longer receive ' + esc(sel.name) + ' by email. Audited app.subscription.unsubscribed.', 'warn'); }
        catch (err) { App.fail(err, 'You were not unsubscribed'); }
      });
      ctx.on('click', '[data-sx-delete]', async () => {
        const ok = await ctx.confirm({ title: 'Delete ' + sel.name, tone: 'danger', body: '<p class="fg2" style="margin:0">No more deliveries are made to anyone. Copies already in the file store stay.</p>', kv: [['Owner', esc((sel.owner && (sel.owner.name || sel.owner.username)) || '')], ['Schedule', esc(sel.schedule.description)]], ok: 'Delete subscription' });
        if (!ok) return;
        // Gone from the screen at once, so a reload that lands meanwhile does not ask for its history.
        st.gone = st.gone || {}; st.gone[sel.id] = true; st.sel = null;
        try { await App.del(base); reload('Deleted ' + esc(sel.name) + '. Audited app.subscription.deleted.', 'warn'); }
        catch (err) { delete st.gone[sel.id]; st.sel = sel.id; ctx.rerender(); App.fail(err, 'The subscription was not deleted'); }
      });
    }
  });
})();
