(function () {
  const { UI, esc } = App;

  // ---------- formatting ----------
  const gbNum = (b) => (b == null ? '?' : (b / 1e9).toFixed(1));
  const gb = (b) => (b == null ? 'unknown' : gbNum(b) + ' GB');
  const dur = (ms) => (ms == null ? 'none' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s');
  const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'never');
  const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const sameModel = (a, b) => a === b || a === b + ':latest' || a + ':latest' === b;
  const enc = encodeURIComponent;
  const healthOf = (i) => (i.state === 'disabled' ? 'disabled' : i.state === 'draining' ? 'draining' : i.health || 'unknown');
  const healthKind = (h) => ({ healthy: 'ok', degraded: 'warn', unreachable: 'danger', draining: 'warn', disabled: 'outline', upgrading: 'info' }[h] || '');
  const resKind = (r) => ({ pinned: 'ok', warm: '', cold: 'outline', draining: 'warn', loading: 'info' }[r] || '');
  const EVENT_TONE = { load: 'ok', unload: '', evicted: 'danger', pull: 'info' };
  const EVENT_TEXT = { load: 'Loaded', unload: 'Unloaded', evicted: 'Evicted', pull: 'Pulled' };
  const ACCELERATORS = ['cuda', 'rocm', 'metal', 'cpu'];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const overlayOpen = () => !!document.getElementById('overlay');

  // ---------- live updates ----------
  // One pools.state and one job.progress listener for the screen. They detach once the route is left.
  const live = { sock: null, onPools: null, onJob: null, timer: null, last: 0, refresh: null, onJobEvent: null };
  const detach = () => {
    if (live.sock) { live.sock.off('pools.state', live.onPools); live.sock.off('job.progress', live.onJob); }
    live.sock = null; live.onPools = null; live.onJob = null;
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  };
  const attach = () => {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    live.onPools = () => {
      if (App.state.route !== 'pools') { detach(); return; }
      if (live.timer) return;
      // At most one snapshot fetch every 2 s, however often the poller reports.
      live.timer = setTimeout(() => { live.timer = null; if (live.refresh) live.refresh(); }, Math.max(0, 2000 - (Date.now() - live.last)));
    };
    live.onJob = (e) => { if (App.state.route !== 'pools') { detach(); return; } if (live.onJobEvent) live.onJobEvent(e); };
    live.sock.on('pools.state', live.onPools);
    live.sock.on('job.progress', live.onJob);
  };
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'pools') detach(); });

  App.register({
    id: 'pools', title: 'Pools', live: true, section: 'admin', crumb: ['Admin', 'Pools'],
    summary: 'Instances per accelerator group, memory planner, load, unload, pin, drain and rolling upgrades',
    commands: [
      { label: 'Load a model on an instance', sub: 'Pools', run(app) { app.stateFor('pools').openLoad = true; app.render(); } },
      { label: 'Add a pool', sub: 'Pools', run(app) { app.stateFor('pools').openAddPool = true; app.render(); } }
    ],
    states: [
      { title: 'No spare memory', tone: 'warn', text: 'A load does not fit next to the pinned models on an instance, even after evicting every warm model. The planner refuses it rather than evict a pinned model.',
        async apply(ctx) {
          const st = ctx.state; const all = flat(st.pools || []).filter((x) => x.state === 'active');
          if (!all.length) { ctx.toast('Add a pool and an instance first; this state needs one.', 'warn'); return; }
          // Ask the planner about every pulled, non-resident model and show the first real refusal.
          let pick = null, fallback = null;
          for (const i of all) {
            for (const a of (i.available || []).filter((x) => !i.loaded.some((m) => m.name === x.name)).sort((x, y) => y.sizeBytes - x.sizeBytes)) {
              let plan = null;
              try { plan = await App.get('/api/admin/instances/' + enc(i.id) + '/plan?model=' + enc(a.name)); } catch (err) { continue; }
              if (!plan.fits) { pick = { i, model: a.name, plan }; break; }
              if (!fallback) fallback = { i, model: a.name, plan };
            }
            if (pick) break;
          }
          const hit = pick || fallback;
          st.notes = st.notes || {};
          if (!hit) { const i = all[0]; st.notes[i.id] = { kind: 'nospare', model: '', plan: null, at: Date.now(), detail: 'Nothing is pulled on ' + i.name + ' that is not already loaded, so no load can be refused yet.' }; ctx.rerender(); return; }
          st.notes[hit.i.id] = { kind: 'nospare', model: hit.model, plan: pick ? hit.plan : null, at: Date.now(),
            detail: pick ? hit.model + ' needs about ' + gb(hit.plan.needBytes) + ' and ' + hit.i.name + ' cannot make room without evicting a pinned model.'
              : 'Preview: every pulled model fits right now. The largest, ' + hit.model + ', needs about ' + gb(hit.plan.needBytes) + ' and ' + hit.i.name + ' has ' + (hit.plan.freeBytes == null ? 'no declared memory size' : gb(hit.plan.freeBytes) + ' free') + '; a load that does not fit is refused like this.' };
          ctx.rerender();
        } },
      { title: 'Anti-thrash limit', tone: 'warn', text: 'Too many loads on one instance in ten minutes. Further loads are refused until the window clears; pinned models are never evicted.',
        apply(ctx) {
          const st = ctx.state; const i = flat(st.pools || [])[0];
          if (!i) { ctx.toast('Add a pool and an instance first; this state needs one.', 'warn'); return; }
          st.notes = st.notes || {};
          st.notes[i.id] = { kind: 'thrash', at: Date.now(), retry: 60, detail: i.name + ' has reached its anti-thrash limit of loads in the last ten minutes. Further loads wait until the window clears.' };
          ctx.rerender();
        } },
      { title: 'Why is this cold?', tone: 'neutral', text: 'Clicking a model shows who loaded, unloaded or evicted it, when, why, and its residency class.',
        apply(ctx) {
          const st = ctx.state;
          for (const p of st.pools || []) {
            const i = p.instances.find((x) => x.loaded.length) || p.instances[0];
            const name = (i && i.loaded[0] && i.loaded[0].name) || (p.placements[0] && p.placements[0].model) || (i && i.available[0] && i.available[0].name);
            if (name) { st.openCold = { pool: p.id, inst: i && i.loaded.some((m) => m.name === name) ? i.id : null, model: name }; ctx.rerender(); return; }
          }
          ctx.toast('No model is placed or pulled on any instance yet.', 'warn');
        } },
      { title: 'Estimate drift', tone: 'info', text: 'Measured memory differs from the catalogue estimate by more than 10%. The model is flagged so its size can be reviewed.',
        apply(ctx) { ctx.state.showDrift = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.notes = st.notes || {};
      st.upgrades = st.upgrades || {};
      st.busy = st.busy || {};

      // ---------- loading ----------
      // Async results re-render only while this screen is showing and no dialog is open (a re-render closes dialogs).
      const refresh = () => {
        if (App.state.route !== 'pools') return;
        if (overlayOpen()) { st.dirty = true; return; }
        const page = document.querySelector('#main .page'); const top = page ? page.scrollTop : 0; const y = window.scrollY;
        ctx.rerender();
        const p2 = document.querySelector('#main .page'); if (p2) p2.scrollTop = top; if (y) window.scrollTo(0, y);
      };
      const onClose = () => { if (st.dirty) { st.dirty = false; refresh(); } };
      const syncJobs = () => {
        const ids = Object.keys(st.upgrades).filter((k) => ['queued', 'running'].indexOf(st.upgrades[k].state) >= 0);
        if (!ids.length) return Promise.resolve();
        return App.get('/api/me/jobs').then((jobs) => { ids.forEach((k) => { const u = st.upgrades[k]; const j = jobs.find((x) => x.id === u.jobId); if (j) Object.assign(u, { state: j.state, progress: j.progress, message: j.error || j.message }); }); }).catch(() => undefined);
      };
      const fetchAll = () => Promise.all([App.get('/api/admin/pools'), App.can('models:read') ? App.get('/api/admin/models').catch(() => []) : Promise.resolve([]), syncJobs()]);
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        fetchAll()
          .then(([pools, models]) => { Object.assign(st, { pools, models, loaded: true, loadError: null, at: Date.now() }); live.last = Date.now(); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; refresh(); });
      };
      // A quiet refresh for socket events and after actions: keeps the current view, never shows "Loading".
      const quiet = () => {
        live.last = Date.now();
        return fetchAll().then(([pools, models]) => { st.pools = pools; st.models = models; st.at = Date.now(); st.refreshError = null; refresh(); })
          .catch((err) => { st.refreshError = err; refresh(); });
      };
      live.refresh = quiet;
      live.onJobEvent = (e) => {
        const k = Object.keys(st.upgrades).find((x) => st.upgrades[x].jobId === e.id); if (!k) return;
        const u = st.upgrades[k]; Object.assign(u, { state: e.state, progress: e.progress, message: e.message || u.message });
        if (e.state === 'succeeded') ctx.toast('Rolling upgrade of ' + esc(u.pool) + ' to Ollama ' + esc(u.target) + ' finished.', 'ok', 6000);
        else if (e.state === 'failed') ctx.toast('<b>Rolling upgrade of ' + esc(u.pool) + ' stopped.</b> ' + esc(e.message || ''), 'danger', 8000);
        refresh();
      };
      attach();
      if (!st.loaded && !st.loadError) load();
      const reload = () => { st.loaded = false; st.loadError = null; ctx.rerender(); };

      const pools = st.pools || [];
      const allInst = flat(pools);
      const findInst = (id) => { for (const p of pools) { const i = p.instances.find((x) => x.id === id); if (i) return { p, i }; } return null; };
      const catalog = (name) => (st.models || []).find((m) => sameModel(m.name, name));
      const placementOf = (p, name) => { const m = catalog(name); return m ? p.placements.find((x) => x.model_id === m.id) : p.placements.find((x) => sameModel(x.model, name)); };

      // ---------- pieces ----------
      const memBar = (i) => {
        const mem = i.memory || {}; const total = mem.totalBytes || mem.usedBytes || 0;
        if (!total) return '<div class="pl-mem" title="Nothing resident"></div>';
        return '<div class="pl-mem">' + i.loaded.map((m) => '<div class="' + esc(m.residency) + '" style="width:' + Math.max(0.5, (m.sizeBytes / total) * 100).toFixed(1) + '%" title="' + esc(m.name + ' ' + gb(m.sizeBytes) + ', ' + m.residency) + '"></div>').join('') + '</div>';
      };
      const memText = (i) => {
        const mem = i.memory || {};
        if (i.health === 'unreachable') return 'not reporting since ' + when(i.last_seen_at);
        const parts = i.loaded.map((m) => m.name + ' ' + gbNum(m.sizeBytes));
        if (mem.totalBytes) parts.push('free ' + gbNum(mem.freeBytes) + ' of ' + gbNum(mem.totalBytes) + ' GB');
        else parts.push((i.loaded.length ? 'used ' + gbNum(mem.usedBytes) + ' GB, ' : '') + 'no memory size declared');
        return parts.join(', ');
      };
      const chip = (i, m) => '<button type="button" class="pl-model' + (m.drift ? ' drift' : '') + '" data-model="' + esc(m.name) + '" data-on="' + esc(i.id) + '" title="Residency and load history">'
        + '<span class="mono">' + esc(m.name) + '</span> <span class="muted">' + esc(m.residency) + '</span>' + (m.drift ? ' <span class="pl-drift">drift</span>' : '') + '</button>';
      const row = (p, i) => {
        const h = st.busy[i.id] === 'draining' && i.state !== 'draining' ? 'draining' : healthOf(i);
        const loading = (i.loading || []).concat(st.busy[i.id] && st.busy[i.id].indexOf('load:') === 0 && (i.loading || []).indexOf(st.busy[i.id].slice(5)) < 0 && !i.loaded.some((m) => m.name === st.busy[i.id].slice(5)) ? [st.busy[i.id].slice(5)] : []);
        // The row opens the instance on click; the name is the keyboard control (a row with role button would nest
        // the model buttons inside another control).
        return '<div class="pl-grid row" data-inst="' + esc(i.id) + '">'
          + '<div class="vstack" style="gap:1px"><button type="button" class="pl-instname mono" data-inst-open="' + esc(i.id) + '" aria-label="Open instance ' + esc(i.name) + '">' + esc(i.name) + '</button><span class="muted" style="font-size:11px">' + esc([i.settings.hardware, i.deploy].filter(Boolean).join(', ')) + '</span></div>'
          + '<div class="vstack gap4">' + memBar(i) + '<span class="muted" style="font-size:11px">' + esc(memText(i)) + '</span></div>'
          + '<div class="hstack wrap gap6">' + i.loaded.map((m) => chip(i, m)).join('') + loading.map((n) => '<span class="pl-model loading"><span class="mono">' + esc(n) + '</span> <span class="muted">loading</span></span>').join('')
          + (i.loaded.length || loading.length ? '' : '<span class="muted" style="font-size:11px">nothing loaded</span>') + '</div>'
          + '<div class="num">' + i.inflight + ' / ' + i.parallel + '</div><div class="num">' + i.queued + '</div><div class="num">' + esc(dur(i.firstTokenMs)) + '</div>'
          + '<div><span class="mono fg2" style="font-size:11px">' + esc(i.version || 'unknown') + '</span></div><div>' + UI.pill(h, healthKind(h)) + '</div></div>';
      };
      const head = '<div class="pl-grid head"><div>Instance</div><div>Memory: loaded models, free</div><div>Loaded models</div><div>Slots</div><div>Queue</div><div>First tok</div><div>Ollama</div><div>Health</div></div>';

      const noteHtml = (i) => {
        const n = st.notes[i.id]; if (!n) return '';
        if (n.kind === 'nospare') {
          const pl = n.plan;
          const numbers = pl ? ' ' + (pl.freeBytes == null ? 'No memory size is declared.' : gb(pl.freeBytes) + ' free now.') + (pl.reason ? ' ' + esc(pl.reason) + '.' : '') : '';
          return UI.notice('<b>No spare memory on ' + esc(i.name) + '.</b> ' + esc(n.detail) + numbers + ' Unload or unpin a model, move the load to another instance, or raise the declared memory if it is wrong.', 'warn',
            '<span class="hstack gap6">' + UI.btn('Open planner', { size: 'sm', attrs: 'data-planner="' + esc(i.id) + '" data-pmodel="' + esc(n.model || '') + '"' }) + UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearnote="' + esc(i.id) + '"' }) + '</span>');
        }
        if (n.kind === 'thrash') {
          const left = Math.max(0, Math.round((n.at + (n.retry || 60) * 1000 - Date.now()) / 1000));
          return UI.notice('<b>Anti-thrash limit on ' + esc(i.name) + '.</b> ' + esc(n.detail) + (n.loads ? ' Loads in the window: ' + n.loads + ', limit ' + n.max + '.' : '') + ' ' + (left ? 'Retry after ' + left + ' s.' : 'Retry now.') + ' Pinned models are never evicted.', 'warn', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearnote="' + esc(i.id) + '"' }));
        }
        return '';
      };
      const upgradeNotice = (p) => {
        const u = st.upgrades[p.id]; if (!u) return '';
        const running = u.state === 'queued' || u.state === 'running';
        const tone = running ? 'info' : u.state === 'succeeded' ? 'ok' : 'danger';
        const text = running ? 'Rolling Ollama ' + esc(u.target) + ' across ' + esc(p.name) + ', one instance at a time. Each instance drains, the job waits for it to report ' + esc(u.target) + ', reloads pinned models and returns it to service.'
          : u.state === 'succeeded' ? 'Rolling upgrade to Ollama ' + esc(u.target) + ' finished.' : 'Rolling upgrade to Ollama ' + esc(u.target) + ' ' + esc(u.state) + '.';
        return '<div class="vstack gap6">' + UI.notice(text + (u.message ? ' <span class="fg2">' + esc(u.message) + '</span>' : ''), tone, running ? '' : UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-clearup="' + esc(p.id) + '"' }))
          + (running ? UI.meter('Job ' + u.jobId.slice(-6).toLowerCase(), (u.progress || 0) + '%', u.progress || 0, 'accent') : '') + '</div>';
      };
      const driftList = (p) => p.instances.reduce((a, i) => a.concat(i.loaded.filter((m) => m.drift).map((m) => ({ i, m }))), []);
      const driftNotice = (p) => {
        const d = driftList(p);
        if (!d.length) return '';
        return UI.notice('<b>Estimate drift.</b> ' + d.map((x) => { const pct = Math.round(((x.m.sizeBytes - x.m.estimateBytes) / x.m.estimateBytes) * 100); return 'Measured memory for <span class="mono">' + esc(x.m.name) + '</span> on ' + esc(x.i.name) + ' is ' + gb(x.m.sizeBytes) + ' against an estimate of ' + gb(x.m.estimateBytes) + ', ' + Math.abs(pct) + '% ' + (pct > 0 ? 'over' : 'under') + '.'; }).join(' ') + ' Review the recorded size in Models.', 'info', App.can('models:manage') ? UI.btn('Open in Models', { size: 'sm', attrs: 'data-go="models"' }) : '');
      };
      const placementsHtml = (p) => {
        if (!p.placements.length) return '<div class="muted" style="font-size:12px">No models placed on this pool. Place and pull them from Models.</div>';
        return UI.table(['Placed model', 'Residency', 'Resident on', { label: '', right: true }], p.placements.map((pl) => {
          const on = p.instances.filter((i) => i.loaded.some((m) => sameModel(m.name, pl.model)));
          return { cells: ['<span class="mono">' + esc(pl.model) + '</span>', '<span class="pl-res">' + UI.select(['pinned', 'warm', 'cold'], pl.residency, 'data-residency="' + esc(pl.id) + '" aria-label="Residency of ' + esc(pl.model) + '"') + '</span>',
            on.length ? esc(on.map((i) => i.name).join(', ')) : '<span class="muted">cold on every instance</span>',
            '<span class="hstack gap6" style="justify-content:flex-end">' + UI.btn(on.length ? 'History' : 'Why is this cold?', { kind: 'ghost', size: 'sm', attrs: 'data-cold="' + esc(p.id) + '" data-cmodel="' + esc(pl.model) + '"' }) + UI.btn('Remove', { kind: 'ghost', size: 'sm', attrs: 'data-unplace="' + esc(pl.id) + '" data-umodel="' + esc(pl.model) + '"' }) + '</span>'] };
        }), { minWidth: '0', clickable: false });
      };
      const poolPanel = (p) => {
        let notices = '';
        const up0 = st.upgrades[p.id]; const upOn = up0 && (up0.state === 'queued' || up0.state === 'running');
        const sentence = (t) => (t ? esc(t) + (/[.!?]$/.test(t) ? '' : '.') : '');
        p.instances.forEach((i) => {
          notices += noteHtml(i);
          if (i.state !== 'disabled' && i.health === 'unreachable') notices += UI.notice('<b>' + esc(i.name) + ' is not answering.</b> ' + sentence(i.health_detail) + ' Last seen ' + esc(when(i.last_seen_at)) + '. Requests route to other instances in the pool.', 'danger', UI.btn('Open instance', { size: 'sm', attrs: 'data-inst-open="' + esc(i.id) + '"' }));
          else if (i.state !== 'disabled' && i.health === 'degraded') notices += UI.notice('<b>' + esc(i.name) + ' is degraded.</b> ' + sentence(i.health_detail), 'warn', UI.btn('Open instance', { size: 'sm', attrs: 'data-inst-open="' + esc(i.id) + '"' }));
          if (i.state === 'draining' && upOn) notices += UI.notice('<b>' + esc(i.name) + ' is drained for the rolling upgrade.</b> The job returns it to service once it reports the target version.', 'info');
          else if (i.state === 'draining') notices += UI.notice('<b>' + esc(i.name) + ' is drained.</b> The gateway routes nothing to it and refuses loads until it returns to service.', 'warn', UI.btn('Return to service', { size: 'sm', attrs: 'data-undrain="' + esc(i.id) + '"' }));
        });
        notices += upgradeNotice(p) + driftNotice(p);
        if (st.showDrift && !driftList(p).length) notices += UI.notice('<b>Estimate drift.</b> No model loaded on ' + esc(p.name) + ' differs from its catalogue estimate by more than 10%.', 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-nodrift' }));
        const title = p.name + ', ' + p.accelerator + ', zone ' + p.zone + ', ceiling ' + p.label_ceiling;
        const upRunning = upOn;
        const actions = UI.btn('Add instance', { size: 'sm', icon: 'plus', attrs: 'data-addinst="' + esc(p.id) + '"' }) + UI.btn(upRunning ? 'Upgrade running' : 'Roll upgrade', { size: 'sm', attrs: 'data-roll="' + esc(p.id) + '"', disabled: upRunning || !p.instances.length }) + UI.iconbtn('edit', 'Edit pool', { attrs: 'data-editpool="' + esc(p.id) + '"', cls: 'sm ghost' }) + UI.iconbtn('trash', 'Delete pool', { attrs: 'data-delpool="' + esc(p.id) + '"', cls: 'sm ghost' });
        const grid = p.instances.length ? '<div class="pl-wrap" data-scroll-x>' + head + p.instances.map((i) => row(p, i)).join('') + '</div>' : UI.empty('No instances', 'Register the Ollama endpoints that serve this pool.', UI.btn('Add instance', { size: 'sm', kind: 'primary', attrs: 'data-addinst="' + esc(p.id) + '"' }));
        return UI.panel(title, (p.description ? '<div class="fg2" style="font-size:12px">' + esc(p.description) + '</div>' : '') + '<div class="hstack gap6">' + UI.label(p.label_ceiling, { sm: true }) + '<a href="#" class="muted" style="font-size:12px" data-go="zones">zone ' + esc(p.zone) + '</a></div>' + grid + notices
          + '<div class="eyebrow">Placements</div>' + placementsHtml(p), { actions });
      };

      let body;
      if (st.loadError) body = UI.problem('Pools could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id);
      else if (!st.loaded) body = UI.notice('Loading…', 'info');
      else if (!pools.length) body = UI.empty('No pools yet', 'A pool groups the Ollama instances of one accelerator class. Add one, then register its instances.', UI.btn('Add pool', { kind: 'primary', icon: 'plus', attrs: 'data-addpool' }));
      else body = pools.map(poolPanel).join('');

      root.innerHTML = '<style>'
        + '.pl-wrap{position:relative;overflow-x:auto}.pl-grid{display:grid;grid-template-columns:160px minmax(180px,1fr) 250px 64px 54px 70px 72px 92px;gap:10px;align-items:center;padding:7px 4px;border-bottom:1px solid var(--line2);min-width:980px;font-size:13px}.pl-grid.head{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);border-bottom-color:var(--line)}.pl-grid.row{cursor:pointer;border-radius:4px}.pl-grid.row:hover,.pl-grid.row:focus-visible{background:var(--sel)}.pl-grid:last-child{border-bottom:0}.pl-grid .pill{padding:0 5px;font-size:11px}'
        + '.pl-instname{all:unset;cursor:pointer;font-family:var(--mono);font-weight:500;color:var(--fg)}.pl-instname:hover{text-decoration:underline}.pl-instname:focus-visible{outline:var(--focus-w) solid var(--focus);outline-offset:2px}.pl-mem{display:flex;height:10px;background:var(--sel);border-radius:2px;overflow:hidden;gap:1px}.pl-mem .pinned{background:var(--meter)}.pl-mem .warm{background:var(--faint)}.pl-mem .cold{background:var(--line)}.pl-mem .draining{background:var(--warn-fg)}'
        + '.pl-model{display:inline-flex;gap:4px;align-items:center;font-size:11px;border:1px solid var(--line);border-radius:4px;background:var(--panel);padding:1px 6px;cursor:pointer;font-family:inherit;color:var(--fg)}.pl-model:hover{border-color:var(--muted)}.pl-model.loading{cursor:default;border-style:dashed;color:var(--info-fg)}.pl-model.drift{border-color:var(--info-fg)}'
        + '.pl-drift{font-size:10px;padding:0 4px;border-radius:3px;background:var(--info-bg);color:var(--info-fg)}'
        + '.pl-legend{display:flex;gap:14px;font-size:11px;color:var(--muted);align-items:center;flex-wrap:wrap}.pl-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}'
        + '.pl-ev{font-size:12px}.pl-res .select{width:auto;min-width:110px}'
        + '</style>'
        + '<div class="page">'
        + UI.pagehead('Pools and instances', 'One Ollama process per accelerator group. The gateway owns placement.',
          UI.btn('Refresh', { kind: 'ghost', icon: 'refresh', attrs: 'data-reload' }) + UI.btn('Add pool', { icon: 'plus', attrs: 'data-addpool' }) + UI.btn('Load model', { attrs: 'data-load', disabled: !allInst.length }) + UI.btn('Drain instance', { attrs: 'data-drain', disabled: !allInst.length }))
        + (st.loaded ? '<div class="pl-legend"><span><i style="background:var(--meter)"></i>pinned</span><span><i style="background:var(--faint)"></i>warm</span><span><i style="background:var(--warn-fg)"></i>draining</span><span><i style="background:var(--sel);border:1px solid var(--line)"></i>free</span>'
          + '<span class="right">Live from the gateway, which polls each instance\'s /api/version, /api/ps and /api/tags. Updated ' + esc(clock(st.at)) + '.</span></div>' : '')
        + (st.refreshError ? UI.notice('The last refresh failed: ' + esc(st.refreshError.message) + '. Showing the previous snapshot.', 'warn', UI.btn('Retry', { size: 'sm', attrs: 'data-reload' })) : '')
        + body
        + '</div>';

      // ---------- events ----------
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go); });
      ctx.on('click', '[data-reload]', reload);
      ctx.on('click', '[data-clearnote]', (e, t) => { delete st.notes[t.dataset.clearnote]; ctx.rerender(); });
      ctx.on('click', '[data-clearup]', (e, t) => { delete st.upgrades[t.dataset.clearup]; ctx.rerender(); });
      ctx.on('click', '[data-nodrift]', () => { st.showDrift = false; ctx.rerender(); });
      const later = (fn) => setTimeout(fn, 30);

      // ----- pools -----
      const poolForm = (p) => '<div class="formgrid" style="--cols:2">'
        + UI.field('Name', UI.input(p ? p.name : '', { attrs: 'data-pname maxlength="63"' + (p ? ' disabled' : ''), placeholder: 'gpu-large' }), p ? 'Names cannot change.' : 'Lower case letters, digits and hyphens')
        + UI.field('Accelerator', UI.select(ACCELERATORS, p ? p.accelerator : 'cuda', 'data-pacc'))
        + UI.field('Zone', UI.input(p ? p.zone : 'inference', { attrs: 'data-pzone maxlength="63"' }))
        + UI.field('Label ceiling', UI.select(LABELS, p ? p.label_ceiling : 'internal', 'data-pceil'), 'Models above this label cannot be placed here')
        + '</div>' + UI.field('Description', UI.textarea(p && p.description ? p.description : '', { attrs: 'data-pdesc maxlength="500"', rows: 2 }));
      const poolModal = (p) => ctx.modal({ title: p ? 'Edit ' + esc(p.name) : 'Add pool', body: poolForm(p), onClose,
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(p ? 'Save' : 'Add pool', { kind: 'primary', attrs: 'data-psave' }),
        onMount(m) {
          const btn = m.querySelector('[data-psave]');
          btn.addEventListener('click', async () => {
            const v = (s) => m.querySelector(s).value.trim();
            const bodyP = { accelerator: v('[data-pacc]'), zone: v('[data-pzone]'), labelCeiling: v('[data-pceil]'), description: v('[data-pdesc]') || null };
            btn.disabled = true;
            try {
              if (p) await App.patch('/api/admin/pools/' + enc(p.id), bodyP);
              else await App.post('/api/admin/pools', Object.assign({ name: v('[data-pname]') }, bodyP));
              App.closeOverlay(); ctx.toast(p ? esc(p.name) + ' saved.' : 'Pool ' + esc(v('[data-pname]')) + ' added. Register its instances next.', 'ok'); quiet();
            } catch (err) { btn.disabled = false; App.fail(err); }
          });
        } });
      ctx.on('click', '[data-addpool]', () => poolModal(null));
      ctx.on('click', '[data-editpool]', (e, t) => poolModal(pools.find((p) => p.id === t.dataset.editpool)));
      ctx.on('click', '[data-delpool]', async (e, t) => {
        const p = pools.find((x) => x.id === t.dataset.delpool); if (!p) return;
        if (p.instances.length) { ctx.toast('Remove the instances of ' + esc(p.name) + ' before deleting it.', 'warn'); return; }
        const ok = await ctx.confirm({ title: 'Delete pool ' + p.name, tag: 'cannot be undone', tone: 'danger', body: '<p style="margin:0" class="fg2">Its placements go with it. Refused while a profile routes to this pool.</p>', ok: 'Delete pool' });
        if (!ok) return;
        try { await App.del('/api/admin/pools/' + enc(p.id)); ctx.toast('Pool ' + esc(p.name) + ' deleted. Audit entry written.', 'ok'); quiet(); } catch (err) { App.fail(err); }
      });

      // ----- instances -----
      const instForm = (i) => {
        const s = (i && i.settings) || {};
        return '<div class="formgrid" style="--cols:2">'
          + UI.field('Name', UI.input(i ? i.name : '', { attrs: 'data-iname maxlength="100"' + (i ? ' disabled' : ''), placeholder: 'gpu-large-1/0' }))
          + UI.field('URL', UI.input(i ? i.url : '', { attrs: 'data-iurl', placeholder: 'http://10.40.1.10:11434' }), 'Mutual TLS needs https://')
          + UI.field('Deployment', UI.select([{ value: 'docker', label: 'Docker' }, { value: 'baremetal', label: 'Bare metal (systemd)' }], i ? i.deploy : 'docker', 'data-ideploy' + (i ? ' disabled' : '')))
          + UI.field('Memory (GB)', UI.input(s.memoryBytes ? (s.memoryBytes / 1e9).toFixed(1) : '', { type: 'number', attrs: 'data-imem min="0" step="0.1"', placeholder: 'unknown' }), 'VRAM or RAM the planner may use')
          + UI.field('Hardware', UI.input(s.hardware || '', { attrs: 'data-ihw maxlength="100"', placeholder: 'A100 80 GB' }))
          + UI.field('Node', UI.input(s.node || '', { attrs: 'data-inode maxlength="100"', placeholder: 'gpu-large-1' }))
          + UI.field('Device', UI.input(s.device || '', { attrs: 'data-idev maxlength="200"', placeholder: 'CUDA_VISIBLE_DEVICES=0' }), 'Recorded; set it in the instance\'s environment')
          + UI.field('Parallel slots', UI.input(s.parallel ? String(s.parallel) : '', { type: 'number', attrs: 'data-ipar min="1" max="256"', placeholder: 'gateway default' }))
          + UI.field('Max loaded models', UI.input(s.maxLoaded ? String(s.maxLoaded) : '', { type: 'number', attrs: 'data-imax min="1" max="64"' }))
          + UI.field('Context length', UI.input(s.numCtx ? String(s.numCtx) : '', { type: 'number', attrs: 'data-ictx min="256"' }))
          + UI.field('KV cache type', UI.select([{ value: '', label: 'not set' }, 'f16', 'q8_0', 'q4_0'], s.kvCacheType || '', 'data-ikv'))
          + UI.field('keep_alive', UI.input(s.keepAlive || '', { attrs: 'data-ikeep maxlength="10"', placeholder: '30m' }), '-1, or seconds with s, m or h')
          + '</div><div class="eyebrow">Mutual TLS (optional)</div><div class="formgrid" style="--cols:3">'
          + ['caFile', 'certFile', 'keyFile'].map((k) => UI.field({ caFile: 'CA file', certFile: 'Client certificate', keyFile: 'Client key' }[k], UI.input(i && i.tls && i.tls[k] ? i.tls[k] : '', { attrs: 'data-tls="' + k + '"', placeholder: '/etc/exprsn-ai/tls/' + k.replace('File', '') + '.pem' }))).join('')
          + '</div><div class="muted" style="font-size:12px">Paths on the server. Key material never passes through the console.</div>';
      };
      const readInst = (m) => {
        const v = (s) => m.querySelector(s).value.trim();
        const settings = {};
        const num = (s) => (v(s) === '' ? undefined : Number(v(s)));
        if (v('[data-imem]') !== '') settings.memoryBytes = Math.round(Number(v('[data-imem]')) * 1e9);
        if (v('[data-ihw]')) settings.hardware = v('[data-ihw]');
        if (v('[data-inode]')) settings.node = v('[data-inode]');
        if (v('[data-idev]')) settings.device = v('[data-idev]');
        if (num('[data-ipar]') !== undefined) settings.parallel = num('[data-ipar]');
        if (num('[data-imax]') !== undefined) settings.maxLoaded = num('[data-imax]');
        if (num('[data-ictx]') !== undefined) settings.numCtx = num('[data-ictx]');
        if (v('[data-ikv]')) settings.kvCacheType = v('[data-ikv]');
        if (v('[data-ikeep]')) settings.keepAlive = v('[data-ikeep]');
        const tls = {}; m.querySelectorAll('[data-tls]').forEach((el) => { if (el.value.trim()) tls[el.dataset.tls] = el.value.trim(); });
        return { name: v('[data-iname]'), url: v('[data-iurl]'), deploy: v('[data-ideploy]'), settings, tls: Object.keys(tls).length ? tls : null };
      };
      const instModal = (poolId, i) => {
        const p = pools.find((x) => x.id === poolId);
        ctx.modal({ cls: 'wide', title: i ? 'Edit ' + esc(i.name) : 'Add instance to ' + esc(p ? p.name : ''), body: instForm(i), onClose,
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(i ? 'Save' : 'Add instance', { kind: 'primary', attrs: 'data-isave' }),
          onMount(m) {
            const btn = m.querySelector('[data-isave]');
            btn.addEventListener('click', async () => {
              const b = readInst(m); btn.disabled = true;
              try {
                let out;
                if (i) out = await App.patch('/api/admin/instances/' + enc(i.id), { url: b.url, settings: b.settings, tls: b.tls });
                else out = await App.post('/api/admin/pools/' + enc(poolId) + '/instances', b);
                App.closeOverlay();
                ctx.toast(esc(out ? out.name : b.name) + (i ? ' saved.' : ' registered.') + (out ? ' Health ' + esc(out.health) + (out.version ? ', Ollama ' + esc(out.version) : '') + '.' : ''), out && out.health === 'healthy' ? 'ok' : 'warn', 5000);
                quiet();
              } catch (err) { btn.disabled = false; App.fail(err); }
            });
          } });
      };
      ctx.on('click', '[data-addinst]', (e, t) => instModal(t.dataset.addinst, null));

      const envOf = (i) => {
        const s = i.settings || {}; const lines = [];
        if (s.device) lines.push(s.device);
        if (s.maxLoaded) lines.push('OLLAMA_MAX_LOADED_MODELS=' + s.maxLoaded);
        if (s.parallel) lines.push('OLLAMA_NUM_PARALLEL=' + s.parallel);
        if (s.numCtx) lines.push('OLLAMA_CONTEXT_LENGTH=' + s.numCtx);
        if (s.kvCacheType) lines.push('OLLAMA_KV_CACHE_TYPE=' + s.kvCacheType);
        if (s.keepAlive) lines.push('OLLAMA_KEEP_ALIVE=' + s.keepAlive);
        return lines.join('\n');
      };
      const eventsTimeline = (evs, withInst) => (evs.length ? UI.timeline(evs.map((ev) => ({ title: esc((EVENT_TEXT[ev.event] || ev.event) + ' ' + ev.model) + (withInst && ev.inst ? ' <span class="muted" style="font-weight:400">on ' + esc(ev.inst) + '</span>' : ''), text: esc(ev.reason || ''), meta: esc(when(ev.ts) + (ev.actor ? ', by ' + ev.actor : '')), tone: EVENT_TONE[ev.event] || '' }))) : '<div class="muted pl-ev">No load, unload, eviction or pull recorded yet.</div>');

      const instDrawer = (id) => {
        const r = findInst(id); if (!r) return; const i = r.i, p = r.p; const h = healthOf(i);
        const env = envOf(i);
        ctx.drawer({ title: '<span class="mono">' + esc(i.name) + '</span>', onClose,
          body: '<div class="hstack">' + UI.pill(h, healthKind(h)) + UI.pill(p.accelerator, 'outline') + UI.label(p.label_ceiling, { sm: true }) + '</div>'
            + (i.health_detail ? UI.notice(esc(i.health_detail), i.health === 'unreachable' ? 'danger' : 'warn') : '')
            + UI.kv([['Pool', esc(p.name)], ['Zone', '<a href="#" data-zone>' + esc(p.zone) + '</a>'], ['URL', '<span class="mono">' + esc(i.url) + '</span>'], ['Deployment', esc(i.deploy === 'baremetal' ? 'bare metal' : 'Docker')], ['Node', esc(i.settings.node || 'not recorded')], ['Hardware', esc(i.settings.hardware || 'not recorded')],
              ['Ollama', '<span class="mono">' + esc(i.version || 'unknown') + '</span>'], ['Mutual TLS', i.tls ? 'client certificate' + (i.tls.caFile ? ', private CA' : '') : 'none'], ['Poll latency', esc(dur(i.latencyMs))], ['First token', esc(dur(i.firstTokenMs))], ['Slots', i.inflight + ' of ' + i.parallel + ' busy, ' + i.queued + ' queued'], ['Last seen', esc(when(i.last_seen_at))]], 2)
            + '<div class="eyebrow">Loaded models</div>' + (i.loaded.length ? '<div class="vstack gap4">' + i.loaded.map((m) => '<div class="hstack"><span class="mono grow">' + esc(m.name) + '</span>' + (m.drift ? '<span class="pl-drift">drift</span>' : '') + UI.pill(m.residency, resKind(m.residency)) + UI.btn('Details', { size: 'xs', attrs: 'data-close data-m="' + esc(m.name) + '"' }) + '</div>').join('') + '</div>' : '<div class="muted">nothing loaded</div>')
            + (i.available.length ? '<div class="muted" style="font-size:12px">Pulled here: ' + esc(i.available.map((a) => a.name + ' ' + gb(a.sizeBytes)).join(', ')) + '</div>' : '')
            + '<div class="eyebrow">Memory</div>' + memBar(i) + '<div class="muted" style="font-size:12px">' + esc(memText(i)) + '</div>'
            + '<div class="eyebrow">Recorded settings as Ollama environment</div>' + (env ? UI.code(env, 'env') : '<div class="muted" style="font-size:12px">No settings recorded; Ollama defaults apply.</div>')
            + '<div class="eyebrow">Recent events</div><div data-events><div class="muted pl-ev">Loading history…</div></div>',
          actions: UI.btn('Load model here', { kind: 'primary', attrs: 'data-close data-loadhere', disabled: i.state !== 'active' })
            + UI.btn(i.state === 'draining' ? 'Return to service' : 'Drain', { attrs: 'data-close data-drainthis', disabled: i.state === 'disabled' })
            + UI.btn('Edit', { attrs: 'data-close data-editthis' })
            + (i.state === 'draining' ? '' : UI.btn(i.state === 'disabled' ? 'Enable' : 'Disable', { attrs: 'data-close data-togglethis' }))
            + UI.btn('Remove', { kind: 'danger', attrs: 'data-close data-rmthis' }),
          onMount(d) {
            d.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => later(() => modelDrawer(p.id, id, b.dataset.m))));
            d.querySelector('[data-loadhere]').addEventListener('click', () => later(() => loadModal(id)));
            d.querySelector('[data-drainthis]').addEventListener('click', () => later(() => (i.state === 'draining' ? undrain(id) : drainFlow(id))));
            d.querySelector('[data-editthis]').addEventListener('click', () => later(() => instModal(p.id, i)));
            const tog = d.querySelector('[data-togglethis]'); if (tog) tog.addEventListener('click', () => later(() => toggleInst(i)));
            d.querySelector('[data-rmthis]').addEventListener('click', () => later(() => removeInst(i)));
            d.querySelector('[data-zone]').addEventListener('click', (e) => { e.preventDefault(); App.closeOverlay(); ctx.navigate('zones'); });
            App.get('/api/admin/instances/' + enc(id) + '/events').then((evs) => { const box = d.querySelector('[data-events]'); if (box) box.innerHTML = eventsTimeline(evs.slice(0, 12)); })
              .catch((err) => { const box = d.querySelector('[data-events]'); if (box) box.innerHTML = UI.notice('History could not be loaded: ' + esc(err.message), 'danger'); });
          } });
      };
      ctx.on('click', '.pl-grid.row', (e, t) => { if (e.target.closest('.pl-model,[data-inst-open]')) return; instDrawer(t.dataset.inst); });
      ctx.on('click', '[data-inst-open]', (e, t) => instDrawer(t.dataset.instOpen));

      const toggleInst = async (i) => {
        const disable = i.state !== 'disabled';
        const ok = await ctx.confirm({ title: (disable ? 'Disable ' : 'Enable ') + i.name, tag: disable ? 'stops routing' : 'returns to routing', tone: disable ? 'danger' : 'info', body: '<p style="margin:0" class="fg2">' + (disable ? 'The gateway stops polling and routing to this instance. Models stay wherever Ollama keeps them.' : 'The gateway polls the instance again and routes to it once it answers.') + '</p>', ok: disable ? 'Disable' : 'Enable' });
        if (!ok) return;
        try { await App.patch('/api/admin/instances/' + enc(i.id), { state: disable ? 'disabled' : 'active' }); ctx.toast(esc(i.name) + (disable ? ' disabled.' : ' enabled.'), 'ok'); quiet(); } catch (err) { App.fail(err); }
      };
      const removeInst = async (i) => {
        const ok = await ctx.confirm({ title: 'Remove ' + i.name, tag: 'cannot be undone', tone: 'danger', body: '<p style="margin:0" class="fg2">The gateway forgets this endpoint and its history. Ollama itself keeps running; stop it with Compose or systemd.</p>', kv: [['URL', '<span class="mono">' + esc(i.url) + '</span>'], ['Loaded', esc(i.loaded.map((m) => m.name).join(', ') || 'nothing')]], ok: 'Remove instance' });
        if (!ok) return;
        try { await App.del('/api/admin/instances/' + enc(i.id)); delete st.notes[i.id]; ctx.toast(esc(i.name) + ' removed. Audit entry written.', 'ok'); quiet(); } catch (err) { App.fail(err); }
      };

      // ----- model: residency and "why is this cold?" -----
      const modelDrawer = (poolId, instId, name) => {
        const p = pools.find((x) => x.id === poolId); if (!p) return;
        const r = instId ? findInst(instId) : null; const i = r && r.i;
        const m = i && i.loaded.find((x) => x.name === name);
        const pl = placementOf(p, name); const cat = catalog(name);
        const targets = i ? [i] : p.instances;
        const residency = m ? m.residency : 'cold';
        const pinned = pl && pl.residency === 'pinned';
        ctx.drawer({ title: '<span class="mono">' + esc(name) + '</span>' + (i ? ' on ' + esc(i.name) : ' in ' + esc(p.name)), onClose,
          body: '<div class="hstack">' + UI.pill(m ? residency : 'not loaded', resKind(m ? residency : 'cold')) + (m && m.drift ? '<span class="pl-drift">estimate drift</span>' : '') + (cat ? UI.label(cat.label, { sm: true }) : '') + '</div>'
            + UI.kv([['Residency on ' + p.name, pl ? esc(pl.residency) : 'not placed'], ['Catalogue state', cat ? esc(cat.state) : 'not in the catalogue'],
              ['Measured (/api/ps)', m ? gb(m.sizeBytes) : 'not resident'], ['Estimate', m && m.estimateBytes ? gb(m.estimateBytes) : cat && cat.sizeBytes ? gb(Math.round(cat.sizeBytes * 1.2)) : 'unknown'],
              ['size_vram', m ? gb(m.vramBytes) : 'none'], ['Expires', m ? (m.expiresAt && Date.parse(m.expiresAt) - Date.now() < 365 * 864e5 ? esc(when(Date.parse(m.expiresAt))) : 'never (keep_alive -1)') : 'none']], 2)
            + '<div data-why></div><div class="eyebrow">History</div><div data-hist><div class="muted pl-ev">Loading history…</div></div>',
          actions: (pinned ? UI.btn('Unpin', { attrs: 'data-close data-unpin' }) : UI.btn('Pin', { kind: 'primary', attrs: 'data-close data-pin', disabled: !cat })) + (m ? UI.btn('Unload', { kind: 'danger', attrs: 'data-close data-unload' }) : (i || p.instances.length ? UI.btn('Load', { attrs: 'data-close data-mload' }) : '')) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(d) {
            const pin = d.querySelector('[data-pin]'); if (pin) pin.addEventListener('click', () => later(() => pinFlow(p, i, name, true)));
            const unpin = d.querySelector('[data-unpin]'); if (unpin) unpin.addEventListener('click', () => later(() => pinFlow(p, i, name, false)));
            const un = d.querySelector('[data-unload]'); if (un) un.addEventListener('click', () => later(() => unloadFlow(i, name)));
            const ld = d.querySelector('[data-mload]'); if (ld) ld.addEventListener('click', () => later(() => loadModal(i ? i.id : (p.instances.find((x) => x.state === 'active') || p.instances[0]).id, name)));
            Promise.all(targets.map((t) => App.get('/api/admin/instances/' + enc(t.id) + '/events').then((evs) => evs.map((ev) => Object.assign({ inst: t.name }, ev)))))
              .then((lists) => {
                const evs = lists.reduce((a, l) => a.concat(l), []).filter((ev) => sameModel(ev.model, name)).sort((a, b) => b.ts - a.ts);
                const last = evs[0];
                let why;
                if (m) why = 'Resident' + (last && last.event === 'load' ? ' since ' + esc(when(last.ts)) + ': ' + esc(last.reason || 'loaded') + (last.actor ? ' (' + esc(last.actor) + ')' : '') : '') + '. Residency <b>' + esc(residency) + '</b>' + (residency === 'pinned' ? '; the planner never evicts it.' : '; the planner may evict it to make room for another load.');
                else if (!last) why = 'No load, unload or eviction of ' + esc(name) + ' is recorded' + (i ? ' on ' + esc(i.name) : ' in ' + esc(p.name)) + '. It has not been loaded here since the gateway started keeping history.';
                else why = 'Cold since ' + esc(when(last.ts)) + (last.inst && !i ? ' on ' + esc(last.inst) : '') + ': ' + esc(last.reason || 'no reason recorded') + ' (' + esc((EVENT_TEXT[last.event] || last.event).toLowerCase()) + (last.actor ? ' by ' + esc(last.actor) : '') + '). Residency <b>' + esc(pl ? pl.residency : 'not placed') + '</b>' + (pl && pl.residency === 'pinned' ? '; it loads again on first use.' : '. Pin it to keep it resident.');
                const w = d.querySelector('[data-why]'); if (w) w.innerHTML = UI.notice(why, m ? 'info' : 'warn');
                const box = d.querySelector('[data-hist]'); if (box) box.innerHTML = eventsTimeline(evs.slice(0, 15), !i);
              })
              .catch((err) => { const box = d.querySelector('[data-hist]'); if (box) box.innerHTML = UI.notice('History could not be loaded: ' + esc(err.message), 'danger'); });
          } });
      };
      ctx.on('click', '.pl-model[data-model]', (e, t) => { e.stopPropagation(); const r = findInst(t.dataset.on); if (r) modelDrawer(r.p.id, r.i.id, t.dataset.model); });
      ctx.on('click', '[data-cold]', (e, t) => modelDrawer(t.dataset.cold, null, t.dataset.cmodel));
      if (st.openCold) { const c = st.openCold; st.openCold = null; later(() => modelDrawer(c.pool, c.inst, c.model)); }

      // Pinning is the pool placement's residency (the planner never evicts pinned models); a pin also loads the model
      // on the instance with keep_alive -1.
      const pinFlow = async (p, i, name, pin) => {
        const pl = placementOf(p, name); const cat = catalog(name);
        const ok = await ctx.confirm({ title: (pin ? 'Pin ' : 'Unpin ') + name, tag: pin ? 'keep resident' : 'warm', tone: 'info',
          body: '<p style="margin:0" class="fg2">' + (pin ? 'Sets its residency on ' + esc(p.name) + ' to pinned, so the planner never evicts it' + (i ? ', and loads it on ' + esc(i.name) + ' with keep_alive -1' : '') + '. A load counts toward the anti-thrash limit.' : 'Sets its residency on ' + esc(p.name) + ' to warm. It stays loaded until it expires, is unloaded, or the planner evicts it for another load.') + '</p>', ok: pin ? 'Pin' : 'Unpin' });
        if (!ok) return;
        try {
          if (pl) await App.patch('/api/admin/placements/' + enc(pl.id), { residency: pin ? 'pinned' : 'warm' });
          else if (cat) await App.post('/api/admin/placements', { modelId: cat.id, poolId: p.id, residency: pin ? 'pinned' : 'warm', pull: false });
          if (pin && i && i.state === 'active') await doLoad(i, name, true);
          else { ctx.toast(esc(name) + (pin ? ' pinned on ' : ' unpinned on ') + esc(p.name) + '.', 'ok'); quiet(); }
        } catch (err) { App.fail(err); quiet(); }
      };
      const unloadFlow = async (i, name) => {
        const ok = await ctx.confirm({ title: 'Unload ' + name + ' from ' + i.name, tag: 'unload', tone: 'warn', body: '<p style="margin:0" class="fg2">Sends keep_alive 0. The next request for it on this instance pays a cold start. A pinned placement is not changed.</p>', ok: 'Unload' });
        if (!ok) return;
        try { await App.post('/api/admin/instances/' + enc(i.id) + '/unload', { model: name }); ctx.toast(esc(name) + ' unloaded from ' + esc(i.name) + '. Memory freed.', 'ok'); quiet(); } catch (err) { App.fail(err); quiet(); }
      };
      ctx.on('change', '[data-residency]', async (e, t) => {
        const pl = pools.reduce((a, p) => a.concat(p.placements), []).find((x) => x.id === t.dataset.residency); if (!pl) return;
        try { await App.patch('/api/admin/placements/' + enc(pl.id), { residency: t.value }); ctx.toast(esc(pl.model) + ' residency set to ' + esc(t.value) + '.', 'ok'); quiet(); } catch (err) { App.fail(err); quiet(); }
      });
      ctx.on('click', '[data-unplace]', async (e, t) => {
        const ok = await ctx.confirm({ title: 'Remove placement of ' + t.dataset.umodel, tag: 'placement', tone: 'danger', body: '<p style="margin:0" class="fg2">The model is no longer placed on this pool. Loaded copies stay until unloaded; profiles that route here stop finding it.</p>', ok: 'Remove placement' });
        if (!ok) return;
        try { await App.del('/api/admin/placements/' + enc(t.dataset.unplace)); ctx.toast('Placement of ' + esc(t.dataset.umodel) + ' removed.', 'ok'); quiet(); } catch (err) { App.fail(err); }
      });

      // ----- load with the memory planner -----
      const doLoad = async (i, name, pinned) => {
        st.busy[i.id] = 'load:' + name; refresh();
        ctx.toast('Loading ' + esc(name) + ' on ' + esc(i.name) + (pinned ? ', pinned' : '') + '.', '', 3000);
        try {
          const out = await App.post('/api/admin/instances/' + enc(i.id) + '/load', { model: name, pinned: !!pinned });
          delete st.notes[i.id];
          ctx.toast(esc(name) + ' loaded on ' + esc(i.name) + (pinned ? ' with keep_alive -1' : '') + '.' + (out && out.evicted && out.evicted.length ? ' Evicted ' + esc(out.evicted.join(', ')) + '.' : ''), 'ok', 5000);
        } catch (err) {
          const pr = err.problem || {};
          if (err.status === 409 && pr.title === 'No spare memory') st.notes[i.id] = { kind: 'nospare', model: name, plan: pr.plan, detail: pr.detail || '', at: Date.now() };
          else if (err.status === 429 && pr.limit === 'anti_thrash') st.notes[i.id] = { kind: 'thrash', detail: pr.detail || '', retry: pr.retry_after || 60, loads: pr.loads, max: pr.max, at: Date.now() };
          else App.fail(err, 'Could not load ' + name);
        } finally { delete st.busy[i.id]; quiet(); }
      };
      const planHtml = (pl, inst) => {
        if (!pl) return '';
        const need = 'Needs about ' + gb(pl.needBytes) + ' (catalogue size plus 20% for KV cache and overhead)';
        const free = pl.freeBytes == null ? 'no memory size is declared for ' + esc(inst.name) : gb(pl.freeBytes) + ' free on ' + esc(inst.name);
        if (pl.resident) return UI.notice('<b>Memory planner.</b> Already resident on ' + esc(inst.name) + '. Loading again refreshes its keep_alive.', 'info');
        if (!pl.fits) return UI.notice('<b>Memory planner: does not fit.</b> ' + need + '; ' + free + '. ' + esc(pl.reason) + '. Pinned models are never evicted.', 'danger');
        if (pl.evict.length) return UI.notice('<b>Memory planner: fits after evicting ' + esc(pl.evict.join(', ')) + '.</b> ' + need + '; ' + free + '. Warm models expiring soonest go first.', 'warn');
        return UI.notice('<b>Memory planner: fits.</b> ' + need + '; ' + free + '. ' + esc(pl.reason) + '. The estimate is compared with /api/ps after the load.', 'ok');
      };
      const loadModal = (instId, modelName) => {
        // B-4302: a Chat Completions server holds its own models; loads go to Ollama instances only.
        const act = allInst.filter((x) => x.state === 'active' && x.kind !== 'openai');
        if (!act.length) { ctx.toast(allInst.some((x) => x.kind === 'openai') ? 'No Ollama instance is in service. Chat Completions servers keep their own models in memory; there is nothing to load on them.' : 'No instance is in service. Add one or return a drained instance to service first.', 'warn'); return; }
        const start = act.find((x) => x.id === instId) || act.find((x) => x.health === 'healthy') || act[0];
        const opts = act.map((x) => ({ value: x.id, label: x.name + (x.memory && x.memory.freeBytes != null ? ', free ' + gb(x.memory.freeBytes) : '') + (x.health !== 'healthy' ? ', ' + x.health : '') }));
        const modelOpts = (inst) => inst.available.map((a) => ({ value: a.name, label: a.name + ', ' + gb(a.sizeBytes) + (inst.loaded.some((m) => m.name === a.name) ? ', loaded' : '') }));
        ctx.modal({ title: 'Load model', onClose,
          body: '<div class="formgrid" style="--cols:2">' + UI.field('Instance', UI.select(opts, start.id, 'data-target')) + UI.field('Model', '<select class="select" data-lmodel></select>', 'Models pulled on this instance') + '</div>'
            + UI.check('Pin: keep_alive -1, and pinned residency on the pool so the planner never evicts it', false, 'data-lpin')
            + '<div data-plan></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Load', { kind: 'primary', attrs: 'data-do' }),
          onMount(m) {
            const tSel = m.querySelector('[data-target]'), mSel = m.querySelector('[data-lmodel]'), box = m.querySelector('[data-plan]'), go = m.querySelector('[data-do]');
            let seq = 0;
            const plan = () => {
              const inst = allInst.find((x) => x.id === tSel.value); const name = mSel.value; const n = ++seq;
              if (!name) { box.innerHTML = UI.notice('Nothing is pulled on ' + esc(inst.name) + '. Place a model on ' + esc((findInst(inst.id) || {}).p.name) + ' and pull it from Models first.', 'warn'); go.disabled = true; return; }
              go.disabled = false; box.innerHTML = UI.notice('Asking the memory planner…', 'info');
              App.get('/api/admin/instances/' + enc(inst.id) + '/plan?model=' + enc(name)).then((pl) => { if (n === seq) box.innerHTML = planHtml(pl, inst); })
                .catch((err) => { if (n === seq) box.innerHTML = UI.notice(esc(err.message), 'danger'); });
            };
            const fill = () => { const inst = allInst.find((x) => x.id === tSel.value); const o = modelOpts(inst); mSel.innerHTML = o.map((x) => '<option value="' + esc(x.value) + '">' + esc(x.label) + '</option>').join(''); const pick = o.find((x) => x.value === modelName) || o.find((x) => !inst.loaded.some((l) => l.name === x.value)) || o[0]; if (pick) mSel.value = pick.value; plan(); };
            tSel.addEventListener('change', fill); mSel.addEventListener('change', plan); fill();
            go.addEventListener('click', async () => {
              const inst = allInst.find((x) => x.id === tSel.value); const name = mSel.value; const pin = m.querySelector('[data-lpin]').checked;
              if (!name) return;
              App.closeOverlay();
              if (pin) { const p = findInst(inst.id).p; const pl = placementOf(p, name); const cat = catalog(name); try { if (pl) await App.patch('/api/admin/placements/' + enc(pl.id), { residency: 'pinned' }); else if (cat) await App.post('/api/admin/placements', { modelId: cat.id, poolId: p.id, residency: 'pinned', pull: false }); } catch (err) { App.fail(err); } }
              doLoad(inst, name, pin);
            });
          } });
      };
      ctx.on('click', '[data-load]', () => loadModal());
      ctx.on('click', '[data-planner]', (e, t) => loadModal(t.dataset.planner, t.dataset.pmodel));
      if (st.openLoad && st.loaded) { st.openLoad = false; later(() => loadModal()); }
      if (st.openAddPool && st.loaded) { st.openAddPool = false; later(() => poolModal(null)); }

      // ----- drain -----
      const runDrain = async (i) => {
        st.busy[i.id] = 'draining'; refresh();
        ctx.toast('Draining ' + esc(i.name) + '. ' + i.inflight + ' requests finishing; new requests route to other instances.', 'warn', 5000);
        try { const out = await App.post('/api/admin/instances/' + enc(i.id) + '/drain'); ctx.toast(esc(i.name) + ' drained.' + (out && out.unloaded && out.unloaded.length ? ' Unloaded ' + esc(out.unloaded.join(', ')) + '.' : ' Nothing was loaded.'), 'ok', 5000); }
        catch (err) { App.fail(err); } finally { delete st.busy[i.id]; quiet(); }
      };
      const drainFlow = async (instId) => {
        if (!instId) {
          const cand = allInst.filter((x) => x.state === 'active');
          if (!cand.length) { ctx.toast('No instance is in service.', 'warn'); return; }
          ctx.modal({ title: 'Drain instance', onClose, body: UI.field('Instance', UI.select(cand.map((x) => ({ value: x.id, label: x.name + ', ' + x.inflight + ' in flight, ' + x.loaded.length + ' loaded' })), cand[0].id, 'data-target')) + UI.notice('New requests route to other instances at once. In-flight requests finish (up to ten minutes), then every model unloads and the instance is free for an upgrade or maintenance.', 'info'),
            actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Drain', { attrs: 'data-do', kind: 'primary' }),
            onMount(m) { m.querySelector('[data-do]').addEventListener('click', () => { const v = m.querySelector('[data-target]').value; App.closeOverlay(); const r = findInst(v); if (r) runDrain(r.i); }); } });
          return;
        }
        const r = findInst(instId); if (!r) return; const i = r.i;
        const ok = await ctx.confirm({ title: 'Drain ' + i.name, tag: 'drain', tone: 'warn', body: '<p style="margin:0" class="fg2">New requests route elsewhere; in-flight requests finish; every model unloads with keep_alive 0.</p>', kv: [['In flight', String(i.inflight)], ['Loaded', esc(i.loaded.map((m) => m.name).join(', ') || 'nothing')], ['Pinned', String(i.loaded.filter((m) => m.residency === 'pinned').length)]], ok: 'Drain' });
        if (ok) runDrain(i);
      };
      const undrain = async (instId) => {
        const r = findInst(instId); if (!r) return;
        const ok = await ctx.confirm({ title: 'Return ' + r.i.name + ' to service', tag: 'undrain', tone: 'info', body: '<p style="margin:0" class="fg2">The gateway routes requests to it again. Pinned models load on first use, or load them now from the instance.</p>', ok: 'Return to service' });
        if (!ok) return;
        try { await App.post('/api/admin/instances/' + enc(instId) + '/undrain'); ctx.toast(esc(r.i.name) + ' back in rotation.', 'ok'); quiet(); } catch (err) { App.fail(err); }
      };
      ctx.on('click', '[data-drain]', () => drainFlow());
      ctx.on('click', '[data-undrain]', (e, t) => undrain(t.dataset.undrain));

      // ----- rolling upgrade -----
      ctx.on('click', '[data-roll]', (e, t) => {
        const p = pools.find((x) => x.id === t.dataset.roll); if (!p) return;
        const versions = p.instances.map((i) => i.version).filter(Boolean);
        const uniq = versions.filter((v, n) => versions.indexOf(v) === n);
        ctx.modal({ title: 'Roll Ollama upgrade on ' + esc(p.name), onClose,
          body: '<div class="formgrid" style="--cols:2">' + UI.field('Target version', UI.input('', { attrs: 'data-uver maxlength="40"', placeholder: uniq[0] || '0.12.4' }), 'Currently ' + esc(uniq.join(', ') || 'unknown')) + UI.field('Wait per instance (minutes)', UI.input('30', { type: 'number', attrs: 'data-uwait min="1" max="240"' })) + '</div>'
            + UI.notice('One instance at a time: it drains, then the job waits for your deployment (Compose or systemd) to bring it back reporting the target version, reloads the pool\'s pinned models and returns it to service. Instances already on the target are skipped. The job stops at the first instance that does not come back in time and leaves the rest untouched.', 'info')
            + UI.kv(p.instances.map((i) => [i.name, '<span class="mono">' + esc(i.version || 'unknown') + '</span>']), 2),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Start rollout', { kind: 'primary', attrs: 'data-do' }),
          onMount(m) {
            const btn = m.querySelector('[data-do]');
            btn.addEventListener('click', async () => {
              const target = m.querySelector('[data-uver]').value.trim(); const wait = Number(m.querySelector('[data-uwait]').value || 30);
              btn.disabled = true;
              try {
                const out = await App.post('/api/admin/pools/' + enc(p.id) + '/upgrade', { targetVersion: target, waitMinutes: wait });
                App.closeOverlay();
                st.upgrades[p.id] = { jobId: out.jobId, pool: p.name, target, state: 'queued', progress: 0, message: 'Queued' };
                ctx.toast('Rolling upgrade of ' + esc(p.name) + ' to Ollama ' + esc(target) + ' started.', 'ok'); refresh();
              } catch (err) { btn.disabled = false; App.fail(err); }
            });
          } });
      });
    }
  });

  function flat(pools) { return pools.reduce((a, p) => a.concat(p.instances), []); }
})();
