// Apps, the Board view of the Records tab (the exprsn-platform low-code port, docs/decisions/lowcode-port.md): an
// entity's records as cards in one column per state of its state machine, or per option of an indexed enum or static
// lookup field. Each column is paged on the server (POST .../records/board, follow-up 4): the first cards of every
// column with its count, then "Load more" per column from that column's cursor. A card moves with its "Move to" menu
// (or by dragging it): a state move is a transition (refused with 409 when the record's state does not allow it), a
// field move a versioned update. `apps.js` calls App.appsBoard(ctx, app, ent, deps) for the view's markup; the state
// lives in ctx.state.board.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const PER_COLUMN = 25;
  const CSS = '#main .apps-board{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;align-items:flex-start;min-width:0}#main .apps-board:focus-visible{outline:2px solid var(--accent)}'
    + '#main .apps-col{flex:0 0 240px;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:8px}#main .apps-col.drop{box-shadow:0 0 0 2px var(--accent)}'
    + '#main .apps-colhead{display:flex;align-items:center;gap:6px;font-weight:600;overflow-wrap:anywhere}#main .apps-card{background:var(--panel);border:1px solid var(--line2);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:4px;min-width:0}'
    + '#main .apps-card.sel{box-shadow:0 0 0 2px var(--accent)}#main .apps-card .ttl{all:unset;cursor:pointer;font-weight:600;overflow-wrap:anywhere;color:var(--fg)}#main .apps-card .ttl:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'
    + '#main .apps-card .kv{font-size:12px;color:var(--fg2);overflow-wrap:anywhere}#main .apps-card select{font-size:12px}';

  const optionsOf = (f) => (f.type === 'enum' ? f.options || [] : f.type === 'lookup' && f.source === 'static' ? f.options || [] : null);

  /** What a board can group by: the state machine, and indexed enum fields and static lookups (the server pages on them). */
  function groupings(ent) {
    const out = [];
    const sm = ent.definition && ent.definition.states;
    if (sm) out.push({ value: '@state', label: 'State' });
    (ent.definition.fields || []).forEach((f) => { if (optionsOf(f) && (f.indexed || f.unique)) out.push({ value: f.name, label: f.title || f.name }); });
    return out;
  }
  /** Enum and static-lookup fields a designer could index to group by them. */
  const unindexed = (ent) => (ent.definition.fields || []).filter((f) => optionsOf(f) && !f.indexed && !f.unique);
  App.appsBoardGroupings = groupings;

  App.appsBoard = function (ctx, app, ent, deps) {
    const st = ctx.state;
    const groups = groupings(ent);
    const missing = unindexed(ent);
    const hint = missing.length ? 'Mark ' + missing.map((f) => f.title || f.name).join(', ') + ' indexed on the Entities tab to group by ' + (missing.length === 1 ? 'it' : 'them') + '.' : '';
    if (!groups.length) return UI.empty('Nothing to group by', 'A board needs a state machine, or an indexed enum field or static lookup on ' + (ent.title || ent.name) + '. ' + (hint || 'Add one on the Entities tab, or use the table.'));
    st.boardBy = st.boardBy || {};
    if (!groups.some((g) => g.value === st.boardBy[ent.id])) st.boardBy[ent.id] = groups[0].value;
    const by = groups.find((g) => g.value === st.boardBy[ent.id]);
    const sm = ent.definition.states;
    const base = '/api/apps/' + enc(app.id) + '/entities/' + enc(ent.id) + '/records';
    const body = { by: by.value, limit: PER_COLUMN };
    if (deps.filter) body.filter = deps.filter;
    if (deps.q) body.q = deps.q;
    if (deps.sorts && deps.sorts.length) body.sort = deps.sorts;
    const key = ent.id + ':' + JSON.stringify(body);
    const b = st.board || (st.board = {});
    if (b.key !== key && b.busy !== key) {
      b.busy = key; const seq = b.seq = (b.seq || 0) + 1;
      App.post(base + '/board', body).then((d) => { if (b.seq !== seq) return; b.data = d; b.key = key; b.error = null; b.more = {}; }).catch((err) => { if (b.seq !== seq) return; b.error = err; b.key = key; }).finally(() => { if (b.seq === seq) b.busy = null; deps.refresh(); });
    }
    const data = b.key === key ? b.data : null;
    const canWrite = App.can('records:write');
    const shown = (ent.definition.fields || []).filter((f) => f.type !== 'json' && f.name !== by.value);
    const titleField = shown.find((f) => f.type === 'string' && (f.indexed || f.unique)) || shown.find((f) => f.type === 'string') || null;
    const extra = shown.filter((f) => f !== titleField).slice(0, 2);
    const colKey = (v) => (v == null ? '' : String(v));
    const keyOf = (r) => (by.value === '@state' ? r.state || '' : r.values[by.value] == null ? '' : String(r.values[by.value]));
    const allowed = (r) => (sm ? sm.transitions.filter((t) => t.from.indexOf('*') >= 0 || t.from.indexOf(r.state) >= 0).map((t) => t.to) : []);

    let html = '<style>' + CSS + '</style><div class="hstack wrap gap6">' + UI.field('Group by', UI.select(groups.map((g) => ({ value: g.value, label: g.label })), by.value, 'data-boardby'), '') + '<span class="muted" style="font-size:12px">' + (by.value === '@state' ? 'Moving a card makes a transition; only the moves the record\'s state allows are offered.' : 'Moving a card sets ' + esc(by.label) + ', guarded by the record\'s version.') + (hint ? ' ' + esc(hint) : '') + '</span></div>';
    if (b.error && b.key === key) return html + UI.problem('The board could not be loaded', deps.detailOf(b.error), deps.traceOf(b.error)) + '<div>' + UI.btn('Try again', { attrs: 'data-boardreload' }) + '</div>';
    if (!data) return html + UI.notice('Loading…', 'info');
    const cols = data.columns;
    const all = [];
    cols.forEach((c) => c.records.forEach((r) => all.push(r)));
    const labelOf = (v) => { const c = cols.find((x) => colKey(x.value) === v); return c ? c.label : v || 'No value'; };
    const card = (r) => {
      const k = keyOf(r);
      const moves = by.value === '@state' ? allowed(r).filter((x) => x !== k) : cols.map((c) => colKey(c.value)).filter((v) => v !== k);
      const title = titleField && r.values[titleField.name] != null && r.values[titleField.name] !== '' ? String(r.values[titleField.name]) : r.id.slice(-8);
      return '<div class="apps-card' + (st.record === r.id ? ' sel' : '') + '" data-bcard="' + esc(r.id) + '"' + (canWrite && moves.length ? ' draggable="true"' : '') + '>'
        + '<button type="button" class="ttl" data-bopen="' + esc(r.id) + '" aria-label="Open record ' + esc(title) + '">' + esc(title) + '</button>'
        + extra.map((f) => (r.values[f.name] == null || r.values[f.name] === '' ? '' : '<div class="kv">' + esc(f.title || f.name) + ': ' + esc(String(r.values[f.name])) + '</div>')).join('')
        + '<div class="kv">' + UI.label(r.label, { sm: true }) + ' <span class="num">v' + r.version + '</span></div>'
        + (canWrite && moves.length ? '<label class="sr" for="bm-' + esc(r.id) + '">Move ' + esc(title) + ' to</label><select class="select" id="bm-' + esc(r.id) + '" data-bmove="' + esc(r.id) + '"><option value="">Move to…</option>' + moves.map((v) => '<option value="' + esc(v) + '">' + esc(labelOf(v)) + '</option>').join('') + '</select>' : '')
        + '</div>';
    };
    html += '<div class="apps-board" data-scroll-x tabindex="0" role="region" aria-label="Board of ' + esc(ent.title || ent.name) + ' by ' + esc(by.label) + '">'
      + cols.map((c, i) => {
        const label = c.label || 'No value';
        const n = c.records.length;
        const more = c.nextCursor || (!c.loaded && c.total > n);
        const busy = b.more && b.more[i];
        return '<section class="apps-col" data-bcol="' + esc(colKey(c.value)) + '" aria-label="' + esc(label) + ', ' + c.total + ' records">'
          + '<div class="apps-colhead"><span class="grow">' + esc(label) + '</span>' + UI.pill(n < c.total ? n + ' of ' + c.total : String(c.total), 'outline') + '</div>'
          + (c.records.map(card).join('') || (c.total ? '' : '<div class="muted" style="font-size:12px">No records</div>'))
          + (more ? UI.btn(busy ? 'Loading…' : 'Load more', { size: 'xs', attrs: 'data-bmore="' + i + '" aria-label="' + esc('Load more ' + label + ' records, ' + n + ' of ' + c.total + ' shown') + '"', disabled: !!busy }) : '')
          + '</section>';
      }).join('')
      + '</div><span class="muted" style="font-size:12px">' + data.total + ' matching records; each column shows ' + PER_COLUMN + ' at a time, in the table\'s sort order.</span>';

    // ----- events -----
    const loadMore = async (i) => {
      const c = cols[i]; if (!c || (b.more && b.more[i])) return;
      b.more = b.more || {}; b.more[i] = true; ctx.rerender();
      const req = Object.assign({}, body, { columns: [Object.assign({ value: c.value }, c.nextCursor ? { cursor: c.nextCursor } : {})] });
      try {
        const d = await App.post(base + '/board', req);
        if (b.key !== key) return;
        const got = d.columns[0];
        const have = {}; c.records.forEach((r) => { have[r.id] = true; });
        c.records = c.records.concat(got.records.filter((r) => !have[r.id])); c.nextCursor = got.nextCursor; c.loaded = true; c.total = got.total;
      } catch (err) { App.fail(err, 'More cards could not be loaded'); }
      finally { if (b.more) b.more[i] = false; ctx.rerender(); const el = ctx.$('[data-bmore="' + i + '"]') || ctx.$('[data-bcol="' + colKey(c.value) + '"] .apps-card:last-of-type [data-bopen]'); if (el) el.focus(); }
    };
    const move = async (id, to) => {
      const r = all.find((x) => x.id === id); if (!r || to === keyOf(r)) return;
      const rec = base + '/' + enc(id);
      try {
        let out;
        if (by.value === '@state') out = await App.post(rec + '/transition', { to, version: r.version });
        else { const values = {}; values[by.value] = to === '' ? null : to; out = await App.patch(rec, { values, version: r.version }); }
        st.board = {}; deps.invalidate(); st.record = id; st.recordObj = out; ctx.rerender();
        const el = ctx.$('[data-bopen="' + id + '"]'); if (el) el.focus();
        ctx.toast(by.value === '@state' ? esc(id.slice(-8)) + ' is now ' + esc(out.state) + '. Audited app.record.transitioned; event record.transitioned.' : esc(id.slice(-8)) + ' moved to ' + esc(to || 'no value') + ' at version ' + out.version + '. Audited app.record.updated.', 'ok', 4500);
      } catch (err) {
        const p = err.problem || {};
        if (err.status === 409) { st.problem = { kind: p.allowed ? 'illegal' : 'stale', title: p.title || 'Refused', text: deps.detailOf(err) + (p.allowed ? ' Allowed: ' + JSON.stringify(p.allowed) + '.' : ' Reload the board and try again.'), trace: deps.traceOf(err) }; st.record = id; st.board = {}; ctx.rerender(); }
        else App.fail(err, 'The card was not moved');
      }
    };
    ctx.on('change', '[data-boardby]', (e, t) => { st.boardBy[ent.id] = t.value; ctx.rerender(); const el = ctx.$('[data-boardby]'); if (el) el.focus(); });
    ctx.on('click', '[data-boardreload]', () => { st.board = {}; ctx.rerender(); });
    ctx.on('click', '[data-bmore]', (e, t) => { loadMore(+t.dataset.bmore); });
    ctx.on('click', '[data-bopen]', (e, t) => { st.record = t.dataset.bopen; ctx.rerender(); const el = ctx.$('[data-bopen="' + t.dataset.bopen + '"]'); if (el) el.focus(); });
    ctx.on('change', '[data-bmove]', (e, t) => { if (t.value === '' && t.selectedIndex === 0) return; move(t.dataset.bmove, t.value); });
    ctx.on('dragstart', '[data-bcard]', (e, t) => { if (e.dataTransfer) { e.dataTransfer.setData('text/plain', t.dataset.bcard); e.dataTransfer.effectAllowed = 'move'; } });
    ctx.on('dragover', '[data-bcol]', (e, t) => { e.preventDefault(); t.classList.add('drop'); });
    ctx.on('dragleave', '[data-bcol]', (e, t) => { t.classList.remove('drop'); });
    ctx.on('drop', '[data-bcol]', (e, t) => { e.preventDefault(); t.classList.remove('drop'); const id = e.dataTransfer ? e.dataTransfer.getData('text/plain') : ''; if (!id) return; const r = all.find((x) => x.id === id); if (!r) return; const to = t.dataset.bcol; if (by.value === '@state' && allowed(r).indexOf(to) < 0) { ctx.toast('The record\'s state ' + esc(r.state || 'none') + ' does not allow a move to ' + esc(to) + '.', 'warn'); return; } move(id, to); });
    return html;
  };
})();
