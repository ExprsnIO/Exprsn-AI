(function () {
  const { UI, esc } = App;

  // ---- data ----
  const ASSETS = [
    { id: 'town-hall-sept.mp4', kind: 'video', meta: '42:10, 1080p', duration: '42:10', secs: 2530, res: '1920 x 1080', w: 1920, h: 1080, streams: '1 video, 1 audio', size: '1.8 GB', label: 'internal', by: 'Mara Okafor, 19 Sep 09:12', trim: [555, 1340] },
    { id: 'site-walk.mov', kind: 'video', meta: '06:31, 4K', duration: '06:31', secs: 391, res: '3840 x 2160', w: 3840, h: 2160, streams: '1 video, 1 audio', size: '3.1 GB', label: 'internal', by: 'Mara Okafor, 18 Sep 16:40', trim: [0, 391] },
    { id: 'supplier-call.m4a', kind: 'audio', meta: '28:02, audio', duration: '28:02', secs: 1682, res: 'audio only', streams: '0 video, 1 audio', size: '41 MB', label: 'confidential', by: 'Mara Okafor, 17 Sep 15:05', trim: [0, 1682] },
    { id: 'whiteboard.jpg', kind: 'image', meta: '4032 x 3024', duration: 'still image', secs: 0, res: '4032 x 3024', w: 4032, h: 3024, streams: '1 image', size: '4.2 MB', label: 'internal', by: 'Mara Okafor, 16 Sep 10:21', trim: null }
  ];
  const CAPS = { duration: '120:00', durationSecs: 7200, w: 1920, h: 1080, size: '4 GB', streams: 4 };
  const PRESETS = [
    { id: 'clip-720p', sub: 'H.264 and AAC', kinds: ['video'], params: [['Start', 'time', '00:09:15'], ['End', 'time', '00:22:20'], ['Height', 'select', ['720', '480', '1080']], ['Crop', 'select', ['none', '16:9 centre', '4:3 centre', '1:1 centre']]] },
    { id: 'transcribe-srt', sub: 'whisper.cpp, SRT and VTT', kinds: ['video', 'audio'], params: [['Language', 'select', ['auto-detect', 'en', 'de', 'fr']], ['Model', 'select', ['whisper large-v3', 'whisper medium']], ['Diarise speakers', 'select', ['yes', 'no']]] },
    { id: 'frames-1fps', sub: 'for vision captions', kinds: ['video'], params: [['Start', 'time', '00:09:15'], ['End', 'time', '00:22:20'], ['Frames per second', 'select', ['1', '0.5', '2']], ['Max frames', 'select', ['48', '96', '200']]] },
    { id: 'normalise-audio', sub: 'loudness to -16 LUFS', kinds: ['video', 'audio'], params: [['Target loudness', 'select', ['-16 LUFS', '-14 LUFS', '-23 LUFS']], ['True peak', 'select', ['-1.5 dBTP', '-1 dBTP']]] }
  ];
  const JOBS0 = [
    { id: 'media.7d21', asset: 'town-hall-sept.mp4', preset: 'clip-720p', stage: 'Encoding', pct: 64, enc: 'NVENC', state: 'running', node: 'gpu-small-1' },
    { id: 'media.7d1e', asset: 'town-hall-sept.mp4', preset: 'transcribe-srt', stage: 'Done, 6,204 words', pct: 100, enc: 'CPU', state: 'succeeded', node: 'cpu-2', words: 6204 },
    { id: 'media.7c02', asset: 'supplier-call.m4a', preset: 'transcribe-srt', stage: 'Done, 4,118 words', pct: 100, enc: 'CPU', state: 'succeeded', node: 'cpu-2', words: 4118 },
    { id: 'media.7b90', asset: 'whiteboard.jpg', preset: 'strip-metadata', stage: 'Done, EXIF and GPS removed', pct: 100, enc: 'libvips', state: 'succeeded', node: 'cpu-1' }
  ];

  const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; const p = (n) => String(n).padStart(2, '0'); return (h ? p(h) + ':' : '') + p(m) + ':' + p(x); };
  const fmtLong = (s) => { s = Math.max(0, Math.round(s)); const p = (n) => String(n).padStart(2, '0'); return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60); };

  // ---- drawings (inline SVG only) ----
  const videoFrame = (t, total, h) => {
    // abstract town-hall frame: stage, screen, audience blocks; the playhead shifts the presenter and the slide number
    const shift = total ? (t / total) : 0; const px = 300 + Math.round(shift * 200);
    return '<svg viewBox="0 0 800 ' + h + '" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%;display:block" aria-hidden="true">'
      + '<defs><linearGradient id="media-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--fg)" stop-opacity=".92"/><stop offset="1" stop-color="var(--fg)" stop-opacity=".78"/></linearGradient></defs>'
      + '<rect width="800" height="' + h + '" fill="url(#media-sky)"/>'
      + '<rect x="120" y="40" width="560" height="' + Math.round(h * 0.52) + '" rx="4" fill="var(--panel2)" opacity=".85"/>'
      + '<rect x="150" y="66" width="220" height="12" rx="2" fill="var(--fg2)" opacity=".7"/><rect x="150" y="90" width="330" height="8" rx="2" fill="var(--fg2)" opacity=".4"/><rect x="150" y="106" width="290" height="8" rx="2" fill="var(--fg2)" opacity=".4"/>'
      + '<rect x="440" y="66" width="200" height="' + Math.round(h * 0.3) + '" rx="3" fill="var(--accent)" opacity=".55"/>'
      + '<text x="655" y="' + Math.round(h * 0.5) + '" font-size="11" fill="var(--fg2)" text-anchor="end" font-family="var(--mono)">slide ' + (3 + Math.round(shift * 20)) + '</text>'
      + '<rect x="0" y="' + Math.round(h * 0.66) + '" width="800" height="' + h + '" fill="var(--fg)" opacity=".5"/>'
      + [60, 150, 240, 330, 420, 510, 600, 690].map((x, i) => '<circle cx="' + (x + (i % 2) * 20) + '" cy="' + (Math.round(h * 0.78) + (i % 3) * 8) + '" r="16" fill="var(--panel)" opacity=".25"/>').join('')
      + '<circle cx="' + px + '" cy="' + Math.round(h * 0.6) + '" r="14" fill="var(--panel)" opacity=".9"/><rect x="' + (px - 12) + '" y="' + Math.round(h * 0.64) + '" width="24" height="36" rx="6" fill="var(--panel)" opacity=".9"/>'
      + '</svg>';
  };
  const waveform = (h) => '<svg viewBox="0 0 800 ' + h + '" preserveAspectRatio="none" style="width:100%;height:100%;display:block" aria-hidden="true"><rect width="800" height="' + h + '" fill="var(--fg)" opacity=".9"/>'
    + Array.from({ length: 160 }, (_, i) => { const a = (Math.sin(i * 0.37) * 0.5 + Math.sin(i * 1.3) * 0.3 + Math.cos(i * 0.11) * 0.2) * (h * 0.36); return '<rect x="' + (i * 5 + 2) + '" y="' + (h / 2 - Math.abs(a)) + '" width="3" height="' + Math.max(2, Math.abs(a) * 2) + '" rx="1" fill="var(--panel)" opacity=".7"/>'; }).join('') + '</svg>';
  const stillImage = (h) => '<svg viewBox="0 0 800 ' + h + '" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%;display:block" aria-hidden="true"><rect width="800" height="' + h + '" fill="var(--panel2)"/><rect x="40" y="30" width="720" height="' + (h - 60) + '" rx="6" fill="var(--panel)" stroke="var(--line)"/>'
    + '<path d="M90 80 C 200 40, 320 120, 420 70 S 640 60, 720 110" fill="none" stroke="var(--info-fg)" stroke-width="4" opacity=".7"/><path d="M110 150 L 260 150 L 260 210 L 110 210 Z" fill="none" stroke="var(--fg2)" stroke-width="3"/><path d="M330 160 L 500 160" stroke="var(--fg2)" stroke-width="3"/><path d="M330 190 L 460 190" stroke="var(--fg2)" stroke-width="3"/><circle cx="600" cy="185" r="34" fill="none" stroke="var(--accent)" stroke-width="4"/><text x="600" y="190" text-anchor="middle" font-size="16" fill="var(--accent)" font-family="var(--sans)">Q3</text></svg>';
  const frameThumb = (i, n, withheld) => '<svg viewBox="0 0 64 36" preserveAspectRatio="none" style="width:100%;height:100%;display:block" aria-hidden="true"><rect width="64" height="36" fill="var(--fg)" opacity="' + (0.6 + (i % 4) * 0.08) + '"/><rect x="' + (10 + (i % 5) * 4) + '" y="6" width="34" height="14" rx="1" fill="var(--panel2)" opacity=".8"/><rect x="0" y="24" width="64" height="12" fill="var(--fg)" opacity=".5"/>' + (withheld ? '<rect width="64" height="36" fill="var(--warn-fg)" opacity=".55"/><path d="M8 8l48 20M56 8L8 28" stroke="var(--panel)" stroke-width="2"/>' : '') + '</svg>';

  App.register({
    id: 'media', title: 'Media', summary: 'Assets, presets, trim and frame scrubber, media jobs',
    crumb: (st) => ['Media', st.asset || ASSETS[0].id],
    label: (st) => (ASSETS.find((a) => a.id === (st.asset || ASSETS[0].id)) || ASSETS[0]).label,
    commands: [{ label: 'Run a media preset', sub: 'Media', run(app) { app.stateFor('media').openRun = true; app.render(); } }],
    states: [
      { title: 'Refused at probe', tone: 'danger', text: 'site-walk.mov is 3840 x 2160 and the cap is 1920 x 1080. The job is refused before it starts, with the cap and who sets it.', apply(ctx) { ctx.state.asset = 'site-walk.mov'; ctx.state.refused = true; ctx.rerender(); } },
      { title: 'Frame failed safety', tone: 'warn', text: '2 sampled frames failed the image-safety classifier and were withheld from the vision model. The rest continue.', apply(ctx) { const st = ctx.state; st.asset = 'town-hall-sept.mp4'; st.withheld = true; st.preset = 'frames-1fps'; st.jobs = st.jobs || JOBS0.map((j) => Object.assign({}, j)); if (!st.jobs.some((j) => j.id === 'media.7d2a')) st.jobs.unshift({ id: 'media.7d2a', asset: 'town-hall-sept.mp4', preset: 'frames-1fps', stage: 'Done, 46 of 48 frames captioned', pct: 100, enc: 'NVENC', state: 'succeeded', node: 'gpu-small-1' }); ctx.rerender(); } },
      { title: 'Transcript redacted', tone: 'neutral', text: 'Guardrails masked 3 phone numbers in the transcript before it reached a model or a user.', apply(ctx) { ctx.state.asset = 'town-hall-sept.mp4'; ctx.state.redacted = true; ctx.state.preset = 'transcribe-srt'; ctx.rerender(); } },
      { title: 'No free-form arguments', tone: 'neutral', text: 'There is no command field anywhere. Parameters come only from the preset\'s typed form.', apply(ctx) { ctx.state.asset = 'town-hall-sept.mp4'; ctx.state.noFreeform = true; ctx.state.openRun = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.asset) { st.asset = ctx.params.asset; delete ctx.params.asset; }
      st.asset = st.asset || ASSETS[0].id; st.query = st.query || ''; st.preset = st.preset || 'clip-720p';
      st.jobs = st.jobs || JOBS0.map((j) => Object.assign({}, j)); st.extra = st.extra || [];
      st.trims = st.trims || {}; st.heads = st.heads || {};
      const assets = ASSETS.concat(st.extra);
      const a = assets.find((x) => x.id === st.asset) || ASSETS[0];
      const trim = st.trims[a.id] || a.trim || [0, a.secs];
      const head = st.heads[a.id] != null ? st.heads[a.id] : (a.id === ASSETS[0].id ? 760 : trim[0]);
      const list = assets.filter((x) => !st.query || x.id.toLowerCase().includes(st.query.toLowerCase()));
      const jobs = st.jobs.filter((j) => j.asset === a.id);
      const refused = st.refused && a.id === 'site-walk.mov';
      const preset = PRESETS.find((p) => p.id === st.preset) || PRESETS[0];
      const applicable = (p) => p.kinds.indexOf(a.kind) >= 0;

      // preview
      const previewH = 250;
      const preview = a.kind === 'video' ? videoFrame(head, a.secs, previewH) : a.kind === 'audio' ? waveform(previewH) : stillImage(previewH);
      const caption = a.kind === 'video' ? 'video preview, ' + fmtLong(head) + ' of ' + fmtLong(a.secs) : a.kind === 'audio' ? 'waveform, ' + fmtLong(head) + ' of ' + fmtLong(a.secs) : 'image preview, ' + a.res;
      const nFrames = 14;
      const strip = a.kind === 'video' ? '<div class="media-strip" role="group" aria-label="Frame scrubber">' + Array.from({ length: nFrames }, (_, i) => { const t = Math.round((i / nFrames) * a.secs); const wh = st.withheld && a.id === ASSETS[0].id && (i === 5 || i === 9); return '<button type="button" class="media-frame' + (Math.floor((head / a.secs) * nFrames) === i ? ' cur' : '') + (t >= trim[0] && t <= trim[1] ? ' in' : '') + '" data-seek="' + t + '" title="' + fmt(t) + (wh ? ', withheld by the image-safety classifier' : '') + '">' + frameThumb(i, nFrames, wh) + '<span>' + fmt(t) + '</span></button>'; }).join('') + '</div>' : '';
      const pct = (s) => (a.secs ? (s / a.secs) * 100 : 0);
      const trimbar = a.kind === 'image' ? '' : '<div class="vstack gap4"><div class="media-track" data-track title="Click to move the playhead"><div class="media-sel" style="left:' + pct(trim[0]) + '%;width:' + (pct(trim[1]) - pct(trim[0])) + '%"></div><div class="media-head" style="left:' + pct(head) + '%"></div></div>'
        + '<div class="hstack muted" style="font-size:12px;justify-content:space-between"><span class="num">00:00</span><span class="hstack gap6"><span>Trim ' + fmt(trim[0]) + ' to ' + fmt(trim[1]) + '</span>' + UI.btn('Set start', { kind: 'ghost', size: 'xs', attrs: 'data-trim="0"' }) + UI.btn('Set end', { kind: 'ghost', size: 'xs', attrs: 'data-trim="1"' }) + UI.btn('Reset', { kind: 'ghost', size: 'xs', attrs: 'data-trimreset' }) + '</span><span class="num">' + esc(a.duration) + '</span></div></div>';

      const probeNotice = refused
        ? UI.problem('Refused at probe', 'ffprobe reports 3840 x 2160 and the resolution cap for this tenant is 1920 x 1080. Nothing was queued and no sandbox started. Caps on duration, resolution, stream count and file size are set by the system admin under Platform.', '9c1e7a42b0d94f1c8a2e5d6f7b8c9d0e') + '<div class="hstack gap6">' + UI.btn('Open Platform caps', { size: 'sm', attrs: 'data-goplatform' }) + UI.btn('Ask for a higher cap', { size: 'sm', kind: 'ghost', attrs: 'data-askcap' }) + '</div>'
        : '';

      const kv = UI.kv([
        ['Duration', a.kind === 'image' ? 'still image' : esc(a.duration) + ' of ' + CAPS.duration + ' allowed'],
        ['Resolution', a.w && a.w > CAPS.w ? '<span style="color:var(--danger-fg)">' + esc(a.res) + '</span> (cap ' + CAPS.w + ' x ' + CAPS.h + ')' : esc(a.res)],
        ['Streams', esc(a.streams)],
        ['Size', esc(a.size) + ' of ' + CAPS.size + ' allowed'],
        ['Label', UI.label(a.label, { sm: true })],
        ['Metadata', 'GPS and device data removed']
      ], 3);

      const presets = '<div class="media-presets">' + PRESETS.map((p) => '<button type="button" class="media-preset' + (p.id === st.preset ? ' on' : '') + '" data-preset="' + p.id + '"' + (applicable(p) ? '' : ' disabled title="Not applicable to ' + a.kind + '"') + '><span style="font-weight:600">' + esc(p.id) + '</span><span class="muted" style="font-size:12px">' + esc(p.sub) + '</span></button>').join('') + '</div>';

      const jobRows = jobs.map((j) => {
        const fill = j.state === 'running' ? 'accent' : j.state === 'failed' ? 'danger' : '';
        const extra = (st.withheld && j.preset === 'frames-1fps' && j.asset === ASSETS[0].id) ? ' <span style="color:var(--warn-fg)">2 withheld</span>' : (st.redacted && j.id === 'media.7d1e') ? ' <span class="fg2">3 masked</span>' : '';
        return { cells: ['<span class="mono">' + esc(j.id) + '</span>', esc(j.preset), UI.meter(j.stage + (extra ? '' : ''), j.pct + '%', j.pct, fill).replace('<span>' + esc(j.stage) + '</span>', '<span>' + esc(j.stage) + extra + '</span>'), esc(j.enc), UI.pill(j.state)], attrs: 'data-job="' + j.id + '"' };
      });
      const jobNotices = (st.withheld && a.id === ASSETS[0].id ? UI.notice('<b>2 of 48 sampled frames were withheld</b> by the image-safety classifier at 00:15:11 and 00:26:03. They never reached the vision model. Captions continue for the other 46.', 'warn', '<a href="#" data-goflags>Open flag F-2296</a>') : '')
        + (st.redacted && a.id === ASSETS[0].id ? UI.notice('<b>Transcript redacted.</b> Guardrail profile Finance baseline v12 masked 3 phone numbers before the transcript reached a model or a user. The unmasked text is not stored.', 'info', '<a href="#" data-transcript>View transcript</a>') : '');

      root.innerHTML = '<style>'
        + '.media-assets{display:grid;gap:8px;grid-template-columns:repeat(2,minmax(0,1fr))}'
        + '.media-asset{display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:pointer;text-align:left;font-family:inherit;color:var(--fg)}.media-asset:hover{border-color:var(--muted)}.media-asset.on{background:var(--accent-tint);border-color:var(--accent)}'
        + '.media-poster{height:84px;border-radius:4px;overflow:hidden;position:relative;background:var(--sel)}.media-poster .cap{position:absolute;left:6px;bottom:4px;font-size:11px;color:var(--panel);opacity:.9;font-family:var(--mono)}.media-poster .lbl{position:absolute;right:4px;top:4px}'
        + '.media-preview{flex-shrink:0;height:250px;border-radius:6px;overflow:hidden;position:relative;background:var(--fg);color:var(--fg2)}.media-preview .cap{position:absolute;left:12px;bottom:10px;font-size:12px;padding:3px 8px;border-radius:4px;background:var(--panel);color:var(--fg2);opacity:.92;font-family:var(--mono)}.media-preview .play{position:absolute;right:12px;bottom:10px}'
        + '.media-strip{flex-shrink:0;display:grid;grid-template-columns:repeat(14,minmax(0,1fr));gap:3px}.media-frame{position:relative;height:44px;padding:0;border:2px solid transparent;border-radius:3px;overflow:hidden;background:var(--sel);cursor:pointer;opacity:.55}.media-frame.in{opacity:1}.media-frame.cur{border-color:var(--accent)}.media-frame span{position:absolute;left:0;right:0;bottom:0;font-size:9px;color:var(--panel);font-family:var(--mono);text-align:center;background:var(--fg);opacity:.85}'
        + '.media-track{position:relative;height:26px;background:var(--sel);border-radius:4px;cursor:pointer}.media-sel{position:absolute;top:0;bottom:0;background:var(--accent-tint);border-left:2px solid var(--accent);border-right:2px solid var(--accent)}.media-head{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--fg);transform:translateX(-1px)}'
        + '.media-presets{display:grid;gap:10px;grid-template-columns:repeat(4,minmax(0,1fr))}.media-preset{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:pointer;text-align:left;font-family:inherit;color:var(--fg)}.media-preset:hover{border-color:var(--muted)}.media-preset.on{background:var(--accent-tint);border-color:var(--accent)}.media-preset[disabled]{opacity:.45;cursor:not-allowed}'
        + '@media (max-width:900px){.media-presets{grid-template-columns:repeat(2,minmax(0,1fr))}.media-strip{grid-template-columns:repeat(7,minmax(0,1fr))}}'
        + '</style>'
        + '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Assets</div>' + UI.btn('Upload', { size: 'sm', icon: 'upload', attrs: 'data-upload' }) + '</div>'
        + UI.search('Filter', 'data-filter', st.query).replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="media-assets">' + list.map((x) => '<button type="button" class="media-asset' + (x.id === a.id ? ' on' : '') + '" data-asset="' + esc(x.id) + '"><div class="media-poster">' + (x.kind === 'video' ? videoFrame(x.trim ? x.trim[0] : 0, x.secs, 84) : x.kind === 'audio' ? waveform(84) : stillImage(84)) + '<span class="cap">' + (x.kind === 'video' ? 'poster frame' : x.kind === 'audio' ? 'waveform' : 'preview') + '</span><span class="lbl">' + UI.label(x.label, { sm: true }) + '</span></div><div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(x.id) + '</div><div class="muted" style="font-size:11px">' + esc(x.meta) + '</div></button>').join('') + '</div>'
        + (list.length ? '' : UI.empty('No assets match', 'Try another name or upload a file.'))
        + '<div class="muted" style="font-size:12px;margin-top:auto">Uploads are probed with ffprobe and refused above the caps: ' + CAPS.duration + ', ' + CAPS.w + ' x ' + CAPS.h + ', ' + CAPS.streams + ' streams, ' + CAPS.size + '.</div></div>'
        + '<div class="page">'
        + UI.pagehead(a.id, 'Uploaded by ' + esc(a.by), (a.kind !== 'image' ? UI.btn('Send transcript to a knowledge base', { attrs: 'data-sendkb', disabled: !jobs.some((j) => j.preset === 'transcribe-srt' && j.state === 'succeeded') }) : UI.btn('Send OCR text to a knowledge base', { attrs: 'data-sendkb' })) + UI.btn('Run preset', { kind: 'primary', icon: 'play', attrs: 'data-run', disabled: refused }))
        + probeNotice
        + '<div class="media-preview">' + preview + '<span class="cap">' + esc(caption) + '</span>' + (a.kind !== 'image' ? '<span class="play">' + UI.btn(st.playing ? 'Pause' : 'Play', { size: 'sm', icon: st.playing ? 'pause' : 'play', attrs: 'data-play' }) + '</span>' : '') + '</div>'
        + strip + trimbar + kv
        + '<div class="hstack"><div class="eyebrow grow">Presets</div><span class="muted" style="font-size:12px">Typed parameters only. Free-form FFmpeg arguments exist only in reviewed script tools.</span></div>' + presets
        + '<div class="hstack"><div class="eyebrow grow">Jobs</div>' + UI.btn('Open in Runs', { kind: 'ghost', size: 'sm', attrs: 'data-goruns' }) + '</div>'
        + jobNotices
        + UI.table(['Job', 'Preset', { label: 'Progress', width: '32%' }, 'Encoder', 'State'], jobRows, { attrs: 'style="flex-shrink:0"', emptyTitle: 'No jobs for this asset', emptyText: 'Pick a preset and run it. Every job is probed first and runs in the media sandbox with no network.' })
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div>';

      // ---- events ----
      ctx.on('click', '[data-asset]', (e, t) => { st.asset = t.dataset.asset; st.refused = false; st.playing = false; ctx.rerender(); });
      ctx.on('input', '[data-filter]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-filter]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-preset]', (e, t) => { st.preset = t.dataset.preset; ctx.rerender(); });
      ctx.on('click', '[data-seek]', (e, t) => { st.heads[a.id] = +t.dataset.seek; ctx.rerender(); });
      ctx.on('click', '[data-track]', (e, t) => { const r = t.getBoundingClientRect(); st.heads[a.id] = Math.round(((e.clientX - r.left) / r.width) * a.secs); ctx.rerender(); });
      ctx.on('click', '[data-trim]', (e, t) => { const tr = (st.trims[a.id] || a.trim || [0, a.secs]).slice(); tr[+t.dataset.trim] = head; if (tr[0] > tr[1]) tr.reverse(); st.trims[a.id] = tr; ctx.rerender(); ctx.toast('Trim set to ' + fmt(tr[0]) + ' to ' + fmt(tr[1]) + '. clip-720p and frames-1fps use it as Start and End.'); });
      ctx.on('click', '[data-trimreset]', () => { st.trims[a.id] = [0, a.secs]; ctx.rerender(); });
      ctx.on('click', '[data-play]', () => { st.playing = !st.playing; if (st.playing) { clearTimeout(st.playTimer); const tick = () => { if (!st.playing || App.state.route !== 'media') return; st.heads[a.id] = Math.min(a.secs, (st.heads[a.id] != null ? st.heads[a.id] : head) + Math.max(15, a.secs / 40)); if (st.heads[a.id] >= a.secs) st.playing = false; ctx.rerender(); st.playTimer = setTimeout(tick, 700); }; st.playTimer = setTimeout(tick, 700); } else clearTimeout(st.playTimer); ctx.rerender(); });
      ctx.on('click', '[data-goruns]', () => ctx.navigate('runs'));
      ctx.on('click', '[data-goplatform]', () => ctx.navigate('platform'));
      ctx.on('click', '[data-goflags]', (e) => { e.preventDefault(); ctx.navigate('flags', { id: 'F-2296' }); });
      ctx.on('click', '[data-askcap]', () => { ctx.toast('Request sent to the system admins with the probe result attached.', 'ok'); });
      ctx.on('click', '[data-transcript]', (e) => { e.preventDefault(); ctx.modal({ cls: 'wide', title: 'Transcript ' + UI.label(a.label, { sm: true }), body: UI.notice('3 phone numbers masked by Finance baseline v12, rule <span class="mono">pii-phone</span>. Redaction ran on the worker before storage.', 'info') + UI.code('00:00:04,120 --> 00:00:09,400\nGood morning everyone, welcome to the September town hall.\n\n00:12:38,900 --> 00:12:44,010\nIf you have questions about the Lisbon office, call [phone redacted] or\n\n00:12:44,010 --> 00:12:47,300\nthe facilities desk on [phone redacted].\n\n00:26:01,500 --> 00:26:05,800\nThe supplier hotline is [phone redacted] until Friday.', 'srt'), actions: UI.btn('Download SRT', { attrs: 'data-close data-dl' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(m) { m.querySelector('[data-dl]').addEventListener('click', () => ctx.toast('town-hall-sept.srt downloaded with the internal label in its sidecar.')); } }); });
      ctx.on('click', '[data-job]', (e, t) => {
        const j = st.jobs.find((x) => x.id === t.dataset.job); const p = PRESETS.find((x) => x.id === j.preset);
        ctx.drawer({ title: '<span class="mono">' + esc(j.id) + '</span> ' + UI.pill(j.state), body: UI.kv([['Preset', esc(j.preset)], ['Encoder', esc(j.enc)], ['Node', esc(j.node)], ['Sandbox', 'media image, no network'], ['Input', esc(j.asset)], ['Label', UI.label(a.label, { sm: true })]], 2) + UI.meter(j.stage, j.pct + '%', j.pct, j.state === 'running' ? 'accent' : '') + (p ? '<div class="eyebrow">Parameters</div>' + UI.kv(p.params.map((q) => [q[0], '<span class="mono">' + esc(j.params && j.params[q[0]] != null ? j.params[q[0]] : (q[1] === 'select' ? q[2][0] : q[2])) + '</span>']), 2) : '') + '<div class="eyebrow">Output</div><div class="fg2" style="font-size:12px">' + (j.state === 'succeeded' ? 'Written to MinIO as <span class="mono">media/' + esc(j.asset.replace(/\.[^.]+$/, '')) + '.' + (j.preset === 'transcribe-srt' ? 'srt' : j.preset === 'frames-1fps' ? 'frames/' : 'mp4') + '</span> with the job label, a preview and provenance metadata.' : 'Output is written when the job succeeds.') + '</div>', actions: (j.state === 'running' ? UI.btn('Cancel job', { kind: 'danger', attrs: 'data-close data-cancel' }) : '') + UI.btn('Open in Runs', { attrs: 'data-close data-runs' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { const c = d.querySelector('[data-cancel]'); if (c) c.addEventListener('click', () => { j.state = 'cancelled'; j.stage = 'Cancelled at ' + j.pct + '%'; ctx.rerender(); ctx.toast('Job cancelled. The sandbox process was stopped.'); }); d.querySelector('[data-runs]').addEventListener('click', () => ctx.navigate('runs', { job: j.id })); } });
      });
      ctx.on('click', '[data-sendkb]', () => {
        ctx.modal({ title: 'Send transcript to a knowledge base', body: UI.field('Knowledge base', UI.select(['Finance KB', 'Policy KB', 'Contracts KB'], 'Finance KB', 'data-kb')) + UI.field('Source name', UI.input(a.id.replace(/\.[^.]+$/, '') + ' transcript')) + UI.kv([['Label', UI.label(a.label, { sm: true }) + ' <span class="muted">inherited from the asset</span>'], ['Guardrails', 'passed, 3 phone numbers masked']], 2) + UI.notice('The knowledge base label stays at its own level. A confidential transcript cannot go into an internal base.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send and index', { kind: 'primary', attrs: 'data-close data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { const kb = m.querySelector('[data-kb]').value; ctx.toast('Indexing into ' + esc(kb) + ' as job index.document. Opening Knowledge.', 'ok'); setTimeout(() => ctx.navigate('knowledge', { kb: kb.toLowerCase().split(' ')[0] }), 400); }); } });
      });
      ctx.on('click', '[data-upload]', () => {
        ctx.modal({ title: 'Upload media', body: '<div class="fg2">Files go to quarantine first, then ffprobe. A file above any cap is refused before a sandbox starts.</div>' + UI.table(['Cap', 'Limit', 'Set by'], [['Duration', CAPS.duration, 'System admin'], ['Resolution', CAPS.w + ' x ' + CAPS.h, 'System admin'], ['Streams', String(CAPS.streams), 'System admin'], ['File size', CAPS.size, 'System admin']], { clickable: false, minWidth: '0', cls: 'bare' }) + UI.field('Label', UI.select(['public', 'internal', 'confidential'], 'internal', 'data-lbl'), 'Cannot be lower than the source it came from.'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Choose file and upload', { kind: 'primary', icon: 'upload', attrs: 'data-close data-go' }), onMount(m) { m.querySelector('[data-go]').addEventListener('click', () => { const lbl = m.querySelector('[data-lbl]').value; if (!st.extra.some((x) => x.id === 'q3-review-call.mp4')) st.extra.push({ id: 'q3-review-call.mp4', kind: 'video', meta: '31:05, 720p', duration: '31:05', secs: 1865, res: '1280 x 720', w: 1280, h: 720, streams: '1 video, 1 audio', size: '640 MB', label: lbl, by: 'Mara Okafor, just now', trim: [0, 1865] }); st.asset = 'q3-review-call.mp4'; ctx.rerender(); ctx.toast('q3-review-call.mp4 probed: 31:05, 1280 x 720, 2 streams. Within caps. GPS and device data stripped.', 'ok'); }); } });
      });
      const openRun = () => {
        if (refused) return;
        const p = preset; const tr = st.trims[a.id] || a.trim || [0, a.secs];
        const form = p.params.map((q) => { const v = q[0] === 'Start' ? fmtLong(tr[0]) : q[0] === 'End' ? fmtLong(tr[1]) : null; return q[1] === 'select' ? UI.field(q[0], UI.select(q[2], q[2][0], 'data-p="' + esc(q[0]) + '"')) : UI.field(q[0], UI.input(v != null ? v : q[2], { attrs: 'data-p="' + esc(q[0]) + '" class="input mono"' }).replace('class="input" ', '')); }).join('');
        ctx.modal({ title: 'Run ' + esc(p.id) + ' on ' + esc(a.id), body: '<div class="fg2">' + esc(p.sub) + '. Parameters are validated against the preset\'s JSON Schema and passed to the worker as an argument array. There is no command field.</div><div class="formgrid">' + form + '</div>' + (st.noFreeform ? UI.notice('<b>No free-form arguments.</b> Models and users fill in these typed fields only. Raw FFmpeg arguments are available only through reviewed script tools.', 'info', '<a href="#" data-close data-goscripts>Scripts</a>') : '') + UI.kv([['Encoder', a.kind === 'audio' || p.id === 'transcribe-srt' ? 'CPU' : 'NVENC on gpu-small-1, libx264 fallback'], ['Label', UI.label(a.label, { sm: true })], ['Safety', p.id === 'frames-1fps' ? 'sampled frames pass the image-safety classifier' : p.id === 'transcribe-srt' ? 'transcript passes text guardrails' : 'output inherits the label']], 3), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Queue job', { kind: 'primary', icon: 'play', attrs: 'data-close data-go' }), onMount(m) {
          const gs = m.querySelector('[data-goscripts]'); if (gs) gs.addEventListener('click', (e) => { e.preventDefault(); ctx.navigate('scripts'); });
          m.querySelector('[data-go]').addEventListener('click', () => {
            const params = {}; m.querySelectorAll('[data-p]').forEach((el) => { params[el.dataset.p] = el.value; });
            const id = 'media.' + (0x7d22 + st.jobs.length).toString(16);
            st.jobs.unshift({ id, asset: a.id, preset: p.id, stage: 'Queued', pct: 0, enc: a.kind === 'audio' || p.id === 'transcribe-srt' ? 'CPU' : 'NVENC', state: 'queued', node: 'gpu-small-1', params });
            st.noFreeform = false; ctx.rerender(); ctx.toast('Queued <span class="mono">' + id + '</span> on the media pool. Progress arrives over /ws.', 'ok');
          });
        } });
      };
      ctx.on('click', '[data-run]', openRun);
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (st.openRun) { st.openRun = false; setTimeout(openRun, 50); }

      // progress ticker for queued and running jobs
      clearTimeout(st.tick);
      if (st.jobs.some((j) => j.state === 'queued' || (j.state === 'running' && j.pct < 100))) {
        st.tick = setTimeout(() => {
          if (App.state.route !== 'media') return;
          st.jobs.forEach((j) => {
            if (j.state === 'queued') { j.state = 'running'; j.stage = j.preset === 'transcribe-srt' ? 'Transcribing' : j.preset === 'frames-1fps' ? 'Sampling frames' : j.preset === 'normalise-audio' ? 'Measuring loudness' : 'Encoding'; j.pct = 4; }
            else if (j.state === 'running' && j.pct < 100) { j.pct = Math.min(100, j.pct + 9); if (j.pct === 100) { j.state = 'succeeded'; j.stage = j.preset === 'transcribe-srt' ? 'Done, 6,204 words' : j.preset === 'frames-1fps' ? 'Done, 48 frames' : 'Done'; } }
          });
          ctx.rerender();
        }, 1600);
      }
    }
  });
})();
