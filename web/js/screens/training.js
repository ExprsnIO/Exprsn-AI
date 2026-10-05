(function () {
  // Training, backed by /api/training: dataset versions (scrubbed, hashed, sealed), jobs on the GPU training worker
  // with approval, windows, checkpoints and fair-share queueing, evals per hardware class, GGUF packaging and
  // registration as a draft model. Progress and loss points arrive over the socket (train.progress, train.dataset).
  const { UI, esc } = App;

  const enc = encodeURIComponent;
  const S = () => App.stateFor('training');
  const visible = () => App.state.route === 'training';
  const STAGES = ['Dataset', 'Approval', 'Training', 'Evals', 'GGUF convert', 'Registry draft', 'Model admin approval', 'Canary', 'Approved pools'];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const METHODS = { 'LoRA r=16, alpha 32': { kind: 'lora', rank: 16, alpha: 32 }, 'LoRA r=8, alpha 16': { kind: 'lora', rank: 8, alpha: 16 }, 'QLoRA 4-bit, r=32': { kind: 'qlora', rank: 32, alpha: 64 }, 'Full fine-tune': { kind: 'full', rank: null, alpha: null } };
  const TRAINERS = { Unsloth: 'unsloth', Axolotl: 'axolotl', 'HF TRL/PEFT': 'trl' };
  const HW = { 'cuda (default)': 'cuda', 'rocm, optional adapter': 'rocm', 'metal MLX, optional adapter': 'metal' };
  const GPUS = { '1 × 80 GB': 1, '2 × 80 GB': 2, '4 × 80 GB': 4 };
  const CANARY = { '10% of traffic': 10, '5% of traffic': 5, 'none, flip directly': 0 };
  const RETRY = { 'Request 4 GPUs': 'gpus4', 'Halve micro-batch': 'half-batch', 'Reduce sequence length to 4,096': 'seq4096', 'No change': 'none' };
  const num = (n) => Number(n || 0).toLocaleString('en-GB');
  const when = (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : when(ms); };

  // ---------- live updates ----------
  const live = { sock: null, handlers: null, timer: null };
  function detach() {
    if (live.sock && live.handlers) Object.keys(live.handlers).forEach((ev) => live.sock.off(ev, live.handlers[ev]));
    live.sock = null; live.handlers = null;
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  }
  function schedule() {
    if (live.timer) return;
    live.timer = setTimeout(() => {
      live.timer = null;
      if (!visible()) return;
      if (document.getElementById('overlay')) { schedule(); return; }
      App.render();
    }, 500);
  }
  function attach() {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    const guard = (fn) => (d) => { if (!visible()) { detach(); return; } fn(S(), d || {}); };
    live.handlers = {
      'train.progress': guard((st, d) => {
        const j = (st.jobs || []).find((x) => x.id === d.id);
        if (!j) { reload('jobs'); return; }
        const before = j.state + ':' + j.stage + ':' + j.awaiting;
        ['state', 'stage', 'stageTone', 'step', 'steps', 'epoch', 'loss', 'gpuHours', 'checkpoint', 'note', 'error', 'waitReason', 'awaiting', 'holding'].forEach((k) => { if (d[k] !== undefined) j[k] = d[k]; });
        (d.points || []).forEach((p) => { const last = j.series[j.series.length - 1]; if (!last || p[0] > last[0]) j.series.push(p); });
        // A state or stage change carries more (evals, model, card): fetch the job again.
        if (before !== j.state + ':' + j.stage + ':' + j.awaiting) { reload('jobs'); reload('evals'); reload('summary'); }
        schedule();
      }),
      'train.dataset': guard(() => { reload('datasets'); })
    };
    Object.keys(live.handlers).forEach((ev) => live.sock.on(ev, live.handlers[ev]));
  }
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'training') detach(); });

  const URLS = { summary: '/api/training/summary', jobs: '/api/training/jobs', datasets: '/api/training/datasets', windows: '/api/training/windows', schedules: '/api/training/schedules', evals: '/api/training/evals', bases: '/api/training/base-models' };
  function reload(key) { return App.get(URLS[key]).then((v) => { S()[key] = v; schedule(); }).catch(() => undefined); }
  function reloadAll() { return Promise.all(Object.keys(URLS).map((k) => App.get(URLS[k]).then((v) => [k, v]))).then((pairs) => { const st = S(); pairs.forEach((p) => { st[p[0]] = p[1]; }); }); }

  /** "always", "daily 22:00 to 06:00", "Sat 22:00 to Mon 06:00" or "Sat 06:00 to 22:00" (UTC). */
  function parseWhen(text) {
    const t = String(text || '').trim();
    if (/^always$/i.test(t)) return { kind: 'always' };
    let m = /^daily (\d{2}:\d{2}) to (\d{2}:\d{2})$/i.exec(t);
    if (m) return { kind: 'daily', startTime: m[1], endTime: m[2] };
    m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{2}:\d{2}) to (?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?(\d{2}:\d{2})$/i.exec(t);
    if (m) { const d = (x) => DAYS.map((y) => y.toLowerCase()).indexOf(x.toLowerCase()); return { kind: 'weekly', startDay: d(m[1]), startTime: m[2], endDay: d(m[3] || m[1]), endTime: m[4] }; }
    return null;
  }

  App.register({
    id: 'training', title: 'Training', live: true, summary: 'Datasets, LoRA and QLoRA jobs, evals, GGUF packaging, windows and canary rollout', section: 'admin', crumb: ['Admin', 'Training'],
    label: (st) => { const j = (st.jobs || []).find((x) => x.id === st.selected); return j ? j.label : null; },
    commands: [{ label: 'New training job', sub: 'Training', run(app) { app.stateFor('training').openNew = true; app.render(); } }],
    states: [
      { title: 'Preempted and resumed', tone: 'info', text: 'The job was preempted at step 1,750 for interactive load and resumed from the checkpoint, not from zero.', apply(ctx) {
        const j = (ctx.state.jobs || []).find((x) => x.state === 'preempted' || /Resumed from the checkpoint/.test(x.note || ''));
        if (j) { ctx.state.tab = 'jobs'; ctx.state.selected = j.id; ctx.rerender(); return; }
        ctx.toast('<span>No job has been preempted. When interactive load or a closing window preempts a job, it checkpoints and resumes from that step, and the job shows it here.</span>', '', 7000);
      } },
      { title: 'Approval required', tone: 'warn', text: 'The dataset is confidential, so the job waits for an ML admin approval before training starts.', apply(ctx) {
        const j = (ctx.state.jobs || []).find((x) => x.awaiting);
        if (j) { ctx.state.tab = 'jobs'; ctx.state.selected = j.id; ctx.rerender(); return; }
        ctx.toast('<span>No job waits for approval. A job on a confidential or restricted dataset waits here for an ML admin other than the submitter.</span>', '', 7000);
      } },
      { title: 'Eval below threshold', tone: 'danger', text: 'The pipeline stops before registration. The model card records the failing suite.', apply(ctx) {
        const j = (ctx.state.jobs || []).find((x) => x.registration && x.registration.state === 'blocked');
        if (j) { ctx.state.tab = 'jobs'; ctx.state.selected = j.id; ctx.rerender(); return; }
        ctx.toast('<span>No job is blocked by an eval. A suite below its tenant threshold stops the pipeline before registration and is recorded on the model card.</span>', '', 7000);
      } },
      { title: 'Window closing', tone: 'neutral', text: '20 minutes before 06:00 the job checkpoints and the gateway reloads pinned models.', apply(ctx) {
        const w = ((ctx.state.windows && ctx.state.windows.windows) || []).find((x) => x.closing);
        if (w) { ctx.state.tab = 'schedules'; ctx.rerender(); return; }
        ctx.toast('<span>No window is closing now. In the last minutes before a window closes, its jobs checkpoint and the lent pool\'s pinned models are reloaded.</span>', '', 7000);
      } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      st.tab = st.tab || 'jobs'; st.query = st.query || ''; st.stateFilter = st.stateFilter || 'all';
      if (!st.loaded && !st.loadError && !st.loading) {
        st.loading = true;
        reloadAll().then(() => { st.loaded = true; st.loadError = null; attach(); }).catch((err) => { st.loadError = err; }).finally(() => { st.loading = false; schedule(); });
      }
      if (!st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Training', 'Datasets, jobs, windows and evals') + (st.loadError ? UI.problem('Training could not be loaded', st.loadError.message, (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      attach();

      const summary = st.summary; const jobs = st.jobs || []; const datasets = st.datasets || []; const windows = st.windows.windows; const pools = st.windows.pools;
      const recurring = st.schedules || []; const evals = st.evals || [];
      const manage = App.can('training:manage');
      const meId = App.me && App.me.user.id;
      if (ctx.params.job) { st.selected = ctx.params.job; delete ctx.params.job; }
      if (!jobs.some((j) => j.id === st.selected)) st.selected = jobs[0] ? jobs[0].id : null;
      const q = st.query.toLowerCase();
      const rows = jobs.filter((j) => (!q || (j.name + ' ' + j.desc).toLowerCase().includes(q)) && (st.stateFilter === 'all' || j.state === st.stateFilter));
      const job = jobs.find((j) => j.id === st.selected) || null;
      const counts = {}; jobs.forEach((j) => { counts[j.state] = (counts[j.state] || 0) + 1; });
      const dsName = (d) => (d ? d.name + ' v' + d.version : 'unknown');
      const winFor = (j) => windows.find((w) => w.name === j.window);
      const started = (j) => (j.state === 'running' && j.startedAt ? when(j.startedAt) : j.waitReason || (j.startedAt ? when(j.startedAt) : j.createdAt ? 'submitted ' + when(j.createdAt) : ''));

      const chart = (series) => {
        if (!series.length) return '<div class="muted" style="font-size:12px;padding:8px 0">No steps recorded yet.</div>';
        const w = 600, h = 110, pad = 6; const vals = series.map((p) => p[1]); const max = Math.max.apply(null, vals), min = 0;
        const s0 = series[0][0], s1 = series[series.length - 1][0];
        const pts = series.map((p) => [pad + ((p[0] - s0) / Math.max(1, s1 - s0)) * (w - pad * 2), pad + (1 - (p[1] - min) / (max - min || 1)) * (h - pad * 2)]);
        return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="110" preserveAspectRatio="none" aria-label="Training loss">' + [0.25, 0.5, 0.75].map((g) => '<line x1="0" x2="' + w + '" y1="' + (pad + g * (h - pad * 2)) + '" y2="' + (pad + g * (h - pad * 2)) + '" stroke="var(--line2)" stroke-width="1"/>').join('') + '<polyline fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" points="' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/><circle cx="' + pts[pts.length - 1][0].toFixed(1) + '" cy="' + pts[pts.length - 1][1].toFixed(1) + '" r="3" fill="var(--accent)"/></svg>'
          + '<div class="hstack muted" style="font-size:11px;justify-content:space-between"><span>step ' + num(s0) + ', loss ' + series[0][1].toFixed(2) + '</span><span>step ' + num(s1) + ', loss ' + series[series.length - 1][1].toFixed(3) + '</span></div>';
      };
      const stepper = (j) => '<div class="training-stages">' + STAGES.map((s, i) => { const cls = i < j.stage ? 'done' : i === j.stage ? 'cur ' + (j.stageTone || '') : ''; return '<div class="' + cls + '"><i></i><span>' + esc(s) + '</span></div>'; }).join('') + '</div>';
      const stateKind = (s) => ({ running: 'info', succeeded: 'ok', failed: 'danger', cancelled: '', preempted: 'warn', queued: 'outline' }[s] || '');
      const mine = (j) => j.ownerId === meId;

      const jobActions = (j) => {
        if (j.state === 'running') return UI.btn('Pause', { size: 'sm', attrs: 'data-pause', disabled: !manage && !mine(j) }) + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-canceljob', disabled: !manage && !mine(j) });
        if (j.state === 'queued' && j.awaiting) return UI.btn('Approve to start', { size: 'sm', kind: 'primary', attrs: 'data-approvejob', disabled: !manage || mine(j), title: mine(j) ? 'An ML admin other than the submitter approves' : '' }) + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-canceljob' });
        if (j.state === 'queued' || j.state === 'preempted') return UI.btn(j.state === 'preempted' || j.checkpoint ? 'Resume now' : 'Run now', { size: 'sm', attrs: 'data-resume' }) + UI.btn('Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-canceljob' });
        if (j.state === 'failed' || j.state === 'cancelled') return UI.btn('Retry from checkpoint', { size: 'sm', attrs: 'data-retry' });
        if (j.state === 'succeeded') return UI.btn('Model card', { size: 'sm', attrs: 'data-card' }) + UI.btn('Re-run evals', { size: 'sm', attrs: 'data-rerun' });
        return '';
      };
      const jobNotices = (j) => {
        let h = '';
        if (j.awaiting) h += UI.notice('<b>Approval required.</b> Dataset ' + esc(dsName(j.dataset)) + ' is ' + esc(j.label) + ', so the job waits for an ML admin approval before training starts. GPUs are not reserved until then.', 'warn');
        if (j.error) h += UI.problem('Training failed', j.error, false);
        if (j.note) h += UI.notice(esc(j.note), j.state === 'preempted' ? 'info' : '');
        if (j.registration && j.registration.state === 'blocked') h += UI.notice('<b>Eval below threshold.</b> The pipeline stopped before registration: ' + esc(j.registration.reason || '') + '. The model card records the failing suite.', 'danger', UI.btn('Model card', { size: 'sm', attrs: 'data-card' }));
        if (j.registration && j.registration.state === 'failed') h += UI.notice('<b>Registration failed.</b> ' + esc(j.registration.reason || ''), 'danger');
        const w = winFor(j);
        if (w && w.closing && j.state === 'running' && !st.dismissClosing) h += UI.notice('<b>Window closing, ' + esc(when(w.closesAt - w.reloadMinutes * 60000)) + '.</b> ' + w.reloadMinutes + ' minutes before the ' + esc(w.name) + ' window closes the job checkpoints' + (w.poolId ? ' and the gateway reloads pinned models on ' + esc(w.pool) : '') + '. The job resumes in the next window.', '', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clear="dismissClosing"' })).replace('class="notice "', 'class="notice accent"');
        return h;
      };

      let body = '';
      if (st.tab === 'jobs') {
        body = '<div class="toolbar">' + UI.search('Filter jobs', 'data-search', st.query) + UI.seg([{ id: 'all', label: 'All ' + jobs.length }].concat(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'preempted'].map((s) => ({ id: s, label: s + (counts[s] ? ' ' + counts[s] : '') }))), st.stateFilter, 'data-segs') + '</div>'
          + (summary.worker.available === false || summary.worker.reachable === false ? UI.notice('<b>No training worker.</b> ' + esc(summary.worker.reason || '') + ' Jobs queue and wait until it answers.', 'warn') : '')
          + UI.table(['Job', 'Base', 'Dataset', 'Hardware', 'State', { label: 'Progress', width: '150px' }, 'Started'], rows.map((j) => ({ cells: ['<b>' + esc(j.name) + '</b><div class="muted" style="font-size:11px">' + esc(j.methodText) + '</div>', '<span class="mono">' + esc(j.baseModel) + '</span>', esc(dsName(j.dataset)), esc(j.hardwareText), UI.pill(j.state, stateKind(j.state)), '<div class="meter ' + (j.state === 'failed' ? 'danger' : j.state === 'running' ? 'accent' : '') + '" style="min-width:120px"><div class="mrow"><span></span><span class="num">' + (j.steps ? Math.round((j.step / j.steps) * 100) : 0) + '%</span></div><div class="track"><div class="fill" style="width:' + (j.steps ? (j.step / j.steps) * 100 : 0) + '%"></div></div></div>', esc(started(j))], selected: job && j.id === job.id, attrs: 'data-job="' + esc(j.id) + '"' })), { emptyTitle: jobs.length ? 'No jobs match' : 'No training jobs yet', emptyText: jobs.length ? 'Clear the filter or submit a job.' : 'Register a dataset version, then submit a job.' });
        if (job) {
          const pct = job.steps ? Math.round((job.step / job.steps) * 100) : 0;
          body += UI.panel(null, '<div class="hstack wrap" style="align-items:flex-start"><div class="vstack grow" style="gap:2px"><span style="font-size:15px;font-weight:600">' + esc(job.name) + '</span><span class="muted" style="font-size:12px">' + esc(job.desc) + '</span></div><div class="hstack gap6">' + UI.label(job.label, { sm: true }) + UI.pill(job.state, stateKind(job.state)) + jobActions(job) + '</div></div>'
            + stepper(job)
            + jobNotices(job)
            + '<div class="grid3">' + UI.meter('Steps', num(job.step) + ' of ' + num(job.steps), pct, job.state === 'failed' ? 'danger' : 'accent') + UI.meter('Epoch', (Math.floor(job.epoch * 10) / 10) + ' of ' + job.epochs, (job.epoch / (job.epochs || 1)) * 100) + UI.meter('GPU-hours used', job.gpuHours + ' of ' + job.maxGpuHours + ' max', (job.gpuHours / (job.maxGpuHours || 1)) * 100, job.gpuHours > job.maxGpuHours * 0.8 ? 'warn' : '') + '</div>'
            + '<div class="eyebrow">Training loss</div>' + chart(job.series)
            + UI.kv([['Priority', esc(job.priorityText)], ['Hardware', esc(job.hardwareText)], ['Deadline', esc(job.deadline ? when(job.deadline) : 'none')], ['Last checkpoint', esc(job.checkpoint ? 'step ' + num(job.checkpoint.step) + ', ' + ago(job.checkpoint.at) : 'none')]], 4)
            + '<div class="hstack wrap muted" style="font-size:12px;gap:12px"><span>Owner ' + esc(job.owner || '') + '</span><span>Tenant ' + esc(summary.tenant || '') + '</span><span>Container <span class="mono">' + esc(job.container || (summary.worker.container || 'not started')) + '</span></span><span>Progress streams on <span class="mono">train.progress</span></span>' + (job.model ? '<span><a href="#" data-model="' + esc(job.model.name) + '">' + esc(job.model.name) + '</a>, ' + esc(job.model.state) + '</span>' : '') + '<span class="right"><a href="#" data-go="pools">Pool health</a></span></div>');
        }
      } else if (st.tab === 'datasets') {
        const list = datasets.filter((d) => !q || (d.name + ' ' + d.source).toLowerCase().includes(q));
        body = '<div class="toolbar">' + UI.search('Filter datasets', 'data-search', st.query) + '<span class="right">' + UI.btn('Register dataset version', { attrs: 'data-newds' }) + '</span></div>'
          + UI.table(['Dataset', 'Version', 'Rows', 'Label', 'Source', 'PII scrub', 'Hash', 'Used by'], list.map((d) => ({ cells: ['<b>' + esc(d.name) + '</b>', esc(d.ver), num(d.rows), UI.label(d.label, { sm: true }), esc(d.source) + (d.conversationData && d.optIn ? ', conversation opt-in' + (d.optIn.scope ? ' (' + esc(d.optIn.scope) + ')' : '') : ''), d.withdrawn || d.state === 'failed' ? '<span style="color:var(--danger-fg)">' + esc(d.pii) + '</span>' : esc(d.pii), '<span class="mono">' + esc(d.hash ? d.hash.slice(0, 13) + '…' : '') + '</span>', esc(d.usedBy.join(', '))], attrs: 'data-ds="' + esc(d.id) + '"' })), { emptyTitle: 'No dataset versions', emptyText: 'Register one from a staging path.' })
          + UI.notice('Datasets are versioned in the blob store with a manifest: row count, hash, label, source and PII-scrub report, sealed with the tenant key. Conversation data enters only with tenant opt-in and at or below the target model\'s label ceiling.', 'info');
      } else if (st.tab === 'schedules') {
        const now = new Date(); const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
        const days = [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(monday.getTime() + i * 86400000));
        const dayEnd = (d) => d.getTime() + 86400000;
        const cal = (label, cells) => '<div class="training-cal"><span style="font-size:12px;font-weight:600">' + esc(label) + '</span>' + cells.map((c) => '<div class="cell">' + (c ? '<div class="ev ' + (c[1] || '') + '">' + esc(c[0]) + '</div>' : '') + '</div>').join('') + '</div>';
        const workerRow = days.map((d) => {
          const j = jobs.find((x) => x.startedAt && x.startedAt < dayEnd(d) && (x.finishedAt || (x.state === 'running' ? Date.now() : x.startedAt)) >= d.getTime());
          if (j) return [j.name, 'hot'];
          const r = recurring.find((x) => x.nextRunAt && x.nextRunAt >= d.getTime() && x.nextRunAt < dayEnd(d));
          if (r) return [r.enabled ? r.name : r.name + ', paused', ''];
          const pausedRun = recurring.find((x) => !x.enabled && x.lastRunAt && x.lastRunAt >= d.getTime() && x.lastRunAt < dayEnd(d));
          return pausedRun ? [pausedRun.name + ', paused', ''] : null;
        });
        const lentRows = windows.filter((w) => w.poolId).map((w) => cal(w.pool, days.map((d) => {
          if (w.kind === 'daily') return ['lent ' + w.startTime + ' to ' + w.endTime, ''];
          const dow = d.getUTCDay(); let k = w.startDay; const span = [];
          for (let i = 0; i < 8; i++) { span.push(k); if (k === w.endDay) break; k = (k + 1) % 7; }
          return span.indexOf(dow) >= 0 ? ['lent, ' + w.name, ''] : null;
        })));
        body = UI.panel('GPU calendar, week of ' + monday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }), '<div class="training-cal head"><span></span>' + days.map((d) => '<span>' + DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + '</span>').join('') + '</div>'
          + cal('training worker', workerRow) + lentRows.join('')
          + '<span class="muted" style="font-size:12px">Inference GPUs lent to training are drained first and pinned models are reloaded before the window closes. Times are UTC.</span>')
          + '<div class="grid2">'
          + UI.panel('Training windows', UI.table(['Window', 'Pool', 'When', 'Effect'], windows.map((w) => [esc(w.name) + (w.open ? ' ' + UI.pill(w.closing ? 'closing' : 'open', w.closing ? 'warn' : 'info') : ''), w.poolId ? '<a href="#" data-go="pools">' + esc(w.pool) + '</a>' : esc(w.pool), esc(w.when), esc(w.effect)]), { clickable: false, minWidth: '0', emptyTitle: 'No windows', emptyText: 'Jobs start only inside a window, or with Run now.' }), { actions: UI.btn('Add window', { size: 'sm', attrs: 'data-addwindow', disabled: !manage }) })
          + UI.panel('Recurring jobs', UI.table(['Schedule', 'Cron', 'Condition', 'Next run', ''], recurring.map((r) => [esc(r.name) + (r.lastResult ? '<div class="muted" style="font-size:11px">' + esc(r.lastResult) + '</div>' : ''), '<span class="mono">' + esc(r.cronText) + '</span>', esc(r.conditionText), esc(r.nextRunAt ? when(r.nextRunAt) : r.enabled ? '' : 'paused'), UI.toggle(r.enabled ? 'on' : 'off', r.enabled, 'data-manual data-rec="' + esc(r.id) + '"' + (manage ? '' : ' disabled'))]), { clickable: false, minWidth: '0', emptyTitle: 'No recurring jobs', emptyText: 'Schedule one from a job template.' }) + '<div class="muted" style="font-size:12px">Queued jobs are ordered by priority, then by each tenant\'s GPU-hour usage this month. A higher-priority job may preempt a lower-priority preemptible one; it resumes from its checkpoint.</div>', { actions: UI.btn('Schedule recurring', { size: 'sm', attrs: 'data-recurring', disabled: !manage }) })
          + '</div>';
      } else {
        const list = evals.filter((e) => !q || (e.model + ' ' + e.name).toLowerCase().includes(q));
        body = '<div class="toolbar">' + UI.search('Filter evals', 'data-search', st.query) + '<span class="right hstack gap6">' + UI.btn('Thresholds', { attrs: 'data-thresholds' }) + UI.btn('Run evals', { attrs: 'data-runevals' }) + '</span></div>'
          + UI.table(['Model', 'Hardware class', 'Suite', 'Score', 'Threshold', 'Result'], list.map((e) => ['<span class="mono">' + esc(e.model) + '</span>', esc(e.hardware), esc(e.name), esc(e.scoreText), esc(e.thresholdText), UI.pill(e.result, e.result === 'pass' ? 'ok' : 'danger')]), { clickable: false, emptyTitle: 'No eval results', emptyText: 'Evals run after training, or from Run evals.' })
          + UI.notice('Evals run per hardware class, because quantized kernels can produce slightly different outputs across backends. Pass thresholds are set per tenant; a failing suite stops the pipeline before registration.', 'info');
      }

      const evalJob = job && job.evals.length ? job : jobs.find((j) => j.evals.length && (!job || !job.dataset || !j.dataset || j.dataset.name === job.dataset.name)) || jobs.find((j) => j.evals.length);
      const ds = job && job.dataset ? datasets.find((d) => d.id === job.dataset.id) : datasets[0];
      const quota = summary.quota;
      const month = new Date().toLocaleDateString('en-GB', { month: 'long' });
      const inspector = '<aside class="inspector w360 training-side">'
        + (evalJob ? UI.panel('Evals for ' + evalJob.name, (job && job !== evalJob ? '<div class="muted" style="font-size:12px">' + esc(job.name) + ' has not reached evals. Showing the previous version of the lineage.</div>' : '') + UI.table(['Eval', 'Base', 'This model', 'Threshold', 'Result'], evalJob.evals.map((e) => [esc(e.name) + (e.hardware !== 'cuda' ? ', ' + esc(e.hardware) : ''), esc(e.baseText), esc(e.scoreText), esc(e.thresholdText), UI.pill(e.result, e.result === 'pass' ? 'ok' : 'danger')]), { clickable: false, cls: 'bare', minWidth: '0', attrs: 'style="font-size:12px"' }) + (evalJob.registration.state === 'blocked' ? '<span class="muted" style="font-size:12px">Registration is blocked until every suite meets its threshold.</span>' : ''), { cls: 'pad-sm' }) : UI.panel('Evals', '<div class="muted" style="font-size:12px">No job has reached evals yet.</div>'))
        + UI.panel('GPU-hours, ' + esc(summary.tenant || '') + ', ' + month, UI.meter('Used', quota.usedHours + (quota.limitHours != null ? ' of ' + quota.limitHours : ', no limit'), quota.limitHours ? (quota.usedHours / quota.limitHours) * 100 : 0, quota.limitHours && quota.usedHours >= quota.limitHours ? 'danger' : '') + '<span class="muted" style="font-size:12px">Fair share: queued jobs are ordered by priority, then by usage against this quota.</span>')
        + (ds ? UI.panel('Dataset ' + ds.name + ' ' + ds.ver, UI.kv([['Rows', num(ds.rows)], ['Label', UI.label(ds.label, { sm: true })], ['PII scrub', esc(ds.pii)], ['Splits', esc(ds.splits.pct.train + ' / ' + ds.splits.pct.val + ' / ' + ds.splits.pct.test)]], 2) + '<div>' + UI.btn('Manifest', { size: 'sm', attrs: 'data-ds="' + esc(ds.id) + '"' }) + '</div>') : '')
        + '</aside>';

      root.innerHTML = '<style>'
        + '.training-stages{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:6px}.training-stages > div{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--muted);font-weight:500}.training-stages i{display:block;height:4px;border-radius:2px;background:var(--line)}.training-stages .done{color:var(--fg)}.training-stages .done i{background:var(--ok-fg)}.training-stages .cur{color:var(--fg);font-weight:700}.training-stages .cur i{background:var(--accent)}.training-stages .cur.danger i{background:var(--danger-fg)}'
        + '.training-cal{display:grid;grid-template-columns:120px repeat(7,minmax(0,1fr));gap:4px;align-items:center}.training-cal.head{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}.training-cal .cell{height:30px;border-left:1px solid var(--line2);padding:3px 3px 3px 4px}.training-cal .ev{height:24px;display:flex;align-items:center;padding:0 6px;border-radius:4px;background:var(--sel);color:var(--fg2);font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.training-cal .ev.hot{background:var(--accent-tint);color:var(--accent)}'
        + '.training-side.inspector{width:420px}.training-side .panel{padding:12px}.training-side table.dt th,.training-side table.dt td{padding:5px 6px;font-size:12px}.training-side table.dt th{white-space:normal}@media (max-width:1100px){.training-side.inspector{width:320px}}@media (max-width:900px){.training-side.inspector{width:100%}}'
        + '</style>'
        + '<div class="page">'
        + UI.pagehead('Training', 'TypeScript orchestrates and governs, Python GPU workers train, Ollama serves only the approved, converted result', UI.btn('Schedule recurring', { attrs: 'data-recurring', disabled: !manage }) + UI.btn('Submit job', { kind: 'primary', attrs: 'data-newjob' }))
        + UI.tabs([{ id: 'jobs', label: 'Jobs', count: jobs.length }, { id: 'datasets', label: 'Datasets', count: datasets.length }, { id: 'schedules', label: 'Schedules' }, { id: 'evals', label: 'Evals', count: evals.length }], st.tab)
        + body
        + '</div>' + inspector;

      // ---- events ----
      const act = async (fn, what) => { try { return await fn(); } catch (err) { App.fail(err, what); return null; } };
      const refresh = () => Promise.all([reload('jobs'), reload('summary'), reload('datasets')]);
      ctx.on('click', '.tabs [data-tab]', (e, t) => { st.tab = t.dataset.tab; st.query = ''; ctx.rerender(); });
      ctx.on('click', '[data-segs] [data-seg]', (e, t) => { st.stateFilter = t.dataset.seg; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', 'tr.row[data-job]', (e, t) => { st.selected = t.dataset.job; ctx.rerender(); });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-model]', (e, t) => { e.preventDefault(); ctx.navigate('models', { model: t.dataset.model }); });
      ctx.on('click', '[data-clear]', (e, t) => { st[t.dataset.clear] = true; ctx.rerender(); });
      ctx.on('click', '[data-rec]', async (e, t) => {
        const r = recurring.find((x) => x.id === t.dataset.rec); if (!r || !manage) return;
        const out = await act(() => App.patch('/api/training/schedules/' + enc(r.id), { enabled: !r.enabled }), 'Could not change the schedule');
        if (!out) return; await reload('schedules'); toast(esc(r.name) + (out.enabled ? ' enabled.' : ' paused; the next run is skipped.'));
      });

      ctx.on('click', '[data-pause]', async () => {
        const ok = await ctx.confirm({ title: 'Pause ' + job.name, tag: 'checkpoint', tone: 'warn', body: '<p style="margin:0" class="fg2">The trainer checkpoints at the current step and releases the GPUs. The job returns to the queue and resumes from that checkpoint when you run it again.</p>', kv: [['Current step', num(job.step)], ['GPUs released', String(job.hardware.gpus)]], ok: 'Pause' });
        if (!ok) return; const j = await act(() => App.post('/api/training/jobs/' + enc(job.id) + '/pause'), 'Could not pause'); if (!j) return;
        await refresh(); toast('<b>' + esc(job.name) + '</b> checkpointed at step ' + num(j.checkpoint && j.checkpoint.step) + ' and paused. GPUs released.', 'warn');
      });
      ctx.on('click', '[data-resume]', async () => {
        const from = job.checkpoint ? 'the checkpoint at step ' + num(job.checkpoint.step) : 'the start';
        const ok = await ctx.confirm({ title: (job.state === 'preempted' || job.checkpoint ? 'Resume ' : 'Run ') + job.name + ' now', tag: 'outside window', tone: 'info', body: '<p style="margin:0" class="fg2">Runs as soon as the worker has ' + job.hardware.gpus + ' free GPU' + (job.hardware.gpus === 1 ? '' : 's') + ' instead of waiting for the next window. Resumes from ' + esc(from) + '. Interactive load can still preempt it.</p>', ok: job.checkpoint ? 'Resume' : 'Run now' });
        if (!ok) return; if (!(await act(() => App.post('/api/training/jobs/' + enc(job.id) + '/resume'), 'Could not start'))) return;
        await refresh(); toast('<b>' + esc(job.name) + '</b> queued to start from ' + esc(from) + '.', 'ok');
      });
      ctx.on('click', '[data-approvejob]', async () => {
        const d = datasets.find((x) => job.dataset && x.id === job.dataset.id) || {};
        const ok = await ctx.confirm({ title: 'Approve ' + job.name + ' to train on ' + job.label + ' data', tag: 'ML admin', tone: 'ok', body: '<p style="margin:0" class="fg2">' + esc(dsName(job.dataset)) + ' is ' + esc(job.label) + '. Approval records your decision on the model card; the resulting model inherits a ' + esc(job.label) + ' ceiling and can only serve profiles at or above it.</p>', kv: [['Dataset', esc(dsName(job.dataset)) + ', ' + num(d.rows) + ' rows'], ['PII scrub', esc(d.pii || '')], ['Tenant opt-in', d.conversationData && d.optIn ? esc((d.optIn.scope || 'recorded') + ', yes') : 'not required']], ok: 'Approve' });
        if (!ok) return; if (!(await act(() => App.post('/api/training/jobs/' + enc(job.id) + '/approve'), 'Could not approve'))) return;
        await refresh(); toast('<b>' + esc(job.name) + '</b> approved and queued.', 'ok');
      });
      ctx.on('click', '[data-canceljob]', async () => {
        const ok = await ctx.confirm({ title: 'Cancel ' + job.name, tag: 'destructive', tone: 'danger', body: '<p style="margin:0" class="fg2">The trainer stops after the current step and keeps the last checkpoint. GPU-hours used so far count against the tenant quota.</p>', ok: 'Cancel job' });
        if (!ok) return; if (!(await act(() => App.post('/api/training/jobs/' + enc(job.id) + '/cancel'), 'Could not cancel'))) return;
        await refresh(); toast('<b>' + esc(job.name) + '</b> cancelled.', '');
      });
      ctx.on('click', '[data-retry]', async () => {
        const from = job.checkpoint ? 'the checkpoint at step ' + num(job.checkpoint.step) : 'the start (no checkpoint was written)';
        let change = 'none';
        const ok = await new Promise((resolve) => {
          let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
          ctx.modal({ title: 'Retry ' + job.name + ' from checkpoint', body: '<p style="margin:0" class="fg2">Requeues with the same dataset version, seed and container. Resumes from ' + esc(from) + '.</p>' + (job.error ? UI.field('Change before retry', UI.select(Object.keys(RETRY), 'Request 4 GPUs', 'data-change')) : ''), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Requeue', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const sel = m.querySelector('[data-change]'); if (sel) change = RETRY[sel.value]; finish(true); App.closeOverlay(); }); }, onClose() { finish(false); } });
        });
        if (!ok) return; const j = await act(() => App.post('/api/training/jobs/' + enc(job.id) + '/retry', { change }), 'Could not requeue'); if (!j) return;
        await refresh(); toast('<b>' + esc(job.name) + '</b> requeued. ' + esc(j.note || ''), 'ok');
      });
      ctx.on('click', '[data-rerun]', async () => {
        if (!(await act(() => App.post('/api/training/evals', { jobId: job.id }), 'Could not queue evals'))) return;
        toast('Evals requeued for ' + esc(job.name) + '. Results post to this page and to the model card; registration proceeds automatically on a pass.', '');
      });
      ctx.on('click', '[data-card]', async () => {
        const c = await act(() => App.get('/api/training/jobs/' + enc(job.id) + '/card'), 'Could not open the model card'); if (!c) return;
        const blocked = c.registration.state === 'blocked';
        const evalText = c.evals.length ? c.evals.map((e) => e.name + ' ' + e.scoreText + (e.hardware !== 'cuda' ? ' on ' + e.hardware : '') + (e.result === 'fail' ? ' (fail, threshold ' + e.thresholdText + ')' : '')).join(', ') : 'not run yet';
        const pk = c.packaging || {};
        ctx.drawer({ title: 'Model card, ' + esc(c.model), body: '<div class="hstack">' + UI.pill(job.model ? job.model.state : 'not registered') + UI.label(c.label, { sm: true }) + (blocked ? UI.pill('registration blocked', 'danger') : c.registration.state === 'registered' ? UI.pill('registered', 'ok') : '') + '</div>'
          + UI.kv([['Base digest', '<span class="mono">' + esc(c.baseModel) + ', ' + esc(c.baseDigest || 'unknown') + '</span>'], ['Dataset version', esc(c.dataset.name + ' v' + c.dataset.version + ', ' + (c.dataset.hash || ''))], ['Container digest', '<span class="mono">' + esc(c.container || 'not started') + '</span>'], ['Hyperparameters', esc(c.hyperparameters)], ['Trainer', esc(c.trainer + ' on ' + c.hardware)], ['Approval', esc(c.approval ? c.approval.byName + ', ' + when(c.approval.at) : 'not required')], ['Eval scores', esc(evalText)], ['Packaging', esc(pk.quantization ? 'GGUF ' + pk.quantization + ' via ' + pk.tool + ', ' + pk.artifact : (pk.requested || '') + ', not converted yet')], ['Manifest', c.manifest ? 'signed with the KMS key <span class="mono">' + esc(c.manifest.key) + '</span>' : 'signed at registration']], 1)
          + (blocked ? UI.notice('The failing suite is recorded on the card. Fix the dataset or adjust the guardrail set, then re-run evals; registration proceeds automatically on a pass.', 'danger') : ''),
        actions: (job.model ? UI.btn('Open in Models', { attrs: 'data-close data-models' }) : '') + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { const b = d.querySelector('[data-models]'); if (b) b.addEventListener('click', () => ctx.navigate('models', { model: job.model.name })); } });
      });

      ctx.on('click', '[data-ds]', (e, t) => {
        const d = datasets.find((x) => x.id === t.dataset.ds); if (!d) return;
        const manifest = 'dataset: ' + d.name + '\nversion: ' + d.version + '\nrows: ' + d.rows + '\nlabel: ' + d.label + '\nhash: ' + (d.hash || '') + '\nsplits: ' + d.splits.pct.train + '/' + d.splits.pct.val + '/' + d.splits.pct.test + '\nscrub:\n  report: pii-report.json\n  masked: ' + (d.scrub ? d.scrub.masked : 0) + (d.scrub ? '\n  by_kind: ' + JSON.stringify(d.scrub.byKind) : '');
        ctx.drawer({ title: 'Dataset ' + esc(d.name) + ' ' + esc(d.ver), body: '<div class="hstack">' + UI.label(d.label, { sm: true }) + (d.withdrawn ? UI.pill('withdrawn', 'danger') : d.state === 'ready' ? UI.pill('scrubbed', 'ok') : UI.pill(d.state)) + '</div>'
          + UI.kv([['Rows', num(d.rows)], ['Splits', esc(d.splits.pct.train + ' / ' + d.splits.pct.val + ' / ' + d.splits.pct.test)], ['Hash', '<span class="mono">' + esc(d.hash || '') + '</span>'], ['Source', esc(d.source)], ['PII scrub', esc(d.pii)], ['Used by', esc(d.usedBy.join(', ') || 'none')], ['Tenant opt-in', d.conversationData && d.optIn ? esc((d.optIn.scope || 'tenant') + ', recorded ' + when(d.optIn.at)) : 'not required'], ['Stored', esc(d.stored || 'deleted')]], 2)
          + UI.code(manifest, 'manifest'),
        actions: UI.btn('Download scrub report', { icon: 'download', attrs: 'data-rep', disabled: d.state !== 'ready' && d.state !== 'withdrawn' }) + (manage && !d.withdrawn ? UI.btn('Withdraw', { kind: 'danger', attrs: 'data-withdraw' }) : '') + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
        onMount(dr) {
          dr.querySelector('[data-rep]').addEventListener('click', async () => {
            const r = await act(() => App.get('/api/training/datasets/' + enc(d.id) + '/report'), 'Could not export the report'); if (!r) return;
            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })); a.download = 'pii-report-' + d.name + '-' + d.ver + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            toast('pii-report.json exported. Access logged to audit.');
          });
          const w = dr.querySelector('[data-withdraw]');
          if (w) w.addEventListener('click', () => {
            App.closeOverlay();
            ctx.modal({ title: 'Withdraw ' + d.name + ' ' + d.ver, body: '<p style="margin:0" class="fg2">The scrubbed rows are deleted and jobs that have not finished training on this version are cancelled. The manifest and scrub report stay for the audit trail.</p>' + UI.field('Reason', UI.input('', { attrs: 'data-reason', placeholder: 'unmasked names found in a review' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Withdraw', { kind: 'danger', attrs: 'data-ok' }), onMount(m) {
              m.querySelector('[data-ok]').addEventListener('click', async () => {
                const reason = m.querySelector('[data-reason]').value.trim(); if (!reason) { toast('Give a reason.', 'warn'); return; }
                const r = await act(() => App.post('/api/training/datasets/' + enc(d.id) + '/withdraw', { reason }), 'Could not withdraw'); if (!r) return;
                App.closeOverlay(); await refresh(); toast(esc(d.name + ' ' + d.ver) + ' withdrawn.' + (r.cancelled.length ? ' Cancelled ' + esc(r.cancelled.join(', ')) + '.' : ''), 'warn');
              });
            } });
          });
        } });
      });
      ctx.on('click', '[data-newds]', () => {
        const names = Array.from(new Set(datasets.map((d) => d.name)));
        const nextVer = (n) => { const v = datasets.filter((d) => d.name === n).map((d) => d.version); return 'v' + ((v.length ? Math.max.apply(null, v) : 0) + 1); };
        const first = names[0] || 'new dataset';
        const myLabels = LABELS.filter((l) => !App.me || LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance));
        ctx.modal({ title: 'Register dataset version', body: '<div class="formgrid" style="--cols:2">' + UI.field('Dataset', UI.select(names.concat(['new dataset']), first, 'data-dsn')) + UI.field('Name of the new dataset', UI.input('', { attrs: 'data-newname class="input mono"' + (first === 'new dataset' ? '' : ' disabled'), placeholder: 'finance-qa' }).replace('class="input" ', '')) + UI.field('Version', UI.input(first === 'new dataset' ? 'v1' : nextVer(first), { attrs: 'data-ver class="input mono"' }).replace('class="input" ', '')) + UI.field('Label', UI.select(myLabels, myLabels.indexOf('confidential') >= 0 ? 'confidential' : myLabels[myLabels.length - 1], 'data-lbl')) + UI.field('Source path in the staging area', UI.input('', { attrs: 'data-path class="input mono"', placeholder: 'finance-qa/2026-09-20/rows.jsonl' }).replace('class="input" ', ''), 'JSON Lines under training/staging/<tenant>/ in the blob store') + UI.field('Source', UI.input('', { attrs: 'data-src', placeholder: 'Finance KB Q&A pairs' })) + '</div>' + UI.check('Contains conversation data; the tenant opt-in is recorded' + (summary.settings.conversationOptIn ? '' : ' (no opt-in recorded yet)'), false, 'data-conv') + UI.notice('Registration runs the PII scrub and hashes the rows. The version becomes usable in jobs once the scrub report is attached; the unscrubbed staging object is deleted.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Register', { kind: 'primary', attrs: 'data-ok' }), onMount(m) {
          const sel = m.querySelector('[data-dsn]'); const nn = m.querySelector('[data-newname]');
          sel.addEventListener('change', () => { nn.disabled = sel.value !== 'new dataset'; m.querySelector('[data-ver]').value = sel.value === 'new dataset' ? 'v1' : nextVer(sel.value); });
          m.querySelector('[data-ok]').addEventListener('click', async () => {
            const name = sel.value === 'new dataset' ? nn.value.trim() : sel.value;
            const ver = parseInt(String(m.querySelector('[data-ver]').value).replace(/^v/i, ''), 10);
            const convOn = !!m.querySelector('[data-conv]').checked;
            const body = { name, label: m.querySelector('[data-lbl]').value, source: m.querySelector('[data-src]').value.trim() || name, stagingPath: m.querySelector('[data-path]').value.trim(), conversationData: convOn };
            if (ver) body.version = ver;
            const d = await act(() => App.post('/api/training/datasets', body), 'The dataset was refused'); if (!d) return;
            App.closeOverlay(); st.tab = 'datasets'; await reload('datasets'); toast(esc(d.name) + ' v' + d.version + ' registered; PII scrub running.', 'ok');
          });
        } });
      });

      const newJob = () => {
        const ready = datasets.filter((d) => d.state === 'ready');
        const bases = st.bases || [];
        if (!ready.length || !bases.length) { toast(!ready.length ? 'Register a dataset version first; a job needs a scrubbed version.' : 'No approved or evaluated base model is available to you.', 'warn', 6000); return; }
        const dsLabel = (d) => d.name + ' ' + d.ver;
        const draw = (id) => { const d = ready.find((x) => x.id === id) || ready[0]; return d.label === 'confidential' || d.label === 'restricted' ? UI.notice('Dataset ' + esc(dsLabel(d)) + ' is ' + esc(d.label) + '. The job waits for an ML admin approval before training starts.', 'warn') : UI.notice('Dataset is ' + esc(d.label) + '; no approval step before training.', 'info'); };
        const dsOpts = ready.map(dsLabel);
        ctx.modal({ title: 'New training job', cls: 'wide', body: '<div class="formgrid" style="--cols:3">' + UI.field('Name', UI.input('', { attrs: 'data-n', placeholder: 'finance-lora-v5' })) + UI.field('Base model', UI.select(bases.map((b) => b.name + ', ' + b.state), bases[0].name + ', ' + bases[0].state, 'data-b')) + UI.field('Dataset version', UI.select(dsOpts, dsOpts[0], 'data-d')) + UI.field('Method', UI.select(Object.keys(METHODS), 'LoRA r=16, alpha 32', 'data-m')) + UI.field('Trainer', UI.select(Object.keys(TRAINERS), 'Unsloth', 'data-t')) + UI.field('Hardware class', UI.select(Object.keys(HW), 'cuda (default)', 'data-hw')) + UI.field('GPUs and memory', UI.select(Object.keys(GPUS), '2 × 80 GB', 'data-g')) + UI.field('Max duration', UI.input('8 h', { attrs: 'data-max' })) + UI.field('Deadline', UI.input('', { type: 'datetime-local', attrs: 'data-dl' })) + UI.field('Priority', UI.select(['low', 'normal', 'high'], 'normal', 'data-p')) + UI.field('Packaging', UI.select(['GGUF Q4_K_M', 'GGUF Q5_K_M', 'GGUF Q8_0', 'LoRA adapter on pinned base'], 'GGUF Q4_K_M', 'data-pk')) + UI.field('Canary after approval', UI.select(Object.keys(CANARY), '10% of traffic', 'data-c')) + '</div><div class="hstack wrap gap12">' + UI.check('May be preempted by interactive load', true, 'data-pre') + UI.check('Checkpoint every 250 steps', true, 'data-ck') + UI.check('Record seed and hyperparameters on the model card', true, 'data-recseed disabled') + '</div><div id="dsnote">' + draw(ready[0].id) + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Submit job', { kind: 'primary', attrs: 'data-submit' }), onMount(m) {
          const dsOf = () => ready[dsOpts.indexOf(m.querySelector('[data-d]').value)] || ready[0];
          const checked = (sel) => { const el = m.querySelector(sel); return !!el && el.checked; };
          m.querySelector('[data-d]').addEventListener('change', () => { m.querySelector('#dsnote').innerHTML = draw(dsOf().id); });
          m.querySelector('[data-submit]').addEventListener('click', async () => {
            const name = m.querySelector('[data-n]').value.trim(); if (!name) { toast('Give the job a name.', 'warn'); return; }
            const d = dsOf(); const dl = m.querySelector('[data-dl]').value;
            const method = Object.assign({ epochs: 3, seed: 1337 }, METHODS[m.querySelector('[data-m]').value]);
            const body = { name, baseModel: m.querySelector('[data-b]').value.split(',')[0], datasetId: d.id, method, trainer: TRAINERS[m.querySelector('[data-t]').value], hardware: { accelerator: HW[m.querySelector('[data-hw]').value], gpus: GPUS[m.querySelector('[data-g]').value], memoryGb: 80 }, maxHours: parseFloat(m.querySelector('[data-max]').value) || 8, deadline: dl ? new Date(dl).getTime() : null, priority: m.querySelector('[data-p]').value, preemptible: checked('[data-pre]'), packaging: m.querySelector('[data-pk]').value, canary: CANARY[m.querySelector('[data-c]').value], checkpointEvery: checked('[data-ck]') ? 250 : 1000 };
            const j = await act(() => App.post('/api/training/jobs', body), 'The job was refused'); if (!j) return;
            App.closeOverlay(); st.selected = j.id; st.tab = 'jobs'; st.stateFilter = 'all'; await refresh();
            toast('<b>' + esc(j.name) + '</b> submitted. ' + (j.awaiting ? 'Waiting for ML admin approval.' : 'Queued for the next window.'), j.awaiting ? 'warn' : 'ok', 5000);
          });
        } });
      };
      ctx.on('click', '[data-newjob]', newJob);
      if (st.openNew) { st.openNew = false; setTimeout(newJob, 30); }
      ctx.on('click', '[data-recurring]', () => {
        if (!jobs.length) { toast('Submit a job first; a recurring job repeats its spec.', 'warn'); return; }
        const tpls = jobs.map((j) => j.name); const wins = ['any open window'].concat(windows.map((w) => w.name + ', ' + w.pool));
        ctx.modal({ title: 'Schedule recurring job', body: '<div class="formgrid" style="--cols:2">' + UI.field('Name', UI.input('', { attrs: 'data-n', placeholder: 'nightly guard refresh' })) + UI.field('Job template', UI.select(tpls, tpls[0], 'data-tpl')) + UI.field('Cron', UI.input('0 22 * * *', { attrs: 'data-c class="input mono"' }).replace('class="input" ', ''), 'UTC') + UI.field('Run only when', UI.select(['the input dataset version changed', 'always'], 'the input dataset version changed', 'data-cond')) + UI.field('Window', UI.select(wins, wins[0], 'data-w')) + UI.field('Priority', UI.select(['low', 'normal'], 'low', 'data-p')) + '</div>' + UI.notice('Each run submits a job with the same spec and the newest dataset version. Evals, packaging and registration as a draft run automatically after it, and the owner is notified.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Schedule', { kind: 'primary', attrs: 'data-ok' }), onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', async () => {
            const n = m.querySelector('[data-n]').value.trim(); if (!n) { toast('Give the schedule a name.', 'warn'); return; }
            const wi = wins.indexOf(m.querySelector('[data-w]').value);
            const body = { name: n, templateJobId: jobs[tpls.indexOf(m.querySelector('[data-tpl]').value)].id, cron: m.querySelector('[data-c]').value.trim(), condition: m.querySelector('[data-cond]').value === 'always' ? 'always' : 'dataset-changed', windowId: wi > 0 ? windows[wi - 1].id : null, priority: m.querySelector('[data-p]').value };
            const r = await act(() => App.post('/api/training/schedules', body), 'The schedule was refused'); if (!r) return;
            App.closeOverlay(); st.tab = 'schedules'; await reload('schedules'); toast('<b>' + esc(n) + '</b> scheduled. Shown under Schedules.', 'ok');
          });
        } });
      });
      ctx.on('click', '[data-addwindow]', () => {
        const canLend = App.can('pools:manage');
        const poolOpts = ['training worker, own GPUs'].concat(pools.map((p) => p.name));
        ctx.modal({ title: 'Add training window', body: '<div class="formgrid" style="--cols:2">' + UI.field('Name', UI.input('', { attrs: 'data-n', placeholder: 'saturday full day' })) + UI.field('Pool to lend', UI.select(poolOpts, poolOpts[canLend && pools.length ? 1 : 0], 'data-pool'), canLend ? '' : 'Lending an inference pool needs a model admin (pools:manage)') + UI.field('When', UI.input('Sat 06:00 to 22:00', { attrs: 'data-w' }), 'always, daily 22:00 to 06:00, or Sat 22:00 to Mon 06:00 (UTC)') + UI.field('Reload pinned models', UI.input('20 min before close', { readonly: true })) + '</div>' + UI.notice('The gateway drains and unloads the pool\'s models when the window opens, and reloads pinned models before it closes. Other pools keep serving.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add window', { kind: 'primary', attrs: 'data-ok' }), onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', async () => {
            const n = m.querySelector('[data-n]').value.trim(); if (!n) { toast('Give the window a name.', 'warn'); return; }
            const spec = parseWhen(m.querySelector('[data-w]').value); if (!spec) { toast('Write When as always, daily 22:00 to 06:00, or Sat 22:00 to Mon 06:00.', 'warn', 6000); return; }
            const pi = poolOpts.indexOf(m.querySelector('[data-pool]').value);
            const w = await act(() => App.post('/api/training/windows', Object.assign({ name: n, poolId: pi > 0 ? pools[pi - 1].id : null, reloadMinutes: 20 }, spec)), 'The window was refused'); if (!w) return;
            App.closeOverlay(); await reload('windows'); toast('Window <b>' + esc(n) + '</b> added: ' + esc(w.when) + ', ' + esc(w.effect) + '.', 'ok');
          });
        } });
      });
      ctx.on('click', '[data-runevals]', () => {
        const models = Array.from(new Set(jobs.filter((j) => j.model).map((j) => j.model.name).concat((st.bases || []).map((b) => b.name))));
        if (!models.length) { toast('No model to evaluate yet.', 'warn'); return; }
        const suites = summary.settings.suites;
        ctx.modal({ title: 'Run evals', body: '<div class="formgrid" style="--cols:2">' + UI.field('Model version', UI.select(models, models[0], 'data-m')) + UI.field('Hardware classes', UI.input('cuda, cpu', { attrs: 'data-hw' })) + '</div><div class="vstack gap4">' + suites.map((s) => UI.check(s.name, s.id !== 'tools', 'data-suite="' + esc(s.id) + '"')).join('') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Queue evals', { kind: 'primary', attrs: 'data-ok' }), onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', async () => {
            const picked = Array.prototype.filter.call(m.querySelectorAll('[data-suite]'), (el) => el.checked).map((el) => el.getAttribute('data-suite'));
            const hw = m.querySelector('[data-hw]').value.split(',').map((x) => x.trim()).filter(Boolean);
            if (!picked.length) { toast('Pick at least one suite.', 'warn'); return; }
            const r = await act(() => App.post('/api/training/evals', { model: m.querySelector('[data-m]').value, hardware: hw, suites: picked }), 'Evals were refused'); if (!r) return;
            App.closeOverlay(); toast('Evals queued for ' + esc(r.model) + '. Results post here and to the model card.', 'ok');
          });
        } });
      });
      ctx.on('click', '[data-thresholds]', () => {
        const s = summary.settings; const canTenant = App.can('tenant:manage');
        ctx.modal({ title: 'Eval thresholds, ' + esc(summary.tenant || ''), body: '<div class="formgrid" style="--cols:2">' + s.suites.map((x) => UI.field(x.name, UI.input(String(x.threshold), { attrs: 'data-th="' + esc(x.id) + '" class="input mono"' + (manage ? '' : ' disabled') }).replace('class="input" ', ''), 'default ' + x.defaultThreshold)).join('') + '</div>' + UI.check('Tenant opt-in: conversation data may enter training datasets', s.conversationOptIn, 'data-optin' + (canTenant ? '' : ' disabled')) + UI.field('Opt-in scope', UI.input(s.optInScope || '', { attrs: 'data-scope' + (canTenant ? '' : ' disabled'), placeholder: 'Finance Ops' }), canTenant ? '' : 'A tenant admin records the opt-in'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-ok', disabled: !manage }), onMount(m) {
          m.querySelector('[data-ok]').addEventListener('click', async () => {
            const thresholds = {}; Array.prototype.forEach.call(m.querySelectorAll('[data-th]'), (el) => { const v = parseFloat(el.value); if (!isNaN(v)) thresholds[el.getAttribute('data-th')] = v; });
            const body = { thresholds };
            if (canTenant) { body.conversationOptIn = !!m.querySelector('[data-optin]').checked; body.optInScope = m.querySelector('[data-scope]').value.trim() || null; }
            const r = await act(() => App.api('PUT', '/api/training/settings', body), 'Could not save'); if (!r) return;
            App.closeOverlay(); await reload('summary'); toast('Thresholds saved. They apply to the next eval run.', 'ok');
          });
        } });
      });
    }
  });
})();
