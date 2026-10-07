(function () {
  const { UI, esc } = App;

  // 1.6.0, Sprint 35c (B-4205): Configuration, live. Every setting this build reads (the descriptor is generated from
  // server/src/config/index.ts), what each instance reads and where it came from, and database overrides under dual
  // control (decision Q2): one platform admin proposes, a second approves; hot settings apply at once, restart ones at
  // the next start of each instance. Secret values never reach the console: only set or unset, length and file.

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const when = (ms) => { if (!ms) return ''; const d = new Date(ms); return pad(d.getDate()) + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const srcKind = (s) => (s === 'override' ? 'accent' : s === 'file' ? 'info' : s === 'env' ? 'outline' : '');
  const valueText = (s) => (s.secret ? (s.value ? 'set, ' + s.chars + ' characters' + (s.file ? ', from file ' + s.file : ', from the environment') : 'unset') : s.value == null || s.value === '' ? 'unset' : s.value);
  const instValue = (p, secret) => (secret ? (p.value ? 'set, ' + p.chars + ' characters' : 'unset') : p.value == null || p.value === '' ? 'unset' : p.value);
  const ident = (p) => (p.fingerprint ? 'fp:' + p.fingerprint : 'v:' + (p.value == null ? '' : p.value));

  App.register({
    id: 'configuration', title: 'Configuration', section: 'admin', live: true, crumb: ['Admin', 'Configuration'],
    summary: 'Every setting this build reads, where its value comes from, whether the instances agree, and what a change needs',
    commands: [
      { label: 'Find a setting', sub: 'Configuration', run(app) { const s = app.stateFor('configuration'); s.focusSearch = true; app.render(); } },
      { label: 'Export settings as .env', sub: 'Configuration', run(app) { const s = app.stateFor('configuration'); s.openExport = true; app.render(); } }
    ],
    states: [
      { title: 'Instances disagree', tone: 'danger', text: 'When instances read different values for a setting, the filter chip, the row and the inspector show it.', apply(ctx) { const st = ctx.state; st.section = 'all'; st.query = ''; st.chips = { differs: true }; st.compare = true; const s = st.data && st.data.settings.find((x) => x.differs); if (s) st.sel = s.name; else ctx.toast('Every instance reads the same values.', 'ok'); ctx.rerender(); } },
      { title: 'Restart required', tone: 'warn', text: 'An approved override of a restart setting applies at the next start; a banner names the instances still running without it.', apply(ctx) { const st = ctx.state; st.section = 'all'; st.chips = {}; const r = st.data && st.data.restartRequired[0]; if (r) st.sel = r.name; else ctx.toast('No instance waits for a restart.', 'ok'); ctx.rerender(); } },
      { title: 'Overrides disabled', tone: 'neutral', text: 'With PLATFORM_SETTINGS_OVERRIDES=false, settings are managed in the environment: Propose override is replaced by a notice with the name to copy.', apply(ctx) { const st = ctx.state; if (st.data && st.data.overridesEnabled) ctx.toast('Overrides are on in this deployment (PLATFORM_SETTINGS_OVERRIDES).', '', 5000); ctx.rerender(); } },
      { title: 'Secret from file', tone: 'info', text: 'A secret shows its length, the file it came from and the file mode, never its value.', apply(ctx) { const st = ctx.state; st.section = 'all'; st.chips = {}; st.query = ''; const s = st.data && (st.data.settings.find((x) => x.secret && x.file) || st.data.settings.find((x) => x.name === 'DATA_KEY')); if (s) st.sel = s.name; if (s && !s.file) ctx.toast(s.name + ' comes from the environment here, not from a file.', '', 5000); ctx.rerender(); } },
      { title: 'Deprecated setting still set', tone: 'warn', text: 'DATA_KEY_PREVIOUS still set after a verified re-wrap is marked deprecated in the row and the inspector.', apply(ctx) { const st = ctx.state; st.section = 'all'; st.query = ''; st.chips = { deprecated: true }; const s = st.data && st.data.settings.find((x) => x.deprecated); if (s) st.sel = s.name; else ctx.toast('No deprecated setting is set.', 'ok'); ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (st.section == null) st.section = 'all';
      if (st.query == null) st.query = '';
      if (!st.chips) st.chips = {};
      if (location.hash !== st.paramsHash) {
        st.paramsHash = location.hash;
        if (ctx.params.q) { st.query = ctx.params.q; st.wantSel = ctx.params.q; st.section = 'all'; }
        if (ctx.params.section) st.section = ctx.params.section;
      }

      const refresh = () => {
        if (App.state.route !== 'configuration') return;
        if (document.getElementById('overlay')) { st.dirty = true; return; }
        ctx.rerender();
      };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        App.get('/api/admin/platform/settings').then((r) => { st.data = r; st.loaded = true; st.loadError = null; }).catch((err) => { st.loadError = err; }).finally(() => { st.loading = false; refresh(); });
      };
      if (!st.loaded && !st.loadError) load();
      const act = (p, ok, kind) => p.then((r) => { if (ok) ctx.toast(typeof ok === 'function' ? ok(r) : ok, kind || 'ok', 6000); load(); return r; }).catch((err) => { App.fail(err); load(); });
      const onClose = () => { if (st.dirty) { st.dirty = false; refresh(); } };

      if (!st.data) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Configuration', 'Every setting this build reads') + (st.loadError ? UI.problem('The settings could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-retry' }) + '</div>' : '<div class="muted">Loading…</div>') + '</div>';
        ctx.on('click', '[data-retry]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      const d = st.data; const all = d.settings;
      if (st.wantSel) { const m = all.find((s) => s.name.toLowerCase() === String(st.wantSel).toLowerCase()); if (m) st.sel = m.name; st.wantSel = null; }
      const live = d.instances.filter((i) => i.live);
      const q = st.query.trim().toLowerCase();
      const counts = {}; all.forEach((s) => { counts[s.section] = (counts[s.section] || 0) + 1; });
      const rows = all.filter((s) => (st.section === 'all' || s.section === st.section) && (!q || (s.name + ' ' + s.description + ' ' + s.section).toLowerCase().indexOf(q) >= 0)
        && (!st.chips.changed || s.changed) && (!st.chips.secrets || s.secret) && (!st.chips.restart || s.applies === 'restart') && (!st.chips.differs || s.differs) && (!st.chips.deprecated || s.deprecated));
      if (!rows.some((s) => s.name === st.sel)) st.sel = rows.length ? rows[0].name : null;
      const sel = all.find((s) => s.name === st.sel);
      const nChanged = all.filter((s) => s.changed).length, nDiffer = all.filter((s) => s.differs).length, nDep = all.filter((s) => s.deprecated).length;
      const chip = (id, label, n) => '<button type="button" class="chip' + (st.chips[id] ? ' on' : '') + '" data-chip="' + id + '" aria-pressed="' + (st.chips[id] ? 'true' : 'false') + '">' + esc(label) + (n != null ? ' <span class="muted">' + n + '</span>' : '') + '</button>';

      const left = '<div class="leftpane" role="navigation" aria-label="Sections"><div class="eyebrow" style="padding:4px 8px 0">Sections</div><div class="vstack" style="gap:1px">'
        + UI.listItem('All settings', all.length + ' read by this build', { active: st.section === 'all', attrs: 'data-section="all"' + (st.section === 'all' ? ' aria-current="true"' : '') })
        + d.sections.filter((s) => counts[s]).map((s) => UI.listItem(esc(s), counts[s] + (counts[s] === 1 ? ' setting' : ' settings'), { active: st.section === s, attrs: 'data-section="' + esc(s) + '"' + (st.section === s ? ' aria-current="true"' : '') })).join('') + '</div>'
        + '<span class="muted" style="font-size:11px;padding:0 8px">Sections group the settings the way docs/deploy.md does. Instances report what they read every few seconds.</span></div>';

      const banner = d.restartRequired.length ? UI.notice('<b>Restart required.</b> ' + d.restartRequired.map((r) => '<span class="mono">' + esc(r.name) + '</span> on ' + r.instances.map((i) => '<span class="mono">' + esc(i) + '</span>').join(', ')).join('; ') + ': the approved value is read at the next start. A rolling restart keeps the console up; this banner clears itself as each instance reports the new value.', 'warn', UI.btn('Check again', { size: 'sm', attrs: 'data-reload' })) : '';
      const pendingNote = d.pending.length ? UI.notice(d.pending.length + ' override' + (d.pending.length > 1 ? 's wait' : ' waits') + ' for a second platform admin: ' + d.pending.map((p) => '<a href="#" class="mono" data-pick="' + esc(p.name) + '">' + esc(p.name) + '</a>').join(', ') + '.', 'info') : '';
      const disabledNote = !d.overridesEnabled ? UI.notice('Settings are managed in the environment of this deployment (PLATFORM_SETTINGS_OVERRIDES=false). The values below are what each instance reads.', 'info') : '';

      const table = UI.table(['Setting', 'Value', 'Source', 'Applies', 'Description'], rows.map((s) => ({
        cells: ['<span class="mono" style="font-weight:600">' + esc(s.name) + '</span>' + (s.deprecated ? ' ' + UI.pill('deprecated', 'warn') : '') + (s.differs ? ' ' + UI.pill('instances differ', 'danger') : '') + (s.pending ? ' ' + UI.pill('override pending', 'info') : ''),
          s.secret ? '<span class="muted">' + esc(valueText(s)) + '</span>' : '<span class="mono" style="overflow-wrap:anywhere">' + esc(valueText(s)) + '</span>' + (s.changed ? '' : ' <span class="muted" style="font-size:11px">default</span>'),
          UI.pill(s.source, srcKind(s.source)), s.applies === 'hot' ? UI.pill('hot', 'ok') : UI.pill('restart', 'outline'), '<span class="fg2" style="font-size:12px">' + esc(s.description) + '</span>'],
        attrs: 'data-setting="' + esc(s.name) + '"', selected: s.name === st.sel
      })), { minWidth: '820px', emptyTitle: 'No setting matches', emptyText: 'Clear the search or the filter chips, or pick another section.' });

      const page = '<div class="page">' + UI.pagehead('Configuration', all.length + ' settings read by build ' + esc(d.build) + ' on ' + live.length + (live.length === 1 ? ' instance' : ' instances') + '. Secrets show their length and file, never their value.', UI.btn('Diff against defaults', { attrs: 'data-diff', icon: 'sort' }) + UI.btn('Export as .env', { attrs: 'data-export', icon: 'download' }))
        + banner + pendingNote + disabledNote
        + '<div class="toolbar">' + UI.search('Find by name or description', 'data-search', st.query) + chip('changed', 'Changed from default', nChanged) + chip('secrets', 'Secrets', all.filter((s) => s.secret).length) + chip('restart', 'Restart required', all.filter((s) => s.applies === 'restart').length) + chip('differs', 'Instances differ', nDiffer) + chip('deprecated', 'Deprecated', nDep) + '<span class="muted right" style="font-size:12px">' + rows.length + ' shown</span></div>'
        + table
        + '<span class="muted" style="font-size:12px">Source: <b>env</b> the process environment, <b>file</b> a <span class="mono">&lt;NAME&gt;_FILE</span> secret file, <b>default</b> the value in the build, <b>override</b> a change approved here. Applies: <b>hot</b> is read on the next use; <b>restart</b> waits for the instance to start again.</span></div>';

      let insp = '';
      if (sel) {
        const distinct = {}; sel.perInstance.forEach((p) => { distinct[ident(p)] = (distinct[ident(p)] || 0) + 1; });
        const majority = Object.keys(distinct).sort((a, b) => distinct[b] - distinct[a])[0];
        const perInstance = sel.perInstance.map((p) => { const off = sel.differs && ident(p) !== majority; const v = instValue(p, sel.secret); return ['<span class="mono">' + esc(p.instance) + '</span>', (st.compare && off ? '<span class="mono" style="background:var(--warn-bg);color:var(--warn-fg);padding:0 4px;border-radius:3px;overflow-wrap:anywhere">' + esc(v) + '</span>' : '<span class="mono" style="overflow-wrap:anywhere">' + esc(v) + '</span>') + ' <span class="muted" style="font-size:11px">' + esc(p.source) + '</span>' + (off ? ' ' + UI.pill('differs', 'danger') : '')]; });
        const pend = sel.pending;
        const offInstances = sel.differs ? sel.perInstance.filter((p) => ident(p) !== majority).map((p) => p.instance) : [];
        insp = '<div class="hstack"><div class="eyebrow grow">Selected setting</div>' + UI.pill(sel.source, srcKind(sel.source)) + (sel.applies === 'hot' ? UI.pill('hot', 'ok') : UI.pill('restart', 'outline')) + '</div>'
          + '<div class="mono" style="font-size:14px;font-weight:600;overflow-wrap:anywhere">' + esc(sel.name) + '</div><div class="fg2" style="font-size:12px">' + esc(sel.description) + '</div>'
          + (sel.deprecated ? UI.notice('<b>Deprecated.</b> ' + esc(sel.deprecated) + ' Unset it at the next restart.', 'warn') : '')
          + (sel.secret ? UI.notice('A secret: the console shows whether it is set, its length' + (sel.file ? ', its file and mode' : '') + ', never the value. Rotate it at the source and restart.', 'info') : '')
          + UI.kv([['Section', esc(sel.section)], ['Type', esc(sel.type) + (sel.constraint ? ', ' + esc(sel.constraint) : '')], ['Default', sel.default == null || sel.default === '' ? '<span class="muted">unset</span>' : '<span class="mono" style="overflow-wrap:anywhere">' + esc(sel.default) + '</span>'], ['Current value', sel.secret ? esc(valueText(sel)) : '<span class="mono" style="overflow-wrap:anywhere">' + esc(valueText(sel)) + '</span>'], ['Source', esc(sel.source) + (sel.file ? ', <span class="mono" style="font-size:11px">' + esc(sel.file) + '</span>' + (sel.mode ? ' mode ' + esc(sel.mode) : '') : '')], ['Since', sel.since ? esc(when(sel.since)) : '<span class="muted">the instance started</span>']], 1)
          + '<div class="hstack"><div class="eyebrow grow">Per instance</div>' + UI.btn(st.compare ? 'Stop comparing' : 'Compare instances', { size: 'xs', kind: 'ghost', attrs: 'data-compare aria-pressed="' + (st.compare ? 'true' : 'false') + '"' }) + '</div>'
          + (perInstance.length ? '<div style="overflow-wrap:anywhere">' + UI.kv(perInstance, 1) + '</div>' : '<span class="muted" style="font-size:12px">No instance has reported in the last few minutes.</span>')
          + (sel.differs ? UI.notice('The instances read different values. Fix the environment of ' + offInstances.map((i) => '<span class="mono">' + esc(i) + '</span>').join(', ') + ' and restart it' + (sel.overridable && d.overridesEnabled ? ', or approve an override so every instance reads the same' : '') + '.', 'danger') : '')
          + (sel.override && sel.override.waiting && sel.override.waiting.length ? UI.notice((sel.override.applies === 'restart' ? 'Waiting for a restart of ' : 'Being applied on ') + sel.override.waiting.map((i) => '<span class="mono">' + esc(i) + '</span>').join(', ') + '.', sel.override.applies === 'restart' ? 'warn' : 'info') : '')
          + '<div class="eyebrow">History</div>' + (sel.history.length ? UI.timeline(sel.history.map((h) => ({ title: h.action === 'clear' ? 'override removed' : '<span class="mono">' + esc(h.from == null ? 'unset' : h.from) + '</span> → <span class="mono">' + esc(h.to == null ? 'unset' : h.to) + '</span>', text: h.state + ': proposed by ' + esc(h.proposedBy || 'someone') + (h.decidedBy ? ', ' + (h.state === 'withdrawn' ? 'withdrawn' : 'decided by ' + esc(h.decidedBy)) : '') + (h.reason ? '. ' + esc(h.reason) : ''), meta: esc(when(h.at)), tone: h.state === 'approved' ? 'ok' : h.state === 'rejected' ? 'danger' : '' }))) : '<span class="muted" style="font-size:12px">No override recorded. Changes made in the environment leave no entry here; the deploy log has them.</span>')
          + (pend ? UI.notice('<b>' + (pend.action === 'clear' ? 'Removal of the override' : 'Override') + ' pending:</b> ' + (pend.action === 'clear' ? '' : '<span class="mono">' + esc(pend.value) + '</span> ') + 'proposed by ' + esc(pend.proposedBy || 'someone') + ', waiting for a second platform admin. ' + esc(pend.reason), 'info', pend.mine ? UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-withdraw="' + esc(pend.id) + '"' }) : UI.btn('Approve', { size: 'xs', attrs: 'data-approve="' + esc(pend.id) + '"' }) + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-reject="' + esc(pend.id) + '"' })) : '')
          + '<div class="hstack wrap gap6">' + UI.btn('Copy name', { size: 'sm', icon: 'copy', attrs: 'data-copyname' })
          + (d.overridesEnabled && sel.overridable ? UI.btn('Propose override', { kind: 'primary', size: 'sm', icon: 'edit', attrs: 'data-propose', disabled: !!pend }) + (sel.override ? UI.btn('Propose removal', { size: 'sm', attrs: 'data-unset', disabled: !!pend }) : '') : '') + '</div>'
          + (!d.overridesEnabled ? UI.notice('Settings are managed in the environment of this deployment. Copy the name, change it where the instances are deployed, and restart if the setting needs it.', 'info')
            : !sel.overridable ? UI.notice('Not overridable here: ' + esc(sel.fixedReason || 'it is read before the overrides.'), 'info')
              : '<span class="muted" style="font-size:12px">An override needs a second platform admin. A hot setting applies at once; a restart setting waits for the next start and the banner names the instances.</span>');
      }

      root.innerHTML = left + page + (insp ? '<aside class="inspector w360" aria-label="Setting details">' + insp + '</aside>' : '');
      if (st.focusSearch) { st.focusSearch = false; const inp = ctx.$('input[data-search]'); if (inp && inp.focus) inp.focus(); }

      const exportEnv = () => App.get('/api/admin/platform/settings/export').then((r) => ctx.modal({ cls: 'wide', title: 'Export as .env ' + UI.pill('secrets masked', 'info'), body: '<p class="fg2" style="margin:0">Every setting with the value instance <span class="mono">' + esc(d.instance) + '</span> reads, in the order of the sections. Secrets are masked; a comment names their file.</p>' + UI.code(r.text, 'ini'), actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Copy', { kind: 'primary', attrs: 'data-copyenv' }), onMount(m) { m.querySelector('[data-copyenv]').addEventListener('click', () => { const done = () => { App.closeOverlay(); ctx.toast('Copied ' + r.lines + ' settings. Audit event platform.settings.exported written.', 'ok'); }; try { navigator.clipboard.writeText(r.text).then(done, done); } catch (e) { done(); } }); }, onClose })).catch((err) => App.fail(err, 'Export refused'));
      if (st.openExport) { st.openExport = false; setTimeout(exportEnv, 30); }

      ctx.on('click', '[data-section]', (e, t) => { st.section = t.dataset.section; ctx.rerender(); });
      ctx.on('input', 'input[data-search]', (e, t) => { st.query = t.value; ctx.rerender(); });
      ctx.on('click', '[data-chip]', (e, t) => { e.preventDefault(); st.chips[t.dataset.chip] = !st.chips[t.dataset.chip]; ctx.rerender(); });
      ctx.on('click', 'tr.row[data-setting]', (e, t) => { st.sel = t.dataset.setting; ctx.rerender(); });
      ctx.on('click', '[data-pick]', (e, t) => { e.preventDefault(); st.sel = t.dataset.pick; st.section = 'all'; st.query = ''; st.chips = {}; ctx.rerender(); });
      ctx.on('click', '[data-compare]', () => { st.compare = !st.compare; ctx.rerender(); });
      ctx.on('click', '[data-reload]', () => { load(); ctx.toast('Asked every instance again.', ''); });
      ctx.on('click', '[data-copyname]', () => { if (!sel) return; const done = () => ctx.toast('<span class="mono">' + esc(sel.name) + '</span> copied', 'ok'); try { navigator.clipboard.writeText(sel.name).then(done, done); } catch (e) { done(); } });
      ctx.on('click', '[data-export]', () => exportEnv());
      ctx.on('click', '[data-diff]', () => {
        const ch = all.filter((s) => s.changed);
        ctx.modal({ cls: 'wide', title: 'Diff against defaults ' + UI.pill(ch.length + ' changed', 'outline'), body: '<p class="fg2" style="margin:0">Only the settings whose value is not the build\'s default, as instance <span class="mono">' + esc(d.instance) + '</span> reads them. Lines marked - are the default, + the value read.</p>' + UI.code(ch.map((s) => '- ' + s.name + '=' + (s.secret || s.default == null ? '' : s.default) + '\n+ ' + s.name + '=' + (s.secret ? '******** (' + (s.file || 'environment') + ')' : s.value == null ? '' : s.value) + (s.differs ? '   # instances differ' : '')).join('\n') || '# every setting has its default', 'diff'), actions: UI.btn('Close', { attrs: 'data-close' }), onClose });
      });
      ctx.on('click', '[data-propose],[data-unset]', (e, t) => {
        if (!sel) return;
        const clear = t.hasAttribute('data-unset');
        const cur = sel.value == null ? '' : sel.value;
        const control = clear ? '' : UI.field('New value', sel.type === 'enum' && sel.options ? UI.select(sel.options.map((v) => ({ value: v, label: v })), cur, 'data-ov-value') : sel.type === 'boolean' ? UI.select([{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }], cur, 'data-ov-value') : UI.input(cur, { attrs: 'data-ov-value', placeholder: sel.constraint }), sel.constraint ? 'Must fit: ' + esc(sel.constraint) : '');
        ctx.drawer({ title: (clear ? 'Propose removing the override of ' : 'Propose override of ') + '<span class="mono">' + esc(sel.name) + '</span>',
          body: '<div class="vstack gap12">' + UI.notice('A second platform admin must approve. ' + (sel.applies === 'hot' ? 'The setting is hot: it applies as soon as it is approved.' : 'The setting needs a restart: approved, it waits for the next start of each instance.'), 'info')
            + UI.kv([['Type', esc(sel.type) + (sel.constraint ? ', ' + esc(sel.constraint) : '')], ['Current', '<span class="mono" style="overflow-wrap:anywhere">' + esc(valueText(sel)) + '</span>'], ['Default', sel.default == null || sel.default === '' ? 'unset' : '<span class="mono">' + esc(sel.default) + '</span>']].concat(clear ? [['After', 'what the environment gives']] : []), 1)
            + control
            + UI.field('Reason', UI.textarea('', { rows: 3, attrs: 'data-ov-reason aria-required="true"', placeholder: 'Why, and what it should change. Written to the audit chain with the proposal.' }), 'Required.') + '<div data-ov-problem role="alert"></div></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Submit for approval', { kind: 'primary', attrs: 'data-ov-submit' }),
          onMount(dr) {
            dr.querySelector('[data-ov-submit]').addEventListener('click', () => {
              const vEl = dr.querySelector('[data-ov-value]'); const v = vEl ? vEl.value.trim() : null; const r = dr.querySelector('[data-ov-reason]').value.trim(); const p = dr.querySelector('[data-ov-problem]');
              if (r.length < 3) { p.innerHTML = UI.notice('A reason of at least 3 characters is required.', 'danger'); return; }
              App.post('/api/admin/platform/settings/' + encodeURIComponent(sel.name) + '/proposals', { value: clear ? null : v, reason: r })
                .then(() => { App.closeOverlay(); ctx.toast((clear ? 'Removal of the override of ' : 'Override of ') + '<span class="mono">' + esc(sel.name) + '</span> proposed; waiting for a second platform admin. Audit event written.', '', 6000); load(); })
                .catch((err) => { const pr = err.problem || {}; p.innerHTML = UI.problem((pr.title || 'Refused') + (pr.status ? ' (' + pr.status + ')' : ''), pr.detail || err.message, pr.trace_id); });
            });
          },
          onClose });
      });
      ctx.on('click', '[data-approve]', (e, t) => {
        const s = all.find((x) => x.pending && x.pending.id === t.dataset.approve); if (!s) return; const p = s.pending;
        ctx.confirm({ title: 'Approve ' + (p.action === 'clear' ? 'removing the override of ' : 'override of ') + s.name, tag: 'dual control', tone: 'info', body: '<p class="fg2" style="margin:0">You are the second platform admin. ' + (s.applies === 'hot' ? 'The value applies on the next use, on every instance.' : 'The value is stored now and read at the next start of each instance.') + '</p>', kv: [['From', esc(valueText(s))], ['To', p.action === 'clear' ? 'what the environment gives' : '<span class="mono">' + esc(p.value) + '</span>'], ['Proposed by', esc(p.proposedBy || '')], ['Reason', esc(p.reason)]], ok: 'Approve' }).then((ok) => {
          if (!ok) return;
          act(App.post('/api/admin/platform/settings/proposals/' + encodeURIComponent(p.id) + '/approve', {}), (r) => esc(s.name) + (r.applies === 'hot' ? ' applied on every instance.' : ' stored; restart the instances to apply it.') + ' Audit event written.', s.applies === 'hot' ? 'ok' : 'warn');
        });
      });
      ctx.on('click', '[data-reject]', (e, t) => { const s = all.find((x) => x.pending && x.pending.id === t.dataset.reject); if (!s) return; ctx.confirm({ title: 'Reject the proposal for ' + s.name, tone: 'danger', tag: 'dual control', body: '<p class="fg2" style="margin:0">The value stays as it is. The proposer sees the rejection in the history.</p>', ok: 'Reject' }).then((ok) => { if (ok) act(App.post('/api/admin/platform/settings/proposals/' + encodeURIComponent(s.pending.id) + '/reject', {}), 'Proposal rejected. Audit event written.', ''); }); });
      ctx.on('click', '[data-withdraw]', (e, t) => act(App.post('/api/admin/platform/settings/proposals/' + encodeURIComponent(t.dataset.withdraw) + '/withdraw', {}), 'Proposal withdrawn. Audit event written.', ''));
    }
  });
})();
