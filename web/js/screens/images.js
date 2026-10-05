(function () {
  // Images, backed by /api/images: prompts pass the image guardrail checkpoint and the GPU-second quota before any
  // job is queued; each image is a job on a ComfyUI or diffusers worker whose real queue position and denoising step
  // arrive over the socket (image.job). Finished images carry a signed provenance manifest and are sealed at rest.
  const { UI, esc } = App;

  const SIZES = ['1024 x 768', '768 x 768', '1024 x 1024', '1536 x 1024'];
  const COUNTS = ['1', '2', '4', '8'];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const enc = encodeURIComponent;
  const S = () => App.stateFor('images');
  const visible = () => App.state.route === 'images';
  const secs = (ms) => (ms == null ? null : Math.max(1, Math.round(ms / 1000)));
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
  const ACTIVE = { queued: 1, running: 1 };

  // ---------- live updates ----------
  const live = { sock: null, handler: null, timer: null };
  function detach() {
    if (live.sock && live.handler) live.sock.off('image.job', live.handler);
    live.sock = null; live.handler = null;
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  }
  /** Re-renders at most every 300 ms, never while a dialog is open (a re-render would close it). */
  function schedule() {
    if (live.timer) return;
    live.timer = setTimeout(() => {
      live.timer = null;
      if (!visible()) return;
      if (document.getElementById('overlay')) { schedule(); return; }
      App.render();
    }, 300);
  }
  function attach() {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.handler = (d) => {
      if (!visible()) { detach(); return; }
      const st = S(); const img = (st.images || []).find((x) => x.id === d.id);
      if (!img) return;
      Object.keys(d).forEach((k) => { if (d[k] != null) img[k] = d[k]; });
      if (!ACTIVE[d.state]) refreshOne(d.id);
      schedule();
    };
    live.sock.on('image.job', live.handler);
  }
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'images') detach(); });

  function refreshOne(id) {
    Promise.all([App.get('/api/images/' + enc(id)), App.get('/api/images/quota')]).then(([img, quota]) => {
      const st = S(); const i = (st.images || []).findIndex((x) => x.id === id);
      if (i >= 0) st.images[i] = img;
      st.quota = quota; schedule();
    }).catch(() => undefined);
  }
  /** Queue positions change as other jobs finish: refresh the waiting ones every few seconds while any wait. */
  function pollQueue() {
    const st = S();
    if (st.pollTimer || !(st.images || []).some((x) => ACTIVE[x.state])) return;
    st.pollTimer = setTimeout(() => {
      st.pollTimer = null;
      if (!visible()) return;
      App.get('/api/images').then((list) => { st.images = list; schedule(); pollQueue(); }).catch(() => pollQueue());
    }, 4000);
  }

  App.register({
    id: 'images', title: 'Images', live: true, summary: 'Prompt, provider, honest job progress, safety and provenance, quota',
    label: (st) => { const sel = (st.images || []).find((c) => c.id === st.sel) || (st.images || [])[0]; return sel ? sel.label : null; },
    commands: [{ label: 'Generate an image', sub: 'Images', run() { const el = document.querySelector('#images-prompt'); if (el) el.focus(); } }],
    states: [
      { title: 'Prompt blocked', tone: 'danger', text: 'The prompt failed the safety rule before any GPU time was spent. Shows the rule and a report link.', apply(ctx) {
        if (ctx.state.blocked) { ctx.rerender(); return; }
        ctx.toast('<span>No prompt has been blocked in this session. When the image guardrail checkpoint refuses one, the rule and a report link appear under the prompt and no job is queued.</span>', '', 7000);
      } },
      { title: 'Quota exhausted', tone: 'warn', text: 'Generate is disabled with the reset date and who can raise the limit.', apply(ctx) {
        const q = ctx.state.quota;
        if (q && q.limit != null && q.used >= q.limit) { ctx.rerender(); return; }
        ctx.toast('<span>The GPU-second quota has room' + (q ? ': ' + esc(q.used.toLocaleString()) + (q.limit != null ? ' of ' + esc(q.limit.toLocaleString()) : ', no limit set') + ' this month' : '') + '. When it runs out, Generate is disabled until the reset.</span>', '', 6000);
      } },
      { title: 'Honest waiting', tone: 'neutral', text: 'Queue position and the real stage are shown. No indeterminate spinner and no invented percentage.', apply(ctx) {
        const st = ctx.state; st.honest = true;
        const w = (st.images || []).find((x) => ACTIVE[x.state]); if (w) st.sel = w.id; ctx.rerender();
      } },
      { title: 'Download', tone: 'neutral', text: 'Downloads carry the provenance manifest and show the label warning for confidential and above.', apply(ctx) {
        const st = ctx.state; const done = (st.images || []).filter((x) => x.state === 'succeeded');
        const pick = done.find((x) => x.label === 'confidential' || x.label === 'restricted') || done[0];
        if (!pick) { ctx.toast('<span>No finished image yet. Generate one to download it with its manifest.</span>', '', 5000); return; }
        st.sel = pick.id; st.openDownload = true; ctx.rerender();
      } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      if (ctx.params.job) { st.sel = ctx.params.job; delete ctx.params.job; }
      if (st.prompt == null) st.prompt = '';
      st.size = st.size || '1024 x 768'; st.count = st.count || '1'; st.label = st.label || 'internal';

      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/images/backends'), App.get('/api/images/quota'), App.get('/api/images')])
          .then(([b, quota, images]) => { Object.assign(st, { backends: b.backends, safety: b.safety, quota, images, loaded: true, loadError: null }); attach(); pollQueue(); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; schedule(); });
      };
      if (!st.loaded && !st.loadError) load();
      if (!st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Images', 'Jobs run one per GPU on the image pool and never evict chat models') + (st.loadError ? UI.problem('Images could not be loaded', st.loadError.message, (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      attach(); pollQueue();

      const backends = st.backends || [];
      if (!st.provider || !backends.some((b) => b.id === st.provider)) st.provider = backends[0] ? backends[0].id : '';
      const provider = backends.find((b) => b.id === st.provider);
      const cards = st.images || [];
      const sel = cards.find((c) => c.id === st.sel) || cards[0] || null;
      if (sel) st.sel = sel.id;
      const q = st.quota || { used: 0, limit: null };
      const quotaOut = q.limit != null && q.used >= q.limit;
      const pct = q.limit ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
      const canGenerate = !!provider && !quotaOut && st.prompt.trim().length > 0 && !st.sending;
      const myLabels = LABELS.filter((l) => !App.me || LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance));
      const backendLabel = (id) => { const b = backends.find((x) => x.id === id); return b ? b.label : id; };
      const safetyText = (c) => (c.safety ? 'passed, ' + c.safety.score.toFixed(2) + ' score' : 'not classified: no image-safety classifier is configured');
      const waitText = (c) => (c.etaMs != null ? 'about ' + secs(c.etaMs) + ' s, from the last jobs on this worker' : 'no recent jobs on this worker to estimate from');

      const card = (c) => {
        const on = sel && c.id === sel.id;
        let body;
        if (c.state === 'succeeded') body = '<div class="images-pic"><img src="/api/images/' + enc(c.id) + '/image" alt="Generated image, seed ' + esc(c.seed) + '" loading="lazy"></div><div class="hstack" style="padding:8px 10px"><span class="muted" style="font-size:12px">generated image</span><span class="right hstack gap6">' + (c.safety ? UI.pill('safe', 'ok') : UI.pill('not classified', 'outline')) + '<span class="muted" style="font-size:12px">signed</span></span></div>';
        else if (c.state === 'running') body = '<div class="images-mid"><div class="vstack" style="width:100%">' + (c.step && c.steps ? UI.meter((c.stage || 'Denoising') + ', step ' + c.step + ' of ' + c.steps, Math.round((c.step / c.steps) * 100) + '%', (c.step / c.steps) * 100, 'accent') : '<span class="fg2">' + esc(c.stage || 'Starting') + '</span><span class="muted" style="font-size:12px">The worker reports steps once denoising starts.</span>') + '<span class="muted" style="font-size:12px">' + esc(c.node || backendLabel(c.backend)) + ' · one job per GPU</span></div></div>';
        else if (c.state === 'queued') body = '<div class="images-mid"><div class="vstack gap4"><span class="fg2">Position ' + esc(c.position || 1) + ' in queue</span><span class="muted" style="font-size:12px">' + esc(waitText(c)) + '</span></div></div>';
        else if (c.state === 'withheld') body = '<div class="images-mid"><div class="vstack gap4"><span style="color:var(--danger-fg)">' + (c.safety ? 'Withheld by the image-safety classifier' : 'Withheld: no image-safety classifier is configured') + '</span><span class="muted" style="font-size:12px">' + (c.safety ? 'Not stored. Raised to reviewers.' : 'Not stored. This server requires a classifier before images are kept.') + '</span></div></div>';
        else body = '<div class="images-mid"><div class="vstack gap4"><span class="' + (c.state === 'failed' ? '' : 'fg2') + '" style="' + (c.state === 'failed' ? 'color:var(--danger-fg)' : '') + '">' + (c.state === 'failed' ? 'Failed' : 'Cancelled') + '</span><span class="muted" style="font-size:12px">' + esc(c.error || (c.state === 'cancelled' ? 'Nothing is stored.' : '')) + '</span></div></div>';
        return '<button type="button" class="images-card' + (on ? ' on' : '') + '" data-card="' + esc(c.id) + '" aria-pressed="' + !!on + '">' + body + '</button>';
      };

      const insp = (() => {
        const c = sel;
        if (!c) return UI.empty('No images yet', 'Write a prompt, pick a worker and generate.');
        const common = [['Label', UI.label(c.label, { sm: true })], ['Job', '<span class="mono">' + esc(c.id) + '</span>']];
        if (c.state === 'succeeded') return UI.kv(common.concat([['GPU-seconds', esc(c.gpuSeconds)], ['Seed', '<span class="mono">' + esc(c.seed) + '</span>'], ['Provenance', 'manifest signed by Exprsn-AI, in the file and beside it'], ['Safety', esc(safetyText(c))]]), 1)
          + '<div class="hstack wrap gap6">' + UI.btn('Send to chat', { attrs: 'data-tochat' + (App.can('chat:write') ? '' : ' disabled title="Needs the chat:write permission"') }) + UI.btn('Vary', { attrs: 'data-vary' }) + UI.btn('Download', { icon: 'download', attrs: 'data-download' }) + '</div>';
        if (c.state === 'running') return UI.kv(common.concat([['Stage', esc(c.stage || 'Starting') + (c.step && c.steps ? ', step ' + c.step + ' of ' + c.steps : '')], ['GPU', esc(c.node || backendLabel(c.backend))], ['Seed', '<span class="mono">' + esc(c.seed) + '</span>'], ['Estimate', 'none beyond the step count; steps are reported by the worker']]), 1) + '<div class="hstack gap6">' + UI.btn('Cancel job', { kind: 'danger', attrs: 'data-cancel' }) + '</div>';
        if (c.state === 'queued') return UI.kv(common.concat([['Queue', 'position ' + esc(c.position || 1) + ' on ' + esc(backendLabel(c.backend))], ['Wait', esc(waitText(c))], ['Seed', '<span class="mono">' + esc(c.seed) + '</span>'], ['Provider', esc(backendLabel(c.backend))]]), 1) + '<div class="hstack gap6">' + UI.btn('Cancel job', { kind: 'danger', attrs: 'data-cancel' }) + '</div>';
        if (c.state === 'withheld') return UI.kv(common.concat([['GPU-seconds', esc(c.gpuSeconds) + ', still metered'], ['Safety', '<span style="color:var(--danger-fg)">' + (c.safety ? 'withheld, ' + c.safety.score.toFixed(2) + ' score' : 'withheld, not classified') + '</span>'], ['Stored', 'no'], ['Flag', c.safety ? 'raised to flag reviewers and guardrail admins' : 'none: no classifier looked at it']]), 1)
          + UI.notice('The output failed the image-safety classifier and was discarded on the worker. Only the prompt, the seed and the score are kept for review.', 'danger') + '<div class="hstack gap6">' + UI.btn('Open flags', { attrs: 'data-goflag' }) + UI.btn('Report a false positive', { kind: 'ghost', attrs: 'data-fp' }) + '</div>';
        return UI.kv(common.concat([['State', UI.pill(c.state, c.state === 'failed' ? 'danger' : '')], ['Reason', esc(c.error || '')], ['Seed', '<span class="mono">' + esc(c.seed) + '</span>']]), 1) + '<div class="hstack gap6">' + UI.btn('Try again', { attrs: 'data-vary' }) + '</div>';
      })();

      const blocked = st.blocked;
      root.innerHTML = '<style>'
        + '.images-grid{display:grid;gap:14px;grid-template-columns:repeat(3,minmax(0,1fr))}'
        + '.images-card{display:flex;flex-direction:column;height:250px;padding:0;border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:pointer;text-align:left;font-family:inherit;color:var(--fg);overflow:hidden}.images-card:hover{border-color:var(--muted)}.images-card.on{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-tint)}'
        + '.images-pic{flex-grow:1;min-height:0;background:var(--panel2)}.images-pic img{width:100%;height:100%;object-fit:cover;display:block}.images-mid{flex-grow:1;display:flex;align-items:center;justify-content:center;padding:16px}'
        + '.images-textarea{width:100%;min-height:96px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);font-size:14px;resize:vertical;line-height:1.4;color:var(--fg)}'
        + '@media (max-width:1100px){.images-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:900px){.images-grid{grid-template-columns:1fr}}'
        + '</style>'
        + '<div class="leftpane w320"><div class="eyebrow">Prompt</div>'
        + '<label class="sr" for="images-prompt">Prompt</label><textarea class="images-textarea" id="images-prompt" data-prompt placeholder="Describe the image. Plain descriptions work best.">' + esc(st.prompt) + '</textarea>'
        + (blocked ? UI.notice('<b>Prompt blocked.</b> ' + esc(blocked.detail) + (blocked.rule ? ' Rule <span class="mono">' + esc(blocked.rule) + '</span>.' : '') + ' No GPU time was spent.', 'danger', '<a href="#" data-report>Report</a>')
          : st.passed ? '<div class="hstack gap6" style="font-size:12px;color:var(--ok-fg)">' + UI.icon('check', 13) + (st.passed === 'redacted' ? 'Prompt passed image guardrails after redaction' : 'Prompt passed image guardrails') + '</div>'
            : '<div class="muted" style="font-size:12px">The prompt is checked by the image guardrails before any GPU time is spent.</div>')
        + UI.field('Provider', backends.length ? UI.select(backends.map((b) => ({ value: b.id, label: b.label })), st.provider, 'data-provider') : UI.notice('No image worker is configured. A system admin adds ComfyUI or diffusers workers (IMAGE_BACKENDS).', 'warn'))
        + '<div class="grid2" style="gap:10px">' + UI.field('Size', UI.select(SIZES, st.size, 'data-size')) + UI.field('Count', UI.select(COUNTS, st.count, 'data-count')) + '</div>'
        + UI.field('Label', UI.select(myLabels, st.label, 'data-label'), 'The label of the prompt and the images.')
        + UI.btn(st.sending ? 'Checking the prompt' : 'Generate', { kind: 'primary', cls: 'block', attrs: 'data-generate', disabled: !canGenerate })
        + (quotaOut ? UI.notice('<b>Quota exhausted.</b> Resets ' + esc(day(q.resetsAt)) + '. ' + esc(q.raisedBy ? q.raisedBy.charAt(0).toUpperCase() + q.raisedBy.slice(1) : 'An admin') + ' can raise the limit under ' + (q.scope === 'workspace' ? 'Tenants' : 'Tenants, for this tenant') + '.', 'warn', '<a href="#" data-gousage>Usage</a>') : '')
        + '<div class="eyebrow" style="margin-top:6px">Quota this month</div>' + UI.meter('GPU-seconds', q.used.toLocaleString() + (q.limit != null ? ' of ' + q.limit.toLocaleString() : ', no limit set'), pct, pct >= 100 ? 'danger' : pct >= 70 ? 'warn' : '')
        + '<div class="muted" style="font-size:12px">Metered per ' + esc(q.scope || 'tenant') + ' in GPU-seconds. Withheld outputs still count.</div></div>'
        + '<div class="page">' + UI.pagehead('Images', 'Jobs run one per GPU on the image pool and never evict chat models')
        + (st.honest ? UI.notice('<b>Honest waiting.</b> Each card shows its queue position or the real denoising step reported by the worker. There is no spinner and no invented percentage.', 'info') : '')
        + (cards.length ? '<div class="images-grid">' + cards.map(card).join('') + '</div>' : UI.empty('No images yet', provider ? 'Write a prompt and generate. Each image is one job on ' + esc(provider.label) + '.' : 'An image worker has to be configured first.'))
        + '</div>'
        + '<aside class="inspector w300" aria-label="Inspector"><div class="eyebrow">Selected image</div>' + insp
        + (sel ? '<div class="divider"></div><div class="eyebrow">Prompt</div><div class="fg2" style="font-size:12px">' + esc(sel.prompt || '') + '</div>' + UI.kv([['Size', esc(sel.width + ' x ' + sel.height)], ['Provider', esc(backendLabel(sel.backend).split(',')[0])]], 2) : '') + '</aside>';

      // ---- events ----
      ctx.on('click', '[data-card]', (e, t) => { st.sel = t.dataset.card; ctx.rerender(); });
      ctx.on('input', '[data-prompt]', (e, t) => {
        st.prompt = t.value; if (st.blocked) { st.blocked = null; } st.passed = null;
        const b = ctx.$('[data-generate]'); if (b) { if (t.value.trim() && provider && !quotaOut) b.removeAttribute('disabled'); else b.setAttribute('disabled', ''); }
      });
      ctx.on('change', '[data-provider]', (e, t) => { st.provider = t.value; ctx.rerender(); });
      ctx.on('change', '[data-size]', (e, t) => { st.size = t.value; });
      ctx.on('change', '[data-count]', (e, t) => { st.count = t.value; });
      ctx.on('change', '[data-label]', (e, t) => { st.label = t.value; });
      ctx.on('click', '[data-gousage]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
      ctx.on('click', '[data-goflag]', () => ctx.navigate('flags'));

      const put = (list) => { list.forEach((img) => { const i = cards.findIndex((x) => x.id === img.id); if (i >= 0) cards[i] = img; else cards.unshift(img); }); st.images = cards.slice().sort((a, b) => b.createdAt - a.createdAt); };
      ctx.on('click', '[data-generate]', async () => {
        // The prompt is read live: typing enables the button without a re-render.
        if (!provider || quotaOut || st.sending || !st.prompt.trim()) return;
        const wh = st.size.split(' x ').map(Number);
        st.sending = true; ctx.rerender();
        try {
          const r = await App.post('/api/images', { prompt: st.prompt, backend: st.provider, width: wh[0], height: wh[1], count: Number(st.count), label: st.label });
          put(r.images); st.sel = r.images[0].id; st.blocked = null; st.passed = r.redacted ? 'redacted' : 'passed';
          toast(r.images.length + ' image.generate job' + (r.images.length > 1 ? 's' : '') + ' queued on ' + esc(provider.label) + '. Progress arrives over the socket.', 'ok');
          pollQueue();
        } catch (err) {
          const p = err.problem || {};
          if (err.status === 422) { st.blocked = { detail: p.detail || err.message, rule: p.rule || null }; toast('Prompt blocked by the image guardrails. No GPU time spent.', 'danger'); }
          else if (err.status === 429) { App.get('/api/images/quota').then((qq) => { st.quota = qq; schedule(); }).catch(() => undefined); App.fail(err, 'Quota exhausted'); }
          else App.fail(err, 'Could not queue the images');
        } finally { st.sending = false; ctx.rerender(); }
      });
      ctx.on('click', '[data-report]', (e) => {
        e.preventDefault();
        const b = st.blocked || {};
        ctx.modal({ title: 'Report a blocked prompt', body: UI.kv([['Rule', '<span class="mono">' + esc(b.rule || 'not named') + '</span>'], ['Reason', esc(b.detail || '')], ['Prompt', esc(st.prompt)]], 1) + UI.field('Why should this have been allowed?', UI.textarea('', { rows: 3, placeholder: 'The reviewer sees the prompt, the rule and this note.', attrs: 'data-note' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send to flag queue', { kind: 'primary', attrs: 'data-go' }),
          onMount(m) { m.querySelector('[data-go]').addEventListener('click', async () => { const note = m.querySelector('[data-note]').value; App.closeOverlay(); try { const r = await App.post('/api/images/report', { kind: 'prompt', rule: b.rule || null, note }); toast('Report filed as a false-positive candidate. ' + r.notified + ' reviewer' + (r.notified === 1 ? '' : 's') + ' notified.', 'ok'); } catch (err) { App.fail(err, 'Could not file the report'); } }); } });
      });
      ctx.on('click', '[data-cancel]', async () => {
        if (!sel) return;
        const ok = await ctx.confirm({ title: 'Cancel ' + sel.id, tag: 'cancel', tone: 'danger', body: '<p class="fg2" style="margin:0">' + (sel.state === 'running' ? 'The worker stops and the GPU slot is released. Time already spent is metered.' : 'The job leaves the queue. Nothing is metered.') + '</p>', ok: 'Cancel job', cancel: 'Keep it' });
        if (!ok) return;
        try { put([await App.post('/api/images/' + enc(sel.id) + '/cancel')]); toast('Job cancelled. ' + (sel.state === 'running' ? 'The GPU slot is released.' : 'Nothing was metered.')); ctx.rerender(); } catch (err) { App.fail(err, 'Could not cancel'); }
      });
      ctx.on('click', '[data-vary]', async () => {
        if (!sel) return;
        try { const r = await App.post('/api/images/' + enc(sel.id) + '/vary'); put(r.images); st.sel = r.images[0].id; toast('Variation queued with seed ' + esc(r.images[0].seed) + ' and the same prompt.'); pollQueue(); ctx.rerender(); }
        catch (err) { if (err.status === 422) { st.blocked = { detail: (err.problem || {}).detail || err.message, rule: (err.problem || {}).rule || null }; ctx.rerender(); } App.fail(err, 'Could not queue the variation'); }
      });
      ctx.on('click', '[data-tochat]', async () => {
        if (!sel) return;
        try {
          let a = await App.post('/api/images/' + enc(sel.id) + '/attach');
          toast('Image attached with its ' + esc(sel.label) + ' label; it is scanned like any upload. Opening chat.', 'ok');
          // The scan usually takes a moment: wait for it (briefly) so chat opens with the attachment's real state.
          for (let i = 0; i < 8 && (a.state === 'quarantined' || a.state === 'scanning'); i++) {
            await new Promise((r) => setTimeout(r, 500));
            try { a = await App.get('/api/attachments/' + enc(a.id)); } catch (err) { break; }
          }
          // The chat screen keeps attachments waiting for the next message in its own state, keyed for removal.
          const cs = App.stateFor('chat'); cs.pending = (cs.pending || []).concat([Object.assign({ key: 'k' + Math.random().toString(36).slice(2) }, a)]);
          ctx.navigate('chat');
        } catch (err) { App.fail(err, 'Could not send the image to chat'); }
      });
      ctx.on('click', '[data-fp]', async () => {
        if (!sel) return;
        try { const r = await App.post('/api/images/report', { kind: 'output', imageId: sel.id, note: '' }); toast('False-positive report sent to ' + r.notified + ' reviewer' + (r.notified === 1 ? '' : 's') + '.', 'ok'); } catch (err) { App.fail(err, 'Could not file the report'); }
      });
      const openDownload = () => {
        const c = sel; if (!c || c.state !== 'succeeded') return;
        const high = c.label === 'confidential' || c.label === 'restricted';
        const file = 'image-' + c.id.toLowerCase() + '.png';
        ctx.modal({ title: 'Download ' + UI.label(c.label, { sm: true }), body: (high ? UI.notice('<b>This image is ' + esc(c.label) + '.</b> Downloading copies it outside the console. The download is written to the audit log with your name and the trace ID.', 'warn') : '')
          + UI.kv([['File', '<span class="mono">' + esc(file) + '</span>'], ['Size', esc(c.width + ' x ' + c.height)], ['Provenance', '<span data-prov>checking the signature…</span>'], ['Label', UI.label(c.label, { sm: true }) + ' <span class="muted">in the manifest and the sidecar</span>'], ['Safety', esc(safetyText(c))], ['Seed', '<span class="mono">' + esc(c.seed) + '</span>']], 2),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(high ? 'Download and log' : 'Download', { kind: 'primary', icon: 'download', attrs: 'data-go' }),
          onMount(m) {
            App.get('/api/images/' + enc(c.id) + '/provenance').then((v) => { const el = m.querySelector('[data-prov]'); if (el) el.innerHTML = v.verified ? 'manifest embedded, signature verified' : '<span style="color:var(--danger-fg)">manifest does not verify' + (v.signature ? '' : ': bad signature') + (v.bytesMatch ? '' : ': the pixels changed') + '</span>'; }).catch(() => { const el = m.querySelector('[data-prov]'); if (el) el.textContent = 'could not be checked'; });
            m.querySelector('[data-go]').addEventListener('click', () => {
              const a = document.createElement('a'); a.href = '/api/images/' + enc(c.id) + '/download'; a.download = file; document.body.appendChild(a); a.click(); a.remove();
              App.closeOverlay(); toast('Downloaded with the provenance manifest.' + (high ? ' Audit entry written.' : ''), 'ok');
            });
          } });
      };
      ctx.on('click', '[data-download]', openDownload);
      if (st.openDownload) { st.openDownload = false; setTimeout(openDownload, 50); }
    }
  });
})();
