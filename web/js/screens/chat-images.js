// Chat: pictures a tool made, shown where the tool's result is (1.7.0). `chat.js` (a model's tool calls) and
// `chat-capabilities.js` (a /tool card) pass a result to App.chatImages.collect, which finds the image views in it
// (the shape of GET /api/images/:id), and draw them with App.chatImages.html. A picture still being made is asked
// for again every two seconds until it is done; chat.js lends `bind(schedule)` so the thread repaints. The picture
// itself is GET /api/images/:id/image (same origin, the session's cookie); "Open" shows it full size in a dialog.
(function () {
  const { UI, esc } = App;
  const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  const ACTIVE = { queued: true, running: true };
  const cache = {}; // id -> the newest view
  const polling = {};
  let repaint = () => {};

  /** Image views inside a tool's result, at most a few levels down, each once. */
  function collect(out) {
    const found = []; const seen = {};
    (function walk(v, depth) {
      if (!v || typeof v !== 'object' || depth > 4) return;
      if (Array.isArray(v)) { v.slice(0, 20).forEach((x) => walk(x, depth + 1)); return; }
      if (typeof v.id === 'string' && ULID.test(v.id) && 'state' in v && 'width' in v && ('url' in v || 'batchId' in v)) {
        if (!seen[v.id]) { seen[v.id] = true; found.push(v); }
        return;
      }
      Object.keys(v).forEach((k) => walk(v[k], depth + 1));
    })(out, 0);
    return found;
  }

  function watch(id) {
    if (polling[id]) return;
    polling[id] = true;
    let tries = 0;
    const tick = () => {
      App.get('/api/images/' + encodeURIComponent(id)).then((r) => {
        cache[id] = r; repaint();
        if (ACTIVE[r.state] && ++tries < 450) setTimeout(tick, 2000); else polling[id] = false;
      }).catch(() => { polling[id] = false; });
    };
    setTimeout(tick, 1500);
  }

  const urlOf = (v) => v.url || (v.state === 'succeeded' ? '/api/images/' + encodeURIComponent(v.id) + '/image' : null);
  const altOf = (v) => (v.edit ? 'Edited picture: ' + v.edit : v.prompt ? 'Picture: ' + v.prompt : 'Picture made in this conversation');

  function card(v0) {
    const v = cache[v0.id] || v0;
    const size = v.width && v.height ? v.width + ' × ' + v.height : '';
    const meta = [size, v.backend || v.backendLabel, v.edit].filter(Boolean).map(esc).join(' · ');
    if (ACTIVE[v.state]) {
      watch(v.id);
      const step = v.steps && v.step ? ', step ' + v.step + ' of ' + v.steps : '';
      return '<figure class="ch-img ch-img-wait" aria-live="polite"><div class="ch-img-ph">' + UI.icon('clock', 14) + ' ' + esc(v.stage || (v.state === 'queued' ? 'Queued' : 'Making the picture')) + esc(step)
        + (v.position ? ', position ' + esc(String(v.position)) : '') + '</div>' + (meta ? '<figcaption>' + meta + '</figcaption>' : '') + '</figure>';
    }
    if (v.state !== 'succeeded') {
      const why = v.state === 'withheld' ? 'Withheld by the image-safety check.' : v.error ? v.error : 'The picture is ' + v.state + '.';
      return '<figure class="ch-img ch-img-off"><div class="ch-img-ph">' + esc(why) + '</div>' + (meta ? '<figcaption>' + meta + '</figcaption>' : '') + '</figure>';
    }
    const url = urlOf(v);
    return '<figure class="ch-img"><button type="button" class="ch-img-btn" data-chimg="' + esc(v.id) + '" aria-label="Open the picture full size">'
      + '<img src="' + esc(url) + '" alt="' + esc(altOf(v)) + '" loading="lazy" width="' + esc(String(v.width || '')) + '" height="' + esc(String(v.height || '')) + '"></button>'
      + '<figcaption>' + meta + (meta ? ' · ' : '') + '<a href="' + esc(url) + '" target="_blank" rel="noopener">Open in a new tab</a> · <a href="#/images">Images</a></figcaption></figure>';
  }

  function html(list) {
    if (!list || !list.length) return '';
    return '<div class="ch-imgs">' + list.map(card).join('') + '</div>';
  }

  /** The picture full size in a dialog. */
  function open(id) {
    const v = cache[id] || { id: id, state: 'succeeded' };
    const url = urlOf(v);
    App.modal({ cls: 'wide', title: v.edit ? 'Edited picture' : 'Picture', label: 'Picture',
      body: '<figure class="ch-img-full"><img src="' + esc(url) + '" alt="' + esc(altOf(v)) + '"><figcaption>' + esc([v.width && v.height ? v.width + ' × ' + v.height : '', v.backendLabel || v.backend, v.edit].filter(Boolean).join(' · '))
        + ' · <a href="' + esc(url) + '" target="_blank" rel="noopener">Open in a new tab</a> · <a href="' + esc('/api/images/' + encodeURIComponent(id) + '/download') + '">Download</a></figcaption></figure>' });
  }

  /** Remembers a view the chat already has (a tool result), so a repaint does not ask for it again. */
  function note(v) { if (v && v.id && !cache[v.id]) cache[v.id] = v; }

  const CSS = '.ch-imgs{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0}'
    + '.ch-img{margin:0;display:flex;flex-direction:column;gap:4px;max-width:min(100%,520px)}'
    + '.ch-img-btn{padding:0;border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:zoom-in;line-height:0;overflow:hidden}'
    + '.ch-img-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'
    + '.ch-img img{display:block;max-width:100%;max-height:420px;width:auto;height:auto;object-fit:contain}'
    + '.ch-img figcaption{font-size:12px;color:var(--fg2);overflow-wrap:anywhere}'
    + '.ch-img-ph{display:flex;align-items:center;gap:6px;min-height:72px;min-width:min(260px,100%);padding:12px;border:1px dashed var(--line);border-radius:6px;background:var(--panel);font-size:13px;color:var(--fg2)}'
    + '.ch-img-off .ch-img-ph{border-style:solid}'
    + '.ch-img-full{margin:0;display:flex;flex-direction:column;gap:8px}.ch-img-full img{max-width:100%;max-height:75vh;object-fit:contain;align-self:center}'
    + '.ch-img-full figcaption{font-size:12px;color:var(--fg2);overflow-wrap:anywhere}';

  App.chatImages = { collect: collect, html: html, open: open, note: note, CSS: CSS, bind: (fn) => { repaint = fn; } };
})();
