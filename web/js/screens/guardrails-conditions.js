// Guardrails, the condition tree editor (1.9.0, B-157): a rule whose mechanism is `conditions` is an all/any/none tree
// of mechanisms (pattern, term list, classifier categories with a threshold each, detector) and facts about the check
// (surface, channel, label, role, account age, new account, spam score), up to four groups deep. `guardrails.js` calls
// App.guardrailConditions.render(tree, opts) for the markup and .bind(ctx, getTree, setTree) for its handlers. Every
// control is a native button, select or field, so the tree is edited from the keyboard: add, remove, move up and down,
// and change a group's kind. `explain(e)` draws what a test run or the live test found, branch by branch.
(function () {
  const { UI, esc } = App;
  const MAX_DEPTH = 4;
  const GROUPS = [{ value: 'all', label: 'All of these match' }, { value: 'any', label: 'Any of these matches' }, { value: 'none', label: 'None of these matches' }];
  const LEAVES = [{ value: 'pattern', label: 'Pattern (RE2)' }, { value: 'term-list', label: 'Term list' }, { value: 'category', label: 'Classifier categories' }, { value: 'detector', label: 'Detector' }, { value: 'context', label: 'Fact about the check' }];
  const FIELDS = [{ value: 'surface', label: 'surface' }, { value: 'channel', label: 'channel' }, { value: 'label', label: 'label' }, { value: 'role', label: 'role' }, { value: 'accountAgeDays', label: 'account age in days' }, { value: 'newAccount', label: 'new account' }, { value: 'spamScore', label: 'spam score (0 to 100)' }];
  const OPS = [{ value: 'eq', label: 'is' }, { value: 'ne', label: 'is not' }, { value: 'in', label: 'is one of' }, { value: 'not_in', label: 'is none of' }, { value: 'gt', label: 'is more than' }, { value: 'gte', label: 'is at least' }, { value: 'lt', label: 'is less than' }, { value: 'lte', label: 'is at most' }, { value: 'truthy', label: 'is true' }, { value: 'falsy', label: 'is false' }];
  const NO_VALUE = { truthy: 1, falsy: 1, exists: 1, not_exists: 1 };
  const NUMERIC = { accountAgeDays: 1, spamScore: 1 };
  const DEFAULTS = {
    pattern: () => ({ kind: 'pattern', pattern: '(?i)replace-me' }),
    'term-list': (lists) => ({ kind: 'term-list', list: lists && lists[0] ? lists[0].id : '', version: 'latest' }),
    category: () => ({ kind: 'category', classifier: 'safety', thresholds: { S1: 0.5, S10: 0.8 } }),
    detector: () => ({ kind: 'detector', family: 'pii', detectors: ['*'], threshold: 0.8 }),
    context: () => ({ kind: 'context', field: 'newAccount', op: 'truthy' })
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const groupKind = (n) => (n && typeof n === 'object' ? (Array.isArray(n.all) ? 'all' : Array.isArray(n.any) ? 'any' : Array.isArray(n.none) ? 'none' : null) : null);
  const kids = (n) => n[groupKind(n)];
  const depthOf = (path) => path.split('.').length; // the root group is 1
  const label = (path) => path.split('.').slice(1).map((x) => Number(x) + 1).join('.') || 'top';
  const nodeAt = (tree, path) => { let n = tree; path.split('.').slice(1).forEach((i) => { n = kids(n)[Number(i)]; }); return n; };
  const parentOf = (tree, path) => { const parts = path.split('.'); return { parent: nodeAt(tree, parts.slice(0, -1).join('.')), index: Number(parts[parts.length - 1]) }; };

  /** A tree the editor can show: its root is always a group. */
  const normalised = (tree) => (groupKind(tree) ? tree : { all: tree ? [tree] : [DEFAULTS.pattern()] });

  function leafHtml(leaf, path, opts) {
    const dis = opts.disabled ? ' disabled' : '';
    const at = ' data-path="' + path + '"' + dis;
    const f = (lab, name, value, hint, mono) => UI.field(lab, UI.input(value == null ? '' : String(value), { attrs: 'class="input' + (mono ? ' mono' : '') + '" data-ce-f="' + name + '"' + at }), hint);
    let body = '';
    if (leaf.kind === 'pattern') body = f('Pattern', 'pattern', leaf.pattern, 'RE2: no backreferences, no lookaround.', true);
    else if (leaf.kind === 'term-list') {
      const lists = opts.lists || [];
      body = UI.field('List', UI.select([{ value: '', label: lists.length ? 'Pick a list' : 'No term lists yet' }].concat(lists.map((l) => ({ value: l.id, label: l.name + ' (' + l.kind + ')' }))), leaf.list || '', 'data-ce-f="list"' + at))
        + f('Version', 'version', leaf.version, 'latest, or a version number to pin it.');
    } else if (leaf.kind === 'category') {
      body = f('Classifier', 'classifier', leaf.classifier || 'safety', 'safety is Llama Guard\'s S1 to S14.') + f('Thresholds', 'thresholds', Object.keys(leaf.thresholds || {}).map((k) => k + ' ' + leaf.thresholds[k]).join(', '), 'Category and threshold pairs, for example S1 0.5, S10 0.8.');
    } else if (leaf.kind === 'detector') {
      body = UI.field('Detector', UI.select([{ value: 'pii', label: 'personal data' }, { value: 'secrets', label: 'secrets' }], leaf.family, 'data-ce-f="family"' + at)) + f('Kinds', 'detectors', (leaf.detectors || []).join(', '), '* or, for example, email, payment_card.') + f('Threshold', 'threshold', leaf.threshold);
    } else {
      const val = leaf.value === undefined ? '' : Array.isArray(leaf.value) ? leaf.value.join(', ') : String(leaf.value);
      body = UI.field('Fact', UI.select(FIELDS, leaf.field, 'data-ce-f="field"' + at)) + UI.field('Test', UI.select(OPS, leaf.op, 'data-ce-f="op"' + at)) + (NO_VALUE[leaf.op] ? '' : f('Value', 'value', val, leaf.op === 'in' || leaf.op === 'not_in' ? 'Separate values with commas.' : leaf.field === 'label' ? 'public, internal, confidential or restricted.' : ''));
    }
    const n = label(path);
    return '<div class="gc-leaf" role="group" aria-label="Condition ' + esc(n) + '">'
      + '<div class="gc-row">' + UI.field('Condition ' + n, UI.select(LEAVES, leaf.kind, 'data-ce-leafkind' + at)) + body + '</div>'
      + moveButtons(path, 'condition ' + n, opts) + '</div>';
  }

  function moveButtons(path, what, opts) {
    if (path === '0' || opts.disabled) return '';
    const { index } = { index: Number(path.split('.').pop()) };
    const siblings = opts.siblings[path] || 1;
    return '<div class="hstack wrap gc-acts">'
      + UI.btn('Move up', { size: 'xs', kind: 'ghost', attrs: 'data-ce-move="up" data-path="' + path + '" aria-label="Move ' + esc(what) + ' up"', disabled: index === 0 })
      + UI.btn('Move down', { size: 'xs', kind: 'ghost', attrs: 'data-ce-move="down" data-path="' + path + '" aria-label="Move ' + esc(what) + ' down"', disabled: index >= siblings - 1 })
      + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-ce-del data-path="' + path + '" aria-label="Remove ' + esc(what) + '"' }) + '</div>';
  }

  function groupHtml(node, path, opts) {
    const k = groupKind(node);
    const list = kids(node);
    list.forEach((c, i) => { opts.siblings[path + '.' + i] = list.length; });
    const n = label(path);
    const dis = opts.disabled ? ' disabled' : '';
    const deep = depthOf(path) >= MAX_DEPTH;
    return '<div class="gc-group" role="group" aria-label="Group ' + esc(n) + ': ' + esc((GROUPS.find((g) => g.value === k) || GROUPS[0]).label.toLowerCase()) + '">'
      + '<div class="hstack wrap gc-head">' + UI.field(path === '0' ? 'The rule fires when' : 'Group ' + n, UI.select(GROUPS, k, 'data-ce-kind data-path="' + path + '"' + dis))
      + (opts.disabled ? '' : '<span class="hstack wrap gc-acts">' + UI.btn('Add condition', { size: 'xs', attrs: 'data-ce-add="leaf" data-path="' + path + '" aria-label="Add a condition to group ' + esc(n) + '"' }) + UI.btn('Add group', { size: 'xs', attrs: 'data-ce-add="group" data-path="' + path + '" aria-label="Add a group to group ' + esc(n) + '"', disabled: deep, title: deep ? 'Groups nest at most four deep' : '' }) + '</span>') + '</div>'
      + (list.length ? '<ol class="gc-list">' + list.map((c, i) => '<li>' + (groupKind(c) ? groupHtml(c, path + '.' + i, opts) : leafHtml(c, path + '.' + i, opts)) + '</li>').join('') + '</ol>' : '<div class="muted" style="font-size:12px">' + (k === 'any' ? 'An empty group never matches.' : 'An empty group always matches.') + '</div>')
      + moveButtons(path, 'group ' + n, opts) + '</div>';
  }

  const CSS = '#main .gc-group{border:1px solid var(--line);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:8px;min-width:0}'
    + '#main .gc-group .gc-group{background:var(--panel)}#main .gc-list{list-style:none;margin:0;padding:0 0 0 12px;display:flex;flex-direction:column;gap:8px;border-left:2px solid var(--line)}'
    + '#main .gc-leaf{display:flex;flex-direction:column;gap:6px;min-width:0}#main .gc-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;min-width:0}'
    + '#main .gc-head{align-items:flex-end;gap:8px}#main .gc-acts{gap:4px}#main .gc-x{margin:0;padding-left:16px;font-size:12px}#main .gc-x li{margin:2px 0}';

  function parseField(leaf, name, raw) {
    const v = String(raw);
    if (name === 'threshold') leaf.threshold = Number(v);
    else if (name === 'detectors') leaf.detectors = v.split(',').map((x) => x.trim()).filter(Boolean);
    else if (name === 'version') leaf.version = v.trim() === '' || v.trim() === 'latest' ? 'latest' : Number(v);
    else if (name === 'thresholds') {
      const t = {};
      v.split(',').forEach((pair) => { const m = pair.trim().split(/\s+/); if (m[0]) t[m[0].toUpperCase().indexOf('S') === 0 ? m[0].toUpperCase() : m[0]] = m[1] === undefined ? 0.5 : Number(m[1]); });
      leaf.thresholds = t;
    } else if (name === 'op') {
      leaf.op = v;
      if (NO_VALUE[v]) delete leaf.value;
      else if ((v === 'in' || v === 'not_in') && !Array.isArray(leaf.value)) leaf.value = leaf.value === undefined || leaf.value === '' ? [] : [leaf.value];
      else if (v !== 'in' && v !== 'not_in' && Array.isArray(leaf.value)) leaf.value = leaf.value.length ? leaf.value[0] : '';
      if (leaf.value === undefined && !NO_VALUE[v]) leaf.value = NUMERIC[leaf.field] ? 0 : '';
    } else if (name === 'field') {
      leaf.field = v;
      if (NUMERIC[v] && (leaf.op === 'truthy' || leaf.op === 'falsy')) { leaf.op = 'gte'; leaf.value = 0; }
      if (v === 'newAccount') { leaf.op = 'truthy'; delete leaf.value; }
    } else if (name === 'value') {
      const conv = (x) => (NUMERIC[leaf.field] && x !== '' && !isNaN(Number(x)) ? Number(x) : x);
      leaf.value = leaf.op === 'in' || leaf.op === 'not_in' ? v.split(',').map((x) => conv(x.trim())).filter((x) => x !== '') : conv(v.trim());
    } else leaf[name] = v;
  }

  App.guardrailConditions = {
    defaultTree() { return { all: [DEFAULTS.pattern(), DEFAULTS.context()] }; },
    text(tree) {
      const t = normalised(tree); const n = (function count(x) { return groupKind(x) ? kids(x).reduce((a, c) => a + count(c), 0) : 1; })(t);
      return 'conditions (' + groupKind(t) + ', ' + n + ' test' + (n === 1 ? '' : 's') + ')';
    },
    render(tree, opts) {
      opts = Object.assign({ lists: [], disabled: false }, opts || {}, { siblings: {} });
      return '<style>' + CSS + '</style><div class="vstack" style="gap:8px" data-ce-root>' + groupHtml(normalised(tree), '0', opts) + '</div>';
    },
    /** Handlers for the editor; `setTree(next)` saves the change (and re-renders the screen). */
    bind(ctx, getTree, setTree, lists) {
      const change = (fn, focusSel) => {
        const t = clone(normalised(getTree()));
        fn(t);
        setTree(t);
        if (focusSel) { const el = document.querySelector('#main ' + focusSel); if (el && !el.disabled) el.focus(); }
      };
      ctx.on('change', '[data-ce-kind]', (e, el) => change((t) => {
        const node = nodeAt(t, el.dataset.path); const k = groupKind(node); const list = node[k]; delete node[k]; node[el.value] = list;
      }, '[data-ce-kind][data-path="' + el.dataset.path + '"]'));
      ctx.on('click', '[data-ce-add]', (e, el) => {
        const path = el.dataset.path; let added = null;
        change((t) => { const list = kids(nodeAt(t, path)); list.push(el.dataset.ceAdd === 'group' ? { all: [DEFAULTS.pattern()] } : DEFAULTS.context()); added = path + '.' + (list.length - 1); });
        const f = document.querySelector('#main [data-path="' + added + '"]'); if (f) f.focus();
      });
      ctx.on('click', '[data-ce-move]', (e, el) => {
        const path = el.dataset.path; const up = el.dataset.ceMove === 'up';
        const parts = path.split('.'); const i = Number(parts.pop()); const j = up ? i - 1 : i + 1; const to = parts.concat(String(j)).join('.');
        change((t) => { const { parent } = parentOf(t, path); const list = kids(parent); if (j < 0 || j >= list.length) return; const x = list[i]; list[i] = list[j]; list[j] = x; },
          '[data-ce-move="' + el.dataset.ceMove + '"][data-path="' + to + '"]');
        const f = document.querySelector('#main [data-ce-move="' + el.dataset.ceMove + '"][data-path="' + to + '"]');
        if (f && f.disabled) { const other = document.querySelector('#main [data-ce-move="' + (up ? 'down' : 'up') + '"][data-path="' + to + '"]'); if (other) other.focus(); }
      });
      ctx.on('click', '[data-ce-del]', (e, el) => {
        const path = el.dataset.path; const parts = path.split('.'); parts.pop(); const owner = parts.join('.');
        change((t) => { const { parent, index } = parentOf(t, path); kids(parent).splice(index, 1); }, '[data-ce-add="leaf"][data-path="' + owner + '"]');
      });
      ctx.on('change', '[data-ce-leafkind]', (e, el) => change((t) => {
        const { parent, index } = parentOf(t, el.dataset.path); kids(parent)[index] = DEFAULTS[el.value](lists);
      }, '[data-ce-leafkind][data-path="' + el.dataset.path + '"]'));
      ctx.on('change', '[data-ce-f]', (e, el) => change((t) => parseField(nodeAt(t, el.dataset.path), el.dataset.ceF, el.value)));
    },
    /** What a run found, node by node: matched, did not match, or was not needed. */
    explain(e) {
      if (!e) return '';
      const word = (n) => (!n.evaluated ? UI.pill('not needed', 'outline') : n.matched ? UI.pill('matched', 'ok') : UI.pill('no match', ''));
      const leaf = (n) => {
        const d = n.detail || {};
        const extra = [d.detail, d.value !== undefined && d.value !== null ? 'value ' + String(d.value) : d.value === null ? 'unknown' : null, d.score != null && d.detail == null ? 'score ' + Number(d.score).toFixed(2) : null].filter(Boolean).join('; ');
        return esc(d.test || 'condition') + (extra ? ' <span class="muted">(' + esc(extra) + ')</span>' : '') + (d.reasons && d.reasons.length ? '<ul class="gc-x">' + d.reasons.map((r) => '<li>' + esc(r.signal) + ': ' + esc(String(r.value)) + ' (threshold ' + esc(String(r.threshold)) + ')</li>').join('') + '</ul>' : '');
      };
      const node = (n) => '<li>' + word(n) + ' ' + (n.kind === 'leaf' ? leaf(n) : '<b>' + esc(n.kind) + '</b><ul class="gc-x">' + (n.children || []).map(node).join('') + '</ul>') + '</li>';
      return '<style>' + CSS + '</style><ul class="gc-x" aria-label="Which conditions matched">' + node(e) + '</ul>';
    }
  };
})();
