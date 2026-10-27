/*
 * 2.0.x: editing and dropping schema objects through a connection, for the Schema designer and Queues tabs
 * (connections-designer.js, loaded before this file, owns the forms and the preview and apply flow).
 *
 * The objects panel lists GET /connections/:id/objects. Edit loads GET /connections/:id/objects/describe and opens
 * the create form for that kind filled from the description; what is sent is an edit definition (alter-table,
 * replace-index, a routine with orReplace, or edit) that the server diffs against the object as it is then. Drop opens
 * a dialog that previews the drop first and, for a plan that loses data, asks for the object's name typed back.
 * The server contract is server/src/connections/ddl-edit-types.ts.
 */
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const I = App.connectionDesigner.internals;
  const { editor, previewHtml, confirmField, listHtml, stepUp, base, designerOf, dialectOf, famOf, designKinds, formFor, str, put, findType, firstType, idType, typeChoice, typeOut, choiceForm, typeChanged, sqlColOut, sqlConstraintsOut, GSI } = I;

  const GROUP = { table: 'Tables', view: 'Views', procedure: 'Stored procedures', function: 'Functions', index: 'Indexes', dataset: 'Schemas and databases', collection: 'Collections', 'search-index': 'Indexes', container: 'Containers', queue: 'Queues', exchange: 'Exchanges', binding: 'Bindings', 'stream-group': 'Consumer groups' };
  const NOUN = { table: 'table', view: 'view', procedure: 'procedure', function: 'function', index: 'index', dataset: 'schema', collection: 'collection', 'search-index': 'index', container: 'container', queue: 'queue', exchange: 'exchange', binding: 'binding', 'stream-group': 'consumer group' };
  const ORDER = ['table', 'view', 'collection', 'search-index', 'container', 'procedure', 'function', 'index', 'dataset', 'queue', 'exchange', 'binding', 'stream-group'];
  const NON_SQL_EDIT = ['collection', 'search-index', 'table', 'container', 'stream-group'];
  const toast = (ctx, h, k, ms) => ctx.toast('<span>' + h + '</span>', k, ms);
  const shortName = (n) => String(n || '').split('.').pop();

  /** Whether an engine's list (the `editable` of /objects) offers a kind; edit-definition names count for theirs. */
  function offers(list, kind) {
    list = list || [];
    if (list.indexOf(kind) >= 0) return true;
    if (kind === 'table' && list.indexOf('alter-table') >= 0) return true;
    if (kind === 'index' && list.indexOf('replace-index') >= 0) return true;
    if ((kind === 'procedure' || kind === 'function') && list.indexOf('routine') >= 0) return true;
    return false;
  }
  /** The create form that edits a kind on this connection, or null (views and schemas are not edited). */
  function editForm(conn, kind) {
    const sql = famOf(conn) === 'sql';
    if (sql) return kind === 'table' || kind === 'procedure' || kind === 'function' || kind === 'index' ? kind : null;
    return NON_SQL_EDIT.indexOf(kind) >= 0 && formFor(conn, kind) ? kind : null;
  }
  const canEdit = (conn, data, kind) => !!editForm(conn, kind) && offers(data && data.editable && data.editable.edit, kind);
  const canDrop = (data, kind) => offers(data && data.editable && data.editable.drop, kind);
  /** CASCADE where the engine has it: PostgreSQL, Snowflake, Oracle (CASCADE CONSTRAINTS on tables), BigQuery datasets. */
  function cascadeOk(conn, kind) {
    const d = dialectOf(conn);
    if (d === 'postgres') return ['table', 'view', 'index', 'procedure', 'function', 'dataset'].indexOf(kind) >= 0;
    if (d === 'snowflake') return ['table', 'view', 'dataset'].indexOf(kind) >= 0;
    if (d === 'oracle') return kind === 'table';
    if (d === 'bigquery') return kind === 'dataset';
    return false;
  }
  const whyNot = (conn) => (!App.can('connections:ddl') ? 'Applying needs the connections:ddl permission.' : !(conn.admin && conn.admin.set) ? 'Set an admin account on Settings before applying.' : '');

  // ---- the objects list ----
  function objState(st, conn) { st.objs = st.objs || {}; return st.objs[conn.id] || (st.objs[conn.id] = {}); }
  function invalidate(st, conn) { const s = objState(st, conn); s.data = null; s.error = null; }
  /** Re-renders once nothing is open over the screen (a re-render would close a dialog). */
  function later(rerender) { const go = () => { if (App.state.route !== 'connections') return; if (document.querySelector('.overlay')) { setTimeout(go, 250); return; } rerender(); }; go(); }
  function fetchObjects(st, conn, rerender) {
    const s = objState(st, conn);
    if (s.loading) return;
    s.loading = true;
    App.get(base(conn) + '/objects').then((d) => { s.data = d; s.error = null; s.at = Date.now(); }).catch((err) => { s.error = err; }).finally(() => { s.loading = false; later(rerender); });
  }

  function objectsPanel(ctx, conn, st, rerender, reload) {
    const s = objState(st, conn);
    if (!s.data && !s.loading && !s.error) fetchObjects(st, conn, rerender);
    const data = s.data;
    const kinds = designKinds(conn);
    const news = '<div class="hstack wrap" role="group" aria-label="Create">' + kinds.map((k) => UI.btn('New ' + k.label.toLowerCase(), { size: 'sm', icon: 'plus', attrs: 'data-ddlnew="' + esc(k.kind) + '"' })).join('') + '</div>';
    const filter = (s.filter || '').trim().toLowerCase();
    let body = '';
    if (s.error && !data) {
      const gone = s.error.status === 404;
      body = UI.problem((s.error.problem && s.error.problem.title) || 'The objects could not be read', gone ? 'This server does not list a connection\'s objects yet. Creating still works with the New buttons.' : s.error.message, s.error.problem && s.error.problem.trace_id) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-objrefresh' }) + '</div>';
    } else if (!data) body = UI.notice('Reading the objects…', 'info');
    else {
      const objs = (data.objects || []).map((o, i) => Object.assign({ i }, o));
      const shown = objs.filter((o) => !filter || String(o.name).toLowerCase().indexOf(filter) >= 0 || String(NOUN[o.kind] || o.kind).indexOf(filter) >= 0);
      const order = ORDER.concat(objs.map((o) => o.kind).filter((k, i, a) => ORDER.indexOf(k) < 0 && a.indexOf(k) === i));
      const outside = objs.some((o) => !o.allowed);
      const groups = order.map((k) => {
        const rows = shown.filter((o) => o.kind === k);
        if (!rows.length) return '';
        return '<div class="vstack" style="gap:6px"><div class="cd-ghead"><h3 class="eyebrow" style="margin:0">' + esc(GROUP[k] || k) + '</h3>' + UI.pill(String(rows.length), 'outline') + '</div>'
          + UI.table(['Name', 'Allow-list', { label: '', srLabel: 'Actions' }], rows.map((o) => {
            const noun = NOUN[o.kind] || o.kind; const label = noun + ' ' + o.name;
            const blocked = !o.allowed;
            const hint = blocked ? ' aria-describedby="cd-objhint" title="Not on the allow-list: the server refuses changes to it."' : '';
            const acts = (canEdit(conn, data, o.kind) ? UI.btn('Edit', { size: 'xs', icon: 'edit', attrs: 'data-objedit="' + o.i + '" aria-label="Edit ' + esc(label) + '"' + hint, disabled: blocked }) : '')
              + (canDrop(data, o.kind) ? UI.btn('Drop', { kind: 'danger', size: 'xs', icon: 'trash', attrs: 'data-objdrop="' + o.i + '" aria-label="Drop ' + esc(label) + '"' + hint, disabled: blocked }) : '');
            return { attrs: 'data-objrow="' + esc(o.name) + '"', cells: ['<span class="mono">' + esc(o.name) + '</span>' + (o.signature ? ' <span class="mono muted">(' + esc(o.signature) + ')</span>' : ''), o.allowed ? UI.pill('allow-listed', 'ok') : UI.pill('not allow-listed', 'warn'), '<div class="cd-acts">' + (acts || '<span class="muted" style="font-size:12px">No changes offered</span>') + '</div>'] };
          }), { clickable: false, minWidth: '0' }) + '</div>';
      }).join('');
      body = (objs.length ? '' : UI.empty('No objects yet', 'Nothing was found in what the account can see. Create one with a New button, or refresh the schema after a migration.'))
        + (objs.length && !shown.length ? '<div class="muted" style="font-size:12px">Nothing matches the filter.</div>' : '')
        + groups
        + (outside ? '<div class="muted" style="font-size:12px" id="cd-objhint">Objects not on the allow-list cannot be edited or dropped here: the server refuses changes to them. Allow them on the Schema allow-list first.</div>' : '')
        + (s.error ? UI.notice('The last refresh failed: ' + esc(s.error.message), 'warn') : '');
    }
    const html = UI.panel('Objects', '<div class="vstack cd-objs" style="gap:10px">' + news
      + '<div class="hstack wrap">' + '<div class="grow" style="min-width:min(100%,220px)">' + UI.search('Filter objects', 'data-objfilter', s.filter || '') + '</div>' + UI.btn('Refresh list', { size: 'sm', icon: 'refresh', attrs: 'data-objrefresh', disabled: !!s.loading }) + '</div>'
      + body + '</div>');
    return { html, bind() {
      ctx.on('click', '[data-ddlnew]', (e, t) => { st.ddlKind[conn.id] = t.dataset.ddlnew; st.ddlView[conn.id] = 'create'; rerender(); });
      ctx.on('input', '[data-objfilter]', (e, t) => { s.filter = t.value; rerender(); });
      ctx.on('click', '[data-objrefresh]', () => { s.error = null; s.data = null; fetchObjects(st, conn, rerender); rerender(); });
      ctx.on('click', '[data-objedit]', (e, t) => { const o = data && data.objects[+t.dataset.objedit]; if (o) openEdit(ctx, conn, st, { kind: o.kind, name: o.name, signature: o.signature || null }, rerender); });
      ctx.on('click', '[data-objdrop]', (e, t) => {
        const o = data && data.objects[+t.dataset.objdrop]; if (!o) return;
        dropDialog(ctx, conn, { objectKind: o.kind, name: o.name, signature: o.signature || undefined }, () => { invalidate(st, conn); if (reload) reload(); else rerender(); });
      });
    } };
  }

  // ---- edit: load the description, then the form ----
  function openEdit(ctx, conn, st, target, rerender) {
    st.ddlEdit = st.ddlEdit || {};
    const ed = Object.assign({ loading: true, desc: null, error: null }, target);
    st.ddlEdit[conn.id] = ed; st.ddlView[conn.id] = 'edit';
    rerender();
    if (target.kind === 'index') { ed.loading = false; return; }
    App.get(base(conn) + '/objects/describe?name=' + enc(target.name) + '&kind=' + enc(target.kind))
      .then((r) => { ed.desc = r.description || r; ed.error = null; })
      .catch((err) => { ed.error = err; })
      .finally(() => { ed.loading = false; if (st.ddlEdit[conn.id] === ed) later(rerender); });
  }
  const back = (st, conn) => { const ed = st.ddlEdit && st.ddlEdit[conn.id]; if (ed && ed.parent) { st.ddlEdit[conn.id] = ed.parent; } else { if (st.ddlEdit) st.ddlEdit[conn.id] = null; st.ddlView[conn.id] = 'objects'; } };

  // ---- tables: the description as the table form, the alter definition, and what changed ----
  const tcOf = (E, tc, raw) => { const known = !!(tc && findType(E.types, tc.type)); return { type: known ? choiceForm(tc) : typeChoice(firstType(E.types)), rawType: raw || '', rawLocked: !known }; };
  function prefillTable(E, desc) {
    const action = (v) => (v ? String(v).toUpperCase() : '');
    const columns = (desc.columns || []).map((c) => {
      const t = tcOf(E, c.type, c.rawType);
      const def = c.default || null;
      return Object.assign({ from: c.name, name: c.name, nullable: c.nullable !== false, defKind: def ? def.kind : 'none', defValue: def && def.kind === 'literal' ? def.value : '', defExpr: def && def.kind === 'expression' ? def.value : '', identity: !!c.identity, comment: c.comment || '', dropped: false, using: '' },
        t, { origType: t.rawLocked ? null : typeOut(E.d, E.types, t.type) });
    });
    return {
      name: desc.name, rename: '', columns,
      primaryKey: desc.primaryKey ? (desc.primaryKey.columns || []).slice() : [],
      uniques: (desc.uniques || []).map((u) => ({ name: u.name || '', columns: (u.columns || []).slice() })),
      foreignKeys: (desc.foreignKeys || []).map((fk) => ({ name: fk.name || '', refTable: fk.refTable || '', pairs: (fk.columns || []).map((c, j) => ({ col: c, ref: (fk.refColumns || [])[j] || '' })), onDelete: action(fk.onDelete), onUpdate: action(fk.onUpdate) })),
      checks: (desc.checks || []).map((k) => ({ name: k.name || '', expression: k.expression || '' })),
      comment: desc.comment || '', ifNotExists: false, options: {}
    };
  }
  function alterDef(E, desc) {
    const { f, d } = E;
    const live = f.columns.filter((x) => !x.dropped && str(x.name));
    if (!live.length) return { problems: ['A table keeps at least one column. Undo a drop or add a column.'] };
    const names = live.map((x) => str(x.name));
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) return { problems: ['Two columns are named ' + dup[0] + '.'] };
    const columns = live.map((x) => { const c = sqlColOut(E, x); if (x.rawLocked) delete c.type; return x.from ? Object.assign({ from: x.from }, c) : c; });
    const k = sqlConstraintsOut(E, f, names);
    const out = { kind: 'alter-table', name: desc.name };
    const rn = str(f.rename);
    if (rn && rn !== shortName(desc.name)) out.rename = rn;
    Object.assign(out, { columns, primaryKey: k.primaryKey, uniques: k.uniques, foreignKeys: k.foreignKeys, checks: k.checks, comment: str(f.comment) || null, using: {} });
    if (d === 'postgres') live.forEach((x) => { if (typeChanged(E, x) && str(x.using)) out.using[str(x.name)] = str(x.using); });
    return { def: out };
  }
  const typeText = (ch) => { if (!ch || !ch.type) return 'no type'; const p = ch.max ? 'max' : str(ch.length) || (str(ch.precision) ? str(ch.precision) + (str(ch.scale) ? ', ' + str(ch.scale) : '') : ''); return ch.type + (p ? '(' + p + ')' : '') + (ch.array ? '[]' : ''); };
  /** What the form changes against the description, in plain words; `loss` marks what loses data. */
  function tableChanges(E, desc) {
    const f = E.f; const out = []; const add = (text, loss) => out.push({ text, loss: !!loss });
    const byName = {}; (desc.columns || []).forEach((c) => { byName[c.name] = c; });
    const defSig = (x) => (x.defKind === 'literal' ? 'l:' + String(x.defValue == null ? '' : x.defValue) : x.defKind === 'expression' ? 'e:' + str(x.defExpr) : '');
    const descSig = (dv) => (!dv ? '' : dv.kind === 'literal' ? 'l:' + String(dv.value == null ? '' : dv.value) : 'e:' + str(dv.value));
    const rn = str(f.rename);
    if (rn && rn !== shortName(desc.name)) add('Rename the table to ' + rn);
    f.columns.forEach((x) => {
      const nm = str(x.name);
      if (!x.from) { if (nm) add('Add column ' + nm + ' (' + typeText(x.type) + ')'); return; }
      if (x.dropped) { add('Drop column ' + x.from, true); return; }
      const c0 = byName[x.from] || {}; const label = nm || x.from;
      if (nm && nm !== x.from) add('Rename column ' + x.from + ' to ' + nm);
      if (typeChanged(E, x)) add('Change the type of ' + label + ' from ' + (c0.rawType || 'its type') + ' to ' + typeText(x.type));
      if (!!x.nullable !== (c0.nullable !== false)) add(x.nullable ? 'Allow NULL in ' + label : 'Make ' + label + ' NOT NULL');
      if (defSig(x) !== descSig(c0.default)) add(x.defKind === 'none' ? 'Remove the default of ' + label : c0.default ? 'Change the default of ' + label : 'Set a default on ' + label);
      if (str(x.comment) !== (c0.comment || '')) add('Change the comment on ' + label);
    });
    const names = f.columns.filter((x) => !x.dropped && str(x.name)).map((x) => str(x.name));
    const k = sqlConstraintsOut(E, f, names);
    const pk0 = desc.primaryKey ? desc.primaryKey.columns || [] : [];
    if (k.primaryKey.join(',') !== pk0.join(',')) add(!k.primaryKey.length ? 'Drop the primary key' : (pk0.length ? 'Change the primary key to (' : 'Add a primary key on (') + k.primaryKey.join(', ') + ')');
    const named = (was, now, noun, sig, about) => {
      was.forEach((o) => { const c = now.find((x) => x.name && x.name === o.name); if (!c) add('Drop ' + noun + ' ' + o.name); else if (sig(c) !== sig(o)) add('Change ' + noun + ' ' + o.name); });
      now.forEach((c) => { if (!c.name || !was.some((o) => o.name === c.name)) add('Add ' + noun + (c.name ? ' ' + c.name : '') + about(c)); });
    };
    const sorted = (l) => (l || []).slice().sort().join(',');
    named(desc.uniques || [], k.uniques, 'unique constraint', (u) => sorted(u.columns), (u) => ' on (' + u.columns.join(', ') + ')');
    named(desc.foreignKeys || [], k.foreignKeys, 'foreign key', (x) => (x.columns || []).join(',') + '>' + x.refTable + '(' + (x.refColumns || []).join(',') + ')' + String(x.onDelete || '').toUpperCase() + '/' + String(x.onUpdate || '').toUpperCase(), (x) => ' (' + x.columns.join(', ') + ') to ' + x.refTable);
    named(desc.checks || [], k.checks, 'check constraint', (x) => str(x.expression), (x) => ': ' + x.expression);
    if (str(f.comment) !== (desc.comment || '')) add(str(f.comment) ? 'Change the table comment' : 'Remove the table comment');
    return out;
  }
  const changesHtml = (list) => UI.panel('Changes', list.length
    ? '<ul class="cd-changes">' + list.map((c) => '<li' + (c.loss ? ' class="loss"' : '') + '>' + esc(c.text) + (c.loss ? ' (loses data)' : '') + '</li>').join('') + '</ul>'
    : '<div class="muted" style="font-size:12px">No changes yet. Each change you make in the form shows here before you preview it.</div>', { actions: UI.pill(list.length + ' change' + (list.length === 1 ? '' : 's'), list.some((c) => c.loss) ? 'danger' : 'outline') });

  function tableEdit(ed) {
    const desc = ed.desc;
    return {
      pkName: desc.primaryKey && desc.primaryKey.name,
      init: (E) => prefillTable(E, desc),
      ro: (E, p) => p === 'name',
      def: (E) => alterDef(E, desc),
      changes: (E) => changesHtml(tableChanges(E, desc)),
      losses: (E) => tableChanges(E, desc).filter((c) => c.loss).map((c) => c.text),
      // A renamed table keeps its allow-list entry: the server moves it, so no allow-list choice is offered.
      allowLabel: () => null
    };
  }
  function indexEdit(ed) {
    const idx = ed.index; const desc = ed.desc;
    return {
      tableColumns: (desc.columns || []).map((c) => c.name),
      init(E) {
        const methods = E.designer.indexMethods || [];
        return { name: idx.name, table: desc.name, cols: (idx.columns || []).length ? idx.columns.map((c) => ({ name: c.name, order: c.order || '' })) : [{ name: '', order: '' }], allColumns: false, unique: !!idx.unique, method: idx.method && methods.indexOf(idx.method) > 0 ? idx.method : '', include: (idx.include || []).slice(), where: idx.where || '', concurrently: false, ifNotExists: false };
      },
      ro: (E, p) => p === 'table' || p === 'ifNotExists',
      def(E, spec) {
        const r = spec.def(E); if (!r.def) return r;
        const dd = Object.assign({}, r.def); delete dd.kind; delete dd.ifNotExists;
        return { def: Object.assign({ kind: 'replace-index', from: idx.name }, dd) };
      },
      losses: () => ['The index ' + idx.name + ' is dropped and built again; queries that use it are slower until it is built.']
    };
  }
  function routineEdit(ed) {
    const desc = ed.desc;
    return {
      init(E) {
        const langs = E.designer.languages || [];
        const params = (desc.params || []).map((p) => Object.assign({ name: p.name, mode: p.mode || 'in' }, tcOf(E, p.type, p.rawType)));
        const r = desc.returns ? tcOf(E, desc.returns.type, desc.returns.rawType) : { type: typeChoice(idType(E.types) || firstType(E.types)), rawType: '', rawLocked: false };
        return { name: desc.name, params, returns: r.type, retRawType: r.rawType, retRawLocked: r.rawLocked, language: desc.language && langs.indexOf(desc.language) > 0 ? desc.language : '', body: desc.body || '', orReplace: true, deterministic: !!desc.deterministic, volatility: desc.volatility || '', executeAs: '', comment: desc.comment || '' };
      },
      ro: (E, p) => p === 'name',
      def(E, spec) {
        const f = E.f; const fn = E.kind === 'function';
        const probs = f.params.filter((p) => str(p.name) && p.rawLocked).map((p) => 'Parameter ' + str(p.name) + ' has the type ' + p.rawType + ', which the designer does not offer. Choose a type for it with Change type.');
        if ((fn || E.d === 'snowflake') && f.retRawLocked) probs.push('The result has the type ' + f.retRawType + ', which the designer does not offer. Choose a type for it with Change type.');
        if (!str(f.body)) probs.push('The body is empty.');
        if (probs.length) return { problems: probs };
        const r = spec.def(E); if (!r.def) return r;
        r.def.name = desc.name; r.def.orReplace = true;
        return r;
      }
    };
  }

  // ---- non-SQL objects: the description's definition as the create form ----
  const sv = (v) => (v == null ? '' : String(v));
  const PREFILL = {
    'mongo:collection': (def) => ({ name: def.name || '', fields: (def.fields || []).map((x) => ({ name: x.name || '', bsonType: x.bsonType || 'string', required: !!x.required, description: x.description || '' })), additionalProperties: def.additionalProperties !== false, validationLevel: def.validationLevel || 'strict', validationAction: def.validationAction || 'error', mode: def.capped ? 'capped' : def.timeseries ? 'timeseries' : 'normal', cappedSize: sv(def.capped && def.capped.size), cappedMax: sv(def.capped && def.capped.max), timeField: sv(def.timeseries && def.timeseries.timeField), metaField: sv(def.timeseries && def.timeseries.metaField), granularity: sv(def.timeseries && def.timeseries.granularity), expireAfterSeconds: sv(def.expireAfterSeconds) }),
    'opensearch:search-index': (def) => ({ name: def.name || '', shards: sv(def.shards != null ? def.shards : 1), replicas: sv(def.replicas != null ? def.replicas : 1), dynamic: sv(def.dynamic != null ? def.dynamic : 'true'), fields: (def.fields || []).map((x) => ({ name: x.name || '', type: x.type || 'keyword', analyzer: x.analyzer || '', format: x.format || '', dimension: sv(x.dimension), scalingFactor: sv(x.scalingFactor), fixed: true })) }),
    'dynamodb:table': (def, desc) => {
      const pk = def.partitionKey || {}; const sk = def.sortKey || {};
      const gsis = def.indexes || desc.indexes || [];
      return { name: def.name || desc.name, pkName: pk.name || '', pkType: pk.type || 'S', skName: sk.name || '', skType: sk.type || 'S', billingMode: def.billingMode || 'PAY_PER_REQUEST', readCapacity: sv(def.readCapacity), writeCapacity: sv(def.writeCapacity), ttlAttribute: def.ttlAttribute || '',
        indexes: gsis.map((g) => Object.assign(GSI(), { name: g.name || '', pkName: (g.partitionKey || {}).name || '', pkType: (g.partitionKey || {}).type || 'S', skName: (g.sortKey || {}).name || '', skType: (g.sortKey || {}).type || 'S', projection: g.projection || 'ALL', nonKey: (g.nonKeyAttributes || []).join(', '), readCapacity: sv(g.readCapacity), writeCapacity: sv(g.writeCapacity), fixed: true })) };
    },
    'cosmos:container': (def) => ({ name: def.name || '', pkPaths: (def.partitionKeyPaths || []).map((p) => ({ path: p })), defaultTtl: sv(def.defaultTtl), uniqueKeys: (def.uniqueKeys || []).map((l) => ({ paths: (l || []).join(', ') })), excluded: (def.excludedPaths || []).join('\n'), throughput: sv(def.throughput) }),
    'redis:stream-group': (def, desc) => { const id = sv(def.startId || '$'); return { key: def.key || '', group: def.group || desc.name, startMode: id === '$' || id === '0' ? id : 'custom', startCustom: id === '$' || id === '0' ? '' : id, mkstream: false }; }
  };
  const fixedAt = (f, list, p) => { const m = new RegExp('^' + list + '\\.(\\d+)(\\.|$)').exec(p); return !!(m && f[list] && f[list][+m[1]] && f[list][+m[1]].fixed); };
  const RO = {
    'mongo:collection': (f, p) => ['name', 'mode', 'cappedSize', 'cappedMax', 'timeField', 'metaField', 'granularity'].indexOf(p) >= 0,
    'opensearch:search-index': (f, p) => p === 'name' || p === 'shards' || fixedAt(f, 'fields', p),
    'dynamodb:table': (f, p) => ['name', 'pkName', 'pkType', 'skName', 'skType'].indexOf(p) >= 0 || (fixedAt(f, 'indexes', p) && !/\.(readCapacity|writeCapacity)$/.test(p)),
    'cosmos:container': (f, p) => p === 'name' || p === 'throughput' || /^(pkPaths|uniqueKeys)(\.|$)/.test(p),
    'redis:stream-group': (f, p) => p === 'key' || p === 'group'
  };
  function docEdit(conn, ed) {
    const desc = ed.desc; const fk = famOf(conn) + ':' + ed.kind;
    return {
      init: (E) => (PREFILL[fk] ? PREFILL[fk](desc.definition || {}, desc) : {}),
      ro: (E, p) => !!(RO[fk] && RO[fk](E.f, p)),
      def(E, spec) {
        const r = spec.def(E); if (!r.def) return r;
        const dd = Object.assign({}, r.def); delete dd.kind; if (ed.kind === 'stream-group') delete dd.mkstream;
        // A stream group is named by its stream key (the group is in the definition).
        return { def: { kind: 'edit', objectKind: ed.kind, name: ed.kind === 'stream-group' ? (dd.key || desc.name || ed.name) : desc.name || ed.name, definition: dd } };
      }
    };
  }

  /** The edit view: Back, the form filled from the description (or why it cannot be), and a table's indexes. */
  function editView(ctx, conn, st, rerender, reload) {
    const ed = st.ddlEdit && st.ddlEdit[conn.id];
    if (!ed) { st.ddlView[conn.id] = 'objects'; return objectsPanel(ctx, conn, st, rerender, reload); }
    const noun = NOUN[ed.kind] || ed.kind;
    const head = '<div class="hstack wrap">' + UI.btn(ed.parent ? 'Back to the table' : 'Back to objects', { kind: 'ghost', size: 'sm', icon: 'undo', attrs: 'data-editback' })
      + '<h2 class="eyebrow grow" style="margin:0">Edit ' + esc(noun) + ' <span class="mono">' + esc(ed.name) + '</span></h2>'
      + UI.btn('Drop ' + noun, { kind: 'danger', size: 'sm', icon: 'trash', attrs: 'data-editdrop' }) + '</div>';
    const common = () => {
      ctx.on('click', '[data-editback]', () => { back(st, conn); rerender(); });
      ctx.on('click', '[data-editdrop]', () => dropDialog(ctx, conn, dropTarget(ed), () => { if (st.ddlEdit) st.ddlEdit[conn.id] = ed.parent || null; if (!ed.parent) st.ddlView[conn.id] = 'objects'; invalidate(st, conn); if (reload) reload(); else rerender(); }));
    };
    if (ed.loading) return { html: head + UI.notice('Reading ' + esc(noun) + ' ' + esc(ed.name) + '…', 'info'), bind: common };
    if (ed.error || !ed.desc) {
      const e = ed.error || {};
      const msg = e.status === 404 ? 'It no longer exists, or this server does not describe objects yet. Go back and refresh the list.' : e.status === 403 ? 'It is above your clearance.' : e.message || 'Nothing was returned.';
      return { html: head + UI.problem((e.problem && e.problem.title) || 'The ' + noun + ' could not be described', msg, e.problem && e.problem.trace_id), bind: common };
    }
    const sql = famOf(conn) === 'sql';
    let X = null; let formKind = ed.kind;
    if (ed.kind === 'index') X = indexEdit(ed);
    else if (sql && ed.kind === 'table') X = ed.desc.columns ? tableEdit(ed) : null;
    else if (sql && (ed.kind === 'procedure' || ed.kind === 'function')) X = routineEdit(ed);
    else if (!sql && ed.desc.definition) X = docEdit(conn, ed);
    if (ed.desc.kind === 'view' || !X) {
      const def = ed.desc.definition;
      return { html: head + UI.notice('A view is not altered here: drop it and create it again.', 'info') + (typeof def === 'string' && def ? UI.code(def, 'sql') : ''), bind: common };
    }
    const kinds = designKinds(conn); const k = kinds.find((x) => x.kind === formKind) || { label: noun };
    const ed2 = editor(ctx, conn, st, {
      key: conn.id + '|edit|' + ed.kind + '|' + ed.name, kind: formKind, kindLabel: k.label, rerender, reload, edit: X,
      onApplied() {
        // Back to the objects list (or the table, after an index), which is read again.
        if (ed.parent) { ed.parent.loading = true; openEdit(ctx, conn, st, { kind: 'table', name: ed.parent.name }, rerender); }
        else { if (st.ddlEdit) st.ddlEdit[conn.id] = null; st.ddlView[conn.id] = 'objects'; }
        invalidate(st, conn);
      }
    });
    // A table's own indexes (those that back a constraint are edited through the constraint).
    let idxPanel = '';
    const objs = objState(st, conn).data;
    const idxs = ed.kind === 'table' && ed.desc.indexes ? ed.desc.indexes.filter((x) => !x.constraint) : [];
    if (ed.kind === 'table' && formFor(conn, 'index')) {
      const editIdx = !objs || canEdit(conn, objs, 'index'); const dropIdx = !objs || canDrop(objs, 'index');
      idxPanel = UI.panel('Indexes on this table', idxs.length ? UI.table(['Name', 'Columns', 'Kind', { label: '', srLabel: 'Actions' }], idxs.map((x, i) => [
        '<span class="mono">' + esc(x.name) + '</span>', '<span class="mono">' + esc((x.columns || []).map((c) => c.name + (c.order === 'desc' ? ' desc' : '')).join(', ')) + '</span>' + (x.where ? ' <span class="muted">where ' + esc(x.where) + '</span>' : ''),
        (x.unique ? UI.pill('unique', 'outline') + ' ' : '') + (x.method ? '<span class="muted">' + esc(x.method) + '</span>' : ''),
        '<div class="cd-acts">' + (editIdx ? UI.btn('Edit', { size: 'xs', icon: 'edit', attrs: 'data-idxedit="' + i + '" aria-label="Edit index ' + esc(x.name) + '"' }) : '') + (dropIdx ? UI.btn('Drop', { kind: 'danger', size: 'xs', icon: 'trash', attrs: 'data-idxdrop="' + i + '" aria-label="Drop index ' + esc(x.name) + '"' }) : '') + '</div>'
      ]), { clickable: false, minWidth: '0' }) : '<div class="muted" style="font-size:12px">No indexes apart from those behind the primary key and unique constraints.</div>');
    }
    return { html: head + ed2.html + idxPanel, bind() {
      common(); ed2.bind();
      ctx.on('click', '[data-idxedit]', (e, t) => { const x = idxs[+t.dataset.idxedit]; if (!x) return; st.ddlEdit[conn.id] = { kind: 'index', name: x.name, index: x, desc: ed.desc, parent: ed, loading: false }; rerender(); });
      ctx.on('click', '[data-idxdrop]', (e, t) => { const x = idxs[+t.dataset.idxdrop]; if (!x) return; dropDialog(ctx, conn, { objectKind: 'index', name: x.name, on: ed.desc.name }, () => { openEdit(ctx, conn, st, { kind: 'table', name: ed.name }, rerender); invalidate(st, conn); }); });
    } };
  }
  function dropTarget(ed) {
    if (ed.kind === 'index') return { objectKind: 'index', name: ed.name, on: ed.desc && ed.desc.name };
    const t = { objectKind: ed.desc && ed.desc.kind === 'view' ? 'view' : ed.kind, name: ed.name };
    const sig = ed.signature || (ed.desc && ed.desc.signature);
    if (sig) t.signature = sig;
    return t;
  }

  // ---- the plan dialog: preview first, then apply (drops, a stream group's start id) ----
  /**
   * `o`: { title, intro, fields, read(modal) → { def } | { problems }, auto (preview on open and on every change),
   * applyLabel, onDone(result) }. Fields that change the definition carry `data-pd`.
   */
  function planDialog(ctx, conn, o) {
    const lang = dialectOf(conn) ? 'sql' : 'json';
    const why = whyNot(conn);
    let after = null;
    const finish = (r) => {
      toast(ctx, (o.doneText ? o.doneText(r) : 'Applied') + (r && r.ms != null ? ' in ' + r.ms + ' ms' : '') + '. Audit entry written.', 'ok', 7000);
      if (o.onDone) o.onDone(r);
    };
    ctx.modal({
      title: o.title, cls: 'wide',
      body: (o.intro || '') + (o.fields || '')
        + '<div data-pdout aria-live="polite"><div class="muted" style="font-size:12px">' + (o.auto ? 'Previewing…' : 'Preview shows what would run. Nothing is sent until you apply.') + '</div></div>'
        + '<div data-pdconfirm></div><div data-pderr role="alert"></div>'
        + (why ? '<div class="muted" style="font-size:12px">' + esc(why) + '</div>' : ''),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Preview', { icon: 'eye', attrs: 'data-pdprev' }) + UI.btn(o.applyLabel || 'Apply', { kind: 'danger', attrs: 'data-pdgo', disabled: true }),
      onMount(m) {
        const out = m.querySelector('[data-pdout]'); const conf = m.querySelector('[data-pdconfirm]'); const err = m.querySelector('[data-pderr]'); const go = m.querySelector('[data-pdgo]');
        let cur = null; let busy = false;
        const need = () => (cur && cur.plan.destructive && cur.plan.confirmName ? cur.plan.confirmName : null);
        const sync = () => { const inp = conf.querySelector('input'); const n = need(); go.disabled = busy || !cur || !App.can('connections:ddl') || (cur.blockers || []).length > 0 || (!!n && (!inp || inp.value !== n)); };
        const preview = async () => {
          err.innerHTML = ''; cur = null; conf.innerHTML = '';
          const r = o.read(m);
          if (r.problems) { out.innerHTML = previewHtml({ problems: r.problems }, conn, lang); sync(); return; }
          out.innerHTML = '<div class="muted" style="font-size:12px">Previewing…</div>'; sync();
          try {
            const pv = await App.post(base(conn) + '/ddl/preview', { definition: r.def });
            cur = { def: r.def, plan: pv.plan, blockers: pv.blockers || [] };
            out.innerHTML = previewHtml(cur, conn, lang);
            if (need()) { conf.innerHTML = confirmField(need()); conf.querySelector('input').addEventListener('input', sync); }
          } catch (e) {
            const probs = e.problem && Array.isArray(e.problem.problems) ? e.problem.problems : null;
            out.innerHTML = previewHtml(e.status === 422 && probs ? { problems: probs } : { error: e }, conn, lang);
          }
          sync();
        };
        m.querySelectorAll('[data-pd]').forEach((el) => el.addEventListener('change', () => { cur = null; conf.innerHTML = ''; if (o.auto) preview(); else { out.innerHTML = '<div class="muted" style="font-size:12px">Changed. Preview again before applying.</div>'; sync(); } }));
        m.querySelector('[data-pdprev]').addEventListener('click', preview);
        go.addEventListener('click', async () => {
          if (!cur || go.disabled) return;
          const n = need(); const inp = conf.querySelector('input');
          const body = { definition: cur.def, hash: cur.plan.hash, allowList: false };
          if (n) body.confirm = inp ? inp.value : '';
          busy = true; sync();
          try {
            const r = await App.post(base(conn) + '/ddl/apply', body);
            App.closeOverlay(); finish(r);
          } catch (e) {
            busy = false;
            if (e.problem && e.problem.step_up) {
              // The sign-in check opens its own dialog: this one closes first, then the change is sent again.
              after = async () => {
                if (!(await stepUp(ctx))) { toast(ctx, 'Not applied: the sign-in check was cancelled.', 'warn'); return; }
                try { finish(await App.post(base(conn) + '/ddl/apply', body)); } catch (e2) { if (e2.status === 409) toast(ctx, 'The object changed since the preview. Open it again and preview the change.', 'warn', 7000); else App.fail(e2, 'Not applied'); }
              };
              App.closeOverlay(); return;
            }
            if (e.status === 409) { await preview(); err.innerHTML = UI.notice('The object changed since the preview, so nothing was run. It has been previewed again: check the plan, then apply.', 'warn'); return; }
            const probs = e.problem && Array.isArray(e.problem.problems) ? e.problem.problems : null;
            err.innerHTML = probs ? '<div class="notice danger">' + UI.icon('warn', 15) + '<div class="grow"><b>Refused.</b>' + listHtml(probs) + '</div></div>' : UI.problem((e.problem && e.problem.title) || 'Not applied', e.message, e.problem && e.problem.trace_id);
            sync();
          }
        });
        if (o.auto) preview();
      },
      onClose() { if (after) { const a = after; after = null; setTimeout(a, 0); } }
    });
  }

  /** Drop: `t` = { objectKind, name, on, signature, destination, destinationType, propertiesKey }. */
  function dropDialog(ctx, conn, t, onDone) {
    const noun = NOUN[t.objectKind] || t.objectKind;
    const casc = cascadeOk(conn, t.objectKind);
    const rabbitQueue = conn.engine === 'rabbitmq' && t.objectKind === 'queue';
    const fields = (casc || rabbitQueue ? '<div class="vstack" style="gap:4px">' : '')
      + (casc ? UI.check('Drop dependent objects too (CASCADE)', false, 'data-pd="cascade" aria-describedby="cd-casc-h"') + '<div class="hint" id="cd-casc-h">Views, foreign keys and other objects that depend on it are dropped with it. Left off, the database refuses the drop while anything depends on it.</div>' : '')
      + (rabbitQueue ? UI.check('Only if the queue is empty and has no consumers', true, 'data-pd="ifEmpty"') : '')
      + (casc || rabbitQueue ? '</div>' : '');
    planDialog(ctx, conn, {
      title: 'Drop ' + esc(noun) + ' <span class="mono">' + esc(t.label || t.name) + '</span> ' + UI.pill('destructive', 'danger'),
      intro: '<p class="fg2" style="margin:0">The drop is previewed first; nothing is sent to ' + esc(conn.name) + ' until you apply it. It runs on the admin account and is written to the audit log.</p>',
      fields, auto: true, applyLabel: 'Drop ' + noun,
      read(m) {
        const def = { kind: 'drop', objectKind: t.objectKind, name: t.name };
        ['on', 'signature', 'destination', 'destinationType', 'propertiesKey'].forEach((k) => { if (t[k] != null && t[k] !== '') def[k] = t[k]; });
        const c = m.querySelector('[data-pd="cascade"]'); if (c && c.checked) def.cascade = true;
        const ie = m.querySelector('[data-pd="ifEmpty"]'); if (ie) def.ifEmpty = !!ie.checked;
        return { def };
      },
      doneText: () => 'Dropped ' + esc(noun) + ' <span class="mono">' + esc(t.label || t.name) + '</span>',
      onDone
    });
  }

  /** Redis: a consumer group's start id (XGROUP SETID), as an edit of the stream group. */
  function startIdDialog(ctx, conn, key, group, onDone) {
    planDialog(ctx, conn, {
      title: 'Start id of <span class="mono">' + esc(group) + '</span>',
      intro: '<p class="fg2" style="margin:0">Moves where consumer group <span class="mono">' + esc(group) + '</span> on stream <span class="mono">' + esc(key) + '</span> reads from next. Entries already delivered and pending stay pending.</p>',
      fields: '<div class="formgrid" style="--cols:2">' + UI.field('Start from', UI.select([{ value: '$', label: 'New entries only ($)' }, { value: '0', label: 'The whole stream (0)' }, { value: 'custom', label: 'An entry id' }], '$', 'data-pd="mode"'))
        + UI.field('Entry id', UI.input('', { placeholder: '1700000000000-0', attrs: 'data-pd="custom" autocomplete="off" spellcheck="false"' }), 'Used when Start from is an entry id.') + '</div>',
      auto: false, applyLabel: 'Set start id',
      read(m) {
        const mode = m.querySelector('[data-pd="mode"]').value; const custom = m.querySelector('[data-pd="custom"]').value.trim();
        if (mode === 'custom' && !/^\d{1,20}-\d{1,20}$/.test(custom)) return { problems: ['An entry id is two numbers joined by a dash, such as 1700000000000-0.'] };
        return { def: { kind: 'edit', objectKind: 'stream-group', name: key, definition: { key, group, startId: mode === 'custom' ? custom : mode } } };
      },
      doneText: () => 'Moved the start id of <span class="mono">' + esc(group) + '</span>',
      onDone
    });
  }

  App.connectionDesigner.edit = { objectsPanel, editView, invalidate, dropDialog, startIdDialog, planDialog, offers, tableChanges, alterDef, prefillTable };
})();
