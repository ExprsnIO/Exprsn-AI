/*
 * 2.0.x: the Connections screen's Schema designer and Queues tabs, and the admin account field on Settings.
 * connections.js calls these. A schema change is a structured definition (the zod schemas in
 * server/src/connections/ddl.ts), previewed with POST /connections/:id/ddl/preview and applied with
 * POST /connections/:id/ddl/apply on the connection's separate admin account, after a confirmation and, when the
 * server asks, a fresh sign-in check. Nothing here sends SQL text of its own.
 */
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const base = (conn) => '/api/admin/connections/' + enc(conn.id);
  const QUEUE_KINDS = ['stream-group', 'queue', 'exchange', 'binding'];
  const DIALECT = { postgres: 'postgres', mysql: 'mysql', mssql: 'tsql', 'azure-sql': 'tsql', oracle: 'oracle', snowflake: 'snowflake', bigquery: 'bigquery', 'cloudflare-d1': 'sqlite' };
  const MONGO = ['mongodb', 'documentdb', 'cosmos-mongodb', 'do-mongodb'];
  const BSON = ['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'timestamp', 'objectId', 'object', 'array', 'binData', 'null', 'regex', 'uuid'];
  const OS_TYPES = ['text', 'keyword', 'match_only_text', 'long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long', 'boolean', 'date', 'date_nanos', 'ip', 'geo_point', 'geo_shape', 'binary', 'object', 'nested', 'flat_object', 'knn_vector'];
  const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];
  const GROUP_TITLES = { integer: 'Whole numbers', decimal: 'Exact decimals', float: 'Floating point', text: 'Text', binary: 'Binary', boolean: 'Boolean', date: 'Dates', time: 'Times', timestamp: 'Timestamps', interval: 'Intervals', json: 'JSON and semi-structured', uuid: 'UUID', spatial: 'Spatial', network: 'Network', other: 'Other' };

  // ---- step-up (as on the Certificates screen) ----
  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">This change needs a fresh check of who you are. ' + (pw && totp ? 'Enter your password or a code from your authenticator.' : pw ? 'Enter your password.' : totp ? 'Enter a code from your authenticator.' : 'Sign out and sign in again.') + '</div>'
        + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
        + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
        + '<div data-suerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + (pw || totp ? UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }) : ''),
      onMount(m) {
        const err = m.querySelector('[data-suerr]'); const first = m.querySelector('input'); if (first) first.focus();
        const go = async () => {
          const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
          const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
          if (!pwv && !code) { err.innerHTML = UI.notice('Enter your password or a code.', 'warn'); return; }
          try { await App.post('/api/me/step-up', pwv ? { password: pwv } : { code }); ok = true; App.closeOverlay(); }
          catch (e) { err.innerHTML = UI.notice(esc((e.problem && e.problem.detail) || e.message), 'danger'); }
        };
        const b = m.querySelector('[data-sugo]'); if (b) b.addEventListener('click', go);
        m.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }));
      },
      onClose() { resolve(ok); } });
  });
  /** Runs `fn`; when the server asks for step-up, confirms the user and runs it once more. Resolves undefined when cancelled. */
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) return undefined;
      return fn();
    }
  };

  // ---- what the engine offers ----
  const engineInfo = (conn) => { const s = App.stateFor('connections'); return ((s.engines || []).find((e) => e.id === conn.engine)) || { id: conn.engine }; };
  const designerOf = (conn) => Object.assign({ kinds: [], languages: [], indexMethods: [], transactional: false, identity: false, types: [], fieldTypes: [] }, engineInfo(conn).designer || {});
  const dialectOf = (conn) => engineInfo(conn).dialect || DIALECT[conn.engine] || null;
  function famOf(conn) {
    if (dialectOf(conn)) return 'sql';
    if (MONGO.indexOf(conn.engine) >= 0) return 'mongo';
    return { opensearch: 'opensearch', dynamodb: 'dynamodb', 'cosmos-nosql': 'cosmos', influxdb: 'influx', redis: 'redis', rabbitmq: 'rabbitmq' }[conn.engine] || 'none';
  }
  /** The kinds the Schema designer tab offers (queue kinds live on the Queues tab). */
  const designKinds = (conn) => designerOf(conn).kinds.filter((k) => QUEUE_KINDS.indexOf(k.kind) < 0);
  const queueKinds = (conn) => designerOf(conn).kinds.filter((k) => QUEUE_KINDS.indexOf(k.kind) >= 0);
  const hasQueues = (conn) => conn.engine === 'redis' || conn.engine === 'rabbitmq';
  const allowedObjs = (conn) => (conn.schema || []).filter((o) => o.allowed);
  const objCols = (conn, name) => { const o = (conn.schema || []).find((x) => x.name === name); return o ? (o.columns || []).map((c) => c.name) : []; };

  // ---- form state helpers ----
  const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, path, v) {
    const ks = path.split('.'); let a = o;
    for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null) a[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {}; a = a[ks[i]]; }
    a[ks[ks.length - 1]] = v;
  }
  const num = (v) => { if (v === '' || v == null) return undefined; const n = Number(v); return isFinite(n) ? n : undefined; };
  const str = (v) => (v == null ? '' : String(v).trim());
  const lines = (v) => String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const commas = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  /** Sets o[k] unless v is empty (undefined, '', an empty list or object). */
  const put = (o, k, v) => { if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) return o; o[k] = v; return o; };
  let gid = 0;

  /**
   * Controls bound to the form object by path (`data-df`); `rr` redraws the form on change. `ro(path)` (editing) says
   * which paths cannot change: those show their value read-only, with "Cannot be changed" as the hint.
   */
  function controls(f, ro) {
    const at = (path) => getPath(f, path);
    const rr = (o) => (o && o.rr ? ' data-rr' : '');
    const fixed = (path) => !!(ro && ro(path));
    const roHint = (o) => (o && o.roHint) || 'Cannot be changed on an existing object.';
    const roField = (label, text, o) => UI.field(label, UI.input(text, { readonly: true, attrs: 'data-dro autocomplete="off"' }), roHint(o));
    return {
      input(path, label, o) {
        o = o || {}; const v = at(path);
        if (fixed(path)) return roField(label, v == null ? '' : String(v), o);
        const attrs = 'data-df="' + esc(path) + '" autocomplete="off" spellcheck="false"' + (o.min != null ? ' min="' + o.min + '"' : '') + (o.max != null ? ' max="' + o.max + '"' : '') + (o.step ? ' step="' + o.step + '"' : '') + rr(o);
        return UI.field(label, UI.input(v == null ? '' : String(v), { type: o.type || 'text', placeholder: o.ph || '', attrs }), o.hint);
      },
      select(path, label, options, o) {
        o = o || {}; const v = at(path);
        if (fixed(path)) { const hit = options.find((x) => (typeof x === 'string' ? x : x.value) === (v == null ? '' : String(v))); return roField(label, hit ? (typeof hit === 'string' ? hit : hit.label) : (v == null ? '' : String(v)), o); }
        return UI.field(label, UI.select(options, v == null ? '' : String(v), 'data-df="' + esc(path) + '"' + rr(o)), o.hint);
      },
      check(path, label, o) { return '<div class="cd-chk">' + UI.check(label, !!at(path), fixed(path) ? 'disabled data-dro' : 'data-df="' + esc(path) + '" data-dt="bool"' + rr(o)) + '</div>'; },
      code(path, label, o) {
        o = o || {}; const id = 'cdt-' + (++gid); const hid = o.hint || fixed(path) ? 'cdh-' + gid : null; const ronly = fixed(path);
        return '<div class="field"><label for="' + id + '">' + esc(label) + '</label><textarea class="textarea mono" id="' + id + '" ' + (ronly ? 'readonly data-dro' : 'data-df="' + esc(path) + '"') + ' spellcheck="false" autocomplete="off" autocapitalize="off"' + (hid ? ' aria-describedby="' + hid + '"' : '') + ' placeholder="' + esc(o.ph || '') + '" style="min-height:' + (o.rows || 4) * 20 + 'px;white-space:pre">' + esc(at(path) || '') + '</textarea>' + (hid ? '<div class="hint" id="' + hid + '">' + (ronly ? esc(roHint(o)) : o.hint) + '</div>' : '') + '</div>';
      },
      /** A labelled group of checkboxes that keeps a list of names at `path`. */
      set(path, label, options, o) {
        o = o || {}; const id = 'cdg-' + (++gid); const have = at(path) || []; const ronly = fixed(path);
        return '<div class="field" role="group" aria-labelledby="' + id + '"><span class="fl" id="' + id + '">' + esc(label) + '</span>'
          + (options.length ? '<div class="cd-set">' + options.map((n) => UI.check(n, have.indexOf(n) >= 0, ronly ? 'disabled data-dro' : 'data-dset="' + esc(path) + '" value="' + esc(n) + '"')).join('') + '</div>' : '<div class="muted" style="font-size:12px">' + esc(o.empty || 'Nothing to choose yet.') + '</div>')
          + (o.hint ? '<div class="hint">' + o.hint + '</div>' : '') + '</div>';
      }
    };
  }
  const rowBtns = (path, i, n, what) => '<div class="hstack wrap cd-rowbtns">'
    + UI.btn('Up', { kind: 'ghost', size: 'xs', attrs: 'data-dmove="' + esc(path + '.' + i) + '" data-dir="-1" aria-label="Move ' + esc(what) + ' ' + (i + 1) + ' up"', disabled: i === 0 })
    + UI.btn('Down', { kind: 'ghost', size: 'xs', attrs: 'data-dmove="' + esc(path + '.' + i) + '" data-dir="1" aria-label="Move ' + esc(what) + ' ' + (i + 1) + ' down"', disabled: i === n - 1 })
    + UI.btn('Remove', { kind: 'ghost', size: 'xs', attrs: 'data-ddel="' + esc(path + '.' + i) + '" aria-label="Remove ' + esc(what) + ' ' + (i + 1) + '"' }) + '</div>';
  const delBtn = (path, i, what) => UI.btn('Remove', { kind: 'ghost', size: 'xs', attrs: 'data-ddel="' + esc(path + '.' + i) + '" aria-label="Remove ' + esc(what) + ' ' + (i + 1) + '"' });
  const addBtn = (path, label) => UI.btn(label, { size: 'sm', icon: 'plus', attrs: 'data-dadd="' + esc(path) + '"' });
  const section = (title, body, actions) => '<div class="cd-sec"><div class="hstack wrap"><div class="eyebrow grow">' + esc(title) + '</div>' + (actions || '') + '</div>' + body + '</div>';

  // ---- vendor types ----
  const findType = (types, name) => types.find((t) => t.name === name) || null;
  const firstType = (types) => types.find((t) => t.group === 'text' && t.params === 'length') || types.find((t) => t.group === 'text') || types[0] || null;
  function typeChoice(vt) {
    return { type: vt ? vt.name : '', length: vt && vt.defaultLength != null ? String(vt.defaultLength) : '', max: false, precision: vt && vt.defaultPrecision != null ? String(vt.defaultPrecision) : '', scale: vt && vt.defaultScale != null ? String(vt.defaultScale) : '', values: '', unsigned: false, array: false };
  }
  /** A sensible whole-number type for an id column or a result: the 64-bit one where there is one. */
  const idType = (types) => ['bigint', 'BIGINT', 'INT64', 'INTEGER', 'NUMBER'].map((n) => findType(types, n)).find(Boolean) || types.find((t) => t.group === 'integer') || null;
  const big = (n) => Number(n).toLocaleString();
  /** The type select (grouped) and only the parameter inputs the chosen type takes. Returns field HTML pieces. */
  function typeFields(E, d, types, path, label) {
    const ch = getPath(E.f, path) || {};
    if (!types.length) return [E.c.input(path + '.type', label, { ph: 'varchar(255)', hint: 'The type as the database writes it.' })];
    const vt = findType(types, ch.type);
    const groups = []; types.forEach((t) => { if (groups.indexOf(t.group) < 0) groups.push(t.group); });
    const sel = '<select class="select" data-df="' + esc(path + '.type') + '" data-tsel data-rr>' + (vt ? '' : '<option value="" selected>Choose a type</option>')
      + groups.map((g) => '<optgroup label="' + esc(GROUP_TITLES[g] || g) + '">' + types.filter((t) => t.group === g).map((t) => '<option value="' + esc(t.name) + '"' + (vt && t.name === vt.name ? ' selected' : '') + '>' + esc(t.name) + '</option>').join('') + '</optgroup>').join('') + '</select>';
    const out = [UI.field(label, sel, vt && vt.note ? esc(vt.note) : '')];
    if (!vt) return out;
    if (vt.params === 'length') {
      out.push(E.c.input(path + '.length', 'Length' + (vt.required ? '' : ' (optional)'), { type: 'number', min: 1, max: vt.maxLength, ph: vt.required ? 'required' : '', hint: '1 to ' + big(vt.maxLength) + (vt.allowMax ? ', or max' : '') }));
      if (vt.allowMax) out.push(E.c.check(path + '.max', 'Length max'));
    } else if (vt.params === 'precision') {
      out.push(E.c.input(path + '.precision', 'Precision (optional)', { type: 'number', min: vt.minPrecision, max: vt.maxPrecision, hint: vt.minPrecision + ' to ' + vt.maxPrecision }));
    } else if (vt.params === 'precision-scale') {
      out.push(E.c.input(path + '.precision', 'Precision', { type: 'number', min: vt.minPrecision != null ? vt.minPrecision : 1, max: vt.maxPrecision, hint: (vt.minPrecision != null ? vt.minPrecision : 1) + ' to ' + vt.maxPrecision }));
      out.push(E.c.input(path + '.scale', 'Scale', { type: 'number', min: vt.minScale, max: vt.maxScale, hint: (vt.minScale != null ? vt.minScale : 0) + ' to ' + (d === 'oracle' ? vt.maxScale : 'the precision, at most ' + vt.maxScale) }));
    } else if (vt.params === 'values') {
      out.push(E.c.code(path + '.values', 'Values', { rows: 3, hint: 'One value per line.' }));
    }
    if (vt.unsigned) out.push(E.c.check(path + '.unsigned', 'Unsigned'));
    if (d === 'postgres' && E.allowArray) out.push(E.c.check(path + '.array', 'Array of this type'));
    return out;
  }
  function typeOut(d, types, ch) {
    const o = { type: str(ch && ch.type) };
    const vt = findType(types, o.type);
    if (!vt) return o;
    if (vt.params === 'length') { if (ch.max && vt.allowMax) o.length = 'max'; else put(o, 'length', num(ch.length)); }
    if (vt.params === 'precision') put(o, 'precision', num(ch.precision));
    if (vt.params === 'precision-scale') { put(o, 'precision', num(ch.precision)); put(o, 'scale', num(ch.scale)); }
    if (vt.params === 'values') put(o, 'values', lines(ch.values));
    if (ch.unsigned && vt.unsigned) o.unsigned = true;
    if (ch.array && d === 'postgres') o.array = true;
    return o;
  }
  /**
   * Editing: a type the designer does not offer (the description's `type` is null) shows as the database writes it,
   * read-only, until "Change type" opens the picker; "Keep" goes back. `lockPath` holds the flag, `rawPath` the text.
   */
  function typeOrRaw(E, lockPath, rawPath, typePath, label, what, extra) {
    const raw = getPath(E.f, rawPath);
    if (getPath(E.f, lockPath)) {
      return [UI.field(label, UI.input(raw || '', { readonly: true, attrs: 'data-dro autocomplete="off"' }), 'As the database reports it. The designer does not offer this type, so it stays as it is.'),
        '<div class="cd-chk">' + UI.btn('Change type', { kind: 'ghost', size: 'xs', attrs: 'data-drawtype="' + esc(lockPath) + '" data-dtype="' + esc(typePath) + '" aria-label="Change the type of ' + esc(what) + '"' }) + '</div>'];
    }
    const out = typeFields(Object.assign({}, E, extra || {}), E.d, E.types, typePath, label);
    if (raw && E.edit) out.push('<div class="cd-chk">' + UI.btn('Keep ' + raw, { kind: 'ghost', size: 'xs', attrs: 'data-drawkeep="' + esc(lockPath) + '" aria-label="Keep the type of ' + esc(what) + ' as ' + esc(raw) + '"' }) + '</div>');
    return out;
  }
  /** A described TypeChoice as the picker's form state. */
  function choiceForm(tc) {
    tc = tc || {};
    const s = (v) => (v == null ? '' : String(v));
    return { type: s(tc.type), length: tc.length === 'max' ? '' : s(tc.length), max: tc.length === 'max', precision: s(tc.precision), scale: s(tc.scale), values: (tc.values || []).join('\n'), unsigned: !!tc.unsigned, array: !!tc.array };
  }
  /** One table column card's definition (create and alter). */
  function sqlColOut(E, x) {
    const { d, types } = E;
    const vt = findType(types, x.type && x.type.type);
    const o = { name: str(x.name), type: typeOut(d, types, x.type), nullable: !!x.nullable };
    if (x.identity && E.designer.identity && vt && vt.identity) o.identity = true;
    if (x.defKind === 'literal') {
      const v = x.defValue == null ? '' : String(x.defValue);
      const g = vt ? vt.group : '';
      o.default = { kind: 'literal', value: g === 'boolean' ? v !== 'false' : (g === 'integer' || g === 'decimal' || g === 'float') && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v };
    } else if (x.defKind === 'expression' && str(x.defExpr)) o.default = { kind: 'expression', sql: str(x.defExpr) };
    else if (E.edit) o.default = null;
    put(o, 'comment', str(x.comment));
    return o;
  }
  /** A table's constraints as the schemas take them, given the column names that remain. */
  function sqlConstraintsOut(E, f, names) {
    const d = E.d;
    return {
      primaryKey: names.filter((n) => (f.primaryKey || []).indexOf(n) >= 0).sort((a, b) => (f.primaryKey || []).indexOf(a) - (f.primaryKey || []).indexOf(b)),
      uniques: d === 'bigquery' ? [] : f.uniques.map((u) => put({ columns: names.filter((n) => (u.columns || []).indexOf(n) >= 0) }, 'name', str(u.name))).filter((u) => u.columns.length),
      foreignKeys: f.foreignKeys.filter((fk) => fk.refTable).map((fk) => {
        const pairs = fk.pairs.filter((p) => str(p.col) && str(p.ref));
        const o = { columns: pairs.map((p) => str(p.col)), refTable: fk.refTable, refColumns: pairs.map((p) => str(p.ref)) };
        put(o, 'name', str(fk.name)); put(o, 'onDelete', fk.onDelete); if (d !== 'oracle') put(o, 'onUpdate', fk.onUpdate);
        return o;
      }).filter((fk) => fk.columns.length),
      checks: d === 'bigquery' || d === 'snowflake' ? [] : f.checks.filter((k) => str(k.expression)).map((k) => put({ expression: str(k.expression) }, 'name', str(k.name)))
    };
  }
  /** A column's type changed from the described one (alter-table). */
  const typeChanged = (E, x) => !!(x.from && !x.rawLocked && JSON.stringify(typeOut(E.d, E.types, x.type)) !== JSON.stringify(x.origType || null));

  // ---- the forms, one per kind ----
  // Each spec: init(E) → a fresh form; render(E) → HTML; def(E) → { def } or { problems }; templates for list rows.
  const sqlCol = (types) => ({ name: '', type: typeChoice(firstType(types)), nullable: true, defKind: 'none', defValue: '', identity: false, comment: '' });
  const GSI = () => ({ name: '', pkName: '', pkType: 'S', skName: '', skType: 'S', projection: 'ALL', nonKey: '', readCapacity: '', writeCapacity: '' });
  function gsiFields(E, p, provisioned, keyTypes) {
    const c = E.c; const g = (p ? getPath(E.f, p) : E.f) || {}; const j = (k) => (p ? p + '.' + k : k);
    return c.input(j('name'), 'Index name', { ph: 'by-customer' })
      + c.input(j('pkName'), 'Partition key', { ph: 'customerId' }) + c.select(j('pkType'), 'Partition key type', keyTypes)
      + c.input(j('skName'), 'Sort key (optional)', { ph: 'createdAt' }) + c.select(j('skType'), 'Sort key type', keyTypes)
      + c.select(j('projection'), 'Projection', [{ value: 'ALL', label: 'All attributes' }, { value: 'KEYS_ONLY', label: 'Keys only' }, { value: 'INCLUDE', label: 'Keys and listed attributes' }], { rr: true })
      + (g.projection === 'INCLUDE' ? c.input(j('nonKey'), 'Attributes to include', { ph: 'status, total', hint: 'Comma separated.' }) : '')
      + (provisioned ? c.input(j('readCapacity'), 'Read capacity units', { type: 'number', min: 1 }) + c.input(j('writeCapacity'), 'Write capacity units', { type: 'number', min: 1 }) : '');
  }
  function gsiOut(g, withCap) {
    const o = { name: str(g.name), partitionKey: { name: str(g.pkName), type: g.pkType || 'S' }, projection: g.projection || 'ALL' };
    if (str(g.skName)) o.sortKey = { name: str(g.skName), type: g.skType || 'S' };
    if (o.projection === 'INCLUDE') put(o, 'nonKeyAttributes', commas(g.nonKey));
    if (withCap) { put(o, 'readCapacity', num(g.readCapacity)); put(o, 'writeCapacity', num(g.writeCapacity)); }
    return o;
  }
  const vhostOf = (conn) => conn.database || '/';

  const FORMS = {
    'sql:table': {
      templates: { columns: (E) => sqlCol(E.types), uniques: () => ({ name: '', columns: [] }), foreignKeys: () => ({ name: '', refTable: '', pairs: [{ col: '', ref: '' }], onDelete: '', onUpdate: '' }), 'foreignKeys.pairs': () => ({ col: '', ref: '' }), checks: () => ({ name: '', expression: '' }) },
      init(E) { const id = sqlCol(E.types); id.name = 'id'; const it = idType(E.types); if (it) { id.type = typeChoice(it); id.identity = !!(it.identity && E.designer.identity); } id.nullable = false; return { name: '', columns: [id], primaryKey: ['id'], uniques: [], foreignKeys: [], checks: [], ifNotExists: false, comment: '', options: {} }; },
      render(E) {
        const { f, c, d, types } = E; const editing = !!E.edit;
        const live = f.columns.filter((x) => !x.dropped);
        const colNames = live.map((x) => str(x.name)).filter(Boolean);
        const objs = allowedObjs(E.conn).map((o) => o.name);
        const identityOk = E.designer.identity;
        const cards = f.columns.map((col, i) => {
          const p = 'columns.' + i; const vt = findType(types, col.type && col.type.type);
          const title = 'Column ' + (i + 1) + (str(col.name) ? ': <span class="mono">' + esc(str(col.name)) + '</span>' : '');
          if (col.dropped) {
            return '<div class="cd-card cd-dropped"><div class="hstack wrap"><b class="grow"><s>' + title + '</s></b>' + UI.pill('will be dropped', 'danger') + '</div>'
              + '<div class="muted" style="font-size:12px"><s class="mono">' + esc(col.from) + ' ' + esc(col.rawType || '') + '</s>. Its values are lost when the change is applied.</div>'
              + '<div class="hstack">' + UI.btn('Undo', { size: 'xs', icon: 'undo', attrs: 'data-dundo="' + esc(p) + '" aria-label="Keep column ' + esc(col.from) + '"' }) + '</div></div>';
          }
          const isBool = vt && vt.group === 'boolean';
          const what = 'column ' + (str(col.name) || i + 1);
          const pieces = [c.input(p + '.name', 'Column name', { ph: i === 0 ? 'id' : 'name', rr: editing, hint: col.from && str(col.name) !== col.from ? 'Renamed from <span class="mono">' + esc(col.from) + '</span>.' : '' })]
            .concat(typeOrRaw(E, p + '.rawLocked', p + '.rawType', p + '.type', 'Type', what, { allowArray: true }));
          if (editing && d === 'postgres' && typeChanged(E, col)) pieces.push(c.input(p + '.using', 'Convert existing values with (USING), optional', { ph: (str(col.from) || 'value') + '::' + str(col.type && col.type.type), hint: 'An expression over the old value. Left empty, PostgreSQL converts the values itself if it can.' }));
          pieces.push(c.select(p + '.defKind', 'Default', [{ value: 'none', label: 'None' }, { value: 'literal', label: 'A value' }, { value: 'expression', label: 'An expression' }], { rr: true }));
          if (col.defKind === 'literal') pieces.push(isBool ? c.select(p + '.defValue', 'Default value', [{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]) : c.input(p + '.defValue', 'Default value', { hint: 'Written as a literal of the column type.' }));
          if (col.defKind === 'expression') pieces.push(c.input(p + '.defExpr', 'Default expression', { ph: d === 'postgres' ? 'now()' : d === 'tsql' ? 'SYSUTCDATETIME()' : 'CURRENT_TIMESTAMP', hint: 'Checked so it cannot end the statement.' }));
          pieces.push(c.check(p + '.nullable', 'Nullable'));
          if (identityOk && vt && vt.identity) pieces.push(c.check(p + '.identity', d === 'mysql' ? 'Auto-increment' : 'Identity'));
          pieces.push(c.input(p + '.comment', 'Comment (optional)'));
          const badge = !editing ? '' : !col.from ? UI.pill('new', 'accent') : str(col.name) !== col.from ? UI.pill('renamed', 'info') : '';
          return '<div class="cd-card"><div class="hstack wrap"><b class="grow">' + title + '</b>' + badge + '</div><div class="cd-grid">' + pieces.join('') + '</div>' + rowBtns('columns', i, f.columns.length, 'column') + '</div>';
        }).join('');
        const uniques = d === 'bigquery' ? '' : section('Unique constraints', f.uniques.map((u, i) => '<div class="cd-card"><div class="cd-grid">' + c.input('uniques.' + i + '.name', 'Constraint name (optional)') + c.set('uniques.' + i + '.columns', 'Columns', colNames, { empty: 'Name the columns first.' }) + '</div>' + delBtn('uniques', i, 'unique constraint') + '</div>').join(''), addBtn('uniques', 'Add unique constraint'));
        const fks = section('Foreign keys', (objs.length ? '' : '<div class="muted" style="font-size:12px">A foreign key references an allow-listed table; allow one on the Schema allow-list first.</div>') + f.foreignKeys.map((fk, i) => {
          const p = 'foreignKeys.' + i; const refCols = objCols(E.conn, fk.refTable);
          const tables = objs.concat(fk.refTable && objs.indexOf(fk.refTable) < 0 ? [fk.refTable] : []);
          return '<div class="cd-card"><div class="cd-grid">' + c.input(p + '.name', 'Constraint name (optional)') + c.select(p + '.refTable', 'Referenced table', [{ value: '', label: 'Choose a table' }].concat(tables), { rr: true })
            + c.select(p + '.onDelete', 'On delete', [{ value: '', label: 'Database default' }].concat(FK_ACTIONS)) + (d === 'oracle' ? '' : c.select(p + '.onUpdate', 'On update', [{ value: '', label: 'Database default' }].concat(FK_ACTIONS))) + '</div>'
            + fk.pairs.map((pr, j) => '<div class="cd-grid">' + c.select(p + '.pairs.' + j + '.col', 'Column', [{ value: '', label: 'Choose' }].concat(colNames, pr.col && colNames.indexOf(pr.col) < 0 ? [pr.col] : [])) + (refCols.length ? c.select(p + '.pairs.' + j + '.ref', 'References', [{ value: '', label: 'Choose' }].concat(refCols, pr.ref && refCols.indexOf(pr.ref) < 0 ? [pr.ref] : [])) : c.input(p + '.pairs.' + j + '.ref', 'References column')) + '<div class="cd-chk">' + delBtn(p + '.pairs', j, 'column pair') + '</div></div>').join('')
            + '<div class="hstack wrap">' + addBtn(p + '.pairs', 'Add column pair') + delBtn('foreignKeys', i, 'foreign key') + '</div></div>';
        }).join(''), objs.length ? addBtn('foreignKeys', 'Add foreign key') : '');
        const checks = d === 'bigquery' || d === 'snowflake' ? '' : section('Check constraints', f.checks.map((k, i) => '<div class="cd-card"><div class="cd-grid">' + c.input('checks.' + i + '.name', 'Constraint name (optional)') + c.input('checks.' + i + '.expression', 'Expression', { ph: 'total >= 0' }) + '</div>' + delBtn('checks', i, 'check constraint') + '</div>').join(''), addBtn('checks', 'Add check'));
        const pkName = editing && E.edit.pkName ? 'Now named <span class="mono">' + esc(E.edit.pkName) + '</span>. ' : '';
        const pk = section('Primary key', c.set('primaryKey', 'Primary key columns', colNames, { empty: 'Name the columns first.', hint: pkName + 'In the order of the columns above.' }));
        if (editing) {
          return '<div class="formgrid" style="--cols:2">' + c.input('name', 'Table', { roHint: 'The table as it is named now.' }) + c.input('rename', 'Rename table (optional)', { ph: String(f.name || '').split('.').pop(), hint: 'A new name in the same ' + (d === 'bigquery' ? 'dataset' : 'schema') + '. Renamed last.' }) + c.input('comment', 'Table comment (optional)') + '</div>'
            + section('Columns', cards, addBtn('columns', 'Add column')) + pk + uniques + fks + checks;
        }
        const dateCols = f.columns.filter((x) => { const t = findType(types, x.type && x.type.type); return t && /^(DATE|TIMESTAMP|DATETIME)$/.test(t.name) && str(x.name); }).map((x) => str(x.name));
        const vendor = d === 'postgres' ? c.check('options.unlogged', 'Unlogged (not written to the write-ahead log; emptied after a crash)')
          : d === 'mysql' ? c.select('options.engine', 'Storage engine', [{ value: '', label: 'InnoDB (default)' }, 'InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE']) + c.input('options.charset', 'Character set', { ph: 'utf8mb4' }) + c.input('options.collation', 'Collation', { ph: 'utf8mb4_0900_ai_ci' })
          : d === 'snowflake' ? c.check('options.transient', 'Transient (no Fail-safe period)') + c.set('options.clusterBy', 'Cluster by (up to 4)', colNames)
          : d === 'bigquery' ? c.select('options.partitionBy', 'Partition by', [{ value: '', label: 'Not partitioned' }].concat(dateCols), { hint: 'A DATE, TIMESTAMP or DATETIME column.' }) + c.select('options.partitionGranularity', 'Partition granularity', [{ value: '', label: 'Day (default)' }, 'HOUR', 'DAY', 'MONTH', 'YEAR']) + c.set('options.clusterBy', 'Cluster by (up to 4)', colNames) + c.input('options.expirationDays', 'Expires after, days (optional)', { type: 'number', min: 0.01, step: 'any' })
          : d === 'sqlite' ? c.check('options.strict', 'STRICT (types are enforced)') + c.check('options.withoutRowid', 'WITHOUT ROWID (needs a primary key)') : '';
        return '<div class="formgrid" style="--cols:2">' + c.input('name', 'Table name', { ph: d === 'bigquery' ? 'dataset.table' : 'schema.table', hint: d === 'bigquery' ? 'Write dataset.table.' : 'schema.table, or a plain name for the default schema.' }) + c.input('comment', 'Table comment (optional)') + '</div>'
          + section('Columns', cards, addBtn('columns', 'Add column'))
          + pk + uniques + fks + checks
          + section('Options', '<div class="cd-grid">' + (d === 'tsql' || d === 'oracle' ? '' : c.check('ifNotExists', 'If not exists')) + vendor + '</div>');
      },
      def(E) {
        const { f, d } = E;
        const cols = f.columns.filter((x) => str(x.name));
        const names = cols.map((x) => str(x.name));
        const out = { kind: 'table', name: str(f.name), columns: cols.map((x) => sqlColOut(E, x)) };
        const k = sqlConstraintsOut(E, f, names);
        put(out, 'primaryKey', k.primaryKey);
        if (d !== 'bigquery') put(out, 'uniques', k.uniques);
        put(out, 'foreignKeys', k.foreignKeys);
        if (d !== 'bigquery' && d !== 'snowflake') put(out, 'checks', k.checks);
        if (f.ifNotExists && d !== 'tsql' && d !== 'oracle') out.ifNotExists = true;
        put(out, 'comment', str(f.comment));
        const o = f.options || {}; const opts = {};
        const cluster = names.filter((n) => (o.clusterBy || []).indexOf(n) >= 0);
        if (d === 'postgres' && o.unlogged) opts.unlogged = true;
        if (d === 'mysql') { put(opts, 'engine', o.engine); put(opts, 'charset', str(o.charset)); put(opts, 'collation', str(o.collation)); }
        if (d === 'snowflake') { if (o.transient) opts.transient = true; put(opts, 'clusterBy', cluster); }
        if (d === 'bigquery') { put(opts, 'partitionBy', o.partitionBy); if (o.partitionBy) put(opts, 'partitionGranularity', o.partitionGranularity); put(opts, 'clusterBy', cluster); put(opts, 'expirationDays', num(o.expirationDays)); }
        if (d === 'sqlite') { if (o.strict) opts.strict = true; if (o.withoutRowid) opts.withoutRowid = true; }
        put(out, 'options', opts);
        return { def: out };
      }
    },
    'sql:index': {
      templates: { cols: () => ({ name: '', order: '' }) },
      init(E) { const objs = allowedObjs(E.conn); return { name: '', table: objs[0] ? objs[0].name : '', cols: [{ name: '', order: '' }], allColumns: false, unique: false, method: '', include: [], where: '', concurrently: false, ifNotExists: false }; },
      render(E) {
        const { f, c, d } = E; const objs = allowedObjs(E.conn).map((o) => o.name);
        if (!objs.length && !E.edit) return UI.notice('An index is made on an allow-listed table. Allow one on the Schema allow-list first.', 'info');
        const cols = E.edit && E.edit.tableColumns ? E.edit.tableColumns : objCols(E.conn, f.table); const methods = E.designer.indexMethods || [];
        const colRows = d === 'bigquery' && f.allColumns ? '' : f.cols.map((x, i) => '<div class="cd-grid">' + (cols.length ? c.select('cols.' + i + '.name', 'Column ' + (i + 1), [{ value: '', label: 'Choose' }].concat(cols, x.name && cols.indexOf(x.name) < 0 ? [x.name] : [])) : c.input('cols.' + i + '.name', 'Column ' + (i + 1))) + (d === 'bigquery' ? '' : c.select('cols.' + i + '.order', 'Order', [{ value: '', label: 'Default' }, { value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }])) + '<div class="cd-chk">' + rowBtns('cols', i, f.cols.length, 'index column') + '</div></div>').join('');
        return '<div class="formgrid" style="--cols:2">' + c.input('name', 'Index name', { ph: 'ix_orders_customer' }) + c.select('table', 'Table', objs, { rr: true, hint: 'Allow-listed tables.' }) + '</div>'
          + section('Columns', (d === 'bigquery' ? c.check('allColumns', 'All columns', { rr: true }) : '') + colRows, d === 'bigquery' && f.allColumns ? '' : addBtn('cols', 'Add column'))
          + section('Options', '<div class="cd-grid">' + (d === 'bigquery' ? '' : c.check('unique', 'Unique')) + (methods.length > 1 ? c.select('method', 'Method', [{ value: '', label: methods[0] + ' (default)' }].concat(methods.slice(1))) : '')
            + (d === 'postgres' || d === 'tsql' ? c.set('include', 'Include columns', cols, { empty: 'The table has no introspected columns.' }) : '')
            + (d === 'postgres' || d === 'tsql' || d === 'sqlite' ? c.input('where', 'Only rows where (optional)', { ph: 'deleted_at IS NULL', hint: 'A partial (filtered) index.' }) : '')
            + (d === 'postgres' ? c.check('concurrently', 'Concurrently (no write lock; runs outside a transaction)') : '')
            + ((d === 'postgres' || d === 'sqlite' || d === 'bigquery') && !E.edit ? c.check('ifNotExists', 'If not exists') : '') + '</div>');
      },
      def(E) {
        const { f, d } = E;
        const out = { kind: 'index', name: str(f.name), table: f.table };
        const tcols = E.edit && E.edit.tableColumns ? E.edit.tableColumns : objCols(E.conn, f.table);
        if (d === 'bigquery' && f.allColumns) out.allColumns = true;
        else out.columns = f.cols.filter((x) => str(x.name)).map((x) => put({ name: str(x.name) }, 'order', d === 'bigquery' ? '' : x.order));
        if (f.unique && d !== 'bigquery') out.unique = true;
        put(out, 'method', f.method);
        if (d === 'postgres' || d === 'tsql') put(out, 'include', tcols.filter((n) => (f.include || []).indexOf(n) >= 0));
        if (d === 'postgres' || d === 'tsql' || d === 'sqlite') put(out, 'where', str(f.where));
        if (d === 'postgres' && f.concurrently) out.concurrently = true;
        if ((d === 'postgres' || d === 'sqlite' || d === 'bigquery') && f.ifNotExists) out.ifNotExists = true;
        return { def: out };
      }
    },
    'sql:routine': {
      templates: { params: (E) => ({ name: '', type: typeChoice(firstType(E.types)), mode: 'in' }) },
      init(E) { const r = idType(E.types) || firstType(E.types); return { name: '', params: [], returns: typeChoice(r), language: '', body: '', orReplace: false, deterministic: false, volatility: '', executeAs: '', comment: '' }; },
      render(E) {
        const { f, c, d, types, kind } = E; const fn = kind === 'function';
        const langs = E.designer.languages || [];
        const modes = !fn && d !== 'snowflake';
        const params = f.params.map((p, i) => '<div class="cd-card"><div class="cd-grid">' + c.input('params.' + i + '.name', 'Parameter name') + typeOrRaw(E, 'params.' + i + '.rawLocked', 'params.' + i + '.rawType', 'params.' + i + '.type', 'Type', 'parameter ' + (str(p.name) || i + 1)).join('') + (modes ? c.select('params.' + i + '.mode', 'Mode', [{ value: 'in', label: 'IN' }, { value: 'out', label: 'OUT' }, { value: 'inout', label: 'IN OUT' }]) : '') + '</div>' + rowBtns('params', i, f.params.length, 'parameter') + '</div>').join('');
        const hint = d === 'postgres' ? 'The body goes between dollar quotes the body does not contain.' : d === 'mysql' ? 'Statements; wrapped in BEGIN and END unless the body starts with BEGIN.' : d === 'tsql' ? 'The statements inside BEGIN and END.' + (fn ? ' A function body ends with RETURN.' : '') : d === 'oracle' ? 'PL/SQL; wrapped in BEGIN and END unless it has a BEGIN.' : d === 'snowflake' ? 'The body between $$ quotes.' : d === 'bigquery' ? (fn ? 'An SQL expression, or a JavaScript body.' : 'Statements between BEGIN and END.') : '';
        return '<div class="formgrid" style="--cols:2">' + c.input('name', fn ? 'Function name' : 'Procedure name', { ph: d === 'bigquery' ? 'dataset.name' : 'schema.name' }) + c.input('comment', 'Comment (optional)') + '</div>'
          + section('Parameters', params, addBtn('params', 'Add parameter'))
          + (fn || d === 'snowflake' ? section('Result', '<div class="cd-grid">' + typeOrRaw(E, 'retRawLocked', 'retRawType', 'returns', fn ? 'Returns' : 'Returns (default VARCHAR)', 'the result').join('') + '</div>') : '')
          + section('Body', '<div class="cd-grid">' + (langs.length > 1 ? c.select('language', 'Language', [{ value: '', label: langs[0] + ' (default)' }].concat(langs.slice(1))) : '')
            + (d === 'mysql' || E.edit ? '' : c.check('orReplace', d === 'tsql' ? 'Create or alter' : 'Or replace'))
            + (d === 'mysql' && fn ? c.check('deterministic', 'Deterministic') : '')
            + (d === 'postgres' && fn ? c.select('volatility', 'Volatility', [{ value: '', label: 'Database default (volatile)' }, 'immutable', 'stable', 'volatile']) : '')
            + (d === 'snowflake' && !fn ? c.select('executeAs', 'Execute as', [{ value: '', label: 'Owner (default)' }, 'owner', 'caller']) : '') + '</div>'
            + c.code('body', 'Body', { rows: E.edit ? 18 : 10, hint }));
      },
      def(E) {
        const { f, d, types, kind } = E; const fn = kind === 'function';
        const out = { kind, name: str(f.name), params: f.params.filter((p) => str(p.name)).map((p) => { const o = { name: str(p.name), type: typeOut(d, types, p.type) }; if (!fn && d !== 'snowflake' && p.mode && p.mode !== 'in') o.mode = p.mode; return o; }), body: f.body || '' };
        if (!out.params.length) delete out.params;
        if ((fn || d === 'snowflake') && f.returns && str(f.returns.type)) out.returns = typeOut(d, types, f.returns);
        put(out, 'language', f.language);
        if (f.orReplace && d !== 'mysql') out.orReplace = true;
        if (d === 'mysql' && fn && f.deterministic) out.deterministic = true;
        if (d === 'postgres' && fn) put(out, 'volatility', f.volatility);
        if (d === 'snowflake' && !fn) put(out, 'executeAs', f.executeAs);
        put(out, 'comment', str(f.comment));
        return { def: out };
      }
    },
    dataset: {
      init() { return { name: '', ifNotExists: false, owner: '', charset: '', collation: '', location: '', defaultTableExpirationDays: '', managedAccess: false, retentionDays: '', duration: '', throughput: '', comment: '' }; },
      render(E) {
        const { c, d, conn } = E; const cosmos = conn.engine === 'cosmos-nosql'; const influx = conn.engine === 'influxdb';
        const label = E.kindLabel || 'Name';
        return '<div class="formgrid" style="--cols:2">' + c.input('name', label + ' name', { ph: influx ? 'metrics' : cosmos ? 'orders' : 'reporting' })
          + (d === 'postgres' || d === 'tsql' ? c.input('owner', 'Owner (optional)', { hint: 'The role that owns it.' }) : '')
          + (d === 'mysql' ? c.input('charset', 'Character set (optional)', { ph: 'utf8mb4' }) + c.input('collation', 'Collation (optional)', { ph: 'utf8mb4_0900_ai_ci' }) : '')
          + (d === 'bigquery' ? c.input('location', 'Location (optional)', { ph: 'EU' }) + c.input('defaultTableExpirationDays', 'Default table expiration, days (optional)', { type: 'number', min: 0.042, step: 'any' }) : '')
          + (d === 'snowflake' ? c.input('retentionDays', 'Time Travel retention, days (optional)', { type: 'number', min: 0, max: 90 }) : '')
          + (influx ? c.input('duration', 'Retention (optional)', { ph: '30d', hint: 'Hours, days or weeks (12h, 30d, 4w), or INF.' }) : '')
          + (cosmos ? c.input('throughput', 'Throughput, RU/s (optional)', { type: 'number', min: 400, max: 1000000, hint: 'Serverless when left empty.' }) : '')
          + (d === 'postgres' || d === 'snowflake' || d === 'bigquery' ? c.input('comment', d === 'bigquery' ? 'Description (optional)' : 'Comment (optional)') : '')
          + '</div><div class="cd-grid">' + (d && d !== 'tsql' ? c.check('ifNotExists', 'If not exists') : '') + (d === 'snowflake' ? c.check('managedAccess', 'Managed access') : '') + '</div>';
      },
      def(E) {
        const { f, d, conn } = E; const out = { kind: 'dataset', name: str(f.name) };
        if (f.ifNotExists && d && d !== 'tsql') out.ifNotExists = true;
        if (d === 'postgres' || d === 'tsql') put(out, 'owner', str(f.owner));
        if (d === 'mysql') { put(out, 'charset', str(f.charset)); put(out, 'collation', str(f.collation)); }
        if (d === 'bigquery') { put(out, 'location', str(f.location)); put(out, 'defaultTableExpirationDays', num(f.defaultTableExpirationDays)); }
        if (d === 'snowflake') { if (f.managedAccess) out.managedAccess = true; put(out, 'retentionDays', num(f.retentionDays)); }
        if (conn.engine === 'influxdb') put(out, 'duration', str(f.duration));
        if (conn.engine === 'cosmos-nosql') put(out, 'throughput', num(f.throughput));
        if (d === 'postgres' || d === 'snowflake' || d === 'bigquery') put(out, 'comment', str(f.comment));
        return { def: out };
      }
    },
    'mongo:collection': {
      templates: { fields: () => ({ name: '', bsonType: 'string', required: false, description: '' }) },
      init() { return { name: '', fields: [], additionalProperties: true, validationLevel: 'strict', validationAction: 'error', mode: 'normal', cappedSize: '', cappedMax: '', timeField: '', metaField: '', granularity: '', expireAfterSeconds: '' }; },
      render(E) {
        const { f, c } = E; const bson = E.designer.fieldTypes && E.designer.fieldTypes.length ? E.designer.fieldTypes : BSON;
        const rows = f.fields.map((x, i) => '<div class="cd-card"><div class="cd-grid">' + c.input('fields.' + i + '.name', 'Field', { ph: 'status' }) + c.select('fields.' + i + '.bsonType', 'BSON type', bson) + c.check('fields.' + i + '.required', 'Required') + c.input('fields.' + i + '.description', 'Description (optional)') + '</div>' + rowBtns('fields', i, f.fields.length, 'field') + '</div>').join('');
        return '<div class="formgrid" style="--cols:2">' + c.input('name', 'Collection name', { ph: 'orders' }) + c.select('mode', 'Kind', [{ value: 'normal', label: 'Ordinary collection' }, { value: 'capped', label: 'Capped (fixed size)' }, { value: 'timeseries', label: 'Time series' }], { rr: true }) + '</div>'
          + section('Validator fields', (f.fields.length ? '' : '<div class="muted" style="font-size:12px">No validator: any document is accepted.</div>') + rows, addBtn('fields', 'Add field'))
          + (f.fields.length ? '<div class="cd-grid">' + c.check('additionalProperties', 'Allow fields not listed') + c.select('validationLevel', 'Validation level', ['strict', 'moderate', 'off']) + c.select('validationAction', 'Validation action', [{ value: 'error', label: 'error (refuse the write)' }, { value: 'warn', label: 'warn (log only)' }]) + '</div>' : '')
          + (f.mode === 'capped' ? section('Capped', '<div class="cd-grid">' + c.input('cappedSize', 'Size, bytes', { type: 'number', min: 4096 }) + c.input('cappedMax', 'Most documents (optional)', { type: 'number', min: 1 }) + '</div>') : '')
          + (f.mode === 'timeseries' ? section('Time series', '<div class="cd-grid">' + c.input('timeField', 'Time field', { ph: 'ts' }) + c.input('metaField', 'Meta field (optional)', { ph: 'sensor' }) + c.select('granularity', 'Granularity', [{ value: '', label: 'Default (seconds)' }, 'seconds', 'minutes', 'hours']) + c.input('expireAfterSeconds', 'Expire after, seconds (optional)', { type: 'number', min: 1 }) + '</div>') : '');
      },
      def(E) {
        const { f } = E; const out = { kind: 'collection', name: str(f.name) };
        const fields = f.fields.filter((x) => str(x.name)).map((x) => put({ name: str(x.name), bsonType: x.bsonType, required: !!x.required }, 'description', str(x.description)));
        if (fields.length) { out.fields = fields; out.additionalProperties = !!f.additionalProperties; out.validationLevel = f.validationLevel; out.validationAction = f.validationAction; }
        if (f.mode === 'capped') out.capped = put({ size: num(f.cappedSize) }, 'max', num(f.cappedMax));
        if (f.mode === 'timeseries') { out.timeseries = put(put({ timeField: str(f.timeField) }, 'metaField', str(f.metaField)), 'granularity', f.granularity); put(out, 'expireAfterSeconds', num(f.expireAfterSeconds)); }
        return { def: out };
      }
    },
    'mongo:index': {
      templates: { keys: () => ({ field: '', order: '1' }) },
      init(E) { const objs = allowedObjs(E.conn); return { collection: objs[0] ? objs[0].name : '', name: '', keys: [{ field: '', order: '1' }], unique: false, sparse: false, ttl: '', partialFilter: '' }; },
      render(E) {
        const { f, c } = E; const objs = allowedObjs(E.conn).map((o) => o.name);
        if (!objs.length) return UI.notice('An index is made on an allow-listed collection. Allow one on the Schema allow-list first.', 'info');
        const rows = f.keys.map((k, i) => '<div class="cd-grid">' + c.input('keys.' + i + '.field', 'Field ' + (i + 1), { ph: 'customerId' }) + c.select('keys.' + i + '.order', 'Kind', [{ value: '1', label: 'Ascending (1)' }, { value: '-1', label: 'Descending (-1)' }, { value: 'text', label: 'Text' }, { value: '2dsphere', label: '2dsphere' }, { value: 'hashed', label: 'Hashed' }]) + '<div class="cd-chk">' + rowBtns('keys', i, f.keys.length, 'key') + '</div></div>').join('');
        return '<div class="formgrid" style="--cols:2">' + c.select('collection', 'Collection', objs, { hint: 'Allow-listed collections.' }) + c.input('name', 'Index name (optional)', { ph: 'customerId_1' }) + '</div>'
          + section('Keys', rows, addBtn('keys', 'Add key'))
          + section('Options', '<div class="cd-grid">' + c.check('unique', 'Unique') + c.check('sparse', 'Sparse') + c.input('ttl', 'Expire after, seconds (optional)', { type: 'number', min: 0, hint: 'A TTL index has one date field.' }) + '</div>' + c.code('partialFilter', 'Partial filter (optional)', { rows: 3, ph: '{ "status": "open" }', hint: 'JSON with equality and range operators only ($eq, $gt, $gte, $lt, $lte, $exists, $type, $and, $in).' }));
      },
      def(E) {
        const { f } = E; const out = { kind: 'index', collection: f.collection, keys: f.keys.filter((k) => str(k.field)).map((k) => ({ field: str(k.field), order: k.order === '1' ? 1 : k.order === '-1' ? -1 : k.order })) };
        put(out, 'name', str(f.name));
        if (f.unique) out.unique = true;
        if (f.sparse) out.sparse = true;
        put(out, 'expireAfterSeconds', num(f.ttl));
        if (str(f.partialFilter)) {
          let pf; try { pf = JSON.parse(f.partialFilter); } catch (e) { return { problems: ['The partial filter is not valid JSON: ' + e.message] }; }
          if (!pf || typeof pf !== 'object' || Array.isArray(pf)) return { problems: ['The partial filter must be a JSON object.'] };
          out.partialFilter = pf;
        }
        return { def: out };
      }
    },
    'opensearch:search-index': {
      templates: { fields: () => ({ name: '', type: 'keyword', analyzer: '', format: '', dimension: '', scalingFactor: '' }) },
      init() { return { name: '', shards: '1', replicas: '1', dynamic: 'true', fields: [] }; },
      render(E) {
        const { f, c } = E; const types = E.designer.fieldTypes && E.designer.fieldTypes.length ? E.designer.fieldTypes : OS_TYPES;
        const rows = f.fields.map((x, i) => {
          const p = 'fields.' + i;
          return '<div class="cd-card"><div class="cd-grid">' + c.input(p + '.name', 'Field', { ph: 'message' }) + c.select(p + '.type', 'Type', types, { rr: true })
            + (x.type === 'text' || x.type === 'match_only_text' ? c.select(p + '.analyzer', 'Analyzer', [{ value: '', label: 'Default (standard)' }, 'standard', 'simple', 'whitespace', 'keyword', 'english', 'french', 'german', 'spanish']) : '')
            + (x.type === 'date' || x.type === 'date_nanos' ? c.input(p + '.format', 'Format (optional)', { ph: 'strict_date_optional_time||epoch_millis' }) : '')
            + (x.type === 'knn_vector' ? c.input(p + '.dimension', 'Dimension', { type: 'number', min: 1, max: 16000 }) : '')
            + (x.type === 'scaled_float' ? c.input(p + '.scalingFactor', 'Scaling factor', { type: 'number', min: 0, step: 'any', ph: '100' }) : '')
            + '</div>' + (E.ro(p) ? '' : rowBtns('fields', i, f.fields.length, 'field')) + '</div>';
        }).join('');
        return '<div class="formgrid" style="--cols:2">' + c.input('name', 'Index name', { ph: 'logs-2026.10', hint: 'Lower-case letters, digits, ., _ and -.' }) + c.select('dynamic', 'New fields', [{ value: 'true', label: 'Mapped as they arrive (true)' }, { value: 'false', label: 'Stored, not indexed (false)' }, { value: 'strict', label: 'Refused (strict)' }])
          + c.input('shards', 'Primary shards', { type: 'number', min: 1, max: 1024 }) + c.input('replicas', 'Replicas', { type: 'number', min: 0, max: 10 }) + '</div>'
          + section('Mapping', rows, addBtn('fields', 'Add field'));
      },
      def(E) {
        const { f } = E; const out = { kind: 'search-index', name: str(f.name), dynamic: f.dynamic || 'true' };
        put(out, 'shards', num(f.shards)); put(out, 'replicas', num(f.replicas));
        put(out, 'fields', f.fields.filter((x) => str(x.name)).map((x) => {
          const o = { name: str(x.name), type: x.type };
          if (x.type === 'text' || x.type === 'match_only_text') put(o, 'analyzer', x.analyzer);
          if (x.type === 'date' || x.type === 'date_nanos') put(o, 'format', str(x.format));
          if (x.type === 'knn_vector') put(o, 'dimension', num(x.dimension));
          if (x.type === 'scaled_float') put(o, 'scalingFactor', num(x.scalingFactor));
          return o;
        }));
        return { def: out };
      }
    },
    'dynamodb:table': {
      templates: { indexes: GSI },
      init() { return { name: '', pkName: '', pkType: 'S', skName: '', skType: 'S', billingMode: 'PAY_PER_REQUEST', readCapacity: '', writeCapacity: '', indexes: [], ttlAttribute: '' }; },
      render(E) {
        const { f, c } = E; const kt = E.designer.fieldTypes && E.designer.fieldTypes.length ? E.designer.fieldTypes : ['S', 'N', 'B'];
        const prov = f.billingMode === 'PROVISIONED';
        return '<div class="formgrid" style="--cols:2">' + c.input('name', 'Table name', { ph: 'orders', hint: '3 to 255 letters, digits, _, . and -.' }) + c.select('billingMode', 'Billing', [{ value: 'PAY_PER_REQUEST', label: 'On demand' }, { value: 'PROVISIONED', label: 'Provisioned capacity' }], { rr: true })
          + c.input('pkName', 'Partition key', { ph: 'pk' }) + c.select('pkType', 'Partition key type', kt) + c.input('skName', 'Sort key (optional)', { ph: 'sk' }) + c.select('skType', 'Sort key type', kt)
          + (prov ? c.input('readCapacity', 'Read capacity units', { type: 'number', min: 1 }) + c.input('writeCapacity', 'Write capacity units', { type: 'number', min: 1 }) : '')
          + c.input('ttlAttribute', 'Time to live attribute (optional)', { ph: 'expiresAt', hint: 'An attribute holding an epoch time in seconds.' }) + '</div>'
          + section('Global secondary indexes', f.indexes.map((g, i) => '<div class="cd-card"><div class="cd-grid">' + gsiFields(E, 'indexes.' + i, prov, kt) + '</div>' + delBtn('indexes', i, 'index') + '</div>').join(''), addBtn('indexes', 'Add index'));
      },
      def(E) {
        const { f } = E; const prov = f.billingMode === 'PROVISIONED';
        const out = { kind: 'table', name: str(f.name), partitionKey: { name: str(f.pkName), type: f.pkType }, billingMode: f.billingMode };
        if (str(f.skName)) out.sortKey = { name: str(f.skName), type: f.skType };
        if (prov) { put(out, 'readCapacity', num(f.readCapacity)); put(out, 'writeCapacity', num(f.writeCapacity)); }
        put(out, 'indexes', f.indexes.filter((g) => str(g.name)).map((g) => gsiOut(g, prov)));
        put(out, 'ttlAttribute', str(f.ttlAttribute));
        return { def: out };
      }
    },
    'dynamodb:index': {
      init(E) { const objs = allowedObjs(E.conn); return Object.assign(GSI(), { table: objs[0] ? objs[0].name : '' }); },
      render(E) {
        const { c } = E; const objs = allowedObjs(E.conn).map((o) => o.name); const kt = E.designer.fieldTypes && E.designer.fieldTypes.length ? E.designer.fieldTypes : ['S', 'N', 'B'];
        if (!objs.length) return UI.notice('An index is added to an allow-listed table. Allow one on the Schema allow-list first.', 'info');
        return '<div class="formgrid" style="--cols:2">' + c.select('table', 'Table', objs, { hint: 'Allow-listed tables.' }) + gsiFields(E, '', false, kt) + '</div>'
          + '<div class="cd-grid">' + c.input('readCapacity', 'Read capacity units (provisioned tables only)', { type: 'number', min: 1 }) + c.input('writeCapacity', 'Write capacity units (provisioned tables only)', { type: 'number', min: 1 }) + '</div>';
      },
      def(E) { return { def: Object.assign({ kind: 'index', table: E.f.table }, gsiOut(E.f, true)) }; }
    },
    'cosmos:container': {
      templates: { pkPaths: () => ({ path: '' }), uniqueKeys: () => ({ paths: '' }) },
      init() { return { name: '', pkPaths: [{ path: '/tenantId' }], defaultTtl: '', uniqueKeys: [], excluded: '', throughput: '' }; },
      render(E) {
        const { f, c } = E;
        return '<div class="formgrid" style="--cols:2">' + c.input('name', 'Container name', { ph: 'orders' }) + c.input('throughput', 'Throughput, RU/s (optional)', { type: 'number', min: 400, max: 1000000, hint: 'Shared database throughput or serverless when left empty.' })
          + c.input('defaultTtl', 'Default time to live (optional)', { type: 'number', min: -1, hint: '-1 turns TTL on with no default; otherwise seconds.' }) + '</div>'
          + section('Partition key paths (1 to 3)', f.pkPaths.map((p, i) => '<div class="cd-grid">' + c.input('pkPaths.' + i + '.path', 'Path ' + (i + 1), { ph: '/tenantId' }) + (f.pkPaths.length > 1 && !E.ro('pkPaths') ? '<div class="cd-chk">' + delBtn('pkPaths', i, 'partition key path') + '</div>' : '') + '</div>').join(''), f.pkPaths.length < 3 && !E.ro('pkPaths') ? addBtn('pkPaths', 'Add path') : '')
          + section('Unique keys', (E.ro('uniqueKeys') && !f.uniqueKeys.length ? '<div class="muted" style="font-size:12px">None. Unique keys are set when a container is created.</div>' : '') + f.uniqueKeys.map((u, i) => '<div class="cd-grid">' + c.input('uniqueKeys.' + i + '.paths', 'Unique key ' + (i + 1), { ph: '/email, /region', hint: 'Paths, comma separated.' }) + (E.ro('uniqueKeys') ? '' : '<div class="cd-chk">' + delBtn('uniqueKeys', i, 'unique key') + '</div>') + '</div>').join(''), E.ro('uniqueKeys') ? '' : addBtn('uniqueKeys', 'Add unique key'))
          + c.code('excluded', 'Paths left out of the index (optional)', { rows: 3, ph: '/payload/*', hint: 'One path per line.' });
      },
      def(E) {
        const { f } = E; const out = { kind: 'container', name: str(f.name), partitionKeyPaths: f.pkPaths.map((p) => str(p.path)).filter(Boolean) };
        put(out, 'defaultTtl', num(f.defaultTtl));
        put(out, 'uniqueKeys', f.uniqueKeys.map((u) => commas(u.paths)).filter((l) => l.length));
        put(out, 'excludedPaths', lines(f.excluded));
        put(out, 'throughput', num(f.throughput));
        return { def: out };
      }
    },
    'redis:stream-group': {
      init() { return { key: '', group: '', startMode: '$', startCustom: '', mkstream: true }; },
      render(E) {
        const { f, c } = E;
        return '<div class="formgrid" style="--cols:2">' + c.input('key', 'Stream key', { ph: 'orders:events', hint: 'No spaces or glob characters.' }) + c.input('group', 'Consumer group', { ph: 'billing' })
          + c.select('startMode', 'Start from', [{ value: '$', label: 'New entries only ($)' }, { value: '0', label: 'The whole stream (0)' }, { value: 'custom', label: 'An entry id' }], { rr: true })
          + (f.startMode === 'custom' ? c.input('startCustom', 'Entry id', { ph: '1700000000000-0' }) : '') + '</div>'
          + (E.edit ? '' : c.check('mkstream', 'Make the stream if the key does not exist (MKSTREAM)'));
      },
      def(E) { const { f } = E; return { def: { kind: 'stream-group', key: str(f.key), group: str(f.group), startId: f.startMode === 'custom' ? str(f.startCustom) : f.startMode, mkstream: !!f.mkstream } }; }
    },
    'rabbitmq:queue': {
      init(E) { return { vhost: vhostOf(E.conn), name: '', type: 'quorum', durable: true, autoDelete: false, a: {} }; },
      render(E) {
        const { f, c } = E; const t = f.type; const classic = t === 'classic', quorum = t === 'quorum', stream = t === 'stream';
        const a = (k, label, o) => c.input('a.' + k, label, Object.assign({ type: 'number', min: 0 }, o || {}));
        return '<div class="formgrid" style="--cols:2">' + c.input('vhost', 'Virtual host', { ph: '/' }) + c.input('name', 'Queue name', { ph: 'orders.created' })
          + c.select('type', 'Type', [{ value: 'quorum', label: 'Quorum (replicated, default)' }, { value: 'classic', label: 'Classic' }, { value: 'stream', label: 'Stream' }], { rr: true }) + '</div>'
          + (classic ? '<div class="cd-grid">' + c.check('durable', 'Durable') + c.check('autoDelete', 'Auto-delete when the last consumer leaves') + '</div>' : '<div class="muted" style="font-size:12px">Quorum queues and streams are always durable and never auto-delete.</div>')
          + section('Arguments', '<div class="cd-grid">'
            + (stream ? '' : a('messageTtl', 'Message TTL, ms (optional)') + a('expires', 'Queue expires after idle, ms (optional)', { min: 1 }) + a('maxLength', 'Most messages (optional)'))
            + a('maxLengthBytes', 'Most bytes (optional)')
            + (stream ? '' : c.select('a.overflow', 'When full', [{ value: '', label: 'Drop the oldest (default)' }, { value: 'drop-head', label: 'drop-head' }, { value: 'reject-publish', label: 'reject-publish' }].concat(classic ? [{ value: 'reject-publish-dlx', label: 'reject-publish-dlx' }] : [])))
            + (stream ? '' : c.input('a.deadLetterExchange', 'Dead-letter exchange (optional)', { ph: 'dlx' }) + c.input('a.deadLetterRoutingKey', 'Dead-letter routing key (optional)'))
            + (quorum ? c.select('a.deadLetterStrategy', 'Dead-letter strategy', [{ value: '', label: 'At most once (default)' }, { value: 'at-most-once', label: 'at-most-once' }, { value: 'at-least-once', label: 'at-least-once (needs reject-publish)' }]) + a('deliveryLimit', 'Delivery limit (optional)', { min: 1 }) : '')
            + (classic ? a('maxPriority', 'Most priority levels (optional)', { min: 1, max: 255 }) : '')
            + (quorum || stream ? a('initialGroupSize', 'Initial replicas (optional)', { min: 1, max: 15 }) : '')
            + (stream ? c.input('a.maxAge', 'Most age (optional)', { ph: '7D', hint: 'A number and Y, M, D, h, m or s.' }) + a('streamMaxSegmentSizeBytes', 'Segment size, bytes (optional)', { min: 1 }) : '')
            + (stream ? '' : c.check('a.singleActiveConsumer', 'Single active consumer')) + '</div>');
      },
      def(E) {
        const { f } = E; const t = f.type; const a = f.a || {}; const classic = t === 'classic', quorum = t === 'quorum', stream = t === 'stream';
        const args = {};
        if (!stream) { put(args, 'messageTtl', num(a.messageTtl)); put(args, 'expires', num(a.expires)); put(args, 'maxLength', num(a.maxLength)); put(args, 'overflow', a.overflow); put(args, 'deadLetterExchange', str(a.deadLetterExchange)); put(args, 'deadLetterRoutingKey', str(a.deadLetterRoutingKey)); if (a.singleActiveConsumer) args.singleActiveConsumer = true; }
        put(args, 'maxLengthBytes', num(a.maxLengthBytes));
        if (quorum) { put(args, 'deadLetterStrategy', a.deadLetterStrategy); put(args, 'deliveryLimit', num(a.deliveryLimit)); }
        if (classic) put(args, 'maxPriority', num(a.maxPriority));
        if (quorum || stream) put(args, 'initialGroupSize', num(a.initialGroupSize));
        if (stream) { put(args, 'maxAge', str(a.maxAge)); put(args, 'streamMaxSegmentSizeBytes', num(a.streamMaxSegmentSizeBytes)); }
        const out = { kind: 'queue', name: str(f.name), type: t, durable: classic ? !!f.durable : true, autoDelete: classic ? !!f.autoDelete : false };
        put(out, 'vhost', str(f.vhost)); put(out, 'arguments', args);
        return { def: out };
      }
    },
    'rabbitmq:exchange': {
      init(E) { return { vhost: vhostOf(E.conn), name: '', type: 'direct', durable: true, autoDelete: false, internal: false, alternateExchange: '' }; },
      render(E) {
        const { c } = E;
        return '<div class="formgrid" style="--cols:2">' + c.input('vhost', 'Virtual host', { ph: '/' }) + c.input('name', 'Exchange name', { ph: 'orders' }) + c.select('type', 'Type', ['direct', 'fanout', 'topic', 'headers']) + c.input('alternateExchange', 'Alternate exchange (optional)', { hint: 'Receives messages no binding routes.' }) + '</div>'
          + '<div class="cd-grid">' + c.check('durable', 'Durable') + c.check('autoDelete', 'Auto-delete when the last binding goes') + c.check('internal', 'Internal (only other exchanges publish to it)') + '</div>';
      },
      def(E) { const { f } = E; const out = { kind: 'exchange', name: str(f.name), type: f.type, durable: !!f.durable, autoDelete: !!f.autoDelete, internal: !!f.internal }; put(out, 'vhost', str(f.vhost)); put(out, 'alternateExchange', str(f.alternateExchange)); return { def: out }; }
    },
    'rabbitmq:binding': {
      templates: { args: () => ({ key: '', value: '' }) },
      init(E) { return { vhost: vhostOf(E.conn), source: '', destinationType: 'queue', destination: '', routingKey: '', args: [] }; },
      render(E) {
        const { f, c } = E;
        const vh = str(f.vhost) || '/';
        const listed = ((E.queues && E.queues.queues) || []).map((q) => q.name).filter((n) => n.indexOf(vh + '/') === 0).map((n) => n.slice(vh.length + 1));
        return '<div class="formgrid" style="--cols:2">' + c.input('vhost', 'Virtual host', { ph: '/', rr: true }) + c.input('source', 'Source exchange', { ph: 'orders' })
          + c.select('destinationType', 'Destination', [{ value: 'queue', label: 'A queue' }, { value: 'exchange', label: 'An exchange' }], { rr: true })
          + (f.destinationType === 'queue' && listed.length ? c.select('destination', 'Destination queue', [{ value: '', label: 'Choose a queue' }].concat(listed), { hint: 'Allow-listed queues in this virtual host.' }) : c.input('destination', f.destinationType === 'queue' ? 'Destination queue' : 'Destination exchange'))
          + c.input('routingKey', 'Routing key (optional)', { ph: 'orders.*' }) + '</div>'
          + section('Arguments', f.args.map((x, i) => '<div class="cd-grid">' + c.input('args.' + i + '.key', 'Name', { ph: 'x-match' }) + c.input('args.' + i + '.value', 'Value', { hint: 'Numbers and true or false are sent as such.' }) + '<div class="cd-chk">' + delBtn('args', i, 'argument') + '</div></div>').join(''), addBtn('args', 'Add argument'));
      },
      def(E) {
        const { f } = E; const args = {};
        f.args.forEach((x) => { const k = str(x.key); if (!k) return; const v = str(x.value); args[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v; });
        const out = { kind: 'binding', source: str(f.source), destination: str(f.destination), destinationType: f.destinationType, routingKey: f.routingKey || '' };
        put(out, 'vhost', str(f.vhost)); put(out, 'arguments', args);
        return { def: out };
      }
    }
  };
  function formFor(conn, kind) {
    const fam = famOf(conn);
    if (fam === 'sql') return kind === 'table' ? FORMS['sql:table'] : kind === 'index' ? FORMS['sql:index'] : kind === 'procedure' || kind === 'function' ? FORMS['sql:routine'] : kind === 'dataset' ? FORMS.dataset : null;
    if (kind === 'dataset' && (fam === 'cosmos' || fam === 'influx')) return FORMS.dataset;
    return FORMS[fam + ':' + kind] || null;
  }

  // ---- the editor: form, preview, apply ----
  const listHtml = (items) => '<ul class="cd-ul">' + items.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
  function previewHtml(pv, conn, lang) {
    if (!pv) return '<div class="muted" style="font-size:12px">Preview shows what would run before anything is sent to ' + esc(conn.name) + '.</div>';
    if (pv.problems) return '<div class="notice danger" role="alert">' + UI.icon('warn', 15) + '<div class="grow"><b>The definition is not valid.</b>' + listHtml(pv.problems) + '</div></div>';
    if (pv.error) return UI.problem((pv.error.problem && pv.error.problem.title) || 'Preview failed', pv.error.message, pv.error.problem && pv.error.problem.trace_id);
    const p = pv.plan; const blockers = pv.blockers || [];
    return '<div class="vstack" style="gap:8px"><div class="hstack wrap"><div class="eyebrow grow">Plan for <span class="mono">' + esc(p.object) + '</span></div>' + (p.destructive ? UI.pill('loses data', 'danger') : '') + UI.pill(p.statements.length + ' step' + (p.statements.length === 1 ? '' : 's'), 'outline') + '</div>'
      + (p.statements.length ? UI.code(p.statements.join('\n\n'), lang) : UI.notice('Nothing to change: the definition matches the database.', 'info'))
      + (p.destructive ? '<div class="notice danger">' + UI.icon('warn', 15) + '<div class="grow"><b>This change loses data.</b>' + (p.confirmName ? ' Applying it asks you to type <span class="mono">' + esc(p.confirmName) + '</span> to confirm.' : '') + '</div></div>' : '')
      + (p.notes || []).map((n) => UI.notice(esc(n), 'info')).join('')
      + '<div class="muted" style="font-size:12px">' + (p.transactional ? 'Runs in one transaction: if a step fails, nothing is changed.' : p.statements.length > 1 ? 'Not run in one transaction: each step commits on its own.' : 'Runs as one step.') + ((p.touches || []).length ? ' Acts on ' + p.touches.map((x) => '<span class="mono">' + esc(x) + '</span>').join(', ') + '.' : '') + '</div>'
      + (blockers.length ? '<div class="notice warn">' + UI.icon('warn', 15) + '<div class="grow"><b>Apply would be refused now.</b>' + listHtml(blockers) + '</div></div>' : '')
      + (pv.applyError ? UI.problem('The database refused the change', pv.applyError.message, pv.applyError.problem && pv.applyError.problem.trace_id) : '') + '</div>';
  }
  /** The typed confirmation a destructive plan needs: a labelled input; `onMatch(ok)` follows it. */
  const confirmField = (name) => UI.field('Type ' + name + ' to confirm', UI.input('', { attrs: 'data-cdconfirm autocomplete="off" spellcheck="false" autocapitalize="off"' }), 'The name exactly as shown: <span class="mono">' + esc(name) + '</span>.');

  /**
   * One kind's form with Preview and Apply. `o`: { key, kind, kindLabel, reload, rerender, queues, onApplied, edit }.
   * `o.edit` (editing an existing object): { init(E), def(E, spec), ro(E, path), changes(E), losses(E), allowLabel(E), bind(E) }.
   * Returns { html, bind }.
   */
  function editor(ctx, conn, st, o) {
    st.ddlForms = st.ddlForms || {}; st.ddlPrev = st.ddlPrev || {};
    const spec = formFor(conn, o.kind);
    if (!spec) return { html: UI.notice('This kind of object is not offered on ' + esc(conn.name) + '.', 'info'), bind() {} };
    const d = dialectOf(conn); const designer = designerOf(conn); const X = o.edit || null;
    const E = { conn, d, designer, types: designer.types || [], kind: o.kind, kindLabel: o.kindLabel, queues: o.queues, edit: X };
    E.ro = (path) => !!(X && X.ro && X.ro(E, path));
    if (!st.ddlForms[o.key]) st.ddlForms[o.key] = X ? X.init(E) : spec.init(E);
    const f = st.ddlForms[o.key];
    E.f = f; E.c = controls(f, E.ro);
    const lang = d ? 'sql' : 'json';
    const canApply = App.can('connections:ddl');
    const defOf = () => (X ? X.def(E, spec) : spec.def(E));
    const sig = () => { const r = defOf(); return r.def ? JSON.stringify(r.def) : null; };
    const pv = st.ddlPrev[o.key];
    const ready = !!(pv && pv.plan && !(pv.blockers || []).length && canApply && pv.sig === sig());
    const why = !canApply ? 'Applying needs the connections:ddl permission.' : !(conn.admin && conn.admin.set) ? 'Set an admin account on Settings before applying.' : '';
    const changes = X && X.changes ? '<div data-ddlchanges>' + X.changes(E) + '</div>' : '';
    const html = '<div class="vstack cd-editor" style="gap:12px">' + spec.render(E) + changes
      + '<div class="hstack wrap">' + UI.btn('Preview', { kind: ready ? '' : 'primary', icon: 'eye', attrs: 'data-ddlprev' }) + UI.btn('Apply', { kind: ready ? 'primary' : '', icon: 'play', attrs: 'data-ddlapply', disabled: !ready }) + UI.btn(X ? 'Undo all changes' : 'Start over', { kind: 'ghost', attrs: 'data-ddlreset' })
      + (why ? '<span class="muted" style="font-size:12px">' + esc(why) + '</span>' : '') + '</div>'
      + '<div data-ddlout aria-live="polite">' + previewHtml(pv, conn, lang) + '</div></div>';

    const stale = () => {
      if (!st.ddlPrev[o.key]) return;
      delete st.ddlPrev[o.key];
      const box = ctx.$('[data-ddlout]'); if (box) box.innerHTML = '<div class="muted" style="font-size:12px">The definition changed. Preview it again before applying.</div>';
      const ab = ctx.$('[data-ddlapply]'); if (ab) { ab.disabled = true; ab.classList.remove('primary'); }
    };
    const refreshChanges = () => { if (!X || !X.changes) return; const box = ctx.$('[data-ddlchanges]'); if (box) box.innerHTML = X.changes(E); };
    /** A renamed column keeps its place in the primary key, unique constraints, foreign keys and cluster list. */
    const renameRefs = (from, to) => {
      if (!from || from === to || !Array.isArray(f.columns) || f.columns.some((x) => !x.dropped && str(x.name) === from)) return;
      const swap = (list) => (Array.isArray(list) ? list.map((n) => (n === from ? to : n)) : list);
      if (f.primaryKey) f.primaryKey = swap(f.primaryKey);
      (f.uniques || []).forEach((u) => { u.columns = swap(u.columns); });
      (f.foreignKeys || []).forEach((fk) => (fk.pairs || []).forEach((p) => { if (p.col === from) p.col = to; }));
      if (f.options && f.options.clusterBy) f.options.clusterBy = swap(f.options.clusterBy);
    };
    const toast = (h, k, ms) => ctx.toast('<span>' + h + '</span>', k, ms);
    function bind() {
      const edit = (e, t) => {
        const p = t.dataset.df;
        const v = t.dataset.dt === 'bool' ? t.checked : t.value;
        const before = /^columns\.\d+\.name$/.test(p) ? str(getPath(f, p)) : null;
        setPath(f, p, v);
        if (before !== null) renameRefs(before, str(v));
        if (t.hasAttribute('data-tsel')) { const chp = p.replace(/\.type$/, ''); const ch = getPath(f, chp); const fresh = typeChoice(findType(E.types, v)); fresh.array = !!(ch && ch.array); setPath(f, chp, fresh); }
        stale(); refreshChanges();
        if (e.type === 'change' && t.hasAttribute('data-rr')) o.rerender();
      };
      ctx.on('input', '[data-df]', edit);
      ctx.on('change', '[data-df]', edit);
      ctx.on('change', '[data-dset]', (e, t) => {
        const p = t.dataset.dset; const list = (getPath(f, p) || []).slice(); const i = list.indexOf(t.value);
        if (t.checked && i < 0) list.push(t.value); else if (!t.checked && i >= 0) list.splice(i, 1);
        setPath(f, p, list); stale(); refreshChanges();
      });
      ctx.on('click', '[data-dadd]', (e, t) => {
        const p = t.dataset.dadd; const tkey = p.split('.').filter((x) => !/^\d+$/.test(x)).join('.');
        const make = spec.templates && spec.templates[tkey]; if (!make) return;
        const list = getPath(f, p) || []; list.push(make(E)); setPath(f, p, list); delete st.ddlPrev[o.key]; o.rerender();
      });
      ctx.on('click', '[data-ddel]', (e, t) => {
        const p = t.dataset.ddel; const i = +p.split('.').pop(); const list = getPath(f, p.replace(/\.\d+$/, ''));
        // Editing: an existing column is not taken out of the form but marked to be dropped, with Undo.
        if (Array.isArray(list)) { const item = list[i]; if (X && item && typeof item === 'object' && item.from) item.dropped = true; else list.splice(i, 1); }
        delete st.ddlPrev[o.key]; o.rerender();
      });
      ctx.on('click', '[data-dundo]', (e, t) => { const item = getPath(f, t.dataset.dundo); if (item) item.dropped = false; delete st.ddlPrev[o.key]; o.rerender(); });
      ctx.on('click', '[data-drawtype]', (e, t) => { setPath(f, t.dataset.drawtype, false); const ch = getPath(f, t.dataset.dtype); if (!ch || !findType(E.types, ch.type)) setPath(f, t.dataset.dtype, typeChoice(firstType(E.types))); delete st.ddlPrev[o.key]; o.rerender(); });
      ctx.on('click', '[data-drawkeep]', (e, t) => { setPath(f, t.dataset.drawkeep, true); delete st.ddlPrev[o.key]; o.rerender(); });
      ctx.on('click', '[data-dmove]', (e, t) => {
        const p = t.dataset.dmove; const i = +p.split('.').pop(); const list = getPath(f, p.replace(/\.\d+$/, '')); const j = i + Number(t.dataset.dir);
        if (!Array.isArray(list) || j < 0 || j >= list.length) return;
        const x = list[i]; list[i] = list[j]; list[j] = x; delete st.ddlPrev[o.key]; o.rerender();
      });
      ctx.on('click', '[data-ddlreset]', async () => {
        const ok = await ctx.confirm(X
          ? { title: 'Undo all changes', tone: 'warn', body: '<p class="fg2" style="margin:0">Puts the form back as the database described it. Nothing has been sent to the database.</p>', ok: 'Undo all changes' }
          : { title: 'Start over', tone: 'warn', body: '<p class="fg2" style="margin:0">Clears this form and its preview. Nothing has been sent to the database.</p>', ok: 'Clear the form' });
        if (!ok) return;
        delete st.ddlForms[o.key]; delete st.ddlPrev[o.key]; o.rerender();
      });
      ctx.on('click', '[data-ddlprev]', async () => {
        const r = defOf();
        if (r.problems) { st.ddlPrev[o.key] = { problems: r.problems }; o.rerender(); return; }
        const s = JSON.stringify(r.def);
        try {
          const out = await App.post(base(conn) + '/ddl/preview', { definition: r.def });
          st.ddlPrev[o.key] = { sig: s, plan: out.plan, blockers: out.blockers || [] };
        } catch (err) {
          const probs = err.problem && Array.isArray(err.problem.problems) ? err.problem.problems : null;
          st.ddlPrev[o.key] = err.status === 422 && probs ? { problems: probs } : { error: err };
        }
        o.rerender();
        const box = ctx.$('[data-ddlout]'); if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
      });
      ctx.on('click', '[data-ddlapply]', () => {
        const cur = st.ddlPrev[o.key]; const r = defOf();
        if (!cur || !cur.plan || !r.def || cur.sig !== JSON.stringify(r.def)) { toast('The definition changed since the preview. Preview it again.', 'warn'); return; }
        const plan = cur.plan; let go = false; let allow = !X; let typed = '';
        const need = plan.destructive && plan.confirmName ? plan.confirmName : null;
        const allowLabel = X ? (X.allowLabel ? X.allowLabel(E) : null) : 'Add the new object to the allow-list';
        const losses = plan.destructive ? ((X && X.losses ? X.losses(E) : []) || []) : [];
        ctx.modal({
          title: (X ? 'Apply change to ' : 'Apply schema change ') + (X ? '<span class="mono">' + esc(plan.object) + '</span> ' : '') + UI.pill(plan.destructive ? 'loses data' : 'schema change', plan.destructive ? 'danger' : 'warn'),
          body: '<p class="fg2" style="margin:0">Runs the ' + plan.statements.length + ' previewed step' + (plan.statements.length === 1 ? '' : 's') + ' on the admin account. The change is written to the audit log with the statements and your name.</p>'
            + UI.kv([['Connection', esc(conn.name)], ['Admin account', '<span class="mono">' + esc((conn.admin && conn.admin.account) || 'set') + '</span>'], ['Label', UI.label(conn.label, { sm: true })], ['Object', '<span class="mono">' + esc(plan.object) + '</span>']], 2)
            + (plan.destructive ? '<div class="notice danger">' + UI.icon('warn', 15) + '<div class="grow"><b>This change loses data and cannot be undone here.</b>' + (losses.length ? listHtml(losses) : ' What the dropped or narrowed parts held is lost.') + '</div></div>' : '')
            + (need ? confirmField(need) : '')
            + (allowLabel ? UI.check(allowLabel, true, 'data-cdallow') : ''),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Apply change', { kind: plan.destructive ? 'danger' : 'primary', attrs: 'data-cdgo', disabled: !!need }),
          onMount(m) {
            const goBtn = m.querySelector('[data-cdgo]'); const inp = m.querySelector('[data-cdconfirm]');
            if (inp) { inp.addEventListener('input', () => { goBtn.disabled = inp.value !== need; }); inp.focus(); }
            goBtn.addEventListener('click', () => { if (need && (!inp || inp.value !== need)) return; typed = inp ? inp.value : ''; const cb = m.querySelector('[data-cdallow]'); allow = !!(cb && cb.checked); go = true; App.closeOverlay(); });
          },
          onClose() { if (go) setTimeout(() => apply(r.def, plan, allow, need ? typed : null), 0); }
        });
      });
      if (X && X.bind) X.bind(E);
    }
    async function apply(def, plan, allow, confirm) {
      try {
        const body = { definition: def, hash: plan.hash, allowList: allow };
        if (confirm) body.confirm = confirm;
        const r = await withStepUp(ctx, () => App.post(base(conn) + '/ddl/apply', body));
        if (r === undefined) { toast('Not applied: the sign-in check was cancelled.', 'warn'); return; }
        delete st.ddlPrev[o.key]; delete st.ddlForms[o.key];
        toast((X ? 'Changed' : 'Created') + ' <span class="mono">' + esc((r.plan && r.plan.object) || plan.object) + '</span> in ' + r.ms + ' ms.' + (r.allowListed ? ' Added to the allow-list.' : '') + (r.schemaRefreshed ? ' Schema refreshed.' : '') + ' Audit entry written.', 'ok', 7000);
        if (o.onApplied) o.onApplied(r);
        if (o.reload) o.reload(); else o.rerender();
      } catch (err) {
        const cur = st.ddlPrev[o.key];
        const probs = err.problem && Array.isArray(err.problem.problems) ? err.problem.problems : null;
        if (err.status === 409) { delete st.ddlPrev[o.key]; toast(err.problem && err.problem.kind === 'hash' ? 'The object changed since the preview. Preview it again, then apply.' : 'The definition no longer matches the preview. Preview it again, then apply.', 'warn', 7000); }
        else if (err.status === 422 && probs) st.ddlPrev[o.key] = { problems: probs };
        else if (err.status === 502 && cur) { cur.applyError = err; toast('The database refused the change.', 'danger'); }
        else App.fail(err, 'Not applied');
        o.rerender();
      }
    }
    return { html, bind };
  }

  const STYLE = '<style>'
    + '#main .cd-sec{display:flex;flex-direction:column;gap:8px}'
    + '#main .cd-card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--line);border-radius:6px;padding:10px;background:var(--panel);min-width:0}'
    + '#main .cd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,170px),1fr));gap:8px 12px;align-items:end;min-width:0}'
    + '#main .cd-grid > *{min-width:0}'
    + '#main .cd-chk{display:flex;align-items:center;min-height:32px}'
    + '#main .cd-set{display:flex;flex-wrap:wrap;gap:12px 20px}#main .cd-set .check{min-height:24px}'
    + '#main .cd-ul{margin:4px 0 0;padding-left:18px}'
    + '#main .cd-rowbtns{gap:4px}'
    + '#main .cd-editor .codebox{max-width:100%;overflow:auto}'
    + '#main .cd-kinds{display:flex;flex-wrap:wrap;gap:6px}'
    + '#main .cd-dropped{background:var(--danger-bg);border-color:var(--line2)}'
    + '#main .cd-dropped s{color:var(--danger-fg)}'
    + '#main .cd-changes{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px}'
    + '#main .cd-changes .loss{color:var(--danger-fg)}'
    + '#main .cd-objs .tablewrap{max-width:100%;overflow-x:auto}'
    + '#main .cd-objs td{overflow-wrap:anywhere}'
    + '#main .cd-acts{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}'
    + '#main .cd-ghead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}'
    + '</style>';

  /**
   * The Schema designer tab. It opens on the objects panel (connections-schema-edit.js: the connection's objects with
   * Edit and Drop, and New buttons); New opens the create form below (a kind picker and that kind's form), Edit the
   * same form filled from the object's description.
   */
  function designerTab(ctx, conn, st, rerender, reload) {
    st.ddlKind = st.ddlKind || {}; st.ddlView = st.ddlView || {};
    const kinds = designKinds(conn);
    if (!kinds.length) return { html: UI.notice(esc(conn.name) + ' has nothing the designer can create.', 'info'), bind() {} };
    const SE = App.connectionDesigner.edit;
    const view = SE ? st.ddlView[conn.id] || 'objects' : 'create';
    const admin = conn.admin && conn.admin.set ? 'Changes run on <span class="mono">' + esc(conn.admin.account || 'the admin account') + '</span> after a preview and a confirmation.' : 'No admin account is set: you can preview, but applying needs one (Settings, Admin account for schema changes).';
    const note = UI.notice(admin + ' Queries keep using the read-only account.', conn.admin && conn.admin.set ? 'info' : 'warn');
    if (view !== 'create') {
      const part = view === 'edit' ? SE.editView(ctx, conn, st, rerender, reload) : SE.objectsPanel(ctx, conn, st, rerender, reload);
      return { html: STYLE + '<div class="vstack" style="gap:12px">' + note + part.html + '</div>', bind: part.bind };
    }
    let kind = st.ddlKind[conn.id];
    if (!kinds.some((k) => k.kind === kind)) kind = kinds[0].kind;
    const k = kinds.find((x) => x.kind === kind);
    const ed = editor(ctx, conn, st, { key: conn.id + '|' + kind, kind, kindLabel: k.label, rerender, reload, onApplied() { st.ddlView[conn.id] = 'objects'; if (SE) SE.invalidate(st, conn); } });
    const html = STYLE + '<div class="vstack" style="gap:12px">'
      + note
      + (SE ? '<div class="hstack wrap">' + UI.btn('Back to objects', { kind: 'ghost', size: 'sm', icon: 'undo', attrs: 'data-ddlback' }) + '<span class="eyebrow">New ' + esc(k.label.toLowerCase()) + '</span></div>' : '')
      + '<div class="field" role="group" aria-labelledby="cd-kinds-l"><span class="fl" id="cd-kinds-l">What to create</span><div class="cd-kinds">' + kinds.map((x) => UI.chip(esc(x.label), x.kind === kind, 'data-ddlkind="' + esc(x.kind) + '"')).join('') + '</div></div>'
      + ed.html + '</div>';
    return { html, bind() {
      ctx.on('click', '[data-ddlkind]', (e, t) => { st.ddlKind[conn.id] = t.dataset.ddlkind; rerender(); });
      ctx.on('click', '[data-ddlback]', () => { st.ddlView[conn.id] = 'objects'; rerender(); });
      ed.bind();
    } };
  }

  // ---- Queues ----
  const n0 = (v) => (v == null ? '<span class="muted">n/a</span>' : esc(Number(v).toLocaleString()));
  const rate = (v) => (v == null ? '<span class="muted">n/a</span>' : esc((Math.round(v * 10) / 10).toLocaleString()) + '/s');
  const KIND_LABEL = { list: 'list', stream: 'stream', bullmq: 'BullMQ', pubsub: 'pub/sub', zset: 'sorted set', classic: 'classic', quorum: 'quorum', 'stream-queue': 'stream' };
  const val = (v) => (v == null ? '<span class="muted">none</span>' : typeof v === 'object' ? '<span class="mono">' + esc(JSON.stringify(v)) + '</span>' : esc(String(v)));
  const queueCount = (st, conn) => { const q = st.queues && st.queues[conn.id]; return q && q.data ? q.data.queues.length : null; };

  function queuesTab(ctx, conn, st, rerender, reload) {
    st.queues = st.queues || {}; st.qCreate = st.qCreate || {};
    const q = st.queues[conn.id] || (st.queues[conn.id] = {});
    const later = () => { if (App.state.route !== 'connections') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } rerender(); };
    const fetchQueues = () => {
      if (q.loading) return;
      q.loading = true;
      App.get(base(conn) + '/queues').then((d) => { q.data = d; q.error = null; q.at = Date.now(); }).catch((err) => { q.error = err; }).finally(() => { q.loading = false; later(); });
    };
    if (!q.data && !q.loading && !q.error) fetchQueues();
    const rabbit = conn.engine === 'rabbitmq';
    const data = q.data;
    const sel = data && q.open ? data.queues.find((x) => x.name === q.open) : null;
    const canCreate = App.can('connections:ddl') && queueKinds(conn).length > 0;
    const creating = canCreate && st.qCreate[conn.id];
    // 2.0.x editing: drops (queues, exchanges, bindings, stream groups) and a group's start id, previewed first.
    const SE = App.connectionDesigner.edit;
    const canDrop = !!SE && App.can('connections:ddl');
    const splitQ = (n) => (n.indexOf('//') === 0 ? { vhost: '/', name: n.slice(2) } : n.indexOf('/') > 0 ? { vhost: n.slice(0, n.indexOf('/')), name: n.slice(n.indexOf('/') + 1) } : { vhost: vhostOf(conn), name: n });
    const qname = (vh, n) => vh + '/' + n;
    const rowsOf = (r) => (r.rows || []).map((row) => { const o = {}; (r.columns || []).forEach((c, i) => { o[c] = row[i]; }); return o; });
    const readCmd = (holder, query) => {
      holder.loading = true; holder.error = null; rerender();
      App.post(base(conn) + '/query', { query, confirmUnparsed: false }).then((r) => { holder.rows = rowsOf(r); }).catch((err) => { holder.error = err; }).finally(() => { holder.loading = false; later(); });
    };
    const afterDrop = () => { q.data = null; q.error = null; q.exch = null; q.bind = {}; if (reload) reload(); else rerender(); };
    q.bind = q.bind || {};

    let table = '';
    if (q.error && !data) table = UI.problem((q.error.problem && q.error.problem.title) || 'Queues could not be read', q.error.message, q.error.problem && q.error.problem.trace_id);
    else if (!data) table = UI.notice('Reading the queues…', 'info');
    else {
      const cols = ['Name', 'Kind', { label: 'Depth', right: true }, { label: 'In flight', right: true }, { label: 'Consumers', right: true }].concat(rabbit ? [{ label: 'Rate in', right: true }, { label: 'Rate out', right: true }] : []).concat(['State', { label: '', srLabel: 'Details' }]);
      table = UI.table(cols, data.queues.map((x) => ({ selected: sel && sel.name === x.name, cells: ['<span class="mono">' + esc(x.name) + '</span>', UI.pill(KIND_LABEL[x.kind] || x.kind, 'outline'), n0(x.depth), n0(x.inFlight), n0(x.consumers)].concat(rabbit ? [rate(x.rateIn), rate(x.rateOut)] : []).concat([x.state ? UI.pill(x.state) : '<span class="muted">n/a</span>', UI.btn(sel && sel.name === x.name ? 'Hide' : 'Details', { kind: 'ghost', size: 'xs', attrs: 'data-qopen="' + esc(x.name) + '" aria-expanded="' + (sel && sel.name === x.name ? 'true' : 'false') + '" aria-label="' + (sel && sel.name === x.name ? 'Hide details of ' : 'Details of ') + esc(x.name) + '"' })]) })), { clickable: false, minWidth: '0', emptyTitle: 'No queues on the allow-list', emptyText: 'Allow key or queue patterns on the Schema allow-list; matching queues show here.' })
        + '<div class="muted" style="font-size:12px">' + (data.outside ? 'Outside the allow-list: ' + data.outside + ' (not shown). ' : '') + 'Read in ' + data.ms + ' ms' + (q.at ? ' at ' + esc(new Date(q.at).toLocaleTimeString()) : '') + '.</div>'
        + (data.capped ? UI.notice('Only the first queues are listed. Narrow the allow-list patterns to see the rest.', 'info') : '');
    }
    let detail = '';
    if (sel) {
      const parts = [];
      if (sel.groups && sel.groups.length) parts.push('<div class="eyebrow">Consumer groups</div>' + UI.table(['Group', { label: 'Consumers', right: true }, { label: 'Pending', right: true }, 'Last delivered', { label: 'Lag', right: true }].concat(canDrop ? [{ label: '', srLabel: 'Actions' }] : []), sel.groups.map((g, i) => ['<span class="mono">' + esc(g.name) + '</span>', n0(g.consumers), n0(g.pending), '<span class="mono">' + esc(g.lastDeliveredId) + '</span>', n0(g.lag)].concat(canDrop ? ['<div class="hstack wrap" style="gap:4px;justify-content:flex-end">' + UI.btn('Edit start id', { size: 'xs', attrs: 'data-gstart="' + i + '" aria-label="Edit the start id of ' + esc(g.name) + '"' }) + UI.btn('Drop', { kind: 'danger', size: 'xs', icon: 'trash', attrs: 'data-gdrop="' + i + '" aria-label="Drop consumer group ' + esc(g.name) + '"' }) + '</div>'] : [])), { clickable: false, minWidth: '0' }));
      if (rabbit && canDrop) {
        const b = q.bind[sel.name] || {};
        const list = (b.rows || []).filter((x) => x.source);
        parts.push('<div class="hstack wrap"><div class="eyebrow grow">Bindings</div>' + UI.btn(b.rows ? 'Read again' : 'Show bindings', { size: 'xs', attrs: 'data-qbind', disabled: !!b.loading }) + '</div>'
          + (b.error ? UI.notice('The bindings could not be read: ' + esc(b.error.message), 'warn') : '')
          + (b.loading ? '<div class="muted" style="font-size:12px">Reading…</div>' : '')
          + (b.rows ? UI.table(['Source exchange', 'Routing key', { label: '', srLabel: 'Actions' }], list.map((x, i) => ['<span class="mono">' + esc(x.source) + '</span>', '<span class="mono">' + esc(x.routing_key || '') + '</span>', UI.btn('Drop', { kind: 'danger', size: 'xs', icon: 'trash', attrs: 'data-bdrop="' + i + '" aria-label="Drop the binding from ' + esc(x.source) + '"' })]), { clickable: false, minWidth: '0', emptyTitle: 'No bindings', emptyText: 'Only the default exchange routes to this queue.' }) : ''));
      }
      if (sel.counts && Object.keys(sel.counts).length) parts.push('<div class="eyebrow">Jobs by state</div>' + UI.kv(Object.keys(sel.counts).map((k) => [k, n0(sel.counts[k])]), 3));
      if (sel.details && Object.keys(sel.details).length) parts.push('<div class="eyebrow">Details</div>' + UI.kv(Object.keys(sel.details).map((k) => [k.replace(/_/g, ' '), val(sel.details[k])]), 2));
      if (!parts.length) parts.push('<div class="muted" style="font-size:12px">The server reports nothing more about this queue.</div>');
      detail = UI.panel('Queue ' + sel.name, '<div class="vstack" style="gap:10px">' + parts.join('') + '</div>', { actions: (rabbit && canDrop ? UI.btn('Drop queue', { kind: 'danger', size: 'xs', icon: 'trash', attrs: 'data-qdrop' }) : '') + UI.btn('Close', { kind: 'ghost', size: 'xs', attrs: 'data-qopen="' + esc(sel.name) + '"' }) });
    }

    let create = ''; let ed = null;
    if (creating) {
      const kinds = queueKinds(conn);
      const kind = kinds.some((k) => k.kind === creating) ? creating : kinds[0].kind;
      const k = kinds.find((x) => x.kind === kind);
      ed = editor(ctx, conn, st, { key: conn.id + '|q|' + kind, kind, kindLabel: k.label, rerender, reload: () => { q.data = null; q.error = null; if (reload) reload(); else rerender(); }, queues: data });
      create = UI.panel(rabbit ? 'Create' : 'Create a stream queue', '<div class="vstack" style="gap:12px">' + (kinds.length > 1 ? '<div class="field" role="group" aria-labelledby="cd-qkinds-l"><span class="fl" id="cd-qkinds-l">What to create</span><div class="cd-kinds">' + kinds.map((x) => UI.chip(esc(x.label), x.kind === kind, 'data-qkind="' + esc(x.kind) + '"')).join('') + '</div></div>' : '') + ed.html + '</div>', { actions: UI.btn('Close', { kind: 'ghost', size: 'xs', attrs: 'data-qcreateclose' }) });
    }
    let exch = '';
    if (rabbit && canDrop && data) {
      const x = q.exch || {};
      const list = (x.rows || []).filter((e) => e.name && String(e.name).indexOf('amq.') !== 0);
      exch = UI.panel('Exchanges', '<div class="vstack" style="gap:8px">' + (x.error ? UI.notice('The exchanges could not be read: ' + esc(x.error.message), 'warn') : '')
        + (x.rows ? UI.table(['Exchange', 'Virtual host', 'Type', { label: '', srLabel: 'Actions' }], list.map((e, i) => ['<span class="mono">' + esc(e.name) + '</span>', '<span class="mono">' + esc(e.vhost || '') + '</span>', esc(e.type || ''), UI.btn('Drop', { kind: 'danger', size: 'xs', icon: 'trash', attrs: 'data-xdrop="' + i + '" aria-label="Drop exchange ' + esc(e.name) + '"' })]), { clickable: false, minWidth: '0', emptyTitle: 'No exchanges of your own', emptyText: 'The default and amq. exchanges are not listed; they cannot be dropped.' }) : '<div class="muted" style="font-size:12px">' + (x.loading ? 'Reading…' : 'Read through the management API when you ask.') + '</div>') + '</div>',
        { actions: UI.btn(x.rows ? 'Read again' : 'List exchanges', { size: 'xs', attrs: 'data-qexch', disabled: !!x.loading }) });
    }
    const html = STYLE + '<div class="vstack" style="gap:10px">'
      + '<div class="hstack wrap">' + UI.btn('Refresh', { icon: 'refresh', attrs: 'data-qrefresh', disabled: !!q.loading }) + (canCreate && !creating ? UI.btn('Create queue', { kind: 'primary', icon: 'plus', attrs: 'data-qcreate' }) : '')
      + '<span class="muted" style="font-size:12px">' + (rabbit ? 'Read through the management API; message bodies are not read here.' : 'Lists, streams, BullMQ queues and sorted sets whose keys match the allow-list.') + '</span></div>'
      + (q.error && data ? UI.notice('The last refresh failed: ' + esc(q.error.message), 'warn') : '')
      + table + detail + exch + create + '</div>';
    return { html, bind() {
      ctx.on('click', '[data-qrefresh]', () => { q.error = null; fetchQueues(); rerender(); });
      ctx.on('click', '[data-qopen]', (e, t) => { q.open = q.open === t.dataset.qopen ? null : t.dataset.qopen; rerender(); });
      ctx.on('click', '[data-qcreate]', () => { st.qCreate[conn.id] = queueKinds(conn)[0].kind; rerender(); });
      ctx.on('click', '[data-qkind]', (e, t) => { st.qCreate[conn.id] = t.dataset.qkind; rerender(); });
      ctx.on('click', '[data-qcreateclose]', () => { st.qCreate[conn.id] = null; rerender(); });
      if (canDrop) {
        ctx.on('click', '[data-gstart]', (e, t) => { const g = sel && sel.groups[+t.dataset.gstart]; if (g) SE.startIdDialog(ctx, conn, sel.name, g.name, afterDrop); });
        ctx.on('click', '[data-gdrop]', (e, t) => { const g = sel && sel.groups[+t.dataset.gdrop]; if (g) SE.dropDialog(ctx, conn, { objectKind: 'stream-group', name: g.name, on: sel.name, label: sel.name + ' ' + g.name }, afterDrop); });
        ctx.on('click', '[data-qdrop]', () => { if (!sel) return; const s0 = splitQ(sel.name); SE.dropDialog(ctx, conn, { objectKind: 'queue', name: s0.name, on: s0.vhost, label: sel.name }, () => { q.open = null; afterDrop(); }); });
        ctx.on('click', '[data-qbind]', () => { if (sel) readCmd(q.bind[sel.name] = q.bind[sel.name] || {}, 'bindings ' + sel.name); });
        ctx.on('click', '[data-bdrop]', (e, t) => {
          const b = sel && q.bind[sel.name]; const x = b && (b.rows || []).filter((r) => r.source)[+t.dataset.bdrop]; if (!x) return;
          const vh = splitQ(sel.name).vhost; const args = x.arguments && typeof x.arguments === 'object' ? Object.keys(x.arguments).length : 0;
          const tgt = { objectKind: 'binding', name: x.source, on: vh, destination: x.destination, destinationType: x.destination_type === 'exchange' ? 'exchange' : 'queue', label: x.source + ' to ' + x.destination };
          if (!args) tgt.propertiesKey = x.routing_key ? String(x.routing_key) : '~';
          SE.dropDialog(ctx, conn, tgt, afterDrop);
        });
        ctx.on('click', '[data-qexch]', () => { readCmd(q.exch = q.exch || {}, 'exchanges'); });
        ctx.on('click', '[data-xdrop]', (e, t) => { const x = q.exch && (q.exch.rows || []).filter((r) => r.name && String(r.name).indexOf('amq.') !== 0)[+t.dataset.xdrop]; if (x) SE.dropDialog(ctx, conn, { objectKind: 'exchange', name: x.name, on: x.vhost || vhostOf(conn), label: qname(x.vhost || vhostOf(conn), x.name) }, afterDrop); });
      }
      if (ed) ed.bind();
    } };
  }

  // ---- Settings: the admin account ----
  const secretInput = (cred) => (cred && cred.multiline
    ? '<textarea class="textarea mono" data-adpass rows="5" autocomplete="off" spellcheck="false" autocapitalize="off" style="min-height:96px"></textarea>'
    : '<input type="password" class="input" data-adpass autocomplete="new-password">');
  /** Shown only to people who may change schemas, on engines the designer covers. Returns { html, bind }. */
  function adminCredentialField(ctx, conn, info, reload) {
    if (!App.can('connections:ddl') || !designerOf(conn).kinds.length) return { html: '', bind() {} };
    const a = conn.admin || { set: false, account: null, setAt: null };
    const text = a.set ? (a.account || 'set') + ' (sealed)' : 'Not set';
    const html = '<div class="vstack" style="gap:6px">' + UI.field('Admin account for schema changes', UI.input(text, { readonly: true, attrs: 'data-adminshow' }), a.set && a.setAt ? 'Set ' + esc(new Date(a.setAt).toLocaleString()) + '. Queries never use it.' : 'Queries never use it.')
      + '<div class="hstack wrap">' + UI.btn(a.set ? 'Replace admin account' : 'Set admin account', { size: 'sm', attrs: 'data-adminset' }) + (a.set ? UI.btn('Remove', { kind: 'danger', size: 'sm', attrs: 'data-adminremove' }) : '') + '</div></div>';
    const toast = (h, k, ms) => ctx.toast('<span>' + h + '</span>', k, ms);
    return { html, bind() {
      ctx.on('click', '[data-adminset]', () => {
        const cred = (info && info.credential) || { usernameLabel: 'Account', usernameRequired: true, secretLabel: 'Password', multiline: false };
        let body = null;
        ctx.modal({ title: 'Admin account for ' + esc(conn.name),
          body: '<p class="fg2" style="margin:0">A separate account allowed to create objects. Queries never use it.</p>'
            + UI.field('Admin ' + cred.usernameLabel.toLowerCase().replace(/^read-only /, '') + (cred.usernameRequired ? '' : ' (optional)'), UI.input(a.account || '', { attrs: 'data-aduser autocomplete="off" spellcheck="false"' }))
            + UI.field(cred.secretLabel, secretInput(cred), 'Sealed with the tenant key; never shown again. A vault: reference is accepted.') + '<div data-aderr role="alert"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save admin account', { kind: 'primary', attrs: 'data-adgo' }),
          onMount(m) {
            m.querySelector('[data-adgo]').addEventListener('click', () => {
              const u = m.querySelector('[data-aduser]').value.trim(); const pw = m.querySelector('[data-adpass]').value;
              const err = m.querySelector('[data-aderr]');
              if (!u && cred.usernameRequired) { err.innerHTML = UI.notice('Give the account name.', 'warn'); return; }
              if (!pw) { err.innerHTML = UI.notice('Give the ' + esc(cred.secretLabel.toLowerCase()) + '.', 'warn'); return; }
              body = { username: u || null, password: pw }; App.closeOverlay();
            });
          },
          onClose() {
            if (!body) return;
            const b = body; body = null;
            setTimeout(async () => {
              try {
                const r = await withStepUp(ctx, () => App.put(base(conn) + '/admin-credential', b));
                if (r === undefined) { toast('Not saved: the sign-in check was cancelled.', 'warn'); return; }
                toast('Admin account ' + esc(b.username || '') + ' sealed. Schema changes now run on it after a preview. Audit entry written.', 'ok', 6000);
                reload();
              } catch (err) { App.fail(err, 'Admin account not saved'); }
            }, 0);
          } });
      });
      ctx.on('click', '[data-adminremove]', async () => {
        const ok = await ctx.confirm({ title: 'Remove admin account', tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">' + esc(a.account || 'The admin account') + '\'s sealed secret is deleted. Schema changes cannot be applied on ' + esc(conn.name) + ' until another is set. Queries are not affected.</p>', ok: 'Remove' });
        if (!ok) return;
        try {
          const r = await withStepUp(ctx, () => App.del(base(conn) + '/admin-credential'));
          if (r === undefined) { toast('Not removed: the sign-in check was cancelled.', 'warn'); return; }
          toast('Admin account removed. Audit entry written.', 'ok'); reload();
        } catch (err) { App.fail(err, 'Admin account not removed'); }
      });
    } };
  }

  App.connectionDesigner = {
    designerTab, queuesTab, adminCredentialField, designKinds, hasQueues, queueCount,
    /** For connections-schema-edit.js (loaded after this file): the forms and helpers editing reuses. */
    internals: { FORMS, formFor, editor, previewHtml, confirmField, listHtml, withStepUp, stepUp, base, STYLE, designerOf, dialectOf, famOf, designKinds, queueKinds, allowedObjs, getPath, setPath, str, num, put, findType, firstType, idType, typeChoice, typeOut, choiceForm, typeChanged, sqlColOut, sqlConstraintsOut, GSI, vhostOf }
  };
})();
