// Guardrails, the Term lists section (1.9.0, B-156): the tenant's named deny and allow lists of words, phrases and
// domains, shared by every rule set; their versions, entries, a live test with the normalised matches, CSV import
// with a dry run (duplicates and invalid rows) and CSV export. `guardrails.js` calls App.guardrailTerms(ctx, deps) for
// the markup; it registers its own handlers. State lives in ctx.state.gtl. App.guardrailTermLists(st, later) loads
// the lists for the rule editor's term-list mechanism.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const BASE = '/api/admin/guardrails/term-lists';
  const MATCH = [{ value: 'word', label: 'whole word' }, { value: 'substring', label: 'anywhere in a word' }, { value: 'domain', label: 'domain and subdomains' }];
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const CSS = '#main .gtl-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}@media (min-width:1100px){#main .gtl-cols{grid-template-columns:minmax(0,2fr) minmax(0,3fr)}}#main .gtl-mark{background:var(--warn-bg);color:inherit;border-radius:2px}#main .gtl-text{white-space:pre-wrap;overflow-wrap:anywhere}';
  const toLines = (entries) => entries.map((e) => (e.match === 'word' ? e.value : e.value + ',' + e.match)).join('\n');
  const fromLines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^(.*?),\s*(word|substring|domain)$/i.exec(l); return m ? { value: m[1].trim(), match: m[2].toLowerCase() } : { value: l, match: 'word' }; });

  App.guardrailTermLists = function (st, later) {
    if (st.termLists || st.termListsLoading) return st.termLists || [];
    st.termListsLoading = true;
    App.get(BASE).then((x) => { st.termLists = x; }).catch(() => { st.termLists = []; }).finally(() => { st.termListsLoading = false; later(); });
    return [];
  };

  App.guardrailTerms = function (ctx, deps) {
    const st = ctx.state;
    const s = st.gtl || (st.gtl = {});
    const toast = (m, k) => ctx.toast('<span>' + m + '</span>', k || 'ok', 5000);
    const load = () => {
      s.loading = true;
      App.get(BASE).then((x) => { s.lists = x; st.termLists = x; s.error = null; if (s.sel && !x.some((l) => l.id === s.sel)) { s.sel = null; s.detail = null; } if (!s.sel && x.length) s.sel = x[0].id; return s.sel ? loadOne(s.sel, s.version) : null; })
        .catch((err) => { s.error = err; }).finally(() => { s.loading = false; deps.later(); });
    };
    const loadOne = (id, version) => App.get(BASE + '/' + enc(id) + (version ? '?version=' + version : '')).then((x) => { s.detail = x; });
    if (!s.lists && !s.loading && !s.error) load();
    let html = '<style>' + CSS + '</style>';
    if (s.error) {
      ctx.on('click', '[data-gtl-reload]', () => { s.error = null; load(); ctx.rerender(); });
      return html + UI.problem('Term lists could not be loaded', s.error.message, s.error.problem && s.error.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-gtl-reload' }) + '</div>';
    }
    if (!s.lists) return html + UI.notice('Loading…', 'info');

    const lists = s.lists;
    const table = UI.table(['List', 'Kind', { label: 'Entries', right: true }, 'Version', 'Used by'], lists.map((l) => ({
      cells: ['<b>' + esc(l.name) + '</b>' + (l.description ? '<div class="muted" style="font-size:12px">' + esc(l.description) + '</div>' : ''), UI.pill(l.kind, l.kind === 'deny' ? 'danger' : 'ok'), String(l.entries), 'v' + l.latestVersion, l.usedBy.length ? esc(l.usedBy.map((u) => u.rule).slice(0, 3).join(', ')) + (l.usedBy.length > 3 ? ' and ' + (l.usedBy.length - 3) + ' more' : '') : '<span class="muted">no rule</span>'],
      attrs: 'data-gtl-sel="' + esc(l.id) + '"', selected: l.id === s.sel
    })), { minWidth: '520px', emptyTitle: 'No term lists yet', emptyText: 'A list of words, phrases or domains, shared by every rule set of the tenant. Rules use it with the term-list mechanism.' });
    const left = UI.panel('Term lists', '<p class="muted" style="font-size:12px;margin:0">Matching ignores case, accents, full-width letters, Cyrillic and Greek lookalikes, leetspeak (4 and @ for a, 3 for e, 0 for o, 1 for i and l, 5 and $ for s), zero-width characters and letters split by spaces or dots. A domain matches its subdomains.</p>' + table, { actions: UI.btn('New term list', { size: 'sm', kind: 'primary', attrs: 'data-gtl-new', icon: 'plus' }) });

    const d = s.detail && s.detail.id === s.sel ? s.detail : null;
    let right = '';
    if (s.sel && !d) right = UI.panel('Term list', UI.notice('Loading…', 'info'));
    else if (d) {
      const shown = d.entries.slice(0, 200);
      const test = s.test && s.test.id === d.id ? s.test : null;
      const marked = (text, hits) => { let out = ''; let pos = 0; hits.slice().sort((a, b) => a.start - b.start).forEach((h) => { if (h.start < pos) return; out += esc(text.slice(pos, h.start)) + '<mark class="gtl-mark">' + esc(text.slice(h.start, h.end)) + '</mark>'; pos = h.end; }); return out + esc(text.slice(pos)); };
      right = UI.panel(esc(d.name) + ' v' + d.version, UI.kv([['Kind', d.kind === 'deny' ? 'deny: a rule fires on its entries' : 'allow: a rule fires on hosts not on it'], ['Entries', String(d.entries.length)], ['Latest', 'v' + d.latestVersion], ['Used by', d.usedBy.length ? esc(d.usedBy.map((u) => u.rule + ' in ' + u.set + (u.version === 'latest' ? '' : ' (pinned to v' + u.version + ')')).join('; ')) : 'no rule']], 2)
        + UI.field('Version', UI.select(d.versions.map((v) => ({ value: String(v.version), label: 'v' + v.version + ' · ' + v.count + ' entries · ' + when(v.created_at) + (v.note ? ' · ' + v.note : '') })), String(d.version), 'data-gtl-ver'))
        + UI.table(['Entry', 'Matches'], shown.map((e) => [esc(e.value), esc((MATCH.find((m) => m.value === e.match) || { label: e.match }).label)]), { clickable: false, minWidth: '0', emptyTitle: 'No entries', emptyText: 'Edit the entries or import a CSV.' })
        + (d.entries.length > shown.length ? '<div class="muted" style="font-size:12px">The first ' + shown.length + ' of ' + d.entries.length + ' entries. Export the CSV for all of them.</div>' : '')
        + '<div class="eyebrow">Try it</div>' + UI.field('Sample text', UI.textarea(test ? test.text : '', { rows: 2, attrs: 'data-gtl-sample', placeholder: 'for example: fr33 m0ney at s.p.a.m.example' }))
        + '<div>' + UI.btn('Test v' + d.version, { size: 'sm', attrs: 'data-gtl-test' }) + '</div>'
        + '<div aria-live="polite">' + (test ? (test.problem ? UI.notice(esc(test.problem), 'danger') : '<div class="gtl-text">' + marked(test.text, test.result.hits) + '</div><div class="muted" style="font-size:12px">' + test.result.hits.length + ' match' + (test.result.hits.length === 1 ? '' : 'es') + (test.result.hits.length ? ': ' + esc(test.result.hits.map((h) => h.entry).filter((x, i, a) => a.indexOf(x) === i).join(', ')) : '') + ' · ' + test.result.ms + ' ms</div>') : '') + '</div>',
        { actions: '<span class="hstack wrap gap6">' + UI.btn('Edit entries', { size: 'sm', attrs: 'data-gtl-edit' }) + UI.btn('Import CSV', { size: 'sm', attrs: 'data-gtl-import' }) + UI.btn('Export CSV', { size: 'sm', attrs: 'data-gtl-export' }) + UI.btn('Description', { size: 'sm', kind: 'ghost', attrs: 'data-gtl-desc' }) + UI.btn('Delete', { size: 'sm', kind: 'ghost', attrs: 'data-gtl-del', disabled: d.usedBy.length > 0, title: d.usedBy.length ? 'Rules use this list' : '' }) + '</span>' });
    }
    html += '<div class="gtl-cols">' + left + (right || '') + '</div>';

    // ---- handlers ----
    const changed = (msg) => { if (msg) toast(msg); st.termLists = null; load(); };
    ctx.on('click', 'tr.row[data-gtl-sel]', (e, t) => { s.sel = t.dataset.gtlSel; s.version = null; s.detail = null; loadOne(s.sel).catch((err) => App.fail(err)).finally(deps.later); ctx.rerender(); });
    ctx.on('change', '[data-gtl-ver]', (e, t) => { s.version = Number(t.value); loadOne(s.sel, s.version).catch((err) => App.fail(err)).finally(deps.later); });
    ctx.on('click', '[data-gtl-test]', () => {
      const text = ctx.$('[data-gtl-sample]').value;
      if (!text.trim()) { toast('Write a sample text first.', 'warn'); return; }
      App.post(BASE + '/' + enc(d.id) + '/test', { text: text, version: d.version }).then((r) => { s.test = { id: d.id, text: text, result: r }; }).catch((err) => { s.test = { id: d.id, text: text, problem: err.message }; }).finally(deps.later);
    });
    ctx.on('click', '[data-gtl-new]', () => ctx.modal({ cls: 'wide', title: 'New term list',
      body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-n', placeholder: 'for example spam-words' }), 'Lower-case letters, digits and hyphens.') + UI.field('Kind', UI.select([{ value: 'deny', label: 'deny: rules fire on its entries' }, { value: 'allow', label: 'allow: rules fire on hosts not on it' }], 'deny', 'data-k')) + '</div>'
        + UI.field('Description', UI.input('', { attrs: 'data-de' }))
        + UI.field('Entries', UI.textarea('', { rows: 6, attrs: 'data-e class="textarea mono"', placeholder: 'one per line; add ,substring or ,domain to match differently' }), 'The kind is fixed once the list exists; the entries are versioned.')
        + '<div data-err aria-live="polite"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create', { kind: 'primary', attrs: 'data-ok' }),
      onMount(m) {
        m.querySelector('[data-ok]').addEventListener('click', () => {
          const body = { name: m.querySelector('[data-n]').value.trim(), kind: m.querySelector('[data-k]').value, entries: fromLines(m.querySelector('[data-e]').value) };
          const de = m.querySelector('[data-de]').value.trim(); if (de) body.description = de;
          App.post(BASE, body).then((x) => { App.closeOverlay(); s.sel = x.id; s.detail = null; changed('Term list ' + esc(x.name) + ' created with ' + x.entries + ' entr' + (x.entries === 1 ? 'y' : 'ies') + (x.duplicates.length ? ', ' + x.duplicates.length + ' duplicate' + (x.duplicates.length === 1 ? '' : 's') + ' left out' : '') + '.'); })
            .catch((err) => { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Refused') + '.</b> ' + esc(err.message), 'danger'); });
        });
      } }));
    ctx.on('click', '[data-gtl-edit]', () => ctx.modal({ cls: 'wide', title: 'Edit entries of ' + esc(d.name),
      body: (d.entries.length > 5000 ? UI.notice('This list has more than 5,000 entries: edit it through a CSV import.', 'warn') : '')
        + UI.field('Entries', UI.textarea(d.entries.length > 5000 ? '' : toLines(d.entries), { rows: 12, attrs: 'data-e class="textarea mono"' }), 'One per line; add ,substring or ,domain to match differently. Saving writes v' + (d.latestVersion + 1) + '.')
        + UI.field('Note', UI.input('', { attrs: 'data-no', placeholder: 'what changed' })) + '<div data-err aria-live="polite"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save as v' + (d.latestVersion + 1), { kind: 'primary', attrs: 'data-ok', disabled: d.entries.length > 5000 }),
      onMount(m) {
        m.querySelector('[data-ok]').addEventListener('click', () => {
          const body = { entries: fromLines(m.querySelector('[data-e]').value) }; const no = m.querySelector('[data-no]').value.trim(); if (no) body.note = no;
          App.put(BASE + '/' + enc(d.id) + '/entries', body).then((r) => { App.closeOverlay(); s.version = null; s.detail = null; changed(esc(d.name) + ' v' + r.version + ' saved with ' + r.entries + ' entries. Rules on latest use it now; pinned rules keep their version.'); })
            .catch((err) => { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Refused') + '.</b> ' + esc(err.message), 'danger'); });
        });
      } }));
    ctx.on('click', '[data-gtl-import]', () => {
      let checked = false;
      ctx.modal({ cls: 'wide', title: 'Import entries into ' + esc(d.name),
        body: '<p class="fg2" style="margin:0">A <span class="mono">value</span> column and an optional <span class="mono">match</span> (word, substring or domain), or one entry per line. At most 50,000 entries. Check it first: nothing changes until you import.</p>'
          + UI.field('CSV file', '<input type="file" accept=".csv,text/csv,text/plain" class="input" data-file>')
          + UI.field('Or paste the CSV', UI.textarea('', { rows: 6, attrs: 'data-csv class="textarea mono"' }))
          + UI.field('Mode', UI.select([{ value: 'replace', label: 'replace: the CSV is the next version' }, { value: 'append', label: 'append: add to v' + d.latestVersion }], 'replace', 'data-mode'))
          + '<div data-report aria-live="polite" class="vstack" style="gap:8px"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Check', { attrs: 'data-check' }) + UI.btn('Import', { kind: 'primary', attrs: 'data-import', disabled: true }),
        onMount(m) {
          const area = m.querySelector('[data-csv]'); const out = m.querySelector('[data-report]'); const imp = m.querySelector('[data-import]'); const mode = m.querySelector('[data-mode]');
          const reset = () => { checked = false; imp.disabled = true; };
          m.querySelector('[data-file]').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) f.text().then((t) => { area.value = t; reset(); }); });
          area.addEventListener('input', reset); mode.addEventListener('change', reset);
          const url = (dry) => BASE + '/' + enc(d.id) + '/import?mode=' + mode.value + (dry ? '&dryRun=true' : '');
          m.querySelector('[data-check]').addEventListener('click', () => {
            if (!area.value.trim()) { out.innerHTML = UI.notice('Choose a file or paste the CSV first.', 'warn'); return; }
            App.guardrailCsvPost(url(true), area.value).then((r) => {
              checked = !r.overLimit && !r.invalidCount; imp.disabled = !checked;
              out.innerHTML = UI.notice(r.rows + ' row' + (r.rows === 1 ? '' : 's') + ' read: the new version would hold ' + r.entries + ' entr' + (r.entries === 1 ? 'y' : 'ies') + (mode.value === 'append' ? ' (' + r.added + ' added)' : '') + '; ' + r.duplicateCount + ' duplicate' + (r.duplicateCount === 1 ? '' : 's') + ' and ' + r.invalidCount + ' invalid row' + (r.invalidCount === 1 ? '' : 's') + '.' + (r.overLimit ? ' That is over the limit of ' + r.max.toLocaleString() + ' entries.' : r.invalidCount ? ' Fix the invalid rows and check again.' : ''), checked ? 'info' : 'warn')
                + (r.invalid.length ? UI.table(['Row', 'Value', 'Why'], r.invalid.slice(0, 20).map((x) => [String(x.row), esc(x.value), esc(x.reason)]), { clickable: false, minWidth: '0' }) : '')
                + (r.duplicates.length ? '<div class="muted" style="font-size:12px">Duplicates (after normalisation): ' + esc(r.duplicates.slice(0, 20).map((x) => x.value + (x.row > 0 ? ' (row ' + x.row + ')' : '')).join(', ')) + '</div>' : '');
            }).catch((err) => { out.innerHTML = UI.problem('The CSV could not be read', err.message); });
          });
          imp.addEventListener('click', () => {
            if (!checked) return;
            imp.disabled = true;
            App.guardrailCsvPost(url(false), area.value).then((r) => { App.closeOverlay(); s.version = null; s.detail = null; changed(esc(d.name) + ' v' + r.version + ' imported with ' + r.entries + ' entries. Audit entry written.'); }).catch((err) => { imp.disabled = false; out.innerHTML = UI.problem('Not imported', err.message); });
          });
        } });
    });
    ctx.on('click', '[data-gtl-export]', () => {
      fetch(BASE + '/' + enc(d.id) + '/export?version=' + d.version, { credentials: 'same-origin' })
        .then((r) => { if (!r.ok) throw new Error('Export failed (' + r.status + ')'); return r.blob(); })
        .then((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = d.name + '-v' + d.version + '.csv'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); toast('Exported ' + esc(d.name) + ' v' + d.version + '. Audit entry written.'); })
        .catch((err) => App.fail(err, 'Not exported'));
    });
    ctx.on('click', '[data-gtl-desc]', () => ctx.modal({ title: 'Description of ' + esc(d.name), body: UI.field('Description', UI.input(d.description || '', { attrs: 'data-de' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-ok' }),
      onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const v = m.querySelector('[data-de]').value.trim(); App.patch(BASE + '/' + enc(d.id), { description: v || null }).then(() => { App.closeOverlay(); s.detail = null; changed('Description saved.'); }).catch((err) => App.fail(err)); }); } }));
    ctx.on('click', '[data-gtl-del]', async () => {
      const ok = await ctx.confirm({ title: 'Delete term list', tag: 'delete', tone: 'danger', body: '<p class="fg2" style="margin:0">' + esc(d.name) + ' and its ' + d.latestVersion + ' version' + (d.latestVersion === 1 ? '' : 's') + ' are deleted. No rule uses it. The deletion is audited.</p>', ok: 'Delete' });
      if (!ok) return;
      App.del(BASE + '/' + enc(d.id)).then(() => { s.sel = null; s.detail = null; changed('Term list deleted.'); }).catch((err) => App.fail(err));
    });
    return html;
  };
})();
