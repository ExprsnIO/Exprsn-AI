(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const THINK = ['off', 'low', 'medium', 'high'];
  const rank = (l) => LABELS.indexOf(l);
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const short = (d) => (d ? 'sha256:' + String(d).replace(/^sha256:/, '').slice(0, 8) + '…' : 'no digest yet');
  const RES_KIND = { loaded: 'ok', cold: 'info', unavailable: 'danger', none: '' };
  const TOOL_NOTE = 'Registry and MCP tools are bound on the MCP servers screen and kept when the profile is saved.';

  /** The editable settings of a saved profile, as form values. */
  const formOf = (p) => ({
    displayName: p.displayName, description: p.description || '', modelId: p.modelId || '', poolId: p.poolId || '',
    numCtx: p.numCtx == null ? '' : String(p.numCtx), temperature: p.temperature == null ? '' : String(p.temperature),
    label: p.label, thinkDefault: p.thinkDefault, thinkCeiling: p.thinkCeiling, systemPrompt: p.systemPrompt || '',
    fbProfile: p.fallback ? p.fallback.profileId : '', fbWait: p.fallback ? String(p.fallback.afterQueueWaitMs / 1000) : '8',
    calculate: (p.tools || []).indexOf('calculate') >= 0,
    others: (p.tools || []).filter((t) => t !== 'calculate')
  });
  const num = (v, what, int) => {
    if (String(v).trim() === '') return null;
    const n = Number(v);
    if (!isFinite(n) || (int && Math.round(n) !== n)) throw new Error(what + ' must be ' + (int ? 'a whole number' : 'a number') + '.');
    return n;
  };
  /** Form values as the API body. Throws on numbers that do not parse. */
  const bodyOf = (f) => ({
    displayName: f.displayName.trim(), description: f.description.trim() || null, modelId: f.modelId || null, poolId: f.poolId || null,
    numCtx: num(f.numCtx, 'num_ctx', true), temperature: num(f.temperature, 'temperature'), label: f.label,
    thinkDefault: f.thinkDefault, thinkCeiling: f.thinkCeiling, systemPrompt: f.systemPrompt.trim() ? f.systemPrompt : null,
    fallback: f.fbProfile ? { profileId: f.fbProfile, afterQueueWaitMs: Math.round((num(f.fbWait, 'Queue wait') || 0) * 1000) } : null,
    tools: (f.calculate ? ['calculate'] : []).concat(f.others || [])
  });

  function cur(st) { return (st.profiles || []).find((x) => x.id === st.sel) || null; }

  App.register({
    id: 'profiles', title: 'Profiles', section: 'admin', live: true,
    summary: 'Pinned model, options, prompt, pool, residency, label, fallback, canary and version history',
    crumb: (st) => { const p = cur(st); return ['Admin', 'Profiles'].concat(p ? [p.name] : []); },
    label: (st) => { const p = cur(st); const t = p && p.aliasOf ? (st.profiles || []).find((x) => x.id === p.aliasOf) : p; return t ? t.label : null; },
    commands: [{ label: 'New model profile', sub: 'Profiles', run(app) { app.stateFor('profiles').openNew = 'profile'; app.render(); } }],
    states: [
      { title: 'Tools refused', tone: 'danger', text: 'A model without the tools capability, or with tools withheld after its conformance test, cannot publish a profile that offers the calculate tool.', apply(ctx) { ctx.state.demo = 'tools'; ctx.rerender(); } },
      { title: 'Thinking unsupported', tone: 'warn', text: 'A thinking ceiling above off needs a model with the thinking capability; the server refuses to publish until it is off.', apply(ctx) { ctx.state.demo = 'think'; ctx.rerender(); } },
      { title: 'Alias repoint', tone: 'info', text: 'Moving an alias to another profile shows the model, label and pool change and which of your workspaces are affected before it applies.', apply(ctx) { ctx.state.demo = 'repoint'; ctx.rerender(); } },
      { title: 'Ceiling conflict', tone: 'danger', text: 'A profile labelled above the data its model is approved for cannot publish, and a canary model must be approved for the profile\'s label.', apply(ctx) { ctx.state.demo = 'ceiling'; ctx.rerender(); } },
      { title: 'Delete refused', tone: 'danger', text: 'A profile that an alias or a fallback points at cannot be deleted until they are moved.', apply(ctx) { ctx.state.demo = 'dependants'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      st.form = st.form || {}; st.versions = st.versions || {};
      // Re-rendering closes any open dialog, so data that arrives while one is open waits until it closes.
      const later = () => { if (App.state.route !== 'profiles') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      const load = () => {
        if (st.loading) { st.again = true; return; }
        st.loading = true;
        Promise.all([
          App.get('/api/admin/profiles'),
          App.can('models:read') ? App.get('/api/admin/models') : Promise.resolve(null),
          App.can('pools:manage') ? App.get('/api/admin/pools') : Promise.resolve(null),
          App.can('users:manage') ? App.get('/api/admin/users?limit=500').catch(() => null) : Promise.resolve(null)
        ])
          .then(([profiles, models, pools, users]) => { Object.assign(st, { profiles, models, pools, users, loaded: true, loadError: null }); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; if (st.again) { st.again = false; load(); return; } later(); });
      };
      if (!st.loaded && !st.loadError) load();
      const refresh = () => { st.versions = {}; st.evals = {}; load(); };
      const reload = () => { st.loaded = false; st.loadError = null; st.versions = {}; ctx.rerender(); };
      /** Runs one server call; a refusal stays on the page as a notice as well as a toast. */
      const act = async (fn, okMsg, pid) => {
        try { const r = await fn(); st.conflict = null; if (okMsg) toast(okMsg, 'ok', 5000); refresh(); return r || true; }
        catch (err) { const pr = err.problem || {}; if (err.status >= 400 && err.status < 500) st.conflict = { id: pid, title: pr.title || 'Refused', detail: err.message, trace: pr.trace_id }; App.fail(err); ctx.rerender(); return null; }
      };

      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Profiles', 'What users pick in chat: a pinned model plus options, prompt, pool, label and fallback', '')
          + (st.loadError ? UI.problem('Profiles could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', reload);
        return;
      }

      const list = st.profiles;
      const selBefore = st.sel;
      const byId = (id) => list.find((x) => x.id === id);
      if (ctx.params.profile) { const want = ctx.params.profile; const hit = list.find((x) => x.id === want || x.name === want); if (hit) st.sel = hit.id; delete ctx.params.profile; }
      if (!byId(st.sel)) st.sel = list[0] ? list[0].id : null;
      const reals = list.filter((x) => !x.aliasOf);
      const models = st.models;
      const modelById = (id) => (models ? models.find((m) => m.id === id) : null) || (list.map((x) => x.model).find((m) => m && m.id === id)) || null;
      const pickable = (keep) => (models || []).filter((m) => m.state === 'approved' || m.id === keep);
      const poolChoices = () => {
        if (st.pools) return st.pools.map((pl) => ({ id: pl.id, name: pl.name, ceiling: pl.label_ceiling }));
        const seen = {}; const out = [];
        (models || []).forEach((m) => (m.pools || []).forEach((x) => { if (!seen[x.poolId]) { seen[x.poolId] = true; out.push({ id: x.poolId, name: x.pool || x.poolId, ceiling: null }); } }));
        list.forEach((p) => { if (p.poolId && !seen[p.poolId]) { seen[p.poolId] = true; out.push({ id: p.poolId, name: p.pool || p.poolId, ceiling: null }); } });
        return out;
      };
      const poolName = (id) => { const x = poolChoices().find((pl) => pl.id === id); return x ? x.name : (id ? 'unknown pool' : 'any pool the model is placed on'); };
      const userName = (id) => { if (App.me && App.me.user && id === App.me.user.id) return 'you'; const u = (st.users || []).find((x) => x.id === id); return u ? u.displayName : (id ? id.slice(-6) : ''); };
      const dependants = (p) => list.filter((y) => y.aliasOf === p.id || (y.fallback && y.fallback.profileId === p.id));
      const myLabels = LABELS.filter((l) => !App.me || !App.me.user || rank(l) <= rank(App.me.user.clearance));

      // ---- demo states: pick a matching profile from live data and stage the edit that the server would refuse ----
      if (st.demo) {
        const d = st.demo; st.demo = null; st.demoNote = null; st.conflict = null; st.showDependants = null;
        const withModel = reals.filter((p) => p.model);
        const stage = (p, patch) => { st.sel = p.id; st.form[p.id] = Object.assign(formOf(p), st.form[p.id] || {}, patch); };
        if (d === 'tools') {
          const p = withModel.find((x) => { const m = modelById(x.modelId); return m.capabilities.indexOf('tools') < 0 || (m.evaluation && m.evaluation.toolsWithheld); });
          const noTools = (models || []).find((m) => m.state === 'approved' && (m.capabilities.indexOf('tools') < 0 || (m.evaluation && m.evaluation.toolsWithheld)));
          if (p) stage(p, { calculate: true });
          else if (noTools && reals.length) { const fit = reals.find((x) => rank(x.label) <= rank(noTools.label) && (x.thinkCeiling === 'off' || noTools.capabilities.indexOf('thinking') >= 0)) || reals[0]; stage(fit, { modelId: noTools.id, calculate: true }); }
          else st.demoNote = 'Every approved model has the tools capability, so nothing is refused here. The check below runs whenever the calculate tool is on.';
        } else if (d === 'think') {
          const p = withModel.find((x) => modelById(x.modelId).capabilities.indexOf('thinking') < 0);
          const noThink = (models || []).find((m) => m.state === 'approved' && m.capabilities.indexOf('thinking') < 0);
          if (p) stage(p, { thinkCeiling: 'medium' });
          else if (noThink && reals.length) { const fit = reals.find((x) => rank(x.label) <= rank(noThink.label)) || reals[0]; stage(fit, { modelId: noThink.id, thinkCeiling: 'medium' }); }
          else st.demoNote = 'Every approved model supports thinking, so nothing is refused here.';
        } else if (d === 'ceiling') {
          const p = withModel.find((x) => rank(modelById(x.modelId).label) < 3 && myLabels.indexOf(LABELS[rank(modelById(x.modelId).label) + 1]) >= 0);
          if (p) stage(p, { label: LABELS[rank(modelById(p.modelId).label) + 1] }); else st.demoNote = 'No profile has a model approved below your clearance, so the conflict cannot be staged here.';
        } else if (d === 'dependants') {
          const p = reals.find((x) => dependants(x).length);
          if (p) { st.sel = p.id; st.showDependants = p.id; } else st.demoNote = 'No alias or fallback points at a profile yet; every profile here can be deleted.';
        } else if (d === 'repoint') {
          const a = list.find((x) => x.aliasOf);
          if (a) { st.sel = a.id; const to = reals.find((x) => x.id !== a.aliasOf); if (to) st.openRepoint = to.id; else st.demoNote = 'There is only one profile to point at. Create another to repoint ' + a.name + '.'; }
          else if (reals.length) st.openNew = 'alias'; else st.demoNote = 'Create a profile first; an alias points at one.';
        }
      }

      const p = byId(st.sel);
      const isAlias = !!(p && p.aliasOf);
      const target = p ? (isAlias ? byId(p.aliasOf) : p) : null;

      const side = '<div class="leftpane" style="width:300px"><div class="hstack"><div class="eyebrow grow">Profiles</div>' + UI.btn('New', { size: 'sm', icon: 'plus', attrs: 'data-new' }) + '</div><div class="vstack gap4">'
        + (list.length ? list.map((x) => { const t = x.aliasOf ? byId(x.aliasOf) : null; return UI.listItem(esc(x.name), esc(x.aliasOf ? 'alias, points to ' + (t ? t.name : 'a removed profile') : (x.model ? x.model.name : 'no model chosen')), { active: p && x.id === p.id, attrs: 'data-profile="' + esc(x.id) + '"', right: UI.pill(x.aliasOf ? 'alias' : x.status, x.aliasOf ? 'outline' : undefined) }); }).join('') : '<div class="muted" style="font-size:12px">No profiles yet.</div>')
        + '</div></div>';

      const wsPanel = (t, title) => {
        const ws = (App.me && App.me.workspaces) || [];
        return UI.panel(title, UI.table(['Workspace', 'Ceiling', 'With ' + t.name], ws.map((w) => [esc(w.name), UI.label(w.label, { sm: true }), rank(w.label) <= rank(t.label) ? UI.pill('every conversation label fits', 'ok') : UI.pill('only conversations up to ' + t.label, 'warn')]), { clickable: false, minWidth: '0', emptyTitle: 'No workspaces', emptyText: 'You are not a member of any workspace.' })
          + '<div class="muted" style="font-size:12px">A conversation can use this profile when its label is at or below <b>' + esc(t.label) + '</b> and the user is cleared for ' + esc(t.label) + '. Only workspaces you belong to are listed.</div>');
      };
      const versionsPanel = (x) => {
        const v = st.versions[x.id];
        if (!v) { if (st.vLoading !== x.id) { st.vLoading = x.id; App.get('/api/admin/profiles/' + enc(x.id) + '/versions').then((r) => { st.versions[x.id] = r; }).catch((err) => { st.versions[x.id] = { error: err }; }).finally(() => { st.vLoading = null; later(); }); } return UI.panel('Version history', '<div class="muted">Loading…</div>'); }
        if (v.error) return UI.panel('Version history', UI.problem('Versions could not be loaded', v.error.message, v.error.problem && v.error.problem.trace_id));
        const rows = v.slice().sort((a, b) => b.version - a.version).map((r) => ({ cells: ['<span class="num">' + r.version + '</span>' + (r.version === x.version ? ' ' + UI.pill('current', 'accent') : ''), esc(r.note || ''), esc(userName(r.createdBy)), esc(when(r.createdAt)), '<span class="hstack" style="justify-content:flex-end">' + (r.version === x.version ? '' : UI.btn('Roll back', { kind: 'ghost', size: 'xs', icon: 'undo', attrs: 'data-rollback="' + r.version + '"' })) + '</span>'] }));
        return UI.panel('Version history', UI.table(['Version', 'Note', 'By', 'When', { label: '', right: true }], rows, { clickable: false, minWidth: '0' }) + '<div class="muted" style="font-size:12px">Every change saves a new version. Rolling back copies an earlier version\'s settings into a new one; nothing is overwritten.</div>');
      };
      const conflictNotice = (x) => (st.conflict && st.conflict.id === x.id ? UI.notice('<b>' + esc(st.conflict.title) + '.</b> ' + esc(st.conflict.detail) + (st.conflict.trace ? ' <span class="mono muted" style="font-size:11px">trace ' + esc(st.conflict.trace) + '</span>' : ''), 'danger', UI.btn('Dismiss', { kind: 'ghost', size: 'xs', attrs: 'data-dismiss' })) : '');

      // ---- Evaluations (B-1303): eval sets, runs and the publish gate for the saved settings ----
      st.evals = st.evals || {};
      const loadEvals = (id) => {
        if (st.eLoading === id) return;
        st.eLoading = id;
        App.get('/api/admin/profiles/' + enc(id) + '/evaluations').then((r) => { st.evals[id] = r; }).catch((err) => { st.evals[id] = { error: err }; }).finally(() => {
          st.eLoading = null; later();
          const e = st.evals[id];
          // Runs are jobs: look again while one is queued or running and this tab is open.
          if (e && e.runs && e.runs.some((x) => x.state === 'queued' || x.state === 'running')) setTimeout(() => { if (App.state.route === 'profiles' && st.sel === id && st.ptab === 'evals') loadEvals(id); }, 2000);
        });
      };
      const RUN_KIND = { passed: 'ok', failed: 'danger', error: 'danger', queued: 'info', running: 'info' };
      const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
      const evalPanel = (x) => {
        const e = st.evals[x.id];
        if (!e) { loadEvals(x.id); return UI.notice('Loading evaluations…', 'info'); }
        if (e.error) return UI.problem('Evaluations could not be loaded', e.error.message, e.error.problem && e.error.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-ereload' }) + '</div>';
        const g = e.gate; const me = App.me && App.me.user ? App.me.user.id : null;
        const busy = e.runs.some((r) => r.state === 'queued' || r.state === 'running');
        const gateText = !g.gated ? 'No eval set gates publishing. Mark a set as a gate to require it.'
          : g.failing.length ? (g.overridden ? 'An approved override lets these settings be published although: ' : 'Publishing these settings is refused until: ') + g.failing.map((f2) => esc(f2.set) + ', ' + esc(f2.reason)).join('; ') + '.'
          : 'Every gated set passed for the saved settings (version ' + x.version + '). Publishing is allowed.';
        const pending = e.overrides.filter((o) => o.state === 'pending');
        const gateNotice = UI.notice(gateText, !g.gated ? 'info' : g.failing.length && !g.overridden ? 'warn' : 'ok',
          '<span class="hstack gap6">' + UI.btn(busy ? 'Running…' : 'Run evaluations', { size: 'sm', attrs: 'data-erun', disabled: busy || !e.sets.length }) + (g.failing.length && !g.overridden && !pending.length ? UI.btn('Request override', { size: 'sm', kind: 'ghost', attrs: 'data-eoverride' }) : '') + '</span>');
        const latest = (setId) => e.runs.find((r) => r.setId === setId && r.configHash === g.configHash);
        const sets = UI.table(['Set', 'Cases', 'Threshold', 'Gate', 'Judge', 'Label', 'Saved settings', { label: '', right: true }], e.sets.map((x2) => {
          const r = latest(x2.id);
          return [esc(x2.name) + (x2.description ? '<div class="muted" style="font-size:12px">' + esc(x2.description) + '</div>' : ''), '<span class="num">' + x2.cases.length + '</span>', '<span class="num">' + pct(x2.threshold) + '</span>', x2.gate ? UI.pill('gates publishing', 'accent') : UI.pill('advisory', 'outline'), esc(x2.judgeProfile || 'none'), UI.label(x2.label, { sm: true }),
            r ? UI.pill(r.state + (r.score != null ? ', ' + pct(r.score) : ''), RUN_KIND[r.state]) : '<span class="muted">not run</span>',
            '<span class="hstack" style="justify-content:flex-end">' + UI.btn('Run', { kind: 'ghost', size: 'xs', attrs: 'data-erunset="' + esc(x2.id) + '"', disabled: busy }) + UI.btn('Edit', { kind: 'ghost', size: 'xs', attrs: 'data-eedit="' + esc(x2.id) + '"' }) + UI.btn('Delete', { kind: 'ghost', size: 'xs', attrs: 'data-edel="' + esc(x2.id) + '"' }) + '</span>'];
        }), { clickable: false, minWidth: '0', emptyTitle: 'No eval sets', emptyText: 'Add a set of cases: prompts with the properties their answers must have.' });
        const history = UI.table(['When', 'Set', 'Version', 'Score', 'Threshold', 'Result', 'By', { label: '', right: true }], e.runs.slice(0, 30).map((r) => [esc(when(r.createdAt)), esc(r.set || ''), '<span class="num">' + r.profileVersion + '</span>' + (r.configHash === g.configHash ? ' ' + UI.pill('saved settings', 'outline') : ''), '<span class="num">' + pct(r.score) + (r.total != null ? ' <span class="muted">(' + r.passed + ' of ' + r.total + ')</span>' : '') + '</span>', '<span class="num">' + pct(r.threshold) + '</span>', UI.pill(r.state, RUN_KIND[r.state]), esc(r.createdByName || ''), '<span class="hstack" style="justify-content:flex-end">' + (r.state === 'queued' || r.state === 'running' ? '' : UI.btn('Details', { kind: 'ghost', size: 'xs', attrs: 'data-erundetail="' + esc(r.id) + '"' })) + '</span>']), { clickable: false, minWidth: '0', emptyTitle: 'No runs yet', emptyText: 'Run the evaluations to score the saved settings.' });
        const overrides = e.overrides.length ? UI.panel('Overrides', UI.table(['Requested', 'By', 'Reason', 'Version', 'State', { label: '', right: true }], e.overrides.map((o) => [esc(when(o.requestedAt)), esc(o.requestedByName || ''), esc(o.reason), '<span class="num">' + o.profileVersion + '</span>', UI.pill(o.state, o.state === 'approved' ? 'ok' : o.state === 'rejected' ? 'danger' : 'warn') + (o.decidedByName ? ' <span class="muted" style="font-size:12px">by ' + esc(o.decidedByName) + '</span>' : ''), '<span class="hstack" style="justify-content:flex-end">' + (o.state === 'pending' && o.requestedBy !== me ? UI.btn('Approve', { size: 'xs', attrs: 'data-edecide="approve" data-oid="' + esc(o.id) + '"' }) + UI.btn('Reject', { kind: 'ghost', size: 'xs', attrs: 'data-edecide="reject" data-oid="' + esc(o.id) + '"' }) : o.state === 'pending' ? '<span class="muted" style="font-size:12px">another profile admin decides</span>' : '') + '</span>']), { clickable: false, minWidth: '0' }) + '<div class="muted" style="font-size:12px">An override lets one set of settings be published although its evaluations did not pass. Someone other than the requester approves it.</div>') : '';
        return gateNotice
          + UI.panel('Eval sets', sets + '<div class="muted" style="font-size:12px">Each case is answered by the saved profile through the gateway and its output checkpoint, then checked: contains, does not contain, a pattern, a JSON schema, or a rubric scored by a judge profile. The score is the share of cases that pass.</div>', { actions: UI.btn('New eval set', { size: 'xs', icon: 'plus', attrs: 'data-enew' }) })
          + UI.panel('Score history', history)
          + overrides;
      };

      let main = '';
      let f = null; let dirty = false; let checks = [];
      if (!p) {
        main = UI.pagehead('Profiles', 'What users pick in chat: a pinned model plus options, prompt, pool, label and fallback', UI.btn('Refresh', { kind: 'ghost', size: 'sm', icon: 'refresh', attrs: 'data-refresh' }))
          + UI.empty('No profiles yet', 'A profile pins an approved model with its options, prompt, pool and label. Create one, then publish it for users.', UI.btn('New model profile', { kind: 'primary', attrs: 'data-new' }));
      } else if (isAlias) {
        const deps = dependants(p);
        main = UI.pagehead(p.displayName, UI.pill('alias', 'outline') + ' Clients ask for <span class="mono">' + esc(p.name) + '</span>; the gateway resolves it to the profile it points at, which you can repoint without client changes', UI.btn('Refresh', { kind: 'ghost', size: 'sm', icon: 'refresh', attrs: 'data-refresh' }) + UI.btn('Delete', { kind: 'ghost', size: 'sm', icon: 'trash', attrs: 'data-delete' }) + UI.btn('Repoint alias', { kind: 'primary', attrs: 'data-repoint' }))
          + conflictNotice(p) + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '')
          + (deps.length ? UI.notice('Pointed at by ' + deps.map((d) => '<b>' + esc(d.name) + '</b>').join(', ') + ' as a fallback.', 'info') : '')
          + (target ? '<div class="formgrid" style="--cols:3">' + UI.field('Points to', UI.select(reals.map((x) => ({ value: x.id, label: x.name })), target.id, 'data-alias-target')) + UI.field('Resolved model', UI.input(target.model ? target.model.name : 'no model chosen', { readonly: true })) + UI.field('Resolved label', '<div style="height:30px;display:flex;align-items:center">' + UI.label(target.label) + '</div>') + '</div>'
            + wsPanel(target, 'Your workspaces and this alias')
            + UI.panel('Resolved profile', UI.kv([['Profile', '<a href="#" data-profile-link="' + esc(target.id) + '">' + esc(target.name) + '</a> ' + UI.pill(target.status)], ['Pool', esc(target.pool || 'any pool the model is placed on')], ['Residency', UI.pill(target.residency, RES_KIND[target.residency])], ['Think', esc(target.thinkDefault + ', users may choose up to ' + target.thinkCeiling)], ['Tools', target.tools.length ? esc(target.tools.join(', ')) : 'none'], ['Fallback', target.fallback ? esc((byId(target.fallback.profileId) || { name: 'removed profile' }).name + ' when the model is unavailable or fails to load, or after ' + target.fallback.afterQueueWaitMs / 1000 + ' s queue wait') : 'none']], 3))
            : UI.notice('The profile this alias pointed at no longer exists. Repoint it.', 'danger'))
          + versionsPanel(p);
      } else {
        f = Object.assign(formOf(p), st.form[p.id] || {});
        const base = formOf(p);
        dirty = Object.keys(base).some((k) => String(base[k]) !== String(f[k]));
        const m = modelById(f.modelId);
        const pools = poolChoices();
        // The same checks the server runs when a profile is published (and on every save of a published one).
        if (!m) checks.push({ ok: false, text: 'Choose a model before publishing.' });
        else {
          checks.push({ ok: m.state === 'approved' || (m.state === 'deprecated' && p.status === 'published'), text: m.name + ' is ' + m.state + (m.state === 'approved' ? '.' : '; profiles publish only with an approved model.') });
          checks.push({ ok: rank(f.label) <= rank(m.label), text: m.name + ' is approved for ' + m.label + ' data; the profile\'s label is ' + f.label + '.' });
          if (m.pools) {
            const on = m.pools.filter((x) => !f.poolId || x.poolId === f.poolId);
            checks.push({ ok: on.length > 0, text: on.length ? m.name + ' is placed on ' + on.map((x) => x.pool).join(', ') + '.' : m.name + ' is not placed on ' + (f.poolId ? 'the chosen pool' : 'any pool') + '.' });
            if (st.pools && on.length) { const ok = on.some((x) => { const pl = st.pools.find((y) => y.id === x.poolId); return pl && rank(pl.label_ceiling) >= rank(f.label); }); checks.push({ ok, text: ok ? 'A pool running ' + m.name + ' is cleared for ' + f.label + ' data.' : 'No pool running ' + m.name + ' is cleared for ' + f.label + ' data.' }); }
          }
          checks.push({ ok: f.thinkCeiling === 'off' || m.capabilities.indexOf('thinking') >= 0, text: f.thinkCeiling === 'off' ? 'Thinking is off.' : m.capabilities.indexOf('thinking') >= 0 ? m.name + ' supports thinking.' : m.name + ' does not support thinking; set the ceiling to off.' });
          const withheld = m.evaluation && m.evaluation.toolsWithheld;
          checks.push({ ok: !f.calculate || (m.capabilities.indexOf('tools') >= 0 && !withheld), text: !f.calculate ? 'No tools offered.' : m.capabilities.indexOf('tools') < 0 ? m.name + ' has no tools capability.' : withheld ? m.name + ' has tools withheld until its tool-calling test passes.' : m.name + ' can call tools.' });
        }
        checks.push({ ok: THINK.indexOf(f.thinkDefault) <= THINK.indexOf(f.thinkCeiling), text: THINK.indexOf(f.thinkDefault) <= THINK.indexOf(f.thinkCeiling) ? 'Default thinking is within the ceiling.' : 'The default thinking level cannot be above the ceiling.' });
        const failing = checks.filter((c) => !c.ok).length;

        const modelOpts = [{ value: '', label: 'Choose an approved model' }].concat((models ? pickable(p.modelId) : (m ? [m] : [])).map((x) => ({ value: x.id, label: x.name + (x.state === 'approved' ? '' : ', ' + x.state) + ', ' + x.label })));
        const poolOpts = [{ value: '', label: 'Any pool the model is placed on' }].concat(pools.map((x) => ({ value: x.id, label: x.name + (x.ceiling ? ', ceiling ' + x.ceiling : '') })));
        const fbOpts = [{ value: '', label: 'No fallback' }].concat(list.filter((x) => x.id !== p.id).map((x) => ({ value: x.id, label: x.name + (x.aliasOf ? ' (alias)' : '') + ', ' + (x.aliasOf ? 'published' : x.status) })));
        const labelOpts = myLabels.indexOf(f.label) >= 0 ? myLabels : myLabels.concat([f.label]);
        const ptr = p.canary ? p.canary.percent : 0;
        const canaryM = p.canary ? modelById(p.canary.modelId) : null;
        const deps = dependants(p);
        const yaml = 'profile: ' + p.name + '\nversion: ' + p.version + '\nstatus: ' + p.status + '\nmodel: ' + (p.model ? p.model.name + '  # ' + short(p.model.digest) : 'none') + '\npool: ' + (p.pool || 'any') + '\nlabel: ' + p.label
          + '\noptions: { num_ctx: ' + (p.numCtx == null ? 'model default' : p.numCtx) + ', temperature: ' + (p.temperature == null ? 'model default' : p.temperature) + ' }'
          + '\nthink: { default: ' + p.thinkDefault + ', ceiling: ' + p.thinkCeiling + ' }'
          + '\nfallback: ' + (p.fallback ? '{ profile: ' + (byId(p.fallback.profileId) || { name: '?' }).name + ', afterQueueWait: ' + p.fallback.afterQueueWaitMs / 1000 + 's }' : 'none')
          + '\ncanary: ' + (p.canary ? '{ model: ' + (p.canaryModel || '?') + ', percent: ' + p.canary.percent + ' }' : 'none')
          + '\ntools: [' + p.tools.join(', ') + ']'
          + '\nsystemPrompt: ' + (p.systemPrompt ? '|\n  ' + p.systemPrompt.split('\n').join('\n  ') : 'none');

        const statusBtns = (p.status !== 'published' ? UI.btn('Publish', { attrs: 'data-status="published"', disabled: dirty, title: dirty ? 'Save or reset your changes first' : '' }) : '')
          + (p.status === 'published' ? UI.btn('Disable', { attrs: 'data-status="disabled"' }) : '')
          + (p.status !== 'draft' ? UI.btn('Back to draft', { kind: 'ghost', attrs: 'data-status="draft"' }) : '');
        main = UI.pagehead(p.displayName, UI.pill(p.status) + ' <span class="mono">' + esc(p.name) + '</span>, version ' + p.version + (p.description ? '. ' + esc(p.description) : '. What users pick in chat: a pinned model plus options, prompt, pool, label and fallback'),
          UI.btn('Refresh', { kind: 'ghost', size: 'sm', icon: 'refresh', attrs: 'data-refresh' }) + UI.btn('Delete', { kind: 'ghost', size: 'sm', icon: 'trash', attrs: 'data-delete' }) + statusBtns + (dirty ? UI.btn('Reset', { kind: 'ghost', attrs: 'data-reset' }) : '') + UI.btn('Save version', { kind: 'primary', attrs: 'data-save', disabled: !dirty }))
          + conflictNotice(p) + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '')
          + (st.showDependants === p.id && deps.length ? UI.notice('<b>Delete refused.</b> ' + deps.map((d) => esc(d.name)).join(', ') + ' point' + (deps.length === 1 ? 's' : '') + ' at this profile. Repoint the alias or change the fallback first.', 'danger') : deps.length ? UI.notice('Pointed at by ' + deps.map((d) => '<b>' + esc(d.name) + '</b>' + (d.aliasOf === p.id ? ' (alias)' : ' (fallback)')).join(', ') + '.', 'info') : '')
          + (p.model && p.model.state === 'deprecated' ? UI.notice(esc(p.model.name) + ' is deprecated. This profile keeps serving it, but once you switch away it cannot be picked again. <a href="#" data-go="models">Open Models</a>', 'warn') : '')
          + (p.model && p.model.state === 'retired' ? UI.notice(esc(p.model.name) + ' is retired; choose another model.', 'danger') : '')
          + (p.status === 'published' && p.residency === 'unavailable' ? UI.notice('No instance in ' + esc(p.pool || 'any pool') + ' has ' + esc(p.model ? p.model.name : 'the model') + ' pulled. Requests will fail until it is placed and pulled. <a href="#" data-go="models">Open Models</a>', 'danger') : '')
          + (dirty ? UI.notice('Unsaved changes. ' + (p.status === 'published' ? 'This profile is published, so saving runs the publishing checks and users get the new version on their next turn.' : 'Saving creates a new draft version.'), 'accent') : '')
          + UI.tabs([{ id: 'settings', label: 'Settings' }, { id: 'evals', label: 'Evaluations', count: st.evals && st.evals[p.id] && st.evals[p.id].sets ? st.evals[p.id].sets.length : null }], st.ptab === 'evals' ? 'evals' : 'settings')
          + (st.ptab === 'evals' ? '<div class="vstack gap12" style="min-width:0">' + evalPanel(p) + '</div>' : '<div class="vstack gap12" style="min-width:0">'
          + '<div class="formgrid" style="--cols:3">'
          + UI.field('Display name', UI.input(f.displayName, { attrs: 'data-f="displayName" maxlength="200"' }))
          + UI.field('Model', UI.select(modelOpts, f.modelId, 'data-f="model" data-key="modelId"'), m ? esc(short(m.digest)) + ', ' + esc(m.capabilities.join(', ')) + (models ? ' · <a href="#" data-go="models">Open in Models</a>' : '') : 'Only approved models are offered')
          + UI.field('Pool', UI.select(poolOpts, f.poolId, 'data-f="pool" data-key="poolId"'), App.can('pools:manage') ? '<a href="#" class="pf-go" data-go="pools">Instances and health</a>' : '')
          + UI.field('num_ctx (fixed at load)', UI.input(f.numCtx, { placeholder: 'model default', attrs: 'data-f="numCtx" class="input mono" inputmode="numeric"' }).replace('class="input" ', ''), 'Changing it reloads the model on every instance')
          + UI.field('temperature', UI.input(f.temperature, { placeholder: 'model default', attrs: 'data-f="temperature" class="input mono" inputmode="decimal"' }).replace('class="input" ', ''), '0 to 2')
          + UI.field('Max label', UI.select(labelOpts, f.label, 'data-f="label" data-key="label"'), 'Up to your clearance')
          + UI.field('Thinking default', UI.select(THINK, f.thinkDefault, 'data-f="thinkDefault" data-key="thinkDefault"'))
          + UI.field('Thinking ceiling', UI.select(THINK, f.thinkCeiling, 'data-f="thinkCeiling" data-key="thinkCeiling"'), 'Users may choose up to this level')
          + UI.field('Fallback', '<div class="hstack gap6">' + UI.select(fbOpts, f.fbProfile, 'data-f="fbProfile" data-key="fbProfile" style="flex:1;min-width:0"') + UI.input(f.fbWait, { attrs: 'data-f="fbWait" class="input mono" style="width:64px" inputmode="decimal" aria-label="Seconds of queue wait"' + (f.fbProfile ? '' : ' disabled') }).replace('class="input" ', '') + '<span class="muted">s</span></div>', 'Also used at once when the model is unavailable or fails to load; never when a policy refuses the request')
          + '</div>'
          + UI.field('System prompt', UI.textarea(f.systemPrompt, { placeholder: 'None: the model\'s own template applies', attrs: 'data-f="systemPrompt" maxlength="20000" spellcheck="false"', rows: 4 }))
          + '<div class="formgrid" style="--cols:2">' + UI.field('Description', UI.input(f.description, { placeholder: 'What this profile is for', attrs: 'data-f="description" maxlength="500"' }))
          + UI.field('Built-in tools', '<div style="min-height:30px;display:flex;align-items:center">' + UI.check('calculate, exact arithmetic', f.calculate, 'data-f="calculate" data-key="calculate"') + '</div>', esc(TOOL_NOTE)) + '</div>'
          + '<div class="cols"><div class="grow vstack gap12" style="min-width:0">'
          + UI.panel('Publishing checks', '<div class="vstack gap4">' + checks.map((c) => '<div class="pf-check">' + UI.pill(c.ok ? 'passes' : 'fails', c.ok ? 'ok' : 'danger') + '<span>' + esc(c.text) + '</span></div>').join('') + '</div>'
            + '<div class="muted" style="font-size:12px">' + (failing ? failing + ' check' + (failing === 1 ? '' : 's') + ' would stop publishing. ' : 'Publishing would pass these checks. ') + 'The server runs them again and has the final word; ' + (dirty ? 'these include your unsaved changes.' : 'they reflect the saved version.') + '</div>')
          + UI.panel('Model rollout', '<div class="hstack wrap gap12"><div style="flex:1 1 200px"><div class="pf-ptr"><div class="stable" style="width:' + (100 - ptr) + '%"></div>' + (ptr ? '<div class="canary" style="width:' + ptr + '%"></div>' : '') + '</div></div>'
            + '<span class="fg2" style="font-size:12px">' + (p.model ? (ptr ? (100 - ptr) + '% on <b>' + esc(p.model.name) + '</b>, ' + ptr + '% canary on <b>' + esc(p.canaryModel || 'unknown') + '</b>' : '100% on <b>' + esc(p.model.name) + '</b>') : 'No model chosen') + '</span></div>'
            + UI.kv([['Stable', p.model ? esc(p.model.name) + ' <span class="mono muted">' + esc(short(p.model.digest)) + '</span>' : 'none'], ['Canary', p.canary ? esc(p.canaryModel || '') + ' <span class="mono muted">' + esc(short(canaryM && canaryM.digest)) + '</span>, ' + ptr + '%' : 'none'], ['Residency', UI.pill(p.residency, RES_KIND[p.residency])], ['Pool', esc(p.pool || 'any pool the model is placed on')]], 2)
            + '<div class="hstack wrap gap6">' + UI.btn(p.canary ? 'Change canary' : 'Start canary', { size: 'sm', icon: 'branch', attrs: 'data-canary', disabled: !p.model || dirty, title: dirty ? 'Save or reset your changes first' : '' }) + UI.btn('Promote', { size: 'sm', attrs: 'data-promote', disabled: !p.canary || dirty }) + UI.btn('Stop canary', { size: 'sm', kind: 'ghost', attrs: 'data-stopcanary', disabled: !p.canary || dirty }) + '</div>')
          + wsPanel(p, 'Your workspaces and this profile')
          + versionsPanel(p)
          + '</div><div class="pf-side">' + UI.panel('Saved version', '<pre class="pf-yaml" tabindex="0" aria-label="Saved version as YAML">' + esc(yaml) + '</pre>', { actions: UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copy' }) }) + '</div></div></div>');
      }

      root.innerHTML = '<style>'
        + '.pf-ptr{display:flex;height:12px;background:var(--sel);border-radius:3px;overflow:hidden}.pf-ptr .stable{background:var(--meter)}.pf-ptr .canary{background:var(--accent)}'
        + '.pf-yaml{margin:0;padding:10px 12px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre;overflow:auto;min-height:210px}'
        + '.pf-check{display:flex;gap:8px;align-items:baseline;font-size:13px}.pf-check .pill{flex-shrink:0}'
        // A link alone on its hint line is a target in its own right: at least 24 px tall (WCAG 2.5.8).
        + '.pf-go{display:inline-block;min-height:24px;line-height:24px}'
        + '.pf-side{width:330px;flex-shrink:0;min-width:0}@media (max-width:1100px){.pf-side{width:100%}}'
        + '.pf-out{max-height:120px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:var(--fg2)}'
        + '</style>'
        + side
        + '<div class="page">' + main + '</div>';

      // The header's crumb and label were drawn before this render picked the profile; redraw them when it changed.
      if (st.sel !== selBefore && App.renderHeader) App.renderHeader();

      // ---- events ----
      ctx.on('click', '[data-profile]', (e, t) => { st.sel = t.dataset.profile; st.demoNote = null; st.showDependants = null; ctx.rerender(); });
      ctx.on('click', '[data-profile-link]', (e, t) => { e.preventDefault(); st.sel = t.dataset.profileLink; ctx.rerender(); });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go, t.dataset.go === 'models' && target && target.model ? { model: target.model.name } : undefined); });
      ctx.on('click', '[data-refresh]', () => { refresh(); toast('Refreshing profiles.', '', 1500); });
      ctx.on('click', '[data-dismiss]', () => { st.conflict = null; ctx.rerender(); });
      ctx.on('click', '[data-new]', () => newModal('profile'));

      const delProfile = async () => {
        const deps = dependants(p);
        const ok = await ctx.confirm({ title: 'Delete ' + p.name + '?', tag: 'cannot be undone', tone: 'danger', body: '<div class="fg2">' + (p.aliasOf ? 'Clients asking for ' + esc(p.name) + ' get an unknown-profile error.' : 'Users can no longer pick it, and its version history goes with it.') + (deps.length ? ' The server will refuse while ' + deps.map((d) => esc(d.name)).join(', ') + ' point' + (deps.length === 1 ? 's' : '') + ' at it.' : '') + '</div>', ok: 'Delete profile' });
        if (!ok) return;
        const r = await act(() => App.del('/api/admin/profiles/' + enc(p.id)), 'Profile ' + esc(p.name) + ' deleted. Audit entry written.', p.id);
        if (r) { st.sel = null; delete st.form[p.id]; }
      };
      if (p) ctx.on('click', '[data-delete]', delProfile);

      const rollback = async (ver) => {
        const v = (st.versions[p.id] || []).find((x) => x.version === ver);
        if (!v) return;
        const s = v.profile; const vm = modelById(s.modelId);
        const kv = s.aliasOf ? [['Points to', esc((byId(s.aliasOf) || { name: 'a removed profile' }).name)]] : [['Model', esc(vm ? vm.name : 'none')], ['Label', UI.label(s.label, { sm: true })], ['Status', UI.pill(s.status)], ['Pool', esc(poolName(s.poolId))], ['Think', esc(s.thinkDefault + ' up to ' + s.thinkCeiling)], ['Canary', s.canary ? esc((modelById(s.canary.modelId) || { name: '?' }).name + ' at ' + s.canary.percent + '%') : 'none']];
        const ok = await ctx.confirm({ title: 'Roll ' + p.name + ' back to version ' + ver + '?', tag: 'rollback', tone: 'warn', body: '<p style="margin:0" class="fg2">Version ' + ver + ' (' + esc(v.note || '') + ') is copied into a new version ' + (p.version + 1) + '. ' + (s.status === 'published' ? 'It is published, so the publishing checks run again.' : '') + '</p>', kv, ok: 'Roll back' });
        if (!ok) return;
        const r = await act(() => App.post('/api/admin/profiles/' + enc(p.id) + '/rollback', { version: ver }), null, p.id);
        if (r) { delete st.form[p.id]; toast('<b>' + esc(p.name) + '</b> rolled back to version ' + ver + ', saved as version ' + r.version + '.', 'warn', 5000); }
      };
      ctx.on('click', '[data-rollback]', (e, t) => rollback(+t.dataset.rollback));

      if (p && isAlias) {
        const repointModal = (to) => {
          const ws = (App.me && App.me.workspaces) || [];
          const draw = (tid) => {
            const tp = byId(tid) || reals[0];
            return UI.field('Point ' + esc(p.name) + ' to', UI.select(reals.filter((x) => x.id !== (target && target.id)).map((x) => ({ value: x.id, label: x.name + ', ' + x.status })), tp.id, 'data-to'))
              + UI.kv([['From', target ? esc(target.name) + ', ' + esc(target.model ? target.model.name : 'no model') : 'a removed profile'], ['To', esc(tp.name) + ', ' + esc(tp.model ? tp.model.name : 'no model')], ['Label', (target ? esc(target.label) : '?') + ' → ' + esc(tp.label)], ['Pool', esc(target ? (target.pool || 'any') : '?') + ' → ' + esc(tp.pool || 'any')]], 2)
              + (tp.status !== 'published' ? UI.notice(esc(tp.name) + ' is ' + esc(tp.status) + '. Users cannot chat through the alias until it is published.', 'warn') : '')
              + '<div class="eyebrow">Your workspaces</div>' + UI.table(['Workspace', 'Ceiling', 'Effect'], ws.map((w) => [esc(w.name), UI.label(w.label, { sm: true }), rank(w.label) <= rank(tp.label) ? 'every conversation label fits' : '<span style="color:var(--warn-fg)">conversations above ' + esc(tp.label) + ' cannot use the alias</span>']), { clickable: false, minWidth: '0', emptyTitle: 'No workspaces', emptyText: '' })
              + UI.field('Note for the version history', UI.input('', { attrs: 'data-note maxlength="300"', placeholder: 'why the alias moves' }))
              + UI.notice('Applies on the next turn. Clients keep asking for ' + esc(p.name) + '; in-flight streams finish where they started.', 'info')
              + '<div class="mfoot">' + UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Apply repoint', { kind: 'primary', attrs: 'data-apply' }) + '</div>';
          };
          ctx.modal({ title: 'Repoint alias ' + esc(p.name), cls: 'wide', body: '<div class="vstack gap12" data-rpbody>' + draw(to) + '</div>', onClose() { ctx.rerender(); }, onMount(mEl) {
            const host = mEl.querySelector('[data-rpbody]');
            const wire = () => {
              host.querySelector('[data-to]').addEventListener('change', (e) => { host.innerHTML = draw(e.target.value); wire(); });
              host.querySelector('[data-apply]').addEventListener('click', async () => {
                const tid = host.querySelector('[data-to]').value; const note = host.querySelector('[data-note]').value.trim();
                App.closeOverlay();
                const r = await act(() => App.patch('/api/admin/profiles/' + enc(p.id), Object.assign({ aliasOf: tid }, note ? { note } : {})), null, p.id);
                if (r) toast('<b>' + esc(p.name) + '</b> now points to <b>' + esc((byId(tid) || {}).name || '') + '</b>. Saved as version ' + r.version + '.', 'ok', 5000);
              });
            };
            wire();
          } });
        };
        const other = () => { const o = reals.find((x) => x.id !== p.aliasOf); return o ? o.id : null; };
        ctx.on('click', '[data-repoint]', () => { if (other()) repointModal(other()); else toast('There is no other profile to point at.', 'warn'); });
        ctx.on('change', '[data-alias-target]', (e, t) => { if (t.value !== p.aliasOf) repointModal(t.value); });
        if (st.openRepoint) { const to = st.openRepoint; st.openRepoint = null; setTimeout(() => repointModal(to), 30); }
      }

      if (p && !isAlias) {
        const setF = (k, v) => { st.form[p.id] = Object.assign(formOf(p), st.form[p.id] || {}); st.form[p.id][k] = v; };
        // Text fields update state without re-rendering (focus stays put); selects and the checkbox re-render the checks.
        ctx.on('input', 'input[data-f]:not([type=checkbox]), textarea[data-f]', (e, t) => {
          setF(t.dataset.f, t.value);
          const was = dirty; const base = formOf(p); const now = Object.assign({}, base, st.form[p.id]);
          if (Object.keys(base).some((k) => String(base[k]) !== String(now[k])) === was) return;
          const key = t.dataset.f; const pos = t.selectionStart;
          ctx.rerender();
          const el = document.querySelector('#main [data-f="' + key + '"]');
          if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (err) { /* not a text field */ } }
        });
        ctx.on('change', 'select[data-key], input[type=checkbox][data-key]', (e, t) => { setF(t.dataset.key, t.type === 'checkbox' ? t.checked : t.value); ctx.rerender(); });
        ctx.on('click', '[data-reset]', () => { delete st.form[p.id]; ctx.rerender(); toast('Changes discarded.'); });
        ctx.on('click', '[data-copy]', () => { const text = root.querySelector('.pf-yaml').textContent; (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'))).then(() => toast('Copied the saved version.', 'ok'), () => toast('The browser did not allow copying.', 'warn')); });

        ctx.on('click', '[data-save]', () => {
          let body; let before;
          try { body = bodyOf(f); before = bodyOf(formOf(p)); } catch (err) { toast(esc(err.message), 'danger'); return; }
          const LBL = { displayName: 'Display name', description: 'Description', modelId: 'Model', poolId: 'Pool', numCtx: 'num_ctx', temperature: 'temperature', label: 'Max label', thinkDefault: 'Thinking default', thinkCeiling: 'Thinking ceiling', systemPrompt: 'System prompt', fallback: 'Fallback', tools: 'Tools' };
          const show = (k, v) => { if (v == null || (Array.isArray(v) && !v.length)) return 'none'; if (k === 'modelId') return (modelById(v) || { name: v }).name; if (k === 'poolId') return poolName(v); if (k === 'fallback') return (byId(v.profileId) || { name: '?' }).name + ' after ' + v.afterQueueWaitMs / 1000 + ' s'; if (k === 'systemPrompt') return v.length > 60 ? v.slice(0, 60) + '…' : v; return Array.isArray(v) ? v.join(', ') : String(v); };
          const patch = {}; const kv = [];
          Object.keys(body).forEach((k) => { if (JSON.stringify(body[k]) !== JSON.stringify(before[k])) { patch[k] = body[k]; kv.push([LBL[k], esc(show(k, before[k])) + ' → <b>' + esc(show(k, body[k])) + '</b>']); } });
          if (!kv.length) { delete st.form[p.id]; ctx.rerender(); return; }
          ctx.modal({ title: 'Save ' + esc(p.name) + ' as version ' + (p.version + 1), body: UI.kv(kv, 1) + UI.field('Note for the version history', UI.input('', { attrs: 'data-note maxlength="300"', placeholder: 'what changed and why' }))
            + (p.status === 'published' ? UI.notice('This profile is published. The server runs the publishing checks on save and refuses a version that would fail them.', 'info') : '')
            + (patch.numCtx !== undefined ? UI.notice('A new num_ctx reloads the model on every instance that serves this profile.', 'warn') : ''),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save version', { kind: 'primary', attrs: 'data-ok' }),
          onMount(mEl) {
            mEl.querySelector('[data-ok]').addEventListener('click', async () => {
              const note = mEl.querySelector('[data-note]').value.trim();
              App.closeOverlay();
              const r = await act(() => App.patch('/api/admin/profiles/' + enc(p.id), Object.assign(patch, note ? { note } : {})), null, p.id);
              if (r) { delete st.form[p.id]; toast('<b>' + esc(p.name) + '</b> saved as version ' + r.version + '.', 'ok', 5000); }
            });
          } });
        });

        // ---- Evaluations tab ----
        ctx.on('click', '[data-tab]', (e, t) => { st.ptab = t.dataset.tab === 'evals' ? 'evals' : 'settings'; ctx.rerender(); });
        ctx.on('click', '[data-ereload]', () => { delete st.evals[p.id]; ctx.rerender(); });
        const evalAct = async (fn, okMsg) => {
          try { const r = await fn(); if (okMsg) toast(okMsg, 'ok', 5000); delete st.evals[p.id]; ctx.rerender(); return r || true; }
          catch (err) { App.fail(err); return null; }
        };
        const runEvals = (setId) => evalAct(() => App.post('/api/admin/profiles/' + enc(p.id) + '/evaluations/run', setId ? { setId } : {}), 'Evaluation queued for version ' + p.version + ' of <b>' + esc(p.name) + '</b>. Scores appear here when the run finishes.');
        ctx.on('click', '[data-erun]', () => runEvals(null));
        ctx.on('click', '[data-erunset]', (e, t) => runEvals(t.dataset.erunset));
        const CASE_TEMPLATE = JSON.stringify([{ id: 'greeting', prompt: 'Say hello to a new customer.', checks: [{ kind: 'contains', value: 'hello' }] }, { id: 'format', prompt: 'Give the total as JSON with a number field "total".', checks: [{ kind: 'json-schema', schema: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } } }] }], null, 2);
        const setModal = (x2) => {
          const judges = (st.profiles || []).filter((y) => y.status === 'published' || y.aliasOf);
          const ev = st.evals[p.id] || {};
          ctx.modal({ title: x2 ? 'Edit eval set ' + esc(x2.name) : 'New eval set for ' + esc(p.name), cls: 'wide',
            body: '<div class="vstack gap12"><div class="formgrid" style="--cols:2">'
              + UI.field('Name', UI.input(x2 ? x2.name : '', { attrs: 'data-en maxlength="120"', placeholder: 'Regression' }))
              + UI.field('Threshold (share of cases that must pass)', UI.input(x2 ? String(x2.threshold) : '0.9', { attrs: 'data-et class="input mono" inputmode="decimal"' }).replace('class="input" ', ''), '0 to 1')
              + UI.field('Judge profile', UI.select([{ value: '', label: 'None (no rubric cases)' }].concat(judges.map((y) => ({ value: y.name, label: y.name + ', up to ' + y.label }))), x2 ? (x2.judgeProfile || '') : '', 'data-ej'), 'Scores rubric cases through the gateway; it must handle this set\'s label')
              + UI.field('Description', UI.input(x2 ? (x2.description || '') : '', { attrs: 'data-ed maxlength="500"', placeholder: 'What these cases protect' }))
              + '</div>'
              + UI.check('Gate publishing on this set', x2 ? x2.gate : true, 'data-eg')
              + UI.field('Cases (JSON)', UI.textarea(x2 ? JSON.stringify(x2.cases, null, 2) : CASE_TEMPLATE, { attrs: 'data-ec spellcheck="false" class="textarea mono"', rows: 12 }).replace('class="textarea" ', ''), 'Each case: an id, a prompt and checks. Check kinds: contains, not-contains (value), regex (pattern, RE2), json-schema (schema), judge (rubric, minScore).')
              + (x2 ? UI.notice('Changing the cases, threshold or judge starts a new revision: earlier runs no longer open the publish gate.', 'info') : (ev.sets && ev.sets.length ? '' : UI.notice('Sets gate publishing by default: once this set exists, publishing needs a passing run for the saved settings.', 'info')))
              + '<div data-eerr></div></div>',
            actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(x2 ? 'Save set' : 'Create set', { kind: 'primary', attrs: 'data-eok' }),
            onMount(mEl) {
              mEl.querySelector('[data-eok]').addEventListener('click', async () => {
                const val = (sel) => mEl.querySelector(sel).value.trim();
                const err = (msg) => { mEl.querySelector('[data-eerr]').innerHTML = UI.notice(esc(msg), 'danger'); };
                let cases;
                try { cases = JSON.parse(val('[data-ec]')); } catch (e2) { err('The cases are not valid JSON: ' + e2.message); return; }
                const threshold = Number(val('[data-et]'));
                if (!(threshold >= 0 && threshold <= 1)) { err('The threshold is a number from 0 to 1.'); return; }
                const body = { name: val('[data-en]'), threshold, gate: mEl.querySelector('[data-eg]').checked, judgeProfile: val('[data-ej]') || null, description: val('[data-ed]') || null, cases };
                try {
                  if (x2) await App.patch('/api/admin/profiles/' + enc(p.id) + '/eval-sets/' + enc(x2.id), body);
                  else await App.post('/api/admin/profiles/' + enc(p.id) + '/eval-sets', body);
                  App.closeOverlay(); delete st.evals[p.id];
                  toast('Eval set <b>' + esc(body.name) + '</b> ' + (x2 ? 'saved.' : 'created.') + ' Run it to score the saved settings.', 'ok', 5000);
                  ctx.rerender();
                } catch (e3) { err(e3.message); }
              });
            } });
        };
        ctx.on('click', '[data-enew]', () => setModal(null));
        ctx.on('click', '[data-eedit]', (e, t) => { const x2 = ((st.evals[p.id] || {}).sets || []).find((y) => y.id === t.dataset.eedit); if (x2) setModal(x2); });
        ctx.on('click', '[data-edel]', async (e, t) => {
          const x2 = ((st.evals[p.id] || {}).sets || []).find((y) => y.id === t.dataset.edel); if (!x2) return;
          const ok = await ctx.confirm({ title: 'Delete eval set ' + x2.name + '?', tag: 'cannot be undone', tone: 'danger', body: '<p style="margin:0" class="fg2">Its runs and scores are deleted with it' + (x2.gate ? ', and it no longer gates publishing' : '') + '.</p>', ok: 'Delete set' });
          if (ok) evalAct(() => App.del('/api/admin/profiles/' + enc(p.id) + '/eval-sets/' + enc(x2.id)), 'Eval set ' + esc(x2.name) + ' deleted. Audit entry written.');
        });
        ctx.on('click', '[data-eoverride]', () => {
          ctx.modal({ title: 'Request an override for ' + esc(p.name),
            body: '<div class="vstack gap12"><p class="fg2" style="margin:0">Lets version ' + p.version + '\'s settings be published although its evaluations did not pass. Another profile admin approves or rejects it.</p>' + UI.field('Reason', UI.textarea('', { attrs: 'data-or maxlength="500"', placeholder: 'Why this cannot wait for passing evaluations', rows: 3 })) + '<div data-oerr></div></div>',
            actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Request override', { kind: 'primary', attrs: 'data-ook' }),
            onMount(mEl) {
              mEl.querySelector('[data-ook]').addEventListener('click', async () => {
                const reason = mEl.querySelector('[data-or]').value.trim();
                if (reason.length < 10) { mEl.querySelector('[data-oerr]').innerHTML = UI.notice('Give a reason of at least ten characters.', 'danger'); return; }
                App.closeOverlay();
                await evalAct(() => App.post('/api/admin/profiles/' + enc(p.id) + '/evaluations/overrides', { reason }), 'Override requested. Another profile admin decides on it.');
              });
            } });
        });
        ctx.on('click', '[data-edecide]', async (e, t) => {
          const approve = t.dataset.edecide === 'approve';
          const ok = await ctx.confirm({ title: (approve ? 'Approve' : 'Reject') + ' this override?', tag: 'dual control', tone: approve ? 'warn' : 'info', body: '<p style="margin:0" class="fg2">' + (approve ? 'The settings of the requested version can then be published without passing evaluations.' : 'Publishing stays refused until the evaluations pass.') + '</p>', ok: approve ? 'Approve override' : 'Reject override' });
          if (ok) evalAct(() => App.post('/api/admin/profiles/' + enc(p.id) + '/evaluations/overrides/' + enc(t.dataset.oid) + '/decide', { decision: approve ? 'approve' : 'reject' }), 'Override ' + (approve ? 'approved' : 'rejected') + '. Audit entry written.');
        });
        ctx.on('click', '[data-erundetail]', async (e, t) => {
          let r;
          try { r = await App.get('/api/admin/profiles/' + enc(p.id) + '/evaluations/runs/' + enc(t.dataset.erundetail)); } catch (err) { App.fail(err); return; }
          const rows = (r.results || []).map((c) => [esc(c.name || c.caseId), c.passed ? UI.pill('passed', 'ok') : UI.pill('failed', 'danger'), c.checks.map((k) => esc(k.kind) + ' ' + (k.passed ? 'passed' : 'failed' + (k.detail ? ': ' + esc(k.detail) : ''))).join('<br>'), '<div class="pf-out">' + esc(c.output) + '</div>']);
          ctx.modal({ title: 'Run of ' + esc(r.set || 'eval set') + ', version ' + r.profileVersion, cls: 'wide',
            body: UI.kv([['Result', UI.pill(r.state, RUN_KIND[r.state])], ['Score', pct(r.score) + (r.total != null ? ' (' + r.passed + ' of ' + r.total + ')' : '')], ['Threshold', pct(r.threshold)], ['Set revision', String(r.setRevision)]], 4)
              + (r.error ? UI.notice(esc(r.error), 'danger') : '')
              + UI.table(['Case', 'Result', 'Checks', 'Answer'], rows, { clickable: false, minWidth: '0', emptyTitle: 'No cases ran', emptyText: '' }),
            actions: UI.btn('Close', { attrs: 'data-close' }) });
        });

        ctx.on('click', '[data-status]', async (e, t) => {
          const to = t.dataset.status;
          const copy = {
            published: { title: 'Publish ' + p.name + '?', tag: 'users can pick it', tone: 'info', text: 'Users with clearance for ' + p.label + ' can pick it in chat. The server checks the model, its placement and the label first.', ok: 'Publish', done: 'published. Users can pick it in chat.' },
            disabled: { title: 'Disable ' + p.name + '?', tag: 'stops new turns', tone: 'danger', text: 'Users can no longer pick it, and aliases pointing at it stop resolving. It can be published again later.', ok: 'Disable', done: 'disabled.' },
            draft: { title: 'Move ' + p.name + ' back to draft?', tag: 'hidden from users', tone: 'warn', text: 'Users can no longer pick it until it is published again.', ok: 'Back to draft', done: 'moved back to draft.' }
          }[to];
          const kv = to === 'published' ? checks.map((c) => [c.ok ? 'passes' : 'fails', esc(c.text)]) : undefined;
          const ok = await ctx.confirm({ title: copy.title, tag: copy.tag, tone: copy.tone, body: '<p style="margin:0" class="fg2">' + esc(copy.text) + '</p>', kv, ok: copy.ok });
          if (!ok) return;
          await act(() => App.post('/api/admin/profiles/' + enc(p.id) + '/publish', { status: to }), '<b>' + esc(p.name) + '</b> ' + copy.done, p.id);
        });

        const canaryModal = () => {
          const opts = (models || []).filter((x) => x.state === 'approved' && x.id !== p.modelId);
          if (!models) { toast('Starting a canary needs the model catalogue (models:read).', 'warn'); return; }
          const where = (x) => (x.pools || []).filter((y) => !p.poolId || y.poolId === p.poolId).map((y) => y.pool).join(', ');
          ctx.modal({ title: (p.canary ? 'Change canary on ' : 'Start canary on ') + esc(p.name),
            body: (opts.length ? UI.field('Canary model', UI.select(opts.map((x) => ({ value: x.id, label: x.name + ', ' + x.label + (where(x) ? ', on ' + where(x) : ', not placed where this profile routes') })), p.canary ? p.canary.modelId : opts[0].id, 'data-cm'), 'Approved models only. It must be approved for ' + esc(p.label) + ' data and placed where this profile routes.')
              + UI.field('Share of requests', '<div class="hstack gap6">' + UI.input(String(p.canary ? p.canary.percent : 10), { type: 'number', attrs: 'data-cp min="1" max="50" class="input mono" style="width:90px"' }).replace('class="input" ', '') + '<span class="muted">% (1 to 50)</span></div>')
              + UI.notice('The rest stays on ' + esc(p.model ? p.model.name : '') + '. Promote to move all traffic, or stop to send everything back.', 'info') : UI.notice('No other approved model exists. Approve one in Models first.', 'warn')),
            actions: UI.btn('Cancel', { attrs: 'data-close' }) + (opts.length ? UI.btn(p.canary ? 'Change canary' : 'Start canary', { kind: 'primary', attrs: 'data-ok' }) : ''),
            onMount(mEl) {
              const b = mEl.querySelector('[data-ok]'); if (!b) return;
              b.addEventListener('click', async () => {
                const modelId = mEl.querySelector('[data-cm]').value; const percent = Number(mEl.querySelector('[data-cp]').value);
                if (!(percent >= 1 && percent <= 50 && Math.round(percent) === percent)) { toast('The share must be a whole number from 1 to 50.', 'danger'); return; }
                App.closeOverlay();
                await act(() => App.api('PUT', '/api/admin/profiles/' + enc(p.id) + '/canary', { modelId, percent }), 'Canary on <b>' + esc(p.name) + '</b>: ' + percent + '% of requests go to ' + esc((modelById(modelId) || {}).name || '') + '.', p.id);
              });
            } });
        };
        ctx.on('click', '[data-canary]', canaryModal);
        ctx.on('click', '[data-promote]', async () => {
          const ok = await ctx.confirm({ title: 'Promote canary on ' + p.name + '?', tag: 'all traffic', tone: 'info', body: '<p style="margin:0" class="fg2">' + esc(p.canaryModel || '') + ' becomes the profile\'s model for 100% of requests. The previous version stays in the history, so a rollback is one step.</p>', kv: [['Stable now', esc(p.model ? p.model.name : '')], ['Canary', esc((p.canaryModel || '') + ' at ' + p.canary.percent + '%')]], ok: 'Promote' });
          if (!ok) return;
          await act(() => App.post('/api/admin/profiles/' + enc(p.id) + '/canary/promote'), '<b>' + esc(p.name) + '</b> now serves 100% on ' + esc(p.canaryModel || '') + '.', p.id);
        });
        ctx.on('click', '[data-stopcanary]', async () => {
          const ok = await ctx.confirm({ title: 'Stop canary on ' + p.name + '?', tag: 'rollback', tone: 'warn', body: '<p style="margin:0" class="fg2">All requests go back to ' + esc(p.model ? p.model.name : '') + ' on the next turn.</p>', ok: 'Stop canary' });
          if (!ok) return;
          await act(() => App.del('/api/admin/profiles/' + enc(p.id) + '/canary'), 'Canary stopped. 100% on ' + esc(p.model ? p.model.name : '') + '.', p.id);
        });
      }

      // ---- new profile or alias ----
      function newModal(kind) {
        const approved = (models || []).filter((x) => x.state === 'approved');
        const pools = poolChoices();
        const draw = (k) => '<div class="formgrid" style="--cols:2">'
          + UI.field('Kind', UI.select([{ value: 'profile', label: 'Profile, pins a model' }, { value: 'alias', label: 'Alias, points at a profile' }], k, 'data-nk'))
          + UI.field('Name', UI.input('', { placeholder: k === 'alias' ? 'chat-default' : 'summariser-8b', attrs: 'data-nn maxlength="63" autocomplete="off"' }), 'Lower case, digits and hyphens; clients ask for it by this name')
          + UI.field('Display name', UI.input('', { placeholder: k === 'alias' ? 'Default chat' : 'Summariser', attrs: 'data-nd maxlength="200"' }))
          + (k === 'alias'
            ? UI.field('Points to', UI.select(reals.map((x) => ({ value: x.id, label: x.name + ', ' + x.status })), reals[0] ? reals[0].id : '', 'data-na'))
            : UI.field('Model', UI.select([{ value: '', label: approved.length ? 'Choose later' : 'No approved models yet' }].concat(approved.map((x) => ({ value: x.id, label: x.name + ', ' + x.label }))), approved[0] ? approved[0].id : '', 'data-nm'))
              + UI.field('Pool', UI.select([{ value: '', label: 'Any pool the model is placed on' }].concat(pools.map((x) => ({ value: x.id, label: x.name + (x.ceiling ? ', ceiling ' + x.ceiling : '') }))), '', 'data-np'))
              + UI.field('Max label', UI.select(myLabels, myLabels.indexOf('internal') >= 0 ? 'internal' : myLabels[myLabels.length - 1], 'data-nl'))
              + UI.field('Description', UI.input('', { placeholder: 'What this profile is for', attrs: 'data-nds maxlength="500"' })))
          + '</div>'
          + (k === 'alias' ? UI.notice('An alias is published as soon as it is created and resolves to whatever it points at. Repoint it later without client changes.', 'info') + (reals.length ? '' : UI.notice('Create a profile first; an alias points at one.', 'warn'))
            : UI.notice('Only approved models are offered. The profile starts as a draft: set its options, then publish it for users.', 'info'))
          + '<div data-nerr></div><div class="mfoot">' + UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(k === 'alias' ? 'Create alias' : 'Create draft', { kind: 'primary', attrs: 'data-create', disabled: k === 'alias' && !reals.length }) + '</div>';
        ctx.modal({ title: 'New model profile', body: '<div class="vstack gap12" data-nbody>' + draw(kind) + '</div>', onMount(mEl) {
          const host = mEl.querySelector('[data-nbody]');
          const wire = () => {
            host.querySelector('[data-nk]').addEventListener('change', (e) => { host.innerHTML = draw(e.target.value); wire(); });
            host.querySelector('[data-create]').addEventListener('click', async () => {
              const k = host.querySelector('[data-nk]').value; const val = (sel) => { const el = host.querySelector(sel); return el ? el.value.trim() : ''; };
              const name = val('[data-nn]'); const body = { name, displayName: val('[data-nd]') || name };
              if (k === 'alias') body.aliasOf = val('[data-na]');
              else { if (val('[data-nm]')) body.modelId = val('[data-nm]'); if (val('[data-np]')) body.poolId = val('[data-np]'); body.label = val('[data-nl]'); if (val('[data-nds]')) body.description = val('[data-nds]'); }
              try {
                const created = await App.post('/api/admin/profiles', body);
                App.closeOverlay(); st.sel = created.id; st.conflict = null;
                toast(k === 'alias' ? 'Alias <b>' + esc(created.name) + '</b> created and published.' : 'Draft profile <b>' + esc(created.name) + '</b> created. Set its options, then publish it.', 'ok', 5000);
                refresh();
              } catch (err) { const pr = err.problem || {}; host.querySelector('[data-nerr]').innerHTML = UI.notice('<b>' + esc(pr.title || 'Refused') + '.</b> ' + esc(err.message), 'danger'); }
            });
          };
          wire();
        } });
      }
      if (st.openNew) { const k = st.openNew; st.openNew = null; setTimeout(() => newModal(k === 'alias' ? 'alias' : 'profile'), 30); }
    }
  });
})();
