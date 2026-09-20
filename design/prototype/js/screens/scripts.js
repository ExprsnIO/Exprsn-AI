(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  const CODE_PY = 'import csv, sys\nfrom decimal import Decimal\n\ndef clean(rows):\n    seen = set()\n    for r in rows:\n        key = (r["txn_id"], r["posted"])\n        if key in seen:\n            continue\n        seen.add(key)\n        r["amount"] = Decimal(r["amount"].replace(",", ""))\n        yield r\n\nimport requests  # blocked: no network in the sandbox\n\nif __name__ == "__main__":\n    w = csv.DictWriter(sys.stdout, fieldnames=FIELDS)\n    w.writeheader()\n    for row in clean(csv.DictReader(sys.stdin)):\n        w.writerow(row)';
  const SCRIPTS = [
    { id: 'clean_card_feed.py', runtime: 'Python 3.13', version: 'saved v4', status: 'saved', stage: 1, label: 'confidential', packages: 'curated wheels: pandas, openpyxl, python-dateutil', lang: 'python', code: CODE_PY, blockedLine: 14,
      checks: [['ruff', 'clean', 'ok'], ['Bandit', '1 finding', 'warn'], ['Script-generation guardrail', 'blocked module', 'danger'], ['Secrets scan', 'clean', 'ok']], note: 'Line 14 imports requests. Scripts have no network. A promoted tool may declare internal destinations reached through the egress proxy.',
      dry: 'rows in   1,204\nrows out  1,187\ndropped   17 duplicates\nruntime   0.41 s, 38 MB', sample: 'card-feed-2026-09.csv (1,204 rows, confidential)', output: 'txn_id,posted,merchant,amount\n8841,2026-09-02,Lisbon Air,412.50\n8842,2026-09-02,Hotel Baixa,188.00\n8843,2026-09-03,TAP Cargo,96.10\n… 1,184 more rows\n\nfiles produced: cleaned.csv (84 KB)' },
    { id: 'monthly_variance.py', runtime: 'Python 3.13', version: 'published tool', status: 'published tool', stage: 2, label: 'confidential', packages: 'curated wheels: pandas, duckdb', lang: 'python', code: 'import sys, json\nimport duckdb\n\nSQL = """\nSELECT cost_centre,\n       sum(actual) AS actual,\n       sum(budget) AS budget,\n       sum(actual) - sum(budget) AS variance\nFROM read_csv_auto(?)\nGROUP BY 1 ORDER BY variance DESC\n"""\n\ndef main(path):\n    rows = duckdb.sql(SQL, params=[path]).fetchall()\n    json.dump([dict(zip(["cost_centre", "actual", "budget", "variance"], r)) for r in rows], sys.stdout)\n\nif __name__ == "__main__":\n    main(sys.argv[1])',
      checks: [['ruff', 'clean', 'ok'], ['Bandit', 'clean', 'ok'], ['Script-generation guardrail', 'passed', 'ok'], ['Secrets scan', 'clean', 'ok']], note: 'Published as report.generate (script) 0.3.1 with JSON Schema inputs and outputs, side-effect class write, signed with cosign.',
      dry: 'rows in   214\ngroups    9\nruntime   0.18 s, 41 MB', sample: 'q3-ledger.csv (214 rows, confidential)', output: '[{"cost_centre":"FIELD-SALES","actual":188420.0,"budget":150000.0,"variance":38420.0},\n {"cost_centre":"LIS-ONBOARD","actual":96310.0,"budget":60000.0,"variance":36310.0},\n …]' },
    { id: 'parse_gateway_logs.mjs', runtime: 'Node.js 24', version: '', status: 'ad-hoc', stage: 0, label: 'internal', packages: 'curated npm: none (built-ins only)', lang: 'javascript', code: "import { createInterface } from 'node:readline';\n\nconst counts = new Map();\nconst rl = createInterface({ input: process.stdin });\nfor await (const line of rl) {\n  const m = /model=(\\S+) .* latency_ms=(\\d+)/.exec(line);\n  if (!m) continue;\n  const c = counts.get(m[1]) ?? { n: 0, ms: 0 };\n  c.n++; c.ms += Number(m[2]);\n  counts.set(m[1], c);\n}\nfor (const [model, c] of counts) {\n  console.log(model, c.n, (c.ms / c.n).toFixed(1));\n}",
      checks: [['node --check', 'clean', 'ok'], ['ESLint', '2 warnings', 'warn'], ['Script-generation guardrail', 'passed', 'ok'], ['Secrets scan', 'clean', 'ok']], note: 'ESLint: prefer const for counts; unused variable rl after loop. Warnings do not block a run.',
      dry: 'lines in  48,210\nmodels    4\nruntime   0.62 s, 52 MB', sample: 'gateway-2026-09-19.log (48,210 lines, internal)', output: 'qwen2.5:32b-q4_K_M 1204 2140.5\nllama3.1:8b-q5_K_M 8891 412.3\nqwen2.5-coder:32b-q4_K_M 312 1880.2\nvision-default 96 3120.0' },
    { id: 'ledger_client.mjs', runtime: 'Node.js 24', version: 'saved v2', status: 'saved', stage: 1, label: 'confidential', packages: 'curated npm: zod', lang: 'javascript', code: "import { z } from 'zod';\n\nconst Row = z.object({ cost_centre: z.string(), amount: z.string() });\n\nexport async function fetchRows(period) {\n  // Promoted tools reach ledger-api through the egress proxy only.\n  const res = await fetch(`http://ledger-api.northwind.internal/v4/rows?period=${period}`);\n  return z.array(Row).parse(await res.json());\n}",
      checks: [['node --check', 'clean', 'ok'], ['ESLint', 'clean', 'ok'], ['Script-generation guardrail', 'egress declared', 'ok'], ['Secrets scan', 'clean', 'ok']], note: 'fetch to ledger-api.northwind.internal is allowed only after promotion, with the destination declared on the tool entry. Ad-hoc and saved runs have no network.',
      dry: 'network   refused (no egress for saved scripts)\nruntime   0.05 s, 30 MB', sample: 'period=2026-Q3', output: 'TypeError: fetch failed\n  cause: connect ECONNREFUSED (egress proxy: not a promoted tool)\n\nexit 1' }
  ];
  const TEMPLATES = [
    { kind: 'Script', name: 'CSV clean-up', produces: 'Draft script with parameters filled in', runtimes: 'Node.js, Python, Tcl, Perl' }, { kind: 'Script', name: 'Log parser', produces: 'Draft script', runtimes: 'Node.js, Python, Perl' }, { kind: 'Script', name: 'Report generator', produces: 'Draft script', runtimes: 'Python' }, { kind: 'Script', name: 'Internal API client', produces: 'Draft script', runtimes: 'Node.js, Python, Tcl' },
    { kind: 'Tool', name: 'OpenAPI tool', produces: 'Draft registry entry plus code', runtimes: 'TypeScript' }, { kind: 'Tool', name: 'SQL or MongoDB query tool', produces: 'Draft registry entry plus code', runtimes: 'TypeScript' }, { kind: 'Tool', name: 'MCP server scaffold', produces: 'Draft registry entry plus code', runtimes: 'TypeScript, Python' },
    { kind: 'Agent', name: 'Data analyst', produces: 'Draft agent: profile, prompt, tools, skills, limits', runtimes: '' }, { kind: 'Agent', name: 'Meeting notes', produces: 'Draft agent', runtimes: '' },
    { kind: 'Workflow', name: 'Video to notes', produces: 'Draft workflow graph', runtimes: '' }, { kind: 'Workflow', name: 'Nightly report', produces: 'Draft workflow graph', runtimes: '' }
  ];
  const RUNTIMES = [['Node.js 24 LTS', 'Curated npm packages from the internal Verdaccio mirror', 'node --check, ESLint, tsc --noEmit for TypeScript'], ['Python 3.13', 'Curated wheels (data, parsing, plotting)', 'ruff, Bandit'], ['Tcl 9.0', 'tcllib, tdom', 'Nagelfar syntax check'], ['Perl 5.40', 'Curated CPAN modules', 'perlcritic; perl -c only inside the sandbox']];
  const statusPill = (s) => UI.pill(s, s === 'saved' ? 'ok' : s === 'published tool' ? 'info' : s === 'in review' ? 'info' : '');
  const find = (id) => SCRIPTS.find((s) => s.id === id);
  const codeHtml = (s, st) => {
    const code = st.removedLine[s.id] && s.blockedLine ? s.code.split('\n').filter((l, i) => i !== s.blockedLine - 1).join('\n') : s.code;
    let html = UI.code(code, s.lang);
    if (s.blockedLine && !st.removedLine[s.id]) html = html.replace(/(<span class="ln">14<\/span>)([^\n]*)/, '<span style="display:inline-block;width:100%;background:var(--warn-bg)" data-line="14">$1$2</span>');
    if (st.hiLine) html = html.replace(new RegExp('(<span class="ln">' + st.hiLine + '</span>)([^\\n]*)'), '<span style="display:inline-block;width:100%;outline:1px solid var(--accent)">$1$2</span>');
    return html;
  };

  let bound = false; const cur = {};

  App.register({
    id: 'scripts', title: 'Scripts', summary: 'Script runtimes, checks, dry runs, promotion path, template catalog, code interpreter sessions',
    crumb(st) { return ['Scripts', st.sel || 'clean_card_feed.py']; }, label(st) { const s = find(st.sel || 'clean_card_feed.py'); return s ? s.label : 'confidential'; },
    commands: [{ label: 'New script from template', sub: 'Scripts', run(app) { app.stateFor('scripts').openTemplates = true; app.render(); } }],
    states: [
      { title: 'Template form', tone: 'neutral', text: 'Choosing a template opens a parameter form generated from its JSON Schema and always creates a draft.', apply(ctx) { templateForm(ctx, TEMPLATES[0]); } },
      { title: 'Sandbox timeout', tone: 'warn', text: 'The run stopped at the 60 s cap. Output so far is kept and the limits are shown.', apply(ctx) { const st = ctx.state; st.sel = 'parse_gateway_logs.mjs'; st.tab = 'output'; st.runs = st.runs || {}; st.runs[st.sel] = { phase: 'timeout', lines: ['qwen2.5:32b-q4_K_M 1204 2140.5', 'llama3.1:8b-q5_K_M 8891 412.3'] }; ctx.rerender(); } },
      { title: 'Interpreter expired', tone: 'neutral', text: 'The chat code-interpreter session expired after 30 idle minutes. Files remain in the conversation.', apply(ctx) { ctx.state.interpExpired = true; ctx.rerender(); } },
      { title: 'Two runtimes', tone: 'info', text: 'Only Node.js 24 and Python 3.13 are offered when creating a script.', apply(ctx) { ctx.state.twoRuntimes = true; ctx.rerender(); templateForm(ctx, TEMPLATES[0]); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.script) { st.sel = ctx.params.script; delete ctx.params.script; }
      st.sel = st.sel || 'clean_card_feed.py'; st.tab = st.tab || 'checks'; st.query = st.query || ''; st.filter = st.filter || 'all'; st.runs = st.runs || {}; st.removedLine = st.removedLine || {}; st.over = st.over || {}; st.added = st.added || [];
      cur.ctx = ctx; cur.st = st;
      const scripts = SCRIPTS.concat(st.added);
      const s = scripts.find((x) => x.id === st.sel) || SCRIPTS[0];
      const status = st.over[s.id] || s.status;
      const list = scripts.filter((x) => (!st.query || x.id.toLowerCase().includes(st.query.toLowerCase())) && (st.filter === 'all' || x.runtime.startsWith(st.filter)));
      const checks = s.checks.map((c) => s.id === 'clean_card_feed.py' && st.removedLine[s.id] && c[0] === 'Script-generation guardrail' ? ['Script-generation guardrail', 'passed', 'ok'] : c);
      const blocked = checks.some((c) => c[2] === 'danger');
      const run = st.runs[s.id];
      const stage = st.over[s.id] === 'in review' ? 1 : s.stage;

      const stepper = '<div class="scripts-steps">' + ['Ad-hoc script', 'Saved script', 'Published tool'].map((t, i) => '<div class="' + (i < stage ? 'done' : i === stage ? 'cur' : '') + '"><i></i><span>' + t + (i === 1 && stage === 1 && st.over[s.id] === 'in review' ? ' <span class="pill info" style="height:18px;font-size:11px">in review</span>' : '') + '</span></div>').join('') + '</div>';

      let side;
      if (st.tab === 'checks') {
        side = UI.table(['Check', 'Result'], checks.map((c) => ({ cells: [esc(c[0]), UI.pill(c[1], c[2])], attrs: 'data-check="' + esc(c[0]) + '"' })), { minWidth: '0', cls: 'scripts-checks' })
          + '<div class="fg2" style="font-size:12px">' + esc(st.removedLine[s.id] && s.id === 'clean_card_feed.py' ? 'Line 14 removed. All checks pass; the script can be submitted for promotion.' : s.note) + '</div>'
          + (blocked ? '<div>' + UI.btn('Remove line 14', { size: 'sm', attrs: 'data-removeline' }) + '</div>' : '')
          + '<div class="eyebrow">Dry run on sample input</div><pre class="codebox">' + esc(s.dry) + '</pre>';
      } else if (st.tab === 'dry') {
        side = UI.field('Sample input', UI.select([s.sample, 'blank input', 'previous run output'], s.sample)) + UI.kv([['Sandbox', 'gVisor, read-only root, tmpfs work dir'], ['Limits', '60 s, 512 MB, 64 KB output'], ['Network', 'none'], ['Files', 'in and out through MinIO']], 2)
          + '<div>' + UI.btn(run && run.phase === 'running' ? 'Running' : 'Run in sandbox', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-runsandbox', disabled: run && run.phase === 'running' }) + '</div>'
          + (run ? outputPane(s, run) : '<div class="eyebrow">Last dry run</div><pre class="codebox">' + esc(s.dry) + '</pre>');
      } else {
        side = run ? outputPane(s, run) : UI.empty('No output yet', 'Run once or run in the sandbox to see stdout, files produced and the limits used.', UI.btn('Run in sandbox', { size: 'sm', icon: 'play', attrs: 'data-runsandbox' }));
      }

      root.innerHTML = '<style>'
        + '.scripts-page > *{flex-shrink:0}.scripts-side > *{flex-shrink:0}'
        + '.scripts-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.scripts-steps > div{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--fg2)}.scripts-steps i{display:block;height:4px;border-radius:2px;background:var(--line)}.scripts-steps .done i,.scripts-steps .cur i{background:var(--ok-fg)}.scripts-steps .cur span{font-weight:700;color:var(--fg)}'
        + '.scripts-list{display:flex;flex-direction:column;gap:2px}.scripts-code{min-height:400px;max-height:560px}.scripts-code .codebox{min-height:400px}'
        + '.scripts-side{width:340px;flex-shrink:0;display:flex;flex-direction:column;gap:12px}.scripts-out{background:var(--fg);color:var(--bg);border-radius:6px;padding:10px 12px;font-family:var(--mono);font-size:12px;white-space:pre-wrap;margin:0;min-height:96px;overflow:auto}'
        + '@media (max-width:1100px){.scripts-side{width:100%}}'
        + '</style>'
        + '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Scripts</div>' + UI.btn('From template', { size: 'sm', attrs: 'data-templates' }) + '</div>'
        + UI.search('Filter scripts', 'data-search', st.query).replace('class="search"', 'class="search" style="width:100%"')
        + UI.seg([{ id: 'all', label: 'All' }, { id: 'Python', label: 'Python' }, { id: 'Node', label: 'Node.js' }], st.filter, 'data-rtseg')
        + '<div class="scripts-list">' + list.map((x) => UI.listItem(esc(x.id), esc(x.runtime + (x.version ? ', ' + x.version : '')), { active: x.id === s.id, attrs: 'data-script="' + esc(x.id) + '"', right: statusPill(st.over[x.id] || x.status) })).join('') + (list.length ? '' : UI.empty('No scripts match', 'Try another word or create one from a template.')) + '</div>'
        + '<div class="muted" style="font-size:12px;margin-top:auto">Promotion path: ad-hoc (one conversation), saved (workspace, versioned), published tool (tool-admin review, JSON Schema, signed).</div></div>'
        + '<div class="page scripts-page">' + UI.pagehead(s.id, esc(s.runtime) + ', ' + esc(s.packages), UI.btn('Diff ' + (s.version && s.version.startsWith('saved') ? 'v' + (parseInt(s.version.replace(/\D/g, ''), 10) - 1) : 'previous'), { attrs: 'data-diff', disabled: !(s.version && s.version.startsWith('saved')) }) + UI.btn('Run once', { icon: 'play', attrs: 'data-runonce' }) + (status === 'published tool' ? UI.btn('Open in Registry', { kind: 'primary', attrs: 'data-goreg' }) : status === 'in review' ? UI.btn('In review', { kind: 'primary', disabled: true }) : status === 'ad-hoc' ? UI.btn('Save to workspace', { kind: 'primary', attrs: 'data-save' }) : UI.btn('Submit for promotion', { kind: 'primary', attrs: 'data-promote' })))
        + stepper
        + (st.over[s.id] === 'in review' ? UI.notice('Submitted for promotion. A tool admin reviews the JSON Schema inputs and outputs, side-effect class and declared egress in the <a href="#" data-goreg>Registry</a>.', 'info') : '')
        + '<div class="cols"><div class="grow scripts-code" style="min-width:0">' + codeHtml(s, st) + '</div>'
        + '<div class="scripts-side">' + UI.tabs([{ id: 'checks', label: 'Checks' }, { id: 'dry', label: 'Dry run' }, { id: 'output', label: 'Output' }], st.tab) + side + '</div></div>'
        + UI.panel('Code interpreter sessions', (st.interpExpired ? UI.notice('The session in <b>Reconcile card feed</b> expired after 30 idle minutes. Files produced remain attached to the conversation; the next run starts a fresh sandbox.', 'warn', UI.btn('Open conversation', { size: 'sm', attrs: 'data-gochat' })) : '')
          + UI.table(['Conversation', 'Runtime', 'Runs', 'Idle', 'Expires', 'Files', ''], [['Reconcile card feed', 'Python 3.13', '6', st.interpExpired ? '30 m' : '12 m', st.interpExpired ? UI.pill('expired', 'danger') : 'in 18 m', 'cleaned.csv, variance.png', UI.btn('Open', { size: 'sm', kind: 'ghost', attrs: 'data-gochat' })], ['Q3 travel overrun', 'Node.js 24', '2', '3 m', 'in 27 m', 'none', UI.btn('Open', { size: 'sm', kind: 'ghost', attrs: 'data-gochat="c1"' })]], { clickable: false, cls: 'bare', minWidth: '0' })
          + '<div class="muted" style="font-size:12px">In chat, a model can run Python or Node repeatedly in a per-session sandbox and return output, files and charts. Sessions expire after 30 idle minutes.</div>')
        + UI.panel('Runtimes', UI.table(['Runtime', 'Image contents', 'Checks before any run'], RUNTIMES.map((r) => [esc(r[0]) + (st.twoRuntimes && !/Node|Python/.test(r[0]) ? ' ' + UI.pill('not offered', 'outline') : ''), esc(r[1]), esc(r[2])]), { clickable: false, cls: 'bare', minWidth: '0' }) + '<div class="muted" style="font-size:12px">Curated images, no network, gVisor or rootless container with a read-only root. Nothing is installed at run time; new packages arrive through the air-gap import path and an image rebuild.</div>')
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      if (st.openTemplates) { st.openTemplates = false; setTimeout(() => templateCatalog(ctx), 30); }
      if (bound) return; bound = true;

      const on = ctx.on;
      on('click', '[data-script]', (e, t) => { cur.st.sel = t.dataset.script; cur.st.hiLine = null; cur.ctx.rerender(); });
      on('input', '[data-search]', (e, t) => { cur.st.query = t.value; const v = t.value; cur.ctx.rerender(); const i = cur.ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      on('click', '[data-rtseg] [data-seg]', (e, t) => { cur.st.filter = t.dataset.seg; cur.ctx.rerender(); });
      on('click', '[data-tab]', (e, t) => { cur.st.tab = t.dataset.tab; cur.ctx.rerender(); });
      on('click', '.state-card', (e, t) => cur.ctx.app.applyState(+t.dataset.state));
      on('click', 'tr.row[data-check]', (e, t) => {
        const ctx = cur.ctx; const s = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel); const name = t.dataset.check; const c = s.checks.find((x) => x[0] === name);
        const detail = name === 'Bandit' ? 'B404 (low): import of subprocess-like module flagged by pattern match on line 14. Informational for a script with no network.' : name === 'Script-generation guardrail' ? (cur.st.removedLine[s.id] ? 'No disallowed modules, secrets or suspicious patterns.' : 'Disallowed module "requests" on line 14. Scripts have no network. Remove the import or promote the script and declare an internal destination.') : name === 'ESLint' ? 'prefer-const (line 3), no-unused-vars (line 4). Warnings do not block a run.' : 'No findings.';
        if (name === 'Script-generation guardrail' || name === 'Bandit') { cur.st.hiLine = cur.st.removedLine[s.id] ? null : 14; cur.st.tab = 'checks'; ctx.rerender(); }
        ctx.drawer({ title: esc(name) + ' ' + UI.pill(c[1], c[2]), body: '<div class="fg2">' + esc(detail) + '</div>' + UI.kv([['Runs', 'inside the sandbox, before any execution'], ['Runtime', esc(s.runtime)], ['Blocks a run', c[2] === 'danger' ? 'yes' : 'no']], 1) + (name === 'Script-generation guardrail' ? UI.notice('The checkpoint flags or blocks secrets, disallowed modules and suspicious patterns in generated scripts. Rules live in <a href="#" data-goguard>Guardrails</a>.', 'info') : ''), actions: (c[2] === 'danger' ? UI.btn('Remove line 14', { attrs: 'data-close data-removeline' }) : '') + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { const g = d.querySelector('[data-goguard]'); if (g) g.addEventListener('click', (ev) => { ev.preventDefault(); ctx.navigate('guardrails'); }); const r = d.querySelector('[data-removeline]'); if (r) r.addEventListener('click', () => removeLine(ctx)); } });
      });
      on('click', '[data-removeline]', () => removeLine(cur.ctx));
      on('click', '[data-runsandbox], [data-runonce]', () => runSandbox(cur.ctx));
      on('click', '[data-diff]', () => { const ctx = cur.ctx; const s = find(cur.st.sel); ctx.modal({ title: 'Diff ' + esc(s.id) + ': v3 to v4', body: '<pre class="codebox" data-lang="diff">' + ['@@ -8,4 +8,6 @@', '         key = (r["txn_id"], r["posted"])', '-        if key in seen: continue', '+        if key in seen:', '+            continue', '         seen.add(key)', '-        r["amount"] = float(r["amount"])', '+        r["amount"] = Decimal(r["amount"].replace(",", ""))'].map((l) => l.startsWith('+') ? '<span style="color:var(--ok-fg)">' + esc(l) + '</span>' : l.startsWith('-') ? '<span style="color:var(--danger-fg)">' + esc(l) + '</span>' : esc(l)).join('\n') + '</pre><div class="fg2" style="font-size:12px">v4 switches to Decimal so money never passes through binary floating point, matching the calc service.</div>', actions: UI.btn('Restore v3', { attrs: 'data-close data-restore' }) + UI.btn('Close', { kind: 'primary', attrs: 'data-close' }), cls: 'wide', onMount(m) { m.querySelector('[data-restore]').addEventListener('click', () => ctx.toast('v3 restored as v5. Versions are never overwritten.')); } }); });
      on('click', '[data-save]', async () => { const ctx = cur.ctx; const s = find(cur.st.sel) || cur.st.added.find((x) => x.id === cur.st.sel); const ok = await ctx.confirm({ title: 'Save ' + esc(s.id) + ' to the workspace', tag: 'saved', tone: 'info', body: '<p class="fg2" style="margin:0">Saved scripts are versioned in Finance Ops and can be run by members with the scripts:run scope. They still have no network.</p>', kv: [['Label', s.label], ['Version', 'v1']], ok: 'Save' }); if (ok) { cur.st.over[s.id] = 'saved'; s.version = 'saved v1'; s.stage = 1; ctx.rerender(); ctx.toast(esc(s.id) + ' saved as v1 in Finance Ops.', 'ok'); } });
      on('click', '[data-promote]', async () => {
        const ctx = cur.ctx; const st = cur.st; const s = find(st.sel) || st.added.find((x) => x.id === st.sel);
        const checks = s.checks.map((c) => s.id === 'clean_card_feed.py' && st.removedLine[s.id] && c[0] === 'Script-generation guardrail' ? ['Script-generation guardrail', 'passed', 'ok'] : c);
        const blocked = checks.some((c) => c[2] === 'danger');
        if (blocked) { ctx.modal({ title: 'Cannot submit ' + esc(s.id), body: UI.problem('Script-generation guardrail: blocked module', 'Line 14 imports requests. Scripts have no network. Remove the import, or declare an internal destination reached through the egress proxy once the tool is promoted.', 'd91f0b2a7c3e4f5061728394a5b6c7d8') + UI.table(['Check', 'Result'], checks.map((c) => [esc(c[0]), UI.pill(c[1], c[2])]), { clickable: false, minWidth: '0', cls: 'bare' }), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Remove line 14 and retry', { kind: 'primary', attrs: 'data-fix' }), onMount(m) { m.querySelector('[data-fix]').addEventListener('click', () => { App.closeOverlay(); removeLine(ctx); }); } }); return; }
        ctx.modal({ title: 'Submit ' + esc(s.id) + ' for promotion', body: '<p class="fg2" style="margin:0">Promotion creates a draft tool in the Registry. A tool admin reviews it; nothing reaches a tenant before review.</p><div class="formgrid">' + UI.field('Tool name', UI.input('cardfeed.clean')) + UI.field('Side-effect class', UI.select(['read-only', 'write', 'destructive', 'external-comms'], 'read-only')) + UI.field('Max label', UI.select(['public', 'internal', 'confidential', 'restricted'], s.label)) + UI.field('Egress allow-list', UI.input('none'), 'Internal destinations only, through the egress proxy') + '</div>' + UI.code('{ "input": { "csv": "MinIORef" },\n  "output": { "cleaned": "MinIORef", "dropped": "integer" } }', 'json') + UI.notice('Checks: ' + checks.map((c) => c[0] + ' ' + c[1]).join(', ') + '. The archive is signed with cosign on approval.', 'ok'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Submit', { kind: 'primary', attrs: 'data-ok' }), cls: 'wide', onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { App.closeOverlay(); st.over[s.id] = 'in review'; ctx.rerender(); ctx.toast('cardfeed.clean 0.1.0 submitted as a draft tool. <a href="#/registry?tab=review" style="color:inherit">Open the review queue</a>', 'ok', 6000); }); } });
      });
      on('click', '[data-goreg]', (e) => { e.preventDefault(); cur.ctx.navigate('registry', { entry: 'report.generate (script)' }); });
      on('click', '[data-gochat]', (e, t) => cur.ctx.navigate('chat', { convo: t.dataset.gochat || 'c4' }));
      on('click', '[data-templates]', () => templateCatalog(cur.ctx));
    }
  });

  function removeLine(ctx) { const st = ctx.state; st.removedLine[st.sel] = true; st.hiLine = null; ctx.rerender(); ctx.toast('Line 14 removed. Checks re-ran: all clean.', 'ok'); }

  function outputPane(s, run) {
    const limitsKv = run.phase === 'timeout' ? UI.kv([['CPU time', '60.0 s of 60 s'], ['Memory', '410 MB of 512 MB'], ['Output', '2 lines kept, 64 KB cap'], ['Exit', 'killed at cap']], 2) : run.phase === 'done' ? UI.kv([['CPU time', esc(s.dry.match(/runtime\s+([\d.]+ s)/) ? s.dry.match(/runtime\s+([\d.]+ s)/)[1] : '0.4 s') + ' of 60 s'], ['Memory', esc(s.dry.match(/, (\d+ MB)/) ? s.dry.match(/, (\d+ MB)/)[1] : '38 MB') + ' of 512 MB'], ['Files produced', s.output.includes('files produced') ? 'cleaned.csv' : 'none'], ['Exit', s.output.includes('exit 1') ? UI.pill('1', 'danger') : UI.pill('0', 'ok')]], 2) : '';
    return (run.phase === 'timeout' ? UI.notice('<b>Sandbox timeout.</b> The run stopped at the 60 s cap. Output so far is kept below.', 'warn', UI.btn('Run again', { size: 'sm', attrs: 'data-runsandbox' })) : '')
      + '<div class="hstack"><div class="eyebrow grow">' + (run.phase === 'running' ? 'Running in sandbox' : run.phase === 'timeout' ? 'Output, stopped at cap' : 'Output') + '</div>' + (run.phase === 'running' ? '<span class="muted" style="font-size:12px">' + esc(run.step) + '</span>' : UI.pill(run.phase === 'timeout' ? 'timed out' : s.output.includes('exit 1') ? 'exit 1' : 'exit 0', run.phase === 'timeout' ? 'warn' : s.output.includes('exit 1') ? 'danger' : 'ok')) + '</div>'
      + (run.phase === 'running' ? UI.meter(run.step, run.pct + '%', run.pct, 'accent') : '')
      + '<pre class="scripts-out">' + esc(run.lines.join('\n')) + (run.phase === 'running' ? '<span class="blink">▍</span>' : '') + '</pre>' + limitsKv;
  }

  function runSandbox(ctx) {
    const st = ctx.state; const s = find(st.sel) || st.added.find((x) => x.id === st.sel);
    if (st.runs[s.id] && st.runs[s.id].phase === 'running') return;
    if (s.blockedLine && !st.removedLine[s.id]) { ctx.toast('Refused before start: the script-generation guardrail blocked the requests import on line 14.', 'danger', 5000); st.tab = 'checks'; st.hiLine = 14; ctx.rerender(); return; }
    st.tab = st.tab === 'checks' ? 'output' : st.tab;
    const steps = [['Starting sandbox image ' + s.runtime.toLowerCase().replace(' ', '-'), 20], ['Running ' + (s.lang === 'python' ? 'ruff, Bandit' : 'node --check, ESLint'), 40], ['Staging sample input from MinIO', 55], ['Executing, no network', 80], ['Collecting output and files', 95]];
    const lines = s.output.split('\n'); let i = 0, li = 0;
    st.runs[s.id] = { phase: 'running', step: steps[0][0], pct: steps[0][1], lines: [] };
    ctx.rerender();
    const tick = () => {
      const r = st.runs[s.id];
      if (i < steps.length - 1) { i++; r.step = steps[i][0]; r.pct = steps[i][1]; if (i >= 3 && li < lines.length) r.lines.push(lines[li++]); ctx.rerender(); st.timer = setTimeout(tick, 380); return; }
      if (li < lines.length) { r.lines.push(lines[li++]); ctx.rerender(); st.timer = setTimeout(tick, 120); return; }
      r.phase = 'done'; ctx.rerender();
      ctx.toast(s.output.includes('exit 1') ? 'Run finished with exit 1. Saved scripts have no network.' : 'Run finished. Output labelled ' + esc(s.label) + ' and attached to this script.', s.output.includes('exit 1') ? 'warn' : 'ok');
    };
    clearTimeout(st.timer); st.timer = setTimeout(tick, 380);
  }

  function templateCatalog(ctx) {
    ctx.modal({
      title: 'Template catalog ' + UI.pill('platform, shared across tenants', 'outline'),
      body: '<p class="fg2" style="margin:0">Templates are versioned and parameterised with JSON Schema. Instantiating one always creates a draft that follows the normal review path.</p>'
        + UI.table(['Kind', 'Template', 'Produces', 'Runtimes', ''], TEMPLATES.map((t, i) => [UI.pill(t.kind, 'outline'), '<b>' + esc(t.name) + '</b>', esc(t.produces), esc(t.runtimes), UI.btn('Use', { size: 'sm', attrs: 'data-use="' + i + '"' })]), { clickable: false, minWidth: '0' }),
      actions: UI.btn('Close', { attrs: 'data-close' }), cls: 'wide',
      onMount(m) { m.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => templateForm(ctx, TEMPLATES[+b.dataset.use]))); }
    });
  }

  function templateForm(ctx, t) {
    const two = ctx.state.twoRuntimes; const isScript = t.kind === 'Script';
    const runtimes = two ? ['Node.js 24', 'Python 3.13'] : ['Python 3.13', 'Node.js 24', 'Tcl 9.0', 'Perl 5.40'];
    ctx.modal({
      title: 'New ' + esc(t.kind.toLowerCase()) + ' from template: ' + esc(t.name),
      body: '<div class="muted" style="font-size:12px">Parameter form generated from the template\'s JSON Schema, version 1.2.0.</div>'
        + '<div class="formgrid">' + (isScript ? UI.field('Runtime', UI.select(runtimes, runtimes[0], 'data-rt'), two ? 'Only Node.js 24 and Python 3.13 are offered in this workspace' : '') : '') + UI.field('Name', UI.input(isScript ? 'clean_vendor_feed.py' : t.name.toLowerCase().replace(/\s+/g, '-'), { attrs: 'data-name' }))
        + (isScript ? UI.field('Input columns', UI.input('txn_id, posted, merchant, amount')) + UI.field('Dedupe key', UI.input('txn_id, posted')) + UI.field('Amount format', UI.select(['decimal, thousands separator', 'integer cents'], 'decimal, thousands separator')) : t.kind === 'Tool' ? UI.field('Source', UI.input('openapi/ledger-api-v4.yaml')) + UI.field('Side-effect class', UI.select(['read-only', 'write'], 'read-only')) : t.kind === 'Agent' ? UI.field('Profile', UI.select(['analyst', 'chat-default', 'fast', 'coder'], 'analyst')) + UI.field('Limits', UI.input('20 steps, 10,000 tokens, 120 s')) : UI.field('Trigger', UI.select(['event upload.completed', 'cron schedule', 'manual'], 'event upload.completed')) + UI.field('Approval role', UI.input('knowledge curator')))
        + '<div class="span2">' + UI.field('Task for the model', UI.textarea(isScript ? 'Drop duplicate rows by txn_id and posted date, parse amounts as Decimal, write CSV to stdout.' : 'Describe what the draft should do.', { rows: 2 })) + '</div></div>'
        + (two ? UI.notice('<b>Two runtimes.</b> Finance Ops allows Node.js 24 and Python 3.13 only. Tcl and Perl images are installed but not offered here.', 'info') : '')
        + UI.notice('The draft passes the script-generation guardrail, then the language checks, then a dry run on sample input, before you can run it.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-ok' }), cls: 'wide',
      onMount(m) {
        m.querySelector('[data-ok]').addEventListener('click', () => {
          const name = (m.querySelector('[data-name]').value || '').trim() || 'draft'; const rt = m.querySelector('[data-rt]') ? m.querySelector('[data-rt]').value : '';
          App.closeOverlay();
          if (!isScript) { ctx.toast('Draft ' + esc(t.kind.toLowerCase()) + ' ' + esc(name) + ' created in the ' + (t.kind === 'Workflow' ? 'Workflows editor' : 'Registry') + '.', 'ok', 5000); setTimeout(() => ctx.navigate(t.kind === 'Workflow' ? 'workflows' : 'registry'), 800); return; }
          const st = ctx.state; st.added = st.added || [];
          const py = rt.startsWith('Python');
          st.added.push({ id: name, runtime: rt, version: '', status: 'ad-hoc', stage: 0, label: 'internal', packages: py ? 'curated wheels: pandas' : 'curated npm: none (built-ins only)', lang: py ? 'python' : 'javascript', code: py ? '# generated from template ' + t.name + ' 1.2.0\nimport csv, sys\nfrom decimal import Decimal\n\nKEY = ("txn_id", "posted")\n\ndef clean(rows):\n    seen = set()\n    for r in rows:\n        k = tuple(r[c] for c in KEY)\n        if k in seen:\n            continue\n        seen.add(k)\n        r["amount"] = Decimal(r["amount"].replace(",", ""))\n        yield r' : "// generated from template " + t.name + " 1.2.0\nimport { parse } from 'node:csv';\nconst seen = new Set();\nexport function clean(rows) {\n  return rows.filter((r) => { const k = r.txn_id + '|' + r.posted; if (seen.has(k)) return false; seen.add(k); return true; });\n}", checks: py ? [['ruff', 'clean', 'ok'], ['Bandit', 'clean', 'ok'], ['Script-generation guardrail', 'passed', 'ok'], ['Secrets scan', 'clean', 'ok']] : [['node --check', 'clean', 'ok'], ['ESLint', 'clean', 'ok'], ['Script-generation guardrail', 'passed', 'ok'], ['Secrets scan', 'clean', 'ok']], note: 'Generated draft. Checks passed; run a dry run on sample input, then run once, save, or submit for promotion.', dry: 'not run yet', sample: 'vendor-feed-sample.csv (120 rows, internal)', output: 'txn_id,posted,merchant,amount\n9001,2026-09-04,Fabrikam,1200.00\n… 118 more rows\n\nfiles produced: cleaned.csv (9 KB)' });
          st.sel = name; st.tab = 'checks'; ctx.rerender(); ctx.toast('Draft ' + esc(name) + ' created from ' + esc(t.name) + '. Guardrail and language checks passed.', 'ok');
        });
      }
    });
  }
})();
