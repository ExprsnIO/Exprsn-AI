(function () {
  // Images › Export (2026-10-16): one image, or several made into one animation (or a page each in a PDF), as WebP,
  // GIF, JPEG XL, JPEG, PNG or PDF, downloaded or saved into Files. POST /api/images/export converts in the sandboxed
  // converter (exprsn-imgconv); the server checks every option, the images' access and labels, and audits the export.
  // JPEG XL takes transparency, 8 to 16 bits per channel, lossless, animation, HDR (PQ or HLG), a region of interest
  // decoded first and a tile size.
  const { UI, esc } = App;
  const enc = encodeURIComponent;

  const FORMATS = [
    { value: 'webp', label: 'WebP', many: true, hint: 'Small for the web; lossy or lossless, transparency and animation.' },
    { value: 'gif', label: 'GIF', many: true, hint: '256 colours and one-bit transparency; plays everywhere.' },
    { value: 'jxl', label: 'JPEG XL', many: true, hint: 'Transparency, up to 16 bits per channel, lossless, animation, HDR, a region of interest and tiles.' },
    { value: 'jpg', label: 'JPEG', many: false, hint: 'Photos everywhere; no transparency, one image.' },
    { value: 'png', label: 'PNG', many: true, hint: 'Lossless; several images become an animated PNG.' },
    { value: 'pdf', label: 'PDF', many: true, hint: 'One page per image.' }
  ];
  const EXT = { webp: 'webp', gif: 'gif', jxl: 'jxl', jpg: 'jpg', png: 'png', pdf: 'pdf' };
  const HIGH = { confidential: 1, restricted: 1 };
  const RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };

  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  const help = (t) => '<div class="muted" style="font-size:12px">' + t + '</div>';

  /** The options the server is sent for the chosen format. */
  function optionsOf(x, many) {
    const o = {};
    if (x.maxSide) o.max_side = num(x.maxSide, 16, 16384);
    if (many) { o.frame_ms = num(x.frameMs, 10, 60000) || 500; o.loop = num(x.loop, 0, 65535) || 0; }
    if (x.format === 'webp') { if (x.lossless) o.lossless = true; else o.quality = num(x.quality, 1, 100) || 80; }
    if (x.format === 'jpg') { o.quality = num(x.quality, 1, 100) || 85; o.progressive = !!x.progressive; o.background = x.background || '#ffffff'; }
    if (x.format === 'gif' && x.colors && Number(x.colors) < 256) o.colors = num(x.colors, 2, 256);
    if (x.format === 'jxl') {
      if (x.lossless) o.lossless = true; else o.quality = num(x.quality, 1, 100) || 90;
      o.bit_depth = Number(x.bitDepth) || 8;
      if (x.hdr !== 'none') { o.hdr = x.hdr; if (o.bit_depth === 8) o.bit_depth = 10; if (x.hdr === 'pq') o.sdr_white = num(x.sdrWhite, 80, 1000) || 203; if (x.peak) o.intensity_target = num(x.peak, 100, 10000); }
      o.effort = num(x.effort, 1, 9) || 7;
      if (x.progressive) o.progressive = true;
      if (x.roi) o.roi = { x: Math.round(num(x.roiX, 0, 100) * 10) / 1000, y: Math.round(num(x.roiY, 0, 100) * 10) / 1000 };
      if (x.tile) o.tile_size = Number(x.tile);
      if (!x.alpha) o.background = x.background || '#ffffff';
    }
    return o;
  }

  function optionFields(x, many, first) {
    const q = (dflt) => UI.field('Quality', UI.input(x.quality == null ? dflt : x.quality, { type: 'number', attrs: 'data-x="quality" min="1" max="100" inputmode="numeric"' }), '1 to 100; higher is closer to the original and larger.');
    let h = '';
    if (x.format === 'webp') h += UI.check('Lossless (exact pixels)', x.lossless, 'data-x="lossless"') + (x.lossless ? '' : q(80));
    if (x.format === 'jpg') h += q(85) + UI.check('Progressive (shows a rough picture first)', x.progressive, 'data-x="progressive"') + UI.field('Background for transparency', UI.input(x.background || '#ffffff', { attrs: 'data-x="background" maxlength="7"' }), 'JPEG has no transparency: transparent pixels go onto this colour (#rrggbb).');
    if (x.format === 'gif') h += UI.field('Colours', UI.select(['256', '128', '64', '32', '16'], String(x.colors || 256), 'data-x="colors"'), 'GIF holds at most 256 colours.');
    if (x.format === 'png') h += help('Lossless. Only the original download keeps the content credentials (C2PA manifest); an exported PNG is written again without them.');
    if (x.format === 'pdf') h += help('One page per image, sized to the image.');
    if (x.format === 'jxl') {
      h += '<fieldset class="vstack gap6" style="border:0;padding:0;margin:0"><legend class="eyebrow">Compression</legend>'
        + UI.check('Lossless (mathematically exact)', x.lossless, 'data-x="lossless"') + (x.lossless ? '' : q(90))
        + UI.field('Effort', UI.select(['1', '3', '5', '7', '9'].map((v) => ({ value: v, label: v + (v === '7' ? ' (default)' : v === '9' ? ' (smallest, slowest)' : v === '1' ? ' (fastest)' : '') })), String(x.effort || 7), 'data-x="effort"')) + '</fieldset>'
        + '<fieldset class="vstack gap6" style="border:0;padding:0;margin:0"><legend class="eyebrow">Colour</legend>'
        + UI.field('Bits per channel', UI.select([{ value: '8', label: '8 bits' }, { value: '10', label: '10 bits' }, { value: '12', label: '12 bits' }, { value: '16', label: '16 bits' }], String(x.bitDepth || 8), 'data-x="bitDepth"'), 'More than 8 bits keeps smooth gradients through later editing; HDR needs 10 or more.')
        + UI.field('HDR', UI.select([{ value: 'none', label: 'None (SDR, sRGB)' }, { value: 'pq', label: 'PQ (Rec.2100, HDR10 displays)' }, { value: 'hlg', label: 'HLG (Rec.2100, broadcast)' }], x.hdr, 'data-x="hdr"'), 'Rec.2100 with BT.2020 primaries. A generated image is SDR: it is placed at reference white, so it gains no brighter highlights.')
        + (x.hdr === 'pq' ? UI.field('SDR white (nits)', UI.input(x.sdrWhite == null ? 203 : x.sdrWhite, { type: 'number', attrs: 'data-x="sdrWhite" min="80" max="1000" inputmode="numeric"' }), '203 nits is the BT.2408 reference.') : '')
        + (x.hdr !== 'none' ? UI.field('Peak brightness (nits)', UI.input(x.peak == null ? '' : x.peak, { type: 'number', placeholder: x.hdr === 'pq' ? '10000' : '1000', attrs: 'data-x="peak" min="100" max="10000" inputmode="numeric"' })) : '')
        + UI.check('Keep transparency', x.alpha, 'data-x="alpha"') + (x.alpha ? '' : UI.field('Background', UI.input(x.background || '#ffffff', { attrs: 'data-x="background" maxlength="7"' }), '#rrggbb'))
        + '</fieldset>'
        + '<fieldset class="vstack gap6" style="border:0;padding:0;margin:0"><legend class="eyebrow">Decoding</legend>'
        + UI.check('Progressive (a sharper picture arrives as more bytes load)', x.progressive || x.roi, 'data-x="progressive"' + (x.roi ? ' disabled' : ''))
        + UI.check('Region of interest (decoded first)', x.roi, 'data-x="roi"')
        + (x.roi ? '<div class="grid2" style="gap:10px">' + UI.field('Centre across (%)', UI.input(x.roiX, { type: 'number', attrs: 'data-x="roiX" min="0" max="100" inputmode="numeric"' })) + UI.field('Centre down (%)', UI.input(x.roiY, { type: 'number', attrs: 'data-x="roiY" min="0" max="100" inputmode="numeric"' })) + '</div>'
          + (first ? '<button type="button" class="ix-roi" data-roipick aria-label="Choose the region of interest: click the picture, or use the two fields above"><img src="/api/images/' + enc(first.id) + '/image" alt=""><span class="ix-dot" style="left:' + esc(x.roiX) + '%;top:' + esc(x.roiY) + '%"></span></button>' : '')
          + help('The 256-pixel groups around this point are stored first, so a viewer that loads part of the file shows this region first.') : '')
        + UI.field('Tile size', UI.select([{ value: '', label: 'Default (VarDCT, 256 px groups)' }, { value: '128', label: '128 px' }, { value: '256', label: '256 px' }, { value: '512', label: '512 px' }, { value: '1024', label: '1024 px' }], x.tile || '', 'data-x="tile"'), 'Tiles are decoded independently, in parallel or region by region. A lossy file with a chosen tile size is encoded in modular mode.')
        + '</fieldset>';
    }
    if (many) h += '<div class="grid2" style="gap:10px">' + UI.field(x.format === 'pdf' ? 'Pages' : 'Each frame (ms)', x.format === 'pdf' ? '<span class="fg2">one per image</span>' : UI.input(x.frameMs, { type: 'number', attrs: 'data-x="frameMs" min="10" max="60000" inputmode="numeric"' })) + (x.format === 'pdf' ? '' : UI.field('Plays', UI.select([{ value: '0', label: 'For ever' }, { value: '1', label: 'Once' }, { value: '3', label: '3 times' }], String(x.loop || 0), 'data-x="loop"'))) + '</div>';
    h += UI.field('Longest side (px)', UI.input(x.maxSide || '', { type: 'number', placeholder: 'as generated', attrs: 'data-x="maxSide" min="16" max="16384" inputmode="numeric"' }), 'Shrinks the image; never enlarges it.');
    return h;
  }

  /**
   * open(ctx, { selected, images }): `images` are the finished ones the user may add (newest first); `selected` is
   * checked to start with.
   */
  function open(ctx, input) {
    const done = (input.images || []).filter((c) => c.state === 'succeeded');
    const me = App.me || {};
    const spaces = (me.workspaces || []).map((w) => ({ value: w.id, label: w.name }));
    const x = { format: 'webp', ids: input.selected ? [input.selected.id] : done.slice(0, 1).map((c) => c.id), quality: null, lossless: false, progressive: false, background: '#ffffff', colors: 256,
      bitDepth: 8, hdr: 'none', sdrWhite: 203, peak: null, effort: 7, roi: false, roiX: 50, roiY: 50, tile: '', alpha: true, frameMs: 500, loop: 0, maxSide: '',
      to: 'download', workspaceId: me.workspace || (spaces[0] && spaces[0].value) || '', folderId: '', folders: null, name: '', busy: false };
    const chosen = () => done.filter((c) => x.ids.indexOf(c.id) >= 0);
    const fmt = () => FORMATS.find((f) => f.value === x.format);

    const body = () => {
      const list = chosen(); const many = list.length > 1;
      const label = list.reduce((l, c) => (RANK[c.label] > RANK[l] ? c.label : l), 'public');
      const f = fmt();
      return '<style>#overlay .ix-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px;max-height:200px;overflow:auto;padding:2px}'
        + '#overlay .ix-pick{position:relative;display:block;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel2);cursor:pointer}#overlay .ix-pick img{display:block;width:100%;height:64px;object-fit:cover}'
        + '#overlay .ix-pick input{position:absolute;top:4px;left:4px;width:18px;height:18px}#overlay .ix-pick .ix-n{position:absolute;right:4px;bottom:4px;background:var(--panel);color:var(--fg);border-radius:4px;padding:0 4px;font-size:11px}'
        + '#overlay .ix-pick:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-tint)}#overlay .ix-pick:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}'
        + '#overlay .ix-roi{position:relative;display:block;padding:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;max-width:240px;cursor:crosshair;background:var(--panel2)}#overlay .ix-roi img{display:block;width:100%}'
        + '#overlay .ix-dot{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 2px #000;pointer-events:none}</style>'
        + '<fieldset style="border:0;padding:0;margin:0"><legend class="eyebrow">Images (' + list.length + ' chosen)</legend><div class="ix-grid">'
        + done.map((c) => { const at = x.ids.indexOf(c.id); return '<label class="ix-pick"><input type="checkbox" data-xpick="' + esc(c.id) + '"' + (at >= 0 ? ' checked' : '') + ' aria-label="Image seed ' + esc(c.seed) + ', ' + esc(c.label) + (at >= 0 ? ', frame ' + (at + 1) : '') + '"><img src="/api/images/' + enc(c.id) + '/image" alt="" loading="lazy">' + (at >= 0 && many ? '<span class="ix-n">' + (at + 1) + '</span>' : '') + '</label>'; }).join('')
        + '</div>' + help(many ? 'Frames play in the order you chose them. ' + (x.format === 'pdf' ? 'Each becomes a page.' : 'They become one animation.') : 'Choose more than one for an animation, or for a PDF with a page each.') + '</fieldset>'
        + UI.field('Format', UI.select(FORMATS.map((o) => ({ value: o.value, label: o.label + (!o.many && many ? ' (one image only)' : '') })), x.format, 'data-x="format"'), esc(f.hint))
        + (!f.many && many ? UI.notice(esc(f.label) + ' holds one image. Choose one image, or another format.', 'warn') : '')
        + '<div class="vstack gap6" data-xopts>' + optionFields(x, many, list[0]) + '</div>'
        + '<fieldset class="vstack gap6" style="border:0;padding:0;margin:0"><legend class="eyebrow">Save to</legend>'
        + UI.seg([{ id: 'download', label: 'Download' }, { id: 'files', label: 'Files' }], x.to, 'data-xto aria-label="Save to"')
        + (x.to === 'files' ? (App.can('files:write') ? (spaces.length ? UI.field('Workspace', UI.select(spaces, x.workspaceId, 'data-x="workspaceId"')) + UI.field('Folder', UI.select([{ value: '', label: 'The workspace\'s top level' }].concat((x.folders || []).map((fo) => ({ value: fo.id, label: fo.name }))), x.folderId, 'data-x="folderId"' + (x.folders ? '' : ' disabled')), x.folders ? '' : 'Loading the folders…') : UI.notice('You are in no workspace, and files live in one.', 'warn')) : UI.notice('Saving into Files needs the files:write permission.', 'warn')) : '')
        + UI.field('File name', UI.input(x.name, { placeholder: (list.length === 1 ? 'image-' + list[0].id.toLowerCase() : 'images-' + list.length) + '.' + EXT[x.format], attrs: 'data-x="name" maxlength="200"' }), 'Without folders; the extension is added.')
        + '</fieldset>'
        + (HIGH[label] ? UI.notice('<b>' + (many ? 'These images are' : 'This image is') + ' ' + esc(label) + '.</b> ' + (x.to === 'files' ? 'The file keeps the label in Files.' : 'Downloading copies it outside the console.') + ' The export is written to the audit log.', 'warn') : '')
        + (x.format !== 'png' ? help('The content credentials (C2PA manifest) travel only in the original PNG; the audit records which images this export came from.') : '');
    };

    const canGo = () => { const list = chosen(); return list.length > 0 && !x.busy && (fmt().many || list.length === 1) && (x.to === 'download' || (App.can('files:write') && !!x.workspaceId)); };
    const loadFolders = (m) => {
      if (x.to !== 'files' || !x.workspaceId) return;
      App.get('/api/files/browse?workspace=' + enc(x.workspaceId)).then((b) => { x.folders = b.folders || []; paint(m); }).catch(() => { x.folders = []; paint(m); });
    };
    let paintRef = null;
    const paint = (m) => { if (paintRef) paintRef(m); };

    ctx.modal({
      title: 'Export',
      cls: 'wide',
      body: body(),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Export', { kind: 'primary', icon: 'download', attrs: 'data-xgo' }),
      onMount(m) {
        const box = m.querySelector('.vstack.gap12');
        paintRef = (mm) => {
          const a = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null;
          const keep = a ? (a.getAttribute('data-x') ? '[data-x="' + a.getAttribute('data-x') + '"]' : a.getAttribute('data-xpick') ? '[data-xpick="' + a.getAttribute('data-xpick') + '"]' : a.getAttribute('data-seg') ? '[data-xto] [data-seg="' + a.getAttribute('data-seg') + '"]' : null) : null;
          box.innerHTML = body();
          const go = mm.querySelector('[data-xgo]'); if (go) { go.disabled = !canGo(); go.textContent = x.busy ? 'Exporting…' : x.to === 'files' ? 'Save to Files' : 'Download'; }
          if (keep) { const el = box.querySelector(keep); if (el) el.focus(); }
        };
        paint(m);
        const set = (k, v) => { x[k] = v; if (k === 'workspaceId') { x.folders = null; x.folderId = ''; loadFolders(m); } if (k === 'roi' && v) x.progressive = true; };
        m.addEventListener('change', (e) => {
          const t = e.target;
          if (t.dataset.xpick) { const id = t.dataset.xpick; x.ids = t.checked ? x.ids.concat([id]) : x.ids.filter((v) => v !== id); paint(m); return; }
          const k = t.dataset.x; if (!k) return;
          set(k, t.type === 'checkbox' ? t.checked : t.value);
          if (t.tagName === 'SELECT' || t.type === 'checkbox') paint(m);
        });
        m.addEventListener('input', (e) => { const t = e.target; const k = t.dataset.x; if (k && t.type !== 'checkbox' && t.tagName !== 'SELECT') x[k] = t.value; const go = m.querySelector('[data-xgo]'); if (go) go.disabled = !canGo(); });
        m.addEventListener('click', async (e) => {
          const seg = e.target.closest('[data-xto] [data-seg]');
          if (seg) { x.to = seg.dataset.seg; if (x.to === 'files' && !x.folders) loadFolders(m); paint(m); return; }
          const pick = e.target.closest('[data-roipick]');
          if (pick) {
            const r = pick.getBoundingClientRect();
            x.roiX = Math.round(((e.clientX - r.left) / r.width) * 100); x.roiY = Math.round(((e.clientY - r.top) / r.height) * 100);
            paint(m); return;
          }
          if (!e.target.closest('[data-xgo]') || !canGo()) return;
          x.busy = true; paint(m);
          const list = chosen(); const many = list.length > 1;
          const req = { ids: list.map((c) => c.id), format: x.format, options: optionsOf(x, many), to: x.to };
          if (x.name.trim()) req.name = x.name.trim();
          if (x.to === 'files') { req.workspaceId = x.workspaceId || null; if (x.folderId) req.folderId = x.folderId; }
          try {
            const res = await fetch('/api/images/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': App.state.csrf || '' }, body: JSON.stringify(req) });
            if (!res.ok) { let problem = {}; try { problem = await res.json(); } catch (_) { /* none */ } const err = new Error(problem.detail || res.statusText); err.problem = problem; err.status = res.status; throw err; }
            if (x.to === 'files') {
              const out = await res.json();
              App.closeOverlay();
              ctx.toast('<span>Saved to Files as <b>' + esc(out.file.name) + '</b> (' + esc(out.export.label) + '). ' + esc(((out.export.notes || [])[0]) || '') + ' <a href="#/files?id=' + enc(out.file.id) + '">Open in Files</a></span>', 'ok', 8000);
            } else {
              const blob = await res.blob();
              const name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'export.' + EXT[x.format];
              let meta = {}; try { meta = JSON.parse(decodeURIComponent(res.headers.get('X-Export-Notes') || '')); } catch (_) { /* none */ }
              const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
              App.closeOverlay();
              ctx.toast('<span>Exported <b>' + esc(name) + '</b>, ' + esc(Math.round(blob.size / 1024)) + ' KB' + (meta.frames > 1 ? ', ' + esc(meta.frames) + (x.format === 'pdf' ? ' pages' : ' frames') : '') + '. ' + esc(((meta.notes || []).find((n) => /^JPEG XL/.test(n))) || '') + ((meta.warnings || []).length ? ' ' + esc(meta.warnings[0]) : '') + '</span>', 'ok', 8000);
            }
          } catch (err) {
            x.busy = false; paint(m);
            App.fail(err, err.status === 503 ? 'Image conversion is not set up' : 'Could not export');
          }
        });
      }
    });
  }

  App.imagesExport = { open, optionsOf };
})();
