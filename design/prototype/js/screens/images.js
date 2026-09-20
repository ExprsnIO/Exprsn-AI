(function () {
  const { UI, esc } = App;

  const PROMPT = 'Isometric line drawing of a warehouse loading bay, two trucks, neutral palette, for a logistics training slide';
  const PROVIDERS = [{ value: 'comfyui-sdxl', label: 'comfyui, sdxl-base workflow' }, { value: 'comfyui-sdxl-turbo', label: 'comfyui, sdxl-turbo workflow' }, { value: 'diffusers-sdxl', label: 'diffusers, sdxl-base (Python worker)' }];
  const SIZES = ['1024 x 768', '768 x 768', '1024 x 1024', '1536 x 1024'];
  const COUNTS = ['1', '2', '4', '8'];
  const QUOTA = { used: 1480, limit: 2000, reset: '1 Oct' };

  // the six cards on the board, in order
  const CARDS0 = [
    { id: 'image.generate.91c0', kind: 'done', seed: 2087734121, gpu: 11.4, label: 'internal', safety: 0.02, prompt: PROMPT, size: '1024 x 768', node: 'gpu-image-1' },
    { id: 'image.generate.91c1', kind: 'done', seed: 2087734122, gpu: 11.1, label: 'internal', safety: 0.03, prompt: PROMPT, size: '1024 x 768', node: 'gpu-image-1' },
    { id: 'image.generate.91c2', kind: 'progress', stage: 'Denoising', step: 18, steps: 40, node: 'gpu-image-1', seed: 2087734123, label: 'internal', prompt: PROMPT, size: '1024 x 768' },
    { id: 'image.generate.91c3', kind: 'queued', position: 2, eta: 'about 40 s', seed: 2087734124, label: 'internal', prompt: PROMPT, size: '1024 x 768' },
    { id: 'image.generate.91b7', kind: 'withheld', flag: 'F-2294', seed: 1188420553, gpu: 12.0, label: 'internal', safety: 0.81, prompt: 'Photo-real portrait of the Northwind CFO presenting the Q3 numbers', size: '1024 x 1024', node: 'gpu-image-2' },
    { id: 'image.generate.90aa', kind: 'done', seed: 774120099, gpu: 18.6, label: 'confidential', safety: 0.01, prompt: 'Cover illustration for the Q3 finance review pack, abstract chart shapes, restrained palette', size: '1536 x 1024', node: 'gpu-image-2' }
  ];

  // deterministic abstract composition from the seed, theme colours only, with a visible "generated" watermark
  const svgImage = (seed, w, h) => {
    let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const fills = ['var(--accent)', 'var(--info-fg)', 'var(--ok-fg)', 'var(--fg2)', 'var(--warn-fg)', 'var(--muted)'];
    let out = '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%;display:block" role="img" aria-label="Generated image placeholder"><rect width="' + w + '" height="' + h + '" fill="var(--panel2)"/>';
    // ground and horizon
    out += '<rect x="0" y="' + Math.round(h * 0.62) + '" width="' + w + '" height="' + h + '" fill="var(--sel)"/>';
    const n = 5 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const f = fills[Math.floor(rnd() * fills.length)]; const op = (0.35 + rnd() * 0.45).toFixed(2);
      const x = Math.round(rnd() * w * 0.85), y = Math.round(h * 0.15 + rnd() * h * 0.55), bw = Math.round(w * (0.12 + rnd() * 0.3)), bh = Math.round(h * (0.1 + rnd() * 0.35));
      const t = rnd();
      if (t < 0.45) out += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + bh + '" rx="' + Math.round(rnd() * 12) + '" fill="' + f + '" opacity="' + op + '"/>';
      else if (t < 0.75) out += '<circle cx="' + (x + bw / 2) + '" cy="' + (y + bh / 2) + '" r="' + Math.round(Math.min(bw, bh) / 2) + '" fill="' + f + '" opacity="' + op + '"/>';
      else out += '<polygon points="' + x + ',' + (y + bh) + ' ' + (x + bw / 2) + ',' + y + ' ' + (x + bw) + ',' + (y + bh) + '" fill="' + f + '" opacity="' + op + '"/>';
    }
    // isometric line hints
    for (let i = 0; i < 4; i++) { const x = Math.round(rnd() * w), y = Math.round(rnd() * h); out += '<path d="M' + x + ' ' + y + ' l' + Math.round(w * 0.25) + ' ' + Math.round(-h * 0.14) + ' l' + Math.round(w * 0.25) + ' ' + Math.round(h * 0.14) + '" fill="none" stroke="var(--fg2)" stroke-width="2" opacity=".5"/>'; }
    out += '<g><rect x="' + (w / 2 - 53) + '" y="' + (h - 30) + '" width="106" height="20" rx="4" fill="var(--fg)" opacity=".8"/><text x="' + (w / 2) + '" y="' + (h - 16) + '" text-anchor="middle" font-size="12" font-weight="700" letter-spacing="1" fill="var(--bg)" font-family="var(--sans)">GENERATED</text></g></svg>';
    return out;
  };

  App.register({
    id: 'images', title: 'Images', summary: 'Prompt, provider, honest job progress, safety and provenance, quota',
    label: (st) => { const sel = ((st.cards || CARDS0).find((c) => c.id === st.sel) || CARDS0[0]); return sel.label; },
    commands: [{ label: 'Generate an image', sub: 'Images', run(app) { const el = document.querySelector('#images-prompt'); if (el) el.focus(); } }],
    states: [
      { title: 'Prompt blocked', tone: 'danger', text: 'The prompt failed the safety rule before any GPU time was spent. Shows the rule and a report link.', apply(ctx) { ctx.state.blocked = true; ctx.state.quotaOut = false; ctx.state.prompt = 'Photo-real portrait of the Northwind CFO presenting the Q3 numbers'; ctx.rerender(); } },
      { title: 'Quota exhausted', tone: 'warn', text: 'Generate is disabled with the reset date and who can raise the limit.', apply(ctx) { ctx.state.quotaOut = true; ctx.state.blocked = false; ctx.rerender(); } },
      { title: 'Honest waiting', tone: 'neutral', text: 'Queue position and the real stage are shown. No indeterminate spinner and no invented percentage.', apply(ctx) { ctx.state.honest = true; ctx.state.sel = 'image.generate.91c2'; ctx.rerender(); } },
      { title: 'Download', tone: 'neutral', text: 'Downloads carry the provenance manifest and show the label warning for confidential and above.', apply(ctx) { ctx.state.sel = 'image.generate.90aa'; ctx.state.openDownload = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.cards = st.cards || CARDS0.map((c) => Object.assign({}, c));
      if (ctx.params.job) { st.sel = ctx.params.job; delete ctx.params.job; }
      st.sel = st.sel || CARDS0[0].id; st.prompt = st.prompt == null ? PROMPT : st.prompt;
      st.provider = st.provider || 'comfyui-sdxl'; st.size = st.size || '1024 x 768'; st.count = st.count || '4'; st.used = st.used == null ? QUOTA.used : st.used;
      const cards = st.cards; const sel = cards.find((c) => c.id === st.sel) || cards[0];
      const used = st.quotaOut ? QUOTA.limit : st.used; const pct = Math.round((used / QUOTA.limit) * 100);
      const canGenerate = !st.blocked && !st.quotaOut && st.prompt.trim().length > 0;

      const card = (c) => {
        const on = c.id === sel.id;
        let body;
        if (c.kind === 'done') body = '<div class="images-pic">' + svgImage(c.seed, 300, 300) + '</div><div class="hstack" style="padding:8px 10px"><span class="muted" style="font-size:12px">generated image</span><span class="right hstack gap6">' + UI.pill('safe', 'ok') + '<span class="muted" style="font-size:12px">C2PA signed</span></span></div>';
        else if (c.kind === 'progress') body = '<div class="images-mid"><div class="vstack" style="width:100%">' + UI.meter(c.stage + ', step ' + c.step + ' of ' + c.steps, Math.round((c.step / c.steps) * 100) + '%', (c.step / c.steps) * 100, 'accent') + '<span class="muted" style="font-size:12px">' + esc(c.node) + ' · prefetch 1, one job per GPU</span></div></div>';
        else if (c.kind === 'queued') body = '<div class="images-mid"><div class="vstack gap4"><span class="fg2">Position ' + c.position + ' in queue</span><span class="muted" style="font-size:12px">' + esc(c.eta) + ', from the last ' + (c.position + 1) + ' jobs on the image pool</span></div></div>';
        else body = '<div class="images-mid"><div class="vstack gap4"><span style="color:var(--danger-fg)">Withheld by the image-safety classifier</span><span class="muted" style="font-size:12px">Not stored. Flag raised.</span></div></div>';
        return '<button type="button" class="images-card' + (on ? ' on' : '') + '" data-card="' + esc(c.id) + '" aria-pressed="' + on + '">' + body + '</button>';
      };

      const insp = (() => {
        const c = sel;
        const common = [['Label', UI.label(c.label, { sm: true })], ['Job', '<span class="mono">' + esc(c.id) + '</span>']];
        if (c.kind === 'done') return UI.kv(common.concat([['GPU-seconds', String(c.gpu)], ['Seed', '<span class="mono">' + c.seed + '</span>'], ['Provenance', 'C2PA manifest, signed by Exprsn-AI'], ['Safety', 'passed, ' + c.safety.toFixed(2) + ' score']]), 1)
          + '<div class="hstack wrap gap6">' + UI.btn('Send to chat', { attrs: 'data-tochat' }) + UI.btn('Vary', { attrs: 'data-vary' }) + UI.btn('Download', { icon: 'download', attrs: 'data-download' }) + '</div>';
        if (c.kind === 'progress') return UI.kv(common.concat([['Stage', esc(c.stage) + ', step ' + c.step + ' of ' + c.steps], ['GPU', esc(c.node)], ['Seed', '<span class="mono">' + c.seed + '</span>'], ['Estimate', 'none beyond the step count; steps are reported by the worker']]), 1) + '<div class="hstack gap6">' + UI.btn('Cancel job', { kind: 'danger', attrs: 'data-cancel' }) + '</div>';
        if (c.kind === 'queued') return UI.kv(common.concat([['Queue', 'position ' + c.position + ' on the image pool'], ['Wait', esc(c.eta) + ', measured from recent jobs'], ['Seed', '<span class="mono">' + c.seed + '</span>'], ['Provider', esc((PROVIDERS.find((p) => p.value === st.provider) || PROVIDERS[0]).label)]]), 1) + '<div class="hstack gap6">' + UI.btn('Cancel job', { kind: 'danger', attrs: 'data-cancel' }) + '</div>';
        return UI.kv(common.concat([['GPU-seconds', String(c.gpu) + ', still metered'], ['Safety', '<span style="color:var(--danger-fg)">withheld, ' + c.safety.toFixed(2) + ' score</span>'], ['Stored', 'no'], ['Flag', '<a href="#" data-goflag="' + esc(c.flag) + '">' + esc(c.flag) + '</a>, open in the review queue']]), 1)
          + UI.notice('The output failed the image-safety classifier and was discarded on the worker. Only the prompt, the seed and the score are kept for review.', 'danger') + '<div class="hstack gap6">' + UI.btn('Open flag', { attrs: 'data-goflag="' + esc(c.flag) + '"' }) + UI.btn('Report a false positive', { kind: 'ghost', attrs: 'data-fp' }) + '</div>';
      })();

      root.innerHTML = '<style>'
        + '.images-grid{display:grid;gap:14px;grid-template-columns:repeat(3,minmax(0,1fr))}'
        + '.images-card{display:flex;flex-direction:column;height:250px;padding:0;border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:pointer;text-align:left;font-family:inherit;color:var(--fg);overflow:hidden}.images-card:hover{border-color:var(--muted)}.images-card.on{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-tint)}'
        + '.images-pic{flex-grow:1;min-height:0;background:var(--panel2)}.images-mid{flex-grow:1;display:flex;align-items:center;justify-content:center;padding:16px}'
        + '.images-textarea{width:100%;min-height:96px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);font-size:14px;resize:vertical;line-height:1.4;color:var(--fg)}'
        + '@media (max-width:1100px){.images-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:900px){.images-grid{grid-template-columns:1fr}}'
        + '</style>'
        + '<div class="leftpane w320"><div class="eyebrow">Prompt</div>'
        + '<label class="sr" for="images-prompt">Prompt</label><textarea class="images-textarea" id="images-prompt" data-prompt>' + esc(st.prompt) + '</textarea>'
        + (st.blocked ? UI.notice('<b>Prompt blocked.</b> Rule <span class="mono">no-real-person-likeness</span> in Finance baseline v12 matched before any GPU time was spent.', 'danger', '<a href="#" data-report>Report</a>') : '<div class="hstack gap6" style="font-size:12px;color:var(--ok-fg)">' + UI.icon('check', 13) + 'Prompt passed text guardrails</div>')
        + UI.field('Provider', UI.select(PROVIDERS, st.provider, 'data-provider'))
        + '<div class="grid2" style="gap:10px">' + UI.field('Size', UI.select(SIZES, st.size, 'data-size')) + UI.field('Count', UI.select(COUNTS, st.count, 'data-count')) + '</div>'
        + UI.btn('Generate', { kind: 'primary', cls: 'block', attrs: 'data-generate', disabled: !canGenerate })
        + (st.quotaOut ? UI.notice('<b>Quota exhausted.</b> Resets ' + QUOTA.reset + '. A workspace admin can raise the limit under Usage and audit.', 'warn', '<a href="#" data-gousage>Usage</a>') : '')
        + '<div class="eyebrow" style="margin-top:6px">Quota this month</div>' + UI.meter('GPU-seconds', used.toLocaleString('en-GB') + ' of ' + QUOTA.limit.toLocaleString('en-GB'), pct, pct >= 100 ? 'danger' : pct >= 70 ? 'warn' : '')
        + '<div class="muted" style="font-size:12px">Metered per tenant in GPU-seconds. Withheld outputs still count.</div></div>'
        + '<div class="page">' + UI.pagehead('Images', 'Jobs run one per GPU on the image pool and never evict chat models')
        + (st.honest ? UI.notice('<b>Honest waiting.</b> Each card shows its queue position or the real denoising step reported by the worker. There is no spinner and no invented percentage.', 'info') : '')
        + '<div class="images-grid">' + cards.map(card).join('') + '</div>'
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
        + '<aside class="inspector w300" aria-label="Inspector"><div class="eyebrow">Selected image</div>' + insp
        + '<div class="divider"></div><div class="eyebrow">Prompt</div><div class="fg2" style="font-size:12px">' + esc(sel.prompt) + '</div>' + UI.kv([['Size', esc(sel.size)], ['Provider', esc((PROVIDERS.find((p) => p.value === st.provider) || PROVIDERS[0]).label.split(',')[0])]], 2) + '</aside>';

      // ---- events ----
      ctx.on('click', '[data-card]', (e, t) => { st.sel = t.dataset.card; ctx.rerender(); });
      ctx.on('input', '[data-prompt]', (e, t) => { st.prompt = t.value; st.blocked = false; const b = ctx.$('[data-generate]'); if (b) { if (t.value.trim() && !st.quotaOut) b.removeAttribute('disabled'); else b.setAttribute('disabled', ''); } });
      ctx.on('change', '[data-provider]', (e, t) => { st.provider = t.value; ctx.rerender(); });
      ctx.on('change', '[data-size]', (e, t) => { st.size = t.value; });
      ctx.on('change', '[data-count]', (e, t) => { st.count = t.value; });
      ctx.on('click', '[data-gousage]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
      ctx.on('click', '[data-goflag]', (e, t) => { e.preventDefault(); ctx.navigate('flags', { id: t.dataset.goflag }); });
      ctx.on('click', '[data-report]', (e) => { e.preventDefault(); ctx.modal({ title: 'Report a blocked prompt', body: UI.kv([['Rule', '<span class="mono">no-real-person-likeness</span>'], ['Profile', 'Finance baseline v12'], ['Prompt', esc(st.prompt)]], 1) + UI.field('Why should this have been allowed?', UI.textarea('', { rows: 3, placeholder: 'The reviewer sees the prompt, the rule and this note.' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send to flag queue', { kind: 'primary', attrs: 'data-close data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => ctx.toast('Report filed as a false-positive candidate. A flag reviewer will see it.', 'ok')); } }); });
      ctx.on('click', '[data-generate]', () => {
        if (!canGenerate) return;
        if (/portrait of the northwind cfo|real person|photo-real portrait/i.test(st.prompt)) { st.blocked = true; ctx.rerender(); ctx.toast('Prompt blocked by text guardrails. No GPU time spent.', 'danger'); return; }
        const n = +st.count; const base = 0x91d0 + cards.length;
        for (let i = 0; i < n; i++) { const seed = Math.floor(2000000000 + Math.random() * 100000000); cards.push({ live: true, id: 'image.generate.' + (base + i).toString(16), kind: 'queued', position: i + 1 + cards.filter((c) => c.kind === 'queued').length, eta: 'about ' + (30 + i * 12) + ' s', seed, label: 'internal', prompt: st.prompt, size: st.size, node: 'gpu-image-' + (1 + (i % 2)) }); }
        st.sel = cards[cards.length - n].id; ctx.rerender(); ctx.toast(n + ' image.generate job' + (n > 1 ? 's' : '') + ' queued on the image pool. Progress arrives over /ws.', 'ok');
      });
      ctx.on('click', '[data-cancel]', () => { const i = cards.indexOf(sel); if (i >= 0) cards.splice(i, 1); st.sel = (cards[i] || cards[0]).id; ctx.rerender(); ctx.toast('Job cancelled. ' + (sel.kind === 'progress' ? 'The GPU slot is released.' : 'Nothing was metered.')); });
      ctx.on('click', '[data-tochat]', () => { ctx.toast('Image attached to the conversation with its ' + esc(sel.label) + ' label. Opening chat.', 'ok'); setTimeout(() => ctx.navigate('chat'), 400); });
      ctx.on('click', '[data-vary]', () => { const id = 'image.generate.' + (0x91e0 + cards.length).toString(16); cards.push({ live: true, id, kind: 'queued', position: 1 + cards.filter((c) => c.kind === 'queued').length, eta: 'about 30 s', seed: sel.seed + 1, label: sel.label, prompt: sel.prompt + ', variation', size: sel.size, node: sel.node }); st.sel = id; ctx.rerender(); ctx.toast('Variation queued with seed ' + (sel.seed + 1) + ' and the same prompt.'); });
      ctx.on('click', '[data-fp]', () => { ctx.toast('False-positive report attached to ' + esc(sel.flag) + '.', 'ok'); });
      const openDownload = () => {
        const c = sel; if (c.kind !== 'done') return;
        const high = c.label === 'confidential' || c.label === 'restricted';
        ctx.modal({ title: 'Download ' + UI.label(c.label, { sm: true }), body: (high ? UI.notice('<b>This image is ' + esc(c.label) + '.</b> Downloading copies it outside the console. The export is written to the audit log with your name and the trace ID.', 'warn') : '') + UI.kv([['File', '<span class="mono">' + esc(c.id.replace(/\./g, '-')) + '.png</span>'], ['Size', esc(c.size)], ['Provenance', 'C2PA manifest embedded, signed by Exprsn-AI'], ['Label', UI.label(c.label, { sm: true }) + ' <span class="muted">in the manifest and the sidecar</span>'], ['Safety', 'passed, ' + c.safety.toFixed(2)], ['Trace', '<span class="mono">7e2c19a4b0d84f3e</span>']], 2), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(high ? 'Download and log' : 'Download', { kind: 'primary', icon: 'download', attrs: 'data-close data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => ctx.toast('Downloaded with the provenance manifest.' + (high ? ' Audit entry written.' : ''), 'ok')); } });
      };
      ctx.on('click', '[data-download]', openDownload);
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (st.openDownload) { st.openDownload = false; setTimeout(openDownload, 50); }

      // honest progress ticker: queued jobs move to denoising one per GPU, steps come from the worker
      clearTimeout(st.tick);
      if (cards.some((c) => c.live && (c.kind === 'queued' || c.kind === 'progress'))) {
        st.tick = setTimeout(() => {
          if (App.state.route !== 'images') return;
          const running = cards.filter((c) => c.live && c.kind === 'progress');
          running.forEach((c) => { c.step = Math.min(c.steps, c.step + 4); if (c.step >= c.steps) { c.kind = 'done'; c.gpu = +(10 + Math.random() * 3).toFixed(1); c.safety = +(Math.random() * 0.05).toFixed(2); st.used = Math.min(QUOTA.limit, st.used + Math.round(c.gpu)); } });
          const slots = 2 - cards.filter((c) => c.live && c.kind === 'progress').length;
          cards.filter((c) => c.live && c.kind === 'queued').forEach((c, i) => { if (i < slots) { c.kind = 'progress'; c.stage = 'Denoising'; c.step = 1; c.steps = 40; c.node = c.node || 'gpu-image-1'; } else { c.position = i - slots + 1; c.eta = 'about ' + (30 + (i - slots) * 12) + ' s'; } });
          ctx.rerender();
        }, 1800);
      }
    }
  });
})();
