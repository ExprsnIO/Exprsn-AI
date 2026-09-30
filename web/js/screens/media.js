(function () {
  // Media, backed by /api/media: uploads are probed and refused above the caps before any processing, stored sealed
  // without metadata, and processed by presets whose typed parameters become ffmpeg argument arrays on the server.
  // Ingest and job progress arrive over the socket (media.asset, media.job).
  const { UI, esc } = App;

  const enc = encodeURIComponent;
  const S = () => App.stateFor('media');
  const visible = () => App.state.route === 'media';
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const ACTIVE = { queued: 1, running: 1 };
  const p2 = (n) => String(n).padStart(2, '0');
  const fmt = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000)); const h = Math.floor(s / 3600); return (h ? p2(h) + ':' : '') + p2(Math.floor((s % 3600) / 60)) + ':' + p2(s % 60); };
  const fmtLong = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000)); return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor((s % 3600) / 60)) + ':' + p2(s % 60); };
  const size = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const streamsText = (a) => { const c = {}; (a.streams || []).forEach((x) => { c[x.type] = (c[x.type] || 0) + 1; }); const parts = Object.keys(c).map((k) => c[k] + ' ' + k); return parts.length ? parts.join(', ') : 'not probed yet'; };
  const shortId = (id) => 'media.' + String(id).slice(-6).toLowerCase();
  const encName = (e) => (e === 'nvenc' ? 'NVENC' : e === 'cpu' ? 'CPU' : '—');

  // ---------- live updates ----------
  const live = { sock: null, handlers: null, timer: null };
  function detach() {
    if (live.sock && live.handlers) Object.keys(live.handlers).forEach((ev) => live.sock.off(ev, live.handlers[ev]));
    live.sock = null; live.handlers = null;
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  }
  /** A playing video or audio element would restart on a re-render: wait until it pauses. */
  const playing = () => Array.prototype.some.call(document.querySelectorAll('#main video, #main audio'), (m) => !m.paused);
  function schedule() {
    if (live.timer) return;
    live.timer = setTimeout(() => {
      live.timer = null;
      if (!visible()) return;
      if (document.getElementById('overlay') || playing()) { schedule(); return; }
      App.render();
    }, 400);
  }
  function attach() {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    const guard = (fn) => (d) => { if (!visible()) { detach(); return; } fn(S(), d || {}); };
    live.handlers = {
      'media.asset': guard((st, d) => { reloadList(); if (st.details && st.details[d.id]) loadDetail(d.id); }),
      'media.job': guard((st, d) => {
        const det = st.details && st.details[d.assetId];
        const j = det && det.jobs.find((x) => x.id === d.id);
        if (j) Object.keys(d).forEach((k) => { if (d[k] !== undefined) j[k] = d[k]; });
        if (!ACTIVE[d.state] && det) loadDetail(d.assetId);
        schedule();
      })
    };
    Object.keys(live.handlers).forEach((ev) => live.sock.on(ev, live.handlers[ev]));
  }
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'media') detach(); });

  function reloadList() { App.get('/api/media/assets').then((list) => { S().assets = list; schedule(); }).catch(() => undefined); }
  function loadDetail(id) {
    const st = S(); st.details = st.details || {};
    return App.get('/api/media/assets/' + enc(id)).then((d) => { st.details[id] = d; const i = (st.assets || []).findIndex((x) => x.id === id); if (i >= 0) st.assets[i] = Object.assign({}, st.assets[i], d); schedule(); return d; }).catch((err) => { st.detailError = err; schedule(); });
  }

  App.register({
    id: 'media', title: 'Media', live: true, summary: 'Assets, presets, trim and frame scrubber, media jobs',
    crumb: (st) => { const a = (st.assets || []).find((x) => x.id === st.asset); return ['Media'].concat(a ? [a.name] : []); },
    label: (st) => { const a = (st.assets || []).find((x) => x.id === st.asset); return a ? a.label : null; },
    commands: [{ label: 'Run a media preset', sub: 'Media', run(app) { app.stateFor('media').openRun = true; app.render(); } }],
    states: [
      { title: 'Refused at probe', tone: 'danger', text: 'A file above the resolution cap is refused before it starts, with the cap and who sets it.', apply(ctx) {
        const a = (ctx.state.assets || []).find((x) => x.state === 'refused');
        if (a) { ctx.state.asset = a.id; ctx.rerender(); return; }
        ctx.toast('<span>No upload has been refused. A file above a cap (duration, resolution, streams or size) is refused at probe, before any processing, and shows the cap here.</span>', '', 7000);
      } },
      { title: 'Frame failed safety', tone: 'warn', text: 'Sampled frames that fail the image-safety classifier are withheld from the vision model. The rest continue.', apply(ctx) {
        const st = ctx.state; const hit = Object.keys(st.details || {}).map((k) => st.details[k]).find((d) => d.jobs.some((j) => j.result && j.result.withheld));
        if (hit) { st.asset = hit.id; ctx.rerender(); return; }
        ctx.toast('<span>No sampled frame has been withheld in the assets opened so far. frames-1fps runs every frame through the image-safety classifier and reports withheld ones here.</span>', '', 7000);
      } },
      { title: 'Transcript redacted', tone: 'neutral', text: 'Guardrails masked personal data in the transcript before it reached a model or a user.', apply(ctx) {
        const st = ctx.state; const hit = Object.keys(st.details || {}).map((k) => st.details[k]).find((d) => d.jobs.some((j) => j.result && j.result.masked));
        if (hit) { st.asset = hit.id; ctx.rerender(); return; }
        ctx.toast('<span>No transcript has been redacted in the assets opened so far. Transcripts pass the media guardrail checkpoint, which masks what its rules match before storage.</span>', '', 7000);
      } },
      { title: 'No free-form arguments', tone: 'neutral', text: 'There is no command field anywhere. Parameters come only from the preset\'s typed form.', apply(ctx) { ctx.state.noFreeform = true; ctx.state.openRun = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      if (ctx.params.asset) { st.asset = ctx.params.asset; delete ctx.params.asset; }
      st.query = st.query || ''; st.trims = st.trims || {}; st.heads = st.heads || {}; st.details = st.details || {};

      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/media/caps'), App.get('/api/media/assets')])
          .then(([caps, assets]) => { Object.assign(st, { caps, assets, loaded: true, loadError: null }); attach(); })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; schedule(); });
      };
      if (!st.loaded && !st.loadError) load();
      if (!st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Media', 'Assets, presets and media jobs') + (st.loadError ? UI.problem('Media could not be loaded', st.loadError.message, (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      attach();

      const caps = st.caps.caps; const presets = st.caps.presets;
      const assets = st.assets || [];
      if (!assets.some((x) => x.id === st.asset)) st.asset = assets[0] ? assets[0].id : null;
      const a = assets.find((x) => x.id === st.asset) || null;
      if (a && !st.details[a.id] && !st.loadingDetail) { st.loadingDetail = true; loadDetail(a.id).then(() => { st.loadingDetail = false; }); }
      const det = a ? st.details[a.id] : null;
      const jobs = det ? det.jobs : [];
      const list = assets.filter((x) => !st.query || x.name.toLowerCase().indexOf(st.query.toLowerCase()) >= 0);
      const capText = fmt(caps.maxDurationMs) + ', ' + caps.maxWidth + ' x ' + caps.maxHeight + ', ' + caps.maxStreams + ' streams, ' + size(caps.maxBytes);
      if (!st.preset || !presets.some((p) => p.id === st.preset)) st.preset = presets[0].id;
      const applicable = (p) => a && a.kind && p.kinds.indexOf(a.kind) >= 0;
      if (a && a.kind && !applicable(presets.find((p) => p.id === st.preset))) { const first = presets.find(applicable); if (first) st.preset = first.id; }
      const preset = presets.find((p) => p.id === st.preset);
      const ready = a && a.state === 'ready';
      const refused = a && a.state === 'refused';
      const dur = a && a.durationMs ? a.durationMs : 0;
      const trim = a ? (st.trims[a.id] || [0, dur]) : [0, 0];
      const head = a ? (st.heads[a.id] != null ? st.heads[a.id] : trim[0]) : 0;
      const pct = (ms) => (dur ? (ms / dur) * 100 : 0);
      const transcriptJob = jobs.find((j) => j.preset === 'transcribe-srt' && j.state === 'succeeded');

      // ---- preview ----
      let preview = '';
      if (a && ready) {
        const src = '/api/media/assets/' + enc(a.id) + '/content';
        if (a.kind === 'video') preview = '<video data-media src="' + src + '" preload="metadata" playsinline style="width:100%;height:100%;object-fit:contain;display:block;background:var(--fg)"></video>';
        else if (a.kind === 'audio') preview = (a.previews ? '<img src="/api/media/assets/' + enc(a.id) + '/previews/0" alt="" style="width:100%;height:100%;object-fit:fill;display:block">' : '') + '<audio data-media src="' + src + '" preload="metadata"></audio>';
        else preview = '<img src="' + src + '" alt="' + esc(a.name) + '" style="width:100%;height:100%;object-fit:contain;display:block">';
      }
      const caption = !a ? '' : a.kind === 'video' ? 'video preview, <span data-headtext>' + fmtLong(head) + '</span> of ' + fmtLong(dur) : a.kind === 'audio' ? 'waveform, <span data-headtext>' + fmtLong(head) + '</span> of ' + fmtLong(dur) : 'image preview, ' + esc((a.width || '?') + ' x ' + (a.height || '?'));
      const nFrames = a && a.kind === 'video' ? a.previews : 0;
      const strip = nFrames ? '<div class="media-strip" role="group" aria-label="Frame scrubber" style="grid-template-columns:repeat(' + nFrames + ',minmax(0,1fr))">' + Array.from({ length: nFrames }, (_, i) => { const t = Math.round((i / nFrames) * dur); return '<button type="button" class="media-frame' + (Math.floor((head / (dur || 1)) * nFrames) === i ? ' cur' : '') + (t >= trim[0] && t <= trim[1] ? ' in' : '') + '" data-seek="' + t + '" title="' + fmt(t) + '"><img src="/api/media/assets/' + enc(a.id) + '/previews/' + i + '" alt="" loading="lazy"><span>' + fmt(t) + '</span></button>'; }).join('') + '</div>' : '';
      const trimbar = !a || !ready || a.kind === 'image' ? '' : '<div class="vstack gap4"><div class="media-track" data-track title="Click to move the playhead"><div class="media-sel" style="left:' + pct(trim[0]) + '%;width:' + (pct(trim[1]) - pct(trim[0])) + '%"></div><div class="media-head" style="left:' + pct(head) + '%"></div></div>'
        + '<div class="hstack muted" style="font-size:12px;justify-content:space-between"><span class="num">00:00</span><span class="hstack gap6"><span>Trim ' + fmt(trim[0]) + ' to ' + fmt(trim[1]) + '</span>' + UI.btn('Set start', { kind: 'ghost', size: 'xs', attrs: 'data-trim="0"' }) + UI.btn('Set end', { kind: 'ghost', size: 'xs', attrs: 'data-trim="1"' }) + UI.btn('Reset', { kind: 'ghost', size: 'xs', attrs: 'data-trimreset' }) + '</span><span class="num">' + fmt(dur) + '</span></div></div>';

      const over = (v) => '<span style="color:var(--danger-fg)">' + v + '</span>';
      const tooWide = a && a.width && a.height && !((a.width <= caps.maxWidth && a.height <= caps.maxHeight) || (a.width <= caps.maxHeight && a.height <= caps.maxWidth));
      const kv = a ? UI.kv([
        ['Duration', a.kind === 'image' ? 'still image' : a.durationMs != null ? (a.durationMs > caps.maxDurationMs ? over(fmt(a.durationMs)) : fmt(a.durationMs)) + ' of ' + fmt(caps.maxDurationMs) + ' allowed' : 'not probed yet'],
        ['Resolution', a.width ? (tooWide ? over(a.width + ' x ' + a.height) + ' (cap ' + caps.maxWidth + ' x ' + caps.maxHeight + ')' : esc(a.width + ' x ' + a.height)) : a.kind === 'audio' ? 'audio only' : 'not probed yet'],
        ['Streams', esc(streamsText(a))],
        ['Size', esc(size(a.size)) + ' of ' + esc(size(caps.maxBytes)) + ' allowed'],
        ['Label', UI.label(a.label, { sm: true })],
        ['Metadata', ready ? 'GPS, device and author data removed' : refused ? 'not stored' : 'removed when the probe finishes']
      ], 3) : '';

      const presetCards = '<div class="media-presets">' + presets.map((p) => { const ok = applicable(p) && p.available; return '<button type="button" class="media-preset' + (p.id === st.preset ? ' on' : '') + '" data-preset="' + esc(p.id) + '"' + (ok ? '' : ' disabled title="' + esc(!p.available ? p.reason : a ? 'Not applicable to ' + (a.kind || 'this file') : 'Pick an asset') + '"') + '><span style="font-weight:600">' + esc(p.id) + '</span><span class="muted" style="font-size:12px">' + esc(p.sub) + '</span></button>'; }).join('') + '</div>';

      const jobRows = jobs.map((j) => {
        const fill = j.state === 'running' ? 'accent' : j.state === 'failed' ? 'danger' : '';
        const extra = j.result && j.result.withheld ? ' <span style="color:var(--warn-fg)">' + j.result.withheld + ' withheld</span>' : j.result && j.result.masked ? ' <span class="fg2">' + j.result.masked + ' masked</span>' : '';
        const stage = j.state === 'failed' ? 'Failed: ' + (j.error || '') : (j.stage || j.state);
        return { cells: ['<span class="mono">' + esc(shortId(j.id)) + '</span>', esc(j.preset), UI.meter(stage, j.progress + '%', j.progress, fill).replace('<span>' + esc(stage) + '</span>', '<span>' + esc(stage) + extra + '</span>'), esc(encName(j.encoder)), UI.pill(j.state)], attrs: 'data-job="' + esc(j.id) + '"' };
      });
      const frameJob = jobs.find((j) => j.result && j.result.withheld);
      const maskJob = jobs.find((j) => j.result && j.result.masked);
      const jobNotices = (frameJob ? UI.notice('<b>' + frameJob.result.withheld + ' of ' + (frameJob.result.withheld + frameJob.result.frames) + ' sampled frames were withheld</b> by the image-safety classifier at ' + esc((frameJob.result.withheldAt || []).join(', ')) + '. They were not stored and never reach a vision model. The other ' + frameJob.result.frames + ' continue.', 'warn', '<a href="#" data-goflags>Open flags</a>') : '')
        + (maskJob ? UI.notice('<b>Transcript redacted.</b> Guardrails masked ' + maskJob.result.masked + ' finding' + (maskJob.result.masked === 1 ? '' : 's') + ' before the transcript was stored. The unmasked text is not kept.', 'info', '<a href="#" data-transcript="' + esc(maskJob.id) + '">View transcript</a>') : '');

      const probeNotice = refused ? UI.problem('Refused at probe', a.reason || 'Above a cap.', false) + '<div class="hstack gap6">' + (App.can('platform:manage') ? UI.btn('Open Platform caps', { size: 'sm', attrs: 'data-goplatform' }) : '') + UI.btn('Ask for a higher cap', { size: 'sm', kind: 'ghost', attrs: 'data-askcap' }) + '</div>' : '';
      const pending = a && (a.state === 'quarantined' || a.state === 'probing') ? UI.notice('<b>' + (a.state === 'probing' ? 'Probing.' : 'In quarantine.') + '</b> ffprobe checks the container, duration, resolution, streams and size against the caps; metadata is removed and previews drawn before the file can be used.', 'info') : '';

      root.innerHTML = '<style>'
        + '.media-assets{display:grid;gap:8px;grid-template-columns:repeat(2,minmax(0,1fr))}'
        + '.media-asset{display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:pointer;text-align:left;font-family:inherit;color:var(--fg)}.media-asset:hover{border-color:var(--muted)}.media-asset.on{background:var(--accent-tint);border-color:var(--accent)}'
        + '.media-poster{height:84px;border-radius:4px;overflow:hidden;position:relative;background:var(--sel);display:flex;align-items:center;justify-content:center}.media-poster img{width:100%;height:100%;object-fit:cover;display:block}.media-poster .cap{position:absolute;left:6px;bottom:4px;font-size:11px;color:var(--panel);opacity:.9;font-family:var(--mono)}.media-poster .lbl{position:absolute;right:4px;top:4px}'
        + '.media-preview{flex-shrink:0;height:250px;border-radius:6px;overflow:hidden;position:relative;background:var(--fg);color:var(--fg2)}.media-preview .cap{position:absolute;left:12px;bottom:10px;font-size:12px;padding:3px 8px;border-radius:4px;background:var(--panel);color:var(--fg2);opacity:.92;font-family:var(--mono)}.media-preview .play{position:absolute;right:12px;bottom:10px}'
        + '.media-strip{flex-shrink:0;display:grid;gap:3px}.media-frame{position:relative;height:44px;padding:0;border:2px solid transparent;border-radius:3px;overflow:hidden;background:var(--sel);cursor:pointer;opacity:.55}.media-frame img{width:100%;height:100%;object-fit:cover;display:block}.media-frame.in{opacity:1}.media-frame.cur{border-color:var(--accent)}.media-frame span{position:absolute;left:0;right:0;bottom:0;font-size:9px;color:var(--panel);font-family:var(--mono);text-align:center;background:var(--fg);opacity:.85}'
        + '.media-track{position:relative;height:26px;background:var(--sel);border-radius:4px;cursor:pointer}.media-sel{position:absolute;top:0;bottom:0;background:var(--accent-tint);border-left:2px solid var(--accent);border-right:2px solid var(--accent)}.media-head{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--fg);transform:translateX(-1px)}'
        + '.media-presets{display:grid;gap:10px;grid-template-columns:repeat(4,minmax(0,1fr))}.media-preset{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:pointer;text-align:left;font-family:inherit;color:var(--fg)}.media-preset:hover{border-color:var(--muted)}.media-preset.on{background:var(--accent-tint);border-color:var(--accent)}.media-preset[disabled]{opacity:.45;cursor:not-allowed}'
        + '@media (max-width:900px){.media-presets{grid-template-columns:repeat(2,minmax(0,1fr))}}'
        + '</style>'
        + '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Assets</div>' + UI.btn('Upload', { size: 'sm', icon: 'upload', attrs: 'data-upload' + (App.can('chat:write') ? '' : ' disabled') }) + '</div>'
        + UI.search('Filter', 'data-filter', st.query).replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="media-assets">' + list.map((x) => {
          const poster = x.state === 'ready' && x.previews ? '<img src="/api/media/assets/' + enc(x.id) + '/previews/0" alt="" loading="lazy">' : x.state === 'refused' ? '<span style="color:var(--danger-fg);font-size:12px">refused</span>' : x.state === 'ready' ? '' : '<span class="muted" style="font-size:12px">' + (x.state === 'probing' ? 'probing' : 'in quarantine') + '</span>';
          const meta = x.state === 'refused' ? 'refused at probe' : x.state !== 'ready' ? x.state : x.kind === 'image' ? (x.width + ' x ' + x.height) : fmt(x.durationMs) + (x.kind === 'video' && x.height ? ', ' + x.height + 'p' : x.kind === 'audio' ? ', audio' : '');
          return '<button type="button" class="media-asset' + (a && x.id === a.id ? ' on' : '') + '" data-asset="' + esc(x.id) + '"><div class="media-poster">' + poster + (x.state === 'ready' ? '<span class="cap">' + (x.kind === 'video' ? 'poster frame' : x.kind === 'audio' ? 'waveform' : 'preview') + '</span>' : '') + '<span class="lbl">' + UI.label(x.label, { sm: true }) + '</span></div><div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(x.name) + '</div><div class="muted" style="font-size:11px">' + esc(meta) + '</div></button>';
        }).join('') + '</div>'
        + (list.length ? '' : UI.empty(assets.length ? 'No assets match' : 'No assets yet', assets.length ? 'Try another name or upload a file.' : 'Upload a video, audio file or image.'))
        + '<div class="muted" style="font-size:12px;margin-top:auto">Uploads are probed with ffprobe and refused above the caps: ' + esc(capText) + '.</div></div>'
        + '<div class="page">'
        + (a ? UI.pagehead(a.name, 'Uploaded by ' + esc(a.uploadedByName || (det && det.uploadedByName) || 'a member of this workspace') + ', ' + esc(when(a.createdAt)),
          (a.kind !== 'image' ? UI.btn('Send transcript to a knowledge base', { attrs: 'data-sendkb', disabled: !transcriptJob || !App.can('knowledge:read') || !App.can('chat:write'), title: !App.can('knowledge:read') ? 'Needs access to knowledge bases' : transcriptJob ? 'Adds the transcript as a document, keeping its label' : 'Run the transcribe-srt preset first' }) : '')
          + UI.btn('Run preset', { kind: 'primary', icon: 'play', attrs: 'data-run', disabled: !ready || !App.can('chat:write') }))
          : UI.pagehead('Media', 'Assets, presets and media jobs'))
        + probeNotice + pending
        + (a && ready ? '<div class="media-preview">' + preview + '<span class="cap">' + caption + '</span>' + (a.kind !== 'image' ? '<span class="play">' + UI.btn('Play', { size: 'sm', icon: 'play', attrs: 'data-play' }) + '</span>' : '') + '</div>' : '')
        + strip + trimbar + kv
        + (a ? '<div class="hstack"><div class="eyebrow grow">Presets</div><span class="muted" style="font-size:12px">Typed parameters only. Free-form FFmpeg arguments exist only in reviewed script tools.</span></div>' + presetCards : '')
        + (a ? '<div class="hstack"><div class="eyebrow grow">Jobs</div>' + UI.btn('Open in Runs', { kind: 'ghost', size: 'sm', attrs: 'data-goruns' }) + '</div>' + jobNotices
          + UI.table(['Job', 'Preset', { label: 'Progress', width: '32%' }, 'Encoder', 'State'], jobRows, { attrs: 'style="flex-shrink:0"', emptyTitle: 'No jobs for this asset', emptyText: 'Pick a preset and run it. Every job is probed first and runs on the media worker with local files only.' }) : '')
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div>';

      // ---- the media element drives the playhead without re-rendering ----
      const media = ctx.$('[data-media]');
      if (media && a) {
        const syncHead = () => {
          const ms = Math.round(media.currentTime * 1000); st.heads[a.id] = ms;
          const hd = ctx.$('.media-head'); if (hd) hd.style.left = pct(ms) + '%';
          const tx = ctx.$('[data-headtext]'); if (tx) tx.textContent = fmtLong(ms);
        };
        media.addEventListener('loadedmetadata', () => { if (head) media.currentTime = head / 1000; });
        media.addEventListener('timeupdate', syncHead);
        const btn = ctx.$('[data-play]');
        const label = () => { if (btn) btn.innerHTML = UI.icon(media.paused ? 'play' : 'pause', 14) + (media.paused ? 'Play' : 'Pause'); };
        media.addEventListener('play', label); media.addEventListener('pause', () => { label(); schedule(); });
      }

      // ---- events ----
      ctx.on('click', '[data-asset]', (e, t) => { st.asset = t.dataset.asset; ctx.rerender(); });
      ctx.on('input', '[data-filter]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-filter]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-preset]', (e, t) => { st.preset = t.dataset.preset; ctx.rerender(); });
      const seek = (ms) => { st.heads[a.id] = Math.max(0, Math.min(dur, ms)); if (media) media.currentTime = st.heads[a.id] / 1000; ctx.rerender(); };
      ctx.on('click', '[data-seek]', (e, t) => seek(+t.dataset.seek));
      ctx.on('click', '[data-track]', (e, t) => { const r = t.getBoundingClientRect(); seek(Math.round(((e.clientX - r.left) / r.width) * dur)); });
      ctx.on('click', '[data-play]', () => { if (!media) return; if (media.paused) media.play().catch((err) => toast('The browser could not play this file: ' + esc(err.message), 'warn')); else media.pause(); });
      ctx.on('click', '[data-trim]', (e, t) => { const tr = (st.trims[a.id] || [0, dur]).slice(); tr[+t.dataset.trim] = head; if (tr[0] > tr[1]) tr.reverse(); st.trims[a.id] = tr; ctx.rerender(); toast('Trim set to ' + fmt(tr[0]) + ' to ' + fmt(tr[1]) + '. clip-720p and frames-1fps use it as Start and End.'); });
      ctx.on('click', '[data-trimreset]', () => { st.trims[a.id] = [0, dur]; ctx.rerender(); });
      ctx.on('click', '[data-goruns]', () => ctx.navigate('runs'));
      ctx.on('click', '[data-goplatform]', () => ctx.navigate('platform'));
      ctx.on('click', '[data-goflags]', (e) => { e.preventDefault(); ctx.navigate('flags'); });
      ctx.on('click', '[data-askcap]', async () => {
        try { const r = await App.post('/api/media/caps/request', { assetId: a.id }); toast('Request sent to ' + r.notified + ' system admin' + (r.notified === 1 ? '' : 's') + ' with the probe result attached.', 'ok'); } catch (err) { App.fail(err, 'Could not send the request'); }
      });

      const fetchText = async (url) => { const res = await fetch(url, { credentials: 'same-origin' }); if (!res.ok) throw new Error('The transcript could not be loaded (' + res.status + ').'); return res.text(); };
      const showTranscript = async (jobId) => {
        const j = jobs.find((x) => x.id === jobId); if (!j) return;
        try {
          const text = await fetchText('/api/media/jobs/' + enc(j.id) + '/outputs/0');
          ctx.modal({ cls: 'wide', title: 'Transcript ' + UI.label(j.label, { sm: true }), body: (j.result && j.result.masked ? UI.notice(j.result.masked + ' finding' + (j.result.masked === 1 ? '' : 's') + ' masked by guardrails at the media checkpoint. Redaction ran before storage.', 'info') : '') + UI.code(text.slice(0, 20000) + (text.length > 20000 ? '\n…' : ''), 'srt'), actions: UI.btn('Download SRT', { attrs: 'data-dl' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
            onMount(m) { m.querySelector('[data-dl]').addEventListener('click', () => { const l = document.createElement('a'); l.href = '/api/media/jobs/' + enc(j.id) + '/outputs/0?download=1'; l.download = 'transcript.srt'; document.body.appendChild(l); l.click(); l.remove(); toast('Transcript downloaded; the download is in the audit log with its label.'); }); } });
        } catch (err) { App.fail(err, 'Could not open the transcript'); }
      };
      ctx.on('click', '[data-transcript]', (e, t) => { e.preventDefault(); showTranscript(t.dataset.transcript); });
      ctx.on('click', '[data-sendkb]', async () => {
        const j = transcriptJob; if (!j) return;
        let bases;
        try { bases = (await App.get('/api/knowledge/bases')).filter((k) => k.access === 'manage'); } catch (err) { App.fail(err, 'Could not list knowledge bases'); return; }
        ctx.modal({ title: 'Send transcript to a knowledge base',
          body: (bases.length ? UI.field('Knowledge base', UI.select(bases.map((k) => ({ value: k.id, label: k.name + ' · ' + k.label + (k.status === 'published' ? '' : ' · draft') })), bases[0].id, 'data-kb'), 'Bases you can curate') : UI.notice('You cannot curate any knowledge base. A knowledge curator can give you manage access to one, or send the transcript for you.', 'warn'))
            + UI.kv([['Transcript', 'job <span class="mono">' + esc(String(j.id).slice(-6).toLowerCase()) + '</span>' + (j.result && j.result.words ? ', ' + esc(j.result.words) + ' words' : '')], ['Label', UI.label(j.label, { sm: true }) + ' <span class="muted">kept; classification may raise it, never lower it</span>']], 1)
            + UI.notice('The transcript becomes a text document in the base\'s uploads, one line per caption with its start time. It is scanned, classified and indexed like any upload.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send', { kind: 'primary', attrs: 'data-go', disabled: !bases.length }),
          onMount(m) {
            const go = m.querySelector('[data-go]');
            go.addEventListener('click', async () => {
              go.disabled = true;
              try {
                const d = await App.post('/api/media/jobs/' + enc(j.id) + '/knowledge', { kbId: m.querySelector('[data-kb]').value });
                App.closeOverlay();
                toast(esc(d.name) + ' added to ' + esc(d.kb.name) + ', labelled ' + esc(d.label) + '. It is scanned and indexed next. <a href="#/knowledge?kb=' + enc(d.kb.id) + '">Open in Knowledge</a>', 'ok', 7000);
              } catch (err) { go.disabled = false; App.fail(err, 'Could not send the transcript'); }
            });
          } });
      });

      ctx.on('click', '[data-job]', (e, t) => {
        const j = jobs.find((x) => x.id === t.dataset.job); if (!j) return;
        const p = presets.find((x) => x.id === j.preset);
        const outputs = (j.outputs || []);
        const outHtml = j.state !== 'succeeded' ? 'Output is written when the job succeeds.' : outputs.length === 0 ? 'No output was kept.'
          : j.preset === 'frames-1fps' ? '<div class="hstack wrap gap4">' + outputs.slice(0, 12).map((o) => '<img src="/api/media/jobs/' + enc(j.id) + '/outputs/' + o.index + '" alt="' + esc(o.name) + '" style="width:64px;height:36px;object-fit:cover;border-radius:3px">').join('') + '</div><div class="muted" style="font-size:12px">' + outputs.length + ' frames stored sealed with the job label.</div>'
            : outputs.map((o) => '<a href="/api/media/jobs/' + enc(j.id) + '/outputs/' + o.index + '?download=1" download="' + esc(o.name) + '" class="mono">' + esc(o.name) + '</a> <span class="muted">' + esc(size(o.size)) + '</span>').join('<br>') + '<div class="muted" style="font-size:12px">Stored sealed in the blob store with the job label. Downloads are audited.</div>';
        ctx.drawer({ title: '<span class="mono">' + esc(shortId(j.id)) + '</span> ' + UI.pill(j.state), body: UI.kv([['Preset', esc(j.preset)], ['Encoder', esc(encName(j.encoder))], ['Node', esc(j.node || 'not started')], ['Worker', 'ffmpeg, local files only']], 2) + UI.kv([['Input', esc(a.name)], ['Label', UI.label(j.label, { sm: true })]], 2)
          + UI.meter(j.state === 'failed' ? 'Failed' : (j.stage || j.state), j.progress + '%', j.progress, j.state === 'running' ? 'accent' : j.state === 'failed' ? 'danger' : '') + (j.error ? UI.notice(esc(j.error), 'danger') : '')
          + (p ? '<div class="eyebrow">Parameters</div>' + UI.kv(p.fields.map((f) => [f.label, '<span class="mono">' + esc(j.params[f.name] != null ? j.params[f.name] : (f.default || 'whole file')) + '</span>']), 2) : '')
          + '<div class="eyebrow">Output</div><div class="fg2" style="font-size:12px">' + outHtml + '</div>',
          actions: (ACTIVE[j.state] ? UI.btn('Cancel job', { kind: 'danger', attrs: 'data-cancel' }) : '') + (j.preset === 'transcribe-srt' && j.state === 'succeeded' ? UI.btn('View transcript', { attrs: 'data-close data-view' }) : '') + UI.btn('Open in Runs', { attrs: 'data-close data-runs' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(d) {
            const c = d.querySelector('[data-cancel]');
            if (c) c.addEventListener('click', async () => { App.closeOverlay(); try { await App.post('/api/media/jobs/' + enc(j.id) + '/cancel'); toast('Job cancelled. The ffmpeg process was stopped.'); loadDetail(a.id); } catch (err) { App.fail(err, 'Could not cancel'); } });
            const v = d.querySelector('[data-view]'); if (v) v.addEventListener('click', () => setTimeout(() => showTranscript(j.id), 50));
            d.querySelector('[data-runs]').addEventListener('click', () => ctx.navigate('runs'));
          } });
      });

      ctx.on('click', '[data-upload]', () => {
        const myLabels = LABELS.filter((l) => !App.me || LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance));
        ctx.modal({ title: 'Upload media', body: '<div class="fg2">Files go to quarantine first, then ffprobe. A file above any cap is refused before anything processes it.</div>' + UI.table(['Cap', 'Limit', 'Set by'], [['Duration', fmt(caps.maxDurationMs), 'System admin'], ['Resolution', caps.maxWidth + ' x ' + caps.maxHeight, 'System admin'], ['Streams', String(caps.maxStreams), 'System admin'], ['File size', size(caps.maxBytes), 'System admin']], { clickable: false, minWidth: '0', cls: 'bare' })
          + UI.field('File', '<input type="file" class="input" data-file accept="video/*,audio/*,image/png,image/jpeg,image/webp">') + UI.field('Label', UI.select(myLabels, 'internal', 'data-lbl'), 'Cannot be lower than the source it came from.'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Upload', { kind: 'primary', icon: 'upload', attrs: 'data-go' }),
          onMount(m) {
            m.querySelector('[data-go]').addEventListener('click', async () => {
              const file = m.querySelector('[data-file]').files[0]; const lbl = m.querySelector('[data-lbl]').value;
              if (!file) { toast('Choose a file first.', 'warn'); return; }
              if (file.size > caps.maxBytes) { toast(esc(file.name) + ' is ' + esc(size(file.size)) + '; the upload cap is ' + esc(size(caps.maxBytes)) + '.', 'danger', 6000); return; }
              App.closeOverlay(); toast('Uploading ' + esc(file.name) + '…');
              try {
                const res = await fetch('/api/media/assets?name=' + enc(file.name) + '&label=' + enc(lbl), { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': 'application/octet-stream', Accept: 'application/json' } });
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new App.ApiError(body && body.title ? body : { status: res.status, title: 'Upload failed', detail: res.statusText });
                st.assets = [body].concat(st.assets || []); st.asset = body.id; ctx.rerender();
                toast(esc(file.name) + ' is in quarantine. The probe and metadata removal run now; the result appears here.', 'ok', 6000);
              } catch (err) { App.fail(err, 'Could not upload ' + file.name); }
            });
          } });
      });

      const openRun = () => {
        if (!a || !ready || !preset) return;
        if (!applicable(preset) || !preset.available) { toast(esc(preset.available ? preset.id + ' does not apply to ' + a.kind + ' files.' : preset.reason), 'warn', 6000); return; }
        const tr = st.trims[a.id] || [0, dur];
        const form = preset.fields.map((f) => {
          if (f.type === 'select') return UI.field(f.label, UI.select(f.options, f.default, 'data-p="' + esc(f.name) + '"'));
          const v = f.name === 'start' ? fmtLong(tr[0]) : f.name === 'end' ? fmtLong(tr[1] || dur) : f.default;
          return UI.field(f.label, UI.input(v, { attrs: 'data-p="' + esc(f.name) + '"' }), 'HH:MM:SS');
        }).join('');
        const encoderText = preset.encodes ? (st.caps.encoder.video === 'nvenc' ? 'NVENC on the media worker, libx264 fallback' : 'CPU (libx264)') : 'CPU';
        ctx.modal({ title: 'Run ' + esc(preset.id) + ' on ' + esc(a.name), body: '<div class="fg2">' + esc(preset.sub) + '. Parameters are validated against the preset\'s schema and passed to the worker as an argument array. There is no command field.</div><div class="formgrid">' + form + '</div>'
          + (st.noFreeform ? UI.notice('<b>No free-form arguments.</b> Models and users fill in these typed fields only. Raw FFmpeg arguments are available only through reviewed script tools.', 'info', '<a href="#" data-goscripts>Scripts</a>') : '')
          + UI.kv([['Encoder', esc(encoderText)], ['Label', UI.label(a.label, { sm: true })], ['Safety', preset.id === 'frames-1fps' ? 'sampled frames pass the image-safety classifier' : preset.id === 'transcribe-srt' ? 'transcript passes the media guardrails' : 'output inherits the label']].concat(preset.model ? [['Model', esc(preset.model)]] : []), 3),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Queue job', { kind: 'primary', icon: 'play', attrs: 'data-go' }),
          onClose() { st.noFreeform = false; },
          onMount(m) {
            const gs = m.querySelector('[data-goscripts]'); if (gs) gs.addEventListener('click', (e) => { e.preventDefault(); App.closeOverlay(); ctx.navigate('scripts'); });
            m.querySelector('[data-go]').addEventListener('click', async () => {
              const params = {}; m.querySelectorAll('[data-p]').forEach((el) => { if (el.value !== '') params[el.dataset.p] = el.value; });
              try {
                const j = await App.post('/api/media/assets/' + enc(a.id) + '/jobs', { preset: preset.id, params });
                App.closeOverlay();
                if (st.details[a.id]) st.details[a.id].jobs.unshift(j);
                ctx.rerender(); toast('Queued <span class="mono">' + esc(shortId(j.id)) + '</span> on the media worker' + (j.encoder === 'nvenc' ? ' with NVENC' : '') + '. Progress arrives over the socket.', 'ok');
              } catch (err) { const pr = err.problem || {}; App.fail(err, pr.errors && pr.errors[0] ? 'Parameter ' + pr.errors[0].path + ': ' + pr.errors[0].message : 'The preset was refused'); }
            });
          } });
      };
      ctx.on('click', '[data-run]', openRun);
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (st.openRun) { st.openRun = false; setTimeout(openRun, 50); }
    }
  });
})();
