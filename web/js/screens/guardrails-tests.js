// Guardrails, the Tests tab (1.9.0, B-155): a rule set's test cases, the run button, each case's result, and what
// changed since the previous run. Cases come from the form, from CSV (checked first with a dry run), from recorded
// decisions where the set's rules fired, and from a finished shadow replay's hits. Publishing, approving and promoting
// are refused while a case fails (409); `guardrails.js` opens this tab then. It calls App.guardrailTests(ctx, set,
// deps) for the markup, and the function registers its own handlers; the state lives in ctx.state.gt[set.id].
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const EXPECT = [{ value: 'pass', label: 'pass: no rule fires' }, { value: 'block', label: 'block or hold' }, { value: 'annotate', label: 'annotate: log, warn or flag' }, { value: 'redact', label: 'redact' }];
  const CHECKPOINTS = ['user-input', 'context', 'tool-call', 'model-output', 'image', 'context-transfer', 'memory', 'script', 'db-query', 'media', 'export', 'untrusted-content'];
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const TRIGGER = { change: 'after a change', manual: 'run by hand', publish: 'before publishing', approve: 'before approval', promote: 'before a promotion' };
  const CSS = '#main .gt-diff{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px}#main .gt-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}#main .gt-pick{display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow:auto}#main .gt-pick .row{border:1px solid var(--line);border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:4px}';

  App.guardrailTests = function (ctx, d, deps) {
    const st = ctx.state;
    st.gt = st.gt || {};
    const base = '/api/admin/guardrails/sets/' + enc(d.id) + '/tests';
    const s = st.gt[d.id] || (st.gt[d.id] = {});
    const load = () => {
      s.loading = true;
      App.get(base).then((x) => { s.data = x; s.error = null; }).catch((err) => { s.error = err; }).finally(() => { s.loading = false; deps.later(); });
    };
    if (!s.data && !s.loading && !s.error) load();
    const rules = deps.rules || [];
    const locked = deps.locked;
    const toast = (m, k) => ctx.toast('<span>' + m + '</span>', k || 'ok', 5000);

    let html = '<style>' + CSS + '</style>';
    if (s.error) return html + UI.problem('The tests could not be loaded', s.error.message, s.error.problem && s.error.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-gt-reload' }) + bindReload();
    if (!s.data) return html + UI.notice('Loading…', 'info');

    const cases = s.data.cases;
    const run = s.data.lastRun;
    const byId = {};
    (run ? run.results : []).forEach((r) => { byId[r.id] = r; });
    const nameOf = (id) => { const c = cases.find((x) => x.id === id); return c ? c.name || 'Case ' + id.slice(-6) : 'a removed case'; };
    const failing = run ? run.results.filter((r) => !r.ok) : [];

    const actions = UI.btn('Run tests', { kind: 'primary', size: 'sm', attrs: 'data-gt-run', disabled: !cases.length || s.running })
      + UI.btn('Add case', { size: 'sm', attrs: 'data-gt-add', disabled: locked })
      + UI.btn('Import CSV', { size: 'sm', attrs: 'data-gt-csv', disabled: locked })
      + UI.btn('From recorded decisions', { size: 'sm', attrs: 'data-gt-decisions', disabled: locked })
      + UI.btn('From replay hits', { size: 'sm', attrs: 'data-gt-replay', disabled: locked || !(deps.replay && deps.replay.result), title: deps.replay && deps.replay.result ? '' : 'Run a shadow replay of this set first (Rules tab)' });

    let summary;
    if (!cases.length) summary = UI.empty('No test cases yet', 'Add texts that must pass and texts that must be blocked. Publishing, approving and promoting then wait until every case passes.');
    else if (!run) summary = UI.notice('No run yet. Cases run after every change of the draft, before publishing, and when you run them here.', 'info');
    else {
      const df = run.diff;
      const parts = [];
      if (df.nowFailing.length) parts.push('<span><b>Now failing:</b> ' + esc(df.nowFailing.map(nameOf).join(', ')) + '</span>');
      if (df.nowPassing.length) parts.push('<span><b>Now passing:</b> ' + esc(df.nowPassing.map(nameOf).join(', ')) + '</span>');
      if (df.previous && df.added.length) parts.push('<span><b>New cases:</b> ' + df.added.length + '</span>');
      if (df.removed.length) parts.push('<span><b>Removed cases:</b> ' + df.removed.length + '</span>');
      const rc = df.rules;
      const ruleBits = [rc.added.length ? 'added ' + rc.added.join(', ') : '', rc.removed.length ? 'removed ' + rc.removed.join(', ') : '', rc.changed.length ? 'changed ' + rc.changed.map((c) => c.id + ' (' + c.fields.join(', ') + ')').join(', ') : ''].filter(Boolean);
      if (df.previous && ruleBits.length) parts.push('<span><b>Rules:</b> ' + esc(ruleBits.join('; ')) + '</span>');
      summary = UI.notice('<b>' + run.passed + ' of ' + run.total + ' passed</b>' + (run.failed ? ', ' + run.failed + ' failing' : '') + ' against v' + esc(String(run.version || '?')) + ', ' + esc(TRIGGER[run.trigger] || run.trigger) + ' at ' + esc(when(run.createdAt)) + '.' + (run.failed ? ' Publishing, approving and promoting are refused until every case passes.' : ''), run.failed ? 'danger' : 'ok')
        + '<div class="eyebrow">Since the previous run' + (df.previous ? ' (' + esc(when(df.previous.at)) + ', ' + df.previous.passed + ' passed, ' + df.previous.failed + ' failing)' : '') + '</div>'
        + (df.previous ? (parts.length ? '<div class="gt-diff">' + parts.join('') + '</div>' : '<div class="muted" style="font-size:12px">No case changed its result and no rule changed.</div>') : '<div class="muted" style="font-size:12px">This is the first run.</div>');
    }

    const ctxText = (c) => [c.context.checkpoint || (c.ruleId && (rules.find((r) => r.id === c.ruleId) || {}).checkpoint) || 'user-input', c.label, c.context.surface, c.context.channel, c.context.role, c.context.accountAgeDays != null ? c.context.accountAgeDays + ' days old' : null, c.context.newAccount ? 'new account' : null].filter(Boolean).join(' · ');
    const result = (c) => {
      const r = byId[c.id];
      if (!r) return '<span class="muted">not run yet</span>';
      return (r.ok ? UI.pill('passes', 'ok') : UI.pill('fails', 'danger')) + (r.reason ? '<div style="font-size:12px;color:var(--danger-fg)">' + esc(r.reason) + '</div>' : '') + (r.fired.length ? '<div class="muted" style="font-size:12px">Fired: ' + esc(r.fired.map((f) => f.ruleId + ' (' + f.action + ')').join(', ')) + '</div>' : '');
    };
    const table = !cases.length ? '' : UI.table(['Case', 'Expect', 'Context', 'Result', ''], cases.map((c) => [
      '<b>' + esc(c.name || 'Case ' + c.id.slice(-6)) + '</b><div class="gt-text">' + (c.hidden ? '<span class="muted">Labelled ' + esc(c.label) + ', above your clearance</span>' : esc(c.text.length > 160 ? c.text.slice(0, 160) + '…' : c.text)) + '</div>',
      UI.pill(c.expect, c.expect === 'pass' ? 'ok' : c.expect === 'block' ? 'danger' : 'warn') + (c.ruleId ? ' <span class="mono" style="font-size:12px">' + esc(c.ruleId) + '</span>' : ''),
      '<span style="font-size:12px">' + esc(ctxText(c)) + '</span>' + (c.source !== 'manual' ? ' ' + UI.pill(c.source, 'outline') : ''),
      result(c),
      '<span class="hstack gap6">' + UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-gt-edit="' + esc(c.id) + '" aria-label="Edit ' + esc(c.name || 'case') + '"', disabled: locked || c.hidden }) + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-gt-del="' + esc(c.id) + '" aria-label="Remove ' + esc(c.name || 'case') + '"', disabled: locked }) + '</span>'
    ]), { clickable: false, minWidth: '640px' });

    const firstFail = failing.find((r) => r.fired.some((f) => f.explain));
    const explain = firstFail ? '<div class="eyebrow">Why ' + esc(nameOf(firstFail.id)) + ' fired</div>' + firstFail.fired.filter((f) => f.explain).map((f) => '<div style="font-size:12px"><b>' + esc(f.ruleName) + '</b>' + App.guardrailConditions.explain(f.explain) + '</div>').join('') : '';

    html += UI.panel('Tests for ' + esc(d.name), summary + table + explain, { actions: '<span class="hstack wrap gap6">' + actions + '</span>' });

    // ---- handlers ----
    function bindReload() { ctx.on('click', '[data-gt-reload]', () => { s.error = null; load(); ctx.rerender(); }); return '</div>'; }
    const done = (msg) => { if (msg) toast(msg); load(); };
    ctx.on('click', '[data-gt-run]', () => {
      s.running = true; ctx.rerender();
      App.post(base + '/run', {}).then((r) => { toast('Ran ' + r.total + ' case' + (r.total === 1 ? '' : 's') + ': ' + r.passed + ' passed, ' + r.failed + ' failing.', r.failed ? 'warn' : 'ok'); }).catch((err) => App.fail(err, 'Tests not run')).finally(() => { s.running = false; load(); });
    });
    ctx.on('click', '[data-gt-add]', () => caseDialog(null));
    ctx.on('click', '[data-gt-edit]', (e, t) => caseDialog(cases.find((c) => c.id === t.dataset.gtEdit)));
    ctx.on('click', '[data-gt-del]', async (e, t) => {
      const c = cases.find((x) => x.id === t.dataset.gtDel);
      const ok = await ctx.confirm({ title: 'Remove test case', tag: 'remove', tone: 'warn', body: '<p class="fg2" style="margin:0">' + esc(c.name || 'This case') + ' is removed from ' + esc(d.name) + '. The removal is audited.</p>', ok: 'Remove' });
      if (!ok) return;
      App.del(base + '/' + enc(c.id)).then(() => done('Test case removed.')).catch((err) => App.fail(err));
    });

    function caseDialog(c) {
      const cx = (c && c.context) || { label: 'internal' };
      const ruleOpts = [{ value: '', label: 'Any rule' }].concat(rules.map((r) => ({ value: r.id, label: r.name + ' (' + r.checkpoint + ', ' + r.action + ')' })));
      ctx.modal({ cls: 'wide', title: c ? 'Edit test case' : 'Add a test case to ' + esc(d.name),
        body: '<div class="formgrid">' + UI.field('Name', UI.input(c ? c.name || '' : '', { attrs: 'data-n', placeholder: 'for example casino spam is blocked' }))
          + UI.field('Expect', UI.select(EXPECT, c ? c.expect : 'block', 'data-x'))
          + UI.field('Rule that must fire', UI.select(ruleOpts, c && c.ruleId ? c.ruleId : '', 'data-r'), 'Left as any rule, the set\'s strongest action decides. A case that must pass names no rule.')
          + UI.field('Checkpoint', UI.select([{ value: '', label: 'The rule\'s own, else user input' }].concat(CHECKPOINTS.map((x) => ({ value: x, label: x }))), cx.checkpoint || '', 'data-cp'))
          + UI.field('Label', UI.select(LABELS, cx.label || 'internal', 'data-l'), 'Only people cleared for it read the text.')
          + UI.field('Surface', UI.input(cx.surface || '', { attrs: 'data-su', placeholder: 'feed, chat, group-post…' }))
          + UI.field('Channel', UI.input(cx.channel || '', { attrs: 'data-ch' }))
          + UI.field('Role', UI.input(cx.role || '', { attrs: 'data-ro', placeholder: 'member' }))
          + UI.field('Account age in days', UI.input(cx.accountAgeDays == null ? '' : String(cx.accountAgeDays), { type: 'number', attrs: 'data-ag min="0"' }))
          + '</div>' + UI.check('New account', !!cx.newAccount, 'data-nw')
          + UI.field('Text', UI.textarea(c ? c.text || '' : '', { rows: 4, attrs: 'data-t' }), 'Sealed at rest. Harmful examples are expected here.')
          + '<div data-err aria-live="polite"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(c ? 'Save' : 'Add case', { kind: 'primary', attrs: 'data-ok' }),
        onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', () => {
            const v = (sel) => m.querySelector(sel).value.trim();
            const context = { label: v('[data-l]') };
            if (v('[data-cp]')) context.checkpoint = v('[data-cp]');
            if (v('[data-su]')) context.surface = v('[data-su]');
            if (v('[data-ch]')) context.channel = v('[data-ch]');
            if (v('[data-ro]')) context.role = v('[data-ro]');
            if (v('[data-ag]') !== '') context.accountAgeDays = Number(v('[data-ag]'));
            if (m.querySelector('[data-nw]').checked) context.newAccount = true;
            const expect = v('[data-x]');
            const body = { text: m.querySelector('[data-t]').value, expect: expect, context: context, ruleId: expect === 'pass' || !v('[data-r]') ? null : v('[data-r]') };
            if (v('[data-n]')) body.name = v('[data-n]'); else if (c) body.name = null;
            if (!body.text.trim()) { m.querySelector('[data-err]').innerHTML = UI.notice('Write the text to test.', 'warn'); return; }
            const p = c ? App.api('PATCH', base + '/' + enc(c.id), body) : App.post(base, Object.assign({}, body, { name: body.name || undefined, ruleId: body.ruleId || undefined }));
            p.then(() => { App.closeOverlay(); done(c ? 'Test case saved. Audit entry written.' : 'Test case added. Run the tests to see its result.'); }).catch((err) => { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Refused') + '.</b> ' + esc(err.message), 'danger'); });
          });
        } });
    }

    ctx.on('click', '[data-gt-csv]', () => {
      let checked = null;
      ctx.modal({ cls: 'wide', title: 'Import test cases from CSV',
        body: '<p class="fg2" style="margin:0">A header naming <span class="mono">text</span> and <span class="mono">expect</span>, and any of <span class="mono">name, rule, checkpoint, label, surface, channel, role, account_age_days, new_account</span>. Check it first: nothing is added by a check.</p>'
          + UI.field('CSV file', '<input type="file" accept=".csv,text/csv" class="input" data-file>')
          + UI.field('Or paste the CSV', UI.textarea('', { rows: 6, attrs: 'data-csv class="textarea mono"' }))
          + '<div data-report aria-live="polite" class="vstack" style="gap:8px"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Check', { attrs: 'data-check' }) + UI.btn('Import', { kind: 'primary', attrs: 'data-import', disabled: true }),
        onMount(m) {
          const area = m.querySelector('[data-csv]'); const out = m.querySelector('[data-report]'); const imp = m.querySelector('[data-import]');
          m.querySelector('[data-file]').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; f.text().then((t) => { area.value = t; checked = null; imp.disabled = true; }); });
          area.addEventListener('input', () => { checked = null; imp.disabled = true; });
          const send = (dry) => App.guardrailCsvPost(base + '/import/csv' + (dry ? '?dryRun=true' : ''), area.value);
          m.querySelector('[data-check]').addEventListener('click', () => {
            if (!area.value.trim()) { out.innerHTML = UI.notice('Choose a file or paste the CSV first.', 'warn'); return; }
            send(true).then((r) => {
              checked = r; imp.disabled = !r.valid;
              out.innerHTML = UI.notice(r.valid + ' case' + (r.valid === 1 ? '' : 's') + ' would be added; ' + r.invalid.length + ' invalid row' + (r.invalid.length === 1 ? '' : 's') + ', ' + r.duplicates.length + ' duplicate' + (r.duplicates.length === 1 ? '' : 's') + '.', r.valid ? 'info' : 'warn')
                + (r.invalid.length ? UI.table(['Row', 'Why'], r.invalid.slice(0, 20).map((x) => [x.row ? String(x.row) : '', esc(x.reason)]), { clickable: false, minWidth: '0' }) : '')
                + (r.duplicates.length ? '<div class="muted" style="font-size:12px">Duplicates: ' + esc(r.duplicates.slice(0, 20).map((x) => 'row ' + x.row + ' repeats ' + x.of).join('; ')) + '</div>' : '');
            }).catch((err) => { out.innerHTML = UI.problem('The CSV could not be read', err.message); });
          });
          imp.addEventListener('click', () => {
            if (!checked) return;
            imp.disabled = true;
            send(false).then((r) => { App.closeOverlay(); done(r.added.length + ' case' + (r.added.length === 1 ? '' : 's') + ' imported. Audit entry written.'); }).catch((err) => { imp.disabled = false; out.innerHTML = UI.problem('Not imported', err.message); });
          });
        } });
    });

    ctx.on('click', '[data-gt-decisions]', () => {
      App.get(base + '/decisions').then((list) => {
        ctx.modal({ cls: 'wide', title: 'Test cases from recorded decisions',
          body: '<p class="fg2" style="margin:0">Checks of the last 7 days in which a rule of ' + esc(d.name) + ' fired, at or below your clearance. A case keeps the decision\'s label. Mark a false positive as pass.</p>'
            + (list.length ? '<div class="gt-pick" role="list">' + list.map((x, i) => '<div class="row" role="listitem">' + UI.check(when(x.at) + ' · ' + x.checkpoint + ' · ' + x.label + ' · ' + x.rules.map((r) => r.ruleId + ' (' + r.action + (r.stage === 'shadow' ? ', shadow' : '') + ')').join(', '), false, 'data-pick="' + i + '"') + '<div class="gt-text">' + esc(x.excerpt) + '</div>' + UI.field('Expect', UI.select([{ value: 'hit', label: 'what the rule did' }, { value: 'pass', label: 'pass (a false positive)' }], 'hit', 'data-pexp="' + i + '"')) + '</div>').join('') + '</div>' : UI.empty('Nothing recorded', 'No rule of this set fired in the last 7 days.')),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Import selected', { kind: 'primary', attrs: 'data-ok', disabled: !list.length }),
          onMount(m) {
            const ok = m.querySelector('[data-ok]');
            ok.addEventListener('click', () => {
              const picks = [];
              list.forEach((x, i) => {
                if (!m.querySelector('[data-pick="' + i + '"]').checked) return;
                const r = x.rules[0]; const exp = m.querySelector('[data-pexp="' + i + '"]').value;
                const cat = r.action === 'block' || r.action === 'require-approval' ? 'block' : r.action === 'redact' ? 'redact' : 'annotate';
                picks.push(exp === 'pass' ? { id: x.id, expect: 'pass' } : { id: x.id, expect: cat, ruleId: r.ruleId });
              });
              if (!picks.length) { ctx.toast('Pick at least one decision.', 'warn'); return; }
              App.post(base + '/import/decisions', { decisions: picks }).then((r) => { App.closeOverlay(); done(r.added.length + ' case' + (r.added.length === 1 ? '' : 's') + ' imported' + (r.skipped.length ? ', ' + r.skipped.length + ' skipped (' + esc(r.skipped[0].reason) + ')' : '') + '.'); }).catch((err) => App.fail(err, 'Not imported'));
            });
          } });
      }).catch((err) => App.fail(err, 'Decisions could not be loaded'));
    });

    ctx.on('click', '[data-gt-replay]', async () => {
      const rp = deps.replay;
      if (!rp || !rp.result) return;
      const hits = rp.result.rules.reduce((a, r) => a + (r.hits ? r.hits.length : 0), 0);
      const ok = await ctx.confirm({ title: 'Test cases from replay hits', tag: 'import', tone: 'info', body: '<p class="fg2" style="margin:0">The replay of v' + rp.version + ' found ' + hits + ' recorded check' + (hits === 1 ? '' : 's') + ' its rules would act on. Up to 20 become cases that expect what each rule does; those above your clearance or already cases are skipped.</p>', ok: 'Import' });
      if (!ok) return;
      App.post(base + '/import/replay', { jobId: rp.jobId }).then((r) => done(r.added.length + ' case' + (r.added.length === 1 ? '' : 's') + ' imported' + (r.skipped.length ? ', ' + r.skipped.length + ' skipped' : '') + '.')).catch((err) => App.fail(err, 'Not imported'));
    });
    return html;
  };

  /** POSTs a CSV body (App.api always sends JSON); problem details come back as App.ApiError. */
  App.guardrailCsvPost = function (url, text) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'text/csv', Accept: 'application/json', 'X-CSRF-Token': App.state.csrf || '' }, body: text })
      .then((r) => r.json().catch(() => ({ status: r.status, title: r.statusText })).then((b) => { if (!r.ok) throw new App.ApiError(b); return b; }));
  };

  /** Refreshes a set's tests after something outside the tab ran them (a refused publish). */
  App.guardrailTestsReload = function (st, setId) { if (st.gt && st.gt[setId]) st.gt[setId] = {}; };
})();
