// Apps, relations and back-references (1.8.0, Sprint 45, B-128): the "Related records" panels of the record inspector
// (a list per relation with paging, an add-link picker that searches the other entity through the reader's own
// access, remove, and Move up / Move down for a relation's own links), the relation column of the Records table
// (linked titles, then +N), the relation field editor of the entity designer (target, cardinality, back-reference,
// two-way, symmetric, on delete, max) and the multi-select a new record's relations are first set with.
//
// `apps.js` calls these hooks when they are there. Every list and count comes from the server, which leaves out links
// whose other end the reader may not read. State lives in ctx.state.rel.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const PAGE = 5;
  const CSS = '#main .apps-rel{display:flex;flex-direction:column;gap:6px;min-width:0;flex-shrink:0;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}'
    + '#main .apps-rel .apps-relh{margin:0;font-size:13px;font-weight:600;color:var(--fg);overflow-wrap:anywhere}'
    + '#main .apps-rellist{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}'
    + '#main .apps-rellist li{display:flex;align-items:center;gap:4px;min-width:0}#main .apps-rellist li .grow{min-width:0;overflow-wrap:anywhere}'
    + '#main .apps-relcell{overflow-wrap:anywhere}#main .apps-relpick{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;max-height:260px;overflow:auto}'
    + '#main .apps-relpick li{display:flex;align-items:center;gap:6px;min-width:0}#main .apps-relpick li span{flex:1;min-width:0;overflow-wrap:anywhere}'
    + '.modal .apps-relpick{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;max-height:260px;overflow:auto}.modal .apps-relpick li{display:flex;align-items:center;gap:6px;min-width:0}.modal .apps-relpick li span{flex:1;min-width:0;overflow-wrap:anywhere}';

  const E = (app, ent) => '/api/apps/' + enc(app.id) + '/entities/' + enc(ent.id);
  const relOf = (st) => st.rel || (st.rel = { ends: {}, busyEnds: {}, pages: {}, busy: {}, errors: {} });
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Request failed';
  const titleField = (ent) => { const d = (ent && ent.definition) || {}; return d.titleField || ((d.fields || []).find((f) => f.type === 'string') || {}).name || null; };
  const titleOf = (ent, r) => { const t = titleField(ent); const v = t && r.values ? r.values[t] : null; return v == null || v === '' ? r.id : String(v); };

  /** The relation ends of an entity (its relations and the back-references declared on others), loaded once per design. */
  function endsOf(ctx, app, ent) {
    const st = ctx.state; const rel = relOf(st); const key = ent.id + ':' + ent.rev + ':' + app.entities.map((e) => e.rev).join(',');
    const have = rel.ends[ent.id];
    if (have && have.key === key) return have.list;
    if (!rel.busyEnds[key]) {
      rel.busyEnds[key] = true;
      App.get(E(app, ent) + '/relations').then((r) => { rel.ends[ent.id] = { key, list: r.relations }; }).catch((err) => { rel.ends[ent.id] = { key, list: [], error: detailOf(err) }; }).finally(() => { delete rel.busyEnds[key]; if (st.refresh) st.refresh(); });
    }
    return have ? have.list : null;
  }

  /** The Records table cell of a relation: the linked titles the reader may see, then +N for the rest. */
  App.appsRelationCell = function (r, f) {
    const l = r.links && r.links[f.name];
    if (!l) return '<span class="muted">not shown</span>';
    if (!l.total) return '<span class="muted">none</span>';
    const more = l.total - l.records.length;
    return '<span class="apps-relcell">' + l.records.map((x) => esc(x.title || x.id)).join(', ') + (more > 0 ? ' ' + UI.pill('+' + more, 'outline') + '<span class="sr"> more linked</span>' : '') + '</span>';
  };

  /** Relation names a Records filter may use: each relation, and its number of links. */
  App.appsRelationFilterFields = function (ctx, app, ent) {
    const ends = endsOf(ctx, app, ent) || ((ent.definition && ent.definition.fields) || []).filter((f) => f.type === 'relation').map((f) => ({ name: f.name, kind: 'relation' }));
    return ends.filter((e) => e.kind === 'relation').flatMap((e) => [e.name, e.name + '.count']);
  };

  /** `region eq emea` (or `region:eq:emea`) as the where of a matches filter; null when it does not read. */
  App.appsRelationWhere = function (raw) {
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*[: ]\s*(eq|ne|gt|gte|lt|lte|contains|startsWith|exists)\s*[: ]?\s*(.*)$/.exec(String(raw || ''));
    if (!m) return null;
    const v = m[3].trim(); const typed = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
    return m[2] === 'exists' ? { field: m[1], op: 'exists' } : v === '' ? null : { field: m[1], op: m[2], value: typed };
  };

  // ---------- the inspector's Related records ----------

  function pageOf(ctx, app, ent, rec, end) {
    const st = ctx.state; const rel = relOf(st); const key = rec.id + ':' + end.name;
    const p = rel.pages[key] || (rel.pages[key] = { offset: 0, data: null, url: null });
    const url = E(app, ent) + '/records/' + enc(rec.id) + '/links/' + enc(end.name) + '?limit=' + PAGE + '&offset=' + p.offset;
    if (p.url !== url && !rel.busy[url]) {
      rel.busy[url] = true;
      App.get(url).then((d) => { p.data = d; p.url = url; p.error = null; }).catch((err) => { p.data = null; p.url = url; p.error = err; }).finally(() => { delete rel.busy[url]; if (st.refresh) st.refresh(); });
    }
    return p;
  }
  const reload = (ctx, rec, name) => { const rel = relOf(ctx.state); Object.keys(rel.pages).forEach((k) => { if (!name || k === rec.id + ':' + name || k.endsWith(':' + name)) rel.pages[k].url = null; }); };

  App.appsRelationsPanel = function (ctx, app, ent, rec, deps) {
    const st = ctx.state; const canWrite = !!(deps && deps.canWrite);
    const ends = endsOf(ctx, app, ent);
    if (ends === null) return '<div class="muted" style="font-size:12px">Loading related records…</div>';
    if (!ends.length) return '';
    const other = (name) => app.entities.find((e) => e.name === name);
    const panels = ends.map((end) => {
      const p = pageOf(ctx, app, ent, rec, end); const d = p.data; const hid = 'apps-relh-' + end.name;
      const kind = end.kind === 'reference' ? 'one-to-many, read-only' : end.side === 'inverse' ? (end.editable ? 'back-reference, two-way' : 'back-reference, read-only') : 'many-to-many' + (end.symmetric ? ', symmetric' : '');
      let body;
      if (p.error && p.error.status === 403) body = '<div class="muted" style="font-size:12px">A policy does not let you read ' + esc(end.title) + '.</div>';
      else if (p.error) body = UI.notice(esc(detailOf(p.error)), 'danger');
      else if (!d) body = '<div class="muted" style="font-size:12px">Loading…</div>';
      else {
        const movable = canWrite && end.editable && end.side === 'forward' && end.kind === 'relation';
        const items = d.records.map((r, i) => '<li><a class="grow" href="#" data-goref="' + esc(end.other) + ':' + esc(r.id) + '">' + esc(r.title || r.id) + '</a>'
          + (movable ? UI.btn('Up', { size: 'xs', kind: 'ghost', attrs: 'data-relup="' + esc(end.name) + '|' + (d.offset + i) + '" aria-label="' + esc('Move ' + (r.title || r.id) + ' up') + '"', disabled: d.offset + i === 0 }) + UI.btn('Down', { size: 'xs', kind: 'ghost', attrs: 'data-reldown="' + esc(end.name) + '|' + (d.offset + i) + '" aria-label="' + esc('Move ' + (r.title || r.id) + ' down') + '"', disabled: d.offset + i >= d.total - 1 }) : '')
          + (canWrite && end.editable ? UI.iconbtn('x', 'Remove the link to ' + (r.title || r.id), { attrs: 'data-relrm="' + esc(end.name) + '|' + esc(r.id) + '"', cls: 'sm ghost' }) : '') + '</li>').join('');
        const paging = d.total > PAGE ? '<div class="hstack wrap gap6" style="font-size:12px"><span class="muted grow">' + (d.offset + 1) + ' to ' + (d.offset + d.records.length) + ' of ' + d.total + '</span>' + UI.btn('Previous', { size: 'xs', attrs: 'data-relprev="' + esc(end.name) + '" aria-label="Previous ' + esc(end.title) + '"', disabled: d.offset === 0 }) + UI.btn('Next', { size: 'xs', attrs: 'data-relnext="' + esc(end.name) + '" aria-label="Next ' + esc(end.title) + '"', disabled: d.offset + PAGE >= d.total }) + '</div>' : '';
        body = (d.records.length ? '<ul class="apps-rellist" aria-labelledby="' + hid + '">' + items + '</ul>' : '<div class="muted" style="font-size:12px">No linked ' + esc((other(end.other) || {}).title || end.other) + ' records you can see.</div>') + paging;
      }
      const add = canWrite && end.editable ? UI.btn('Add link', { size: 'xs', icon: 'plus', attrs: 'data-reladd="' + esc(end.name) + '" aria-label="Add a link to ' + esc(end.title) + '"' }) : '';
      return '<section class="apps-rel" aria-labelledby="' + hid + '"><div class="hstack wrap gap6"><h3 class="apps-relh grow" id="' + hid + '">' + esc(end.title) + (d ? ' <span class="muted" style="font-weight:400">(' + d.total + ')</span>' : '') + '</h3>' + add + '</div><div class="muted" style="font-size:11px">' + esc(kind) + ', ' + esc(end.declaredBy) + '</div>' + body + '</section>';
    }).join('');

    const endBy = (name) => ends.find((e) => e.name === name);
    const linksUrl = (name) => E(app, ent) + '/records/' + enc(rec.id) + '/links/' + enc(name);
    const after = (name, msg) => { reload(ctx, rec, null); if (deps && deps.invalidate) deps.invalidate(); if (msg) ctx.toast(msg, 'ok', 4000); ctx.rerender(); void name; };
    ctx.on('click', '[data-relprev]', (e, t) => { const p = relOf(st).pages[rec.id + ':' + t.dataset.relprev]; if (p) { p.offset = Math.max(0, p.offset - PAGE); p.url = null; } ctx.rerender(); });
    ctx.on('click', '[data-relnext]', (e, t) => { const p = relOf(st).pages[rec.id + ':' + t.dataset.relnext]; if (p) { p.offset += PAGE; p.url = null; } ctx.rerender(); });
    ctx.on('click', '[data-relrm]', async (e, t) => {
      const [name, id] = t.dataset.relrm.split('|'); const end = endBy(name);
      const ok = await ctx.confirm({ title: 'Remove the link', tone: 'warn', body: '<p class="fg2" style="margin:0">The two records stay; only the link between them goes.</p>', kv: [['Relation', esc(end ? end.title : name)], ['Record', '<span class="mono">' + esc(id) + '</span>']], ok: 'Remove link' });
      if (!ok) return;
      try { await App.del(linksUrl(name) + '/' + enc(id)); after(name, 'Link removed. Audited app.record.unlinked.'); } catch (err) { App.fail(err, 'The link was not removed'); }
    });
    const move = async (name, from, to) => {
      try {
        const all = await App.get(linksUrl(name) + '?limit=100&offset=0');
        if (all.total > all.records.length) { ctx.toast('More than 100 links: reorder them through the API.', 'warn'); return; }
        const ids = all.records.map((r) => r.id); if (to < 0 || to >= ids.length) return;
        const x = ids.splice(from, 1)[0]; ids.splice(to, 0, x);
        await App.put(linksUrl(name) + '/order', { order: ids });
        reload(ctx, rec, name); ctx.toast('Order saved. Audited app.record.links.reordered.', 'ok', 3000); ctx.rerender();
        const el = ctx.$('[data-rel' + (to > from ? 'down' : 'up') + '="' + name + '|' + to + '"]') || ctx.$('[data-reladd="' + name + '"]'); if (el) el.focus();
      } catch (err) { App.fail(err, 'The order was not saved'); }
    };
    ctx.on('click', '[data-relup]', (e, t) => { const [name, i] = t.dataset.relup.split('|'); move(name, +i, +i - 1); });
    ctx.on('click', '[data-reldown]', (e, t) => { const [name, i] = t.dataset.reldown.split('|'); move(name, +i, +i + 1); });
    ctx.on('click', '[data-reladd]', (e, t) => openPicker(ctx, app, ent, rec, endBy(t.dataset.reladd), () => after(t.dataset.reladd, null)));
    return '<style>' + CSS + '</style><div class="eyebrow">Related records</div>' + panels;
  };

  /** The add-link picker: a typeahead over the other entity's records, through the reader's grant. */
  function openPicker(ctx, app, ent, rec, end, done) {
    if (!end) return;
    const target = app.entities.find((e) => e.name === end.other);
    const url = E(app, ent) + '/records/' + enc(rec.id) + '/links/' + enc(end.name);
    ctx.modal({ title: 'Link ' + esc(end.title), body: '<style>' + CSS + '</style>' + UI.field('Search ' + esc((target && target.title) || end.other) + ' records', UI.input('', { type: 'search', placeholder: 'Type part of a title', attrs: 'data-rp-q autocomplete="off"' }), 'Only records you may read are offered.' + (end.max ? ' At most ' + end.max + ' links.' : ''))
      + '<div aria-live="polite" data-rp-status class="muted" style="font-size:12px"></div><ul class="apps-relpick" data-rp-list aria-label="Matching records"></ul><div data-rp-err></div>',
    actions: UI.btn('Done', { attrs: 'data-close' }),
    onClose() { done(); },
    onMount(m) {
      const q = m.querySelector('[data-rp-q]'); const list = m.querySelector('[data-rp-list]'); const status = m.querySelector('[data-rp-status]'); const errEl = m.querySelector('[data-rp-err]');
      let seq = 0; let timer = null;
      const draw = (cands) => {
        list.innerHTML = cands.map((c) => '<li><span>' + esc(c.title) + ' <span class="muted mono" style="font-size:11px">' + esc(c.id.slice(-6)) + '</span></span>' + UI.btn(c.linked ? 'Linked' : 'Link', { size: 'xs', kind: c.linked ? '' : 'primary', attrs: 'data-rp-link="' + esc(c.id) + '" aria-label="' + esc((c.linked ? 'Already linked: ' : 'Link ') + c.title) + '"', disabled: c.linked }) + '</li>').join('');
        status.textContent = cands.length ? cands.length + ' record' + (cands.length === 1 ? '' : 's') + ' found' : 'No record found';
      };
      const search = () => {
        const mine = ++seq; status.textContent = 'Searching…';
        App.get(url + '/candidates?limit=10' + (q.value.trim() ? '&q=' + enc(q.value.trim()) : '')).then((r) => { if (mine === seq) draw(r.candidates); }).catch((err) => { if (mine === seq) { status.textContent = ''; errEl.innerHTML = UI.notice(esc(detailOf(err)), 'danger'); } });
      };
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
      list.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-rp-link]'); if (!b || b.disabled) return;
        errEl.innerHTML = '';
        try {
          const out = await App.post(url, { id: b.dataset.rpLink });
          b.textContent = 'Linked'; b.disabled = true; b.classList.remove('primary'); b.setAttribute('aria-label', 'Linked: ' + ((out.linked && out.linked.title) || b.dataset.rpLink));
          status.textContent = 'Linked ' + ((out.linked && out.linked.title) || '') + '. Audited app.record.linked.';
          q.focus();
        } catch (err) { errEl.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(detailOf(err)), 'danger'); }
      });
      search(); q.focus();
    } });
  }

  // ---------- a new record's first links ----------

  /** Options for a new record's relation fields: the target's records the reader may read, newest first (50). */
  App.appsRelationOptions = async function (app, ent, fields) {
    const out = {};
    await Promise.all(fields.map((f) => {
      const target = app.entities.find((e) => e.name === f.entity); if (!target) return Promise.resolve();
      return App.get(E(app, target) + '/records?limit=50&sort=updatedAt:desc').then((r) => { out[f.name] = r.records.map((x) => ({ value: x.id, label: titleOf(target, x) })); }).catch(() => { out[f.name] = []; });
    }));
    return out;
  };
  /** A multi-select of records to link; the value read is the list of chosen ids. */
  App.appsRelationControl = function (f, opts, attrs) {
    return '<select class="select" multiple size="' + Math.min(5, Math.max(2, (opts || []).length)) + '" ' + (attrs || '') + '>' + (opts || []).map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('') + '</select>';
  };

  // ---------- the relation field editor ----------

  /** The type body of a relation or reference field: target, cardinality, back-reference and the relation's rules. */
  App.appsRelationEditor = function (cur, others, type) {
    const g = UI.field;
    const card = g('Cardinality', UI.select([{ value: 'many-to-many', label: 'Many to many (links)' }, { value: 'one-to-many', label: 'One to many (a reference)' }], type === 'reference' ? 'one-to-many' : 'many-to-many', 'data-ff="cardinality"'), 'Many to many keeps links in their own table; one to many stores one record id in each record.');
    const target = g('Target entity', UI.select(others, cur.entity || others[0], 'data-ff="entity"'), 'An entity of this app; this one too for a self-relation.');
    const inverse = g('Back-reference name (optional)', UI.input(cur.inverse || '', { placeholder: 'shown on the target, e.g. tickets', attrs: 'data-ff="inverse"' }), 'The "related records" the target entity shows.') + g('Back-reference title', UI.input(cur.inverseTitle || '', { attrs: 'data-ff="inverseTitle"' }));
    if (type === 'reference') return card + target + inverse + '<div class="span2">' + UI.notice('A reference with a back-reference is indexed, so the records pointing at one can be listed. The back-reference is read-only.', 'info') + '</div>';
    return card + target + inverse
      + g('On delete', UI.select([{ value: 'unlink', label: 'Unlink (remove the links)' }, { value: 'block', label: 'Block the delete while linked' }], cur.onDelete || 'unlink', 'data-ff="onDelete"'), 'Applies to a record at either end.')
      + g('Max links (optional)', UI.input(cur.max == null ? '' : cur.max, { type: 'number', attrs: 'data-ff="max" min="1" step="1"' }))
      + '<div class="span2 hstack wrap gap12">' + UI.check('Two-way: links can also be made from the back-reference', !!cur.twoWay, 'data-ff="twoWay"') + UI.check('Symmetric (a self-relation without a back-reference)', !!cur.symmetric, 'data-ff="symmetric"') + '</div>'
      + '<div class="span2">' + UI.notice('Links are not values: they are listed under Related records on each record, filtered with eq, in, exists, matches and name.count, and only ever show records the reader may read. Required means at least one link.', 'info') + '</div>';
  };
  /** The relation or reference properties the editor holds. */
  App.appsRelationRead = function (val, type) {
    const out = { entity: val('entity') };
    const inv = String(val('inverse') || '').trim(); const invTitle = String(val('inverseTitle') || '').trim();
    if (inv) { out.inverse = inv; if (invTitle) out.inverseTitle = invTitle; }
    if (type === 'relation') {
      out.onDelete = val('onDelete') || 'unlink';
      const max = String(val('max') == null ? '' : val('max')).trim(); if (max) out.max = Number(max);
      out.twoWay = !!val('twoWay') && !!inv; out.symmetric = !!val('symmetric') && !inv;
      out.indexed = false; out.unique = false;
    } else if (inv) out.indexed = true;
    return out;
  };
})();
