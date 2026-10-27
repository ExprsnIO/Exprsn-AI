(function () {
  // Plugin UI surfaces (1.7.0, Sprint 43, B-11203; docs/decisions/plugin-ui-surfaces.md). A surface is data from a
  // plugin's manifest: blocks of text, key-value lines, a table and action buttons. The console draws them with its own
  // helpers, so no plugin code runs here; every value is escaped. Screens host a slot with
  //   '<div data-surfaces></div>' in their markup, then App.surfaces.attach(el, {slot, near, context}) after rendering.
  // Each panel is titled "<surface title> · <plugin name>". A refused data call shows a quiet note in its panel.
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const LIST_MS = 20000, DATA_MS = 10000;
  const lists = {}; const data = {};
  let seq = 0;

  /** A value by dotted path ("record.values.title"); arrays take numeric segments. */
  const at = (obj, path) => String(path || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const show = (v) => (v == null || v === '' ? '<span class="muted">none</span>' : typeof v === 'object' ? '<span class="mono">' + esc(JSON.stringify(v)) + '</span>' : esc(String(v)));
  const keyOf = (slot, near) => slot + '|' + ((near && near.app) || '') + '|' + ((near && near.entity) || '');
  const callUrl = (s, kind, call) => '/api/plugin-surfaces/' + enc(s.plugin.id) + '/' + enc(s.id) + '/' + kind + '/' + enc(call);

  function load(slot, near) {
    const k = keyOf(slot, near); const c = lists[k];
    if (c && Date.now() - c.at < LIST_MS) return c.promise;
    const q = '?slot=' + enc(slot) + (near && near.app ? '&app=' + enc(near.app) : '') + (near && near.entity ? '&entity=' + enc(near.entity) : '');
    const promise = App.get('/api/plugin-surfaces' + q).then((l) => (Array.isArray(l) ? l : [])).catch(() => []);
    lists[k] = { at: Date.now(), promise };
    return promise;
  }

  function fetchData(s, call, context, fresh) {
    const k = s.plugin.id + '/' + s.id + '/' + call + '|' + JSON.stringify(context || {});
    const c = data[k];
    if (!fresh && c && Date.now() - c.at < DATA_MS) return c.promise;
    const promise = App.post(callUrl(s, 'data', call), { context: context || {} }).then((v) => ({ ok: true, v }), (err) => ({ ok: false, err }));
    data[k] = { at: Date.now(), promise };
    return promise;
  }

  function blockHtml(b, i) {
    if (b.type === 'text') return '<p class="fg2" style="margin:0;font-size:13px">' + esc(b.text) + '</p>';
    if (b.type === 'action') return '<div>' + UI.btn(b.label, { size: 'sm', attrs: 'data-psaction="' + esc(b.action) + '" data-psconfirm="' + esc(b.confirm || '') + '"' }) + '</div>';
    return '<div data-psblock="' + i + '" aria-live="polite"><span class="muted psurf-wait">Reading…</span></div>';
  }

  function render(list) {
    return list.map((s) => {
      const id = 'psurf-' + (++seq);
      return '<section class="panel psurf" data-psurf="' + esc(s.plugin.id + '/' + s.id) + '" aria-labelledby="' + id + '">'
        + '<div class="phead"><div class="eyebrow" id="' + id + '">' + esc(s.title) + ' · ' + esc(s.plugin.name) + '</div></div>'
        + (s.description ? '<p class="muted" style="margin:0;font-size:12px">' + esc(s.description) + '</p>' : '')
        + (s.blocks || []).map(blockHtml).join('') + '</section>';
    }).join('');
  }

  /** A kv or table block filled from its data call's answer. */
  function draw(host, b, v) {
    if (b.type === 'kv') host.innerHTML = UI.kv((b.items || []).map((it) => [it.label, show(at(v, it.path))]), 1);
    else {
      const rows = at(v, b.rows);
      host.innerHTML = UI.table((b.columns || []).map((c) => c.label), (Array.isArray(rows) ? rows : []).map((row) => (b.columns || []).map((c) => show(at(row, c.path)))), { clickable: false, minWidth: '0', emptyTitle: 'Nothing to show', emptyText: 'The plugin returned no rows.' });
    }
  }

  function fill(section, s, context, fresh) {
    (s.blocks || []).forEach((b, i) => {
      if (b.type !== 'kv' && b.type !== 'table') return;
      const host = section.querySelector('[data-psblock="' + i + '"]'); if (!host) return;
      fetchData(s, b.data, context, fresh).then((r) => {
        if (!host.isConnected) return;
        if (!r.ok) { host.innerHTML = UI.notice(r.err && (r.err.status === 403 || r.err.status === 404) ? 'This panel has nothing to show you here.' : 'This panel could not be read just now.', 'info'); return; }
        draw(host, b, r.v);
      });
    });
  }

  function wire(section, s, context) {
    section.querySelectorAll('[data-psaction]').forEach((btn) => btn.addEventListener('click', async () => {
      const call = btn.dataset.psaction; const ask = btn.dataset.psconfirm;
      const ok = await App.confirm({ title: btn.textContent.trim(), tag: s.plugin.name, tone: 'info', body: '<p class="fg2" style="margin:0">' + esc(ask || 'The plugin ' + s.plugin.name + ' does this as you.') + '</p>', ok: btn.textContent.trim() });
      if (!ok) return;
      try {
        await App.post(callUrl(s, 'actions', call), { context: context || {} });
        App.toast('Done by ' + esc(s.plugin.name) + '. Audited plugin.surface.action.', 'ok');
        if (section.isConnected) fill(section, s, context, true);
      } catch (err) { App.fail(err, 'The plugin could not do that'); }
    }));
  }

  /** Draws the slot's surfaces into el; el stays empty when there are none. */
  function attach(el, opts) {
    if (!el) return Promise.resolve([]);
    return load(opts.slot, opts.near).then((all) => {
      const list = opts.filter ? all.filter(opts.filter) : all;
      if (!el.isConnected) return list;
      el.innerHTML = list.length ? render(list) : '';
      el.style.display = list.length ? '' : 'none';
      list.forEach((s) => {
        const section = el.querySelector('[data-psurf="' + CSS.escape(s.plugin.id + '/' + s.id) + '"]'); if (!section) return;
        fill(section, s, opts.context, false);
        wire(section, s, opts.context);
      });
      return list;
    });
  }

  /**
   * 1.8.0 (B-147): one surface of a manifest being written, drawn by this same renderer with sample answers for its
   * data calls (`sample[dataId]`), for the plugin creator's live preview. Nothing is called; action buttons only say
   * what they would do.
   */
  function preview(el, def, sample, pluginName) {
    if (!el) return;
    const surf = { plugin: { id: 'preview', name: pluginName || 'Preview' }, id: def.id || 'preview', title: def.title || 'Untitled surface', description: def.description || null, blocks: Array.isArray(def.blocks) ? def.blocks.filter((b) => b && typeof b === 'object') : [] };
    el.innerHTML = render([surf]);
    const section = el.querySelector('[data-psurf]'); if (!section) return;
    surf.blocks.forEach((b, i) => {
      if (b.type !== 'kv' && b.type !== 'table') return;
      const host = section.querySelector('[data-psblock="' + i + '"]'); if (!host) return;
      draw(host, b, (sample || {})[b.data]);
    });
    section.querySelectorAll('[data-psaction]').forEach((btn) => btn.addEventListener('click', () => App.toast('Preview only: once installed, approved and enabled, this button runs the action ' + esc(btn.dataset.psaction) + ' as the viewer' + (btn.dataset.psconfirm ? ', after asking "' + esc(btn.dataset.psconfirm) + '"' : '') + '.', '', 4000)));
  }

  /** Forgets what was read, so the next attach asks the server again (after an approval or a disable). */
  function reset() { Object.keys(lists).forEach((k) => delete lists[k]); Object.keys(data).forEach((k) => delete data[k]); }

  App.surfaces = { load, render, attach, reset, preview };
})();
