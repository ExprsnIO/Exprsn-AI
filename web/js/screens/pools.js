(function () {
  const { UI, esc } = App;

  const POOLS = [
    { id: 'gpu-large', cls: 'cuda', zone: 'inference', ceiling: 'confidential', title: 'gpu-large, cuda, zone inference, ceiling confidential', total: 80, instances: [
      { id: 'gpu-large-1/0', hw: 'A100 80 GB', segs: [['weights', 19.8], ['kv', 22.4]], free: 37.8, memText: 'weights 19.8, KV 22.4, free 37.8 GB. Estimate was 41.0, measured 42.2', models: [{ name: 'qwen2.5:32b', res: 'pinned' }], slots: [3, 4], queue: 0, ftok: '1.1 s', ollama: '0.32.6', health: 'healthy', node: 'gpu-large-1', dev: 'CUDA_VISIBLE_DEVICES=0', parallel: 4, maxLoaded: 2, ctx: 8192, kvType: 'q8_0', keep: '30m' },
      { id: 'gpu-large-1/1', hw: 'A100 80 GB', segs: [['weights', 19.8], ['new', 19.9], ['kv', 30.1]], free: 10.2, memText: 'old 19.8, new 19.9, KV 30.1, free 10.2 GB', models: [{ name: 'qwen2.5:32b', res: 'draining' }, { name: 'qwen2.5:32b@c07e', res: 'loading' }], slots: [2, 4], queue: 1, ftok: '1.3 s', ollama: '0.32.6', health: 'swapping', node: 'gpu-large-1', dev: 'CUDA_VISIBLE_DEVICES=1', parallel: 4, maxLoaded: 2, ctx: 8192, kvType: 'q8_0', keep: '30m' },
      { id: 'gpu-large-2/0', hw: 'A100 80 GB', segs: [['weights', 5.7], ['kv', 6.2]], free: 68.1, memText: 'weights 5.7, KV 6.2, free 68.1 GB', models: [{ name: 'llama3.1:8b', res: 'warm' }], slots: [1, 8], queue: 0, ftok: '0.4 s', ollama: '0.33.0', health: 'canary', node: 'gpu-large-2', dev: 'CUDA_VISIBLE_DEVICES=0', parallel: 8, maxLoaded: 3, ctx: 8192, kvType: 'q8_0', keep: '30m' }
    ] },
    { id: 'cpu-helpers', cls: 'cpu', zone: 'inference', ceiling: 'restricted', title: 'cpu-helpers, cpu, zone inference, ceiling restricted', total: 128, instances: [
      { id: 'cpu-1/socket0', hw: '32 cores, 256 GB', segs: [['weights', 5.4], ['kv', 1.1]], free: 121, memText: 'weights 5.4, KV 1.1, free 121 GB', models: [{ name: 'nomic-embed-text', res: 'pinned' }, { name: 'llama-guard3:8b', res: 'pinned' }], slots: [5, 16], queue: 2, ftok: '0.2 s', ollama: '0.32.6', health: 'healthy', node: 'cpu-1', dev: 'CPU set 0-31, NUMA node 0', parallel: 16, maxLoaded: 3, ctx: 8192, kvType: 'f16', keep: '-1' },
      { id: 'cpu-1/socket1', hw: '32 cores, 256 GB', segs: [], free: 0, memText: 'not reporting for 46 s', models: [{ name: 'bge-reranker', res: 'pinned' }], slots: [0, 16], queue: 0, ftok: 'none', ollama: '0.32.6', health: 'unreachable', node: 'cpu-1', dev: 'CPU set 32-63, NUMA node 1', parallel: 16, maxLoaded: 3, ctx: 512, kvType: 'f16', keep: '-1' }
    ] }
  ];
  const LOADABLE = ['qwen2.5:32b-q4_K_M', 'llama3.1:8b-q5_K_M', 'qwen2.5-coder:32b-q4_K_M', 'nomic-embed-text:v1.5', 'llama-guard3:8b', 'llama3.2-vision:11b-q4_K_M'];
  const healthKind = (h) => ({ healthy: 'ok', swapping: 'info', canary: 'warn', unreachable: 'danger', draining: 'warn', updating: 'info', upgrading: 'info', loading: 'info' }[h] || '');

  App.register({
    id: 'pools', title: 'Pools', summary: 'Instances per accelerator group, memory planner, load, unload, pin, scheduled and blue/green swaps', section: 'admin', crumb: ['Admin', 'Pools'],
    commands: [{ label: 'Load a model on an instance', sub: 'Pools', run(app) { app.stateFor('pools').openLoad = true; app.render(); } }],
    states: [
      { title: 'No spare memory', tone: 'warn', text: 'The swap on gpu-large-1/0 is waiting for the 02:00 window because both versions do not fit. The model shows as updating in chat.', apply(ctx) { ctx.state.noSpare = true; ctx.rerender(); } },
      { title: 'Anti-thrash limit', tone: 'warn', text: '3 cold loads in the last minute on gpu-large-2/0. Further on-demand loads queue until the limit clears.', apply(ctx) { ctx.state.thrash = true; ctx.rerender(); } },
      { title: 'Why is this cold?', tone: 'neutral', text: 'Hovering a model shows who evicted it, when, and its residency class.', apply(ctx) { ctx.state.coldInfo = { inst: 'gpu-large-2/0', model: 'llama3.1:8b' }; ctx.rerender(); } },
      { title: 'Estimate drift', tone: 'info', text: 'Measured memory differs from the estimate by more than 10%. The registry profile is updated and flagged for review.', apply(ctx) { ctx.state.drift = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.pools) st.pools = JSON.parse(JSON.stringify(POOLS));
      st.notices = st.notices || {};
      const pools = st.pools;
      const allInst = pools.reduce((a, p) => a.concat(p.instances.map((i) => Object.assign({ pool: p.id, total: p.total }, i))), []);
      const find = (id) => { for (const p of pools) { const i = p.instances.find((x) => x.id === id); if (i) return { p, i }; } return null; };

      const memBar = (p, i) => {
        if (!i.segs.length) return '<div class="pools-mem"></div>';
        return '<div class="pools-mem">' + i.segs.map((s) => '<div class="' + s[0] + '" style="width:' + (s[1] / p.total * 100).toFixed(1) + '%" title="' + esc(s[0] + ' ' + s[1] + ' GB') + '"></div>').join('') + '</div>';
      };
      const memText = (i) => {
        if (st.drift && i.id === 'gpu-large-2/0') return 'weights 6.6 measured, estimate was 5.7 (16% over), KV 6.2, free 67.2 GB';
        return i.memText;
      };
      const health = (i) => {
        if (st.noSpare && i.id === 'gpu-large-1/0') return 'updating';
        return i.health;
      };
      const queue = (i) => (st.thrash && i.id === 'gpu-large-2/0' ? 4 : i.queue);
      const row = (p, i) => '<div class="pools-grid row" data-inst="' + esc(i.id) + '" role="button" tabindex="0">'
        + '<div class="vstack" style="gap:1px"><span class="mono" style="font-weight:500">' + esc(i.id) + '</span><span class="muted" style="font-size:11px">' + esc(i.hw) + '</span></div>'
        + '<div class="vstack gap4">' + memBar(p, i) + '<span class="muted" style="font-size:11px">' + esc(memText(i)) + '</span></div>'
        + '<div class="hstack wrap gap6">' + i.models.map((m) => '<button type="button" class="pools-model" data-model="' + esc(m.name) + '" data-on="' + esc(i.id) + '" title="Why is this ' + (m.res === 'warm' || m.res === 'on-demand' ? 'cold' : 'here') + '? Click for residency and eviction history"><span class="mono">' + esc(m.name) + '</span> <span class="muted">' + esc(m.res) + '</span></button>').join('') + (i.models.length ? '' : '<span class="muted" style="font-size:11px">nothing loaded</span>') + '</div>'
        + '<div class="num">' + i.slots[0] + ' / ' + i.slots[1] + '</div><div class="num">' + queue(i) + '</div><div class="num">' + esc(i.ftok) + '</div><div><span class="mono fg2" style="font-size:11px">' + esc(i.ollama) + '</span></div><div>' + UI.pill(health(i), healthKind(health(i))) + '</div></div>';
      const head = '<div class="pools-grid head"><div>Instance</div><div>Memory: weights, KV cache, free</div><div>Loaded models</div><div>Slots</div><div>Queue</div><div>First tok</div><div>Ollama</div><div>Health</div></div>';

      const poolPanels = pools.map((p) => {
        let extra = '';
        if (p.id === 'gpu-large') {
          if (st.scheduled) extra += UI.notice('Swap scheduled: <b>' + esc(st.scheduled) + '</b>. The new version loads on spare capacity, the profile pointer flips, and the old version unloads after its streams finish.', 'info', UI.btn('Cancel swap', { size: 'sm', attrs: 'data-cancelswap' }));
          if (st.noSpare) extra += UI.notice('<b>No spare memory on gpu-large-1/0.</b> The swap to qwen2.5:32b@c07e waits for the 02:00 low-traffic window because both versions do not fit (19.8 + 19.9 GB weights plus KV cache). analyst shows as <b>updating</b> in chat until then.', 'warn', UI.btn('Queue requests and swap now', { size: 'sm', attrs: 'data-swapnow' }));
          if (st.thrash) extra += UI.notice('<b>Anti-thrash limit on gpu-large-2/0.</b> 3 cold loads in the last minute. Further on-demand loads queue until the limit clears in 41 s; pinned models are never evicted.', 'warn', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clear="thrash"' }));
          if (st.drift) extra += UI.notice('<b>Estimate drift.</b> Measured memory for llama3.1:8b on gpu-large-2/0 is 6.6 GB against an estimate of 5.7 GB, 16% over. The registry profile is updated with the measured size and flagged for review.', 'info', UI.btn('Open in Models', { size: 'sm', attrs: 'data-go="models"' }));
          if (st.coldInfo) extra += UI.notice('<b>Why is llama3.1:8b cold on gpu-large-2/0?</b> Residency <b>warm</b>. Evicted at 11:40 by the pinned load of qwen2.5:32b when memory ran short, then reloaded on first use at 14:02 with an 18 s cold start. Pin it or move it to cpu-helpers to keep it resident.', '', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clear="coldInfo"' })).replace('class="notice "', 'class="notice accent"');
          if (st.rolling) extra += UI.notice('Rolling Ollama 0.33.0 across gpu-large one instance at a time, starting with the canary. Each instance drains, upgrades, reloads pinned models and passes a warm-up before the next.', 'info');
        }
        if (p.id === 'cpu-helpers') extra += UI.notice('cpu-1/socket1 has not reported for 46 s. Requests for bge-reranker route to cpu-1/socket0 while the node agent reconnects.', 'danger', UI.btn('Open node', { size: 'sm', attrs: 'data-inst-open="cpu-1/socket1"' }));
        return UI.panel(p.title, '<div class="pools-wrap">' + head + p.instances.map((i) => row(p, i)).join('') + '</div>' + extra, { actions: p.id === 'gpu-large' ? UI.btn('Schedule swap', { size: 'sm', attrs: 'data-swap' }) + UI.btn('Roll upgrade', { size: 'sm', attrs: 'data-roll' }) : '' });
      }).join('');

      root.innerHTML = '<style>'
        + '.pools-wrap{overflow-x:auto}.pools-grid{display:grid;grid-template-columns:150px 1fr 250px 70px 60px 70px 80px 84px;gap:10px;align-items:center;padding:7px 4px;border-bottom:1px solid var(--line2);min-width:960px;font-size:13px}.pools-grid.head{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);border-bottom-color:var(--line)}.pools-grid.row{cursor:pointer;border-radius:4px}.pools-grid.row:hover{background:var(--sel)}.pools-grid:last-child{border-bottom:0}.pools-grid .pill{padding:0 5px;font-size:11px}'
        + '.pools-mem{display:flex;height:10px;background:var(--sel);border-radius:2px;overflow:hidden}.pools-mem .weights{background:var(--meter)}.pools-mem .new{background:var(--accent)}.pools-mem .kv{background:var(--faint)}'
        + '.pools-model{display:inline-flex;gap:4px;align-items:center;font-size:11px;border:1px solid var(--line);border-radius:4px;background:var(--panel);padding:1px 6px;cursor:pointer;font-family:inherit;color:var(--fg)}.pools-model:hover{border-color:var(--muted)}'
        + '.pools-legend{display:flex;gap:14px;font-size:11px;color:var(--muted);align-items:center}.pools-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}'
        + '</style>'
        + '<div class="page">'
        + UI.pagehead('Pools and instances', 'One Ollama process per accelerator group. The gateway owns placement.', UI.btn('Load model', { attrs: 'data-load' }) + UI.btn('Drain instance', { attrs: 'data-drain' }))
        + '<div class="pools-legend"><span><i style="background:var(--meter)"></i>weights</span><span><i style="background:var(--accent)"></i>new version loading</span><span><i style="background:var(--faint)"></i>KV cache</span><span><i style="background:var(--sel);border:1px solid var(--line)"></i>free</span><span class="right">Polled from /api/ps and /api/tags every 5 s. Zone <a href="#" data-go="zones">inference</a>, gpu-east-private.</span></div>'
        + poolPanels
        + UI.panel('gpu-amd and mac-overflow', '<div class="fg2">rocm and metal pools are validated in Phase 5. Mac nodes serve development only until the signed node agent ships.</div>' + UI.kv([['gpu-amd', 'rocm, 2 nodes MI300X 192 GB, ollama/ollama:rocm, zone inference. Evals per class pending.'], ['mac-overflow', 'metal, 3 Mac Studio 192 GB unified, native Ollama over WireGuard. One schedulable unit per Mac, development only.']], 2) + '<div>' + UI.btn('Hardware classes in the plan', { kind: 'ghost', size: 'sm', attrs: 'data-go="platform"' }) + '</div>')
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div>';

      // ---- events ----
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-clear]', (e, t) => { st[t.dataset.clear] = null; ctx.rerender(); });
      ctx.on('click', '[data-cancelswap]', () => { st.scheduled = null; ctx.rerender(); ctx.toast('Scheduled swap cancelled. The pointer stays on the current version.'); });
      ctx.on('click', '[data-swapnow]', async () => {
        const ok = await ctx.confirm({ title: 'Swap now on gpu-large-1/0', tag: 'brief queueing', tone: 'warn', body: '<p style="margin:0" class="fg2">New requests for analyst queue for about 40 s while the old version drains and unloads, then the new version loads and warms up. Fallback chain sends waits over 8 s to general-8b.</p>', ok: 'Swap now' });
        if (!ok) return; st.noSpare = false; const r = find('gpu-large-1/0'); r.i.health = 'swapping'; r.i.models = [{ name: 'qwen2.5:32b', res: 'draining' }, { name: 'qwen2.5:32b@c07e', res: 'loading' }]; ctx.rerender(); ctx.toast('Draining gpu-large-1/0. analyst requests fall back to general-8b for the next 40 s.', 'warn', 5000);
        setTimeout(() => { r.i.health = 'healthy'; r.i.models = [{ name: 'qwen2.5:32b@c07e', res: 'pinned' }]; r.i.memText = 'weights 19.9, KV 22.4, free 37.7 GB. Estimate was 41.2, measured 42.3'; ctx.rerender(); ctx.toast('gpu-large-1/0 ready on qwen2.5:32b@c07e after a measured first token of 1.2 s.', 'ok'); }, 5000);
      });

      const modelInfo = (name, instId) => {
        const r = find(instId); const m = r && r.i.models.find((x) => x.name === name);
        const facts = { 'qwen2.5:32b': ['pinned', 'Preloaded at start with keep_alive -1. Never evicted by the gateway.', 'analyst'], 'qwen2.5:32b@c07e': ['loading', 'Canary version for analyst, blue/green swap in progress. Ready after a measured first token.', 'analyst (canary 10%)'], 'llama3.1:8b': ['warm', 'Evicted at 11:40 by the pinned load of qwen2.5:32b on gpu-large-1/0 when memory ran short. Reloaded on first use at 14:02, cold start 18 s.', 'general-8b, chat-default'], 'nomic-embed-text': ['pinned', 'Embeddings for every knowledge query. keep_alive -1.', 'embed'], 'llama-guard3:8b': ['pinned', 'Guard model for input and output checks. keep_alive -1.', 'guardrails'], 'bge-reranker': ['pinned', 'Cross-encoder reranker. Instance unreachable, so requests route to socket0.', 'reranker'] };
        const f = facts[name] || [m ? m.res : 'warm', 'Loaded on request through the gateway.', 'none'];
        ctx.drawer({ title: '<span class="mono">' + esc(name) + '</span> on ' + esc(instId), body: UI.kv([['Residency', esc(m ? m.res : f[0])], ['Profiles', esc(f[2])], ['keep_alive', f[0] === 'pinned' ? '-1' : '30m'], ['Loaded since', name === 'llama3.1:8b' ? '14:02 today' : 'boot, 06:12']], 2) + UI.notice(esc(f[1]), name === 'llama3.1:8b' ? 'warn' : 'info') + UI.kv([['size (/api/ps)', name.includes('32b') ? '19.8 GB' : name.includes('8b') ? '5.7 GB' : '0.3 GB'], ['size_vram', instId.startsWith('cpu') ? '0' : name.includes('32b') ? '19.8 GB' : '5.7 GB']], 2), actions: (m && m.res === 'pinned' ? UI.btn('Unpin', { attrs: 'data-close data-unpin' }) : UI.btn('Pin', { kind: 'primary', attrs: 'data-close data-pin' })) + UI.btn('Unload', { kind: 'danger', attrs: 'data-close data-unload' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) {
          const pin = d.querySelector('[data-pin]'); if (pin) pin.addEventListener('click', () => { if (m) m.res = 'pinned'; ctx.rerender(); ctx.toast(esc(name) + ' pinned on ' + esc(instId) + ' with keep_alive -1.', 'ok'); });
          const unpin = d.querySelector('[data-unpin]'); if (unpin) unpin.addEventListener('click', () => { if (m) m.res = 'warm'; ctx.rerender(); ctx.toast(esc(name) + ' unpinned; now warm with a 30 m keep_alive.'); });
          d.querySelector('[data-unload]').addEventListener('click', async () => { const ok = await ctx.confirm({ title: 'Unload ' + name + ' from ' + instId, tag: 'unload', tone: 'warn', body: '<p style="margin:0" class="fg2">Sends keep_alive 0 after in-flight streams finish. Profiles that pin this version route to other instances; the next request here pays a cold start.</p>', ok: 'Unload' }); if (!ok) return; if (r) { r.i.models = r.i.models.filter((x) => x.name !== name); } ctx.rerender(); ctx.toast(esc(name) + ' unloaded from ' + esc(instId) + '. Memory freed.'); });
        } });
      };
      ctx.on('click', '.pools-model', (e, t) => { e.stopPropagation(); modelInfo(t.dataset.model, t.dataset.on); });

      const instDrawer = (id) => {
        const r = find(id); if (!r) return; const i = r.i, p = r.p;
        const env = 'OLLAMA_HOST=' + (p.cls === 'cpu' ? '10.40.2.' : '10.40.1.') + (10 + allInst.findIndex((x) => x.id === id)) + ':11434\n' + i.dev + '\nOLLAMA_NO_CLOUD=1\nOLLAMA_MAX_LOADED_MODELS=' + i.maxLoaded + '\nOLLAMA_NUM_PARALLEL=' + i.parallel + '\nOLLAMA_CONTEXT_LENGTH=' + i.ctx + '\nOLLAMA_KV_CACHE_TYPE=' + i.kvType + '\nOLLAMA_MAX_QUEUE=16\nOLLAMA_KEEP_ALIVE=' + i.keep;
        ctx.drawer({ title: '<span class="mono">' + esc(id) + '</span>', body: '<div class="hstack">' + UI.pill(health(i), healthKind(health(i))) + UI.pill(p.cls, 'outline') + UI.label(p.ceiling, { sm: true }) + '</div>' + UI.kv([['Node', esc(i.node)], ['Accelerator', esc(i.hw)], ['Pool', esc(p.id)], ['Zone', '<a href="#" data-zone>inference</a>'], ['Ollama', '<span class="mono">' + esc(i.ollama) + '</span>'], ['mTLS proxy', 'ok, cert expires in 41 d']], 2) + '<div class="eyebrow">Loaded models</div>' + (i.models.length ? '<div class="vstack gap4">' + i.models.map((m) => '<div class="hstack"><span class="mono grow">' + esc(m.name) + '</span>' + UI.pill(m.res, m.res === 'pinned' ? 'ok' : m.res === 'loading' ? 'info' : m.res === 'draining' ? 'warn' : '') + UI.btn('Details', { size: 'xs', attrs: 'data-close data-m="' + esc(m.name) + '"' }) + '</div>').join('') + '</div>' : '<div class="muted">nothing loaded</div>') + '<div class="eyebrow">Memory</div>' + memBar(p, i) + '<div class="muted" style="font-size:12px">' + esc(memText(i)) + '</div><div class="eyebrow">Instance environment</div>' + UI.code(env, 'env'), actions: UI.btn('Load model here', { kind: 'primary', attrs: 'data-close data-loadhere' }) + UI.btn(i.health === 'draining' ? 'Undrain' : 'Drain', { attrs: 'data-close data-drainthis' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) {
          d.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => setTimeout(() => modelInfo(b.dataset.m, id), 30)));
          d.querySelector('[data-loadhere]').addEventListener('click', () => setTimeout(() => loadModal(id), 30));
          d.querySelector('[data-drainthis]').addEventListener('click', () => setTimeout(() => drainFlow(id), 30));
          d.querySelector('[data-zone]').addEventListener('click', (e) => { e.preventDefault(); App.closeOverlay(); ctx.navigate('zones'); });
        } });
      };
      ctx.on('click', '.pools-grid.row', (e, t) => instDrawer(t.dataset.inst));
      ctx.on('keydown', '.pools-grid.row', (e, t) => { if (e.key === 'Enter') instDrawer(t.dataset.inst); });
      ctx.on('click', '[data-inst-open]', (e, t) => instDrawer(t.dataset.instOpen));

      const loadModal = (instId) => {
        const opts = allInst.map((x) => ({ value: x.id, label: x.id + ', free ' + x.free + ' GB' + (x.health === 'unreachable' ? ', unreachable' : '') }));
        ctx.modal({ title: 'Load model', body: '<div class="formgrid" style="--cols:2">' + UI.field('Model version', UI.select(LOADABLE, 'llama3.2-vision:11b-q4_K_M', 'data-model')) + UI.field('Instance', UI.select(opts, instId || 'gpu-large-2/0', 'data-target')) + UI.field('Residency', UI.select(['pinned', 'warm', 'on-demand', 'batch-only'], 'warm')) + UI.field('Warm-up', UI.select(['empty request, then a short prompt', 'empty request only'], 'empty request, then a short prompt')) + '</div>' + UI.notice('<b>Memory planner.</b> weights 7.9 + KV cache (8,192 × 8 slots × q8_0) 6.4 + overhead 0.8 = 15.1 GB. Fits on gpu-large-2/0 (68.1 GB free) without splitting across CPU and GPU. The estimate is corrected from /api/ps after load.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Load', { kind: 'primary', attrs: 'data-do' }), onMount(m) {
          m.querySelector('[data-do]').addEventListener('click', () => {
            const model = m.querySelector('[data-model]').value.split('-q')[0].replace(':v1.5', ''); const target = m.querySelector('[data-target]').value; const r = find(target); App.closeOverlay();
            if (r.i.health === 'unreachable') { ctx.toast('Cannot load: ' + esc(target) + ' is unreachable.', 'danger'); return; }
            if (st.thrash && target === 'gpu-large-2/0') { ctx.toast('Queued: anti-thrash limit on gpu-large-2/0 clears in 41 s.', 'warn'); return; }
            r.i.models.push({ name: model, res: 'loading' }); ctx.rerender(); ctx.toast('Loading ' + esc(model) + ' on ' + esc(target) + '. Ready after a measured first token.', '', 3000);
            setTimeout(() => { const mm = r.i.models.find((x) => x.name === model && x.res === 'loading'); if (mm) mm.res = 'warm'; r.i.slots[1] = r.i.slots[1]; ctx.rerender(); ctx.toast(esc(model) + ' ready on ' + esc(target) + ': first token 0.6 s, measured 8.1 GB.', 'ok'); }, 3500);
          });
        } });
      };
      ctx.on('click', '[data-load]', () => loadModal());
      if (st.openLoad) { st.openLoad = false; setTimeout(() => loadModal(), 30); }

      const drainFlow = async (instId) => {
        let id = instId;
        if (!id) {
          const picked = await new Promise((resolve) => ctx.modal({ title: 'Drain instance', body: UI.field('Instance', UI.select(allInst.map((x) => x.id), 'gpu-large-1/1', 'data-target')) + UI.notice('New requests route to other instances at once. In-flight streams finish, then models unload with keep_alive 0 and the instance is free for an upgrade or a training window.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Drain', { attrs: 'data-do', kind: 'primary' }), onMount(m) { m.querySelector('[data-do]').addEventListener('click', () => { const v = m.querySelector('[data-target]').value; App.closeOverlay(); resolve(v); }); } }));
          id = picked;
        } else {
          const r = find(id);
          if (r.i.health === 'draining') { r.i.health = 'healthy'; r.i.models.forEach((m) => { if (m.res === 'draining') m.res = 'warm'; }); ctx.rerender(); ctx.toast(esc(id) + ' back in rotation.', 'ok'); return; }
          const ok = await ctx.confirm({ title: 'Drain ' + id, tag: 'drain', tone: 'warn', body: '<p style="margin:0" class="fg2">New requests route elsewhere; in-flight streams finish; models unload with keep_alive 0.</p>', kv: [['In flight', String(r.i.slots[0])], ['Pinned models', String(r.i.models.filter((m) => m.res === 'pinned').length)]], ok: 'Drain' });
          if (!ok) return;
        }
        if (!id) return; const r = find(id); r.i.health = 'draining'; r.i.models.forEach((m) => { m.res = 'draining'; }); r.i.queue = 0; ctx.rerender(); ctx.toast('Draining ' + esc(id) + '. ' + r.i.slots[0] + ' streams finishing; new requests route to other instances.', 'warn', 5000);
      };
      ctx.on('click', '[data-drain]', () => drainFlow());

      ctx.on('click', '[data-swap]', () => ctx.modal({ title: 'Schedule swap on gpu-large', body: '<div class="formgrid" style="--cols:2">' + UI.field('Profile', UI.select(['analyst', 'general-8b', 'coder-32b', 'vision'], 'analyst')) + UI.field('New version', UI.select(['qwen2.5:32b-q4_K_M, sha256:c07e.. (evaluated)', 'qwen2.5:32b-q5_K_M, sha256:88e1.. (draft)'], 'qwen2.5:32b-q4_K_M, sha256:c07e.. (evaluated)')) + UI.field('Strategy', UI.select(['blue/green, canary 10% first', 'blue/green, flip immediately', 'scheduled: coder by day, batch model at night'], 'blue/green, canary 10% first')) + UI.field('Window', UI.select(['02:00 low-traffic window', 'now, if memory allows', 'next training window close, 06:00'], '02:00 low-traffic window', 'data-window')) + UI.field('Keep old version warm', UI.select(['24 h', '4 h', 'until next swap'], '24 h')) + UI.field('Ollama upgrade first', UI.select(['no', 'yes, to 0.33.0'], 'no')) + '</div>' + UI.notice('The new version loads on spare capacity, the profile pointer flips atomically, in-flight streams finish on the old version, and the old one unloads with keep_alive 0. Rollback moves the pointer back while the old version is still warm.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Schedule', { kind: 'primary', attrs: 'data-do' }), onMount(m) { m.querySelector('[data-do]').addEventListener('click', () => { const w = m.querySelector('[data-window]').value; App.closeOverlay(); st.scheduled = 'analyst to qwen2.5:32b@c07e, ' + w; ctx.rerender(); ctx.toast('Swap scheduled for analyst at ' + esc(w) + '. Profiles shows the pointer once it flips.', 'ok', 5000); }); } }));
      ctx.on('click', '[data-roll]', async () => {
        const ok = await ctx.confirm({ title: 'Roll Ollama upgrade on gpu-large', tag: '0.32.6 to 0.33.0', tone: 'info', body: '<p style="margin:0" class="fg2">One instance at a time, starting with the canary instance gpu-large-2/0 (already on 0.33.0). Each instance drains, upgrades from the internal OCI registry, reloads its pinned models and passes a warm-up before the next starts.</p>', kv: [['Image', '<span class="mono">harbor.northwind.local/ollama/ollama:0.33.0</span>'], ['Signature', UI.pill('verified, cosign', 'ok')]], ok: 'Start rollout' });
        if (!ok) return; st.rolling = true; const seq = ['gpu-large-1/0', 'gpu-large-1/1']; ctx.rerender(); ctx.toast('Rollout started on gpu-large.', 'ok');
        seq.forEach((id, n) => { setTimeout(() => { const r = find(id); r.i.health = 'upgrading'; ctx.rerender(); }, 800 + n * 4000); setTimeout(() => { const r = find(id); r.i.health = id === 'gpu-large-1/1' ? 'swapping' : 'healthy'; r.i.ollama = '0.33.0'; if (n === seq.length - 1) st.rolling = false; ctx.rerender(); ctx.toast(esc(id) + ' on 0.33.0, pinned models reloaded, warm-up passed.', 'ok'); }, 3800 + n * 4000); });
      });
    }
  });
})();
