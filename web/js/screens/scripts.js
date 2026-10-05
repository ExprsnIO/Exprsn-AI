(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const LANG = { python: 'Python', javascript: 'JavaScript (Node.js)' };
  const STATUS_TEXT = { draft: 'draft', tested: 'tested', in_review: 'in review', promoted: 'promoted tool' };
  const statusPill = (s) => UI.pill(STATUS_TEXT[s] || s, s === 'tested' ? 'ok' : s === 'promoted' || s === 'in_review' ? 'info' : '');
  const runPill = (s, exit) => UI.pill(s === 'succeeded' ? 'exit 0' : s === 'failed' && exit != null ? 'exit ' + exit : s === 'timeout' ? 'timed out' : s, s === 'succeeded' ? 'ok' : s === 'timeout' ? 'warn' : s === 'failed' ? 'danger' : 'info');
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const secs = (ms) => (ms == null ? '' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s');
  const shortId = (id) => String(id || '').slice(-6).toLowerCase();

  /** Templates for new scripts: each fills the source of a draft that then goes through the normal checks. */
  const TEMPLATES = [
    { name: 'CSV clean-up', language: 'python', file: 'clean_feed.py', produces: 'Draft script', params: [['Dedupe columns', 'txn_id, posted'], ['Amount column', 'amount']], source: (p) => 'import csv, sys\nfrom decimal import Decimal\n\nKEY = (' + p[0].split(',').map((c) => JSON.stringify(c.trim())).join(', ') + ',)\nAMOUNT = ' + JSON.stringify(p[1].trim()) + '\n\nrows = list(csv.DictReader(sys.stdin))\nseen = set()\nw = csv.DictWriter(sys.stdout, fieldnames=rows[0].keys() if rows else [])\nw.writeheader()\nfor r in rows:\n    k = tuple(r[c] for c in KEY)\n    if k in seen:\n        continue\n    seen.add(k)\n    r[AMOUNT] = str(Decimal(r[AMOUNT].replace(",", "")))\n    w.writerow(r)\n' },
    { name: 'Log parser', language: 'javascript', file: 'parse_logs.mjs', produces: 'Draft script', params: [['Pattern (key=value pairs)', 'model=(\\S+) .* latency_ms=(\\d+)']], source: (p) => "import { createInterface } from 'node:readline';\n\nconst re = new RegExp(" + JSON.stringify(p[0]) + ");\nconst counts = new Map();\nfor await (const line of createInterface({ input: process.stdin })) {\n  const m = re.exec(line);\n  if (!m) continue;\n  const c = counts.get(m[1]) ?? { n: 0, ms: 0 };\n  c.n++;\n  c.ms += Number(m[2]);\n  counts.set(m[1], c);\n}\nfor (const [key, c] of counts) console.log(key, c.n, (c.ms / c.n).toFixed(1));\n" },
    { name: 'JSON tool', language: 'python', file: 'sum_values.py', produces: 'Draft script, ready to promote as a tool', params: [['Array field', 'values']], source: (p) => 'import json, sys\nfrom decimal import Decimal\n\nargs = json.load(sys.stdin)\ntotal = sum(Decimal(str(v)) for v in args[' + JSON.stringify(p[0].trim()) + '])\njson.dump({"total": float(total)}, sys.stdout)\n' },
    { name: 'Report table', language: 'javascript', file: 'report_table.mjs', produces: 'Draft script', params: [['Group by field', 'cost_centre']], source: (p) => "let raw = '';\nfor await (const chunk of process.stdin) raw += chunk;\nconst rows = JSON.parse(raw || '[]');\nconst by = new Map();\nfor (const r of rows) by.set(r[" + JSON.stringify(p[0].trim()) + "], (by.get(r[" + JSON.stringify(p[0].trim()) + "]) ?? 0) + Number(r.amount));\nconsole.log(JSON.stringify([...by].map(([key, total]) => ({ key, total }))));\n" }
  ];

  /** A line diff of two texts (longest common subsequence). */
  function diffLines(a, b) {
    const x = a.split('\n'), y = b.split('\n');
    const n = x.length, m = y.length;
    const t = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) { if (x[i] === y[j]) { out.push('  ' + x[i]); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) out.push('- ' + x[i++]); else out.push('+ ' + y[j++]); }
    while (i < n) out.push('- ' + x[i++]);
    while (j < m) out.push('+ ' + y[j++]);
    return out;
  }

  // ---------- live updates: script.run for the signed-in user ----------
  const live = { sock: null, onRun: null, refresh: null };
  const detach = () => { if (live.sock && live.onRun) live.sock.off('script.run', live.onRun); live.sock = null; live.onRun = null; };
  const attach = () => {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.onRun = (e) => { if (App.state.route !== 'scripts') { detach(); return; } if (live.refresh) live.refresh(e); };
    live.sock.on('script.run', live.onRun);
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'scripts') detach(); });

  App.register({
    id: 'scripts', title: 'Scripts', live: true,
    summary: 'Script versions, checks, sandboxed runs, the promotion path to a registry tool, templates',
    crumb(st) { const s = st.script; return ['Scripts'].concat(s ? [s.name] : []); },
    label(st) { return st.script ? st.script.label : null; },
    commands: [{ label: 'New script from template', sub: 'Scripts', run(app) { app.stateFor('scripts').openTemplates = true; app.render(); } }],
    states: [
      { title: 'Template form', tone: 'neutral', text: 'Choosing a template opens a parameter form and always creates a draft that goes through the checks.', apply(ctx) { ctx.state.openTemplate = 0; ctx.rerender(); } },
      { title: 'Sandbox timeout', tone: 'warn', text: 'The run stopped at its time limit. Output so far is kept and the limits are shown.', apply(ctx) { ctx.state.demo = 'timeout'; ctx.rerender(); } },
      { title: 'Refused before start', tone: 'danger', text: 'A blocked module, a secret in the source or the script guardrail stops a run before any sandbox starts.', apply(ctx) { ctx.state.demo = 'blocked'; ctx.rerender(); } },
      { title: 'Two runtimes', tone: 'info', text: 'Only Python and JavaScript (Node.js) are offered when creating a script.', apply(ctx) { ctx.state.openTemplate = 0; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      st.tab = st.tab || 'checks'; st.query = st.query || ''; st.filter = st.filter || 'all';
      const later = () => { if (App.state.route !== 'scripts') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      const loadScript = (id) => Promise.all([App.get('/api/scripts/' + id), App.get('/api/scripts/' + id + '/runs')]).then(([s, runs]) => { st.script = s; st.runs = runs; const r = st.runView && st.runView.scriptId === id ? st.runView.id : s.lastRunId; return r ? App.get('/api/script-runs/' + r).then((x) => { st.runView = x; }) : (st.runView = null); }).catch((err) => { st.script = { id, error: err }; });
      const load = () => {
        if (st.loading) { st.again = true; return; }
        st.loading = true;
        Promise.all([App.get('/api/scripts'), st.runtime ? Promise.resolve(st.runtime) : App.get('/api/scripts/runtime').catch(() => null)])
          .then(([list, runtime]) => { st.list = list; st.runtime = runtime; st.loaded = true; st.loadError = null; if (ctx.params.script) { const hit = list.find((x) => x.id === ctx.params.script || x.name === ctx.params.script); if (hit) st.sel = hit.id; delete ctx.params.script; } if (!list.find((x) => x.id === st.sel)) st.sel = list[0] ? list[0].id : null; return st.sel ? loadScript(st.sel) : (st.script = null); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; if (st.again) { st.again = false; load(); return; } later(); });
      };
      live.refresh = (e) => { if (e && st.sel && e.scriptId === st.sel) { if (e.runId) st.runView = { id: e.runId, scriptId: e.scriptId, state: e.state }; loadScript(st.sel).then(later); if (e.state === 'succeeded' || e.state === 'failed' || e.state === 'timeout') load(); } };
      attach();
      if (!st.loaded && !st.loadError) load();
      const act = async (fn, okMsg, kind) => {
        try { const r = await fn(); st.problem = null; if (okMsg) toast(okMsg, kind || 'ok', 5000); load(); return r || true; }
        catch (err) { const pr = err.problem || {}; if (err.status >= 400 && err.status < 500) st.problem = { title: pr.title || 'Refused', detail: err.message, trace: pr.trace_id }; App.fail(err); ctx.rerender(); return null; }
      };
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Scripts', 'Sandboxed scripts and the promotion path to a registry tool', '') + (st.loadError ? UI.problem('Scripts could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }

      if (st.demo) {
        const d = st.demo; st.demo = null; st.demoNote = null;
        if (d === 'blocked') { const hit = st.list.find((x) => x.id === st.sel && st.script && st.script.blocked) ; if (hit) st.tab = 'checks'; else if (st.script && !st.script.blocked) st.demoNote = 'This script passes its checks. Add a line such as import requests and save to see the run refused before start.'; }
        else if (d === 'timeout') { if (st.runView && st.runView.state === 'timeout') st.tab = 'output'; else { const t = (st.runs || []).find((r) => r.state === 'timeout'); if (t) { st.tab = 'output'; App.get('/api/script-runs/' + t.id).then((x) => { st.runView = x; later(); }); } else st.demoNote = 'No run of this script has hit its time limit. A run that does is stopped, its output so far is kept, and the limits are shown under Output.'; } }
      }

      const list = st.list.filter((x) => (!st.query || x.name.toLowerCase().indexOf(st.query.toLowerCase()) >= 0) && (st.filter === 'all' || x.language === st.filter));
      const s = st.script && !st.script.error && st.script.id === st.sel ? st.script : null;
      const rt = st.runtime || { runner: 'unknown', available: false, defaults: {}, languages: ['python', 'javascript'] };
      const canPromote = App.can('workflows:manage') || App.can('tools:manage');

      const left = '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Scripts</div>' + UI.btn('New', { size: 'sm', attrs: 'data-new' }) + UI.btn('From template', { size: 'sm', attrs: 'data-templates' }) + '</div>'
        + UI.search('Filter scripts', 'data-search', st.query).replace('class="search"', 'class="search" style="width:100%"')
        + UI.seg([{ id: 'all', label: 'All' }, { id: 'python', label: 'Python' }, { id: 'javascript', label: 'Node.js' }], st.filter, 'data-langseg')
        + '<div class="scripts-list">' + list.map((x) => UI.listItem(esc(x.name), esc(LANG[x.language] + ', v' + x.version), { active: x.id === st.sel, attrs: 'data-script="' + esc(x.id) + '"', right: statusPill(x.status) })).join('') + (list.length ? '' : UI.empty(st.list.length ? 'No scripts match' : 'No scripts yet', st.list.length ? 'Try another word.' : 'Create one, or start from a template.')) + '</div>'
        + '<div class="muted" style="font-size:12px;margin-top:auto">Promotion path: draft (this workspace, versioned), tested (a clean run of the current version), promoted tool (tool-admin review in the Registry).</div></div>';

      let page;
      if (!st.sel) page = '<div class="page scripts-page">' + UI.pagehead('Scripts', 'Sandboxed scripts and the promotion path to a registry tool', '') + UI.empty('No scripts in this workspace', 'Scripts run in a disposable container with no network. Start from a template or write one.', UI.btn('From template', { kind: 'primary', attrs: 'data-templates' })) + runtimesPanel() + '</div>';
      else if (!s) page = '<div class="page">' + (st.script && st.script.error ? UI.problem('The script could not be loaded', st.script.error.message, st.script.error.problem && st.script.error.problem.trace_id) : UI.notice('Loading…', 'info')) + '</div>';
      else {
        const stage = s.status === 'draft' ? 0 : s.status === 'tested' || s.status === 'in_review' ? 1 : 2;
        const stepper = '<div class="scripts-steps">' + ['Draft', 'Tested', 'Promoted tool'].map((t, i) => '<div class="' + (i < stage ? 'done' : i === stage ? 'cur' : '') + '"><i></i><span>' + t + (i === 1 && s.status === 'in_review' ? ' <span class="pill info" style="height:18px;font-size:11px">in review</span>' : '') + '</span></div>').join('') + '</div>';
        const blockers = s.checks.filter((c) => c.tone === 'danger');
        const hiLine = st.hiLine || (blockers[0] && blockers[0].line);
        let code;
        if (st.editing === s.id) code = '<textarea class="textarea mono scripts-edit" data-source spellcheck="false">' + esc(st.draft != null ? st.draft : s.source) + '</textarea><div class="hstack">' + UI.field('Note', UI.input(st.note || '', { attrs: 'data-note', placeholder: 'What changed' })) + '<span class="grow"></span>' + UI.btn('Cancel', { attrs: 'data-canceledit' }) + UI.btn('Save as v' + (s.version + 1), { kind: 'primary', attrs: 'data-saveversion' }) + '</div>';
        else {
          code = UI.code(s.source, s.language);
          if (hiLine) code = code.replace(new RegExp('(<span class="ln">' + hiLine + '</span>)([^\\n]*)'), '<span style="display:inline-block;width:100%;background:var(--warn-bg)">$1$2</span>');
        }
        const run = st.runView && st.runView.scriptId === s.id ? st.runView : null;
        let side;
        if (st.tab === 'checks') {
          side = UI.table(['Check', 'Result'], s.checks.map((c) => ({ cells: [esc(c.name), UI.pill(c.result, c.tone)], attrs: 'data-check="' + esc(c.name) + '"' })), { minWidth: '0', cls: 'scripts-checks' })
            + '<div class="fg2" style="font-size:12px">' + (blockers.length ? esc(blockers.map((c) => c.detail).join(' ')) : 'All checks pass; the script can run in the sandbox.') + '</div>'
            + '<div class="hstack">' + UI.btn('Re-run checks', { size: 'sm', kind: 'ghost', icon: 'refresh', attrs: 'data-recheck' }) + (blockers.length && hiLine ? UI.btn('Edit line ' + hiLine, { size: 'sm', attrs: 'data-edit' }) : '') + '</div>';
        } else if (st.tab === 'dry') {
          side = UI.field('Input (stdin)', UI.textarea(st.stdin || '', { rows: 5, attrs: 'data-stdin', placeholder: s.language === 'python' ? '{"values": [1, 2, 3]}' : 'a line of input' }), 'Promoted tools receive their arguments here as JSON')
            + UI.kv([['Sandbox', esc(rt.runner === 'none' ? 'not configured' : rt.runner + ' container' + (rt.available ? '' : ', not answering'))], ['Limits', esc(s.limits.timeoutSeconds + ' s, ' + s.limits.memoryMb + ' MB, ' + s.limits.cpus + ' CPU, ' + s.limits.pids + ' processes, ' + s.limits.outputKb + ' KB output')], ['Network', 'none'], ['Filesystem', 'read-only root, small noexec tmpfs']], 2)
            + '<div>' + UI.btn(run && (run.state === 'queued' || run.state === 'running') ? 'Running' : 'Run in sandbox', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-runsandbox', disabled: !!(run && (run.state === 'queued' || run.state === 'running')) }) + '</div>'
            + (run ? outputPane(s, run) : '');
        } else side = run ? outputPane(s, run) : UI.empty('No output yet', 'Run once or run in the sandbox to see stdout, stderr, the exit code and the limits used.', UI.btn('Run in sandbox', { size: 'sm', icon: 'play', attrs: 'data-runsandbox' }));

        const primary = s.status === 'promoted' ? UI.btn('Open in Registry', { kind: 'primary', attrs: 'data-goreg' })
          : s.status === 'in_review' ? UI.btn('In review', { kind: 'primary', disabled: true })
            : UI.btn('Submit for promotion', { kind: 'primary', attrs: 'data-promote', disabled: s.status !== 'tested' || !canPromote, title: !canPromote ? 'Promotion needs workflows:manage or tools:manage' : s.status !== 'tested' ? 'Run the current version once without errors first' : '' });
        page = '<div class="page scripts-page">' + UI.pagehead(s.name, esc(LANG[s.language]) + ', version ' + s.version + ' · ' + statusPill(s.status) + ' · ' + UI.label(s.label, { sm: true }), UI.btn('Diff v' + (s.version - 1), { attrs: 'data-diff', disabled: s.version < 2 }) + UI.btn('Edit', { attrs: 'data-edit', disabled: st.editing === s.id }) + UI.btn('Run once', { icon: 'play', attrs: 'data-runonce' }) + primary)
          + stepper
          + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '')
          + (st.problem ? UI.problem(st.problem.title, st.problem.detail, st.problem.trace) : '')
          + (s.status === 'in_review' && s.registry ? UI.notice('Submitted for promotion as <b>' + esc(s.registry.name + ' ' + s.registry.version) + '</b>. A tool admin reviews its schemas, side-effect class and checks in the <a href="#" data-goreg>Registry</a>.', 'info') : '')
          + (s.registry && s.registry.status === 'draft' && s.registry.reviewNote ? UI.notice('<b>Returned by the reviewer.</b> ' + esc(s.registry.reviewNote), 'warn') : '')
          + (blockers.length ? UI.notice('<b>Runs are refused before start.</b> ' + esc(blockers[0].name + ': ' + blockers[0].detail), 'danger') : '')
          + '<div class="cols"><div class="grow scripts-code" style="min-width:0">' + code + '</div>'
          + '<div class="scripts-side">' + UI.tabs([{ id: 'checks', label: 'Checks' }, { id: 'dry', label: 'Dry run' }, { id: 'output', label: 'Output' }], st.tab) + side + '</div></div>'
          + UI.panel('Runs', UI.table(['Run', 'Version', 'Result', 'Duration', 'Started'], (st.runs || []).map((r) => ({ cells: ['<span class="mono">' + esc(shortId(r.id)) + '</span>', 'v' + r.version, runPill(r.state, r.exitCode), esc(secs(r.durationMs)), esc(when(r.createdAt))], attrs: 'data-runrow="' + esc(r.id) + '"', selected: run && run.id === r.id })), { cls: 'bare', minWidth: '0', emptyTitle: 'No runs yet', emptyText: 'Each run is a job in a fresh sandbox.' }))
          + runtimesPanel()
          + '</div>';
      }

      root.innerHTML = '<style>'
        + '.scripts-page > *{flex-shrink:0}.scripts-side > *{flex-shrink:0}'
        + '.scripts-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.scripts-steps > div{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--fg2)}.scripts-steps i{display:block;height:4px;border-radius:2px;background:var(--line)}.scripts-steps .done i,.scripts-steps .cur i{background:var(--ok-fg)}.scripts-steps .cur span{font-weight:700;color:var(--fg)}'
        + '.scripts-list{display:flex;flex-direction:column;gap:2px}.scripts-code{min-height:320px;max-height:560px;display:flex;flex-direction:column;gap:8px}.scripts-code .codebox{min-height:320px}.scripts-edit{min-height:360px;font-family:var(--mono);font-size:12px;white-space:pre}'
        + '.scripts-side{width:340px;flex-shrink:0;display:flex;flex-direction:column;gap:12px}.scripts-out{background:var(--fg);color:var(--bg);border-radius:6px;padding:10px 12px;font-family:var(--mono);font-size:12px;white-space:pre-wrap;margin:0;min-height:96px;max-height:320px;overflow:auto}'
        + '@media (max-width:1100px){.scripts-side{width:100%}}'
        + '</style>' + left + page;

      // ---- events ----
      ctx.on('click', '[data-script]', (e, t) => { st.sel = t.dataset.script; st.hiLine = null; st.editing = null; st.draft = null; st.runView = null; st.problem = null; st.demoNote = null; st.script = null; loadScript(st.sel).then(later); ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-langseg] [data-seg]', (e, t) => { st.filter = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-templates]', () => templateCatalog());
      ctx.on('click', '[data-new]', () => newScript(null));
      ctx.on('click', '[data-goreg]', (e) => { e.preventDefault(); if (s && s.registry) ctx.navigate('registry', { entry: s.registry.id }); });
      ctx.on('input', '[data-stdin]', (e, t) => { st.stdin = t.value; });
      ctx.on('input', '[data-source]', (e, t) => { st.draft = t.value; });
      ctx.on('input', '[data-note]', (e, t) => { st.note = t.value; });
      ctx.on('click', '[data-edit]', () => { st.editing = s.id; st.draft = s.source; ctx.rerender(); });
      ctx.on('click', '[data-canceledit]', () => { st.editing = null; st.draft = null; ctx.rerender(); });
      ctx.on('click', '[data-saveversion]', async () => { const source = st.draft; const note = st.note || null; const r = await act(() => App.patch('/api/scripts/' + s.id, { source, note }), 'Saved as v' + (s.version + 1) + '. Checks re-ran.'); if (r) { st.editing = null; st.draft = null; st.note = ''; st.hiLine = null; } });
      ctx.on('click', '[data-recheck]', () => act(() => App.post('/api/scripts/' + s.id + '/checks'), 'Checks re-ran on v' + s.version + '.'));
      ctx.on('click', '[data-runsandbox]', () => runScript(st.stdin || null));
      ctx.on('click', '[data-runonce]', () => runScript(st.stdin || null));
      ctx.on('click', '[data-runrow]', (e, t) => { App.get('/api/script-runs/' + t.dataset.runrow).then((x) => { st.runView = x; st.tab = 'output'; later(); }).catch((err) => App.fail(err)); });
      ctx.on('click', 'tr.row[data-check]', (e, t) => {
        const c = s.checks.find((x) => x.name === t.dataset.check);
        if (c.line) { st.hiLine = c.line; ctx.rerender(); }
        ctx.drawer({ title: esc(c.name) + ' ' + UI.pill(c.result, c.tone), body: '<div class="fg2">' + esc(c.detail) + '</div>' + UI.kv([['Runs', 'on the server, before any execution'], ['Language', esc(LANG[s.language])], ['Blocks a run', c.tone === 'danger' ? 'yes' : 'no']].concat(c.line ? [['Line', String(c.line)]] : []), 1) + (c.name === 'Script guardrail' ? UI.notice('The script checkpoint flags or blocks secrets, disallowed modules and suspicious patterns. Rules live in <a href="#" data-goguard>Guardrails</a>.', 'info') : ''), actions: (c.tone === 'danger' ? UI.btn('Edit the script', { attrs: 'data-close data-fix' }) : '') + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { const g = d.querySelector('[data-goguard]'); if (g) g.addEventListener('click', (ev) => { ev.preventDefault(); App.closeOverlay(); ctx.navigate('guardrails'); }); const f = d.querySelector('[data-fix]'); if (f) f.addEventListener('click', () => { st.editing = s.id; st.draft = s.source; later(); }); } });
      });
      ctx.on('click', '[data-diff]', async () => {
        try {
          const prev = await App.get('/api/scripts/' + s.id + '/versions/' + (s.version - 1));
          const lines = diffLines(prev.source, s.source);
          ctx.modal({ cls: 'wide', title: 'Diff ' + esc(s.name) + ': v' + (s.version - 1) + ' to v' + s.version, body: '<pre class="codebox" data-lang="diff">' + lines.map((l) => l.startsWith('+') ? '<span style="color:var(--ok-fg)">' + esc(l) + '</span>' : l.startsWith('-') ? '<span style="color:var(--danger-fg)">' + esc(l) + '</span>' : esc(l)).join('\n') + '</pre>' + (prev.note ? '<div class="fg2" style="font-size:12px">v' + (s.version - 1) + ': ' + esc(prev.note) + '</div>' : ''), actions: UI.btn('Restore v' + (s.version - 1), { attrs: 'data-restore' }) + UI.btn('Close', { kind: 'primary', attrs: 'data-close' }), onMount(m) { m.querySelector('[data-restore]').addEventListener('click', () => { App.closeOverlay(); act(() => App.post('/api/scripts/' + s.id + '/restore', { version: s.version - 1 }), 'v' + (s.version - 1) + ' restored as v' + (s.version + 1) + '. Versions are never overwritten.'); }); } });
        } catch (err) { App.fail(err, 'The previous version could not be loaded'); }
      });
      ctx.on('click', '[data-promote]', () => promoteModal());

      if (st.openTemplates) { st.openTemplates = false; setTimeout(templateCatalog, 30); }
      if (st.openTemplate != null) { const i = st.openTemplate; st.openTemplate = null; setTimeout(() => newScript(TEMPLATES[i]), 30); }

      function runtimesPanel() {
        return UI.panel('Runtimes', UI.table(['Runtime', 'Image', 'Checks before any run'], (rt.languages || []).map((l) => [esc(LANG[l] || l), '<span class="mono">' + esc((rt.images && rt.images[l]) || (l === 'python' ? 'SCRIPT_IMAGE_PYTHON' : 'SCRIPT_IMAGE_NODE')) + '</span>', 'script guardrail, blocked modules, secrets scan']), { clickable: false, cls: 'bare', minWidth: '0' })
          + UI.kv([['Sandbox', esc(rt.runner === 'none' ? 'none configured: runs are refused' : rt.runner) + ' ' + UI.pill(rt.available ? 'answering' : 'not answering', rt.available ? 'ok' : 'danger')], ['Default limits', rt.defaults ? esc(rt.defaults.timeoutSeconds + ' s, ' + rt.defaults.memoryMb + ' MB, ' + rt.defaults.cpus + ' CPU, ' + rt.defaults.pids + ' processes, ' + rt.defaults.outputKb + ' KB output') : '']], 2)
          + '<div class="muted" style="font-size:12px">Each run is a fresh container: no network, read-only root, nobody user, all capabilities dropped. Nothing is installed at run time.</div>');
      }
      function outputPane(sc, r) {
        const running = r.state === 'queued' || r.state === 'running';
        return (r.state === 'timeout' ? UI.notice('<b>Sandbox timeout.</b> The run stopped at the ' + sc.limits.timeoutSeconds + ' s limit. Output so far is kept below.', 'warn', UI.btn('Run again', { size: 'sm', attrs: 'data-runsandbox' })) : '')
          + (r.error ? UI.notice(esc(r.error), 'danger') : '')
          + '<div class="hstack"><div class="eyebrow grow">' + (running ? 'Running in sandbox' : 'Output, run ' + esc(shortId(r.id))) + '</div>' + runPill(r.state, r.exitCode) + '</div>'
          + (running ? UI.meter(r.state === 'queued' ? 'Queued for a worker' : 'Executing, no network', '…', r.state === 'queued' ? 20 : 60, 'accent') : '')
          + '<pre class="scripts-out">' + esc(r.stdout || (running ? '' : '(no output)')) + '</pre>'
          + (r.stderr ? '<div class="eyebrow">stderr</div><pre class="scripts-out">' + esc(r.stderr) + '</pre>' : '')
          + (running ? '' : UI.kv([['Duration', esc(secs(r.durationMs)) + ' of ' + sc.limits.timeoutSeconds + ' s'], ['Exit', r.exitCode == null ? esc(r.state === 'timeout' ? 'killed at the limit' : 'none') : String(r.exitCode)], ['Output', r.truncated ? 'truncated at ' + sc.limits.outputKb + ' KB' : 'complete'], ['Runner', esc(r.runner || '')]], 2));
      }
      async function runScript(stdin) {
        if (!s) return;
        try {
          const r = await App.post('/api/scripts/' + s.id + '/run', { stdin });
          st.runView = { id: r.runId, scriptId: s.id, state: 'queued' }; st.tab = st.tab === 'checks' ? 'output' : st.tab; st.problem = null;
          toast('Run queued. Output appears when the sandbox finishes.', 'ok');
          ctx.rerender();
        } catch (err) {
          const pr = err.problem || {};
          if (err.status === 409) { st.tab = 'checks'; st.problem = { title: pr.title || 'Refused', detail: err.message, trace: pr.trace_id }; ctx.rerender(); toast('Refused before start: ' + esc(err.message), 'danger', 6000); }
          else App.fail(err, 'The run could not start');
        }
      }
      function templateCatalog() {
        ctx.modal({ cls: 'wide', title: 'Template catalog', body: '<p class="fg2" style="margin:0">Templates fill in a new script from a few parameters. It is always created as a draft and passes the same checks before it can run.</p>' + UI.table(['Template', 'Produces', 'Runtime', ''], TEMPLATES.map((t, i) => ['<b>' + esc(t.name) + '</b>', esc(t.produces), esc(LANG[t.language]), UI.btn('Use', { size: 'sm', attrs: 'data-use="' + i + '"' })]), { clickable: false, minWidth: '0' }), actions: UI.btn('Close', { attrs: 'data-close' }), onMount(m) { m.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => { App.closeOverlay(); setTimeout(() => newScript(TEMPLATES[+b.dataset.use]), 30); })); } });
      }
      function newScript(t) {
        const me = App.me && App.me.user ? App.me.user : {};
        const labels = LABELS.filter((l) => !me.clearance || LABELS.indexOf(l) <= LABELS.indexOf(me.clearance));
        ctx.modal({ cls: 'wide', title: t ? 'New script from template: ' + esc(t.name) : 'New script', body: '<div class="formgrid">' + UI.field('Runtime', UI.select((rt.languages || ['python', 'javascript']).map((l) => ({ value: l, label: LANG[l] })), t ? t.language : 'python', 'data-lang' + (t ? ' disabled' : '')), 'Only Python and JavaScript (Node.js) are offered') + UI.field('Name', UI.input(t ? t.file : '', { attrs: 'data-name', placeholder: 'clean_feed.py' }))
          + UI.field('Label', UI.select(labels, 'internal', 'data-label'), 'Runs and output carry this label') + UI.field('Time limit, seconds', UI.input(String((rt.defaults && rt.defaults.timeoutSeconds) || 60), { type: 'number', attrs: 'data-timeout' }))
          + (t ? t.params.map((p, i) => UI.field(p[0], UI.input(p[1], { attrs: 'data-p="' + i + '"' }))).join('') : '<div class="span2">' + UI.field('Source', UI.textarea('', { rows: 8, attrs: 'data-src' })) + '</div>') + '</div>'
          + UI.notice('The draft passes the script guardrail, the blocked-module check and the secrets scan before it can run.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-ok' }),
          onMount(m) {
            m.querySelector('[data-ok]').addEventListener('click', async () => {
              const params = Array.prototype.map.call(m.querySelectorAll('[data-p]'), (x) => x.value);
              const source = t ? t.source(params) : m.querySelector('[data-src]').value;
              const limits = Object.assign({}, rt.defaults || { timeoutSeconds: 60, memoryMb: 512, cpus: 1, pids: 64, outputKb: 64 }, { timeoutSeconds: Number(m.querySelector('[data-timeout]').value) || 60 });
              const body = { name: m.querySelector('[data-name]').value.trim(), language: m.querySelector('[data-lang]').value, label: m.querySelector('[data-label]').value, source, limits };
              if (!body.source.trim()) { toast('Write the source first.', 'warn'); return; }
              App.closeOverlay();
              const r = await act(() => App.post('/api/scripts', body), 'Draft ' + esc(body.name) + ' created. Its checks ran.');
              if (r && r.id) { st.sel = r.id; st.tab = 'checks'; st.runView = null; st.script = null; }
            });
          } });
      }
      function promoteModal() {
        const guess = s.name.replace(/\.(py|mjs|js)$/, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
        ctx.modal({ cls: 'wide', title: 'Submit ' + esc(s.name) + ' for promotion', body: '<p class="fg2" style="margin:0">Promotion creates a draft tool in the Registry and submits it for review. A tool admin other than you approves it; nothing reaches a tenant before review. The tool pins version ' + s.version + '.</p><div class="formgrid">'
          + UI.field('Tool name', UI.input('scripts.' + guess, { attrs: 'data-tname' })) + UI.field('Tool version', UI.input('0.1.0', { attrs: 'data-tver' }))
          + UI.field('Side-effect class', UI.select([{ value: 'read', label: 'read-only' }, { value: 'write', label: 'write' }, { value: 'destructive', label: 'destructive' }], 'read', 'data-side'), 'Scripts have no network; most are read-only') + UI.field('Max label', UI.select(LABELS.slice(LABELS.indexOf(s.label)), s.label, 'data-label'))
          + '<div class="span2">' + UI.field('Description', UI.textarea('', { rows: 2, attrs: 'data-desc', placeholder: 'What the tool does, when to use it and what it returns' })) + '</div>'
          + UI.field('Input schema (JSON Schema)', UI.textarea('{\n  "type": "object",\n  "properties": {},\n  "required": []\n}', { rows: 6, attrs: 'data-in' })) + UI.field('Output schema', UI.textarea('{\n  "type": "object"\n}', { rows: 6, attrs: 'data-out' })) + '</div>'
          + UI.notice('Checks on v' + s.version + ': ' + esc(s.checks.map((c) => c.name + ' ' + c.result).join(', ')) + '. The registry runs its own checks on submission.', 'ok'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Submit', { kind: 'primary', attrs: 'data-ok' }),
          onMount(m) {
            m.querySelector('[data-ok]').addEventListener('click', async () => {
              let body;
              try { body = { toolName: m.querySelector('[data-tname]').value.trim(), version: m.querySelector('[data-tver]').value.trim() || '0.1.0', sideEffect: m.querySelector('[data-side]').value, label: m.querySelector('[data-label]').value, description: m.querySelector('[data-desc]').value.trim(), inputSchema: JSON.parse(m.querySelector('[data-in]').value), outputSchema: m.querySelector('[data-out]').value.trim() ? JSON.parse(m.querySelector('[data-out]').value) : null }; }
              catch (err) { toast('A schema is not valid JSON: ' + esc(err.message), 'danger'); return; }
              if (!body.description) { toast('Describe the tool; the registry checks the description.', 'warn'); return; }
              App.closeOverlay();
              const r = await act(() => App.post('/api/scripts/' + s.id + '/promote', body), esc(body.toolName) + ' ' + esc(body.version) + ' submitted for review. <a href="#/registry?tab=review" style="color:inherit">Open the review queue</a>', 'ok');
              if (r && r.checksPassed === false) toast('Some registry checks fail; the reviewer will see them. Fix the description or schemas in a new version.', 'warn', 7000);
            });
          } });
      }
    }
  });
})();
