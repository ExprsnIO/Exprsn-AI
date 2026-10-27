// 1.8.0, Sprint 47 (B-137): designer editing on the Workflows canvas, called from workflows.js as App.wfEdit.
//
// - Undo and redo of every change to the draft graph in this session (snapshots of the graph, at most 100 back),
//   with Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z or Ctrl+Y, and the Undo and Redo buttons.
// - Selecting several steps (Shift, Ctrl or Cmd and a click; Ctrl/Cmd+A on the canvas), copying, pasting and
//   duplicating them with the edges between them and new ids. The clipboard is this browser's (localStorage), so a
//   copy pastes into another workflow; the server then checks the pasted steps' references against that workflow and
//   the inspector flags those that do not resolve.
// - Zoom (buttons, Ctrl+wheel, + - and 0 to fit while the canvas has focus), panning by dragging the empty canvas,
//   and a minimap button that pans with the arrow keys and jumps where it is clicked. Smooth scrolling only without
//   prefers-reduced-motion.
// - Step comments (notes on a step, kept in the draft graph; the server stamps who wrote them and when).
// - Workflow tags (filter the list by one) and favourites (a star, and a favourites-only filter).
// - A list of the keyboard shortcuts. None of them takes Ctrl+K (the command palette) or works while typing in a field.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const CLIP = 'exprsn.workflows.clipboard';
  const MAX_HISTORY = 100;
  const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const MOD = isMac ? 'Cmd' : 'Ctrl';
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  const CSS = '#main .wf-viewbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px}#main .wf-viewbar .grow{flex:1 1 auto}'
    + '#main .wf-zoom{position:relative}#main .wf-canvas{transform-origin:0 0}'
    + '@media (prefers-reduced-motion: no-preference){#main .wf-canvas{transition:transform .12s ease-out}}'
    + '#main .wf-node.multi{box-shadow:0 0 0 3px var(--accent-tint);border-color:var(--accent)}'
    + '#main .wf-cbadge{position:absolute;right:6px;top:6px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--info-bg);color:var(--info-fg);font-size:10px;font-weight:700;line-height:16px;text-align:center}'
    + '#main .wf-minimap{display:block;padding:2px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);cursor:pointer;line-height:0}#main .wf-minimap:focus-visible{outline:2px solid var(--accent);outline-offset:1px}'
    + '#main .wf-minimap rect.n{fill:var(--meter)}#main .wf-minimap rect.s{fill:var(--accent)}#main .wf-minimap rect.v{fill:none;stroke:var(--accent);stroke-width:2}'
    + '#main .wf-comments{display:flex;flex-direction:column;gap:6px}#main .wf-comment{border:1px solid var(--line);border-radius:6px;padding:6px 8px;background:var(--panel2);font-size:12px;overflow-wrap:anywhere}#main .wf-comment.resolved{opacity:.75}'
    + '#main .wf-tagrow{display:flex;flex-wrap:wrap;align-items:center;gap:4px}#main .wf-star[aria-pressed="true"] svg{fill:var(--warn-fg)}#main .wf-star svg{fill:none;stroke:currentColor;stroke-width:1.6}';
  const STAR = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"></path></svg>';

  // ---------- history ----------

  /** Starts a fresh history when another workflow is open; keeps it across saves of the same one. */
  function track(st) {
    const h = st.hist;
    if (!st.draft) return;
    if (!h || h.wf !== st.wfId) { st.hist = { wf: st.wfId, cur: JSON.stringify(st.draft), past: [], future: [], ref: st.draft }; st.multi = []; st.pasted = {}; return; }
    if (h.ref !== st.draft) { h.ref = st.draft; if (!st.unsaved) h.cur = JSON.stringify(st.draft); }
  }
  /** Records the draft as it is now (after a change) as the newest step of the history. */
  function commit(st) {
    track(st);
    const h = st.hist; if (!h) return;
    const j = JSON.stringify(st.draft);
    if (j === h.cur) return;
    h.past.push(h.cur);
    if (h.past.length > MAX_HISTORY) h.past.shift();
    h.cur = j; h.future = [];
  }
  function step(st, from, to) {
    commit(st);
    const h = st.hist; if (!h || !h[from].length) return false;
    h[to].push(h.cur);
    h.cur = h[from].pop();
    st.draft = JSON.parse(h.cur); h.ref = st.draft;
    st.unsaved = true;
    if (!st.draft.nodes.some((n) => n.id === st.sel)) st.sel = st.draft.nodes[0] ? st.draft.nodes[0].id : null;
    st.multi = (st.multi || []).filter((id) => st.draft.nodes.some((n) => n.id === id));
    return true;
  }
  const undo = (st) => step(st, 'past', 'future');
  const redo = (st) => step(st, 'future', 'past');
  const canUndo = (st) => !!(st.hist && (st.hist.past.length || (st.draft && JSON.stringify(st.draft) !== st.hist.cur)));
  const canRedo = (st) => !!(st.hist && st.hist.future.length);

  // ---------- selection and clipboard ----------

  function selected(st) {
    const ids = (st.multi || []).filter((id) => st.draft && st.draft.nodes.some((n) => n.id === id));
    return ids.length ? ids : st.sel ? [st.sel] : [];
  }
  function toggle(st, id) {
    const m = (st.multi && st.multi.length ? st.multi : st.sel ? [st.sel] : []).slice();
    const i = m.indexOf(id);
    if (i >= 0) m.splice(i, 1); else m.push(id);
    st.multi = m; st.sel = id;
  }
  function readClip() {
    try { const c = JSON.parse(localStorage.getItem(CLIP) || 'null'); return c && Array.isArray(c.nodes) && c.nodes.length ? c : null; } catch (e) { return null; }
  }
  /** Copies the steps (never the trigger) and the edges between them. Returns how many were copied. */
  function copy(st, ids) {
    const set = {};
    const nodes = st.draft.nodes.filter((n) => ids.indexOf(n.id) >= 0 && n.kind !== 'trigger');
    nodes.forEach((n) => { set[n.id] = 1; });
    if (!nodes.length) return 0;
    const clip = { v: 1, at: Date.now(), from: { id: st.wfId, name: st.wf ? st.wf.name : '' }, nodes: JSON.parse(JSON.stringify(nodes)), edges: st.draft.edges.filter((e) => set[e.from] && set[e.to]).map((e) => Object.assign({}, e)) };
    clip.nodes.forEach((n) => { delete n.comments; });
    try { localStorage.setItem(CLIP, JSON.stringify(clip)); } catch (e) { st.clipMemory = clip; }
    st.clipMemory = clip;
    return nodes.length;
  }
  /** Adds the clipboard's steps with new ids, the edges between them re-pointed; returns the new ids. */
  function paste(st, W, H, clip) {
    clip = clip || readClip() || st.clipMemory;
    if (!clip) return [];
    const g = st.draft; const map = {};
    const taken = {}; g.nodes.forEach((n) => { taken[n.id] = 1; });
    const minX = Math.min.apply(null, clip.nodes.map((n) => n.x || 0));
    const minY = Math.min.apply(null, clip.nodes.map((n) => n.y || 0));
    const same = clip.from && clip.from.id === st.wfId;
    // In the same workflow the copy sits just below and right of the original; elsewhere, below everything.
    const baseY = same ? null : g.nodes.reduce((m, n) => Math.max(m, (n.y || 0) + H), 0) + 56;
    const out = [];
    clip.nodes.forEach((src) => {
      const kind = src.kind;
      let i = 1; while (taken[kind + i]) i++;
      const id = kind + i; taken[id] = 1; map[src.id] = id;
      const n = JSON.parse(JSON.stringify(src));
      n.id = id;
      n.x = Math.max(0, Math.min(20000, same ? (src.x || 0) + 40 : 20 + (src.x || 0) - minX));
      n.y = Math.max(0, Math.min(20000, same ? (src.y || 0) + 40 : baseY + (src.y || 0) - minY));
      if (same && !/ \(copy\)$/.test(n.title)) n.title = String(n.title).slice(0, 93) + ' (copy)';
      g.nodes.push(n); out.push(id);
    });
    clip.edges.forEach((e) => { if (map[e.from] && map[e.to]) g.edges.push(Object.assign({}, e, { from: map[e.from], to: map[e.to] })); });
    st.pasted = st.pasted || {};
    out.forEach((id) => { st.pasted[id] = { from: (clip.from && clip.from.name) || 'another workflow', same }; });
    st.multi = out.slice(); st.sel = out[0];
    return out;
  }
  function duplicate(st, ids, W, H) {
    const keep = readClip();
    const n = copy(st, ids);
    if (!n) return [];
    const clip = st.clipMemory;
    // Duplicating leaves the clipboard as it was.
    try { if (keep) localStorage.setItem(CLIP, JSON.stringify(keep)); else localStorage.removeItem(CLIP); } catch (e) { /* storage unavailable */ }
    st.clipMemory = keep || null;
    return paste(st, W, H, clip);
  }

  // ---------- view: zoom, pan, minimap ----------

  const zoom = (st) => (st.zoom && st.zoom > 0 ? st.zoom : 1);
  function setZoom(st, z) { st.zoom = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], Math.round(z * 100) / 100)); }
  function zoomStep(st, dir) {
    const z = zoom(st);
    const next = dir > 0 ? ZOOMS.find((x) => x > z + 0.001) : ZOOMS.slice().reverse().find((x) => x < z - 0.001);
    setZoom(st, next || z);
  }
  function fit(st, sc, cw, ch) {
    if (!sc) return;
    setZoom(st, Math.min(1.5, (sc.clientWidth - 8) / cw, (sc.clientHeight - 8) / ch));
    st.scrollTo = { left: 0, top: 0 };
  }

  function viewBar(st, o) {
    const z = zoom(st);
    const sel = selected(st).filter((id) => { const n = st.draft.nodes.find((x) => x.id === id); return n && n.kind !== 'trigger'; });
    const clip = readClip() || st.clipMemory;
    return '<style>' + CSS + '</style><div class="wf-viewbar" role="toolbar" aria-label="Canvas view and editing">'
      + '<span class="hstack gap4" role="group" aria-label="Zoom">' + UI.btn('−', { size: 'xs', attrs: 'data-wfzoom="-1" aria-label="Zoom out"', title: 'Zoom out (-)', disabled: z <= ZOOMS[0] }) + '<span class="muted num" style="font-size:12px;min-width:38px;text-align:center" aria-live="polite">' + Math.round(z * 100) + '%</span>' + UI.btn('+', { size: 'xs', attrs: 'data-wfzoom="1" aria-label="Zoom in"', title: 'Zoom in (+)', disabled: z >= ZOOMS[ZOOMS.length - 1] }) + UI.btn('Fit', { size: 'xs', kind: 'ghost', attrs: 'data-wfzoomfit', title: 'Fit the graph (0)' }) + UI.btn('100%', { size: 'xs', kind: 'ghost', attrs: 'data-wfzoom1' }) + '</span>'
      + (o.editable || sel.length ? '<span class="hstack gap4" role="group" aria-label="Clipboard">'
        + UI.btn(sel.length > 1 ? 'Copy ' + sel.length + ' steps' : 'Copy', { size: 'xs', icon: 'copy', attrs: 'data-wfcopy', disabled: !sel.length, title: 'Copy the selected steps (' + MOD + '+C)' })
        + (o.editable ? UI.btn('Paste', { size: 'xs', attrs: 'data-wfpaste', disabled: !clip, title: clip ? 'Paste ' + clip.nodes.length + ' step' + (clip.nodes.length === 1 ? '' : 's') + ' from ' + (clip.from && clip.from.name ? clip.from.name : 'the clipboard') + ' (' + MOD + '+V)' : 'Copy steps first' }) + UI.btn('Duplicate', { size: 'xs', attrs: 'data-wfdup', disabled: !sel.length, title: 'Duplicate the selected steps (' + MOD + '+D)' }) : '')
        + '</span>' : '')
      + (o.editable ? '<span class="hstack gap4" role="group" aria-label="History">' + UI.btn('Undo', { size: 'xs', icon: 'undo', attrs: 'data-wfundo', disabled: !canUndo(st), title: 'Undo (' + MOD + '+Z)' }) + UI.btn('Redo', { size: 'xs', attrs: 'data-wfredo', disabled: !canRedo(st), title: 'Redo (Shift+' + MOD + '+Z)' }) + '</span>' : '')
      + (st.multi && st.multi.length > 1 ? '<span class="muted" style="font-size:12px">' + st.multi.length + ' steps selected</span>' + UI.btn('Clear selection', { size: 'xs', kind: 'ghost', attrs: 'data-wfselclear' }) : '')
      + '<span class="grow"></span>' + UI.btn('Shortcuts', { size: 'xs', kind: 'ghost', attrs: 'data-wfkeys', title: 'Keyboard shortcuts' })
      + '</div>';
  }

  function minimap(st, nodes, cw, ch, W, H) {
    const mw = 168; const mh = Math.max(60, Math.min(120, Math.round(mw * ch / cw)));
    const sx = mw / cw, sy = mh / ch;
    const sel = selected(st);
    const v = st.viewport || { left: 0, top: 0, width: cw, height: ch };
    const z = zoom(st);
    const vr = [v.left / z * sx, v.top / z * sy, Math.min(mw, v.width / z * sx), Math.min(mh, v.height / z * sy)].map((x) => Math.max(0, Math.round(x * 10) / 10));
    return '<button type="button" class="wf-minimap" data-wfminimap aria-label="Minimap of ' + nodes.length + ' step' + (nodes.length === 1 ? '' : 's') + '. Arrow keys pan the canvas; Enter shows the selected step; click to jump there." title="Minimap: arrow keys pan, Enter shows the selected step">'
      + '<svg width="' + mw + '" height="' + mh + '" viewBox="0 0 ' + mw + ' ' + mh + '" aria-hidden="true" focusable="false">'
      + nodes.map((n) => '<rect class="' + (sel.indexOf(n.id) >= 0 ? 's' : 'n') + '" x="' + Math.round(n.x * sx) + '" y="' + Math.round(n.y * sy) + '" width="' + Math.max(3, Math.round(W * sx)) + '" height="' + Math.max(2, Math.round(H * sy)) + '" rx="1"></rect>').join('')
      + '<rect class="v" data-wfvp x="' + vr[0] + '" y="' + vr[1] + '" width="' + vr[2] + '" height="' + vr[3] + '"></rect></svg></button>';
  }

  /** Scroll position kept across re-renders, the viewport for the minimap, Ctrl+wheel zoom and panning. */
  function bindView(ctx, st, o) {
    const sc = ctx.$('.wf-scroll');
    if (!sc) return;
    const z = zoom(st);
    if (st.fitPending) { st.fitPending = false; fit(st, sc, o.cw, o.ch); setTimeout(() => ctx.rerender(), 0); return; }
    const to = st.scrollTo || st.scroll;
    if (to) { sc.scrollLeft = to.left; sc.scrollTop = to.top; }
    st.scrollTo = null;
    const mm = ctx.$('[data-wfvp]');
    const mmSize = mm && mm.ownerSVGElement ? { w: Number(mm.ownerSVGElement.getAttribute('width')), h: Number(mm.ownerSVGElement.getAttribute('height')) } : null;
    const paint = () => {
      st.scroll = { left: sc.scrollLeft, top: sc.scrollTop };
      st.viewport = { left: sc.scrollLeft, top: sc.scrollTop, width: sc.clientWidth, height: sc.clientHeight };
      if (!mm || !mmSize) return;
      const sx = mmSize.w / o.cw, sy = mmSize.h / o.ch;
      mm.setAttribute('x', String(Math.max(0, sc.scrollLeft / z * sx)));
      mm.setAttribute('y', String(Math.max(0, sc.scrollTop / z * sy)));
      mm.setAttribute('width', String(Math.min(mmSize.w, sc.clientWidth / z * sx)));
      mm.setAttribute('height', String(Math.min(mmSize.h, sc.clientHeight / z * sy)));
    };
    paint();
    sc.addEventListener('scroll', paint, { passive: true });
    // Ctrl (or Cmd) and the wheel zooms around the pointer; the wheel alone scrolls as usual.
    sc.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = sc.getBoundingClientRect();
      const px = (sc.scrollLeft + e.clientX - r.left) / z, py = (sc.scrollTop + e.clientY - r.top) / z;
      zoomStep(st, e.deltaY < 0 ? 1 : -1);
      const nz = zoom(st);
      st.scrollTo = { left: Math.max(0, px * nz - (e.clientX - r.left)), top: Math.max(0, py * nz - (e.clientY - r.top)) };
      ctx.rerender();
    }, { passive: false });
    // Dragging the empty canvas pans it.
    sc.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('[data-node], button, a, input, select, textarea')) return;
      const sx = e.clientX, sy = e.clientY, l = sc.scrollLeft, t = sc.scrollTop;
      let moved = false;
      const move = (ev) => { const dx = ev.clientX - sx, dy = ev.clientY - sy; if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return; moved = true; sc.scrollLeft = l - dx; sc.scrollTop = t - dy; };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    const jump = (left, top) => sc.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: reduced() ? 'auto' : 'smooth' });
    const btn = ctx.$('[data-wfminimap]');
    if (btn && mmSize) {
      btn.addEventListener('click', (e) => {
        if (!e.clientX && !e.clientY) return; // a keyboard click (Enter) is handled below
        const r = btn.querySelector('svg').getBoundingClientRect();
        const cx = (e.clientX - r.left) / mmSize.w * o.cw * z, cy = (e.clientY - r.top) / mmSize.h * o.ch * z;
        jump(cx - sc.clientWidth / 2, cy - sc.clientHeight / 2);
      });
      btn.addEventListener('keydown', (e) => {
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (d) { e.preventDefault(); const stepPx = e.shiftKey ? 400 : 120; jump(sc.scrollLeft + d[0] * stepPx, sc.scrollTop + d[1] * stepPx); return; }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const n = st.draft && st.draft.nodes.find((x) => x.id === st.sel);
          if (n) jump((n.x + o.W / 2) * z - sc.clientWidth / 2, (n.y + o.H / 2) * z - sc.clientHeight / 2);
        }
      });
    }
  }

  // ---------- comments ----------

  function stepExtras(st, n, editable, issues) {
    let out = '';
    const p = st.pasted && st.pasted[n.id];
    if (p) {
      const refs = issues.filter((x) => x.code === 'reference' || x.code === 'unavailable');
      out += UI.notice('<b>Pasted' + (p.same ? '' : ' from ' + esc(p.from)) + '.</b> ' + (refs.length ? 'These references do not resolve in this workflow: ' + refs.map((x) => esc(x.message)).join(' ') : 'Its tools, profiles, workflows and other references were checked against this workflow' + (st.validation ? ' and resolve here.' : '; the check is running.')), refs.length ? 'warn' : 'info');
    }
    const list = n.comments || [];
    out += '<div class="eyebrow">Comments' + (list.length ? ' (' + list.length + ')' : '') + '</div><div class="wf-comments">'
      + (list.length ? list.map((c) => '<div class="wf-comment' + (c.resolved ? ' resolved' : '') + '"><div class="muted">' + esc(c.byName || 'you, not saved yet') + (c.at ? ', ' + esc(when(c.at)) : '') + (c.resolved ? ' · resolved' : '') + '</div><div>' + esc(c.text) + '</div>'
        + (editable ? '<div class="hstack gap6" style="margin-top:4px">' + UI.btn(c.resolved ? 'Reopen' : 'Resolve', { size: 'xs', kind: 'ghost', attrs: 'data-wfcres="' + esc(c.id) + '"' }) + UI.btn('Delete', { size: 'xs', kind: 'ghost', attrs: 'data-wfcdel="' + esc(c.id) + '"' }) + '</div>' : '') + '</div>').join('') : '<div class="muted" style="font-size:12px">No comments on this step.</div>')
      + (editable && list.length < 50 ? UI.field('Add a comment', UI.textarea('', { rows: 2, placeholder: 'A note for the next editor; runs never read it', attrs: 'data-wfcomment maxlength="2000"' })) + '<div>' + UI.btn('Add comment', { size: 'xs', attrs: 'data-wfcadd' }) + '</div>' : '')
      + '<div class="muted" style="font-size:11px">Saved with the draft and carried by versions and bundles. Never checked or run.</div></div>';
    return out;
  }

  // ---------- tags and favourites ----------

  function loadTags(st) {
    if (st.tagVocab || st.tagVocabBusy) return;
    st.tagVocabBusy = true;
    App.get('/api/workflow-tags').then((d) => { st.tagVocab = d.tags || []; }).catch(() => { st.tagVocab = []; }).finally(() => { st.tagVocabBusy = false; });
  }
  /** The list as the filters leave it; the open workflow always stays (it is the select's value). */
  function filterList(st, list) {
    return list.filter((w) => w.id === st.wfId || ((!st.tagFilter || (w.tags || []).indexOf(st.tagFilter) >= 0) && (!st.favOnly || w.favourite)));
  }
  function listFilter(st) {
    const tags = (st.tagVocab || []).map((t) => ({ value: t.tag, label: t.tag + ' (' + t.count + ')' }));
    if (st.tagFilter && !tags.some((t) => t.value === st.tagFilter)) tags.unshift({ value: st.tagFilter, label: st.tagFilter });
    return '<span class="wf-tagrow" role="group" aria-label="Filter the workflow list">' + UI.select([{ value: '', label: 'All tags' }].concat(tags), st.tagFilter || '', 'data-wftagfilter aria-label="Show workflows with the tag" style="width:auto"') + UI.btn('Favourites only', { size: 'xs', kind: st.favOnly ? '' : 'ghost', attrs: 'data-wffavonly aria-pressed="' + (st.favOnly ? 'true' : 'false') + '"' }) + '</span>';
  }
  function tagBar(st, wf, manage) {
    const row = (st.list || []).find((x) => x.id === wf.id) || {};
    const tags = wf.tags || row.tags || [];
    const fav = wf.favourite != null ? !!wf.favourite : !!row.favourite;
    return '<span class="wf-tagrow wf-tags">' + '<button type="button" class="btn sm ghost wf-star" data-wffav aria-pressed="' + (fav ? 'true' : 'false') + '" title="' + (fav ? 'Remove from your favourites' : 'Add to your favourites') + '">' + STAR + '<span>Favourite</span></button>'
      + tags.map((t) => UI.pill(t, 'outline')).join('') + (manage ? UI.btn(tags.length ? 'Edit tags' : 'Add tags', { size: 'xs', kind: 'ghost', attrs: 'data-wftags' }) : '') + '</span>';
  }

  // ---------- shortcuts ----------

  const SHORTCUTS = [
    [MOD + '+Z', 'Undo the last change to the graph'], ['Shift+' + MOD + '+Z, or Ctrl+Y', 'Redo'],
    [MOD + '+C', 'Copy the selected steps (to this browser\'s clipboard)'], [MOD + '+V', 'Paste steps, also into another workflow'], [MOD + '+D', 'Duplicate the selected steps (canvas focused)'],
    [MOD + '+A', 'Select every step (canvas focused)'], ['Shift and a click', 'Add a step to the selection, or take it out'],
    ['+ and -', 'Zoom in and out (canvas or minimap focused)'], ['0', 'Fit the graph'], [MOD + ' and the wheel', 'Zoom around the pointer'],
    ['Arrow keys', 'Move between steps (canvas); pan (minimap)'], ['Enter', 'Open the inspector (canvas); show the selected step (minimap)'], ['C', 'Start a connection from the selected step'], ['Delete', 'Remove the selected step'], ['Escape', 'Cancel a connection']
  ];
  function showShortcuts(ctx) {
    ctx.modal({ title: 'Keyboard shortcuts', body: UI.table(['Keys', 'What it does'], SHORTCUTS.map((s) => ['<span class="mono">' + esc(s[0]) + '</span>', esc(s[1])]), { clickable: false, minWidth: '0' }) + '<div class="muted" style="font-size:12px">None of them works while you type in a field. ' + MOD + '+K still opens the command palette.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) });
  }

  // ---------- events ----------

  let active = null;
  const typingIn = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color)$/i.test(el.type || '')));
  document.addEventListener('keydown', (e) => {
    if (!active || App.state.route !== 'workflows' || document.getElementById('overlay') || typingIn(e.target) || !document.querySelector('#main .wf-canvas')) return;
    const a = active;
    const mod = e.ctrlKey || e.metaKey;
    const k = (e.key || '').toLowerCase();
    const onCanvas = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.wf-scroll, .wf-viewbar, .wf-minimap'));
    if (mod && !e.altKey && k === 'k') return; // the command palette
    if (mod && !e.altKey && ((k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey && !e.metaKey))) { if (a.editable) { e.preventDefault(); a.redo(); } return; }
    if (mod && !e.altKey && k === 'z') { if (a.editable) { e.preventDefault(); a.undo(); } return; }
    if (mod && !e.altKey && k === 'c' && !e.shiftKey) { const sel = window.getSelection ? String(window.getSelection()) : ''; if (!sel && (onCanvas || document.activeElement === document.body)) { e.preventDefault(); a.copy(); } return; }
    if (mod && !e.altKey && k === 'v' && !e.shiftKey) { if (a.editable && (readClip() || a.st.clipMemory)) { e.preventDefault(); a.paste(); } return; }
    if (mod && !e.altKey && k === 'd' && onCanvas) { if (a.editable) { e.preventDefault(); a.duplicate(); } return; }
    if (mod && !e.altKey && k === 'a' && onCanvas) { e.preventDefault(); a.selectAll(); return; }
    if (!mod && !e.altKey && onCanvas) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); a.zoom(1); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); a.zoom(-1); return; }
      if (e.key === '0') { e.preventDefault(); a.fit(); }
    }
  });

  /**
   * Wires the editing controls for this render. `o`: editable, changed(msg) (the draft changed: re-validate, mark
   * unsaved, re-render), W, H (step size), cw, ch (canvas size), wf, manage, toast(html, kind).
   */
  function bind(ctx, st, o) {
    const refocus = () => { const c = ctx.$('.wf-canvas'); if (c) c.focus(); };
    const say = (html, kind) => o.toast(html, kind);
    const doUndo = () => { if (!o.editable) return; if (undo(st)) { if (o.claim) o.claim(); o.revalidate(); ctx.rerender(); say('Undone.'); } else say('Nothing to undo.'); };
    const doRedo = () => { if (!o.editable) return; if (redo(st)) { if (o.claim) o.claim(); o.revalidate(); ctx.rerender(); say('Redone.'); } else say('Nothing to redo.'); };
    const doCopy = () => { const n = copy(st, selected(st)); say(n ? 'Copied ' + n + ' step' + (n === 1 ? '' : 's') + '. Paste with ' + MOD + '+V here or in another workflow.' : 'Select a step other than the trigger to copy it.', n ? 'ok' : 'warn'); ctx.rerender(); };
    const doPaste = () => {
      if (!o.editable) return;
      const ids = paste(st, o.W, o.H);
      if (!ids.length) { say('The clipboard is empty. Copy steps first.', 'warn'); return; }
      o.changed('Pasted ' + ids.length + ' step' + (ids.length === 1 ? '' : 's') + ' with new ids. Their references are checked against this workflow.');
    };
    const doDup = () => {
      if (!o.editable) return;
      const ids = duplicate(st, selected(st), o.W, o.H);
      if (!ids.length) { say('Select a step other than the trigger to duplicate it.', 'warn'); return; }
      o.changed('Duplicated ' + ids.length + ' step' + (ids.length === 1 ? '' : 's') + '.');
    };
    const doZoom = (dir) => { zoomStep(st, dir); ctx.rerender(); refocus(); };
    const doFit = () => { fit(st, ctx.$('.wf-scroll'), o.cw, o.ch); ctx.rerender(); refocus(); };
    active = { st, editable: o.editable, undo: doUndo, redo: doRedo, copy: doCopy, paste: doPaste, duplicate: doDup, zoom: doZoom, fit: doFit, selectAll: () => { st.multi = st.draft.nodes.map((n) => n.id); ctx.rerender(); refocus(); } };

    ctx.on('click', '[data-wfundo]', doUndo);
    ctx.on('click', '[data-wfredo]', doRedo);
    ctx.on('click', '[data-wfcopy]', doCopy);
    ctx.on('click', '[data-wfpaste]', doPaste);
    ctx.on('click', '[data-wfdup]', doDup);
    ctx.on('click', '[data-wfselclear]', () => { st.multi = []; ctx.rerender(); });
    ctx.on('click', '[data-wfzoom]', (e, t) => { zoomStep(st, Number(t.dataset.wfzoom)); ctx.rerender(); });
    ctx.on('click', '[data-wfzoom1]', () => { setZoom(st, 1); ctx.rerender(); });
    ctx.on('click', '[data-wfzoomfit]', () => { fit(st, ctx.$('.wf-scroll'), o.cw, o.ch); ctx.rerender(); });
    ctx.on('click', '[data-wfkeys]', () => showShortcuts(ctx));
    bindView(ctx, st, o);

    // comments
    const node = () => st.draft && st.draft.nodes.find((x) => x.id === st.sel);
    ctx.on('click', '[data-wfcadd]', () => {
      const n = node(); const ta = ctx.$('[data-wfcomment]'); if (!n || !ta || !o.editable) return;
      const text = ta.value.trim();
      if (!text) { say('Write the comment first.', 'warn'); ta.focus(); return; }
      n.comments = (n.comments || []).concat([{ id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: text.slice(0, 2000) }]);
      o.changed('Comment added. Save the draft to keep it.');
    });
    ctx.on('click', '[data-wfcres]', (e, t) => { const n = node(); const c = n && (n.comments || []).find((x) => x.id === t.dataset.wfcres); if (!c || !o.editable) return; if (c.resolved) delete c.resolved; else c.resolved = true; o.changed(c.resolved ? 'Comment resolved.' : 'Comment reopened.'); });
    ctx.on('click', '[data-wfcdel]', async (e, t) => {
      const n = node(); if (!n || !o.editable) return;
      const ok = await ctx.confirm({ title: 'Delete the comment', tone: 'warn', body: '<p class="fg2" style="margin:0">It goes from the draft when you save. Published versions keep theirs.</p>', ok: 'Delete' });
      if (!ok) return;
      n.comments = (n.comments || []).filter((x) => x.id !== t.dataset.wfcdel);
      if (!n.comments.length) delete n.comments;
      o.changed('Comment deleted. Save the draft to keep it.');
    });

    // tags and favourites
    ctx.on('change', '[data-wftagfilter]', (e, t) => { st.tagFilter = t.value || null; ctx.rerender(); });
    ctx.on('click', '[data-wffavonly]', () => { st.favOnly = !st.favOnly; ctx.rerender(); });
    ctx.on('click', '[data-wffav]', async (e, t) => {
      const wf = o.wf; const on = t.getAttribute('aria-pressed') !== 'true';
      try {
        if (on) await App.put('/api/workflows/' + enc(wf.id) + '/favourite', {}); else await App.del('/api/workflows/' + enc(wf.id) + '/favourite');
        wf.favourite = on;
        const row = (st.list || []).find((x) => x.id === wf.id); if (row) row.favourite = on;
        ctx.rerender(); say(esc(wf.name) + (on ? ' is in your favourites.' : ' is no longer in your favourites.'), on ? 'ok' : '');
      } catch (err) { App.fail(err, 'Could not change your favourites'); }
    });
    ctx.on('click', '[data-wftags]', () => {
      const wf = o.wf; const cur = wf.tags || [];
      const vocab = (st.tagVocab || []).map((x) => x.tag);
      ctx.modal({ title: 'Tags of ' + esc(wf.name), body: UI.field('Tags', UI.input(cur.join(', '), { placeholder: 'finance, monthly', attrs: 'data-tagsin list="wf-tag-vocab" autocomplete="off"' }), 'Comma separated; lower-case letters, digits and hyphens; up to 10. Tags are the tenant\'s: everyone who can see the workflow sees them.') + '<datalist id="wf-tag-vocab">' + vocab.map((x) => '<option value="' + esc(x) + '"></option>').join('') + '</datalist>' + (vocab.length ? '<div class="muted" style="font-size:12px">In use: ' + vocab.map(esc).join(', ') + '</div>' : ''),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save tags', { kind: 'primary', attrs: 'data-go' }),
        onMount(m) {
          m.querySelector('[data-go]').addEventListener('click', async () => {
            const tags = m.querySelector('[data-tagsin]').value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
            try {
              const out = await App.put('/api/workflows/' + enc(wf.id) + '/tags', { tags });
              App.closeOverlay();
              wf.tags = out.tags;
              const row = (st.list || []).find((x) => x.id === wf.id); if (row) row.tags = out.tags;
              st.tagVocab = null; loadTags(st);
              ctx.rerender(); say('Tags saved. Audited workflow.tags.updated.', 'ok');
            } catch (err) { App.fail(err, 'Could not save the tags'); }
          });
        } });
    });
  }

  App.wfEdit = { track, commit, undo, redo, canUndo, canRedo, selected, toggle, copy, paste, duplicate, zoom, setZoom, viewBar, minimap, stepExtras, loadTags, filterList, listFilter, tagBar, bind, readClip };
})();
