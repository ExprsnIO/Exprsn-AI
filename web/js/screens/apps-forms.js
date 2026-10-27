// Apps, the Forms tab (the exprsn-platform low-code port, follow-up 2 of docs/decisions/lowcode-port.md): an app's
// forms with sections, wizard steps and condition trees. A section has a title, help and may collapse; a wizard is
// ordered steps of sections with a review step; fields, sections and steps can be shown (visible if) or required
// (required if) by an all/any/none tree over earlier answers. The live preview runs the same evaluator as the public
// form page and the embed page (/js/form-layout.js); the server decides again on every submission.
// `apps.js` calls App.appsForms(ctx, app, design, canWrite, deps) for the tab's body; the state lives in ctx.state.
(function () {
  const { UI, esc } = App;
  const L = window.ExprsnFormLayout;
  const enc = encodeURIComponent;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const GROUPS = [{ value: 'all', label: 'all of these match' }, { value: 'any', label: 'any of these match' }, { value: 'none', label: 'none of these match' }];
  const LEGACY_OPS = ['eq', 'ne', 'in', 'truthy', 'falsy'];
  const MODES = [{ id: 'flat', label: 'One list' }, { id: 'sections', label: 'Sections' }, { id: 'wizard', label: 'Wizard' }];
  const CSS = '#main .apf-sec,#main .apf-step{border:1px solid var(--line2);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;min-width:0;background:var(--panel)}'
    + '#main .apf-step{background:var(--panel2);border-left:4px solid var(--accent)}#main .apf-head{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;min-width:0}#main .apf-head > *{min-width:0}#main .apf-head .field{flex:1 1 160px}'
    + '#main .apf-cond{font-size:12px;color:var(--fg2);overflow-wrap:anywhere}#main .apf-steps{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}'
    + '#main .apf-stp{display:inline-block;font:inherit;font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--line2);background:var(--panel);color:var(--fg2);overflow-wrap:anywhere;max-width:100%}'
    + '#main .apf-stp.cur{border-color:var(--accent);color:var(--fg);font-weight:600;box-shadow:0 0 0 1px var(--accent)}#main button.apf-stp{cursor:pointer;color:var(--fg)}'
    + '#main .apf-pvh{font-size:14px;margin:0;overflow-wrap:anywhere}#main .apf-pvh:focus-visible{outline:2px solid var(--accent);outline-offset:2px}#main .apf-pvs{display:flex;flex-direction:column;gap:8px;border:1px solid var(--line);border-radius:6px;padding:8px;min-width:0}'
    + '#main .apf-pvs > summary{cursor:pointer}#main .apf-pvsh{font-size:13px;margin:0;display:inline;overflow-wrap:anywhere}#main .apf-review{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:4px 10px;margin:0;font-size:12px}#main .apf-review dt{font-weight:600;overflow-wrap:anywhere}#main .apf-review dd{margin:0;overflow-wrap:anywhere}'
    + '#main .apf-sec .apps-ff:last-child{border-bottom:0}@media (max-width:520px){#main .apf-review{grid-template-columns:minmax(0,1fr)}}';
  const MODAL_CSS = '<style>#overlay .apf-cb{border-left:2px solid var(--line2);padding:4px 0 4px 10px;display:flex;flex-direction:column;gap:6px;min-width:0}#overlay .apf-leaf{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;min-width:0}#overlay .apf-leaf > *{min-width:0}#overlay .apf-leaf .field{flex:1 1 120px}</style>';

  // ---------- the draft's layout ----------
  const isTree = (c) => !!c && (Array.isArray(c.all) || Array.isArray(c.any) || Array.isArray(c.none) || LEGACY_OPS.indexOf(c.op) < 0);
  const modeOf = (def) => (!def.layout ? 'flat' : def.layout.mode === 'wizard' ? 'wizard' : 'sections');
  const secById = (def, id) => (def.layout ? def.layout.sections.filter((s) => s.id === id)[0] || null : null);
  const stepById = (def, id) => (def.layout && def.layout.steps ? def.layout.steps.filter((s) => s.id === id)[0] || null : null);
  /** Section ids in layout order (a wizard's by its steps). */
  function sectionOrder(def) {
    if (!def.layout) return [];
    const ids = def.layout.sections.map((s) => s.id);
    if (def.layout.mode !== 'wizard') return ids;
    const out = []; (def.layout.steps || []).forEach((st) => st.sections.forEach((sid) => { if (out.indexOf(sid) < 0 && ids.indexOf(sid) >= 0) out.push(sid); }));
    ids.forEach((sid) => { if (out.indexOf(sid) < 0) out.push(sid); });
    return out;
  }
  /** Field names in layout order. */
  function fieldOrder(def) {
    if (!def.layout) return def.fields.map((f) => f.field);
    const out = []; sectionOrder(def).forEach((sid) => (secById(def, sid).fields || []).forEach((n) => { if (out.indexOf(n) < 0) out.push(n); }));
    def.fields.forEach((f) => { if (out.indexOf(f.field) < 0) out.push(f.field); });
    return out;
  }
  function reorderFields(def) { const o = fieldOrder(def); def.fields.sort((a, b) => o.indexOf(a.field) - o.indexOf(b.field)); }
  const freeId = (prefix, taken) => { let i = 1; while (taken.indexOf(prefix + i) >= 0) i++; return prefix + i; };
  const sectionOfField = (def, name) => (def.layout ? def.layout.sections.filter((s) => s.fields.indexOf(name) >= 0)[0] || null : null);
  const stepOfSection = (def, sid) => (def.layout && def.layout.steps ? def.layout.steps.filter((s) => s.sections.indexOf(sid) >= 0)[0] || null : null);
  function setMode(def, mode) {
    if (mode === 'flat') { if (def.layout) { reorderFields(def); delete def.layout; } return; }
    if (!def.layout) def.layout = { mode: 'sections', sections: [{ id: 'main', title: '', fields: def.fields.map((f) => f.field) }] };
    if (mode === 'sections') { def.layout.mode = 'sections'; reorderFields(def); delete def.layout.steps; delete def.layout.review; return; }
    def.layout.mode = 'wizard';
    if (!def.layout.steps || !def.layout.steps.length) def.layout.steps = def.layout.sections.map((s, i) => ({ id: 'step' + (i + 1), title: s.title || 'Step ' + (i + 1), sections: [s.id] }));
  }
  /** The fields a condition of `target` may read: those before it in layout order (the server's rule). */
  function earlierFields(def, target) {
    const kind = target.split(':')[0]; const id = target.slice(kind.length + 1);
    if (kind === 'field') { const order = fieldOrder(def); return order.slice(0, Math.max(0, order.indexOf(id))); }
    // A section's or a step's conditions read the fields of the sections before it.
    const sids = sectionOrder(def);
    const mine = kind === 'section' ? [id] : (stepById(def, id) || { sections: [] }).sections;
    const at = Math.min.apply(null, mine.map((sid) => sids.indexOf(sid)).filter((i) => i >= 0).concat([sids.length]));
    return sids.slice(0, at).reduce((a, sid) => a.concat(secById(def, sid).fields), []);
  }
  const targetObj = (def, target) => { const kind = target.split(':')[0]; const id = target.slice(kind.length + 1); return kind === 'field' ? def.fields.filter((f) => f.field === id)[0] : kind === 'section' ? secById(def, id) : stepById(def, id); };
  const targetName = (def, target) => { const kind = target.split(':')[0]; const id = target.slice(kind.length + 1); const o = targetObj(def, target) || {}; return kind === 'field' ? 'field ' + id : kind === 'section' ? 'section ' + (o.title || id) : 'step ' + (o.title || id); };
  /** The definition the API takes: empty optional parts left out, fields in layout order. */
  function payload(def) {
    const d = clone(def);
    if (!d.submitLabel) delete d.submitLabel; if (!d.successMessage) delete d.successMessage;
    d.fields.forEach((f) => { if (!f.label) delete f.label; if (!f.help) delete f.help; if (!f.required) delete f.required; if (!f.visibleIf) delete f.visibleIf; if (!f.requiredIf) delete f.requiredIf; });
    if (d.layout) {
      reorderFields(d);
      d.layout.sections.forEach((s) => { if (!s.title) delete s.title; if (!s.help) delete s.help; if (!s.collapsible) { delete s.collapsible; delete s.collapsed; } else if (!s.collapsed) delete s.collapsed; if (!s.visibleIf) delete s.visibleIf; if (!s.requiredIf) delete s.requiredIf; });
      if (d.layout.mode === 'wizard') { d.layout.steps.forEach((s) => { if (!s.help) delete s.help; if (!s.visibleIf) delete s.visibleIf; if (!s.requiredIf) delete s.requiredIf; }); if (!d.layout.review) delete d.layout.review; }
      else { delete d.layout.steps; delete d.layout.review; }
    }
    return d;
  }
  const condLine = (o) => [o.visibleIf ? 'visible if ' + L.text(o.visibleIf) : null, o.requiredIf ? 'required if ' + L.text(o.requiredIf) : null].filter(Boolean).join(' · ');
  const layoutText = (def) => (!def.layout ? 'one list' : def.layout.mode === 'wizard' ? 'wizard, ' + (def.layout.steps || []).length + ' step' + ((def.layout.steps || []).length === 1 ? '' : 's') + (def.layout.review ? ' + review' : '') : def.layout.sections.length + ' section' + (def.layout.sections.length === 1 ? '' : 's'));

  // Re-render after the event settles, and put focus back on the control that had it (by its data-* attributes).
  function keyOf(el) { if (!el || !el.attributes) return null; for (let i = 0; i < el.attributes.length; i++) { const a = el.attributes[i]; if (/^data-(fl|pv|fe|fsave|ftest|fadd)/.test(a.name)) return '[' + a.name + '="' + String(a.value).replace(/"/g, '\\"') + '"]'; } return null; }
  function rerenderKeep(ctx, overlayOpen) {
    setTimeout(() => { if (App.state.route !== 'apps' || overlayOpen()) return; const k = keyOf(document.activeElement); ctx.rerender(); const el = k ? ctx.$(k) : null; if (el && !el.disabled) el.focus(); }, 0);
  }

  // ---------- the condition tree builder (a dialog) ----------
  // The flows condition model (all, any, none groups of {field, op, value}), edited as a tree addressed by paths of
  // child indices. Every control is a native button, select or input, so the builder is keyboard operable.
  const isGroup = (c) => !!c && (Array.isArray(c.all) || Array.isArray(c.any) || Array.isArray(c.none));
  const gop = (g) => (Array.isArray(g.all) ? 'all' : Array.isArray(g.any) ? 'any' : 'none');
  const kids = (g) => g[gop(g)];
  const leafCount = (c) => (!c ? 0 : isGroup(c) ? kids(c).reduce((a, x) => a + leafCount(x), 0) : 1);
  function leafHtml(l, k, opts, label) {
    const needs = L.NO_VALUE.indexOf(l.op) < 0;
    const val = l.value === undefined || l.value === null ? '' : Array.isArray(l.value) ? l.value.join(', ') : String(l.value);
    return '<div class="apf-leaf" role="group" aria-label="' + esc(label) + '">'
      + UI.field('Field', UI.select(opts.concat(opts.some((o) => o.value === l.field) ? [] : [{ value: l.field, label: l.field + ' (not before this)' }]), l.field, 'data-cb-f="' + esc(k) + '"'))
      + UI.field('Test', UI.select(L.OPS, l.op, 'data-cb-o="' + esc(k) + '"'))
      + (needs ? UI.field(L.LIST_VALUE.indexOf(l.op) >= 0 ? 'Values, comma-separated' : 'Value', UI.input(val, { attrs: 'data-cb-v="' + esc(k) + '"' })) : '')
      + UI.iconbtn('trash', 'Remove the comparison ' + L.text(l), { attrs: 'data-cb-del="' + esc(k) + '"', cls: 'sm ghost' }) + '</div>';
  }
  function treeHtml(c, pfx, path, opts, depth) {
    const k = pfx + '|' + path;
    if (!isGroup(c)) return leafHtml(c, k, opts, 'Comparison ' + (path === '' ? '1' : path.split('.').map((x) => +x + 1).join('.')));
    return '<div class="apf-cb" role="group" aria-label="Group: ' + esc(gop(c)) + ' of ' + kids(c).length + '">'
      + UI.field('Match when', UI.select(GROUPS, gop(c), 'data-cb-g="' + esc(k) + '"'))
      + kids(c).map((x, i) => treeHtml(x, pfx, path === '' ? String(i) : path + '.' + i, opts, depth + 1)).join('')
      + '<div class="hstack wrap gap6">' + UI.btn('Add comparison', { size: 'xs', icon: 'plus', attrs: 'data-cb-add="' + esc(k) + '"', disabled: !opts.length }) + (depth < 3 ? UI.btn('Add group', { size: 'xs', icon: 'plus', attrs: 'data-cb-addg="' + esc(k) + '"', disabled: !opts.length }) : '') + (path !== '' ? UI.btn('Remove group', { size: 'xs', kind: 'ghost', attrs: 'data-cb-del="' + esc(k) + '"' }) : '') + '</div></div>';
  }
  function builderHtml(root, pfx, opts, emptyText) {
    if (!root) return '<div class="muted" style="font-size:12px">' + esc(emptyText) + '</div><div class="hstack wrap gap6">' + UI.btn('Add comparison', { size: 'xs', icon: 'plus', attrs: 'data-cb-add="' + esc(pfx) + '|"', disabled: !opts.length }) + UI.btn('Add group', { size: 'xs', icon: 'plus', attrs: 'data-cb-addg="' + esc(pfx) + '|"', disabled: !opts.length }) + '</div>';
    return treeHtml(root, pfx, '', opts, 0) + (isGroup(root) ? '' : '<div class="hstack wrap gap6">' + UI.btn('Add another comparison', { size: 'xs', icon: 'plus', attrs: 'data-cb-add="' + esc(pfx) + '|"' }) + '</div>')
      + '<div class="muted" style="font-size:12px">' + leafCount(root) + ' comparison' + (leafCount(root) === 1 ? '' : 's') + ' (at most 15, groups 4 deep). Reads: ' + esc(L.text(root)) + '.</div>';
  }
  function leafProblems(c) {
    if (!c) return [];
    if (isGroup(c)) return kids(c).length ? kids(c).reduce((a, x) => a.concat(leafProblems(x)), []) : ['A group needs at least one comparison.'];
    if (L.NO_VALUE.indexOf(c.op) >= 0) return [];
    if (L.LIST_VALUE.indexOf(c.op) >= 0) return Array.isArray(c.value) && c.value.length ? [] : [c.field + ' ' + c.op + ' needs a list of values.'];
    return c.value === undefined || c.value === '' ? [c.field + ' ' + c.op + ' needs a value.'] : [];
  }

  function openConditions(ctx, deps, ent, def, target, after) {
    const obj = targetObj(def, target); if (!obj) return;
    const roots = { visibleIf: obj.visibleIf ? clone(obj.visibleIf) : null, requiredIf: obj.requiredIf ? clone(obj.requiredIf) : null };
    const names = earlierFields(def, target);
    const opts = names.map((n) => { const f = deps.fieldByName(ent, n); return { value: n, label: f && f.title ? f.title + ' (' + n + ')' : n }; });
    const typed = (field, s) => { const f = deps.fieldByName(ent, field); if (f && f.type === 'number' && s !== '' && !isNaN(Number(s))) return Number(s); if (f && f.type === 'boolean' && (s === 'true' || s === 'false')) return s === 'true'; return s; };
    const what = targetName(def, target);
    const box = (pfx) => '<div class="vstack gap6" data-cb-box="' + pfx + '">' + builderHtml(roots[pfx], pfx, opts, pfx === 'visibleIf' ? 'Always shown.' : 'Required only when marked required.') + '</div>';
    const body = MODAL_CSS + '<p class="fg2" style="margin:0;font-size:13px">A condition reads answers that come earlier on the form than the ' + esc(what) + '. Text compares without regard to case; numbers as numbers. The server applies the same conditions to every submission: a hidden field is dropped and never stored.</p>'
      + (opts.length ? '' : UI.notice('Nothing comes before the ' + esc(what) + ', so it has nothing to depend on. Move it later on the form first.', 'warn'))
      + '<h3 style="font-size:13px;margin:8px 0 0">Visible if</h3>' + box('visibleIf') + '<h3 style="font-size:13px;margin:8px 0 0">Required if</h3>' + box('requiredIf') + '<div data-cb-err></div>';
    deps.modal({ title: 'Conditions for the ' + esc(what), cls: 'wide', body, actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Done', { kind: 'primary', attrs: 'data-cb-ok' }),
      onMount(m) {
        const parse = (key) => { const i = key.indexOf('|'); const rest = key.slice(i + 1); return { pfx: key.slice(0, i), path: rest === '' ? [] : rest.split('.').map(Number) }; };
        const at = (root, path) => path.reduce((n, i) => (n ? kids(n)[i] : null), root);
        const newLeaf = () => ({ field: opts[0] ? opts[0].value : '', op: 'eq', value: '' });
        const redraw = (pfx, focusSel) => { m.querySelector('[data-cb-box="' + pfx + '"]').innerHTML = builderHtml(roots[pfx], pfx, opts, pfx === 'visibleIf' ? 'Always shown.' : 'Required only when marked required.'); const el = focusSel ? m.querySelector(focusSel) : null; if (el) el.focus(); };
        m.addEventListener('click', (e) => {
          const t = e.target.closest('[data-cb-add],[data-cb-addg],[data-cb-del]'); if (!t || !m.contains(t)) return;
          if (t.hasAttribute('data-cb-del')) {
            const p = parse(t.getAttribute('data-cb-del'));
            if (!p.path.length) roots[p.pfx] = null;
            else { const parent = at(roots[p.pfx], p.path.slice(0, -1)); kids(parent).splice(p.path[p.path.length - 1], 1); if (!kids(parent).length && p.path.length === 1) roots[p.pfx] = null; }
            const parentKey = p.pfx + '|' + p.path.slice(0, -1).join('.');
            redraw(p.pfx, '[data-cb-add="' + parentKey + '"]'); if (!m.querySelector('[data-cb-add="' + parentKey + '"]')) { const el = m.querySelector('[data-cb-add^="' + p.pfx + '|"]'); if (el) el.focus(); }
            return;
          }
          const group = t.hasAttribute('data-cb-addg'); const p = parse(t.getAttribute(group ? 'data-cb-addg' : 'data-cb-add')); const root = roots[p.pfx];
          const item = group ? { all: [newLeaf()] } : newLeaf();
          let path;
          if (!root) { roots[p.pfx] = item; path = group ? '0' : ''; }
          else if (!p.path.length && !isGroup(root)) { roots[p.pfx] = { all: [root, item] }; path = '1' + (group ? '.0' : ''); }
          else { const g = at(root, p.path); kids(g).push(item); path = p.path.concat([kids(g).length - 1]).join('.') + (group ? '.0' : ''); }
          redraw(p.pfx, '[data-cb-f="' + p.pfx + '|' + path + '"]');
        });
        m.addEventListener('change', (e) => {
          const t = e.target; let k;
          if ((k = t.getAttribute('data-cb-g'))) { const p = parse(k); const g = at(roots[p.pfx], p.path); const list = kids(g); delete g.all; delete g.any; delete g.none; g[t.value] = list; redraw(p.pfx, '[data-cb-g="' + k + '"]'); }
          else if ((k = t.getAttribute('data-cb-f'))) { const p = parse(k); at(roots[p.pfx], p.path).field = t.value; }
          else if ((k = t.getAttribute('data-cb-o'))) {
            const p = parse(k); const l = at(roots[p.pfx], p.path); l.op = t.value;
            if (L.NO_VALUE.indexOf(l.op) >= 0) delete l.value; else if (L.LIST_VALUE.indexOf(l.op) >= 0) l.value = Array.isArray(l.value) ? l.value : l.value === undefined || l.value === '' ? [] : [l.value]; else if (Array.isArray(l.value)) l.value = l.value[0] === undefined ? '' : l.value[0]; else if (l.value === undefined) l.value = '';
            redraw(p.pfx, '[data-cb-o="' + k + '"]');
          } else if ((k = t.getAttribute('data-cb-v'))) { const p = parse(k); const l = at(roots[p.pfx], p.path); l.value = L.LIST_VALUE.indexOf(l.op) >= 0 ? t.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => typed(l.field, s)) : typed(l.field, t.value.trim()); }
        });
        m.querySelector('[data-cb-ok]').addEventListener('click', () => {
          // Values typed but not yet committed by a change event.
          m.querySelectorAll('[data-cb-v]').forEach((el) => { const p = parse(el.getAttribute('data-cb-v')); const l = at(roots[p.pfx], p.path); if (l) l.value = L.LIST_VALUE.indexOf(l.op) >= 0 ? el.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => typed(l.field, s)) : typed(l.field, el.value.trim()); });
          const probs = leafProblems(roots.visibleIf).concat(leafProblems(roots.requiredIf));
          if (probs.length) { m.querySelector('[data-cb-err]').innerHTML = UI.notice(probs.map(esc).join('<br>'), 'warn'); return; }
          if (roots.visibleIf) obj.visibleIf = roots.visibleIf; else delete obj.visibleIf;
          if (roots.requiredIf) obj.requiredIf = roots.requiredIf; else delete obj.requiredIf;
          App.closeOverlay(); after();
        });
      } });
  }

  // ---------- a field's label, help, required and quick condition (a dialog) ----------
  function openFieldModal(ctx, deps, ent, def, name, spare, after) {
    const x = name == null ? {} : clone(def.fields.filter((f) => f.field === name)[0] || {});
    const order = fieldOrder(def);
    const earlier = name == null ? order : order.slice(0, order.indexOf(name));
    const tree = isTree(x.visibleIf);
    const cond = !tree && x.visibleIf ? x.visibleIf : {};
    const secs = def.layout ? sectionOrder(def).map((sid) => { const s = secById(def, sid); const st = stepOfSection(def, sid); return { value: sid, label: (st ? st.title + ' / ' : '') + (s.title || 'untitled section ' + sid) }; }) : [];
    const curSec = name == null ? (secs.length ? secs[secs.length - 1].value : '') : ((sectionOfField(def, name) || {}).id || '');
    const quick = tree ? UI.notice('Visible if ' + esc(L.text(x.visibleIf)) + '. Edit it with Conditions.', 'info')
      : '<div class="formgrid">' + UI.field('Earlier field', UI.select([{ value: '', label: 'always shown' }].concat(earlier.map((n) => ({ value: n, label: n }))), cond.field || '', 'data-xf-cf'), 'A condition may only read a field earlier on the form. Groups of conditions: Conditions.') + UI.field('Operator', UI.select(LEGACY_OPS, cond.op || 'eq', 'data-xf-cop')) + '<div class="span2">' + UI.field('Value', UI.input(cond.value == null ? '' : Array.isArray(cond.value) ? cond.value.join(', ') : String(cond.value), { attrs: 'data-xf-cv', placeholder: 'for in: a, b' })) + '</div></div>';
    deps.modal({ title: name == null ? 'Add a field to the form' : 'Edit ' + esc(name), body: '<div class="formgrid">' + (name == null ? UI.field('Field', UI.select(spare.map((f) => ({ value: f.name, label: f.title || f.name })), spare[0] ? spare[0].name : '', 'data-xf-field')) : UI.field('Field', UI.input(name, { readonly: true })))
      + (secs.length ? UI.field('Section', UI.select(secs, curSec, 'data-xf-sec')) : '') + UI.field('Label', UI.input(x.label || '', { attrs: 'data-xf-label', placeholder: 'defaults to the field title' })) + '<div class="span2">' + UI.field('Help', UI.input(x.help || '', { attrs: 'data-xf-help' })) + '</div></div>' + UI.check('Required on this form', !!x.required, 'data-xf-required')
      + (x.requiredIf ? '<div class="muted" style="font-size:12px">Also required if ' + esc(L.text(x.requiredIf)) + '.</div>' : '')
      + '<div class="divider"></div><div class="eyebrow">Visible if (optional)</div>' + quick,
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(name == null ? 'Add' : 'Done', { kind: 'primary', attrs: 'data-xf-ok' }),
    onMount(m) {
      m.querySelector('[data-xf-ok]').addEventListener('click', () => {
        const fname = name == null ? m.querySelector('[data-xf-field]').value : name;
        const nx = { field: fname };
        if (m.querySelector('[data-xf-required]').checked) nx.required = true;
        const label = m.querySelector('[data-xf-label]').value.trim(); if (label) nx.label = label;
        const help = m.querySelector('[data-xf-help]').value.trim(); if (help) nx.help = help;
        if (x.requiredIf) nx.requiredIf = x.requiredIf;
        if (tree) nx.visibleIf = x.visibleIf;
        const cfEl = m.querySelector('[data-xf-cf]'); const cf = cfEl ? cfEl.value : '';
        if (cf) {
          const op = m.querySelector('[data-xf-cop]').value; const v = m.querySelector('[data-xf-cv]').value; const cfDef = deps.fieldByName(ent, cf);
          const typed = (s) => (cfDef && cfDef.type === 'number' && s !== '' && !isNaN(Number(s)) ? Number(s) : cfDef && cfDef.type === 'boolean' ? s === 'true' : s);
          nx.visibleIf = { field: cf, op };
          if (op === 'in') nx.visibleIf.value = v.split(',').map((s) => s.trim()).filter(Boolean).map(typed); else if (op === 'eq' || op === 'ne') nx.visibleIf.value = typed(v.trim());
        }
        if (name == null) def.fields.push(nx); else def.fields[def.fields.findIndex((f) => f.field === name)] = nx;
        if (def.layout) {
          const secEl = m.querySelector('[data-xf-sec]'); const target = secById(def, secEl ? secEl.value : curSec) || def.layout.sections[def.layout.sections.length - 1];
          const from = sectionOfField(def, fname);
          if (from !== target) { if (from) from.fields.splice(from.fields.indexOf(fname), 1); target.fields.push(fname); }
        }
        App.closeOverlay(); after();
      });
    } });
  }

  // ---------- the live preview ----------
  // The same plan as the public page: visible steps, sections and fields, per-step checks, a review step.
  function previewPlan(ent, def, pv, deps) {
    const spec = L.fromDefinition(def);
    spec.fields.forEach((f) => { const ef = deps.fieldByName(ent, f.name); if (ef && ef.required) f.required = true; });
    const p = L.plan(spec, pv);
    const pages = p.layout.mode === 'wizard' ? p.steps.slice() : ['_page'];
    if (p.layout.review) pages.push('_review');
    return { p, pages };
  }
  function previewHtml(ctx, form, ent, def, pv, deps, canWrite) {
    const st = ctx.state; const ps = st.pvStep[form.id] || (st.pvStep[form.id] = { cur: 0, missing: [] });
    const { p, pages } = previewPlan(ent, def, pv, deps);
    if (ps.cur >= pages.length) ps.cur = pages.length - 1; if (ps.cur < 0) ps.cur = 0;
    const id = pages[ps.cur]; const wizard = pages.length > 1;
    const stepTitle = (sid) => (sid === '_review' ? 'Review' : sid === '_page' ? (st.fdraft.title || form.name) : ((stepById(def, sid) || {}).title || sid));
    const fieldHtml = (pf) => {
      const f = deps.fieldByName(ent, pf.field); const x = def.fields.filter((y) => y.field === pf.field)[0] || {}; if (!f) return '';
      const c = st.optCache[ent.id + ':' + f.name]; const o = c ? Object.keys(c).map((k) => ({ value: k, label: c[k] })) : undefined;
      const miss = ps.missing.indexOf(pf.field) >= 0;
      return UI.field((x.label || f.title || f.name) + (pf.required ? ' *' : ''), deps.fieldControl(f, pv[f.name], 'data-pv' + (pf.required ? ' aria-required="true"' : '') + (miss ? ' aria-invalid="true"' : ''), o), esc(x.help || f.description || '') + (miss ? (x.help || f.description ? ' ' : '') + '<b>Fill this in.</b>' : ''));
    };
    const sectionHtml = (sid) => {
      const shown = p.fields.filter((x) => x.section === sid && x.visible); if (!shown.length) return '';
      const s = def.layout ? secById(def, sid) || {} : {};
      const inner = (s.help ? '<div class="muted" style="font-size:12px">' + esc(s.help) + '</div>' : '') + shown.map(fieldHtml).join('');
      if (!s.title) return inner;
      const h = '<h4 class="apf-pvsh">' + esc(s.title) + '</h4>';
      if (s.collapsible) return '<details class="apf-pvs"' + (!s.collapsed || shown.some((x) => ps.missing.indexOf(x.field) >= 0) ? ' open' : '') + '><summary>' + h + '</summary>' + inner + '</details>';
      return '<section class="apf-pvs" aria-label="' + esc(s.title) + '">' + h + inner + '</section>';
    };
    let body;
    if (id === '_review') {
      body = (p.layout.mode === 'wizard' ? p.steps : ['_page']).map((sid, i) => { const rows = p.fields.filter((x) => x.step === sid && x.visible).map((x) => { const f = deps.fieldByName(ent, x.field) || {}; const v = p.values[x.field]; return '<dt>' + esc(f.title || x.field) + '</dt><dd>' + (v == null || v === '' ? '<span class="muted">not answered</span>' : esc(String(v))) + '</dd>'; }).join(''); return '<div class="hstack wrap gap6"><b class="grow" style="font-size:12px">' + esc(stepTitle(sid)) + '</b>' + UI.btn('Change', { size: 'xs', kind: 'ghost', attrs: 'data-pvgoto="' + i + '" aria-label="Change ' + esc(stepTitle(sid)) + '"' }) + '</div><dl class="apf-review">' + (rows || '<dt class="muted">Nothing asked.</dt><dd></dd>') + '</dl>'; }).join('');
    } else {
      const secs = def.layout ? (id === '_page' ? sectionOrder(def) : (stepById(def, id) || { sections: [] }).sections) : ['main'];
      const sh = id !== '_page' && (stepById(def, id) || {}).help;
      body = (sh ? '<div class="muted" style="font-size:12px">' + esc(sh) + '</div>' : '') + secs.map(sectionHtml).join('');
    }
    const nav = wizard ? '<nav aria-label="Preview steps"><ol class="apf-steps">' + pages.map((x, i) => { const n = (i + 1) + '. ' + esc(stepTitle(x)); return '<li>' + (i === ps.cur ? '<span class="apf-stp cur" aria-current="step">' + n + '</span>' : i < ps.cur ? '<button type="button" class="apf-stp" data-pvgoto="' + i + '">' + n + '</button>' : '<span class="apf-stp">' + n + '</span>') + '</li>'; }).join('') + '</ol></nav>' : '';
    const last = ps.cur === pages.length - 1;
    const buttons = '<div class="hstack wrap gap6">' + (wizard && ps.cur > 0 ? UI.btn('Back', { size: 'sm', attrs: 'data-pvback' }) : '') + (!last ? UI.btn(pages[ps.cur + 1] === '_review' ? 'Review' : 'Next', { kind: 'primary', size: 'sm', attrs: 'data-pvnext' }) : canWrite ? UI.btn(def.submitLabel || 'Submit', { kind: 'primary', size: 'sm', attrs: 'data-ftest' }) : '') + (wizard ? '<span class="muted" style="font-size:12px">Step ' + (ps.cur + 1) + ' of ' + pages.length + '</span>' : '') + '</div>';
    return '<div class="apps-preview"><div style="font-weight:600;font-size:15px">' + esc(st.fdraft.title || form.name) + '</div>' + nav + (wizard ? '<h3 class="apf-pvh" tabindex="-1" data-pvstep-h>' + esc(stepTitle(id)) + '</h3>' : '')
      + (ps.missing.length ? UI.notice('Fill in ' + esc(ps.missing.join(', ')) + ' first.', 'warn') : '') + (body || '<div class="muted">Nothing to show.</div>') + buttons + '</div>';
  }

  // ---------- the editor ----------
  function fieldRow(ctx, deps, ent, def, x, n, design) {
    const f = ent ? deps.fieldByName(ent, x.field) : null; const name = x.field;
    const secs = def.layout ? sectionOrder(def).map((sid) => { const s = secById(def, sid); return { value: sid, label: s.title || 'section ' + sid }; }) : [];
    const cl = condLine(x);
    return '<div class="apps-ff" data-ffrow="' + esc(name) + '"><span class="muted num">' + n + '</span><span><span class="mono">' + esc(name) + '</span> <span class="muted" style="font-size:11px">' + esc(f ? f.type : 'unknown') + (f && f.required ? ', required' : x.required ? ', required here' : '') + '</span></span>'
      + '<span style="font-size:12px">' + esc(x.label || (f ? f.title || '' : '')) + (x.help ? '<span class="muted"> · ' + esc(x.help) + '</span>' : '') + '</span>'
      + '<span class="apf-cond">' + (cl ? '<span class="mono">' + esc(cl) + '</span>' : '<span class="muted">always shown</span>') + '</span>'
      + (design ? '<span class="apps-ffa">' + (secs.length > 1 ? '<label class="sr" for="apf-mv-' + esc(name) + '">Section of ' + esc(name) + '</label>' + UI.select(secs, (sectionOfField(def, name) || {}).id || '', 'id="apf-mv-' + esc(name) + '" data-fl-fsec="' + esc(name) + '" style="max-width:150px"') : '')
        + UI.iconbtn('chev', 'Move ' + name + ' up', { attrs: 'data-fl-up="' + esc(name) + '"', cls: 'sm ghost' }) + UI.iconbtn('chevd', 'Move ' + name + ' down', { attrs: 'data-fl-down="' + esc(name) + '"', cls: 'sm ghost' })
        + UI.iconbtn('edit', 'Edit ' + name, { attrs: 'data-fedit="' + esc(name) + '"', cls: 'sm ghost' }) + UI.iconbtn('branch', 'Conditions for ' + name, { attrs: 'data-fl-cond="field:' + esc(name) + '"', cls: 'sm ghost' }) + UI.iconbtn('trash', 'Remove ' + name + ' from the form', { attrs: 'data-fdel="' + esc(name) + '"', cls: 'sm ghost' }) + '</span>' : '') + '</div>';
  }
  function sectionCard(ctx, deps, ent, def, s, counter, design, wizard) {
    const n = sectionOrder(def).indexOf(s.id) + 1; const total = def.layout.sections.length;
    const rows = s.fields.map((name) => { const x = def.fields.filter((f) => f.field === name)[0]; return x ? fieldRow(ctx, deps, ent, def, x, ++counter.n, design) : ''; }).join('');
    const steps = wizard ? (def.layout.steps || []).map((t) => ({ value: t.id, label: t.title || t.id })) : [];
    const cl = condLine(s);
    const head = design ? '<div class="apf-head">' + UI.field('Section ' + n + ' title', UI.input(s.title || '', { attrs: 'data-fl-sv="' + esc(s.id) + '|title"', placeholder: 'untitled' })) + UI.field('Help', UI.input(s.help || '', { attrs: 'data-fl-sv="' + esc(s.id) + '|help"' })) + (wizard && steps.length > 1 ? UI.field('Step', UI.select(steps, (stepOfSection(def, s.id) || {}).id || '', 'data-fl-sstep="' + esc(s.id) + '"')) : '') + '</div>'
      + '<div class="hstack wrap gap6">' + UI.check('Collapsible', !!s.collapsible, 'data-fl-sc="' + esc(s.id) + '|collapsible"') + (s.collapsible ? UI.check('Starts collapsed', !!s.collapsed, 'data-fl-sc="' + esc(s.id) + '|collapsed"') : '')
        + '<span class="grow"></span>' + UI.iconbtn('chev', 'Move section ' + n + ' up', { attrs: 'data-fl-sup="' + esc(s.id) + '"', cls: 'sm ghost' }) + UI.iconbtn('chevd', 'Move section ' + n + ' down', { attrs: 'data-fl-sdown="' + esc(s.id) + '"', cls: 'sm ghost' })
        + UI.btn('Conditions', { size: 'xs', icon: 'branch', attrs: 'data-fl-cond="section:' + esc(s.id) + '" aria-label="Conditions for section ' + n + '"' }) + UI.btn('Remove section', { size: 'xs', kind: 'ghost', attrs: 'data-fl-srm="' + esc(s.id) + '" aria-label="Remove section ' + n + '"', disabled: total < 2 }) + '</div>'
      : '<div><b>' + esc(s.title || 'Section ' + n) + '</b>' + (s.help ? ' <span class="muted">' + esc(s.help) + '</span>' : '') + (s.collapsible ? ' ' + UI.pill('collapsible', 'outline') : '') + '</div>';
    return '<div class="apf-sec" role="group" aria-label="Section ' + n + (s.title ? ': ' + esc(s.title) : '') + '" data-fl-secbox="' + esc(s.id) + '">' + head + (cl ? '<div class="apf-cond mono">' + esc(cl) + '</div>' : '') + (rows || '<div class="muted" style="font-size:12px">No fields in this section yet: add one, or move one here with its Section list.</div>') + '</div>';
  }
  function layoutEditor(ctx, deps, ent, def, design, spare) {
    const mode = modeOf(def); const counter = { n: 0 };
    let html = design ? '<div class="hstack wrap gap6"><span class="fl" id="apf-mode-l" style="font-size:12px;font-weight:600;color:var(--fg2)">Layout</span>' + UI.seg(MODES, mode, 'data-fl-mode aria-labelledby="apf-mode-l"') + (mode === 'wizard' ? UI.check('Review step before submitting', !!def.layout.review, 'data-fl-review') : '') + '</div>' : '<div class="muted" style="font-size:12px">Layout: ' + esc(layoutText(def)) + '</div>';
    if (mode === 'flat') html += '<div>' + (def.fields.map((x) => fieldRow(ctx, deps, ent, def, x, ++counter.n, design)).join('') || '<div class="muted" style="font-size:12px">No fields yet.</div>') + '</div>';
    else if (mode === 'sections') html += sectionOrder(def).map((sid) => sectionCard(ctx, deps, ent, def, secById(def, sid), counter, design, false)).join('');
    else html += (def.layout.steps || []).map((t, i) => {
      const cl = condLine(t); const total = def.layout.steps.length;
      const head = design ? '<div class="apf-head">' + UI.field('Step ' + (i + 1) + ' title', UI.input(t.title || '', { attrs: 'data-fl-tv="' + esc(t.id) + '|title"' })) + UI.field('Help', UI.input(t.help || '', { attrs: 'data-fl-tv="' + esc(t.id) + '|help"' })) + '</div>'
        + '<div class="hstack wrap gap6"><span class="grow"></span>' + UI.iconbtn('chev', 'Move step ' + (i + 1) + ' up', { attrs: 'data-fl-tup="' + esc(t.id) + '"', cls: 'sm ghost' }) + UI.iconbtn('chevd', 'Move step ' + (i + 1) + ' down', { attrs: 'data-fl-tdown="' + esc(t.id) + '"', cls: 'sm ghost' })
          + UI.btn('Conditions', { size: 'xs', icon: 'branch', attrs: 'data-fl-cond="step:' + esc(t.id) + '" aria-label="Conditions for step ' + (i + 1) + '"' }) + UI.btn('Add section', { size: 'xs', icon: 'plus', attrs: 'data-fl-addsec="' + esc(t.id) + '" aria-label="Add a section to step ' + (i + 1) + '"' }) + UI.btn('Remove step', { size: 'xs', kind: 'ghost', attrs: 'data-fl-trm="' + esc(t.id) + '" aria-label="Remove step ' + (i + 1) + '"', disabled: total < 2 }) + '</div>'
        : '<div><b>Step ' + (i + 1) + ': ' + esc(t.title) + '</b></div>';
      return '<div class="apf-step" role="group" aria-label="Step ' + (i + 1) + ': ' + esc(t.title || '') + '">' + head + (cl ? '<div class="apf-cond mono">' + esc(cl) + '</div>' : '') + t.sections.map((sid) => (secById(def, sid) ? sectionCard(ctx, deps, ent, def, secById(def, sid), counter, design, true) : '')).join('') + '</div>';
    }).join('');
    if (design) html += '<div class="hstack wrap gap6">' + UI.btn('Add field', { size: 'sm', icon: 'plus', attrs: 'data-fadd', disabled: !spare.length }) + (mode === 'sections' ? UI.btn('Add section', { size: 'sm', icon: 'plus', attrs: 'data-fl-addsec=""' }) : '') + (mode === 'wizard' ? UI.btn('Add step', { size: 'sm', icon: 'plus', attrs: 'data-fl-addstep' }) : '')
      + '<span class="muted" style="font-size:12px">A condition reads fields earlier on the form. On submission the server keeps only the fields shown given the earlier answers (their step\'s, section\'s and own conditions); the rest is dropped and counted.</span></div>';
    return html;
  }

  // ---------- the tab ----------
  App.appsForms = function (ctx, app, design, canWrite, deps) {
    const st = ctx.state;
    st.pvStep = st.pvStep || {};
    const A = '/api/apps/' + enc(app.id);
    const forms = app.forms;
    if (!st.form || !forms.some((f) => f.id === st.form)) st.form = forms[0] ? forms[0].id : null;
    const form = forms.find((f) => f.id === st.form) || null;
    const entOf = (f) => app.entities.find((e) => e.name === f.entity) || null;
    const rows = forms.map((f) => ({ cells: ['<span class="mono">' + esc(f.name) + '</span>', esc(f.title || ''), esc((entOf(f) || {}).title || f.entity), f.public ? UI.pill('public link', 'warn') : UI.pill('private', 'outline'), '<span class="num">' + f.ratePerMinute + '</span>', '<span class="num">' + f.definition.fields.length + '</span>', esc(layoutText(f.definition))], attrs: 'data-form="' + esc(f.id) + '" tabindex="0" aria-label="Form ' + esc(f.name) + '"', selected: f.id === st.form }));
    const table = '<style>' + CSS + '</style>' + UI.panel('Forms', UI.table(['Name', 'Title', 'Entity', 'Access', 'Per minute', 'Fields', 'Layout'], rows, { minWidth: '0', emptyTitle: 'No forms', emptyText: 'A form lists an entity\'s fields in sections or wizard steps and can be published as a link.' }) + (design ? '<div>' + UI.btn('New form', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-newform', disabled: !app.entities.length }) + '</div>' : ''));
    const pick = (id) => { st.form = id; st.lastSubmit = null; ctx.rerender(); };
    ctx.on('click', 'tr[data-form]', (e, t) => pick(t.dataset.form));
    ctx.on('keydown', 'tr[data-form]', (e, t) => { if (e.target !== t || (e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); pick(t.dataset.form); });
    ctx.on('click', '[data-newform]', () => deps.openNewForm());
    if (!form) return table;

    const ent = entOf(form);
    if (!st.fdraft || st.fdraft.id !== form.id || st.fdraft.at !== form.updatedAt) st.fdraft = { id: form.id, at: form.updatedAt, title: form.title, definition: clone(form.definition), ratePerMinute: form.ratePerMinute, dirty: false };
    const fd = st.fdraft; const def = fd.definition;
    // 1.8.0 (B-140): who else designs this form (design-presence.js); the first change takes the edit lock, and someone
    // else's lock leaves the builder read-only here. Unsaved changes lost to a takeover are kept on this device.
    const dp = design && App.designPresence ? App.designPresence.use('app-form', { kind: 'app-form', app: app.id, id: form.id, title: form.title || form.name }, { unsaved: () => !!(st.fdraft && st.fdraft.dirty), snapshot: () => (st.fdraft ? { title: st.fdraft.title, definition: st.fdraft.definition, ratePerMinute: st.fdraft.ratePerMinute } : null), onRestore(d) { if (!d || !d.definition) return; st.fdraft = { id: form.id, at: form.updatedAt, title: d.title, definition: d.definition, ratePerMinute: d.ratePerMinute, dirty: true }; ctx.rerender(); } }) : null;
    const edit = design && !(dp && App.designPresence.readOnly(dp));
    if (dp && fd.dirty) App.designPresence.claim(dp);
    const spare = ent ? deps.fieldsOf(ent).filter((f) => !deps.computed(f) && !def.fields.some((x) => x.field === f.name)) : [];
    const missingRequired = ent ? deps.fieldsOf(ent).filter((f) => f.required && !def.fields.some((x) => x.field === f.name)).map((f) => f.name) : [];
    const badPublic = form.public && ent ? def.fields.map((x) => deps.fieldByName(ent, x.field)).filter((f) => f && (f.type === 'file' || f.type === 'reference' || (f.type === 'lookup' && f.source !== 'static'))).map((f) => f.name) : [];
    const pv = st.preview[form.id] || (st.preview[form.id] = {});
    const link = st.formToken && st.formToken.id === form.id ? location.origin + '/form#token=' + st.formToken.token : '';
    const tokenBox = link ? UI.notice('<b>Public link for ' + esc(form.name) + '. Copy it now; its token is shown once.</b><div class="mono apps-token" style="margin-top:4px;overflow-wrap:anywhere">' + esc(link) + '</div><div class="muted" style="font-size:12px;margin-top:4px">The page at /form reads the token from the part after #, which never reaches a server log, and opens the form with POST /api/public/forms/open and submits with /api/public/forms/submit, as no one (createdBy null, source form), limited per address and per form, then 429 with Retry-After. An older link stopped working.</div>', 'warn', UI.btn('Copy', { size: 'sm', attrs: 'data-ftokencopy' }) + UI.btn('Done', { kind: 'ghost', size: 'sm', attrs: 'data-fdone' })) : form.public ? '<div class="muted" style="font-size:12px">Public link active (the page /form#token=…). The token is not stored in clear; rotate it to get a new link.</div>' : '';
    const editor = edit ? '<div class="formgrid">' + UI.field('Title', UI.input(fd.title || '', { attrs: 'data-ftitle' })) + UI.field('Per minute (public)', UI.input(fd.ratePerMinute, { type: 'number', attrs: 'data-frate' })) + UI.field('Submit label', UI.input(def.submitLabel || '', { attrs: 'data-fsubmit', placeholder: 'Submit' })) + UI.field('Success message', UI.input(def.successMessage || '', { attrs: 'data-fsuccess' })) + '</div>'
      + '<div class="hstack wrap gap6">' + UI.btn('Save form', { kind: 'primary', size: 'sm', attrs: 'data-fsave', disabled: !!missingRequired.length || !def.fields.length }) + (fd.dirty ? '<span class="muted" style="font-size:12px">Unsaved changes</span>' : '') + (form.public ? UI.btn('Rotate link', { size: 'sm', icon: 'refresh', attrs: 'data-frotate' }) + UI.btn('Unpublish', { size: 'sm', attrs: 'data-funpublish' }) : UI.btn('Publish public link', { size: 'sm', icon: 'link', attrs: 'data-fpublish' })) + UI.btn('Delete form', { size: 'sm', kind: 'ghost', attrs: 'data-fdelete' }) + '</div>' : '';
    const prob = st.formProblem && st.formProblem.id === form.id ? UI.problem(st.formProblem.title, st.formProblem.text + (st.formProblem.list && st.formProblem.list.length > 1 ? ' Also: ' + st.formProblem.list.slice(1, 6).join(' ') : ''), st.formProblem.trace || false) : '';
    const submitted = st.lastSubmit && st.lastSubmit.id === form.id ? UI.notice('<b>201 Submitted.</b> Record <span class="mono">' + esc(st.lastSubmit.rec) + '</span> created; dropped: ' + (st.lastSubmit.dropped.length ? '<span class="mono">' + esc(st.lastSubmit.dropped.join(', ')) + '</span>' : 'none') + '. Every text value passed the user-input checkpoint.', 'ok') : '';
    const builder = UI.panel((design ? 'Builder: ' : 'Form: ') + esc(form.title || form.name), (dp ? App.designPresence.bar(dp) : '') + (missingRequired.length ? UI.notice('<b>The form must ask for every field the entity requires.</b> Missing: <span class="mono">' + esc(missingRequired.join(', ')) + '</span>. Saving is refused until they are added.', 'warn') : '') + (badPublic.length ? UI.notice('<b>A public form cannot ask for files, references or user, workspace or record lookups.</b> Remove <span class="mono">' + esc(badPublic.join(', ')) + '</span> or make the form private.', 'danger') : '') + prob
      + '<div class="grid2"><div class="vstack gap12" style="min-width:0"><div class="eyebrow">Layout and fields</div>' + (ent ? layoutEditor(ctx, deps, ent, def, edit, spare) : UI.notice('The entity of this form is gone.', 'warn')) + editor + tokenBox
      + '</div><div class="vstack gap12" style="min-width:0"><div class="eyebrow">Live preview</div>' + (ent ? previewHtml(ctx, form, ent, def, pv, deps, canWrite) : '') + '<span class="muted" style="font-size:12px">Fields, sections and steps hidden by a condition disappear as you answer; Next checks the step\'s required fields. Submitting writes a record with source form through the saved form and reports the dropped fields.</span>' + submitted + '</div></div>',
      { actions: UI.pill(form.public ? 'public link' : 'private', form.public ? 'warn' : 'outline') });

    const F = A + '/forms/' + enc(form.id);
    // the preview
    const ps = st.pvStep[form.id] || (st.pvStep[form.id] = { cur: 0, missing: [] });
    const pvSet = (t) => { const f = ent ? deps.fieldByName(ent, t.dataset.fv) : null; let v = t.value; if (v === '') v = null; else if (f && f.type === 'number') v = Number(v); else if (f && f.type === 'boolean') v = v === 'true'; pv[t.dataset.fv] = v; const i = ps.missing.indexOf(t.dataset.fv); if (i >= 0 && v != null) ps.missing.splice(i, 1); };
    const shownNow = () => (ent ? previewPlan(ent, def, pv, deps).p.visible.join(',') : '');
    const shownAtRender = shownNow();
    ctx.on('input', '[data-pv]', (e, t) => pvSet(t));
    // A condition may show or hide later fields, sections or steps: re-render once focus has moved on, and keep it.
    ctx.on('change', '[data-pv]', (e, t) => { pvSet(t); setTimeout(() => { if (App.state.route !== 'apps' || deps.overlayOpen() || shownNow() === shownAtRender) return; const a = document.activeElement; const fv = a && a.dataset ? a.dataset.fv : null; ctx.rerender(); const el = fv ? ctx.$('[data-pv][data-fv="' + fv + '"]') : null; if (el) el.focus(); }, 0); });
    const capturePv = () => ctx.$$('.apps-preview [data-pv]').forEach(pvSet);
    const goStep = (i) => { ps.cur = i; ctx.rerender(); const h = ctx.$('[data-pvstep-h]'); if (h) h.focus(); };
    ctx.on('click', '[data-pvgoto]', (e, t) => { capturePv(); ps.missing = []; goStep(+t.dataset.pvgoto); });
    ctx.on('click', '[data-pvback]', () => { capturePv(); ps.missing = []; goStep(ps.cur - 1); });
    ctx.on('click', '[data-pvnext]', () => {
      capturePv();
      const { p, pages } = previewPlan(ent, def, pv, deps); const here = pages[ps.cur];
      const miss = p.missing.filter((m) => here === '_page' || m.step === here).map((m) => m.field);
      ps.missing = miss;
      if (miss.length) { ctx.rerender(); const el = ctx.$('.apps-preview [data-fv="' + miss[0] + '"]'); if (el) el.focus(); return; }
      goStep(ps.cur + 1);
    });
    ctx.on('click', '[data-ftest]', async () => {
      if (!ent) return; capturePv();
      const { p, pages } = previewPlan(ent, def, pv, deps);
      // Only what the form shows is sent; the server drops anything else again and checks required fields itself.
      const values = {}; Object.keys(p.values).forEach((k) => { if (p.values[k] != null && p.values[k] !== '') values[k] = p.values[k]; });
      try { const out = await App.post(F + '/submit', { values }); st.lastSubmit = { id: form.id, rec: out.id, dropped: out.dropped || [] }; st.preview[form.id] = {}; st.pvStep[form.id] = { cur: 0, missing: [] }; st.recsKey = st.busyRecs = null; ctx.rerender(); ctx.toast('201: ' + esc(def.successMessage || 'Submitted.') + ' Audited app.form.submitted.', 'ok'); }
      catch (err) {
        const pr = (err.problem && err.problem.problems) || [];
        const fields = pr.filter((x) => x && x.field).map((x) => x.field);
        if (fields.length) { ps.missing = fields; const step = pr[0].step; const at = step ? pages.indexOf(step) : -1; if (at >= 0) ps.cur = at; ctx.rerender(); }
        App.fail(err, 'The form was not submitted');
      }
    });
    if (dp) App.designPresence.bind(ctx, dp);
    if (!edit) return table + builder;

    // the editor
    const capture = () => { const g = (s) => ctx.$(s); if (g('[data-ftitle]')) { fd.title = g('[data-ftitle]').value; fd.ratePerMinute = +g('[data-frate]').value || fd.ratePerMinute; def.submitLabel = g('[data-fsubmit]').value; def.successMessage = g('[data-fsuccess]').value; } };
    const touch = () => { capture(); fd.dirty = true; rerenderKeep(ctx, deps.overlayOpen); };
    ctx.on('input', '[data-ftitle],[data-frate],[data-fsubmit],[data-fsuccess]', () => { capture(); fd.dirty = true; if (dp) App.designPresence.claim(dp); });
    ctx.on('click', '[data-fl-mode] [data-seg]', async (e, t) => {
      const to = t.dataset.seg; const from = modeOf(def); if (to === from) return;
      const partConds = def.layout ? def.layout.sections.some((s) => s.visibleIf || s.requiredIf) || (def.layout.steps || []).some((s) => s.visibleIf || s.requiredIf) : false;
      if ((to === 'flat' && def.layout && (def.layout.sections.length > 1 || partConds)) || (from === 'wizard' && to === 'sections' && (def.layout.steps || []).some((s) => s.visibleIf || s.requiredIf || s.help))) {
        const ok = await ctx.confirm({ title: to === 'flat' ? 'Make it one list' : 'Leave the wizard', tone: 'warn', body: '<p class="fg2" style="margin:0">' + (to === 'flat' ? 'Section titles, help and the conditions of sections and steps are dropped; the fields keep their order and their own conditions.' : 'Step titles, help and step conditions are dropped; sections and their fields stay.') + '</p>', ok: 'Change layout' });
        if (!ok) return;
      }
      setMode(def, to); st.pvStep[form.id] = { cur: 0, missing: [] }; touch();
    });
    ctx.on('change', '[data-fl-review]', (e, t) => { def.layout.review = t.checked; touch(); });
    // fields
    const moveField = (name, dir) => {
      if (!def.layout) { const a = def.fields; const i = a.findIndex((f) => f.field === name); const j = i + dir; if (j < 0 || j >= a.length) return false; a.splice(j, 0, a.splice(i, 1)[0]); return true; }
      const s = sectionOfField(def, name); if (!s) return false; const i = s.fields.indexOf(name); const j = i + dir;
      if (j >= 0 && j < s.fields.length) { s.fields.splice(j, 0, s.fields.splice(i, 1)[0]); reorderFields(def); return true; }
      // Past the edge of its section: into the neighbouring section, at the near end.
      const sids = sectionOrder(def); const k = sids.indexOf(s.id) + dir; if (k < 0 || k >= sids.length) return false;
      const to = secById(def, sids[k]); s.fields.splice(i, 1); if (dir < 0) to.fields.push(name); else to.fields.unshift(name); reorderFields(def); return true;
    };
    ctx.on('click', '[data-fl-up],[data-fl-down]', (e, t) => { const up = t.hasAttribute('data-fl-up'); if (moveField(up ? t.dataset.flUp : t.dataset.flDown, up ? -1 : 1)) touch(); else ctx.toast('Already at the ' + (up ? 'top' : 'bottom') + ' of the form.'); });
    ctx.on('change', '[data-fl-fsec]', (e, t) => { const name = t.dataset.flFsec; const from = sectionOfField(def, name); const to = secById(def, t.value); if (!to || from === to) return; if (from) from.fields.splice(from.fields.indexOf(name), 1); to.fields.push(name); reorderFields(def); touch(); });
    ctx.on('click', '[data-fdel]', (e, t) => { const name = t.dataset.fdel; def.fields.splice(def.fields.findIndex((f) => f.field === name), 1); const s = sectionOfField(def, name); if (s) s.fields.splice(s.fields.indexOf(name), 1); touch(); });
    const reopen = () => { fd.dirty = true; ctx.rerender(); };
    ctx.on('click', '[data-fadd]', () => { capture(); openFieldModal(ctx, deps, ent, def, null, spare, reopen); });
    ctx.on('click', '[data-fedit]', (e, t) => { capture(); openFieldModal(ctx, deps, ent, def, t.dataset.fedit, spare, reopen); });
    ctx.on('click', '[data-fl-cond]', (e, t) => { capture(); openConditions(ctx, deps, ent, def, t.dataset.flCond, reopen); });
    // sections
    const parts = (k) => { const i = k.lastIndexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };
    ctx.on('input', '[data-fl-sv]', (e, t) => { const [id, key] = parts(t.dataset.flSv); const s = secById(def, id); if (s) { s[key] = t.value; fd.dirty = true; } });
    ctx.on('change', '[data-fl-sv]', () => touch());
    ctx.on('change', '[data-fl-sc]', (e, t) => { const [id, key] = parts(t.dataset.flSc); const s = secById(def, id); if (!s) return; s[key] = t.checked; if (key === 'collapsible' && !t.checked) delete s.collapsed; touch(); });
    const moveIn = (list, item, dir) => { const i = list.indexOf(item); const j = i + dir; if (i < 0 || j < 0 || j >= list.length) return false; list.splice(j, 0, list.splice(i, 1)[0]); return true; };
    ctx.on('click', '[data-fl-sup],[data-fl-sdown]', (e, t) => {
      const up = t.hasAttribute('data-fl-sup'); const id = up ? t.dataset.flSup : t.dataset.flSdown; let moved;
      if (def.layout.mode === 'wizard') { const stp = stepOfSection(def, id); moved = stp && moveIn(stp.sections, id, up ? -1 : 1); if (!moved && stp) { const steps = def.layout.steps; const k = steps.indexOf(stp) + (up ? -1 : 1); if (k >= 0 && k < steps.length) { stp.sections.splice(stp.sections.indexOf(id), 1); if (up) steps[k].sections.push(id); else steps[k].sections.unshift(id); moved = true; } } }
      else { const ids = def.layout.sections.map((s) => s.id); moved = moveIn(ids, id, up ? -1 : 1); if (moved) def.layout.sections.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); }
      if (moved) { reorderFields(def); touch(); } else ctx.toast('Already at the ' + (up ? 'top' : 'bottom') + '.');
    });
    ctx.on('click', '[data-fl-srm]', (e, t) => {
      const id = t.dataset.flSrm; const sids = sectionOrder(def); if (sids.length < 2) return;
      const s = secById(def, id); const k = sids.indexOf(id); const into = secById(def, sids[k > 0 ? k - 1 : 1]);
      into.fields = into.fields.concat(s.fields); def.layout.sections.splice(def.layout.sections.indexOf(s), 1);
      (def.layout.steps || []).forEach((stp) => { const i = stp.sections.indexOf(id); if (i >= 0) stp.sections.splice(i, 1); });
      (def.layout.steps || []).filter((stp) => !stp.sections.length).forEach((stp) => { def.layout.steps.splice(def.layout.steps.indexOf(stp), 1); });
      reorderFields(def); ctx.toast('Section removed; its fields moved to ' + esc(into.title || 'the section ' + (k > 0 ? 'before' : 'after')) + '.'); touch();
    });
    ctx.on('click', '[data-fl-addsec]', (e, t) => {
      const sid = freeId('section', def.layout.sections.map((s) => s.id)); def.layout.sections.push({ id: sid, title: 'Section ' + (def.layout.sections.length + 1), fields: [] });
      const stp = t.dataset.flAddsec ? stepById(def, t.dataset.flAddsec) : null; if (stp) stp.sections.push(sid);
      fd.dirty = true; ctx.rerender(); const el = ctx.$('[data-fl-sv="' + sid + '|title"]'); if (el) { el.focus(); el.select(); }
    });
    ctx.on('change', '[data-fl-sstep]', (e, t) => { const id = t.dataset.flSstep; const from = stepOfSection(def, id); const to = stepById(def, t.value); if (!to || from === to) return; if (from) { from.sections.splice(from.sections.indexOf(id), 1); if (!from.sections.length) { const k = def.layout.steps.indexOf(from); def.layout.steps.splice(k, 1); ctx.toast('Its step had no other section and was removed.'); } } to.sections.push(id); reorderFields(def); touch(); });
    // steps
    ctx.on('input', '[data-fl-tv]', (e, t) => { const [id, key] = parts(t.dataset.flTv); const s = stepById(def, id); if (s) { s[key] = t.value; fd.dirty = true; } });
    ctx.on('change', '[data-fl-tv]', () => touch());
    ctx.on('click', '[data-fl-tup],[data-fl-tdown]', (e, t) => { const up = t.hasAttribute('data-fl-tup'); const s = stepById(def, up ? t.dataset.flTup : t.dataset.flTdown); if (moveIn(def.layout.steps, s, up ? -1 : 1)) { reorderFields(def); touch(); } else ctx.toast('Already at the ' + (up ? 'first' : 'last') + ' step.'); });
    ctx.on('click', '[data-fl-trm]', (e, t) => { const steps = def.layout.steps; if (steps.length < 2) return; const s = stepById(def, t.dataset.flTrm); const k = steps.indexOf(s); const into = steps[k > 0 ? k - 1 : 1]; into.sections = into.sections.concat(s.sections); steps.splice(k, 1); reorderFields(def); ctx.toast('Step removed; its sections moved to ' + esc(into.title) + '.'); st.pvStep[form.id] = { cur: 0, missing: [] }; touch(); });
    ctx.on('click', '[data-fl-addstep]', () => {
      const sid = freeId('section', def.layout.sections.map((s) => s.id)); const tid = freeId('step', def.layout.steps.map((s) => s.id));
      def.layout.sections.push({ id: sid, title: '', fields: [] }); def.layout.steps.push({ id: tid, title: 'Step ' + (def.layout.steps.length + 1), sections: [sid] });
      fd.dirty = true; ctx.rerender(); const el = ctx.$('[data-fl-tv="' + tid + '|title"]'); if (el) { el.focus(); el.select(); }
    });
    // save, publish, delete
    ctx.on('click', '[data-fsave]', async () => {
      capture();
      const body = { definition: payload(def), ratePerMinute: fd.ratePerMinute }; if (fd.title && fd.title.trim()) body.title = fd.title.trim();
      try { await App.patch(F, body); st.formProblem = null; st.fdraft = null; deps.afterChange({}); ctx.toast('Form saved. Audited app.form.updated.', 'ok'); }
      catch (err) { const list = ((err.problem && err.problem.problems) || []).map((x) => (typeof x === 'string' ? x : x.message || JSON.stringify(x))); st.formProblem = { id: form.id, title: 'Form not saved', text: deps.detailOf(err), list, trace: deps.traceOf(err) }; ctx.rerender(); }
    });
    const publish = async (enabled, title, body, okLabel, msg) => {
      const ok = await ctx.confirm({ title, tag: enabled ? 'anyone with the link' : '', tone: 'warn', body: '<p class="fg2" style="margin:0">' + body + '</p>', ok: okLabel });
      if (!ok) return;
      try { const out = await App.post(F + '/public', { enabled }); st.formToken = enabled && out.token ? { id: form.id, token: out.token } : null; deps.afterChange({}); ctx.toast(msg, 'ok'); }
      catch (err) { st.formProblem = { id: form.id, title: enabled ? 'Not published' : 'Still public', text: deps.detailOf(err), trace: deps.traceOf(err) }; ctx.rerender(); }
    };
    ctx.on('click', '[data-fpublish]', () => publish(true, 'Publish ' + form.name + ' as a public link', 'Anyone with the link can open the form and submit records as no one. Only the fields the form shows are written; the entity\'s other fields are never revealed. Limited per address and per form (' + form.ratePerMinute + ' a minute).', 'Publish', 'Form published. Audited app.form.published.'));
    ctx.on('click', '[data-frotate]', () => publish(true, 'Rotate the public link', 'A new token is issued and shown once; the older link stops working at once.', 'Rotate', 'Link rotated. Audited app.form.link.rotated.'));
    ctx.on('click', '[data-funpublish]', () => publish(false, 'Make ' + form.name + ' private', 'The public link stops working. Signed-in members can still submit it.', 'Unpublish', 'Form is private again. Audited app.form.unpublished.'));
    ctx.on('click', '[data-fdone]', () => { st.formToken = null; ctx.rerender(); });
    ctx.on('click', '[data-ftokencopy]', () => { if (!link) return; (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject(new Error('no clipboard'))).then(() => ctx.toast('Link copied.'), () => ctx.toast('Select the link and copy it.', 'warn')); });
    ctx.on('click', '[data-fdelete]', async () => {
      const ok = await ctx.confirm({ title: 'Delete form ' + form.name, tone: 'danger', body: '<p class="fg2" style="margin:0">Its public link, if any, stops working. Records it created stay.</p>', ok: 'Delete' });
      if (!ok) return;
      try { await App.del(F); st.form = null; st.fdraft = null; deps.afterChange({}); ctx.toast('Form deleted. Audited app.form.deleted.', 'warn'); } catch (err) { App.fail(err, 'Could not delete the form'); }
    });
    return table + builder;
  };
})();
