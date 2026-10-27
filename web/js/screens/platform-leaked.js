// Platform › Leaked passwords (1.9.0, Sprint 55: B-192 to B-195). A tab the Platform screen (platform.js) shows
// through App.platformLeaked.render(ctx, st).
//
// - Lists: the platform's (platform:manage) or this tenant's own (identity:manage): name, hash kind, source, the
//   active version's size and date. Add a list, upload a version (HIBP "hash:count", one hash per line, or plain text,
//   hashed on the server as it streams in and never stored), mirror the HIBP corpus into a platform list (an explicit
//   action, rate-limited and resumable), make a version active (replace or roll back), turn a list off, delete it.
// - This tenant: what a sign-in with a newly listed password does (warn, require a change, block), whether new
//   passwords are accepted when a check cannot run (fail open) or refused (fail closed), the deny words, and the
//   report of accounts found at sign-in and whether they changed their password since.
//
// Every check is the server's; a person is only ever told "found in a leaked list", never which list.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const CSS = '<style>#main .pleak-actions{display:flex;flex-wrap:wrap;gap:6px}#main .pleak-wrap{overflow-wrap:anywhere}#main .pleak-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}#main .pleak-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:8px}</style>';
  const STATE_TONE = { ready: 'ok', failed: 'danger', building: 'info', queued: 'info', staging: 'info', mirroring: 'info' };
  const ACTION_LABEL = { warn: 'Warn the person', require_change: 'Require a change (default)', block: 'Block the sign-in' };
  const FORMATS = [{ value: 'hibp', label: 'HIBP "hash:count" (ordered by hash)' }, { value: 'hashes', label: 'One hash per line' }, { value: 'plain', label: 'Plain text, one password per line' }];
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Something went wrong.';
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || null;
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const count = (n) => (n == null ? '' : Number(n).toLocaleString());
  const bytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' kB' : (n || 0) + ' B');
  const BASE = '/api/admin/leaked-passwords';

  function load(ctx, st) {
    const p = st.leaked;
    if (p.loading) return;
    p.loading = true;
    const tenant = p.scope === 'tenant';
    Promise.all([
      App.get(BASE + '/lists?scope=' + enc(p.scope)),
      tenant ? App.get(BASE + '/settings') : Promise.resolve(null),
      tenant ? App.get(BASE + '/report') : Promise.resolve(null)
    ])
      .then((r) => { p.data = r[0]; p.settings = r[1]; p.report = r[2]; p.error = null; p.loaded = true; })
      .catch((err) => { p.error = err; p.loaded = true; })
      .then(() => { p.loading = false; if (App.state.route === 'platform' && !document.getElementById('overlay')) ctx.rerender(); });
  }

  function reload(ctx, st) { st.leaked.loaded = false; ctx.rerender(); }

  // ---------- dialogs ----------

  function addModal(ctx, st) {
    const p = st.leaked;
    ctx.modal({
      title: p.scope === 'platform' ? 'Add a platform list' : 'Add a list for this tenant',
      body: '<div class="pleak-grid">' + UI.field('Name', UI.input('', { attrs: 'data-la-name maxlength="100" autocomplete="off"', placeholder: 'Pwned Passwords' }))
        + UI.field('Hash', UI.select([{ value: 'sha1', label: 'SHA-1 (HIBP, most lists)' }, { value: 'ntlm', label: 'NTLM (Windows)' }], 'sha1', 'data-la-kind')) + '</div>'
        + UI.field('Description (optional)', UI.input('', { attrs: 'data-la-desc maxlength="500"' }))
        + '<div data-la-err role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add list', { kind: 'primary', attrs: 'data-la-ok' }),
      onMount(m) {
        m.querySelector('[data-la-ok]').addEventListener('click', async () => {
          const err = m.querySelector('[data-la-err]');
          const name = m.querySelector('[data-la-name]').value.trim();
          if (!name) { err.innerHTML = UI.notice('Give the list a name.', 'warn'); return; }
          try {
            await App.post(BASE + '/lists', { scope: p.scope, name, hashKind: m.querySelector('[data-la-kind]').value, description: m.querySelector('[data-la-desc]').value.trim() || null });
            App.closeOverlay(); ctx.toast('List added. Upload a version to start checking against it. Audit event passwords.list.created written.', 'ok', 6000); reload(ctx, st);
          } catch (e) { err.innerHTML = UI.notice(esc(detailOf(e)), 'danger'); }
        });
      }
    });
  }

  function uploadModal(ctx, st, l) {
    ctx.modal({
      title: 'Upload a version of ' + esc(l.name),
      body: UI.notice('A plain-text list is hashed on the server as it streams in; the passwords themselves are never stored or logged. Duplicates are removed. Larger lists: <span class="mono">exprsn-ai passwords:import</span>.', 'info')
        + '<div class="pleak-grid">' + UI.field('Format', UI.select(FORMATS, 'hibp', 'data-lu-format')) + UI.field('Note (optional)', UI.input('', { attrs: 'data-lu-note maxlength="500"' })) + '</div>'
        + UI.field('List file', '<input type="file" class="input" accept=".txt,.csv,text/plain" data-lu-file>')
        + '<div style="margin-top:8px">' + UI.toggle('Make it the active version once built', true, 'data-lu-activate') + '</div>'
        + '<div data-lu-err role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Upload', { kind: 'primary', attrs: 'data-lu-ok' }),
      onMount(m) {
        const tg = m.querySelector('[data-lu-activate]');
        tg.addEventListener('click', () => { const on = tg.getAttribute('aria-checked') !== 'true'; tg.setAttribute('aria-checked', on ? 'true' : 'false'); tg.classList.toggle('on', on); });
        m.querySelector('[data-lu-ok]').addEventListener('click', async () => {
          const err = m.querySelector('[data-lu-err]'); err.innerHTML = '';
          const file = m.querySelector('[data-lu-file]').files[0];
          if (!file) { err.innerHTML = UI.notice('Choose the list file.', 'warn'); return; }
          const q = ['format=' + enc(m.querySelector('[data-lu-format]').value), 'activate=' + (tg.getAttribute('aria-checked') === 'true' ? 'true' : 'false')];
          const note = m.querySelector('[data-lu-note]').value.trim(); if (note) q.push('note=' + enc(note));
          try {
            const res = await fetch(BASE + '/lists/' + enc(l.id) + '/upload?' + q.join('&'), { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': 'application/octet-stream', Accept: 'application/json' } });
            const out = await res.json().catch(() => ({}));
            if (!res.ok) { err.innerHTML = UI.notice('<b>' + esc(String(res.status)) + '</b> ' + esc(out.detail || out.title || 'Upload refused'), 'danger'); return; }
            App.closeOverlay();
            ctx.toast('Version ' + esc(out.version.version) + ': ' + esc(count(out.lines)) + ' lines read, ' + esc(count(out.invalid)) + ' invalid. It is being built (job ' + esc(out.jobId) + '). Audit event passwords.list.uploaded written.', 'ok', 8000);
            reload(ctx, st);
          } catch (e) { err.innerHTML = UI.notice(esc(detailOf(e)), 'danger'); }
        });
      }
    });
  }

  async function versionsModal(ctx, st, l) {
    let d;
    try { d = await App.get(BASE + '/lists/' + enc(l.id)); } catch (err) { App.fail(err, 'Could not read the versions'); return; }
    const rows = d.versions.map((v) => [
      'v' + esc(v.version) + (v.version === d.activeVersion ? ' ' + UI.pill('active', 'ok') : ''),
      UI.pill(v.state, STATE_TONE[v.state] || 'outline') + (v.mirror && v.state !== 'ready' ? '<div class="muted" style="font-size:12px">' + esc(count(v.mirror.cursor)) + ' of ' + esc(count(v.mirror.total)) + ' ranges</div>' : '') + (v.error ? '<div class="muted pleak-wrap" style="font-size:12px">' + esc(v.error) + '</div>' : ''),
      esc(v.source === 'hibp-mirror' ? 'HIBP mirror' : v.format) + (v.note ? '<div class="muted pleak-wrap" style="font-size:12px">' + esc(v.note) + '</div>' : ''),
      esc(count(v.entries)) + (v.duplicates ? '<div class="muted" style="font-size:12px">' + esc(count(v.duplicates)) + ' duplicates</div>' : ''),
      v.state === 'ready' ? esc((v.bloom.falsePositiveRate * 100).toFixed(2) + '%') : '',
      esc(day(v.builtAt || v.createdAt)),
      '<span class="pleak-actions">' + (v.state === 'ready' && v.version !== d.activeVersion ? UI.btn(v.version < (d.activeVersion || 0) ? 'Roll back to this' : 'Make active', { size: 'xs', attrs: 'data-lv-act="' + esc(v.version) + '"' }) : '') + (v.version !== d.activeVersion && v.state !== 'building' && v.state !== 'mirroring' ? UI.btn('Delete', { size: 'xs', kind: 'ghost', attrs: 'data-lv-del="' + esc(v.version) + '"' }) : '') + '</span>'
    ]);
    ctx.modal({
      title: 'Versions of ' + esc(l.name),
      cls: 'wide',
      body: UI.table(['Version', 'State', 'Source', 'Hashes', 'Bloom false positives', 'Built', ''], rows, { clickable: false, minWidth: '720px', emptyTitle: 'No versions', emptyText: 'Upload a list to make the first version.', attrs: 'aria-label="Versions"' }) + '<div data-lv-err role="alert"></div>',
      actions: UI.btn('Close', { attrs: 'data-close' }),
      onMount(m) {
        const err = m.querySelector('[data-lv-err]');
        m.addEventListener('click', async (ev) => {
          const act = ev.target.closest('[data-lv-act]');
          const del = ev.target.closest('[data-lv-del]');
          try {
            if (act) { await App.post(BASE + '/lists/' + enc(l.id) + '/versions/' + enc(act.dataset.lvAct) + '/activate', {}); App.closeOverlay(); ctx.toast('Version ' + esc(act.dataset.lvAct) + ' is now active. Audit event passwords.list.activated written.', 'ok'); reload(ctx, st); }
            if (del) { await App.del(BASE + '/lists/' + enc(l.id) + '/versions/' + enc(del.dataset.lvDel)); App.closeOverlay(); ctx.toast('Version ' + esc(del.dataset.lvDel) + ' deleted. Audit event passwords.list.version.deleted written.', 'ok'); reload(ctx, st); }
          } catch (e) { err.innerHTML = UI.notice(esc(detailOf(e)), 'danger'); }
        });
      }
    });
  }

  // ---------- the tenant's settings ----------

  function settingsPanel(p) {
    const s = p.settings || {};
    return UI.panel('Checks for this tenant', '<p class="fg2" style="margin-top:0">Every password set, reset, imported or set by an admin is checked against the platform\'s lists, this tenant\'s lists and, where <span class="mono">BREACHED_PASSWORDS</span> allows, the HIBP range API. At sign-in, a password is checked against the lists added since it was last checked.</p>'
      + '<div class="pleak-grid">'
      + UI.field('A sign-in with a newly listed password', UI.select(['require_change', 'warn', 'block'].map((v) => ({ value: v, label: ACTION_LABEL[v] })), s.signinAction || 'require_change', 'data-ls-action'), 'Require a change signs the person in once and asks for a new password.')
      + UI.field('When a check cannot run', UI.select([{ value: 'open', label: 'Accept the password (fail open, default)' }, { value: 'closed', label: 'Refuse the password (fail closed)' }], s.failMode || 'open', 'data-ls-fail'), 'Either way, the miss is audited.')
      + '</div>'
      + UI.field('Deny words, one per line', UI.textarea((s.denyWords || []).join('\n'), { attrs: 'data-ls-words spellcheck="false"', rows: 4, placeholder: 'Your organisation\'s name, products, places' }), 'Refused anywhere inside a password, whatever the case, accents, leetspeak (4 for a, 3 for e) or spacing. At most 200.')
      + '<div class="pleak-actions" style="margin-top:8px">' + UI.btn('Save', { kind: 'primary', size: 'sm', attrs: 'data-ls-save' }) + '</div>');
  }

  function reportPanel(p) {
    const r = p.report || { checked: 0, flagged: 0, changed: 0, accounts: [] };
    const rows = r.accounts.map((a) => [esc(a.displayName || a.username) + '<div class="muted mono" style="font-size:12px">' + esc(a.username) + '</div>', esc(day(a.flaggedAt)), esc(ACTION_LABEL[a.action] ? a.action.replace('_', ' ') : a.action || ''), a.changedAt ? UI.pill('changed ' + day(a.changedAt), 'ok') : UI.pill('not changed', 'warn')]);
    return UI.panel('Accounts found at sign-in', '<div class="pleak-stats">' + UI.stat(esc(count(r.checked)), 'Accounts checked') + UI.stat(esc(count(r.flagged)), 'Found on a list') + UI.stat(esc(count(r.changed)), 'Changed since') + '</div>'
      + UI.table(['Person', 'Found', 'Action', 'Password'], rows, { clickable: false, minWidth: '520px', emptyTitle: 'Nobody found', emptyText: 'No sign-in has used a password from a leaked list.', attrs: 'aria-label="Accounts found at sign-in"' }));
  }

  // ---------- render ----------

  function render(ctx, st) {
    const canPlatform = App.can('platform:manage');
    const canTenant = App.can('identity:manage');
    st.leaked = st.leaked || { scope: canPlatform ? 'platform' : 'tenant' };
    const p = st.leaked;
    if (!p.loaded) { load(ctx, st); return '<p class="muted">Loading the leaked-password lists…</p>'; }
    if (p.error) {
      ctx.on('click', '[data-leak-retry]', () => { p.loaded = false; p.error = null; ctx.rerender(); });
      return UI.problem('The leaked-password lists could not be loaded', detailOf(p.error), traceOf(p.error)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-leak-retry' }) + '</div>';
    }
    const d = p.data || { lists: [], installed: false };
    const scopes = [].concat(canPlatform ? [{ id: 'platform', label: 'Platform lists' }] : [], canTenant ? [{ id: 'tenant', label: 'This tenant' }] : []);
    const installed = d.installed !== false;
    const rows = d.lists.map((l) => [
      '<b class="pleak-wrap">' + esc(l.name) + '</b>' + (l.description ? '<div class="muted pleak-wrap" style="font-size:12px">' + esc(l.description) + '</div>' : ''),
      esc(l.hashKind === 'ntlm' ? 'NTLM' : 'SHA-1'),
      esc(l.source === 'hibp-mirror' ? 'HIBP mirror' : l.source),
      l.activeVersion ? 'v' + esc(l.activeVersion) + ' of ' + esc(l.latestVersion) : '<span class="muted">none yet</span>',
      esc(count(l.activeEntries)),
      esc(day(l.updatedAt)),
      l.enabled ? UI.pill('checked', 'ok') : UI.pill('off', 'outline'),
      '<div class="pleak-actions">' + UI.btn('Upload', { size: 'sm', attrs: 'data-lup="' + esc(l.id) + '"' }) + (p.scope === 'platform' ? UI.btn('Mirror HIBP', { size: 'sm', attrs: 'data-lmirror="' + esc(l.id) + '"' }) : '') + UI.btn('Versions', { size: 'sm', attrs: 'data-lver="' + esc(l.id) + '"' }) + UI.btn(l.enabled ? 'Turn off' : 'Turn on', { size: 'sm', attrs: 'data-ltoggle="' + esc(l.id) + '"' }) + UI.btn('Delete', { size: 'sm', kind: 'danger', attrs: 'data-ldel="' + esc(l.id) + '"' }) + '</div>'
    ]);
    const lists = UI.panel(p.scope === 'platform' ? 'Platform lists' : 'This tenant\'s lists',
      (p.scope === 'platform' ? '<p class="fg2" style="margin-top:0">Checked for every tenant. A person is only told a password was found in a leaked list, never which one.</p>' : '<p class="fg2" style="margin-top:0">Checked for this tenant only, with the platform\'s ' + esc(count(d.platformLists || 0)) + ' list(s).</p>')
      + UI.table(['List', 'Hash', 'Source', 'Active', 'Hashes', 'Updated', 'State', ''], rows, { clickable: false, minWidth: '900px', emptyTitle: 'No lists', emptyText: 'Without lists, new passwords are checked as BREACHED_PASSWORDS says, as before.', attrs: 'aria-label="Leaked-password lists"' })
      + (installed ? '<div class="pleak-actions" style="margin-top:8px">' + UI.btn('Add a list', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-ladd' }) + '</div>' : ''),
      { actions: UI.btn('Refresh', { size: 'sm', attrs: 'data-lrefresh' }) });

    // ----- handlers -----
    const find = (id) => d.lists.find((x) => x.id === id);
    ctx.on('click', '[data-lscope]', (e, t) => { p.scope = t.dataset.lscope; reload(ctx, st); });
    ctx.on('click', '[data-lrefresh]', () => reload(ctx, st));
    ctx.on('click', '[data-ladd]', () => addModal(ctx, st));
    ctx.on('click', '[data-lup]', (e, t) => { const l = find(t.dataset.lup); if (l) uploadModal(ctx, st, l); });
    ctx.on('click', '[data-lver]', (e, t) => { const l = find(t.dataset.lver); if (l) versionsModal(ctx, st, l); });
    ctx.on('click', '[data-lmirror]', async (e, t) => {
      const l = find(t.dataset.lmirror); if (!l) return;
      const ok = await ctx.confirm({ title: 'Mirror the HIBP corpus into ' + l.name, body: '<p class="fg2" style="margin:0">This fetches every one of the 1,048,576 ranges of the Pwned Passwords range API, at the rate <span class="mono">LEAKED_MIRROR_RPS</span> allows, into a new version (about 40 GB of hashes in the blob store). It can take a day; a stopped mirror resumes where it stopped.</p>', ok: 'Start the mirror' });
      if (!ok) return;
      try { const r = await App.post(BASE + '/lists/' + enc(l.id) + '/mirror', {}); ctx.toast('Mirror of version ' + esc(r.version.version) + ' queued (job ' + esc(r.jobId) + '). Audit event passwords.list.mirror.started written.', 'ok', 7000); reload(ctx, st); }
      catch (err) { App.fail(err, 'The mirror did not start'); }
    });
    ctx.on('click', '[data-ltoggle]', async (e, t) => {
      const l = find(t.dataset.ltoggle); if (!l) return;
      try { await App.patch(BASE + '/lists/' + enc(l.id), { enabled: !l.enabled }); ctx.toast((l.enabled ? 'Turned off: passwords are no longer checked against it. ' : 'Turned on. ') + 'Audit event passwords.list.updated written.', 'ok'); reload(ctx, st); }
      catch (err) { App.fail(err, 'Not changed'); }
    });
    ctx.on('click', '[data-ldel]', async (e, t) => {
      const l = find(t.dataset.ldel); if (!l) return;
      const ok = await ctx.confirm({ title: 'Delete ' + l.name, tone: 'danger', tag: 'destructive', body: '<p class="fg2" style="margin:0">Every version and its hashes are deleted. Passwords are no longer checked against this list.</p>', ok: 'Delete list' });
      if (!ok) return;
      try { await App.del(BASE + '/lists/' + enc(l.id)); ctx.toast('Deleted. Audit event passwords.list.deleted written.', 'ok'); reload(ctx, st); }
      catch (err) { App.fail(err, 'Not deleted'); }
    });
    ctx.on('click', '[data-ls-save]', async () => {
      const root = document.getElementById('main');
      const words = root.querySelector('[data-ls-words]').value.split('\n').map((w) => w.trim()).filter(Boolean);
      try {
        await App.put(BASE + '/settings', { signinAction: root.querySelector('[data-ls-action]').value, failMode: root.querySelector('[data-ls-fail]').value, denyWords: words });
        ctx.toast('Saved. Audit event passwords.settings.updated written.', 'ok'); reload(ctx, st);
      } catch (err) { App.fail(err, 'Not saved'); }
    });

    return CSS
      + (scopes.length > 1 ? '<div class="pleak-actions" role="group" aria-label="Which lists">' + scopes.map((sc) => UI.chip(esc(sc.label), sc.id === p.scope, 'data-lscope="' + sc.id + '"')).join('') + '</div>' : '')
      + (!installed ? UI.notice('<b>Leaked-password lists are not installed yet.</b> The database migration <span class="mono">131_leaked_password_lists</span> has not been applied; until it is, new passwords are checked as <span class="mono">BREACHED_PASSWORDS</span> says.', 'warn') : '')
      + lists
      + (p.scope === 'tenant' && installed ? settingsPanel(p) + reportPanel(p) : '');
  }

  App.platformLeaked = {
    tabs: [{ id: 'leaked', label: 'Leaked passwords' }],
    render
  };
}());
