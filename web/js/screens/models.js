(function () {
  const { UI, esc } = App;

  const STEPS = ['draft', 'evaluated', 'approved', 'deprecated', 'retired'];
  const CAPS = ['chat', 'tools', 'thinking', 'vision', 'embedding'];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const TERMINAL = { succeeded: 1, failed: 1, cancelled: 1 };
  const capName = (c) => (c === 'completion' ? 'chat' : c);
  const capsOf = (m) => (m.capabilities || []).map(capName);
  const gb = (b) => (b ? (b / 1e9).toFixed(1) + ' GB' : '');
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const hex = (d) => String(d || '').replace(/^sha256:/, '');
  const shortDigest = (d) => { const h = hex(d); return h ? 'sha256:' + h.slice(0, 16) + '…' + h.slice(-4) : ''; };
  const isoDay = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const meId = () => (App.me && App.me.user ? App.me.user.id : null);
  const who = (id) => (!id ? '' : id === meId() ? 'you' : 'another administrator <span class="mono muted">' + esc(String(id).slice(-6)) + '</span>');

  // One job.progress listener for the whole screen; it removes itself once the screen is left.
  let jobSocket = null, jobHandler = null;
  const stopJobs = () => { if (jobSocket && jobHandler) jobSocket.off('job.progress', jobHandler); jobSocket = null; jobHandler = null; };

  function menu(ctx, host, items, cur, onPick) {
    ctx.$$('.dropdown').forEach((d) => d.remove());
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it) + '" class="' + (it === cur ? 'on' : '') + '">' + esc(it) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; d.remove(); onPick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function h(e) { if (!d.contains(e.target)) { d.remove(); document.removeEventListener('click', h); } }), 0);
  }

  App.register({
    id: 'models', title: 'Models', live: true,
    summary: 'Catalog, import requests, conformance evaluation, lifecycle approvals, placement', section: 'admin', crumb: ['Admin', 'Models'],
    commands: [{ label: 'Request model import', sub: 'Models', run(app) { app.stateFor('models').openRequest = {}; app.render(); } }],
    states: [
      { title: 'Pickle rejected', tone: 'danger', text: 'Import refused: the source is a pickle checkpoint. Only GGUF and safetensors are accepted.', apply(ctx) { ctx.state.openRequest = { name: 'consolidated-7b', source: 'https://huggingface.co/example/consolidated-7b/resolve/main/pytorch_model.bin' }; ctx.rerender(); } },
      { title: 'Digest mismatch', tone: 'danger', text: 'The pulled blob does not match the expected digest. The gateway deletes the blob and nothing is registered.', apply(ctx) {
        const failed = (ctx.state.models || []).filter((m) => m.importState === 'failed');
        const m = failed.find((x) => /digest/i.test(x.importError || '')) || failed[0];
        if (!m) { ctx.toast('No import has failed its digest check. Request an import with an expected digest that does not match the published one to see this state.', 'warn', 7000); return; }
        Object.assign(ctx.state, { selected: m.id, lifecycle: 'all', cap: 'all', query: '', showImportProblem: m.id }); ctx.rerender();
      } },
      { title: 'Licence missing', tone: 'warn', text: 'Approve is disabled until the licence is recorded.', apply(ctx) {
        const open = (ctx.state.models || []).filter((x) => !(x.license && x.license.name) && (x.state === 'draft' || x.state === 'evaluated'));
        const m = open.find((x) => x.state === 'evaluated') || open[0];
        if (!m) { ctx.toast('Every model in the catalogue has a licence recorded.', '', 5000); return; }
        Object.assign(ctx.state, { selected: m.id, lifecycle: 'all', cap: 'all', query: '' }); ctx.rerender();
      } },
      { title: 'Retired', tone: 'neutral', text: 'Retired models stay in the catalogue for audit and are removed from routing. Shown read-only.', apply(ctx) {
        const m = (ctx.state.models || []).find((x) => x.state === 'retired');
        Object.assign(ctx.state, { lifecycle: 'retired', cap: 'all', query: '' }); if (m) ctx.state.selected = m.id; ctx.rerender();
        if (!m) ctx.toast('No model is retired yet. Retire one from its inspector to see this state.', '', 5000);
      } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.query = st.query || ''; st.lifecycle = st.lifecycle || 'all'; st.cap = st.cap || 'all';
      st.reveal = st.reveal || {}; st.jobs = st.jobs || {};
      const canManage = App.can('models:manage'), canPools = App.can('pools:manage');
      // Toasts lay out as a flex row; one wrapping span keeps a message with markup on one flowing line.
      const say = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      if (ctx.params.model) { st.wantModel = ctx.params.model; delete ctx.params.model; }

      // Re-renders only while this screen is showing; with a dialog open it waits for the dialog to close.
      const refresh = () => {
        if (App.state.route !== 'models') return;
        if (document.getElementById('overlay')) { st.dirty = true; return; }
        const focused = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute('data-search');
        ctx.rerender();
        if (focused) { const i = document.querySelector('#main [data-search]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
      };
      const onClose = () => { if (st.dirty) { st.dirty = false; refresh(); } };

      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/admin/models'), canPools ? App.get('/api/admin/pools') : null])
          .then(([models, pools]) => {
            Object.assign(st, { models, pools: pools || [], loaded: true, loadError: null });
            if (st.wantModel) { const m = models.find((x) => x.id === st.wantModel || x.name === st.wantModel); if (m) st.selected = m.id; st.wantModel = null; }
            watchJobs();
          })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; refresh(); });
      };
      if (!st.loaded && !st.loadError) load();
      const reload = () => { st.loaded = false; st.loadError = null; ctx.rerender(); };
      const reloadModels = () => App.get('/api/admin/models').then((models) => { st.models = models; watchJobs(); refresh(); return models; }).catch((err) => { App.fail(err, 'Models could not be loaded'); return null; });
      const put = (m) => { const i = (st.models || []).findIndex((x) => x.id === m.id); if (i >= 0) st.models[i] = Object.assign({}, st.models[i], m); else (st.models = st.models || []).unshift(Object.assign({ pools: [], profiles: 0 }, m)); };
      const nameOf = (id) => ((st.models || []).find((m) => m.id === id) || { name: 'the model' }).name;

      // ---------- pull and evaluation jobs: socket events, with polling as the fallback ----------
      const finish = async (id, state, error) => {
        const j = st.jobs[id]; if (!j) return;
        delete st.jobs[id];
        st.jobErrors = st.jobErrors || {};
        if (state === 'failed' && error) st.jobErrors[j.modelId] = { kind: j.kind, error }; else delete st.jobErrors[j.modelId];
        const models = await reloadModels();
        const m = (models || []).find((x) => x.id === j.modelId) || { name: nameOf(j.modelId) };
        if (j.kind === 'pull') {
          if (state === 'succeeded') say('<b>' + esc(m.name) + '</b> pulled and verified' + (m.digest ? ' at <span class="mono">' + esc(shortDigest(m.digest)) + '</span>' : '') + '. Run the evaluation next.', 'ok', 6000);
          else say('<b>Pull of ' + esc(m.name) + ' ' + esc(state) + '.</b> ' + esc(m.importError || error || ''), 'danger', 9000);
        } else if (state === 'succeeded') {
          const ev = m.evaluation;
          say('<b>' + esc(m.name) + '</b> evaluated: ' + (ev ? esc(ev.passed + ' of ' + ev.total) + ' tests passed' : 'finished') + (ev && ev.toolsWithheld ? '. Tools are withheld.' : '.'), ev && ev.passed === ev.total ? 'ok' : 'warn', 6000);
        } else say('<b>Evaluation of ' + esc(m.name) + ' ' + esc(state) + '.</b> ' + esc(error || ''), 'danger', 9000);
      };
      const poll = () => {
        st.pollTimer = null;
        if (App.state.route !== 'models') { stopJobs(); return; }
        App.get('/api/me/jobs').then((list) => {
          Object.keys(st.jobs).forEach((id) => {
            const j = list.find((x) => x.id === id);
            if (!j) { delete st.jobs[id]; reloadModels(); return; }
            if (TERMINAL[j.state]) finish(id, j.state, j.error);
            else { st.jobs[id].state = j.state; st.jobs[id].progress = j.progress; st.jobs[id].message = j.message; }
          });
          if (!Object.keys(st.jobs).length && (st.models || []).some((m) => m.importState === 'pulling')) reloadModels();
          refresh(); watchJobs();
        }).catch(() => watchJobs());
      };
      function watchJobs() {
        const pending = Object.keys(st.jobs).length || (st.models || []).some((m) => m.importState === 'pulling');
        if (!pending) { stopJobs(); st.polls = 0; return; }
        if (App.socket && (jobSocket !== App.socket || !jobHandler)) {
          stopJobs();
          jobSocket = App.socket;
          jobHandler = (e) => {
            if (App.state.route !== 'models') { stopJobs(); return; }
            const j = st.jobs[e.id]; if (!j) return;
            if (TERMINAL[e.state]) { if (e.state === 'failed') App.get('/api/me/jobs').then((l) => { const x = l.find((r) => r.id === e.id); finish(e.id, 'failed', x && x.error); }).catch(() => finish(e.id, 'failed', '')); else finish(e.id, e.state, ''); return; }
            j.state = e.state; j.progress = e.progress; j.message = e.message; refresh();
          };
          jobSocket.on('job.progress', jobHandler);
        }
        if (!st.pollTimer && (st.polls || 0) < 30) { st.polls = (st.polls || 0) + 1; st.pollTimer = setTimeout(poll, Math.min(2000 * st.polls, 8000)); }
      }
      const track = (jobId, modelId, kind) => { if (!jobId) return; st.jobs[jobId] = { modelId, kind, state: 'queued', progress: 0, message: kind === 'pull' ? 'Queued' : 'Queued for the conformance run' }; st.polls = 0; if (st.pollTimer) { clearTimeout(st.pollTimer); st.pollTimer = null; } watchJobs(); };
      const jobFor = (modelId) => { const id = Object.keys(st.jobs).find((k) => st.jobs[k].modelId === modelId); return id ? st.jobs[id] : null; };

      // ---------- data for this render ----------
      const all = st.models || [];
      const q = st.query.toLowerCase();
      const rows = all.filter((m) => (!q || [m.name, m.family, m.parameterSize, m.source, capsOf(m).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0)
        && (st.lifecycle === 'all' || m.state === st.lifecycle) && (st.cap === 'all' || capsOf(m).indexOf(st.cap) >= 0));
      const sel = all.find((m) => m.id === st.selected) || rows[0] || all[0] || null;
      if (sel) st.selected = sel.id;

      const lcPill = (m) => { const j = jobFor(m.id); if (j) return UI.pill((j.kind === 'pull' ? 'pulling ' : 'evaluating ') + (j.progress || 0) + '%', 'info'); if (m.importState === 'failed') return UI.pill('import failed', 'danger'); if (m.importState === 'pulling') return UI.pill('pulling', 'info'); return UI.pill(m.state); };

      let problem = '';
      if (sel && st.showImportProblem === sel.id && sel.importState === 'failed') {
        const digest = /digest/i.test(sel.importError || '');
        problem = '<div class="vstack gap6">' + UI.problem(digest ? 'Digest mismatch' : 'Import refused', (sel.importError || 'The pull failed.') + ' Model: ' + sel.name + '.', false)
          + '<div class="hstack gap6">' + UI.btn('Dismiss', { size: 'sm', attrs: 'data-dismiss' }) + '</div></div>';
      }

      let inspector = '';
      if (sel) {
        const lc = sel.state, readOnly = lc === 'retired';
        const job = jobFor(sel.id);
        const licence = sel.license && sel.license.name ? sel.license : null;
        const mine = sel.requestedBy && sel.requestedBy === meId();
        const ev = sel.evaluation;
        const stepper = '<div class="md-steps">' + STEPS.map((s, i) => '<span class="' + (s === lc ? 'cur' : STEPS.indexOf(lc) > i ? 'done' : '') + '">' + s + '</span>' + (i < STEPS.length - 1 ? '<span class="sep">›</span>' : '')).join('') + '</div>';
        const digest = !sel.digest ? '<span class="muted">not pulled yet</span>'
          : st.reveal[sel.id] ? '<span class="mono fg2" style="overflow-wrap:anywhere">sha256:' + esc(hex(sel.digest)) + '</span> <a href="#" data-reveal style="font-size:12px">hide</a>'
          : '<span class="mono fg2">' + esc(shortDigest(sel.digest)) + '</span> <a href="#" data-reveal style="font-size:12px">reveal</a>';
        const importCell = job ? UI.pill(job.kind === 'pull' ? 'pulling' : 'pulled', 'info') : sel.importState === 'failed' ? UI.pill('failed', 'danger') : sel.importState === 'pulled' ? UI.pill('pulled and verified', 'ok') : sel.importState === 'pulling' ? UI.pill('pulling', 'info') : UI.pill('not pulled', 'outline');
        const kv = [
          ['Digest', digest],
          ['Expected digest', sel.expectedDigest ? '<span class="mono fg2">' + esc(shortDigest(sel.expectedDigest)) + '</span>' : '<span class="muted">none given</span>'],
          ['Import', importCell],
          ['Format', sel.format ? esc([sel.format, sel.quantization].filter(Boolean).join(', ')) : '<span class="muted">known after the pull</span>'],
          ['Size on disk', sel.sizeBytes ? esc(gb(sel.sizeBytes)) : '<span class="muted">known after the pull</span>'],
          ['Context length', sel.contextLength ? esc(Number(sel.contextLength).toLocaleString()) : '<span class="muted">known after the pull</span>'],
          ['Capabilities', capsOf(sel).length ? esc(capsOf(sel).join(', ')) + (ev && ev.toolsWithheld ? ' <span style="color:var(--warn-fg)">(tools withheld)</span>' : '') : '<span class="muted">known after the pull</span>'],
          ['Source', esc(sel.source || '')],
          ['Licence', licence ? (licence.url ? '<a href="' + esc(licence.url) + '" target="_blank" rel="noopener noreferrer">' + esc(licence.name) + '</a>' : esc(licence.name)) + (licence.recordedBy ? ' <span class="muted" style="font-size:12px">recorded by ' + esc(licence.recordedBy) + (licence.recordedAt ? ', ' + esc(day(licence.recordedAt)) : '') + '</span>' : '')
            : '<span style="color:var(--warn-fg)">not recorded</span>' + (canManage && !readOnly ? ' ' + UI.btn('Record licence', { size: 'xs', attrs: 'data-licence' }) : '')],
          ['Tool-calling conformance', !ev ? '<span class="fg2">not run</span>' : !ev.tests.some((t) => t.name === 'Tool calling') ? '<span class="fg2">not applicable, no tools capability</span>' : ev.toolsWithheld ? UI.pill('failed, tools withheld', 'warn') : UI.pill('passed', 'ok')],
          ['Placed on pools', (sel.pools || []).length ? sel.pools.map((p) => '<span class="md-pl"><a href="#" data-go="pools">' + esc(p.pool || p.poolId) + '</a> <span class="muted">' + esc(p.residency) + '</span>' + (canPools && !readOnly ? ' ' + UI.iconbtn('x', 'Remove from ' + (p.pool || 'pool'), { attrs: 'data-unplace="' + esc(p.placementId) + '"', cls: 'sm ghost', size: 13 }) : '') + '</span>').join('') : '<span class="fg2">none</span>'],
          ['Used by profiles', sel.profiles ? '<a href="#" data-go="profiles">' + esc(sel.profiles) + (sel.profiles === 1 ? ' profile' : ' profiles') + '</a>' : '<span class="fg2">none</span>'],
          ['Requested by', who(sel.requestedBy) + (sel.createdAt ? ', ' + esc(day(sel.createdAt)) : '')],
          ['Approved by', sel.approvedBy ? who(sel.approvedBy) + ', ' + esc(day(sel.approvedAt)) : '<span class="fg2">not approved</span>']
        ];
        if (sel.retireAt) kv.push(['Retires on', esc(day(sel.retireAt))]);
        if (sel.notes) kv.push(['Notes', esc(sel.notes)]);

        const notices = [];
        if (job) notices.push(UI.meter(job.kind === 'pull' ? 'Pulling onto the pool' : 'Conformance run', esc(job.message || job.state), job.progress || 0, 'accent'));
        if (readOnly) notices.push(UI.notice('Retired' + (sel.updatedAt ? ' on ' + esc(day(sel.updatedAt)) : '') + '. The model stays in the catalogue for audit and is removed from routing. Fields are read-only.', 'info'));
        else {
          const jobErr = !job && (st.jobErrors || {})[sel.id];
          if (sel.importState === 'failed' && !job) notices.push(UI.notice('<b>Import failed.</b> ' + esc(sel.importError || ''), 'danger'));
          else if (jobErr && !(jobErr.kind === 'pull' && sel.importState === 'pulled')) notices.push(UI.notice('<b>' + (jobErr.kind === 'pull' ? 'The last pull failed.' : 'The last evaluation failed.') + '</b> ' + esc(jobErr.error), 'danger'));
          if ((lc === 'draft' || lc === 'evaluated') && !licence) notices.push(UI.notice('Approve is disabled until the licence is recorded' + (lc === 'draft' ? ' and the evaluation passes' : '') + '.', 'warn', canManage ? UI.btn('Record licence', { size: 'sm', attrs: 'data-licence' }) : ''));
          if (lc === 'evaluated' && mine) notices.push(UI.notice('You requested this import. Dual control: someone other than the requester must approve it.', 'info'));
          if (ev && ev.toolsWithheld && (lc === 'evaluated' || lc === 'approved')) notices.push(UI.notice('Tool calling failed the conformance test, so the tools capability is withheld from profiles. ' + (lc === 'approved' ? 'Approved for chat only.' : 'Approval is still possible for chat only.'), 'warn'));
          if (lc === 'draft' && ev && !ev.tests.some((t) => t.name === 'Chat smoke test' && t.ok)) notices.push(UI.notice('The chat smoke test failed, so the model stays a draft. Fix the cause and run the evaluation again.', 'danger'));
          if (lc === 'deprecated') notices.push(UI.notice('Deprecated. New profiles cannot pick it; profiles that already use it keep routing' + (sel.retireAt ? ' until ' + esc(day(sel.retireAt)) : ' until it is retired') + '.', 'warn'));
        }
        const evalHtml = ev ? '<div class="eyebrow">Conformance, ' + esc(ev.passed + ' of ' + ev.total) + ' passed</div><div class="muted" style="font-size:12px">On ' + esc(ev.instance) + ', ' + esc(when(ev.at)) + '</div>'
          + UI.timeline(ev.tests.map((t) => ({ title: esc(t.name), text: esc(t.detail || ''), meta: t.ok ? 'passed' : 'failed', tone: t.ok ? 'ok' : 'danger' }))) : '';

        let actions = '';
        const busy = !!job;
        const approveTitle = lc === 'draft' ? 'Run the evaluation first' : !licence ? 'Licence not recorded' : mine ? 'Someone other than the requester must approve' : '';
        if (canManage && !readOnly) {
          if (lc === 'draft' || lc === 'evaluated') actions += UI.btn('Approve', { kind: 'primary', attrs: 'data-approve', disabled: !!approveTitle || busy, title: approveTitle });
          if (lc === 'approved') actions += UI.btn('Deprecate', { attrs: 'data-deprecate', disabled: busy });
          if (lc === 'deprecated') actions += UI.btn('Retire', { kind: 'danger', attrs: 'data-retire', disabled: busy });
          if (lc !== 'deprecated') actions += UI.btn(ev ? 'Evaluate again' : 'Evaluate', { attrs: 'data-evaluate', disabled: busy || sel.importState !== 'pulled', title: sel.importState !== 'pulled' ? 'Pull the model onto a pool first' : '' });
          if ((sel.pools || []).length) actions += UI.btn(sel.importState === 'pulled' ? 'Pull again' : 'Pull', { attrs: 'data-pull', disabled: busy });
          actions += UI.btn('Edit', { kind: 'ghost', icon: 'edit', attrs: 'data-edit' });
          if (lc === 'draft' || lc === 'evaluated') actions += UI.btn('Retire', { kind: 'ghost', attrs: 'data-retire', disabled: busy });
        }
        if (canPools && !readOnly) actions += UI.btn('Place on pool', { attrs: 'data-place', icon: 'pools' });
        actions += UI.btn('Model card', { kind: 'ghost', attrs: 'data-card' });

        inspector = '<aside class="inspector w360"><div class="hstack"><div class="md-name grow">' + esc(sel.name) + '</div>' + UI.label(sel.label, { sm: true }) + '</div>' + stepper + UI.kv(kv, 1) + notices.join('') + evalHtml + '<div class="hstack wrap gap6">' + actions + '</div></aside>';
      }

      let body;
      if (st.loadError) body = UI.problem('Models could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-reload' }) + '</div>';
      else if (!st.loaded && !st.models) body = UI.notice('Loading…', 'info');
      else body = '<div class="toolbar">' + UI.search('Filter models', 'data-search', st.query)
          + '<span class="relative">' + UI.btn('Lifecycle: ' + st.lifecycle, { attrs: 'data-menu="lifecycle"', cls: st.lifecycle !== 'all' ? 'active' : '' }) + '</span>'
          + '<span class="relative">' + UI.btn('Capability: ' + st.cap, { attrs: 'data-menu="cap"', cls: st.cap !== 'all' ? 'active' : '' }) + '</span>'
          + '<span class="muted right" style="font-size:12px">' + rows.length + ' of ' + all.length + ' models</span></div>'
        + UI.table(['Model', 'Family', 'Size', 'Capabilities', 'Max label', 'Lifecycle'], rows.map((m) => ({
          cells: ['<span class="mono">' + esc(m.name) + '</span>', esc(m.family || ''), esc([m.parameterSize, gb(m.sizeBytes)].filter(Boolean).join(', ')), esc(capsOf(m).join(', ')), UI.label(m.label, { sm: true }), lcPill(m)],
          selected: sel && m.id === sel.id, attrs: 'data-id="' + esc(m.id) + '"'
        })), all.length ? { emptyTitle: 'No models match', emptyText: 'Clear the filters or request an import.' } : { emptyTitle: 'The catalogue is empty', emptyText: 'Request an import to pull a model from the Ollama library onto a pool.' });

      root.innerHTML = '<style>'
        + '.md-steps{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}.md-steps span{color:var(--muted);font-weight:500}.md-steps .cur{color:var(--fg);font-weight:700}.md-steps .done{color:var(--fg2)}.md-steps .sep{color:var(--faint)}'
        + '.md-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}'
        + '.md-pl{display:inline-flex;align-items:center;gap:4px;margin-right:8px}'
        + '</style>'
        + '<div class="page">'
        + UI.pagehead('Model catalog', 'Weights enter only through the import path: GGUF or safetensors, verified by digest, approved by a second person',
          UI.iconbtn('refresh', 'Refresh', { attrs: 'data-reload', cls: 'sm ghost' }) + (canManage ? UI.btn('Request import', { kind: 'primary', attrs: 'data-request' }) : ''))
        + problem + body
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div>' + inspector;

      // ---------- handlers ----------
      ctx.on('click', 'tr.row', (e, t) => { if (!t.dataset.id) return; st.selected = t.dataset.id; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', '[data-menu]', (e, t) => {
        e.stopPropagation();
        if (t.dataset.menu === 'lifecycle') menu(ctx, t.parentElement, ['all'].concat(STEPS), st.lifecycle, (v) => { st.lifecycle = v; ctx.rerender(); });
        else menu(ctx, t.parentElement, ['all'].concat(CAPS), st.cap, (v) => { st.cap = v; ctx.rerender(); });
      });
      ctx.on('click', '[data-reveal]', (e) => { e.preventDefault(); st.reveal[sel.id] = !st.reveal[sel.id]; ctx.rerender(); });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-dismiss]', () => { st.showImportProblem = null; ctx.rerender(); });
      ctx.on('click', '[data-reload]', () => reload());
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));

      // A form dialog that stays open when the server refuses, so nothing typed is lost.
      const formModal = (opts) => ctx.modal({
        title: opts.title, cls: opts.cls || '', onClose,
        body: opts.body + '<div data-err></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(opts.ok, { kind: opts.kind || 'primary', attrs: 'data-ok' }),
        onMount(m) {
          if (opts.onMount) opts.onMount(m);
          const btn = m.querySelector('[data-ok]');
          btn.addEventListener('click', async () => {
            const err = m.querySelector('[data-err]'); err.innerHTML = '';
            let payload;
            try { payload = opts.read(m); } catch (x) { err.innerHTML = UI.notice(esc(x.message), 'danger'); return; }
            btn.disabled = true;
            try { const r = await opts.submit(payload); App.closeOverlay(); opts.done(r, payload); }
            catch (x) {
              btn.disabled = false;
              if (opts.refused && opts.refused(x, err)) return;
              const p = x.problem || {};
              err.innerHTML = UI.problem(p.title || 'Request failed', p.detail || x.message, p.trace_id);
            }
          });
        }
      });
      // Pools with instances first: a pull onto a pool without any fails.
      const poolOptions = (model) => (st.pools || []).slice().sort((x, y) => ((y.instances || []).length ? 1 : 0) - ((x.instances || []).length ? 1 : 0))
        .map((p) => { const n = (p.instances || []).length; return { value: p.id, label: p.name + ' (' + p.accelerator + ', ceiling ' + p.label_ceiling + ', ' + (n ? n + ' instance' + (n === 1 ? '' : 's') : 'no instances') + ')', ok: !model || LABELS.indexOf(model.label) <= LABELS.indexOf(p.label_ceiling) }; });

      // ----- import request -----
      const requestModal = (prefill) => {
        prefill = prefill || {};
        const pools = canPools ? [{ value: '', label: 'None yet, record the request only' }].concat(poolOptions(null)) : [];
        formModal({
          title: 'Request model import', cls: 'wide', ok: 'Send request',
          body: '<div class="formgrid" style="--cols:2">'
            + UI.field('Model and tag', UI.input(prefill.name || '', { placeholder: 'llama3.1:8b or hf.co/org/repo:Q4_K_M', attrs: 'data-f="name"' }), 'The name Ollama pulls')
            + UI.field('Source', UI.input(prefill.source || 'Ollama library', { attrs: 'data-f="source"' }), 'Where the weights come from, for the record')
            + UI.field('Expected digest', UI.input('', { placeholder: 'sha256:… (optional)', attrs: 'data-f="digest"' }), 'The pull fails and the blob is deleted if it does not match')
            + UI.field('Requested max label', UI.select(LABELS, 'internal', 'data-f="label"'))
            + UI.field('Licence', UI.input('', { placeholder: 'Apache 2.0 (optional now, required before approval)', attrs: 'data-f="licence"' }))
            + UI.field('Licence URL', UI.input('', { placeholder: 'https://… (optional)', attrs: 'data-f="licenceUrl"' }))
            + (canPools ? UI.field('Pull onto pool', UI.select(pools, '', 'data-f="pool"'), 'Placed warm and pulled right away') : '')
            + '<div class="span2">' + UI.field('Why this model', UI.textarea('', { placeholder: 'Which workload it serves and what the current model lacks', rows: 3, attrs: 'data-f="notes"' })) + '</div></div>'
            + UI.notice('Pickle checkpoints (.bin, .pt, .pth, .pkl, .ckpt) are refused; only GGUF and safetensors are accepted. The model appears here as a draft; it is evaluated, its licence recorded, and a second administrator approves it before profiles can use it.', 'info'),
          read(m) {
            const v = (k) => { const el = m.querySelector('[data-f="' + k + '"]'); return el ? el.value.trim() : ''; };
            if (!v('name')) throw new Error('Enter the model and tag.');
            const body = { name: v('name'), source: v('source') || 'Ollama library', label: v('label') };
            if (v('digest')) body.expectedDigest = v('digest');
            if (v('licence')) body.license = v('licenceUrl') ? { name: v('licence'), url: v('licenceUrl') } : { name: v('licence') };
            if (v('notes')) body.notes = v('notes');
            if (v('pool')) body.poolId = v('pool');
            return body;
          },
          submit: (body) => App.post('/api/admin/models', body),
          refused(x, err) {
            if (!(x.status === 422 && x.problem && x.problem.reason === 'pickle')) return false;
            err.innerHTML = UI.problem('Import refused: pickle checkpoint', x.problem.detail + ' Nothing was pulled and no model was registered. The refusal is in the audit log.', x.problem.trace_id);
            return true;
          },
          done(m, body) {
            put(m); Object.assign(st, { selected: m.id, lifecycle: 'all', cap: 'all', query: '' });
            if (m.jobId) track(m.jobId, m.id, 'pull');
            refresh(); reloadModels();
            say('Import of <b>' + esc(m.name) + '</b> requested as a draft' + (m.jobId ? '; pulling onto ' + esc(((st.pools || []).find((p) => p.id === body.poolId) || { name: 'the pool' }).name) + '.' : '. Place it on a pool to pull it.'), 'ok', 6000);
          }
        });
      };
      ctx.on('click', '[data-request]', () => requestModal());
      if (st.openRequest && st.loaded) { const pre = st.openRequest; st.openRequest = null; setTimeout(() => requestModal(pre), 30); }

      if (!sel) return;

      // ----- licence, label and notes -----
      const editModal = () => {
        const lic = sel.license || {};
        formModal({
          title: (sel.license && sel.license.name ? 'Edit ' : 'Record licence for ') + esc(sel.name), ok: 'Save',
          body: '<div class="formgrid" style="--cols:2">'
            + UI.field('Licence', UI.input(lic.name || '', { placeholder: 'Apache 2.0, MIT, Llama 3.1 Community…', attrs: 'data-f="licence"' }))
            + UI.field('Licence URL', UI.input(lic.url || '', { placeholder: 'https://… (optional)', attrs: 'data-f="url"' }))
            + '<div class="span2">' + UI.field('Licence notes', UI.textarea(lic.notes || '', { placeholder: 'Review outcome, conditions of use (optional)', rows: 2, attrs: 'data-f="lnotes"' })) + '</div>'
            + UI.field('Max label', UI.select(LABELS, sel.label, 'data-f="label"'), sel.state === 'approved' ? 'Raising it on an approved model needs a new approval' : '')
            + '<div class="span2">' + UI.field('Notes', UI.textarea(sel.notes || '', { rows: 2, attrs: 'data-f="notes"' })) + '</div></div>'
            + UI.notice('The licence is recorded with your name and shown on the model card. Approve becomes available once it is saved.', 'info'),
          read(m) {
            const v = (k) => m.querySelector('[data-f="' + k + '"]').value.trim();
            const body = { label: v('label'), notes: v('notes') || null };
            if (v('licence')) { body.license = { name: v('licence') }; if (v('url')) body.license.url = v('url'); if (v('lnotes')) body.license.notes = v('lnotes'); }
            else if (sel.license && sel.license.name) throw new Error('A recorded licence cannot be cleared; enter its name.');
            return body;
          },
          submit: (body) => App.patch('/api/admin/models/' + encodeURIComponent(sel.id), body),
          done(m, body) { put(m); refresh(); say(body.license ? 'Licence for <b>' + esc(m.name) + '</b> recorded as ' + esc(body.license.name) + '.' + (m.state === 'evaluated' ? ' Approve is available.' : '') : '<b>' + esc(m.name) + '</b> saved.', 'ok'); }
        });
      };
      ctx.on('click', '[data-licence]', editModal);
      ctx.on('click', '[data-edit]', editModal);

      // ----- jobs -----
      ctx.on('click', '[data-evaluate]', async () => {
        const claimsTools = (sel.capabilities || []).indexOf('tools') >= 0;
        const ok = await ctx.confirm({ title: 'Evaluate ' + sel.name, tag: 'conformance', tone: 'info', ok: 'Run evaluation',
          body: '<p style="margin:0" class="fg2">Runs a chat smoke test on a healthy instance that has the model pulled' + (claimsTools ? ', and a tool-calling test because the model claims tools. Failing it withholds tools from profiles' : '') + '. Passing the smoke test moves a draft to evaluated.</p>' });
        if (!ok) return;
        try { const r = await App.post('/api/admin/models/' + encodeURIComponent(sel.id) + '/evaluate'); track(r.jobId, sel.id, 'evaluate'); refresh(); say('Evaluation of <b>' + esc(sel.name) + '</b> started.'); }
        catch (err) { App.fail(err, 'Evaluation not started'); }
      });
      ctx.on('click', '[data-pull]', () => {
        const options = (sel.pools || []).map((p) => ({ value: p.poolId, label: p.pool || p.poolId }));
        if (!options.length) return;
        formModal({
          title: 'Pull ' + esc(sel.name), ok: 'Pull',
          body: UI.field('Pool', UI.select(options, options[0].value, 'data-f="pool"'), 'Pools the model is placed on')
            + UI.notice('Every instance in the pool pulls the model. ' + (sel.expectedDigest ? 'The digest is checked against the expected one and the format is verified;' : 'The digest and the format are verified;') + ' a mismatch deletes the blob and fails the import.', 'info'),
          read: (m) => ({ poolId: m.querySelector('[data-f="pool"]').value }),
          submit: (body) => App.post('/api/admin/models/' + encodeURIComponent(sel.id) + '/pull', body),
          done(r) { track(r.jobId, sel.id, 'pull'); refresh(); say('Pulling <b>' + esc(sel.name) + '</b>.'); }
        });
      });

      // ----- placement -----
      ctx.on('click', '[data-place]', () => {
        const placed = {}; (sel.pools || []).forEach((p) => { placed[p.poolId] = true; });
        const options = poolOptions(sel).filter((p) => p.ok && !placed[p.value]);
        const refused = poolOptions(sel).filter((p) => !p.ok);
        if (!options.length) { say(refused.length ? 'Every other pool\'s label ceiling is below ' + esc(sel.label) + '.' : 'No pool to place it on. Create one under Pools first.', 'warn', 6000); return; }
        formModal({
          title: 'Place ' + esc(sel.name) + ' on a pool', ok: 'Place and pull',
          body: '<div class="formgrid" style="--cols:2">' + UI.field('Pool', UI.select(options, options[0].value, 'data-f="pool"')) + UI.field('Residency', UI.select([{ value: 'warm', label: 'warm, loaded on demand' }, { value: 'pinned', label: 'pinned, kept loaded' }, { value: 'cold', label: 'cold, pulled only' }], 'warm', 'data-f="res"')) + '</div>'
            + (refused.length ? UI.notice('Not offered: ' + refused.map((p) => esc(p.label.split(' (')[0])).join(', ') + ', whose label ceiling is below ' + esc(sel.label) + '.', 'info') : '')
            + UI.notice('The pull starts right away on every instance in the pool.', 'info'),
          read: (m) => ({ modelId: sel.id, poolId: m.querySelector('[data-f="pool"]').value, residency: m.querySelector('[data-f="res"]').value, pull: true }),
          submit: (body) => App.post('/api/admin/placements', body),
          done(r, body) {
            const pool = (st.pools || []).find((p) => p.id === body.poolId) || { name: 'the pool' };
            if (r.jobId) track(r.jobId, sel.id, 'pull');
            reloadModels(); say('<b>' + esc(sel.name) + '</b> placed on ' + esc(pool.name) + ' (' + esc(body.residency) + '); pulling.', 'ok');
          }
        });
      });
      ctx.on('click', '[data-unplace]', async (e, t) => {
        const p = (sel.pools || []).find((x) => x.placementId === t.dataset.unplace); if (!p) return;
        const ok = await ctx.confirm({ title: 'Remove ' + sel.name + ' from ' + (p.pool || 'the pool'), tag: 'placement', tone: 'danger', ok: 'Remove',
          body: '<p style="margin:0" class="fg2">The gateway stops routing this model to the pool. Profiles that route here fail to publish until the model is placed again.</p>', kv: [['Residency', esc(p.residency)], ['Used by profiles', esc(sel.profiles || 0)]] });
        if (!ok) return;
        try { await App.del('/api/admin/placements/' + encodeURIComponent(p.placementId)); await reloadModels(); say('<b>' + esc(sel.name) + '</b> removed from ' + esc(p.pool || 'the pool') + '.'); }
        catch (err) { App.fail(err, 'Placement not removed'); }
      });

      // ----- lifecycle -----
      const lifecycle = (body) => App.post('/api/admin/models/' + encodeURIComponent(sel.id) + '/lifecycle', body);
      ctx.on('click', '[data-approve]', async () => {
        const ev = sel.evaluation || {};
        const ok = await ctx.confirm({ title: 'Approve ' + sel.name, tag: ev.toolsWithheld ? 'chat only' : 'approved', tone: 'ok', ok: 'Approve',
          body: '<p style="margin:0" class="fg2">Profiles can pick this model once it is approved and placed on a pool cleared for their label.' + (ev.toolsWithheld ? ' The tools capability stays withheld because tool calling failed the conformance test.' : '') + '</p>',
          kv: [['Digest', '<span class="mono">' + esc(shortDigest(sel.digest)) + '</span>'], ['Max label', UI.label(sel.label, { sm: true })], ['Licence', esc((sel.license || {}).name || '')], ['Conformance', esc((ev.passed || 0) + ' of ' + (ev.total || 0) + ' passed')], ['Placed on', esc((sel.pools || []).map((p) => p.pool).join(', ') || 'no pool yet')], ['Requested by', who(sel.requestedBy)]] });
        if (!ok) return;
        try { const m = await lifecycle({ to: 'approved' }); put(m); refresh(); say('<b>' + esc(m.name) + '</b> approved' + (ev.toolsWithheld ? ' for chat only' : '') + '. Audit entry written.', 'ok', 5000); }
        catch (err) {
          if (err.problem && err.problem.step === 'dual-control') say('<b>Dual control.</b> ' + esc(err.problem.detail), 'warn', 7000);
          else App.fail(err, 'Not approved');
        }
      });
      ctx.on('click', '[data-deprecate]', () => {
        const soon = Date.now() + 30 * 86400000;
        formModal({
          title: 'Deprecate ' + esc(sel.name) + ' ' + UI.pill('deprecated', 'warn'), ok: 'Deprecate',
          body: '<p style="margin:0" class="fg2">New profiles cannot pick a deprecated model. Profiles that already use it keep routing until it is retired.</p>'
            + UI.field('Retire on', UI.input(isoDay(soon), { type: 'date', attrs: 'data-f="date"' }), 'Recorded on the model; retiring stays a separate step')
            + UI.field('Reason', UI.input('', { placeholder: 'Superseded by …', attrs: 'data-f="reason"' }))
            + (sel.profiles ? UI.notice('Still used by ' + esc(sel.profiles) + (sel.profiles === 1 ? ' profile' : ' profiles') + '. Repoint them before retirement.', 'warn') : ''),
          read(m) {
            const d = m.querySelector('[data-f="date"]').value, r = m.querySelector('[data-f="reason"]').value.trim();
            const body = { to: 'deprecated' };
            if (d) { const t = new Date(d + 'T00:00:00').getTime(); if (!(t > 0)) throw new Error('Enter a valid date.'); body.retireAt = t; }
            if (r) body.reason = r;
            return body;
          },
          submit: lifecycle,
          done(m) { put(m); refresh(); say('<b>' + esc(m.name) + '</b> deprecated' + (m.retireAt ? '. Retires on ' + esc(day(m.retireAt)) + '.' : '.'), 'warn', 5000); }
        });
      });
      ctx.on('click', '[data-retire]', () => {
        formModal({
          title: 'Retire ' + esc(sel.name) + ' ' + UI.pill('destructive', 'danger'), ok: 'Retire', kind: 'danger',
          body: '<p style="margin:0" class="fg2">The model is removed from routing and cannot be placed again. It stays in the catalogue, read-only, for audit.</p>'
            + UI.kv([['Placed on', esc((sel.pools || []).map((p) => p.pool).join(', ') || 'no pool')], ['Used by profiles', esc(sel.profiles || 0)]], 2)
            + UI.field('Reason', UI.input('', { placeholder: 'Why it is retired', attrs: 'data-f="reason"' })),
          read(m) { const r = m.querySelector('[data-f="reason"]').value.trim(); return r ? { to: 'retired', reason: r } : { to: 'retired' }; },
          submit: lifecycle,
          done(m) { put(m); refresh(); say('<b>' + esc(m.name) + '</b> retired and removed from routing.', '', 5000); }
        });
      });

      // ----- model card -----
      ctx.on('click', '[data-card]', () => {
        const ev = sel.evaluation;
        const card = { name: sel.name, digest: sel.digest ? 'sha256:' + hex(sel.digest) : null, expectedDigest: sel.expectedDigest, family: sel.family, parameterSize: sel.parameterSize, quantization: sel.quantization, format: sel.format, sizeBytes: sel.sizeBytes, contextLength: sel.contextLength, capabilities: sel.capabilities, source: sel.source, license: sel.license, label: sel.label, state: sel.state, evaluation: ev, requestedBy: sel.requestedBy, approvedBy: sel.approvedBy, approvedAt: sel.approvedAt, retireAt: sel.retireAt, pools: (sel.pools || []).map((p) => ({ pool: p.pool, residency: p.residency })), notes: sel.notes, exportedAt: new Date().toISOString() };
        const idx = STEPS.indexOf(sel.state);
        ctx.drawer({
          title: 'Model card, ' + esc(sel.name), onClose,
          body: '<div class="hstack">' + UI.pill(sel.state) + UI.label(sel.label, { sm: true }) + '</div>'
            + UI.kv([['Digest', sel.digest ? '<span class="mono">' + esc(shortDigest(sel.digest)) + '</span>' : 'not pulled'], ['Family, size', esc([sel.family, sel.parameterSize, gb(sel.sizeBytes)].filter(Boolean).join(', ') || 'unknown')], ['Format', esc([sel.format, sel.quantization].filter(Boolean).join(', ') || 'unknown')], ['Capabilities', esc(capsOf(sel).join(', ') || 'unknown')], ['Context length', sel.contextLength ? esc(Number(sel.contextLength).toLocaleString()) : 'unknown'], ['Source', esc(sel.source || '')], ['Licence', esc((sel.license || {}).name || 'not recorded')], ['Conformance', ev ? esc(ev.passed + ' of ' + ev.total + ' passed on ' + ev.instance) + (ev.toolsWithheld ? ', tools withheld' : '') : 'not run']], 1)
            + UI.timeline([
              { title: 'Import requested', text: esc(sel.source || ''), meta: esc(when(sel.createdAt)), tone: 'ok' },
              { title: 'Pulled', text: sel.importState === 'pulled' ? 'digest and format verified' : sel.importState === 'failed' ? esc(sel.importError || 'failed') : 'pending', tone: sel.importState === 'pulled' ? 'ok' : sel.importState === 'failed' ? 'danger' : '' },
              { title: 'Evaluated', text: ev ? esc(ev.passed + ' of ' + ev.total + ' passed') : 'pending', meta: ev ? esc(when(ev.at)) : '', tone: ev ? (ev.passed === ev.total ? 'ok' : 'warn') : '' },
              { title: 'Approved', text: sel.approvedBy ? who(sel.approvedBy) : 'pending', meta: esc(when(sel.approvedAt)), tone: sel.approvedBy ? 'ok' : '' },
              { title: sel.state === 'retired' ? 'Retired' : 'Deprecated', text: idx >= 3 ? (sel.retireAt ? 'retire on ' + esc(day(sel.retireAt)) : '') : 'not planned', tone: idx >= 3 ? 'warn' : '' }
            ]),
          actions: UI.btn('Download card (JSON)', { icon: 'download', attrs: 'data-dl' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(d) {
            d.querySelector('[data-dl]').addEventListener('click', () => {
              const url = URL.createObjectURL(new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' }));
              const a = document.createElement('a'); a.href = url; a.download = sel.name.replace(/[^\w.-]+/g, '_') + '.model-card.json'; document.body.appendChild(a); a.click(); a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 10000);
              say('Model card downloaded.');
            });
          }
        });
      });
    }
  });
})();
