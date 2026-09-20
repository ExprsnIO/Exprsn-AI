(function () {
  const { UI, esc } = App;

  const STEPS = ['draft', 'evaluated', 'approved', 'deprecated', 'retired'];
  const MODELS = [
    { id: 'qwen2.5:32b-q4_K_M', family: 'Qwen 2.5', size: '32B', caps: ['chat', 'tools'], label: 'confidential', lifecycle: 'approved', digest: 'sha256:41ab9c0e7f5d2b18...e3a7', full: 'sha256:41ab9c0e7f5d2b18c4a6f0d9e2b7c1a8f5e3d2c1b0a9f8e7d6c5b4a3f2e1d0e3a7', ctx: '32,768', source: 'Ollama library, import bundle 2026-35', licence: 'Apache 2.0, recorded', manifest: 'verified', hw: 'cuda passed, rocm passed, cpu passed', conf: '44 of 44 passed', confTone: 'ok', pools: ['gpu-large'], profiles: ['analyst'] },
    { id: 'llama3.1:8b-q5_K_M', family: 'Llama 3.1', size: '8B', caps: ['chat', 'tools'], label: 'confidential', lifecycle: 'approved', digest: 'sha256:7d21e6b03a9f4c55...0b2d', full: 'sha256:7d21e6b03a9f4c55e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a60b2d', ctx: '32,768', source: 'Ollama library, import bundle 2026-35', licence: 'Llama 3.1 Community, recorded', manifest: 'verified', hw: 'cuda passed, cpu passed', conf: '43 of 44 passed', confTone: 'ok', pools: ['gpu-large', 'cpu-helpers'], profiles: ['general-8b', 'chat-default'] },
    { id: 'qwen2.5-coder:32b-q4_K_M', family: 'Qwen 2.5', size: '32B', caps: ['chat', 'tools'], label: 'internal', lifecycle: 'evaluated', digest: 'sha256:9f2c41d07be6a3...c81e', full: 'sha256:9f2c41d07be6a3f1e8d2c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7c81e', ctx: '32,768', source: 'Ollama library, import bundle 2026-37', licence: 'Apache 2.0, recorded', manifest: 'verified', hw: 'cuda passed, cpu passed', conf: '41 of 44 passed', confTone: 'warn', pools: ['gpu-large'], profiles: ['coder-32b', 'code'], warn: 'The tools capability is withheld until the conformance suite passes. Approval is still possible for chat only.' },
    { id: 'nomic-embed-text:v1.5', family: 'Nomic', size: '137M', caps: ['embed'], label: 'restricted', lifecycle: 'approved', digest: 'sha256:0c6e3d4a1f9b2e77...94af', full: 'sha256:0c6e3d4a1f9b2e77d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f494af', ctx: '8,192', source: 'Ollama library, import bundle 2026-31', licence: 'Apache 2.0, recorded', manifest: 'verified', hw: 'cpu passed, cuda passed', conf: 'not applicable, no tools capability', confTone: '', pools: ['cpu-helpers'], profiles: [] },
    { id: 'llama-guard3:8b', family: 'Llama Guard', size: '8B', caps: ['chat'], label: 'restricted', lifecycle: 'approved', digest: 'sha256:b3a8f1c92d0e6547...1e60', full: 'sha256:b3a8f1c92d0e6547a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c41e60', ctx: '8,192', source: 'Ollama library, import bundle 2026-31', licence: 'Llama 3.1 Community, recorded', manifest: 'verified', hw: 'cpu passed, cuda passed', conf: 'not applicable, guard model', confTone: '', pools: ['cpu-helpers'], profiles: [], guard: true },
    { id: 'finance-lora-v3:8b', family: 'Llama 3.1', size: '8B', caps: ['chat'], label: 'confidential', lifecycle: 'draft', digest: 'sha256:e5d09a7c3b2f1486...77c3', full: 'sha256:e5d09a7c3b2f1486b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d377c3', ctx: '32,768', source: 'Internal fine-tune, training job finance-lora-v3', licence: 'Inherits Llama 3.1 Community, recorded', manifest: 'signed, cosign key northwind-ml', hw: 'cuda passed', conf: 'not run', confTone: '', pools: ['none until approved'], profiles: [], evalNote: 'Registration waits on the guardrail red-team suite, which is below its threshold (0.968 against 0.980).' },
    { id: 'llama3:8b-q4_0', family: 'Llama 3', size: '8B', caps: ['chat'], label: 'internal', lifecycle: 'deprecated', digest: 'sha256:2a7c9e4d0b1f8365...5bd2', full: 'sha256:2a7c9e4d0b1f8365c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e25bd2', ctx: '8,192', source: 'Ollama library, import bundle 2026-12', licence: 'Llama 3 Community, recorded', manifest: 'verified', hw: 'cuda passed, cpu passed', conf: '38 of 44 passed', confTone: 'warn', pools: ['gpu-large'], profiles: [], depNote: 'Deprecated on 2 Sep. New profiles cannot pick it; existing profiles keep routing until 30 Sep, then it retires.' }
  ];
  const CAPS = ['chat', 'tools', 'embed', 'vision', 'thinking'];

  function menu(ctx, host, items, cur, onPick) {
    ctx.$$('.dropdown').forEach((d) => d.remove());
    const d = document.createElement('div'); d.className = 'dropdown';
    d.innerHTML = items.map((it) => '<button type="button" data-v="' + esc(it) + '" class="' + (it === cur ? 'on' : '') + '">' + esc(it) + '</button>').join('');
    host.appendChild(d);
    d.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; d.remove(); onPick(b.dataset.v); });
    setTimeout(() => document.addEventListener('click', function h(e) { if (!d.contains(e.target)) { d.remove(); document.removeEventListener('click', h); } }), 0);
  }

  App.register({
    id: 'models', title: 'Models', summary: 'Catalog, signed import path, lifecycle approvals, quantization builds', section: 'admin', crumb: ['Admin', 'Models'],
    commands: [{ label: 'Request model import', sub: 'Models', run(app) { app.stateFor('models').openRequest = true; app.render(); } }],
    states: [
      { title: 'Pickle rejected', tone: 'danger', text: 'Import refused: the archive contains a pickle checkpoint. Only GGUF and safetensors are accepted.', apply(ctx) { ctx.state.problem = 'pickle'; ctx.rerender(); } },
      { title: 'Digest mismatch', tone: 'danger', text: 'The blob digest does not match the approved manifest. The gateway refuses the blob and nothing is registered.', apply(ctx) { ctx.state.problem = 'digest'; ctx.rerender(); } },
      { title: 'Licence missing', tone: 'warn', text: 'Approve is disabled until the licence field is completed and reviewed.', apply(ctx) { ctx.state.selected = 'qwen2.5-coder:32b-q4_K_M'; ctx.state.licenceMissing = true; ctx.rerender(); } },
      { title: 'Retired', tone: 'neutral', text: 'Retired tags stay resolvable for audit and are removed from routing. Shown read-only.', apply(ctx) { ctx.state.lc = ctx.state.lc || {}; ctx.state.lc['llama3:8b-q4_0'] = 'retired'; ctx.state.selected = 'llama3:8b-q4_0'; ctx.state.lifecycle = 'all'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.selected = st.selected || 'qwen2.5-coder:32b-q4_K_M'; st.query = st.query || ''; st.lifecycle = st.lifecycle || 'all'; st.cap = st.cap || 'all';
      st.lc = st.lc || {}; st.extra = st.extra || []; st.reveal = st.reveal || {};
      if (ctx.params.model) { st.selected = ctx.params.model; delete ctx.params.model; }
      const all = MODELS.concat(st.extra);
      const lcOf = (m) => st.lc[m.id] || m.lifecycle;
      const q = st.query.toLowerCase();
      const rows = all.filter((m) => (!q || (m.id + ' ' + m.family + ' ' + m.caps.join(' ')).toLowerCase().includes(q)) && (st.lifecycle === 'all' || lcOf(m) === st.lifecycle) && (st.cap === 'all' || m.caps.includes(st.cap)));
      const sel = all.find((m) => m.id === st.selected) || all[0];
      const lc = lcOf(sel);
      const licenceMissing = st.licenceMissing && sel.id === 'qwen2.5-coder:32b-q4_K_M';
      const readOnly = lc === 'retired';

      const stepper = '<div class="models-steps">' + STEPS.map((s, i) => '<span class="' + (s === lc ? 'cur' : STEPS.indexOf(lc) > i ? 'done' : '') + '">' + s + '</span>' + (i < STEPS.length - 1 ? '<span class="sep">›</span>' : '')).join('') + '</div>';
      const digest = st.reveal[sel.id] ? '<span class="mono fg2" style="overflow-wrap:anywhere">' + esc(sel.full) + '</span> <a href="#" data-reveal style="font-size:12px">hide</a>' : '<span class="mono fg2">' + esc(sel.digest) + '</span> <a href="#" data-reveal style="font-size:12px">reveal</a>';
      const kv = [
        ['Digest', digest],
        ['Context length', esc(sel.ctx)],
        ['Source', esc(sel.source) + (/bundle/.test(sel.source) ? ' <a href="#" data-go="platform" style="font-size:12px">bundle</a>' : /training job/.test(sel.source) ? ' <a href="#" data-go="training" style="font-size:12px">open job</a>' : '')],
        ['Licence', licenceMissing ? '<span style="color:var(--warn-fg)">not recorded</span> ' + UI.btn('Record licence', { size: 'xs', attrs: 'data-licence' }) : esc(sel.licence)],
        ['Signed manifest', sel.manifest === 'verified' ? UI.pill('verified', 'ok') : UI.pill(sel.manifest, 'ok')],
        ['Tested hardware', esc(sel.hw)],
        ['Tool-calling conformance', sel.confTone ? UI.pill(sel.conf, sel.confTone) : '<span class="fg2">' + esc(sel.conf) + '</span>'],
        ['Allowed pools', sel.pools.map((p) => /^none/.test(p) ? '<span class="fg2">' + esc(p) + '</span>' : '<a href="#" data-go="pools">' + esc(p) + '</a>').join(', ')],
        ['Used by profiles', sel.profiles.length ? sel.profiles.map((p) => '<a href="#" data-profile="' + esc(p) + '">' + esc(p) + '</a>').join(', ') : '<span class="fg2">' + (sel.guard ? 'guardrails only' : 'none') + '</span>']
      ];
      let notice = '';
      if (readOnly) notice = UI.notice('Retired on ' + (sel.id === 'llama3:8b-q4_0' ? '20 Sep' : 'today') + '. The tag stays resolvable for audit and is removed from routing. Fields are read-only.', 'info');
      else if (licenceMissing) notice = UI.notice('Approve is disabled until the licence field is completed and reviewed.', 'warn');
      else if (sel.warn && lc === 'evaluated') notice = UI.notice(esc(sel.warn), 'warn');
      else if (sel.evalNote && lc === 'draft') notice = UI.notice(esc(sel.evalNote) + ' <a href="#" data-go="training">Open evals</a>', 'warn');
      else if (sel.depNote && lc === 'deprecated') notice = UI.notice(esc(sel.depNote), 'warn');
      else if (lc === 'approved' && sel.warn) notice = UI.notice('Approved for chat only. Tools stay withheld until the conformance suite passes.', 'info');
      let actions = '';
      if (readOnly) actions = UI.btn('Model card', { attrs: 'data-card' });
      else if (lc === 'draft') actions = UI.btn('Approve', { kind: 'primary', disabled: true, title: 'Needs an eval record and a passing red-team suite' }) + UI.btn('Build quantization', { attrs: 'data-quant' }) + UI.btn('Model card', { attrs: 'data-card' });
      else if (lc === 'evaluated') actions = UI.btn('Approve', { kind: 'primary', attrs: 'data-approve', disabled: licenceMissing, title: licenceMissing ? 'Licence not recorded' : '' }) + UI.btn('Build quantization', { attrs: 'data-quant' }) + UI.btn('Model card', { attrs: 'data-card' });
      else if (lc === 'approved') actions = UI.btn('Deprecate', { attrs: 'data-deprecate' }) + UI.btn('Build quantization', { attrs: 'data-quant' }) + UI.btn('Model card', { attrs: 'data-card' });
      else if (lc === 'deprecated') actions = UI.btn('Retire', { kind: 'danger', attrs: 'data-retire' }) + UI.btn('Model card', { attrs: 'data-card' });

      const problem = st.problem === 'pickle'
        ? '<div class="vstack gap6">' + UI.problem('Import refused: pickle checkpoint', 'The archive 2026-38-hf-models.tar contains consolidated.00.pth, a pickle checkpoint. Only GGUF and safetensors are accepted. Nothing was written to MinIO and no tag was registered.', '7c1e0b3f9a2d4e6c8b5a7f1e3d9c0b2a') + '<div>' + UI.btn('Dismiss', { size: 'sm', attrs: 'data-dismiss' }) + '</div></div>'
        : st.problem === 'digest'
          ? '<div class="vstack gap6">' + UI.problem('Digest mismatch', 'Blob sha256:c07e2a… does not match the approved manifest for qwen2.5:32b-q4_K_M (expected sha256:41ab9c…). The gateway refused the blob on gpu-large-1/1 and nothing is registered.', '3e9a7c1b5d2f4e8a6c0b9d7f1a3e5c2b') + '<div>' + UI.btn('Dismiss', { size: 'sm', attrs: 'data-dismiss' }) + UI.btn('Open import log', { kind: 'ghost', size: 'sm', attrs: 'data-go="platform"' }) + '</div></div>'
          : '';

      root.innerHTML = '<style>'
        + '.models-steps{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}.models-steps span{color:var(--muted);font-weight:500}.models-steps .cur{color:var(--fg);font-weight:700}.models-steps .done{color:var(--fg2)}.models-steps .sep{color:var(--faint)}'
        + '.models-name{font-family:var(--mono);font-size:14px;font-weight:500;overflow-wrap:anywhere}'
        + '</style>'
        + '<div class="page">'
        + UI.pagehead('Model catalog', 'Weights enter only through the signed import path', UI.btn('Import safetensors', { attrs: 'data-import' }) + UI.btn('Request import', { kind: 'primary', attrs: 'data-request' }))
        + problem
        + '<div class="toolbar">' + UI.search('Filter models', 'data-search', st.query) + '<span class="relative">' + UI.btn('Lifecycle: ' + st.lifecycle, { attrs: 'data-menu="lifecycle"', cls: st.lifecycle !== 'all' ? 'active' : '' }) + '</span><span class="relative">' + UI.btn('Capability: ' + st.cap, { attrs: 'data-menu="cap"', cls: st.cap !== 'all' ? 'active' : '' }) + '</span><span class="muted right" style="font-size:12px">' + rows.length + ' of ' + all.length + ' models</span></div>'
        + UI.table(['Model', 'Family', 'Size', 'Capabilities', 'Max label', 'Lifecycle'], rows.map((m) => ({ cells: ['<span class="mono">' + esc(m.id) + '</span>', esc(m.family), esc(m.size), esc(m.caps.join(', ')), UI.label(m.label, { sm: true }), UI.pill(lcOf(m))], selected: m.id === sel.id, attrs: 'data-id="' + esc(m.id) + '"' })), { emptyTitle: 'No models match', emptyText: 'Clear the filters or request an import.' })
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div>'
        + '<aside class="inspector w360"><div class="models-name">' + esc(sel.id) + '</div>' + stepper + UI.kv(kv, 1) + notice + '<div class="hstack wrap gap6">' + actions + '</div></aside>';

      ctx.on('click', 'tr.row', (e, t) => { st.selected = t.dataset.id; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-menu]', (e, t) => {
        e.stopPropagation();
        if (t.dataset.menu === 'lifecycle') menu(ctx, t.parentElement, ['all'].concat(STEPS), st.lifecycle, (v) => { st.lifecycle = v; ctx.rerender(); });
        else menu(ctx, t.parentElement, ['all'].concat(CAPS), st.cap, (v) => { st.cap = v; ctx.rerender(); });
      });
      ctx.on('click', '[data-reveal]', (e) => { e.preventDefault(); st.reveal[sel.id] = !st.reveal[sel.id]; ctx.rerender(); });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-profile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.profile }); });
      ctx.on('click', '[data-dismiss]', () => { st.problem = null; ctx.rerender(); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));

      ctx.on('click', '[data-approve]', async () => {
        const chatOnly = sel.confTone === 'warn';
        const ok = await ctx.confirm({ title: 'Approve ' + sel.id, tag: chatOnly ? 'chat only' : 'approved', tone: 'ok', body: '<p style="margin:0" class="fg2">Approval mirrors the weights into MinIO by digest and allows placement on the allowed pools. Profiles can pin this version from now on.' + (chatOnly ? ' The tools capability stays withheld until the conformance suite passes.' : '') + '</p>', kv: [['Digest', '<span class="mono">' + esc(sel.digest) + '</span>'], ['Max label', UI.label(sel.label, { sm: true })], ['Allowed pools', esc(sel.pools.join(', '))], ['Signed manifest', UI.pill('verified', 'ok')]], ok: 'Approve' });
        if (!ok) return;
        st.lc[sel.id] = 'approved'; ctx.rerender(); ctx.toast('<b>' + esc(sel.id) + '</b> approved' + (chatOnly ? ' for chat only' : '') + '. Weights mirrored to MinIO; audit entry written.', 'ok', 5000);
      });
      ctx.on('click', '[data-deprecate]', async () => {
        const ok = await ctx.confirm({ title: 'Deprecate ' + sel.id, tag: 'deprecated', tone: 'warn', body: '<p style="margin:0" class="fg2">New profiles cannot pick a deprecated tag. Profiles that already pin it keep routing until the retirement date you set here.</p>' + UI.field('Retire on', UI.input('2026-10-31', { type: 'date' })) + (sel.profiles.length ? UI.notice('Still pinned by ' + sel.profiles.map((p) => '<b>' + esc(p) + '</b>').join(', ') + '. Repoint them before retirement.', 'warn') : ''), ok: 'Deprecate' });
        if (!ok) return;
        st.lc[sel.id] = 'deprecated'; ctx.rerender(); ctx.toast('<b>' + esc(sel.id) + '</b> deprecated. Retires on 31 Oct unless extended.', 'warn', 5000);
      });
      ctx.on('click', '[data-retire]', async () => {
        const ok = await ctx.confirm({ title: 'Retire ' + sel.id, tag: 'destructive', tone: 'danger', body: '<p style="margin:0" class="fg2">The tag is removed from routing on every pool and unloaded from instances. It stays resolvable for audit and the blob stays in MinIO for the retention period.</p>', kv: [['Loaded on', 'gpu-large-2/0'], ['Requests last 7 days', '0']], ok: 'Retire' });
        if (!ok) return;
        st.lc[sel.id] = 'retired'; ctx.rerender(); ctx.toast('<b>' + esc(sel.id) + '</b> retired and removed from routing.', '', 5000);
      });
      ctx.on('click', '[data-licence]', () => ctx.modal({ title: 'Record licence for ' + esc(sel.id), body: UI.field('Licence', UI.select(['Apache 2.0', 'MIT', 'Llama 3.1 Community', 'Qwen Research', 'Other, attach text'], 'Apache 2.0')) + UI.field('Source of the licence text', UI.input('LICENSE in the Hugging Face repository, import bundle 2026-37')) + UI.check('Reviewed by legal for commercial internal use', false) + UI.notice('The licence is recorded on the manifest and shown on the model card. Approve becomes available once it is saved.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save licence', { kind: 'primary', attrs: 'data-save' }), onMount(m) { m.querySelector('[data-save]').addEventListener('click', () => { App.closeOverlay(); st.licenceMissing = false; ctx.rerender(); ctx.toast('Licence recorded as Apache 2.0. Approve is available.', 'ok'); }); } }));
      ctx.on('click', '[data-quant]', () => ctx.modal({ title: 'Build quantization from ' + esc(sel.id), body: '<div class="formgrid" style="--cols:2">' + UI.field('Target quantization', UI.select(['Q4_K_M', 'Q5_K_M', 'Q8_0'], 'Q8_0')) + UI.field('Evals to run', UI.select(['cuda and cpu', 'cuda only', 'cuda, rocm and cpu'], 'cuda and cpu')) + UI.field('Result tag', UI.input(sel.id.replace(/-q[0-9]_[A-Z0-9_]+$/i, '') + '-q8_0', { readonly: true }), 'Registers as a new draft with its own digest') + UI.field('Priority', UI.select(['low, off-peak', 'normal'], 'low, off-peak')) + '</div>' + UI.notice('Runs llama-quantize on the training pool from the mirrored safetensors. The new tag needs its own eval record per hardware class before approval.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Queue build', { kind: 'primary', attrs: 'data-queue' }), onMount(m) { m.querySelector('[data-queue]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Quantization queued on train-1, off-peak. It appears as a draft tag when packaging finishes. <a href="#/training" style="color:inherit">Track it</a>', '', 6000); }); } }));
      ctx.on('click', '[data-card]', () => ctx.drawer({ title: 'Model card, ' + esc(sel.id), body: '<div class="hstack">' + UI.pill(lc) + UI.label(sel.label, { sm: true }) + '</div>' + UI.kv([['Base digest', '<span class="mono">' + esc(sel.digest) + '</span>'], ['Family, size', esc(sel.family + ', ' + sel.size)], ['Capabilities', esc(sel.caps.join(', '))], ['Context length', esc(sel.ctx)], ['Source', esc(sel.source)], ['Licence', licenceMissing ? 'not recorded' : esc(sel.licence)], ['Tested hardware', esc(sel.hw)], ['Tool-calling conformance', esc(sel.conf)]].concat(sel.id === 'finance-lora-v3:8b' ? [['Dataset version', 'finance-qa v6, 18,420 rows'], ['Code commit', '<span class="mono">a91f3c2</span>'], ['Container digest', '<span class="mono">sha256:5be0…</span>'], ['Hyperparameters', 'LoRA r=16, alpha=32, lr 2e-4, 3 epochs, seed 1337'], ['Eval scores', 'held-out 0.781, regression 0.974, red-team 0.968 (fail)']] : [['Evals', 'task suite passed per class, red-team 0.991']]), 1) + UI.timeline([{ title: 'Imported', text: esc(sel.source), meta: 'signature and digest verified at the diode', tone: 'ok' }, { title: 'Evaluated', text: esc(sel.hw), meta: 'per hardware class', tone: STEPS.indexOf(lc) >= 1 ? 'ok' : '' }, { title: 'Approved', text: STEPS.indexOf(lc) >= 2 ? 'Mara Okafor, model admin' : 'pending', tone: STEPS.indexOf(lc) >= 2 ? 'ok' : '' }]), actions: UI.btn('Download card (JSON)', { icon: 'download', attrs: 'data-dl' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { d.querySelector('[data-dl]').addEventListener('click', () => ctx.toast('Model card exported with the signed manifest attached.')); } }));

      const requestModal = () => ctx.modal({ title: 'Request model import', cls: 'wide', body: '<div class="formgrid" style="--cols:2">' + UI.field('Source', UI.select(['Ollama library mirror', 'Hugging Face, safetensors only', 'Internal fine-tune'], 'Ollama library mirror')) + UI.field('Model and tag', UI.input('', { placeholder: 'mistral-small:24b-instruct-q4_K_M', attrs: 'data-f="name"' })) + UI.field('Licence', UI.input('', { placeholder: 'As published by the source; legal reviews before approval' })) + UI.field('Requested max label', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal')) + UI.field('Capabilities expected', UI.input('chat, tools')) + UI.field('Allowed pools', '<div class="hstack wrap gap12" style="height:30px">' + UI.check('gpu-large', true) + UI.check('cpu-helpers', false) + UI.check('gpu-amd', false) + '</div>') + '<div class="span2">' + UI.field('Why this model', UI.textarea('', { placeholder: 'Which workload it serves and what the current model lacks', rows: 3 })) + '</div></div>' + UI.notice('Requests join the next weekly bundle. Staging fetches, scans and signs the weights; pickle checkpoints are rejected there, and only GGUF or safetensors cross the diode. The tag appears here as a draft once the digest verifies.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send request', { kind: 'primary', attrs: 'data-send' }), onMount(m) { m.querySelector('[data-send]').addEventListener('click', () => { const name = (m.querySelector('[data-f="name"]').value || 'mistral-small:24b-instruct-q4_K_M').trim(); App.closeOverlay(); st.extra.push({ id: name, family: 'pending', size: 'pending', caps: ['chat', 'tools'], label: 'internal', lifecycle: 'draft', digest: 'not yet imported', full: 'not yet imported', ctx: 'pending', source: 'Import request IMP-2026-41, next weekly bundle', licence: 'to be recorded at staging', manifest: 'pending', hw: 'not yet tested', conf: 'not run', confTone: '', pools: ['none until approved'], profiles: [] }); st.selected = name; st.lifecycle = 'all'; ctx.rerender(); ctx.toast('Import request IMP-2026-41 sent to the model admin queue. Bundled with import 2026-39.', 'ok', 5000); }); } });
      ctx.on('click', '[data-request]', requestModal);
      if (st.openRequest) { st.openRequest = false; setTimeout(requestModal, 30); }
      ctx.on('click', '[data-import]', () => ctx.modal({ title: 'Import safetensors bundle', cls: 'wide', body: UI.field('Bundle on the import share', UI.select(['2026-38-hf-models.tar, 47.2 GB, received 19 Sep 06:10', '2026-37-ollama-mirror.tar, imported'], '2026-38-hf-models.tar, 47.2 GB, received 19 Sep 06:10')) + UI.table(['Entry', 'Format', 'Size', 'Signature', 'Digest', 'Licence'], [['<span class="mono">mistral-small:24b-instruct</span>', 'safetensors', '47.1 GB', UI.pill('verified', 'ok'), UI.pill('matches manifest', 'ok'), 'Apache 2.0'], ['<span class="mono">tokenizer, config</span>', 'json', '4 MB', UI.pill('verified', 'ok'), UI.pill('matches manifest', 'ok'), '']], { clickable: false, minWidth: '0' }) + UI.notice('Import converts to GGUF on the training pool, records the licence and registers the tag as a draft. Pickle checkpoints in a bundle stop the whole import.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Verify and import', { kind: 'primary', attrs: 'data-do' }), onMount(m) { m.querySelector('[data-do]').addEventListener('click', () => { App.closeOverlay(); st.extra.push({ id: 'mistral-small:24b-instruct-q4_K_M', family: 'Mistral Small', size: '24B', caps: ['chat', 'tools'], label: 'internal', lifecycle: 'draft', digest: 'sha256:6b1d0e8f2a9c4735...a204', full: 'sha256:6b1d0e8f2a9c4735e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2a204', ctx: '32,768', source: 'Hugging Face safetensors, import bundle 2026-38', licence: 'Apache 2.0, recorded', manifest: 'verified', hw: 'not yet tested', conf: 'not run', confTone: '', pools: ['none until approved'], profiles: [], evalNote: 'Converted to GGUF Q4_K_M. Evals have not run yet; queue them under Training before approval.' }); st.selected = 'mistral-small:24b-instruct-q4_K_M'; st.lifecycle = 'all'; ctx.rerender(); ctx.toast('Bundle verified. mistral-small:24b-instruct registered as a draft; GGUF conversion queued.', 'ok', 5000); }); } }));
    }
  });
})();
