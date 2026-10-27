(function () {
  /*
   * 1.9.9-qa (QA-1): User stores › a cloud directory store (Entra ID through Graph, Google Workspace through the
   * Directory API) › "Import users". A dry run first (counts, a per-user list), then the run that names it, with the
   * job's progress. Hooks into directories.js through App.storeImportButton and App.storeImportHandlers.
   */
  const { UI, esc } = App;

  const hasDirectory = (sel) => !!(sel && sel.kind === 'oidc' && sel.config && sel.config.directory && sel.state !== 'archived');
  const ACTION = { create: ['will be created', 'ok'], link: ['linked to an account here', 'info'], existing: ['already linked', ''], disabled: ['disabled in the directory', 'warn'], no_mapped_group: ['no mapped group', 'warn'], conflict: ['username used by another store', 'danger'], refused: ['beyond your roles', 'danger'], error: ['error', 'danger'] };
  const COUNTS = [['users', 'Directory users'], ['create', 'To create'], ['link', 'To link'], ['existing', 'Already linked'], ['disabled', 'Disabled, not created'], ['noMappedGroup', 'No mapped group'], ['conflict', 'Username conflicts'], ['refused', 'Beyond your roles'], ['error', 'Errors']];

  App.storeImportButton = function (sel) {
    return hasDirectory(sel) ? UI.btn('Import users', { size: 'sm', kind: 'ghost', icon: 'download', attrs: 'data-dimport' }) : '';
  };

  App.storeImportHandlers = function (ctx, h) {
    const sel = h.sel;
    if (!hasDirectory(sel)) return;
    ctx.on('click', '[data-dimport]', () => open(ctx, sel, h.reload));
  };

  function summaryHtml(sum, dry) {
    const rows = COUNTS.filter(([k]) => k === 'users' || sum[k]).map(([k, label]) => [esc(label), '<span class="num">' + esc(String(sum[k] || 0)) + '</span>']);
    if (!dry) rows.push(['Accounts made or linked', '<span class="num">' + esc(String(sum.applied || 0)) + '</span>']);
    return UI.kv(rows, 2);
  }

  function reportHtml(report) {
    if (!report || !report.length) return '';
    const shown = report.slice(0, 50);
    return '<div class="eyebrow">Accounts' + (report.length > shown.length ? ' (first ' + shown.length + ' of ' + report.length + ')' : '') + '</div>'
      + UI.table(['Username', 'Outcome', 'Roles'], shown.map((r) => { const a = ACTION[r.action] || [r.action, '']; return { cells: ['<span class="mono">' + esc(r.username) + '</span>', UI.pill(r.outcome || a[0], a[1]) + (r.detail ? '<div class="muted" style="font-size:12px">' + esc(r.detail) + '</div>' : ''), esc((r.roles || []).join(', '))] }; }), { minWidth: '0', clickable: false, emptyTitle: '', emptyText: '' });
  }

  function open(ctx, sel, reload) {
    const st = { dry: null, run: null, busy: false, error: null };
    let timer = null;
    let mounted = null;
    const base = '/api/admin/identity-providers/' + encodeURIComponent(sel.id) + '/directory-imports';
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };

    const paint = () => {
      if (!mounted || !document.contains(mounted)) { stop(); return; }
      const cur = st.run || st.dry;
      let body = UI.notice('Reads every user of the directory and their groups, and makes their accounts here as a first sign-in would: roles, clearance and workspaces from the group mappings. Accounts disabled in the directory are not created. A dry run comes first and changes nothing.', 'info');
      if (st.error) body += UI.notice(esc(st.error), 'danger');
      if (cur) {
        const running = cur.state === 'queued' || cur.state === 'running';
        const label = cur.dryRun ? 'Dry run' : 'Import';
        body += UI.meter(running ? label + ' running' : cur.state === 'failed' ? label + ' failed' : label + ' finished', (cur.message ? cur.message + ', ' : '') + (cur.progress || 0) + '%', cur.progress || 0, cur.state === 'failed' ? 'danger' : 'accent');
        if (cur.state === 'failed' && cur.error) body += UI.notice(esc(cur.error), 'danger');
        if (cur.summary && !running) body += summaryHtml(cur.summary, cur.dryRun) + reportHtml(cur.report);
      }
      const dryDone = st.dry && st.dry.state === 'succeeded';
      const toMake = dryDone ? (st.dry.summary.create || 0) + (st.dry.summary.link || 0) : 0;
      const running = cur && (cur.state === 'queued' || cur.state === 'running');
      const runDone = st.run && st.run.state === 'succeeded';
      const actions = UI.btn('Close', { attrs: 'data-close' })
        + (runDone ? '' : UI.btn(st.dry ? 'Dry run again' : 'Dry run', { kind: dryDone ? 'ghost' : 'primary', attrs: 'data-didry' + (running || st.busy ? ' disabled' : '') }))
        + (dryDone && !st.run ? UI.btn(toMake ? 'Import ' + toMake + ' account' + (toMake === 1 ? '' : 's') : 'Nothing to import', { kind: 'primary', attrs: 'data-dirun' + (!toMake || running || st.busy ? ' disabled' : '') }) : '');
      mounted.querySelector('[data-dibody]').innerHTML = body;
      mounted.querySelector('[data-diactions]').innerHTML = actions;
    };

    const poll = (which) => {
      stop();
      timer = setTimeout(async () => {
        try {
          const r = await App.get(base + '/' + encodeURIComponent(st[which].id));
          st[which] = r;
          if (r.state === 'queued' || r.state === 'running') poll(which);
          else if (which === 'run' && r.state === 'succeeded') { ctx.toast('Import finished: ' + (r.summary.applied || 0) + ' accounts made or linked. Audit entries written.', 'ok'); }
        } catch (err) { st.error = err.message; }
        paint();
      }, 700);
    };

    const submit = async (which, body) => {
      st.busy = true; st.error = null; paint();
      try {
        const r = await App.post(base, body);
        st[which] = { id: r.id, jobId: r.jobId, state: 'queued', progress: 0, dryRun: which === 'dry' };
        if (which === 'dry') st.run = null;
        poll(which);
      } catch (err) { st.error = (err.problem && err.problem.detail) || err.message; }
      st.busy = false; paint();
    };

    ctx.modal({ cls: 'wide', title: 'Import users from ' + esc(sel.name),
      body: '<div class="vstack gap12" data-dibody></div>',
      actions: '<span class="hstack wrap gap6" data-diactions style="justify-content:flex-end;width:100%"></span>',
      onMount(m) {
        mounted = m;
        m.addEventListener('click', (e) => {
          const t = e.target.closest ? e.target.closest('button') : null;
          if (!t || t.disabled) return;
          if (t.hasAttribute('data-didry')) submit('dry', { dryRun: true });
          if (t.hasAttribute('data-dirun')) submit('run', { dryRun: false, fromDryRun: st.dry.id });
        });
        paint();
        // The latest dry run of this store from the last day, if one finished: the run can start from it.
        App.get(base).then((r) => {
          const last = (r.imports || [])[0];
          if (r.available === false) { st.error = 'The directory import is not available on this server yet (its database migration has not been applied).'; paint(); return; }
          if (last && last.dryRun && Date.now() - last.createdAt < 23 * 3600000) return App.get(base + '/' + encodeURIComponent(last.id)).then((d) => { st.dry = d; if (d.state === 'queued' || d.state === 'running') poll('dry'); paint(); });
        }).catch(() => undefined);
      },
      onClose() { stop(); mounted = null; if (st.run) reload(); } });
  }
})();
