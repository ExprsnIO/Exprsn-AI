(function () {
  // 1.8.0, Sprint 48 (B-148): the Overview's cards, arranged by each admin (GET, PUT and DELETE
  // /api/admin/overview-cards, the optional cards' figures from /api/admin/overview-cards/data). overview.js hands its
  // parts to App.overviewCards.arrange as named cards and draws what comes back; the server decides which cards a
  // person may see, so a card they lack the permission for is never listed, drawn or computed. "Customise cards"
  // pins, hides and reorders (Move up and Move down buttons, or drag), picks the density and resets.
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const OPTIONAL = ['workflows-running', 'sla-breaching', 'approvals-pending', 'revisions-waiting', 'moderation-trends'];
  /** Cards drawn side by side in a grid when they follow each other. */
  const SMALL = ['schedules', 'audit', 'capacity'].concat(OPTIONAL);
  const SLA_ROUTE = { flag: 'flags', 'channel-session': 'channels', 'held-write': 'moderation', appeal: 'moderation' };
  const SLA_WORDS = { flag: 'Flags', 'channel-session': 'Channel sessions', 'held-write': 'Held writes', appeal: 'Appeals' };
  const num = (n) => String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const CSS = '#main .ovc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--ovc-gap,16px);flex-shrink:0}#main .ovc{flex-shrink:0;min-width:0}'
    + '#main .ovc-compact{--ovc-gap:8px}#main .ovc-compact .page,#main .page.ovc-compact{gap:10px}#main .ovc-compact .panel{padding:10px 12px;gap:6px}#main .ovc-compact .stat{padding:8px 10px}#main .ovc-compact .stats{gap:8px}'
    + '#main .ovc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}#main .ovc-item{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--line);border-radius:6px;padding:6px 8px;background:var(--panel)}#main .ovc-item.drag{opacity:.5}#main .ovc-item .grow{min-width:120px}';

  /** Loads the layout and the figures of the optional cards it shows; calls back when done (also on failure). */
  function load(st, done) {
    if (st.cardsLoading) return;
    st.cardsLoading = true;
    App.get('/api/admin/overview-cards')
      .then((layout) => {
        st.cards = layout; st.cardsError = null;
        const want = layout.visible.filter((id) => OPTIONAL.indexOf(id) >= 0);
        return want.length ? App.get('/api/admin/overview-cards/data?cards=' + enc(want.join(','))).then((d) => { st.cardData = d; }) : (st.cardData = {});
      })
      .catch((err) => { st.cardsError = err; })
      .finally(() => { st.cardsLoading = false; st.cardsLoaded = true; done(); });
  }

  /** The optional cards, drawn from their figures. */
  function optionalCard(id, d) {
    if (!d) return UI.panel(titleOf(id), '<div class="muted" style="font-size:12px" role="status">Reading…</div>');
    if (d.error) return UI.panel(titleOf(id), UI.notice(esc(d.error), 'info'));
    if (id === 'workflows-running') return UI.panel('Running workflows', '<div class="stats">' + UI.stat(num(d.running), 'Running', 'now') + UI.stat(num(d.waiting), 'Waiting', 'on an approval or a step') + '</div>'
      + (d.items.length ? '<ul class="ovc-list">' + d.items.map((r) => '<li class="hstack" style="font-size:12px"><span class="grow">' + esc(r.workflow || 'Workflow') + '</span>' + UI.pill(r.state, r.state === 'waiting' ? 'warn' : 'info') + '</li>').join('') + '</ul>' : '<div class="muted" style="font-size:12px">Nothing is running at or below your clearance.</div>'), { actions: UI.btn('Workflows', { size: 'xs', kind: 'ghost', attrs: 'data-go="workflows"' }) });
    if (id === 'sla-breaching') return UI.panel('SLA breaching soon', '<div class="stats">' + UI.stat('<span' + (d.breached ? ' style="color:var(--danger-fg)"' : '') + '>' + num(d.breached) + '</span>', 'Breached', 'past a target') + UI.stat(num(d.warning), 'Due soon', 'in the warning band') + '</div>'
      + (d.byType.length ? '<ul class="ovc-list">' + d.byType.map((t) => '<li class="hstack" style="font-size:12px"><span class="grow">' + esc(SLA_WORDS[t.type] || t.type) + '</span><span class="num">' + num(t.breached) + ' breached, ' + num(t.warning) + ' due soon</span>' + UI.btn('Open', { size: 'xs', kind: 'ghost', attrs: 'data-go="' + esc(SLA_ROUTE[t.type] || 'flags') + '" aria-label="Open ' + esc(SLA_WORDS[t.type] || t.type) + '"' }) + '</li>').join('') + '</ul>' : ''));
    if (id === 'approvals-pending') return UI.panel('Pending approvals', '<div class="stats">' + UI.stat(num(d.count), 'Waiting for you', 'workflow approvals you may decide') + '</div>'
      + (d.items.length ? '<ul class="ovc-list">' + d.items.map((a) => '<li style="font-size:12px">' + esc(a.workflow || 'Workflow') + ': ' + esc(a.step) + '</li>').join('') + '</ul>' : ''), { actions: UI.btn('Workflows', { size: 'xs', kind: 'ghost', attrs: 'data-go="workflows"' }) });
    if (id === 'moderation-trends') return App.modSpam ? App.modSpam.trendCard(d) : ''; // 1.9.0 (B-158), moderation-spam.js
    if (id === 'revisions-waiting') return UI.panel('Revisions waiting', '<div class="stats">' + UI.stat(num(d.count), 'In review', num(d.decidable) + ' you may decide') + '</div>'
      + (d.items.length ? '<ul class="ovc-list">' + d.items.map((r) => '<li style="font-size:12px">' + esc(r.title) + ' ' + esc(r.version) + ' <span class="muted">' + esc(r.kb) + '</span></li>').join('') + '</ul>' : ''), { actions: UI.btn('Knowledge', { size: 'xs', kind: 'ghost', attrs: 'data-go="knowledge"' }) });
    return '';
  }

  const titleOf = (id) => ({ 'workflows-running': 'Running workflows', 'sla-breaching': 'SLA breaching soon', 'approvals-pending': 'Pending approvals', 'revisions-waiting': 'Revisions waiting', 'moderation-trends': 'Moderation trends' })[id] || id;

  /**
   * The page's cards in the person's order: `sections` maps a card id to its markup (overview.js draws the built-in
   * ones); optional cards are drawn here. Without a layout yet, every built-in section in its usual order.
   */
  function arrange(st, sections, fallbackOrder) {
    const layout = st.cards;
    const ids = layout ? layout.visible : fallbackOrder;
    const html = [];
    let group = [];
    const flush = () => { if (group.length) html.push('<div class="ovc-grid">' + group.join('') + '</div>'); group = []; };
    ids.forEach((id) => {
      const part = OPTIONAL.indexOf(id) >= 0 ? optionalCard(id, (st.cardData || {})[id]) : sections[id];
      if (!part) return;
      const wrapped = '<div class="ovc" data-card="' + esc(id) + '">' + part + '</div>';
      if (SMALL.indexOf(id) >= 0) group.push(wrapped);
      else { flush(); html.push(wrapped); }
    });
    flush();
    return html.join('');
  }

  /** The Customise dialog: show, pin, order (Move up and down, or drag), density, reset. */
  function customise(ctx, st, after) {
    const layout = st.cards;
    if (!layout) { ctx.toast(st.cardsError ? 'The card layout could not be read: ' + esc(st.cardsError.message) : 'The card layout is still loading.', 'warn'); return; }
    const draft = { cards: layout.cards.map((c) => Object.assign({}, c)), density: layout.density };
    const list = () => '<ul class="ovc-list" data-ovclist aria-label="Cards, in order">' + draft.cards.map((c, i) => '<li class="ovc-item" draggable="true" data-ovcrow="' + i + '"><span class="grow"><b>' + esc(c.title) + '</b>' + (c.optional ? ' <span class="muted" style="font-size:11px">optional</span>' : '') + '<div class="muted" style="font-size:11px">' + esc(c.description) + '</div></span>'
      + UI.check('Show', !c.hidden, 'data-ovcshow="' + i + '" aria-label="Show ' + esc(c.title) + '"') + UI.check('Pin', c.pinned, 'data-ovcpin="' + i + '" aria-label="Pin ' + esc(c.title) + ' to the top"')
      + UI.btn('Move up', { size: 'xs', kind: 'ghost', attrs: 'data-ovcup="' + i + '" aria-label="Move ' + esc(c.title) + ' up"', disabled: i === 0 }) + UI.btn('Move down', { size: 'xs', kind: 'ghost', attrs: 'data-ovcdown="' + i + '" aria-label="Move ' + esc(c.title) + ' down"', disabled: i === draft.cards.length - 1 }) + '</li>').join('') + '</ul>';
    ctx.modal({
      title: 'Customise your Overview', cls: 'wide',
      body: '<p class="fg2" style="margin:0;font-size:13px">Your layout is yours alone and follows you to every browser. Pinned cards come first; cards you may not see are not listed. Reorder with Move up and Move down, or drag a row.</p>'
        + UI.field('Density', UI.select([{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }], draft.density, 'data-ovcdensity')) + '<div data-ovchost>' + list() + '</div><div data-err role="alert"></div>',
      actions: UI.btn('Reset to default', { kind: 'ghost', attrs: 'data-ovcreset' }) + UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-ovcsave' }),
      onMount(m) {
        const host = m.querySelector('[data-ovchost]');
        let dragFrom = null;
        const redraw = (focusSel) => { host.innerHTML = list(); wire(); if (focusSel) { const el = host.querySelector(focusSel); if (el && !el.disabled) el.focus(); else { const r = host.querySelector(focusSel.replace(/data-ovc(up|down)/, 'data-ovcshow')); if (r) r.focus(); } } };
        const move = (i, j, focusSel) => { if (j < 0 || j >= draft.cards.length) return; const x = draft.cards.splice(i, 1)[0]; draft.cards.splice(j, 0, x); redraw(focusSel); };
        function wire() {
          host.querySelectorAll('[data-ovcup]').forEach((b) => b.addEventListener('click', () => { const i = Number(b.dataset.ovcup); move(i, i - 1, '[data-ovcup="' + (i - 1) + '"]'); }));
          host.querySelectorAll('[data-ovcdown]').forEach((b) => b.addEventListener('click', () => { const i = Number(b.dataset.ovcdown); move(i, i + 1, '[data-ovcdown="' + (i + 1) + '"]'); }));
          host.querySelectorAll('[data-ovcshow]').forEach((b) => b.addEventListener('change', () => { draft.cards[Number(b.dataset.ovcshow)].hidden = !b.checked; }));
          host.querySelectorAll('[data-ovcpin]').forEach((b) => b.addEventListener('change', () => { draft.cards[Number(b.dataset.ovcpin)].pinned = b.checked; }));
          host.querySelectorAll('[data-ovcrow]').forEach((row) => {
            row.addEventListener('dragstart', (e) => { dragFrom = Number(row.dataset.ovcrow); row.classList.add('drag'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (err) { /* no data transfer */ } });
            row.addEventListener('dragend', () => row.classList.remove('drag'));
            row.addEventListener('dragover', (e) => { e.preventDefault(); });
            row.addEventListener('drop', (e) => { e.preventDefault(); const to = Number(row.dataset.ovcrow); if (dragFrom != null && dragFrom !== to) move(dragFrom, to); dragFrom = null; });
          });
        }
        wire();
        m.querySelector('[data-ovcdensity]').addEventListener('change', (e) => { draft.density = e.target.value; });
        const fail = (err) => { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Not saved') + '.</b> ' + esc(err.message), 'danger'); };
        m.querySelector('[data-ovcsave]').addEventListener('click', async () => {
          // Pinned cards keep their place in the order; the server puts them first.
          const body = { order: draft.cards.map((c) => c.id), pinned: draft.cards.filter((c) => c.pinned).map((c) => c.id), hidden: draft.cards.filter((c) => c.hidden).map((c) => c.id), density: draft.density };
          try { st.cards = await App.put('/api/admin/overview-cards', body); App.closeOverlay(); ctx.toast('Your Overview layout is saved. Audit event written.', 'ok'); st.cardsLoaded = false; after(); } catch (err) { fail(err); }
        });
        m.querySelector('[data-ovcreset]').addEventListener('click', async () => {
          try { st.cards = await App.del('/api/admin/overview-cards'); App.closeOverlay(); ctx.toast('Your Overview is back to the default layout.', 'ok'); st.cardsLoaded = false; after(); } catch (err) { fail(err); }
        });
      }
    });
  }

  App.overviewCards = { load, arrange, customise, CSS, OPTIONAL };
})();
