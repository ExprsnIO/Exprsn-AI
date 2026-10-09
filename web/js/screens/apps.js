(function () {
  const { UI, esc } = App;

  // ---------- constants and formatting ----------
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l) + 1;
  const TYPES = ['string', 'number', 'boolean', 'date', 'enum', 'reference', 'lookup', 'file', 'json', 'formula', 'ai'];
  const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'startsWith', 'exists'];
  const SYSTEM_FIELDS = ['id', 'state', 'createdAt', 'updatedAt', 'createdBy'];
  const FUNCS = ['if', 'coalesce', 'isblank', 'concat', 'upper', 'lower', 'trim', 'len', 'left', 'right', 'mid', 'contains', 'replace', 'round', 'floor', 'ceil', 'abs', 'min', 'max', 'sum', 'number', 'text', 'today', 'now', 'year', 'month', 'day', 'add_days', 'days_between'];
  const EVENTS = ['created', 'updated', 'deleted', 'transitioned'];
  const RESERVED = ['id', 'state', 'label', 'version', 'created_at', 'updated_at', 'created_by', 'updated_by', 'createdat', 'updatedat', 'createdby', 'updatedby'];
  const PAGE = 25;
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const overlayOpen = () => !!document.getElementById('overlay');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || false;
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Request failed';
  const who = (id) => (!id ? 'no one (a public form)' : App.me && App.me.user && App.me.user.id === id ? 'you' : 'user ' + id.slice(-6));
  const fmtNum = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-GB'));
  const A = (app) => '/api/apps/' + enc(app);
  const E = (app, ent) => A(app) + '/entities/' + enc(ent);
  const clearance = () => (App.me && App.me.user && App.me.user.clearance) || 'internal';
  const wsName = (id) => { const w = ((App.me && App.me.workspaces) || []).find((x) => x.id === id); return w ? w.name : 'another workspace'; };
  const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

  // ---------- definitions ----------
  const fieldsOf = (e) => (e && e.definition && e.definition.fields) || [];
  const smOf = (e) => (e && e.definition && e.definition.states) || null;
  const computed = (f) => f.type === 'formula' || f.type === 'ai';
  const remote = (f) => f.type === 'reference' || (f.type === 'lookup' && f.source !== 'static');
  const indexedFields = (e) => fieldsOf(e).filter((f) => f.indexed || f.unique);
  const gridFields = (e) => { const i = indexedFields(e); return i.length ? i : fieldsOf(e).filter((f) => f.type !== 'json').slice(0, 4); };
  const fieldByName = (e, n) => fieldsOf(e).find((f) => f.name === n) || null;
  const optList = (f) => (f.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label || o.value }));
  const stateTone = (s) => (/approv|done|issued|closed|complete/.test(s || '') ? 'ok' : /reject|fail|retir/.test(s || '') ? 'danger' : /review|progress|pending/.test(s || '') ? 'info' : '');
  const srcPill = (s) => UI.pill(s, s === 'form' ? 'info' : s === 'workflow' ? 'accent' : s === 'import' ? 'outline' : '');
  const aiPill = (s) => (s ? UI.pill(s, s === 'filled' ? 'ok' : s === 'failed' ? 'danger' : 'warn') : '<span class="muted">none</span>');

  const detail = (f) => {
    const bits = [];
    if (f.type === 'string') { if (f.maxLength) bits.push('maxLength ' + f.maxLength); if (f.minLength) bits.push('minLength ' + f.minLength); if (f.pattern) bits.push('pattern'); if (f.multiline) bits.push('multiline'); }
    if (f.min != null) bits.push('min ' + f.min); if (f.max != null) bits.push('max ' + f.max); if (f.integer) bits.push('integer'); if (f.withTime) bits.push('with time');
    if (f.options && f.options.length) bits.push(optList(f).map((o) => o.value).join(' | '));
    if (f.entity) bits.push('→ ' + f.entity + (f.display ? ' / ' + f.display : ''));
    if (f.type === 'lookup' && f.source !== 'static') bits.push('source ' + f.source);
    if (f.type === 'json' && f.maxBytes) bits.push('maxBytes ' + fmtNum(f.maxBytes));
    if (f.type === 'ai' && f.maxLength) bits.push('maxLength ' + f.maxLength);
    const html = bits.map(esc);
    if (f.expression) html.push('<span class="mono">' + esc(f.expression) + '</span>');
    if (f.type === 'ai') html.unshift('profile ' + (App.canOpen('profiles') ? '<a href="#" data-goprofile="' + esc(f.profile) + '">' + esc(f.profile) + '</a>' : esc(f.profile)));
    return html.join(', ');
  };
  // An advisory check while typing; the server checks the formula when the entity is saved.
  function checkFormula(expr, fields) {
    if (!expr || !expr.trim()) return 'Empty expression';
    let depth = 0; for (const ch of expr) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) return 'Unbalanced parentheses'; } if (depth) return 'Unbalanced parentheses';
    const names = (expr.replace(/"[^"]*"/g, '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);
    for (const n of names) { if (['and', 'or', 'not', 'true', 'false'].includes(n) || FUNCS.includes(n)) continue; const f = fields.find((x) => x.name === n); if (!f) return 'Unknown name ' + n + ' (only the entity\'s fields and the formula functions)'; if (computed(f)) return 'Field ' + n + ' is computed; a formula reads the entity\'s other fields'; }
    return null;
  }
  const condOk = (c, values) => {
    if (!c) return true;
    const v = values[c.field]; const norm = (x) => (typeof x === 'string' ? x.toLowerCase() : x);
    switch (c.op) {
      case 'truthy': return v != null && v !== '' && v !== false && v !== 0;
      case 'falsy': return v == null || v === '' || v === false || v === 0;
      case 'eq': return norm(v) === norm(c.value);
      case 'ne': return norm(v) !== norm(c.value);
      case 'in': return Array.isArray(c.value) && c.value.map(norm).indexOf(norm(v)) >= 0;
      default: return true;
    }
  };

  // A control for one field's value. `opts` are the options of a reference or lookup loaded from the server; without
  // them the control takes the id as text.
  const fieldControl = (f, v, attr, opts) => {
    const a = 'data-fv="' + esc(f.name) + '" ' + (attr || '');
    const empty = { value: '', label: 'empty' };
    if (f.type === 'boolean') return UI.select([empty, { value: 'true', label: 'yes' }, { value: 'false', label: 'no' }], v == null || v === '' ? '' : String(v), a);
    if (f.type === 'enum' || (f.type === 'lookup' && f.source === 'static')) return UI.select([empty].concat(optList(f)), v == null ? '' : String(v), a);
    if (remote(f)) {
      if (opts) { const list = opts.slice(); if (v && !list.some((o) => o.value === v)) list.push({ value: v, label: v }); return UI.select([empty].concat(list), v || '', a); }
      return UI.input(v || '', { placeholder: f.type === 'reference' ? 'record id' : 'id', attrs: a });
    }
    if (f.type === 'string' && f.multiline) return UI.textarea(v || '', { rows: 2, attrs: a });
    if (f.type === 'json') return UI.textarea(v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v), { rows: 2, attrs: a + ' spellcheck="false"' });
    if (f.type === 'date') return UI.input(v || '', { placeholder: f.withTime ? 'YYYY-MM-DDTHH:MM:SSZ' : 'YYYY-MM-DD', attrs: a });
    if (f.type === 'number') return UI.input(v == null ? '' : v, { type: 'number', attrs: a + ' step="any"' });
    if (f.type === 'file') return UI.input(v || '', { placeholder: 'file id from Files', attrs: a });
    return UI.input(v || '', { attrs: a });
  };
  // Reads [data-fv] controls into typed values; `bad` names JSON fields that do not parse.
  const readValues = (m, e) => {
    const values = {}; const bad = [];
    m.querySelectorAll('[data-fv]').forEach((el) => {
      const f = fieldByName(e, el.dataset.fv); if (!f) return;
      const v = el.value;
      if (v === '') values[f.name] = null;
      else if (f.type === 'number') values[f.name] = Number(v);
      else if (f.type === 'boolean') values[f.name] = v === 'true';
      else if (f.type === 'json') { try { values[f.name] = JSON.parse(v); } catch (x) { bad.push(f.name); } }
      else values[f.name] = v;
    });
    return { values, bad };
  };
  const optionsFromLines = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf('|'); return i > 0 ? { value: s.slice(0, i).trim(), label: s.slice(i + 1).trim() } : { value: s }; });
  const linesFromOptions = (f) => (f.options || []).map((o) => (o.label && o.label !== o.value ? o.value + ' | ' + o.label : o.value)).join('\n');

  App.register({
    id: 'apps', title: 'Apps', live: true, summary: 'Low-code data apps: entity designer, records grid, forms, state machines, triggers',
    crumb: (st) => { const a = (st.apps || []).find((x) => x.id === st.app); return ['Apps'].concat(a ? [a.title || a.name] : []); },
    label: (st) => { const a = (st.apps || []).find((x) => x.id === st.app); return a ? a.label : null; },
    commands: [
      { label: 'New record in the current app', sub: 'Apps', run(app) { const s = app.stateFor('apps'); s.tab = 'records'; s.openNew = true; app.render(); } },
      { label: 'Design an entity with a model', sub: 'Apps', run(app) { const s = app.stateFor('apps'); s.tab = 'entities'; s.openDraft = true; app.render(); } }
    ],
    states: [
      { title: 'Illegal transition', tone: 'danger', text: '409 with the transitions the record may take from its state. The button for the illegal one is disabled; the problem names the allowed ones.',
        apply(ctx) {
          const st = ctx.state; const d = st.detail; const ent = d ? d.entities.find((e) => smOf(e)) : null;
          st.tab = 'records';
          if (!ent) { st.problem = { kind: 'illegal', title: 'Illegal transition', text: 'A transition the record\'s state does not allow is refused with 409, naming the allowed ones. No entity of this app has a state machine yet; add one on the Entities tab.' }; ctx.rerender(); return; }
          st.entity = ent.id;
          const sm = smOf(ent); const rec = st.recs && st.recs.records.find((r) => r.state); const from = rec ? rec.state : sm.initial;
          if (rec) st.record = rec.id;
          const allowed = sm.transitions.filter((t) => t.from.indexOf('*') >= 0 || t.from.indexOf(from) >= 0).map((t) => t.name || t.to);
          const illegal = sm.states.map((s) => s.name).filter((n) => n !== from && !sm.transitions.some((t) => t.to === n && (t.from.indexOf('*') >= 0 || t.from.indexOf(from) >= 0)));
          st.problem = { kind: 'illegal', title: 'Illegal transition', text: (rec ? 'Record ' + rec.id + ' is in ' + from + '. ' : 'A record in ' + from + '. ') + 'From ' + from + ' ' + ent.title + ' allows: ' + (allowed.join(', ') || 'nothing') + '.' + (illegal.length ? ' Moving to ' + illegal[0] + ' is refused with 409 (allowed: ' + JSON.stringify(allowed) + ').' : '') };
          ctx.rerender();
        } },
      { title: 'Stale version', tone: 'warn', text: 'A write carrying an older version is refused with 409. The inspector offers to reload the record.',
        apply(ctx) { const st = ctx.state; st.tab = 'records'; const rec = st.recs && st.recs.records[0]; if (rec) st.record = rec.id; st.problem = { kind: 'stale', title: 'Record changed since you opened it', text: rec ? 'An edit carrying version ' + rec.version + ' is refused with 409 once someone writes version ' + (rec.version + 1) + '. Reload the record and apply your change again.' : 'An edit carrying an older version is refused with 409. Reload the record and apply your change again.' }; ctx.rerender(); } },
      { title: 'AI fill failed', tone: 'warn', text: 'The record is saved and the ai field is empty, with aiState failed and the reason. The fill job retries on the next write.',
        apply(ctx) { const st = ctx.state; st.tab = 'records'; const rec = st.recs && st.recs.records.find((r) => r.aiState === 'failed'); if (rec) st.record = rec.id; st.problem = null; st.aiNote = true; ctx.rerender(); } },
      { title: 'Import with bad rows', tone: 'info', text: 'The import job writes the good rows and reports the bad ones (row, problem), up to 500.',
        apply(ctx) { const st = ctx.state; st.tab = 'records'; st.openImport = true; ctx.rerender(); } },
      { title: 'Bundle refused', tone: 'danger', text: 'A bundle changed after signing, signed elsewhere or naming another key is 422. Nothing is created and the refusal is audited.',
        apply(ctx) { const st = ctx.state; st.bundleProblem = { title: 'Bundle refused', text: 'The signature does not cover what arrived: the bundle was changed after signing, signed by another instance or names another key. Nothing was created; audited as app.import.refused.', trace: false }; ctx.rerender(); } },
      { title: 'Promotion waits for approval', tone: 'info', text: 'A promotion to production starts the pipeline\'s approval workflow with the deployment as its input and waits (awaiting-approval). The approver decides it on Workflows; a rejection ends the deployment and tells the requester.',
        apply(ctx) { const st = ctx.state; st.tab = 'deployments'; st.depProblem = null; st.depNote = { kind: 'warn', text: 'Deployment to production is awaiting approval: the run of the approval workflow started with the deployment as its input. Nothing else moves until an approver decides it on Workflows.' }; ctx.rerender(); } },
      { title: 'Stage cannot be skipped', tone: 'warn', text: 'Production takes the exact package the last successful promotion to test landed. Before anything passed test, a promotion to production is 409 "Nothing has passed test yet".',
        apply(ctx) { const st = ctx.state; st.tab = 'deployments'; st.depProblem = { title: 'Nothing has passed test yet', text: 'Promote to test first: a stage cannot be skipped, and production only ever lands a package that passed test (409).' }; ctx.rerender(); } },
      { title: 'Rollback restores the backup', tone: 'neutral', text: 'Every deployment backs the target up first. A rollback deploys that backup onto the same stage, as its own deployment with its own backup, and is audited app.package.rolled_back. An entity that still holds records is kept and reported.',
        apply(ctx) { const st = ctx.state; st.tab = 'deployments'; st.depProblem = null; st.depNote = { kind: 'ok', text: 'Rolled back: the backup taken before the deployment was deployed onto the same stage. Entities that still hold records were kept and are listed in the report. Audit event app.package.rolled_back written.' }; ctx.rerender(); } },
      { title: 'Package refused from git', tone: 'danger', text: 'A package read from a repository is verified like one pasted in: a file edited after the push no longer matches the signature in package.json, the import is 422 and audited app.import.refused.',
        apply(ctx) { const st = ctx.state; st.tab = 'deployments'; st.depProblem = { title: 'Package refused', text: 'entities/vendor.json was changed after the package was signed: the signature in package.json does not verify. Nothing was created; audited as app.import.refused.' }; ctx.rerender(); } },
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.init) { Object.assign(st, { init: true, tab: 'entities', query: '', filters: [], filterMode: 'and', sorts: [{ field: 'updatedAt', dir: 'desc' }], stateFilter: 'all', page: 0, cursors: [null], selected: {}, optCache: {}, transfers: {}, preview: {} }); }
      const design = App.can('apps:design');
      const canWrite = App.can('records:write');

      // ---------- loading ----------
      const refresh = () => { if (App.state.route !== 'apps') return; if (overlayOpen()) { st.dirty = true; return; } ctx.rerender(); };
      st.refresh = refresh;
      const loadApps = () => {
        if (st.loadingApps) return;
        st.loadingApps = true;
        App.get('/api/apps')
          .then((d) => { st.apps = d.apps; st.loaded = true; st.loadError = null; st.detailKey = st.busyDetail = null; st.recsKey = st.busyRecs = null; })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loadingApps = false; refresh(); });
      };
      if (!st.loaded && !st.loadError) { loadApps(); }
      const style = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .apps-sm{display:block;max-width:100%;height:auto}'
        + '#main .apps-sm text{font:600 11px var(--sans);fill:var(--fg)}#main .apps-sm .box{fill:var(--panel);stroke:var(--line2)}#main .apps-sm .initial{stroke:var(--accent);stroke-width:1.6}#main .apps-sm .arrow{stroke:var(--fg2);fill:none}#main .apps-sm .tl{font-weight:500;fill:var(--fg2);font-size:10px}'
        + '#main .apps-fieldname{font-weight:600}#main .apps-bulk{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;background:var(--accent-tint);border-radius:6px}'
        + '#main .apps-preview{border:1px dashed var(--line2);border-radius:6px;padding:12px;display:flex;flex-direction:column;gap:10px;max-width:520px;min-width:0}'
        + '#main .apps-ff{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}#main .apps-ff > *{min-width:0;overflow-wrap:anywhere}#main .apps-ff .apps-ffa{margin-left:auto;display:flex;gap:4px}'
        + '#main .apps-token{overflow-wrap:anywhere;word-break:break-all}'
        + '#main .apps-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}#main .apps-chip{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--line2);border-radius:999px;padding:0 2px 0 10px;font-size:12px}'
        + '</style>';
      const head = (sub, actions) => UI.pagehead('Apps', sub || 'Low-code data apps: entities, records, forms and triggers', actions || '');
      if (st.loadError) {
        root.innerHTML = style + '<div class="page">' + head() + UI.problem('Apps could not be loaded', detailOf(st.loadError), traceOf(st.loadError)) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div></div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      if (!st.loaded) { root.innerHTML = style + '<div class="page">' + head() + UI.notice('Loading…', 'info') + '</div>'; return; }

      if (ctx.params.app) { const p = st.apps.find((a) => a.id === ctx.params.app || a.name === ctx.params.app); if (p) st.app = p.id; delete ctx.params.app; }
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }
      if (!design && (st.tab === 'triggers' || st.tab === 'api' || st.tab === 'embed')) st.tab = 'entities';
      if (!st.app || !st.apps.some((a) => a.id === st.app)) st.app = st.apps[0] ? st.apps[0].id : null;
      const appSummary = st.apps.find((a) => a.id === st.app) || null;

      // The app's entities, forms and (for designers) triggers.
      if (appSummary && st.detailKey !== appSummary.id && st.busyDetail !== appSummary.id) {
        const key = appSummary.id; st.busyDetail = key; const seq = st.detailSeq = (st.detailSeq || 0) + 1;
        App.get(A(key))
          .then((d) => { if (st.detailSeq !== seq) return; st.detail = d; st.detailKey = key; st.detailError = null; })
          .catch((err) => { if (st.detailSeq !== seq) return; st.detailError = err; st.detailKey = key; if (err.status === 404) { st.loaded = false; } })
          .finally(() => { if (st.detailSeq === seq) st.busyDetail = null; refresh(); });
      }
      const app = st.detail && appSummary && st.detail.id === appSummary.id ? st.detail : null;

      // ----- left pane -----
      const appMatches = (a) => !st.appQuery || ((a.title || '') + ' ' + a.name + ' ' + (a.description || '')).toLowerCase().indexOf(st.appQuery.toLowerCase()) >= 0;
      const appItems = () => st.apps.filter(appMatches).map((a) => UI.listItem(esc(a.title || a.name), esc(a.scope === 'tenant' ? 'Tenant-wide' : wsName(a.workspaceId)), { active: a.id === st.app, attrs: 'data-app="' + esc(a.id) + '"', right: UI.label(a.label, { sm: true }) })).join('') || UI.empty(st.apps.length ? 'No apps match' : 'No apps yet', st.apps.length ? 'Clear the filter.' : (design ? 'Create one, or import a signed bundle.' : 'A workflow admin or tenant admin designs apps for your workspace.'));
      const left = '<div class="leftpane"><div class="hstack"><div class="eyebrow grow">Apps, ' + st.apps.length + ' visible</div>' + (design ? UI.iconbtn('plus', 'New app', { attrs: 'data-newapp', cls: 'sm ghost' }) : '') + '</div>'
        + UI.search('Filter apps', 'data-appsearch', st.appQuery || '')
        + '<div class="vstack gap4" data-applist>' + appItems() + '</div>'
        + (st.bundleProblem ? UI.problem(st.bundleProblem.title, st.bundleProblem.text, st.bundleProblem.trace) + '<div>' + UI.btn('Dismiss', { size: 'xs', kind: 'ghost', attrs: 'data-dismissbundle' }) + '</div>' : '')
        + (design ? '<div class="hstack gap6 wrap" style="margin-top:auto">' + UI.btn('Import bundle', { size: 'sm', icon: 'upload', attrs: 'data-import-bundle' }) + (app ? UI.btn('Export', { size: 'sm', icon: 'download', attrs: 'data-export-bundle' }) : '') + '</div>' : '')
        + '</div>';

      const pageProblem = st.problem ? UI.problem(st.problem.title, st.problem.text, st.problem.trace || false) + '<div class="hstack gap6">' + (st.problem.kind === 'stale' && st.record ? UI.btn('Reload record', { size: 'sm', attrs: 'data-reloadrec' }) : '') + UI.btn('Dismiss', { size: 'sm', kind: 'ghost', attrs: 'data-dismissproblem' }) + '</div>' : '';

      let page, inspector = '';
      if (!appSummary) {
        page = head('', design ? UI.btn('New app', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newapp' }) : '') + pageProblem + UI.empty('No apps yet', design ? 'An app groups entities, their records, forms and triggers. Create one for your workspace or the whole tenant.' : 'No app is shared with your workspaces yet. A workflow admin or tenant admin designs them.', design ? UI.btn('New app', { kind: 'primary', attrs: 'data-newapp' }) : '');
      } else if (!app) {
        page = UI.pagehead(appSummary.title || appSummary.name, esc(appSummary.description || ''), '') + (st.detailError && st.detailKey === appSummary.id ? UI.problem('The app could not be loaded', detailOf(st.detailError), traceOf(st.detailError)) + '<div>' + UI.btn('Try again', { attrs: 'data-reloaddetail' }) + '</div>' : UI.notice('Loading…', 'info'));
      } else {
        if (!st.entity || !app.entities.some((e) => e.id === st.entity)) st.entity = app.entities[0] ? app.entities[0].id : null;
        const ent = app.entities.find((e) => e.id === st.entity) || null;
        const tabs = UI.tabs([{ id: 'entities', label: 'Entities', count: app.entities.length }, { id: 'records', label: 'Records', count: st.recs && ent && st.recs.ek === app.id + '/' + ent.id ? st.recs.total : null }, { id: 'forms', label: 'Forms', count: app.forms.length }].concat(design ? [{ id: 'policies', label: 'Policies', count: st.polKey === app.id && st.pol ? (st.pol.policies || []).length : null }, { id: 'triggers', label: 'Triggers', count: (app.triggers || []).length }, { id: 'deployments', label: 'Deployments', count: st.depKey === app.id && st.dep ? st.dep.history.length : null }, { id: 'api', label: 'API', count: st.schemaKey === app.id && st.schema ? st.schema.version : null }, { id: 'embed', label: 'Embed', count: st.embedKey === app.id && st.embed ? (st.embed.keys.filter((k) => k.state === 'active').length + st.embed.pages.length) : null }] : []), st.tab);
        let body = '';
        if (st.tab === 'entities') body = renderEntities(ctx, app, ent, design);
        else if (st.tab === 'records') { const r = renderRecords(ctx, app, ent, design, canWrite); body = r.body; inspector = r.inspector; }
        else if (st.tab === 'forms') body = renderForms(ctx, app, design, canWrite);
        else if (st.tab === 'policies' && design) body = renderPolicies(ctx, app);
        else if (st.tab === 'deployments' && design) body = renderDeployments(ctx, app);
        else if (st.tab === 'api' && design) body = renderApi(ctx, app);
        else if (st.tab === 'embed' && design) body = renderEmbed(ctx, app);
        else body = renderTriggers(ctx, app);
        const scope = app.scope === 'tenant' ? 'Tenant-wide' : 'Workspace ' + wsName(app.workspaceId);
        page = UI.pagehead(app.title || app.name, (app.description ? esc(app.description) + ' ' : '') + '<span class="muted">' + esc(scope) + ', by ' + esc(who(app.createdBy)) + ', updated ' + esc(when(app.updatedAt)) + '</span>', UI.label(app.label) + (design ? UI.btn('Edit app', { size: 'sm', icon: 'edit', attrs: 'data-editapp' }) + UI.btn('Delete app', { size: 'sm', kind: 'ghost', attrs: 'data-delapp' }) : ''))
          + tabs + pageProblem + body;
      }
      root.innerHTML = style + left + '<div class="page">' + page + '</div>' + inspector;

      // ----- shared events -----
      ctx.on('click', '[data-app]', (e, t) => { st.app = t.dataset.app; st.entity = null; st.record = null; st.recordObj = null; st.problem = null; st.filters = []; st.stateFilter = 'all'; st.query = ''; resetPaging(st); st.selected = {}; st.form = null; st.fdraft = null; st.importReport = null; ctx.rerender(); });
      ctx.on('input', '[data-appsearch]', (e, t) => { st.appQuery = t.value; const list = root.querySelector('[data-applist]'); if (list) list.innerHTML = appItems(); });
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; st.problem = null; ctx.rerender(); });
      ctx.on('click', '[data-reloaddetail]', () => { st.detailKey = st.busyDetail = null; st.detailError = null; ctx.rerender(); });
      ctx.on('click', '[data-dismissproblem]', () => { st.problem = null; ctx.rerender(); });
      ctx.on('click', '[data-dismissbundle]', () => { st.bundleProblem = null; ctx.rerender(); });
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', '[data-goworkflow]', (e, t) => { e.preventDefault(); ctx.navigate('workflows', t.dataset.goworkflow ? { id: t.dataset.goworkflow } : undefined); });
      ctx.on('click', '[data-gorun]', (e, t) => { e.preventDefault(); ctx.navigate('runs', { run: t.dataset.gorun }); });
      ctx.on('click', '[data-newapp]', () => openAppModal(ctx, null));
      if (app) {
        ctx.on('click', '[data-editapp]', () => openAppModal(ctx, app));
        ctx.on('click', '[data-delapp]', async () => {
          const ok = await ctx.confirm({ title: 'Delete ' + (app.title || app.name), tag: 'deletes records', tone: 'danger', body: '<p class="fg2" style="margin:0">Deletes the app with its entities, every record, its forms, triggers and transfers. The audit event records the counts.</p>', kv: [['Entities', app.entities.length], ['Forms', app.forms.length], ['Triggers', (app.triggers || []).length]], ok: 'Delete app' });
          if (!ok) return;
          try { await App.del(A(app.id)); st.app = null; st.detail = null; st.detailKey = st.busyDetail = null; st.loaded = false; ctx.rerender(); ctx.toast(esc(app.title || app.name) + ' deleted. Audit event app.deleted written with counts.', 'warn'); } catch (err) { App.fail(err, 'Could not delete the app'); }
        });
        ctx.on('click', '[data-export-bundle]', () => openExportBundle(ctx, app));
      }
      ctx.on('click', '[data-import-bundle]', () => openImportBundle(ctx));
      ctx.on('click', '[data-reloadrec]', async () => {
        const ent = app && app.entities.find((e) => e.id === st.entity); if (!ent || !st.record) return;
        try { const r = await App.get(E(app.id, ent.id) + '/records/' + enc(st.record)); st.recordObj = r; st.problem = null; st.recsKey = st.busyRecs = null; ctx.rerender(); ctx.toast('Record reloaded at version ' + r.version + '.', 'ok'); } catch (err) { App.fail(err, 'Could not reload the record'); }
      });

      // Requests from the command palette and design states, once the data is there.
      if (app) {
        const ent = app.entities.find((e) => e.id === st.entity) || null;
        // Wait for the records to load first: a dialog open over the grid would hold back its re-render.
        const waiting = ent && st.tab === 'records' && !(st.recs && st.recs.ek === app.id + '/' + ent.id);
        if (waiting) { /* opened on the render after the load */ }
        else if (st.openNew) { st.openNew = false; if (ent && canWrite) openRecordModal(ctx, app, ent, null); else if (!ent) ctx.toast('This app has no entity yet; design one first.', 'warn'); }
        else if (st.openDraft) { st.openDraft = false; if (design) openDraftModal(ctx, app); else ctx.toast('Designing entities needs apps:design.', 'warn'); }
        else if (st.openImport) { st.openImport = false; if (ent && canWrite) openImportModal(ctx, app, ent); else if (!ent) ctx.toast('This app has no entity to import into yet.', 'warn'); }
      } else if (!appSummary && (st.openNew || st.openDraft || st.openImport)) { st.openNew = st.openDraft = st.openImport = false; ctx.toast('No app yet. Create one first.', 'warn'); }
    }
  });

  function resetPaging(st) { st.page = 0; st.cursors = [null]; }
  // Opens a modal whose close re-renders the screen if data arrived meanwhile.
  function modal(ctx, opts) {
    const st = ctx.state; const onClose = opts.onClose;
    return ctx.modal(Object.assign({}, opts, { onClose() { if (onClose) onClose(); if (st.dirty) { st.dirty = false; setTimeout(() => { if (st.refresh) st.refresh(); }, 0); } } }));
  }
  function afterChange(ctx, opts) {
    const st = ctx.state;
    if (opts.apps) st.loaded = false;
    if (opts.detail !== false) st.detailKey = st.busyDetail = null;
    if (opts.records) st.recsKey = st.busyRecs = null;
    App.closeOverlay();
    ctx.rerender();
  }

  // ---------- apps ----------
  function openAppModal(ctx, app) {
    const st = ctx.state;
    const labels = LABELS.filter((l) => rank(l) <= rank(clearance()));
    const scopes = ((App.me && App.me.workspaces) || []).map((w) => ({ value: w.id, label: 'Workspace: ' + w.name })).concat([{ value: '', label: 'Tenant-wide' }]);
    const body = '<div class="formgrid">'
      + (app ? '' : UI.field('Name', UI.input('', { placeholder: 'lower-case letters, digits and _', attrs: 'data-na-name' }), 'Unique in its workspace.'))
      + UI.field('Title', UI.input(app ? app.title || '' : '', { attrs: 'data-na-title' }))
      + UI.field('Label', UI.select(labels, app ? app.label : 'internal', 'data-na-label'), app ? 'Lowering the label is refused while entities or records sit above it.' : 'The highest label its records may carry; at most your clearance and the workspace ceiling.')
      + (app ? '' : UI.field('Scope', UI.select(scopes, (App.me && App.me.workspace) || '', 'data-na-scope')))
      + '<div class="span2">' + UI.field('Description', UI.textarea(app ? app.description || '' : '', { rows: 2, attrs: 'data-na-desc' })) + '</div></div><div data-na-err></div>';
    modal(ctx, { title: app ? 'Edit ' + esc(app.title || app.name) : 'New app', body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(app ? 'Save' : 'Create app', { kind: 'primary', attrs: 'data-na-ok' }),
      onMount(m) {
        m.querySelector('[data-na-ok]').addEventListener('click', async () => {
          const err = m.querySelector('[data-na-err]'); err.innerHTML = '';
          const title = m.querySelector('[data-na-title]').value.trim(); const desc = m.querySelector('[data-na-desc]').value;
          try {
            if (app) {
              const body = { label: m.querySelector('[data-na-label]').value, description: desc || null }; if (title) body.title = title;
              await App.patch(A(app.id), body);
              afterChange(ctx, { apps: true }); ctx.toast('App saved. Audit event app.updated written.', 'ok');
            } else {
              const name = m.querySelector('[data-na-name]').value.trim();
              if (!NAME_RE.test(name)) { err.innerHTML = UI.notice('A name is lower-case letters, digits and _, starting with a letter.', 'warn'); return; }
              const body = { name, label: m.querySelector('[data-na-label]').value }; if (title) body.title = title; if (desc) body.description = desc;
              const scope = m.querySelector('[data-na-scope]').value; body.workspaceId = scope || null;
              const out = await App.post('/api/apps', body);
              st.app = out.id; st.tab = 'entities'; st.entity = null;
              afterChange(ctx, { apps: true }); ctx.toast('App ' + esc(out.name) + ' created. Audit event app.created written.', 'ok');
            }
          } catch (e) { err.innerHTML = UI.notice('<b>' + esc(e.status ? String(e.status) : '') + '</b> ' + esc(detailOf(e)), 'danger'); }
        });
      } });
  }

  function openImportBundle(ctx) {
    const st = ctx.state;
    const scopes = ((App.me && App.me.workspaces) || []).map((w) => ({ value: w.id, label: w.name })).concat([{ value: '', label: 'Tenant-wide' }]);
    modal(ctx, { title: 'Import an app bundle', cls: 'wide', body: UI.notice('The signature is verified over exactly what arrived before anything is read. A bundle changed after signing, signed elsewhere or naming another key is refused with 422 and audited.', 'info')
      + UI.field('Bundle (exprsn-app/1 JSON)', UI.textarea('', { rows: 6, placeholder: '{"format":"exprsn-app/1", …}', attrs: 'data-ib-json spellcheck="false"' }))
      + '<div class="formgrid">' + UI.field('Name (optional)', UI.input('', { placeholder: 'defaults to the bundle\'s name', attrs: 'data-ib-name' })) + UI.field('Workspace', UI.select(scopes, (App.me && App.me.workspace) || '', 'data-ib-ws')) + '</div><div data-ib-err></div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Verify and import', { kind: 'primary', attrs: 'data-ib-ok' }),
    onMount(m) {
      m.querySelector('[data-ib-ok]').addEventListener('click', async () => {
        const errEl = m.querySelector('[data-ib-err]'); errEl.innerHTML = '';
        let bundle; try { bundle = JSON.parse(m.querySelector('[data-ib-json]').value); } catch (x) { errEl.innerHTML = UI.notice('The bundle is not JSON.', 'danger'); return; }
        const body = { bundle }; const name = m.querySelector('[data-ib-name]').value.trim(); if (name) body.name = name; body.workspaceId = m.querySelector('[data-ib-ws]').value || null;
        try {
          const out = await App.post('/api/apps/import', body);
          st.app = out.id; st.bundleProblem = null; st.tab = 'entities';
          afterChange(ctx, { apps: true }); ctx.toast('Signature verified. App ' + esc(out.name) + ' created; its forms are private. Audited app.imported.', 'ok', 5000);
        } catch (err) {
          if (err.status === 422) { st.bundleProblem = { title: (err.problem && err.problem.title) || 'Bundle refused', text: detailOf(err) + ' Nothing was created; audited as app.import.refused.', trace: traceOf(err) }; App.closeOverlay(); ctx.rerender(); return; }
          errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger');
        }
      });
    } });
  }

  async function openExportBundle(ctx, app) {
    let bundle;
    try { bundle = await App.get(A(app.id) + '/export'); } catch (err) { App.fail(err, 'Could not export the app'); return; }
    const text = JSON.stringify(bundle, null, 2);
    modal(ctx, { title: 'Export ' + esc(app.title || app.name), cls: 'wide', body: UI.notice('The design only: entities and forms. No records, triggers or form links. Signed with the KMS key ' + esc(bundle.key || '') + ' so another tenant or instance can verify it. Audited app.exported.', 'info') + UI.code(text, 'json'),
      actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Download bundle', { kind: 'primary', attrs: 'data-eb-dl' }),
      onMount(m) {
        m.querySelector('[data-eb-dl]').addEventListener('click', () => {
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
          const a = document.createElement('a'); a.href = url; a.download = app.name + '.app.json'; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          App.closeOverlay(); ctx.toast(esc(app.name) + '.app.json downloaded.', 'ok');
        });
      } });
  }

  // ---------- entities: designer and state machine ----------
  async function saveDefinition(ctx, app, ent, def, msg) {
    try {
      const out = await App.patch(E(app.id, ent.id), { definition: def, rev: ent.rev });
      afterChange(ctx, { records: true });
      ctx.toast(msg + (out.reindexJob ? ' Reindexing the records (job apps.reindex).' : '') + ' Audited app.entity.updated.', 'ok', 4500);
      return true;
    } catch (err) { return err; }
  }

  function renderEntities(ctx, app, ent, design) {
    const st = ctx.state;
    const list = '<div class="hstack wrap gap6">' + (app.entities.length ? UI.seg(app.entities.map((e) => ({ id: e.id, label: e.title || e.name })), ent ? ent.id : '', 'data-entityseg') : '') + (design ? UI.btn('New entity', { size: 'sm', icon: 'plus', attrs: 'data-newentity' }) + UI.btn('Draft the data model', { size: 'sm', icon: 'brain', attrs: 'data-draft' }) : '') + '</div>';
    ctx.on('click', '[data-entityseg] [data-seg]', (e, t) => { st.entity = t.dataset.seg; st.smProblem = null; st.record = null; st.filters = []; st.stateFilter = 'all'; resetPaging(st); st.selected = {}; ctx.rerender(); });
    ctx.on('click', '[data-newentity]', () => openEntityModal(ctx, app, null));
    ctx.on('click', '[data-draft]', () => openDraftModal(ctx, app));
    if (!ent) return list + UI.empty('No entities yet', design ? 'Design one by hand or let a model draft it from a description.' : 'A designer has not added an entity to this app yet.', design ? UI.btn('New entity', { kind: 'primary', attrs: 'data-newentity' }) : '');

    const fields = fieldsOf(ent);
    const rows = fields.map((f, i) => ({ cells: ['<span class="apps-fieldname mono">' + esc(f.name) + '</span>', esc(f.title || ''), UI.pill(f.type, computed(f) ? 'accent' : 'outline'), f.required ? 'yes' : '', f.indexed ? 'yes' : '', f.unique ? 'yes' : '', detail(f), design ? '<span class="hstack gap4" style="justify-content:flex-end">' + UI.iconbtn('edit', 'Edit field ' + f.name, { attrs: 'data-editfield="' + i + '"', cls: 'sm ghost' }) + UI.iconbtn('trash', 'Delete field ' + f.name, { attrs: 'data-delfield="' + i + '"', cls: 'sm ghost' }) + '</span>' : ''], attrs: 'data-field="' + esc(f.name) + '"' }));
    const fieldsPanel = UI.panel('Fields of ' + esc(ent.title || ent.name), UI.notice('Values are sealed with the tenant key. Only fields marked <b>indexed</b> or <b>unique</b> are kept in a clear index, and only those can be filtered, sorted, searched and aggregated. Changing them reindexes every record (job apps.reindex).', 'info')
      + UI.table(['Field', 'Title', 'Type', 'Required', 'Indexed', 'Unique', 'Details', { label: '', right: true }], rows, { clickable: false, minWidth: '860px', emptyTitle: 'No fields', emptyText: 'Add the first field.' })
      + '<div class="hstack gap6 wrap">' + (design ? UI.btn('Add field', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-addfield' }) + UI.btn('Edit entity', { size: 'sm', attrs: 'data-editentity' }) + UI.btn('Delete entity', { size: 'sm', kind: 'ghost', attrs: 'data-delentity' }) : '') + '<span class="muted" style="font-size:12px">rev ' + ent.rev + ', label ' + esc(ent.label) + ' (its records\' default and lowest), name <span class="mono">' + esc(ent.name) + '</span></span></div>',
      { actions: UI.label(ent.label, { sm: true }) });

    const sm = smOf(ent);
    let smPanel;
    if (sm) {
      const S = sm.states; const w = 150, gap = 60, bw = 120, bh = 34; const W = Math.max(1, S.length) * (w + gap); const x = (n) => S.findIndex((s) => s.name === n) * (w + gap) + 10;
      const edges = []; sm.transitions.forEach((t) => (t.from.indexOf('*') >= 0 ? S.map((s) => s.name) : t.from).filter((f) => f !== t.to).forEach((f) => edges.push({ t, f, back: x(t.to) < x(f) })));
      const nUp = edges.filter((e) => !e.back).length, nDown = edges.filter((e) => e.back).length;
      const BY = 44 + nUp * 26; const H = BY + bh + 48 + nDown * 26;
      const boxes = S.map((s) => '<rect class="box ' + (s.name === sm.initial ? 'initial' : '') + '" x="' + x(s.name) + '" y="' + BY + '" width="' + bw + '" height="' + bh + '" rx="6"></rect><text x="' + (x(s.name) + bw / 2) + '" y="' + (BY + 22) + '" text-anchor="middle">' + esc(s.title || s.name) + '</text>' + (s.name === sm.initial ? '<text class="tl" x="' + (x(s.name) + bw / 2) + '" y="' + (BY + bh + 16) + '" text-anchor="middle">initial</text>' : '')).join('');
      let up = 0, down = 0;
      const arrows = edges.map((e) => { const t = e.t; const x1 = x(e.f) + bw / 2, x2 = x(t.to) + bw / 2; const lane = e.back ? down++ : up++; const y = e.back ? BY + bh : BY; const cy = e.back ? y + 40 + lane * 26 : y - 40 - lane * 26; const my = (y + cy) / 2; return '<path class="arrow" d="M' + x1 + ' ' + y + ' Q' + ((x1 + x2) / 2) + ' ' + cy + ' ' + x2 + ' ' + y + '" marker-end="url(#apps-arr)"></path><text class="tl" x="' + ((x1 + x2) / 2) + '" y="' + (e.back ? my + 11 : my - 3) + '" text-anchor="middle">' + esc(t.name || '') + (t.roles && t.roles.length ? ' (' + esc(t.roles.join(', ')) + ')' : '') + '</text>'; }).join('');
      const svg = '<svg class="apps-sm" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="State machine of ' + esc(ent.title || ent.name) + ': states ' + esc(S.map((s) => s.name).join(', ')) + ', initial ' + esc(sm.initial) + '"><defs><marker id="apps-arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="var(--fg2)"></path></marker></defs>' + boxes + arrows + '</svg>';
      const trows = sm.transitions.map((t, i) => ({ cells: ['<span class="mono">' + esc(t.name || '') + '</span>', t.from.map((f) => UI.pill(f, f === '*' ? 'accent' : 'outline')).join(' '), UI.pill(t.to, 'outline'), t.roles && t.roles.length ? esc(t.roles.join(', ')) : '<span class="muted">any writer</span>', design ? '<span class="hstack" style="justify-content:flex-end">' + UI.iconbtn('trash', 'Remove transition ' + (t.name || t.to), { attrs: 'data-deltrans="' + i + '"', cls: 'sm ghost' }) + '</span>' : ''] }));
      const chips = '<div class="apps-chips">' + S.map((s) => '<span class="apps-chip">' + esc(s.title || s.name) + (s.name === sm.initial ? ' <span class="muted">initial</span>' : '') + (design ? (s.name !== sm.initial ? UI.iconbtn('flag', 'Make ' + s.name + ' the initial state', { attrs: 'data-initstate="' + esc(s.name) + '"', cls: 'sm ghost' }) : '') + UI.iconbtn('x', 'Remove state ' + s.name, { attrs: 'data-delstate="' + esc(s.name) + '"', cls: 'sm ghost' }) : '') + '</span>').join('') + (design ? UI.btn('Add state', { size: 'xs', attrs: 'data-addstate' }) : '') + '</div>';
      smPanel = UI.panel('State machine', svg + chips
        + UI.table(['Transition', 'From', 'To', 'Roles', { label: '', right: true }], trows, { clickable: false, minWidth: '0', emptyTitle: 'No transitions', emptyText: 'Records stay in the state they are in until a transition is added.' })
        + '<div class="hstack gap6 wrap">' + (design ? UI.btn('Add transition', { size: 'sm', icon: 'plus', attrs: 'data-addtrans' }) + UI.btn('Remove state machine', { size: 'sm', kind: 'ghost', attrs: 'data-delsm' }) : '') + '<span class="muted" style="font-size:12px">A new record starts in the initial state; only listed transitions are allowed. A state a record holds cannot be removed (409).</span></div>'
        + (st.smProblem ? UI.problem(st.smProblem.title, st.smProblem.text, st.smProblem.trace || false) : ''));
    } else {
      smPanel = UI.panel('State machine', UI.empty('No states', 'Records of ' + (ent.title || ent.name) + ' have no lifecycle.' + (design ? ' Add an initial state to start a state machine.' : ''), design ? UI.btn('Add state machine', { attrs: 'data-addsm' }) : '') + (st.smProblem ? UI.problem(st.smProblem.title, st.smProblem.text, st.smProblem.trace || false) : ''));
    }

    if (design) {
      const smSave = async (def, msg) => { const r = await saveDefinition(ctx, app, ent, def, msg); if (r !== true) { st.smProblem = { title: r.status === 409 ? 'Refused' : 'Not saved', text: detailOf(r), trace: traceOf(r) }; App.closeOverlay(); ctx.rerender(); } else st.smProblem = null; return r; };
      ctx.on('click', '[data-addfield]', () => openFieldModal(ctx, app, ent, null));
      ctx.on('click', '[data-editfield]', (e, t) => openFieldModal(ctx, app, ent, +t.dataset.editfield));
      ctx.on('click', '[data-delfield]', async (e, t) => {
        const f = fields[+t.dataset.delfield];
        if (fields.length === 1) { ctx.toast('An entity keeps at least one field. Delete the entity instead.', 'warn'); return; }
        const ok = await ctx.confirm({ title: 'Delete field ' + f.name, tag: 'drops values', tone: 'danger', body: '<p class="fg2" style="margin:0">The field leaves the definition and its values leave every record of ' + esc(ent.title || ent.name) + '. A formula or AI prompt that reads it is refused by the server.</p>', kv: [['Type', f.type], ['Indexed', f.indexed ? 'yes' : 'no']], ok: 'Delete field' });
        if (!ok) return;
        const def = clone(ent.definition); def.fields.splice(+t.dataset.delfield, 1); if (def.titleField === f.name) delete def.titleField;
        const r = await saveDefinition(ctx, app, ent, def, 'Field ' + esc(f.name) + ' deleted.'); if (r !== true) App.fail(r, 'Could not delete the field');
      });
      ctx.on('click', '[data-editentity]', () => openEntityModal(ctx, app, ent));
      ctx.on('click', '[data-delentity]', async () => {
        const ok = await ctx.confirm({ title: 'Delete entity ' + (ent.title || ent.name), tag: 'deletes records', tone: 'danger', body: '<p class="fg2" style="margin:0">Deletes its records, forms and triggers. Refused while another entity refers to it.</p>', kv: [['Forms', app.forms.filter((f) => f.entity === ent.name).length], ['Triggers', (app.triggers || []).filter((t) => t.entity === ent.name).length]], ok: 'Delete entity' });
        if (!ok) return;
        try { await App.del(E(app.id, ent.id)); st.entity = null; afterChange(ctx, { records: true }); ctx.toast('Entity ' + esc(ent.title || ent.name) + ' deleted. Audited app.entity.deleted.', 'warn'); } catch (err) { App.fail(err, 'Could not delete the entity'); }
      });
      ctx.on('click', '[data-addsm]', () => modal(ctx, { title: 'Add a state machine', body: UI.field('Initial state', UI.input('new', { attrs: 'data-sm-init' }), 'Lower-case letters, digits, _ and -. Every existing record moves into it.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add', { kind: 'primary', attrs: 'data-sm-ok' }), onMount(m) { m.querySelector('[data-sm-ok]').addEventListener('click', () => { const n = m.querySelector('[data-sm-init]').value.trim(); const def = clone(ent.definition); def.states = { initial: n, states: [{ name: n }], transitions: [] }; smSave(def, 'State machine added.'); }); } }));
      ctx.on('click', '[data-delsm]', async () => { const ok = await ctx.confirm({ title: 'Remove the state machine', tone: 'danger', body: '<p class="fg2" style="margin:0">Records of ' + esc(ent.title || ent.name) + ' lose their lifecycle. Refused while records hold a state.</p>', ok: 'Remove' }); if (!ok) return; const def = clone(ent.definition); delete def.states; smSave(def, 'State machine removed.'); });
      ctx.on('click', '[data-addstate]', () => modal(ctx, { title: 'Add state', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'lower-case', attrs: 'data-as-name' })) + UI.field('Title', UI.input('', { attrs: 'data-as-title' })) + '</div>' + UI.check('Make it the initial state', false, 'data-as-init') + '<div data-as-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add', { kind: 'primary', attrs: 'data-as-ok' }), onMount(m) { m.querySelector('[data-as-ok]').addEventListener('click', () => { const name = m.querySelector('[data-as-name]').value.trim(); if (!name || sm.states.some((s) => s.name === name)) { m.querySelector('[data-as-err]').innerHTML = UI.notice('A new, unique state name is needed.', 'warn'); return; } const def = clone(ent.definition); const s = { name }; const title = m.querySelector('[data-as-title]').value.trim(); if (title) s.title = title; def.states.states.push(s); if (m.querySelector('[data-as-init]').checked) def.states.initial = name; smSave(def, 'State ' + esc(name) + ' added.'); }); } }));
      ctx.on('click', '[data-initstate]', (e, t) => { const def = clone(ent.definition); def.states.initial = t.dataset.initstate; smSave(def, 'Initial state set to ' + esc(t.dataset.initstate) + '.'); });
      ctx.on('click', '[data-delstate]', (e, t) => {
        const n = t.dataset.delstate;
        if (n === sm.initial) { st.smProblem = { title: 'Initial state', text: n + ' is the initial state. Make another state the initial one first.' }; ctx.rerender(); return; }
        const def = clone(ent.definition); def.states.states = def.states.states.filter((s) => s.name !== n);
        def.states.transitions = def.states.transitions.filter((tr) => tr.to !== n).map((tr) => Object.assign({}, tr, { from: tr.from.filter((f) => f !== n) })).filter((tr) => tr.from.length);
        smSave(def, 'State ' + esc(n) + ' removed with its transitions.');
      });
      ctx.on('click', '[data-addtrans]', () => {
        const names = sm.states.map((s) => s.name);
        modal(ctx, { title: 'Add transition', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-at-name', placeholder: 'submit, approve…' })) + UI.field('To', UI.select(names, names[names.length - 1], 'data-at-to')) + '</div>' + UI.field('From', '<div class="hstack wrap gap6">' + UI.check('any state (*)', false, 'data-at-any') + names.map((n) => UI.check(n, false, 'data-at-from="' + esc(n) + '"')).join('') + '</div>') + UI.field('Roles (optional)', UI.input('', { placeholder: 'flag-reviewer, tenant-admin', attrs: 'data-at-roles' }), 'Only holders of one of these roles may take the transition; empty allows every writer.') + '<div data-at-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add', { kind: 'primary', attrs: 'data-at-ok' }),
          onMount(m) { m.querySelector('[data-at-ok]').addEventListener('click', () => { const any = m.querySelector('[data-at-any]').checked; const from = any ? ['*'] : Array.prototype.slice.call(m.querySelectorAll('[data-at-from]')).filter((c) => c.checked).map((c) => c.dataset.atFrom); if (!from.length) { m.querySelector('[data-at-err]').innerHTML = UI.notice('Choose at least one source state.', 'warn'); return; } const roles = m.querySelector('[data-at-roles]').value.split(',').map((s) => s.trim()).filter(Boolean); const tr = { from, to: m.querySelector('[data-at-to]').value }; const nm = m.querySelector('[data-at-name]').value.trim(); if (nm) tr.name = nm; if (roles.length) tr.roles = roles; const def = clone(ent.definition); def.states.transitions.push(tr); smSave(def, 'Transition added.'); }); } });
      });
      ctx.on('click', '[data-deltrans]', (e, t) => { const def = clone(ent.definition); def.states.transitions.splice(+t.dataset.deltrans, 1); smSave(def, 'Transition removed.'); });
    }
    return list + fieldsPanel + smPanel + (design ? renderAiFills(ctx, app, ent) + renderSource(ctx, app, ent) : '');
  }

  function openEntityModal(ctx, app, ent) {
    const st = ctx.state;
    const labels = LABELS.filter((l) => rank(l) <= rank(app.label) && rank(l) <= rank(clearance()));
    const body = '<div class="formgrid">' + (ent ? '' : UI.field('Name', UI.input('', { placeholder: 'lower-case, unique in the app', attrs: 'data-ne-name' }))) + UI.field('Title', UI.input(ent ? ent.title || '' : '', { attrs: 'data-ne-title' })) + UI.field('Label', UI.select(labels, ent ? ent.label : labels[Math.min(1, labels.length - 1)], 'data-ne-label'), 'The records\' default and lowest label, at most the app\'s (' + esc(app.label) + ').') + '</div>'
      + (ent ? '' : '<div class="divider"></div><div class="eyebrow">First field</div><div class="formgrid">' + UI.field('Field name', UI.input('', { placeholder: 'name', attrs: 'data-ne-fname' })) + UI.field('Field type', UI.select(['string', 'number', 'boolean', 'date', 'json'], 'string', 'data-ne-ftype')) + '</div>' + '<div class="hstack wrap gap12">' + UI.check('Required', false, 'data-ne-freq') + UI.check('Indexed', true, 'data-ne-fidx') + '</div>' + UI.notice('An entity has at least one field; add the others on the designer. Field names cannot be id, state, label, version or the timestamps.', 'info'))
      + '<div data-ne-err></div>';
    modal(ctx, { title: ent ? 'Edit entity ' + esc(ent.title || ent.name) : 'New entity', body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(ent ? 'Save' : 'Create entity', { kind: 'primary', attrs: 'data-ne-ok' }),
      onMount(m) {
        m.querySelector('[data-ne-ok]').addEventListener('click', async () => {
          const errEl = m.querySelector('[data-ne-err]'); errEl.innerHTML = '';
          const title = m.querySelector('[data-ne-title]').value.trim(); const label = m.querySelector('[data-ne-label]').value;
          try {
            if (ent) {
              const b = { label, rev: ent.rev }; if (title) b.title = title;
              await App.patch(E(app.id, ent.id), b); afterChange(ctx, { records: true }); ctx.toast('Entity saved. Audited app.entity.updated.', 'ok');
            } else {
              const name = m.querySelector('[data-ne-name]').value.trim(); const fname = m.querySelector('[data-ne-fname]').value.trim();
              if (!NAME_RE.test(name)) { errEl.innerHTML = UI.notice('The entity name is lower-case letters, digits and _, starting with a letter.', 'warn'); return; }
              if (!NAME_RE.test(fname) || RESERVED.indexOf(fname) >= 0) { errEl.innerHTML = UI.notice('The first field needs a name: lower-case letters, digits and _, not a reserved one.', 'warn'); return; }
              const ftype = m.querySelector('[data-ne-ftype]').value;
              const f = { name: fname, type: ftype, required: m.querySelector('[data-ne-freq]').checked, indexed: ftype !== 'json' && m.querySelector('[data-ne-fidx]').checked };
              if (ftype === 'string' && f.indexed) f.maxLength = 255;
              const b = { name, label, definition: { fields: [f] } }; if (title) b.title = title;
              const out = await App.post(A(app.id) + '/entities', b);
              st.entity = out.id; afterChange(ctx, {}); ctx.toast('Entity ' + esc(name) + ' created. Audited app.entity.created.', 'ok');
            }
          } catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
        });
      } });
  }

  async function profilesList(ctx) {
    const st = ctx.state;
    if (st.profiles) return st.profiles;
    if (!App.can('chat:read')) return [];
    try { st.profiles = (await App.get('/api/chat/profiles')).map((p) => p.name); } catch (err) { st.profiles = []; }
    return st.profiles;
  }

  async function openFieldModal(ctx, app, ent, idx) {
    const fields = fieldsOf(ent);
    const f = idx == null ? { type: 'string' } : clone(fields[idx]);
    const others = app.entities.map((e) => e.name);
    const profiles = await profilesList(ctx);
    const typeBody = (t, cur) => {
      const g = UI.field;
      switch (t) {
        case 'string': return g('Max length', UI.input(cur.maxLength || '', { type: 'number', attrs: 'data-ff="maxLength"' }), 'At most 255 when indexed or unique.') + g('Min length', UI.input(cur.minLength == null ? '' : cur.minLength, { type: 'number', attrs: 'data-ff="minLength"' })) + g('Pattern (RE2)', UI.input(cur.pattern || '', { attrs: 'data-ff="pattern"' })) + UI.check('Multiline', !!cur.multiline, 'data-ff="multiline"');
        case 'number': return g('Min', UI.input(cur.min == null ? '' : cur.min, { type: 'number', attrs: 'data-ff="min" step="any"' })) + g('Max', UI.input(cur.max == null ? '' : cur.max, { type: 'number', attrs: 'data-ff="max" step="any"' })) + UI.check('Whole numbers only', !!cur.integer, 'data-ff="integer"');
        case 'date': return UI.check('With time (ISO date and time with a zone)', !!cur.withTime, 'data-ff="withTime"');
        case 'enum': return '<div class="span2">' + g('Options (one per line, value or value | label)', UI.textarea(linesFromOptions(cur), { rows: 3, attrs: 'data-ff="options"' })) + '</div>';
        case 'reference': return g('Entity', UI.select(others, cur.entity || others[0], 'data-ff="entity"'), 'A record of an entity of this app.');
        case 'lookup': return g('Source', UI.select(['static', 'entity', 'user', 'workspace'], cur.source || 'static', 'data-ff="source"')) + g('Static options (one per line)', UI.textarea(linesFromOptions(cur), { rows: 3, attrs: 'data-ff="options"' }), 'For source static.') + g('Entity (source entity)', UI.select([{ value: '', label: 'none' }].concat(others.map((o) => ({ value: o, label: o }))), cur.entity || '', 'data-ff="entity"')) + g('Display field (source entity)', UI.input(cur.display || '', { placeholder: 'name', attrs: 'data-ff="display"' }));
        case 'file': return '<div class="span2">' + UI.notice('A file-store id the writer can read. Public forms cannot ask for files.', 'info') + '</div>';
        case 'json': return g('Max bytes', UI.input(cur.maxBytes || 10000, { type: 'number', attrs: 'data-ff="maxBytes"' }));
        case 'formula': return '<div class="span2">' + g('Expression', UI.textarea(cur.expression || '', { rows: 2, attrs: 'data-ff="expression" spellcheck="false"' }), esc('Computed on write from the entity\'s other fields. Functions: ' + FUNCS.join(', ') + '. Operators: + - * / % & = != < <= > >= and or not.')) + '<div data-fcheck class="muted" style="font-size:12px" aria-live="polite">Type an expression to check it.</div></div>';
        case 'ai': return g('Profile', profiles.length ? UI.select(profiles.indexOf(cur.profile) >= 0 || !cur.profile ? profiles : profiles.concat([cur.profile]), cur.profile || profiles[0], 'data-ff="profile"') : UI.input(cur.profile || '', { attrs: 'data-ff="profile"', placeholder: 'published profile name' }), 'A published profile; the fill job runs as the person who last wrote the record.') + g('Max length', UI.input(cur.maxLength || 2000, { type: 'number', attrs: 'data-ff="maxLength"' })) + '<div class="span2">' + g('Prompt', UI.textarea(cur.prompt || '', { rows: 3, attrs: 'data-ff="prompt"', placeholder: 'Use {{field}} placeholders' })) + '<div data-pcheck class="muted" style="font-size:12px" aria-live="polite"></div></div>';
        default: return '';
      }
    };
    modal(ctx, { title: idx == null ? 'Add field to ' + esc(ent.title || ent.name) : 'Edit field ' + esc(f.name), cls: 'wide',
      body: '<div class="formgrid">' + UI.field('Name', UI.input(f.name || '', { placeholder: 'lower-case, letters, digits, _', attrs: 'data-ff="name"', readonly: idx != null })) + UI.field('Title', UI.input(f.title || '', { attrs: 'data-ff="title"' })) + UI.field('Type', UI.select(TYPES, f.type, 'data-ff="type"'), idx != null ? 'With records present a field\'s type cannot change (409).' : '') + UI.field('Description', UI.input(f.description || '', { attrs: 'data-ff="description"' })) + '</div>'
        + '<div class="hstack wrap gap12">' + UI.check('Required', !!f.required, 'data-ff="required"') + UI.check('Indexed (filter, sort, search, aggregate)', !!f.indexed, 'data-ff="indexed"') + UI.check('Unique', !!f.unique, 'data-ff="unique"') + '</div>' + (idx != null && !f.unique ? '<div class="muted" style="font-size:12px">An existing field cannot become unique while records exist (409).</div>' : '')
        + '<div class="divider"></div><div class="formgrid" data-typebody>' + typeBody(f.type, f) + '</div><div data-ff-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(idx == null ? 'Add field' : 'Save field', { kind: 'primary', attrs: 'data-ff-ok' }),
      onMount(m) {
        const tb = m.querySelector('[data-typebody]');
        const wire = () => {
          const ex = tb.querySelector('[data-ff="expression"]');
          if (ex) { const out = tb.querySelector('[data-fcheck]'); const run = () => { const p = checkFormula(ex.value, fields); out.innerHTML = p ? '<span style="color:var(--danger-fg)">' + esc(p) + '</span>' : '<span style="color:var(--ok-fg)">Looks right; the server checks it on save.</span>'; }; ex.addEventListener('input', run); run(); }
          const pr = tb.querySelector('[data-ff="prompt"]');
          if (pr) { const out = tb.querySelector('[data-pcheck]'); const run = () => { const ph = (pr.value.match(/\{\{\s*([^}]+?)\s*\}\}/g) || []).map((s) => s.replace(/^\{\{\s*|\s*\}\}$/g, '')); const plain = fields.filter((x) => !computed(x)); const bad = ph.filter((n) => !(plain.some((x) => x.name === n) || !checkFormula(n, plain))); out.innerHTML = bad.length ? '<span style="color:var(--danger-fg)">Unknown placeholder ' + esc(bad.join(', ')) + '</span>' : ph.length ? '<span style="color:var(--ok-fg)">Reads ' + esc(ph.join(', ')) + '.</span>' : 'No placeholders yet.'; }; pr.addEventListener('input', run); run(); }
        };
        wire();
        m.querySelector('[data-ff="type"]').addEventListener('change', (e) => { tb.innerHTML = typeBody(e.target.value, {}); wire(); });
        m.querySelector('[data-ff-ok]').addEventListener('click', async () => {
          const errEl = m.querySelector('[data-ff-err]'); errEl.innerHTML = '';
          const g = (k) => m.querySelector('[data-ff="' + k + '"]'); const val = (k) => { const el = g(k); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
          const warn = (t) => { errEl.innerHTML = UI.notice(esc(t), 'warn'); };
          const name = String(val('name') || '').trim(); const type = val('type');
          if (!NAME_RE.test(name)) { warn('Field names are lower-case letters, digits and _, starting with a letter.'); return; }
          if (RESERVED.indexOf(name) >= 0) { warn(name + ' is reserved for record properties.'); return; }
          if (idx == null && fields.some((x) => x.name === name)) { warn('A field named ' + name + ' exists.'); return; }
          const nf = { name, type, required: !!val('required'), indexed: !!val('indexed'), unique: !!val('unique') };
          if (val('title')) nf.title = val('title').trim(); if (val('description')) nf.description = val('description');
          const num = (k) => (val(k) === '' || val(k) == null ? undefined : Number(val(k)));
          if (type === 'string') { if (num('maxLength') != null) nf.maxLength = num('maxLength'); else if (nf.indexed || nf.unique) nf.maxLength = 255; if (num('minLength') != null) nf.minLength = num('minLength'); if (val('pattern')) nf.pattern = val('pattern'); if (val('multiline')) nf.multiline = true; }
          if (type === 'number') { if (num('min') != null) nf.min = num('min'); if (num('max') != null) nf.max = num('max'); nf.integer = !!val('integer'); }
          if (type === 'date') nf.withTime = !!val('withTime');
          if (type === 'enum') nf.options = optionsFromLines(val('options'));
          if (type === 'reference') nf.entity = val('entity');
          if (type === 'lookup') { nf.source = val('source'); if (nf.source === 'static') nf.options = optionsFromLines(val('options')); if (nf.source === 'entity') { nf.entity = val('entity') || undefined; if (val('display')) nf.display = val('display').trim(); } }
          if (type === 'json') { nf.maxBytes = num('maxBytes') || 10000; nf.indexed = false; nf.unique = false; }
          if (type === 'formula') { nf.expression = val('expression') || ''; nf.indexed = false; nf.unique = false; nf.required = false; }
          if (type === 'ai') { nf.profile = val('profile') || ''; nf.prompt = val('prompt') || ''; nf.maxLength = num('maxLength') || 2000; nf.indexed = false; nf.unique = false; nf.required = false; }
          const def = clone(ent.definition); if (idx == null) def.fields.push(nf); else def.fields[idx] = nf;
          const r = await saveDefinition(ctx, app, ent, def, idx == null ? 'Field ' + esc(name) + ' added.' : 'Field ' + esc(name) + ' saved.');
          if (r !== true) { const ps = r.problem && Array.isArray(r.problem.problems) ? r.problem.problems.map((p) => (typeof p === 'string' ? p : (p.field ? p.field + ': ' : '') + (p.message || ''))) : []; errEl.innerHTML = UI.notice('<b>' + esc(String(r.status || '')) + '</b> ' + esc(detailOf(r)) + (ps.length > 1 ? '<ul style="margin:4px 0 0 16px;padding:0">' + ps.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' : ''), 'danger'); }
        });
      } });
  }

  async function openDraftModal(ctx, app) {
    // 1.6.0 (B-8301): a description becomes a draft of the app's whole data model, shown as a diff to accept or edit.
    const st = ctx.state;
    const profiles = await profilesList(ctx);
    modal(ctx, { title: 'Draft the data model with a model', cls: 'wide', body: UI.notice('A local model, through the gateway and the named published profile, drafts entities, fields, relations, formulas, state machines and record triggers from your description. The draft is validated like a saved entity, compared with what the app already has, and never saved on its own: accept the diff, or edit the JSON first. Audited app.model.drafted.', 'info')
      + '<div class="formgrid">' + UI.field('Profile', profiles.length ? UI.select(profiles, profiles[0], 'data-dr-profile') : UI.input('', { attrs: 'data-dr-profile', placeholder: 'published profile name' })) + UI.field('Label of the draft', UI.select(LABELS.filter((l) => rank(l) <= rank(clearance())), 'internal', 'data-dr-label')) + '</div>'
      + UI.field('Describe the app', UI.textarea('', { rows: 3, attrs: 'data-dr-prompt', placeholder: 'A leave request app: employees submit requests for a date range with a reason; a manager approves or rejects them.' })) + '<div data-dr-out aria-live="polite"></div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Draft', { kind: 'primary', attrs: 'data-dr-go' }) + UI.btn('Accept the diff', { attrs: 'data-dr-save', disabled: true }),
    onMount(m) {
      let draft = null;
      const out = m.querySelector('[data-dr-out]'); const save = m.querySelector('[data-dr-save]');
      m.querySelector('[data-dr-go]').addEventListener('click', async () => {
        const profile = m.querySelector('[data-dr-profile]').value.trim(); const prompt = m.querySelector('[data-dr-prompt]').value.trim();
        if (!profile || prompt.length < 3) { out.innerHTML = UI.notice('Pick a profile and describe the app.', 'warn'); return; }
        out.innerHTML = '<div class="muted" style="font-size:12px">Asking ' + esc(profile) + '…</div>'; save.disabled = true;
        try {
          const r = await App.post(A(app.id) + '/model/draft', { prompt, profile, label: m.querySelector('[data-dr-label]').value });
          draft = r.draft;
          const rows = r.diff.map((d) => [ '<span class="mono">' + esc(d.entity) + '</span>', UI.pill(d.change, d.change === 'new' ? 'ok' : d.change === 'changed' ? 'accent' : 'outline'), d.addedFields.map((f) => UI.pill('+ ' + f, 'ok')).join(' ') || '<span class="muted">none</span>', d.changedFields.map((f) => UI.pill('~ ' + f, 'warn')).join(' ') || '<span class="muted">none</span>', d.removedFields.length ? d.removedFields.map((f) => UI.pill(f, 'outline')).join(' ') + ' <span class="muted">kept</span>' : '<span class="muted">none</span>', d.states ? UI.pill('state machine ' + d.states, 'accent') : '<span class="muted">none</span>', d.problems.length ? '<span style="color:var(--danger-fg)">' + esc(d.problems.join('; ')) + '</span>' : '' ]);
          const trig = (r.triggers || []).map((t) => '<li><span class="mono">' + esc(t.entity) + '</span> on ' + esc(t.events.join(', ')) + ' → workflow <span class="mono">' + esc(t.workflow) + '</span> ' + (t.ok ? UI.pill('exists', 'ok') : UI.pill(t.problem || 'skipped', 'warn')) + '</li>').join('');
          out.innerHTML = (rows.length ? UI.table(['Entity', 'Change', 'Fields added', 'Fields changed', 'Fields the draft omits', 'States', 'Problems'], rows, { clickable: false, minWidth: '0' }) : UI.notice('The model drafted no entity.', 'warn'))
            + (trig ? '<p class="fg2" style="margin:8px 0 0">Triggers</p><ul class="fg2" style="margin:4px 0 0 18px">' + trig + '</ul>' : '')
            + '<details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Draft JSON (edit before accepting)</summary>' + UI.textarea(JSON.stringify(draft, null, 2), { rows: 10, attrs: 'data-dr-json spellcheck="false"' }) + '</details>'
            + (r.valid ? UI.notice('<b>Draft is valid.</b> Accepting creates the new entities (after what they reference), adds the drafted fields and state machines to existing ones (nothing is removed) and creates the triggers whose workflow exists, in one request. Audited <span class="mono">app.model.applied</span>.', 'ok') : UI.notice('<b>Draft is not valid.</b> ' + esc(r.problems.join('; ')) + ' Edit the JSON and accept, or draft again.', 'warn'));
          save.disabled = !draft || !draft.entities || !draft.entities.length;
        } catch (err) { draft = null; out.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
      });
      save.addEventListener('click', async () => {
        if (!draft) return;
        const raw = m.querySelector('[data-dr-json]');
        if (raw) { try { draft = JSON.parse(raw.value); } catch (x) { out.insertAdjacentHTML('beforeend', UI.notice('The edited draft is not JSON.', 'danger')); return; } }
        try {
          const r = await App.post(A(app.id) + '/model/apply', { entities: draft.entities, triggers: draft.triggers || [] });
          st.entity = null; st.tab = 'entities'; afterChange(ctx, {});
          ctx.toast('Model applied: ' + r.created.length + ' created, ' + r.updated.length + ' updated' + (r.triggers.length ? ', ' + r.triggers.filter((t) => t.created).length + ' of ' + r.triggers.length + ' triggers' : '') + '. Audited app.model.applied.', 'ok', 5000);
        } catch (err) { out.insertAdjacentHTML('beforeend', UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)) + (err.problem && err.problem.problems ? ' ' + esc(err.problem.problems.join('; ')) : ''), 'danger')); }
      });
    } });
  }

  // ---------- AI fills over every row (1.6.0, B-8402) ----------
  function renderAiFills(ctx, app, ent) {
    const st = ctx.state;
    const aiFields = fieldsOf(ent).filter((f) => f.type === 'ai');
    if (!aiFields.length) return '';
    st.fills = st.fills || {}; st.fillEstimate = st.fillEstimate || {};
    const key = app.id + '/' + ent.id;
    const cur = st.fills[key];
    if (!cur || cur.stale) {
      if (!st.fillsBusy) { st.fillsBusy = true; App.get(E(app.id, ent.id) + '/ai/fills').then((d) => { st.fills[key] = { fills: d.fills, at: Date.now() }; }).catch(() => { st.fills[key] = { fills: [], at: Date.now() }; }).finally(() => { st.fillsBusy = false; if (App.state.route === 'apps') ctx.rerender(); }); }
    }
    const fills = cur ? cur.fills : [];
    const live = fills.some((x) => x.state === 'running' || x.state === 'queued');
    if (live && !st.fillTimer) st.fillTimer = setTimeout(() => { st.fillTimer = null; if (st.fills[key]) st.fills[key].stale = true; if (App.state.route === 'apps') ctx.rerender(); }, 1500);
    const est = st.fillEstimate[key];
    const rowsF = aiFields.map((f) => [ '<span class="mono">' + esc(f.name) + '</span>', esc(f.profile), '<span class="mono" style="font-size:12px">' + esc((f.prompt || '').slice(0, 80)) + ((f.prompt || '').length > 80 ? '…' : '') + '</span>', UI.btn('Estimate', { size: 'sm', attrs: 'data-fill-est="' + esc(f.name) + '"' }) + ' ' + UI.btn('Fill empty', { size: 'sm', kind: 'primary', attrs: 'data-fill-go="' + esc(f.name) + '" data-scope="empty"' }) + ' ' + UI.btn('Refresh all', { size: 'sm', attrs: 'data-fill-go="' + esc(f.name) + '" data-scope="all"' }) ]);
    const estHtml = est ? (est.busy ? '<div class="muted" style="font-size:12px">Estimating…</div>' : est.error ? UI.notice(esc(est.error), 'danger') : UI.notice('<b>Estimate for ' + esc(est.field) + ' (' + esc(est.scope) + '):</b> ' + est.records + (est.capped ? '+' : '') + ' records, about ' + Number(est.promptTokens).toLocaleString() + ' prompt and ' + Number(est.outputTokens).toLocaleString() + ' output tokens' + (est.model ? ' on ' + esc(est.model) : '') + (est.cost != null ? ', about ' + Number(est.cost).toFixed(2) + ' ' + esc(est.currency) + ' at the tenant\'s price' : ', no price set for the model') + '. Each record passes the profile\'s guardrails and the tenant quota, and is metered.', 'info')) : '';
    const when = (t) => (t ? new Date(t).toLocaleString() : '');
    const fillRows = fills.map((x) => { const pct = x.total ? Math.round(((x.done + x.failed + x.skipped) * 100) / x.total) : 100; return { attrs: 'data-fill="' + esc(x.id) + '"', cells: [ '<span class="mono">' + esc(x.field) + '</span>', esc(x.scope), UI.pill(x.state, x.state === 'succeeded' ? 'ok' : x.state === 'running' || x.state === 'queued' ? 'accent' : x.state === 'cancelled' ? 'outline' : 'danger'), x.state === 'running' || x.state === 'queued' ? UI.meter('', (x.done + x.failed) + ' of ' + x.total, pct, 'accent') : (x.done + ' done, ' + x.failed + ' failed' + (x.skipped ? ', ' + x.skipped + ' skipped' : '')), Number(x.promptTokens).toLocaleString() + ' / ' + Number(x.outputTokens).toLocaleString(), esc(when(x.finishedAt || x.createdAt)), (x.state === 'running' || x.state === 'queued') ? UI.btn('Cancel', { size: 'sm', kind: 'danger', attrs: 'data-fill-cancel="' + esc(x.id) + '"' }) : (x.error ? '<span class="muted" style="font-size:12px">' + esc(x.error) + '</span>' : '') ] }; });
    const html = UI.panel('AI fills over every row', UI.notice('A fill or refresh of an AI field over every record runs as one job (<span class="mono">apps.ai-fill-all</span>): an estimate first, progress as it runs, a cancel that stops it between records. Prompts may read fields and formulas, <span class="mono">{{upper(name)}}</span>; an edit regenerates only the fields that read what changed, once per quiet window.', 'info')
      + UI.table(['AI field', 'Profile', 'Prompt', { label: '', right: true }], rowsF, { clickable: false, minWidth: '0' }) + estHtml
      + UI.table(['Field', 'Scope', 'State', 'Progress', 'Tokens in / out', 'When', { label: '', right: true }], fillRows, { clickable: false, minWidth: '860px', emptyTitle: cur ? 'No fills yet' : 'Loading fills…', emptyText: cur ? 'Estimate, then fill the empty values or refresh them all.' : '' }));
    const reload = () => { if (st.fills[key]) st.fills[key].stale = true; ctx.rerender(); };
    ctx.on('click', '[data-fill-est]', async (e, t) => { const field = t.dataset.fillEst; st.fillEstimate[key] = { busy: true }; ctx.rerender(); try { const r = await App.post(E(app.id, ent.id) + '/ai/estimate', { field, scope: 'empty' }); st.fillEstimate[key] = Object.assign({ field, scope: 'empty' }, r); } catch (err) { st.fillEstimate[key] = { error: detailOf(err) }; } ctx.rerender(); });
    ctx.on('click', '[data-fill-go]', async (e, t) => {
      const field = t.dataset.fillGo; const scope = t.dataset.scope;
      try {
        const est = await App.post(E(app.id, ent.id) + '/ai/estimate', { field, scope });
        const ok = await ctx.confirm({ title: (scope === 'all' ? 'Refresh ' : 'Fill ') + field + ' for every record', tag: 'model spend', body: '<p class="fg2" style="margin:0">' + est.records + (est.capped ? '+' : '') + ' records, about ' + Number(est.promptTokens).toLocaleString() + ' prompt and ' + Number(est.outputTokens).toLocaleString() + ' output tokens' + (est.cost != null ? ', about ' + Number(est.cost).toFixed(2) + ' ' + esc(est.currency) : '') + '. Runs as one job; cancel it from this panel.</p>' });
        if (!ok) return;
        const r = await App.post(E(app.id, ent.id) + '/ai/fills', { field, scope });
        ctx.toast('Fill ' + esc(r.id.slice(-6)) + ' started over ' + r.total + ' records (job apps.ai-fill-all). Audited app.ai.fill.started.', 'ok', 4500);
        reload();
      } catch (err) { App.fail(err, 'Could not start the fill'); }
    });
    ctx.on('click', '[data-fill-cancel]', async (e, t) => { try { await App.post(E(app.id, ent.id) + '/ai/fills/' + enc(t.dataset.fillCancel) + '/cancel'); ctx.toast('Fill cancelled between records; filled values stay. Audited app.ai.fill.cancelled.', 'ok'); } catch (err) { App.fail(err, 'Could not cancel the fill'); } reload(); });
    return html;
  }

  // ---------- outside tables (1.6.0, B-8501) ----------
  function renderSource(ctx, app, ent) {
    const st = ctx.state;
    const src = (app.sources || []).find((x) => x.entity === ent.name) || null;
    const canAttach = App.can('connections:manage');
    if (!src) {
      const html = UI.panel('Outside table', UI.empty('Not backed by an outside table', 'Attach a table of a PostgreSQL or MySQL data connection: a pull brings its rows in as records (keyed by the table\'s key column), and with writes on an app edit reaches the table at once.' + (canAttach ? '' : ' Attaching needs connections:manage as well as apps:design.'), canAttach ? UI.btn('Attach an outside table', { attrs: 'data-src-attach' }) : ''));
      ctx.on('click', '[data-src-attach]', () => openSourceModal(ctx, app, ent, null));
      return html;
    }
    const lp = src.lastPull;
    const when = (t) => (t ? new Date(t).toLocaleString() : '');
    const kv = UI.kv([
      ['Connection', '<span class="mono">' + esc(src.connection || src.connectionId) + '</span> <span class="muted">' + esc(src.engine || '') + '</span>'], ['Table', '<span class="mono">' + esc(src.object) + '</span>'],
      ['Key', '<span class="mono">' + esc(src.keyColumn) + '</span> → ' + (src.keyField ? 'field <span class="mono">' + esc(src.keyField) + '</span>' : 'the record id')], ['State column', src.stateColumn ? '<span class="mono">' + esc(src.stateColumn) + '</span>' : '<span class="muted">none</span>'],
      ['Writes', src.writes ? UI.pill('through to the table at once', 'ok') : UI.pill('off: records are read-only here', 'outline')], ['Pull', src.pullMinutes ? 'every ' + src.pullMinutes + ' min' + (src.nextPullAt ? ', next ' + esc(when(src.nextPullAt)) : '') : 'on demand'],
      ['Rows gone outside', src.deleteMissing ? 'remove their records' : 'keep their records'], ['Last pull', lp ? esc(when(src.lastPullAt)) + ': ' + lp.rows + ' rows, ' + lp.created + ' created, ' + lp.updated + ' updated, ' + lp.deleted + ' deleted, ' + lp.unchanged + ' unchanged' + (lp.failed ? ', <b>' + lp.failed + ' failed</b>' : '') + ' in ' + lp.ms + ' ms' + (lp.error ? ' <span style="color:var(--danger-fg)">' + esc(lp.error) + '</span>' : '') : '<span class="muted">never</span>']
    ], 2);
    const problems = lp && lp.problems && lp.problems.length ? UI.notice('<b>Rows the last pull could not write:</b><ul style="margin:4px 0 0 18px">' + lp.problems.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>', 'warn') : '';
    const html = UI.panel('Outside table', UI.notice('Records of this entity are pulled from the table (unmasked, through the connection\'s allow-list) and sealed like any record; searches, policies and labels apply as usual. Audited app.entity.source.pulled per pull.', 'info') + kv + problems
      + '<div class="hstack gap6 wrap">' + UI.btn('Pull now', { kind: 'primary', size: 'sm', attrs: 'data-src-pull' }) + (canAttach ? UI.btn('Edit', { size: 'sm', attrs: 'data-src-edit' }) + UI.btn('Detach', { size: 'sm', kind: 'ghost', attrs: 'data-src-detach' }) : '') + '</div>');
    ctx.on('click', '[data-src-pull]', async () => { try { await App.post(E(app.id, ent.id) + '/source/pull'); ctx.toast('Pull queued as job apps.source-pull; the result shows here when it ends.', 'ok'); setTimeout(() => { st.detailKey = st.busyDetail = null; st.recsKey = st.busyRecs = null; if (App.state.route === 'apps') ctx.rerender(); }, 1500); } catch (err) { App.fail(err, 'Could not queue the pull'); } });
    ctx.on('click', '[data-src-edit]', () => openSourceModal(ctx, app, ent, src));
    ctx.on('click', '[data-src-detach]', async () => { const ok = await ctx.confirm({ title: 'Detach ' + (ent.title || ent.name) + ' from ' + src.object, tag: 'keeps records', body: '<p class="fg2" style="margin:0">The records stay as ordinary records; nothing is written to the table. Audited app.entity.source.removed.</p>' }); if (!ok) return; try { await App.del(E(app.id, ent.id) + '/source'); afterChange(ctx, {}); ctx.toast('Detached. Audited app.entity.source.removed.', 'ok'); } catch (err) { App.fail(err, 'Could not detach'); } });
    return html;
  }

  async function openSourceModal(ctx, app, ent, cur) {
    let conns = [];
    try { const list = await App.get('/api/admin/connections'); conns = (Array.isArray(list) ? list : list.connections || []).filter((c) => c.engine === 'postgres' || c.engine === 'mysql'); } catch (err) { App.fail(err, 'Could not list the connections'); return; }
    if (!conns.length) { ctx.toast('No PostgreSQL or MySQL connection is registered; add one on the Connections screen first.', 'warn'); return; }
    const sel = cur ? conns.find((c) => c.id === cur.connectionId) || conns[0] : conns[0];
    const objectsOf = (c) => (c.allowList || []);
    const plain = fieldsOf(ent).filter((f) => !computed(f));
    modal(ctx, { title: (cur ? 'Edit the outside table of ' : 'Attach an outside table to ') + esc(ent.title || ent.name), cls: 'wide', body: UI.notice('The table must be on the connection\'s schema allow-list, and the entity\'s label (' + esc(ent.label) + ') must cover the connection\'s. Fields map to the columns of the same name unless mapped below; the key column maps to a string or number field, or to the record id when no field is picked (then the column must take text).', 'info')
      + '<div class="formgrid">' + UI.field('Connection', UI.select(conns.map((c) => ({ value: c.id, label: c.name + ' (' + c.engine + ', ' + c.label + ')' })), sel.id, 'data-sr-conn')) + UI.field('Table', objectsOf(sel).length ? UI.select(objectsOf(sel), cur ? cur.object : objectsOf(sel)[0], 'data-sr-object') : UI.input(cur ? cur.object : '', { attrs: 'data-sr-object', placeholder: 'schema.table on the allow-list' }))
      + UI.field('Key column', UI.input(cur ? cur.keyColumn : 'id', { attrs: 'data-sr-key' })) + UI.field('Key field', UI.select([{ value: '', label: 'the record id' }].concat(plain.filter((f) => f.type === 'string' || f.type === 'number').map((f) => ({ value: f.name, label: f.name }))), cur && cur.keyField ? cur.keyField : '', 'data-sr-keyfield'))
      + UI.field('State column', UI.input(cur && cur.stateColumn ? cur.stateColumn : '', { attrs: 'data-sr-state', placeholder: smOf(ent) ? 'column holding the state' : 'the entity has no state machine' })) + UI.field('Pull every (minutes)', UI.input(cur && cur.pullMinutes ? cur.pullMinutes : '', { type: 'number', attrs: 'data-sr-min', placeholder: 'empty: on demand only' }))
      + '<div class="span2">' + UI.field('Column mapping (field=column, one per line)', UI.textarea(cur && cur.columns ? Object.keys(cur.columns).map((k) => k + '=' + cur.columns[k]).join('\n') : '', { rows: 2, attrs: 'data-sr-cols spellcheck="false"' })) + '</div>'
      + '</div>' + UI.check('Writes through: a record created, changed, moved or deleted here reaches the table first', !!(cur && cur.writes), 'data-sr-writes') + UI.check('Rows gone from the table remove their records', cur ? cur.deleteMissing !== false : true, 'data-sr-delete') + '<div data-sr-err></div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(cur ? 'Save' : 'Attach', { kind: 'primary', attrs: 'data-sr-ok' }),
    onMount(m) {
      m.querySelector('[data-sr-conn]').addEventListener('change', (e) => { const c = conns.find((x) => x.id === e.target.value); const o = m.querySelector('[data-sr-object]'); if (o && o.tagName === 'SELECT') o.innerHTML = objectsOf(c).map((x) => '<option>' + esc(x) + '</option>').join(''); });
      m.querySelector('[data-sr-ok]').addEventListener('click', async () => {
        const errEl = m.querySelector('[data-sr-err]');
        const columns = {}; (m.querySelector('[data-sr-cols]').value || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => { const i = l.indexOf('='); if (i > 0) columns[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
        const min = parseInt(m.querySelector('[data-sr-min]').value, 10);
        const body = { connectionId: m.querySelector('[data-sr-conn]').value, object: m.querySelector('[data-sr-object]').value.trim(), keyColumn: m.querySelector('[data-sr-key]').value.trim(), keyField: m.querySelector('[data-sr-keyfield]').value || null, columns, stateColumn: m.querySelector('[data-sr-state]').value.trim() || null, writes: m.querySelector('[data-sr-writes]').checked, deleteMissing: m.querySelector('[data-sr-delete]').checked, pullMinutes: Number.isFinite(min) && min > 0 ? min : null, enabled: true };
        try { await App.put(E(app.id, ent.id) + '/source', body); afterChange(ctx, {}); ctx.toast(cur ? 'Source updated. Audited app.entity.source.updated.' : 'Table attached; pull it now to bring its rows in. Audited app.entity.source.set.', 'ok', 4500); }
        catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
      });
    } });
  }

  // ---------- records ----------
  const toValue = (e, field, raw, op) => {
    const f = fieldByName(e, field); const s = String(raw).trim();
    const one = (x) => { if (field === 'createdAt' || field === 'updatedAt') return /^\d+$/.test(x) ? Number(x) : Date.parse(x); if (f && f.type === 'number') return Number(x); if (f && f.type === 'boolean') return x === 'true'; return x; };
    if (op === 'exists') return s !== 'false';
    if (op === 'in') return s.split(',').map((x) => x.trim()).filter(Boolean).map(one);
    return one(s);
  };
  function filterOf(st) {
    const conds = st.filters.map((f) => ({ field: f.field, op: f.op, value: f.value }));
    const parts = [];
    if (conds.length === 1) parts.push(conds[0]); else if (conds.length > 1) parts.push(st.filterMode === 'or' ? { or: conds } : { and: conds });
    if (st.stateFilter !== 'all') parts.push({ field: 'state', op: 'eq', value: st.stateFilter });
    return parts.length === 0 ? null : parts.length === 1 ? parts[0] : { and: parts };
  }
  function fmtVal(st, ent, f, v) {
    if (v == null || v === '') return '<span class="muted">empty</span>';
    if (f.type === 'number') return '<span class="num">' + esc(fmtNum(v)) + '</span>';
    if (f.type === 'boolean') return v ? 'yes' : 'no';
    if (f.type === 'json') { const s = JSON.stringify(v); return '<span class="mono" style="font-size:12px">' + esc(s.slice(0, 60)) + (s.length > 60 ? '…' : '') + '</span>'; }
    if (f.type === 'enum' || (f.type === 'lookup' && f.source === 'static')) { const o = optList(f).find((x) => x.value === v); return esc(o ? o.label : v); }
    const cache = st.optCache[ent.id + ':' + f.name] || {};
    const label = cache[v] || String(v);
    if (f.type === 'reference') return '<a href="#" data-goref="' + esc(f.entity) + ':' + esc(v) + '">' + esc(label) + '</a>';
    return esc(label);
  }
  async function loadOptions(ctx, app, ent, list) {
    const st = ctx.state; const out = {};
    await Promise.all(list.map((f) => App.get(E(app.id, ent.id) + '/fields/' + enc(f.name) + '/options?limit=100').then((r) => { out[f.name] = r.options; const c = st.optCache[ent.id + ':' + f.name] = st.optCache[ent.id + ':' + f.name] || {}; r.options.forEach((o) => { c[o.value] = o.label; }); }).catch(() => undefined)));
    return out;
  }

  function renderRecords(ctx, app, ent, design, canWrite) {
    const st = ctx.state;
    if (!ent) return { body: UI.empty('No entity', design ? 'Design an entity first, on the Entities tab.' : 'This app has no entity yet.'), inspector: '' };
    const ek = app.id + '/' + ent.id;
    const sm = smOf(ent);
    const sorts = st.sorts.filter((s) => s.field);
    const filter = filterOf(st);
    const cursor = st.cursors[st.page] || null;
    const qs = [];
    if (filter) qs.push('filter=' + enc(JSON.stringify(filter)));
    if (sorts.length) qs.push('sort=' + enc(sorts.map((s) => s.field + ':' + s.dir).join(',')));
    if (st.query) qs.push('q=' + enc(st.query));
    qs.push('limit=' + PAGE);
    if (cursor) qs.push('cursor=' + enc(cursor));
    const url = E(app.id, ent.id) + '/records?' + qs.join('&');
    if (st.recsKey !== url && st.busyRecs !== url) {
      st.busyRecs = url; const seq = st.recsSeq = (st.recsSeq || 0) + 1;
      App.get(url)
        .then((d) => { if (st.recsSeq !== seq) return; d.ek = ek; st.recs = d; st.recsKey = url; st.recsError = null; })
        .catch((err) => { if (st.recsSeq !== seq) return; st.recsError = err; st.recsKey = url; if (err.status === 400 && cursor) resetPaging(st); })
        .finally(() => { if (st.recsSeq === seq) st.busyRecs = null; if (st.refresh) st.refresh(); });
    }
    const recs = st.recs && st.recs.ek === ek ? st.recs : null;
    const list = recs ? recs.records : [];
    const total = recs ? recs.total : 0;
    const gf = gridFields(ent);
    const idx = indexedFields(ent);

    let sel = null;
    if (st.record) {
      sel = list.find((r) => r.id === st.record) || (st.recordObj && st.recordObj.id === st.record ? st.recordObj : null);
      if (!sel && st.fetchRec !== st.record) {
        const id = st.record; st.fetchRec = id;
        App.get(E(app.id, ent.id) + '/records/' + enc(id)).then((r) => { st.recordObj = r; }).catch((err) => { if (err.status === 404) { st.record = null; ctx.toast('That record is not there, or not visible to you.', 'warn'); } else App.fail(err, 'Could not load the record'); }).finally(() => { st.fetchRec = null; if (st.refresh) st.refresh(); });
      }
    }
    const selIds = Object.keys(st.selected).filter((k) => st.selected[k]);

    const cols = (canWrite ? [{ label: '', srLabel: 'Select', width: '28px' }] : []).concat(gf.map((f) => ({ label: f.title || f.name }))).concat(sm ? ['State'] : []).concat(['Label', 'Version', 'Source', 'AI', 'Updated']);
    const rows = list.map((r) => ({ cells: (canWrite ? ['<label class="check"><input type="checkbox" data-pick="' + esc(r.id) + '"' + (st.selected[r.id] ? ' checked' : '') + ' aria-label="Select record ' + esc(r.id) + '"></label>'] : []).concat(gf.map((f) => fmtVal(st, ent, f, r.values[f.name]))).concat(sm ? [r.state ? UI.pill(r.state, stateTone(r.state)) : '<span class="muted">none</span>'] : []).concat([UI.label(r.label, { sm: true }), '<span class="num">' + r.version + '</span>', srcPill(r.source), aiPill(r.aiState), esc(when(r.updatedAt))]), attrs: 'data-rec="' + esc(r.id) + '" tabindex="0" aria-label="Record ' + esc(r.id) + '"', selected: r.id === st.record }));

    const filterChips = st.filters.map((f, i) => '<span class="apps-chip"><span class="mono">' + esc(f.field + ' ' + f.op + ' ' + (Array.isArray(f.value) ? f.value.join(', ') : String(f.value))) + '</span>' + UI.iconbtn('x', 'Remove filter ' + f.field + ' ' + f.op, { attrs: 'data-delfilter="' + i + '"', cls: 'sm ghost' }) + '</span>').join('');
    const sortLabel = sorts.length ? 'Sort: ' + sorts.map((s) => s.field + ' ' + s.dir).join(', ') : 'Sort';
    const toolbar = '<div class="toolbar">' + UI.search('Search indexed text fields', 'data-search', st.query)
      + UI.btn('Add filter', { size: 'sm', icon: 'filter', attrs: 'data-addfilter', cls: st.filters.length ? 'active' : '' })
      + (st.filters.length > 1 ? UI.seg([{ id: 'and', label: 'and' }, { id: 'or', label: 'or' }], st.filterMode, 'data-filtermode aria-label="Combine filters"') : '')
      + UI.btn(sortLabel, { size: 'sm', icon: 'sort', attrs: 'data-sort' })
      + (sm ? '<label class="sr" for="apps-statef">State</label><select class="select" id="apps-statef" data-statefilter style="width:auto">' + [['all', 'All states']].concat(sm.states.map((s) => [s.name, s.title || s.name])).map((o) => '<option value="' + esc(o[0]) + '"' + (st.stateFilter === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>' : '')
      + '<span class="muted right" style="font-size:12px">' + (recs ? total + ' matching' : '') + '</span></div>'
      + (st.filters.length ? '<div class="apps-chips">' + filterChips + UI.btn('Clear filters', { size: 'xs', kind: 'ghost', attrs: 'data-clearfilters' }) + '</div>' : '');
    const actions = '<div class="hstack wrap gap6">' + UI.seg(app.entities.map((e) => ({ id: e.id, label: e.title || e.name })), ent.id, 'data-entityseg aria-label="Entity"') + '<span class="grow"></span>' + (canWrite ? UI.btn('New record', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newrec' }) + UI.btn('Import CSV', { size: 'sm', icon: 'upload', attrs: 'data-importcsv' }) : '') + UI.btn('Export', { size: 'sm', icon: 'download', attrs: 'data-exportcsv' }) + UI.btn('Aggregate', { size: 'sm', icon: 'calc', attrs: 'data-aggregate' }) + '</div>';
    const bulk = selIds.length ? '<div class="apps-bulk"><b>' + selIds.length + ' selected</b>' + UI.btn('Delete', { size: 'xs', kind: 'danger', attrs: 'data-bulkdelete' }) + UI.btn('Clear selection', { size: 'xs', kind: 'ghost', attrs: 'data-bulkclear' }) + '<span class="muted" style="font-size:12px">One transaction: any problem writes nothing and names the operation.</span></div>' : '';
    const from = recs && list.length ? st.page * PAGE + 1 : 0;
    const paging = '<div class="hstack wrap" style="font-size:12px"><span class="muted grow">' + (recs ? 'Showing ' + from + ' to ' + (st.page * PAGE + list.length) + ' of ' + total + ' (page ' + (st.page + 1) + ', ' + PAGE + ' a page)' : '') + '</span>' + UI.btn('Previous', { size: 'xs', attrs: 'data-prev', disabled: st.page === 0 }) + UI.btn('Next', { size: 'xs', attrs: 'data-next', disabled: !recs || !recs.nextCursor }) + '</div>';
    const aiFailed = sel && sel.aiState === 'failed';
    const aiNote = st.aiNote ? UI.notice(aiFailed ? '<b>AI field left empty.</b> ' + esc(sel.aiError || 'The fill failed.') + ' The record itself was saved; audited app.record.ai.failed. The fill job runs again on the next write of the record.' : '<b>AI fill.</b> When the fill of an ai field fails (the model down, the profile unpublished, the guardrails holding the answer), the record stays saved with aiState failed and the reason shown here. ' + (list.some((r) => r.aiState === 'failed') ? '' : 'No record on this page has a failed fill.'), 'warn', (aiFailed && canWrite ? UI.btn('Edit record', { size: 'sm', attrs: 'data-editrec' }) : '') + UI.btn('Dismiss', { size: 'sm', kind: 'ghost', attrs: 'data-dismissai' })) : '';
    const rep = st.importReport && st.importReport.ek === ek ? st.importReport : null;
    const report = rep ? UI.panel('Import result', (rep.dryRun ? UI.notice('<b>Dry run.</b> Nothing was written; uniqueness was checked too.', 'info') : '') + (rep.error ? UI.notice(esc(rep.error), 'danger') : '') + UI.kv([['Rows', (rep.summary && rep.summary.rows) || 0], [rep.dryRun ? 'Would write' : 'Written', rep.summary ? (rep.dryRun ? rep.summary.valid : rep.summary.created) : 0], ['Problems', (rep.summary && rep.summary.failed) || 0]], 3) + UI.table(['Row', 'Problem'], (rep.report || []).map((p) => ['<span class="num">' + esc(String(p.row)) + '</span>', esc(p.problem)]), { clickable: false, minWidth: '0', emptyTitle: 'No problems', emptyText: 'Every row was valid.' }), { actions: UI.btn('Dismiss', { size: 'xs', kind: 'ghost', attrs: 'data-dismissreport' }) }) : '';
    const tlist = (st.transfers[app.id] || []);
    const tsum = (t) => { const s = t.summary || {}; if (t.error) return t.error; if (t.kind === 'import') return t.summary ? s.rows + ' rows, ' + (t.dryRun ? s.valid + ' valid' : s.created + ' written') + ', ' + s.failed + ' problem' + (s.failed === 1 ? '' : 's') : 'waiting for the job'; return t.summary ? s.records + ' records, ' + fmtNum(s.bytes) + ' bytes' : 'building'; };
    const transfers = tlist.length ? UI.panel('Imports and exports', UI.table(['Kind', 'Entity', 'State', 'Summary', 'When', { label: '', right: true }], tlist.map((t) => [UI.pill(t.kind + (t.dryRun ? ' (dry run)' : ''), 'outline'), esc(t.entityTitle), UI.pill(t.state, t.state === 'succeeded' ? 'ok' : t.state === 'failed' ? 'danger' : 'info'), esc(tsum(t)), esc(when(t.createdAt)), t.download ? '<a class="btn sm" href="/api/apps/transfers/' + esc(t.id) + '/download" download>Download CSV</a>' : '']), { clickable: false, minWidth: '0' }) + '<span class="muted" style="font-size:12px">Exports are built as a job with what you may read when it runs; the CSV is sealed in the blob store and only you can download it. Cells starting with = + - @ are prefixed with an apostrophe.</span>') : '';
    let grid;
    if (st.recsError && st.recsKey === url) grid = UI.problem('Records could not be loaded', detailOf(st.recsError), traceOf(st.recsError)) + '<div>' + UI.btn('Try again', { attrs: 'data-reloadrecs' }) + '</div>';
    else if (!recs) grid = UI.notice('Loading…', 'info');
    else grid = UI.table(cols, rows, { minWidth: '900px', emptyTitle: total || st.filters.length || st.query || st.stateFilter !== 'all' ? 'No records match' : 'No records yet', emptyText: st.filters.length || st.query || st.stateFilter !== 'all' ? 'Clear the search and filters to see the rest.' : (canWrite ? 'Add the first record with New record, a form or an import.' : 'Records appear here when someone adds them.') }) + paging;
    const body = actions + toolbar + bulk + aiNote + grid + report + transfers;

    // ----- inspector -----
    let inspector;
    if (sel) {
      const allowed = sm ? sm.transitions.filter((t) => t.from.indexOf('*') >= 0 || t.from.indexOf(sel.state) >= 0) : [];
      const illegal = sm ? sm.transitions.filter((t) => allowed.indexOf(t) < 0) : [];
      const kv = fieldsOf(ent).map((f) => [esc(f.title || f.name), fmtVal(st, ent, f, sel.values[f.name]) + (f.type === 'formula' ? ' <span class="muted" style="font-size:11px">computed</span>' : '') + (f.type === 'ai' && sel.aiState === 'failed' ? ' <span style="color:var(--danger-fg);font-size:11px">fill failed</span>' : f.type === 'ai' && sel.aiState === 'pending' ? ' <span class="muted" style="font-size:11px">fill pending</span>' : '')]);
      inspector = '<aside class="inspector w360" aria-label="Record"><div class="hstack"><div class="eyebrow grow">Record</div>' + UI.label(sel.label, { sm: true }) + '</div><div style="font-size:15px;font-weight:600;overflow-wrap:anywhere" class="mono">' + esc(sel.id) + '</div>'
        + UI.kv([['Entity', esc(ent.title || ent.name)], ['State', sel.state ? UI.pill(sel.state, stateTone(sel.state)) : '<span class="muted">none</span>'], ['Version', '<span class="num">' + sel.version + '</span>'], ['Source', srcPill(sel.source)], ['AI fill', aiPill(sel.aiState) + (sel.aiError ? '<div class="muted" style="font-size:11px">' + esc(sel.aiError) + '</div>' : '')], ['Created', esc(when(sel.createdAt)) + ' by ' + esc(who(sel.createdBy))], ['Updated', esc(when(sel.updatedAt)) + ' by ' + esc(who(sel.updatedBy))]], 2)
        + '<div class="eyebrow">Values</div>' + UI.kv(kv, 1)
        + '<span class="muted" style="font-size:11px">Non-indexed values are opened from their sealed form for this view only.</span>'
        + (sm ? '<div class="eyebrow">Transitions</div><div class="hstack wrap gap6">' + allowed.map((t) => UI.btn((t.name || t.to) + ' → ' + t.to, { size: 'sm', attrs: 'data-transition="' + esc(t.to) + '" data-tname="' + esc(t.name || '') + '"', title: t.roles && t.roles.length ? 'Needs ' + t.roles.join(' or ') : '', disabled: !canWrite })).join('') + illegal.map((t) => UI.btn((t.name || t.to) + ' → ' + t.to, { size: 'sm', disabled: true, title: 'Not allowed from ' + sel.state })).join('') + (sm.transitions.length ? '' : '<span class="muted" style="font-size:12px">No transitions are defined.</span>') + '</div>' : '')
        + '<div class="hstack wrap gap6" style="margin-top:auto">' + (canWrite ? UI.btn('Edit', { kind: 'primary', size: 'sm', icon: 'edit', attrs: 'data-editrec' }) : '') + (App.canOpen('usage-audit') ? UI.btn('History', { size: 'sm', attrs: 'data-goaudit' }) : '') + (canWrite ? UI.btn('Delete', { size: 'sm', kind: 'ghost', attrs: 'data-delrec' }) : '') + '</div></aside>';
    } else {
      inspector = '<aside class="inspector w300" aria-label="Record">' + UI.empty(st.record ? 'Loading…' : 'No record selected', st.record ? 'Opening the record.' : 'Click a row to see every value, its version and the transitions it may take.') + '</aside>';
    }

    // ----- events -----
    const invalidate = () => { st.recsKey = st.busyRecs = null; };
    const requery = () => { resetPaging(st); st.selected = {}; ctx.rerender(); };
    ctx.on('click', '[data-entityseg] [data-seg]', (e, t) => { st.entity = t.dataset.seg; st.record = null; st.filters = []; st.sorts = [{ field: 'updatedAt', dir: 'desc' }]; st.stateFilter = 'all'; st.query = ''; st.problem = null; st.selected = {}; resetPaging(st); ctx.rerender(); });
    ctx.on('click', 'tr[data-rec]', (e, t) => { if (e.target.closest('[data-pick]') || e.target.closest('label.check') || e.target.closest('a')) return; st.record = t.dataset.rec; ctx.rerender(); });
    ctx.on('keydown', 'tr[data-rec]', (e, t) => { if (e.target !== t || (e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); st.record = t.dataset.rec; ctx.rerender(); const row = ctx.$('tr[data-rec="' + t.dataset.rec + '"]'); if (row) row.focus(); });
    ctx.on('change', '[data-pick]', (e, t) => { st.selected[t.dataset.pick] = t.checked; ctx.rerender(); const el = ctx.$('[data-pick="' + t.dataset.pick + '"]'); if (el) el.focus(); });
    ctx.on('click', '[data-goref]', (e, t) => { e.preventDefault(); const parts = t.dataset.goref.split(':'); const target = app.entities.find((x) => x.name === parts[0]); if (!target) return; st.entity = target.id; st.record = parts[1]; st.recordObj = null; st.filters = []; st.stateFilter = 'all'; st.query = ''; st.tab = 'records'; resetPaging(st); ctx.rerender(); });
    ctx.on('change', '[data-search]', (e, t) => { if (st.query === t.value.trim()) return; st.query = t.value.trim(); setTimeout(() => { if (App.state.route !== 'apps') return; const keep = document.activeElement === t; requery(); const el = keep ? ctx.$('[data-search]') : null; if (el) el.focus(); }, 0); });
    ctx.on('click', '[data-prev]', () => { if (st.page > 0) { st.page--; ctx.rerender(); } });
    ctx.on('click', '[data-next]', () => { if (recs && recs.nextCursor) { st.cursors[st.page + 1] = recs.nextCursor; st.page++; ctx.rerender(); } });
    ctx.on('click', '[data-delfilter]', (e, t) => { st.filters.splice(+t.dataset.delfilter, 1); requery(); });
    ctx.on('click', '[data-clearfilters]', () => { st.filters = []; requery(); });
    ctx.on('click', '[data-filtermode] [data-seg]', (e, t) => { st.filterMode = t.dataset.seg; requery(); });
    ctx.on('change', '[data-statefilter]', (e, t) => { st.stateFilter = t.value; requery(); });
    ctx.on('click', '[data-reloadrecs]', () => { st.recsError = null; invalidate(); ctx.rerender(); });
    ctx.on('click', '[data-dismissai]', () => { st.aiNote = false; ctx.rerender(); });
    ctx.on('click', '[data-dismissreport]', () => { st.importReport = null; ctx.rerender(); });
    ctx.on('click', '[data-goaudit]', () => ctx.navigate('usage-audit'));
    ctx.on('click', '[data-addfilter]', () => {
      const fields = idx.map((f) => f.name).concat(sm ? SYSTEM_FIELDS : SYSTEM_FIELDS.filter((s) => s !== 'state'));
      modal(ctx, { title: 'Add filter', body: UI.notice('Filters read the clear index, so only indexed or unique fields and the system fields are offered. Text compares lower-cased; ne and not include records without the value. Up to 30 conditions.', 'info') + '<div class="formgrid">' + UI.field('Field', UI.select(fields, fields[0], 'data-af-field')) + UI.field('Operator', UI.select(OPS, 'eq', 'data-af-op')) + '<div class="span2">' + UI.field('Value', UI.input('', { placeholder: 'for in: a, b, c; for exists: true or false', attrs: 'data-af-value' }), 'Dates as YYYY-MM-DD; createdAt and updatedAt take a date too.') + '</div></div><div data-af-err></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add filter', { kind: 'primary', attrs: 'data-af-ok' }),
        onMount(m) { m.querySelector('[data-af-ok]').addEventListener('click', () => { const field = m.querySelector('[data-af-field]').value; const op = m.querySelector('[data-af-op]').value; const raw = m.querySelector('[data-af-value]').value; if (op !== 'exists' && !raw.trim()) { m.querySelector('[data-af-err]').innerHTML = UI.notice('A value is needed for ' + esc(op) + '.', 'warn'); return; } if (st.filters.length >= 30) { m.querySelector('[data-af-err]').innerHTML = UI.notice('At most 30 conditions.', 'warn'); return; } const value = toValue(ent, field, raw, op); if (typeof value === 'number' && isNaN(value)) { m.querySelector('[data-af-err]').innerHTML = UI.notice(esc(field) + ' needs a number or a date.', 'warn'); return; } st.filters.push({ field, op, value }); resetPaging(st); App.closeOverlay(); ctx.rerender(); }); } });
    });
    ctx.on('click', '[data-sort]', () => {
      const fields = [{ value: '', label: 'none' }].concat(idx.map((f) => ({ value: f.name, label: f.title || f.name }))).concat(SYSTEM_FIELDS.filter((s) => s !== 'state' || sm).map((s) => ({ value: s, label: s })));
      const row = (i) => { const s = st.sorts[i] || { field: '', dir: 'asc' }; return '<div class="formgrid">' + UI.field('Sort ' + (i + 1), UI.select(fields, s.field, 'data-so-f="' + i + '"')) + UI.field('Direction ' + (i + 1), UI.select(['asc', 'desc'], s.dir, 'data-so-d="' + i + '"')) + '</div>'; };
      modal(ctx, { title: 'Sort records', body: UI.notice('At most three sorts, on indexed or system fields. Empty values come last, then the record id.', 'info') + row(0) + row(1) + row(2), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Apply', { kind: 'primary', attrs: 'data-so-ok' }),
        onMount(m) { m.querySelector('[data-so-ok]').addEventListener('click', () => { st.sorts = [0, 1, 2].map((i) => ({ field: m.querySelector('[data-so-f="' + i + '"]').value, dir: m.querySelector('[data-so-d="' + i + '"]').value })).filter((s) => s.field); resetPaging(st); App.closeOverlay(); ctx.rerender(); }); } });
    });
    ctx.on('click', '[data-newrec]', () => openRecordModal(ctx, app, ent, null));
    ctx.on('click', '[data-editrec]', () => { if (sel) openRecordModal(ctx, app, ent, sel); });
    ctx.on('click', '[data-delrec]', async () => {
      const ok = await ctx.confirm({ title: 'Delete record ' + sel.id, tag: 'permanent', tone: 'danger', body: '<p class="fg2" style="margin:0">The sealed values and the indexed copy are removed. Triggers on deleted fire without values.</p>', kv: [['Entity', esc(ent.title || ent.name)], ['State', esc(sel.state || 'none')], ['Version', sel.version]], ok: 'Delete' });
      if (!ok) return;
      try { await App.del(E(app.id, ent.id) + '/records/' + enc(sel.id)); st.record = null; st.recordObj = null; invalidate(); ctx.rerender(); ctx.toast(esc(sel.id) + ' deleted. Audited app.record.deleted; event record.deleted.', 'warn'); } catch (err) { App.fail(err, 'Could not delete the record'); }
    });
    ctx.on('click', '[data-transition]', (e, t) => {
      const to = t.dataset.transition; const tr = sm.transitions.find((x) => x.to === to && (x.from.indexOf('*') >= 0 || x.from.indexOf(sel.state) >= 0));
      modal(ctx, { title: 'Move ' + esc(sel.id) + ' to ' + esc(to), body: UI.kv([['From', esc(sel.state || 'none')], ['To', esc(to)], ['Version', sel.version]], 3) + UI.field('Note (optional)', UI.textarea('', { rows: 2, attrs: 'data-tr-note' })) + '<p class="fg2" style="margin:0;font-size:12px">The record moves along the transition <b>' + esc((tr && tr.name) || to) + '</b>' + (tr && tr.roles && tr.roles.length ? ', which needs ' + esc(tr.roles.join(' or ')) : '') + '. Triggers on transitioned fire with from and to.</p>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Transition', { kind: 'primary', attrs: 'data-tr-ok' }),
        onMount(m) { m.querySelector('[data-tr-ok]').addEventListener('click', async () => {
          const note = m.querySelector('[data-tr-note]').value.trim();
          try { const r = await App.post(E(app.id, ent.id) + '/records/' + enc(sel.id) + '/transition', Object.assign({ to, version: sel.version }, note ? { note } : {})); st.recordObj = r; st.problem = null; invalidate(); App.closeOverlay(); ctx.rerender(); ctx.toast(esc(sel.id) + ' is now ' + esc(r.state) + '. Audited app.record.transitioned; event record.transitioned.', 'ok', 5000); }
          catch (err) {
            App.closeOverlay();
            if (err.status === 409) { const p = err.problem || {}; st.problem = { kind: p.allowed ? 'illegal' : 'stale', title: p.title || 'Refused', text: detailOf(err) + (p.allowed ? ' Allowed: ' + JSON.stringify(p.allowed) + '.' : ''), trace: traceOf(err) }; ctx.rerender(); }
            else App.fail(err, 'Could not move the record');
          }
        }); } });
    });
    ctx.on('click', '[data-bulkclear]', () => { st.selected = {}; ctx.rerender(); });
    ctx.on('click', '[data-bulkdelete]', async () => {
      const ids = selIds.slice();
      const ok = await ctx.confirm({ title: 'Delete ' + ids.length + ' record' + (ids.length === 1 ? '' : 's'), tag: 'one transaction', tone: 'danger', body: '<p class="fg2" style="margin:0">All validated first and written together: any problem writes nothing and names the operation.</p>', kv: [['Records', '<span class="mono" style="overflow-wrap:anywhere">' + esc(ids.join(', ')) + '</span>']], ok: 'Delete all' });
      if (!ok) return;
      try { await App.post(E(app.id, ent.id) + '/records/bulk', { delete: ids }); st.selected = {}; if (ids.indexOf(st.record) >= 0) st.record = null; invalidate(); ctx.rerender(); ctx.toast(ids.length + ' records deleted in one transaction. Audited once as app.records.bulk; one record.deleted event each.', 'warn', 4500); } catch (err) { App.fail(err, 'Nothing was deleted'); }
    });
    ctx.on('click', '[data-importcsv]', () => openImportModal(ctx, app, ent));
    ctx.on('click', '[data-exportcsv]', async () => {
      const ok = await ctx.confirm({ title: 'Export ' + (ent.title || ent.name) + ' records', tone: 'info', body: '<p class="fg2" style="margin:0">Runs as a job, as you, with what you may read when it runs: a CSV of id, state, label, timestamps and every field, sealed into the blob store. At most APPS_EXPORT_MAX_ROWS records.</p>', kv: [['Matching records', total], ['Filters', st.filters.length || 'none'], ['Search', esc(st.query || 'none')]], ok: 'Queue export' });
      if (!ok) return;
      const body = {}; if (filter) body.filter = filter; if (st.query) body.q = st.query; if (sorts.length) body.sort = sorts;
      try { const out = await App.post(E(app.id, ent.id) + '/records/export', body); trackTransfer(ctx, app, ent, { id: out.id, kind: 'export', state: 'queued', dryRun: false, createdAt: Date.now() }); ctx.toast('Export queued (job apps.export). Audited app.records.export.queued.'); } catch (err) { App.fail(err, 'Could not queue the export'); }
    });
    ctx.on('click', '[data-aggregate]', () => openAggregate(ctx, app, ent, filter));
    return { body, inspector };
  }

  // Follows an import or export job until it finishes.
  function trackTransfer(ctx, app, ent, t) {
    const st = ctx.state;
    t.entityTitle = ent.title || ent.name; t.ek = app.id + '/' + ent.id;
    const list = st.transfers[app.id] = st.transfers[app.id] || []; list.unshift(t);
    if (st.refresh) st.refresh();
    let tries = 0;
    const tick = () => {
      App.get('/api/apps/transfers/' + enc(t.id)).then((x) => {
        Object.assign(t, x);
        const done = x.state === 'succeeded' || x.state === 'failed';
        if (done) {
          if (t.kind === 'import') { st.importReport = { ek: t.ek, dryRun: x.dryRun, summary: x.summary, report: x.report, error: x.error }; st.recsKey = st.busyRecs = null; }
          App.toast(t.kind === 'import' ? (x.state === 'failed' ? 'Import failed: ' + esc(x.error || '') : x.dryRun ? 'Dry run finished. Audited app.records.import.checked.' : 'Import ran; ' + ((x.summary && x.summary.created) || 0) + ' records written. Audited app.records.imported.') : (x.state === 'failed' ? 'Export failed: ' + esc(x.error || '') : 'Export ready. Audited app.records.exported.'), x.state === 'failed' ? 'danger' : 'ok', 4500);
        } else if (++tries < 120) setTimeout(tick, 1000);
        if (st.refresh) st.refresh();
      }).catch((err) => { t.state = 'unknown'; t.error = detailOf(err); if (st.refresh) st.refresh(); });
    };
    setTimeout(tick, 600);
  }

  function openImportModal(ctx, app, ent) {
    const header = fieldsOf(ent).filter((f) => !computed(f)).map((f) => f.name).join(',');
    modal(ctx, { title: 'Import records into ' + esc(ent.title || ent.name), cls: 'wide', body: UI.notice('A header row names fields (and optionally label; id, state and timestamps are ignored). An unknown column is 400. The job writes each good row as a record of its own and reports the bad ones, up to 500. The sealed CSV is dropped once the job has run.', 'info')
      + UI.field('CSV', UI.textarea(header + '\n', { rows: 6, attrs: 'data-ic-csv spellcheck="false"' }), 'The header lists the fields you can write: ' + header + '.') + UI.check('Dry run: validate only, uniqueness too', true, 'data-ic-dry') + '<div data-ic-err></div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Queue import', { kind: 'primary', attrs: 'data-ic-ok' }),
    onMount(m) {
      m.querySelector('[data-ic-ok]').addEventListener('click', async () => {
        const csv = m.querySelector('[data-ic-csv]').value; const dryRun = m.querySelector('[data-ic-dry]').checked;
        try { const out = await App.post(E(app.id, ent.id) + '/records/import', { csv, dryRun }); App.closeOverlay(); trackTransfer(ctx, app, ent, { id: out.id, kind: 'import', state: 'queued', dryRun, createdAt: Date.now() }); ctx.toast('Import queued (job apps.import). Audited app.records.import.queued.'); }
        catch (err) { m.querySelector('[data-ic-err]').innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
      });
    } });
  }

  function openAggregate(ctx, app, ent, filter) {
    const st = ctx.state; const sm = smOf(ent); const idx = indexedFields(ent);
    const groups = [{ value: '', label: 'no grouping' }].concat(sm ? [{ value: 'state', label: 'state' }] : []).concat(idx.map((f) => ({ value: f.name, label: f.title || f.name })));
    const nums = idx.filter((f) => f.type === 'number' || f.type === 'date' || f.type === 'boolean').map((f) => ({ value: f.name, label: f.title || f.name }));
    ctx.drawer({ title: 'Aggregate ' + esc(ent.title || ent.name), body: UI.notice('Groups by an indexed field or state; metrics over indexed number, date and boolean fields. Ordered by key with empty last, at most 1000 groups. Uses the current search and filters.', 'info')
      + '<div class="formgrid">' + UI.field('Group by', UI.select(groups, sm ? 'state' : (groups[1] ? groups[1].value : ''), 'data-ag-g')) + UI.field('Metric', UI.select(['count', 'sum', 'avg', 'min', 'max'], 'count', 'data-ag-op')) + UI.field('Field', UI.select(nums.length ? nums : [{ value: '', label: 'no indexed number field' }], nums[0] ? nums[0].value : '', 'data-ag-f')) + '</div><div data-ag-out aria-live="polite"></div>',
    actions: UI.btn('Close', { attrs: 'data-close' }),
    onMount(d) {
      const out = d.querySelector('[data-ag-out]');
      const draw = async () => {
        const g = d.querySelector('[data-ag-g]').value, op = d.querySelector('[data-ag-op]').value, f = d.querySelector('[data-ag-f]').value;
        if (op !== 'count' && !f) { out.innerHTML = UI.notice('This metric needs an indexed number, date or boolean field.', 'warn'); return; }
        const body = { metrics: [op === 'count' ? { op: 'count' } : { op, field: f }] }; if (g) body.groupBy = g; if (filter) body.filter = filter; if (st.query) body.q = st.query;
        out.innerHTML = '<div class="muted" style="font-size:12px">Counting…</div>';
        try {
          const r = await App.post(E(app.id, ent.id) + '/records/aggregate', body);
          const vals = r.groups.map((x) => Number(x.values[0]) || 0); const max = Math.max.apply(null, vals.concat([1]));
          out.innerHTML = UI.table(['Group', r.metrics[0], { label: 'Share', right: false }], r.groups.map((x, i) => [esc(x.key == null ? '(empty)' : String(x.key)), '<span class="num">' + esc(x.values[0] == null ? '' : fmtNum(Math.round(x.values[0] * 100) / 100)) + '</span>', UI.meter('', '', (vals[i] / max) * 100, 'accent')]), { clickable: false, minWidth: '0', emptyTitle: 'No groups', emptyText: 'No record matches.' }) + '<div class="muted" style="font-size:12px">' + r.groups.length + ' group' + (r.groups.length === 1 ? '' : 's') + '</div>';
        } catch (err) { out.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
      };
      d.querySelectorAll('select').forEach((s) => s.addEventListener('change', draw)); draw();
    } });
  }

  async function openRecordModal(ctx, app, ent, rec) {
    const st = ctx.state;
    const editable = fieldsOf(ent).filter((f) => !computed(f));
    const opts = await loadOptions(ctx, app, ent, editable.filter(remote));
    const labels = LABELS.filter((l) => rank(l) >= rank(ent.label) && rank(l) <= rank(app.label) && rank(l) <= rank(clearance()));
    const body = '<div class="formgrid">' + editable.map((f) => '<div' + (f.multiline || f.type === 'json' ? ' class="span2"' : '') + '>' + UI.field((f.title || f.name) + (f.required ? ' *' : ''), fieldControl(f, rec ? rec.values[f.name] : null, '', opts[f.name]), f.description ? esc(f.description) : detail(f).replace(/<[^>]+>/g, '')) + '<div data-perr="' + esc(f.name) + '" style="font-size:12px;color:var(--danger-fg)" aria-live="polite"></div></div>').join('')
      + (rec ? UI.field('Version guard', UI.input(rec.version, { readonly: true, attrs: 'data-rec-version' }), 'The write is refused with 409 when a newer version exists.') : UI.field('Label', UI.select(labels.length ? labels : [ent.label], ent.label, 'data-rec-label'), 'Between the entity\'s label and the app\'s, within your clearance.'))
      + '</div>' + (fieldsOf(ent).some(computed) ? UI.notice('Formulas are computed on write; ai fields are filled afterwards by the apps.ai-fill job as you (your inference:invoke and clearance), failing soft.', 'info') : '') + '<div data-rec-problems aria-live="polite"></div>';
    modal(ctx, { title: rec ? 'Edit ' + esc(rec.id) : 'New ' + esc(ent.title || ent.name), cls: 'wide', body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(rec ? 'Save' : 'Create record', { kind: 'primary', attrs: 'data-rec-ok' }),
      onMount(m) {
        m.querySelector('[data-rec-ok]').addEventListener('click', async () => {
          const probs = m.querySelector('[data-rec-problems]'); probs.innerHTML = '';
          m.querySelectorAll('[data-perr]').forEach((el) => { el.textContent = ''; });
          const r = readValues(m, ent);
          if (r.bad.length) { r.bad.forEach((n) => { const el = m.querySelector('[data-perr="' + n + '"]'); if (el) el.textContent = 'Not valid JSON'; }); probs.innerHTML = UI.notice('Fix the JSON in ' + esc(r.bad.join(', ')) + '.', 'warn'); return; }
          const values = r.values;
          if (rec) { Object.keys(values).forEach((k) => { if (JSON.stringify(values[k]) === JSON.stringify(rec.values[k] == null ? null : rec.values[k])) delete values[k]; }); }
          try {
            const url = E(app.id, ent.id) + '/records';
            const out = rec ? await App.patch(url + '/' + enc(rec.id), { values, version: rec.version }) : await App.post(url, { values, label: m.querySelector('[data-rec-label]').value });
            st.record = out.id; st.recordObj = out; st.recsKey = st.busyRecs = null; if (!rec) resetPaging(st);
            App.closeOverlay(); ctx.rerender();
            ctx.toast(rec ? esc(out.id) + ' saved at version ' + out.version + '. Audited app.record.updated; event record.updated.' : 'Record ' + esc(out.id) + ' created' + (out.state ? ' in ' + esc(out.state) : '') + '. Audited app.record.created; event record.created' + (out.aiState === 'pending' ? '; AI fill queued' : '') + '.', 'ok', 4500);
          } catch (err) {
            const p = err.problem || {};
            if (err.status === 400 && Array.isArray(p.problems)) { p.problems.forEach((x) => { const el = x && x.field ? m.querySelector('[data-perr="' + x.field + '"]') : null; if (el) el.textContent = x.message; }); probs.innerHTML = UI.notice('<b>400.</b> ' + esc(detailOf(err)), 'danger'); return; }
            if (err.status === 409 && p.field) { probs.innerHTML = UI.notice('<b>409 Duplicate value.</b> Field <span class="mono">' + esc(p.field) + '</span> is unique and another record already has this value.', 'danger'); const el = m.querySelector('[data-perr="' + p.field + '"]'); if (el) el.textContent = 'Duplicate value'; return; }
            if (err.status === 409 && rec) { App.closeOverlay(); st.problem = { kind: 'stale', title: p.title || 'Record changed since you opened it', text: detailOf(err) + ' Reload the record and apply your change again.', trace: traceOf(err) }; ctx.rerender(); return; }
            probs.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger');
          }
        });
      } });
  }

  // ---------- forms ----------
  function renderForms(ctx, app, design, canWrite) {
    const st = ctx.state;
    const forms = app.forms;
    if (!st.form || !forms.some((f) => f.id === st.form)) st.form = forms[0] ? forms[0].id : null;
    const form = forms.find((f) => f.id === st.form) || null;
    const entOf = (f) => app.entities.find((e) => e.name === f.entity) || null;
    const rows = forms.map((f) => ({ cells: ['<span class="mono">' + esc(f.name) + '</span>', esc(f.title || ''), esc((entOf(f) || {}).title || f.entity), f.public ? UI.pill('public link', 'warn') : UI.pill('private', 'outline'), '<span class="num">' + f.ratePerMinute + '</span>', '<span class="num">' + f.definition.fields.length + '</span>'], attrs: 'data-form="' + esc(f.id) + '" tabindex="0" aria-label="Form ' + esc(f.name) + '"', selected: f.id === st.form }));
    const table = UI.panel('Forms', UI.table(['Name', 'Title', 'Entity', 'Access', 'Per minute', 'Fields'], rows, { minWidth: '0', emptyTitle: 'No forms', emptyText: 'A form lists an entity\'s fields in order and can be published as a link.' }) + (design ? '<div>' + UI.btn('New form', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newform', disabled: !app.entities.length }) + '</div>' : ''));
    ctx.on('click', 'tr[data-form]', (e, t) => { st.form = t.dataset.form; st.lastSubmit = null; ctx.rerender(); });
    ctx.on('keydown', 'tr[data-form]', (e, t) => { if (e.target !== t || (e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); st.form = t.dataset.form; st.lastSubmit = null; ctx.rerender(); });
    ctx.on('click', '[data-newform]', () => openNewForm(ctx, app));
    if (!form) return table;

    const ent = entOf(form);
    if (!st.fdraft || st.fdraft.id !== form.id || st.fdraft.at !== form.updatedAt) st.fdraft = { id: form.id, at: form.updatedAt, title: form.title, definition: clone(form.definition), ratePerMinute: form.ratePerMinute, dirty: false };
    const fd = st.fdraft; const def = fd.definition;
    const spare = ent ? fieldsOf(ent).filter((f) => !computed(f) && !def.fields.some((x) => x.field === f.name)) : [];
    const missingRequired = ent ? fieldsOf(ent).filter((f) => f.required && !def.fields.some((x) => x.field === f.name)).map((f) => f.name) : [];
    const badPublic = form.public && ent ? def.fields.map((x) => fieldByName(ent, x.field)).filter((f) => f && (f.type === 'file' || f.type === 'reference' || (f.type === 'lookup' && f.source !== 'static'))).map((f) => f.name) : [];
    const pv = st.preview[form.id] || (st.preview[form.id] = {});
    const frows = def.fields.map((x, i) => { const f = ent ? fieldByName(ent, x.field) : null; return '<div class="apps-ff"><span class="muted num">' + (i + 1) + '</span><span><span class="mono">' + esc(x.field) + '</span> <span class="muted" style="font-size:11px">' + esc(f ? f.type : 'unknown') + (f && f.required ? ', required' : x.required ? ', required here' : '') + '</span></span><span style="font-size:12px">' + esc(x.label || (f ? f.title || '' : '')) + (x.help ? '<span class="muted"> · ' + esc(x.help) + '</span>' : '') + '</span><span style="font-size:12px">' + (x.visibleIf ? '<span class="mono">if ' + esc(x.visibleIf.field) + ' ' + esc(x.visibleIf.op) + (x.visibleIf.value != null ? ' ' + esc(Array.isArray(x.visibleIf.value) ? x.visibleIf.value.join(', ') : String(x.visibleIf.value)) : '') + '</span>' : '<span class="muted">always shown</span>') + '</span>' + (design ? '<span class="apps-ffa">' + UI.iconbtn('chevd', 'Move ' + x.field + ' down', { attrs: 'data-fmove="' + i + '"', cls: 'sm ghost' }) + UI.iconbtn('edit', 'Edit ' + x.field, { attrs: 'data-fedit="' + i + '"', cls: 'sm ghost' }) + UI.iconbtn('trash', 'Remove ' + x.field + ' from the form', { attrs: 'data-fdel="' + i + '"', cls: 'sm ghost' }) + '</span>' : '') + '</div>'; }).join('');
    const previewFields = def.fields.filter((x) => condOk(x.visibleIf, pv)).map((x) => { const f = ent ? fieldByName(ent, x.field) : null; if (!f) return ''; const c = st.optCache[ent.id + ':' + f.name]; const o = c ? Object.keys(c).map((k) => ({ value: k, label: c[k] })) : undefined; return UI.field((x.label || f.title || f.name) + (x.required || f.required ? ' *' : ''), fieldControl(f, pv[f.name], 'data-pv', o), esc(x.help || '')); }).join('');
    const tokenBox = st.formToken && st.formToken.id === form.id ? UI.notice('<b>Public link token for ' + esc(form.name) + '. Copy it now; it is shown once.</b><div class="mono apps-token" style="margin-top:4px">' + esc(st.formToken.token) + '</div><div class="muted" style="font-size:12px;margin-top:4px">Anyone holding it opens the form with POST /api/public/forms/open and submits with /api/public/forms/submit, as no one (createdBy null, source form), limited per address and per form, then 429 with Retry-After. An older token stopped working.</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-ftokencopy' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-fdone' })) : form.public ? '<div class="muted" style="font-size:12px">Public link active. The token is not stored in clear; rotate it to get a new one.</div>' : '';
    const editor = design ? '<div class="formgrid">' + UI.field('Title', UI.input(fd.title || '', { attrs: 'data-ftitle' })) + UI.field('Per minute (public)', UI.input(fd.ratePerMinute, { type: 'number', attrs: 'data-frate' })) + UI.field('Submit label', UI.input(def.submitLabel || '', { attrs: 'data-fsubmit', placeholder: 'Submit' })) + UI.field('Success message', UI.input(def.successMessage || '', { attrs: 'data-fsuccess' })) + '</div>'
      + '<div class="hstack wrap gap6">' + UI.btn('Save form', { kind: 'primary', size: 'sm', attrs: 'data-fsave', disabled: !!missingRequired.length || !def.fields.length }) + (fd.dirty ? '<span class="muted" style="font-size:12px">Unsaved changes</span>' : '') + (form.public ? UI.btn('Rotate link', { size: 'sm', icon: 'refresh', attrs: 'data-frotate' }) + UI.btn('Unpublish', { size: 'sm', attrs: 'data-funpublish' }) : UI.btn('Publish public link', { size: 'sm', icon: 'link', attrs: 'data-fpublish' })) + UI.btn('Delete form', { size: 'sm', kind: 'ghost', attrs: 'data-fdelete' }) + '</div>' : '';
    const builder = UI.panel((design ? 'Builder: ' : 'Form: ') + esc(form.title || form.name), (missingRequired.length ? UI.notice('<b>The form must ask for every field the entity requires.</b> Missing: <span class="mono">' + esc(missingRequired.join(', ')) + '</span>. Saving is refused until they are added.', 'warn') : '') + (badPublic.length ? UI.notice('<b>A public form cannot ask for files, references or user, workspace or record lookups.</b> Remove <span class="mono">' + esc(badPublic.join(', ')) + '</span> or make the form private.', 'danger') : '') + (st.formProblem && st.formProblem.id === form.id ? UI.problem(st.formProblem.title, st.formProblem.text, st.formProblem.trace || false) : '')
      + '<div class="grid2"><div class="vstack gap12" style="min-width:0"><div class="eyebrow">Fields in order</div><div>' + (frows || '<div class="muted" style="font-size:12px">No fields yet.</div>') + '</div>' + (design ? '<div class="hstack wrap gap6">' + UI.btn('Add field', { size: 'sm', icon: 'plus', attrs: 'data-fadd', disabled: !spare.length }) + '<span class="muted" style="font-size:12px">A condition reads a field earlier on the form. On submission the server keeps only the fields shown given the earlier answers; the rest is dropped and counted.</span></div>' : '')
      + editor + tokenBox
      + '</div><div class="vstack gap12" style="min-width:0"><div class="eyebrow">Live preview</div><div class="apps-preview"><div style="font-weight:600;font-size:15px">' + esc(fd.title || form.name) + '</div>' + (previewFields || '<div class="muted">Nothing to show.</div>') + (canWrite ? '<div>' + UI.btn(def.submitLabel || 'Submit', { kind: 'primary', size: 'sm', attrs: 'data-ftest' }) + '</div>' : '') + '</div><span class="muted" style="font-size:12px">Fields hidden by a condition disappear as you answer. Submitting writes a record with source form through the saved form and reports the dropped fields.</span>' + (st.lastSubmit && st.lastSubmit.id === form.id ? UI.notice('<b>201 Submitted.</b> Record <span class="mono">' + esc(st.lastSubmit.rec) + '</span> created; dropped: ' + (st.lastSubmit.dropped.length ? '<span class="mono">' + esc(st.lastSubmit.dropped.join(', ')) + '</span>' : 'none') + '. Every text value passed the user-input checkpoint.', 'ok') : '') + '</div></div>',
      { actions: UI.pill(form.public ? 'public link' : 'private', form.public ? 'warn' : 'outline') });

    const F = A(app.id) + '/forms/' + enc(form.id);
    const pvSet = (t) => { const f = ent ? fieldByName(ent, t.dataset.fv) : null; let v = t.value; if (v === '') v = null; else if (f && f.type === 'number') v = Number(v); else if (f && f.type === 'boolean') v = v === 'true'; pv[t.dataset.fv] = v; };
    ctx.on('input', '[data-pv]', (e, t) => pvSet(t));
    const shownNow = () => def.fields.filter((x) => condOk(x.visibleIf, pv)).map((x) => x.field).join(',');
    const shownAtRender = shownNow();
    // A condition may show or hide later fields: re-render once focus has moved on, and keep it where it went.
    ctx.on('change', '[data-pv]', (e, t) => { pvSet(t); setTimeout(() => { if (App.state.route !== 'apps' || overlayOpen() || shownNow() === shownAtRender) return; const a = document.activeElement; const fv = a && a.dataset ? a.dataset.fv : null; ctx.rerender(); const el = fv ? ctx.$('[data-pv][data-fv="' + fv + '"]') : null; if (el) el.focus(); }, 0); });
    ctx.on('click', '[data-ftest]', async () => {
      if (!ent) return;
      const values = {}; Object.keys(pv).forEach((k) => { if (pv[k] != null && pv[k] !== '') values[k] = pv[k]; });
      try { const out = await App.post(F + '/submit', { values }); st.lastSubmit = { id: form.id, rec: out.id, dropped: out.dropped || [] }; st.preview[form.id] = {}; st.recsKey = st.busyRecs = null; ctx.rerender(); ctx.toast('201: ' + esc(def.successMessage || 'Submitted.') + ' Audited app.form.submitted.', 'ok'); }
      catch (err) { App.fail(err, 'The form was not submitted'); }
    });
    if (design) {
      const capture = () => { const g = (s) => ctx.$(s); if (g('[data-ftitle]')) { fd.title = g('[data-ftitle]').value; fd.ratePerMinute = +g('[data-frate]').value || fd.ratePerMinute; def.submitLabel = g('[data-fsubmit]').value; def.successMessage = g('[data-fsuccess]').value; } };
      const touch = () => { capture(); fd.dirty = true; ctx.rerender(); };
      ctx.on('click', '[data-fmove]', (e, t) => { const i = +t.dataset.fmove; const a = def.fields; const j = i + 1 < a.length ? i + 1 : 0; const x = a.splice(i, 1)[0]; a.splice(j, 0, x); touch(); });
      ctx.on('click', '[data-fdel]', (e, t) => { def.fields.splice(+t.dataset.fdel, 1); touch(); });
      ctx.on('click', '[data-fadd]', () => { capture(); openFormFieldModal(ctx, form, ent, null, spare); });
      ctx.on('click', '[data-fedit]', (e, t) => { capture(); openFormFieldModal(ctx, form, ent, +t.dataset.fedit, spare); });
      ctx.on('input', '[data-ftitle],[data-frate],[data-fsubmit],[data-fsuccess]', () => { capture(); fd.dirty = true; });
      ctx.on('click', '[data-fsave]', async () => {
        capture();
        const d = clone(def); if (!d.submitLabel) delete d.submitLabel; if (!d.successMessage) delete d.successMessage;
        const body = { definition: d, ratePerMinute: fd.ratePerMinute }; if (fd.title && fd.title.trim()) body.title = fd.title.trim();
        try { await App.patch(F, body); st.formProblem = null; st.fdraft = null; afterChange(ctx, {}); ctx.toast('Form saved. Audited app.form.updated.', 'ok'); }
        catch (err) { st.formProblem = { id: form.id, title: 'Form not saved', text: detailOf(err), trace: traceOf(err) }; ctx.rerender(); }
      });
      const publish = async (enabled, title, body, okLabel, msg) => {
        const ok = await ctx.confirm({ title, tag: enabled ? 'anyone with the link' : '', tone: 'warn', body: '<p class="fg2" style="margin:0">' + body + '</p>', ok: okLabel });
        if (!ok) return;
        try { const out = await App.post(F + '/public', { enabled }); st.formToken = enabled && out.token ? { id: form.id, token: out.token } : null; afterChange(ctx, {}); ctx.toast(msg, 'ok'); }
        catch (err) { st.formProblem = { id: form.id, title: enabled ? 'Not published' : 'Still public', text: detailOf(err), trace: traceOf(err) }; ctx.rerender(); }
      };
      ctx.on('click', '[data-fpublish]', () => publish(true, 'Publish ' + form.name + ' as a public link', 'Anyone with the link can open the form and submit records as no one. Only the fields the form shows are written; the entity\'s other fields are never revealed. Limited per address and per form (' + form.ratePerMinute + ' a minute).', 'Publish', 'Form published. Audited app.form.published.'));
      ctx.on('click', '[data-frotate]', () => publish(true, 'Rotate the public link', 'A new token is issued and shown once; the older link stops working at once.', 'Rotate', 'Link rotated. Audited app.form.link.rotated.'));
      ctx.on('click', '[data-funpublish]', () => publish(false, 'Make ' + form.name + ' private', 'The public link stops working. Signed-in members can still submit it.', 'Unpublish', 'Form is private again. Audited app.form.unpublished.'));
      ctx.on('click', '[data-fdone]', () => { st.formToken = null; ctx.rerender(); });
      ctx.on('click', '[data-ftokencopy]', () => { const t = st.formToken && st.formToken.token; if (!t) return; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject(new Error('no clipboard'))).then(() => ctx.toast('Token copied.'), () => ctx.toast('Select the token and copy it.', 'warn')); });
      ctx.on('click', '[data-fdelete]', async () => {
        const ok = await ctx.confirm({ title: 'Delete form ' + form.name, tone: 'danger', body: '<p class="fg2" style="margin:0">Its public link, if any, stops working. Records it created stay.</p>', ok: 'Delete' });
        if (!ok) return;
        try { await App.del(F); st.form = null; st.fdraft = null; afterChange(ctx, {}); ctx.toast('Form deleted. Audited app.form.deleted.', 'warn'); } catch (err) { App.fail(err, 'Could not delete the form'); }
      });
    }
    return table + builder;
  }

  function openNewForm(ctx, app) {
    const st = ctx.state;
    modal(ctx, { title: 'New form', body: '<div class="formgrid">' + UI.field('Name', UI.input('', { attrs: 'data-nf-name', placeholder: 'lower-case letters, digits and _' })) + UI.field('Title', UI.input('', { attrs: 'data-nf-title' })) + UI.field('Entity', UI.select(app.entities.map((e) => ({ value: e.name, label: e.title || e.name })), app.entities[0] ? app.entities[0].name : '', 'data-nf-entity')) + UI.field('Per minute (public)', UI.input(60, { type: 'number', attrs: 'data-nf-rate' })) + '</div>' + UI.notice('The form starts with the entity\'s required fields, in their order (or its first field when none is required).', 'info') + '<div data-nf-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create form', { kind: 'primary', attrs: 'data-nf-ok' }),
      onMount(m) {
        m.querySelector('[data-nf-ok]').addEventListener('click', async () => {
          const errEl = m.querySelector('[data-nf-err]'); errEl.innerHTML = '';
          const name = m.querySelector('[data-nf-name]').value.trim();
          if (!NAME_RE.test(name)) { errEl.innerHTML = UI.notice('A form name is lower-case letters, digits and _, starting with a letter.', 'warn'); return; }
          const e = app.entities.find((x) => x.name === m.querySelector('[data-nf-entity]').value);
          const req = fieldsOf(e).filter((f) => f.required); const first = fieldsOf(e).filter((f) => !computed(f));
          const fields = (req.length ? req : first.slice(0, 1)).map((f) => (f.required ? { field: f.name, required: true } : { field: f.name }));
          const body = { name, entity: e.name, definition: { fields }, ratePerMinute: +m.querySelector('[data-nf-rate]').value || 60 }; const title = m.querySelector('[data-nf-title]').value.trim(); if (title) body.title = title;
          try { const out = await App.post(A(app.id) + '/forms', body); st.form = out.id; st.fdraft = null; afterChange(ctx, {}); ctx.toast('Form ' + esc(name) + ' created. Audited app.form.created.', 'ok'); }
          catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
        });
      } });
  }

  function openFormFieldModal(ctx, form, ent, idx, spare) {
    const st = ctx.state; const fd = st.fdraft; const def = fd.definition;
    const x = idx == null ? {} : clone(def.fields[idx]);
    const earlier = (idx == null ? def.fields : def.fields.slice(0, idx)).map((f) => f.field);
    const cond = x.visibleIf || {};
    modal(ctx, { title: idx == null ? 'Add a field to the form' : 'Edit ' + esc(x.field), body: '<div class="formgrid">' + (idx == null ? UI.field('Field', UI.select(spare.map((f) => ({ value: f.name, label: f.title || f.name })), spare[0] ? spare[0].name : '', 'data-xf-field')) : UI.field('Field', UI.input(x.field, { readonly: true }))) + UI.field('Label', UI.input(x.label || '', { attrs: 'data-xf-label', placeholder: 'defaults to the field title' })) + '<div class="span2">' + UI.field('Help', UI.input(x.help || '', { attrs: 'data-xf-help' })) + '</div></div>' + UI.check('Required on this form', !!x.required, 'data-xf-required')
      + '<div class="divider"></div><div class="eyebrow">Visible if (optional)</div><div class="formgrid">' + UI.field('Earlier field', UI.select([{ value: '', label: 'always shown' }].concat(earlier.map((n) => ({ value: n, label: n }))), cond.field || '', 'data-xf-cf'), 'A condition may only read a field earlier on the form.') + UI.field('Operator', UI.select(['eq', 'ne', 'in', 'truthy', 'falsy'], cond.op || 'eq', 'data-xf-cop')) + '<div class="span2">' + UI.field('Value', UI.input(cond.value == null ? '' : Array.isArray(cond.value) ? cond.value.join(', ') : String(cond.value), { attrs: 'data-xf-cv', placeholder: 'for in: a, b' })) + '</div></div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(idx == null ? 'Add' : 'Done', { kind: 'primary', attrs: 'data-xf-ok' }),
    onMount(m) {
      m.querySelector('[data-xf-ok]').addEventListener('click', () => {
        const nx = { field: idx == null ? m.querySelector('[data-xf-field]').value : x.field };
        if (m.querySelector('[data-xf-required]').checked) nx.required = true;
        const label = m.querySelector('[data-xf-label]').value.trim(); if (label) nx.label = label;
        const help = m.querySelector('[data-xf-help]').value.trim(); if (help) nx.help = help;
        const cf = m.querySelector('[data-xf-cf]').value;
        if (cf) {
          const op = m.querySelector('[data-xf-cop]').value; const v = m.querySelector('[data-xf-cv]').value; const cfDef = ent ? fieldByName(ent, cf) : null;
          const typed = (s) => (cfDef && cfDef.type === 'number' && s !== '' && !isNaN(Number(s)) ? Number(s) : cfDef && cfDef.type === 'boolean' ? s === 'true' : s);
          nx.visibleIf = { field: cf, op };
          if (op === 'in') nx.visibleIf.value = v.split(',').map((s) => s.trim()).filter(Boolean).map(typed); else if (op === 'eq' || op === 'ne') nx.visibleIf.value = typed(v.trim());
        }
        if (idx == null) def.fields.push(nx); else def.fields[idx] = nx;
        fd.dirty = true; App.closeOverlay(); ctx.rerender();
      });
    } });
  }

  // ---------- triggers ----------
  // ---------- Policies tab (1.6.0, B-8101 to B-8103) ----------
  const MASKS = ['last4', 'hash', 'hidden'];
  const SUBJECT_KINDS = ['everyone', 'role', 'group', 'workspace', 'user'];
  const PLACEHOLDER_RE = /^\$user\.(id|username|clearance|roles|groups|workspaces|attributes\.[a-z][a-z0-9_]{0,62})$/;
  const LIST_PLACEHOLDERS = ['$user.roles', '$user.groups', '$user.workspaces'];
  const subjectText = (s) => (s.kind === 'everyone' ? 'everyone' : s.kind + ' ' + s.value);
  const rowsText = (p) => (p.rows ? ('field' in p.rows ? p.rows.field + ' ' + p.rows.op + ' ' + (Array.isArray(p.rows.value) ? p.rows.value.join(', ') : p.rows.value) : JSON.stringify(p.rows)) : 'every row');
  const fieldsText = (p) => { const named = Object.keys(p.fields || {}); return named.length ? named.map((f) => { const g = p.fields[f]; return f + ': ' + (!g.read ? 'hidden' : !g.unmasked ? 'masked ' + g.mask : 'read') + (g.update === false ? ', no update' : '') + (g.create === false ? ', no create' : ''); }).join('; ') : 'every field in full'; };

  function renderPolicies(ctx, app) {
    const st = ctx.state;
    const key = app.id;
    if (st.polKey !== key && st.polBusy !== key) {
      st.polBusy = key;
      App.get(A(app.id) + '/policies')
        .then((d) => { st.pol = d; st.polKey = key; st.polError = null; })
        .catch((err) => { st.polError = err; st.polKey = key; })
        .finally(() => { st.polBusy = null; if (App.state.route === 'apps' && !overlayOpen()) ctx.rerender(); else st.dirty = true; });
    }
    if (st.polKey !== key) return UI.notice('Loading policies…', 'info');
    if (st.polError) return UI.problem('Policies could not be loaded', detailOf(st.polError), traceOf(st.polError)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-polreload' }) + '</div>';
    const policies = st.pol.policies || [];
    const rows = policies.map((p) => ({ cells: ['<b>' + esc(p.name) + '</b>' + (p.description ? '<div class="muted" style="font-size:12px">' + esc(p.description) + '</div>' : ''), p.entity ? esc(p.entity) : '<span class="muted">every entity</span>', esc(p.subjects.map(subjectText).join(', ')), '<span class="mono" style="font-size:12px">' + esc(rowsText(p)) + '</span>', esc(fieldsText(p)), UI.pill(p.enabled ? 'enabled' : 'off', p.enabled ? 'ok' : ''), UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-editpolicy="' + esc(p.id) + '"' }) + ' ' + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-delpolicy="' + esc(p.id) + '"' })], attrs: 'data-policy="' + esc(p.id) + '"' }));
    const table = UI.panel('Row and field policies', UI.notice('A policy names who it applies to, the rows they reach (a condition on an indexed field compared with the reader: <span class="mono">$user.attributes.region</span>, <span class="mono">$user.id</span>, <span class="mono">$user.groups</span>…) and what each field shows: read, read unmasked, create, update, with a mask (<span class="mono">last4</span>, <span class="mono">hash</span>, <span class="mono">hidden</span>) for readers without unmasked. Once an entity has a policy, a reader no policy names reaches nothing. Designers are not subject to policies. Labels still apply first.', 'info')
      + (st.polProblem ? UI.problem(st.polProblem.title, st.polProblem.text, st.polProblem.trace) : '')
      + UI.table(['Policy', 'Entity', 'Subjects', 'Rows', 'Fields', 'State', { label: '', right: true }], rows, { clickable: false, minWidth: '960px', emptyTitle: 'No policies', emptyText: 'Every member of the workspace reads every record within their clearance. Add a policy to narrow rows and fields per role, group, workspace or user.' })
      + '<div class="hstack gap6 wrap">' + UI.btn('New policy', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newpolicy' }) + '</div>');

    // ----- explain (B-8103) -----
    const ex = st.explain || (st.explain = { username: '', entity: app.entities[0] ? app.entities[0].name : '', recordId: '', field: '' });
    if (!app.entities.some((e) => e.name === ex.entity)) ex.entity = app.entities[0] ? app.entities[0].name : '';
    const exEnt = app.entities.find((e) => e.name === ex.entity) || null;
    const r = st.explainResult && st.explainResult.key === key ? st.explainResult : null;
    const pillFor = (t) => UI.pill(t, /^no /.test(t) ? 'warn' : /masked/.test(t) ? 'info' : 'ok');
    const result = !r ? '' : r.error ? UI.problem('Explain failed', detailOf(r.error), traceOf(r.error)) : (() => {
      const u = r.data.user;
      const rec = r.data.record;
      const f = r.data.field;
      return UI.kv([
        ['Reader', esc(u.username) + (u.designer ? ' ' + UI.pill('designer', 'accent') : '') + ', clearance ' + UI.label(u.clearance, { sm: true })],
        ['Compared by', 'roles ' + esc(u.roles.join(', ') || 'none') + '; groups ' + esc(u.groups.join(', ') || 'none') + '; workspaces ' + esc(String(u.workspaces.length)) + '; attributes ' + esc(Object.keys(u.attributes).length ? JSON.stringify(u.attributes) : 'none')],
        ['Policies on ' + esc(ex.entity), r.data.policed ? (r.data.none ? UI.pill('none name this reader', 'danger') + ' they reach no record' : r.data.policies.filter((p) => p.matches).length + ' of ' + r.data.policies.length + ' name this reader') : u.designer ? 'a designer is not subject to policies' : 'none: every record within their clearance'],
        ['Record', rec ? (rec.reachable ? UI.pill('reachable', 'ok') + (rec.by ? ' by ' + esc(rec.by) : '') : UI.pill('not reachable', 'danger') + (rec.by ? ' ' + esc(rec.by) : '')) : '<span class="muted">none asked</span>'],
        ['Field', f ? [f.read ? 'read' : 'no read', f.unmasked ? 'unmasked' : 'masked ' + f.mask, f.create ? 'create' : 'no create', f.update ? 'update' : 'no update'].map(pillFor).join(' ') + (f.by ? ' by ' + esc(f.by) : '') : '<span class="muted">none asked</span>']
      ], 1) + (r.data.policies.length ? UI.table(['Policy', 'Names the reader', 'Why', 'Rows'], r.data.policies.map((p) => [esc(p.name), p.matches ? UI.pill('yes', 'ok') : UI.pill('no', ''), esc(p.reason), p.rows ? '<span class="mono" style="font-size:12px">' + esc(rowsText({ rows: p.rows })) + '</span>' : '<span class="muted">every row</span>']), { clickable: false, cls: 'bare', minWidth: '0' }) : '');
    })();
    const explain = UI.panel('Explain: what a reader gets', '<div class="formgrid">'
      + UI.field('Reader (username)', UI.input(ex.username, { placeholder: 'ana', attrs: 'data-exuser aria-label="Reader username"' }))
      + UI.field('Entity', UI.select(app.entities.map((e) => ({ value: e.name, label: e.title || e.name })), ex.entity, 'data-exentity aria-label="Entity"'))
      + UI.field('Record id (optional)', UI.input(ex.recordId, { placeholder: '26 characters', attrs: 'data-exrecord aria-label="Record id"' }))
      + UI.field('Field (optional)', UI.select([{ value: '', label: 'none' }].concat(exEnt ? fieldsOf(exEnt).map((f) => ({ value: f.name, label: f.name })) : []), ex.field, 'data-exfield aria-label="Field"'))
      + '</div><div class="hstack gap6">' + UI.btn('Explain', { size: 'sm', attrs: 'data-explain' }) + '<span class="muted" style="font-size:12px">Which policy names the reader, whether the record is in their reach and what the field shows.</span></div>'
      + result);

    ctx.on('click', '[data-polreload]', () => { st.polKey = st.polBusy = null; st.polError = null; ctx.rerender(); });
    ctx.on('input', '[data-exuser]', (e, t) => { ex.username = t.value; });
    ctx.on('input', '[data-exrecord]', (e, t) => { ex.recordId = t.value.trim(); });
    ctx.on('change', '[data-exentity]', (e, t) => { ex.entity = t.value; ex.field = ''; ctx.rerender(); });
    ctx.on('change', '[data-exfield]', (e, t) => { ex.field = t.value; });
    ctx.on('click', '[data-explain]', async () => {
      if (!ex.username.trim()) { ctx.toast('Name the reader.', 'warn'); return; }
      const body = { username: ex.username.trim() }; if (ex.recordId) body.recordId = ex.recordId; if (ex.field) body.field = ex.field;
      try { const data = await App.post(E(app.id, ex.entity) + '/policies/explain', body); st.explainResult = { key, data }; } catch (err) { st.explainResult = { key, error: err }; }
      ctx.rerender();
    });
    ctx.on('click', '[data-newpolicy]', () => openPolicyModal(ctx, app, null));
    ctx.on('click', '[data-editpolicy]', (e, t) => openPolicyModal(ctx, app, policies.find((p) => p.id === t.dataset.editpolicy)));
    ctx.on('click', '[data-delpolicy]', async (e, t) => {
      const p = policies.find((x) => x.id === t.dataset.delpolicy); if (!p) return;
      const ok = await ctx.confirm({ title: 'Remove ' + p.name, tone: 'danger', body: '<p class="fg2" style="margin:0">Readers it named lose what it granted at once. Audited app.policy.deleted.</p>', ok: 'Remove' });
      if (!ok) return;
      try { await App.del(A(app.id) + '/policies/' + enc(p.id)); st.polKey = null; st.polProblem = null; ctx.rerender(); ctx.toast('Policy ' + esc(p.name) + ' removed. Audited app.policy.deleted.', 'ok'); } catch (err) { App.fail(err, 'Could not remove the policy'); }
    });
    return table + explain;
  }

  function openPolicyModal(ctx, app, existing) {
    const st = ctx.state;
    const p = existing ? clone(existing) : { name: '', description: '', enabled: true, entity: app.entities[0] ? app.entities[0].name : null, subjects: [{ kind: 'role', value: 'member' }], rows: null, fields: {}, otherFields: { read: true, unmasked: true, create: true, update: true } };
    const entOf = (name) => app.entities.find((e) => e.name === name) || null;
    const leaf = p.rows && 'field' in p.rows ? p.rows : null;
    const draft = { entity: p.entity || '', subjects: p.subjects.slice(), rowField: leaf ? leaf.field : '', rowOp: leaf ? leaf.op : 'eq', rowValue: leaf ? (Array.isArray(leaf.value) ? leaf.value.join(', ') : String(leaf.value)) : '$user.attributes.region', fields: clone(p.fields || {}), enabled: p.enabled !== false, name: p.name, description: p.description || '' };
    const body = () => {
      const ent = entOf(draft.entity);
      const covered = ent ? [ent] : app.entities;
      const indexed = covered.length ? covered[0] : null;
      const fieldNames = ent ? fieldsOf(ent).map((f) => f.name) : app.entities.length ? fieldsOf(app.entities[0]).map((f) => f.name).filter((n) => app.entities.every((e) => fieldsOf(e).some((f) => f.name === n))) : [];
      const grantRow = (name) => { const g = draft.fields[name] || { read: true, unmasked: true, create: true, update: true, mask: 'hidden' }; const f = ent ? fieldByName(ent, name) : null; return '<tr><td class="mono">' + esc(name) + (f && !(f.indexed || f.unique) ? ' <span class="muted">(not indexed)</span>' : '') + '</td>' + ['read', 'unmasked', 'create', 'update'].map((k) => '<td style="text-align:center"><input type="checkbox" data-grant="' + esc(name) + ':' + k + '"' + (g[k] !== false ? ' checked' : '') + ' aria-label="' + esc(name + ' ' + k) + '"></td>').join('') + '<td>' + UI.select(MASKS, g.mask || 'hidden', 'data-grant="' + esc(name) + ':mask" aria-label="' + esc(name) + ' mask"') + '</td></tr>'; };
      const subjRows = draft.subjects.map((s, i) => '<div class="hstack gap6" style="margin-bottom:6px">' + UI.select(SUBJECT_KINDS, s.kind, 'data-skind="' + i + '" aria-label="Subject kind"') + UI.input(s.value || '', { placeholder: 'member, finance-ops, a workspace id, a username', attrs: 'data-svalue="' + i + '" aria-label="Subject value"' }) + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-sdel="' + i + '" aria-label="Remove subject"' }) + '</div>').join('');
      return '<div class="formgrid">' + UI.field('Name', UI.input(draft.name, { attrs: 'data-pname aria-label="Policy name"' })) + UI.field('Description', UI.input(draft.description, { attrs: 'data-pdesc aria-label="Description"' }))
        + UI.field('Entity', UI.select([{ value: '', label: 'Every entity of the app' }].concat(app.entities.map((e) => ({ value: e.name, label: e.title || e.name }))), draft.entity, 'data-pentity aria-label="Entity"'), 'An app-wide policy may only use fields every entity has.')
        + UI.field('Enabled', UI.toggle('In force', draft.enabled, 'data-penabled')) + '</div>'
        + '<div class="eyebrow" style="margin-top:10px">Applies to</div>' + subjRows + UI.btn('Add subject', { size: 'xs', kind: 'ghost', attrs: 'data-sadd' })
        + '<div class="eyebrow" style="margin-top:10px">Rows</div><div class="hstack gap6 wrap">' + UI.select([{ value: '', label: 'Every row' }].concat((indexed ? fieldNames.filter((n) => covered.every((e) => { const f = fieldByName(e, n); return f && (f.indexed || f.unique); })) : []).concat(SYSTEM_FIELDS).map((n) => ({ value: n, label: n }))), draft.rowField, 'data-prfield aria-label="Row field"') + UI.select(OPS.filter((o) => o !== 'exists'), draft.rowOp, 'data-prop aria-label="Operator"') + UI.input(draft.rowValue, { attrs: 'data-prvalue aria-label="Value"' }) + '</div><div class="muted" style="font-size:12px">Only indexed or unique fields, or id, state, createdAt, updatedAt, createdBy. A value starting with $user. is the reader\'s fact ($user.id, $user.username, $user.clearance, $user.roles, $user.groups, $user.workspaces, $user.attributes.&lt;name&gt;); the list placeholders go with in. Several values for in: comma-separated.</div>'
        + '<div class="eyebrow" style="margin-top:10px">Fields' + (ent ? ' of ' + esc(ent.title || ent.name) : ' every entity has') + '</div><div class="tablewrap"><table class="table bare" style="min-width:0"><thead><tr><th>Field</th><th>Read</th><th>Unmasked</th><th>Create</th><th>Update</th><th>Mask</th></tr></thead><tbody>' + fieldNames.map(grantRow).join('') + '</tbody></table></div><div class="muted" style="font-size:12px;margin-top:6px">A field left in full stays in full. Masks apply to readers with read but not unmasked: last4 keeps the last four letters or digits (***-**-1234), hash shows a short SHA-256, hidden shows nothing.</div>';
    };
    const capture = (m) => {
      draft.name = m.querySelector('[data-pname]').value; draft.description = m.querySelector('[data-pdesc]').value; draft.entity = m.querySelector('[data-pentity]').value; draft.enabled = m.querySelector('[data-penabled]').classList.contains('on');
      draft.subjects = [...m.querySelectorAll('[data-skind]')].map((el) => ({ kind: el.value, value: m.querySelector('[data-svalue="' + el.dataset.skind + '"]').value.trim() }));
      draft.rowField = m.querySelector('[data-prfield]').value; draft.rowOp = m.querySelector('[data-prop]').value; draft.rowValue = m.querySelector('[data-prvalue]').value.trim();
      const fields = {}; m.querySelectorAll('[data-grant]').forEach((el) => { const i = el.dataset.grant.lastIndexOf(':'); const f = el.dataset.grant.slice(0, i), k = el.dataset.grant.slice(i + 1); fields[f] = fields[f] || { read: true, unmasked: true, create: true, update: true, mask: 'hidden' }; fields[f][k] = k === 'mask' ? el.value : el.checked; });
      draft.fields = fields;
    };
    const repaint = (m) => { capture(m); m.querySelector('[data-pbody]').innerHTML = body(); };
    modal(ctx, {
      title: existing ? 'Edit ' + existing.name : 'New policy', cls: 'wide',
      body: '<div data-pbody>' + body() + '</div>',
      actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn(existing ? 'Save' : 'Create policy', { kind: 'primary', attrs: 'data-psave' }),
      onMount(m) {
        m.addEventListener('change', (e) => { if (e.target.matches('[data-pentity]')) repaint(m); });
        m.addEventListener('click', (e) => {
          const t = e.target.closest('[data-penabled],[data-sadd],[data-sdel]'); if (!t) return;
          if (t.matches('[data-penabled]')) { t.classList.toggle('on'); t.setAttribute('aria-checked', t.classList.contains('on')); return; }
          capture(m);
          if (t.matches('[data-sadd]')) draft.subjects.push({ kind: 'role', value: '' }); else draft.subjects.splice(+t.dataset.sdel, 1);
          m.querySelector('[data-pbody]').innerHTML = body();
        });
        m.querySelector('[data-psave]').addEventListener('click', async () => {
          capture(m);
          const name = draft.name.trim(); if (!name) { ctx.toast('A policy needs a name.', 'warn'); return; }
          const subjects = draft.subjects.map((s) => (s.kind === 'everyone' ? { kind: 'everyone' } : { kind: s.kind, value: s.value })); if (!subjects.length || subjects.some((s) => s.kind !== 'everyone' && !s.value)) { ctx.toast('Every subject other than everyone needs a value.', 'warn'); return; }
          const v = draft.rowValue;
          if (v.startsWith('$user.') && !PLACEHOLDER_RE.test(v)) { ctx.toast('Unknown placeholder ' + esc(v) + '. Use $user.id, $user.username, $user.clearance, $user.roles, $user.groups, $user.workspaces or $user.attributes.<name>.', 'danger', 6000); return; }
          if (LIST_PLACEHOLDERS.includes(v) && draft.rowOp !== 'in') { ctx.toast(esc(v) + ' is a list: compare it with in.', 'danger'); return; }
          const ent = entOf(draft.entity); const f = ent && draft.rowField ? fieldByName(ent, draft.rowField) : null;
          const typed = (x) => (f && f.type === 'number' && x !== '' && !isNaN(Number(x)) ? Number(x) : f && f.type === 'boolean' ? x === 'true' : x);
          const rows = draft.rowField ? { field: draft.rowField, op: draft.rowOp, value: draft.rowOp === 'in' ? (v.startsWith('$user.') ? [v] : v.split(',').map((x) => typed(x.trim())).filter((x) => x !== '')) : typed(v) } : null;
          const fields = {}; Object.keys(draft.fields).forEach((k) => { const g = draft.fields[k]; if (!(g.read && g.unmasked && g.create && g.update)) fields[k] = { read: !!g.read, unmasked: !!g.unmasked, create: !!g.create, update: !!g.update, mask: g.mask || 'hidden' }; });
          const payload = { name, description: draft.description.trim() || null, enabled: draft.enabled, entity: draft.entity || null, subjects, rows, fields, otherFields: p.otherFields || { read: true, unmasked: true, create: true, update: true } };
          try {
            if (existing) await App.put(A(app.id) + '/policies/' + enc(existing.id), payload); else await App.post(A(app.id) + '/policies', payload);
            st.polKey = null; st.polProblem = null; App.closeOverlay(); ctx.rerender(); ctx.toast('Policy ' + esc(name) + (existing ? ' saved' : ' created') + '. Audited app.policy.' + (existing ? 'updated' : 'created') + '.', 'ok');
          } catch (err) { st.polProblem = { title: existing ? 'Policy not saved' : 'Policy not created', text: detailOf(err), trace: traceOf(err) }; App.closeOverlay(); ctx.rerender(); }
        });
      }
    });
  }

  // ---------- deployments: packages, environments, promotion, history (1.6.0, B-8201 to B-8204) ----------

  const STAGES = ['development', 'test', 'production'];
  const DEPLOY_STATES = { 'awaiting-approval': 'warn', queued: '', running: 'info', succeeded: 'ok', failed: 'danger', rejected: 'danger' };
  const stageLabel = (x) => x === 'development' ? 'Development' : x === 'test' ? 'Test' : x === 'production' ? 'Production' : String(x || '');
  const whenAt = (t) => t ? new Date(t).toLocaleString() : '';
  const reportLine = (r) => !r ? '' : ['entities ' + (r.entities.created.length + r.entities.updated.length + r.entities.removed.length) + ' changed' + (r.entities.kept.length ? ', ' + r.entities.kept.length + ' kept (records)' : ''), 'forms ' + (r.forms.created.length + r.forms.updated.length + r.forms.removed.length) + ' changed', r.triggers ? 'triggers ' + r.triggers.created + (r.triggers.skipped.length ? ' (' + r.triggers.skipped.length + ' skipped)' : '') : null, r.policies ? 'policies ' + r.policies.created : null, r.records && r.records.created ? 'records ' + r.records.created : null].filter(Boolean).join(' · ');
  const bytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  const shortHash = (h) => h ? h.slice(0, 4) + '…' + h.slice(-4) : '';

  function loadDeployments(ctx, app) {
    const st = ctx.state; const key = app.id;
    st.depBusy = key;
    Promise.all([App.get(A(app.id) + '/packages'), App.get('/api/apps/pipelines')])
      .then(async ([pk, pl]) => {
        const pipeline = (pl.pipelines || []).find((x) => STAGES.some((sg) => x.stages[sg] && x.stages[sg].id === app.id)) || null;
        const history = pipeline ? (await App.get('/api/apps/pipelines/' + enc(pipeline.id) + '/deployments')).deployments : [];
        st.dep = { packages: pk.packages || [], stage: pk.stage, pipeline, history, pipelines: pl.pipelines || [] }; st.depKey = key; st.depError = null;
      })
      .catch((err) => { st.depError = err; st.depKey = key; })
      .finally(() => { st.depBusy = null; if (App.state.route === 'apps' && !overlayOpen()) ctx.rerender(); else st.dirty = true; });
  }

  function renderDeployments(ctx, app) {
    const st = ctx.state;
    const key = app.id;
    if (st.depKey !== key && st.depBusy !== key) loadDeployments(ctx, app);
    if (st.depKey !== key) return UI.notice('Loading packages and deployments…', 'info');
    if (st.depError) return UI.problem('Deployments could not be loaded', detailOf(st.depError), traceOf(st.depError)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-depreload' }) + '</div>';
    const d = st.dep;
    const pipeline = d.pipeline;
    const reload = () => { st.depKey = null; ctx.rerender(); };
    const fail = (err, title) => { st.depProblem = { title: (err.problem && err.problem.title) || title, text: detailOf(err), trace: traceOf(err) }; ctx.rerender(); };
    const active = pipeline && pipeline.activeDeployment ? d.history.find((h) => h.id === pipeline.activeDeployment) : null;
    if (active && !st.depPoll) { st.depPoll = setTimeout(() => { st.depPoll = null; if (App.state.route === 'apps' && st.tab === 'deployments' && !overlayOpen()) reload(); }, 3000); }

    const problem = (st.depProblem ? UI.problem(st.depProblem.title, st.depProblem.text, st.depProblem.trace) : '') + (st.depNote ? UI.notice(esc(st.depNote.text), st.depNote.kind === 'ok' ? 'ok' : 'warn') : '');

    // ----- environments -----
    const stageCard = (name) => { const sg = pipeline.stages[name]; const last = name === 'test' ? pipeline.last.test : name === 'production' ? pipeline.last.production : null; return '<div class="panel apps-stage" data-stage="' + name + '"><div class="eyebrow">' + stageLabel(name) + '</div><div><b>' + esc(sg.title || sg.name) + '</b>' + (sg.id === app.id ? ' ' + UI.pill('this app', 'accent') : '') + '</div><div class="muted" style="font-size:12px">' + esc(sg.scope === 'tenant' ? 'Tenant-wide' : wsName(sg.workspaceId)) + '</div><div style="margin-top:6px">' + (name === 'development' ? UI.pill((d.stage && d.stage.stage === 'development' ? d.packages.length : 0) + ' packages', '') : last ? UI.pill('v' + last.version, name === 'production' ? 'ok' : 'accent') + ' <span class="muted" style="font-size:12px">' + esc(whenAt(last.finishedAt)) + '</span>' : UI.pill('nothing deployed', '')) + '</div></div>'; };
    const env = !pipeline
      ? UI.panel('Environments', UI.empty('No pipeline', 'A pipeline gives this app three stages, each an app of its own (usually in three workspaces): development, test and production. A package moves stage to stage, never skipping one, and production waits for the Workflows approval step.') + '<div class="hstack gap6 wrap">' + UI.btn('Create a pipeline', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-pl-new' }) + '</div>')
      : UI.panel('Environments: ' + esc(pipeline.name), '<div class="apps-stages">' + stageCard('development') + '<div class="apps-arrow" aria-hidden="true">→</div>' + stageCard('test') + '<div class="apps-arrow" aria-hidden="true">→</div>' + stageCard('production') + '</div>'
        + UI.kv([['Approval before production', pipeline.approvalWorkflow ? esc(pipeline.approvalWorkflow.name) + ' <span class="muted">(its run starts with the deployment as input; the approver decides it on Workflows)</span>' : '<span class="muted">none: a promotion to production is refused until a workflow with an approval step is named</span>'], ['Backups', 'before every deployment, kept as packages of the target']])
        + (active ? UI.notice('Deployment ' + esc(active.id.slice(-6)) + ' to ' + esc(active.to) + ' is ' + esc(active.state) + (active.state === 'awaiting-approval' ? ': waiting for an approver on Workflows. Nothing else moves until it is decided.' : '. This page refreshes until it ends.'), 'warn') : '')
        + '<div class="hstack gap6 wrap">' + UI.btn('Promote development → test', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-promote="test"' + (active ? ' disabled' : '') }) + UI.btn('Promote test → production', { size: 'sm', icon: 'play', attrs: 'data-promote="production"' + (active ? ' disabled' : '') }) + UI.btn('Edit pipeline', { size: 'sm', attrs: 'data-pl-edit' }) + UI.btn('Delete pipeline', { size: 'sm', kind: 'danger', attrs: 'data-pl-del' }) + '</div>');

    // ----- packages -----
    const pkgRows = d.packages.map((p) => ({ cells: ['<b>v' + p.version + '</b>', UI.pill(p.source, p.source === 'backup' ? '' : p.source === 'promotion' ? 'accent' : p.source === 'git' ? 'info' : 'outline'), '<span class="mono" title="' + esc(p.hash) + '">' + esc(shortHash(p.hash)) + '</span>', p.withData ? 'design and records' : 'design only', esc(bytes(p.size)), p.note ? esc(p.note) : '<span class="muted">none</span>', esc(whenAt(p.createdAt)), '<div class="hstack gap6 right">' + UI.btn('Download', { size: 'sm', attrs: 'data-pkg-dl="' + esc(p.id) + '"' }) + UI.btn('Push to git', { size: 'sm', icon: 'upload', attrs: 'data-pkg-git="' + esc(p.id) + '"' }) + '</div>'], attrs: 'data-pkg="' + esc(p.id) + '"' }));
    const packages = UI.panel('Packages', UI.notice('A package is the whole design (entities, fields, formulas, forms, state machines, triggers, the workflows they name, policies), versioned per app and signed with the KMS key; records only when asked. Every promotion, every backup taken before a deployment and every import from git is a package here. Import verifies the signature over exactly what arrived, before anything is read.', 'info')
      + UI.table(['Version', 'Source', 'Hash', 'Contents', 'Size', 'Note', 'Made', { label: '', right: true }], pkgRows, { clickable: false, minWidth: '1040px', emptyTitle: 'No packages yet', emptyText: 'Make a package to version this design, or promote it through a pipeline.' })
      + '<div class="hstack gap6 wrap">' + UI.btn('Make a package', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-pkg-new' }) + UI.btn('Import a package', { size: 'sm', icon: 'upload', attrs: 'data-pkg-import' }) + UI.btn('Import from git', { size: 'sm', icon: 'download', attrs: 'data-pkg-gitimport' }) + '</div>');

    // ----- history -----
    const histRows = d.history.map((h) => ({ cells: ['<span class="mono">' + esc(h.id.slice(-6)) + '</span>', h.kind === 'rollback' ? UI.pill('rollback', 'warn') + (h.rollbackOf ? ' of ' + esc(h.rollbackOf.slice(-6)) : '') : esc(stageLabel(h.from)) + ' → ' + esc(stageLabel(h.to)), 'v' + h.version, UI.pill(h.state, DEPLOY_STATES[h.state] || '') + (h.error ? '<div class="muted" style="font-size:12px;max-width:360px">' + esc(h.error) + '</div>' : ''), esc(h.createdByName || h.createdBy || ''), esc(whenAt(h.finishedAt || h.createdAt)), h.report ? '<span style="font-size:12px">' + esc(reportLine(h.report)) + '</span>' : '<span class="muted">—</span>', '<div class="hstack gap6 right">' + (h.state === 'succeeded' && h.backupPackageId && !active ? UI.btn('Roll back', { size: 'sm', attrs: 'data-rollback="' + esc(h.id) + '"' }) : '') + '</div>'], attrs: 'data-dep="' + esc(h.id) + '"' }));
    const history = UI.panel('Deployment history', UI.table(['Deployment', 'Stages', 'Version', 'State', 'Who', 'When', 'Report', { label: '', right: true }], histRows, { clickable: false, minWidth: '1100px', emptyTitle: 'No deployments', emptyText: 'Promotions and rollbacks appear here with their package, their backup and what they changed. Audited app.package.promoted, app.package.rolled_back and app.package.deployment.failed.' }));

    ctx.on('click', '[data-depreload]', reload);
    ctx.on('click', '[data-pkg-new]', () => modal(ctx, { title: 'Make a package of ' + esc(app.title || app.name), body: UI.notice('The design is read now and signed with the KMS key; the package is kept sealed with the tenant key and numbered v' + (d.packages.length ? d.packages[0].version + 1 : 1) + '.', 'info') + '<div class="formgrid">' + UI.field('Contents', UI.select([{ value: 'design', label: 'Design only' }, { value: 'data', label: 'Design and records' }], 'design', 'data-pk-data')) + UI.field('Note', UI.input('', { placeholder: 'what changed', attrs: 'data-pk-note' })) + '</div><div data-pk-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Make the package', { kind: 'primary', attrs: 'data-pk-ok' }), onMount(m) { m.querySelector('[data-pk-ok]').addEventListener('click', async () => { const errEl = m.querySelector('[data-pk-err]'); errEl.innerHTML = ''; try { const out = await App.post(A(app.id) + '/packages', { withData: m.querySelector('[data-pk-data]').value === 'data', note: m.querySelector('[data-pk-note]').value.trim() || null }); App.closeOverlay(); st.depNote = null; st.depProblem = null; ctx.toast('Package v' + out.version + ' made and signed. Audit event app.package.created written.', 'ok'); reload(); } catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); } }); } }));
    ctx.on('click', '[data-pkg-dl]', async (e, t) => { try { const out = await App.get(A(app.id) + '/packages/' + enc(t.dataset.pkgDl)); const text = JSON.stringify(out.package, null, 2); const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = app.name + '-v' + out.version + '.app.json'; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (err) { App.fail(err, 'Could not download the package'); } });
    ctx.on('click', '[data-pkg-git]', (e, t) => { const p = d.packages.find((x) => x.id === t.dataset.pkgGit); modal(ctx, { title: 'Push v' + p.version + ' to a repository', cls: 'wide', body: UI.notice('One file per object (package.json with the signature, app.json, entities/, forms/, triggers/, policies/, workflows/, records/), pretty-printed with sorted keys so the diff reads as the design change. A token only as a vault reference, answered to git through a credential helper, never on the command line.', 'info') + '<div class="formgrid">' + UI.field('Repository (https)', UI.input(st.gitUrl || '', { placeholder: 'https://git.example.com/team/apps.git', attrs: 'data-g-url' })) + UI.field('Branch', UI.input(st.gitRef || 'main', { attrs: 'data-g-ref' })) + UI.field('Path', UI.input('apps/' + app.name, { attrs: 'data-g-path' })) + UI.field('Credential (vault reference, optional)', UI.input('', { placeholder: 'vault:team/git#token', attrs: 'data-g-cred' })) + '<div class="span2">' + UI.field('Commit message', UI.input(app.name + ' v' + p.version, { attrs: 'data-g-msg' })) + '</div></div><div data-g-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Push', { kind: 'primary', attrs: 'data-g-ok' }), onMount(m) { m.querySelector('[data-g-ok]').addEventListener('click', async () => { const errEl = m.querySelector('[data-g-err]'); errEl.innerHTML = ''; const body = { url: m.querySelector('[data-g-url]').value.trim(), ref: m.querySelector('[data-g-ref]').value.trim() || null, path: m.querySelector('[data-g-path]').value.trim(), message: m.querySelector('[data-g-msg]').value.trim() || null, credential: m.querySelector('[data-g-cred]').value.trim() || null }; try { st.gitUrl = body.url; st.gitRef = body.ref; const out = await App.post(A(app.id) + '/packages/' + enc(p.id) + '/git', body); App.closeOverlay(); ctx.toast('Pushed v' + p.version + ' as ' + out.files + ' files, commit ' + out.commit.slice(0, 7) + '. Audit event app.package.pushed written.', 'ok', 5000); } catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); } }); } }); });
    ctx.on('click', '[data-pkg-import]', () => { const scopes = ((App.me && App.me.workspaces) || []).map((w) => ({ value: w.id, label: w.name })).concat([{ value: '', label: 'Tenant-wide' }]); modal(ctx, { title: 'Import a package', cls: 'wide', body: UI.notice('The signature is verified over exactly what arrived before anything is read. A package changed after signing, signed elsewhere or naming another key is refused (422) and audited app.import.refused.', 'info') + UI.field('Package (exprsn-app/2 JSON)', UI.textarea('', { rows: 6, placeholder: '{"format":"exprsn-app/2", …}', attrs: 'data-pi-json spellcheck="false"' })) + '<div class="formgrid">' + UI.field('Name (optional)', UI.input('', { placeholder: 'defaults to the package\'s name', attrs: 'data-pi-name' })) + UI.field('Workspace', UI.select(scopes, (App.me && App.me.workspace) || '', 'data-pi-ws')) + '</div><div data-pi-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Verify and import', { kind: 'primary', attrs: 'data-pi-ok' }), onMount(m) { m.querySelector('[data-pi-ok]').addEventListener('click', async () => { const errEl = m.querySelector('[data-pi-err]'); errEl.innerHTML = ''; let pkg; try { pkg = JSON.parse(m.querySelector('[data-pi-json]').value); } catch (x) { errEl.innerHTML = UI.notice('The package is not JSON.', 'danger'); return; } const body = { package: pkg, workspaceId: m.querySelector('[data-pi-ws]').value || null }; const name = m.querySelector('[data-pi-name]').value.trim(); if (name) body.name = name; try { const out = await App.post('/api/apps/packages/import', body); st.app = out.id; st.tab = 'entities'; st.depProblem = null; afterChange(ctx, { apps: true }); ctx.toast('Signature verified. App ' + esc(out.name) + ' created from the package: ' + esc(reportLine(out.report)) + '. Audited app.imported.', 'ok', 6000); } catch (err) { if (err.status === 422) { App.closeOverlay(); fail(err, 'Package refused'); return; } errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); } }); } }); });
    ctx.on('click', '[data-pkg-gitimport]', () => { const scopes = ((App.me && App.me.workspaces) || []).map((w) => ({ value: w.id, label: w.name })).concat([{ value: '', label: 'Tenant-wide' }]); modal(ctx, { title: 'Import a package from a repository', cls: 'wide', body: UI.notice('The files under the path are reassembled into the package and verified like one pasted in: the signature in package.json must cover them.', 'info') + '<div class="formgrid">' + UI.field('Repository (https)', UI.input(st.gitUrl || '', { placeholder: 'https://git.example.com/team/apps.git', attrs: 'data-gi-url' })) + UI.field('Branch', UI.input(st.gitRef || 'main', { attrs: 'data-gi-ref' })) + UI.field('Path', UI.input('apps/' + app.name, { attrs: 'data-gi-path' })) + UI.field('Credential (vault reference, optional)', UI.input('', { placeholder: 'vault:team/git#token', attrs: 'data-gi-cred' })) + UI.field('Name (optional)', UI.input('', { placeholder: 'defaults to the package\'s name', attrs: 'data-gi-name' })) + UI.field('Workspace', UI.select(scopes, (App.me && App.me.workspace) || '', 'data-gi-ws')) + '</div><div data-gi-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Read and import', { kind: 'primary', attrs: 'data-gi-ok' }), onMount(m) { m.querySelector('[data-gi-ok]').addEventListener('click', async () => { const errEl = m.querySelector('[data-gi-err]'); errEl.innerHTML = ''; const body = { url: m.querySelector('[data-gi-url]').value.trim(), ref: m.querySelector('[data-gi-ref]').value.trim() || null, path: m.querySelector('[data-gi-path]').value.trim(), credential: m.querySelector('[data-gi-cred]').value.trim() || null, workspaceId: m.querySelector('[data-gi-ws]').value || null }; const name = m.querySelector('[data-gi-name]').value.trim(); if (name) body.name = name; try { st.gitUrl = body.url; st.gitRef = body.ref; const out = await App.post('/api/apps/packages/git-import', body); st.app = out.id; st.tab = 'entities'; st.depProblem = null; afterChange(ctx, { apps: true }); ctx.toast('Package read from ' + esc(out.commit.slice(0, 7)) + ' and verified. App ' + esc(out.name) + ' created. Audited app.imported.', 'ok', 6000); } catch (err) { if (err.status === 422) { App.closeOverlay(); fail(err, 'Package refused'); return; } errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); } }); } }); });
    ctx.on('click', '[data-pl-new], [data-pl-edit]', () => { const apps = (st.apps || []).map((a) => ({ value: a.name, label: a.title + ' (' + a.name + ')' })); const cur = pipeline || null; const sel = (stage, dflt) => UI.select(apps, cur ? cur.stages[stage].name : dflt, 'data-p-' + stage); modal(ctx, { title: cur ? 'Edit pipeline' : 'Create a pipeline', cls: 'wide', body: UI.notice('Three different apps you may design, one per stage, usually in three workspaces. A promotion to production needs a published workflow with an approval step; name it by its name.', 'info') + '<div class="formgrid">' + UI.field('Name', UI.input(cur ? cur.name : (app.title || app.name), { attrs: 'data-p-name' })) + UI.field('Approval workflow (name, optional)', UI.input(cur && cur.approvalWorkflow ? cur.approvalWorkflow.name : '', { placeholder: 'a published workflow with an approval step', attrs: 'data-p-wf' })) + UI.field('Development', sel('development', app.name)) + UI.field('Test', sel('test', app.name)) + UI.field('Production', sel('production', app.name)) + '</div><div data-p-err></div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(cur ? 'Save' : 'Create pipeline', { kind: 'primary', attrs: 'data-p-ok' }), onMount(m) { m.querySelector('[data-p-ok]').addEventListener('click', async () => { const errEl = m.querySelector('[data-p-err]'); errEl.innerHTML = ''; const body = { name: m.querySelector('[data-p-name]').value.trim(), development: m.querySelector('[data-p-development]').value, test: m.querySelector('[data-p-test]').value, production: m.querySelector('[data-p-production]').value, approvalWorkflow: m.querySelector('[data-p-wf]').value.trim() || null }; try { if (cur) await App.patch('/api/apps/pipelines/' + enc(cur.id), body); else await App.post('/api/apps/pipelines', body); App.closeOverlay(); st.depProblem = null; ctx.toast('Pipeline ' + esc(body.name) + (cur ? ' saved' : ' created') + '. Audit event app.pipeline.' + (cur ? 'updated' : 'created') + ' written.', 'ok'); reload(); } catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); } }); } }); });
    ctx.on('click', '[data-pl-del]', async () => { const ok = await ctx.confirm({ title: 'Delete the pipeline ' + esc(pipeline.name), tone: 'danger', body: '<p>The pipeline and its deployment history are deleted; the three apps and their packages stay.</p>', ok: 'Delete' }); if (!ok) return; try { await App.del('/api/apps/pipelines/' + enc(pipeline.id)); ctx.toast('Pipeline deleted. Audit event app.pipeline.deleted written.', 'ok'); reload(); } catch (err) { fail(err, 'Could not delete the pipeline'); } });
    ctx.on('click', '[data-promote]', async (e, t) => {
      const to = t.dataset.promote;
      const tested = pipeline.last.test;
      const body = to === 'test' ? '<p>The development app <b>' + esc(pipeline.stages.development.name) + '</b> is packaged now and deployed onto <b>' + esc(pipeline.stages.test.name) + '</b>. The test app is backed up first.</p>' : tested ? '<p>The package that passed test, <b>v' + tested.version + '</b>, is deployed onto <b>' + esc(pipeline.stages.production.name) + '</b> once ' + (pipeline.approvalWorkflow ? esc(pipeline.approvalWorkflow.name) + ' approves it' : 'an approval workflow approves it') + '. The production app is backed up first.</p>' : '<p>Nothing has passed test yet; the server will refuse this (a stage cannot be skipped).</p>';
      const ok = await ctx.confirm({ title: 'Promote to ' + stageLabel(to), body, ok: 'Promote' });
      if (!ok) return;
      try { const out = await App.post('/api/apps/pipelines/' + enc(pipeline.id) + '/promote', { to }); st.depProblem = null; st.depNote = null; ctx.toast(out.state === 'awaiting-approval' ? 'Deployment to production waits for an approver on Workflows. Audit event app.package.promotion.requested written.' : 'Deployment to ' + to + ' queued (v' + out.version + '). Audit event app.package.promotion.requested written.', 'ok', 5000); reload(); } catch (err) { fail(err, 'Promotion refused'); }
    });
    ctx.on('click', '[data-rollback]', async (e, t) => {
      const h = d.history.find((x) => x.id === t.dataset.rollback);
      const target = pipeline.stages[h.to];
      const ok = await ctx.confirm({ title: 'Roll back deployment ' + esc(h.id.slice(-6)), tone: 'danger', body: '<p>The backup taken before this deployment is deployed onto <b>' + esc(target ? target.name : h.to) + '</b> as a deployment of its own, with its own backup. Entities that still hold records are kept and reported; forms, triggers and policies return to the backup\'s.</p>', ok: 'Roll back' });
      if (!ok) return;
      try { await App.post('/api/apps/deployments/' + enc(h.id) + '/rollback', {}); st.depProblem = null; st.depNote = null; ctx.toast('Rollback queued. Audit event app.package.rollback.requested written.', 'ok'); reload(); } catch (err) { fail(err, 'Rollback refused'); }
    });

    return '<style>#main .apps-stages{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:10px;align-items:stretch;margin-bottom:10px}#main .apps-stage{padding:10px 12px}#main .apps-arrow{align-self:center;color:var(--muted);font-size:18px}@media (max-width:640px){#main .apps-stages{grid-template-columns:1fr}#main .apps-arrow{display:none}}</style>'
      + problem + env + packages + history;
  }

  // ---------- API tab (1.6.0, B-8601 to B-8603) ----------
  const KIND_TONE = { 'entity.created': 'ok', 'entity.deleted': 'danger', 'field.removed': 'warn', 'form.deleted': 'warn' };
  const SOURCE_TONE = { 'schema-api': 'accent', package: 'outline' };
  function renderApi(ctx, app) {
    const st = ctx.state;
    const key = app.id;
    if (st.schemaKey !== key && st.schemaBusy !== key) {
      st.schemaBusy = key;
      Promise.all([App.get(A(app.id) + '/schema'), App.get(A(app.id) + '/schema/versions?limit=50')])
        .then(([schema, versions]) => { st.schema = schema; st.schemaVersions = versions.versions; st.schemaKey = key; st.schemaError = null; })
        .catch((err) => { st.schemaError = err; st.schemaKey = key; })
        .finally(() => { st.schemaBusy = null; if (App.state.route === 'apps' && !overlayOpen()) ctx.rerender(); else st.dirty = true; });
    }
    if (st.schemaKey !== key) return UI.notice('Loading the schema…', 'info');
    if (st.schemaError) return UI.problem('The schema could not be loaded', detailOf(st.schemaError), traceOf(st.schemaError)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-schemareload' }) + '</div>';
    const sc = st.schema;
    const base = A(app.name);
    const first = app.entities[0] || null;
    const firstIndexed = first ? fieldsOf(first).find((f) => f.indexed || f.unique) : null;
    const curl = 'curl -H "Authorization: Bearer exai_k1_…" \\\n  "' + location.origin + base + '/' + (first ? first.name : 'entity') + '?where=' + (firstIndexed ? firstIndexed.name : 'field') + ':eq:value&sort=updatedAt:desc&limit=50&include=related"';
    const endpoints = UI.panel('Entity API', UI.notice('Every entity of the app is a REST resource under <span class="mono">' + esc(base) + '/&lt;entity&gt;</span>: list with <span class="mono">filter</span> (JSON), <span class="mono">where=field:op:value</span>, <span class="mono">sort</span>, <span class="mono">limit</span>, <span class="mono">offset</span> or <span class="mono">cursor</span>, <span class="mono">q</span> and <span class="mono">include=related</span>; read, create, update (with <span class="mono">version</span>), transition and delete. The caller\'s policies, masks, labels and workspaces apply as on this screen. A key may be limited to this app or one entity (Settings, API keys).', 'info')
      + UI.table(['Method', 'Path', 'Needs', 'What it does'], app.entities.flatMap((e) => [
        [UI.pill('GET', 'outline'), '<span class="mono">' + esc(base + '/' + e.name) + '</span>', '<span class="mono">records:read</span>', 'A page of ' + esc(e.title || e.name) + ' records: total, nextCursor, records'],
        [UI.pill('POST', 'accent'), '<span class="mono">' + esc(base + '/' + e.name) + '</span>', '<span class="mono">records:write</span>', 'Create one: {values, label?}'],
        [UI.pill('GET', 'outline'), '<span class="mono">' + esc(base + '/' + e.name + '/{id}') + '</span>', '<span class="mono">records:read</span>', 'One record; related records with include=related'],
        [UI.pill('PATCH', 'accent'), '<span class="mono">' + esc(base + '/' + e.name + '/{id}') + '</span>', '<span class="mono">records:write</span>', 'Update: {values, version?}; 409 on a stale version'],
        [UI.pill('DELETE', 'danger'), '<span class="mono">' + esc(base + '/' + e.name + '/{id}') + '</span>', '<span class="mono">records:write</span>', 'Delete; 204']
      ].concat(smOf(e) ? [[UI.pill('POST', 'accent'), '<span class="mono">' + esc(base + '/' + e.name + '/{id}/transition') + '</span>', '<span class="mono">records:write</span>', 'Move to a state: {to, version?, note?}; ' + esc(smOf(e).states.map((x) => x.name).join(', '))]] : [])), { clickable: false, minWidth: '720px', cls: 'bare', emptyTitle: 'No entities yet', emptyText: 'Design an entity first; each one becomes a resource.' })
      + (first ? '<div class="eyebrow" style="margin-top:10px">Try it</div>' + UI.code(curl, 'sh') : ''));
    const docs = UI.panel('OpenAPI and client', UI.kv([
      ['Schema version', '<b>' + esc(String(sc.version)) + '</b>' + (sc.changedAt ? ' <span class="muted">changed ' + esc(when(sc.changedAt)) + '</span>' : ' <span class="muted">no change recorded yet</span>')],
      ['Hash', '<span class="mono" style="overflow-wrap:anywhere">' + esc(sc.hash) + '</span> <span class="muted">(the ETag of the document and the client)</span>'],
      ['OpenAPI 3.1', '<a href="' + esc(base + '/openapi.json') + '" class="mono" download="' + esc(app.name) + '-openapi.json">' + esc(base + '/openapi.json') + '</a> <span class="muted">typed from the entity definitions, current on every read</span>'],
      ['Client', '<a href="' + esc(base + '/client.ts') + '" class="mono" download="' + esc(app.name) + '-client.ts">' + esc(base + '/client.ts') + '</a> <span class="muted">or</span> <a href="' + esc(base + '/client.js') + '" class="mono" download="' + esc(app.name) + '-client.js">' + esc(base + '/client.js') + '</a> <span class="muted">createClient({baseUrl, token}).' + esc(first ? first.name : 'entity') + '.list() / get / create / update / delete / transition</span>']
    ], 1) + '<div class="hstack gap6 wrap" style="margin-top:8px">' + UI.btn('Download openapi.json', { size: 'sm', icon: 'download', attrs: 'data-dl="' + esc(base + '/openapi.json') + '" data-dlname="' + esc(app.name) + '-openapi.json"' }) + UI.btn('Download client.ts', { size: 'sm', icon: 'download', attrs: 'data-dl="' + esc(base + '/client.ts') + '" data-dlname="' + esc(app.name) + '-client.ts"' }) + (App.canOpen('settings') ? UI.btn('Make a key for this app', { size: 'sm', kind: 'ghost', icon: 'key', attrs: 'data-appkey' }) : '') + '</div>');
    const versions = UI.panel('Schema versions', UI.notice('Every design change, whichever route made it (this screen, the schema API, a package import), is one version with a hash of the whole design afterwards; each is audited app.schema.versioned.', 'info')
      + UI.table(['Version', 'Change', 'Target', 'What changed', 'Source', 'By', 'When'], (st.schemaVersions || []).map((v) => [ '<b>' + esc(String(v.version)) + '</b>', UI.pill(v.kind, KIND_TONE[v.kind] || 'info'), '<span class="mono">' + esc(v.target) + '</span>', esc(v.summary), UI.pill(v.source, SOURCE_TONE[v.source] || ''), esc(who(v.createdBy)), esc(when(v.createdAt)) ]), { clickable: false, minWidth: '900px', emptyTitle: 'No versions yet', emptyText: 'The first entity records version 1.' })
      + '<div class="eyebrow" style="margin-top:10px">Schema API</div><div class="muted" style="font-size:12px">' + UI.pill('apps:design', 'outline') + ' <span class="mono">GET ' + esc(base) + '/schema</span>, <span class="mono">PUT …/schema/entities/{entity}</span>, <span class="mono">POST …/schema/entities/{entity}/fields</span>, <span class="mono">PATCH|DELETE …/fields/{field}</span>, <span class="mono">PUT …/entities/{entity}/states</span>, <span class="mono">PUT|DELETE …/schema/forms/{form}</span>, <span class="mono">GET …/schema/versions</span>.</div>');
    ctx.on('click', '[data-schemareload]', () => { st.schemaKey = st.schemaBusy = null; st.schemaError = null; ctx.rerender(); });
    ctx.on('click', '[data-dl]', async (e, t) => {
      try {
        const res = await fetch(t.dataset.dl, { credentials: 'same-origin', headers: { accept: 'application/json, text/plain, application/typescript' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = t.dataset.dlname; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
        ctx.toast(esc(t.dataset.dlname) + ' downloaded (schema version ' + esc(String(sc.version)) + ').', 'ok');
      } catch (err) { App.fail(err, 'Could not download'); }
    });
    ctx.on('click', '[data-appkey]', () => ctx.navigate('settings', { section: 'keys', app: app.name }));
    return endpoints + docs + versions;
  }

  // ---------- Embed tab (1.6.0, B-8701, B-8702) ----------
  const ALGS = ['ES256', 'RS256', 'EdDSA', 'HS256', 'x5c'];
  const algText = (a) => (a === 'x5c' ? 'tenant CA certificate' : a === 'HS256' ? 'HS256 shared secret' : a + ' public key');
  const HOST_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
  function renderEmbed(ctx, app) {
    const st = ctx.state;
    const key = app.id;
    if (st.embedKey !== key && st.embedBusy !== key) {
      st.embedBusy = key;
      App.get(A(app.id) + '/embed')
        .then((d) => { st.embed = d; st.embedKey = key; st.embedError = null; })
        .catch((err) => { st.embedError = err; st.embedKey = key; })
        .finally(() => { st.embedBusy = null; if (App.state.route === 'apps' && !overlayOpen()) ctx.rerender(); else st.dirty = true; });
    }
    if (st.embedKey !== key) return UI.notice('Loading the embed settings…', 'info');
    if (st.embedError) return UI.problem('The embed settings could not be loaded', detailOf(st.embedError), traceOf(st.embedError)) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-emreload' }) + '</div>';
    const em = st.embed;
    const reloadEmbed = () => { st.embedKey = st.embedBusy = null; ctx.rerender(); };
    const secret = st.embedSecret && st.embedSecret.app === key ? UI.notice('<b>Secret for key ' + esc(st.embedSecret.kid) + '. Copy it now; it is shown once.</b><div class="mono apps-token" style="margin-top:4px">' + esc(st.embedSecret.secret) + '</div><div class="muted" style="font-size:12px;margin-top:4px">The host site signs HS256 tokens with it (base64url, 32 bytes). It is sealed with the tenant key here and never shown again; make a new key to rotate it.</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-emsecretcopy' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-emsecretdone' })) : '';
    const problem = st.embedProblem ? UI.problem(st.embedProblem.title, st.embedProblem.text, st.embedProblem.trace) : '';
    const settings = UI.panel('Embed settings', '<div class="formgrid">'
      + UI.field('Allowed host sites', UI.textarea(em.allowedHosts.join('\n'), { rows: 2, attrs: 'data-emhosts aria-label="Allowed host sites" spellcheck="false"' }), 'One origin a line (https://host[:port]); they become the frame-ancestors of every embed page of this app.')
      + UI.field('Public pages', UI.toggle(em.publicEnabled ? 'on' : 'off', em.publicEnabled, 'data-empublic aria-label="Public pages"'), 'Public forms of this app can be published as embed pages.')
      + UI.field('Signed embeds', UI.toggle(em.signedEnabled ? 'on' : 'off', em.signedEnabled, 'data-emsigned aria-label="Signed embeds"'), 'The host site signs a short token per visitor with a key below.')
      + UI.field('Claim that names the person', '<div class="hstack gap6">' + UI.input(em.claimName, { attrs: 'data-emclaim aria-label="Claim name" maxlength="60"' }) + UI.select([{ value: 'username', label: 'is the username' }, { value: 'email', label: 'is the email' }, { value: 'id', label: 'is the user id' }], em.claimMatch, 'data-emmatch aria-label="Claim match"') + '</div>', 'An existing, active user of this tenant; the session acts as them.')
      + UI.field('Longest session', UI.select([{ value: '300', label: '5 minutes' }, { value: '900', label: '15 minutes' }, { value: '3600', label: '1 hour' }, { value: '86400', label: '1 day' }], String(em.maxTtlSeconds), 'data-emttl aria-label="Longest session"'), 'The shorter of this, the token\'s exp and APP_EMBED_MAX_TTL_SECONDS.')
      + UI.field('Writes', UI.toggle(em.write ? 'allowed' : 'read-only', em.write, 'data-emwrite aria-label="Writes"'), 'Embedded sessions hold records:read, and records:write only when allowed.')
      + UI.field('Entities reached', UI.input(em.entities ? em.entities.join(', ') : '', { placeholder: 'every entity', attrs: 'data-ementities aria-label="Entities reached"' }), 'Names, comma-separated; empty for every entity of the app.')
      + '</div>' + UI.kv([['Audience the token must name', '<span class="mono">' + esc(em.audience) + '</span>'], ['Signed embed page', '<span class="mono" style="overflow-wrap:anywhere">' + esc(em.signedUrl) + '#token=&lt;jwt&gt;</span> <span class="muted">(the token travels in the fragment, never a query string)</span>'], ['frame-ancestors', '<span class="mono">' + esc(em.frameAncestors) + '</span>']], 1)
      + '<div class="hstack gap6" style="margin-top:8px">' + UI.btn('Save settings', { kind: 'primary', size: 'sm', attrs: 'data-emsave' }) + '<span class="muted" style="font-size:12px">Audited app.embed.updated.</span></div>');
    const keys = UI.panel('Signing keys', UI.table(['kid', 'Kind', 'State', 'By', 'Made', { label: '', right: true }], em.keys.map((k) => ({ cells: ['<span class="mono">' + esc(k.kid) + '</span>', esc(algText(k.alg)), k.state === 'active' ? UI.pill('active', 'ok') : UI.pill('revoked ' + when(k.revokedAt), 'danger'), esc(who(k.createdBy)), esc(when(k.createdAt)), '<span class="hstack" style="justify-content:flex-end">' + (k.state === 'active' ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-emrevoke="' + esc(k.id) + '" aria-label="Revoke key ' + esc(k.kid) + '"' }) : '') + '</span>'], attrs: 'data-emkey="' + esc(k.id) + '"' })), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No keys', emptyText: 'Register the public key the host site signs with, a shared secret, or the tenant CA.' })
      + '<div class="hstack gap6 wrap">' + UI.btn('Add key', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-emaddkey' }) + '<span class="muted" style="font-size:12px">Revoking a key ends every session it made.</span></div>');
    const publicForms = (app.forms || []).filter((f) => f.public && !em.pages.some((p) => p.formId === f.id));
    const pages = UI.panel('Public embed pages', UI.notice('A public form (one with a public link) is published as an embed page under a random id; the page opens and submits the form by that id, so the form\'s link token never reaches the host site. Submissions follow the public path: per-address and per-form limits, the user-input guardrail, held values queued for review.', 'info')
      + UI.table(['Form', 'Entity', 'Embed page', 'By', 'Made', { label: '', right: true }], em.pages.map((p) => ({ cells: ['<b>' + esc(p.formTitle) + '</b> <span class="mono muted">' + esc(p.form) + '</span>' + (p.public ? '' : ' ' + UI.pill('form no longer public', 'warn')), '<span class="mono">' + esc(p.entity) + '</span>', '<span class="mono" style="overflow-wrap:anywhere">' + esc(p.url) + '</span>', esc(who(p.createdBy)), esc(when(p.createdAt)), '<span class="hstack gap4" style="justify-content:flex-end">' + UI.btn('Snippet', { size: 'xs', kind: 'ghost', attrs: 'data-emsnippet="' + esc(p.id) + '"' }) + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-emrmpage="' + esc(p.id) + '"' }) + '</span>'], attrs: 'data-empage="' + esc(p.id) + '"' })), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No embed pages', emptyText: (app.forms || []).some((f) => f.public) ? 'Publish one of the public forms as an embed page.' : 'No form of this app has a public link yet; publish one on the Forms tab first.' })
      + '<div class="hstack gap6 wrap">' + UI.btn('Publish a form', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-emaddpage', disabled: !publicForms.length || !em.publicEnabled }) + (!em.publicEnabled ? '<span class="muted" style="font-size:12px">Turn public pages on and save first.</span>' : '') + '</div>');
    const sessions = UI.panel('Embedded sessions', UI.table(['Person', 'Host (iss)', 'Opened', 'Expires', 'State'], em.sessions.map((x) => [esc(x.username || x.user), '<span class="mono">' + esc(x.host || '') + '</span>', esc(when(x.createdAt)), esc(when(x.expiresAt)), x.revokedAt ? UI.pill('revoked', 'danger') : x.expiresAt < Date.now() ? UI.pill('expired', '') : UI.pill('active', 'ok')]), { clickable: false, minWidth: '0', cls: 'bare', emptyTitle: 'No sessions', emptyText: 'Sessions opened by host tokens appear here with the issuer that made them.' })
      + '<div class="hstack gap6">' + UI.btn('End every session', { size: 'sm', kind: 'danger', attrs: 'data-emendall', disabled: !em.sessions.some((x) => !x.revokedAt && x.expiresAt > Date.now()) }) + '<span class="muted" style="font-size:12px">Sessions are apart from console sessions: no cookie, a bearer of their own, the app only.</span></div>');
    const fail = (err, title) => { st.embedProblem = { title, text: detailOf(err), trace: traceOf(err) }; App.closeOverlay(); ctx.rerender(); };
    ctx.on('click', '[data-emreload]', () => { st.embedError = null; reloadEmbed(); });
    ctx.on('click', '[data-emsecretdone]', () => { st.embedSecret = null; ctx.rerender(); });
    ctx.on('click', '[data-emsecretcopy]', () => { const v = st.embedSecret && st.embedSecret.secret; if (!v) return; (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject(new Error('no clipboard'))).then(() => ctx.toast('Secret copied.'), () => ctx.toast('Select the secret and copy it.', 'warn')); });
    ctx.on('click', '[data-emsave]', async () => {
      const root = ctx.root || document;
      const hosts = (root.querySelector('[data-emhosts]').value || '').split(/\n/).map((h) => h.trim()).filter(Boolean);
      const bad = hosts.find((h) => !HOST_RE.test(h));
      if (bad) { ctx.toast('An allowed host is an origin: https://host[:port], not ' + esc(bad) + '.', 'danger'); return; }
      const ents = root.querySelector('[data-ementities]').value.split(',').map((x) => x.trim()).filter(Boolean);
      const body = { allowedHosts: hosts, publicEnabled: root.querySelector('[data-empublic]').classList.contains('on'), signedEnabled: root.querySelector('[data-emsigned]').classList.contains('on'), claimName: root.querySelector('[data-emclaim]').value.trim() || 'sub', claimMatch: root.querySelector('[data-emmatch]').value, maxTtlSeconds: Number(root.querySelector('[data-emttl]').value), write: root.querySelector('[data-emwrite]').classList.contains('on'), entities: ents.length ? ents : null };
      try { await App.put(A(app.id) + '/embed', body); st.embedProblem = null; reloadEmbed(); ctx.toast('Embed settings saved. Audited app.embed.updated.', 'ok'); } catch (err) { fail(err, 'Settings not saved'); }
    });
    ctx.on('click', '[data-emaddkey]', () => modal(ctx, { title: 'Add a signing key', body: '<div class="formgrid">' + UI.field('kid', UI.input('', { placeholder: 'portal-2027', attrs: 'data-kid aria-label="kid" maxlength="100"' }), 'The token\'s header names it.') + UI.field('Kind', UI.select(ALGS.map((a) => ({ value: a, label: algText(a) })), 'ES256', 'data-alg aria-label="Kind"')) + '</div>' + UI.field('Public key (PEM)', UI.textarea('', { rows: 4, placeholder: '-----BEGIN PUBLIC KEY-----', attrs: 'data-pem aria-label="Public key" spellcheck="false"' }), 'For ES256 (P-256), RS256 (2048 bits or more) and EdDSA. An HS256 secret is generated and shown once; a tenant CA key needs nothing: the token carries the certificate the CA issued (x5c).'),
      actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn('Add key', { kind: 'primary', attrs: 'data-go' }),
      onMount(m) { m.querySelector('[data-go]').addEventListener('click', async () => { const kid = m.querySelector('[data-kid]').value.trim(); const alg = m.querySelector('[data-alg]').value; const pem = m.querySelector('[data-pem]').value.trim(); if (!kid) { ctx.toast('A key needs a kid.', 'warn'); return; } if (['ES256', 'RS256', 'EdDSA'].includes(alg) && !pem) { ctx.toast('A ' + alg + ' key needs the public key (PEM).', 'warn'); return; } const body = { kid, alg }; if (pem && alg !== 'HS256' && alg !== 'x5c') body.publicKey = pem; try { const out = await App.post(A(app.id) + '/embed/keys', body); if (out.secret) st.embedSecret = { app: key, kid, secret: out.secret }; st.embedProblem = null; App.closeOverlay(); reloadEmbed(); ctx.toast('Key ' + esc(kid) + ' added. Audited app.embed.key.created.', 'ok'); } catch (err) { fail(err, 'Key not added'); } }); } }));
    ctx.on('click', '[data-emrevoke]', async (e, t) => { const k = em.keys.find((x) => x.id === t.dataset.emrevoke); if (!k) return; const ok = await ctx.confirm({ title: 'Revoke key ' + k.kid + '?', tone: 'danger', body: '<p class="fg2" style="margin:0">Tokens signed with it are refused from now on, and every session it opened ends at once.</p>', ok: 'Revoke' }); if (!ok) return; try { await App.del(A(app.id) + '/embed/keys/' + enc(k.id)); reloadEmbed(); ctx.toast('Key ' + esc(k.kid) + ' revoked; its sessions ended. Audited app.embed.key.revoked.', 'warn'); } catch (err) { App.fail(err, 'Could not revoke the key'); } });
    ctx.on('click', '[data-emaddpage]', () => modal(ctx, { title: 'Publish a form as an embed page', body: UI.field('Public form', UI.select(publicForms.map((f) => ({ value: f.name, label: (f.title || f.name) + ' (' + f.name + ')' })), publicForms[0] ? publicForms[0].name : '', 'data-form aria-label="Public form"'), 'Only forms with a public link.') + UI.notice('The page is served at /embed/&lt;id&gt; with frame-ancestors set to the allowed host sites.', 'info'), actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn('Publish', { kind: 'primary', attrs: 'data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', async () => { const form = m.querySelector('[data-form]').value; try { const out = await App.post(A(app.id) + '/embed/pages', { form }); st.embedProblem = null; App.closeOverlay(); reloadEmbed(); ctx.toast('Embed page for ' + esc(form) + ' published at ' + esc(out.url) + '. Audited app.embed.page.created.', 'ok', 6000); } catch (err) { fail(err, 'Page not published'); } }); } }));
    ctx.on('click', '[data-emsnippet]', (e, t) => { const p = em.pages.find((x) => x.id === t.dataset.emsnippet); if (!p) return; modal(ctx, { title: 'Embed ' + esc(p.formTitle), body: UI.code('<iframe src="' + p.url + '" title="' + p.formTitle + '" width="100%" height="640" style="border:0"></iframe>', 'html') + UI.notice('Works on ' + esc(em.allowedHosts.join(', ') || 'no site yet: add the host sites first') + '. The browser refuses the frame elsewhere.', 'info'), actions: UI.btn('Close', { attrs: 'data-close' }) }); });
    ctx.on('click', '[data-emrmpage]', async (e, t) => { const p = em.pages.find((x) => x.id === t.dataset.emrmpage); if (!p) return; const ok = await ctx.confirm({ title: 'Remove the embed page for ' + p.formTitle + '?', tone: 'danger', body: '<p class="fg2" style="margin:0">Sites framing it get a 404 from now on. The form and its public link stay.</p>', ok: 'Remove' }); if (!ok) return; try { await App.del(A(app.id) + '/embed/pages/' + enc(p.id)); reloadEmbed(); ctx.toast('Embed page removed. Audited app.embed.page.removed.', 'warn'); } catch (err) { App.fail(err, 'Could not remove the page'); } });
    ctx.on('click', '[data-emendall]', async () => { const ok = await ctx.confirm({ title: 'End every embedded session?', tone: 'danger', body: '<p class="fg2" style="margin:0">Pages framed on the host sites get 401 on their next call and ask the host for a new token.</p>', ok: 'End sessions' }); if (!ok) return; try { const out = await App.post(A(app.id) + '/embed/sessions/revoke', {}); reloadEmbed(); ctx.toast(out.revoked + ' session' + (out.revoked === 1 ? '' : 's') + ' ended. Audited app.embed.sessions.revoked.', 'warn'); } catch (err) { App.fail(err, 'Could not end the sessions'); } });
    return secret + problem + settings + keys + pages + sessions;
  }

  function renderTriggers(ctx, app) {
    const st = ctx.state;
    const triggers = app.triggers || [];
    const rows = triggers.map((t) => ({ cells: [UI.pill(t.kind, t.kind === 'schedule' ? 'info' : 'outline'), esc(((app.entities.find((e) => e.name === t.entity) || {}).title) || t.entity), t.kind === 'record' ? t.events.map((e) => '<span class="mono">' + esc(e) + '</span>').join(', ') : '<span class="mono">' + esc(t.cron || '') + '</span> <span class="muted">UTC</span>' + (t.schedule ? '<div class="muted" style="font-size:11px">' + esc(t.schedule) + '</div>' : ''), t.workflow ? '<a href="#" data-goworkflow="' + esc(t.workflowId) + '">' + esc(t.workflow) + '</a>' : '<span class="muted">gone</span>', esc(who(t.ownerId)), UI.toggle(t.enabled ? 'on' : 'off', t.enabled, 'data-manual data-ttoggle="' + esc(t.id) + '" aria-label="Trigger ' + esc(t.id) + ' enabled"'), esc(t.nextRunAt ? when(t.nextRunAt) : ''), esc(t.lastRunAt ? when(t.lastRunAt) : 'never') + (t.lastRunId ? ' <a href="#" data-gorun="' + esc(t.lastRunId) + '" class="mono" style="font-size:11px">' + esc(t.lastRunId.slice(-8)) + '</a>' : ''), t.lastResult ? (/^skip/.test(t.lastResult) ? '<span style="color:var(--warn-fg)">' + esc(t.lastResult) + '</span>' : UI.pill(t.lastResult, /fail|error/.test(t.lastResult) ? 'danger' : 'ok')) : '', '<span class="hstack gap4" style="justify-content:flex-end">' + UI.iconbtn('edit', 'Edit trigger ' + t.id, { attrs: 'data-tedit="' + esc(t.id) + '"', cls: 'sm ghost' }) + UI.iconbtn('trash', 'Delete trigger ' + t.id, { attrs: 'data-tdel="' + esc(t.id) + '"', cls: 'sm ghost' }) + '</span>'] }));
    const body = UI.panel('Triggers', UI.notice('A record trigger fires on created, updated, deleted or transitioned records of its entity; a schedule trigger on a five-field UTC cron, each due time claimed once across instances. Each runs the workflow\'s published version as its creator, who must still be active, hold agents:run and records:read, belong to the workflow\'s workspace and be cleared for the record; otherwise a skip is recorded. Chains stop at APPS_TRIGGER_MAX_DEPTH, and a workflow\'s own record steps never fire that workflow\'s triggers.', 'info')
      + UI.table(['Kind', 'Entity', 'Events or cron', 'Workflow', 'Owner', 'Enabled', 'Next run', 'Last run', 'Last result', { label: '', right: true }], rows, { clickable: false, minWidth: '1000px', emptyTitle: 'No triggers', emptyText: 'Connect an entity to a published workflow.' })
      + '<div class="hstack gap6 wrap">' + UI.btn('Add trigger', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-tadd', disabled: !app.entities.length }) + (App.canOpen('workflows') ? UI.btn('Workflow record steps', { size: 'sm', attrs: 'data-goworkflow=""' }) : '') + '</div>');
    const tModal = async (t) => {
      let wfs = [];
      if (!t) { try { wfs = (await App.get('/api/workflows')).filter((w) => w.publishedVersion != null); } catch (err) { App.fail(err, 'Could not list workflows'); return; } }
      const ents = app.entities.map((e) => ({ value: e.name, label: e.title || e.name }));
      modal(ctx, { title: t ? 'Edit trigger' : 'Add trigger', body: '<div class="formgrid">'
        + (t ? UI.field('Entity', UI.input(t.entity, { readonly: true })) + UI.field('Kind', UI.input(t.kind, { readonly: true })) + UI.field('Workflow', UI.input(t.workflow || '', { readonly: true }), 'Entity, kind and workflow are fixed; delete and add a trigger to change them.')
          : UI.field('Entity', UI.select(ents, ents[0] ? ents[0].value : '', 'data-tr-entity')) + UI.field('Kind', UI.select(['record', 'schedule'], 'record', 'data-tr-kind')) + UI.field('Workflow', wfs.length ? UI.select(wfs.map((w) => ({ value: w.id, label: w.name + ' v' + w.publishedVersion })), wfs[0].id, 'data-tr-wf') : UI.select([{ value: '', label: 'no published workflow' }], '', 'data-tr-wf disabled'), 'Published and visible in your current workspace.'))
        + UI.field('Cron (schedule)', UI.input(t && t.cron ? t.cron : '0 6 * * 1', { attrs: 'data-tr-cron' }), 'Five fields, UTC.') + '</div>'
        + UI.field('Events (record)', '<div class="hstack wrap gap6">' + EVENTS.map((e) => UI.check(e, t ? t.events.indexOf(e) >= 0 : e === 'created', 'data-tr-ev="' + e + '"')).join('') + '</div>') + UI.check('Enabled', t ? t.enabled : true, 'data-tr-on')
        + (!t && !wfs.length ? UI.notice('No published workflow is visible in your current workspace. Publish one on Workflows first.', 'warn') : '') + '<div data-tr-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(t ? 'Save' : 'Add trigger', { kind: 'primary', attrs: 'data-tr-ok', disabled: !t && !wfs.length }),
      onMount(m) {
        m.querySelector('[data-tr-ok]').addEventListener('click', async () => {
          const errEl = m.querySelector('[data-tr-err]'); errEl.innerHTML = '';
          const kind = t ? t.kind : m.querySelector('[data-tr-kind]').value;
          const events = Array.prototype.slice.call(m.querySelectorAll('[data-tr-ev]')).filter((c) => c.checked).map((c) => c.dataset.trEv);
          const cron = m.querySelector('[data-tr-cron]').value.trim(); const enabled = m.querySelector('[data-tr-on]').checked;
          if (kind === 'record' && !events.length) { errEl.innerHTML = UI.notice('Pick at least one event.', 'warn'); return; }
          if (kind === 'schedule' && cron.split(/\s+/).length !== 5) { errEl.innerHTML = UI.notice('A cron has five fields.', 'warn'); return; }
          try {
            if (t) { const b = { enabled }; if (kind === 'record') b.events = events; else b.cron = cron; await App.patch(A(app.id) + '/triggers/' + enc(t.id), b); afterChange(ctx, {}); ctx.toast('Trigger saved. Audited app.trigger.updated.', 'ok'); }
            else { const b = { entity: m.querySelector('[data-tr-entity]').value, kind, workflow: m.querySelector('[data-tr-wf]').value, enabled }; if (kind === 'record') b.events = events; else b.cron = cron; await App.post(A(app.id) + '/triggers', b); afterChange(ctx, {}); ctx.toast('Trigger added; it runs as you. Audited app.trigger.created.', 'ok'); }
          } catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
        });
      } });
    };
    ctx.on('click', '[data-tadd]', () => tModal(null));
    ctx.on('click', '[data-tedit]', (e, t) => tModal(triggers.find((x) => x.id === t.dataset.tedit)));
    ctx.on('click', '[data-ttoggle]', async (e, t) => { const tr = triggers.find((x) => x.id === t.dataset.ttoggle); try { await App.patch(A(app.id) + '/triggers/' + enc(tr.id), { enabled: !tr.enabled }); st.detailKey = st.busyDetail = null; ctx.rerender(); ctx.toast('Trigger ' + (tr.enabled ? 'disabled' : 'enabled') + '. Audited app.trigger.updated.', 'ok'); } catch (err) { App.fail(err, 'Could not change the trigger'); } });
    ctx.on('click', '[data-tdel]', async (e, t) => { const tr = triggers.find((x) => x.id === t.dataset.tdel); const ok = await ctx.confirm({ title: 'Delete trigger', tone: 'danger', body: '<p class="fg2" style="margin:0">Queued jobs for it are dropped; runs already started finish.</p>', kv: [['Entity', esc(tr.entity)], ['Workflow', esc(tr.workflow || '')]], ok: 'Delete' }); if (!ok) return; try { await App.del(A(app.id) + '/triggers/' + enc(tr.id)); afterChange(ctx, {}); ctx.toast('Trigger deleted. Audited app.trigger.deleted.', 'warn'); } catch (err) { App.fail(err, 'Could not delete the trigger'); } });
    return body;
  }
})();
